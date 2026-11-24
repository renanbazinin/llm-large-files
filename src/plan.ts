import { pageList } from "./quality.js";
import { numberLines } from "./search.js";
import { plural, sliceWhole, wellFormed } from "./text.js";
import type { Budget, DocumentFormat, DocumentMeta, DocumentPlan, OutlineEntry, ToolName } from "./types.js";

/** Formats whose documents may hold a table that `aggregate_table` reads. */
export const TABLE_FORMATS: ReadonlySet<DocumentFormat> = new Set<DocumentFormat>(["csv", "xlsx", "docx", "pptx", "pdf", "html", "markdown"]);

/** Bytes kept free for document cards, the tool declarations, and JSON framing. */
export const REQUEST_BYTES_MARGIN = 256 * 1024;
const CARD_HEAD_LINES = 25;
const CARD_OUTLINE_ENTRIES = 40;

/**
 * How planning places documents besides their size (`planDocuments`). New in 0.10.0: without it,
 * the plan is that of 0.9.
 */
export type PlanOptions = {
  /** Count each document at its size with its lines numbered (`numberedSize`), as it is then sent. */
  numbered?: boolean;
  /**
   * The IDs of documents sent whole in earlier questions, in the order they were first placed
   * (`PlacementState.inline`): placed first, in that order, each while it fits. One that does not
   * fit is searched, and leaves its room to the others.
   */
  pinned?: readonly string[];
  /** The IDs of documents searched in earlier questions (`PlacementState.cards`): they stay searched. */
  cards?: readonly string[];
};

/**
 * Decides which documents go into the prompt in full and which the model reaches through
 * tools. Smaller documents are inlined first, so as many as possible are read in full. Since
 * 0.10.0, `options` can count them with their lines numbered, keep documents in the place they
 * had in earlier questions, and so on (`PlanOptions`). Both lists are in order of size, smallest
 * first, as before.
 */
export function planDocuments(
  documents: DocumentMeta[],
  budget: Budget,
  base: { tokens: number; bytes: number },
  options: PlanOptions = {},
): DocumentPlan {
  const tokenRoom = Math.min(budget.inlineTokens, budget.contextTokens - budget.reservedTokens - base.tokens);
  const byteRoom = budget.maxRequestBytes - REQUEST_BYTES_MARGIN - base.bytes;
  const sorted = [...documents].sort((left, right) => left.estimatedTokens - right.estimatedTokens);
  const pinned = new Set(options.pinned ?? []);
  const cards = new Set((options.cards ?? []).filter((id) => !pinned.has(id)));
  const inline = new Set<string>();
  let tokens = 0;
  let bytes = 0;
  const place = (meta: DocumentMeta) => {
    const size = inlineSize(meta, options.numbered === true);
    if (tokens + size.tokens <= tokenRoom && bytes + size.bytes <= byteRoom) {
      inline.add(meta.id);
      tokens += size.tokens;
      bytes += size.bytes;
    }
  };
  const byId = new Map(documents.map((meta) => [meta.id, meta]));
  for (const id of pinned) {
    const meta = byId.get(id);
    if (meta && !inline.has(id)) place(meta);
  }
  for (const meta of sorted) if (!pinned.has(meta.id) && !cards.has(meta.id)) place(meta);
  return {
    inline: sorted.filter((meta) => inline.has(meta.id)),
    searchable: sorted.filter((meta) => !inline.has(meta.id)),
    inlineTokens: tokens,
    inlineBytes: bytes,
  };
}

/**
 * What a document sent whole takes of the request: its tokens, and its bytes with 200 for its
 * frame. `numbered` counts its line numbers too (`numberedSize`), rounded up.
 */
function inlineSize(meta: DocumentMeta, numbered: boolean): { tokens: number; bytes: number } {
  if (!numbered) return { tokens: meta.estimatedTokens, bytes: (meta.jsonBytes ?? Math.ceil(meta.textBytes * 1.08)) + 200 };
  const size = numberedSize(meta);
  return { tokens: Math.ceil(size.tokens), bytes: Math.ceil(size.bytes) + 200 };
}

/** The digits of the numbers 1 to `count`, written out: what the line numbers of a text take. */
function digitsUpTo(count: number): number {
  let digits = 0;
  for (let width = 1, first = 1; first <= count; width++, first *= 10) digits += (Math.min(count, first * 10 - 1) - first + 1) * width;
  return digits;
}

/**
 * The size of a document's text with its lines numbered (`12345| `), as the tools show it and as
 * `numberInline` sends it, from its metadata alone: about 1.2 tokens a digit and one for the bar,
 * and half a token more for each line's estimate, which is rounded up; in bytes, the digits and
 * four more a line. About 8% to 16% more tokens than the text alone: 15.5% for a CSV of short
 * rows, 9.4% for a service log, 8.4% for Hebrew prose. New in 0.10.0.
 */
export function numberedSize(meta: Pick<DocumentMeta, "estimatedTokens" | "lines" | "textBytes" | "jsonBytes">): { tokens: number; bytes: number } {
  const lines = Math.max(1, meta.lines);
  const digits = digitsUpTo(lines);
  return {
    tokens: meta.estimatedTokens + 1.2 * digits + 1.5 * lines,
    bytes: (meta.jsonBytes ?? meta.textBytes * 1.08) + digits + 4 * lines,
  };
}

/**
 * About how many parts a whole-document read of a document takes, from its metadata alone:
 * counting them exactly means reading the whole text. In the prompt every line carries its number
 * (`numberedSize`). A part ends at the end of a line, so it is short of full by half a line on
 * average. On logs, prose, tables and blank-heavy text this lands within a few percent of the count.
 */
export function estimateParts(meta: Pick<DocumentMeta, "estimatedTokens" | "lines" | "textBytes" | "jsonBytes">, budget: Budget): number {
  const lines = Math.max(1, meta.lines);
  const { tokens, bytes } = numberedSize(meta);
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

/**
 * A count of tokens as a card shows it: "9,999", "10K", "1.0M". A count that rounds to 1,000K is
 * written in millions (since 0.10.0: "1000K" before).
 */
export function formatCount(value: number): string {
  if (value >= 1_000_000 || Math.round(value / 1_000) >= 1_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString("en-US");
}

/**
 * A size in bytes: "512 B", "12 KB", "1.5 MB". A size that rounds to 1,024 KB is written in MB
 * (since 0.10.0: "1024 KB" before).
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 || Math.round(bytes / 1024) >= 1024) return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
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

/**
 * A text with its lines numbered as the tools number them ("12| text", by `numberLines`): a line
 * ends at "\n", and a newline at the very end does not start another line. What `numberInline`
 * puts between the frame lines of a file sent whole. New in 0.10.0.
 */
export function numberedText(text: string): string {
  if (text.length === 0) return "";
  return numberLines((text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"), 1);
}

/** A Markdown separator row, `| --- | :---: |`, as `aggregate_table` skips it. */
const SEPARATOR_ROW = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/**
 * Whether a text has at least `rows` rows of a `| cell | cell |` table, by the rule
 * `aggregate_table` reads them with: a line that starts and ends with "|", not counting the
 * separator rows of Markdown. It stops at the row that makes the count.
 */
export function hasPipeRows(text: string, rows = 3): boolean {
  let count = 0;
  for (let start = 0; start < text.length;) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end === -1 ? text.length : end).trim();
    if (line.length > 1 && line.startsWith("|") && line.endsWith("|") && !SEPARATOR_ROW.test(line) && ++count >= rows) return true;
    if (end === -1) break;
    start = end + 1;
  }
  return false;
}

/** How many `| cell |` rows make a document sent whole one whose tables the tools count (`toolable`). */
export const TOOLABLE_PIPE_ROWS = 3;

/**
 * Whether the tools can count the tables of a document sent whole (`PrepareOptions.inlineTables:
 * "tools"`): a CSV or a workbook always; a document of another format that `aggregate_table` reads
 * when its text has at least `TOOLABLE_PIPE_ROWS` rows of a `| cell |` table. New in 0.10.0.
 */
export function isToolable(format: DocumentFormat, text: string): boolean {
  if (format === "csv" || format === "xlsx") return true;
  return TABLE_FORMATS.has(format) && hasPipeRows(text, TOOLABLE_PIPE_ROWS);
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
    ...qualityLines(meta, viewable),
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

/** What the card says of the quality of a document's text (see `measureQuality`). */
function qualityLines(meta: DocumentMeta, viewable: boolean): string[] {
  const out: string[] = [];
  const look = viewable ? " Look at them with view_pages." : "";
  if (meta.pagesWithoutText?.length) out.push(`Pages without text (scans, photos or charts, whose content is not in the text): ${pageList(meta.pagesWithoutText)}.${look}`);
  if (meta.garbledPages?.length) out.push(`Pages whose text looks garbled, not to be relied on: ${pageList(meta.garbledPages)}.${look}`);
  if (meta.scripts?.length) out.push(`Written in: ${meta.scripts.map((share) => `${share.script} ${share.percent}%`).join(", ")}. Search in the language of the text.`);
  return out;
}

/** What the guides say of each text tool, the same in `documentToolsInstruction` and `toolGuide`. */
const SEARCH_LINES = [
  "- search_document finds lines (exact or regex) or the most relevant passages (keywords).",
  "- To count or list what can be matched as text (a word, an ID, an error code, a log level, a pattern), use search_document in exact or regex mode: its total_matching_lines is exact.",
  "- To count per group (per hour or day, per error code or ID with a regex group, per message shape), pass group_by: one call gives every count. For more matches than a result shows, search again from its next_from_line, or with order \"last\" for the last ones.",
  "- Search for the bare form of a word: a search matches inside longer words, so \"timeout\" also finds \"timeouts\", and a Hebrew word without its prefix letters (חוזה, not בחוזה) finds every form of it.",
];
const AGGREGATE_LINE = "- To add up, average, count or group the rows of a table (a CSV, an Excel sheet, a | cell | table), use aggregate_table: it reads every row, and its numbers are exact. Do not add numbers up from rows you read.";
const READ_LINE = "- read_document reads a line range. Read around search hits before you rely on them.";
const OVERVIEW_LINE = "- get_document_overview returns the outline, log profile, and the start and end of a file.";
const ANALYZE_LINE = "- analyze_whole_document reads the entire file in parts. Use it only when the task needs all of the file and cannot be done by matching text: a full summary, a timeline, or items that must be judged by meaning. It is slow and costly, and it can miss items of a long list.";
const EVIDENCE_LINE = "Base your answer on text you actually read. Cite line numbers like (app.log L1203). If the tools did not find something, say so rather than guessing.";
const VIEW_LINES = [
  "- Use view_pages when the answer depends on a picture, photo, chart, diagram, map, handwriting, a stamp or signature, or on how a page is laid out. A page is worth a look when its text says it has a picture or has no text, or mentions a figure.",
  "- Page numbers are the N of the \"--- Page N ---\" lines in the text. Ask only for the pages you need: you have a limited number of tool turns.",
  "- Do not use view_pages to read text, and do not describe a picture you have not looked at. If you could not look at a page, say so.",
];

/**
 * The tool guide for the system prompt. `searchable` are the files the model reads through the
 * text tools. `viewable` are the PDFs whose pages it can look at with `view_pages`: some of them
 * may be searchable, and some may have their whole text in the prompt. `wholeReads` is false when
 * the tools have no `analyze_whole_document`, or every searchable file is too large for it: the
 * guide then leaves it out. It names the files, so it changes when they do: `toolGuide` is the
 * guide that stays the same (0.10.0).
 */
export function documentToolsInstruction(searchable: DocumentMeta[], viewable: DocumentMeta[] = [], wholeReads = true): string {
  // File names come from uploads. Quoting keeps a name that reads like an instruction a name.
  const named = (meta: DocumentMeta, detail = "") => `${JSON.stringify(meta.name)} (document_id ${meta.id}${detail})`;
  const guide: string[] = [];
  if (searchable.length > 0) {
    guide.push(
      `Some attached files are too large for your context: ${searchable.map((meta) => named(meta)).join("; ")}.`,
      "You see only a summary card for each. Read them through the tools:",
      ...SEARCH_LINES,
      ...(searchable.some((meta) => TABLE_FORMATS.has(meta.format)) ? [AGGREGATE_LINE] : []),
      READ_LINE,
      OVERVIEW_LINE,
      ...(wholeReads ? [ANALYZE_LINE] : []),
      "You have a limited number of tool turns. Call several tools in the same turn when the searches do not depend on each other, and answer as soon as you have enough evidence.",
      EVIDENCE_LINE,
    );
  }
  if (viewable.length > 0) {
    guide.push(
      `The text of a PDF does not show its pictures, charts or diagrams. You can look at the real pages of these PDFs with view_pages: ${viewable.map((meta) => named(meta, meta.pages ? `, ${meta.pages} ${meta.pages === 1 ? "page" : "pages"}` : "")).join("; ")}.`,
      ...VIEW_LINES,
    );
  }
  return guide.join("\n");
}

/** The tools in the order a tool set declares them: search, read, overview, aggregate, analyze, view. New in 0.10.0. */
export const TOOL_ORDER: readonly ToolName[] = ["search_document", "read_document", "get_document_overview", "aggregate_table", "analyze_whole_document", "view_pages"];

/** `names` once each, in `TOOL_ORDER`; names that are not tools are left out. New in 0.10.0. */
export function toolsInOrder(names: Iterable<string>): ToolName[] {
  const given = new Set(names);
  return TOOL_ORDER.filter((name) => given.has(name));
}

/**
 * The tools a question needs, in `TOOL_ORDER`, as `files.tools` declares them for its documents:
 * for searched documents, search_document, read_document and get_document_overview, with
 * aggregate_table when one may hold a table, and analyze_whole_document when `wholeReads`; for
 * documents sent whole whose tables the tools count (`toolable`), search_document, read_document
 * and aggregate_table; and view_pages for PDFs whose pages can be shown. None when there is
 * nothing to search, count or look at. New in 0.10.0.
 */
export function questionTools(documents: { searchable: readonly DocumentMeta[]; toolable?: readonly DocumentMeta[]; viewable?: readonly DocumentMeta[] }, wholeReads: boolean): ToolName[] {
  const { searchable, toolable = [], viewable = [] } = documents;
  const names: ToolName[] = [];
  if (searchable.length > 0 || toolable.length > 0) names.push("search_document", "read_document");
  if (searchable.length > 0) names.push("get_document_overview");
  if (toolable.length > 0 || searchable.some((meta) => TABLE_FORMATS.has(meta.format))) names.push("aggregate_table");
  if (wholeReads && searchable.length > 0) names.push("analyze_whole_document");
  if (viewable.length > 0) names.push("view_pages");
  return toolsInOrder(names);
}

/**
 * The line of the system text, with tools, for the files sent whole whose tables the tools can
 * count (`PrepareOptions.inlineTables: "tools"`). New in 0.10.0.
 */
export const INLINE_TABLES_LINE = "Files shown in full can still be counted exactly: use aggregate_table for counts, sums and groups over their tables, and search_document exact for matching lines. In a spreadsheet, give the Row number when asked which row.";

/** The file name in `INLINE_CITATION_LINE`: an example, never the name of a real file. New in 0.10.0. */
export const CITATION_EXAMPLE_NAME = "report.docx";

/**
 * The line of the system text of a question without tools whose files sent whole have their
 * lines numbered (`numberInline`). Its file name is always `CITATION_EXAMPLE_NAME`, so that the
 * line is the same in every question. New in 0.10.0.
 */
export const INLINE_CITATION_LINE = `Cite line numbers like (${CITATION_EXAMPLE_NAME} L12).`;

/**
 * What `toolGuide` says of `analyze_whole_document`'s list of items (`output: "items"`). New in
 * 0.10.0.
 */
export const ITEMS_LINE = "- To find every item of a kind across a whole file (each penalty clause, each incident), call analyze_whole_document with output \"items\" and up to 12 short labels: it lists each item with its line and a quote, and code counts them, not a model.";

/** How `toolGuide` says that the tool turns are limited: the last one is marked, and no count is given. */
const TURNS_LINE = "You have a limited number of tool turns, and you are told when a turn is your last. Call several tools in the same turn when the searches do not depend on each other, and answer as soon as you have enough evidence.";

/**
 * The tool guide for the system text that stays the same from one question of a chat to the next
 * (`PreparedContext.guide`): it names no file and no document ID, and gives no count of turns, so
 * it changes only when `tools` does. The header lines of the blocks (`listingLine`) say which file
 * is shown in full and which is searched. `tools` are the tools declared, in any order.
 * `fullTables` adds `INLINE_TABLES_LINE` when aggregate_table is among them: the files sent whole
 * may have tables the tools count. `numberedInline` is for a question without tools whose files
 * sent whole have numbered lines: the guide is then `INLINE_CITATION_LINE`. Empty when there is
 * nothing to say. New in 0.10.0.
 */
export function toolGuide(tools: readonly ToolName[], context: { fullTables?: boolean; numberedInline?: boolean } = {}): string {
  const has = new Set(tools);
  if (has.size === 0) return context.numberedInline ? INLINE_CITATION_LINE : "";
  const guide: string[] = [];
  const textTools = TOOL_ORDER.some((name) => name !== "view_pages" && has.has(name));
  const fullTables = context.fullTables === true && has.has("aggregate_table");
  if (textTools) {
    // Files searched with the tools are there, or were in an earlier question: get_document_overview is declared only for them.
    const searched = has.has("get_document_overview");
    guide.push(
      searched
        ? "The files the file list marks \"searched with the tools\" are too large for your context: you see only a summary card for each. Read them through the tools:"
        : fullTables ? INLINE_TABLES_LINE : "Use the document tools:",
      ...(has.has("search_document") ? SEARCH_LINES : []),
      ...(has.has("aggregate_table") ? [AGGREGATE_LINE] : []),
      ...(has.has("read_document") ? [READ_LINE] : []),
      ...(searched ? [OVERVIEW_LINE] : []),
      ...(has.has("analyze_whole_document") ? [ANALYZE_LINE, ITEMS_LINE] : []),
      ...(searched && fullTables ? [INLINE_TABLES_LINE] : []),
      TURNS_LINE,
      EVIDENCE_LINE,
    );
  }
  if (has.has("view_pages")) {
    guide.push(
      "The text of a PDF does not show its pictures, charts or diagrams. You can look at the real pages of a PDF with view_pages: the file list gives the pages of each PDF whose pages can be shown.",
      ...VIEW_LINES,
    );
  }
  return guide.join("\n");
}

/** The first line of a header of blocks (`renderListing`). New in 0.10.0. */
export const LISTING_TITLE = "Attached files:";

/**
 * The header line of a document (`PreparedContext.listing`): its name, its document_id, whether
 * it is shown in full below or searched with the tools, its pages when `view_pages` can show them,
 * and the document it replaces: an earlier file of the same name. It is made from the metadata
 * and the place of the document alone, so it stays the same while they do. New in 0.10.0.
 */
export function listingLine(meta: DocumentMeta, place: { inline: boolean; viewable?: boolean; replaces?: string }): string {
  const pages = place.viewable && meta.pages ? `, ${meta.pages} ${plural(meta.pages, "page")}` : "";
  const replaces = place.replaces ? `; it replaces ${place.replaces}, an earlier file of the same name` : "";
  // The name comes from the upload: quoted, as in the frame of a file sent whole.
  return `- ${JSON.stringify(meta.name)} (document_id ${meta.id}${pages}): ${place.inline ? "shown in full below" : "searched with the tools"}${replaces}`;
}

/**
 * The header that starts a group of blocks: `LISTING_TITLE`, then the header lines of its
 * documents (`PreparedContext.listing`), in the order of the blocks. Empty for no lines. New in
 * 0.10.0.
 */
export function renderListing(lines: readonly string[]): string {
  return lines.length === 0 ? "" : [LISTING_TITLE, ...lines].join("\n");
}
