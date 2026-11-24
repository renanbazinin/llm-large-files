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
/** What the built-in PDF extractor returns for `bytes`. */
const extract = (bytes: Uint8Array, options?: Parameters<typeof createPdfExtractor>[0]) =>
  (options ? createPdfExtractor(options) : defaultExtractors.pdf)(bytes, { name: "file.pdf", mimeType: "application/pdf", format: "pdf" });
/** The headings the extractor found, as [page, level, title]. */
const headingsIn = async (bytes: Uint8Array, options?: Parameters<typeof createPdfExtractor>[0]) =>
  ((await extract(bytes, options)).headings ?? []).map(({ page, level, title }) => [page, level, title]);

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

  it("gives a PDF printed by Word its headings, and leaves the outline of one with a title alone as it was", async () => {
    const report = await ingested(fixture("word-pictures"));
    expect(outlineOf(report.meta, report.text).map(([, level, title]) => [level, title])).toEqual([[1, "Regional report"], [1, "Site visit"], [1, "Status by site"]]);
    // A title, or a title and a caption set larger than the text, is not an outline: the card and
    // the search hits of these PDFs, the two of the evals among them, are those of 0.9.
    for (const [name, found] of [
      ["word-hebrew", [[1, 1, "דוח הכנסות"]]],
      ["chrome-hebrew-statement", [[1, 1, "דף חשבון"]]],
      ["word-simple", [[1, 1, "Revenue report"], [1, 2, "Table 1: Revenue by region (USD millions)"]]],
      ["word-dense", [[1, 1, "Output by site"]]],
    ] as const) {
      expect(await headingsIn(fixture(name))).toEqual(found);
      expect((await ingested(fixture(name))).meta.outline).toEqual([]);
    }
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

  it("takes no row of a table for a heading, nor a line of numbers set large, with the tables rebuilt or not", async () => {
    const rows = Array.from({ length: 14 }, (_, index): SizedLine => ({ cells: [`Site ${String.fromCharCode(65 + index)}`, `${120 + index}`, `${135 + index}`, `${150 + index}`], size: 10 }));
    const bytes = () => pdfWithSizedLines([[
      { text: "Quarterly figures", size: 16 },
      { cells: ["Region", "North South", "East", "West"], size: 13 },
      ...rows,
      { cells: ["Total", "1,200", "1,350", "1,500"], size: 13 },
      { text: "1,234,567", size: 18 },
      { text: "Figures are in thousands and were not audited.", size: 10 },
      { text: "The north and south regions were counted together this year.", size: 10 },
    ]]);
    expect((await extract(bytes())).text).toContain("\n| Region | North South | East | West |\n| Site A | 120 | 135 | 150 |\n");
    expect(await headingsIn(bytes())).toEqual([[1, 1, "Quarterly figures"]]);
    // Read without rebuilding the tables, the header row is one line of the text: its cells are far apart.
    expect((await extract(bytes(), { tables: false })).text).toContain("\nRegion North South East West\n");
    expect(await headingsIn(bytes(), { tables: false })).toEqual([[1, 1, "Quarterly figures"]]);
    // A table of two columns, which is never rebuilt: a label and its value.
    const details = pdfWithSizedLines([[
      { text: "Tenant details", size: 16 },
      body("The tenant gave these details when the lease was signed, in person."),
      { cells: ["Field", "Value"], size: 13 },
      { cells: ["Name", "Dana Levi"], size: 11 },
      { cells: ["Phone", "050-1234567"], size: 11 },
      body("The landlord keeps a copy of these details for the length of the lease."),
    ]]);
    expect(await headingsIn(details)).toEqual([[1, 1, "Tenant details"]]);
  });

  it("measures the body without the tables: a statement whose table is in smaller type than its notes has no note for a heading", async () => {
    const statement = (hebrew: boolean) => {
      const row = (index: number): SizedLine => ({ cells: [`${10 + (index % 20)}/11/2026`, hebrew ? `תשלום לספק ${index}` : `Payment to supplier ${index}`, `${120 + index}.50`, `${4_000 + index}.20`], size: 8 });
      const rows = Array.from({ length: 30 }, (_, index) => row(index));
      const note = (english: string, hebrewText: string): SizedLine => ({ text: hebrew ? hebrewText : english, size: 10 });
      return pdfWithSizedLines([
        [{ text: hebrew ? "דף חשבון" : "Account statement", size: 14 }, note("Your balance went down this month because of two large payments.", "היתרה שלך ירדה החודש בגלל שני תשלומים גדולים"),
          ...rows, note("Interest is paid on the last working day of each month.", "הריבית משולמת ביום העבודה האחרון של כל חודש")],
        [note("Call us if you see a payment you do not know.", "פנה אלינו אם אתה רואה תשלום שאינך מכיר"), ...rows, note("All amounts are in pounds.", "כל הסכומים בשקלים חדשים")],
      ]);
    };
    expect(await headingsIn(statement(false))).toEqual([[1, 1, "Account statement"]]);
    expect(await headingsIn(statement(true))).toEqual([[1, 1, "דף חשבון"]]);
    expect((await ingested(statement(true))).meta.outline).toEqual([]);
  });

  it("points each heading at its own line when a line above it on its page reads the same: a contents list, a running header", async () => {
    const bytes = () => pdfWithSizedLines([[
      { text: "Site report", size: 9 },
      { text: "Site report", size: 22 },
      { text: "Contents", size: 14 },
      body("Introduction"), body("Method"), body("Results"),
      { text: "Introduction", size: 16 }, body("The inspection began with the north gate and its fence."), body("Two inspectors walked the grounds."),
      { text: "Method", size: 16 }, body("Each wall was measured with a laser and photographed."), body("The roof was checked by drone."),
      { text: "Results", size: 16 }, body("The east wall needs new mortar before the winter."), body("The roof drains are blocked by leaves."),
    ]]);
    expect((await extract(bytes())).headings).toEqual([
      { page: 1, level: 1, title: "Site report", skip: 1 },
      { page: 1, level: 3, title: "Contents" },
      { page: 1, level: 2, title: "Introduction", skip: 1 },
      { page: 1, level: 2, title: "Method", skip: 1 },
      { page: 1, level: 2, title: "Results", skip: 1 },
    ]);
    const { files, meta, text } = await ingested(bytes());
    expect(outlineOf(meta, text)).toEqual([[3, 1, "Site report"], [4, 3, "Contents"], [8, 2, "Introduction"], [11, 2, "Method"], [14, 2, "Results"]]);
    const tools = files.tools([meta]);
    const sectionOf = async (query: string) => ((await tools.execute("search_document", { document_id: meta.id, query, mode: "exact" })) as { matches: Array<{ section?: string }> }).matches[0]!.section;
    expect([await sectionOf("north gate"), await sectionOf("laser"), await sectionOf("east wall")]).toEqual(["Introduction", "Method", "Results"]);
  });

  it("keeps numbered chapters, which are on a few pages, and leaves out a numbered footer, which is on most", async () => {
    const lines = ["המשכיר הוא בעל הזכויות בדירה ברחוב הרצל", "השוכר מעוניין לשכור את הדירה למגורים בלבד", "דמי השכירות ישולמו בראשון לכל חודש בהעברה"].map(body);
    const pages = Array.from({ length: 12 }, (_, index): SizedLine[] => [
      ...(index % 3 === 0 ? [{ text: `פרק ${index / 3 + 1}`, size: 18 }] : []),
      ...lines, ...lines,
      { text: `עמוד ${index + 1} מתוך 12`, size: 13 },
    ]);
    const { meta, text } = await ingested(pdfWithSizedLines(pages));
    expect(outlineOf(meta, text).map(([, level, title]) => [level, title])).toEqual([[1, "פרק 1"], [1, "פרק 2"], [1, "פרק 3"], [1, "פרק 4"]]);
  });

  it("keeps numbered sections several to a page and chapters on the odd pages, and leaves out a page number on the odd pages and on each (Hebrew)", async () => {
    const lines = ["המשכיר הוא בעל הזכויות בדירה ברחוב הרצל", "השוכר מעוניין לשכור את הדירה למגורים בלבד", "דמי השכירות ישולמו בראשון לכל חודש בהעברה"].map(body);
    const section = (number: number): SizedLine[] => [{ text: `סעיף ${number}`, size: 14 }, { text: `נושא ${String.fromCharCode(0x5d0 + number)}`, size: 14 }, ...lines];
    const pages = Array.from({ length: 10 }, (_, index): SizedLine[] => [
      // On the odd pages: a running header with the page's number, and a chapter counting by one.
      ...(index % 2 === 0 ? [{ text: `דוח שנתי עמוד ${index + 1}`, size: 13 }, { text: `פרק ${index / 2 + 1}`, size: 18 }] : []),
      ...section(2 * index + 1), ...section(2 * index + 2),
      { text: `עמוד ${index + 1} מתוך 10`, size: 13 },
    ]);
    const { meta, text } = await ingested(pdfWithSizedLines(pages));
    const sections = (page: number) => [[2, `סעיף ${2 * page + 1}`], [2, `סעיף ${2 * page + 2}`]];
    expect(outlineOf(meta, text).map(([, level, title]) => [level, title])).toEqual(Array.from({ length: 10 }, (_, page) => [
      ...(page % 2 === 0 ? [[1, `פרק ${page / 2 + 1}`]] : []), ...sections(page),
    ]).flat());
  });

  it("keeps numbered articles, 3 to a page on every page, and leaves out a page number on the odd pages (English)", async () => {
    const filler = [body("The supplier keeps the systems running at all hours of the day."), body("Each party does what this agreement asks of it, on time and in full.")];
    const pages = Array.from({ length: 6 }, (_, index): SizedLine[] => [
      ...(index % 2 === 0 ? [{ text: `Annual Report page ${index + 1}`, size: 16 }] : []),
      ...[1, 2, 3].flatMap((article) => [{ text: `Article ${3 * index + article}`, size: 14 }, ...filler]),
    ]);
    const { meta, text } = await ingested(pdfWithSizedLines(pages));
    expect(outlineOf(meta, text).map(([, level, title]) => [level, title])).toEqual(Array.from({ length: 18 }, (_, index) => [1, `Article ${index + 1}`]));
  });

  it("gives the headings of the body their own levels below a cover page", async () => {
    const filler = [body("The supplier keeps the systems running at all hours of the day."), body("Each party does what this agreement asks of it, on time and in full.")];
    const { meta, text } = await ingested(pdfWithSizedLines([
      [{ text: "Annual Audit Report", size: 26 }, { text: "Operations Division", size: 18 }],
      [{ text: "Introduction", size: 16 }, ...filler, { text: "Scope of the audit", size: 13 }, ...filler, { text: "Sources", size: 13 }, ...filler],
      [{ text: "Findings", size: 16 }, ...filler, { text: "Late payments", size: 13 }, ...filler, { text: "Missing receipts", size: 13 }, ...filler],
    ]));
    expect(outlineOf(meta, text).map(([, level, title]) => [level, title])).toEqual([
      [1, "Annual Audit Report"], [1, "Operations Division"],
      [2, "Introduction"], [3, "Scope of the audit"], [3, "Sources"],
      [2, "Findings"], [3, "Late payments"], [3, "Missing receipts"],
    ]);
  });

  it("finds the headings of the pages with text in a PDF with a page without any, and none in a scan", async () => {
    const mixed = await ingested(pdfWithSizedLines([
      [{ text: "Inspection notes", size: 18 }, body("The first site was visited on a dry morning in March."), body("Nothing needed repair at once.")],
      [],
      [{ text: "Second visit", size: 18 }, body("The second visit found a leak in the roof of the store room."), { text: "Third visit", size: 18 }, body("The leak was mended.")],
    ]), { store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    expect(mixed.text).toContain("--- Page 2 ---\n[No text on this page. It may be a scan, a photo, or a chart.]");
    expect(outlineOf(mixed.meta, mixed.text)).toEqual([[2, 1, "Inspection notes"], [10, 1, "Second visit"], [12, 1, "Third visit"]]);

    const builder = new PdfBuilder();
    for (let page = 0; page < 2; page++) builder.page(paint("Im1", 612, 792, 0, 0), { Im1: builder.image() });
    const scan = builder.build();
    const extracted = await defaultExtractors.pdf(scan, { name: "scan.pdf", mimeType: "application/pdf", format: "pdf", scannedPages: 30 });
    expect(extracted).not.toHaveProperty("headings");
    const scanned = await ingested(scan, { store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    expect(scanned.meta).toMatchObject({ pages: 2, outline: [] });
  });

  it("reads only well-formed headings of an extractor of your own, for a PDF only, and leaves out those not found on their page", async () => {
    const text = "--- Page 1 ---\nTitle of the file\nSome text under it.\n\n--- Page 2 ---\nA  second   heading\nMore text.\nTitle of the file\nThird part";
    const own = (headings: unknown, written: string): Extractor => async () => ({ text: written, pages: 2, headings } as Awaited<ReturnType<Extractor>>);
    const withHeadings = (headings: unknown, format: "pdf" | "text" = "pdf", written = text) => {
      const store = new MemoryDocumentStore();
      return createLargeFiles({ store, extractors: { [format]: own(headings, written) } }).ingest({ name: format === "pdf" ? "own.pdf" : "own.txt", bytes: new Uint8Array([1]) });
    };
    const good = [{ page: 1, level: 1, title: "Title of the file" }, { page: 2, level: 2, title: "A second heading" }, { page: 2, level: 2, title: "Third part" }];
    expect((await withHeadings(good)).outline).toEqual([{ line: 2, level: 1, title: "Title of the file" }, { line: 6, level: 2, title: "A  second   heading" }, { line: 9, level: 2, title: "Third part" }]);
    // Bad entries are skipped; a heading looked for on another page, or missing from its page, is not found.
    const mixed = [null, "Title", { page: 0, level: 1, title: "Title of the file" }, { page: 1, level: 7, title: "Title of the file" }, { page: 1.5, level: 1, title: "x" },
      { page: 1, level: 1, title: "  " }, { page: 1, level: 1, title: "x".repeat(1_001) }, { page: 3, level: 1, title: "More text." }, { page: 1, level: 1, title: "More text." },
      { page: 2, level: 1, title: "More text.", skip: -1 }, { page: 2, level: 1, title: "More text.", skip: 0.5 }, { page: 2, level: 1, title: "More text.", skip: "0" }, ...good];
    expect((await withHeadings(mixed)).outline).toHaveLength(3);
    expect((await withHeadings("not a list")).outline).toEqual([]);
    expect((await withHeadings([{ page: 1, level: 1, title: "Nowhere" }])).outline).toEqual([]);
    expect((await withHeadings(good, "text")).outline).toEqual([]);
    // Two of them alone are not an outline.
    expect((await withHeadings(good.slice(0, 2))).outline).toEqual([]);
    // A heading past lines of its page that read the same; one past more of them than there are is not found.
    const listed = "--- Page 1 ---\nContents\nPart one\nPart two\nPart one\nText.\nPart two\nText.";
    const parts = [{ page: 1, level: 1, title: "Contents" }, { page: 1, level: 2, title: "Part one", skip: 1 }, { page: 1, level: 2, title: "Part two", skip: 1 }];
    expect((await withHeadings(parts, "pdf", listed)).outline.map((entry) => entry.line)).toEqual([2, 5, 7]);
    expect((await withHeadings([...parts, { page: 1, level: 2, title: "Part two", skip: 2 }], "pdf", listed)).outline.map((entry) => entry.line)).toEqual([2, 5, 7]);
    // In a long text, past the pauses for other requests.
    const long = ["--- Page 1 ---", "Opening words", ...Array.from({ length: 5_000 }, (_, index) => `Line ${index}`), "", "--- Page 2 ---", "Late heading", "More text.", "Last heading"].join("\n");
    expect((await withHeadings([{ page: 1, level: 1, title: "Opening words" }, { page: 2, level: 2, title: "Late heading" }, { page: 2, level: 2, title: "Last heading" }], "pdf", long)).outline)
      .toEqual([{ line: 2, level: 1, title: "Opening words" }, { line: 5_005, level: 2, title: "Late heading" }, { line: 5_007, level: 2, title: "Last heading" }]);
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

  it("leaves out lines repeated on most pages, and page numbers, but not numbered headings", () => {
    const page = (number: number, extra: PdfTextItem[] = []) => [item("Company name", 14), ...extra, item(BODY, 10), item(BODY, 10), item(`Page ${number}`, 14)];
    // Two pages of two: both repeated. Two pages of five: kept. Three pages: repeated.
    expect(find([page(1, [item("First", 18)]), page(2)]).map((heading) => heading.title)).toEqual(["First"]);
    const five = find([page(1, [item("Twice seen", 18)]), page(2, [item("Twice seen", 18)]), page(3), page(4), page(5)]);
    expect(five.map((heading) => heading.title)).toEqual(["Twice seen", "Twice seen"]);
    expect(find([[item("Notes", 18), item(BODY, 10)], [item("Notes", 18), item(BODY, 10)], [item("Notes", 18), item(BODY, 10)], [item(BODY, 10)], [item(BODY, 10)], [item(BODY, 10)]])).toEqual([]);
    // Numbered lines on the odd pages, half of them: a page number skips the pages it is not on, and is left out;
    // section numbers count by one, and are kept. On fewer than half the pages, numbers on pages in a row are kept.
    const odd = (count: number, title: (page: number, nth: number) => string) =>
      find(Array.from({ length: count }, (_, index) => [...(index % 2 === 0 ? [item(title(index + 1, index / 2 + 1), 18)] : []), item(BODY, 10), item(BODY, 10)]));
    expect(odd(6, (page) => `Annual Report page ${page}`)).toEqual([]);
    expect(odd(4, (page) => `Annual Report page ${page} of 4`)).toEqual([]);
    expect(odd(6, (_, nth) => `Part ${nth}`).map((heading) => heading.title)).toEqual(["Part 1", "Part 2", "Part 3"]);
    expect(find(Array.from({ length: 5 }, (_, index) => [...(index < 2 ? [item(`Part ${index + 1}`, 18)] : []), item(BODY, 10), item(BODY, 10)]))).toHaveLength(2);
    // Several to a page are headings, on every page: "Article 1" to "Article 18", 3 to a page of 6.
    const articles = find(Array.from({ length: 6 }, (_, index) => [1, 2, 3].flatMap((article) => [item(`Article ${3 * index + article}`, 14), item(BODY, 10), item(BODY, 10)])));
    expect(articles.map((heading) => heading.title)).toEqual(Array.from({ length: 18 }, (_, index) => `Article ${index + 1}`));
    // On pages in a row, counting by one, section numbers read as a page number: on 4 pages of 6, left out.
    expect(find(Array.from({ length: 6 }, (_, index) => [...(index < 4 ? [item(`Part ${index + 1}`, 18)] : []), item(BODY, 10), item(BODY, 10)]))).toEqual([]);
  });

  it("finds none when the text has one size, when much of it is set large, or when nothing can be measured", () => {
    expect(find([[item("Only line", 11), item(BODY, 11)]])).toEqual([]);
    expect(find([[item("Large heading here", 16), item(BODY, 16), item(BODY, 10)]])).toEqual([]);
    expect(find([])).toEqual([]);
    expect(find([[{ str: "No size", transform: "odd" as unknown as number[], width: 1, height: 0, hasEOL: true }, { str: 3 as unknown as string, transform: [1, 0, 0, 1, 0, 0], width: 1, height: 20 }, item("   ", 20)]])).toEqual([]);
    // Of two sizes with as many characters, the smaller is the body.
    expect(find([[item("Equal length", 20), item("Equal length", 10)]]).map((heading) => heading.title)).toEqual([]);
  });

  it("keeps at most 64 sizes while it reads: the smallest go first, and more sizes than that set large give none", () => {
    const bodyLines = Array.from({ length: 200 }, () => item(BODY, 10));
    const sixty = Array.from({ length: 60 }, (_, index) => item(`Heading ${index}`, 20 + index * 0.5));
    expect(find([[...bodyLines, ...sixty]])).toHaveLength(60);
    const seventy = Array.from({ length: 70 }, (_, index) => item(`Heading ${index}`, 20 + index * 0.5));
    expect(find([[...bodyLines, ...seventy]])).toEqual([]);
  });

  it("keeps at most 20,000 lines while it reads: the smallest size goes first, and too many large lines give none", () => {
    const many = Array.from({ length: 25_000 }, (_, index) => item(`Body line ${index}`, 10));
    expect(find([[item("The one heading", 16), ...many]]).map((heading) => heading.title)).toEqual(["The one heading"]);
    const long = Array.from({ length: 2_000 }, () => item(`${BODY} `.repeat(4), 10));
    const large = Array.from({ length: 21_000 }, (_, index) => item(`Head ${index}`, 16));
    expect(find([[...long, ...large]])).toEqual([]);
  });
});
