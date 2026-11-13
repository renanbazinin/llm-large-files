// Gemini (Generate Content REST) helpers. No SDK dependency: the caller supplies the URL and
// auth headers, so this works with the Gemini API, Vertex AI, or an enterprise gateway.
import type { ToolAnswer, ToolCall } from "../model.js";
import { completeWithinLimit, type LimitedReply } from "../output-limit.js";
import { retryAfterMs } from "../retry.js";
import type { GenerateText, GenerateUsage, ToolDeclaration, ToolFile, ToolResult } from "../types.js";
import { GeminiRequestError, unreachable } from "./errors.js";

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

type UserTurn = { role: "user"; parts: unknown[] };

const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** One function response, with `files` inside it. */
function functionResponse(call: GeminiFunctionCall, result: ToolResult, files: ToolFile[]): unknown {
  let response = result;
  const parts: unknown[] = [];
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
  generationConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  timeoutMs?: number;
}): GenerateText {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { url } = options;
  return async ({ system, prompt, maxOutputTokens, signal, onTruncated, onUsage }) => {
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
            generationConfig: options.generationConfig?.(limit) ?? { maxOutputTokens: limit, temperature: 0.2 },
          }),
        });
      } catch (error) {
        // Stopped by the caller, or out of time: reported as it is. Anything else is a connection that failed.
        if (signal?.aborted || timeout.aborted) throw error;
        throw unreachable(error);
      }
      const data = await response.json().catch(() => null) as {
        error?: { message?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: boolean }> } }>;
        usageMetadata?: Record<string, unknown>;
      } | null;
      if (!response.ok) {
        const wait = retryAfterMs(response.headers, data);
        throw new GeminiRequestError(data?.error?.message ?? `The model returned HTTP ${response.status}.`, response.status, wait === undefined ? {} : { retryAfterMs: wait });
      }
      onUsage?.(usageOfGemini(data?.usageMetadata));
      const candidate = data?.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .filter((part) => part.thought !== true && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      const thoughts = data?.usageMetadata?.thoughtsTokenCount;
      return {
        text,
        cutOff: candidate?.finishReason === "MAX_TOKENS",
        ...(candidate?.finishReason ? { reason: candidate.finishReason } : {}),
        thoughts: typeof thoughts === "number" ? thoughts : 0,
      };
    };
    return completeWithinLimit(url, maxOutputTokens, send, { signal, onTruncated });
  };
}
