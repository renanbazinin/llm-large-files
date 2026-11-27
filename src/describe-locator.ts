// A source's place in words, for a chip or its accessible name, in Hebrew or English. Browser-safe:
// no import but types. New in 0.99.14.
import type { SourceLocator } from "./sources.js";

/** The dash of a range of numbers: an en dash, which reads the same in both directions. */
const DASH = "–";
/** What joins the parts of a place in a label: "גיליון לקוחות · שורה 8". */
const DOT = " · ";

const span = (from: number, to?: number) => (to !== undefined && to !== from ? `${from}${DASH}${to}` : String(from));
const many = (from: number, to?: number) => to !== undefined && to !== from;

/** A sheet as a label names it: by its name, or its number when the name is not known. */
function sheetName(locator: { sheetIndex?: number; sheet?: string }, language: "he" | "en"): string | undefined {
  if (typeof locator.sheet === "string" && locator.sheet) return language === "he" ? `גיליון ${locator.sheet}` : `Sheet ${locator.sheet}`;
  if (typeof locator.sheetIndex === "number") return language === "he" ? `גיליון ${locator.sheetIndex}` : `Sheet ${locator.sheetIndex}`;
  return undefined;
}

/**
 * The place a locator names, as a short label: "גיליון לקוחות · שורה 8", "Sheet Customers · row 8",
 * "עמוד 3", "slide 2 · speaker notes", "4. Payments · סעיף 4.2", "line 120". An empty string for
 * `{ kind: "document" }`, which names no place in the file: show the file's name alone. A locator of
 * a kind this version does not know is an empty string too. New in 0.99.14.
 */
export function describeLocator(locator: SourceLocator, language: "he" | "en" = "en"): string {
  const he = language === "he";
  if (!locator || typeof locator !== "object") return "";
  switch (locator.kind) {
    case "row": {
      const sheet = sheetName(locator, language);
      const row = `${he ? (many(locator.row, locator.toRow) ? "שורות" : "שורה") : many(locator.row, locator.toRow) ? "rows" : "row"} ${span(locator.row, locator.toRow)}`;
      return sheet ? `${sheet}${DOT}${row}` : row;
    }
    case "cell": {
      const sheet = sheetName(locator, language);
      const cell = `${he ? "תא" : "cell"} ${locator.column}${locator.row}`;
      return sheet ? `${sheet}${DOT}${cell}` : cell;
    }
    case "sheet":
      return sheetName(locator, language) ?? "";
    case "page":
      return `${he ? (many(locator.page, locator.toPage) ? "עמודים" : "עמוד") : many(locator.page, locator.toPage) ? "pages" : "page"} ${span(locator.page, locator.toPage)}`;
    case "slide": {
      const slide = `${he ? (many(locator.slide, locator.toSlide) ? "שקופיות" : "שקופית") : many(locator.slide, locator.toSlide) ? "slides" : "slide"} ${span(locator.slide, locator.toSlide)}`;
      return locator.notes === true ? `${slide}${DOT}${he ? "הערות הדובר" : "speaker notes"}` : slide;
    }
    case "section": {
      const parts: string[] = [];
      const heading = locator.headings?.at(-1);
      if (typeof heading === "string" && heading) parts.push(heading);
      if (typeof locator.numbering === "string" && locator.numbering) parts.push(`${he ? (locator.numbering.includes("-") ? "סעיפים" : "סעיף") : locator.numbering.includes("-") ? "clauses" : "clause"} ${locator.numbering.replace("-", DASH)}`);
      return parts.join(DOT);
    }
    case "line": {
      const parts: string[] = [];
      if (typeof locator.line === "number") parts.push(`${he ? (many(locator.line, locator.toLine) ? "שורות" : "שורה") : many(locator.line, locator.toLine) ? "lines" : "line"} ${span(locator.line, locator.toLine)}`);
      if (typeof locator.time === "string" && locator.time) parts.push(locator.time);
      return parts.join(DOT);
    }
    default:
      return "";
  }
}

/**
 * The place a locator names, as words of a sentence: "שורה 8 בגיליון לקוחות", "row 8 of sheet
 * Customers", "עמוד 3", "סעיף 4.2". For a citation the answer needs, put into words where it stood.
 * Undefined for `{ kind: "document" }` and for a section with no number and no heading.
 */
export function locatorInWords(locator: SourceLocator, language: "he" | "en"): string | undefined {
  const he = language === "he";
  switch (locator.kind) {
    case "row": {
      const row = `${he ? (many(locator.row, locator.toRow) ? "שורות" : "שורה") : many(locator.row, locator.toRow) ? "rows" : "row"} ${span(locator.row, locator.toRow)}`;
      const name = locator.sheet ?? (locator.sheetIndex !== undefined ? String(locator.sheetIndex) : undefined);
      if (name === undefined) return row;
      return he ? `${row} בגיליון ${name}` : `${row} of sheet ${name}`;
    }
    case "sheet": {
      const name = locator.sheet ?? String(locator.sheetIndex);
      return he ? `גיליון ${name}` : `sheet ${name}`;
    }
    case "section": {
      if (typeof locator.numbering === "string" && locator.numbering) return `${he ? (locator.numbering.includes("-") ? "סעיפים" : "סעיף") : locator.numbering.includes("-") ? "clauses" : "clause"} ${locator.numbering.replace("-", DASH)}`;
      const heading = locator.headings?.at(-1);
      return typeof heading === "string" && heading ? (he ? `בפרק "${heading}"` : `under "${heading}"`) : undefined;
    }
    case "document":
      return undefined;
    default: {
      const label = describeLocator(locator, language);
      return label || undefined;
    }
  }
}
