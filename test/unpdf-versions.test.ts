// Versions of unpdf that would stop the process on a supported version of Node are refused with a
// message that says what to install. In the 0.6 review, unpdf 1.5.0 to 1.6.0 stopped the whole
// process at the first PDF on Node 22.12 (and on Node 20, no longer supported since 0.9.0).
//
// The CI job "unpdf versions" runs this file with other versions of unpdf installed, and sets
// UNPDF_EXPECT to "refused" where the version cannot run on that Node.
import * as unpdf from "unpdf";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { checkUnpdf } from "../src/extract.js";
import { numberedPdf } from "./pdf-fixtures.js";

// pdf.js and pdf-lib are loaded before the tests, as load-pdf-libraries.ts does. A pdf.js that
// cannot load on this Node must not stop the file: the tests expect it to be refused.
await Promise.all([unpdf.getResolvedPDFJS().catch(() => undefined), import("@cantoo/pdf-lib")]);

const REFUSED = /^The unpdf installed would stop the whole server at the first PDF file on Node \d+, /;

/** Runs `work` on a Node without `Promise.try`, as Node 22 is, then puts it back as it was. */
async function withoutPromiseTry<T>(work: () => Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(Promise, "try");
  delete (Promise as { try?: unknown }).try;
  try {
    return await work();
  } finally {
    if (saved) Object.defineProperty(Promise, "try", saved);
    else delete (Promise as { try?: unknown }).try;
  }
}

/** What unpdf 1.6.1 and later do when they load pdf.js on a Node without `Promise.try`. */
function addPromiseTry(): void {
  Object.defineProperty(Promise, "try", {
    configurable: true,
    writable: true,
    value: function <T>(this: PromiseConstructor, run: (...args: unknown[]) => T, ...args: unknown[]) {
      return new this<T>((resolve) => resolve(run(...args)));
    },
  });
}

describe("the unpdf installed", () => {
  it("reads PDFs on this Node, or is refused with a message that says what to install", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const reading = files.ingest({ name: "book.pdf", bytes: numberedPdf(2) });
    if (process.env.UNPDF_EXPECT === "refused") {
      await expect(reading).rejects.toThrow(REFUSED);
    } else {
      expect((await reading).pages).toBe(2);
    }
  });
});

describe("checkUnpdf", () => {
  it("passes on the error of a pdf.js that could not be loaded, with no advice for a Node it does not support", async () => {
    // Until 0.9.0, on Node 20, this error was wrapped with advice to install unpdf 1.7.0.
    const reason = new Error("Serverless PDF.js bundle could not be resolved: ReferenceError: Iterator is not defined");
    await expect(checkUnpdf({ getResolvedPDFJS: () => Promise.reject(reason) }, "20.19.0")).rejects.toBe(reason);
    await expect(checkUnpdf({ getResolvedPDFJS: () => Promise.reject(reason) }, "22.12.0")).rejects.toBe(reason);
  });

  it("refuses an unpdf that would stop the process, where Node has no Promise.try", async () => {
    // unpdf 1.5.0 to 1.6.0 load pdf.js without adding Promise.try, which Node 22 does not have.
    const withoutIt = { getResolvedPDFJS: () => Promise.resolve({}) };
    await withoutPromiseTry(async () => {
      await expect(checkUnpdf(withoutIt, "22.12.0")).rejects.toThrow(
        "The unpdf installed would stop the whole server at the first PDF file on Node 22, so PDF files are not read. Install unpdf 1.6.1 or later, or run Node 24 or later.",
      );
      // No advice for Node 20 any more: it is told what Node 22 is told.
      await expect(checkUnpdf(withoutIt, "20.19.0")).rejects.toThrow(
        "The unpdf installed would stop the whole server at the first PDF file on Node 20, so PDF files are not read. Install unpdf 1.6.1 or later, or run Node 24 or later.",
      );
      // Node 24 has Promise.try: only an app that removed it gets here.
      await expect(checkUnpdf(withoutIt, "24.19.0")).rejects.toThrow(
        "The unpdf installed would stop the whole server at the first PDF file on Node 24, so PDF files are not read. Install unpdf 1.6.1 or later.",
      );
    });
  });

  it("accepts an unpdf that adds Promise.try when it loads pdf.js, and the real one installed", async () => {
    await withoutPromiseTry(async () => {
      await expect(checkUnpdf({ getResolvedPDFJS: async () => addPromiseTry() }, "22.12.0")).resolves.toBeUndefined();
    });
    if (process.env.UNPDF_EXPECT !== "refused") await expect(checkUnpdf(unpdf)).resolves.toBeUndefined();
    await expect(checkUnpdf({})).resolves.toBeUndefined();
  });

  it("keeps the PDF extractor from stopping the process where pdf.js would need Promise.try", async () => {
    // pdf.js is loaded, and with it the Promise.try that unpdf adds. Without it, as with unpdf 1.5.0
    // on Node 22, reading a PDF threw where nothing could catch it, and the test process stopped.
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await withoutPromiseTry(async () => {
      const reading = files.ingest({ name: "book.pdf", bytes: numberedPdf(2) });
      if (process.env.UNPDF_EXPECT === "refused") await expect(reading).rejects.toThrow(REFUSED);
      else await expect(reading).rejects.toThrow(/^The unpdf installed would stop the whole server at the first PDF file on Node \d+, so PDF files are not read\. Install unpdf /);
    });
    // Put back, PDFs are read again.
    if (process.env.UNPDF_EXPECT !== "refused") expect((await files.ingest({ name: "book.pdf", bytes: numberedPdf(2) })).pages).toBe(2);
  });
});
