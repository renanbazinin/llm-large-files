// The codes of a connection that failed, in one place: whole-file reads, each adapter's request
// that got no answer, and a key or token that could not be fetched read them alike (since 0.99.13).
import type { ModelErrorKind } from "./model.js";

/**
 * The codes of a connection that failed, Node's and undici's, and their kind. An answer that did
 * not come in time is a timeout: undici's headers and body timeouts (300 s each by default) are
 * one, while a connection that never opened (`UND_ERR_CONNECT_TIMEOUT`) could not reach the model.
 */
const CONNECTION_FAILURES: Record<string, ModelErrorKind> = {
  ECONNREFUSED: "unreachable",
  ECONNRESET: "unreachable",
  ECONNABORTED: "unreachable",
  ENOTFOUND: "unreachable",
  EAI_AGAIN: "unreachable",
  ETIMEDOUT: "unreachable",
  EHOSTUNREACH: "unreachable",
  ENETUNREACH: "unreachable",
  ENETDOWN: "unreachable",
  EPIPE: "unreachable",
  UND_ERR_CONNECT_TIMEOUT: "unreachable",
  UND_ERR_SOCKET: "unreachable",
  UND_ERR_CLOSED: "unreachable",
  UND_ERR_DESTROYED: "unreachable",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
};

/** A connection that failed: its kind, and the code it was told by (none for a `TimeoutError`). */
export type ConnectionFailure = { kind: ModelErrorKind; code?: string };

/**
 * The connection that failed, from the code of the error or of one that caused it (the `fetch
 * failed` of undici, which holds the socket's error as its cause). An `AbortSignal.timeout` of the
 * app's (a `TimeoutError`) is a timeout. Undefined for any other error.
 */
export function connectionFailure(error: unknown): ConnectionFailure | undefined {
  let at = error;
  for (let depth = 0; depth < 4 && typeof at === "object" && at !== null; depth++) {
    const { code, name, cause } = at as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof code === "string" && Object.hasOwn(CONNECTION_FAILURES, code)) return { kind: CONNECTION_FAILURES[code]!, code };
    if (name === "TimeoutError") return { kind: "timeout" };
    at = cause;
  }
  return undefined;
}
