// Questions run by the client's ID (H14): a request sent again after its stream broke joins the
// question that is still running, or gets its answer, instead of asking the model twice. In the
// memory of one process, bounded, with a time to live for kept answers. New in 0.99.9.
import { createHash } from "node:crypto";
import { askWithFiles, type AskOptions, type AskResult } from "./ask.js";
import { QuestionConflictError } from "./errors.js";
import { eventStream, type AskEvent, type EventStream } from "./events.js";
import type { AccessOptions } from "./library.js";
import { checkQuestionId } from "./question-id.js";
import { utf8Bytes } from "./text.js";

/** The options of `askWithFiles`, with the question ID required. New in 0.99.9. */
export type QuestionAskOptions = AskOptions & { questionId: string };

/** The options of `createQuestionRegistry`. New in 0.99.9. */
export type QuestionRegistryOptions = {
  /**
   * How long a finished answer is kept for a request sent again, in milliseconds, from when it
   * finished. Defaults to 600,000 (10 minutes). 0 keeps none; `Infinity` keeps each until it is
   * pushed out by `maxQuestions` or `maxBytes`.
   */
  keepMs?: number;
  /**
   * How long a running question goes on while no caller waits for it, in milliseconds, before it
   * is stopped. Defaults to 30,000. 0 stops it as soon as its last caller leaves; `Infinity` runs
   * it to its end, and keeps its answer for a request sent again.
   */
  detachedMs?: number;
  /** The most questions held, running and kept. Defaults to 1,000. At least 1. */
  maxQuestions?: number;
  /**
   * The most bytes of kept answers: the UTF-8 JSON of each result and its `run.finish` event.
   * Defaults to 33,554,432 (32 MiB). An answer larger than this is not kept.
   */
  maxBytes?: number;
  /** The clock of `keepMs`, for tests. Defaults to `Date.now`. (`detachedMs` runs on timers.) */
  now?: () => number;
};

/** What `QuestionRegistry.stats()` counts. New in 0.99.9. */
export type QuestionRegistryStats = {
  /** Questions running now. */
  running: number;
  /** Finished answers kept for a request sent again. */
  kept: number;
  /** The bytes of the kept answers, as `maxBytes` counts them. */
  keptBytes: number;
};

/**
 * Questions run by owner, scope and question ID, made by `createQuestionRegistry()`. New in 0.99.9.
 */
export interface QuestionRegistry {
  /**
   * `askWithFiles` by question ID: starts the question, joins the one running under the same
   * owner, scope and ID, or gives its kept answer. A joiner gets the events from when it joined,
   * and its other options are not used: the running question's apply. Rejects with
   * `QuestionConflictError` when the ID names another question.
   */
  ask(options: QuestionAskOptions): Promise<AskResult>;
  /**
   * The same as a stream of events, as `askStream` gives them: the answer is asked for as it is
   * written unless `streamText` is false. Throws a `TypeError` or `QuestionConflictError` at once,
   * before any event. Leaving the loop early detaches only this caller.
   */
  askStream(options: QuestionAskOptions): EventStream<AskEvent, AskResult>;
  /**
   * Stops a running question for every caller: each rejects with `reason` (an `AbortError` by
   * default). True when one was running. A kept answer stays.
   */
  stop(questionId: string, access?: Pick<AccessOptions, "owner" | "scope">, reason?: unknown): boolean;
  /** Counts the questions, after dropping the kept answers that expired. */
  stats(): QuestionRegistryStats;
}

type RunFinish = Extract<AskEvent, { type: "run.finish" }>;

/** Which question a request is: its key, and the fingerprint of what it asks. */
type Identity = { key: string; fingerprint: string };

/** One request waiting for a question: its callbacks, its signal, and how it ends. */
type Caller = {
  options: QuestionAskOptions;
  resolve: (result: AskResult) => void;
  reject: (error: unknown) => void;
  /** Takes the listener off the caller's signal. */
  unwatch: () => void;
};

type Running = {
  key: string;
  fingerprint: string;
  controller: AbortController;
  /** In join order. */
  callers: Caller[];
  /** The run's run.finish event, once it came. */
  finish?: RunFinish;
  timer?: ReturnType<typeof setTimeout>;
};

type Kept = {
  fingerprint: string;
  result: AskResult;
  finish: RunFinish | undefined;
  finishedAt: number;
  bytes: number;
};

/** The largest delay `setTimeout` keeps: a longer `detachedMs` counts as `Infinity`. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const shown = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : typeof value);

/** A number option of the registry, checked as `createLargeFiles` checks its own. */
function numberOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new TypeError(`${name} must be a number, and is ${shown(value)}.`);
  if (Number.isNaN(value)) throw new RangeError(`${name} must be a number, and is NaN. Leave it out for the default.`);
  return value;
}

function atLeastZero(name: string, value: unknown, fallback: number): number {
  const number = numberOption(name, value, fallback);
  if (number < 0) throw new RangeError(`${name} must be 0 or more, and is ${number}.`);
  return number;
}

/** A copy for one caller, so that no caller changes another's result, or the kept one. */
function copyOf<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // A result with something that cannot be copied (a function an adapter put in it): as it is.
    return value;
  }
}

/** The first line of an error's message, for a message of ours. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0] ?? "";
}

/**
 * Makes a registry that runs questions by owner, scope and question ID (`AskOptions.questionId`).
 * A request sent again under the same ID, while the question runs, joins it; after it ended, it
 * gets the kept answer (for `keepMs`). Another question under the same ID is a
 * `QuestionConflictError`. A question nobody waits for any more goes on for `detachedMs`, then
 * stops. A question that fails is not kept: a request sent again runs it again. In memory: one
 * registry is for one process. Create it once, next to `createLargeFiles`. New in 0.99.9.
 */
export function createQuestionRegistry(options: QuestionRegistryOptions = {}): QuestionRegistry {
  const given = options ?? {};
  const keepMs = atLeastZero("keepMs", given.keepMs, 600_000);
  const detachedGiven = atLeastZero("detachedMs", given.detachedMs, 30_000);
  const detachedMs = detachedGiven > MAX_TIMER_MS ? Number.POSITIVE_INFINITY : detachedGiven;
  const maxQuestionsGiven = numberOption("maxQuestions", given.maxQuestions, 1_000);
  const maxQuestions = Math.trunc(maxQuestionsGiven);
  if (!(maxQuestions >= 1)) throw new RangeError(`maxQuestions must be 1 or more, and is ${maxQuestionsGiven}.`);
  const maxBytes = atLeastZero("maxBytes", given.maxBytes, 33_554_432);
  if (given.now !== undefined && typeof given.now !== "function") throw new TypeError(`now must be a function, such as Date.now, and is ${shown(given.now)}.`);
  const now = given.now ?? Date.now;

  const running = new Map<string, Running>();
  /** In the order they finished: the oldest first out. */
  const kept = new Map<string, Kept>();
  let keptBytes = 0;

  const forget = (key: string) => {
    const entry = kept.get(key);
    if (!entry) return;
    kept.delete(key);
    keptBytes -= entry.bytes;
  };
  const expire = () => {
    const time = now();
    for (const [key, entry] of kept) if (entry.finishedAt + keepMs <= time) forget(key);
  };
  /** Pushes out the oldest kept answers while the registry holds more than it may. */
  const evict = (room: number) => {
    for (const key of kept.keys()) {
      if (keptBytes <= maxBytes && running.size + kept.size <= maxQuestions - room) return;
      forget(key);
    }
  };

  /** The question ID of a request, checked. */
  const questionIdOf = (asked: QuestionAskOptions, method: string): string => {
    const questionId = (asked as Partial<QuestionAskOptions> | undefined)?.questionId;
    if (questionId === undefined) throw new TypeError(`${method} needs options.questionId: the client's ID for this question, such as a UUID.`);
    checkQuestionId(questionId);
    return questionId;
  };

  /** Which question a request is, after the kept answers that expired are dropped: another one under its ID is a conflict. */
  const identified = (asked: QuestionAskOptions, questionId: string): Identity => {
    const identity = identify(asked);
    expire();
    const entry = running.get(identity.key) ?? kept.get(identity.key);
    if (entry && entry.fingerprint !== identity.fingerprint) throw new QuestionConflictError(questionId);
    return identity;
  };

  /** Takes a caller off its question, and starts the wait for a caller when none is left. */
  const detach = (entry: Running, caller: Caller) => {
    const at = entry.callers.indexOf(caller);
    if (at === -1) return false;
    entry.callers.splice(at, 1);
    caller.unwatch();
    if (entry.callers.length === 0 && running.get(entry.key) === entry) {
      if (detachedMs === 0) stopRun(entry, new DOMException("Nobody waited for the answer to this question.", "AbortError"));
      else if (detachedMs !== Number.POSITIVE_INFINITY) {
        entry.timer = setTimeout(() => stopRun(entry, new DOMException("Nobody waited for the answer to this question.", "AbortError")), detachedMs);
        entry.timer.unref?.();
      }
    }
    return true;
  };

  /**
   * Stops a run. It leaves the registry now, so that a request sent again starts the question
   * again rather than join one that is stopping; its callers reject when the run does.
   */
  const stopRun = (entry: Running, reason: unknown) => {
    if (running.get(entry.key) === entry) running.delete(entry.key);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.controller.abort(reason);
  };

  /** Waits for the question as one more caller: its signal, its callbacks and its promise. */
  const attach = (entry: Running, asked: QuestionAskOptions): Promise<AskResult> => new Promise<AskResult>((resolve, reject) => {
    const signal = asked.signal;
    const caller: Caller = { options: asked, resolve, reject, unwatch: () => undefined };
    if (signal) {
      const onAbort = () => {
        if (detach(entry, caller)) reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      caller.unwatch = () => signal.removeEventListener("abort", onAbort);
    }
    entry.callers.push(caller);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  });

  /**
   * Passes a callback on to every caller that gave one, in join order. A caller whose listener
   * throws is detached and rejects with what it threw; the run goes on.
   */
  const fan = <A>(entry: Running, pick: (options: QuestionAskOptions) => ((value: A) => void) | undefined) => (value: A) => {
    for (const caller of [...entry.callers]) {
      const listener = pick(caller.options);
      if (!listener) continue;
      try {
        listener(value);
      } catch (error) {
        if (detach(entry, caller)) caller.reject(error);
      }
    }
  };

  const start = (asked: QuestionAskOptions, key: string, fingerprint: string): Promise<AskResult> => {
    const entry: Running = { key, fingerprint, controller: new AbortController(), callers: [] };
    running.set(key, entry);
    // The first caller is attached before the run starts: run.start is emitted at once.
    const answer = attach(entry, asked);
    // Each caller gets its own copy of run.finish, whose result shares its lists with the answer:
    // a listener that changes it changes neither another caller's nor the kept one.
    const onEvent = fan<AskEvent>(entry, (given) => {
      const listener = given.onEvent;
      return listener && ((event: AskEvent) => listener(event.type === "run.finish" ? copyOf(event) : event));
    });
    void askWithFiles({
      ...asked,
      signal: entry.controller.signal,
      // As `askWithFiles` decides it for this caller: joiners do not change how the model is asked.
      streamText: asked.streamText ?? asked.onText !== undefined,
      onEvent: (event) => {
        if (event.type === "run.finish") entry.finish = copyOf(event);
        onEvent(event);
      },
      onText: fan<string>(entry, (given) => given.onText),
      onActivity: fan<string>(entry, (given) => given.onActivity),
      onStep: fan<string>(entry, (given) => given.onStep),
    }).then(
      (result) => finished(entry, result),
      (error: unknown) => failed(entry, error),
    );
    return answer;
  };

  const finished = (entry: Running, result: AskResult) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const current = running.get(entry.key) === entry;
    if (current) running.delete(entry.key);
    // A run stopped after its answer came in is not kept, but its callers still get the answer.
    if (current && keepMs > 0) keep(entry, result);
    for (const caller of entry.callers.splice(0)) {
      caller.unwatch();
      caller.resolve(copyOf(result));
    }
  };

  const keep = (entry: Running, result: AskResult) => {
    let bytes: number;
    try {
      bytes = utf8Bytes(JSON.stringify(result)) + utf8Bytes(JSON.stringify(entry.finish) ?? "");
    } catch {
      // Not JSON (a result an adapter put a BigInt in): not kept.
      return;
    }
    if (bytes > maxBytes) return;
    // Last in the order of finishing, and counted once.
    forget(entry.key);
    kept.set(entry.key, { fingerprint: entry.fingerprint, result, finish: entry.finish, finishedAt: now(), bytes });
    keptBytes += bytes;
    evict(0);
  };

  const failed = (entry: Running, error: unknown) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (running.get(entry.key) === entry) running.delete(entry.key);
    // The same error for every caller, so that `partialResultOf(error)` works for each.
    for (const caller of entry.callers.splice(0)) {
      caller.unwatch();
      caller.reject(error);
    }
  };

  /**
   * `ask` without the promise around it: a request that cannot be asked throws. `known` is the
   * identity `askStream` already settled, in the same tick.
   */
  const enter = (asked: QuestionAskOptions, known?: Identity): Promise<AskResult> => {
    const questionId = questionIdOf(asked, "registry.ask");
    if (asked.signal?.aborted) return Promise.reject(asked.signal.reason);
    const { key, fingerprint } = known ?? identified(asked, questionId);
    const run = running.get(key);
    if (run) return attach(run, asked);
    const answer = kept.get(key);
    if (answer) {
      if (answer.finish) asked.onEvent?.(copyOf(answer.finish));
      return Promise.resolve(copyOf(answer.result));
    }
    evict(1);
    // Every place holds a running question: this one runs, unkept, as askWithFiles would run it.
    if (running.size + kept.size >= maxQuestions) return askWithFiles(asked);
    return start(asked, key, fingerprint);
  };

  return {
    ask(asked) {
      try {
        return enter(asked);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    askStream(asked) {
      // At once, before any event: a request the route can still answer with a status.
      const identity = identified(asked, questionIdOf(asked, "registry.askStream"));
      return eventStream<AskEvent, AskResult>((onEvent, signal) => enter({
        ...asked,
        signal,
        // A page that reads the events shows the text as it is written, unless told not to.
        streamText: asked.streamText !== false,
        onEvent: (event) => {
          // The stream first, as askStream does.
          onEvent(event);
          asked.onEvent?.(event);
        },
      }, identity), { signal: asked.signal });
    },
    stop(questionId, access, reason) {
      const entry = running.get(keyOf(access?.owner, access?.scope, questionId));
      if (!entry) return false;
      stopRun(entry, reason ?? new DOMException("The question was stopped.", "AbortError"));
      return true;
    },
    stats() {
      expire();
      return { running: running.size, kept: kept.size, keptBytes };
    },
  };
}

/**
 * The bytes of a file in the messages (`ModelTextMessage.files`), as their SHA-256 in the
 * fingerprint: JSON would write each byte as a key of its own, many times the file's size. The
 * value is read from its holder, as it was before its `toJSON`: a Buffer's writes every byte, and
 * the same bytes in a Buffer and in a Uint8Array are the same question.
 */
function bytesHashed(this: unknown, key: string, value: unknown): unknown {
  const own = (this as Record<string, unknown>)[key];
  const view = ArrayBuffer.isView(own) ? own : value;
  if (!ArrayBuffer.isView(view)) return value;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

/** The key of a question: who asks, in which scope, and the client's ID. */
function keyOf(owner: unknown, scope: unknown, questionId: string): string {
  return JSON.stringify([owner ?? null, scope ?? null, questionId]);
}

/**
 * The key of a question, and its fingerprint: a hash of what makes it this question (the
 * messages, the documents, the system text and the models), to tell a request sent again from
 * another question under the same ID. Limits, budget and callbacks are not part of it.
 */
function identify(asked: QuestionAskOptions): Identity {
  try {
    const { model, explorer } = asked;
    const key = keyOf(asked.owner, asked.scope, asked.questionId);
    const json = JSON.stringify([asked.messages, asked.documentIds, asked.system ?? null, model?.id ?? null, explorer && explorer !== model ? explorer.id : null], bytesHashed);
    return { key, fingerprint: createHash("sha256").update(json).digest("hex") };
  } catch (error) {
    throw new TypeError(`questionId needs messages, documentIds and system that JSON can hold: ${reasonOf(error)}.`);
  }
}
