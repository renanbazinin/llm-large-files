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
 *   (Gemini 3 multimodal function responses);
 * - "beside": as a part of the same user turn, after all function responses, for an endpoint that
 *   refuses the first form.
 */
export type GeminiToolFilePlacement = "inside" | "beside";

/**
 * The `user` turn that answers a model turn's function calls, in call order. Files that a tool
 * returned (`executeWithFiles`) are sent as base64 `inlineData`.
 */
export function geminiFunctionResponses(
  calls: Array<{ call: GeminiFunctionCall; result: ToolResult; files?: ToolFile[] }>,
  options: { files?: GeminiToolFilePlacement } = {},
): { role: "user"; parts: unknown[] } {
  const inside = options.files !== "beside";
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  const responses: unknown[] = [];
  const beside: unknown[] = [];
  for (const { call, result, files = [] } of calls) {
    let response = result;
    const parts: unknown[] = [];
    if (inside && files.length > 0) {
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
    } else {
      for (const file of files) {
        beside.push({ text: `${file.name} (returned by ${call.name}):` }, { inlineData: { mimeType: file.mimeType, data: base64(file.bytes) } });
      }
    }
    responses.push({
      functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response, ...(parts.length > 0 ? { parts } : {}) },
    });
  }
  return { role: "user", parts: [...responses, ...beside] };
}

/**
 * A `GenerateText` backed by a non-streaming `:generateContent` endpoint.
 * `generationConfig` lets the caller apply model-specific rules (thinking level, output floors).
 */
export function createGeminiGenerateText(options: {
  url: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  generationConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  timeoutMs?: number;
}): GenerateText {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async ({ system, prompt, maxOutputTokens, signal, onTruncated }) => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: options.headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction: { role: "system", parts: [{ text: system }] },
        generationConfig: options.generationConfig?.(maxOutputTokens) ?? { maxOutputTokens, temperature: 0.2 },
      }),
    });
    const data = await response.json().catch(() => null) as {
      error?: { message?: string };
      candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: boolean }> } }>;
    } | null;
    if (!response.ok) throw new Error(data?.error?.message ?? `The model returned HTTP ${response.status}.`);
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    if (!text.trim()) throw new Error(`The model returned no text${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`);
    // The text stops mid-list when the output limit is reached. Say so instead of passing it off as complete.
    if (candidate?.finishReason === "MAX_TOKENS") onTruncated?.();
    return text;
  };
}
