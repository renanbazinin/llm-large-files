// A whole-file read that lists items (`output: "items"`, new in 0.10.0, M9): each part replies with
// JSON lines, code checks each item against its line and counts them, with no merge and no final
// request. A synthetic Hebrew contract has 37 penalty clauses among 200.
import { describe, expect, it } from "vitest";
import { createLargeFiles, estimateTokens, evidenceOf, MemoryDocumentStore, stubResult, type GenerateText, type ToolResult } from "../src/index.js";
import { parseItemLines, quoteForm, quoteOnLine } from "../src/map-reduce.js";
import { wholeReadCost } from "../src/whole-cost.js";
import { utf8 } from "./fake-model.js";

const BREACHES = ["איחור בתגובה לקריאת שירות דחופה", "אי הגשת דוח תחזוקה חודשי במועד", "החלפת טכנאי ללא הודעה מוקדמת", "שימוש בחלקי חילוף שאינם מקוריים", "הפרת הוראות הבטיחות באתר"];

/** A Hebrew service contract: a title, the parties, and 200 numbered clauses, 37 of which set a fine (קנס), the word in no other line. */
function contract(): { text: string; penaltyLines: number[] } {
  const lines = ["חוזה שירותי תחזוקה מס' 2026/114", "שנערך ונחתם בין חברת אורן מערכות בע\"מ (\"המזמין\") לבין חברת קור-טק שירותים בע\"מ (\"הספק\")."];
  const penalties = new Set(Array.from({ length: 37 }, (_, k) => 5 + Math.round(k * 5.3)));
  const penaltyLines: number[] = [];
  for (let clause = 1; clause <= 200; clause++) {
    if (penalties.has(clause)) {
      penaltyLines.push(lines.length + 1);
      lines.push(`${clause}. בגין ${BREACHES[clause % BREACHES.length]} באתר ${clause % 5} ישלם הספק למזמין קנס בסך ${(1_000 + clause * 50).toLocaleString("en-US")} ש"ח לכל מקרה.`);
    } else {
      lines.push(`${clause}. הספק יבצע ביקור תחזוקה חודשי באתר ${clause % 5}, וימסור דוח על הביקור למנהל האתר בתוך שבעה ימים.`);
    }
  }
  if (penaltyLines.length !== 37) throw new Error("The contract must have 37 penalty clauses.");
  return { text: lines.join("\n"), penaltyLines };
}

async function library(budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 1_500, ...budget } });
  const { text, penaltyLines } = contract();
  const meta = await files.ingest({ name: "חוזה תחזוקה.txt", bytes: utf8(text) });
  return { files, meta, penaltyLines };
}

/** The numbered lines of a part read's prompt, by number. */
function partLines(prompt: string): Array<[number, string]> {
  const body = prompt.slice(prompt.indexOf("<part>\n") + "<part>\n".length, prompt.indexOf("\n</part>"));
  return body.split("\n").map((line) => {
    const bar = line.indexOf("| ");
    return [Number(line.slice(0, bar)), line.slice(bar + 2)];
  });
}

/** The items of a part as a careful model lists them: each penalty line, with its amount and a quote from it. */
function penaltyItems(prompt: string): Array<{ line: number; label: string; value: string; quote: string }> {
  return partLines(prompt).flatMap(([line, text]) => {
    const at = text.indexOf("קנס");
    if (at === -1) return [];
    return [{ line, label: "penalty", value: /קנס בסך ([\d,]+)/.exec(text)![1]!, quote: text.slice(at, at + 24) }];
  });
}

type Sent = { system: string; prompt: string };

/** A part reader that lists the penalty items, and keeps what each request sent. */
function lister(sent: Sent[], write: (items: ReturnType<typeof penaltyItems>, prompt: string) => string = (items) => items.map((item) => JSON.stringify(item)).join("\n")): GenerateText {
  return async ({ system, prompt }) => {
    sent.push({ system, prompt });
    const items = penaltyItems(prompt);
    return items.length ? write(items, prompt) : "NOTHING RELEVANT";
  };
}

const TASK = "List every clause that sets a fine (קנס) the supplier pays.";

describe("a read that lists items", () => {
  it("counts the 37 planted penalty clauses of a Hebrew contract, one request a part", async () => {
    const { files, meta, penaltyLines } = await library();
    const sent: Sent[] = [];
    const tools = files.tools([meta], { generate: lister(sent) });
    const result = await tools.execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    expect(result).toMatchObject({ document: "חוזה תחזוקה.txt", total_items: 37, counts_by_label: { penalty: 37 }, unverified_items: 0 });
    expect(result.note).toBeUndefined();
    const items = result.items as Array<{ line: number; label: string; value: string; quote: string }>;
    expect(items.map((item) => item.line)).toEqual(penaltyLines);
    expect(items[0]).toEqual({ line: penaltyLines[0], label: "penalty", value: "1,250", quote: expect.stringMatching(/^קנס בסך 1,250/) });
    // No merge, no answer of the read: a request for each part, and each part read once.
    expect(sent.length).toBe(result.parts_read);
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every((request) => request.prompt.includes("<part>"))).toBe(true);
    expect(result.answer).toBeUndefined();
  });

  it("is priced at the requests it makes, and near the tokens it sends (wholeReadCost)", async () => {
    const { files, meta } = await library();
    const sent: Sent[] = [];
    const result = await files.tools([meta], { generate: lister(sent) }).execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    const price = wholeReadCost(meta, files.budget, 1, "items");
    expect(price.requests).toBe(sent.length);
    expect(price).toMatchObject({ parts: result.parts_read, merges: 0 });
    const tokens = sent.reduce((sum, request) => sum + estimateTokens(request.system) + estimateTokens(request.prompt), 0);
    expect(price.inputTokens).toBeGreaterThanOrEqual(tokens);
    expect(price.inputTokens).toBeLessThanOrEqual(tokens * 1.15);
    // Less than a read that answers, which merges and answers too.
    expect(price.inputTokens).toBeLessThan(wholeReadCost(meta, files.budget, 1).inputTokens);
  });

  it("does not count an item whose quote is not on its line, or whose line is not in its part", async () => {
    const { files, meta } = await library();
    const sent: Sent[] = [];
    let planted = 0;
    const generate = lister(sent, (items, prompt) => {
      const lines = partLines(prompt);
      const extra = planted < 1
        ? [
          // A quote of another line of the part: not on its line.
          JSON.stringify({ line: items[0]!.line, label: "penalty", value: "99", quote: lines.find(([, text]) => !text.includes("קנס"))![1].slice(4, 30) }),
          // A line outside the part.
          JSON.stringify({ line: lines.at(-1)![0] + 500, label: "penalty", value: "1", quote: "קנס" }),
          // No quote at all.
          JSON.stringify({ line: items[0]!.line, label: "penalty", value: "7" }),
        ]
        : [];
      planted += extra.length;
      return [...items.map((item) => JSON.stringify(item)), ...extra].join("\n");
    });
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    expect(planted).toBe(3);
    expect(result).toMatchObject({ total_items: 37, unverified_items: 3 });
    expect(result.note).toBe("3 listed items are not counted: their line is not in the part that listed them, or their quote is not on that line.");
  });

  it("reads replies leniently, and counts an item listed twice once", async () => {
    const { files, meta } = await library();
    const sent: Sent[] = [];
    let part = 0;
    const generate = lister(sent, (items) => {
      part++;
      const lines = items.map((item) => JSON.stringify(item));
      // In turn: prose and a fence around the lines; list marks and commas; a JSON array; the same item twice.
      if (part % 4 === 1) return ["Here are the items:", "```json", ...lines, "```"].join("\n");
      if (part % 4 === 2) return lines.map((line, index) => `${index + 1}. ${line},`).join("\n");
      if (part % 4 === 3) return `[${lines.join(",\n")}]`;
      return [...lines, lines[0]!, JSON.stringify({ ...items[0]!, label: "PENALTY " })].join("\n");
    });
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    expect(part).toBeGreaterThanOrEqual(4);
    expect(result).toMatchObject({ total_items: 37, counts_by_label: { penalty: 37 }, unverified_items: 0 });
  });

  it("reads a part again in halves when its list is cut at the output limit, two levels at most", async () => {
    const { files, meta } = await library({ mapChunkTokens: 3_000 });
    // A list of more than 3 items does not fit: the reply stops after 3, and says it was cut.
    const truncating = (sent: Sent[]): GenerateText => async ({ system, prompt, onTruncated }) => {
      sent.push({ system, prompt });
      const items = penaltyItems(prompt);
      if (items.length > 3) onTruncated?.();
      return items.length ? items.slice(0, 3).map((item) => JSON.stringify(item)).join("\n") : "NOTHING RELEVANT";
    };
    const sent: Sent[] = [];
    const halved = await files.tools([meta], { generate: truncating(sent) }).execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    const parts = wholeReadCost(meta, files.budget, 1, "items").parts;
    expect(sent.length).toBeGreaterThan(parts);
    expect(sent.some((request) => /\nThis is part \d+ of \d+, first half, second half\.\n/.test(request.prompt))).toBe(true);
    expect(sent.some((request) => /, first half, first half, first half\./.test(request.prompt))).toBe(false);
    expect(halved.total_items).toBeGreaterThan(30);
    expect(halved.total_items).toBeLessThanOrEqual(37);

    // Within the requests the question has left: none to halve with, so the cut lists are counted, and said to be cut.
    const tightSent: Sent[] = [];
    const tight = await files.tools([meta], { generate: truncating(tightSent) })
      .executeWithFiles("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] }, { maxRequests: parts });
    expect(tightSent).toHaveLength(parts);
    expect(tight.result).toMatchObject({ parts_read: parts, parts_cut_short: expect.any(Number) });
    expect(String(tight.result.note)).toMatch(/listed more items than fit the model's output limit, even read in smaller pieces, so items may be missing: tell the user the count may be incomplete\.$/);
  });

  it("refuses more than 12 labels, or a label of more than 40 characters, before it counts a read", async () => {
    const { files, meta } = await library();
    const sent: Sent[] = [];
    const tools = files.tools([meta], { generate: lister(sent) });
    const many = Array.from({ length: 13 }, (_, index) => `kind ${index}`);
    expect(await tools.execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: many })).toEqual({ error: "labels takes up to 12 labels, each up to 40 characters." });
    expect(await tools.execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["x".repeat(41)] })).toEqual({ error: "labels takes up to 12 labels, each up to 40 characters." });
    expect(sent).toHaveLength(0);
    expect(tools.wholeReadsLeft?.(meta.id)).toBe(1);
    // Without labels, the prompt asks for none; a label the model gives all the same is kept, and counted.
    const plain = await tools.execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items" });
    expect(plain.total_items).toBe(37);
    expect(plain.counts_by_label).toEqual({ penalty: 37 });
    expect(sent[0]!.prompt).not.toContain("- label:");
  });

  it("gives the lines of its items as evidence, and keeps its counts in a stand-in", async () => {
    const { files, meta, penaltyLines } = await library();
    const call = { id: "c1", name: "analyze_whole_document", args: { document_id: meta.id, task: TASK, output: "items" } };
    const result: ToolResult = await files.tools([meta], { generate: lister([]) }).execute(call.name, call.args);
    expect(evidenceOf(call, result)).toEqual({
      tool: "analyze_whole_document", documentId: meta.id, document: "חוזה תחזוקה.txt", whole: true, query: TASK,
      lines: penaltyLines.map((line) => [line, line]),
    });
    const stub = stubResult(call, result)!;
    expect(stub).toMatchObject({ dropped: true, total_items: 37, unverified_items: 0, parts_read: result.parts_read });
    expect(stub.items).toHaveLength(20);
    expect(JSON.stringify(stub).length).toBeLessThan(JSON.stringify(result).length);
  });
});

describe("quoteOnLine", () => {
  const line = "17. בגין איחור באספקה ישלם הספק למזמין קנס בסך 5,000 ש\"ח לכל מקרה, וכן יחזיר כספים ששולמו.";

  it("finds a quote copied from the line, with Hebrew points or final letters written another way", () => {
    expect(quoteOnLine("קנס בסך 5,000 ש\"ח", line)).toBe(true);
    expect(quoteOnLine("קְנָס בְּסַךְ 5,000", line)).toBe(true);
    // A word cut before its final letter: כסף and כספים.
    expect(quoteOnLine("יחזיר כסף", line)).toBe(true);
    // Curly quotes, the line number copied with it, quote marks around it, and a quote cut with an ellipsis.
    expect(quoteOnLine("קנס בסך 5,000 ש”ח", line)).toBe(true);
    expect(quoteOnLine("17| בגין איחור באספקה", line)).toBe(true);
    expect(quoteOnLine("\"ישלם הספק למזמין\".", line)).toBe(true);
    expect(quoteOnLine("בגין איחור … קנס בסך 5,000", line)).toBe(true);
    expect(quoteOnLine("INFO Worker   started", "2026 info worker started")).toBe(true);
  });

  it("does not find words that are not on the line, nor an empty quote", () => {
    expect(quoteOnLine("קנס בסך 6,000", line)).toBe(false);
    expect(quoteOnLine("קנס בסך … ביטול החוזה", line)).toBe(false);
    // The pieces of a quote cut with an ellipsis must come in their order.
    expect(quoteOnLine("קנס בסך … בגין איחור", line)).toBe(false);
    expect(quoteOnLine("", line)).toBe(false);
    expect(quoteOnLine("…", line)).toBe(false);
  });

  it("compares in one form, quoteForm", () => {
    expect(quoteForm("  שָׁלוֹם   עוֹלָם ")).toBe("שלומ עולמ");
    expect(quoteForm("Don’t STOP")).toBe("don't stop");
  });
});

describe("parseItemLines", () => {
  it("reads JSON lines, a JSON array, list marks and fences, and counts the lines it skips", () => {
    expect(parseItemLines('{"line": 3, "quote": "a"}\n{"line": 4, "quote": "b"}')).toEqual({ objects: [{ line: 3, quote: "a" }, { line: 4, quote: "b" }], skipped: 0 });
    expect(parseItemLines('```json\n[{"line": 3, "quote": "a"}, {"line": 4, "quote": "b"}]\n```')).toEqual({ objects: [{ line: 3, quote: "a" }, { line: 4, quote: "b" }], skipped: 0 });
    expect(parseItemLines('Items:\n- {"line": 3, "quote": "a"},\n2) {"line": 4, "quote": "b"}\n{"line": 5, "quote": ')).toEqual({ objects: [{ line: 3, quote: "a" }, { line: 4, quote: "b" }], skipped: 2 });
    expect(parseItemLines("**NOTHING RELEVANT**")).toEqual({ objects: [], skipped: 0 });
    expect(parseItemLines("")).toEqual({ objects: [], skipped: 0 });
    expect(parseItemLines("[1, 2]")).toEqual({ objects: [], skipped: 2 });
  });
});
