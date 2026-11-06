import type { LargeFiles } from "../library.js";
import { estimateTokens, jsonBytes } from "../text.js";
import { toolResultSummary } from "../tools.js";
import type { DocumentPlan, ToolResult } from "../types.js";
import { resolveHeaders, type GeminiEndpoint } from "./endpoints.js";
import { createGeminiGenerateText, geminiFunctionResponses, type GeminiFunctionCall } from "./generate.js";
import { parseSseJson } from "./sse.js";

export type GeminiPart = Record<string, unknown>;
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
/** A plain chat turn. "assistant" is accepted as an alias for "model". */
export type ChatTurn = { role: "user" | "model" | "assistant"; text: string };

/** Sent (invisibly to the user) when the model must stop using tools and answer. */
export const FINAL_ANSWER_REQUEST = "Stop using tools now. Answer my question using only what the tools returned above, with line citations. Say plainly what you could not find.";

/** Some document IDs were never uploaded, have expired, or belong to another owner. */
export class DocumentsNotFoundError extends Error {
  constructor(readonly ids: string[]) {
    super(`${ids.length === 1 ? "A document is" : `${ids.length} documents are`} no longer available: ${ids.join(", ")}. Upload ${ids.length === 1 ? "it" : "them"} again.`);
    this.name = "DocumentsNotFoundError";
  }
}

/** Gemini answered with an HTTP error. */
export class GeminiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

export type AskGeminiOptions = {
  files: LargeFiles;
  endpoint: GeminiEndpoint;
  /** Documents this conversation may use. Their text or cards are added to the last user turn. */
  documentIds: string[];
  /** Plain chat history; the last turn must be the user's question. Use this or `contents`. */
  messages?: ChatTurn[];
  /** Your own Gemini `contents` (with images, inline PDFs, etc.). The last turn must be the user's. */
  contents?: GeminiContent[];
  system?: string;
  /** Sent with every chat request: temperature, maxOutputTokens, thinkingConfig, and so on. */
  generationConfig?: Record<string, unknown>;
  /** The user asking. Documents ingested with a different owner are treated as missing. */
  owner?: string;
  /** Model turns that may call tools before a final, tool-free turn. Defaults to 12. */
  maxToolTurns?: number;
  /** Offer `analyze_whole_document`, which reads a whole file in many model calls. Defaults to true. */
  wholeDocumentAnalysis?: boolean;
  /** generationConfig for whole-document part reads. Defaults to `{ temperature: 0.2, maxOutputTokens }`. */
  analysisConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  /** Answer text as it streams. Streaming is used when this is set and the endpoint has `streamUrl`. */
  onText?: (delta: string) => void;
  /** Short-lived status, such as "Searching app.log for “timeout”…". */
  onActivity?: (text: string) => void;
  /** A finished step, such as "Search app.log (exact) for “timeout” — 12 matching lines". */
  onStep?: (text: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

export type AskGeminiResult = {
  text: string;
  /** Every tool step taken, in order (also delivered through `onStep`). */
  steps: string[];
  /** Which documents went in whole and which were searched. */
  plan: DocumentPlan;
  /** Model requests made for the chat itself (whole-document part reads not included). */
  turns: number;
  finishReason?: string;
  /** Usage metadata of the last model response. */
  usage?: Record<string, unknown>;
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
  error?: { message?: string };
};

function toContents(options: AskGeminiOptions): GeminiContent[] {
  const contents: GeminiContent[] = options.contents
    ? options.contents.map((content) => ({ role: content.role, parts: [...content.parts] }))
    : (options.messages ?? []).map((turn) => ({ role: turn.role === "user" ? "user" : "model", parts: [{ text: turn.text }] }));
  if (contents.at(-1)?.role !== "user") throw new Error("The last message must be the user's.");
  return contents;
}

function baseSize(contents: GeminiContent[], system: string | undefined): { tokens: number; bytes: number } {
  let tokens = estimateTokens(system ?? "") + 2_000;
  let bytes = jsonBytes(system ?? "") + 8_000;
  for (const content of contents) {
    for (const part of content.parts) {
      if (typeof part.text === "string") {
        tokens += estimateTokens(part.text);
        bytes += jsonBytes(part.text);
      } else {
        const size = JSON.stringify(part).length;
        bytes += size;
        // Media: Gemini bills about 258 tokens per image or PDF page; ~4 tokens/KB is a cautious stand-in.
        tokens += Math.ceil(size / 256);
      }
    }
  }
  return { tokens, bytes };
}

/**
 * Answers a chat turn about large documents with Gemini (Generate Content REST).
 * Documents that fit go into the prompt whole; otherwise Gemini gets search/read tools and this
 * runs the tool loop, ending with a tool-free turn so there is always an answer.
 */
export async function askGemini(options: AskGeminiOptions): Promise<AskGeminiResult> {
  const fetchImpl = options.fetch ?? fetch;
  const { files, endpoint, signal } = options;
  const contents = toContents(options);
  const prepared = await files.prepare(options.documentIds, baseSize(contents, options.system), { owner: options.owner });
  if (prepared.missing.length) throw new DocumentsNotFoundError(prepared.missing);

  const blocks = [...new Set(options.documentIds)].map((id) => prepared.blocks.get(id)).filter((block): block is string => Boolean(block));
  if (blocks.length) contents.at(-1)!.parts.push({ text: blocks.join("\n\n") });
  const system = [options.system?.trim(), prepared.instruction].filter(Boolean).join("\n\n");
  const body: Body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(options.generationConfig ? { generationConfig: options.generationConfig } : {}),
  };
  const headers = await resolveHeaders(endpoint);
  const streaming = Boolean(options.onText && endpoint.streamUrl);

  let text = "";
  let turns = 0;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const steps: string[] = [];
  const emit = (delta: string) => {
    text += delta;
    options.onText?.(delta);
  };

  /** One model request. Text is emitted as it arrives; parts are kept as received. */
  const turn = async (): Promise<{ parts: GeminiPart[]; calls: GeminiFunctionCall[] }> => {
    turns++;
    const response = await fetchImpl(streaming ? endpoint.streamUrl! : endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new GeminiRequestError(data?.error?.message ?? `Gemini returned HTTP ${response.status}.`, response.status);
    }
    const parts: GeminiPart[] = [];
    const calls: GeminiFunctionCall[] = [];
    let separated = text.length === 0;
    const take = (chunk: Chunk) => {
      if (chunk.error?.message) throw new GeminiRequestError(chunk.error.message, response.status);
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        // Keep every part unchanged: Gemini 3 requires its thought signatures back.
        parts.push(part);
        if (typeof part.text === "string" && part.text && part.thought !== true) {
          if (!separated) {
            emit("\n\n");
            separated = true;
          }
          emit(part.text);
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
    if (streaming) {
      if (!response.body) throw new GeminiRequestError("Gemini returned an empty stream.", response.status);
      for await (const chunk of parseSseJson<Chunk>(response.body)) take(chunk);
    } else {
      take(await response.json() as Chunk);
    }
    return { parts, calls };
  };

  const result = (): AskGeminiResult => ({
    text,
    steps,
    plan: prepared.plan,
    turns,
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  });

  if (prepared.plan.searchable.length === 0) {
    await turn();
    return result();
  }

  const tools = files.tools(prepared.plan.searchable, {
    ...(options.wholeDocumentAnalysis === false ? {} : {
      generate: createGeminiGenerateText({ url: endpoint.url, headers, fetchImpl, ...(options.analysisConfig ? { generationConfig: options.analysisConfig } : {}) }),
    }),
    onProgress: (event) => options.onActivity?.(`${event.message}…`),
    ...(signal ? { signal } : {}),
  });
  body.tools = [{ functionDeclarations: tools.declarations }];
  body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  options.onActivity?.(`Too large to read at once: ${prepared.plan.searchable.map((meta) => meta.name).join(", ")}. Searching instead…`);

  const maxTurns = Math.max(1, options.maxToolTurns ?? 12);
  let unanswered = false;
  for (let round = 1; round <= maxTurns; round++) {
    const { parts, calls } = await turn();
    if (calls.length === 0) break;
    if (round === maxTurns) {
      unanswered = true;
      break;
    }
    body.contents.push({ role: "model", parts });
    const answered: Array<{ call: GeminiFunctionCall; result: ToolResult }> = [];
    for (const call of calls) {
      const label = tools.has(call.name) ? tools.describe(call.name, call.args) : call.name;
      options.onActivity?.(`${label}…`);
      const output = await tools.execute(call.name, call.args);
      const step = `${label}${toolResultSummary(label, output)}`;
      steps.push(step);
      options.onStep?.(step);
      answered.push({ call, result: { ...output, tool_turns_left: maxTurns - round - 1 } });
    }
    body.contents.push(geminiFunctionResponses(answered) as GeminiContent);
  }

  // Out of turns, or no answer yet: ask once more with no tools declared at all.
  // (Gemini can ignore functionCallingConfig mode NONE and keep calling tools.)
  if (unanswered || !text) {
    options.onActivity?.("Writing the answer…");
    delete body.tools;
    delete body.toolConfig;
    body.contents.push({ role: "user", parts: [{ text: FINAL_ANSWER_REQUEST }] });
    await turn();
  }
  return result();
}
