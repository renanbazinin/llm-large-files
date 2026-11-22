import { decodeSteps } from "./decode.js";
import { TimeSlicer } from "./pause.js";
import type { Extractor } from "./types.js";
import { parseAttributes } from "./xml-stream.js";

/**
 * HTML pages, as text a model can search and cite: the text a browser shows, without scripts,
 * styles and markup. Headings become Markdown headings, list items "- item" (or "1. item"), each
 * table row `| cell | cell |` with its empty cells, a link "text (https://…)", and a picture its
 * alt text. Entities are decoded: "AT&amp;T" is found as "AT&T". Saved pages in an older encoding
 * are read as text files are.
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
/** List items are indented by their depth, up to this many levels. */
const MAX_INDENT = 6;
/** A tag is read up to this many characters; past it, it ends at its first ">". */
const MAX_TAG = 64 * 1024;

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

/** One line of output being built: its prefix (a heading's "#", a list item's "- ") and pieces of text. */
type Line = { prefix: string; pieces: string[] };

/**
 * Builds the text of a page as its tags and text go past. A table row is collected cell by cell
 * and written as one line when it ends; a table inside a cell is read as text of that cell.
 */
class HtmlText {
  private readonly lines: string[] = [];
  private line: Line = { prefix: "", pieces: [] };
  /** How deep inside skipped elements, `pre` elements, and lists (with the count of each ordered one). */
  private skipping = 0;
  private preformatted = 0;
  private readonly lists: Array<{ ordered: boolean; count: number }> = [];
  private heading = 0;
  /** The table row being read: its cells, and the cell open. `depth`: tables inside the table. */
  private row: { cells: string[]; cell: string[] | undefined } | undefined;
  private tableDepth = 0;
  /** The link open, to write its address after its text. */
  private link: { href: string; start: number } | undefined;

  open(name: string, attributes: string): void {
    if (SKIPPED.has(name)) {
      this.skipping++;
      return;
    }
    if (this.skipping > 0) return;
    if (name === "table") {
      this.tableDepth++;
      if (this.tableDepth === 1) this.flush();
      return;
    }
    if (this.tableDepth === 1 && (name === "tr" || name === "td" || name === "th")) {
      if (name === "tr") {
        this.endRow();
        this.row = { cells: [], cell: undefined };
      } else {
        this.row ??= { cells: [], cell: undefined };
        this.endCell();
        this.row.cell = [];
      }
      return;
    }
    if (this.row?.cell) {
      // Inside a cell: line breaks become spaces, as the cell is one cell of one row.
      if (name === "br") this.text(" ");
      else if (name === "img") this.image(attributes);
      else if (name === "a") this.startLink(attributes);
      return;
    }
    if (name === "br") {
      this.flush(true);
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
    if (name === "ul" || name === "ol" || name === "menu" || name === "dir") {
      this.flush();
      this.lists.push({ ordered: name === "ol", count: Number.parseInt(parseAttributes(attributes).start ?? "1", 10) - 1 || 0 });
      return;
    }
    if (BLOCKS.has(name)) this.flush();
    const level = /^h([1-6])$/.exec(name);
    if (level) {
      this.heading = Number(level[1]);
      this.line.prefix = `${"#".repeat(this.heading)} `;
    } else if (name === "li") {
      const list = this.lists.at(-1);
      // Indented up to a few levels: a page of lists nested thousands deep must not grow its text by the square.
      const indent = "  ".repeat(Math.min(MAX_INDENT, Math.max(0, this.lists.length - 1)));
      if (list?.ordered) this.line.prefix = `${indent}${++list.count}. `;
      else this.line.prefix = `${indent}- `;
    } else if (name === "hr") {
      this.lines.push("---");
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
    if (name === "table") {
      if (this.tableDepth === 1) {
        this.endRow();
        this.row = undefined;
      }
      if (this.tableDepth > 0) this.tableDepth--;
      return;
    }
    if (this.tableDepth === 1 && this.row) {
      if (name === "tr") this.endRow();
      else if (name === "td" || name === "th") this.endCell();
      else if (name === "a") this.endLink();
      return;
    }
    if (name === "a") {
      this.endLink();
      return;
    }
    if (name === "pre" && this.preformatted > 0) {
      // The last line of the block keeps its spaces: it ends while the block is still open.
      this.flush();
      this.preformatted--;
      return;
    }
    if (name === "ul" || name === "ol" || name === "menu" || name === "dir") {
      this.flush();
      this.lists.pop();
      return;
    }
    if (/^h[1-6]$/.test(name)) this.heading = 0;
    if (BLOCKS.has(name)) this.flush();
  }

  text(raw: string): void {
    if (this.skipping > 0 || raw === "") return;
    const text = decodeHtmlEntities(raw);
    if (this.row?.cell) {
      this.row.cell.push(text);
      return;
    }
    if (this.tableDepth > 0 && !this.row?.cell) {
      // Text between the cells of a table (white space, or a caption's text outside a cell).
      if (!text.trim()) return;
    }
    if (this.preformatted > 0) {
      const lines = text.split("\n");
      lines.forEach((piece, index) => {
        if (index > 0) this.flush(true, true);
        this.line.pieces.push(piece);
      });
      return;
    }
    this.line.pieces.push(text);
  }

  private image(attributes: string): void {
    const alt = parseAttributes(attributes).alt?.trim();
    if (alt) this.text(` [Image: ${alt}] `);
  }

  private startLink(attributes: string): void {
    const href = parseAttributes(attributes).href?.trim() ?? "";
    // Only addresses a person can follow outside the page: not "#top", not "javascript:".
    if (/^(https?:|mailto:)/i.test(href) && href.length <= 2_048) {
      const pieces = this.row?.cell ?? this.line.pieces;
      this.link = { href, start: pieces.length };
    }
  }

  private endLink(): void {
    const link = this.link;
    this.link = undefined;
    if (!link) return;
    const pieces = this.row?.cell ?? this.line.pieces;
    const shown = pieces.slice(link.start).join("").trim();
    const address = link.href.replace(/^mailto:/i, "");
    // A link whose text is its address says it once.
    if (shown && !shown.includes(address)) pieces.push(` (${link.href.startsWith("mailto:") ? address : link.href})`);
  }

  private endCell(): void {
    const row = this.row;
    if (!row?.cell) return;
    row.cells.push(decodeSpaces(row.cell.join("")).replace(/\|/g, "\\|").trim());
    row.cell = undefined;
  }

  private endRow(): void {
    this.endCell();
    const row = this.row;
    this.row = undefined;
    if (!row || row.cells.length === 0 || row.cells.every((cell) => cell === "")) return;
    this.lines.push(`| ${row.cells.join(" | ")} |`);
  }

  /** Ends the line being built. `always`: also an empty one (a `<br>` in a row of them). */
  private flush(always = false, keepSpaces = false): void {
    const text = keepSpaces || this.preformatted > 0 ? this.line.pieces.join("").replace(/\s+$/, "") : decodeSpaces(this.line.pieces.join("")).trim();
    if (text) this.lines.push(`${this.line.prefix}${text}`);
    else if (always && this.lines.length > 0 && this.lines.at(-1) !== "") this.lines.push("");
    // A heading or list item keeps its mark only on its first line.
    this.line = { prefix: this.heading > 0 ? this.line.prefix : "", pieces: [] };
  }

  result(): string {
    this.endRow();
    this.flush();
    return this.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
}

/** Runs of white space as one space, as a browser shows them; a no-break space stays a space. */
const decodeSpaces = (text: string) => text.replace(/[\s ]+/g, " ");

const TAG_NAME = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)/y;

/** The text of an HTML page (see the comment at the top of this file), with pauses for other requests. */
export async function htmlToText(html: string, signal?: AbortSignal): Promise<string> {
  const slicer = new TimeSlicer(signal);
  const out = new HtmlText();
  let title: string | undefined;
  let hasHeading = false;
  const length = html.length;
  let steps = 0;
  for (let at = 0; at < length;) {
    if ((++steps & 1023) === 0) await slicer.maybePause();
    const start = html.indexOf("<", at);
    if (start === -1) {
      out.text(html.slice(at));
      break;
    }
    if (start > at) out.text(html.slice(at, start));
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
    if (/^h[1-6]$/.test(name)) hasHeading = true;
    if (RAW_TEXT.has(name)) {
      const closer = new RegExp(`</${name}\\s*>`, "gi");
      closer.lastIndex = at;
      const found = closer.exec(html);
      const content = html.slice(at, found ? found.index : length);
      at = found ? closer.lastIndex : length;
      if (name === "title") title ??= decodeSpaces(decodeHtmlEntities(content)).trim();
      else if (name === "textarea" || name === "xmp" || name === "plaintext") {
        out.open("pre", "");
        out.text(content);
        out.close("pre");
      }
      continue;
    }
    out.open(name, attributes);
    // `<svg/>` holds nothing: it ends where it starts.
    if (selfClosing && SKIPPED.has(name)) out.close(name);
  }
  const body = out.result();
  // The title names the page, when no heading of it does.
  return title && (!hasHeading || !body.includes(title)) ? `# ${title}\n\n${body}` : body;
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
  const converted = await htmlToText(text, input?.signal);
  input?.onProgress?.({ stage: "decode", done: bytes.byteLength, total: bytes.byteLength, unit: "bytes" });
  return { text: converted, ...(encoding ? { encoding } : {}), ...(replacedCharacters ? { replacedCharacters } : {}) };
};
