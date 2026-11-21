import { TimeSlicer } from "./pause.js";
import { layoutPage, plainPageText, type LayoutBox, type PdfTextItem } from "./pdf-layout.js";
import { findPicturePages, parsePdf, type PageGeometry } from "./pdf-pictures.js";
import { checkPageWork, HeavyPage } from "./pdf-work.js";
import { formatBytes } from "./plan.js";
import { utf8Bytes } from "./text.js";
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
/** Paragraphs inside paragraphs, at most. Real files nest two or three: a text box in a paragraph. */
const MAX_PARAGRAPH_DEPTH = 32;
/** Paragraphs with text read from one Office file, at most: a document of 10,000 pages has about 300,000. */
const MAX_OFFICE_PARAGRAPHS = 1_000_000;
/** Characters of text kept from one Office file, at most, whatever `maxTextBytes` allows: about 10,000 dense pages. */
const MAX_OFFICE_CHARACTERS = 32_000_000;
/**
 * The text of an open paragraph is counted as written in the XML, where `&quot;` is six characters
 * for one: past this many times the limit, it is refused before the paragraph closes.
 */
const MAX_ENTITY_GROWTH = 6;
/** Below this length V8 copies a slice of a string; from it on, a slice keeps the whole string it was cut from. */
const SLICE_COPIED_BELOW = 13;

/** What an Office file may hold before it is refused, and what to call it in the refusal. */
type OfficeLimits = { kind: string; maxCharacters: number; byTextLimit: boolean };
const NO_OFFICE_LIMITS: OfficeLimits = { kind: "file", maxCharacters: MAX_OFFICE_CHARACTERS, byTextLimit: false };
/** The text and the paragraphs read from all the parts of one Office file so far. */
type OfficeCount = { characters: number; paragraphs: number };

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
 *
 * What it keeps in memory is bounded by the text, not by the XML: a paragraph becomes one string
 * when it closes, an empty one is dropped, and a file that nests paragraphs past
 * `MAX_PARAGRAPH_DEPTH`, or has more text or paragraphs than one document holds, is refused.
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
  /** The text of each paragraph, in the order the paragraphs start: null while it is open, "" when empty. */
  private readonly paragraphs: Array<string | null> = [];
  /** The paragraphs that are open, the innermost last: where each goes in `paragraphs`, its text so far, and its length. */
  private readonly open: Array<{ slot: number; pieces: string[]; length: number }> = [];
  /** Characters held in the paragraphs that are open, as written in the XML. */
  private pending = 0;
  private inText = false;
  private inProperties = 0;
  private inFallback = 0;
  /** The tag being read, from its "<": its name so far, the quote of a value it is in, its last character. */
  private tag: { name: string; named: boolean; quote: number; last: number } | undefined;

  /** `count`: what the other parts of the same file held, shared with them. */
  constructor(prefix: "w" | "a", private readonly limits: OfficeLimits = NO_OFFICE_LIMITS, private readonly count: OfficeCount = { characters: 0, paragraphs: 0 }) {
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
        if (end > at && this.inText && this.inProperties === 0 && this.inFallback === 0) this.add(xml.slice(at, end));
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
    // A paragraph never closed keeps the text it has, as when the file ends inside it.
    while (this.open.length > 0) this.close();
    return this.paragraphs.filter((text): text is string => !!text);
  }

  /** Adds text to the innermost open paragraph. */
  private add(piece: string): void {
    const paragraph = this.open.at(-1);
    if (!paragraph) return;
    this.pending += piece.length;
    paragraph.length += piece.length;
    // The decoded text is counted when its paragraph closes. Until then, what is held is bounded too.
    if (this.pending > this.limits.maxCharacters * MAX_ENTITY_GROWTH) throw this.tooMuchText();
    paragraph.pieces.push(piece);
  }

  private tooMuchText(): Error {
    const { kind, maxCharacters, byTextLimit } = this.limits;
    return new Error(byTextLimit
      ? `This ${kind} holds more than ${formatBytes(maxCharacters)} of text, more than is kept from one file. Split it, and attach the part you need.`
      : `This ${kind} holds more than ${Math.round(maxCharacters / 1_000_000)} million characters of text, more than is read from one file. Split it, and attach the part you need.`);
  }

  /** Closes the innermost open paragraph: its text becomes one string, or it is dropped when empty. */
  private close(): void {
    const paragraph = this.open.pop();
    if (!paragraph) return;
    this.pending -= paragraph.length;
    const text = decodeXmlEntities(paragraph.pieces.join(""));
    if (text.trim()) {
      this.count.characters += text.length;
      if (this.count.characters > this.limits.maxCharacters) throw this.tooMuchText();
      if (++this.count.paragraphs > MAX_OFFICE_PARAGRAPHS) {
        throw new Error(`This ${this.limits.kind} has more than ${MAX_OFFICE_PARAGRAPHS.toLocaleString("en-US")} paragraphs, more than a document holds. It may be built to exhaust the server, so it is not read.`);
      }
      // A copy, not a slice of the piece of XML it came from: a slice would keep all that XML in memory.
      this.paragraphs[paragraph.slot] = text.length < SLICE_COPIED_BELOW ? text : (" " + text).slice(1);
    } else if (paragraph.slot === this.paragraphs.length - 1) {
      this.paragraphs.pop();
    } else {
      this.paragraphs[paragraph.slot] = "";
    }
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
        if (this.open.length >= MAX_PARAGRAPH_DEPTH) {
          throw new Error(`This ${this.limits.kind} nests paragraphs more than ${MAX_PARAGRAPH_DEPTH} deep, which no document does. It may be built to exhaust the server, so it is not read.`);
        }
        this.open.push({ slot: this.paragraphs.length, pieces: [], length: 0 });
        this.paragraphs.push(null);
      }
    } else if (name === this.paragraphEnd) {
      this.close();
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
      if (name === this.tabTag) this.add("\t");
      else if (this.breakTags.has(name)) this.add("\n");
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
 * that much is in memory. JSZip can unpack megabytes of XML in one turn of the event loop, so the
 * stream is paused every few milliseconds of reading, and other requests get a turn.
 */
function officeReader(archive: ZipArchive, kind: "DOCX" | "PPTX", size: number, input: ExtractInput | undefined) {
  const limit = Math.min(MAX_OFFICE_XML, Math.max(OFFICE_ALLOWANCE, size * MAX_OFFICE_EXPANSION));
  const refusal = limit === MAX_OFFICE_XML
    ? `This ${kind} unpacks to more than ${megabytes(limit)} of XML, more than is read from one file. Save it as text or PDF, and attach that.`
    : `This ${kind} unpacks to more than ${megabytes(limit)}, over ${MAX_OFFICE_EXPANSION} times its size. A file that grows that much is not read: it may be a zip bomb. Save it as text or PDF, and attach that.`;
  const maxTextBytes = input?.maxTextBytes ?? Number.POSITIVE_INFINITY;
  // A character is at least one byte: a text with more characters than the limit is past it.
  const limits: OfficeLimits = {
    kind,
    maxCharacters: Math.min(MAX_OFFICE_CHARACTERS, maxTextBytes),
    byTextLimit: maxTextBytes < MAX_OFFICE_CHARACTERS,
  };
  // One count for the whole file, across its parts.
  const count: OfficeCount = { characters: 0, paragraphs: 0 };
  const slicer = new TimeSlicer(input?.signal);
  let unpacked = 0;
  return (name: string, prefix: "w" | "a") => new Promise<string[]>((resolve, reject) => {
    const file = archive.file(name);
    if (!file) {
      resolve([]);
      return;
    }
    const text = new OfficeText(prefix, limits, count);
    let stopped = false;
    let pausing = false;
    let ended = false;
    const stream = file.internalStream("string");
    const stop = (error: unknown) => {
      if (stopped) return;
      stopped = true;
      stream.pause();
      reject(error);
    };
    const finish = () => {
      try {
        resolve(text.texts());
      } catch (error) {
        stop(error);
      }
    };
    stream
      .on("data", (chunk) => {
        if (stopped) return;
        if (input?.signal?.aborted) {
          stop(input.signal.reason);
          return;
        }
        unpacked += chunk.length;
        if (unpacked > limit) {
          stop(new Error(refusal));
          return;
        }
        try {
          text.write(chunk);
        } catch (error) {
          stop(error);
          return;
        }
        if (!pausing && slicer.due) {
          pausing = true;
          stream.pause();
          slicer.pauseNow().then(() => {
            pausing = false;
            if (stopped) return;
            if (ended) finish();
            else stream.resume();
          }, stop);
        }
      })
      .on("error", stop)
      .on("end", () => {
        ended = true;
        if (!stopped && !pausing) finish();
      })
      .resume();
  });
}

/**
 * The parts an Office file may have, at most. A deck of 2,000 slides with notes and pictures has
 * about 12,000. JSZip reads the header of every part into memory before any part is unpacked: 300,000
 * empty parts took over 500 MB.
 */
const MAX_ZIP_ENTRIES = 20_000;

/**
 * How many parts a ZIP file says it has, from its end-of-central-directory record, without
 * reading the parts. When that field holds 65,535 (more than it can hold), the count is read from
 * the ZIP64 record it points to; 65,535 when there is none. Undefined when there is no end record:
 * the file is not a ZIP, or is damaged, and JSZip will say so.
 */
export function zipEntryCount(bytes: Uint8Array): number | undefined {
  const at4 = (at: number, third: number, fourth: number) => bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === third && bytes[at + 3] === fourth;
  // The record is 22 bytes, followed by a comment of at most 65,535 bytes.
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at--) {
    if (!at4(at, 0x05, 0x06)) continue;
    const count = bytes[at + 10]! | (bytes[at + 11]! << 8);
    if (count !== 0xffff) return count;
    // ZIP64: a 20-byte locator just before the record gives the offset of the ZIP64 end record,
    // which holds the count in 8 bytes.
    const locator = at - 20;
    if (locator < 0 || !at4(locator, 0x06, 0x07)) return count;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = Number(view.getBigUint64(locator + 8, true));
    if (!Number.isSafeInteger(offset) || offset + 56 > bytes.length || !at4(offset, 0x06, 0x06)) return count;
    const total = Number(view.getBigUint64(offset + 32, true));
    return Number.isSafeInteger(total) ? total : count;
  }
  return undefined;
}

async function loadZip(bytes: Uint8Array, kind: "DOCX" | "PPTX"): Promise<ZipArchive> {
  let JSZip: { loadAsync(data: Uint8Array): Promise<ZipArchive> };
  try {
    JSZip = (await import("jszip")).default as unknown as typeof JSZip;
  } catch {
    throw new Error("Reading DOCX and PPTX files needs the optional dependency \"jszip\".");
  }
  const entries = zipEntryCount(bytes);
  if (entries !== undefined && entries > MAX_ZIP_ENTRIES) {
    throw new Error(`This ${kind} has ${entries === 0xffff ? "over 65,000" : entries.toLocaleString("en-US")} parts, more than an Office document has. It may be built to exhaust the server, so it is not read.`);
  }
  return JSZip.loadAsync(bytes);
}

const docx: Extractor = async (bytes, input) => {
  input?.signal?.throwIfAborted();
  const archive = await loadZip(bytes, "DOCX");
  input?.signal?.throwIfAborted();
  const names = Object.keys(archive.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name))
    .sort((left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right));
  if (!names.includes("word/document.xml")) throw new Error("This DOCX does not contain word/document.xml.");
  const read = officeReader(archive, "DOCX", bytes.byteLength, input);
  const sections: string[] = [];
  for (const name of names) sections.push((await read(name, "w")).join("\n"));
  return { text: sections.filter(Boolean).join("\n\n") };
};

const pptx: Extractor = async (bytes, input) => {
  input?.signal?.throwIfAborted();
  const archive = await loadZip(bytes, "PPTX");
  input?.signal?.throwIfAborted();
  const slideNumber = (name: string) => Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const names = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  if (names.length === 0) throw new Error("This PPTX does not contain any slides.");
  const read = officeReader(archive, "PPTX", bytes.byteLength, input);
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

/**
 * The built-in PDF extractor (needs `unpdf`). Use it to change an option:
 * `createLargeFiles({ extractors: { pdf: createPdfExtractor({ tables: false }) } })`.
 */
export function createPdfExtractor(options: PdfExtractorOptions = {}): Extractor {
  const tables = options.tables ?? true;
  const pictures = options.pictures ?? true;
  const checkPages = options.checkPages ?? true;
  return async (bytes, input) => {
    let unpdf: typeof import("unpdf");
    try {
      unpdf = await import("unpdf");
    } catch {
      throw new Error("Reading PDF files needs the optional dependency \"unpdf\".");
    }
    const signal = input?.signal;
    signal?.throwIfAborted();
    // pdf.js may detach the buffer it reads, so give it a copy.
    const document = await unpdf.getDocumentProxy(new Uint8Array(bytes));
    const maxPages = input?.maxPages;
    if (maxPages !== undefined && document.numPages > maxPages) {
      throw new Error(`This PDF has ${document.numPages.toLocaleString("en-US")} pages, more than the ${maxPages.toLocaleString("en-US")} read from one file. Split it, and attach the part you need.`);
    }
    // Read once with @cantoo/pdf-lib, when it is installed: to refuse a page that would hold the
    // server before pdf.js reads it, and to mark the pages that show a picture.
    let parsed = checkPages || pictures ? await parsePdf(bytes, signal) : undefined;
    signal?.throwIfAborted();
    if (parsed && checkPages) {
      try {
        await checkPageWork(parsed.library, parsed.document, bytes.byteLength, signal);
      } catch (error) {
        if (error instanceof HeavyPage) throw new Error(error.reason === "unreadable" ? UNREADABLE_PAGE(error.page) : error.reason === "file" ? HEAVY_FILE : HEAVY_PAGE(error.page));
        signal?.throwIfAborted();
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
      await slicer.maybePause();
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
    const pictured = pictures ? await findPicturePages(parsed, geometry, signal) : undefined;
    signal?.throwIfAborted();
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
