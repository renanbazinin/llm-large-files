/** Lines longer than this are split so line-based tools always return bounded output. */
export const MAX_LINE_CHARACTERS = 2_000;

/** Strips a BOM, unifies line endings, and removes control characters other than tab and newline. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

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
      const cut = soft > limit * 0.8 ? soft + 1 : limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return { text: out.join("\n"), wrapped };
}

/**
 * A deliberately conservative token estimate: about 4 characters per token for ASCII and
 * 1.5 for other scripts (Hebrew, CJK, etc.). Overestimating only moves a document to the
 * searchable path sooner, which is safe.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

/** UTF-8 byte length without allocating an encoded copy. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** Bytes a string adds to a JSON request body, including escapes for quotes and newlines. */
export function jsonBytes(text: string): number {
  return Math.ceil(utf8Bytes(text) * 1.08) + 2;
}

/** Fast line lookups over one text. Line numbers are 1-based. */
export class LineIndex {
  private readonly starts: Uint32Array;
  readonly lineCount: number;

  constructor(private readonly text: string) {
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
