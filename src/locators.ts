// Where a cited line is in the original file: a workbook's sheet and Excel row, a CSV row, a PDF
// page, a slide, a section and clause, a log line (CIT-1, CIT-5). A locator says only what is
// certain: an unknown part is left out, and it is never taken from the nearest outline entry, from
// the line before, or from a default. When nothing narrower than the file is certain, it is
// `{ kind: "document" }`. New in 0.99.14.
//
// Every input is passed in: the stored text of a document and its metadata, the page index of a PDF,
// the tool evidence and `aggregate_table` results of the question, and the claim written around
// the citation. Nothing here reads a store or waits.
import type { Evidence } from "./evidence.js";
import type { SourceBasis, SourceLocator } from "./sources.js";
import type { DocumentFormat, DocumentMeta } from "./types.js";

/** The newest version of the extractors' text this file knows (`DocumentMeta.textVersion`). */
export const KNOWN_TEXT_VERSION = 1;
/** More parts than this (a range across sheets) give the document. */
export const MAX_LOCATOR_PARTS = 4;

type RowLocator = Extract<SourceLocator, { kind: "row" }>;
type SheetLocator = Extract<SourceLocator, { kind: "sheet" }>;
type SectionLocator = Extract<SourceLocator, { kind: "section" }>;
type LineLocatorKind = Extract<SourceLocator, { kind: "line" }>;
type SlideLocator = Extract<SourceLocator, { kind: "slide" }>;
type PageLocator = Extract<SourceLocator, { kind: "page" }>;

const documentLocator = (): SourceLocator => ({ kind: "document" });

/** The index of the last item whose key is `value` or less, or -1. Items are in order of their key. */
function lastAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (key(items[middle]!) <= value) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** How many of the sorted values are below `value`. */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The grammar of the stored text, as src/xlsx.ts, src/office.ts, src/extract.ts and src/analyze.ts write it.
const SHEET_HEADING = /^## Sheet (\d+): (.*?)( \(hidden sheet\))?$/;
const ROW_LINE = /^Row (\d+): \|/;
const COLUMNS_LINE = /^Columns: /;
const NO_VALUES = "[No values on this sheet]";
const SLIDE_HEADING = /^## Slide (\d+)(?:\s.*)?$/;
const SPEAKER_NOTES = "[Speaker notes]";
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

type Heading = { line: number; level: number; title: string; path: string[]; ids: number[] };

/** A heading by the outline's rules (`outlineEntry` in src/analyze.ts), with no cap: a "#" heading of any length. */
function headingOf(lines: readonly string[], index: number): { line: number; level: number; title: string } | undefined {
  const line = (lines[index] ?? "").trim();
  if (!line) return undefined;
  const previousBlank = index === 0 || !(lines[index - 1] ?? "").trim();
  const markdown = /^(#{1,6})\s+(.+)$/.exec(line);
  if (markdown) return { line: index + 1, level: markdown[1]!.length, title: markdown[2]!.trim() };
  if (line.length > 120) return undefined;
  if (/^(chapter|part|book|section|appendix|פרק|חלק|נספח)(?=[\s:.\d]|$)/iu.test(line) && previousBlank) {
    return { line: index + 1, level: /^(part|book|חלק)(?=[\s:.\d]|$)/iu.test(line) ? 1 : 2, title: line };
  }
  if (/^\d+(\.\d+){0,2}\s+\S/.test(line) && previousBlank && line.length <= 80 && !/[.:;,]$/.test(line)) {
    return { line: index + 1, level: (line.split(" ")[0]!.match(/\./g)?.length ?? 0) + 2, title: line };
  }
  if (previousBlank && line.length >= 4 && line.length <= 60 && /\p{Lu}/u.test(line) && line === line.toUpperCase() && /\p{L}{3}/u.test(line)) {
    return { line: index + 1, level: 2, title: line };
  }
  return undefined;
}

const HEBREW_NUMERAL = String.raw`(?:[א-ט]|י[א-ט]?|טו|טז|[כלמנסעפצ][א-ט]?|[קרשת])`;
const NUMBERING = new RegExp(String.raw`^(?:#{1,6}\s+|[-*+]\s+)?(?:(\d+(?:\.\d+)+)\.?|(\d+)[.)]|\((\d+|${HEBREW_NUMERAL}|[a-z]|[ivx]{1,4})\)|(${HEBREW_NUMERAL})[.)]|([a-z]|[ivx]{1,4})[.)]|סעיף\s+(\d+(?:\.\d+)*)[.:]?)(?=\s)`, "u");

/**
 * The clause number written at the start of `line` itself: "3.1 …", "5. …", "12) …", "(ב) …",
 * "ג. …", "a) …", "iv. …", after a Markdown heading's "#"s or a list bullet, or "סעיף 7 …". Never
 * taken from a line above.
 */
export function numberingOf(line: string | undefined): string | undefined {
  const match = NUMBERING.exec((line ?? "").trimStart());
  if (!match) return undefined;
  return match.slice(1).find((part) => part !== undefined);
}

const TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
/** A time written in the first 120 characters of the line itself. */
export function timeOf(line: string | undefined): string | undefined {
  return TIME.exec((line ?? "").slice(0, 120))?.[0];
}

/** What a document's locators are found from: its stored text and metadata, and a PDF's page index. */
export type LocatorDocument = { meta: DocumentMeta; text?: string; pageStarts?: ArrayLike<number> };

/**
 * The section tables of one document, derived once (`deriveLocatorTables`): its sheets and their
 * rows, slides and notes markers, pages, CSV records or headings. Read only through this module.
 */
export type LocatorTables = {
  readonly format: DocumentFormat;
  readonly lineCount: number;
  /** The stored text's lines, when it was in hand. */
  readonly lines: readonly string[] | undefined;
  readonly textVersion: number;
  readonly wrappedLines: number;
  readonly splitLines: readonly number[] | undefined;
  readonly continuation: ReadonlySet<number> | undefined;
  readonly wrapsKnown: boolean;
  basis: SourceBasis;
  sheets: Array<{ line: number; index: number; name: string; hidden: boolean }>;
  rowOfLine: Map<number, { row: number; sheet: number }>;
  sheetRows: Map<number, Map<number, number>>;
  slides: Array<{ line: number; index: number }>;
  markersInSlide: Map<number, number[]>;
  notes: Map<number, number>;
  pages: number[];
  records: Array<{ line: number; row: number }>;
  csvReliable: boolean;
  csvReason: string | undefined;
  headings: Heading[];
  headingsComplete: boolean;
};

/** A workbook's or deck's outline lists exactly `meta.pages` sheets or slides, numbered 1 to N. */
function outlineNumbersParts(meta: DocumentMeta, word: string): boolean {
  if (!Array.isArray(meta.outline) || typeof meta.pages !== "number" || meta.outline.length !== meta.pages) return false;
  return meta.outline.every((entry, index) => new RegExp(`^${word} ${index + 1}(?::|$| )`).test(entry.title));
}

/** Sorted, distinct positive integers of a meta field, or undefined. */
function lineList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines = value.filter((line): line is number => Number.isSafeInteger(line) && line >= 1);
  return [...new Set(lines)].sort((left, right) => left - right);
}

/**
 * The locator tables of one document, from its stored text (one pass), or without the text from
 * a list known to be complete: a workbook's or deck's outline that numbers exactly `meta.pages`
 * sheets or slides, or an outline of fewer than 400 headings. A PDF's pages come from `pageStarts`
 * (the text index) when given. The lines split at 2,000 characters and the speaker-notes markers
 * come from what ingest recorded (`DocumentMeta.lineSplits`, `DocumentMeta.notesLines`): without
 * them, what they would say stays unknown.
 */
export function deriveLocatorTables(document: LocatorDocument): LocatorTables {
  const { meta, pageStarts } = document;
  const lines = typeof document.text === "string" ? document.text.split("\n") : undefined;
  const format = meta.format;
  const lineCount = typeof meta.lines === "number" ? meta.lines : lines?.length ?? 0;
  const splitLines = lineList(meta.lineSplits);
  const wrappedLines = typeof meta.wrappedLines === "number" ? meta.wrappedLines : 0;
  const continuation = splitLines ? new Set(splitLines) : undefined;
  const t: LocatorTables = {
    format,
    lineCount,
    lines,
    textVersion: typeof meta.textVersion === "number" ? meta.textVersion : 1,
    wrappedLines,
    splitLines,
    continuation,
    wrapsKnown: wrappedLines === 0 || Boolean(splitLines),
    basis: lines ? "text" : "none",
    sheets: [],
    rowOfLine: new Map(),
    sheetRows: new Map(),
    slides: [],
    markersInSlide: new Map(),
    notes: new Map(),
    pages: [],
    records: [],
    csvReliable: false,
    csvReason: undefined,
    headings: [],
    headingsComplete: false,
  };
  if (format === "xlsx") {
    if (lines) {
      let sheet = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const heading = SHEET_HEADING.exec(line);
        // A sheet heading comes first or after a blank line, and counts up: a cell cannot fake it.
        if (heading && Number(heading[1]) === sheet + 1 && (i === 0 || lines[i - 1] === "") && !continuation?.has(i + 1)) {
          sheet++;
          t.sheets.push({ line: i + 1, index: sheet, name: heading[2]!, hidden: Boolean(heading[3]) });
          t.sheetRows.set(sheet, new Map());
          continue;
        }
        if (sheet === 0 || continuation?.has(i + 1)) continue;
        const row = ROW_LINE.exec(line);
        if (row) {
          t.rowOfLine.set(i + 1, { row: Number(row[1]), sheet });
          const rows = t.sheetRows.get(sheet)!;
          if (!rows.has(Number(row[1]))) rows.set(Number(row[1]), i + 1);
        }
      }
    } else if (outlineNumbersParts(meta, "Sheet")) {
      t.basis = "outline";
      for (const entry of meta.outline) {
        const match = /^Sheet (\d+): (.*)$/.exec(entry.title);
        if (!match) continue;
        t.sheets.push({ line: entry.line, index: Number(match[1]), name: match[2]!.replace(/ \(hidden sheet\)$/, ""), hidden: / \(hidden sheet\)$/.test(match[2]!) });
      }
    } else t.basis = "none";
  } else if (format === "pptx") {
    if (lines) {
      let slide = 0;
      for (let i = 0; i < lines.length; i++) {
        const heading = SLIDE_HEADING.exec(lines[i]!);
        if (heading && Number(heading[1]) === slide + 1 && (i === 0 || lines[i - 1] === "")) {
          slide++;
          t.slides.push({ line: i + 1, index: slide });
          continue;
        }
        if (slide > 0 && lines[i] === SPEAKER_NOTES) t.markersInSlide.set(slide, [...t.markersInSlide.get(slide) ?? [], i + 1]);
      }
    } else if (outlineNumbersParts(meta, "Slide")) {
      t.basis = "outline";
      for (const entry of meta.outline) t.slides.push({ line: entry.line, index: Number(/^Slide (\d+)/.exec(entry.title)![1]) });
    } else t.basis = "none";
    // Notes only with clear evidence: the marker ingest recorded. The text alone cannot tell a real
    // marker from a slide that writes "[Speaker notes]" itself.
    for (const marker of lineList(meta.notesLines) ?? []) {
      const at = lastAtOrBefore(t.slides, marker, (slide) => slide.line);
      if (at >= 0) t.notes.set(t.slides[at]!.index, marker);
    }
  } else if (format === "pdf") {
    if (pageStarts && pageStarts.length) {
      t.pages = Array.from(pageStarts);
      t.basis = "pages";
    } else if (lines) {
      for (let i = 0; i < lines.length; i++) if (lines[i] === `--- Page ${t.pages.length + 1} ---`) t.pages.push(i + 1);
    } else t.basis = "none";
  } else if (format === "csv") {
    if (lines && t.wrapsKnown) {
      // Excel's rows: one per record; a quoted field may hold line breaks; a blank line is a row.
      let open = false;
      let row = 0;
      for (let i = 0; i < lines.length && i < lineCount; i++) {
        if (!open && !continuation?.has(i + 1)) {
          row++;
          t.records.push({ line: i + 1, row });
        }
        let quotes = 0;
        for (const character of lines[i]!) if (character === '"') quotes++;
        if (quotes % 2 === 1) open = !open;
      }
      // A file that ends inside a quote was not read as a CSV parser reads it: no row is certain.
      t.csvReliable = !open;
      t.csvReason = open ? "csv_quote_never_closed" : undefined;
    } else t.csvReason = lines ? "csv_lines_split" : "no_text";
  } else if (format === "docx" || format === "markdown" || format === "html") {
    const found: Array<{ line: number; level: number; title: string }> = [];
    if (lines) {
      let fence: string | undefined;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const mark = FENCE.exec(line)?.[1];
        if (fence !== undefined) {
          if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = undefined;
          continue;
        }
        if (mark) {
          fence = mark;
          continue;
        }
        const heading = headingOf(lines, i);
        if (heading) found.push(heading);
      }
      t.headingsComplete = true;
    } else if (Array.isArray(meta.outline) && meta.outline.length < 400) {
      // Complete only below the 400 cap (a heading over 120 characters is still absent).
      for (const entry of meta.outline) found.push({ line: entry.line, level: entry.level, title: entry.title });
      t.headingsComplete = true;
      t.basis = "outline";
    }
    // The path of each heading: its nearest heading above of each lower level.
    const stack: Heading[] = [];
    for (const entry of found) {
      while (stack.length && stack.at(-1)!.level >= entry.level) stack.pop();
      const heading: Heading = { ...entry, path: [...stack.map((above) => above.title), entry.title], ids: [...stack.map((above) => above.line), entry.line] };
      t.headings.push(heading);
      stack.push(heading);
    }
  }
  return t;
}

const isSheetOnlyLine = (line: string | undefined) => line === "" || line === undefined || COLUMNS_LINE.test(line) || line === NO_VALUES || SHEET_HEADING.test(line);

/** The physical line of a text line: its start, less the pieces of split lines before it, when that is known. */
function physicalLine(t: LocatorTables, n: number): number | undefined {
  if (t.wrappedLines === 0) return n;
  if (!t.splitLines || !t.continuation) return undefined;
  let start = n;
  while (t.continuation.has(start) && start > 1) start--;
  return start - countBelow(t.splitLines, start + 1);
}

/** What one text line gives: its locator, why, from what, and for a section the lines of its headings. */
export type LineLocation = { locator: SourceLocator; reason: string; basis: SourceBasis; headingIds?: number[] };

/** The locator of one text line `n` of a document. */
export function locatorOfLine(t: LocatorTables, n: number): LineLocation {
  if (!(n >= 1 && n <= t.lineCount)) return { locator: documentLocator(), reason: "past_end", basis: "none" };
  const text = t.lines?.[n - 1];
  const coarseOnly = t.textVersion > KNOWN_TEXT_VERSION;
  switch (t.format) {
    case "xlsx": {
      const at = lastAtOrBefore(t.sheets, n, (sheet) => sheet.line);
      if (at < 0) return { locator: documentLocator(), reason: t.sheets.length ? "before_first_sheet" : "no_sheet_table", basis: "none" };
      const sheet = t.sheets[at]!;
      const sheetLocator: SheetLocator = { kind: "sheet", sheetIndex: sheet.index, sheet: sheet.name };
      if (coarseOnly) return { locator: sheetLocator, reason: "text_version_unknown", basis: t.basis };
      if (t.basis !== "text") return { locator: sheetLocator, reason: "sheet_from_outline", basis: t.basis };
      const own = t.rowOfLine.get(n);
      if (own) return { locator: { kind: "row", sheetIndex: sheet.index, sheet: sheet.name, row: own.row }, reason: "row_prefix", basis: "text" };
      if (t.continuation) {
        if (!t.continuation.has(n)) return { locator: sheetLocator, reason: "sheet_line", basis: "text" };
      } else if (isSheetOnlyLine(text) || t.wrappedLines === 0) {
        return { locator: sheetLocator, reason: isSheetOnlyLine(text) ? "sheet_line" : "not_a_row_line", basis: "text" };
      }
      // A piece of a row split at 2,000 characters: back to the line where the row starts.
      let m = n - 1;
      while (m > sheet.line && !t.rowOfLine.has(m) && (t.continuation ? t.continuation.has(m) : !isSheetOnlyLine(t.lines?.[m - 1]))) m--;
      const start = t.rowOfLine.get(m);
      if (start && start.sheet === sheet.index && (t.continuation ? true : !isSheetOnlyLine(text))) {
        return { locator: { kind: "row", sheetIndex: sheet.index, sheet: sheet.name, row: start.row }, reason: "row_continuation", basis: t.continuation ? "ingest" : "text" };
      }
      return { locator: sheetLocator, reason: "continuation_without_row", basis: "text" };
    }
    case "pptx": {
      const at = lastAtOrBefore(t.slides, n, (slide) => slide.line);
      if (at < 0) return { locator: documentLocator(), reason: t.slides.length ? "before_first_slide" : "no_slide_table", basis: "none" };
      const slide = t.slides[at]!;
      const marker = t.notes.get(slide.index);
      if (!coarseOnly && marker !== undefined && n > marker) return { locator: { kind: "slide", slide: slide.index, notes: true }, reason: "slide_notes", basis: "ingest" };
      const written = (t.markersInSlide.get(slide.index) ?? []).some((line) => line < n);
      return { locator: { kind: "slide", slide: slide.index }, reason: written && marker === undefined ? "slide_notes_unknown" : "slide", basis: t.basis };
    }
    case "pdf": {
      const at = lastAtOrBefore(t.pages, n, (line) => line);
      if (at < 0) return { locator: documentLocator(), reason: t.pages.length ? "before_first_page_marker" : "no_page_markers", basis: "none" };
      return { locator: { kind: "page", page: at + 1 }, reason: "page_marker", basis: t.basis };
    }
    case "csv": {
      if (coarseOnly) return { locator: documentLocator(), reason: "text_version_unknown", basis: "none" };
      if (!t.csvReliable) return { locator: documentLocator(), reason: t.csvReason ?? "csv_rows_unknown", basis: "none" };
      const at = lastAtOrBefore(t.records, n, (record) => record.line);
      if (at < 0) return { locator: documentLocator(), reason: "csv_rows_unknown", basis: "none" };
      const record = t.records[at]!;
      return { locator: { kind: "row", row: record.row }, reason: record.line === n ? "csv_record" : "csv_record_continuation", basis: t.continuation ? "ingest" : "text" };
    }
    case "docx":
    case "markdown":
    case "html": {
      if (coarseOnly) return { locator: documentLocator(), reason: "text_version_unknown", basis: "none" };
      const at = t.headingsComplete ? lastAtOrBefore(t.headings, n, (heading) => heading.line) : -1;
      const heading = at >= 0 ? t.headings[at] : undefined;
      const numbering = text !== undefined ? numberingOf(text) : undefined;
      if (!heading && numbering === undefined) return { locator: documentLocator(), reason: t.headingsComplete ? "no_heading_no_number" : "headings_unknown", basis: "none" };
      return {
        locator: { kind: "section", ...(heading ? { headings: [...heading.path] } : {}), ...(numbering !== undefined ? { numbering } : {}) },
        reason: heading && numbering !== undefined ? "heading_path_and_number" : heading ? "heading_path" : "clause_prefix",
        basis: heading ? t.basis : "text",
        headingIds: heading ? heading.ids : [],
      };
    }
    case "log":
    case "text":
    case "json": {
      const line = coarseOnly ? undefined : physicalLine(t, n);
      const time = text !== undefined ? timeOf(text) : undefined;
      if (line === undefined && time === undefined) return { locator: documentLocator(), reason: "line_unknown_no_time", basis: "none" };
      return {
        locator: { kind: "line", ...(line !== undefined ? { line } : {}), ...(time !== undefined ? { time } : {}) },
        reason: line === undefined ? "time_only_lines_split" : time !== undefined ? "line_and_time" : "line",
        basis: t.wrappedLines === 0 ? "text" : "ingest",
      };
    }
    default:
      return { locator: documentLocator(), reason: "format_without_locator", basis: "none" };
  }
}

/** What a range of text lines gives: 1 to 4 parts, why, from what; `unresolved` when it runs past the end. */
export type RangeLocation = { locators: SourceLocator[]; reason: string; basis: SourceBasis; unresolved?: true };

/** The locators of text lines `from` to `to` of a document. */
export function locatorsOfRange(t: LocatorTables, from: number, to: number): RangeLocation {
  if (!(from >= 1 && from <= t.lineCount)) return { locators: [documentLocator()], reason: "past_end", basis: "none", unresolved: true };
  if (!(to <= t.lineCount)) return { locators: [documentLocator()], reason: "range_past_end", basis: "none", unresolved: true };
  if (from === to) {
    const one = locatorOfLine(t, from);
    return { locators: [one.locator], reason: one.reason, basis: one.basis };
  }
  const first = locatorOfLine(t, from);
  const last = locatorOfLine(t, to);
  switch (t.format) {
    case "xlsx": {
      // One part per sheet the range crosses; rows inside one sheet become row..toRow.
      type Part = { sheetIndex: number; sheet?: string; row?: number; toRow?: number };
      const parts: Part[] = [];
      let basis: SourceBasis = "text";
      for (let n = from; n <= to; n++) {
        const { locator, reason, basis: lineBasis } = locatorOfLine(t, n);
        if (lineBasis === "ingest") basis = "ingest";
        if (locator.kind === "document") return { locators: [documentLocator()], reason, basis: "none" };
        const sheetIndex = (locator as RowLocator | SheetLocator).sheetIndex!;
        let part = parts.find((one) => one.sheetIndex === sheetIndex);
        if (!part) {
          part = { sheetIndex, ...((locator as SheetLocator).sheet !== undefined ? { sheet: (locator as SheetLocator).sheet! } : {}) };
          parts.push(part);
        }
        if (locator.kind === "row") {
          if (part.row === undefined) {
            part.row = locator.row;
            part.toRow = locator.row;
          } else {
            part.row = Math.min(part.row, locator.row);
            part.toRow = Math.max(part.toRow!, locator.row);
          }
        }
        if (parts.length > MAX_LOCATOR_PARTS) return { locators: [documentLocator()], reason: "more_than_4_parts", basis: "none" };
      }
      const locators: SourceLocator[] = parts.map((part) => (part.row !== undefined
        ? { kind: "row", sheetIndex: part.sheetIndex, ...(part.sheet !== undefined ? { sheet: part.sheet } : {}), row: part.row, ...(part.toRow !== part.row ? { toRow: part.toRow! } : {}) }
        : { kind: "sheet", sheetIndex: part.sheetIndex, ...(part.sheet !== undefined ? { sheet: part.sheet } : {}) }));
      const reason = parts.length > 1 ? "range_across_sheets" : locators[0]!.kind === "row" ? "row_range" : "sheet_range";
      return { locators, reason, basis: first.basis === "outline" ? "outline" : basis };
    }
    case "pptx": {
      if (first.locator.kind === "document" || last.locator.kind === "document") return { locators: [documentLocator()], reason: first.locator.kind === "document" ? first.reason : last.reason, basis: "none" };
      const a = first.locator as SlideLocator;
      const b = last.locator as SlideLocator;
      const notes = a.notes && b.notes && a.slide === b.slide;
      const locator: SlideLocator = { kind: "slide", slide: a.slide, ...(b.slide !== a.slide ? { toSlide: b.slide } : {}), ...(notes ? { notes: true as const } : {}) };
      return { locators: [locator], reason: locator.toSlide ? "slide_range" : notes ? "slide_notes" : "slide", basis: first.basis };
    }
    case "pdf": {
      if (first.locator.kind === "document") return { locators: [documentLocator()], reason: first.reason, basis: "none" };
      const a = first.locator as PageLocator;
      const b = last.locator as PageLocator;
      const locator: PageLocator = { kind: "page", page: a.page, ...(b.page !== a.page ? { toPage: b.page } : {}) };
      return { locators: [locator], reason: locator.toPage ? "page_range" : "page_marker", basis: first.basis };
    }
    case "csv": {
      if (first.locator.kind === "document" || last.locator.kind === "document") return { locators: [documentLocator()], reason: first.reason, basis: "none" };
      const a = first.locator as RowLocator;
      const b = last.locator as RowLocator;
      const locator: RowLocator = { kind: "row", row: a.row, ...(b.row !== a.row ? { toRow: b.row } : {}) };
      return { locators: [locator], reason: locator.toRow ? "csv_record_range" : "csv_record", basis: first.basis };
    }
    case "docx":
    case "markdown":
    case "html": {
      // The headings the whole range is under (the common ones), and the clause numbers of its two
      // ends when each end's own line starts with one.
      const a = first.locator as SectionLocator;
      const b = last.locator as SectionLocator;
      const aIds = a.headings ? first.headingIds ?? [] : [];
      const bIds = b.headings ? last.headingIds ?? [] : [];
      const path: string[] = [];
      for (let i = 0; i < Math.min(aIds.length, bIds.length) && aIds[i] === bIds[i]; i++) path.push(a.headings![i]!);
      const na = first.locator.kind === "section" ? a.numbering : undefined;
      const nb = last.locator.kind === "section" ? b.numbering : undefined;
      const numbering = na === undefined ? undefined : nb !== undefined && nb !== na ? `${na}-${nb}` : na;
      if (!path.length && numbering === undefined) return { locators: [documentLocator()], reason: "no_common_heading_no_number", basis: "none" };
      return {
        locators: [{ kind: "section", ...(path.length ? { headings: path } : {}), ...(numbering !== undefined ? { numbering } : {}) }],
        reason: path.length && numbering !== undefined ? "heading_path_and_number" : path.length ? "heading_path" : "clause_prefix",
        basis: path.length ? first.basis : "text",
      };
    }
    case "log":
    case "text":
    case "json": {
      const a = first.locator.kind === "line" ? (first.locator as LineLocatorKind) : undefined;
      const b = last.locator.kind === "line" ? (last.locator as LineLocatorKind) : undefined;
      const line = a?.line;
      const toLine = b?.line;
      const time = a?.time;
      if (line === undefined && time === undefined) return { locators: [documentLocator()], reason: "line_unknown_no_time", basis: "none" };
      return {
        locators: [{ kind: "line", ...(line !== undefined ? { line } : {}), ...(line !== undefined && toLine !== undefined && toLine !== line ? { toLine } : {}), ...(time !== undefined ? { time } : {}) }],
        reason: line === undefined ? "time_only_lines_split" : "line_range",
        basis: first.basis,
      };
    }
    default:
      return { locators: [documentLocator()], reason: "format_without_locator", basis: "none" };
  }
}

/** A removed span of the model's text: `[rawStart, rawEnd)`. */
export type RemovedSpan = { rawStart: number; rawEnd: number };

/**
 * The claim around a removed span `[start, end)` of the model's text, on its line: from the end
 * of the previous removed span (or the line's start) to it, and from it to the next removed span
 * (or the line's end). `removed` are the answer's removed spans.
 */
export function claimAround(text: string, start: number, end: number, removed: readonly RemovedSpan[] = []): { before: string; after: string } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = text.length;
  let from = lineStart;
  let to = lineEnd;
  for (const span of removed) {
    if (span.rawEnd <= start && span.rawEnd > from) from = span.rawEnd;
    if (span.rawStart >= end && span.rawStart < to) to = span.rawStart;
  }
  return { before: text.slice(from, start), after: text.slice(end, to) };
}

const normalized = (text: string | undefined) => (text ?? "").normalize("NFC").replace(/[‎‏‪-‮⁦-⁩؜֑-ׇ]/g, "").replace(/(?<=\d),(?=\d{3})/g, "");

/** The cells of a line a claim can name: those with a number of 2 or more digits, or of several words. */
function cellsOf(line: string | undefined): string[] {
  return (line ?? "").replace(/^Row \d+:/, "").split(/[|,]/).map((cell) => normalized(cell.trim())).filter((cell) => cell.length >= 2 && (/\d{2,}/.test(cell) || /\s/.test(cell)));
}

/** How many such cells of `lines` the claim holds. */
function cellScore(claim: string, lines: readonly string[]): number {
  const written = normalized(claim);
  const seen = new Set<string>();
  let score = 0;
  for (const text of lines) {
    for (const cell of cellsOf(text)) {
      if (!seen.has(cell) && written.includes(cell)) {
        seen.add(cell);
        score++;
      }
    }
  }
  return score;
}

type Written = { value: number; decimals: number };
/** The numbers written in a text, as values: "15,508" is 15508, "$32,133" 32133, "87%" 87, with their decimals. */
function numbersIn(text: string): Written[] {
  const out: Written[] = [];
  for (const match of normalized(text).matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d])/g)) out.push({ value: Number(match[0]), decimals: (match[0].split(".")[1] ?? "").length });
  return out;
}
const sameNumber = (written: Written, value: number) => Number.isFinite(value) && Math.abs(Number(value.toFixed(written.decimals)) - written.value) < 1e-9;

/**
 * The content check for a document among several of one name: the claim's numbers (2 or more
 * digits, or with decimals) on the cited lines; with none in the claim, two of its words of 3 or
 * more letters.
 */
function contentHolds(claim: string, lines: readonly string[]): boolean {
  const text = normalized(lines.join("\n"));
  const numbers = numbersIn(claim).filter((number) => number.decimals > 0 || number.value >= 10);
  if (numbers.length) {
    const onLines = numbersIn(text);
    return numbers.some((number) => onLines.some((line) => line.value === number.value));
  }
  const words = [...new Set(normalized(claim).match(/[\p{L}]{3,}/gu) ?? [])];
  return words.filter((word) => text.includes(word)).length >= 2;
}

const EXAMPLE_LEAD_IN = /לדוגמה|לדוגמא|למשל|(?<![\p{L}])e\.?g\.?(?![\p{L}])|for example|for instance/iu;

/** The words of a text, lowercase, numbers without thousands commas: for the claim check of option B. */
function wordsOf(text: string | undefined): Set<string> {
  return new Set(((text ?? "").normalize("NFC").replace(/[‎‏‪-‮⁦-⁩؜]/g, "").replace(/(?<=\d),(?=\d{3})/g, "").toLowerCase().match(/[\p{L}\p{N}]+(?:[.\-][\p{L}\p{N}]+)*/gu)) ?? []);
}
/** The cells of a workbook row line whose every word is a word of the claim. */
function cellHits(claimWords: ReadonlySet<string>, line: string | undefined): number {
  const cells = (line ?? "").replace(/^Row \d+:\s*/, "").split("|").map((cell) => cell.trim()).filter((cell) => cell.length >= 2);
  return cells.filter((cell) => {
    const words = [...wordsOf(cell)];
    return words.length > 0 && words.every((word) => claimWords.has(word));
  }).length;
}

const linesOfRange = (t: LocatorTables, from: number, to: number): string[] => {
  const out: string[] = [];
  for (let n = from; n <= Math.min(to, t.lineCount); n++) out.push(t.lines?.[n - 1] ?? "");
  return out;
};

/** A citation as `checkCitations` reads it, with every document ID of the file name it goes with. */
export type CitationToResolve = {
  /** The document `checkCitations` gave it, when one. */
  documentId?: string;
  /** Every document of the question with the file name it goes with (several when two files share a name; none when no name). */
  ids: readonly string[];
  from: number;
  to: number;
  form: "line" | "row";
  /** The citation as it is written ("Row 7", "שורה 7"): an English "Row N" is Excel's row N. */
  written?: string;
};

/** What `aggregate_table` returned, as CIT-5 reads it: each group's numbers and the lines of its first rows. */
export type AggregateSide = { callId: string; documentId: string; groups: Array<{ values: number[]; lines: number[] }> };

/**
 * The `AggregateSide` of an `aggregate_table` call, read from its result as the tool returns it
 * (`groups: [{ group?, <metric>: value, rows?, lines }]`), or undefined for a result without groups
 * (an error, or a result cut to fit).
 */
export function aggregateSideOf(callId: string, documentId: string, result: unknown): AggregateSide | undefined {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { groups?: unknown }).groups)) return undefined;
  const groups: AggregateSide["groups"] = [];
  for (const group of (value as { groups: unknown[] }).groups) {
    if (!group || typeof group !== "object") continue;
    const lines = Array.isArray((group as { lines?: unknown }).lines) ? ((group as { lines: unknown[] }).lines.filter((line): line is number => Number.isSafeInteger(line))) : [];
    const values = Object.entries(group).filter(([key, one]) => key !== "lines" && key !== "group" && typeof one === "number").map(([, one]) => one as number);
    groups.push({ values, lines });
  }
  return { callId, documentId, groups };
}

/** The lines `citations` name, ranges expanded. */
function expand(citations: readonly CitationToResolve[]): Set<number> {
  const lines = new Set<number>();
  for (const one of citations) for (let n = one.from; n <= one.to && n - one.from < 100_000; n++) lines.add(n);
  return lines;
}

/**
 * "Computed over sheet X" (CIT-5): every citation of the removed parenthesis is a line citation of
 * this workbook, its lines are exactly one aggregate group's sample lines, a number of that group is
 * written before them, no example lead-in precedes them, and they are on one sheet.
 */
function computedOverSheet(t: LocatorTables, documentId: string, group: readonly CitationToResolve[], before: string, aggregates: readonly AggregateSide[]): { locator: SheetLocator; callId: string } | undefined {
  if (t.format !== "xlsx" || !aggregates.length) return undefined;
  const mine = group.filter((one) => one.documentId === documentId && one.form === "line");
  if (mine.length !== group.length || mine.length === 0) return undefined;
  const cited = expand(mine);
  if (EXAMPLE_LEAD_IN.test(normalized(before))) return undefined;
  const written = numbersIn(before);
  for (const call of aggregates) {
    if (call.documentId !== documentId) continue;
    for (const one of call.groups) {
      const samples = new Set(one.lines);
      if (samples.size === 0 || samples.size !== cited.size || ![...cited].every((line) => samples.has(line))) continue;
      if (!written.some((number) => one.values.some((value) => sameNumber(number, value)))) continue;
      const sheets = new Set([...cited].map((line) => {
        const locator = locatorOfLine(t, line).locator;
        return locator.kind === "row" || locator.kind === "sheet" ? locator.sheetIndex : undefined;
      }));
      if (sheets.size !== 1 || sheets.has(undefined)) continue;
      const sheet = t.sheets.find((one) => one.index === [...sheets][0]);
      if (!sheet) continue;
      return { locator: { kind: "sheet", sheetIndex: sheet.index, sheet: sheet.name }, callId: call.callId };
    }
  }
  return undefined;
}

/** Excel rows `from` to `to` in each sheet that has both: the locator and the rows' own lines. */
function rowsInSheets(t: LocatorTables, from: number, to: number): Array<{ locator: RowLocator; lines: string[] }> {
  const out: Array<{ locator: RowLocator; lines: string[] }> = [];
  for (const sheet of t.sheets) {
    const rows = t.sheetRows.get(sheet.index);
    const a = rows?.get(from);
    const b = rows?.get(to);
    if (a === undefined || b === undefined || b < a) continue;
    // The row's own lines and the pieces of it split at 2,000 characters.
    let end = b;
    while (end + 1 <= t.lineCount && locatorOfLine(t, end + 1).reason === "row_continuation") end++;
    out.push({ locator: { kind: "row", sheetIndex: sheet.index, sheet: sheet.name, row: from, ...(to !== from ? { toRow: to } : {}) }, lines: linesOfRange(t, a, end) });
  }
  return out;
}

/** Whether `evidence` shows every line `from` to `to` of a document. */
function shownBy(evidence: readonly Evidence[], documentId: string, from: number, to: number): boolean {
  const ranges: Array<[number, number]> = [];
  for (const entry of evidence) {
    if (entry.documentId !== documentId) continue;
    if (entry.whole === true && !Array.isArray(entry.lines)) return true;
    for (const range of entry.lines ?? []) ranges.push(range);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  let next = from;
  for (const [a, b] of ranges) {
    if (a > next) break;
    if (b >= next) next = b + 1;
    if (next > to) return true;
  }
  return next > to;
}

/** Two locators that name the same place. */
function sameLocator(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined).sort();
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined).sort();
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && sameLocator(a[key], b[key]));
}

/** Where a citation is, as `resolveCitation` decides it. */
export type ResolvedLocation = {
  /** The document. Absent when it could not be decided ("ambiguous" between several, `candidates`). */
  documentId?: string;
  /** One part, or one per sheet of a range across sheets (at most 4). */
  locators: SourceLocator[];
  status: "resolved" | "ambiguous" | "unresolved";
  /** Why, as a code ("row_prefix", "computed_over_sheet", "l_number_contradicts_claim"…). */
  reason: string;
  basis: SourceBasis;
  /** The places it may be, for "ambiguous". */
  candidates?: Array<{ documentId?: string; locator: SourceLocator }>;
  /** Every cited line was shown to the model (`evidence`). */
  shown: boolean;
  /** The `aggregate_table` call a "computed over sheet" locator comes from. */
  callId?: string;
};

/** What `resolveCitation` takes. */
export type ResolveInput = {
  citation: CitationToResolve;
  /** The claim around the removed parenthesis (`claimAround`). */
  claim: { before: string; after: string };
  /** Every citation of the same removed parenthesis, the citation itself included (for CIT-5). */
  group: readonly CitationToResolve[];
  /** The tables of a document, or undefined when they are not in hand yet: then the answer is "pending". */
  tablesOf: (documentId: string) => LocatorTables | undefined;
  /** The question's documents, for a citation with no file named among several files. */
  documents?: readonly string[];
  aggregates?: readonly AggregateSide[];
  evidence?: readonly Evidence[];
};

const single = (locators: SourceLocator[]): SourceLocator => (locators.length === 1 ? locators[0]! : { kind: "document" });

/**
 * Where one citation is (CIT-1, CIT-5), or "pending" when a document it needs has no tables in hand
 * (`tablesOf` gave undefined): load its text, derive them, and ask again. Without the text, give
 * `deriveLocatorTables({ meta })`, which knows what the metadata alone can say.
 *
 * - The document: the one the citation goes with; two of one name (or none named among several
 *   files) are "ambiguous" unless the content check holds in exactly one.
 * - An English "Row N" in a workbook is Excel's row N; a Hebrew "שורה N" is Excel's row N or text
 *   line N, whichever's cells the claim matches better, and the sheet alone ("ambiguous") when
 *   neither wins.
 * - Line citations that are exactly one aggregate group's sample lines, after its number, give the
 *   sheet ("computed_over_sheet").
 * - A workbook L-number whose literal row holds none of the claim's cells while Excel row N holds
 *   one gives the sheet alone, "ambiguous", with both rows as candidates
 *   ("l_number_contradicts_claim"): it never names a doubtful row.
 */
export function resolveCitation(input: ResolveInput): ResolvedLocation | "pending" {
  const { citation, claim, group, tablesOf } = input;
  const aggregates = input.aggregates ?? [];
  const evidence = input.evidence ?? [];
  const claimText = `${claim.before} ${claim.after}`;
  const english = /^[Rr]ows?\b/.test(citation.written ?? "");
  let ids: readonly string[] = citation.ids.length ? citation.ids : citation.documentId ? [citation.documentId] : [];
  let fileReason: string | undefined;
  if (ids.length !== 1) {
    const candidates = ids.length ? ids : input.documents ?? [];
    const tables = candidates.map((id) => tablesOf(id));
    if (tables.some((one) => one === undefined)) return "pending";
    const holding = candidates.filter((_id, index) => {
      const t = tables[index]!;
      return citation.to <= t.lineCount && contentHolds(claimText, linesOfRange(t, citation.from, citation.to));
    });
    if (holding.length === 1) {
      fileReason = citation.ids.length > 1 ? "name_shared_content_one" : "no_name_content_one";
      ids = holding;
    } else {
      return {
        locators: [documentLocator()],
        status: "ambiguous",
        reason: citation.ids.length > 1 ? `name_shared_content_${holding.length === 0 ? "none" : "several"}` : "no_file_named",
        basis: "none",
        shown: false,
        candidates: candidates.map((id, index) => ({ documentId: id, locator: single(locatorsOfRange(tables[index]!, citation.from, citation.to).locators) })),
      };
    }
  }
  const documentId = ids[0]!;
  const t = tablesOf(documentId);
  if (!t) return "pending";
  const shown = shownBy(evidence, documentId, citation.from, citation.to);
  const out = (found: { locators: SourceLocator[]; reason: string; basis: SourceBasis; unresolved?: true }, extra: Partial<ResolvedLocation> = {}): ResolvedLocation => ({
    documentId,
    locators: found.locators,
    status: found.unresolved ? "unresolved" : "resolved",
    reason: fileReason ? `${fileReason}+${found.reason}` : found.reason,
    basis: found.basis,
    shown,
    ...extra,
  });
  const ambiguous = (locator: SourceLocator, reason: string, basis: SourceBasis, candidates: Array<{ documentId?: string; locator: SourceLocator }>): ResolvedLocation => ({
    documentId,
    locators: [locator],
    status: "ambiguous",
    reason: fileReason ? `${fileReason}+${reason}` : reason,
    basis,
    shown,
    candidates,
  });
  const sheetOf = (index: number): SheetLocator | undefined => {
    const sheet = t.sheets.find((one) => one.index === index);
    return sheet ? { kind: "sheet", sheetIndex: sheet.index, sheet: sheet.name } : undefined;
  };
  const onlySheet = (): SourceLocator => (t.sheets.length === 1 ? sheetOf(t.sheets[0]!.index)! : documentLocator());

  // Rows named as rows. Without the text's row table (no text, or a newer text version) a workbook
  // row names only its sheet, and only when the workbook has one sheet.
  if (citation.form === "row" && t.format === "xlsx" && !(t.basis === "text" && t.textVersion <= KNOWN_TEXT_VERSION)) {
    return out({ locators: [onlySheet()], reason: "row_form_without_row_table", basis: t.sheets.length === 1 ? t.basis : "none" });
  }
  if (citation.form === "row" && t.format === "xlsx") {
    const asRows = rowsInSheets(t, citation.from, citation.to);
    if (english) {
      // "Row N" is Excel's row N.
      if (asRows.length === 1) return out({ locators: [asRows[0]!.locator], reason: "english_row_is_excel_row", basis: "text" });
      if (asRows.length > 1) {
        const scored = asRows.map((one) => ({ ...one, score: cellScore(claimText, one.lines) }));
        const best = Math.max(...scored.map((one) => one.score));
        const top = scored.filter((one) => one.score === best);
        if (best > 0 && top.length === 1) return out({ locators: [top[0]!.locator], reason: "english_row_sheet_by_cells", basis: "text" });
        return ambiguous(documentLocator(), "english_row_in_several_sheets", "none", scored.map((one) => ({ documentId, locator: one.locator })));
      }
      return { ...out({ locators: [onlySheet()], reason: "english_row_not_in_sheet", basis: "text" }), status: "unresolved" };
    }
    // Hebrew "שורה N": Excel's row N or text line N, whichever's cells match the claim better (a
    // reading that does not exist scores -1; the winner must match at least one cell).
    const asLine = locatorsOfRange(t, citation.from, citation.to);
    const rowCandidates = asRows.map((one) => ({ ...one, score: cellScore(claimText, one.lines) }));
    const rowBestScore = rowCandidates.length ? Math.max(...rowCandidates.map((one) => one.score)) : -1;
    const rowTop = rowCandidates.filter((one) => one.score === rowBestScore);
    const rowBest = rowTop.length === 1 ? rowTop[0] : undefined;
    const lineScore = asLine.unresolved ? -1 : cellScore(claimText, linesOfRange(t, citation.from, citation.to));
    // Text line N is itself Excel row N's line: both readings open the same row.
    if (rowBest && !asLine.unresolved && asLine.locators.length === 1 && sameLocator(asLine.locators[0], rowBest.locator)) return out({ locators: [rowBest.locator], reason: "hebrew_row_same_either_way", basis: "text" });
    if (rowBest && rowBestScore > lineScore && rowBestScore > 0) return out({ locators: [rowBest.locator], reason: "hebrew_row_cells_match_excel_row", basis: "text" });
    if (lineScore > rowBestScore && lineScore > 0) return out({ ...asLine, reason: `hebrew_row_cells_match_text_line+${asLine.reason}` });
    // Neither wins: the sheet alone, when both readings are on one sheet.
    const sheets = new Set<number>();
    for (const one of rowCandidates) if (one.locator.sheetIndex !== undefined) sheets.add(one.locator.sheetIndex);
    if (!asLine.unresolved) for (const locator of asLine.locators) if (locator.kind === "row" || locator.kind === "sheet") if (locator.sheetIndex !== undefined) sheets.add(locator.sheetIndex);
    const sheetOnly = sheets.size === 1 ? sheetOf([...sheets][0]!) ?? documentLocator() : onlySheet();
    return ambiguous(sheetOnly, "hebrew_row_tie", "text", [
      ...rowCandidates.map((one) => ({ documentId, locator: one.locator })),
      ...(asLine.unresolved ? [] : [{ documentId, locator: single(asLine.locators) }]),
    ]);
  }
  if (citation.form === "row" && t.format === "csv" && t.csvReliable && t.textVersion <= KNOWN_TEXT_VERSION) {
    // A row form in a CSV: the spreadsheet's row N or text line N, the same unless a quoted line
    // break comes before N. When they differ, the cells decide, else the file alone ("ambiguous").
    const asLine = locatorsOfRange(t, citation.from, citation.to);
    const recordFrom = t.records.find((record) => record.row === citation.from);
    const recordTo = t.records.find((record) => record.row === citation.to);
    const asRow: RowLocator | undefined = recordFrom && recordTo ? { kind: "row", row: citation.from, ...(citation.to !== citation.from ? { toRow: citation.to } : {}) } : undefined;
    if (asRow && !asLine.unresolved && sameLocator(asLine.locators[0], asRow)) return out({ locators: [asRow], reason: "csv_row_same_either_way", basis: "text" });
    const rowLines = asRow && recordFrom ? linesOfRange(t, recordFrom.line, (t.records.find((record) => record.row === citation.to + 1)?.line ?? t.lineCount + 1) - 1) : [];
    const rowScore = asRow ? cellScore(claimText, rowLines) : -1;
    const lineScore = asLine.unresolved ? -1 : cellScore(claimText, linesOfRange(t, citation.from, citation.to));
    if (asRow && rowScore > Math.max(lineScore, 0)) return out({ locators: [asRow], reason: "csv_row_cells_match_row", basis: "text" });
    if (lineScore > Math.max(rowScore, 0)) return out({ ...asLine, reason: `csv_row_cells_match_text_line+${asLine.reason}` });
    return ambiguous(documentLocator(), "csv_row_tie", "text", [
      ...(asRow ? [{ documentId, locator: asRow as SourceLocator }] : []),
      ...(asLine.unresolved ? [] : [{ documentId, locator: single(asLine.locators) }]),
    ]);
  }
  // Lines, and row forms in formats without rows (a text line). "Computed over sheet X" first.
  if (citation.form === "line") {
    const computed = computedOverSheet(t, documentId, group, claim.before, aggregates);
    if (computed) return out({ locators: [computed.locator], reason: "computed_over_sheet", basis: "tool" }, { callId: computed.callId });
    // A workbook L-number whose literal row contradicts the claim (option B, decision 16): the
    // sheet alone, never a doubtful row.
    if (t.format === "xlsx" && citation.from === citation.to && t.basis === "text" && t.textVersion <= KNOWN_TEXT_VERSION) {
      const literal = locatorOfLine(t, citation.from);
      const claimWords = wordsOf(claimText);
      const literalHits = cellHits(claimWords, t.lines?.[citation.from - 1]);
      const excel = rowsInSheets(t, citation.from, citation.from)[0];
      const excelHits = excel ? cellHits(claimWords, excel.lines[0]) : -1;
      if (literal.locator.kind !== "document" && excel && literalHits === 0 && excelHits > 0) {
        const literalSheet = (literal.locator as RowLocator | SheetLocator).sheetIndex;
        const locator = literalSheet !== undefined && literalSheet === excel.locator.sheetIndex ? sheetOf(literalSheet) ?? documentLocator() : onlySheet();
        return ambiguous(locator, "l_number_contradicts_claim", "text", [
          { documentId, locator: literal.locator },
          { documentId, locator: excel.locator },
        ]);
      }
    }
  }
  const range = locatorsOfRange(t, citation.from, citation.to);
  return out({ ...range, reason: citation.form === "row" ? `row_form_read_as_line+${range.reason}` : range.reason });
}
