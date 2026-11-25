// Pages of a PDF drawn as images, for `view_pages` with a model that takes images and no PDF
// (G-13, new in 0.99.9). Drawing needs the optional dependencies "unpdf" 2 or later, which runs on
// Node 24 or later, and "@napi-rs/canvas". Both are loaded on first use: without them every look
// answers the model with what to install, as a missing "@cantoo/pdf-lib" does for a cut.
import { checkUnpdf } from "./extract.js";
import { fairPause } from "./pause.js";
import { tooManyObjects } from "./pdf-pages.js";
import { importPeer } from "./peers.js";
import { formatBytes } from "./plan.js";

/** The longest side of a page drawn as an image, in pixels: Claude's standard size, which every provider takes. New in 0.99.9. */
export const PAGE_IMAGE_SIDE = 1_568;
/** The JPEG quality of a page image. */
export const PAGE_IMAGE_QUALITY = 0.85;
/**
 * pdf.js draws no image of a page that has more pixels than this (`maxImageSize`): it leaves it
 * blank. A 600 dpi scan of an A4 page has 35 million.
 */
export const MAX_SOURCE_IMAGE_PIXELS = 40_000_000;
/**
 * A call starts no page once the time so far and its slowest page so far would pass this, in
 * milliseconds. The page under way is never cut short.
 */
export const RENDER_TIME_MS = 5_000;

/** One page drawn. */
export type PageImage = { page: number; bytes: Uint8Array };
/**
 * The pages drawn by one call: `from` to `to`, of the `pageCount` of the file. `stoppedBy` says why
 * pages asked for were left off the end: the bytes the request had room for, or the time.
 */
export type PageImages = { images: PageImage[]; from: number; to: number; pageCount: number; stoppedBy?: "bytes" | "time" };

/** What draws pages: unpdf 2 with @napi-rs/canvas, or a fake in the tests. */
export type RenderBackend = { open(bytes: Uint8Array): Promise<RenderDocument> };
/** One PDF opened to draw its pages. */
export type RenderDocument = {
  readonly pageCount: number;
  /** The page's size at scale 1, in points, with its rotation. */
  pageSize(page: number): Promise<{ width: number; height: number }>;
  draw(page: number, options: { scale: number; format: "png" | "jpeg"; quality: number }): Promise<Uint8Array>;
  close(): Promise<void>;
};

/** How the two optional dependencies are loaded; the tests give their own. */
export type RenderImporters = { unpdf?: () => Promise<unknown>; canvas?: () => Promise<unknown> };

/** What this module uses of a PDF opened by unpdf 2 (pdf.js 5). */
type PdfProxy = {
  numPages: number;
  getPage(page: number): Promise<{ getViewport(options: { scale: number }): { width: number; height: number } }>;
  loadingTask: { destroy(): Promise<void> };
};

/**
 * What this module uses of unpdf 2. The devDependency is unpdf 1, whose types have no `inspectPages`
 * and another `renderPageAsImage`: 2 is read through this type, once its functions are checked.
 */
type Unpdf2 = {
  getResolvedPDFJS?: unknown;
  inspectPages: unknown;
  getDocumentProxy(data: Uint8Array, options?: { maxImageSize?: number }): Promise<PdfProxy>;
  renderPageAsImage(data: PdfProxy, page: number, options: {
    canvasImport: () => Promise<unknown>;
    scale: number;
    format: "png" | "jpeg";
    quality?: number;
  }): Promise<Uint8Array | ArrayBuffer>;
};

/**
 * The name of the canvas package, held in a variable: it is not a dependency of this package and has
 * no types here, so an import of the literal name would not compile.
 */
const CANVAS = "@napi-rs/canvas";

/** Loads unpdf 2 and the canvas, and makes the backend that draws with them. */
async function backendOf(importers: RenderImporters): Promise<RenderBackend> {
  const loaded = await importPeer<unknown>("unpdf", importers.unpdf ?? (() => import("unpdf")), 'Showing pages as images needs the optional dependency "unpdf".');
  const unpdf = loaded as Partial<Unpdf2> | null;
  if (typeof unpdf?.inspectPages !== "function" || typeof unpdf.renderPageAsImage !== "function" || typeof unpdf.getDocumentProxy !== "function") {
    throw new Error("Showing pages as images needs unpdf 2 or later, which runs on Node 24 or later.");
  }
  await checkUnpdf(unpdf);
  const canvas = await importPeer<unknown>(CANVAS, importers.canvas ?? (() => import(CANVAS)), 'Showing pages as images needs the optional dependency "@napi-rs/canvas".');
  const library = unpdf as Unpdf2;
  return {
    async open(bytes) {
      // pdf.js may detach the buffer it reads, so it gets a copy.
      const proxy = await library.getDocumentProxy(new Uint8Array(bytes), { maxImageSize: MAX_SOURCE_IMAGE_PIXELS });
      return {
        pageCount: proxy.numPages,
        async pageSize(page) {
          const { width, height } = (await proxy.getPage(page)).getViewport({ scale: 1 });
          return { width, height };
        },
        async draw(page, { scale, format, quality }) {
          const drawn = await library.renderPageAsImage(proxy, page, { canvasImport: async () => canvas, scale, format, ...(format === "jpeg" ? { quality } : {}) });
          return drawn instanceof Uint8Array ? drawn : new Uint8Array(drawn);
        },
        async close() {
          await proxy.loadingTask.destroy();
        },
      };
    },
  };
}

/** The backend once it loaded: a failure is not kept, so a dependency installed later is found. */
let loaded: Promise<RenderBackend> | undefined;

/**
 * The backend that draws pages: unpdf 2 with @napi-rs/canvas, loaded on first use. Throws an Error
 * that says what to install: "unpdf" missing, an unpdf before 2 ("needs unpdf 2 or later, which runs
 * on Node 24 or later"), an unpdf that would stop the process (`checkUnpdf`), "@napi-rs/canvas"
 * missing, or installed and broken. `importers` are for the tests: with them nothing is kept.
 */
export function loadRenderBackend(importers?: RenderImporters): Promise<RenderBackend> {
  if (importers) return backendOf(importers);
  if (!loaded) {
    const loading = backendOf({});
    loaded = loading;
    loading.catch(() => {
      if (loaded === loading) loaded = undefined;
    });
  }
  return loaded;
}

/**
 * The pause between two pages: a timer first, so that the timers and the I/O of other work get their
 * turn (a fair pause alone, which runs at the end of the turn it is asked in, let no timer run between
 * the first two pages, measured), then a fair pause, taken in turns with other long work.
 */
async function pauseBetweenPages(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await fairPause();
}

const UNREADABLE = "This PDF could not be read to draw its pages. It may be damaged.";
const damaged = (page: number) => `Page ${page} could not be drawn. It may be damaged.`;

/**
 * Draws pages `from` to `to` (1-based, inclusive) of a PDF, each at `longestSide` pixels on its
 * longest side. Pages are left off the end when their images do not fit in `maxBytes` together
 * (`stoppedBy: "bytes"`), or when the time so far and the slowest page so far would pass
 * `RENDER_TIME_MS` (`stoppedBy: "time"`). Each page is drawn in one turn of the event loop, with a
 * pause between two in which timers, I/O and other long work run. Throws an Error whose message can
 * be shown to a model: for a file that cannot be opened, a page that does not exist or cannot be
 * drawn, and a first page that does not fit by itself. An aborted `signal` throws its reason,
 * between two pages.
 *
 * `expectedPages` is the page count the text of the file was extracted with: when this reader counts
 * other pages, a page number may not mean the same page in both, and no page is drawn.
 */
export async function renderPdfPages(original: Uint8Array, from: number, to: number, options: {
  format: "png" | "jpeg";
  longestSide: number;
  maxBytes: number;
  expectedPages?: number | undefined;
  signal?: AbortSignal | undefined;
  now?: () => number;
}, backend: RenderBackend): Promise<PageImages> {
  const { format, longestSide, maxBytes, expectedPages, signal } = options;
  const now = options.now ?? (() => performance.now());
  const started = now();
  // Refuse a file that says it has more objects than this process can hold, before pdf.js reads it.
  const objects = tooManyObjects(original);
  if (objects !== undefined) throw new Error(`This PDF has ${objects.toLocaleString("en-US")} objects, too many to draw its pages in memory.`);
  let document: RenderDocument;
  try {
    document = await backend.open(original);
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "PasswordException") throw new Error("This PDF needs a password to open, so its pages cannot be shown.");
    throw new Error(UNREADABLE);
  }
  try {
    const pageCount = document.pageCount;
    if (!(pageCount > 0)) throw new Error(UNREADABLE);
    if (expectedPages !== undefined && pageCount !== expectedPages) {
      throw new Error(`The pages of this PDF could not be matched to its text (${pageCount} pages against ${expectedPages}), so they cannot be shown.`);
    }
    if (from < 1 || from > pageCount) throw new Error(`There is no page ${from}: the file has ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`);
    const last = Math.min(Math.max(to, from), pageCount);
    const images: PageImage[] = [];
    let total = 0;
    let slowest = 0;
    let stoppedBy: "bytes" | "time" | undefined;
    for (let page = from; page <= last; page++) {
      signal?.throwIfAborted();
      if (page > from) {
        if (now() - started + slowest > RENDER_TIME_MS) {
          stoppedBy = "time";
          break;
        }
        // Each page holds the thread while it is drawn: other work runs between two.
        await pauseBetweenPages();
        signal?.throwIfAborted();
      }
      let bytes: Uint8Array;
      try {
        const { width, height } = await document.pageSize(page);
        const scale = longestSide / Math.max(width, height);
        if (!Number.isFinite(scale) || scale <= 0) throw new Error(damaged(page));
        const start = now();
        bytes = await document.draw(page, { scale, format, quality: PAGE_IMAGE_QUALITY });
        slowest = Math.max(slowest, now() - start);
      } catch {
        throw new Error(damaged(page));
      }
      if (total + bytes.length > maxBytes) {
        if (page === from) throw new Error(`Page ${from} is ${formatBytes(bytes.length)} as an image, more than the ${formatBytes(Math.max(0, maxBytes))} that fit in this request.`);
        stoppedBy = "bytes";
        break;
      }
      total += bytes.length;
      images.push({ page, bytes });
    }
    return { images, from, to: images.at(-1)!.page, pageCount, ...(stoppedBy ? { stoppedBy } : {}) };
  } finally {
    await document.close().catch(() => undefined);
  }
}
