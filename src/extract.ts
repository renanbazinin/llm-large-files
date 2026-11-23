import { decodeText, plainText } from "./decode.js";
import { html } from "./html.js";
import { TimeSlicer } from "./pause.js";
import { layoutPage, plainPageText, type LayoutBox, type PdfTextItem } from "./pdf-layout.js";
import { findPicturePages, parsePdf, type PageGeometry } from "./pdf-pictures.js";
import { checkPageWork, HeavyPage } from "./pdf-work.js";
import { formatBytes } from "./plan.js";
import { docx, pptx } from "./office.js";
import { importPeer } from "./peers.js";
import { plural, utf8Bytes } from "./text.js";
import type { DocumentFormat, ExtractedText, ExtractInput, ExtractProgress, Extractor } from "./types.js";

import { xlsx } from "./xlsx.js";

export { decodeText };
export { HIDDEN_SLIDE, HIDDEN_TEXT, officeXmlParagraphs, SPEAKER_NOTES } from "./office.js";

const EXTENSION_FORMATS: Record<string, DocumentFormat> = {
  log: "log", out: "log", err: "log",
  md: "markdown", markdown: "markdown",
  json: "json", jsonl: "json", ndjson: "json",
  csv: "csv", tsv: "csv",
  pdf: "pdf", docx: "docx", docm: "docx", pptx: "pptx", pptm: "pptx",
  xlsx: "xlsx", xlsm: "xlsx", xltx: "xlsx", xltm: "xlsx",
  html: "html", htm: "html", xhtml: "html",
};

const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/markdown": "markdown",
  "application/json": "json",
  "text/csv": "csv",
};

/**
 * Picks a format from the file name, then the MIME type. Unknown text-like files are "text". Both
 * come from the upload: only the tables' own keys count, not "constructor" or "__proto__", which
 * every object has.
 */
export function detectFormat(name: string, mimeType: string, bytes?: Uint8Array): DocumentFormat {
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  const mime = mimeType.toLowerCase();
  const named = (Object.hasOwn(EXTENSION_FORMATS, extension) ? EXTENSION_FORMATS[extension] : undefined)
    ?? (Object.hasOwn(MIME_FORMATS, mime) ? MIME_FORMATS[mime] : undefined)
    ?? "text";
  // A name that says text ("notes.txt") is taken at its word.
  return named === "text" && bytes && extension !== "txt" ? sniffFormat(bytes) ?? named : named;
}

/** Where the part names of an Office file are looked for: its directory at the end, and its first parts. */
const SNIFFED_HEAD = 64 * 1024;
const SNIFFED_TAIL = 1024 * 1024;

/**
 * The format of a file whose name and type say nothing (no extension, "application/octet-stream"),
 * from its bytes: a PDF by its header, a DOCX, PPTX or XLSX by the names of its parts, an HTML page
 * by its first tag. Undefined for anything else, which is read as text. A DOCX sent without its
 * extension was told "This file is a ZIP archive".
 */
export function sniffFormat(bytes: Uint8Array): DocumentFormat | undefined {
  const head = latin1(bytes.subarray(0, 1_024));
  const start = head.replace(/^\xef\xbb\xbf/, "").trimStart();
  if (start.startsWith("%PDF-")) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const names = latin1(bytes.subarray(0, SNIFFED_HEAD)) + latin1(bytes.subarray(Math.max(SNIFFED_HEAD, bytes.length - SNIFFED_TAIL)));
    if (names.includes("word/document.xml")) return "docx";
    if (names.includes("ppt/presentation.xml") || names.includes("ppt/slides/")) return "pptx";
    if (names.includes("xl/workbook.xml")) return "xlsx";
    return undefined;
  }
  const tag = start.slice(0, 64).toLowerCase();
  if (tag.startsWith("<!doctype html") || tag.startsWith("<html")) return "html";
  return undefined;
}

/** Bytes as Latin-1 text, one character a byte: enough to find ASCII names in them. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 8_192) out += String.fromCharCode(...bytes.subarray(at, at + 8_192));
  return out;
}

export type PdfExtractorOptions = {
  /**
   * Rebuild tables from the position of the text, and write each row as `| cell | cell |  |`, so an
   * empty cell stays an empty cell. Defaults to true. With false, the text is in pdf.js order, as
   * in version 0.1.0.
   */
  tables?: boolean;
  /**
   * Write a line under the page header of every page that shows a picture or a drawing, so the
   * model knows that the text does not tell all of that page. Defaults to true. It needs the
   * optional dependency `@cantoo/pdf-lib`; without it, and with false, the text is that of 0.2.0.
   */
  pictures?: boolean;
  /**
   * Before pdf.js reads any page, add up what each page would make it run, and refuse a file with
   * a page that would hold the server for a long time: pdf.js reads a page in one block that no
   * time limit can cut short. Defaults to true. It needs the optional dependency
   * `@cantoo/pdf-lib`. With false, and `pictures: false`, the file is not read with it at ingest.
   */
  checkPages?: boolean;
};

/**
 * A page tree that lists one page more than once makes the text of that page come back each time:
 * a 3 KB file built that way held 107 MB of text. PDF writers do not do this.
 */
const REPEATED_PAGE = "This PDF lists the same page more than once. A file built that way can hold far more text than its size, so it is not read. Print it to a new PDF, and attach that.";
/**
 * pdf.js reads the text of a page in one go, and nothing can stop it. A page that paints forms
 * inside forms, or whose content is packed hundreds of times, held the server for 6 s to 2 minutes
 * from files of 2 to 650 KB. Such a page is found before pdf.js reads it (see pdf-work.ts).
 */
const HEAVY_PAGE = (page: number) => `Page ${page} of this PDF draws far more than its file holds, and reading it would hold the server for a long time. A file built that way is not read: it may be built to exhaust the server. Print it to a new PDF, and attach that.`;
const HEAVY_FILE = "This PDF draws far more than its file holds, and reading it would hold the server for a long time. A file built that way is not read: it may be built to exhaust the server. Print it to a new PDF, and attach that.";
const UNREADABLE_PAGE = (page: number) => `Page ${page} of this PDF stores its content in a way that cannot be checked before it is read, so it is not read. Print it to a new PDF, and attach that.`;
/**
 * The text of a PDF is smaller than the file: fonts and pictures take room, and text is
 * compressed. A page that paints one form inside another, many times over, draws the text of the
 * innermost form each time: a file of a few kilobytes can draw megabytes. Past the first 16 MB,
 * text over this many times the size of the file is refused as it is read.
 */
const MAX_PDF_EXPANSION = 100;
const PDF_ALLOWANCE = 16 * 1024 * 1024;

/** Written in place of a page that has no text at all, so the model can say so instead of guessing. */
const PAGE_WITHOUT_TEXT = "[No text on this page. It may be a scan, a photo, or a chart.]";
/**
 * Written under the header of a page that shows a picture or a drawing. The words hold whether or
 * not the model is later given a way to look at the page.
 */
export const PICTURE_ON_PAGE = "[Picture on this page. This text cannot show it.]";

/** A line of a page's text that reads as one the extractor writes: a page header, or one of the two notes above. */
const OWN_LINE = /^(?:--- Page \d+ ---|\[Picture on this page\. This text cannot show it\.\]|\[No text on this page\. It may be a scan, a photo, or a chart\.\])$/gm;

/**
 * A page's text, with each line that reads as a line of the extractor's own moved by a space: a
 * document that quotes "--- Page 3 ---" on page 2 must not start page 3 there, nor tell a model of a
 * picture it does not have. Only the extractor's lines have the exact form, which search and
 * `view_pages` look for.
 */
function ownLines(text: string): string {
  return text.includes("--- Page ") || text.includes("[Picture on this page") || text.includes("[No text on this page") ? text.replace(OWN_LINE, (line) => ` ${line}`) : text;
}

/**
 * The progress of the pages of one stage of reading a PDF, for `ExtractInput.onProgress`. The page
 * check and the picture marks give up quietly on an error of their own: an error of the listener is
 * kept, and `rethrow` throws it once they are done, as it would anywhere else.
 */
function pageProgress(input: ExtractInput | undefined, stage: ExtractProgress["stage"]): { report?: (done: number, total: number) => void; rethrow(): void } {
  const listener = input?.onProgress;
  if (!listener) return { rethrow() {} };
  let failed: { error: unknown } | undefined;
  return {
    report(done, total) {
      try {
        listener({ stage, done, total, unit: "pages" });
      } catch (error) {
        failed ??= { error };
        throw error;
      }
    },
    rethrow() {
      if (failed) throw failed.error;
    },
  };
}

/**
 * Loads pdf.js through `unpdf`, and refuses a version of unpdf that would stop the process on this
 * version of Node (`node`, as in `process.versions.node`), with a message that says what to install.
 * pdf.js calls `Promise.try`, which Node 22 does not have (Node 24 does). unpdf adds it where it is
 * missing, but 1.5.0 to 1.6.0 do not: there, the first PDF throws where nothing can catch it, and
 * the whole process stops. An error of unpdf while it loads pdf.js is passed on as it is.
 * The message gives the major version of Node only: an upload can be answered with it. Its start,
 * "The unpdf installed", is what `ingestErrorCodeOf` reads as missing_dependency.
 */
export async function checkUnpdf(unpdf: { getResolvedPDFJS?: unknown }, node: string = process.versions.node): Promise<void> {
  if (typeof unpdf.getResolvedPDFJS !== "function") return;
  await (unpdf.getResolvedPDFJS as () => Promise<unknown>)();
  if (typeof (Promise as { try?: unknown }).try !== "function") {
    const major = Number.parseInt(node, 10);
    const advice = major < 24 ? "Install unpdf 1.6.1 or later, or run Node 24 or later." : "Install unpdf 1.6.1 or later.";
    throw new Error(`The unpdf installed would stop the whole server at the first PDF file on Node ${major}, so PDF files are not read. ${advice}`);
  }
}

/**
 * The built-in PDF extractor (needs `unpdf`). Use it to change an option:
 * `createLargeFiles({ extractors: { pdf: createPdfExtractor({ tables: false }) } })`.
 */
export function createPdfExtractor(options: PdfExtractorOptions = {}): Extractor {
  const tables = options.tables ?? true;
  const pictures = options.pictures ?? true;
  const checkPages = options.checkPages ?? true;
  return async (bytes, input) => {
    const unpdf = await importPeer("unpdf", () => import("unpdf"), "Reading PDF files needs the optional dependency \"unpdf\".");
    await checkUnpdf(unpdf);
    const signal = input?.signal;
    signal?.throwIfAborted();
    // pdf.js may detach the buffer it reads, so give it a copy.
    let document: Awaited<ReturnType<typeof unpdf.getDocumentProxy>>;
    try {
      document = await unpdf.getDocumentProxy(new Uint8Array(bytes));
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "PasswordException") {
        throw new Error("This PDF is protected by a password, so it cannot be read. Open it, print it to a new PDF without the password, and attach that.", { cause: error });
      }
      throw error;
    }
    const maxPages = input?.maxPages;
    if (maxPages !== undefined && document.numPages > maxPages) {
      throw new Error(`This PDF has ${document.numPages.toLocaleString("en-US")} pages, more than the ${maxPages.toLocaleString("en-US")} read from one file. Split it, and attach the part you need.`);
    }
    // Read once with @cantoo/pdf-lib, when it is installed: to refuse a page that would hold the
    // server before pdf.js reads it, and to mark the pages that show a picture.
    let parsed = checkPages || pictures ? await parsePdf(bytes, signal) : undefined;
    signal?.throwIfAborted();
    if (parsed && checkPages) {
      const checked = pageProgress(input, "check");
      try {
        await checkPageWork(parsed.library, parsed.document, bytes.byteLength, signal, checked.report);
      } catch (error) {
        if (error instanceof HeavyPage) throw new Error(error.reason === "unreadable" ? UNREADABLE_PAGE(error.page) : error.reason === "file" ? HEAVY_FILE : HEAVY_PAGE(error.page));
        signal?.throwIfAborted();
        checked.rethrow();
        // Anything else unusual in the file: the check is given up, and the text is read as before.
      }
    }
    if (!pictures) parsed = undefined;
    const maxTextBytes = input?.maxTextBytes ?? Number.POSITIVE_INFINITY;
    const mostDrawn = Math.max(PDF_ALLOWANCE, bytes.byteLength * MAX_PDF_EXPANSION);
    const tooMuchText = () => new Error(maxTextBytes <= mostDrawn
      ? `This PDF holds more than ${formatBytes(maxTextBytes)} of text, more than is kept from one file. Split it, and attach the part you need.`
      : `This PDF draws more than ${formatBytes(mostDrawn)} of text, over ${MAX_PDF_EXPANSION} times its size. A file that grows that much is not read: it may be built to exhaust the server.`);
    const textLimit = Math.min(maxTextBytes, mostDrawn);
    const texts: string[] = [];
    const geometry: PageGeometry[] = [];
    /** The page objects read so far: a page tree that lists one page twice is refused. */
    const seen = new Set<string>();
    // pdf.js reads a page through promises that never let a timer or another request run: other
    // requests get a turn every few milliseconds, or a 2,000-page file holds the server for seconds.
    const slicer = new TimeSlicer(signal);
    let textBytes = 0;
    let hasText = false;
    for (let number = 1; number <= document.numPages; number++) {
      signal?.throwIfAborted();
      const page = await document.getPage(number);
      const ref = page.ref;
      if (ref) {
        const key = `${ref.num} ${ref.gen}`;
        if (seen.has(key)) throw new Error(REPEATED_PAGE);
        seen.add(key);
      }
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter((item): item is PdfTextItem => typeof (item as PdfTextItem).str === "string");
      const transform = page.getViewport({ scale: 1 }).transform as number[];
      let text = "";
      let found: LayoutBox[] = [];
      if (tables) {
        try {
          ({ text, tables: found } = layoutPage(items, transform));
        } catch {
          // Unusual geometry must never lose a page: fall back to the plain order.
          text = plainPageText(items);
        }
      } else {
        text = plainPageText(items);
      }
      text = text.trim();
      if (text) hasText = true;
      // Counted as it is read: a small file can draw far more text than its own size.
      textBytes += utf8Bytes(text);
      if (textBytes > textLimit) throw tooMuchText();
      texts.push(text);
      geometry.push({ view: page.view, transform, tables: found });
      page.cleanup();
      input?.onProgress?.({ done: number, total: document.numPages, unit: "pages" });
      await slicer.maybePause();
    }
    if (!hasText) {
      // A scan has nothing to search, but a short one can be read by looking at its pages, when the
      // caller says that they can be shown. Every page then says that it has no text.
      const most = input?.scannedPages ?? 0;
      if (most <= 0) throw new Error("This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.");
      if (document.numPages > most) {
        throw new Error(`This PDF has no text layer (it may be scanned) and ${document.numPages} pages. Without text it can only be read by looking at its pages, which works for up to ${most} ${plural(most, "page")}. It needs OCR first.`);
      }
    }
    // Which pages show a picture. Undefined when that could not be found out: then none is marked.
    const looked = pageProgress(input, "pictures");
    const pictured = pictures ? await findPicturePages(parsed, geometry, signal, looked.report) : undefined;
    signal?.throwIfAborted();
    looked.rethrow();
    const pages = texts.map((text, index) => `--- Page ${index + 1} ---\n${pictured?.[index] ? `${PICTURE_ON_PAGE}\n` : ""}${text ? ownLines(text) : PAGE_WITHOUT_TEXT}`);
    return { text: pages.join("\n\n"), pages: document.numPages };
  };
}

export const defaultExtractors: Record<DocumentFormat, Extractor> = {
  text: plainText,
  markdown: plainText,
  log: plainText,
  json: plainText,
  csv: plainText,
  pdf: createPdfExtractor(),
  docx,
  pptx,
  xlsx,
  html,
};

export async function extractText(
  bytes: Uint8Array,
  input: ExtractInput,
  extractors: Partial<Record<DocumentFormat, Extractor>> = {},
): Promise<ExtractedText> {
  const extractor = extractors[input.format] ?? defaultExtractors[input.format];
  return extractor(bytes, input);
}
