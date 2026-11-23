// @cantoo/pdf-lib reads the whole file into objects before a page can be cut or checked, and
// cannot be stopped once it has started. It pauses for other requests by time, not by a count of
// objects: in the 0.6 review, a file of 4,006 objects never paused, and objects differ in cost
// a hundred times. A look at pages then copies the pages into a new file and writes it: that
// pauses too. The tests that count those pauses are in test/timing/pdf.timing.test.ts: they hold
// the work to the clock. The tests here check the cut itself: made in turns, it is the cut made at
// once.
import "./load-pdf-libraries.js";
import * as pdfLib from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { cutPdfPages } from "../src/pdf-pages.js";
import { heavyPdf, HELVETICA, layeredPdf, numberedPdf, pdfFromObjects, pdfStream, pdfWithPictures, textLine } from "./pdf-fixtures.js";

/** How many objects a PDF holds. */
async function objectsIn(bytes: Uint8Array): Promise<number> {
  return (await pdfLib.PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
}

describe("cutting pages out of a PDF lets other work run", () => {
  // The page refers to 450 arrays of 1,200 numbers: copying them into the cut, and writing the cut,
  // each take longer than several slices of work.
  const heavy = heavyPdf(450, 1_200, true);

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
