import { analyzeWholeDocument, splitIntoParts } from "./map-reduce.js";
import { grep, rankPassages, type SearchableDocument } from "./search.js";
import { formatBytes, outlineLines } from "./plan.js";
import type { Budget, GenerateText, ProgressListener, ToolDeclaration, ToolResult, ToolSet } from "./types.js";

const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 600;

export const TOOL_NAMES = {
  search: "search_document",
  read: "read_document",
  overview: "get_document_overview",
  analyze: "analyze_whole_document",
} as const;

const documentId = { type: "string" as const, description: "The document_id from the file's card." };

const DECLARATIONS: Record<keyof typeof TOOL_NAMES, ToolDeclaration> = {
  search: {
    name: TOOL_NAMES.search,
    description: "Search a large attached file. mode \"keywords\" returns the most relevant passages for a question; \"exact\" returns every line containing the text; \"regex\" returns lines matching a JavaScript regular expression. Results include line numbers to read further with read_document.",
    parameters: {
      type: "object",
      properties: {
        document_id: documentId,
        query: { type: "string", description: "Keywords, exact text, or a regex, depending on mode." },
        mode: { type: "string", enum: ["keywords", "exact", "regex"], description: "Defaults to keywords." },
        max_results: { type: "integer", description: "Up to 50 for exact/regex (default 20), up to 10 passages for keywords (default 5)." },
        context_lines: { type: "integer", description: "exact/regex only: lines to show before and after each match, 0-5." },
        case_sensitive: { type: "boolean", description: "exact/regex only. Defaults to false." },
      },
      required: ["document_id", "query"],
    },
  },
  read: {
    name: TOOL_NAMES.read,
    description: `Read a range of lines from a large attached file, with line numbers. Up to ${MAX_READ_LINES} lines per call; long results are cut and tell you where to continue.`,
    parameters: {
      type: "object",
      properties: {
        document_id: documentId,
        start_line: { type: "integer", description: "First line to read (1-based)." },
        end_line: { type: "integer", description: `Last line to read. Defaults to start_line + ${DEFAULT_READ_LINES - 1}.` },
      },
      required: ["document_id", "start_line"],
    },
  },
  overview: {
    name: TOOL_NAMES.overview,
    description: "Get the full outline (headings with line numbers), log profile (levels, time range, most frequent errors), and the first and last lines of a large attached file.",
    parameters: { type: "object", properties: { document_id: documentId }, required: ["document_id"] },
  },
  analyze: {
    name: TOOL_NAMES.analyze,
    description: "Read an entire large file in parts and answer a task that needs all of it, such as a full summary, a timeline, or every occurrence of something. Slow and costly: prefer search_document and read_document for specific questions.",
    parameters: {
      type: "object",
      properties: {
        document_id: documentId,
        task: { type: "string", description: "What to find or produce from the whole file, stated completely." },
      },
      required: ["document_id", "task"],
    },
  },
};

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

/** Trims a result to the character budget by dropping trailing list entries, then cutting text. */
function fit(result: ToolResult, listKey: string | null, limit: number): ToolResult {
  if (JSON.stringify(result).length <= limit) return result;
  const list = listKey ? result[listKey] : undefined;
  if (Array.isArray(list)) {
    const kept = [...list];
    const note = () => `Showing ${kept.length} of ${list.length} results to stay within the size limit. Narrow the query or read specific lines.`;
    const trimmed = () => ({ ...result, [listKey!]: kept, note: note() });
    while (kept.length > 1 && JSON.stringify(trimmed()).length > limit) kept.pop();
    if (JSON.stringify(trimmed()).length <= limit) return trimmed();
  }
  // Last resort: a raw prefix. Escaping grows the text, so shrink until the whole result fits.
  const serialized = JSON.stringify(result);
  let size = limit;
  let cut: ToolResult;
  do {
    size = Math.floor(size * 0.85);
    cut = { truncated: true, partial: serialized.slice(0, size), note: "Result cut to the size limit. Ask for a smaller range." };
  } while (JSON.stringify(cut).length > limit && size > 100);
  return cut;
}

/**
 * What a finished tool call found, as a suffix for its `describe()` label, for a steps list:
 * "Search app.log (exact) for “timeout”" + " — 12 matching lines".
 */
export function toolResultSummary(label: string, result: ToolResult): string {
  if (typeof result.error === "string") return ` — failed: ${result.error}`;
  if (typeof result.total_matching_lines === "number") return ` — ${result.total_matching_lines.toLocaleString("en-US")} matching lines`;
  if (Array.isArray(result.passages)) return ` — ${result.passages.length} passages`;
  if (typeof result.parts_read === "number") return ` — ${result.parts_read} parts, ${String(result.parts_with_relevant_content ?? 0)} relevant`;
  // A read reports its range only when it was cut short of what was asked.
  if (typeof result.lines === "string" && typeof result.total_lines === "number") return label.endsWith(result.lines) ? "" : ` — got ${result.lines}`;
  return "";
}

export function createDocumentTools(options: {
  /** Loads a document the tools may access. Return undefined for anything out of scope. */
  load(documentId: string): Promise<SearchableDocument | undefined>;
  documentIds: string[];
  /** File names by document ID, so `describe` can name files before they are loaded. */
  names?: Record<string, string>;
  budget: Budget;
  generate?: GenerateText;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
}): ToolSet {
  const allowed = new Set(options.documentIds);
  const names = new Map<string, string>(Object.entries(options.names ?? {}));
  const declarations = [DECLARATIONS.search, DECLARATIONS.read, DECLARATIONS.overview, ...(options.generate ? [DECLARATIONS.analyze] : [])];
  const known = new Set(declarations.map((declaration) => declaration.name));
  const limit = options.budget.toolResultCharacters;

  async function documentFor(args: Record<string, unknown>): Promise<SearchableDocument> {
    const id = text(args.document_id, "document_id");
    // Scope check: a model can only reach files attached to this conversation.
    if (!allowed.has(id)) throw new Error(`Unknown document_id ${id}. Use an ID from a file card.`);
    const document = await options.load(id);
    if (!document) throw new Error(`${id} is no longer available on the server. Ask the user to attach the file again.`);
    names.set(id, document.meta.name);
    return document;
  }

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
    async [TOOL_NAMES.search](args) {
      const document = await documentFor(args);
      const query = text(args.query, "query");
      const mode = args.mode === "exact" || args.mode === "regex" ? args.mode : "keywords";
      if (mode === "keywords") {
        const topK = integer(args.max_results, 5, 1, 10);
        const ranked = rankPassages(document, query, topK);
        return fit({
          document: document.meta.name,
          mode,
          passages: ranked.map((passage) => ({
            lines: `${passage.from}-${passage.to}`,
            score: passage.score,
            text: document.lines.numbered(passage.from, passage.to),
          })),
          ...(ranked.length === 0 ? { note: "No passage contains these keywords. Try other words, synonyms, or exact mode." } : {}),
        }, "passages", limit);
      }
      const result = grep(document, query, {
        regex: mode === "regex",
        caseSensitive: args.case_sensitive === true,
        maxResults: integer(args.max_results, 20, 1, 50),
        contextLines: integer(args.context_lines, 0, 0, 5),
      });
      return fit({
        document: document.meta.name,
        mode,
        total_matching_lines: result.totalMatchingLines,
        ...(result.stoppedEarly ? { note: "The scan stopped early; the total is a lower bound." } : {}),
        matches: result.matches,
      }, "matches", limit);
    },

    async [TOOL_NAMES.read](args) {
      const document = await documentFor(args);
      const total = document.lines.lineCount;
      const start = integer(args.start_line, 1, 1, total);
      const end = integer(args.end_line, start + DEFAULT_READ_LINES - 1, start, Math.min(total, start + MAX_READ_LINES - 1));
      let to = end;
      let body = document.lines.numbered(start, to);
      while (body.length > limit - 500 && to > start) {
        to = start + Math.max(0, Math.floor((to - start) * 0.7));
        body = document.lines.numbered(start, to);
      }
      return {
        document: document.meta.name,
        lines: `${start}-${to}`,
        total_lines: total,
        text: body.slice(0, limit - 500),
        ...(to < total ? { next_start_line: to + 1 } : { note: "End of file." }),
      };
    },

    async [TOOL_NAMES.overview](args) {
      const document = await documentFor(args);
      const { meta, lines } = document;
      const tail = Math.max(1, lines.lineCount - 19);
      return fit({
        document: meta.name,
        format: meta.format,
        size: formatBytes(meta.bytes),
        lines: meta.lines,
        estimated_tokens: meta.estimatedTokens,
        ...(meta.pages ? { pages: meta.pages } : {}),
        parts_for_whole_document_analysis: splitIntoParts(document, options.budget).length,
        ...(meta.logProfile ? { log_profile: meta.logProfile } : {}),
        first_lines: lines.numbered(1, Math.min(30, lines.lineCount)),
        last_lines: lines.lineCount > 30 ? lines.numbered(tail, lines.lineCount) : "",
        outline: meta.outline.length ? outlineLines(meta.outline) : [],
      }, "outline", limit);
    },

    async [TOOL_NAMES.analyze](args) {
      if (!options.generate) throw new Error("Whole-document analysis is not enabled.");
      const document = await documentFor(args);
      const task = text(args.task, "task");
      const result = await analyzeWholeDocument({
        document,
        task,
        generate: options.generate,
        budget: options.budget,
        onProgress: options.onProgress,
        signal: options.signal,
      });
      return fit({
        document: document.meta.name,
        parts_read: result.parts,
        parts_with_relevant_content: result.relevantParts,
        ...(result.failedParts ? { parts_that_failed: result.failedParts } : {}),
        answer: result.answer,
      }, null, Math.max(limit, 40_000));
    },
  };

  return {
    declarations,
    has: (name) => known.has(name),
    async execute(name, args) {
      if (!known.has(name)) return { error: `Unknown tool ${name}.` };
      try {
        return await handlers[name]!(args);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    describe(name, args) {
      const id = typeof args.document_id === "string" ? args.document_id : "";
      const file = names.get(id) ?? "the file";
      if (name === TOOL_NAMES.search) {
        const mode = args.mode === "exact" || args.mode === "regex" ? args.mode : "keywords";
        return `Search ${file} (${mode}) for “${String(args.query ?? "").slice(0, 80)}”`;
      }
      if (name === TOOL_NAMES.read) {
        const start = integer(args.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
        const end = typeof args.end_line === "number" && args.end_line >= start ? `-${Math.trunc(args.end_line)}` : "";
        return `Read ${file} lines ${start}${end}`;
      }
      if (name === TOOL_NAMES.overview) return `Overview of ${file}`;
      if (name === TOOL_NAMES.analyze) return `Read all of ${file} for “${String(args.task ?? "").slice(0, 100)}”`;
      return name;
    },
  };
}
