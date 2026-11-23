// Reads of documents once an application chooses their IDs (0.9.0), and another document can be
// stored under an ID: a document replaced on another server while it is read, whole, by range or
// its original file; copies kept in memory, which must not cross owners; and the context a store
// sees for the reads of a document's text. Two libraries over one store stand for two servers; a held
// store call stands for a slow one.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type DocumentContext, type DocumentMeta, type DocumentStore, type LargeFiles, type StoredDocument } from "llm-large-files";
import { utf8 } from "./fake-model.js";
import { HeldRangedMemoryStore, RangedStoreOf08, StoreOf08 } from "./held-store.js";
import { pdfWithPages, textLine } from "./pdf-fixtures.js";

const base = { tokens: 0, bytes: 0 };
const CLOCK = new Date("2026-03-01T10:00:00.000Z");
type Access = { owner?: string; scope?: string[] };

/** The text of a document as `prepare` gives it (whole, or its card), or undefined when it is missing. */
const textOf = async (files: LargeFiles, id: string, access: Access) => (await files.prepare([id], base, access)).blocks.get(id);

/** A log of `lines` lines, each naming `word`: two words of one length give two texts of one size. */
const log = (word: string, lines = 400) => Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO ${word} request ${String(i).padStart(4, "0")} done`).join("\n");

/** How many lines of document `id` hold `query`, for a caller of `access`. */
const matches = async (files: LargeFiles, access: Access, meta: DocumentMeta, query: string) =>
  (await files.tools([meta], { access }).execute("search_document", { document_id: meta.id, query, mode: "exact" })).total_matching_lines;

/**
 * A `MemoryDocumentStore` that also reads by range and keeps line indexes, each scope apart, and
 * notes every call with the context it was given.
 */
class RangedStore implements DocumentStore {
  readonly inner: MemoryDocumentStore;
  readonly calls: Array<{ method: string; context: DocumentContext | undefined }> = [];
  private readonly indexes = new Map<string, Uint8Array>();

  constructor(now?: () => Date) {
    this.inner = new MemoryDocumentStore(now ? { now } : {});
  }
  private note(method: string, context: DocumentContext | undefined) {
    this.calls.push({ method, context });
  }
  private where(id: string, context: DocumentContext | undefined) {
    return `${JSON.stringify(context?.scope ?? null)}|${id}`;
  }
  async put(document: StoredDocument, context?: DocumentContext) {
    this.note("put", context);
    return this.inner.put(document, context);
  }
  async get(id: string, context?: DocumentContext) {
    this.note("get", context);
    return this.inner.get(id, context);
  }
  async getMeta(id: string, context?: DocumentContext) {
    this.note("getMeta", context);
    return this.inner.getMeta(id, context);
  }
  async delete(id: string, context?: DocumentContext) {
    this.note("delete", context);
    this.indexes.delete(this.where(id, context));
    return this.inner.delete(id, context);
  }
  async readTextRange(id: string, start: number, end: number, context?: DocumentContext) {
    this.note("readTextRange", context);
    const document = await this.inner.get(id, context);
    return document && utf8(document.text).subarray(start, end);
  }
  async putIndex(id: string, index: Uint8Array, context?: DocumentContext) {
    this.note("putIndex", context);
    this.indexes.set(this.where(id, context), index.slice());
  }
  async getIndex(id: string, context?: DocumentContext) {
    this.note("getIndex", context);
    return this.indexes.get(this.where(id, context))?.slice();
  }
}

describe("a document read whole", () => {
  it("is missing when the store gives back another document than the one checked: replaced on another server meanwhile", async () => {
    const store = new StoreOf08();
    const one = createLargeFiles({ store });
    const two = createLargeFiles({ store });
    const alice = { owner: "alice", scope: ["alice", "s1"] };
    const bob = { owner: "bob", scope: ["bob", "s1"] };
    await one.ingest({ name: "report.txt", bytes: utf8("alice's report\n"), id: "report", ...alice });
    // Server one has checked alice's document, and waits for its text.
    const held = store.holds.hold("get");
    const reading = one.prepare(["report"], base, alice);
    await held.reached;
    // Server two: alice deletes it, and bob uploads a file under the same ID in his own chat.
    expect(await two.delete("report", alice)).toBe(true);
    await two.ingest({ name: "report.txt", bytes: utf8("bob's report\n"), id: "report", ...bob });
    held.release();
    const prepared = await reading;
    expect(prepared.missing).toEqual(["report"]);
    expect(JSON.stringify([...prepared.blocks.values()])).not.toContain("bob's");
    // Nothing of bob's was kept for alice, and bob reads his own.
    expect((await one.prepare(["report"], base, alice)).missing).toEqual(["report"]);
    expect(await textOf(one, "report", bob)).toContain("bob's report");
  });

  it("is missing when the store gives back the document of another scope: a wrapper that keeps what get gave by ID", async () => {
    /** Written for 0.8: it remembers `get` by ID alone. Its getMeta looks in the right scope. */
    class KeptById extends MemoryDocumentStore {
      readonly kept = new Map<string, StoredDocument | undefined>();
      override async get(id: string, context?: DocumentContext) {
        if (!this.kept.has(id)) this.kept.set(id, await super.get(id, context));
        return this.kept.get(id);
      }
      override async getMeta(id: string, context?: DocumentContext) {
        return (await super.get(id, context))?.meta;
      }
    }
    const files = createLargeFiles({ store: new KeptById() });
    await files.ingest({ name: "a.txt", bytes: utf8("alpha text\n"), id: "shared", scope: ["a"] });
    await files.ingest({ name: "b.txt", bytes: utf8("bravo text\n"), id: "shared", scope: ["b"] });
    expect(await textOf(files, "shared", { scope: ["a"] })).toContain("alpha text");
    const b = await files.prepare(["shared"], base, { scope: ["b"] });
    expect(b.missing).toEqual(["shared"]);
    expect(JSON.stringify([...b.blocks.values()])).not.toContain("alpha");
  });
});

describe("a document read by range", () => {
  const GONE = { error: "report is no longer available on the server. Ask the user to attach the file again." };

  for (const sameSize of [true, false]) {
    it(`is missing when another server put another document under the ID while it was read (a text of ${sameSize ? "the same" : "another"} size)`, async () => {
      const store = new RangedStoreOf08();
      const one = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 4_096 });
      const two = createLargeFiles({ store, wholeDocumentBytes: 0 });
      const alice = { owner: "alice", scope: ["alice", "s1"] };
      const bob = { owner: "bob", scope: ["bob", "s1"] };
      const meta = await one.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "report", ...alice });
      // Server one has checked alice's document, and waits for its index.
      const held = store.holds.hold("getIndex");
      const reading = one.tools([meta], { access: alice }).execute("read_document", { document_id: "report", start_line: 1, end_line: 3 });
      await held.reached;
      // Server two: alice deletes it, and bob uploads a file under the same ID in his own chat.
      await two.delete("report", alice);
      const second = await two.ingest({ name: "app.log", bytes: utf8(log(sameSize ? "bravo" : "bravo-bravo")), id: "report", ...bob });
      held.release();
      expect(await reading).toEqual(GONE);
      // Bob reads his own, on either server.
      const bobs = await one.tools([second], { access: bob }).execute("read_document", { document_id: "report", start_line: 1, end_line: 1 });
      expect(bobs.text).toContain("bravo");
    });
  }

  for (const servers of [2, 1]) {
    it(`is missing when another owner stored the ID in the same scope during a search of a kept copy (${servers === 2 ? "on another server" : "in the same library"})`, async () => {
      // A store that keeps scopes apart, as the contract asks: the two owners share one scope.
      const store = new HeldRangedMemoryStore();
      const one = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 4_096 });
      const other = servers === 2 ? createLargeFiles({ store, wholeDocumentBytes: 0 }) : one;
      const scope = ["org"];
      const x = { owner: "x", scope };
      const y = { owner: "y", scope };
      const meta = await one.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "report", ...x });
      const tools = one.tools([meta], { access: x });
      // Its index is kept: the search reads only the text.
      await tools.execute("read_document", { document_id: "report", start_line: 1, end_line: 2 });
      const held = store.holds.hold("readTextRange");
      const searching = tools.execute("search_document", { document_id: "report", query: "bravo", mode: "exact" });
      await held.reached;
      await other.delete("report", x);
      const second = await other.ingest({ name: "app.log", bytes: utf8(log("bravo")), id: "report", ...y });
      held.release();
      expect(await searching).toEqual(GONE);
      expect(await matches(one, y, second, "bravo")).toBe(400);
      expect(await matches(one, y, second, "alpha")).toBe(0);
    });
  }

  it("is missing from prepare when another server put another document under the ID while its text was read", async () => {
    const store = new RangedStoreOf08();
    const one = createLargeFiles({ store, wholeDocumentBytes: 0 });
    const two = createLargeFiles({ store, wholeDocumentBytes: 0 });
    const alice = { owner: "alice", scope: ["alice", "s1"] };
    const bob = { owner: "bob", scope: ["bob", "s1"] };
    await one.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "report", ...alice });
    const held = store.holds.hold("readTextRange");
    const preparing = one.prepare(["report"], base, alice);
    await held.reached;
    await two.delete("report", alice);
    await two.ingest({ name: "app.log", bytes: utf8(log("bravo")), id: "report", ...bob });
    held.release();
    const prepared = await preparing;
    expect(prepared.missing).toEqual(["report"]);
    expect(JSON.stringify([...prepared.blocks.values()])).not.toContain("bravo");
    expect(await textOf(one, "report", bob)).toContain("bravo");
  });

  for (const kind of ["two servers", "one library, one scope"] as const) {
    it(`is checked also when the call fails, whose error may quote what it read (${kind})`, async () => {
      // aggregate_table names the columns it read when asked for one that is not there.
      const csv = (header: string) => [header, ...Array.from({ length: 300 }, (_, i) => `${i},${i * 2},${i * 3}`)].join("\n");
      const store = kind === "two servers" ? new RangedStoreOf08() : new HeldRangedMemoryStore();
      const one = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 4_096 });
      const two = kind === "two servers" ? createLargeFiles({ store, wholeDocumentBytes: 0 }) : one;
      const alice = kind === "two servers" ? { owner: "alice", scope: ["alice", "s1"] } : { owner: "x", scope: ["org"] };
      const bob = kind === "two servers" ? { owner: "bob", scope: ["bob", "s1"] } : { owner: "y", scope: ["org"] };
      const meta = await one.ingest({ name: "t.csv", bytes: utf8(csv("ida,colb,colc")), id: "report", ...alice });
      const tools = one.tools([meta], { access: alice });
      await tools.execute("read_document", { document_id: "report", start_line: 1, end_line: 2 });
      const held = store.holds.hold("readTextRange");
      const call = tools.execute("aggregate_table", { document_id: "report", metrics: ["sum:nonexistent"] });
      await held.reached;
      await two.delete("report", alice);
      // The same layout, so the index kept for alice's copy still matches the text.
      await two.ingest({ name: "t.csv", bytes: utf8(csv("sal,ssnx,bonu")), id: "report", ...bob });
      held.release();
      const result = await call;
      expect(JSON.stringify(result)).not.toContain("ssnx");
      expect(result.error).toMatch(/report is no longer available/);
    });
  }

  it("asks the store once more after a call, however many ranges the call read", async () => {
    const store = new RangedStore();
    const files = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 4_096 });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "report" });
    const tools = files.tools([meta], { access: {} });
    store.calls.length = 0;
    // A scan of every piece, then the lines of the best passages.
    const found = await tools.execute("search_document", { document_id: "report", query: "alpha request", max_results: 5 });
    expect(found.error).toBeUndefined();
    expect(store.calls.filter((call) => call.method === "readTextRange").length).toBeGreaterThan(5);
    expect(store.calls.filter((call) => call.method === "getMeta")).toHaveLength(2);
  });
});

describe("the original file", () => {
  it("is missing when another server put another document under the ID while it was read", async () => {
    const store = new StoreOf08();
    // One clock, and files of one size: only the owner and the scope tell the two documents apart.
    const one = createLargeFiles({ store, keepOriginals: ["text"], now: () => CLOCK });
    const two = createLargeFiles({ store, keepOriginals: ["text"], now: () => CLOCK });
    const alice = { owner: "alice", scope: ["alice", "s1"] };
    const bob = { owner: "bob", scope: ["bob", "s1"] };
    await one.ingest({ name: "report.txt", bytes: utf8("alice's report\n"), id: "report", ...alice });
    const held = store.holds.hold("getOriginal");
    const reading = one.getOriginal("report", alice);
    await held.reached;
    await two.delete("report", alice);
    await two.ingest({ name: "report.txt", bytes: utf8("bobby's report\n"), id: "report", ...bob });
    held.release();
    expect(await reading).toBeUndefined();
    expect(await one.getOriginal("report", bob)).toEqual(utf8("bobby's report\n"));
  });

  it("shows no pages of another document put under the ID while view_pages read it", async () => {
    const store = new StoreOf08();
    const one = createLargeFiles({ store, keepOriginals: ["pdf"], now: () => CLOCK });
    const two = createLargeFiles({ store, keepOriginals: ["pdf"], now: () => CLOCK });
    const alice = { owner: "alice", scope: ["alice", "s1"] };
    const bob = { owner: "bob", scope: ["bob", "s1"] };
    const meta = await one.ingest({ name: "report.pdf", bytes: pdfWithPages([textLine("alice page one")]), id: "report", ...alice });
    const held = store.holds.hold("getOriginal");
    const looking = one.tools([meta], { access: alice, viewPages: true }).executeWithFiles("view_pages", { document_id: "report", from_page: 1 });
    await held.reached;
    await two.delete("report", alice);
    await two.ingest({ name: "report.pdf", bytes: pdfWithPages([textLine("bob's page one")]), id: "report", ...bob });
    held.release();
    const output = await looking;
    expect(output.files).toEqual([]);
    expect(JSON.stringify(output.result)).toContain("is no longer on the server");
  });

  it("is missing when the bytes the store gives are not the size of the file that was ingested", async () => {
    class Cut extends MemoryDocumentStore {
      override async getOriginal(id: string, context?: DocumentContext) {
        return (await super.getOriginal(id, context))?.subarray(0, 4);
      }
    }
    const files = createLargeFiles({ store: new Cut(), keepOriginals: ["text"] });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("a whole file\n") });
    expect(await files.getOriginal(meta.id)).toBeUndefined();
  });
});

describe("copies kept in memory, once IDs are reused", () => {
  it("are not served to another owner of the same ID, scope, clock and size: a store that keeps owners apart", async () => {
    /** Keeps one document per owner and ID: more than the contract allows, which is at most one per ID in a scope. */
    class ByOwner implements DocumentStore {
      readonly documents = new Map<string, StoredDocument>();
      private key = (id: string, context?: DocumentContext) => `${context?.owner ?? ""}|${id}`;
      async put(document: StoredDocument, context?: DocumentContext) {
        this.documents.set(this.key(document.meta.id, context), structuredClone(document));
      }
      async get(id: string, context?: DocumentContext) {
        return structuredClone(this.documents.get(this.key(id, context)));
      }
      async getMeta(id: string, context?: DocumentContext) {
        return structuredClone(this.documents.get(this.key(id, context))?.meta);
      }
      async delete(id: string, context?: DocumentContext) {
        return this.documents.delete(this.key(id, context));
      }
    }
    const files = createLargeFiles({ store: new ByOwner(), now: () => CLOCK });
    const scope = ["org"];
    await files.ingest({ name: "r.txt", bytes: utf8("x's text\n"), id: "report", owner: "x", scope });
    await files.ingest({ name: "r.txt", bytes: utf8("y's text\n"), id: "report", owner: "y", scope });
    for (let round = 0; round < 2; round++) {
      expect(await textOf(files, "report", { owner: "x", scope })).toContain("x's text");
      expect(await textOf(files, "report", { owner: "y", scope })).toContain("y's text");
    }
  });

  for (const ranged of [false, true]) {
    it(`are not served after another server deleted the document and another owner stored the ID at the same instant (${ranged ? "read by range" : "loaded whole"})`, async () => {
      const store = ranged ? new RangedStore(() => CLOCK) : new MemoryDocumentStore({ now: () => CLOCK });
      const options = { store, now: () => CLOCK, ...(ranged ? { wholeDocumentBytes: 0, scanChunkBytes: 4_096 } : {}) };
      const one = createLargeFiles(options);
      const two = createLargeFiles(options);
      const scope = ["org"];
      const x = { owner: "x", scope };
      const y = { owner: "y", scope };
      const first = await one.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "report", ...x });
      // Twice, so that the second is served from what the first kept, its pieces included.
      expect(await matches(one, x, first, "alpha")).toBe(400);
      expect(await matches(one, x, first, "alpha")).toBe(400);
      expect(await two.delete("report", x)).toBe(true);
      const second = await two.ingest({ name: "app.log", bytes: utf8(log("bravo")), id: "report", ...y });
      expect([second.createdAt, second.textBytes, second.characters, second.lines]).toEqual([first.createdAt, first.textBytes, first.characters, first.lines]);
      expect(await matches(one, y, second, "bravo")).toBe(400);
      expect(await matches(one, y, second, "alpha")).toBe(0);
    });
  }
});

describe("the context of the reads of a document's text", () => {
  it("is the document's own, whoever's call opened the copy that is shared", async () => {
    const store = new RangedStore();
    const files = createLargeFiles({ store, wholeDocumentBytes: 0, scanChunkBytes: 4_096 });
    const scope = ["org"];
    // A document of the scope, of no owner: every owner of the scope may use it.
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "shared-log", scope });
    store.calls.length = 0;
    const read = (owner: string, line: number) => files.tools([meta], { access: { owner, scope } }).execute("read_document", { document_id: "shared-log", start_line: line, end_line: line + 1 });
    expect((await read("x", 1)).lines).toBe("1-2");
    expect((await read("y", 300)).lines).toBe("300-301");
    // The look-ups are the caller's: before each call, and once more after its reads by range. The
    // reads of the text, its index and its rebuilt index are the document's: the same for every
    // caller of the copy, and where the document lives.
    expect(store.calls.filter((call) => call.method === "getMeta").map((call) => call.context)).toEqual([{ scope, owner: "x" }, { scope, owner: "x" }, { scope, owner: "y" }, { scope, owner: "y" }]);
    const reads = store.calls.filter((call) => call.method !== "getMeta");
    expect(new Set(reads.map((call) => call.method))).toEqual(new Set(["getIndex", "readTextRange"]));
    for (const call of reads) expect(call.context, call.method).toEqual({ scope });

    // The same for a document loaded whole, which `get` reads.
    const whole = createLargeFiles({ store });
    store.calls.length = 0;
    expect(await textOf(whole, "shared-log", { owner: "x", scope })).toContain("alpha request 0000");
    expect(store.calls.map((call) => [call.method, call.context])).toEqual([["getMeta", { scope, owner: "x" }], ["get", { scope }]]);
  });

  for (const ranged of [false, true]) {
    it(`is the caller's scope for a document whose metadata has none, found in that scope (${ranged ? "read by range" : "loaded whole"})`, async () => {
      const store = ranged ? new RangedStore() : new MemoryDocumentStore();
      const files = createLargeFiles({ store, ...(ranged ? { wholeDocumentBytes: 0 } : {}) });
      // Ingested without a scope, as in 0.8, then moved into scope ["a"] by the application.
      const meta = await files.ingest({ name: "old.txt", bytes: utf8("an old document\n") });
      await store.put((await store.get(meta.id))!, { scope: ["a"] });
      await store.delete(meta.id);
      if (store instanceof RangedStore) store.calls.length = 0;
      expect((await files.getMeta(meta.id, { scope: ["a"] }))?.name).toBe("old.txt");
      expect(await textOf(files, meta.id, { scope: ["a"] })).toContain("an old document");
      if (store instanceof RangedStore) {
        // Its index, rebuilt from its text, and its text: all read where it was found.
        const reads = store.calls.filter((call) => call.method !== "getMeta");
        expect(new Set(reads.map((call) => call.method))).toEqual(new Set(["getIndex", "readTextRange", "putIndex"]));
        for (const call of reads) expect(call.context, call.method).toEqual({ scope: ["a"] });
      }
    });
  }

  it("puts the index of a rebuild with the document's context", async () => {
    class NoSavedIndex extends RangedStore {
      override async getIndex() {
        return undefined;
      }
    }
    const store = new NoSavedIndex();
    const files = createLargeFiles({ store, wholeDocumentBytes: 0 });
    const scope = ["org"];
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "shared-log", scope });
    store.calls.length = 0;
    await files.tools([meta], { access: { owner: "x", scope } }).execute("read_document", { document_id: "shared-log", start_line: 1, end_line: 1 });
    expect(store.calls.filter((call) => call.method === "putIndex").map((call) => call.context)).toEqual([{ scope }]);
  });
});
