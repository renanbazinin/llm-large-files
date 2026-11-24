// What planning writes and counts that is new in 0.10.0 (P1): card sizes at the edge of a unit
// (LLF-059), the size of a document whose lines are numbered (L12), and the fixed lines the loop
// adds for files sent whole.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, resolveBudget, type DocumentMeta } from "llm-large-files";
import { utf8 } from "llm-large-files/testing";
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

  it("writes it so in get_document_overview too, whose size is a result the model sees", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const line = "a line of a file of one megabyte, less 76 bytes\n";
    const text = line.repeat(Math.floor(1_048_500 / line.length)) + "x".repeat(1_048_500 % line.length);
    const document = await files.ingest({ name: "big.txt", bytes: utf8(text) });
    expect(document.bytes).toBe(1_048_500);
    const overview = await files.tools([document]).execute("get_document_overview", { document_id: document.id });
    // "1024 KB" before 0.10.0.
    expect(overview.size).toBe("1 MB");
  });
});

describe("the cards counted in a plan (PlanOptions.cardSizes)", () => {
  const budget = resolveBudget({ contextTokens: 20_000, reservedTokens: 4_000, inlineTokens: 12_000 });
  const base = { tokens: 0, bytes: 0 };
  const note = (id: string) => meta({ id, estimatedTokens: 100, textBytes: 400, jsonBytes: 420 });
  const card = { tokens: 250, bytes: 1_000 };

  it("keeps whole a file whose card is no smaller than it, over the room or not, within inlineTokens", () => {
    const notes = Array.from({ length: 200 }, (_, i) => note(`doc_n${i}`));
    const cardSizes = new Map(notes.map((document) => [document.id, card]));
    // 200 notes of 100 tokens: 20,000, over the room of 16,000; as cards, 50,000.
    expect(planDocuments(notes, budget, base).inline).toHaveLength(120);
    const counted = planDocuments(notes, budget, base, { cardSizes });
    // inlineTokens still holds: 120 notes.
    expect(counted.inline).toHaveLength(120);
    const roomy = planDocuments(notes, resolveBudget({ contextTokens: 20_000, reservedTokens: 4_000, inlineTokens: 16_000 }), { tokens: 2_000, bytes: 0 }, { cardSizes });
    expect(roomy.inline).toHaveLength(160);
  });

  it("moves a file to the cards when that frees the room, and counts the cards it leaves", () => {
    const runbook = meta({ id: "doc_runbook", estimatedTokens: 9_000, textBytes: 36_000 });
    const log = meta({ id: "doc_log", estimatedTokens: 100_000, textBytes: 400_000 });
    const cardSizes = new Map([[runbook.id, { tokens: 900, bytes: 3_000 }], [log.id, { tokens: 7_500, bytes: 30_000 }]]);
    // As in 0.9, the runbook fits the room of 16,000 tokens, and the log's card is not counted.
    expect(planDocuments([runbook, log], budget, base).inline).toEqual([runbook]);
    // With the log's card counted, 9,000 + 7,500 is over: the runbook goes to the cards.
    expect(planDocuments([runbook, log], budget, base, { cardSizes }).inline).toEqual([]);
    expect(planDocuments([runbook, log], budget, { tokens: 0, bytes: 0 }, { cardSizes: new Map([[runbook.id, { tokens: 900, bytes: 3_000 }], [log.id, { tokens: 6_000, bytes: 30_000 }]]) }).inline).toEqual([runbook]);
    // Pinned, the same: a pin stays only while it fits.
    expect(planDocuments([runbook, log], budget, base, { cardSizes, pinned: [runbook.id] }).inline).toEqual([]);
  });

  it("counts a file sent whole at its measured size when that is larger (PlanOptions.measured)", () => {
    const document = meta({ id: "doc_m", estimatedTokens: 10_000, textBytes: 30_000, jsonBytes: 31_000 });
    const roomy = resolveBudget({ inlineTokens: 12_000 });
    expect(planDocuments([document], roomy, base, { measured: new Map([[document.id, { tokens: 11_000, bytes: 40_000 }]]) })).toMatchObject({ inlineTokens: 11_000, inlineBytes: 40_000 });
    expect(planDocuments([document], roomy, base, { measured: new Map([[document.id, { tokens: 13_000, bytes: 0 }]]) }).inline).toEqual([]);
    // Smaller: the estimate.
    expect(planDocuments([document], roomy, base, { measured: new Map([[document.id, { tokens: 1, bytes: 1 }]]) })).toMatchObject({ inlineTokens: 10_000, inlineBytes: 31_200 });
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
