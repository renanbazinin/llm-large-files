// What a question or an ingest does while it runs, as typed data in order. The callbacks of
// earlier versions (onText, onActivity, onStep) still get the same strings, at the same moments.
import type { AskResult } from "./ask.js";
import { DocumentScopeError, DocumentStoreError, IngestError, isErrorCode, type DocumentScopeErrorCode, type IngestErrorCode } from "./errors.js";
import type { Evidence } from "./evidence.js";
import { modelFailureReason } from "./map-reduce.js";
import { classifyModelError, DocumentsNotFoundError, isModelStatus, type ModelErrorKind, type ModelReply, type ModelUsage, type ToolTurn } from "./model.js";
import type { DocumentFormat, DocumentMeta, DocumentSummary, ToolResult } from "./types.js";

/** What every event carries. */
export type EventBase = {
  /** 1 for the first event of a run, then one more for each event after it: no gaps, no repeats. */
  seq: number;
  /** The run the event belongs to: the `runId` you gave, or one made for it ("run_…" for a question, "ing_…" for an ingest). */
  runId: string;
  /** When it was emitted, in milliseconds since 1970 (`Date.now()`). */
  time: number;
};

/** A document as an event names it. */
export type DocumentRef = {
  id: string;
  name: string;
  format: DocumentFormat;
  estimatedTokens: number;
  pages?: number;
};

/** An error as an event carries it: plain data, safe to send to a browser. */
export type EventError = {
  /**
   * A message your users may see. A model error is told by its kind and status ("The model was
   * busy (HTTP 429)."), never in the provider's own words, which can name projects, hosts or
   * keys: those stay on the error that is thrown, for your logs. A storage error is told by its
   * code only.
   */
  message: string;
  /**
   * For a model error: what kind it is (`errorKindOf`). Since 0.9.0 also for an error with a status
   * (0, or 400 and more) and no kind of its own: the kind its status gives (`classifyModelError`).
   */
  kind?: ModelErrorKind;
  /** For an HTTP error: its status. 0 when no answer came. */
  status?: number;
  /** The error's class name: "ModelRequestError", "AbortError", "DocumentsNotFoundError"… */
  name?: string;
  /**
   * For a file `ingest` could not read: why, as `IngestError.code` ("too_large", "no_text",
   * "busy"…), so a page can say it in its own words. New in 0.8.0. Since 0.9.0 also the code of a
   * scope that cannot be used (`DocumentScopeError`, `name` "DocumentScopeError"): "scope_missing"
   * when the chat was deleted.
   */
  code?: IngestErrorCode | DocumentScopeErrorCode;
};

/**
 * Which model a request goes to, and for what:
 * - "tools": the one model of a question without an explorer, in a turn where it may call tools;
 * - "explorer": the explorer model, which only calls tools;
 * - "answer": the model that writes the answer (with or without an explorer);
 * - "reader": a request of a whole-file read (`analyze_whole_document`), made for one tool call.
 */
export type RequestRole = "tools" | "explorer" | "answer" | "reader";

/**
 * Why a request is made:
 * - "turn": a turn of the tool loop;
 * - "nudge": the same turn asked again after an empty or malformed reply;
 * - "closing": the request for the answer after the tools;
 * - "answer_again": the answer asked for again after it came back without text;
 * - "direct": the one request of a question that needs no tools;
 * - "part", "merge", "final": a whole-file read reading one part, combining notes, writing its answer.
 */
export type RequestPurpose = "turn" | "nudge" | "closing" | "answer_again" | "direct" | "part" | "merge" | "final";

/**
 * How a tool call ended:
 * - "ok": it ran and returned a result;
 * - "error": it ran, or was checked, and returned `{ error }` (bad arguments, a document it cannot
 *   read, a regex that took too long…), or it was ended because its turn failed (the question was
 *   stopped, or a listener threw): then the model was sent nothing;
 * - "refused": it was not run, for a limit of the question (cost, room, reads of a whole file);
 * - "already_shown": it repeated a call whose result is still in the conversation, and was answered
 *   with a pointer to it;
 * - "not_run": the turn had more calls than `limits.callsPerTurn`;
 * - "redacted": it ran, and `AskOptions.onToolResult` replaced its result: the model was sent the
 *   replacement. New in 0.10.0.
 *
 * A switch over every outcome must handle the outcomes added in a later version.
 */
export type ToolOutcome = "ok" | "error" | "refused" | "already_shown" | "not_run" | "redacted";

/**
 * Something the run did that is not a request or a tool call:
 * - "searching_instead": documents too large to send whole are searched instead;
 * - "writing_answer": the tools are done and the answer is asked for;
 * - "replanned": the question started again with less in the prompt (a smaller window than thought);
 * - "room_made": the request was too large for the model, was made smaller and sent again;
 * - "nudged": an empty or malformed reply was asked for again;
 * - "results_shortened": older tool results were shortened to make room;
 * - "answer_again": the answer came back without text and was asked for again;
 * - "calls_not_run": a turn had more calls than `limits.callsPerTurn`;
 * - "budget_reached": `limits.inputTokens` or `limits.requests` was reached, so no more tools run;
 * - "no_room": there is no room left in the conversation for another tool result;
 * - "blocked": the provider refused the prompt (`AskResult.blockReason`);
 * - "documents_missing": documents of `documentIds` were missing, and the question is answered
 *   without them (`AskOptions.onMissingDocuments` "drop"; `AskResult.missing`). New in 0.9.0;
 * - "document_gone": a tool call found a document gone during the question (deleted or expired
 *   since it was planned). The model was told so in the call's result. New in 0.9.0;
 * - "page_looks_busy": a look at pages waited its turn (`maxConcurrentPageLooks`) longer than
 *   `pageLookWaitMs`, and was not run. The model was told so in the call's result. New in 0.9.0;
 * - "answer_filtered": a filter of the provider stopped the answer, with or without text
 *   (`AskResult.finish` "filtered"). New in 0.10.0;
 * - "answer_cut": the answer stopped at the output limit (`AskResult.finish` "cut"). New in
 *   0.10.0.
 *
 * A switch over every code must handle the codes added in a later version.
 */
export type NoticeCode =
  | "searching_instead"
  | "writing_answer"
  | "replanned"
  | "room_made"
  | "nudged"
  | "results_shortened"
  | "answer_again"
  | "calls_not_run"
  | "budget_reached"
  | "no_room"
  | "blocked"
  | "documents_missing"
  | "document_gone"
  | "page_looks_busy"
  | "answer_filtered"
  | "answer_cut";

/**
 * Where a notice went in the callbacks of earlier versions: "activity" to `onActivity`, "step" to
 * `onStep` (and `AskResult.steps`), "none" to neither (new in 0.7.0).
 */
export type NoticeDisplay = "activity" | "step" | "none";

/**
 * The result of a question as `run.finish` and `run.error` carry it: an `AskResult` without
 * `toolTurns`, which hold the text of the documents the tools returned, and with its plan naming
 * the documents only (`DocumentRef`). With
 * `AskOptions.eventResults: true` they are there too. The result `askWithFiles` returns (and
 * `askStream`'s `result`, and `partialResultOf`) always has them: keep them from there.
 */
export type EventResult = Omit<AskResult, "toolTurns" | "plan"> & {
  toolTurns?: ToolTurn[];
  /**
   * Which documents went in whole and which were searched, named as `DocumentRef`s: their full
   * `DocumentMeta` (owner, scope, the SHA-256 and the ref of the original, outline headings, the
   * commonest lines of a log) is left out unless `eventResults` is true. The returned result has
   * the full plan. Since 0.10.0 the type of the full metadata here has no owner, scope, `sha256`,
   * `original` or `metaVersion`, which stay on the server: they are left out at run time too.
   */
  plan: {
    inline: Array<DocumentRef | Omit<DocumentMeta, "owner" | "scope" | "sha256" | "original" | "metaVersion">>;
    searchable: Array<DocumentRef | Omit<DocumentMeta, "owner" | "scope" | "sha256" | "original" | "metaVersion">>;
  };
};

/** The events of a question (`askWithFiles`, `askStream`), in the order they happen. */
export type AskEvent =
  /** Always first. */
  | (EventBase & {
      type: "run.start";
      /** The adapter ids: the model that answers, and the explorer when there is one. */
      models: { answer: string; explorer?: string };
      documentIds: string[];
    })
  /**
   * Which documents go into the prompt whole and which are searched. After `run.start`, before any
   * request. Again after a "replanned" notice.
   */
  | (EventBase & { type: "plan"; inline: DocumentRef[]; searchable: DocumentRef[] })
  /** A model request starts. Its retries are `retry` events with the same `requestId`. */
  | (EventBase & {
      type: "request.start";
      /** Unique in the run: "req_1", "req_2"… */
      requestId: string;
      role: RequestRole;
      purpose: RequestPurpose;
      /** The adapter id of the model the request goes to. */
      model: string;
      /** For a request of the chat (not "reader"): its number in the question, from 1, as `AskResult.turns` counts. */
      turn?: number;
      /** For a "reader" request: the tool call of the whole-file read it belongs to. */
      callId?: string;
      /** For a "reader" request: which part ("part 3 of 12"), or which round of combining notes. */
      detail?: string;
      /** For a request of the chat: the library's estimate of its input tokens, before it is sent. */
      estimatedInputTokens?: number;
    })
  /** A model request ended, after any retries. */
  | (EventBase & {
      type: "request.end";
      requestId: string;
      /** From `request.start` to now, retries and their waits included. */
      ms: number;
      outcome: "ok" | "error";
      /** What the provider said this request used (all its HTTP sends, for a "reader" request). */
      usage?: Partial<ModelUsage>;
      /** How the reply ended, in the library's words. */
      finish?: ModelReply["finish"];
      /** How the reply ended, in the provider's words. */
      finishReason?: string;
      /** How many tool calls the reply asked for. */
      toolCalls?: number;
      /** The provider's ID of the response (`ModelReply.responseId`), when the adapter gives one. New in 0.10.0. */
      responseId?: string;
      /** The model that wrote the response, as the provider names it (`ModelReply.responseModel`). New in 0.10.0. */
      responseModel?: string;
      /** With outcome "error": why. A request that failed may still be followed by others (an overflow made smaller, a part read in halves). */
      error?: EventError;
    })
  /**
   * A model request failed and is sent again after `delayMs`. For a request of the chat, earlier
   * versions told `onActivity` the same in `message`; the retries of a "reader" request (a
   * whole-file read) are told only here.
   */
  | (EventBase & {
      type: "retry";
      requestId: string;
      /** 1 for the first retry. */
      attempt: number;
      delayMs: number;
      error: EventError;
      message: string;
    })
  /** Answer text as it arrives: what `onText` gets. Joined, the deltas of a run are `AskResult.text`. */
  | (EventBase & { type: "text"; requestId: string; delta: string })
  /**
   * A tool call starts to run, or is settled without running (refused, already shown, not run).
   * Calls of one turn run a few at a time, so their starts and ends interleave.
   */
  | (EventBase & {
      type: "tool.start";
      /** Unique in the run: "call_1", "call_2"… The provider's own id, when it sent one, is `providerCallId`. */
      callId: string;
      providerCallId?: string;
      /** The tool's name: "search_document", "read_document"… */
      tool: string;
      /** The arguments as the model sent them. */
      args: Record<string, unknown>;
      /** One line of plain text: "Search app.log (exact) for “timeout”". */
      label: string;
      /** The document the call names, when it names one. */
      documentId?: string;
      /** The turn of the tool loop the call came in, from 1. */
      round: number;
    })
  /** Progress of a tool call that takes long: a whole-file read. Between its `tool.start` and `tool.end`. */
  | (EventBase & {
      type: "tool.progress";
      callId: string;
      /** "map": parts read (its requests have purpose "part"); "reduce": notes combined or the answer written ("merge", "final"). */
      stage: "map" | "reduce";
      done: number;
      total: number;
      /** "Reading app.log: part 3 of 12". */
      message: string;
    })
  /** A tool call ended. Ends come in call order within a turn. */
  | (EventBase & {
      type: "tool.end";
      callId: string;
      outcome: ToolOutcome;
      /** From `tool.start` to now. */
      ms: number;
      /**
       * The finished step, as `onStep` gets it. Absent for "not_run" (one "calls_not_run" notice
       * says it for all of them), and for a call ended because its turn failed (see `outcome`).
       */
      step?: string;
      /** What the call showed the model, as in `AskResult.evidence` (with this `callId`). */
      evidence?: Evidence;
      /** The characters of the JSON result the model was sent. */
      resultCharacters?: number;
      /**
       * When the result the model was sent is an error (outcomes "error", "refused", "not_run"):
       * its message. For a call ended because its turn failed: why, as in `EventError.message`.
       */
      error?: string;
      /** The result itself. Only with `AskOptions.eventResults: true`: it holds document text. */
      result?: ToolResult;
    })
  | (EventBase & {
      type: "notice";
      code: NoticeCode;
      message: string;
      display: NoticeDisplay;
      /**
       * The documents the notice is about: those left out ("documents_missing"), the one found gone
       * ("document_gone"), the one whose pages were not looked at ("page_looks_busy"). New in 0.9.0.
       */
      documentIds?: string[];
      /**
       * With "answer_filtered", under `AskOptions.filteredAnswer: "drop"`: text of the answer was
       * already sent (`text` events, `onText`), and the page should take it away. New in 0.10.0.
       */
      discardText?: true;
    })
  /** Always last when the question returns. Nothing comes after it. */
  | (EventBase & { type: "run.finish"; result: EventResult })
  /**
   * Always last when the question throws (an abort included). Nothing comes after it. `partial` is
   * what `partialResultOf(error)` gives: what the question found before it failed.
   */
  | (EventBase & { type: "run.error"; error: EventError; partial?: EventResult });

/** The stages of an ingest that report progress. Not every file goes through each. */
export type IngestStage = "decode" | "extract" | "check" | "pictures" | "prepare" | "index" | "store";

/** The events of an ingest (`IngestInput.onEvent`), in the order they happen. */
export type IngestEvent =
  /** Always first. `format` is what the name and type say; a text file can still become a log. */
  | (EventBase & { type: "ingest.start"; name: string; format: DocumentFormat; bytes: number })
  /**
   * How far a stage is. `total` is absent when it is not known. Sent at most about every 12 ms, and
   * once more when a stage ends; a stage with no progress to report may send none.
   */
  | (EventBase & {
      type: "ingest.progress";
      stage: IngestStage;
      done: number;
      total?: number;
      unit: "pages" | "parts" | "bytes" | "characters";
    })
  /** Always last when the ingest stores the document. */
  | (EventBase & {
      type: "ingest.finish";
      document: DocumentSummary;
      /**
       * What the upload handler's `onUploaded` returned as `answer`, for the page: only in the
       * event the handler sends, never in the events of `files.ingest`. New in 0.9.0.
       */
      app?: Record<string, unknown>;
    })
  /** Always last when the ingest throws (a refusal or an abort included). */
  | (EventBase & { type: "ingest.error"; error: EventError });

/** Any event of this library. */
export type LibraryEvent = AskEvent | IngestEvent;

/** An event without the fields the emitter stamps on it. */
export type UnstampedEvent<E> = E extends unknown ? Omit<E, keyof EventBase> : never;

const TERMINAL = new Set(["run.finish", "run.error", "ingest.finish", "ingest.error"]);

/** A run id: the prefix, "_" and 16 hex digits ("run_3f9a…"). */
export function newRunId(prefix = "run"): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 16)
    ?? Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${prefix}_${random}`;
}

/** An error as plain event data. */
export function eventErrorOf(error: unknown, message?: string): EventError {
  // It never throws: an error whose fields throw when read (a getter, a proxy) is told plainly.
  try {
    const record = (typeof error === "object" && error !== null ? error : {}) as { kind?: unknown; status?: unknown; name?: unknown; code?: unknown };
    if (IngestError.is(error)) {
      // Its status is the upload's answer, not a model's. A subclass of a name of its own (an
      // extractor's) is told by the name errorInfoOf reads, as a store's own DocumentStoreError is.
      return { message: message ?? error.message, name: "IngestError", code: error.code, ...(error.status !== 422 ? { status: error.status } : {}) };
    }
    // Its code tells a deleted chat from a scope the server gave wrong (errorInfoOf).
    if (DocumentScopeError.is(error)) {
      return { message: message ?? userMessageOf(error), name: "DocumentScopeError", ...(typeof error.code === "string" ? { code: error.code } : {}) };
    }
    const out: EventError = { message: message ?? userMessageOf(error) };
    const own = DocumentStoreError.is(error) ? "DocumentStoreError" : DocumentsNotFoundError.is(error) ? "DocumentsNotFoundError" : undefined;
    if (typeof record.kind === "string") out.kind = record.kind as ModelErrorKind;
    else if (isModelStatus(record.status) && own === undefined && !isPlainData(record)) {
      // A model's error without a kind of its own (an adapter of yours, `httpError`): the kind its
      // status gives, as its message is told, so that a model's EventError always has its kind.
      // Plain data thrown is not an adapter's error, as errorInfoOf reads it. The message is read
      // from any class, an Error or not (an SDK's own), as errorInfoOf and the loop read it.
      const { code, message: text } = record as { code?: unknown; message?: unknown };
      out.kind = classifyModelError(record.status, typeof text === "string" ? text : "", { code: typeof code === "string" ? code : undefined }).kind;
    }
    if (typeof record.status === "number") out.status = record.status;
    // A store's own subclass of DocumentStoreError, of a name of its own, is told by the name
    // errorInfoOf reads, as the upload handlers tell it.
    if (own !== undefined) out.name = own;
    else if (typeof record.name === "string" && record.name) out.name = record.name;
    return out;
  } catch {
    return { message: message ?? SOMETHING_WENT_WRONG };
  }
}

const SOMETHING_WENT_WRONG = "Something went wrong.";

/** Data, not an error: an object of no class, as an `EventError` is, or one parsed from JSON. */
export function isPlainData(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A message for users: a model error by its kind and status, a storage error by its code, the
 * library's own errors (refusals, a stop) as they are written, and anything that is not an
 * `Error` as "Something went wrong."
 */
function userMessageOf(error: unknown): string {
  // The library's own errors with a status (503, 404) are not model errors: their words are safe.
  if (DocumentStoreError.is(error) || DocumentsNotFoundError.is(error)) return (error as Error).message;
  if (typeof error !== "object" || error === null) return SOMETHING_WENT_WRONG;
  const record = error as { kind?: unknown; status?: unknown; code?: unknown; syscall?: unknown; message?: unknown };
  // A model error, as eventErrorOf gives it a kind: the provider's words stay on the error.
  if (typeof record.kind === "string" || (isModelStatus(record.status) && !isPlainData(record))) return modelFailureReason(error);
  // Any other status (thrown plain data, a status no model answers with) is not a model's, and the
  // words that came with it may be anyone's: errorInfoOf tells it so too.
  if (typeof record.status === "number") return SOMETHING_WENT_WRONG;
  // A system error (ENOENT, EACCES…): its message names paths of the server. Its code is told only
  // when it reads as one: a driver may put a host in it.
  if (typeof record.code === "string" && typeof record.syscall === "string") {
    return `The file could not be read from storage${isErrorCode(record.code) ? ` (${record.code})` : ""}.`;
  }
  if (!(error instanceof Error) && !(typeof DOMException !== "undefined" && error instanceof DOMException)) return SOMETHING_WENT_WRONG;
  return typeof record.message === "string" && record.message ? record.message : SOMETHING_WENT_WRONG;
}

/**
 * Stamps events with `seq`, `runId` and `time`, and hands them to one listener. After a terminal
 * event (`run.finish`, `run.error`, `ingest.finish`, `ingest.error`) it drops everything: work
 * that goes on after a question stopped (a part read still running) is never reported.
 */
export class EventEmitter<E extends { type: string }> {
  private seq = 0;
  private closed = false;

  constructor(
    readonly runId: string,
    private readonly listener: ((event: E) => void) | undefined,
  ) {}

  /** False when nobody listens or the run has ended: callers may skip building an event. */
  get active(): boolean {
    return this.listener !== undefined && !this.closed;
  }

  /** True once a terminal event was emitted. */
  get ended(): boolean {
    return this.closed;
  }

  emit(event: UnstampedEvent<E>): void {
    if (this.closed) return;
    if (TERMINAL.has(event.type)) this.closed = true;
    if (!this.listener) return;
    this.listener({ ...event, seq: ++this.seq, runId: this.runId, time: Date.now() } as unknown as E);
  }
}

/** The events of a run as an async iterable, and how the run ended. */
export type EventStream<E, T> = AsyncIterable<E> & {
  /** What the run returned. Rejects with its error; awaiting it is optional (it never goes unhandled). */
  result: Promise<T>;
  /** Stops the run: its signal aborts, and the stream ends after the run's last event. */
  abort(reason?: unknown): void;
};

/**
 * Runs `run` at once and gives its events as an async iterable. Events wait in memory until they
 * are read. Leaving the loop early (`break`, `return`, a throw) aborts the run. The iterable ends
 * after the run's last event; it does not throw when the run fails: read the `run.error` event, or
 * await `result`. It can be iterated once.
 */
export function eventStream<E, T>(
  run: (onEvent: (event: E) => void, signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal | undefined } = {},
): EventStream<E, T> {
  const controller = new AbortController();
  const outer = options.signal;
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuterAbort, { once: true });

  const queue: E[] = [];
  // Calls of next() waiting for an event, oldest first: each gets the next event in turn.
  const waiters: Array<(result: IteratorResult<E>) => void> = [];
  let finished = false;
  // Set by return(): the reader left, so nothing more is queued or handed out.
  let closed = false;
  const settleWaiters = () => {
    for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true });
  };
  const onEvent = (event: E) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  };

  let started: Promise<T>;
  try {
    started = run(onEvent, controller.signal);
  } catch (error) {
    started = Promise.reject(error);
  }
  const result = started.finally(() => {
    finished = true;
    outer?.removeEventListener("abort", onOuterAbort);
    // Every event came before the run settled: whoever still waits gets the end.
    settleWaiters();
  });
  result.catch(() => undefined);

  let iterated = false;
  return {
    result,
    abort(reason?: unknown) {
      controller.abort(reason ?? new DOMException("The run was stopped.", "AbortError"));
    },
    [Symbol.asyncIterator](): AsyncIterator<E> {
      if (iterated) throw new TypeError("These events can be read once.");
      iterated = true;
      return {
        next(): Promise<IteratorResult<E>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (finished || closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        async return(): Promise<IteratorResult<E>> {
          if (!finished && !closed) controller.abort(new DOMException("The events stopped being read.", "AbortError"));
          closed = true;
          queue.length = 0;
          settleWaiters();
          return { value: undefined, done: true };
        },
      };
    },
  };
}
