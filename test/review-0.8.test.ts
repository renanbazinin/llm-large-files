// Regression tests for the independent review of 0.8.0: each finding, with an input that showed it.
// The small hostile uploads that held the server are in test/timing: they hold the work to the clock.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { grep, rankPassages, SearchableDocument, unsafeRegexReason } from "../src/search.js";
import { toolCallKey } from "../src/tools.js";
import { excelDate } from "../src/xlsx.js";
import { utf8 } from "./fake-model.js";

describe("search", () => {
  // About 1.2 s with one test file at a time, 2.3 s beside the other files on a busy machine.
  it("counts every match of a regex search with groups or the last matches, whatever the time slices cut", { timeout: 20_000 }, () => {
    const text = Array.from({ length: 400_000 }, (_, index) => (index % 3 === 0 ? `ERROR code=${index % 11} took ${index}ms` : `INFO ok ${index}`)).join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_big", name: "big.log" } as never, text });
    const grouped = grep(document, "ERROR code=(\\d+)", { regex: true, maxResults: 20, contextLines: 0, groupBy: "shape" });
    const counted = grouped.groups!.groups.reduce((sum, group) => sum + group.count, 0) + grouped.groups!.otherCount + grouped.groups!.ungrouped;
    expect(counted).toBe(grouped.totalMatchingLines);
    const last = grep(document, "ERROR", { regex: true, maxResults: 3, contextLines: 0, order: "last" });
    expect(last.matches.map((match) => match.line)).toEqual([399_994, 399_997, 400_000]);
  });

  // About 2.5 s with one test file at a time, 3.5 s beside the other files on a busy machine, and
  // over 20 s under coverage on a busy machine.
  it("says that the last matches of a search that stopped early are the last it found", { timeout: 60_000 }, async () => {
    const text = Array.from({ length: 300_000 }, (_, index) => `line ${index} ${"ab".repeat(30)}`).join("\n");
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "slow.txt", bytes: utf8(text) });
    const result = await files.tools([meta], { regexBudgetMs: 5 }).execute("search_document", { document_id: meta.id, query: "(ab)*line \\d+", mode: "regex", order: "last" });
    expect(result.note).toMatch(/^The scan stopped early; the total is a lower bound\. These are the last \d+ matching lines it found, in the order of the file\. There may be later ones, after line \d+: search again with from_line \d+\.$/);
  });

  it("checks a repeated group with \\w as it is compiled, for letters of every script", () => {
    expect(unsafeRegexReason("(\\w+é)+$")).toMatch(/nested quantifier/);
    expect(unsafeRegexReason("(\\w+\\.)+com")).toBeNull();
  });

  it("does not compare a call whose group_by the search refuses", () => {
    expect(toolCallKey("search_document", { document_id: "doc_1", query: "x", mode: "exact", group_by: "week" })).toBeUndefined();
  });

  it("counts only the hits in the lines ranked, toward the cap too", () => {
    const lines = Array.from({ length: 205_000 }, (_, index) => `error ${index}`);
    for (let index = 204_000; index < 204_100; index++) lines[index] = `error payment failed ${index}`;
    const document = new SearchableDocument({ meta: { id: "doc_r", name: "r.log" } as never, text: lines.join("\n") });
    const ranked = rankPassages(document, "error", 3, { from: 204_000, to: 204_100 });
    expect(ranked.length).toBeGreaterThan(0);
    for (const passage of ranked) expect(passage.to >= 204_000 && passage.from <= 204_100).toBe(true);
  });
});

describe("Excel times", () => {
  it("rounds to the second before carrying into the next day", () => {
    expect(excelDate(45000.999995, "date")).toBe("2023-03-16");
    expect(excelDate(0.999995, "time")).toBe("00:00");
    expect(excelDate(0.75, "time")).toBe("18:00");
  });
});
