// An ingest whose caller leaves while the store writes the document (0.9.0): once the writes have
// ended, what they wrote is removed, and the caller gets its own reason. Before, the document stayed,
// and with `ttlMs: Infinity` it was never removed (the probe abort-write.mjs found one with expiresAt
// 9999-12-31 after an abort during the put).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type DocumentContext, type IngestEvent, type StoredDocument } from "llm-large-files";
import { serviceLog, utf8 } from "./fake-model.js";
import { RangedStoreOf08 } from "./held-store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("an ingest aborted while the store writes", () => {
  it("throws the signal's reason and leaves the store empty: every part, under ttlMs Infinity", async () => {
    const store = new RangedStoreOf08();
    const files = createLargeFiles({ requireOwner: false, store, ttlMs: Infinity, keepOriginals: ["log"] });
    const put = store.holds.hold("put");
    const controller = new AbortController();
    const reason = new Error("The uploader left.");
    const events: IngestEvent[] = [];
    const ingest = files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)), signal: controller.signal, onEvent: (event) => events.push(event) });
    await put.reached;
    // The original and the index are written; the metadata is being written when the caller leaves.
    expect(store.originals.size).toBe(1);
    expect(store.indexes.size).toBe(1);
    controller.abort(reason);
    put.release();
    await expect(ingest).rejects.toBe(reason);
    expect(store.documents.size).toBe(0);
    expect(store.originals.size).toBe(0);
    expect(store.indexes.size).toBe(0);
    expect(events.map((event) => event.type).at(-1)).toBe("ingest.error");
    expect(events.some((event) => event.type === "ingest.finish")).toBe(false);
  });

  it("does so for a slow put and an abort at 150 ms, with FileDocumentStore", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llf-abort-"));
    try {
      class SlowStore extends FileDocumentStore {
        override async put(document: StoredDocument, context?: DocumentContext) {
          await sleep(400);
          return super.put(document, context);
        }
      }
      const files = createLargeFiles({ requireOwner: false, store: new SlowStore(directory), ttlMs: Infinity });
      const controller = new AbortController();
      let writing!: () => void;
      const written = new Promise<void>((resolve) => (writing = resolve));
      const ingest = files.ingest({
        name: "notes.md",
        bytes: utf8("# Notes\n\nShort."),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "ingest.progress" && event.stage === "index") writing();
        },
      });
      // The text is read in a few ms; the abort comes 150 ms later, during the put of 400 ms.
      await written;
      await sleep(150);
      controller.abort(new Error("Gone at 150 ms."));
      await expect(ingest).rejects.toThrow("Gone at 150 ms.");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("frees the application's ID once the removal is done, and leaves another's document", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ requireOwner: false, store, ttlMs: Infinity });
    const controller = new AbortController();
    const reason = new Error("Left.");
    // The listener of the last store progress leaves: the writes have all ended by then.
    const ingest = files.ingest({
      name: "a.md",
      id: "upload-1",
      bytes: utf8("# A"),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "ingest.progress" && event.stage === "store" && event.done === event.total) controller.abort(reason);
      },
    });
    await expect(ingest).rejects.toBe(reason);
    expect(await files.getMeta("upload-1")).toBeUndefined();
    // The ID is free again.
    expect((await files.ingest({ name: "a.md", id: "upload-1", bytes: utf8("# A") })).id).toBe("upload-1");
  });

  it("stores the document when the caller stays", async () => {
    const store = new RangedStoreOf08();
    const files = createLargeFiles({ requireOwner: false, store, ttlMs: Infinity });
    const controller = new AbortController();
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(30)), signal: controller.signal });
    controller.abort();
    expect(store.documents.has(meta.id)).toBe(true);
  });
});
