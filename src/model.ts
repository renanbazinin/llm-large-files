// The contract between the tool loop (`askWithFiles`) and a model provider. An adapter turns a
// neutral request into the provider's own, sends it, and reads the reply back. Everything else
// (planning, tools, limits, retries, usage, the forced answer) is the loop's, once, for every provider.
import type { GenerateText, ToolDeclaration, ToolFile, ToolResult } from "./types.js";

/**
 * A tool call a model made. `id` is the provider's own, where it gives one. `problem` says why
 * the call cannot be run as it came (its arguments were not JSON, or it was cut off): the loop
 * then answers it with that message, and the model can send it again.
 */
export type ToolCall = { id?: string; name: string; args: Record<string, unknown>; problem?: string };

/** A tool call with what the tool returned for it. */
export type ToolAnswer = { call: ToolCall; result: ToolResult; files?: ToolFile[] };

/**
 * One piece of a message: plain text, or something in the provider's own form (an image, an inline
 * PDF) that only its adapter reads. A native part may carry the text it holds, to be sized by.
 */
export type ModelPart = { text: string; native?: undefined } | { native: unknown; text?: string };

/** A turn of the user or of the model, as text and native parts. */
export type ModelTextMessage = { role: "user" | "assistant"; parts: ModelPart[] };

/**
 * One round of tool use: the calls of a model turn, and what the tools returned for them, in call
 * order. `raw` is that model turn in its provider's own form. The loop sets it only for the
 * adapter that received it, which sends it back unchanged (Gemini wants its thought signatures,
 * Claude its thinking blocks). Without `raw` the turn is built from `calls`. A round whose
 * `answers` is empty is a model turn that has not been answered yet.
 */
export type ModelToolRound = { role: "tools"; calls: ToolCall[]; answers: ToolAnswer[]; raw?: unknown };

export type ModelMessage = ModelTextMessage | ModelToolRound;

/** A plain chat turn. "model" is accepted as an alias for "assistant". */
export type ChatTurn = { role: "user" | "assistant" | "model"; text: string };

/**
 * A round of tool use as an application stores it between a question and its answer
 * (`AskResult.toolTurns`): plain JSON. Passed back in `messages`, the model sees in a later
 * question what its tools returned in an earlier one, and does not have to search again.
 */
export type ToolTurn = { role: "tools"; calls: Array<ToolCall & { result: ToolResult }> };

/**
 * A result of a stored tool round, as it is sent again in a later question: without
 * `tool_turns_left`, which counted the tool turns its own question had left, not those of the
 * later one. The same result when it has none.
 */
export function laterResult(result: ToolResult): ToolResult {
  if (result === null || typeof result !== "object" || !("tool_turns_left" in result)) return result;
  const { tool_turns_left: _left, ...rest } = result;
  return rest;
}

/** What `askWithFiles` takes as conversation: plain turns, stored tool rounds, and turns with native parts. */
export type ChatMessage = ChatTurn | ToolTurn | ModelTextMessage;

export type ModelRequest = {
  /** The system instruction: the application's, then the guide to the document tools. May be empty. */
  system: string;
  /** The conversation, oldest first. The last message is the user's, or a tool round. */
  messages: ModelMessage[];
  /** The tools on offer. Left out when the conversation needs none. */
  tools?: ToolDeclaration[];
  /**
   * "none": the model must answer in text. The tools are still listed, for a provider that wants
   * them declared next to the tool calls already in the conversation.
   */
  toolChoice?: "auto" | "none";
};

/** Tokens of one request, or summed over several. */
export type ModelUsage = {
  /** Every token of the prompt, those read from a cache included. */
  inputTokens: number;
  /** The part of `inputTokens` that was read from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Every token the model produced, thoughts included. */
  outputTokens: number;
  /** The part of `outputTokens` that went on thinking, where the provider says. */
  thoughtTokens: number;
};

export type ModelReply = {
  /** What the model wrote for the user in this reply. Thoughts are not part of it. */
  text: string;
  calls: ToolCall[];
  /** This turn in the provider's own form, to send back unchanged with the tool results. */
  raw?: unknown;
  /** Why the reply ended, in the provider's own word ("STOP", "length", "end_turn"). */
  finishReason?: string;
  /**
   * How the reply ended, in terms every adapter maps its own to: "complete"; "cut" at the output
   * limit; "filtered" by the provider's safety filters; "malformed_call", a tool call the model
   * tried to make that could not be read (Gemini's MALFORMED_FUNCTION_CALL). Unset when the
   * adapter does not know the reason.
   */
  finish?: "complete" | "cut" | "filtered" | "malformed_call";
  /** Why the provider refused the prompt, when it did. Nothing more is asked after it. */
  blockReason?: string;
  usage?: Partial<ModelUsage>;
  /** The provider's own usage object, as it came. */
  providerUsage?: Record<string, unknown>;
};

export type SendHooks = {
  /**
   * Called with the answer text as it arrives. When it is given the adapter streams if it can; one
   * that cannot calls it once with the whole text. The text is in the reply either way.
   */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
};

/** What a model can take, as far as its adapter knows. */
export type ModelCapabilities = {
  /** The context window in tokens. When set, the budget of a question is no larger than this. */
  contextTokens?: number;
  /** The largest request body in bytes. When set, the budget of a question is no larger than this. */
  maxRequestBytes?: number;
  /**
   * Where a file that a tool returned (the pages of `view_pages`) goes: "inside" the tool result,
   * "beside" it in a user turn of its own, or "none" for a model that cannot be sent one. With
   * "none", `view_pages` is not offered.
   */
  toolFiles: "inside" | "beside" | "none";
  /** About what the model bills for one PDF page it is shown, in tokens. */
  pageTokens: number;
  /**
   * How many of this model's tokens one token of the library's estimate comes to. The estimate
   * (`estimateTokens`) is fitted to Gemini, so that is 1, the default. A model whose tokenizer
   * counts a third more for the same text says 1.33, and its documents are planned for a window
   * that much smaller.
   */
  tokenScale?: number;
  /**
   * Tokens set aside for the model's reply, when they come out of the same window as the prompt
   * (Claude's `max_tokens`). The budget of a question leaves them free.
   */
  outputTokens?: number;
  /**
   * True for a model whose conversation may only grow: an earlier turn that is rewritten makes
   * the request invalid (Claude ties its thinking blocks to the conversation they were written
   * in). Old tool results are then not shortened to make room: when the room runs out, the
   * question is answered with what it has.
   */
  appendOnly?: boolean;
  /**
   * True for a model whose provider may clear old tool results from the conversation on its side,
   * before the model reads it (Claude's context editing with `clear_tool_uses`, or compaction). A
   * call made again is then run again, instead of being answered with a pointer to an earlier
   * result that the model may no longer have.
   */
  clearsToolResults?: boolean;
};

/** A model provider, as the tool loop sees it. */
export interface ModelAdapter {
  /** Names the model in usage totals and messages: "gemini-3.8-flash". */
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  /**
   * @deprecated Never called. The loop counts every request in the library's estimate
   * (`estimateTokens`), as the documents were counted when they were uploaded, and turns that into
   * this model's tokens with `capabilities.tokenScale`: set `tokenScale` instead. Kept so that
   * adapters that declare it still compile; it may be removed in a later version.
   */
  estimateTokens?(text: string): number;
  /**
   * One chat request. Throw a `ModelRequestError` for an HTTP error or a connection that failed:
   * the loop retries the ones worth retrying.
   */
  send(request: ModelRequest, hooks?: SendHooks): Promise<ModelReply>;
  /**
   * The size in bytes of the body `send` would post. With it, the room left for the pages of a PDF
   * is exact; without it, it is estimated.
   */
  requestBytes?(request: ModelRequest): number;
  /** A plain completion, for whole-file reads. Without it `analyze_whole_document` is not offered. */
  generateText?: GenerateText;
}

/**
 * What went wrong with a model request, as far as the error says:
 * - "context_overflow": the request was larger than the model takes (its context window, or the
 *   size of the body). A smaller request can work.
 * - "quota": a quota that does not come back soon (a daily cap, no credit left). Sending again
 *   does not help.
 * - "rate_limit": too many requests or tokens for now (HTTP 429). Sending again later helps.
 * - "timeout": nothing came from the model for longer than the adapter waits (`firstByteTimeoutMs`,
 *   `idleTimeoutMs`; status 0), or the provider or a gateway said the request timed out (HTTP 408).
 * - "unreachable": no answer at all: the connection failed.
 * - "server": the provider failed on its side (HTTP 5xx).
 * - "auth": the key or token was refused (HTTP 401, 403).
 * - "invalid": the provider refused the request as it was (another HTTP 4xx).
 */
export type ModelErrorKind = "context_overflow" | "quota" | "rate_limit" | "timeout" | "unreachable" | "server" | "auth" | "invalid";

/** How an error was told apart, with the numbers of an overflow when the message gives them. */
export type ModelErrorClass = {
  kind: ModelErrorKind;
  /** The most input tokens the model takes, as the provider counts them. */
  limitTokens?: number;
  /**
   * The tokens of the refused request that the provider counted against the window: its input,
   * and for some providers (OpenRouter, vLLM) the output it would have taken too.
   */
  requestedTokens?: number;
};

/** Wording of a request larger than the model takes, across providers. */
const OVERFLOW_WORDING = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /input token count\b.{0,40}\bexceeds/i,
  // Vertex AI: "Unable to submit request because the input token count is N but model only supports up to M."
  /input token count is [\d,]+ but/i,
  /model only supports up to/i,
  /exceeds? the maximum number of tokens/i,
  /maximum context (?:size|window)/i,
  /too large for (?:the )?model with [\d,]+ maximum context/i,
  /exceeds? (?:the )?(?:available |model'?s? )?context (?:size|window|length)/i,
  /request payload size exceeds/i,
  /reduce the length of the messages/i,
  /input tokens? exceeds?/i,
  /request_too_large/i,
  // Claude 3.7 to 4.1: "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000".
  /exceed context limit/i,
  // Text Generation Inference (Hugging Face, Together): "Input validation error: `inputs` tokens +
  // `max_new_tokens` must be <= 32769. Given: 40000 `inputs` tokens and 1024 `max_new_tokens`".
  /`?inputs`? tokens \+ `?max_new_tokens`? must be <=/i,
  /`?inputs`? must have less than [\d,]+ tokens/i,
  // LM Studio: "Trying to keep the first 9000 tokens when context the overflows. However, the model
  // is loaded with context length of only 4096 tokens, which is not enough."
  /loaded with context length of only/i,
  /tokens to keep from the initial prompt is greater than the context length/i,
  // Amazon Bedrock: "Input is too long for requested model."
  /input is too long for (?:the )?(?:requested )?model/i,
];
/**
 * A request larger than the tokens a whole minute (or day) allows. OpenAI: "Request too large for
 * gpt-4o in organization org-… on tokens per min (TPM): Limit 30000, Requested 45237.", as HTTP 429.
 * Groq says "tokens per minute", as HTTP 413. No wait lets it pass: only a smaller request can.
 */
const RATE_TOO_SMALL = /request too large for .{0,200}\bon tokens per (min(?:ute)?|day)\b/i;
/** Wording of throttling, which can share words with an overflow ("too many tokens, please wait"). */
const THROTTLE_WORDING = /rate.?limit|too many requests|please (?:wait|try again later)|per (?:minute|second|day)\b|\b[TR]PM\b|throttl/i;

const LIMIT_WORDING = [
  /maximum context length is ([\d,]+)/i,
  // The Gemini API puts the number in parentheses; Vertex AI (November 2026) does not:
  // "The input token count exceeds the maximum number of tokens allowed 1048576."
  /maximum number of tokens allowed \(?([\d,]+)/i,
  /> ?([\d,]+) maximum/i,
  /with ([\d,]+) maximum context/i,
  /configured limit of ([\d,]+) tokens/i,
  /supports up to ([\d,]+)/i,
  /context limit: [\d,]+ \+ [\d,]+ > ([\d,]+)/i,
  /must be <= ?([\d,]+)/i,
  /must have less than ([\d,]+) tokens/i,
  /context length of only ([\d,]+) tokens/i,
  /\bLimit:? ([\d,]+), Requested\b/i,
];
const REQUESTED_WORDING = [
  /input token count \(([\d,]+)\)/i,
  /input token count is ([\d,]+)/i,
  /context limit: ([\d,]+) \+/i,
  /\(([\d,]+) in the messages/i,
  /resulted in ([\d,]+) tokens/i,
  /too long: ([\d,]+) tokens/i,
  /prompt contains ([\d,]+) tokens/i,
  /requested (?:about )?([\d,]+) tokens/i,
  // vLLM since its errors changed: "However, your request has 40000 input tokens."
  /your request has ([\d,]+) input tokens/i,
  /\bGiven: ([\d,]+)/i,
  /\bRequested:? ([\d,]+)/i,
];
/**
 * Wording of a quota that does not come back soon: no credit left (DeepSeek's "Insufficient
 * Balance", OpenRouter's "Insufficient credits", Claude's "Your credit balance is too low"), or a
 * spending cap that was reached (Claude's "You have reached your API usage limits").
 */
const QUOTA_WORDING = /credit balance is too low|insufficient (?:balance|credits?|funds)|reached your (?:specified )?API usage limits/i;
/** A quota per day named in the message alone: Vertex AI's "Quota exceeded for …requests_per_day_per_project…". */
const DAILY_QUOTA_WORDING = /quota.{0,200}(?:per[_ -]?day|PerDay)/i;

function firstNumber(message: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const found = pattern.exec(message)?.[1];
    if (!found) continue;
    const value = Number(found.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** True when a Gemini error says a quota per day ran out: `google.rpc.QuotaFailure` with a "PerDay" quota. */
function dailyQuota(details: unknown): boolean {
  if (!Array.isArray(details)) return false;
  return details.some((detail) => {
    const violations = (detail as { violations?: unknown } | null)?.violations;
    return Array.isArray(violations) && violations.some((violation) => {
      const id = (violation as { quotaId?: unknown; quotaMetric?: unknown } | null);
      return /per.?day/i.test(`${String(id?.quotaId ?? "")} ${String(id?.quotaMetric ?? "")}`);
    });
  });
}

/** A request larger than the model takes, with the numbers its message gives. */
function overflowOf(message: string): ModelErrorClass {
  const limitTokens = firstNumber(message, LIMIT_WORDING);
  const requestedTokens = firstNumber(message, REQUESTED_WORDING);
  return { kind: "context_overflow", ...(limitTokens ? { limitTokens } : {}), ...(requestedTokens ? { requestedTokens } : {}) };
}

/** True when a Gemini error names an API key that is not valid (it comes as HTTP 400). */
const keyRefused = (details: unknown): boolean => Array.isArray(details) && details.some((detail) => (detail as { reason?: unknown } | null)?.reason === "API_KEY_INVALID");

/**
 * Tells what kind of failure an HTTP status and an error message are (see `ModelErrorKind`).
 * `code` is the provider's own word, when it gives one (OpenAI's `error.code`, Claude's
 * `error.type`, Gemini's `error.status`); `details` is a Gemini error's `details`. A quota is told
 * from those, from HTTP 402 (payment required), and from words that only a quota uses (no credit
 * left, a spending cap, a quota per day): Gemini says "You exceeded your current quota" of a limit
 * per minute too, which a wait mends.
 */
export function classifyModelError(status: number, message: string, signals: { code?: string | undefined; details?: unknown } = {}): ModelErrorClass {
  const { code, details } = signals;
  if (status === 0) return { kind: "unreachable" };
  if (code === "insufficient_quota" || status === 402 || (status === 429 && (dailyQuota(details) || DAILY_QUOTA_WORDING.test(message)))) return { kind: "quota" };
  if (status < 500 && QUOTA_WORDING.test(message)) return { kind: "quota" };
  // Larger than the provider lets through in a minute: a context overflow, though it comes as 429,
  // and though its words are those of a rate limit.
  if ((status === 429 || status === 413) && RATE_TOO_SMALL.test(message)) return overflowOf(message);
  const throttled = THROTTLE_WORDING.test(message);
  const overflow = !throttled && status !== 429 && status < 500 && (
    status === 413 || code === "context_length_exceeded" || code === "request_too_large" || OVERFLOW_WORDING.some((pattern) => pattern.test(message))
  );
  if (overflow) return overflowOf(message);
  if (status === 429) return { kind: "rate_limit" };
  if (status === 408) return { kind: "timeout" };
  if (status >= 500) return { kind: "server" };
  if (status === 401 || status === 403 || keyRefused(details)) return { kind: "auth" };
  return { kind: "invalid" };
}

/**
 * A model request that failed: the provider answered with an HTTP error, or could not be reached
 * (`status` 0). `retryAfterMs` is the wait the provider asked for, when it named one. `kind` says
 * what went wrong (see `ModelErrorKind`); for a request larger than the model takes,
 * `limitTokens` and `requestedTokens` are the provider's numbers, when its message gives them.
 */
export class ModelRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly kind: ModelErrorKind;
  readonly limitTokens?: number;
  readonly requestedTokens?: number;
  constructor(message: string, status: number, options: {
    retryAfterMs?: number;
    cause?: unknown;
    /** The kind, when the adapter knows it (a timeout). Otherwise it is told from the status and the message. */
    kind?: ModelErrorKind;
    /** The provider's own word for the error, used to tell its kind. */
    code?: string | undefined;
    /** The `details` of a Gemini error, used to tell its kind. */
    details?: unknown;
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelRequestError";
    this.status = status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    const found = classifyModelError(status, message, { code: options.code, details: options.details });
    this.kind = options.kind ?? found.kind;
    if (this.kind === "context_overflow") {
      if (found.limitTokens) this.limitTokens = found.limitTokens;
      if (found.requestedTokens) this.requestedTokens = found.requestedTokens;
    }
  }
}

/** The kind of a model error, when it has one: a `ModelRequestError`'s, or that of an error with the same field. */
export function errorKindOf(error: unknown): ModelErrorKind | undefined {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind as ModelErrorKind : undefined;
}

/**
 * For a request refused as larger than the tokens a minute (or a day) of the provider allows, not
 * than the model's window: that period. Undefined for any other error.
 */
export function rateAllowanceOf(error: unknown): "minute" | "day" | undefined {
  if (errorKindOf(error) !== "context_overflow" || !(error instanceof Error)) return undefined;
  const period = RATE_TOO_SMALL.exec(error.message)?.[1];
  if (period === undefined) return undefined;
  return period.toLowerCase() === "day" ? "day" : "minute";
}

/** Some document IDs were never uploaded, have expired, or belong to another owner. */
export class DocumentsNotFoundError extends Error {
  constructor(readonly ids: string[]) {
    super(`${ids.length === 1 ? "A document is" : `${ids.length} documents are`} no longer available: ${ids.join(", ")}. Upload ${ids.length === 1 ? "it" : "them"} again.`);
    this.name = "DocumentsNotFoundError";
  }
}

const EMPTY_USAGE: ModelUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtTokens: 0 };

/** Usage of one question: every request it made, whole-file part reads included, in all and by model. */
export type UsageTotals = ModelUsage & {
  /** Requests that were answered. One that failed and was sent again counts once. */
  requests: number;
  byModel: Record<string, ModelUsage & { requests: number }>;
};

/** Sums the usage of the requests of one question. */
export class UsageMeter {
  readonly totals: UsageTotals = { requests: 0, ...EMPTY_USAGE, byModel: {} };

  add(model: string, usage: Partial<ModelUsage> | undefined): void {
    const { byModel } = this.totals;
    // An own entry only: an id such as "__proto__" or "constructor" found what every object
    // inherits, and "__proto__" then counted the usage into Object.prototype.
    let of = Object.hasOwn(byModel, model) ? byModel[model] : undefined;
    if (!of) {
      of = { requests: 0, ...EMPTY_USAGE };
      Object.defineProperty(byModel, model, { value: of, enumerable: true, writable: true, configurable: true });
    }
    for (const sum of [this.totals, of]) {
      sum.requests++;
      for (const key of Object.keys(EMPTY_USAGE) as Array<keyof ModelUsage>) {
        const value = usage?.[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) sum[key] += value;
      }
    }
  }
}
