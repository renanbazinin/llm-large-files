// Gemini (Generate Content REST) as a model of `askWithFiles`.
import type { ChatMessage, ModelAdapter, ModelMessage, ModelReply, ModelRequest, ModelTextMessage, ModelToolRound, SendHooks, ToolCall, ToolTurn } from "../model.js";
import { retryAfterMs } from "../retry.js";
import { idleWatch, readJson, type IdleWatch } from "../http.js";
import { parseSseJson } from "../sse.js";
import { resolveHeaders, type GeminiEndpoint } from "./endpoints.js";
import { finishOfGemini, geminiFailure, GeminiRequestError, silent, unreachable } from "./errors.js";
import { createGeminiGenerateText, geminiFunctionResponseTurns, usageOfGemini, type GeminiToolFilePlacement } from "./generate.js";

export type GeminiPart = Record<string, unknown>;
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

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
  /** generationConfig for whole-document part reads. Defaults to `{ temperature: 0.2, maxOutputTokens }`. */
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

const textTurn = (message: ModelTextMessage): GeminiContent => ({
  role: message.role === "user" ? "user" : "model",
  parts: message.parts.map((part) => (part.native !== undefined ? part.native as GeminiPart : { text: part.text ?? "" })),
});

/**
 * Gemini `contents` as messages of `askWithFiles`: text parts as text, every other part (an image,
 * an inline PDF, a function call of an earlier question) as it is.
 */
export function fromGeminiContents(contents: GeminiContent[]): ChatMessage[] {
  return contents.map((content): ModelTextMessage => ({
    role: content.role === "user" ? "user" : "assistant",
    parts: content.parts.map((part) => {
      if (typeof part.text !== "string") return { native: part };
      return Object.keys(part).length === 1 ? { text: part.text } : { native: part, text: part.text };
    }),
  }));
}

/**
 * The tool rounds a question returned (`AskResult.toolTurns`) as Gemini `contents`: a model turn
 * of function calls and a user turn of function responses for each. For an application that
 * keeps its history as `contents`: put them between the question and its answer.
 */
export function geminiToolTurns(turns: ToolTurn[]): GeminiContent[] {
  return turns.flatMap((turn) => {
    const answers = turn.calls.map(({ result, ...call }) => ({ call, result }));
    return [callsTurn(answers.map((answer) => answer.call)), ...geminiFunctionResponseTurns(answers) as GeminiContent[]];
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
      turns = [asked, ...(round.answers.length > 0 ? geminiFunctionResponseTurns(round.answers, { files: placement }) as GeminiContent[] : [])];
      built.set(round, turns);
    }
    return turns;
  };
  const toContents = (messages: ModelMessage[]): GeminiContent[] => messages.flatMap((message) => (message.role === "tools" ? roundTurns(message) : [textTurn(message)]));
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
    if (stream) {
      if (!response.body) throw new GeminiRequestError("Gemini returned an empty stream.", response.status);
      try {
        for await (const chunk of parseSseJson<Chunk>(response.body, { onData: watch.pulse, signal: watch.signal })) take(chunk);
      } catch (error) {
        if (hooks.signal?.aborted || error instanceof GeminiRequestError) throw error;
        // The connection went while the answer was on its way, or nothing came for the whole wait.
        throw lost(error);
      }
      // Every reply Gemini streams ends with a chunk that says why it ended. A stream that closed
      // without one was cut off on its way (a proxy, a dropped connection): it is not a whole
      // reply, and is sent again like a connection that failed, unless text of it was shown.
      if (finishReason === undefined && blockReason === undefined) throw new GeminiRequestError("Gemini's reply ended before it was complete.", 0);
    } else {
      take(await readJson<Chunk>(response, () => Boolean(hooks.signal?.aborted), lost, watch));
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
