// Any Chat Completions endpoint as a model of `askWithFiles`: OpenAI, Azure OpenAI, DeepSeek,
// LiteLLM, vLLM, Ollama, OpenRouter, Gemini's OpenAI layer. No SDK: the caller gives the URL.
import { randomUUID } from "node:crypto";
import { connectionFailure } from "../connection-failure.js";
import { base64, idleWatch, noteCutReply, notJsonMessage, parseArguments, partTimer, readArguments, readJson, replyEnd, resolveHeaderSource, resolveSecret, streamedReply, unreachableReason, until, waitText, type HeaderSource, type IdleWatch, type PartTimer, type SecretSource } from "../http.js";
import { checkToolTurnVersion, laterResult, ModelRequestError, type ChatMessage, type ModelAdapter, type ModelMessage, type ModelReply, type ModelRequest, type ModelTextMessage, type ModelToolRound, type SendHooks, type ToolCall, type ToolTurn } from "../model.js";
import { documentsOption, messageFiles } from "../native.js";
import { completeWithinLimit, type LimitedReply, type OutputLimits } from "../output-limit.js";
import { retryAfterMs } from "../retry.js";
import { eventTooLongMessage, parseSseJson, SseEventTooLongError } from "../sse.js";
import { headerFailure } from "../token-failure.js";
import type { DocumentsCapability, GenerateText, GenerateUsage, ToolDeclaration, ToolFile, ToolResult } from "../types.js";

/** The endpoint answered with an HTTP error, or could not be reached (`status` 0). */
export class OpenAiRequestError extends ModelRequestError {
  /**
   * The request field the error is about, when the server named it (`error.param`): "max_tokens".
   * Since 0.99.10, also the place of the one problem of a FastAPI `detail` (its `loc`).
   */
  readonly param?: string;
  /** The server's own word for the error (`error.code`): "unsupported_parameter". */
  readonly code?: string;
  constructor(message: string, status: number, options: ConstructorParameters<typeof ModelRequestError>[2] & { param?: string } = {}) {
    super(message, status, options);
    this.name = "OpenAiRequestError";
    if (options.param) this.param = options.param;
    if (options.code) this.code = options.code;
  }
}

/** A Chat Completions message, as the API takes and returns it. */
export type OpenAiMessage = { role: string; [key: string]: unknown };

export type OpenAiCompatibleOptions = {
  /**
   * Where part reads keep what they learn about the output limit a model needs (`createOutputLimits()`).
   * Defaults to the memory every adapter of the process shares. Give a test or an eval case its own,
   * so that it does not depend on what another learned before it. New in 0.99.15.
   */
  outputLimits?: OutputLimits | undefined;
  /** The model name the endpoint knows: "gpt-5.5", "deepseek-v4-pro", a deployment name. */
  model: string;
  /**
   * The base of the API: `/chat/completions` is added to it. Defaults to https://api.openai.com/v1.
   * DeepSeek: https://api.deepseek.com/v1. Gemini: https://generativelanguage.googleapis.com/v1beta/openai.
   */
  baseUrl?: string | undefined;
  /** The whole Chat Completions URL, when it is not `baseUrl` + `/chat/completions` (Azure OpenAI, a gateway). */
  url?: string | undefined;
  /**
   * Sent as `Authorization: Bearer …`. A function is called for each request. Since 0.99.13, one
   * that throws on a connection that failed is called again with the request; one that throws
   * otherwise ends it as an "auth" error.
   */
  apiKey?: SecretSource | undefined;
  /** More headers, or all of them (Azure's `api-key`). A function is called for each request, as `apiKey`'s is. */
  headers?: HeaderSource | undefined;
  /** More fields for the body of every chat request: `temperature`, `reasoning_effort`, `max_completion_tokens`, and so on. */
  body?: Record<string, unknown> | undefined;
  /** More fields for the body of a whole-document part read, given the output limit it is sent with. */
  analysisBody?: ((maxOutputTokens: number) => Record<string, unknown>) | undefined;
  /**
   * The name of the output limit in a part read. `max_completion_tokens` for api.openai.com and
   * Azure OpenAI (`*.openai.azure.com`, and the `/openai/` paths of `*.cognitiveservices.azure.com`
   * and `*.services.ai.azure.com`), whose newer models refuse the other; `max_tokens` anywhere
   * else, where it is the one every server knows. Left out, a server that refuses the one sent
   * (HTTP 400, or 422 since 0.99.10, naming it) is sent the other, which is then kept for this adapter.
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
  /**
   * Send the pages of `view_pages` as images: each page a JPEG of 1,568 pixels on its longest side,
   * in an `image_url` part, in a user message after the tool results. For a model that reads images
   * and no PDF (vLLM, DeepSeek, most servers behind this API). It makes `toolFiles` "beside" and
   * lists "image/png" and "image/jpeg" in `toolFileTypes`; with `pdfInput` too, PDF comes first and
   * is used. Drawing pages needs "unpdf" 2 (Node 24 or later) and "@napi-rs/canvas". Off by
   * default. New in 0.99.9.
   */
  imageInput?: boolean | undefined;
  /**
   * The files this model reads natively: `{ formats: ["pdf"] }` sends a small visual PDF sent whole
   * as a `file` part before its text. Only "pdf": Chat Completions reads no other file. Off by
   * default. A value that is not valid is a TypeError when the adapter is made. New in 0.99.9.
   */
  documents?: DocumentsCapability | undefined;
  /** Stream the answer when the caller listens for text. Defaults to true. False for a server without streaming. */
  stream?: boolean | undefined;
  /** The model's context window in tokens, when the budget of a question should follow it. */
  contextTokens?: number | undefined;
  /** The largest request body the endpoint takes, in bytes. */
  maxRequestBytes?: number | undefined;
  /** Tokens billed for one page, as a PDF page or an image, when `pdfInput` or `imageInput` is on. Defaults to 1,000. */
  pageTokens?: number | undefined;
  /** This model's tokens for one token of the library's estimate. Defaults to 1. */
  tokenScale?: number | undefined;
  /**
   * Milliseconds a part read may take, its whole reply included. Defaults to 180,000; 0 sets none
   * (since 0.10.0). A part past it is an `OpenAiRequestError` of kind "timeout" and status 0 (since
   * 0.10.0; before, the abort of the timer), which a whole-file read sends again once.
   */
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

/** The status of an error event in a stream that began with 200: from its code, or from its type. */
const STATUS_OF_ERROR: Record<string, number> = {
  server_error: 500, api_error: 500, internal_error: 500, internal_server_error: 500, service_unavailable: 503,
  rate_limit_exceeded: 429, rate_limit_error: 429, tokens_exceeded: 429, timeout: 408, invalid_request_error: 400,
  context_length_exceeded: 400, insufficient_quota: 429,
};

/**
 * The HTTP status of an error that arrived inside a stream. The response itself was 200, which says
 * nothing of the error: OpenAI's own is `{ type: "server_error", code: null }`. A failure the server
 * did not name is its own, 500, and is sent again like one (when no text of it was shown).
 */
export function streamErrorStatus(failed: unknown): number {
  if (failed && typeof failed === "object") {
    const { code, type } = failed as { code?: unknown; type?: unknown };
    const numeric = typeof code === "number" ? code : typeof code === "string" && /^\d{3}$/.test(code) ? Number(code) : Number.NaN;
    if (numeric >= 400 && numeric <= 599) return numeric;
    // Only a word of the table itself: "constructor" names no status.
    for (const word of [type, code]) if (typeof word === "string" && Object.hasOwn(STATUS_OF_ERROR, word)) return STATUS_OF_ERROR[word]!;
  }
  return 500;
}

/**
 * Whether a server refused the name of the output limit (`max_tokens` or `max_completion_tokens`),
 * rather than its number: "Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens'
 * instead", "Unrecognized request argument supplied: max_completion_tokens". Not "max_tokens is
 * too large", which can name the other field too.
 */
function refusesField(error: unknown, field: string): boolean {
  if (!(error instanceof OpenAiRequestError) || !isRefusal(error.status)) return false;
  // A server that names the field it refuses says it plainly.
  if (error.param !== undefined) return error.param === field && (error.code === "unsupported_parameter" || REFUSED.test(error.message));
  const message = error.message;
  if (/too large|too many|maximum|at most|exceed|must be (less|at most|<)/i.test(message) || !REFUSED.test(message)) return false;
  // "Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens' instead" names both: the
  // one it refuses comes first. Azure's "Could not finish the message because max_tokens or model
  // output limit was reached" refuses nothing.
  const named = /max_completion_tokens|max_tokens/.exec(message)?.[0];
  return named === field;
}

/** Words of a server that refuses a field of the request, rather than its value. */
const REFUSED = /unsupported|unrecognized|not supported|unknown (parameter|field|argument)|not permitted|not allowed|extra (inputs|fields)/i;

/**
 * The statuses a server refuses a request it does not take with: 400, and 422, with which a server
 * built on FastAPI answers a field it does not know ("Extra inputs are not permitted").
 */
export const isRefusal = (status: number): boolean => status === 400 || status === 422;

/**
 * Whether a server refused `stream_options`, the field that asks a stream for its usage: Azure
 * OpenAI before its 2024-09-01 preview ("Unrecognized request argument supplied: stream_options"),
 * and servers that take no field they do not know.
 */
function refusesStreamOptions(error: unknown): boolean {
  if (!(error instanceof OpenAiRequestError) || !isRefusal(error.status)) return false;
  if (error.param !== undefined) return /^stream_options\b/.test(error.param) && (error.code === "unsupported_parameter" || REFUSED.test(error.message));
  return /\bstream_options\b/.test(error.message) && REFUSED.test(error.message);
}

/**
 * Adds a piece of OpenRouter's streamed `reasoning_details` to those of the turn. Pieces of one
 * detail share its `index` and type: their text is joined, and their other fields (a signature, an
 * ID, the encrypted data) are kept. The details stay in the order they came, and are not changed
 * otherwise: they go back to the model as they were written.
 */
function addReasoningDetail(details: Json[], detail: unknown): void {
  if (!detail || typeof detail !== "object") return;
  const piece = detail as Json;
  const same = typeof piece.index === "number" ? details.find((known) => known.index === piece.index && known.type === piece.type) : undefined;
  if (!same) {
    details.push({ ...piece });
    return;
  }
  for (const [key, value] of Object.entries(piece)) {
    if (value === null || value === undefined) continue;
    if ((key === "text" || key === "summary") && typeof value === "string" && typeof same[key] === "string") same[key] += value;
    else same[key] = value;
  }
}

/**
 * The error of a response that is not OK. Gemini's layer wraps its error in an array. Most servers
 * put it in `error`; vLLM before its OpenAI-shaped errors, SGLang and FastChat put `message`, and
 * servers built on FastAPI `detail`, at the top of the body.
 */
export async function failure(response: Response): Promise<OpenAiRequestError> {
  const data = await response.json().catch(() => null) as Json | Json[] | null;
  const body = Array.isArray(data) ? data[0] : data;
  const nested = body?.error && typeof body.error === "object" ? body.error as Json : undefined;
  const message = [typeof body?.error === "string" ? body.error : nested?.message, body?.message, detailText(body?.detail)]
    .find((text): text is string => typeof text === "string" && text.length > 0);
  const wait = retryAfterMs(response.headers, body);
  const own = nested ?? (body && typeof body === "object" ? body : undefined);
  const param = typeof own?.param === "string" ? own.param as string : detailParam(body?.detail);
  const code = typeof own?.code === "string" ? own.code as string : undefined;
  return new OpenAiRequestError(message ?? `The model returned HTTP ${response.status}.`, response.status, {
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(param ? { param } : {}),
    ...(code ? { code } : {}),
    ...(quotaByType(own) ? { kind: "quota" as const } : {}),
  });
}

/**
 * Whether an error names a quota that ran out in its `type` alone: OpenAI's own errors did, with
 * `code: null`, and servers that copy them still do. No wait mends it, and it is not sent again.
 */
const quotaByType = (error: Json | undefined): boolean => error?.type === "insufficient_quota";

/** FastAPI's `detail`: a message, or a list of problems, each with its own `msg`. */
function detailText(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (!Array.isArray(detail)) return undefined;
  return detail.map((problem) => (typeof (problem as Json | null)?.msg === "string" ? (problem as Json).msg as string : "")).filter(Boolean).join("; ") || undefined;
}

/**
 * The request field FastAPI's `detail` is about, when it lists one problem and its place (`loc`):
 * `["body", "max_tokens"]` is "max_tokens". The message alone ("Extra inputs are not permitted")
 * does not name it.
 */
function detailParam(detail: unknown): string | undefined {
  if (!Array.isArray(detail) || detail.length !== 1) return undefined;
  const loc: unknown = (detail[0] as Json | null)?.loc;
  if (!Array.isArray(loc)) return undefined;
  const path = (loc[0] === "body" ? loc.slice(1) : loc).filter((step) => typeof step === "string" || typeof step === "number");
  return path.length > 0 ? path.join(".") : undefined;
}

/** The error a reply that came with 200 holds instead of choices, when it holds one. */
function bodyError(data: unknown): unknown {
  const body = (Array.isArray(data) ? data[0] : data) as Json | null | undefined;
  return body && typeof body === "object" && body.error ? body.error : undefined;
}

/**
 * An error event inside a stream, or a body, that began with 200, with the server's own word for it.
 * `status` is that of `streamErrorStatus`, unless the caller tells it apart in its own way.
 */
export function streamFailure(failed: unknown, status: number = streamErrorStatus(failed)): OpenAiRequestError {
  const named = failed && typeof failed === "object" ? failed as Json : {};
  return new OpenAiRequestError(typeof failed === "string" ? failed : String(named.message ?? "The model reported an error."), status, {
    ...(typeof named.code === "string" && named.code ? { code: named.code } : {}),
    ...(typeof named.param === "string" && named.param ? { param: named.param } : {}),
    ...(quotaByType(named) ? { kind: "quota" as const } : {}),
  });
}

/** The text parts of a turn, the empty ones left out, joined by a blank line. */
export const textOf = (message: ModelTextMessage): string => message.parts.map((part) => part.text ?? "").filter(Boolean).join("\n\n");

/** A file as a content part: an image as `image_url` (with no `detail`), any other file as a `file` part. */
function filePart(file: ToolFile): Record<string, unknown> {
  const data = `data:${file.mimeType};base64,${base64(file.bytes)}`;
  return file.mimeType.startsWith("image/") ? { type: "image_url", image_url: { url: data } } : { type: "file", file: { filename: file.name, file_data: data } };
}

/**
 * A turn of text. One with nothing but text is a string, which every server takes; native parts make
 * it a list. Its files (`ModelTextMessage.files`, since 0.99.9) come first: a PDF as a `file` part,
 * an image as `image_url`; a file of another type is a TypeError.
 */
function textMessage(message: ModelTextMessage): OpenAiMessage {
  const files = messageFiles("openAiCompatible()", message);
  const plain = message.parts.every((part) => part.native === undefined);
  if (files.length === 0 && plain) return { role: message.role, content: textOf(message) };
  // With files, text alone is the one part the string would have been.
  const text = textOf(message);
  const parts = plain ? (text ? [{ type: "text", text }] : []) : message.parts.map((part) => (part.native !== undefined ? part.native : { type: "text", text: part.text }));
  return { role: message.role, content: [...files.map(filePart), ...parts] };
}

/**
 * Turns of the user that follow each other, made one. The loop can send the question and the
 * request for an answer after it with no turn between them, and some servers (DeepSeek's reasoner,
 * the chat templates of Mistral and Gemma models) refuse two user turns in a row.
 */
function joinUserTurns(messages: OpenAiMessage[]): OpenAiMessage[] {
  const parts = (content: unknown): unknown[] => (typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : Array.isArray(content) ? content : []);
  const out: OpenAiMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last?.role !== "user" || message.role !== "user") {
      out.push(message);
      continue;
    }
    out[out.length - 1] = {
      role: "user",
      content: typeof last.content === "string" && typeof message.content === "string"
        ? [last.content, message.content].filter(Boolean).join("\n\n")
        : [...parts(last.content), ...parts(message.content)],
    };
  }
  return out;
}

/**
 * The messages of one tool round. `number` makes the IDs of calls that came without one. `files`:
 * whether the files of tools are sent (`pdfInput` or `imageInput`).
 */
function roundMessages(round: ModelToolRound, number: number, files: boolean): OpenAiMessage[] {
  const idOf = (call: ToolCall, index: number) => call.id ?? `call_${number}_${index + 1}`;
  // Its own turn goes back as it came: a server may want what it put there (reasoning, signatures).
  const asked: OpenAiMessage = round.raw !== undefined ? round.raw as OpenAiMessage : {
    role: "assistant",
    content: null,
    tool_calls: round.calls.map((call, index) => ({ id: idOf(call, index), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
  };
  const results = round.answers.map((answer, index): OpenAiMessage => ({ role: "tool", tool_call_id: idOf(answer.call, index), content: JSON.stringify(answer.result) }));
  // A tool message holds text. Files follow in a user turn, each after a line that names it: a PDF
  // as a `file` part, a page drawn as an image as `image_url` (since 0.99.9).
  const beside = files ? round.answers.flatMap((answer) => (answer.files ?? []).flatMap((file) => [
    { type: "text", text: `${file.name} (returned by ${answer.call.name}):` },
    filePart(file),
  ])) : [];
  return [asked, ...results, ...(beside.length > 0 ? [{ role: "user", content: beside }] : [])];
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

/** An ID for a call that came without one: no round of another question has it. */
export const newCallId = (): string => `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

/**
 * The tool rounds a question returned (`AskResult.toolTurns`) as Chat Completions messages, for an
 * application that keeps its history in that form: put them between the question and its answer.
 * A round of a newer version is a TypeError, as in askWithFiles (since 0.99.9).
 */
export function openAiToolTurns(turns: ToolTurn[]): OpenAiMessage[] {
  for (const turn of turns) checkToolTurnVersion(turn);
  return turns.flatMap((turn, index) => {
    // A call that came without an ID is given one that no round of another question has: these
    // messages are kept, and sent again next to those of later questions.
    const answers = turn.calls.map(({ result, ...call }) => ({ call: call.id ? call : { ...call, id: newCallId() }, result: laterResult(result) }));
    return roundMessages({ role: "tools", calls: answers.map((answer) => answer.call), answers }, index + 1, false);
  });
}

/** A model behind a Chat Completions endpoint, for `askWithFiles`. */
export function openAiCompatible(options: OpenAiCompatibleOptions): ModelAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const url = options.url ?? `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const { hostname, pathname } = (() => {
    try {
      return new URL(url);
    } catch {
      return { hostname: "", pathname: "" };
    }
  })();
  // Azure OpenAI answers on three kinds of host. On the two it shares with other models, only its `/openai/` paths are OpenAI's.
  const official = /(^|\.)openai\.com$|\.openai\.azure\.com$/.test(hostname)
    || (/\.(cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(hostname) && pathname.includes("/openai/"));
  /** The name of the output limit in a part read: changed once when the server refuses it and no name was given. */
  let maxTokensField = options.maxTokensField ?? (official ? "max_completion_tokens" : "max_tokens");
  const systemRole = options.systemRole ?? "system";
  const pdfInput = options.pdfInput === true;
  const imageInput = options.imageInput === true;
  const documents = documentsOption("openAiCompatible()", options.documents, ["pdf"]);
  /**
   * Whether a streamed request asks for its usage (`stream_options`): changed once, when the server
   * refuses the field. A `stream_options` of `body` is the application's own, and is left as it is.
   */
  let usageInStream = !(options.body && "stream_options" in options.body);

  /**
   * The headers of a request. A key or headers function that throws fails the request before
   * anything is sent (since 0.99.13): a connection that failed on the way is sent again, anything
   * else is an "auth" error (`headerFailure`).
   */
  const headersNow = async (): Promise<Record<string, string>> => {
    try {
      const key = await resolveSecret(options.apiKey);
      return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...await resolveHeaderSource(options.headers) };
    } catch (error) {
      throw headerFailure(error, OpenAiRequestError, "The model");
    }
  };

  const built = new WeakMap<ModelToolRound, { number: number; messages: OpenAiMessage[] }>();
  const toMessages = (messages: ModelMessage[]): OpenAiMessage[] => {
    let rounds = 0;
    return joinUserTurns(messages.flatMap((message) => {
      if (message.role !== "tools") return [textMessage(message)];
      const number = ++rounds;
      let known = built.get(message);
      if (!known || known.number !== number) {
        known = { number, messages: roundMessages(message, number, pdfInput || imageInput) };
        built.set(message, known);
      }
      return known.messages;
    }));
  };
  const bodyOf = (request: ModelRequest, stream: boolean, usage = false): Json => {
    const mustAnswer = request.toolChoice === "none";
    const listTools = Boolean(request.tools?.length) && !(mustAnswer && options.answerWithoutTools === "omit");
    return {
      model: options.model,
      messages: [...(request.system ? [{ role: systemRole, content: request.system }] : []), ...toMessages(request.messages)],
      ...(listTools ? { tools: request.tools!.map(asFunction), ...(mustAnswer ? { tool_choice: "none" } : {}) } : {}),
      ...(stream ? { stream: true, ...(usage ? { stream_options: { include_usage: true } } : {}) } : {}),
      ...options.body,
    };
  };

  /**
   * Sends a request. A `bounded` one (a part read, whose time limit is its signal) stops waiting
   * when the signal aborts, even for a fetch that does not stop then itself.
   */
  const post = async (body: Json, signal: AbortSignal | undefined, stopped: () => boolean, lost: (error: unknown) => OpenAiRequestError = unreachable, headers?: Record<string, string>, bounded = false): Promise<Response> => {
    let response: Response;
    // Outside the try: a key that could not be had is its own error, not a connection that failed.
    const given = headers ?? await headersNow();
    try {
      const sent = fetchImpl(url, { method: "POST", headers: given, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      response = await (bounded ? until(sent, signal) : sent);
    } catch (error) {
      if (stopped()) throw error;
      throw lost(error);
    }
    if (!response.ok) throw await failure(response);
    return response;
  };

  const generateText: GenerateText = ({ system, prompt, maxOutputTokens, signal, onTruncated, onUsage }) => {
    const send = async (limit: number): Promise<LimitedReply> => {
      const timer = partTimer(signal, options.timeoutMs);
      try {
        return await read(limit, timer);
      } finally {
        timer.stop();
      }
    };
    /** One part read, within its time limit: past it, a timeout. A stop of the caller's is reported as it is. */
    const read = async (limit: number, timer: PartTimer): Promise<LimitedReply> => {
      const stopped = () => Boolean(signal?.aborted);
      const lost = (error: unknown) => (timer.expired && !signal?.aborted ? tooSlow(timer.limitMs) : unreachable(error));
      const body = (field: string): Json => ({
        model: options.model,
        messages: [{ role: systemRole, content: system }, { role: "user", content: prompt }],
        [field]: limit,
        ...options.analysisBody?.(limit),
      });
      let response: Response;
      // The name this request is sent with: part reads run together, and another may learn the other name meanwhile.
      const sent = maxTokensField;
      try {
        response = await post(body(sent), timer.signal, stopped, lost, undefined, true);
      } catch (error) {
        // A server that knows only the other name of the output limit: it is sent that one, now and from now on.
        if (options.maxTokensField !== undefined || !refusesField(error, sent)) throw error;
        const other = sent === "max_tokens" ? "max_completion_tokens" : "max_tokens";
        if (maxTokensField === sent) maxTokensField = other;
        response = await post(body(other), timer.signal, stopped, lost, undefined, true);
      }
      const data = await readJson<Json>(response, stopped, lost, timer.signal ? { pulse: () => undefined, signal: timer.signal } : undefined, (error) => new OpenAiRequestError(notJsonMessage("The model's", response), response.status, { kind: "invalid", cause: error }));
      // An error in a body that came with 200 (OpenRouter, once generation has started): thrown as
      // a stream's error is, with its status, so that a 502 is sent again rather than read as no text.
      const failed = bodyError(data);
      if (failed) throw streamFailure(failed);
      const used = usageOf(data.usage);
      onUsage?.(used);
      const choice = data.choices?.[0];
      // DeepSeek stops a reply when its servers run short: that is the server's failure, sent again.
      if (choice?.finish_reason === "insufficient_system_resource") throw interrupted();
      return {
        text: contentText(choice?.message?.content),
        cutOff: choice?.finish_reason === "length",
        // Stopped by the content filter before its end: what it wrote is not all there is.
        stopped: choice?.finish_reason === "content_filter",
        ...(typeof choice?.finish_reason === "string" ? { reason: choice.finish_reason } : {}),
        thoughts: used.thoughtTokens ?? 0,
      };
    };
    return completeWithinLimit(`${url}|${options.model}`, maxOutputTokens, send, { signal, onTruncated, memory: options.outputLimits });
  };

  return {
    id: options.id ?? options.model,
    capabilities: {
      ...(options.contextTokens ? { contextTokens: options.contextTokens } : {}),
      ...(options.maxRequestBytes ? { maxRequestBytes: options.maxRequestBytes } : {}),
      toolFiles: pdfInput || imageInput ? "beside" : "none",
      pageTokens: options.pageTokens ?? 1_000,
      ...(options.tokenScale ? { tokenScale: options.tokenScale } : {}),
      // Since 0.99.9, only with the options: without them the object of 0.10.
      ...(imageInput ? { toolFileTypes: pdfInput ? ["application/pdf", "image/png", "image/jpeg"] as const : ["image/png", "image/jpeg"] as const } : {}),
      ...(documents ? { documents } : {}),
    },
    requestBytes: (request) => Buffer.byteLength(JSON.stringify(bodyOf(request, false))),
    generateText,

    async send(request: ModelRequest, hooks: SendHooks = {}): Promise<ModelReply> {
      const stream = Boolean(hooks.onText) && options.stream !== false;
      // A key or token is fetched before the watch starts: the time that takes is not the model's.
      const headers = await headersNow();
      const watch = idleWatch(hooks.signal, { firstByteTimeoutMs: options.firstByteTimeoutMs, idleTimeoutMs: options.idleTimeoutMs });
      // A request the watch aborted got nothing back for the whole wait: that is no failed connection.
      const lost = (error: unknown) => (watch.expired ? silent(watch.waitedMs) : unreachable(error));
      const stopped = () => Boolean(hooks.signal?.aborted);
      try {
        // Whether this request asks for its usage: another request may learn meanwhile that the server refuses the field.
        const sent = stream && usageInStream;
        let response: Response;
        try {
          // The headers are no piece of the reply: a server may send them at once and then think.
          response = await post(bodyOf(request, stream, sent), watch.signal, stopped, lost, headers);
        } catch (error) {
          // A server that does not know `stream_options`: the request is sent without it, now and
          // from now on. Its replies then come without their usage, unless the server sends it anyway.
          if (!sent || !refusesStreamOptions(error)) throw error;
          response = await post(bodyOf(request, stream, false), watch.signal, stopped, lost, headers);
          usageInStream = false;
        }
        return await readReply(response, stream, hooks, watch, lost);
      } finally {
        watch.stop();
      }
    },
  };

  /** The reply of a request that was answered: streamed, or in one piece. */
  async function readReply(answer: Response, stream: boolean, hooks: SendHooks, watch: IdleWatch, lost: (error: unknown) => OpenAiRequestError): Promise<ModelReply> {
    {
      let message: Json;
      let finish: unknown;
      let usage: Json | undefined;
      let text = "";
      /** The provider's ID of the response and the model that wrote it, when it names them. */
      let responseId: string | undefined;
      let responseModel: string | undefined;
      const named = (data: Json | undefined) => {
        if (typeof data?.id === "string" && data.id) responseId = data.id;
        if (typeof data?.model === "string" && data.model) responseModel = data.model;
      };
      // A body that is no JSON (a gateway's page) is not the model's reply, and is not sent again.
      const notJson = (error: unknown) => new OpenAiRequestError(notJsonMessage("The model's", answer), answer.status, { kind: "invalid", cause: error });
      let response = answer;
      let events = false;
      if (stream && answer.body) {
        try {
          ({ events, response } = await streamedReply(answer, watch));
        } catch (error) {
          if (hooks.signal?.aborted) throw error;
          throw noteCutReply(lost(error));
        }
      }
      if (events && response.body) {
        let reasoning = "";
        let reasoningText = "";
        let refusal = "";
        const details: Json[] = [];
        const toolCalls: Json[] = [];
        let ended = false;
        // "[DONE]" ends the reply: a server that leaves the connection open after it is not waited for.
        const end = replyEnd(watch);
        try {
          for await (const chunk of parseSseJson<Json>(response.body, { onData: watch.pulse, onDone: () => { ended = true; end.reached(); }, signal: end.signal })) {
            const failed = (Array.isArray(chunk) ? chunk[0] : chunk)?.error;
            if (failed) throw streamFailure(failed);
            named(chunk);
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
            // What a non-streamed reply holds in fields of its own: a refusal, and the reasoning of
            // OpenRouter, whose details (a thought signature among them) must go back with the turn.
            if (typeof delta.refusal === "string") refusal += delta.refusal;
            if (typeof delta.reasoning === "string") reasoningText += delta.reasoning;
            if (Array.isArray(delta.reasoning_details)) for (const detail of delta.reasoning_details as unknown[]) addReasoningDetail(details, detail);
            for (const part of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as Json[]) {
              // A call arrives in pieces under its index: first its ID and name, then its arguments, a
              // few characters at a time. A server that sends no index starts a new call with an ID
              // that is not the last call's: one that sends the ID with every piece adds to that call.
              const last = toolCalls[toolCalls.length - 1] as Json | undefined;
              const at = typeof part.index === "number" ? part.index : toolCalls.length === 0 || (part.id && part.id !== last?.id) ? toolCalls.length : toolCalls.length - 1;
              const call = (toolCalls[at] ??= { type: "function", function: { name: "", arguments: "" } });
              for (const [key, value] of Object.entries(part)) {
                if (key !== "index" && key !== "function" && value !== undefined && value !== null && !(key === "id" && call.id)) call[key] = value;
              }
              // The name comes whole in the first piece of a call. A server that sends it again with
              // each piece does not make it longer; one that sends it in pieces does.
              const name = part.function?.name;
              if (typeof name === "string" && name !== call.function.name) call.function.name += name;
              if (typeof part.function?.arguments === "string") call.function.arguments += part.function.arguments;
            }
            finish = choice.finish_reason ?? finish;
          }
        } catch (error) {
          // The reply ended with "[DONE]", and the connection then stayed open, or broke rather than
          // end: what came before it is whole.
          const whole = end.left(error) || (end.whole && !hooks.signal?.aborted && !(error instanceof OpenAiRequestError));
          if (!whole) {
            if (hooks.signal?.aborted || error instanceof OpenAiRequestError) throw error;
            // An event too long to read would come again: it is not sent again, like a page in the reply's place.
            if (error instanceof SseEventTooLongError) throw new OpenAiRequestError(eventTooLongMessage("The model's", error), answer.status, { kind: "invalid", cause: error });
            // The connection went while the answer was on its way, or nothing came for the whole wait.
            throw noteCutReply(lost(error));
          }
        } finally {
          end.dispose();
        }
        // A stream ends with a reason for its end, and with "[DONE]". One that closed with neither
        // was cut off on its way (a proxy, a dropped connection): it is not a whole reply, and is
        // sent again like a connection that failed, unless text of it was shown.
        if (finish === undefined && !ended) throw noteCutReply(new OpenAiRequestError("The model's reply ended before it was complete.", 0));
        const calls = toolCalls.filter(Boolean);
        message = {
          role: "assistant",
          content: text || null,
          ...(refusal ? { refusal } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(reasoningText ? { reasoning: reasoningText } : {}),
          ...(details.length > 0 ? { reasoning_details: details } : {}),
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        };
        // A refusal is what the model has to say to the user, as it is without streaming.
        if (!text && refusal) {
          text = refusal;
          hooks.onText?.(refusal);
        }
      } else {
        // In one piece: no streaming was asked for, or the server answered without it.
        const data = await readJson<Json>(response, () => Boolean(hooks.signal?.aborted), lost, watch, notJson);
        // An error in a body that came with 200, as a stream may send one: not an empty reply.
        const failed = bodyError(data);
        if (failed) throw streamFailure(failed);
        const choice = data.choices?.[0] as Json | undefined;
        message = (choice?.message ?? { role: "assistant", content: null }) as Json;
        finish = choice?.finish_reason;
        usage = data.usage as Json | undefined;
        named(data);
        // The whole reply is in hand: one that the server stopped is sent again before any of it is shown.
        if (finish === "insufficient_system_resource") throw interrupted();
        // A refusal is what the model has to say to the user, in a field of its own.
        text = contentText(message.content) || (typeof message.refusal === "string" ? message.refusal : "");
        if (text) hooks.onText?.(text);
      }
      // DeepSeek stops a reply when its servers run short: what came of it is not the model's whole
      // turn. That is the server's failure, sent again unless text of it was shown.
      if (finish === "insufficient_system_resource") throw interrupted();
      // Cut off at the output limit with a call half-written: the call is answered, not run.
      const cutOff = finish === "length" ? "This call was cut off at the output limit before its arguments were complete, and was not run. Send it again." : undefined;
      const calls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls as Json[] : [])
        .filter((call) => typeof call?.function?.name === "string" && call.function.name)
        .map((call) => {
          // A call that came without an ID is given one, once, in the turn that goes back too: its
          // tool message must name the same ID as the call does.
          if (typeof call.id !== "string" || !call.id) call.id = newCallId();
          const read = readArguments(call.function.arguments);
          // Arguments that are not a JSON object go back as none, and so do arguments that are
          // empty: a server that reads every call of the conversation (vLLM before 0.29) refuses
          // the next request when one is not JSON.
          const written = call.function.arguments;
          if (read.problem || typeof written !== "string" || !written.trim()) call.function = { ...call.function, arguments: read.problem ? "{}" : JSON.stringify(read.args) };
          const problem = read.problem ?? cutOff;
          return { id: call.id as string, name: call.function.name as string, args: read.args, ...(problem ? { problem } : {}) };
        });
      const kind = finishOfOpenAi(finish);
      return {
        text,
        calls,
        raw: message,
        ...(typeof finish === "string" ? { finishReason: finish } : {}),
        ...(kind ? { finish: kind } : {}),
        ...(finish === "content_filter" && !text && calls.length === 0 ? { blockReason: "content_filter" } : {}),
        ...(responseId ? { responseId } : {}),
        ...(responseModel ? { responseModel } : {}),
        ...(usage ? { usage: usageOf(usage), providerUsage: usage } : {}),
      };
    }
  }
}

/**
 * A request that got no answer: the reason, without the stack of the HTTP client. Since 0.99.13 an
 * answer that did not come in time (undici's headers or body timeout) is of kind "timeout", and is
 * sent again once, not three times (`connectionFailure`).
 */
export function unreachable(error: unknown): OpenAiRequestError {
  if (connectionFailure(error)?.kind === "timeout") return new OpenAiRequestError(`The model took too long to answer${unreachableReason(error)}.`, 0, { kind: "timeout", cause: error });
  return new OpenAiRequestError(`The model could not be reached${unreachableReason(error)}.`, 0, { cause: error });
}

/** A request that got nothing back for the whole wait of its `IdleWatch`. */
export function silent(waitMs: number): OpenAiRequestError {
  return new OpenAiRequestError(`The model sent nothing for ${Math.round(waitMs / 1_000)} s.`, 0, { kind: "timeout" });
}

/** A part read whose whole reply did not come within its time limit (`timeoutMs`). */
export function tooSlow(limitMs: number): OpenAiRequestError {
  return new OpenAiRequestError(`The model took longer than ${waitText(limitMs)} to answer.`, 0, { kind: "timeout" });
}

/** A reply the server stopped because it ran short (DeepSeek's `insufficient_system_resource`). */
function interrupted(): OpenAiRequestError {
  return new OpenAiRequestError("The model's server stopped the reply: it ran short of resources.", 503);
}

/** `finish_reason` in the terms of `ModelReply.finish`. Undefined for a reason it does not know. */
function finishOfOpenAi(reason: unknown): ModelReply["finish"] {
  if (reason === "stop" || reason === "tool_calls" || reason === "function_call") return "complete";
  if (reason === "length") return "cut";
  if (reason === "content_filter") return "filtered";
  return undefined;
}
