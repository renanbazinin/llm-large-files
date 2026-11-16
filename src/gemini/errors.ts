import { ModelRequestError } from "../model.js";

/** Gemini answered with an HTTP error, or could not be reached (`status` 0). */
export class GeminiRequestError extends ModelRequestError {
  constructor(message: string, status: number, options: ConstructorParameters<typeof ModelRequestError>[2] = {}) {
    super(message, status, options);
    this.name = "GeminiRequestError";
  }
}

/** What to say of a request that never got an answer: the reason, without the stack of the HTTP client. */
export function unreachable(error: unknown): GeminiRequestError {
  const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
  return new GeminiRequestError(`Gemini could not be reached${reason}.`, 0, { cause: error });
}

/** A request that got nothing back for the whole wait of its `IdleWatch`. */
export function silent(waitMs: number): GeminiRequestError {
  return new GeminiRequestError(`Gemini sent nothing for ${Math.round(waitMs / 1_000)} s.`, 0, { kind: "timeout" });
}

/** The error of a response that is not OK, from its JSON body: Gemini's `error.status` and `details` tell its kind. */
export function geminiFailure(status: number, data: unknown, retryAfterMs: number | undefined, fallback: string): GeminiRequestError {
  const error = (data as { error?: { message?: unknown; status?: unknown; details?: unknown } } | null)?.error;
  return new GeminiRequestError(typeof error?.message === "string" && error.message ? error.message : fallback, status, {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(typeof error?.status === "string" ? { code: error.status } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  });
}

const FILTERED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);
const MALFORMED = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"]);

/** Gemini's `finishReason` in the terms of `ModelReply.finish`. Undefined for a reason it does not know. */
export function finishOfGemini(reason: string | undefined): "complete" | "cut" | "filtered" | "malformed_call" | undefined {
  if (reason === "STOP") return "complete";
  if (reason === "MAX_TOKENS") return "cut";
  if (reason && FILTERED.has(reason)) return "filtered";
  if (reason && MALFORMED.has(reason)) return "malformed_call";
  return undefined;
}
