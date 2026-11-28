// The names of the tools, as the model calls them. A module of its own since 0.99.14 (it was in
// tools.ts), with no import but types, for the browser entry (`llm-large-files/client`).
import type { ToolName } from "./types.js";

export const TOOL_NAMES = {
  search: "search_document",
  read: "read_document",
  overview: "get_document_overview",
  analyze: "analyze_whole_document",
  view: "view_pages",
  aggregate: "aggregate_table",
} as const satisfies Record<string, ToolName>;
