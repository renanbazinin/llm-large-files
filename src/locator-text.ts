// How the question reads a document's stored text for its locators (0.99.14): a key on the tool
// set of `files.tools()`, kept off the public type. Internal.

/** The key of a tool set's reader of a document's whole stored text, with the access of its calls. */
export const LOCATOR_TEXT = Symbol("llm-large-files.locatorText");

export type LocatorTextSource = (id: string, signal?: AbortSignal) => Promise<string | undefined>;

/** The reader of a tool set, when it has one (one `files.tools()` made). */
export function locatorTextOf(tools: unknown): LocatorTextSource | undefined {
  const reader = tools !== null && typeof tools === "object" ? (tools as Record<symbol, unknown>)[LOCATOR_TEXT] : undefined;
  return typeof reader === "function" ? (reader as LocatorTextSource) : undefined;
}

/** The key of a whole-file read's result where the lines its notes cite, and its failed parts, are kept (CIT-9): a symbol, so JSON never sends it. */
export const READ_LINES = Symbol("llm-large-files.readLines");

/** `result` with `lines` kept under `READ_LINES`, not enumerable: the result sent is unchanged. */
export function withReadLines<T extends object>(result: T, lines: { noted: Array<[number, number]>; failed: Array<[number, number]> } | undefined): T {
  if (lines) Object.defineProperty(result, READ_LINES, { value: lines, enumerable: false });
  return result;
}

/** The lines a whole-file read's notes cite, and its failed parts, when its result kept them. */
export function readLinesOf(result: unknown): { noted: Array<[number, number]>; failed: Array<[number, number]> } | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const lines = (result as Record<symbol, unknown>)[READ_LINES];
  return lines !== null && typeof lines === "object" ? (lines as { noted: Array<[number, number]>; failed: Array<[number, number]> }) : undefined;
}
