import "./load-pdf-libraries.js";
import { deflateSync } from "node:zlib";
import { PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { canonicalName, cutPdfPages } from "../src/pdf-pages.js";
import { HELVETICA, pdfFromObjects, pdfStream, textLine } from "./pdf-fixtures.js";

/** A name that loses one "#23" each time it is decoded: `levels` + 1 decodings make it "A". */
const nested = (levels: number) => `#${"23".repeat(levels)}41`;

const FORM = "/Type /XObject /Subtype /Form /BBox [0 0 612 792]";

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

describe("PDF names are decoded in time that grows with their length", () => {
  it("reads a name as the characters it stands for, also when a library kept an escape", () => {
    expect(canonicalName("Im1")).toBe("Im1");
    expect(canonicalName("I#31")).toBe("I1");
    expect(canonicalName("A#20B")).toBe("A B");
    // pdf-lib may hand over "#41" for a name the file wrote "#2341": both stand for "A".
    expect(canonicalName(nested(1))).toBe("A");
    expect(canonicalName(nested(2))).toBe("A");
  });

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
