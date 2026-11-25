// FileDocumentStore with `scopes` (new in 0.9.0): a folder per scope, such as
// <root>/<userId>/<chatId>/.llm-large-files/, and the rules that keep it inside the root.
import fsp, { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLargeFiles, DocumentScopeError, FileDocumentStore, hashedScopeSegment, isSafeScopeSegment,
  type DocumentMeta, type DocumentStore, type StoredDocument,
} from "llm-large-files";
import { utf8 } from "llm-large-files/testing";

const directories: string[] = [];
async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "llf-scopes-"));
  directories.push(directory);
  return directory;
}
let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  restore = undefined;
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

/** Metadata for a document written to a store directly. */
function metaOf(id: string, text: string, expiresAt: number, scope?: string[]): DocumentMeta {
  const bytes = utf8(text).length;
  return {
    id, metaVersion: 1, ...(scope ? { scope } : {}), name: `${id}.txt`, mimeType: "text/plain", format: "text", bytes, textBytes: bytes,
    characters: text.length, lines: text.split("\n").length, estimatedTokens: 1, wrappedLines: 0, outline: [],
    createdAt: new Date(START).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  };
}
const documentOf = (id: string, text: string, expiresAt: number, scope?: string[]): StoredDocument => ({ meta: metaOf(id, text, expiresAt, scope), text });
/** The clock of the stores that hold documents written with `documentOf`. */
const now = () => new Date(START);

/** Notes the folder of every `readdir` call. */
function watchListings(): string[] {
  const table = fsp as unknown as { readdir: (...args: unknown[]) => Promise<unknown> };
  const real = table.readdir;
  const listed: string[] = [];
  table.readdir = function (this: unknown, ...args: unknown[]) {
    listed.push(String(args[0]));
    return real.apply(this, args);
  };
  syncBuiltinESMExports();
  restore = () => {
    table.readdir = real;
    syncBuiltinESMExports();
  };
  return listed;
}

describe("FileDocumentStore with scopes: the layout", () => {
  it("keeps each scope's documents in <root>/<scope...>/.llm-large-files/, under the application's ID", async () => {
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    await mkdir(path.join(root, "u1", "s2"), { recursive: true });
    const store = new FileDocumentStore(root, { scopes: { depth: 2 } });
    const files = createLargeFiles({ store, requireOwner: true, requireScope: true, keepOriginals: ["text"] });
    const first = await files.ingest({ name: "notes.txt", bytes: utf8("alpha\nbravo\n"), owner: "u1", scope: ["u1", "s1"], id: "upload-1" });
    const second = await files.ingest({ name: "notes.txt", bytes: utf8("charlie\n"), owner: "u1", scope: ["u1", "s2"], id: "upload-1" });
    expect(first.id).toBe("upload-1");
    expect(second.id).toBe("upload-1");
    expect(await tree(root)).toEqual([
      "u1/s1/.llm-large-files/upload-1.bin", "u1/s1/.llm-large-files/upload-1.idx", "u1/s1/.llm-large-files/upload-1.json", "u1/s1/.llm-large-files/upload-1.txt",
      "u1/s2/.llm-large-files/upload-1.bin", "u1/s2/.llm-large-files/upload-1.idx", "u1/s2/.llm-large-files/upload-1.json", "u1/s2/.llm-large-files/upload-1.txt",
    ]);
    // One ID in two chats: two documents, each read in its own chat only.
    expect((await files.prepare(["upload-1"], { tokens: 0, bytes: 0 }, { owner: "u1", scope: ["u1", "s1"] })).blocks.get("upload-1")).toContain("bravo");
    expect((await files.prepare(["upload-1"], { tokens: 0, bytes: 0 }, { owner: "u1", scope: ["u1", "s2"] })).blocks.get("upload-1")).toContain("charlie");
    expect(await files.getOriginal("upload-1", { owner: "u1", scope: ["u1", "s2"] })).toEqual(utf8("charlie\n"));
    expect(await files.delete("upload-1", { owner: "u1", scope: ["u1", "s1"] })).toBe(true);
    expect(await tree(path.join(root, "u1", "s1"))).toEqual([]);
    expect(await files.getMeta("upload-1", { owner: "u1", scope: ["u1", "s2"] })).toMatchObject({ scope: ["u1", "s2"] });
  });

  it("puts the files in the scope's folder itself with folder '', beside the application's", async () => {
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1", "uploads"), { recursive: true });
    await writeFile(path.join(root, "u1", "s1", "uploads", "upload-1"), "the upload");
    const store = new FileDocumentStore(root, { scopes: { depth: 2, folder: "" } });
    await store.put(documentOf("upload-1", "text", START + DAY), { scope: ["u1", "s1"] });
    expect(await tree(root)).toEqual(["u1/s1/upload-1.json", "u1/s1/upload-1.txt", "u1/s1/uploads/upload-1"]);
  });

  it("makes the folders of a scope only with createScopeFolders", async () => {
    const root = await folder();
    const strict = new FileDocumentStore(root, { scopes: { depth: 2 } });
    await expect(strict.put(documentOf("a", "text", START + DAY), { scope: ["u1", "s1"] })).rejects.toMatchObject({ name: "DocumentScopeError", code: "scope_missing" });
    expect(await readdir(root)).toEqual([]);
    const making = new FileDocumentStore(path.join(root, "volume"), { scopes: { depth: 2, createScopeFolders: true } });
    await making.put(documentOf("a", "text", START + DAY), { scope: ["u1", "s1"] });
    expect(await tree(root)).toEqual(["volume/u1/s1/.llm-large-files/a.json", "volume/u1/s1/.llm-large-files/a.txt"]);
  });

  it("refuses a call without a scope, or uses the root for it with unscoped 'root'", async () => {
    const root = await folder();
    const flat = new FileDocumentStore(root, { now });
    await flat.put(documentOf("doc_0123456789abcdef0123456789abcdef", "written by 0.8", START + DAY));

    const strict = new FileDocumentStore(root, { scopes: { depth: 2 } });
    for (const call of [
      () => strict.getMeta("doc_0123456789abcdef0123456789abcdef"),
      () => strict.get("doc_0123456789abcdef0123456789abcdef", {}),
      () => strict.put(documentOf("a", "x", START + DAY), { owner: "u1" }),
      () => strict.delete("doc_0123456789abcdef0123456789abcdef"),
      () => strict.readTextRange("doc_0123456789abcdef0123456789abcdef", 0, 4),
    ]) {
      await expect(call()).rejects.toMatchObject({ name: "DocumentScopeError", code: "scope_required" });
    }

    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const migrating = new FileDocumentStore(root, { scopes: { depth: 2, unscoped: "root" }, now });
    expect((await migrating.get("doc_0123456789abcdef0123456789abcdef"))?.text).toBe("written by 0.8");
    await migrating.put(documentOf("b", "unscoped", START + DAY));
    await migrating.put(documentOf("b", "scoped", START + DAY), { scope: ["u1", "s1"] });
    expect((await migrating.get("b"))?.text).toBe("unscoped");
    expect((await migrating.get("b", { scope: ["u1", "s1"] }))?.text).toBe("scoped");
    // A server of 0.8 still reads what was written there.
    expect((await flat.get("b"))?.text).toBe("unscoped");
  });

  it("keeps the files of the flat layout, and its names, when there are no scopes; a scope is then only an access rule", async () => {
    const root = await folder();
    const store = new FileDocumentStore(root);
    const files = createLargeFiles({ requireOwner: false, store });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha\n"), scope: ["U1", "Chat 7"] });
    expect(await tree(root)).toEqual([`${meta.id}.idx`, `${meta.id}.json`, `${meta.id}.txt`]);
    expect(await files.getMeta(meta.id, { scope: ["U1", "Chat 7"] })).toBeDefined();
    expect(await files.getMeta(meta.id, { scope: ["U1", "Chat 8"] })).toBeUndefined();
  });
});

describe("FileDocumentStore with scopes: what it refuses", () => {
  it("refuses a scope of the wrong depth, or a segment that cannot name a folder, and never names the segment", async () => {
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const store = new FileDocumentStore(root, { scopes: { depth: 2, createScopeFolders: true } });
    const document = documentOf("a", "text", START + DAY);
    for (const scope of [["u1"], ["u1", "s1", "x"], ["Alice", "s1"], ["u1", "con"], ["u1", "CON"], ["u1", "lpt9"], ["u1", "-s1"], ["u1", "s.1"], ["u1", "שיחה"], ["u1", "x".repeat(65)]]) {
      for (const call of [() => store.put(document, { scope }), () => store.getMeta("a", { scope }), () => store.delete("a", { scope }), () => store.sweep(new Date(), { scope })]) {
        const thrown = await call().then(() => undefined, (error: unknown) => error);
        expect(DocumentScopeError.is(thrown), JSON.stringify(scope)).toBe(true);
        expect(thrown).toMatchObject({ code: "scope_invalid" });
        for (const segment of scope) if (segment !== "u1" && segment.length > 1) expect((thrown as Error).message).not.toContain(segment);
      }
    }
    // ".." and "/" are refused before any path is made: scope_invalid too.
    await expect(store.getMeta("a", { scope: ["u1", ".."] })).rejects.toMatchObject({ code: "scope_invalid" });
    await expect(store.put(document, { scope: ["..", ".."] })).rejects.toMatchObject({ code: "scope_invalid" });
    expect(await tree(root)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("follows no link: a scope folder that is a link, inside the root or out of it, is refused", async () => {
    const root = await folder();
    const outside = await folder();
    await mkdir(path.join(root, "u1", "s1", ".llm-large-files"), { recursive: true });
    await mkdir(path.join(root, "u2"), { recursive: true });
    await mkdir(path.join(outside, ".llm-large-files"), { recursive: true });
    await writeFile(path.join(outside, ".llm-large-files", "a.json"), JSON.stringify(metaOf("a", "secret", START + DAY)));
    await writeFile(path.join(outside, ".llm-large-files", "a.txt"), "secret");
    await symlink(outside, path.join(root, "u2", "s1"));
    await symlink(path.join(root, "u1", "s1"), path.join(root, "u2", "s2"));
    await mkdir(path.join(outside, "s1", ".llm-large-files"), { recursive: true });
    await symlink(outside, path.join(root, "u3"));
    const store = new FileDocumentStore(root, { scopes: { depth: 2 } });
    for (const scope of [["u2", "s1"], ["u2", "s2"], ["u3", "s1"]]) {
      await expect(store.getMeta("a", { scope })).rejects.toMatchObject({ name: "DocumentScopeError", code: "scope_invalid" });
      await expect(store.put(documentOf("b", "x", START + DAY), { scope })).rejects.toMatchObject({ code: "scope_invalid" });
      await expect(store.delete("a", { scope })).rejects.toMatchObject({ code: "scope_invalid" });
    }
    expect(await tree(outside)).toEqual([".llm-large-files/a.json", ".llm-large-files/a.txt"]);
    expect(await tree(path.join(root, "u1"))).toEqual([]);
    // Under a link to a place where the scope has no folder, there is nothing to read, and nothing is written.
    expect(await store.getMeta("a", { scope: ["u3", "s2"] })).toBeUndefined();
    await expect(store.put(documentOf("b", "x", START + DAY), { scope: ["u3", "s2"] })).rejects.toMatchObject({ code: "scope_missing" });
    expect(await tree(outside)).toEqual([".llm-large-files/a.json", ".llm-large-files/a.txt"]);
    // Its own folder in a scope's folder is checked as well.
    await mkdir(path.join(root, "u4", "s1"), { recursive: true });
    await symlink(path.join(outside, ".llm-large-files"), path.join(root, "u4", "s1", ".llm-large-files"));
    await expect(store.get("a", { scope: ["u4", "s1"] })).rejects.toMatchObject({ code: "scope_invalid" });
  });

  it("throws scope_missing for a write into a chat whose folder was removed, and does not make it again; reads find nothing", async () => {
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const store = new FileDocumentStore(root, { scopes: { depth: 2 } });
    const files = createLargeFiles({ requireOwner: false, store, keepOriginals: ["text"] });
    const scope = ["u1", "s1"];
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha\n"), scope, id: "upload-1" });

    // The application deletes the chat: its folder goes, uploads and all.
    await rm(path.join(root, "u1", "s1"), { recursive: true, force: true });
    const late = await files.ingest({ name: "b.txt", bytes: utf8("bravo\n"), scope, id: "upload-2" }).catch((error: unknown) => error);
    expect(DocumentScopeError.is(late)).toBe(true);
    expect(late).toMatchObject({ code: "scope_missing", message: "The scope no longer exists." });
    expect(await tree(root)).toEqual([]);
    expect(await readdir(path.join(root, "u1"))).toEqual([]);

    expect(await files.getMeta(meta.id, { scope })).toBeUndefined();
    expect(await files.getOriginal(meta.id, { scope })).toBeUndefined();
    expect((await files.prepare([meta.id], { tokens: 0, bytes: 0 }, { scope })).missing).toEqual([meta.id]);
    expect(await files.delete(meta.id, { scope })).toBe(false);
    expect(await files.sweep({ scope })).toBe(0);
    expect(await store.readTextRange(meta.id, 0, 3, { scope })).toBeUndefined();
    expect(await store.getIndex(meta.id, { scope })).toBeUndefined();
  });

  it("throws, loudly, under a wrapper that passes on only the ID", async () => {
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const inner = new FileDocumentStore(root, { scopes: { depth: 2 } });
    class ForwardsTheIdOnly implements DocumentStore {
      put(document: StoredDocument) {
        return inner.put(document);
      }
      get(id: string) {
        return inner.get(id);
      }
      getMeta(id: string) {
        return inner.getMeta(id);
      }
      delete(id: string) {
        return inner.delete(id);
      }
    }
    const files = createLargeFiles({ requireOwner: false, store: new ForwardsTheIdOnly() });
    await expect(files.ingest({ name: "a.txt", bytes: utf8("alpha\n"), scope: ["u1", "s1"] })).rejects.toMatchObject({ name: "DocumentScopeError", code: "scope_required" });
    await expect(files.getMeta("upload-1", { scope: ["u1", "s1"] })).rejects.toMatchObject({ code: "scope_required" });
  });

  it("checks its options", () => {
    const bad: Array<ConstructorParameters<typeof FileDocumentStore>[1]> = [
      { scopes: { depth: 0 } }, { scopes: { depth: 9 } }, { scopes: { depth: 1.5 } },
      { scopes: { depth: 2, folder: "a/b" } }, { scopes: { depth: 2, folder: ".." } }, { scopes: { depth: 2, folder: "." } },
      { scopes: { depth: 2, unscoped: "open" as "root" } },
      { fileMode: 0o1000 }, { fileMode: -1 }, { directoryMode: 1.5 }, { sweepConcurrency: 0 }, { sweepConcurrency: Number.NaN },
    ];
    for (const options of bad) expect(() => new FileDocumentStore("/tmp/x", options), JSON.stringify(options)).toThrow(TypeError);
    expect(() => new FileDocumentStore("/tmp/x", { scopes: { depth: 8, folder: "", unscoped: "root", createScopeFolders: true }, fileMode: 0o640, directoryMode: 0o750, sweepConcurrency: 1 })).not.toThrow();
  });
});

describe("isSafeScopeSegment and hashedScopeSegment", () => {
  it("accepts lowercase IDs only, and no device names", () => {
    for (const ok of ["u1", "user-42", "a", "0", "x".repeat(64), "64f1c0de0123456789abcdef", "3f2b8c9e-1d4a-4b6f-9e2a-0c5d7f1a2b3c", "console", "com10", "nul_"]) expect(isSafeScopeSegment(ok), ok).toBe(true);
    for (const bad of ["", "Alice", "-a", "_a", "a.b", "a/b", "..", "x".repeat(65), "con", "prn", "aux", "nul", "com0", "com9", "lpt1", "שלום", " a", undefined as unknown as string]) expect(isSafeScopeSegment(bad), String(bad)).toBe(false);
  });

  it("hashes any value to a safe segment, the same each time", () => {
    const hashed = hashedScopeSegment("Alice@Example.com");
    expect(hashed).toMatch(/^h[a-f0-9]{40}$/);
    expect(isSafeScopeSegment(hashed)).toBe(true);
    expect(hashedScopeSegment("Alice@Example.com")).toBe(hashed);
    expect(hashedScopeSegment("alice@example.com")).not.toBe(hashed);
    expect(isSafeScopeSegment(hashedScopeSegment("משתמש 7"))).toBe(true);
    expect(() => hashedScopeSegment("")).toThrow(TypeError);
  });
});

describe("FileDocumentStore and the application's IDs", () => {
  it("names files after an application's ID in the flat layout too, and leaves made IDs as they were", async () => {
    const root = await folder();
    const files = createLargeFiles({ requireOwner: false, store: new FileDocumentStore(root) });
    const chosen = await files.ingest({ name: "a.txt", bytes: utf8("alpha\n"), id: "upload-3f9a" });
    const made = await files.ingest({ name: "b.txt", bytes: utf8("bravo\n") });
    expect(chosen.id).toBe("upload-3f9a");
    expect(made.id).toMatch(/^doc_[a-f0-9]{32}$/);
    expect(await tree(root)).toEqual([`${made.id}.idx`, `${made.id}.json`, `${made.id}.txt`, "upload-3f9a.idx", "upload-3f9a.json", "upload-3f9a.txt"]);
    expect((await files.prepare(["upload-3f9a"], { tokens: 0, bytes: 0 })).blocks.get("upload-3f9a")).toContain("alpha");
    expect(await files.delete("upload-3f9a")).toBe(true);
  });

  it("refuses an ID that Windows takes for a device", async () => {
    const root = await folder();
    const store = new FileDocumentStore(root);
    for (const id of ["con", "nul", "com1", "lpt0"]) {
      await expect(store.put(documentOf(id, "x", START + DAY))).rejects.toThrow("Invalid document ID.");
      expect(await store.getMeta(id)).toBeUndefined();
      expect(await store.delete(id)).toBe(false);
    }
    expect(await readdir(root)).toEqual([]);
  });
});

describe("FileDocumentStore with scopes: sweep", () => {
  /** 3 users with 4 chats each, an expired and a live document in each chat, and things the sweep must not enter. */
  async function volume(): Promise<{ root: string; store: FileDocumentStore; outside: string }> {
    const root = await folder();
    const outside = await folder();
    const store = new FileDocumentStore(root, { scopes: { depth: 2 }, now: () => new Date(START) });
    for (const user of ["u1", "u2", "u3"]) {
      for (const chat of ["s1", "s2", "s3", "s4"]) {
        const scope = [user, chat];
        await mkdir(path.join(root, user, chat, "uploads", ".llm-large-files"), { recursive: true });
        await store.put(documentOf("expired", "old", START - 1_000, scope), { scope });
        await store.put(documentOf("live", "new", START + DAY, scope), { scope });
        // The application's uploads, at depth 3, with what looks like an expired document in them.
        await writeFile(path.join(root, user, chat, "uploads", ".llm-large-files", "expired.json"), JSON.stringify(metaOf("expired", "x", START - 1_000)));
        await writeFile(path.join(root, user, chat, "uploads", "expired.json"), JSON.stringify(metaOf("expired", "x", START - 1_000)));
      }
    }
    // Expired documents where the sweep must not go: behind links, and in folders a scope cannot name.
    await mkdir(path.join(outside, "s1", ".llm-large-files"), { recursive: true });
    await writeFile(path.join(outside, "s1", ".llm-large-files", "expired.json"), JSON.stringify(metaOf("expired", "x", START - 1_000)));
    await writeFile(path.join(outside, "s1", ".llm-large-files", "expired.txt"), "x");
    if (process.platform !== "win32") {
      await symlink(outside, path.join(root, "u9"));
      await symlink(path.join(outside, "s1"), path.join(root, "u1", "s9"));
    }
    for (const hidden of [".cache", "Users"]) {
      await mkdir(path.join(root, hidden, "s1", ".llm-large-files"), { recursive: true });
      await writeFile(path.join(root, hidden, "s1", ".llm-large-files", "expired.json"), JSON.stringify(metaOf("expired", "x", START - 1_000)));
    }
    return { root, store, outside };
  }

  it("walks exactly depth levels, into folders a scope can name, following no link, and removes the expired documents of every chat", async () => {
    const { root, store, outside } = await volume();
    const before = await tree(root);
    const listed = watchListings();
    expect(await store.sweep()).toBe(12);
    restore!();
    restore = undefined;
    // Only the root, the users and the store's folders were listed: never uploads, a link or a hidden folder.
    const relative = listed.map((entry) => path.relative(root, entry).split(path.sep).join("/")).sort();
    const users = ["u1", "u2", "u3"];
    const chats = users.flatMap((user) => ["s1", "s2", "s3", "s4"].map((chat) => `${user}/${chat}/.llm-large-files`));
    expect(relative).toEqual(["", ...users, ...chats].sort());
    expect(await tree(root)).toEqual(before.filter((file) => !/^u\d\/s\d\/\.llm-large-files\/expired\./.test(file)));
    expect(await tree(outside)).toEqual(["s1/.llm-large-files/expired.json", "s1/.llm-large-files/expired.txt"]);
    // `{}` is every scope too, as files.sweep() passes it.
    expect(await store.sweep(new Date(START + 2 * DAY), {})).toBe(12);
  });

  it("sweeps the folder of one chat with a scope", async () => {
    const { root, store } = await volume();
    const listed = watchListings();
    expect(await store.sweep(new Date(START), { scope: ["u2", "s3"] })).toBe(1);
    restore!();
    restore = undefined;
    expect(listed).toEqual([path.join(root, "u2", "s3", ".llm-large-files")]);
    expect(await readdir(path.join(root, "u2", "s3", ".llm-large-files"))).toEqual(["live.json", "live.txt"]);
    expect(await readdir(path.join(root, "u2", "s4", ".llm-large-files"))).toContain("expired.json");
    expect(await store.sweep(new Date(START), { scope: ["u2", "s9"] })).toBe(0);
  });

  it("also sweeps the root with unscoped 'root'", async () => {
    const root = await folder();
    await mkdir(path.join(root, "u1", "s1"), { recursive: true });
    const store = new FileDocumentStore(root, { scopes: { depth: 2, unscoped: "root" } });
    await store.put(documentOf("old-flat", "x", START - 1_000));
    await store.put(documentOf("old-scoped", "x", START - 1_000, ["u1", "s1"]), { scope: ["u1", "s1"] });
    expect(await store.sweep(new Date(START))).toBe(2);
    expect(await tree(root)).toEqual([]);
  });

  it("removes old leftovers of any ID in its own folder, but only those of made IDs where the application keeps files too", async () => {
    const root = await folder();
    for (const chat of ["s1", "s2"]) await mkdir(path.join(root, "u1", chat), { recursive: true });
    const own = new FileDocumentStore(root, { scopes: { depth: 2 } });
    const shared = new FileDocumentStore(root, { scopes: { depth: 2, folder: "" } });
    // The sweeps below run at the time of the file system, for the age of the leftovers.
    await own.put(documentOf("live", "x", Date.now() + DAY), { scope: ["u1", "s1"] });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const leave = async (file: string) => {
      await writeFile(file, "x");
      await utimes(file, old, old);
    };
    // Left by a delete that could not remove the text of "upload-1", in the store's own folder.
    await leave(path.join(root, "u1", "s1", ".llm-large-files", "upload-1.txt"));
    await leave(path.join(root, "u1", "s1", ".llm-large-files", "live.txt.0123abcd.tmp"));
    // In a chat folder the application shares with the store: "notes.txt" is the application's.
    await leave(path.join(root, "u1", "s2", "notes.txt"));
    await leave(path.join(root, "u1", "s2", "notes.json"));
    await leave(path.join(root, "u1", "s2", `doc_${"5".repeat(32)}.txt`));
    await leave(path.join(root, "u1", "s2", "upload-2.bin.89abcdef.tmp"));
    expect(await own.sweep(new Date())).toBe(0);
    expect(await shared.sweep(new Date())).toBe(0);
    expect(await tree(root)).toEqual(["u1/s1/.llm-large-files/live.json", "u1/s1/.llm-large-files/live.txt", "u1/s2/notes.json", "u1/s2/notes.txt"]);
    // Its own documents are swept there all the same, by their metadata.
    await shared.put(documentOf("upload-3", "x", START - 1_000), { scope: ["u1", "s2"] });
    expect(await shared.sweep(new Date(START), { scope: ["u1", "s2"] })).toBe(1);
    expect(await readdir(path.join(root, "u1", "s2"))).toEqual(["notes.json", "notes.txt"].sort());
  });
});

describe("one library over a scoped FileDocumentStore", () => {
  it("serves every user and chat, with an owner and a scope required on every call", async () => {
    const root = await folder();
    const store = new FileDocumentStore(root, { scopes: { depth: 2 } });
    const files = createLargeFiles({ store, requireOwner: true, requireScope: true, ttlMs: Number.POSITIVE_INFINITY });
    const chats = [["u1", "s1"], ["u1", "s2"], ["u2", "s1"]] as const;
    for (const [user, chat] of chats) {
      await mkdir(path.join(root, user, chat, "uploads"), { recursive: true });
      await files.ingest({ name: "notes.txt", bytes: utf8(`notes of ${user} in ${chat}\n`), owner: user, scope: [user, chat], id: "upload-1" });
    }
    for (const [user, chat] of chats) {
      const access = { owner: user, scope: [user, chat] };
      const tools = files.tools([(await files.getMeta("upload-1", access))!], { access });
      expect(await tools.execute("read_document", { document_id: "upload-1", start_line: 1 })).toMatchObject({ text: expect.stringContaining(`notes of ${user} in ${chat}`) });
    }
    // Another user's chat, under the same ID: missing.
    expect(await files.getMeta("upload-1", { owner: "u2", scope: ["u1", "s1"] })).toBeUndefined();
    await expect(files.getMeta("upload-1", { owner: "u1" })).rejects.toThrow("scope is required: requireScope is on");
    // Deleting a chat is removing its folder; the store never makes it again.
    await rm(path.join(root, "u1", "s2"), { recursive: true });
    expect(await files.getMeta("upload-1", { owner: "u1", scope: ["u1", "s2"] })).toBeUndefined();
    expect(await files.sweep()).toBe(0);
    expect(await readdir(path.join(root, "u1"))).toEqual(["s1"]);
    expect(JSON.parse(await readFile(path.join(root, "u2", "s1", ".llm-large-files", "upload-1.json"), "utf8"))).toMatchObject({ owner: "u2", scope: ["u2", "s1"] });
  });
});
