import { notJsonMessage, unreachableReason, waitText } from "../http.js";
import { ModelRequestError, type ModelReply } from "../model.js";

/** Gemini answered with an HTTP error, or could not be reached (`status` 0). */
export class GeminiRequestError extends ModelRequestError {
  constructor(message: string, status: number, options: ConstructorParameters<typeof ModelRequestError>[2] = {}) {
    super(message, status, options);
    this.name = "GeminiRequestError";
  }
}

/** What to say of a request that never got an answer: the reason, without the stack of the HTTP client. */
export function unreachable(error: unknown): GeminiRequestError {
  return new GeminiRequestError(`Gemini could not be reached${unreachableReason(error)}.`, 0, { cause: error });
}

/** A body that came with a status of success but is no JSON (a gateway's page): it is not sent again. */
export function notJson(response: Response, error: unknown): GeminiRequestError {
  return new GeminiRequestError(notJsonMessage("Gemini's", response), response.status, { kind: "invalid", cause: error });
}

/** A request that got nothing back for the whole wait of its `IdleWatch`. */
export function silent(waitMs: number): GeminiRequestError {
  return new GeminiRequestError(`Gemini sent nothing for ${Math.round(waitMs / 1_000)} s.`, 0, { kind: "timeout" });
}

/** A part read whose whole reply did not come within its time limit (`timeoutMs`). New in 0.10.0. */
export function tooSlow(limitMs: number): GeminiRequestError {
  return new GeminiRequestError(`Gemini took longer than ${waitText(limitMs)} to answer.`, 0, { kind: "timeout" });
}

/**
 * The HTTP status of each code of `google.rpc.Code`, as Google maps them. An error that came
 * inside a reply of HTTP 200 (an event of a stream, a body of a gateway) names its code this way
 * when it has no number: `{ "status": "UNAVAILABLE" }` is 503.
 */
export const GEMINI_STATUS: Readonly<Record<string, number>> = {
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  UNAUTHENTICATED: 401,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
};

/** Gemini's error object of a body: `{ error }`, or the first entry of a list, as a gateway may send it. */
export function errorBodyOf(data: unknown): { error?: { message?: unknown; code?: unknown; status?: unknown; details?: unknown } } | null {
  const body = Array.isArray(data) ? data[0] : data;
  return body !== null && typeof body === "object" ? body as { error?: { message?: unknown; code?: unknown; status?: unknown; details?: unknown } } : null;
}

/**
 * The status of an error that came inside a reply of HTTP 200: its numeric `code`, else the status
 * of its `google.rpc` code (`GEMINI_STATUS`), else 500, a failure on Gemini's side.
 */
export function statusOfError(error: { code?: unknown; status?: unknown } | null | undefined): number {
  const code = error?.code;
  if (typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599) return code;
  const named = typeof error?.status === "string" && Object.hasOwn(GEMINI_STATUS, error.status) ? GEMINI_STATUS[error.status] : undefined;
  return named ?? 500;
}

/**
 * The error of a response that is not OK, or of an error in a reply of HTTP 200, from its JSON
 * body: Gemini's `error.status` and `details` tell its kind. A body that is a list is read by its
 * first entry.
 */
export function geminiFailure(status: number, data: unknown, retryAfterMs: number | undefined, fallback: string): GeminiRequestError {
  const error = errorBodyOf(data)?.error;
  return new GeminiRequestError(typeof error?.message === "string" && error.message ? error.message : fallback, status, {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(typeof error?.status === "string" ? { code: error.status } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  });
}

/** Reasons of a reply that a filter stopped: Gemini's safety filters, Model Armor on Vertex AI, and their image kinds. */
const FILTERED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "MODEL_ARMOR", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "IMAGE_OTHER"]);
/** Reasons of a turn whose tool call could not be read. */
const MALFORMED = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]);
/**
 * Known reasons that are none of the others, and that asking again does not mend. LANGUAGE (a
 * language the model does not take) is not a filter: `answerInfoOf` gives it reason "language".
 */
const OTHER = new Set(["OTHER", "FINISH_REASON_UNSPECIFIED", "NO_IMAGE", "TOO_MANY_TOOL_CALLS", "MISSING_THOUGHT_SIGNATURE", "LANGUAGE"]);

/**
 * Gemini's `finishReason` in the terms of `ModelReply.finish`. Undefined for a reason it does not
 * know. Since 0.10.0, MODEL_ARMOR and the image reasons are "filtered", MALFORMED_RESPONSE is
 * "malformed_call", and OTHER, LANGUAGE and four more are "other".
 */
export function finishOfGemini(reason: string | undefined): ModelReply["finish"] {
  if (reason === "STOP") return "complete";
  if (reason === "MAX_TOKENS") return "cut";
  if (reason && FILTERED.has(reason)) return "filtered";
  if (reason && MALFORMED.has(reason)) return "malformed_call";
  if (reason && OTHER.has(reason)) return "other";
  return undefined;
}
