import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type DocumentMeta, type DocumentStore, type StoredDocument } from "../src/index.js";
import { numberedPdf, utf8 } from "./pdf-fixtures.js";

/** A store as an application wrote it for 0.2.0: without the two methods for original files. */
function storeWithoutOriginals(): DocumentStore & { documents: Map<string, StoredDocument> } {
  const documents = new Map<string, StoredDocument>();
  return {
    documents,
    put: async (document) => void documents.set(document.meta.id, document),
    get: async (id) => documents.get(id),
    getMeta: async (id) => documents.get(id)?.meta,
    delete: async (id) => documents.delete(id),
  };
}

describe("original files", () => {
  const pdf = numberedPdf(3);

  it("keeps nothing unless the caller asks for it", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdf });
    expect(meta.originalKept).toBeUndefined();
    expect(Object.keys(meta)).not.toContain("originalKept");
    expect(await files.getOriginal(meta.id)).toBeUndefined();
    expect(await store.getOriginal(meta.id)).toBeUndefined();
  });

  it("keeps the uploaded file of the formats that are listed, byte for byte", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const report = await files.ingest({ name: "report.pdf", bytes: pdf });
    const notes = await files.ingest({ name: "notes.md", bytes: utf8("# Notes") });
    expect(report.originalKept).toBe(true);
    expect(report.bytes).toBe(pdf.length);
    expect(await files.getOriginal(report.id)).toEqual(pdf);
    expect((await files.getMeta(report.id))?.originalKept).toBe(true);
    expect(notes.originalKept).toBeUndefined();
    expect(await files.getOriginal(notes.id)).toBeUndefined();
  });

  it("keeps a copy, so a caller that reuses its upload buffer does not change the stored file", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const upload = pdf.slice();
    const meta = await files.ingest({ name: "report.pdf", bytes: upload });
    upload.fill(0);
    expect(await files.getOriginal(meta.id)).toEqual(pdf);
  });

  it("gives the original only to the owner of the document", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdf, owner: "alice" });
    expect(await files.getOriginal(meta.id, { owner: "bob" })).toBeUndefined();
    expect(await files.getOriginal(meta.id)).toBeUndefined();
    expect(await files.getOriginal(meta.id, { owner: "alice" })).toEqual(pdf);
    expect(await files.getOriginal("doc_ffffffffffffffffffffffffffffffff", { owner: "alice" })).toBeUndefined();
    expect(await files.getOriginal("../../etc/passwd")).toBeUndefined();
  });

  it("removes the original when the document is deleted, expires, or is swept (memory store)", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const now = () => clock;
    const store = new MemoryDocumentStore({ now });
    const files = createLargeFiles({ store, keepOriginals: ["pdf"], ttlMs: 60_000, now });
    // The files the store really holds: getOriginal alone would hide one left behind for a document that is gone.
    const held = (store as unknown as { originals: Map<string, Uint8Array> }).originals;
    const deleted = await files.ingest({ name: "a.pdf", bytes: pdf });
    expect(held.size).toBe(1);
    expect(await files.delete(deleted.id)).toBe(true);
    expect(await store.getOriginal(deleted.id)).toBeUndefined();
    expect(held.size).toBe(0);

    const expiring = await files.ingest({ name: "b.pdf", bytes: pdf });
    const swept = await files.ingest({ name: "c.pdf", bytes: pdf });
    expect(await store.getOriginal(expiring.id)).toEqual(pdf);
    clock = new Date("2026-01-01T00:02:00Z");
    // An expired document is gone for every reader, and reading it removes its file.
    expect(await files.getOriginal(expiring.id)).toBeUndefined();
    expect(await store.getOriginal(expiring.id)).toBeUndefined();
    expect([...held.keys()]).toEqual([swept.id]);
    expect(await files.sweep()).toBe(1);
    expect(await store.getOriginal(swept.id)).toBeUndefined();
    expect(held.size).toBe(0);
  });

  it("works with a store that cannot keep originals: the documents are stored without them", async () => {
    const store = storeWithoutOriginals();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdf });
    expect(meta.originalKept).toBeUndefined();
    expect(store.documents.get(meta.id)?.text).toContain("Page 1 of the test file.");
    expect(await files.getOriginal(meta.id)).toBeUndefined();
    expect(await files.delete(meta.id)).toBe(true);
  });

  it("does not leave an original behind when the document itself cannot be stored", async () => {
    const calls: string[] = [];
    const originals = new Map<string, Uint8Array>();
    const failing: DocumentStore = {
      put: async () => {
        calls.push("put");
        throw new Error("disk full");
      },
      get: async () => undefined,
      getMeta: async () => undefined,
      delete: async (id) => {
        calls.push("delete");
        return originals.delete(id);
      },
      putOriginal: async (id, bytes) => {
        calls.push("putOriginal");
        originals.set(id, bytes);
      },
      getOriginal: async (id) => originals.get(id),
    };
    const files = createLargeFiles({ store: failing, keepOriginals: ["pdf"] });
    await expect(files.ingest({ name: "report.pdf", bytes: pdf })).rejects.toThrow("disk full");
    // The file is written first and the document last; the file is removed when the document fails.
    expect(calls).toEqual(["putOriginal", "put", "delete"]);
    expect(originals.size).toBe(0);
  });

  it("reports a document without its original when the store lost the file", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdf });
    // A store that lost the file (a cleaned volume, a partial restore) still has the document.
    (store as unknown as { originals: Map<string, Uint8Array> }).originals.clear();
    expect((await files.getMeta(meta.id))?.originalKept).toBe(true);
    expect(await files.getOriginal(meta.id)).toBeUndefined();
  });
});

describe("FileDocumentStore with original files", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const pdf = numberedPdf(2);

  it("writes <id>.bin next to the text and the metadata, and reads it back after a restart", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "large-files-"));
    const files = createLargeFiles({ store: new FileDocumentStore(directory), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdf });
    const text = await files.ingest({ name: "notes.md", bytes: utf8("# Notes") });
    expect((await readdir(directory)).sort()).toEqual([`${meta.id}.bin`, `${meta.id}.json`, `${meta.id}.txt`, `${text.id}.json`, `${text.id}.txt`].sort());
    expect(new Uint8Array(await readFile(path.join(directory, `${meta.id}.bin`)))).toEqual(pdf);
    expect((JSON.parse(await readFile(path.join(directory, `${meta.id}.json`), "utf8")) as DocumentMeta).originalKept).toBe(true);

    const restarted = createLargeFiles({ store: new FileDocumentStore(directory), keepOriginals: ["pdf"] });
    expect(await restarted.getOriginal(meta.id)).toEqual(pdf);
    expect(await restarted.getOriginal(text.id)).toBeUndefined();
  });

  it("removes the file on delete, and on sweep once the document has expired", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "large-files-"));
    let clock = new Date("2026-01-01T00:00:00Z");
    const now = () => clock;
    const store = new FileDocumentStore(directory, { now });
    const files = createLargeFiles({ store, keepOriginals: ["pdf"], ttlMs: 60_000, now });
    const deleted = await files.ingest({ name: "a.pdf", bytes: pdf });
    const kept = await files.ingest({ name: "b.pdf", bytes: pdf });
    expect(await files.delete(deleted.id)).toBe(true);
    expect((await readdir(directory)).sort()).toEqual([`${kept.id}.bin`, `${kept.id}.json`, `${kept.id}.txt`]);

    clock = new Date("2026-01-01T00:00:30Z");
    expect(await files.sweep()).toBe(0);
    expect(await store.getOriginal(kept.id)).toEqual(pdf);
    clock = new Date("2026-01-01T00:02:00Z");
    expect(await files.sweep()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("stops giving the file once the document has expired, without waiting for a sweep", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "large-files-"));
    let clock = new Date("2026-01-01T00:00:00Z");
    const now = () => clock;
    const store = new FileDocumentStore(directory, { now });
    const files = createLargeFiles({ store, keepOriginals: ["pdf"], ttlMs: 60_000, now });
    const meta = await files.ingest({ name: "a.pdf", bytes: pdf });
    clock = new Date("2026-01-01T00:02:00Z");
    expect(await store.getOriginal(meta.id)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("never reaches the file system with an ID that is not a document ID", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "large-files-"));
    const store = new FileDocumentStore(directory);
    await expect(store.putOriginal("../escape", pdf)).rejects.toThrow("Invalid document ID.");
    expect(await store.getOriginal("../../etc/passwd")).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("answers that there is no original for a document stored before originals were kept", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "large-files-"));
    const before = createLargeFiles({ store: new FileDocumentStore(directory) });
    const meta = await before.ingest({ name: "old.pdf", bytes: pdf });
    const after = createLargeFiles({ store: new FileDocumentStore(directory), keepOriginals: ["pdf"] });
    expect((await after.getMeta(meta.id))?.originalKept).toBeUndefined();
    expect(await after.getOriginal(meta.id)).toBeUndefined();
  });
});
