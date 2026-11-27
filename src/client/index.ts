// `llm-large-files/client`: what a page in the browser needs to show an answer and its sources,
// with no Node-only import, so it bundles for the browser. The server's parts (the library, the
// question loop, the citation hider) are not here. New in 0.99.14.
export { readEvents } from "./read-events.js";
export type { ReadEventsOptions } from "./read-events.js";
export { insertCitationTokens } from "../citation-tokens.js";
export { describeLocator } from "../describe-locator.js";
export { answerInfoOf } from "../answer-info.js";
export type { AnswerInfo } from "../answer-info.js";
export { errorInfoOf } from "../error-info.js";
export type { ErrorCategory, ErrorInfo } from "../error-info.js";
export type { CitationAnchor, CitedSource, LineTalk, SourceLocator } from "../sources.js";
