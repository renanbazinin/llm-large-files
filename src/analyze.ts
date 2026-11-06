import type { DocumentFormat, LogIssue, LogProfile, OutlineEntry } from "./types.js";

const MAX_OUTLINE_ENTRIES = 400;
const MAX_TEMPLATES = 50_000;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
const LINE_START_TIMESTAMP = /^\[?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}\/\d{2}\/\d{4}|\w{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})/;
const LEVEL = /\b(FATAL|CRITICAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)\b/;
const LEVEL_NAMES: Record<string, string> = { ERR: "ERROR", WARNING: "WARN", CRITICAL: "FATAL" };

/** Treats text as a log when most early lines start with a timestamp or a level. */
export function looksLikeLog(lines: string[]): boolean {
  const sample = lines.filter((line) => line.trim()).slice(0, 200);
  if (sample.length < 5) return false;
  const hits = sample.filter((line) => LINE_START_TIMESTAMP.test(line.trim()) || /^\[?(FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b/.test(line.trim())).length;
  return hits / sample.length >= 0.4;
}

/** Headings with line numbers: Markdown, slide/page markers, and common book and report patterns. */
export function buildOutline(lines: string[], format: DocumentFormat): OutlineEntry[] {
  if (format === "log" || format === "json" || format === "csv") return [];
  const entries: OutlineEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").trim();
    if (!line || line.length > 120) continue;
    const previousBlank = index === 0 || !(lines[index - 1] ?? "").trim();
    let entry: OutlineEntry | undefined;
    const markdown = /^(#{1,6})\s+(.+)$/.exec(line);
    if (markdown) entry = { line: index + 1, level: markdown[1]!.length, title: markdown[2]!.trim() };
    // A lookahead, not \b: JavaScript's \b does not treat Hebrew letters as word characters.
    else if (/^(chapter|part|book|section|appendix|פרק|חלק|נספח)(?=[\s:.\d]|$)/iu.test(line) && previousBlank) {
      entry = { line: index + 1, level: /^(part|book|חלק)(?=[\s:.\d]|$)/iu.test(line) ? 1 : 2, title: line };
    } else if (/^\d+(\.\d+){0,2}\s+\S/.test(line) && previousBlank && line.length <= 80 && !/[.:;,]$/.test(line)) {
      entry = { line: index + 1, level: (line.split(" ")[0]!.match(/\./g)?.length ?? 0) + 2, title: line };
    } else if (previousBlank && line.length >= 4 && line.length <= 60 && /\p{Lu}/u.test(line) && line === line.toUpperCase() && /\p{L}{3}/u.test(line)) {
      entry = { line: index + 1, level: 2, title: line };
    }
    if (entry) entries.push(entry);
  }
  if (entries.length <= MAX_OUTLINE_ENTRIES) return entries;
  // Keep the top levels first, then sample evenly so the outline still spans the document.
  const minLevel = Math.min(...entries.map((entry) => entry.level));
  const top = entries.filter((entry) => entry.level === minLevel);
  const pool = top.length >= 20 ? top : entries;
  const step = pool.length / MAX_OUTLINE_ENTRIES;
  return Array.from({ length: Math.min(pool.length, MAX_OUTLINE_ENTRIES) }, (_, index) => pool[Math.floor(index * step)]!);
}

/** Replaces the variable parts of a log message so repeated failures group together. */
export function logTemplate(line: string): string {
  return line
    .replace(TIMESTAMP, "")
    .replace(/^\W*\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, "<s>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function buildLogProfile(lines: string[]): LogProfile {
  const levels: Record<string, number> = {};
  const templates = new Map<string, LogIssue>();
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const stamp = TIMESTAMP.exec(line)?.[0];
    if (stamp) {
      firstTimestamp ??= stamp;
      lastTimestamp = stamp;
    }
    const raw = LEVEL.exec(line)?.[1];
    if (!raw) continue;
    const level = LEVEL_NAMES[raw] ?? raw;
    levels[level] = (levels[level] ?? 0) + 1;
    if (level !== "ERROR" && level !== "FATAL" && level !== "WARN") continue;
    const template = logTemplate(line);
    const existing = templates.get(template);
    if (existing) existing.count++;
    else if (templates.size < MAX_TEMPLATES) templates.set(template, { template, level, count: 1, firstLine: index + 1 });
  }
  const severity = (issue: LogIssue) => (issue.level === "FATAL" ? 2 : issue.level === "ERROR" ? 1 : 0);
  const topIssues = [...templates.values()]
    .sort((left, right) => severity(right) - severity(left) || right.count - left.count)
    .slice(0, 15);
  return {
    levels,
    ...(firstTimestamp ? { firstTimestamp } : {}),
    ...(lastTimestamp ? { lastTimestamp } : {}),
    topIssues,
  };
}
