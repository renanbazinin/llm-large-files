// Document IDs chosen by the application (IngestInput.id, 0.9.0), and what ingest does when one is
// taken (ifExists).
import { describe, expect, it } from "vitest";
import {
  APP_DOCUMENT_ID_PATTERN,
  createLargeFiles,
  DOCUMENT_ID_PATTERN,
  DocumentStoreError,
  IngestError,
  isDocumentId,
  MemoryDocumentStore,
  type DocumentContext,
  type DocumentStore,
  type Extractor,
  type IngestEvent,
  type StoredDocument,
} from "llm-large-files";
import { utf8 } from "./fake-model.js";

const SHAPE = 'id must be lowercase letters, digits, "_" and "-", up to 64 characters, starting with a letter or a digit (APP_DOCUMENT_ID_PATTERN).';
const base = { tokens: 0, bytes: 0 };
const textOf = async (files: ReturnType<typeof createLargeFiles>, id: string, access: { owner?: string; scope?: string[] } = {}) =>
  (await files.prepare([id], base, access)).blocks.get(id);

/** A store written for 0.8: one map for every scope, whatever the context says. */
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

describe("the shape of an application's ID", () => {
  it("takes lowercase letters, digits, '_' and '-', up to 64, from a letter or a digit", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    for (const id of ["a", "0", "upload-1", "u_1-x", "x".repeat(64), "doc_0123456789abcdef0123456789abcdef"]) {
      expect((await files.ingest({ name: "a.txt", bytes: utf8("a\n"), id })).id).toBe(id);
      expect(isDocumentId(id)).toBe(true);
    }
    for (const id of ["", "Upload-1", "x".repeat(65), "-upload", "_upload", "a.b", "a/b", "a#b", "a b", "שלום", " a", 7] as unknown as string[]) {
      await expect(files.ingest({ name: "a.txt", bytes: utf8("a\n"), id }), JSON.stringify(id)).rejects.toThrow(new TypeError(SHAPE));
      expect(isDocumentId(id), JSON.stringify(id)).toBe(false);
    }
    // The ID is not in the message: it may hold what it must not.
    await expect(files.ingest({ name: "a.txt", bytes: utf8("a\n"), id: "Alice@example.com" })).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining("Alice") }));
  });

  it("keeps the shapes of both patterns, and still makes an ID when none is given", async () => {
    expect(DOCUMENT_ID_PATTERN.test("upload-1")).toBe(false);
    expect(APP_DOCUMENT_ID_PATTERN.test("upload-1")).toBe(true);
    const meta = await createLargeFiles({ store: new MemoryDocumentStore() }).ingest({ name: "a.txt", bytes: utf8("a\n") });
    expect(meta.id).toMatch(DOCUMENT_ID_PATTERN);
  });

  it("is used everywhere an ID is: getMeta, prepare, tools, delete", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(Array.from({ length: 300 }, (_, i) => `INFO request ${i}`).join("\n")), id: "upload-7" });
    expect((await files.getMeta("upload-7"))?.name).toBe("app.log");
    expect(await textOf(files, "upload-7")).toContain("document_id: upload-7");
    expect((await files.tools([meta]).execute("search_document", { document_id: "upload-7", query: "request 7", mode: "exact" })).total_matching_lines).toBe(11);
    expect(await files.delete("upload-7")).toBe(true);
    expect(await files.getMeta("upload-7")).toBeUndefined();
  });

  it("refuses an ifExists it does not know", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await expect(files.ingest({ name: "a.txt", bytes: utf8("a\n"), id: "x", ifExists: "skip" as "fail" })).rejects.toThrow(new TypeError('ifExists must be "fail" or "replace".'));
  });
});

describe('ifExists: "fail", the default', () => {
  it("refuses a document of that ID with a 409, before the file is read, and keeps the one there", async () => {
    let reads = 0;
    const counting: Extractor = async (bytes) => {
      reads++;
      return { text: new TextDecoder().decode(bytes) };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: counting } });
    const scope = ["u1", "s1"];
    await files.ingest({ name: "first.txt", bytes: utf8("first\n"), id: "upload-1", scope });
    const events: IngestEvent[] = [];
    const refused = await files.ingest({ name: "second.txt", bytes: utf8("second\n"), id: "upload-1", scope, onEvent: (event) => events.push(event) }).catch((error: unknown) => error);
    expect(IngestError.is(refused)).toBe(true);
    expect(refused).toMatchObject({ code: "exists", status: 409, message: "second.txt: a document with this ID already exists." });
    expect(reads).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "ingest.error", error: { code: "exists", status: 409 } });
    expect(await textOf(files, "upload-1", { scope })).toContain("first");
  });

  it("refuses a document of that ID in another scope, over a store that keeps no scopes apart", async () => {
    const files = createLargeFiles({ store: new StoreOf08() });
    await files.ingest({ name: "a.txt", bytes: utf8("chat one\n"), id: "upload-1", scope: ["u1", "s1"], owner: "u1" });
    await expect(files.ingest({ name: "b.txt", bytes: utf8("chat two\n"), id: "upload-1", scope: ["u2", "s9"], owner: "u2" }))
      .rejects.toMatchObject({ code: "exists", status: 409 });
    expect(await textOf(files, "upload-1", { owner: "u1", scope: ["u1", "s1"] })).toContain("chat one");
  });

  it("takes the same ID in another scope of a store that keeps scopes apart", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await files.ingest({ name: "a.txt", bytes: utf8("chat one\n"), id: "upload-1", scope: ["u1", "s1"] });
    await files.ingest({ name: "b.txt", bytes: utf8("chat two\n"), id: "upload-1", scope: ["u1", "s2"] });
    expect(await textOf(files, "upload-1", { scope: ["u1", "s1"] })).toContain("chat one");
    expect(await textOf(files, "upload-1", { scope: ["u1", "s2"] })).toContain("chat two");
  });

  it("writes over a document of that ID that has expired", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const store = new StoreOf08();
    const files = createLargeFiles({ store, ttlMs: 60_000, now: () => clock });
    await files.ingest({ name: "a.txt", bytes: utf8("old\n"), id: "upload-1" });
    clock = new Date("2026-01-01T00:02:00Z");
    await files.ingest({ name: "a.txt", bytes: utf8("new\n"), id: "upload-1" });
    expect(await textOf(files, "upload-1")).toContain("new");
  });

  it("refuses at the write a document stored under the ID while the file was read, and leaves that one alone", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => (waiting = resolve));
    const slow: Extractor = async (bytes, input) => {
      if (input.name === "slow.txt") {
        waiting();
        await held;
      }
      return { text: new TextDecoder().decode(bytes) };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: slow } });
    const first = files.ingest({ name: "slow.txt", bytes: utf8("slow\n"), id: "upload-1" }).catch((error: unknown) => error);
    await started;
    await files.ingest({ name: "fast.txt", bytes: utf8("fast\n"), id: "upload-1" });
    release();
    expect(await first).toMatchObject({ code: "exists", status: 409 });
    expect(await textOf(files, "upload-1")).toContain("fast");
  });
});

describe('ifExists: "replace"', () => {
  it("replaces a document of the same owner and scope", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["text"] });
    const who = { owner: "u1", scope: ["u1", "s1"] };
    await files.ingest({ name: "a.txt", bytes: utf8("old text\n"), id: "upload-1", ...who });
    expect(await textOf(files, "upload-1", who)).toContain("old text");
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("new text\n"), id: "upload-1", ifExists: "replace", ...who });
    expect(meta.id).toBe("upload-1");
    expect(await textOf(files, "upload-1", who)).toContain("new text");
    expect(await files.getOriginal("upload-1", who)).toEqual(utf8("new text\n"));
  });

  it("refuses one of another owner or scope", async () => {
    const store = new StoreOf08();
    const files = createLargeFiles({ store });
    await files.ingest({ name: "a.txt", bytes: utf8("alice's\n"), id: "upload-1", owner: "alice", scope: ["alice", "s1"] });
    for (const other of [{ owner: "bob", scope: ["alice", "s1"] }, { owner: "alice", scope: ["alice", "s2"] }, { owner: "alice" }, { scope: ["alice", "s1"] }]) {
      await expect(files.ingest({ name: "b.txt", bytes: utf8("other\n"), id: "upload-1", ifExists: "replace", ...other }), JSON.stringify(other))
        .rejects.toMatchObject({ code: "exists", status: 409, message: "b.txt: a document with this ID already exists." });
    }
    expect(await textOf(files, "upload-1", { owner: "alice", scope: ["alice", "s1"] })).toContain("alice's");
  });

  it("writes a document that is missing, and replaces one whose text is gone, whoever it was of", async () => {
    /** A store whose text can be lost while its metadata stays, as when a file is removed by hand. */
    class Lossy extends StoreOf08 {
      readonly lost = new Set<string>();
      override async put(document: StoredDocument) {
        this.lost.delete(document.meta.id);
        return super.put(document);
      }
      override async get(id: string) {
        return this.lost.has(id) ? undefined : super.get(id);
      }
    }
    const store = new Lossy();
    const files = createLargeFiles({ store });
    // Missing: written.
    expect((await files.ingest({ name: "a.txt", bytes: utf8("first\n"), id: "upload-1", ifExists: "replace", owner: "alice" })).id).toBe("upload-1");
    // Its text lost: missing for its owner, and replaced by another one, through whom nothing of
    // alice's can be read.
    store.lost.add("upload-1");
    expect((await files.prepare(["upload-1"], base, { owner: "alice" })).missing).toEqual(["upload-1"]);
    await files.ingest({ name: "b.txt", bytes: utf8("second\n"), id: "upload-1", ifExists: "replace", owner: "bob" });
    expect(await textOf(files, "upload-1", { owner: "bob" })).toContain("second");
    expect(await files.getMeta("upload-1", { owner: "alice" })).toBeUndefined();
  });

  it("asks a store that reads by range whether the text is there", async () => {
    class Ranged extends MemoryDocumentStore {
      readonly ranges: Array<[string, number, number]> = [];
      async readTextRange(id: string, start: number, end: number, _context?: DocumentContext) {
        this.ranges.push([id, start, end]);
        return undefined;
      }
    }
    const store = new Ranged();
    const files = createLargeFiles({ store });
    await files.ingest({ name: "a.txt", bytes: utf8("alice's\n"), id: "upload-1", owner: "alice" });
    await files.ingest({ name: "b.txt", bytes: utf8("bob's\n"), id: "upload-1", owner: "bob", ifExists: "replace" });
    expect(store.ranges).toEqual([["upload-1", 0, 1], ["upload-1", 0, 1]]);
    expect((await files.getMeta("upload-1", { owner: "bob" }))?.name).toBe("b.txt");
  });

  it("never replaces a document written by a newer version", async () => {
    const store = new StoreOf08();
    const files = createLargeFiles({ store });
    await files.ingest({ name: "a.txt", bytes: utf8("newer\n"), id: "upload-1" });
    store.documents.get("upload-1")!.meta.metaVersion = 2;
    const refused = await files.ingest({ name: "a.txt", bytes: utf8("older\n"), id: "upload-1", ifExists: "replace" }).catch((error: unknown) => error);
    expect(DocumentStoreError.is(refused)).toBe(true);
    expect(refused).toMatchObject({ code: "NEWER_VERSION" });
    expect(store.documents.get("upload-1")!.text).toBe("newer\n");
  });
});
