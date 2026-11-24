// The price of a whole-file read before it starts (src/whole-cost.ts, new in 0.10.0), against what
// the read sends. Until 0.10.0 the loop priced a read at the document's own tokens, which leaves out
// the line numbers, the prompts and the merges of notes: about 9% under what probe5's read sends.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, estimateTokens, MemoryDocumentStore, resolveBudget, type DocumentMeta, type GenerateText, type LargeFiles } from "llm-large-files";
import { ITEMS_FRAME_TOKENS, PART_OUTPUT_TOKENS } from "../src/map-reduce.js";
import { estimateMerges, lineNumberDigits, wholeReadCost } from "../src/whole-cost.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

/** Notes of a part that say little, as in probe5. */
const SHORT_NOTES = "Nothing much (L1).";
/** Notes of a part of 2,634 tokens, as in probe5: enough for two merges. */
const LONG_NOTES = `Notes (L1) ${"important finding ".repeat(900)}`;
/** Notes of a part of 4,094 tokens: just under the output limit of a part, the most a price counts. */
const FULL_NOTES = `Notes (L1) ${"important finding ".repeat(1_400)}`;

/** probe5's document: a service log of 20,000 lines (1.77 MB), read in parts of 60,000 tokens. */
let probe: Promise<{ files: LargeFiles; meta: DocumentMeta }> | undefined;
const probeLog = () => (probe ??= (async () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 60_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
  return { files, meta };
})());

/**
 * probe5's read, through the tool loop and a fake model whose part reader answers `notes` to every
 * request: what the read sends, counted as the library counts tokens (`estimateTokens` of each
 * request's system text and prompt), and how many requests it makes.
 */
async function readWhole(notes: string) {
  const { files, meta } = await probeLog();
  const sent = { inputTokens: 0, requests: 0 };
  const generateText: GenerateText = async ({ system, prompt }) => {
    sent.inputTokens += estimateTokens(system) + estimateTokens(prompt);
    sent.requests++;
    return notes;
  };
  const read = { id: "c1", name: "analyze_whole_document", args: { document_id: meta.id, task: "list every failure with its time" } };
  const model = fakeModel([calls([read]), says("Done.")], { generateText });
  const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "List every failure with its time." }] });
  expect(result.evidence).toEqual([expect.objectContaining({ tool: "analyze_whole_document", whole: true })]);
  return { meta, budget: result.budget, sent };
}

describe("wholeReadCost", () => {
  it("prices probe5's read within 5% of what the library sends, where the document's own tokens are 9% under", async () => {
    const short = await readWhole(SHORT_NOTES);
    const long = await readWhole(LONG_NOTES);
    const price = wholeReadCost(short.meta, short.budget, 1);
    // 25 parts and the read's answer; with long notes, two merges between them.
    expect(short.sent.requests).toBe(26);
    expect(long.sent.requests).toBe(28);
    expect(price).toMatchObject({ parts: 25, merges: 2, requests: 28 });
    expect(price.inputTokens).toBeGreaterThanOrEqual(short.sent.inputTokens * 0.95);
    expect(price.inputTokens).toBeLessThanOrEqual(long.sent.inputTokens * 1.05);
    // The price of 0.9 (`meta.estimatedTokens`) is more than 5% under even the cheapest of these reads.
    expect(short.meta.estimatedTokens).toBeLessThan(short.sent.inputTokens * 0.95);
  }, 60_000);

  it("is within 2% of a read whose notes reach the output limit, with the same requests", async () => {
    expect(estimateTokens(FULL_NOTES)).toBeGreaterThan(PART_OUTPUT_TOKENS - 10);
    expect(estimateTokens(FULL_NOTES)).toBeLessThanOrEqual(PART_OUTPUT_TOKENS);
    const full = await readWhole(FULL_NOTES);
    const price = wholeReadCost(full.meta, full.budget, 1);
    expect(price.requests).toBe(full.sent.requests);
    expect(Math.abs(price.inputTokens - full.sent.inputTokens) / full.sent.inputTokens).toBeLessThan(0.02);
  }, 60_000);

  it("counts in the model's own tokens, and prices a small file as one part and the answer", () => {
    const budget = resolveBudget({ mapChunkTokens: 60_000 });
    const meta = { estimatedTokens: 1_000, lines: 99, textBytes: 4_000 };
    // 99 lines: 189 digits of line numbers. One part with its prompt, then the read's answer from its notes.
    const tokens = 1_000 + 1.2 * 189 + 1.5 * 99 + 200 + PART_OUTPUT_TOKENS + 25 + 200;
    expect(wholeReadCost(meta, budget, 1)).toEqual({ inputTokens: Math.ceil(tokens), requests: 2, parts: 1, merges: 0 });
    expect(wholeReadCost(meta, budget, 1.35).inputTokens).toBe(Math.ceil(tokens * 1.35));
    expect(Number.isNaN(wholeReadCost({ estimatedTokens: Number.NaN, lines: 1, textBytes: 1 }, budget, 1).inputTokens)).toBe(true);
  });

  it("prices a read that lists items as its parts alone, with the longer rules of a list", () => {
    const budget = resolveBudget({ mapChunkTokens: 60_000 });
    const meta = { estimatedTokens: 1_000, lines: 99, textBytes: 4_000 };
    // One part: its numbered lines and its prompt. No merge, no answer of the read.
    const tokens = 1_000 + 1.2 * 189 + 1.5 * 99 + ITEMS_FRAME_TOKENS;
    expect(wholeReadCost(meta, budget, 1, "items")).toEqual({ inputTokens: Math.ceil(tokens), requests: 1, parts: 1, merges: 0 });
    expect(wholeReadCost(meta, budget, 2, "items").inputTokens).toBe(Math.ceil(tokens * 2));
  });
});

describe("lineNumberDigits", () => {
  it("counts the digits of the line numbers 1 to n", () => {
    const written = (lines: number) => Array.from({ length: lines }, (_, index) => String(index + 1).length).reduce((sum, digits) => sum + digits, 0);
    for (const lines of [0, 1, 9, 10, 99, 100, 999, 1_000, 12_345, 20_000]) expect(lineNumberDigits(lines)).toBe(written(lines));
    // probe5's 20,000 lines: 9 of one digit, 90 of two, 900 of three, 9,000 of four and 10,001 of five.
    expect(lineNumberDigits(20_000)).toBe(88_894);
  });
});

describe("estimateMerges", () => {
  it("merges nothing when the notes fit one request together", () => {
    expect(estimateMerges(1, 4_096, 60_000)).toEqual({ requests: 0, inputTokens: 0, finalTokens: 4_121 });
    expect(estimateMerges(14, 4_096, 60_000)).toEqual({ requests: 0, inputTokens: 0, finalTokens: 14 * 4_121 });
  });

  it("merges in batches that fit, round after round", () => {
    // 25 notes of 4,121 tokens: batches of 14, so 2 merges, whose notes then fit together.
    expect(estimateMerges(25, 4_096, 60_000)).toEqual({ requests: 2, inputTokens: 25 * 4_121 + 2 * 200, finalTokens: 2 * 4_121 });
    // 400 notes in batches of 2: 200 merges, then 100, 50, 25, 13, 7, 4 and 2, whose 2 notes fit 10,000.
    expect(estimateMerges(400, 4_096, 10_000)).toMatchObject({ requests: 200 + 100 + 50 + 25 + 13 + 7 + 4 + 2, finalTokens: 2 * 4_121 });
  });

  it("merges in pairs when no two notes fit one batch, for 8 rounds at most", () => {
    // 5 notes larger than a batch: 3, then 2, then 1 merge.
    expect(estimateMerges(5, 4_096, 4_000).requests).toBe(6);
    // 1,000 notes: 500, 250, 125, 63, 32, 16, 8, 4, and the rounds stop with 4 notes.
    expect(estimateMerges(1_000, 4_096, 4_000)).toMatchObject({ requests: 500 + 250 + 125 + 63 + 32 + 16 + 8 + 4, finalTokens: 4 * 4_121 });
  });
});
