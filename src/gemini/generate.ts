// Gemini (Generate Content REST) helpers. No SDK dependency: the caller supplies the URL and
// auth headers, so this works with the Gemini API, Vertex AI, or an enterprise gateway.
import type { GenerateText, ToolDeclaration, ToolFile, ToolResult } from "../types.js";

/** Gemini accepts this package's JSON Schema subset as-is. */
export function toGeminiTools(declarations: ToolDeclaration[]): { functionDeclarations: ToolDeclaration[] } {
  return { functionDeclarations: declarations };
}

export type GeminiFunctionCall = { name: string; args: Record<string, unknown>; id?: string };

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
export type GeminiToolAnswer = { call: GeminiFunctionCall; result: ToolResult; files?: ToolFile[] };

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

/**
 * A model that thinks counts its thoughts in `maxOutputTokens`. Asked for 4,096 tokens of notes on
 * a part of a log, Gemini 3.8 Flash spent 3,931 of them thinking and wrote two lines, and Gemini 4
 * wrote nothing at all (November 2026). A reply that was cut off that way is asked for again with
 * this limit, the least Google recommends for a Gemini 4 model.
 */
export const THINKING_OUTPUT_TOKENS = 32_768;

/**
 * What has been learned about the model behind a URL, so that a whole-file read does not pay for
 * the wasted request with every part: the output limit it needs, or 0 when it refused that limit.
 */
const learnedLimits = new Map<string, number>();
/** The first request to a URL that is still on its way. Others wait for what it learns. */
const firstRequests = new Map<string, Promise<void>>();
/** URLs that have answered at least once. */
const answered = new Set<string>();
const MOST_REMEMBERED = 200;

function remember(url: string, limit: number): void {
  if (learnedLimits.size >= MOST_REMEMBERED && !learnedLimits.has(url)) learnedLimits.clear();
  learnedLimits.set(url, limit);
}

/**
 * A `GenerateText` backed by a non-streaming `:generateContent` endpoint.
 * `generationConfig` lets the caller apply model-specific rules (thinking level, output floors).
 *
 * When a reply stops at the output limit with most of that limit spent on thoughts, the request
 * is sent once more with `THINKING_OUTPUT_TOKENS`, and later requests to the same URL start there.
 */
export function createGeminiGenerateText(options: {
  url: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  generationConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  timeoutMs?: number;
}): GenerateText {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { url } = options;
  return async ({ system, prompt, maxOutputTokens, signal, onTruncated }) => {
    /** One request with an output limit: the text of the reply, why it ended, and what it thought. */
    const send = async (limit: number): Promise<{ text: string; finishReason?: string; thoughts: number }> => {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: options.headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: { role: "system", parts: [{ text: system }] },
          generationConfig: options.generationConfig?.(limit) ?? { maxOutputTokens: limit, temperature: 0.2 },
        }),
      });
      const data = await response.json().catch(() => null) as {
        error?: { message?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: boolean }> } }>;
        usageMetadata?: { thoughtsTokenCount?: unknown };
      } | null;
      if (!response.ok) throw Object.assign(new Error(data?.error?.message ?? `The model returned HTTP ${response.status}.`), { status: response.status });
      const candidate = data?.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .filter((part) => part.thought !== true && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      const thoughts = data?.usageMetadata?.thoughtsTokenCount;
      return {
        text,
        ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
        thoughts: typeof thoughts === "number" ? thoughts : 0,
      };
    };

    // The first request to a model finds out whether it thinks its limit away. The parts of a
    // whole-file read are sent four at a time: the others wait for it, and one request is wasted
    // on such a model, not four.
    let learned = () => undefined as void;
    if (!answered.has(url)) {
      const first = firstRequests.get(url);
      if (first) {
        await first;
        signal?.throwIfAborted();
      } else {
        firstRequests.set(url, new Promise<void>((resolve) => {
          learned = () => {
            if (answered.size >= MOST_REMEMBERED) answered.clear();
            answered.add(url);
            firstRequests.delete(url);
            resolve();
          };
        }));
      }
    }
    try {
      const known = learnedLimits.get(url);
      const limit = Math.max(maxOutputTokens, known ?? 0);
      let reply = await send(limit);
      // Cut off, with nothing written or with at least half of the limit gone on thoughts: the
      // limit was too low for this model, not the notes too long.
      const starved = reply.finishReason === "MAX_TOKENS" && (!reply.text.trim() || reply.thoughts >= limit / 2);
      if (starved && known !== 0 && limit < THINKING_OUTPUT_TOKENS) {
        remember(url, THINKING_OUTPUT_TOKENS);
        try {
          reply = await send(THINKING_OUTPUT_TOKENS);
        } catch (error) {
          if (signal?.aborted) throw error;
          // A model or a gateway that refuses the larger limit (HTTP 400) is not asked for it again.
          // Any other failure says nothing about the limit: the next request starts with it. What
          // the first reply had is kept; with nothing in it, this error is the one to report.
          if ((error as { status?: unknown } | null)?.status === 400) remember(url, 0);
          if (!reply.text.trim()) throw error;
        }
      }
      if (!reply.text.trim()) throw new Error(`The model returned no text${reply.finishReason ? ` (${reply.finishReason})` : ""}.`);
      // The text stops mid-list when the output limit is reached. Say so instead of passing it off as complete.
      if (reply.finishReason === "MAX_TOKENS") onTruncated?.();
      return reply.text;
    } finally {
      learned();
    }
  };
}
