// Gemini (Generate Content REST) as a model of `askWithFiles`.
import { laterResult, TOOL_TURN_VERSION, type ChatMessage, type ModelAdapter, type ModelMessage, type ModelPart, type ModelReply, type ModelRequest, type ModelTextMessage, type ModelToolRound, type SendHooks, type ToolCall, type ToolTurn } from "../model.js";
import { TOOL_NAMES } from "../tools.js";
import type { ToolResult } from "../types.js";
import { retryAfterMs } from "../retry.js";
import { idleWatch, noteCutReply, readJson, streamedReply, type IdleWatch } from "../http.js";
import { eventTooLongMessage, parseSseJson, SseEventTooLongError } from "../sse.js";
import { resolveHeaders, type GeminiEndpoint } from "./endpoints.js";
import { finishOfGemini, geminiFailure, GeminiRequestError, notJson, silent, unreachable } from "./errors.js";
import { createGeminiGenerateText, geminiFunctionResponseTurns, usageOfGemini, type GeminiContent, type GeminiPart, type GeminiToolFilePlacement } from "./generate.js";

export type { GeminiContent, GeminiPart };

/** What Gemini bills for one PDF page it is shown (measured: 520 to 532). */
export const GEMINI_PAGE_TOKENS = 530;

export type GeminiModelOptions = {
  /** Sent with every chat request: temperature, maxOutputTokens, thinkingConfig, and so on. */
  generationConfig?: Record<string, unknown> | undefined;
  /**
   * Where the pages of `view_pages` go in the request. "inside" (the default) puts the PDF in the
   * function response itself, which Gemini 3 and 4 models read. "beside" sends it in a user turn
   * of its own, after the function responses: use it for Gemini 2.5, which does not see a file
   * inside a function response.
   */
  toolFilePlacement?: GeminiToolFilePlacement | undefined;
  /** generationConfig for whole-document part reads. Defaults to `{ maxOutputTokens }`, with no temperature. */
  analysisConfig?: ((maxOutputTokens: number) => Record<string, unknown>) | undefined;
  /** The model's context window in tokens, when the budget of a question should follow it. */
  contextTokens?: number | undefined;
  /** The largest request body the model or your gateway takes, in bytes. */
  maxRequestBytes?: number | undefined;
  /** Tokens billed for one PDF page. Defaults to 530. */
  pageTokens?: number | undefined;
  /** Names the model in usage totals. Defaults to the model in the URL. */
  id?: string | undefined;
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
  fetch?: typeof fetch | undefined;
};

type Body = {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: Record<string, unknown>;
  tools?: unknown[];
  toolConfig?: unknown;
};

type Chunk = {
  candidates?: Array<{ finishReason?: string; content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: Record<string, unknown>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: unknown };
};

/** The model a Generate Content URL names: ".../models/gemini-3.8-flash:generateContent". */
function modelOf(url: string): string {
  const name = /\/models\/([^/:?]+)/.exec(url)?.[1];
  if (name) return decodeURIComponent(name);
  try {
    return new URL(url).host || "gemini";
  } catch {
    return "gemini";
  }
}

/** A model turn that is known only by its tool calls. */
function callsTurn(calls: ToolCall[]): GeminiContent {
  return { role: "model", parts: calls.map((call) => ({ functionCall: { name: call.name, args: call.args, ...(call.id ? { id: call.id } : {}) } })) };
}

/**
 * A turn of text, without its empty text parts: Vertex AI refuses an empty text parameter (a stored
 * answer that came back empty is one). A native part stays, and a turn with no part left is none.
 */
const textTurn = (message: ModelTextMessage): GeminiContent[] => {
  const parts = message.parts.flatMap((part): GeminiPart[] => (part.native !== undefined ? [part.native as GeminiPart] : part.text ? [{ text: part.text }] : []));
  return parts.length > 0 ? [{ role: message.role === "user" ? "user" : "model", parts }] : [];
};

export type FromGeminiContentsOptions = {
  /**
   * Turn the tool rounds of earlier questions back into stored rounds (`ToolTurn`), as
   * `geminiToolTurns` wrote them: a `model` turn made only of `functionCall` parts that call this
   * library's tools (`TOOL_NAMES`), followed by the `user` turn of their `functionResponse` parts,
   * one for each call, in the same order, with the same names and ids. The loop can then point a
   * repeated call to them, shorten them to make room, and size them as it sizes `toolTurns`. The
   * request is the same. A turn with anything else in it (a function of your own, a thought
   * signature, a file in a response) stays as it is. Defaults to true; false gives the turns of
   * 0.8. New in 0.9.0.
   */
  rounds?: boolean;
};

/** The names of the library's tools. */
const LIBRARY_TOOLS: ReadonlySet<string> = new Set(Object.values(TOOL_NAMES));

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Whether `value` has no keys but those `allowed`. */
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
/** The field `name` of a part that has that field and no other, when it is an object. */
const soleField = (part: GeminiPart | undefined, name: string): Record<string, unknown> | undefined => {
  if (!isPlainObject(part)) return undefined;
  const keys = Object.keys(part);
  return keys.length === 1 && keys[0] === name && isPlainObject(part[name]) ? part[name] : undefined;
};

/**
 * A stored tool round of the library, in the form `geminiToolTurns` gives it: `asked` is a model
 * turn of calls of the library's tools and nothing else, and `answered` the turn of their
 * responses, in the same order. Undefined for anything else.
 */
function liftedRound(asked: GeminiContent, answered: GeminiContent | undefined): ToolTurn | undefined {
  if (asked.role !== "model" || answered?.role !== "user" || !Array.isArray(asked.parts) || !Array.isArray(answered.parts)) return undefined;
  if (asked.parts.length === 0 || answered.parts.length !== asked.parts.length) return undefined;
  const calls: ToolTurn["calls"] = [];
  for (const [index, part] of asked.parts.entries()) {
    const call = soleField(part, "functionCall");
    const response = soleField(answered.parts[index], "functionResponse");
    if (!call || !response || !onlyKeys(call, ["name", "args", "id"]) || !onlyKeys(response, ["name", "id", "response"])) return undefined;
    const { name, args = {}, id } = call;
    if (typeof name !== "string" || !LIBRARY_TOOLS.has(name) || !isPlainObject(args) || (id !== undefined && typeof id !== "string")) return undefined;
    if (response.name !== name || response.id !== id || !isPlainObject(response.response)) return undefined;
    calls.push({ ...(id ? { id } : {}), name, args, result: response.response as ToolResult });
  }
  return { role: "tools", version: TOOL_TURN_VERSION, calls };
}

/**
 * The text a function part is sized by: the JSON of its call or response. Undefined for any other
 * part, and for a response with files in it, which is sized as media.
 */
function sizingText(part: GeminiPart): string | undefined {
  for (const name of ["functionCall", "functionResponse"]) {
    const field = part[name];
    if (!isPlainObject(field)) continue;
    if (Array.isArray(field.parts) && field.parts.length > 0) return undefined;
    return JSON.stringify(field);
  }
  return undefined;
}

/** A part of a turn that is not part of a stored round. */
function partOf(part: GeminiPart): ModelPart {
  if (typeof part.text !== "string") {
    const text = sizingText(part);
    return text === undefined ? { native: part } : { native: part, text };
  }
  return Object.keys(part).length === 1 ? { text: part.text } : { native: part, text: part.text };
}

/**
 * Gemini `contents` as messages of `askWithFiles`: text parts as text, the tool rounds of earlier
 * questions that `geminiToolTurns` gave as stored rounds (see `options.rounds`, since 0.9.0), and
 * every other part (an image, an inline PDF, a function call of your own) as it is. A function
 * part kept as it is is sized by the JSON of its call or response (since 0.9.0; before, as media).
 */
export function fromGeminiContents(contents: GeminiContent[], options: FromGeminiContentsOptions = {}): ChatMessage[] {
  const lift = options.rounds !== false;
  const messages: ChatMessage[] = [];
  for (let at = 0; at < contents.length; at++) {
    const content = contents[at]!;
    const round = lift ? liftedRound(content, contents[at + 1]) : undefined;
    if (round) {
      messages.push(round);
      at++;
      continue;
    }
    const turn: ModelTextMessage = { role: content.role === "user" ? "user" : "assistant", parts: content.parts.map(partOf) };
    messages.push(turn);
  }
  return messages;
}

/**
 * The tool rounds a question returned (`AskResult.toolTurns`) as Gemini `contents`: a model turn
 * of function calls and a user turn of function responses for each. For an application that
 * keeps its history as `contents`: put them between the question and its answer.
 */
export function geminiToolTurns(turns: ToolTurn[]): GeminiContent[] {
  return turns.flatMap((turn) => {
    // Sent again in later questions: without the tool turns this question had left.
    const answers = turn.calls.map(({ result, ...call }) => ({ call, result: laterResult(result) }));
    return [callsTurn(answers.map((answer) => answer.call)), ...geminiFunctionResponseTurns(answers)];
  });
}

/**
 * A Gemini model for `askWithFiles`. `endpoint` says where it is: `geminiApi()`, `vertexAi()`, or
 * your own URLs and headers for a gateway. Its `explorerUrl` is not used here: an explorer is a
 * model of its own, `gemini(geminiApi({ apiKey, model: "the-explorer" }))`.
 */
export function gemini(endpoint: Pick<GeminiEndpoint, "url" | "streamUrl" | "headers">, options: GeminiModelOptions = {}): ModelAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const placement = options.toolFilePlacement ?? "inside";
  // The turns of a tool round are built once: its pages are megabytes of base64.
  const built = new WeakMap<ModelToolRound, GeminiContent[]>();
  const roundTurns = (round: ModelToolRound): GeminiContent[] => {
    let turns = built.get(round);
    if (!turns) {
      // Its own turn goes back unchanged: Gemini 3 requires its thought signatures.
      const asked = round.raw !== undefined ? round.raw as GeminiContent : callsTurn(round.calls);
      turns = [asked, ...(round.answers.length > 0 ? geminiFunctionResponseTurns(round.answers, { files: placement }) : [])];
      built.set(round, turns);
    }
    return turns;
  };
  const toContents = (messages: ModelMessage[]): GeminiContent[] => messages.flatMap((message) => (message.role === "tools" ? roundTurns(message) : textTurn(message)));
  const bodyOf = (request: ModelRequest): Body => ({
    contents: toContents(request.messages),
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    ...(options.generationConfig ? { generationConfig: options.generationConfig } : {}),
    // A request that must be answered in text declares no tools at all: Gemini can ignore
    // functionCallingConfig mode NONE and keep calling them.
    ...(request.tools?.length && request.toolChoice !== "none" ? {
      tools: [{ functionDeclarations: request.tools }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    } : {}),
  });

  return {
    id: options.id ?? modelOf(endpoint.url),
    capabilities: {
      ...(options.contextTokens ? { contextTokens: options.contextTokens } : {}),
      ...(options.maxRequestBytes ? { maxRequestBytes: options.maxRequestBytes } : {}),
      toolFiles: placement,
      pageTokens: options.pageTokens ?? GEMINI_PAGE_TOKENS,
    },
    requestBytes: (request) => Buffer.byteLength(JSON.stringify(bodyOf(request))),
    generateText: createGeminiGenerateText({
      url: endpoint.url,
      headers: endpoint.headers,
      fetchImpl,
      ...(options.analysisConfig ? { generationConfig: options.analysisConfig } : {}),
    }),

    async send(request: ModelRequest, hooks: SendHooks = {}): Promise<ModelReply> {
      const stream = Boolean(hooks.onText && endpoint.streamUrl);
      // Headers are asked for with each request: an access token may have been renewed since the last.
      const headers = await resolveHeaders(endpoint);
      const watch = idleWatch(hooks.signal, { firstByteTimeoutMs: options.firstByteTimeoutMs, idleTimeoutMs: options.idleTimeoutMs });
      // A request the watch aborted got nothing back for the whole wait: that is no failed connection.
      const lost = (error: unknown) => (watch.expired ? silent(watch.waitedMs) : unreachable(error));
      try {
        let response: Response;
        try {
          response = await fetchImpl(stream ? endpoint.streamUrl! : endpoint.url, {
            method: "POST",
            headers,
            body: JSON.stringify(bodyOf(request)),
            signal: watch.signal,
          });
        } catch (error) {
          if (hooks.signal?.aborted) throw error;
          throw lost(error);
        }
        // The headers are no piece of the reply: a server may send them at once and then think.
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw geminiFailure(response.status, data, retryAfterMs(response.headers, data), `Gemini returned HTTP ${response.status}.`);
        }
        return await readReply(response, stream, hooks, watch, lost);
      } finally {
        watch.stop();
      }
    },
  };


  /** The reply of a request that was answered: streamed, or in one piece. */
  async function readReply(response: Response, stream: boolean, hooks: SendHooks, watch: IdleWatch, lost: (error: unknown) => GeminiRequestError): Promise<ModelReply> {
    const parts: GeminiPart[] = [];
    const calls: ToolCall[] = [];
    let text = "";
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    const take = (chunk: Chunk) => {
      if (chunk.error?.message) {
        throw geminiFailure(typeof chunk.error.code === "number" ? chunk.error.code : response.status, chunk, undefined, chunk.error.message);
      }
      if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        // Keep every part unchanged: Gemini 3 requires its thought signatures back.
        parts.push(part);
        if (typeof part.text === "string" && part.text && part.thought !== true) {
          text += part.text;
          hooks.onText?.(part.text);
        }
        const call = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
        if (call && typeof call.name === "string") {
          const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
          calls.push({ name: call.name, args, ...(typeof call.id === "string" ? { id: call.id } : {}) });
        }
      }
      finishReason = candidate?.finishReason ?? finishReason;
      usage = chunk.usageMetadata ?? usage;
    };
    const notTheReply = (error: unknown) => notJson(response, error);
    if (stream) {
      if (!response.body) throw new GeminiRequestError("Gemini returned an empty stream.", response.status);
      let events: boolean;
      let body: Response;
      try {
        ({ events, response: body } = await streamedReply(response, watch));
      } catch (error) {
        if (hooks.signal?.aborted) throw error;
        throw noteCutReply(lost(error));
      }
      if (events) {
        try {
          for await (const chunk of parseSseJson<Chunk>(body.body!, { onData: watch.pulse, signal: watch.signal })) take(chunk);
        } catch (error) {
          if (hooks.signal?.aborted || error instanceof GeminiRequestError) throw error;
          // An event too long to read would come again: it is not sent again, like a page in the reply's place.
          if (error instanceof SseEventTooLongError) throw new GeminiRequestError(eventTooLongMessage("Gemini's", error), response.status, { kind: "invalid", cause: error });
          // The connection went while the answer was on its way, or nothing came for the whole wait.
          throw noteCutReply(lost(error));
        }
        // Every reply Gemini streams ends with a chunk that says why it ended. A stream that closed
        // without one was cut off on its way (a proxy, a dropped connection): it is not a whole
        // reply, and is sent again like a connection that failed, unless text of it was shown.
        if (finishReason === undefined && blockReason === undefined) throw noteCutReply(new GeminiRequestError("Gemini's reply ended before it was complete.", 0));
      } else {
        // In one piece, though it was asked for as a stream: a gateway that does not stream (its
        // chunks in a list, as Gemini sends them without `alt=sse`), or a page in the model's place.
        const data = await readJson<Chunk | Chunk[]>(body, () => Boolean(hooks.signal?.aborted), lost, watch, notTheReply);
        for (const chunk of Array.isArray(data) ? data : [data]) take(chunk);
      }
    } else {
      take(await readJson<Chunk>(response, () => Boolean(hooks.signal?.aborted), lost, watch, notTheReply));
    }
    const finish = finishOfGemini(finishReason);
    return {
      text,
      calls,
      raw: { role: "model", parts } satisfies GeminiContent,
      ...(finishReason ? { finishReason } : {}),
      ...(finish ? { finish } : {}),
      ...(blockReason ? { blockReason } : {}),
      ...(usage ? { usage: usageOfGemini(usage), providerUsage: usage } : {}),
    };
  }
}
