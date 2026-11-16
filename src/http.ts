// Small things every adapter needs for its HTTP requests.

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
 * A wait for `next` that ends with the signal's reason when the signal aborts first. The global
 * `fetch` ends the body of a request whose signal aborts; another `fetch` (or a test's) may not,
 * and a watch on the request must still end it.
 */
function until<T>(next: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
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
    if (signal?.aborted) {
      // A read may still be waiting, on a stream that the fetch does not end when the signal
      // aborts: `return()` would wait behind it for ever. The stream is destroyed (without the
      // reason, which an HTTP request would raise as an error of its own), and not waited for.
      (body as { destroy?: () => void }).destroy?.();
      void pieces.return?.()?.catch(() => undefined);
    } else {
      await pieces.return?.().catch(() => undefined);
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
 * failed before the headers. A body that came whole but is not JSON (a gateway's HTML page) throws
 * its `SyntaxError` as it is, with no status: a chat request is not sent again for it, and a part
 * read is tried once more, as for any failure that gives no reason. With an `IdleWatch`, pass its
 * `pulse` as `onData` (keep-alive blank lines count) and its signal.
 */
export async function readJson<T>(response: Response, stopped: () => boolean, unreachable: (error: unknown) => Error, watch?: Pick<IdleWatch, "pulse" | "signal">): Promise<T> {
  let text: string;
  try {
    text = watch && response.body ? await readText(response.body, watch.pulse, watch.signal) : await response.text();
  } catch (error) {
    if (stopped()) throw error;
    throw unreachable(error);
  }
  return JSON.parse(text) as T;
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
  return { args: {}, problem: `The arguments of this call were not a JSON object, and it was not run: ${text.slice(0, 300)}. Send the call again.` };
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
