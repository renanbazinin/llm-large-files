/**
 * The outline of a PDF from the size of its type (0.10.0).
 *
 * The text rules of the outline (analyze.ts) rarely fire on a PDF: pdf.js gives no blank line
 * between paragraphs, and Hebrew has no capitals, so an unnumbered Hebrew PDF had no outline at
 * all. Its headings are set in larger type than its body, and pdf.js gives the size of each piece
 * of text. The PDF extractor collects the lines set larger than the body (`PdfHeadingFinder`) and
 * returns them with their page (`ExtractedText.headings`). Ingest finds each one among the lines of
 * its page in the stored text, and uses them when the text rules found fewer than 3 headings and 3
 * or more of these are found (`pdfOutline`): a PDF whose text has an outline keeps it as it was, and
 * so does one with a title alone.
 *
 * pdf.js does not say which text is bold (its text content names a generic family, such as
 * "sans-serif", and no weight), so a heading in bold type of the body's size is not found.
 */
import { pickOutline } from "./analyze.js";
import type { TimeSlicer } from "./pause.js";
import type { PdfTextItem } from "./pdf-layout.js";
import { composed, removeInvisible } from "./text.js";
import type { ExtractedText, OutlineEntry } from "./types.js";

/**
 * A heading of a PDF, as the extractor returns it: its page, from 1; its level, from 1; its text;
 * and, when lines above it on its page read the same (spaces aside: a contents list, a running
 * header), how many, so that ingest passes over them.
 */
export type PdfHeading = { page: number; level: number; title: string; skip?: number };

/** Sizes are compared in steps of half a unit: Word's 10.56 and 10.5 are one size. */
const SIZE_STEP = 0.5;
/**
 * A heading is set at least this much larger than the body: Word's Heading 2 (13 pt over 11),
 * HTML's h3 (1.17 em), LibreOffice's Heading 2 (115%). Word's Heading 3 (12 pt over 11) is not: a
 * lower ratio takes body text set a point larger, a quotation or a note, for headings.
 */
const HEADING_RATIO = 1.15;
/** Of a line's characters, at least this share are of its size: a line that opens with a large word is body text. */
const UNIFORM_SHARE = 0.75;
/** When more of the text than this is set larger than the body, its sizes do not mark headings. */
const MAX_LARGE_SHARE = 0.3;
/** A heading has at least 3 letters, and no more digits than letters: "12,500", "2026" and "- 3 -" are not headings. */
const MIN_LETTERS = 3;
/** The longest heading, as for the text rules. */
const MAX_TITLE_CHARACTERS = 120;
/** Levels come from the rank of the sizes: the largest is 1, the third and smaller are 3. */
const MAX_LEVELS = 3;
/** Lines kept while the pages are read, before the size of the body is known: past this, the smallest size kept goes. */
const MAX_KEPT_LINES = 20_000;
/** Sizes kept while the pages are read: past this, the smallest goes. A document uses a few dozen; the bound keeps each line's work small. */
const MAX_KEPT_SIZES = 64;
/**
 * A gap wider than this many times the size of the type, between two pieces of one line, is between
 * two cells: the line is a table row. The tab after a heading's number is at most half an inch,
 * less than 3 times the size of a heading.
 */
const CELL_GAP = 3;
/** An outline has at least this many headings, from the text rules or the sizes: one or two are seldom an outline. */
export const MIN_TEXT_HEADINGS = 3;
/** The most headings `ingest` reads from an extractor. */
const MAX_GIVEN_HEADINGS = 10_000;
/** A stored line longer than this is not looked at: a heading is at most 120 characters, with a space between its words. */
const MAX_LINE_CHARACTERS = 2 * MAX_TITLE_CHARACTERS;

type Line = { page: number; order: number; size: number; title: string; skip: number };

/** The size of a piece of text, in steps of `SIZE_STEP`, or undefined when it has none. */
function sizeOf(item: PdfTextItem): number | undefined {
  const matrix: unknown = item.transform;
  // pdf.js gives the height of horizontal text; vertical text has none, and its matrix gives the size.
  const raw = item.height > 0 ? item.height : Array.isArray(matrix) ? Math.hypot(Number(matrix[0]), Number(matrix[1])) : Number.NaN;
  const size = Math.round(raw / SIZE_STEP) * SIZE_STEP;
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/** Where a piece of text starts along its line (it ends `width` further), or NaN when that cannot be told. */
function startOf(item: PdfTextItem): number {
  const matrix: unknown = item.transform;
  if (!Array.isArray(matrix) || !(item.width > 0)) return Number.NaN;
  const a = Number(matrix[0]);
  const b = Number(matrix[1]);
  return (Number(matrix[4]) * a + Number(matrix[5]) * b) / Math.hypot(a, b);
}

/** Whether a line's text can be a heading: not too long, not a table row, and words rather than a number. */
function mayBeHeading(title: string): boolean {
  if (title.length > MAX_TITLE_CHARACTERS || title.startsWith("|")) return false;
  const letters = title.match(/\p{L}/gu)?.length ?? 0;
  const digits = title.match(/\p{Nd}/gu)?.length ?? 0;
  return letters >= MIN_LETTERS && letters >= digits;
}

/** A text as it is compared with a heading: cleaned and composed as ingest stores text, without its spaces. */
const compared = (text: string) => composed(removeInvisible(text)).replace(/\s+/g, "");
/** A line's text with each number written "#", or undefined when it has none: "Page 3 of 10" is the same on every page. */
const numberless = (title: string) => (/\p{Nd}/u.test(title) ? title.replace(/\s+/g, "").replace(/\p{Nd}+/gu, "#") : undefined);

/** Adds `page` to the pages of `key`. */
function seenOn(pages: Map<string, Set<number>>, key: string, page: number): void {
  const set = pages.get(key);
  if (set) set.add(page);
  else pages.set(key, new Set([page]));
}

/**
 * Finds the headings of a PDF from the size of its type, page by page as pdf.js reads them. A line
 * is the text up to the end of a line (`hasEOL`), as the extractor writes it, and its size is the
 * size most of its characters have. A line with a gap of more than 3 times its size between two
 * pieces is a table row (cells, or a label and its value): it counts for neither the body nor the
 * headings. Once every page is read, `headings()` gives the lines set at least 15% larger than the
 * body, the commonest size of the other lines, but for:
 * - lines over 120 characters, with fewer than 3 letters, with more digits than letters, or that
 *   start with "|";
 * - lines with less than three quarters of their characters at their size;
 * - running headers and footers: the same line on 3 pages or more, or on 2 pages and half the
 *   pages; or a page number (`pageNumbered`);
 * - the lines after the first of a heading set on several lines in a row, at one size;
 * - all of them, when more than 30% of the text is set larger than the body (sizes then mark
 *   something else).
 *
 * Levels follow the sizes of several headings: the largest is level 1, the next 2, the others 3. A
 * size of one heading, larger than all of those (a title, the lines of a cover), is level 1, and the
 * others then start at 2. At most 400 headings, picked as the text rules' outline is. The work is
 * linear in the text: at most 20,000 lines in 64 sizes are kept until the end.
 */
export class PdfHeadingFinder {
  /** The characters of each size, over all the text. */
  private readonly characters = new Map<number, number>();
  /** The lines that may be headings, by size. */
  private readonly kept = new Map<number, Line[]>();
  private keptLines = 0;
  /** Lines of this size or smaller are no longer kept: there were too many. */
  private floor = 0;
  private pages = 0;
  /** The lines of the page being read, by their text without spaces: how many so far. */
  private readonly onPage = new Map<string, number>();

  /** Adds the text of page `page` (from 1): `page.getTextContent().items`. */
  addPage(page: number, items: readonly PdfTextItem[]): void {
    this.pages++;
    this.onPage.clear();
    let order = 0;
    let start = 0;
    for (let index = 0; index <= items.length; index++) {
      if (index < items.length && !items[index]!.hasEOL) continue;
      if (this.addLine(page, order, items.slice(start, index + 1))) order++;
      start = index + 1;
    }
  }

  /** Adds one line; false when it has no visible character. */
  private addLine(page: number, order: number, items: readonly PdfTextItem[]): boolean {
    let text = "";
    let total = 0;
    let row = false;
    /** The last piece with text: where it starts and ends along the line, and its size (NaN when not known). */
    let lastStart = Number.NaN;
    let lastEnd = Number.NaN;
    let lastSize = 0;
    const bySize = new Map<number, number>();
    for (const item of items) {
      if (typeof item.str !== "string") continue;
      text += item.str;
      const count = item.str.replace(/\s+/g, "").length;
      const size = count > 0 ? sizeOf(item) : undefined;
      if (size === undefined) continue;
      bySize.set(size, (bySize.get(size) ?? 0) + count);
      total += count;
      // Right-to-left text runs the other way: the gap is the space between the two pieces either way.
      const start = startOf(item);
      const end = start + item.width;
      if (Math.max(start - lastEnd, lastStart - end) > CELL_GAP * Math.max(size, lastSize)) row = true;
      lastStart = start;
      lastEnd = end;
      lastSize = size;
    }
    if (total === 0) return false;
    const title = text.replace(/\s+/g, " ").trim();
    // A heading is the line after those above it on its page that read the same (a contents list).
    const key = title.length <= MAX_LINE_CHARACTERS ? title.replace(/ /g, "") : "";
    const skip = this.onPage.get(key) ?? 0;
    if (key) this.onPage.set(key, skip + 1);
    if (row) return true;
    let size = 0;
    let most = 0;
    for (const [each, count] of bySize) {
      this.characters.set(each, (this.characters.get(each) ?? 0) + count);
      if (count > most || (count === most && each < size)) {
        size = each;
        most = count;
      }
    }
    if (most >= UNIFORM_SHARE * total && size > this.floor && mayBeHeading(title)) this.keep({ page, order, size, title, skip });
    return true;
  }

  private keep(line: Line): void {
    const lines = this.kept.get(line.size);
    if (lines) lines.push(line);
    else this.kept.set(line.size, [line]);
    this.keptLines++;
    // Headings are larger than the body, so the smallest size goes first, and is not kept again.
    // Each size goes at most once, and there are at most 65 to look through.
    while (this.keptLines > MAX_KEPT_LINES || this.kept.size > MAX_KEPT_SIZES) {
      const smallest = Math.min(...this.kept.keys());
      this.keptLines -= this.kept.get(smallest)!.length;
      this.kept.delete(smallest);
      this.floor = smallest;
    }
  }

  /** The headings found, in the order of the text. Empty when the sizes mark none. */
  headings(): PdfHeading[] {
    // The body: the size with the most characters, the smaller of two with as many.
    let body = 0;
    let most = 0;
    let all = 0;
    for (const [size, count] of this.characters) {
      all += count;
      if (count > most || (count === most && size < body)) {
        body = size;
        most = count;
      }
    }
    const least = body * HEADING_RATIO;
    let large = 0;
    for (const [size, count] of this.characters) if (size >= least) large += count;
    // No larger type; too much of it; or lines of a heading's size were let go (over 20,000 of them).
    if (large === 0 || large > MAX_LARGE_SHARE * all || this.floor >= least) return [];
    const lines = [...this.kept].flatMap(([size, kept]) => (size >= least ? kept : []));
    lines.sort((left, right) => left.page - right.page || left.order - right.order);
    // Running headers and footers: the same line on many pages, or a page number.
    const exactly = new Map<string, Set<number>>();
    const numbered = new Map<string, Line[]>();
    for (const line of lines) {
      seenOn(exactly, line.title.replace(/\s+/g, ""), line.page);
      const key = numberless(line.title);
      if (key === undefined) continue;
      const alike = numbered.get(key);
      if (alike) alike.push(line);
      else numbered.set(key, [line]);
    }
    const paged = new Set([...numbered].flatMap(([key, alike]) => (pageNumbered(alike, this.pages) ? [key] : [])));
    const running = (line: Line) => {
      const same = exactly.get(line.title.replace(/\s+/g, ""))!.size;
      const key = numberless(line.title);
      return same >= 3 || (same >= 2 && same * 2 >= this.pages) || (key !== undefined && paged.has(key));
    };
    const found: Line[] = [];
    let previous: Line | undefined;
    for (const line of lines) {
      if (running(line)) continue;
      const continues = previous !== undefined && previous.page === line.page && previous.order + 1 === line.order && previous.size === line.size;
      previous = line;
      if (!continues) found.push(line);
    }
    const levelOf = levels(found.map((line) => line.size));
    return pickOutline(found.map((line) => ({ page: line.page, level: levelOf.get(line.size)!, title: line.title, ...(line.skip > 0 ? { skip: line.skip } : {}) })));
  }
}

/** The numbers of a line, in its order. */
const numbersOf = (title: string) => (title.match(/\p{Nd}+/gu) ?? []).map(Number);

/** Whether `after` is `before` with one of its numbers 1 more and the others the same. */
function oneMore(before: number[], after: number[]): boolean {
  let more = 0;
  for (const [index, number] of before.entries()) {
    if (after[index] === number + 1) more++;
    else if (after[index] !== number) return false;
  }
  return more === 1;
}

/**
 * Whether lines that differ only by their numbers, in the order of the text, are a page number, a
 * running header or footer ("עמוד 3 מתוך 10", "Annual Report page 7"): on 2 pages or more and at
 * least half the pages, never counting up on one page (the same number in a page's header and its
 * footer is one page number), and not counting as section numbers do. Section
 * numbers count headings: each is the one before with one number 1 more, with pages without one
 * between some of them ("פרק 1" to "פרק 5" on the odd pages). A page number counts pages: it skips
 * the pages it is missing from ("page 1", "page 3" on the odd pages). Several on one page ("Article
 * 1" to "Article 18", 3 to a page) are headings. On pages in a row, counting by one, the two read
 * the same, and are taken for a page number: chapters one to a page on pages in a row, half the
 * pages or more, are lost.
 */
function pageNumbered(alike: Line[], pages: number): boolean {
  const on = new Set(alike.map((line) => line.page)).size;
  if (on < 2 || on * 2 < pages) return false;
  let counts = true;
  let skips = false;
  for (let index = 1; index < alike.length; index++) {
    const before = alike[index - 1]!;
    const line = alike[index]!;
    if (line.page === before.page) {
      // Several on one page that count up are headings ("Article 1" to "Article 3"); the same
      // number twice on a page is a page number in the header and the footer.
      if (oneMore(numbersOf(before.title), numbersOf(line.title))) return false;
      continue;
    }
    skips ||= line.page > before.page + 1;
    counts &&= oneMore(numbersOf(before.title), numbersOf(line.title));
  }
  return !(counts && skips);
}

/**
 * The level of each size of `sizes`, those of the headings found: the sizes of several headings rank
 * from the largest, 1 to 3; a size of one heading, larger than all of those (a title, the lines of a
 * cover), is level 1, and the ranks then start at 2, so that a cover does not take the levels of
 * the body's headings. When every size is of one heading, they all rank.
 */
function levels(sizes: number[]): Map<number, number> {
  const uses = new Map<number, number>();
  for (const size of sizes) uses.set(size, (uses.get(size) ?? 0) + 1);
  const all = [...uses.keys()].sort((left, right) => right - left);
  const ranked = all.filter((size) => uses.get(size)! >= 2);
  const top = ranked[0];
  if (top === undefined) return new Map(all.map((size, rank) => [size, Math.min(rank + 1, MAX_LEVELS)]));
  const first = all[0]! > top ? 2 : 1;
  return new Map(all.map((size) => [size, size > top ? 1 : Math.min(first + ranked.filter((each) => each > size).length, MAX_LEVELS)]));
}

/**
 * The headings an extractor returned (`ExtractedText.headings`): the first 10,000 entries, those of
 * the right shape (a page and a level that are whole numbers from 1, the level up to 6, a title of
 * 1 to 1,000 characters, and a `skip` that is a whole number from 0, or none). Undefined when there
 * are none.
 */
export function headingsOf(extracted: ExtractedText): PdfHeading[] | undefined {
  const given: unknown = extracted.headings;
  if (!Array.isArray(given)) return undefined;
  const headings: PdfHeading[] = [];
  for (const entry of given.slice(0, MAX_GIVEN_HEADINGS) as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { page, level, title, skip } = entry as { page?: unknown; level?: unknown; title?: unknown; skip?: unknown };
    if (!Number.isSafeInteger(page) || (page as number) < 1 || !Number.isSafeInteger(level) || (level as number) < 1 || (level as number) > 6) continue;
    if (typeof title !== "string" || !title.trim() || title.length > 1_000) continue;
    if (skip !== undefined && (!Number.isSafeInteger(skip) || (skip as number) < 0)) continue;
    headings.push({ page: page as number, level: level as number, title, ...(skip ? { skip: skip as number } : {}) });
  }
  return headings.length > 0 ? headings : undefined;
}

/**
 * The outline of the stored text from the headings of the extractor: each heading is the line of its
 * page, after the one taken for the heading before it, with the same text once spaces are left out
 * (pdf.js gives Hebrew words without the space between them, and the extractor adds it), past the
 * `skip` lines above it that read the same. Pages start at the lines `--- Page N ---`, from 1, each
 * continuing the count. A heading that is not found is left out; the title is the line as it is stored.
 */
async function placeHeadings(lines: string[], headings: PdfHeading[], slicer: TimeSlicer): Promise<OutlineEntry[]> {
  const byPage = new Map<number, Map<string, PdfHeading[]>>();
  for (const heading of headings) {
    const key = compared(heading.title);
    if (!key) continue;
    let page = byPage.get(heading.page);
    if (!page) byPage.set(heading.page, (page = new Map()));
    const same = page.get(key);
    if (same) same.push(heading);
    else page.set(key, [heading]);
  }
  const outline: OutlineEntry[] = [];
  let next = 1;
  let marker = "--- Page 1 ---";
  let page: Map<string, PdfHeading[]> | undefined;
  /** The lines of the page so far, by their text without spaces: how many. */
  const seen = new Map<string, number>();
  for (let index = 0; index < lines.length; index++) {
    if ((index & 4095) === 4095) await slicer.maybePause();
    const line = lines[index]!;
    if (line === marker) {
      page = byPage.get(next++);
      marker = `--- Page ${next} ---`;
      seen.clear();
      continue;
    }
    if (!page || line.length > MAX_LINE_CHARACTERS) continue;
    const key = line.replace(/\s+/g, "");
    const waiting = page.get(key);
    if (!waiting?.length) continue;
    const above = seen.get(key) ?? 0;
    seen.set(key, above + 1);
    if ((waiting[0]!.skip ?? 0) > above) continue;
    const heading = waiting.shift()!;
    outline.push({ line: index + 1, level: heading.level, title: line.trim() });
  }
  return outline;
}

/**
 * The outline of a PDF: `outline`, from the text rules, when it has 3 headings or more, or when
 * fewer than 3 of the extractor's headings are found in the stored text (one or two are seldom an
 * outline: a title alone tells nothing); otherwise those found, at most 400, picked as the text
 * rules' are.
 */
export async function pdfOutline(outline: OutlineEntry[], lines: string[], headings: PdfHeading[] | undefined, slicer: TimeSlicer): Promise<OutlineEntry[]> {
  if (!headings || outline.length >= MIN_TEXT_HEADINGS) return outline;
  const placed = await placeHeadings(lines, headings, slicer);
  return placed.length >= MIN_TEXT_HEADINGS ? pickOutline(placed) : outline;
}
