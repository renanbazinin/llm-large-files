// Why a model request failed, in the package's own words: by its kind, its HTTP status, or the
// code of a connection that failed, never by its message. A module of its own since 0.99.14 (it was
// in map-reduce.ts), with no Node-only import, for the browser entry (`llm-large-files/client`).
import { connectionFailure } from "./connection-failure.js";
import { classifyModelError, errorKindOf, isModelStatus, type ModelErrorKind } from "./model.js";
import { noTextReason } from "./output-limit.js";
import { statusOf } from "./retry.js";

/**
 * What went wrong with a model request, by its kind, in words for the model that asked for the
 * read. The request may be a part, a merge of notes, or the last step that writes the answer.
 */
const FAILED_BECAUSE: Record<ModelErrorKind, string> = {
  context_overflow: "The request was larger than the model takes",
  quota: "The model's quota has run out",
  rate_limit: "The model was busy",
  timeout: "The model took too long to answer",
  unreachable: "The model could not be reached",
  server: "The model failed on its side",
  auth: "The model refused the key or token it was sent",
  invalid: "The model refused the request",
};

const knownKind = (kind: unknown): kind is ModelErrorKind => typeof kind === "string" && Object.hasOwn(FAILED_BECAUSE, kind);

/**
 * The HTTP status of a model error: its `status`, or the `statusCode` or `response.status` that
 * the errors of other HTTP clients and SDKs carry (got, http-errors, axios). 0 is a request that
 * got no answer. A number that is no HTTP status is not one.
 */
function httpStatusOf(error: unknown): number | undefined {
  const other = error as { statusCode?: unknown; response?: { status?: unknown } | null } | null | undefined;
  for (const status of [statusOf(error), other?.statusCode, other?.response?.status]) {
    if (typeof status === "number" && Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599))) return status;
  }
  return undefined;
}

/** A reason a provider gives for a reply with no text that is a plain word ("SAFETY", "content_filter"). */
const PLAIN_REASON = /^[A-Za-z_]{1,40}$/;

/**
 * Why a model request of a whole-file read failed, as the model and `onStep` are told: by its
 * kind, its HTTP status, or the code of a connection that failed, never by its message. The
 * provider's message, or the HTTP client's, can name a project, a host, a key or a URL of the
 * server, and goes to the log of the app, not to the model. An error with an HTTP status and no
 * kind (that of a provider's SDK, in a `generate` of the app's own) has its kind told from its
 * status and message. An error with none of these is told as a request that failed. A reply with
 * no text to a part reader of the package's is told in the package's words, as before.
 */
export function modelFailureReason(error: unknown): string {
  try {
    const noText = noTextReason(error);
    if (noText !== undefined) return `The model returned no text${PLAIN_REASON.test(noText) ? ` (${noText})` : ""}.`;
    const status = httpStatusOf(error);
    let kind: unknown = errorKindOf(error);
    if (!knownKind(kind) && isModelStatus(status)) {
      const code = (error as { code?: unknown } | null)?.code;
      kind = classifyModelError(status, error instanceof Error ? error.message : "", { code: typeof code === "string" ? code : undefined }).kind;
    }
    if (!knownKind(kind)) kind = connectionFailure(error)?.kind;
    if (!knownKind(kind)) return `The model request failed${status ? ` (HTTP ${status})` : ""}.`;
    // A reply that came with a status of success, and could not be read (a gateway's page).
    if (kind === "invalid" && status !== undefined && status >= 200 && status < 300) return `The model's reply could not be read (HTTP ${status}).`;
    return `${FAILED_BECAUSE[kind]}${status ? ` (HTTP ${status})` : ""}.`;
  } catch {
    // An error whose fields throw when read (a getter, a proxy): their words are not told either.
    return "The model request failed.";
  }
}
