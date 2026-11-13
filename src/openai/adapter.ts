// Any Chat Completions endpoint as a model of `askWithFiles`: OpenAI, Azure OpenAI, DeepSeek,
// LiteLLM, vLLM, Ollama, OpenRouter, Gemini's OpenAI layer. No SDK: the caller gives the URL.
import { base64, parseArguments, readArguments, resolveHeaderSource, resolveSecret, unreachableReason, type HeaderSource, type SecretSource } from "../http.js";
import { ModelRequestError, type ChatMessage, type ModelAdapter, type ModelMessage, type ModelReply, type ModelRequest, type ModelTextMessage, type ModelToolRound, type SendHooks, type ToolCall, type ToolTurn } from "../model.js";
import { completeWithinLimit, type LimitedReply } from "../output-limit.js";
import { retryAfterMs } from "../retry.js";
import { parseSseJson } from "../sse.js";
import type { GenerateText, GenerateUsage, ToolDeclaration, ToolResult } from "../types.js";

/** The endpoint answered with an HTTP error, or could not be reached (`status` 0). */
export class OpenAiRequestError extends ModelRequestError {
  constructor(message: string, status: number, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, status, options);
    this.name = "OpenAiRequestError";
  }
}

/** A Chat Completions message, as the API takes and returns it. */
export type OpenAiMessage = { role: string; [key: string]: unknown };

export type OpenAiCompatibleOptions = {
  /** The model name the endpoint knows: "gpt-5.5", "deepseek-v4-pro", a deployment name. */
  model: string;
  /**
   * The base of the API: `/chat/completions` is added to it. Defaults to https://api.openai.com/v1.
   * DeepSeek: https://api.deepseek.com/v1. Gemini: https://generativelanguage.googleapis.com/v1beta/openai.
   */
  baseUrl?: string | undefined;
  /** The whole Chat Completions URL, when it is not `baseUrl` + `/chat/completions` (Azure OpenAI, a gateway). */
  url?: string | undefined;
  /** Sent as `Authorization: Bearer …`. A function is called for each request. */
  apiKey?: SecretSource | undefined;
  /** More headers, or all of them (Azure's `api-key`). A function is called for each request. */
  headers?: HeaderSource | undefined;
  /** More fields for the body of every chat request: `temperature`, `reasoning_effort`, `max_completion_tokens`, and so on. */
  body?: Record<string, unknown> | undefined;
  /** More fields for the body of a whole-document part read, given the output limit it is sent with. */
  analysisBody?: ((maxOutputTokens: number) => Record<string, unknown>) | undefined;
  /**
   * The name of the output limit in a part read. `max_completion_tokens` for api.openai.com and
   * Azure OpenAI, whose newer models refuse the other; `max_tokens` anywhere else, where it is the
   * one every server knows.
   */
  maxTokensField?: "max_tokens" | "max_completion_tokens" | undefined;
  /** "system" (the default), or "developer" for an endpoint that wants the newer name. */
  systemRole?: "system" | "developer" | undefined;
  /**
   * How the request that must be answered in text says so. "tool_choice" (the default) keeps the
   * tools and sends `tool_choice: "none"`. "omit" leaves the tools out, for a server that does not
   * know `tool_choice`.
   */
  answerWithoutTools?: "tool_choice" | "omit" | undefined;
  /**
   * Send the pages of `view_pages` to the model, as a `file` part in a user message after the tool
   * results. Off by default: a tool message holds text only, and many servers behind this API
   * take no PDF at all. Turn it on for a model that reads PDF input.
   */
  pdfInput?: boolean | undefined;
  /** Stream the answer when the caller listens for text. Defaults to true. False for a server without streaming. */
  stream?: boolean | undefined;
  /** The model's context window in tokens, when the budget of a question should follow it. */
  contextTokens?: number | undefined;
  /** The largest request body the endpoint takes, in bytes. */
  maxRequestBytes?: number | undefined;
  /** Tokens billed for one PDF page, when `pdfInput` is on. Defaults to 1,000. */
  pageTokens?: number | undefined;
  /** This model's tokens for one token of the library's estimate. Defaults to 1. */
  tokenScale?: number | undefined;
  /** Milliseconds a part read may take. Defaults to 180,000. */
  timeoutMs?: number | undefined;
  /** Names the model in usage totals. Defaults to `model`. */
  id?: string | undefined;
  fetch?: typeof fetch | undefined;
};

type Json = Record<string, any>;

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: Json) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
};

const asFunction = (declaration: ToolDeclaration) => ({ type: "function", function: declaration });

function usageOf(usage: Json | undefined): GenerateUsage {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    inputTokens: number(usage?.prompt_tokens),
    cachedInputTokens: number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens),
    outputTokens: number(usage?.completion_tokens),
    thoughtTokens: number(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

/** The error of a response that is not OK. Gemini's layer wraps its error in an array. */
async function failure(response: Response): Promise<OpenAiRequestError> {
  const data = await response.json().catch(() => null) as Json | Json[] | null;
  const body = Array.isArray(data) ? data[0] : data;
  const message = typeof body?.error === "string" ? body.error : body?.error?.message;
  const wait = retryAfterMs(response.headers, body);
  return new OpenAiRequestError(typeof message === "string" && message ? message : `The model returned HTTP ${response.status}.`, response.status, wait === undefined ? {} : { retryAfterMs: wait });
}

const textOf = (message: ModelTextMessage): string => message.parts.map((part) => part.text ?? "").filter(Boolean).join("\n\n");

/** A turn of text. One with nothing but text is a string, which every server takes; native parts make it a list. */
function textMessage(message: ModelTextMessage): OpenAiMessage {
  if (message.parts.every((part) => part.native === undefined)) return { role: message.role, content: textOf(message) };
  return { role: message.role, content: message.parts.map((part) => (part.native !== undefined ? part.native : { type: "text", text: part.text })) };
}

/** The messages of one tool round. `number` makes the IDs of calls that came without one. */
function roundMessages(round: ModelToolRound, number: number, pdfInput: boolean): OpenAiMessage[] {
  const idOf = (call: ToolCall, index: number) => call.id ?? `call_${number}_${index + 1}`;
  // Its own turn goes back as it came: a server may want what it put there (reasoning, signatures).
  const asked: OpenAiMessage = round.raw !== undefined ? round.raw as OpenAiMessage : {
    role: "assistant",
    content: null,
    tool_calls: round.calls.map((call, index) => ({ id: idOf(call, index), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
  };
  const results = round.answers.map((answer, index): OpenAiMessage => ({ role: "tool", tool_call_id: idOf(answer.call, index), content: JSON.stringify(answer.result) }));
  // A tool message holds text. Files follow in a user turn, each after a line that names it.
  const files = pdfInput ? round.answers.flatMap((answer) => (answer.files ?? []).flatMap((file) => [
    { type: "text", text: `${file.name} (returned by ${answer.call.name}):` },
    { type: "file", file: { filename: file.name, file_data: `data:${file.mimeType};base64,${base64(file.bytes)}` } },
  ])) : [];
  return [asked, ...results, ...(files.length > 0 ? [{ role: "user", content: files }] : [])];
}

/**
 * Chat Completions messages as the conversation of `askWithFiles`. System messages are returned
 * apart, as `system`. An assistant turn of tool calls and the tool messages that answer it become
 * one stored tool round.
 */
export function fromOpenAiMessages(history: OpenAiMessage[]): { system: string; messages: ChatMessage[] } {
  const system: string[] = [];
  const messages: ChatMessage[] = [];
  const open = new Map<string, { result: ToolResult }>();
  for (const message of history) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentText(message.content);
      if (text) system.push(text);
    } else if (message.role === "tool") {
      const call = open.get(String(message.tool_call_id));
      if (!call) continue;
      const text = contentText(message.content);
      const parsed = parseArguments(text);
      call.result = Object.keys(parsed).length > 0 || text.trim() === "{}" ? parsed : { text };
    } else if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const calls = (message.tool_calls as Json[]).map((call, index) => ({
        id: typeof call.id === "string" ? call.id : `call_${messages.length}_${index + 1}`,
        name: String(call.function?.name ?? ""),
        args: parseArguments(call.function?.arguments),
        result: { error: "No result was kept for this call." } as ToolResult,
      }));
      for (const call of calls) open.set(call.id, call);
      messages.push({ role: "tools", calls });
    } else if (message.role === "user" || message.role === "assistant") {
      const parts = typeof message.content === "string" || !Array.isArray(message.content)
        ? [{ text: contentText(message.content) }]
        : (message.content as Json[]).map((part) => (part?.type === "text" && typeof part.text === "string" ? { text: part.text as string } : { native: part }));
      messages.push({ role: message.role, parts });
    }
  }
  return { system: system.join("\n\n"), messages };
}

/**
 * The tool rounds a question returned (`AskResult.toolTurns`) as Chat Completions messages, for an
 * application that keeps its history in that form: put them between the question and its answer.
 */
export function openAiToolTurns(turns: ToolTurn[]): OpenAiMessage[] {
  return turns.flatMap((turn, index) => {
    const answers = turn.calls.map(({ result, ...call }) => ({ call, result }));
    return roundMessages({ role: "tools", calls: answers.map((answer) => answer.call), answers }, index + 1, false);
  });
}

/** A model behind a Chat Completions endpoint, for `askWithFiles`. */
export function openAiCompatible(options: OpenAiCompatibleOptions): ModelAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const url = options.url ?? `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const official = /(^|\.)openai\.com$|\.openai\.azure\.com$/.test((() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })());
  const maxTokensField = options.maxTokensField ?? (official ? "max_completion_tokens" : "max_tokens");
  const systemRole = options.systemRole ?? "system";
  const pdfInput = options.pdfInput === true;

  const headersNow = async (): Promise<Record<string, string>> => {
    const key = await resolveSecret(options.apiKey);
    return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...await resolveHeaderSource(options.headers) };
  };

  const built = new WeakMap<ModelToolRound, { number: number; messages: OpenAiMessage[] }>();
  const toMessages = (messages: ModelMessage[]): OpenAiMessage[] => {
    let rounds = 0;
    return messages.flatMap((message) => {
      if (message.role !== "tools") return [textMessage(message)];
      const number = ++rounds;
      let known = built.get(message);
      if (!known || known.number !== number) {
        known = { number, messages: roundMessages(message, number, pdfInput) };
        built.set(message, known);
      }
      return known.messages;
    });
  };
  const bodyOf = (request: ModelRequest, stream: boolean): Json => {
    const mustAnswer = request.toolChoice === "none";
    const listTools = Boolean(request.tools?.length) && !(mustAnswer && options.answerWithoutTools === "omit");
    return {
      model: options.model,
      messages: [...(request.system ? [{ role: systemRole, content: request.system }] : []), ...toMessages(request.messages)],
      ...(listTools ? { tools: request.tools!.map(asFunction), ...(mustAnswer ? { tool_choice: "none" } : {}) } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...options.body,
    };
  };

  const post = async (body: Json, signal: AbortSignal | undefined, stopped: () => boolean): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "POST", headers: await headersNow(), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (error) {
      if (stopped()) throw error;
      throw new OpenAiRequestError(`The model could not be reached${unreachableReason(error)}.`, 0, { cause: error });
    }
    if (!response.ok) throw await failure(response);
    return response;
  };

  const generateText: GenerateText = ({ system, prompt, maxOutputTokens, signal, onTruncated, onUsage }) => {
    const send = async (limit: number): Promise<LimitedReply> => {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
      const response = await post({
        model: options.model,
        messages: [{ role: systemRole, content: system }, { role: "user", content: prompt }],
        [maxTokensField]: limit,
        ...options.analysisBody?.(limit),
      }, signal ? AbortSignal.any([signal, timeout]) : timeout, () => Boolean(signal?.aborted) || timeout.aborted);
      const data = await response.json() as Json;
      const used = usageOf(data.usage);
      onUsage?.(used);
      const choice = data.choices?.[0];
      return {
        text: contentText(choice?.message?.content),
        cutOff: choice?.finish_reason === "length",
        ...(typeof choice?.finish_reason === "string" ? { reason: choice.finish_reason } : {}),
        thoughts: used.thoughtTokens ?? 0,
      };
    };
    return completeWithinLimit(`${url}|${options.model}`, maxOutputTokens, send, { signal, onTruncated });
  };

  return {
    id: options.id ?? options.model,
    capabilities: {
      ...(options.contextTokens ? { contextTokens: options.contextTokens } : {}),
      ...(options.maxRequestBytes ? { maxRequestBytes: options.maxRequestBytes } : {}),
      toolFiles: pdfInput ? "beside" : "none",
      pageTokens: options.pageTokens ?? 1_000,
      ...(options.tokenScale ? { tokenScale: options.tokenScale } : {}),
    },
    requestBytes: (request) => Buffer.byteLength(JSON.stringify(bodyOf(request, false))),
    generateText,

    async send(request: ModelRequest, hooks: SendHooks = {}): Promise<ModelReply> {
      const stream = Boolean(hooks.onText) && options.stream !== false;
      const response = await post(bodyOf(request, stream), hooks.signal, () => Boolean(hooks.signal?.aborted));
      let message: Json;
      let finish: unknown;
      let usage: Json | undefined;
      let text = "";
      if (stream && response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        let reasoning = "";
        const toolCalls: Json[] = [];
        try {
          for await (const chunk of parseSseJson<Json>(response.body)) {
            const failed = (Array.isArray(chunk) ? chunk[0] : chunk)?.error;
            if (failed) throw new OpenAiRequestError(typeof failed === "string" ? failed : String(failed.message ?? "The model reported an error."), typeof failed.code === "number" ? failed.code : response.status);
            if (chunk.usage) usage = chunk.usage as Json;
            const choice = chunk.choices?.[0] as Json | undefined;
            if (!choice) continue;
            const delta = (choice.delta ?? {}) as Json;
            const piece = contentText(delta.content);
            if (piece) {
              text += piece;
              hooks.onText?.(piece);
            }
            if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
            for (const part of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as Json[]) {
              // A call arrives in pieces under its index: first its ID and name, then its arguments, a few characters at a time.
              const at = typeof part.index === "number" ? part.index : part.id || toolCalls.length === 0 ? toolCalls.length : toolCalls.length - 1;
              const call = (toolCalls[at] ??= { type: "function", function: { name: "", arguments: "" } });
              for (const [key, value] of Object.entries(part)) {
                if (key !== "index" && key !== "function" && value !== undefined && value !== null && !(key === "id" && call.id)) call[key] = value;
              }
              if (typeof part.function?.name === "string") call.function.name += part.function.name;
              if (typeof part.function?.arguments === "string") call.function.arguments += part.function.arguments;
            }
            finish = choice.finish_reason ?? finish;
          }
        } catch (error) {
          if (hooks.signal?.aborted || error instanceof OpenAiRequestError) throw error;
          // The connection went while the answer was on its way.
          throw new OpenAiRequestError(`The model could not be reached${unreachableReason(error)}.`, 0, { cause: error });
        }
        const calls = toolCalls.filter(Boolean);
        message = { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length > 0 ? { tool_calls: calls } : {}) };
      } else {
        // In one piece: no streaming was asked for, or the server answered without it.
        const data = await response.json() as Json;
        const choice = data.choices?.[0] as Json | undefined;
        message = (choice?.message ?? { role: "assistant", content: null }) as Json;
        finish = choice?.finish_reason;
        usage = data.usage as Json | undefined;
        // A refusal is what the model has to say to the user, in a field of its own.
        text = contentText(message.content) || (typeof message.refusal === "string" ? message.refusal : "");
        if (text) hooks.onText?.(text);
      }
      // Cut off at the output limit with a call half-written: the call is answered, not run.
      const cutOff = finish === "length" ? "This call was cut off at the output limit before its arguments were complete, and was not run. Send it again." : undefined;
      const calls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls as Json[] : [])
        .filter((call) => typeof call?.function?.name === "string" && call.function.name)
        .map((call) => {
          const { args, problem = cutOff } = readArguments(call.function.arguments);
          return { ...(typeof call.id === "string" && call.id ? { id: call.id } : {}), name: call.function.name as string, args, ...(problem ? { problem } : {}) };
        });
      return {
        text,
        calls,
        raw: message,
        ...(typeof finish === "string" ? { finishReason: finish } : {}),
        ...(finish === "content_filter" && !text && calls.length === 0 ? { blockReason: "content_filter" } : {}),
        ...(usage ? { usage: usageOf(usage), providerUsage: usage } : {}),
      };
    },
  };
}
