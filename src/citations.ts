// The line citations of an answer, checked against what the tools showed the model. New in 0.10.0.
import { mergeRanges, type Evidence, type NumberRange } from "./evidence.js";
import type { DocumentFormat } from "./types.js";

/** What `checkCitations` found in an answer (`AskResult.citations`). New in 0.10.0. */
export type CitationCheck = {
  /** Citations matched to a file and a line. */
  checked: number;
  /** Of those, the ones inside what the tools showed. A file sent whole counts as shown. */
  supported: number;
  /** Citations recognized but not matched: no file name when there are several files, or the row of a workbook. */
  unchecked: number;
  /** The citations of lines the tools did not show: the document's name, and the line. */
  unsupported: Array<{ document: string; line: number }>;
};

/** A citation found in the text: where it is, the lines it names, and whether it names lines or rows. */
type Cited = { start: number; end: number; from: number; to: number; form: "line" | "row"; bare: boolean };

/** Where a file name is written in the text (`from` with its prefix letter, `start` without), and the documents of that name. */
type Named = { from: number; start: number; end: number; ids: string[] };

/**
 * Hebrew points and cantillation marks, which a word may carry ("שׁוּרָה"). Not the maqaf (־), the
 * paseq, the sof pasuq or the nun hafukha, which are punctuation.
 */
const POINTS = /[֑-ׇֽֿׁׂׅׄ]/gu;
/** Marks that set the direction of text and show nothing: LRM, RLM, the embeddings and overrides, the isolates, the Arabic letter mark. */
const DIRECTION_MARKS = /[؜‎‏‪-‮⁦-⁩]/gu;
/** A text without the marks a model may put in Hebrew or mixed text: what is left is read as a person reads it. */
const plain = (text: string) => text.replace(POINTS, "").replace(DIRECTION_MARKS, "");

/** Not a letter, a digit or "_" before or after: the edge of a word, in any script. */
const EDGE_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const EDGE_AFTER = String.raw`(?![\p{L}\p{N}_])`;
/** The second number of a range: "12-14", "12–14", "12־14" (a maqaf), "12 to 14", "12 עד 14". */
const RANGE_END = String.raw`(?:\s*[-–—־]\s*|\s+(?:to|עד)\s+)`;
/** "L" or "l", and a space at most, before a line number: "L12", "l12", "L 12". */
const LINE_LETTER = String.raw`[Ll][  ]?`;
/**
 * A line number: digits, or digits in groups of three after commas ("1,200", "12,345,678"), as a
 * model writes a large number. "L12,14" is line 12, then something else: a group has three digits.
 */
const NUMBER = String.raw`(\d{1,3}(?:,\d{3}){1,2}|\d{1,9})`;
/** The value of a line number as `NUMBER` reads it: its commas left out. */
const numberOf = (written: string) => Number(written.replaceAll(",", ""));

/**
 * The forms of a citation, each with the numbers it names:
 * - "L12", "L12-14", "L12-L14", "L 12", "l12", "L1,200": lines, as the tools and the closing request write them;
 * - "line 12", "lines 12-14": lines, in words;
 * - "Row 12": a row, which for a workbook may be Excel's row and not a line;
 * - "שורה 12", "שורות 12-14", with a prefix letter ("בשורה 12") or "מס'": in Hebrew "שורה" is
 *   both a line and a row.
 */
const FORMS: Array<{ pattern: RegExp; form: "line" | "row"; bare: boolean }> = [
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}${LINE_LETTER}${NUMBER}(?:${RANGE_END}(?:${LINE_LETTER})?${NUMBER})?${EDGE_AFTER}`, "gu"), form: "line", bare: true },
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}[Ll]ines?\s+${NUMBER}(?:${RANGE_END}${NUMBER})?${EDGE_AFTER}`, "gu"), form: "line", bare: false },
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}[Rr]ows?\s+${NUMBER}(?:${RANGE_END}${NUMBER})?${EDGE_AFTER}`, "gu"), form: "row", bare: false },
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}[בלמוהכש]{0,2}שור(?:ה|ות)\s+(?:(?:מס['׳]?|מספר)\s*)?${NUMBER}(?:${RANGE_END}${NUMBER})?${EDGE_AFTER}`, "gu"), form: "row", bare: false },
];

/** How far, in characters on one line, a file name may be from the citation it goes with. */
const NAME_DISTANCE = 40;
/**
 * What ends a clause between a citation and a name: a comma, a semicolon, the end of a sentence, or
 * "and" ("ו" in Hebrew, alone or with a hyphen). A name across one is farther than its characters say.
 */
const CLAUSE_BREAK = /[,;.!?]|(?<!\p{L})(?:and|ו)(?!\p{L})/iu;
/**
 * What may stand between a citation and a name after it that it belongs to: "of", "in", "from",
 * "בקובץ", "של" and the like, or only a space when the name carries the prefix letter "ב" or "מ"
 * ("שורה 40 בחשבוניות.csv").
 */
const INTRODUCED = /^\s*(?:of|in|from|בקובץ|מקובץ|בגיליון|של)\s*$/iu;
/** A name followed by a comma or a colon and then the citation: "app.log, line 97", "חוזה.docx: שורה 12". */
const LISTED = /^\s*[,:]\s*$/u;

/** A text for a regular expression that matches it as it is. */
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The index of the first item of `items`, in order of `key`, whose key is `value` or more: `items.length` when none is. */
function firstFrom<T>(items: T[], key: (item: T) => number, value: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (key(items[middle]!) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Every citation of `text`, in order. One place in the text is one citation, of the first form that
 * reads it. The matches of each form come in order, so each is checked only against the citations
 * already kept around it.
 */
function citationsIn(text: string): Cited[] {
  let kept: Cited[] = [];
  for (const { pattern, form, bare } of FORMS) {
    const added: Cited[] = [];
    // The first citation kept that ends after the start of the match: the only one it may overlap first.
    let next = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      while (next < kept.length && kept[next]!.end <= start) next++;
      if (next < kept.length && kept[next]!.start < end) continue;
      const first = numberOf(match[1]!);
      const second = match[2] === undefined ? first : numberOf(match[2]);
      if (first < 1 || second < 1) continue;
      added.push({ start, end, from: Math.min(first, second), to: Math.max(first, second), form, bare });
    }
    // The two lists, each in order and apart from the other, made one.
    const merged: Cited[] = [];
    let left = 0;
    let right = 0;
    while (left < kept.length || right < added.length) {
      if (right >= added.length || (left < kept.length && kept[left]!.start < added[right]!.start)) merged.push(kept[left++]!);
      else merged.push(added[right++]!);
    }
    kept = merged;
  }
  return kept;
}

/**
 * Where the documents' names are written in `text`: each name whole, and without its extension
 * when what is left has 3 characters or more ("report" for "report.docx"). A Hebrew prefix letter
 * may come before it ("בדוח.docx"). Where two overlap, the longer one is taken. In order.
 */
function namesIn(text: string, names: Map<string, string[]>): Named[] {
  const aliases = new Map<string, Set<string>>();
  const alias = (name: string, ids: string[]) => {
    const key = name.toLocaleLowerCase();
    const known = aliases.get(key) ?? new Set<string>();
    for (const id of ids) known.add(id);
    aliases.set(key, known);
  };
  for (const [written, ids] of names) {
    const name = plain(written);
    if (!name.trim()) continue;
    alias(name, ids);
    const dot = name.lastIndexOf(".");
    if (dot >= 3) alias(name.slice(0, dot), ids);
  }
  const hits: Named[] = [];
  for (const [name, ids] of aliases) {
    const pattern = new RegExp(String.raw`${EDGE_BEFORE}(?:[בלמוהכש]{1,2}[-־]?)?(${escaped(name)})${EDGE_AFTER}`, "giud");
    for (const match of text.matchAll(pattern)) {
      const [start, end] = match.indices![1]!;
      hits.push({ from: match.index, start, end, ids: [...ids] });
    }
  }
  hits.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
  const kept: Named[] = [];
  for (const hit of hits) {
    const last = kept.at(-1);
    if (last && hit.start < last.end) continue;
    kept.push(hit);
  }
  return kept;
}

/**
 * A function that gives the parentheses around a place of `text`, on its line: their start and
 * end, or undefined when it is not inside any. The parentheses and line breaks are found once.
 */
function parenthesesOf(text: string): (start: number, end: number) => [number, number] | undefined {
  const marks: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x28 || code === 0x29 || code === 0x0a) marks.push(index);
  }
  return (start, end) => {
    // The mark nearest before the place must open parentheses; the nearest after it must close them.
    const before = firstFrom(marks, (mark) => mark, start) - 1;
    if (before < 0 || text[marks[before]!] !== "(") return undefined;
    const after = firstFrom(marks, (mark) => mark, end);
    return after < marks.length && text[marks[after]!] === ")" ? [marks[before]!, marks[after]! + 1] : undefined;
  };
}

/** True when nothing between `from` and `to` breaks the line, and they are close enough. */
const near = (text: string, from: number, to: number) => to - from <= NAME_DISTANCE && !text.slice(from, to).includes("\n");

/**
 * How far a name is from a citation, in characters, with `NAME_DISTANCE` more when a clause ends
 * between them (`broken`, or a break in what is between). A long gap is not read: it is far.
 */
function distance(text: string, from: number, to: number, broken: boolean): number {
  if (to - from > 2 * NAME_DISTANCE) return to - from + NAME_DISTANCE;
  return to - from + (broken || CLAUSE_BREAK.test(text.slice(from, to)) ? NAME_DISTANCE : 0);
}

/**
 * The nearer of the name before a citation and the name after it. A name after it introduced as
 * its own ("of x", "בקובץ x", "בx") is its name. A name before it followed by only a comma or a
 * colon ("x, line 97") is as near as its characters say. Otherwise a citation that opens with "ו"
 * ("ושורה 40") starts a clause of its own, and so does a name after it that opens with "ו". When
 * both are as near, the name before.
 */
function nearer(text: string, cited: Cited, before: Named | undefined, after: Named | undefined): Named | undefined {
  if (!before || !after) return before ?? after;
  const ahead = text.slice(cited.end, after.from);
  // "line 40 of x", "שורה 40 בקובץ x", "שורה 40 בx": the name after is introduced as the citation's.
  if (INTRODUCED.test(ahead) || (/^\s*$/u.test(ahead) && after.from < after.start && (text[after.from] === "ב" || text[after.from] === "מ"))) return after;
  // "x, line 97" and "x: שורה 12": the comma gives the citation to the name before, no clause.
  const back = LISTED.test(text.slice(before.end, cited.start)) ? cited.start - before.end : distance(text, before.end, cited.start, text[cited.start] === "ו");
  const far = distance(text, cited.end, after.from, after.from < after.start && text[after.from] === "ו");
  return far < back ? after : before;
}

/**
 * The name a citation goes with: one inside the same parentheses, else one on its line within
 * `NAME_DISTANCE` characters; of the name before it and the name after it, the nearer.
 */
function nameOf(text: string, cited: Cited, named: Named[], around: [number, number] | undefined): Named | undefined {
  // The names are in order and apart, so their ends are in order too.
  const following = firstFrom(named, (hit) => hit.start, cited.end);
  const before = named[firstFrom(named, (hit) => hit.end, cited.start + 1) - 1];
  const after = named[following];
  if (around) {
    const inside = nearer(text, cited, before && before.start >= around[0] ? before : undefined, after && after.end <= around[1] ? after : undefined);
    if (inside) return inside;
  }
  return nearer(text, cited, before && near(text, before.end, cited.start) ? before : undefined, after && near(text, cited.end, after.from) ? after : undefined);
}

/**
 * The first line of `from`-`to` that `shown` does not hold, or undefined when it holds them all.
 * `shown` is in order, its ranges apart and not touching (`mergeRanges`).
 */
function firstNotShown(shown: NumberRange[] | "whole", from: number, to: number): number | undefined {
  if (shown === "whole") return undefined;
  // The range that holds `from`, if any: the last one that starts at or before it.
  const holding = shown[firstFrom(shown, (range) => range[0], from + 1) - 1];
  if (!holding || holding[1] < from) return from;
  return holding[1] >= to ? undefined : holding[1] + 1;
}

/**
 * Finds the line citations of `text` ("(name L12)", "(name L12-14)", "name L12", "line 12", "Row
 * 12", and the Hebrew "שורה 12" and "שורות 12-14") and checks them against `evidence`. `names`
 * gives each document ID's file name, and `formats` its format. Hebrew points and marks of
 * direction in the text are not read.
 *
 * A citation goes with the file name next to it: in the same parentheses, or on the same line
 * within 40 characters. A name after it introduced as its own ("line 40 of x", "בשורה 40 בקובץ
 * x", "שורה 40 בx") is its name. Else, of the name before it and the name after it, the nearer
 * one, where a comma, a semicolon, the end of a sentence or "and" ("ו") between them counts as far,
 * except a comma or colon right after the name before ("x, line 97"). With one file it may have none. A bare "L12"
 * with no name next to it counts only inside parentheses ("(L12)"): "L2 cache" is no citation. A
 * citation is supported when every line it names was shown, by the lines of an evidence entry of
 * that document. An entry with `whole` (a file read whole, or sent whole) and no lines shows every
 * line; one with lines (`[[1, lines]]`) shows those, so a line past the end of the file is not
 * supported. Two documents of one name support it by either. A row ("Row 12", "שורה 12") of a
 * workbook (XLSX) is unchecked: it may be Excel's row, which is not the line. New in 0.10.0.
 */
export function checkCitations(text: string, evidence: Evidence[], names: Record<string, string>, formats?: Record<string, DocumentFormat>): CitationCheck {
  const check: CitationCheck = { checked: 0, supported: 0, unchecked: 0, unsupported: [] };
  if (typeof text !== "string" || !text) return check;
  const read = plain(text);
  // The name of each document: the one given, else the one its evidence says.
  const nameById = new Map<string, string>(Object.entries(names ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  for (const entry of evidence) if (typeof entry.document === "string" && !nameById.has(entry.documentId)) nameById.set(entry.documentId, entry.document);
  const byName = new Map<string, string[]>();
  for (const [id, name] of nameById) byName.set(name, [...byName.get(name) ?? [], id]);
  // What was shown of each document: its lines, or all of it.
  const shown = new Map<string, NumberRange[] | "whole">();
  for (const entry of evidence) {
    const before = shown.get(entry.documentId);
    if (before === "whole") continue;
    if (entry.whole === true && !Array.isArray(entry.lines)) shown.set(entry.documentId, "whole");
    else if (entry.lines?.length) shown.set(entry.documentId, mergeRanges([...before ?? [], ...entry.lines]));
  }
  const only = nameById.size === 1 ? [...nameById.keys()] : undefined;
  const named = namesIn(read, byName);
  const parentheses = parenthesesOf(read);
  for (const cited of citationsIn(read)) {
    // A part of a file name ("report-L3.docx") is not a citation.
    const overlapping = named[firstFrom(named, (hit) => hit.end, cited.start + 1)];
    if (overlapping && overlapping.start < cited.end) continue;
    const around = parentheses(cited.start, cited.end);
    const hit = nameOf(read, cited, named, around);
    if (!hit && cited.bare && !around) continue;
    const ids = hit?.ids ?? only;
    // A row of a workbook may be Excel's row: there is no line to check it against.
    const lined = ids?.filter((id) => cited.form === "line" || formats?.[id] !== "xlsx");
    if (!lined?.length) {
      check.unchecked++;
      continue;
    }
    check.checked++;
    const missing = lined.map((id) => firstNotShown(shown.get(id) ?? [], cited.from, cited.to));
    if (missing.some((line) => line === undefined)) check.supported++;
    else check.unsupported.push({ document: nameById.get(lined[0]!) ?? lined[0]!, line: missing[0]! });
  }
  return check;
}
