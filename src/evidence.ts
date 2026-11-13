// What the tools showed a model, as data: the trail an application can keep with an answer, and
// the short stand-in a tool result leaves behind when the request runs out of room.
import type { ToolCall } from "./model.js";
import { TOOL_NAMES } from "./tools.js";
import type { ToolResult } from "./types.js";

/** A range of lines or pages, 1-based, both ends included. */
export type NumberRange = [from: number, to: number];

/** What one tool call showed the model of one document. */
export type Evidence = {
  /** The tool that was called: "search_document", "read_document", and so on. */
  tool: string;
  documentId: string;
  /** The file's name. */
  document?: string;
  /** The lines the model was shown, as ranges in order. */
  lines?: NumberRange[];
  /** The pages it looked at (`view_pages`), or the pages those lines are on, where the tool said. */
  pages?: NumberRange[];
  /** What was searched for, or the task of a whole-file read. */
  query?: string;
  /** "keywords", "exact" or "regex", for a search. */
  mode?: string;
  /** For an exact or regex search: how many lines match in the whole file. More than were shown, often. */
  totalMatchingLines?: number;
  /** True for a whole-file read: other model calls read every line, and the model saw their answer. */
  whole?: boolean;
};

/** "12-14", "12" or 12 as a range. */
function rangeOf(value: unknown): NumberRange | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return [value, value];
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  return to >= from ? [from, to] : undefined;
}

/** Ranges in order, with those that overlap or touch made one. */
export function mergeRanges(ranges: NumberRange[]): NumberRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: NumberRange[] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

const defined = <T>(values: Array<T | undefined>): T[] => values.filter((value): value is T => value !== undefined);

/**
 * What a tool call showed of a document, read from the call and its result. Undefined for a call
 * that failed, named no document, or was answered with a stand-in for a dropped result.
 */
export function evidenceOf(call: ToolCall, result: ToolResult): Evidence | undefined {
  const documentId = call.args.document_id;
  if (typeof documentId !== "string" || !documentId || typeof result.error === "string" || result.dropped === true) return undefined;
  const entry: Evidence = { tool: call.name, documentId, ...(typeof result.document === "string" ? { document: result.document } : {}) };
  const withRanges = (lines: NumberRange[], pages: NumberRange[]): Evidence => ({
    ...entry,
    ...(lines.length > 0 ? { lines: mergeRanges(lines) } : {}),
    ...(pages.length > 0 ? { pages: mergeRanges(pages) } : {}),
  });
  switch (call.name) {
    case TOOL_NAMES.read:
      return withRanges(defined([rangeOf(result.lines)]), defined([rangeOf(result.pages)]));
    case TOOL_NAMES.search: {
      const query = typeof call.args.query === "string" ? { query: call.args.query } : {};
      const mode = typeof result.mode === "string" ? { mode: result.mode } : {};
      if (Array.isArray(result.passages)) {
        const passages = result.passages as Array<{ lines?: unknown; pages?: unknown }>;
        return { ...withRanges(defined(passages.map((passage) => rangeOf(passage.lines))), defined(passages.map((passage) => rangeOf(passage.pages)))), ...query, ...mode };
      }
      const matches = (Array.isArray(result.matches) ? result.matches : []) as Array<{ line?: unknown; page?: unknown; before?: unknown; after?: unknown }>;
      const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
      const lines = defined(matches.map((match): NumberRange | undefined => (typeof match.line === "number" ? [Math.max(1, match.line - count(match.before)), match.line + count(match.after)] : undefined)));
      return {
        ...withRanges(lines, defined(matches.map((match) => rangeOf(match.page)))),
        ...query,
        ...mode,
        ...(typeof result.total_matching_lines === "number" ? { totalMatchingLines: result.total_matching_lines } : {}),
      };
    }
    case TOOL_NAMES.overview: {
      const total = typeof result.lines === "number" ? result.lines : 0;
      if (total < 1) return entry;
      return withRanges(total > 30 ? [[1, 30], [Math.max(1, total - 19), total]] : [[1, total]], []);
    }
    case TOOL_NAMES.analyze:
      return { ...entry, whole: true, ...(typeof call.args.task === "string" ? { query: call.args.task } : {}) };
    case TOOL_NAMES.view:
      return withRanges([], defined([rangeOf(result.pages)]));
    default:
      return entry;
  }
}

/** Below this a result is left as it is: a stand-in would save next to nothing. */
const SMALL_RESULT_CHARACTERS = 700;
/** What is kept of the answer of a whole-file read, which cannot be asked for again. */
const KEPT_ANSWER_CHARACTERS = 6_000;
const MOST_RANGES = 60;

const rangeText = ([from, to]: NumberRange) => (to > from ? `${from}-${to}` : String(from));

/**
 * A short stand-in for a tool result that is dropped from the request to make room: it keeps
 * which document it was about and which lines or pages it showed, so the model can read them
 * again, and says that it is a stand-in. Undefined when there is nothing to gain: the result is an
 * error, is small already, or is such a stand-in. `hadFiles` is true for a result whose files
 * (pages) are dropped with it, however small its JSON is.
 */
export function stubResult(call: ToolCall, result: ToolResult, hadFiles = false): ToolResult | undefined {
  if (typeof result.error === "string" || result.dropped === true) return undefined;
  if (!hadFiles && JSON.stringify(result).length < SMALL_RESULT_CHARACTERS) return undefined;
  const evidence = evidenceOf(call, result);
  const base: ToolResult = { ...(typeof result.document === "string" ? { document: result.document } : {}), dropped: true };
  const lines = evidence?.lines?.slice(0, MOST_RANGES).map(rangeText);
  switch (call.name) {
    case TOOL_NAMES.read:
      return {
        ...base,
        ...(typeof result.lines === "string" ? { lines: result.lines } : {}),
        ...(typeof result.total_lines === "number" ? { total_lines: result.total_lines } : {}),
        note: "These lines were shown to you earlier and were dropped from the conversation to make room. Read them again with read_document if you need them.",
      };
    case TOOL_NAMES.search:
      return {
        ...base,
        ...(typeof result.mode === "string" ? { mode: result.mode } : {}),
        ...(typeof call.args.query === "string" ? { query: call.args.query.slice(0, 200) } : {}),
        ...(typeof result.total_matching_lines === "number" ? { total_matching_lines: result.total_matching_lines } : {}),
        ...(lines && lines.length > 0 ? { lines_shown: lines } : {}),
        note: "The results of this search were shown to you earlier and were dropped from the conversation to make room. Read the lines listed here with read_document, or search again, if you need them.",
      };
    case TOOL_NAMES.analyze: {
      const answer = typeof result.answer === "string" ? result.answer : "";
      return {
        ...base,
        ...(typeof result.parts_read === "number" ? { parts_read: result.parts_read } : {}),
        answer: answer.length > KEPT_ANSWER_CHARACTERS ? `${answer.slice(0, KEPT_ANSWER_CHARACTERS)}…` : answer,
        note: "This is the start of the answer of the whole-file read. The rest was dropped from the conversation to make room.",
      };
    }
    case TOOL_NAMES.view:
      return {
        ...base,
        ...(typeof result.pages === "string" ? { pages: result.pages } : {}),
        ...(typeof result.total_pages === "number" ? { total_pages: result.total_pages } : {}),
        note: "These pages were shown to you earlier and are no longer attached. Look at them again with view_pages if you need them.",
      };
    case TOOL_NAMES.overview:
      return { ...base, note: "The overview was shown to you earlier and was dropped from the conversation to make room. Call get_document_overview again if you need it." };
    default:
      return { ...base, note: "This result was shown to you earlier and was dropped from the conversation to make room." };
  }
}
