import { createContext, Script, type Context } from "node:vm";
import { PASSAGE_CHARACTERS, PASSAGE_MAX_LINES, positionOf } from "./text-index.js";
import { foldCase, LineIndex } from "./text.js";
import type { DocumentMeta, StoredDocument } from "./types.js";

const MAX_OCCURRENCES_PER_TERM = 200_000;
const MAX_EXACT_MATCHES = 1_000_000;
const MAX_PHRASE_PASSAGES = 10_000;
/** The most time one regex search may spend matching. */
export const REGEX_TIME_LIMIT_MS = 3_000;
/**
 * A regex scan runs in slices of this length, and other work gets a turn between two slices. A
 * line that takes two whole slices is a pattern that backtracks without end on it: the search
 * stops there, long before its time limit.
 */
const REGEX_SLICE_MS = 250;
const SHOWN_LINE_CHARACTERS = 400;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "that", "this", "what", "how", "why", "when", "where", "who",
  "from", "into", "about", "does", "did", "have", "has", "had", "you", "your", "can", "all", "any", "not",
  "של", "את", "על", "עם", "מה", "איך", "למה", "מתי", "איפה", "מי", "זה", "זאת", "גם", "או", "אם", "כל", "יש", "אין",
]);

/**
 * A piece of a document's text: whole lines, in order. A document read by range is scanned in
 * pieces that start at passage starts; a document held in memory is one piece.
 */
export type TextChunk = {
  /** The document line of the piece's first line. */
  firstLine: number;
  /** Where the piece starts in the whole text, in UTF-16 units. */
  startCharacter: number;
  text: string;
  lines: LineIndex;
  /** `text` lowercased with `foldCase`: the same length, so offsets match. */
  lower(): string;
};

/** A document the tools can read and search: held whole in memory, or read by range from the store. */
export interface DocumentSource {
  readonly meta: DocumentMeta;
  readonly lineCount: number;
  /** The length of the whole text, in UTF-16 units. */
  readonly characters: number;
  /** The first line of each passage (keyword search). */
  readonly passageStarts: ArrayLike<number>;
  /** Memory this object holds, for the cache. */
  readonly memoryBytes: number;
  /** Set when the stored text turned out not to match what this object knows of it: open it again. */
  readonly broken?: boolean;
  pageOfLine(line: number): number | undefined;
  pagesOfLines(from: number, to: number): string | undefined;
  /** Lines `from` to `to`, clamped to the document. */
  readLines(from: number, to: number): Promise<string[]>;
  readText(): Promise<string>;
  /** The whole text in pieces of whole lines, in order. */
  chunks(signal?: AbortSignal): AsyncIterable<TextChunk>;
  /**
   * Optional: feeds the pieces in order to `feed` until it returns true, sharing one pass over the
   * text with other scans of the same document where it can.
   */
  scan?(feed: ScanFeed, signal?: AbortSignal): Promise<void>;
}

/**
 * What a scan does with a piece of the text. True: it has all it needs, so nothing more is read.
 * "again": it stopped part-way through the piece to let other work run, and wants the same piece
 * once more.
 */
export type ScanFeed = (chunk: TextChunk) => boolean | void | "again";

/** Lets other work on the server run (an answer streaming to another user) before going on. */
export const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Feeds a document's text, a piece at a time, to `feed` until it returns true or the text ends. */
export async function scanSource(source: DocumentSource, feed: ScanFeed, signal?: AbortSignal): Promise<void> {
  if (source.scan) return source.scan(feed, signal);
  for await (const chunk of source.chunks(signal)) {
    let more = feed(chunk);
    while (more === "again") {
      await pause();
      signal?.throwIfAborted();
      more = feed(chunk);
    }
    if (more === true) break;
  }
}

/** Lines as the tools show them: "12| text", one a line. */
export function numberLines(lines: readonly string[], from: number): string {
  return lines.map((text, index) => `${from + index}| ${text}`).join("\n");
}

/** The pages a range of lines is on, as "12" or "12-14", from the first line of each page. */
export function pagesOfLines(pageStarts: ArrayLike<number>, from: number, to: number): string | undefined {
  const page = (line: number) => (pageStarts.length === 0 || line < pageStarts[0]! ? undefined : positionOf(pageStarts, line));
  const last = page(to);
  if (last === undefined) return undefined;
  const first = page(from) ?? 1;
  return first === last ? String(last) : `${first}-${last}`;
}

/** A stored document held whole in memory, with lazily built search structures. */
export class SearchableDocument implements DocumentSource {
  readonly meta: DocumentMeta;
  readonly text: string;
  readonly lines: LineIndex;
  private lowerText?: string;
  private passageStartList?: number[];
  private pageStarts?: number[];

  constructor(document: StoredDocument) {
    this.meta = document.meta;
    this.text = document.text;
    this.lines = new LineIndex(document.text);
  }

  get lineCount(): number {
    return this.lines.lineCount;
  }

  get characters(): number {
    return this.text.length;
  }

  /**
   * Memory this document takes once it has been searched: the text, its lowercased copy, and the
   * line index. A text of ASCII only is held at one byte a character, any other at two.
   */
  get memoryBytes(): number {
    const ascii = this.meta.textBytes !== undefined && this.meta.textBytes === this.text.length;
    return this.text.length * (ascii ? 1 : 2) * 2 + this.lines.lineCount * 4 + 1_024;
  }

  /** The text lowercased for case-insensitive search. Same length as `text`, so offsets match. */
  get lower(): string {
    this.lowerText ??= foldCase(this.text);
    return this.lowerText;
  }

  /** First line of each passage: groups of lines up to about 1,500 characters. */
  get passages(): number[] {
    if (!this.passageStartList) {
      const starts: number[] = [];
      let line = 1;
      while (line <= this.lines.lineCount) {
        starts.push(line);
        let characters = 0;
        let count = 0;
        while (line <= this.lines.lineCount && count < PASSAGE_MAX_LINES && characters < PASSAGE_CHARACTERS) {
          characters += this.lines.endOf(line) - this.lines.startOf(line) + 1;
          count++;
          line++;
        }
      }
      this.passageStartList = starts;
    }
    return this.passageStartList;
  }

  get passageStarts(): ArrayLike<number> {
    return this.passages;
  }

  passageRange(index: number): { from: number; to: number } {
    const starts = this.passages;
    return { from: starts[index]!, to: (starts[index + 1] ?? this.lines.lineCount + 1) - 1 };
  }

  passageOfLine(line: number): number {
    return positionOf(this.passages, line) - 1;
  }

  /**
   * The page a line is on, from the "--- Page N ---" lines the PDF extractor writes. Undefined for
   * a text without them, and for lines above the first one. Only markers that count up from 1 are
   * used, so a line of the document that happens to read "--- Page 7 ---" is not taken for one.
   */
  pageOfLine(line: number): number | undefined {
    const starts = this.pageLines();
    return starts.length === 0 || line < starts[0]! ? undefined : positionOf(starts, line);
  }

  /** The pages a range of lines is on, as "12" or "12-14". Undefined for a text without page lines. */
  pagesOfLines(from: number, to: number): string | undefined {
    return pagesOfLines(this.pageLines(), from, to);
  }

  async readLines(from: number, to: number): Promise<string[]> {
    const out: string[] = [];
    for (let line = Math.max(1, from); line <= Math.min(to, this.lines.lineCount); line++) out.push(this.lines.line(line));
    return out;
  }

  async readText(): Promise<string> {
    return this.text;
  }

  /** The whole text as one piece. */
  wholeChunk(): TextChunk {
    return { firstLine: 1, startCharacter: 0, text: this.text, lines: this.lines, lower: () => this.lower };
  }

  async *chunks(): AsyncGenerator<TextChunk> {
    yield this.wholeChunk();
  }

  private pageLines(): number[] {
    if (!this.pageStarts) {
      const starts: number[] = [];
      const marker = "--- Page ";
      for (let at = this.text.indexOf(marker); at !== -1; at = this.text.indexOf(marker, at + marker.length)) {
        if (at > 0 && this.text[at - 1] !== "\n") continue;
        const found = this.lines.lineAt(at);
        if (this.lines.line(found) === `--- Page ${starts.length + 1} ---`) starts.push(found);
      }
      this.pageStarts = starts;
    }
    return this.pageStarts;
  }
}

export type LineMatch = { line: number; text: string; before?: string[]; after?: string[] };

export type GrepResult = {
  totalMatchingLines: number;
  /** True when the scan stopped early (too many matches or the regex time limit). */
  stoppedEarly: boolean;
  matches: LineMatch[];
};

export type GrepOptions = {
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults: number;
  contextLines: number;
  /** Regex mode only. Defaults to 3 seconds of scanning. */
  timeLimitMs?: number;
  /** Regex mode only: the time spent matching is added to `usedMs`, for a caller that keeps a budget over several searches. */
  regexClock?: { usedMs: number };
};

function clip(line: string, column: number): string {
  if (line.length <= SHOWN_LINE_CHARACTERS) return line;
  const start = Math.max(0, Math.min(column - SHOWN_LINE_CHARACTERS / 2, line.length - SHOWN_LINE_CHARACTERS));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + SHOWN_LINE_CHARACTERS)}${start + SHOWN_LINE_CHARACTERS < line.length ? "…" : ""}`;
}

const RUN_SCAN = new Script("scan()");
let scanSandbox: { scan: () => void } | undefined;
let scanContext: Context | undefined;

/**
 * Runs `scan` and stops it after `milliseconds`, returning false if it was stopped.
 *
 * A check between lines cannot interrupt one regex match, and a pattern such as `(a|a)+$` can
 * take longer than the age of the universe on a single 40-character line. Node's `vm` timeout
 * can: V8 checks for it while a regex backtracks, even in a function called from the script.
 */
function withinTimeLimit(scan: () => void, milliseconds: number): boolean {
  scanSandbox ??= { scan };
  scanContext ??= createContext(scanSandbox);
  scanSandbox.scan = scan;
  try {
    RUN_SCAN.runInContext(scanContext, { timeout: Math.max(1, Math.ceil(milliseconds)) });
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return false;
    throw error;
  } finally {
    scanSandbox.scan = () => undefined;
  }
}

/**
 * A quick refusal for the most common catastrophic shape, a nested quantifier such as (a+)+.
 * It does not catch every slow pattern; the time limit in `grep` is what bounds the search.
 */
export function unsafeRegexReason(pattern: string): string | null {
  if (pattern.length > 300) return "Regex is longer than 300 characters.";
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) {
    return "Regex has a nested quantifier like (a+)+, which can hang on large files. Simplify it.";
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    return `Invalid regex: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/**
 * The pattern as a regular expression. With the Unicode flag when the pattern allows it, so that
 * `\p{L}` means a letter and a character outside the basic plane is one character; without it for
 * a pattern that is only valid the old way (`[\w-.]`, `\-`).
 */
function compileRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, `${flags}u`);
  } catch {
    return new RegExp(pattern, flags);
  }
}

const newlinesIn = (text: string) => text.split("\n").length - 1;

/**
 * The text of the `keep` lines before a piece, with their line breaks, and the number of its
 * first line: what a needle across lines may start in.
 */
function carried(recent: ReadonlyArray<readonly [number, string]>, keep: number): { text: string; firstLine: number } | undefined {
  const lines = recent.slice(-keep);
  if (lines.length === 0) return undefined;
  return { text: lines.map(([, text]) => `${text}\n`).join(""), firstLine: lines[0]![0] };
}

/** The lines read last, for lines shown before a hit and for needles across lines. */
function remember(recent: Array<readonly [number, string]>, chunk: TextChunk, keep: number): Array<readonly [number, string]> {
  if (keep === 0) return recent;
  const count = chunk.lines.lineCount;
  const fresh: Array<readonly [number, string]> = [];
  for (let local = Math.max(1, count - keep + 1); local <= count; local++) fresh.push([chunk.firstLine + local - 1, chunk.lines.line(local)]);
  return [...recent, ...fresh].slice(-keep);
}

/**
 * Lines that contain `query` (exact text) or match it (regex), counted over a whole document fed
 * a piece at a time. The pieces must come in order. Given the whole text as one piece, it does
 * what `grep` always did; given it in pieces, it finds the same lines.
 */
class LineSearch {
  private readonly hits: Array<{ line: number; column: number; text: string }> = [];
  private total = 0;
  stoppedEarly = false;
  /** True once nothing more is to be found or counted: the rest of the text need not be read. */
  done = false;
  private readonly context: number;
  /** Lines shown around the hits, by number: undefined until their piece has been read. */
  private readonly shown = new Map<number, string | undefined>();
  private unfilled = 0;
  private recent: Array<readonly [number, string]> = [];
  private readonly keep: number;
  private readonly needle: string = "";
  private readonly newlines: number = 0;
  /** Exact mode: where the next match may start in the whole text, as the scan of one string skips past each match. */
  private nextAllowed = 0;
  private lastLine = 0;
  private readonly pattern?: RegExp;
  private timeLeft: number;
  /** Regex mode: the piece whose scan stopped at the end of a time slice, and the next line of it to look at. */
  private unfinished?: { chunk: TextChunk; next: number };
  /** Regex mode: the line that took a whole slice without being finished. A second such slice ends the search. */
  private stuck?: number;

  constructor(query: string, private readonly settings: GrepOptions, private readonly lineCount: number) {
    if (!query) throw new Error("The search query is empty.");
    if (settings.regex) {
      const problem = unsafeRegexReason(query);
      if (problem) throw new Error(problem);
      this.pattern = compileRegex(query, settings.caseSensitive ? "" : "i");
    } else {
      this.needle = settings.caseSensitive ? query : foldCase(query);
      this.newlines = newlinesIn(this.needle);
    }
    this.timeLeft = settings.timeLimitMs ?? REGEX_TIME_LIMIT_MS;
    this.context = Math.max(0, Math.min(5, settings.contextLines));
    this.keep = this.context + this.newlines;
  }

  /** Scans a piece to its end, without a pause: for a caller that cannot wait. See `addSome`. */
  add(chunk: TextChunk): void {
    while (!this.addSome(chunk)) {
      // The next slice of a regex scan.
    }
  }

  /**
   * Scans a piece, or goes on scanning it. False means that a regex scan reached the end of a time
   * slice with lines of this piece still to look at: let other work run, then call this again with
   * the same piece. Exact search always finishes the piece.
   */
  addSome(chunk: TextChunk): boolean {
    if (this.done) return true;
    if (this.pattern) {
      if (!this.scanRegex(chunk)) return false;
    } else {
      this.scanExact(chunk);
    }
    if (this.unfilled > 0) {
      const last = chunk.firstLine + chunk.lines.lineCount - 1;
      for (const [line, text] of this.shown) {
        if (text !== undefined) continue;
        const found = line >= chunk.firstLine && line <= last
          ? chunk.lines.line(line - chunk.firstLine + 1)
          : this.recent.find(([number]) => number === line)?.[1];
        if (found !== undefined) this.fill(line, found);
      }
    }
    this.recent = remember(this.recent, chunk, this.keep);
    return true;
  }

  /** Lines to show that were not in the pieces read (the scan stopped early). Read them and `fill` them. */
  missing(): number[] {
    if (this.unfilled === 0) return [];
    return [...this.shown].filter(([, text]) => text === undefined).map(([line]) => line).sort((left, right) => left - right);
  }

  fill(line: number, text: string): void {
    if (this.shown.get(line) !== undefined || !this.shown.has(line)) return;
    this.shown.set(line, text);
    this.unfilled--;
  }

  result(): GrepResult {
    const lineText = (line: number) => this.shown.get(line) ?? "";
    const matches = this.hits.map(({ line, column, text }): LineMatch => {
      const match: LineMatch = { line, text: clip(text, column) };
      if (this.context > 0) {
        match.before = [];
        match.after = [];
        for (let other = Math.max(1, line - this.context); other < line; other++) match.before.push(`${other}| ${clip(lineText(other), 0)}`);
        for (let other = line + 1; other <= Math.min(this.lineCount, line + this.context); other++) match.after.push(`${other}| ${clip(lineText(other), 0)}`);
      }
      return match;
    });
    return { totalMatchingLines: this.total, stoppedEarly: this.stoppedEarly, matches };
  }

  private record(line: number, column: number, text: string): void {
    this.total++;
    if (this.hits.length >= this.settings.maxResults) return;
    this.hits.push({ line, column, text });
    for (let other = Math.max(1, line - this.context); other <= Math.min(this.lineCount, line + this.context); other++) {
      if (other !== line && !this.shown.has(other)) {
        this.shown.set(other, undefined);
        this.unfilled++;
      }
    }
  }

  private scanExact(chunk: TextChunk): void {
    const { needle } = this;
    const caseSensitive = this.settings.caseSensitive === true;
    let text = caseSensitive ? chunk.text : chunk.lower();
    let lines = chunk.lines;
    let firstLine = chunk.firstLine;
    let start = chunk.startCharacter;
    // A needle across lines can start in the lines before this piece.
    const before = this.newlines > 0 ? carried(this.recent, this.newlines) : undefined;
    if (before) {
      text = (caseSensitive ? before.text : foldCase(before.text)) + text;
      lines = new LineIndex(before.text + chunk.text);
      firstLine = before.firstLine;
      start = chunk.startCharacter - before.text.length;
    }
    for (let at = text.indexOf(needle, Math.max(0, this.nextAllowed - start)); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      this.nextAllowed = start + at + needle.length;
      const local = lines.lineAt(at);
      const line = firstLine + local - 1;
      if (line === this.lastLine) continue;
      this.lastLine = line;
      this.record(line, at - lines.startOf(local), lines.line(local));
      if (this.total >= MAX_EXACT_MATCHES) {
        this.stoppedEarly = true;
        this.done = true;
        return;
      }
    }
  }

  /**
   * One time slice of a regex scan of a piece. True when the piece is finished, or the search is
   * (out of time, or stopped at a line the pattern cannot get past); false when lines of the piece
   * are left for the next slice.
   */
  private scanRegex(chunk: TextChunk): boolean {
    const stop = (): true => {
      this.stoppedEarly = true;
      this.done = true;
      return true;
    };
    // Where to go on: in a piece that was left at the end of a slice, or at the start of a new one.
    let next = this.unfinished?.chunk === chunk ? this.unfinished.next : 1;
    this.unfinished = undefined;
    if (this.timeLeft <= 0) return stop();
    const pattern = this.pattern!;
    const { lines, firstLine } = chunk;
    const from = next;
    const slice = Math.min(this.timeLeft, REGEX_SLICE_MS);
    const started = performance.now();
    const finished = withinTimeLimit(() => {
      for (; next <= lines.lineCount; next++) {
        const line = firstLine + next - 1;
        const text = lines.line(next);
        const match = pattern.exec(text);
        // A line is recorded once, also when a slice ended while it was being recorded and it is looked at again.
        if (match && line > this.lastLine) {
          this.lastLine = line;
          this.record(line, match.index, text);
        }
      }
    }, slice);
    const spent = performance.now() - started;
    this.timeLeft -= spent;
    if (this.settings.regexClock) this.settings.regexClock.usedMs += spent;
    if (finished) return true;
    if (this.timeLeft <= 0) return stop();
    // The slice ended in the middle of line `next`. A whole slice without one line finished can be
    // a stall of the machine, once. Twice on the same line, it is the pattern.
    if (next === from && slice >= REGEX_SLICE_MS) {
      const line = firstLine + next - 1;
      if (this.stuck === line) return stop();
      this.stuck = line;
    }
    this.unfinished = { chunk, next };
    return false;
  }
}

/** Reads the given lines (sorted) from a document, a run of neighbouring lines at a time. */
async function readSome(source: DocumentSource, lines: number[], use: (line: number, text: string) => void): Promise<void> {
  for (let at = 0; at < lines.length;) {
    let end = at;
    while (end + 1 < lines.length && lines[end + 1]! <= lines[end]! + 1) end++;
    const texts = await source.readLines(lines[at]!, lines[end]!);
    texts.forEach((text, index) => use(lines[at]! + index, text));
    at = end + 1;
  }
}

/** Lines that contain `query` (exact text) or match it (regex), in a document held in memory. */
export function grep(document: SearchableDocument, query: string, options: GrepOptions): GrepResult {
  const search = new LineSearch(query, options, document.lines.lineCount);
  search.add(document.wholeChunk());
  for (const line of search.missing()) search.fill(line, document.lines.line(line));
  return search.result();
}

/** `grep` over any document: one held in memory, or one read from the store a piece at a time. */
export async function grepSource(source: DocumentSource, query: string, options: GrepOptions & { signal?: AbortSignal }): Promise<GrepResult> {
  const search = new LineSearch(query, options, source.lineCount);
  if (source instanceof SearchableDocument) {
    const chunk = source.wholeChunk();
    // A regex scan runs a slice at a time, and other work gets a turn between two slices.
    while (!search.addSome(chunk)) {
      await pause();
      options.signal?.throwIfAborted();
    }
    for (const line of search.missing()) search.fill(line, source.lines.line(line));
    return search.result();
  }
  await scanSource(source, (chunk) => (search.addSome(chunk) ? search.done : "again"), options.signal);
  const missing = search.missing();
  if (missing.length) await readSome(source, missing, (line, text) => search.fill(line, text));
  return search.result();
}

export function queryTerms(query: string): string[] {
  const terms = foldCase(query).split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2 && !STOPWORDS.has(term));
  return [...new Set(terms)].slice(0, 12);
}

export type RankedPassage = { from: number; to: number; score: number };

/**
 * BM25 over fixed passages, computed at query time from substring hits, over a document fed a
 * piece at a time (pieces start at passage starts). No index to build or store, works for any
 * language, and a term also matches longer words ("timeout" → "timeouts").
 */
class PassageRank {
  private readonly terms: Array<{ term: string; seen: number; frequency: Map<number, number> }>;
  /** Passage lengths in characters, for the passages that have a hit. */
  private readonly lengths = new Map<number, number>();
  private readonly phrase?: { needle: string; newlines: number; passages: Set<number>; nextAllowed: number };
  private recent: Array<readonly [number, string]> = [];

  constructor(query: string, private readonly source: Pick<DocumentSource, "passageStarts" | "lineCount" | "characters">) {
    this.terms = queryTerms(query).map((term) => ({ term, seen: 0, frequency: new Map() }));
    // Passages that contain the whole phrase rank above passages with scattered terms.
    const phrase = foldCase(query.trim());
    if (this.terms.length > 1 && phrase.length <= 200) this.phrase = { needle: phrase, newlines: newlinesIn(phrase), passages: new Set(), nextAllowed: 0 };
  }

  get empty(): boolean {
    return this.terms.length === 0;
  }

  add(chunk: TextChunk): void {
    if (this.empty) return;
    const haystack = chunk.lower();
    for (const entry of this.terms) {
      const { term } = entry;
      for (let at = haystack.indexOf(term); at !== -1 && entry.seen < MAX_OCCURRENCES_PER_TERM; at = haystack.indexOf(term, at + term.length)) {
        entry.seen++;
        const passage = this.passageOf(chunk.firstLine + chunk.lines.lineAt(at) - 1);
        entry.frequency.set(passage, (entry.frequency.get(passage) ?? 0) + 1);
        if (!this.lengths.has(passage)) this.lengths.set(passage, this.lengthOf(passage, chunk));
      }
    }
    const phrase = this.phrase;
    if (phrase && phrase.passages.size < MAX_PHRASE_PASSAGES) {
      let text = haystack;
      let lines = chunk.lines;
      let firstLine = chunk.firstLine;
      let start = chunk.startCharacter;
      const before = phrase.newlines > 0 ? carried(this.recent, phrase.newlines) : undefined;
      if (before) {
        text = foldCase(before.text) + haystack;
        lines = new LineIndex(before.text + chunk.text);
        firstLine = before.firstLine;
        start = chunk.startCharacter - before.text.length;
      }
      for (let at = text.indexOf(phrase.needle, Math.max(0, phrase.nextAllowed - start)); at !== -1 && phrase.passages.size < MAX_PHRASE_PASSAGES; at = text.indexOf(phrase.needle, at + phrase.needle.length)) {
        phrase.nextAllowed = start + at + phrase.needle.length;
        phrase.passages.add(this.passageOf(firstLine + lines.lineAt(at) - 1));
      }
      this.recent = remember(this.recent, chunk, phrase.newlines);
    }
  }

  result(topK: number): RankedPassage[] {
    if (this.empty) return [];
    const passageCount = this.source.passageStarts.length;
    const averageLength = Math.max(1, this.source.characters / passageCount);
    const scores = new Map<number, number>();
    for (const { frequency } of this.terms) {
      const df = frequency.size;
      if (df === 0) continue;
      const idf = Math.log(1 + (passageCount - df + 0.5) / (df + 0.5));
      for (const [passage, tf] of frequency) {
        const length = this.lengths.get(passage)!;
        const score = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (length / averageLength)));
        scores.set(passage, (scores.get(passage) ?? 0) + score);
      }
    }
    if (this.phrase) for (const passage of this.phrase.passages) scores.set(passage, (scores.get(passage) ?? 0) * 1.5 + 1);
    return [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, topK)
      .map(([passage, score]) => ({ ...this.range(passage), score: Math.round(score * 100) / 100 }));
  }

  private passageOf(line: number): number {
    return positionOf(this.source.passageStarts, line) - 1;
  }

  private range(passage: number): { from: number; to: number } {
    const starts = this.source.passageStarts;
    return { from: starts[passage]!, to: (passage + 1 < starts.length ? starts[passage + 1]! : this.source.lineCount + 1) - 1 };
  }

  private lengthOf(passage: number, chunk: TextChunk): number {
    const { from, to } = this.range(passage);
    const first = from - chunk.firstLine + 1;
    const last = to - chunk.firstLine + 1;
    if (first < 1 || last > chunk.lines.lineCount) throw new Error("A piece of the text does not hold whole passages.");
    return chunk.lines.endOf(last) - chunk.lines.startOf(first) + 1;
  }
}

/** BM25 passage ranking over a document held in memory. */
export function rankPassages(document: SearchableDocument, query: string, topK: number): RankedPassage[] {
  const rank = new PassageRank(query, document);
  rank.add(document.wholeChunk());
  return rank.result(topK);
}

/** `rankPassages` over any document: one held in memory, or one read from the store a piece at a time. */
export async function rankSource(source: DocumentSource, query: string, topK: number, signal?: AbortSignal): Promise<RankedPassage[]> {
  if (source instanceof SearchableDocument) return rankPassages(source, query, topK);
  const rank = new PassageRank(query, source);
  if (rank.empty) return [];
  await scanSource(source, (chunk) => {
    rank.add(chunk);
  }, signal);
  return rank.result(topK);
}
