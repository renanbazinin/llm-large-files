import { ModelRequestError } from "../model.js";

/** Gemini answered with an HTTP error, or could not be reached (`status` 0). */
export class GeminiRequestError extends ModelRequestError {
  constructor(message: string, status: number, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, status, options);
    this.name = "GeminiRequestError";
  }
}

/** What to say of a request that never got an answer: the reason, without the stack of the HTTP client. */
export function unreachable(error: unknown): GeminiRequestError {
  const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
  return new GeminiRequestError(`Gemini could not be reached${reason}.`, 0, { cause: error });
}
