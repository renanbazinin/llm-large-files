// Claude (the Messages API) as a model of `askWithFiles`. No SDK, like the other adapters: the
// caller gives a key or a token, and may give the URL of a gateway that speaks the same API.
import { base64, resolveHeaderSource, resolveSecret, unreachableReason, type HeaderSource, type SecretSource } from "../http.js";
import { ModelRequestError, type ChatMessage, type ModelAdapter, type ModelMessage, type ModelReply, type ModelRequest, type ModelToolRound, type SendHooks, type ToolCall, type ToolTurn } from "../model.js";
import { completeWithinLimit, type LimitedReply } from "../output-limit.js";
import { retryAfterMs } from "../retry.js";
import { parseSseJson } from "../sse.js";
import type { GenerateText, GenerateUsage, ToolDeclaration, ToolResult } from "../types.js";

/** The API answered with an HTTP error, or could not be reached (`status` 0). `type` is the API's own word: "rate_limit_error". */
export class AnthropicRequestError extends ModelRequestError {
  readonly type?: string;
  constructor(message: string, status: number, options: { retryAfterMs?: number; cause?: unknown; type?: string } = {}) {
    super(message, status, options);
    this.name = "AnthropicRequestError";
    if (options.type) this.type = options.type;
  }
}

/** A message of the Messages API, as it takes and returns it. */
export type AnthropicMessage = { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> };

/** The API version the requests are written for. */
export const ANTHROPIC_VERSION = "2026-10-21";
/** The beta that `fallbacks` needs. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_MAX_TOKENS = 64_000;

export type AnthropicOptions = {
  /** The model ID: "claude-opus-5-5". */
  model: string;
  /** Sent as `x-api-key`. A function is called for each request. */
  apiKey?: SecretSource | undefined;
  /** Sent as `Authorization: Bearer …`, for an OAuth token or a gateway. A function is called for each request. */
  authToken?: SecretSource | undefined;
  /** The base of the API: `/v1/messages` is added to it. Defaults to https://api.anthropic.com. */
  baseUrl?: string | undefined;
  /** The whole Messages URL, when it is not `baseUrl` + `/v1/messages`. */
  url?: string | undefined;
  /** More headers. A function is called for each request. */
  headers?: HeaderSource | undefined;
  /** The `anthropic-version` header. Defaults to `ANTHROPIC_VERSION`. */
  version?: string | undefined;
  /** Values for the `anthropic-beta` header. */
  betas?: string[] | undefined;
  /**
   * `max_tokens` of a chat request: the most the model may write, thoughts included. Defaults to
   * 64,000. It comes out of the context window, so the budget of a question keeps it free.
   */
  maxTokens?: number | undefined;
  /** More fields for the body of every chat request: `thinking`, `output_config`, `context_management`, `metadata`, and so on. */
  body?: Record<string, unknown> | undefined;
  /** More fields for the body of a whole-document part read, given the `max_tokens` it is sent with. */
  analysisBody?: ((maxOutputTokens: number) => Record<string, unknown>) | undefined;
  /**
   * Have another model answer when this one's safety classifiers decline a request: "default", or
   * a list of `{ model }`. It adds the `fallbacks` field and its beta header. Off unless set: it
   * is offered on the Claude API, not on Amazon Bedrock, Vertex AI or Microsoft Foundry, and not
   * for every model.
   */
  fallbacks?: "default" | Array<Record<string, unknown> & { model: string }> | undefined;
  /**
   * Prompt caching: a top-level `cache_control`, which caches the request up to its last block, so
   * each request of a tool loop, and a follow-up question, reads what the one before wrote.
   * `true` (the default) keeps it five minutes, "1h" an hour, `false` sends none.
   */
  cache?: boolean | "5m" | "1h" | undefined;
  /**
   * Where the pages of `view_pages` go: "inside" the tool result as a document block (the
   * default), "beside" it as a document block after the tool results, or "none" to not offer
   * `view_pages`.
   */
  toolFilePlacement?: "inside" | "beside" | "none" | undefined;
  /** Chat requests are streamed, which keeps a long reply from timing out. False for a gateway without streaming. */
  stream?: boolean | undefined;
  /**
   * Set `eager_input_streaming` on the tools of a streamed request, so tool input arrives as it
   * is written. Defaults to true for api.anthropic.com and false for any other URL, which may
   * refuse the field.
   */
  eagerInputStreaming?: boolean | undefined;
  /** The model's context window in tokens, when the budget of a question should follow it. */
  contextTokens?: number | undefined;
  /** The largest request body in bytes. Defaults to 32 MB, the limit of the Claude API. */
  maxRequestBytes?: number | undefined;
  /** Tokens billed for one PDF page: its text and its picture. Defaults to 3,500. */
  pageTokens?: number | undefined;
  /**
   * This model's tokens for one token of the library's estimate, which is fitted to Gemini.
   * Defaults to 1.35, a cautious guess for the tokenizer of the current models: the count the API
   * reports with each reply corrects it during a question.
   */
  tokenScale?: number | undefined;
  /** Milliseconds a part read may take. Defaults to 180,000. */
  timeoutMs?: number | undefined;
  /** Names the model in usage totals. Defaults to `model`. */
  id?: string | undefined;
  fetch?: typeof fetch | undefined;
};

type Json = Record<string, any>;
type Block = Record<string, any>;

const STATUS_OF_TYPE: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, timeout_error: 408 };

/** Blocks of a model that declined part-way must not go back: only what came after the last switch to another model does. */
const INTERNAL_BEFORE_FALLBACK = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);

/** The content of a reply as it goes back in the next request. */
function echoable(content: Block[]): Block[] {
  const boundary = content.map((block) => block?.type).lastIndexOf("fallback");
  if (boundary < 0) return content;
  return content.filter((block, index) => index >= boundary || !INTERNAL_BEFORE_FALLBACK.has(block?.type));
}

function usageOf(usage: Json | undefined): GenerateUsage {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  // With fallbacks, each attempt is an entry of `iterations`, and the top-level numbers are the last attempt's alone.
  const attempts: Json[] = Array.isArray(usage?.iterations) && usage.iterations.length > 0 ? usage.iterations : [usage ?? {}];
  const sum = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
  for (const attempt of attempts) {
    const read = number(attempt?.cache_read_input_tokens);
    // `input_tokens` is what was not cached: the prompt is the three together.
    sum.inputTokens += number(attempt?.input_tokens) + number(attempt?.cache_creation_input_tokens) + read;
    sum.cachedInputTokens += read;
    sum.outputTokens += number(attempt?.output_tokens);
  }
  return sum;
}

async function failure(response: Response): Promise<AnthropicRequestError> {
  const data = await response.json().catch(() => null) as Json | null;
  const wait = retryAfterMs(response.headers, data);
  const type = typeof data?.error?.type === "string" ? data.error.type as string : undefined;
  return new AnthropicRequestError(typeof data?.error?.message === "string" && data.error.message ? data.error.message : `Claude returned HTTP ${response.status}.`, response.status, {
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(type ? { type } : {}),
  });
}

const toolResultOf = (id: string, result: ToolResult, documents: Block[]): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: documents.length > 0 ? [{ type: "text", text: JSON.stringify(result) }, ...documents] : JSON.stringify(result),
  // Says to the model that the call failed, so it tries another way instead of reading the message as data.
  ...(typeof result.error === "string" ? { is_error: true } : {}),
});

/** The two messages of one tool round. `number` makes the IDs of calls that came without one. */
function roundMessages(round: ModelToolRound, number: number, files: "inside" | "beside" | "none"): AnthropicMessage[] {
  const idOf = (call: ToolCall, index: number) => call.id ?? `toolu_${number}_${index + 1}`;
  // Its own turn goes back exactly as it came: Claude checks its thinking blocks against the conversation they were written in.
  const asked: AnthropicMessage = {
    role: "assistant",
    content: round.raw !== undefined ? round.raw as Block[] : round.calls.map((call, index) => ({ type: "tool_use", id: idOf(call, index), name: call.name, input: call.args })),
  };
  if (round.answers.length === 0) return [asked];
  const document = (file: { mimeType: string; bytes: Uint8Array }): Block => ({ type: "document", source: { type: "base64", media_type: file.mimeType, data: base64(file.bytes) } });
  const results = round.answers.map((answer, index) => toolResultOf(idOf(answer.call, index), answer.result, files === "inside" ? (answer.files ?? []).map(document) : []));
  // Anything else in the turn comes after every tool result: the API refuses text before one.
  const beside = files === "beside" ? round.answers.flatMap((answer) => (answer.files ?? []).flatMap((file) => [
    { type: "text", text: `${file.name} (returned by ${answer.call.name}):` },
    document(file),
  ])) : [];
  return [asked, { role: "user", content: [...results, ...beside] }];
}

/** Turns that follow each other with the same role, made one: tool results and the text after them belong to one user turn. */
function joined(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    const content = typeof message.content === "string" ? (message.content ? [{ type: "text", text: message.content }] : []) : message.content;
    if (content.length === 0) continue;
    const last = out.at(-1);
    if (last && last.role === message.role) last.content = [...last.content as Block[], ...content];
    else out.push({ role: message.role, content: [...content] });
  }
  return out;
}

/**
 * Messages of the Messages API as the conversation of `askWithFiles`: text blocks as text, a turn
 * of `tool_use` blocks and the `tool_result` blocks that answer it as one stored tool round, and
 * every other block (an image, a document) as it is. Thinking blocks are left out: they belong to
 * the conversation they were written in.
 */
export function fromAnthropicMessages(history: AnthropicMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const open = new Map<string, { result: ToolResult }>();
  for (const message of history) {
    const content: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const calls: Array<ToolCall & { result: ToolResult }> = [];
    const parts: Array<{ text: string } | { native: unknown }> = [];
    for (const block of content) {
      if (block.type === "thinking" || block.type === "redacted_thinking") continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text) parts.push({ text: block.text });
      } else if (block.type === "tool_use" && message.role === "assistant") {
        calls.push({ id: String(block.id), name: String(block.name), args: block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {}, result: { error: "No result was kept for this call." } });
      } else if (block.type === "tool_result" && message.role === "user") {
        const call = open.get(String(block.tool_use_id));
        if (!call) continue;
        const text = typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content as Block[] : []).map((part) => (part.type === "text" ? String(part.text ?? "") : "")).join("");
        try {
          const parsed = JSON.parse(text) as unknown;
          call.result = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ToolResult : { text };
        } catch {
          call.result = { text };
        }
      } else {
        parts.push({ native: block });
      }
    }
    if (parts.length > 0) messages.push({ role: message.role, parts });
    if (calls.length > 0) {
      for (const call of calls) open.set(call.id!, call);
      messages.push({ role: "tools", calls });
    }
  }
  return messages;
}

/**
 * The tool rounds a question returned (`AskResult.toolTurns`) as messages of the Messages API, for
 * an application that keeps its history in that form: put them between the question and its answer.
 */
export function anthropicToolTurns(turns: ToolTurn[]): AnthropicMessage[] {
  return turns.flatMap((turn, index) => {
    const answers = turn.calls.map(({ result, ...call }) => ({ call, result }));
    return roundMessages({ role: "tools", calls: answers.map((answer) => answer.call), answers }, index + 1, "none");
  });
}

/** A Claude model for `askWithFiles`. */
export function anthropic(options: AnthropicOptions): ModelAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const url = options.url ?? `${(options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  const firstParty = (() => {
    try {
      return new URL(url).hostname === "api.anthropic.com";
    } catch {
      return false;
    }
  })();
  const files = options.toolFilePlacement ?? "inside";
  const maxTokens = Math.max(1, Math.trunc(options.maxTokens ?? DEFAULT_MAX_TOKENS));
  const streaming = options.stream !== false;
  const eager = options.eagerInputStreaming ?? firstParty;
  const cache = options.cache === false ? undefined : { type: "ephemeral", ...(options.cache === "1h" ? { ttl: "1h" } : {}) };
  const betas = [...new Set([...(options.betas ?? []), ...(options.fallbacks ? [FALLBACK_BETA] : [])])];

  const headersNow = async (): Promise<Record<string, string>> => {
    const [key, token] = await Promise.all([resolveSecret(options.apiKey), resolveSecret(options.authToken)]);
    return {
      "Content-Type": "application/json",
      "anthropic-version": options.version ?? ANTHROPIC_VERSION,
      ...(betas.length > 0 ? { "anthropic-beta": betas.join(",") } : {}),
      ...(key ? { "x-api-key": key } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...await resolveHeaderSource(options.headers),
    };
  };

  const built = new WeakMap<ModelToolRound, { number: number; messages: AnthropicMessage[] }>();
  const toMessages = (messages: ModelMessage[]): AnthropicMessage[] => {
    let rounds = 0;
    return joined(messages.flatMap((message): AnthropicMessage[] => {
      if (message.role !== "tools") {
        // The API refuses an empty text block.
        return [{ role: message.role, content: message.parts.flatMap((part): Block[] => (part.native !== undefined ? [part.native as Block] : part.text ? [{ type: "text", text: part.text }] : [])) }];
      }
      const number = ++rounds;
      let known = built.get(message);
      if (!known || known.number !== number) {
        known = { number, messages: roundMessages(message, number, files) };
        built.set(message, known);
      }
      return known.messages;
    }));
  };
  const asTool = (declaration: ToolDeclaration, stream: boolean): Block => ({
    name: declaration.name,
    description: declaration.description,
    input_schema: declaration.parameters,
    ...(stream && eager ? { eager_input_streaming: true } : {}),
  });
  const bodyOf = (request: ModelRequest, stream: boolean): Json => ({
    model: options.model,
    max_tokens: maxTokens,
    ...(request.system ? { system: request.system } : {}),
    messages: toMessages(request.messages),
    // The tools stay listed in the request that must be answered in text: Claude ties its thinking
    // to the tools of the conversation, and wants them declared next to earlier calls.
    ...(request.tools?.length ? { tools: request.tools.map((tool) => asTool(tool, stream)), ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}) } : {}),
    ...(stream ? { stream: true } : {}),
    ...(cache ? { cache_control: cache } : {}),
    ...(options.fallbacks ? { fallbacks: options.fallbacks } : {}),
    ...options.body,
  });

  const post = async (body: Json, signal: AbortSignal | undefined, stopped: () => boolean): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "POST", headers: await headersNow(), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (error) {
      if (stopped()) throw error;
      throw new AnthropicRequestError(`Claude could not be reached${unreachableReason(error)}.`, 0, { cause: error });
    }
    if (!response.ok) throw await failure(response);
    return response;
  };

  /** The reply, from the content of a finished message. */
  const replyOf = (content: Block[], stopReason: unknown, stopDetails: Json | undefined, usage: Json | undefined, problems: Map<number, string>, text: string): ModelReply => {
    const boundary = content.map((block) => block?.type).lastIndexOf("fallback");
    const refused = stopReason === "refusal";
    // Cut off at the output limit with a call half-written: the call is answered, not run.
    const cutOff = stopReason === "max_tokens";
    const calls: ToolCall[] = refused ? [] : content.flatMap((block, index): ToolCall[] => {
      if (block?.type !== "tool_use" || index < boundary || typeof block.name !== "string") return [];
      const problem = problems.get(index) ?? (cutOff ? "This call was cut off at the output limit before its arguments were complete, and was not run. Send it again." : undefined);
      return [{
        ...(typeof block.id === "string" ? { id: block.id } : {}),
        name: block.name,
        args: block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {},
        ...(problem ? { problem } : {}),
      }];
    });
    const category = typeof stopDetails?.category === "string" ? `: ${stopDetails.category as string}` : "";
    return {
      text,
      calls,
      raw: echoable(content),
      ...(typeof stopReason === "string" ? { finishReason: stopReason } : {}),
      ...(refused ? { blockReason: `refusal${category}` } : {}),
      ...(usage ? { usage: usageOf(usage), providerUsage: usage } : {}),
    };
  };

  const generateText: GenerateText = ({ system, prompt, maxOutputTokens, signal, onTruncated, onUsage }) => {
    const send = async (limit: number): Promise<LimitedReply> => {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
      const response = await post({
        model: options.model,
        max_tokens: limit,
        system,
        messages: [{ role: "user", content: prompt }],
        ...options.analysisBody?.(limit),
      }, signal ? AbortSignal.any([signal, timeout]) : timeout, () => Boolean(signal?.aborted) || timeout.aborted);
      const data = await response.json() as Json;
      onUsage?.(usageOf(data.usage as Json | undefined));
      const content: Block[] = Array.isArray(data.content) ? data.content : [];
      return {
        text: content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join(""),
        cutOff: data.stop_reason === "max_tokens",
        ...(typeof data.stop_reason === "string" ? { reason: data.stop_reason } : {}),
        thoughts: 0,
      };
    };
    return completeWithinLimit(`${url}|${options.model}`, maxOutputTokens, send, { signal, onTruncated });
  };

  return {
    id: options.id ?? options.model,
    capabilities: {
      ...(options.contextTokens ? { contextTokens: options.contextTokens } : {}),
      maxRequestBytes: options.maxRequestBytes ?? 32_000_000,
      toolFiles: files,
      pageTokens: options.pageTokens ?? 3_500,
      tokenScale: options.tokenScale ?? 1.35,
      outputTokens: maxTokens,
      // Claude checks its thinking blocks against the conversation they were written in: an
      // earlier turn that is rewritten makes the later ones invalid.
      appendOnly: true,
    },
    requestBytes: (request) => Buffer.byteLength(JSON.stringify(bodyOf(request, streaming))),
    generateText,

    async send(request: ModelRequest, hooks: SendHooks = {}): Promise<ModelReply> {
      const response = await post(bodyOf(request, streaming), hooks.signal, () => Boolean(hooks.signal?.aborted));
      const problems = new Map<number, string>();
      if (!(streaming && response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream"))) {
        // In one piece: streaming is off, or the gateway answered without it.
        const data = await response.json() as Json;
        const content: Block[] = Array.isArray(data.content) ? data.content : [];
        const text = content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
        if (text) hooks.onText?.(text);
        return replyOf(content, data.stop_reason, data.stop_details as Json | undefined, data.usage as Json | undefined, problems, text);
      }
      const content: Block[] = [];
      const inputs = new Map<number, string>();
      let text = "";
      let stopReason: unknown;
      let stopDetails: Json | undefined;
      let usage: Json | undefined;
      try {
        for await (const event of parseSseJson<Json>(response.body)) {
          if (event.type === "error") {
            const type = typeof event.error?.type === "string" ? event.error.type as string : undefined;
            throw new AnthropicRequestError(String(event.error?.message ?? "Claude reported an error."), (type && STATUS_OF_TYPE[type]) || response.status, type ? { type } : {});
          }
          if (event.type === "message_start") {
            usage = { ...event.message?.usage };
          } else if (event.type === "content_block_start" && typeof event.index === "number") {
            content[event.index] = { ...event.content_block };
          } else if (event.type === "content_block_delta" && typeof event.index === "number") {
            const block = (content[event.index] ??= {});
            const delta = (event.delta ?? {}) as Json;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              block.text = `${block.text ?? ""}${delta.text}`;
              text += delta.text;
              if (delta.text) hooks.onText?.(delta.text);
            } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
              block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
            } else if (delta.type === "signature_delta") {
              block.signature = delta.signature;
            } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              inputs.set(event.index, `${inputs.get(event.index) ?? ""}${delta.partial_json}`);
            } else if (delta.type === "citations_delta") {
              (block.citations ??= []).push(delta.citation);
            }
          } else if (event.type === "content_block_stop" && typeof event.index === "number") {
            const written = inputs.get(event.index);
            const block = content[event.index];
            if (block?.type === "tool_use" && written !== undefined && written.trim()) {
              // The pieces of the input are JSON only when they are all there: read them strictly.
              try {
                const input = JSON.parse(written) as unknown;
                if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object");
                block.input = input;
              } catch {
                block.input = {};
                problems.set(event.index, `The arguments of this call were not valid JSON, and it was not run: ${written.slice(0, 300)}. Send the call again.`);
              }
            }
          } else if (event.type === "message_delta") {
            stopReason = event.delta?.stop_reason ?? stopReason;
            stopDetails = (event.delta?.stop_details as Json | undefined) ?? stopDetails;
            usage = { ...usage, ...event.usage };
          }
        }
      } catch (error) {
        if (hooks.signal?.aborted || error instanceof AnthropicRequestError) throw error;
        // The connection went while the answer was on its way.
        throw new AnthropicRequestError(`Claude could not be reached${unreachableReason(error)}.`, 0, { cause: error });
      }
      const blocks = content.filter(Boolean);
      // The problems were noted by the place of the block in the stream: the same place, with no gaps, in what is kept.
      const placed = new Map<number, string>();
      for (const [index, problem] of problems) placed.set(blocks.indexOf(content[index]!), problem);
      return replyOf(blocks, stopReason, stopDetails, usage, placed, text);
    },
  };
}
