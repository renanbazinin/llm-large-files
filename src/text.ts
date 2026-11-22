import type { TimeSlicer } from "./pause.js";

/** Lines longer than this are split so line-based tools always return bounded output. */
export const MAX_LINE_CHARACTERS = 2_000;

/**
 * Terminal escape sequences: CSI ("ESC [ 31 m"), OSC ("ESC ] 0;title BEL", ended by BEL or
 * "ESC \" on the same line), character-set selection ("ESC ( B"), and two-character escapes
 * ("ESC 7", "ESC c"). Coloured logs are full of them. An "ESC ]" whose end is not on its line is
 * not a sequence: only those two characters go. Otherwise one stray "ESC ]", a cut-off window title
 * or two bytes in a logged user agent, would take every line after it.
 * U+009B, the one-character form of "ESC [", starts a sequence only with a parameter ("\x9b31m"),
 * and not right after U+0080-U+00FF: there it is the end of a letter of UTF-8 read as Latin-1
 * ("ś" is C5 9B, so "Coś? Tak" holds "\xc5\x9b? Tak"), and what follows it is text. `INVISIBLE`
 * removes the U+009B alone then.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)|[ -\/]+[0-~]|[0-~])|(?<![\x80-\xff])\x9b[0-?]+[ -\/]*[@-~]/g;

/**
 * Characters that show nothing, that no script needs, and that can hide text from a person who
 * reads the file while a model reads it:
 * - control characters other than tab and line breaks: C0 (U+0000-U+001F, U+007F) and C1
 *   (U+0080-U+009F);
 * - Unicode tag characters (U+E0000-U+E007F). Each spells out one ASCII character, which a model
 *   reads and a person does not see. The three flags written with them (England, Scotland,
 *   Wales) are kept;
 * - the text-direction controls that change the order a person sees: embeddings and overrides
 *   (U+202A-U+202E) and isolates (U+2066-U+2069). The marks that right-to-left text needs
 *   (U+200E, U+200F, U+061C) are kept;
 * - the zero-width space (U+200B), the word joiner and invisible operators (U+2060-U+2064), the
 *   deprecated format characters (U+206A-U+206F), a byte order mark inside the text (U+FEFF), and
 *   the soft hyphen (U+00AD), but not one before a line break: there it shows, as a hyphen.
 * Zero-width joiners and non-joiners (U+200C, U+200D) are kept: emoji and some scripts need them.
 * Tab, "\n" and "\r" are not among them, so removing them moves no line. U+0085 goes with the other
 * C1 characters, except where it ends lines (see `NEXT_LINE`).
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]+|\xAD(?!\n)|\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62\uDB40(?:\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDC73\uDB40\uDC63\uDB40\uDC74|\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F|(?:\uDB40[\uDC00-\uDC7F])+/g;
/** A flag written with tag characters starts with U+1F3F4, whose first half is this. */
const FLAG_START = 0xd83c;
/**
 * U+0085 (next line) ends each record of a mainframe file converted to UTF-8, which has no other
 * line break: in such a text it becomes a line break (see `breaksAtNextLine`). Not one right after
 * U+0080-U+00FF: there it is the last byte of a UTF-8 letter read as Latin-1 ("ą" is C4 85), and a
 * line break would split the word. `INVISIBLE` removes that one, and those of other texts.
 */
const NEXT_LINE = /(?<![\x80-\xFF])\x85/g;
/** A run of U+0085, to go past it in one step. */
const NEXT_LINE_RUN = /\x85+/y;

/** `text` without the characters of `INVISIBLE`. */
export function removeInvisible(text: string): string {
  return text.replace(INVISIBLE, (found) => (found.charCodeAt(0) === FLAG_START ? found : ""));
}

/** A word for a count: "line" for 1, "lines" for any other. */
export const plural = (count: number, word: string): string => (count === 1 ? word : `${word}s`);

/**
 * Whether the U+0085 of `text` end lines: only when it has no other line break, one at its very end
 * aside. A mainframe file converted to UTF-8 has none. In a text that has them, a U+0085 is more
 * often in a JSON string or a CSV field, or a windows-1252 "…" read as Latin-1, and a line break
 * there would split a record and move every line after it.
 */
export function breaksAtNextLine(text: string): boolean {
  let end = text.length;
  if (text.charCodeAt(end - 1) === 10) end--;
  if (text.charCodeAt(end - 1) === 13) end--;
  const lineFeed = text.indexOf("\n");
  if (lineFeed !== -1 && lineFeed < end) return false;
  const carriageReturn = text.indexOf("\r");
  return carriageReturn === -1 || carriageReturn >= end;
}

/** `removeInvisible`, after each U+0085 that ends a line is made a line break, when `nextLines`; then `composed`. */
function cleanLines(text: string, nextLines: boolean): string {
  return composed(removeInvisible(nextLines && text.includes("\x85") ? text.replace(NEXT_LINE, "\n") : text));
}

/** A character that Unicode normalization (NFC) may change: nothing below U+0300 does. */
const MAY_COMPOSE = /[^\x00-\u02ff]/;

/**
 * `text` in Unicode's composed form (NFC): "e" followed by a combining acute accent becomes one
 * "é", as a model writes it in a query. Text exported from macOS, from some PDF and Word files, and
 * Vietnamese, often comes decomposed, and a search for the composed word found nothing in it. Text
 * with no character from U+0300 on is returned as it is, without the cost of normalizing it.
 * Hebrew and Arabic points are not composed by NFC: they stay as they are.
 */
export function composed(text: string): string {
  return MAY_COMPOSE.test(text) ? text.normalize("NFC") : text;
}

/**
 * Strips a BOM, unifies line endings, and removes terminal escape sequences, control characters
 * other than tab and newline, and the invisible characters of `INVISIBLE`. In a text with no other
 * line break, a U+0085 becomes one (see `NEXT_LINE`).
 */
export function normalizeText(raw: string): string {
  const text = raw.replace(/^﻿/, "");
  return normalizeLines(text, breaksAtNextLine(text));
}

/**
 * `normalizeText` without the BOM: the same on a whole text as on pieces of it cut after line
 * breaks, given `breaksAtNextLine` of the whole text as `nextLines`.
 */
function normalizeLines(raw: string, nextLines: boolean): string {
  return cleanLines(withoutEscapes(raw.replace(/\r\n?/g, "\n")), nextLines);
}

/** `text` without terminal escape sequences. */
function withoutEscapes(text: string): string {
  // Remove whole sequences first. Dropping only the ESC byte would leave "[31mERROR[0m" behind.
  // U+009B is the one-character form of "ESC [".
  return text.includes("\x1b") || text.includes("\x9b") ? text.replace(ANSI_ESCAPE, "") : text;
}

/**
 * `withoutEscapes`, with a pause after each `piece` characters or so. The sequences are found one
 * after the other, as `replace` finds them, so the result is the same.
 */
async function withoutEscapesInPieces(text: string, slicer: TimeSlicer, piece: number): Promise<string> {
  if (!text.includes("\x1b") && !text.includes("\x9b")) return text;
  // A copy of its own: during a pause, another ingest may use `ANSI_ESCAPE`, which moves its lastIndex.
  const escape = new RegExp(ANSI_ESCAPE.source, "g");
  const done: string[] = [];
  let parts: string[] = [];
  // Where the text after the last sequence starts, and where the last pause was.
  let kept = 0;
  let paused = 0;
  for (let found = escape.exec(text); found !== null; found = escape.exec(text)) {
    parts.push(text.slice(kept, found.index));
    kept = escape.lastIndex;
    if (kept - paused >= piece) {
      done.push(parts.join(""));
      parts = [];
      paused = kept;
      await slicer.maybePause();
    }
  }
  parts.push(text.slice(kept));
  done.push(parts.join(""));
  return done.length === 1 ? done[0]! : done.join("");
}

/**
 * `normalizeLines`, a piece of about `piece` characters at a time, with a pause between pieces. A
 * line with no break for megabytes can hold millions of characters or escape sequences to remove,
 * which take seconds in one go. The escape sequences are found in order, as in one go, and the
 * pieces of the last step (`cleanLines`) end where `cutsCleanly` says, so the result is the same.
 */
export async function normalizeInPieces(raw: string, slicer: TimeSlicer, nextLines: boolean, piece = SLICE_CHARACTERS): Promise<string> {
  const text = await withoutEscapesInPieces(raw.replace(/\r\n?/g, "\n"), slicer, piece);
  const parts: string[] = [];
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + piece);
    // Where the next piece starts.
    let next = to;
    while (to < text.length && !cutsCleanly(text, to)) {
      if (text.charCodeAt(to) === 0x85) {
        // A run of U+0085 after U+0080-U+00FF, which no place may cut. `cleanLines` removes all of
        // it, and gives the same on the text before it and after it alone: the run is left out.
        NEXT_LINE_RUN.lastIndex = to;
        NEXT_LINE_RUN.test(text);
        next = NEXT_LINE_RUN.lastIndex;
        break;
      }
      next = ++to;
    }
    parts.push(cleanLines(text.slice(from, to), nextLines));
    from = next;
    await slicer.maybePause();
  }
  return parts.length === 1 ? parts[0]! : parts.join("");
}

/**
 * Whether `cleanLines` gives the same result on `text` cut before `at` as on it whole. It does
 * unless the cut is between the two halves of a character outside the basic plane, inside a flag,
 * between a soft hyphen and a line break, or before a U+0085 right after U+0080-U+00FF. Only
 * these places are kept whole: a rule that never cut after a soft hyphen or half of a pair would
 * never cut a line of soft hyphens, or of tag characters and emoji in turn, and such a line
 * would be cleaned in one go again.
 */
function cutsCleanly(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  if (isHighSurrogate(before) && isLowSurrogate(after)) return false;
  // NFC (`composed`) joins a mark to the letter before it, and Hangul jamo to each other.
  if (composesWithBefore(text, at)) return false;
  if (before === 0xad && after === 0x0a) return false;
  if (after === 0x85 && before >= 0x80 && before <= 0xff) return false;
  // A flag is 14 units: U+1F3F4, then tag characters, each a pair that starts with U+DB40.
  if (after === 0xdb40 && text.slice(Math.max(0, at - 12), at).includes("\uD83C\uDFF4")) return false;
  return true;
}

/** A combining mark, or a Hangul vowel or final consonant: NFC may join it to what comes before. */
const JOINS_BEFORE = /^[\p{M}\u1160-\u11ff\ud7b0-\ud7ff]/u;

/** Whether the character at `at` may be joined by NFC to the one before it, so a cut there would change the result. */
function composesWithBefore(text: string, at: number): boolean {
  const after = text.charCodeAt(at);
  if (after < 0x0300) return false;
  return JOINS_BEFORE.test(text.slice(at, at + 2));
}

/**
 * Characters that are written several ways for one meaning, each folded to the plain one for a
 * search that ignores case: curly quotes and primes to `'` and `"`, Hebrew geresh (׳) and gershayim
 * (״) too, which keyboards replace by them ("צה״ל", "צה\"ל"); hyphens, dashes, the minus sign and the
 * Hebrew maqaf (־) to "-"; no-break, thin and other fixed-width spaces to a space; and the
 * full-width forms of ASCII (Ａ, １) to ASCII. Each is one UTF-16 unit for one, so offsets keep.
 */
const SEARCH_FOLDS: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'", "\u05f3": "'", "\u02bc": "'",
  "\u201c": "\"", "\u201d": "\"", "\u201e": "\"", "\u201f": "\"", "\u2033": "\"", "\u05f4": "\"",
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-", "\u05be": "-",
  "\u00a0": " ", "\u2007": " ", "\u2009": " ", "\u200a": " ", "\u202f": " ", "\u2002": " ", "\u2003": " ",
  "\u03c2": "\u03c3",
};
const SEARCH_FOLD = /[\u2018\u2019\u201a\u201b\u2032\u05f3\u02bc\u201c\u201d\u201e\u201f\u2033\u05f4\u2010-\u2015\u2212\u05be\u00a0\u2007\u2009\u200a\u202f\u2002\u2003\u03c2\uff01-\uff5e]/g;

/**
 * Lowercases for case-insensitive search without changing the string's length, so an offset in the
 * result points at the same character in the original. "İ" (U+0130) is the one character whose
 * lowercase form is longer; it is folded to "i". Greek final sigma (ς) is folded to σ, as an upper
 * case Σ is lowered to either depending on where it stands. Then the characters of `SEARCH_FOLDS`
 * are folded, and the full-width forms of ASCII: a search for "don't" finds "don’t".
 */
export function foldCase(text: string): string {
  let lower = (text.includes("\u0130") ? text.replaceAll("\u0130", "i") : text).toLowerCase();
  if (lower.length !== text.length) {
    // Not expected with today's Unicode data. Fold unit by unit and keep any unit that would grow.
    let out = "";
    for (let index = 0; index < text.length; index++) {
      const unit = text[index]!;
      const folded = unit.toLowerCase();
      out += folded.length === 1 ? folded : unit;
    }
    lower = out;
  }
  SEARCH_FOLD.lastIndex = 0;
  if (!SEARCH_FOLD.test(lower)) return lower;
  return lower.replace(SEARCH_FOLD, (unit) => SEARCH_FOLDS[unit] ?? String.fromCharCode(unit.charCodeAt(0) - 0xfee0));
}

/** The first and the second half of a character outside the basic plane, as JavaScript holds it. */
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The first `end` UTF-16 units of `text`, one fewer when the last of them would be the first half
 * of a character outside the basic plane (an emoji). Half of one is not text: JSON writes it as
 * `\ud83d`, and an API that checks its input (Claude's) refuses the request.
 */
export function sliceWhole(text: string, end: number): string {
  const at = Math.max(0, Math.min(text.length, Math.trunc(end)));
  return at > 0 && at < text.length && isHighSurrogate(text.charCodeAt(at - 1)) ? text.slice(0, at - 1) : text.slice(0, at);
}

/** Half of a character outside the basic plane, on its own. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * `text` with each half of a character that is on its own (an emoji cut in two) made a replacement
 * character, as `String.prototype.toWellFormed` does. 0.5.0 cut some strings that way, and kept them:
 * log templates in the metadata, and search windows in tool rounds. Claude's API refuses a request
 * that holds one. Text that is whole comes back as it is.
 */
export function wellFormed(text: string): string {
  return /[\ud800-\udfff]/.test(text) ? text.replace(LONE_SURROGATE, "\ufffd") : text;
}

/**
 * A JSON value with `wellFormed` applied to every string in it, keys included. The same value, not
 * a copy, when nothing in it needed that.
 */
export function wellFormedJson<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item: unknown) => {
      const fixed = wellFormedJson(item);
      if (fixed !== item) changed = true;
      return fixed;
    });
    return (changed ? items : value) as T;
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
      const fixedKey = wellFormed(key);
      const fixed = wellFormedJson(item);
      if (fixedKey !== key || fixed !== item) changed = true;
      return [fixedKey, fixed];
    });
    return (changed ? Object.fromEntries(entries) : value) as T;
  }
  return value;
}

/**
 * Splits lines longer than `limit`, preferring a break after whitespace or punctuation near the
 * end of each piece. Minified JSON or a PDF paragraph becomes many addressable lines.
 */
export function wrapLongLines(text: string, limit = MAX_LINE_CHARACTERS): { text: string; wrapped: number } {
  // Most files have no long line: then the text is used as it is, without splitting and joining it.
  let longest = 0;
  let start = 0;
  for (let end = text.indexOf("\n"); ; end = text.indexOf("\n", start)) {
    const stop = end === -1 ? text.length : end;
    if (stop - start > longest) longest = stop - start;
    if (end === -1 || longest > limit) break;
    start = end + 1;
  }
  if (longest <= limit) return { text, wrapped: 0 };
  let wrapped = 0;
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= limit) {
      out.push(line);
      continue;
    }
    wrapped++;
    let rest = line;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      const soft = Math.max(window.lastIndexOf(" "), window.lastIndexOf(","), window.lastIndexOf(";"), window.lastIndexOf("}"));
      let cut = soft > limit * 0.8 ? soft + 1 : limit;
      // Never between the two halves of a character outside the basic plane (an emoji): each half
      // alone is stored as a replacement character.
      if (isHighSurrogate(rest.charCodeAt(cut - 1)) && isLowSurrogate(rest.charCodeAt(cut))) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return { text: out.join("\n"), wrapped };
}

// Token cost of each kind of character, fitted to Gemini's countTokens on 60 texts (prose in
// eleven languages, source code, JSON, CSV, and eight log formats; Gemini 2.5, 3.5, and 3.8 count
// identically). On those texts the estimate is between 0.98 and 1.7 times Gemini's count.
const WORD = 1.1; // A run of ASCII letters.
const CASE_CHANGE = 1.3; // "camelCase", "HTTPServer", base64: each change starts a new piece.
const LONG_LETTER = 0.18; // Each letter past the 6th of a piece (the 3rd for capitals).
const LONG_AFTER = 6;
const LONG_AFTER_CAPITALS = 3;
const VERY_LONG_LETTER = 0.5; // Each letter past the 20th: no longer a word, but a key or a sequence.
const VERY_LONG_AFTER = 20;
const DIGIT = 1.2; // Digits are about one token each, so IDs, timestamps, and numbers are dense.
const PUNCTUATION = 0.85; // The first of a run of ASCII punctuation; the rest of the run is free.
const NEWLINE = 2.2;
const TAB = 1;
const LOOSE_SPACE = 0.2; // A space before anything but a letter. A space before a word is free.
const SPACE_RUN = 16; // A run of spaces costs a token for each this many after its first.
const LATIN_EXTENDED = 0.6; // é, ü, ß
const GREEK = 0.4;
const CYRILLIC = 0.3;
const HEBREW = 0.52;
const ARABIC = 0.41;
const OTHER_SCRIPT = 0.45; // Devanagari, Thai, Georgian, and other alphabets and syllabaries.
const HAN = 0.7;
const KANA = 0.56;
const HANGUL = 0.7;
const SURROGATE = 0.5; // Half of an emoji or another character outside the basic plane.
const SYMBOL = 1; // Dashes, quotes, arrows, box drawing, and anything unclassified.

/**
 * Estimates how many tokens a model will count for `text`, without calling the model.
 *
 * Characters per token varies a lot with the kind of text: about 4.5 for English prose, 2 for
 * Hebrew, and between 1 and 2 for logs, CSV, and hex, because digits cost about a token each. A
 * flat "4 characters per token" is therefore right for a novel and three times too low for a log.
 * This walks the text once and prices each kind of character. It leans high, which only moves a
 * document to the searchable path sooner. The one kind of text it still counts low is a long run
 * of random letters in a single case with no digits (about 70% of the real count).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(tokensIn(text, 0, text.length, 0));
}

/**
 * The tokens of `text` from `from` to `to`, added to `tokens`. Every count starts again after a line
 * break, so a text cut after line breaks gives, piece by piece, the sum it gives whole.
 */
function tokensIn(text: string, from: number, to: number, tokens: number): number {
  // The current run of ASCII letters: its length since the last case change, and its casing.
  let piece = 0;
  let capitalsInARow = 0;
  let previousWasLower = false;
  let previous = 0; // 1 = space, 2 = ASCII punctuation, 0 = anything else
  let spaces = 0; // the length of the current run of spaces
  for (let index = from; index < to; index++) {
    const code = text.charCodeAt(index);
    if (code !== 32) spaces = 0;
    if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90)) {
      const capital = code <= 90;
      if (piece === 0) tokens += WORD;
      else if ((capital && previousWasLower) || (!capital && capitalsInARow >= 2)) {
        tokens += CASE_CHANGE;
        piece = 0;
      }
      piece++;
      if (piece > VERY_LONG_AFTER) tokens += VERY_LONG_LETTER;
      else if (piece > (capital ? LONG_AFTER_CAPITALS : LONG_AFTER)) tokens += LONG_LETTER;
      capitalsInARow = capital ? capitalsInARow + 1 : 0;
      previousWasLower = !capital;
      previous = 0;
      continue;
    }
    piece = 0;
    capitalsInARow = 0;
    previousWasLower = false;
    if (code === 32) {
      // Tokenizers have tokens for runs of spaces up to a length: a long run costs about one token
      // for every SPACE_RUN spaces after the first. Fixed-width reports and padded tables were
      // planned at almost nothing, then refused by the provider.
      if (++spaces > 1 && (spaces - 1) % SPACE_RUN === 0) tokens += 1;
      previous = 1;
      continue;
    }
    if (previous === 1) tokens += LOOSE_SPACE;
    if (code < 0x80) {
      if (code >= 48 && code <= 57) tokens += DIGIT;
      else if (code === 10) tokens += NEWLINE;
      else if (code === 9) tokens += TAB;
      else {
        if (previous !== 2) tokens += PUNCTUATION;
        previous = 2;
        continue;
      }
      previous = 0;
      continue;
    }
    previous = 0;
    if (code < 0xc0) tokens += SYMBOL;
    else if (code < 0x250) tokens += LATIN_EXTENDED;
    else if (code < 0x370) tokens += OTHER_SCRIPT;
    else if (code < 0x400) tokens += GREEK;
    else if (code < 0x530) tokens += CYRILLIC;
    else if (code < 0x590) tokens += OTHER_SCRIPT;
    else if (code < 0x600) tokens += HEBREW;
    else if (code < 0x700) tokens += ARABIC;
    else if (code < 0x2000) tokens += OTHER_SCRIPT;
    else if (code < 0x2e80) tokens += SYMBOL;
    else if (code < 0x3400) tokens += KANA;
    else if (code < 0xac00) tokens += HAN;
    else if (code < 0xd800) tokens += HANGUL;
    else if (code < 0xe000) tokens += SURROGATE;
    else if (code < 0xf900) tokens += SYMBOL;
    else if (code < 0xfb00) tokens += HAN;
    else if (code < 0xff00) tokens += OTHER_SCRIPT;
    else tokens += KANA;
  }
  return tokens;
}

/**
 * The size of a text in one pass: its UTF-8 bytes, and the bytes it takes as a string in a JSON
 * request body, which is what a model connector's request limit counts. JSON writes a quote and a
 * backslash as two characters, a line break or a tab as two, any other control character as six
 * (`\u0007`), and half of a surrogate pair as six: an export full of quotes or tabs grows by a
 * quarter or more, a novel by a hundredth.
 */
export function textSizes(text: string): { utf8: number; json: number } {
  const { utf8, escapes } = sizesIn(text, 0, text.length);
  return { utf8, json: utf8 + escapes + 2 };
}

/** UTF-8 bytes and JSON escapes of `text` from `from` to `to`, which must not split a surrogate pair. */
function sizesIn(text: string, from: number, to: number): { utf8: number; escapes: number } {
  let utf8 = 0;
  let escapes = 0;
  for (let index = from; index < to; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      utf8 += 1;
      if (code === 0x22 || code === 0x5c) escapes += 1;
      else if (code < 0x20) escapes += code === 0x0a || code === 0x09 || code === 0x0d || code === 0x08 || code === 0x0c ? 1 : 5;
    } else if (code < 0x800) {
      utf8 += 2;
    } else if (isHighSurrogate(code) && index + 1 < to && isLowSurrogate(text.charCodeAt(index + 1))) {
      utf8 += 4;
      index++;
    } else {
      utf8 += 3;
      // Half of a pair on its own: three bytes of replacement character as UTF-8, six as \udXXX in JSON.
      if (code >= 0xd800 && code <= 0xdfff) escapes += 3;
    }
  }
  return { utf8, escapes };
}

/** Characters worked on between two looks at the clock while ingesting. */
const SLICE_CHARACTERS = 1 << 18;

/**
 * The text cut into slices of about 256K characters, each ending after a line break (the last
 * one at the end of the text), as `[from, to)` offsets.
 */
function* lineSlices(text: string): Generator<[number, number]> {
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + SLICE_CHARACTERS);
    if (to < text.length) {
      const newline = text.indexOf("\n", to - 1);
      to = newline === -1 ? text.length : newline + 1;
    }
    yield [from, to];
    from = to;
  }
}

/**
 * `estimateTokens` and `textSizes` of a text, the same numbers, worked out a slice at a time so
 * that other requests get a turn while a large upload is measured. Slices end after a line break.
 */
export async function measureText(text: string, slicer: TimeSlicer): Promise<{ tokens: number; utf8: number; json: number }> {
  let tokens = 0;
  let utf8 = 0;
  let escapes = 0;
  for (const [from, to] of lineSlices(text)) {
    tokens = tokensIn(text, from, to, tokens);
    const sizes = sizesIn(text, from, to);
    utf8 += sizes.utf8;
    escapes += sizes.escapes;
    await slicer.maybePause();
  }
  return { tokens: Math.ceil(tokens), utf8, json: utf8 + escapes + 2 };
}

/**
 * What ingest makes of extracted text, a slice at a time: `normalizeText`, then `wrapLongLines`,
 * then the lines (a line break at the very end does not start another line). The same results as
 * doing each in one go: no step of `normalizeText` reaches across a line break, and whether a U+0085
 * ends lines is decided once, for the whole text. A slice that runs far past its size holds a long
 * line: it is cleaned in pieces too. `onProgress` is told the characters of `raw` cleaned so far,
 * after each slice; splitting the lines after that is quick, and is not counted.
 */
export async function prepareText(
  raw: string,
  slicer: TimeSlicer,
  onProgress?: (done: number, total: number) => void,
): Promise<{ text: string; wrapped: number; lines: string[] }> {
  const start = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = start === 1 ? raw.slice(1) : raw;
  const nextLines = breaksAtNextLine(body);
  const parts: string[] = [];
  // A clean text (most logs) comes back as it is: joining its slices would copy all of it.
  let changed = false;
  for (const [from, to] of lineSlices(body)) {
    const slice = body.slice(from, to);
    const normalized = slice.length > 2 * SLICE_CHARACTERS ? await normalizeInPieces(slice, slicer, nextLines) : normalizeLines(slice, nextLines);
    if (normalized !== slice) changed = true;
    parts.push(normalized);
    onProgress?.(start + to, raw.length);
    await slicer.maybePause();
  }
  const { text, wrapped } = wrapLongLines(!changed ? body : parts.length === 1 ? parts[0]! : parts.join(""));
  parts.length = 0;
  await slicer.maybePause();
  const lines: string[] = [];
  for (const [from, to] of lineSlices(text)) {
    const piece = text.slice(from, to).split("\n");
    // A slice that ends with a line break splits into one empty string too many.
    if (text.charCodeAt(to - 1) === 10) piece.pop();
    for (const line of piece) lines.push(line);
    await slicer.maybePause();
  }
  return { text, wrapped, lines };
}

/** UTF-8 byte length without allocating an encoded copy. */
export function utf8Bytes(text: string): number {
  return textSizes(text).utf8;
}

/** Bytes a string takes in a JSON request body: its UTF-8 bytes, the escapes JSON adds, and its two quotes. */
export function jsonBytes(text: string): number {
  return textSizes(text).json;
}

/** Fast line lookups over one text. Line numbers are 1-based. */
export class LineIndex {
  private readonly starts: Uint32Array;
  readonly lineCount: number;

  /** `knownStarts`, when given, are where each line starts in `text`: they are used as they are. */
  constructor(private readonly text: string, knownStarts?: Uint32Array) {
    if (knownStarts) {
      this.starts = knownStarts;
      this.lineCount = knownStarts.length;
      return;
    }
    let count = 1;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
    // A trailing newline does not start another line.
    if (text.endsWith("\n")) count--;
    count = Math.max(count, text.length === 0 ? 0 : 1);
    this.starts = new Uint32Array(count);
    let line = 1;
    for (let at = text.indexOf("\n"); at !== -1 && line < count; at = text.indexOf("\n", at + 1)) {
      this.starts[line++] = at + 1;
    }
    this.lineCount = count;
  }

  /** The 1-based line that contains a character offset. */
  lineAt(offset: number): number {
    let low = 0;
    let high = this.lineCount - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  startOf(line: number): number {
    return this.starts[line - 1] ?? this.text.length;
  }

  endOf(line: number): number {
    const next = this.starts[line];
    if (next !== undefined) return next - 1;
    return this.text.endsWith("\n") ? this.text.length - 1 : this.text.length;
  }

  line(line: number): string {
    if (line < 1 || line > this.lineCount) return "";
    return this.text.slice(this.startOf(line), this.endOf(line));
  }

  /** Lines `from`..`to` inclusive, each prefixed with its number. */
  numbered(from: number, to: number): string {
    const out: string[] = [];
    for (let line = Math.max(1, from); line <= Math.min(to, this.lineCount); line++) {
      out.push(`${line}| ${this.line(line)}`);
    }
    return out.join("\n");
  }
}
