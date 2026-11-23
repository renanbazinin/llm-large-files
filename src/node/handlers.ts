import type { IncomingMessage, ServerResponse } from "node:http";
import { errorInfoOf, STORE_RETRY_AFTER_MS } from "../error-info.js";
import { DocumentScopeError, DocumentStoreError, IngestError, type IngestErrorCode } from "../errors.js";
import { eventStream, newRunId, type EventError, type IngestEvent } from "../events.js";
import { checkOwner, toDocumentSummary, type AccessOptions, type IngestInput, type LargeFiles } from "../library.js";
import { DocumentsNotFoundError, errorKindOf, ModelRequestError } from "../model.js";
import { formatBytes } from "../plan.js";
import { checkScope } from "../scope.js";
import type { DocumentMeta, DocumentScope } from "../types.js";
import { writeSseEvents } from "./sse.js";

/** What `onUploaded` is told besides the document. New in 0.9.0. */
export type UploadedContext = {
  /** The upload's request, for its headers and URL. Its body has been read: the bytes are not here. */
  request: IncomingMessage;
  /** What `getOwner` returned, when it returned an owner. */
  owner?: string;
  /** What `getScope` returned, when it returned a scope (a frozen copy). */
  scope?: DocumentScope;
  /**
   * True when the client went away before the hook was called: the document is stored all the
   * same, and nobody gets the answer. Record it, or remove it, as your app needs.
   */
  clientGone: boolean;
};

/**
 * What `onUploaded` may return: nothing, or `{ answer }`, whose fields are added to the upload's
 * answer (the `201` JSON, or `ingest.finish.app`). New in 0.9.0.
 */
export type UploadedResult = void | { answer?: Record<string, unknown> };

/** What `onRemoved` is told besides the document's ID. New in 0.9.0. */
export type RemovedContext = {
  request: IncomingMessage;
  owner?: string;
  scope?: DocumentScope;
};

/**
 * An error as the upload handler answers it (`uploadAnswerOf`): the HTTP status, the message of
 * the JSON body `{ "error": … }`, the `IngestErrorCode` of a file that could not be read, and how
 * long to wait before trying again (the `Retry-After` header of a 503). New in 0.9.0.
 */
export type UploadAnswer = {
  status: number;
  error: string;
  code?: IngestErrorCode;
  retryAfterMs?: number;
};

export type DocumentHandlerOptions = {
  /**
   * The signed-in user for this request. When set, uploads are owned by that user and other
   * users cannot read or delete them. Return undefined to allow anonymous access. An empty owner
   * ("", spaces only, or null from JavaScript) is the server's mistake: the upload is answered with a 500
   * `{"error":"Upload failed (empty owner)."}`, before its body is read. So is an owner from
   * JavaScript that is neither a string nor a finite number (`req.user` in place of `req.user.id`,
   * say): `{"error":"Upload failed (owner is not a string)."}`.
   *
   * When the library requires an owner (`requireOwner`), it is required here: the handlers cannot
   * be made without it, and an undefined owner is answered 401 `{"error":"Sign in first."}`
   * before the body is read (new in 0.9.0).
   *
   * To refuse a request, throw an error with a `status` (or `statusCode`) between 400 and 599, as
   * the `http-errors` package makes: the handler answers with that status and the error's message.
   * Any other error is answered with a 500 that does not repeat its message. It is called before
   * the upload is read, so a refused upload is not buffered.
   */
  getOwner?: (request: IncomingMessage) => string | undefined | Promise<string | undefined>;
  /**
   * The scope of this request, such as [userId, chatId] (`DocumentScope`): uploads are stored in
   * it, and `get` and `remove` find only the documents of the same scope. Called after `getOwner`,
   * before the body is read, on every route. Return undefined for no scope. A scope that is not
   * valid is the server's mistake: a 500 `{"error":"Upload failed (invalid scope)."}`. Throw an
   * error with a status to refuse a request, as for `getOwner`. Required when the library requires
   * a scope (`requireScope`); an undefined scope is then a 500 `{"error":"Upload failed (no scope)."}`.
   * New in 0.9.0.
   */
  getScope?: (request: IncomingMessage) => DocumentScope | undefined | Promise<DocumentScope | undefined>;
  /**
   * Called once an upload is stored, before it is answered: to record the document in your
   * database, say. The `201` is sent, or `ingest.finish` on the event-stream path, once it
   * resolves. It is called even when the client went away meanwhile (`clientGone`). Return
   * `{ answer }` to add its fields to the answer: to the `201` JSON (the summary's own fields win),
   * or as `app` in `ingest.finish`. `answer` must be a plain object that JSON can hold.
   *
   * When it throws, or returns an `answer` that is not such an object, the document is deleted
   * (best effort) and the upload is answered as for an error of `ingest`: with the error's status
   * (400 to 599) and message, or a 500 `{"error":"Upload failed."}`. New in 0.9.0.
   */
  onUploaded?: (document: DocumentMeta, context: UploadedContext) => UploadedResult | Promise<UploadedResult>;
  /**
   * Called after `remove` deleted a document (`{ deleted: true }`), before it answers. When it
   * throws, the answer is the error's status and message, or a 500; the document is deleted all
   * the same, and a second `remove` answers `{ deleted: false }` without calling it. New in 0.9.0.
   */
  onRemoved?: (id: string, context: RemovedContext) => void | Promise<void>;
  /**
   * The most bytes of uploads these handlers hold at once: an upload is held whole in memory from
   * the moment its body is read until its ingest ends. An upload that would pass it is answered 503
   * with `Retry-After` before its body is read, while another upload is held: one upload alone is
   * always taken. An upload counts its `Content-Length` (or `maxUploadBytes` without one, then its
   * size once read). `Infinity` for no limit (as before 0.8.2). Defaults to twice `maxUploadBytes`.
   * New in 0.8.2.
   */
  maxPendingUploadBytes?: number;
  /**
   * An upload whose body stops arriving for this many milliseconds is answered 408, its connection
   * closed and its room given back: a client that sends its headers and then nothing, or stalls,
   * holds its room no longer. 0 or `Infinity` for no limit. Defaults to 30,000. New in 0.8.2.
   */
  uploadIdleTimeoutMs?: number;
};

/**
 * The handlers answer every request themselves, errors included, and never reject: they can be
 * called without a `catch`, from `node:http`, from Express 4 (which does not catch a rejected
 * promise) or from Express 5.
 */
export type DocumentHandlers = {
  /**
   * POST: the body is the raw file. Name it with an `X-File-Name` header (URI-encoded) or `?name=`.
   * A file that cannot be read is answered with a 422 and the reason. A store that fails while it
   * writes is answered with a 503 and `Retry-After`. Any other error is answered as
   * `uploadAnswerOf` says.
   *
   * When the request's `Accept` header names `text/event-stream` (not with `q=0`, nor only through a
   * wildcard), a file that passes the checks of the name, the owner, the scope and the size (which
   * still answer with an HTTP error) is answered with a 200 and Server-Sent Events: the ingest's
   * events (`ingest.start`, `ingest.progress`…), ending with `ingest.finish`, whose data is the
   * summary a 201 would hold (and `onUploaded`'s answer in `app`), or `ingest.error`, whose data is
   * `{ error: { message, status } }` with the message and status a JSON answer would have, the
   * `code` of a refused file, and the `name` of a store that failed or of a scope error (with its
   * `code`), for `errorInfoOf`.
   */
  upload(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** GET: the document's summary, or 404. With `getScope`, only a document of the request's scope. */
  get(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
  /** DELETE: removes the document, then calls `onRemoved`. Responds `{ deleted: boolean }`. */
  remove(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
};

class HttpError extends Error {
  /** `close`: answer, then close the connection, without waiting for the rest of the body. */
  constructor(readonly status: number, message: string, readonly close = false) {
    super(message);
  }
}

/** A whole HTTP status of an error, from 400 to 599. */
const isErrorStatus = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
/** A wait in milliseconds: a finite number of 0 or more. */
const isWait = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The HTTP status an error carries: this module's, or one `getOwner` throws (`http-errors` style). */
function statusOf(error: unknown): number | undefined {
  if (error instanceof HttpError) return error.status;
  if (!(error instanceof Error)) return undefined;
  const { status, statusCode } = error as Error & { status?: unknown; statusCode?: unknown };
  const value = typeof status === "number" ? status : statusCode;
  return isErrorStatus(value) ? value : undefined;
}

/**
 * The code of a Node system error (a file or network call that failed, as `ENOSPC`). Its message
 * names server paths or hosts, so only the code is passed on.
 */
function systemErrorCode(error: unknown): string | undefined {
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
  return typeof code === "string" && typeof syscall === "string" ? code : undefined;
}

/** What the handlers answer a scope that is gone (`DocumentScopeError` "scope_missing"): the chat was deleted. */
const CHAT_GONE = "This chat no longer exists.";

/**
 * An error as the handlers answer it, `failed` saying what failed ("Upload failed"). See
 * `uploadAnswerOf`. It never throws: an error whose fields throw when read is a 500.
 */
function answerFor(error: unknown, failed: string): UploadAnswer {
  const plain: UploadAnswer = { status: 500, error: `${failed}.` };
  try {
    if (error instanceof HttpError) return { status: error.status, error: error.message || plain.error };
    if (IngestError.is(error)) {
      const status = isErrorStatus(error.status) ? error.status : 422;
      return {
        status,
        error: typeof error.message === "string" && error.message ? error.message : plain.error,
        code: error.code,
        ...(status === 503 && isWait(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    // Its message names what failed and a code, never a path or a host.
    if (DocumentStoreError.is(error)) return { status: 503, error: errorInfoOf(error).message, retryAfterMs: STORE_RETRY_AFTER_MS };
    // A scope the server gave wrong, or did not give, is its own bug: not the client's to fix.
    if (DocumentScopeError.is(error)) return error.code === "scope_missing" ? { status: 404, error: CHAT_GONE } : plain;
    // A model's error (an ingest or a hook of your own that asks one): its status is the provider's,
    // and its message the provider's words, which may name a project or a key.
    if (ModelRequestError.is(error) || errorKindOf(error) !== undefined) {
      const info = errorInfoOf(error);
      if (info.category === "model") return { status: info.status, error: info.message, ...(info.status === 429 || info.status === 503 ? retryOf(info.retryAfterMs) : {}) };
    }
    const status = statusOf(error);
    if (status !== undefined) {
      const message = (error as Error).message;
      return { status, error: typeof message === "string" && message ? message : plain.error, ...(status === 503 ? retryOf((error as { retryAfterMs?: unknown }).retryAfterMs) : {}) };
    }
    const code = systemErrorCode(error);
    return code ? { status: 500, error: `${failed} (${code}).` } : plain;
  } catch {
    return plain;
  }
}

const retryOf = (value: unknown): { retryAfterMs?: number } => (isWait(value) ? { retryAfterMs: value } : {});

/**
 * How the upload handler answers an error, for a route of your own that ingests files and should
 * answer as it does:
 * - an `IngestError` (a file that could not be read): its status (422; 413, 409, or 503 for "busy"
 *   with its `retryAfterMs`), its message and its `code`. Only an `IngestError` is a 422;
 * - a `DocumentStoreError`: 503, its message (which names no path or host), and 5 s to wait;
 * - a `DocumentScopeError` "scope_missing": 404 "This chat no longer exists."; the other codes
 *   are the server's mistake: 500 "Upload failed.";
 * - a model's error (`ModelRequestError`): the status and words of `errorInfoOf`, never the
 *   provider's own;
 * - any other error with a `status` (or `statusCode`) from 400 to 599: that status and its message;
 * - a Node system error (a `code` and a `syscall`): 500 "Upload failed (ENOSPC).";
 * - anything else: 500 "Upload failed.", without its message, which may name a host.
 *
 * It reads the errors of every copy of the package, and never throws. New in 0.9.0.
 */
export function uploadAnswerOf(error: unknown): UploadAnswer {
  return answerFor(error, "Upload failed");
}

/**
 * Answers a failed request with JSON (see `answerFor`). A 413 of the handler or of `ingest` gets the
 * size message of the upload. An answer that says when to try again (a busy reader, a store, a
 * model's rate limit) sets `Retry-After`.
 */
function fail(response: ServerResponse, error: unknown, failed: string, tooLarge: string, unread?: IncomingMessage): void {
  const answer = answerFor(error, failed);
  if (answer.retryAfterMs !== undefined && !response.headersSent) {
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil(answer.retryAfterMs / 1_000))));
  }
  send(response, answer.status, { error: messageOf(answer, error, tooLarge) }, unread);
}

/** The message of an answer: a 413 of the handler itself, or of `ingest`, says the upload limit. */
function messageOf(answer: UploadAnswer, error: unknown, tooLarge: string): string {
  return answer.status === 413 && (error instanceof HttpError || IngestError.is(error)) ? tooLarge : answer.error;
}

/**
 * Whether the client asked for the upload's progress as Server-Sent Events: its `Accept` header
 * names `text/event-stream` itself, without `q=0`. A wildcard (`text/*`, or any type at all) keeps
 * the JSON answer.
 */
function wantsEvents(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return (Array.isArray(accept) ? accept.join(",") : accept ?? "").split(",").some((range) => {
    const [type, ...parameters] = range.split(";").map((part) => part.trim().toLowerCase());
    if (type !== "text/event-stream") return false;
    const q = parameters.map((parameter) => parameter.split("=").map((part) => part.trim())).find(([name]) => name === "q");
    return q === undefined || Number(q[1]) > 0;
  });
}

/**
 * What `onUploaded` came to for one upload: the fields to add to its answer, or the error to answer
 * with instead (the document then deleted).
 */
type Hooked = { answer?: Record<string, unknown> } | { failure: unknown };

/**
 * An error as `ingest.error` carries it: the message, status and code of the JSON answer, and which
 * of the library's errors it is, so that `errorInfoOf` reads it in the browser as on the server.
 */
function eventErrorFor(error: unknown, tooLarge: string): EventError {
  const answer = answerFor(error, "Upload failed");
  // A file that could not be read also says why, for a page that tells it in its own words.
  return { message: messageOf(answer, error, tooLarge), status: answer.status, ...identityOf(error), ...(answer.code !== undefined ? { code: answer.code } : {}) };
}

/**
 * The name of a store's failure, of documents that are gone, or of a scope that cannot be used
 * (with its code, which tells a deleted chat apart), for `EventError`. Nothing for other errors:
 * a refused file is told by its `code`.
 */
function identityOf(error: unknown): Pick<EventError, "name" | "code"> {
  try {
    if (DocumentStoreError.is(error)) return { name: "DocumentStoreError" };
    if (DocumentsNotFoundError.is(error)) return { name: "DocumentsNotFoundError" };
    if (DocumentScopeError.is(error)) return { name: "DocumentScopeError", ...(typeof error.code === "string" ? { code: error.code } : {}) };
  } catch {
    // A proxy whose traps throw: told plainly.
  }
  return {};
}

/**
 * Ingests the upload and answers with its events as Server-Sent Events. The last one is always
 * `ingest.finish` or `ingest.error`, even with a `LargeFiles` of your own whose `ingest` sends no
 * events. `uploaded` runs `onUploaded` once, before `ingest.finish` is sent; or after the stream, for
 * a document stored once the client went away.
 */
async function streamIngest(
  files: LargeFiles,
  input: IngestInput,
  response: ServerResponse,
  tooLarge: string,
  uploaded: (meta: DocumentMeta) => Promise<Hooked>,
): Promise<void> {
  const runId = newRunId("ing");
  const stream = eventStream<IngestEvent, DocumentMeta>(
    (onEvent, signal) => files.ingest({ ...input, runId, onEvent, signal }),
    { signal: input.signal },
  );
  // The error as a JSON answer would give it: the event's own may hold a store's message.
  const answer = async (fallback: EventError): Promise<EventError> => {
    try {
      await stream.result;
      return { message: fallback.message, ...(fallback.status !== undefined ? { status: fallback.status } : {}) };
    } catch (error) {
      return eventErrorFor(error, tooLarge);
    }
  };
  /** The last event of a stored document: `ingest.finish` once `onUploaded` is done, or `ingest.error` when it failed. */
  const finished = async (base: { seq: number; runId: string; time: number }, last: (IngestEvent & { type: "ingest.finish" }) | undefined): Promise<IngestEvent> => {
    let meta: DocumentMeta;
    try {
      meta = await stream.result;
    } catch {
      // An ingest of your own that sent ingest.finish, then failed.
      return { ...base, type: "ingest.error", error: await answer({ message: "Upload failed." }) };
    }
    const hooked = await uploaded(meta);
    if ("failure" in hooked) return { ...base, type: "ingest.error", error: eventErrorFor(hooked.failure, tooLarge) };
    const event: IngestEvent = last ?? { ...base, type: "ingest.finish", document: toDocumentSummary(meta) };
    return hooked.answer ? { ...event, app: hooked.answer } as IngestEvent : event;
  };
  async function* events(): AsyncGenerator<IngestEvent> {
    let seq = 0;
    for await (const event of stream) {
      seq = event.seq;
      if (event.type === "ingest.error") {
        yield { ...event, error: await answer(event.error) };
        return;
      }
      if (event.type === "ingest.finish") {
        yield await finished({ seq: event.seq, runId: event.runId, time: event.time }, event);
        return;
      }
      yield event;
    }
    // The ingest ended without a last event: a `LargeFiles` of your own whose ingest sends none.
    yield await finished({ seq: seq + 1, runId, time: Date.now() }, undefined);
  }
  // Each message is the event itself, as for a question: `ingest.finish` holds the summary a 201
  // answer would (`document`), `ingest.error` the message and status a JSON answer would (`error`).
  await writeSseEvents(response, events());
  // A client that went away ends the stream at once, while the ingest stops (a store write may still
  // be under way): the upload is held until then, as on the JSON path. A document stored all the
  // same still goes to `onUploaded` (with `clientGone`), once.
  const meta = await stream.result.catch(() => undefined);
  if (meta !== undefined) await uploaded(meta);
}

/**
 * Answers with `value` as JSON. With `unread`, a request whose body was not read to its end (an
 * upload refused as too large, or before it was read): the answer is written now, so that a client
 * still sending reads it, and ended once the rest of the body is drained (see `drain`).
 */
function send(response: ServerResponse, status: number, value: unknown, unread?: IncomingMessage): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  const body = JSON.stringify(value);
  if (!unread || unread.complete || unread.destroyed) return void response.end(body);
  response.write(body);
  drain(unread, response);
}

/** A header's value as it came (the first, when it came more than once), or "". */
function rawHeader(request: IncomingMessage, name: string): string {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? "";
}

/**
 * A header the page URI-encodes (`X-File-Name`, `X-File-Type`), decoded: a value that does not
 * decode is used as it is.
 */
function header(request: IncomingMessage, name: string): string {
  const value = rawHeader(request, name);
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The longest a timer can wait. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** `next`, or a 408 once `idleMs` pass without it. */
function withinIdle<T>(next: Promise<T>, idleMs: number): Promise<T> {
  // Once the upload is refused, the read it waited on ends with the connection: nobody awaits it.
  next.catch(() => undefined);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    const after = idleMs >= 1_000 ? `${Math.round(idleMs / 1_000)} s` : `${idleMs} ms`;
    timer = setTimeout(() => {
      // After the thread was held longer than `idleMs`, timers run before the data that came in the
      // meantime is read: it is read first, in this turn of the loop, and the upload goes on.
      setImmediate(() => {
        if (!settled) reject(new HttpError(408, `The upload stopped arriving: nothing came for ${after}. Send it again.`, true));
      });
    }, idleMs);
  });
  return Promise.race([next.finally(() => (settled = true)), idle]).finally(() => clearTimeout(timer));
}

/**
 * Reads the raw body, or uses one a framework already parsed into a Buffer (e.g. express.raw()).
 * `idleMs`: the longest wait for the next piece of the body (0 for no limit).
 */
async function readBody(request: IncomingMessage, limit: number, idleMs = 0): Promise<Uint8Array> {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed instanceof Uint8Array) {
    if (parsed.byteLength > limit) throw new HttpError(413, "");
    return parsed;
  }
  if (parsed !== undefined && typeof parsed === "object" && parsed !== null && Object.keys(parsed).length) {
    throw new HttpError(400, "The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream.");
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "");
  const chunks: Buffer[] = [];
  let size = 0;
  // Leaving the loop early must not destroy the request: the rest of the body is drained after
  // the answer (see `drain`), which a destroyed request would not do.
  const pieces = request.iterator({ destroyOnReturn: false });
  const timed = idleMs > 0 && idleMs <= LONGEST_TIMER_MS;
  try {
    for (;;) {
      const next = pieces.next();
      const { done, value: chunk } = timed ? await withinIdle(next, idleMs) : await next;
      if (done) break;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.byteLength;
      if (size > limit) throw new HttpError(413, "");
      chunks.push(buffer);
    }
  } finally {
    // As a `for await` does on leaving early; the request is not destroyed (see above).
    void pieces.return?.().catch(() => undefined);
  }
  const body = Buffer.concat(chunks);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

const BUSY = "The server is receiving other files right now. Try again in a moment.";
/** When a client refused for `maxPendingUploadBytes` is told to try again. */
const BUSY_RETRY_MS = 5_000;

/** `uploadIdleTimeoutMs`, checked: a number of 0 or more (0 and Infinity for no limit). */
function idleLimit(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new RangeError(`uploadIdleTimeoutMs must be a number of 0 or more, and is ${typeof value === "number" ? value : typeof value}. Leave it out for the default.`);
  }
  return value;
}

/** `maxPendingUploadBytes`, checked: a number above 0 (Infinity for no limit). */
function pendingLimit(value: unknown, maxUploadBytes: number): number {
  if (value === undefined) return 2 * maxUploadBytes;
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new RangeError(`maxPendingUploadBytes must be a number above 0, and is ${typeof value === "number" ? value : typeof value}. Leave it out for the default.`);
  }
  return value;
}

/**
 * The bytes an upload will hold: a body a framework already read, its declared `Content-Length`,
 * or the upload limit when it declares none. Never more than the limit: a larger one is refused
 * when it is read (413).
 */
function expectedSize(request: IncomingMessage, limit: number): number {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed instanceof Uint8Array) return Math.min(parsed.byteLength, limit);
  const declared = Number(request.headers["content-length"]);
  return Number.isFinite(declared) && declared >= 0 ? Math.min(declared, limit) : limit;
}

/**
 * The most bytes of an upload's body that are read and dropped after it was answered before the
 * body was read to its end (too large, no name). Past it the connection is closed.
 */
const DRAIN_BYTES = 8 * 1024 * 1024;

/**
 * Reads and drops the rest of a body that was answered before it was read to its end, up to
 * `DRAIN_BYTES`, then ends the answer, which was written but not ended. The client, still
 * sending, reads the answer and can use the connection again. Two things Node does shape this:
 * it stops reading a request once its answer has ended, and its client stops sending once it has
 * a whole answer (so the answer has no Content-Length, and ends only after the drain). Closing the
 * connection at once instead makes some systems (Windows) reset it, and the client then never
 * reads the answer. A body larger than `DRAIN_BYTES` is cut off: the answer ends, and the
 * connection is closed.
 */
function drain(request: IncomingMessage, response: ServerResponse): void {
  let drained = 0;
  const end = () => {
    request.off("data", count);
    if (!response.writableEnded) response.end();
  };
  const count = (chunk: Buffer | string) => {
    drained += chunk.length;
    if (drained <= DRAIN_BYTES) return;
    end();
    if (response.writableFinished) request.destroy();
    else response.once("finish", () => request.destroy());
  };
  request.on("data", count);
  request.once("end", end);
  request.once("close", end);
  request.on("error", () => {});
  request.resume();
}

/**
 * Upload, get, and delete handlers for any Node HTTP server (node:http, Express, Fastify via
 * `request.raw`/`reply.raw`, Next.js API routes on the Node runtime). Responses are JSON, except an upload that asks for
 * `text/event-stream`: it is answered with its ingest events.
 */
export function createDocumentHandlers(files: LargeFiles, options: DocumentHandlerOptions = {}): DocumentHandlers {
  const tooLarge = `The file is larger than the ${formatBytes(files.maxUploadBytes)} upload limit.`;
  // The upload limit bounds each body, and the room for all of them: a LargeFiles of your own
  // without it (from JavaScript) had neither.
  if (typeof files.maxUploadBytes !== "number" || !(files.maxUploadBytes > 0)) {
    throw new TypeError(`createDocumentHandlers needs files.maxUploadBytes, a number above 0, and it is ${String(files.maxUploadBytes)}. A LargeFiles of your own must keep the one of the library it wraps.`);
  }
  for (const name of ["getScope", "onUploaded", "onRemoved"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "function") throw new TypeError(`${name} must be a function, and is ${typeof options[name]}.`);
  }
  // A library that requires an owner or a scope on every call cannot be served without them: every
  // request would fail, after its body was read.
  const requireOwner = files.access?.requireOwner === true;
  const requireScope = files.access?.requireScope === true;
  if (requireOwner && typeof options.getOwner !== "function") {
    throw new TypeError("createDocumentHandlers needs getOwner: the library requires an owner on every call (requireOwner).");
  }
  if (requireScope && typeof options.getScope !== "function") {
    throw new TypeError("createDocumentHandlers needs getScope: the library requires a scope on every call (requireScope).");
  }
  const maxPending = pendingLimit(options.maxPendingUploadBytes, files.maxUploadBytes);
  const idleMs = idleLimit(options.uploadIdleTimeoutMs);
  /** Whether uploads are counted at all (`maxPendingUploadBytes` is not Infinity). */
  const counted = maxPending !== Number.POSITIVE_INFINITY;
  /** The bytes of the uploads held now, from the reading of their body to the end of their ingest. */
  let pending = 0;

  /**
   * Who is asking: the owner and the scope of the request, checked, before its body is read. Under
   * `requireOwner`, a request without an owner is answered 401. A scope that is not valid, or none
   * under `requireScope`, is the server's mistake: a 500 that says which, and nothing else.
   * `failed` says what failed ("Upload failed").
   */
  async function callerOf(request: IncomingMessage, failed: string, checkOwnerShape: boolean): Promise<Caller> {
    const owner = await options.getOwner?.(request);
    // An owner that `ingest` would refuse ("", or an object such as `req.user` from JavaScript) is
    // the server's mistake, answered with a 500 before the body is read. Its message says which, so
    // that the operator knows where to look; it says nothing else. (`get` and `remove` pass it on,
    // as before, so that documents of 0.5.0 with the owner "" stay readable.)
    if (checkOwnerShape) {
      try {
        checkOwner(owner);
      } catch {
        const empty = typeof owner === "string" || owner === null;
        throw new HttpError(500, empty ? `${failed} (empty owner).` : `${failed} (owner is not a string).`);
      }
    }
    if (requireOwner && (owner === undefined || owner === null)) throw new HttpError(401, "Sign in first.");
    const given = options.getScope ? await options.getScope(request) : undefined;
    let scope: DocumentScope | undefined;
    try {
      // Null is no scope, as for the library.
      scope = checkScope(given ?? undefined);
    } catch {
      throw new HttpError(500, `${failed} (invalid scope).`);
    }
    if (requireScope && scope === undefined) throw new HttpError(500, `${failed} (no scope).`);
    return { ...(owner !== undefined ? { owner } : {}), ...(scope !== undefined ? { scope } : {}) };
  }

  /**
   * Runs `onUploaded` for a stored document. When it throws, or its `answer` is not a plain object
   * that JSON can hold, the document is deleted (a failure to delete is not told: the upload has
   * failed either way) and the error is what the upload answers.
   */
  async function uploaded(meta: DocumentMeta, request: IncomingMessage, caller: Caller, clientGone: boolean): Promise<Hooked> {
    if (!options.onUploaded) return {};
    try {
      const returned: unknown = await options.onUploaded(meta, { request, ...caller, clientGone });
      return hookAnswerOf(returned);
    } catch (error) {
      // A delete of your own that throws at once is told no more than one that rejects.
      await Promise.resolve().then(() => files.delete(meta.id, caller)).catch(() => undefined);
      return { failure: error };
    }
  }

  return {
    async upload(request, response) {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const name = header(request, "x-file-name").trim() || url.searchParams.get("name")?.trim() || "";
        if (!name) throw new HttpError(400, "Name the file with an X-File-Name header or a ?name= query parameter.");
        // Who is asking comes first: a refused upload is not read into memory.
        const caller = await callerOf(request, "Upload failed", true);
        // Too large is said first, before any wait for room.
        const declared = Number(request.headers["content-length"]);
        const parsed = (request as IncomingMessage & { body?: unknown }).body;
        if ((Number.isFinite(declared) && declared > files.maxUploadBytes) || (parsed instanceof Uint8Array && parsed.byteLength > files.maxUploadBytes)) {
          throw new HttpError(413, "");
        }
        // Room for the upload, before its body is read: a refused upload is not buffered. Never
        // more than the room itself, so that the count stays a number with an upload limit of Infinity.
        let held = counted ? Math.min(expectedSize(request, files.maxUploadBytes), maxPending) : 0;
        if (pending > 0 && pending + held > maxPending) throw new IngestError("busy", BUSY, { retryAfterMs: BUSY_RETRY_MS });
        pending += held;
        try {
          const bytes = await readBody(request, files.maxUploadBytes, idleMs);
          // Counted at its size once read (an upload without a Content-Length was counted at the limit).
          if (counted) {
            pending += bytes.byteLength - held;
            held = bytes.byteLength;
          }
          // Content-Type is a header of HTTP, not one the page encodes: it is taken as it came (S11).
          // `ingest` cleans what it keeps of either.
          const contentType = rawHeader(request, "content-type");
          const mimeType = header(request, "x-file-type") || (contentType && !contentType.startsWith("application/octet-stream") ? contentType : "");
          // A client that goes away before the answer stops the reading of its file: nobody would
          // get the document, and the server has other work.
          const gone = new AbortController();
          const onClose = () => {
            if (!response.writableFinished) gone.abort(new Error("The upload was cancelled: the client closed the connection."));
          };
          response.once("close", onClose);
          const input: IngestInput = {
            name,
            bytes,
            ...(mimeType ? { mimeType } : {}),
            ...caller,
            signal: gone.signal,
          };
          const hook = (meta: DocumentMeta) => uploaded(meta, request, caller, gone.signal.aborted);
          try {
            if (wantsEvents(request)) {
              // `onUploaded` runs once, for the event before ingest.finish or after the stream.
              let hooking: Promise<Hooked> | undefined;
              return await streamIngest(files, input, response, tooLarge, (meta) => (hooking ??= hook(meta)));
            }
            const meta = await files.ingest(input);
            const hooked = await hook(meta);
            if ("failure" in hooked) throw hooked.failure;
            // The summary's own fields win over the hook's.
            send(response, 201, { ...hooked.answer, ...toDocumentSummary(meta) });
          } finally {
            response.off("close", onClose);
          }
        } finally {
          pending -= held;
        }
      } catch (error) {
        // A body that stopped arriving is not drained: the answer ends, and so does the connection.
        if (error instanceof HttpError && error.close) {
          if (!response.headersSent) response.setHeader("Connection", "close");
          send(response, error.status, { error: error.message });
          if (response.writableFinished) request.destroy();
          else response.once("finish", () => request.destroy());
          return;
        }
        // Answered before the body was read to its end (too large, no name): the rest is drained.
        fail(response, error, "Upload failed", tooLarge, request);
        // An event stream that failed after its headers were sent cannot answer with a status. (An
        // answer to a body still being drained is ended by `drain`.)
        if (response.headersSent && !response.writableEnded && request.complete) response.end();
      }
    },

    async get(request, response, id) {
      try {
        const caller = await callerOf(request, "The file could not be looked up", false);
        const meta = await files.getMeta(id, caller);
        if (meta) send(response, 200, toDocumentSummary(meta));
        else send(response, 404, { error: "This file is no longer available." });
      } catch (error) {
        fail(response, error, "The file could not be looked up", tooLarge);
      }
    },

    async remove(request, response, id) {
      try {
        const caller = await callerOf(request, "The file could not be deleted", false);
        const deleted = await files.delete(id, caller);
        if (deleted && options.onRemoved) await options.onRemoved(id, { request, ...caller });
        send(response, 200, { deleted });
      } catch (error) {
        fail(response, error, "The file could not be deleted", tooLarge);
      }
    },
  };
}

/** The owner and the scope of a request, as `getOwner` and `getScope` gave them, checked. */
type Caller = AccessOptions;

/**
 * What `onUploaded` returned, as the fields to add to the answer: `{ answer }` with a plain object
 * that JSON can hold (a copy of it, as JSON reads it back). Anything else without an `answer` (a
 * database's own result) adds nothing. An `answer` of another kind is a TypeError.
 */
function hookAnswerOf(returned: unknown): { answer?: Record<string, unknown> } {
  if (typeof returned !== "object" || returned === null) return {};
  const answer: unknown = (returned as { answer?: unknown }).answer;
  if (answer === undefined || answer === null) return {};
  const proto: unknown = typeof answer === "object" ? Object.getPrototypeOf(answer) : undefined;
  if (typeof answer !== "object" || Array.isArray(answer) || (proto !== Object.prototype && proto !== null)) {
    throw new TypeError("onUploaded must return nothing, or { answer } with a plain object that JSON can hold.");
  }
  return { answer: JSON.parse(JSON.stringify(answer)) as Record<string, unknown> };
}
