import { PDFDocument } from "@cantoo/pdf-lib";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, TOOL_NAMES, toolResultSummary, type DocumentStore, type ToolOutput } from "../src/index.js";
import { cutPdfPages, declaredObjectCount } from "../src/pdf-pages.js";
import { SearchableDocument } from "../src/search.js";
import { createDocumentTools } from "../src/tools.js";
import { layeredPdf, numberedPdf, pdfFromObjects, pdfWithPictures, utf8 } from "./pdf-fixtures.js";

// ---------- Reading a cut back with pdf.js, which did not write it ----------

async function open(bytes: Uint8Array) {
  return getDocumentProxy(new Uint8Array(bytes));
}

/** The text of every page of a PDF. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const document = await open(bytes);
  const texts: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const content = await (await document.getPage(number)).getTextContent();
    texts.push((content.items as Array<{ str?: string }>).map((item) => item.str ?? "").join("").trim());
  }
  return texts;
}

/** How many images each page of a PDF paints. */
async function imagesPainted(bytes: Uint8Array): Promise<number[]> {
  const document = await open(bytes);
  const counts: number[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const list = await (await document.getPage(number)).getOperatorList();
    // The operator that paints an image carries its name and its size in pixels.
    counts.push((list.argsArray as unknown[]).filter((args) => Array.isArray(args) && typeof args[0] === "string" && /^(img_|g_)/.test(args[0]) && typeof args[1] === "number" && typeof args[2] === "number").length);
  }
  return counts;
}

const pageLine = (number: number) => `Page ${number} of the test file.`;
/** Byte for byte the same. (toEqual walks a large array element by element.) */
const sameBytes = (left: Uint8Array, right: Uint8Array) => Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(right);

/** A library that keeps PDFs, one PDF in it, and tools that may show its pages. */
async function withPdf(bytes: Uint8Array, name = "report.pdf") {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
  const meta = await files.ingest({ name, bytes });
  const tools = files.tools([meta], { viewPages: true });
  const view = (args: Record<string, unknown>, limits?: Parameters<typeof tools.executeWithFiles>[2]): Promise<ToolOutput> =>
    tools.executeWithFiles(TOOL_NAMES.view, { document_id: meta.id, ...args }, limits);
  return { store, files, meta, tools, view };
}

const names = (tools: { declarations: Array<{ name: string }> }) => tools.declarations.map((declaration) => declaration.name);
const TEXT_TOOLS = ["search_document", "read_document", "get_document_overview"];

// ---------- When the tool is on offer ----------

describe("view_pages: when it is declared", () => {
  const pdf = numberedPdf(3);

  it("is not declared unless the caller says its loop can deliver files", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdf });
    expect(names(files.tools([meta]))).toEqual(TEXT_TOOLS);
    expect(names(files.tools([meta], { viewPages: false }))).toEqual(TEXT_TOOLS);
    expect(names(files.tools([meta], { viewPages: true }))).toEqual([...TEXT_TOOLS, "view_pages"]);
  });

  it("is declared only for a PDF whose original file is kept", async () => {
    const without = createLargeFiles({ store: new MemoryDocumentStore() });
    const textOnly = await without.ingest({ name: "report.pdf", bytes: pdf });
    expect(names(without.tools([textOnly], { viewPages: true }))).toEqual(TEXT_TOOLS);

    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf", "markdown"] });
    const notes = await files.ingest({ name: "notes.md", bytes: utf8("# Notes") });
    expect(notes.originalKept).toBe(true);
    // A kept original is not enough: only PDFs have pages to cut.
    expect(names(files.tools([notes], { viewPages: true }))).toEqual(TEXT_TOOLS);
  });

  it("is the only tool for a PDF that is not searched, because its text is already in the prompt", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const report = await files.ingest({ name: "report.pdf", bytes: pdf });
    const log = await files.ingest({ name: "app.log", bytes: utf8("2026-01-01 10:00:00 INFO started\n".repeat(20)) });
    const viewOnly = files.tools([], { viewPages: [report] });
    expect(names(viewOnly)).toEqual(["view_pages"]);
    expect(viewOnly.has("search_document")).toBe(false);
    expect((await viewOnly.executeWithFiles("view_pages", { document_id: report.id, from_page: 1 })).files).toHaveLength(1);
    // A searched log next to it: the text tools are for the log, the pages for the PDF.
    const both = files.tools([log], { viewPages: [report], generate: async () => "" });
    expect(names(both)).toEqual([...TEXT_TOOLS, "analyze_whole_document", "view_pages"]);
    expect(await both.execute("search_document", { document_id: report.id, query: "Page" })).toEqual({ error: expect.stringContaining("Unknown document_id") });
    expect((await both.executeWithFiles("view_pages", { document_id: log.id, from_page: 1 })).result).toEqual({ error: "The pages of app.log cannot be shown: only its text was kept. Answer from the text." });
  });

  it("is not declared with a store that cannot return original files", async () => {
    const documents = new Map<string, { meta: never; text: string }>();
    const store: DocumentStore = {
      put: async (document) => void documents.set(document.meta.id, document as never),
      get: async (id) => documents.get(id),
      getMeta: async (id) => documents.get(id)?.meta,
      delete: async (id) => documents.delete(id),
    };
    const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdf });
    expect(names(files.tools([meta], { viewPages: true }))).toEqual(TEXT_TOOLS);
    // Metadata that claims an original, from another store: still nothing to cut from.
    expect(names(files.tools([{ ...meta, originalKept: true }], { viewPages: true }))).toEqual(TEXT_TOOLS);
    // The same one level down: a list of PDFs to show is worth nothing without a way to load them.
    const direct = createDocumentTools({ load: async () => undefined, documentIds: [meta.id], viewableIds: [meta.id], budget: files.budget });
    expect(names(direct)).toEqual(TEXT_TOOLS);
    expect(await direct.executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 })).toEqual({ result: { error: "Unknown tool view_pages." }, files: [] });
  });
});

// ---------- The pages ----------

describe("view_pages: the pages it returns", () => {
  it("returns the pages asked for as one PDF, next to a short result", async () => {
    const { view, tools, meta } = await withPdf(numberedPdf(6));
    const { result, files } = await view({ from_page: 2, to_page: 3 });
    expect(result).toEqual({ document: "report.pdf", pages: "2-3", total_pages: 6, file: "pages-2-3.pdf" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "pages-2-3.pdf", mimeType: "application/pdf" });
    expect(await pageTexts(files[0]!.bytes)).toEqual([pageLine(2), pageLine(3)]);

    const one = await view({ from_page: 6 });
    expect(one.result).toEqual({ document: "report.pdf", pages: "6", total_pages: 6, file: "pages-6.pdf" });
    expect(await pageTexts(one.files[0]!.bytes)).toEqual([pageLine(6)]);

    expect(tools.describe("view_pages", { document_id: meta.id, from_page: 2, to_page: 3 })).toBe("Look at report.pdf pages 2-3");
    expect(tools.describe("view_pages", { document_id: meta.id, from_page: 6 })).toBe("Look at report.pdf page 6");
  });

  it("gives the same bytes for the same pages", async () => {
    const { view } = await withPdf(pdfWithPictures(4));
    const first = await view({ from_page: 2, to_page: 3 });
    const second = await view({ from_page: 2, to_page: 3 });
    expect(sameBytes(second.files[0]!.bytes, first.files[0]!.bytes)).toBe(true);
  });

  it("refuses page numbers that make no sense, and says what the file has", async () => {
    const { view } = await withPdf(numberedPdf(6));
    const error = async (args: Record<string, unknown>) => {
      const output = await view(args);
      expect(output.files).toEqual([]);
      return output.result.error;
    };
    expect(await error({})).toBe("from_page must be a page number: 1 or higher.");
    expect(await error({ from_page: 0 })).toBe("from_page must be a page number: 1 or higher.");
    expect(await error({ from_page: "first" })).toBe("from_page must be a page number: 1 or higher.");
    expect(await error({ from_page: 2, to_page: -1 })).toBe("to_page must be a page number: 1 or higher.");
    expect(await error({ from_page: 4, to_page: 2 })).toBe("to_page (2) is before from_page (4).");
    expect(await error({ from_page: 7 })).toBe("report.pdf has 6 pages. There is no page 7.");
    expect(await error({ document_id: "" })).toBe("document_id is required.");
    // A model sometimes sends numbers as text.
    expect((await view({ from_page: "2", to_page: "3" })).result).toMatchObject({ pages: "2-3" });
    // Past the end is not an error: the pages that exist are shown, and nothing is left to continue with.
    const tail = await view({ from_page: 5, to_page: 9 });
    expect(tail.result).toEqual({ document: "report.pdf", pages: "5-6", total_pages: 6, file: "pages-5-6.pdf" });
    expect(await pageTexts(tail.files[0]!.bytes)).toEqual([pageLine(5), pageLine(6)]);
  });

  it("shows at most five pages a call, and says where to go on", async () => {
    const { view } = await withPdf(numberedPdf(12));
    const { result, files } = await view({ from_page: 1, to_page: 20 });
    expect(result).toEqual({
      document: "report.pdf", pages: "1-5", total_pages: 12, file: "pages-1-5.pdf", next_page: 6,
      note: "Showing 5 of the 12 pages asked for: one call shows at most 5. Call view_pages from page 6 if you need them.",
    });
    expect(await pageTexts(files[0]!.bytes)).toEqual([1, 2, 3, 4, 5].map(pageLine));
    expect(toolResultSummary("Look at report.pdf pages 1-20", result)).toBe(" — got pages 1-5");
    expect(toolResultSummary("Look at report.pdf pages 1-5", (await view({ from_page: 1, to_page: 5 })).result)).toBe("");
    expect(toolResultSummary("Look at report.pdf page 12", (await view({ from_page: 12 })).result)).toBe("");
    expect(toolResultSummary("Look at report.pdf page 99", (await view({ from_page: 99 })).result)).toBe(" — failed: report.pdf has 12 pages. There is no page 99.");
  });

  it("shows fewer pages when the caller has fewer left for the question, and none when none are left", async () => {
    const { view } = await withPdf(numberedPdf(12));
    const few = await view({ from_page: 3, to_page: 7 }, { maxPages: 2 });
    expect(few.result).toEqual({
      document: "report.pdf", pages: "3-4", total_pages: 12, file: "pages-3-4.pdf",
      note: "Showing 2 of the 5 pages asked for: no more pages can be looked at for this question.",
    });
    expect(await pageTexts(few.files[0]!.bytes)).toEqual([pageLine(3), pageLine(4)]);
    const none = await view({ from_page: 3 }, { maxPages: 0 });
    expect(none).toEqual({ result: { error: "No more pages can be looked at for this question. Answer from the pages and the text you already have." }, files: [] });
    // A limit that is not a number is ignored, not obeyed as zero.
    expect((await view({ from_page: 3, to_page: 4 }, { maxPages: Number.NaN, maxFileBytes: Number.NaN })).result).toMatchObject({ pages: "3-4" });
  });

  it("leaves pages off the end when they do not fit in the bytes that are left", async () => {
    // Each page carries a picture of 60,000 bytes.
    const { view } = await withPdf(pdfWithPictures(6));
    const all = await view({ from_page: 1, to_page: 5 });
    expect(all.result).toMatchObject({ pages: "1-5" });
    expect(all.files[0]!.bytes.length).toBeGreaterThan(5 * 60_000);
    expect(all.files[0]!.bytes.length).toBeLessThan(5 * 60_000 + 6_000);

    const two = await view({ from_page: 1, to_page: 5 }, { maxFileBytes: 150_000 });
    expect(two.result).toEqual({
      document: "report.pdf", pages: "1-2", total_pages: 6, file: "pages-1-2.pdf", next_page: 3,
      note: "Showing 2 of the 5 pages asked for: the others did not fit in this request. Call view_pages from page 3 if you need them.",
    });
    expect(two.files[0]!.bytes.length).toBeLessThanOrEqual(150_000);
    expect(await pageTexts(two.files[0]!.bytes)).toEqual([pageLine(1), pageLine(2)]);
    expect(await imagesPainted(two.files[0]!.bytes)).toEqual([1, 1]);

    const none = await view({ from_page: 1, to_page: 5 }, { maxFileBytes: 50_000 });
    expect(none.files).toEqual([]);
    expect(none.result.error).toMatch(/^report\.pdf: Page 1 is \d+ KB as a file, more than the 49 KB that fit in this request\.$/);
    expect((await view({ from_page: 1 }, { maxFileBytes: 500 })).result).toEqual({ error: "There is no room left in this request to show more pages. Answer from the pages and the text you already have." });
  });

  it("uses about a third of the request limit when the caller gives no limit", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"], budget: { maxRequestBytes: 600_000 } });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdfWithPictures(6) });
    // (600,000 - 262,144) * 3 / 8 = 126,696 bytes: two pictures of 60,000 fit, three do not.
    const { result } = await files.tools([meta], { viewPages: true }).executeWithFiles("view_pages", { document_id: meta.id, from_page: 1, to_page: 5 });
    expect(result).toMatchObject({ pages: "1-2", next_page: 3 });
  });
});

// ---------- What a cut must not carry, and must keep ----------

describe("view_pages: what a cut holds", () => {
  it("does not take along the pictures of other pages from a resource dictionary that all pages share", async () => {
    for (const options of [{ shared: true }, { sharedThroughForm: true }, { sharedWithEscapedNames: true }]) {
      const original = pdfWithPictures(10, options);
      expect(original.length).toBeGreaterThan(600_000);
      const { view } = await withPdf(original);
      const { files } = await view({ from_page: 2, to_page: 3 });
      // Two pictures of 60,000 bytes, not ten.
      expect(files[0]!.bytes.length).toBeLessThan(2 * 60_000 + 6_000);
      expect(await pageTexts(files[0]!.bytes)).toEqual([pageLine(2), pageLine(3)]);
      expect(await imagesPainted(files[0]!.bytes)).toEqual([1, 1]);
    }
  });

  it("does not take along the pages that its links lead to", async () => {
    // Every page links to the next: followed blindly, one page would bring the whole file.
    const original = pdfWithPictures(10, { links: true });
    const { view } = await withPdf(original);
    const { files } = await view({ from_page: 4 });
    expect(files[0]!.bytes.length).toBeLessThan(60_000 + 6_000);
    expect(await pageTexts(files[0]!.bytes)).toEqual([pageLine(4)]);
    expect(await imagesPainted(files[0]!.bytes)).toEqual([1]);
    const page = await (await open(files[0]!.bytes)).getPage(1);
    expect((await page.getAnnotations()).map((annotation: { subtype: string }) => annotation.subtype)).toEqual(["Link"]);
  });

  it("keeps hidden layers hidden, and the rotation and crop box a page inherits", async () => {
    const original = layeredPdf();
    const { view } = await withPdf(original);
    const { files } = await view({ from_page: 1 });
    const describe_ = async (bytes: Uint8Array) => {
      const document = await open(bytes);
      const page = await document.getPage(1);
      const layers = [...(await document.getOptionalContentConfig()) as unknown as Iterable<[string, { name: string; visible: boolean }]>];
      return { layers: layers.map(([, group]) => `${group.name}: ${group.visible ? "shown" : "hidden"}`).sort(), rotate: page.rotate, view: page.view };
    };
    const cut = await describe_(files[0]!.bytes);
    expect(cut).toEqual({ layers: ["Hidden layer: hidden", "Shown layer: shown"], rotate: 90, view: [20, 20, 575, 822] });
    expect(cut).toEqual(await describe_(original));
  });

  it("cuts a PDF that is encrypted only to restrict printing and copying", async () => {
    const plain = await PDFDocument.load(numberedPdf(4), { updateMetadata: false });
    plain.encrypt({ ownerPassword: "owner-secret", permissions: { printing: false, copying: false, modifying: false } });
    const encrypted = await plain.save();
    expect(Buffer.from(encrypted).toString("latin1")).toContain("/Encrypt");
    const { view, meta } = await withPdf(encrypted);
    expect(meta.pages).toBe(4);
    const { result, files } = await view({ from_page: 2, to_page: 3 });
    expect(result).toMatchObject({ pages: "2-3", total_pages: 4 });
    expect(await pageTexts(files[0]!.bytes)).toEqual([pageLine(2), pageLine(3)]);
  });
});

// ---------- When the pages cannot be shown ----------

describe("view_pages: when pages cannot be shown", () => {
  it("reaches only the PDFs of this conversation", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const mine = await files.ingest({ name: "mine.pdf", bytes: numberedPdf(2) });
    const other = await files.ingest({ name: "secret.pdf", bytes: numberedPdf(2) });
    const tools = files.tools([mine], { viewPages: true });
    expect(await tools.executeWithFiles("view_pages", { document_id: other.id, from_page: 1 })).toEqual({
      result: { error: `Unknown document_id ${other.id}. Use the document_id of an attached PDF.` }, files: [],
    });
    expect((await tools.executeWithFiles("view_pages", { document_id: mine.id, from_page: 1 })).files).toHaveLength(1);
  });

  it("does not claim that pages are attached when it is run without a way to return them", async () => {
    const { tools, meta } = await withPdf(numberedPdf(2));
    expect(await tools.execute("view_pages", { document_id: meta.id, from_page: 1 })).toEqual({
      error: "The pages could not be shown: this application does not pass files from tools to the model. Answer from the text.",
    });
    // The other tools return the same through either method, and no files.
    const read = await tools.execute("read_document", { document_id: meta.id, start_line: 1 });
    expect(await tools.executeWithFiles("read_document", { document_id: meta.id, start_line: 1 })).toEqual({ result: read, files: [] });
    expect(await tools.executeWithFiles("nope", {})).toEqual({ result: { error: "Unknown tool nope." }, files: [] });
  });

  it("says so when the original file is gone, damaged, or has too many objects", async () => {
    const { view, store, meta } = await withPdf(numberedPdf(3));
    const originals = (store as unknown as { originals: Map<string, Uint8Array> }).originals;
    const good = originals.get(meta.id)!;

    originals.set(meta.id, good.subarray(0, 300));
    expect((await view({ from_page: 1 })).result).toEqual({ error: "report.pdf: This PDF could not be read to cut pages from it. It may be damaged." });
    originals.set(meta.id, utf8("not a PDF at all"));
    expect((await view({ from_page: 1 })).result).toEqual({ error: "report.pdf: This PDF could not be read to cut pages from it. It may be damaged." });

    // A file that says it has five million objects is not parsed.
    originals.set(meta.id, pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"], 5_000_000));
    expect((await view({ from_page: 1 })).result).toEqual({ error: "report.pdf: This PDF has 5,000,000 objects, too many to cut pages from it in memory." });

    // Another file under the same ID, or one that this reader pages differently than the reader the
    // text came from: a page number would not mean the same page, so no page is shown.
    originals.set(meta.id, numberedPdf(5));
    expect((await view({ from_page: 1 })).result).toEqual({ error: "report.pdf: The pages of this PDF could not be matched to its text (5 pages against 3), so they cannot be shown." });

    originals.delete(meta.id);
    expect((await view({ from_page: 1 })).result).toEqual({ error: "The original file of report.pdf is no longer on the server, so its pages cannot be shown. Answer from the text." });

    originals.set(meta.id, good);
    expect((await view({ from_page: 1 })).files).toHaveLength(1);
  });

  it("says so when the PDF needs a password", async () => {
    const plain = await PDFDocument.load(numberedPdf(2), { updateMetadata: false });
    plain.encrypt({ ownerPassword: "owner-secret", userPassword: "open-me" });
    await expect(cutPdfPages(await plain.save(), 1, 1, 1_000_000)).rejects.toThrow("This PDF needs a password to open, so its pages cannot be shown.");
  });

  it("says so when the document has expired", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const now = () => clock;
    const files = createLargeFiles({ store: new MemoryDocumentStore({ now }), keepOriginals: ["pdf"], ttlMs: 60_000, now });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(2) });
    const tools = files.tools([meta], { viewPages: true });
    clock = new Date("2026-01-01T00:02:00Z");
    expect((await tools.executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 })).result).toEqual({
      error: `${meta.id} is no longer available on the server. Ask the user to attach the file again.`,
    });
  });
});

// ---------- The pieces ----------

describe("cutPdfPages", () => {
  it("reports how many pages the file has, and stops at its last page", async () => {
    const cut = await cutPdfPages(numberedPdf(3), 2, 9, 1_000_000);
    expect(cut).toMatchObject({ from: 2, to: 3, pageCount: 3 });
    expect(await pageTexts(cut.bytes)).toEqual([pageLine(2), pageLine(3)]);
    await expect(cutPdfPages(numberedPdf(3), 4, 4, 1_000_000)).rejects.toThrow("There is no page 4: the file has 3 pages.");
    await expect(cutPdfPages(numberedPdf(1), 2, 2, 1_000_000)).rejects.toThrow("There is no page 2: the file has 1 page.");
  });

  it("does not change the bytes it was given", async () => {
    const original = pdfWithPictures(4, { shared: true, links: true });
    const before = original.slice();
    await cutPdfPages(original, 2, 3, 1_000_000);
    expect(sameBytes(original, before)).toBe(true);
  });

  it("reads the number of objects a file declares, from a trailer or from a cross-reference stream", () => {
    expect(declaredObjectCount(numberedPdf(3))).toBe(10);
    // A cross-reference stream: /Size is in the dictionary that startxref points at, far from the end.
    const head = "%PDF-1.7\n";
    const stream = `7 0 obj\n<< /Type /XRef /Size 4321 /W [1 2 1] /Length 9000 >>\nstream\n${"x".repeat(9000)}\nendstream\nendobj\n`;
    expect(declaredObjectCount(utf8(`${head}${stream}startxref\n${head.length}\n%%EOF\n`))).toBe(4321);
    expect(declaredObjectCount(utf8("no trailer here"))).toBeUndefined();
  });
});

describe("page numbers for lines", () => {
  const text = ["--- Page 1 ---", "Intro", "--- Page 9 ---", "is a line of the text, not a page", "", "--- Page 2 ---", "Figure 3: sales by region", "more", "", "--- Page 3 ---", "End"].join("\n");
  const document = new SearchableDocument({ meta: { id: "doc_p", name: "report.pdf" } as never, text });

  it("finds the page of a line from the page lines, and ignores a line that only looks like one", () => {
    expect([1, 2, 3, 4, 6, 7, 8, 10, 11].map((line) => document.pageOfLine(line))).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3]);
    expect(document.pagesOfLines(2, 7)).toBe("1-2");
    expect(document.pagesOfLines(7, 8)).toBe("2");
    const plain = new SearchableDocument({ meta: { id: "doc_q", name: "notes.txt" } as never, text: "alpha\nbeta" });
    expect(plain.pageOfLine(2)).toBeUndefined();
    expect(plain.pagesOfLines(1, 2)).toBeUndefined();
  });

  it("adds page numbers to search and read results of a PDF whose pages can be looked at, and of no other", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(4) });
    const args = { document_id: meta.id };
    const withPages = files.tools([meta], { viewPages: true });
    const exact = await withPages.execute("search_document", { ...args, query: "Page 3 of", mode: "exact" });
    expect(exact.matches).toEqual([{ line: 8, page: 3, text: "Page 3 of the test file." }]);
    const keywords = await withPages.execute("search_document", { ...args, query: "test file" });
    expect((keywords.passages as Array<{ lines: string; pages: string }>)[0]).toMatchObject({ lines: "1-11", pages: "1-4" });
    expect(await withPages.execute("read_document", { ...args, start_line: 5, end_line: 8 })).toMatchObject({ lines: "5-8", pages: "2-3" });

    // Without view_pages on offer the results are those of 0.2.0: no new fields.
    const plain = files.tools([meta]);
    expect((await plain.execute("search_document", { ...args, query: "Page 3 of", mode: "exact" })).matches).toEqual([{ line: 8, text: "Page 3 of the test file." }]);
    expect(Object.keys((await plain.execute("search_document", { ...args, query: "test file" }) as { passages: object[] }).passages[0]!)).toEqual(["lines", "score", "text"]);
    expect(Object.keys(await plain.execute("read_document", { ...args, start_line: 5, end_line: 8 }))).toEqual(["document", "lines", "total_lines", "text", "next_start_line"]);
  });
});
