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
  finishReason?: string;
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
};

/** A model provider, as the tool loop sees it. */
export interface ModelAdapter {
  /** Names the model in usage totals and messages: "gemini-3.8-flash". */
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  /** How many tokens a text is for this model. Defaults to the library's estimate. */
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
 * A model request that failed: the provider answered with an HTTP error, or could not be reached
 * (`status` 0). `retryAfterMs` is the wait the provider asked for, when it named one.
 */
export class ModelRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelRequestError";
    this.status = status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
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
    const of = (this.totals.byModel[model] ??= { requests: 0, ...EMPTY_USAGE });
    for (const sum of [this.totals, of]) {
      sum.requests++;
      for (const key of Object.keys(EMPTY_USAGE) as Array<keyof ModelUsage>) {
        const value = usage?.[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) sum[key] += value;
      }
    }
  }
}
