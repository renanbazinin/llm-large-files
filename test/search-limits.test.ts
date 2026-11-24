// Exact search past 1,000,000 matching lines (P8), and the top passages of a keyword search kept
// with a heap of the few shown, not a sort of all of them (P9). New in 0.10.0.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { grep, rankPassages, SearchableDocument, topScored } from "../src/search.js";
import { utf8 } from "./fake-model.js";

const doc = (text: string) => new SearchableDocument({ meta: { id: "doc_t", name: "t.txt" } as never, text });

/** `lines` lines, each of which holds "hit". */
const allHits = (lines: number) => Array.from({ length: lines }, (_, index) => `hit ${index % 10}`).join("\n");

describe("an exact search past 1,000,000 matching lines", () => {
  it("counts every line, and is not a lower bound", () => {
    // 0.9.0 stopped at 1,000,000: total 1,000,000, stoppedEarly, and no last match.
    const result = grep(doc(allHits(1_200_000)), "hit", { maxResults: 3, contextLines: 0 });
    expect(result.totalMatchingLines).toBe(1_200_000);
    expect(result.stoppedEarly).toBe(false);
    expect(result.matches.map((match) => match.line)).toEqual([1, 2, 3]);
    expect(result.last?.line).toBe(1_200_000);
  }, 30_000);

  it("gives the exact count through search_document, with the last match of the file", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "hits.log", bytes: utf8(allHits(1_200_000)) });
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "hit", mode: "exact", max_results: 2 });
    expect(result.total_matching_lines).toBe(1_200_000);
    expect(String(result.note)).not.toMatch(/stopped early|lower bound/);
    expect((result.matches as Array<{ line: number }>).map((match) => match.line)).toEqual([1, 2, 1_200_000]);
  }, 60_000);

  it("still stops at its time limit when one is given, and says the count is a lower bound", () => {
    const result = grep(doc(allHits(1_200_000)), "hit", { maxResults: 3, contextLines: 0, timeLimitMs: 0 });
    expect(result.stoppedEarly).toBe(true);
    expect(result.totalMatchingLines).toBeLessThan(1_200_000);
  }, 30_000);
});

/** A stable sort by score, then a slice: what `topScored` must give. */
const sorted = <K>(entries: Array<[K, number]>, count: number) => [...entries].sort((left, right) => right[1] - left[1]).slice(0, Math.max(0, count));

describe("topScored", () => {
  it("gives what a stable sort by score gives, ties in the order they came", () => {
    // A small generator of its own, so that every run checks the same cases.
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (let round = 0; round < 300; round++) {
      const size = Math.floor(next() * 400);
      // Few distinct scores, so that ties are many.
      const entries: Array<[number, number]> = Array.from({ length: size }, (_, index) => [index, Math.floor(next() * 12) / 4]);
      const count = Math.floor(next() * 15);
      expect(topScored(entries, count)).toEqual(sorted(entries, count));
    }
  });

  it("keeps only what `keep` keeps, and gives nothing for a count of 0 or less", () => {
    const entries: Array<[string, number]> = [["a", 1], ["b", 3], ["c", 3], ["d", 2], ["e", 5]];
    expect(topScored(entries, 2, (key) => key !== "e")).toEqual([["b", 3], ["c", 3]]);
    expect(topScored(entries, 0)).toEqual([]);
    expect(topScored(entries, -2)).toEqual([]);
    expect(topScored(new Map(entries), 10)).toEqual(sorted(entries, 10));
  });

  it("ranks the passages of a keyword search best first, the top 10 of many", () => {
    // 3,000 passages that mention the word a different number of times.
    const lines = Array.from({ length: 40 * 3_000 }, (_, index) => (index % 40 < (Math.floor(index / 40) % 7) ? "the ledger moved" : "nothing here"));
    const passages = rankPassages(doc(lines.join("\n")), "ledger", 10);
    expect(passages).toHaveLength(10);
    for (let index = 1; index < passages.length; index++) expect(passages[index - 1]!.score).toBeGreaterThanOrEqual(passages[index]!.score);
    // Of equal scores, the earlier passage first, as the sort of 0.9.0 gave them.
    for (let index = 1; index < passages.length; index++) {
      if (passages[index - 1]!.score === passages[index]!.score) expect(passages[index - 1]!.from).toBeLessThan(passages[index]!.from);
    }
  });
});
