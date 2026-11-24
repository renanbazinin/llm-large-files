// The facts an answer must hold, and how each is checked. A fact is checked on the answer's text
// only: never on what the model was sent.
import { checkCitations, type CitationCheck, type DocumentFormat, type Evidence } from "../../src/index.js";

/**
 * What an answer must hold. Each is checked on the answer with its markdown emphasis (`**`, `_`,
 * backticks) and direction marks taken out, and its spaces made single:
 * - `{ number, tolerance }`: a number in the answer within `tolerance` of it (thousands separators
 *   are read: 4,167.90 is 4167.9). With `near`, the number must stand after that label on its line,
 *   before any of the `stop` labels: a value tied to its row, not any value of the answer;
 * - `{ says }`: one of these texts or patterns;
 * - `{ mustCite }`: a line citation of `document` at a line that holds `text`, read by
 *   `checkCitations` ("not checked yet" while it is not available): the citation names the file,
 *   or the question has that file alone;
 * - `{ mustNotClaim }`: none of this text, pattern, or number;
 * - `{ language: "he" }`: at least 60% of the answer's letters are Hebrew letters, once citations,
 *   file names, numbers, code (a quoted log line), identifiers (payments-service, /api/v2), names
 *   and acronyms (words that start with a capital), and Latin words in quotes or in parentheses
 *   with no Hebrew (a gloss) are left out.
 */
export type Fact = (
  | { number: number; tolerance?: number; near?: { label: string; stop?: string[] } }
  | { says: string | RegExp | Array<string | RegExp> }
  | { mustCite: { document: string; text: string } }
  | { mustNotClaim: string | RegExp | { number: number } }
  | { language: "he" }
) & {
  /** The fact in words, for the report, in place of its pattern: "says 09:31". A recording compares facts by these words. */
  name?: string;
};

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
  /** The documents of the question: a citation without a file name goes with its one document. All of `names` when not given. */
  documentIds?: string[];
};

/** A fact in words, for the report. */
export function describeFact(fact: Fact): string {
  if (fact.name) return fact.name;
  if ("number" in fact) return `number ${fact.number}${fact.tolerance ? ` ±${fact.tolerance}` : ""}${fact.near ? ` next to ${fact.near.label}` : ""}`;
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

/**
 * The answer as its facts read it: NFC, without direction marks, without markdown emphasis
 * ("ברבעון **2**" reads "ברבעון 2"), with single spaces. An underscore inside a word stays.
 */
export function plainAnswer(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[*`~]/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/[ \t\u00A0\u202F]+/g, " ");
}

const matches = (text: string, pattern: string | RegExp) => (typeof pattern === "string" ? text.toLowerCase().includes(plainAnswer(pattern).toLowerCase()) : new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text));

/** A word as a pattern that does not match inside a longer word ("east" is not in "least"). */
const word = (text: string, flags = "giu") => new RegExp(`(?<![\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, flags);

/** The text after each `label` on its line, up to the first `stop` label: where a value tied to it stands. */
function textNear(text: string, near: { label: string; stop?: string[] }): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(word(near.label))) {
    const from = match.index + match[0].length;
    let to = text.indexOf("\n", from);
    if (to < 0) to = text.length;
    for (const stop of near.stop ?? []) {
      const found = word(stop).exec(text.slice(from, to));
      if (found) to = from + found.index;
    }
    out.push(text.slice(from, to));
  }
  return out;
}

/**
 * Where `text` cites `document`, read by `checkCitations` as it reads `AskResult.citations`: the
 * file name next to a citation, ranges, "line N", the Hebrew "שורה N". `cited` is the first line of
 * each citation of the document; `at` is true when one of them holds a line of `lines`.
 * `CitationCheck` lists only the citations of lines that were not shown, with the first such line:
 * so the document is shown whole but `lines` for `at`, and not at all for `cited`.
 */
export function citationsAt(text: string, document: string, lines: number[], context: Pick<FactContext, "names" | "formats" | "documentIds">): { at: boolean; cited: number[] } {
  const ids = context.documentIds ?? Object.keys(context.names);
  const names = Object.fromEntries([...ids, document].map((id) => [id, context.names[id] ?? id]));
  const name = names[document]!;
  const linesOf = (check: CitationCheck) => check.unsupported.filter((entry) => entry.document === name).map((entry) => entry.line);
  const wanted = [...new Set(lines)].filter((line) => Number.isInteger(line) && line > 0).sort((a, b) => a - b);
  const others: Array<[number, number]> = [];
  let from = 1;
  for (const line of wanted) {
    if (line > from) others.push([from, line - 1]);
    from = line + 1;
  }
  others.push([from, Number.MAX_SAFE_INTEGER]);
  const at = wanted.length > 0 && linesOf(checkCitations(text, [{ tool: "fact", documentId: document, lines: others }], names, context.formats)).some((line) => wanted.includes(line));
  return { at, cited: linesOf(checkCitations(text, [], names, context.formats)) };
}

/**
 * The share of an answer's letters that are Hebrew letters, once citations, file names, numbers,
 * code, identifiers, names, acronyms and Latin glosses are left out. Niqqud and gershayim are not
 * letters, so the share is never above 1.
 */
export function hebrewShare(text: string, names: string[] = []): number {
  // Code blocks and code spans quote the file (a log line), in its language, not the answer's.
  let plain = text.normalize("NFC").replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const name of names) plain = plain.split(name.normalize("NFC")).join(" ");
  plain = plain
    .replace(/\([^()]*\bL\d+[^()]*\)/g, " ")
    .replace(/\bL\d+(?:-\d+)?/g, " ")
    // A gloss in parentheses with no Hebrew in it: "(card processor timeout after 30000ms)".
    .replace(/\([^()\p{Script=Hebrew}]*\)/gu, " ")
    .replace(/[`"“”'‘’][A-Za-z0-9 ._:/,()-]+[`"“”'‘’]/g, " ")
    .replace(/[\w.-]+\.(?:docx|xlsx|pptx|csv|pdf|log|md|txt)\b/gi, " ")
    // Identifiers: payments-service, db-2, /api/v2/payments, worker_3, a.b.
    .replace(/\/?[A-Za-z0-9]+(?:[-_/.:@][A-Za-z0-9]+)+\/?/g, " ")
    .replace(/\b\w*\d\w*\b/g, " ")
    // Names and acronyms: Northwind Traders, Payments API, East. An English answer still has its
    // small words (the, is, of), so it stays mostly Latin.
    .replace(/\b[A-Z][A-Za-z]*\b/g, " ");
  const hebrew = (plain.match(/(?=\p{Script=Hebrew})\p{L}/gu) ?? []).length;
  const letters = (plain.match(/\p{L}/gu) ?? []).length;
  return letters === 0 ? 0 : hebrew / letters;
}

/** `AskResult.citations`, else `checkCitations` of the text; undefined for a version whose checkCitations is a stub. */
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
  const plain = plainAnswer(text);
  if ("number" in fact) {
    const tolerance = fact.tolerance ?? 0.005;
    if (fact.near) {
      const found = textNear(withoutCitations(plain), fact.near).map(numbersIn);
      return result(found.some((values) => values.some((value) => Math.abs(value - fact.number) <= tolerance)), found.length ? `numbers next to ${fact.near.label}: ${found.flat().slice(0, 12).join(", ") || "none"}` : `${fact.near.label} is not in the answer`);
    }
    const found = numbersIn(withoutCitations(plain));
    return result(found.some((value) => Math.abs(value - fact.number) <= tolerance), `numbers in the answer: ${found.slice(0, 12).join(", ") || "none"}`);
  }
  if ("says" in fact) return result([fact.says].flat().some((pattern) => matches(plain, pattern)), "not in the answer");
  if ("mustNotClaim" in fact) {
    const claim = fact.mustNotClaim;
    if (typeof claim === "object" && !(claim instanceof RegExp)) return result(!numbersIn(withoutCitations(plain)).includes(claim.number), `the answer gives ${claim.number}`);
    return result(!matches(plain, claim), "the answer has it");
  }
  if ("language" in fact) {
    const share = hebrewShare(text, Object.values(context.names));
    return result(share >= 0.6, `${Math.round(share * 100)}% of its letters are Hebrew`);
  }
  // mustCite: a citation of the document, as checkCitations reads it, at a line that holds the text.
  if (!citationsOf(text, context)) return { fact: named, status: "not checked yet", detail: "checkCitations is not available in this version" };
  const lines = context.linesWith(fact.mustCite.document, fact.mustCite.text);
  const { at, cited } = citationsAt(text, fact.mustCite.document, lines, context);
  return result(at, `cited ${cited.length ? `L${cited.join(", L")}` : "nothing"} of ${context.names[fact.mustCite.document] ?? fact.mustCite.document}; the fact is at ${lines.length ? `L${lines.join(", L")}` : "no line"}`);
}
