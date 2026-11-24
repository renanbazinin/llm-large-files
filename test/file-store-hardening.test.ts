// FileDocumentStore in 0.9.0, after its review: device names refused by the ID pattern itself, scope
// folders made one level at a time, folder checks remembered for a moment, no link followed at a
// file name, and a sweep that counts only the removals it made.
import fsp, { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_DOCUMENT_ID_PATTERN, createLargeFiles, FileDocumentStore, isDocumentId, MemoryDocumentStore,
  type DocumentMeta, type DocumentStore, type StoredDocument,
} from "llm-large-files";
import { utf8 } from "llm-large-files/testing";

const directories: string[] = [];
async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "llf-hardening-"));
  directories.push(directory);
  return directory;
}
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Every file under `directory`, as paths relative to it with "/", sorted. Links are listed, not followed. */
async function tree(directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string, prefix: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(at, entry.name), name);
      else out.push(name);
    }
  };
  await walk(directory, "");
  return out.sort();
}

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-06-01T00:00:00Z");
const now = () => new Date(START);

function metaOf(id: string, text: string, expiresAt: number): DocumentMeta {
  const bytes = utf8(text).length;
  return {
    id, metaVersion: 1, name: `${id}.txt`, mimeType: "text/plain", format: "text", bytes, textBytes: bytes,
    characters: text.length, lines: text.split("\n").length, estimatedTokens: 1, wrappedLines: 0, outline: [],
    createdAt: new Date(START).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  };
}
const documentOf = (id: string, text: string, expiresAt = START + DAY): StoredDocument => ({ meta: metaOf(id, text, expiresAt), text });

type FsTable = Record<"realpath" | "unlink", (...args: unknown[]) => Promise<unknown>>;

/** Replaces a function of `node:fs/promises` for the test, as the store imports it. */
function replace(method: keyof FsTable, make: (real: FsTable[keyof FsTable]) => FsTable[keyof FsTable]): void {
  const table = fsp as unknown as FsTable;
  const real = table[method];
  table[method] = make(real);
  syncBuiltinESMExports();
  restores.push(() => {
    table[method] = real;
    syncBuiltinESMExports();
  });
}

/** Counts the `realpath` calls of the test. */
function countRealpath(): { calls: number } {
  const counted = { calls: 0 };
  replace("realpath", (real) => function (this: unknown, ...args: unknown[]) {
    counted.calls++;
    return real.apply(this, args);
  });
  return counted;
}

/** A store that notes every method called on it. */
function watched<T extends DocumentStore>(store: T): { store: T; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

describe("APP_DOCUMENT_ID_PATTERN and the names Windows keeps for devices", () => {
  const DEVICES = ["con", "prn", "aux", "nul", "com0", "com9", "lpt1", "lpt9"];

  it("does not match a device name, but matches longer names that start with one", () => {
    for (const id of DEVICES) {
      expect(APP_DOCUMENT_ID_PATTERN.test(id), id).toBe(false);
      expect(isDocumentId(id), id).toBe(false);
    }
    for (const id of ["console", "com10", "nul_", "con-1", "auxiliary", "lpt", "com", "a", "upload-3f9a", `doc_${"0".repeat(32)}`]) {
      expect(APP_DOCUMENT_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  it("makes ingest refuse a device name with a TypeError, before any store call, over either built-in store", async () => {
    const root = await folder();
    const stores: Array<[string, DocumentStore]> = [
      ["MemoryDocumentStore", new MemoryDocumentStore({ now })],
      ["FileDocumentStore", new FileDocumentStore(root, { now })],
    ];
    for (const [name, inner] of stores) {
      const { store, calls } = watched(inner);
      const files = createLargeFiles({ store, now });
      for (const id of DEVICES) {
        const error = await files.ingest({ name: "a.txt", bytes: utf8("alpha\n"), id }).catch((thrown: unknown) => thrown);
        expect(error, `${name} ${id}`).toBeInstanceOf(TypeError);
        expect((error as Error).message, `${name} ${id}`).toContain("APP_DOCUMENT_ID_PATTERN");
      }
      expect(calls, name).toEqual([]);
    }
    expect(await readdir(root)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("FileDocumentStore with createScopeFolders and links", () => {
  it("makes a scope's folders one level at a time, and nothing under a link", async () => {
    const root = await folder();
    const outside = await folder();
    await symlink(outside, path.join(root, "u1"));
    await mkdir(path.join(root, "u2"));
    await symlink(outside, path.join(root, "u2", "s1"));
    await writeFile(path.join(root, "u3"), "a file of the application");
    const store = new FileDocumentStore(root, { now, scopes: { depth: 2, createScopeFolders: true } });

    // A link at the first level: nothing is made in the folder it points to.
    await expect(store.put(documentOf("a", "alpha"), { scope: ["u1", "s1"] })).rejects.toMatchObject({ name: "DocumentScopeError", code: "scope_invalid" });
    await expect(store.putIndex("a", utf8("index"), { scope: ["u1", "s2"] })).rejects.toMatchObject({ code: "scope_invalid" });
    await expect(store.putOriginal("a", utf8("upload"), { scope: ["u1", "s3"] })).rejects.toMatchObject({ code: "scope_invalid" });
    // A link at the last level: its target gets no folder of the store.
    await expect(store.put(documentOf("a", "alpha"), { scope: ["u2", "s1"] })).rejects.toMatchObject({ code: "scope_invalid" });
    expect(await readdir(outside)).toEqual([]);

    // A file where a folder should be: refused, and nothing made.
    await expect(store.put(documentOf("a", "alpha"), { scope: ["u3", "s1"] })).rejects.toMatchObject({ code: "scope_missing" });
    expect(await readFile(path.join(root, "u3"), "utf8")).toBe("a file of the application");

    // Without links, the folders are made, each with the store's mode.
    await store.put(documentOf("a", "alpha"), { scope: ["u4", "s1"] });
    expect(await tree(path.join(root, "u4"))).toEqual(["s1/.llm-large-files/a.json", "s1/.llm-large-files/a.txt"]);
    for (const made of ["u4", "u4/s1", "u4/s1/.llm-large-files"]) expect((await fsp.stat(path.join(root, made))).mode & 0o777, made).toBe(0o700);
    expect((await store.get("a", { scope: ["u4", "s1"] }))?.text).toBe("alpha");
  });

  it("makes the directory itself too, when it is not there", async () => {
    const parent = await folder();
    const root = path.join(parent, "documents");
    const store = new FileDocumentStore(root, { now, scopes: { depth: 2, folder: "", createScopeFolders: true } });
    await store.put(documentOf("a", "alpha"), { scope: ["u1", "s1"] });
    expect(await tree(parent)).toEqual(["documents/u1/s1/a.json", "documents/u1/s1/a.txt"]);
  });
});

describe("FileDocumentStore with scopes: the check of a folder, remembered for a moment", () => {
  /** Stops the clock the store times its checks by, so that a slow machine does not end the moment. */
  const stopClock = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  };

  it("checks a folder's real path once for many reads, and again on every write and delete", async () => {
    stopClock();
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const store = new FileDocumentStore(root, { now, scopes: { depth: 2 } });
    const scope = ["u1", "s1"];
    await store.put(documentOf("a", "alpha bravo charlie\n".repeat(50)), { scope });
    await store.putIndex("a", utf8("index"), { scope });
    const counted = countRealpath();
    for (let read = 0; read < 200; read++) {
      expect(await store.readTextRange("a", read, read + 5, { scope })).toBeDefined();
      if (read % 10 === 0) {
        expect(await store.getMeta("a", { scope })).toBeDefined();
        expect(await store.getIndex("a", { scope })).toBeDefined();
      }
    }
    // 260 reads; before 0.9.0's review, one realpath each. The put checked the folder.
    expect(counted.calls).toBe(0);

    for (const write of [
      () => store.put(documentOf("b", "bravo"), { scope }),
      () => store.putIndex("b", utf8("index"), { scope }),
      () => store.putOriginal("b", utf8("upload"), { scope }),
      () => store.delete("b", { scope }),
      () => store.sweep(new Date(START), { scope }),
    ]) {
      const before = counted.calls;
      await write();
      expect(counted.calls).toBeGreaterThan(before);
    }
  });

  it("checks again after a read finds no file", async () => {
    stopClock();
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const store = new FileDocumentStore(root, { now, scopes: { depth: 2 } });
    const scope = ["u1", "s1"];
    await store.put(documentOf("a", "alpha"), { scope });
    const counted = countRealpath();
    await store.getMeta("a", { scope });
    expect(counted.calls).toBe(0);
    expect(await store.getMeta("unknown", { scope })).toBeUndefined();
    const before = counted.calls;
    expect(await store.getMeta("a", { scope })).toBeDefined();
    expect(counted.calls).toBe(before + 1);
  });

  it("refuses a folder swapped for a link: at once on a write or a delete, and on a read once the moment has passed", async () => {
    if (process.platform === "win32") return;
    stopClock();
    const root = await folder();
    const outside = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    await mkdir(path.join(outside, ".llm-large-files"));
    await writeFile(path.join(outside, ".llm-large-files", "x.json"), JSON.stringify(metaOf("x", "theirs", START - DAY)));
    await writeFile(path.join(outside, ".llm-large-files", "x.txt"), "theirs");
    const store = new FileDocumentStore(root, { now, scopes: { depth: 2 } });
    const scope = ["u1", "s1"];
    await store.put(documentOf("a", "alpha"), { scope });
    expect(await store.getMeta("a", { scope })).toBeDefined();

    await rm(path.join(root, "u1", "s1"), { recursive: true });
    await symlink(outside, path.join(root, "u1", "s1"));
    // First a read while the check is still remembered: the expired document it finds through the
    // link is not removed, because a removal checks the folder again.
    const remembered = await store.getMeta("x", { scope }).catch((error: unknown) => error);
    expect(remembered === undefined || (remembered as { code?: string }).code === "scope_invalid").toBe(true);
    expect(await tree(outside)).toEqual([".llm-large-files/x.json", ".llm-large-files/x.txt"]);
    await expect(store.put(documentOf("b", "bravo"), { scope })).rejects.toMatchObject({ code: "scope_invalid" });
    await expect(store.delete("x", { scope })).rejects.toMatchObject({ code: "scope_invalid" });
    await expect(store.sweep(new Date(START), { scope })).rejects.toMatchObject({ code: "scope_invalid" });
    // An expired document found through the link is not removed, even while the check is remembered.
    const read = await store.getMeta("x", { scope }).catch((error: unknown) => error);
    expect(read === undefined || (read as { code?: string }).code === "scope_invalid").toBe(true);
    expect(await tree(outside)).toEqual([".llm-large-files/x.json", ".llm-large-files/x.txt"]);

    vi.setSystemTime(START + 1_500);
    await expect(store.getMeta("x", { scope })).rejects.toMatchObject({ code: "scope_invalid" });
    await expect(store.readTextRange("x", 0, 3, { scope })).rejects.toMatchObject({ code: "scope_invalid" });
    expect(await tree(outside)).toEqual([".llm-large-files/x.json", ".llm-large-files/x.txt"]);
  });

  it("remembers a few thousand folders at most", async () => {
    stopClock();
    const root = await folder();
    const store = new FileDocumentStore(root, { now, scopes: { depth: 1, folder: "" } });
    const meta = JSON.stringify(metaOf("a", "alpha", START + DAY));
    /** Runs `task` for every chat, 100 chats at a time, in order of the batches. */
    const everyChat = async (task: (chat: number) => Promise<unknown>) => {
      for (let first = 0; first < 5_000; first += 100) await Promise.all(Array.from({ length: 100 }, (_, offset) => task(first + offset)));
    };
    await everyChat(async (chat) => {
      await mkdir(path.join(root, `c${chat}`));
      await writeFile(path.join(root, `c${chat}`, "a.json"), meta);
    });
    await everyChat(async (chat) => expect(await store.getMeta("a", { scope: [`c${chat}`] })).toBeDefined());
    const counted = countRealpath();
    // The first folders were forgotten: their reads check again.
    for (let chat = 0; chat < 10; chat++) expect(await store.getMeta("a", { scope: [`c${chat}`] })).toBeDefined();
    expect(counted.calls).toBe(10);
    // The last are remembered.
    const before = counted.calls;
    for (let chat = 4_990; chat < 5_000; chat++) expect(await store.getMeta("a", { scope: [`c${chat}`] })).toBeDefined();
    expect(counted.calls).toBe(before);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("FileDocumentStore and a link at a file name", () => {
  async function linked(scoped: boolean) {
    const root = await folder();
    const outside = await folder();
    const scope = scoped ? ["u1", "s1"] : undefined;
    if (scoped) await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const store = new FileDocumentStore(root, { now, ...(scoped ? { scopes: { depth: 2 } } : {}) });
    const context = scope ? { scope } : undefined;
    const files = scoped ? path.join(root, "u1", "s1", ".llm-large-files") : root;
    await writeFile(path.join(outside, "secret.txt"), "the secret of another app");
    await writeFile(path.join(outside, "secret.json"), JSON.stringify(metaOf("b", "the secret of another app", START + DAY)));
    for (const id of ["a", "c"]) {
      await store.put(documentOf(id, "alpha"), context);
      await store.putIndex(id, utf8("index"), context);
      await store.putOriginal(id, utf8("upload"), context);
    }
    // a: its text, index and original are links out of the store. b: its metadata is one too.
    for (const extension of ["txt", "idx", "bin"]) {
      await unlink(path.join(files, `a.${extension}`));
      await symlink(path.join(outside, "secret.txt"), path.join(files, `a.${extension}`));
    }
    await symlink(path.join(outside, "secret.json"), path.join(files, "b.json"));
    await symlink(path.join(outside, "secret.txt"), path.join(files, "b.txt"));
    // c: a link inside the folder, to a's metadata.
    await unlink(path.join(files, "c.json"));
    await symlink(path.join(files, "a.json"), path.join(files, "c.json"));
    return { store, context, outside };
  }

  for (const scoped of [false, true]) {
    it(`is not followed${scoped ? ", with scopes" : ""}: the document's file counts as missing`, async () => {
      const { store, context, outside } = await linked(scoped);
      expect(await store.getMeta("a", context)).toBeDefined();
      expect(await store.get("a", context)).toBeUndefined();
      expect(await store.readTextRange("a", 0, 10, context)).toBeUndefined();
      expect(await store.getIndex("a", context)).toBeUndefined();
      expect(await store.getOriginal("a", context)).toBeUndefined();
      expect(await store.getMeta("b", context)).toBeUndefined();
      expect(await store.get("b", context)).toBeUndefined();
      expect(await store.getMeta("c", context)).toBeUndefined();
      // A delete removes the links, not what they point to.
      expect(await store.delete("a", context)).toBe(true);
      expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("the secret of another app");
    });
  }
});

describe("FileDocumentStore.sweep counts a document once", () => {
  it("counts no document whose metadata another sweep removed first", async () => {
    const root = await folder();
    const store = new FileDocumentStore(root, { now });
    await store.put(documentOf("a", "alpha", START - DAY));
    // Another server's sweep removes the metadata just before this one does.
    replace("unlink", (real) => async function (this: unknown, ...args: unknown[]) {
      if (String(args[0]).endsWith(`${path.sep}a.json`)) await real.apply(this, args);
      return real.apply(this, args);
    });
    expect(await store.sweep(new Date(START))).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  // Not on Windows: two processes that unlink one file at the same moment can both succeed there
  // (the file goes when the last handle closes), and a Windows runner counted 26 of 25.
  it.skipIf(process.platform === "win32")("gives two sweeps of one volume at once a total of the documents removed", async () => {
    const root = await folder();
    const writer = new FileDocumentStore(root, { now, scopes: { depth: 2, createScopeFolders: true } });
    for (let chat = 0; chat < 25; chat++) await writer.put(documentOf("a", "alpha", START - DAY), { scope: ["u1", `s${chat}`] });
    const sweeps = [new FileDocumentStore(root, { now, scopes: { depth: 2 } }), new FileDocumentStore(root, { now, scopes: { depth: 2 } })];
    const counts = await Promise.all(sweeps.map((store) => store.sweep(new Date(START))));
    expect(counts[0]! + counts[1]!).toBe(25);
    expect(await tree(root)).toEqual([]);
  });
});
