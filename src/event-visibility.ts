import type { AskResult } from "./ask.js";
import type { DocumentRef, EventResult } from "./events.js";
import type { DocumentMeta } from "./types.js";

/**
 * Where a key of `AskResult` goes in the events of a question:
 * - `event`, in the result of `run.finish` and the partial result of `run.error` that `onEvent`
 *   gets (`eventResultOf`): "yes", always; "withResults", only with `AskOptions.eventResults: true`;
 *   "plan", the documents named only (`DocumentRef`), or with `eventResults` their metadata without
 *   what is to stay on the server; "sources", each source without its `quote` unless
 *   `eventResults: true` (since 0.99.14); "no", never.
 * - `sse`, in the result of `run.finish` as `sseMessageOf` sends it to a browser: "yes", "no", or
 *   "sources": each source without its `quote`, whatever `eventResults` says (since 0.99.14).
 * - `ssePartial`, in the partial result of `run.error` as `sseMessageOf` sends it: "yes" or "no".
 *
 * New in 0.99.13.
 */
export type ResultVisibility = {
  event: "yes" | "withResults" | "plan" | "sources" | "no";
  sse: "yes" | "sources" | "no";
  ssePartial: "yes" | "no";
};

/**
 * Where each key of `AskResult` goes in events and SSE. A key added to `AskResult` without a row
 * here does not compile, and a key that has no row (one put on a result at run time) is left out of
 * every event: `eventResultOf` and `sseMessageOf` read this table, and fail closed. The rows of
 * 0.99.12's keys write down what it did; `modelText` (0.99.13) holds the citations that
 * `showCitations: false` hides, so it is never sent to a browser.
 *
 * The order of the rows is the order of the keys in `sseMessageOf`'s JSON: keep it, so that what a
 * browser gets stays byte for byte the same. New in 0.99.13. Since 0.99.14 `anchors` and `sources`
 * (without quotes) reach a browser, and `lineTalk` (counts for your logs) does not; the partial of
 * `run.error` that `sseMessageOf` sends has neither, as it has no text to place chips in.
 */
export const RESULT_VISIBILITY = {
  answered: { event: "yes", sse: "yes", ssePartial: "no" },
  text: { event: "yes", sse: "yes", ssePartial: "no" },
  finish: { event: "yes", sse: "yes", ssePartial: "no" },
  finishReason: { event: "yes", sse: "yes", ssePartial: "no" },
  blockReason: { event: "yes", sse: "yes", ssePartial: "no" },
  citations: { event: "yes", sse: "yes", ssePartial: "no" },
  steps: { event: "yes", sse: "yes", ssePartial: "yes" },
  evidence: { event: "yes", sse: "yes", ssePartial: "yes" },
  turns: { event: "yes", sse: "yes", ssePartial: "no" },
  usage: { event: "yes", sse: "yes", ssePartial: "yes" },
  missing: { event: "yes", sse: "yes", ssePartial: "yes" },
  questionId: { event: "yes", sse: "yes", ssePartial: "no" },
  anchors: { event: "yes", sse: "yes", ssePartial: "no" },
  sources: { event: "sources", sse: "sources", ssePartial: "no" },
  lineTalk: { event: "yes", sse: "no", ssePartial: "no" },
  modelText: { event: "yes", sse: "no", ssePartial: "no" },
  budget: { event: "yes", sse: "no", ssePartial: "no" },
  lastUsage: { event: "yes", sse: "no", ssePartial: "no" },
  toolTurns: { event: "withResults", sse: "no", ssePartial: "no" },
  plan: { event: "plan", sse: "no", ssePartial: "no" },
} as const satisfies Record<keyof AskResult, ResultVisibility>;

/** The row of a key, or undefined for a key with no decision (never one of the table's prototype). */
function visibilityOf(key: string): ResultVisibility | undefined {
  return Object.hasOwn(RESULT_VISIBILITY, key) ? (RESULT_VISIBILITY as Record<string, ResultVisibility>)[key] : undefined;
}

/** The keys `sseMessageOf` sends of a result, in the order it sends them: those of `run.finish`, or of `run.error`'s partial. */
export const SSE_RESULT_KEYS: readonly string[] = Object.entries(RESULT_VISIBILITY).flatMap(([key, rule]) => (rule.sse !== "no" ? [key] : []));
export const SSE_PARTIAL_KEYS: readonly string[] = Object.entries(RESULT_VISIBILITY).flatMap(([key, rule]) => (rule.ssePartial === "yes" ? [key] : []));

/** A document as an event names it. */
export const documentRef = (meta: DocumentMeta): DocumentRef => ({
  id: meta.id,
  name: meta.name,
  format: meta.format,
  estimatedTokens: meta.estimatedTokens,
  ...(meta.pages !== undefined ? { pages: meta.pages } : {}),
});

/** A document's metadata without what is to stay on the server, for an event (since 0.10.0). */
function withoutServerFields(meta: DocumentMeta): Omit<DocumentMeta, "owner" | "scope" | "sha256" | "original" | "metaVersion"> {
  const { owner: _owner, scope: _scope, sha256: _sha256, original: _original, metaVersion: _metaVersion, ...rest } = meta;
  return rest;
}

/**
 * A result as `run.finish` and `run.error` carry it, by `RESULT_VISIBILITY`: a copy, so that a
 * listener cannot change the caller's, without the tool rounds and with the plan naming documents
 * only (both hold text of the documents: tool results, outline headings, the commonest lines of a
 * log) unless `withResults`. Its plan never holds the owner, scope, SHA-256 or original of a
 * document. A key with no row in the table is left out. The keys keep the result's order, with the
 * tool rounds and then the plan last, as before 0.99.13. Moved here from ask.ts in 0.99.13.
 */
export function eventResultOf(result: AskResult, withResults: boolean): EventResult {
  const shown: Record<string, unknown> = {};
  const later: Record<string, unknown> = {};
  let plan: EventResult["plan"] | undefined;
  for (const [key, value] of Object.entries(result)) {
    const rule = visibilityOf(key);
    if (rule?.event === "yes") shown[key] = value;
    else if (rule?.event === "sources") shown[key] = withResults ? value : withoutQuotes(value);
    else if (rule?.event === "withResults" && withResults) later[key] = value;
    else if (rule?.event === "plan") {
      const given = value as AskResult["plan"];
      // The full metadata only with `withResults`, and never what is to stay on the server: who owns
      // a document, its scope, the SHA-256 and the ref of its original.
      plan = withResults
        ? { inline: given.inline.map(withoutServerFields), searchable: given.searchable.map(withoutServerFields) }
        : { inline: given.inline.map(documentRef), searchable: given.searchable.map(documentRef) };
    }
  }
  return { ...shown, ...later, ...(plan ? { plan } : {}) } as EventResult;
}

/** Sources without their quotes: a copy of each that has one (since 0.99.14). Not an array: as it is. */
export function withoutQuotes(sources: unknown): unknown {
  if (!Array.isArray(sources)) return sources;
  return sources.map((source) => {
    if (source === null || typeof source !== "object" || !Object.hasOwn(source, "quote")) return source;
    const { quote: _quote, ...rest } = source as Record<string, unknown>;
    return rest;
  });
}

/** The keys of a result that `sseMessageOf` sends (`keys`: `SSE_RESULT_KEYS` or `SSE_PARTIAL_KEYS`), in their order. */
export function sseResultOf(result: Partial<EventResult>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (result as Record<string, unknown>)[key];
    picked[key] = visibilityOf(key)?.sse === "sources" ? withoutQuotes(value) : value;
  }
  return picked;
}
