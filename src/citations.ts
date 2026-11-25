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
type Cited = { start: number; end: number; from: number; to: number; form: "line" | "row"; bare: boolean; kind: number };

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
      added.push({ start, end, from: Math.min(first, second), to: Math.max(first, second), form, bare, kind });
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
 * workbook (XLSX) is unchecked: it may be Excel's row, which is not the line. Every citation read
 * is listed in `cited`, in order, with what was found of it (since 0.99.12). New in 0.10.0.
 */
export function checkCitations(text: string, evidence: Evidence[], names: Record<string, string>, formats?: Record<string, DocumentFormat>): CitationCheck {
  const cited: LineCitation[] = [];
  const check: CitationCheck = { checked: 0, supported: 0, unchecked: 0, unsupported: [], cited };
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
  for (const one of citationsIn(read)) {
    // A part of a file name ("report-L3.docx") is not a citation.
    const overlapping = named[firstFrom(named, (hit) => hit.end, one.start + 1)];
    if (overlapping && overlapping.start < one.end) continue;
    const around = parentheses(one.start, one.end);
    const hit = nameOf(read, one, named, around);
    if (!hit && one.bare && !around) continue;
    const ids = hit?.ids ?? only;
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


/** The most characters of a parenthesis that `CitationHider` holds back to see whether it is a citation. */
const MOST_HELD = 200;
/** A page named beside the lines: "p. 3", "pp. 3-4", "page 3", "עמ' 3", "עמוד 3". */
const PAGE = String.raw`(?:pp?\.|pages?|עמ['׳]|עמודים|עמוד)\s*\d+(?:${RANGE_END}\d+)?`;
/** A file name with no space in it and a known extension, named in a citation but not one of the question's files. */
const FILE_NAME = new RegExp(String.raw`${EDGE_BEFORE}[\p{L}\p{N}_][\p{L}\p{N}_.\-]*\.(?:pdf|docx?|xlsx?|csv|tsv|txt|md|log|json|html?|pptx?)${EDGE_AFTER}`, "giu");
/**
 * What may stand in a parenthesis of citations besides them and file names: separators, quotes,
 * backticks and emphasis around a name, "and", "see", the words for a line or a row
 * ("(שורות L1–L306)"), and pages.
 */
const FILLER = new RegExp(String.raw`^(?:[\s,;:&/.\-–—־\x60"'״׳“”‘’*_]|${EDGE_BEFORE}(?:and|see|cf|ראו|ראה|ו|lines?|rows?|[בלמוהכש]{0,2}שור(?:ה|ות))${EDGE_AFTER}|${PAGE})*$`, "iu");
/** Horizontal white space, which a citation takes with it. */
const SPACE = /^[ \t  ]$/u;
/** A list marker at the start of a line, once it is whole: "-", "+", "*", "1." or "1)". */
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])$/;
/** What may stand in a parenthesis of document IDs besides them: separators, quotes, backticks, emphasis and "and". */
const ID_FILLER = new RegExp(String.raw`^(?:[\s,;&/\x60"'״׳“”‘’*_]|${EDGE_BEFORE}(?:and|ו)${EDGE_AFTER})*$`, "iu");
/** The fields of a tool result that hold no text of a file: the outline's "L12 Title" labels, the hint on how to cite, notes, errors and document IDs. */
const NOT_FILE_TEXT = /^(?:outline|cite|error|document_id|documentId)$|note$/;

/** The keys by which `CitationHider` knows a citation form written in a file: its form, and its lines or one end of them. */
function contentKeys(cited: Cited): string[] {
  return cited.from === cited.to ? [`${cited.kind}:${cited.from}`] : [`${cited.kind}:${cited.from}-${cited.to}`, `${cited.kind}:${cited.from}`, `${cited.kind}:${cited.to}`];
}

/**
 * Takes the citations in parentheses out of an answer as it is written, a piece at a time:
 * "(report.docx L188-L200)", "(L12)", "(app.log L5, L9)", "(`חוזה.docx` שורות 188-200)", each with
 * the space before it (at the start of a line, the space after it, the indentation kept), the
 * emphasis around it ("**(L12)**"), and a list item left with nothing else ("- (L12)").
 *
 * What stays as it is written:
 * - a parenthesis with any other words in it ("(see the table, L12)", "(tier L2)");
 * - a citation outside parentheses ("line 12 of the contract says"), or in square brackets;
 * - code: a fenced block, or an inline code span opened before the parenthesis ("`fn(L12)`");
 * - a parenthesis with no file name in it ("(L4-L5)", "(line 12)") whose citation is written as
 *   words of the files the model read (`addContent`): the vertebrae of a medical report, the
 *   tiers of a support plan, the lines of a tax form.
 *
 * It holds back the text from a "(" until its ")", the end of its line or `MOST_HELD` characters;
 * white space and emphasis until what follows them; and a list marker at the start of a line until
 * the rest of its item. `push` gives what can be shown now, and `flush` the rest at the end, so the
 * pieces together are always `hideCitations` of the whole text. New in 0.99.12.
 */
export class CitationHider {
  private readonly byName: Map<string, string[]>;
  /** The citation forms written in the files the model read (`contentKeys`). */
  private readonly content = new Set<string>();
  /**
   * The document IDs a parenthesis may hold alone and go ("(policy-1)"), each with the pattern that
   * finds it as a whole word, and those written in the files the model read, which stay.
   */
  private readonly ids = new Map<string, RegExp>();
  private readonly idsInFiles = new Set<string>();
  private out = "";
  /** White space held back: it goes with a citation that follows it. */
  private space = "";
  /** A run of "*" or "_" held back after `space`, right before a "(": emphasis around a citation goes with it. */
  private marks = "";
  /** A parenthesis being read, from its "(", and how deep in parentheses its end is. */
  private group: string | undefined;
  private depth = 0;
  /** After a citation that went from inside emphasis: the space and marks before it, held, and how many of the closing marks came. */
  private wrapped: { space: string; marks: string; matched: number } | undefined;
  /** A list marker read at the start of a line, and the whole marker with its indentation and space once it is one. */
  private marker = "";
  private bullet = "";
  /** The line has had its chance at a list marker. */
  private markerDone = false;
  /** Nothing of the line was shown yet: its indentation and list marker may be held. */
  private lineStart = true;
  /** Nothing but white space on the line so far (for a fence, which must start a line). */
  private onlyIndent = true;
  /** A citation went from the line. */
  private removedOnLine = false;
  /** A citation at the start of a line went: the white space after it goes too. */
  private skipSpace = false;
  /** Inside a fenced code block; inside an inline code span, opened by a run of this many backticks. */
  private fence = false;
  private inlineTicks = 0;
  /** The backticks of the run being read, and whether the run starts its line. */
  private ticks = 0;
  private ticksStartLine = false;

  /**
   * `names` gives each document ID's file name, as for `checkCitations`. An ID is a name too: the
   * tool guide shows it beside the file name, and a model may cite "(contract-1 L3)". Not an ID of
   * fewer than 3 characters or without a letter, which ordinary words and numbers would match.
   * Such an ID may also stand alone in a parenthesis, and go: "(policy-1)" says nothing to the
   * user. Not an ID that is its file's name, with or without the extension: "(report.docx)" names
   * the file. `content` is text of the files the model read, as for `addContent`.
   */
  constructor(names: Record<string, string> = {}, content: readonly string[] = []) {
    this.byName = new Map();
    const add = (name: string, id: string) => this.byName.set(name, [...this.byName.get(name) ?? [], id]);
    for (const [id, name] of Object.entries(names ?? {})) {
      if (typeof name !== "string") continue;
      add(name, id);
      if (id.length < 3 || !/\p{L}/u.test(id)) continue;
      add(id, id);
      const key = plain(id).toLocaleLowerCase();
      const file = plain(name).toLocaleLowerCase();
      const dot = file.lastIndexOf(".");
      if (key !== file && (dot < 0 || key !== file.slice(0, dot))) this.ids.set(id, new RegExp(String.raw`${EDGE_BEFORE}${escaped(plain(id))}${EDGE_AFTER}`, "giu"));
    }
    for (const text of content) this.addContent(text);
  }

  /**
   * Text of a file the model read: a file sent whole, or what a tool showed of one. A citation form
   * written in it ("L4-L5", "L2", "line 12"), found as `checkCitations` finds citations (whole
   * words, any dash, "L" or "l"), keeps a parenthesis of that form with no file name in it: it is
   * a word of the file, not a citation. A range is known by itself or by both of its ends. So does
   * a document ID written in it, for a parenthesis that holds the ID alone.
   */
  addContent(text: string): void {
    if (typeof text !== "string" || !text) return;
    const read = plain(text);
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
    for (const char of delta) this.step(char);
    return this.out;
  }

  /** What is still held back: the end of the answer came. A parenthesis never closed is shown as it was written. */
  flush(): string {
    this.out = "";
    if (this.ticks > 0) this.endTicks();
    while (this.group !== undefined) this.replay("");
    if (this.wrapped) this.unwrap();
    if (this.marker) this.notMarker();
    if (this.lineStart && this.removedOnLine) this.bullet = "";
    else this.out += this.bullet + this.space + this.marks;
    this.bullet = this.space = this.marks = "";
    this.lineStart = this.out ? this.out.endsWith("\n") : this.lineStart;
    return this.out;
  }

  /** Shows `text`, after the list marker held for it. */
  private show(text: string): void {
    if (!text) return;
    this.out += this.bullet + text;
    this.bullet = "";
    this.lineStart = text.endsWith("\n");
  }

  /** Shows what was held before `char`, then `char`. */
  private showHeld(char: string): void {
    const held = this.space + this.marks;
    this.space = this.marks = "";
    this.show(held + char);
  }

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
   * The parenthesis is not a citation, or it was not closed: its "(" is shown, and what followed
   * it is read again, then `char`. A code span opened inside a parenthesis that closed ends with it.
   */
  private replay(char: string): void {
    const group = this.group!;
    const closed = this.depth === 0;
    this.group = undefined;
    this.depth = 0;
    this.showHeld("(");
    const before = this.inlineTicks;
    for (const one of group.slice(1)) this.step(one);
    if (this.ticks > 0) this.endTicks();
    if (closed && before === 0) this.inlineTicks = 0;
    if (char) this.step(char);
  }

  /** The emphasis held before a citation that went was not closed right after it: it opened more text. */
  private unwrap(): void {
    const { space, marks, matched } = this.wrapped!;
    this.wrapped = undefined;
    this.show(space + marks + marks.slice(0, matched));
    // The space after the citation goes, as the citation was right after the marks.
    if (matched === 0) this.skipSpace = true;
  }

  /** What was read as a list marker is not one: it is text, read again. */
  private notMarker(): void {
    const held = this.marker;
    this.marker = "";
    this.markerDone = true;
    for (const one of held) this.step(one);
  }

  /** A citation went: what was held before it goes with it, or, at the start of a line, the space after it. */
  private removed(): void {
    this.removedOnLine = true;
    if (this.marks) {
      this.wrapped = { space: this.space, marks: this.marks, matched: 0 };
      this.space = this.marks = "";
    } else if (this.lineStart) this.skipSpace = true;
    else this.space = "";
  }

  /** Whether the text inside a parenthesis is citations only, and not a word of the files (`addContent`). */
  private citationsOnly(inside: string): boolean {
    const read = plain(inside);
    // The names: the question's files and IDs, and any other name with a known extension.
    const spans: Array<[number, number]> = namesIn(read, this.byName).map((hit) => [hit.from, hit.end]);
    for (const match of read.matchAll(FILE_NAME)) spans.push([match.index, match.index + match[0].length]);
    const names = spans.length;
    const cited: Cited[] = [];
    for (const one of citationsIn(read)) {
      // A part of a file name ("report-L3.docx") is not a citation.
      if (spans.slice(0, names).some(([start, end]) => start < one.end && one.start < end)) continue;
      spans.push([one.start, one.end]);
      cited.push(one);
    }
    if (cited.length === 0) return this.idsOnly(read);
    // With no file name, a form written in the files is their word: "(L4-L5)" of a medical report.
    if (names === 0 && cited.some((one) => this.isContent(one))) return false;
    // Code units, as the spans count them: a letter out of the basic plane is two.
    const units = read.split("");
    for (const [start, end] of spans) for (let index = start; index < end; index++) units[index] = " ";
    return FILLER.test(units.join(""));
  }

  /**
   * Whether the text inside a parenthesis is document IDs alone ("policy-1", "`policy-1`"), none of
   * them written in the files the model read nor its file's name (`ids`).
   */
  private idsOnly(read: string): boolean {
    const units = read.split("");
    let found = false;
    for (const [id, pattern] of this.ids) {
      if (this.idsInFiles.has(id)) continue;
      for (const match of read.matchAll(pattern)) {
        found = true;
        for (let index = match.index; index < match.index + match[0].length; index++) units[index] = " ";
      }
    }
    return found && ID_FILLER.test(units.join(""));
  }

  private isContent(cited: Cited): boolean {
    if (this.content.size === 0) return false;
    if (cited.from === cited.to) return this.content.has(`${cited.kind}:${cited.from}`);
    return this.content.has(`${cited.kind}:${cited.from}-${cited.to}`) || (this.content.has(`${cited.kind}:${cited.from}`) && this.content.has(`${cited.kind}:${cited.to}`));
  }

  /** One character of the answer. */
  private step(char: string): void {
    if (char !== "`" && this.ticks > 0) this.endTicks();
    if (this.group !== undefined) {
      if (char === "\n") return this.replay(char);
      this.group += char;
      if (char === "(") this.depth++;
      else if (char === ")") this.depth--;
      if (this.depth === 0) {
        if (this.citationsOnly(this.group.slice(1, -1))) {
          this.group = undefined;
          this.removed();
        } else this.replay("");
      } else if (this.group.length > MOST_HELD) this.replay("");
      return;
    }
    if (this.wrapped) {
      const wrapped = this.wrapped;
      if (char === wrapped.marks[wrapped.matched]) {
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
    if (this.marker) {
      if (/\d/.test(char) && /^\d{1,8}$/.test(this.marker)) return void (this.marker += char);
      if ((char === "." || char === ")") && /^\d+$/.test(this.marker)) return void (this.marker += char);
      if (SPACE.test(char) && LIST_MARKER.test(this.marker)) {
        this.bullet = this.space + this.marker + char;
        this.space = this.marker = "";
        this.markerDone = true;
        return;
      }
      this.notMarker();
    }
    if (char === "\n") {
      if (!this.fence && this.lineStart && this.removedOnLine) {
        // The line held nothing but citations, and a list marker or indentation: it goes, with its end.
        this.bullet = this.space = this.marks = "";
      } else this.showHeld("\n");
      this.lineStart = true;
      this.onlyIndent = true;
      this.removedOnLine = false;
      this.markerDone = false;
      this.skipSpace = false;
      this.inlineTicks = 0;
      return;
    }
    if (char === "`") {
      if (this.ticks === 0) this.ticksStartLine = this.onlyIndent;
      this.ticks++;
      this.onlyIndent = false;
      this.skipSpace = false;
      return this.showHeld(char);
    }
    if (this.fence || this.inlineTicks > 0) {
      this.onlyIndent &&= SPACE.test(char);
      return this.showHeld(char);
    }
    if (SPACE.test(char)) {
      if (this.marks) this.showHeld("");
      if (this.skipSpace) return;
      if (this.bullet && this.lineStart) this.bullet += char;
      else this.space += char;
      return;
    }
    this.onlyIndent = false;
    this.skipSpace = false;
    if (this.lineStart && !this.markerDone && !this.bullet && (char === "-" || char === "+" || char === "*" || /\d/.test(char))) {
      this.marker = char;
      return;
    }
    this.markerDone = true;
    if (char === "(") {
      this.group = "(";
      this.depth = 1;
      return;
    }
    if (char === "*" || char === "_") {
      this.marks += char;
      return;
    }
    this.showHeld(char);
  }
}

/**
 * `text` without its citations in parentheses, as `CitationHider` takes them out: "Payment is due
 * in 30 days (contract.docx L188-L200)." becomes "Payment is due in 30 days.". `names` gives each
 * document ID's file name; `content` is text of the files the model read (`addContent`). New in 0.99.12.
 */
export function hideCitations(text: string, names: Record<string, string> = {}, content: readonly string[] = []): string {
  const hider = new CitationHider(names, content);
  return hider.push(text) + hider.flush();
}
