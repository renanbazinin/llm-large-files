import type { TimeSlicer } from "./pause.js";
import type { DocumentFormat, DocumentMeta } from "./types.js";

/**
 * Signs of the quality of a document's text, worked out at ingest and shown on its card, so the
 * model knows where the text cannot be trusted before it relies on it:
 * - the pages of a PDF that have no text (a scan, a photo), and those whose text layer looks
 *   garbled (fonts without a Unicode map give "ÞÞÞ" or "�����");
 * - the scripts the text is written in, when it is not Latin alone: a Hebrew file is searched in
 *   Hebrew.
 */
export type TextQuality = Pick<DocumentMeta, "pagesWithoutText" | "garbledPages" | "scripts">;

/** Page numbers kept in a list, at most. */
const MAX_LISTED_PAGES = 200;
/** Characters of the text the script shares are counted over. */
const SCRIPT_SAMPLE = 2 * 1024 * 1024;
/** Letters needed before shares are given. */
const MIN_LETTERS = 200;
/** A script is named when it has at least this share of the letters, in percent. */
const MIN_SHARE = 5;
/** A page is judged garbled only with at least this many characters that are not white space. */
const MIN_PAGE_CHARACTERS = 40;

const PAGE_LINE = /^--- Page (\d+) ---$/;
const NO_TEXT_LINE = "[No text on this page. It may be a scan, a photo, or a chart.]";
const PICTURE_LINE = "[Picture on this page. This text cannot show it.]";

/**
 * The script of the letter at `at`, or undefined when it is not a letter. The common scripts are
 * known by their code points, with no regular expression; only rarer blocks are tested.
 */
function letterScript(text: string, at: number): string | undefined {
  const code = text.charCodeAt(at);
  if (code < 0x80) return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ? "Latin" : undefined;
  if (code >= 0x5d0 && code <= 0x5f2) return code <= 0x5ea || code >= 0x5f0 ? "Hebrew" : undefined;
  if (code >= 0x591 && code <= 0x5cf) return undefined; // Hebrew points and marks
  if (code >= 0xc0 && code <= 0x24f) return code === 0xd7 || code === 0xf7 ? undefined : "Latin";
  if ((code >= 0x620 && code <= 0x64a) || (code >= 0x671 && code <= 0x6d3)) return "Arabic";
  if (code >= 0x410 && code <= 0x44f) return "Cyrillic";
  if (code >= 0x4e00 && code <= 0x9fff) return "CJK";
  if (code >= 0xdc00 && code <= 0xdfff) return undefined;
  const character = code >= 0xd800 && code <= 0xdbff ? text.slice(at, at + 2) : text[at]!;
  return LETTER.test(character) ? scriptOf(character.codePointAt(0)!) : undefined;
}

/** The script of a letter, by its code point. */
function scriptOf(code: number): string {
  if (code < 0x250) return "Latin";
  if (code >= 0x370 && code < 0x400) return "Greek";
  if (code >= 0x400 && code < 0x530) return "Cyrillic";
  if (code >= 0x590 && code < 0x600) return "Hebrew";
  if ((code >= 0x600 && code < 0x780) || (code >= 0xfb50 && code < 0xfe00) || (code >= 0xfe70 && code < 0xff00)) return "Arabic";
  if (code >= 0xfb1d && code < 0xfb50) return "Hebrew";
  if (code >= 0x900 && code < 0x980) return "Devanagari";
  if (code >= 0xe00 && code < 0xe80) return "Thai";
  if ((code >= 0x3040 && code < 0x3100) || (code >= 0x3400 && code < 0xa000) || (code >= 0xac00 && code < 0xd7b0) || (code >= 0x1100 && code < 0x1200)) return "CJK";
  if (code >= 0x1e00 && code < 0x1f00) return "Latin";
  return "other";
}

const LETTER = /\p{L}/u;

/** The text quality of a document, from its lines (see `TextQuality`). */
export async function measureQuality(lines: string[], format: DocumentFormat, slicer: TimeSlicer): Promise<TextQuality> {
  const empty: number[] = [];
  const garbled: number[] = [];
  let emptyCount = 0;
  let garbledCount = 0;
  // The page being read: its number, its characters that are not white space, its letters and
  // digits, its replacement characters, and whether it said it has no text.
  let page = 0;
  let characters = 0;
  let wordy = 0;
  let replaced = 0;
  let noText = false;
  const endPage = () => {
    if (page === 0) return;
    if (noText && characters === 0) {
      emptyCount++;
      if (empty.length < MAX_LISTED_PAGES) empty.push(page);
    } else if (characters >= MIN_PAGE_CHARACTERS && (wordy / characters < 0.3 || replaced > Math.max(6, characters * 0.03))) {
      garbledCount++;
      if (garbled.length < MAX_LISTED_PAGES) garbled.push(page);
    }
  };
  const letters = new Map<string, number>();
  let sampled = 0;
  let total = 0;
  /** Adds a line of a PDF page to its counts, a character code at a time. */
  const countPage = (line: string) => {
    for (let at = 0; at < line.length; at++) {
      const code = line.charCodeAt(at);
      if (code === 32 || code === 9 || code === 0xa0 || code === 0x202f) continue;
      // The second half of a character outside the basic plane is counted with its first.
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      characters++;
      if (code === 0xfffd) replaced++;
      else if ((code >= 48 && code <= 57) || letterScript(line, at) !== undefined) wordy++;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    if ((index & 4095) === 4095) await slicer.maybePause();
    const line = lines[index]!;
    if (format === "pdf") {
      const header = PAGE_LINE.exec(line);
      if (header && Number(header[1]) === page + 1) {
        endPage();
        page++;
        characters = wordy = replaced = 0;
        noText = false;
        continue;
      }
      if (line === NO_TEXT_LINE) {
        noText = true;
        continue;
      }
      if (line !== PICTURE_LINE) countPage(line);
    }
    if (sampled < SCRIPT_SAMPLE) {
      sampled += line.length + 1;
      for (let at = 0; at < line.length; at++) {
        const script = letterScript(line, at);
        if (script === undefined) continue;
        letters.set(script, (letters.get(script) ?? 0) + 1);
        total++;
      }
    }
  }
  endPage();
  const shares = total >= MIN_LETTERS
    ? [...letters].map(([script, count]) => ({ script, percent: Math.round((count / total) * 100) })).filter((share) => share.percent >= MIN_SHARE && share.script !== "other").sort((left, right) => right.percent - left.percent)
    : [];
  const notLatinOnly = shares.some((share) => share.script !== "Latin");
  return {
    ...(emptyCount > 0 ? { pagesWithoutText: empty } : {}),
    ...(garbledCount > 0 ? { garbledPages: garbled } : {}),
    ...(notLatinOnly ? { scripts: shares } : {}),
  };
}

/** Page numbers as a short list: "3, 7, 12" or "3, 7, 12 and 40 more". */
export function pageList(pages: number[], shown = 12): string {
  const listed = pages.slice(0, shown).join(", ");
  return pages.length > shown ? `${listed} and ${pages.length - shown} more` : listed;
}
