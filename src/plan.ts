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
    const bytes = Math.ceil(meta.textBytes * 1.08) + 200;
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

export function renderInline(meta: DocumentMeta, text: string): string {
  return `--- Attached file: ${meta.name} (${meta.format}, ${meta.lines.toLocaleString("en-US")} lines) ---\n${text}\n--- End attached file: ${meta.name} ---`;
}

/** How many lines of a file its card shows. */
export const CARD_LINES = CARD_HEAD_LINES;

/**
 * A compact stand-in for a document that is too large for the prompt. `head` is its first
 * `CARD_LINES` lines, numbered. `viewable` adds a line saying that its pages can be looked at
 * with `view_pages`.
 */
export function renderCard(meta: DocumentMeta, head: string, viewable = false): string {
  const out = [
    `--- Large attached file: ${meta.name} ---`,
    `document_id: ${meta.id}`,
    `${meta.format} · ${formatBytes(meta.bytes)} · ${meta.lines.toLocaleString("en-US")} lines${meta.pages ? ` · ${meta.pages} pages` : ""} · about ${formatCount(meta.estimatedTokens)} tokens`,
    "This file is NOT in your context. Use the document tools to search it, read line ranges, or analyze all of it.",
    ...(viewable ? ["Its text cannot show pictures. To see a picture, a chart or the layout of a page, look at the page with view_pages."] : []),
  ];
  const profile = meta.logProfile;
  if (profile) {
    const levels = Object.entries(profile.levels).map(([level, count]) => `${level} ${count.toLocaleString("en-US")}`).join(", ");
    if (levels) out.push(`Log levels: ${levels}`);
    if (profile.firstTimestamp) out.push(`Time range: ${profile.firstTimestamp} → ${profile.lastTimestamp ?? profile.firstTimestamp}`);
    if (profile.topIssues.length) {
      out.push("Most frequent problems (count, first line):");
      for (const issue of profile.topIssues.slice(0, 8)) out.push(`  [${issue.level} ×${issue.count}, L${issue.firstLine}] ${issue.template}`);
    }
  }
  if (meta.outline.length) {
    out.push(`Outline (${Math.min(meta.outline.length, CARD_OUTLINE_ENTRIES)} of ${meta.outline.length} headings):`);
    out.push(...outlineLines(meta.outline.slice(0, CARD_OUTLINE_ENTRIES)).map((line) => `  ${line}`));
  }
  out.push(`First lines:`, head.split("\n").map((line) => `  ${line.slice(0, 300)}`).join("\n"));
  out.push(`--- End large attached file: ${meta.name} ---`);
  return out.join("\n");
}

/**
 * The tool guide for the system prompt. `searchable` are the files the model reads through the
 * text tools. `viewable` are the PDFs whose pages it can look at with `view_pages`: some of them
 * may be searchable, and some may have their whole text in the prompt.
 */
export function documentToolsInstruction(searchable: DocumentMeta[], viewable: DocumentMeta[] = []): string {
  // File names come from uploads. Quoting keeps a name that reads like an instruction a name.
  const named = (meta: DocumentMeta, detail = "") => `${JSON.stringify(meta.name)} (document_id ${meta.id}${detail})`;
  const guide: string[] = [];
  if (searchable.length > 0) {
    guide.push(
      `Some attached files are too large for your context: ${searchable.map((meta) => named(meta)).join("; ")}.`,
      "You see only a summary card for each. Read them through the tools:",
      "- search_document finds lines (exact or regex) or the most relevant passages (keywords).",
      "- read_document reads a line range. Read around search hits before you rely on them.",
      "- get_document_overview returns the outline, log profile, and the start and end of a file.",
      "- analyze_whole_document reads the entire file in parts. Use it only when the task needs all of it (a full summary, every occurrence, a timeline). It is slow and costly.",
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
