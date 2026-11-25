import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, toolResultSummary, type ToolResult } from "../src/index.js";
import { grep, SearchableDocument } from "../src/search.js";
import { alreadyShown, createDocumentTools } from "../src/tools.js";
import { serviceLog, utf8 } from "./fake-model.js";

// serviceLog(3_000) has an ERROR line every 97 lines: 30 of them, the last on line 2910.
const LOG = serviceLog(3_000);
const LINES = LOG.split("\n");
const ERROR_LINES = LINES.flatMap((line, index) => (line.includes("ERROR") ? [index + 1] : []));
const numbered = (line: number) => `${line}| ${LINES[line - 1]!}`;
const linesOf = (result: ToolResult) => (result.matches as Array<{ line: number }>).map((match) => match.line);

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function inMemory() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(LOG) });
  return { files, meta, tools: files.tools([meta]) };
}

describe("the last match of an exact or regex search", () => {
  it("is found with the lines around it, after the first matches", () => {
    expect(ERROR_LINES).toHaveLength(30);
    const document = new SearchableDocument({ meta: { id: "doc_s", name: "app.log" } as never, text: LOG });
    const result = grep(document, "ERROR", { maxResults: 5, contextLines: 2 });
    expect(result.totalMatchingLines).toBe(30);
    expect(result.matches.map((match) => match.line)).toEqual(ERROR_LINES.slice(0, 5));
    expect(result.last).toEqual({ line: 2910, text: LINES[2909], before: [numbered(2908), numbered(2909)], after: [numbered(2911), numbered(2912)] });
    // On the last line of the file there is nothing after it.
    const end = grep(document, "took 300ms", { maxResults: 2, contextLines: 2 });
    expect(end.totalMatchingLines).toBe(4);
    expect(end.last).toEqual({ line: 3000, text: LINES[2999], before: [numbered(2998), numbered(2999)], after: [] });
    // Not when every match is among the first ones.
    expect(grep(document, "ERROR", { maxResults: 30, contextLines: 2 }).last).toBeUndefined();
  });

  it("is shown after the first ones, with a note that says how many of how many are shown", async () => {
    const { tools, meta } = await inMemory();
    const result = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" });
    expect(result.total_matching_lines).toBe(30);
    expect(linesOf(result)).toEqual([...ERROR_LINES.slice(0, 20), 2910]);
    expect(result.note).toBe("21 of the 30 matching lines are shown: the first 20 and the last (line 2910). To see the ones in between, search again with from_line 1941, or count them with group_by.");
    expect(Object.keys(result)).toEqual(["document", "mode", "total_matching_lines", "note", "next_from_line", "matches"]);
    expect(result.next_from_line).toBe(1941);
    // One asked for: the first and the last.
    const one = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "regex", max_results: 1 });
    expect(linesOf(one)).toEqual([97, 2910]);
    expect(one.note).toBe("2 of the 30 matching lines are shown: the first and the last (line 2910). To see the ones in between, search again with from_line 98, or count them with group_by.");
  });

  it("leaves the result as it was when every match is shown", async () => {
    const { tools, meta } = await inMemory();
    // One more match than max_results: the last one is the only one left, and nothing is left out.
    const all = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 29 });
    expect(linesOf(all)).toEqual(ERROR_LINES);
    expect(all.note).toBeUndefined();
    const fits = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 30, context_lines: 1 });
    expect(Object.keys(fits)).toEqual(["document", "mode", "total_matching_lines", "matches"]);
    expect(linesOf(fits)).toEqual(ERROR_LINES);
  });

  it("is the same for a document read by range, in pieces of any size, without reading its lines again", { timeout: 20_000 }, async () => {
    const { tools: whole, meta: wholeMeta } = await inMemory();
    directory = await mkdtemp(path.join(tmpdir(), "llf-last-"));
    const reads = { count: 0 };
    class Counting extends FileDocumentStore {
      override async readTextRange(id: string, start: number, end: number) {
        reads.count++;
        return super.readTextRange(id, start, end);
      }
    }
    // Passages start a new piece; a regex picks a line where one starts, so that the lines before the last match are in the piece before.
    const passages = new SearchableDocument({ meta: { id: "doc_p", name: "app.log" } as never, text: LOG }).passages;
    const start = passages[passages.length - 3]!;
    const hex = (line: number) => /req=([0-9a-f]+)/.exec(LINES[line - 1]!)![1]!;
    const atPassage = `req=(${hex(50)}|${hex(start)})`;
    // And one where a passage ends, so that the lines after it are in the piece after.
    const beforePassage = `req=(${hex(50)}|${hex(start - 1)})`;
    for (const scanChunkBytes of [1, 4_096]) {
      // No cache, so that every search reads its pieces, and the reads of two searches can be compared.
      const files = createLargeFiles({ requireOwner: false, store: new Counting(directory), wholeDocumentBytes: 0, scanChunkBytes, cacheBytes: 0, budget: { inlineTokens: 10 } });
      const meta = await files.ingest({ name: "app.log", bytes: utf8(LOG) });
      const tools = files.tools([meta]);
      for (const [query, mode] of [["ERROR", "exact"], ["took 300ms", "exact"], [atPassage, "regex"]] as const) {
        for (const context_lines of [0, 5]) {
          const args = { query, mode, max_results: 1, context_lines };
          const ranged = await tools.execute("search_document", { document_id: meta.id, ...args });
          expect(ranged).toEqual(await whole.execute("search_document", { document_id: wholeMeta.id, ...args }));
        }
      }
      const ranged = await tools.execute("search_document", { document_id: meta.id, query: atPassage, mode: "regex", max_results: 1, context_lines: 3 });
      expect((ranged.matches as Array<{ line: number; before: string[] }>)[1]).toMatchObject({ line: start, before: [numbered(start - 3), numbered(start - 2), numbered(start - 1)] });
      const after = await tools.execute("search_document", { document_id: meta.id, query: beforePassage, mode: "regex", max_results: 1, context_lines: 3 });
      expect((after.matches as Array<{ line: number; after: string[] }>)[1]).toMatchObject({ line: start - 1, after: [numbered(start), numbered(start + 1), numbered(start + 2)] });
      // The lines around the last match come from the pieces as they are scanned: no read more than a search without them.
      for (const query of [atPassage, beforePassage]) {
        reads.count = 0;
        await tools.execute("search_document", { document_id: meta.id, query, mode: "regex", max_results: 1 });
        const without = reads.count;
        reads.count = 0;
        await tools.execute("search_document", { document_id: meta.id, query, mode: "regex", max_results: 1, context_lines: 3 });
        expect(reads.count).toBe(without);
      }
    }
  });

  it("carries its page in a PDF whose pages can be shown", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const text = [1, 2, 3, 4].flatMap((page) => [`--- Page ${page} ---`, `row ${page}.1 hit`, `row ${page}.2`, `row ${page}.3 hit`]).join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_pdf", name: "report.pdf" } as never, text });
    const tools = createDocumentTools({ load: async () => document, documentIds: ["doc_pdf"], viewableIds: ["doc_pdf"], loadOriginal: async () => undefined, budget: files.budget });
    const result = await tools.execute("search_document", { document_id: "doc_pdf", query: "hit", mode: "exact", max_results: 1 });
    expect(result.matches).toEqual([{ line: 2, page: 1, text: "row 1.1 hit" }, { line: 16, page: 4, text: "row 4.3 hit" }]);
  });

  it("stays when the result is cut to the room it has, and the note says so", async () => {
    const { tools, meta } = await inMemory();
    const args = { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 50, context_lines: 5 };
    const cut = (await tools.executeWithFiles("search_document", args, { maxResultCharacters: 8_000 })).result;
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(8_000);
    const lines = linesOf(cut);
    expect(lines.at(-1)).toBe(2910);
    expect(lines.slice(0, -1)).toEqual(ERROR_LINES.slice(0, lines.length - 1));
    expect(cut.note).toBe(`Showing ${lines.length} of the 30 matching lines to stay within the size limit: the first ${lines.length - 1} and the last (line 2910). To see the ones in between, search again with from_line ${lines.at(-2)! + 1}, or count them with group_by.`);
    expect(cut.next_from_line).toBe(lines.at(-2)! + 1);
    // Room for one match only: the last one, which no other search can show.
    const long = Array.from({ length: 10 }, (_, index) => `${index + 1} hit ${"x".repeat(300)}`).join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_long", name: "long.txt" } as never, text: long });
    const narrow = createDocumentTools({ load: async () => document, documentIds: ["doc_long"], budget: createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() }).budget });
    const only = (await narrow.executeWithFiles("search_document", { document_id: "doc_long", query: "hit", mode: "exact" }, { maxResultCharacters: 600 })).result;
    expect(JSON.stringify(only).length).toBeLessThanOrEqual(600);
    expect(linesOf(only)).toEqual([10]);
    expect(only.note).toBe("Showing 1 of the 10 matching lines to stay within the size limit: the last (line 10). Narrow the query or read specific lines.");
  });

  it("keeps its line when the room is too small for the note of a cut result", async () => {
    const budget = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() }).budget;
    const search = async (filler: string, width: number) => {
      const text = Array.from({ length: 10 }, (_, index) => `${index + 1} hit ${filler.repeat(width)}`).join("\n");
      const document = new SearchableDocument({ meta: { id: "doc_long", name: "long.txt" } as never, text });
      const tools = createDocumentTools({ load: async () => document, documentIds: ["doc_long"], budget });
      return (await tools.executeWithFiles("search_document", { document_id: "doc_long", query: "hit", mode: "exact" }, { maxResultCharacters: 600 })).result;
    };
    // The last match fits, but not with the note above: a shorter note, never "1 of 1 results".
    // 700 is a line clipped to the longest a match shows.
    for (const width of [380, 700]) {
      const result = await search("x", width);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(600);
      expect(result).toMatchObject({ total_matching_lines: 10, note: "Showing 1 of the 10 matching lines: the last (line 10). Narrow the search." });
      expect(linesOf(result)).toEqual([10]);
    }
    // Nothing fits whole: the result is cut as text, and still names the line of the last match.
    const cut = await search("\"", 300);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(600);
    expect(cut).toMatchObject({ truncated: true, note: "Result cut to the size limit. Ask for a smaller range." });
    expect(String(cut.partial)).toContain("Showing 1 of the 10 matching lines: the last (line 10).");
  });

  it("is pointed to when the same search is made again, unless it was cut to the room it had", async () => {
    const { tools, meta } = await inMemory();
    const call = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const result = await tools.execute(call.name, call.args);
    expect(alreadyShown(call, { call, result })).toMatchObject({ already_shown: true });
    const cut = (await tools.executeWithFiles(call.name, call.args, { maxResultCharacters: 1_500 })).result;
    expect(String(cut.note)).toMatch(/^Showing /);
    expect(alreadyShown(call, { call, result: cut })).toBeUndefined();
  });

  it("is not claimed when the scan stopped early", async () => {
    // Twelve lines that match at once, then one the pattern cannot get past.
    const text = [...Array.from({ length: 12 }, (_, index) => `line ${index + 1} a`), `${"a".repeat(40)}!`, "end a"].join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_t", name: "trap.txt" } as never, text });
    const result = grep(document, "(a|a)+$", { regex: true, maxResults: 3, contextLines: 1, timeLimitMs: 150 });
    expect(result.stoppedEarly).toBe(true);
    expect(result.totalMatchingLines).toBeGreaterThanOrEqual(12);
    expect(result.last).toBeUndefined();
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const tools = createDocumentTools({ load: async () => document, documentIds: ["doc_t"], budget: files.budget, regexBudgetMs: 150 });
    const found = await tools.execute("search_document", { document_id: "doc_t", query: "(a|a)+$", mode: "regex", max_results: 3 });
    expect(linesOf(found)).toEqual([1, 2, 3]);
    expect(found.note).toBe("The scan stopped early; the total is a lower bound, and the last match in the file is not known.");
  });

  it("is not claimed when the scan stopped early and the result was cut to its room either", async () => {
    // Twenty long lines that match at once, then one the pattern cannot get past.
    const text = [...Array.from({ length: 20 }, (_, index) => `line ${index + 1} ${"x".repeat(80)} a`), `${"a".repeat(40)}!`, "end a"].join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_t", name: "trap.txt" } as never, text });
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const tools = createDocumentTools({ load: async () => document, documentIds: ["doc_t"], budget: files.budget, regexBudgetMs: 150 });
    const call = { name: "search_document", args: { document_id: "doc_t", query: "(a|a)+$", mode: "regex", context_lines: 3 } };
    const cut = (await tools.executeWithFiles(call.name, call.args, { maxResultCharacters: 2_000 })).result;
    const shown = linesOf(cut).length;
    expect(shown).toBeLessThan(20);
    expect(cut.note).toBe(`The scan stopped early; the total is a lower bound, and the last match in the file is not known. Showing ${shown} of 20 results to stay within the size limit. Narrow the query or read specific lines.`);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(2_000);
    // A call made again may get more.
    expect(alreadyShown(call, { call, result: cut })).toBeUndefined();
  });
});

describe("the search tool's description", () => {
  it("does not say that every line is returned, and says which are", async () => {
    const { tools } = await inMemory();
    const description = tools.declarations.find((declaration) => declaration.name === "search_document")!.description;
    expect(description).not.toMatch(/every line/);
    expect(description).toContain("total_matching_lines counts every matching line, and the result shows the first max_results of them and the last one;");
  });
});

describe("step text", () => {
  it("says one line, passage or part in the singular", () => {
    expect(toolResultSummary("label", { total_matching_lines: 1 })).toBe(" — 1 matching line");
    expect(toolResultSummary("label", { total_matching_lines: 0 })).toBe(" — 0 matching lines");
    expect(toolResultSummary("label", { total_matching_lines: 1_203 })).toBe(" — 1,203 matching lines");
    expect(toolResultSummary("label", { passages: [{ text: "x" }] })).toBe(" — 1 passage");
    expect(toolResultSummary("label", { passages: [] })).toBe(" — 0 passages");
    expect(toolResultSummary("label", { parts_read: 1, parts_with_relevant_content: 1 })).toBe(" — 1 part, 1 relevant");
    expect(toolResultSummary("label", { parts_read: 9, parts_with_relevant_content: 3, notes_only: true })).toBe(" — 9 parts, 3 relevant, notes only");
  });
});
