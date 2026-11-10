import { createContext, Script, type Context } from "node:vm";
import { foldCase, LineIndex } from "./text.js";
import type { DocumentMeta, StoredDocument } from "./types.js";

const PASSAGE_CHARACTERS = 1_500;
const PASSAGE_MAX_LINES = 40;
const MAX_OCCURRENCES_PER_TERM = 200_000;
const REGEX_TIME_LIMIT_MS = 3_000;
const SHOWN_LINE_CHARACTERS = 400;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "that", "this", "what", "how", "why", "when", "where", "who",
  "from", "into", "about", "does", "did", "have", "has", "had", "you", "your", "can", "all", "any", "not",
  "של", "את", "על", "עם", "מה", "איך", "למה", "מתי", "איפה", "מי", "זה", "זאת", "גם", "או", "אם", "כל", "יש", "אין",
]);

/** A stored document with lazily built search structures. Build once, query many times. */
export class SearchableDocument {
  readonly meta: DocumentMeta;
  readonly text: string;
  readonly lines: LineIndex;
  private lowerText?: string;
  private passageStarts?: number[];
  private pageStarts?: number[];

  constructor(document: StoredDocument) {
    this.meta = document.meta;
    this.text = document.text;
    this.lines = new LineIndex(document.text);
  }

  /** The text lowercased for case-insensitive search. Same length as `text`, so offsets match. */
  get lower(): string {
    this.lowerText ??= foldCase(this.text);
    return this.lowerText;
  }

  /** First line of each passage: groups of lines up to about 1,500 characters. */
  get passages(): number[] {
    if (!this.passageStarts) {
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
      this.passageStarts = starts;
    }
    return this.passageStarts;
  }

  passageRange(index: number): { from: number; to: number } {
    const starts = this.passages;
    return { from: starts[index]!, to: (starts[index + 1] ?? this.lines.lineCount + 1) - 1 };
  }

  passageOfLine(line: number): number {
    const starts = this.passages;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= line) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /**
   * The page a line is on, from the "--- Page N ---" lines the PDF extractor writes. Undefined for
   * a text without them, and for lines above the first one. Only markers that count up from 1 are
   * used, so a line of the document that happens to read "--- Page 7 ---" is not taken for one.
   */
  pageOfLine(line: number): number | undefined {
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
    const starts = this.pageStarts;
    if (starts.length === 0 || line < starts[0]!) return undefined;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= line) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  /** The pages a range of lines is on, as "12" or "12-14". Undefined for a text without page lines. */
  pagesOfLines(from: number, to: number): string | undefined {
    const last = this.pageOfLine(to);
    if (last === undefined) return undefined;
    const first = this.pageOfLine(from) ?? 1;
    return first === last ? String(last) : `${first}-${last}`;
  }
}

export type LineMatch = { line: number; text: string; before?: string[]; after?: string[] };

export type GrepResult = {
  totalMatchingLines: number;
  /** True when the scan stopped early (too many matches or the regex time limit). */
  stoppedEarly: boolean;
  matches: LineMatch[];
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
    RUN_SCAN.runInContext(scanContext, { timeout: milliseconds });
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

/** Lines that contain `query` (exact text) or match it (regex). */
export function grep(
  document: SearchableDocument,
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean; maxResults: number; contextLines: number; /** Regex mode only. Defaults to 3 seconds. */ timeLimitMs?: number },
): GrepResult {
  const { lines } = document;
  if (!query) throw new Error("The search query is empty.");
  const hits: Array<{ line: number; column: number }> = [];
  let total = 0;
  let stoppedEarly = false;
  const record = (line: number, column: number) => {
    total++;
    if (hits.length < options.maxResults) hits.push({ line, column });
  };

  if (options.regex) {
    const problem = unsafeRegexReason(query);
    if (problem) throw new Error(problem);
    const pattern = new RegExp(query, options.caseSensitive ? "" : "i");
    const finished = withinTimeLimit(() => {
      for (let line = 1; line <= lines.lineCount; line++) {
        const match = pattern.exec(lines.line(line));
        if (match) record(line, match.index);
      }
    }, options.timeLimitMs ?? REGEX_TIME_LIMIT_MS);
    if (!finished) stoppedEarly = true;
  } else {
    const haystack = options.caseSensitive ? document.text : document.lower;
    const needle = options.caseSensitive ? query : foldCase(query);
    let lastLine = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
      const line = lines.lineAt(at);
      if (line === lastLine) continue;
      lastLine = line;
      record(line, at - lines.startOf(line));
      if (total >= 1_000_000) {
        stoppedEarly = true;
        break;
      }
    }
  }

  const context = Math.max(0, Math.min(5, options.contextLines));
  const matches = hits.map(({ line, column }): LineMatch => {
    const match: LineMatch = { line, text: clip(lines.line(line), column) };
    if (context > 0) {
      match.before = [];
      match.after = [];
      for (let other = Math.max(1, line - context); other < line; other++) match.before.push(`${other}| ${clip(lines.line(other), 0)}`);
      for (let other = line + 1; other <= Math.min(lines.lineCount, line + context); other++) match.after.push(`${other}| ${clip(lines.line(other), 0)}`);
    }
    return match;
  });
  return { totalMatchingLines: total, stoppedEarly, matches };
}

export function queryTerms(query: string): string[] {
  const terms = foldCase(query).split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2 && !STOPWORDS.has(term));
  return [...new Set(terms)].slice(0, 12);
}

export type RankedPassage = { from: number; to: number; score: number };

/**
 * BM25 over fixed passages, computed at query time from substring hits. No index to build or
 * store, works for any language, and a term also matches longer words ("timeout" → "timeouts").
 */
export function rankPassages(document: SearchableDocument, query: string, topK: number): RankedPassage[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const haystack = document.lower;
  const passageCount = document.passages.length;
  const averageLength = Math.max(1, document.text.length / passageCount);
  const scores = new Map<number, number>();
  for (const term of terms) {
    const frequency = new Map<number, number>();
    let seen = 0;
    for (let at = haystack.indexOf(term); at !== -1 && seen < MAX_OCCURRENCES_PER_TERM; at = haystack.indexOf(term, at + term.length)) {
      seen++;
      const passage = document.passageOfLine(document.lines.lineAt(at));
      frequency.set(passage, (frequency.get(passage) ?? 0) + 1);
    }
    const df = frequency.size;
    if (df === 0) continue;
    const idf = Math.log(1 + (passageCount - df + 0.5) / (df + 0.5));
    for (const [passage, tf] of frequency) {
      const range = document.passageRange(passage);
      const length = document.lines.endOf(range.to) - document.lines.startOf(range.from) + 1;
      const score = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (length / averageLength)));
      scores.set(passage, (scores.get(passage) ?? 0) + score);
    }
  }
  // Passages that contain the whole phrase rank above passages with scattered terms.
  const phrase = foldCase(query.trim());
  if (terms.length > 1 && phrase.length <= 200) {
    const withPhrase = new Set<number>();
    for (let at = haystack.indexOf(phrase); at !== -1 && withPhrase.size < 10_000; at = haystack.indexOf(phrase, at + phrase.length)) {
      withPhrase.add(document.passageOfLine(document.lines.lineAt(at)));
    }
    for (const passage of withPhrase) scores.set(passage, (scores.get(passage) ?? 0) * 1.5 + 1);
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, topK)
    .map(([passage, score]) => ({ ...document.passageRange(passage), score: Math.round(score * 100) / 100 }));
}
