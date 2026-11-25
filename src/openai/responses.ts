// OpenAI's Responses API as a model of `askWithFiles`: OpenAI, and the v1 API of Azure OpenAI. No
// SDK. Every request is stateless (`store: false`) and carries the whole conversation, the reasoning
// items of the question included.
import { base64, idleWatch, noteCutReply, notJsonMessage, partTimer, readArguments, readJson, replyEnd, resolveHeaderSource, resolveSecret, streamedReply, until, type HeaderSource, type IdleWatch, type PartTimer, type SecretSource } from "../http.js";
import type { ModelAdapter, ModelMessage, ModelReply, ModelRequest, ModelTextMessage, ModelToolRound, SendHooks, ToolCall } from "../model.js";
import { completeWithinLimit, type LimitedReply } from "../output-limit.js";
import { eventTooLongMessage, parseSseJson, SseEventTooLongError } from "../sse.js";
import type { GenerateText, GenerateUsage, ToolFile } from "../types.js";
import { failure, newCallId, OpenAiRequestError, silent, streamErrorStatus, streamFailure, textOf, tooSlow, unreachable } from "./adapter.js";

/** The options of `openAiResponses()`. New in 0.99.9. */
export type OpenAiResponsesOptions = {
  /** The model name the endpoint knows: "gpt-5.5", an Azure deployment name. */
  model: string;
  /**
   * The base of the API: `/responses` is added to it. Defaults to https://api.openai.com/v1.
   * Azure OpenAI: https://{resource}.openai.azure.com/openai/v1. Trailing slashes are removed.
   */
  baseUrl?: string | undefined;
  /** The whole Responses URL, when it is not `baseUrl` + `/responses` (a gateway). Used as it is. */
  url?: string | undefined;
  /** Sent as `Authorization: Bearer …`. A function is called for each request (an Entra ID token). */
  apiKey?: SecretSource | undefined;
  /** More headers, merged last (Azure's `api-key`). A function is called for each request. */
  headers?: HeaderSource | undefined;
  /**
   * More fields for the body of every chat request, spread last: `reasoning` ({ effort, summary }),
   * `max_output_tokens`, `prompt_cache_key`, `service_tier`, `text`, `truncation`, `include`,
   * `store`. A field set to undefined is left out of the JSON. Not sent with part reads.
   */
  body?: Record<string, unknown> | undefined;
  /** More fields for the body of a whole-document part read, given the output limit it is sent with. */
  analysisBody?: ((maxOutputTokens: number) => Record<string, unknown>) | undefined;
  /**
   * Ask for the encrypted content of reasoning items (`include: ["reasoning.encrypted_content"]`),
   * so that a reasoning model's thinking goes back with the tool results of the next request.
   * Left out: asked for, and when the server refuses it (HTTP 400 naming `include` or encrypted
   * content) the request is sent again without it, and this adapter stops asking. true: always
   * asked for. false: never (a reasoning item that comes without encrypted content is then not
   * sent back, unless `body.store` is true).
   */
  encryptedReasoning?: boolean | undefined;
  /**
   * Where the files a tool returned (the pages of `view_pages`) go: "inside" the
   * `function_call_output`, as content parts after its JSON; "beside" it, in a user message after
   * the outputs of the round; or "none" (the default), which turns `view_pages` off.
   */
  toolFilePlacement?: "inside" | "beside" | "none" | undefined;
  /** Stream the answer when the caller listens for text. Defaults to true. False for a server without streaming. */
  stream?: boolean | undefined;
  /** The model's context window in tokens, when the budget of a question should follow it. */
  contextTokens?: number | undefined;
  /** The largest request body the endpoint takes, in bytes. */
  maxRequestBytes?: number | undefined;
  /** Tokens billed for one PDF page, when pages are sent. Defaults to 1,000. */
  pageTokens?: number | undefined;
  /** This model's tokens for one token of the library's estimate. Defaults to 1. */
  tokenScale?: number | undefined;
  /**
   * Milliseconds a part read may take, its whole reply included. Defaults to 180,000; 0 sets none.
   * A part past it is an `OpenAiRequestError` of kind "timeout" and status 0.
   */
  timeoutMs?: number | undefined;
  /**
   * The longest wait, in milliseconds, for the first piece of a chat reply. Headers do not count.
   * A request that gets nothing for that long is aborted and sent again, once. Defaults to 600,000.
   * 0 waits without end.
   */
  firstByteTimeoutMs?: number | undefined;
  /**
   * The longest wait, in milliseconds, between two pieces of a chat reply once it has started to
   * arrive. A request that gets nothing for that long is aborted and sent again, once, unless text
   * of it was shown. Defaults to 300,000. 0 waits without end.
   */
  idleTimeoutMs?: number | undefined;
  /** Names the model in usage totals. Defaults to `model`. */
  id?: string | undefined;
  fetch?: typeof fetch | undefined;
};

type Json = Record<string, any>;

/**
 * The status of an error that the Responses API names with a word of its own, inside a stream or a
 * body of 200: Azure's error types (`too_many_requests`, `forbidden`, `user_error`), and the codes
 * of a response that failed.
 */
const RESPONSES_STATUS_OF_ERROR: Record<string, number> = {
  too_many_requests: 429, forbidden: 403, user_error: 400,
  invalid_prompt: 400, data_residency_mismatch: 400, bio_policy: 400, misalignment_policy_violation: 400,
  vector_store_timeout: 408, content_filter: 400,
};

/**
 * The HTTP status of an error of the Responses API that came inside a stream or a body of 200: from
 * its type or its code, the words of this API first (an `image` in it is a refused image, 400), then
 * as `streamErrorStatus` tells them. A failure the server did not name is its own, 500. New in
 * 0.99.9; exported for the tests, not from the entry point.
 */
export function responsesErrorStatus(failed: unknown): number {
  if (failed && typeof failed === "object") {
    const { code, type } = failed as { code?: unknown; type?: unknown };
    for (const word of [type, code]) {
      if (typeof word !== "string") continue;
      const status = RESPONSES_STATUS_OF_ERROR[word];
      if (status !== undefined) return status;
      if (word.includes("image")) return 400;
    }
  }
  return streamErrorStatus(failed);
}

/** An error of the Responses API inside a stream or a body of 200, with its status and the server's own word for it. */
const responsesFailure = (failed: unknown): OpenAiRequestError => streamFailure(failed, responsesErrorStatus(failed));

/** The words of a call that the loop answers instead of running it. */
const CUT_OFF = "This call was cut off at the output limit before its arguments were complete, and was not run. Send it again.";
const NOT_WHOLE = "This call did not arrive whole, and was not run. Send it again.";

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A body read as JSON, as an object: a list gives its first entry, and anything else none. */
const objectOf = (value: unknown): Json => {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return isObject(first) ? first : {};
};

function usageOf(usage: Json | undefined): GenerateUsage {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    inputTokens: number(usage?.input_tokens),
    cachedInputTokens: number(usage?.input_tokens_details?.cached_tokens),
    outputTokens: number(usage?.output_tokens),
    thoughtTokens: number(usage?.output_tokens_details?.reasoning_tokens),
  };
}

/** The text of the message items of a response: the `output_text` parts of each, then the messages joined by a blank line. */
function outputTextOf(items: Json[]): string {
  return items
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .map((item) => (item.content as unknown[]).map((part) => (isObject(part) && part.type === "output_text" && typeof part.text === "string" ? part.text : "")).join(""))
    .filter(Boolean)
    .join("\n\n");
}

/** The refusal parts of the message items of a response, joined. */
function refusalOf(items: Json[]): string {
  return items
    .flatMap((item) => (item.type === "message" && Array.isArray(item.content) ? item.content as unknown[] : []))
    .map((part) => (isObject(part) && part.type === "refusal" && typeof part.refusal === "string" ? part.refusal : ""))
    .join("");
}

/** A file a tool returned, as a content part: an image as `input_image`, any other file as `input_file`. */
function fileContent(file: ToolFile): Json {
  const data = `data:${file.mimeType};base64,${base64(file.bytes)}`;
  return file.mimeType.startsWith("image/")
    ? { type: "input_image", image_url: data, detail: "auto" }
    : { type: "input_file", filename: file.name, file_data: data };
}

/**
 * A turn of text. One with nothing but text has a string as its content, which every server takes.
 * Native parts make it a list, where text is `input_text` in a user turn and `output_text` in an
 * assistant turn: the Responses API refuses `input_text` from the assistant.
 */
function textItem(message: ModelTextMessage): Json {
  if (message.parts.every((part) => part.native === undefined)) return { role: message.role, content: textOf(message) };
  const type = message.role === "assistant" ? "output_text" : "input_text";
  return { role: message.role, content: message.parts.map((part) => (part.native !== undefined ? part.native : { type, text: part.text })) };
}

/** A user turn of the input: an item with no `type` of its own. */
const isUserTurn = (item: Json | undefined): item is Json => item?.role === "user" && item.type === undefined;

/**
 * User turns that follow each other, made one: the question and the request for an answer after it,
 * or the files of a round and that request. Some servers' chat templates refuse two in a row.
 */
function joinUserItems(items: Json[]): Json[] {
  const parts = (content: unknown): unknown[] => (typeof content === "string" ? (content ? [{ type: "input_text", text: content }] : []) : Array.isArray(content) ? content : []);
  const out: Json[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (!isUserTurn(last) || !isUserTurn(item)) {
      out.push(item);
      continue;
    }
    out[out.length - 1] = {
      role: "user",
      content: typeof last.content === "string" && typeof item.content === "string"
        ? [last.content, item.content].filter(Boolean).join("\n\n")
        : [...parts(last.content), ...parts(item.content)],
    };
  }
  return out;
}

/** The input items of one tool round. `number` makes the IDs of calls that came without one. */
function roundItems(round: ModelToolRound, number: number, placement: "inside" | "beside" | "none"): Json[] {
  const idOf = (call: ToolCall, index: number) => call.id ?? `call_${number}_${index + 1}`;
  // Its own turn of this question goes back as it came, in order: the reasoning items with their
  // encrypted content, the messages, the calls. A round of another model, or a stored one, is its
  // calls alone, without the `id` of an item, so that it is linked to no stored or reasoning item.
  const asked: Json[] = round.raw !== undefined
    ? (Array.isArray(round.raw) ? round.raw as Json[] : [round.raw as Json])
    : round.calls.map((call, index) => ({ type: "function_call", call_id: idOf(call, index), name: call.name, arguments: JSON.stringify(call.args) }));
  const outputs = round.answers.map((answer, index): Json => {
    const result = JSON.stringify(answer.result);
    const files = placement === "inside" ? answer.files ?? [] : [];
    return { type: "function_call_output", call_id: idOf(answer.call, index), output: files.length > 0 ? [{ type: "input_text", text: result }, ...files.map(fileContent)] : result };
  });
  // Files beside the outputs follow in a user turn, each after a line that names it.
  const beside = placement === "beside"
    ? round.answers.flatMap((answer) => (answer.files ?? []).flatMap((file) => [{ type: "input_text", text: `${file.name} (returned by ${answer.call.name}):` }, fileContent(file)]))
    : [];
  return [...asked, ...outputs, ...(beside.length > 0 ? [{ role: "user", content: beside }] : [])];
}

/** The status of a response and the reason it is incomplete, in the terms of `ModelReply.finish`. */
function finishOfResponses(status: unknown, reason: unknown): ModelReply["finish"] {
  if (status === "completed") return "complete";
  if (status !== "incomplete") return undefined;
  if (reason === "max_output_tokens") return "cut";
  if (reason === "content_filter") return "filtered";
  return undefined;
}

/**
 * A model behind OpenAI's Responses API, or Azure OpenAI's, for `askWithFiles`: the model that
 * answers, or the explorer. Its requests are stateless: each sends `store: false` and the whole
 * conversation, and the reasoning items of the question go back with their encrypted content. It
 * makes no request when it is created, and throws nothing. New in 0.99.9.
 */
export function openAiResponses(options: OpenAiResponsesOptions): ModelAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const url = options.url ?? `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
  const placement = options.toolFilePlacement ?? "none";
  /** Whether chat requests ask for the encrypted content of reasoning: turned off once a server refuses it, unless the option was set. */
  let includeNow = options.encryptedReasoning !== false;

  const headersNow = async (): Promise<Record<string, string>> => {
    const key = await resolveSecret(options.apiKey);
    return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...await resolveHeaderSource(options.headers) };
  };

  const built = new WeakMap<ModelToolRound, { number: number; items: Json[] }>();
  const toInput = (messages: ModelMessage[]): Json[] => {
    let rounds = 0;
    return joinUserItems(messages.flatMap((message) => {
      if (message.role !== "tools") return [textItem(message)];
      const number = ++rounds;
      let known = built.get(message);
      if (!known || known.number !== number) {
        known = { number, items: roundItems(message, number, placement) };
        built.set(message, known);
      }
      return known.items;
    }));
  };
  const bodyOf = (request: ModelRequest, stream: boolean, include: boolean): Json => ({
    model: options.model,
    ...(request.system ? { instructions: request.system } : {}),
    input: toInput(request.messages),
    ...(request.tools?.length ? {
      // Not strict: the declarations have optional properties, which strict mode would change.
      tools: request.tools.map((declaration) => ({ type: "function", name: declaration.name, description: declaration.description, parameters: declaration.parameters, strict: false })),
      ...(request.toolChoice === "none" ? { tool_choice: "none" } : {}),
    } : {}),
    store: false,
    ...(include ? { include: ["reasoning.encrypted_content"] } : {}),
    ...(stream ? { stream: true } : {}),
    ...options.body,
  });

  /**
   * Whether a server refused to give the encrypted content of reasoning, when it was asked for it
   * and the option was left out: "Encrypted content is not supported with this model", or under
   * `store: true`, "Encrypted content cannot be requested for persisted responses".
   */
  const refusesInclude = (error: unknown, sent: boolean): boolean => options.encryptedReasoning === undefined && sent
    && error instanceof OpenAiRequestError && error.status === 400
    && (error.param === "include" || /reasoning\.encrypted_content|encrypted content/i.test(error.message));

  /**
   * Sends a request. A `bounded` one (a part read, whose time limit is its signal) stops waiting
   * when the signal aborts, even for a fetch that does not stop then itself.
   */
  const post = async (body: Json, signal: AbortSignal | undefined, stopped: () => boolean, lost: (error: unknown) => OpenAiRequestError, headers?: Record<string, string>, bounded = false): Promise<Response> => {
    let response: Response;
    try {
      const sent = fetchImpl(url, { method: "POST", headers: headers ?? await headersNow(), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
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
      // Nothing is replayed in a part read: no `include`, and not the chat's `body`.
      const body: Json = {
        model: options.model,
        ...(system ? { instructions: system } : {}),
        input: [{ role: "user", content: prompt }],
        max_output_tokens: limit,
        store: false,
        ...options.analysisBody?.(limit),
      };
      const response = await post(body, timer.signal, stopped, lost, undefined, true);
      const data = objectOf(await readJson<unknown>(response, stopped, lost, timer.signal ? { pulse: () => undefined, signal: timer.signal } : undefined, (error) => new OpenAiRequestError(notJsonMessage("The model's", response), response.status, { kind: "invalid", cause: error })));
      if (data.error || data.status === "failed") throw responsesFailure(data.error ?? {});
      const used = usageOf(data.usage);
      onUsage?.(used);
      const reason: unknown = data.incomplete_details?.reason;
      const why: unknown = data.status === "incomplete" ? (reason ?? "incomplete") : data.status;
      return {
        text: outputTextOf(Array.isArray(data.output) ? (data.output as unknown[]).filter(isObject) : []),
        cutOff: data.status === "incomplete" && reason === "max_output_tokens",
        // Stopped by the content filter before its end: what it wrote is not all there is.
        stopped: reason === "content_filter",
        ...(typeof why === "string" ? { reason: why } : {}),
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
      toolFiles: placement,
      pageTokens: options.pageTokens ?? 1_000,
      ...(options.tokenScale ? { tokenScale: options.tokenScale } : {}),
    },
    requestBytes: (request) => Buffer.byteLength(JSON.stringify(bodyOf(request, false, includeNow))),
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
        // Whether this request asks for encrypted reasoning: another request may learn meanwhile that the server refuses it.
        const sent = includeNow;
        let response: Response;
        try {
          response = await post(bodyOf(request, stream, sent), watch.signal, stopped, lost, headers);
        } catch (error) {
          if (!refusesInclude(error, sent)) throw error;
          response = await post(bodyOf(request, stream, false), watch.signal, stopped, lost, headers);
          // Only a request answered without `include` shows that `include` was refused: an error
          // about the encrypted content sent back in `input` fails the same way without it.
          includeNow = false;
        }
        return await readReply(response, stream, hooks, watch, lost);
      } finally {
        watch.stop();
      }
    },
  };

  /** The reply of a request that was answered: streamed, or in one piece. */
  async function readReply(answer: Response, stream: boolean, hooks: SendHooks, watch: IdleWatch, lost: (error: unknown) => OpenAiRequestError): Promise<ModelReply> {
    /** The output items of the response, in order. */
    let items: Json[];
    let text = "";
    let status: unknown;
    let reason: unknown;
    let usage: unknown;
    /** Calls that were begun in the stream and never finished: their arguments may not be all there. */
    const partial = new Set<Json>();
    /** The provider's ID of the response and the model that wrote it, when it names them. */
    let responseId: string | undefined;
    let responseModel: string | undefined;
    const named = (data: unknown) => {
      if (!isObject(data)) return;
      if (typeof data.id === "string" && data.id) responseId = data.id;
      if (typeof data.model === "string" && data.model) responseModel = data.model;
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
      // Each item of the output under its `output_index`: as it began, as it ended, and what came
      // of its arguments and text in between. Items of parallel calls arrive interleaved.
      const added = new Map<number, Json>();
      const done = new Map<number, Json>();
      const args = new Map<number, string>();
      const texts = new Map<number, string>();
      let refusal = "";
      let lastTextIndex: number | undefined;
      let terminal: Json | undefined;
      let terminalType: string | undefined;
      let ended = false;
      // The end of the response, or "[DONE]" of a proxy, ends the reply: a server that leaves the connection open after it is not waited for.
      const end = replyEnd(watch);
      try {
        for await (const chunk of parseSseJson<unknown>(response.body, { onData: watch.pulse, onDone: () => { ended = true; end.reached(); }, signal: end.signal })) {
          const one: unknown = Array.isArray(chunk) ? chunk[0] : chunk;
          if (!isObject(one)) continue;
          const type: unknown = one.type;
          // OpenAI's error event is flat ({ type: "error", code, message, param }); Azure's holds an
          // `error` object. The event's own type is never read as the error's.
          if (type === "error") throw responsesFailure(isObject(one.error) ? one.error : { code: one.code, message: one.message, param: one.param });
          if (type === "response.failed") throw responsesFailure(one.response?.error ?? {});
          if (type === undefined && one.error) throw responsesFailure(one.error);
          const at = typeof one.output_index === "number" ? one.output_index : 0;
          switch (type) {
            case "response.created":
            case "response.in_progress":
            case "response.queued":
              named(one.response);
              break;
            case "response.output_item.added":
              if (!isObject(one.item)) break;
              added.set(at, { ...one.item });
              if (one.item.type === "function_call") args.set(at, typeof one.item.arguments === "string" ? one.item.arguments : "");
              break;
            case "response.output_text.delta":
              if (typeof one.delta === "string" && one.delta) {
                // The text of another message item is set apart by a blank line, as in a reply in one piece.
                const piece = (text && lastTextIndex !== undefined && lastTextIndex !== at ? "\n\n" : "") + one.delta;
                text += piece;
                texts.set(at, (texts.get(at) ?? "") + one.delta);
                lastTextIndex = at;
                hooks.onText?.(piece);
              }
              break;
            case "response.refusal.delta":
              if (typeof one.delta === "string") refusal += one.delta;
              break;
            case "response.function_call_arguments.delta":
              if (typeof one.delta === "string") args.set(at, (args.get(at) ?? "") + one.delta);
              break;
            case "response.function_call_arguments.done":
              if (typeof one.arguments === "string") args.set(at, one.arguments);
              break;
            case "response.output_item.done":
              // The item as it ended is the one to keep: the encrypted content of a reasoning item
              // that was added may not be whole yet.
              if (isObject(one.item)) done.set(at, { ...one.item });
              break;
            case "response.completed":
            case "response.incomplete":
              terminal = isObject(one.response) ? one.response : {};
              terminalType = type;
              named(terminal);
              end.reached();
              break;
            default:
            // Content parts, reasoning summaries, annotations: nothing the reply needs. Their bytes still count as pieces of it.
          }
        }
      } catch (error) {
        // The response ended, and the connection then stayed open, or broke rather than end: what
        // came before is whole.
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
      // A stream ends with the end of its response, or "[DONE]". One that closed with neither was
      // cut off on its way: it is sent again like a connection that failed, unless text of it was shown.
      if (!terminal && !ended) throw noteCutReply(new OpenAiRequestError("The model's reply ended before it was complete.", 0));
      items = [];
      for (const index of [...new Set([...added.keys(), ...done.keys()])].sort((left, right) => left - right)) {
        const finished = done.get(index);
        if (finished) {
          items.push(finished);
          continue;
        }
        const begun = added.get(index)!;
        if (begun.type === "function_call") {
          const call = { ...begun, arguments: args.get(index) ?? "" };
          partial.add(call);
          items.push(call);
        } else if (begun.type === "message") {
          items.push({ ...begun, content: [{ type: "output_text", text: texts.get(index) ?? "", annotations: [] }] });
        }
        // A reasoning item that never ended has no whole encrypted content: it is left out.
      }
      // A server that sent no item events: the output of the response it ended with.
      if (items.length === 0 && Array.isArray(terminal?.output)) items = (terminal.output as unknown[]).filter(isObject).map((item) => ({ ...item }));
      status = terminal?.status ?? (terminalType === "response.completed" ? "completed" : terminalType === "response.incomplete" ? "incomplete" : undefined);
      reason = terminal?.incomplete_details?.reason;
      usage = terminal?.usage;
      // A server that sent the text with its items and no deltas: it goes to `onText` at once.
      if (!text) {
        text = outputTextOf(items);
        if (text) hooks.onText?.(text);
      }
      // A refusal is what the model has to say to the user, as it is without streaming.
      if (!text && (refusal || refusalOf(items))) {
        text = refusal || refusalOf(items);
        hooks.onText?.(text);
      }
    } else {
      // In one piece: no streaming was asked for, or the server answered without it.
      const data = objectOf(await readJson<unknown>(response, () => Boolean(hooks.signal?.aborted), lost, watch, notJson));
      // An error in a body that came with 200 (OpenAI's response always holds `error: null`).
      if (data.error || data.status === "failed") throw responsesFailure(data.error ?? {});
      named(data);
      items = Array.isArray(data.output) ? (data.output as unknown[]).filter(isObject).map((item) => ({ ...item })) : [];
      text = outputTextOf(items) || refusalOf(items);
      if (text) hooks.onText?.(text);
      status = data.status;
      reason = data.incomplete_details?.reason;
      usage = data.usage;
    }

    // Cut off at the output limit with a call half-written: the call is answered, not run.
    const cut = status === "incomplete" && reason === "max_output_tokens";
    // With `store: false` the server keeps nothing: a reasoning item without its encrypted content
    // would be refused ("Item with id 'rs_…' not found") when it goes back.
    const keepBare = options.body?.store === true;
    const raw: Json[] = [];
    const calls: ToolCall[] = [];
    for (const item of items) {
      if (item.type === "reasoning" && !keepBare && !(typeof item.encrypted_content === "string" && item.encrypted_content)) continue;
      if (item.type === "function_call") {
        if (typeof item.name !== "string" || !item.name) continue;
        // A call that came without an ID is given one, once, in the item that goes back too: its
        // output must name the same ID as the call does.
        if (typeof item.call_id !== "string" || !item.call_id) item.call_id = newCallId();
        const read = readArguments(item.arguments);
        // Arguments that are not a JSON object go back as none, and so do arguments that are empty.
        if (read.problem || typeof item.arguments !== "string" || !item.arguments.trim()) item.arguments = read.problem ? "{}" : JSON.stringify(read.args);
        const problem = read.problem ?? (partial.has(item) ? NOT_WHOLE : undefined) ?? (cut ? CUT_OFF : undefined);
        calls.push({ id: item.call_id as string, name: item.name, args: read.args, ...(problem ? { problem } : {}) });
      }
      raw.push(item);
    }
    const finishReason: unknown = status === "incomplete" ? (typeof reason === "string" ? reason : "incomplete") : status;
    const kind = finishOfResponses(status, reason);
    return {
      text,
      calls,
      raw,
      ...(typeof finishReason === "string" ? { finishReason } : {}),
      ...(kind ? { finish: kind } : {}),
      ...(reason === "content_filter" && !text && calls.length === 0 ? { blockReason: "content_filter" } : {}),
      ...(responseId ? { responseId } : {}),
      ...(responseModel ? { responseModel } : {}),
      ...(isObject(usage) ? { usage: usageOf(usage), providerUsage: usage } : {}),
    };
  }
}
