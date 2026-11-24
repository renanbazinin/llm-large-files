// Core: provider-neutral. The tool loop is `askWithFiles`, and a model provider is an adapter:
// "llm-large-files/gemini", "llm-large-files/openai", "llm-large-files/anthropic", or your own.
// Node HTTP handlers are in "llm-large-files/node".
export { createLargeFiles, DEFAULT_CACHE_BYTES, DEFAULT_INGEST_TIMEOUT_MS, DEFAULT_MAX_PDF_PAGES, DEFAULT_MAX_TEXT_BYTES, DEFAULT_WHOLE_DOCUMENT_BYTES, isDocumentId, NEVER_EXPIRES, toDocumentSummary } from "./library.js";
export type { AccessOptions, IngestFromSource, IngestInput, IngestSource, LargeFiles, LargeFilesOptions, OriginalReadContext, OriginalsReader, PrepareOptions, ToolOptions } from "./library.js";
export { DEFAULT_BUDGET, resolveBudget } from "./budget.js";
export type { ModelLimits } from "./budget.js";
export { askStream, askWithFiles, EXPLORER_INSTRUCTION, FINAL_ANSWER_AFTER_PAGES, FINAL_ANSWER_REQUEST, FINAL_ANSWER_WITHOUT_TOOLS, partialResultOf } from "./ask.js";
export type { AskLimits, AskOptions, AskResult, MissingDocumentsAction, MissingDocumentsContext } from "./ask.js";
export { classifyModelError, DocumentsNotFoundError, errorKindOf, ModelRequestError, TOOL_TURN_VERSION, UsageMeter } from "./model.js";
export type {
  ChatMessage,
  ModelErrorClass,
  ModelErrorKind,
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
export { eventStream, newRunId } from "./events.js";
export type {
  AskEvent,
  DocumentRef,
  EventBase,
  EventError,
  EventResult,
  EventStream,
  IngestEvent,
  IngestStage,
  LibraryEvent,
  NoticeCode,
  NoticeDisplay,
  RequestPurpose,
  RequestRole,
  ToolOutcome,
} from "./events.js";
export { evidenceOf, mergeRanges, stubResult } from "./evidence.js";
export type { Evidence, NumberRange } from "./evidence.js";
export { isRetryableStatus, retryAfterMs, withRetry } from "./retry.js";
export type { RetryNotice, RetryOptions } from "./retry.js";
export { parseSseJson, SseEventTooLongError } from "./sse.js";
export type { SseHooks } from "./sse.js";
export { DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from "./http.js";
export type { IdleWaits } from "./http.js";
export { DocumentScopeError, DocumentStoreError, IngestError, ingestErrorCodeOf } from "./errors.js";
export type { DocumentScopeErrorCode, DocumentStoreOperation, IngestErrorCode } from "./errors.js";
export { errorInfoOf } from "./error-info.js";
export type { ErrorCategory, ErrorInfo } from "./error-info.js";
export { APP_DOCUMENT_ID_PATTERN, DOCUMENT_ID_PATTERN, DOCUMENT_META_VERSION, FileDocumentStore, hashedScopeSegment, isSafeScopeSegment, MemoryDocumentStore } from "./stores.js";
export type { FileDocumentScopes, FileDocumentStoreOptions } from "./stores.js";
export { createPdfExtractor, defaultExtractors, detectFormat } from "./extract.js";
export type { PdfExtractorOptions } from "./extract.js";
export { estimateTokens, utf8Bytes, jsonBytes } from "./text.js";
export { MAX_VIEW_PAGES, MAX_WHOLE_DOCUMENT_READS, REGEX_BUDGET_MS, TOOL_NAMES, toolResultSummary } from "./tools.js";
export type * from "./types.js";
