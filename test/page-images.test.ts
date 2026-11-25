// view_pages with pages drawn as images (`ToolOptions.pageImages`, 0.99.9), with a fake renderer:
// the result and its files, the limits of a call (pages, bytes, time), the errors, the turns and the
// signal, and what a missing renderer answers.
import "./load-pdf-libraries.js";
import * as installedUnpdf from "unpdf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore, PAGE_IMAGE_SIDE, TOOL_NAMES, type LargeFilesOptions, type ToolCallLimits, type ToolOptions } from "llm-large-files";
import { loadRenderBackend, renderPdfPages, type RenderBackend } from "../src/pdf-images.js";
import { numberedPdf, pdfFromObjects } from "./pdf-fixtures.js";
import { code, jobsOf, workflow } from "./workflows.js";

type Drawn = { page: number; scale: number; format: string; quality: number };

/** A renderer that draws `pageCount` pages of 612 by 792 points as bytes of the page's number. */
function fakeRenderer(options: { pageCount?: number; bytesOf?: (page: number) => number; onDraw?: (page: number) => void | Promise<void>; openError?: unknown } = {}) {
  const drawn: Drawn[] = [];
  const counts = { opened: 0, closed: 0 };
  const backend: RenderBackend = {
    async open() {
      counts.opened++;
      if (options.openError !== undefined) throw options.openError;
      return {
        pageCount: options.pageCount ?? 6,
        pageSize: async () => ({ width: 612, height: 792 }),
        async draw(page, given) {
          drawn.push({ page, ...given });
          await options.onDraw?.(page);
          return new Uint8Array(options.bytesOf?.(page) ?? 1_000).fill(page);
        },
        async close() {
          counts.closed++;
        },
      };
    },
  };
  return { backend, drawn, counts };
}

/** A library that keeps PDFs, a PDF of `pages` pages in it, and tools that show its pages as images. */
async function withPdf(renderer: RenderBackend, pages = 6, format: "jpeg" | "png" = "jpeg", options: Partial<LargeFilesOptions> = {}) {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"], ...options });
  const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(pages) });
  // `pageRenderer` is internal: the tests give it through the options, which go on to the tool set.
  const tools = files.tools([meta], { viewPages: true, pageImages: { format }, pageRenderer: renderer } as ToolOptions);
  const view = (args: Record<string, unknown>, limits?: ToolCallLimits, signal?: AbortSignal) =>
    tools.executeWithFiles(TOOL_NAMES.view, { document_id: meta.id, ...args }, limits, signal ? { signal } : {});
  return { files, meta, tools, view };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("view_pages with pageImages", () => {
  it("draws the pages asked for as JPEG images, next to a result that names them", async () => {
    const { backend, drawn, counts } = fakeRenderer();
    const { view } = await withPdf(backend);
    const { result, files } = await view({ from_page: 2, to_page: 3 });
    expect(result).toEqual({ document: "report.pdf", pages: "2-3", total_pages: 6, images: ["page-2.jpg", "page-3.jpg"] });
    expect(files).toEqual([
      { name: "page-2.jpg", mimeType: "image/jpeg", bytes: new Uint8Array(1_000).fill(2) },
      { name: "page-3.jpg", mimeType: "image/jpeg", bytes: new Uint8Array(1_000).fill(3) },
    ]);
    expect(drawn).toEqual([
      { page: 2, scale: PAGE_IMAGE_SIDE / 792, format: "jpeg", quality: 0.85 },
      { page: 3, scale: PAGE_IMAGE_SIDE / 792, format: "jpeg", quality: 0.85 },
    ]);
    expect(counts).toEqual({ opened: 1, closed: 1 });
  });

  it("draws PNG when the tool set is asked for PNG", async () => {
    const { backend, drawn } = fakeRenderer();
    const { view } = await withPdf(backend, 6, "png");
    const { result, files } = await view({ from_page: 4 });
    expect(result).toEqual({ document: "report.pdf", pages: "4", total_pages: 6, images: ["page-4.png"] });
    expect(files.map((file) => [file.name, file.mimeType])).toEqual([["page-4.png", "image/png"]]);
    expect(drawn.map((page) => page.format)).toEqual(["png"]);
  });

  it("shows at most five pages a call, and fewer when the call has fewer left", async () => {
    const { backend } = fakeRenderer({ pageCount: 8 });
    const { view } = await withPdf(backend, 8);
    expect((await view({ from_page: 1, to_page: 8 })).result).toEqual({
      document: "report.pdf", pages: "1-5", total_pages: 8, images: [1, 2, 3, 4, 5].map((page) => `page-${page}.jpg`),
      next_page: 6, note: "Showing 5 of the 8 pages asked for: one call shows at most 5. Call view_pages from page 6 if you need them.",
    });
    expect((await view({ from_page: 1, to_page: 8 }, { maxPages: 2 })).result).toEqual({
      document: "report.pdf", pages: "1-2", total_pages: 8, images: ["page-1.jpg", "page-2.jpg"],
      note: "Showing 2 of the 8 pages asked for: no more pages can be looked at for this question.",
    });
    expect((await view({ from_page: 1 }, { maxPages: 0 })).result).toEqual({ error: "No more pages can be looked at for this question. Answer from the pages and the text you already have." });
  });

  it("leaves pages off the end that do not fit in maxFileBytes, and says where to go on", async () => {
    const { backend } = fakeRenderer({ bytesOf: () => 1_500 });
    const { view } = await withPdf(backend);
    const { result, files } = await view({ from_page: 1, to_page: 4 }, { maxFileBytes: 3_200 });
    expect(result).toEqual({
      document: "report.pdf", pages: "1-2", total_pages: 6, images: ["page-1.jpg", "page-2.jpg"],
      next_page: 3, note: "Showing 2 of the 4 pages asked for: the others did not fit in this request. Call view_pages from page 3 if you need them.",
    });
    expect(files).toHaveLength(2);
  });

  it("refuses a first page larger than the bytes left, with its size", async () => {
    const { backend } = fakeRenderer({ bytesOf: () => 3 * 1_024 });
    const { view } = await withPdf(backend);
    expect(await view({ from_page: 2 }, { maxFileBytes: 2_048 })).toEqual({ result: { error: "report.pdf: Page 2 is 3 KB as an image, more than the 2 KB that fit in this request." }, files: [] });
    // Below 1 KB no page fits: refused before the turn, as a cut is.
    expect((await view({ from_page: 2 }, { maxFileBytes: 1_000 })).result).toEqual({ error: "There is no room left in this request to show more pages. Answer from the pages and the text you already have." });
  });

  it("starts no page that would pass the time a call may take", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { backend, drawn } = fakeRenderer({ onDraw: () => void vi.advanceTimersByTime(2_000) });
    const { view } = await withPdf(backend);
    expect((await view({ from_page: 1, to_page: 4 })).result).toEqual({
      document: "report.pdf", pages: "1-2", total_pages: 6, images: ["page-1.jpg", "page-2.jpg"],
      next_page: 3, note: "Showing 2 of the 4 pages asked for: the others took too long to draw. Call view_pages from page 3 if you need them.",
    });
    expect(drawn.map((page) => page.page)).toEqual([1, 2]);
  });

  it("matches the pages to the text", async () => {
    const { backend } = fakeRenderer({ pageCount: 5 });
    const { view } = await withPdf(backend, 6);
    expect((await view({ from_page: 1 })).result).toEqual({ error: "report.pdf: The pages of this PDF could not be matched to its text (5 pages against 6), so they cannot be shown." });
  });

  it("says when the PDF needs a password, or cannot be read", async () => {
    const locked = await withPdf(fakeRenderer({ openError: Object.assign(new Error("No password given"), { name: "PasswordException" }) }).backend);
    expect((await locked.view({ from_page: 1 })).result).toEqual({ error: "report.pdf: This PDF needs a password to open, so its pages cannot be shown." });
    const damaged = await withPdf(fakeRenderer({ openError: new Error("Invalid PDF structure") }).backend);
    expect((await damaged.view({ from_page: 1 })).result).toEqual({ error: "report.pdf: This PDF could not be read to draw its pages. It may be damaged." });
    const empty = await withPdf(fakeRenderer({ pageCount: 0 }).backend);
    expect((await empty.view({ from_page: 1 })).result).toEqual({ error: "report.pdf: This PDF could not be read to draw its pages. It may be damaged." });
  });

  it("names a page that cannot be drawn", async () => {
    const { backend, counts } = fakeRenderer({ onDraw: (page) => { if (page === 3) throw new Error("bad operator"); } });
    const { view } = await withPdf(backend);
    expect(await view({ from_page: 2, to_page: 4 })).toEqual({ result: { error: "report.pdf: Page 3 could not be drawn. It may be damaged." }, files: [] });
    expect(counts.closed).toBe(1);
  });

  it("refuses a file that declares too many objects, before opening it", async () => {
    const { backend, counts } = fakeRenderer();
    const huge = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"], 5_000_000);
    await expect(renderPdfPages(huge, 1, 1, { format: "jpeg", longestSide: PAGE_IMAGE_SIDE, maxBytes: 1_000_000 }, backend)).rejects.toThrow("This PDF has 5,000,000 objects, too many to draw its pages in memory.");
    expect(counts.opened).toBe(0);
    // A page that is not there, and a page size that cannot be drawn at any scale.
    await expect(renderPdfPages(numberedPdf(1), 7, 7, { format: "jpeg", longestSide: PAGE_IMAGE_SIDE, maxBytes: 1_000_000 }, backend)).rejects.toThrow("There is no page 7: the file has 6 pages.");
    const flat: RenderBackend = { open: async () => ({ pageCount: 1, pageSize: async () => ({ width: 0, height: 0 }), draw: async () => new Uint8Array(1), close: async () => undefined }) };
    await expect(renderPdfPages(numberedPdf(1), 1, 1, { format: "png", longestSide: 512, maxBytes: 1_000_000 }, flat)).rejects.toThrow("Page 1 could not be drawn. It may be damaged.");
  });

  it("waits for the turn of the looks at pages, and stops at the call's signal between pages", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const first = fakeRenderer({ onDraw: () => gate });
    const { view } = await withPdf(first.backend, 6, "jpeg", { maxConcurrentPageLooks: 1 });
    const looking = view({ from_page: 1 });
    const waiting = view({ from_page: 2 });
    await vi.waitFor(() => expect(first.counts.opened).toBe(1));
    // The second look has not opened the file: it waits for the turn of the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.counts.opened).toBe(1);
    open();
    expect((await looking).result).toMatchObject({ pages: "1" });
    expect((await waiting).result).toMatchObject({ pages: "2" });
    expect(first.counts.opened).toBe(2);

    const controller = new AbortController();
    const reason = new Error("The user left.");
    const stopping = fakeRenderer({ onDraw: (page) => { if (page === 1) controller.abort(reason); } });
    const stopped = await withPdf(stopping.backend);
    await expect(stopped.view({ from_page: 1, to_page: 3 }, undefined, controller.signal)).rejects.toBe(reason);
    expect(stopping.drawn.map((page) => page.page)).toEqual([1]);
    expect(stopping.counts.closed).toBe(1);
  });

  it("checks pageImages when the tools are made", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(1) });
    const make = (pageImages: unknown) => () => files.tools([meta], { viewPages: true, pageImages: pageImages as ToolOptions["pageImages"] });
    expect(make({ format: "webp" })).toThrow(new TypeError('pageImages.format must be "png" or "jpeg", and is "webp".'));
    expect(make({})).toThrow(new TypeError('pageImages.format must be "png" or "jpeg", and is undefined.'));
    expect(make("jpeg")).toThrow(new TypeError('pageImages.format must be "png" or "jpeg", and is undefined.'));
    expect(make({ format: 3 })).toThrow(new TypeError('pageImages.format must be "png" or "jpeg", and is 3.'));
    expect(make({ format: "png" })).not.toThrow();
  });

  it("execute() still answers that it cannot deliver files", async () => {
    const { backend, counts } = fakeRenderer();
    const { tools, meta } = await withPdf(backend);
    expect(await tools.execute(TOOL_NAMES.view, { document_id: meta.id, from_page: 1 })).toEqual({ error: "The pages could not be shown: this application does not pass files from tools to the model. Answer from the text." });
    expect(counts.opened).toBe(0);
  });
});

describe("loadRenderBackend", () => {
  const notFound = (name: string) => Object.assign(new Error(`Cannot find package '${name}' imported from /app/dist/pdf-images.js`), { code: "ERR_MODULE_NOT_FOUND" });
  /** What this module uses of unpdf 2, made by hand: it notes what it is asked. */
  const fakeUnpdf = () => {
    const asked: unknown[] = [];
    const proxy = { numPages: 3, getPage: async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }) }), loadingTask: { destroy: async () => void asked.push("destroy") } };
    return {
      asked,
      module: {
        inspectPages: () => undefined,
        getDocumentProxy: async (data: Uint8Array, options: unknown) => {
          asked.push(["open", data.length, options]);
          return proxy;
        },
        renderPageAsImage: async (given: unknown, page: number, options: { canvasImport: () => Promise<unknown>; scale: number; format: string; quality?: number }) => {
          asked.push(["draw", given === proxy, page, options.scale, options.format, options.quality, await options.canvasImport()]);
          return new Uint8Array([page]).buffer;
        },
      },
    };
  };

  it("names the dependency to install", async () => {
    const canvas = { createCanvas: () => undefined };
    await expect(loadRenderBackend({ unpdf: () => Promise.reject(notFound("unpdf")) })).rejects.toThrow('Showing pages as images needs the optional dependency "unpdf".');
    const unpdf1 = { getDocumentProxy: async () => undefined, renderPageAsImage: async () => new ArrayBuffer(1) };
    await expect(loadRenderBackend({ unpdf: async () => unpdf1, canvas: async () => canvas })).rejects.toThrow("Showing pages as images needs unpdf 2 or later, which runs on Node 24 or later.");
    const { module } = fakeUnpdf();
    await expect(loadRenderBackend({ unpdf: async () => module, canvas: () => Promise.reject(notFound("@napi-rs/canvas")) })).rejects.toThrow('Showing pages as images needs the optional dependency "@napi-rs/canvas".');
    await expect(loadRenderBackend({ unpdf: async () => module, canvas: () => Promise.reject(new Error("libstdc++.so.6: cannot open shared object file\nmore")) }))
      .rejects.toThrow('The optional dependency "@napi-rs/canvas" is installed but could not be loaded (libstdc++.so.6: cannot open shared object file). Reinstall it, or install a version this Node can run.');
  });

  it("draws with unpdf 2 and the canvas it was given, and closes the file through its loading task", async () => {
    const canvas = { createCanvas: () => undefined };
    const { module, asked } = fakeUnpdf();
    const backend = await loadRenderBackend({ unpdf: async () => module, canvas: async () => canvas });
    const document = await backend.open(new Uint8Array(10));
    expect(document.pageCount).toBe(3);
    expect(await document.pageSize(1)).toEqual({ width: 612, height: 792 });
    expect(await document.draw(2, { scale: 2, format: "jpeg", quality: 0.85 })).toEqual(new Uint8Array([2]));
    expect(await document.draw(3, { scale: 1, format: "png", quality: 0.85 })).toEqual(new Uint8Array([3]));
    await document.close();
    expect(asked).toEqual([
      ["open", 10, { maxImageSize: 40_000_000 }],
      ["draw", true, 2, 2, "jpeg", 0.85, canvas],
      // No quality for a PNG.
      ["draw", true, 3, 1, "png", undefined, canvas],
      "destroy",
    ]);
  });

  it("is tested with the real renderer in CI: the rows of unpdf 2 install a pinned @napi-rs/canvas", () => {
    const job = code(jobsOf(workflow("ci.yml"))["unpdf-versions"]!);
    expect(job).toContain('{ node: 24, unpdf: "^2", canvas: true }');
    expect(job).toContain('{ node: 26, unpdf: "^2", canvas: true }');
    // Published 2026-10-30: at least 14 days before the build of 0.99.9.
    expect(job).toContain('"@napi-rs/canvas@1.1.0"');
  });

  // The installed renderer, as each CI row has it: unpdf 1 (the devDependency) is refused; unpdf 2
  // without the canvas asks for it. With both, test/page-images-render.test.ts draws real pages.
  const hasUnpdf2 = typeof (installedUnpdf as { inspectPages?: unknown }).inspectPages === "function";
  it.skipIf(hasUnpdf2)("answers a look with the dependency to install, and keeps no failure", async () => {
    const { view } = await withPdf(undefined as unknown as RenderBackend);
    expect((await view({ from_page: 1 })).result).toEqual({ error: "report.pdf: Showing pages as images needs unpdf 2 or later, which runs on Node 24 or later." });
    const first = loadRenderBackend();
    const second = loadRenderBackend();
    await expect(first).rejects.toThrow("needs unpdf 2 or later");
    await expect(second).rejects.toThrow("needs unpdf 2 or later");
    // A failure is not kept: the next call loads again.
    await new Promise((resolve) => setImmediate(resolve));
    const third = loadRenderBackend();
    expect(third).not.toBe(first);
    await expect(third).rejects.toThrow("needs unpdf 2 or later");
  });
});
