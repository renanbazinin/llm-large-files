// The facts an answer must hold, and how each is checked. A fact is checked on the answer's text
// only: never on what the model was sent.
import { checkCitations, type CitationCheck, type DocumentFormat, type Evidence } from "../../src/index.js";

/**
 * What an answer must hold:
 * - `{ number, tolerance }`: a number in the answer within `tolerance` of it (thousands separators
 *   are read: 4,167.90 is 4167.9);
 * - `{ says }`: one of these texts or patterns;
 * - `{ mustCite }`: a line citation of `document` at a line that holds `text` (checked with
 *   `checkCitations`; "not checked yet" while it is not available);
 * - `{ mustNotClaim }`: none of this text, pattern, or number;
 * - `{ language: "he" }`: at least 60% of the answer's letters are Hebrew, once citations, file
 *   names, numbers and Latin words in quotes are left out.
 */
export type Fact =
  | { number: number; tolerance?: number }
  | { says: string | RegExp | Array<string | RegExp> }
  | { mustCite: { document: string; text: string } }
  | { mustNotClaim: string | RegExp | { number: number } }
  | { language: "he" };

/** How a fact came out: "not checked yet" when what checks it is not in this version. */
export type FactStatus = "pass" | "fail" | "not checked yet";
export type FactResult = { fact: string; status: FactStatus; detail?: string };

/** What a check needs beyond the text: the evidence of the answer, and the documents' names and lines. */
export type FactContext = {
  evidence: Evidence[];
  names: Record<string, string>;
  formats: Record<string, DocumentFormat>;
  linesWith(id: string, phrase: string): number[];
  /** `AskResult.citations`, when the version fills it. */
  citations?: CitationCheck;
};

/** A fact in words, for the report. */
export function describeFact(fact: Fact): string {
  if ("number" in fact) return `number ${fact.number}${fact.tolerance ? ` ±${fact.tolerance}` : ""}`;
  if ("says" in fact) return `says ${[fact.says].flat().map(String).join(" or ")}`;
  if ("mustCite" in fact) return `cites ${fact.mustCite.document} at "${fact.mustCite.text}"`;
  if ("mustNotClaim" in fact) {
    const claim = fact.mustNotClaim;
    return `does not claim ${typeof claim === "object" && !(claim instanceof RegExp) ? `the number ${claim.number}` : String(claim)}`;
  }
  return `answers in ${fact.language === "he" ? "Hebrew" : fact.language}`;
}

/** The numbers of a text, with thousands separators read. */
export function numbersIn(text: string): number[] {
  const plain = text.replace(/(?<=\d)[,٬’'](?=\d{3}(?!\d))/g, "");
  return [...plain.matchAll(/(?<![\d.])\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/** The text without its line citations in the library's form (L12, L12-14), whose numbers are no answer. */
const withoutCitations = (text: string) => text.replace(/\bL\d+(?:\s*[-–]\s*L?\d+)?\b/g, " ");

const matches = (text: string, pattern: string | RegExp) => (typeof pattern === "string" ? text.normalize("NFC").toLowerCase().includes(pattern.normalize("NFC").toLowerCase()) : pattern.test(text));

/** The line citations of a text: "L12", "L12-14", "שורה 12", "שורות 12-14", "Row 12", "line 12". */
export function citedLines(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const match of text.matchAll(/(?:\bL|\blines?\s+|\bRows?\s+|שורו?ת\s*|שורה\s*)(\d+)(?:\s*[-–]\s*L?(\d+))?/gi)) {
    const from = Number(match[1]);
    out.push([from, match[2] ? Number(match[2]) : from]);
  }
  return out;
}

/** The share of an answer's letters that are Hebrew, once citations, file names, numbers and quoted Latin words are left out. */
export function hebrewShare(text: string, names: string[] = []): number {
  let plain = text;
  for (const name of names) plain = plain.split(name).join(" ");
  plain = plain
    .replace(/\([^()]*\bL\d+[^()]*\)/g, " ")
    .replace(/\bL\d+(?:-\d+)?/g, " ")
    .replace(/[`"“”'‘’][A-Za-z0-9 ._:/-]+[`"“”'‘’]/g, " ")
    .replace(/[\w.-]+\.(?:docx|xlsx|pptx|csv|pdf|log|md|txt)\b/gi, " ")
    .replace(/\b[A-Za-z]+-\d+\b|\b\w*\d\w*\b/g, " ");
  const hebrew = (plain.match(/\p{Script=Hebrew}/gu) ?? []).length;
  const letters = (plain.match(/\p{L}/gu) ?? []).length;
  return letters === 0 ? 0 : hebrew / letters;
}

/** `checkCitations` of this version, or undefined while it is not written yet. */
export function citationsOf(text: string, context: FactContext): CitationCheck | undefined {
  if (context.citations) return context.citations;
  try {
    return checkCitations(text, context.evidence, context.names, context.formats);
  } catch (error) {
    if (error instanceof Error && /not available yet/.test(error.message)) return undefined;
    throw error;
  }
}

/** Checks one fact on an answer. */
export function checkFact(fact: Fact, text: string, context: FactContext): FactResult {
  const named = describeFact(fact);
  const result = (ok: boolean, detail?: string): FactResult => ({ fact: named, status: ok ? "pass" : "fail", ...(detail && !ok ? { detail } : {}) });
  if ("number" in fact) {
    const found = numbersIn(withoutCitations(text));
    const tolerance = fact.tolerance ?? 0.005;
    return result(found.some((value) => Math.abs(value - fact.number) <= tolerance), `numbers in the answer: ${found.slice(0, 12).join(", ") || "none"}`);
  }
  if ("says" in fact) return result([fact.says].flat().some((pattern) => matches(text, pattern)), "not in the answer");
  if ("mustNotClaim" in fact) {
    const claim = fact.mustNotClaim;
    if (typeof claim === "object" && !(claim instanceof RegExp)) return result(!numbersIn(withoutCitations(text)).includes(claim.number), `the answer gives ${claim.number}`);
    return result(!matches(text, claim), "the answer has it");
  }
  if ("language" in fact) {
    const share = hebrewShare(text, Object.values(context.names));
    return result(share >= 0.6, `${Math.round(share * 100)}% of its letters are Hebrew`);
  }
  // mustCite: once checkCitations works, a citation of a line that holds the text.
  const citations = citationsOf(text, context);
  if (!citations) return { fact: named, status: "not checked yet", detail: "checkCitations is not available in this version" };
  const lines = context.linesWith(fact.mustCite.document, fact.mustCite.text);
  const cited = citedLines(text);
  return result(citations.checked > 0 && cited.some(([from, to]) => lines.some((line) => line >= from && line <= to)), `cited ${cited.map(([from, to]) => (from === to ? `L${from}` : `L${from}-${to}`)).join(", ") || "nothing"}; the fact is at L${lines.join(", L")}`);
}
