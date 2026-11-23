// Ingests under an application's ID (0.9.0) that meet another document of that ID: two ingests of
// one ID at once in one library, the clean-up after a write that failed while another server stored
// the ID, writes that did not end in time, "replace" over another owner's document, and the first
// look at the ID, which must end, and is not made for a caller that has gone.
// Two libraries over one store stand for two servers; a held store call stands for a slow one.
import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, IngestError, MemoryDocumentStore, type DocumentContext, type IngestEvent, type LargeFiles, type StoredDocument } from "llm-large-files";
import { utf8 } from "./fake-model.js";
import { HeldMemoryStore, StoreOf08 } from "./held-store.js";

const base = { tokens: 0, bytes: 0 };
type Access = { owner?: string; scope?: string[] };

/** The text of a document as `prepare` gives it (whole, or its card), or undefined when it is missing. */
const textOf = async (files: LargeFiles, id: string, access: Access) => (await files.prepare([id], base, access)).blocks.get(id);

describe("two ingests of one application's ID at once, in one library", () => {
  const cases = [
    { kind: "a store that ignores the context, two scopes", store: () => new StoreOf08(), alice: { owner: "alice", scope: ["a"] }, bob: { owner: "bob", scope: ["b"] } },
    { kind: "a store that keeps scopes apart, one scope, two owners", store: () => new HeldMemoryStore(), alice: { owner: "alice", scope: ["org"] }, bob: { owner: "bob", scope: ["org"] } },
  ];
  for (const { kind, store: make, alice, bob } of cases) {
    it(`refuses the second with a 409 whatever ifExists says, and each file stays its owner's (${kind})`, async () => {
      const store = make();
      const files = createLargeFiles({ store, keepOriginals: ["text"], maxConcurrentIngests: 2 });
      // Alice's document is written up to its metadata, which the store has not taken yet.
      const held = store.holds.hold("put", "alice");
      const first = files.ingest({ name: "alice.txt", bytes: utf8("alice's file\n"), id: "shared", ...alice });
      await held.reached;
      // Both ways, one after the other: the first refusal does not free the ID for the second.
      for (const ifExists of ["fail", "replace"] as const) {
        const events: IngestEvent[] = [];
        const refused = await files.ingest({ name: "bob.txt", bytes: utf8("bob's file\n"), id: "shared", ifExists, ...bob, onEvent: (event) => events.push(event) })
          .catch((error: unknown) => error);
        expect(IngestError.is(refused), ifExists).toBe(true);
        expect(refused).toMatchObject({ code: "exists", status: 409, message: "bob.txt: a document with this ID already exists." });
        expect(events.at(-1)).toMatchObject({ type: "ingest.error", error: { code: "exists", status: 409 } });
      }
      held.release();
      expect((await first).name).toBe("alice.txt");
      // The file view_pages would show alice is hers, and so is the text.
      expect(await files.getOriginal("shared", alice)).toEqual(utf8("alice's file\n"));
      expect(await textOf(files, "shared", alice)).toContain("alice's file");
      expect(await files.getMeta("shared", bob)).toBeUndefined();
      // Once the first is over, the ID is free in the library again: the store says whether it is taken.
      await expect(files.ingest({ name: "bob.txt", bytes: utf8("bob's file\n"), id: "shared", ...bob })).rejects.toMatchObject({ code: "exists" });
      const again = await files.ingest({ name: "alice-2.txt", bytes: utf8("alice's second file\n"), id: "shared", ifExists: "replace", ...alice });
      expect(again.name).toBe("alice-2.txt");
    });
  }

  it("frees the ID when an ingest fails, and when it is refused before it is read", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await expect(files.ingest({ name: "blank.txt", bytes: utf8(" \n"), id: "upload-1" })).rejects.toMatchObject({ code: "no_text" });
    await files.ingest({ name: "a.txt", bytes: utf8("first\n"), id: "upload-1" });
    await expect(files.ingest({ name: "b.txt", bytes: utf8("second\n"), id: "upload-1" })).rejects.toMatchObject({ code: "exists" });
    expect((await files.ingest({ name: "c.txt", bytes: utf8("third\n"), id: "upload-1", ifExists: "replace" })).name).toBe("c.txt");
  });
});

describe("the clean-up after a write that failed", () => {
  /** A database whose insert refuses an ID that is there, as MongoDB's insertOne with an _id does. */
  class UniqueIds extends StoreOf08 {
    override async put(document: StoredDocument, context?: DocumentContext) {
      await this.holds.pass("put", context);
      if (this.documents.has(document.meta.id)) throw Object.assign(new Error("E11000 duplicate key error collection: llf.documents"), { code: 11000 });
      this.documents.set(document.meta.id, structuredClone(document));
    }
  }

  it("leaves the document another server stored under the ID meanwhile, and answers 409", async () => {
    const store = new UniqueIds();
    const one = createLargeFiles({ store });
    const two = createLargeFiles({ store });
    const alice = { owner: "alice", scope: ["a"] };
    // Bob's ingest has found the ID free, and waits to write its metadata.
    const held = store.holds.hold("put", "bob");
    const bobs = one.ingest({ name: "bob.txt", bytes: utf8("bob's\n"), id: "shared", owner: "bob", scope: ["b"] }).catch((error: unknown) => error);
    await held.reached;
    await two.ingest({ name: "alice.txt", bytes: utf8("alice's\n"), id: "shared", ...alice });
    held.release();
    expect(await bobs).toMatchObject({ name: "IngestError", code: "exists", status: 409, message: "bob.txt: a document with this ID already exists." });
    expect((await two.getMeta("shared", alice))?.name).toBe("alice.txt");
    expect(await textOf(two, "shared", alice)).toContain("alice's");
  });

  it("leaves the document it was to replace when the delete of it fails, and answers 503, not 409", async () => {
    /** Its next delete fails. */
    class FailingDelete extends MemoryDocumentStore {
      failNext = false;
      override async delete(id: string, context?: DocumentContext) {
        if (!this.failNext) return super.delete(id, context);
        this.failNext = false;
        throw new Error("EIO: the delete failed.");
      }
    }
    // A clock that moves on at each look: the two documents are told apart by their createdAt. The
    // store's own clock stays at the start, so that it removes nothing as expired.
    let tick = 0;
    const ticking = () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1_000);
    // Alice replaces her own document.
    const store = new FailingDelete({ now: () => new Date(Date.UTC(2026, 0, 1)) });
    const files = createLargeFiles({ store, now: ticking });
    await files.ingest({ name: "a.txt", bytes: utf8("the first file\n"), id: "upload-1", owner: "alice" });
    store.failNext = true;
    await expect(files.ingest({ name: "b.txt", bytes: utf8("the second file\n"), id: "upload-1", owner: "alice", ifExists: "replace" }))
      .rejects.toMatchObject({ name: "DocumentStoreError", operation: "write", status: 503 });
    expect(await textOf(files, "upload-1", { owner: "alice" })).toContain("the first file");
    // Bob writes over alice's document once it has expired.
    let clock = Date.UTC(2026, 0, 1);
    const expired = new FailingDelete({ now: () => new Date(Date.UTC(2026, 0, 1)) });
    const later = createLargeFiles({ store: expired, ttlMs: 1_000, now: () => new Date(clock) });
    await later.ingest({ name: "a.txt", bytes: utf8("the first file\n"), id: "upload-1", owner: "alice" });
    clock += 5_000;
    expired.failNext = true;
    await expect(later.ingest({ name: "b.txt", bytes: utf8("the second file\n"), id: "upload-1", owner: "bob" }))
      .rejects.toMatchObject({ name: "DocumentStoreError", operation: "write", status: 503 });
    expect((await expired.getMeta("upload-1"))?.owner).toBe("alice");
  });

  it("still removes what the ingest wrote when the document under the ID is its own", async () => {
    class Failing extends StoreOf08 {
      override async put(document: StoredDocument, context?: DocumentContext) {
        await super.put(document, context);
        throw new Error("The write was not acknowledged.");
      }
    }
    const store = new Failing();
    const files = createLargeFiles({ store, keepOriginals: ["text"] });
    await expect(files.ingest({ name: "a.txt", bytes: utf8("a\n"), id: "upload-1", owner: "alice" })).rejects.toMatchObject({ name: "DocumentStoreError", operation: "write" });
    expect(store.documents.size).toBe(0);
    expect(store.originals.size).toBe(0);
  });

  it("after a listener that throws on ingest.finish, removes the document only while it is the ingest's own", async () => {
    const store = new StoreOf08();
    const files = createLargeFiles({ store });
    const thrown = new Error("The listener failed.");
    // Its own: removed, as before.
    await expect(files.ingest({ name: "a.txt", bytes: utf8("a\n"), id: "upload-1", owner: "bob", onEvent: (event) => {
      if (event.type === "ingest.finish") throw thrown;
    } })).rejects.toBe(thrown);
    expect(store.documents.size).toBe(0);
    // Another's by then (written by another server): left where it is.
    await createLargeFiles({ store }).ingest({ name: "alice.txt", bytes: utf8("alice's\n"), id: "elsewhere", owner: "alice" });
    const theirs = structuredClone(store.documents.get("elsewhere")!);
    theirs.meta.id = "upload-1";
    await expect(files.ingest({ name: "b.txt", bytes: utf8("bob's\n"), id: "upload-1", owner: "bob", onEvent: (event) => {
      if (event.type === "ingest.finish") {
        store.documents.set("upload-1", theirs);
        throw thrown;
      }
    } })).rejects.toBe(thrown);
    expect(store.documents.get("upload-1")?.meta.owner).toBe("alice");
  });
});

describe("writes that do not end in time", () => {
  it("keep the ID held in the library until they and the removal of what they wrote have ended", async () => {
    const store = new StoreOf08();
    const files = createLargeFiles({ store, keepOriginals: ["text"], ingestTimeoutMs: 100 });
    const alice = { owner: "alice", scope: ["a"] };
    const bob = { owner: "bob", scope: ["b"] };
    // Alice's metadata is not written within the 100 ms the writes are given.
    const held = store.holds.hold("put", "alice");
    const alices = files.ingest({ name: "a.txt", bytes: utf8("alice's file\n"), id: "shared", ...alice }).catch((error: unknown) => error);
    await held.reached;
    expect(await alices).toMatchObject({ name: "DocumentStoreError", operation: "write", code: "ETIMEDOUT", status: 503 });
    // Her write may still land, and then be removed: the ID is not free for bob yet.
    await expect(files.ingest({ name: "b.txt", bytes: utf8("bobby's file\n"), id: "shared", ...bob }))
      .rejects.toMatchObject({ name: "IngestError", code: "exists", status: 409 });
    // It lands, and her ingest removes what it wrote.
    held.release();
    for (let turn = 0; turn < 50 && (store.documents.size > 0 || store.originals.size > 0); turn++) await new Promise((resolve) => setImmediate(resolve));
    expect([store.documents.size, store.originals.size]).toEqual([0, 0]);
    await new Promise((resolve) => setImmediate(resolve));
    // Now bob's ingest stores his file, and nothing removes it.
    expect((await files.ingest({ name: "b.txt", bytes: utf8("bobby's file\n"), id: "shared", ...bob })).name).toBe("b.txt");
    expect(await files.getOriginal("shared", bob)).toEqual(utf8("bobby's file\n"));
    expect(await files.getOriginal("shared", alice)).toBeUndefined();
    expect(await textOf(files, "shared", bob)).toContain("bobby's file");
  });
});

describe('ifExists: "replace" over a document of another owner or scope', () => {
  it("is refused even when a read says its text is gone: a wrapper that drops the context on readTextRange", async () => {
    /** Written for 0.8 in part: it passes the context on in getMeta, not in readTextRange, which then looks in no scope. */
    class DropsContext extends MemoryDocumentStore {
      async readTextRange(id: string, start: number, end: number, _context?: DocumentContext) {
        const document = await this.get(id);
        return document && utf8(document.text).subarray(start, end);
      }
    }
    const files = createLargeFiles({ store: new DropsContext() });
    const scope = ["org"];
    await files.ingest({ name: "x.txt", bytes: utf8("x's report\n"), id: "report", owner: "x", scope });
    await expect(files.ingest({ name: "y.txt", bytes: utf8("y's report\n"), id: "report", owner: "y", scope, ifExists: "replace" }))
      .rejects.toMatchObject({ code: "exists", status: 409, message: "y.txt: a document with this ID already exists." });
    expect(await textOf(files, "report", { owner: "x", scope })).toContain("x's report");
  });

  it("writes over it once it has expired", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const files = createLargeFiles({ store: new StoreOf08(), ttlMs: 60_000, now: () => clock });
    await files.ingest({ name: "x.txt", bytes: utf8("x's\n"), id: "report", owner: "x" });
    clock = new Date("2026-01-01T00:02:00Z");
    await files.ingest({ name: "y.txt", bytes: utf8("y's\n"), id: "report", owner: "y", ifExists: "replace" });
    expect(await textOf(files, "report", { owner: "y" })).toContain("y's");
  });
});

describe("the first look at an application's ID, before the file is read", () => {
  /** A store that never answers getMeta, and says when it is asked. */
  class Silent extends MemoryDocumentStore {
    asked: () => void = () => {};
    override getMeta(): Promise<undefined> {
      this.asked();
      return new Promise<undefined>(() => {});
    }
  }

  it("gives a caller that gives up its own reason", async () => {
    const store = new Silent();
    const files = createLargeFiles({ store });
    const controller = new AbortController();
    const reason = new Error("The uploader went away.");
    store.asked = () => controller.abort(reason);
    await expect(files.ingest({ name: "a.txt", bytes: utf8("a\n"), id: "upload-1", signal: controller.signal })).rejects.toBe(reason);
  });

  it("is not made for a caller that has already gone: nothing is asked, and no rejection is left unhandled", async () => {
    // Vitest fails the run on an unhandled rejection, which ends a Node.js server; this says which test made it.
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", note);
    try {
      const reason = new Error("The uploader went away before the upload began.");
      const controller = new AbortController();
      controller.abort(reason);
      // An ID that is taken, a store that fails, and a store that does not answer within 30 ms.
      const taken = new MemoryDocumentStore();
      await createLargeFiles({ store: taken }).ingest({ name: "a.txt", bytes: utf8("a\n"), id: "upload-1", owner: "alice" });
      const failing = new MemoryDocumentStore();
      failing.getMeta = async () => {
        throw new Error("ECONNREFUSED");
      };
      const cases = [
        { kind: "taken", store: taken, ingestTimeoutMs: undefined },
        { kind: "failing", store: failing, ingestTimeoutMs: undefined },
        { kind: "silent", store: new Silent(), ingestTimeoutMs: 30 },
      ];
      for (const { kind, store, ingestTimeoutMs } of cases) {
        const files = createLargeFiles({ store, ...(ingestTimeoutMs ? { ingestTimeoutMs } : {}) });
        const asked = vi.spyOn(store, "getMeta");
        await expect(files.ingest({ name: "b.txt", bytes: utf8("b\n"), id: "upload-1", owner: "bob", signal: controller.signal }), kind).rejects.toBe(reason);
        expect(asked, kind).not.toHaveBeenCalled();
      }
      // Past the 30 ms, and the answers of the stores.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", note);
    }
  });

  it("gives up on a store that does not answer within the time the writes are given", async () => {
    const files = createLargeFiles({ store: new Silent(), ingestTimeoutMs: 100 });
    const thrown = await files.ingest({ name: "a.txt", bytes: utf8("a\n"), id: "upload-1" }).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ name: "DocumentStoreError", operation: "read", code: "ETIMEDOUT" });
    expect(((thrown as Error).cause as Error).message).toBe("The store did not answer about a.txt within 100 ms.");
  });
});
