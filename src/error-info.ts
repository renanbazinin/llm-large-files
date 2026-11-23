// What an error means for an application: one record to choose a status, a retry and words of
// your own by, in any language. New in 0.9.0.
import { DocumentScopeError, DocumentStoreError, IngestError } from "./errors.js";
import { eventErrorOf } from "./events.js";
import { classifyModelError, DocumentsNotFoundError, ModelRequestError, type ModelErrorKind } from "./model.js";

/**
 * What kind of failure an error is (`ErrorInfo.category`):
 * - "ingest": a file `ingest` refused (`IngestError`): `code` says why;
 * - "store": the document store failed just now (`DocumentStoreError`);
 * - "missing": documents that are gone (`DocumentsNotFoundError`), or the chat of a scope that is
 *   gone (`DocumentScopeError` "scope_missing");
 * - "model": a model request failed (`ModelRequestError`): `code` is its kind;
 * - "aborted": stopped by a signal (an `AbortError`, or a `TimeoutError` of `AbortSignal.timeout`);
 * - "input": a mistake in the call (a `TypeError` or `RangeError`, or a `DocumentScopeError`
 *   "scope_invalid" or "scope_required"): a bug of the server, not of the user;
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

const SOMETHING_WENT_WRONG = "Something went wrong.";
const UNREADABLE = "This file could not be read. It may be damaged, or not of the type its name says.";
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

const isKind = (value: unknown): value is ModelErrorKind => typeof value === "string" && Object.hasOwn(MODEL_STATUS, value);
const isStatus = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
const isWait = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The code of a Node system error (one with a `code` and a `syscall`), whose message names paths or hosts. */
function systemCode(error: object): string | undefined {
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return typeof code === "string" && typeof syscall === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : undefined;
}

/** The kind of a model error: its own, or the one its status gives (an error of an adapter of your own). */
function modelKindOf(error: object): ModelErrorKind | undefined {
  const { kind, status, message } = error as { kind?: unknown; status?: unknown; message?: unknown };
  if (isKind(kind)) return kind;
  if (ModelRequestError.is(error) || (typeof status === "number" && (status === 0 || status >= 400))) {
    return classifyModelError(typeof status === "number" ? status : 0, typeof message === "string" ? message : "").kind;
  }
  return undefined;
}

function infoOf(error: unknown): ErrorInfo {
  if (IngestError.is(error)) {
    const code = error.code;
    return {
      category: "ingest",
      code,
      status: isStatus(error.status) ? error.status : 422,
      retryable: code === "busy",
      ...(code === "busy" && isWait(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
      // An unreadable file has the parser's message, or that of an extractor of your own: not words for a user.
      message: code === "unreadable" || typeof error.message !== "string" || !error.message ? UNREADABLE : error.message,
    };
  }
  if (DocumentStoreError.is(error)) {
    return {
      category: "store",
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      status: 503,
      retryable: true,
      retryAfterMs: STORE_RETRY_AFTER_MS,
      // Written to be shown: the operation and a code, never a path or a host.
      message: eventErrorOf(error).message,
    };
  }
  if (DocumentsNotFoundError.is(error)) {
    return { category: "missing", code: "documents_missing", status: 404, retryable: false, message: eventErrorOf(error).message };
  }
  if (DocumentScopeError.is(error)) {
    if (error.code === "scope_missing") return { category: "missing", code: "scope_missing", status: 404, retryable: false, message: CHAT_GONE };
    // A scope the server should have given, or given right: its bug, not the user's.
    return { category: "input", code: String(error.code), status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
  }
  if (typeof error !== "object" || error === null) return { category: "unknown", status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
  const { name, retryAfterMs } = error as { name?: unknown; retryAfterMs?: unknown };
  if (name === "AbortError") return { category: "aborted", code: "aborted", status: 503, retryable: true, message: "It was stopped before it finished." };
  if (name === "TimeoutError") return { category: "aborted", code: "timeout", status: 504, retryable: true, message: "It took too long, and was stopped. Try again." };
  const kind = modelKindOf(error);
  if (kind !== undefined) {
    return {
      category: "model",
      code: kind,
      status: MODEL_STATUS[kind],
      retryable: RETRYABLE_KINDS.has(kind),
      ...(isWait(retryAfterMs) ? { retryAfterMs } : {}),
      // By its kind and status, never in the provider's words (eventErrorOf).
      message: eventErrorOf(error).message,
    };
  }
  if (error instanceof TypeError || error instanceof RangeError) return { category: "input", status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
  const code = systemCode(error);
  if (code) return { category: "unknown", code, status: 500, retryable: false, message: `Something went wrong (${code}).` };
  return { category: "unknown", status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
}

/**
 * What an error of the library means, for an application that tells its users in its own words:
 * its category and code, the HTTP status to answer with, whether to retry it, and a message in
 * English that is safe to show (never a path, a host, a stack or a provider's words). It reads
 * the errors of every copy of the package (two versions side by side, or one bundled), and never
 * throws: what it cannot read is "unknown". New in 0.9.0.
 */
export function errorInfoOf(error: unknown): ErrorInfo {
  try {
    return infoOf(error);
  } catch {
    // An error whose fields throw when read (a getter, a proxy).
    return { category: "unknown", status: 500, retryable: false, message: SOMETHING_WENT_WRONG };
  }
}
