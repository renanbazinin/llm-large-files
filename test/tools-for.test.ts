// files.toolsFor (I6, 0.10.0): each ID is looked up for the caller, as getMeta does, then the tools
// are made for the documents found; the others are listed as missing, another owner's included.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { serviceLog, utf8 } from "llm-large-files/testing";

describe("files.toolsFor", () => {
  it("makes the tools for the caller's documents, and reports another owner's ID as missing", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const mine = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)), owner: "alice" });
    const theirs = await files.ingest({ name: "secret.log", bytes: utf8(serviceLog(300)), owner: "bob" });
    const { tools, missing } = await files.toolsFor([mine.id, theirs.id, "doc_00000000000000000000000000000000", mine.id], { access: { owner: "alice" } });
    expect(missing).toEqual([theirs.id, "doc_00000000000000000000000000000000"]);
    expect(await tools.execute("read_document", { document_id: mine.id, start_line: 1, end_line: 2 })).toMatchObject({ lines: "1-2" });
    // The other owner's document is not among the tools' documents.
    expect(await tools.execute("read_document", { document_id: theirs.id, start_line: 1, end_line: 1 })).toMatchObject({ error: expect.stringContaining("Unknown document_id") });
  });

  it("reads with the caller's owner and scope on every call, as tools with access do", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)), owner: "alice", scope: ["u1", "c1"] });
    expect((await files.toolsFor([meta.id], { access: { owner: "alice", scope: ["u1", "c2"] } })).missing).toEqual([meta.id]);
    const { tools, missing } = await files.toolsFor([meta.id], { access: { owner: "alice", scope: ["u1", "c1"] } });
    expect(missing).toEqual([]);
    // Deleted meanwhile: the tools find it gone.
    await files.delete(meta.id, { owner: "alice", scope: ["u1", "c1"] });
    expect(await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 1 })).toMatchObject({ error: expect.stringContaining("no longer available") });
  });

  it("needs access, and its owner under requireOwner", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await expect(files.toolsFor(["doc_1"], undefined as never)).rejects.toBeInstanceOf(TypeError);
    await expect(files.toolsFor("doc_1" as never, { access: {} })).rejects.toBeInstanceOf(TypeError);
    const strict = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: true });
    await expect(strict.toolsFor(["doc_1"], { access: {} })).rejects.toThrow("owner is required: requireOwner is on");
    const { tools, missing } = await files.toolsFor([], { access: {} });
    expect(missing).toEqual([]);
    expect(tools.declarations.length).toBeGreaterThan(0);
  });

  it("stops waiting for the store when the caller's signal aborts", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, storeTimeoutMs: 0 });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha\n") });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getMeta = store.getMeta.bind(store);
    store.getMeta = async (id, context) => {
      await gate;
      return getMeta(id, context);
    };
    const controller = new AbortController();
    const asked = files.toolsFor([meta.id], { access: { signal: controller.signal } });
    controller.abort(new Error("Stopped."));
    await expect(asked).rejects.toThrow("Stopped.");
    release();
  });
});
