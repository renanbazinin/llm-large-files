// Gemini (Generate Content REST) helpers. No SDK dependency: the caller supplies the URL and
// auth headers, so this works with the Gemini API, Vertex AI, or an enterprise gateway.
import type { ToolAnswer, ToolCall } from "../model.js";
import { completeWithinLimit, noTextReason, type LimitedReply } from "../output-limit.js";
import { base64, partTimer, readJson, resolveHeaderSource, type HeaderSource } from "../http.js";
import { noteNoRetry, retryAfterMs } from "../retry.js";
import type { GenerateText, GenerateUsage, ToolDeclaration, ToolFile, ToolResult } from "../types.js";
import { errorBodyOf, finishOfGemini, geminiFailure, notJson, statusOfError, tooSlow, unreachable } from "./errors.js";

/**
 * More fields for the body of a Gemini request (`gemini({ body, analysisBody })`): `safetySettings`,
 * `labels` (Vertex AI), `serviceTier`, `cachedContent` for an explicit cache, or any other field the
 * API takes. They are merged last, after the library's. The fields the library writes itself are
 * typed `never`: set `generationConfig` and `analysisConfig` for those. Nothing is refused at run
 * time. New in 0.10.0.
 */
export type GeminiRequestFields = {
  /** Safety settings, as the API takes them: `{ category, threshold, method? }`. */
  safetySettings?: Array<{ category: string; threshold: string; method?: string }>;
  /**
   * Vertex AI only: labels for the billing export, keys and values in lower case, each at most 63
   * characters. They reach every reader of the billing data: never put a user ID or other personal
   * data in them.
   */
  labels?: Record<string, string>;
  serviceTier?: string;
  /** The name of an explicit context cache (`cachedContents/…`). */
  cachedContent?: string;
  contents?: never;
  systemInstruction?: never;
  tools?: never;
  toolConfig?: never;
  generationConfig?: never;
  [key: string]: unknown;
};

/** Gemini accepts this package's JSON Schema subset as-is. */
export function toGeminiTools(declarations: ToolDeclaration[]): { functionDeclarations: ToolDeclaration[] } {
  return { functionDeclarations: declarations };
}

export type GeminiFunctionCall = ToolCall;

/**
 * Where a file that a tool returned goes in the request:
 * - "inside": in the `parts` of its function response, which names it with `{ "$ref": name }`
 *   (Gemini 3 multimodal function responses). Gemini 2.5 accepts that form and does not see the
 *   file.
 * - "beside": in a `user` turn of its own, after the turn of function responses, for a model that
 *   does not read a file inside a function response.
 */
export type GeminiToolFilePlacement = "inside" | "beside";

/** A function call of the model with what the tool returned for it. */
export type GeminiToolAnswer = ToolAnswer;

/** Gemini's `usageMetadata` in the terms every adapter reports: thoughts are output, cached tokens are input. */
export function usageOfGemini(usage: Record<string, unknown> | undefined): GenerateUsage {
  const number = (key: string) => (typeof usage?.[key] === "number" ? usage[key] as number : 0);
  return {
    inputTokens: number("promptTokenCount") + number("toolUsePromptTokenCount"),
    cachedInputTokens: number("cachedContentTokenCount"),
    outputTokens: number("candidatesTokenCount") + number("thoughtsTokenCount"),
    thoughtTokens: number("thoughtsTokenCount"),
  };
}

/** One part of a Gemini turn, as the REST API takes it: `{ text }`, `{ functionCall }`, `{ inlineData }`… */
export type GeminiPart = Record<string, unknown>;
/** One turn of Gemini's `contents`. */
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/** A `user` turn: a `GeminiContent` that can go in `contents` as it is. */
type UserTurn = GeminiContent & { role: "user" };

/** One function response, with `files` inside it. */
function functionResponse(call: GeminiFunctionCall, result: ToolResult, files: ToolFile[]): GeminiPart {
  let response = result;
  const parts: GeminiPart[] = [];
  if (files.length > 0) {
    // The result names its file ("file": "pages-2-3.pdf"); that becomes the reference Gemini resolves.
    response = { ...result };
    const unnamed: Array<{ $ref: string }> = [];
    for (const file of files) {
      const named = Object.keys(response).find((key) => response[key] === file.name);
      if (named) response[named] = { $ref: file.name };
      else unnamed.push({ $ref: file.name });
      parts.push({ inlineData: { mimeType: file.mimeType, displayName: file.name, data: base64(file.bytes) } });
    }
    if (unnamed.length > 0) response.files = unnamed;
  }
  return { functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response, ...(parts.length > 0 ? { parts } : {}) } };
}

/**
 * The `user` turn that answers a model turn's function calls, in call order. A file that a tool
 * returned (`executeWithFiles`) goes inside its function response, as base64 `inlineData`. To send
 * files beside the function responses instead, use `geminiFunctionResponseTurns`.
 */
export function geminiFunctionResponses(calls: GeminiToolAnswer[]): UserTurn {
  return { role: "user", parts: calls.map(({ call, result, files = [] }) => functionResponse(call, result, files)) };
}

/**
 * The turns that answer a model turn's function calls: add them all to `contents`, in order.
 * With files "inside" (the default) that is the one turn of `geminiFunctionResponses`. With files
 * "beside", the function responses carry no file and a second `user` turn holds the files, each
 * after a line that names it and the tool it came from.
 *
 * The files get a turn of their own because Vertex AI refuses a turn in which anything follows a
 * function response (HTTP 400 for Gemini 3 models, November 2026).
 */
export function geminiFunctionResponseTurns(calls: GeminiToolAnswer[], options: { files?: GeminiToolFilePlacement } = {}): UserTurn[] {
  if (options.files !== "beside") return [geminiFunctionResponses(calls)];
  const responses = calls.map(({ call, result }) => functionResponse(call, result, []));
  const files = calls.flatMap(({ call, files: returned = [] }) => returned.flatMap((file) => [
    { text: `${file.name} (returned by ${call.name}):` },
    { inlineData: { mimeType: file.mimeType, data: base64(file.bytes) } },
  ]));
  return [{ role: "user", parts: responses }, ...(files.length > 0 ? [{ role: "user" as const, parts: files }] : [])];
}

export { THINKING_OUTPUT_TOKENS } from "../output-limit.js";

/**
 * A `GenerateText` backed by a non-streaming `:generateContent` endpoint.
 * `generationConfig` lets the caller apply model-specific rules (thinking level, output floors).
 *
 * When a reply stops at the output limit with most of that limit spent on thoughts, the request
 * is sent once more with `THINKING_OUTPUT_TOKENS`, and later requests to the same URL start there.
 */
export function createGeminiGenerateText(options: {
  url: string;
  /**
   * Request headers, or a function returning them. A function is called for every request: a
   * whole-file read can outlast an access token.
   */
  headers: HeaderSource;
  fetchImpl?: typeof fetch;
  /** The `generationConfig` of each request, from its output limit. Defaults to `{ maxOutputTokens }`. */
  generationConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  /**
   * More fields for the body of each request, given its output limit, merged last
   * (`gemini({ analysisBody })`). New in 0.10.0.
   */
  body?: (maxOutputTokens: number) => GeminiRequestFields;
  /**
   * The longest time, in milliseconds, a request may take, its whole reply included. Defaults to
   * 180,000; 0 sets none. A request past it is a `GeminiRequestError` of kind "timeout" and status
   * 0 (since 0.10.0; before, the abort of the timer), which a whole-file read sends again once.
   */
  timeoutMs?: number;
  /**
   * A request refused with HTTP 401 is sent once more, with the headers of `headers({ refresh: true })`
   * (the endpoint's `refreshable`). New in 0.10.0.
   */
  refreshable?: boolean | undefined;
}): GenerateText {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { url } = options;
  return async ({ system, prompt, maxOutputTokens, signal, onTruncated, onUsage }) => {
    /** Set when Gemini blocked the prompt: sent again, it would be blocked again. */
    let blocked = false;
    /** One request with an output limit: the text of the reply, why it ended, and what it thought. */
    const send = async (limit: number): Promise<LimitedReply> => {
      const timer = partTimer(signal, options.timeoutMs);
      // Stopped by the caller: reported as it is. Out of time: a timeout. Anything else is a connection that failed.
      const lost = (error: unknown) => (timer.expired && !signal?.aborted ? tooSlow(timer.limitMs) : unreachable(error));
      try {
        const body = JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: { role: "system", parts: [{ text: system }] },
          // No temperature: Gemini 3.6 and later ignore it, and Google says later models will refuse it.
          generationConfig: options.generationConfig?.(limit) ?? { maxOutputTokens: limit },
          ...options.body?.(limit),
        });
        const post = async (refresh: boolean): Promise<Response> => {
          const headers = await resolveHeaderSource(options.headers, refresh ? { refresh: true } : undefined);
          try {
            return await fetchImpl(url, { method: "POST", headers, ...(timer.signal ? { signal: timer.signal } : {}), body });
          } catch (error) {
            if (signal?.aborted) throw error;
            throw lost(error);
          }
        };
        let response = await post(false);
        // A token that was refused may be one a cache kept past its time: one more try, with a new one.
        if (response.status === 401 && options.refreshable) {
          discard(response);
          response = await post(true);
        }
        type Chunk = {
          error?: { message?: string; code?: unknown; status?: unknown };
          candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: boolean }> } }>;
          usageMetadata?: Record<string, unknown>;
          promptFeedback?: { blockReason?: unknown };
        };
        // An error may have no JSON body, and one that is a list is read by its first entry.
        if (!response.ok) {
          const data = errorBodyOf(await response.json().catch(() => null));
          throw geminiFailure(response.status, data, retryAfterMs(response.headers, data), `The model returned HTTP ${response.status}.`);
        }
        // A reply must have one: a body that could not be read is a connection that failed, and is
        // sent again. It may be a list of chunks, as Gemini gives a reply without `alt=sse` (a
        // gateway): every chunk is read, as a chat reply's are.
        const data = await readJson<unknown>(response, () => Boolean(signal?.aborted), lost, timer.signal ? { pulse: () => undefined, signal: timer.signal } : undefined, (error) => notJson(response, error));
        const chunks = (Array.isArray(data) ? data : [data]).filter((chunk): chunk is Chunk => chunk !== null && typeof chunk === "object" && !Array.isArray(chunk));
        let text = "";
        let answered = false;
        let finishReason: string | undefined;
        let usage: Record<string, unknown> | undefined;
        let blockReason: unknown;
        for (const chunk of chunks) {
          // An error in a body of HTTP 200 (a gateway, or Vertex AI), alone or after part of the
          // reply: thrown with its own status, so that a 503 is sent again rather than read as a
          // reply with no text, or with part of its text.
          if (chunk.error && typeof chunk.error === "object") throw geminiFailure(statusOfError(chunk.error), chunk, retryAfterMs(response.headers, chunk), "Gemini reported an error.");
          usage = chunk.usageMetadata ?? usage;
          blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;
          answered = true;
          text += (candidate.content?.parts ?? [])
            .filter((part) => part.thought !== true && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("");
          finishReason = candidate.finishReason ?? finishReason;
        }
        onUsage?.(usageOfGemini(usage));
        // A prompt Gemini blocked comes with 200, a reason and no candidate: the reply has no text,
        // and says why ("The model returned no text (PROHIBITED_CONTENT).").
        if (!answered && typeof blockReason === "string" && blockReason) {
          blocked = true;
          return { text: "", cutOff: false, stopped: true, reason: blockReason, thoughts: 0 };
        }
        const thoughts = usage?.thoughtsTokenCount;
        const finish = finishOfGemini(finishReason);
        return {
          text,
          cutOff: finishReason === "MAX_TOKENS",
          // Stopped before its end by a filter, or for another reason that is not the limit: what
          // it wrote is not all there is.
          stopped: finish === "filtered" || finish === "other",
          ...(finishReason ? { reason: finishReason } : {}),
          thoughts: typeof thoughts === "number" ? thoughts : 0,
        };
      } finally {
        timer.stop();
      }
    };
    try {
      return await completeWithinLimit(url, maxOutputTokens, send, { signal, onTruncated });
    } catch (error) {
      // A blocked prompt is not worth sending again: `withRetry` does not.
      if (blocked && noTextReason(error) !== undefined) noteNoRetry(error as object);
      throw error;
    }
  };
}

/** A response that is not read: its body is let go, without waiting for it. */
export function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A body that is locked, or a cancel that throws at once, holds nothing up.
  }
}
