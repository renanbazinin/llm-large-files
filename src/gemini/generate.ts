// Gemini (Generate Content REST) helpers. No SDK dependency: the caller supplies the URL and
// auth headers, so this works with the Gemini API, Vertex AI, or an enterprise gateway.
import type { GenerateText, ToolDeclaration, ToolResult } from "../types.js";

/** Gemini accepts this package's JSON Schema subset as-is. */
export function toGeminiTools(declarations: ToolDeclaration[]): { functionDeclarations: ToolDeclaration[] } {
  return { functionDeclarations: declarations };
}

export type GeminiFunctionCall = { name: string; args: Record<string, unknown>; id?: string };

/** The `user` turn that answers a model turn's function calls, in call order. */
export function geminiFunctionResponses(calls: Array<{ call: GeminiFunctionCall; result: ToolResult }>): { role: "user"; parts: unknown[] } {
  return {
    role: "user",
    parts: calls.map(({ call, result }) => ({
      functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: result },
    })),
  };
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
  return async ({ system, prompt, maxOutputTokens, signal }) => {
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
    return text;
  };
}
