// A whole-file read that lists items (`output: "items"`, new in 0.10.0, M9): each part replies with
// JSON lines, code checks each item against its line and counts them, with no merge and no final
// request. A synthetic Hebrew contract has 37 penalty clauses among 200.
import { describe, expect, it } from "vitest";
import { createLargeFiles, estimateTokens, evidenceOf, MemoryDocumentStore, stubResult, type GenerateText, type ToolResult } from "../src/index.js";
import { ITEMS_FRAME_TOKENS, parseItemLines, quoteForm, quoteNearLine, quoteOnLine } from "../src/map-reduce.js";
import { MAX_LINE_CHARACTERS } from "../src/text.js";
import { fitAnswer } from "../src/tools.js";
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
    // The numbered lines are priced near what they take; the rest of each part, within the room
    // ITEMS_FRAME_TOKENS keeps for 12 labels and a task of a few lines. In these parts of 1,500
    // tokens, the frames are a third of the price.
    const lines = sent.reduce((sum, request) => sum + estimateTokens(request.prompt.slice(request.prompt.indexOf("<part>\n") + 7, request.prompt.indexOf("\n</part>"))), 0);
    expect(Math.abs(price.inputTokens - price.parts * ITEMS_FRAME_TOKENS - lines)).toBeLessThanOrEqual(lines * 0.1);
    expect(tokens - lines).toBeLessThanOrEqual(price.parts * ITEMS_FRAME_TOKENS);
    // Less than a read that answers, which merges and answers too.
    expect(price.inputTokens).toBeLessThan(wholeReadCost(meta, files.budget, 1).inputTokens);
  });

  it("does not count an item whose quote is on no line of its part, or on several but not its own", async () => {
    const { files, meta } = await library();
    const sent: Sent[] = [];
    let planted = 0;
    const generate = lister(sent, (items) => {
      const extra = planted < 1
        ? [
          // A quote that is not in the file.
          JSON.stringify({ line: items[0]!.line, label: "penalty", value: "99", quote: "קנס בסך 99,999 ש\"ח" }),
          // A quote of many lines of the part, but not of the line it names, nor of a line in the part.
          JSON.stringify({ line: items[0]!.line + 500, label: "penalty", value: "1", quote: "וימסור דוח על הביקור" }),
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
    expect(result.note).toBe("3 listed items are not counted: their quote is not on the line they name, nor on just one other line of the part.");
  });

  it("moves an item to the one line of its part that has its quote, as when a clause's number is taken for its line", async () => {
    const { files, meta, penaltyLines } = await library();
    // The lines of the contract start with their clause's number ("7| 5. …"), two below its line:
    // the model names the clause, not the line.
    const generate = lister([], (items, prompt) => items.map((item) => JSON.stringify({ ...item, line: item.line - 2 })).join("\n") + (prompt.includes("<part>\n1| ") ? `\n${JSON.stringify({ line: 3, label: "penalty", value: "1", quote: "ישלם הספק למזמין" })}` : ""));
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    expect(result).toMatchObject({ total_items: 37, unverified_items: 1 });
    expect((result.items as Array<{ line: number }>).map((item) => item.line)).toEqual(penaltyLines);
  });

  it("gives an item named by its clause's number, its quote copied with a letter wrong, the one line near it that starts with that number", async () => {
    const { files, meta, penaltyLines } = await library();
    // As Gemini Flash-Lite listed the part of lines 1-47 of the eval's contract (0.10.0's live
    // measures): clause 5 for line 7 ("7| 5. …"), and ישלם copied as שילם. The quote is on no line,
    // and not near line 5, which holds clause 3.
    const generate = lister([], (items) => items.map((item) => JSON.stringify({ ...item, line: item.line - 2, quote: `שילם הספק למזמין קנס בסך ${item.value} ש"ח לכל מקרה` })).join("\n"));
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    // 0.10.0 before this fix: 0 counted, 37 unverified.
    expect(result).toMatchObject({ total_items: 37, unverified_items: 0 });
    expect((result.items as Array<{ line: number }>).map((item) => item.line)).toEqual(penaltyLines);
  });

  it("reads a value whose quote mark and letter were both escaped (ש\\\"\\ח), as Flash-Lite writes them", async () => {
    const { files, meta } = await library();
    const generate = lister([], (items) => items.map((item) => JSON.stringify({ ...item, value: `${item.value} ש"ח` }).replace('ש\\"ח"', 'ש\\"\\ח"')).join("\n"));
    const sent: string[] = [];
    const watching: GenerateText = async (request) => {
      const text = await generate(request);
      sent.push(text);
      return text;
    };
    const result = await files.tools([meta], { generate: watching }).execute("analyze_whole_document", { document_id: meta.id, task: TASK, output: "items", labels: ["penalty"] });
    expect(sent.join("\n")).toContain('ש\\"\\ח"');
    expect(result).toMatchObject({ total_items: 37, unverified_items: 0 });
    expect((result.items as Array<{ value: string }>)[0]!.value).toBe('1,250 ש"ח');
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

  it("counts labels named like the members of every object", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1 } });
    const lines = ["1. the constructor pays a fine of 100", "2. the constructor pays a fine of 200", "3. the owner pays a fee of 300", "4. late delivery costs 400"];
    const meta = await files.ingest({ name: "c.txt", bytes: utf8(lines.join("\n")) });
    const generate: GenerateText = async () => [
      { line: 1, label: "constructor", value: "100", quote: "the constructor pays a fine of 100" },
      { line: 2, label: "constructor", value: "200", quote: "the constructor pays a fine of 200" },
      { line: 3, label: "__proto__", value: "300", quote: "the owner pays a fee of 300" },
      { line: 4, label: "toString", value: "400", quote: "late delivery costs 400" },
    ].map((item) => JSON.stringify(item)).join("\n");
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: "fines", output: "items", labels: ["constructor", "__proto__", "toString"] });
    expect(result.total_items).toBe(4);
    // 0.10.0 before this fix: "function Object() { [native code] }11" for constructor, and no __proto__.
    expect(JSON.parse(JSON.stringify(result.counts_by_label))).toEqual(JSON.parse('{"constructor": 2, "__proto__": 1, "toString": 1}'));
  });

  it("says so when items were listed and none is on its line, and ends the task with a stop", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1 } });
    const meta = await files.ingest({ name: "f.txt", bytes: utf8(["1. a fine of 100", "2. a fee of 200", "3. late delivery"].join("\n")) });
    const wrong: GenerateText = async () => [1, 2, 3].map((line) => JSON.stringify({ line, quote: "words not in the file" })).join("\n");
    const tools = files.tools([meta], { generate: wrong, maxWholeDocumentReads: 2 });
    // 0.10.0 before this fix: "No part of f.txt listed an item for: fines 3 listed items are not counted: …".
    expect((await tools.execute("analyze_whole_document", { document_id: meta.id, task: "fines", output: "items" })).note)
      .toBe("No item was found on its line for: fines. 3 listed items are not counted: their quote is not on the line they name, nor on just one other line of the part.");
    const none = files.tools([meta], { generate: async () => "NOTHING RELEVANT" });
    expect((await none.execute("analyze_whole_document", { document_id: meta.id, task: "Every fine?", output: "items" })).note).toBe("No part of f.txt listed an item for: Every fine?");
  });

  it("cut to its room, says how many items it shows, and counts the others in more_items", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1, mapChunkTokens: 100_000 } });
    const lines = Array.from({ length: 120 }, (_, index) => `${index + 1}. the supplier pays a fine of ${1_000 + index} for breach ${index + 1}`);
    const meta = await files.ingest({ name: "f.txt", bytes: utf8(lines.join("\n")) });
    const generate: GenerateText = async () => lines.map((text, index) => JSON.stringify({ line: index + 1, value: String(1_000 + index), quote: text.slice(text.indexOf("the")) })).join("\n");
    const tools = files.tools([meta], { generate });
    const { result } = await tools.executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "fines", output: "items" }, { maxResultCharacters: 3_000 });
    const shown = (result.items as unknown[]).length;
    expect(shown).toBeLessThan(50);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(3_000);
    // 0.10.0 before this fix: more_items stayed 70, and the note was a search's ("Showing K of 50 results … read specific lines.").
    expect(result).toMatchObject({ total_items: 120, more_items: 120 - shown, unverified_items: 0 });
    expect(result.note).toBe(`The first ${shown} items are shown, to stay within the size limit; total_items counts them all.`);
    expect(Object.keys(result)).toEqual(["document", "total_items", "items", "more_items", "unverified_items", "parts_read", "note"]);
    // Fitted again to less room, as askWithFiles does: the same, from what it still shows.
    const again = fitAnswer(result, 2_000);
    const left = (again.items as unknown[]).length;
    expect(left).toBeLessThan(shown);
    expect(again).toMatchObject({ total_items: 120, more_items: 120 - left, note: `The first ${left} items are shown, to stay within the size limit; total_items counts them all.` });
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

  it("finds a quote on a line with direction marks or joiners in it, which a model does not copy", () => {
    // An RLM around the number, as Hebrew text from Word and PDF files has; 0.10.0 before this fix refused these.
    expect(quoteOnLine("קנס בסך 5,000 ש\"ח", "17. בגין איחור ישלם הספק קנס בסך \u200f5,000\u200f ש\"ח לכל מקרה.")).toBe(true);
    expect(quoteOnLine("Fine of 5,000 NIS", "Fine of \u200e5,000\u200e NIS")).toBe(true);
    expect(quoteOnLine("קנס בסך 5,000", "קנס בסך\u061c 5,000")).toBe(true);
    expect(quoteOnLine("קנסבסך 5,000", "קנס\u200cבסך 5,000")).toBe(true);
    // And the other way round: a mark the model wrote into its quote.
    expect(quoteOnLine("קנס בסך \u200f5,000", line)).toBe(true);
    expect(quoteOnLine("קנס בסך 6,000", "קנס בסך \u200f5,000")).toBe(false);
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

describe("quoteNearLine", () => {
  // Lines of the eval's cleaning agreement, and quotes Gemini Flash-Lite copied of them, live (0.10.0's measures).
  const offset = "3. המזמין רשאי לקזז 810 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה.";
  const lowered = "58. במקרה של נזק לרהוט במהלך הניקיון יופחתו 760 ש\"ח מהתמורה החודשית של הספק.";

  it("finds a long quote with a few letters copied wrong, and the same numbers", () => {
    expect(quoteOnLine("מקוזז 810 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה", offset)).toBe(false);
    expect(quoteNearLine("מקוזז 810 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה", offset)).toBe(true);
    expect(quoteNearLine("המזמין רשאי לקזז 810 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרים פתוחה.", offset)).toBe(true);
    expect(quoteNearLine("במקרה של נזק לרהוט במהלך הניקוי יופחתו 760 ש\"ח מהתמורה החודשית של הספק.", lowered)).toBe(true);
    // Short quotes, and quotes cut with an ellipsis, with a letter of each piece copied wrong (ש"ץ for ש"ח).
    expect(quoteNearLine("מקוזז 1,670 ש\"ץ", "91. המזמין רשאי לקזז 1,670 ש\"ח מכל תשלום לספק בגין אי ניקוי השירותים בקומה לפי הלוח.")).toBe(true);
    expect(quoteNearLine("המזמין רשאי … השרים פתוחה", offset)).toBe(true);
    expect(quoteNearLine("במקרה של נזק לרהוט... יופחתו 760 ש\"ץ", lowered)).toBe(true);
  });

  it("does not find a quote with another amount, a short quote, one cut with an ellipsis, or other words", () => {
    // Another amount: the quote of the same clause of another site, or a number misread.
    expect(quoteNearLine("המזמין רשאי לקזז 310 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה.", offset)).toBe(false);
    expect(quoteNearLine("המזמין רשאי לקזז 8,100 ש\"ח מכל תשלום לספק", offset)).toBe(false);
    expect(quoteNearLine("רשאי לקזוז 810", offset)).toBe(false);
    expect(quoteNearLine("מקוזז 810 ש\"ץ", offset)).toBe(false);
    expect(quoteNearLine("המזמין רשאי … חלונות המטבח", offset)).toBe(false);
    expect(quoteNearLine("הספק ישלם קנס בגין איחור באספקת חומרי ניקוי", offset)).toBe(false);
    expect(quoteNearLine("ניקיון יומי של החדרים", lowered)).toBe(false);
  });

  describe("on a line longer than ingest stores, as a store of your own may give", () => {
    // 400 clauses of a contract written to one pattern, each with its own amount, on one line of
    // about 33,000 characters. Measured along all of a line of 118,759 characters, a quote of 270
    // took 688 ms (0.10.0 before this fix), for each item that was not on its line.
    const amount = (clause: number) => (1_000 + clause * 7).toLocaleString("en-US");
    const clause = (k: number) => `${k + 1}. המזמין רשאי לקזז ${amount(k)} ש"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה באתר ${k % 9}.`;
    const long = Array.from({ length: 400 }, (_, k) => clause(k)).join(" ");
    /** The cells the near check would fill along all of the line. */
    const along = (quote: string) => [...quoteForm(quote)].length * long.length;

    it("finds a quote with a letter wrong around a word of it that is rare on the line, and measures only there", () => {
      expect(long.length).toBeGreaterThan(15 * MAX_LINE_CHARACTERS);
      const work = { cells: 0 };
      // Clause 300 with השרים for השרתים: its amount is in one place on the line.
      const near = `המזמין רשאי לקזז ${amount(299)} ש"ח מכל תשלום לספק בגין השארת דלת חדר השרים פתוחה`;
      expect(quoteNearLine(near, long, work)).toBe(true);
      expect(work.cells).toBeGreaterThan(0);
      expect(work.cells).toBeLessThan(along(near) / 100);
      // Another amount than the clause's, or other words around the amount: not near.
      expect(quoteNearLine(near.replace(amount(299), "9,999"), long)).toBe(false);
      expect(quoteNearLine(`הספק ישלם קנס בסך ${amount(299)} ש"ח בגין איחור באספקת חומרי ניקוי`, long)).toBe(false);
    });

    it("stays within a few windows of the quote for many quotes not on the line", () => {
      // The quotes of 100 fines of another kind, each with an amount of the line: each is measured
      // around its amount. 0.10.0 before this fix measured each along all of the line.
      const quotes = Array.from({ length: 100 }, (_, k) => `הספק ישלם קנס בסך ${amount(k * 3)} ש"ח בגין איחור באספקת חומרי ניקוי לאתר`);
      const work = { cells: 0 };
      expect(quotes.filter((quote) => quoteNearLine(quote, long, work))).toEqual([]);
      const most = quotes.reduce((sum, quote) => sum + along(quote), 0);
      expect(work.cells).toBeGreaterThan(0);
      expect(work.cells).toBeLessThan(most / 100);
      // At most 2 words of 4 places each, a window of twice the quote and its margin around each.
      for (const quote of quotes.slice(0, 5)) {
        const each = { cells: 0 };
        quoteNearLine(quote, long, each);
        const letters = [...quoteForm(quote)].length;
        expect(each.cells).toBeLessThanOrEqual(2 * 4 * 2 * Math.ceil(letters * 1.2) * letters);
      }
    });

    it("stays within a few windows of each piece of a quote cut with an ellipsis into many short pieces", () => {
      // 16 pieces of 15 letters, each of another clause, with לקזוז for לקזז: none is on the line,
      // and each is near a run of it. 0.10.0 before this fix chose by the piece's letters times the
      // line's characters, which a short piece kept under its bound, and so measured each piece
      // along all of the line (41 pieces on a line of 118,759 characters: 677 ms).
      const pieces = Array.from({ length: 16 }, (_, k) => `לקזוז ${amount(k * 25)} ש"ח`);
      const quote = pieces.join(" … ");
      const letters = pieces.map((piece) => [...quoteForm(piece)].length);
      expect(letters.every((each) => each === 15)).toBe(true);
      expect(pieces.every((piece) => !long.includes(piece))).toBe(true);
      const work = { cells: 0 };
      expect(quoteNearLine(quote, long, work)).toBe(true);
      // Measured along all of the line, each piece would fill its letters times the line's characters.
      const along = letters.reduce((sum, each) => sum + each * long.length, 0);
      expect(work.cells).toBeGreaterThan(0);
      expect(work.cells).toBeLessThan(along / 100);
      // Each piece: at most 2 words of 4 places each, a window of the piece and its margin around
      // each, the margin at most a fifth of the quote's letters.
      const most = Math.floor(letters.reduce((sum, each) => sum + each, 0) * 0.2);
      expect(work.cells).toBeLessThanOrEqual(letters.reduce((sum, each) => sum + 2 * 4 * 2 * (each + most) * each, 0));
    });

    it("does not measure a quote none of whose words is rare on the line, which a stored line of the same text measures whole", () => {
      // Clause 1 without its amount, and with השרים for השרתים: near a line the library stores.
      const quote = "המזמין רשאי לקזז ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרים פתוחה";
      const stored = Array.from({ length: 22 }, (_, k) => clause(k)).join(" ");
      expect(stored.length).toBeLessThanOrEqual(MAX_LINE_CHARACTERS);
      expect(quoteNearLine(quote, stored)).toBe(true);
      // On the long line each of its words is in 400 places, or in none: it is not looked for.
      const work = { cells: 0 };
      expect(quoteNearLine(quote, long, work)).toBe(false);
      expect(work.cells).toBe(0);
    });

    it("finds a quote on a long line with letters outside the BMP", () => {
      const emoji = Array.from({ length: 400 }, (_, k) => `📄 ${clause(k)}`).join(" 🔒 ");
      expect(quoteNearLine(`📄 300. המזמין רשאי לקזז ${amount(299)} ש"ח מכל תשלום לספק בגין השארת דלת חדר השרים`, emoji)).toBe(true);
      expect(quoteNearLine(`📄 הספק ישלם קנס בסך ${amount(299)} ש"ח בגין איחור באספקת חומרי ניקוי`, emoji)).toBe(false);
    });
  });

  it("lets an item with such a quote count on the line it names, and no other", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1 } });
    const meta = await files.ingest({ name: "ניקיון.txt", bytes: utf8(["הסכם שירותי ניקיון", offset, lowered, "4. הספק יבצע ניקיון יומי."].join("\n")) });
    const generate: GenerateText = async () => [
      { line: 2, value: "810", quote: "מקוזז 810 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה" },
      { line: 3, value: "760", quote: "במקרה של נזק לרהוט במהלך הניקוי יופחתו 760 ש\"ח מהתמורה החודשית של הספק." },
      // Near line 2, but named on line 4: not moved by a near match.
      { line: 4, value: "810", quote: "רשאי לקזז 810 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרים" },
    ].map((item) => JSON.stringify(item)).join("\n");
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: "sanctions", output: "items" });
    // 0.10.0 before this fix: 0 counted, 3 unverified.
    expect(result).toMatchObject({ total_items: 2, unverified_items: 1 });
    expect((result.items as Array<{ line: number }>).map((item) => item.line)).toEqual([2, 3]);
  });
  it("does not give an item a line by its number when two lines of the part start with it and are near its quote", async () => {
    // A file whose numbering starts again in each chapter: clause 5 of each sets the same offset.
    const chapters = (second: string) => [
      "הסכם שירותי ניקיון",
      "פרק א",
      offset.replace(/^3\./, "5."),
      "6. הספק יבצע ניקיון יומי של המשרדים.",
      "7. הספק יבצע ניקיון יומי של המטבח.",
      "פרק ב",
      `${second} המזמין רשאי לקזז 810 ש"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה באגף ב.`,
    ].join("\n");
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1 } });
    // Named for clause 5, on line 5, which holds clause 7, with לקזז copied as מקוזז.
    const generate: GenerateText = async () => JSON.stringify({ line: 5, value: "810", quote: "מקוזז 810 ש\"ח מכל תשלום לספק בגין השארת דלת חדר השרתים פתוחה" });
    const read = async (text: string) => {
      const meta = await files.ingest({ name: "ניקיון.txt", bytes: utf8(text) });
      return files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: "sanctions", output: "items" });
    };
    // One line starts with 5: the item is given it.
    const one = await read(chapters("8."));
    expect(one).toMatchObject({ total_items: 1, unverified_items: 0 });
    expect((one.items as Array<{ line: number }>).map((item) => item.line)).toEqual([3]);
    // Lines 3 and 7 both start with 5 and are near the quote: either may be the item's, so neither is taken.
    expect(await read(chapters("5."))).toMatchObject({ total_items: 0, unverified_items: 1 });
    // Nor a line that starts with a longer number, 50 or 5.1.
    for (const longer of ["50.", "5.1"]) {
      const kept = await read(chapters(longer));
      expect((kept.items as Array<{ line: number }>).map((item) => item.line), longer).toEqual([3]);
    }
  });

  it("counts an item whose quote had a \\u escape with three hex digits, on its line", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1 } });
    const meta = await files.ingest({ name: "ניקיון.txt", bytes: utf8(["הסכם שירותי ניקיון", "4. בגין הפרת הוראות הבטיחות באתר ינוכו 1,200 ש\"ח מהתמורה החודשית של הספק."].join("\n")) });
    // ט written as \u05d, as Gemini Flash-Lite wrote it: the escape is bad JSON.
    const generate: GenerateText = async () => '{"line": 2, "value": "1,200", "quote": "בגין הפרת הוראות הב\\u05dיחות באתר ינוכו 1,200 ש\\"ח"}';
    const reply = String(await generate({ system: "", prompt: "", maxOutputTokens: 100 }));
    expect(() => JSON.parse(reply)).toThrow();
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: "sanctions", output: "items" });
    // 0.10.0 before this fix: "u05d" was left in the quote, whose number 05 is not the line's.
    expect(result).toMatchObject({ total_items: 1, unverified_items: 0 });
    expect((result.items as Array<{ line: number; quote: string }>)[0]).toMatchObject({ line: 2, quote: "בגין הפרת הוראות הביחות באתר ינוכו 1,200 ש\"ח" });
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
    // A backslash before a letter starts no JSON escape: it is taken out. One cut in its middle is still skipped.
    expect(parseItemLines('{"line": 3, "value": "5,000 ש\\"\\ח", "quote": "a\\u05d0"}')).toEqual({ objects: [{ line: 3, value: '5,000 ש"ח', quote: "a\u05d0" }], skipped: 0 });
    expect(parseItemLines('{"line": 3, "quote": "\\u05')).toEqual({ objects: [], skipped: 1 });
    // A \u with fewer than four hex digits is taken out with the digits it has: Flash-Lite wrote ט as \u05d.
    expect(parseItemLines('{"line": 3, "quote": "הוראות הב\\u05dיחות באתר"}')).toEqual({ objects: [{ line: 3, quote: "הוראות הביחות באתר" }], skipped: 0 });
    expect(parseItemLines('{"line": 3, "quote": "a\\u05 b\\u0 c\\u d"}')).toEqual({ objects: [{ line: 3, quote: "a b c d" }], skipped: 0 });
    // Four hex digits are an escape, and an escaped backslash before a "u" is a backslash.
    expect(parseItemLines('{"line": 3, "quote": "\\u05d8 \\\\u05d"}')).toEqual({ objects: [{ line: 3, quote: "\u05d8 \\u05d" }], skipped: 0 });
  });

  it("reads two objects on one line, a list wrapped in an object, and items after NOTHING RELEVANT", () => {
    const a = { line: 3, quote: "a b" };
    const b = { line: 4, quote: "c d" };
    // 0.10.0 before this fix: no object and one line skipped; one item with no quote; nothing at all.
    expect(parseItemLines('{"line": 3, "quote": "a b"} {"line": 4, "quote": "c d"}')).toEqual({ objects: [a, b], skipped: 0 });
    expect(parseItemLines('{"line": 3, "quote": "a b"},{"line": 4, "quote": "c d"}\n- {"line": 5, "quote": "{x}"}')).toEqual({ objects: [a, b, { line: 5, quote: "{x}" }], skipped: 0 });
    expect(parseItemLines('{"items": [{"line": 3, "quote": "a b"}, {"line": 4, "quote": "c d"}]}')).toEqual({ objects: [a, b], skipped: 0 });
    expect(parseItemLines('```json\n{"items": [\n{"line": 3, "quote": "a b"},\n{"line": 4, "quote": "c d"}\n], "labels": ["x"]}\n```')).toEqual({ objects: [a, b], skipped: 0 });
    expect(parseItemLines('[{"items": [{"line": 3, "quote": "a b"}]}, {"line": 4, "quote": "c d"}]')).toEqual({ objects: [a, b], skipped: 0 });
    expect(parseItemLines('NOTHING RELEVANT\n{"line": 3, "quote": "a b"}')).toEqual({ objects: [a], skipped: 0 });
    // An object with a quote of its own is an item, whatever lists it holds; and the sentinel alone is still nothing.
    expect(parseItemLines('{"line": 3, "quote": "a b", "notes": [{"x": 1}]}')).toEqual({ objects: [{ ...a, notes: [{ x: 1 }] }], skipped: 0 });
    expect(parseItemLines("NOTHING RELEVANT. No clause of this part sets a fine.")).toEqual({ objects: [], skipped: 0 });
  });
});
