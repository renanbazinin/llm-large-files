// NEW-removal-claim (0.10.0, found by 0.9.0's CI on Windows): FileDocumentStore removes a
// document's metadata by renaming it to a name of its own (`<id>.json.<8 hex>.tmp`), then removing
// that name, and counts the removal as its own only when that succeeds. On Windows two unlinks of
// one file at the same moment can both succeed, so two sweeps counted 26 of 25, and two deletes
// both said true. Here an unlink that also succeeds for a file already gone stands for that.
import fsp, { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, type DocumentMeta } from "llm-large-files";
import { utf8 } from "llm-large-files/testing";

const directories: string[] = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "llf-claim-"));
  directories.push(directory);
  return directory;
}

type Table = Record<"unlink" | "rename", (...args: unknown[]) => Promise<unknown>>;

/** Replaces a function of `node:fs/promises` for the test, as the store imports it. */
function replace(method: keyof Table, make: (real: Table[keyof Table]) => Table[keyof Table]): void {
  const table = fsp as unknown as Table;
  const real = table[method];
  table[method] = make(real);
  syncBuiltinESMExports();
  restores.push(() => {
    table[method] = real;
    syncBuiltinESMExports();
  });
}

/** As on Windows, two unlinks of one file at once both succeed: an unlink of a file already gone is told it worked. */
function unlinkAsWindows(): void {
  replace("unlink", (real) => async function (this: unknown, ...args: unknown[]) {
    try {
      return await real.apply(this, args);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
  });
}

const DAY = 24 * 60 * 60 * 1000;
function metaOf(id: string, expiresAt: number): DocumentMeta {
  return {
    id, metaVersion: 1, name: `${id}.txt`, mimeType: "text/plain", format: "text", bytes: 5, textBytes: 5, characters: 5, lines: 1,
    estimatedTokens: 1, wrappedLines: 0, outline: [], createdAt: new Date(expiresAt - DAY).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  };
}

describe("FileDocumentStore claims a removal before it counts it", () => {
  it("gives true to one of two deletes of one document at once, where unlinks both succeed", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    await store.put({ meta: metaOf("a", Date.now() + DAY), text: "alpha" });
    unlinkAsWindows();
    const results = await Promise.all([store.delete("a"), store.delete("a")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("gives two sweeps at once a total of the documents removed, where unlinks both succeed", async () => {
    const directory = await folder();
    const now = Date.now();
    const writer = new FileDocumentStore(directory);
    for (let index = 0; index < 25; index++) await writer.put({ meta: metaOf(`d${index}`, now - DAY), text: "alpha" });
    unlinkAsWindows();
    const counts = await Promise.all([new FileDocumentStore(directory).sweep(new Date(now)), new FileDocumentStore(directory).sweep(new Date(now))]);
    expect(counts[0]! + counts[1]!).toBe(25);
    expect(await readdir(directory)).toEqual([]);
  });

  it("renames the metadata to a temporary name of its own, then removes that name", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    await store.put({ meta: metaOf("a", Date.now() + DAY), text: "alpha" });
    const renames: Array<[string, string]> = [];
    const unlinks: string[] = [];
    replace("rename", (real) => function (this: unknown, ...args: unknown[]) {
      renames.push([path.basename(String(args[0])), path.basename(String(args[1]))]);
      return real.apply(this, args);
    });
    replace("unlink", (real) => function (this: unknown, ...args: unknown[]) {
      unlinks.push(path.basename(String(args[0])));
      return real.apply(this, args);
    });
    expect(await store.delete("a")).toBe(true);
    expect(renames).toHaveLength(1);
    expect(renames[0]![0]).toBe("a.json");
    expect(renames[0]![1]).toMatch(/^a\.json\.[a-f0-9]{8}\.tmp$/);
    expect(unlinks[0]).toBe(renames[0]![1]);
    expect(unlinks).not.toContain("a.json");
    expect(await store.delete("a")).toBe(false);
  });

  it("counts a removal whose own name cannot be removed now: the document is gone, and the sweep removes the name once it is old", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8("one\ntwo\n") });
    replace("unlink", (real) => function (this: unknown, ...args: unknown[]) {
      if (/\.json\.[a-f0-9]{8}\.tmp$/.test(String(args[0]))) return Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO", syscall: "unlink" }));
      return real.apply(this, args);
    });
    expect(await files.delete(meta.id)).toBe(true);
    restores.pop()!();
    const left = await readdir(directory);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(new RegExp(`^${meta.id}\\.json\\.[a-f0-9]{8}\\.tmp$`));
    expect(await files.getMeta(meta.id)).toBeUndefined();
    expect(await files.delete(meta.id)).toBe(false);
    // A temporary file: removed by a sweep once it is orphanAgeMs old, and not counted.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(directory, left[0]!), old, old);
    expect(await store.sweep(new Date())).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
