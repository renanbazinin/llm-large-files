// Claude (the Messages API) as a model of `askWithFiles`. No SDK, like the other adapters: the
// caller gives a key or a token, and may give the URL of a gateway that speaks the same API.
import { randomUUID } from "node:crypto";
import { base64, idleWatch, noteCutReply, notJsonMessage, readJson, replyEnd, resolveHeaderSource, resolveSecret, streamedReply, unreachableReason, type HeaderSource, type IdleWatch, type SecretSource } from "../http.js";
import { laterResult, ModelRequestError, type ChatMessage, type ModelAdapter, type ModelMessage, type ModelReply, type ModelRequest, type ModelToolRound, type SendHooks, type ToolCall, type ToolTurn } from "../model.js";
import { completeWithinLimit, type LimitedReply } from "../output-limit.js";
import { noteNoRetry, retryAfterMs } from "../retry.js";
import { eventTooLongMessage, parseSseJson, SseEventTooLongError } from "../sse.js";
import { estimateTokens, sliceWhole } from "../text.js";
import type { GenerateText, GenerateUsage, ToolDeclaration, ToolResult } from "../types.js";

/** The API answered with an HTTP error, or could not be reached (`status` 0). `type` is the API's own word: "rate_limit_error". */
export class AnthropicRequestError extends ModelRequestError {
  readonly type?: string;
  constructor(message: string, status: number, options: ConstructorParameters<typeof ModelRequestError>[2] & { type?: string } = {}) {
    // The API's own word tells the kind: "request_too_large" is a request larger than Claude takes.
    super(message, status, { ...options, ...(options.type ? { code: options.type } : {}) });
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
  /**
   * The longest wait, in milliseconds, for the first piece of a chat reply. Headers do not count:
   * a model that thinks sends nothing until it has thought, and a reply that is not streamed comes
   * whole at the end. A request that gets nothing for that long is aborted and sent again, once.
   * Defaults to 600,000. 0 waits without end.
   */
  firstByteTimeoutMs?: number | undefined;
  /**
   * The longest wait, in milliseconds, between two pieces of a chat reply once it has started to
   * arrive (keep-alives count). A request that gets nothing for that long is aborted and sent
   * again, once, unless text of it was shown. Defaults to 300,000. 0 waits without end.
   */
  idleTimeoutMs?: number | undefined;
  /** Names the model in usage totals. Defaults to `model`. */
  id?: string | undefined;
  fetch?: typeof fetch | undefined;
};

type Json = Record<string, any>;
type Block = Record<string, any>;

/**
 * The status of an error event in a stream that began with 200, from its type. A type it does not
 * know is the server's failure, 500, as an OpenAI-compatible stream's is.
 */
const STATUS_OF_TYPE: Record<string, number> = {
  overloaded_error: 529, rate_limit_error: 429, api_error: 500, timeout_error: 408,
  invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404, request_too_large: 413,
};

/** Blocks of a model that declined part-way must not go back: only what came after the last switch to another model does. */
const INTERNAL_BEFORE_FALLBACK = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);

const isThinking = (block: Block | undefined) => block?.type === "thinking" || block?.type === "redacted_thinking";

/** The content of a reply as it goes back in the next request. */
function echoable(content: Block[]): Block[] {
  const boundary = content.map((block) => block?.type).lastIndexOf("fallback");
  const kept = boundary < 0 ? content : content.filter((block, index) => index >= boundary || !INTERNAL_BEFORE_FALLBACK.has(block?.type));
  // A text block that a stream opened and closed with nothing in it is refused when it is sent back
  // ("text content blocks must be non-empty"). One before a thinking block is left: the thinking
  // is checked against what comes before it in its turn.
  let lastThinking = -1;
  kept.forEach((block, index) => {
    if (isThinking(block)) lastThinking = index;
  });
  return kept.filter((block, index) => !(index > lastThinking && block?.type === "text" && !block.text && !(Array.isArray(block.citations) && block.citations.length > 0)));
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
  // The spending cap of the organization comes as a rate limit (HTTP 429): no wait mends it.
  const spent = data?.error?.details?.error_code === "enforced_spend_limit_reached";
  const error = new AnthropicRequestError(typeof data?.error?.message === "string" && data.error.message ? data.error.message : `Claude returned HTTP ${response.status}.`, response.status, {
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(type ? { type } : {}),
    ...(spent ? { kind: "quota" as const } : {}),
  });
  // The API says when another try cannot help, as its own SDKs read it.
  if (response.headers.get("x-should-retry") === "false") noteNoRetry(error);
  return error;
}

const toolResultOf = (id: string, result: ToolResult, documents: Block[]): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: documents.length > 0 ? [{ type: "text", text: JSON.stringify(result) }, ...documents] : JSON.stringify(result),
  // Says to the model that the call failed, so it tries another way instead of reading the message as data.
  ...(typeof result.error === "string" ? { is_error: true } : {}),
});

/**
 * The IDs of the calls of a round, as the API takes them: of the characters `[A-Za-z0-9_-]` only,
 * and each once in a request. A call that came without one, or from another provider (Kimi's
 * "functions.search:0"), or that has the ID of a call of an earlier round (two questions whose
 * stored rounds were numbered alike), is given one that fits. `used` holds the IDs taken so far
 * in the request. The IDs of Claude's own turns are its own, and are kept as they are.
 */
function callIds(round: ModelToolRound, number: number, used: Set<string>): string[] {
  if (round.raw !== undefined) {
    for (const block of Array.isArray(round.raw) ? round.raw as Block[] : []) {
      if (block?.type === "tool_use" && typeof block.id === "string") used.add(block.id);
    }
    return round.calls.map((call, index) => call.id ?? `toolu_${number}_${index + 1}`);
  }
  return round.calls.map((call, index) => {
    const base = (call.id ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || `toolu_${number}_${index + 1}`;
    let id = base;
    for (let again = 2; used.has(id); again++) id = `${base}_${again}`;
    used.add(id);
    return id;
  });
}

/** The two messages of one tool round, with the IDs `callIds` gave its calls. */
function roundMessages(round: ModelToolRound, ids: string[], files: "inside" | "beside" | "none"): AnthropicMessage[] {
  const byCall = new Map(round.calls.map((call, index) => [call, ids[index]!]));
  const idOf = (call: ToolCall, index: number) => byCall.get(call) ?? ids[index] ?? call.id ?? `toolu_${index + 1}`;
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
  const used = new Set<string>();
  return turns.flatMap((turn, index) => {
    // A call that came without an ID is given one that no round of another question has: these
    // messages are kept, and sent again next to those of later questions.
    const answers = turn.calls.map(({ result, ...call }) => ({ call: call.id ? call : { ...call, id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}` }, result: laterResult(result) }));
    const round: ModelToolRound = { role: "tools", calls: answers.map((answer) => answer.call), answers };
    return roundMessages(round, callIds(round, index + 1, used), "none");
  });
}

/**
 * True when `body` asks Claude to clear old tool results on its side (context editing with
 * `clear_tool_uses`), or to compact the conversation: a result shown earlier may then be gone.
 */
function clearsToolResults(body: Record<string, unknown> | undefined): boolean {
  const edits = (body?.context_management as { edits?: unknown } | null | undefined)?.edits;
  return Array.isArray(edits) && edits.some((edit) => /^(?:clear_tool_uses|compact)/.test(String((edit as { type?: unknown } | null)?.type ?? "")));
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
  const scale = options.tokenScale ?? 1.35;
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

  const built = new WeakMap<ModelToolRound, { key: string; messages: AnthropicMessage[] }>();
  const toMessages = (messages: ModelMessage[]): AnthropicMessage[] => {
    let rounds = 0;
    const used = new Set<string>();
    return joined(messages.flatMap((message): AnthropicMessage[] => {
      if (message.role !== "tools") {
        // The API refuses an empty text block.
        return [{ role: message.role, content: message.parts.flatMap((part): Block[] => (part.native !== undefined ? [part.native as Block] : part.text ? [{ type: "text", text: part.text }] : [])) }];
      }
      const ids = callIds(message, ++rounds, used);
      const key = ids.join(" ");
      let known = built.get(message);
      if (!known || known.key !== key) {
        known = { key, messages: roundMessages(message, ids, files) };
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

  const post = async (body: Json, signal: AbortSignal | undefined, stopped: () => boolean, lost: (error: unknown) => AnthropicRequestError = unreachable, headers?: Record<string, string>): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "POST", headers: headers ?? await headersNow(), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (error) {
      if (stopped()) throw error;
      throw lost(error);
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
    const finish = finishOfClaude(stopReason);
    return {
      text,
      calls,
      raw: echoable(content),
      ...(typeof stopReason === "string" ? { finishReason: stopReason } : {}),
      ...(finish ? { finish } : {}),
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
      const data = await readJson<Json>(response, () => Boolean(signal?.aborted) || timeout.aborted, unreachable, undefined, (error) => notJson(response, error));
      const used = usageOf(data.usage as Json | undefined);
      onUsage?.(used);
      const content: Block[] = Array.isArray(data.content) ? data.content : [];
      const text = content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
      return {
        text,
        cutOff: data.stop_reason === "max_tokens",
        // Claude stopped before the end, for its safety rules or because its window was full: what
        // it wrote is not all there is. (Not `cutOff`: a larger output limit would not help.)
        stopped: data.stop_reason === "refusal" || data.stop_reason === "model_context_window_exceeded",
        ...(typeof data.stop_reason === "string" ? { reason: data.stop_reason } : {}),
        // Claude does not count its thoughts apart: they are what it wrote besides its text, when it
        // thought. A reply that thought most of its limit away is then asked for with a larger one.
        thoughts: content.some(isThinking) ? Math.max(0, (used.outputTokens ?? 0) - Math.ceil(estimateTokens(text) * scale)) : 0,
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
      tokenScale: scale,
      outputTokens: maxTokens,
      // Claude checks its thinking blocks against the conversation they were written in: an
      // earlier turn that is rewritten makes the later ones invalid.
      appendOnly: true,
      // With context editing, Claude may no longer have a result shown earlier: none is pointed to.
      ...(clearsToolResults(options.body) ? { clearsToolResults: true } : {}),
    },
    requestBytes: (request) => Buffer.byteLength(JSON.stringify(bodyOf(request, streaming))),
    generateText,

    async send(request: ModelRequest, hooks: SendHooks = {}): Promise<ModelReply> {
      // A key or token is fetched before the watch starts: the time that takes is not the model's.
      const headers = await headersNow();
      const watch = idleWatch(hooks.signal, { firstByteTimeoutMs: options.firstByteTimeoutMs, idleTimeoutMs: options.idleTimeoutMs });
      // A request the watch aborted got nothing back for the whole wait: that is no failed connection.
      const lost = (error: unknown) => (watch.expired ? new AnthropicRequestError(`Claude sent nothing for ${Math.round(watch.waitedMs / 1_000)} s.`, 0, { kind: "timeout" }) : unreachable(error));
      try {
        // The headers are no piece of the reply: a server may send them at once and then think.
        const response = await post(bodyOf(request, streaming), watch.signal, () => Boolean(hooks.signal?.aborted), lost, headers);
        return await readReply(response, hooks, watch, lost);
      } finally {
        watch.stop();
      }
    },
  };

  /** The reply of a request that was answered: streamed, or in one piece. */
  async function readReply(answer: Response, hooks: SendHooks, watch: IdleWatch, lost: (error: unknown) => AnthropicRequestError): Promise<ModelReply> {
    {
      const problems = new Map<number, string>();
      let response = answer;
      let events = false;
      if (streaming && answer.body) {
        try {
          ({ events, response } = await streamedReply(answer, watch));
        } catch (error) {
          if (hooks.signal?.aborted) throw error;
          throw noteCutReply(lost(error));
        }
      }
      if (!(events && response.body)) {
        // In one piece: streaming is off, or the gateway answered without it.
        const data = await readJson<Json>(response, () => Boolean(hooks.signal?.aborted), lost, watch, (error) => notJson(answer, error));
        const content: Block[] = Array.isArray(data.content) ? data.content : [];
        const text = content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
        if (text) hooks.onText?.(text);
        return replyOf(content, data.stop_reason, data.stop_details as Json | undefined, data.usage as Json | undefined, problems, text);
      }
      const content: Block[] = [];
      const inputs = new Map<number, string>();
      /** Blocks whose stop event came: a call whose block was never closed did not arrive whole. */
      const closed = new Set<number>();
      let text = "";
      let stopReason: unknown;
      let stopDetails: Json | undefined;
      let usage: Json | undefined;
      // `message_stop` ends the reply: a gateway that leaves the connection open after it is not waited for.
      const end = replyEnd(watch);
      try {
        for await (const event of parseSseJson<Json>(response.body, { onData: watch.pulse, signal: end.signal })) {
          if (event.type === "error") {
            const type = typeof event.error?.type === "string" ? event.error.type as string : undefined;
            throw new AnthropicRequestError(String(event.error?.message ?? "Claude reported an error."), (type && STATUS_OF_TYPE[type]) || 500, type ? { type } : {});
          }
          if (event.type === "message_stop") {
            end.reached();
          } else if (event.type === "message_start") {
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
            closed.add(event.index);
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
                problems.set(event.index, `The arguments of this call were not valid JSON, and it was not run: ${sliceWhole(written, 300)}. Send the call again.`);
              }
            }
          } else if (event.type === "message_delta") {
            stopReason = event.delta?.stop_reason ?? stopReason;
            stopDetails = (event.delta?.stop_details as Json | undefined) ?? stopDetails;
            // Only the numbers it has: the input fields of message_delta may be null, and the real
            // ones are message_start's (the official SDK keeps them the same way).
            usage = { ...usage };
            for (const [key, value] of Object.entries((event.usage ?? {}) as Json)) if (value !== null && value !== undefined) usage[key] = value;
          }
        }
      } catch (error) {
        // The reply ended with `message_stop`, and the connection then stayed open, or broke rather
        // than end: what came before it is whole.
        const whole = end.left(error) || (end.whole && !hooks.signal?.aborted && !(error instanceof AnthropicRequestError));
        if (!whole) {
          if (hooks.signal?.aborted || error instanceof AnthropicRequestError) throw error;
          // An event too long to read would come again: it is not sent again, like a page in the reply's place.
          if (error instanceof SseEventTooLongError) throw new AnthropicRequestError(eventTooLongMessage("Claude's", error), answer.status, { kind: "invalid", cause: error });
          // The connection went while the answer was on its way, or nothing came for the whole wait.
          throw noteCutReply(lost(error));
        }
      } finally {
        end.dispose();
      }
      // Every reply ends with the reason it stopped. A stream that closed without one was cut short
      // (a gateway that ended it as if it were whole): its text is not the answer, and it is sent
      // again like a connection that failed, when none of it was shown.
      if (stopReason === undefined) throw noteCutReply(new AnthropicRequestError("Claude's reply ended before it was complete.", 0));
      content.forEach((block, index) => {
        if ((block?.type === "tool_use" || block?.type === "server_tool_use") && !closed.has(index)) problems.set(index, "This call did not arrive whole, and was not run. Send it again.");
      });
      const blocks = content.filter(Boolean);
      // The problems were noted by the place of the block in the stream: the same place, with no gaps, in what is kept.
      const placed = new Map<number, string>();
      for (const [index, problem] of problems) placed.set(blocks.indexOf(content[index]!), problem);
      return replyOf(blocks, stopReason, stopDetails, usage, placed, text);
    }
  }
}

/** A body that came with a status of success but is no JSON (a gateway's page): it is not sent again. */
function notJson(response: Response, error: unknown): AnthropicRequestError {
  return new AnthropicRequestError(notJsonMessage("Claude's", response), response.status, { kind: "invalid", cause: error });
}

/** A request that got no answer: the reason, without the stack of the HTTP client. */
function unreachable(error: unknown): AnthropicRequestError {
  return new AnthropicRequestError(`Claude could not be reached${unreachableReason(error)}.`, 0, { cause: error });
}

/** `stop_reason` in the terms of `ModelReply.finish`. Undefined for a reason it does not know. */
function finishOfClaude(reason: unknown): ModelReply["finish"] {
  if (reason === "end_turn" || reason === "tool_use" || reason === "stop_sequence") return "complete";
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "cut";
  if (reason === "refusal") return "filtered";
  return undefined;
}
