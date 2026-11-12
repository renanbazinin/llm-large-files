import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentCache } from "../src/cache.js";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type DocumentMeta, type DocumentStore, type StoredDocument } from "../src/index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const logText = (lines: number, tag = "") => Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO ${tag}request ${i} took ${i % 900}ms`).join("\n");

/** A memory store that counts how often each method is called. */
class CountingStore implements DocumentStore {
  readonly inner = new MemoryDocumentStore();
  readonly calls = { get: 0, getMeta: 0 };
  async put(document: StoredDocument) {
    await this.inner.put(document);
  }
  async get(id: string) {
    this.calls.get++;
    return this.inner.get(id);
  }
  async getMeta(id: string) {
    this.calls.getMeta++;
    return this.inner.getMeta(id);
  }
  async delete(id: string) {
    return this.inner.delete(id);
  }
}

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("documents kept in memory are checked against the store on every use", () => {
  it("does not serve a document that another server deleted from a shared volume", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-cache-"));
    const podA = createLargeFiles({ store: new FileDocumentStore(directory), budget: { inlineTokens: 10 } });
    const podB = createLargeFiles({ store: new FileDocumentStore(directory), budget: { inlineTokens: 10 } });
    const meta = await podA.ingest({ name: "customers.log", bytes: bytes(logText(400, "card 4111 ")), owner: "u1" });

    // Pod B reads it, so it is in pod B's memory.
    const before = await podB.prepare([meta.id], { tokens: 0, bytes: 0 }, { owner: "u1" });
    expect(before.missing).toEqual([]);
    const tools = podB.tools(before.plan.searchable);
    expect((await tools.execute("search_document", { document_id: meta.id, query: "card 4111", mode: "exact" })).total_matching_lines).toBe(400);

    expect(await podA.delete(meta.id, { owner: "u1" })).toBe(true);

    const after = await podB.prepare([meta.id], { tokens: 0, bytes: 0 }, { owner: "u1" });
    expect(after.missing).toEqual([meta.id]);
    expect(after.blocks.size).toBe(0);
    // A tool set made before the delete refuses it too.
    const read = await tools.execute("read_document", { document_id: meta.id, start_line: 1 });
    expect(read.error).toMatch(/no longer available/);
    expect(await podB.getMeta(meta.id, { owner: "u1" })).toBeUndefined();
  });

  it("does not serve a document deleted from a shared store behind its back", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(logText(300)) });
    const tools = files.tools([meta]);
    expect((await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 2 })).lines).toBe("1-2");
    await store.delete(meta.id);
    expect((await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 2 })).error).toMatch(/no longer available/);
  });

  it("drops a document at its expiry by the library's clock", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const files = createLargeFiles({ store: new MemoryDocumentStore({ now: () => new Date("2026-01-01T00:00:00Z") }), ttlMs: 60_000, now: () => clock, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(logText(300)) });
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 })).missing).toEqual([]);
    clock = new Date("2026-01-01T00:01:00Z");
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 })).missing).toEqual([meta.id]);
  });

  it("reads a document again when the store describes another text under the same ID", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(logText(300, "old ")) });
    const tools = files.tools([meta]);
    expect((await tools.execute("search_document", { document_id: meta.id, query: "old request", mode: "exact" })).total_matching_lines).toBe(300);
    // A restore from a backup, or another program, puts a different text under the same ID.
    const text = logText(200, "new ");
    await store.put({ meta: { ...meta, createdAt: new Date(Date.parse(meta.createdAt) + 1).toISOString(), lines: 200, characters: text.length, textBytes: text.length }, text });
    expect((await tools.execute("search_document", { document_id: meta.id, query: "old request", mode: "exact" })).total_matching_lines).toBe(0);
    expect((await tools.execute("search_document", { document_id: meta.id, query: "new request", mode: "exact" })).total_matching_lines).toBe(200);
  });

  it("does not read a document of another owner at all", async () => {
    const store = new CountingStore();
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "a.txt", bytes: bytes("secret"), owner: "u1" });
    const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 }, { owner: "u2" });
    expect(prepared.missing).toEqual([meta.id]);
    expect(store.calls.get).toBe(0);
  });
});

describe("the memory documents may take", () => {
  it("reads a document once for many tool calls, and once for calls that arrive together", async () => {
    const store = new CountingStore();
    const files = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(logText(2_000)) });
    const tools = files.tools([meta]);
    await Promise.all(Array.from({ length: 25 }, (_, i) => tools.execute("read_document", { document_id: meta.id, start_line: i * 10 + 1, end_line: i * 10 + 5 })));
    for (let i = 0; i < 10; i++) await tools.execute("search_document", { document_id: meta.id, query: `request ${i}`, mode: "exact" });
    expect(store.calls.get).toBe(1);
    // ...and the store was asked whether the document is still there for each call.
    expect(store.calls.getMeta).toBeGreaterThanOrEqual(35);
  });

  it("keeps nothing with cacheBytes 0, and still answers", async () => {
    const store = new CountingStore();
    const files = createLargeFiles({ store, cacheBytes: 0, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(logText(500)) });
    const tools = files.tools([meta]);
    for (let i = 0; i < 5; i++) expect((await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 1 })).lines).toBe("1-1");
    expect(store.calls.get).toBe(5);
  });

  it("drops the least recently used document when the next one does not fit, and never keeps one larger than the limit", async () => {
    const store = new CountingStore();
    // Each log of 1,000 lines takes about 100 KB here (ASCII, kept with its lowercased copy).
    const files = createLargeFiles({ store, cacheBytes: 250_000, budget: { inlineTokens: 10 } });
    const a = await files.ingest({ name: "a.log", bytes: bytes(logText(1_000, "a ")) });
    const b = await files.ingest({ name: "b.log", bytes: bytes(logText(1_000, "b ")) });
    const c = await files.ingest({ name: "c.log", bytes: bytes(logText(1_000, "c ")) });
    const huge = await files.ingest({ name: "huge.log", bytes: bytes(logText(5_000, "h ")) });
    const tools = files.tools([a, b, c, huge]);
    const read = (id: string) => tools.execute("read_document", { document_id: id, start_line: 1, end_line: 1 });

    await read(a.id);
    await read(b.id);
    expect(store.calls.get).toBe(2);
    await read(a.id); // a and b fit together
    expect(store.calls.get).toBe(2);
    await read(c.id); // c pushes out b, the least recently used
    await read(a.id);
    expect(store.calls.get).toBe(3);
    await read(b.id);
    expect(store.calls.get).toBe(4);

    // Larger than the whole cache: read for each call, and it does not push out the others.
    await read(huge.id);
    await read(huge.id);
    expect(store.calls.get).toBe(6);
    await read(b.id);
    expect(store.calls.get).toBe(6);
    expect((await read(huge.id)).total_lines).toBe(5_000);
  });

  it("still honours cacheSize as a cap on the number of documents", async () => {
    const store = new CountingStore();
    const files = createLargeFiles({ store, cacheSize: 1, budget: { inlineTokens: 10 } });
    const a = await files.ingest({ name: "a.log", bytes: bytes(logText(100)) });
    const b = await files.ingest({ name: "b.log", bytes: bytes(logText(100)) });
    const tools = files.tools([a, b]);
    for (const id of [a.id, b.id, a.id, b.id]) await tools.execute("read_document", { document_id: id, start_line: 1 });
    expect(store.calls.get).toBe(4);
  });
});

describe("DocumentCache", () => {
  const meta = (id: string) => ({ id }) as DocumentMeta;
  const item = (memoryBytes: number) => ({ memoryBytes, meta: meta("x") });

  it("counts bytes, evicts the least recently used, and drops an entry whose version changed", () => {
    const cache = new DocumentCache<ReturnType<typeof item>>(100);
    const [one, two, three] = [item(40), item(40), item(40)];
    cache.set("1", "v", one);
    cache.set("2", "v", two);
    expect(cache.bytes).toBe(80);
    expect(cache.get("1", "v")).toBe(one); // 1 is now the most recently used
    cache.set("3", "v", three);
    expect(cache.get("2", "v")).toBeUndefined();
    expect(cache.get("1", "v")).toBe(one);
    expect(cache.bytes).toBe(80);
    expect(cache.get("1", "other version")).toBeUndefined();
    expect(cache.bytes).toBe(40);
    cache.set("3", "v", three); // the same entry again changes nothing
    expect(cache.bytes).toBe(40);
    cache.set("big", "v", item(101));
    expect(cache.size).toBe(1);
    cache.delete("3");
    expect(cache.bytes).toBe(0);
  });
});
