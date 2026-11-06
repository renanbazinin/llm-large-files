import { estimateTokens, jsonBytes } from "./text.js";
import type { SearchableDocument } from "./search.js";
import type { Budget, GenerateText, ProgressListener } from "./types.js";

const NOTHING = "NOTHING RELEVANT";
const PART_OUTPUT_TOKENS = 4_096;
const FINAL_OUTPUT_TOKENS = 8_192;

export type WholeDocumentResult = {
  answer: string;
  parts: number;
  relevantParts: number;
  failedParts: number;
};

/** Splits a document into line ranges that each fit one model request. */
export function splitIntoParts(document: SearchableDocument, budget: Budget): Array<{ from: number; to: number }> {
  const maxTokens = budget.mapChunkTokens;
  const maxBytes = Math.floor(budget.maxRequestBytes * 0.8);
  const parts: Array<{ from: number; to: number }> = [];
  let from = 1;
  let tokens = 0;
  let bytes = 0;
  for (let line = 1; line <= document.lines.lineCount; line++) {
    // Count the "123| " prefix each line carries in the prompt.
    const text = `${line}| ${document.lines.line(line)}\n`;
    const lineTokens = estimateTokens(text);
    const lineBytes = jsonBytes(text);
    if (line > from && (tokens + lineTokens > maxTokens || bytes + lineBytes > maxBytes)) {
      parts.push({ from, to: line - 1 });
      from = line;
      tokens = 0;
      bytes = 0;
    }
    tokens += lineTokens;
    bytes += lineBytes;
  }
  if (document.lines.lineCount >= from) parts.push({ from, to: document.lines.lineCount });
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

async function withRetry(call: () => Promise<string>, signal?: AbortSignal): Promise<string> {
  try {
    return await call();
  } catch (error) {
    if (signal?.aborted) throw error;
    return call();
  }
}

/**
 * Answers a task that needs the whole document: each part is read separately ("map"),
 * then the notes are combined ("reduce"), in several rounds if the notes are still too large.
 */
export async function analyzeWholeDocument(options: {
  document: SearchableDocument;
  task: string;
  generate: GenerateText;
  budget: Budget;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
  concurrency?: number;
}): Promise<WholeDocumentResult> {
  const { document, task, generate, budget, onProgress, signal } = options;
  const name = document.meta.name;
  const parts = splitIntoParts(document, budget);
  if (parts.length > budget.maxMapChunks) {
    throw new Error(`Reading all of ${name} needs ${parts.length} model calls, over the limit of ${budget.maxMapChunks}. Use search_document to narrow the question first.`);
  }

  let done = 0;
  let failed = 0;
  const notes = await pool(parts.length, options.concurrency ?? 4, async (index) => {
    const { from, to } = parts[index]!;
    let text: string;
    try {
      text = (await withRetry(() => generate({
        system: "You read one part of a larger document and take notes for a later step that combines the notes from every part.",
        prompt: [
          `Task: ${task}`,
          "",
          `Document: ${name}, part ${index + 1} of ${parts.length}, lines ${from}-${to}.`,
          `Write concise notes on everything in this part that is relevant to the task. Keep exact names, numbers, and quotes that matter. Cite line numbers like (L123). If nothing in this part is relevant, reply exactly: ${NOTHING}`,
          "",
          "<part>",
          document.lines.numbered(from, to),
          "</part>",
        ].join("\n"),
        maxOutputTokens: PART_OUTPUT_TOKENS,
        signal,
      }), signal)).trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      failed++;
      text = `[This part could not be read: ${error instanceof Error ? error.message : String(error)}]`;
    }
    done++;
    onProgress?.({ kind: "map", message: `Reading ${name}: part ${done} of ${parts.length}`, done, total: parts.length });
    return { from, to, text };
  }, signal);

  const relevant = notes.filter((note) => !note.text.toUpperCase().startsWith(NOTHING));
  if (relevant.length === 0) {
    return { answer: `No part of ${name} contained anything relevant to: ${task}`, parts: parts.length, relevantParts: 0, failedParts: failed };
  }

  let layer = relevant.map((note) => `### Lines ${note.from}-${note.to}\n${note.text}`);
  let round = 0;
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
    layer = await pool(batches.length, options.concurrency ?? 4, async (index) => {
      const text = await withRetry(() => generate({
        system: "You merge partial notes about a document into shorter notes, keeping every relevant fact and line citation.",
        prompt: `Task: ${task}\n\nMerge these notes from ${name} into one set of notes. Keep line citations.\n\n${batches[index]!.join("\n\n")}`,
        maxOutputTokens: PART_OUTPUT_TOKENS,
        signal,
      }), signal);
      combined++;
      onProgress?.({ kind: "reduce", message: `Combining notes on ${name} (round ${round}): ${combined} of ${batches.length}`, done: combined, total: batches.length });
      return text.trim();
    }, signal);
  }

  onProgress?.({ kind: "reduce", message: `Writing the answer from ${relevant.length} relevant parts of ${name}`, done: 0, total: 1 });
  const answer = await withRetry(() => generate({
    system: "You write a complete answer from notes taken across every part of a document.",
    prompt: [
      `Task: ${task}`,
      "",
      `These notes cover all ${parts.length} parts of ${name}${failed ? ` (${failed} part(s) could not be read)` : ""}. Parts with nothing relevant are omitted.`,
      "Write one complete answer to the task from them. Keep line citations. Point out contradictions or gaps.",
      "",
      layer.join("\n\n"),
    ].join("\n"),
    maxOutputTokens: FINAL_OUTPUT_TOKENS,
    signal,
  }), signal);
  return { answer: answer.trim(), parts: parts.length, relevantParts: relevant.length, failedParts: failed };
}
