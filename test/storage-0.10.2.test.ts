// Storage for an application's own panels (0.10.2): `files.list`, `files.touch` (expiry from the
// last use, H5), and the application's own data on a document (`appData`, `files.update`), over the
// memory and file stores, with `list` and `putMeta` on the store.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  FileDocumentStore,
  MAX_APP_DATA_BYTES,
  MemoryDocumentStore,
  toDocumentSummary,
  type DocumentStore,
} from "llm-large-files";
import { fakeModel, says, utf8 } from "./fake-model.js";

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
  it("lists the documents of a scope the caller may use, the oldest first, without expired ones", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ store, now: time.now, ttlMs: 2 * HOUR });
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
    const files = createLargeFiles({ store, now: time.now });
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
    await expect(createLargeFiles({ store: bare }).list!()).rejects.toThrow(TypeError);
    await expect(createLargeFiles({ store: memory, requireOwner: true }).list!()).rejects.toThrow("owner is required");
    await expect(createLargeFiles({ store: memory, requireScope: true }).list!({ owner: "u" })).rejects.toThrow("scope is required");
  });
});

describe("files.touch", () => {
  it("counts the expiry again from now, never earlier, and only for the caller who may use the document", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ store, now: time.now, ttlMs: 2 * HOUR });
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
      const shorter = createLargeFiles({ store, now: time.now, ttlMs: 60_000 });
      expect((await shorter.touch!(meta.id, access))?.expiresAt, kind).toBe(touched!.expiresAt);
      // Past its expiry, it is gone.
      time.advance(2 * HOUR);
      expect(await files.touch!(meta.id, access), kind).toBeUndefined();
    }
  });

  it("is a TypeError over a store without putMeta", async () => {
    const memory = new MemoryDocumentStore();
    const bare: DocumentStore = { put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c) };
    const files = createLargeFiles({ store: bare });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    await expect(files.touch!(meta.id)).rejects.toThrow("files.touch needs a store with putMeta()");
    await expect(files.update!(meta.id, { appData: { a: 1 } })).rejects.toThrow("files.update needs a store with putMeta()");
  });
});

describe("appData", () => {
  it("is kept from the ingest, changed and removed by update, and never sent to the model nor in a summary", async () => {
    const time = clock();
    for (const [kind, store] of await stores(time.now)) {
      const files = createLargeFiles({ store, now: time.now });
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
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
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

describe("FileDocumentStore.putMeta", () => {
  it("writes the metadata of a document that is there, and nothing for one that is gone", async () => {
    const time = clock();
    const [, store] = (await stores(time.now))[1]!;
    const files = createLargeFiles({ store, now: time.now });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha"), scope: ["u1", "c1"] });
    const context = { scope: ["u1", "c1"] };
    expect(await store.putMeta!({ ...meta, appData: { a: 1 } }, context)).toBe(true);
    expect((await store.getMeta(meta.id, context))?.appData).toEqual({ a: 1 });
    expect((await store.get(meta.id, context))?.text).toBe("alpha");
    await files.delete(meta.id, context);
    expect(await store.putMeta!(meta, context)).toBe(false);
    const folder = path.join(directory!, "u1", "c1", ".llm-large-files");
    expect((await readdir(folder)).filter((name) => name.startsWith(meta.id))).toEqual([]);
    // A scope whose folder is not there: false, and no folder is made.
    expect(await store.putMeta!(meta, { scope: ["u9", "c9"] })).toBe(false);
    expect(await readdir(directory!)).toEqual(["u1"]);
  });
});
