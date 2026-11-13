import { askWithFiles, type AskLimits, type AskResult } from "../ask.js";
import type { LargeFiles } from "../library.js";
import type { ChatTurn, ToolTurn } from "../model.js";
import type { RetryOptions } from "../retry.js";
import type { Budget } from "../types.js";
import { fromGeminiContents, gemini, type GeminiContent } from "./adapter.js";
import type { GeminiEndpoint } from "./endpoints.js";
import type { GeminiToolFilePlacement } from "./generate.js";

export { DocumentsNotFoundError } from "../model.js";
export { EXPLORER_INSTRUCTION, FINAL_ANSWER_AFTER_PAGES, FINAL_ANSWER_REQUEST, FINAL_ANSWER_WITHOUT_TOOLS } from "../ask.js";
export type { ChatTurn } from "../model.js";
export type { GeminiContent, GeminiPart } from "./adapter.js";
export { GeminiRequestError } from "./errors.js";

export type AskGeminiOptions = {
  files: LargeFiles;
  /**
   * Where the model is: the one that answers. When the endpoint also names an explorer model
   * (`explorerModel` in `geminiApi()` and `vertexAi()`, or `explorerUrl`), that model makes the
   * tool calls and reads a whole file in parts, and this one writes the answer from what the
   * tools returned. Without an explorer, one model does both.
   */
  endpoint: GeminiEndpoint;
  /** Documents this conversation may use. Where their text or cards go: see `documentPlacement`. */
  documentIds: string[];
  /**
   * Where document text and cards are added. "first" (the default) puts them at the start of the
   * first user turn, where they stay as the conversation grows, so Gemini's prompt cache can
   * reuse them on every follow-up question. "last" appends them to the latest user turn, as 0.1.0
   * did; the document then moves on every turn and is billed in full each time.
   */
  documentPlacement?: "first" | "last";
  /**
   * Plain chat history; the last turn must be the user's question. It may hold the tool rounds of
   * earlier questions (`toolTurns` of their results). Use this or `contents`.
   */
  messages?: Array<ChatTurn | ToolTurn>;
  /** Your own Gemini `contents` (with images, inline PDFs, etc.). The last turn must be the user's. */
  contents?: GeminiContent[];
  system?: string;
  /** Sent with every chat request: temperature, maxOutputTokens, thinkingConfig, and so on. */
  generationConfig?: Record<string, unknown>;
  /**
   * The same, for the requests of an explorer model. Defaults to `generationConfig`. Set it when
   * the two models do not take the same settings: a thinking level that one of them refuses, for
   * example. It is not used without an explorer model.
   */
  explorerGenerationConfig?: Record<string, unknown>;
  /** The user asking. Documents ingested with a different owner are treated as missing. */
  owner?: string;
  /** The limits of the question: tool turns, calls in a turn, whole-file reads, tokens and requests. */
  limits?: AskLimits;
  /** `limits.toolTurns`, under the name it had before 0.5.0. Defaults to 12. */
  maxToolTurns?: number;
  /** `limits.callsPerTurn`, under the name it had before 0.5.0. Defaults to 8. */
  maxToolCallsPerTurn?: number;
  /** How a request that failed is sent again. Defaults to three more tries, with a wait that doubles. */
  retry?: RetryOptions;
  /** Budget fields for this question, in place of the library's. */
  budget?: Partial<Budget>;
  /** Offer `analyze_whole_document`, which reads a whole file in many model calls. Defaults to true. */
  wholeDocumentAnalysis?: boolean;
  /**
   * Offer `view_pages` for PDFs whose original file is kept (`keepOriginals`), so the model can
   * look at pictures, charts and layout. Defaults to true. It changes nothing for a library that
   * keeps no originals.
   */
  viewPages?: boolean;
  /**
   * Where the pages go in the request. "inside" (the default) puts the PDF in the function
   * response itself, which Gemini 3 models read. "beside" sends it in a user turn of its own,
   * after the function responses: use it for Gemini 2.5, which does not see a file inside a
   * function response.
   */
  toolFilePlacement?: GeminiToolFilePlacement;
  /**
   * generationConfig for whole-document part reads. Defaults to `{ temperature: 0.2, maxOutputTokens }`.
   * The parts are read by the explorer model when there is one, so write it for that model.
   */
  analysisConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  /** Answer text as it streams. Streaming is used when this is set and the endpoint has `streamUrl`. */
  onText?: (delta: string) => void;
  /** Short-lived status, such as "Searching app.log for “timeout”…". */
  onActivity?: (text: string) => void;
  /** A finished step, such as "Search app.log (exact) for “timeout” — 12 matching lines". */
  onStep?: (text: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

/** What `askWithFiles` returns. `usage` is summed over the whole question; Gemini's own `usageMetadata` of the last response is `lastUsage`. */
export type AskGeminiResult = AskResult;

/**
 * Answers a chat turn about large documents with Gemini (Generate Content REST): `askWithFiles`
 * with a `gemini()` model for the endpoint, and a second one for its explorer model when it names
 * one. Documents that fit go into the prompt whole; otherwise Gemini gets search and read tools
 * and the tool loop runs, ending with a request without tools so there is always an answer.
 */
export async function askGemini(options: AskGeminiOptions): Promise<AskGeminiResult> {
  const { endpoint } = options;
  // A second model for the requests that use tools. The answering model's own URL is not one.
  const explorerUrl = endpoint.explorerUrl && endpoint.explorerUrl !== endpoint.url ? endpoint.explorerUrl : undefined;
  const shared = { toolFilePlacement: options.toolFilePlacement, analysisConfig: options.analysisConfig, fetch: options.fetch };
  const model = gemini(endpoint, { ...shared, generationConfig: options.generationConfig });
  // The explorer is called with the same headers, in one piece, with its own settings when it has any.
  const explorer = explorerUrl
    ? gemini({ url: explorerUrl, headers: endpoint.headers }, { ...shared, generationConfig: options.explorerGenerationConfig ?? options.generationConfig })
    : undefined;
  return askWithFiles({
    files: options.files,
    model,
    explorer,
    documentIds: options.documentIds,
    ...(options.documentPlacement ? { documentPlacement: options.documentPlacement } : {}),
    messages: options.contents ? fromGeminiContents(options.contents) : options.messages ?? [],
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    limits: {
      ...(options.maxToolTurns !== undefined ? { toolTurns: options.maxToolTurns } : {}),
      ...(options.maxToolCallsPerTurn !== undefined ? { callsPerTurn: options.maxToolCallsPerTurn } : {}),
      ...options.limits,
    },
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.wholeDocumentAnalysis !== undefined ? { wholeDocumentAnalysis: options.wholeDocumentAnalysis } : {}),
    ...(options.viewPages !== undefined ? { viewPages: options.viewPages } : {}),
    ...(options.onText ? { onText: options.onText } : {}),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    ...(options.onStep ? { onStep: options.onStep } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
