// The tool loop, for any model: plan the documents, offer the tools, run the calls within the
// limits of the request, and end with an answer. A provider is an adapter (see model.ts).
import { eventErrorOf, EventEmitter, eventStream, newRunId, type AskEvent, type DocumentRef, type EventResult, type EventStream, type NoticeCode, type RequestPurpose, type RequestRole, type ToolOutcome } from "./events.js";
import { checkCitations, type CitationCheck } from "./citations.js";
import { evidenceOf, stubResult, type Evidence } from "./evidence.js";
import { isCutReply, until } from "./http.js";
import type { LargeFiles } from "./library.js";
import { Limiter } from "./limiter.js";
import {
  checkToolTurnVersion,
  DocumentsNotFoundError,
  errorKindOf,
  laterResult,
  modelErrorOf,
  rateAllowanceOf,
  reportsInput,
  TOOL_TURN_VERSION,
  UsageMeter,
  type ChatMessage,
  type ModelAdapter,
  type ModelMessage,
  type ModelReply,
  type ModelRequest,
  type ModelTextMessage,
  type ModelToolRound,
  type ToolAnswer,
  type ToolCall,
  type ToolTurn,
  type UsageTotals,
} from "./model.js";
import { DocumentStoreError } from "./errors.js";
import { nativeFile, nativeFilesLine, sharedDocuments } from "./native.js";
import { canBeReadWhole, estimateParts, inlineInstruction, questionTools, REQUEST_BYTES_MARGIN } from "./plan.js";
import { preparedHere } from "./prepare.js";
import { checkQuestionId, validQuestionId } from "./question-id.js";
import { statusOf, withRetry, type RetryNotice, type RetryOptions } from "./retry.js";
import { estimateTokens, jsonBytes, wellFormedJson } from "./text.js";
import {
  alreadyShown,
  failureKind,
  fitAnswer,
  LEAST_RESULT_CHARACTERS,
  MAX_WHOLE_DOCUMENT_READS,
  repeatedFailureHint,
  stepLine,
  TOOL_NAMES,
  toolCallKey,
  toolResultSummary,
  unknownToolName,
} from "./tools.js";
import type { Budget, DocumentFormat, DocumentMeta, DocumentPlan, DocumentScope, GenerateText, PageImageOptions, PreparedContext, ToolCallHooks, ToolCallLimits, ToolFile, ToolFileType, ToolOutput, ToolRequestEnd, ToolRequestHandle, ToolRequestStart, ToolResult } from "./types.js";
import { wholeReadCost } from "./whole-cost.js";

/** Sent (invisibly to the user) when the model must stop using tools and answer. */
export const FINAL_ANSWER_REQUEST = "Stop using tools now. Answer my question using only what the tools returned above, with line citations. Say plainly what you could not find. Answer in the language of my question.";
/**
 * The same, when files were also sent whole and the tools can read them or their lines are
 * numbered: what they say is part of the answer too, not only what the tools returned. New in
 * 0.10.0. Not exported from the package.
 */
export const FINAL_ANSWER_WITH_FILES = "Stop using tools now. Answer my question using only the files shown in full and what the tools returned above, with line citations. Say plainly what you could not find. Answer in the language of my question.";
/** The same, when the only tool was `view_pages`: the text of the files is in the prompt, not in tool results. */
export const FINAL_ANSWER_AFTER_PAGES = "Stop using tools now. Answer my question from the text of the files and the pages you looked at. Say plainly what you could not see or find. Answer in the language of my question.";
/**
 * Sent when no tool ran (an explorer model called none, the first reply was empty, or no turn was
 * left for tools), so there is no tool result to answer from.
 */
export const FINAL_ANSWER_WITHOUT_TOOLS = "Answer my question now, from what is in this conversation. No tools are available for this reply: if the answer needs a part of a file that is not shown here, say so plainly. Answer in the language of my question.";
/**
 * Added to the system instruction of an explorer model's requests: it gathers what the answer
 * needs, and the other model writes the answer.
 */
export const EXPLORER_INSTRUCTION = "You only gather material in this conversation: another model writes the answer. It sees this conversation and what your tool calls returned, not what you thought or wrote. So call the tools until their results hold everything the answer needs from the files. Then, or at once if no tool is needed, reply with the single word DONE instead of an answer.";

/**
 * The least ceiling on the input tokens of a question that sets no `limits.inputTokens`. Its
 * ceiling is the larger of this and `toolTurns` times its first request, with the room for its
 * whole-file reads added. New in 0.10.0.
 */
export const DEFAULT_INPUT_TOKENS = 1_000_000;

/** How many whole-file reads one question may make, over all its documents, by default (`limits.wholeReadsPerQuestion`). */
const DEFAULT_WHOLE_READS_PER_QUESTION = 2;

/** The limits of one question. */
export type AskLimits = {
  /**
   * The most model requests of the chat for one question, counting the answer. Tools can run in
   * all but the last: if the model is still calling tools then, the last request must be answered
   * in text. Defaults to 12. With an explorer model the answer is always a request of its own, so
   * the explorer has one less than this. An answer that comes back without text is asked for once
   * more, and that request can be one past this.
   */
  toolTurns?: number;
  /**
   * The most tool calls of one model turn that are run. A turn with more gets an error for each
   * of the others, which tells the model to send it again if it is still needed. Defaults to 8.
   */
  callsPerTurn?: number;
  /**
   * How many times each document may be read whole (`analyze_whole_document`) for one question.
   * One read of a large file is up to `maxMapChunks` model requests. Defaults to 1; 0 refuses
   * every whole-file read.
   */
  wholeDocumentReads?: number;
  /**
   * A ceiling on the input tokens of one question, over all its requests, whole-file part reads
   * included, in the models' own tokens. Before each tool request the loop looks ahead: when what
   * was spent, that request and the answer's request would pass it, no more tools run and the next
   * request is the answer. A whole-file read that would pass it is refused. A request whose
   * provider reports no input counts by the library's estimate (`UsageTotals.estimatedInputTokens`).
   * Unset (since 0.10.0): the larger of `DEFAULT_INPUT_TOKENS` and `toolTurns` times the estimate
   * of the question's first request, plus room for its whole-file reads: as many as
   * `wholeReadsPerQuestion` and the documents allow, each at the price of the dearest one.
   * `Infinity`: no ceiling, as before 0.10.0.
   */
  inputTokens?: number;
  /** The same ceiling, on the number of model requests: the chat's and the part reads' together. */
  requests?: number;
  /**
   * How many whole-file reads (`analyze_whole_document`) one question may make over all its
   * documents, next to `wholeDocumentReads` for each one. A read that sent requests counts, one
   * that failed among them. Defaults to 2; `Infinity` keeps the rule of 0.9, one read of each
   * document. New in 0.10.0.
   */
  wholeReadsPerQuestion?: number;
};

export type AskOptions = {
  files: LargeFiles;
  /**
   * The model that answers. With an `explorer` it only writes the answer, from what the explorer's
   * tool calls returned. Without one it does both.
   */
  model: ModelAdapter;
  /**
   * A second model that explores the documents: it makes the tool calls (search, read, look at
   * pages) and reads a whole file in parts. It may be of another provider than `model`. Left out,
   * or the same adapter as `model`: one model does both. Since 0.10.0 it is not used when no file
   * is searched and the tools are there for tables sent whole: `model` runs them.
   */
  explorer?: ModelAdapter | undefined;
  /** Documents this conversation may use. Where their text or cards go: see `documentPlacement`. */
  documentIds: string[];
  /**
   * Where document text and cards are added. "first" (the default) puts them at the start of the
   * first user turn, where they stay as the conversation grows, so a provider's prompt cache can
   * reuse them on every follow-up question. "last" appends them to the latest user turn; the
   * document then moves on every turn and is billed in full each time.
   */
  documentPlacement?: "first" | "last";
  /**
   * What to do with an answer that a filter of the provider stopped (`AskResult.finish`
   * "filtered"): "keep" (the default) keeps its text, as in 0.9; "drop" gives `answered: false` and
   * `text: ""`. Text already sent through `onText` and `text` events cannot be taken back: the
   * "answer_filtered" notice then says `discardText`, before `run.finish`. New in 0.10.0.
   */
  filteredAnswer?: "keep" | "drop";
  /**
   * Called with the result of every tool call that ran, before the model, the evidence, the steps
   * and the events get it: return `{ result }` to send another result (it is sent with
   * `redacted: true`, and the call's outcome is "redacted"), `{ reject: "why" }` to send
   * `{ error: "why" }` in its place (outcome "refused"), or undefined to keep it. What it throws, or
   * a value of another shape, ends the question. Each call's hook is called as soon as its result
   * is in, so those of one turn may run at the same time; the verdicts are applied in call order,
   * and what they let through is then fitted to the room in the request. The parts of a whole-file
   * read go to the model that reads them, not through this. New in 0.10.0.
   */
  onToolResult?: (context: ToolResultContext) => ToolResultVerdict | undefined | Promise<ToolResultVerdict | undefined>;
  /**
   * The conversation; the last message must be the user's question. Plain turns
   * (`{ role, text }`), the tool rounds an earlier question returned (`AskResult.toolTurns`), and
   * turns with parts in the provider's own form (`{ role, parts: [{ text }, { native }] }`).
   */
  messages: ChatMessage[];
  system?: string;
  /**
   * The user asking. Documents ingested with a different owner are treated as missing. Required
   * unless the library has `requireOwner: false` (since 0.99.9): documents of another owner, or
   * without one under the default, are missing.
   */
  owner?: string;
  /**
   * The scope of the question, such as [userId, chatId] (`DocumentScope`). It is passed to every
   * store call, and documents ingested with another scope are treated as missing. New in 0.9.0.
   */
  scope?: DocumentScope;
  /**
   * What to do when documents of `documentIds` are missing: expired, deleted, never ingested, or of
   * another owner or scope, which look the same. It is settled before any model request.
   * - "throw" (the default): the question fails with `DocumentsNotFoundError`, as before 0.9.0.
   * - "drop": the question is answered without them. The system instruction gets one line that says
   *   how many files are no longer available, `AskResult.missing` lists them, and a
   *   "documents_missing" notice names them. With no document left, it is a plain chat: no tools.
   * - A function, given the missing IDs, that returns what to do (`MissingDocumentsAction`): "throw",
   *   "drop", `{ retry: true }` once it has ingested them again under the same IDs, or
   *   `{ replace: { [oldId]: newId } }` for the IDs it ingested them under. A retry or replace plans
   *   the question again, once: an ID still missing then fails it with `DocumentsNotFoundError`.
   *   What the function throws fails the question.
   * New in 0.9.0.
   */
  onMissingDocuments?: "throw" | "drop" | ((missing: string[], context: MissingDocumentsContext) => MissingDocumentsAction | Promise<MissingDocumentsAction>);
  limits?: AskLimits;
  /** How a model request that failed is sent again. Defaults to three more tries, with a wait that doubles. */
  retry?: RetryOptions;
  /**
   * Budget fields for this question, in place of the library's. The budget is also made to fit
   * what the adapters say of their models (`capabilities.contextTokens`, `maxRequestBytes`).
   */
  budget?: Partial<Budget>;
  /**
   * Offer `analyze_whole_document`, which reads a whole file in many model calls. Defaults to true.
   * It is offered only when the model that uses the tools (`explorer`, or else `model`) has
   * `generateText`.
   */
  wholeDocumentAnalysis?: boolean;
  /**
   * Offer `view_pages` for PDFs whose original file is kept (`keepOriginals`), so the model can
   * look at pictures, charts and layout. Defaults to true. It is offered only when every model of
   * the question can be sent a file of the same kind (`capabilities.toolFileTypes`): one small PDF,
   * or, since 0.99.9, each page drawn as an image. It changes nothing for a library that keeps no
   * originals.
   */
  viewPages?: boolean;
  /**
   * Send small visual files sent whole (a PDF with a picture or a scanned page, a slide deck) as the
   * files themselves too, before their text, when every model of the question declares
   * `capabilities.documents` and their original is kept (`keepOriginals`). Defaults to true; it
   * changes nothing unless an adapter declares `documents`. False sends text only. A value that is
   * not true or false is a `TypeError` before any request. New in 0.99.9.
   */
  nativeDocuments?: boolean;
  /** Answer text as it arrives. The adapter streams when this is set and it can (see `streamText`). */
  onText?: (delta: string) => void;
  /**
   * Whether to ask the model for the answer as it is written (the adapter's streaming request).
   * Defaults to true when `onText` is given, false otherwise; `askStream` defaults it to true. With
   * it, a reply that fails after its first piece of text is not sent again. New in 0.7.0.
   */
  streamText?: boolean;
  /** Short-lived status, such as "Searching app.log for “timeout”…". */
  onActivity?: (text: string) => void;
  /** A finished step, such as "Search app.log (exact) for “timeout” — 12 matching lines". */
  onStep?: (text: string) => void;
  /**
   * Everything the question does, as typed events in order: the plan, each model request, tool
   * call, piece of text and notice, and last `run.finish` or `run.error`. The callbacks above get
   * the same strings as before. It does not change how the model is asked: without `streamText`
   * (or `onText`), the text of a reply comes in its `text` events once the reply is in. A throw
   * from it ends the question with that error (on `run.finish`, the answer is lost: `askWithFiles`
   * throws it; on `run.error`, it replaces the question's own error). `askStream` gives the events
   * as an async iterable. New in 0.7.0.
   */
  onEvent?: (event: AskEvent) => void;
  /** The `runId` of the events. Defaults to one made for the question ("run_…"). */
  runId?: string;
  /**
   * A stable ID of this question, made by the client for the turn (such as a UUID), the same when
   * the request is sent again: 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a
   * letter or a digit (`QUESTION_ID_PATTERN`). Every event of the question and its result carry it.
   * On its own it only labels the question; `createQuestionRegistry()` runs questions by it, so that
   * a request sent again joins the question or gets its answer. Never sent to the model. Another
   * value is a `TypeError` before any request. New in 0.99.9.
   */
  questionId?: string;
  /**
   * Put each tool result in its `tool.end` event (`result`), and the tool rounds in the result that
   * `run.finish` and `run.error` carry (`toolTurns`). Off by default: results hold the text of the
   * documents, and events are often sent on to a browser.
   */
  eventResults?: boolean;
  /**
   * How `AskResult.toolTurns` holds the results of the question's tool calls. "full" (the default):
   * as the model had them. "compact": each large result replaced by the stand-in the loop sends
   * when it drops a result to make room (`compactToolTurns`), so that a stored question takes a few
   * hundred bytes a call. A later question then sends those stand-ins: the model reads again what it
   * needs, at the price of a tool call. New in 0.10.2.
   */
  storeRounds?: "full" | "compact";
  signal?: AbortSignal;
};

export type AskResult = {
  /**
   * Everything the model wrote, including any remark it made before calling a tool. With an
   * explorer model, only what the answering model wrote: the explorer's words are not shown.
   */
  text: string;
  /**
   * False when the reply that should be the answer had no text: the prompt was blocked, or the
   * reply was cut off or filtered before any text. A turn whose tool call could not be read is
   * not an answer either, even with text: the answer is asked for once more. With
   * `filteredAnswer: "drop"`, false for a filtered answer too. `text` may then be empty or hold
   * only an earlier remark, so show your own message instead of treating it as the answer
   * (`answerInfoOf` says which).
   */
  answered: boolean;
  /** Why the provider refused the prompt, when it did. */
  blockReason?: string;
  /** Every tool step taken, in order (also delivered through `onStep`). */
  steps: string[];
  /**
   * What the model was shown: first each file sent whole, in the order of its block (`tool`
   * "inline", every line, `whole: true`, no `callId`; since 0.10.0), and, right after the entry of
   * a file whose uploaded file was sent too, one with `tool` "original" and every page in `pages`
   * (no `lines`, no `whole`; since 0.99.9); then what each tool call showed, the document and the
   * lines or pages, in call order.
   */
  evidence: Evidence[];
  /**
   * The tool rounds of this question as plain JSON. Kept with the conversation and passed back in
   * `messages` between this question and its answer, they let a later question use what was
   * found here. Pages that were shown are not in them: only that they were.
   */
  toolTurns: ToolTurn[];
  /** Which documents went in whole and which were searched. */
  plan: DocumentPlan;
  /**
   * The documents of `documentIds` that were missing, and that the question was answered without
   * (`onMissingDocuments` "drop"). Absent when none was. New in 0.9.0.
   */
  missing?: string[];
  /** The budget the question ran with: the library's, fitted to the models. */
  budget: Budget;
  /** Model requests made for the chat itself, an explorer model's among them (whole-document part reads not included). */
  turns: number;
  finishReason?: string;
  /** Tokens and requests of the whole question, part reads included, in all and for each model. */
  usage: UsageTotals;
  /** The provider's own usage object of the last chat response, as it came. */
  lastUsage?: Record<string, unknown>;
  /**
   * How the reply whose text is the answer ended (`ModelReply.finish`), or the last reply of the
   * chat when none answered. Absent when the adapter does not say. A "filtered" or "cut" answer
   * also has an "answer_filtered" or "answer_cut" notice. New in 0.10.0.
   */
  finish?: ModelReply["finish"];
  /**
   * The line citations of `text`, checked against what the tools showed (`checkCitations`): a
   * document sent whole counts as shown. Set when the question had documents. New in 0.10.0.
   */
  citations?: CitationCheck;
  /**
   * `AskOptions.questionId`, when the question had one. Also in the result of `run.finish` and the
   * partial result of `run.error` (`EventResult`), and in what `partialResultOf` gives. New in
   * 0.99.9.
   */
  questionId?: string;
};

/**
 * What `AskOptions.onToolResult` is given: the call and its result, as the tool returned it (before
 * it is fitted to the room in the request), the document it names, who asks, and a signal that
 * aborts when the question is stopped or fails. New in 0.10.0.
 */
export type ToolResultContext = { call: ToolCall; result: ToolResult; documentId?: string; owner?: string; scope?: DocumentScope; signal: AbortSignal };

/**
 * What `AskOptions.onToolResult` returns: `{ result }` sends that result in place of the tool's,
 * and `{ reject }` sends `{ error: reject }`. Undefined keeps the tool's result. New in 0.10.0.
 */
export type ToolResultVerdict = { result: ToolResult } | { reject: string };

/**
 * What `AskOptions.onMissingDocuments` says to do with the documents that are missing:
 * - "throw": fail the question with `DocumentsNotFoundError`;
 * - "drop": answer it without them;
 * - `{ retry: true }`: plan it again with the same IDs, under which the documents were ingested again;
 * - `{ replace: { [oldId]: newId } }`: plan it again with each new ID in place of its old one.
 * New in 0.9.0.
 */
export type MissingDocumentsAction = "throw" | "drop" | { retry: true } | { replace: Record<string, string> };

/** What a function of `AskOptions.onMissingDocuments` is told besides the IDs: who asks, and the question's signal. New in 0.9.0. */
export type MissingDocumentsContext = { owner?: string; scope?: DocumentScope; signal?: AbortSignal };

/** The line added to the system instruction when `count` documents were left out ("drop"). */
const missingFilesLine = (count: number) => (count === 1
  ? "1 of the attached files is no longer available; say so if the question needs it."
  : `${count} of the attached files are no longer available; say so if the question needs them.`);

/** A value as an error quotes it. */
const shownValue = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : typeof value);

/** `onMissingDocuments` checked: a value it cannot be is an error before anything is planned. */
function checkMissingPolicy(given: unknown): void {
  if (given === undefined || given === "throw" || given === "drop" || typeof given === "function") return;
  throw new TypeError(`onMissingDocuments must be "throw", "drop" or a function, and is ${shownValue(given)}.`);
}

/**
 * `filteredAnswer` checked: a value it cannot be ("Drop", true) is an error before anything is
 * planned. It would otherwise keep a filtered answer that the application meant to drop.
 */
function checkFilteredAnswer(given: unknown): void {
  if (given === undefined || given === "keep" || given === "drop") return;
  throw new TypeError(`filteredAnswer must be "keep" or "drop", and is ${shownValue(given)}.`);
}

/** `storeRounds` checked: "full", "compact" or nothing (0.10.2). */
function checkStoreRounds(given: unknown): void {
  if (given === undefined || given === "full" || given === "compact") return;
  throw new TypeError(`storeRounds must be "full" or "compact", and is ${shownValue(given)}.`);
}

/** `nativeDocuments` checked: true, false or nothing (0.99.9). */
function checkNativeDocuments(given: unknown): void {
  if (given === undefined || typeof given === "boolean") return;
  throw new TypeError(`nativeDocuments must be true or false, and is ${shownValue(given)}.`);
}

/**
 * Stored tool rounds (`AskResult.toolTurns`) made small: each result that is large is replaced by
 * the stand-in the loop sends when it drops a result to make room (`stubResult`): the document, the
 * lines or pages it showed, a search's query and total, the largest groups of a count, and a note
 * that it was dropped. Errors and small results stay as they are. Copies: the turns given are not
 * changed. For rounds stored by `storeRounds: "full"`, or by an earlier version. New in 0.10.2. A
 * round of a newer version is a `TypeError`, as in `askWithFiles` (since 0.99.9).
 */
export function compactToolTurns(turns: readonly ToolTurn[]): ToolTurn[] {
  for (const turn of turns) checkToolTurnVersion(turn);
  return turns.map((turn) => ({
    ...turn,
    calls: turn.calls.map((call) => {
      const { result, ...rest } = call;
      return { ...rest, result: stubResult(rest, result) ?? result };
    }),
  }));
}

/** How a value of a removed option is shown in its TypeError: a string quoted, a boolean or a number as it is. */
const removedValue = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : typeof value === "boolean" || typeof value === "number" ? String(value) : value === null ? "null" : typeof value);

/**
 * The options 0.99.9 removed, `inlineTables` and `numberInline`, refused when a caller still passes
 * a value that would change something (JavaScript, or options spread in from another object).
 * "tools" and true, what they defaulted to, change nothing.
 */
function checkRemovedOptions(options: object): void {
  const { inlineTables, numberInline } = options as { inlineTables?: unknown; numberInline?: unknown };
  if (inlineTables !== undefined && inlineTables !== "tools") throw new TypeError(`inlineTables was removed in 0.99.9, and is ${removedValue(inlineTables)}: a table sent whole always gets the tools that count it, as "tools" did. Leave it out.`);
  if (numberInline !== undefined && numberInline !== true) throw new TypeError(`numberInline was removed in 0.99.9, and is ${removedValue(numberInline)}: the lines of files sent whole are always numbered, as true did. Leave it out.`);
}

/**
 * The evidence of a document whose uploaded file was sent before its text (since 0.99.9): every
 * page of it. No lines and no `whole`: `checkCitations` reads an entry with `whole` and no lines as
 * every line shown, and the lines are the text's, shown by the entry before it.
 */
const sentAsFile = (meta: DocumentMeta): Evidence => ({
  tool: "original",
  documentId: meta.id,
  document: meta.name,
  ...(typeof meta.pages === "number" && Number.isFinite(meta.pages) && meta.pages >= 1 ? { pages: [[1, Math.trunc(meta.pages)]] } : {}),
});

/**
 * The evidence of a document sent whole (since 0.10.0): every line of it was shown. It comes from
 * no tool call, so it has no `callId`.
 */
const sentWhole = (meta: DocumentMeta): Evidence => ({
  tool: "inline",
  documentId: meta.id,
  document: meta.name,
  ...(Number.isFinite(meta.lines) && meta.lines >= 1 ? { lines: [[1, Math.trunc(meta.lines)]] } : {}),
  whole: true,
});

/** An object made as `{}` or `Object.create(null)` is: not a Map, an array or an instance of a class. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** What a function of `onMissingDocuments` returned, checked. */
function checkedAction(action: unknown): MissingDocumentsAction {
  if (action === "throw" || action === "drop") return action;
  // Only the keys of an action: a key it does not have is a mistake, not something to ignore.
  if (action !== null && typeof action === "object" && Object.keys(action).every((key) => key === "retry" || key === "replace")) {
    const { retry, replace } = action as { retry?: unknown; replace?: unknown };
    if (retry === true && replace === undefined) return { retry: true };
    if (retry === undefined && isPlainObject(replace) && Object.values(replace).every((id) => typeof id === "string" && id.length > 0)) {
      return { replace: { ...(replace as Record<string, string>) } };
    }
  }
  throw new TypeError(`onMissingDocuments returned ${shownValue(action)}: it must return "throw", "drop", { retry: true } or { replace: { [oldId]: newId } }.`);
}

/**
 * What `onToolResult` returned, checked: undefined, `{ result }` with a result that is an object,
 * or `{ reject }` with a string. A verdict with a `result` is a result, whatever else it holds.
 * Anything else ends the question: the hook is there to keep something from the model, and a
 * mistake in it must not let the result through.
 */
function checkedVerdict(verdict: unknown): ToolResultVerdict | undefined {
  if (verdict === undefined) return undefined;
  if (verdict !== null && typeof verdict === "object") {
    if (Object.hasOwn(verdict, "result")) {
      const { result } = verdict as { result: unknown };
      if (result !== null && typeof result === "object" && !Array.isArray(result)) return { result: result as ToolResult };
    } else if (Object.hasOwn(verdict, "reject")) {
      const { reject } = verdict as { reject: unknown };
      if (typeof reject === "string") return { reject };
    }
  }
  throw new TypeError(`onToolResult returned ${shownValue(verdict)}: it must return { result }, { reject: "why" } or undefined.`);
}

/** The documents of a question once `onMissingDocuments` had its say. */
type PlannedDocuments = {
  prepared: PreparedContext;
  /** The IDs planned: those asked about, without those left out, with those replaced. */
  documentIds: string[];
  /** The IDs left out ("drop"). */
  dropped: string[];
};

/**
 * Plans the documents `ids`, and settles those that are missing as `onMissingDocuments` says. A
 * retry or a replace plans them again, once.
 */
async function planDocumentsOf(options: AskOptions, ids: string[], prepare: (ids: string[]) => Promise<PreparedContext>): Promise<PlannedDocuments> {
  const prepared = await prepare(ids);
  if (prepared.missing.length === 0) return { prepared, documentIds: ids, dropped: [] };
  const policy = options.onMissingDocuments ?? "throw";
  let action: MissingDocumentsAction = policy === "drop" ? "drop" : "throw";
  if (typeof policy === "function") {
    options.signal?.throwIfAborted();
    const context: MissingDocumentsContext = {
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    // A function that does not look at the signal does not hold the question once it is stopped.
    action = checkedAction(await until(policy([...prepared.missing], context), options.signal));
  }
  if (action === "throw") throw new DocumentsNotFoundError(prepared.missing);
  if (action === "drop") {
    const gone = new Set(prepared.missing);
    return { prepared, documentIds: ids.filter((id) => !gone.has(id)), dropped: [...prepared.missing] };
  }
  const replace = "replace" in action ? action.replace : {};
  const again = ids.map((id) => (Object.hasOwn(replace, id) ? replace[id]! : id));
  const second = await prepare(again);
  if (second.missing.length > 0) throw new DocumentsNotFoundError(second.missing);
  return { prepared: second, documentIds: again, dropped: [] };
}

/** The step of a question whose older tool results were shortened to make room. */
const RESULTS_SHORTENED = "Older tool results were shortened to make room in the request";

const DEFAULT_TOOL_TURNS = 12;
const DEFAULT_CALLS_PER_TURN = 8;
/** Tool calls of one turn that run at the same time. */
const CALLS_AT_ONCE = 4;
/** With less room than this for its result, a call is not run. */
const LEAST_ROOM_CHARACTERS = 1_500;
/**
 * Characters of a tool result for each token of room, when the call names no document of the
 * question. Since 0.10.0 a call that names one takes its document's own (`charactersPerToken`).
 */
const CHARACTERS_PER_TOKEN = 2;

/**
 * The characters of a document's text for each token of the estimate, as its ingest counted them,
 * from 0.8 to 4: about 0.9 for a table of numbers, 1.4 for a service log, 1.9 for Hebrew prose.
 * The JSON of a tool result that quotes the text comes to about the same. `CHARACTERS_PER_TOKEN`
 * when the metadata does not say. New in 0.10.0.
 */
function charactersPerToken(meta: Pick<DocumentMeta, "characters" | "estimatedTokens"> | undefined): number {
  const ratio = meta && meta.estimatedTokens > 0 ? meta.characters / meta.estimatedTokens : Number.NaN;
  return Number.isFinite(ratio) ? Math.min(4, Math.max(0.8, ratio)) : CHARACTERS_PER_TOKEN;
}

/** The tokens of room a tool result takes in a request, as the request meter counts an answer. */
const resultTokens = (result: ToolResult): number => estimateTokens(JSON.stringify(result)) + 8;

/**
 * `result` cut to `tokens` of room (`resultTokens`): by `fitAnswer`, to the characters its own
 * characters per token give, and a little less again while it is still over. Never below
 * `LEAST_RESULT_CHARACTERS`.
 */
function cutToTokens(result: ToolResult, tokens: number): ToolResult {
  const json = JSON.stringify(result);
  const perToken = json.length / Math.max(1, resultTokens(result));
  let characters = Math.max(LEAST_RESULT_CHARACTERS, Math.floor(tokens * perToken));
  let cut = fitAnswer(result, characters);
  for (let tries = 0; tries < 4 && resultTokens(cut) > tokens && characters > LEAST_RESULT_CHARACTERS; tries++) {
    characters = Math.max(LEAST_RESULT_CHARACTERS, Math.floor(characters * 0.85));
    cut = fitAnswer(result, characters);
  }
  return cut;
}

/**
 * `alreadyShown`, but never a pointer to a result that `onToolResult` replaced (`redacted: true`):
 * it does not hold what the call would return.
 */
function pointerTo(call: { name: string; args: Record<string, unknown> }, earlier: { call: { name: string; args: Record<string, unknown> }; result: ToolResult }, stored = false): ToolResult | undefined {
  return earlier.result.redacted === true ? undefined : alreadyShown(call, earlier, stored);
}
/** Bytes a character of a tool result may take in the request. */
const BYTES_PER_CHARACTER = 3;
/** Tool rounds whose results are kept in full when older ones are dropped to make room. */
const ROUNDS_KEPT = [3, 2, 1];

const NO_ROOM = "Not run: there is no room left in this conversation for another tool result. Answer now, from what the tools returned so far.";
/** How the error of a whole-file read that sent its parts, and could read none of them, begins (`NothingReadError`). */
const NOTHING_READ = "Could not read any part of ";
/** The answer to a call of a tool the question does not have: it is not run, and takes no room. New in 0.10.0. */
const unknownTool = (name: string, tools: string[]) => `Unknown tool ${unknownToolName(name)}. The tools are: ${tools.join(", ")}.`;
/** Why a request of a whole-file read that its read left behind ended with its call. */
const CALL_ENDED = "The tool call ended before this request did.";

type Size = { tokens: number; bytes: number };

const count = (value: number) => Math.max(0, Math.round(value)).toLocaleString("en-US");
/** How many of a model's tokens one token of the library's estimate comes to. */
const scaleOf = (adapter: ModelAdapter): number => (adapter.capabilities.tokenScale && adapter.capabilities.tokenScale > 0 ? adapter.capabilities.tokenScale : 1);
/** What a page costs when a model does not say: the OpenAI adapter's default. */
const DEFAULT_PAGE_TOKENS = 1_000;
/**
 * What a page costs a model, in its tokens: its `pageTokens`, or `DEFAULT_PAGE_TOKENS` when that is
 * missing or not a finite number (an adapter written in JavaScript). NaN took away the page limit
 * of the question and every count of the room left once a page was shown.
 */
const pageTokensOf = (adapter: ModelAdapter): number => {
  const declared: unknown = adapter.capabilities.pageTokens;
  return typeof declared === "number" && Number.isFinite(declared) && declared >= 0 ? declared : DEFAULT_PAGE_TOKENS;
};
const isRound = (message: ModelMessage): message is ModelToolRound => message.role === "tools";
/** The kinds of file the loop knows a tool may hand a model (`ModelCapabilities.toolFileTypes`). */
const TOOL_FILE_TYPES: readonly ToolFileType[] = ["application/pdf", "image/png", "image/jpeg"];
/**
 * The kinds of file a model takes from a tool: none without `toolFiles` "inside" or "beside"
 * (a value the type does not have counts as "none"); ["application/pdf"] when it says no more, as
 * before 0.99.9.
 */
const toolFileTypesOf = (adapter: ModelAdapter): ToolFileType[] => {
  const { toolFiles, toolFileTypes } = adapter.capabilities as { toolFiles?: unknown; toolFileTypes?: unknown };
  if (toolFiles !== "inside" && toolFiles !== "beside") return [];
  if (!Array.isArray(toolFileTypes)) return ["application/pdf"];
  return toolFileTypes.filter((type): type is ToolFileType => TOOL_FILE_TYPES.includes(type as ToolFileType));
};
/** The bytes a file takes in a request: base64, and what frames it. */
const fileBytes = (file: ToolFile): number => Math.ceil(file.bytes.length / 3) * 4 + 512;

/** How many pages a `view_pages` result showed: its `pages` is "12" or "12-14". */
function pagesShown(result: ToolResult): number {
  const [first, last] = String(result.pages ?? "").split("-").map(Number);
  return Number.isFinite(first) ? (Number.isFinite(last) ? last! - first! + 1 : 1) : 0;
}

/**
 * A result of a tool round of an earlier question, as it is sent again: without its
 * `tool_turns_left`, which counted the turns of that question, not of this one, and with no half of a
 * character in it (0.5.0 cut some search windows inside an emoji, and Claude's API refuses them).
 */
const carriedResult = (result: ToolResult): ToolResult => wellFormedJson(laterResult(result));

/**
 * The conversation as the loop keeps it: copies, so that nothing of the caller's is changed. Of a
 * stored tool round, only the calls are kept: its version is not sent to the model.
 */
function toMessages(given: ChatMessage[]): ModelMessage[] {
  const messages = given.map((message): ModelMessage => {
    if (message.role === "tools") {
      checkToolTurnVersion(message);
      const answers = message.calls.map(({ result, ...call }) => ({ call, result: carriedResult(result) }));
      return { role: "tools", calls: answers.map((answer) => answer.call), answers };
    }
    const role = message.role === "user" ? "user" : "assistant";
    if (!("parts" in message)) return { role, parts: [{ text: message.text }] };
    // Files the application put in a turn go on as they are (0.99.9); a turn without has no key.
    return { role, parts: [...message.parts], ...(message.files?.length ? { files: [...message.files] } : {}) };
  });
  if (messages.at(-1)?.role !== "user") throw new Error("The last message must be the user's.");
  return messages;
}

/** The size of the turns of text, and of the system instruction, with a margin for what frames them. */
function textSize(messages: ModelMessage[], system: string | undefined): Size {
  let tokens = estimateTokens(system ?? "") + 2_000;
  let bytes = jsonBytes(system ?? "") + 8_000;
  for (const message of messages) {
    if (isRound(message)) continue;
    for (const part of message.parts) {
      if (typeof part.text === "string") {
        tokens += estimateTokens(part.text);
        // A part in the provider's own form is sent whole: its text, and what is next to it (a
        // thought signature), or the call that the text stands for.
        bytes += part.native === undefined ? jsonBytes(part.text) : Math.max(jsonBytes(part.text), (JSON.stringify(part.native) ?? "").length);
      } else {
        const size = (JSON.stringify(part.native) ?? "").length;
        bytes += size;
        // Media: about 258 tokens per image or PDF page; ~4 tokens/KB is a cautious stand-in.
        tokens += Math.ceil(size / 256);
      }
    }
    // Files of the turn (0.99.9): their base64, and the same stand-in for their tokens.
    for (const file of message.files ?? []) {
      const size = Math.ceil(file.bytes.length / 3) * 4;
      bytes += size + 512;
      tokens += Math.ceil(size / 256);
    }
  }
  return { tokens, bytes };
}

/** Keeps count of how large the request is, in the library's estimate of tokens and in bytes. */
class RequestMeter {
  /** Everything that does not change during the question: the conversation as asked, the documents, the tool list. */
  fixed: Size = { tokens: 0, bytes: 0 };
  private readonly sizes = new WeakMap<ModelToolRound, Size>();
  /** How much larger the provider counted the last request than the estimate did. Never below 1. */
  private factor = 1;
  /** The least `factor` may be for the rest of the question: what a request refused as too large showed. */
  private floor = 1;

  constructor(private readonly pageTokens: number) {}

  private round(round: ModelToolRound): Size {
    const known = this.sizes.get(round);
    if (known) return known;
    let tokens = 0;
    let bytes = round.raw === undefined ? 0 : (JSON.stringify(round.raw) ?? "").length;
    for (const call of round.calls) {
      const sent = `${call.name}${JSON.stringify(call.args)}`;
      tokens += estimateTokens(sent) + 8;
      if (round.raw === undefined) bytes += Buffer.byteLength(sent) + 64;
    }
    for (const answer of round.answers) {
      const sent = JSON.stringify(answer.result);
      tokens += estimateTokens(sent) + 8;
      bytes += Buffer.byteLength(sent) + 96;
      for (const file of answer.files ?? []) bytes += Math.ceil(file.bytes.length / 3) * 4 + 512;
      if (answer.files?.length) tokens += pagesShown(answer.result) * this.pageTokens;
    }
    const size = { tokens, bytes };
    this.sizes.set(round, size);
    return size;
  }

  /** The size of the tool rounds among these messages. */
  rounds(messages: ModelMessage[]): Size {
    const sum = { tokens: 0, bytes: 0 };
    for (const message of messages) {
      if (!isRound(message)) continue;
      const size = this.round(message);
      sum.tokens += size.tokens;
      sum.bytes += size.bytes;
    }
    return sum;
  }

  /** The estimate for a request with these messages, as it is. */
  estimate(messages: ModelMessage[]): Size {
    const rounds = this.rounds(messages);
    return { tokens: this.fixed.tokens + rounds.tokens, bytes: this.fixed.bytes + rounds.bytes };
  }

  /** The same, raised by what the provider's own count of an earlier request showed. */
  current(messages: ModelMessage[]): Size {
    const size = this.estimate(messages);
    return { tokens: Math.ceil(size.tokens * this.factor), bytes: size.bytes };
  }

  /**
   * Takes note of what the provider counted for a request that was estimated at `estimated` tokens.
   * A report raises the estimate up to twice; it never lowers it below what a refusal showed.
   */
  observe(estimated: number, counted: number | undefined): void {
    if (estimated > 0 && typeof counted === "number" && counted > 0) this.factor = Math.max(this.floor, Math.min(2, Math.max(1, counted / estimated)));
  }

  /**
   * Takes note of a request the provider refused as too large: it counted `counted` tokens (in the
   * library's tokens by the model's scale) of one estimated at `estimated`, or, when it did not say,
   * a quarter more than the estimate. Unlike `observe`, nothing caps it at twice the estimate: the
   * refusal is the provider's word that the estimate was too low, and it holds for the rest of the
   * question: a later report does not take it back.
   */
  overflowed(estimated: number, counted: number | undefined): void {
    const ratio = estimated > 0 && typeof counted === "number" && counted > 0 ? counted / estimated : this.factor * 1.25;
    this.factor = Math.min(8, Math.max(this.factor, ratio));
    this.floor = this.factor;
  }
}

/**
 * Shares `room` among tool calls whose results may be up to `caps` characters. A character of the
 * result of call i takes `rates[i]` of the room (1 when `rates` is left out: the room is in
 * characters; since 0.10.0 the loop gives it in tokens, and each call the tokens a character of its
 * document takes). A call gets no more than its cap, and the others split what it leaves. Calls
 * that cannot each get `LEAST_ROOM_CHARACTERS` (or their cap, when it is smaller) are not run, the
 * last ones first: their share is undefined. The shares are in characters.
 */
export function shareRoom(caps: number[], room: number, rates?: number[]): Array<number | undefined> {
  const rate = (index: number) => rates?.[index] ?? 1;
  const least = (cap: number, index: number) => Math.min(cap, LEAST_ROOM_CHARACTERS) * rate(index);
  let count = caps.length;
  let needed = caps.reduce((sum, cap, index) => sum + least(cap, index), 0);
  while (count > 0 && needed > room) {
    count--;
    needed -= least(caps[count]!, count);
  }
  const shares: Array<number | undefined> = caps.map(() => undefined);
  // The smallest caps first: each call takes its cap or an even share of what is left, whichever is less.
  const order = caps.slice(0, count).map((cap, index) => ({ cap: cap * rate(index), index })).sort((left, right) => left.cap - right.cap);
  let left = Math.max(0, Math.floor(room));
  order.forEach(({ cap, index }, position) => {
    const share = Math.min(cap, Math.floor(left / (order.length - position)));
    // A call given its whole cap gets the cap as it is, not as it comes back from the rate.
    shares[index] = share === cap ? caps[index]! : Math.floor(share / rate(index));
    left -= share;
  });
  return shares;
}

function retryMessage({ error, delayMs }: RetryNotice): string {
  const status = statusOf(error);
  const seconds = delayMs >= 1_000 ? ` in ${Math.round(delayMs / 1_000)} s` : "";
  const what = errorKindOf(error) === "timeout" && status === 0 ? "The model sent nothing for too long"
    // The model was reached, and its reply began to arrive.
    : isCutReply(error) ? "The model's reply was cut off on its way"
    : status ? `The model did not answer (HTTP ${status})` : "The model could not be reached";
  return `${what}. Trying again${seconds}…`;
}

/**
 * What the question had found when it failed, by the error it threw: see `partialResultOf`. With
 * the question it came from, and no result once a second question threw the same error.
 */
const partialResults = new WeakMap<object, { owner: RunState; result: AskResult | undefined }>();

/**
 * Keeps what the question run with `owner` had done when it threw `error`. The same error can be
 * thrown by several questions: the reason of a signal they share (`AbortSignal.any` passes the
 * reason on as it is). Then `partialResultOf` gives none of them a result for it, rather than one
 * question's tool rounds and usage for another's. The question's own `run.error` still has its own.
 */
function keepPartial(error: unknown, owner: RunState, result: AskResult): void {
  if (error === null || typeof error !== "object") return;
  owner.failed = { error, result };
  const kept = partialResults.get(error);
  const shared = kept !== undefined && (kept.owner !== owner || kept.result === undefined);
  partialResults.set(error, { owner, result: shared ? undefined : result });
}

/**
 * What a question that failed had done before it failed: its tool steps, evidence, tool rounds and
 * usage, with `answered: false`. `askWithFiles` throws the provider's error as it came (a
 * `ModelRequestError` that was not worth sending again, or still failed after the retries); this
 * gives what was found and paid for until then, so that an application can keep the tool rounds
 * with the conversation and count the usage. Undefined for an error that did not come from a
 * question under way (a document that is missing, a budget that does not work).
 */
export function partialResultOf(error: unknown): AskResult | undefined {
  return error !== null && typeof error === "object" ? partialResults.get(error)?.result : undefined;
}

/**
 * What a question that is planned again carries over from its first try: what it paid for and the
 * steps it showed, so that the totals, the ceilings of `limits` and the steps of the result count
 * them, and the window the documents are planned for now.
 */
type Carried = {
  usage: UsageMeter;
  steps: string[];
  turns: number;
  /** Chat requests of the first try that were answered: each took a tool turn of the question. */
  answered: number;
  nudges: number;
  recoveries: number;
  contextTokens: number;
  step: string;
  /** The documents the first try planned, once `onMissingDocuments` had its say, and those it left out. */
  documentIds: string[];
  missing: string[];
};

/**
 * Thrown inside a question whose first requests were too large for the model before any tool ran,
 * when nothing can be shortened: the documents are planned again for a smaller window. Never
 * leaves `askWithFiles`.
 */
class Replan extends Error {
  constructor(readonly carried: Carried, readonly overflow: unknown, readonly partial: AskResult) {
    super("replan");
  }
}

/** Sent, once, after a tool turn whose call could not be read. Not kept in the conversation. */
const MALFORMED_CALL_NUDGE = "Your last reply tried to call a tool, but the call could not be read. Call the tools again, with arguments that match their declarations, or answer if you already have enough.";
const MALFORMED_EXPLORER_NUDGE = "Your last reply tried to call a tool, but the call could not be read. Call the tools again, with arguments that match their declarations, or reply DONE if the results above already hold what the answer needs.";
/** Sent, once, after a first reply that was empty. Not kept in the conversation. */
const EMPTY_REPLY_NUDGE = "Your last reply was empty. Use the tools to read the files the question is about, or answer the question.";
const EMPTY_EXPLORER_NUDGE = "Your last reply was empty. Call the tools to gather what the answer needs from the files, then reply DONE.";
/**
 * Sent, once, after a reply to the answer's request that had no text: it was empty, or held a tool
 * call that the model was told not to make. Not kept in the conversation.
 */
const ANSWER_AGAIN_NOTE = "Your last reply had no text. No tool can be called in this reply: write the answer now, in text, from what is above.";
/** The most such second tries in one question, the answer's included. */
const MOST_NUDGES = 2;
/** The most requests sent again, smaller, after the provider refused one as too large. */
const MOST_OVERFLOW_RECOVERIES = 2;

/**
 * The limits of a question, checked. A field that is NaN (`Number(process.env.X)` of a variable
 * that is not set) or not a number is an error, as a budget field is: NaN fails every comparison,
 * so it turned off the ceilings and the cap on whole-file reads, or every tool.
 */
function checkedLimits(given: AskLimits | undefined): AskLimits {
  for (const field of ["toolTurns", "callsPerTurn", "wholeDocumentReads", "inputTokens", "requests", "wholeReadsPerQuestion"] as const) {
    const value: unknown = given?.[field];
    if (value === undefined) continue;
    if (typeof value !== "number") throw new TypeError(`limits.${field} must be a number, and is ${typeof value === "string" ? JSON.stringify(value) : typeof value}.`);
    if (Number.isNaN(value)) throw new RangeError(`limits.${field} must be a number, and is NaN. Leave it out for the default.`);
  }
  return given ?? {};
}

/** Said, once, when a ceiling of `limits` stops the tools. */
const BUDGET_REACHED = "No more tools: the question reached its limit of input tokens or requests.";

/**
 * What the tries of one question share for its events: where they go, and the counters of the ids
 * of its requests and tool calls, which a question planned again goes on counting.
 */
type RunState = {
  events: EventEmitter<AskEvent>;
  requests: number;
  calls: number;
  /** True once "budget_reached" was said. */
  budgetSaid: boolean;
  /** The error the question failed with, and what it had done: for its own `run.error`. */
  failed?: { error: unknown; result: AskResult };
};

/** A document as an event names it. */
const documentRef = (meta: DocumentMeta): DocumentRef => ({
  id: meta.id,
  name: meta.name,
  format: meta.format,
  estimatedTokens: meta.estimatedTokens,
  ...(meta.pages !== undefined ? { pages: meta.pages } : {}),
});

/** Which model a chat request goes to, and why. */
type RequestKind = { role: RequestRole; purpose: RequestPurpose };

/**
 * Answers a chat turn about large documents with any model that has an adapter.
 * Documents that fit go into the prompt whole; otherwise the model gets search and read tools and
 * this runs the tool loop, ending with a request that must be answered in text, so there is always
 * an answer. With an `explorer`, that model runs the tool loop and `model` writes the answer.
 */
export async function askWithFiles(options: AskOptions): Promise<AskResult> {
  // An ID that is not one stamps nothing: the question ends with its TypeError, after run.start.
  const questionId = validQuestionId(options.questionId);
  const events = new EventEmitter<AskEvent>(options.runId ?? newRunId(), options.onEvent, questionId);
  const state: RunState = { events, requests: 0, calls: 0, budgetSaid: false };
  try {
    if (events.active) {
      // Always first, whatever the options hold: they are checked after it, and a question whose
      // options do not work ends with run.error like any other.
      const { model, explorer, documentIds } = options as Partial<AskOptions>;
      const other = explorer && explorer !== model ? explorer : undefined;
      events.emit({
        type: "run.start",
        models: { answer: model?.id ?? "", ...(other ? { explorer: other.id } : {}) },
        documentIds: Array.isArray(documentIds) ? [...documentIds] : [],
      });
    }
    const result = await askPlanned(options, state);
    if (questionId !== undefined) result.questionId = questionId;
    if (events.active) events.emit({ type: "run.finish", result: eventResultOf(result, options.eventResults === true) });
    return result;
  } catch (error) {
    // The question's own partial result, for `partialResultOf` too: never another question's.
    const own = state.failed && state.failed.error === error ? state.failed.result : undefined;
    if (own && questionId !== undefined) own.questionId = questionId;
    if (events.active) {
      // The question's own, also when another question threw the same error (a shared signal's reason).
      const partial = own ?? partialResultOf(error);
      events.emit({ type: "run.error", error: eventErrorOf(error), ...(partial ? { partial: eventResultOf(partial, options.eventResults === true) } : {}) });
    }
    throw error;
  }
}

/**
 * A result as `run.finish` and `run.error` carry it: a copy, so that a listener cannot change the
 * caller's, without the tool rounds and with the plan naming documents only (both hold text of
 * the documents: tool results, outline headings, the commonest lines of a log) unless `withTurns`.
 * Its plan never holds the owner, scope, SHA-256 or original of a document.
 */
function eventResultOf(result: AskResult, withTurns: boolean): EventResult {
  const { toolTurns, plan, ...rest } = result;
  // The full metadata only with `withTurns`, and never what is to stay on the server: who owns a
  // document, its scope, the SHA-256 and the ref of its original.
  if (withTurns) return { ...rest, toolTurns, plan: { inline: plan.inline.map(withoutServerFields), searchable: plan.searchable.map(withoutServerFields) } };
  return { ...rest, plan: { inline: plan.inline.map(documentRef), searchable: plan.searchable.map(documentRef) } };
}

/** A document's metadata without what is to stay on the server, for an event (since 0.10.0). */
function withoutServerFields(meta: DocumentMeta): Omit<DocumentMeta, "owner" | "scope" | "sha256" | "original" | "metaVersion"> {
  const { owner: _owner, scope: _scope, sha256: _sha256, original: _original, metaVersion: _metaVersion, ...rest } = meta;
  return rest;
}

/**
 * `askWithFiles` as a stream of its events, for a page that shows the question as it goes: see
 * `AskEvent`. Leaving the loop early (`break`) stops the question. `result` is what `askWithFiles`
 * returns. `onEvent`, when given, gets each event too, after the stream. The model is asked for
 * the answer as it is written unless `streamText` is false. `questionId` labels every event and
 * the result, as in `askWithFiles`: `createQuestionRegistry().askStream` runs a stream by it.
 * New in 0.7.0.
 */
export function askStream(options: AskOptions): EventStream<AskEvent, AskResult> {
  return eventStream<AskEvent, AskResult>((onEvent, signal) => askWithFiles({
    ...options,
    // A page that reads the events shows the text as it is written, unless told not to.
    streamText: options.streamText !== false,
    signal,
    onEvent: (event) => {
      // The stream first: a throw of the caller's listener cannot keep an event, the last one
      // included, from the stream.
      onEvent(event);
      options.onEvent?.(event);
    },
  }), { signal: options.signal });
}

/** The question, planned again once when its first requests were too large for the model. */
async function askPlanned(options: AskOptions, state: RunState): Promise<AskResult> {
  try {
    return await ask(options, undefined, state);
  } catch (error) {
    if (!(error instanceof Replan)) throw error;
    // The first requests were too large for the model, and nothing in them could be shortened: the
    // documents are planned again for the window the provider named, or a smaller one. Once. The
    // window is a limit of the model's, as one it declares: the application's budget is fitted to it.
    try {
      return await ask(options, error.carried, state);
    } catch (again) {
      // Failed before it sent anything (a budget of the application's that cannot work with the
      // smaller window): the provider's error, with what the first try found, is the one to report.
      // (The question's own record: `partialResultOf` gives nothing for an error another question threw too.)
      // (A store that failed, or a document gone, has a status since 0.9.0, but is not the model's.)
      const fromModel = (again as { status?: unknown } | null)?.status !== undefined && !DocumentStoreError.is(again) && !DocumentsNotFoundError.is(again);
      if (state.failed?.error !== again && !fromModel) {
        keepPartial(error.overflow, state, error.partial);
        throw error.overflow;
      }
      throw again;
    }
  }
}

async function ask(options: AskOptions, carried: Carried | undefined, state: RunState): Promise<AskResult> {
  const { files, model, signal } = options;
  const { events } = state;
  // A second model for the requests that use tools. The answering model itself is not one. It
  // explores only when a file is searched (see `explorer` below), but the budget is fitted to it.
  const given = options.explorer && options.explorer !== model ? options.explorer : undefined;
  const models = given ? [model, given] : [model];
  const limits = checkedLimits(options.limits);
  checkMissingPolicy(options.onMissingDocuments);
  checkQuestionId(options.questionId);
  checkFilteredAnswer(options.filteredAnswer);
  checkStoreRounds(options.storeRounds);
  checkRemovedOptions(options);
  checkNativeDocuments(options.nativeDocuments);
  // A question planned again goes on counting what its first try paid for.
  const usage = carried?.usage ?? new UsageMeter();

  // The budget is counted in the library's estimate of tokens. A model whose tokenizer counts
  // more of them for the same text has, in those terms, a smaller window.
  const scale = Math.max(...models.map(scaleOf));
  const declared = (pick: (adapter: ModelAdapter) => number | undefined): number[] => models.map(pick).filter((value): value is number => typeof value === "number" && value > 0);
  const own = files.budgetFor(options.budget);
  // The window in the models' own tokens, and in the library's.
  const modelWindow = Math.min(own.contextTokens, carried?.contextTokens ?? Number.POSITIVE_INFINITY, ...declared((adapter) => adapter.capabilities.contextTokens));
  const windowTokens = Math.floor(modelWindow / scale);
  // A reply that is counted against the window: that part of it is not there for the prompt.
  const replyTokens = Math.ceil(Math.max(0, ...declared((adapter) => adapter.capabilities.outputTokens)) / scale);
  const requestBytesLimit = declared((adapter) => adapter.capabilities.maxRequestBytes);
  const budget = files.budgetFor(options.budget, {
    contextTokens: Math.max(Math.floor(windowTokens / 4), windowTokens - replyTokens),
    ...(requestBytesLimit.length > 0 ? { maxRequestBytes: Math.min(...requestBytesLimit) } : {}),
  });
  // What a page costs, in the same terms. Pages are shown to every model of the question.
  const pageTokens = Math.max(1, ...models.map(pageTokensOf)) / scale;
  // The kind of file every model takes from a tool (`toolFileTypes`, since 0.99.9): one small PDF;
  // else each page drawn as an image, a JPEG (smaller), else a PNG; else none, and no `view_pages`.
  const takes = (type: ToolFileType) => models.every((adapter) => toolFileTypesOf(adapter).includes(type));
  const pageFormat = takes("application/pdf") ? "pdf" : takes("image/jpeg") ? "jpeg" : takes("image/png") ? "png" : undefined;
  const canShowFiles = pageFormat !== undefined;
  const pageImages: PageImageOptions | undefined = pageFormat === "jpeg" || pageFormat === "png" ? { format: pageFormat } : undefined;
  // The uploaded files every model reads as they are (`documents`, since 0.99.9): none unless all declare it.
  const sharedNative = options.nativeDocuments !== false ? sharedDocuments(models) : undefined;
  // Every model must be able to take a conversation whose earlier turns were made shorter.
  const canShrink = models.every((adapter) => !adapter.capabilities.appendOnly);
  // A call made again is answered with a pointer to its earlier result only while that result stays
  // in the conversation: a provider that clears old tool results on its side may have removed it.
  const canPoint = models.every((adapter) => !adapter.capabilities.clearsToolResults);

  const messages = toMessages(options.messages);
  const meter = new RequestMeter(pageTokens);
  const asText = textSize(messages, options.system);
  const earlier = meter.rounds(messages);
  // Who asks: the documents are looked up, and every tool call reads them, for this owner and
  // scope. The question's signal goes with them, for a library that ends its waits for the store
  // with it (`AccessOptions.signal`).
  const access = {
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(signal ? { signal } : {}),
  };
  // Documents that are missing are settled as `onMissingDocuments` says. A question planned again
  // starts from the documents its first try planned: the function is not asked again about them.
  // The question stops when its signal aborts, whether the library does or not: a store call that
  // hangs (a network volume that does not answer) must not hold it, with any `LargeFiles`.
  const planned = await planDocumentsOf(options, carried?.documentIds ?? options.documentIds, (ids) => until(files.prepare(ids, { tokens: asText.tokens + earlier.tokens, bytes: asText.bytes + earlier.bytes }, {
    ...access,
    viewPages: options.viewPages !== false && canShowFiles,
    // The guide and the cards name `analyze_whole_document` only when the tools will have it.
    wholeDocumentAnalysis: options.wholeDocumentAnalysis !== false && typeof (given ?? model).generateText === "function",
    budget,
    // Since 0.99.9 always: tables sent whole get the tools, and files sent whole are numbered. A
    // `prepare` of your own may leave the options aside, as 0.9's did.
    numberInline: true,
    inlineTables: "tools",
    // Only when every model reads files as they are: otherwise the options of 0.10.2, as they were.
    ...(sharedNative ? { nativeDocuments: { ...sharedNative, pageTokens } } : {}),
  }), signal));
  const { prepared, documentIds } = planned;
  /** The documents left out of the question ("drop"), by this try and by the first. */
  const missing = [...carried?.missing ?? [], ...planned.dropped];
  // Tools are needed for a file that is too large to send whole, for a PDF whose pages can be
  // looked at (that one may have its whole text in the prompt and still hide a chart from the
  // model), and for a table sent whole whose rows they can count. A library of your own whose
  // `prepare` gives no `toolable` has none of the last.
  const { searchable } = prepared.plan;
  const { viewable } = prepared;
  const toolable = prepared.toolable ?? [];
  // The explorer gathers what the answer needs from the files searched with the tools. When none
  // is, and the tools are there for tables sent whole, the answering model runs the loop itself: a
  // question that needs no count is then answered in its first request, and the whole files are
  // not sent to two models that share no cache.
  const explorer = given && !(searchable.length === 0 && toolable.length > 0) ? given : undefined;
  const toolModel = explorer ?? model;
  // The lines of the files sent whole are numbered by a library whose `prepare` is that of this
  // package (its result has the mark, `preparedHere`); one of your own of 0.9 sends them as they
  // are, with no citation line.
  const numbered = preparedHere(prepared);

  // The small visual files that go as they are (0.99.9), in plan order: each one whose original is
  // still the file that was ingested. One that is gone or changed is sent as text only, as
  // `view_pages` would fail on it too. A store that fails fails the question, as it does elsewhere.
  const sentFiles: Array<{ meta: DocumentMeta; file: ToolFile }> = [];
  if (sharedNative && typeof files.getOriginal === "function") {
    const asked = new Set(documentIds);
    const inline = new Set(prepared.plan.inline.map((meta) => meta.id));
    for (const meta of prepared.native ?? []) {
      // A `prepare` of your own may list what is not sent whole: only a file whose text is here goes.
      if (!asked.has(meta.id) || !inline.has(meta.id) || !prepared.blocks.has(meta.id) || sentFiles.some((sent) => sent.meta.id === meta.id)) continue;
      const bytes = await until(files.getOriginal(meta.id, access), signal);
      if (bytes) sentFiles.push({ meta, file: nativeFile(meta, bytes, sentFiles.length + 1) });
    }
  }
  const filesLine = sentFiles.length > 0 ? nativeFilesLine(sentFiles.map((sent) => sent.meta.name)) : "";

  const blocks = [...new Set(documentIds)].map((id) => prepared.blocks.get(id)).filter((block): block is string => Boolean(block));
  if (blocks.length) {
    const block = { text: blocks.join("\n\n") };
    // The last turn is the user's, so there is always a first user turn.
    const turn = (options.documentPlacement === "last" ? messages.at(-1) : messages.find((message) => message.role === "user")) as ModelTextMessage;
    if (options.documentPlacement === "last") turn.parts.push(block);
    else turn.parts.unshift(block);
    // The files themselves come first in that turn, and the line that names them just before the text.
    if (filesLine) {
      turn.parts.splice(turn.parts.indexOf(block), 0, { text: filesLine });
      turn.files = [...sentFiles.map((sent) => sent.file), ...turn.files ?? []];
    }
  }
  // A question without some of its files says so to the model, in one line of its own.
  const missingLine = missing.length > 0 ? missingFilesLine(missing.length) : "";
  // The fixed lines for the files sent whole (since 0.10.0): that their tables can still be counted
  // with the tools, and, when no file is searched, to cite their numbered lines.
  const inlineLine = inlineInstruction(prepared, numbered);
  const system = [options.system?.trim(), prepared.instruction, inlineLine, missingLine].filter(Boolean).join("\n\n");

  // The size of what stays in every request: the text as asked, the documents, the tool guide.
  const whole = new Set(prepared.plan.inline.map((meta) => meta.id));
  meter.fixed = {
    tokens: asText.tokens + prepared.plan.inlineTokens + estimateTokens(prepared.instruction) + (inlineLine ? estimateTokens(inlineLine) : 0) + (missingLine ? estimateTokens(missingLine) : 0),
    bytes: asText.bytes + prepared.plan.inlineBytes + jsonBytes(prepared.instruction) + (inlineLine ? jsonBytes(inlineLine) : 0) + (missingLine ? jsonBytes(missingLine) : 0),
  };
  for (const [id, block] of prepared.blocks) {
    if (whole.has(id)) continue;
    meter.fixed.tokens += estimateTokens(block);
    meter.fixed.bytes += jsonBytes(block);
  }
  // The files sent as they are: each of their pages, as a page of `view_pages` is counted, and their base64.
  if (filesLine) {
    meter.fixed.tokens += sentFiles.reduce((sum, sent) => sum + (sent.meta.pages ?? 0) * pageTokens, 0) + estimateTokens(filesLine);
    meter.fixed.bytes += sentFiles.reduce((sum, sent) => sum + fileBytes(sent.file), 0) + jsonBytes(filesLine);
  }

  let text = "";
  let turns = carried?.turns ?? 0;
  /** The last reply of the chat: its `finish` is the answer's (`AskResult.finish`). */
  let lastReply: ModelReply | undefined;
  const dropFiltered = options.filteredAnswer === "drop";
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  let lastUsage: Record<string, unknown> | undefined;
  const steps: string[] = [];
  // The files sent whole come first, in the order of their blocks: the model was shown every line
  // of them before any tool ran (since 0.10.0).
  const inlineById = new Map(prepared.plan.inline.map((meta) => [meta.id, meta]));
  const sentById = new Set(sentFiles.map((sent) => sent.meta.id));
  const evidence: Evidence[] = [...new Set(documentIds)].flatMap((id) => {
    const meta = inlineById.get(id);
    return meta ? [sentWhole(meta), ...(sentById.has(id) ? [sentAsFile(meta)] : [])] : [];
  });
  const emit = (delta: string, requestId: string) => {
    text += delta;
    options.onText?.(delta);
    events.emit({ type: "text", requestId, delta });
  };
  /**
   * A step can quote what the model sent: it is made one line of plain text before anyone sees it.
   * A step that is not a tool call's is also a notice, with that code. Returns the line.
   */
  const step = (line: string, code?: NoticeCode): string => {
    const plain = stepLine(line);
    steps.push(plain);
    options.onStep?.(plain);
    if (code) events.emit({ type: "notice", code, message: plain, display: "step" });
    return plain;
  };
  /** Short-lived status that is also a notice. */
  const activity = (code: NoticeCode, message: string) => {
    options.onActivity?.(message);
    events.emit({ type: "notice", code, message, display: "activity" });
  };
  /** A notice that earlier versions did not show. */
  const notice = (code: NoticeCode, message: string, documentIds?: string[]) => events.emit({ type: "notice", code, message, display: "none", ...(documentIds ? { documentIds } : {}) });
  const budgetReached = () => {
    if (state.budgetSaid) return;
    state.budgetSaid = true;
    notice("budget_reached", BUDGET_REACHED);
  };
  // What a first try that was planned again showed is part of this question; then why it was planned again.
  steps.push(...carried?.steps ?? []);
  if (carried) step(carried.step, "replanned");
  if (planned.dropped.length > 0) {
    const count = planned.dropped.length;
    notice("documents_missing", `${count === 1 ? "1 of the attached files is" : `${count} of the attached files are`} no longer available: the question is answered without ${count === 1 ? "it" : "them"}.`, [...planned.dropped]);
  }
  if (events.active) events.emit({ type: "plan", inline: prepared.plan.inline.map(documentRef), searchable: prepared.plan.searchable.map(documentRef) });

  // A model turn in its provider's own form goes back only to the adapter it came from. Any other
  // model gets the tool calls alone: a thought signature belongs to the model that wrote it, and
  // an explorer's thoughts and remarks are not what the files say.
  const rawOwner = new WeakMap<ModelToolRound, ModelAdapter>();
  const plain = new WeakMap<ModelToolRound, ModelToolRound>();
  const callsOnly = (round: ModelToolRound): ModelToolRound => {
    let known = plain.get(round);
    if (!known) {
      known = { role: "tools", calls: round.calls, answers: round.answers };
      plain.set(round, known);
    }
    return known;
  };
  /**
   * Turns that hold a note for the model that explores, kept in the conversation because that model
   * may not have it rewritten (see `notedMessages`), with the turn as it was before the note, or
   * undefined for a turn that is only the note. The other model never gets them.
   */
  const notes = new Map<ModelMessage, ModelMessage | undefined>();
  const viewFor = (adapter: ModelAdapter, list: ModelMessage[] = messages): ModelMessage[] => list.flatMap((message): ModelMessage[] => {
    if (adapter !== toolModel && notes.has(message)) {
      const before = notes.get(message);
      return before ? [before] : [];
    }
    return [isRound(message) && message.raw !== undefined && rawOwner.get(message) !== adapter ? callsOnly(message) : message];
  });

  /**
   * One model request of the chat. Text is passed on as it arrives when it is `shown`: an
   * explorer's words are not, because the answer comes from the other model. A request that
   * failed is sent again by the rule of `retry`, unless text of it was already shown.
   */
  /** Chat requests of the question that were answered, those of a first try included: each took a tool turn. */
  let answeredRequests = carried?.answered ?? 0;
  const streamText = options.streamText ?? options.onText !== undefined;
  const request = async (adapter: ModelAdapter, body: ModelRequest, shown: boolean, kind: RequestKind): Promise<ModelReply> => {
    turns++;
    const requestId = `req_${++state.requests}`;
    const began = Date.now();
    let separated = text.length === 0;
    let got = "";
    const write = (delta: string) => {
      // Nothing more is shown once the question was stopped, by an adapter that goes on regardless.
      if (!delta || signal?.aborted) return;
      if (!separated) {
        emit("\n\n", requestId);
        separated = true;
      }
      got += delta;
      emit(delta, requestId);
    };
    const estimated = meter.estimate(body.messages).tokens;
    let reply: ModelReply;
    try {
      // In the try: a listener that throws on the start still gets its end.
      events.emit({ type: "request.start", requestId, role: kind.role, purpose: kind.purpose, model: adapter.id, turn: turns, estimatedInputTokens: estimated });
      reply = await withRetry(() => {
        // Nothing is sent once the question was stopped.
        signal?.throwIfAborted();
        const sending = adapter.send(body, {
          ...(signal ? { signal } : {}),
          // The adapter streams only when the text is asked for as it is written: a listener of
          // the events alone does not change how the model is asked.
          ...(shown && streamText ? { onText: write } : {}),
        });
        // The question stops when the signal aborts, whether the adapter does or not: one that does
        // not look at it would hold the question, and the user, until its request ends, if it ever
        // does. That holds when the signal aborted while the adapter was called (its onText ran the
        // caller's code): `until` then ends at once with the signal's reason.
        return until(sending, signal);
      }, {
        retry: options.retry,
        signal,
        canRetry: () => got.length === 0,
        onRetry: (retried) => {
          const message = retryMessage(retried);
          options.onActivity?.(message);
          if (events.active) events.emit({ type: "retry", requestId, attempt: retried.attempt, delayMs: retried.delayMs, error: eventErrorOf(retried.error), message });
        },
      });
    } catch (error) {
      if (events.active) events.emit({ type: "request.end", requestId, ms: Date.now() - began, outcome: "error", error: eventErrorOf(error) });
      throw error;
    }
    // Text the adapter did not pass on as it came (no streaming was asked for, or it cannot). Not
    // the text of a reply a filter stopped, when such an answer is dropped: it was not shown yet.
    if (shown && reply.text.length > got.length && reply.text.startsWith(got) && !(dropFiltered && reply.finish === "filtered")) write(reply.text.slice(got.length));
    answeredRequests++;
    lastReply = reply;
    // A reply without its input tokens is counted by the estimate, in the model's own tokens.
    usage.add(adapter.id, reply.usage, estimated * scaleOf(adapter));
    // The count of the model that answered, in the library's tokens by that model's own scale: how
    // much more than its scale says the text costs it, which the other model will see too. By the
    // larger scale of the two, a count of the model with the smaller one was taken for no more.
    meter.observe(estimated, typeof reply.usage?.inputTokens === "number" ? reply.usage.inputTokens / scaleOf(adapter) : undefined);
    if (reply.blockReason) blockReason = reply.blockReason;
    finishReason = reply.finishReason ?? finishReason;
    lastUsage = reply.providerUsage ?? lastUsage;
    events.emit({
      type: "request.end",
      requestId,
      ms: Date.now() - began,
      outcome: "ok",
      ...(reply.usage ? { usage: reply.usage } : {}),
      ...(reply.finish ? { finish: reply.finish } : {}),
      ...(reply.finishReason !== undefined ? { finishReason: reply.finishReason } : {}),
      toolCalls: reply.calls.length,
      ...(typeof reply.responseId === "string" ? { responseId: reply.responseId } : {}),
      ...(typeof reply.responseModel === "string" ? { responseModel: reply.responseModel } : {}),
    });
    if (reply.blockReason) notice("blocked", `The provider refused the prompt: ${reply.blockReason}.`);
    return reply;
  };
  // What a model wrote before it was stopped by a refusal is not an answer.
  const wrote = (reply: ModelReply) => reply.text.trim().length > 0 && !reply.blockReason;

  const asked = messages.length;
  /** The documents of the question, by ID: their names and formats, for the citations of the answer. */
  const documents = [...prepared.plan.inline, ...prepared.plan.searchable];
  const citationsOf = (): CitationCheck => {
    const names: Record<string, string> = {};
    const formats: Record<string, DocumentFormat> = {};
    for (const meta of documents) {
      names[meta.id] = meta.name;
      formats[meta.id] = meta.format;
    }
    // A document sent whole was shown, every line of it (its evidence comes first and says so),
    // and a whole-file read read every line: those from 1 to its last. A line past the end of the
    // file is not supported.
    const linesOf = new Map(documents.map((meta) => [meta.id, meta.lines]));
    const bounded = (entry: Evidence): Evidence => {
      const lines = linesOf.get(entry.documentId);
      return entry.whole === true && !entry.lines && typeof lines === "number" && Number.isFinite(lines) ? { ...entry, lines: lines >= 1 ? [[1, Math.trunc(lines)]] : [] } : entry;
    };
    return checkCitations(text, evidence.map(bounded), names, formats);
  };
  const result = (answered: boolean): AskResult => ({
    text,
    answered,
    ...(blockReason ? { blockReason } : {}),
    steps,
    evidence,
    // The rounds as the model last had them, or their stand-ins (`storeRounds: "compact"`). A
    // file cannot be kept as JSON: what is kept says that it was shown.
    toolTurns: messages.slice(asked).filter(isRound).map((round) => ({
      role: "tools" as const,
      version: TOOL_TURN_VERSION,
      calls: round.answers.map(({ call: { problem: _problem, ...call }, result: returned, files: shownFiles }) => ({
        ...call,
        result: shownFiles?.length ? stubResult(call, returned, true) ?? returned : options.storeRounds === "compact" ? stubResult(call, returned) ?? returned : returned,
      })),
    })),
    plan: prepared.plan,
    ...(missing.length > 0 ? { missing: [...missing] } : {}),
    budget,
    turns,
    ...(finishReason ? { finishReason } : {}),
    usage: usage.totals,
    ...(lastUsage ? { lastUsage } : {}),
    ...(lastReply?.finish !== undefined ? { finish: lastReply.finish } : {}),
    ...(documents.length > 0 ? { citations: citationsOf() } : {}),
  });
  /**
   * The result of a question that ends with an answer: one that a filter stopped, or that was cut
   * at the output limit, says so in a notice, before `run.finish`. A filtered answer is dropped
   * when `filteredAnswer` says so; text of it already sent is to be taken away (`discardText`).
   */
  const answer = (answered: boolean): AskResult => {
    const finish = lastReply?.finish;
    if (finish === "filtered") {
      const sent = text.length > 0;
      const message = !lastReply?.text.trim()
        ? "A filter of the provider stopped the answer before any text came."
        : dropFiltered
          ? "A filter of the provider stopped the answer before it was finished: its text was dropped."
          : "A filter of the provider stopped the answer before it was finished.";
      events.emit({ type: "notice", code: "answer_filtered", message, display: "none", ...(dropFiltered && sent ? { discardText: true as const } : {}) });
      if (dropFiltered) {
        text = "";
        return result(false);
      }
    } else if (finish === "cut") {
      notice("answer_cut", lastReply?.text.trim() ? "The answer stopped at the model's output limit, so it is incomplete." : "The answer stopped at the model's output limit before any text came.");
    }
    return result(answered);
  };

  // Pages the model looks at stay in the request until the question is answered, so they are
  // counted twice: as bytes against the request limit, and as tokens against half of what the
  // budget keeps free for tool results and the answer.
  const { maxRequestBytes, reservedTokens } = budget;
  const bytesKeptFree = Math.max(REQUEST_BYTES_MARGIN, Math.floor(maxRequestBytes / 10));
  let pagesLeft = Math.floor(reservedTokens / 2 / pageTokens);
  // The results of the text tools may fill the context window up to half of what is kept free (the
  // other half is the answer's), and the request up to a small margin. A provider that refuses a
  // request as too large, and names its window, makes it smaller.
  let tokenLimit = budget.contextTokens - Math.floor(reservedTokens / 2);
  const byteLimit = maxRequestBytes - Math.max(32_768, Math.floor(maxRequestBytes / 50));
  /**
   * The tokens of tool results that still fit, with a model turn that is about to be answered, for
   * calls whose results take `rates` tokens a character: within the token limit, and within the
   * bytes of the request for the call that takes the fewest tokens a character.
   */
  const room = (pending: ModelToolRound, rates: number[]): number => {
    const now = meter.current([...messages, pending]);
    const fewest = rates.length > 0 ? Math.min(...rates) : 1 / CHARACTERS_PER_TOKEN;
    return Math.floor(Math.min(tokenLimit - now.tokens, (byteLimit - now.bytes) / BYTES_PER_CHARACTER * fewest));
  };
  /**
   * Makes room: the results of every tool round but the last `keep` are replaced by short
   * stand-ins that say which lines or pages they showed. True when anything was replaced.
   */
  const shrink = (keep: number): boolean => {
    const rounds = messages.flatMap((message, index) => (isRound(message) ? [index] : []));
    let changed = false;
    for (const index of rounds.slice(0, Math.max(0, rounds.length - keep))) {
      const round = messages[index] as ModelToolRound;
      let touched = false;
      const answers = round.answers.map((answer): ToolAnswer => {
        const stub = stubResult(answer.call, answer.result, (answer.files?.length ?? 0) > 0);
        if (!stub) return answer;
        touched = true;
        return { call: answer.call, result: stub };
      });
      if (!touched) continue;
      const smaller: ModelToolRound = { ...round, answers };
      const owner = rawOwner.get(round);
      if (owner) rawOwner.set(smaller, owner);
      messages[index] = smaller;
      changed = true;
    }
    if (changed) unpoint();
    return changed;
  };

  /**
   * A pointer ("already shown above") whose result is no longer in the conversation in full (it was
   * shortened to make room, here or in an earlier question) is made a stand-in that says so: the
   * model must not be told to use what it no longer has. Every round is looked at, the kept ones too.
   * With a provider that clears old tool results on its side, every pointer is. So is a pointer to a
   * read of one line made in an earlier question than the pointer: 0.5.0 cut such reads without
   * saying so, and `shownBefore` does not point to them either.
   */
  function unpoint(): void {
    // What the answers before the one looked at hold, as they are now, found once in one pass:
    // the calls whose result is shown in full, by key, and the reads shown in full, by document,
    // with the question each was made in (stored questions are told apart by their user turns).
    const shownKeys = new Set<string>();
    const shownReads = new Map<unknown, Array<{ answer: ToolAnswer; index: number; question: number }>>();
    let question = 0;
    messages.forEach((message, index) => {
      if (!isRound(message)) {
        if (message.role === "user") question++;
        return;
      }
      let touched = false;
      /** The answers of this round so far that are not stand-ins, by key: a call made twice in a turn points to the first. */
      const inRound = new Map<string, ToolAnswer>();
      const answers: ToolAnswer[] = [];
      for (const answer of message.answers) {
        const key = toolCallKey(answer.call.name, answer.call.args);
        let now = answer;
        if (answer.result.already_shown === true) {
          const held = canPoint && ((key !== undefined && (inRound.has(key) || (answer.call.name !== TOOL_NAMES.read && shownKeys.has(key))))
            || (answer.call.name === TOOL_NAMES.read && (shownReads.get(answer.call.args.document_id) ?? [])
              .some((read) => pointerTo(answer.call, read.answer, read.index < asked && read.question !== question) !== undefined)));
          if (!held) {
            touched = true;
            now = {
              call: answer.call,
              result: {
                ...(typeof answer.result.document === "string" ? { document: answer.result.document } : {}),
                dropped: true,
                note: "Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it.",
              },
            };
          }
        } else if (key !== undefined && pointerTo(answer.call, answer) !== undefined) {
          // A result in full: what a later pointer may point to.
          if (answer.call.name === TOOL_NAMES.read) {
            const reads = shownReads.get(answer.call.args.document_id) ?? [];
            reads.push({ answer, index, question });
            shownReads.set(answer.call.args.document_id, reads);
          } else {
            shownKeys.add(key);
          }
        }
        if (key !== undefined && now.result.dropped !== true) inRound.set(key, now);
        answers.push(now);
      }
      if (!touched) return;
      const smaller: ModelToolRound = { ...message, answers };
      const owner = rawOwner.get(message);
      if (owner) rawOwner.set(smaller, owner);
      messages[index] = smaller;
    });
  }
  // Rounds of earlier questions are stored as the model last had them: a pointer may have lost its result there.
  unpoint();

  /** Calls answered in this question, refused ones included: none means that no tool ran. */
  let callsAnswered = 0;
  let recoveries = carried?.recoveries ?? 0;
  let nudges = carried?.nudges ?? 0;
  /**
   * After the provider refused `sent` as larger than the model takes: the meter learns what the
   * provider counted, the window it named, and old tool results are shortened until the request
   * fits by the meter's new count. True when anything was shortened, so that sending it again can
   * work. A model whose conversation may only grow (Claude) has nothing shortened.
   */
  const makeRoom = (adapter: ModelAdapter, sent: ModelRequest, error: unknown): boolean => {
    const refused: { limitTokens?: number; requestedTokens?: number } = modelErrorOf(error) ?? {};
    const own = scaleOf(adapter);
    meter.overflowed(meter.estimate(sent.messages).tokens, refused.requestedTokens !== undefined ? refused.requestedTokens / own : undefined);
    if (refused.limitTokens !== undefined) {
      tokenLimit = Math.min(tokenLimit, Math.floor(refused.limitTokens / own) - replyTokens - Math.floor(reservedTokens / 2));
    }
    if (!canShrink) return false;
    return shortenUntil(() => meter.current(messages).tokens <= tokenLimit);
  };
  /**
   * Shortens old tool results until `fits`: those of every round but the last three, then two,
   * then one, then all. True when anything was shortened.
   */
  const shortenUntil = (fits: () => boolean): boolean => {
    let changed = false;
    for (const keep of [...ROUNDS_KEPT, 0]) {
      if (changed && fits()) break;
      if (shrink(keep)) changed = true;
    }
    return changed;
  };
  /**
   * Before the first request of the question: when the stored rounds of earlier questions make it
   * larger than the room it has in tokens, their results are shortened as they would be after the
   * provider refused it (`makeRoom`, which counts tokens too), and it is sent shortened, instead of
   * sent to be refused. The rounds are those of earlier questions: nothing of this question has
   * been sent, and a stored round has no thinking in it, so this is done for a model whose
   * conversation may only grow (Claude) too. A question planned again shortens them again, and
   * does not say so twice: its first try's steps already do.
   */
  let firstSent = false;
  const preflight = () => {
    if (firstSent) return;
    firstSent = true;
    const fits = () => meter.current(messages).tokens <= tokenLimit;
    if (!fits() && shortenUntil(fits) && !carried?.steps.includes(RESULTS_SHORTENED)) step(RESULTS_SHORTENED, "results_shortened");
  };
  /**
   * The window to plan the documents for again, in the models' tokens, after the first request was
   * refused as too large: the one the provider named, made smaller by how much more than the
   * estimate it counted. Without its numbers, seven tenths of the window the budget assumed.
   */
  const smallerWindow = (adapter: ModelAdapter, sent: ModelRequest, error: unknown): { contextTokens: number; step: string } => {
    const refused: { limitTokens?: number; requestedTokens?: number } = modelErrorOf(error) ?? {};
    const estimated = meter.estimate(sent.messages).tokens;
    const ratio = refused.requestedTokens !== undefined && estimated > 0 ? refused.requestedTokens / scaleOf(adapter) / estimated : undefined;
    const limit = refused.limitTokens;
    let contextTokens = Math.floor((limit ?? modelWindow * 0.7) / Math.max(1, ratio ?? (limit !== undefined ? 1.25 : 1)));
    if (contextTokens >= modelWindow) contextTokens = Math.floor(modelWindow * 0.7);
    // The limit may be the tokens a minute of the provider allows (OpenAI's TPM), not the window.
    const period = rateAllowanceOf(error);
    return {
      contextTokens,
      step: limit !== undefined
        ? period
          ? `The first request was larger than the ${count(limit)} tokens a ${period} that the provider allows: the files were planned again to fit it`
          : `The first request was larger than the model's window of ${count(limit)} tokens: the files were planned again to fit it`
        : period
          ? `The first request was larger than the provider allows in a ${period}: the files were planned again for a smaller request`
          : "The first request was larger than the model takes: the files were planned again for a smaller window",
    };
  };
  /**
   * `request`, for a request the provider may refuse as larger than the model takes. Then room is
   * made, and it is sent once more, at most twice in a question. When nothing can be made smaller
   * and nothing has happened yet in this question, the documents are planned again for a smaller
   * window (`Replan`). `build` makes the request from the conversation as it is then.
   */
  const send = async (adapter: ModelAdapter, build: () => ModelRequest, shown: boolean, kind: RequestKind): Promise<ModelReply> => {
    preflight();
    for (let again = false; ; again = true) {
      const body = build();
      try {
        return await request(adapter, body, shown, kind);
      } catch (error) {
        // By the kind its events report: also for an error of your own adapter with a status and no kind.
        if (modelErrorOf(error)?.kind !== "context_overflow" || signal?.aborted) throw error;
        if (!again && recoveries < MOST_OVERFLOW_RECOVERIES && makeRoom(adapter, body, error)) {
          recoveries++;
          const period = rateAllowanceOf(error);
          step(period
            ? `The request was larger than the provider allows in a ${period}: older tool results were shortened, and it was sent again`
            : "The request was larger than the model takes: older tool results were shortened, and it was sent again", "room_made");
          continue;
        }
        if (carried === undefined && callsAnswered === 0 && !text) {
          const smaller = smallerWindow(adapter, body, error);
          throw new Replan({ usage, steps: [...steps], turns, answered: answeredRequests, nudges, recoveries, contextTokens: smaller.contextTokens, step: smaller.step, documentIds, missing }, error, result(false));
        }
        throw error;
      }
    }
  };
  /** The conversation with a note at its end: in the last user turn, or in one of its own after a tool round. */
  const withNote = (list: ModelMessage[], note: string): ModelMessage[] => {
    const last = list.at(-1);
    if (last && !isRound(last) && last.role === "user") return [...list.slice(0, -1), { role: "user", parts: [...last.parts, { text: note }] }];
    return [...list, { role: "user", parts: [{ text: note }] }];
  };
  /**
   * The tool request with a note at its end. The note is not kept in the conversation, so that the
   * start of the later requests is the one the provider's cache holds. A model that explores whose
   * conversation may only grow (Claude ties its thinking to the turns it was written after) keeps
   * it: what it thinks next follows the note. The answering model, when it is another, never gets it.
   */
  const notedMessages = (note: string): (() => ModelMessage[]) => {
    if (!toolModel.capabilities.appendOnly) return () => withNote(viewFor(toolModel), note);
    const last = messages.at(-1);
    if (last && !isRound(last) && last.role === "user") {
      const noted: ModelMessage = { role: "user", parts: [...last.parts, { text: note }] };
      notes.set(noted, notes.has(last) ? notes.get(last) : last);
      messages[messages.length - 1] = noted;
    } else {
      const noted: ModelMessage = { role: "user", parts: [{ text: note }] };
      notes.set(noted, undefined);
      messages.push(noted);
    }
    return () => viewFor(toolModel);
  };

  // The tool calls run with a signal of their own. The question's aborts it, and so does a turn
  // that fails (a listener that threw): the calls still waiting for a slot, or running, stop. A
  // failed turn ends the question, so one signal serves every turn, with the tool set that counts
  // the whole-file reads of the question.
  const halt = new AbortController();
  const stopTools = () => halt.abort(signal?.reason);
  if (signal?.aborted) halt.abort(signal.reason);
  else signal?.addEventListener("abort", stopTools, { once: true });

  try {
    // Nothing for the tools (see `toolable` above): one request, without them.
    if (searchable.length === 0 && viewable.length === 0 && toolable.length === 0) return answer(wrote(await send(model, () => ({ system, messages }), true, { role: "answer", purpose: "direct" })));

    // Reading a whole file in parts is exploring too: the explorer model's work, when there is one.
    // Bound to its adapter: a class with a `generateText` method that uses `this` keeps it.
    const partReader = options.wholeDocumentAnalysis === false ? undefined : toolModel.generateText?.bind(toolModel);
    const generate: GenerateText | undefined = partReader && (async (part) => {
      let reported = false;
      // What the request sends, in the reader's tokens: counted for a request whose usage does not
      // give its input, so that `limits.inputTokens` sees it. Worked out only then.
      const estimate = () => (estimateTokens(part.system) + estimateTokens(part.prompt)) * scaleOf(toolModel);
      const text = await partReader({
        ...part,
        onUsage: (used) => {
          reported = true;
          usage.add(toolModel.id, used, reportsInput(used) ? undefined : estimate());
          part.onUsage?.(used);
        },
      });
      // A part reader that does not report its usage (`onUsage` is optional) still made a request,
      // and `limits.requests` counts it.
      if (!reported) usage.add(toolModel.id, undefined, estimate());
      return text;
    });
    // The tables sent whole are read by the tools too. Their question declares exactly the tools it
    // needs (`questionTools`): search_document, read_document and aggregate_table for them, never
    // get_document_overview or analyze_whole_document, which refuses a file sent whole if it is
    // called. With no such table, the tool set of 0.9.
    const declare = toolable.length > 0
      ? { declare: questionTools({ searchable, toolable, viewable }, generate !== undefined && searchable.some((meta) => canBeReadWhole(meta, budget))), inline: prepared.plan.inline.map((meta) => meta.id) }
      : {};
    const tools = files.tools([...searchable, ...toolable], {
      // The owner and scope the store holds are checked against the question's own, not against
      // the metadata handed in.
      access,
      ...(generate ? { generate } : {}),
      onProgress: (event) => options.onActivity?.(`${event.message}…`),
      signal: halt.signal,
      ...(viewable.length > 0 ? { viewPages: viewable, ...(pageImages ? { pageImages } : {}) } : {}),
      maxWholeDocumentReads: limits.wholeDocumentReads ?? MAX_WHOLE_DOCUMENT_READS,
      ...(options.retry ? { retry: options.retry } : {}),
      budget,
      ...declare,
    });
    const declarations = tools.declarations;
    /** The documents a tool call found gone, told once each ("document_gone"). */
    const gone = new Set<string>();
    /** The file name of a document of the question, as the plan has it. */
    const metaOf = (id: unknown): DocumentMeta | undefined => (typeof id === "string" ? [...searchable, ...toolable, ...viewable].find((meta) => meta.id === id) : undefined);
    const nameOf = (id: string): string | undefined => metaOf(id)?.name;
    // The requests that use the tools are the chat's own, or an explorer model's: the same
    // conversation, and a line that says what its part is.
    const toolSystem = explorer ? `${system}\n\n${EXPLORER_INSTRUCTION}` : system;
    const sentTools = JSON.stringify(declarations);
    meter.fixed.tokens += estimateTokens(sentTools) + (explorer ? estimateTokens(EXPLORER_INSTRUCTION) : 0);
    meter.fixed.bytes += Buffer.byteLength(sentTools) + (explorer ? EXPLORER_INSTRUCTION.length : 0);
    if (searchable.length > 0) activity("searching_instead", `Too large to read at once: ${searchable.map((meta) => meta.name).join(", ")}. Searching instead…`);

    const maxTurns = Math.max(1, Math.trunc(limits.toolTurns ?? DEFAULT_TOOL_TURNS));
    const maxCalls = Math.max(1, Math.trunc(limits.callsPerTurn ?? DEFAULT_CALLS_PER_TURN));
    const readsOfEach = limits.wholeDocumentReads ?? MAX_WHOLE_DOCUMENT_READS;
    // As the tool set reads its own count of reads of each document: whole numbers, none below 0.
    const readsInAll = Math.max(0, Math.trunc(limits.wholeReadsPerQuestion ?? DEFAULT_WHOLE_READS_PER_QUESTION));
    /**
     * The price of a whole-file read of `meta` by the model that explores, in its own tokens and
     * requests: a read that lists items (`output: "items"`) is its parts alone; any other, its
     * parts, the merges of their notes and its answer.
     */
    const priceOf = (meta: DocumentMeta, output: "answer" | "items" = "answer") => wholeReadCost(meta, budget, scaleOf(toolModel), output);
    /**
     * The ceiling on the input tokens of the question: `limits.inputTokens`, or by default the larger
     * of `DEFAULT_INPUT_TOKENS` and `toolTurns` times the first request, plus room for the
     * whole-file reads the question may make: as many as `wholeReadsPerQuestion` and the documents
     * that can be read whole allow, each at the price of the dearest of them.
     */
    const ceiling = ((): number => {
      if (limits.inputTokens !== undefined) return limits.inputTokens;
      const first = meter.current(viewFor(toolModel)).tokens * scaleOf(toolModel);
      const readable = tools.has(TOOL_NAMES.analyze) && readsOfEach > 0 ? searchable.filter((meta) => canBeReadWhole(meta, budget)) : [];
      const reads = Math.max(0, Math.min(readsInAll, readable.length * Math.trunc(readsOfEach)));
      const prices = readable.map((meta) => priceOf(meta).inputTokens).filter((price) => Number.isFinite(price));
      const allowance = prices.length > 0 ? (Number.isFinite(reads) ? reads : readable.length) * Math.max(...prices) : 0;
      return Math.max(DEFAULT_INPUT_TOKENS, maxTurns * first) + allowance;
    })();
    /** The input tokens the question has used: those the providers reported, and the estimates of those they did not. */
    const spentTokens = (): number => usage.totals.inputTokens + (usage.totals.estimatedInputTokens ?? 0);
    /**
     * True once the question has used what it may: no more tools run. One request is kept for the
     * answer. The ceiling of input tokens looks ahead: what was spent, the tool request about to be
     * sent and the answer's request after it, each as the meter counts it now, must stay within it.
     */
    const spent = (): boolean => {
      if (limits.requests !== undefined && usage.totals.requests >= limits.requests - 1) return true;
      if (!(ceiling < Number.POSITIVE_INFINITY)) return false;
      const next = meter.current(viewFor(toolModel)).tokens * scaleOf(toolModel);
      const closing = meter.current(viewFor(model)).tokens * scaleOf(model);
      return spentTokens() + next + closing > ceiling;
    };
    /**
     * The whole-file reads of the question that sent requests, by document: those that returned, and
     * those that failed after they sent them. Counted from what the tool returned, before
     * `onToolResult`: a read whose answer the hook replaced or rejected still made its requests.
     */
    const readsSent = new Map<string, number>();
    const readsMade = (documentId?: string): number => {
      if (documentId !== undefined) return readsSent.get(documentId) ?? 0;
      let made = 0;
      for (const reads of readsSent.values()) made += reads;
      return made;
    };
    /** True for the output of a whole-file read that sent its parts: its answer, or the error of a read that could read none of them. */
    const sentParts = (call: ToolCall, output: ToolResult): boolean => call.name === TOOL_NAMES.analyze
      && (evidenceOf(call, output)?.whole === true || (typeof output.error === "string" && output.error.startsWith(NOTHING_READ)));
    /** What the whole-file reads already let through in a turn will take: they run together, and the totals do not show them yet. */
    type Reserved = { inputTokens: number; requests: number; reads: Map<string, number> };
    /**
     * True when no whole-file read of `meta` is left, past those of `reserved`: the tool refuses one
     * itself, at no cost, with its own reason (such as a read that failed earlier). The tool set says
     * how many reads are left; one of your own that does not is read by what the reads of this
     * question returned.
     */
    const noReadLeft = (meta: DocumentMeta, reserved: Reserved): boolean => {
      const inTurn = reserved.reads.get(meta.id) ?? 0;
      const left = tools.wholeReadsLeft?.(meta.id);
      return typeof left === "number" ? left - inTurn <= 0 : readsMade(meta.id) + inTurn >= readsOfEach;
    };
    /**
     * What a whole-file read of `meta` takes, and why the question would not start it now, past the
     * reads of `reserved`: its whole reads made, or a ceiling it would pass. Not the tool's own
     * reasons (`noReadLeft`). `output` is the read's own: a read that lists items ("items") is
     * priced at its parts alone, any other ("answer") at its parts, merges and answer.
     */
    const readNeeds = (meta: DocumentMeta, reserved: Reserved, output: "answer" | "items"): { refusal?: string; tokens: number; requests: number } => {
      // The parts are read by the model that explores, in its own tokens: their lines numbered, the
      // prompts, and the merges of their notes (`wholeReadCost`). A read that lists items sends its
      // parts alone, with the rules of a list.
      const items = output === "items";
      const price = priceOf(meta, output).inputTokens;
      const tokens = Number.isFinite(price) ? price : Math.ceil(meta.estimatedTokens * scaleOf(toolModel));
      // The parts, a merge of their notes, the answer of the read, and the answer of the question;
      // for a list of items, the parts and the answer of the question.
      const requests = estimateParts(meta, budget) + (items ? 1 : 3);
      const allReserved = [...reserved.reads.values()].reduce((sum, reads) => sum + reads, 0);
      if (readsMade() + allReserved >= readsInAll) {
        return { tokens, requests, refusal: `Not run: one question makes at most ${count(readsInAll)} whole-file ${readsInAll === 1 ? "read" : "reads"}, and this one has made ${readsInAll === 1 ? "it" : "them"}. Use search_document and read_document on ${meta.name}.` };
      }
      if (ceiling < Number.POSITIVE_INFINITY) {
        const left = Math.max(0, ceiling - spentTokens() - reserved.inputTokens);
        if (tokens > left) return { tokens, requests, refusal: `Not run: reading all of ${meta.name} takes about ${count(tokens)} input tokens, and ${count(left)} ${count(left) === "1" ? "is" : "are"} left of the ${count(ceiling)} this question may use. Use search_document and read_document.` };
      }
      if (limits.requests !== undefined) {
        const left = Math.max(0, limits.requests - usage.totals.requests - reserved.requests);
        if (requests > left) return { tokens, requests, refusal: `Not run: reading all of ${meta.name} takes about ${count(requests)} model requests, and ${count(left)} ${count(left) === "1" ? "is" : "are"} left of the ${count(limits.requests)} this question may make. Use search_document and read_document.` };
      }
      return { tokens, requests };
    };
    /**
     * A whole-file read is many requests at once: one that would pass a ceiling of the question is
     * not started. `reserved` is what the reads already let through in this turn will take.
     */
    const tooCostly = (call: ToolCall, reserved: Reserved): { refusal?: string; own?: number } => {
      if (call.name !== TOOL_NAMES.analyze) return {};
      const meta = searchable.find((document) => document.id === call.args.document_id);
      // A read of a document read whole as often as it may be takes nothing from the reads of other documents.
      if (!meta || noReadLeft(meta, reserved)) return {};
      const { refusal, tokens, requests } = readNeeds(meta, reserved, call.args.output === "items" ? "items" : "answer");
      if (refusal) return { refusal };
      reserved.inputTokens += tokens;
      // The answer of the question is one request, whatever number of reads come before it.
      reserved.requests += requests - 1;
      reserved.reads.set(meta.id, (reserved.reads.get(meta.id) ?? 0) + 1);
      // The read's own requests: its parts, a merge of their notes, and its answer; or its parts.
      return { own: requests - 1 };
    };
    /**
     * The requests a whole-file read of the document of a `read_document` call may make
     * (`ToolCallLimits.maxRequests`), judged as on the next turn, the first the model can call it on:
     * with the reads of this turn reserved, and that turn's request, of the conversation with
     * `pending` at least (its results are not in it yet). 0 when the question would not start one
     * then (`noReadLeft`, `readNeeds`), so that a read cut short of its range does not point at it
     * (`whole_file`); what is left of `limits.requests` with one kept for the answer, when that is
     * set; undefined otherwise.
     */
    const wholeReadRequests = (call: ToolCall, reserved: Reserved, pending: ModelToolRound): number | undefined => {
      const meta = searchable.find((document) => document.id === call.args.document_id);
      if (!meta) return undefined;
      const nextTurn = meter.current(viewFor(toolModel, [...messages, pending])).tokens * scaleOf(toolModel);
      const later: Reserved = { ...reserved, inputTokens: reserved.inputTokens + nextTurn, requests: reserved.requests + 1 };
      // The hint points at a read that gives an answer, the dearer of the two kinds.
      if (noReadLeft(meta, later) || readNeeds(meta, later, "answer").refusal !== undefined) return 0;
      return limits.requests === undefined ? undefined : Math.max(0, limits.requests - usage.totals.requests - 1 - later.requests);
    };
    /**
     * A pointer for a call whose result is already in the conversation, in full: an earlier result
     * (of this question or of one before it) holds what this one would return. The files do not
     * change, so running it again would only take room.
     */
    const shownBefore = (call: ToolCall): ToolResult | undefined => {
      if (!canPoint) return undefined;
      for (let at = messages.length - 1; at >= 0; at--) {
        const message = messages[at]!;
        if (!isRound(message)) continue;
        // The rounds before `asked` are those of earlier questions, which an older version may have written.
        for (const answer of message.answers) {
          const pointer = pointerTo(call, answer, at < asked);
          if (pointer) return pointer;
        }
      }
      return undefined;
    };
    /** The tool and mode of the calls that failed last, and how many failed in a row. */
    let failing: { kind: string; count: number } | undefined;

    let answered = false;
    let outOfRoom = false;
    // Tools run in at most maxTurns - 1 requests. The last request is the one below that must be
    // answered in text, so a model that never stops calling tools does not cost a request whose
    // calls are thrown away.
    const toolRole: RequestRole = explorer ? "explorer" : "tools";
    /** A call as one line of plain text. An unknown tool's name is quoted and cut: no step starts with what the model chose, at any length. */
    const labelOf = (call: ToolCall): string => stepLine(tools.has(call.name) ? tools.describe(call.name, call.args) : `Call ${unknownToolName(call.name)}`);
    // The tools are there only for tables sent whole: without them, the question would be the one
    // request of 0.9. It is still that, without the tools, the line that says to count with them,
    // or a notice, when not one tool turn fits: a ceiling or a count of requests sized for that one
    // request, or `toolTurns: 1`.
    const tablesOnly = !explorer && searchable.length === 0 && viewable.length === 0;
    if (tablesOnly && (1 + (carried?.answered ?? 0) >= maxTurns || spent())) {
      const plainLine = inlineInstruction({ plan: prepared.plan }, numbered);
      const plain = [options.system?.trim(), prepared.instruction, plainLine, missingLine].filter(Boolean).join("\n\n");
      // Its estimate, for a provider that reports no usage: no declarations, its own line.
      meter.fixed.tokens += -estimateTokens(sentTools) - (inlineLine ? estimateTokens(inlineLine) : 0) + (plainLine ? estimateTokens(plainLine) : 0);
      meter.fixed.bytes += -Buffer.byteLength(sentTools) - (inlineLine ? jsonBytes(inlineLine) : 0) + (plainLine ? jsonBytes(plainLine) : 0);
      return answer(wrote(await send(model, () => ({ system: plain, messages }), true, { role: "answer", purpose: "direct" })));
    }
    for (let round = 1 + (carried?.answered ?? 0); round < maxTurns && !outOfRoom; round++) {
      if (spent()) {
        budgetReached();
        break;
      }
      const toolRequest = (): ModelRequest => ({ system: toolSystem, messages: viewFor(toolModel), tools: declarations, toolChoice: "auto" });
      let reply = await send(toolModel, () => toolRequest(), !explorer, { role: toolRole, purpose: "turn" });
      // A turn whose tool call could not be read, or a first reply with nothing in it, is asked
      // for once more, with a note that says what was wrong: the answer would otherwise be written
      // from the cards alone, and look like any other. The note is not kept in the conversation.
      // It is a request of the chat like any other: it takes a tool turn, and the last turn is still the answer's.
      if (reply.calls.length === 0 && nudges < MOST_NUDGES && round + 1 < maxTurns && !reply.blockReason && !spent()) {
        const malformed = reply.finish === "malformed_call";
        // Not a reply that a filter, the output limit or another reason that asking again does not
        // mend ended ("other": Gemini's OTHER, LANGUAGE): it would only end the same way.
        const empty = !reply.text.trim() && callsAnswered === 0 && reply.finish !== "cut" && reply.finish !== "filtered" && reply.finish !== "other";
        if (malformed || empty) {
          nudges++;
          round++;
          step(malformed ? "The model's tool call could not be read: it was asked to send it again" : "The model's first reply was empty: it was asked again", "nudged");
          const note = malformed ? (explorer ? MALFORMED_EXPLORER_NUDGE : MALFORMED_CALL_NUDGE) : explorer ? EMPTY_EXPLORER_NUDGE : EMPTY_REPLY_NUDGE;
          const withIt = notedMessages(note);
          reply = await send(toolModel, () => ({ system: toolSystem, messages: withIt(), tools: declarations, toolChoice: "auto" }), !explorer, { role: toolRole, purpose: "nudge" });
        }
      }
      if (reply.calls.length === 0) {
        // Text from this turn is the answer. A remark made earlier, before a tool call, is not.
        // Neither is anything an explorer model writes: the answer is asked for below. Nor the
        // remark of a turn whose tool call could not be read ("Let me look at the errors."), on
        // the last tool turn or after its nudge: the answer is asked for below.
        answered = wrote(reply) && !explorer && reply.finish !== "malformed_call";
        // Over tables sent whole alone, a reply that a filter or another reason that asking again
        // does not mend ended ("other"), or one cut at the output limit before any text, ends the
        // question, as it ends the direct request of 0.9: the request for the answer would send
        // the whole tables again, only to end the same way.
        if (tablesOnly && !answered && (reply.finish === "filtered" || reply.finish === "other" || reply.finish === "cut")) return answer(false);
        break;
      }
      const pending: ModelToolRound = { role: "tools", calls: reply.calls, answers: [], ...(reply.raw !== undefined ? { raw: reply.raw } : {}) };
      if (reply.raw !== undefined) rawOwner.set(pending, toolModel);
      // Every call must be answered, but not every call is run: a turn of sixty reads would build
      // a request that no model accepts, and a file can ask a model for exactly that.
      const run = reply.calls.slice(0, maxCalls);
      const most = (call: ToolCall) => tools.resultCharacters(call.name);

      /**
       * `late`: a whole-file read, whose answer is fitted to the room once the other results of the
       * turn are in. `pointer`: the result of a call whose result is already in the conversation;
       * `earlier` when that is the result of an earlier turn, which room may still be made from.
       */
      type Planned = { call: ToolCall; label: string; refusal?: string; pointer?: ToolResult; earlier?: boolean; twinOf?: number; own?: number; limits?: ToolCallLimits; late?: boolean };
      const reserved = { inputTokens: 0, requests: 0, reads: new Map<string, number>() };
      /** The first call of this turn with each key: the same call made again in the turn is not run twice. */
      const seen = new Map<string, number>();
      const planned = run.map((call, index): Planned => {
        const label = labelOf(call);
        // A call that did not arrive whole is not run: the model is told, and can send it again.
        if (call.problem) return { call, label, refusal: call.problem };
        // Nor a call of a tool the question does not have: it is told which there are, and its
        // answer takes no room (a turn of unknown calls made room for each of them, at the cap of
        // a result, and shortened the results of earlier turns for nothing).
        if (!tools.has(call.name)) return { call, label, refusal: unknownTool(call.name, declarations.map((declaration) => declaration.name)) };
        // A look at pages returns a file and a few words: the file has its own room, worked out when it runs.
        if (call.name === TOOL_NAMES.view) return { call, label };
        const key = toolCallKey(call.name, call.args);
        if (key !== undefined && canPoint) {
          const twin = seen.get(key);
          if (twin !== undefined) return { call, label, twinOf: twin, pointer: { already_shown: true, note: `Not run: call ${twin + 1} of this turn is the same call, and its result is next to this one. Use it.` } };
          seen.set(key, index);
        }
        const pointer = shownBefore(call);
        if (pointer) return { call, label, pointer, earlier: true };
        const cost = tooCostly(call, reserved);
        if (cost.refusal) return { call, label, refusal: cost.refusal };
        return { call, label, ...(cost.own !== undefined ? { own: cost.own } : {}) };
      });
      // The requests each whole-file read of the turn may make, once all of them are reserved: its
      // own, and an even share of what the question has left over them (a part read as two halves
      // takes one more). Together they never pass limits.requests.
      const reads = planned.filter((plan) => plan.own !== undefined);
      if (limits.requests !== undefined && reads.length > 0) {
        const slack = Math.max(0, limits.requests - usage.totals.requests - 1 - reserved.requests);
        for (const plan of reads) plan.limits = { ...plan.limits, maxRequests: plan.own! + Math.floor(slack / reads.length) };
      }
      // A read of lines points at a whole read of its file only when the question would start one
      // on the next turn, past the whole reads of this turn: each is told the requests one may make.
      for (const plan of planned) {
        if (plan.refusal || plan.call.name !== TOOL_NAMES.read) continue;
        const most = wholeReadRequests(plan.call, reserved, pending);
        if (most !== undefined) plan.limits = { ...plan.limits, maxRequests: most };
      }
      // The calls that return text, and the most they may return: a call that is refused, or
      // answered with a pointer to what is already shown, needs no room.
      const sized = planned.filter((plan) => !plan.refusal && !plan.pointer && plan.call.name !== TOOL_NAMES.view);
      // The room is in tokens, and each result takes those of its document's characters.
      const rateOf = (call: ToolCall) => 1 / charactersPerToken(metaOf(call.args.document_id));
      const sizedRates = sized.map((plan) => rateOf(plan.call));
      const needed = sized.reduce((sum, plan, index) => sum + most(plan.call) * sizedRates[index]!, 0);
      let left = room(pending, sizedRates);
      let dropped = false;
      for (const keep of canShrink ? ROUNDS_KEPT : []) {
        if (left >= needed) break;
        if (shrink(keep)) {
          dropped = true;
          left = room(pending, sizedRates);
        }
      }
      if (dropped) {
        step(RESULTS_SHORTENED, "results_shortened");
        // A result that was shortened is no longer shown in full: a call that pointed to it is run after all.
        for (const plan of planned) {
          if (!plan.earlier) continue;
          const pointer = shownBefore(plan.call);
          if (pointer) {
            plan.pointer = pointer;
          } else {
            delete plan.pointer;
            delete plan.earlier;
          }
        }
      }
      const runsNow = planned.filter((plan) => !plan.refusal && !plan.pointer && plan.call.name !== TOOL_NAMES.view);

      // The room is shared by those calls. A result is most often far smaller than its cap, so a call
      // that was given its whole cap first could leave none for the next ones, and a turn of small
      // searches ended the question.
      const runRates = runsNow.map((plan) => rateOf(plan.call));
      const shares = shareRoom(runsNow.map((plan) => most(plan.call)), left, runRates);
      /** The tokens of room each call that runs was given, by its index in the turn. */
      const given = new Map<number, number>();
      runsNow.forEach((plan, index) => {
        const share = shares[index];
        const cap = most(plan.call);
        if (share !== undefined) given.set(planned.indexOf(plan), share * runRates[index]!);
        if (share === undefined) {
          if (!outOfRoom) notice("no_room", "There is no room left in this conversation for another tool result.");
          outOfRoom = true;
          plan.refusal = NO_ROOM;
        } else if (plan.call.name === TOOL_NAMES.analyze) {
          // The answer of a whole-file read cannot be asked for again. It is not cut to an even share
          // up front: it gets all the room the other results of the turn leave, once they are in.
          plan.late = true;
        } else if (share < cap) {
          plan.limits = { ...plan.limits, maxResultCharacters: share };
        }
      });
      // A call made twice in the turn whose first was refused (no room, or not whole) is refused the
      // same way: there is no result next to it to use.
      for (const plan of planned) {
        const source = plan.twinOf === undefined ? undefined : planned[plan.twinOf];
        if (source?.refusal) {
          plan.refusal = source.refusal;
          delete plan.pointer;
        }
      }

      // Each call of the turn, those over `maxCalls` too, has an id for its events, in call order.
      const callIds = reply.calls.map(() => `call_${++state.calls}`);
      /**
       * The calls of this turn whose `tool.start` went out and whose `tool.end` has not, by index:
       * when each started, and how to end the requests of a whole-file read still under way.
       */
      const openCalls = new Map<number, { began: number; requests: Set<(error: unknown) => void> }>();
      /** True once the turn failed (the question was stopped): nothing more of it is reported. */
      let turnFailed = false;
      /**
       * The first throw of a listener told of a whole-file read while it runs (`onEvent`,
       * `onActivity`). It must reach the caller, not become the read's own failure: the calls of the
       * question stop, and the turn ends with it.
       */
      let listenerError: { error: unknown } | undefined;
      const tell = (told: () => void) => {
        try {
          told();
        } catch (error) {
          if (listenerError) return;
          listenerError = { error };
          halt.abort(error);
        }
      };
      const startTool = (index: number, call: ToolCall, label: string) => {
        if (turnFailed) return;
        openCalls.set(index, { began: Date.now(), requests: new Set() });
        if (!events.active) return;
        events.emit({
          type: "tool.start",
          callId: callIds[index]!,
          ...(call.id !== undefined ? { providerCallId: call.id } : {}),
          tool: call.name,
          args: call.args,
          label,
          ...(typeof call.args?.document_id === "string" ? { documentId: call.args.document_id } : {}),
          round,
        });
      };
      /** `sent`: the result as the model gets it. `line`: the step, as `onStep` got it. */
      const endTool = (index: number, outcome: ToolOutcome, sent: ToolResult, line?: string, shown?: Evidence) => {
        const open = openCalls.get(index);
        openCalls.delete(index);
        // A request of a whole-file read that its read left behind ends before its call does.
        for (const end of [...open?.requests ?? []]) end(new Error(CALL_ENDED));
        if (!events.active || turnFailed) return;
        events.emit({
          type: "tool.end",
          callId: callIds[index]!,
          outcome,
          ms: open ? Date.now() - open.began : 0,
          ...(line !== undefined ? { step: line } : {}),
          ...(shown ? { evidence: { ...shown, callId: callIds[index]! } } : {}),
          resultCharacters: JSON.stringify(sent).length,
          ...(typeof sent.error === "string" ? { error: sent.error } : {}),
          ...(options.eventResults === true ? { result: sent } : {}),
        });
      };
      /** Ends every call of the turn still open, and its requests, in call order, when the turn failed. */
      const failTurn = (error: unknown) => {
        const open = [...openCalls].sort(([first], [second]) => first - second);
        openCalls.clear();
        turnFailed = true;
        const why = events.active ? eventErrorOf(error).message : "";
        for (const [index, call] of open) {
          for (const end of [...call.requests]) end(error);
          if (!events.active) continue;
          events.emit({ type: "tool.end", callId: callIds[index]!, outcome: "error", ms: Date.now() - call.began, error: why, resultCharacters: 0 });
        }
      };
      /** A model request of a whole-file read, for its events. */
      const readerRequest = (index: number, start: ToolRequestStart): ToolRequestHandle => {
        const open = openCalls.get(index);
        // The call was ended already (the question was stopped): nothing more of it is reported.
        if (!open) return { retry: () => undefined, end: () => undefined };
        const requestId = `req_${++state.requests}`;
        const began = Date.now();
        let ended = false;
        const end = (last: ToolRequestEnd) => {
          if (ended) return;
          ended = true;
          open.requests.delete(abandon);
          tell(() => events.emit({
            type: "request.end",
            requestId,
            ms: Date.now() - began,
            outcome: last.outcome,
            ...(last.usage ? { usage: last.usage } : {}),
            ...(last.error !== undefined ? { error: eventErrorOf(last.error) } : {}),
          }));
        };
        const abandon = (error: unknown) => end({ outcome: "error", error });
        // Before its start goes out: a listener that throws on the start still gets the end.
        open.requests.add(abandon);
        tell(() => events.emit({ type: "request.start", requestId, role: "reader", purpose: start.purpose, model: toolModel.id, callId: callIds[index]!, detail: start.detail }));
        return {
          retry: (retried) => {
            if (!ended && events.active) tell(() => events.emit({ type: "retry", requestId, attempt: retried.attempt, delayMs: retried.delayMs, error: eventErrorOf(retried.error), message: retryMessage(retried) }));
          },
          end,
        };
      };
      /** A look of this turn waited `pageLookWaitMs` and was told the server is busy: the others do not wait (`maxWaitMs`). */
      let pagesBusy = false;
      /**
       * The listeners of one call: its progress goes to `onActivity` as before (in place of the
       * tool set's shared listener) and is told apart by call in the events, with its requests.
       */
      const hooksFor = (index: number): ToolCallHooks => ({
        onProgress: (event) => tell(() => {
          options.onActivity?.(`${event.message}…`);
          if (openCalls.has(index)) events.emit({ type: "tool.progress", callId: callIds[index]!, stage: event.kind, done: event.done, total: event.total, message: event.message });
        }),
        ...(events.active ? { onRequest: (start: ToolRequestStart) => readerRequest(index, start) } : {}),
        // Notices of the question, not steps: the call's own step says what the model was told.
        onDocumentGone: (id) => tell(() => {
          if (gone.has(id)) return;
          gone.add(id);
          notice("document_gone", `${nameOf(id) ?? "A file"} is no longer available on the server.`, [id]);
        }),
        onPagesBusy: (id) => {
          pagesBusy = true;
          tell(() => notice("page_looks_busy", `The pages of ${nameOf(id) ?? "a file"} were not looked at: the server was busy with other looks at pages.`, [id]));
        },
      });

      // The calls of a turn run together, a few at a time. Looks at pages take their turns, one
      // after another: each is given the room the ones before it left.
      const together = new Limiter(CALLS_AT_ONCE);
      let looks: Promise<unknown> = Promise.resolve();
      // The size of the request as it stands, worked out when the first look at pages in this turn needs it.
      let requestBytes: number | undefined;
      const runCall = ({ call, label, refusal, pointer, limits: callLimits }: Planned, index: number): Promise<ToolOutput> => {
        if (refusal || pointer) startTool(index, call, label);
        if (refusal) return Promise.resolve({ result: { error: refusal }, files: [] });
        if (pointer) return Promise.resolve({ result: pointer, files: [] });
        if (call.name === TOOL_NAMES.view) {
          const look = looks.then(async () => {
            halt.signal.throwIfAborted();
            options.onActivity?.(`${label}…`);
            startTool(index, call, label);
            if (requestBytes === undefined) {
              const waiting: ModelRequest = { system: toolSystem, messages: [...viewFor(toolModel), pending], tools: declarations, toolChoice: "auto" };
              requestBytes = toolModel.requestBytes?.(waiting) ?? meter.estimate(waiting.messages).bytes;
            }
            // Base64 turns three bytes into four characters.
            const output = await until(tools.executeWithFiles(call.name, call.args, {
              maxFileBytes: Math.floor((maxRequestBytes - bytesKeptFree - requestBytes) * 3 / 4),
              maxPages: pagesLeft,
              // A wait that ends busy comes once in a tool turn: after a busy look, the others run only when a turn is free now.
              ...(pagesBusy ? { maxWaitMs: 0 } : {}),
            }, hooksFor(index)), halt.signal);
            for (const file of output.files) requestBytes += Math.ceil(file.bytes.length / 3) * 4 + 512;
            if (output.files.length > 0) pagesLeft -= pagesShown(output.result);
            return output;
          });
          looks = look.catch(() => undefined);
          return look;
        }
        return together.acquire(halt.signal).then(async (release) => {
          try {
            // The turn may have failed while this call waited for its slot.
            halt.signal.throwIfAborted();
            options.onActivity?.(`${label}…`);
            startTool(index, call, label);
            // The question stops when its signal aborts, whether the tool set does or not: a store
            // call that hangs inside a tool of any `LargeFiles` must not hold it.
            return await until(tools.executeWithFiles(call.name, call.args, callLimits, hooksFor(index)), halt.signal);
          } finally {
            release();
          }
        });
      };

      const turnsLeft = outOfRoom ? 0 : maxTurns - round - 1;
      const answers: ToolAnswer[] = [];
      try {
        const outputs: Array<Promise<ToolOutput>> = [];
        for (const [index, plan] of planned.entries()) {
          const output = runCall(plan, index);
          // One that fails (the question was stopped) is reported below, in call order; the others must not go unheard.
          output.catch(() => undefined);
          outputs.push(output);
        }

        /**
         * The application's say on what the model gets (`onToolResult`): each call's verdict, asked
         * for as soon as its result is in, so that the hooks of a turn run at the same time. They are
         * applied below, in call order, before the result is fitted to the room in the request, and
         * before the evidence, the step and the events, which all tell what the model was sent.
         * `raw` is what the tool returned; `output`, what the hook let through. A call made twice in
         * the turn is given the verdict of its first (`copied`): no pointer to a result the hook
         * replaced or rejected. A hook that fails ends the turn at once.
         */
        type Judged = { raw: ToolOutput; output: ToolOutput; judged?: ToolOutcome; copied?: boolean };
        const hook = options.onToolResult;
        const judgedOutputs: Array<Promise<Judged>> = [];
        for (const [index, { call, refusal, pointer, twinOf }] of planned.entries()) {
          const raw = outputs[index]!;
          let judging: Promise<Judged>;
          if (hook && pointer && twinOf !== undefined) {
            judging = Promise.all([raw, judgedOutputs[twinOf]!]).then(([own, first]): Judged => (first.judged
              ? { raw: own, output: { result: first.output.result, files: [] }, judged: first.judged, copied: true }
              : { raw: own, output: own }));
          } else if (hook && !refusal && !pointer) {
            judging = raw.then(async (own): Promise<Judged> => {
              const context: ToolResultContext = {
                call,
                result: own.result,
                ...(typeof call.args.document_id === "string" ? { documentId: call.args.document_id } : {}),
                ...(options.owner !== undefined ? { owner: options.owner } : {}),
                ...(options.scope !== undefined ? { scope: options.scope } : {}),
                signal: halt.signal,
              };
              let verdict: ToolResultVerdict | undefined;
              try {
                // A hook that does not look at the signal does not hold the question once it is stopped.
                verdict = checkedVerdict(await until(Promise.resolve().then(() => hook(context)), halt.signal));
              } catch (error) {
                halt.abort(error);
                throw error;
              }
              if (verdict && "result" in verdict) return { raw: own, output: { ...own, result: { ...verdict.result, redacted: true } }, judged: "redacted" };
              if (verdict) return { raw: own, output: { result: { error: verdict.reject }, files: [] }, judged: "refused" };
              return { raw: own, output: own };
            });
          } else {
            judging = raw.then((own): Judged => ({ raw: own, output: own }));
          }
          judging.catch(() => undefined);
          judgedOutputs.push(judging);
        }

        /**
         * The room of each whole-file read of the turn: what the other results left, shared among the
         * reads, the smaller answers first. Worked out when the first of them is reached, by which time
         * the other calls, which are quick, have most often returned.
         */
        let lateRoom: Map<number, number> | undefined;
        const roomOfReads = async (): Promise<Map<number, number>> => {
          const sizes = await Promise.all(judgedOutputs.map(async (judging) => resultTokens((await judging).output.result)));
          const reads = planned.flatMap((plan, index) => (plan.late ? [index] : []));
          let free = left - sizes.reduce((sum, size, index) => sum + (planned[index]!.late ? 0 : size), 0);
          const shares = new Map<number, number>();
          [...reads].sort((first, second) => sizes[first]! - sizes[second]!).forEach((index, position) => {
            const share = Math.min(sizes[index]!, Math.floor(free / (reads.length - position)));
            shares.set(index, share);
            free -= share;
          });
          return shares;
        };

        /**
         * The tokens the results of this turn took so far, of the calls that were given room and are
         * not whole-file reads (those are fitted to what the others left, above), and of those the
         * hook replaced. A result is cut when it would take more than the room leaves it once the
         * calls after it, and the reads, have their shares: the room shared by characters is a
         * guess, a tool set of your own may not keep to `maxResultCharacters`, and a hook may return
         * more than the tool did.
         */
        let took = 0;
        const roomFor = (index: number): number => {
          let others = 0;
          for (const [other, tokens] of given) if (other > index || planned[other]!.late) others += tokens;
          return left - took - others;
        };

        // The answers in call order. Each call's `tool.end` goes out here, in the same order.
        for (const [index, { call, label, late, refusal, pointer }] of planned.entries()) {
          const { raw, output: judgedOutput, judged, copied } = await judgedOutputs[index]!;
          if (listenerError) throw listenerError.error;
          // A hook of a later call failed: nothing more of the turn reaches the model.
          if (halt.signal.aborted) throw halt.signal.reason;
          callsAnswered++;
          // A whole-file read that sent its parts counts against `wholeReadsPerQuestion`, whatever the hook made of its answer.
          if (!refusal && !pointer && sentParts(call, raw.result)) {
            const id = String(call.args.document_id);
            readsSent.set(id, (readsSent.get(id) ?? 0) + 1);
          }
          let output = judgedOutput;
          if (late) {
            lateRoom ??= await roomOfReads();
            const share = lateRoom.get(index)!;
            if (resultTokens(output.result) > share) output = { ...output, result: cutToTokens(output.result, share) };
          } else if (given.has(index) || judged) {
            const fits = roomFor(index);
            if (resultTokens(output.result) > fits) output = { ...output, result: cutToTokens(output.result, fits) };
            took += resultTokens(output.result);
          }
          // A cut replacement is still a replacement.
          if (judged === "redacted" && output.result.redacted !== true) output = { ...output, result: { ...output.result, redacted: true } };
          if (pointer && !copied) {
            const line = step(`${label} — already shown above`);
            const sent = { ...output.result, tool_turns_left: turnsLeft };
            answers.push({ call, result: sent, files: [] });
            endTool(index, "already_shown", sent, line);
            continue;
          }
          // Two searches in a row that failed in the same mode: the second says to try another way.
          // Read from what the tool returned; the hint goes only to a result the hook kept.
          if (!refusal && !copied) {
            const own = judged ? raw.result : output.result;
            const kind = failureKind(call);
            if (kind === undefined) {
              failing = undefined;
            } else if (typeof own.error === "string") {
              failing = failing?.kind === kind ? { kind, count: failing.count + 1 } : { kind, count: 1 };
              if (failing.count >= 2 && !judged) output = { ...output, result: { ...output.result, error: `${output.result.error} ${repeatedFailureHint(call)}` } };
            } else {
              failing = undefined;
            }
          }
          const line = step(`${label}${toolResultSummary(label, output.result)}`);
          // A copy of the first call's verdict shows nothing that the first did not.
          const shown = copied ? undefined : evidenceOf(call, output.result);
          if (shown) evidence.push({ ...shown, callId: callIds[index]! });
          const sent = { ...output.result, tool_turns_left: turnsLeft };
          answers.push({ call, result: sent, files: output.files });
          const outcome: ToolOutcome = judged ?? (call.problem ? "error" : refusal ? "refused" : typeof output.result.error === "string" ? "error" : "ok");
          endTool(index, outcome, sent, line, shown);
        }
        // A listener of a read that went on after its call returned (its progress).
        if (listenerError) throw listenerError.error;
      } catch (error) {
        // The calls of the turn still waiting for a slot, or running, stop.
        halt.abort(error);
        failTurn(error);
        throw error;
      }
      for (const [offset, call] of reply.calls.slice(maxCalls).entries()) {
        callsAnswered++;
        const sent = { error: `Not run: one turn runs at most ${maxCalls} tool calls. Send this call again if you still need it.`, tool_turns_left: turnsLeft };
        answers.push({ call, result: sent, files: [] });
        if (events.active) {
          startTool(maxCalls + offset, call, labelOf(call));
          endTool(maxCalls + offset, "not_run", sent);
        }
      }
      const notRun = reply.calls.length - maxCalls;
      if (notRun > 0) step(`${notRun} more tool ${notRun === 1 ? "call in this turn was" : "calls in this turn were"} not run (at most ${maxCalls} a turn)`, "calls_not_run");
      const done: ModelToolRound = { ...pending, answers };
      if (reply.raw !== undefined) rawOwner.set(done, toolModel);
      messages.push(done);
    }

    // Out of tool turns or of room, or the last turn had no text (cut off, or a malformed tool call):
    // ask once more, for an answer in text. A blocked prompt would only be blocked again.
    // With an explorer model this request is always made: it is the one the answering model gets.
    if (!answered && !blockReason) {
      activity("writing_answer", "Writing the answer…");
      // With view_pages alone, the files are in the prompt and the pages were looked at. With the
      // text tools, the answer comes from what they returned, and from the files sent whole too when
      // their lines can be cited or their tables were counted: a model told "only what the tools
      // returned" said that a fact of a file shown in full was not there.
      const fromFiles = prepared.plan.inline.length > 0 && (numbered || toolable.length > 0);
      let closing = searchable.length === 0 && toolable.length === 0 ? FINAL_ANSWER_AFTER_PAGES : fromFiles ? FINAL_ANSWER_WITH_FILES : FINAL_ANSWER_REQUEST;
      // No tool ran (the explorer needed none, the first reply was empty, or no turn was left for
      // tools): there is no tool result to answer from. The answering model gets the explorer's
      // calls and what they returned, and nothing else of it.
      if (callsAnswered === 0) closing = FINAL_ANSWER_WITHOUT_TOOLS;
      const answerRequest = (note?: string) => (): ModelRequest => ({
        system,
        messages: [...viewFor(model), { role: "user", parts: [{ text: closing }, ...(note ? [{ text: note }] : [])] }],
        tools: declarations,
        toolChoice: "none",
      });
      let reply = await send(model, answerRequest(), true, { role: "answer", purpose: "closing" });
      // A reply with no text (empty, or a tool call the model was told not to make, or one that
      // could not be read) is asked for once more, with a note that is not kept: otherwise the
      // question ends with nothing to show. Not after a refusal, a filter or another reason that
      // asking again does not mend ("other"), which would come again, nor a reply cut off at the
      // output limit with nothing in it, nor when it would pass a ceiling of the question: the
      // ceiling of input tokens looks ahead, as before each tool request, by what was spent and
      // what this request takes, as the meter counts it now. It is one of the second tries of the
      // question, and may be one request past `limits.toolTurns`, which counts the answer's first
      // request.
      const calledInstead = reply.calls.length > 0 || reply.finish === "malformed_call";
      const again = ceiling < Number.POSITIVE_INFINITY ? meter.current(viewFor(model)).tokens * scaleOf(model) : 0;
      const ceilingReached = spentTokens() + again > ceiling || (limits.requests !== undefined && usage.totals.requests >= limits.requests);
      if (!wrote(reply) && !reply.blockReason && reply.finish !== "filtered" && reply.finish !== "other" && (calledInstead || reply.finish !== "cut") && nudges < MOST_NUDGES) {
        if (ceilingReached) {
          budgetReached();
        } else {
          nudges++;
          step(calledInstead ? "The model called a tool instead of answering: it was asked again for the answer" : "The model's answer was empty: it was asked again", "answer_again");
          reply = await send(model, answerRequest(ANSWER_AGAIN_NOTE), true, { role: "answer", purpose: "answer_again" });
        }
      }
      answered = wrote(reply);
    }
    return answer(answered);
  } catch (error) {
    // What the question found and paid for until it failed, for the application to keep. The usage is
    // a copy: a part reader that went on after the question was stopped may still report its own.
    if (!(error instanceof Replan) && error !== null && typeof error === "object") keepPartial(error, state, { ...result(false), usage: structuredClone(usage.totals) });
    throw error;
  } finally {
    signal?.removeEventListener("abort", stopTools);
  }
}
