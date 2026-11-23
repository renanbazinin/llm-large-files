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
      if (line !== PICTURE_LINE) {
        for (const character of line) {
          if (character.trim() === "") continue;
          characters++;
          if (character === "�") replaced++;
          else if (/[\p{L}\p{N}]/u.test(character)) wordy++;
        }
      }
    }
    if (sampled < SCRIPT_SAMPLE) {
      sampled += line.length + 1;
      for (const character of line) {
        const code = character.codePointAt(0)!;
        // ASCII letters, the common case, without a regex.
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          letters.set("Latin", (letters.get("Latin") ?? 0) + 1);
          total++;
        } else if (code >= 0x80 && LETTER.test(character)) {
          const script = scriptOf(code);
          letters.set(script, (letters.get(script) ?? 0) + 1);
          total++;
        }
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
