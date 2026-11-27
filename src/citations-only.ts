// An answer made only of citations, with `showCitations: false` (LOOP-10, new in 0.99.13): taking
// its citations out leaves it shown empty, while it is reported answered and complete. The lines it
// cited are shown in words instead: "line 8" in an English chat, "שורה 8" in a Hebrew one. Not
// part of the public API: `askWithFiles` uses it.
import type { LineCitation } from "./citations.js";

/** A Hebrew letter. */
const HEBREW = /[א-ת]/u;
/** Two Latin letters in a row, which a citation's "L12" alone does not make. */
const LATIN = /[A-Za-z]{2}/;
/** The "L12" or "L 12" of a citation, taken out before looking for Latin letters. */
const LINE_FORM = /(?<![A-Za-z])[Ll] ?\d+/g;

/**
 * Whether `text` that was shown has nothing in it a person reads as an answer: no letter, no digit
 * and no symbol (an emoji is an answer). Spaces, punctuation and list markers are not.
 */
export const showsNothing = (text: string): boolean => !/[\p{L}\p{N}\p{So}]/u.test(text);

/** Hebrew or not, by the letters of `text`: undefined when it has neither Hebrew letters nor words in Latin letters. */
function hebrewBy(text: string): boolean | undefined {
  if (HEBREW.test(text)) return true;
  return LATIN.test(text.replace(LINE_FORM, "")) ? false : undefined;
}

/**
 * Whether the words for the lines of an answer are Hebrew: when the answer (its citations, with their
 * file names) or the question has Hebrew letters, so that a Hebrew chat about "contract.txt" gets
 * "שורה 8"; English when either has words in Latin letters; else by the names of the question's
 * files. English otherwise.
 */
export function hebrewWords(answer: string, question: string | undefined, names: readonly string[]): boolean {
  const by = [hebrewBy(answer), question !== undefined ? hebrewBy(question) : undefined];
  if (by.includes(true)) return true;
  if (by.includes(false)) return false;
  return names.some((name) => HEBREW.test(name));
}

/**
 * The lines of `cited`, in words, each once and in the order of the answer: "line 8", "lines 2 and
 * 3", "lines 4–6", "row 12" for rows; "שורה 8", "שורות 3 ו-8" in Hebrew. The file names are left
 * out, as the citations hid them. Empty for no citation.
 */
export function linesInWords(cited: readonly LineCitation[], hebrew: boolean): string {
  const seen = new Set<string>();
  const ranges: Array<{ from: number; to: number; form: "line" | "row" }> = [];
  for (const { from, to, form } of cited) {
    const key = `${from}-${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({ from, to, form });
  }
  if (ranges.length === 0) return "";
  const numbers = ranges.map(({ from, to }) => (from === to ? String(from) : `${from}–${to}`));
  const many = ranges.length > 1 || ranges[0]!.from !== ranges[0]!.to;
  const list = (and: string) => (numbers.length === 1 ? numbers[0]! : `${numbers.slice(0, -1).join(", ")}${and}${numbers.at(-1)!}`);
  if (hebrew) return `${many ? "שורות" : "שורה"} ${list(" ו-")}`;
  const word = ranges.every((range) => range.form === "row") ? "row" : "line";
  return `${word}${many ? "s" : ""} ${list(" and ")}`;
}
