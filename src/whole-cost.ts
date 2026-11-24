// What a whole-file read (`analyze_whole_document`) costs, before it starts: the input tokens of
// all its requests, and how many requests it makes, from the document's metadata alone. New in
// 0.10.0, for the ceiling of a question, which prices a read before it lets it run. Internal: not
// exported from the package.
import { estimateMerges, ITEMS_FRAME_TOKENS, PART_HEADING_TOKENS, PART_OUTPUT_TOKENS, partsHaveHeadings, REQUEST_FRAME_TOKENS } from "./map-reduce.js";
import { estimateParts } from "./plan.js";
import type { Budget, DocumentMeta } from "./types.js";

/** The merges of notes a read makes, worked out from the rounds of `analyzeWholeDocument` (src/map-reduce.ts). */
export { estimateMerges };

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
 * The input tokens and requests of a whole-file read of `meta`, with the `budget` of the question
 * and the `scale` of the model that reads it (`capabilities.tokenScale`). The parts are
 * `estimateParts`'s; each sends its lines numbered (the document's tokens, 1.2 tokens a digit of
 * the line numbers and 1.5 a line) with its system text, task and rules, and each after the first
 * of a file with an outline the heading it starts under (`PART_HEADING_TOKENS`).
 * The merges are `estimateMerges`'s, for notes as long as the output limit allows, and the answer
 * of the read is one request more. It is a price before the read: what a read sends is usually
 * less, as notes are shorter than the limit, and not every part starts under a heading. NaN for
 * metadata that does not give its size.
 *
 * `output` "items" (a read that lists items, new in 0.10.0) is the parts alone, each with the
 * longer rules of a list: no merge and no answer. A part read again in halves, when its list does
 * not fit the output limit, is not in the price, as a part halved by an answer read is not.
 */
export function wholeReadCost(
  meta: Pick<DocumentMeta, "estimatedTokens" | "lines" | "textBytes" | "jsonBytes"> & Partial<Pick<DocumentMeta, "format" | "outline">>,
  budget: Budget,
  scale: number,
  output: "answer" | "items" = "answer",
): WholeReadCost {
  const parts = estimateParts(meta, budget);
  const lines = Math.max(1, meta.lines);
  // The first part starts at line 1, under no heading.
  const headings = partsHaveHeadings(meta) ? (parts - 1) * PART_HEADING_TOKENS : 0;
  const numbered = meta.estimatedTokens + 1.2 * lineNumberDigits(lines) + 1.5 * lines + headings;
  if (output === "items") return { inputTokens: Math.ceil((numbered + parts * ITEMS_FRAME_TOKENS) * scale), requests: parts, parts, merges: 0 };
  const merges = estimateMerges(parts, PART_OUTPUT_TOKENS, budget.mapChunkTokens);
  const tokens = numbered + parts * REQUEST_FRAME_TOKENS + merges.inputTokens + merges.finalTokens + REQUEST_FRAME_TOKENS;
  return { inputTokens: Math.ceil(tokens * scale), requests: parts + merges.requests + 1, parts, merges: merges.requests };
}
