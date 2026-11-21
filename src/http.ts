// Small things every adapter needs for its HTTP requests.
import { sliceWhole } from "./text.js";

/** Request headers, or a function returning them: called for each request, so a token can be renewed. */
export type HeaderSource = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export async function resolveHeaderSource(source: HeaderSource | undefined): Promise<Record<string, string>> {
  return typeof source === "function" ? source() : source ?? {};
}

/** A secret, or a function returning it: called for each request. */
export type SecretSource = string | (() => string | Promise<string>);

export async function resolveSecret(source: SecretSource | undefined): Promise<string | undefined> {
  return typeof source === "function" ? source() : source;
}

/** Base64 of bytes, worked out once for each array: the pages of a PDF are sent again with every later request. */
const encoded = new WeakMap<Uint8Array, string>();
export function base64(bytes: Uint8Array): string {
  let text = encoded.get(bytes);
  if (text === undefined) {
    text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    encoded.set(bytes, text);
  }
  return text;
}

/** The reason a request never got an answer, without the stack of the HTTP client. */
export function unreachableReason(error: unknown): string {
  return error instanceof Error && error.message ? ` (${error.message})` : "";
}

/**
 * The longest wait, by default, between two pieces of a reply once it has started to arrive: an
 * event of a stream, a keep-alive, a piece of a body. A model that is writing sends something
 * well within it.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/**
 * The longest wait, by default, for the first piece of a reply. Headers do not count: some servers
 * send them at once. A model that thinks sends nothing while it does (Gemini without its thoughts,
 * OpenAI's reasoning models), and a reply that is not streamed comes whole at the end, so this
 * wait is long enough for a model that thinks long on a large request.
 */
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 600_000;

/** The longest delay `setTimeout` takes: a longer one fires at once. About 24.8 days, which is no limit. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** Watches a request for silence: see `idleWatch`. */
export type IdleWatch = {
  /** The signal for `fetch`: it aborts when the caller's does, or when nothing arrived for the whole wait. */
  readonly signal: AbortSignal | undefined;
  /** A piece of the reply arrived: from now on the wait is the one between pieces, and it starts again. */
  pulse(): void;
  /** The reply is in, or failed: the watch ends. */
  stop(): void;
  /** True once a wait ran out with nothing arriving. The request was then aborted by the watch, not by the caller. */
  readonly expired: boolean;
  /** The wait that ran out, in milliseconds, for the message. */
  readonly waitedMs: number;
};

/** How long an adapter waits: before the first piece of a reply, and between pieces. 0 waits without end. */
export type IdleWaits = { firstByteTimeoutMs?: number | undefined; idleTimeoutMs?: number | undefined };

const watching = (ms: number | undefined): ms is number => ms !== undefined && Number.isFinite(ms) && ms > 0;

/**
 * A watch on one model request: when nothing arrives for the wait (`firstByteTimeoutMs` before the
 * first piece of the reply, `idleTimeoutMs` between pieces), the request is aborted, and `expired`
 * tells that apart from the caller's own abort. There is no cap on the time of a reply that keeps
 * arriving. A wait of 0 watches nothing.
 */
export function idleWatch(caller: AbortSignal | undefined, waits: IdleWaits = {}): IdleWatch {
  const first = waits.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const between = waits.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!watching(first) && !watching(between)) {
    return { signal: caller, pulse() {}, stop() {}, expired: false, waitedMs: 0 };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let stopped = false;
  let waitedMs = 0;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || !watching(ms)) return;
    timer = setTimeout(() => {
      expired = true;
      waitedMs = ms;
      controller.abort(new Error(`Nothing arrived from the model for ${Math.round(ms / 1_000)} s.`));
    }, Math.min(ms, LONGEST_TIMER_MS));
  };
  arm(first);
  return {
    signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
    pulse: () => arm(between),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    get expired() {
      return expired;
    },
    get waitedMs() {
      return waitedMs;
    },
  };
}

/**
 * How long, in milliseconds, the end of a streamed body is waited for once the reply said it is
 * whole (OpenAI's `[DONE]`, Claude's `message_stop`). A server ends the body at once: the wait lets
 * the connection be used again. One that leaves it open is not waited for longer.
 */
export const REPLY_END_GRACE_MS = 1_000;

/** The end of a streamed reply, once it said it is whole: see `replyEnd`. */
export type ReplyEnd = {
  /** The signal to read the stream with: the watch's, and the end of the grace that follows `reached`. */
  readonly signal: AbortSignal;
  /** The reply said it is whole: the watch ends, and the body is read for `REPLY_END_GRACE_MS` more at most. */
  reached(): void;
  /**
   * True once the reply said it is whole (`reached`): a connection that breaks after that, rather
   * than end, loses nothing of the reply.
   */
  readonly whole: boolean;
  /** True for the error of a body left after that grace: what came before it is the whole reply. */
  left(error: unknown): boolean;
  /** The reading is over: the grace is not waited for. */
  dispose(): void;
};

/**
 * The end of a streamed reply. A server that says the reply is whole and then leaves the
 * connection open would hold the request until the watch ran out, and fail it as silent, with the
 * whole answer already shown.
 */
export function replyEnd(watch: Pick<IdleWatch, "signal" | "stop">): ReplyEnd {
  const controller = new AbortController();
  const ended = new Error("The reply is whole, and its body was left open.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    signal: watch.signal ? AbortSignal.any([watch.signal, controller.signal]) : controller.signal,
    reached() {
      if (timer !== undefined) return;
      watch.stop();
      timer = setTimeout(() => controller.abort(ended), REPLY_END_GRACE_MS);
    },
    get whole() {
      return timer !== undefined;
    },
    left: (error) => error === ended,
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * A wait for `next` that ends with the signal's reason when the signal aborts first. The global
 * `fetch` ends the body of a request whose signal aborts; another `fetch` (or a test's) may not,
 * and a watch on the request must still end it. The tool loop waits for a model request the same
 * way: an adapter of an application's own may not stop when the signal aborts.
 */
export function until<T>(next: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return next;
  if (signal.aborted) {
    // The read is not waited for: when it fails later, that is no error of anyone's.
    next.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    next.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/**
 * The pieces of a body as they arrive: from a web stream (the global `fetch`), or from a Node
 * stream (node-fetch and the like), which has no `getReader`. A reader that is left early is
 * cancelled. When `signal` aborts, the next piece is not waited for.
 */
export async function* bodyPieces(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        // No read is started after an abort.
        signal?.throwIfAborted();
        const { done, value } = await until(reader.read(), signal);
        if (done) return;
        if (value) yield value;
      }
    } finally {
      // Not waited for: a stream whose cancel never settles (a `fetch` of a test, or of a library)
      // would hold the request after its watch ran out, or after the reply was whole.
      try {
        Promise.resolve(reader.cancel()).catch(() => undefined);
        reader.releaseLock();
      } catch {
        // A reader of the app's whose `cancel()` gives no promise, or throws at once, is no error of the caller's.
      }
    }
  }
  const encoder = new TextEncoder();
  const pieces = (body as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await until(pieces.next(), signal);
      if (done) return;
      yield typeof value === "string" ? encoder.encode(value) : value;
    }
  } finally {
    // A read may still be waiting, on a stream that the fetch does not end when the signal
    // aborts: `return()` would wait behind it for ever. The stream is destroyed (without the
    // reason, which an HTTP request would raise as an error of its own).
    if (signal?.aborted) (body as { destroy?: () => void }).destroy?.();
    // Not waited for, as a web stream's cancel is not: an iterable of the app's whose `return()`
    // never settles would hold the caller, and the error it is to be told of.
    try {
      Promise.resolve(pieces.return?.()).catch(() => undefined);
    } catch {
      // A `return()` that throws at once is no error of the caller's.
    }
  }
}

/** Reads a body as text a piece at a time, calling `onData` for each piece. */
async function readText(body: ReadableStream<Uint8Array>, onData: () => void, signal: AbortSignal | undefined): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const piece of bodyPieces(body, signal)) {
    if (piece.length === 0) continue;
    text += decoder.decode(piece, { stream: true });
    onData();
  }
  return text + decoder.decode();
}

/**
 * The body of a response that is not streamed, as JSON. A connection that fails while the body
 * arrives is `unreachable(error)`, a request that got no answer, which is sent again like one that
 * failed before the headers; it is noted as a reply cut off on its way (`isCutReply`), and so is a
 * body that ended empty. A body that came whole but is not JSON (a gateway's HTML page) is
 * `notJson(error)`: see `notJsonMessage`.
 * With an `IdleWatch`, pass its `pulse` as `onData` (keep-alive blank lines count) and its signal.
 */
export async function readJson<T>(response: Response, stopped: () => boolean, unreachable: (error: unknown) => Error, watch: Pick<IdleWatch, "pulse" | "signal"> | undefined, notJson: (error: unknown) => Error): Promise<T> {
  let text: string;
  try {
    text = watch && response.body ? await readText(response.body, watch.pulse, watch.signal) : await response.text();
  } catch (error) {
    if (stopped()) throw error;
    throw noteCutReply(unreachable(error));
  }
  // A body that ended before anything came is a reply cut off on its way, not a page in its place.
  if (!text.trim()) throw noteCutReply(unreachable(new Error("the reply was empty")));
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw notJson(error);
  }
}

/**
 * The message of a reply that came with a status of success but is not JSON: most often a page of
 * a proxy or a gateway (a sign-in page, an error page) that answered in the model's place. It is
 * not sent again: the same page would most likely come back. `who` is "Gemini's", "Claude's"…
 */
export function notJsonMessage(who: string, response: Response): string {
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  return `${who} reply could not be read: it was not JSON${type ? ` (${type})` : ""}. A proxy or gateway may have answered in its place.`;
}

/** Errors of a reply that was cut off on its way: it began to arrive, and did not arrive whole. */
const cutReplies = new WeakSet<object>();

/**
 * Takes note that this error is that of a reply cut off on its way (a stream that closed before
 * its end, a connection that failed while the reply arrived), not of a model that could not be
 * reached at all. Returns the error.
 */
export function noteCutReply<E extends Error>(error: E): E {
  cutReplies.add(error);
  return error;
}

/** Whether this is the error of a reply cut off on its way (see `noteCutReply`). */
export function isCutReply(error: unknown): boolean {
  return typeof error === "object" && error !== null && cutReplies.has(error);
}

/**
 * The most white space, in characters, that the body of a reply asked for as a stream is read
 * through to tell what it is (see `streamedReply`). A body with more before anything else is read
 * as JSON.
 */
const LONGEST_BLANK_START = 65_536;

/**
 * The first pieces of a body told to be events, without the byte order mark and the white space
 * before the first event: an event stream's parser reads a first line "  data: {...}" as a field
 * named "  data", and drops the event.
 */
function withoutBlankStart(pieces: Uint8Array[]): Uint8Array[] {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    bytes.set(piece, at);
    at += piece.length;
  }
  let skip = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (skip < total && (bytes[skip] === 0x20 || bytes[skip] === 0x09 || bytes[skip] === 0x0a || bytes[skip] === 0x0d)) skip++;
  return skip === 0 ? pieces : [bytes.subarray(skip)];
}

/**
 * How to read the body of a reply that was asked for as a stream: as server-sent events, or as
 * JSON in one piece. A reply of type `text/event-stream` is events. Of any other type, its first
 * characters tell: a gateway may stream under another type (`application/octet-stream`, or none),
 * and a server may answer in one piece. A body that starts like neither (an HTML page), or with
 * more than `LONGEST_BLANK_START` characters of white space, is read as JSON, which it is not: see
 * `readJson`. The pieces read to tell are pulses of the watch, and the `response` returned holds
 * the whole body again.
 */
export async function streamedReply(response: Response, watch: Pick<IdleWatch, "pulse" | "signal">): Promise<{ events: boolean; response: Response }> {
  const type = response.headers.get("content-type") ?? "";
  if (/event-stream/i.test(type)) return { events: true, response };
  if (!response.body) return { events: false, response };
  // The body given back may be left before its end (a reply that said it is whole, and stayed
  // open): its reader then stops this one too, which cancels the body it reads.
  const left = new AbortController();
  const pieces = bodyPieces(response.body, watch.signal ? AbortSignal.any([watch.signal, left.signal]) : left.signal);
  const head: Uint8Array[] = [];
  const decoder = new TextDecoder();
  /** The start of the body, without the white space before it: only that is looked at. */
  let start = "";
  /** The characters of white space that came before it. */
  let blank = 0;
  let ended = false;
  let events: boolean | undefined;
  while (events === undefined) {
    const next = await pieces.next();
    if (next.done) {
      ended = true;
      events = startsEvents(start, true) ?? false;
      break;
    }
    if (next.value.length > 0) watch.pulse();
    head.push(next.value);
    const text = start + decoder.decode(next.value, { stream: true });
    start = text.trimStart();
    blank += text.length - start.length;
    // A body of white space alone is not waited on to its end: past so much of it, the body is read
    // as JSON, which it is not, whatever comes after it, and however the pieces are cut.
    events = blank > LONGEST_BLANK_START ? false : startsEvents(start, false);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of events ? withoutBlankStart(head) : head) controller.enqueue(piece);
      if (ended) controller.close();
    },
    async pull(controller) {
      const next = await pieces.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      // A read may still wait on the body, and `return` would wait behind it: the read is stopped.
      left.abort(reason);
      void pieces.return(undefined).catch(() => undefined);
    },
    // Nothing is read ahead of the reader: what is left unread when it stops is cancelled.
  }, { highWaterMark: 0 });
  return { events, response: new Response(body, { headers: type ? { "content-type": type } : {} }) };
}

/**
 * Whether a body that starts with `text` is server-sent events (a field such as `data:`, or a
 * comment), or else JSON or a page: undefined while too little has come to tell.
 */
function startsEvents(text: string, whole: boolean): boolean | undefined {
  const start = text.trimStart();
  if (/^(?::|(?:data|event|id|retry):)/.test(start)) return true;
  if (/^[{[]/.test(start) || start.length >= 6 || /[\r\n]/.test(start)) return false;
  return whole ? false : undefined;
}

/**
 * Arguments of a tool call that arrived as JSON text, and, when the text is not a JSON object,
 * why the call cannot be run: a model that is told so sends the call again.
 */
export function readArguments(text: unknown): { args: Record<string, unknown>; problem?: string } {
  if (text && typeof text === "object" && !Array.isArray(text)) return { args: text as Record<string, unknown> };
  if (typeof text !== "string" || !text.trim()) return { args: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return { args: value as Record<string, unknown> };
  } catch {
    // Reported below.
  }
  return { args: {}, problem: `The arguments of this call were not a JSON object, and it was not run: ${sliceWhole(text, 300)}. Send the call again.` };
}

/** Arguments of a tool call that arrived as JSON text. Text that is no JSON object gives none. */
export function parseArguments(text: unknown): Record<string, unknown> {
  if (text && typeof text === "object" && !Array.isArray(text)) return text as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
