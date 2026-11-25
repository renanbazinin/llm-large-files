import { LEGACY_OFFICE } from "./decode.js";
import { importPeer } from "./peers.js";
import { TimeSlicer } from "./pause.js";
import { formatBytes } from "./plan.js";
import { MAX_LINE_CHARACTERS, sliceWhole } from "./text.js";
import type { ExtractInput, Extractor } from "./types.js";
import { WordNumbering, type ParagraphStyle } from "./word-styles.js";
import { decodeEntities, parseAttributes, readRelationships, readXml } from "./xml-stream.js";
import { readZipDirectory } from "./zip-directory.js";

// Office files are ZIP archives of XML: Word (DOCX) and PowerPoint (PPTX) are read here, and the
// parts are streamed for the spreadsheet reader (xlsx.ts) too. No XML parser is used: each part is
// read a piece at a time as it is unpacked, under limits a hostile file cannot get past.

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
/** The attributes of a tag are read up to this many characters: the few that are read are short. */
const MAX_RAW_TAG = 1_024;
/** Grid columns one table cell may span (`w:gridSpan`); Word allows 63 columns in a table. */
const MAX_CELL_SPAN = 63;
/** Tags whose attributes are read, beside `w:vanish` and `p:sld`. */
const WORD_ATTRIBUTE_TAGS = new Set(["w:pStyle", "w:numId", "w:ilvl", "w:outlineLvl", "w:gridSpan", "w:gridBefore", "w:gridAfter", "w:sym"]);
const DRAWING_ATTRIBUTE_TAGS = new Set(["p:ph"]);
/** The properties of a Word table row and cell, and those of them that are read. */
const TABLE_PROPERTY_TAGS = new Set(["w:trPr", "/w:trPr", "w:tcPr", "/w:tcPr", "w:gridSpan", "w:gridBefore", "w:gridAfter"]);
/**
 * The placeholders of a notes page whose text is not the speaker's notes: the slide number, the
 * date, the header and the footer (Header & Footer, Notes and Handouts), and the picture of the
 * slide. The notes are in the body placeholder; a text box the presenter added is kept too.
 */
const NOTES_PAGE_PLACEHOLDERS: ReadonlySet<string> = new Set(["sldNum", "dt", "hdr", "ftr", "sldImg"]);

/** How the text of a part is read: with Word's numbering, or as a PowerPoint notes page. */
type PartOptions = { numbering?: WordNumbering; notesPage?: boolean };

/** A table cell's text as a cell of a `| cell | cell |` row: one line, its pipes escaped, as the PDF extractor writes them. */
function cellText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Written before each line of the text that Word hides (a run marked `<w:vanish/>`), after the text
 * of its paragraph that shows: a person reading the document does not see it. Each line is marked,
 * so hidden text cannot end the mark and pass for text that shows.
 */
export const HIDDEN_TEXT = "[Hidden text, not shown in the document]";
/** Added to the heading of a slide that the slide show skips (`<p:sld show="0">`). */
export const HIDDEN_SLIDE = "(hidden, not shown in the slide show)";
/**
 * The one attribute read of `w:vanish` and of `p:sld`, and the values that count:
 * `<w:vanish w:val="0"/>` turns hiding off (`<w:vanish/>` and any other value turn it on), and a
 * slide with `show="0"` is hidden. Letter case counts in the value of `show`, and not in that of
 * `w:val`. It counts in names, as in XML: `W:VAL` is another attribute.
 */
const VANISH_OFF = { name: "w:val", values: ["0", "false", "off"], anyCase: true };
const SLIDE_NOT_SHOWN = { name: "show", values: ["0", "false"], anyCase: false };
type WantedAttribute = typeof VANISH_OFF;
/** Characters kept of an attribute's name and of the value wanted: more than the longest of those above. */
const MAX_ATTRIBUTE_PART = 6;
/**
 * A line of hidden text longer than this is cut into pieces, each marked. A mark and its piece then
 * fit on one line, which ingest does not cut: past `MAX_LINE_CHARACTERS` it would put the rest of
 * the hidden line on a line of its own, without the mark.
 */
// A tenth is kept free: ingest composes the text (NFC) and bounds runs of marks after it is cut,
// which can lengthen a line, and a line past the wrap limit would leave its rest without a mark.
const HIDDEN_PIECE = Math.floor((MAX_LINE_CHARACTERS - HIDDEN_TEXT.length - 1) * 0.9);
/**
 * What ends a line of hidden text: a line break, a carriage return (ingest makes it one), a U+0085
 * (ingest makes it one in a text with no other line break), or a line or paragraph separator
 * (U+2028, U+2029), which a model may take for one. A new marked line where ingest removes the
 * U+0085 instead does no harm.
 */
const HIDDEN_LINE_END = /[\r\n\x85\u2028\u2029]/g;
/** Where a line of hidden text starts: at a character that is not white space, nor a U+0085. */
const NOT_SPACE = /[^\s\x85]/g;

/**
 * Reads one attribute of a tag as the tag goes past, a character at a time, in whatever pieces the
 * XML comes: whether its value is one of those wanted. It keeps a few characters, whatever the
 * length of the tag, and looks at names and values apart, so a value that holds `w:val="0"` is not
 * read as the attribute.
 */
class AttributeReader {
  /** The name being read, or the last one read, cut after `MAX_ATTRIBUTE_PART` characters. */
  private name = "";
  /** Whether the next character of a name starts a new one. */
  private ended = true;
  /** Whether "=" came after the name wanted, so the next value is its value. */
  private assigned = false;
  /** The value of the attribute wanted, while it is read. */
  private value: string | undefined;
  /** Whether the attribute wanted has one of the values wanted. */
  found = false;

  constructor(private readonly wanted: WantedAttribute) {}

  /** A character of the tag after its name, outside a value. A quote that opens a value is not one. */
  outside(code: number): void {
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      this.ended = true;
    } else if (code === 61) {
      this.assigned = this.name === this.wanted.name;
      this.name = "";
      this.ended = true;
    } else {
      if (this.ended) {
        this.name = "";
        this.ended = false;
        this.assigned = false;
      }
      if (this.name.length < MAX_ATTRIBUTE_PART) this.name += String.fromCharCode(code);
    }
  }

  /** A quote opens a value. */
  open(): void {
    if (this.assigned) this.value = "";
    this.assigned = false;
  }

  /** A character of a value. */
  inValue(code: number): void {
    if (this.value !== undefined && this.value.length < MAX_ATTRIBUTE_PART) this.value += String.fromCharCode(code);
  }

  /** The quote that closes a value. */
  close(): void {
    if (this.value !== undefined) {
      this.found = this.wanted.values.includes(this.wanted.anyCase ? this.value.toLowerCase() : this.value);
      this.value = undefined;
    }
    this.name = "";
    this.ended = true;
  }
}

/** What an Office file may hold before it is refused, and what to call it in the refusal. */
export type OfficeLimits = { kind: string; maxCharacters: number; byTextLimit: boolean };
const NO_OFFICE_LIMITS: OfficeLimits = { kind: "file", maxCharacters: MAX_OFFICE_CHARACTERS, byTextLimit: false };
/** The text and the paragraphs read from all the parts of one Office file so far. */
export type OfficeCount = { characters: number; paragraphs: number };

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
 * - In Word, the text of a hidden run (`<w:vanish/>` in the run's own properties) comes after the
 *   text of its paragraph that shows, each line marked with `HIDDEN_TEXT`. Text hidden by a style
 *   is not told apart. In PowerPoint, `hiddenSlide` says whether the slide show skips the slide.
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
  /** Word marks hidden runs; PowerPoint hides whole slides. */
  private readonly word: boolean;
  /** The one tag whose attributes are read: `w:vanish` in Word, the slide's `p:sld` in PowerPoint. */
  private readonly attributesTag: string;
  /** The attribute read of `attributesTag`, and the values that count. */
  private readonly attribute: WantedAttribute;
  /** The text of each paragraph, in the order the paragraphs start: null while it is open, "" when empty. */
  private readonly paragraphs: Array<string | null> = [];
  /**
   * The paragraphs that are open, the innermost last: where each goes in `paragraphs` (-1: into
   * the table cell that is open), its text so far (that which shows, and that which Word hides),
   * and its length. In Word, also how many runs are open (a ruby's runs are inside a run), how deep
   * the outermost hidden one is (0: none is hidden), how deep in run properties the reading is, and
   * its style and numbering.
   */
  private readonly open: Array<{ slot: number; pieces: string[]; hidden: string[] | undefined; length: number; runs: number; hiddenFrom: number; runProperties: number; style: ParagraphStyle | undefined }> = [];
  /**
   * The table being read, and how deep in tables (a table in a cell is read as text of that cell).
   * Its rows so far, the row and the cell open, and in Word: how many grid columns the cell open
   * spans, how many empty columns end the row open (`w:gridAfter`), and how deep in the properties
   * of the row or cell the reading is (those of a change they record are one level deeper).
   */
  private table: { slot: number; depth: number; rows: string[][]; row: string[] | undefined; cell: string[] | undefined; span: number; after: number; properties: number } | undefined;
  private readonly tableTag: string;
  private readonly rowTag: string;
  private readonly cellTag: string;
  /** Tags whose attributes are read (see `read`). */
  private readonly attributeTags: ReadonlySet<string>;
  /** Characters held in the paragraphs that are open, as written in the XML. */
  private pending = 0;
  private inText = false;
  private inProperties = 0;
  private inFallback = 0;
  /**
   * The tag being read, from its "<": its name so far, the quote of a value it is in, its last
   * character, and for `attributesTag` the reader of its attribute.
   */
  private tag: { name: string; named: boolean; quote: number; last: number; attributes: AttributeReader | undefined; raw: string | undefined } | undefined;
  /** A PowerPoint slide that the slide show skips (`<p:sld show="0">`). */
  hiddenSlide = false;
  /** Word's styles and lists, to write headings as `#` lines and each paragraph with its list number. */
  private readonly numbering: WordNumbering | undefined;
  /** On a notes page, the placeholders whose text is left out (`NOTES_PAGE_PLACEHOLDERS`). */
  private readonly leftOut: ReadonlySet<string> | undefined;
  /** In PowerPoint, whether a shape (`p:sp`) is open, and whether it is a placeholder left out. */
  private inShape = false;
  private inLeftOut = false;

  /** `count`: what the other parts of the same file held, shared with them. */
  constructor(prefix: "w" | "a", private readonly limits: OfficeLimits = NO_OFFICE_LIMITS, private readonly count: OfficeCount = { characters: 0, paragraphs: 0 }, options: PartOptions = {}) {
    this.numbering = options.numbering;
    this.leftOut = options.notesPage ? NOTES_PAGE_PLACEHOLDERS : undefined;
    this.paragraphTag = `${prefix}:p`;
    this.paragraphEnd = `/${prefix}:p`;
    this.textTag = `${prefix}:t`;
    this.textEnd = `/${prefix}:t`;
    this.propertiesTag = `${prefix}:pPr`;
    this.propertiesEnd = `/${prefix}:pPr`;
    this.tabTag = `${prefix}:tab`;
    this.breakTags = new Set([`${prefix}:br`, `${prefix}:cr`]);
    this.word = prefix === "w";
    this.attributesTag = this.word ? "w:vanish" : "p:sld";
    this.attribute = this.word ? VANISH_OFF : SLIDE_NOT_SHOWN;
    this.tableTag = `${prefix}:tbl`;
    this.rowTag = `${prefix}:tr`;
    this.cellTag = `${prefix}:tc`;
    this.attributeTags = this.word ? WORD_ATTRIBUTE_TAGS : DRAWING_ATTRIBUTE_TAGS;
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
        this.tag = { name: "", named: false, quote: 0, last: 0, attributes: undefined, raw: undefined };
        at = start + 1;
        continue;
      }
      for (; at < length; at++) {
        const code = xml.charCodeAt(at);
        if (tag.quote !== 0) {
          if (tag.raw !== undefined && tag.raw.length < MAX_RAW_TAG) tag.raw += xml[at];
          if (code === tag.quote) {
            tag.quote = 0;
            tag.attributes?.close();
          } else {
            tag.attributes?.inValue(code);
          }
          continue;
        }
        if (!tag.named) {
          // A name ends at white space, at ">", or at the "/" of "<w:br/>". "</w:p>" starts with one.
          if (code === 62 || code === 32 || code === 9 || code === 10 || code === 13 || (code === 47 && tag.name !== "")) {
            tag.named = true;
            if (tag.name === this.attributesTag) tag.attributes = new AttributeReader(this.attribute);
            if (this.attributeTags.has(tag.name)) tag.raw = "";
          } else {
            if (tag.name.length < MAX_TAG_NAME) tag.name += xml[at];
            continue;
          }
        }
        if (code === 62) break;
        if (tag.raw !== undefined && tag.raw.length < MAX_RAW_TAG) tag.raw += xml[at];
        if (code === 34 || code === 39) {
          tag.quote = code;
          tag.attributes?.open();
        } else {
          tag.attributes?.outside(code);
          if (code !== 32 && code !== 9 && code !== 10 && code !== 13) tag.last = code;
        }
      }
      if (at === length) return; // The tag goes on in the next piece.
      this.tag = undefined;
      this.read(tag.name, tag.last === 47, tag.attributes?.found ?? false, tag.raw);
      at++;
    }
  }

  /** The text of each paragraph that has some, in the order the paragraphs start. A table is one, of a line a row. */
  texts(): string[] {
    // A paragraph never closed keeps the text it has, as when the file ends inside it; so does a table.
    while (this.open.length > 0) this.close();
    while (this.table) this.closeTable();
    return this.paragraphs.filter((text): text is string => !!text);
  }

  /** Adds text to the innermost open paragraph. */
  private add(piece: string): void {
    const paragraph = this.open.at(-1);
    if (!paragraph || this.inLeftOut) return;
    this.pending += piece.length;
    paragraph.length += piece.length;
    // The decoded text is counted when its paragraph closes. Until then, what is held is bounded too.
    if (this.pending > this.limits.maxCharacters * MAX_ENTITY_GROWTH) throw this.tooMuchText();
    if (paragraph.hiddenFrom !== 0) (paragraph.hidden ??= []).push(piece);
    else paragraph.pieces.push(piece);
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
    let shown = decodeEntities(paragraph.pieces.join(""));
    if (this.numbering && paragraph.style) {
      // An empty paragraph is counted in its list too, as Word shows its number there. The number
      // is written only before text: empty paragraphs count toward no limit, and a file of them
      // would have its numbers written, at up to 64 characters each, only to be thrown away.
      const counted = this.numbering.count(paragraph.style);
      if (shown.trim()) {
        const label = counted && this.numbering.labelOf(counted);
        const level = paragraph.slot !== -1 ? this.numbering.headingLevel(paragraph.style) : undefined;
        shown = `${level ? `${"#".repeat(level)} ` : ""}${label ? `${label} ` : ""}${shown}`;
      }
    }
    const text = paragraph.hidden ? this.withHiddenText(shown, decodeEntities(paragraph.hidden.join(""))) : shown;
    if (paragraph.slot === -1) {
      // A paragraph of a table cell: its text goes into the cell, counted as any paragraph's.
      if (text.trim()) {
        this.count.characters += text.length;
        if (this.count.characters > this.limits.maxCharacters) throw this.tooMuchText();
        this.table?.cell?.push(text);
      }
      return;
    }
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

  /**
   * A paragraph's text that shows, then each line of its hidden text, marked with `HIDDEN_TEXT`. A
   * long hidden line is cut into pieces of `HIDDEN_PIECE` characters at most, each marked. The marks
   * make the text longer than the XML it came from, so it is refused as soon as it holds more than
   * the room left under the limit, not once it is built.
   */
  private withHiddenText(shown: string, hidden: string): string {
    const room = this.limits.maxCharacters - this.count.characters;
    const lines = shown.trim() ? [shown] : [];
    // The length of the lines joined with line breaks.
    let length = lines.length > 0 ? shown.length : -1;
    let marked = 0;
    // Where the line being marked ends, found once a line: each of its pieces starts before it, as
    // `NOT_SPACE` never stops at a line end. Searched again from each piece, it took seconds.
    let lineEnd = -1;
    // Line by line, without splitting the text first: a run can hold millions of empty lines.
    for (let at = 0; ;) {
      NOT_SPACE.lastIndex = at;
      const first = NOT_SPACE.exec(hidden);
      if (!first) break;
      const start = first.index;
      if (start >= lineEnd) {
        HIDDEN_LINE_END.lastIndex = start;
        lineEnd = HIDDEN_LINE_END.exec(hidden)?.index ?? hidden.length;
      }
      let end = lineEnd;
      if (end - start > HIDDEN_PIECE) {
        // Cut after a space near the end of the piece, and never between the two halves of an emoji.
        const window = sliceWhole(hidden.slice(start, lineEnd), HIDDEN_PIECE);
        const space = window.lastIndexOf(" ");
        end = start + (space > HIDDEN_PIECE * 0.8 ? space + 1 : window.length);
      }
      const line = `${HIDDEN_TEXT} ${hidden.slice(start, end)}`;
      length += 1 + line.length;
      if (length > room) throw this.tooMuchText();
      lines.push(line);
      marked++;
      at = end;
    }
    return marked === 0 ? shown : lines.join("\n");
  }

  /**
   * Acts on a tag that has been read. `empty` is a tag that closes itself, as `<w:br/>`.
   * `found`: whether the tag is `attributesTag`, and its attribute has one of the values wanted.
   */
  private read(name: string, empty: boolean, found: boolean, raw?: string): void {
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
        const inCell = this.table?.cell !== undefined;
        this.open.push({ slot: inCell ? -1 : this.paragraphs.length, pieces: [], hidden: undefined, length: 0, runs: 0, hiddenFrom: 0, runProperties: 0, style: undefined });
        if (!inCell) this.paragraphs.push(null);
      }
    } else if (name === this.tableTag || name === this.rowTag || name === this.cellTag || name === `/${this.tableTag}` || name === `/${this.rowTag}` || name === `/${this.cellTag}`) {
      this.readTable(name, empty);
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
      else if (this.word && name === "w:noBreakHyphen") this.add("-");
      else if (this.word && name === "w:sym") this.addSymbol(raw);
      else if (this.word && TABLE_PROPERTY_TAGS.has(name)) this.readTableProperty(name, empty, raw);
      else if (this.word) this.readRun(name, empty, found);
      else if (name === "p:sld" && found) this.hiddenSlide = true;
      else if (name === "p:sp" || name === "/p:sp") {
        this.inShape = name === "p:sp" && !empty;
        this.inLeftOut = false;
      } else if (name === "p:ph" && this.inShape && this.leftOut?.has(parseAttributes(raw ?? "").type ?? "")) {
        // The placeholder of the shape comes before its text (`p:nvSpPr`, then `p:txBody`).
        this.inLeftOut = true;
      }
    } else if (this.inProperties === 1 && this.word && raw !== undefined) {
      // The paragraph's own properties; those of a change it records (`w:pPrChange`) are one level deeper.
      this.readParagraphProperty(name, raw);
    }
  }

  /** `w:pStyle`, `w:numId`, `w:ilvl` and `w:outlineLvl` of the innermost open paragraph. */
  private readParagraphProperty(name: string, raw: string): void {
    const paragraph = this.open.at(-1);
    if (!paragraph) return;
    const value = parseAttributes(raw)["w:val"];
    if (value === undefined) return;
    const style = (paragraph.style ??= {});
    if (name === "w:pStyle") style.styleId = value;
    else if (name === "w:numId") style.numId = value;
    else if (name === "w:ilvl") style.ilvl = Number.parseInt(value, 10) || 0;
    else if (name === "w:outlineLvl") style.outlineLevel = Number.parseInt(value, 10);
  }

  /**
   * A symbol of a symbol font (`<w:sym w:char="F0B7"/>`). Those fonts put their characters in the
   * private-use area: one that stands for a printable ASCII character is written as it, others are
   * left out.
   */
  private addSymbol(raw: string | undefined): void {
    const code = Number.parseInt(parseAttributes(raw ?? "")["w:char"] ?? "", 16);
    if (!Number.isFinite(code)) return;
    const plain = code >= 0xf000 ? code - 0xf000 : code;
    if (plain >= 0x20 && plain <= 0x7e) this.add(String.fromCharCode(plain));
  }

  /**
   * The properties of the Word table row and cell that are open: `w:gridSpan` of a cell, and
   * `w:gridBefore` and `w:gridAfter` of a row, the grid columns that the row leaves empty before its
   * first cell and after its last. Those of a change the properties record (`w:tcPrChange`,
   * `w:trPrChange`) are the properties before the change, one level deeper, and are not read.
   */
  private readTableProperty(name: string, empty: boolean, raw: string | undefined): void {
    const table = this.table;
    if (!table || table.depth !== 1) return;
    if (name === "w:trPr" || name === "w:tcPr") {
      if (!empty) table.properties++;
      return;
    }
    if (name === "/w:trPr" || name === "/w:tcPr") {
      if (table.properties > 0) table.properties--;
      return;
    }
    if (table.properties > 1) return;
    const columns = Math.min(MAX_CELL_SPAN, Math.max(0, Number.parseInt(parseAttributes(raw ?? "")["w:val"] ?? "", 10) || 0));
    if (name === "w:gridSpan") {
      if (table.cell) table.span = Math.max(1, columns);
    } else if (name === "w:gridBefore") {
      // Once, before the row's first cell.
      if (table.row?.length === 0 && !table.cell) for (let index = 0; index < columns; index++) this.addCell(table.row, "");
    } else if (table.row && !table.cell) {
      table.after = columns;
    }
  }

  /**
   * The start and end of tables, rows and cells. A table becomes one paragraph, written when it
   * closes: a line for each row, as `| cell | cell |  |`, with its empty cells, as the PDF extractor
   * writes rows. A Word cell that spans grid columns is followed by an empty cell for each column
   * past the first, and a row that leaves grid columns empty before its first cell or after its
   * last has an empty cell for each, so that every row keeps its columns. A cell that continues a
   * merged cell (`w:vMerge` in Word; in PowerPoint, where the cells a merged cell covers are in the
   * XML already, `hMerge` and `vMerge`) is written in its column: Word and PowerPoint leave it
   * empty, and the text another program left in it is kept. A table inside a cell is read as text
   * of that cell.
   */
  private readTable(name: string, empty: boolean): void {
    if (name === this.tableTag) {
      if (empty) return;
      if (this.table) {
        this.table.depth++;
        return;
      }
      // Inside a paragraph of a cell of no table (a malformed file): the table is that paragraph's.
      this.table = { slot: this.paragraphs.length, depth: 1, rows: [], row: undefined, cell: undefined, span: 1, after: 0, properties: 0 };
      this.paragraphs.push(null);
      return;
    }
    const table = this.table;
    if (!table) return;
    if (name === `/${this.tableTag}`) {
      if (table.depth > 1) table.depth--;
      else this.closeTable();
      return;
    }
    if (table.depth !== 1) return;
    if (name === this.rowTag) {
      this.closeRow();
      table.row = empty ? undefined : [];
      table.properties = 0;
    } else if (name === `/${this.rowTag}`) {
      this.closeRow();
    } else if (name === this.cellTag) {
      this.closeCell();
      table.span = 1;
      table.properties = 0;
      table.cell = [];
      if (empty) this.closeCell();
    } else if (name === `/${this.cellTag}`) {
      this.closeCell();
    }
  }

  /**
   * Adds a cell to a row. Each cell is counted as a paragraph, empty or not, and its separator as
   * text: a table of millions of empty cells is bounded as a document of millions of paragraphs is.
   */
  private addCell(row: string[], text: string): void {
    if (++this.count.paragraphs > MAX_OFFICE_PARAGRAPHS) {
      throw new Error(`This ${this.limits.kind} has more than ${MAX_OFFICE_PARAGRAPHS.toLocaleString("en-US")} paragraphs and table cells, more than a document holds. It may be built to exhaust the server, so it is not read.`);
    }
    this.count.characters += 3;
    if (this.count.characters > this.limits.maxCharacters) throw this.tooMuchText();
    row.push(text);
  }

  /** Ends the table cell that is open, if any: its paragraphs become one cell of the row. */
  private closeCell(): void {
    const table = this.table;
    if (!table?.cell) return;
    // Paragraphs of the cell left open (a malformed file) give their text to it first.
    while (this.open.length > 0 && this.open.at(-1)!.slot === -1) this.close();
    const text = cellText(table.cell.join(" "));
    table.cell = undefined;
    const row = (table.row ??= []);
    const cells = this.word ? table.span : 1;
    for (let index = 0; index < cells; index++) this.addCell(row, index === 0 ? text : "");
  }

  /** Ends the table row that is open, if any, with an empty cell for each grid column it leaves empty after its last cell. */
  private closeRow(): void {
    const table = this.table;
    if (!table) return;
    this.closeCell();
    const row = table.row;
    if (row && row.length > 0) {
      for (let index = 0; index < table.after; index++) this.addCell(row, "");
      table.rows.push(row);
    }
    table.row = undefined;
    table.after = 0;
  }

  /** Ends the table: its rows become the text of its paragraph. Also when the file ends inside it. */
  private closeTable(): void {
    const table = this.table;
    if (!table) return;
    this.closeRow();
    this.table = undefined;
    if (table.rows.some((row) => row.some((cell) => cell !== ""))) {
      const text = table.rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
      this.paragraphs[table.slot] = text;
    } else if (table.slot === this.paragraphs.length - 1) {
      this.paragraphs.pop();
    } else {
      this.paragraphs[table.slot] = "";
    }
  }

  /**
   * Follows the runs of a Word paragraph, to tell the text of a hidden run: `<w:vanish/>` in the
   * run's own properties, not in those of a change it records (`w:rPrChange`), one level deeper.
   * A run inside a hidden run (the text of a ruby) is hidden too, and the run around it stays
   * hidden after it. `off`: the `w:vanish` turns hiding off.
   */
  private readRun(name: string, empty: boolean, off: boolean): void {
    const paragraph = this.open.at(-1);
    if (!paragraph) return;
    if (name === "w:r") {
      if (empty) return;
      paragraph.runs++;
      paragraph.runProperties = 0;
    } else if (name === "/w:r") {
      if (paragraph.runs > 0) {
        if (paragraph.hiddenFrom === paragraph.runs) paragraph.hiddenFrom = 0;
        paragraph.runs--;
      }
      paragraph.runProperties = 0;
    } else if (name === "w:rPr") {
      if (!empty && paragraph.runs > 0) paragraph.runProperties++;
    } else if (name === "/w:rPr") {
      if (paragraph.runProperties > 0) paragraph.runProperties--;
    } else if (name === "w:vanish" && paragraph.runProperties === 1) {
      if (!off) {
        if (paragraph.hiddenFrom === 0) paragraph.hiddenFrom = paragraph.runs;
      } else if (paragraph.hiddenFrom === paragraph.runs) {
        paragraph.hiddenFrom = 0;
      }
    }
  }
}

/**
 * Text of each paragraph of Office XML, in the order the paragraphs start. See `OfficeText`. The
 * XML may be given in pieces, as it is unpacked.
 */
export function officeXmlParagraphs(xml: string | string[], prefix: "w" | "a"): string[] {
  const text = new OfficeText(prefix);
  for (const piece of typeof xml === "string" ? [xml] : xml) text.write(piece);
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
export type ZipArchive = { files: Record<string, unknown>; file(name: string): ZipFile | null };

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

/** The kinds of zipped Office files read here, as refusals name them. */
export type OfficeKind = "DOCX" | "PPTX" | "XLSX";

/** What `officeReader` gives: ways to read the parts of one Office file, under one count of what is unpacked. */
export type OfficeParts = {
  /**
   * The paragraphs of a part of Word (`w`) or DrawingML (`a`) XML; none when the part is missing.
   * `options`: Word's numbering, for the document itself; or that the part is a notes page.
   */
  paragraphs(name: string, prefix: "w" | "a", options?: PartOptions): Promise<{ paragraphs: string[]; hiddenSlide: boolean }>;
  /**
   * A small part whole (styles, relationships, the list of slides or sheets), or undefined when it
   * is missing or larger than `maxCharacters`: it is then read no further, and the file is read
   * without it.
   */
  small(name: string, maxCharacters?: number): Promise<string | undefined>;
  /** Feeds a part to `write` a piece at a time as it is unpacked. False when the part is missing. */
  stream(name: string, write: (piece: string) => void): Promise<boolean>;
  /** The limits of the text kept, and the count shared by the parts, for a reader of a part's text. */
  readonly limits: OfficeLimits;
  readonly count: OfficeCount;
};

/** The most a small part (`OfficeParts.small`) may hold. Styles of a large document take about 1 MB. */
const MAX_SMALL_PART = 8 * 1024 * 1024;

/** Thrown inside `small` when a part is larger than it may be: the part is then left out. */
class PartTooLarge extends Error {}

/**
 * Reads the parts of one Office file, each a piece at a time as it is unpacked, counting what is
 * unpacked: a file that grows far past its size is refused as it grows, before that much is in
 * memory. The parsing is paused every few milliseconds, and other requests get a turn. The
 * unpacking is not: JSZip inflates and decodes a whole deflated block (up to about 16 MB of XML)
 * in one turn before any of it is handed out, and what it hands out once paused is held, and
 * written in the slices after the pause, which costs memory for that block. Reading a file in a
 * child process (`createIsolatedExtractors`) is what bounds both for files from users.
 */
export function officeReader(archive: ZipArchive, kind: OfficeKind, size: number, input: ExtractInput | undefined): OfficeParts {
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
  /** Feeds a part to `write`, then calls `done`; false when the part is missing. */
  const stream = (name: string, write: (piece: string) => void, done: () => void = () => undefined) => new Promise<boolean>((resolve, reject) => {
    const file = archive.file(name);
    if (!file) {
      resolve(false);
      return;
    }
    let stopped = false;
    let pausing = false;
    let ended = false;
    /**
     * The pieces that came while the stream was paused, and the next one to write. Pausing JSZip
     * does not stop the block it is unpacking: it hands out the rest of it, up to 16 MB of XML from
     * 16 KB of a deflated part, in the same turn. Those pieces wait for the next slice.
     */
    let waiting: string[] = [];
    let next = 0;
    const unzip = file.internalStream("string");
    const stop = (error: unknown) => {
      if (stopped) return;
      stopped = true;
      waiting = [];
      unzip.pause();
      reject(error);
    };
    const finish = () => {
      try {
        done();
        resolve(true);
      } catch (error) {
        stop(error);
      }
    };
    /** Pauses, then writes the pieces that came meanwhile, a slice at a time, and goes on with the stream. */
    const pauseThenGoOn = async () => {
      try {
        do {
          await slicer.pauseNow();
          while (!stopped && next < waiting.length && !slicer.due) write(waiting[next++]!);
          if (stopped) return;
        } while (next < waiting.length);
      } catch (error) {
        stop(error);
        return;
      }
      waiting = [];
      next = 0;
      pausing = false;
      if (ended) finish();
      else unzip.resume();
    };
    unzip
      .on("data", (chunk) => {
        if (stopped) return;
        if (input?.signal?.aborted) {
          stop(input.signal.reason);
          return;
        }
        // Counted as it comes, written or not: a file that grows past the limit is refused at once.
        unpacked += chunk.length;
        if (unpacked > limit) {
          stop(new Error(refusal));
          return;
        }
        if (pausing) {
          waiting.push(chunk);
          return;
        }
        try {
          write(chunk);
        } catch (error) {
          stop(error);
          return;
        }
        if (slicer.due) {
          pausing = true;
          unzip.pause();
          void pauseThenGoOn();
        }
      })
      .on("error", stop)
      .on("end", () => {
        ended = true;
        if (!stopped && !pausing) finish();
      })
      .resume();
  });
  return {
    limits,
    count,
    stream: (name, write) => stream(name, write),
    async paragraphs(name, prefix, options) {
      const text = new OfficeText(prefix, limits, count, options);
      let result = { paragraphs: [] as string[], hiddenSlide: false };
      await stream(name, (piece) => text.write(piece), () => {
        result = { paragraphs: text.texts(), hiddenSlide: text.hiddenSlide };
      });
      return result;
    },
    async small(name, maxCharacters = MAX_SMALL_PART) {
      const pieces: string[] = [];
      let length = 0;
      try {
        const found = await stream(name, (piece) => {
          length += piece.length;
          if (length > maxCharacters) throw new PartTooLarge();
          pieces.push(piece);
        });
        return found ? pieces.join("") : undefined;
      } catch (error) {
        if (error instanceof PartTooLarge) return undefined;
        throw error;
      }
    },
  };
}

/**
 * The parts an Office file may have, at most. A deck of 2,000 slides with notes and pictures has
 * about 12,000. JSZip reads the header of every part into memory before any part is unpacked:
 * about 2 KB each, and 300,000 empty parts took over 500 MB.
 */
const MAX_ZIP_ENTRIES = 20_000;
/**
 * The extra fields the parts of an Office file may have, together. Office writes none, other ZIP
 * programs one to three for each part. JSZip keeps about 250 bytes for each field of 4 bytes: a
 * file of 4 MB made only of them took 250 MB.
 */
const MAX_ZIP_EXTRA_FIELDS = 4 * MAX_ZIP_ENTRIES;
/**
 * The bytes JSZip may turn into text, or go through one by one, from the directory of an Office
 * file: names, comments, and the data of three kinds of extra field (see ZipDirectory). The Office
 * files we tried had at most 68 KB. A name can be decoded from the same bytes for many parts, and
 * the data of a field can run over the records after it, so the size of the file does not bound
 * them: 2,000 parts of a 0.17 MB file took JSZip over 256 MB. A file just under this limit and the
 * two above took JSZip under 0.5 s and 140 MB.
 */
const MAX_ZIP_TEXT_BYTES = 8 * 1024 * 1024;

export async function loadZip(bytes: Uint8Array, kind: OfficeKind): Promise<ZipArchive> {
  const JSZip = (await importPeer("jszip", () => import("jszip"), "Reading DOCX, PPTX and XLSX files needs the optional dependency \"jszip\".")).default as unknown as { loadAsync(data: Uint8Array): Promise<ZipArchive> };
  // The directory is read first, as JSZip will read it: the count of parts it gives may say
  // anything.
  const directory = readZipDirectory(bytes, { parts: MAX_ZIP_ENTRIES, extraFields: MAX_ZIP_EXTRA_FIELDS, textBytes: MAX_ZIP_TEXT_BYTES });
  if (directory?.endless) {
    throw new Error(`This ${kind} ends with a ZIP64 record that cannot be read, and reading it could hold the server without end. It may be built to exhaust the server, so it is not read.`);
  }
  if (directory && directory.parts > MAX_ZIP_ENTRIES) {
    throw new Error(`This ${kind} has more than ${MAX_ZIP_ENTRIES.toLocaleString("en-US")} parts, more than an Office document has. It may be built to exhaust the server, so it is not read.`);
  }
  // A mass of extra fields, or of names, comments and field data: no Office program writes either.
  if (directory && (directory.extraFields > MAX_ZIP_EXTRA_FIELDS || directory.textBytes > MAX_ZIP_TEXT_BYTES)) {
    throw new Error(`This ${kind} lists its parts in a way that no Office program does: reading the list would take far more memory or time than an Office document needs. It may be built to exhaust the server, so it is not read.`);
  }
  return JSZip.loadAsync(bytes);
}

/**
 * Opens an Office file, or refuses it in words for its user: an Office file of before 2007, or one
 * protected by a password, is not a ZIP archive but a compound file, and JSZip says only that it
 * found no ZIP in it.
 */
export async function openOffice(bytes: Uint8Array, kind: OfficeKind): Promise<ZipArchive> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) throw new Error(LEGACY_OFFICE);
  return loadZip(bytes, kind);
}

/** The parts of a DOCX read after the document itself, in this order, each under a heading of its own. */
const WORD_SECTIONS: Array<{ part: RegExp; title: string }> = [
  { part: /^word\/footnotes\.xml$/i, title: "Footnotes" },
  { part: /^word\/endnotes\.xml$/i, title: "Endnotes" },
  { part: /^word\/comments\.xml$/i, title: "Comments" },
  { part: /^word\/header\d+\.xml$/i, title: "Header" },
  { part: /^word\/footer\d+\.xml$/i, title: "Footer" },
];

/** A part's number, for an order that follows it: header2.xml before header10.xml. */
const partNumber = (name: string) => Number(/(\d+)\.xml$/i.exec(name)?.[1] ?? 0);

/**
 * Word files. The document's paragraphs come first: a heading as a Markdown heading ("## 2.1
 * Scope"), each paragraph with the list number Word shows before it, and each table as rows of
 * `| cell | cell |`, empty cells kept. Then the footnotes, endnotes, comments, headers and footers,
 * each under a heading of its own; a header or footer that repeats one already read is left out.
 */
export const docx: Extractor = async (bytes, input) => {
  input?.signal?.throwIfAborted();
  const archive = await openOffice(bytes, "DOCX");
  input?.signal?.throwIfAborted();
  if (!archive.file("word/document.xml")) throw new Error("This DOCX does not contain word/document.xml.");
  const parts = Object.keys(archive.files);
  const extra = WORD_SECTIONS.flatMap(({ part, title }) => parts.filter((name) => part.test(name)).sort((left, right) => partNumber(left) - partNumber(right)).map((name) => ({ name, title })));
  const read = officeReader(archive, "DOCX", bytes.byteLength, input);
  const numbering = new WordNumbering(await read.small("word/styles.xml"), await read.small("word/numbering.xml"));
  const total = 1 + extra.length;
  const sections = [(await read.paragraphs("word/document.xml", "w", { numbering })).paragraphs.join("\n")];
  input?.onProgress?.({ done: 1, total, unit: "parts" });
  const seen = new Set<string>();
  for (const [index, { name, title }] of extra.entries()) {
    const text = (await read.paragraphs(name, "w")).paragraphs.join("\n");
    input?.onProgress?.({ done: index + 2, total, unit: "parts" });
    if (!text.trim() || seen.has(text)) continue;
    seen.add(text);
    sections.push(`# ${title}\n${text}`);
  }
  return { text: sections.filter(Boolean).join("\n\n") };
};

/** Speaker notes of a slide are written after this line. */
export const SPEAKER_NOTES = "[Speaker notes]";

/**
 * The slide parts of a deck, in the order of the slide show: the list in `ppt/presentation.xml`,
 * through its relationships. A deck reordered by a tool that does not rename the parts has them in
 * another order than their names. Without that list, the parts in the order of their numbers.
 */
async function slideOrder(read: OfficeParts, parts: string[]): Promise<string[]> {
  const byName = parts.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((left, right) => partNumber(left) - partNumber(right));
  const [presentation, relationshipsXml] = [await read.small("ppt/presentation.xml"), await read.small("ppt/_rels/presentation.xml.rels")];
  if (!presentation || !relationshipsXml) return byName;
  const relationships = readRelationships(relationshipsXml, "ppt");
  const ordered: string[] = [];
  const listed = new Set<string>();
  const existing = new Set(parts);
  let inList = false;
  readXml(presentation, {
    open(name, attributes) {
      if (name === "p:sldIdLst") inList = true;
      else if (inList && name === "p:sldId") {
        const target = relationships.get(attributes["r:id"] ?? "")?.target;
        if (target && existing.has(target) && !listed.has(target)) {
          listed.add(target);
          ordered.push(target);
        }
      }
    },
    close(name) {
      if (name === "p:sldIdLst") inList = false;
    },
  });
  return ordered.length > 0 ? ordered : byName;
}

/** The notes part of a slide, from the slide's relationships, or undefined. */
async function notesOf(read: OfficeParts, slide: string): Promise<string | undefined> {
  const folder = slide.slice(0, slide.lastIndexOf("/"));
  const file = slide.slice(slide.lastIndexOf("/") + 1);
  const relationships = readRelationships(await read.small(`${folder}/_rels/${file}.rels`), folder);
  for (const { target, type, external } of relationships.values()) if (!external && type.endsWith("/notesSlide")) return target;
  return undefined;
}

/**
 * PowerPoint files: a "## Slide N" section for each slide, numbered in the order of the slide show,
 * with its text, its tables as rows of `| cell | cell |`, and its speaker notes after
 * `SPEAKER_NOTES`. A slide the slide show skips says so in its heading.
 */
export const pptx: Extractor = async (bytes, input) => {
  input?.signal?.throwIfAborted();
  const archive = await openOffice(bytes, "PPTX");
  input?.signal?.throwIfAborted();
  const read = officeReader(archive, "PPTX", bytes.byteLength, input);
  const names = await slideOrder(read, Object.keys(archive.files));
  if (names.length === 0) throw new Error("This PPTX does not contain any slides.");
  const slides: string[] = [];
  for (const [index, name] of names.entries()) {
    const { paragraphs, hiddenSlide } = await read.paragraphs(name, "a");
    const notesPart = await notesOf(read, name);
    // The notes page holds the slide's number, and may hold the date, a header and a footer, as
    // text of placeholders of their own: those are left out, and a note that is only a number is kept.
    const notes = notesPart ? (await read.paragraphs(notesPart, "a", { notesPage: true })).paragraphs : [];
    const text = paragraphs.join("\n");
    // A hidden slide keeps its text, and says that the slide show skips it.
    slides.push(`## Slide ${index + 1}${hiddenSlide ? ` ${HIDDEN_SLIDE}` : ""}\n${text || "[No text on this slide]"}${notes.length > 0 ? `\n${SPEAKER_NOTES}\n${notes.join("\n")}` : ""}`);
    input?.onProgress?.({ done: index + 1, total: names.length, unit: "parts" });
  }
  return { text: slides.join("\n\n"), pages: names.length };
};

