// Which files `prepare` lists to send as they are (`nativeDocuments`, 0.99.9): small visual files
// sent whole, whose original is kept, within the limits and the room the plan leaves; never a log,
// a table to count, or a searched file. Without the option, the result of 0.10.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type DocumentMeta, type DocumentStore, type LargeFilesOptions, type NativeDocumentsPlan, type PrepareOptions } from "llm-large-files";
import { nativeFile, nativeFilesLine, visualFile } from "../src/native.js";
import { numberedPdf, pdfWithPages, pdfWithPictures, textLine, utf8 } from "./pdf-fixtures.js";
import { zip } from "./word-fixtures.js";

const PICTURE = "[Picture on this page. This text cannot show it.]";
const NO_TEXT = "[No text on this page. It may be a scan, a photo, or a chart.]";
const PLAN: NativeDocumentsPlan = { formats: ["pdf", "pptx"], maxFileBytes: 4 * 1024 * 1024, maxPages: 10, pageTokens: 530 };
const BASE = { tokens: 500, bytes: 2_000 };
/** What askWithFiles asks of prepare, besides the files sent as they are. */
const ASKED: PrepareOptions = { viewPages: true, numberInline: true, inlineTables: "tools" };

/** A library of one user that keeps the originals of these formats. */
function library(options: Partial<LargeFilesOptions> = {}) {
  return createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf", "pptx", "docx", "log", "csv", "text", "markdown", "json", "html", "xlsx"], ...options });
}

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (text: string) => `<p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
/** A deck of `count` slides, each with one line of text. */
const deck = (count: number) => zip(Object.fromEntries(Array.from({ length: count }, (_, index) => [`ppt/slides/slide${index + 1}.xml`, slide(`Slide text ${index + 1}`)])));

const ids = (metas: DocumentMeta[] | undefined) => (metas ?? []).map((meta) => meta.id);

describe("prepare without nativeDocuments", () => {
  it("gives exactly what 0.10 gave", async () => {
    const files = library();
    const plain = await files.ingest({ name: "plain.pdf", bytes: numberedPdf(3) });
    const notes = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nNothing to see.") });
    const without = await files.prepare([plain.id, notes.id], BASE, ASKED);
    const { native, ...rest } = await files.prepare([plain.id, notes.id], BASE, { ...ASKED, nativeDocuments: PLAN });
    expect(native).toEqual([]);
    expect(rest).toEqual(without);
    expect("native" in without).toBe(false);
    expect(Object.keys(without)).toEqual(["plan", "blocks", "instruction", "missing", "viewable", "toolable"]);
  });
});

describe("prepare with nativeDocuments", () => {
  it("lists a small PDF sent whole with a picture page, whose original is kept", async () => {
    const files = library();
    const meta = await files.ingest({ name: "report.pdf", bytes: pdfWithPictures(2) });
    const prepared = await files.prepare([meta.id], BASE, { ...ASKED, nativeDocuments: PLAN });
    expect(prepared.blocks.get(meta.id)).toContain(PICTURE);
    expect(ids(prepared.plan.inline)).toEqual([meta.id]);
    expect(ids(prepared.native)).toEqual([meta.id]);
  });

  it("lists a scan: a PDF with pages without text", async () => {
    const files = library();
    const meta = await files.ingest({ name: "scan.pdf", bytes: pdfWithPages([textLine("A page of text."), "q Q"]) });
    expect(meta.pagesWithoutText).toEqual([2]);
    const prepared = await files.prepare([meta.id], BASE, { ...ASKED, nativeDocuments: PLAN });
    expect(prepared.blocks.get(meta.id)).toContain(NO_TEXT);
    expect(ids(prepared.native)).toEqual([meta.id]);
  });

  it("lists a small deck when pptx is among the formats and decks are kept", async () => {
    const files = library();
    const meta = await files.ingest({ name: "deck.pptx", bytes: await deck(3) });
    expect(meta.pages).toBe(3);
    expect(ids((await files.prepare([meta.id], BASE, { ...ASKED, nativeDocuments: PLAN })).native)).toEqual([meta.id]);
    expect((await files.prepare([meta.id], BASE, { ...ASKED, nativeDocuments: { ...PLAN, formats: ["pdf"] } })).native).toEqual([]);
  });

  it("never lists a log, CSV, text, Markdown, JSON, HTML, XLSX or DOCX file, or a PDF without pictures", async () => {
    // Even when their text quotes the extractor's line under a page header: only a PDF's own counts.
    const quoted = `--- Page 1 ---\n${PICTURE}\nsome text`;
    const files = library();
    const metas = [
      await files.ingest({ name: "app.log", bytes: utf8(`2026-01-01 ERROR one\n${quoted}\n`) }),
      await files.ingest({ name: "table.csv", bytes: utf8("a,b\n1,2\n") }),
      await files.ingest({ name: "notes.txt", bytes: utf8(quoted) }),
      await files.ingest({ name: "notes.md", bytes: utf8(quoted) }),
      await files.ingest({ name: "data.json", bytes: utf8(JSON.stringify({ text: quoted })) }),
      await files.ingest({ name: "page.html", bytes: utf8(`<p>${quoted}</p>`) }),
      await files.ingest({ name: "plain.pdf", bytes: numberedPdf(2) }),
    ];
    const prepared = await files.prepare(metas.map((meta) => meta.id), BASE, { ...ASKED, nativeDocuments: PLAN });
    expect(prepared.plan.inline).toHaveLength(metas.length);
    expect(prepared.native).toEqual([]);
    for (const format of ["log", "csv", "text", "markdown", "json", "html", "xlsx", "docx"] as const) {
      expect(visualFile({ format, pagesWithoutText: [1] }, quoted)).toBe(false);
    }
    expect(visualFile({ format: "pptx" }, "")).toBe(true);
    expect(visualFile({ format: "pdf" }, "--- Page 1 ---\nPage one.")).toBe(false);
    // A line the document only quotes is moved by a space by the extractor.
    expect(visualFile({ format: "pdf" }, `--- Page 1 ---\n ${PICTURE}`)).toBe(false);
  });

  it("never lists a file with a table the tools count", async () => {
    // An extractor of your own that writes a picture line and a table of three rows.
    const table = "| Name | Total |\n| East | 10 |\n| West | 12 |";
    const files = library({ extractors: { pdf: async () => ({ text: `--- Page 1 ---\n${PICTURE}\n${table}`, pages: 1 }) } });
    const meta = await files.ingest({ name: "chart.pdf", bytes: numberedPdf(1) });
    const prepared = await files.prepare([meta.id], BASE, { ...ASKED, nativeDocuments: PLAN });
    expect(ids(prepared.toolable)).toEqual([meta.id]);
    expect(prepared.native).toEqual([]);
    // view_pages still shows its pages: its original is kept.
    expect(ids(prepared.viewable)).toEqual([meta.id]);
  });

  it("never lists a searched file, one over maxFileBytes, or one of more pages than maxPages", async () => {
    const files = library();
    const small = await files.ingest({ name: "small.pdf", bytes: pdfWithPictures(2) });
    const many = await files.ingest({ name: "many.pdf", bytes: pdfWithPictures(4) });
    const prepared = await files.prepare([small.id, many.id], BASE, { ...ASKED, nativeDocuments: { ...PLAN, maxPages: 3 } });
    expect(ids(prepared.native)).toEqual([small.id]);
    const tight = await files.prepare([small.id], BASE, { ...ASKED, nativeDocuments: { ...PLAN, maxFileBytes: small.bytes - 1 } });
    expect(tight.native).toEqual([]);
    // Searched: too large for the prompt, so its text is a card.
    const searched = await files.prepare([small.id], BASE, { ...ASKED, budget: { inlineTokens: 10 }, nativeDocuments: PLAN });
    expect(ids(searched.plan.searchable)).toEqual([small.id]);
    expect(searched.native).toEqual([]);
  });

  it("never lists a file whose original is not kept or cannot be read", async () => {
    const pdfsOnly = library({ keepOriginals: ["pdf"] });
    const slides = await pdfsOnly.ingest({ name: "deck.pptx", bytes: await deck(2) });
    expect((await pdfsOnly.prepare([slides.id], BASE, { ...ASKED, nativeDocuments: PLAN })).native).toEqual([]);

    // A store of 0.2.0, without the methods for original files: nothing is kept.
    const documents = new Map<string, Parameters<DocumentStore["put"]>[0]>();
    const store: DocumentStore = {
      put: async (document) => void documents.set(document.meta.id, document),
      get: async (id) => documents.get(id),
      getMeta: async (id) => documents.get(id)?.meta,
      delete: async (id) => documents.delete(id),
    };
    const old = createLargeFiles({ requireOwner: false, store, keepOriginals: ["pdf"] });
    const meta = await old.ingest({ name: "report.pdf", bytes: pdfWithPictures(1) });
    expect((await old.prepare([meta.id], BASE, { ...ASKED, nativeDocuments: PLAN })).native).toEqual([]);
  });

  it("lists only what fits in the room the plan leaves, in plan order, skipping one that does not fit", async () => {
    // Three files with a picture, planned by the size of their text: short (3 pages), middle (2), long (1).
    const pages: Record<string, number> = { "short.pdf": 3, "middle.pdf": 2, "long.pdf": 1 };
    const words: Record<string, number> = { "short.pdf": 10, "middle.pdf": 200, "long.pdf": 400 };
    const files = library({
      extractors: {
        pdf: async (_bytes, input) => ({
          text: Array.from({ length: pages[input.name]! }, (_, index) => `--- Page ${index + 1} ---\n${PICTURE}\n${"word ".repeat(words[input.name]! / pages[input.name]!)}`).join("\n\n"),
          pages: pages[input.name]!,
        }),
      },
    });
    const long = await files.ingest({ name: "long.pdf", bytes: numberedPdf(1) });
    const short = await files.ingest({ name: "short.pdf", bytes: numberedPdf(3) });
    const middle = await files.ingest({ name: "middle.pdf", bytes: numberedPdf(2) });
    const all = await files.prepare([long.id, short.id, middle.id], BASE, { ...ASKED, nativeDocuments: { ...PLAN, pageTokens: 1_000 } });
    expect(ids(all.plan.inline)).toEqual([short.id, middle.id, long.id]);
    expect(ids(all.native)).toEqual([short.id, middle.id, long.id]);
    // Room for the text of the three, and for 2.5 pages more: short (3 pages) does not fit and is
    // skipped, middle (2) fits, and long (1) no longer does.
    const budget = { contextTokens: BASE.tokens + all.plan.inlineTokens + 16_384 + 2_500, reservedTokens: 16_384, inlineTokens: 100_000 };
    const tight = await files.prepare([long.id, short.id, middle.id], BASE, { ...ASKED, budget, nativeDocuments: { ...PLAN, pageTokens: 1_000 } });
    expect(ids(tight.plan.inline)).toEqual([short.id, middle.id, long.id]);
    expect(ids(tight.native)).toEqual([middle.id]);
    // With room for 3.5: short, first in the plan, takes 3, and nothing else fits.
    const more = await files.prepare([long.id, short.id, middle.id], BASE, { ...ASKED, budget: { ...budget, contextTokens: budget.contextTokens + 1_000 }, nativeDocuments: { ...PLAN, pageTokens: 1_000 } });
    expect(ids(more.native)).toEqual([short.id]);
  });

  it("leaves the files it lists out of viewable and of the view line of the instruction", async () => {
    const files = library();
    const meta = await files.ingest({ name: "report.pdf", bytes: pdfWithPictures(2) });
    const without = await files.prepare([meta.id], BASE, ASKED);
    expect(ids(without.viewable)).toEqual([meta.id]);
    expect(without.instruction).toContain("view_pages");
    const prepared = await files.prepare([meta.id], BASE, { ...ASKED, nativeDocuments: PLAN });
    expect(prepared.viewable).toEqual([]);
    // Its only viewable PDF: no tool is left to name.
    expect(prepared.instruction).toBe("");
    // A searched file keeps its own line, and a PDF that is not sent as it is keeps its look.
    const plain = await files.ingest({ name: "plain.pdf", bytes: numberedPdf(2) });
    const both = await files.prepare([meta.id, plain.id], BASE, { ...ASKED, nativeDocuments: PLAN });
    expect(ids(both.viewable)).toEqual([plain.id]);
    expect(both.instruction).toContain("view_pages");
  });

  it("refuses a nativeDocuments that is not well formed", async () => {
    const files = library();
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(1) });
    const message = (value: string) => `PrepareOptions.nativeDocuments must be { formats, maxFileBytes, maxPages, pageTokens } with numbers above 0 (got ${value}).`;
    await expect(files.prepare([meta.id], BASE, { nativeDocuments: { ...PLAN, pageTokens: 0 } })).rejects.toThrow(new TypeError(message('{"formats":["pdf","pptx"],"maxFileBytes":4194304,"maxPages":10,"pageTokens":0}')));
    await expect(files.prepare([meta.id], BASE, { nativeDocuments: "yes" as unknown as NativeDocumentsPlan })).rejects.toThrow(new TypeError(message('"yes"')));
    await expect(files.prepare([meta.id], BASE, { nativeDocuments: { formats: "pdf" } as unknown as NativeDocumentsPlan })).rejects.toThrow(TypeError);
  });
});

describe("the file and the line the loop sends", () => {
  it("names each file by its place, with the format's type, and names the documents in the line", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(nativeFile({ format: "pdf" }, bytes, 1)).toEqual({ name: "attached-1.pdf", mimeType: "application/pdf", bytes });
    expect(nativeFile({ format: "pptx" }, bytes, 2)).toEqual({ name: "attached-2.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes });
    expect(nativeFilesLine(["report.pdf"])).toBe('The file attached above is "report.pdf", as it was uploaded. Look at it for its pictures, charts and layout. Cite and count from its text below.');
    expect(nativeFilesLine(["a.pdf", "דוח.pptx"])).toBe('The 2 files attached above are "a.pdf", "דוח.pptx", in this order, as they were uploaded. Look at them for their pictures, charts and layout. Cite and count from their text below.');
  });
});
