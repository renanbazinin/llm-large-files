// Gemini (Generate Content REST) helpers. No SDK dependency: the caller supplies the URL and
// auth headers, so this works with the Gemini API, Vertex AI, or an enterprise gateway.
import type { ToolAnswer, ToolCall } from "../model.js";
import { completeWithinLimit, noTextReason, type LimitedReply } from "../output-limit.js";
import { readJson } from "../http.js";
import { noteNoRetry, retryAfterMs } from "../retry.js";
import type { GenerateText, GenerateUsage, ToolDeclaration, ToolFile, ToolResult } from "../types.js";
import { finishOfGemini, geminiFailure, notJson, unreachable } from "./errors.js";

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

const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

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
  /** Request headers, or a function returning them. A function is called for every request: a whole-file read can outlast an access token. */
  headers: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  fetchImpl?: typeof fetch;
  /** The `generationConfig` of each request, from its output limit. Defaults to `{ maxOutputTokens }`. */
  generationConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  timeoutMs?: number;
}): GenerateText {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { url } = options;
  return async ({ system, prompt, maxOutputTokens, signal, onTruncated, onUsage }) => {
    /** Set when Gemini blocked the prompt: sent again, it would be blocked again. */
    let blocked = false;
    /** One request with an output limit: the text of the reply, why it ended, and what it thought. */
    const send = async (limit: number): Promise<LimitedReply> => {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
      const headers = typeof options.headers === "function" ? await options.headers() : options.headers;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            systemInstruction: { role: "system", parts: [{ text: system }] },
            // No temperature: Gemini 3.6 and later ignore it, and Google says later models will refuse it.
            generationConfig: options.generationConfig?.(limit) ?? { maxOutputTokens: limit },
          }),
        });
      } catch (error) {
        // Stopped by the caller, or out of time: reported as it is. Anything else is a connection that failed.
        if (signal?.aborted || timeout.aborted) throw error;
        throw unreachable(error);
      }
      type Data = {
        error?: { message?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: boolean }> } }>;
        usageMetadata?: Record<string, unknown>;
        promptFeedback?: { blockReason?: unknown };
      } | null;
      // An error may have no JSON body. A reply must: one whose body could not be read is a
      // connection that failed, and is sent again.
      const data: Data = response.ok
        ? await readJson<Data>(response, () => Boolean(signal?.aborted) || timeout.aborted, unreachable, undefined, (error) => notJson(response, error))
        : await response.json().catch(() => null) as Data;
      if (!response.ok) throw geminiFailure(response.status, data, retryAfterMs(response.headers, data), `The model returned HTTP ${response.status}.`);
      onUsage?.(usageOfGemini(data?.usageMetadata));
      const candidate = data?.candidates?.[0];
      // A prompt Gemini blocked comes with 200, a reason and no candidate: the reply has no text,
      // and says why ("The model returned no text (PROHIBITED_CONTENT).").
      const blockReason = data?.promptFeedback?.blockReason;
      if (!candidate && typeof blockReason === "string" && blockReason) {
        blocked = true;
        return { text: "", cutOff: false, stopped: true, reason: blockReason, thoughts: 0 };
      }
      const text = (candidate?.content?.parts ?? [])
        .filter((part) => part.thought !== true && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      const thoughts = data?.usageMetadata?.thoughtsTokenCount;
      return {
        text,
        cutOff: candidate?.finishReason === "MAX_TOKENS",
        // Stopped by the safety filters before its end: what it wrote is not all there is.
        stopped: finishOfGemini(candidate?.finishReason) === "filtered",
        ...(candidate?.finishReason ? { reason: candidate.finishReason } : {}),
        thoughts: typeof thoughts === "number" ? thoughts : 0,
      };
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
