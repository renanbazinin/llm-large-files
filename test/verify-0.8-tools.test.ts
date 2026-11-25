// Regression tests for the findings of the verification of 0.8.0 in the search tool: arguments sent
// as text, the notes of order "last" when the scan stopped early, and group_by results cut to their room.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type ToolResult } from "../src/index.js";
import { SearchableDocument } from "../src/search.js";
import { alreadyShown, createDocumentTools, toolCallKey } from "../src/tools.js";
import { utf8 } from "./fake-model.js";

const doc = (text: string) => new SearchableDocument({ meta: { id: "doc_t", name: "t.txt" } as never, text });
const linesOf = (result: ToolResult) => (result.matches as Array<{ line: number }>).map((match) => match.line);
const budget = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() }).budget;
/** Tools over one document held in memory, with the time for regex searches given. */
const toolsOver = (text: string, regexBudgetMs?: number) =>
  createDocumentTools({ load: async () => doc(text), documentIds: ["doc_t"], budget, ...(regexBudgetMs !== undefined ? { regexBudgetMs } : {}) });
/** A line that the regex (a|a)+$ cannot get past: it tries 2^40 ways before it fails. */
const TRAP = `${"a".repeat(40)}!`;
const SLOW = "(a|a)+$";

describe("booleans sent as text (finding 12)", () => {
  const text = "the cat sat\nconcatenate strings\nCat food\ncategory: pets\n";

  it("reads whole_word and case_sensitive given as \"true\" as true, and \"false\" as false", async () => {
    const tools = toolsOver(text);
    const search = (extra: Record<string, unknown>) => tools.execute("search_document", { document_id: "doc_t", query: "cat", mode: "exact", ...extra });
    for (const on of [true, "true", "TRUE", " True ", 1, "1"]) {
      const whole = await search({ whole_word: on });
      expect(whole.total_matching_lines, JSON.stringify(on)).toBe(2);
      expect(linesOf(whole)).toEqual([1, 3]);
      expect((await search({ case_sensitive: on })).total_matching_lines, JSON.stringify(on)).toBe(3);
    }
    for (const off of [false, "false", "False", 0, "0", "", "no", null]) {
      expect((await search({ whole_word: off })).total_matching_lines, JSON.stringify(off)).toBe(4);
      expect((await search({ case_sensitive: off })).total_matching_lines, JSON.stringify(off)).toBe(4);
    }
    // In regex mode, whole_word stays ignored, however it is sent: \b does it there.
    const regex = await tools.execute("search_document", { document_id: "doc_t", query: "cat", mode: "regex", whole_word: "true" });
    expect(regex.total_matching_lines).toBe(4);
  });

  it("gives a call with \"true\" the key of the same call with true, and one with \"false\" the key of a call without it", () => {
    const base = { document_id: "doc_1", query: "cat", mode: "exact" };
    for (const name of ["whole_word", "case_sensitive"]) {
      expect(toolCallKey("search_document", { ...base, [name]: "true" })).toBe(toolCallKey("search_document", { ...base, [name]: true }));
      expect(toolCallKey("search_document", { ...base, [name]: "true" })).not.toBe(toolCallKey("search_document", base));
      expect(toolCallKey("search_document", { ...base, [name]: "false" })).toBe(toolCallKey("search_document", base));
    }
    // The key of a call without them is the one it had.
    expect(toolCallKey("search_document", base)).toBe(JSON.stringify(["search_document", "doc_1", "cat", "exact", 20, 0, false]));
  });
});

describe("order \"last\" when the scan stopped early (findings 14, 33, 51, 52)", () => {
  // Twenty lines that match at once, then one the pattern cannot get past: the scan stops there.
  const stopsAt21 = [...Array.from({ length: 20 }, (_, index) => `line ${index + 1} a`), TRAP, "end a", "end a"].join("\n");

  it("starts its note as the other searches that stopped early do, so a later call of it is run again", async () => {
    const call = { name: "search_document", args: { document_id: "doc_t", query: SLOW, mode: "regex", order: "last", max_results: 3 } };
    const started = performance.now();
    const result = await toolsOver(stopsAt21, 400).execute(call.name, call.args);
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(linesOf(result)).toEqual([18, 19, 20]);
    expect(result.note).toBe("The scan stopped early; the total is a lower bound. These are the last 3 matching lines it found, in the order of the file. There may be later ones, after line 20: search again with from_line 21.");
    expect(alreadyShown(call, { call, result })).toBeUndefined();
    expect(alreadyShown(call, { call, result }, true)).toBeUndefined();
  });

  it("starts its note the same way when the result is cut to its room", async () => {
    const text = [...Array.from({ length: 40 }, (_, index) => `line ${index + 1} ${"x".repeat(30)} a`), TRAP].join("\n");
    const call = { name: "search_document", args: { document_id: "doc_t", query: SLOW, mode: "regex", order: "last", max_results: 40 } };
    const { result } = await toolsOver(text, 400).executeWithFiles(call.name, call.args, { maxResultCharacters: 1_000 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
    const lines = linesOf(result);
    expect(lines.length).toBeLessThan(40);
    expect(lines.at(-1)).toBe(40);
    expect(result.note).toBe(`The scan stopped early; the total is a lower bound. Showing the last ${lines.length} matching lines it found to stay within the size limit, in the order of the file. There may be later ones, after line 40: search again with from_line 41.`);
    expect(alreadyShown(call, { call, result })).toBeUndefined();
  });

  it("says that it found nothing, and suggests no line to search from, when nothing was found before it stopped", async () => {
    const trapFirst = [TRAP, ...Array.from({ length: 50 }, (_, index) => `line ${index + 2} a`)].join("\n");
    for (const range of [{}, { from_line: 1 }, { to_line: 30 }]) {
      const call = { name: "search_document", args: { document_id: "doc_t", query: SLOW, mode: "regex", order: "last", ...range } };
      const result = await toolsOver(trapFirst, 300).execute(call.name, call.args);
      expect(result.matches).toEqual([]);
      expect(result.note).toBe("The scan stopped early, out of time, before it found a matching line: the lines it did not reach may have some. Try a simpler pattern, mode \"exact\", or fewer lines with from_line and to_line.");
      expect(alreadyShown(call, { call, result })).toBeUndefined();
    }
  });

  it("suggests a from_line inside the range searched, and keeps its to_line", async () => {
    const text = [...Array.from({ length: 30 }, (_, index) => `line ${index + 1} a`), TRAP, ...Array.from({ length: 20 }, () => "x a")].join("\n");
    // Nothing found in the range: no from_line before it.
    const none = await toolsOver(text, 300).execute("search_document", { document_id: "doc_t", query: SLOW, mode: "regex", order: "last", from_line: 31, to_line: 32 });
    expect(none.searched_lines).toBe("31-32");
    expect(String(none.note)).not.toMatch(/from_line \d/);
    // Found some: the search goes on after the last of them, up to the same to_line.
    const some = await toolsOver(text, 300).execute("search_document", { document_id: "doc_t", query: SLOW, mode: "regex", order: "last", max_results: 2, from_line: 10, to_line: 45 });
    expect(linesOf(some)).toEqual([29, 30]);
    expect(some.note).toBe("The scan stopped early; the total is a lower bound. These are the last 2 matching lines it found, in the order of the file. There may be later ones, after line 30: search again with from_line 31 and to_line 45.");
    // Only from_line given: no to_line is added.
    const from = await toolsOver(text, 300).execute("search_document", { document_id: "doc_t", query: SLOW, mode: "regex", order: "last", max_results: 2, from_line: 10 });
    expect(String(from.note)).toMatch(/search again with from_line 31\.$/);
  });

  it("leaves the note of a search that read the whole file as it was", async () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1}${index % 3 === 0 ? " hit" : ""}`).join("\n");
    const result = await toolsOver(text).execute("search_document", { document_id: "doc_t", query: "hit", mode: "regex", order: "last", max_results: 2 });
    expect(result.note).toBe("These are the last 2 of the 10 matching lines, in the order of the file: the last match is on line 28, and the first on line 1.");
  });
});

describe("group_by by time, cut to its room (finding 28)", () => {
  // Hour h has h + 1 matching lines: the largest groups are the latest hours.
  const lines: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute <= hour; minute++) lines.push(`2026-11-10 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00 ERROR timeout`);
  }
  const log = lines.join("\n");
  type Group = { key: string; count: number; first_line: number };

  it("keeps the largest groups, in time order, as its note says", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "p.log", bytes: utf8(log) });
    const tools = files.tools([meta]);
    for (const max of [50, 10]) {
      const { result } = await tools.executeWithFiles("search_document", { document_id: meta.id, query: "timeout", mode: "exact", group_by: "hour", max_results: max }, { maxResultCharacters: 900 });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(900);
      const groups = result.groups as Group[];
      expect(groups.length).toBeGreaterThan(1);
      expect(groups.length).toBeLessThan(Math.min(max, 24));
      // The largest: the latest hours, 23:00 among them.
      const counts = groups.map((group) => group.count);
      expect(counts).toEqual(Array.from({ length: groups.length }, (_, index) => 24 - groups.length + index + 1));
      expect(groups.at(-1)!.key).toBe("2026-11-10 23:00");
      // In time order.
      expect(groups.map((group) => group.first_line)).toEqual([...groups.map((group) => group.first_line)].sort((left, right) => left - right));
      expect(result.note).toBe(`Showing ${groups.length} of the 24 groups to stay within the size limit, the largest, in time order. Narrow the search, or use from_line and to_line, for the others.`);
    }
  });

  it("keeps the largest groups by day and minute too, and by shape the first of its list", async () => {
    const days: string[] = [];
    for (let day = 1; day <= 28; day++) for (let count = 0; count < day; count++) days.push(`2026-02-${String(day).padStart(2, "0")} 10:00:00 ERROR code=${day} timeout`);
    const tools = toolsOver(days.join("\n"));
    const { result } = await tools.executeWithFiles("search_document", { document_id: "doc_t", query: "timeout", mode: "exact", group_by: "day" }, { maxResultCharacters: 700 });
    const groups = result.groups as Group[];
    expect(groups.length).toBeLessThan(28);
    expect(groups.at(-1)!.key).toBe("2026-02-28");
    expect(groups.map((group) => group.count)).toEqual(Array.from({ length: groups.length }, (_, index) => 28 - groups.length + index + 1));
    // By minute: the same text with minutes in place of days.
    const minutes = days.map((line) => line.replace(/^2026-02-(\d\d) 10:00/, "2026-02-01 10:$1"));
    const byMinute = (await toolsOver(minutes.join("\n")).executeWithFiles("search_document", { document_id: "doc_t", query: "timeout", mode: "exact", group_by: "minute" }, { maxResultCharacters: 700 })).result;
    expect((byMinute.groups as Group[]).at(-1)!.key).toBe("2026-02-01 10:28");
    // By shape (one group here) and by capture, the largest first, as before.
    const byCapture = (await toolsOver(days.join("\n")).executeWithFiles("search_document", { document_id: "doc_t", query: "code=(\\d+)", mode: "regex", group_by: "capture" }, { maxResultCharacters: 700 })).result;
    const captured = byCapture.groups as Group[];
    expect(captured[0]!.key).toBe("28");
    expect(captured.map((group) => group.count)).toEqual([...captured.map((group) => group.count)].sort((left, right) => right - left));
    expect(String(byCapture.note)).toMatch(/, the largest first\./);
  });
});

describe("follow-ups of the check of the tool fixes", () => {
  it("runs again a search stored by 0.7.0 with case_sensitive as text", async () => {
    const { alreadyShown } = await import("../src/tools.js");
    const call = { name: "search_document", args: { document_id: "doc_1", query: "Error", mode: "exact", case_sensitive: true } };
    const stored = { call: { name: "search_document", args: { document_id: "doc_1", query: "Error", mode: "exact", case_sensitive: "true" } }, result: { document: "a.log", mode: "exact", total_matching_lines: 1, matches: [{ line: 1, text: "Error" }] } };
    expect(alreadyShown(call, stored, true)).toBeUndefined();
    // In this question (not stored), the same call is pointed to.
    expect(alreadyShown(call, stored, false)?.already_shown).toBe(true);
  });
});
