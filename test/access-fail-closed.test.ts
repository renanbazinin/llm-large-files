// Access that fails closed (0.9.0): requireOwner and requireScope, the scope rule, an owner of null
// from a store, stores that drop or ignore the context, and the tools checking the owner and scope
// the store holds (S3).
import "./load-pdf-libraries.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  askStream,
  askWithFiles,
  createLargeFiles,
  DocumentScopeError,
  FileDocumentStore,
  MemoryDocumentStore,
  type DocumentContext,
  type DocumentMeta,
  type DocumentStore,
  type LargeFiles,
  type StoredDocument,
} from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { fakeFetch } from "llm-large-files/testing";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";
import { numberedPdf } from "./pdf-fixtures.js";

const OWNER_REQUIRED = "owner is required: requireOwner is on (the default). Pass the user's ID as owner, or create the library with requireOwner: false to allow calls without one.";
const SCOPE_REQUIRED = "scope is required: requireScope is on";
const question = (text: string) => [{ role: "user" as const, text }];
const base = { tokens: 0, bytes: 0 };
const log = (word: string, lines = 300) => Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:00Z INFO ${word} request ${i}`).join("\n");

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/**
 * Each path that reads or writes documents, called with `access` (an owner, a scope, both or
 * neither): what it throws, or undefined.
 */
async function eachPath(files: LargeFiles, id: string, access: { owner?: string; scope?: string[] }): Promise<Record<string, unknown>> {
  const model = fakeModel([says("Hello.")]);
  const caught = (work: () => unknown) => Promise.resolve().then(work).then(() => undefined, (error: unknown) => error);
  const { fetch } = fakeFetch([Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Hi." }] } }] })]);
  return {
    ingest: await caught(() => files.ingest({ name: "a.txt", bytes: utf8("a\n"), ...access })),
    getMeta: await caught(() => files.getMeta(id, access)),
    getOriginal: await caught(() => files.getOriginal(id, access)),
    prepare: await caught(() => files.prepare([id], base, access)),
    askWithFiles: await caught(() => askWithFiles({ files, model, documentIds: [id], messages: question("?"), ...access })),
    askStream: await caught(() => askStream({ files, model, documentIds: [id], messages: question("?"), ...access }).result),
    askGemini: await caught(() => askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "m" }), fetch, documentIds: [id], messages: question("?"), ...access })),
    tools: await caught(() => files.tools([]).declarations),
    delete: await caught(() => files.delete(id, access)),
  };
}

const PATHS = ["ingest", "getMeta", "getOriginal", "prepare", "askWithFiles", "askStream", "askGemini", "tools", "delete"];

describe("requireOwner and requireScope", () => {
  it("check owners by default, not scopes, and the library says which are on", () => {
    expect(createLargeFiles({ store: new MemoryDocumentStore() }).access).toEqual({ requireOwner: true, requireScope: false });
    expect(createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false }).access).toEqual({ requireOwner: false, requireScope: false });
    expect(createLargeFiles({ store: new MemoryDocumentStore(), requireScope: true }).access).toEqual({ requireOwner: true, requireScope: true });
    expect(Object.isFrozen(createLargeFiles({ store: new MemoryDocumentStore() }).access)).toBe(true);
  });

  it("refuse a call without an owner on every path", async () => {
    const store = new MemoryDocumentStore();
    const open = createLargeFiles({ requireOwner: false, store });
    const meta = await open.ingest({ name: "a.txt", bytes: utf8("a\n"), owner: "alice" });
    // The default: owners are required.
    const files = createLargeFiles({ store });
    const thrown = await eachPath(files, meta.id, {});
    expect(Object.keys(thrown)).toEqual(PATHS);
    for (const name of PATHS) expect(thrown[name], name).toEqual(new TypeError(OWNER_REQUIRED));
    // An owner the library refuses at ingest is refused here too, rather than taken for one.
    await expect(files.getMeta(meta.id, { owner: "" })).rejects.toThrow(/owner must be a string that is not empty/);
    // With an owner (and `access` for the tools), each works.
    const alice = await eachPath(files, meta.id, { owner: "alice" });
    for (const name of PATHS.filter((path) => path !== "tools")) expect(alice[name], name).toBeUndefined();
    expect(() => files.tools([meta], { access: { owner: "alice" } })).not.toThrow();
    expect(() => files.tools([meta], { access: {} })).toThrow(new TypeError(OWNER_REQUIRED));
  });

  it("refuse a call without a scope on every path, but not a sweep of every scope", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ requireOwner: false, store, requireScope: true });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("a\n"), scope: ["u1", "s1"] });
    const thrown = await eachPath(files, meta.id, { owner: "alice" });
    for (const name of PATHS) expect(thrown[name], name).toEqual(new TypeError(SCOPE_REQUIRED));
    const scoped = await eachPath(files, meta.id, { scope: ["u1", "s1"] });
    for (const name of PATHS.filter((path) => path !== "tools")) expect(scoped[name], name).toBeUndefined();
    expect(() => files.tools([meta], { access: { scope: ["u1", "s1"] } })).not.toThrow();
    // Upkeep, not a user's access.
    expect(await files.sweep()).toBe(0);
    expect(await files.sweep({ scope: ["u1", "s1"] })).toBe(0);
  });

  it("read documents stored without an owner or a scope as missing", async () => {
    const store = new MemoryDocumentStore();
    const open = createLargeFiles({ requireOwner: false, store, keepOriginals: ["text"], budget: { inlineTokens: 10 } });
    const unowned = await open.ingest({ name: "app.log", bytes: utf8(log("alpha")) });
    const scopeless = await open.ingest({ name: "b.log", bytes: utf8(log("bravo")), owner: "alice" });
    for (const [rules, access, meta] of [
      [{}, { owner: "alice" }, unowned],
      [{ requireOwner: false, requireScope: true }, { scope: ["u1"] }, scopeless],
      [{ requireOwner: false, requireScope: true }, { owner: "alice", scope: ["u1"] }, scopeless],
    ] as const) {
      const files = createLargeFiles({ store, ...rules, budget: { inlineTokens: 10 } });
      expect(await files.getMeta(meta.id, access)).toBeUndefined();
      expect(await files.getOriginal(meta.id, access)).toBeUndefined();
      expect((await files.prepare([meta.id], base, access)).missing).toEqual([meta.id]);
      expect((await files.tools([meta], { access }).execute("read_document", { document_id: meta.id, start_line: 1 })).error).toMatch(/no longer available/);
      expect(await files.delete(meta.id, access)).toBe(false);
    }
    // Still there for a library that does not require them.
    expect(await open.getMeta(unowned.id)).toBeDefined();
    expect(await open.getMeta(scopeless.id, { owner: "alice" })).toBeDefined();
  });
});

describe("an owner of null from a store", () => {
  /** A store whose documents come back with `owner: null`, as a MongoDB driver writes one that was left out. */
  class NullOwners extends MemoryDocumentStore {
    override async put(document: StoredDocument, context?: DocumentContext): Promise<void> {
      return super.put({ ...document, meta: { ...document.meta, owner: document.meta.owner ?? null } as unknown as DocumentMeta }, context);
    }
  }

  it("is no owner: open to any caller, and the metadata leaves it out", async () => {
    const store = new NullOwners();
    const files = createLargeFiles({ requireOwner: false, store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")) });
    expect((await store.getMeta(meta.id))!.owner).toBeNull();
    const read = await files.getMeta(meta.id, { owner: "bob" });
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty("owner");
    expect((await files.prepare([meta.id], base)).missing).toEqual([]);
    // The tools agree with getMeta, with or without access: before 0.9.0 getMeta read it as missing
    // for every owner, and the tools as open.
    expect((await files.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 1, end_line: 1 })).lines).toBe("1-1");
    expect((await files.tools([read!], { access: { owner: "bob" } }).execute("read_document", { document_id: meta.id, start_line: 1, end_line: 1 })).lines).toBe("1-1");
  });

  it("is missing under requireOwner", async () => {
    const store = new NullOwners();
    await createLargeFiles({ requireOwner: false, store }).ingest({ name: "a.txt", bytes: utf8("a\n") });
    const [id] = [...(store as unknown as { documents: Map<string, unknown> }).documents.keys()];
    const files = createLargeFiles({ store, requireOwner: true });
    expect(await files.getMeta(id!, { owner: "alice" })).toBeUndefined();
    expect((await files.prepare([id!], base, { owner: "alice" })).missing).toEqual([id]);
  });
});

describe("the scope rule", () => {
  it("serves a document with a scope only to a caller of that scope, segment by segment", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    // A store that keeps scopes apart would not even find it in another scope: this one does (see
    // the next test), so the rule is the library's.
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("a\n"), scope: ["u1", "s1"] });
    expect(await files.getMeta(meta.id, { scope: ["u1", "s1"] })).toBeDefined();
    for (const scope of [undefined, ["u1"], ["u1", "s1", "x"], ["u1", "S1"], ["s1", "u1"]]) {
      expect(await files.getMeta(meta.id, scope ? { scope } : {}), String(scope)).toBeUndefined();
    }
  });

  it("keeps a scope-B caller from a scope-A document of a store that ignores the context", async () => {
    // A store written for 0.8: one map for every scope.
    class StoreOf08 implements DocumentStore {
      readonly documents = new Map<string, StoredDocument>();
      async put(document: StoredDocument) {
        this.documents.set(document.meta.id, structuredClone(document));
      }
      async get(id: string) {
        return structuredClone(this.documents.get(id));
      }
      async getMeta(id: string) {
        return structuredClone(this.documents.get(id)?.meta);
      }
      async delete(id: string) {
        return this.documents.delete(id);
      }
    }
    const files = createLargeFiles({ requireOwner: false, store: new StoreOf08(), budget: { inlineTokens: 10 } });
    const A = { owner: "u1", scope: ["u1", "s1"] };
    const B = { owner: "u1", scope: ["u1", "s2"] };
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), ...A });
    expect(await files.getMeta(meta.id, B)).toBeUndefined();
    expect((await files.prepare([meta.id], base, B)).missing).toEqual([meta.id]);
    expect(await files.getOriginal(meta.id, B)).toBeUndefined();
    expect(await files.delete(meta.id, B)).toBe(false);
    // Metadata handed in with scope A, for a caller of scope B.
    expect((await files.tools([meta], { access: B }).execute("search_document", { document_id: meta.id, query: "alpha", mode: "exact" })).error).toMatch(/no longer available/);
    const model = fakeModel([calls([{ id: "c1", name: "search_document", args: { document_id: meta.id, query: "alpha", mode: "exact" } }]), says("…")]);
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), ...B })).rejects.toMatchObject({ name: "DocumentsNotFoundError" });
    expect(model.requests).toHaveLength(0);
    // Scope A reads it.
    expect((await files.tools([meta], { access: A }).execute("search_document", { document_id: meta.id, query: "alpha", mode: "exact" })).total_matching_lines).toBe(300);
    // A document of no scope serves a caller of any scope, when the library does not require one.
    const open = await files.ingest({ name: "open.txt", bytes: utf8("open\n"), owner: "u1" });
    expect(await files.getMeta(open.id, B)).toBeDefined();
    expect(await createLargeFiles({ requireOwner: false, store: new StoreOf08(), requireScope: true }).getMeta(open.id, B)).toBeUndefined();
  });

  it("refuses a scope that is not valid with a DocumentScopeError, on every path", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("a\n") });
    for (const scope of [[], ["a/b"], [".."], ["x".repeat(257)], "u1"] as unknown as string[][]) {
      const thrown = await eachPath(files, meta.id, { scope });
      for (const name of PATHS.filter((path) => path !== "tools")) expect(DocumentScopeError.is(thrown[name]), `${name} ${JSON.stringify(scope)}`).toBe(true);
      expect(() => files.tools([meta], { access: { scope } })).toThrow(DocumentScopeError);
      await expect(files.sweep({ scope })).rejects.toBeInstanceOf(DocumentScopeError);
    }
  });
});

describe("a store that drops the context", () => {
  /** A wrapper written without the context: it forwards only the ID. */
  class ForwardsTheIdOnly implements DocumentStore {
    constructor(readonly inner: MemoryDocumentStore) {}
    put(document: StoredDocument) {
      return this.inner.put(document);
    }
    get(id: string) {
      return this.inner.get(id);
    }
    getMeta(id: string) {
      return this.inner.getMeta(id);
    }
    delete(id: string) {
      return this.inner.delete(id);
    }
  }

  it("fails closed: what it stored in a scope is never served to another, and what it cannot find is missing", async () => {
    const inner = new MemoryDocumentStore();
    // Written in scope A by a library over the store itself: the wrapper looks for it without a scope.
    const direct = createLargeFiles({ requireOwner: false, store: inner });
    const kept = await direct.ingest({ name: "a.txt", bytes: utf8("alpha\n"), scope: ["u1", "s1"] });
    const files = createLargeFiles({ requireOwner: false, store: new ForwardsTheIdOnly(inner) });
    expect(await files.getMeta(kept.id, { scope: ["u1", "s1"] })).toBeUndefined();
    expect((await files.prepare([kept.id], base, { scope: ["u1", "s1"] })).missing).toEqual([kept.id]);

    // Written through the wrapper: it lands among the documents of no scope, with its scope in the
    // metadata, which only scope A may use.
    const through = await files.ingest({ name: "b.txt", bytes: utf8("bravo\n"), scope: ["u1", "s1"] });
    expect(await inner.getMeta(through.id)).toBeDefined();
    expect(await files.getMeta(through.id, { scope: ["u1", "s2"] })).toBeUndefined();
    expect(await files.getMeta(through.id)).toBeUndefined();
    expect((await files.prepare([through.id], base, { scope: ["u1", "s1"] })).blocks.get(through.id)).toContain("bravo");
  });
});

describe("tools() and the owner the store holds (S3)", () => {
  it("checks access against the store, not against the metadata handed in", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-access-"));
    const files = createLargeFiles({ requireOwner: false, store: new FileDocumentStore(directory), keepOriginals: ["pdf"], budget: { inlineTokens: 10 } });
    const log8 = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), owner: "alice" });
    const report = await files.ingest({ name: "report.pdf", bytes: numberedPdf(2), owner: "alice" });
    // Metadata read from the store itself, owner and all, handed in for bob.
    const handed = [await new FileDocumentStore(directory).getMeta(log8.id), await new FileDocumentStore(directory).getMeta(report.id)] as DocumentMeta[];
    const bob = files.tools(handed, { access: { owner: "bob" }, viewPages: true });
    expect((await bob.execute("search_document", { document_id: log8.id, query: "alpha", mode: "exact" })).error).toMatch(/no longer available/);
    expect((await bob.execute("read_document", { document_id: report.id, start_line: 1 })).error).toMatch(/no longer available/);
    const look = await bob.executeWithFiles("view_pages", { document_id: report.id, from_page: 1 });
    expect(look.files).toEqual([]);
    expect(look.result.error).toMatch(/no longer available/);

    const alice = files.tools(handed, { access: { owner: "alice" }, viewPages: true });
    expect((await alice.execute("search_document", { document_id: log8.id, query: "alpha", mode: "exact" })).total_matching_lines).toBe(300);
    expect((await alice.executeWithFiles("view_pages", { document_id: report.id, from_page: 1 })).files).toHaveLength(1);

    // Without access, as in 0.8: the owner each document was handed in with.
    expect((await files.tools(handed).execute("search_document", { document_id: log8.id, query: "alpha", mode: "exact" })).total_matching_lines).toBe(300);
    const forged = files.tools([{ ...log8, owner: "bob" }]);
    expect((await forged.execute("search_document", { document_id: log8.id, query: "alpha", mode: "exact" })).error).toMatch(/no longer available/);
  });

  it("checks the scope the store holds against the scope of access, and without access against the handed one", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    // A store that keeps scopes apart: a caller of another scope does not find it at all. A
    // document of no scope is asked for with the handed scope, and refused for it.
    const open = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")) });
    const scoped = await files.ingest({ name: "b.log", bytes: utf8(log("bravo")), scope: ["u1", "s1"] });
    const search = (tools: ReturnType<LargeFiles["tools"]>, id: string) => tools.execute("search_document", { document_id: id, query: "request 3", mode: "exact" });
    expect((await search(files.tools([scoped], { access: { scope: ["u1", "s1"] } }), scoped.id)).total_matching_lines).toBe(11);
    expect((await search(files.tools([scoped], { access: { scope: ["u1", "s2"] } }), scoped.id)).error).toMatch(/no longer available/);
    expect((await search(files.tools([scoped], { access: {} }), scoped.id)).error).toMatch(/no longer available/);
    expect((await search(files.tools([scoped]), scoped.id)).total_matching_lines).toBe(11);
    expect((await search(files.tools([{ ...scoped, scope: ["u1", "s2"] }]), scoped.id)).error).toMatch(/no longer available/);
    expect((await search(files.tools([{ ...scoped, scope: ["../x"] }]), scoped.id)).error).toMatch(/no longer available/);
    // A store that keeps scopes apart does not find a document of no scope for a caller of one.
    expect((await search(files.tools([open], { access: { scope: ["u1", "s2"] } }), open.id)).error).toMatch(/no longer available/);
    expect((await search(files.tools([open], { access: {} }), open.id)).total_matching_lines).toBe(11);
  });
});
