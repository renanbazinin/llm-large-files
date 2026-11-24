// What a whole-file read (`analyze_whole_document`) costs, before it starts: the input tokens of
// all its requests, and how many requests it makes, from the document's metadata alone. New in
// 0.10.0, for the ceiling of a question, which prices a read before it lets it run. Internal: not
// exported from the package.
import { PART_OUTPUT_TOKENS } from "./map-reduce.js";
import { estimateParts } from "./plan.js";
import type { Budget, DocumentMeta } from "./types.js";

/**
 * The tokens of a request of a read besides the text it reads or the notes it merges: its system
 * text, the task and the rules. By `estimateTokens`, the fixed words take 135 tokens in a part
 * read, 53 in a merge and 76 in the answer of the read; the rest is room for a task of a few lines.
 */
const REQUEST_FRAME_TOKENS = 200;

/** The tokens of the "### Lines a-b" heading of a part's notes, and of the blank line that joins notes. */
const NOTE_HEADING_TOKENS = 25;

/**
 * The digits of the line numbers 1 to `lines`, written out: what the numbers take in the prompts of
 * the parts. `estimateParts` (src/plan.ts) counts them the same way.
 */
export function lineNumberDigits(lines: number): number {
  let digits = 0;
  for (let width = 1, first = 1; first <= lines; width++, first *= 10) digits += (Math.min(lines, first * 10 - 1) - first + 1) * width;
  return digits;
}

/** What a whole-file read costs. */
export type WholeReadCost = {
  /** The input tokens of all its requests, in the model's own tokens (the library's estimate times `scale`). */
  inputTokens: number;
  /** All its requests: the parts, the merges of their notes, and the answer of the read. */
  requests: number;
  /** The part reads among them. */
  parts: number;
  /** The merges of notes among them. */
  merges: number;
};

/**
 * The merges of notes a whole-file read of `parts` parts makes, when the notes of each part, and
 * each merge, take `noteTokens` (the output limit, at most): how many merge requests there are,
 * their input tokens, and the tokens of the notes the answer of the read is written from. It
 * follows the rounds of `analyzeWholeDocument`: while the notes do not fit `mapChunkTokens`
 * together, they are merged in batches of up to `mapChunkTokens` (in pairs when no two fit one
 * batch), for at most 8 rounds.
 */
export function estimateMerges(parts: number, noteTokens: number, mapChunkTokens: number): { requests: number; inputTokens: number; finalTokens: number } {
  const note = noteTokens + NOTE_HEADING_TOKENS;
  let layer = Math.max(1, Math.ceil(parts));
  let requests = 0;
  let inputTokens = 0;
  for (let round = 0; layer > 1 && layer * note > mapChunkTokens && round < 8; round++) {
    // A batch takes notes while they fit `mapChunkTokens`, and always one.
    const perBatch = Math.max(1, Math.floor(mapChunkTokens / note));
    const batches = perBatch === 1 ? Math.ceil(layer / 2) : Math.ceil(layer / perBatch);
    requests += batches;
    inputTokens += layer * note + batches * REQUEST_FRAME_TOKENS;
    layer = batches;
  }
  return { requests, inputTokens, finalTokens: layer * note };
}

/**
 * The input tokens and requests of a whole-file read of `meta`, with the `budget` of the question
 * and the `scale` of the model that reads it (`capabilities.tokenScale`). The parts are
 * `estimateParts`'s; each sends its lines numbered (the document's tokens, 1.2 tokens a digit of
 * the line numbers and 1.5 a line) with its system text, task and rules. The merges are
 * `estimateMerges`'s, for notes as long as the output limit allows, and the answer of the read is
 * one request more. It is a price before the read: what a read sends is usually less, as notes
 * are shorter than the limit. NaN for metadata that does not give its size.
 *
 * `output` "items" (a read that lists items, with no merge and no answer) is not priced yet.
 */
export function wholeReadCost(meta: Pick<DocumentMeta, "estimatedTokens" | "lines" | "textBytes" | "jsonBytes">, budget: Budget, scale: number, output: "answer" | "items" = "answer"): WholeReadCost {
  if (output !== "answer") throw new Error(`The price of a whole-file read with output "${output}" is not written yet.`);
  const parts = estimateParts(meta, budget);
  const lines = Math.max(1, meta.lines);
  const numbered = meta.estimatedTokens + 1.2 * lineNumberDigits(lines) + 1.5 * lines;
  const merges = estimateMerges(parts, PART_OUTPUT_TOKENS, budget.mapChunkTokens);
  const tokens = numbered + parts * REQUEST_FRAME_TOKENS + merges.inputTokens + merges.finalTokens + REQUEST_FRAME_TOKENS;
  return { inputTokens: Math.ceil(tokens * scale), requests: parts + merges.requests + 1, parts, merges: merges.requests };
}
