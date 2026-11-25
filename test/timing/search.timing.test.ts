// The tests of search that hold work to the clock: the longest time the event loop waits while a
// large document is searched, how long a search takes, and how often a timer gets a turn meanwhile
// (from test/verify-0.8-search.test.ts, test/limits.test.ts, test/search-0.8.1.test.ts and
// test/verify-0.8-tools.test.ts).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type DocumentMeta, type ToolResult } from "../../src/index.js";
import { grep, grepSource, rankPassages, rankSource, SearchableDocument } from "../../src/search.js";
import { createDocumentTools } from "../../src/tools.js";
import { measured } from "./clock.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const doc = (text: string) => new SearchableDocument({ meta: { id: "doc_v", name: "v.txt", textBytes: text.length } as DocumentMeta, text });
/** A test that takes a second or two alone, with room for a machine busy with other tests. */
const BUSY_TIMEOUT_MS = 20_000;

/** A log of `count` lines that all hold "ERROR", with numbers, addresses and IDs that vary. */
const errorLog = (count: number) => Array.from({ length: count }, (_, index) => `2026-11-10T14:${String(index % 60).padStart(2, "0")}:17Z ERROR job ${index} failed at 10.0.${index % 256}.1 id=${(index * 7919).toString(16)}`).join("\n");

const bytes = (text: string) => new TextEncoder().encode(text);
const line = (i: number) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} took ${i % 900}ms`;
/** A log with one line that `(a|a)+$` cannot get past: the quick check lets that pattern through. */
const trapped = (lines: number) => [
  ...Array.from({ length: lines }, (_, i) => line(i)),
  `checksum ${"a".repeat(48)}!`,
  ...Array.from({ length: lines }, (_, i) => line(lines + i)),
].join("\n");
const SLOW = "(a|a)+$";

/** Runs `work` and reports how long it took and how often a timer of another "request" got a turn meanwhile. */
async function watched<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; turns: number }> {
  let turns = 0;
  const beat = setInterval(() => turns++, 5);
  const started = performance.now();
  try {
    const value = await work();
    return { value, ms: performance.now() - started, turns };
  } finally {
    clearInterval(beat);
  }
}

describe("a document held in memory is searched in pieces, within a time limit (6, 50)", () => {
  it("finds a whole word among 30 MB of long words without holding the server", async () => {
    const word = "a".repeat(1_999);
    const lines = Array.from({ length: 15_000 }, () => word);
    lines[100] = "x a y";
    lines[14_000] = "a";
    const document = doc(lines.join("\n"));
    const { value, gap } = await measured(() => grepSource(document, "a", { maxResults: 5, contextLines: 0, wholeWord: true, caseSensitive: true, timeLimitMs: 60_000 }));
    expect(value.stoppedEarly).toBe(false);
    expect(value.matches.map((match) => match.line)).toEqual([101, 14_001]);
    // Held as one piece, the scan took one look per occurrence, and 820 ms of 10 MB in one go.
    expect(gap).toBeLessThan(500);
    const ignoringCase = grep(document, "A", { maxResults: 5, contextLines: 0, wholeWord: true, timeLimitMs: 60_000 });
    expect(ignoringCase.totalMatchingLines).toBe(2);
  }, BUSY_TIMEOUT_MS);

  it("counts the lines of an exact search by shape with other work in between", async () => {
    const document = doc(errorLog(250_000));
    const { value, gap } = await measured(() => grepSource(document, "ERROR", { maxResults: 5, contextLines: 0, groupBy: "shape" }));
    const groups = value.groups!;
    expect(groups.groups.reduce((sum, group) => sum + group.count, 0) + groups.otherCount + groups.ungrouped).toBe(value.totalMatchingLines);
    expect(gap).toBeLessThan(500);
  }, BUSY_TIMEOUT_MS);

  it("counts the lines of a regex search by shape within its time slices", async () => {
    const document = doc(errorLog(250_000));
    const { value, gap } = await measured(() => grepSource(document, "ERR(OR)", { regex: true, maxResults: 5, contextLines: 0, groupBy: "shape", timeLimitMs: 60_000 }));
    const groups = value.groups!;
    expect(groups.groups.reduce((sum, group) => sum + group.count, 0) + groups.otherCount + groups.ungrouped).toBe(value.totalMatchingLines);
    expect(value.totalMatchingLines).toBe(250_000);
    // A slice is 250 ms; the lines it found were grouped after it, outside the time limit, for seconds.
    expect(gap).toBeLessThan(800);
  }, BUSY_TIMEOUT_MS);
});

describe("a ranged keyword search reads and counts only what it needs (13, 53, 54)", () => {
  it("goes through only the occurrences in the lines ranked, in memory", async () => {
    const document = doc(Array.from({ length: 150_000 }, (_, index) => `${"zq zw zx ".repeat(13)}${index}`).join("\n"));
    const { value, ms } = await measured(() => rankPassages(document, "zq zw zx", 3, { from: 149_901, to: 150_000 }));
    expect(value.length).toBe(3);
    for (const passage of value) expect(passage.to).toBeGreaterThanOrEqual(149_901);
    // Every occurrence in the file was looked at, and its line found: 1.5 seconds of 100,000 lines.
    expect(ms).toBeLessThan(500);
    const ranged = await rankSource(document, "zq zw zx", 3, undefined, { from: 149_901, to: 150_000 });
    expect(ranged).toEqual(value);
  });
});

describe("a regex that cannot get past a line", () => {
  it("stops the search at that line, long before the time limit, and keeps what was found", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(trapped(300)) });
    const tools = files.tools([meta]);
    const { value, ms, turns } = await watched(() => tools.execute("search_document", { document_id: meta.id, query: SLOW, mode: "regex" }));
    expect(value.note).toMatch(/stopped early/);
    // The time limit of one search is 3 seconds. Two slices on the line, and it is over.
    expect(ms).toBeLessThan(2_000);
    // Other work ran while it searched.
    expect(turns).toBeGreaterThan(0);
    // The tool set still works.
    expect((await tools.execute("search_document", { document_id: meta.id, query: "request 7 took", mode: "exact" })).total_matching_lines).toBe(1);
  });

  it("does the same for a document read by range", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-limits-"));
    const files = createLargeFiles({ requireOwner: false, store: new FileDocumentStore(directory), wholeDocumentBytes: 0, scanChunkBytes: 4_096, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(trapped(300)) });
    const tools = files.tools([meta]);
    const { value, ms } = await watched(() => tools.execute("search_document", { document_id: meta.id, query: SLOW, mode: "regex" }));
    expect(value.note).toMatch(/stopped early/);
    expect(ms).toBeLessThan(2_000);
  });
});

describe("a large document held in memory (LLF-044)", () => {
  it("is searched in pieces, with the results of one scan, letting other work run", async () => {
    const { grep, grepSource, rankPassages, rankSource, SearchableDocument } = await import("../../src/search.js");
    const text = Array.from({ length: 320_000 }, (_, index) => `2026-01-01 10:00:${String(index % 60).padStart(2, "0")} ${index % 13 === 0 ? "ERROR payment declined" : "INFO request served"} id=${index}`).join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_m", name: "m.log", outline: [] } as never, text });
    // The turns of the event loop other work got: counted by an immediate that asks for the next
    // turn, not by a 1 ms timer, which did not run once during the three searches on a Windows runner
    // (Node 26), whose timers are coarse. Twice the lines of a slice's worth on a fast machine.
    let turns = 0;
    let counting = true;
    const count = () => {
      if (!counting) return;
      turns++;
      setImmediate(count);
    };
    setImmediate(count);
    const exact = await grepSource(document, "ERROR", { maxResults: 5, contextLines: 1 });
    const keywords = await rankSource(document, "payment declined", 3);
    const last = await grepSource(document, "declined", { maxResults: 2, contextLines: 0, order: "last" });
    counting = false;
    expect(turns).toBeGreaterThan(0);
    expect(exact).toEqual(grep(document, "ERROR", { maxResults: 5, contextLines: 1 }));
    expect(keywords).toEqual(rankPassages(document, "payment declined", 3));
    expect(last.matches.map((match) => match.line)).toEqual([319_983, 319_996]);
  });
});

describe("order \"last\" when the scan stopped early (findings 14, 33, 51, 52)", () => {
  const doc = (text: string) => new SearchableDocument({ meta: { id: "doc_t", name: "t.txt" } as never, text });
  const linesOf = (result: ToolResult) => (result.matches as Array<{ line: number }>).map((match) => match.line);
  const budget = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() }).budget;
  /** Tools over one document held in memory, with the time for regex searches given. */
  const toolsOver = (text: string, regexBudgetMs?: number) =>
    createDocumentTools({ load: async () => doc(text), documentIds: ["doc_t"], budget, ...(regexBudgetMs !== undefined ? { regexBudgetMs } : {}) });

  it("counts all of 1,000,000 matching lines, and is no lower bound (P8, 0.10.0)", async () => {
    // Until 0.10.0 an exact search stopped at its millionth matching line, here the last line of
    // the file, and said that the scan stopped early. It now goes on past it, and so reaches the end.
    const text = "x\n".repeat(999_999) + "x";
    const started = performance.now();
    const result = await toolsOver(text).execute("search_document", { document_id: "doc_t", query: "x", mode: "exact", order: "last", max_results: 2 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.total_matching_lines).toBe(1_000_000);
    expect(linesOf(result)).toEqual([999_999, 1_000_000]);
    expect(result.note).toBe("These are the last 2 of the 1000000 matching lines, in the order of the file: the last match is on line 1000000, and the first on line 1.");
  }, 15_000);
});
