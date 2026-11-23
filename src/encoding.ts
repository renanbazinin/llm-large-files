// Text files whose bytes are not all valid UTF-8.
//
// Such a file is one of two things. It is UTF-8 with a few characters that are not valid: a log cut
// at a byte count, a stray byte, a binary body in a log line. Or it was saved in an older encoding:
// Excel saves a Hebrew CSV in windows-1255, and Notepad saved text in the code page of Windows.
// Each line is looked at. When at least as many lines are UTF-8 as are not, or when at most one
// line in 200 is not UTF-8, the file is UTF-8, and each character that is not valid becomes U+FFFD
// and is counted. Otherwise the lines that are not UTF-8 are read in the older encoding that their
// letters fit, and in no other: a byte that this encoding does not have becomes U+FFFD, and is
// counted too. A line that is valid UTF-8 is read as UTF-8 all the same. When the letters fit no
// older encoding for sure, the file is read as UTF-8, with the count: letters that mean nothing
// would be worse than U+FFFD that the model is told of. A text file is never refused for its
// encoding. A file in CESU-8, which writes an emoji as two halves of a surrogate pair, is read with
// its emoji when that makes it valid UTF-8.

import { isAscii, isUtf8 } from "node:buffer";

/** The text of a file whose bytes are not all valid UTF-8, and how it was read. */
export type DecodedText = {
  text: string;
  /** The older encoding the file was read in, as TextDecoder names it: "windows-1255". */
  encoding?: string;
  /** The characters that were not valid in the encoding the file was read in (UTF-8, or `encoding`): each is now U+FFFD. */
  replacedCharacters?: number;
};

/** Bytes looked at or decoded between two chances for other requests to run. */
const STEP_BYTES = 1024 * 1024;
/** Rows of lines in one encoding decoded between two chances for other requests to run: a few milliseconds. */
const RUNS_PER_STEP = 2048;
/**
 * Lines up to this many bytes are looked at byte by byte; a longer one by `isAscii` and `isUtf8` of
 * node:buffer, which cost a call each.
 */
const SHORT_LINE = 256;
/**
 * Lines in a row in a single-byte encoding, up to this many bytes, are read from a table of its
 * characters: TextDecoder takes most of a microsecond for each call.
 */
const SHORT_RUN = 64;
/** The encoding is chosen on lines that are not UTF-8, up to this many bytes: about a thousand rows of a CSV. */
const SAMPLE_BYTES = 64 * 1024;
/** In the encoding a file is read in, at most one word or sign in this many may look wrong. */
const WRONG_ONE_IN = 50;
/**
 * A file with at most one line in this many that is not UTF-8 is read as UTF-8, ASCII lines
 * counted: the other lines are stray bytes in a log, or a binary body it logged.
 */
const STRAY_ONE_IN = 200;
/** U+FFFD, which TextDecoder writes for a character that is not valid. */
const REPLACEMENT = String.fromCharCode(0xfffd);
/**
 * U+0080 to U+009F. TextDecoder gives them for some bytes that an older encoding has no character
 * for (windows-1252 0x81, 0x8D, 0x8F, 0x90 and 0x9D, windows-1255 0x8A): none of the encodings
 * here has a character of its own there.
 */
const C1_CONTROLS = /[\u0080-\u009f]/g;

type Script = "Latin" | "Cyrillic" | "Hebrew" | "Arabic" | "Japanese";

/**
 * The older encodings a file is recognized in, with the script of their letters. When the text
 * fits more than one, the first wins: a Hebrew text read as windows-1251 gives Cyrillic letters
 * that look like words, but a Russian text read as windows-1255 does not give Hebrew words.
 * ISO-8859-1 is read as windows-1252, as browsers do, and ISO-8859-8 as windows-1255.
 */
const ENCODINGS: ReadonlyArray<{ encoding: string; script: Script }> = [
  { encoding: "windows-1255", script: "Hebrew" },
  { encoding: "windows-1256", script: "Arabic" },
  { encoding: "windows-1251", script: "Cyrillic" },
  { encoding: "shift_jis", script: "Japanese" },
  { encoding: "windows-1252", script: "Latin" },
];

/**
 * Reads bytes that `TextDecoder("utf-8", { fatal: true })` refused. A generator: it yields between
 * steps of about a megabyte, and between the encodings it tries, so that the caller can let other
 * requests run.
 */
export function* decodeNotUtf8(bytes: Uint8Array): Generator<void, DecodedText> {
  const lines = yield* scanLines(bytes);
  // Every character that is not valid is half of a surrogate pair: an export in CESU-8.
  if (lines.halves > 0 && lines.errors === lines.halves * 3) {
    const text = yield* joinSurrogates(bytes);
    if (text !== undefined) return { text };
  }
  // A byte-order mark says the file is UTF-8, whatever its lines look like.
  const marked = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (marked || lines.other <= lines.utf8 || lines.other * STRAY_ONE_IN <= lines.total) return yield* readAsUtf8(bytes, lines.errors);
  const encoding = yield* firstThatFits(lines);
  yield;
  if (!encoding) return yield* readAsUtf8(bytes, lines.errors);
  // The first encoding that fits, and no other, even for a byte further on that it does not have:
  // in the next one, Hebrew would come out as Cyrillic letters. When some lines are UTF-8, they
  // are read as UTF-8 all the same.
  const { text, replaced } = lines.utf8 === 0 ? yield* decodeInSteps(bytes, encoding) : yield* decodeLines(bytes, encoding);
  return { text, encoding, ...(replaced > 0 ? { replacedCharacters: replaced } : {}) };
}

/** The file as UTF-8. `errors` comes from `scanLines`: the text may hold U+FFFD of its own. */
function* readAsUtf8(bytes: Uint8Array, errors: number): Generator<void, DecodedText> {
  const { text } = yield* decodeInSteps(bytes, "utf-8");
  return { text, ...(errors > 0 ? { replacedCharacters: errors } : {}) };
}

/**
 * The first of `ENCODINGS` that the lines which are not UTF-8 fit, or none. Lines of signs alone
 * (– ’ € °) are the same bytes in the single-byte encodings, and say nothing: the lines with
 * letters choose, wherever they are in the file, and the first lines only when no line has
 * letters. In Shift_JIS, kana and most kanji have no byte of 0xC0 or more, and every byte from
 * 0x81 on is part of a character: Shift_JIS is tried on the first lines. Checking an encoding
 * takes a few milliseconds, and more the first time, when its table of bytes is made: this pauses
 * before each.
 */
function* firstThatFits(lines: Lines): Generator<void, string | undefined> {
  const letters = lines.letters.length > 0 ? lines.letters : lines.sample;
  for (const { encoding, script } of ENCODINGS) {
    yield;
    if (!supported(encoding)) continue;
    if (script !== "Japanese") {
      kindsOf(encoding);
      yield;
    }
    if (fits(script === "Japanese" ? lines.sample : letters, encoding, script)) return encoding;
  }
  return undefined;
}

/** How the lines of a file read as UTF-8. */
type Lines = {
  /** Lines with characters of more than one byte, at least as many as those that are not valid. */
  utf8: number;
  /** Lines with more bytes that are not valid UTF-8 than characters that are. */
  other: number;
  /** Every line, ASCII lines too. */
  total: number;
  /** The characters that are not valid, counted as TextDecoder counts the U+FFFD it writes. */
  errors: number;
  /**
   * The first of the `other` lines, whole, one per line, up to `SAMPLE_BYTES`. Only a first line
   * longer than that is cut.
   */
  sample: Uint8Array;
  /**
   * The `other` lines with a byte of 0xC0 or more, from anywhere in the file, as `sample` holds
   * them. Such a byte is a letter in each single-byte encoding here, or a Hebrew point.
   */
  letters: Uint8Array;
  /** Halves of a surrogate pair (0xED, then 0xA0 to 0xBF), which UTF-8 does not allow. */
  halves: number;
};

/** Whole lines, one after another, up to `SAMPLE_BYTES`. */
function sampler(bytes: Uint8Array) {
  const lines: Uint8Array[] = [];
  let size = 0;
  let full = false;
  return {
    add(start: number, end: number) {
      if (full) return;
      const room = SAMPLE_BYTES - size;
      if (end - start <= room) {
        lines.push(bytes.subarray(start, end));
        size += end - start + 1;
      } else {
        // A line cut short could end in the middle of a Shift_JIS character: the sample ends
        // before it, unless it is the first.
        if (lines.length === 0) lines.push(bytes.subarray(start, start + room));
        full = true;
      }
    },
    joined: () => joinLines(lines),
  };
}

/**
 * Reads the bytes as the UTF-8 decoder of the Encoding Standard does (TextDecoder follows it), and
 * counts, line by line, the characters of more than one byte and the ones that are not valid.
 */
function* scanLines(bytes: Uint8Array): Generator<void, Lines> {
  let utf8 = 0;
  let other = 0;
  let total = 0;
  let errors = 0;
  let halves = 0;
  const sample = sampler(bytes);
  const letters = sampler(bytes);
  let lineStart = 0;
  let lineErrors = 0;
  let lineCharacters = 0;
  let lineLetters = false;
  // The bytes of a character cut in two by the start or the end of the file, as in a log cut at a
  // byte count or a part made by `split -b`. Such a character is UTF-8 as far as it goes: it
  // counts against its line only when other bytes of the line are not valid either.
  let lineCut = 0;
  const endLine = (end: number) => {
    total++;
    errors += lineErrors + lineCut;
    const invalid = lineErrors > 0 ? lineErrors + lineCut : 0;
    if (invalid === 0) {
      if (lineCharacters > 0) utf8++;
    } else if (lineCharacters >= invalid) {
      utf8++;
    } else {
      other++;
      sample.add(lineStart, end);
      if (lineLetters) letters.add(lineStart, end);
    }
    lineErrors = 0;
    lineCharacters = 0;
    lineCut = 0;
    lineLetters = false;
  };
  // One to three bytes that continue a character, at the start: the end of a character cut in two.
  let start = 0;
  while (start < 4 && start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  if (start === 4) start = 0;
  lineCut = start;
  // The bytes the character being read still needs, and the range the next one must be in.
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let from = 0; from < bytes.length; from += STEP_BYTES) {
    const to = Math.min(bytes.length, from + STEP_BYTES);
    for (let at = Math.max(from, start); at < to; at++) {
      const byte = bytes[at]!;
      if (needed === 0) {
        if (byte < 0x80) {
          if (byte === 0x0a) {
            endLine(at);
            lineStart = at + 1;
          }
          continue;
        }
        if (byte >= 0xc0) lineLetters = true;
        if (byte >= 0xc2 && byte <= 0xdf) {
          needed = 1;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) lower = 0xa0;
          else if (byte === 0xed) upper = 0x9f;
          needed = 2;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) lower = 0x90;
          else if (byte === 0xf4) upper = 0x8f;
          needed = 3;
        } else {
          lineErrors++;
        }
        continue;
      }
      if (byte < lower || byte > upper) {
        // After 0xED, 0xA0 to 0xBF begin half of a surrogate pair.
        if (upper === 0x9f && byte > upper && byte <= 0xbf) halves++;
        // The character ends before it is whole: that is one error, and this byte is read again.
        needed = 0;
        seen = 0;
        lower = 0x80;
        upper = 0xbf;
        lineErrors++;
        at--;
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      if (++seen === needed) {
        needed = 0;
        seen = 0;
        lineCharacters++;
      }
    }
    yield;
  }
  // A character cut off by the end of the file.
  if (needed !== 0) lineCut++;
  if (lineStart < bytes.length) endLine(bytes.length);
  return { utf8, other, total, errors, sample: sample.joined(), letters: letters.joined(), halves };
}

/** The lines, with a line feed between two. */
function joinLines(pieces: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(Math.max(0, pieces.reduce((sum, piece) => sum + piece.length + 1, 0) - 1));
  let at = 0;
  pieces.forEach((piece, index) => {
    if (index > 0) joined[at++] = 0x0a;
    joined.set(piece, at);
    at += piece.length;
  });
  return joined;
}

/**
 * Decodes the bytes a megabyte at a time. In an older encoding, a byte the encoding does not have
 * becomes U+FFFD (see `C1_CONTROLS`), and `replaced` counts the U+FFFD written: no older encoding
 * here has a character of its own for it. As UTF-8, `replaced` is 0: `scanLines` counts.
 */
function* decodeInSteps(bytes: Uint8Array, encoding: string): Generator<void, { text: string; replaced: number }> {
  const decoder = decoderFor(encoding);
  const pieces: string[] = [];
  let replaced = 0;
  const add = (decoded: string) => {
    if (encoding === "utf-8") {
      pieces.push(decoded);
      return;
    }
    const piece = decoded.replace(C1_CONTROLS, REPLACEMENT);
    pieces.push(piece);
    replaced += replacements(piece);
  };
  for (let from = 0; from < bytes.length; from += STEP_BYTES) {
    add(decoder.decode(bytes.subarray(from, from + STEP_BYTES), { stream: true }));
    yield;
  }
  add(decoder.decode());
  return { text: pieces.join(""), replaced };
}

/**
 * Decodes a file with lines in two encodings: a line that is valid UTF-8 as UTF-8, any other line
 * in the older `encoding`, as `decodeInSteps` does. `replaced` counts the U+FFFD written. A line
 * feed is never part of a character in UTF-8 or Shift_JIS, so each line can be decoded alone.
 * Lines in a row in the same encoding are decoded together, and an ASCII line goes with the line
 * before it: it is the same text in each encoding here (Shift_JIS swaps three control characters,
 * which ingest removes). A step ends after a megabyte, or after `RUNS_PER_STEP` such rows when the
 * two encodings take turns, and a longer line is decoded a megabyte at a time.
 */
function* decodeLines(bytes: Uint8Array, encoding: string): Generator<void, { text: string; replaced: number }> {
  // A byte-order mark further on is kept, as in a file decoded whole.
  const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
  const older = decoderFor(encoding);
  const chars = encoding === "shift_jis" ? undefined : charsOf(encoding);
  // The text of each step, and of the step being decoded.
  const pieces: string[] = [];
  let step: string[] = [];
  let replaced = 0;
  // The lines from `runStart` on are all valid UTF-8, or all not, apart from ASCII lines.
  let runStart = 0;
  let runUtf8 = true;
  let runs = 0;
  // Decodes the lines from `runStart` to `end`, a megabyte at most: false when more is left.
  const endRun = (end: number): boolean => {
    if (end === runStart) return true;
    if (!runUtf8 && chars && end - runStart <= SHORT_RUN) {
      let piece = "";
      for (let at = runStart; at < end; at++) {
        const char = chars[bytes[at]!]!;
        if (char === REPLACEMENT) replaced++;
        piece += char;
      }
      step.push(piece);
    } else {
      const to = Math.min(end, runStart + STEP_BYTES);
      const options = { stream: to < end };
      if (runUtf8) {
        step.push(utf8.decode(bytes.subarray(runStart, to), options));
      } else {
        const piece = older.decode(bytes.subarray(runStart, to), options).replace(C1_CONTROLS, REPLACEMENT);
        step.push(piece);
        replaced += replacements(piece);
      }
      if (to < end) {
        runStart = to;
        return false;
      }
    }
    runStart = end;
    runs++;
    return true;
  };
  let stepEnd = STEP_BYTES;
  for (let start = 0; start < bytes.length;) {
    const feed = bytes.indexOf(0x0a, start);
    const end = feed === -1 ? bytes.length : feed + 1;
    const kind = lineKind(bytes, start, end);
    if (kind !== "ascii" && (kind === "utf8") !== runUtf8) {
      while (!endRun(start)) yield;
      runUtf8 = kind === "utf8";
    }
    start = end;
    if (start >= stepEnd || runs >= RUNS_PER_STEP) {
      while (!endRun(start)) yield;
      pieces.push(step.join(""));
      step = [];
      runs = 0;
      stepEnd = start + STEP_BYTES;
      yield;
    }
  }
  while (!endRun(bytes.length)) yield;
  pieces.push(step.join(""));
  return { text: pieces.join(""), replaced };
}

/** Whether the line from `start` to `end` is ASCII, valid UTF-8 with characters of more than one byte, or not valid UTF-8. */
function lineKind(bytes: Uint8Array, start: number, end: number): "ascii" | "utf8" | "other" {
  if (end - start > SHORT_LINE) {
    const line = bytes.subarray(start, end);
    return isAscii(line) ? "ascii" : isUtf8(line) ? "utf8" : "other";
  }
  let kind: "ascii" | "utf8" = "ascii";
  for (let at = start; at < end; at++) {
    const byte = bytes[at]!;
    if (byte < 0x80) continue;
    kind = "utf8";
    // The bytes the character still needs, and the range the next one must be in, as in `scanLines`.
    let needed: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (byte >= 0xc2 && byte <= 0xdf) {
      needed = 1;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      if (byte === 0xe0) lower = 0xa0;
      else if (byte === 0xed) upper = 0x9f;
      needed = 2;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      if (byte === 0xf0) lower = 0x90;
      else if (byte === 0xf4) upper = 0x8f;
      needed = 3;
    } else {
      return "other";
    }
    if (at + needed >= end) return "other";
    for (; needed > 0; needed--) {
      const next = bytes[++at]!;
      if (next < lower || next > upper) return "other";
      lower = 0x80;
      upper = 0xbf;
    }
  }
  return kind;
}

const charTables = new Map<string, string[]>();

/** The character each byte is in a single-byte encoding, as `decodeInSteps` reads it: U+FFFD for a byte the encoding does not have. */
function charsOf(encoding: string): string[] {
  let chars = charTables.get(encoding);
  if (!chars) {
    const decoder = decoderFor(encoding);
    chars = Array.from({ length: 256 }, (_, byte) => decoder.decode(Uint8Array.of(byte)).replace(C1_CONTROLS, REPLACEMENT));
    charTables.set(encoding, chars);
  }
  return chars;
}

/** The U+FFFD in a text. */
function replacements(text: string): number {
  let count = 0;
  for (let at = text.indexOf(REPLACEMENT); at !== -1; at = text.indexOf(REPLACEMENT, at + 1)) count++;
  return count;
}

/**
 * The text of a file in CESU-8, as an Oracle database in its character set UTF8, or Java, writes
 * it: a character past U+FFFF, such as an emoji, is two halves of a surrogate pair of three bytes
 * each. Each pair is written as the four bytes of UTF-8. Undefined when the bytes are still not
 * valid UTF-8 then.
 */
function* joinSurrogates(bytes: Uint8Array): Generator<void, string | undefined> {
  const joined = new Uint8Array(bytes.length);
  let length = 0;
  let copied = 0;
  for (let from = 0; from < bytes.length; from += STEP_BYTES) {
    const to = Math.min(bytes.length, from + STEP_BYTES);
    for (let at = bytes.indexOf(0xed, Math.max(from, copied)); at !== -1 && at < to; at = bytes.indexOf(0xed, at + 1)) {
      const high = surrogateAt(bytes, at);
      const low = surrogateAt(bytes, at + 3);
      if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff) continue;
      const code = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
      joined.set(bytes.subarray(copied, at), length);
      length += at - copied;
      joined[length++] = 0xf0 | (code >> 18);
      joined[length++] = 0x80 | ((code >> 12) & 0x3f);
      joined[length++] = 0x80 | ((code >> 6) & 0x3f);
      joined[length++] = 0x80 | (code & 0x3f);
      copied = at + 6;
      at = copied - 1;
    }
    yield;
  }
  joined.set(bytes.subarray(copied), length);
  length += bytes.length - copied;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined.subarray(0, length));
  } catch {
    return undefined;
  }
}

/** The surrogate that the three bytes at `at` would be in UTF-8 (0xED, then two that continue a character), or -1. */
function surrogateAt(bytes: Uint8Array, at: number): number {
  const second = bytes[at + 1];
  const third = bytes[at + 2];
  if (bytes[at] !== 0xed || second === undefined || third === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) return -1;
  return 0xd000 | ((second & 0x3f) << 6) | (third & 0x3f);
}

/** The encodings the sample fits, the one to read the file in first. */
export function encodingsThatFit(sample: Uint8Array): string[] {
  return ENCODINGS.filter(({ encoding, script }) => supported(encoding) && fits(sample, encoding, script)).map(({ encoding }) => encoding);
}

/** Whether the sample looks like text of the script, read in the encoding. */
function fits(sample: Uint8Array, encoding: string, script: Script): boolean {
  return script === "Japanese" ? fitsJapanese(sample) : fitsSingleByte(sample, kindsOf(encoding), script);
}

/**
 * A decoder for an older encoding. Some versions of Node read windows-1252 (and its other Latin-1
 * labels) as Latin-1 in a decode call that is not streamed, so 0x80-0x9F come out as control
 * characters ("’" as U+0092), until the decoder has been called once streamed: that call is made
 * here. Not only Node 20 (20.18.3 and later): Node 22.13.0 brought the same bug
 * (nodejs/node#60888), which 22.23.5 no longer has. Keep the call while such a 22.x is supported.
 */
function decoderFor(encoding: string, options?: ConstructorParameters<typeof TextDecoder>[1]): InstanceType<typeof TextDecoder> {
  const decoder = new TextDecoder(encoding, options);
  decoder.decode(new Uint8Array(0), { stream: true });
  return decoder;
}

/** Whether this runtime's TextDecoder has the encoding: a Node.js built without full ICU has only UTF-8, UTF-16 and Latin-1. */
function supported(encoding: string): boolean {
  try {
    new TextDecoder(encoding);
    return true;
  } catch {
    return false;
  }
}

/** What a character is, for telling whether a text is read in the right encoding. */
type CharKind = {
  kind: "missing" | "control" | "letter" | "mark" | "joiner" | "separator" | "symbol";
  script?: string;
  upper?: boolean;
  lower?: boolean;
  /** A Hebrew final form (ך ם ן ף ץ), or Arabic ة: it ends a word. */
  final?: boolean;
  /** A letter the languages written in windows-1252 seldom use (see `RARE_LATIN`). */
  rare?: boolean;
  /** Š or Ž, which begin names such as Škoda: before letters of ASCII only, they are not rare. */
  initial?: boolean;
  /** A Cyrillic vowel. */
  vowel?: boolean;
  /** Ь or Ы, which begin no word. */
  neverFirst?: boolean;
  /** Й, which follows a vowel when it does not begin its word. */
  afterVowel?: boolean;
  /** An Arabic letter that every Arabic text is full of (see `FREQUENT_ARABIC`). */
  frequent?: boolean;
};

/**
 * Letters that the languages written in windows-1252 seldom use, but that text in another encoding
 * read as windows-1252 is full of: Turkish ı ş ğ come out as ý þ ð, and Czech, Slovak and Croatian
 * text, written in windows-1250, has š and ž among letters that come out wrong (ř as ø, č as è).
 */
const RARE_LATIN = "ÐðÞþÝýŠšŽžƒ";
const INITIAL_LATIN = "ŠŽ";
/** Signs that Unicode files as letters: ª º µ ˆ. Between letters they are as odd as other signs. */
const SIGNS = "ªºµˆ";
/** Signs that stand between letters in words: apostrophes, the Catalan middle dot, the Hebrew geresh, gershayim and maqaf. */
const IN_WORD = "’‘·׳״־";
/** Letters that end a word: the Hebrew final forms, and Arabic ة, which KOI8-R и and Greek Ι come out as. */
const FINAL_FORMS = "ךםןףץة";
/**
 * Cyrillic vowels, Ukrainian ones too, and Ъ, which is a vowel in Bulgarian. A Russian, Ukrainian,
 * Bulgarian or Serbian word of five letters or more has one. Lower-case KOI8-R, or Greek capitals,
 * read as windows-1251 give words without: "оплата" comes out as "ПРМБФБ".
 */
const CYRILLIC_VOWELS = "АЕЁИОУЫЭЮЯЄІЇЪаеёиоуыэюяєіїъ";
/** No word begins with these (Bulgarian "ъгъл" begins with Ъ). KOI8-R "это" comes out as "ЬФП". */
const NEVER_FIRST = "ЬЫьы";
/** Й follows a vowel. KOI8-R and Greek и and ι come out as Й, after any letter. */
const AFTER_VOWEL = "Йй";
/**
 * ل م ن ه و ى ي: in Arabic text, about two letters in five. Text in Cyrillic or Greek capitals,
 * lower-case KOI8-R, or half-width katakana, read as windows-1256, gives other Arabic letters only.
 */
const FREQUENT_ARABIC = "لمنهوىي";

const SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Arabic", /\p{Script=Arabic}/u],
];

function kindOf(char: string | undefined): CharKind {
  if (char === undefined) return { kind: "missing" };
  const code = char.charCodeAt(0);
  if (code >= 0x80 && code <= 0x9f) return { kind: "control" };
  if (SIGNS.includes(char)) return { kind: "symbol" };
  if (/\p{L}/u.test(char)) {
    return {
      kind: "letter",
      script: SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0] ?? "other",
      upper: /\p{Lu}/u.test(char),
      // ß has no capital in these encodings: "STRAßE" is written in capitals.
      lower: /\p{Ll}/u.test(char) && char !== "ß",
      final: FINAL_FORMS.includes(char),
      rare: RARE_LATIN.includes(char),
      initial: INITIAL_LATIN.includes(char),
      vowel: CYRILLIC_VOWELS.includes(char),
      neverFirst: NEVER_FIRST.includes(char),
      afterVowel: AFTER_VOWEL.includes(char),
      frequent: FREQUENT_ARABIC.includes(char),
    };
  }
  if (/\p{M}/u.test(char)) return { kind: "mark" };
  if (/\p{Cf}/u.test(char)) return { kind: "joiner" };
  if (IN_WORD.includes(char) || /\p{Zs}/u.test(char)) return { kind: "separator" };
  return { kind: "symbol" };
}

/** ASCII: letters, and everything else between words. */
const ASCII_KINDS: CharKind[] = Array.from({ length: 0x80 }, (_, code) => {
  if (code >= 0x41 && code <= 0x5a) return { kind: "letter", script: "Latin", upper: true };
  if (code >= 0x61 && code <= 0x7a) return { kind: "letter", script: "Latin", lower: true };
  return { kind: "separator" };
});

const byteKinds = new Map<string, CharKind[]>();

/** The kind of character each byte is in a single-byte encoding, ASCII included. */
function kindsOf(encoding: string): CharKind[] {
  let kinds = byteKinds.get(encoding);
  if (!kinds) {
    const decoder = decoderFor(encoding, { fatal: true });
    kinds = [...ASCII_KINDS];
    for (let byte = 0x80; byte <= 0xff; byte++) {
      let char: string | undefined;
      try {
        char = decoder.decode(Uint8Array.of(byte));
      } catch {
        char = undefined;
      }
      kinds.push(kindOf(char));
    }
    byteKinds.set(encoding, kinds);
  }
  return kinds;
}

/**
 * Whether the sample, read in a single-byte encoding, looks like text of its script. A word with
 * letters other than ASCII must hold letters of one script, in a case that words have ("word",
 * "Word", "WORD"), and a sign must not stand between two letters. In the Latin script, most
 * letters of a word are ASCII, and seldom-used letters (`RARE_LATIN`) are wrong. Hebrew points
 * follow a letter, and a final form ends its word, as Arabic ة does. A Cyrillic word has a vowel
 * when it is long, begins with neither Ь nor Ы, and has Й only after a vowel. Arabic text may hold
 * French words, and is full of the letters in `FREQUENT_ARABIC`. At most one word or sign in
 * `WRONG_ONE_IN` may look wrong, a byte the encoding does not have counts as a wrong sign, and a
 * script other than Latin needs a word of two letters or more.
 */
function fitsSingleByte(sample: Uint8Array, kinds: CharKind[], script: Script): boolean {
  let counted = 0;
  let wrong = 0;
  let words = 0;
  // Letters of the script, and how many of them are frequent ones.
  let scriptLetters = 0;
  let frequent = 0;
  // The word being read.
  let letters = 0;
  let ascii = 0;
  let others = 0;
  let vowels = 0;
  let scripts = new Set<string>();
  let odd = false;
  let firstUpper = false;
  let upperAfterFirst = false;
  let uppers = 0;
  let lowers = 0;
  let afterFinal = false;
  let afterVowel = false;
  let rareFirst = false;
  // A sign right after a letter: it is odd when a letter follows it.
  let previousLetter = false;
  let signAfterLetter = false;

  const caseOk = () => uppers === 0 || lowers === 0 || (firstUpper && !upperAfterFirst);
  const latinOk = () => caseOk() && !(others >= 3 && others > ascii);
  const endWord = () => {
    if (others > 0) {
      counted++;
      if (rareFirst && others > 1) odd = true;
      if (script === "Cyrillic" && letters >= 5 && vowels === 0) odd = true;
      const only = (name: string) => scripts.size === 1 && scripts.has(name);
      let right = false;
      if (!odd) {
        if (script === "Latin") right = only("Latin") && latinOk();
        else if (only(script) && ascii === 0 && (script !== "Cyrillic" || caseOk())) right = true;
        else if (script === "Arabic" && only("Latin")) right = latinOk();
      }
      if (!right) wrong++;
      else if (script === "Latin" || (only(script) && letters >= 2)) words++;
    }
    letters = ascii = others = vowels = uppers = lowers = 0;
    scripts = new Set();
    odd = firstUpper = upperAfterFirst = afterFinal = afterVowel = rareFirst = false;
  };

  for (const byte of sample) {
    const kind = kinds[byte]!;
    switch (kind.kind) {
      case "letter":
        if (signAfterLetter) wrong++;
        signAfterLetter = false;
        previousLetter = true;
        letters++;
        if (byte < 0x80) ascii++;
        else others++;
        scripts.add(kind.script!);
        if (kind.script === script) {
          scriptLetters++;
          if (kind.frequent) frequent++;
        }
        if (kind.rare) {
          if (letters === 1 && kind.initial) rareFirst = true;
          else odd = true;
        }
        if (afterFinal) odd = true;
        afterFinal = !!kind.final;
        if (letters === 1 ? kind.neverFirst : kind.afterVowel && !afterVowel) odd = true;
        afterVowel = !!kind.vowel;
        if (kind.vowel) vowels++;
        if (kind.upper) {
          uppers++;
          if (letters === 1) firstUpper = true;
          else upperAfterFirst = true;
        }
        if (kind.lower) lowers++;
        break;
      case "mark":
        // A point or vowel sign belongs to the letter before it.
        if (letters === 0) odd = true;
        others++;
        break;
      case "joiner":
        break;
      case "missing":
      case "control":
        counted++;
        wrong++;
        endWord();
        previousLetter = signAfterLetter = false;
        break;
      case "symbol":
        counted++;
        endWord();
        signAfterLetter = previousLetter;
        previousLetter = false;
        break;
      case "separator":
        // An apostrophe or a no-break space that is not ASCII is right: it may be all a text holds
        // that is not ASCII.
        if (byte >= 0x80) counted++;
        endWord();
        previousLetter = signAfterLetter = false;
        break;
    }
  }
  endWord();
  return counted > 0 && wrong * WRONG_ONE_IN <= counted && (script === "Latin" || words > 0)
    && (script !== "Arabic" || frequent * 10 >= scriptLetters);
}

/**
 * Whether the sample reads as Japanese in Shift_JIS: every character a byte pair gives is one that
 * Japanese text uses, at least one in ten is hiragana or katakana, and at most one in four
 * characters of two bytes is a seldom-used kanji (JIS level 2 and after, first byte 0xE0 to 0xEF).
 * Chinese, Korean or Thai text read as Shift_JIS gives characters from the user-defined area,
 * half-width katakana and seldom-used kanji, but almost no hiragana.
 *
 * Half-width katakana, as Japanese bank files hold them, count as kana when they are written as
 * words are: two or more in a row, ﾞ and ﾟ after a kana they voice, small kana and ｰ after a kana,
 * and from both ends of their table, ｦ to ｿ and ﾐ to ﾟ. A sign such as µ or · in windows-1252 is
 * one half-width katakana alone. Cyrillic or Greek letters fill a block of 32 bytes, which gives
 * half-width katakana from one end only: ﾀ to ﾟ from windows-1251 capitals or lower-case KOI8-R,
 * ｰ to ﾏ from ISO-8859-5 capitals.
 */
function fitsJapanese(sample: Uint8Array): boolean {
  let text: string;
  try {
    // With `stream`, a character cut in two at the end of the sample is left out, not taken for a wrong one.
    text = new TextDecoder("shift_jis", { fatal: true }).decode(sample, { stream: true });
  } catch {
    return false;
  }
  let pairs = 0;
  let seldom = 0;
  for (let at = 0; at < sample.length; at++) {
    const byte = sample[at]!;
    if ((byte >= 0x81 && byte <= 0x9f) || byte >= 0xe0) {
      pairs++;
      if (byte >= 0xe0 && byte <= 0xef) seldom++;
      at++;
    }
  }
  let counted = 0;
  let kana = 0;
  let halfWidth = 0;
  let firstRows = 0;
  let lastRows = 0;
  let wrong = 0;
  let previous = 0;
  // The half-width katakana in a row, and how many of them are ｦ to ｿ, and ﾐ to ﾟ.
  let run = 0;
  let runFirst = 0;
  let runLast = 0;
  const endRun = () => {
    if (run >= 2) {
      halfWidth += run;
      firstRows += runFirst;
      lastRows += runLast;
    }
    run = runFirst = runLast = 0;
  };
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xff66 && code <= 0xff9f) {
      counted++;
      run++;
      if (code <= 0xff7f) runFirst++;
      else if (code >= 0xff90) runLast++;
      if (!halfWidthFollows(code, previous)) wrong++;
    } else {
      endRun();
      if (code >= 0x80) {
        counted++;
        if (code >= 0x3041 && code <= 0x30ff) kana++;
        // Control characters, and the user-defined area that the bytes 0xF0 to 0xF9 lead to.
        else if (code <= 0x9f || (code >= 0xe000 && code <= 0xf8ff)) wrong++;
      }
    }
    previous = code;
  }
  endRun();
  if (firstRows * 10 >= halfWidth && lastRows * 10 >= halfWidth) kana += halfWidth;
  return counted > 0 && wrong * WRONG_ONE_IN <= counted && kana >= 2 && kana * 10 >= counted && seldom * 4 <= pairs;
}

/** Whether a half-width katakana may follow the character before it. */
function halfWidthFollows(code: number, previous: number): boolean {
  const kana = previous >= 0xff66 && previous <= 0xff9f;
  // ﾞ voices ｳ, ｶ to ﾄ, and ﾊ to ﾎ; ﾟ, ﾊ to ﾎ.
  if (code === 0xff9e) return previous === 0xff73 || (previous >= 0xff76 && previous <= 0xff84) || (previous >= 0xff8a && previous <= 0xff8e);
  if (code === 0xff9f) return previous >= 0xff8a && previous <= 0xff8e;
  // Small ｧ to ｯ, and ｰ.
  if (code >= 0xff67 && code <= 0xff70) return kana;
  return true;
}
