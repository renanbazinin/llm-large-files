import fsp, { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, DocumentStoreError, FileDocumentStore, MemoryDocumentStore, NEVER_EXPIRES } from "llm-large-files";

const bytes = (text: string) => new TextEncoder().encode(text);
const log = (lines: number) => Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} took ${i % 900}ms`).join("\n");

type FsCall = "readFile" | "open" | "rm";

/**
 * Makes the next matching call of an `fs/promises` function fail the way a busy volume does: with a
 * system error whose message names the path. Returns how to undo it.
 */
function failNext(method: FsCall, matches: (target: string) => boolean, code: string): () => void {
  const table = fsp as unknown as Record<FsCall, (...args: unknown[]) => Promise<unknown>>;
  const real = table[method];
  let armed = true;
  table[method] = function (this: unknown, ...args: unknown[]) {
    const target = String(args[0]);
    if (armed && matches(target)) {
      armed = false;
      return Promise.reject(Object.assign(new Error(`${code}: it failed, ${method} '${target}'`), { code, syscall: method === "readFile" ? "open" : method, path: target }));
    }
    return real.apply(this, args);
  };
  syncBuiltinESMExports();
  return () => {
    table[method] = real;
    syncBuiltinESMExports();
  };
}

let directory: string | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  restore = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function folder(): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), "llf-errors-"));
  return directory;
}

describe("a store that could not be read", () => {
  it("is not taken for an unreadable document by sweep, however old the document is", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir) });
    const meta = await files.ingest({ name: "contract.txt", bytes: bytes("clause 1\nclause 2\n"), owner: "alice" });
    // Two hours old, with seventy hours left to live.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const entry of await readdir(dir)) await utimes(path.join(dir, entry), old, old);
    const before = (await readdir(dir)).sort();

    restore = failNext("readFile", (target) => target.endsWith(`${meta.id}.json`), "EMFILE");
    expect(await files.sweep()).toBe(0);
    restore();
    restore = undefined;

    expect((await readdir(dir)).sort()).toEqual(before);
    expect((await files.getMeta(meta.id, { owner: "alice" }))?.name).toBe("contract.txt");
  });

  it("is an error to retry, not a missing document", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir) });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });

    restore = failNext("readFile", (target) => target.endsWith(`${meta.id}.json`), "EIO");
    const failure = await files.prepare([meta.id], { tokens: 0, bytes: 0 }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(DocumentStoreError);
    expect(failure).toMatchObject({ code: "EIO", message: "The document store could not be read (EIO). Try again." });
    // The message is for a user or a model. What happened, with the path, is the cause.
    expect((failure as Error).message).not.toContain(dir);
    expect(String(((failure as Error).cause as Error).message)).toContain(dir);

    // The same call a moment later: the document was there all along.
    const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 });
    expect(prepared.missing).toEqual([]);
    expect(prepared.blocks.get(meta.id)).toContain("one\ntwo");
  });

  it("tells a model the code of the error, never the path", async () => {
    const dir = await folder();
    // Read by range, so that the tool call opens the text file.
    const files = createLargeFiles({ store: new FileDocumentStore(dir), wholeDocumentBytes: 0, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(log(500)) });
    const tools = files.tools([meta]);
    expect((await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 2 })).lines).toBe("1-2");

    restore = failNext("open", (target) => target.endsWith(`${meta.id}.txt`), "EACCES");
    const result = await tools.execute("read_document", { document_id: meta.id, start_line: 5, end_line: 9 });
    expect(result).toEqual({ error: "The document store could not be read (EACCES). Try again." });
    expect((await tools.execute("read_document", { document_id: meta.id, start_line: 5, end_line: 9 })).lines).toBe("5-9");
  });

  it("does not pass on what a store of another kind says in its errors", async () => {
    class Remote extends MemoryDocumentStore {
      down = false;
      override async getMeta(id: string) {
        if (this.down) throw new Error("connect ECONNREFUSED mongo-2.internal.corp:27017");
        return super.getMeta(id);
      }
    }
    const store = new Remote();
    const files = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(log(400)) });
    const tools = files.tools([meta]);
    store.down = true;
    expect(await tools.execute("search_document", { document_id: meta.id, query: "request 7", mode: "exact" }))
      .toEqual({ error: "The document store could not be read. Try again." });
    await expect(files.getMeta(meta.id)).rejects.toBeInstanceOf(DocumentStoreError);
  });

  it("keeps a document whole when its metadata cannot be removed", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir), keepOriginals: ["text"] });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });
    const before = (await readdir(dir)).sort();
    expect(before).toHaveLength(4);

    restore = failNext("rm", (target) => target.endsWith(`${meta.id}.json`), "EBUSY");
    await expect(files.delete(meta.id)).rejects.toMatchObject({ code: "EBUSY" });
    restore();
    restore = undefined;

    // Nothing of it went: a document whose text is gone must not stay listed.
    expect((await readdir(dir)).sort()).toEqual(before);
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 })).blocks.get(meta.id)).toContain("one\ntwo");
    expect(await files.delete(meta.id)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("documents that never expire", () => {
  it("accepts a time to live without end", async () => {
    const dir = await folder();
    let clock = new Date("2026-06-01T00:00:00Z");
    const store = new FileDocumentStore(dir, { now: () => clock });
    const files = createLargeFiles({ store, ttlMs: Number.POSITIVE_INFINITY, now: () => clock });
    const meta = await files.ingest({ name: "policy.md", bytes: bytes("# Policy\n\nKeep this.") });
    expect(meta.expiresAt).toBe(NEVER_EXPIRES);

    clock = new Date("2126-06-01T00:00:00Z"); // a hundred years on
    expect(await files.sweep()).toBe(0);
    expect((await files.getMeta(meta.id))?.expiresAt).toBe(NEVER_EXPIRES);
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 })).missing).toEqual([]);
  });

  it("still dates a time to live that has an end", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ttlMs: 60_000, now: () => new Date("2026-06-01T00:00:00Z") });
    const meta = await files.ingest({ name: "a.txt", bytes: bytes("x") });
    expect(meta.expiresAt).toBe("2026-06-01T00:01:00.000Z");
  });
});
