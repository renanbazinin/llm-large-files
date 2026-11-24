// Inline tables with tools, the planning side (P1): `PrepareOptions.inlineTables: "tools"` lists in
// `toolable` the files sent whole whose tables the tools can count: a CSV or a workbook always, a
// document of another format that aggregate_table reads when its text has at least 3 `| cell |`
// rows. With "text", the default, `prepare` gives what 0.9 gave.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { serviceLog, utf8 } from "llm-large-files/testing";
import { hasPipeRows, INLINE_TABLES_LINE, isToolable, questionTools, toolGuide } from "../src/plan.js";
import { p, word, zip } from "./word-fixtures.js";

const base = { tokens: 0, bytes: 0 };

/** probe4's CSV: 3,000 invoices in Hebrew, 750 of them late. */
function invoices(): string {
  const statuses = ["שולם", "באיחור", "בוטל", "פתוח"];
  const rows = ["מספר,לקוח,סכום,סטטוס,תאריך"];
  for (let i = 1; i <= 3000; i++) rows.push(`${i},לקוח ${i % 211},${(i * 7919) % 50000}.${i % 100},${statuses[(i * 7) % 4]},2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
  return rows.join("\n");
}

const cell = (text: string) => `<w:tc>${p(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;

/** A Hebrew policy in Word with a table of three rows. */
const hebrewDocx = () => word([
  p("נוהל החזר הוצאות"),
  p("הטבלה מפרטת את התקרות לפי סוג ההוצאה."),
  `<w:tbl>${row("סוג", "תקרה")}${row("נסיעות", "500")}${row("ארוחות", "120")}</w:tbl>`,
].join(""));

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const drawingCell = (text: string) => `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;

/** A deck of one slide with a table of three rows. */
const deckWithTable = () => zip({
  "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
  "ppt/slides/slide1.xml": `<p:sld ${P}><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl>${[["אזור", "מכירות"], ["צפון", "10"], ["דרום", "12"]].map((cells) => `<a:tr>${cells.map(drawingCell).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
});

describe("files sent whole whose tables the tools count (inlineTables)", () => {
  it("lists probe4's CSV, sent whole, with the tools that count it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices()) });
    const prepared = await files.prepare([meta.id], base, { inlineTables: "tools" });
    expect(prepared.plan.inline.map((document) => document.id)).toEqual([meta.id]);
    expect(prepared.toolable?.map((document) => document.id)).toEqual([meta.id]);
    // An inline-only question: search, read and aggregate_table, not the overview or a whole read.
    expect(prepared.placement?.tools).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(prepared.guide).toContain(INLINE_TABLES_LINE);
    expect(prepared.guide).toContain("use aggregate_table");
    expect(prepared.guide).not.toContain("analyze_whole_document");
    expect(prepared.guide).not.toContain("get_document_overview");
    // The blocks and the instruction stay those of "text".
    const text = await files.prepare([meta.id], base);
    expect(prepared.instruction).toBe("");
    expect([...prepared.blocks]).toEqual([...text.blocks]);
  });

  it("gives no toolable list for \"text\", the default", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices()) });
    for (const prepared of [await files.prepare([meta.id], base), await files.prepare([meta.id], base, { inlineTables: "text" })]) {
      expect(prepared.toolable).toBeUndefined();
      expect(prepared.instruction).toBe("");
      expect(prepared.placement?.tools).toEqual([]);
      expect(prepared.guide).toBe("");
    }
  });

  it("lists a Hebrew Word file and a deck whose tables have three rows", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const docx = await files.ingest({ name: "נוהל.docx", bytes: await hebrewDocx() });
    const pptx = await files.ingest({ name: "מצגת.pptx", bytes: await deckWithTable() });
    const markdown = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n") });
    const html = await files.ingest({ name: "page.html", bytes: utf8("<html><body><table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table></body></html>") });
    const ids = [docx.id, pptx.id, markdown.id, html.id];
    const prepared = await files.prepare(ids, base, { inlineTables: "tools" });
    expect(prepared.plan.inline).toHaveLength(4);
    expect(prepared.toolable?.map((document) => document.id).sort()).toEqual([...ids].sort());
  });

  it("leaves out a table of two rows, a text file's rows, and a file that is searched", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 5_000 } });
    const short = await files.ingest({ name: "short.md", bytes: utf8("| a | b |\n| --- | --- |\n| 1 | 2 |\n") });
    const plain = await files.ingest({ name: "rows.txt", bytes: utf8("| a | b |\n| 1 | 2 |\n| 3 | 4 |\n") });
    const big = await files.ingest({ name: "big.csv", bytes: utf8(invoices()) });
    const prepared = await files.prepare([short.id, plain.id, big.id], base, { inlineTables: "tools" });
    expect(prepared.plan.inline.map((document) => document.id).sort()).toEqual([short.id, plain.id].sort());
    expect(prepared.toolable).toEqual([]);
    // The CSV is searched: the tools of 0.9 for it.
    expect(prepared.placement?.tools).toEqual(["search_document", "read_document", "get_document_overview", "aggregate_table", "analyze_whole_document"]);
  });

  it("counts rows by the rule aggregate_table reads them with", () => {
    expect(hasPipeRows("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(false);
    expect(hasPipeRows("| a | b |\n| --- | :---: |\n| 1 | 2 |\n| 3 | 4 |")).toBe(true);
    expect(hasPipeRows("  | a |  \n|b|\n|c|")).toBe(true);
    expect(hasPipeRows("| a\nb |\n|\n| c | d |")).toBe(false);
    expect(hasPipeRows("text | with | pipes\n| x |\n| y |")).toBe(false);
    expect(hasPipeRows("| a |\n| b |", 2)).toBe(true);
    expect(isToolable("csv", "")).toBe(true);
    expect(isToolable("xlsx", "")).toBe(true);
    expect(isToolable("docx", "| a |\n| b |\n| c |")).toBe(true);
    expect(isToolable("pdf", "| a |\n| b |")).toBe(false);
    expect(isToolable("text", "| a |\n| b |\n| c |")).toBe(false);
    expect(isToolable("log", serviceLog(10))).toBe(false);
  });

  it("declares, for a question, the tools its documents need, in today's order", () => {
    const csv = { format: "csv" } as never;
    const log = { format: "log" } as never;
    const pdf = { format: "pdf" } as never;
    expect(questionTools({ searchable: [] }, true)).toEqual([]);
    expect(questionTools({ searchable: [], toolable: [csv] }, true)).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(questionTools({ searchable: [log] }, true)).toEqual(["search_document", "read_document", "get_document_overview", "analyze_whole_document"]);
    expect(questionTools({ searchable: [log], toolable: [csv], viewable: [pdf] }, false)).toEqual(["search_document", "read_document", "get_document_overview", "aggregate_table", "view_pages"]);
    expect(questionTools({ searchable: [], viewable: [pdf] }, true)).toEqual(["view_pages"]);
    expect(toolGuide(["search_document", "read_document", "aggregate_table"], { fullTables: true }).split("\n")[0]).toBe(INLINE_TABLES_LINE);
  });
});
