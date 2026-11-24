// The price of a whole-file read before it starts (src/whole-cost.ts, new in 0.10.0), against what
// the read sends. Until 0.10.0 the loop priced a read at the document's own tokens, which leaves out
// the line numbers, the prompts and the merges of notes: about 9% under what probe5's read sends.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, estimateTokens, MemoryDocumentStore, resolveBudget, type DocumentMeta, type GenerateText, type LargeFiles } from "llm-large-files";
import { ITEMS_FRAME_TOKENS, MAX_ITEM_LABELS, MAX_LABEL_CHARACTERS, PART_HEADING_TOKENS, PART_OUTPUT_TOKENS, REQUEST_FRAME_TOKENS } from "../src/map-reduce.js";
import { numberLines } from "../src/search.js";
import { estimateMerges, lineNumberDigits, wholeReadCost } from "../src/whole-cost.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

/** Notes of a part that say little, as in probe5. */
const SHORT_NOTES = "Nothing much (L1).";
/** Notes of a part of 2,634 tokens, as in probe5: enough for two merges. */
const LONG_NOTES = `Notes (L1) ${"important finding ".repeat(900)}`;
/** Notes of a part of 4,094 tokens: just under the output limit of a part, the most a price counts. */
const FULL_NOTES = `Notes (L1) ${"important finding ".repeat(1_400)}`;

/** probe5's document: a service log of 20,000 lines (1.77 MB), read in parts of 60,000 tokens. */
let probe: Promise<{ files: LargeFiles; meta: DocumentMeta }> | undefined;
const probeLog = () => (probe ??= (async () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 60_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
  return { files, meta };
})());

/**
 * probe5's read, through the tool loop and a fake model whose part reader answers `notes` to every
 * request: what the read sends, counted as the library counts tokens (`estimateTokens` of each
 * request's system text and prompt), and how many requests it makes.
 */
async function readWhole(notes: string) {
  const { files, meta } = await probeLog();
  const sent = { inputTokens: 0, requests: 0 };
  const generateText: GenerateText = async ({ system, prompt }) => {
    sent.inputTokens += estimateTokens(system) + estimateTokens(prompt);
    sent.requests++;
    return notes;
  };
  const read = { id: "c1", name: "analyze_whole_document", args: { document_id: meta.id, task: "list every failure with its time" } };
  const model = fakeModel([calls([read]), says("Done.")], { generateText });
  const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "List every failure with its time." }] });
  expect(result.evidence).toEqual([expect.objectContaining({ tool: "analyze_whole_document", whole: true })]);
  return { meta, budget: result.budget, sent };
}

describe("wholeReadCost", () => {
  it("prices probe5's read within 5% of what the library sends, where the document's own tokens are 9% under", async () => {
    const short = await readWhole(SHORT_NOTES);
    const long = await readWhole(LONG_NOTES);
    const price = wholeReadCost(short.meta, short.budget, 1);
    // 25 parts and the read's answer; with long notes, two merges between them.
    expect(short.sent.requests).toBe(26);
    expect(long.sent.requests).toBe(28);
    expect(price).toMatchObject({ parts: 25, merges: 2, requests: 28 });
    expect(price.inputTokens).toBeGreaterThanOrEqual(short.sent.inputTokens * 0.95);
    expect(price.inputTokens).toBeLessThanOrEqual(long.sent.inputTokens * 1.05);
    // The price of 0.9 (`meta.estimatedTokens`) is more than 5% under even the cheapest of these reads.
    expect(short.meta.estimatedTokens).toBeLessThan(short.sent.inputTokens * 0.95);
  }, 60_000);

  it("is within 2% of a read whose notes reach the output limit, with the same requests", async () => {
    expect(estimateTokens(FULL_NOTES)).toBeGreaterThan(PART_OUTPUT_TOKENS - 10);
    expect(estimateTokens(FULL_NOTES)).toBeLessThanOrEqual(PART_OUTPUT_TOKENS);
    const full = await readWhole(FULL_NOTES);
    const price = wholeReadCost(full.meta, full.budget, 1);
    expect(price.requests).toBe(full.sent.requests);
    expect(Math.abs(price.inputTokens - full.sent.inputTokens) / full.sent.inputTokens).toBeLessThan(0.02);
  }, 60_000);

  it("counts in the model's own tokens, and prices a small file as one part and the answer", () => {
    const budget = resolveBudget({ mapChunkTokens: 60_000 });
    const meta = { estimatedTokens: 1_000, lines: 99, textBytes: 4_000 };
    // 99 lines: 189 digits of line numbers. One part with its prompt, then the read's answer from its notes.
    const tokens = 1_000 + 1.2 * 189 + 1.5 * 99 + REQUEST_FRAME_TOKENS + PART_OUTPUT_TOKENS + 25 + REQUEST_FRAME_TOKENS;
    expect(wholeReadCost(meta, budget, 1)).toEqual({ inputTokens: Math.ceil(tokens), requests: 2, parts: 1, merges: 0 });
    expect(wholeReadCost(meta, budget, 1.35).inputTokens).toBe(Math.ceil(tokens * 1.35));
    expect(Number.isNaN(wholeReadCost({ estimatedTokens: Number.NaN, lines: 1, textBytes: 1 }, budget, 1).inputTokens)).toBe(true);
  });

  it("prices a read that lists items as its parts alone, with the longer rules of a list", () => {
    const budget = resolveBudget({ mapChunkTokens: 60_000 });
    const meta = { estimatedTokens: 1_000, lines: 99, textBytes: 4_000 };
    // One part: its numbered lines and its prompt. No merge, no answer of the read.
    const tokens = 1_000 + 1.2 * 189 + 1.5 * 99 + ITEMS_FRAME_TOKENS;
    expect(wholeReadCost(meta, budget, 1, "items")).toEqual({ inputTokens: Math.ceil(tokens), requests: 1, parts: 1, merges: 0 });
    expect(wholeReadCost(meta, budget, 2, "items").inputTokens).toBe(Math.ceil(tokens * 2));
  });
});

describe("the frame of a part read, which a price counts for each part", () => {
  /** A task of a few lines: 160 characters. */
  const TASK = "List every clause that sets a fine the supplier pays, with its amount and the site it applies to. Leave out fines that are only proposed. Give the date of each.";
  /** The most labels a read takes, each of the most characters, in Hebrew. */
  const LABELS = Array.from({ length: MAX_ITEM_LABELS }, (_, k) => [...`${k + 1} קנס בגין איחור בתגובה לקריאת שירות דחופה באתר הצפוני`].slice(0, MAX_LABEL_CHARACTERS).join(""));

  /**
   * What each part read of `text` sends besides its numbered lines, by `estimateTokens`: its
   * system text, where it is, the task and the rules, and the heading it starts under, if any.
   */
  async function frames(name: string, text: string, args: Record<string, unknown>, mapChunkTokens = 60_000) {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens } });
    const meta = await files.ingest({ name, bytes: utf8(text) });
    const lines = text.split("\n");
    const sent: Array<{ system: string; prompt: string }> = [];
    const generateText: GenerateText = async ({ system, prompt }) => {
      sent.push({ system, prompt });
      return "NOTHING RELEVANT";
    };
    await files.tools([meta], { generate: generateText }).execute("analyze_whole_document", { document_id: meta.id, ...args });
    const parts = sent.filter((request) => request.system.startsWith("You read one part"));
    return {
      meta,
      files,
      frames: parts.map(({ system, prompt }) => {
        const [, from, to] = /lines (\d+)-(\d+)/.exec(prompt)!.map(Number);
        return estimateTokens(system) + estimateTokens(prompt) - estimateTokens(numberLines(lines.slice(from! - 1, to), from!));
      }),
      sent: parts.reduce((sum, { system, prompt }) => sum + estimateTokens(system) + estimateTokens(prompt), 0),
    };
  }

  it("is within ITEMS_FRAME_TOKENS for a list with 12 labels of 40 characters and a task of a few lines", async () => {
    const { frames: [items] } = await frames("הסכם ניקיון.txt", "שורה אחת.\nשורה שנייה.", { task: TASK, output: "items", labels: LABELS });
    // 0.10.0 before this fix: 400, under what this part sends.
    expect(items).toBeGreaterThan(550);
    expect(items).toBeLessThanOrEqual(ITEMS_FRAME_TOKENS);
    const { frames: [notes] } = await frames("הסכם ניקיון.txt", "שורה אחת.\nשורה שנייה.", { task: TASK });
    expect(notes).toBeLessThanOrEqual(REQUEST_FRAME_TOKENS);
  });

  it("is within REQUEST_FRAME_TOKENS for a read of notes with a Hebrew task of a few lines", async () => {
    const task = [..."פרט כל סעיף בחוזה שקובע קנס שהספק משלם למזמין, עם הסכום שלו והאתר שהוא חל עליו. השמט קנסות שרק הוצעו ולא נקבעו. ציין גם את התאריך של כל אחד מהם ואת שם המפקח שאישר אותו"].slice(0, 160).join("");
    expect(task.length).toBe(160);
    const { frames: [notes] } = await frames("הסכם ניקיון.txt", "שורה אחת.\nשורה שנייה.", { task });
    // 0.10.0 before this fix: 200, under what this part sends.
    expect(notes).toBeGreaterThan(200);
    expect(notes).toBeLessThanOrEqual(REQUEST_FRAME_TOKENS);
  });

  it("counts the heading a part starts under, cut to 120 characters, for each part after the first of a file with an outline", async () => {
    // A heading of 120 characters in Hebrew, the longest an outline takes, and 400 lines under it.
    const heading = `# ${[..."פרק 12: דוח התחזוקה הרבעוני של האתרים הצפוניים, עם הקנסות וההפרות שהוטלו על הספק בגין איחורים בתגובה לקריאות שירות דחופות"].slice(0, 118).join("")}`;
    expect(heading.length).toBe(120);
    const text = [heading, ...Array.from({ length: 400 }, (_, k) => `רישום ${k}: המשאבה באתר ${k % 7} נבדקה ונמצאה תקינה.`)].join("\n");
    for (const output of ["answer", "items"] as const) {
      const read = await frames("יומן.md", text, { task: TASK, output }, 2_000);
      expect(read.meta.outline).toEqual([expect.objectContaining({ line: 1 })]);
      expect(read.frames.length).toBeGreaterThan(2);
      // The first part starts with the heading's line itself; each other part is sent the heading first.
      const extra = read.frames[1]! - read.frames[0]!;
      expect(extra).toBeGreaterThan(40);
      expect(extra).toBeLessThanOrEqual(PART_HEADING_TOKENS);
      // The price counts it for each part after the first, and none for a file without an outline.
      const price = wholeReadCost(read.meta, read.files.budget, 1, output);
      expect(price.parts).toBe(read.frames.length);
      expect(price.inputTokens - wholeReadCost({ ...read.meta, outline: [] }, read.files.budget, 1, output).inputTokens).toBe((price.parts - 1) * PART_HEADING_TOKENS);
      expect(wholeReadCost({ ...read.meta, format: "log" }, read.files.budget, 1, output).inputTokens).toBe(wholeReadCost({ ...read.meta, outline: [] }, read.files.budget, 1, output).inputTokens);
      if (output === "items") expect(price.inputTokens).toBeGreaterThanOrEqual(read.sent);
    }
  });
});

describe("lineNumberDigits", () => {
  it("counts the digits of the line numbers 1 to n", () => {
    const written = (lines: number) => Array.from({ length: lines }, (_, index) => String(index + 1).length).reduce((sum, digits) => sum + digits, 0);
    for (const lines of [0, 1, 9, 10, 99, 100, 999, 1_000, 12_345, 20_000]) expect(lineNumberDigits(lines)).toBe(written(lines));
    // probe5's 20,000 lines: 9 of one digit, 90 of two, 900 of three, 9,000 of four and 10,001 of five.
    expect(lineNumberDigits(20_000)).toBe(88_894);
  });
});

describe("estimateMerges", () => {
  it("merges nothing when the notes fit one request together", () => {
    expect(estimateMerges(1, 4_096, 60_000)).toEqual({ requests: 0, inputTokens: 0, finalTokens: 4_121 });
    expect(estimateMerges(14, 4_096, 60_000)).toEqual({ requests: 0, inputTokens: 0, finalTokens: 14 * 4_121 });
  });

  it("merges in batches that fit, round after round", () => {
    // 25 notes of 4,121 tokens: batches of 14, so 2 merges, whose notes then fit together.
    expect(estimateMerges(25, 4_096, 60_000)).toEqual({ requests: 2, inputTokens: 25 * 4_121 + 2 * REQUEST_FRAME_TOKENS, finalTokens: 2 * 4_121 });
    // 400 notes in batches of 2: 200 merges, then 100, 50, 25, 13, 7, 4 and 2, whose 2 notes fit 10,000.
    expect(estimateMerges(400, 4_096, 10_000)).toMatchObject({ requests: 200 + 100 + 50 + 25 + 13 + 7 + 4 + 2, finalTokens: 2 * 4_121 });
  });

  it("merges in pairs when no two notes fit one batch, for 8 rounds at most", () => {
    // 5 notes larger than a batch: 3, then 2, then 1 merge.
    expect(estimateMerges(5, 4_096, 4_000).requests).toBe(6);
    // 1,000 notes: 500, 250, 125, 63, 32, 16, 8, 4, and the rounds stop with 4 notes.
    expect(estimateMerges(1_000, 4_096, 4_000)).toMatchObject({ requests: 500 + 250 + 125 + 63 + 32 + 16 + 8 + 4, finalTokens: 4 * 4_121 });
  });
});
