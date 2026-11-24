import "./load-pdf-libraries.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLargeFiles, createPdfExtractor, defaultExtractors, MemoryDocumentStore, type DocumentMeta, type Extractor } from "llm-large-files";
import { buildOutline } from "../src/analyze.js";
import { PdfHeadingFinder } from "../src/pdf-outline.js";
import type { PdfTextItem } from "../src/pdf-layout.js";
import { hebrewLease, paint, PdfBuilder, pdfWithSizedLines, type SizedLine } from "./pdf-fixtures.js";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/pdf/${name}.pdf`, import.meta.url)));
const body = (text: string): SizedLine => ({ text, size: 11 });

/** An English report: a title, numbered and unnumbered headings in two sizes, a small running footer. */
function englishReport(): Uint8Array {
  const page = (number: number, lines: SizedLine[]): SizedLine[] => [...lines, { text: `Page ${number} of 2`, size: 9 }];
  return pdfWithSizedLines([
    page(1, [
      { text: "Annual Maintenance Review", size: 24 },
      body("This review covers the maintenance work done on the three sites"), body("during the year, and the plans for the next one."),
      { text: "Background", size: 16 },
      body("The sites were inspected twice, in the spring and in the autumn,"), body("and each inspection was written up by the site manager."),
      { text: "2.1 Methods of inspection", size: 13 },
      body("Each roof, wall and drain was checked against the same list."),
    ]),
    page(2, [
      { text: "Findings", size: 16 },
      body("Most of the repairs found in the spring were done by the autumn,"), body("but the east wall of the second site still needs work."),
      { text: "Costs by site", size: 13 },
      body("The repairs cost less than planned, mostly because of the mild winter."),
    ]),
  ]);
}

/** The outline as [line, level, title], and the check that each heading is the line it points to. */
function outlineOf(meta: DocumentMeta, text: string): Array<[number, number, string]> {
  const lines = text.split("\n");
  for (const entry of meta.outline) expect(lines[entry.line - 1]!.trim()).toBe(entry.title);
  return meta.outline.map((entry) => [entry.line, entry.level, entry.title]);
}

async function ingested(bytes: Uint8Array, options: Parameters<typeof createLargeFiles>[0] = { store: new MemoryDocumentStore() }) {
  const store = options.store as MemoryDocumentStore;
  const files = createLargeFiles(options);
  const meta = await files.ingest({ name: "file.pdf", bytes });
  return { files, meta, text: (await store.get(meta.id))!.text };
}

describe("the outline of a PDF from the size of its type", () => {
  it("gives an unnumbered Hebrew PDF an outline: title, sections and subsections, without its running header, footer and a large number", async () => {
    const { files, meta, text } = await ingested(hebrewLease());
    expect(outlineOf(meta, text)).toEqual([
      [3, 1, "חוזה שכירות בלתי מוגנת"],
      [6, 2, "הצדדים לחוזה"],
      [9, 3, "פרטי השוכר"],
      [16, 2, "תקופת השכירות"],
      [19, 2, "דמי השכירות"],
      // A heading set on two lines is one entry, at its first line.
      [23, 2, "התחייבויות"],
      [31, 2, "סיום החוזה"],
      [34, 3, "שונות"],
    ]);
    expect(text.split("\n").slice(1, 3)).toEqual(["חברת אלפא ניהול נכסים", "חוזה שכירות בלתי מוגנת"]);
    // The text rules find nothing in it: no capitals, no numbers, no blank lines.
    expect(buildOutline(text.split("\n"), "pdf")).toEqual([]);
    // The model gets it from get_document_overview.
    const overview = await files.tools([meta]).execute("get_document_overview", { document_id: meta.id }) as { outline: string[] };
    expect(overview.outline.slice(0, 3)).toEqual(["L3 חוזה שכירות בלתי מוגנת", "L6   הצדדים לחוזה", "L9     פרטי השוכר"]);
  });

  it("gives an English PDF the same kind of outline", async () => {
    const { meta, text } = await ingested(englishReport());
    expect(outlineOf(meta, text)).toEqual([
      [2, 1, "Annual Maintenance Review"],
      [5, 2, "Background"],
      [8, 3, "2.1 Methods of inspection"],
      [13, 2, "Findings"],
      [16, 3, "Costs by site"],
    ]);
  });

  it("finds the headings with the tables off, and in a PDF read by an extractor that wraps the built-in one", async () => {
    const plain = await ingested(hebrewLease(), { store: new MemoryDocumentStore(), extractors: { pdf: createPdfExtractor({ tables: false }) } });
    const expected = outlineOf((await ingested(hebrewLease())).meta, (await ingested(hebrewLease())).text);
    expect(outlineOf(plain.meta, plain.text)).toEqual(expected);
    // A wrapper that passes on what the built-in extractor returns keeps the outline; one that
    // passes on only the text and the pages has none.
    const passing: Extractor = async (bytes, input) => ({ ...await defaultExtractors.pdf(bytes, input) });
    const dropping: Extractor = async (bytes, input) => {
      const { text, pages } = await defaultExtractors.pdf(bytes, input);
      return { text, pages };
    };
    expect((await ingested(hebrewLease(), { store: new MemoryDocumentStore(), extractors: { pdf: passing } })).meta.outline).toHaveLength(8);
    expect((await ingested(hebrewLease(), { store: new MemoryDocumentStore(), extractors: { pdf: dropping } })).meta.outline).toEqual([]);
  });

  it("gives the Hebrew and English PDFs printed by Word and Chrome their headings", async () => {
    const hebrewReport = await ingested(fixture("word-hebrew"));
    expect(outlineOf(hebrewReport.meta, hebrewReport.text)).toEqual([[2, 1, "דוח הכנסות"]]);
    const statement = await ingested(fixture("chrome-hebrew-statement"));
    expect(outlineOf(statement.meta, statement.text)).toEqual([[2, 1, "דף חשבון"]]);
    const report = await ingested(fixture("word-pictures"));
    expect(outlineOf(report.meta, report.text).map(([, level, title]) => [level, title])).toEqual([[1, "Regional report"], [1, "Site visit"], [1, "Status by site"]]);
    // A caption set larger than the text, smaller than the title.
    const simple = await ingested(fixture("word-simple"));
    expect(outlineOf(simple.meta, simple.text)).toEqual([[2, 1, "Revenue report"], [7, 2, "Table 1: Revenue by region (USD millions)"]]);
  });

  it("keeps the outline of the text rules when they find 3 headings or more, and replaces one of fewer", async () => {
    const agreement = (hashes: string[]) => pdfWithSizedLines([[
      { text: "Service agreement", size: 20 },
      ...hashes.flatMap((title) => [body(`# ${title}`), body("The supplier keeps the systems running at all hours of the day.")]),
      { text: "Definitions", size: 15 },
      body("Words in capitals have the meaning given to them in this section."),
      { text: "Obligations", size: 15 },
      body("Each party does what this agreement asks of it, on time and in full."),
    ]]);
    const three = await ingested(agreement(["Scope", "Terms", "Payment"]));
    // The extractor found its headings by size, and the text rules' outline was kept as it is.
    const extracted = await defaultExtractors.pdf(agreement(["Scope", "Terms", "Payment"]), { name: "a.pdf", mimeType: "application/pdf", format: "pdf" });
    expect(extracted.headings).toEqual([
      { page: 1, level: 1, title: "Service agreement" },
      { page: 1, level: 2, title: "Definitions" },
      { page: 1, level: 2, title: "Obligations" },
    ]);
    expect(three.meta.outline).toEqual(buildOutline(three.text.split("\n"), "pdf"));
    expect(three.meta.outline).toEqual([{ line: 3, level: 1, title: "Scope" }, { line: 5, level: 1, title: "Terms" }, { line: 7, level: 1, title: "Payment" }]);
    const two = await ingested(agreement(["Scope", "Terms"]));
    expect(outlineOf(two.meta, two.text)).toEqual([[2, 1, "Service agreement"], [7, 2, "Definitions"], [9, 2, "Obligations"]]);
  });

  it("takes no row of a table for a heading, nor a line of numbers set large", async () => {
    const rows = Array.from({ length: 14 }, (_, index): SizedLine => ({ cells: [`Site ${String.fromCharCode(65 + index)}`, `${120 + index}`, `${135 + index}`, `${150 + index}`], size: 10 }));
    const bytes = pdfWithSizedLines([[
      { text: "Quarterly figures", size: 16 },
      { cells: ["Region", "Q1", "Q2", "Q3"], size: 13 },
      ...rows,
      { cells: ["Total", "1,200", "1,350", "1,500"], size: 13 },
      { text: "1,234,567", size: 18 },
      { text: "Figures are in thousands and were not audited.", size: 10 },
    ]]);
    const { meta, text } = await ingested(bytes);
    expect(text).toContain("\n| Region | Q1 | Q2 | Q3 |\n| Site A | 120 | 135 | 150 |\n");
    expect(outlineOf(meta, text)).toEqual([[2, 1, "Quarterly figures"]]);
    // Real tables: a Word report whose table is most of the page, and a Hebrew bank statement.
    const dense = await ingested(fixture("word-dense"));
    expect(outlineOf(dense.meta, dense.text)).toEqual([[2, 1, "Output by site"]]);
  });

  it("finds the headings of the pages with text in a PDF with a page without any, and none in a scan", async () => {
    const mixed = await ingested(pdfWithSizedLines([
      [{ text: "Inspection notes", size: 18 }, body("The first site was visited on a dry morning in March."), body("Nothing needed repair at once.")],
      [],
      [{ text: "Second visit", size: 18 }, body("The second visit found a leak in the roof of the store room.")],
    ]), { store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    expect(mixed.text).toContain("--- Page 2 ---\n[No text on this page. It may be a scan, a photo, or a chart.]");
    expect(outlineOf(mixed.meta, mixed.text)).toEqual([[2, 1, "Inspection notes"], [10, 1, "Second visit"]]);

    const builder = new PdfBuilder();
    for (let page = 0; page < 2; page++) builder.page(paint("Im1", 612, 792, 0, 0), { Im1: builder.image() });
    const scan = builder.build();
    const extracted = await defaultExtractors.pdf(scan, { name: "scan.pdf", mimeType: "application/pdf", format: "pdf", scannedPages: 30 });
    expect(extracted).not.toHaveProperty("headings");
    const scanned = await ingested(scan, { store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    expect(scanned.meta).toMatchObject({ pages: 2, outline: [] });
  });

  it("reads only well-formed headings of an extractor of your own, for a PDF only, and leaves out those not found on their page", async () => {
    const text = "--- Page 1 ---\nTitle of the file\nSome text under it.\n\n--- Page 2 ---\nA  second   heading\nMore text.\nTitle of the file";
    const own = (headings: unknown, written: string): Extractor => async () => ({ text: written, pages: 2, headings } as Awaited<ReturnType<Extractor>>);
    const withHeadings = (headings: unknown, format: "pdf" | "text" = "pdf", written = text) => {
      const store = new MemoryDocumentStore();
      return createLargeFiles({ store, extractors: { [format]: own(headings, written) } }).ingest({ name: format === "pdf" ? "own.pdf" : "own.txt", bytes: new Uint8Array([1]) });
    };
    const good = [{ page: 1, level: 1, title: "Title of the file" }, { page: 2, level: 2, title: "A second heading" }];
    expect((await withHeadings(good)).outline).toEqual([{ line: 2, level: 1, title: "Title of the file" }, { line: 6, level: 2, title: "A  second   heading" }]);
    // Bad entries are skipped; a heading looked for on another page, or missing from its page, is not found.
    const mixed = [null, "Title", { page: 0, level: 1, title: "Title of the file" }, { page: 1, level: 7, title: "Title of the file" }, { page: 1.5, level: 1, title: "x" },
      { page: 1, level: 1, title: "  " }, { page: 1, level: 1, title: "x".repeat(1_001) }, { page: 3, level: 1, title: "More text." }, { page: 1, level: 1, title: "More text." }, ...good];
    expect((await withHeadings(mixed)).outline).toHaveLength(2);
    expect((await withHeadings("not a list")).outline).toEqual([]);
    expect((await withHeadings([{ page: 1, level: 1, title: "Nowhere" }])).outline).toEqual([]);
    expect((await withHeadings(good, "text")).outline).toEqual([]);
    // In a long text, past the pauses for other requests.
    const long = ["--- Page 1 ---", "Opening words", ...Array.from({ length: 5_000 }, (_, index) => `Line ${index}`), "", "--- Page 2 ---", "Late heading", "More text."].join("\n");
    expect((await withHeadings([{ page: 1, level: 1, title: "Opening words" }, { page: 2, level: 2, title: "Late heading" }], "pdf", long)).outline)
      .toEqual([{ line: 2, level: 1, title: "Opening words" }, { line: 5_005, level: 2, title: "Late heading" }]);
  });
});

/** A piece of text as pdf.js gives it, `size` units high, ending its line unless `eol` is false. */
const item = (str: string, size: number, eol = true): PdfTextItem => ({ str, transform: [size, 0, 0, size, 72, 700], width: str.length * size * 0.5, height: size, hasEOL: eol });
const BODY = "words of an ordinary line of the body text";

function find(pages: PdfTextItem[][]) {
  const finder = new PdfHeadingFinder();
  pages.forEach((items, index) => finder.addPage(index + 1, items));
  return finder.headings();
}

describe("PdfHeadingFinder", () => {
  it("ranks sizes into three levels, and takes vertical text by its matrix", () => {
    const sizes = [30, 24, 18, 14];
    const headings = find([[...sizes.map((size) => item(`Heading at ${size}`, size)), ...Array.from({ length: 20 }, () => item(BODY, 10)),
      { str: "Sideways heading", transform: [0, 24, -24, 0, 100, 100], width: 100, height: 0, hasEOL: true }]]);
    expect(headings.map(({ level, title }) => [level, title])).toEqual([[1, "Heading at 30"], [2, "Heading at 24"], [3, "Heading at 18"], [3, "Heading at 14"], [2, "Sideways heading"]]);
  });

  it("takes the size most of a line's characters have, and a line only when three quarters of it are of that size", () => {
    const filler = Array.from({ length: 10 }, () => item(BODY, 10));
    expect(find([[item("Big", 20, false), item(" start of an ordinary body line", 10), item("Mostly big heading", 20, false), item("!", 10), ...filler]]).map((heading) => heading.title)).toEqual(["Mostly big heading!"]);
  });

  it("leaves out short, long and numeric lines, and lines that read as a table row", () => {
    // Each between two lines of the body: lines in a row at one size are one heading.
    const lines = ["No", "x".repeat(121), "15/03/2026", "2026 Q1", "| Region | Q1 |", "A1B2C3", "Fine heading"].flatMap((title) => [item(title, 16), item(BODY, 10), item(BODY, 10), item(BODY, 10)]);
    expect(find([lines]).map((heading) => heading.title)).toEqual(["A1B2C3", "Fine heading"]);
  });

  it("leaves out lines repeated on most pages, numbers aside", () => {
    const page = (number: number, extra: PdfTextItem[] = []) => [item("Company name", 14), ...extra, item(BODY, 10), item(BODY, 10), item(`Page ${number}`, 14)];
    // Two pages of two: both repeated. Two pages of five: kept. Three pages: repeated.
    expect(find([page(1, [item("First", 18)]), page(2)]).map((heading) => heading.title)).toEqual(["First"]);
    const five = find([page(1, [item("Twice seen", 18)]), page(2, [item("Twice seen", 18)]), page(3), page(4), page(5)]);
    expect(five.map((heading) => heading.title)).toEqual(["Twice seen", "Twice seen"]);
    expect(find([[item("Notes", 18), item(BODY, 10)], [item("Notes", 18), item(BODY, 10)], [item("Notes", 18), item(BODY, 10)], [item(BODY, 10)], [item(BODY, 10)], [item(BODY, 10)]])).toEqual([]);
  });

  it("finds none when the text has one size, when much of it is set large, or when nothing can be measured", () => {
    expect(find([[item("Only line", 11), item(BODY, 11)]])).toEqual([]);
    expect(find([[item("Large heading here", 16), item(BODY, 16), item(BODY, 10)]])).toEqual([]);
    expect(find([])).toEqual([]);
    expect(find([[{ str: "No size", transform: "odd" as unknown as number[], width: 1, height: 0, hasEOL: true }, { str: 3 as unknown as string, transform: [1, 0, 0, 1, 0, 0], width: 1, height: 20 }, item("   ", 20)]])).toEqual([]);
    // Of two sizes with as many characters, the smaller is the body.
    expect(find([[item("Equal length", 20), item("Equal length", 10)]]).map((heading) => heading.title)).toEqual([]);
  });

  it("keeps at most 20,000 lines while it reads: the smallest size goes first, and too many large lines give none", () => {
    const many = Array.from({ length: 25_000 }, (_, index) => item(`Body line ${index}`, 10));
    expect(find([[item("The one heading", 16), ...many]]).map((heading) => heading.title)).toEqual(["The one heading"]);
    const long = Array.from({ length: 2_000 }, () => item(`${BODY} `.repeat(4), 10));
    const large = Array.from({ length: 21_000 }, (_, index) => item(`Head ${index}`, 16));
    expect(find([[...long, ...large]])).toEqual([]);
  });
});
