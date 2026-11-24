// What planning writes and counts that is new in 0.10.0 (P1): card sizes at the edge of a unit
// (LLF-059), the size of a document whose lines are numbered (L12), and the fixed lines the loop
// adds for files sent whole.
import { describe, expect, it } from "vitest";
import { resolveBudget, type DocumentMeta } from "llm-large-files";
import {
  CITATION_EXAMPLE_NAME,
  estimateParts,
  formatBytes,
  formatCount,
  INLINE_CITATION_LINE,
  INLINE_TABLES_LINE,
  numberedSize,
  planDocuments,
  renderCard,
} from "../src/plan.js";

/** Metadata made by hand: only what planning and a card read. */
function meta(fields: Partial<DocumentMeta> & Pick<DocumentMeta, "id">): DocumentMeta {
  return {
    name: `${fields.id}.log`,
    mimeType: "text/plain",
    format: "log",
    bytes: 1_000,
    textBytes: 1_000,
    characters: 1_000,
    lines: 10,
    estimatedTokens: 300,
    wrappedLines: 0,
    outline: [],
    createdAt: "2026-11-20T08:00:00.000Z",
    expiresAt: "2026-11-21T08:00:00.000Z",
    ...fields,
  };
}

const sizeLine = (document: DocumentMeta) => renderCard(document, "1| a").split("\n")[2];

describe("card sizes at the edge of a unit (LLF-059)", () => {
  it("writes a count that rounds to 1,000K in millions", () => {
    expect(sizeLine(meta({ id: "doc_a", bytes: 1_048_000, estimatedTokens: 999_500, lines: 1_000 }))).toBe("log · 1023 KB · 1,000 lines · about 1.0M tokens");
    expect(formatCount(999_500)).toBe("1.0M");
    expect(formatCount(999_499)).toBe("999K");
    expect(formatCount(1_000_000)).toBe("1.0M");
    expect(formatCount(1_250_000)).toBe("1.3M");
    expect(formatCount(10_000)).toBe("10K");
    expect(formatCount(9_999)).toBe("9,999");
  });

  it("writes a size that rounds to 1,024 KB in MB", () => {
    expect(sizeLine(meta({ id: "doc_b", bytes: 1_048_500, estimatedTokens: 400_000, lines: 1_000 }))).toBe("log · 1 MB · 1,000 lines · about 400K tokens");
    expect(formatBytes(1_048_500)).toBe("1 MB");
    expect(formatBytes(1_048_575)).toBe("1 MB");
    expect(formatBytes(1_048_000)).toBe("1023 KB");
    expect(formatBytes(1_048_576)).toBe("1 MB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
    expect(formatBytes(1_023)).toBe("1023 B");
  });
});

describe("the size of a document with numbered lines (L12)", () => {
  it("adds 1.2 tokens a digit and 1.5 a line, and in bytes the digits and 4 a line", () => {
    // 120 lines: 9 numbers of one digit, 90 of two and 21 of three, 252 digits.
    const document = meta({ id: "doc_c", lines: 120, estimatedTokens: 5_000, textBytes: 10_000, jsonBytes: 10_400 });
    const size = numberedSize(document);
    expect(size.tokens).toBeCloseTo(5_000 + 1.2 * 252 + 1.5 * 120, 6);
    expect(size.bytes).toBe(10_400 + 252 + 4 * 120);
    // Without `jsonBytes` (a document of 0.4.0), 8% over the text, as planning assumes.
    expect(numberedSize({ ...document, jsonBytes: undefined }).bytes).toBeCloseTo(10_000 * 1.08 + 252 + 480, 6);
  });

  it("is what estimateParts counts the parts of a whole-file read by", () => {
    const budget = resolveBudget({ mapChunkTokens: 4_000 });
    const document = meta({ id: "doc_d", lines: 3_000, estimatedTokens: 60_000, textBytes: 200_000 });
    const { tokens } = numberedSize(document);
    // A part ends at the end of a line: short of full by half a line on average.
    expect(estimateParts(document, budget)).toBe(Math.ceil(tokens / (4_000 - tokens / 3_000 / 2)));
  });

  it("plans a document at the edge of inlineTokens by its numbered size", () => {
    const document = meta({ id: "doc_e", lines: 400, estimatedTokens: 10_000, textBytes: 30_000 });
    const numbered = Math.ceil(numberedSize(document).tokens);
    expect(numbered).toBeGreaterThan(10_000);
    const budget = resolveBudget({ inlineTokens: 10_000 });
    const base = { tokens: 0, bytes: 0 };
    // As in 0.9: the text alone fits.
    expect(planDocuments([document], budget, base).inline).toEqual([document]);
    // Numbered, it does not.
    const plan = planDocuments([document], budget, base, { numbered: true });
    expect(plan.inline).toEqual([]);
    expect(plan.searchable).toEqual([document]);
    // With room for it, its numbered size is what the plan counts.
    const roomy = planDocuments([document], resolveBudget({ inlineTokens: numbered }), base, { numbered: true });
    expect(roomy.inline).toEqual([document]);
    expect(roomy.inlineTokens).toBe(numbered);
    expect(roomy.inlineBytes).toBe(Math.ceil(numberedSize(document).bytes) + 200);
  });
});

describe("the fixed lines for files sent whole", () => {
  it("are the plan's words, with an example name that is never a real file's", () => {
    expect(INLINE_TABLES_LINE).toBe("Files shown in full can still be counted exactly: use aggregate_table for counts, sums and groups over their tables, and search_document exact for matching lines. In a spreadsheet, give the Row number when asked which row.");
    expect(CITATION_EXAMPLE_NAME).toBe("report.docx");
    expect(INLINE_CITATION_LINE).toBe("Cite line numbers like (report.docx L12).");
  });
});
