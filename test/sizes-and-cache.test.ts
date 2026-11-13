import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, jsonBytes, MemoryDocumentStore, utf8Bytes } from "llm-large-files";
import { DocumentCache } from "../src/cache.js";
import { REQUEST_BYTES_MARGIN } from "../src/plan.js";
import { wrapLongLines } from "../src/text.js";

const bytes = (text: string) => new TextEncoder().encode(text);

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("the size of a text in a JSON request", () => {
  const samples = [
    "",
    "plain words and nothing else",
    "{\"level\":\"error\",\"msg\":\"disk \\\"full\\\"\"}\n".repeat(50),
    "a\tb\tc\td\n".repeat(50),
    "path C:\\srv\\data\\file.txt\r\n",
    "bell \u0007 escape \u001b form feed \f backspace \b delete \u007f",
    "שגיאה בשרת, ההזמנה נכשלה",
    "emoji 😀 and 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 and 漢字",
    "line separator \u2028 and paragraph separator \u2029 stay as they are",
    `half a pair at the end \ud83d`,
    `half a pair \ude00 in the middle, and \ud83d before a letter`,
  ];

  it("is exact: UTF-8 bytes plus what JSON adds for quotes, backslashes and control characters", () => {
    for (const sample of samples) {
      expect(jsonBytes(sample), JSON.stringify(sample)).toBe(Buffer.byteLength(JSON.stringify(sample)));
      expect(utf8Bytes(sample), JSON.stringify(sample)).toBe(Buffer.byteLength(sample));
    }
  });

  it("is kept with the document, so that planning counts what the request will hold", async () => {
    const rows = 20_000;
    const text = "a\tb\tc\n".repeat(rows); // 6 bytes a row as text, 9 in JSON
    // Room for 8 bytes a row: enough by the old rule of 8% over the text, not enough in fact.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { maxRequestBytes: REQUEST_BYTES_MARGIN + 8 * rows } });
    const meta = await files.ingest({ name: "export.tsv", bytes: bytes(text) });
    expect(meta.textBytes).toBe(6 * rows);
    expect(meta.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(text.endsWith("\n") ? text : `${text}\n`)));
    const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 });
    expect(prepared.plan.inline).toEqual([]);
    expect(prepared.plan.searchable.map((document) => document.id)).toEqual([meta.id]);
  });

  it("bounds a read_document result as it is sent, not as it was read", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    // Every character of these lines takes two in JSON: read as text, 205 lines fit the limit; sent, they are twice it.
    const row = (i: number) => `${"\\\"".repeat(49)} ${i}`;
    const meta = await files.ingest({ name: "export.txt", bytes: bytes(Array.from({ length: 2_000 }, (_, i) => row(i)).join("\n")) });
    const result = await files.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 1, end_line: 600 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(files.budget.toolResultCharacters);
    expect(result.next_start_line).toBeGreaterThan(1);
    // Whole lines, and the next call goes on where this one stopped.
    const [from, to] = String(result.lines).split("-").map(Number);
    expect(String(result.text).split("\n")).toHaveLength(to! - from! + 1);
    expect(result.next_start_line).toBe(to! + 1);
  });
});

describe("wrapping long lines", () => {
  const halfOfAPair = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it("never cuts between the two halves of a character outside the basic plane", () => {
    for (const lead of ["", "x", "xy"]) {
      const line = `${lead}${"😀".repeat(2_500)}`;
      const { text, wrapped } = wrapLongLines(line);
      expect(wrapped).toBe(1);
      for (const piece of text.split("\n")) {
        expect(piece.length).toBeLessThanOrEqual(2_000);
        expect(halfOfAPair.test(piece)).toBe(false);
      }
      expect(text.replaceAll("\n", "")).toBe(line);
    }
  });

  it("stores such a line without replacement characters", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-wrap-"));
    const files = createLargeFiles({ store: new FileDocumentStore(directory), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "chat.txt", bytes: bytes(`x${"😀".repeat(1_500)}\nsecond line\n`) });
    const result = await files.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 1, end_line: 3 });
    expect(String(result.text)).not.toContain("\ufffd");
    expect(String(result.text).match(/😀/g)).toHaveLength(1_500);
  });
});

describe("cacheSize", () => {
  const item = (memoryBytes: number) => ({ memoryBytes });

  it("counts documents, not the pieces kept of them", () => {
    const cache = new DocumentCache<ReturnType<typeof item>>(10_000, 2);
    cache.set("a", "v", item(10));
    for (let piece = 0; piece < 6; piece++) cache.set(`a#${piece}`, "v", item(10), "a");
    cache.set("b", "v", item(10));
    expect(cache.size).toBe(8);
    expect(cache.get("a", "v")).toBeDefined();
    // A third document: the one used longest ago goes. That is "b": "a" was just used.
    cache.set("c", "v", item(10));
    expect(cache.get("b", "v")).toBeUndefined();
    expect(cache.size).toBe(8);
    // A fourth: now "a" is the one used longest ago, and its pieces go with it.
    cache.set("d", "v", item(10));
    expect(cache.get("a", "v")).toBeUndefined();
    expect(cache.get("a#3", "v")).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(20);
  });

  it("still bounds everything by memory, pieces included", () => {
    const cache = new DocumentCache<ReturnType<typeof item>>(50, 2);
    cache.set("a", "v", item(10));
    for (let piece = 0; piece < 6; piece++) cache.set(`a#${piece}`, "v", item(10), "a");
    expect(cache.bytes).toBeLessThanOrEqual(50);
  });

  it("keeps a document that is read by range open between its searches", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-cachesize-"));
    let opened = 0;
    class Counting extends FileDocumentStore {
      override async getIndex(id: string) {
        opened++;
        return super.getIndex(id);
      }
    }
    const files = createLargeFiles({ store: new Counting(directory), cacheSize: 2, wholeDocumentBytes: 0, scanChunkBytes: 2_048, budget: { inlineTokens: 10 } });
    const text = Array.from({ length: 2_000 }, (_, i) => `2026-01-01T00:00:00Z INFO worker-${i % 8} request ${i}`).join("\n");
    const meta = await files.ingest({ name: "app.log", bytes: bytes(text) });
    const tools = files.tools([meta]);
    for (let i = 0; i < 6; i++) {
      expect((await tools.execute("search_document", { document_id: meta.id, query: `worker-${i}`, mode: "exact", max_results: 1 })).total_matching_lines).toBe(250);
    }
    expect(opened).toBe(1);
  });
});
