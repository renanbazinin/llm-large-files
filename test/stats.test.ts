// Counters for metrics and alerts (0.10.0): `files.stats()` and `handlers.stats()` give plain
// numbers, read without a store call and without waiting. createLargeFiles returns
// `CreatedLargeFiles`, so `files.stats()` needs no `?.` (test/types/compat-0.10.ts compiles it).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type CreatedLargeFiles, type DocumentContext, type DocumentStore, type LargeFilesStats } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";
import { serviceLog, utf8 } from "llm-large-files/testing";
import { library } from "./page-look-library.js";
import { heldExtractor, until } from "./upload-server.js";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A store that notes every method called on it. */
function watched<T extends DocumentStore>(store: T): { store: T; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

describe("files.stats()", () => {
  it("gives plain numbers, without a store call", () => {
    const { store, calls } = watched(new MemoryDocumentStore());
    const files: CreatedLargeFiles = createLargeFiles({ store, cacheBytes: 1_000_000, maxStuckStoreCalls: 3 });
    const stats: LargeFilesStats = files.stats();
    expect(stats).toEqual({
      ingests: { active: 0, waiting: 0 },
      scans: { active: 0, waiting: 0 },
      pageLooks: { active: 0, waiting: 0 },
      cache: { bytes: 0, entries: 0, maxBytes: 1_000_000 },
      stuckStoreCalls: 0,
      maxStuckStoreCalls: 3,
    });
    expect(calls).toEqual([]);
    // A copy each time: changing one changes nothing.
    stats.ingests.active = 9;
    expect(files.stats().ingests.active).toBe(0);
  });

  it("moves with an ingest that is held, and one that waits its turn", async () => {
    const held = heldExtractor();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: held.extract }, maxConcurrentIngests: 1 });
    const first = files.ingest({ name: "a.txt", bytes: utf8("alpha\n") });
    const second = files.ingest({ name: "b.txt", bytes: utf8("beta\n") });
    await until(() => held.state.running === 1);
    await until(() => files.stats().ingests.waiting === 1);
    expect(files.stats().ingests).toEqual({ active: 1, waiting: 1 });
    held.state.releaseOne();
    await first;
    await until(() => held.state.running === 1);
    expect(files.stats().ingests).toEqual({ active: 1, waiting: 0 });
    held.state.releaseAll();
    await second;
    expect(files.stats().ingests).toEqual({ active: 0, waiting: 0 });
  });

  it("moves with a look at pages that is held, and one that waits its turn", async () => {
    const gates: Array<() => void> = [];
    const { files, look, loads } = await library({ maxConcurrentPageLooks: 1 }, () => new Promise<void>((resolve) => gates.push(resolve)));
    const first = look();
    const second = look();
    await until(() => loads.now === 1);
    await until(() => files.stats().pageLooks.waiting === 1);
    expect(files.stats().pageLooks).toEqual({ active: 1, waiting: 1 });
    gates.shift()!();
    await first;
    await until(() => loads.now === 1);
    expect(files.stats().pageLooks).toEqual({ active: 1, waiting: 0 });
    gates.shift()!();
    await second;
    expect(files.stats().pageLooks).toEqual({ active: 0, waiting: 0 });
  });

  it("moves with a scan of a document read by range, and counts what the cache keeps", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llf-stats-"));
    directories.push(directory);
    let gate: Promise<void> | undefined;
    class Slow extends FileDocumentStore {
      override async readTextRange(id: string, start: number, end: number, context?: DocumentContext) {
        if (gate) await gate;
        return super.readTextRange(id, start, end, context);
      }
    }
    const files = createLargeFiles({ store: new Slow(directory), wholeDocumentBytes: 0, maxConcurrentScans: 1, cacheBytes: 50_000_000 });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const tools = files.tools([meta]);
    expect(await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 2 })).toMatchObject({ lines: "1-2" });
    const kept = files.stats().cache;
    expect(kept.entries).toBeGreaterThan(0);
    expect(kept.bytes).toBeGreaterThan(0);
    expect(kept.maxBytes).toBe(50_000_000);

    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const searching = tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" });
    await until(() => files.stats().scans.active === 1);
    release();
    gate = undefined;
    await searching;
    expect(files.stats().scans).toEqual({ active: 0, waiting: 0 });
    // The pieces read for the search are kept too.
    expect(files.stats().cache.entries).toBeGreaterThan(kept.entries);
  });
});

describe("handlers.stats()", () => {
  async function serve(options: Parameters<typeof createDocumentHandlers>[1]) {
    const held = heldExtractor();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: held.extract }, maxConcurrentIngests: 10 });
    const handlers = createDocumentHandlers(files, options);
    const server = createServer((request, response) => void handlers.upload(request, response));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const upload = (name: string, body: string) => fetch(url, { method: "POST", headers: { "X-File-Name": name }, body });
    return { handlers, held, upload };
  }

  it("counts the bytes held in memory and the uploads in flight, while an ingest is held", async () => {
    const { handlers, held, upload } = await serve({});
    expect(handlers.stats()).toEqual({ memoryBytes: 0, spooledBytes: 0, uploadsInFlight: 0 });
    const answering = upload("a.txt", "x".repeat(5_000));
    await until(() => held.state.running === 1);
    expect(handlers.stats()).toEqual({ memoryBytes: 5_000, spooledBytes: 0, uploadsInFlight: 1 });
    held.state.releaseAll();
    expect((await answering).status).toBe(201);
    await until(() => handlers.stats().uploadsInFlight === 0);
    expect(handlers.stats()).toEqual({ memoryBytes: 0, spooledBytes: 0, uploadsInFlight: 0 });
  });

  it("counts the bytes of the spool's files, with no limit on them too", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "llf-stats-spool-"));
    directories.push(spool);
    const { handlers, held, upload } = await serve({ uploadSpool: { directory: spool, minBytes: 0 }, maxSpooledUploadBytes: Number.POSITIVE_INFINITY, maxPendingUploadBytes: Number.POSITIVE_INFINITY });
    const answering = upload("a.txt", "y".repeat(3_000));
    await until(() => held.state.running === 1);
    expect(handlers.stats()).toEqual({ memoryBytes: 0, spooledBytes: 3_000, uploadsInFlight: 1 });
    held.state.releaseAll();
    expect((await answering).status).toBe(201);
    await until(() => handlers.stats().uploadsInFlight === 0);
    expect(handlers.stats()).toEqual({ memoryBytes: 0, spooledBytes: 0, uploadsInFlight: 0 });
    expect(await readdir(spool)).toEqual([]);
  });
});
