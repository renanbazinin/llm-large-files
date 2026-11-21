import { plural, sliceWhole, wellFormed } from "./text.js";
import type { Budget, DocumentMeta, DocumentPlan, OutlineEntry } from "./types.js";

/** Bytes kept free for document cards, the tool declarations, and JSON framing. */
export const REQUEST_BYTES_MARGIN = 256 * 1024;
const CARD_HEAD_LINES = 25;
const CARD_OUTLINE_ENTRIES = 40;

/**
 * Decides which documents go into the prompt in full and which the model reaches through
 * tools. Smaller documents are inlined first, so as many as possible are read in full.
 */
export function planDocuments(
  documents: DocumentMeta[],
  budget: Budget,
  base: { tokens: number; bytes: number },
): DocumentPlan {
  const tokenRoom = Math.min(budget.inlineTokens, budget.contextTokens - budget.reservedTokens - base.tokens);
  const byteRoom = budget.maxRequestBytes - REQUEST_BYTES_MARGIN - base.bytes;
  const plan: DocumentPlan = { inline: [], searchable: [], inlineTokens: 0, inlineBytes: 0 };
  for (const meta of [...documents].sort((left, right) => left.estimatedTokens - right.estimatedTokens)) {
    const bytes = (meta.jsonBytes ?? Math.ceil(meta.textBytes * 1.08)) + 200;
    if (plan.inlineTokens + meta.estimatedTokens <= tokenRoom && plan.inlineBytes + bytes <= byteRoom) {
      plan.inline.push(meta);
      plan.inlineTokens += meta.estimatedTokens;
      plan.inlineBytes += bytes;
    } else {
      plan.searchable.push(meta);
    }
  }
  return plan;
}

/** The digits of the numbers 1 to `count`, written out: what the line numbers of a text take. */
function digitsUpTo(count: number): number {
  let digits = 0;
  for (let width = 1, first = 1; first <= count; width++, first *= 10) digits += (Math.min(count, first * 10 - 1) - first + 1) * width;
  return digits;
}

/**
 * About how many parts a whole-document read of a document takes, from its metadata alone:
 * counting them exactly means reading the whole text. In the prompt every line carries its number
 * (`12345| `), at about 1.2 tokens a digit and one for the bar, and each line's estimate is
 * rounded up. A part ends at the end of a line, so it is short of full by half a line on average.
 * On logs, prose, tables and blank-heavy text this lands within a few percent of the count.
 */
export function estimateParts(meta: Pick<DocumentMeta, "estimatedTokens" | "lines" | "textBytes" | "jsonBytes">, budget: Budget): number {
  const lines = Math.max(1, meta.lines);
  const digits = digitsUpTo(lines);
  const tokens = meta.estimatedTokens + 1.2 * digits + 1.5 * lines;
  const bytes = (meta.jsonBytes ?? meta.textBytes * 1.08) + digits + 4 * lines;
  const room = (limit: number, size: number) => Math.max(1, limit - size / lines / 2);
  const maxBytes = Math.floor(budget.maxRequestBytes * 0.8);
  return Math.max(1, Math.ceil(Math.max(tokens / room(budget.mapChunkTokens, tokens), bytes / room(maxBytes, bytes))));
}

/**
 * Whether a whole-document read of a document is within `maxMapChunks`, as far as its metadata
 * tells. The estimate runs a few percent high, so a file just over the limit by it is let through:
 * the read counts its parts, and refuses with the reason if they are too many after all.
 */
export function canBeReadWhole(meta: Pick<DocumentMeta, "estimatedTokens" | "lines" | "textBytes" | "jsonBytes">, budget: Budget): boolean {
  const parts = estimateParts(meta, budget);
  // Metadata that does not say (a record of a document that an application kept in part): not refused here.
  return !Number.isFinite(parts) || parts <= budget.maxMapChunks * 1.05;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString("en-US");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** "L12 Title" lines, indented relative to the shallowest heading. */
export function outlineLines(outline: OutlineEntry[]): string[] {
  let top = Number.POSITIVE_INFINITY;
  for (const entry of outline) if (entry.level < top) top = entry.level;
  return outline.map((entry) => `L${entry.line} ${"  ".repeat(entry.level - top)}${entry.title}`);
}

/**
 * What the model is told of a text file that was not valid UTF-8, or nothing: in which encoding
 * it was read, so that it can say so when letters look wrong, or why it shows U+FFFD.
 */
function readingNote(meta: DocumentMeta, short: boolean): string | undefined {
  const count = meta.replacedCharacters ?? 0;
  const characters = `${count.toLocaleString("en-US")} ${count === 1 ? "character" : "characters"}`;
  const were = count === 1 ? "was" : "were";
  const show = count === 1 ? "shows" : "show";
  if (meta.encoding) {
    if (short) return `read as ${meta.encoding}${count ? `, ${characters} not valid in it, shown as �` : ""}`;
    const read = `This file is not in UTF-8. Its text was read as ${meta.encoding}: if its letters look wrong, ask the user to save it as UTF-8.`;
    // Bytes further on that the encoding does not have.
    return count ? `${read} ${characters} of it ${were} not valid in ${meta.encoding}, and ${show} as �.` : read;
  }
  if (!count) return undefined;
  return short ? `${characters} not valid UTF-8, shown as �` : `${characters} of this file ${were} not valid UTF-8, and ${show} as �.`;
}

/**
 * Eight hex digits made from a document ID. The ID is made at random when the file is stored, so
 * the file's own text cannot know them, and they are the same in every request: a provider's
 * prompt cache still reuses the file.
 */
export function frameMark(id: string): string {
  // FNV-1a, 32 bits.
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A file sent whole, between two frame lines. Both carry a mark the file's text cannot hold, and
 * the first one says that only the line with the mark ends the file: a line of the file such as
 * "--- End attached file: report.txt ---", in whatever letters, cannot end it early and start a
 * fake one. The uploader chooses the name with the text, so the mark comes before the name, the
 * name is quoted, and the last line holds the mark alone: a name cannot name a mark of its own.
 */
export function renderInline(meta: DocumentMeta, text: string): string {
  const mark = frameMark(meta.id);
  const note = readingNote(meta, true);
  return `--- Attached file [mark ${mark}]: ${JSON.stringify(meta.name)} (${meta.format}, ${meta.lines.toLocaleString("en-US")} ${plural(meta.lines, "line")}${note ? `, ${note}` : ""}; it ends only at the line with mark ${mark}) ---\n${text}\n--- End attached file [mark ${mark}] ---`;
}

/** How many lines of a file its card shows. */
export const CARD_LINES = CARD_HEAD_LINES;

/**
 * What a card says of a whole-document read: that it can have one ("offered"), that the file is
 * too large for one ("too_large"), or nothing, when the tools have none ("not_offered").
 */
export type WholeRead = "offered" | "too_large" | "not_offered";

/** The line of a card that says how to read the file. */
const HOW_TO_READ: Record<WholeRead, string> = {
  offered: "This file is NOT in your context. Use the document tools to search it, read line ranges, or analyze all of it.",
  too_large: "This file is NOT in your context. Use the document tools to search it and to read line ranges. It is too large to be analyzed whole.",
  not_offered: "This file is NOT in your context. Use the document tools to search it and to read line ranges.",
};

/**
 * A compact stand-in for a document that is too large for the prompt. `head` is its first
 * `CARD_LINES` lines, numbered. `viewable` adds a line saying that its pages can be looked at
 * with `view_pages`. `wholeRead` says whether the card offers a whole-document read.
 */
export function renderCard(meta: DocumentMeta, head: string, viewable = false, wholeRead: WholeRead = "offered"): string {
  const note = readingNote(meta, false);
  const out = [
    `--- Large attached file: ${meta.name} ---`,
    `document_id: ${meta.id}`,
    `${meta.format} · ${formatBytes(meta.bytes)} · ${meta.lines.toLocaleString("en-US")} ${plural(meta.lines, "line")}${meta.pages ? ` · ${meta.pages} ${plural(meta.pages, "page")}` : ""} · about ${formatCount(meta.estimatedTokens)} tokens`,
    HOW_TO_READ[wholeRead],
    ...(viewable ? ["Its text cannot show pictures. To see a picture, a chart or the layout of a page, look at the page with view_pages."] : []),
    ...(note ? [note] : []),
  ];
  const profile = meta.logProfile;
  if (profile) {
    const levels = Object.entries(profile.levels).map(([level, count]) => `${level} ${count.toLocaleString("en-US")}`).join(", ");
    if (levels) out.push(`Log levels: ${levels}`);
    if (profile.firstTimestamp) out.push(`Time range: ${profile.firstTimestamp} → ${profile.lastTimestamp ?? profile.firstTimestamp}`);
    if (profile.topIssues.length) {
      out.push("Most frequent problems (count, first line):");
      // 0.5.0 stored some templates cut inside an emoji: half of a character is not sent.
      for (const issue of profile.topIssues.slice(0, 8)) out.push(`  [${issue.level} ×${issue.count}, L${issue.firstLine}] ${wellFormed(issue.template)}`);
    }
  }
  if (meta.outline.length) {
    out.push(`Outline (${Math.min(meta.outline.length, CARD_OUTLINE_ENTRIES)} of ${meta.outline.length} headings):`);
    out.push(...outlineLines(meta.outline.slice(0, CARD_OUTLINE_ENTRIES)).map((line) => `  ${line}`));
  }
  out.push(`First lines:`, head.split("\n").map((line) => `  ${sliceWhole(line, 300)}`).join("\n"));
  out.push(`--- End large attached file: ${meta.name} ---`);
  return out.join("\n");
}

/**
 * The tool guide for the system prompt. `searchable` are the files the model reads through the
 * text tools. `viewable` are the PDFs whose pages it can look at with `view_pages`: some of them
 * may be searchable, and some may have their whole text in the prompt. `wholeReads` is false when
 * the tools have no `analyze_whole_document`, or every searchable file is too large for it: the
 * guide then leaves it out.
 */
export function documentToolsInstruction(searchable: DocumentMeta[], viewable: DocumentMeta[] = [], wholeReads = true): string {
  // File names come from uploads. Quoting keeps a name that reads like an instruction a name.
  const named = (meta: DocumentMeta, detail = "") => `${JSON.stringify(meta.name)} (document_id ${meta.id}${detail})`;
  const guide: string[] = [];
  if (searchable.length > 0) {
    guide.push(
      `Some attached files are too large for your context: ${searchable.map((meta) => named(meta)).join("; ")}.`,
      "You see only a summary card for each. Read them through the tools:",
      "- search_document finds lines (exact or regex) or the most relevant passages (keywords).",
      "- To count or list what can be matched as text (a word, an ID, an error code, a log level, a pattern), use search_document in exact or regex mode: its total_matching_lines is exact.",
      "- read_document reads a line range. Read around search hits before you rely on them.",
      "- get_document_overview returns the outline, log profile, and the start and end of a file.",
      ...(wholeReads ? ["- analyze_whole_document reads the entire file in parts. Use it only when the task needs all of the file and cannot be done by matching text: a full summary, a timeline, or items that must be judged by meaning. It is slow and costly, and it can miss items of a long list."] : []),
      "You have a limited number of tool turns. Call several tools in the same turn when the searches do not depend on each other, and answer as soon as you have enough evidence.",
      "Base your answer on text you actually read. Cite line numbers like (app.log L1203). If the tools did not find something, say so rather than guessing.",
    );
  }
  if (viewable.length > 0) {
    guide.push(
      `The text of a PDF does not show its pictures, charts or diagrams. You can look at the real pages of these PDFs with view_pages: ${viewable.map((meta) => named(meta, meta.pages ? `, ${meta.pages} ${meta.pages === 1 ? "page" : "pages"}` : "")).join("; ")}.`,
      "- Use view_pages when the answer depends on a picture, photo, chart, diagram, map, handwriting, a stamp or signature, or on how a page is laid out. A page is worth a look when its text says it has a picture or has no text, or mentions a figure.",
      "- Page numbers are the N of the \"--- Page N ---\" lines in the text. Ask only for the pages you need: you have a limited number of tool turns.",
      "- Do not use view_pages to read text, and do not describe a picture you have not looked at. If you could not look at a page, say so.",
    );
  }
  return guide.join("\n");
}
