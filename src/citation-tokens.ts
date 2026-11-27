// The text of an answer with a token at each chip: for apps that render Markdown, where an offset
// into the text breaks as soon as the text is trimmed or normalized. Browser-safe: no import but
// types. New in 0.99.14.
import type { CitationAnchor } from "./sources.js";

/** The characters around a label: U+27E6 and U+27E7, which Markdown reads as plain text. */
export const TOKEN_OPEN = "⟦";
export const TOKEN_CLOSE = "⟧";

/**
 * `text` with `⟦label⟧` at each anchor's place (`CitationAnchor.at`), in order: "הקנס 30 ש״ח⟦1⟧."
 * Anchors at one place keep their order. An anchor past the end of the text goes at its end. This is
 * what `citationMarkers: "token"` shows, made from the text of `citationMarkers: "remove"`.
 * New in 0.99.14.
 */
export function insertCitationTokens(text: string, anchors: ReadonlyArray<Pick<CitationAnchor, "at" | "label">>): string {
  if (typeof text !== "string") return "";
  const sorted = [...(anchors ?? [])].map((anchor, order) => ({ anchor, order })).sort((left, right) => left.anchor.at - right.anchor.at || left.order - right.order);
  let out = "";
  let from = 0;
  for (const { anchor } of sorted) {
    const at = Math.max(from, Math.min(text.length, Math.trunc(anchor.at)));
    out += text.slice(from, at) + TOKEN_OPEN + String(anchor.label) + TOKEN_CLOSE;
    from = at;
  }
  return out + text.slice(from);
}
