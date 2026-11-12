/**
 * The index of a stored text: where each line starts, as a byte offset into its UTF-8 bytes, and
 * which lines start a passage (keyword search) or a page ("--- Page N ---"). With it a tool call
 * reads only the lines it needs instead of loading the whole text.
 *
 * It is built from the bytes of the text, in one pass, at ingest (and written next to the text
 * with `putIndex`), or the first time an older document without one is used.
 */
import type { DocumentMeta } from "./types.js";

/** A passage, for keyword search, is a run of lines of about this many characters... */
export const PASSAGE_CHARACTERS = 1_500;
/** ...and at most this many lines. */
export const PASSAGE_MAX_LINES = 40;

export type TextIndex = {
  /** Lines in the text. A newline at the very end does not start another one. */
  lineCount: number;
  /** UTF-8 bytes of the text. */
  textBytes: number;
  /** UTF-16 code units of the text, which is its `length` as a JavaScript string. */
  characters: number;
  /** Where line n starts: `lineStarts[n - 1]`, in bytes. */
  lineStarts: Uint32Array;
  /** Where line n starts in the text as a string: `characterStarts[n - 1]`, in UTF-16 units. */
  characterStarts: Uint32Array;
  /** The first line of each passage. */
  passageStarts: Uint32Array;
  /** The line of each "--- Page N ---" marker that counts up from 1. */
  pageStarts: Uint32Array;
};

const PAGE_MARKER = Array.from("--- Page ", (character) => character.charCodeAt(0));
/** The longest line that is looked at as a possible page marker. */
const HEAD_BYTES = 48;

/** Builds a `TextIndex` from the bytes of a text, given in pieces of any size. */
export class TextIndexBuilder {
  private starts = new Uint32Array(1_024);
  private characterStarts = new Uint32Array(1_024);
  private lineCount = 0;
  private readonly passages: number[] = [];
  private readonly pages: number[] = [];
  private bytes = 0;
  private characters = 0;
  private inLine = false;
  private lineUnits = 0;
  private readonly head = new Uint8Array(HEAD_BYTES);
  private headLength = 0;
  private passageOpen = false;
  private passageCharacters = 0;
  private passageLines = 0;

  push(chunk: Uint8Array): void {
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]!;
      if (!this.inLine) this.startLine();
      if (byte === 10) {
        this.endLine();
        this.characters++;
      } else {
        if (this.headLength < HEAD_BYTES) this.head[this.headLength] = byte;
        this.headLength++;
        // A UTF-8 sequence is one UTF-16 unit, or two for one of four bytes (outside the basic plane).
        if ((byte & 0xc0) !== 0x80) {
          const units = byte >= 0xf0 ? 2 : 1;
          this.lineUnits += units;
          this.characters += units;
        }
      }
      this.bytes++;
    }
  }

  finish(): TextIndex {
    if (this.inLine) this.endLine();
    return {
      lineCount: this.lineCount,
      textBytes: this.bytes,
      characters: this.characters,
      lineStarts: this.starts.slice(0, this.lineCount),
      characterStarts: this.characterStarts.slice(0, this.lineCount),
      passageStarts: Uint32Array.from(this.passages),
      pageStarts: Uint32Array.from(this.pages),
    };
  }

  private startLine(): void {
    if (this.lineCount === this.starts.length) {
      const grown = new Uint32Array(this.starts.length * 2);
      grown.set(this.starts);
      this.starts = grown;
      const grownCharacters = new Uint32Array(this.characterStarts.length * 2);
      grownCharacters.set(this.characterStarts);
      this.characterStarts = grownCharacters;
    }
    this.characterStarts[this.lineCount] = this.characters;
    this.starts[this.lineCount++] = this.bytes;
    this.inLine = true;
    this.lineUnits = 0;
    this.headLength = 0;
  }

  private endLine(): void {
    const line = this.lineCount;
    // Passages: the same rule as SearchableDocument.passages, one line at a time.
    if (!this.passageOpen) {
      this.passages.push(line);
      this.passageOpen = true;
      this.passageCharacters = 0;
      this.passageLines = 0;
    }
    this.passageCharacters += this.lineUnits + 1;
    this.passageLines++;
    if (this.passageLines >= PASSAGE_MAX_LINES || this.passageCharacters >= PASSAGE_CHARACTERS) this.passageOpen = false;
    // Pages: a line that is exactly the next marker. The marker is ASCII, so bytes compare as text.
    if (this.headLength <= HEAD_BYTES && this.headLength > PAGE_MARKER.length && PAGE_MARKER.every((code, at) => this.head[at] === code)) {
      let marker = "";
      for (let at = 0; at < this.headLength; at++) marker += String.fromCharCode(this.head[at]!);
      if (marker === `--- Page ${this.pages.length + 1} ---`) this.pages.push(line);
    }
    this.inLine = false;
  }
}

/** The index of a text held as a string, built from its UTF-8 bytes a slice at a time. */
export function buildTextIndex(text: string): TextIndex {
  const builder = new TextIndexBuilder();
  const slice = 1 << 20;
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + slice);
    // Never cut between the two halves of a surrogate pair: each half alone encodes as U+FFFD.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++;
    builder.push(Buffer.from(text.slice(at, end), "utf8"));
    at = end;
  }
  return builder.finish();
}

// The file: a 40-byte header, then the lists of 32-bit numbers (line starts in bytes, line starts
// in characters, passage starts, page starts), all little-endian.
//   0  "LLFI"   4  version   8  lineCount   12  passages   16  pages   20  unused
//  24  textBytes (float64)  32  characters (float64)
const MAGIC = [0x4c, 0x4c, 0x46, 0x49];
const VERSION = 1;
const HEADER = 40;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Whether an index can be written in this format: offsets are 32-bit. */
export function canSerialize(index: TextIndex): boolean {
  return index.textBytes <= 0xffff_ffff;
}

export function serializeTextIndex(index: TextIndex): Uint8Array {
  const counts = [index.lineStarts.length, index.passageStarts.length, index.pageStarts.length];
  const out = new Uint8Array(HEADER + 4 * (2 * counts[0]! + counts[1]! + counts[2]!));
  const view = new DataView(out.buffer);
  MAGIC.forEach((byte, at) => view.setUint8(at, byte));
  view.setUint32(4, VERSION, true);
  view.setUint32(8, counts[0]!, true);
  view.setUint32(12, counts[1]!, true);
  view.setUint32(16, counts[2]!, true);
  view.setFloat64(24, index.textBytes, true);
  view.setFloat64(32, index.characters, true);
  let at = HEADER;
  for (const list of [index.lineStarts, index.characterStarts, index.passageStarts, index.pageStarts]) {
    if (LITTLE_ENDIAN) out.set(new Uint8Array(list.buffer, list.byteOffset, list.byteLength), at);
    else list.forEach((value, i) => view.setUint32(at + 4 * i, value, true));
    at += list.byteLength;
  }
  return out;
}

function readList(bytes: Uint8Array, at: number, count: number): Uint32Array {
  if (LITTLE_ENDIAN) return new Uint32Array(bytes.slice(at, at + 4 * count).buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: count }, (_, i) => view.getUint32(at + 4 * i, true));
}

const ascending = (list: Uint32Array, first: number, last: number): boolean => {
  let previous = -1;
  for (const value of list) {
    if (value <= previous || value < first || value > last) return false;
    previous = value;
  }
  return true;
};

/**
 * Reads an index written by `serializeTextIndex`. Undefined when it is damaged, cut short, of
 * another version, or does not describe the text of `meta`: the caller then builds it again from
 * the text. An index is only a faster way to the same text, so a doubtful one is never used.
 */
export function parseTextIndex(bytes: Uint8Array, meta?: Pick<DocumentMeta, "lines" | "characters">): TextIndex | undefined {
  if (bytes.length < HEADER || MAGIC.some((byte, at) => bytes[at] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== VERSION) return undefined;
  const lineCount = view.getUint32(8, true);
  const passageCount = view.getUint32(12, true);
  const pageCount = view.getUint32(16, true);
  const textBytes = view.getFloat64(24, true);
  const characters = view.getFloat64(32, true);
  if (bytes.length !== HEADER + 4 * (2 * lineCount + passageCount + pageCount)) return undefined;
  if (!Number.isSafeInteger(textBytes) || !Number.isSafeInteger(characters) || lineCount < 1 || passageCount < 1) return undefined;
  if (meta && (meta.lines !== lineCount || meta.characters !== characters)) return undefined;
  const lineStarts = readList(bytes, HEADER, lineCount);
  const characterStarts = readList(bytes, HEADER + 4 * lineCount, lineCount);
  const passageStarts = readList(bytes, HEADER + 8 * lineCount, passageCount);
  const pageStarts = readList(bytes, HEADER + 4 * (2 * lineCount + passageCount), pageCount);
  if (lineStarts[0] !== 0 || !ascending(lineStarts, 0, textBytes - 1)) return undefined;
  if (characterStarts[0] !== 0 || !ascending(characterStarts, 0, characters - 1)) return undefined;
  if (passageStarts[0] !== 1 || !ascending(passageStarts, 1, lineCount)) return undefined;
  if (!ascending(pageStarts, 1, lineCount)) return undefined;
  return { lineCount, textBytes, characters, lineStarts, characterStarts, passageStarts, pageStarts };
}

/** The 1-based position of `line` among sorted `starts`: the page or passage a line is in. */
export function positionOf(starts: ArrayLike<number>, line: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= line) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}
