import { layoutPage, plainPageText, type LayoutBox, type PdfTextItem } from "./pdf-layout.js";
import { findPicturePages, type PageGeometry } from "./pdf-pictures.js";
import type { DocumentFormat, ExtractedText, Extractor } from "./types.js";

const EXTENSION_FORMATS: Record<string, DocumentFormat> = {
  log: "log", out: "log", err: "log",
  md: "markdown", markdown: "markdown",
  json: "json", jsonl: "json", ndjson: "json",
  csv: "csv", tsv: "csv",
  pdf: "pdf", docx: "docx", pptx: "pptx",
};

const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/markdown": "markdown",
  "application/json": "json",
  "text/csv": "csv",
};

/** Picks a format from the file name, then the MIME type. Unknown text-like files are "text". */
export function detectFormat(name: string, mimeType: string): DocumentFormat {
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  return EXTENSION_FORMATS[extension] ?? MIME_FORMATS[mimeType.toLowerCase()] ?? "text";
}

const NOT_TEXT = "This file looks binary, not text. Attach a text, log, PDF, DOCX, or PPTX file.";

/**
 * Decodes text bytes, honoring UTF-8 and UTF-16 byte-order marks (common for Windows logs).
 * Throws a readable error for compressed and other binary files.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // Rotated logs often arrive as app.log.gz. Compressed bytes have few zeros, so name them here.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    throw new Error("This file is gzip-compressed. Decompress it, then attach the text file inside.");
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    throw new Error("This file is a ZIP archive. Extract it, then attach the text file you need.");
  }
  const sample = bytes.subarray(0, 8_192);
  let zeros = 0;
  for (const byte of sample) if (byte === 0) zeros++;
  // UTF-16 without a BOM: about half the bytes of ASCII text are zero.
  if (sample.length > 64 && zeros / sample.length > 0.3) {
    let oddZeros = 0;
    let evenText = 0;
    for (let index = 0; index < sample.length; index++) {
      if (index % 2 === 1 && sample[index] === 0) oddZeros++;
      if (index % 2 === 0 && sample[index] !== 0) evenText++;
    }
    const half = sample.length / 2;
    if (oddZeros / half > 0.6 && evenText / half > 0.6) return new TextDecoder("utf-16le").decode(bytes);
  }
  if (sample.length > 0 && zeros / sample.length > 0.01) throw new Error(NOT_TEXT);
  // Compressed, encrypted, and media files spread control bytes evenly: about 1 byte in 10.
  // Text has almost none, in UTF-8 or in a legacy single-byte encoding. Tab, line breaks, form
  // feed, and ESC (colour codes) do not count.
  let controls = 0;
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b) || byte === 0x7f) controls++;
  }
  if (sample.length >= 64 && controls / sample.length > 0.03) throw new Error(NOT_TEXT);
  return new TextDecoder("utf-8").decode(bytes);
}

const plainText: Extractor = async (bytes) => ({ text: decodeText(bytes) });

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Text of each `<prefix:p>` paragraph in Office XML. Regex keeps this free of an XML parser dependency. */
export function officeXmlParagraphs(xml: string, prefix: "w" | "a"): string[] {
  const paragraphs = xml.match(new RegExp(`<${prefix}:p[\\s>][\\s\\S]*?</${prefix}:p>`, "g")) ?? [];
  const textPattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:t>|<${prefix}:(tab|br)\\b[^>]*/>`, "g");
  return paragraphs.map((paragraph) => {
    let text = "";
    for (const match of paragraph.matchAll(textPattern)) {
      if (match[2] === "tab") text += "\t";
      else if (match[2] === "br") text += "\n";
      else text += decodeXmlEntities(match[1] ?? "");
    }
    return text;
  }).filter((text) => text.trim());
}

type ZipFile = { async(type: "string"): Promise<string> };
type ZipArchive = { files: Record<string, unknown>; file(name: string): ZipFile | null };

async function loadZip(bytes: Uint8Array): Promise<ZipArchive> {
  let JSZip: { loadAsync(data: Uint8Array): Promise<ZipArchive> };
  try {
    JSZip = (await import("jszip")).default as unknown as typeof JSZip;
  } catch {
    throw new Error("Reading DOCX and PPTX files needs the optional dependency \"jszip\".");
  }
  return JSZip.loadAsync(bytes);
}

const docx: Extractor = async (bytes) => {
  const archive = await loadZip(bytes);
  const names = Object.keys(archive.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name))
    .sort((left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right));
  if (!names.includes("word/document.xml")) throw new Error("This DOCX does not contain word/document.xml.");
  const sections: string[] = [];
  for (const name of names) {
    const xml = await archive.file(name)?.async("string");
    if (xml) sections.push(officeXmlParagraphs(xml, "w").join("\n"));
  }
  return { text: sections.filter(Boolean).join("\n\n") };
};

const pptx: Extractor = async (bytes) => {
  const archive = await loadZip(bytes);
  const slideNumber = (name: string) => Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const names = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  if (names.length === 0) throw new Error("This PPTX does not contain any slides.");
  const slides: string[] = [];
  for (const name of names) {
    const xml = await archive.file(name)?.async("string");
    const text = xml ? officeXmlParagraphs(xml, "a").join("\n") : "";
    slides.push(`## Slide ${slideNumber(name)}\n${text || "[No text on this slide]"}`);
  }
  return { text: slides.join("\n\n"), pages: names.length };
};

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
};

/** Written in place of a page that has no text at all, so the model can say so instead of guessing. */
const PAGE_WITHOUT_TEXT = "[No text on this page. It may be a scan, a photo, or a chart.]";
/**
 * Written under the header of a page that shows a picture or a drawing. The words hold whether or
 * not the model is later given a way to look at the page.
 */
export const PICTURE_ON_PAGE = "[Picture on this page. This text cannot show it.]";

/**
 * The built-in PDF extractor (needs `unpdf`). Use it to change an option:
 * `createLargeFiles({ extractors: { pdf: createPdfExtractor({ tables: false }) } })`.
 */
export function createPdfExtractor(options: PdfExtractorOptions = {}): Extractor {
  const tables = options.tables ?? true;
  const pictures = options.pictures ?? true;
  return async (bytes) => {
    let unpdf: typeof import("unpdf");
    try {
      unpdf = await import("unpdf");
    } catch {
      throw new Error("Reading PDF files needs the optional dependency \"unpdf\".");
    }
    // pdf.js may detach the buffer it reads, so give it a copy.
    const document = await unpdf.getDocumentProxy(new Uint8Array(bytes));
    const texts: string[] = [];
    const geometry: PageGeometry[] = [];
    let hasText = false;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
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
      texts.push(text);
      geometry.push({ view: page.view, transform, tables: found });
      page.cleanup();
    }
    if (!hasText) {
      throw new Error("This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.");
    }
    // Which pages show a picture. Undefined when that could not be found out: then none is marked.
    const pictured = pictures ? await findPicturePages(bytes, geometry) : undefined;
    const pages = texts.map((text, index) => `--- Page ${index + 1} ---\n${pictured?.[index] ? `${PICTURE_ON_PAGE}\n` : ""}${text || PAGE_WITHOUT_TEXT}`);
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
};

export async function extractText(
  bytes: Uint8Array,
  input: { name: string; mimeType: string; format: DocumentFormat },
  extractors: Partial<Record<DocumentFormat, Extractor>> = {},
): Promise<ExtractedText> {
  const extractor = extractors[input.format] ?? defaultExtractors[input.format];
  return extractor(bytes, input);
}
