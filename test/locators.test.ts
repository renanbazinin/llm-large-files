// CIT-1 and CIT-5 (0.99.14): where a cited line is in the original file. The fixtures and their
// expected places come from the independent ground truth of specs/01-locators (built from the
// original bytes, not from this code): test/fixtures/locators/expected.json. Each file is ingested
// here, and read both as a new upload (with the 0.99.14 meta fields) and as a document stored by
// 0.99.12 (without them).
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { aggregateSideOf, claimAround, deriveLocatorTables, locatorOfLine, locatorsOfRange, numberingOf, resolveCitation, type CitationToResolve, type LocatorTables } from "../src/locators.js";
import type { SourceLocator } from "../src/sources.js";
import { buildTextIndex } from "../src/text-index.js";
import type { DocumentMeta } from "../src/types.js";

type Expect = { kind: string; sheet?: string; excelRow?: number; line?: number; headings?: string[]; clause?: string; slide?: number; notes?: boolean; page?: number };
type Expected = {
  files: Record<string, { file: string; name: string; format: string; textLines: number }>;
  tests: Array<{ id: string; doc: string; line: number; anchor: string; expect: Expect; status: string }>;
  manyTests: Array<{ id: string; line: number; anchor: string; expect: Expect }>;
};
const fixture = (name: string) => new URL(`./fixtures/locators/${name}`, import.meta.url);
const expected = JSON.parse(readFileSync(fixture("expected.json"), "utf8")) as Expected;

/** The places the truth itself calls coarse by rule zero for a document stored by 0.99.12, and with the 0.99.14 meta fields. */
const COARSER_V1 = new Set(["long-record-part1", "long-record-part2", "long-record-after", "events-line4-part1", "events-line4-part2", "events-line4-part3", "events-line3", "events-line5", "events-line10", "deck-mention-the-budget", "deck-ask-the-board", "deck-only-if-asked", "docx-background1", "docx-background198", "docx-background355", "docx-background420", "deck-marker-slide1", "deck-marker-slide3"]);
const COARSER_V2 = new Set(["docx-background1", "docx-background198", "docx-background355", "docx-background420", "deck-marker-slide1", "deck-marker-slide3"]);

/** The locator names exactly the truth's place (at the granularity a SourceLocator has). */
function exact(want: Expect, got: SourceLocator): boolean {
  switch (want.kind) {
    case "row":
      return got.kind === "row" && got.row === want.excelRow && got.toRow === undefined && (want.sheet === undefined || got.sheet === want.sheet);
    case "sheet":
      return got.kind === "sheet" && got.sheet === want.sheet;
    case "page":
      return got.kind === "page" && got.page === want.page;
    case "slide":
      return got.kind === "slide" && got.slide === want.slide && Boolean(got.notes) === Boolean(want.notes);
    case "document":
      return got.kind === "document";
    case "clause":
      return got.kind === "section" && got.numbering === want.clause && (want.headings === undefined || JSON.stringify(got.headings ?? []) === JSON.stringify(want.headings));
    case "heading":
      return got.kind === "section" && JSON.stringify(got.headings) === JSON.stringify(want.headings) && got.numbering === undefined;
    case "line":
      // A Markdown line: its section (the line itself travels in the source's from/to).
      if (want.headings) return got.kind === "section" && JSON.stringify(got.headings) === JSON.stringify(want.headings) && got.numbering === want.clause;
      return got.kind === "line" && got.line === want.line;
    default:
      return false;
  }
}

/** The locator holds the truth's place but names less of it (never another place). */
function coarser(want: Expect, got: SourceLocator): boolean {
  if (got.kind === "document") return true;
  if (want.kind === "slide") return got.kind === "slide" && got.slide === want.slide && !got.notes;
  if (want.kind === "row") return got.kind === "sheet" && got.sheet === want.sheet;
  if (want.kind === "line") return got.kind === "line" && got.line === undefined;
  if (want.kind === "clause" || want.kind === "line") return got.kind === "section" && got.numbering === undefined;
  return false;
}

async function ingestAll() {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, requireOwner: false });
  const out: Record<string, { meta: DocumentMeta; text: string }> = {};
  for (const [id, file] of Object.entries(expected.files)) {
    const meta = await files.ingest({ id, name: file.name, bytes: new Uint8Array(readFileSync(fixture(file.file))) });
    out[id] = { meta, text: (await store.get(id))!.text };
  }
  const sheet = (rows: Array<[string, string | number]>) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map(([a, b], i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${a}</t></is></c><c r="B${i + 1}"${typeof b === "number" ? "" : ' t="inlineStr"'}>${typeof b === "number" ? `<v>${b}</v>` : `<is><t>${b}</t></is>`}</c></row>`).join("")}</sheetData></worksheet>`;
  const zip = new JSZip();
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const names = Array.from({ length: 450 }, (_, k) => `S${String(k + 1).padStart(3, "0")}`);
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  names.forEach((_, k) => zip.file(`xl/worksheets/sheet${k + 1}.xml`, sheet([["Key", "Value"], k + 1 === 100 || k + 1 === 200 ? ["dup", 1] : [`K${k + 1}`, (k + 1) * 7]])));
  const meta = await files.ingest({ id: "syn-many", name: "many-sheets.xlsx", bytes: await zip.generateAsync({ type: "uint8array" }) });
  out["syn-many"] = { meta, text: (await store.get("syn-many"))!.text };
  return out;
}
const documents = await ingestAll();

/** As a document stored by 0.99.12: without the fields 0.99.14 records. */
const asStoredBefore = (meta: DocumentMeta): DocumentMeta => {
  const { lineSplits: _splits, notesLines: _notes, textVersion: _version, ...rest } = meta;
  return rest;
};
const tablesOf = (id: string, mode: "v1" | "v2"): LocatorTables => {
  const { meta, text } = documents[id]!;
  return deriveLocatorTables({ meta: mode === "v1" ? asStoredBefore(meta) : meta, text, ...(meta.format === "pdf" ? { pageStarts: buildTextIndex(text).pageStarts } : {}) });
};

describe("ingest records what locators need (0.99.14)", () => {
  it("writes textVersion 1, the pieces of split lines, and a deck's real notes markers", () => {
    for (const { meta } of Object.values(documents)) expect(meta.textVersion).toBe(1);
    expect(documents["syn-long-row"]!.meta.lineSplits).toEqual([6]);
    expect(documents["syn-long-record"]!.meta.lineSplits).toEqual([4]);
    expect(documents["syn-events"]!.meta.lineSplits).toEqual([5, 6]);
    expect(documents["syn-events"]!.meta.wrappedLines).toBe(1);
    // Slide 2's own text says "[Speaker notes]" (line 9 or so): only slides 1 and 3 have notes.
    expect(documents["syn-deck"]!.meta.notesLines).toEqual([4, 16]);
    const lines = documents["syn-deck"]!.text.split("\n");
    expect(lines.filter((line) => line === "[Speaker notes]").length).toBe(3);
    for (const id of ["syn-book", "syn-records", "syn-headings-md", "syn-pdf"]) {
      expect(documents[id]!.meta.lineSplits).toBeUndefined();
      expect(documents[id]!.meta.notesLines).toBeUndefined();
    }
  });
});

describe("locatorOfLine against the ground truth", () => {
  for (const mode of ["v1", "v2"] as const) {
    it(`gives every expected place, coarser only where rule zero says (${mode === "v1" ? "stored by 0.99.12" : "new upload"})`, () => {
      const allowed = mode === "v1" ? COARSER_V1 : COARSER_V2;
      const wrong: string[] = [];
      let exactCount = 0;
      for (const test of expected.tests) {
        const t = tablesOf(test.doc, mode);
        expect(t.lines?.[test.line - 1]?.startsWith(test.anchor.slice(0, 40))).toBe(true);
        const got = locatorOfLine(t, test.line).locator;
        if (exact(test.expect, got)) exactCount++;
        else if (!(allowed.has(test.id) && coarser(test.expect, got)) && !(test.status === "coarser" && coarser(test.expect, got))) wrong.push(`${test.id}: ${JSON.stringify(got)} for ${JSON.stringify(test.expect)}`);
      }
      expect(wrong).toEqual([]);
      expect(exactCount).toBeGreaterThanOrEqual(expected.tests.length - (mode === "v1" ? allowed.size : COARSER_V2.size));
    });
  }

  it("names the right sheet of 450 (no outline cap)", () => {
    const t = tablesOf("syn-many", "v2");
    for (const test of expected.manyTests) expect(exact(test.expect, locatorOfLine(t, test.line).locator), test.id).toBe(true);
    // Without the text, the capped outline is not used: the file, never sheet 8 for sheet 9.
    expect(deriveLocatorTables({ meta: documents["syn-many"]!.meta }).sheets.length).toBe(0);
  });

  it("a newer text version gives the sheet only", () => {
    const { meta, text } = documents["syn-book"]!;
    const t = deriveLocatorTables({ meta: { ...meta, textVersion: 2 }, text });
    const line = text.split("\n").findIndex((one) => one.startsWith("Row 8: | Center")) + 1;
    expect(locatorOfLine(t, line).locator).toEqual({ kind: "sheet", sheetIndex: 1, sheet: "Summary" });
  });

  it("a range across two sheets gives one part per sheet; past the end is unresolved", () => {
    const t = tablesOf("syn-book", "v2");
    const lines = documents["syn-book"]!.text.split("\n");
    const from = lines.findIndex((one) => one.startsWith("Row 8: | Center")) + 1;
    const to = lines.findIndex((one) => one.includes("ORD-1008 |")) + 1;
    const range = locatorsOfRange(t, from, to);
    expect(range.reason).toBe("range_across_sheets");
    expect(range.locators).toEqual([
      { kind: "row", sheetIndex: 1, sheet: "Summary", row: 8, toRow: 12 },
      { kind: "row", sheetIndex: 2, sheet: "Data", row: 1, toRow: 8 },
    ]);
    expect(locatorsOfRange(t, 9999, 9999)).toMatchObject({ unresolved: true, reason: "past_end" });
  });

  it("reads a clause number only from the line's own prefix", () => {
    expect(numberingOf("3.1 Payment terms")).toBe("3.1");
    expect(numberingOf("(ב) the second")).toBe("ב");
    expect(numberingOf("סעיף 7: קנס")).toBe("7");
    expect(numberingOf("Payment is due")).toBeUndefined();
  });
});

describe("resolveCitation (CIT-1, CIT-5, option B)", () => {
  const book = tablesOf("syn-book", "v2");
  const bookLines = documents["syn-book"]!.text.split("\n");
  const lineWith = (text: string) => bookLines.findIndex((one) => one.includes(text)) + 1;
  const cite = (from: number, form: "line" | "row", written: string, to = from): CitationToResolve => ({ documentId: "syn-book", ids: ["syn-book"], from, to, form, written });
  const resolve = (answer: string, citation: CitationToResolve, extra: Partial<Parameters<typeof resolveCitation>[0]> = {}) => {
    const start = answer.indexOf("(");
    const end = answer.indexOf(")") + 1;
    return resolveCitation({ citation, claim: claimAround(answer, start, end, [{ rawStart: start, rawEnd: end }]), group: [citation], tablesOf: (id) => (id === "syn-book" ? book : undefined), ...extra });
  };

  it("English Row N is Excel's row; in two sheets the claim's cells decide, else ambiguous", () => {
    expect(resolve("The largest early order is ORD-1008 for Customer 8, 888 (book.xlsx Row 8).", cite(8, "row", "Row 8"))).toMatchObject({ status: "resolved", locators: [{ kind: "row", sheet: "Data", row: 8 }], reason: "english_row_sheet_by_cells" });
    expect(resolve("The workbook has a row for it (book.xlsx Row 8).", cite(8, "row", "Row 8"))).toMatchObject({ status: "ambiguous", locators: [{ kind: "document" }], reason: "english_row_in_several_sheets" });
  });

  it("Hebrew שורה N: Excel's row N when its cells match the claim", () => {
    expect(resolve("במרכז היו 1104 ברבעון 1 (שורה 8).", cite(8, "row", "שורה 8"))).toMatchObject({ status: "resolved", locators: [{ kind: "row", sheet: "Summary", row: 8 }] });
  });

  it("the hidden row is an ordinary row (HIDDEN-ROWS)", () => {
    const line = lineWith("Hidden adjustment |");
    expect(resolve(`The hidden adjustment is 7777 (book.xlsx L${line}).`, cite(line, "line", `L${line}`))).toMatchObject({ status: "resolved", locators: [{ kind: "row", sheet: "Notes", row: 5 }] });
  });

  it("an L-number whose row contradicts the claim gives the sheet only (option B)", () => {
    // Text line 8 is another Summary row (the heading and Columns lines come first); Excel row 8 is Center 1104.
    const literal = locatorOfLine(book, 8).locator;
    expect(literal).toMatchObject({ kind: "row", sheet: "Summary" });
    expect((literal as { row: number }).row).not.toBe(8);
    const result = resolve("Center had 1104 in Q1 (book.xlsx L8).", cite(8, "line", "L8"));
    expect(result).toMatchObject({ status: "ambiguous", reason: "l_number_contradicts_claim", locators: [{ kind: "sheet", sheet: "Summary" }] });
    expect(result !== "pending" && result.candidates?.length).toBe(2);
  });

  it("lines that are one aggregate group's samples, after its number, give the sheet (computed over sheet)", () => {
    const rows = [lineWith("ORD-1002 |"), lineWith("ORD-1003 |"), lineWith("ORD-1004 |")];
    const side = aggregateSideOf("call_1", "syn-book", { document: "book.xlsx", table: "Sheet 2: Data", groups: [{ count: 38, lines: rows }] })!;
    expect(side).toEqual({ callId: "call_1", documentId: "syn-book", groups: [{ values: [38], lines: rows }] });
    const answer = `There are 38 orders (book.xlsx L${rows[0]}, L${rows[1]}, L${rows[2]}).`;
    const group = rows.map((line) => cite(line, "line", `L${line}`));
    const run = (text: string) => resolveCitation({ citation: group[0]!, claim: claimAround(text, text.indexOf("("), text.indexOf(")") + 1, []), group, tablesOf: () => book, aggregates: [side] });
    expect(run(answer)).toMatchObject({ locators: [{ kind: "sheet", sheet: "Data" }], reason: "computed_over_sheet", basis: "tool", callId: "call_1" });
    // An example lead-in: each line gets its row.
    expect(run(`There are 38 orders, for example (book.xlsx L${rows[0]}, L${rows[1]}, L${rows[2]}).`)).toMatchObject({ locators: [{ kind: "row", row: 2 }] });
  });

  it("two files of one name: the content check picks one, else ambiguous; a missing table is pending", () => {
    const a = tablesOf("dup-a", "v2");
    const b = tablesOf("dup-b", "v2");
    const citation: CitationToResolve = { documentId: "dup-a", ids: ["dup-a", "dup-b"], from: 3, to: 3, form: "line", written: "L3" };
    const tables = (id: string) => (id === "dup-a" ? a : id === "dup-b" ? b : undefined);
    const claim = (text: string) => claimAround(text, text.indexOf("("), text.indexOf(")") + 1, []);
    expect(resolveCitation({ citation, claim: claim("Revenue was 250 thousand (report.md L3)."), group: [citation], tablesOf: tables })).toMatchObject({ documentId: "dup-b", status: "resolved" });
    expect(resolveCitation({ citation, claim: claim("Revenue is listed (report.md L3)."), group: [citation], tablesOf: tables })).toMatchObject({ status: "ambiguous", reason: "name_shared_content_none" });
    expect(resolveCitation({ citation, claim: claim("x (report.md L3)."), group: [citation], tablesOf: () => undefined })).toBe("pending");
  });

  it("a CSV row counts records, not lines: a quoted line break and a blank line", () => {
    const t = tablesOf("syn-records", "v2");
    for (const test of expected.tests.filter((one) => one.doc === "syn-records")) expect(exact(test.expect, locatorOfLine(t, test.line).locator), test.id).toBe(true);
  });
});
