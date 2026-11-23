import { sliceWhole } from "./text.js";
import { readXml, type XmlAttributes } from "./xml-stream.js";

/**
 * Word's paragraph styles and list numbering, read from `word/styles.xml` and
 * `word/numbering.xml`, so that a paragraph's text can be written with the number Word shows before
 * it ("2.1", "(a)", "ג.") and a heading as a Markdown heading. Without them, "clause 2.2" of a
 * contract cannot be found, and the document has no outline.
 */

/** What a paragraph says of itself in its properties (`w:pPr`). */
export type ParagraphStyle = {
  styleId?: string;
  /** `w:numPr`: the list and its level. A `numId` of "0" takes numbering off. */
  numId?: string;
  ilvl?: number;
  /** `w:outlineLvl`, 0-based: 0 is a top-level heading, 9 is body text. */
  outlineLevel?: number;
};

/**
 * A level of a list: its start, its number format, its number text cut into the text between the
 * numbers and the level of each number (`"%1.%2"` is `[0, ".", 1]`), and whether it writes the
 * numbers of all levels in Arabic digits (`w:isLgl`, Word's "legal style numbering").
 */
type Level = { start: number; format: string; parts: Array<string | number>; legal: boolean };
/**
 * A list definition (`w:abstractNum`): its levels, the list style it defines (`w:styleLink`), and
 * the list style it takes its levels from instead (`w:numStyleLink`). Word writes a list made with
 * a list style, as its "1 / 1.1 / 1.1.1" or "Article / Section", as a definition with no levels.
 */
type ListDefinition = { levels: Level[]; styleLink?: string; numStyleLink?: string };
/** A list (`w:num`): its definition, and the levels it starts at another number. */
type Num = { abstractId: string; starts: Map<number, number> };
type StyleInfo = { name: string; basedOn?: string; numId?: string; ilvl?: number; outlineLevel?: number };
/** What a paragraph style and the styles it is based on give its paragraphs: a list and level, a heading level, an outline level. */
type Resolved = { numId?: string; ilvl?: number; heading?: number; outline?: number };
/** A list as it numbers paragraphs: the definition whose counts it shares, its levels, and its start overrides. */
type List = { key: string; levels: Level[]; starts: Map<number, number> };
/**
 * A paragraph counted in its list, as `WordNumbering.count` gives it to `labelOf`: the levels of
 * its list, its level, and the counts of the list.
 */
type Counted ={ levels: Level[]; level: number; counts: Array<number | undefined> };

/** Levels of numbering a list may have in Word. */
const LEVELS = 9;
/**
 * The characters of a level's number text kept, and of the number written from it: Word's dialog
 * takes far fewer. Each `%n` of the text may be a Roman numeral of 15 letters, and the number is
 * written before every paragraph of the list.
 */
const MAX_LABEL = 64;
/** Links from a list definition to a list style, and on to the definition of that style, followed at most: Word makes one. */
const MAX_LIST_LINKS = 4;
const NOTHING: Resolved = {};

const attribute = (attributes: XmlAttributes, name: string) => attributes[`w:${name}`] ?? attributes[name];
const integerOf = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : undefined;
};

/** A start value of a list, within what Word allows (0 to 32,767): a file may say anything. */
const startOf = (value: string | undefined): number | undefined => {
  const number = integerOf(value);
  return number === undefined ? undefined : Math.min(32_767, Math.max(0, number));
};

/**
 * Reads `w:style` elements: names, the style each is based on, and the numbering and outline level
 * in its paragraph properties. Paragraph styles and list styles (`w:type="numbering"`, whose list a
 * list definition may take its levels from) are kept apart.
 */
function readStyles(xml: string | undefined): { styles: Map<string, StyleInfo>; listStyles: Map<string, StyleInfo> } {
  const styles = new Map<string, StyleInfo>();
  const listStyles = new Map<string, StyleInfo>();
  if (!xml) return { styles, listStyles };
  let current: StyleInfo | undefined;
  let inParagraphProperties = 0;
  let inChange = 0;
  readXml(xml, {
    open(name, attributes, empty) {
      if (name === "w:style") {
        const id = attribute(attributes, "styleId");
        const type = attribute(attributes, "type");
        const kept = type === undefined || type === "paragraph" ? styles : type === "numbering" ? listStyles : undefined;
        current = id && kept ? { name: "" } : undefined;
        if (current && id) kept?.set(id, current);
        return;
      }
      if (!current) return;
      if (name === "w:pPrChange" && !empty) inChange++;
      if (inChange > 0) return;
      if (name === "w:pPr" && !empty) inParagraphProperties++;
      else if (name === "w:name") current.name = (attribute(attributes, "val") ?? "").toLowerCase();
      else if (name === "w:basedOn") current.basedOn = attribute(attributes, "val");
      else if (inParagraphProperties > 0 && name === "w:numId") current.numId = attribute(attributes, "val");
      else if (inParagraphProperties > 0 && name === "w:ilvl") current.ilvl = integerOf(attribute(attributes, "val"));
      else if (inParagraphProperties > 0 && name === "w:outlineLvl") current.outlineLevel = integerOf(attribute(attributes, "val"));
    },
    close(name) {
      if (name === "w:style") current = undefined;
      else if (name === "w:pPrChange" && inChange > 0) inChange--;
      else if (name === "w:pPr" && inParagraphProperties > 0) inParagraphProperties--;
    },
  });
  return { styles, listStyles };
}

/** `"%1.%2."` as `[0, ".", 1, "."]`: the text of a level, with the level of each number in it. */
function partsOf(text: string): Array<string | number> {
  const parts: Array<string | number> = [];
  let from = 0;
  for (const match of text.matchAll(/%([1-9])/g)) {
    if (match.index > from) parts.push(text.slice(from, match.index));
    parts.push(Number(match[1]) - 1);
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/** Reads `w:abstractNum` and `w:num` elements. */
function readNumbering(xml: string | undefined): { abstracts: Map<string, ListDefinition>; nums: Map<string, Num> } {
  const abstracts = new Map<string, ListDefinition>();
  const nums = new Map<string, Num>();
  if (!xml) return { abstracts, nums };
  let abstract: ListDefinition | undefined;
  let level: Level | undefined;
  let num: Num | undefined;
  let overrideLevel: number | undefined;
  readXml(xml, {
    open(name, attributes, empty) {
      if (name === "w:abstractNum" && !empty) {
        abstract = { levels: [] };
        const id = attribute(attributes, "abstractNumId");
        if (id !== undefined) abstracts.set(id, abstract);
      } else if (abstract && name === "w:lvl" && !empty) {
        const index = integerOf(attribute(attributes, "ilvl")) ?? 0;
        level = { start: 1, format: "decimal", parts: [index, "."], legal: false };
        if (index >= 0 && index < LEVELS) abstract.levels[index] = level;
      } else if (level && name === "w:start") {
        level.start = startOf(attribute(attributes, "val")) ?? 1;
      } else if (level && name === "w:numFmt") {
        level.format = attribute(attributes, "val") ?? "decimal";
      } else if (level && name === "w:lvlText") {
        // Word writes a few characters here ("%1.%2."); a long one would be copied before every paragraph.
        level.parts = partsOf(sliceWhole(attribute(attributes, "val") ?? "", MAX_LABEL));
      } else if (level && name === "w:isLgl") {
        level.legal = !["0", "false", "off"].includes(attribute(attributes, "val") ?? "");
      } else if (abstract && !level && name === "w:styleLink") {
        abstract.styleLink = attribute(attributes, "val");
      } else if (abstract && !level && name === "w:numStyleLink") {
        abstract.numStyleLink = attribute(attributes, "val");
      } else if (name === "w:num" && !empty) {
        num = { abstractId: "", starts: new Map() };
        const id = attribute(attributes, "numId");
        if (id !== undefined) nums.set(id, num);
      } else if (num && name === "w:abstractNumId") {
        num.abstractId = attribute(attributes, "val") ?? "";
      } else if (num && name === "w:lvlOverride") {
        overrideLevel = integerOf(attribute(attributes, "ilvl"));
      } else if (num && overrideLevel !== undefined && overrideLevel >= 0 && overrideLevel < LEVELS && name === "w:startOverride") {
        const start = startOf(attribute(attributes, "val"));
        if (start !== undefined) num.starts.set(overrideLevel, start);
      }
    },
    close(name) {
      if (name === "w:abstractNum") abstract = undefined;
      else if (name === "w:lvl") level = undefined;
      else if (name === "w:num") num = undefined;
      else if (name === "w:lvlOverride") overrideLevel = undefined;
    },
  });
  return { abstracts, nums };
}

const ROMAN: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

function roman(value: number): string {
  // Roman numerals end at 3999; past it Word writes the number.
  if (value < 1 || value > 3_999) return String(value);
  let rest = value;
  let out = "";
  for (const [size, letters] of ROMAN) {
    while (rest >= size) {
      out += letters;
      rest -= size;
    }
  }
  return out;
}

/** a, b, … z, aa, bb, …: Word repeats the letter. */
function letters(value: number): string {
  // Past "zzzzzzzzzz" (260) the letters would only grow: the number is written.
  if (value < 1 || value > 260) return String(value);
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

const HEBREW_ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const HEBREW_TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const HEBREW_HUNDREDS = ["", "ק", "ר", "ש", "ת"];
const HEBREW_LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";

/** Hebrew numerals (hebrew1): א, ב, … י, יא, … טו and טז for 15 and 16, as Word writes them. */
function hebrewNumeral(value: number): string {
  if (value < 1) return String(value);
  let rest = value % 1000;
  let out = "";
  while (rest >= 400) {
    out += "ת";
    rest -= 400;
  }
  out += HEBREW_HUNDREDS[Math.floor(rest / 100)]!;
  rest %= 100;
  if (rest === 15) return `${out}טו`;
  if (rest === 16) return `${out}טז`;
  return out + HEBREW_TENS[Math.floor(rest / 10)]! + HEBREW_ONES[rest % 10]!;
}

/** A counter in a list format of Word. Formats it does not know are written as numbers. */
export function formatNumber(value: number, format: string): string {
  switch (format) {
    case "lowerLetter": return letters(value);
    case "upperLetter": return letters(value).toUpperCase();
    case "lowerRoman": return roman(value);
    case "upperRoman": return roman(value).toUpperCase();
    case "decimalZero": return value < 10 ? `0${value}` : String(value);
    case "hebrew1": return hebrewNumeral(value);
    case "hebrew2": return value < 1 ? String(value) : HEBREW_LETTERS[(value - 1) % HEBREW_LETTERS.length]!;
    case "none": return "";
    default: return String(value);
  }
}

/** Private-use characters: the bullets of the Symbol and Wingdings fonts. */
const PRIVATE_USE = /[-]/u;

/**
 * Numbers the paragraphs of one document in order, as Word does: one count for each list and level,
 * shared by the lists made from one definition (or from one list style), restarted by a list that
 * says where to start, and the deeper levels started again when a level counts up.
 *
 * Every paragraph of a list is counted, an empty one too, but its number is written only when it
 * has text (`count`, then `labelOf`), and what a style gives is worked out once a style: a file of
 * 312,500 empty paragraphs of a style based on 19 others, in a list whose number was 480
 * characters long, took 25 seconds for 45 KB.
 */
export class WordNumbering {
  private readonly styles: Map<string, StyleInfo>;
  private readonly listStyles: Map<string, StyleInfo>;
  private readonly abstracts: Map<string, ListDefinition>;
  private readonly nums: Map<string, Num>;
  /** The list definition that defines each list style (`w:styleLink`). */
  private readonly styleLinks = new Map<string, string>();
  /** The counts of each list definition, by level: undefined for a level not counted since it was last started again. */
  private readonly counts = new Map<string, Array<number | undefined>>();
  /** Lists whose start override has been applied. */
  private readonly started = new Set<string>();
  /** What each paragraph style gives, worked out at its first paragraph: the styles of a document do not change. */
  private readonly resolved = new Map<string, Resolved>();
  /** Each list found so far, by its `numId`; null for one with no levels. */
  private readonly lists = new Map<string, List | null>();

  constructor(stylesXml: string | undefined, numberingXml: string | undefined) {
    ({ styles: this.styles, listStyles: this.listStyles } = readStyles(stylesXml));
    ({ abstracts: this.abstracts, nums: this.nums } = readNumbering(numberingXml));
    for (const [id, definition] of this.abstracts) {
      if (definition.styleLink !== undefined && !this.styleLinks.has(definition.styleLink)) this.styleLinks.set(definition.styleLink, id);
    }
  }

  /** A style and the styles it is based on, nearest first, at most 20 deep. */
  private *chain(styleId: string | undefined): Generator<StyleInfo> {
    const seen = new Set<string>();
    for (let id = styleId; id !== undefined && !seen.has(id) && seen.size < 20; id = this.styles.get(id)?.basedOn) {
      seen.add(id);
      const style = this.styles.get(id);
      if (!style) return;
      yield style;
    }
  }

  /**
   * What a paragraph style gives: the nearest list, level and outline level in its chain, and the
   * level of its nearest heading style ("heading 2", or a style whose name Word gives in English
   * even in a Hebrew document) or title style. Kept only for the styles the file defines, which
   * bounds what is kept.
   */
  private resolve(styleId: string | undefined): Resolved {
    if (styleId === undefined || !this.styles.has(styleId)) return NOTHING;
    let resolved = this.resolved.get(styleId);
    if (resolved) return resolved;
    resolved = {};
    for (const style of this.chain(styleId)) {
      resolved.numId ??= style.numId;
      resolved.ilvl ??= style.ilvl;
      resolved.outline ??= style.outlineLevel;
      if (resolved.heading === undefined) {
        const named = /^heading (\d)$/.exec(style.name);
        if (named) resolved.heading = Math.min(6, Math.max(1, Number(named[1])));
        else if (style.name === "title") resolved.heading = 1;
      }
    }
    this.resolved.set(styleId, resolved);
    return resolved;
  }

  /**
   * The level of a heading, 1 to 6, for a paragraph of a heading style, of the title style, or with
   * an outline level. Undefined for body text.
   */
  headingLevel(paragraph: ParagraphStyle): number | undefined {
    const style = this.resolve(paragraph.styleId);
    if (style.heading !== undefined) return style.heading;
    const outline = paragraph.outlineLevel ?? style.outline;
    return outline !== undefined && outline >= 0 && outline < 6 ? outline + 1 : undefined;
  }

  /** The list a `numId` names, found at its first paragraph; undefined when the file defines none, or it has no levels. */
  private list(numId: string): List | undefined {
    const known = this.lists.get(numId);
    if (known !== undefined) return known ?? undefined;
    // A numId the file does not define is not kept: the paragraphs may name any number of them.
    const num = this.nums.get(numId);
    if (!num) return undefined;
    const found = this.definitionOf(num.abstractId);
    const list = found ? { key: found.id, levels: found.definition.levels, starts: num.starts } : null;
    this.lists.set(numId, list);
    return list ?? undefined;
  }

  /**
   * The list definition whose levels and counts a definition uses: itself, or for one that takes
   * them from a list style (`w:numStyleLink`), the definition of that style: the one that names it
   * in `w:styleLink`, or that of the list in the style's own properties. A file may link them in a
   * circle, so a few links are followed; a definition linked back to itself keeps its own levels.
   */
  private definitionOf(abstractId: string): { id: string; definition: ListDefinition } | undefined {
    let id = abstractId;
    for (let link = 0; link <= MAX_LIST_LINKS; link++) {
      const definition = this.abstracts.get(id);
      if (!definition) return undefined;
      const style = definition.numStyleLink;
      if (style === undefined) return { id, definition };
      const styleNumId = this.listStyles.get(style)?.numId;
      const linked = this.styleLinks.get(style) ?? (styleNumId === undefined ? undefined : this.nums.get(styleNumId)?.abstractId);
      if (linked === undefined || linked === id) return { id, definition };
      id = linked;
    }
    return undefined;
  }

  /**
   * Counts a paragraph in its list, as Word counts every paragraph of a list, an empty one too. It
   * gives what `labelOf` needs to write the paragraph's number, until the next paragraph is
   * counted, or undefined for a paragraph of no list.
   */
  count(paragraph: ParagraphStyle): Counted | undefined {
    const style = this.resolve(paragraph.styleId);
    const numId = paragraph.numId ?? style.numId;
    if (numId === undefined || numId === "0") return undefined;
    const list = this.list(numId);
    if (!list) return undefined;
    const level = Math.min(LEVELS - 1, Math.max(0, paragraph.ilvl ?? style.ilvl ?? 0));
    const definition = list.levels[level];
    if (!definition) return undefined;
    let counts = this.counts.get(list.key);
    if (!counts) {
      counts = new Array<number | undefined>(LEVELS).fill(undefined);
      this.counts.set(list.key, counts);
    }
    if (!this.started.has(numId)) {
      this.started.add(numId);
      for (const [overridden, start] of list.starts) counts[overridden] = start - 1;
    }
    const count = counts[level];
    counts[level] = count === undefined ? definition.start : count + 1;
    for (let deeper = level + 1; deeper < LEVELS; deeper++) counts[deeper] = undefined;
    return { levels: list.levels, level, counts };
  }

  /**
   * The number Word writes before a paragraph that `count` has just counted ("2.1.", "(a)", "-"
   * for a bullet), or undefined. It is cut after `MAX_LABEL` characters.
   */
  labelOf({ levels, level, counts }: Counted): string | undefined {
    const definition = levels[level];
    if (!definition) return undefined;
    if (definition.format === "bullet") return "-";
    let text = "";
    for (const part of definition.parts) {
      if (typeof part === "string") {
        text += part;
      } else {
        const own = levels[part];
        const format = own?.format ?? "decimal";
        // A legal level writes the number of every level in Arabic digits. Word keeps the zero of
        // decimalZero: "Section 1.01" of its "Article I. / Section 1.01" list is a legal level.
        text += formatNumber(counts[part] ?? own?.start ?? 1, definition.legal && format !== "decimalZero" ? "decimal" : format);
      }
      if (text.length >= MAX_LABEL) {
        text = sliceWhole(text, MAX_LABEL);
        break;
      }
    }
    if (PRIVATE_USE.test(text)) return "-";
    return text.trim() || undefined;
  }

  /** Counts a paragraph (`count`), and gives the number Word writes before it (`labelOf`), or undefined. */
  label(paragraph: ParagraphStyle): string | undefined {
    const counted = this.count(paragraph);
    return counted && this.labelOf(counted);
  }
}
