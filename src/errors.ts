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
 * What to tell a model, or a user, about an error: its message, unless it is a system error, whose
 * message names a path or a host of the server. Of that one only the code is passed on.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof DocumentStoreError) return error.message;
  const { code, syscall } = systemError(error);
  if (code && syscall) return `The file could not be read from storage (${code}). Try the call again.`;
  return error instanceof Error ? error.message : String(error);
}
