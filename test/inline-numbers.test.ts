// Files sent whole with their lines numbered (L12, P1): `PrepareOptions.numberInline` numbers the
// text between the frame lines exactly as the tools number lines, and planning counts the numbered
// size. Without it, `prepare` gives the blocks and the instruction of 0.9.
import { describe, expect, it } from "vitest";
import { createLargeFiles, estimateTokens, MemoryDocumentStore, type DocumentMeta } from "llm-large-files";
import { serviceLog, utf8 } from "llm-large-files/testing";
import { documentToolsInstruction, numberedSize, numberedText, renderInline } from "../src/plan.js";

const base = { tokens: 0, bytes: 0 };

/** A Hebrew text with blank lines, a line of spaces, a tab, and a newline at its end. */
const HEBREW = [
  "מדיניות חופשות",
  "",
  "סעיף 1: העובד זכאי ל-12 ימי חופשה בשנה.",
  "   ",
  "סעיף 2:\tימי מחלה אינם נספרים כחופשה.",
  "סעיף 3: בקשה תוגש שבועיים מראש (ראו טופס 7).",
  "",
].join("\n");

/** probe4's CSV: 3,000 invoices in Hebrew, 750 of them late. */
function invoices(): string {
  const statuses = ["שולם", "באיחור", "בוטל", "פתוח"];
  const rows = ["מספר,לקוח,סכום,סטטוס,תאריך"];
  for (let i = 1; i <= 3000; i++) rows.push(`${i},לקוח ${i % 211},${(i * 7919) % 50000}.${i % 100},${statuses[(i * 7) % 4]},2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
  return rows.join("\n");
}

const prose = () => Array.from({ length: 800 }, (_, i) => `סעיף ${i + 1}: העובד זכאי לימי חופשה בהתאם לוותק, ובלבד שהודיע למנהל הישיר לפחות שבועיים מראש ובכתב, למעט מקרים חריגים.`).join("\n");

async function library(budget = {}) {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, budget });
  return { store, files };
}

/** The text the store keeps for a document. */
async function stored(store: MemoryDocumentStore, meta: DocumentMeta): Promise<string> {
  return (await store.get(meta.id))!.text;
}

describe("numbered files sent whole (numberInline)", () => {
  it("numbers the lines between the frame lines as read_document numbers them", async () => {
    const { store, files } = await library();
    const meta = await files.ingest({ name: "מדיניות.md", bytes: utf8(HEBREW) });
    const prepared = await files.prepare([meta.id], base, { numberInline: true });
    expect(prepared.plan.inline.map((document) => document.id)).toEqual([meta.id]);
    // What the tools show of every line of the file.
    const read = await files.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 1, end_line: meta.lines });
    expect(read.lines).toBe(`1-${meta.lines}`);
    expect(prepared.blocks.get(meta.id)).toBe(renderInline(meta, read.text as string));
    expect(numberedText(await stored(store, meta))).toBe(read.text);
    expect(prepared.blocks.get(meta.id)).toContain("\n1| מדיניות חופשות\n2| \n3| סעיף 1:");
    // The instruction is that of 0.9: no file to search.
    expect(prepared.instruction).toBe("");
  });

  it("numbers a text as the tools split it: at each newline, and none after the last", () => {
    expect(numberedText("a\nb\n")).toBe("1| a\n2| b");
    expect(numberedText("a\nb")).toBe("1| a\n2| b");
    expect(numberedText("a\n\nb")).toBe("1| a\n2| \n3| b");
    expect(numberedText("\n")).toBe("1| ");
    expect(numberedText("one")).toBe("1| one");
    expect(numberedText("")).toBe("");
    // A carriage return is part of its line, as the tools keep it.
    expect(numberedText("a\r\nb")).toBe("1| a\r\n2| b");
  });

  it("gives the blocks and the instruction of 0.9 without the option, and with false", async () => {
    const { store, files } = await library({ inlineTokens: 2_000 });
    const small = await files.ingest({ name: "מדיניות.md", bytes: utf8(HEBREW) });
    const large = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const ids = [small.id, large.id];
    const plain = await files.prepare(ids, base);
    const off = await files.prepare(ids, base, { numberInline: false });
    for (const prepared of [plain, off]) {
      expect(prepared.blocks.get(small.id)).toBe(renderInline(small, await stored(store, small)));
      expect(prepared.instruction).toBe(documentToolsInstruction([large], [], true));
      expect(prepared.plan.inlineTokens).toBe(small.estimatedTokens);
    }
    expect([...off.blocks]).toEqual([...plain.blocks]);
    // Numbered, the same card for the file that is searched, and the same instruction.
    const numbered = await files.prepare(ids, base, { numberInline: true });
    expect(numbered.blocks.get(large.id)).toBe(plain.blocks.get(large.id));
    expect(numbered.instruction).toBe(plain.instruction);
    expect(numbered.blocks.get(small.id)).not.toBe(plain.blocks.get(small.id));
  });

  it("plans a file at the edge of inlineTokens by its numbered size", async () => {
    const text = serviceLog(300);
    const probe = await (await library()).files.ingest({ name: "app.log", bytes: utf8(text) });
    const numbered = Math.ceil(numberedSize(probe).tokens);
    // Room for the text alone, not for its numbers.
    const { files } = await library({ inlineTokens: probe.estimatedTokens });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(text) });
    expect((await files.prepare([meta.id], base)).plan.inline).toHaveLength(1);
    const edge = await files.prepare([meta.id], base, { numberInline: true });
    expect(edge.plan.inline).toEqual([]);
    expect(edge.plan.searchable.map((document) => document.id)).toEqual([meta.id]);
    expect(edge.blocks.get(meta.id)).toContain("--- Large attached file: app.log ---");
    // With room for the numbers, it is sent whole, and counted at its numbered size.
    const { files: roomy } = await library({ inlineTokens: numbered });
    const again = await roomy.ingest({ name: "app.log", bytes: utf8(text) });
    const sent = await roomy.prepare([again.id], base, { numberInline: true });
    expect(sent.plan.inline).toHaveLength(1);
    expect(sent.plan.inlineTokens).toBe(numbered);
  });

  it("counts about 8% to 16% more, and no less than the numbered block is", async () => {
    const { store, files } = await library();
    const shares: Record<string, number> = {};
    for (const [name, text] of [["invoices.csv", invoices()], ["app.log", serviceLog(8_000)], ["policy.md", prose()]] as const) {
      const meta = await files.ingest({ name, bytes: utf8(text) });
      const size = numberedSize(meta);
      shares[name] = Math.round((1_000 * (size.tokens - meta.estimatedTokens)) / meta.estimatedTokens) / 10;
      // The estimate of the numbered text itself is within what planning counts.
      const block = numberedText(await stored(store, meta));
      expect(estimateTokens(block)).toBeLessThanOrEqual(Math.ceil(size.tokens));
      expect(Buffer.byteLength(JSON.stringify(block))).toBeLessThanOrEqual(Math.ceil(size.bytes));
    }
    expect(shares).toEqual({ "invoices.csv": 15.5, "app.log": 9.4, "policy.md": 8.4 });
  });
});
