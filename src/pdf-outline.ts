/**
 * The outline of a PDF from the size of its type (0.10.0).
 *
 * The text rules of the outline (analyze.ts) rarely fire on a PDF: pdf.js gives no blank line
 * between paragraphs, and Hebrew has no capitals, so an unnumbered Hebrew PDF had no outline at
 * all. Its headings are set in larger type than its body, and pdf.js gives the size of each piece
 * of text. The PDF extractor collects the lines set larger than the body (`PdfHeadingFinder`) and
 * returns them with their page (`ExtractedText.headings`). Ingest finds each one among the lines of
 * its page in the stored text, and uses them when the text rules found fewer than 3 headings
 * (`pdfOutline`): a PDF whose text has an outline keeps it as it was.
 *
 * pdf.js does not say which text is bold (its text content names a generic family, such as
 * "sans-serif", and no weight), so a heading in bold type of the body's size is not found.
 */
import { pickOutline } from "./analyze.js";
import type { TimeSlicer } from "./pause.js";
import type { PdfTextItem } from "./pdf-layout.js";
import { composed, removeInvisible } from "./text.js";
import type { ExtractedText, OutlineEntry } from "./types.js";

/** A heading of a PDF, as the extractor returns it: its page, from 1; its level, from 1; its text. */
export type PdfHeading = { page: number; level: number; title: string };

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
/** The text rules' outline is kept when it has at least this many headings: one or two are seldom an outline. */
export const MIN_TEXT_HEADINGS = 3;
/** The most headings `ingest` reads from an extractor. */
const MAX_GIVEN_HEADINGS = 10_000;
/** A stored line longer than this is not looked at: a heading is at most 120 characters, with a space between its words. */
const MAX_LINE_CHARACTERS = 2 * MAX_TITLE_CHARACTERS;

type Line = { page: number; order: number; size: number; title: string };

/** The size of a piece of text, in steps of `SIZE_STEP`, or undefined when it has none. */
function sizeOf(item: PdfTextItem): number | undefined {
  const matrix: unknown = item.transform;
  // pdf.js gives the height of horizontal text; vertical text has none, and its matrix gives the size.
  const raw = item.height > 0 ? item.height : Array.isArray(matrix) ? Math.hypot(Number(matrix[0]), Number(matrix[1])) : Number.NaN;
  const size = Math.round(raw / SIZE_STEP) * SIZE_STEP;
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/** Whether a line's text can be a heading: not too long, not a table row, and words rather than a number. */
function mayBeHeading(title: string): boolean {
  if (title.length > MAX_TITLE_CHARACTERS || title.startsWith("|")) return false;
  const letters = title.match(/\p{L}/gu)?.length ?? 0;
  const digits = title.match(/\p{Nd}/gu)?.length ?? 0;
  return letters >= MIN_LETTERS && letters >= digits;
}

/** A line's text with its spaces removed and each number written "#": a running header or footer is the same on every page. */
const repeatKey = (title: string) => title.replace(/\s+/g, "").replace(/\p{Nd}+/gu, "#");

/**
 * Finds the headings of a PDF from the size of its type, page by page as pdf.js reads them. A line
 * is the text up to the end of a line (`hasEOL`), as the extractor writes it, and its size is the
 * size most of its characters have. Once every page is read, `headings()` gives the lines set at
 * least 15% larger than the body, its commonest size, but for:
 * - lines over 120 characters, with fewer than 3 letters, with more digits than letters, or that
 *   start with "|";
 * - lines with less than three quarters of their characters at their size;
 * - lines repeated on 3 pages or more, or on 2 pages and half the pages, numbers aside (running
 *   headers and footers, "Page 3 of 10");
 * - the lines after the first of a heading set on several lines in a row, at one size;
 * - all of them, when more than 30% of the text is set larger than the body (sizes then mark
 *   something else).
 *
 * Levels follow the sizes: the largest is level 1, the next 2, the others 3. At most 400 headings,
 * picked as the text rules' outline is. The work is linear in the text, and at most 20,000 lines
 * are kept until the end.
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

  /** Adds the text of page `page` (from 1): `page.getTextContent().items`. */
  addPage(page: number, items: readonly PdfTextItem[]): void {
    this.pages++;
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
    const bySize = new Map<number, number>();
    for (const item of items) {
      if (typeof item.str !== "string") continue;
      text += item.str;
      const count = item.str.replace(/\s+/g, "").length;
      const size = count > 0 ? sizeOf(item) : undefined;
      if (size === undefined) continue;
      bySize.set(size, (bySize.get(size) ?? 0) + count);
      total += count;
    }
    if (total === 0) return false;
    let size = 0;
    let most = 0;
    for (const [each, count] of bySize) {
      this.characters.set(each, (this.characters.get(each) ?? 0) + count);
      if (count > most || (count === most && each < size)) {
        size = each;
        most = count;
      }
    }
    const title = text.replace(/\s+/g, " ").trim();
    if (most >= UNIFORM_SHARE * total && size > this.floor && mayBeHeading(title)) this.keep({ page, order, size, title });
    return true;
  }

  private keep(line: Line): void {
    const lines = this.kept.get(line.size);
    if (lines) lines.push(line);
    else this.kept.set(line.size, [line]);
    if (++this.keptLines <= MAX_KEPT_LINES) return;
    // Headings are larger than the body, so the smallest size goes first, and is not kept again.
    const smallest = Math.min(...this.kept.keys());
    this.keptLines -= this.kept.get(smallest)!.length;
    this.kept.delete(smallest);
    this.floor = smallest;
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
    const pagesOf = new Map<string, Set<number>>();
    for (const line of lines) {
      const key = repeatKey(line.title);
      const pages = pagesOf.get(key);
      if (pages) pages.add(line.page);
      else pagesOf.set(key, new Set([line.page]));
    }
    const found: Line[] = [];
    let previous: Line | undefined;
    for (const line of lines) {
      const repeated = pagesOf.get(repeatKey(line.title))!.size;
      if (repeated >= 3 || (repeated >= 2 && repeated * 2 >= this.pages)) continue;
      const continues = previous !== undefined && previous.page === line.page && previous.order + 1 === line.order && previous.size === line.size;
      previous = line;
      if (!continues) found.push(line);
    }
    const sizes = [...new Set(found.map((line) => line.size))].sort((left, right) => right - left);
    return pickOutline(found.map((line) => ({ page: line.page, level: Math.min(sizes.indexOf(line.size) + 1, MAX_LEVELS), title: line.title })));
  }
}

/**
 * The headings an extractor returned (`ExtractedText.headings`): the first 10,000 entries, those of
 * the right shape (a page and a level that are whole numbers from 1, the level up to 6, and a title
 * of 1 to 1,000 characters). Undefined when there are none.
 */
export function headingsOf(extracted: ExtractedText): PdfHeading[] | undefined {
  const given: unknown = extracted.headings;
  if (!Array.isArray(given)) return undefined;
  const headings: PdfHeading[] = [];
  for (const entry of given.slice(0, MAX_GIVEN_HEADINGS) as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { page, level, title } = entry as { page?: unknown; level?: unknown; title?: unknown };
    if (!Number.isSafeInteger(page) || (page as number) < 1 || !Number.isSafeInteger(level) || (level as number) < 1 || (level as number) > 6) continue;
    if (typeof title !== "string" || !title.trim() || title.length > 1_000) continue;
    headings.push({ page: page as number, level: level as number, title });
  }
  return headings.length > 0 ? headings : undefined;
}

/** A text as it is compared with a heading: cleaned and composed as ingest stores text, without its spaces. */
const compared = (text: string) => composed(removeInvisible(text)).replace(/\s+/g, "");

/**
 * The outline of the stored text from the headings of the extractor: each heading is the first line
 * of its page, after the one taken for the heading before it, with the same text once spaces are
 * left out (pdf.js gives Hebrew words without the space between them, and the extractor adds it).
 * Pages start at the lines `--- Page N ---`, from 1, each continuing the count. A heading that is
 * not found is left out; the title is the line as it is stored.
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
  for (let index = 0; index < lines.length; index++) {
    if ((index & 4095) === 4095) await slicer.maybePause();
    const line = lines[index]!;
    if (line === marker) {
      page = byPage.get(next++);
      marker = `--- Page ${next} ---`;
      continue;
    }
    if (!page || line.length > MAX_LINE_CHARACTERS) continue;
    const heading = page.get(line.replace(/\s+/g, ""))?.shift();
    if (heading) outline.push({ line: index + 1, level: heading.level, title: line.trim() });
  }
  return outline;
}

/**
 * The outline of a PDF: `outline`, from the text rules, when it has 3 headings or more, or when
 * the extractor's headings give no more; otherwise the headings found in the stored text, at most
 * 400, picked as the text rules' are.
 */
export async function pdfOutline(outline: OutlineEntry[], lines: string[], headings: PdfHeading[] | undefined, slicer: TimeSlicer): Promise<OutlineEntry[]> {
  if (!headings || outline.length >= MIN_TEXT_HEADINGS) return outline;
  const placed = await placeHeadings(lines, headings, slicer);
  return placed.length > outline.length ? pickOutline(placed) : outline;
}
