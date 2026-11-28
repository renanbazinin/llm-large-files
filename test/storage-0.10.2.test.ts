// Storage for an application's own panels (0.10.2): `files.list`, `files.touch` (expiry from the
// last use, H5), and the application's own data on a document (`appData`, `files.update`), over the
// memory and file stores, with `list` and `patchMeta` on the store.
import { chmod, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  askWithFiles,
  compactToolTurns,
  createLargeFiles,
  FileDocumentStore,
  MAX_APP_DATA_BYTES,
  MemoryDocumentStore,
  toDocumentSummary,
  type DocumentContext,
  type DocumentMeta,
  type DocumentStore,
} from "llm-large-files";
import { DocumentCache } from "../src/cache.js";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";

const HOUR = 60 * 60 * 1000;
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A clock the test moves. */
const clock = (start = Date.parse("2026-11-25T08:00:00Z")) => {
  let at = start;
  return { now: () => new Date(at), advance: (ms: number) => (at += ms) };
};

/** The two built-in stores, each with the same clock, the file store keeping a folder per chat. */
async function stores(now: () => Date): Promise<Array<[string, DocumentStore]>> {
  directory = await mkdtemp(path.join(tmpdir(), "llf-0102-"));
  return [
    ["memory", new MemoryDocumentStore({ now })],
    ["file", new FileDocumentStore(directory, { now, scopes: { depth: 2, createScopeFolders: true, unscoped: "root" } })],
  ];
}

describe("files.list", () => {
  it("leaves out metadata whose metaVersion is NaN, which getMeta refuses, and so does dedupe (0.99.9)", async () => {
    const memory = new MemoryDocumentStore();
    let bad: string | undefined;
    const spoiled = (meta: DocumentMeta | undefined) => (meta !== undefined && meta.id === bad ? { ...meta, metaVersion: Number.NaN } : meta);
    // A store of your own whose metadata of one document comes back with a version that is not one.
    const store: DocumentStore = {
      put: (document, context) => memory.put(document, context),
      get: async (id, context) => {
        const document = await memory.get(id, context);
        return document && { ...document, meta: spoiled(document.meta)! };
      },
      getMeta: async (id, context) => spoiled(await memory.getMeta(id, context)),
      delete: (id, context) => memory.delete(id, context),
      list: async (context) => (await memory.list(context)).map((meta) => spoiled(meta)!),
    };
    const files = createLargeFiles({ requireOwner: false, store });
    const spoilt = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), owner: "u1" });
    const good = await files.ingest({ name: "b.txt", bytes: utf8("beta"), owner: "u1" });
    bad = spoilt.id;
    expect((await files.list!({ owner: "u1" })).map((meta) => meta.id)).toEqual([good.id]);
    await expect(files.getMeta(spoilt.id, { owner: "u1" })).rejects.toMatchObject({ code: "NEWER_VERSION" });
    // The same file again with dedupe is stored anew: the spoilt document is not taken for it.
    const again = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), owner: "u1", dedupe: true });
    expect(again.id).not.toBe(spoilt.id);
  });

  it("lists the documents of a scope the caller may use, the oldest first, without expired ones", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ requireOwner: false, store, now: time.now, ttlMs: 2 * HOUR });
      const chat = ["u1", "c1"];
      const first = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), owner: "u1", scope: chat });
      time.advance(1_000);
      const second = await files.ingest({ name: "b.txt", bytes: utf8("beta"), owner: "u1", scope: chat });
      await files.ingest({ name: "theirs.txt", bytes: utf8("gamma"), owner: "u2", scope: chat });
      await files.ingest({ name: "other-chat.txt", bytes: utf8("delta"), owner: "u1", scope: ["u1", "c2"] });
      await files.ingest({ name: "no-scope.txt", bytes: utf8("eps"), owner: "u1" });
      expect((await files.list!({ owner: "u1", scope: chat })).map((meta) => meta.id), kind).toEqual([first.id, second.id]);
      expect((await files.list!({ owner: "u1" })).map((meta) => meta.name), kind).toEqual(["no-scope.txt"]);
      // Another owner sees only their own; a scope with nothing in it gives none.
      expect((await files.list!({ owner: "u2", scope: chat })).map((meta) => meta.name), kind).toEqual(["theirs.txt"]);
      expect(await files.list!({ owner: "u1", scope: ["u1", "none"] }), kind).toEqual([]);
      // The first document expires an hour before the second would have.
      time.advance(2 * HOUR - 500);
      expect((await files.list!({ owner: "u1", scope: chat })).map((meta) => meta.id), kind).toEqual([second.id]);
    }
  });

  it("leaves out metadata it cannot read, of a newer version, or that names another file", async () => {
    const time = clock();
    const [, store] = (await stores(time.now))[1]!;
    const files = createLargeFiles({ requireOwner: false, store, now: time.now });
    const kept = await files.ingest({ name: "kept.txt", bytes: utf8("x") });
    const newer = await files.ingest({ name: "newer.txt", bytes: utf8("y") });
    const folder = directory!;
    const meta = JSON.parse(JSON.stringify(await store.getMeta(newer.id)));
    await writeFile(path.join(folder, `${newer.id}.json`), JSON.stringify({ ...meta, metaVersion: 99 }));
    await writeFile(path.join(folder, "doc_broken.json"), "{ not json");
    await writeFile(path.join(folder, "notes.json"), JSON.stringify({ ...meta, id: "elsewhere" }));
    expect((await files.list!()).map((item) => item.id)).toEqual([kept.id]);
    // getMeta still refuses the newer one, as before.
    await expect(files.getMeta(newer.id)).rejects.toMatchObject({ code: "NEWER_VERSION" });
  });

  it("is a TypeError over a store without list, and follows requireOwner and requireScope", async () => {
    const memory = new MemoryDocumentStore();
    const bare: DocumentStore = { put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c) };
    await expect(createLargeFiles({ requireOwner: false, store: bare }).list!()).rejects.toThrow(TypeError);
    await expect(createLargeFiles({ store: memory, requireOwner: true }).list!()).rejects.toThrow("owner is required");
    await expect(createLargeFiles({ requireOwner: false, store: memory, requireScope: true }).list!({ owner: "u" })).rejects.toThrow("scope is required");
  });
});

describe("files.touch", () => {
  it("counts the expiry again from now, never earlier, and only for the caller who may use the document", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ requireOwner: false, store, now: time.now, ttlMs: 2 * HOUR });
      const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), owner: "u1", scope: ["u1", "c1"] });
      const access = { owner: "u1", scope: ["u1", "c1"] };
      time.advance(HOUR + 30 * 60 * 1000);
      const touched = await files.touch!(meta.id, access);
      expect(touched?.expiresAt, kind).toBe(new Date(time.now().getTime() + 2 * HOUR).toISOString());
      // The text and the rest of the metadata are as they were.
      expect({ ...touched, expiresAt: meta.expiresAt }, kind).toEqual(meta);
      time.advance(HOUR);
      expect(await files.getMeta(meta.id, access), kind).toBeDefined();
      const tools = files.tools([meta], { access });
      expect((await tools.execute("read_document", { document_id: meta.id })).text ?? "", kind).toContain("alpha");
      // Another owner, another scope, an unknown ID: undefined, and nothing written.
      expect(await files.touch!(meta.id, { owner: "u2", scope: ["u1", "c1"] }), kind).toBeUndefined();
      expect(await files.touch!(meta.id, { owner: "u1", scope: ["u1", "c2"] }), kind).toBeUndefined();
      expect(await files.touch!("doc_00000000000000000000000000000000", access), kind).toBeUndefined();
      // A library with a shorter time to live does not shorten it.
      const shorter = createLargeFiles({ requireOwner: false, store, now: time.now, ttlMs: 60_000 });
      expect((await shorter.touch!(meta.id, access))?.expiresAt, kind).toBe(touched!.expiresAt);
      // Past its expiry, it is gone.
      time.advance(2 * HOUR);
      expect(await files.touch!(meta.id, access), kind).toBeUndefined();
    }
  });

  it("is a TypeError over a store without patchMeta", async () => {
    const memory = new MemoryDocumentStore();
    const bare: DocumentStore = { put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c) };
    const files = createLargeFiles({ requireOwner: false, store: bare });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    await expect(files.touch!(meta.id)).rejects.toThrow("files.touch needs a store with patchMeta()");
    await expect(files.update!(meta.id, { appData: { a: 1 } })).rejects.toThrow("files.update needs a store with patchMeta()");
  });
});

describe("appData", () => {
  it("is kept from the ingest, changed and removed by update, and never sent to the model nor in a summary", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ requireOwner: false, store, now: time.now });
      const access = { owner: "u1", scope: ["u1", "c1"] };
      const meta = await files.ingest({ name: "orders.csv", bytes: utf8("id,amount\n1,10\n2,20\n"), ...access, appData: { rowId: "mongo-42", tags: ["finance"] } });
      expect(meta.appData, kind).toEqual({ rowId: "mongo-42", tags: ["finance"] });
      expect((await files.getMeta(meta.id, access))?.appData, kind).toEqual({ rowId: "mongo-42", tags: ["finance"] });
      expect(JSON.stringify(toDocumentSummary(meta)), kind).not.toContain("mongo-42");
      const updated = await files.update!(meta.id, { appData: { rowId: "mongo-43" } }, access);
      expect(updated?.appData, kind).toEqual({ rowId: "mongo-43" });
      expect((await files.list!(access))[0]?.appData, kind).toEqual({ rowId: "mongo-43" });
      // A question over it: neither the card nor the text sent carries it.
      const model = fakeModel([says("The total is 30 (orders.csv L2-L3).")]);
      await askWithFiles({ model, files, documentIds: [meta.id], messages: [{ role: "user", text: "Total?" }], ...access });
      expect(JSON.stringify(model.requests), kind).not.toContain("mongo-43");
      expect(JSON.stringify(model.requests), kind).toContain("orders.csv");
      const removed = await files.update!(meta.id, { appData: null }, access);
      expect(removed && "appData" in removed, kind).toBe(false);
      expect((await files.getMeta(meta.id, access))?.appData, kind).toBeUndefined();
      // Another caller changes nothing.
      expect(await files.update!(meta.id, { appData: { x: 1 } }, { owner: "u2", scope: ["u1", "c1"] }), kind).toBeUndefined();
    }
  });

  it("is a JSON object of at most MAX_APP_DATA_BYTES, at ingest and in update", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const big = { text: "x".repeat(MAX_APP_DATA_BYTES) };
    await expect(files.ingest({ name: "a.txt", bytes: utf8("a"), appData: big })).rejects.toThrow(RangeError);
    for (const bad of [[1, 2], "label", 42, { n: 10n }]) {
      await expect(files.ingest({ name: "a.txt", bytes: utf8("a"), appData: bad as never })).rejects.toThrow(TypeError);
    }
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("a"), appData: null as never });
    expect(meta.appData).toBeUndefined();
    await expect(files.update!(meta.id, { appData: big })).rejects.toThrow(RangeError);
    await expect(files.update!(meta.id, { name: "b.txt" } as never)).rejects.toThrow("files.update changes appData only");
    // A copy: changing the object given changes nothing stored.
    const given = { label: "first" };
    const kept = await files.update!(meta.id, { appData: given });
    given.label = "changed";
    expect(kept?.appData).toEqual({ label: "first" });
    expect((await files.getMeta(meta.id))?.appData).toEqual({ label: "first" });
  });
});

describe("FileDocumentStore.patchMeta", () => {
  it("changes the metadata of a document that is there, and nothing for one that is gone", async () => {
    const time = clock();
    const [, store] = (await stores(time.now))[1]!;
    const files = createLargeFiles({ requireOwner: false, store, now: time.now });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), scope: ["u1", "c1"] });
    const context = { scope: ["u1", "c1"] };
    expect(await store.patchMeta!(meta.id, { createdAt: meta.createdAt, scope: ["u1", "c1"], appData: { a: 1 } }, context)).toEqual({ ...meta, appData: { a: 1 } });
    expect((await store.getMeta(meta.id, context))?.appData).toEqual({ a: 1 });
    expect((await store.get(meta.id, context))?.text).toBe("alpha");
    await files.delete(meta.id, context);
    expect(await store.patchMeta!(meta.id, { createdAt: meta.createdAt, scope: ["u1", "c1"], appData: { a: 2 } }, context)).toBeUndefined();
    const folder = path.join(directory!, "u1", "c1", ".llm-large-files");
    expect((await readdir(folder)).filter((name) => name.startsWith(meta.id))).toEqual([]);
    // A scope whose folder is not there: undefined, and no folder is made.
    expect(await store.patchMeta!(meta.id, { createdAt: meta.createdAt }, { scope: ["u9", "c9"] })).toBeUndefined();
    expect(await readdir(directory!)).toEqual(["u1"]);
  });
});

describe("the review of 0.10.2", () => {
  it("lists without removing anything: the application's own expired JSON in a folder it shares stays", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-0102-"));
    const store = new FileDocumentStore(directory);
    const files = createLargeFiles({ requireOwner: false, store });
    const kept = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    await writeFile(path.join(directory, "notes.json"), JSON.stringify({ title: "mine", expiresAt: "2020-01-01T00:00:00Z" }));
    await writeFile(path.join(directory, "notes.txt"), "my notes");
    await writeFile(path.join(directory, "plan.json"), JSON.stringify({ ...kept, id: "plan", expiresAt: "2020-01-01T00:00:00Z" }));
    await writeFile(path.join(directory, "plan.txt"), "my plan");
    expect((await files.list!()).map((meta) => meta.id)).toEqual([kept.id]);
    expect((await readdir(directory)).sort()).toEqual([`${kept.id}.idx`, `${kept.id}.json`, `${kept.id}.txt`, "notes.json", "notes.txt", "plan.json", "plan.txt"].sort());
  });

  it("lists a document without an owner only to a caller without one, and none of another scope", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const open = await files.ingest({ name: "open.txt", bytes: utf8("open") });
    const mine = await files.ingest({ name: "mine.txt", bytes: utf8("mine"), owner: "u1" });
    await files.ingest({ name: "scoped.txt", bytes: utf8("scoped"), owner: "u1", scope: ["u1", "c1"] });
    expect((await files.list!({ owner: "u1" })).map((meta) => meta.id)).toEqual([mine.id]);
    expect((await files.list!({ owner: "u2" })).map((meta) => meta.id)).toEqual([]);
    expect((await files.list!()).map((meta) => meta.id)).toEqual([open.id]);
    // getMeta still gives the open one to anyone who has its ID, as before.
    expect(await files.getMeta(open.id, { owner: "u2" })).toBeDefined();
  });

  it("never changes a document stored again under the ID between the look and the change", async () => {
    // The store keeps the library's clock: with the real one, the document expired once the real
    // date passed the clock's 72 hours (2026-11-28 08:01 UTC), and the test failed from then on.
    const time = clock();
    const memory = new MemoryDocumentStore({ now: time.now });
    let swap: (() => Promise<void>) | undefined;
    // A store where another server deletes the document and stores another under its ID, between
    // the library's getMeta and its patchMeta.
    const store: DocumentStore = {
      put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c),
      list: (c) => memory.list(c),
      patchMeta: async (id, patch, c) => {
        await swap?.();
        return memory.patchMeta(id, patch, c);
      },
    };
    const files = createLargeFiles({ requireOwner: false, store, now: time.now });
    const first = await files.ingest({ name: "report.txt", bytes: utf8("AAAA of A"), id: "report-1", owner: "a" });
    swap = async () => {
      swap = undefined;
      await memory.delete("report-1");
      time.advance(1_000);
      await files.ingest({ name: "report.txt", bytes: utf8("BBBB of B"), id: "report-1", owner: "b" });
    };
    // Later, so that the touch has something to write.
    time.advance(60_000);
    expect(await files.touch!("report-1", { owner: "a" })).toBeUndefined();
    const theirs = await files.getMeta("report-1", { owner: "b" });
    expect(theirs?.owner).toBe("b");
    expect(theirs?.createdAt).not.toBe(first.createdAt);
    expect(await files.getMeta("report-1", { owner: "a" })).toBeUndefined();
  });

  it("keeps both a touch and an update made at once", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ requireOwner: false, store, now: time.now, ttlMs: 2 * HOUR });
      const access = { owner: "u1", scope: ["u1", "c1"] };
      const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), ...access });
      time.advance(HOUR);
      await Promise.all([files.touch!(meta.id, access), files.update!(meta.id, { appData: { v: 2 } }, access)]);
      const now = await files.getMeta(meta.id, access);
      expect(now?.appData, kind).toEqual({ v: 2 });
      expect(now?.expiresAt, kind).toBe(new Date(time.now().getTime() + 2 * HOUR).toISOString());
    }
  });

  it("dedupe stores the file when the document it found is deleted before its expiry is counted again", async () => {
    const memory = new MemoryDocumentStore();
    let deleteFirst = false;
    const store: DocumentStore = {
      put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c),
      list: (c) => memory.list(c),
      patchMeta: async (id, patch, c) => {
        if (deleteFirst) await memory.delete(id, c);
        return memory.patchMeta(id, patch, c);
      },
    };
    const files = createLargeFiles({ requireOwner: false, store });
    const bytes = utf8("alpha beta");
    const first = await files.ingest({ name: "a.txt", bytes, dedupe: true });
    deleteFirst = true;
    const again = await files.ingest({ name: "a.txt", bytes, dedupe: true });
    expect(again.id).not.toBe(first.id);
    expect(await files.getMeta(again.id)).toBeDefined();
  });

  it("sweeps metadata whose text is gone, once it is old", async () => {
    // The real time: the age of a file is from its time on the disk.
    const time = clock(Date.now());
    const [, store] = (await stores(time.now))[1]!;
    const files = createLargeFiles({ requireOwner: false, store, now: time.now });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    await rm(path.join(directory!, `${meta.id}.txt`));
    // Young: left, as an upload of an older version may be writing it.
    expect(await files.sweep()).toBe(0);
    time.advance(5_000);
    const later = new FileDocumentStore(directory!, { now: time.now, orphanAgeMs: 1_000, scopes: { depth: 2, createScopeFolders: true, unscoped: "root" } });
    expect(await later.sweep(time.now())).toBe(1);
    expect((await readdir(directory!)).filter((name) => name.startsWith(meta.id))).toEqual([]);
  });
});

describe("the second review of 0.10.2", () => {
  it("does not use the built-in list or patchMeta of a subclass that reads or writes in its own way", async () => {
    // A store of 0.10.1: a subclass that keeps a field of its own in the metadata.
    class Labelled extends MemoryDocumentStore {
      override async getMeta(id: string, context?: DocumentContext) {
        const meta = await super.getMeta(id, context);
        return meta && { ...meta, name: `[x] ${meta.name}` };
      }
    }
    const files = createLargeFiles({ requireOwner: false, store: new Labelled() });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    await expect(files.list!()).rejects.toThrow("files.list needs a store with list()");
    await expect(files.touch!(meta.id)).rejects.toThrow("needs a store with patchMeta()");
    await expect(files.ingest({ name: "a.txt", bytes: utf8("alpha"), dedupe: true })).rejects.toThrow("dedupe needs a store with list()");
    // With a list of its own, it is used; a subclass that changes nothing keeps the built-in ones.
    class Listing extends Labelled {
      override async list(context?: DocumentContext) {
        return (await super.list(context)).map((item) => ({ ...item, name: `[x] ${item.name}` }));
      }
    }
    const listing = createLargeFiles({ requireOwner: false, store: new Listing() });
    await listing.ingest({ name: "b.txt", bytes: utf8("beta") });
    expect((await listing.list!()).map((item) => item.name)).toEqual(["[x] b.txt"]);
    class Plain extends MemoryDocumentStore {}
    const plain = createLargeFiles({ requireOwner: false, store: new Plain() });
    await plain.ingest({ name: "c.txt", bytes: utf8("gamma") });
    expect((await plain.list!()).map((item) => item.name)).toEqual(["c.txt"]);
  });

  it("dedupe fails in the ingest's time, and stops for the caller, when the store's list does not answer", async () => {
    const memory = new MemoryDocumentStore();
    const hung = new Promise<never>(() => undefined);
    const store: DocumentStore = {
      put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c),
      list: () => hung,
    };
    const files = createLargeFiles({ requireOwner: false, store, ingestTimeoutMs: 200, maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const timedOut = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), dedupe: true }).catch((error: unknown) => error);
    expect(timedOut).toMatchObject({ name: "DocumentStoreError", code: "ETIMEDOUT" });
    const left = new AbortController();
    const slow = createLargeFiles({ requireOwner: false, store, ingestTimeoutMs: 60_000, maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const ingest = slow.ingest({ name: "a.txt", bytes: utf8("alpha"), dedupe: true, signal: left.signal });
    setTimeout(() => left.abort(new Error("Left.")), 50);
    await expect(ingest).rejects.toThrow("Left.");
  });

  it.skipIf(process.platform === "win32")("checks the folder of a scope again before patchMeta writes, as delete does", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-0102-"));
    const outside = await mkdtemp(path.join(tmpdir(), "llf-0102-outside-"));
    try {
      const store = new FileDocumentStore(directory, { scopes: { depth: 1, createScopeFolders: true } });
      const files = createLargeFiles({ requireOwner: false, store });
      const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), scope: ["u1"] });
      // Within the second a read keeps its check, the folder becomes a link to a folder outside.
      const folder = path.join(directory, "u1", ".llm-large-files");
      for (const name of await readdir(folder)) await rename(path.join(folder, name), path.join(outside, name));
      await rm(folder, { recursive: true });
      await symlink(outside, folder);
      await expect(store.patchMeta!(meta.id, { createdAt: meta.createdAt, scope: ["u1"], appData: { a: 1 } }, { scope: ["u1"] })).rejects.toThrow(/link/);
      expect(JSON.parse(await readFile(path.join(outside, `${meta.id}.json`), "utf8")).appData).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("counts the document kept apart toward cacheSize, the one used longest ago going first", async () => {
    const meta = (id: string) => ({ id }) as DocumentMeta;
    const item = (memoryBytes: number) => ({ memoryBytes, meta: meta("x") });
    const cache = new DocumentCache<ReturnType<typeof item>>(100, 1);
    const small = item(10);
    const big = item(500);
    cache.set("small", "v", small);
    cache.set("big", "v", big);
    // The one kept apart is the latest: the small one goes.
    expect(cache.get("small", "v")).toBeUndefined();
    expect(cache.get("big", "v")).toBe(big);
    cache.set("small", "v", small);
    // The small one is the latest now: the one kept apart goes.
    expect(cache.get("big", "v")).toBeUndefined();
    expect(cache.get("small", "v")).toBe(small);
  });

  it.skipIf(process.platform === "win32")("lists past an application's file it cannot read, in a folder it shares", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-0102-"));
    const files = createLargeFiles({ requireOwner: false, store: new FileDocumentStore(directory) });
    const kept = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    const secret = path.join(directory, "secret.json");
    await writeFile(secret, "{}");
    await chmod(secret, 0o000);
    try {
      expect((await files.list!()).map((meta) => meta.id)).toEqual([kept.id]);
    } finally {
      await chmod(secret, 0o600);
    }
  });
});

describe("the third review of 0.10.2", () => {
  // About 1.5 s alone on Linux; given room for a busy machine and Windows.
  it("never leaves the metadata of a document over the text of the one that replaced it, in one process", { timeout: 60_000 }, async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-0102-"));
    const files = createLargeFiles({ requireOwner: false, store: new FileDocumentStore(directory), ttlMs: 60 * 60 * 1000 });
    for (let round = 0; round < 80; round++) {
      await files.ingest({ name: "a.txt", bytes: utf8(`alpha ${round}`), id: "race-1", ifExists: "replace" });
      await Promise.all([
        files.touch!("race-1"),
        files.update!("race-1", { appData: { round } }),
        files.ingest({ name: "b.txt", bytes: utf8(`bravo ${round}`), id: "race-1", ifExists: "replace" }),
      ]);
      const stored = await new FileDocumentStore(directory).get("race-1");
      // The metadata and the text of one document: b's (both may share a createdAt, within one millisecond).
      expect(stored?.meta.name, `round ${round}`).toBe("b.txt");
      expect(stored?.text, `round ${round}`).toBe(`bravo ${round}`);
      expect(stored?.meta.textBytes, `round ${round}`).toBe(utf8(`bravo ${round}`).byteLength);
    }
  });

  it("never changes another owner's document stored under the ID in the same millisecond", async () => {
    const memory = new MemoryDocumentStore({ now: () => new Date("2026-11-25T08:00:00Z") });
    let swap: (() => Promise<void>) | undefined;
    const store: DocumentStore = {
      put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c),
      list: (c) => memory.list(c),
      patchMeta: async (id, patch, c) => {
        await swap?.();
        return memory.patchMeta(id, patch, c);
      },
    };
    // One clock that does not move: both documents have the same createdAt.
    const files = createLargeFiles({ requireOwner: false, store, now: () => new Date("2026-11-25T08:00:00Z") });
    const first = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), id: "same-ms", owner: "alice" });
    swap = async () => {
      swap = undefined;
      await memory.delete("same-ms");
      await files.ingest({ name: "b.txt", bytes: utf8("bravo"), id: "same-ms", owner: "bob" });
    };
    expect(await files.update!("same-ms", { appData: { by: "alice" } }, { owner: "alice" })).toBeUndefined();
    const bobs = await files.getMeta("same-ms", { owner: "bob" });
    expect(bobs?.createdAt).toBe(first.createdAt);
    expect(bobs?.appData).toBeUndefined();
  });

  it("does not sweep an application's own JSON without a .txt in a folder it shares", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-0102-"));
    await writeFile(path.join(directory, "plan.json"), JSON.stringify({ id: "plan", name: "mine", expiresAt: "2999-01-01T00:00:00Z" }));
    const hourAgo = new Date(Date.now() - 2 * HOUR);
    await utimes(path.join(directory, "plan.json"), hourAgo, hourAgo);
    const store = new FileDocumentStore(directory, { orphanAgeMs: 1_000 });
    expect(await store.sweep()).toBe(0);
    expect(await readdir(directory)).toEqual(["plan.json"]);
  });

  it("drops the document used longest ago under cacheSize, whether the one kept apart or another", () => {
    const meta = (id: string) => ({ id }) as DocumentMeta;
    const item = (memoryBytes: number) => ({ memoryBytes, meta: meta("x") });
    const cache = new DocumentCache<ReturnType<typeof item>>(100, 2);
    const [a, b, big] = [item(10), item(10), item(500)];
    cache.set("a", "v", a);
    cache.set("big", "v", big);
    expect(cache.get("a", "v")).toBe(a); // a is used after big
    cache.set("b", "v", b); // one too many: big, used longest ago, goes
    expect(cache.get("big", "v")).toBeUndefined();
    expect(cache.get("a", "v")).toBe(a);
    expect(cache.get("b", "v")).toBe(b);
    cache.set("big", "v", big); // one too many: a, used longest ago, goes
    expect(cache.get("a", "v")).toBeUndefined();
    expect(cache.get("b", "v")).toBe(b);
    expect(cache.get("big", "v")).toBe(big);
  });

  it("writes nothing when touch finds the expiry already as late", async () => {
    const memory = new MemoryDocumentStore();
    let patches = 0;
    const store: DocumentStore = {
      put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c),
      patchMeta: (id, patch, c) => {
        patches++;
        return memory.patchMeta(id, patch, c);
      },
    };
    const files = createLargeFiles({ requireOwner: false, store, ttlMs: Number.POSITIVE_INFINITY });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    expect((await files.touch!(meta.id))?.expiresAt).toBe(meta.expiresAt);
    expect(patches).toBe(0);
  });
});

describe("storeRounds and compactToolTurns", () => {
  const log = Array.from({ length: 3_000 }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z ${i % 7 === 0 ? "ERROR payment failed" : "INFO ok"} request ${i} ${"x".repeat(40)}`).join("\n");

  it("stores the stand-ins of large results with storeRounds \"compact\", and compactToolTurns makes the same of full rounds", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 100 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log) });
    const script = () => fakeModel([
      calls([{ id: "c1", name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 300 } }, { id: "c2", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
      says("There are 429 errors (app.log L1)."),
    ]);
    const asked = { files, documentIds: [meta.id], messages: [{ role: "user" as const, text: "How many errors?" }] };
    const full = await askWithFiles({ ...asked, model: script() });
    const compact = await askWithFiles({ ...asked, model: script(), storeRounds: "compact" });
    const sizeOf = (value: unknown) => JSON.stringify(value).length;
    expect(sizeOf(compact.toolTurns)).toBeLessThan(sizeOf(full.toolTurns) / 10);
    const [read, search] = compact.toolTurns[0]!.calls;
    expect(read!.result).toMatchObject({ dropped: true, lines: full.toolTurns[0]!.calls[0]!.result.lines });
    expect(search!.result).toMatchObject({ dropped: true, total_matching_lines: 429, query: "ERROR" });
    // The same stand-ins from the full rounds; those are not changed.
    expect(compactToolTurns(full.toolTurns)).toEqual(compact.toolTurns);
    expect(full.toolTurns[0]!.calls[0]!.result.dropped).toBeUndefined();
    // A later question takes them as any stored round.
    const later = fakeModel([says("Still 429.")]);
    await askWithFiles({ files, documentIds: [meta.id], model: later, messages: [...asked.messages, ...compact.toolTurns, { role: "assistant", text: compact.text }, { role: "user", text: "And now?" }] });
    expect(JSON.stringify(later.requests[0]!.messages)).toContain("dropped from the conversation to make room");
    await expect(askWithFiles({ ...asked, model: script(), storeRounds: "small" as never })).rejects.toThrow('storeRounds must be "full" or "compact"');
  });
});

describe("dedupe", () => {
  it("gives back the document of the same owner and scope with the same file, and stores another for anyone else", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ requireOwner: false, store, now: time.now, ttlMs: 2 * HOUR });
      const chat = { owner: "u1", scope: ["u1", "c1"] };
      const bytes = utf8("id,amount\n1,10\n2,20\n");
      const first = await files.ingest({ name: "orders.csv", bytes, ...chat, dedupe: true, appData: { row: 1 } });
      time.advance(HOUR);
      const again = await files.ingest({ name: "orders (1).csv", bytes, ...chat, dedupe: true, appData: { row: 2 } });
      // The same document, its name and appData its own, its expiry counted again from now.
      expect(again.id, kind).toBe(first.id);
      expect(again.name, kind).toBe("orders.csv");
      expect(again.appData, kind).toEqual({ row: 1 });
      expect(again.expiresAt, kind).toBe(new Date(time.now().getTime() + 2 * HOUR).toISOString());
      expect((await files.list!(chat)).length, kind).toBe(1);
      // Another owner, another scope, other bytes, or no dedupe: another document.
      const ids = new Set([first.id]);
      ids.add((await files.ingest({ name: "orders.csv", bytes, owner: "u2", scope: ["u1", "c1"], dedupe: true })).id);
      ids.add((await files.ingest({ name: "orders.csv", bytes, owner: "u1", scope: ["u1", "c2"], dedupe: true })).id);
      ids.add((await files.ingest({ name: "orders.csv", bytes: utf8("id,amount\n1,11\n"), ...chat, dedupe: true })).id);
      ids.add((await files.ingest({ name: "orders.csv", bytes, ...chat })).id);
      expect(ids.size, kind).toBe(5);
    }
  });

  it("stores the file again when the text of the document found is gone", async () => {
    const time = clock();
    const [, store] = (await stores(time.now))[1]!;
    const files = createLargeFiles({ requireOwner: false, store, now: time.now });
    const bytes = utf8("alpha beta");
    const first = await files.ingest({ name: "a.txt", bytes, dedupe: true });
    await rm(path.join(directory!, `${first.id}.txt`));
    const again = await files.ingest({ name: "a.txt", bytes, dedupe: true });
    expect(again.id).not.toBe(first.id);
    expect((await files.tools([again]).execute("read_document", { document_id: again.id })).text ?? "").toContain("alpha");
  });

  it("never removes the document it found, even when the listener of ingest.finish throws", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const bytes = utf8("alpha beta");
    const first = await files.ingest({ name: "a.txt", bytes, dedupe: true });
    const failing = files.ingest({ name: "a.txt", bytes, dedupe: true, onEvent: (event) => { if (event.type === "ingest.finish") throw new Error("listener"); } });
    await expect(failing).rejects.toThrow("listener");
    expect(await files.getMeta(first.id)).toBeDefined();
  });

  it("is a TypeError with id, over a store without list, or when it is not a boolean", async () => {
    const memory = new MemoryDocumentStore();
    const bare: DocumentStore = { put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c) };
    await expect(createLargeFiles({ requireOwner: false, store: memory }).ingest({ name: "a.txt", bytes: utf8("a"), id: "upload-1", dedupe: true })).rejects.toThrow("dedupe and id cannot be given together");
    await expect(createLargeFiles({ requireOwner: false, store: bare }).ingest({ name: "a.txt", bytes: utf8("a"), dedupe: true })).rejects.toThrow("dedupe needs a store with list()");
    await expect(createLargeFiles({ requireOwner: false, store: memory }).ingest({ name: "a.txt", bytes: utf8("a"), dedupe: "yes" as never })).rejects.toThrow("dedupe must be true or false");
  });

  it("works for a file ingested from a path", async () => {
    const time = clock();
    const [, store] = (await stores(time.now))[1]!;
    const files = createLargeFiles({ requireOwner: false, store, now: time.now });
    const source = path.join(directory!, "upload.txt");
    await writeFile(source, "gamma delta");
    const first = await files.ingest({ name: "upload.txt", source: { path: source }, dedupe: true });
    const again = await files.ingest({ name: "upload.txt", source: { path: source }, dedupe: true });
    expect(again.id).toBe(first.id);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
