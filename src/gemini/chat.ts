import { askWithFiles, type AskOptions, type AskResult } from "../ask.js";
import type { ChatMessage } from "../model.js";
import { fromGeminiContents, gemini, type GeminiContent } from "./adapter.js";
import type { GeminiEndpoint } from "./endpoints.js";
import type { GeminiRequestFields, GeminiToolFilePlacement } from "./generate.js";

export { DocumentsNotFoundError } from "../model.js";
export { EXPLORER_INSTRUCTION, FINAL_ANSWER_AFTER_PAGES, FINAL_ANSWER_REQUEST, FINAL_ANSWER_WITHOUT_TOOLS, partialResultOf } from "../ask.js";
export type { AskEvent } from "../events.js";
export type { ChatTurn } from "../model.js";
export type { GeminiContent, GeminiPart } from "./adapter.js";
export { GeminiRequestError } from "./errors.js";

/**
 * The options of `askGemini` that are its own. Every other option is `askWithFiles`'s
 * (`AskOptions`), and goes to it as it is. New as a type of its own in 0.10.0.
 */
export type GeminiOwnOptions = {
  /**
   * Where the model is: the one that answers. When the endpoint also names an explorer model
   * (`explorerModel` in `geminiApi()` and `vertexAi()`, or `explorerUrl`), that model makes the
   * tool calls and reads a whole file in parts, and this one writes the answer from what the
   * tools returned. Without an explorer, one model does both.
   */
  endpoint: GeminiEndpoint;
  /**
   * The chat history, as `askWithFiles` takes it; the last turn must be the user's question. It
   * may hold the tool rounds of earlier questions (`toolTurns` of their results), and turns with
   * parts, such as `fromGeminiContents(contents, { rounds: false })` gives. Use this or
   * `contents`. Typed `ChatMessage[]` since 0.9.0; before, `Array<ChatTurn | ToolTurn>`.
   */
  messages?: ChatMessage[];
  /** Your own Gemini `contents` (with images, inline PDFs, etc.). The last turn must be the user's. */
  contents?: GeminiContent[];
  /** Sent with every chat request: temperature, maxOutputTokens, thinkingConfig, and so on. */
  generationConfig?: Record<string, unknown>;
  /**
   * The same, for the requests of an explorer model. Defaults to `generationConfig`. Set it when
   * the two models do not take the same settings: a thinking level that one of them refuses, for
   * example. It is not used without an explorer model.
   */
  explorerGenerationConfig?: Record<string, unknown>;
  /**
   * More fields for the body of every chat request of the model that answers: `safetySettings`,
   * `labels` (Vertex AI; never a user ID), `serviceTier`, `cachedContent`. Merged last
   * (`GeminiModelOptions.body`). New in 0.10.0.
   */
  body?: GeminiRequestFields;
  /** The same, for the requests of an explorer model. Defaults to `body`. New in 0.10.0. */
  explorerBody?: GeminiRequestFields;
  /**
   * More fields for the body of a whole-document part read, given its output limit. The parts are
   * read by the explorer model when there is one. New in 0.10.0.
   */
  analysisBody?: (maxOutputTokens: number) => GeminiRequestFields;
  /** `functionCallingConfig` mode of the requests that offer tools: "AUTO" (the default) or "VALIDATED". New in 0.10.0. */
  functionCallingMode?: "AUTO" | "VALIDATED";
  /** How the request for the answer in text says so: "omit" (the default) or "mode_none" (`GeminiModelOptions`). New in 0.10.0. */
  answerWithoutTools?: "omit" | "mode_none";
  /** The longest time, in milliseconds, of one part read of a whole-file read. Defaults to 180,000; 0 sets none. New in 0.10.0. */
  timeoutMs?: number;
  /** `limits.toolTurns`, under the name it had before 0.5.0. Defaults to 12. */
  maxToolTurns?: number;
  /** `limits.callsPerTurn`, under the name it had before 0.5.0. Defaults to 8. */
  maxToolCallsPerTurn?: number;
  /**
   * Where the pages go in the request. "inside" (the default) puts the PDF in the function
   * response itself, which Gemini 3 models read. "beside" sends it in a user turn of its own,
   * after the function responses: use it for Gemini 2.5, which does not see a file inside a
   * function response.
   */
  toolFilePlacement?: GeminiToolFilePlacement;
  /**
   * generationConfig for whole-document part reads. Defaults to `{ maxOutputTokens }`, with no temperature.
   * The parts are read by the explorer model when there is one, so write it for that model.
   */
  analysisConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  /**
   * The longest wait, in milliseconds, for the first piece of a chat reply (see
   * `GeminiModelOptions`). Defaults to 600,000. 0 waits without end.
   */
  firstByteTimeoutMs?: number;
  /**
   * The longest wait, in milliseconds, between two pieces of a chat reply once it has started to
   * arrive. Defaults to 300,000. 0 waits without end.
   */
  idleTimeoutMs?: number;
  fetch?: typeof fetch;
};

/**
 * The options of `askGemini`: its own (`GeminiOwnOptions`), and every option of `askWithFiles` but
 * the models, which it makes. Since 0.10.0 the options of `askWithFiles` are taken by their type, so
 * an option new there reaches the loop through `askGemini` too; no option was removed.
 */
export type AskGeminiOptions = Omit<AskOptions, "model" | "explorer" | "messages"> & GeminiOwnOptions;

/** What `askWithFiles` returns. `usage` is summed over the whole question; Gemini's own `usageMetadata` of the last response is `lastUsage`. */
export type AskGeminiResult = AskResult;

/**
 * Answers a chat turn about large documents with Gemini (Generate Content REST): `askWithFiles`
 * with a `gemini()` model for the endpoint, and a second one for its explorer model when it names
 * one. Documents that fit go into the prompt whole; otherwise Gemini gets search and read tools
 * and the tool loop runs, ending with a request without tools so there is always an answer.
 */
export async function askGemini(options: AskGeminiOptions): Promise<AskGeminiResult> {
  const {
    endpoint, messages, contents, generationConfig, explorerGenerationConfig, body, explorerBody, analysisBody, functionCallingMode,
    answerWithoutTools, timeoutMs, maxToolTurns, maxToolCallsPerTurn, toolFilePlacement, analysisConfig, firstByteTimeoutMs, idleTimeoutMs,
    fetch, limits, ...loop
  } = options;
  // A second model for the requests that use tools. The answering model's own URL is not one.
  const explorerUrl = endpoint.explorerUrl && endpoint.explorerUrl !== endpoint.url ? endpoint.explorerUrl : undefined;
  const shared = {
    toolFilePlacement, analysisConfig, firstByteTimeoutMs, idleTimeoutMs, fetch,
    ...(analysisBody ? { analysisBody } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(functionCallingMode ? { functionCallingMode } : {}),
    ...(answerWithoutTools ? { answerWithoutTools } : {}),
  };
  const model = gemini(endpoint, { ...shared, generationConfig, ...(body ? { body } : {}) });
  // The explorer is called with the same headers, in one piece, with its own settings when it has any.
  const explorerBodyOf = explorerBody ?? body;
  const explorer = explorerUrl
    ? gemini({
        url: explorerUrl,
        headers: endpoint.headers,
        ...(endpoint.refreshable ? { refreshable: endpoint.refreshable } : {}),
      }, { ...shared, generationConfig: explorerGenerationConfig ?? generationConfig, ...(explorerBodyOf ? { body: explorerBodyOf } : {}) })
    : undefined;
  return askWithFiles({
    ...loop,
    model,
    explorer,
    messages: contents ? fromGeminiContents(contents) : messages ?? [],
    limits: {
      ...(maxToolTurns !== undefined ? { toolTurns: maxToolTurns } : {}),
      ...(maxToolCallsPerTurn !== undefined ? { callsPerTurn: maxToolCallsPerTurn } : {}),
      ...limits,
    },
  });
}
