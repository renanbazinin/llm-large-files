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

type Level = { start: number; format: string; text: string };
type StyleInfo = { name: string; basedOn?: string; numId?: string; ilvl?: number; outlineLevel?: number };

/** Levels of numbering a list may have in Word. */
const LEVELS = 9;
/** The characters of a level's number text kept: Word's dialog takes far fewer. */
const MAX_LABEL = 64;

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

/** Reads `w:style` elements: names, the style each is based on, and the numbering and outline level in its paragraph properties. */
function readStyles(xml: string | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!xml) return styles;
  let current: StyleInfo | undefined;
  let inParagraphProperties = 0;
  let inChange = 0;
  readXml(xml, {
    open(name, attributes, empty) {
      if (name === "w:style") {
        const id = attribute(attributes, "styleId");
        const type = attribute(attributes, "type");
        current = id && (type === undefined || type === "paragraph") ? { name: "" } : undefined;
        if (current && id) styles.set(id, current);
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
  return styles;
}

/** Reads `w:abstractNum` and `w:num` elements. */
function readNumbering(xml: string | undefined): { abstracts: Map<string, Level[]>; nums: Map<string, { abstractId: string; starts: Map<number, number> }> } {
  const abstracts = new Map<string, Level[]>();
  const nums = new Map<string, { abstractId: string; starts: Map<number, number> }>();
  if (!xml) return { abstracts, nums };
  let abstract: Level[] | undefined;
  let level: Level | undefined;
  let num: { abstractId: string; starts: Map<number, number> } | undefined;
  let overrideLevel: number | undefined;
  readXml(xml, {
    open(name, attributes, empty) {
      if (name === "w:abstractNum" && !empty) {
        abstract = [];
        const id = attribute(attributes, "abstractNumId");
        if (id !== undefined) abstracts.set(id, abstract);
      } else if (abstract && name === "w:lvl" && !empty) {
        const index = integerOf(attribute(attributes, "ilvl")) ?? 0;
        level = { start: 1, format: "decimal", text: `%${index + 1}.` };
        if (index >= 0 && index < LEVELS) abstract[index] = level;
      } else if (level && name === "w:start") {
        level.start = startOf(attribute(attributes, "val")) ?? 1;
      } else if (level && name === "w:numFmt") {
        level.format = attribute(attributes, "val") ?? "decimal";
      } else if (level && name === "w:lvlText") {
        // Word writes a few characters here ("%1.%2."); a long one would be copied before every paragraph.
        level.text = (attribute(attributes, "val") ?? "").slice(0, MAX_LABEL);
      } else if (name === "w:num" && !empty) {
        num = { abstractId: "", starts: new Map() };
        const id = attribute(attributes, "numId");
        if (id !== undefined) nums.set(id, num);
      } else if (num && name === "w:abstractNumId") {
        num.abstractId = attribute(attributes, "val") ?? "";
      } else if (num && name === "w:lvlOverride") {
        overrideLevel = integerOf(attribute(attributes, "ilvl"));
      } else if (num && overrideLevel !== undefined && name === "w:startOverride") {
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
 * shared by the lists made from one definition, restarted by a list that says where to start, and
 * the deeper levels started again when a level counts up.
 */
export class WordNumbering {
  private readonly styles: Map<string, StyleInfo>;
  private readonly abstracts: Map<string, Level[]>;
  private readonly nums: Map<string, { abstractId: string; starts: Map<number, number> }>;
  /** The counts of each list definition, by level: undefined for a level not counted since it was last started again. */
  private readonly counts = new Map<string, Array<number | undefined>>();
  /** Lists whose start override has been applied. */
  private readonly started = new Set<string>();

  constructor(stylesXml: string | undefined, numberingXml: string | undefined) {
    this.styles = readStyles(stylesXml);
    ({ abstracts: this.abstracts, nums: this.nums } = readNumbering(numberingXml));
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
   * The level of a heading, 1 to 6, for a paragraph of a heading style ("heading 2", or a style
   * whose name Word gives in English even in a Hebrew document), of the title style, or with an
   * outline level. Undefined for body text.
   */
  headingLevel(paragraph: ParagraphStyle): number | undefined {
    let outline = paragraph.outlineLevel;
    for (const style of this.chain(paragraph.styleId)) {
      const named = /^heading (\d)$/.exec(style.name);
      if (named) return Math.min(6, Math.max(1, Number(named[1])));
      if (style.name === "title") return 1;
      outline ??= style.outlineLevel;
    }
    return outline !== undefined && outline >= 0 && outline < 6 ? outline + 1 : undefined;
  }

  /** The number Word writes before the paragraph ("2.1.", "(a)", "-" for a bullet), or undefined. */
  label(paragraph: ParagraphStyle): string | undefined {
    let numId = paragraph.numId;
    let ilvl = paragraph.ilvl;
    for (const style of this.chain(paragraph.styleId)) {
      numId ??= style.numId;
      ilvl ??= style.ilvl;
    }
    if (numId === undefined || numId === "0") return undefined;
    const num = this.nums.get(numId);
    const levels = num ? this.abstracts.get(num.abstractId) : undefined;
    if (!num || !levels) return undefined;
    const level = Math.min(LEVELS - 1, Math.max(0, ilvl ?? 0));
    const definition = levels[level];
    if (!definition) return undefined;
    let counts = this.counts.get(num.abstractId);
    if (!counts) {
      counts = new Array<number | undefined>(LEVELS).fill(undefined);
      this.counts.set(num.abstractId, counts);
    }
    if (!this.started.has(numId)) {
      this.started.add(numId);
      for (const [overridden, start] of num.starts) if (overridden >= 0 && overridden < LEVELS) counts[overridden] = start - 1;
    }
    const count = counts[level];
    counts[level] = count === undefined ? definition.start : count + 1;
    for (let deeper = level + 1; deeper < LEVELS; deeper++) counts[deeper] = undefined;
    if (definition.format === "bullet") return "-";
    const text = definition.text.replace(/%([1-9])/g, (_, digit: string) => {
      const index = Number(digit) - 1;
      const own = levels[index];
      const value = counts[index] ?? own?.start ?? 1;
      return formatNumber(value, own?.format ?? "decimal");
    });
    if (PRIVATE_USE.test(text)) return "-";
    return text.trim() || undefined;
  }
}
