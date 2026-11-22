// @cantoo/pdf-lib reads the whole file into objects before a page can be cut or checked, and
// cannot be stopped once it has started. It pauses for other requests by time, not by a count of
// objects: in the 0.6 review, a file of 4,006 objects never paused, and objects differ in cost
// a hundred times. A look at pages then copies the pages into a new file and writes it: that
// pauses too.
import "./load-pdf-libraries.js";
import * as pdfLib from "@cantoo/pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { cutPdfPages, loadPdf, objectsPerTick, OBJECTS_PER_TICK } from "../src/pdf-pages.js";
import { HELVETICA, layeredPdf, numberedPdf, pdfFromObjects, pdfStream, pdfWithPictures, textLine } from "./pdf-fixtures.js";

/** Counts the beats of a 2 ms timer while `work` runs: 0 when the work never lets a timer run. */
async function beatsDuring<T>(work: () => Promise<T>): Promise<{ beats: number; result: T }> {
  let beats = 0;
  const timer = setInterval(() => beats++, 2);
  try {
    const result = await work();
    return { beats, result };
  } finally {
    clearInterval(timer);
  }
}

/**
 * A one-page PDF with `count` more objects that each hold an array of `size` numbers: fewer objects
 * than a count of `OBJECTS_PER_TICK` pauses for, each far slower to parse than a page. With
 * `referred`, the page refers to them all (under a key of its own), so a cut of the page copies them.
 */
function heavyPdf(count = 450, size = 1_200, referred = false): Uint8Array {
  const numbers = `[${Array.from({ length: size }, (_, index) => index % 1_000).join(" ")}]`;
  const references = referred ? ` /Heavy [${Array.from({ length: count }, (_, index) => `${6 + index} 0 R`).join(" ")}]` : "";
  return pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    HELVETICA,
    `<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >>${references} >>`,
    pdfStream("", textLine("A page among many large arrays.")),
    ...Array.from({ length: count }, () => numbers),
  ]);
}

/** How many objects a PDF holds. */
async function objectsIn(bytes: Uint8Array): Promise<number> {
  return (await pdfLib.PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
}

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

  it("adds the objects of a cut to its list of objects without searching the whole list for each", async () => {
    // pdf-lib's writer searched the entries it had for the place of each new one: the time grew
    // with the square of the objects in the cut, and 20,000 objects held the server for 0.5 s.
    const count = 3_000;
    const many = pdfFromObjects([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      HELVETICA,
      `<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> /Heavy [${Array.from({ length: count }, (_, index) => `${6 + index} 0 R`).join(" ")}] >>`,
      pdfStream("", textLine("A page that refers to many small objects.")),
      ...Array.from({ length: count }, (_, index) => `[${index}]`),
    ]);
    // The first cut readies pdf-lib's writer; the second is counted.
    await cutPdfPages(many, 1, 1, 10_000_000);
    const { PDFCrossRefStream } = pdfLib;
    const create = PDFCrossRefStream.create;
    let searches = 0;
    PDFCrossRefStream.create = (dictionary, encode) => {
      const stream = create(dictionary, encode);
      const entries = (stream as unknown as { entries: unknown[] }).entries;
      const search = entries.findIndex;
      Object.defineProperty(entries, "findIndex", {
        value: function (this: unknown[], ...args: Parameters<typeof search>) {
          searches++;
          return search.apply(this, args);
        },
      });
      return stream;
    };
    let cut: Awaited<ReturnType<typeof cutPdfPages>>;
    try {
      cut = await cutPdfPages(many, 1, 1, 10_000_000);
    } finally {
      PDFCrossRefStream.create = create;
    }
    expect(await objectsIn(cut.bytes)).toBeGreaterThan(count);
    // Before 0.6.0: one search for each object, and one for each stream of 50 objects.
    expect(searches).toBeLessThan(10);
  });

  it("writes the same cut, to the byte, as when the copier copied everything at once", { timeout: 20_000 }, async () => {
    // Some producers reuse a page object: here the page tree lists A, B, A.
    const twice = pdfFromObjects([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [4 0 R 6 0 R 4 0 R] /Count 3 /MediaBox [0 0 612 792] >>",
      HELVETICA,
      "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
      pdfStream("", textLine("Page A.")),
      "<< /Type /Page /Parent 2 0 R /Contents 7 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
      pdfStream("", textLine("Page B.")),
    ]);
    const restricted = await pdfLib.PDFDocument.load(numberedPdf(4), { updateMetadata: false });
    restricted.encrypt({ ownerPassword: "owner-secret", permissions: { printing: false, copying: false, modifying: false } });
    const cases: Array<[Uint8Array, number, number]> = [
      [heavy, 1, 1],
      [layeredPdf(), 1, 2],
      [pdfWithPictures(6, { links: true }), 2, 4],
      [pdfWithPictures(6, { shared: true, links: true }), 3, 5],
      [pdfWithPictures(4, { sharedThroughForm: true }), 1, 1],
      [twice, 1, 3],
      [await restricted.save(), 2, 3],
    ];
    const { PDFObjectCopier } = pdfLib;
    const copierFor = PDFObjectCopier.for;
    for (const [file, from, to] of cases) {
      const inTurns = await cutPdfPages(file, from, to, 10_000_000);
      // A copier that keeps out of sight what it has copied is left to copy everything at once.
      PDFObjectCopier.for = (source, target) => new Proxy(copierFor(source, target), {
        get: (copier, key) => (key === "traversedObjects" ? undefined : Reflect.get(copier, key)),
      });
      let atOnce: Awaited<ReturnType<typeof cutPdfPages>>;
      try {
        atOnce = await cutPdfPages(file, from, to, 10_000_000);
      } finally {
        PDFObjectCopier.for = copierFor;
      }
      expect({ from: inTurns.from, to: inTurns.to, pages: inTurns.pageCount }).toEqual({ from: atOnce.from, to: atOnce.to, pages: atOnce.pageCount });
      expect(Buffer.from(inTurns.bytes).equals(Buffer.from(atOnce.bytes))).toBe(true);
    }
  });
});
