// The tests of text preparation that hold work to the clock: composing long runs of marks and
// telling code from prose in linear time, and ingesting millions of marks without holding the
// event loop (from test/review-0.8.test.ts and test/verify-0.8-search.test.ts).
import { describe, expect, it } from "vitest";
import { buildOutline } from "../../src/analyze.js";
import { createLargeFiles, MemoryDocumentStore } from "../../src/index.js";
import { composed } from "../../src/text.js";
import { utf8 } from "../fake-model.js";
import { measured, timed } from "./clock.js";

/** A test that takes a second or two alone, with room for a machine busy with other tests. */
const BUSY_TIMEOUT_MS = 20_000;

describe("small hostile uploads that held the server", () => {
  it("composes a long run of marks of two classes in linear time (stream-safe form)", async () => {
    const zalgo = `a${"̖́".repeat(160_000)}`;
    const { value, ms } = await timed(() => composed(zalgo));
    expect(ms).toBeLessThan(2_000);
    // A combining grapheme joiner after every 30 marks; each run of 30 is composed as NFC composes it.
    expect(value.split("\u034f").length).toBe(Math.ceil(320_000 / 30));
    const sixty = `a${"\u0301\u0316".repeat(30)}`;
    expect(composed(sixty)).toBe(`${sixty.slice(0, 31).normalize("NFC")}\u034f${sixty.slice(31).normalize("NFC")}`);
    expect(composed(`a${"\u0301\u0316".repeat(15)}`)).toBe(`a${"\u0301\u0316".repeat(15)}`.normalize("NFC"));
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const ingest = await timed(() => files.ingest({ name: "zalgo.txt", bytes: utf8(zalgo) }));
    expect(ingest.ms).toBeLessThan(10_000);
    // Real text is untouched: Hebrew with points and cantillation has a few marks a letter.
    expect(composed("בְּרֵאשִׁ֖ית")).toBe("בְּרֵאשִׁ֖ית".normalize("NFC"));
  });

  it("decides whether a text is code without backtracking over leading spaces", async () => {
    const lines = Array.from({ length: 300 }, () => `${" ".repeat(40_000)}x`);
    expect((await timed(() => buildOutline(lines, "text"))).ms).toBeLessThan(1_000);
  });
});

describe("ingest of text with many marks (45, 47, 48)", () => {
  it("decides whether a text is code without backtracking over the spaces after \"function\"", () => {
    const started = performance.now();
    buildOutline(Array.from({ length: 100 }, () => `function${" ".repeat(1_991)}x`), "text");
    buildOutline(Array.from({ length: 100 }, () => `function${"\u3000".repeat(1_991)}x`), "text");
    expect(performance.now() - started).toBeLessThan(1_000);
    // Code is still code, and its "# " lines are comments; prose keeps its headings.
    for (const code of ["function foo() {", "function(a) {", "function  foo  (a) {"]) expect(buildOutline(["# Title", "", code, "", "# Not a heading", ""], "text"), code).toEqual([]);
    expect(buildOutline(["", "# Title", "", "function of the board", ""], "text")).toHaveLength(1);
  });

  it("composes runs of 30 marks, more than any letter has but no more than the stream-safe form allows, in linear time", () => {
    const thirty = ("a" + "\u0301".repeat(30)).repeat(60_000);
    const started = performance.now();
    const result = composed(thirty);
    expect(performance.now() - started).toBeLessThan(600);
    expect(result).toBe(thirty.normalize("NFC"));
  });

  it("composes a run of millions of marks, and ingests it without holding the server", async () => {
    const run = `a${"\u0301\u0316".repeat(2_000_000)}`;
    const result = composed(run);
    expect(result.split("\u034f")).toHaveLength(Math.ceil(4_000_000 / 30));
    // Composing it again changes nothing: a grapheme joiner ends a run.
    expect(composed(result.slice(0, 100_000))).toBe(result.slice(0, 100_000));
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const { value, gap } = await measured(() => files.ingest({ name: "marks.txt", bytes: utf8(`${run}\nafter\n`) }));
    expect(value.lines).toBeGreaterThan(2_000);
    expect(gap).toBeLessThan(600);
  }, BUSY_TIMEOUT_MS);
});
