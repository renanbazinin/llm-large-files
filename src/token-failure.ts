// A key, token or header function that failed, told as the model request's own error (since 0.99.13).
import { connectionFailure } from "./connection-failure.js";
import type { ModelErrorKind } from "./model.js";
import { noteNoRetry } from "./retry.js";

/** An adapter's error class: `GeminiRequestError`, `OpenAiRequestError`, `AnthropicRequestError`. */
type RequestErrorClass<E extends Error> = new (message: string, status: number, options: { kind: ModelErrorKind; cause: unknown }) => E;

/**
 * The error of a request whose key, token or headers could not be had: the function that gives
 * them threw before anything was sent (`vertexAi({ accessToken })`, `apiKey`, `authToken` or
 * `headers` as a function).
 * - A connection that failed on the way (a metadata server that reset, undici's "fetch failed"),
 *   by a code of `connectionFailure` anywhere in its causes: status 0, of kind "unreachable" (or
 *   "timeout"). It is sent again, as any request that got no answer.
 * - Anything else (a revoked grant, a bug in the function): status 0, of kind "auth", and not sent
 *   again: another try would fail the same way.
 *
 * Its message names the code of the connection at most. The function's own error, whose words
 * may name the metadata server or the grant, is only its `cause`, for the log: events and the
 * user are told by its kind ("The model could not be reached.", "The model refused the key or
 * token it was sent."). An abort is passed on as it is. `who` starts the message: "Gemini",
 * "Claude", "The model".
 */
export function headerFailure<E extends Error>(error: unknown, RequestError: RequestErrorClass<E>, who: string): unknown {
  if ((error as { name?: unknown } | null)?.name === "AbortError") return error;
  const connection = connectionFailure(error);
  if (connection) {
    return new RequestError(`${who} could not be reached: its key or token could not be fetched${connection.code ? ` (${connection.code})` : ""}.`, 0, { kind: connection.kind, cause: error });
  }
  const failed = new RequestError(`${who} was sent no key or token: the function that gives it failed.`, 0, { kind: "auth", cause: error });
  noteNoRetry(failed);
  return failed;
}
