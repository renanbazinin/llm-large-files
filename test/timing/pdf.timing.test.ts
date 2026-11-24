// The tests of PDF reading that hold work to the clock: how often a timer gets a turn while
// @cantoo/pdf-lib parses or cuts a file (from test/pdf-parse-pauses.test.ts), how long the
// checks take that refuse pages, names and forms built to hold the server (from
// test/ingest-limits.test.ts, test/pdf-names.test.ts and test/pdf-pictures.test.ts), and how long
// the headings of a PDF built to hold the server take to find (from test/pdf-outline.test.ts).
import "../load-pdf-libraries.js";
import { deflateSync } from "node:zlib";
import * as pdfLib from "@cantoo/pdf-lib";
import { PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { createPdfExtractor, PICTURE_ON_PAGE, type PdfExtractorOptions } from "../../src/extract.js";
import { canonicalName, cutPdfPages, loadPdf, objectsPerTick, OBJECTS_PER_TICK } from "../../src/pdf-pages.js";
import { PdfHeadingFinder } from "../../src/pdf-outline.js";
import { parsePdf } from "../../src/pdf-pictures.js";
import { checkPageWork } from "../../src/pdf-work.js";
import { FORM, formsInForms, heavyPdf, HELVETICA, pageObject as page, PdfBuilder, pdfFromObjects, pdfStream, textLine } from "../pdf-fixtures.js";
import { beatsDuring } from "./clock.js";

/** How many objects a PDF holds. */
async function objectsIn(bytes: Uint8Array): Promise<number> {
  return (await pdfLib.PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
}

/** A name that loses one "#23" each time it is decoded: `levels` + 1 decodings make it "A". */
const nested = (levels: number) => `#${"23".repeat(levels)}41`;

/**
 * One page that paints the form /X, which shows a line of text, beside `content`. The page's
 * XObject dictionary also holds an image /Unused that nothing paints, and `extraKeys`, each naming
 * the same form. Objects: 1 catalog, 2 pages, 3 the page, 4 the font, 5 the content, 6 the form,
 * 7 the image.
 */
function pdfWithNames({ extraKeys = [], content = "" }: { extraKeys?: string[]; content?: string }): Uint8Array {
  const xobjects = ["/X 6 0 R", "/Unused 7 0 R", ...extraKeys.map((key) => `/${key} 6 0 R`)].join(" ");
  const stream = `${textLine("A page with odd names.")}\nq /X Do Q\n${content}`;
  return pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /XObject << ${xobjects} >> /Font << /F1 4 0 R >> >> >>`,
    HELVETICA,
    pdfStream("/Filter /FlateDecode", deflateSync(Buffer.from(stream, "latin1"))),
    pdfStream(`${FORM} /Resources << /Font << /F1 4 0 R >> >>`, textLine("Inside the form.", 600)),
    pdfStream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", "\x00\xff\xff\x00"),
  ]);
}

/** How many entries the XObject dictionary of the first page of `bytes` has. */
async function drawingsKept(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes);
  const xobjects = document.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"));
  return xobjects instanceof PDFDict ? xobjects.entries().length : 0;
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  // pdf.js takes the buffer it is given: hand it a copy.
  const pdf = await getDocumentProxy(bytes.slice());
  const texts: string[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const content = await (await pdf.getPage(number)).getTextContent();
    texts.push(content.items.map((item: object) => ("str" in item ? String(item.str) : "")).join(" ").trim());
  }
  return texts;
}

const input = { name: "a.pdf", mimeType: "application/pdf", format: "pdf" as const };
const read = async (bytes: Uint8Array, options?: PdfExtractorOptions) => (await createPdfExtractor(options)(bytes, input)).text;
/** The pages whose header is followed by the line that says the page shows a picture. */
const marked = (text: string): number[] => text.split("\n\n").flatMap((page) => {
  const [header, second] = page.split("\n");
  return second === PICTURE_ON_PAGE ? [Number(/^--- Page (\d+) ---$/.exec(header ?? "")?.[1])] : [];
});

describe("parsing a PDF with @cantoo/pdf-lib lets other work run", () => {
  const bytes = heavyPdf();

  it("pauses by time, not by a count of objects", async () => {
    // A count would not pause at all here: the file has fewer objects than one count.
    expect(objectsPerTick(bytes)).toBe(OBJECTS_PER_TICK);
    const { beats, result } = await beatsDuring(() => loadPdf(pdfLib, bytes));
    expect(result.getPageCount()).toBe(1);
    expect(result.context.enumerateIndirectObjects().length).toBe(455);
    expect(beats).toBeGreaterThanOrEqual(3);
  });

  it("pauses for each of two reads of one file at once, and leaves other uses of pdf-lib as they were", async () => {
    const [first, second] = await Promise.all([beatsDuring(() => loadPdf(pdfLib, bytes)), beatsDuring(() => loadPdf(pdfLib, bytes))]);
    expect(first.beats).toBeGreaterThanOrEqual(3);
    expect(second.beats).toBeGreaterThanOrEqual(3);
    // An app's own use of pdf-lib, on the same bytes, parses as it asks: here without a pause.
    const { beats, result } = await beatsDuring(() => pdfLib.PDFDocument.load(bytes, { parseSpeed: Number.POSITIVE_INFINITY, updateMetadata: false }));
    expect(result.getPageCount()).toBe(1);
    expect(beats).toBe(0);
  });

  it("pauses while view_pages reads the file to cut a page out of it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "arrays.pdf", bytes });
    const tools = files.tools([meta], { viewPages: true });
    const { beats, result } = await beatsDuring(() => tools.executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 }));
    expect(result.result).toMatchObject({ pages: "1", total_pages: 1 });
    expect(result.files).toHaveLength(1);
    // Before 0.6.0 the look held the event loop until the whole file was parsed.
    expect(beats).toBeGreaterThanOrEqual(3);
  });
});

describe("cutting pages out of a PDF lets other work run", () => {
  // The page refers to 450 arrays of 1,200 numbers: copying them into the cut, and writing the cut,
  // each take longer than several slices of work.
  const heavy = heavyPdf(450, 1_200, true);

  it("pauses while it copies the page, and while it writes the cut", async () => {
    const { PDFDocument, PDFObjectCopier } = pdfLib;
    const copierFor = PDFObjectCopier.for;
    const save = PDFDocument.prototype.save;
    const realNow = performance.now.bind(performance);
    let fake: number | undefined;
    // From the start of the copy, the clock moves 3 ms each time it is read, so that a slice of
    // work ends after a number of steps, whatever the speed of the machine. (The parse before it
    // keeps the real clock: tested above.)
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (fake === undefined ? realNow() : (fake += 3)));
    let beats = 0;
    let copying: number | undefined;
    let saving: number | undefined;
    // The beats counted when the copy starts (the copier is made after the parse), and when the
    // cut starts to be written.
    PDFObjectCopier.for = (source, target) => {
      copying = beats;
      fake = realNow();
      return copierFor(source, target);
    };
    PDFDocument.prototype.save = async function (this: pdfLib.PDFDocument, options?: pdfLib.SaveOptions) {
      saving = beats;
      return save.call(this, options);
    };
    const timer = setInterval(() => beats++, 2);
    let cut: Awaited<ReturnType<typeof cutPdfPages>>;
    try {
      cut = await cutPdfPages(heavy, 1, 1, 10_000_000);
    } finally {
      clearInterval(timer);
      clock.mockRestore();
      PDFObjectCopier.for = copierFor;
      PDFDocument.prototype.save = save;
    }
    expect(await objectsIn(cut.bytes)).toBeGreaterThan(450);
    // Before 0.6.0, the copy and the writing each held the event loop until they were done.
    expect(saving! - copying!).toBeGreaterThanOrEqual(3);
    expect(beats - saving!).toBeGreaterThanOrEqual(3);
  });
});

describe("a PDF page that would hold the server is refused before pdf.js reads it", () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore() });
  const heavy = "Page 1 of this PDF draws far more than its file holds, and reading it would hold the server for a long time.";

  it("refuses a page that paints forms inside forms", async () => {
    // 3 KB: 125,000 forms with text. pdf.js held the event loop for 13 to 14 s reading it.
    const bomb = formsInForms(3, 50);
    expect(bomb.length).toBeLessThan(4_000);
    const started = performance.now();
    await expect(files.ingest({ name: "forms.pdf", bytes: bomb })).rejects.toThrow(heavy);
    expect(performance.now() - started).toBeLessThan(2_000);
    // A few forms inside forms is what real files do.
    expect((await files.ingest({ name: "few.pdf", bytes: formsInForms(2, 3) })).pages).toBe(1);
  });

  it("reads two forms that paint each other, as pdf.js does, and refuses forms that all paint each other", async () => {
    // pdf.js skips a form that is already being painted: A paints B, and B's paint of A is skipped.
    const loop = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "<< /XObject << /A 6 0 R >> /Font << /F1 4 0 R >> >>"), HELVETICA,
      pdfStream("", `/A Do ${textLine("Text.")}`),
      pdfStream(`${FORM} /Resources << /XObject << /B 7 0 R >> >>`, "/B Do"),
      pdfStream(`${FORM} /Resources << /XObject << /A 6 0 R >> >>`, "/A Do")]);
    expect((await files.ingest({ name: "loop.pdf", bytes: loop })).pages).toBe(1);
    // Eight forms with text that each paint all eight: pdf.js follows paths through them until each
    // meets a form already open, and held the event loop for 6 s on this 3 KB file.
    const names = Array.from({ length: 8 }, (_, index) => `/F${index} ${7 + index} 0 R`).join(" ");
    const clique = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "6 0 R"), HELVETICA,
      pdfStream("", "/F0 Do"), `<< /XObject << ${names} >> /Font << /F1 4 0 R >> >>`,
      ...Array.from({ length: 8 }, () => pdfStream(`${FORM} /Resources 6 0 R`, `${textLine("Text.")} /F0 Do /F1 Do /F2 Do /F3 Do /F4 Do /F5 Do /F6 Do /F7 Do`))]);
    const started = performance.now();
    await expect(files.ingest({ name: "clique.pdf", bytes: clique })).rejects.toThrow(heavy);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("reads a list of drawings that many pages share once, not once for each page", async () => {
    // 200 pages with resources of their own that point to one list of 60,000 drawings. Read for each
    // page, a list of 140,000 shared by 300 pages filled 4 GB.
    const names = Array.from({ length: 60_000 }, (_, index) => `/x${index} 5 0 R`).join("");
    const kids = Array.from({ length: 200 }, (_, index) => `${7 + index} 0 R`).join(" ");
    const bytes = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count 200 >>`, `<< ${names} >>`, HELVETICA,
      pdfStream(`${FORM} /Resources << /Font << /F1 4 0 R >> >>`, textLine("Stamp.")), pdfStream("", "/x1 Do"),
      ...Array.from({ length: 200 }, () => page("6 0 R", "<< /XObject 3 0 R /Font << /F1 4 0 R >> >>"))]);
    const parsed = await parsePdf(bytes);
    const started = performance.now();
    await checkPageWork(parsed!.library, parsed!.document, bytes.byteLength);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("PDF names are decoded in time that grows with their length", () => {
  it("gives up on a name escaped more deeply than any writer does", () => {
    expect(canonicalName(nested(3))).toBeUndefined();
    // Decoded until nothing changed, a name of 400,000 characters took 20 s: here it takes four passes.
    const started = performance.now();
    expect(canonicalName(nested(1_000_000))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });

  const files = createLargeFiles({ store: new MemoryDocumentStore() });

  it("ingests a PDF whose resource dictionary has a name of 400,000 characters, at once", async () => {
    const pdf = pdfWithNames({ extraKeys: [nested(200_000)] });
    const started = performance.now();
    const meta = await files.ingest({ name: "key.pdf", bytes: pdf });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(meta.pages).toBe(1);
    expect(await files.tools([meta]).execute("read_document", { document_id: meta.id })).toMatchObject({ text: expect.stringContaining("A page with odd names.") });
  });

  it("ingests a PDF whose content paints names that would each take long to decode, at once", async () => {
    // 40 names of 30,000 characters: 1.2 MB of content, a few kilobytes in the file.
    const content = Array.from({ length: 40 }, () => `q /${nested(15_000)} Do Q`).join("\n");
    const pdf = pdfWithNames({ content });
    expect(pdf.length).toBeLessThan(20_000);
    const started = performance.now();
    const meta = await files.ingest({ name: "content.pdf", bytes: pdf });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(meta.pages).toBe(1);
  });

  it("cuts pages of such files at once, and keeps every drawing a name it cannot read may paint", async () => {
    // With names it can read, the image nothing paints is left out of the cut.
    expect(await drawingsKept((await cutPdfPages(pdfWithNames({ content: "q /#58 Do Q" }), 1, 1, 10_000_000)).bytes)).toBe(1);
    for (const [pdf, entries] of [[pdfWithNames({ extraKeys: [nested(200_000)] }), 3], [pdfWithNames({ content: `q /${nested(30_000)} Do Q` }), 2]] as const) {
      const started = performance.now();
      const cut = await cutPdfPages(pdf, 1, 1, 10_000_000);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect((await pageTexts(cut.bytes))[0]).toContain("Inside the form.");
      expect(await drawingsKept(cut.bytes)).toBe(entries);
    }
  });
});

describe("picture marks: when they are left out", () => {
  it("stops reading a page that paints forms inside forms thousands of times, and marks it", async () => {
    // Each form paints the next one 30 times: 30^5 images from a file of a few kilobytes, which
    // used to take seconds and gigabytes, and then the process.
    const builder = new PdfBuilder();
    let object = builder.image();
    let name = "Im1";
    for (let level = 1; level <= 4; level++) {
      const content = Array.from({ length: 30 }, () => `q 0.5 0 0 0.5 0 0 cm /${name} Do Q`).join("\n");
      object = builder.form(content, `/Resources << /XObject << /${name} ${object} 0 R >> >>`);
      name = `Fm${level}`;
    }
    builder.page(`${textLine("Forms inside forms.")}\n${Array.from({ length: 30 }, () => `q /${name} Do Q`).join("\n")}`, { [name]: object });
    builder.page(textLine("A page of text."));
    const bytes = builder.build();
    expect(bytes.length).toBeLessThan(10_000);
    const started = performance.now();
    expect(marked(await read(bytes))).toEqual([1]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("the headings of a PDF are found in time that grows with its text", () => {
  it("reads 40,000 lines each in a size of its own at once: a few sizes are kept, not one per line", () => {
    // A file of short lines at rising sizes, 0.5 apart: once 20,000 lines were kept, each new one
    // looked through all the sizes kept to drop the smallest, and this took about a minute. It takes
    // about half a second on a busy machine.
    const items = Array.from({ length: 40_000 }, (_, index) => {
      const size = 4 + index * 0.5;
      return { str: "abc", transform: [size, 0, 0, size, 72, 700], width: size * 1.5, height: size, hasEOL: true };
    });
    const started = performance.now();
    const finder = new PdfHeadingFinder();
    for (let page = 0; page < 8; page++) finder.addPage(page + 1, items.slice(page * 5_000, (page + 1) * 5_000));
    expect(finder.headings()).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
