import { analyzeWholeDocument, splitIntoParts } from "./map-reduce.js";
import { cutPdfPages } from "./pdf-pages.js";
import { grep, rankPassages, type SearchableDocument } from "./search.js";
import { formatBytes, outlineLines, REQUEST_BYTES_MARGIN } from "./plan.js";
import type { Budget, GenerateText, ProgressListener, ToolDeclaration, ToolFileLimits, ToolOutput, ToolResult, ToolSet } from "./types.js";

const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 600;
/** The most pages one `view_pages` call shows. A page costs a model about 530 tokens. */
export const MAX_VIEW_PAGES = 5;
/** Below this, no page fits: a cut of one page of plain text is larger. */
const MIN_FILE_BYTES = 1_024;

export const TOOL_NAMES = {
  search: "search_document",
  read: "read_document",
  overview: "get_document_overview",
  analyze: "analyze_whole_document",
  view: "view_pages",
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
  view: {
    name: TOOL_NAMES.view,
    description: `Look at pages of an attached PDF as they are printed. Use it when the answer depends on something the text of the file cannot show: a picture, photo, chart, diagram, map, handwriting, a stamp or signature, or how a page is laid out. It is not for reading text. Up to ${MAX_VIEW_PAGES} pages per call.`,
    parameters: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "The document_id of the PDF." },
        from_page: { type: "integer", description: "First page to look at (1-based, the N of the \"--- Page N ---\" lines in the text)." },
        to_page: { type: "integer", description: "Last page to look at. Defaults to from_page." },
      },
      required: ["document_id", "from_page"],
    },
  },
};

/** Says so when a tool that returns files is run through `execute`, which has nowhere to put them. */
const FILES_NOT_DELIVERED = "The pages could not be shown: this application does not pass files from tools to the model. Answer from the text.";

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  // The fallback is clamped too: a default end line must not point past the end of the file.
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(number) ? number : fallback)));
}

const INCOMPLETE_ANALYSIS = "Incomplete: the model's output limit was reached, so some relevant items are missing from this answer. Tell the user it is incomplete. For a complete list or an exact count, use search_document in exact or regex mode (it returns total_matching_lines), or ask about a narrower part of the file.";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

/** A page number given by the model. Unlike a line number it is not clamped: a wrong page is a wrong picture. */
function pageNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || Math.trunc(number) < 1) throw new Error(`${name} must be a page number: 1 or higher.`);
  return Math.trunc(number);
}

const pageRange = (from: number, to: number): string => (to > from ? `${from}-${to}` : String(from));

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
  if (typeof result.parts_read === "number") {
    const incomplete = result.notes_cut_short || result.answer_cut_short ? ", incomplete" : "";
    return ` — ${result.parts_read} parts, ${String(result.parts_with_relevant_content ?? 0)} relevant${incomplete}`;
  }
  // A read reports its range only when it was cut short of what was asked.
  if (typeof result.lines === "string" && typeof result.total_lines === "number") return label.endsWith(result.lines) ? "" : ` — got ${result.lines}`;
  // So does a look at pages.
  if (typeof result.pages === "string" && typeof result.total_pages === "number") {
    return label.endsWith(` ${result.pages}`) ? "" : ` — got ${result.pages.includes("-") ? "pages" : "page"} ${result.pages}`;
  }
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
  /**
   * PDFs whose pages `view_pages` may show. The tool is declared only when there is at least one
   * and `loadOriginal` is given. They need not be among `documentIds`: a PDF whose text is in the
   * prompt has nothing to search, but its pages can still be looked at.
   */
  viewableIds?: string[];
  /** Loads the uploaded file of a document, for `view_pages`. */
  loadOriginal?(documentId: string): Promise<Uint8Array | undefined>;
}): ToolSet {
  const allowed = new Set(options.documentIds);
  const viewable = new Set(options.loadOriginal ? options.viewableIds ?? [] : []);
  const names = new Map<string, string>(Object.entries(options.names ?? {}));
  // The text tools are left out only when there are pages to look at and no document to search.
  const textTools = allowed.size > 0 || viewable.size === 0;
  const declarations = [
    ...(textTools ? [DECLARATIONS.search, DECLARATIONS.read, DECLARATIONS.overview, ...(options.generate ? [DECLARATIONS.analyze] : [])] : []),
    ...(viewable.size > 0 ? [DECLARATIONS.view] : []),
  ];
  const known = new Set(declarations.map((declaration) => declaration.name));
  const limit = options.budget.toolResultCharacters;
  // When no limit is given with a call: three eighths of a request, so that two looks still fit.
  const defaultFileBytes = Math.floor((options.budget.maxRequestBytes - REQUEST_BYTES_MARGIN) * 3 / 8);

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
      // Page numbers are added only for a PDF whose pages can be looked at: they are what
      // view_pages takes. Everything else gets the results of 0.2.0 unchanged.
      const paged = viewable.has(document.meta.id);
      if (mode === "keywords") {
        const topK = integer(args.max_results, 5, 1, 10);
        const ranked = rankPassages(document, query, topK);
        return fit({
          document: document.meta.name,
          mode,
          passages: ranked.map((passage) => {
            const pages = paged ? document.pagesOfLines(passage.from, passage.to) : undefined;
            return {
              lines: `${passage.from}-${passage.to}`,
              ...(pages ? { pages } : {}),
              score: passage.score,
              text: document.lines.numbered(passage.from, passage.to),
            };
          }),
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
        matches: paged ? result.matches.map(({ line, ...rest }) => {
          const page = document.pageOfLine(line);
          return { line, ...(page ? { page } : {}), ...rest };
        }) : result.matches,
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
      const pages = viewable.has(document.meta.id) ? document.pagesOfLines(start, to) : undefined;
      return {
        document: document.meta.name,
        lines: `${start}-${to}`,
        ...(pages ? { pages } : {}),
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
      const notesCutShort = result.truncatedParts + result.truncatedMerges;
      return fit({
        document: document.meta.name,
        parts_read: result.parts,
        parts_with_relevant_content: result.relevantParts,
        ...(result.failedParts ? { parts_that_failed: result.failedParts } : {}),
        ...(notesCutShort ? { notes_cut_short: notesCutShort } : {}),
        ...(result.answerTruncated ? { answer_cut_short: true } : {}),
        ...(notesCutShort || result.answerTruncated ? { note: INCOMPLETE_ANALYSIS } : {}),
        answer: result.answer,
      }, null, Math.max(limit, 40_000));
    },
  };

  /** `view_pages`: the pages as one small PDF, next to a short JSON result. */
  async function viewPages(args: Record<string, unknown>, limits: ToolFileLimits): Promise<ToolOutput> {
    const id = text(args.document_id, "document_id");
    // The same scope check as the text tools, on its own list: a PDF can be looked at without
    // being searchable, and the other way round.
    if (!viewable.has(id)) {
      throw new Error(allowed.has(id)
        ? `The pages of ${names.get(id) ?? id} cannot be shown: only its text was kept. Answer from the text.`
        : `Unknown document_id ${id}. Use the document_id of an attached PDF.`);
    }
    const document = await options.load(id);
    if (!document) throw new Error(`${id} is no longer available on the server. Ask the user to attach the file again.`);
    const file = document.meta.name;
    names.set(id, file);
    const from = pageNumber(args.from_page, "from_page");
    const asked = args.to_page === undefined || args.to_page === null ? from : pageNumber(args.to_page, "to_page");
    if (asked < from) throw new Error(`to_page (${asked}) is before from_page (${from}).`);
    const total = document.meta.pages;
    if (total && from > total) throw new Error(`${file} has ${total} ${total === 1 ? "page" : "pages"}. There is no page ${from}.`);
    const whole = (value: number | undefined, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback);
    const mostPages = Math.min(MAX_VIEW_PAGES, whole(limits.maxPages, MAX_VIEW_PAGES));
    if (mostPages < 1) throw new Error("No more pages can be looked at for this question. Answer from the pages and the text you already have.");
    const maxBytes = whole(limits.maxFileBytes, defaultFileBytes);
    if (maxBytes < MIN_FILE_BYTES) throw new Error("There is no room left in this request to show more pages. Answer from the pages and the text you already have.");
    const original = await options.loadOriginal!(id);
    if (!original) throw new Error(`The original file of ${file} is no longer on the server, so its pages cannot be shown. Answer from the text.`);
    let cut;
    try {
      cut = await cutPdfPages(original, from, Math.min(asked, from + mostPages - 1), maxBytes, total);
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pages = pageRange(cut.from, cut.to);
    const shown = cut.to - cut.from + 1;
    // What was asked for, as far as the file goes.
    const wanted = Math.min(asked, cut.pageCount);
    const showing = `Showing ${shown} of the ${wanted - cut.from + 1} pages asked for`;
    const again = `Call view_pages from page ${cut.to + 1} if you need them.`;
    const rest: ToolResult = cut.to >= wanted ? {}
      : shown < mostPages ? { next_page: cut.to + 1, note: `${showing}: the others did not fit in this request. ${again}` }
        : mostPages < MAX_VIEW_PAGES ? { note: `${showing}: no more pages can be looked at for this question.` }
          : { next_page: cut.to + 1, note: `${showing}: one call shows at most ${MAX_VIEW_PAGES}. ${again}` };
    const name = `pages-${pages}.pdf`;
    return {
      result: { document: file, pages, total_pages: cut.pageCount, file: name, ...rest },
      files: [{ name, mimeType: "application/pdf", bytes: cut.bytes }],
    };
  }

  const failure = (error: unknown): ToolResult => ({ error: error instanceof Error ? error.message : String(error) });

  async function execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!known.has(name)) return { error: `Unknown tool ${name}.` };
    // The pages are a file, and this method returns only JSON. Saying that pages are attached
    // with nothing attached would be worse than saying that they could not be shown.
    if (name === TOOL_NAMES.view) return { error: FILES_NOT_DELIVERED };
    try {
      return await handlers[name]!(args);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return failure(error);
    }
  }

  return {
    declarations,
    has: (name) => known.has(name),
    execute,
    async executeWithFiles(name, args, limits = {}) {
      if (name !== TOOL_NAMES.view || !known.has(name)) return { result: await execute(name, args), files: [] };
      try {
        return await viewPages(args, limits);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { result: failure(error), files: [] };
      }
    },
    describe(name, args) {
      const id = typeof args.document_id === "string" ? args.document_id : "";
      const file = names.get(id) ?? "the file";
      if (name === TOOL_NAMES.view) {
        const from = integer(args.from_page, 1, 1, Number.MAX_SAFE_INTEGER);
        const to = typeof args.to_page === "number" && args.to_page > from ? Math.trunc(args.to_page) : from;
        return `Look at ${file} ${to > from ? "pages" : "page"} ${pageRange(from, to)}`;
      }
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
