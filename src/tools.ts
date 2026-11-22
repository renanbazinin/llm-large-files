import { safeErrorMessage } from "./errors.js";
import { aggregateTable, FILTER_OPS, MAX_SHOWN_GROUPS, type AggregateRequest, type FilterOp } from "./aggregate.js";
import { GROUP_BY_VALUES, MAX_GROUP_KEYS, type GroupBy, type GroupResult } from "./groups.js";
import { analyzeWholeDocument, NothingReadError } from "./map-reduce.js";
import { cutPdfPages } from "./pdf-pages.js";
import { grepSource, numberLines, rankSource, REGEX_TIME_LIMIT_MS, type DocumentSource, type LineMatch } from "./search.js";
import { estimateParts, formatBytes, outlineLines, REQUEST_BYTES_MARGIN } from "./plan.js";
import type { RetryOptions } from "./retry.js";
import { plural, removeInvisible, sliceWhole, wellFormedJson } from "./text.js";
import type { Budget, GenerateText, ProgressListener, ToolCallHooks, ToolCallLimits, ToolDeclaration, ToolOutput, ToolResult, ToolSet } from "./types.js";

const DEFAULT_READ_LINES = 200;
/** Matching lines an exact or regex search shows: the default, and the most a call may ask for. */
const DEFAULT_GREP_RESULTS = 20;
const MAX_GREP_RESULTS = 50;
/** Groups a search with `group_by` shows: the default, and the most a call may ask for. */
const DEFAULT_GROUPS = 50;
const MAX_GROUPS = 200;
const MAX_READ_LINES = 600;
/** The most pages one `view_pages` call shows. A page costs a model about 530 tokens. */
export const MAX_VIEW_PAGES = 5;
/**
 * The time the regex searches of one tool set (one question, in `askWithFiles`) may take together,
 * unless `regexBudgetMs` says otherwise. An ordinary search of a 60 MB log takes about 0.15 s.
 */
export const REGEX_BUDGET_MS = 6_000;
/** Below this, no page fits: a cut of one page of plain text is larger. */
const MIN_FILE_BYTES = 1_024;
/** The answer of a whole-document read may be this long, when the cap on tool results is lower. */
const ANALYSIS_RESULT_CHARACTERS = 40_000;
/** A result is never cut below this, whatever room a caller names: less holds no line of a file. */
export const LEAST_RESULT_CHARACTERS = 600;
/**
 * How many times one document is read whole by the tools of one tool set (one question, in
 * `askWithFiles`), unless `maxWholeDocumentReads` says otherwise. One read of a large file is
 * up to `maxMapChunks` model requests.
 */
export const MAX_WHOLE_DOCUMENT_READS = 1;

export const TOOL_NAMES = {
  search: "search_document",
  read: "read_document",
  overview: "get_document_overview",
  analyze: "analyze_whole_document",
  view: "view_pages",
  aggregate: "aggregate_table",
} as const;

const documentId = { type: "string" as const, description: "The document_id from the file's card." };

const DECLARATIONS: Record<keyof typeof TOOL_NAMES, ToolDeclaration> = {
  search: {
    name: TOOL_NAMES.search,
    description: "Search a large attached file. mode \"keywords\" returns the most relevant passages for a question; \"exact\" finds the lines that contain the text; \"regex\" finds the lines that match a JavaScript regular expression (\\w and \\b know the letters of every language). For exact and regex, total_matching_lines counts every matching line, and the result shows the first max_results of them and the last one; search again from next_from_line for the ones after those shown, or with order \"last\" for the last ones. To count by group (per hour or day, per error code, per message shape), pass group_by: the result then counts each group, and shows no lines. from_line and to_line search part of the file. Results include line numbers to read further with read_document.",
    parameters: {
      type: "object",
      properties: {
        document_id: documentId,
        query: { type: "string", description: "Keywords, exact text, or a regex, depending on mode." },
        mode: { type: "string", enum: ["keywords", "exact", "regex"], description: "Defaults to keywords." },
        max_results: { type: "integer", description: `Up to ${MAX_GREP_RESULTS} for exact/regex (default ${DEFAULT_GREP_RESULTS}), up to ${MAX_GROUPS} groups with group_by (default ${DEFAULT_GROUPS}), up to 10 passages for keywords (default 5).` },
        context_lines: { type: "integer", description: "exact/regex only: lines to show before and after each match, 0-5." },
        case_sensitive: { type: "boolean", description: "exact/regex only. Defaults to false." },
        from_line: { type: "integer", description: "Search only from this line on (1-based). Pass a result's next_from_line to see the matches after those it shows." },
        to_line: { type: "integer", description: "Search only up to this line." },
        order: { type: "string", enum: ["first", "last"], description: "exact/regex only: \"last\" shows the last max_results matching lines (in file order) instead of the first. Defaults to \"first\"." },
        group_by: { type: "string", enum: [...GROUP_BY_VALUES], description: "exact/regex only: count the matching lines by group instead of showing them. \"capture\": by the text of the regex's first (group); \"minute\", \"hour\", \"day\": by the timestamp on the line; \"shape\": by the line with its numbers, IDs and quoted values taken out." },
        whole_word: { type: "boolean", description: "exact only: match the text only as a whole word, not inside a longer one. Defaults to false." },
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
    description: "Read an entire large file in parts and answer a task that needs all of it, such as a full summary, a timeline, or items that must be judged by meaning. To count or list lines that contain a word, an ID or a pattern, use search_document in exact or regex mode instead: its count is exact, and this can miss items. Slow and costly: prefer search_document and read_document for specific questions.",
    parameters: {
      type: "object",
      properties: {
        document_id: documentId,
        task: { type: "string", description: "What to find or produce from the whole file, stated completely." },
      },
      required: ["document_id", "task"],
    },
  },
  aggregate: {
    name: TOOL_NAMES.aggregate,
    description: "Count, sum, average, or find the minimum or maximum over the rows of a table in an attached file: a CSV or TSV file, a sheet of an Excel workbook, or a table written as | cell | rows (in Word, PowerPoint, PDF or HTML files). It can keep only the rows that match filters, and group them by up to 3 columns (a date column by year, month or day). Its numbers are exact, as it reads every row: use it instead of reading rows to add them up or count them. Columns are named as in the table's header row; a letter (C) or a number (3) works too. Each group lists the lines of its first rows, to cite.",
    parameters: {
      type: "object",
      properties: {
        document_id: documentId,
        table: { type: "string", description: "Which table: a sheet's name or number in a workbook, or a table's number in other files (1 is the first). Defaults to the first." },
        metrics: { type: "array", items: { type: "string" }, description: "What to compute: \"count\", or an operation and a column: \"sum:Revenue\", \"avg:Price\", \"min:Date\", \"max:Amount\", \"count_distinct:Customer\". Defaults to [\"count\"]." },
        group_by: { type: "array", items: { type: "string" }, description: "Up to 3 columns to group the rows by. A date column may end in \":year\", \":month\" or \":day\": \"Date:month\"." },
        filters: {
          type: "array",
          description: "Keep only the rows that match all of these. Numbers compare as numbers, ISO dates (2026-03-01) as text, other text ignoring case.",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: [...FILTER_OPS] },
              value: { type: "string", description: "Not needed for empty and not_empty." },
            },
            required: ["column", "op"],
          },
        },
        order_by: { type: "string", enum: ["metric", "key"], description: "\"metric\" (the default): the largest value of the first metric first; \"key\": by the values grouped by, in order (dates and months in time order)." },
        limit: { type: "integer", description: `Groups to show, up to ${MAX_SHOWN_GROUPS} (default 50).` },
        header_rows: { type: "integer", description: "How many rows at the top of the table are its header, 0 to 5, when the result's columns show it was read wrong. Found by itself: a title row is skipped, and a header of two or three rows is joined (\"Q1 / January\")." },
      },
      required: ["document_id"],
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

/**
 * A boolean given by the model: on for `true`, and for "true" (in any case) or 1, as a number or as
 * text. A model sometimes sends a boolean as text, as it does numbers; read as off, "true" gave
 * another search than true without a word about it. Anything else is off.
 */
function flag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && /^\s*(?:true|1)\s*$/i.test(value);
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

/**
 * Trims a result to the character budget by dropping trailing list entries, then cutting text. A
 * note the result already has (a search that stopped early) is kept, before the one that says so.
 */
function fit(result: ToolResult, listKey: string | null, limit: number): ToolResult {
  if (JSON.stringify(result).length <= limit) return result;
  const list = listKey ? result[listKey] : undefined;
  if (Array.isArray(list)) {
    const kept = [...list];
    const before = typeof result.note === "string" ? `${result.note} ` : "";
    const note = () => `${before}Showing ${kept.length} of ${list.length} results to stay within the size limit. Narrow the query or read specific lines.`;
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
    cut = { truncated: true, partial: sliceWhole(serialized, size), note: "Result cut to the size limit. Ask for a smaller range." };
  } while (JSON.stringify(cut).length > limit && size > 100);
  return cut;
}

/**
 * The result of a whole-document read within `limit` characters: its answer is cut at the end,
 * and says so, rather than the result being cut as JSON, which loses what the other fields say.
 */
export function fitAnswer(result: ToolResult, limit: number): ToolResult {
  if (JSON.stringify(result).length <= limit || typeof result.answer !== "string") return fit(result, null, limit);
  const answer = result.answer;
  const cutAt = (keep: number): ToolResult => ({
    ...result,
    answer: `${sliceWhole(answer, keep)}…`,
    answer_shortened: "The rest of this answer did not fit in the room left in this conversation.",
  });
  // The longest start of the answer that fits. Escapes (quotes, line breaks) make the JSON longer
  // than the text by as much as the text holds of them, so it is found by halving, not worked out.
  let low = 0;
  let high = answer.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(cutAt(middle)).length <= limit) low = middle;
    else high = middle - 1;
  }
  return fit(cutAt(low), null, limit);
}

/**
 * The result of an exact or regex search that read the whole file: the first matches, then the
 * last one of the file, and a note that says how many of how many are shown when that is not all.
 * Without the last one, a model asked when something last happened named the last line it was
 * shown. To fit `limit`, matches are dropped from the end of the first ones: the last one stays.
 */
function firstAndLastMatches(base: ToolResult, first: LineMatch[], last: LineMatch, total: number, limit: number): ToolResult {
  const which = (kept: number) => (kept === 0 ? `the last (line ${last.line})` : `the first${kept > 1 ? ` ${kept}` : ""} and the last (line ${last.line})`);
  const shown = (kept: number) => `${kept + 1} of the ${total} matching lines`;
  // Where a search for the ones in between goes on: after the last of the first ones shown.
  const next = (kept: number) => (kept > 0 ? first[kept - 1]!.line + 1 : undefined);
  const between = (kept: number) => (next(kept) !== undefined ? `To see the ones in between, search again with from_line ${next(kept)}, or count them with group_by.` : "Narrow the query or read specific lines.");
  const withFirst = (kept: number, cut: boolean): ToolResult => ({
    ...base,
    ...(cut
      ? { note: `Showing ${shown(kept)} to stay within the size limit: ${which(kept)}. ${between(kept)}` }
      // When every match is shown, there is nothing to say.
      : kept + 1 < total ? { note: `${shown(kept)} are shown: ${which(kept)}. ${between(kept)}` } : {}),
    ...(kept + 1 < total && next(kept) !== undefined ? { next_from_line: next(kept) } : {}),
    matches: [...first.slice(0, kept), last],
  });
  const whole = withFirst(first.length, false);
  if (JSON.stringify(whole).length <= limit) return whole;
  let kept = first.length;
  while (kept > 0 && JSON.stringify(withFirst(kept, true)).length > limit) kept--;
  const cut = withFirst(kept, true);
  if (JSON.stringify(cut).length <= limit) return cut;
  // Only the last match is left, and its note is too long for the room: a shorter one. It still
  // starts with "Showing ", so the result is taken as cut. `fit` must not put its own note in its
  // place, which would say "1 of 1 results" and drop the line of the last match. When even this
  // does not fit, `fit` cuts the result as text: the note, with that line, comes before the match.
  const lastOnly = { ...base, note: `Showing 1 of the ${total} matching lines: ${which(0)}. Narrow the search.`, matches: [last] };
  return fit(lastOnly, null, limit);
}

/**
 * The result of a search with `order: "last"`: the last matching lines, in the order of the file,
 * with a note that says so, and on which line the first match is. To fit `limit`, the earliest of
 * them are dropped first: the very last stays. `stopped` is given when the scan stopped early: the
 * last line of the lines searched, and the `to_line` of the call, which a search for the lines after
 * those it found keeps.
 */
function lastMatches(base: ToolResult, first: LineMatch | undefined, last: LineMatch[], total: number, limit: number, stopped?: { end: number; toLine?: number }): ToolResult {
  const build = (kept: number, cut: boolean): ToolResult => {
    const shown = last.slice(last.length - kept);
    const end = shown.at(-1)?.line;
    // A scan that stopped early found these last: the lines after them were not all looked at. Its
    // note starts as those of the other searches that stopped early do, which `alreadyShown` looks
    // for: a later question has time of its own, and the call made then is run, not pointed back to.
    if (stopped) {
      // Nothing found means out of time (an exact search stops only past its limit on matches). It
      // is not known where the scan stopped, so no line is named to search from.
      if (end === undefined) {
        return { ...base, note: "The scan stopped early, out of time, before it found a matching line: the lines it did not reach may have some. Try a simpler pattern, mode \"exact\", or fewer lines with from_line and to_line.", matches: shown };
      }
      const lines = `${shown.length} ${plural(shown.length, "matching line")}`;
      const which = cut ? `Showing the last ${lines} it found to stay within the size limit` : `These are the last ${lines} it found`;
      // The search goes on after the last line found, in the same range. When that line is the last
      // of the range, the scan stopped there and missed none of it: there is nothing to search on.
      const later = end < stopped.end
        ? ` There may be later ones, after line ${end}: search again with from_line ${end + 1}${stopped.toLine !== undefined ? ` and to_line ${stopped.toLine}` : ""}.`
        : "";
      return { ...base, note: `The scan stopped early; the total is a lower bound. ${which}, in the order of the file.${later}`, matches: shown };
    }
    const note = shown.length < total
      // A cut result's note starts with "Showing ", as `alreadyShown` looks for: a call made later may have more room.
      ? cut
        ? `Showing the last ${shown.length} of the ${total} matching lines to stay within the size limit, in the order of the file: the last match is on line ${end}${first ? `, and the first on line ${first.line}` : ""}. Narrow the query or read specific lines.`
        : `These are the last ${shown.length} of the ${total} matching lines, in the order of the file: the last match is on line ${end}${first ? `, and the first on line ${first.line}` : ""}.`
      : undefined;
    return { ...base, ...(note ? { note: typeof base.note === "string" ? `${base.note} ${note}` : note } : {}), matches: shown };
  };
  const whole = build(last.length, false);
  if (JSON.stringify(whole).length <= limit) return whole;
  let kept = last.length;
  while (kept > 1 && JSON.stringify(build(kept, true)).length > limit) kept--;
  return fit(build(kept, true), null, limit);
}

/** The result of a search with `group_by`: the total, then up to `shown` groups, cut further to fit `limit`. */
function groupedResult(base: ToolResult, counted: GroupResult, shown: number, limit: number): ToolResult {
  const byTime = base.group_by === "minute" || base.group_by === "hour" || base.group_by === "day";
  const all = counted.groups.map(({ key, count, firstLine, lastLine }) => ({ key, count, first_line: firstLine, last_line: lastLine }));
  // By time, the groups shown are the largest, put back in time order; so are those kept when the
  // result is cut to its room. Cutting the end of the list there kept the earliest groups, while the
  // note said the largest, and a model named the wrong hour as the busiest. The sort is stable: of
  // groups of the same size, the earlier comes first.
  const largest = byTime ? [...all].sort((left, right) => right.count - left.count) : all;
  const pick = (kept: number) => (byTime ? largest.slice(0, kept).sort((left, right) => left.first_line - right.first_line) : all.slice(0, kept));
  const most = Math.min(shown, all.length);
  const extra = {
    total_groups: counted.totalGroups,
    ...(counted.otherCount > 0 ? { other_count: counted.otherCount, other_note: `Lines of groups past the first ${MAX_GROUP_KEYS.toLocaleString("en-US")} found.` } : {}),
    ...(counted.ungrouped > 0 ? { lines_without_group: counted.ungrouped } : {}),
  };
  const build = (kept: number, cut: boolean): ToolResult => {
    const groups = pick(kept);
    const order = byTime ? (groups.length < all.length ? "the largest, in time order" : "in time order") : "the largest first";
    const note = groups.length < counted.totalGroups ? `${cut ? "Showing " : ""}${groups.length} of the ${counted.totalGroups} groups${cut ? " to stay within the size limit" : " are shown"}, ${order}. Narrow the search, or use from_line and to_line, for the others.` : undefined;
    return { ...base, ...extra, ...(note ? { note: typeof base.note === "string" ? `${base.note} ${note}` : note } : {}), groups };
  };
  const whole = build(most, false);
  if (JSON.stringify(whole).length <= limit) return whole;
  let kept = most;
  while (kept > 1 && JSON.stringify(build(kept, true)).length > limit) kept--;
  return fit(build(kept, true), null, limit);
}

/** A list of strings the model sent: an array, or one string (which a model sometimes sends for a list of one). */
function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (typeof item !== "string" && typeof item !== "number") throw new Error(`${name} must be a list of strings.`);
    return String(item);
  });
}

/** The arguments of an `aggregate_table` call as the tool reads them. */
export function aggregateRequest(args: Record<string, unknown>): AggregateRequest {
  const rawFilters = args.filters === undefined || args.filters === null ? [] : Array.isArray(args.filters) ? args.filters : [args.filters];
  const filters = rawFilters.map((filter) => {
    const { column, op, value } = (filter ?? {}) as { column?: unknown; op?: unknown; value?: unknown };
    if (typeof column !== "string" && typeof column !== "number") throw new Error("Each filter needs a column.");
    if (typeof op !== "string" || !(FILTER_OPS as readonly string[]).includes(op)) throw new Error(`A filter's op must be one of ${FILTER_OPS.map((name) => `"${name}"`).join(", ")}.`);
    return { column: String(column), op: op as FilterOp, ...(value !== undefined && value !== null ? { value: typeof value === "number" ? value : String(value) } : {}) };
  });
  const table = typeof args.table === "number" || (typeof args.table === "string" && args.table.trim()) ? args.table as string | number : undefined;
  const groupBy = stringList(args.group_by, "group_by");
  const metrics = stringList(args.metrics, "metrics");
  return {
    ...(table !== undefined ? { table } : {}),
    ...(filters.length > 0 ? { filters } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(metrics ? { metrics } : {}),
    orderBy: args.order_by === "key" ? "key" : "metric",
    limit: integer(args.limit, 50, 1, MAX_SHOWN_GROUPS),
    ...(args.header_rows !== undefined && args.header_rows !== null && args.header_rows !== "" ? { headerRows: integer(args.header_rows, 1, 0, 5) } : {}),
  };
}

const searchMode = (mode: unknown): "keywords" | "exact" | "regex" => (mode === "exact" || mode === "regex" ? mode : "keywords");

/** `group_by` as the search reads it: undefined when not given. A value it does not know is an error. */
function groupByOf(value: unknown): GroupBy | undefined {
  if (value === undefined || value === null || value === "" || value === "none") return undefined;
  if (typeof value === "string" && (GROUP_BY_VALUES as readonly string[]).includes(value)) return value as GroupBy;
  throw new Error(`group_by must be one of ${GROUP_BY_VALUES.map((name) => `"${name}"`).join(", ")}.`);
}

/** A line number of a search's range, as the search reads it: undefined when not given. */
const rangeLine = (value: unknown): number | undefined => (value === undefined || value === null || value === "" ? undefined : integer(value, 1, 1, Number.MAX_SAFE_INTEGER));

/**
 * The arguments of a search that choose which lines it looks at and how it shows them, as the
 * search reads them. The search, its key and its label all read them here, so that they agree.
 */
function searchScope(args: Record<string, unknown>): { fromLine?: number; toLine?: number; order: "first" | "last"; groupBy?: GroupBy; wholeWord: boolean; caseSensitive: boolean } {
  const fromLine = rangeLine(args.from_line);
  const toLine = rangeLine(args.to_line);
  let groupBy: GroupBy | undefined;
  try {
    groupBy = groupByOf(args.group_by);
  } catch {
    groupBy = undefined;
  }
  return {
    ...(fromLine !== undefined ? { fromLine } : {}),
    ...(toLine !== undefined ? { toLine } : {}),
    order: args.order === "last" ? "last" : "first",
    ...(groupBy ? { groupBy } : {}),
    wholeWord: flag(args.whole_word),
    caseSensitive: flag(args.case_sensitive),
  };
}

/** The lines a `read_document` call asks for, as its handler reads them, before the end of the file is known. */
function requestedLines(args: Record<string, unknown>): [number, number] {
  const start = integer(args.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
  return [start, integer(args.end_line, start + DEFAULT_READ_LINES - 1, start, start + MAX_READ_LINES - 1)];
}

/**
 * A call's arguments as its tool reads them, with the defaults filled in: two calls with the same
 * key get the same result from a file that has not changed. Undefined for a tool whose calls are
 * not compared (a whole-file read has a count of its own; a look at pages returns a file).
 */
export function toolCallKey(name: string, args: Record<string, unknown>): string | undefined {
  const id = typeof args.document_id === "string" && args.document_id ? args.document_id : undefined;
  if (!id) return undefined;
  if (name === TOOL_NAMES.search) {
    if (typeof args.query !== "string" || !args.query.trim()) return undefined;
    const mode = searchMode(args.mode);
    // A group_by the search refuses: the call answers with an error, and is not compared.
    try {
      groupByOf(args.group_by);
    } catch {
      return undefined;
    }
    const { fromLine, toLine, order, groupBy, wholeWord, caseSensitive } = searchScope(args);
    // The arguments of 0.8.0 are added only when given: a call without them has the key it had.
    const scope = [
      ...(fromLine !== undefined || toLine !== undefined ? [fromLine ?? 1, toLine ?? null] : []),
      ...(mode !== "keywords" && (order === "last" || groupBy || wholeWord) ? [order, groupBy ?? null, mode === "exact" && wholeWord] : []),
    ];
    return JSON.stringify(mode === "keywords"
      ? [name, id, args.query, mode, integer(args.max_results, 5, 1, 10), ...scope]
      : [name, id, args.query, mode, groupBy ? integer(args.max_results, DEFAULT_GROUPS, 1, MAX_GROUPS) : integer(args.max_results, DEFAULT_GREP_RESULTS, 1, MAX_GREP_RESULTS), groupBy ? 0 : integer(args.context_lines, 0, 0, 5), caseSensitive, ...scope]);
  }
  if (name === TOOL_NAMES.read) return JSON.stringify([name, id, ...requestedLines(args)]);
  if (name === TOOL_NAMES.aggregate) {
    try {
      return JSON.stringify([name, id, aggregateRequest(args)]);
    } catch {
      return undefined;
    }
  }
  if (name === TOOL_NAMES.overview) return JSON.stringify([name, id]);
  return undefined;
}

/**
 * When an earlier call's result already holds all that `call` would return, and is still in the
 * conversation in full: a short result that says so, in place of running the call again. A result
 * that was cut to the room it had, or replaced by a stand-in, or failed, is not pointed to: the call
 * is run, and may get more. A read of lines inside a read that is shown in full is pointed to.
 * `stored` is true for a result in the tool rounds of an earlier question, which an older version
 * may have written: 0.5.0 cut the text of a read of one long line without saying so (no
 * `text_cut`), so a read of one line from there is not taken as shown in full.
 */
export function alreadyShown(call: { name: string; args: Record<string, unknown> }, earlier: { call: { name: string; args: Record<string, unknown> }; result: ToolResult }, stored = false): ToolResult | undefined {
  const { result } = earlier;
  if (earlier.call.name !== call.name || earlier.call.args.document_id !== call.args.document_id) return undefined;
  if (result.dropped === true || result.already_shown === true || typeof result.error === "string" || result.truncated === true) return undefined;
  // A search stored by 0.7.0 with case_sensitive or whole_word as text or 1 ("true", 1): 0.7.0 read
  // those as off, 0.8.0 as on, so the call made now would not return what was stored.
  if (stored && call.name === TOOL_NAMES.search && [earlier.call.args.case_sensitive, earlier.call.args.whole_word].some((value) => value !== undefined && value !== true && value !== false && flag(value))) return undefined;
  // A list that `fit` cut to the room it had, a read whose text was cut, or a search that ran out of
  // time ("the total is a lower bound"; a later question has time of its own): a call made now may get more.
  if (typeof result.note === "string" && (result.note.startsWith("Showing ") || result.note.startsWith("The scan stopped early"))) return undefined;
  if (result.text_cut === true) return undefined;
  // An exact or regex search that an earlier version stored: the first matches, without the last one
  // and without a note. Run now, the call returns more (the last match), not the same.
  if (call.name === TOOL_NAMES.search && typeof result.total_matching_lines === "number" && Array.isArray(result.matches)
    && result.matches.length < result.total_matching_lines && typeof result.note !== "string") return undefined;
  const document = typeof result.document === "string" ? { document: result.document } : {};
  if (call.name === TOOL_NAMES.read) {
    const shown = typeof result.lines === "string" ? /^(\d+)-(\d+)$/.exec(result.lines) : null;
    const total = result.total_lines;
    if (!shown || typeof total !== "number") return undefined;
    const [first, last] = [Number(shown[1]), Number(shown[2])];
    if (stored && first === last) return undefined;
    const [start, end] = requestedLines(call.args);
    const from = Math.min(start, total);
    const to = Math.min(end, total);
    if (from < first || to > last) return undefined;
    return {
      ...document,
      lines: `${from}-${to}`,
      already_shown: true,
      note: `Not run: lines ${from}-${to} are already shown above in full, in the result that has lines ${first}-${last} of this file, and the file has not changed. Use them. To see more, read other lines.`,
    };
  }
  const key = toolCallKey(call.name, call.args);
  if (key === undefined || key !== toolCallKey(earlier.call.name, earlier.call.args)) return undefined;
  return {
    ...document,
    already_shown: true,
    note: "Not run: this exact call was answered earlier in this conversation, and its result is still shown above in full. The file has not changed, so it would return the same. Use that result. For more, read other lines, or search with other words or another mode.",
  };
}

/**
 * A hint added to the error of a search that failed twice in a row in the same mode, so that the
 * model tries another way instead of sending the same kind of call a third time.
 */
export function repeatedFailureHint(call: { name: string; args: Record<string, unknown> }): string {
  return searchMode(call.args.mode) === "regex"
    ? "Two regex searches in a row failed. Try mode \"exact\" with a plain word or ID from the file, or mode \"keywords\"."
    : "This search failed twice in a row. Check the arguments against the tool's description, or answer from what you have.";
}

/**
 * The tool and mode of a search, to tell whether two failures in a row were of the same kind.
 * Undefined for the other tools: their errors say what to do (a whole-file read that is not made
 * again, a page that does not exist), and a hint would only blur that.
 */
export function failureKind(call: { name: string; args: Record<string, unknown> }): string | undefined {
  return call.name === TOOL_NAMES.search ? `${call.name}|${searchMode(call.args.mode)}` : undefined;
}

/**
 * What a finished tool call found, as a suffix for its `describe()` label, for a steps list:
 * "Search app.log (exact) for “timeout”" + " — 12 matching lines".
 */
export function toolResultSummary(label: string, result: ToolResult): string {
  if (typeof result.error === "string") return ` — failed: ${result.error}`;
  if (typeof result.total_matching_lines === "number") {
    const groups = typeof result.total_groups === "number" ? ` in ${result.total_groups.toLocaleString("en-US")} ${plural(result.total_groups, "group")}` : "";
    return ` — ${result.total_matching_lines.toLocaleString("en-US")} ${plural(result.total_matching_lines, "matching line")}${groups}`;
  }
  if (Array.isArray(result.passages)) return ` — ${result.passages.length} ${plural(result.passages.length, "passage")}`;
  if (typeof result.rows_matched === "number") {
    const groups = typeof result.total_groups === "number" ? `, ${result.total_groups.toLocaleString("en-US")} ${plural(result.total_groups, "group")}` : "";
    return ` — ${result.rows_matched.toLocaleString("en-US")} ${plural(result.rows_matched, "row")}${groups}`;
  }
  if (typeof result.parts_read === "number") {
    const incomplete = result.notes_only ? ", notes only" : result.notes_cut_short || result.answer_cut_short ? ", incomplete" : "";
    return ` — ${result.parts_read} ${plural(result.parts_read, "part")}, ${String(result.parts_with_relevant_content ?? 0)} relevant${incomplete}`;
  }
  // A read reports its range only when it was cut short of what was asked.
  if (typeof result.lines === "string" && typeof result.total_lines === "number") return label.endsWith(result.lines) ? "" : ` — got ${result.lines}`;
  // So does a look at pages.
  if (typeof result.pages === "string" && typeof result.total_pages === "number") {
    return label.endsWith(` ${result.pages}`) ? "" : ` — got ${result.pages.includes("-") ? "pages" : "page"} ${result.pages}`;
  }
  return "";
}

/**
 * A step, or a label of one, as one line of plain text. Steps quote what the model sent (a query, a
 * task, the name of a tool, arguments that were not JSON), and they reach users' screens: the
 * invisible characters that file text and names lose are dropped (`removeInvisible`: text-direction
 * overrides and isolates, zero-width spaces, tag characters), a line break, a tab or another control
 * character becomes one space with the blanks around it, and "](" gets a space, so that a markdown
 * link or picture in a query stays text. A line without them is unchanged.
 */
export function stepLine(text: string): string {
  // Each control character, tab and line break is a "\n" first, which `removeInvisible` keeps (it
  // would drop the others): an invisible character between two of them then leaves one space, not
  // two. A soft hyphen it keeps before one goes too. Then a run of blanks with a "\n" in it is one space.
  const marked = removeInvisible(text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "\n")).replace(/\xAD+(?=\n)/g, "");
  return marked.replace(/\s+/g, (blank) => (blank.includes("\n") ? " " : blank)).replaceAll("](", "] (");
}

/** An unknown tool's name as a step or an error quotes it: the model chose it, at any length. */
export const unknownToolName = (name: string): string => `“${sliceWhole(name, 64)}”`;

/**
 * A document_id the model sent, as an error quotes it: whole when it is as long as a real one can
 * be, cut otherwise. The model chose it, at any length, and the error goes into steps too.
 */
const shownId = (id: string): string => (id.length > 64 ? `${sliceWhole(id, 64)}…` : id);

export function createDocumentTools(options: {
  /** Loads a document the tools may access. Return undefined for anything out of scope. */
  load(documentId: string): Promise<DocumentSource | undefined>;
  documentIds: string[];
  /** File names by document ID, so `describe` can name files before they are loaded. */
  names?: Record<string, string>;
  budget: Budget;
  generate?: GenerateText;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
  /** The most time, in milliseconds, that the regex searches of this tool set may take together. Defaults to `REGEX_BUDGET_MS`. */
  regexBudgetMs?: number;
  /** How many times each document may be read whole by this tool set. Defaults to `MAX_WHOLE_DOCUMENT_READS`. */
  maxWholeDocumentReads?: number;
  /** How a model request of a whole-document read that failed is sent again. */
  retry?: RetryOptions;
  /**
   * False when every document is too large for a whole-document read: `analyze_whole_document` is
   * then not declared. A call of it still answers with the reason. Defaults to true.
   */
  wholeReads?: boolean;
  /**
   * PDFs whose pages `view_pages` may show. The tool is declared only when there is at least one
   * and `loadOriginal` is given. They need not be among `documentIds`: a PDF whose text is in the
   * prompt has nothing to search, but its pages can still be looked at.
   */
  viewableIds?: string[];
  /** Loads the uploaded file of a document, for `view_pages`. */
  loadOriginal?(documentId: string): Promise<Uint8Array | undefined>;
  /**
   * True when a document may hold a table (a CSV, a workbook, a document with `| cell |` rows):
   * `aggregate_table` is then declared. A call of it is answered either way. Defaults to false.
   */
  tables?: boolean;
}): ToolSet {
  const allowed = new Set(options.documentIds);
  const viewable = new Set(options.loadOriginal ? options.viewableIds ?? [] : []);
  const names = new Map<string, string>(Object.entries(options.names ?? {}));
  // The text tools are left out only when there are pages to look at and no document to search.
  const textTools = allowed.size > 0 || viewable.size === 0;
  const declarations = [
    ...(textTools ? [DECLARATIONS.search, DECLARATIONS.read, DECLARATIONS.overview, ...(options.tables ? [DECLARATIONS.aggregate] : []), ...(options.generate && options.wholeReads !== false ? [DECLARATIONS.analyze] : [])] : []),
    ...(viewable.size > 0 ? [DECLARATIONS.view] : []),
  ];
  const known = new Set(declarations.map((declaration) => declaration.name));
  // Answered for any document, declared or not: a model may know the tool from earlier in the conversation.
  if (textTools) known.add(TOOL_NAMES.aggregate);
  // Not declared for files that are all too large for it, but still answered: with the reason, not "unknown tool".
  if (textTools && options.generate) known.add(TOOL_NAMES.analyze);
  const cap = options.budget.toolResultCharacters;
  /** The cap on the result of one call: the tool set's own, or the room its caller has left when that is less. */
  const limitOf = (limits: ToolCallLimits, own = cap): number => {
    const room = limits.maxResultCharacters;
    return typeof room === "number" && Number.isFinite(room) ? Math.max(LEAST_RESULT_CHARACTERS, Math.min(own, Math.trunc(room))) : own;
  };
  // The model writes the regex, and a file it reads can ask for a slow one: the time is counted
  // over every search of this tool set, not only within one.
  const regexBudget = Math.max(0, options.regexBudgetMs ?? REGEX_BUDGET_MS);
  const regexClock = { usedMs: 0 };
  // Calls of one turn may run together. Regex searches still take their turns, one after another:
  // each must know how much of the time the ones before it used.
  let regexQueue: Promise<unknown> = Promise.resolve();
  const inRegexTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = regexQueue.then(run, run);
    regexQueue = next.catch(() => undefined);
    return next;
  };
  const givenReads: unknown = options.maxWholeDocumentReads;
  // NaN failed every comparison, so it let a document be read whole any number of times.
  if (givenReads !== undefined && (typeof givenReads !== "number" || Number.isNaN(givenReads))) {
    const shown = typeof givenReads === "number" ? String(givenReads) : typeof givenReads === "string" ? JSON.stringify(givenReads) : typeof givenReads;
    throw new (typeof givenReads === "number" ? RangeError : TypeError)(`maxWholeDocumentReads must be a number, and is ${shown}.`);
  }
  const maxWholeReads = Math.max(0, Math.trunc(options.maxWholeDocumentReads ?? MAX_WHOLE_DOCUMENT_READS));
  /** Whole-document reads started, by document. */
  const wholeReads = new Map<string, number>();
  /** Why the last whole-document read of a document failed, when no part of it could be read. */
  const failedWholeReads = new Map<string, string>();
  // When no limit is given with a call: three eighths of a request, so that two looks still fit.
  const defaultFileBytes = Math.floor((options.budget.maxRequestBytes - REQUEST_BYTES_MARGIN) * 3 / 8);

  async function documentFor(args: Record<string, unknown>): Promise<DocumentSource> {
    const id = text(args.document_id, "document_id");
    // Scope check: a model can only reach files attached to this conversation.
    if (!allowed.has(id)) {
      // The IDs it may use, with their file names, so that the next call is right.
      const usable = [...allowed].slice(0, 20).map((known) => `${known}${names.has(known) ? ` (${JSON.stringify(names.get(known))})` : ""}`);
      throw new Error(usable.length === 0
        ? `Unknown document_id ${shownId(id)}. No attached file is read with this tool in this conversation.`
        : `Unknown document_id ${shownId(id)}. Use one of: ${usable.join(", ")}${allowed.size > 20 ? ", …" : ""}.`);
    }
    const document = await options.load(id);
    if (!document) throw new Error(`${id} is no longer available on the server. Ask the user to attach the file again.`);
    names.set(id, document.meta.name);
    return document;
  }

  const handlers: Record<string, (args: Record<string, unknown>, limits: ToolCallLimits, hooks: ToolCallHooks) => Promise<ToolResult>> = {
    async [TOOL_NAMES.search](args, limits) {
      const limit = limitOf(limits);
      const document = await documentFor(args);
      const query = text(args.query, "query");
      const mode = args.mode === "exact" || args.mode === "regex" ? args.mode : "keywords";
      // Page numbers are added only for a PDF whose pages can be looked at: they are what
      // view_pages takes. Everything else gets the results of 0.2.0 unchanged.
      const paged = viewable.has(document.meta.id);
      const groupBy = groupByOf(args.group_by);
      const { fromLine, toLine, order, wholeWord, caseSensitive } = searchScope(args);
      const total = document.lineCount;
      if (fromLine !== undefined && fromLine > total) throw new Error(`from_line ${fromLine} is past the end of the file, which has ${total} ${plural(total, "line")}.`);
      if (toLine !== undefined && toLine < (fromLine ?? 1)) throw new Error(`to_line ${toLine} is before from_line ${fromLine ?? 1}.`);
      const ranged = fromLine !== undefined || toLine !== undefined;
      const range = { from: fromLine ?? 1, to: Math.min(total, toLine ?? total) };
      // Said in the result when part of the file was searched: the counts are of those lines.
      const searched = ranged ? { searched_lines: `${range.from}-${range.to}` } : {};
      if (mode === "keywords") {
        if (groupBy) throw new Error("group_by counts the lines of an exact or regex search: use mode \"exact\" or \"regex\".");
        const topK = integer(args.max_results, 5, 1, 10);
        const ranked = await rankSource(document, query, topK, options.signal, ranged ? range : undefined);
        const texts = await Promise.all(ranked.map((passage) => document.readLines(passage.from, passage.to)));
        return fit({
          document: document.meta.name,
          mode,
          ...searched,
          passages: ranked.map((passage, index) => {
            const pages = paged ? document.pagesOfLines(passage.from, passage.to) : undefined;
            return {
              lines: `${passage.from}-${passage.to}`,
              ...(pages ? { pages } : {}),
              score: passage.score,
              text: numberLines(texts[index]!, passage.from),
            };
          }),
          ...(ranked.length === 0 ? { note: "No passage contains these keywords. Try other words, synonyms, or exact mode." } : {}),
        }, "passages", limit);
      }
      const regex = mode === "regex";
      const shownGroups = integer(args.max_results, DEFAULT_GROUPS, 1, MAX_GROUPS);
      const grep = async () => {
        const regexLeft = regexBudget - regexClock.usedMs;
        if (regex && regexLeft <= 0) {
          throw new Error("The time for regex searches is used up for this answer. Search with mode \"exact\" or \"keywords\" instead.");
        }
        return grepSource(document, query, {
          regex,
          caseSensitive,
          maxResults: integer(args.max_results, DEFAULT_GREP_RESULTS, 1, MAX_GREP_RESULTS),
          contextLines: integer(args.context_lines, 0, 0, 5),
          ...(regex ? { timeLimitMs: Math.min(REGEX_TIME_LIMIT_MS, regexLeft), regexClock } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(ranged ? { fromLine: range.from, toLine: range.to } : {}),
          ...(order === "last" ? { order } : {}),
          ...(groupBy ? { groupBy } : {}),
          ...(wholeWord && !regex ? { wholeWord } : {}),
        });
      };
      const result = await (regex ? inRegexTurn(grep) : grep());
      const placed = (match: LineMatch): LineMatch => {
        if (!paged) return match;
        const { line, ...rest } = match;
        const page = document.pageOfLine(line);
        return { line, ...(page ? { page } : {}), ...rest };
      };
      const base = { document: document.meta.name, mode, ...searched, total_matching_lines: result.totalMatchingLines };
      const stopped = result.stoppedEarly ? { note: "The scan stopped early; the counts are lower bounds." } : {};
      if (result.groups) return groupedResult({ ...base, group_by: groupBy!, ...stopped }, result.groups, shownGroups, limit);
      const matches = result.matches.map(placed);
      if (order === "last") {
        // The range a search for the lines after those found goes on in, when the scan stopped early.
        const rest = result.stoppedEarly ? { end: range.to, ...(toLine !== undefined ? { toLine: range.to } : {}) } : undefined;
        return lastMatches({ ...base, order }, result.first ? placed(result.first) : undefined, matches, result.totalMatchingLines, limit, rest);
      }
      if (!result.stoppedEarly && result.totalMatchingLines >= 2) {
        // The last match is `last`, or, when every match is among the first ones, the last of them.
        return result.last
          ? firstAndLastMatches(base, matches, placed(result.last), result.totalMatchingLines, limit)
          : firstAndLastMatches(base, matches.slice(0, -1), matches.at(-1)!, result.totalMatchingLines, limit);
      }
      return fit({
        ...base,
        // The description says the last match is shown: here it is not known.
        ...(result.stoppedEarly ? { note: "The scan stopped early; the total is a lower bound, and the last match in the file is not known." } : {}),
        matches,
      }, "matches", limit);
    },

    async [TOOL_NAMES.read](args, limits) {
      const limit = limitOf(limits);
      const document = await documentFor(args);
      const total = document.lineCount;
      const start = integer(args.start_line, 1, 1, total);
      const end = integer(args.end_line, start + DEFAULT_READ_LINES - 1, start, Math.min(total, start + MAX_READ_LINES - 1));
      // One read for the range asked; trimming to the size limit works on what was read.
      const read = await document.readLines(start, end);
      let to = end;
      let body = numberLines(read, start);
      // The limit is on the result as it is sent, as JSON: quotes, tabs and line breaks each take two characters there.
      const fits = (text: string) => JSON.stringify(text).length <= limit - 500;
      while (!fits(body) && to > start) {
        to = start + Math.max(0, Math.floor((to - start) * 0.7));
        body = numberLines(read.slice(0, to - start + 1), start);
      }
      const pages = viewable.has(document.meta.id) ? document.pagesOfLines(start, to) : undefined;
      return {
        document: document.meta.name,
        lines: `${start}-${to}`,
        ...(pages ? { pages } : {}),
        total_lines: total,
        text: fits(body) ? body : sliceWhole(body, Math.floor((limit - 500) / 2)),
        // One line longer than the room: its text was cut, so the lines are not all shown.
        ...(fits(body) ? {} : { text_cut: true }),
        ...(to < total ? { next_start_line: to + 1 } : { note: "End of file." }),
      };
    },

    async [TOOL_NAMES.overview](args, limits) {
      const limit = limitOf(limits);
      const document = await documentFor(args);
      const { meta, lineCount } = document;
      const tail = Math.max(1, lineCount - 19);
      // Counting the parts means reading the whole text, for a number that only says how costly a
      // whole-document read is. It is worked out from the metadata instead, to within a part or
      // two; the read itself counts them.
      const parts = estimateParts(meta, options.budget);
      const first = Math.min(30, lineCount);
      return fit({
        document: meta.name,
        format: meta.format,
        size: formatBytes(meta.bytes),
        lines: meta.lines,
        estimated_tokens: meta.estimatedTokens,
        ...(meta.pages ? { pages: meta.pages } : {}),
        parts_for_whole_document_analysis: parts,
        ...(parts > options.budget.maxMapChunks ? { whole_document_analysis: `Not available for this file: it would take about ${parts} parts, and the limit is ${options.budget.maxMapChunks}. Use search_document and read_document.` } : {}),
        // 0.5.0 stored some log templates cut inside an emoji: half of a character is not sent.
        ...(meta.logProfile ? { log_profile: wellFormedJson(meta.logProfile) } : {}),
        first_lines: numberLines(await document.readLines(1, first), 1),
        last_lines: lineCount > 30 ? numberLines(await document.readLines(tail, lineCount), tail) : "",
        outline: meta.outline.length ? outlineLines(meta.outline) : [],
      }, "outline", limit);
    },

    async [TOOL_NAMES.aggregate](args, limits) {
      const limit = limitOf(limits);
      const document = await documentFor(args);
      const request = aggregateRequest(args);
      const result = await aggregateTable(document, request, options.signal);
      const groups = result.groups.map((group) => ({
        ...(Object.keys(group.key).length > 0 ? { group: group.key } : {}),
        ...group.values,
        ...(group.values.count === undefined ? { rows: group.count } : {}),
        lines: group.lines,
      }));
      const shownColumns = result.columns.slice(0, 60);
      const base = {
        document: document.meta.name,
        table: result.table,
        ...(result.tables > 1 ? { tables_in_file: result.tables } : {}),
        header_line: result.headerLine,
        ...(result.headerRows !== 1 ? { header_rows: result.headerRows } : {}),
        ...(result.title !== undefined ? { title: result.title } : {}),
        columns: result.columns.length > shownColumns.length ? [...shownColumns, `… ${result.columns.length - shownColumns.length} more`] : shownColumns,
        rows_read: result.rowsRead,
        rows_matched: result.rowsMatched,
        ...(result.totalGroups > 1 || (request.groupBy?.length ?? 0) > 0 ? { total_groups: result.totalGroups } : {}),
        ...(result.otherRows > 0 ? { other_rows: result.otherRows, other_note: `Rows of groups past the first ${MAX_GROUP_KEYS.toLocaleString("en-US")} found.` } : {}),
        ...(Object.keys(result.notNumbers).length > 0 ? { values_not_numbers: result.notNumbers, values_note: "Cells of these columns that are not numbers were left out of the metric." } : {}),
        ...(result.repeatedHeaders > 0 ? { repeated_header_rows: result.repeatedHeaders } : {}),
        ...(result.irregularRows > 0 ? { irregular_rows: result.irregularRows, irregular_note: "Rows with values past the header's columns: check columns and header_rows." } : {}),
      };
      const note = groups.length < result.totalGroups
        ? { note: `${groups.length} of the ${result.totalGroups} groups are shown, ${request.orderBy === "key" ? "in the order of their values" : "the largest first"}. Raise limit, or filter, for the others.` }
        : {};
      return fit({ ...base, ...note, groups }, "groups", limit);
    },

    async [TOOL_NAMES.analyze](args, limits, hooks) {
      if (!options.generate) throw new Error("Whole-document analysis is not enabled.");
      const document = await documentFor(args);
      const task = text(args.task, "task");
      // A read of the whole file is many model requests. A model that asks for it again, with the
      // task put another way, is told to use what it has. The count is taken before the read
      // starts, so that two calls in one turn do not both pass.
      const id = document.meta.id;
      const reads = wholeReads.get(id) ?? 0;
      if (reads >= maxWholeReads) {
        const failure = failedWholeReads.get(id);
        throw new Error(maxWholeReads === 0
          ? `Whole-file reads are turned off for this question. Use search_document and read_document on ${document.meta.name}.`
          : failure !== undefined
            // There is no answer to use: saying "use the answer of that read" would invite one made up.
            ? `The whole-file read of ${document.meta.name} failed earlier in this question (${failure}), and is not tried again. Use search_document and read_document.`
            : `${document.meta.name} was already read whole for this question${maxWholeReads > 1 ? ` ${maxWholeReads} times` : ""}, and is not read whole again. Use the answer of that read, or search_document and read_document for the details.`);
      }
      wholeReads.set(id, reads + 1);
      let result;
      try {
        result = await analyzeWholeDocument({
          document,
          task,
          generate: options.generate,
          budget: options.budget,
          // The call's own listener, when it has one, in place of the tool set's.
          onProgress: hooks.onProgress ?? options.onProgress,
          ...(hooks.onRequest ? { onRequest: hooks.onRequest } : {}),
          signal: options.signal,
          ...(options.retry ? { retry: options.retry } : {}),
          ...(typeof limits.maxRequests === "number" && Number.isFinite(limits.maxRequests) ? { maxRequests: limits.maxRequests } : {}),
        });
      } catch (error) {
        // Parts were sent and none could be read: that read is counted, since another would most
        // likely fail the same way. Anything else (too many parts, a store that could not be read)
        // failed before any model request: that was no read. Its count is given back, not set to
        // what it was when the read started, which would take back the count of another read of
        // the same document running in this turn.
        if (error instanceof NothingReadError) failedWholeReads.set(id, error.reason);
        else wholeReads.set(id, Math.max(0, (wholeReads.get(id) ?? 1) - 1));
        throw error;
      }
      failedWholeReads.delete(id);
      const notesCutShort = result.truncatedParts + result.truncatedMerges;
      return fitAnswer({
        document: document.meta.name,
        parts_read: result.parts,
        parts_with_relevant_content: result.relevantParts,
        ...(result.failedParts ? { parts_that_failed: result.failedParts } : {}),
        ...(notesCutShort ? { notes_cut_short: notesCutShort } : {}),
        ...(result.answerTruncated ? { answer_cut_short: true } : {}),
        ...(result.answerFailed !== undefined ? { notes_only: true } : {}),
        ...(result.answerFailed !== undefined
          ? { note: `The last step of this read, which writes one answer from the notes of the parts, failed (${result.answerFailed}). The answer is those notes: answer from them.${notesCutShort ? " Some of them were cut off at the output limit, so they are incomplete: tell the user." : ""}` }
          : notesCutShort || result.answerTruncated ? { note: INCOMPLETE_ANALYSIS } : {}),
        answer: result.answer,
      }, limitOf(limits, Math.max(cap, ANALYSIS_RESULT_CHARACTERS)));
    },
  };

  /** `view_pages`: the pages as one small PDF, next to a short JSON result. */
  async function viewPages(args: Record<string, unknown>, limits: ToolCallLimits): Promise<ToolOutput> {
    const id = text(args.document_id, "document_id");
    // The same scope check as the text tools, on its own list: a PDF can be looked at without
    // being searchable, and the other way round.
    if (!viewable.has(id)) {
      throw new Error(allowed.has(id)
        ? `The pages of ${names.get(id) ?? id} cannot be shown: only its text was kept. Answer from the text.`
        : `Unknown document_id ${shownId(id)}. Use the document_id of an attached PDF.`);
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
      throw new Error(`${file}: ${safeErrorMessage(error)}`);
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

  // What a tool could not do goes to the model, and from there to a user's screen: never a server path.
  const failure = (error: unknown): ToolResult => ({ error: safeErrorMessage(error) });

  async function execute(name: string, args: Record<string, unknown>, limits: ToolCallLimits = {}, hooks: ToolCallHooks = {}): Promise<ToolResult> {
    if (!known.has(name)) return { error: `Unknown tool ${unknownToolName(name)}.` };
    // The pages are a file, and this method returns only JSON. Saying that pages are attached
    // with nothing attached would be worse than saying that they could not be shown.
    if (name === TOOL_NAMES.view) return { error: FILES_NOT_DELIVERED };
    try {
      return await handlers[name]!(args, limits, hooks);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return failure(error);
    }
  }

  return {
    declarations,
    has: (name) => known.has(name),
    execute: (name, args) => execute(name, args),
    resultCharacters: (name) => (name === TOOL_NAMES.analyze ? Math.max(cap, ANALYSIS_RESULT_CHARACTERS) : name === TOOL_NAMES.view ? LEAST_RESULT_CHARACTERS : cap),
    async executeWithFiles(name, args, limits = {}, hooks = {}) {
      if (name !== TOOL_NAMES.view || !known.has(name)) return { result: await execute(name, args, limits, hooks), files: [] };
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
        // Read the numbers the way the tool will: a model sometimes sends them as text.
        const from = integer(args.from_page, 1, 1, Number.MAX_SAFE_INTEGER);
        const to = integer(args.to_page, from, from, Number.MAX_SAFE_INTEGER);
        return `Look at ${file} ${to > from ? "pages" : "page"} ${pageRange(from, to)}`;
      }
      if (name === TOOL_NAMES.search) {
        const mode = args.mode === "exact" || args.mode === "regex" ? args.mode : "keywords";
        const { fromLine, toLine, order, groupBy } = searchScope(args);
        const where = fromLine !== undefined || toLine !== undefined ? ` in lines ${fromLine ?? 1}-${toLine ?? "end"}` : "";
        const how = mode === "keywords" ? "" : groupBy ? `, counted by ${groupBy}` : order === "last" ? ", the last ones" : "";
        return `Search ${file} (${mode}) for “${sliceWhole(String(args.query ?? ""), 80)}”${where}${how}`;
      }
      if (name === TOOL_NAMES.read) {
        const start = integer(args.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
        const end = typeof args.end_line === "number" && args.end_line >= start ? `-${Math.trunc(args.end_line)}` : "";
        return `Read ${file} lines ${start}${end}`;
      }
      if (name === TOOL_NAMES.overview) return `Overview of ${file}`;
      if (name === TOOL_NAMES.aggregate) {
        const request = (() => {
          try {
            return aggregateRequest(args);
          } catch {
            return {} as AggregateRequest;
          }
        })();
        const metrics = (request.metrics?.length ? request.metrics : ["count"]).join(", ");
        const by = request.groupBy?.length ? ` by ${request.groupBy.join(", ")}` : "";
        const where = request.filters?.length ? ` where ${request.filters.map((filter) => `${filter.column} ${filter.op}${filter.value !== undefined && filter.value !== "" ? ` ${filter.value}` : ""}`).join(" and ")}` : "";
        const table = request.table !== undefined && request.table !== "" ? ` (${typeof request.table === "number" ? `table ${request.table}` : request.table})` : "";
        return sliceWhole(`Aggregate ${file}${table}: ${metrics}${by}${where}`, 200);
      }
      if (name === TOOL_NAMES.analyze) return `Read all of ${file} for “${sliceWhole(String(args.task ?? ""), 100)}”`;
      return name;
    },
  };
}
