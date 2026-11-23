import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { errorInfoOf, STORE_RETRY_AFTER_MS, UNREADABLE_MESSAGE } from "../error-info.js";
import { DocumentScopeError, DocumentStoreError, IngestError, isErrorCode, type IngestErrorCode } from "../errors.js";
import { eventStream, newRunId, type EventError, type IngestEvent } from "../events.js";
import { checkOwner, cleanFileName, toDocumentSummary, type AccessOptions, type IngestInput, type LargeFiles } from "../library.js";
import { DocumentsNotFoundError, errorKindOf, ModelRequestError, type ModelErrorKind } from "../model.js";
import { formatBytes } from "../plan.js";
import { checkScope } from "../scope.js";
import type { DocumentMeta, DocumentScope } from "../types.js";
import { BodyFile, checkRefFolders, HttpError, parsedBody, readBody, Room, spoolFileIn, writeBody, type Held } from "./spool.js";
import { writeSseEvents } from "./sse.js";

/** What `onUploaded` is told besides the document. New in 0.9.0. */
export type UploadedContext = {
  /**
   * The upload's request, for its headers and URL. Its body has been read: the bytes are not here,
   * unless a framework left them in `request.body` (`express.raw()`), which keeps them until the
   * request ends.
   */
  request: IncomingMessage;
  /** What `getOwner` returned, when it returned an owner. */
  owner?: string;
  /** What `getScope` returned, when it returned a scope (a frozen copy). */
  scope?: DocumentScope;
  /**
   * True when the client went away before the hook was called: the document is stored all the
   * same, and nobody gets the answer. Record it, or remove it, as your app needs. With the
   * library's own `ingest`, a client that leaves before the ingest ends leaves nothing stored, and
   * the hook is not called: this is for a client that left after the ingest ended, or for an
   * `ingest` of your own that does not stop on its `signal`.
   */
  clientGone: boolean;
  /**
   * The path the body was saved to: the `path` that `prepareUpload` returned. Only for such an
   * upload: the file is yours, and stays (unless this hook throws). A file of the spool
   * (`uploadSpool`) is gone by now, and is not told. New in 0.9.0.
   */
  path?: string;
};

/** What `prepareUpload` is told of an upload, before its body is read. New in 0.9.0. */
export type PrepareUploadInfo = {
  /**
   * The file's name, as the document will have it: the last part of the name sent, without
   * control characters (`cleanFileName`). It is the client's: never build a path from it.
   */
  name: string;
  /** What `getOwner` returned, when it returned an owner. */
  owner?: string;
  /** What `getScope` returned, when it returned a scope (a frozen copy). */
  scope?: DocumentScope;
};

/**
 * What `prepareUpload` may return for an upload: the document's ID, where to save its body, and
 * the ref of that file for `LargeFilesOptions.originals`. Each is optional. New in 0.9.0.
 */
export type PreparedUpload = {
  /**
   * The document's ID (`IngestInput.id`), such as the ID of the upload in your database. A
   * document of that ID that is already stored makes the upload fail with a 409 ("exists").
   */
  id?: string;
  /**
   * An absolute path where the body is saved as it arrives, then ingested from (`source`). The
   * file must not be there: it is made new (`"wx"`, mode `uploadFileMode`), and never written
   * through a file or a link already at that name (a 409). Its folder must exist: the handler makes
   * no folder. A link in a folder above it is followed, except below the root of a ref (see
   * `original`). The file is yours once the document is stored: the library never removes it, even
   * when the document is deleted or expires. When the upload fails, it is removed.
   */
  path?: string;
  /**
   * The ref of the saved file for `LargeFilesOptions.originals` (`IngestInput.original`), such as
   * its path under the folder of `fileOriginals`: the store then keeps no copy of it. Give it with
   * `path`: the handler does not make a ref of a path, nor check that the ref names that file.
   * When `path` ends with the ref (`<root>/<ref>`, as `fileOriginals(root)` reads it), a link in a
   * folder below that root, which `fileOriginals` would refuse to read through, fails the upload
   * before its body is read: a 500 "Upload failed (ELOOP).".
   */
  original?: { ref: string };
};

/** Where `uploadSpool` writes the bodies of uploads, and which ones. New in 0.9.0. */
export type UploadSpoolOptions = {
  /** The folder of the temporary files. It must exist. Defaults to `os.tmpdir()`. */
  directory?: string;
  /**
   * Bodies whose `Content-Length` is this many bytes or fewer are held in memory, as without a
   * spool; larger ones, and those without a `Content-Length`, are written to a temporary file.
   * Defaults to 1 MiB (1,048,576). 0 writes every body to a file.
   */
  minBytes?: number;
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
   * be made without it, and an undefined owner (or null, from JavaScript) is answered 401
   * `{"error":"Sign in first."}` before the body is read, on every route (new in 0.9.0). An empty
   * owner is then a 500 on every route too, without calling the library: `get` answers
   * `{"error":"The file could not be looked up (empty owner)."}`, and `remove`
   * `{"error":"The file could not be deleted (empty owner)."}`.
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
   * resolves, with no time limit: bound your own calls. The upload's room
   * (`maxPendingUploadBytes`) is given back, and the body the handler read is freed, before it is
   * called. It is called even when the client went away after the ingest ended (`clientGone`):
   * with the library's own `ingest`, a client that leaves before it ends leaves nothing stored,
   * and no call. Return `{ answer }` to add its fields to the answer: to the `201` JSON (the
   * summary's own fields win), or as `app` in `ingest.finish`. `answer` must be a plain object that
   * JSON can hold.
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
   * Called for each upload after `getOwner` and `getScope`, before its body is read: returns the
   * document's `id`, a `path` to save the body to, and the `original` ref of that file (see
   * `PreparedUpload`), or nothing. With a `path`, the body is written there as it arrives (under
   * the same limits: `maxUploadBytes`, `uploadIdleTimeoutMs`), then ingested from the file, which
   * stays once the document is stored and is removed when the upload fails, whatever the reason
   * (a process that is killed cannot remove it).
   * Such an upload is not held in memory, and takes no room of `maxPendingUploadBytes` or
   * `maxSpooledUploadBytes`. Throw an error with a status to refuse the upload, as for `getOwner`.
   * The upload can still fail after it (no room, too large…): choose here, record in `onUploaded`.
   * New in 0.9.0.
   */
  prepareUpload?: (request: IncomingMessage, info: PrepareUploadInfo) => PreparedUpload | void | Promise<PreparedUpload | void>;
  /**
   * Writes the bodies of uploads to temporary files, instead of holding them in memory while they
   * are ingested: those over `minBytes` (1 MiB), and those without a `Content-Length`. Each file is
   * made new in `directory` (`os.tmpdir()`), with a random name and mode 0o600, ingested from its
   * path, and removed once the ingest ends, whatever the end. `true` for the defaults. Defaults to
   * false. New in 0.9.0.
   */
  uploadSpool?: boolean | UploadSpoolOptions;
  /**
   * The most bytes of the spool's files (`uploadSpool`) at once. An upload that would pass it is
   * answered 503 with `Retry-After`, before its body is read, as for `maxPendingUploadBytes`. A
   * disk that is full is answered 503 with `Retry-After` too. `Infinity` for no limit. Defaults to
   * ten times `maxUploadBytes`. New in 0.9.0.
   */
  maxSpooledUploadBytes?: number;
  /**
   * The mode of the files saved to the `path` of `prepareUpload`, minus the umask of the process.
   * Defaults to 0o600: only the server's user reads them. 0o640 lets a group read them (pods of
   * another user that share the volume through a group). The spool's files are always 0o600. New
   * in 0.9.0.
   */
  uploadFileMode?: number;
  /**
   * The most bytes of uploads these handlers hold in memory at once: an upload is held whole in
   * memory from the moment its body is read until its ingest ends. An upload that would pass it is
   * answered 503 with `Retry-After` before its body is read, while another upload is held: one
   * upload alone is always taken. An upload counts its `Content-Length` (or `maxUploadBytes`
   * without one, then its size once read). Bodies written to a file (`prepareUpload`'s `path`,
   * `uploadSpool`) do not count, since 0.9.0. `Infinity` for no limit (as before 0.8.2). Defaults
   * to twice `maxUploadBytes`. New in 0.8.2.
   */
  maxPendingUploadBytes?: number;
  /**
   * An upload whose body stops arriving for this many milliseconds is answered 408, its connection
   * closed and its room given back: a client that sends its headers and then nothing, or stalls,
   * holds its room no longer. Since 0.9.0 it also bounds each call to the disk for a body written
   * to a file (the check of its folders for a link, its opening, each write, its closing): a volume
   * that stops answering fails the upload with a 500 "Upload failed (ETIMEDOUT).", and its room is
   * given back. The removal of the file is waited for no longer either: past it, the removal goes
   * on alone, and the upload is answered all the same. 0 or `Infinity` for no limit. Defaults to
   * 30,000. New in 0.8.2.
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
   * `uploadAnswerOf` says. The body is held in memory, or, with the `path` of `prepareUpload` or
   * with `uploadSpool`, written to a file as it arrives and ingested from its path (new in 0.9.0).
   *
   * When the request's `Accept` header names `text/event-stream` (not with `q=0`, nor only through a
   * wildcard), a file that passes the checks of the name, the owner, the scope and the size (which
   * still answer with an HTTP error) is answered with a 200 and Server-Sent Events: the ingest's
   * events (`ingest.start`, `ingest.progress`…), ending with `ingest.finish`, whose data is the
   * summary a 201 would hold (and `onUploaded`'s answer in `app`), or `ingest.error`, whose data is
   * `{ error: { message, status } }` with the message and status a JSON answer would have, the
   * `code` of a refused file, the `name` of a store that failed or of a scope error (with its
   * `code`), and the `kind` of a model's error, for `errorInfoOf`.
   */
  upload(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** GET: the document's summary, or 404. With `getScope`, only a document of the request's scope. */
  get(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
  /** DELETE: removes the document, then calls `onRemoved`. Responds `{ deleted: boolean }`. */
  remove(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
};

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
 * names server paths or hosts, so only the code is passed on, and only when it reads as one: a
 * driver may put a host in `code`.
 */
function systemErrorCode(error: unknown): string | undefined {
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
  return isErrorCode(code) && typeof syscall === "string" ? code : undefined;
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
        // An unreadable file has the words of a parser, or of an extractor of your own, which may
        // name a host: not words for a user (as for errorInfoOf).
        error: error.code === "unreadable" ? UNREADABLE_MESSAGE : typeof error.message === "string" && error.message ? error.message : plain.error,
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
 *   with its `retryAfterMs`), its message and its `code`. Only an `IngestError` is a 422. An
 *   "unreadable" file is told in fixed words, as `errorInfoOf` tells it: its own message is a
 *   parser's, or that of an extractor of your own;
 * - a `DocumentStoreError`: 503, its message (which names no path or host), and 5 s to wait;
 * - a `DocumentScopeError` "scope_missing": 404 "This chat no longer exists."; the other codes
 *   are the server's mistake: 500 "Upload failed.";
 * - a model's error (`ModelRequestError`): the status and words of `errorInfoOf`, never the
 *   provider's own;
 * - any other error with a `status` (or `statusCode`) from 400 to 599: that status and its message;
 * - a Node system error (a `code` and a `syscall`): 500 "Upload failed (ENOSPC).", or "Upload
 *   failed." when its code does not read as one (capitals, digits and "_"), as a host does;
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

/** Starts the ingest of an upload, with the fields of an event stream (`upload`). */
type StartIngest = (more?: Pick<IngestInput, "runId" | "onEvent" | "signal">) => Promise<DocumentMeta>;

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
 * (with its code, which tells a deleted chat apart), and the kind of a model's error (an ingest or
 * a hook of yours that asks one), as `answerFor` answers it, for `EventError`. Nothing for other
 * errors: a refused file is told by its `code`.
 */
function identityOf(error: unknown): Pick<EventError, "name" | "code" | "kind"> {
  try {
    if (DocumentStoreError.is(error)) return { name: "DocumentStoreError" };
    if (DocumentsNotFoundError.is(error)) return { name: "DocumentsNotFoundError" };
    if (DocumentScopeError.is(error)) return { name: "DocumentScopeError", ...(typeof error.code === "string" ? { code: error.code } : {}) };
    // A model's EventError always has its kind, as in the events of a question.
    if (ModelRequestError.is(error) || errorKindOf(error) !== undefined) {
      const info = errorInfoOf(error);
      if (info.category === "model") return { kind: info.code as ModelErrorKind };
    }
  } catch {
    // A proxy whose traps throw: told plainly.
  }
  return {};
}

/**
 * Ingests the upload and answers with its events as Server-Sent Events. The last one is always
 * `ingest.finish` or `ingest.error`, even with a `LargeFiles` of your own whose `ingest` sends no
 * events. `uploaded` runs `onUploaded` once, before `ingest.finish` is sent; or after the stream, for
 * a document stored once the client went away. `start` starts the ingest (see `upload`); `release`
 * is called once the ingest ended, before `onUploaded`.
 */
async function streamIngest(
  start: StartIngest,
  signal: AbortSignal,
  response: ServerResponse,
  tooLarge: string,
  uploaded: (meta: DocumentMeta) => Promise<Hooked>,
  release: () => void,
): Promise<void> {
  const runId = newRunId("ing");
  const stream = eventStream<IngestEvent, DocumentMeta>(
    (onEvent, stop) => start({ runId, onEvent, signal: stop }),
    { signal },
  );
  // The ingest ended: its room is given back, while `onUploaded` may still run.
  stream.result.then(release, release);
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
  // same (the ingest had ended, or an ingest of your own did not stop) still goes to `onUploaded`
  // (with `clientGone`), once.
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

/** `uploadIdleTimeoutMs`, checked: a number of 0 or more (0 and Infinity for no limit). */
function idleLimit(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new RangeError(`uploadIdleTimeoutMs must be a number of 0 or more, and is ${typeof value === "number" ? value : typeof value}. Leave it out for the default.`);
  }
  return value;
}

/** `maxPendingUploadBytes` or `maxSpooledUploadBytes` (`name`), checked: a number above 0 (Infinity for no limit). */
function roomLimit(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new RangeError(`${name} must be a number above 0, and is ${typeof value === "number" ? value : typeof value}. Leave it out for the default.`);
  }
  return value;
}

/** Where the spool writes bodies, and from which size (`uploadSpool`, checked). */
type Spool = { directory: string; minBytes: number };

/** `uploadSpool`, checked: undefined for no spool. */
function spoolOf(value: unknown): Spool | undefined {
  if (value === undefined || value === false) return undefined;
  const given: unknown = value === true ? {} : value;
  if (typeof given !== "object" || given === null) throw new TypeError("uploadSpool must be true, false, or { directory?, minBytes? }.");
  const { directory, minBytes } = given as { directory?: unknown; minBytes?: unknown };
  if (directory !== undefined && (typeof directory !== "string" || directory.length === 0 || directory.includes("\0"))) {
    throw new TypeError("uploadSpool.directory must be the path of a folder: a string that is not empty.");
  }
  if (minBytes !== undefined && (typeof minBytes !== "number" || Number.isNaN(minBytes) || minBytes < 0)) {
    throw new RangeError(`uploadSpool.minBytes must be a number of 0 or more, and is ${typeof minBytes === "number" ? minBytes : typeof minBytes}. Leave it out for the default.`);
  }
  return { directory: path.resolve(directory ?? tmpdir()), minBytes: minBytes ?? 1024 * 1024 };
}

/** `uploadFileMode`, checked: a file mode from 0 to 0o777. */
function fileModeOf(value: unknown): number {
  if (value === undefined) return 0o600;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new TypeError("uploadFileMode must be a file mode from 0 to 0o777, such as 0o640.");
  }
  return value;
}

const PREPARED_SHAPE = "prepareUpload must return nothing, or { id?, path?, original? }: id a string, path an absolute path, original { ref } with a path.";

/**
 * What `prepareUpload` returned, checked (a copy). Null fields are left out, as a database gives
 * them. Anything else is a TypeError, the server's mistake: a 500 "Upload failed.". The rules of
 * `id` and `original.ref` are the library's, checked by `ingest`.
 */
function preparedOf(value: unknown): PreparedUpload {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError(PREPARED_SHAPE);
  const { id, path: at, original } = value as { id?: unknown; path?: unknown; original?: unknown };
  const prepared: PreparedUpload = {};
  if (id !== undefined && id !== null) {
    if (typeof id !== "string") throw new TypeError(PREPARED_SHAPE);
    prepared.id = id;
  }
  if (at !== undefined && at !== null) {
    if (typeof at !== "string" || at.includes("\0") || !path.isAbsolute(at)) throw new TypeError(PREPARED_SHAPE);
    prepared.path = at;
  }
  if (original !== undefined && original !== null) {
    const ref: unknown = typeof original === "object" ? (original as { ref?: unknown }).ref : undefined;
    // A ref names the file the body is saved to: without a path, it would name a file the handler never wrote.
    if (typeof ref !== "string" || prepared.path === undefined) throw new TypeError(PREPARED_SHAPE);
    prepared.original = { ref };
  }
  return prepared;
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
  for (const name of ["getScope", "prepareUpload", "onUploaded", "onRemoved"] as const) {
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
  const idleMs = idleLimit(options.uploadIdleTimeoutMs);
  /** The bodies held in memory, from the reading of each to the end of its ingest (`maxPendingUploadBytes`). */
  const memoryRoom = new Room(roomLimit("maxPendingUploadBytes", options.maxPendingUploadBytes, 2 * files.maxUploadBytes));
  const spool = spoolOf(options.uploadSpool);
  /** The files of the spool, from the writing of each to its removal (`maxSpooledUploadBytes`). */
  const spoolRoom = new Room(roomLimit("maxSpooledUploadBytes", options.maxSpooledUploadBytes, 10 * files.maxUploadBytes));
  const fileMode = fileModeOf(options.uploadFileMode);

  /**
   * Whether the body of an upload goes to a file of the spool: with `uploadSpool`, one over
   * `minBytes`, or that does not say its size. Not a body a framework already read into memory.
   */
  function spools(declared: number, parsed: Uint8Array | undefined): boolean {
    if (spool === undefined || parsed !== undefined) return false;
    return !(Number.isFinite(declared) && declared >= 0 && declared <= spool.minBytes);
  }

  /**
   * Who is asking: the owner and the scope of the request, checked, before its body is read. Under
   * `requireOwner`, a request without an owner is answered 401. An owner the library refuses (on
   * the upload, or on every route under `requireOwner`), a scope that is not valid, or none under
   * `requireScope`, is the server's mistake: a 500 that says which, and nothing else. `failed` says
   * what failed ("Upload failed").
   */
  async function callerOf(request: IncomingMessage, failed: string, checkOwnerShape: boolean): Promise<Caller> {
    const owner = await options.getOwner?.(request);
    // No owner, or null (`req.user?.id ?? null` from JavaScript), is a request that is not signed in.
    if (requireOwner && (owner === undefined || owner === null)) throw new HttpError(401, "Sign in first.");
    // An owner that `ingest` would refuse ("", or an object such as `req.user` from JavaScript) is
    // the server's mistake, answered with a 500 before the body is read. Its message says which, so
    // that the operator knows where to look; it says nothing else. (Without `requireOwner`, `get`
    // and `remove` pass it on, as before, so that documents of 0.5.0 with the owner "" stay
    // readable. Under it, the library refuses such an owner on every call: so do they, in the same
    // words as the upload.)
    if (checkOwnerShape || requireOwner) {
      try {
        checkOwner(owner);
      } catch {
        const empty = typeof owner === "string" || owner === null;
        throw new HttpError(500, empty ? `${failed} (empty owner).` : `${failed} (owner is not a string).`);
      }
    }
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
  async function uploaded(meta: DocumentMeta, request: IncomingMessage, caller: Caller, clientGone: boolean, saved: string | undefined): Promise<Hooked> {
    if (!options.onUploaded) return {};
    try {
      const returned: unknown = await options.onUploaded(meta, { request, ...caller, clientGone, ...(saved !== undefined ? { path: saved } : {}) });
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
        const parsed = parsedBody(request);
        if ((Number.isFinite(declared) && declared > files.maxUploadBytes) || (parsed !== undefined && parsed.byteLength > files.maxUploadBytes)) {
          throw new HttpError(413, "");
        }
        const prepared = options.prepareUpload ? preparedOf(await options.prepareUpload(request, { name: cleanFileName(name), ...caller })) : {};
        // A file `fileOriginals` would not read back by its ref is refused before anything is written.
        if (prepared.path !== undefined && prepared.original !== undefined) await checkRefFolders(prepared.path, prepared.original.ref, idleMs);
        // Where the body is while it is ingested: in the application's file (`prepareUpload`), in a
        // file of the spool, or in memory. Room is taken for it before it is read, so that a refused
        // upload is not read: in the spool, or in memory. The application's file takes none: it is
        // on the application's disk, and stays.
        const spooled = prepared.path === undefined && spools(declared, parsed);
        const held: Held | undefined = prepared.path !== undefined ? undefined : (spooled ? spoolRoom : memoryRoom).take(expectedSize(request, files.maxUploadBytes));
        /** Gives the upload's room back, once: when its ingest ended, so that an `onUploaded` that waits on a database of yours does not hold it, or when the upload failed. */
        const release = () => held?.release();
        let file: BodyFile | undefined;
        try {
          let body: Uint8Array | undefined;
          if (prepared.path !== undefined || spooled) {
            const at = prepared.path ?? spoolFileIn(spool!.directory);
            const size = await writeBody(request, at, { limit: files.maxUploadBytes, idleMs, mode: prepared.path !== undefined ? fileMode : 0o600 });
            file = new BodyFile(at, prepared.path !== undefined, idleMs);
            held?.resize(size);
          } else {
            body = await readBody(request, files.maxUploadBytes, idleMs);
            // Counted at its size once read (an upload without a Content-Length was counted at the limit).
            held?.resize(body.byteLength);
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
          // One that left already is told no more: while the last piece of its body was written,
          // or its file closed (where a network volume writes what it held back), or before a body
          // a framework read was taken.
          if (response.destroyed || request.socket?.destroyed) onClose();
          const chosen = { ...(prepared.id !== undefined ? { id: prepared.id } : {}), ...(prepared.original !== undefined ? { original: prepared.original } : {}) };
          /**
           * Starts the upload's ingest, once. A body in memory is then the ingest's alone: it is
           * freed when the ingest ends, while `onUploaded` may still run. The input is built in
           * this function, whose frame ends at once: a value in the frame of `upload`, an async
           * function, is kept until it returns, the hook's wait included. A body in a file is
           * ingested from its path: the file of the spool is removed when the ingest ends, and the
           * application's file when the ingest fails.
           */
          const start: StartIngest = (more) => {
            const input = { name, ...(mimeType ? { mimeType } : {}), ...chosen, ...caller, signal: gone.signal, ...more };
            if (file) return file.settle(files.ingest({ ...input, source: { path: file.path } }));
            const bytes = body!;
            body = undefined;
            return files.ingest({ ...input, bytes });
          };
          // The path is told only for the application's own file: the spool's is gone by then.
          const saved = file?.kept ? file.path : undefined;
          const hook = async (meta: DocumentMeta): Promise<Hooked> => {
            const hooked = await uploaded(meta, request, caller, gone.signal.aborted, saved);
            // The document is deleted: the file saved for it goes too.
            if ("failure" in hooked) await file?.remove();
            return hooked;
          };
          try {
            if (wantsEvents(request)) {
              // `onUploaded` runs once, for the event before ingest.finish or after the stream.
              let hooking: Promise<Hooked> | undefined;
              return await streamIngest(start, gone.signal, response, tooLarge, (meta) => (hooking ??= hook(meta)), release);
            }
            const meta = await start();
            release();
            const hooked = await hook(meta);
            if ("failure" in hooked) throw hooked.failure;
            // The summary's own fields win over the hook's.
            send(response, 201, { ...hooked.answer, ...toDocumentSummary(meta) });
          } finally {
            response.off("close", onClose);
          }
        } finally {
          release();
          // Whatever happened: the spool's file is gone, and so is the application's unless its document is stored.
          await file?.end();
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
