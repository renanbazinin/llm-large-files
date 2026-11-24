// What an error means for an application: one record to choose a status, a retry and words of
// your own by, in any language. New in 0.9.0.
import { DocumentScopeError, DocumentStoreError, IngestError, isErrorCode, type DocumentScopeErrorCode, type IngestErrorCode } from "./errors.js";
import { eventErrorOf, isPlainData } from "./events.js";
import { modelFailureReason } from "./map-reduce.js";
import { classifyModelError, DocumentsNotFoundError, isModelStatus, ModelRequestError, type ModelErrorKind } from "./model.js";

/**
 * What kind of failure an error is (`ErrorInfo.category`):
 * - "ingest": a file `ingest` refused (`IngestError`): `code` says why;
 * - "store": the document store failed just now (`DocumentStoreError`);
 * - "missing": documents that are gone (`DocumentsNotFoundError`), or the chat of a scope that is
 *   gone (`DocumentScopeError` "scope_missing");
 * - "model": a model request failed (`ModelRequestError`): `code` is its kind;
 * - "aborted": stopped by a signal (an `AbortError`, or a `TimeoutError` of `AbortSignal.timeout`);
 * - "input": a mistake in the call (a `TypeError` or `RangeError`, or a `DocumentScopeError`
 *   "scope_invalid" or "scope_required", and the `EventError` of each): a bug of the server, not
 *   of the user;
 * - "unknown": anything else.
 *
 * A switch over every category must handle the categories added in a later version.
 */
export type ErrorCategory = "ingest" | "store" | "missing" | "model" | "aborted" | "input" | "unknown";

/** What `errorInfoOf` tells of an error. New in 0.9.0. */
export type ErrorInfo = {
  category: ErrorCategory;
  /**
   * More precise than the category, when there is more to say: the `IngestErrorCode` ("too_large",
   * "busy"…), the `ModelErrorKind` ("rate_limit"…), "documents_missing", the `DocumentScopeError`
   * code, "aborted" or "timeout", or the code of the system error behind it ("EIO").
   */
  code?: string;
  /** The HTTP status to answer with: 400 to 599. */
  status: number;
  /** Whether the same call may work when it is made again, later. */
  retryable: boolean;
  /** How long to wait before trying again, in milliseconds, when that is known. */
  retryAfterMs?: number;
  /**
   * Words a user may see, in English. Never a path, a host, a stack or the provider's own words:
   * those stay on the error, for your log. Show your own words for the category and code instead,
   * in your users' language.
   */
  message: string;
};

/** How long to wait after a store failed, before the same call is made again. */
export const STORE_RETRY_AFTER_MS = 5_000;
/** How long to wait after a disk was full (`ENOSPC`, `EDQUOT`), before the same call is made again. New in 0.10.0. */
export const NO_ROOM_RETRY_AFTER_MS = 30_000;

/**
 * The codes of system errors that say the server, or a service it needs, could not answer just
 * now: a time limit, a connection that was refused or cut, a name that could not be looked up, too
 * many files open, a busy file or a stale handle on a network volume. The same call may work a
 * moment later. New in 0.10.0: before, they were "unknown", 500, and not retryable.
 */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ESTALE", "EHOSTUNREACH", "ENETUNREACH",
]);
/** The codes of a disk that is full: retryable too, later. New in 0.10.0. */
export const NO_ROOM_CODES: ReadonlySet<string> = new Set(["ENOSPC", "EDQUOT"]);

/** How long to wait before the same call is made again after a system error of `code`, or undefined when it is not one to retry. New in 0.10.0. */
export function retryAfterOfCode(code: unknown): number | undefined {
  if (typeof code !== "string") return undefined;
  if (TRANSIENT_CODES.has(code)) return STORE_RETRY_AFTER_MS;
  if (NO_ROOM_CODES.has(code)) return NO_ROOM_RETRY_AFTER_MS;
  return undefined;
}

const SOMETHING_WENT_WRONG = "Something went wrong.";
/**
 * What a user is told of an "unreadable" file, whose message is a parser's or an extractor's of
 * your own (which may name a host): by `errorInfoOf`, and by the upload handlers.
 */
export const UNREADABLE_MESSAGE = "This file could not be read. It may be damaged, or not of the type its name says.";
const CHAT_GONE = "This chat no longer exists.";

/** The HTTP status of a model error, by its kind: the answer of a server that asked a model for its user. */
const MODEL_STATUS: Record<ModelErrorKind, number> = {
  context_overflow: 413,
  rate_limit: 429,
  quota: 503,
  timeout: 504,
  unreachable: 502,
  server: 502,
  auth: 500,
  invalid: 500,
};
const RETRYABLE_KINDS = new Set<ModelErrorKind>(["rate_limit", "timeout", "unreachable", "server"]);

/** Every `DocumentScopeErrorCode`, to read the `code` of an `EventError`. */
const SCOPE_CODES: Record<DocumentScopeErrorCode, true> = { scope_required: true, scope_invalid: true, scope_missing: true };
/** Statuses of plain data that say "try again later": too many requests, and a server that could not answer. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Every `IngestErrorCode`, to read the `code` of an `EventError`. */
const INGEST_CODES: Record<IngestErrorCode, true> = {
  empty: true, too_large: true, too_much_text: true, too_many_pages: true, not_text: true, compressed: true, legacy_office: true,
  encrypted: true, no_text: true, hostile: true, timeout: true, out_of_memory: true, busy: true, missing_dependency: true, unreadable: true, exists: true,
};

const isKind = (value: unknown): value is ModelErrorKind => typeof value === "string" && Object.hasOwn(MODEL_STATUS, value);
const isStatus = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
const isWait = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The code of a Node system error (one with a `code` and a `syscall`), whose message names paths or hosts. */
function systemCode(error: object): string | undefined {
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return typeof syscall === "string" && isErrorCode(code) ? code : undefined;
}

/**
 * The kind of a model error: its own, or the one its status (0, or 400 to 599), message and code
 * give (an error of an adapter of your own), as its `EventError` and its message have it.
 */
function modelKindOf(error: object): ModelErrorKind | undefined {
  const { kind, status, message, code } = error as { kind?: unknown; status?: unknown; message?: unknown; code?: unknown };
  if (isKind(kind)) return kind;
  if (ModelRequestError.is(error) || isModelStatus(status)) {
    return classifyModelError(typeof status === "number" ? status : 0, typeof message === "string" ? message : "", { code: typeof code === "string" ? code : undefined }).kind;
  }
  return undefined;
}

/**
 * The code in the library's own words for a system error, as an `EventError` holds them: "The
 * file could not be read from storage (ELOOP)." of `ingest.error` and `run.error`, "Upload failed
 * (ENOSPC)." of the upload handlers' `ingest.error`. The error itself has the code: its event, only
 * these words.
 */
function codeInWords(message: unknown): string | undefined {
  const code = typeof message === "string" ? /^(?:The file could not be read from storage|Upload failed) \(([A-Z][A-Z0-9_]{0,31})\)\.$/.exec(message)?.[1] : undefined;
  return isErrorCode(code) ? code : undefined;
}

/**
 * Whether `message` is the library's own words for a model's error of `kind`, with any status:
 * "The model was busy (HTTP 429).". An `EventError` holds them, and the upload handlers' names the
 * provider's status in them and the answer's in `status` ("The model failed on its side (HTTP
 * 503).", 502): they are kept. Any other words, a provider's, are not.
 */
function isModelWords(kind: ModelErrorKind, message: unknown): message is string {
  if (typeof message !== "string") return false;
  const status = /\(HTTP (\d{1,3})\)\.$/.exec(message)?.[1];
  return message === modelFailureReason({ kind, ...(status !== undefined ? { status: Number(status) } : {}) });
}

/** A refused file, from an `IngestError` or the `EventError` of one. */
function ingestInfo(code: string, status: unknown, retryAfterMs: unknown, message: unknown): ErrorInfo {
  return {
    category: "ingest",
    code,
    status: isStatus(status) ? status : 422,
    retryable: code === "busy",
    ...(code === "busy" && isWait(retryAfterMs) ? { retryAfterMs } : {}),
    // An unreadable file has the parser's message, or that of an extractor of your own: not words for a user.
    message: code === "unreadable" || typeof message !== "string" || !message ? UNREADABLE_MESSAGE : message,
  };
}

const storeInfo = (code: unknown, message: string): ErrorInfo => ({
  category: "store",
  // As the store's message does, a code is given only when it reads as one.
  ...(isErrorCode(code) ? { code } : {}),
  status: 503,
  retryable: true,
  retryAfterMs: STORE_RETRY_AFTER_MS,
  message,
});

/**
 * A scope that cannot be used: a chat that is gone, or a scope the server should have given, or
 * given right (its bug, not the user's). Its own words are not used: a store of your own wrote them.
 */
function scopeInfo(code: unknown): ErrorInfo {
  if (code === "scope_missing") return { category: "missing", code: "scope_missing", status: 404, retryable: false, message: CHAT_GONE };
  const known = typeof code === "string" && Object.hasOwn(SCOPE_CODES, code);
  return { category: "input", ...(known ? { code } : {}), status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
}

/**
 * An `EventError`: the plain data of `run.error`, `request.end`, `retry` and `ingest.error`, which
 * the library made from an error with words safe to show. It is read by its `name` and `code`;
 * a model error by its `kind`, below, as any error with one. Undefined for other data.
 */
function eventInfoOf(record: { name?: unknown; code?: unknown; kind?: unknown; status?: unknown; message?: unknown }): ErrorInfo | undefined {
  const { name, code, kind, status, message } = record;
  if (typeof message !== "string" || kind !== undefined) return undefined;
  // `ingest.error` of the upload handler has no name for a refused file.
  if (typeof code === "string" && Object.hasOwn(INGEST_CODES, code) && (name === undefined || name === "IngestError")) return ingestInfo(code, status, undefined, message);
  if (name === "DocumentStoreError") return storeInfo(undefined, message || "The document store could not be used. Try again.");
  if (name === "DocumentsNotFoundError") return { category: "missing", code: "documents_missing", status: 404, retryable: false, message: message || "A document is no longer available. Upload it again." };
  if (name === "DocumentScopeError") return scopeInfo(code);
  // A mistake in the call, as the error itself is read (`ingest.error` of a TypeError of ingest).
  if (name === "TypeError" || name === "RangeError") return inputInfo();
  return undefined;
}

/** A `TypeError` or `RangeError`: a mistake in the call, the server's bug and not the user's. */
const inputInfo = (): ErrorInfo => ({ category: "input", status: 500, retryable: false, message: SOMETHING_WENT_WRONG });

function infoOf(error: unknown): ErrorInfo {
  if (IngestError.is(error)) return ingestInfo(error.code, error.status, error.retryAfterMs, error.message);
  // Written to be shown: the operation and a code, never a path or a host.
  if (DocumentStoreError.is(error)) return storeInfo(error.code, eventErrorOf(error).message);
  if (DocumentsNotFoundError.is(error)) {
    return { category: "missing", code: "documents_missing", status: 404, retryable: false, message: eventErrorOf(error).message };
  }
  if (DocumentScopeError.is(error)) return scopeInfo(error.code);
  if (typeof error !== "object" || error === null) return { category: "unknown", status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
  const { name, retryAfterMs } = error as { name?: unknown; retryAfterMs?: unknown };
  if (name === "AbortError") return { category: "aborted", code: "aborted", status: 503, retryable: true, message: "It was stopped before it finished." };
  if (name === "TimeoutError") return { category: "aborted", code: "timeout", status: 504, retryable: true, message: "It took too long, and was stopped. Try again." };
  const plain = isPlainData(error);
  if (plain) {
    const fromEvent = eventInfoOf(error);
    if (fromEvent) return fromEvent;
    // Plain data without a `kind` is not a model's error: an `EventError` of one always has its
    // kind. The `ingest.error` of the upload handler for a hook that failed ({ message, status })
    // keeps its status, and that of a system error its code.
    const { kind, status, message } = error as { kind?: unknown; status?: unknown; message?: unknown };
    if (typeof kind !== "string") return plainInfo(error, status, systemCode(error) ?? codeInWords(message));
  }
  const kind = modelKindOf(error);
  if (kind !== undefined) {
    const { message } = error as { message?: unknown };
    return {
      category: "model",
      code: kind,
      status: MODEL_STATUS[kind],
      retryable: RETRYABLE_KINDS.has(kind),
      ...(isWait(retryAfterMs) ? { retryAfterMs } : {}),
      // By its kind and status, never in the provider's words (eventErrorOf). The library's own
      // words, in an EventError, are kept.
      message: plain && isModelWords(kind, message) ? message : eventErrorOf(error).message,
    };
  }
  if (error instanceof TypeError || error instanceof RangeError) return inputInfo();
  return plainInfo(error, undefined);
}

/**
 * Anything else: "unknown", with the code of a system error (of its event, from the library's
 * words), never its message. `status`, of plain data, is kept when it is one of an error (400 to
 * 599), and says whether to retry. Since 0.10.0 a code that says the server could not answer just
 * now (`TRANSIENT_CODES`) is 503 and retryable, with 5 s to wait, and one of a full disk
 * (`NO_ROOM_CODES`) the same with 30 s, whatever status the data holds.
 */
function plainInfo(error: object, status: unknown, code = systemCode(error)): ErrorInfo {
  const retryAfterMs = retryAfterOfCode(code);
  if (code && retryAfterMs !== undefined) {
    return {
      category: "unknown",
      code,
      status: 503,
      retryable: true,
      retryAfterMs,
      message: NO_ROOM_CODES.has(code) ? `The server has no room right now (${code}). Try again later.` : `The server could not do this just now (${code}). Try again in a moment.`,
    };
  }
  return {
    category: "unknown",
    ...(code ? { code } : {}),
    status: isStatus(status) ? status : 500,
    retryable: RETRY_STATUSES.has(status as number),
    message: code ? `Something went wrong (${code}).` : SOMETHING_WENT_WRONG,
  };
}

/**
 * What an error of the library means, for an application that tells its users in its own words:
 * its category and code, the HTTP status to answer with, whether to retry it, and a message in
 * English that is safe to show (never a path, a host, a stack or a provider's words). It reads
 * the errors of every copy of the package (two versions side by side, or one bundled), and the
 * `EventError` of an event (`run.error`, `ingest.error`, the upload handlers' `ingest.error` too),
 * by its `code`, `name` and `kind`, keeping the words the library wrote. Plain data with none of
 * them is "unknown", with its status. It never throws: what it cannot read is "unknown". New in
 * 0.9.0.
 */
export function errorInfoOf(error: unknown): ErrorInfo {
  try {
    return infoOf(error);
  } catch {
    // An error whose fields throw when read (a getter, a proxy).
    return { category: "unknown", status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
  }
}
