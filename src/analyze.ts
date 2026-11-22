import type { TimeSlicer } from "./pause.js";
import { sliceWhole } from "./text.js";
import type { DocumentFormat, LogIssue, LogProfile, OutlineEntry } from "./types.js";

const MAX_OUTLINE_ENTRIES = 400;
const MAX_TEMPLATES = 50_000;
/**
 * Timestamps of logs: ISO 8601 (2026-11-10T14:03:17.120Z), nginx's error log (2026/11/10
 * 14:03:17), the access logs of Apache and nginx (10/Nov/2026:14:03:17 +0000), and syslog (Nov 10
 * 14:03:17).
 */
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}|\b\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?|\b[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}/;
const LINE_START_TIMESTAMP = /^\[?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}|\w{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})/;
/** Other shapes of log lines: an access log, a JSON log, klog, logfmt. */
const LOG_LINE = /^(?:\d{1,3}(?:\.\d{1,3}){3} \S+ \S+ \[\d{2}\/\w{3}\/\d{4}:|\{.*"(?:level|severity|time|timestamp|ts|@timestamp)"\s*:|[IWEF]\d{4} \d{2}:\d{2}:\d{2}|(?:time|ts|level|lvl)=)/;
/** A level word in upper case, anywhere on the line. */
const LEVEL = /\b(FATAL|CRITICAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)\b/;
/**
 * A level in lower or mixed case, where logs put one: in brackets as nginx and Apache do
 * ("[error]"), after `level=` as logfmt, zap and logrus do, or in a JSON field ("level":"warn").
 */
const MARKED_LEVEL = /(?:\[|\b(?:level|lvl|severity)=\s*"?|"(?:level|severity)"\s*:\s*")(fatal|critical|crit|emerg|alert|error|err|warning|warn|notice|info|debug|trace)\b/i;
/** pino and bunyan write the level as a number. */
const NUMBER_LEVEL = /"level"\s*:\s*(10|20|30|40|50|60)\b/;
const NUMBER_LEVELS: Record<string, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
/** klog and glog start a line with the level's letter, then the month and day. */
const LETTER_LEVEL = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}/;
const LETTER_LEVELS: Record<string, string> = { I: "INFO", W: "WARN", E: "ERROR", F: "FATAL" };
const LEVEL_NAMES: Record<string, string> = { ERR: "ERROR", WARNING: "WARN", CRITICAL: "FATAL", CRIT: "FATAL", EMERG: "FATAL", ALERT: "FATAL", NOTICE: "INFO" };

/** The level of a log line, in upper case ("ERROR", "WARN"), or undefined. */
export function levelOf(line: string): string | undefined {
  const raw = LEVEL.exec(line)?.[1]
    ?? MARKED_LEVEL.exec(line)?.[1]?.toUpperCase()
    ?? NUMBER_LEVELS[NUMBER_LEVEL.exec(line)?.[1] ?? ""]
    ?? LETTER_LEVELS[LETTER_LEVEL.exec(line)?.[1] ?? ""];
  return raw === undefined ? undefined : LEVEL_NAMES[raw] ?? raw;
}

/** Treats text as a log when most early lines start with a timestamp or a level, or have the shape of a log line. */
export function looksLikeLog(lines: string[]): boolean {
  const sample: string[] = [];
  for (let index = 0; index < lines.length && sample.length < 200; index++) if (lines[index]!.trim()) sample.push(lines[index]!);
  if (sample.length < 5) return false;
  const hits = sample.filter((line) => {
    const trimmed = line.trim();
    return LINE_START_TIMESTAMP.test(trimmed) || LOG_LINE.test(trimmed) || /^\[?(FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b/i.test(trimmed);
  }).length;
  return hits / sample.length >= 0.4;
}

/** A line that opens or closes a fenced code block of Markdown: ``` or ~~~. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Follows fenced code blocks line by line: a "# comment" in a block of shell or Python is not a
 * heading. A fence closes with the same character, at least as long.
 */
class Fences {
  private open: string | undefined;

  /** Whether line `line` is inside a block, its fences included. */
  inside(line: string): boolean {
    const fence = FENCE.exec(line)?.[1];
    if (this.open !== undefined) {
      if (fence && fence[0] === this.open[0] && fence.length >= this.open.length && line.trim() === fence) this.open = undefined;
      return true;
    }
    if (fence) {
      this.open = fence;
      return true;
    }
    return false;
  }
}

/** Headings with line numbers: Markdown, slide/page markers, and common book and report patterns. */
export function buildOutline(lines: string[], format: DocumentFormat): OutlineEntry[] {
  if (format === "log" || format === "json" || format === "csv") return [];
  const entries: OutlineEntry[] = [];
  const fences = new Fences();
  const hashes = hashHeadings(lines, format);
  for (let index = 0; index < lines.length; index++) {
    if (fences.inside(lines[index] ?? "")) continue;
    const entry = outlineEntry(lines, index, hashes);
    if (entry) entries.push(entry);
  }
  return pickOutline(entries);
}

/** `buildOutline`, the same result, with pauses for other requests while a large file is read. */
export async function buildOutlineInSlices(lines: string[], format: DocumentFormat, slicer: TimeSlicer): Promise<OutlineEntry[]> {
  if (format === "log" || format === "json" || format === "csv") return [];
  const entries: OutlineEntry[] = [];
  const fences = new Fences();
  const hashes = hashHeadings(lines, format);
  for (let index = 0; index < lines.length; index++) {
    if ((index & 4095) === 4095) await slicer.maybePause();
    if (fences.inside(lines[index] ?? "")) continue;
    const entry = outlineEntry(lines, index, hashes);
    if (entry) entries.push(entry);
  }
  return pickOutline(entries);
}

/** Whether a line is a "# " line: a Markdown heading, or a comment of a script or a configuration file. */
const hashLine = (line: string | undefined) => /^\s*#{1,6}\s/.test(line ?? "");

/** A line only code has: a shebang, an include, an import, a definition. One is enough. */
const CODE_LINE = /^\s*(?:#!\/|#include\b|import\s+[\w{*"']|from\s+[\w.]+\s+import\b|def\s+\w+\s*\(|class\s+\w+[\s:({]|function\s*\w*\s*\(|package\s+[\w.]+;?\s*$|using\s+[\w.]+;\s*$)/;
/** A line common in code and configuration files, and rarer in prose: three are needed. */
const CODE_LIKE_LINE = /^\s*(?:(?:const|let|var|export|public|private|return)\s|(?:if|for|while)\s*\(|echo\s|set\s+-\w|[A-Za-z_][\w.-]*\s*=\s*\S|[}\])];?\s*$|.*[{;]\s*$)/;

/**
 * Whether a plain text file is a script, source code or a configuration file, where "# " starts
 * a comment, not a heading: one of its first lines only code has, or three that code often has.
 */
function looksLikeCode(lines: string[]): boolean {
  let likely = 0;
  for (let index = 0; index < lines.length && index < 300; index++) {
    const line = lines[index] ?? "";
    if (CODE_LINE.test(line)) return true;
    if (CODE_LIKE_LINE.test(line) && ++likely >= 3) return true;
  }
  return false;
}

/**
 * Which "# " lines are headings: all of them in Markdown and the other formats; in a plain text
 * file, none when it reads as code ("strict" is false then), and otherwise only one after a blank
 * line that is not followed by another "# " line, as comments come in blocks.
 */
type HashHeadings = "all" | "strict" | "none";

function hashHeadings(lines: string[], format: DocumentFormat): HashHeadings {
  if (format !== "text") return "all";
  return looksLikeCode(lines) ? "none" : "strict";
}

/** The heading on line `index` (0-based), if it is one. */
function outlineEntry(lines: string[], index: number, hashes: HashHeadings = "all"): OutlineEntry | undefined {
  const line = (lines[index] ?? "").trim();
  if (!line || line.length > 120) return undefined;
  const previousBlank = index === 0 || !(lines[index - 1] ?? "").trim();
  const markdown = /^(#{1,6})\s+(.+)$/.exec(line);
  if (markdown) {
    if (hashes === "none" || (hashes === "strict" && (!previousBlank || hashLine(lines[index + 1])))) return undefined;
    return { line: index + 1, level: markdown[1]!.length, title: markdown[2]!.trim() };
  }
  // A lookahead, not \b: JavaScript's \b does not treat Hebrew letters as word characters.
  if (/^(chapter|part|book|section|appendix|פרק|חלק|נספח)(?=[\s:.\d]|$)/iu.test(line) && previousBlank) {
    return { line: index + 1, level: /^(part|book|חלק)(?=[\s:.\d]|$)/iu.test(line) ? 1 : 2, title: line };
  }
  if (/^\d+(\.\d+){0,2}\s+\S/.test(line) && previousBlank && line.length <= 80 && !/[.:;,]$/.test(line)) {
    return { line: index + 1, level: (line.split(" ")[0]!.match(/\./g)?.length ?? 0) + 2, title: line };
  }
  if (previousBlank && line.length >= 4 && line.length <= 60 && /\p{Lu}/u.test(line) && line === line.toUpperCase() && /\p{L}{3}/u.test(line)) {
    return { line: index + 1, level: 2, title: line };
  }
  return undefined;
}

/** The outline kept from all the headings found: at most 400 of them. */
function pickOutline(entries: OutlineEntry[]): OutlineEntry[] {
  if (entries.length <= MAX_OUTLINE_ENTRIES) return entries;
  // Keep the top-level headings when there are at least 20 of them. A pool that fits is kept whole;
  // a larger one is sampled evenly, so the outline still spans the document.
  // A loop, not Math.min(...levels): spreading a few hundred thousand values overflows the stack.
  let minLevel = Number.POSITIVE_INFINITY;
  for (const entry of entries) if (entry.level < minLevel) minLevel = entry.level;
  const top = entries.filter((entry) => entry.level === minLevel);
  const pool = top.length >= 20 ? top : entries;
  if (pool.length <= MAX_OUTLINE_ENTRIES) return pool;
  // The step is above 1 here, so each sampled index is greater than the one before it.
  const step = pool.length / MAX_OUTLINE_ENTRIES;
  return Array.from({ length: MAX_OUTLINE_ENTRIES }, (_, index) => pool[Math.floor(index * step)]!);
}

/** Replaces the variable parts of a log message so repeated failures group together. */
export function logTemplate(line: string): string {
  const template = line
    .replace(TIMESTAMP, "")
    .replace(/^\W*\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, "<s>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return sliceWhole(template, 180);
}

export function buildLogProfile(lines: string[]): LogProfile {
  const profile = new LogProfiler();
  for (let index = 0; index < lines.length; index++) profile.add(lines[index] ?? "", index);
  return profile.result();
}

/** `buildLogProfile`, the same result, with pauses for other requests while a large log is read. */
export async function buildLogProfileInSlices(lines: string[], slicer: TimeSlicer): Promise<LogProfile> {
  const profile = new LogProfiler();
  for (let index = 0; index < lines.length; index++) {
    profile.add(lines[index] ?? "", index);
    if ((index & 4095) === 4095) await slicer.maybePause();
  }
  return profile.result();
}

/** Builds a log profile one line at a time. */
class LogProfiler {
  private readonly levels: Record<string, number> = {};
  private readonly templates = new Map<string, LogIssue>();
  private firstTimestamp: string | undefined;
  private lastTimestamp: string | undefined;

  /** Adds line `index` (0-based). */
  add(line: string, index: number): void {
    const stamp = TIMESTAMP.exec(line)?.[0];
    if (stamp) {
      this.firstTimestamp ??= stamp;
      this.lastTimestamp = stamp;
    }
    const level = levelOf(line);
    if (!level) return;
    this.levels[level] = (this.levels[level] ?? 0) + 1;
    if (level !== "ERROR" && level !== "FATAL" && level !== "WARN") return;
    const template = logTemplate(line);
    const existing = this.templates.get(template);
    if (existing) existing.count++;
    else if (this.templates.size < MAX_TEMPLATES) this.templates.set(template, { template, level, count: 1, firstLine: index + 1 });
  }

  result(): LogProfile {
    const severity = (issue: LogIssue) => (issue.level === "FATAL" ? 2 : issue.level === "ERROR" ? 1 : 0);
    const topIssues = [...this.templates.values()]
      .sort((left, right) => severity(right) - severity(left) || right.count - left.count)
      .slice(0, 15);
    return {
      levels: this.levels,
      ...(this.firstTimestamp ? { firstTimestamp: this.firstTimestamp } : {}),
      ...(this.lastTimestamp ? { lastTimestamp: this.lastTimestamp } : {}),
      topIssues,
    };
  }
}
