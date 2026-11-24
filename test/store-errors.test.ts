import fsp, { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, DocumentScopeError, DocumentStoreError, FileDocumentStore, MemoryDocumentStore, NEVER_EXPIRES, type DocumentContext, type IngestEvent, type StoredDocument } from "llm-large-files";

const bytes = (text: string) => new TextEncoder().encode(text);
const log = (lines: number) => Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} took ${i % 900}ms`).join("\n");

type FsCall = "readFile" | "open" | "rm" | "unlink" | "rename";

/**
 * Makes the next `times` matching calls of an `fs/promises` function fail the way a busy volume
 * does: with a system error whose message names the path. Returns how to undo it.
 */
function failNext(method: FsCall, matches: (target: string) => boolean, code: string, times = 1): () => void {
  const table = fsp as unknown as Record<FsCall, (...args: unknown[]) => Promise<unknown>>;
  const real = table[method];
  let left = times;
  table[method] = function (this: unknown, ...args: unknown[]) {
    const target = String(args[0]);
    if (left > 0 && matches(target)) {
      left--;
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

/**
 * Makes the next removal of the metadata fail: its rename to a name of the removal's own (since
 * 0.10.0), and an `unlink` of it (before).
 */
function failBoth(matches: (target: string) => boolean, code: string): () => void {
  const undo = [failNext("rename", matches, code), failNext("unlink", matches, code)];
  return () => undo.reverse().forEach((step) => step());
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

    // EIO, which is not tried again (EBUSY is since 0.9.0: see below). Since 0.10.0 the metadata is
    // renamed to a name of the delete's own before it is removed: the rename fails.
    restore = failBoth((target) => target.endsWith(`${meta.id}.json`), "EIO");
    await expect(files.delete(meta.id)).rejects.toMatchObject({ name: "DocumentStoreError", operation: "delete", code: "EIO" });
    restore();
    restore = undefined;

    // Nothing of it went: a document whose text is gone must not stay listed.
    expect((await readdir(dir)).sort()).toEqual(before);
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 })).blocks.get(meta.id)).toContain("one\ntwo");
    expect(await files.delete(meta.id)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("a store that could not write, delete or sweep (0.9.0)", () => {
  it("is a DocumentStoreError of operation 'write' at ingest, with the store's error as its cause", async () => {
    const dir = await folder();
    // A volume that fails as the text file is written, with an error that names the path.
    class Failing extends FileDocumentStore {
      override async put(document: StoredDocument): Promise<void> {
        throw Object.assign(new Error(`EIO: i/o error, open '${path.join(dir, document.meta.id)}.txt'`), { code: "EIO", syscall: "open" });
      }
    }
    const failing = createLargeFiles({ store: new Failing(dir) });
    const events: IngestEvent[] = [];
    const thrown = await failing.ingest({ name: "notes.txt", bytes: bytes("one\n"), onEvent: (event) => events.push(event) }).catch((error: unknown) => error);
    expect(DocumentStoreError.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({ operation: "write", code: "EIO", syscall: "open", status: 503, message: "The document could not be stored (EIO). Try again." });
    expect((thrown as Error).message).not.toContain(dir);
    expect(String(((thrown as Error).cause as Error).message)).toContain(dir);
    // The event, which a browser may see, says only that the document could not be stored: a
    // DocumentStoreError (503), without its code.
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "ingest.error", error: { message: "The document could not be stored. Try again later.", name: "DocumentStoreError", status: 503 } }));
    expect(await readdir(dir)).toEqual([]);
  });

  it("wraps a failed write of the original or of the index the same way", async () => {
    for (const method of ["putOriginal", "putIndex"] as const) {
      class Failing extends MemoryDocumentStore {
        async putIndex(): Promise<void> {
          if (method === "putIndex") throw new Error("bucket llf-prod-7 refused");
        }
        override async putOriginal(id: string, data: Uint8Array, context?: DocumentContext): Promise<void> {
          if (method === "putOriginal") throw new Error("bucket llf-prod-7 refused");
          return super.putOriginal(id, data, context);
        }
      }
      const store = new Failing();
      const files = createLargeFiles({ store, keepOriginals: ["text"] });
      const thrown = await files.ingest({ name: "a.txt", bytes: bytes("a\n") }).catch((error: unknown) => error);
      expect(thrown, method).toMatchObject({ name: "DocumentStoreError", operation: "write", message: "The document could not be stored. Try again.", cause: new Error("bucket llf-prod-7 refused") });
      expect(await store.sweep(new Date(8.64e15))).toBe(0);
    }
  });

  it("is a DocumentStoreError of code ETIMEDOUT when the store does not finish writing in time", async () => {
    class Hanging extends MemoryDocumentStore {
      override put(): Promise<void> {
        return new Promise(() => {});
      }
    }
    const files = createLargeFiles({ store: new Hanging(), ingestTimeoutMs: 100 });
    const thrown = await files.ingest({ name: "a.txt", bytes: bytes("a\n") }).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ name: "DocumentStoreError", operation: "write", code: "ETIMEDOUT", message: "The document could not be stored (ETIMEDOUT). Try again." });
    expect(((thrown as Error).cause as Error).message).toBe("The store did not finish writing a.txt within 100 ms.");
  });

  it("gives up on a store that does not answer whether an application's ID is taken, before anything is written", async () => {
    class Hanging extends MemoryDocumentStore {
      looks = 0;
      override getMeta(id: string, context?: DocumentContext) {
        // The look before the file is read answers; the one just before the writes does not.
        return ++this.looks === 1 ? super.getMeta(id, context) : new Promise<undefined>(() => {});
      }
    }
    const store = new Hanging();
    const files = createLargeFiles({ store, ingestTimeoutMs: 100 });
    const thrown = await files.ingest({ name: "a.txt", bytes: bytes("a\n"), id: "upload-1" }).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ name: "DocumentStoreError", operation: "read", code: "ETIMEDOUT" });
    expect(((thrown as Error).cause as Error).message).toBe("The store did not answer about a.txt within 100 ms.");
    expect(await store.sweep(new Date(8.64e15))).toBe(0);
  });

  it("is a DocumentStoreError of operation 'delete' from files.delete, with no path in the message", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir) });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\n") });
    // EROFS (a volume mounted read-only) is not tried again: EPERM, EACCES and EBUSY are, since 0.9.0.
    restore = failBoth((target) => target.endsWith(`${meta.id}.json`), "EROFS");
    const thrown = await files.delete(meta.id).catch((error: unknown) => error);
    expect(DocumentStoreError.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({ operation: "delete", code: "EROFS", status: 503, message: "The document could not be deleted (EROFS). Try again." });
    expect((thrown as Error).message).not.toContain(dir);
    expect(String(((thrown as Error).cause as Error).message)).toContain(dir);
  });

  it("is a DocumentStoreError of operation 'sweep' from files.sweep", async () => {
    class Failing extends MemoryDocumentStore {
      override async sweep(): Promise<number> {
        throw Object.assign(new Error("EACCES: permission denied, scandir '/srv/volume/u1'"), { code: "EACCES", syscall: "scandir" });
      }
    }
    const thrown = await createLargeFiles({ store: new Failing() }).sweep().catch((error: unknown) => error);
    expect(thrown).toMatchObject({ name: "DocumentStoreError", operation: "sweep", code: "EACCES", message: "The document store could not be cleaned up (EACCES). Try again." });
    expect((thrown as Error).message).not.toContain("/srv");
  });

  it("passes a DocumentScopeError of the store on as it is: a mistake of the call, not a store to try again", async () => {
    const gone = new DocumentScopeError("scope_missing");
    class NoFolder extends MemoryDocumentStore {
      override async put(): Promise<void> {
        throw gone;
      }
      override async delete(): Promise<boolean> {
        throw gone;
      }
      override async sweep(): Promise<number> {
        throw gone;
      }
    }
    const files = createLargeFiles({ store: new NoFolder() });
    const events: IngestEvent[] = [];
    await expect(files.ingest({ name: "a.txt", bytes: bytes("a\n"), scope: ["u1", "s1"], onEvent: (event) => events.push(event) })).rejects.toBe(gone);
    expect(events.at(-1)).toMatchObject({ type: "ingest.error", error: { message: "The scope no longer exists.", name: "DocumentScopeError" } });
    await expect(files.sweep({ scope: ["u1", "s1"] })).rejects.toBe(gone);

    class Unscoped extends MemoryDocumentStore {
      override async getMeta(id: string, context?: DocumentContext) {
        if (!context?.scope) throw new DocumentScopeError("scope_required");
        return super.getMeta(id, context);
      }
    }
    const strict = createLargeFiles({ store: new Unscoped() });
    await expect(strict.getMeta("doc_0123456789abcdef0123456789abcdef")).rejects.toMatchObject({ name: "DocumentScopeError", code: "scope_required" });
  });
});

/**
 * Makes removing a file that `matches` fail with `code`, `times` times, whichever call removes it:
 * `unlink` since 0.9.0, `rm` before, and for the metadata, since 0.10.0, its `rename` to a name of
 * the removal's own. Counts the tries.
 */
function failRemoval(matches: (target: string) => boolean, code: string, times = Number.POSITIVE_INFINITY): { tries: number } {
  const table = fsp as unknown as Record<"rm" | "unlink" | "rename", (...args: unknown[]) => Promise<unknown>>;
  const real = { rm: table.rm, unlink: table.unlink, rename: table.rename };
  const counted = { tries: 0 };
  for (const method of ["rm", "unlink", "rename"] as const) {
    table[method] = function (this: unknown, ...args: unknown[]) {
      const target = String(args[0]);
      if (matches(target)) {
        counted.tries++;
        if (counted.tries <= times) return Promise.reject(Object.assign(new Error(`${code}: it failed, ${method} '${target}'`), { code, syscall: method, path: target }));
      }
      return real[method].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  restore = () => {
    table.rm = real.rm;
    table.unlink = real.unlink;
    table.rename = real.rename;
    syncBuiltinESMExports();
  };
  return counted;
}

describe("FileDocumentStore removing a document (0.9.0)", () => {
  it("reads an expired document as missing, also when its files cannot be removed (S8)", async () => {
    const dir = await folder();
    let clock = new Date("2026-06-01T00:00:00Z");
    const store = new FileDocumentStore(dir, { now: () => clock });
    const files = createLargeFiles({ store, now: () => clock, ttlMs: 60_000 });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });
    clock = new Date("2026-06-01T00:02:00Z");

    failRemoval((target) => target.endsWith(`${meta.id}.json`), "EIO");
    expect(await store.getMeta(meta.id)).toBeUndefined();
    expect(await store.get(meta.id)).toBeUndefined();
    expect(await files.getMeta(meta.id)).toBeUndefined();
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 })).missing).toEqual([meta.id]);
    // Still on disk: the sweep tries again.
    expect(await readdir(dir)).toContain(`${meta.id}.json`);
    restore!();
    restore = undefined;
    expect(await files.sweep()).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("is deleted once its metadata is gone, and leaves a part that cannot be removed to the sweep (S9)", async () => {
    const dir = await folder();
    const store = new FileDocumentStore(dir);
    const files = createLargeFiles({ store, keepOriginals: ["text"] });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });

    failRemoval((target) => target.endsWith(`${meta.id}.txt`), "EIO");
    expect(await files.delete(meta.id)).toBe(true);
    restore!();
    restore = undefined;
    expect(await readdir(dir)).toEqual([`${meta.id}.txt`]);
    expect(await files.getMeta(meta.id)).toBeUndefined();
    expect(await files.delete(meta.id)).toBe(false);
    // A file of no document: removed once it is orphanAgeMs old.
    expect(await store.sweep(new Date())).toBe(0);
    expect(await readdir(dir)).toEqual([`${meta.id}.txt`]);
    await store.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(await readdir(dir)).toEqual([]);
  });

  it("tries a removal again while Windows holds the file open for a moment (LLF-027)", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir), keepOriginals: ["text"] });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });

    const metadata = failRemoval((target) => target.endsWith(`${meta.id}.json`), "EBUSY", 2);
    expect(await files.delete(meta.id)).toBe(true);
    expect(metadata.tries).toBe(3);
    restore!();
    const again = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });
    const text = failRemoval((target) => target.endsWith(`${again.id}.txt`), "EPERM", 2);
    expect(await files.delete(again.id)).toBe(true);
    expect(text.tries).toBe(3);
    expect(await readdir(dir)).toEqual([]);
  });

  it("gives up after ten more tries, about 2.6 seconds, and throws with the document whole", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir) });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });
    const before = (await readdir(dir)).sort();
    const store = new FileDocumentStore(dir);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const metadata = failRemoval((target) => target.endsWith(`${meta.id}.json`), "EBUSY");
      const removing = store.delete(meta.id).then(() => undefined, (error: unknown) => error);
      // The pauses between the tries: 2,630 ms in all.
      await vi.advanceTimersByTimeAsync(2_629);
      expect(metadata.tries).toBe(10);
      await vi.advanceTimersByTimeAsync(1);
      expect(await removing).toMatchObject({ code: "EBUSY" });
      expect(metadata.tries).toBe(11);
    } finally {
      vi.useRealTimers();
    }
    restore!();
    restore = undefined;
    expect((await readdir(dir)).sort()).toEqual(before);
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
