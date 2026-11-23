/**
 * Whether `value` reads as a code (EIO, ETIMEDOUT, NEWER_VERSION): capitals, digits and "_", 32 at
 * most. A driver may put a host in the `code` of an error ("db-prod.internal:27017"): such a code is
 * never shown.
 */
export const isErrorCode = (value: unknown): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(value);

/** The code and system call of a Node system error (`EIO`, `open`), when the value is one. */
function systemError(value: unknown): { code?: string; syscall?: string } {
  const { code, syscall } = (value ?? {}) as { code?: unknown; syscall?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof syscall === "string" ? { syscall } : {}),
  };
}

/**
 * Whether `value` carries the brand `key` (`Symbol.for`), which every copy of this package gives
 * its errors of one class: `instanceof` fails for an error made by another copy of the package (two
 * versions installed side by side, or one bundled), and the brand does not.
 */
export function branded(value: unknown, key: symbol): boolean {
  try {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[key] === true;
  } catch {
    // A proxy whose traps throw.
    return false;
  }
}

/** Puts the brand `key` on the instances of a class, through its prototype (see `branded`). */
export function brand(target: { prototype: object }, key: symbol): void {
  Object.defineProperty(target.prototype, key, { value: true });
}

const DOCUMENT_STORE_ERROR = Symbol.for("llm-large-files.DocumentStoreError");
const DOCUMENT_SCOPE_ERROR = Symbol.for("llm-large-files.DocumentScopeError");
const INGEST_ERROR = Symbol.for("llm-large-files.IngestError");

/**
 * What the store was doing when it failed: reading, writing a document at ingest, deleting one, or
 * removing expired ones. New in 0.9.0.
 */
export type DocumentStoreOperation = "read" | "write" | "delete" | "sweep";

/** The message of a `DocumentStoreError`, by what failed: words for a user, with no path and no host. */
function storeMessage(operation: DocumentStoreOperation, code: string | undefined): string {
  if (code === "NEWER_VERSION") return "The document was stored by a newer version of llm-large-files. Try again.";
  const what = operation === "write" ? "The document could not be stored"
    : operation === "delete" ? "The document could not be deleted"
    : operation === "sweep" ? "The document store could not be cleaned up"
    : "The document store could not be read";
  // A code is shown only when it reads as one (EIO, ETIMEDOUT): a driver may put a host in `code`.
  return `${what}${isErrorCode(code) ? ` (${code})` : ""}. Try again.`;
}

/**
 * The store failed just now: a volume that did not answer, too many open files, a database that
 * is down. It does not mean that the document is gone, and the same call may work a moment later,
 * so retry it rather than ask the user to upload the file again.
 *
 * The message names no path and no host. The error that was caught is `cause`: log that one on
 * the server, and show this one to a user or a model.
 *
 * New in 0.9.0: `operation` says what failed, `status` is 503, and code "NEWER_VERSION" is
 * metadata written by a newer version of the package, which this one does not read. Before 0.9.0
 * it was only made for reads, and `new DocumentStoreError(cause)` still makes one.
 */
export class DocumentStoreError extends Error {
  /**
   * The code of the system error behind it (`EIO`, `EMFILE`, `ETIMEDOUT`), when there is one, or
   * the code it was made with: "NEWER_VERSION".
   */
  readonly code?: string;
  /** The system call that failed (`open`, `read`), when there is one. */
  readonly syscall?: string;
  /** What the store was doing. "read" unless it was made with another. */
  readonly operation: DocumentStoreOperation;
  /** The HTTP status to answer with: the server cannot serve the request now. */
  readonly status: 503 = 503;

  constructor(cause: unknown, options: { operation?: DocumentStoreOperation; code?: string } = {}) {
    const found = systemError(cause);
    const code = options.code ?? found.code;
    const operation = options.operation ?? "read";
    super(storeMessage(operation, code), { cause });
    this.name = "DocumentStoreError";
    this.operation = operation;
    if (code) this.code = code;
    if (found.syscall) this.syscall = found.syscall;
  }

  /** Whether `value` is a `DocumentStoreError`, made by this copy of the package or another one. New in 0.9.0. */
  static is(value: unknown): value is DocumentStoreError {
    return branded(value, DOCUMENT_STORE_ERROR);
  }
}
brand(DocumentStoreError, DOCUMENT_STORE_ERROR);

/**
 * Why a scope was refused (see `DocumentScopeError`):
 * - "scope_invalid": not an array of 1 to 8 segments of 1 to 256 characters, without control
 *   characters, "/" or "\", and not "." or "..", or not one the store can keep;
 * - "scope_required": the store needs a scope, and the call had none;
 * - "scope_missing": the store keeps the scope in a folder that is gone (the chat was deleted).
 */
export type DocumentScopeErrorCode = "scope_required" | "scope_invalid" | "scope_missing";

const SCOPE_MESSAGES: Record<DocumentScopeErrorCode, string> = {
  scope_invalid: "The scope is not valid.",
  scope_required: "A scope is required: pass the scope of the document, such as [userId, chatId].",
  scope_missing: "The scope no longer exists.",
};

/**
 * A scope (`DocumentScope`) that cannot be used: one that is not valid, a call without one to a
 * store that needs one, or a scope whose place in the store is gone. A mistake in the call, not a
 * failure of the store: the library passes it on as it is, and retrying the same call fails again.
 * The message names no segment of the scope. New in 0.9.0.
 */
export class DocumentScopeError extends TypeError {
  readonly code: DocumentScopeErrorCode;

  constructor(code: DocumentScopeErrorCode, message: string = SCOPE_MESSAGES[code], options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DocumentScopeError";
    this.code = code;
  }

  /** Whether `value` is a `DocumentScopeError`, made by this copy of the package or another one. */
  static is(value: unknown): value is DocumentScopeError {
    return branded(value, DOCUMENT_SCOPE_ERROR);
  }
}
brand(DocumentScopeError, DOCUMENT_SCOPE_ERROR);

/**
 * The errors a store threw while `ingest` wrote a document. `ingest` passes them on as they are,
 * and the upload handler tells them apart from a file that could not be read: their message is
 * the store's own (a database driver's names its host), not words for a user.
 */
const storeWriteFailures = new WeakSet<object>();

/** Takes note that a store threw this error while it wrote a document. */
export function noteStoreWriteFailure(error: unknown): void {
  if (typeof error === "object" && error !== null) storeWriteFailures.add(error);
}

/** Whether a store threw this error while it wrote a document (see `noteStoreWriteFailure`). */
export function isStoreWriteFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && storeWriteFailures.has(error);
}

/**
 * What to tell a model, or a user, about an error: its message, unless it is a system error, whose
 * message names a path or a host of the server. Of that one only the code is passed on, when it
 * reads as one (`isErrorCode`).
 */
export function safeErrorMessage(error: unknown): string {
  if (DocumentStoreError.is(error)) return (error as Error).message;
  const { code, syscall } = systemError(error);
  if (code && syscall) return `The file could not be read from storage${isErrorCode(code) ? ` (${code})` : ""}. Try the call again.`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why `ingest` refused a file, for an application that tells its users in its own words (another
 * language, its own tone) rather than with the message:
 * - "empty": the file has no bytes.
 * - "too_large": larger than `maxUploadBytes`.
 * - "too_much_text": more text than `maxTextBytes`, or far more than its size can hold.
 * - "too_many_pages": a PDF with more pages than `maxPdfPages`.
 * - "not_text": a binary file of a kind the library does not read.
 * - "compressed": a gzip or ZIP archive to extract first.
 * - "legacy_office": a Word, Excel or PowerPoint file of before 2007 (.doc, .xls, .ppt), or an
 *   Office file protected by a password: both are stored the same way, and neither can be read.
 * - "encrypted": a PDF protected by a password.
 * - "no_text": nothing to read: a PDF without a text layer (a scan), a deck without slides, a
 *   workbook without sheets, a file of white space.
 * - "hostile": a file built the way files that exhaust a server are: a zip bomb, pages that draw far
 *   more than they hold, a structure no program writes.
 * - "timeout": reading it took longer than `ingestTimeoutMs`, or the kill timer of an isolated reader.
 * - "out_of_memory": an isolated reader ran out of the memory it is given (`createIsolatedExtractors`).
 * - "busy": every isolated reader is busy and the queue is full: try again in a moment
 *   (`IngestError.retryAfterMs`). The upload handler answers 503 with `Retry-After`.
 * - "missing_dependency": the optional dependency for the format is not installed, could not be
 *   loaded, or (`unpdf`) is of a version that cannot read PDFs on this Node.
 * - "unreadable": the file is damaged, or not of the type its name says.
 * - "exists": a document with the ID the application gave (`IngestInput.id`) is already stored.
 *   Status 409. New in 0.9.0.
 */
export type IngestErrorCode =
  | "empty"
  | "too_large"
  | "too_much_text"
  | "too_many_pages"
  | "not_text"
  | "compressed"
  | "legacy_office"
  | "encrypted"
  | "no_text"
  | "hostile"
  | "timeout"
  | "out_of_memory"
  | "busy"
  | "missing_dependency"
  | "unreadable"
  | "exists";

/**
 * `ingest` could not read a file. The message says why, in words for the person who uploaded it,
 * as it always did; `code` says it for the application. New in 0.8.0: before it, the same refusals
 * were plain `Error`s, with the same messages. The error of an extractor, a parser or an isolated
 * reader is `cause`.
 */
export class IngestError extends Error {
  readonly code: IngestErrorCode;
  /** For "busy": how long to wait before trying again, in milliseconds. */
  declare readonly retryAfterMs?: number;
  /** The HTTP status the upload handler answers with: 422 for a file that cannot be read, 413 for "too_large", 409 for "exists", 503 for "busy". */
  readonly status: number;

  constructor(code: IngestErrorCode, message: string, options: { cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IngestError";
    this.code = code;
    this.status = code === "busy" ? 503 : code === "too_large" ? 413 : code === "exists" ? 409 : 422;
    if (options.retryAfterMs !== undefined) (this as { retryAfterMs?: number }).retryAfterMs = options.retryAfterMs;
  }

  /** Whether `value` is an `IngestError`, made by this copy of the package or another one. New in 0.9.0. */
  static is(value: unknown): value is IngestError {
    return branded(value, INGEST_ERROR);
  }
}
brand(IngestError, INGEST_ERROR);

/** The refusals of the library, by the words of their messages: the extractors give plain `Error`s. */
const REFUSALS: Array<[RegExp, IngestErrorCode]> = [
  // First, and to the end of the message: the busy refusal of a file starts with its name, which
  // may hold the words of any other refusal.
  [/^The server is (?:reading other files right now|shutting down)\. Try again in a moment\.$| could not be read now: a reader could not be started(?: \([^()]*\))?\. Try again in a moment\.$/, "busy"],
  [/ is empty\.$/, "empty"],
  [/larger than the .* upload limit/, "too_large"],
  // An unpdf that cannot run on this Node is told as its own message (checkUnpdf in extract.ts).
  [/needs the optional dependency|is installed but could not be loaded|^The unpdf installed (?:cannot read PDF files|would stop the whole server)/, "missing_dependency"],
  [/needed more memory than/, "out_of_memory"],
  [/took too long to read|took longer than/, "timeout"],
  [/may be built to exhaust the server|may be a zip bomb|cannot be checked before it is read|lists the same page more than once|far longer than any Office file writes/, "hostile"],
  [/of text, more than is kept|more text than is (?:kept|read) from one file|million characters of text|draws more than .* of text|unpacks to more than/, "too_much_text"],
  [/ pages, more than the .* read from one file/, "too_many_pages"],
  [/gzip-compressed|is a ZIP archive/, "compressed"],
  [/Word, Excel or PowerPoint file of before 2007|protected by a password and stored/, "legacy_office"],
  [/PasswordException|No password given|Incorrect Password|is protected by a password/i, "encrypted"],
  [/looks binary, not text/, "not_text"],
  [/no text layer|did not contain any text|does not contain any slides|any sheets with cells/, "no_text"],
];

/**
 * The code of a refusal of the library, from its message; "unreadable" for any other error of
 * reading a file. A "busy" message does not say how long to wait: give the `IngestError` a
 * `retryAfterMs` of your own (the isolated readers use 5,000).
 */
export function ingestErrorCodeOf(message: string): IngestErrorCode {
  for (const [pattern, code] of REFUSALS) if (pattern.test(message)) return code;
  return "unreadable";
}

/**
 * `error` as an `IngestError`: one already is kept, a plain `Error` gets the code of its message.
 * Anything else is passed on as it is: a value that is not an `Error`, an error with an HTTP status
 * of its own, and a system error, whose message names paths of the server (an extractor of your
 * own that reads a file).
 */
export function toIngestError(error: unknown): unknown {
  if (IngestError.is(error) || !(error instanceof Error)) return error;
  const { code, syscall } = systemError(error);
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  if ((code && syscall) || typeof status === "number" || typeof statusCode === "number") return error;
  return new IngestError(ingestErrorCodeOf(error.message), error.message, { cause: error });
}
