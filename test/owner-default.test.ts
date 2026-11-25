// Owner checks on by default (0.99.9): every call names its owner unless the library is made with
// requireOwner: false; a document stored without an owner reads as missing on every path, and stays
// in the store; sweep takes no owner; the way back and the way forward of the upgrade guide; and
// the mark of a document dedupe gave back, which the upload handlers read.
import { describe, expect, it } from "vitest";
import {
  askStream,
  askWithFiles,
  createLargeFiles,
  DocumentsNotFoundError,
  IngestError,
  MemoryDocumentStore,
  type DocumentContext,
  type DocumentMeta,
  type DocumentStore,
  type LargeFilesOptions,
  type MetaPatch,
  type StoredDocument,
} from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { fakeFetch } from "llm-large-files/testing";
import { REUSED_HERE, reusedHere } from "../src/ingest.js";
import { fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const OWNER_REQUIRED = "owner is required: requireOwner is on (the default). Pass the user's ID as owner, or create the library with requireOwner: false to allow calls without one.";
const question = (text: string) => [{ role: "user" as const, text }];
const base = { tokens: 0, bytes: 0 };
const HOUR = 60 * 60 * 1000;

/** A clock the test moves. */
const clock = (start = Date.parse("2026-11-25T08:00:00Z")) => {
  let at = start;
  return { now: () => new Date(at), advance: (ms: number) => (at += ms) };
};

/** A store over a memory store that keeps the name of every method called on it. */
function countingStore(inner: MemoryDocumentStore = new MemoryDocumentStore()): DocumentStore & { calls: string[] } {
  const calls: string[] = [];
  const count = <T>(name: string, run: () => Promise<T>) => {
    calls.push(name);
    return run();
  };
  return {
    calls,
    put: (document: StoredDocument, context?: DocumentContext) => count("put", () => inner.put(document, context)),
    get: (id: string, context?: DocumentContext) => count("get", () => inner.get(id, context)),
    getMeta: (id: string, context?: DocumentContext) => count("getMeta", () => inner.getMeta(id, context)),
    delete: (id: string, context?: DocumentContext) => count("delete", () => inner.delete(id, context)),
    sweep: (now?: Date, context?: DocumentContext) => count("sweep", () => inner.sweep(now, context)),
    putOriginal: (id: string, bytes: Uint8Array, context?: DocumentContext) => count("putOriginal", () => inner.putOriginal(id, bytes, context)),
    getOriginal: (id: string, context?: DocumentContext) => count("getOriginal", () => inner.getOriginal(id, context)),
    list: (context?: DocumentContext) => count("list", () => inner.list(context)),
    patchMeta: (id: string, patch: MetaPatch, context?: DocumentContext) => count("patchMeta", () => inner.patchMeta(id, patch, context)),
  };
}

/** What `work` threw or rejected with, or undefined. */
const caught = (work: () => unknown) => Promise.resolve().then(work).then(() => undefined, (error: unknown) => error);

describe("owner checks by default", () => {
  it("checks owners unless the library is made with requireOwner: false", () => {
    const store = new MemoryDocumentStore();
    const on = { requireOwner: true, requireScope: false };
    expect(createLargeFiles({ store }).access).toEqual(on);
    expect(createLargeFiles({ store, requireOwner: undefined }).access).toEqual(on);
    expect(createLargeFiles({ store, requireOwner: true }).access).toEqual(on);
    expect(createLargeFiles({ store, requireOwner: false }).access).toEqual({ requireOwner: false, requireScope: false });
    // From JavaScript (an environment file gives "false"): only false turns the checks off.
    for (const given of [0, "false", null, "", "no"]) {
      expect(createLargeFiles({ store, requireOwner: given } as unknown as LargeFilesOptions).access, String(given)).toEqual(on);
    }
    // requireScope stays off unless asked for.
    expect(createLargeFiles({ store, requireScope: true }).access).toEqual({ requireOwner: true, requireScope: true });
  });

  it("refuses a call without an owner on every path, before the store, with a message that says how to turn the checks off", async () => {
    const memory = new MemoryDocumentStore();
    const meta = await createLargeFiles({ store: memory, keepOriginals: ["text"] }).ingest({ name: "a.txt", bytes: utf8("a\n"), owner: "alice" });
    const store = countingStore(memory);
    const files = createLargeFiles({ store, keepOriginals: ["text"] });
    const model = fakeModel([says("Hello.")]);
    const { fetch, sent } = fakeFetch([Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Hi." }] } }] })]);
    const thrown: Record<string, unknown> = {
      ingest: await caught(() => files.ingest({ name: "b.txt", bytes: utf8("b\n") })),
      getMeta: await caught(() => files.getMeta(meta.id)),
      getOriginal: await caught(() => files.getOriginal(meta.id)),
      delete: await caught(() => files.delete(meta.id)),
      list: await caught(() => files.list()),
      touch: await caught(() => files.touch(meta.id)),
      update: await caught(() => files.update(meta.id, { appData: { rowId: "1" } })),
      prepare: await caught(() => files.prepare([meta.id], base)),
      tools: await caught(() => files.tools([])),
      toolsWithAccess: await caught(() => files.tools([], { access: {} })),
      toolsFor: await caught(() => files.toolsFor([meta.id], { access: {} })),
      askWithFiles: await caught(() => askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") })),
      askStream: await caught(() => askStream({ files, model, documentIds: [meta.id], messages: question("?") }).result),
      askGemini: await caught(() => askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "m" }), fetch, documentIds: [meta.id], messages: question("?") })),
    };
    for (const [name, error] of Object.entries(thrown)) expect(error, name).toEqual(new TypeError(OWNER_REQUIRED));
    expect(OWNER_REQUIRED).toContain("requireOwner: false");
    // The start of the message is that of 0.9.0 to 0.10.x, for code that looks for it.
    expect(OWNER_REQUIRED.startsWith("owner is required: requireOwner is on")).toBe(true);
    // Nothing reached the store, a model or the network.
    expect(store.calls).toEqual([]);
    expect(model.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // Upkeep takes no owner.
    expect(await files.sweep()).toBe(0);
    expect(store.calls).toEqual(["sweep"]);
    // With an owner, each works.
    expect(await files.getMeta(meta.id, { owner: "alice" })).toMatchObject({ id: meta.id, owner: "alice" });
    expect(await files.list({ owner: "alice" })).toHaveLength(1);
  });

  it("reads a document stored without an owner as missing on every path, and leaves it in the store", async () => {
    const memory = new MemoryDocumentStore();
    const legacy = createLargeFiles({ store: memory, keepOriginals: ["text"], requireOwner: false, budget: { inlineTokens: 10 } });
    const log = utf8(serviceLog(300));
    const unowned = await legacy.ingest({ name: "app.log", bytes: log });
    const named = await legacy.ingest({ name: "report.txt", bytes: utf8("The total is 7.\n"), id: "report-1" });
    const before = { unowned: await memory.getMeta(unowned.id), named: await memory.getMeta(named.id) };
    const store = countingStore(memory);
    const files = createLargeFiles({ store, keepOriginals: ["text"], budget: { inlineTokens: 10 } });
    const alice = { owner: "alice" };
    for (const meta of [unowned, named]) {
      expect(await files.getMeta(meta.id, alice), meta.id).toBeUndefined();
      expect(await files.getOriginal(meta.id, alice), meta.id).toBeUndefined();
      expect(await files.delete(meta.id, alice), meta.id).toBe(false);
      expect((await files.prepare([meta.id], base, alice)).missing, meta.id).toEqual([meta.id]);
      expect((await files.toolsFor([meta.id], { access: alice })).missing, meta.id).toEqual([meta.id]);
      const read = await files.tools([meta], { access: alice }).execute("read_document", { document_id: meta.id, start_line: 1 });
      expect(read.error, meta.id).toMatch(/no longer available/);
      expect(await files.touch(meta.id, alice), meta.id).toBeUndefined();
      expect(await files.update(meta.id, { appData: { rowId: "1" } }, alice), meta.id).toBeUndefined();
    }
    expect(await files.list(alice)).toEqual([]);
    // A question: missing, before any model request ("throw", the default), or dropped.
    const model = fakeModel([says("Nothing to read.")]);
    await expect(askWithFiles({ files, model, documentIds: [unowned.id], messages: question("?"), ...alice })).rejects.toBeInstanceOf(DocumentsNotFoundError);
    await expect(askStream({ files, model, documentIds: [named.id], messages: question("?"), ...alice }).result).rejects.toBeInstanceOf(DocumentsNotFoundError);
    const { fetch, sent } = fakeFetch([Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Hi." }] } }] })]);
    await expect(askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "m" }), fetch, documentIds: [unowned.id], messages: question("?"), ...alice })).rejects.toBeInstanceOf(DocumentsNotFoundError);
    expect(model.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const dropped = await askWithFiles({ files, model, documentIds: [unowned.id], onMissingDocuments: "drop", messages: question("?"), ...alice });
    expect(dropped.text).toBe("Nothing to read.");
    expect(JSON.stringify(model.requests[0])).not.toContain("app.log");
    // Its application's ID is not taken over, even with "replace"; dedupe never gives it back.
    const replaced = await caught(() => files.ingest({ name: "report.txt", bytes: utf8("The total is 9.\n"), id: "report-1", ifExists: "replace", ...alice }));
    expect(IngestError.is(replaced) && replaced.code).toBe("exists");
    const again = await files.ingest({ name: "app.log", bytes: log, dedupe: true, ...alice });
    expect(again.id).not.toBe(unowned.id);
    expect(again.owner).toBe("alice");
    // Nothing was deleted or changed: both are there as they were, with the same expiry.
    expect(store.calls).not.toContain("delete");
    expect(store.calls).not.toContain("patchMeta");
    expect(await memory.getMeta(unowned.id)).toEqual(before.unowned);
    expect(await memory.getMeta(named.id)).toEqual(before.named);
  });

  it("sweeps expired documents of every owner, those without one included, without an owner", async () => {
    const time = clock();
    const store = new MemoryDocumentStore({ now: time.now });
    const legacy = createLargeFiles({ store, now: time.now, ttlMs: HOUR, requireOwner: false });
    const files = createLargeFiles({ store, now: time.now, ttlMs: HOUR });
    await legacy.ingest({ name: "old.txt", bytes: utf8("old\n") });
    await files.ingest({ name: "mine.txt", bytes: utf8("mine\n"), owner: "alice" });
    expect(await files.sweep()).toBe(0);
    time.advance(2 * HOUR);
    expect(await files.sweep()).toBe(2);
    expect(await legacy.list()).toEqual([]);
  });

  it("gives them back to a library made with requireOwner: false, as 0.10 did", async () => {
    const store = new MemoryDocumentStore();
    const legacy = createLargeFiles({ store, requireOwner: false });
    const meta = await legacy.ingest({ name: "notes.txt", bytes: utf8("The meeting is on Tuesday.\n") });
    expect(await createLargeFiles({ store }).getMeta(meta.id, { owner: "alice" })).toBeUndefined();
    const open = createLargeFiles({ store, requireOwner: false });
    expect(await open.getMeta(meta.id)).toMatchObject({ id: meta.id, name: "notes.txt" });
    expect(await open.getMeta(meta.id, { owner: "alice" })).toMatchObject({ id: meta.id });
    expect((await open.prepare([meta.id], base)).missing).toEqual([]);
    expect(await open.list()).toHaveLength(1);
  });

  it("stores a document without an owner again with one, as the upgrade guide shows", async () => {
    const store = new MemoryDocumentStore();
    const scope = ["chat-1"];
    const before = createLargeFiles({ store, keepOriginals: ["text"], requireOwner: false });
    const old = await before.ingest({ name: "notes.txt", bytes: utf8("The meeting is on Tuesday.\n"), scope, appData: { rowId: "7" } });
    const report = await before.ingest({ name: "report.txt", bytes: utf8("The total is 7.\n"), scope, id: "report-1" });
    const ownerOf = (_id: string) => "alice";
    const moved = new Map<string, string>();
    const recordNewId = async (from: string, to: string) => void moved.set(from, to);

    // The guide's code: a second library with the checks off reads the old documents.
    const files = createLargeFiles({ store, keepOriginals: ["text"] });
    const legacy = createLargeFiles({ store, keepOriginals: ["text"], requireOwner: false });
    for (const old of await legacy.list({ scope })) {
      if (old.id === "report-1") continue; // under an application's ID: below
      const bytes = await legacy.getOriginal(old.id, { scope });
      if (!bytes) continue;
      const userId = ownerOf(old.id);
      const stored = await files.ingest({ name: old.name, mimeType: old.mimeType, bytes, owner: userId, scope, ...(old.appData ? { appData: old.appData } : {}) });
      await legacy.delete(old.id, { scope });
      await recordNewId(old.id, stored.id);
    }
    // Under an application's ID: delete the old one first, then ingest under the same ID.
    const bytes = (await legacy.getOriginal("report-1", { scope }))!;
    await legacy.delete("report-1", { scope });
    await files.ingest({ name: report.name, mimeType: report.mimeType, bytes, owner: "alice", scope, id: "report-1" });

    expect(await legacy.list({ scope })).toEqual([]);
    const listed = await files.list({ owner: "alice", scope });
    expect(listed.map((meta) => meta.id).sort()).toEqual([moved.get(old.id)!, "report-1"].sort());
    expect(listed.find((meta) => meta.id === moved.get(old.id))).toMatchObject({ name: "notes.txt", owner: "alice", appData: { rowId: "7" } });
    expect(moved.get(old.id)).not.toBe(old.id);
  });

  it("marks a document dedupe gave back, not a new one, without a field anyone sees", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store });
    const bytes = utf8("The meeting is on Tuesday.\n");
    const first = await files.ingest({ name: "notes.txt", bytes, owner: "alice", dedupe: true });
    const second = await files.ingest({ name: "copy.txt", bytes, owner: "alice", dedupe: true });
    expect(second.id).toBe(first.id);
    expect(reusedHere(first)).toBe(false);
    expect(reusedHere(second)).toBe(true);
    // A registered symbol, so that another copy of the package reads it.
    expect(REUSED_HERE).toBe(Symbol.for("llm-large-files.reused"));
    // Not enumerable: neither the keys, JSON, nor a copy has it.
    const stored = (await store.getMeta(first.id))!;
    expect(Object.keys(second)).toEqual(Object.keys(stored));
    expect(JSON.stringify(second)).toBe(JSON.stringify(stored));
    expect(reusedHere({ ...second })).toBe(false);
    expect(reusedHere(JSON.parse(JSON.stringify(second)) as DocumentMeta)).toBe(false);
    // Another owner gets a document of its own, not marked.
    const bobs = await files.ingest({ name: "notes.txt", bytes, owner: "bob", dedupe: true });
    expect(bobs.id).not.toBe(first.id);
    expect(reusedHere(bobs)).toBe(false);
  });
});
