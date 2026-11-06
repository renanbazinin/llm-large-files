import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type GenerateText } from "../src/index.js";
import { grep, rankPassages, SearchableDocument, unsafeRegexReason } from "../src/search.js";
import { splitIntoParts } from "../src/map-reduce.js";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

function bigLog(lines: number): string {
  const out: string[] = [];
  for (let index = 1; index <= lines; index++) {
    const second = String(index % 60).padStart(2, "0");
    if (index % 500 === 0) out.push(`2026-05-01 12:00:${second} ERROR payment-service: timeout after ${index}ms calling ledger`);
    else if (index % 97 === 0) out.push(`2026-05-01 12:00:${second} WARN cache miss for key user:${index}`);
    else out.push(`2026-05-01 12:00:${second} INFO handled request ${index} in ${index % 40}ms`);
  }
  return out.join("\n");
}

function book(chapters: number): string {
  const out: string[] = [];
  for (let chapter = 1; chapter <= chapters; chapter++) {
    out.push(`Chapter ${chapter}`, "");
    for (let paragraph = 0; paragraph < 40; paragraph++) {
      out.push(chapter === 7 && paragraph === 12
        ? "The lighthouse keeper finally revealed the hidden treasure under the old oak tree."
        : `In chapter ${chapter} the travellers walked on through the valley, talking about the weather and the road ahead.`);
    }
    out.push("");
  }
  return out.join("\n");
}

describe("search", () => {
  const document = new SearchableDocument({
    meta: { id: "doc_x", name: "app.log" } as never,
    text: bigLog(3_000),
  });

  it("finds exact lines case-insensitively with context", () => {
    const result = grep(document, "ERROR PAYMENT", { maxResults: 3, contextLines: 1 });
    expect(result.totalMatchingLines).toBe(6);
    expect(result.matches.map((match) => match.line)).toEqual([500, 1000, 1500]);
    expect(result.matches[0]!.before).toEqual(["499| 2026-05-01 12:00:19 INFO handled request 499 in 19ms"]);
  });

  it("supports regex and rejects patterns that can backtrack catastrophically", () => {
    expect(grep(document, "timeout after \\d{4}ms", { regex: true, maxResults: 50, contextLines: 0 }).totalMatchingLines).toBe(5);
    expect(unsafeRegexReason("(a+)+b")).toMatch(/nested quantifier/);
    expect(() => grep(document, "(a+)+b", { regex: true, maxResults: 5, contextLines: 0 })).toThrow(/nested/);
  });

  it("ranks the passage that answers a question first", () => {
    const novel = new SearchableDocument({ meta: { id: "doc_y", name: "novel.txt" } as never, text: book(12) });
    const [best] = rankPassages(novel, "where is the hidden treasure", 3);
    const answerLine = book(12).split("\n").findIndex((line) => line.includes("treasure")) + 1;
    expect(best!.from).toBeLessThanOrEqual(answerLine);
    expect(best!.to).toBeGreaterThanOrEqual(answerLine);
  });
});

describe("createLargeFiles", () => {
  const generateEcho: GenerateText = async ({ prompt }) => {
    if (prompt.includes("<part>")) {
      return prompt.includes("hidden treasure") ? "The treasure is under the oak tree (L300)." : "NOTHING RELEVANT";
    }
    return `FINAL: ${prompt.includes("oak tree") ? "under the oak tree" : "unknown"}`;
  };

  it("ingests a log: detects the format, profiles it, and stores it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "C:\\logs\\service.txt", mimeType: "text/plain", bytes: bytes(bigLog(1_000)) });
    expect(meta).toMatchObject({ name: "service.txt", format: "log", lines: 1_000 });
    expect(meta.id).toMatch(/^doc_[a-f0-9]{32}$/);
    expect(meta.logProfile?.levels.ERROR).toBe(2);
    expect(meta.logProfile?.topIssues[0]?.template).toBe("ERROR payment-service: timeout after <n>ms calling ledger");
    expect(await files.getMeta(meta.id)).toEqual(meta);
  });

  it("hides documents from other owners everywhere", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "a.md", bytes: bytes("# A"), owner: "alice" });
    const shared = await files.ingest({ name: "b.md", bytes: bytes("# B") });
    expect(meta.owner).toBe("alice");
    expect(await files.getMeta(meta.id, { owner: "bob" })).toBeUndefined();
    expect(await files.getMeta(meta.id)).toBeUndefined();
    expect((await files.getMeta(meta.id, { owner: "alice" }))?.name).toBe("a.md");
    expect((await files.prepare([meta.id, shared.id], { tokens: 0, bytes: 0 }, { owner: "bob" })).missing).toEqual([meta.id]);
    expect(await files.delete(meta.id, { owner: "bob" })).toBe(false);
    expect(await files.delete(meta.id, { owner: "alice" })).toBe(true);
  });

  it("rejects empty, oversized, and binary uploads with readable errors", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes: 100 });
    await expect(files.ingest({ name: "a.txt", bytes: new Uint8Array() })).rejects.toThrow("a.txt is empty.");
    await expect(files.ingest({ name: "a.txt", bytes: bytes("x".repeat(101)) })).rejects.toThrow("a.txt is larger than the 100 B upload limit.");
    await expect(files.ingest({ name: "a.bin", bytes: new Uint8Array(90).fill(0) })).rejects.toThrow(/binary/);
  });

  it("inlines what fits and turns the rest into searchable cards", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 5_000 } });
    const small = await files.ingest({ name: "notes.md", bytes: bytes("# Notes\n\nShort and sweet.") });
    const large = await files.ingest({ name: "novel.txt", bytes: bytes(book(10)) });
    const prepared = await files.prepare([large.id, small.id, "doc_ffffffffffffffffffffffffffffffff"], { tokens: 100, bytes: 1_000 });
    expect(prepared.plan.inline.map((meta) => meta.name)).toEqual(["notes.md"]);
    expect(prepared.plan.searchable.map((meta) => meta.name)).toEqual(["novel.txt"]);
    expect(prepared.missing).toEqual(["doc_ffffffffffffffffffffffffffffffff"]);
    expect(prepared.blocks.get(small.id)).toContain("Short and sweet.");
    expect(prepared.blocks.get(large.id)).toContain(`document_id: ${large.id}`);
    expect(prepared.blocks.get(large.id)).toContain("L1 Chapter 1");
    expect(prepared.instruction).toContain("novel.txt");
  });

  it("respects the request byte limit as well as the token budget", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { maxRequestBytes: 300_000 } });
    const meta = await files.ingest({ name: "a.txt", bytes: bytes("שלום עולם ".repeat(10_000)) });
    expect(meta.textBytes).toBeGreaterThan(150_000);
    const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 });
    expect(prepared.plan.searchable).toHaveLength(1);
  });

  it("gives tools access only to the conversation's documents", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const mine = await files.ingest({ name: "app.log", bytes: bytes(bigLog(2_000)) });
    const other = await files.ingest({ name: "secret.log", bytes: bytes(bigLog(10)) });
    const tools = files.tools([mine]);
    expect(tools.declarations.map((declaration) => declaration.name)).toEqual(["search_document", "read_document", "get_document_overview"]);
    expect(await tools.execute("read_document", { document_id: other.id, start_line: 1 })).toEqual({ error: expect.stringContaining("Unknown document_id") });
    const search = await tools.execute("search_document", { document_id: mine.id, query: "payment-service", mode: "exact" });
    expect(search).toMatchObject({ total_matching_lines: 4, mode: "exact" });
    expect(tools.describe("search_document", { document_id: mine.id, query: "payment-service", mode: "exact" })).toBe("Search app.log (exact) for “payment-service”");
    expect(tools.describe("read_document", { document_id: mine.id, start_line: 10, end_line: 20 })).toBe("Read app.log lines 10-20");
    const read = await tools.execute("read_document", { document_id: mine.id, start_line: 1_990, end_line: 5_000 });
    expect(read).toMatchObject({ lines: "1990-2000", total_lines: 2_000, note: "End of file." });
    const overview = await tools.execute("get_document_overview", { document_id: mine.id });
    expect(overview).toMatchObject({ format: "log", lines: 2_000 });
    expect(await tools.execute("nope", {})).toEqual({ error: "Unknown tool nope." });
  });

  it("keeps tool results under the character budget", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { toolResultCharacters: 3_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(bigLog(2_000)) });
    const tools = files.tools([meta]);
    const search = await tools.execute("search_document", { document_id: meta.id, query: "INFO", mode: "exact", max_results: 50 });
    expect(JSON.stringify(search).length).toBeLessThanOrEqual(3_000);
    expect(search.note).toMatch(/Showing \d+ of 50/);
    const read = await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 600 });
    expect(JSON.stringify(read).length).toBeLessThanOrEqual(3_200);
    expect(read.next_start_line).toBeGreaterThan(1);
  });

  it("reads a whole document with map-reduce, reporting progress", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 2_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(12)) });
    const progress: string[] = [];
    const generate = vi.fn(generateEcho);
    const tools = files.tools([meta], { generate, onProgress: (event) => progress.push(event.message) });
    const result = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Where is the treasure?" });
    expect(result.answer).toBe("FINAL: under the oak tree");
    expect(result.parts_with_relevant_content).toBe(1);
    expect(result.parts_read).toBeGreaterThan(5);
    expect(generate).toHaveBeenCalledTimes(Number(result.parts_read) + 1);
    expect(progress.at(-1)).toMatch(/Writing the answer/);
  });

  it("refuses whole-document reads that need too many model calls", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 1_000, maxMapChunks: 3 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(12)) });
    const result = await files.tools([meta], { generate: generateEcho }).execute("analyze_whole_document", { document_id: meta.id, task: "summarize" });
    expect(result.error).toMatch(/over the limit of 3/);
  });

  it("retries a failed part once, then reports it instead of failing the whole read", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    let calls = 0;
    const flaky: GenerateText = async (request) => {
      calls++;
      if (request.prompt.includes("part 1 of")) throw new Error("quota");
      return request.prompt.includes("<part>") ? "Some notes (L10)." : "FINAL";
    };
    const result = await files.tools([meta], { generate: flaky }).execute("analyze_whole_document", { document_id: meta.id, task: "summarize" });
    expect(result).toMatchObject({ answer: "FINAL", parts_that_failed: 1 });
    expect(calls).toBeGreaterThan(Number(result.parts_read) + 1);
  });

  it("combines notes in rounds when they do not fit one request", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 1_500 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(10)) });
    const reducePrompts: string[] = [];
    const verbose: GenerateText = async ({ prompt }) => {
      if (prompt.includes("<part>")) return "note ".repeat(200);
      reducePrompts.push(prompt);
      return "merged";
    };
    const result = await files.tools([meta], { generate: verbose }).execute("analyze_whole_document", { document_id: meta.id, task: "summarize" });
    expect(result.answer).toBe("merged");
    expect(reducePrompts.filter((prompt) => prompt.startsWith("Task: summarize\n\nMerge")).length).toBeGreaterThan(1);
  });

  it("splits parts on line boundaries that cover the document exactly once", () => {
    const document = new SearchableDocument({ meta: { name: "x" } as never, text: book(6) });
    const parts = splitIntoParts(document, { mapChunkTokens: 1_000, maxRequestBytes: 10_000_000 } as never);
    expect(parts[0]!.from).toBe(1);
    expect(parts.at(-1)!.to).toBe(document.lines.lineCount);
    parts.slice(1).forEach((part, index) => expect(part.from).toBe(parts[index]!.to + 1));
  });
});

describe("FileDocumentStore", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("round-trips documents, expires them, and ignores unsafe IDs", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "large-files-"));
    let clock = new Date("2026-01-01T00:00:00Z");
    const now = () => clock;
    const files = createLargeFiles({ store: new FileDocumentStore(directory, { now }), ttlMs: 60_000, now });
    const meta = await files.ingest({ name: "a.md", bytes: bytes("# A\n\nhello") });
    expect((await readdir(directory)).sort()).toEqual([`${meta.id}.json`, `${meta.id}.txt`]);
    expect(await readFile(path.join(directory, `${meta.id}.txt`), "utf8")).toBe("# A\n\nhello");
    expect(await files.getMeta("../../etc/passwd")).toBeUndefined();
    expect(await files.delete("doc_../../x")).toBe(false);

    const store = new FileDocumentStore(directory, { now });
    expect((await store.get(meta.id))?.text).toBe("# A\n\nhello");
    clock = new Date("2026-01-01T00:02:00Z");
    expect(await store.sweep(clock)).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });
});
