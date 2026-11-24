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

/** Where a file name is written in the text, and the documents of that name. */
type Named = { start: number; end: number; ids: string[] };

/** Not a letter, a digit or "_" before or after: the edge of a word, in any script. */
const EDGE_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const EDGE_AFTER = String.raw`(?![\p{L}\p{N}_])`;
/** The second number of a range: "12-14", "12–14", "12 to 14", "12 עד 14". */
const RANGE_END = String.raw`(?:\s*[-–—]\s*|\s+(?:to|עד)\s+)`;

/**
 * The forms of a citation, each with the numbers it names:
 * - "L12", "L12-14", "L12-L14": lines, as the tools and the closing request write them;
 * - "line 12", "lines 12-14": lines, in words;
 * - "Row 12": a row, which for a workbook may be Excel's row and not a line;
 * - "שורה 12", "שורות 12-14", with a prefix letter ("בשורה 12") or "מס'": in Hebrew "שורה" is
 *   both a line and a row.
 */
const FORMS: Array<{ pattern: RegExp; form: "line" | "row"; bare: boolean }> = [
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}L(\d{1,9})(?:${RANGE_END}L?(\d{1,9}))?${EDGE_AFTER}`, "gu"), form: "line", bare: true },
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}[Ll]ines?\s+(\d{1,9})(?:${RANGE_END}(\d{1,9}))?${EDGE_AFTER}`, "gu"), form: "line", bare: false },
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}[Rr]ows?\s+(\d{1,9})(?:${RANGE_END}(\d{1,9}))?${EDGE_AFTER}`, "gu"), form: "row", bare: false },
  { pattern: new RegExp(String.raw`${EDGE_BEFORE}[בלמוהכש]{0,2}שור(?:ה|ות)\s+(?:(?:מס['׳]?|מספר)\s*)?(\d{1,9})(?:${RANGE_END}(\d{1,9}))?${EDGE_AFTER}`, "gu"), form: "row", bare: false },
];

/** How far, in characters on one line, a file name may be from the citation it goes with. */
const NAME_DISTANCE = 40;

/** A text for a regular expression that matches it as it is. */
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every citation of `text`, in order. One place in the text is one citation, of the first form that reads it. */
function citationsIn(text: string): Cited[] {
  const found: Cited[] = [];
  for (const { pattern, form, bare } of FORMS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (found.some((other) => start < other.end && other.start < end)) continue;
      const first = Number(match[1]);
      const second = match[2] === undefined ? first : Number(match[2]);
      if (first < 1 || second < 1) continue;
      found.push({ start, end, from: Math.min(first, second), to: Math.max(first, second), form, bare });
    }
  }
  return found.sort((left, right) => left.start - right.start);
}

/**
 * Where the documents' names are written in `text`: each name whole, and without its extension
 * when what is left has 3 characters or more ("report" for "report.docx"). A Hebrew prefix letter
 * may come before it ("בדוח.docx"). Where two overlap, the longer one is taken.
 */
function namesIn(text: string, names: Map<string, string[]>): Named[] {
  const aliases = new Map<string, Set<string>>();
  const alias = (name: string, ids: string[]) => {
    const key = name.toLocaleLowerCase();
    const known = aliases.get(key) ?? new Set<string>();
    for (const id of ids) known.add(id);
    aliases.set(key, known);
  };
  for (const [name, ids] of names) {
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
      hits.push({ start, end, ids: [...ids] });
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

/** The parentheses around `at`, on its line: their start and end, or undefined when it is not inside any. */
function parenthesesAround(text: string, start: number, end: number): [number, number] | undefined {
  let open = -1;
  for (let index = start - 1; index >= 0; index--) {
    const character = text[index];
    if (character === "\n" || character === ")") return undefined;
    if (character === "(") {
      open = index;
      break;
    }
  }
  if (open < 0) return undefined;
  for (let index = end; index < text.length; index++) {
    const character = text[index];
    if (character === "\n" || character === "(") return undefined;
    if (character === ")") return [open, index + 1];
  }
  return undefined;
}

/** True when nothing between `from` and `to` breaks the line, and they are close enough. */
const near = (text: string, from: number, to: number) => to - from <= NAME_DISTANCE && !text.slice(from, to).includes("\n");

/**
 * The name a citation goes with: one inside the same parentheses (the last before it, else the
 * first after it), else the nearest before it on its line, else the nearest after it.
 */
function nameOf(text: string, cited: Cited, named: Named[]): Named | undefined {
  const around = parenthesesAround(text, cited.start, cited.end);
  if (around) {
    const inside = named.filter((hit) => hit.start >= around[0] && hit.end <= around[1]);
    const before = inside.filter((hit) => hit.end <= cited.start).at(-1);
    if (before) return before;
    const after = inside.find((hit) => hit.start >= cited.end);
    if (after) return after;
  }
  const before = named.filter((hit) => hit.end <= cited.start).at(-1);
  if (before && near(text, before.end, cited.start)) return before;
  const after = named.find((hit) => hit.start >= cited.end);
  if (after && near(text, cited.end, after.start)) return after;
  return undefined;
}

/** The first line of `from`-`to` that `shown` does not hold, or undefined when it holds them all. */
function firstNotShown(shown: NumberRange[] | "whole", from: number, to: number): number | undefined {
  if (shown === "whole") return undefined;
  let line = from;
  for (const [first, last] of shown) {
    if (last < line) continue;
    if (first > line) return line;
    line = last + 1;
    if (line > to) return undefined;
  }
  return line;
}

/**
 * Finds the line citations of `text` ("(name L12)", "(name L12-14)", "name L12", "line 12", "Row
 * 12", and the Hebrew "שורה 12" and "שורות 12-14") and checks them against `evidence`. `names`
 * gives each document ID's file name, and `formats` its format.
 *
 * A citation goes with the file name next to it: in the same parentheses, or on the same line
 * within 40 characters, before or after it. With one file it may have none. A bare "L12" with no
 * name next to it counts only inside parentheses ("(L12)"): "L2 cache" is no citation. A citation
 * is supported when every line it names was shown: by the lines of an evidence entry of that
 * document, or by an entry with `whole` (a file read whole, or sent whole). Two documents of one
 * name support it by either. A row ("Row 12", "שורה 12") of a workbook (XLSX) is unchecked: it may
 * be Excel's row, which is not the line. New in 0.10.0.
 */
export function checkCitations(text: string, evidence: Evidence[], names: Record<string, string>, formats?: Record<string, DocumentFormat>): CitationCheck {
  const check: CitationCheck = { checked: 0, supported: 0, unchecked: 0, unsupported: [] };
  if (typeof text !== "string" || !text) return check;
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
    if (entry.whole === true) shown.set(entry.documentId, "whole");
    else if (entry.lines?.length) shown.set(entry.documentId, mergeRanges([...before ?? [], ...entry.lines]));
  }
  const only = nameById.size === 1 ? [...nameById.keys()] : undefined;
  const named = namesIn(text, byName);
  for (const cited of citationsIn(text)) {
    // A part of a file name ("report-L3.docx") is not a citation.
    if (named.some((hit) => cited.start < hit.end && hit.start < cited.end)) continue;
    const hit = nameOf(text, cited, named);
    if (!hit && cited.bare && !parenthesesAround(text, cited.start, cited.end)) continue;
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
