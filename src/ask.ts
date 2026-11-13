// The tool loop, for any model: plan the documents, offer the tools, run the calls within the
// limits of the request, and end with an answer. A provider is an adapter (see model.ts).
import { evidenceOf, stubResult, type Evidence } from "./evidence.js";
import type { LargeFiles } from "./library.js";
import { Limiter } from "./limiter.js";
import {
  DocumentsNotFoundError,
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
import { estimateParts, REQUEST_BYTES_MARGIN } from "./plan.js";
import { statusOf, withRetry, type RetryNotice, type RetryOptions } from "./retry.js";
import { estimateTokens, jsonBytes } from "./text.js";
import { MAX_WHOLE_DOCUMENT_READS, TOOL_NAMES, toolResultSummary } from "./tools.js";
import type { Budget, DocumentPlan, GenerateText, ToolCallLimits, ToolOutput, ToolResult } from "./types.js";

/** Sent (invisibly to the user) when the model must stop using tools and answer. */
export const FINAL_ANSWER_REQUEST = "Stop using tools now. Answer my question using only what the tools returned above, with line citations. Say plainly what you could not find.";
/** The same, when the only tool was `view_pages`: the text of the files is in the prompt, not in tool results. */
export const FINAL_ANSWER_AFTER_PAGES = "Stop using tools now. Answer my question from the text of the files and the pages you looked at. Say plainly what you could not see or find.";
/** Sent to the answering model when an explorer model used no tool, so there is no tool result to answer from. */
export const FINAL_ANSWER_WITHOUT_TOOLS = "Answer my question now, from what is in this conversation. No tools are available for this reply: if the answer needs a part of a file that is not shown here, say so plainly.";
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
   * the explorer has one less than this.
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
  /** Offer `analyze_whole_document`, which reads a whole file in many model calls. Defaults to true. */
  wholeDocumentAnalysis?: boolean;
  /**
   * Offer `view_pages` for PDFs whose original file is kept (`keepOriginals`), so the model can
   * look at pictures, charts and layout. Defaults to true. It is offered only when every model of
   * the question can be sent a file, and changes nothing for a library that keeps no originals.
   */
  viewPages?: boolean;
  /** Answer text as it arrives. The adapter streams when this is set and it can. */
  onText?: (delta: string) => void;
  /** Short-lived status, such as "Searching app.log for “timeout”…". */
  onActivity?: (text: string) => void;
  /** A finished step, such as "Search app.log (exact) for “timeout” — 12 matching lines". */
  onStep?: (text: string) => void;
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

type Size = { tokens: number; bytes: number };

const count = (value: number) => Math.max(0, Math.round(value)).toLocaleString("en-US");
const isRound = (message: ModelMessage): message is ModelToolRound => message.role === "tools";

/** How many pages a `view_pages` result showed: its `pages` is "12" or "12-14". */
function pagesShown(result: ToolResult): number {
  const [first, last] = String(result.pages ?? "").split("-").map(Number);
  return Number.isFinite(first) ? (Number.isFinite(last) ? last! - first! + 1 : 1) : 0;
}

/** The conversation as the loop keeps it: copies, so that nothing of the caller's is changed. */
function toMessages(given: ChatMessage[]): ModelMessage[] {
  const messages = given.map((message): ModelMessage => {
    if (message.role === "tools") {
      const answers = message.calls.map(({ result, ...call }) => ({ call, result }));
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

  /** Takes note of what the provider counted for a request that was estimated at `estimated` tokens. */
  observe(estimated: number, counted: number | undefined): void {
    if (estimated > 0 && typeof counted === "number" && counted > 0) this.factor = Math.min(2, Math.max(1, counted / estimated));
  }
}

function retryMessage({ error, delayMs }: RetryNotice): string {
  const status = statusOf(error);
  const seconds = delayMs >= 1_000 ? ` in ${Math.round(delayMs / 1_000)} s` : "";
  return `${status ? `The model did not answer (HTTP ${status})` : "The model could not be reached"}. Trying again${seconds}…`;
}

/**
 * Answers a chat turn about large documents with any model that has an adapter.
 * Documents that fit go into the prompt whole; otherwise the model gets search and read tools and
 * this runs the tool loop, ending with a request that must be answered in text, so there is always
 * an answer. With an `explorer`, that model runs the tool loop and `model` writes the answer.
 */
export async function askWithFiles(options: AskOptions): Promise<AskResult> {
  const { files, model, signal } = options;
  // A second model for the requests that use tools. The answering model itself is not one.
  const explorer = options.explorer && options.explorer !== model ? options.explorer : undefined;
  const toolModel = explorer ?? model;
  const models = explorer ? [model, explorer] : [model];
  const limits = options.limits ?? {};
  const usage = new UsageMeter();

  // The budget is counted in the library's estimate of tokens. A model whose tokenizer counts
  // more of them for the same text has, in those terms, a smaller window.
  const scale = Math.max(...models.map((adapter) => (adapter.capabilities.tokenScale && adapter.capabilities.tokenScale > 0 ? adapter.capabilities.tokenScale : 1)));
  const declared = (pick: (adapter: ModelAdapter) => number | undefined): number[] => models.map(pick).filter((value): value is number => typeof value === "number" && value > 0);
  const own = files.budgetFor(options.budget);
  const windowTokens = Math.floor(Math.min(own.contextTokens, ...declared((adapter) => adapter.capabilities.contextTokens)) / scale);
  // A reply that is counted against the window: that part of it is not there for the prompt.
  const replyTokens = Math.ceil(Math.max(0, ...declared((adapter) => adapter.capabilities.outputTokens)) / scale);
  const requestBytesLimit = declared((adapter) => adapter.capabilities.maxRequestBytes);
  const budget = files.budgetFor(options.budget, {
    contextTokens: Math.max(Math.floor(windowTokens / 4), windowTokens - replyTokens),
    ...(requestBytesLimit.length > 0 ? { maxRequestBytes: Math.min(...requestBytesLimit) } : {}),
  });
  // What a page costs, in the same terms. Pages are shown to every model of the question.
  const pageTokens = Math.max(1, ...models.map((adapter) => adapter.capabilities.pageTokens)) / scale;
  const canShowFiles = models.every((adapter) => adapter.capabilities.toolFiles !== "none");
  // Every model must be able to take a conversation whose earlier turns were made shorter.
  const canShrink = models.every((adapter) => !adapter.capabilities.appendOnly);

  const messages = toMessages(options.messages);
  const meter = new RequestMeter(pageTokens);
  const asText = textSize(messages, options.system);
  const earlier = meter.rounds(messages);
  const prepared = await files.prepare(options.documentIds, { tokens: asText.tokens + earlier.tokens, bytes: asText.bytes + earlier.bytes }, {
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    viewPages: options.viewPages !== false && canShowFiles,
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
  let turns = 0;
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  let lastUsage: Record<string, unknown> | undefined;
  const steps: string[] = [];
  const evidence: Evidence[] = [];
  const emit = (delta: string) => {
    text += delta;
    options.onText?.(delta);
  };
  const step = (line: string) => {
    steps.push(line);
    options.onStep?.(line);
  };

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
  const viewFor = (adapter: ModelAdapter, list: ModelMessage[] = messages): ModelMessage[] => list.map((message) => (
    isRound(message) && message.raw !== undefined && rawOwner.get(message) !== adapter ? callsOnly(message) : message
  ));

  /**
   * One model request of the chat. Text is passed on as it arrives when it is `shown`: an
   * explorer's words are not, because the answer comes from the other model. A request that
   * failed is sent again by the rule of `retry`, unless text of it was already shown.
   */
  const request = async (adapter: ModelAdapter, body: ModelRequest, shown: boolean): Promise<ModelReply> => {
    turns++;
    let separated = text.length === 0;
    let got = "";
    const write = (delta: string) => {
      if (!delta) return;
      if (!separated) {
        emit("\n\n");
        separated = true;
      }
      got += delta;
      emit(delta);
    };
    const estimated = meter.estimate(body.messages).tokens;
    const reply = await withRetry(() => adapter.send(body, {
      ...(signal ? { signal } : {}),
      ...(shown && options.onText ? { onText: write } : {}),
    }), {
      retry: options.retry,
      signal,
      canRetry: () => got.length === 0,
      onRetry: (notice) => options.onActivity?.(retryMessage(notice)),
    });
    // Text the adapter did not pass on as it came (no streaming was asked for, or it cannot).
    if (shown && reply.text.length > got.length && reply.text.startsWith(got)) write(reply.text.slice(got.length));
    usage.add(adapter.id, reply.usage);
    meter.observe(estimated, typeof reply.usage?.inputTokens === "number" ? reply.usage.inputTokens / scale : undefined);
    if (reply.blockReason) blockReason = reply.blockReason;
    finishReason = reply.finishReason ?? finishReason;
    lastUsage = reply.providerUsage ?? lastUsage;
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

  // Tools are needed for a file that is too large to send whole, and for a PDF whose pages can be
  // looked at: that one may have its whole text in the prompt and still hide a chart from the model.
  const { searchable } = prepared.plan;
  const { viewable } = prepared;
  if (searchable.length === 0 && viewable.length === 0) return result(wrote(await request(model, { system, messages }, true)));

  // Reading a whole file in parts is exploring too: the explorer model's work, when there is one.
  const partReader = options.wholeDocumentAnalysis === false ? undefined : toolModel.generateText;
  const generate: GenerateText | undefined = partReader && ((part) => partReader({
    ...part,
    onUsage: (used) => {
      usage.add(toolModel.id, used);
      part.onUsage?.(used);
    },
  }));
  const tools = files.tools(searchable, {
    ...(generate ? { generate } : {}),
    onProgress: (event) => options.onActivity?.(`${event.message}…`),
    ...(signal ? { signal } : {}),
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
  if (searchable.length > 0) options.onActivity?.(`Too large to read at once: ${searchable.map((meta) => meta.name).join(", ")}. Searching instead…`);

  // Pages the model looks at stay in the request until the question is answered, so they are
  // counted twice: as bytes against the request limit, and as tokens against half of what the
  // budget keeps free for tool results and the answer.
  const { maxRequestBytes, reservedTokens } = budget;
  const bytesKeptFree = Math.max(REQUEST_BYTES_MARGIN, Math.floor(maxRequestBytes / 10));
  let pagesLeft = Math.floor(reservedTokens / 2 / pageTokens);
  // The results of the text tools may fill the context window up to half of what is kept free (the
  // other half is the answer's), and the request up to a small margin.
  const tokenLimit = budget.contextTokens - Math.floor(reservedTokens / 2);
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
    return changed;
  };

  const maxTurns = Math.max(1, Math.trunc(limits.toolTurns ?? DEFAULT_TOOL_TURNS));
  const maxCalls = Math.max(1, Math.trunc(limits.callsPerTurn ?? DEFAULT_CALLS_PER_TURN));
  /** True once the question has used what it may: no more tools run. One request is kept for the answer. */
  const spent = (): boolean => (
    (limits.inputTokens !== undefined && usage.totals.inputTokens >= limits.inputTokens)
    || (limits.requests !== undefined && usage.totals.requests >= limits.requests - 1)
  );
  /** A whole-file read is many requests at once: one that would pass a ceiling of the question is not started. */
  const tooCostly = (call: ToolCall): string | undefined => {
    if (call.name !== TOOL_NAMES.analyze) return undefined;
    const meta = searchable.find((document) => document.id === call.args.document_id);
    if (!meta) return undefined;
    if (limits.inputTokens !== undefined) {
      const cost = Math.ceil(meta.estimatedTokens * scale);
      const left = limits.inputTokens - usage.totals.inputTokens;
      if (cost > left) return `Not run: reading all of ${meta.name} takes about ${count(cost)} input tokens, and ${count(left)} are left of the ${count(limits.inputTokens)} this question may use. Use search_document and read_document.`;
    }
    if (limits.requests !== undefined) {
      // The parts, a merge of their notes, the answer of the read, and the answer of the question.
      const cost = estimateParts(meta, budget) + 3;
      const left = limits.requests - usage.totals.requests;
      if (cost > left) return `Not run: reading all of ${meta.name} takes about ${count(cost)} model requests, and ${count(left)} are left of the ${count(limits.requests)} this question may make. Use search_document and read_document.`;
    }
    return undefined;
  };

  let answered = false;
  let outOfRoom = false;
  // Tools run in at most maxTurns - 1 requests. The last request is the one below that must be
  // answered in text, so a model that never stops calling tools does not cost a request whose
  // calls are thrown away.
  for (let round = 1; round < maxTurns && !outOfRoom && !spent(); round++) {
    const reply = await request(toolModel, { system: toolSystem, messages: viewFor(toolModel), tools: declarations, toolChoice: "auto" }, !explorer);
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
    const needed = run.reduce((sum, call) => sum + (call.name === TOOL_NAMES.view ? 0 : most(call)), 0);
    let left = room(pending);
    let dropped = false;
    for (const keep of canShrink ? ROUNDS_KEPT : []) {
      if (left >= needed) break;
      if (shrink(keep)) {
        dropped = true;
        left = room(pending);
      }
    }
    if (dropped) step("Older tool results were shortened to make room in the request");

    type Planned = { call: ToolCall; label: string; refusal?: string; limits?: ToolCallLimits };
    const planned = run.map((call): Planned => {
      const label = tools.has(call.name) ? tools.describe(call.name, call.args) : call.name;
      // A call that did not arrive whole is not run: the model is told, and can send it again.
      if (call.problem) return { call, label, refusal: call.problem };
      // A look at pages returns a file and a few words: the file has its own room, worked out when it runs.
      if (call.name === TOOL_NAMES.view) return { call, label };
      const refusal = tooCostly(call);
      if (refusal) return { call, label, refusal };
      const cap = most(call);
      if (left < Math.min(cap, LEAST_ROOM_CHARACTERS)) {
        outOfRoom = true;
        return { call, label, refusal: NO_ROOM };
      }
      const allowed = Math.min(cap, left);
      left -= allowed;
      return { call, label, ...(allowed < cap ? { limits: { maxResultCharacters: allowed } } : {}) };
    });

    // The calls of a turn run together, a few at a time. Looks at pages take their turns, one
    // after another: each is given the room the ones before it left.
    const together = new Limiter(CALLS_AT_ONCE);
    let looks: Promise<unknown> = Promise.resolve();
    // The size of the request as it stands, worked out when the first look at pages in this turn needs it.
    let requestBytes: number | undefined;
    const outputs = planned.map(({ call, label, refusal, limits: callLimits }): Promise<ToolOutput> => {
      if (refusal) return Promise.resolve({ result: { error: refusal }, files: [] });
      if (call.name === TOOL_NAMES.view) {
        const look = looks.then(async () => {
          signal?.throwIfAborted();
          options.onActivity?.(`${label}…`);
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
      return together.acquire(signal).then(async (release) => {
        try {
          options.onActivity?.(`${label}…`);
          return await tools.executeWithFiles(call.name, call.args, callLimits);
        } finally {
          release();
        }
      });
    });
    // One that fails (the question was stopped) is reported below, in call order; the others must not go unheard.
    for (const output of outputs) output.catch(() => undefined);

    const turnsLeft = outOfRoom ? 0 : maxTurns - round - 1;
    const answers: ToolAnswer[] = [];
    for (const [index, { call, label }] of planned.entries()) {
      const output = await outputs[index]!;
      step(`${label}${toolResultSummary(label, output.result)}`);
      const shown = evidenceOf(call, output.result);
      if (shown) evidence.push(shown);
      answers.push({ call, result: { ...output.result, tool_turns_left: turnsLeft }, files: output.files });
    }
    for (const call of reply.calls.slice(maxCalls)) {
      answers.push({ call, result: { error: `Not run: one turn runs at most ${maxCalls} tool calls. Send this call again if you still need it.`, tool_turns_left: turnsLeft }, files: [] });
    }
    if (reply.calls.length > maxCalls) step(`${reply.calls.length - maxCalls} more tool calls in this turn were not run (at most ${maxCalls} a turn)`);
    const done: ModelToolRound = { ...pending, answers };
    if (reply.raw !== undefined) rawOwner.set(done, toolModel);
    messages.push(done);
  }

  // Out of tool turns or of room, or the last turn had no text (cut off, or a malformed tool call):
  // ask once more, for an answer in text. A blocked prompt would only be blocked again.
  // With an explorer model this request is always made: it is the one the answering model gets.
  if (!answered && !blockReason) {
    options.onActivity?.("Writing the answer…");
    let closing = searchable.length > 0 ? FINAL_ANSWER_REQUEST : FINAL_ANSWER_AFTER_PAGES;
    // The answering model gets the explorer's calls and what they returned, and nothing else of it.
    if (explorer && steps.length === 0) closing = FINAL_ANSWER_WITHOUT_TOOLS;
    const reply = await request(model, {
      system,
      messages: [...viewFor(model), { role: "user", parts: [{ text: closing }] }],
      tools: declarations,
      toolChoice: "none",
    }, true);
    answered = wrote(reply);
  }
  return result(answered);
}
