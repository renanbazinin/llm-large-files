import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type DocumentMeta, type DocumentStore, type LargeFiles } from "../src/index.js";
import { Limiter } from "../src/limiter.js";
import { openRangedDocument, type RangedDocument } from "../src/ranged.js";
import { grepSource, SearchableDocument } from "../src/search.js";
import { buildTextIndex, parseTextIndex, serializeTextIndex, TextIndexBuilder } from "../src/text-index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const directories: string[] = [];
async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "llf-volume-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Texts that are hard to cut into pieces: every kind of character, empty lines, page lines, lines across pieces. */
const TEXTS: Record<string, string> = {
  log: Array.from({ length: 900 }, (_, i) => `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z ${i % 37 === 0 ? "ERROR" : "INFO"} payment gateway timeout after ${i}ms to 10.0.0.${i % 255}`).join("\n"),
  unicode: Array.from({ length: 400 }, (_, i) => `${i % 3 === 0 ? "😀 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 " : ""}שגיאה בשרת ${i} İstanbul ΟΔΟΣ ΣΑΣ 漢字 é ${i % 5 === 0 ? "" : "timeout"}`).join("\n"),
  blank: `\n\n\nfirst\n\n\n${"x\n\n".repeat(200)}last\n\n`,
  single: "only one line, and no line break at the end",
  pages: Array.from({ length: 60 }, (_, i) => [`--- Page ${i + 1} ---`, i % 7 === 0 ? "[Picture on this page. This text cannot show it.]" : `Text of page ${i + 1}`, i % 9 === 0 ? `--- Page ${i + 40} ---` : "body", "Figure 3: sales"].join("\n")).join("\n\n"),
  overlapping: "a\na\na\na\na\nb\na\na\nend",
  long: `${"word ".repeat(3_000)}\n${"x".repeat(5_000)}\nshort\n`,
};

const CALLS: Array<Record<string, unknown>> = [
  { name: "read_document", start_line: 1 },
  { name: "read_document", start_line: 3, end_line: 9 },
  { name: "read_document", start_line: 500, end_line: 2_000 },
  { name: "get_document_overview" },
  { name: "search_document", query: "timeout", mode: "exact", context_lines: 3, max_results: 50 },
  { name: "search_document", query: "TIMEOUT", mode: "exact", case_sensitive: true },
  { name: "search_document", query: "a\na", mode: "exact", context_lines: 2 },
  { name: "search_document", query: "\n\n", mode: "exact" },
  { name: "search_document", query: "istanbul", mode: "exact" },
  { name: "search_document", query: "σας", mode: "exact" },
  { name: "search_document", query: "😀", mode: "exact", context_lines: 5 },
  { name: "search_document", query: "x", mode: "exact", max_results: 50, context_lines: 1 },
  { name: "search_document", query: "\\d{3}ms", mode: "regex", context_lines: 2 },
  { name: "search_document", query: "^$", mode: "regex", max_results: 50 },
  { name: "search_document", query: "[א-ת]+", mode: "regex" },
  { name: "search_document", query: "payment gateway timeout" },
  { name: "search_document", query: "שגיאה בשרת", max_results: 10 },
  { name: "search_document", query: "figure sales page" },
  { name: "search_document", query: "a a end", max_results: 10 },
  { name: "search_document", query: "end\nstart" },
];

/** What the model would be sent for each call, with document IDs taken out. */
async function transcript(files: LargeFiles, meta: DocumentMeta): Promise<string[]> {
  const generate = async ({ prompt }: { prompt: string }) => `notes on ${prompt.length} characters`;
  const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 }, { viewPages: true });
  const tools = files.tools([meta], { generate, viewPages: true });
  const out = [JSON.stringify([prepared.blocks.get(meta.id), prepared.missing])];
  for (const { name, ...args } of CALLS) out.push(JSON.stringify(await tools.execute(name as string, { document_id: meta.id, ...args })));
  out.push(JSON.stringify(await tools.execute("analyze_whole_document", { document_id: meta.id, task: "everything" })));
  return out.map((line) => line.replaceAll(meta.id, "ID"));
}

describe("reading by range gives what reading the whole text gives", () => {
  for (const [kind, text] of Object.entries(TEXTS)) {
    it(`for a text of kind "${kind}", in pieces of any size`, async () => {
      const budget = { inlineTokens: 5, mapChunkTokens: 2_000, maxMapChunks: 100 };
      const memory = createLargeFiles({ store: new MemoryDocumentStore(), budget });
      const expected = await transcript(memory, await memory.ingest({ name: `${kind}.txt`, bytes: bytes(text) }));
      for (const scanChunkBytes of [1, 97, 4_096, 1 << 20]) {
        const files = createLargeFiles({ store: new FileDocumentStore(await folder()), budget, wholeDocumentBytes: 0, scanChunkBytes });
        expect(await transcript(files, await files.ingest({ name: `${kind}.txt`, bytes: bytes(text) }))).toEqual(expected);
      }
    });
  }

  it("builds the same index from the bytes in any pieces as from the text, with the passages and pages of the text", () => {
    for (const text of Object.values(TEXTS)) {
      const whole = buildTextIndex(text);
      const builder = new TextIndexBuilder();
      const encoded = bytes(text);
      for (let at = 0; at < encoded.length; at += 7) builder.push(encoded.subarray(at, at + 7));
      expect(builder.finish()).toEqual(whole);
      const document = new SearchableDocument({ meta: { id: "doc_x", name: "x" } as DocumentMeta, text });
      expect(whole.lineCount).toBe(document.lineCount);
      expect(whole.characters).toBe(text.length);
      expect([...whole.characterStarts]).toEqual(Array.from({ length: document.lineCount }, (_, i) => document.lines.startOf(i + 1)));
      expect([...whole.passageStarts]).toEqual(document.passages);
      expect(Array.from({ length: whole.lineCount }, (_, i) => document.pageOfLine(i + 1))).toEqual(
        Array.from({ length: whole.lineCount }, (_, i) => (whole.pageStarts.length && i + 1 >= whole.pageStarts[0]! ? [...whole.pageStarts].filter((start) => start <= i + 1).length : undefined)),
      );
      expect(parseTextIndex(serializeTextIndex(whole))).toEqual(whole);
    }
  });
});

describe("FileDocumentStore on a volume", () => {
  it("writes a line index next to the text at ingest, and removes it with the document", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    expect((await readdir(directory)).sort()).toEqual([`${meta.id}.idx`, `${meta.id}.json`, `${meta.id}.txt`]);
    expect(parseTextIndex((await store.getIndex(meta.id))!, meta)).toEqual(buildTextIndex(TEXTS.log!));
    expect(await files.delete(meta.id)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("reads a large document by range, and loads a small one whole", async () => {
    const directory = await folder();
    const calls = { get: 0, readTextRange: 0 };
    class Counting extends FileDocumentStore {
      override async get(id: string) {
        calls.get++;
        return super.get(id);
      }
      override async readTextRange(id: string, start: number, end: number) {
        calls.readTextRange++;
        return super.readTextRange(id, start, end);
      }
    }
    const files = createLargeFiles({ store: new Counting(directory), budget: { inlineTokens: 5 }, wholeDocumentBytes: 20_000 });
    const small = await files.ingest({ name: "small.log", bytes: bytes(TEXTS.log!.slice(0, 10_000)) });
    const large = await files.ingest({ name: "large.log", bytes: bytes(TEXTS.log!) });
    const tools = files.tools([small, large]);
    await tools.execute("read_document", { document_id: small.id, start_line: 5 });
    expect(calls).toEqual({ get: 1, readTextRange: 0 });
    await tools.execute("read_document", { document_id: large.id, start_line: 5, end_line: 6 });
    expect(calls).toEqual({ get: 1, readTextRange: 1 });
  });

  it("opens an older document that has no index, builds the index once, and saves it for the next server", async () => {
    const directory = await folder();
    const writer = createLargeFiles({ store: new FileDocumentStore(directory) });
    const meta = await writer.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    const expected = await transcript(createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: Infinity, budget: { inlineTokens: 5, mapChunkTokens: 2_000, maxMapChunks: 100 } }), meta);
    // As 0.3.x left it: the text and the metadata, no index.
    await rm(path.join(directory, `${meta.id}.idx`));

    const podA = createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 5, mapChunkTokens: 2_000, maxMapChunks: 100 } });
    expect(await transcript(podA, meta)).toEqual(expected);
    const saved = await readFile(path.join(directory, `${meta.id}.idx`));
    expect(parseTextIndex(new Uint8Array(saved), meta)).toEqual(buildTextIndex(TEXTS.log!));
    // Another server finds it ready.
    const podB = createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 5, mapChunkTokens: 2_000, maxMapChunks: 100 } });
    expect(await transcript(podB, meta)).toEqual(expected);
  });

  it("rebuilds an index that is damaged, cut short, of another version, or of another document", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    const files = createLargeFiles({ store, budget: { inlineTokens: 5 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    const other = await files.ingest({ name: "other.log", bytes: bytes(TEXTS.unicode!) });
    const good = (await store.getIndex(meta.id))!;
    const wrongVersion = good.slice();
    wrongVersion[4] = 9;
    const damaged = [new Uint8Array(0), bytes("not an index"), good.subarray(0, good.length - 4), wrongVersion, (await store.getIndex(other.id))!];
    for (const index of damaged) {
      await writeFile(path.join(directory, `${meta.id}.idx`), index);
      const fresh = createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 5 } });
      const result = await fresh.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 899, end_line: 900 });
      expect(result.text).toBe(`899| ${TEXTS.log!.split("\n")[898]}\n900| ${TEXTS.log!.split("\n")[899]}`);
      expect(Buffer.compare(await readFile(path.join(directory, `${meta.id}.idx`)), Buffer.from(good))).toBe(0);
    }
  });

  it("notices an index that looks right but points to the wrong bytes, and reads correctly from the next call on", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    const meta = await createLargeFiles({ store }).ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    const index = parseTextIndex((await store.getIndex(meta.id))!, meta)!;
    // Every line from line 11 on is said to start one byte later than it does.
    for (let line = 10; line < index.lineStarts.length; line++) index.lineStarts[line]! += 1;
    await store.putIndex(meta.id, serializeTextIndex(index));

    const files = createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 5 } });
    const tools = files.tools([meta]);
    const first = await tools.execute("read_document", { document_id: meta.id, start_line: 11, end_line: 20 });
    expect(first.error).toMatch(/did not match its index/);
    const second = await tools.execute("read_document", { document_id: meta.id, start_line: 11, end_line: 12 });
    expect(second.text).toBe(`11| ${TEXTS.log!.split("\n")[10]}\n12| ${TEXTS.log!.split("\n")[11]}`);
    expect(parseTextIndex((await store.getIndex(meta.id))!, meta)).toEqual(buildTextIndex(TEXTS.log!));
    // prepare() reads the card of such a document without failing at all.
    await store.putIndex(meta.id, serializeTextIndex(index));
    const prepared = await createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 5 } }).prepare([meta.id], { tokens: 0, bytes: 0 });
    expect(prepared.missing).toEqual([]);
    expect(prepared.blocks.get(meta.id)).toContain(`  25| ${TEXTS.log!.split("\n")[24]}`);
  });

  it("works on a read-only volume and with a store that keeps no index", async () => {
    const directory = await folder();
    const meta = await createLargeFiles({ store: new FileDocumentStore(directory) }).ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    await rm(path.join(directory, `${meta.id}.idx`));
    class ReadOnly extends FileDocumentStore {
      override async putIndex(): Promise<void> {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      }
    }
    const readOnly = createLargeFiles({ store: new ReadOnly(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 5 } });
    expect((await readOnly.tools([meta]).execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" })).total_matching_lines).toBe(25);
    expect(await readdir(directory)).not.toContain(`${meta.id}.idx`);

    // A store of your own with readTextRange only: the index is built in memory.
    const file = new FileDocumentStore(directory);
    const minimal: DocumentStore = {
      put: (document) => file.put(document),
      get: (id) => file.get(id),
      getMeta: (id) => file.getMeta(id),
      delete: (id) => file.delete(id),
      readTextRange: (id, start, end) => file.readTextRange(id, start, end),
    };
    const own = createLargeFiles({ store: minimal, wholeDocumentBytes: 0, budget: { inlineTokens: 5 } });
    expect((await own.tools([meta]).execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" })).total_matching_lines).toBe(25);
  });

  it("answers a document deleted in the middle of a search as no longer available", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    const files = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 1_000, budget: { inlineTokens: 5 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    let reads = 0;
    const original = store.readTextRange.bind(store);
    store.readTextRange = async (id, start, end) => {
      if (++reads === 3) await store.delete(id);
      return original(id, start, end);
    };
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "timeout", mode: "exact" });
    expect(result.error).toMatch(/no longer available/);
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 })).missing).toEqual([meta.id]);
  });

  it("runs at most maxConcurrentScans searches at once, and lets a waiting one be cancelled", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    let running = 0;
    let most = 0;
    const original = store.readTextRange.bind(store);
    store.readTextRange = async (id, start, end) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return original(id, start, end);
    };
    const files = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 4_000, maxConcurrentScans: 2, budget: { inlineTokens: 5 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    const tools = files.tools([meta]);
    const results = await Promise.all(Array.from({ length: 8 }, () => tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" })));
    expect(results.every((result) => result.total_matching_lines === 25)).toBe(true);
    // Two scans at once, each with one piece read ahead: at most four reads in flight.
    expect(most).toBeLessThanOrEqual(4);

    const limiter = new Limiter(1);
    const release = await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    release();
    expect(limiter.load).toEqual({ active: 0, waiting: 0 });
  });

  it("lets searches of one document that wait together share one pass over the text", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    let reads = 0;
    const original = store.readTextRange.bind(store);
    store.readTextRange = async (id, start, end) => {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return original(id, start, end);
    };
    const files = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 8_000, maxConcurrentScans: 1, budget: { inlineTokens: 5 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    const memory = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 5 } });
    const reference = await memory.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    const tools = files.tools([meta]);
    await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 1 }); // opens the document
    const calls = [
      { query: "ERROR", mode: "exact" },
      { query: "timeout after 1\\d\\dms", mode: "regex", context_lines: 2 },
      { query: "payment gateway" },
      { query: "10.0.0.7", mode: "exact", context_lines: 1 },
      { query: "gateway timeout", max_results: 10 },
      { query: "ms to", mode: "exact", max_results: 3 },
    ];
    const piecesOfOnePass = Math.ceil(TEXTS.log!.length / 8_000) + 1;
    reads = 0;
    const together = await Promise.all(Array.from({ length: 24 }, (_, i) => tools.execute("search_document", { document_id: meta.id, ...calls[i % calls.length] })));
    // 24 searches, one at a time, in at most a few passes: the first alone, the rest together.
    expect(reads).toBeLessThanOrEqual(3 * piecesOfOnePass + 24 * 3);
    const expected = await Promise.all(Array.from({ length: 24 }, (_, i) => memory.tools([reference]).execute("search_document", { document_id: reference.id, ...calls[i % calls.length] })));
    expect(together.map((result) => JSON.stringify(result))).toEqual(expected.map((result) => JSON.stringify(result)));

    // A search that is cancelled leaves the others it waited with untouched.
    const controller = new AbortController();
    const cancellable = files.tools([meta], { signal: controller.signal });
    const waiting = [
      tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" }),
      cancellable.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" }).then(() => "finished", () => "cancelled"),
      tools.execute("search_document", { document_id: meta.id, query: "INFO", mode: "exact" }),
    ];
    controller.abort(new Error("the user left"));
    const [first, second, third] = await Promise.all(waiting);
    expect((first as { total_matching_lines: number }).total_matching_lines).toBe(25);
    expect(second).toBe("cancelled");
    expect((third as { total_matching_lines: number }).total_matching_lines).toBe(875);
  });

  it("keeps decoded pieces of a document within cacheBytes, so the next search reads nothing, and forgets them when it is deleted", async () => {
    const directory = await folder();
    const reads = { count: 0 };
    class Counting extends FileDocumentStore {
      override async readTextRange(id: string, start: number, end: number) {
        reads.count++;
        return super.readTextRange(id, start, end);
      }
    }
    const search = (files: LargeFiles, meta: DocumentMeta) => files.tools([meta]).execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", context_lines: 1 });
    const kept = createLargeFiles({ store: new Counting(directory), wholeDocumentBytes: 0, scanChunkBytes: 8_000, budget: { inlineTokens: 5 } });
    const meta = await kept.ingest({ name: "app.log", bytes: bytes(TEXTS.log!) });
    const first = await search(kept, meta);
    const afterFirst = reads.count;
    expect(afterFirst).toBeGreaterThan(5);
    expect(await search(kept, meta)).toEqual(first);
    expect(reads.count).toBe(afterFirst);

    // A cache too small for a quarter of the decoded text keeps none of it.
    const small = createLargeFiles({ store: new Counting(directory), wholeDocumentBytes: 0, scanChunkBytes: 8_000, cacheBytes: 40_000, budget: { inlineTokens: 5 } });
    await search(small, meta);
    const before = reads.count;
    expect(await search(small, meta)).toEqual(first);
    expect(reads.count - before).toBeGreaterThan(5);

    // Deleted by another server: not served from the pieces.
    await createLargeFiles({ store: new FileDocumentStore(directory) }).delete(meta.id);
    expect((await search(kept, meta)).error).toMatch(/no longer available/);
  });

  it("stops a slow regex on a document read by range, within the time limit", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    const text = Array.from({ length: 2_000 }, () => `${"a".repeat(28)}!`).join("\n");
    const meta = await createLargeFiles({ store }).ingest({ name: "trap.txt", bytes: bytes(text) });
    const document = (await openRangedDocument(store, meta, { chunkBytes: 2_000, limiter: new Limiter(4) })) as RangedDocument;
    const started = performance.now();
    const result = await grepSource(document, "(a|a)+$", { regex: true, maxResults: 5, contextLines: 0, timeLimitMs: 150 });
    expect(result.stoppedEarly).toBe(true);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("sweep on a shared volume", () => {
  it("removes expired documents, and files of no document once they are old, but never an upload in progress", async () => {
    const directory = await folder();
    const start = Date.parse("2026-06-01T00:00:00Z");
    let clock = new Date(start);
    const store = new FileDocumentStore(directory, { now: () => clock, orphanAgeMs: 60_000 });
    const files = createLargeFiles({ store, now: () => clock, ttlMs: 10 * 60_000 });
    const dying = await files.ingest({ name: "dying.log", bytes: bytes(TEXTS.log!) });
    clock = new Date(start + 5 * 60_000);
    const live = await files.ingest({ name: "live.log", bytes: bytes(TEXTS.log!) });
    clock = new Date(start + 10 * 60_000 + 1_000); // dying has expired, live has not

    // File times as the store's clock sees them: written just now, or two minutes ago.
    const written = async (entry: string, content: string, ago = 0) => {
      await writeFile(path.join(directory, entry), content);
      const at = new Date(clock.getTime() - ago);
      await utimes(path.join(directory, entry), at, at);
    };
    // An upload in progress on another server: its files without metadata yet, and a temporary file.
    const uploading = `doc_${"1".repeat(32)}`;
    await written(`${uploading}.bin`, "x");
    await written(`${uploading}.json.0123abcd.tmp`, "{");
    // Left behind by a server that stopped.
    const stale = `doc_${"2".repeat(32)}`;
    for (const extension of ["bin", "txt", "idx"]) await written(`${stale}.${extension}`, "x", 2 * 60_000);
    await written(`${live.id}.txt.89abcdef.tmp`, "x", 2 * 60_000);
    // Metadata that cannot be read: being written right now by a server of an older version, or broken long ago.
    const writing = `doc_${"3".repeat(32)}`;
    await written(`${writing}.json`, "{\"id\":");
    await written(`${writing}.txt`, "text");
    const broken = `doc_${"4".repeat(32)}`;
    await written(`${broken}.json`, "{\"id\":", 2 * 60_000);
    await written("notes.txt", "not ours", 2 * 60_000);

    expect(await files.sweep()).toBe(2); // dying, and the broken one
    expect((await readdir(directory)).sort()).toEqual([
      `${uploading}.bin`, `${uploading}.json.0123abcd.tmp`,
      `${writing}.json`, `${writing}.txt`,
      `${live.id}.idx`, `${live.id}.json`, `${live.id}.txt`,
      "notes.txt",
    ].sort());
    expect((await files.prepare([live.id, dying.id], { tokens: 0, bytes: 0 })).missing).toEqual([dying.id]);
  });

  it("leaves no temporary file behind after an ingest", async () => {
    const directory = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(directory), keepOriginals: ["log"] });
    await Promise.all(Array.from({ length: 20 }, (_, i) => files.ingest({ name: `f${i}.log`, bytes: bytes(TEXTS.log!) })));
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect((await readdir(directory)).length).toBe(80);
  });
});
