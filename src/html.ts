import { decodeSteps } from "./decode.js";
import { HIDDEN_TEXT } from "./office.js";
import { TimeSlicer } from "./pause.js";
import { formatBytes } from "./plan.js";
import { MAX_LINE_CHARACTERS, sliceWhole } from "./text.js";
import type { Extractor } from "./types.js";

/**
 * HTML pages, as text a model can search and cite: the text a browser shows, without scripts,
 * styles and markup. Headings become Markdown headings, list items "- item" (or "1. item"), each
 * table row `| cell | cell |` with its empty cells (a merged cell is followed by an empty cell for
 * each other column it covers), a link "text (https://…)", and a picture its alt text. Entities are
 * decoded: "AT&amp;T" is found as "AT&T". Saved pages in an older encoding are read as text files
 * are.
 *
 * Text that the page hides (an element with the `hidden` attribute, or an inline style of
 * `display: none` or `visibility: hidden`) is kept, as Word's hidden text is: it comes after the
 * text of its line that shows, and each of its lines starts with `HIDDEN_TEXT`. A style sheet, or a
 * class it names, is not read: text it hides is read as text that shows.
 *
 * The page is read a piece of text at a time, with pauses for other requests. White space is made
 * one space in each piece as it comes, and the lines are written into blocks as they end, so that
 * no step works on a whole line or the whole text in one call; and a page whose text grows past
 * `maxTextBytes` is refused as soon as it does.
 */

/** Elements whose content is not text a person reads: left out with all they hold. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "select"]);
/** Elements read as raw text up to their end tag, whatever "<" they hold. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "plaintext"]);
/** Elements that start and end a line of their own. */
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html",
  "legend", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
/** Elements without content or end tag: a hidden one hides only itself. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements that hold list items. */
const LISTS = new Set(["ul", "ol", "menu", "dir"]);
const HEADING = /^h[1-6]$/;
/** The parts of a table by how deep in it they are: a row group, a row, a cell. */
const TABLE_PARTS = new Map([["caption", 1], ["colgroup", 1], ["thead", 1], ["tbody", 1], ["tfoot", 1], ["tr", 2], ["td", 3], ["th", 3]]);
/** List items are indented by their depth, up to this many levels. */
const MAX_INDENT = 6;
/** Ordered lists nested deeper than this count their items with the list this deep. */
const MAX_LISTS = 64;
/** A tag is read up to this many characters; past it, it ends at its first ">". */
const MAX_TAG = 64 * 1024;
/** Text is read in pieces of this many characters at most, with a look at the clock between them. */
const TEXT_PIECE = 64 * 1024;
/** A character reference is at most 34 characters long (`&` and a name of 32, and `;`): a piece of text never ends this close after an `&`. */
const MAX_REFERENCE = 40;
/** The lines written are joined into blocks of about this many characters, or of this many pieces. */
const BLOCK = 64 * 1024;
const BLOCK_PARTS = 1024;
/** A page's title is kept up to this many characters. */
const MAX_TITLE = 1_000;
/** The title is looked for in this many characters at the start of the page's text. */
const TITLE_SEARCH = 64 * 1024;
/** A link's address is written after its text up to this length; a longer one is left out. */
const MAX_ADDRESS = 2_048;
/** A link's text is compared with its address up to this many characters: a longer text is not its address. */
const MAX_LINK_TEXT = 8 * 1024;
/** A picture's alt text is kept up to this many characters. */
const MAX_ALT = 1_000;
/** Rows one table cell may span, as browsers read `rowspan`. */
const MAX_ROWSPAN = 65_534;
/**
 * The columns covered by merged cells are written as empty cells in the first 64 columns of a table
 * only: a page of short cells that each span thousands of columns, or rows below thousands of cells
 * that each span all of them, must not grow its text a thousand times.
 */
const MAX_SPANNED_COLUMNS = 64;
/**
 * A line of hidden text longer than this is cut into pieces, each marked. A mark and its piece then
 * fit on one line, which ingest does not cut: past `MAX_LINE_CHARACTERS` it would put the rest of
 * the hidden line on a line of its own, without the mark.
 */
// A tenth is kept free: ingest composes the text (NFC) and bounds runs of marks after it is cut,
// which can lengthen a line, and a line past the wrap limit would leave its rest without a mark.
const HIDDEN_PIECE = Math.floor((MAX_LINE_CHARACTERS - HIDDEN_TEXT.length - 1) * 0.9);
const HIDDEN_MARK = `${HIDDEN_TEXT} `;
/**
 * Runs of white space, made one space as a browser shows them (a no-break space is one too). A
 * single space is not matched: prose is then left as it is, five times faster than with `/\s+/g`.
 */
const SPACES = /\s{2,}|[^\S ]/g;
/** The same in hidden text, and U+0085 too: ingest may read it as a line break, and the text after it would lose its mark. */
const HIDDEN_SPACES = /[\s\x85]{2,}|[^\S ]|\x85/g;
/** A line break in preformatted text: a browser reads a carriage return as one too. */
const LINE_BREAK = /\r\n?|\n/;

/** The named entities pages use most; any other is left as it is written. Numeric ones are all decoded. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  shy: "­", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏",
  ndash: "–", mdash: "—", minus: "−", hellip: "…", bull: "•", middot: "·", prime: "′", Prime: "″",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾",
  sup1: "¹", sup2: "²", sup3: "³", micro: "µ", para: "¶", sect: "§", dagger: "†", Dagger: "‡", permil: "‰",
  euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤", shekel: "₪",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒", lArr: "⇐", hArr: "⇔",
  le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", sum: "∑", radic: "√", check: "✓",
  iexcl: "¡", iquest: "¿", ordf: "ª", ordm: "º", not: "¬", macr: "¯", acute: "´", cedil: "¸", uml: "¨",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù",
  uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", szlig: "ß", eth: "ð", thorn: "þ",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù",
  Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", ETH: "Ð", THORN: "Þ", oelig: "œ", OElig: "Œ", scaron: "š", Scaron: "Š",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", sigma: "σ", omega: "ω", mu: "μ", lambda: "λ", Delta: "Δ", Omega: "Ω",
};

/** Decodes the character references of HTML text: numeric ones, and the named ones of `ENTITIES`. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      // HTML reads 0x80-0x9F as windows-1252 by mistake; and a surrogate or 0 is a replacement character.
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    // Only a name of the table, not one an object has from its prototype ("&constructor;").
    // "AT&T" and "?a=1&b=2" stay as they are.
    return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity]! : match;
  });
}

/**
 * The text of a line, or of a table cell, as it is read: in pieces, each with its runs of white
 * space made one space as it comes, and none at the start. A line of megabytes is never searched or
 * copied whole. Its pieces are joined into blocks as they come, as the lines of `Output` are, so
 * that a line of millions of short pieces (a word between each two tags) is written in a few steps.
 */
class Run {
  /** The blocks the pieces were joined into, the pieces since, and their length. */
  private readonly blocks: string[] = [];
  private parts: string[] = [];
  private size = 0;
  length = 0;
  /** Whether the text so far is empty or ends with a space: a space after it is left out. */
  private spaced = true;

  /** `cell`: its pipes are escaped, as the PDF extractor writes cells. `hidden`: text the page hides. */
  constructor(private readonly cell = false, private readonly hidden = false) {}

  /** The text, in pieces. */
  get pieces(): string[] {
    return this.blocks.length === 0 ? this.parts : [...this.blocks, ...this.parts];
  }

  /**
   * Adds text, and returns how many characters it added. `preformatted`: its white space is kept,
   * except in hidden text, which is marked line by line.
   */
  add(text: string, preformatted = false): number {
    let piece = text;
    if (!preformatted || this.hidden) {
      piece = piece.replace(this.hidden ? HIDDEN_SPACES : SPACES, " ");
      if (this.spaced && piece.charCodeAt(0) === 32) piece = piece.slice(1);
    }
    if (piece === "") return 0;
    if (this.cell && piece.includes("|")) piece = piece.replace(/\|/g, "\\|");
    this.spaced = piece.charCodeAt(piece.length - 1) === 32;
    this.parts.push(piece);
    this.size += piece.length;
    this.length += piece.length;
    if (this.size >= BLOCK || this.parts.length >= BLOCK_PARTS) {
      this.blocks.push(this.parts.join(""));
      this.parts = [];
      this.size = 0;
    }
    return piece.length;
  }

  /** The last `length` characters of the text (a link's, to compare with its address). */
  tail(length: number): string {
    const taken: string[] = [];
    let size = 0;
    for (const list of [this.parts, this.blocks]) {
      for (let index = list.length - 1; index >= 0 && size < length; index--) {
        taken.push(list[index]!);
        size += list[index]!.length;
      }
    }
    const text = taken.reverse().join("");
    return text.slice(text.length - Math.min(length, text.length));
  }

  /**
   * Drops the white space at its end, and returns how many characters it dropped. Only the last
   * pieces are looked at: `/\s+$/` on a line was tried at each space of a run, and took the square
   * of its length (28 seconds for a run of 120,000 spaces in a `<pre>`).
   */
  trimEnd(): number {
    const before = this.length;
    for (;;) {
      const list = this.parts.length > 0 ? this.parts : this.blocks;
      const last = list.at(-1);
      if (last === undefined) break;
      const trimmed = last.trimEnd();
      this.length -= last.length - trimmed.length;
      if (trimmed !== "") {
        list[list.length - 1] = trimmed;
        break;
      }
      list.pop();
    }
    return before - this.length;
  }
}

/**
 * The text written so far. The lines are joined into blocks of about `BLOCK` characters as they
 * come, so that a page of millions of short lines is held in a few long strings, and the text is
 * joined once, at the end. It starts at its first character that is not white space, and a blank
 * line is written only before another line.
 */
class Output {
  private readonly blocks: string[] = [];
  private parts: string[] = [];
  private size = 0;
  /** Characters written, with the line breaks between the lines. */
  characters = 0;
  private lines = 0;
  /** A blank line is due before the next line (two `<br>` in a row). */
  private blank = false;

  /** Writes a line: `prefix`, then `parts`, `length` characters in all. */
  line(prefix: string, parts: Iterable<string>, length: number): void {
    let size = length;
    // The first line (a list nested in nothing, or a block of code) starts at its first character.
    let starting = this.lines === 0;
    if (!starting) {
      const breaks = this.blank ? "\n\n" : "\n";
      this.blank = false;
      this.push(breaks);
      size += breaks.length;
    }
    const put = (part: string) => {
      if (!starting) {
        this.push(part);
        return;
      }
      const trimmed = part.trimStart();
      size -= part.length - trimmed.length;
      if (trimmed === "") return;
      starting = false;
      this.push(trimmed);
    };
    put(prefix);
    for (const part of parts) put(part);
    // A first line of nothing but white space is not written.
    if (starting) return;
    this.characters += size;
    this.lines++;
  }

  /** A blank line before the next line, unless no line was written yet. */
  blankLine(): void {
    if (this.lines > 0) this.blank = true;
  }

  /** The text written, joined. */
  text(): string {
    if (this.parts.length > 0) this.blocks.push(this.parts.join(""));
    this.parts = [];
    this.size = 0;
    return this.blocks.length === 1 ? this.blocks[0]! : this.blocks.join("");
  }

  private push(part: string): void {
    if (part === "") return;
    this.parts.push(part);
    this.size += part.length;
    if (this.size >= BLOCK || this.parts.length >= BLOCK_PARTS) {
      this.blocks.push(this.parts.join(""));
      this.parts = [];
      this.size = 0;
    }
  }
}

/** The line being built: its prefix (a heading's "#", a list item's "- "), its text that shows, and that the page hides. */
type Line = { prefix: string; shown: Run; hidden: Run | undefined };
const newLine = (prefix = ""): Line => ({ prefix, shown: new Run(), hidden: undefined });

/**
 * The cell of a table row being read: its text (pipes escaped), and the columns and rows it spans.
 * `dropped`: the page hides the cell itself, which then takes no column, as in a browser.
 */
type Cell = { shown: Run; dropped: boolean; colspan: number; rowspan: number };

/**
 * A table row being read. Each cell is added to the row's line as it ends: `parts` not yet joined
 * (`size` characters), and the blocks they were joined into, so that a row of millions of cells is
 * held in a few strings and written without a step over all of them. `columns`: the cells added (a
 * merged cell adds one for each column it covers); `text`: whether one of them has text (a row of
 * empty cells is not written). `hidden`: the page hides the whole row, which is written marked.
 * `hiddenText`: the text its cells hide, written after it. `held`: the characters it holds.
 * `covered`: the columns that cells of rows above cover in it.
 */
type Row = {
  parts: string[];
  size: number;
  blocks: string[];
  columns: number;
  text: boolean;
  cell: Cell | undefined;
  hidden: boolean;
  hiddenText: Run | undefined;
  held: number;
  covered: boolean[];
};

/**
 * The outermost element open that the page hides: its name, how many elements of that name are open
 * inside it and it, and how many lists and tables were opened inside it (to tell the end of its list
 * or table from the end of one inside it). `keepsPlace`: hidden by `visibility`, it still takes its
 * place, as a cell keeps its column. `listed` and `celled`: it is inside a list item or a table cell
 * and is not itself a list, item, table or part of one, so that the next item, the next cell or the
 * end of the table ends it, as a browser closes it there.
 */
type Hidden = { name: string; depth: number; lists: number; tables: number; keepsPlace: boolean; listed: boolean; celled: boolean; outer: number };

/** Elements open around the one being read, at most: past it, end tags are matched no further. */
const MAX_OPEN = 512;
/** Elements a browser closes and opens again around what follows them, not ends at an end tag around them. */
const FORMATTING = new Set(["a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u"]);

/**
 * Builds the text of a page as its tags and text go past. A table row is collected cell by cell
 * and written as one line when it ends; a table inside a cell is read as text of that cell.
 */
class HtmlText {
  private readonly out = new Output();
  private line: Line = newLine();
  /**
   * How deep inside skipped elements, `pre` elements, and lists, with the count of each ordered
   * list of the first `MAX_LISTS`: a page of lists nested millions deep must not hold one each.
   */
  private skipping = 0;
  private preformatted = 0;
  private listDepth = 0;
  private readonly lists: Array<{ ordered: boolean; count: number }> = [];
  private heading = 0;
  /** The table row being read, and how deep in tables (a table inside a cell is text of that cell). */
  private row: Row | undefined;
  private tableDepth = 0;
  /** For each of the first `MAX_SPANNED_COLUMNS` columns of the table: how many rows after this one a cell above still covers. */
  private spans: number[] = [];
  /** The link open, to write its address after its text: the text its text went to, and that text's length before it. */
  private link: { href: string; run: Run; length: number } | undefined;
  private hidden: Hidden | undefined;
  /**
   * The names of the elements open, outermost first, up to `MAX_OPEN`: a hidden element ends at the
   * end tag of an element that was open around it (`<p>a <span hidden>b</p>`), as a browser ends it.
   * Elements a page leaves open (a `<p>` with no end tag) stay in it; they only make such an end
   * less likely to be seen, never wrongly seen.
   */
  private readonly opened: string[] = [];

  /** `maxCharacters`: the page is refused as soon as its text grows past it. */
  constructor(private readonly maxCharacters = Number.POSITIVE_INFINITY) {}

  /** Whether the reading is inside an element whose content is left out. */
  get skipped(): boolean {
    return this.skipping > 0;
  }

  open(name: string, attributes: string): void {
    if (SKIPPED.has(name)) {
      this.skipping++;
      return;
    }
    if (this.skipping > 0) return;
    if (this.hidden && this.endedByStart(this.hidden, name)) this.hidden = undefined;
    const hiddenBefore = this.hidden !== undefined;
    // Not inside a hidden element, which hides it already; not `<html>` or `<body>`: a page hidden
    // whole until a script shows it is meant to be read.
    const hides = this.hidden || name === "html" || name === "body" ? undefined : hiding(attributes);
    if (hides && VOID.has(name)) return;
    if (this.hidden) {
      this.hiddenOpens(this.hidden, name);
    } else if (hides) {
      const listed = this.listDepth > 0 && !LISTS.has(name) && name !== "li" && name !== "dl" && name !== "dt" && name !== "dd";
      const celled = this.row?.cell !== undefined && !TABLE_PARTS.has(name) && name !== "table";
      this.hidden = { name, depth: 1, lists: 0, tables: 0, keepsPlace: hides === "invisible", listed, celled, outer: this.opened.length };
    }
    if (!VOID.has(name) && this.opened.length < MAX_OPEN) this.opened.push(name);
    if (name === "table") {
      this.tableDepth++;
      if (this.tableDepth === 1) {
        this.flush();
        // The rows are lines of their own: a list item's mark is not written before them.
        if (this.heading === 0) this.line.prefix = "";
        this.spans = [];
      } else if (this.row?.cell) {
        this.space();
      }
      return;
    }
    if (this.tableDepth === 1 && (name === "thead" || name === "tbody" || name === "tfoot")) {
      // A row group ends the row before it, and the rows that cells above span: they span their group only.
      this.endRow();
      this.spans = [];
      return;
    }
    if (this.tableDepth === 1 && (name === "tr" || name === "td" || name === "th")) {
      if (name === "tr") {
        this.endRow();
        this.row = this.startRow(this.hidden !== undefined);
      } else {
        this.row ??= this.startRow(hiddenBefore);
        this.startCell(attributes);
      }
      return;
    }
    if (this.row?.cell) {
      // Inside a cell: line breaks and blocks (paragraphs, list items, the cells of a table inside
      // it) become spaces, as the cell is one cell of one row.
      if (name === "br" || BLOCKS.has(name)) this.space();
      else if (name === "img") this.image(attributes);
      else if (name === "a") this.startLink(attributes);
      return;
    }
    if (name === "br") {
      // In hidden text a line break is a space: the hidden text is written after its line, which it does not end.
      if (this.hidden) this.space();
      else this.flush(true);
      return;
    }
    if (name === "img") {
      this.image(attributes);
      return;
    }
    if (name === "a") {
      this.startLink(attributes);
      return;
    }
    if (name === "pre") this.preformatted++;
    if (LISTS.has(name)) {
      this.flush();
      if (++this.listDepth <= MAX_LISTS) {
        this.lists.push({ ordered: name === "ol", count: Number.parseInt(attributeOf(attributes, "start", 16) ?? "1", 10) - 1 || 0 });
      }
      return;
    }
    if (BLOCKS.has(name)) this.flush();
    // Hidden text is written after its own mark: it gets no heading's or list item's.
    if (this.hidden) return;
    const level = /^h([1-6])$/.exec(name);
    if (level) {
      this.heading = Number(level[1]);
      this.line.prefix = `${"#".repeat(this.heading)} `;
    } else if (name === "li") {
      const list = this.lists.at(-1);
      // Indented up to a few levels: a page of lists nested thousands deep must not grow its text by the square.
      const indent = "  ".repeat(Math.min(MAX_INDENT, Math.max(0, this.listDepth - 1)));
      if (list?.ordered) this.line.prefix = `${indent}${++list.count}. `;
      else this.line.prefix = `${indent}- `;
    } else if (name === "hr") {
      this.write("---", [], 3);
      this.line.prefix = "";
    } else if (name === "blockquote") {
      this.line.prefix = "> ";
    }
  }

  close(name: string): void {
    if (SKIPPED.has(name)) {
      if (this.skipping > 0) this.skipping--;
      return;
    }
    if (this.skipping > 0) return;
    // The innermost open element of this name is closed, and those inside it.
    const index = this.opened.lastIndexOf(name);
    this.end(name);
    if (this.hidden && (this.endedByEnd(this.hidden, name) || (index !== -1 && index < this.hidden.outer && !FORMATTING.has(name)))) this.hidden = undefined;
    if (index !== -1) this.opened.length = index;
  }

  text(raw: string): void {
    if (this.skipping > 0 || raw === "") return;
    const text = decodeHtmlEntities(raw);
    if (!this.row?.cell) {
      // Text between the cells of a table (white space, or a caption's text outside a cell).
      if (this.tableDepth > 0 && !text.trim()) return;
      if (this.preformatted > 0) {
        const lines = text.split(LINE_BREAK);
        for (let index = 0; index < lines.length; index++) {
          if (index > 0) this.flush(true);
          this.add(lines[index]!, true);
        }
        return;
      }
    }
    this.add(text);
  }

  result(): string {
    this.endRow();
    this.flush();
    return this.out.text();
  }

  private end(name: string): void {
    if (name === "table") {
      if (this.tableDepth === 1) {
        this.endRow();
        this.spans = [];
      } else if (this.row?.cell) {
        this.space();
      }
      if (this.tableDepth > 0) this.tableDepth--;
      return;
    }
    if (this.tableDepth === 1 && (name === "thead" || name === "tbody" || name === "tfoot")) {
      this.endRow();
      this.spans = [];
      return;
    }
    if (name === "a") {
      this.endLink();
      return;
    }
    if (this.tableDepth === 1 && this.row) {
      if (name === "tr") this.endRow();
      else if (name === "td" || name === "th") this.endCell();
      else if (this.row.cell && BLOCKS.has(name)) this.space();
      return;
    }
    if (this.row?.cell) {
      // The end of a block inside a cell, or of a row or cell of a table inside it.
      if (BLOCKS.has(name)) this.space();
      return;
    }
    if (name === "pre" && this.preformatted > 0) {
      // The last line of the block keeps its spaces: it ends while the block is still open.
      this.flush();
      this.preformatted--;
      return;
    }
    if (LISTS.has(name)) {
      this.flush();
      if (this.listDepth > 0 && this.listDepth-- <= MAX_LISTS) this.lists.pop();
      // The mark of a last item left with no text (an icon, a picture without words) is not given to what follows the list.
      if (this.heading === 0) this.line.prefix = "";
      return;
    }
    if (HEADING.test(name)) this.heading = 0;
    if (BLOCKS.has(name)) this.flush();
    // A list item, quote or heading that ends before any text of its own: its mark is not given to the text after it.
    if (name === "li" || name === "blockquote" || HEADING.test(name)) this.line.prefix = "";
  }

  /** Adds text where it goes now (see `target`). */
  private add(text: string, preformatted = false): void {
    const row = this.row;
    if (row?.cell) row.held += this.target().add(text);
    else this.target().add(text, preformatted);
    this.check();
  }

  /**
   * Where text goes now: to the cell open or to the line, with the text that shows or with the text
   * that the page hides. In a row that the page hides whole, the row is marked: its cells are read
   * as cells. The text a cell hides is the row's, written after it.
   */
  private target(): Run {
    const row = this.row;
    if (row?.cell) return this.hidden && !row.hidden ? (row.hiddenText ??= new Run(false, true)) : row.cell.shown;
    return this.hidden ? (this.line.hidden ??= new Run(false, true)) : this.line.shown;
  }

  private space(): void {
    this.add(" ");
  }

  /** Refuses the page as soon as the text written, with what the line and the row not yet written hold, passes the limit. */
  private check(): void {
    const held = this.line.shown.length + (this.line.hidden?.length ?? 0) + (this.row?.held ?? 0);
    if (this.out.characters + held > this.maxCharacters) throw tooMuchText(this.maxCharacters);
  }

  private write(prefix: string, parts: Iterable<string>, length: number): void {
    this.out.line(prefix, parts, length);
    this.check();
  }

  /**
   * Writes text the page hides, after the text that shows: each of its lines starts with
   * `HIDDEN_TEXT`, as the hidden text of a Word document does. A line longer than `HIDDEN_PIECE` is
   * cut into pieces, after a space near the end of each where there is one and never between the
   * two halves of an emoji, and each piece is marked.
   */
  private writeHidden(pieces: Iterable<string>): void {
    let rest = "";
    for (const written of pieces) {
      // A U+0085 ends a line in a text with no other line break: ingest would split the text from its mark there.
      const piece = written.includes("\x85") ? written.replace(/\x85/g, " ") : written;
      rest = rest === "" ? piece.trimStart() : rest + piece;
      while (rest.length > HIDDEN_PIECE) {
        const window = sliceWhole(rest, HIDDEN_PIECE);
        const space = window.lastIndexOf(" ");
        const end = space > HIDDEN_PIECE * 0.8 ? space + 1 : window.length;
        this.write(HIDDEN_MARK, [rest.slice(0, end)], HIDDEN_MARK.length + end);
        rest = rest.slice(end).trimStart();
      }
    }
    rest = rest.trimEnd();
    if (rest !== "") this.write(HIDDEN_MARK, [rest], HIDDEN_MARK.length + rest.length);
  }

  private image(attributes: string): void {
    // Up to `MAX_ALT` characters, read from the start of the text only: an attribute can be megabytes long.
    const alt = sliceWhole(decodeSpaces(attributeOf(attributes, "alt", MAX_ALT * 4) ?? "").trim(), MAX_ALT).trim();
    if (alt) this.text(` [Image: ${alt}] `);
  }

  private startLink(attributes: string): void {
    // An address too long to follow is not decoded at all.
    const written = attributeOf(attributes, "href", MAX_ADDRESS * 2 + 1) ?? "";
    if (written.length > MAX_ADDRESS * 2) return;
    // A browser leaves out the tabs and line breaks of an address.
    const href = written.replace(/[\t\n\r]/g, "").trim();
    // Only addresses a person can follow outside the page: not "#top", not "javascript:".
    if (/^(https?:|mailto:)/i.test(href) && href.length <= MAX_ADDRESS) {
      const run = this.target();
      this.link = { href, run, length: run.length };
    }
  }

  private endLink(): void {
    const link = this.link;
    this.link = undefined;
    if (!link) return;
    const run = this.target();
    // The link's text; or, when its line or cell ended inside it, the text since.
    const length = run.length - (run === link.run ? link.length : 0);
    if (length === 0) return;
    const address = link.href.replace(/^mailto:/i, "");
    if (length <= MAX_LINK_TEXT) {
      const shown = run.tail(length);
      // A link whose text is its address says it once.
      if (!shown.trim() || shown.includes(address)) return;
    }
    this.add(` (${link.href.startsWith("mailto:") ? address : link.href})`);
  }

  /** Starts a row of the table. `hidden`: the page hides the whole row, which is written marked. */
  private startRow(hidden: boolean): Row {
    // The columns that cells above cover in this row; after it, each covers one row fewer.
    // Most tables span no rows: then nothing is worked out for each row.
    const spanning = this.spans.some((rows) => rows > 0);
    const covered = spanning ? this.spans.map((rows) => rows > 0) : [];
    if (spanning) this.spans = this.spans.map((rows) => Math.max(0, rows - 1));
    return { parts: [], size: 0, blocks: [], columns: 0, text: false, cell: undefined, hidden, hiddenText: undefined, held: 0, covered };
  }

  private startCell(attributes: string): void {
    const row = this.row!;
    this.endCell();
    // A cell hidden by `visibility` keeps its column, empty; one hidden otherwise takes none.
    const dropped = this.hidden !== undefined && !row.hidden && !this.hidden.keepsPlace;
    let colspan = 1;
    let rowspan = 1;
    if (!dropped) {
      // The columns that cells above cover come first, empty, so that this cell is under its heading.
      while (row.columns < row.covered.length && row.covered[row.columns]) this.addCell(row, undefined);
      if (/span/i.test(attributes)) {
        colspan = Math.min(MAX_SPANNED_COLUMNS, Math.max(1, Number.parseInt(attributeOf(attributes, "colspan", 16) ?? "1", 10) || 1));
        const rows = Number.parseInt(attributeOf(attributes, "rowspan", 16) ?? "1", 10);
        // `rowspan="0"` spans the rest of the rows of its group.
        rowspan = rows === 0 ? MAX_ROWSPAN : Math.min(MAX_ROWSPAN, Math.max(1, rows || 1));
      }
    }
    row.cell = { shown: new Run(true), dropped, colspan, rowspan };
  }

  private endCell(): void {
    const row = this.row;
    const cell = row?.cell;
    if (!row || !cell) return;
    row.cell = undefined;
    // The hidden text of one cell is a word apart from that of the next.
    row.held += row.hiddenText?.add(" ") ?? 0;
    if (cell.dropped) {
      // Text after the end of what hid the cell, in the cell: hidden with it.
      if (cell.shown.length > 0) for (const piece of cell.shown.pieces) (row.hiddenText ??= new Run(false, true)).add(piece);
      return;
    }
    row.held -= cell.shown.trimEnd();
    const column = row.columns;
    this.addCell(row, cell.shown.length > 0 ? cell.shown : undefined);
    if (cell.rowspan > 1) {
      for (let index = column; index < column + cell.colspan && index < MAX_SPANNED_COLUMNS; index++) {
        this.spans[index] = Math.max(this.spans[index] ?? 0, cell.rowspan - 1);
      }
    }
    // Each column it spans past the first is an empty cell, so that the cells after it stay under their headings.
    for (let extra = 1; extra < cell.colspan && row.columns < MAX_SPANNED_COLUMNS; extra++) this.addCell(row, undefined);
  }

  /**
   * Adds a cell to the row's line: ` text |`, or `  |` for an empty one (also for a column that a
   * merged cell covers). Each cell is counted with its separator, empty or not: a row of millions of
   * empty cells is bounded too.
   */
  private addCell(row: Row, cell: Run | undefined): void {
    if (!cell) {
      this.rowPart(row, "  |");
    } else if (cell.pieces.length === 1) {
      this.rowPart(row, ` ${cell.pieces[0]!} |`);
    } else {
      this.rowPart(row, " ");
      for (const piece of cell.pieces) this.rowPart(row, piece);
      this.rowPart(row, " |");
    }
    if (cell) row.text = true;
    row.columns++;
    row.held += 3;
    this.check();
  }

  private rowPart(row: Row, part: string): void {
    row.parts.push(part);
    row.size += part.length;
    if (row.size >= BLOCK) {
      row.blocks.push(row.parts.join(""));
      row.parts = [];
      row.size = 0;
    }
  }

  private endRow(): void {
    this.endCell();
    const row = this.row;
    if (!row) return;
    if (row.text) {
      // The columns that cells above cover after its last cell are empty cells too: the row has all its columns.
      const last = row.covered.lastIndexOf(true);
      while (row.columns <= last) this.addCell(row, undefined);
      if (row.parts.length > 0) row.blocks.push(row.parts.join(""));
    }
    // The row is let go before it is written: what it held is not counted twice.
    this.row = undefined;
    if (row.text) {
      if (row.hidden) this.writeHidden(["|", ...row.blocks]);
      else this.write("|", row.blocks, row.blocks.reduce((sum, block) => sum + block.length, 1));
    }
    if (row.hiddenText) this.writeHidden(row.hiddenText.pieces);
  }

  /** Ends the line being built. `always`: also an empty one (a `<br>` in a row of them). */
  private flush(always = false): void {
    const { prefix, shown, hidden } = this.line;
    if (shown.length === 0 && !hidden?.length) {
      // A list item or quote whose text starts in a paragraph inside it keeps its mark for that text.
      if (always && !this.hidden) this.out.blankLine();
      return;
    }
    shown.trimEnd();
    // A heading keeps its mark on each of its lines, a list item and a quote on their first line of
    // text. The line is let go before it is written: what it held is not counted twice.
    this.line = newLine(this.heading > 0 || shown.length === 0 ? prefix : "");
    if (shown.length > 0) this.write(prefix, shown.pieces, prefix.length + shown.length);
    else if (always && !this.hidden) this.out.blankLine();
    if (hidden?.length) this.writeHidden(hidden.pieces);
  }

  /** Whether `name` starting ends the hidden element, which cannot hold it. */
  private endedByStart(hidden: Hidden, name: string): boolean {
    const kind = hidden.name;
    // A paragraph holds no block, and a heading no heading.
    if (kind === "p") return BLOCKS.has(name);
    if (HEADING.test(kind)) return HEADING.test(name);
    // The next item of its list, or the next term or definition of its list.
    if (hidden.lists === 0 && name === "li" && (kind === "li" || hidden.listed)) return true;
    if (hidden.lists === 0 && (name === "dt" || name === "dd") && (kind === "dt" || kind === "dd")) return true;
    // The next part of its table at its level or above: the next cell, row or row group.
    const level = this.tableLevel(hidden);
    const other = TABLE_PARTS.get(name);
    if (level === undefined || other === undefined || hidden.tables > 0) return false;
    return kind === "caption" || kind === "colgroup" || other <= level;
  }

  /** How deep in its table the hidden element is (see `TABLE_PARTS`): inside a cell, below a cell. */
  private tableLevel(hidden: Hidden): number | undefined {
    return TABLE_PARTS.get(hidden.name) ?? (hidden.celled ? 4 : undefined);
  }

  /** Counts what opens inside the hidden element, to tell its end from the end of an element inside it. */
  private hiddenOpens(hidden: Hidden, name: string): void {
    if (name === hidden.name) hidden.depth++;
    if (LISTS.has(name) || name === "dl") hidden.lists++;
    if (name === "table") hidden.tables++;
  }

  /** Whether `name` ending ends the hidden element: its own end tag, or that of an element around it. */
  private endedByEnd(hidden: Hidden, name: string): boolean {
    const kind = hidden.name;
    if (LISTS.has(name) || name === "dl") {
      if (hidden.lists > 0) hidden.lists--;
      else if (kind === "li" || kind === "dt" || kind === "dd" || hidden.listed) return true;
    }
    if (name === "table") {
      if (hidden.tables > 0) hidden.tables--;
      else if (TABLE_PARTS.has(kind) || hidden.celled) return true;
    }
    if (kind === "p") return BLOCKS.has(name);
    if (HEADING.test(kind)) return HEADING.test(name);
    if (name === "li" && hidden.lists === 0 && hidden.listed) return true;
    const level = this.tableLevel(hidden);
    const other = TABLE_PARTS.get(name);
    if (level !== undefined && other !== undefined && hidden.tables === 0 && other < level) return true;
    return name === kind && --hidden.depth === 0;
  }
}

/** Runs of white space as one space, as a browser shows them; a no-break space stays a space. */
const decodeSpaces = (text: string) => text.replace(/\s+/g, " ");

const isAttributeSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13 || code === 12;

/**
 * The value of one attribute of an HTML tag, by its name in lower case (HTML reads `HREF` as
 * `href`, and keeps the first of two of a name), with its character references decoded, or
 * undefined when the tag has none. Only the first `maxRaw` characters of the value are decoded:
 * an attribute can be megabytes of references (`alt="&amp;&amp;…"`), and decoding all of them, or
 * every attribute of the tag, held the server and, at 100 MB, ran it out of memory. One pass over
 * the tag, with no regular expression.
 */
function attributeOf(inside: string, wanted: string, maxRaw: number): string | undefined {
  const length = inside.length;
  let at = 0;
  while (at < length) {
    while (at < length && (isAttributeSpace(inside.charCodeAt(at)) || inside[at] === "/")) at++;
    const start = at;
    while (at < length && !isAttributeSpace(inside.charCodeAt(at)) && inside[at] !== "=" && inside[at] !== "/" && inside[at] !== ">") at++;
    const name = at - start === wanted.length ? inside.slice(start, at).toLowerCase() : undefined;
    while (at < length && isAttributeSpace(inside.charCodeAt(at))) at++;
    if (inside[at] !== "=") {
      if (name === wanted) return "";
      if (at === start) at++;
      continue;
    }
    at++;
    while (at < length && isAttributeSpace(inside.charCodeAt(at))) at++;
    const quote = inside[at];
    let valueStart: number;
    let valueEnd: number;
    if (quote === "\"" || quote === "'") {
      valueStart = at + 1;
      const end = inside.indexOf(quote, valueStart);
      valueEnd = end === -1 ? length : end;
      at = end === -1 ? length : end + 1;
    } else {
      valueStart = at;
      while (at < length && !isAttributeSpace(inside.charCodeAt(at)) && inside[at] !== ">") at++;
      valueEnd = at;
    }
    if (name === wanted) return decodeHtmlEntities(inside.slice(valueStart, Math.min(valueEnd, valueStart + maxRaw)));
  }
  return undefined;
}


/**
 * Whether a tag's attributes hide its element: "none" for the `hidden` attribute or an inline style
 * of `display: none`, "invisible" for `visibility: hidden` or `collapse`, which keeps the element's
 * place. Only the first `MAX_TAG` characters of the tag are read for it: a picture's address can be
 * megabytes long.
 */
function hiding(attributes: string): "none" | "invisible" | undefined {
  if (attributes.length < 5) return undefined;
  const inside = attributes.length > MAX_TAG ? attributes.slice(0, MAX_TAG) : attributes;
  // Most tags have none of these words: their attributes are not read at all.
  if (!/hidden|none|collapse/i.test(inside)) return undefined;
  if (attributeOf(inside, "hidden", 0) !== undefined) return "none";
  const style = attributeOf(inside, "style", MAX_STYLE);
  return style === undefined ? undefined : styleHiding(style);
}

/** An inline style is read up to this many characters for whether it hides its element. */
const MAX_STYLE = 4_096;
/** The values of `display` and `visibility` a browser takes: a declaration with another value is dropped, as CSS drops it. */
const DISPLAY_VALUES = /^(?:none|block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|flow|flow-root|list-item|table|inline-table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-column-group|table-caption|ruby|ruby-base|ruby-text|run-in|math|inherit|initial|unset|revert|revert-layer)$/;
const VISIBILITY_VALUES = /^(?:visible|hidden|collapse|inherit|initial|unset|revert|revert-layer)$/;

/** `hiding` of an inline style: the last `display` and `visibility` of it count, an `!important` one first. */
function styleHiding(style: string): "none" | "invisible" | undefined {
  const values = new Map<string, { value: string; important: boolean }>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (property !== "display" && property !== "visibility") continue;
    let value = declaration.slice(colon + 1).trim().toLowerCase();
    const important = /!\s*important$/.test(value);
    if (important) value = value.slice(0, value.lastIndexOf("!")).trim();
    // "display: foo" is dropped by CSS, and the declaration before it stays.
    if (!(property === "display" ? DISPLAY_VALUES : VISIBILITY_VALUES).test(value)) continue;
    if (important || !values.get(property)?.important) values.set(property, { value, important });
  }
  if (values.get("display")?.value === "none") return "none";
  const visibility = values.get("visibility")?.value;
  return visibility === "hidden" || visibility === "collapse" ? "invisible" : undefined;
}

/** The refusal of a page with more text than `maxTextBytes`, in the words of the other extractors. */
const tooMuchText = (maxTextBytes: number) =>
  new Error(`This HTML page holds more than ${formatBytes(maxTextBytes)} of text, more than is kept from one file. Split it, and attach the part you need.`);

/**
 * Where a piece of the text from `from` to `to` ends: after `TEXT_PIECE` characters at most, and
 * not inside a character reference, between the two characters of "\r\n", or between the two
 * halves of a character outside the basic plane.
 */
function pieceEnd(html: string, from: number, to: number): number {
  if (to - from <= TEXT_PIECE) return to;
  const end = from + TEXT_PIECE;
  const reference = html.slice(end - MAX_REFERENCE, end).lastIndexOf("&");
  if (reference !== -1) return end - MAX_REFERENCE + reference;
  const last = html.charCodeAt(end - 1);
  return last === 13 || (last >= 0xd800 && last <= 0xdbff) ? end - 1 : end;
}

/** A page's title from the text of its `<title>`: its first `MAX_TITLE` characters, read from the start of that text only. */
function titleOf(content: string): string {
  return sliceWhole(decodeSpaces(decodeHtmlEntities(content.slice(0, MAX_TITLE * 8))).trim(), MAX_TITLE).trimEnd();
}

const TAG_NAME = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)/y;

/**
 * The text of an HTML page (see the comment at the top of this file), with pauses for other
 * requests. `maxTextBytes`: it is refused as soon as its text grows past this many characters (a
 * character is at least one byte).
 */
export async function htmlToText(html: string, signal?: AbortSignal, maxTextBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const slicer = new TimeSlicer(signal);
  const out = new HtmlText(maxTextBytes);
  let title: string | undefined;
  let hasHeading = false;
  const length = html.length;
  // Raw-text elements whose end tag was looked for and is not there: it is not looked for again.
  const unclosed = new Set<string>();
  let steps = 0;
  let looked = 0;
  // Text longer than a piece is read a piece at a time, with a look at the clock after each.
  const readText = async (from: number, to: number) => {
    for (let at = from; at < to;) {
      const end = pieceEnd(html, at, to);
      out.text(html.slice(at, end));
      at = end;
      await slicer.maybePause();
    }
  };
  for (let at = 0; at < length;) {
    // A look at the clock every so many tags, and after each piece of text or tags of some length.
    if ((++steps & 1023) === 0 || at - looked >= TEXT_PIECE) {
      looked = at;
      await slicer.maybePause();
    }
    const start = html.indexOf("<", at);
    const textEnd = start === -1 ? length : start;
    if (textEnd - at > TEXT_PIECE) await readText(at, textEnd);
    else if (textEnd > at) out.text(html.slice(at, textEnd));
    if (start === -1) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      at = end === -1 ? length : end + 3;
      continue;
    }
    if (html.startsWith("<!", start) || html.startsWith("<?", start)) {
      const end = html.indexOf(">", start);
      at = end === -1 ? length : end + 1;
      continue;
    }
    TAG_NAME.lastIndex = start;
    const named = TAG_NAME.exec(html);
    if (!named) {
      out.text("<");
      at = start + 1;
      continue;
    }
    const closing = named[1] === "/";
    const name = named[2]!.toLowerCase();
    // The tag's end: its first ">" outside quotes, unless the quotes run on too far.
    let end = -1;
    let quote = 0;
    const limit = Math.min(length, TAG_NAME.lastIndex + MAX_TAG);
    for (let index = TAG_NAME.lastIndex; index < limit; index++) {
      const code = html.charCodeAt(index);
      if (quote !== 0) {
        if (code === quote) quote = 0;
      } else if (code === 34 || code === 39) {
        quote = code;
      } else if (code === 62) {
        end = index;
        break;
      }
    }
    if (end === -1) end = html.indexOf(">", TAG_NAME.lastIndex);
    if (end === -1) end = length;
    const inside = html.slice(TAG_NAME.lastIndex, end);
    const selfClosing = inside.endsWith("/");
    const attributes = selfClosing ? inside.slice(0, -1) : inside;
    at = end + 1;
    if (closing) {
      out.close(name);
      continue;
    }
    if (HEADING.test(name)) hasHeading = true;
    if (RAW_TEXT.has(name)) {
      let found: RegExpExecArray | null = null;
      if (!unclosed.has(name)) {
        const closer = new RegExp(`</${name}\\s*>`, "gi");
        closer.lastIndex = at;
        found = closer.exec(html);
        if (!found) unclosed.add(name);
      }
      if (name === "title") {
        // A title never closed would take the rest of the page, which a browser then does not show:
        // the rest is read as the page instead. The title of an inline SVG (or of anything else left
        // out) does not name the page: it is left out with what holds it.
        if (!found) continue;
        if (title === undefined && !out.skipped) title = titleOf(html.slice(at, found.index));
        at = found.index + found[0].length;
        continue;
      }
      if (name === "textarea" || name === "xmp" || name === "plaintext") {
        out.open("pre", attributes);
        await readText(at, found ? found.index : length);
        out.close("pre");
      }
      at = found ? found.index + found[0].length : length;
      continue;
    }
    out.open(name, attributes);
    // `<svg/>` holds nothing: it ends where it starts.
    if (selfClosing && SKIPPED.has(name)) out.close(name);
  }
  await slicer.maybePause();
  const body = out.result();
  // The title names the page, when no heading of it does. It is looked for at the start of the text
  // only: in a text of megabytes, a title written to be found nowhere took seconds to look for.
  if (!title || (hasHeading && body.slice(0, TITLE_SEARCH).includes(title))) return body;
  if (body.length + title.length + 4 > maxTextBytes) throw tooMuchText(maxTextBytes);
  return body ? `# ${title}\n\n${body}` : `# ${title}`;
}

export const html: Extractor = async (bytes, input) => {
  input?.signal?.throwIfAborted();
  const slicer = new TimeSlicer(input?.signal);
  const steps = decodeSteps(bytes);
  let step = steps.next();
  while (!step.done) {
    await slicer.maybePause();
    step = steps.next();
  }
  const { text, encoding, replacedCharacters } = step.value;
  const converted = await htmlToText(text, input?.signal, input?.maxTextBytes);
  input?.onProgress?.({ stage: "decode", done: bytes.byteLength, total: bytes.byteLength, unit: "bytes" });
  return { text: converted, ...(encoding ? { encoding } : {}), ...(replacedCharacters ? { replacedCharacters } : {}) };
};
