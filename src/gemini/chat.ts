import type { LargeFiles } from "../library.js";
import { REQUEST_BYTES_MARGIN } from "../plan.js";
import { estimateTokens, jsonBytes } from "../text.js";
import { TOOL_NAMES, toolResultSummary } from "../tools.js";
import type { DocumentPlan, ToolFile, ToolFileLimits, ToolResult } from "../types.js";
import { resolveHeaders, type GeminiEndpoint } from "./endpoints.js";
import { createGeminiGenerateText, geminiFunctionResponseTurns, type GeminiFunctionCall, type GeminiToolFilePlacement } from "./generate.js";
import { parseSseJson } from "./sse.js";

export type GeminiPart = Record<string, unknown>;
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
/** A plain chat turn. "assistant" is accepted as an alias for "model". */
export type ChatTurn = { role: "user" | "model" | "assistant"; text: string };

/** Sent (invisibly to the user) when the model must stop using tools and answer. */
export const FINAL_ANSWER_REQUEST = "Stop using tools now. Answer my question using only what the tools returned above, with line citations. Say plainly what you could not find.";
/** The same, when the only tool was `view_pages`: the text of the files is in the prompt, not in tool results. */
export const FINAL_ANSWER_AFTER_PAGES = "Stop using tools now. Answer my question from the text of the files and the pages you looked at. Say plainly what you could not see or find.";
/** Sent to the answering model when an explorer model used no tool, so there is no tool result to answer from. */
export const FINAL_ANSWER_WITHOUT_TOOLS = "Answer my question now, from what is in this conversation. No tools are available for this reply: if the answer needs a part of a file that is not shown here, say so plainly.";
/**
 * Added to the system instruction of an explorer model's requests: it gathers what the answer
 * needs, and the other model writes the answer.
 */
export const EXPLORER_INSTRUCTION = "You only gather material in this conversation: another model writes the answer. It sees this conversation and what your tool calls returned, not what you thought or wrote. So call the tools until their results hold everything the answer needs from the files. Then, or at once if no tool is needed, reply with the single word DONE instead of an answer.";

/** What Gemini bills for one PDF page it is shown (measured: 520 to 532). */
const PAGE_TOKENS = 530;

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
  /**
   * Where the model is: the one that answers. When the endpoint also names an explorer model
   * (`explorerModel` in `geminiApi()` and `vertexAi()`, or `explorerUrl`), that model makes the
   * tool calls and reads a whole file in parts, and this one writes the answer from what the
   * tools returned. Without an explorer, one model does both.
   */
  endpoint: GeminiEndpoint;
  /** Documents this conversation may use. Where their text or cards go: see `documentPlacement`. */
  documentIds: string[];
  /**
   * Where document text and cards are added. "first" (the default) puts them at the start of the
   * first user turn, where they stay as the conversation grows, so Gemini's prompt cache can
   * reuse them on every follow-up question. "last" appends them to the latest user turn, as 0.1.0
   * did; the document then moves on every turn and is billed in full each time.
   */
  documentPlacement?: "first" | "last";
  /** Plain chat history; the last turn must be the user's question. Use this or `contents`. */
  messages?: ChatTurn[];
  /** Your own Gemini `contents` (with images, inline PDFs, etc.). The last turn must be the user's. */
  contents?: GeminiContent[];
  system?: string;
  /** Sent with every chat request: temperature, maxOutputTokens, thinkingConfig, and so on. */
  generationConfig?: Record<string, unknown>;
  /**
   * The same, for the requests of an explorer model. Defaults to `generationConfig`. Set it when
   * the two models do not take the same settings: a thinking level that one of them refuses, for
   * example. It is not used without an explorer model.
   */
  explorerGenerationConfig?: Record<string, unknown>;
  /** The user asking. Documents ingested with a different owner are treated as missing. */
  owner?: string;
  /**
   * The most model requests for one question, counting the answer. Tools can run in all but the
   * last: if the model is still calling tools then, the last request is sent with no tools so it
   * must answer. Defaults to 12. With an explorer model the answer is always a request of its
   * own, the last one, so the explorer has one less than this.
   */
  maxToolTurns?: number;
  /**
   * The most tool calls of one model turn that are run. A turn with more gets an error for each
   * of the others, which tells the model to send it again if it is still needed. Defaults to 8.
   */
  maxToolCallsPerTurn?: number;
  /** Offer `analyze_whole_document`, which reads a whole file in many model calls. Defaults to true. */
  wholeDocumentAnalysis?: boolean;
  /**
   * Offer `view_pages` for PDFs whose original file is kept (`keepOriginals`), so the model can
   * look at pictures, charts and layout. Defaults to true. It changes nothing for a library that
   * keeps no originals.
   */
  viewPages?: boolean;
  /**
   * Where the pages go in the request. "inside" (the default) puts the PDF in the function
   * response itself, which Gemini 3 models read. "beside" sends it in a user turn of its own,
   * after the function responses: use it for Gemini 2.5, which does not see a file inside a
   * function response.
   */
  toolFilePlacement?: GeminiToolFilePlacement;
  /**
   * generationConfig for whole-document part reads. Defaults to `{ temperature: 0.2, maxOutputTokens }`.
   * The parts are read by the explorer model when there is one, so write it for that model.
   */
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
  /**
   * Everything the model wrote, including any remark it made before calling a tool. With an
   * explorer model, only what the answering model wrote: the explorer's words are not shown.
   */
  text: string;
  /**
   * False when the model's last turn had no text: the prompt was blocked, the reply was cut off
   * before any text, or the model produced a malformed tool call. `text` may then be empty or
   * hold only an earlier remark, so show your own message instead of treating it as the answer.
   */
  answered: boolean;
  /** Why Gemini refused the prompt (`promptFeedback.blockReason`), when it did. */
  blockReason?: string;
  /** Every tool step taken, in order (also delivered through `onStep`). */
  steps: string[];
  /** Which documents went in whole and which were searched. */
  plan: DocumentPlan;
  /** Model requests made for the chat itself, an explorer model's among them (whole-document part reads not included). */
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
  promptFeedback?: { blockReason?: string };
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
 * A turn of an explorer model as the answering model gets it: the tool calls alone. A thought
 * signature belongs to the model that wrote it, and the explorer's thoughts and remarks are not
 * what the files say.
 */
function callsOnly(content: GeminiContent): GeminiContent {
  if (content.role !== "model") return content;
  return { role: "model", parts: content.parts.flatMap((part) => (part.functionCall ? [{ functionCall: part.functionCall }] : [])) };
}

/**
 * Answers a chat turn about large documents with Gemini (Generate Content REST).
 * Documents that fit go into the prompt whole; otherwise Gemini gets search/read tools and this
 * runs the tool loop, ending with a tool-free turn so there is always an answer.
 * When the endpoint names an explorer model, that model runs the tool loop and the endpoint's own
 * model writes the answer, in the tool-free turn.
 */
export async function askGemini(options: AskGeminiOptions): Promise<AskGeminiResult> {
  const fetchImpl = options.fetch ?? fetch;
  const { files, endpoint, signal } = options;
  // A second model for the requests that use tools. The answering model's own URL is not one.
  const explorerUrl = endpoint.explorerUrl && endpoint.explorerUrl !== endpoint.url ? endpoint.explorerUrl : undefined;
  const contents = toContents(options);
  const prepared = await files.prepare(options.documentIds, baseSize(contents, options.system), { owner: options.owner, viewPages: options.viewPages !== false });
  if (prepared.missing.length) throw new DocumentsNotFoundError(prepared.missing);

  const blocks = [...new Set(options.documentIds)].map((id) => prepared.blocks.get(id)).filter((block): block is string => Boolean(block));
  if (blocks.length) {
    const block = { text: blocks.join("\n\n") };
    if (options.documentPlacement === "last") contents.at(-1)!.parts.push(block);
    // The last turn is the user's, so there is always a first user turn.
    else contents.find((content) => content.role === "user")!.parts.unshift(block);
  }
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
  let blockReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const steps: string[] = [];
  const emit = (delta: string) => {
    text += delta;
    options.onText?.(delta);
  };

  /**
   * One model request. Text is emitted as it arrives; parts are kept as received.
   * `wroteText` says whether this request produced any text of its own.
   * Given `exploring`, the request is the explorer model's: that body goes to its URL, in one
   * piece, and what it writes is not emitted, because the answer comes from the other model.
   */
  const turn = async (exploring?: Body): Promise<{ parts: GeminiPart[]; calls: GeminiFunctionCall[]; wroteText: boolean }> => {
    turns++;
    const stream = streaming && !exploring;
    const response = await fetchImpl(exploring ? explorerUrl! : stream ? endpoint.streamUrl! : endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(exploring ?? body),
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new GeminiRequestError(data?.error?.message ?? `Gemini returned HTTP ${response.status}.`, response.status);
    }
    const parts: GeminiPart[] = [];
    const calls: GeminiFunctionCall[] = [];
    let separated = text.length === 0;
    let wroteText = false;
    const take = (chunk: Chunk) => {
      if (chunk.error?.message) throw new GeminiRequestError(chunk.error.message, response.status);
      if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        // Keep every part unchanged: Gemini 3 requires its thought signatures back.
        parts.push(part);
        if (typeof part.text === "string" && part.text && part.thought !== true) {
          if (!exploring) {
            if (!separated) {
              emit("\n\n");
              separated = true;
            }
            emit(part.text);
          }
          if (part.text.trim()) wroteText = true;
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
      for await (const chunk of parseSseJson<Chunk>(response.body)) take(chunk);
    } else {
      take(await response.json() as Chunk);
    }
    return { parts, calls, wroteText };
  };

  const result = (answered: boolean): AskGeminiResult => ({
    text,
    answered,
    ...(blockReason ? { blockReason } : {}),
    steps,
    plan: prepared.plan,
    turns,
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  });

  // Tools are needed for a file that is too large to send whole, and for a PDF whose pages can be
  // looked at: that one may have its whole text in the prompt and still hide a chart from the model.
  const { searchable } = prepared.plan;
  const { viewable } = prepared;
  if (searchable.length === 0 && viewable.length === 0) return result((await turn()).wroteText);

  const tools = files.tools(searchable, {
    ...(options.wholeDocumentAnalysis === false ? {} : {
      // Reading a whole file in parts is exploring too: the explorer model's work, when there is one.
      generate: createGeminiGenerateText({ url: explorerUrl ?? endpoint.url, headers, fetchImpl, ...(options.analysisConfig ? { generationConfig: options.analysisConfig } : {}) }),
    }),
    onProgress: (event) => options.onActivity?.(`${event.message}…`),
    ...(signal ? { signal } : {}),
    ...(viewable.length > 0 ? { viewPages: viewable } : {}),
  });
  // The request that uses the tools is the chat's own, or one for the explorer model: the same
  // conversation (`contents` is one array, so it grows in both), that model's settings, and a
  // line that says what its part is.
  const explorerConfig = options.explorerGenerationConfig ?? options.generationConfig;
  const exploring: Body | undefined = explorerUrl ? {
    contents,
    systemInstruction: { parts: [{ text: `${system}\n\n${EXPLORER_INSTRUCTION}` }] },
    ...(explorerConfig ? { generationConfig: explorerConfig } : {}),
  } : undefined;
  const withTools = exploring ?? body;
  withTools.tools = [{ functionDeclarations: tools.declarations }];
  withTools.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  // How many turns the conversation had as it was asked. What follows them is the tool loop's.
  const asked = contents.length;
  if (searchable.length > 0) options.onActivity?.(`Too large to read at once: ${searchable.map((meta) => meta.name).join(", ")}. Searching instead…`);

  // Pages the model looks at stay in the request until the question is answered, so they are
  // counted twice: as bytes against the request limit, and as tokens against half of what the
  // budget keeps free for tool results and the answer.
  const { maxRequestBytes, reservedTokens } = files.budget;
  const bytesKeptFree = Math.max(REQUEST_BYTES_MARGIN, Math.floor(maxRequestBytes / 10));
  let pagesLeft = Math.floor(reservedTokens / 2 / PAGE_TOKENS);

  const maxTurns = Math.max(1, options.maxToolTurns ?? 12);
  const maxCalls = Math.max(1, Math.trunc(options.maxToolCallsPerTurn ?? 8));
  let answered = false;
  // Tools run in at most maxTurns - 1 requests. The last request is the tool-free one below, so a
  // model that never stops calling tools does not cost a request whose calls are thrown away.
  for (let round = 1; round < maxTurns; round++) {
    const { parts, calls, wroteText } = await turn(exploring);
    if (calls.length === 0) {
      // Text from this turn is the answer. A remark made earlier, before a tool call, is not.
      // Neither is anything an explorer model writes: the answer is asked for below.
      answered = wroteText && !exploring;
      break;
    }
    body.contents.push({ role: "model", parts });
    const responses: Array<{ call: GeminiFunctionCall; result: ToolResult; files: ToolFile[] }> = [];
    // The size of the request as it stands, worked out when the first look at pages in this turn needs it.
    let requestBytes: number | undefined;
    for (const [index, call] of calls.entries()) {
      // Every call must be answered, but not every call is run: a turn of sixty reads would build
      // a request that no model accepts, and a file can ask a model for exactly that.
      if (index >= maxCalls) {
        responses.push({
          call,
          result: { error: `Not run: one turn runs at most ${maxCalls} tool calls. Send this call again if you still need it.`, tool_turns_left: maxTurns - round - 1 },
          files: [],
        });
        continue;
      }
      const label = tools.has(call.name) ? tools.describe(call.name, call.args) : call.name;
      options.onActivity?.(`${label}…`);
      let limits: ToolFileLimits | undefined;
      if (call.name === TOOL_NAMES.view) {
        requestBytes ??= Buffer.byteLength(JSON.stringify(withTools));
        // Base64 turns three bytes into four characters.
        limits = { maxFileBytes: Math.floor((maxRequestBytes - bytesKeptFree - requestBytes) * 3 / 4), maxPages: pagesLeft };
      }
      const output = await tools.executeWithFiles(call.name, call.args, limits);
      for (const file of output.files) requestBytes = (requestBytes ?? 0) + Math.ceil(file.bytes.length / 3) * 4 + 512;
      if (output.files.length > 0) pagesLeft -= pagesShown(output.result);
      const step = `${label}${toolResultSummary(label, output.result)}`;
      steps.push(step);
      options.onStep?.(step);
      responses.push({ call, result: { ...output.result, tool_turns_left: maxTurns - round - 1 }, files: output.files });
    }
    if (calls.length > maxCalls) {
      const step = `${calls.length - maxCalls} more tool calls in this turn were not run (at most ${maxCalls} a turn)`;
      steps.push(step);
      options.onStep?.(step);
    }
    body.contents.push(...geminiFunctionResponseTurns(responses, { files: options.toolFilePlacement ?? "inside" }) as GeminiContent[]);
  }

  // Out of tool turns, or the last turn had no text (cut off, or a malformed tool call): ask once
  // more with no tools declared at all. (Gemini can ignore functionCallingConfig mode NONE and
  // keep calling tools.) A blocked prompt would only be blocked again.
  // With an explorer model this request is always made: it is the one the answering model gets.
  if (!answered && !blockReason) {
    options.onActivity?.("Writing the answer…");
    delete body.tools;
    delete body.toolConfig;
    let request = searchable.length > 0 ? FINAL_ANSWER_REQUEST : FINAL_ANSWER_AFTER_PAGES;
    if (exploring) {
      // The answering model gets the explorer's calls and what they returned, and nothing else of
      // it. This request ends with a user message, as it must: a Gemini 3 model refuses a
      // function call without its own thought signature in the turn it is still answering.
      body.contents = [...contents.slice(0, asked), ...contents.slice(asked).map(callsOnly)];
      if (steps.length === 0) request = FINAL_ANSWER_WITHOUT_TOOLS;
    }
    body.contents.push({ role: "user", parts: [{ text: request }] });
    answered = (await turn()).wroteText;
  }
  return result(answered);
}

/** How many pages a `view_pages` result showed: its `pages` is "12" or "12-14". */
function pagesShown(result: ToolResult): number {
  const [first, last] = String(result.pages ?? "").split("-").map(Number);
  return Number.isFinite(first) ? (Number.isFinite(last) ? last! - first! + 1 : 1) : 0;
}
