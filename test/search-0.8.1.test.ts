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

describe("the quality of a document's text, on its card", () => {
  it("names the pages without text and those that look garbled, and the scripts of the text", async () => {
    const page = (number: number, body: string) => `--- Page ${number} ---\n${body}`;
    const text = [
      page(1, "חוזה שכירות בין הצדדים, לתקופה של עשרים וארבעה חודשים, החל מיום 1.1.2027."),
      page(2, "[No text on this page. It may be a scan, a photo, or a chart.]"),
      page(3, "ÞÞÞ ¶¶¶ ÞÞ ¶¶ ÞÞÞÞ ¶¶ ÞÞÞ ¶¶¶ ÞÞ ¶¶ ÞÞÞÞ ¶¶ ÞÞÞ ¶¶¶ ÞÞ ¶¶ ÞÞÞÞ ¶¶ ÞÞÞ ¶¶¶ ÞÞ ¶¶ ÞÞÞÞ ¶¶".replace(/[Þ¶]/g, (c) => (c === "Þ" ? "§" : "¶"))),
      page(4, "�".repeat(20) + " some words here and there to fill the page with characters"),
      page(5, ["השוכר ישלם דמי שכירות חודשיים בסך 4,750 ש\"ח, כולל מע\"מ.", "Payment by bank transfer to the account of ACME Ltd."].join("\n")),
    ].join("\n\n").repeat(1);
    const own = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 }, extractors: { pdf: async () => ({ text: text + "\n" + "השוכר ".repeat(60), pages: 5 }) } });
    const meta = await own.ingest({ name: "lease.pdf", bytes: utf8("%PDF-1.4") });
    expect(meta.pagesWithoutText).toEqual([2]);
    expect(meta.garbledPages).toEqual([3, 4]);
    expect(meta.scripts?.[0]?.script).toBe("Hebrew");
    expect(meta.scripts?.some((share) => share.script === "Latin")).toBe(true);
    const card = (await own.prepare([meta.id], { tokens: 0, bytes: 0 })).blocks.get(meta.id)!;
    expect(card).toContain("Pages without text (scans, photos or charts, whose content is not in the text): 2.");
    expect(card).toContain("Pages whose text looks garbled, not to be relied on: 3, 4.");
    expect(card).toMatch(/Written in: Hebrew \d+%, Latin \d+%\. Search in the language of the text\./);
  });

  it("says nothing for a clean English text", async () => {
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe meeting was moved to Friday afternoon, after the review.\n".repeat(40)) });
    expect(meta.pagesWithoutText).toBeUndefined();
    expect(meta.garbledPages).toBeUndefined();
    expect(meta.scripts).toBeUndefined();
  });
});

describe("table headers of many hits", () => {
  it("finds the header of each of two long tables once", async () => {
    const table = (name: string, rows: number) => [`| ${name} | Amount |`, ...Array.from({ length: rows }, (_, index) => `| item ${index} | ${index % 5 === 0 ? "hit" : "x"} |`)];
    const text = ["# Report", ...table("First", 400), "", "Between the tables.", "", ...table("Second", 400)].join("\n");
    const meta = await files.ingest({ name: "two.md", bytes: utf8(text) });
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "| hit |", mode: "exact", max_results: 50 });
    expect(result.table_headers).toEqual([{ line: 2, text: "| First | Amount |" }, { line: 406, text: "| Second | Amount |" }]);
  });
});
