/** The code and system call of a Node system error (`EIO`, `open`), when the value is one. */
function systemError(value: unknown): { code?: string; syscall?: string } {
  const { code, syscall } = (value ?? {}) as { code?: unknown; syscall?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof syscall === "string" ? { syscall } : {}),
  };
}

/**
 * The store could not be read just now: a volume that did not answer, too many open files, a
 * database that is down. It does not mean that the document is gone, and the same call may work a
 * moment later, so retry it rather than ask the user to upload the file again.
 *
 * The message names no path and no host. The error that was caught is `cause`: log that one on
 * the server, and show this one to a user or a model.
 */
export class DocumentStoreError extends Error {
  /** The code of the system error behind it (`EIO`, `EMFILE`, `ETIMEDOUT`), when there is one. */
  readonly code?: string;
  /** The system call that failed (`open`, `read`), when there is one. */
  readonly syscall?: string;

  constructor(cause: unknown) {
    const { code, syscall } = systemError(cause);
    super(`The document store could not be read${code ? ` (${code})` : ""}. Try again.`, { cause });
    this.name = "DocumentStoreError";
    if (code) this.code = code;
    if (syscall) this.syscall = syscall;
  }
}

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
 * message names a path or a host of the server. Of that one only the code is passed on.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof DocumentStoreError) return error.message;
  const { code, syscall } = systemError(error);
  if (code && syscall) return `The file could not be read from storage (${code}). Try the call again.`;
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
 * - "missing_dependency": the optional dependency for the format is not installed.
 * - "unreadable": the file is damaged, or not of the type its name says.
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
  | "unreadable";

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
  /** The HTTP status the upload handler answers with: 422 for a file that cannot be read, 413 for "too_large", 503 for "busy". */
  readonly status: number;

  constructor(code: IngestErrorCode, message: string, options: { cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IngestError";
    this.code = code;
    this.status = code === "busy" ? 503 : code === "too_large" ? 413 : 422;
    if (options.retryAfterMs !== undefined) (this as { retryAfterMs?: number }).retryAfterMs = options.retryAfterMs;
  }
}

/** The refusals of the library, by the words of their messages: the extractors give plain `Error`s. */
const REFUSALS: Array<[RegExp, IngestErrorCode]> = [
  [/ is empty\.$/, "empty"],
  [/larger than the .* upload limit/, "too_large"],
  [/needs the optional dependency/, "missing_dependency"],
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

/** The code of a refusal of the library, from its message; "unreadable" for any other error of reading a file. */
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
  if (error instanceof IngestError || !(error instanceof Error)) return error;
  const { code, syscall } = systemError(error);
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  if ((code && syscall) || typeof status === "number" || typeof statusCode === "number") return error;
  return new IngestError(ingestErrorCodeOf(error.message), error.message, { cause: error });
}
