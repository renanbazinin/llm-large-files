import type { Budget } from "./types.js";

/** Defaults sized for a 1M-token model behind a 10 MB request limit. */
export const DEFAULT_BUDGET: Budget = {
  contextTokens: 1_000_000,
  maxRequestBytes: 10_000_000,
  inlineTokens: 200_000,
  reservedTokens: 64_000,
  mapChunkTokens: 100_000,
  maxMapChunks: 30,
  toolResultCharacters: 24_000,
};

/** A model's own limits, which a budget must stay within. */
export type ModelLimits = { contextTokens?: number | undefined; maxRequestBytes?: number | undefined };

const FIELDS = Object.keys(DEFAULT_BUDGET) as Array<keyof Budget>;

/** The fields of a partial budget that were given: a key set to undefined is one that was not. */
export function givenBudget(budget: Partial<Budget> | undefined): Partial<Budget> {
  const given: Partial<Budget> = {};
  for (const field of FIELDS) {
    const value = budget?.[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`budget.${field} must be a number above 0, and is ${String(value)}.`);
    }
    given[field] = value;
  }
  return given;
}

const count = (value: number) => value.toLocaleString("en-US");

/**
 * A whole budget from the fields that were given. What was left out follows the context window:
 * a quarter of it is kept free (64,000 tokens at most), half of it may be document text (200,000
 * at most), a part of a whole-file read is half of it (100,000 at most), and one tool result is
 * about an eighth of it (24,000 characters at most). At the default window of 1M tokens these are
 * the defaults the library always had.
 *
 * Given values that cannot work together are an error. With `limits`, a model's own context window
 * and request size, the budget is made to fit them instead: the smaller window holds, and given
 * values too large for it are lowered.
 */
export function resolveBudget(budget?: Partial<Budget>, limits?: ModelLimits): Budget {
  const given = givenBudget(budget);
  const lowest = (own: number, limit: number | undefined) => (typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.min(own, limit) : own);
  const contextTokens = lowest(given.contextTokens ?? DEFAULT_BUDGET.contextTokens, limits?.contextTokens);
  const maxRequestBytes = lowest(given.maxRequestBytes ?? DEFAULT_BUDGET.maxRequestBytes, limits?.maxRequestBytes);
  // A window that a model made smaller than the one the values were given for: they follow it down.
  const fitted = contextTokens < (given.contextTokens ?? DEFAULT_BUDGET.contextTokens);
  const half = Math.max(1, Math.floor(contextTokens / 2));
  const fit = (value: number | undefined, most: number) => (value === undefined ? undefined : fitted ? Math.min(value, most) : value);
  const resolved: Budget = {
    contextTokens,
    maxRequestBytes,
    inlineTokens: fit(given.inlineTokens, contextTokens) ?? Math.min(DEFAULT_BUDGET.inlineTokens, half),
    reservedTokens: fit(given.reservedTokens, half) ?? Math.min(DEFAULT_BUDGET.reservedTokens, Math.max(1, Math.floor(contextTokens / 4))),
    mapChunkTokens: fit(given.mapChunkTokens, half) ?? Math.min(DEFAULT_BUDGET.mapChunkTokens, half),
    maxMapChunks: given.maxMapChunks ?? DEFAULT_BUDGET.maxMapChunks,
    toolResultCharacters: fit(given.toolResultCharacters, Math.max(1_000, contextTokens)) ?? Math.min(DEFAULT_BUDGET.toolResultCharacters, Math.max(1_000, Math.round(contextTokens * 0.12))),
  };
  if (resolved.reservedTokens >= resolved.contextTokens) {
    throw new Error(`budget.reservedTokens (${count(resolved.reservedTokens)}) must be smaller than budget.contextTokens (${count(resolved.contextTokens)}): nothing would be left for the conversation.`);
  }
  if (resolved.mapChunkTokens >= resolved.contextTokens) {
    throw new Error(`budget.mapChunkTokens (${count(resolved.mapChunkTokens)}) must be smaller than budget.contextTokens (${count(resolved.contextTokens)}): a part of a whole-file read would not fit the model.`);
  }
  return resolved;
}
