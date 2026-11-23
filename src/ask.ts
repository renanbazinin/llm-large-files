// The tool loop, for any model: plan the documents, offer the tools, run the calls within the
// limits of the request, and end with an answer. A provider is an adapter (see model.ts).
import { eventErrorOf, EventEmitter, eventStream, newRunId, type AskEvent, type DocumentRef, type EventResult, type EventStream, type NoticeCode, type RequestPurpose, type RequestRole, type ToolOutcome } from "./events.js";
import { evidenceOf, stubResult, type Evidence } from "./evidence.js";
import { isCutReply, until } from "./http.js";
import type { LargeFiles } from "./library.js";
import { Limiter } from "./limiter.js";
import {
  DocumentsNotFoundError,
  errorKindOf,
  laterResult,
  rateAllowanceOf,
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
import { estimateParts, REQUEST_BYTES_MARGIN } from "./plan.js";
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
import type { Budget, DocumentMeta, DocumentPlan, GenerateText, ToolCallHooks, ToolCallLimits, ToolOutput, ToolRequestEnd, ToolRequestHandle, ToolRequestStart, ToolResult } from "./types.js";

/** Sent (invisibly to the user) when the model must stop using tools and answer. */
export const FINAL_ANSWER_REQUEST = "Stop using tools now. Answer my question using only what the tools returned above, with line citations. Say plainly what you could not find. Answer in the language of my question.";
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
   * included. Once it is reached no more tools run and the next request is the answer; a
   * whole-file read that would pass it is refused. Unset: no ceiling.
   */
  inputTokens?: number;
  /** The same ceiling, on the number of model requests: the chat's and the part reads' together. */
  requests?: number;
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
   * or the same adapter as `model`: one model does both.
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
   * The conversation; the last message must be the user's question. Plain turns
   * (`{ role, text }`), the tool rounds an earlier question returned (`AskResult.toolTurns`), and
   * turns with parts in the provider's own form (`{ role, parts: [{ text }, { native }] }`).
   */
  messages: ChatMessage[];
  system?: string;
  /** The user asking. Documents ingested with a different owner are treated as missing. */
  owner?: string;
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
   * the question can be sent a file, and changes nothing for a library that keeps no originals.
   */
  viewPages?: boolean;
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
   * Put each tool result in its `tool.end` event (`result`), and the tool rounds in the result that
   * `run.finish` and `run.error` carry (`toolTurns`). Off by default: results hold the text of the
   * documents, and events are often sent on to a browser.
   */
  eventResults?: boolean;
  signal?: AbortSignal;
};

export type AskResult = {
  /**
   * Everything the model wrote, including any remark it made before calling a tool. With an
   * explorer model, only what the answering model wrote: the explorer's words are not shown.
   */
  text: string;
  /**
   * False when the model's last turn had no text: the prompt was blocked, the reply was cut off
   * before any text, or the model produced a malformed tool call. `text` may then be empty or
   * hold only an earlier remark, so show your own message instead of treating it as the answer.
   */
  answered: boolean;
  /** Why the provider refused the prompt, when it did. */
  blockReason?: string;
  /** Every tool step taken, in order (also delivered through `onStep`). */
  steps: string[];
  /** What each tool call showed the model: the document, and the lines or pages. In call order. */
  evidence: Evidence[];
  /**
   * The tool rounds of this question as plain JSON. Kept with the conversation and passed back in
   * `messages` between this question and its answer, they let a later question use what was
   * found here. Pages that were shown are not in them: only that they were.
   */
  toolTurns: ToolTurn[];
  /** Which documents went in whole and which were searched. */
  plan: DocumentPlan;
  /** The budget the question ran with: the library's, fitted to the models. */
  budget: Budget;
  /** Model requests made for the chat itself, an explorer model's among them (whole-document part reads not included). */
  turns: number;
  finishReason?: string;
  /** Tokens and requests of the whole question, part reads included, in all and for each model. */
  usage: UsageTotals;
  /** The provider's own usage object of the last chat response, as it came. */
  lastUsage?: Record<string, unknown>;
};

const DEFAULT_TOOL_TURNS = 12;
const DEFAULT_CALLS_PER_TURN = 8;
/** Tool calls of one turn that run at the same time. */
const CALLS_AT_ONCE = 4;
/** With less room than this for its result, a call is not run. */
const LEAST_ROOM_CHARACTERS = 1_500;
/** Characters of a tool result for each token of room. A log full of IDs and numbers comes to about two. */
const CHARACTERS_PER_TOKEN = 2;
/** Bytes a character of a tool result may take in the request. */
const BYTES_PER_CHARACTER = 3;
/** Tool rounds whose results are kept in full when older ones are dropped to make room. */
const ROUNDS_KEPT = [3, 2, 1];

const NO_ROOM = "Not run: there is no room left in this conversation for another tool result. Answer now, from what the tools returned so far.";
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
 * Refuses a stored tool round of a version this package does not read: one a newer version made
 * (`ToolTurn.version` above `TOOL_TURN_VERSION`). A round without a version (before 0.9.0) is read
 * as before. A `TypeError`, which an application can catch to leave such rounds out.
 */
function checkToolTurnVersion(turn: ToolTurn): void {
  const version: unknown = turn.version ?? 0;
  if (typeof version === "number" && version <= TOOL_TURN_VERSION) return;
  if (typeof version !== "number" || Number.isNaN(version)) {
    throw new TypeError(`A stored tool round (toolTurns) has a version that is not a number (${typeof version === "string" ? JSON.stringify(version) : String(version)}). Leave it out of messages, or store it as it was given.`);
  }
  throw new TypeError(`A stored tool round (toolTurns) has version ${String(version)}: a newer version of llm-large-files made it, and this one reads up to version ${TOOL_TURN_VERSION}. Leave it out of messages.`);
}

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
    return "parts" in message ? { role, parts: [...message.parts] } : { role, parts: [{ text: message.text }] };
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
        bytes += jsonBytes(part.text);
      } else {
        const size = (JSON.stringify(part.native) ?? "").length;
        bytes += size;
        // Media: about 258 tokens per image or PDF page; ~4 tokens/KB is a cautious stand-in.
        tokens += Math.ceil(size / 256);
      }
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
 * Shares `room` characters among tool calls whose results may be up to `caps` characters. A call
 * gets no more than its cap, and the others split what it leaves. Calls that cannot each get
 * `LEAST_ROOM_CHARACTERS` (or their cap, when it is smaller) are not run, the last ones first:
 * their share is undefined.
 */
export function shareRoom(caps: number[], room: number): Array<number | undefined> {
  const least = (cap: number) => Math.min(cap, LEAST_ROOM_CHARACTERS);
  let count = caps.length;
  let needed = caps.reduce((sum, cap) => sum + least(cap), 0);
  while (count > 0 && needed > room) needed -= least(caps[--count]!);
  const shares: Array<number | undefined> = caps.map(() => undefined);
  // The smallest caps first: each call takes its cap or an even share of what is left, whichever is less.
  const order = caps.slice(0, count).map((cap, index) => ({ cap, index })).sort((left, right) => left.cap - right.cap);
  let left = Math.max(0, Math.floor(room));
  order.forEach(({ cap, index }, position) => {
    const share = Math.min(cap, Math.floor(left / (order.length - position)));
    shares[index] = share;
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
  for (const field of ["toolTurns", "callsPerTurn", "wholeDocumentReads", "inputTokens", "requests"] as const) {
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
  const events = new EventEmitter<AskEvent>(options.runId ?? newRunId(), options.onEvent);
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
    if (events.active) events.emit({ type: "run.finish", result: eventResultOf(result, options.eventResults === true) });
    return result;
  } catch (error) {
    if (events.active) {
      // The question's own, also when another question threw the same error (a shared signal's reason).
      const partial = state.failed && state.failed.error === error ? state.failed.result : partialResultOf(error);
      events.emit({ type: "run.error", error: eventErrorOf(error), ...(partial ? { partial: eventResultOf(partial, options.eventResults === true) } : {}) });
    }
    throw error;
  }
}

/**
 * A result as `run.finish` and `run.error` carry it: a copy, so that a listener cannot change the
 * caller's, without the tool rounds and with the plan naming documents only (both hold text of
 * the documents: tool results, outline headings, the commonest lines of a log) unless `withTurns`.
 */
function eventResultOf(result: AskResult, withTurns: boolean): EventResult {
  if (withTurns) return { ...result };
  const { toolTurns: _toolTurns, plan, ...rest } = result;
  return { ...rest, plan: { inline: plan.inline.map(documentRef), searchable: plan.searchable.map(documentRef) } };
}

/**
 * `askWithFiles` as a stream of its events, for a page that shows the question as it goes: see
 * `AskEvent`. Leaving the loop early (`break`) stops the question. `result` is what `askWithFiles`
 * returns. `onEvent`, when given, gets each event too, after the stream. The model is asked for
 * the answer as it is written unless `streamText` is false. New in 0.7.0.
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
  // A second model for the requests that use tools. The answering model itself is not one.
  const explorer = options.explorer && options.explorer !== model ? options.explorer : undefined;
  const toolModel = explorer ?? model;
  const models = explorer ? [model, explorer] : [model];
  const limits = checkedLimits(options.limits);
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
  // A value the type does not have (left out by an adapter in JavaScript) counts as "none".
  const canShowFiles = models.every((adapter) => adapter.capabilities.toolFiles === "inside" || adapter.capabilities.toolFiles === "beside");
  // Every model must be able to take a conversation whose earlier turns were made shorter.
  const canShrink = models.every((adapter) => !adapter.capabilities.appendOnly);
  // A call made again is answered with a pointer to its earlier result only while that result stays
  // in the conversation: a provider that clears old tool results on its side may have removed it.
  const canPoint = models.every((adapter) => !adapter.capabilities.clearsToolResults);

  const messages = toMessages(options.messages);
  const meter = new RequestMeter(pageTokens);
  const asText = textSize(messages, options.system);
  const earlier = meter.rounds(messages);
  const prepared = await files.prepare(options.documentIds, { tokens: asText.tokens + earlier.tokens, bytes: asText.bytes + earlier.bytes }, {
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    viewPages: options.viewPages !== false && canShowFiles,
    // The guide and the cards name `analyze_whole_document` only when the tools will have it.
    wholeDocumentAnalysis: options.wholeDocumentAnalysis !== false && typeof toolModel.generateText === "function",
    budget,
  });
  if (prepared.missing.length) throw new DocumentsNotFoundError(prepared.missing);

  const blocks = [...new Set(options.documentIds)].map((id) => prepared.blocks.get(id)).filter((block): block is string => Boolean(block));
  if (blocks.length) {
    const block = { text: blocks.join("\n\n") };
    if (options.documentPlacement === "last") (messages.at(-1) as ModelTextMessage).parts.push(block);
    // The last turn is the user's, so there is always a first user turn.
    else (messages.find((message) => message.role === "user") as ModelTextMessage).parts.unshift(block);
  }
  const system = [options.system?.trim(), prepared.instruction].filter(Boolean).join("\n\n");

  // The size of what stays in every request: the text as asked, the documents, the tool guide.
  const whole = new Set(prepared.plan.inline.map((meta) => meta.id));
  meter.fixed = {
    tokens: asText.tokens + prepared.plan.inlineTokens + estimateTokens(prepared.instruction),
    bytes: asText.bytes + prepared.plan.inlineBytes + jsonBytes(prepared.instruction),
  };
  for (const [id, block] of prepared.blocks) {
    if (whole.has(id)) continue;
    meter.fixed.tokens += estimateTokens(block);
    meter.fixed.bytes += jsonBytes(block);
  }

  let text = "";
  let turns = carried?.turns ?? 0;
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  let lastUsage: Record<string, unknown> | undefined;
  const steps: string[] = [];
  const evidence: Evidence[] = [];
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
  const notice = (code: NoticeCode, message: string) => events.emit({ type: "notice", code, message, display: "none" });
  const budgetReached = () => {
    if (state.budgetSaid) return;
    state.budgetSaid = true;
    notice("budget_reached", BUDGET_REACHED);
  };
  // What a first try that was planned again showed is part of this question; then why it was planned again.
  steps.push(...carried?.steps ?? []);
  if (carried) step(carried.step, "replanned");
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
    // Text the adapter did not pass on as it came (no streaming was asked for, or it cannot).
    if (shown && reply.text.length > got.length && reply.text.startsWith(got)) write(reply.text.slice(got.length));
    answeredRequests++;
    usage.add(adapter.id, reply.usage);
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
    });
    if (reply.blockReason) notice("blocked", `The provider refused the prompt: ${reply.blockReason}.`);
    return reply;
  };
  // What a model wrote before it was stopped by a refusal is not an answer.
  const wrote = (reply: ModelReply) => reply.text.trim().length > 0 && !reply.blockReason;

  const asked = messages.length;
  const result = (answered: boolean): AskResult => ({
    text,
    answered,
    ...(blockReason ? { blockReason } : {}),
    steps,
    evidence,
    // The rounds as the model last had them. A file cannot be kept as JSON: what is kept says that it was shown.
    toolTurns: messages.slice(asked).filter(isRound).map((round) => ({
      role: "tools" as const,
      version: TOOL_TURN_VERSION,
      calls: round.answers.map(({ call: { problem: _problem, ...call }, result: returned, files: shownFiles }) => ({
        ...call,
        result: shownFiles?.length ? stubResult(call, returned, true) ?? returned : returned,
      })),
    })),
    plan: prepared.plan,
    budget,
    turns,
    ...(finishReason ? { finishReason } : {}),
    usage: usage.totals,
    ...(lastUsage ? { lastUsage } : {}),
  });

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
  /** Characters of tool results that still fit, with a model turn that is about to be answered. */
  const room = (pending: ModelToolRound): number => {
    const now = meter.current([...messages, pending]);
    return Math.floor(Math.min((tokenLimit - now.tokens) * CHARACTERS_PER_TOKEN, (byteLimit - now.bytes) / BYTES_PER_CHARACTER));
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
              .some((read) => alreadyShown(answer.call, read.answer, read.index < asked && read.question !== question) !== undefined)));
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
        } else if (key !== undefined && alreadyShown(answer.call, answer) !== undefined) {
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
    const refused = error as { limitTokens?: number; requestedTokens?: number };
    const own = scaleOf(adapter);
    meter.overflowed(meter.estimate(sent.messages).tokens, refused.requestedTokens !== undefined ? refused.requestedTokens / own : undefined);
    if (refused.limitTokens !== undefined) {
      tokenLimit = Math.min(tokenLimit, Math.floor(refused.limitTokens / own) - replyTokens - Math.floor(reservedTokens / 2));
    }
    if (!canShrink) return false;
    let changed = false;
    for (const keep of [...ROUNDS_KEPT, 0]) {
      if (changed && meter.current(messages).tokens <= tokenLimit) break;
      if (shrink(keep)) changed = true;
    }
    return changed;
  };
  /**
   * The window to plan the documents for again, in the models' tokens, after the first request was
   * refused as too large: the one the provider named, made smaller by how much more than the
   * estimate it counted. Without its numbers, seven tenths of the window the budget assumed.
   */
  const smallerWindow = (adapter: ModelAdapter, sent: ModelRequest, error: unknown): { contextTokens: number; step: string } => {
    const refused = error as { limitTokens?: number; requestedTokens?: number };
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
    for (let again = false; ; again = true) {
      const body = build();
      try {
        return await request(adapter, body, shown, kind);
      } catch (error) {
        if (errorKindOf(error) !== "context_overflow" || signal?.aborted) throw error;
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
          throw new Replan({ usage, steps: [...steps], turns, answered: answeredRequests, nudges, recoveries, contextTokens: smaller.contextTokens, step: smaller.step }, error, result(false));
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
    // Tools are needed for a file that is too large to send whole, and for a PDF whose pages can be
    // looked at: that one may have its whole text in the prompt and still hide a chart from the model.
    const { searchable } = prepared.plan;
    const { viewable } = prepared;
    if (searchable.length === 0 && viewable.length === 0) return result(wrote(await send(model, () => ({ system, messages }), true, { role: "answer", purpose: "direct" })));

    // Reading a whole file in parts is exploring too: the explorer model's work, when there is one.
    // Bound to its adapter: a class with a `generateText` method that uses `this` keeps it.
    const partReader = options.wholeDocumentAnalysis === false ? undefined : toolModel.generateText?.bind(toolModel);
    const generate: GenerateText | undefined = partReader && (async (part) => {
      let reported = false;
      const text = await partReader({
        ...part,
        onUsage: (used) => {
          reported = true;
          usage.add(toolModel.id, used);
          part.onUsage?.(used);
        },
      });
      // A part reader that does not report its usage (`onUsage` is optional) still made a request,
      // and `limits.requests` counts it.
      if (!reported) usage.add(toolModel.id, undefined);
      return text;
    });
    const tools = files.tools(searchable, {
      ...(generate ? { generate } : {}),
      onProgress: (event) => options.onActivity?.(`${event.message}…`),
      signal: halt.signal,
      ...(viewable.length > 0 ? { viewPages: viewable } : {}),
      maxWholeDocumentReads: limits.wholeDocumentReads ?? MAX_WHOLE_DOCUMENT_READS,
      ...(options.retry ? { retry: options.retry } : {}),
      budget,
    });
    const declarations = tools.declarations;
    // The requests that use the tools are the chat's own, or an explorer model's: the same
    // conversation, and a line that says what its part is.
    const toolSystem = explorer ? `${system}\n\n${EXPLORER_INSTRUCTION}` : system;
    const sentTools = JSON.stringify(declarations);
    meter.fixed.tokens += estimateTokens(sentTools) + (explorer ? estimateTokens(EXPLORER_INSTRUCTION) : 0);
    meter.fixed.bytes += Buffer.byteLength(sentTools) + (explorer ? EXPLORER_INSTRUCTION.length : 0);
    if (searchable.length > 0) activity("searching_instead", `Too large to read at once: ${searchable.map((meta) => meta.name).join(", ")}. Searching instead…`);

    const maxTurns = Math.max(1, Math.trunc(limits.toolTurns ?? DEFAULT_TOOL_TURNS));
    const maxCalls = Math.max(1, Math.trunc(limits.callsPerTurn ?? DEFAULT_CALLS_PER_TURN));
    /** True once the question has used what it may: no more tools run. One request is kept for the answer. */
    const spent = (): boolean => (
      (limits.inputTokens !== undefined && usage.totals.inputTokens >= limits.inputTokens)
      || (limits.requests !== undefined && usage.totals.requests >= limits.requests - 1)
    );
    /**
     * A whole-file read is many requests at once: one that would pass a ceiling of the question is
     * not started. `reserved` is what the reads already let through in this turn will take: they run
     * together, and the totals do not show them yet.
     */
    const tooCostly = (call: ToolCall, reserved: { inputTokens: number; requests: number; reads: Map<string, number> }): { refusal?: string; own?: number } => {
      if (call.name !== TOOL_NAMES.analyze) return {};
      const meta = searchable.find((document) => document.id === call.args.document_id);
      if (!meta) return {};
      // A read of a document read whole as often as it may be is refused by the tool, at no cost: it
      // takes nothing from the reads of other documents.
      const before = evidence.filter((shown) => shown.whole && shown.documentId === meta.id).length + (reserved.reads.get(meta.id) ?? 0);
      if (before >= (limits.wholeDocumentReads ?? MAX_WHOLE_DOCUMENT_READS)) return {};
      // The parts are read by the model that explores, in its own tokens.
      const tokens = Math.ceil(meta.estimatedTokens * scaleOf(toolModel));
      // The parts, a merge of their notes, the answer of the read, and the answer of the question.
      const requests = estimateParts(meta, budget) + 3;
      if (limits.inputTokens !== undefined) {
        const left = Math.max(0, limits.inputTokens - usage.totals.inputTokens - reserved.inputTokens);
        if (tokens > left) return { refusal: `Not run: reading all of ${meta.name} takes about ${count(tokens)} input tokens, and ${count(left)} are left of the ${count(limits.inputTokens)} this question may use. Use search_document and read_document.` };
      }
      if (limits.requests !== undefined) {
        const left = Math.max(0, limits.requests - usage.totals.requests - reserved.requests);
        if (requests > left) return { refusal: `Not run: reading all of ${meta.name} takes about ${count(requests)} model requests, and ${count(left)} are left of the ${count(limits.requests)} this question may make. Use search_document and read_document.` };
      }
      reserved.inputTokens += tokens;
      // The answer of the question is one request, whatever number of reads come before it.
      reserved.requests += requests - 1;
      reserved.reads.set(meta.id, (reserved.reads.get(meta.id) ?? 0) + 1);
      // The read's own requests: its parts, a merge of their notes, and its answer.
      return { own: requests - 1 };
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
          const pointer = alreadyShown(call, answer, at < asked);
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
        const empty = !reply.text.trim() && callsAnswered === 0 && reply.finish !== "cut" && reply.finish !== "filtered";
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
        // Neither is anything an explorer model writes: the answer is asked for below.
        answered = wrote(reply) && !explorer;
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
      // The calls that return text, and the most they may return: a call that is refused, or
      // answered with a pointer to what is already shown, needs no room.
      const sized = planned.filter((plan) => !plan.refusal && !plan.pointer && plan.call.name !== TOOL_NAMES.view);
      const needed = sized.reduce((sum, plan) => sum + most(plan.call), 0);
      let left = room(pending);
      let dropped = false;
      for (const keep of canShrink ? ROUNDS_KEPT : []) {
        if (left >= needed) break;
        if (shrink(keep)) {
          dropped = true;
          left = room(pending);
        }
      }
      if (dropped) {
        step("Older tool results were shortened to make room in the request", "results_shortened");
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
      const shares = shareRoom(runsNow.map((plan) => most(plan.call)), left);
      runsNow.forEach((plan, index) => {
        const share = shares[index];
        const cap = most(plan.call);
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
            const output = await tools.executeWithFiles(call.name, call.args, { maxFileBytes: Math.floor((maxRequestBytes - bytesKeptFree - requestBytes) * 3 / 4), maxPages: pagesLeft });
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
            return await tools.executeWithFiles(call.name, call.args, callLimits, hooksFor(index));
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
         * The room of each whole-file read of the turn: what the other results left, shared among the
         * reads, the smaller answers first. Worked out when the first of them is reached, by which time
         * the other calls, which are quick, have most often returned.
         */
        let lateRoom: Map<number, number> | undefined;
        const roomOfReads = async (): Promise<Map<number, number>> => {
          const sizes = await Promise.all(outputs.map(async (output) => JSON.stringify((await output).result).length));
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

        // The answers in call order. Each call's `tool.end` goes out here, in the same order.
        for (const [index, { call, label, late, refusal, pointer }] of planned.entries()) {
          let output = await outputs[index]!;
          if (listenerError) throw listenerError.error;
          callsAnswered++;
          if (late) {
            lateRoom ??= await roomOfReads();
            const share = lateRoom.get(index)!;
            if (JSON.stringify(output.result).length > share) output = { ...output, result: fitAnswer(output.result, Math.max(LEAST_RESULT_CHARACTERS, share)) };
          }
          if (pointer) {
            const line = step(`${label} — already shown above`);
            const sent = { ...output.result, tool_turns_left: turnsLeft };
            answers.push({ call, result: sent, files: [] });
            endTool(index, "already_shown", sent, line);
            continue;
          }
          // Two searches in a row that failed in the same mode: the second says to try another way.
          if (!refusal) {
            const kind = failureKind(call);
            if (kind === undefined) {
              failing = undefined;
            } else if (typeof output.result.error === "string") {
              failing = failing?.kind === kind ? { kind, count: failing.count + 1 } : { kind, count: 1 };
              if (failing.count >= 2) output = { ...output, result: { ...output.result, error: `${output.result.error} ${repeatedFailureHint(call)}` } };
            } else {
              failing = undefined;
            }
          }
          const line = step(`${label}${toolResultSummary(label, output.result)}`);
          const shown = evidenceOf(call, output.result);
          if (shown) evidence.push({ ...shown, callId: callIds[index]! });
          const sent = { ...output.result, tool_turns_left: turnsLeft };
          answers.push({ call, result: sent, files: output.files });
          const outcome: ToolOutcome = call.problem ? "error" : refusal ? "refused" : typeof output.result.error === "string" ? "error" : "ok";
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
      let closing = searchable.length > 0 ? FINAL_ANSWER_REQUEST : FINAL_ANSWER_AFTER_PAGES;
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
      // question ends with nothing to show. Not after a refusal or a filter, which would come again,
      // nor a reply cut off at the output limit with nothing in it, nor once a ceiling of `limits`
      // is reached. It is one of the second tries of the question, and may be one request past
      // `limits.toolTurns`, which counts the answer's first request.
      const calledInstead = reply.calls.length > 0 || reply.finish === "malformed_call";
      const ceilingReached = (limits.inputTokens !== undefined && usage.totals.inputTokens >= limits.inputTokens)
        || (limits.requests !== undefined && usage.totals.requests >= limits.requests);
      if (!wrote(reply) && !reply.blockReason && reply.finish !== "filtered" && (calledInstead || reply.finish !== "cut") && nudges < MOST_NUDGES) {
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
    return result(answered);
  } catch (error) {
    // What the question found and paid for until it failed, for the application to keep. The usage is
    // a copy: a part reader that went on after the question was stopped may still report its own.
    if (!(error instanceof Replan) && error !== null && typeof error === "object") keepPartial(error, state, { ...result(false), usage: structuredClone(usage.totals) });
    throw error;
  } finally {
    signal?.removeEventListener("abort", stopTools);
  }
}
