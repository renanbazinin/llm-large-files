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
  /**
   * Every citation read, in the order of the answer, the unchecked ones too: for a list of sources
   * beside the answer, or when the answer is shown without them (`AskOptions.showCitations`).
   * `checkCitations` always gives it; optional so that a `CitationCheck` made by hand still
   * compiles. New in 0.99.12.
   */
  cited?: LineCitation[];
};

/** A citation of an answer, as `checkCitations` read it (`CitationCheck.cited`). New in 0.99.12. */
export type LineCitation = {
  /** The file name it goes with, as the question names the file. None when no name was found and the question has several files. */
  document?: string;
  /** The ID of that file. When two files of the question have the name, the one that shows the lines, else the first. */
  documentId?: string;
  /** The first and last line it names ("L12-14": 12 and 14; "L12": 12 and 12). */
  from: number;
  to: number;
  /** "line" ("L12", "line 12"), or "row" ("Row 12", and the Hebrew "שורה 12", which is both). */
  form: "line" | "row";
  /**
   * "supported": the tools showed every line it names (a file sent whole shows all of its lines);
   * "unsupported": they did not; "unchecked": no file was found for it, or it names a row of a workbook.
   */
  status: "supported" | "unsupported" | "unchecked";
};

/** A citation found in the text: where it is, the lines it names, and whether it names lines or rows. */
type Cited = { start: number; end: number; from: number; to: number; form: "line" | "row"; bare: boolean; kind: number; written?: string };

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
  for (const [kind, { pattern, form, bare }] of FORMS.entries()) {
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
      added.push({ start, end, from: Math.min(first, second), to: Math.max(first, second), form, bare, kind, written: match[0] });
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

/** The patterns of the names of one map of names (`namesIn`), made once for it: a hider reads its names at every character it holds. */
const NAME_PATTERNS = new WeakMap<Map<string, string[]>, Array<{ ids: string[]; pattern: RegExp }>>();
function namePatterns(names: Map<string, string[]>): Array<{ ids: string[]; pattern: RegExp }> {
  const known = NAME_PATTERNS.get(names);
  if (known) return known;
  const aliases = new Map<string, Set<string>>();
  const alias = (name: string, ids: string[]) => {
    const key = name.toLocaleLowerCase();
    const seen = aliases.get(key) ?? new Set<string>();
    for (const id of ids) seen.add(id);
    aliases.set(key, seen);
  };
  for (const [written, ids] of names) {
    const name = plain(written);
    if (!name.trim()) continue;
    alias(name, ids);
    const dot = name.lastIndexOf(".");
    if (dot >= 3) alias(name.slice(0, dot), ids);
  }
  const list = [...aliases].map(([name, ids]) => ({ ids: [...ids], pattern: new RegExp(String.raw`${EDGE_BEFORE}(?:[בלמוהכש]{1,2}[-־]?)?(${escaped(name)})${EDGE_AFTER}`, "giud") }));
  NAME_PATTERNS.set(names, list);
  return list;
}

/**
 * Where the documents' names are written in `text`: each name whole, and without its extension
 * when what is left has 3 characters or more ("report" for "report.docx"). A Hebrew prefix letter
 * may come before it ("בדוח.docx"). Where two overlap, the longer one is taken. In order.
 */
function namesIn(text: string, names: Map<string, string[]>): Named[] {
  const hits: Named[] = [];
  for (const { ids, pattern } of namePatterns(names)) {
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

/** A citation as `checkCitations` reads it, with the documents its name rule gives it. */
type Attributed = Cited & { ids?: string[] };

/**
 * The citations of `read` (a text without Hebrew points and direction marks, `plain`) that
 * `checkCitations` counts, in order, each with the IDs of the file named next to it (`nameById`
 * gives each ID's name), or the one document when there is one and none is named.
 */
function attributed(read: string, nameById: Map<string, string>): Attributed[] {
  const byName = new Map<string, string[]>();
  for (const [id, name] of nameById) byName.set(name, [...byName.get(name) ?? [], id]);
  const only = nameById.size === 1 ? [...nameById.keys()] : undefined;
  const named = namesIn(read, byName);
  const parentheses = parenthesesOf(read);
  const found: Attributed[] = [];
  for (const one of citationsIn(read)) {
    // A part of a file name ("report-L3.docx") is not a citation.
    const overlapping = named[firstFrom(named, (hit) => hit.end, one.start + 1)];
    if (overlapping && overlapping.start < one.end) continue;
    const around = parentheses(one.start, one.end);
    const hit = nameOf(read, one, named, around);
    if (!hit && one.bare && !around) continue;
    const ids = hit?.ids ?? only;
    found.push(ids ? { ...one, ids } : one);
  }
  return found;
}

/** A citation of an answer with where it is written and the documents it goes with (`attributedCitations`). New in 0.99.14. */
export type AttributedCitation = {
  /** Where it is written in the text given, in UTF-16 units: from its first character to after its last. */
  start: number;
  end: number;
  /** The lines it names, and its form, as `LineCitation` has them. */
  from: number;
  to: number;
  form: "line" | "row";
  /** The IDs of the file it goes with, by `checkCitations`' rule (two files of one name: both). None when no file was found for it. */
  ids?: string[];
};

/**
 * Every citation `checkCitations` reads in `text`, in order, with its place in `text` (Hebrew points
 * and direction marks included, as written) and the IDs of the file `checkCitations`' name rule gives
 * it. `names` gives each document ID's file name. `formats` is taken for the shape of
 * `checkCitations` and changes nothing: a row of a workbook is listed like any citation. For a list
 * of sources made apart from `AskResult.sources`. New in 0.99.14.
 */
export function attributedCitations(text: string, names: Record<string, string>, _formats?: Record<string, DocumentFormat>): AttributedCitation[] {
  if (typeof text !== "string" || !text) return [];
  // Where each unit of the plain text was in `text`: the marks it drops are one unit each.
  const origin: number[] = [];
  let read = "";
  for (let index = 0; index < text.length; index++) {
    const unit = text[index]!;
    if (plain(unit) === "") continue;
    origin.push(index);
    read += unit;
  }
  const nameById = new Map<string, string>(Object.entries(names ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return attributed(read, nameById).map((one) => ({
    start: origin[one.start]!,
    end: origin[one.end - 1]! + 1,
    from: one.from,
    to: one.to,
    form: one.form,
    ...(one.ids ? { ids: [...one.ids] } : {}),
  }));
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
 * workbook (XLSX) is unchecked: it may be Excel's row, which is not the line. Every citation read
 * is listed in `cited`, in order, with what was found of it (since 0.99.12). New in 0.10.0.
 */
export function checkCitations(text: string, evidence: Evidence[], names: Record<string, string>, formats?: Record<string, DocumentFormat>): CitationCheck {
  const cited: LineCitation[] = [];
  const check: CitationCheck = { checked: 0, supported: 0, unchecked: 0, unsupported: [], cited };
  if (typeof text !== "string" || !text) return check;
  // The name of each document: the one given, else the one its evidence says.
  const nameById = new Map<string, string>(Object.entries(names ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  for (const entry of evidence) if (typeof entry.document === "string" && !nameById.has(entry.documentId)) nameById.set(entry.documentId, entry.document);
  // What was shown of each document: its lines, or all of it.
  const shown = new Map<string, NumberRange[] | "whole">();
  for (const entry of evidence) {
    const before = shown.get(entry.documentId);
    if (before === "whole") continue;
    if (entry.whole === true && !Array.isArray(entry.lines)) shown.set(entry.documentId, "whole");
    else if (entry.lines?.length) shown.set(entry.documentId, mergeRanges([...before ?? [], ...entry.lines]));
  }
  for (const one of attributed(plain(text), nameById)) {
    const ids = one.ids;
    const lines = { from: one.from, to: one.to, form: one.form };
    // A row of a workbook may be Excel's row: there is no line to check it against.
    const lined = ids?.filter((id) => one.form === "line" || formats?.[id] !== "xlsx");
    if (!lined?.length) {
      check.unchecked++;
      const id = ids?.[0];
      cited.push({ ...(id !== undefined ? { document: nameById.get(id) ?? id, documentId: id } : {}), ...lines, status: "unchecked" });
      continue;
    }
    check.checked++;
    const missing = lined.map((id) => firstNotShown(shown.get(id) ?? [], one.from, one.to));
    const showing = missing.findIndex((line) => line === undefined);
    const id = lined[Math.max(0, showing)]!;
    cited.push({ document: nameById.get(id) ?? id, documentId: id, ...lines, status: showing >= 0 ? "supported" : "unsupported" });
    if (showing >= 0) check.supported++;
    else check.unsupported.push({ document: nameById.get(lined[0]!) ?? lined[0]!, line: missing[0]! });
  }
  return check;
}


// ---------------------------------------------------------------------------------------------
// CitationHider: takes the citations out of an answer as it is written (0.99.12), with the rules of
// 0.99.14 (CIT-4): more forms, a citation the answer needs put into words, and a record of each.

/** The most characters of a parenthesis that the 0.99.12 rules hold back to see whether it is a citation. */
const MOST_HELD = 200;
/** The most characters a hold of the 0.99.14 rules keeps: a parenthesis, a tail or a lead-in sentence that may still be a run of citations. */
const MOST_HELD_RUN = 2_000;
/** A page named beside the lines: "p. 3", "pp. 3-4", "page 3", "עמ' 3", "עמוד 3". */
const PAGE = String.raw`(?:pp?\.|pages?|עמ['׳]|עמודים|עמוד)\s*\d+(?:${RANGE_END}\d+)?`;
/** A file name with no space in it and a known extension, named in a citation but not one of the question's files. */
const FILE_NAME = new RegExp(String.raw`${EDGE_BEFORE}[\p{L}\p{N}_][\p{L}\p{N}_.\-]*\.(?:pdf|docx?|xlsx?|csv|tsv|txt|md|log|json|html?|pptx?)${EDGE_AFTER}`, "giu");
/** Separators, quotes, backticks and emphasis: what may stand between citations. */
const FILLER_CHARS = String.raw`[\s,;:&/.\-–—־\x60"'״׳“”‘’*_]`;
/** The words of 0.99.12 that may stand between citations: "and", "see", the words for a line or a row ("(שורות L1–L306)"). */
const FILLER_WORDS = String.raw`and|see|cf|ראו|ראה|ו|lines?|rows?|[בלמוהכש]{0,2}שור(?:ה|ות)`;
/**
 * What may stand in a parenthesis of citations besides them and file names, by the 0.99.12 rules:
 * separators, quotes, backticks and emphasis around a name, "and", "see", the words for a line or a
 * row, and pages.
 */
const FILLER = new RegExp(String.raw`^(?:${FILLER_CHARS}|${EDGE_BEFORE}(?:${FILLER_WORDS})${EDGE_AFTER}|${PAGE})*$`, "iu");
/** Horizontal white space, which a citation takes with it. */
const SPACE = /^[ \t  ]$/u;
/** A conjunction right after a citation run first in a parenthesis, with its space: "או ", "or ", "and ", "ו ", or the "ו" of "וגם". */
const JOINING = /^(?:(?:או|or|and|ו[-־]?)(?=[ \t\u00a0\u202f])[ \t\u00a0\u202f]+|ו(?=גם(?![\p{L}\p{N}_])))/iu;
/** A list marker at the start of a line, once it is whole: "-", "+", "*", "1." or "1)". */
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])$/;
/** What may stand in a parenthesis of document IDs besides them: separators, quotes, backticks, emphasis and "and". */
const ID_FILLER = new RegExp(String.raw`^(?:[\s,;&/\x60"'״׳“”‘’*_]|${EDGE_BEFORE}(?:and|ו)${EDGE_AFTER})*$`, "iu");
/** The fields of a tool result that hold no text of a file: the outline's "L12 Title" labels, the hint on how to cite, notes, errors and document IDs. */
const NOT_FILE_TEXT = /^(?:outline|cite|error|document_id|documentId)$|note$/;

/** The Hebrew letters that may be prefixed to a word: ב, ל, מ, ו, ה, כ, ש. */
const HE_PREFIX = "[בלמוהכש]";
/** Lead-in words a citation run may hold inside its own brackets: "(מקור: x L4)", "(found in x L4)". */
const LEAD_WORDS = [
  "source", "sources", "data", "reference", "references", "ref", "citation", "citations", "found", "located", "listed",
  "in", "at", "on", "from", "per", "according", "to", "based", "for", "example", "e\\.g", "eg", "i\\.e", "as", "shown",
  "noted", "stated", "described", "cited", "also", "the", "of", "a", "an",
].join("|");
const LEAD_WORDS_HE = [
  "מקור", "מקורות", "נתונים", "ראו", "ראה", "למשל", "לדוגמה", "לדוגמא", "כגון", "כמפורט", "כמצוין", "כמופיע", "לפי", "על", "פי",
  "בהתאם", "מתוך", "השוו", "עיינו", "מופיע", "מופיעה", "נמצא", "נמצאת", "ר'",
].join("|");
/** Range and list words: "(החל משורה 17280 ועד שורה 25680)", "(L4, L9, etc.)". */
const RANGE_WORDS = "to|through|until|between|from|and|or|etc|וכו['׳]?|ועוד|או";
const RANGE_WORDS_HE = "עד|החל|בין";
/** Words for the file itself, standing where a file name would: "(בשורה 17280 בלוג)", "(שורה 3 בגיליון)". */
const FILE_WORDS = "file|sheet|log|document|spreadsheet|workbook|קובץ|גיליון|לוג|מסמך|דוח|טבלת הנתונים";
/** "שורה מס' 8": the number word, as in the citation form itself. */
const NUMBER_WORDS = "מס['׳]?|מספר|no\\.?|nos\\.?";
/** What may stand in a run of citations besides them, names and list numbers, by the 0.99.14 rules. */
const RUN_FILLER = new RegExp(String.raw`^(?:${FILLER_CHARS}|[…]|${EDGE_BEFORE}(?:${FILLER_WORDS}|${LEAD_WORDS}|${RANGE_WORDS}|${NUMBER_WORDS})${EDGE_AFTER}|${EDGE_BEFORE}${HE_PREFIX}{0,2}(?:${LEAD_WORDS_HE}|${RANGE_WORDS_HE}|${FILE_WORDS})${EDGE_AFTER}|${EDGE_BEFORE}${HE_PREFIX}{1,2}(?=[-־"'“”״\x60])|${PAGE})*$`, "iu");
/** A bare number that continues a list of citations: "שורות 12, 15 ו-18", "L4, 9, 12". */
const LIST_NUMBER = new RegExp(String.raw`${EDGE_BEFORE}${NUMBER}(?:\s*[-–—־]\s*${NUMBER})?${EDGE_AFTER}`, "gu");
/** What may stand between two entries of a list: ", ", " ו-", " and ", " & ". */
const LIST_SEP = /^\s*(?:[,،;&]\s*)?(?:(?:and|or|ו|או)\s*)?[-־]?\s*$/iu;
/** The start of a lead-in sentence, removed whole with its run: "Data source: x L4.", "מקור: x שורה 4." */
const LEAD_SENTENCES = [
  "data source:", "data sources:", "source:", "sources:", "reference:", "references:", "citation:", "citations:", "see:", "see ",
  "cf. ", "מקור:", "מקורות:", "המקור:", "מקור הנתונים:", "מקורות המידע:", "ראו:", "ראו ", "ראה:", "ראה ",
];
/** A location word right before a citation makes the answer need it: "ראו (L4)", "למשל: (L7)", "found in (L4)". */
const LOCATION_WORD_END = /(?<![\p{L}\p{N}_])(?:נמצא|נמצאת|נמצאים|נמצאות|מופיע|מופיעה|מופיעים|מופיעות|ראו|ראה|למשל|לדוגמה|לדוגמא|כגון|לפי|על\s+פי|in|at|on|see|found\s+in|located\s+in|listed\s+in|e\.g\.,?|for\s+example,?|such\s+as)[\s*_"'“”״]*$/iu;
/**
 * A location verb whose place has no number yet makes the answer need the citation: "דני כהן נמצא
 * בגיליון לקוחות (שורה 8)". "מופיע בסעיף 63 (L65)" already names the place, and its citation goes.
 */
const LOCATION_VERB_CLAUSE = /(?<![\p{L}])(?:נמצא|נמצאת|נמצאים|נמצאות|מופיע|מופיעה|מופיעים|מופיעות|רשום|רשומה|located|found|appears|listed)(?:\s+[^\s\d,;.:!?()[\]|]+){1,4}[\s*_]*$/iu;
/** The common shape of a run, read at once: "L3, L4, L5-L9, 12", with a number or an "L" still being written. */
const FAST_RUN = /^[Ll]\d{1,9}(?:[-–—־][Ll]?\d{0,9})?(?:[ \t]*[,;][ \t]*(?:[Ll]\d{0,9}(?:[-–—־][Ll]?\d{0,9})?|\d{1,9}(?:[-–—־]\d{0,9})?)?)*[ \t]*$/u;
/** A word that names a place in a file: a sheet, a page, a clause, a slide. */
const PLACE_NOUN = /(?<![\p{L}])[בלמוהכש]{0,2}(?:גיליון|גליון|עמוד|סעיף|שקופית|פרק|טבלה|sheet|page|section|clause|slide|chapter|tab)(?![\p{L}])/iu;
/** The word before the second end of a range: "משורה 3 ועד (L7)". */
const RANGE_END_WORD = /(?<![\p{L}\p{N}_])(?:ו?עד|until|through|to)[\s*_"'“”״]*$/iu;
/** A word for a place right before a citation: "בשורה (L10)". */
const PLACE_NOUN_END = /(?<![\p{L}])[בלמוהכש]{0,2}(?:שורה|שורות|עמוד|שקופית|סעיף|line|lines|row|rows|page|slide|clause)[\s*_"'“”״]*$/iu;
/** The words of a place, cut from the start of the words a citation is put in when a place word stands before it. */
const PLACE_WORDS_START = /^(?:שורה|שורות|עמוד|עמודים|שקופית|שקופיות|סעיף|סעיפים|lines?|rows?|pages?|slides?|clauses?)\s+/iu;
/** The brackets a run may be written in, by the 0.99.14 rules, with what closes each. */
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "【": "】", "［": "］", "（": "）" };
/** Brackets that, followed by "(" or ":", make a link or a reference: "[x L4](url)", "[x L4]: url". */
const LINKABLE = new Set(["[", "［"]);
/** What may start the run of citations at the end of a parenthesis: "(סעיף 3.5, שורה 31)". */
const TAIL_SEPARATORS = new Set([",", ";", "–", "—", "،"]);
const HEBREW = /[א-ת]/u;
const ID_CHAR = /[\p{L}\p{N}_\-]/u;
/** The first word of a parenthesis that may still be a file name outside the question: Latin letters, digits, "_" and "-". */
const FIRST_WORD = /^[A-Za-z0-9_\-]+$/;
/** The words of a run, for the hold: a word still being written must start one of them. */
const VOCABULARY = [
  "and", "see", "cf", "line", "lines", "row", "rows", "etc", "page", "pages", "p.", "pp.", "no.", "nos.", "e.g.", "i.e.",
  ...LEAD_WORDS.split("|"), ...RANGE_WORDS.split("|"), ...FILE_WORDS.split("|"),
].map((one) => one.replace(/\\/g, "").toLocaleLowerCase());
const VOCABULARY_HE = ["שורה", "שורות", "ראו", "ראה", "עמ'", "עמוד", "עמודים", "מס'", "מספר", "וכו'", "ועוד", "או", ...LEAD_WORDS_HE.split("|"), ...RANGE_WORDS_HE.split("|"), ...FILE_WORDS.split("|")];
const PAGE_ANY = new RegExp(String.raw`${EDGE_BEFORE}${PAGE}`, "giu");
/** A page word at the end of a hold, its number still to come: "p. ", "page ", "עמ' ". */
const PAGE_WORD_END = new RegExp(String.raw`${EDGE_BEFORE}(?:pp?\.|pages?|עמ['׳]|עמודים|עמוד)\s*$`, "iu");
const PREFIX_LETTERS_END = new RegExp(`(?<![\\p{L}\\p{N}_])${HE_PREFIX}{1,2}$`, "u");
const PREFIX_LETTERS_START = new RegExp(`^${HE_PREFIX}{1,2}[-־]?`, "u");
/** A direction mark, which may stand between a prefix hyphen and a parenthesis ("ב-‏("). */
const DIRECTION_MARK = /^[؜‎‏‪-‮⁦-⁩]$/u;
/** A line's own markers, which the library writes and the file does not: "12| ", "Row 7: ". */
const LIBRARY_LINE = /^(?:\d{1,9}\|[ \t]?)?(?:Row \d{1,9}:[ \t]?)?/;
/** A line the library writes whole: a sheet or slide heading, a page marker. */
const LIBRARY_HEADING = /^(?:\d{1,9}\|[ \t]?)?(?:## (?:Sheet|Slide) \d{1,9}\b.*|--- Page \d{1,9} ---)$/;

/** `text` without the markers the library writes on its lines (ROW-PREFIX): what is left is the file's own words. */
function withoutLibraryMarkers(text: string): string {
  if (!/\||Row \d|## (?:Sheet|Slide) |--- Page /.test(text)) return text;
  return text.split("\n").map((line) => (LIBRARY_HEADING.test(line) ? "" : line.replace(LIBRARY_LINE, ""))).join("\n");
}

/** The keys by which `CitationHider` knows a citation form written in a file: its form, and its lines or one end of them. */
function contentKeys(cited: Cited): string[] {
  return cited.from === cited.to ? [`${cited.kind}:${cited.from}`] : [`${cited.kind}:${cited.from}-${cited.to}`, `${cited.kind}:${cited.from}`, `${cited.kind}:${cited.to}`];
}

/** A held piece of text, with the place in the raw text of each UTF-16 unit. */
class Held {
  s = "";
  p: number[] = [];
  add(char: string, pos: number): this {
    this.s += char;
    for (let index = 0; index < char.length; index++) this.p.push(pos + index);
    return this;
  }
  addHeld(other: Held): this {
    this.s += other.s;
    for (const pos of other.p) this.p.push(pos);
    return this;
  }
  clear(): this {
    this.s = "";
    this.p = [];
    return this;
  }
  take(): Held {
    const copy = new Held();
    copy.s = this.s;
    copy.p = this.p;
    this.s = "";
    this.p = [];
    return copy;
  }
  slice(from: number, to?: number): Held {
    const part = new Held();
    part.s = this.s.slice(from, to);
    part.p = this.p.slice(from, to);
    return part;
  }
  /** The code points, with the place of each. */
  *chars(): Generator<[string, number]> {
    let index = 0;
    for (const char of this.s) {
      yield [char, this.p[index]!];
      index += char.length;
    }
  }
  get length(): number {
    return this.s.length;
  }
}
/** `text` as held, every unit of it at the place `pos`: words the hider puts in, for the place of the citation they stand for. */
const heldAt = (text: string, pos: number): Held => {
  const held = new Held();
  held.s = text;
  held.p = Array.from({ length: text.length }, () => pos);
  return held;
};

/** A number of a citation, as an entry of `CitationHider` gives it: its lines, and whether they are lines or rows. New in 0.99.14. */
export type HiderNumber = { from: number; to: number; form: "line" | "row" };

/**
 * A citation `CitationHider` took out, put into words or left (`drainEntries`). New in 0.99.14.
 * - `kind`: "removed", taken out of the text; "converted", put into words where it stood, as the
 *   answer needs the place ("ראו שורה 4"); "kept", left as it is written (a form written in the
 *   files, or a place already in words).
 * - `rule`: how it was read: "group" (in parentheses), "bracket" (in square or full-width brackets),
 *   "partial" (a run at the end of a parenthesis), "first-in-parenthesis" (a run before ":" or "," at
 *   its start), "lead-in-sentence" ("Data source: x L4."), "id-only", "id-in-prose" (a document ID
 *   put as its file name), "file-form" and "id-in-files" (kept), "in-words" (kept or converted).
 * - `place`: where it stood: "trailing", "line-start", "own-line", "end-of-parenthesis",
 *   "start-of-parenthesis", "colon", "prefix-letter", "location-word", "location-verb", "range-end",
 *   "table-cell", "list-item", "whole-answer", "appositive", "prose", "as-written".
 * - `span`: where it was in the raw text (all the text pushed), in UTF-16 units, its separator
 *   included when one went with it.
 * - `at`: where its chip goes in the shown text (all the text shown), for a removed or converted
 *   citation: after a list marker, outside emphasis, never at the start of a line, never in code.
 * - `numbers`: one per number it names, a list split ("שורות 12, 15 ו-18" gives three).
 * - `file`, `documentId`, `ids`: the file named inside it (`ids`: every document of that name), or
 *   the one document of the question.
 * - `words`: the words it was put into, when converted.
 */
export type HiderEntry = {
  kind: "removed" | "converted" | "kept";
  rule: string;
  place: string;
  span: [number, number];
  at?: number;
  text: string;
  numbers: HiderNumber[];
  file?: string;
  documentId?: string;
  ids?: string[];
  words?: string;
};

/** What `CitationHiderOptions.describe` is asked: the place a citation the answer needs names. New in 0.99.14. */
export type HiderPlace = {
  /** The documents of the file named in it, or the one document of the question; empty when none is known. */
  ids: string[];
  /** Its numbers, one per number. */
  numbers: HiderNumber[];
  /** Whether the answer is in Hebrew there: the words are to be in Hebrew. */
  hebrew: boolean;
  /** Where it is in the raw text, in UTF-16 units: the claim around it can be read there. */
  span: [number, number];
};

/** Options of `CitationHider`. New in 0.99.14. */
export type CitationHiderOptions = {
  /**
   * The rules: "0.99.14" (the default), or "0.99.12", what `showCitations: false` did in 0.99.12:
   * parentheses only, no words for a place, no record of what was taken out.
   */
  rules?: "0.99.12" | "0.99.14";
  /**
   * The words for the place of a citation the answer needs ("שורה 8 בגיליון לקוחות", "page 3"),
   * called at once when it is put into words. Undefined, or an error, puts in its own numbers
   * ("שורה 10", "line 10").
   */
  describe?: (place: HiderPlace) => string | undefined;
  /**
   * When a request's shown text is nothing but citations, show them in words at its end (LOOP-10).
   * True by default.
   */
  wholeAnswer?: boolean;
  /** Keep, for each unit shown, the place it came from and the call that showed it (`emittedPos`, `emittedCall`): for measuring how long text is held. */
  trace?: boolean;
};

/** A reading of a run of citations: pure (nothing else), kept (pure, but a form written in the files), its numbers and the documents it names. */
type Run = { pure: boolean; kept: boolean; items: Cited[]; ids: string[]; idOnly?: boolean };
/** What the text before a group says of it, for the needed-place rule. */
type GroupContext = {
  colon?: boolean;
  prefixHyphen?: boolean;
  locationWord?: boolean;
  locationVerb?: boolean;
  cellStart?: boolean;
  placeNamed?: boolean;
  rangeEnd?: boolean;
  placeNounBefore?: boolean;
};
/** What a hold that grows one character at a time knows of itself: up to where its head is clean, and whether that head holds a citation. */
type Checkpoint = { cp?: number; cpCit?: boolean; cpKey?: string };
type Group = Checkpoint & { open: string; close: string; buf: Held; depth: number; start: number; ctx: GroupContext; hyphen: Held; sep: Held | undefined };
type Tail = Checkpoint & { buf: Held; sepAt: number; sepIndex: number; prefixLetter: boolean };
type Lead = Checkpoint & { buf: Held; start: number; dot: boolean };
type Frame = { open: string; close: string; ticksBefore: number; noTail: boolean };
/** An entry as the hider keeps it while it works. */
type Entry = HiderEntry & { hebrew?: boolean; written: Array<string | undefined> };

/**
 * Takes the citations out of an answer as it is written, a piece at a time: "(report.docx
 * L188-L200)", "(L12)", "(app.log L5, L9)", "(`חוזה.docx` שורות 188-200)", each with the space
 * before it (at the start of a line, the space after it, the indentation kept), the emphasis around
 * it ("**(L12)**"), and a list item left with nothing else ("- (L12)").
 *
 * The 0.99.14 rules (the default, CIT-4) also take out:
 * - lead-ins in the brackets ("(מקור: x L4)", "(found in x L4)") and a whole lead-in sentence
 *   ("Data source: x L4.");
 * - square and full-width brackets ("[x L4]", "【L4】"), but not a link or a reference ("[x](url)");
 * - lists ("שורות 12, 15 ו-18", "L4, 9, 12", "etc."), one entry for each number;
 * - a run at the end of a parenthesis, after a separator or a prefix letter ("(סעיף 3.5, שורה 31)"
 *   → "(סעיף 3.5)", "(כגון 84% ב-L12)" → "(כגון 84%)"), and a run at its start before ":" or ","
 *   ("(L8: קנס יומי)" → "(קנס יומי)");
 * - a group of any length while it can still be a run of citations (up to 2,000 characters); words
 *   that cannot be part of one show it at once.
 * A citation the answer needs is put into words, not taken out: the whole answer, a whole table cell
 * or list item, or right after ":", a hyphenated prefix letter ("ב-("), a location word ("ראו",
 * "found in"), a location verb whose place has no number yet, or the second end of a range ("משורה 3
 * ועד (L7)"). The words come from `options.describe`, or are its numbers ("שורה 4", "line 4").
 *
 * What stays as it is written: a parenthesis with other words in it ("(see the table, L12)",
 * "(tier L2)"); code; a citation in a sentence with no brackets ("line 12 of the contract says",
 * "According to L4"); a form with no file name written in the files the model read (`addContent`),
 * such as the vertebrae "(L4-L5)" of a medical report (the library's own "Row N:" and "N|" are not
 * the file's words); a place in words in brackets after a place the sentence names ("בגיליון לקוחות
 * (שורה 8)").
 *
 * `push` gives what can be shown now, and `flush` the rest at the end of a request. Each citation
 * handled is an entry (`drainEntries`), with where its chip goes in the shown text. With `rules:
 * "0.99.12"` it is the hider of 0.99.12, piece for piece. New in 0.99.12; the 0.99.14 rules, the
 * entries and the options are new in 0.99.14.
 */
export class CitationHider {
  private readonly legacy: boolean;
  private readonly wholeAnswer: boolean;
  private readonly trace: boolean;
  private readonly describe: CitationHiderOptions["describe"];
  private readonly names: Record<string, string> = {};
  private readonly byName = new Map<string, string[]>();
  /** The document IDs a group may hold alone and go ("(policy-1)"), each with the pattern that finds it as a whole word, and those written in the files, which stay. */
  private readonly ids = new Map<string, RegExp>();
  private readonly idsInFiles = new Set<string>();
  /** The citation forms written in the files the model read (`contentKeys`). */
  private readonly content = new Set<string>();
  /** Every name and alias in lower case, for the hold. */
  private readonly aliases: string[] = [];
  private readonly record: Entry[] = [];
  private readonly drained = new Set<Entry>();
  private maxHeld = 0;
  private holds = 0;
  // The state of 0.99.12, with the place of each held unit.
  private pos = 0;
  private carry = "";
  private space = new Held();
  private marks = new Held();
  private hyphen = new Held();
  private group: Group | undefined;
  private wrapped: { space: Held; marks: Held; matched: number } | undefined;
  private marker = new Held();
  private bullet = new Held();
  private markerDone = false;
  private lineStart = true;
  private onlyIndent = true;
  private removedOnLine = false;
  private skipSpace = false;
  private fence = false;
  private inlineTicks = 0;
  private ticks = 0;
  private ticksStartLine = false;
  // The state of 0.99.14.
  private frames: Frame[] = [];
  private tail: Tail | undefined;
  private lead: Lead | undefined;
  private bracketPending: { group: Group; run: Run } | undefined;
  private cellPending: { entry: Entry; end: number; before: Held; after: Held } | undefined;
  private sepHold: { buf: Held } | undefined;
  private pendingSep: Held | undefined;
  private noTailAt = -1;
  private noLeadAt = -1;
  private lineAnchors: Entry[] = [];
  private lineEntries: Entry[] = [];
  private lastRemovalEnd = -1;
  private recent = "";
  private lineText = "";
  private lastSig = "";
  private requestText = "";
  private requestEntries: Entry[] = [];
  private coreOut = "";
  // The last stage: anchors and document IDs in prose.
  private out = "";
  private shownTotal = 0;
  private lastContentEnd = 0;
  private call = 0;
  private eWord: { text: string; chars: Array<[string, number[]]> } | undefined;
  private eDot: { word: { text: string; chars: Array<[string, number[]]> }; dot: [string, number[]] } | undefined;
  private eAnchors: Entry[] = [];
  private eMarks: Array<[string, number[]]> = [];
  private eInWord = false;
  /** With `trace`: for each unit shown, the place in the raw text it came from, and the call (push or flush, counted from 0) that showed it. */
  readonly emittedPos: number[] = [];
  readonly emittedCall: number[] = [];

  /**
   * `names` gives each document ID's file name, as for `checkCitations`. An ID is a name too: the
   * tool guide shows it beside the file name, and a model may cite "(contract-1 L3)". Not an ID of
   * fewer than 3 characters or without a letter, which ordinary words and numbers would match.
   * Such an ID may also stand alone in a parenthesis, and go: "(policy-1)" says nothing to the
   * user. Not an ID that is its file's name, with or without the extension: "(report.docx)" names
   * the file. `content` is text of the files the model read, as for `addContent`.
   */
  constructor(names: Record<string, string> = {}, content: readonly string[] = [], options: CitationHiderOptions = {}) {
    this.legacy = options?.rules === "0.99.12";
    this.wholeAnswer = !this.legacy && options?.wholeAnswer !== false;
    this.trace = options?.trace === true;
    this.describe = typeof options?.describe === "function" ? options.describe : undefined;
    const add = (name: string, id: string) => this.byName.set(name, [...this.byName.get(name) ?? [], id]);
    for (const [id, name] of Object.entries(names ?? {})) {
      if (typeof name !== "string") continue;
      this.names[id] = name;
      add(name, id);
      if (id.length < 3 || !/\p{L}/u.test(id)) continue;
      add(id, id);
      const key = plain(id).toLocaleLowerCase();
      const file = plain(name).toLocaleLowerCase();
      const dot = file.lastIndexOf(".");
      if (key !== file && (dot < 0 || key !== file.slice(0, dot))) this.ids.set(id, new RegExp(String.raw`${EDGE_BEFORE}${escaped(plain(id))}${EDGE_AFTER}`, "giu"));
    }
    for (const [written] of this.byName) {
      const name = plain(written).toLocaleLowerCase();
      if (!name.trim()) continue;
      this.aliases.push(name);
      const dot = name.lastIndexOf(".");
      if (dot >= 3) this.aliases.push(name.slice(0, dot));
    }
    for (const text of content ?? []) this.addContent(text);
  }

  /**
   * Text of a file the model read: a file sent whole, or what a tool showed of one. A citation form
   * written in it ("L4-L5", "L2", "line 12"), found as `checkCitations` finds citations (whole
   * words, any dash, "L" or "l"), keeps a group of that form with no file name in it: it is a word of
   * the file, not a citation. A range is known by itself or by both of its ends. So does a document
   * ID written in it, for a group that holds the ID alone. By the 0.99.14 rules the markers the
   * library writes on its lines ("12| ", "Row 7: ", "## Sheet 2: …", "--- Page 3 ---") are not read.
   */
  addContent(text: string): void {
    if (typeof text !== "string" || !text) return;
    const read = this.legacy ? plain(text) : withoutLibraryMarkers(plain(text));
    for (const cited of citationsIn(read)) for (const key of contentKeys(cited)) this.content.add(key);
    for (const [id, pattern] of this.ids) {
      if (this.idsInFiles.has(id)) continue;
      pattern.lastIndex = 0;
      if (pattern.test(read)) this.idsInFiles.add(id);
    }
  }

  /** `addContent` for the text of a tool result: every string in it, but the fields that hold no text of a file (`NOT_FILE_TEXT`). */
  addToolResult(result: unknown): void {
    const walk = (value: unknown): void => {
      if (typeof value === "string") this.addContent(value);
      else if (Array.isArray(value)) for (const item of value) walk(item);
      else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) if (!NOT_FILE_TEXT.test(key)) walk(item);
    };
    walk(result);
  }

  /** The text of `delta` that can be shown now, after what an earlier piece held back. */
  push(delta: string): string {
    this.out = "";
    this.coreOut = "";
    let text = this.carry + String(delta ?? "");
    this.carry = "";
    // A high surrogate at the end waits for its pair: half of a pair is not a character.
    if (!this.legacy && text && /[\ud800-\udbff]$/.test(text)) {
      this.carry = text.slice(-1);
      text = text.slice(0, -1);
    }
    for (const char of text) {
      const at = this.pos;
      this.pos += char.length;
      this.step(char, at);
    }
    const shown = this.out;
    this.call++;
    return shown;
  }

  /** What is still held back, at the end of a request's text. A group never closed is shown as it was written. */
  flush(): string {
    this.out = "";
    this.coreOut = "";
    if (this.carry) {
      const char = this.carry;
      this.carry = "";
      const at = this.pos;
      this.pos += char.length;
      this.step(char, at);
    }
    if (this.ticks > 0) this.endTicks();
    for (let guard = 0; guard < 10_000 && (this.sepHold || this.bracketPending || this.lead || this.group || this.tail || this.cellPending); guard++) {
      if (this.sepHold) this.releaseSepHold();
      else if (this.bracketPending) this.resolveBracket();
      else if (this.lead) this.resolveLead(true);
      else if (this.group !== undefined) this.replay("", 0);
      else if (this.tail) this.replayTail();
      else this.resolveCell(true);
    }
    if (this.wrapped) this.unwrap();
    if (this.marker.length) this.notMarker();
    if (this.lineStart && this.removedOnLine) {
      if (!this.convertItem()) {
        this.bullet.clear();
        this.anchorLine("prev");
        for (const entry of this.lineEntries) if (entry.place === "line-start") entry.place = "own-line";
      }
    } else {
      this.emitText(new Held().addHeld(this.bullet).addHeld(this.space).addHeld(this.hyphen).addHeld(this.marks));
      if (this.lineAnchors.length) this.anchorLine("here");
    }
    this.bullet.clear();
    this.space.clear();
    this.marks.clear();
    this.hyphen.clear();
    this.lineStart = this.coreOut ? this.coreOut.endsWith("\n") : this.lineStart;
    this.frames = [];
    // LOOP-10: nothing but citations was shown for this request: they are shown in words.
    if (this.wholeAnswer) {
      const removed = this.requestEntries.filter((entry) => entry.kind === "removed" && entry.numbers.length);
      if (removed.length && !/[\p{L}\p{N}\p{So}]/u.test(this.requestText)) {
        removed.forEach((entry, index) => {
          if (index > 0) this.emitText(heldAt(", ", entry.span[1] - 1));
          entry.kind = "converted";
          entry.place = "whole-answer";
          entry.words = this.placeWords(entry);
          this.eAnchor(entry, "here");
          this.emitText(heldAt(entry.words, entry.span[1] - 1));
        });
      }
    }
    this.eFlush();
    this.requestText = "";
    this.requestEntries = [];
    const shown = this.out;
    this.call++;
    return shown;
  }

  /**
   * The entries decided since the last call, in the order of the raw text: each citation taken out,
   * put into words or left. An entry with a chip is given once the shown text has reached its `at`,
   * and once nothing can change it (a request's text that could still turn out to be nothing but
   * citations keeps its entries until it shows a word, or until `flush`). Copies: changing them
   * changes nothing here. The 0.99.12 rules give no entry. New in 0.99.14.
   */
  drainEntries(): HiderEntry[] {
    const open = !/[\p{L}\p{N}\p{So}]/u.test(this.requestText) && this.wholeAnswer;
    const pendingRequest = open ? new Set(this.requestEntries) : undefined;
    const ready: Entry[] = [];
    for (const entry of this.record) {
      if (this.drained.has(entry)) continue;
      if (entry.kind !== "kept" && entry.at === undefined) continue;
      if (this.cellPending?.entry === entry || pendingRequest?.has(entry)) continue;
      ready.push(entry);
    }
    for (const entry of ready) this.drained.add(entry);
    return ready.sort(bySpan).map(publicEntry);
  }

  /** Every entry so far, in the order of the raw text, those not yet decided included. New in 0.99.14. */
  entries(): HiderEntry[] {
    return [...this.record].sort(bySpan).map(publicEntry);
  }

  /** How much it held back: the most characters one hold reached, and how many holds it opened (for `AskResult.lineTalk`). New in 0.99.14. */
  held(): { characters: number; times: number } {
    return { characters: this.maxHeld, times: this.holds };
  }

  // ----------------------------------------------------------------------------- reading runs

  private isContent(cited: Cited): boolean {
    if (this.content.size === 0) return false;
    if (cited.from === cited.to) return this.content.has(`${cited.kind}:${cited.from}`);
    return this.content.has(`${cited.kind}:${cited.from}-${cited.to}`) || (this.content.has(`${cited.kind}:${cited.from}`) && this.content.has(`${cited.kind}:${cited.to}`));
  }

  /** The IDs a text holds alone, none of them written in the files nor its file's name, or undefined when it holds more. */
  private idsOnly(read: string): string[] | undefined {
    const units = read.split("");
    const found: string[] = [];
    for (const [id, pattern] of this.ids) {
      if (this.idsInFiles.has(id)) continue;
      for (const match of read.matchAll(pattern)) {
        found.push(id);
        for (let index = match.index; index < match.index + match[0].length; index++) units[index] = " ";
      }
    }
    return found.length && ID_FILLER.test(units.join("")) ? found : undefined;
  }

  /** Whether a text holds IDs written in the files alone: a group that stays. */
  private idsInFilesOnly(read: string): boolean {
    const units = read.split("");
    let found = false;
    for (const [id, pattern] of this.ids) {
      if (!this.idsInFiles.has(id)) continue;
      for (const match of read.matchAll(pattern)) {
        found = true;
        for (let index = match.index; index < match.index + match[0].length; index++) units[index] = " ";
      }
    }
    return found && ID_FILLER.test(units.join(""));
  }

  /**
   * Reads `inside` as a run of citations. `pure`: nothing but citations, names, list numbers and
   * filler (what 0.99.12 read with its rules). `kept`: pure, but a form written in the files with
   * no file name, which stays. `items`: one per number.
   */
  private parseRun(inside: string, allowParens = false): Run {
    const read = plain(inside);
    const spans: Array<{ start: number; end: number; ids?: string[] }> = namesIn(read, this.byName).map((hit) => ({ start: hit.from, end: hit.end, ids: hit.ids }));
    for (const match of read.matchAll(FILE_NAME)) spans.push({ start: match.index, end: match.index + match[0].length, ids: [] });
    const nameCount = spans.length;
    const cited: Cited[] = [];
    for (const one of citationsIn(read)) {
      if (spans.slice(0, nameCount).some(({ start, end }) => start < one.end && one.start < end)) continue;
      spans.push({ start: one.start, end: one.end });
      cited.push(one);
    }
    const ids = spans.slice(0, nameCount).flatMap((span) => span.ids ?? []);
    if (cited.length === 0) {
      const only = this.idsOnly(read);
      if (only) return { pure: true, kept: false, items: [], ids: only, idOnly: true };
      if (this.idsInFilesOnly(read)) return { pure: true, kept: true, items: [], ids: [], idOnly: true };
      return { pure: false, kept: false, items: [], ids };
    }
    const units = read.split("");
    for (const { start, end } of spans) for (let index = start; index < end; index++) units[index] = " ";
    let masked = units.join("");
    const items: Cited[] = cited.map((one) => ({ ...one }));
    if (!this.legacy) {
      masked = masked.replace(PAGE_ANY, (match) => " ".repeat(match.length));
      // Bare numbers after a citation, each after a list separator, are entries of the list.
      type Piece = { start: number; end: number; cit?: Cited; first?: string; second?: string; head?: Cited };
      const numbers: Piece[] = [];
      for (const match of masked.matchAll(LIST_NUMBER)) numbers.push({ start: match.index, end: match.index + match[0].length, first: match[1]!, ...(match[2] !== undefined ? { second: match[2] } : {}) });
      const sorted: Piece[] = [...cited.map((one) => ({ start: one.start, end: one.end, cit: one })), ...numbers].sort((left, right) => left.start - right.start);
      let previous: Piece | undefined;
      for (const piece of sorted) {
        if (piece.cit) {
          previous = piece;
          continue;
        }
        if (!previous || !LIST_SEP.test(read.slice(previous.end, piece.start))) return { pure: false, kept: false, items: [], ids };
        const head = (previous.cit ?? previous.head)!;
        const first = numberOf(piece.first!);
        const second = piece.second === undefined ? first : numberOf(piece.second);
        items.push({ start: piece.start, end: piece.end, from: Math.min(first, second), to: Math.max(first, second), form: head.form, kind: head.kind, bare: head.bare, written: read.slice(piece.start, piece.end) });
        piece.head = head;
        previous = piece;
      }
      const listUnits = masked.split("");
      for (const piece of numbers) for (let index = piece.start; index < piece.end; index++) listUnits[index] = " ";
      masked = listUnits.join("");
    }
    items.sort((left, right) => left.start - right.start);
    const test = allowParens ? masked.replace(/[()[\]]/g, " ") : masked;
    const pure = (this.legacy ? FILLER : RUN_FILLER).test(test);
    const kept = pure && nameCount === 0 && items.some((one) => this.isContent(one));
    return { pure, kept, items, ids };
  }

  /**
   * `viable` for a hold that grows one character at a time (a group, a tail, a lead-in sentence),
   * read incrementally (HIDER-SPEED): a head that was clean up to a list separator ("," or ";") is
   * not read again; only the text since, after a stand-in citation when the head held one, so that a
   * list number after it still counts. Time grows with the length of the hold, not its square.
   */
  private viableHeld(holder: Checkpoint, inside: string, firstWord = false, key = ""): boolean {
    if (inside.length > MOST_HELD_RUN) return false;
    if (holder.cpKey !== key) {
      holder.cp = 0;
      holder.cpCit = false;
      holder.cpKey = key;
    }
    const cp = holder.cp ?? 0;
    const window = inside.slice(cp);
    const head = holder.cpCit ? "L1" : "";
    if (!this.viable(head + window, firstWord && cp === 0)) return false;
    const last = window.at(-1);
    if ((last === "," || last === ";") && window.length > 1) {
      const prefix = plain(head + window.slice(0, -1));
      const fast = FAST_RUN.test(prefix);
      if (fast || this.clean(prefix)) {
        holder.cpCit = holder.cpCit || fast || citationsIn(prefix).length > 0;
        holder.cp = cp + window.length - 1;
      }
    }
    return true;
  }

  /** Whether `inside` (the text after an opener, so far) may still become a run of citations. */
  private viable(inside: string, firstWord: boolean): boolean {
    if (inside.length > MOST_HELD_RUN) return false;
    if (FAST_RUN.test(inside)) return true;
    const read = plain(inside);
    if (/[()[\]【】［］（）\n|]/u.test(read)) return false;
    if (this.clean(read)) return true;
    // A page of a named file, its number still to come ("(report.pdf p. "). A page with no file name
    // is the answer's own words ("(p. 2, L8)" keeps "(p. 2)"), and is shown at once.
    const page = PAGE_WORD_END.exec(read);
    if (page) {
      const head = read.slice(0, page.index);
      if ((namesIn(head, this.byName).length > 0 || head.search(FILE_NAME) >= 0) && this.clean(head)) return true;
    }
    // A head that is clean (only run words so far) and a word, or a name, still being written.
    const lower = read.toLocaleLowerCase();
    let lastStart = read.length;
    while (lastStart > 0 && /[\p{L}\p{N}_.\-'׳״"]/u.test(read[lastStart - 1]!)) lastStart--;
    const head = read.slice(0, lastStart);
    const word = read.slice(lastStart);
    if (this.clean(head)) {
      if (this.partialOk(word, citationsIn(head).length > 0)) return true;
      // The first word of a parenthesis may be a file name outside the question ("(other.pdf L4)").
      if (firstWord && !/[\p{L}\p{N}]/u.test(head) && FIRST_WORD.test(word)) return true;
    }
    for (let k = 0; k < read.length; k++) {
      if (k > 0 && /[\p{L}\p{N}_]/u.test(read[k - 1]!)) continue;
      if (!/[\p{L}\p{N}_]/u.test(read[k] ?? "")) continue;
      const restWhole = lower.slice(k);
      const rest = restWhole.replace(PREFIX_LETTERS_START, "");
      const namePrefix = this.aliases.some((alias) => alias.startsWith(restWhole) || (rest !== restWhole && alias.startsWith(rest)));
      if (namePrefix && this.clean(read.slice(0, k))) return true;
    }
    return false;
  }

  /** Whether a word still being written may become a word of a run: a list number after a citation, "L12", "ב-L12", a word with a dot (a file name: "x.pd"), or the start of a run word. */
  private partialOk(word: string, afterCitation: boolean): boolean {
    if (!word) return true;
    if (/^\d[\d,]*(?:[-–—־]\d*)?$/.test(word)) return afterCitation;
    if (/^[Ll]\d*$/.test(word) || /^[Ll]\d[\d,]*[-–—־][Ll]?\d*$/.test(word)) return true;
    if (/^[בלמוהכש]{1,2}[-־](?:[Ll]\d*)?$/u.test(word)) return true;
    if (/^[\p{L}\p{N}_][\p{L}\p{N}_\-]*\.\p{L}*$/u.test(word)) return true;
    const lower = plain(word).toLocaleLowerCase().replace(/^["'״׳`]+/u, "");
    if (!lower) return true;
    if (VOCABULARY.some((one) => one.startsWith(lower))) return true;
    // Hebrew: none, one or two prefix letters (and a hyphen), then the start of a run word.
    for (let n = 0; n <= 2; n++) {
      if (n > 0 && !new RegExp(`^${HE_PREFIX}{${n}}`, "u").test(lower)) break;
      const rest = lower.slice(n).replace(/^[-־]/u, "");
      if (n > 0 && !rest) return true;
      if (rest && VOCABULARY_HE.some((one) => one.startsWith(rest))) return true;
    }
    return false;
  }

  /** Whether a text is the head of a run: only names, citations, list numbers and run words (no citation needed yet). */
  private clean(head: string): boolean {
    if (!head.trim()) return true;
    const text = head.replace(/(^|[\s,;:"'`])[Ll][  ]$/u, "$1");
    if (this.parseRun(text).pure) return true;
    const spans: Array<[number, number]> = namesIn(text, this.byName).map((hit) => [hit.from, hit.end]);
    for (const match of text.matchAll(FILE_NAME)) spans.push([match.index, match.index + match[0].length]);
    const found = citationsIn(text);
    for (const one of found) spans.push([one.start, one.end]);
    const units = text.split("");
    for (const [start, end] of spans) for (let index = start; index < end; index++) units[index] = " ";
    let masked = units.join("");
    if (found.length > 0) masked = masked.replace(LIST_NUMBER, (match) => " ".repeat(match.length));
    return RUN_FILLER.test(masked);
  }

  /** A citation's own numbers in words ("שורה 10", "שורות 12, 15 ו-18", "line 10", "rows 7 and 9"). */
  private wordsOf(items: Array<HiderNumber & { written?: string | undefined }>, hebrew: boolean): string {
    const format = (item: HiderNumber) => (item.from === item.to ? `${item.from}` : `${item.from}–${item.to}`);
    const join = (parts: string[], last: string) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")}${last}${parts.at(-1)}`);
    if (!items.length) return "";
    if (hebrew) {
      if (items.length === 1) return `${items[0]!.from === items[0]!.to ? "שורה" : "שורות"} ${format(items[0]!)}`;
      return `שורות ${join(items.map(format), " ו-")}`;
    }
    const word = items.every((item) => item.form === "row" && /^[Rr]ow/.test(item.written ?? "")) ? "row" : "line";
    if (items.length === 1) return `${items[0]!.from === items[0]!.to ? word : `${word}s`} ${format(items[0]!)}`;
    return `${word}s ${join(items.map(format), " and ")}`;
  }

  /** The file a run names (the first of its documents that is one of the question's), or the one document of the question. */
  private fileOf(run: Pick<Run, "ids">): { file?: string; documentId?: string; ids: string[] } {
    const named = [...new Set(run.ids.filter((one) => this.names[one] !== undefined))];
    const id = named[0];
    if (id) return { file: this.names[id]!, documentId: id, ids: named };
    const all = Object.keys(this.names);
    if (all.length === 1) return { file: this.names[all[0]!]!, documentId: all[0]!, ids: [all[0]!] };
    return { ids: [] };
  }

  /** The app's words for the place of `entry` (`describe`), or undefined. */
  private described(entry: Entry): string | undefined {
    if (!this.describe || this.legacy) return undefined;
    try {
      const given = this.describe({ ids: [...entry.ids ?? []], numbers: entry.numbers.map((one) => ({ ...one })), hebrew: entry.hebrew === true, span: [entry.span[0], entry.span[1]] });
      return typeof given === "string" && given.trim() ? given.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The words a citation the answer needs is shown as: the app's (`describe`), else its own numbers
   * in the answer's language. `numberOnly`: a word for a place stands right before it ("בשורה
   * (L10)"), so the words start with no such word of their own.
   */
  private placeWords(entry: Entry, numberOnly = false): string {
    let words = this.described(entry);
    words ??= this.wordsOf(entry.numbers.map((one, index) => ({ ...one, written: entry.written[index] })), entry.hebrew === true);
    return numberOnly ? words.replace(PLACE_WORDS_START, "") : words;
  }

  /** Whether the answer is in Hebrew where it is being written: its line, else what came before it, else the files' names. */
  private isHebrewHere(extra = ""): boolean {
    if (!this.legacy) {
      // The line as written, without the citation's own file names: "Avi Mizrahi is listed in (לקוחות.xlsx Row 7)" is English.
      const own = plain(this.lineText);
      if (HEBREW.test(own)) return true;
      if (/[A-Za-z]{2}/.test(own.replace(/(?<![A-Za-z])[Ll] ?\d+/g, ""))) return false;
      let rest = plain(extra);
      for (const hit of namesIn(rest, this.byName).reverse()) rest = rest.slice(0, hit.from) + rest.slice(hit.end);
      rest = rest.replace(FILE_NAME, " ");
      if (HEBREW.test(rest)) return true;
      if (/[A-Za-z]{2}/.test(rest.replace(/(?<![A-Za-z])[Ll] ?\d+/g, "").replace(/\b(?:lines?|rows?)\b/gi, ""))) return false;
      if (HEBREW.test(plain(this.recent))) return true;
      if (/[A-Za-z]{2}/.test(plain(this.recent))) return false;
      return Object.values(this.names).some((name) => HEBREW.test(name));
    }
    const line = plain(this.lineText + extra);
    if (HEBREW.test(line)) return true;
    if (/[A-Za-z]{2}/.test(line.replace(/(?<![A-Za-z])[Ll] ?\d+/g, ""))) return false;
    if (HEBREW.test(plain(this.recent))) return true;
    return Object.values(this.names).some((name) => HEBREW.test(name));
  }

  private newEntry(fields: { kind?: Entry["kind"]; rule?: string; place?: string; span: [number, number]; text: string; items?: Cited[]; hebrew?: boolean; file?: string; documentId?: string; ids?: string[] }): Entry {
    const { items = [], ...rest } = fields;
    const entry: Entry = {
      kind: "removed",
      rule: "group",
      place: "trailing",
      ...rest,
      numbers: items.map((item) => ({ from: item.from, to: item.to, form: item.form })),
      written: items.map((item) => item.written),
    };
    // The 0.99.12 rules keep no record.
    if (this.legacy) return entry;
    this.record.push(entry);
    this.requestEntries.push(entry);
    return entry;
  }

  // ----------------------------------------------------------------------------- output

  /** Shows `buf` after the list marker held for it, and the line's anchors after the line's prefix. */
  private show(buf: Held): void {
    if (!buf.length) return;
    const code = this.fence || this.inlineTicks > 0;
    if (this.lineAnchors.length) {
      // Anchors of citations that went at the start of the line: after its marker and indentation.
      const lead = /^[ \t  ]*/u.exec(buf.s)![0].length;
      this.emitText(new Held().addHeld(this.bullet).addHeld(buf.slice(0, lead)), code);
      this.bullet.clear();
      const rest = buf.slice(lead);
      if (rest.length) {
        this.anchorLine("here");
        this.emitText(rest, code);
      }
      this.lineStart = buf.s.endsWith("\n");
      return;
    }
    this.emitText(new Held().addHeld(this.bullet).addHeld(buf), code);
    this.bullet.clear();
    this.lineStart = buf.s.endsWith("\n");
  }

  private emitText(buf: Held, code = false): void {
    if (!buf.length) return;
    this.coreOut += buf.s;
    this.requestText += buf.s;
    this.recent = (this.recent + buf.s).slice(-160);
    const newline = buf.s.lastIndexOf("\n");
    this.lineText = newline >= 0 ? buf.s.slice(newline + 1) : this.lineText + buf.s;
    const signal = buf.s.replace(/\s+$/u, "");
    if (signal) this.lastSig = signal.at(-1)!;
    let index = 0;
    for (const char of buf.s) {
      this.eChar(char, buf.p.slice(index, index + char.length), code);
      index += char.length;
    }
  }

  /** The anchors of citations that went at the start of the line: here, or at the end of the previous content line. */
  private anchorLine(mode: "here" | "prev"): void {
    const anchors = this.lineAnchors;
    this.lineAnchors = [];
    for (const entry of anchors) this.eAnchor(entry, mode);
  }

  /** Shows what was held before `char`, then `char`. */
  private showHeld(char: string, pos: number): void {
    const held = new Held().addHeld(this.space).addHeld(this.hyphen).addHeld(this.marks);
    this.space.clear();
    this.hyphen.clear();
    this.marks.clear();
    if (char) held.add(char, pos);
    this.show(held);
  }

  // The last stage: an anchor takes its place in the shown text (after closing emphasis), and a
  // document ID written in prose becomes its file name. It holds only an ID being written, and
  // emphasis marks after an anchor.
  private eChar(char: string, positions: number[], code: boolean): void {
    if (this.eAnchors.length) {
      if (/^[*_~]$/.test(char)) {
        this.eMarks.push([char, positions]);
        return;
      }
      this.eReleaseAnchors(!/[\p{L}\p{N}]/u.test(char) && !this.legacy);
    }
    if (this.legacy || this.ids.size === 0) return this.eOut(char, positions);
    if (this.eDot) {
      const { word, dot } = this.eDot;
      this.eDot = undefined;
      if (/[\p{L}\p{N}]/u.test(char)) {
        this.eOutWord(word, false);
        this.eOut(dot[0], dot[1]);
        this.eInWord = true;
        return this.eOut(char, positions);
      }
      this.eOutWord(word, true);
      this.eOut(dot[0], dot[1]);
      return this.eChar(char, positions, code);
    }
    if (this.eWord) {
      const candidate = this.eWord.text + char;
      if (ID_CHAR.test(char) && this.idPrefix(candidate)) {
        this.eWord.text = candidate;
        this.eWord.chars.push([char, positions]);
        return;
      }
      const word = this.eWord;
      this.eWord = undefined;
      const exact = !ID_CHAR.test(char) && this.idExact(word.text) !== undefined;
      if (exact && char === ".") {
        this.eDot = { word, dot: [char, positions] };
        return;
      }
      this.eOutWord(word, exact);
      return this.eChar(char, positions, code);
    }
    const wordChar = ID_CHAR.test(char);
    if (wordChar && !this.eInWord && !code && this.idPrefix(char)) {
      this.eWord = { text: char, chars: [[char, positions]] };
      this.eInWord = true;
      return;
    }
    this.eInWord = wordChar;
    this.eOut(char, positions);
  }

  private idPrefix(text: string): boolean {
    const key = plain(text).toLocaleLowerCase();
    for (const id of this.ids.keys()) if (!this.idsInFiles.has(id) && plain(id).toLocaleLowerCase().startsWith(key)) return true;
    return false;
  }

  private idExact(text: string): string | undefined {
    const key = plain(text).toLocaleLowerCase();
    for (const id of this.ids.keys()) if (!this.idsInFiles.has(id) && plain(id).toLocaleLowerCase() === key) return id;
    return undefined;
  }

  /** A word that may be a document ID: as written, or (`convert`) as its file's name. */
  private eOutWord(word: { text: string; chars: Array<[string, number[]]> }, convert: boolean): void {
    const id = convert ? this.idExact(word.text) : undefined;
    if (!id) {
      for (const [char, positions] of word.chars) this.eOut(char, positions);
      return;
    }
    const start = word.chars[0]![1][0]!;
    const end = word.chars.at(-1)![1].at(-1)! + 1;
    const name = this.names[id]!;
    const entry: Entry = { kind: "converted", rule: "id-in-prose", place: "prose", span: [start, end], text: word.text, numbers: [], written: [], file: name, documentId: id, ids: [id], words: name, at: this.shownTotal };
    this.record.push(entry);
    for (let index = 0; index < name.length; index++) this.eOut(name[index]!, [end - 1]);
  }

  private eAnchor(entry: Entry, mode: "here" | "prev"): void {
    if (this.legacy) return;
    if (this.eWord) {
      const word = this.eWord;
      this.eWord = undefined;
      this.eOutWord(word, this.idExact(word.text) !== undefined);
    }
    if (this.eDot) {
      const { word, dot } = this.eDot;
      this.eDot = undefined;
      this.eOutWord(word, true);
      this.eOut(dot[0], dot[1]);
    }
    if (mode === "prev") {
      entry.at = this.lastContentEnd;
      return;
    }
    this.eAnchors.push(entry);
  }

  private eReleaseAnchors(afterMarks: boolean): void {
    const anchors = this.eAnchors;
    const marks = this.eMarks;
    this.eAnchors = [];
    this.eMarks = [];
    if (!afterMarks) for (const entry of anchors) entry.at = this.shownTotal;
    for (const [char, positions] of marks) this.eOut(char, positions);
    if (afterMarks) for (const entry of anchors) entry.at = this.shownTotal;
  }

  private eOut(text: string, positions: number[]): void {
    this.out += text;
    for (let index = 0; index < text.length; index++) {
      if (this.trace) {
        this.emittedPos.push(positions[Math.min(index, positions.length - 1)]!);
        this.emittedCall.push(this.call);
      }
      this.shownTotal++;
      if (!/\s/u.test(text[index]!)) this.lastContentEnd = this.shownTotal;
    }
  }

  private eFlush(): void {
    if (this.eDot) {
      const { word, dot } = this.eDot;
      this.eDot = undefined;
      this.eOutWord(word, true);
      this.eOut(dot[0], dot[1]);
    }
    if (this.eWord) {
      const word = this.eWord;
      this.eWord = undefined;
      this.eOutWord(word, this.idExact(word.text) !== undefined);
    }
    if (this.eAnchors.length || this.eMarks.length) this.eReleaseAnchors(!this.legacy);
  }

  // ----------------------------------------------------------------------------- the 0.99.12 machine

  /** A run of backticks ended: at the start of a line, three or more open or close a fence; elsewhere they open or close inline code. */
  private endTicks(): void {
    if (this.ticksStartLine && this.ticks >= 3) {
      this.fence = !this.fence;
      this.inlineTicks = 0;
    } else if (!this.fence) {
      if (this.inlineTicks === 0) this.inlineTicks = this.ticks;
      else if (this.inlineTicks === this.ticks) this.inlineTicks = 0;
    }
    this.ticks = 0;
  }

  /**
   * The group is not a citation, was not closed, or can no longer be one: its opener is shown and
   * what followed it is read again, then `char`. A code span opened inside a group that closed ends
   * with it. `noTail`: a run longer than the hold, shown whole and never cut short by a tail.
   */
  private replay(char: string, pos: number, noTail = false): void {
    const group = this.group!;
    const closed = group.depth === 0;
    this.group = undefined;
    if (group.sep?.length) this.show(group.sep);
    if (group.hyphen.length) this.hyphen = group.hyphen;
    // A run first in a parenthesis, then ":" or "," and the file's words: the run goes ("(L8: קנס יומי)" → "(קנס יומי)").
    const head = noTail || this.legacy || group.open !== "(" ? undefined : this.leadingRun(group);
    if (head) this.eAnchor(head.entry, "here");
    this.showHeld(group.open, group.start);
    if (!this.legacy) this.frames.push({ open: group.open, close: group.close, ticksBefore: this.inlineTicks, noTail });
    const depthBefore = this.frames.length;
    const before = this.inlineTicks;
    let index = 0;
    for (const [one, at] of group.buf.chars()) {
      const skip = index === 0 || (head !== undefined && index < head.end);
      index += one.length;
      if (!skip) this.step(one, at);
    }
    if (this.ticks > 0) this.endTicks();
    if (closed && before === 0) this.inlineTicks = 0;
    if (!this.legacy && closed && this.frames.length >= depthBefore) this.frames.length = depthBefore - 1;
    if (char) this.step(char, pos);
  }

  /**
   * A run at the start of a group shown as text, ended by ":" or "," and white space, with words
   * after it that are not a run: its entry, and where the group's text goes on (an index into its
   * buffer, past the separator and the space after it). The longest such head.
   */
  private leadingRun(group: Group): { entry: Entry; end: number } | undefined {
    const s = group.buf.s;
    let best: { run: Run; end: number } | undefined;
    for (let k = 1; k < s.length; k++) {
      const char = s[k];
      if (char !== ":" && char !== ",") continue;
      if (!SPACE.test(s[k + 1] ?? "")) continue;
      let end = k + 1;
      while (end < s.length && SPACE.test(s[end]!)) end++;
      // A conjunction that joined the run to the words after it goes with the run: "(L52, או שורה 50
      // בטבלה)" → "(שורה 50 בטבלה)", not "(או שורה 50 …)". The "ו" of "וגם" goes, never that of
      // another word ("ועדה").
      const joined = JOINING.exec(s.slice(end));
      if (joined && /[\p{L}\p{N}`"'״“]/u.test(s.slice(end + joined[0].length))) end += joined[0].length;
      const rest = s.slice(end);
      if (!/[\p{L}\p{N}`"'״“]/u.test(rest)) break;
      const run = this.parseRun(s.slice(1, k));
      if (!run.pure) break;
      if (run.kept || !run.items.length || run.idOnly || run.items.some((one) => this.isContent(one))) continue;
      // The rest is the group's own words: a run there would make the group a list, read whole.
      if (this.parseRun(rest.replace(/[)\]）］】]\s*$/u, "")).pure) continue;
      best = { run, end };
    }
    if (!best) return undefined;
    const entry = this.newEntry({ span: [group.buf.p[1]!, group.buf.p[best.end - 1]! + 1], text: s.slice(1, best.end), items: best.run.items, rule: "first-in-parenthesis", place: "start-of-parenthesis", hebrew: this.isHebrewHere(), ...this.fileOf(best.run) });
    return { entry, end: best.end };
  }

  /** The emphasis held before a citation that went was not closed right after it: it opened more text. */
  private unwrap(): void {
    const { space, marks, matched } = this.wrapped!;
    this.wrapped = undefined;
    this.show(new Held().addHeld(space).addHeld(marks).addHeld(marks.slice(0, matched)));
    // The space after the citation goes, as the citation was right after the marks.
    if (matched === 0) this.skipSpace = true;
  }

  /** What was read as a list marker is not one: it is text, read again. */
  private notMarker(): void {
    const held = this.marker.take();
    this.markerDone = true;
    for (const [one, at] of held.chars()) this.step(one, at);
  }

  /** A citation went: what was held before it goes with it (or, at the start of a line, the space after it), and its anchor is placed. */
  private removed(entry?: Entry): void {
    this.removedOnLine = true;
    if (this.marks.length) this.wrapped = { space: this.space.take(), marks: this.marks.take(), matched: 0 };
    else if (this.lineStart) this.skipSpace = true;
    else this.space.clear();
    if (!entry) return;
    if (this.lineStart) {
      entry.place = "line-start";
      this.lineAnchors.push(entry);
      this.lineEntries.push(entry);
    } else this.eAnchor(entry, "here");
  }

  /** One character of the answer, and where it is in the raw text. */
  private step(char: string, pos: number): void {
    if (char !== "`" && this.ticks > 0) this.endTicks();
    if (this.group !== undefined) return this.stepGroup(char, pos);
    if (this.bracketPending) return this.stepBracket(char, pos);
    if (this.cellPending) return this.stepCell(char, pos);
    if (this.sepHold) return this.stepSepHold(char, pos);
    if (this.lead) return this.stepLead(char, pos);
    if (this.tail) return this.stepTail(char, pos);
    if (this.wrapped) {
      const wrapped = this.wrapped;
      if (char === wrapped.marks.s[wrapped.matched]) {
        wrapped.matched++;
        if (wrapped.matched === wrapped.marks.length) {
          // "**(L12)**": the emphasis went with the citation, and so does the space before it.
          this.wrapped = undefined;
          if (this.lineStart) {
            this.space = wrapped.space;
            this.skipSpace = true;
          }
        }
        return;
      }
      this.unwrap();
    }
    if (this.marker.length) {
      const marker = this.marker.s;
      if (/\d/.test(char) && /^\d{1,8}$/.test(marker)) return void this.marker.add(char, pos);
      if ((char === "." || char === ")") && /^\d+$/.test(marker)) return void this.marker.add(char, pos);
      if (SPACE.test(char) && LIST_MARKER.test(marker)) {
        this.bullet = new Held().addHeld(this.space).addHeld(this.marker).add(char, pos);
        this.space.clear();
        this.marker.clear();
        this.markerDone = true;
        return;
      }
      this.notMarker();
    }
    if (char === "\n") return this.newline(pos);
    // A direction mark after a held prefix hyphen ("ב-‏(") waits with it.
    if (!this.legacy && this.hyphen.length && DIRECTION_MARK.test(char)) return void this.hyphen.add(char, pos);
    if (char === "`") {
      if (this.ticks === 0) this.ticksStartLine = this.onlyIndent;
      this.ticks++;
      this.onlyIndent = false;
      this.skipSpace = false;
      return this.showHeld(char, pos);
    }
    // A code span opened inside a group shown as text ends with the group, as in 0.99.12 ("(see `x) then (L12)").
    if (!this.legacy && !this.fence && this.inlineTicks > 0 && this.frames.length && char === this.frames.at(-1)!.close && this.frames.at(-1)!.ticksBefore === 0) {
      this.inlineTicks = 0;
      this.frames.pop();
      return this.showHeld(char, pos);
    }
    if (this.fence || this.inlineTicks > 0) {
      this.onlyIndent &&= SPACE.test(char);
      return this.showHeld(char, pos);
    }
    if (SPACE.test(char)) {
      if (this.marks.length || this.hyphen.length) this.showHeld("", pos);
      if (this.skipSpace) return;
      if (this.bullet.length && this.lineStart) this.bullet.add(char, pos);
      else this.space.add(char, pos);
      return;
    }
    this.onlyIndent = false;
    this.skipSpace = false;
    if (this.lineStart && !this.markerDone && !this.bullet.length && (char === "-" || char === "+" || char === "*" || /\d/.test(char))) {
      this.marker.add(char, pos);
      return;
    }
    this.markerDone = true;
    const close = this.legacy ? (char === "(" ? ")" : undefined) : OPENERS[char];
    if (close) return this.openGroup(char, close, pos);
    if (char === "*" || char === "_") {
      this.marks.add(char, pos);
      return;
    }
    if (this.hyphen.length) this.showHeld("", pos);
    // The end of a group shown as text, and a separator or prefix letter that may start its tail.
    if (this.frames.length) {
      const frame = this.frames.at(-1)!;
      if (char === frame.close) {
        this.frames.pop();
        return this.showHeld(char, pos);
      }
      if (!frame.noTail && pos !== this.noTailAt) {
        if (TAIL_SEPARATORS.has(char) || (char === "-" && this.space.length)) return this.startTail(char, pos, true);
        if (this.space.length && /^[בלמוהכש]$/u.test(char)) return this.startTail(char, pos, false);
      }
    }
    // A whole lead-in sentence ("Data source: x L4.").
    if (!this.legacy && this.frames.length === 0 && pos !== this.noLeadAt && this.atSentenceStart() && this.leadPrefix(char)) {
      this.holds++;
      this.lead = { buf: new Held().add(char, pos), start: pos, dot: false };
      return;
    }
    // After a removed citation, a separator waits: ", (L4)" goes with a second citation.
    if (!this.legacy && (char === "," || char === ";") && this.lastRemovalEnd === pos && !this.space.length) {
      this.sepHold = { buf: new Held().add(char, pos) };
      return;
    }
    // A hyphen after a Hebrew prefix letter waits for a citation ("ב-(שורה 8)" → "בשורה 8").
    if (!this.legacy && (char === "-" || char === "־") && !this.space.length && !this.marks.length && PREFIX_LETTERS_END.test(plain(this.recent))) {
      this.hyphen.add(char, pos);
      return;
    }
    this.showHeld(char, pos);
  }

  private newline(pos: number): void {
    if (this.hyphen.length) this.showHeld("", pos);
    if (!this.fence && this.lineStart && this.removedOnLine) {
      if (this.convertItem()) this.showHeld("\n", pos);
      else {
        // The line held nothing but citations, and a list marker or indentation: it goes, with its end.
        this.bullet.clear();
        this.space.clear();
        this.marks.clear();
        this.anchorLine("prev");
        for (const entry of this.lineEntries) if (entry.place === "line-start") entry.place = "own-line";
      }
    } else this.showHeld("\n", pos);
    this.lineStart = true;
    this.onlyIndent = true;
    this.removedOnLine = false;
    this.markerDone = false;
    this.skipSpace = false;
    this.inlineTicks = 0;
    this.frames = [];
    this.lineEntries = [];
    this.lineText = "";
  }

  /** A list item made of nothing but citations: they are shown in words, after its marker. */
  private convertItem(): boolean {
    if (this.legacy || !this.bullet.length || !this.lineEntries.length || this.lineEntries.some((entry) => !entry.numbers.length || (entry.rule !== "group" && entry.rule !== "bracket"))) return false;
    const entries = this.lineEntries;
    const anchors = this.lineAnchors;
    this.lineAnchors = [];
    this.lineEntries = [];
    const bullet = this.bullet.take();
    this.space.clear();
    this.marks.clear();
    this.emitText(bullet);
    entries.forEach((entry, index) => {
      if (index > 0) this.emitText(heldAt(", ", entry.span[1] - 1));
      entry.kind = "converted";
      entry.place = "list-item";
      entry.words = this.placeWords(entry);
      if (anchors.includes(entry)) this.eAnchor(entry, "here");
      this.emitText(heldAt(entry.words, entry.span[1] - 1));
    });
    this.lineStart = false;
    return true;
  }

  private atSentenceStart(): boolean {
    if (this.lineStart) return true;
    return /[.!?]/.test(this.lastSig) && this.space.length > 0 && /\s$/u.test(this.recent + this.space.s);
  }

  private leadPrefix(text: string): boolean {
    const key = plain(text).toLocaleLowerCase();
    return LEAD_SENTENCES.some((phrase) => phrase.startsWith(key) || key.startsWith(phrase));
  }

  // ----------------------------------------------------------------------------- groups

  private openGroup(open: string, close: string, pos: number): void {
    const held = this.space.s + this.hyphen.s + this.marks.s;
    const ctx: GroupContext = {};
    if (!this.legacy) {
      const before = plain(this.recent) + held;
      ctx.colon = /:$/.test(before.replace(/[\s*_"'“”״]+$/u, ""));
      ctx.prefixHyphen = this.hyphen.length > 0;
      ctx.locationWord = LOCATION_WORD_END.test(before);
      const clause = before.split(/[,;!?:](?=\s)|\.(?=\s)|\n/u).at(-1) ?? "";
      ctx.locationVerb = LOCATION_VERB_CLAUSE.test(clause);
      ctx.cellStart = /^\s*\|/.test(this.lineText) && /\|[\s*_]*$/.test(this.lineText + held);
      // The clause names a place already, with no number (a sheet, a page): a place in words after it is the answer's own.
      const noun = PLACE_NOUN.exec(clause);
      ctx.placeNamed = noun !== null && !/\d/u.test(clause.slice(noun.index));
      // The second end of a range whose first end is a place in words ("משורה 3 ועד (L7)").
      ctx.rangeEnd = RANGE_END_WORD.test(before) && /(?:שור(?:ה|ות)|lines?|rows?)\s+\d/iu.test(plain(this.lineText));
      // A word for a place right before the group ("בשורה (L10)"): the words take only the number.
      ctx.placeNounBefore = PLACE_NOUN_END.test(before);
      this.holds++;
    }
    this.group = { open, close, buf: new Held().add(open, pos), depth: 1, start: pos, ctx, hyphen: this.hyphen.take(), sep: this.pendingSep };
    this.pendingSep = undefined;
  }

  private stepGroup(char: string, pos: number): void {
    const group = this.group!;
    if (char === "\n") return this.replay(char, pos);
    group.buf.add(char, pos);
    if (char === group.open) group.depth++;
    else if (char === group.close) group.depth--;
    if (group.depth === 0) return this.closeGroup();
    if (this.legacy) {
      if (group.buf.length > MOST_HELD) this.replay("", pos);
      return;
    }
    if (group.buf.length > this.maxHeld) this.maxHeld = group.buf.length;
    // A run longer than the hold is shown whole, never cut short by a tail.
    if (group.buf.length > MOST_HELD_RUN + 1) return this.replay("", pos, true);
    if (!this.viableHeld(group, group.buf.s.slice(1), true)) this.replay("", pos);
  }

  private closeGroup(): void {
    const group = this.group!;
    const inside = group.buf.s.slice(1, -1);
    const run = this.parseRun(inside);
    if (!this.legacy && run.pure && !run.kept) {
      // A form written in the files beside a citation with a file name ("(L4-L5, x.pdf L4)" of a
      // medical report): the file's word stays, and only a citation after a separator goes.
      if (run.items.some((one) => this.isContent(one)) && inside.split(/[,;]/u).some((part) => this.parseRun(part).kept)) return this.replay("", 0);
      // A place in words with no file name, right after a place the clause names ("on the customers
      // sheet (Row 8)", "בגיליון לקוחות (שורה 8)"), is the answer's own words: it stays, or, when the
      // app's words name another place (Excel's row of a text line), becomes those in its brackets.
      const ctx = group.ctx;
      if (!run.idOnly && group.open === "(" && ctx.placeNamed && !ctx.prefixHyphen && !ctx.colon && run.ids.length === 0 && plain(inside).search(FILE_NAME) < 0 && run.items.length && run.items.every((one) => one.kind !== 0)) {
        const end = group.buf.p.at(-1)! + 1;
        const entry = this.newEntry({ kind: "kept", rule: "in-words", place: "appositive", span: [group.start, end], text: group.buf.s, items: run.items, hebrew: this.isHebrewHere(group.buf.s), ...this.fileOf(run) });
        const given = this.described(entry);
        const numbers = (text: string) => [...plain(text).matchAll(/\d+/gu)].map((match) => match[0]).join(",");
        if (!given || numbers(given) === numbers(inside)) return this.replay("", 0);
        this.group = undefined;
        entry.kind = "converted";
        entry.words = `(${given})`;
        if (group.sep) this.show(group.sep);
        this.showHeld("", end - 1);
        this.eAnchor(entry, "here");
        this.show(heldAt(entry.words, end - 1));
        this.lastRemovalEnd = -1;
        return;
      }
    }
    if (run.pure && !run.kept) {
      this.group = undefined;
      if (!this.legacy && LINKABLE.has(group.open)) {
        this.bracketPending = { group, run };
        return;
      }
      return this.resolveGroup(group, run);
    }
    if (!this.legacy && run.pure && run.kept) {
      this.newEntry({ kind: "kept", rule: run.idOnly ? "id-in-files" : "file-form", place: "as-written", span: [group.start, group.buf.p.at(-1)! + 1], text: group.buf.s, items: run.items, ...this.fileOf(run) });
    }
    this.replay("", 0);
  }

  private stepBracket(char: string, pos: number): void {
    const { group } = this.bracketPending!;
    if (char === "(" || char === ":") {
      // "[x L4](url)" is a link and "[x L4]: url" a reference: text.
      this.bracketPending = undefined;
      this.group = group;
      this.replay(char, pos);
      return;
    }
    this.resolveBracket();
    this.step(char, pos);
  }

  private resolveBracket(): void {
    const { group, run } = this.bracketPending!;
    this.bracketPending = undefined;
    this.resolveGroup(group, run);
  }

  /** A group that is a run of citations: removed, or put into words when the answer needs it. */
  private resolveGroup(group: Group, run: Run): void {
    const end = group.buf.p.at(-1)! + 1;
    const ctx = group.ctx;
    const hebrew = this.legacy ? false : this.isHebrewHere(group.buf.s);
    const base = { span: [group.start, end] as [number, number], text: group.buf.s, items: run.items, rule: run.idOnly ? "id-only" : group.open === "(" ? "group" : "bracket", hebrew, ...this.fileOf(run) };
    const needed = this.legacy || run.idOnly || !run.items.length ? undefined : ctx.colon ? "colon" : ctx.prefixHyphen ? "prefix-letter" : ctx.locationWord ? "location-word" : ctx.locationVerb ? "location-verb" : ctx.rangeEnd ? "range-end" : undefined;
    if (needed) {
      const entry = this.newEntry({ ...base, kind: "converted", place: needed });
      entry.words = this.placeWords(entry, ctx.placeNounBefore === true);
      // After a place the clause names ("מופיע בגיליון לקוחות (x L10)"), the words stand beside it in brackets: "(שורה 8)".
      if (needed === "location-verb" && ctx.placeNamed && group.open === "(") entry.words = `(${entry.words})`;
      if (group.sep) this.show(group.sep);
      const dropHyphen = group.hyphen.length > 0 && HEBREW.test(entry.words[0] ?? "");
      const held = new Held().addHeld(this.space).addHeld(dropHyphen ? new Held() : group.hyphen).addHeld(this.marks);
      this.space.clear();
      this.marks.clear();
      this.show(held);
      this.eAnchor(entry, "here");
      this.show(heldAt(entry.words, end - 1));
      this.lastRemovalEnd = -1;
      return;
    }
    if (!this.legacy && ctx.cellStart && run.items.length) {
      if (group.sep) this.show(group.sep);
      const entry = this.newEntry({ ...base, kind: "removed", place: "table-cell" });
      this.cellPending = { entry, end, before: new Held().addHeld(this.space).addHeld(this.marks), after: new Held() };
      this.space.clear();
      this.marks.clear();
      return;
    }
    // A separator held after an earlier citation goes with this one.
    const entry = this.newEntry(base);
    if (group.sep) entry.span = [group.sep.p[0]!, end];
    if (group.hyphen.length) this.hyphen = group.hyphen;
    this.removed(entry);
    this.lastRemovalEnd = end;
  }

  private stepCell(char: string, pos: number): void {
    const cell = this.cellPending!;
    if (SPACE.test(char) || char === "*" || char === "_") return void cell.after.add(char, pos);
    if (char === "|" || char === "\n") {
      this.resolveCell(true);
      return this.step(char, pos);
    }
    this.resolveCell(false);
    this.step(char, pos);
  }

  /** A citation that opened a table cell: the whole cell (put into words), or the start of more text (taken out). */
  private resolveCell(whole: boolean): void {
    const cell = this.cellPending!;
    this.cellPending = undefined;
    const { entry, end } = cell;
    if (whole) {
      entry.kind = "converted";
      entry.words = this.placeWords(entry);
      this.show(cell.before);
      this.eAnchor(entry, "here");
      this.show(heldAt(entry.words, end - 1));
      this.show(cell.after);
      return;
    }
    entry.place = "trailing";
    this.eAnchor(entry, "here");
    for (const [one, at] of cell.after.chars()) this.step(one, at);
  }

  private stepSepHold(char: string, pos: number): void {
    const hold = this.sepHold!;
    if (SPACE.test(char)) return void hold.buf.add(char, pos);
    if (OPENERS[char]) {
      this.sepHold = undefined;
      this.pendingSep = hold.buf;
      return this.step(char, pos);
    }
    this.releaseSepHold();
    this.step(char, pos);
  }

  private releaseSepHold(): void {
    const hold = this.sepHold!;
    this.sepHold = undefined;
    const [first, ...rest] = [...hold.buf.chars()];
    this.lastRemovalEnd = -1;
    this.showHeld(first![0], first![1]);
    for (const [one, at] of rest) this.step(one, at);
  }

  // ----------------------------------------------------------------------------- tails

  /** A separator (`withSeparator`) or a prefix letter inside a group shown as text: a run may follow it to the group's end. */
  private startTail(char: string, pos: number, withSeparator: boolean): void {
    if (this.marks.length) this.showHeld("", pos);
    this.holds++;
    const buf = new Held().addHeld(this.space).add(char, pos);
    this.space.clear();
    // The separator is not read as part of the run; a prefix letter is ("ב-L12").
    this.tail = { buf, sepAt: pos, sepIndex: buf.length - char.length - (withSeparator ? 0 : 1), prefixLetter: !withSeparator };
  }

  private stepTail(char: string, pos: number): void {
    const tail = this.tail!;
    const frame = this.frames.at(-1);
    if (char === "\n") {
      this.replayTail();
      return this.step(char, pos);
    }
    if (frame && char === frame.close) {
      const inside = tail.buf.s.slice(tail.sepIndex + 1);
      const attached = !tail.prefixLetter || /^[בלמוהכש]{1,2}[-־]/u.test(inside);
      const run: Run = inside.trim() && attached ? this.parseRun(inside) : { pure: false, kept: false, items: [], ids: [] };
      if (run.pure && !run.kept && run.items.length) {
        this.tail = undefined;
        const entry = this.newEntry({ span: [tail.buf.p[0]!, tail.buf.p.at(-1)! + 1], text: tail.buf.s, items: run.items, rule: "partial", place: "end-of-parenthesis", hebrew: this.isHebrewHere(tail.buf.s), ...this.fileOf(run) });
        this.eAnchor(entry, "here");
        this.frames.pop();
        return this.showHeld(char, pos);
      }
      this.replayTail();
      return this.step(char, pos);
    }
    tail.buf.add(char, pos);
    if (tail.buf.length > this.maxHeld) this.maxHeld = tail.buf.length;
    if (tail.buf.length > MOST_HELD_RUN || !this.viableHeld(tail, tail.buf.s.slice(tail.sepIndex + 1))) this.replayTail();
  }

  private replayTail(): void {
    const tail = this.tail!;
    this.tail = undefined;
    this.noTailAt = tail.sepAt;
    for (const [one, at] of tail.buf.chars()) this.step(one, at);
  }

  // ----------------------------------------------------------------------------- lead-in sentences

  private stepLead(char: string, pos: number): void {
    const lead = this.lead!;
    if (char === "\n") {
      this.resolveLead(true);
      return this.step(char, pos);
    }
    if (lead.dot) {
      lead.dot = false;
      if (SPACE.test(char)) {
        this.resolveLead(true);
        return this.step(char, pos);
      }
    }
    lead.buf.add(char, pos);
    if (char === ".") {
      lead.dot = true;
      return;
    }
    const key = plain(lead.buf.s).toLocaleLowerCase();
    const phrase = LEAD_SENTENCES.filter((one) => key.startsWith(one)).sort((left, right) => right.length - left.length)[0];
    if (!phrase) {
      if (LEAD_SENTENCES.some((one) => one.startsWith(key))) return;
      return this.replayLead();
    }
    if (lead.buf.length > this.maxHeld) this.maxHeld = lead.buf.length;
    const rest = lead.buf.s.slice(phrase.length).replace(/[()[\]]/g, " ");
    if (lead.buf.length > MOST_HELD_RUN || !this.viableHeld(lead, rest, false, phrase)) this.replayLead();
  }

  /** At the end of a sentence that began with a lead-in: it goes whole when the rest is a run of citations. */
  private resolveLead(atEnd: boolean): boolean {
    const lead = this.lead!;
    const key = plain(lead.buf.s).toLocaleLowerCase();
    const phrase = LEAD_SENTENCES.filter((one) => key.startsWith(one)).sort((left, right) => right.length - left.length)[0];
    if (atEnd && phrase && !/:\s*$/.test(lead.buf.s)) {
      const run = this.parseRun(lead.buf.s.slice(phrase.length).replace(/\.$/, ""), true);
      if (run.pure && !run.kept && run.items.length) {
        this.lead = undefined;
        const entry = this.newEntry({ span: [lead.start, lead.buf.p.at(-1)! + 1], text: lead.buf.s, items: run.items, rule: "lead-in-sentence", place: this.lineStart ? "line-start" : "trailing", hebrew: this.isHebrewHere(lead.buf.s), ...this.fileOf(run) });
        this.removed(entry);
        // Emphasis opened before the sentence and closed in it ("*Data source: x L2–L6*") went with it.
        if (this.wrapped && lead.buf.s.replace(/[\s.]+$/u, "").endsWith(this.wrapped.marks.s)) {
          const wrapped = this.wrapped;
          this.wrapped = undefined;
          if (this.lineStart) {
            this.space = wrapped.space;
            this.skipSpace = true;
          }
        }
        return true;
      }
    }
    this.replayLead();
    return false;
  }

  private replayLead(): void {
    const lead = this.lead!;
    this.lead = undefined;
    this.noLeadAt = lead.start;
    for (const [one, at] of lead.buf.chars()) this.step(one, at);
  }
}

const bySpan = (left: Entry, right: Entry) => left.span[0] - right.span[0] || left.span[1] - right.span[1];

/** An entry as the hider gives it: a copy, without what it keeps for itself. */
function publicEntry(entry: Entry): HiderEntry {
  return {
    kind: entry.kind,
    rule: entry.rule,
    place: entry.place,
    span: [entry.span[0], entry.span[1]],
    ...(entry.at !== undefined ? { at: entry.at } : {}),
    text: entry.text,
    numbers: entry.numbers.map((one) => ({ ...one })),
    ...(entry.file !== undefined ? { file: entry.file } : {}),
    ...(entry.documentId !== undefined ? { documentId: entry.documentId } : {}),
    ...(entry.ids?.length ? { ids: [...entry.ids] } : {}),
    ...(entry.words !== undefined ? { words: entry.words } : {}),
  };
}

/**
 * `text` without its citations, as `CitationHider` takes them out: "Payment is due in 30 days
 * (contract.docx L188-L200)." becomes "Payment is due in 30 days.". `names` gives each document ID's
 * file name; `content` is text of the files the model read (`addContent`); `options` are those of
 * `CitationHider` (the 0.99.14 rules by default). New in 0.99.12; `options` new in 0.99.14.
 */
export function hideCitations(text: string, names: Record<string, string> = {}, content: readonly string[] = [], options: CitationHiderOptions = {}): string {
  const hider = new CitationHider(names, content, options);
  return hider.push(text) + hider.flush();
}
