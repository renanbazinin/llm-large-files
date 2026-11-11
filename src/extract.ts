import { layoutPage, plainPageText, type LayoutBox, type PdfTextItem } from "./pdf-layout.js";
import { findPicturePages, type PageGeometry } from "./pdf-pictures.js";
import type { DocumentFormat, ExtractedText, ExtractInput, Extractor } from "./types.js";

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

/** A tag name is read up to this many characters: the names that matter here are short. */
const MAX_TAG_NAME = 64;

/**
 * Collects the text of each paragraph of Office XML (`<w:p>` in Word, `<a:p>` in PowerPoint) in one
 * pass, with no XML parser. The XML can come in pieces, as it is unpacked: a tag cut between two
 * pieces is read whole. Every character is looked at once, so the time follows the length of the
 * XML whatever its shape: a file of unclosed tags costs what a file of closed ones does.
 *
 * - A paragraph inside another one (the text box of a shape anchored in a paragraph) is a paragraph
 *   of its own, after the one it is anchored in, which keeps its text before and after the box.
 * - `mc:Fallback` repeats `mc:Choice` for older programs, so it is skipped: a text box is read once.
 * - Paragraph properties hold no text. Their tab stops are not tabs.
 */
class OfficeText {
  private readonly paragraphTag: string;
  private readonly paragraphEnd: string;
  private readonly textTag: string;
  private readonly textEnd: string;
  private readonly propertiesTag: string;
  private readonly propertiesEnd: string;
  private readonly tabTag: string;
  private readonly breakTags: ReadonlySet<string>;
  /** The pieces of text of each paragraph, in the order the paragraphs start. */
  private readonly paragraphs: string[][] = [];
  /** The paragraphs that are open, the innermost last. */
  private readonly open: string[][] = [];
  private inText = false;
  private inProperties = 0;
  private inFallback = 0;
  /** The tag being read, from its "<": its name so far, the quote of a value it is in, its last character. */
  private tag: { name: string; named: boolean; quote: number; last: number } | undefined;

  constructor(prefix: "w" | "a") {
    this.paragraphTag = `${prefix}:p`;
    this.paragraphEnd = `/${prefix}:p`;
    this.textTag = `${prefix}:t`;
    this.textEnd = `/${prefix}:t`;
    this.propertiesTag = `${prefix}:pPr`;
    this.propertiesEnd = `/${prefix}:pPr`;
    this.tabTag = `${prefix}:tab`;
    this.breakTags = new Set([`${prefix}:br`, `${prefix}:cr`]);
  }

  write(xml: string): void {
    const length = xml.length;
    let at = 0;
    while (at < length) {
      const tag = this.tag;
      if (!tag) {
        const start = xml.indexOf("<", at);
        const end = start === -1 ? length : start;
        if (end > at && this.inText && this.inProperties === 0 && this.inFallback === 0) this.open.at(-1)?.push(xml.slice(at, end));
        if (start === -1) return;
        this.tag = { name: "", named: false, quote: 0, last: 0 };
        at = start + 1;
        continue;
      }
      for (; at < length; at++) {
        const code = xml.charCodeAt(at);
        if (tag.quote !== 0) {
          if (code === tag.quote) tag.quote = 0;
          continue;
        }
        if (!tag.named) {
          // A name ends at white space, at ">", or at the "/" of "<w:br/>". "</w:p>" starts with one.
          if (code === 62 || code === 32 || code === 9 || code === 10 || code === 13 || (code === 47 && tag.name !== "")) tag.named = true;
          else {
            if (tag.name.length < MAX_TAG_NAME) tag.name += xml[at];
            continue;
          }
        }
        if (code === 62) break;
        if (code === 34 || code === 39) tag.quote = code;
        else if (code !== 32 && code !== 9 && code !== 10 && code !== 13) tag.last = code;
      }
      if (at === length) return; // The tag goes on in the next piece.
      this.tag = undefined;
      this.read(tag.name, tag.last === 47);
      at++;
    }
  }

  /** The text of each paragraph that has some, in the order the paragraphs start. */
  texts(): string[] {
    return this.paragraphs.map((pieces) => decodeXmlEntities(pieces.join(""))).filter((text) => text.trim());
  }

  /** Acts on a tag that has been read. `empty` is a tag that closes itself, as `<w:br/>`. */
  private read(name: string, empty: boolean): void {
    if (name === "mc:Fallback") {
      if (!empty) this.inFallback++;
      return;
    }
    if (name === "/mc:Fallback") {
      if (this.inFallback > 0) this.inFallback--;
      return;
    }
    if (this.inFallback > 0) return;
    if (name === this.paragraphTag) {
      if (!empty) {
        const pieces: string[] = [];
        this.paragraphs.push(pieces);
        this.open.push(pieces);
      }
    } else if (name === this.paragraphEnd) {
      this.open.pop();
      this.inText = false;
      this.inProperties = 0;
    } else if (name === this.textTag) {
      this.inText = !empty;
    } else if (name === this.textEnd) {
      this.inText = false;
    } else if (name === this.propertiesTag) {
      if (!empty) this.inProperties++;
    } else if (name === this.propertiesEnd) {
      if (this.inProperties > 0) this.inProperties--;
    } else if (this.inProperties === 0) {
      if (name === this.tabTag) this.open.at(-1)?.push("\t");
      else if (this.breakTags.has(name)) this.open.at(-1)?.push("\n");
    }
  }
}

/** Text of each paragraph of Office XML, in the order the paragraphs start. See `OfficeText`. */
export function officeXmlParagraphs(xml: string, prefix: "w" | "a"): string[] {
  const text = new OfficeText(prefix);
  text.write(xml);
  return text.texts();
}

/** The part of JSZip's stream of one file that is used here. */
type ZipStream = {
  on(event: "data", listener: (chunk: string) => void): ZipStream;
  on(event: "error", listener: (error: unknown) => void): ZipStream;
  on(event: "end", listener: () => void): ZipStream;
  resume(): ZipStream;
  pause(): ZipStream;
};
/** `internalStream` hands out a file of the archive in pieces, as it is unpacked. */
type ZipFile = { internalStream(type: "string"): ZipStream };
type ZipArchive = { files: Record<string, unknown>; file(name: string): ZipFile | null };

/** The most XML read from one DOCX or PPTX, whatever its size: a document of thousands of pages. */
const MAX_OFFICE_XML = 128 * 1024 * 1024;
/**
 * The parts read from an Office file unpack to less than its size: pictures, fonts and styles stay
 * packed. A generated report that repeats one paragraph 50,000 times unpacks to 90 times its size.
 * A file that unpacks to more than this many times its size, past the first 16 MB, is taken for a
 * zip bomb, as Apache POI does.
 */
const MAX_OFFICE_EXPANSION = 100;
const OFFICE_ALLOWANCE = 16 * 1024 * 1024;

const megabytes = (size: number) => `${Math.round(size / 1024 / 1024)} MB`;

/**
 * Reads the paragraphs of the parts of one DOCX or PPTX, each a piece at a time as it is unpacked,
 * counting what is unpacked: a file that grows far past its size is refused as it grows, before
 * that much is in memory. Unpacking yields to other work between pieces.
 */
function officeReader(archive: ZipArchive, kind: "DOCX" | "PPTX", size: number) {
  const limit = Math.min(MAX_OFFICE_XML, Math.max(OFFICE_ALLOWANCE, size * MAX_OFFICE_EXPANSION));
  const refusal = limit === MAX_OFFICE_XML
    ? `This ${kind} unpacks to more than ${megabytes(limit)} of XML, more than is read from one file. Save it as text or PDF, and attach that.`
    : `This ${kind} unpacks to more than ${megabytes(limit)}, over ${MAX_OFFICE_EXPANSION} times its size. A file that grows that much is not read: it may be a zip bomb. Save it as text or PDF, and attach that.`;
  let unpacked = 0;
  return (name: string, prefix: "w" | "a") => new Promise<string[]>((resolve, reject) => {
    const file = archive.file(name);
    if (!file) {
      resolve([]);
      return;
    }
    const text = new OfficeText(prefix);
    let stopped = false;
    const stream = file.internalStream("string");
    stream
      .on("data", (chunk) => {
        if (stopped) return;
        unpacked += chunk.length;
        if (unpacked > limit) {
          stopped = true;
          stream.pause();
          reject(new Error(refusal));
          return;
        }
        text.write(chunk);
      })
      .on("error", (error) => {
        stopped = true;
        reject(error);
      })
      .on("end", () => {
        if (!stopped) resolve(text.texts());
      })
      .resume();
  });
}

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
  const read = officeReader(archive, "DOCX", bytes.byteLength);
  const sections: string[] = [];
  for (const name of names) sections.push((await read(name, "w")).join("\n"));
  return { text: sections.filter(Boolean).join("\n\n") };
};

const pptx: Extractor = async (bytes) => {
  const archive = await loadZip(bytes);
  const slideNumber = (name: string) => Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const names = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  if (names.length === 0) throw new Error("This PPTX does not contain any slides.");
  const read = officeReader(archive, "PPTX", bytes.byteLength);
  const slides: string[] = [];
  for (const name of names) {
    const text = (await read(name, "a")).join("\n");
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
  return async (bytes, input) => {
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
      // A scan has nothing to search, but a short one can be read by looking at its pages, when the
      // caller says that they can be shown. Every page then says that it has no text.
      const most = input?.scannedPages ?? 0;
      if (most <= 0) throw new Error("This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.");
      if (document.numPages > most) {
        throw new Error(`This PDF has no text layer (it may be scanned) and ${document.numPages} pages. Without text it can only be read by looking at its pages, which works for up to ${most} pages. It needs OCR first.`);
      }
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
  input: ExtractInput,
  extractors: Partial<Record<DocumentFormat, Extractor>> = {},
): Promise<ExtractedText> {
  const extractor = extractors[input.format] ?? defaultExtractors[input.format];
  return extractor(bytes, input);
}
