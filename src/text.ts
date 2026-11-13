/** Lines longer than this are split so line-based tools always return bounded output. */
export const MAX_LINE_CHARACTERS = 2_000;

/**
 * Terminal escape sequences: CSI ("ESC [ 31 m"), OSC ("ESC ] 0;title BEL", ended by BEL or
 * "ESC \" on the same line), character-set selection ("ESC ( B"), and two-character escapes
 * ("ESC 7", "ESC c"). Coloured logs are full of them. An "ESC ]" whose end is not on its line is
 * not a sequence: only those two characters go. Otherwise one stray "ESC ]", a cut-off window title
 * or two bytes in a logged user agent, would take every line after it.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)|[ -\/]+[0-~]|[0-~])/g;

/**
 * Strips a BOM, unifies line endings, and removes terminal escape sequences and control characters
 * other than tab and newline.
 */
export function normalizeText(raw: string): string {
  let text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // Remove whole sequences first. Dropping only the ESC byte would leave "[31mERROR[0m" behind.
  if (text.includes("\x1b")) text = text.replace(ANSI_ESCAPE, "");
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Lowercases for case-insensitive search without changing the string's length, so an offset in the
 * result points at the same character in the original. "İ" (U+0130) is the one character whose
 * lowercase form is longer; it is folded to "i".
 */
export function foldCase(text: string): string {
  const lower = (text.includes("\u0130") ? text.replaceAll("\u0130", "i") : text).toLowerCase();
  if (lower.length === text.length) return lower;
  // Not expected with today's Unicode data. Fold unit by unit and keep any unit that would grow.
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const unit = text[index]!;
    const folded = unit.toLowerCase();
    out += folded.length === 1 ? folded : unit;
  }
  return out;
}

/** The first and the second half of a character outside the basic plane, as JavaScript holds it. */
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Splits lines longer than `limit`, preferring a break after whitespace or punctuation near the
 * end of each piece. Minified JSON or a PDF paragraph becomes many addressable lines.
 */
export function wrapLongLines(text: string, limit = MAX_LINE_CHARACTERS): { text: string; wrapped: number } {
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
  let tokens = 0;
  // The current run of ASCII letters: its length since the last case change, and its casing.
  let piece = 0;
  let capitalsInARow = 0;
  let previousWasLower = false;
  let previous = 0; // 1 = space, 2 = ASCII punctuation, 0 = anything else
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
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
  return Math.ceil(tokens);
}

/**
 * The size of a text in one pass: its UTF-8 bytes, and the bytes it takes as a string in a JSON
 * request body, which is what a model connector's request limit counts. JSON writes a quote and a
 * backslash as two characters, a line break or a tab as two, any other control character as six
 * (`\u0007`), and half of a surrogate pair as six: an export full of quotes or tabs grows by a
 * quarter or more, a novel by a hundredth.
 */
export function textSizes(text: string): { utf8: number; json: number } {
  let utf8 = 0;
  let escapes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      utf8 += 1;
      if (code === 0x22 || code === 0x5c) escapes += 1;
      else if (code < 0x20) escapes += code === 0x0a || code === 0x09 || code === 0x0d || code === 0x08 || code === 0x0c ? 1 : 5;
    } else if (code < 0x800) {
      utf8 += 2;
    } else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
      utf8 += 4;
      index++;
    } else {
      utf8 += 3;
      // Half of a pair on its own: three bytes of replacement character as UTF-8, six as \udXXX in JSON.
      if (code >= 0xd800 && code <= 0xdfff) escapes += 3;
    }
  }
  return { utf8, json: utf8 + escapes + 2 };
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
