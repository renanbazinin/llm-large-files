import type { Budget, DocumentMeta, DocumentPlan, OutlineEntry } from "./types.js";
import type { SearchableDocument } from "./search.js";

/** Bytes kept free for document cards, the tool declarations, and JSON framing. */
const REQUEST_BYTES_MARGIN = 256 * 1024;
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
  const top = Math.min(...outline.map((entry) => entry.level));
  return outline.map((entry) => `L${entry.line} ${"  ".repeat(entry.level - top)}${entry.title}`);
}

export function renderInline(document: SearchableDocument): string {
  const { meta } = document;
  return `--- Attached file: ${meta.name} (${meta.format}, ${meta.lines.toLocaleString("en-US")} lines) ---\n${document.text}\n--- End attached file: ${meta.name} ---`;
}

/** A compact stand-in for a document that is too large for the prompt. */
export function renderCard(document: SearchableDocument): string {
  const { meta } = document;
  const out = [
    `--- Large attached file: ${meta.name} ---`,
    `document_id: ${meta.id}`,
    `${meta.format} · ${formatBytes(meta.bytes)} · ${meta.lines.toLocaleString("en-US")} lines${meta.pages ? ` · ${meta.pages} pages` : ""} · about ${formatCount(meta.estimatedTokens)} tokens`,
    "This file is NOT in your context. Use the document tools to search it, read line ranges, or analyze all of it.",
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
  out.push(`First lines:`, document.lines.numbered(1, CARD_HEAD_LINES).split("\n").map((line) => `  ${line.slice(0, 300)}`).join("\n"));
  out.push(`--- End large attached file: ${meta.name} ---`);
  return out.join("\n");
}

export function documentToolsInstruction(searchable: DocumentMeta[]): string {
  if (searchable.length === 0) return "";
  const names = searchable.map((meta) => `${meta.name} (document_id ${meta.id})`).join("; ");
  return [
    `Some attached files are too large for your context: ${names}.`,
    "You see only a summary card for each. Read them through the tools:",
    "- search_document finds lines (exact or regex) or the most relevant passages (keywords).",
    "- read_document reads a line range. Read around search hits before you rely on them.",
    "- get_document_overview returns the outline, log profile, and the start and end of a file.",
    "- analyze_whole_document reads the entire file in parts. Use it only when the task needs all of it (a full summary, every occurrence, a timeline). It is slow and costly.",
    "You have a limited number of tool turns. Call several tools in the same turn when the searches do not depend on each other, and answer as soon as you have enough evidence.",
    "Base your answer on text you actually read. Cite line numbers like (app.log L1203). If the tools did not find something, say so rather than guessing.",
  ].join("\n");
}
