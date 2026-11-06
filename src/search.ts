import { LineIndex } from "./text.js";
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

  constructor(document: StoredDocument) {
    this.meta = document.meta;
    this.text = document.text;
    this.lines = new LineIndex(document.text);
  }

  /** Lowercased text for case-insensitive search, or undefined if lowercasing changes offsets. */
  get lower(): string | undefined {
    if (this.lowerText === undefined) {
      const lower = this.text.toLowerCase();
      this.lowerText = lower.length === this.text.length ? lower : "";
    }
    return this.lowerText || undefined;
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

/** Rejects patterns with nested quantifiers such as (a+)+, the usual cause of catastrophic backtracking. */
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
  options: { regex?: boolean; caseSensitive?: boolean; maxResults: number; contextLines: number },
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
    const started = Date.now();
    for (let line = 1; line <= lines.lineCount; line++) {
      const text = lines.line(line);
      const match = pattern.exec(text);
      if (match) record(line, match.index);
      if (line % 2_000 === 0 && Date.now() - started > REGEX_TIME_LIMIT_MS) {
        stoppedEarly = true;
        break;
      }
    }
  } else {
    const lower = options.caseSensitive ? undefined : document.lower;
    const haystack = options.caseSensitive || !lower ? document.text : lower;
    const needle = options.caseSensitive || !lower ? query : query.toLowerCase();
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
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2 && !STOPWORDS.has(term));
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
  const haystack = document.lower ?? document.text;
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
  const phrase = query.trim().toLowerCase();
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
