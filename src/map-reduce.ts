import { withRetry, type RetryOptions } from "./retry.js";
import { estimateTokens, jsonBytes } from "./text.js";
import { numberLines, scanSource, SearchableDocument, type DocumentSource, type TextChunk } from "./search.js";
import type { Budget, GenerateText, ProgressListener } from "./types.js";

const NOTHING = "NOTHING RELEVANT";
const PART_OUTPUT_TOKENS = 4_096;
const FINAL_OUTPUT_TOKENS = 8_192;

export type WholeDocumentResult = {
  answer: string;
  parts: number;
  /** Parts that were read and had something relevant. Parts that could not be read are not counted. */
  relevantParts: number;
  failedParts: number;
  /** Parts whose notes stopped at the output limit, so some of what they contain is missing. */
  truncatedParts: number;
  /** Note-merging steps that stopped at the output limit. */
  truncatedMerges: number;
  /** The final answer stopped at the output limit. */
  answerTruncated: boolean;
};

type Parts = Array<{ from: number; to: number }>;

/**
 * Whether a part's reply says that the part holds nothing for the task: the sentinel, whatever
 * Markdown or punctuation a model puts around it (`**NOTHING RELEVANT**`). A reply that starts
 * that way and then cites a line did find something, and is kept.
 */
export function saysNothingRelevant(reply: string): boolean {
  const text = reply.replace(/^[^\p{L}\p{N}]+/u, "");
  return text.toUpperCase().startsWith(NOTHING) && !/\(L\d+/.test(text.slice(NOTHING.length));
}

/** Splits a text, fed a piece at a time, into line ranges that each fit one model request. */
class PartSplitter {
  private readonly maxTokens: number;
  private readonly maxBytes: number;
  private readonly parts: Parts = [];
  private from = 1;
  private tokens = 0;
  private bytes = 0;

  constructor(budget: Budget) {
    this.maxTokens = budget.mapChunkTokens;
    this.maxBytes = Math.floor(budget.maxRequestBytes * 0.8);
  }

  add(chunk: TextChunk): void {
    for (let local = 1; local <= chunk.lines.lineCount; local++) {
      const line = chunk.firstLine + local - 1;
      // Count the "123| " prefix each line carries in the prompt.
      const text = `${line}| ${chunk.lines.line(local)}\n`;
      const lineTokens = estimateTokens(text);
      const lineBytes = jsonBytes(text);
      if (line > this.from && (this.tokens + lineTokens > this.maxTokens || this.bytes + lineBytes > this.maxBytes)) {
        this.parts.push({ from: this.from, to: line - 1 });
        this.from = line;
        this.tokens = 0;
        this.bytes = 0;
      }
      this.tokens += lineTokens;
      this.bytes += lineBytes;
    }
  }

  finish(lineCount: number): Parts {
    if (lineCount >= this.from) this.parts.push({ from: this.from, to: lineCount });
    return this.parts;
  }
}

/** Splits a document held in memory into line ranges that each fit one model request. */
export function splitIntoParts(document: SearchableDocument, budget: Budget): Parts {
  const splitter = new PartSplitter(budget);
  splitter.add(document.wholeChunk());
  return splitter.finish(document.lines.lineCount);
}

/** Parts already worked out, by document and budget: counting them reads the whole text. */
const knownParts = new WeakMap<DocumentSource, Map<string, Parts>>();

/** `splitIntoParts` for any document, worked out once per document object and budget. */
export async function partsOf(source: DocumentSource, budget: Budget, signal?: AbortSignal): Promise<Parts> {
  const key = `${budget.mapChunkTokens}|${budget.maxRequestBytes}`;
  const known = knownParts.get(source)?.get(key);
  if (known) return known;
  let parts: Parts;
  if (source instanceof SearchableDocument) {
    parts = splitIntoParts(source, budget);
  } else {
    const splitter = new PartSplitter(budget);
    await scanSource(source, (chunk) => {
      splitter.add(chunk);
    }, signal);
    parts = splitter.finish(source.lineCount);
  }
  if (!knownParts.has(source)) knownParts.set(source, new Map());
  knownParts.get(source)!.set(key, parts);
  return parts;
}

async function pool<T>(count: number, concurrency: number, run: (index: number) => Promise<T>, signal?: AbortSignal): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      signal?.throwIfAborted();
      const index = next++;
      results[index] = await run(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  return results;
}

/** A whole-document read that was refused before any model call: the document has too many parts. */
export class TooManyPartsError extends Error {
  constructor(name: string, readonly parts: number, readonly limit: number) {
    super(`Reading all of ${name} needs ${parts} model calls, over the limit of ${limit}. Use search_document to narrow the question first.`);
    this.name = "TooManyPartsError";
  }
}

/**
 * One model call. A model that was busy or failed on its side (an error with an HTTP status worth
 * retrying) is asked again after a wait, a few times; a request it refused is not. An error that
 * says nothing of the kind is tried once more, at once. `truncated` is true when the reply that
 * was kept hit the output limit.
 */
async function ask(
  generate: GenerateText,
  request: { system: string; prompt: string; maxOutputTokens: number },
  signal: AbortSignal | undefined,
  retry: RetryOptions | undefined,
): Promise<{ text: string; truncated: boolean }> {
  let truncated = false;
  const text = await withRetry(() => {
    truncated = false;
    return generate({ ...request, ...(signal ? { signal } : {}), onTruncated: () => { truncated = true; } });
  }, { retry, signal, unknownErrors: "once" });
  return { text: text.trim(), truncated };
}

/**
 * Answers a task that needs the whole document: each part is read separately ("map"),
 * then the notes are combined ("reduce"), in several rounds if the notes are still too large.
 */
export async function analyzeWholeDocument(options: {
  document: DocumentSource;
  task: string;
  generate: GenerateText;
  budget: Budget;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
  concurrency?: number;
  /** How a model request that failed is sent again. See `RetryOptions`. */
  retry?: RetryOptions;
}): Promise<WholeDocumentResult> {
  const { document, task, generate, budget, onProgress, signal, retry } = options;
  const name = document.meta.name;
  const parts = await partsOf(document, budget, signal);
  if (parts.length > budget.maxMapChunks) throw new TooManyPartsError(name, parts.length, budget.maxMapChunks);

  let done = 0;
  let failed = 0;
  let firstFailure = "";
  let truncatedParts = 0;
  const notes = await pool(parts.length, options.concurrency ?? 4, async (index) => {
    const { from, to } = parts[index]!;
    let text: string;
    let read = true;
    try {
      const part = numberLines(await document.readLines(from, to), from);
      const reply = await ask(generate, {
        system: "You read one part of a larger document and take notes for a later step that combines the notes from every part.",
        prompt: [
          `Task: ${task}`,
          "",
          `Document: ${name}, part ${index + 1} of ${parts.length}, lines ${from}-${to}.`,
          `Write concise notes on everything in this part that is relevant to the task. Keep exact names, numbers, and quotes that matter. Cite line numbers like (L123). If nothing in this part is relevant, reply exactly: ${NOTHING}`,
          "",
          "<part>",
          part,
          "</part>",
        ].join("\n"),
        maxOutputTokens: PART_OUTPUT_TOKENS,
      }, signal, retry);
      text = reply.text;
      if (reply.truncated) {
        truncatedParts++;
        text += "\n[These notes were cut off at the output limit. This part has more relevant content than is listed here.]";
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      failed++;
      read = false;
      const reason = error instanceof Error ? error.message : String(error);
      firstFailure ||= reason;
      text = `[This part could not be read: ${reason}]`;
    }
    done++;
    onProgress?.({ kind: "map", message: `Reading ${name}: part ${done} of ${parts.length}`, done, total: parts.length });
    return { from, to, text, read };
  }, signal);

  // Nothing was read at all: an answer written from here would be invented.
  if (failed === parts.length) throw new Error(`Could not read any part of ${name}: ${firstFailure}`);

  const relevant = notes.filter((note) => !saysNothingRelevant(note.text));
  const relevantParts = relevant.filter((note) => note.read).length;
  if (relevantParts === 0) {
    return {
      answer: `No part of ${name} contained anything relevant to: ${task}${failed ? ` (${failed} of ${parts.length} parts could not be read.)` : ""}`,
      parts: parts.length,
      relevantParts: 0,
      failedParts: failed,
      truncatedParts,
      truncatedMerges: 0,
      answerTruncated: false,
    };
  }

  let layer = relevant.map((note) => `### Lines ${note.from}-${note.to}\n${note.text}`);
  let round = 0;
  let truncatedMerges = 0;
  // Combine notes in batches until one batch holds them all. Each merge is capped at
  // PART_OUTPUT_TOKENS, so the layer shrinks every round; the round cap is a safety net.
  while (layer.length > 1 && estimateTokens(layer.join("\n\n")) > budget.mapChunkTokens && round < 8) {
    round++;
    let batches: string[][] = [];
    let current: string[] = [];
    let tokens = 0;
    for (const note of layer) {
      const noteTokens = estimateTokens(note);
      if (current.length && tokens + noteTokens > budget.mapChunkTokens) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
      current.push(note);
      tokens += noteTokens;
    }
    if (current.length) batches.push(current);
    // Notes too large to share a batch: merge them in pairs instead.
    if (batches.length === layer.length) {
      batches = [];
      for (let index = 0; index < layer.length; index += 2) batches.push(layer.slice(index, index + 2));
    }
    let combined = 0;
    let unmerged = 0;
    layer = await pool(batches.length, options.concurrency ?? 4, async (index) => {
      const batch = batches[index]!.join("\n\n");
      let merged: string;
      try {
        const reply = await ask(generate, {
          system: "You merge partial notes about a document into shorter notes, keeping every relevant fact and line citation.",
          prompt: `Task: ${task}\n\nMerge these notes from ${name} into one set of notes. Keep line citations.\n\n${batch}`,
          maxOutputTokens: PART_OUTPUT_TOKENS,
        }, signal, retry);
        if (reply.truncated) truncatedMerges++;
        merged = reply.truncated ? `${reply.text}\n[These merged notes were cut off at the output limit.]` : reply.text;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A merge that cannot be made loses nothing: the notes of every part were paid for, and go on as they are.
        unmerged++;
        merged = batch;
      }
      combined++;
      onProgress?.({ kind: "reduce", message: `Combining notes on ${name} (round ${round}): ${combined} of ${batches.length}`, done: combined, total: batches.length });
      return merged;
    }, signal);
    // Notes that would not merge will not merge in another round either: the answer is written from what there is.
    if (unmerged > 0) break;
  }

  onProgress?.({ kind: "reduce", message: `Writing the answer from ${relevantParts} relevant parts of ${name}`, done: 0, total: 1 });
  const cutShort = truncatedParts + truncatedMerges;
  const final = await ask(generate, {
    system: "You write a complete answer from notes taken across every part of a document.",
    prompt: [
      `Task: ${task}`,
      "",
      `These notes cover all ${parts.length} parts of ${name}${failed ? ` (${failed} part(s) could not be read)` : ""}. Parts with nothing relevant are omitted.`,
      ...(cutShort ? [`Some notes were cut off at the output limit (they say so), so the notes are incomplete. Say in the answer that it is incomplete.`] : []),
      "Write one complete answer to the task from them. Keep line citations. Point out contradictions or gaps.",
      "",
      layer.join("\n\n"),
    ].join("\n"),
    maxOutputTokens: FINAL_OUTPUT_TOKENS,
  }, signal, retry);
  return {
    answer: final.text,
    parts: parts.length,
    relevantParts,
    failedParts: failed,
    truncatedParts,
    truncatedMerges,
    answerTruncated: final.truncated,
  };
}
