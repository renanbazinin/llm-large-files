// The store context (0.9.0): every store call the library makes carries the scope and the owner it
// was made for, and one ID in two scopes is two documents everywhere, the memory of the library
// included.
import "./load-pdf-libraries.js";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  MemoryDocumentStore,
  type DocumentContext,
  type DocumentMeta,
  type DocumentScope,
  type DocumentStore,
  type StoredDocument,
  toDocumentSummary as toSummary,
} from "llm-large-files";
import { scopeKey } from "../src/scope.js";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";
import { pdfWithPages, textLine } from "./pdf-fixtures.js";

type Method = keyof DocumentStore;

/**
 * A MemoryDocumentStore that can also read by range and keep line indexes, each scope apart, and
 * notes every call with the context it was given.
 */
class RecordingStore implements DocumentStore {
  readonly inner: MemoryDocumentStore;
  readonly calls: Array<{ method: Method; id?: string; context: DocumentContext | undefined }> = [];
  private readonly indexes = new Map<string, Uint8Array>();

  constructor(now?: () => Date) {
    this.inner = new MemoryDocumentStore(now ? { now } : {});
  }

  private note(method: Method, id: string | undefined, context: DocumentContext | undefined): void {
    this.calls.push({ method, ...(id !== undefined ? { id } : {}), context });
  }

  async put(document: StoredDocument, context?: DocumentContext) {
    this.note("put", document.meta.id, context);
    return this.inner.put(document, context);
  }
  async get(id: string, context?: DocumentContext) {
    this.note("get", id, context);
    return this.inner.get(id, context);
  }
  async getMeta(id: string, context?: DocumentContext) {
    this.note("getMeta", id, context);
    return this.inner.getMeta(id, context);
  }
  async delete(id: string, context?: DocumentContext) {
    this.note("delete", id, context);
    this.indexes.delete(`${scopeKey(context?.scope)}|${id}`);
    return this.inner.delete(id, context);
  }
  async sweep(now?: Date, context?: DocumentContext) {
    this.note("sweep", undefined, context);
    return this.inner.sweep(now, context);
  }
  async putOriginal(id: string, bytes: Uint8Array, context?: DocumentContext) {
    this.note("putOriginal", id, context);
    return this.inner.putOriginal(id, bytes, context);
  }
  async getOriginal(id: string, context?: DocumentContext) {
    this.note("getOriginal", id, context);
    return this.inner.getOriginal(id, context);
  }
  async readTextRange(id: string, start: number, end: number, context?: DocumentContext) {
    this.note("readTextRange", id, context);
    const document = await this.inner.get(id, context);
    return document && utf8(document.text).subarray(start, end);
  }
  async putIndex(id: string, index: Uint8Array, context?: DocumentContext) {
    this.note("putIndex", id, context);
    this.indexes.set(`${scopeKey(context?.scope)}|${id}`, index.slice());
  }
  async getIndex(id: string, context?: DocumentContext) {
    this.note("getIndex", id, context);
    return this.indexes.get(`${scopeKey(context?.scope)}|${id}`)?.slice();
  }
}

const ALL_METHODS: Method[] = ["put", "get", "getMeta", "delete", "sweep", "putOriginal", "getOriginal", "readTextRange", "putIndex", "getIndex"];

/** A log of `lines` lines, each naming `word`: two words of one length give two texts of one size. */
const log = (word: string, lines = 400) => Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO ${word} request ${String(i).padStart(4, "0")} done`).join("\n");

const question = (text: string) => [{ role: "user" as const, text }];
const search = (id: string, query: string) => ({ id: "c1", name: "search_document", args: { document_id: id, query, mode: "exact" } });
const CLOCK = new Date("2026-03-01T10:00:00.000Z");

describe("the context of every store call", () => {
  it("reaches every method of the store, with the scope and the owner, through every path", async () => {
    const store = new RecordingStore();
    // Read by range (wholeDocumentBytes 0), so that tool calls read ranges and the index; the text
    // file is kept, so that getOriginal has something to give.
    const files = createLargeFiles({ store, keepOriginals: ["log"], wholeDocumentBytes: 0, budget: { inlineTokens: 10 } });
    const scope: DocumentScope = ["u1", "chat-7"];
    const owner = "u1";
    const who = { scope, owner };

    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), scope, owner });
    expect(meta.scope).toEqual(["u1", "chat-7"]);
    const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 }, who);
    expect(prepared.missing).toEqual([]);
    const model = fakeModel([calls([search(meta.id, "alpha request 0007")]), says("It is there.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("Is 7 there?"), owner, scope });
    const tools = files.tools(prepared.plan.searchable, { access: who });
    expect((await tools.execute("read_document", { document_id: meta.id, start_line: 3, end_line: 4 })).lines).toBe("3-4");
    // A library over the same store that loads documents whole: `get`.
    const whole = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    expect((await whole.prepare([meta.id], { tokens: 0, bytes: 0 }, who)).blocks.get(meta.id)).toContain("alpha request 0000");
    expect(await files.getOriginal(meta.id, who)).toEqual(utf8(log("alpha")));
    expect(await files.delete(meta.id, who)).toBe(true);
    expect(await files.sweep({ scope })).toBe(0);

    expect(new Set(store.calls.map((call) => call.method))).toEqual(new Set(ALL_METHODS));
    for (const call of store.calls) {
      // Sweeping is upkeep of a scope: it has no owner.
      expect(call.context, call.method).toEqual(call.method === "sweep" ? { scope } : { scope, owner });
      expect(Object.isFrozen(call.context), call.method).toBe(true);
    }
    // The scope the store is given is a copy, which the caller cannot change afterwards.
    expect(store.calls[0]!.context!.scope).not.toBe(scope);
  });

  it("passes a context without a scope or an owner too: an empty one", async () => {
    const store = new RecordingStore();
    const files = createLargeFiles({ store, wholeDocumentBytes: 0, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")) });
    await files.prepare([meta.id], { tokens: 0, bytes: 0 });
    await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "alpha", mode: "exact" });
    await files.delete(meta.id);
    await files.sweep();
    expect(store.calls.length).toBeGreaterThan(5);
    for (const call of store.calls) {
      expect(call.context, call.method).toEqual({});
      expect(Object.isFrozen(call.context)).toBe(true);
    }
    // Neither field is there, not even as undefined.
    expect(Object.keys(store.calls[0]!.context!)).toEqual([]);
  });

  it("asks the store with the context of the handed metadata, for tools without access", async () => {
    const store = new RecordingStore();
    const files = createLargeFiles({ store, wholeDocumentBytes: 0, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), scope: ["u1", "s1"], owner: "u1" });
    store.calls.length = 0;
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "alpha request 0003", mode: "exact" });
    expect(result.total_matching_lines).toBe(1);
    expect(store.calls.length).toBeGreaterThan(0);
    for (const call of store.calls) expect(call.context).toEqual({ scope: ["u1", "s1"], owner: "u1" });
  });
});

describe("the scope and the owner of a document", () => {
  it("are kept as a copy, and never reach a summary, an event, the cards or the model", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const scope = ["secret-user", "secret-chat"];
    const owner = "secret-owner";
    const events: unknown[] = [];
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), scope, owner, onEvent: (event) => events.push(event) });
    scope[1] = "changed";
    expect(meta.scope).toEqual(["secret-user", "secret-chat"]);
    expect((await files.getMeta(meta.id, { owner, scope: ["secret-user", "secret-chat"] }))?.scope).toEqual(["secret-user", "secret-chat"]);
    const who = { owner, scope: ["secret-user", "secret-chat"] };

    const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 }, who);
    const model = fakeModel([calls([search(meta.id, "alpha request 0001")]), says("Found.")]);
    const asked: unknown[] = [];
    // (With `eventResults: true`, the result in run.finish holds the full metadata, as it always did.)
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("Line 1?"), ...who, onEvent: (event) => asked.push(event) });
    const seen = JSON.stringify([toSummary(meta), events, prepared.instruction, [...prepared.blocks.values()], model.requests, asked, result.toolTurns, result.evidence, result.steps]);
    expect(seen).toContain("alpha request 0001");
    expect(seen).not.toContain("secret-");
  });
});

describe("one ID in two scopes", () => {
  // Same owner, same name, same clock, texts of the same size: only the scope tells them apart, as
  // two chats of one user that each uploaded a file under the upload's ID.
  const A: DocumentScope = ["u1", "s1"];
  const B: DocumentScope = ["u1", "s2"];
  const owner = "u1";

  async function twoChats(options: { ranged: boolean }) {
    const store = options.ranged ? new RecordingStore(() => CLOCK) : new MemoryDocumentStore({ now: () => CLOCK });
    const files = createLargeFiles({
      store,
      now: () => CLOCK,
      budget: { inlineTokens: 10 },
      ...(options.ranged ? { wholeDocumentBytes: 0, scanChunkBytes: 4_096 } : {}),
    });
    const a = await files.ingest({ name: "app.log", bytes: utf8(log("alpha")), id: "upload-1", scope: A, owner });
    const b = await files.ingest({ name: "app.log", bytes: utf8(log("bravo")), id: "upload-1", scope: B, owner });
    return { store, files, a, b };
  }

  const found = async (files: ReturnType<typeof createLargeFiles>, scope: DocumentScope, meta: DocumentMeta, query: string) => {
    const result = await files.tools([meta], { access: { owner, scope } }).execute("search_document", { document_id: "upload-1", query, mode: "exact" });
    return result.total_matching_lines;
  };

  for (const ranged of [false, true]) {
    it(`each reads its own text, and neither the memory nor the pieces cross (${ranged ? "read by range" : "loaded whole"})`, async () => {
      const { files, a, b } = await twoChats({ ranged });
      // The same version: only the scope keeps the two apart in memory.
      expect([a.createdAt, a.textBytes, a.characters, a.lines]).toEqual([b.createdAt, b.textBytes, b.characters, b.lines]);
      expect((await files.getMeta("upload-1", { owner, scope: A }))?.scope).toEqual(A);
      expect((await files.getMeta("upload-1", { owner, scope: B }))?.scope).toEqual(B);

      // Twice each, so that the second search is served from what the first kept.
      for (let round = 0; round < 2; round++) {
        expect(await found(files, A, a, "alpha")).toBe(400);
        expect(await found(files, A, a, "bravo")).toBe(0);
        expect(await found(files, B, b, "bravo")).toBe(400);
        expect(await found(files, B, b, "alpha")).toBe(0);
      }
      const cardOf = async (scope: DocumentScope) => (await files.prepare(["upload-1"], { tokens: 0, bytes: 0 }, { owner, scope })).blocks.get("upload-1")!;
      expect(await cardOf(A)).toContain("alpha request 0000");
      expect(await cardOf(A)).not.toContain("bravo");
      expect(await cardOf(B)).toContain("bravo request 0000");
      expect(await cardOf(B)).not.toContain("alpha");

      // A question in each chat: the tool results it is sent are of its own file.
      for (const [scope, own, other] of [[A, "alpha", "bravo"], [B, "bravo", "alpha"]] as const) {
        const model = fakeModel([calls([search("upload-1", "request 0042")]), says("Done.")]);
        await askWithFiles({ files, model, documentIds: ["upload-1"], messages: question("Line 42?"), owner, scope });
        const sent = JSON.stringify(model.requests.at(-1)!.messages);
        expect(sent).toContain(`${own} request 0042`);
        expect(sent).not.toContain(other);
      }

      // Deleted and ingested again in chat A, under the same ID, at the same instant and with a
      // text of the same size: chat A reads the new text, never the one kept from before.
      expect(await files.delete("upload-1", { owner, scope: A })).toBe(true);
      expect(await files.getMeta("upload-1", { owner, scope: A })).toBeUndefined();
      expect(await found(files, B, b, "bravo")).toBe(400);
      const again = await files.ingest({ name: "app.log", bytes: utf8(log("charl")), id: "upload-1", scope: A, owner });
      expect(again.createdAt).toBe(a.createdAt);
      expect(await found(files, A, again, "charl")).toBe(400);
      expect(await found(files, A, again, "alpha")).toBe(0);
      expect(await found(files, B, b, "bravo")).toBe(400);
      expect(await found(files, B, b, "charl")).toBe(0);
    });
  }

  it("keeps scopes whose segments hold '#' and '%' apart, in memory too", async () => {
    const store = new RecordingStore(() => CLOCK);
    const files = createLargeFiles({ store, now: () => CLOCK, wholeDocumentBytes: 0, scanChunkBytes: 4_096, budget: { inlineTokens: 10 } });
    // A key made by joining the segments as they are would take these for one scope, or cut a
    // piece's key at the '#' of a segment.
    const scopes: DocumentScope[] = [["a#1", "b"], ["a", "1#b"], ["a%231", "b"], ["a/1".replace("/", "%2F"), "b"]];
    const words = ["alpha", "bravo", "charl", "delta"];
    const metas: DocumentMeta[] = [];
    for (const [index, scope] of scopes.entries()) {
      metas.push(await files.ingest({ name: "app.log", bytes: utf8(log(words[index]!)), id: "same", scope }));
    }
    for (let round = 0; round < 2; round++) {
      for (const [index, scope] of scopes.entries()) {
        const tools = files.tools([metas[index]!], { access: { scope } });
        for (const [other, word] of words.entries()) {
          const result = await tools.execute("search_document", { document_id: "same", query: word, mode: "exact" });
          expect(result.total_matching_lines, `${scope.join("|")} ${word}`).toBe(other === index ? 400 : 0);
        }
      }
    }
  });

  it("shows each chat the pages of its own PDF", async () => {
    const store = new MemoryDocumentStore({ now: () => CLOCK });
    const files = createLargeFiles({ store, keepOriginals: ["pdf"], now: () => CLOCK });
    const pdf = (word: string) => pdfWithPages([textLine(`${word} page one`), textLine(`${word} page two`)]);
    const a = await files.ingest({ name: "report.pdf", bytes: pdf("alpha"), id: "report", scope: A, owner });
    const b = await files.ingest({ name: "report.pdf", bytes: pdf("bravo"), id: "report", scope: B, owner });
    const pageText = async (scope: DocumentScope, meta: DocumentMeta) => {
      const output = await files.tools([meta], { access: { owner, scope }, viewPages: true }).executeWithFiles("view_pages", { document_id: "report", from_page: 2 });
      const document = await getDocumentProxy(new Uint8Array(output.files[0]!.bytes));
      const content = await (await document.getPage(1)).getTextContent();
      return (content.items as Array<{ str?: string }>).map((item) => item.str ?? "").join("").trim();
    };
    for (let round = 0; round < 2; round++) {
      expect(await pageText(A, a)).toBe("alpha page two");
      expect(await pageText(B, b)).toBe("bravo page two");
    }
    expect(await files.getOriginal("report", { owner, scope: A })).toEqual(pdf("alpha"));
    expect(await files.getOriginal("report", { owner, scope: B })).toEqual(pdf("bravo"));
  });
});
