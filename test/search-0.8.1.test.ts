import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type ToolResult } from "../src/index.js";
import { utf8 } from "./fake-model.js";

const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
type Match = { line: number; section?: string; text: string };
const matchesOf = (result: ToolResult) => result.matches as Match[];

describe("where a search hit sits", () => {
  it("gives the header row of a CSV file with its hits", async () => {
    const csv = ["Region,Month,Revenue", ...Array.from({ length: 200 }, (_, index) => `${index % 2 ? "East" : "West"},2026-01,${index}`)].join("\n");
    const meta = await files.ingest({ name: "sales.csv", bytes: utf8(csv) });
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "East", mode: "exact", max_results: 3 });
    expect(result.table_headers).toEqual([{ line: 1, text: "Region,Month,Revenue" }]);
    expect(matchesOf(result)[0]!.section).toBeUndefined();
  });

  it("gives the first row of each sheet a hit is in, and the sheet as its section", async () => {
    const text = ["## Sheet 1: North", "Columns: | A | B |", "Row 1: | City | Amount |", "Row 2: | Haifa | 10 |", "", "## Sheet 2: South", "Columns: | A | B |", "Row 1: | City | Amount |", "Row 2: | Eilat | 20 |", "Row 3: | Beersheba | 30 |"].join("\n");
    const own = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 }, extractors: { xlsx: async () => ({ text }) } });
    const meta = await own.ingest({ name: "cities.xlsx", bytes: utf8("PK") });
    const result = await own.tools([meta]).execute("search_document", { document_id: meta.id, query: "\\| \\d0 \\|", mode: "regex" });
    expect(result.table_headers).toEqual([{ line: 3, text: "Row 1: | City | Amount |" }, { line: 8, text: "Row 1: | City | Amount |" }]);
    expect(matchesOf(result).map((match) => [match.line, match.section])).toEqual([[4, "Sheet 1: North"], [9, "Sheet 2: South"], [10, "Sheet 2: South"]]);
  });

  it("gives the first row of a | cell | table, and the heading above a hit", async () => {
    const text = ["# Contract", "", "## 2.1 Rent", "The rent is paid monthly.", "", "| Year | Rent |", "| --- | --- |", "| 2027 | 4,750 |", "| 2028 | 4,900 |", "", "## 3. Term", "The term is 24 months."].join("\n");
    const meta = await files.ingest({ name: "lease.md", bytes: utf8(text) });
    const rent = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "4,900", mode: "exact" });
    expect(rent.table_headers).toEqual([{ line: 6, text: "| Year | Rent |" }]);
    expect(matchesOf(rent)).toEqual([{ line: 9, section: "2.1 Rent", text: "| 2028 | 4,900 |" }]);
    const term = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "24 months", mode: "exact" });
    expect(term.table_headers).toBeUndefined();
    expect(matchesOf(term)[0]!.section).toBe("3. Term");
  });

  it("gives no section in a log, and no header for a row that is the table's first", async () => {
    const log = await files.ingest({ name: "app.log", bytes: utf8("2026-01-01 10:00:00 ERROR a\n".repeat(30)) });
    const result = await files.tools([log]).execute("search_document", { document_id: log.id, query: "ERROR", mode: "exact", max_results: 2 });
    expect(matchesOf(result).every((match) => match.section === undefined)).toBe(true);
    expect(result.table_headers).toBeUndefined();
    const table = await files.ingest({ name: "t.md", bytes: utf8("| Year | Rent |\n| 2027 | 1 |\n") });
    const first = await files.tools([table]).execute("search_document", { document_id: table.id, query: "Year", mode: "exact" });
    expect(first.table_headers).toBeUndefined();
  });
});

describe("a large document held in memory (LLF-044)", () => {
  it("is searched in pieces, with the results of one scan, letting other work run", async () => {
    const { grep, grepSource, rankPassages, rankSource, SearchableDocument } = await import("../src/search.js");
    const text = Array.from({ length: 160_000 }, (_, index) => `2026-01-01 10:00:${String(index % 60).padStart(2, "0")} ${index % 13 === 0 ? "ERROR payment declined" : "INFO request served"} id=${index}`).join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_m", name: "m.log", outline: [] } as never, text });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const exact = await grepSource(document, "ERROR", { maxResults: 5, contextLines: 1 });
    const keywords = await rankSource(document, "payment declined", 3);
    const last = await grepSource(document, "declined", { maxResults: 2, contextLines: 0, order: "last" });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(exact).toEqual(grep(document, "ERROR", { maxResults: 5, contextLines: 1 }));
    expect(keywords).toEqual(rankPassages(document, "payment declined", 3));
    expect(last.matches.map((match) => match.line)).toEqual([159_979, 159_992]);
  });
});

describe("the format of a file whose name says nothing", () => {
  it("is found from its bytes: PDF, DOCX, XLSX, HTML; a .txt stays text", async () => {
    const { default: JSZip } = await import("jszip");
    const { detectFormat } = await import("../src/extract.js");
    const { numberedPdf } = await import("./pdf-fixtures.js");
    const zip = async (part: string) => {
      const archive = new JSZip();
      archive.file("[Content_Types].xml", "<Types/>");
      archive.file(part, "<x/>");
      return archive.generateAsync({ type: "uint8array" });
    };
    expect(detectFormat("upload", "application/octet-stream", numberedPdf(1))).toBe("pdf");
    expect(detectFormat("upload", "", await zip("word/document.xml"))).toBe("docx");
    expect(detectFormat("upload", "", await zip("xl/workbook.xml"))).toBe("xlsx");
    expect(detectFormat("upload", "", await zip("ppt/presentation.xml"))).toBe("pptx");
    expect(detectFormat("page", "", utf8("﻿  <!DOCTYPE html><html><body>x</body></html>"))).toBe("html");
    expect(detectFormat("notes.txt", "", numberedPdf(1))).toBe("text");
    expect(detectFormat("readme", "", utf8("How to read a %PDF- header"))).toBe("text");
    // Ingest reads it as what it is.
    const meta = await files.ingest({ name: "report", bytes: numberedPdf(2) });
    expect(meta.format).toBe("pdf");
  });
});
