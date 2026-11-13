// Core: provider-neutral. The tool loop is `askWithFiles`, and a model provider is an adapter:
// "llm-large-files/gemini", "llm-large-files/openai", "llm-large-files/anthropic", or your own.
// Node HTTP handlers are in "llm-large-files/node".
export { createLargeFiles, DEFAULT_CACHE_BYTES, DEFAULT_WHOLE_DOCUMENT_BYTES, isDocumentId, NEVER_EXPIRES, toDocumentSummary } from "./library.js";
export type { AccessOptions, IngestInput, LargeFiles, LargeFilesOptions, PrepareOptions, ToolOptions } from "./library.js";
export { DEFAULT_BUDGET, resolveBudget } from "./budget.js";
export type { ModelLimits } from "./budget.js";
export { askWithFiles, EXPLORER_INSTRUCTION, FINAL_ANSWER_AFTER_PAGES, FINAL_ANSWER_REQUEST, FINAL_ANSWER_WITHOUT_TOOLS } from "./ask.js";
export type { AskLimits, AskOptions, AskResult } from "./ask.js";
export { DocumentsNotFoundError, ModelRequestError, UsageMeter } from "./model.js";
export type {
  ChatMessage,
  ChatTurn,
  ModelAdapter,
  ModelCapabilities,
  ModelMessage,
  ModelPart,
  ModelReply,
  ModelRequest,
  ModelTextMessage,
  ModelToolRound,
  ModelUsage,
  SendHooks,
  ToolAnswer,
  ToolCall,
  ToolTurn,
  UsageTotals,
} from "./model.js";
export { evidenceOf, mergeRanges, stubResult } from "./evidence.js";
export type { Evidence, NumberRange } from "./evidence.js";
export { isRetryableStatus, retryAfterMs, withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export { parseSseJson } from "./sse.js";
export { DocumentStoreError } from "./errors.js";
export { FileDocumentStore, MemoryDocumentStore, DOCUMENT_ID_PATTERN } from "./stores.js";
export { createPdfExtractor, defaultExtractors, detectFormat } from "./extract.js";
export type { PdfExtractorOptions } from "./extract.js";
export { estimateTokens, utf8Bytes, jsonBytes } from "./text.js";
export { MAX_VIEW_PAGES, MAX_WHOLE_DOCUMENT_READS, REGEX_BUDGET_MS, TOOL_NAMES, toolResultSummary } from "./tools.js";
export type * from "./types.js";
