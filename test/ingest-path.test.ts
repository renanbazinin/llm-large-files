// Ingest from a path (`IngestFromSource`, 0.9.0): the file is looked at before its turn without
// being read, read once at its turn within the upload limit, and hashed as it is read. The reads
// of the server are counted through a wrapper of node:fs/promises.
import { createHash, randomBytes } from "node:crypto";
import { appendFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, IngestError, MemoryDocumentStore, type Extractor, type IngestEvent } from "../src/index.js";
import { absolutePath } from "../src/source.js";
import { serviceLog, utf8 } from "./fake-model.js";

/**
 * What the server read, file by file: each opening of a file, and the bytes read through it. The
 * reads of the file `stuck`, and the lstat of the file `stuckStat`, do not answer until
 * `unstick()`, as a volume that hangs. `looked`: each path the server gave lstat.
 */
const reads = vi.hoisted(() => ({
  opens: [] as Array<{ file: string; bytes: number }>,
  looked: [] as string[],
  stuck: undefined as string | undefined,
  stuckStat: undefined as string | undefined,
  waiting: [] as Array<() => void>,
}));
const unstick = () => {
  reads.stuck = undefined;
  reads.stuckStat = undefined;
  for (const release of reads.waiting.splice(0)) release();
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const entry = { file: String(args[0]), bytes: 0 };
    reads.opens.push(entry);
    const read = handle.read.bind(handle) as (...given: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as { read: unknown }).read = async (...given: unknown[]) => {
      if (entry.file === reads.stuck) await new Promise<void>((resolve) => reads.waiting.push(resolve));
      const result = await read(...given);
      entry.bytes += result.bytesRead;
      return result;
    };
    return handle;
  };
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    reads.looked.push(String(args[0]));
    if (String(args[0]) === reads.stuckStat) await new Promise<void>((resolve) => reads.waiting.push(resolve));
    return actual.lstat(...args);
  }) as typeof actual.lstat;
  return { ...actual, open, lstat, default: { ...actual, open, lstat } };
});

/** The bytes the server read from `file`, through every opening of it. */
const bytesRead = (file: string) => reads.opens.filter((entry) => entry.file === file).reduce((sum, entry) => sum + entry.bytes, 0);
const opened = (file: string) => reads.opens.filter((entry) => entry.file === file).length;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "llf-path-"));
  reads.opens.length = 0;
  reads.looked.length = 0;
});
afterEach(async () => {
  unstick();
  await rm(directory, { recursive: true, force: true });
});

/** Writes a file in the test's folder and returns its path. */
async function file(name: string, bytes: Uint8Array | string): Promise<string> {
  const at = path.join(directory, name);
  await writeFile(at, bytes);
  return at;
}

/**
 * A library whose one turn (`maxConcurrentIngests: 1`) can be held: `hold()` starts an ingest of a
 * Markdown file whose extractor waits until `release()`.
 */
function heldLibrary(options: { maxUploadBytes?: number } = {}) {
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (reached = resolve));
  const waiting: Extractor = async () => {
    reached();
    await held;
    return { text: "# Held\n\nThe turn was held." };
  };
  const files = createLargeFiles({ store: new MemoryDocumentStore(), maxConcurrentIngests: 1, extractors: { markdown: waiting }, ...options });
  return {
    files,
    /** Starts the ingest that holds the turn, and waits until it does: `done` is that ingest. */
    async hold() {
      const done = files.ingest({ name: "held.md", bytes: utf8("# Held") });
      await started;
      return { done };
    },
    release,
  };
}

/** What an ingest of the file at `at` gave: the size and SHA-256 of what was read, or the code of the error. */
async function outcome(files: ReturnType<typeof createLargeFiles>, at: string): Promise<{ bytes: number; sha256: string | undefined } | { code: unknown }> {
  try {
    const meta = await files.ingest({ name: "r.txt", source: { path: at } });
    return { bytes: meta.bytes, sha256: meta.sha256 };
  } catch (error) {
    return { code: (error as { code?: unknown }).code };
  }
}

/** Waits until the work of other ingests in this process has had a few turns of the event loop. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
};

describe("ingest from a path", () => {
  it("gives the document an ingest of the same bytes gives, with the file's SHA-256 (H6)", async () => {
    const text = serviceLog(400);
    const at = await file("app.log", text);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const fromPath = await files.ingest({ name: "app.log", source: { path: at } });
    const fromBytes = await files.ingest({ name: "app.log", bytes: utf8(text) });
    const { id: _a, createdAt: _b, expiresAt: _c, ...pathRest } = fromPath;
    const { id: _d, createdAt: _e, expiresAt: _f, ...bytesRest } = fromBytes;
    expect(pathRest).toEqual(bytesRest);
    expect(fromPath.sha256).toBe(sha256(utf8(text)));
    expect(fromBytes.sha256).toBe(sha256(utf8(text)));
    expect(fromPath.bytes).toBe(utf8(text).byteLength);
    // Read once, at its turn.
    expect(opened(at)).toBe(1);
    expect(bytesRead(at)).toBe(utf8(text).byteLength);
    expect(await files.getMeta(fromPath.id)).toEqual(fromPath);
  });

  it("hashes a file of several slices as node:crypto does, from bytes and from a path", async () => {
    const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
    // Text, so that it is read: every byte a letter.
    for (let at = 0; at < bytes.length; at++) bytes[at] = 97 + (bytes[at]! % 26);
    for (let at = 99; at < bytes.length; at += 100) bytes[at] = 10;
    const at = await file("letters.txt", bytes);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    expect((await files.ingest({ name: "letters.txt", source: { path: at } })).sha256).toBe(sha256(bytes));
    expect((await files.ingest({ name: "letters.txt", bytes })).sha256).toBe(sha256(bytes));
  });

  it("lets the bytes read go once the extractor returns: they are not held while the text is prepared and stored", async () => {
    const at = await file("big.txt", "the quick brown fox jumps over the lazy dog 0123456789\n".repeat(40_000));
    let given: WeakRef<Uint8Array> | undefined;
    const extractor: Extractor = async (bytes) => {
      given = new WeakRef(bytes);
      return { text: new TextDecoder().decode(bytes) };
    };
    // Whether the bytes the extractor was given are still held, after full collections, at the
    // first progress of each stage after it.
    const held: Record<string, boolean> = {};
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extractor } });
    const meta = await files.ingest({
      name: "big.txt",
      source: { path: at },
      onEvent: (event) => {
        if (event.type !== "ingest.progress" || event.stage in held || !given) return;
        collectGarbage();
        collectGarbage();
        held[event.stage] = given.deref() !== undefined;
      },
    });
    expect(meta.bytes).toBe(55 * 40_000);
    expect(held).toEqual({ prepare: false, store: false });
  });

  it("calls the extractor at the turn, before bytes given are hashed: ingests of one turn reach it in the order they came", async () => {
    const order: string[] = [];
    const extractor: Extractor = async (_bytes, input) => {
      order.push(input.name);
      return { text: "# Text" };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxConcurrentIngests: Number.POSITIVE_INFINITY, extractors: { markdown: extractor } });
    // The first is hashed in four slices, the second in one: hashed first, the second came first.
    const large = new Uint8Array(4 * 1024 * 1024).fill(35);
    const metas = await Promise.all([files.ingest({ name: "large.md", bytes: large }), files.ingest({ name: "small.md", bytes: utf8("#") })]);
    expect(order).toEqual(["large.md", "small.md"]);
    expect(metas[0]!.sha256).toBe(sha256(large));
  });

  it("reports the size from lstat in ingest.start, before the file is read", async () => {
    const at = await file("notes.md", "# Notes\n\nOne line.");
    const events: IngestEvent[] = [];
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await files.ingest({
      name: "notes.md",
      source: { path: at },
      onEvent: (event) => {
        if (event.type === "ingest.start") expect(opened(at)).toBe(0);
        events.push(event);
      },
    });
    expect(events[0]).toMatchObject({ type: "ingest.start", name: "notes.md", format: "markdown", bytes: 18 });
  });

  it("refuses an empty file, and one over the upload limit, before the turn, without reading them", async () => {
    const library = heldLibrary({ maxUploadBytes: 1_000 });
    const { done: first } = await library.hold();
    const empty = await file("empty.log", "");
    const large = await file("large.log", "x".repeat(1_001));
    // Refused while the one turn is held: they do not wait for it.
    const emptyError = await library.files.ingest({ name: "empty.log", source: { path: empty } }).catch((error: unknown) => error);
    const largeError = await library.files.ingest({ name: "large.log", source: { path: large } }).catch((error: unknown) => error);
    expect(emptyError).toBeInstanceOf(IngestError);
    expect(emptyError).toMatchObject({ code: "empty", message: "empty.log is empty." });
    expect(largeError).toMatchObject({ code: "too_large", status: 413, message: "large.log is larger than the 1000 B upload limit." });
    expect(opened(empty)).toBe(0);
    expect(opened(large)).toBe(0);
    library.release();
    await first;
  });

  it("refuses a file that grew past the limit between the look and the read, reading no more than one byte past it", async () => {
    const library = heldLibrary({ maxUploadBytes: 1_000 });
    const { done: first } = await library.hold();
    const at = await file("growing.log", "x\n".repeat(300));
    let started!: () => void;
    const looked = new Promise<void>((resolve) => (started = resolve));
    const ingest = library.files.ingest({ name: "growing.log", source: { path: at }, onEvent: (event) => event.type === "ingest.start" && started() }).catch((error: unknown) => error);
    await looked;
    await settle();
    // Waiting for its turn: nothing of it is read yet.
    expect(opened(at)).toBe(0);
    await appendFile(at, "y\n".repeat(2_000));
    library.release();
    await first;
    expect(await ingest).toMatchObject({ code: "too_large", message: "growing.log is larger than the 1000 B upload limit." });
    expect(bytesRead(at)).toBeLessThanOrEqual(1_001);
  });

  it("knows a DOCX without an extension from ranged reads of it, not the whole file", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The lease ends in May.</w:t></w:r></w:p></w:body></w:document>');
    // A picture of 3 MB that does not compress: the file is larger than the parts looked at.
    zip.file("word/media/image1.bin", new Uint8Array(randomBytes(3 * 1024 * 1024)), { compression: "STORE" });
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const at = await file("lease", bytes);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "lease", mimeType: "application/octet-stream", source: { path: at } });
    expect(meta.format).toBe("docx");
    // The first KB, then the first 64 KB and the last MB of the ZIP, then the whole file at its turn.
    const opens = reads.opens.filter((entry) => entry.file === at).map((entry) => entry.bytes);
    expect(opens).toEqual([1_024, 64 * 1024 + 1024 * 1024, bytes.byteLength]);
  });

  it("refuses a link at the path, and reads nothing through it", async () => {
    if (process.platform === "win32") return;
    const target = await file("real.log", "real\n");
    const at = path.join(directory, "linked.log");
    await symlink(target, at);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const error = await files.ingest({ name: "linked.log", source: { path: at } }).catch((caught: unknown) => caught);
    // The server's trouble, not a file the user sent: passed on as a system error, which names no path.
    expect(error).not.toBeInstanceOf(IngestError);
    expect(error).toMatchObject({ code: "ELOOP", syscall: "lstat" });
    expect((error as Error).message).not.toContain(directory);
    expect(opened(at)).toBe(0);
    expect(opened(target)).toBe(0);
  });

  it("passes on a path that is not there, or a folder, as the system error it is", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const missing = await files.ingest({ name: "gone.log", source: { path: path.join(directory, "gone.log") } }).catch((error: unknown) => error);
    expect(missing).not.toBeInstanceOf(IngestError);
    expect(missing).toMatchObject({ code: "ENOENT" });
    expect(await files.ingest({ name: "folder.log", source: { path: directory } }).catch((error: unknown) => error)).toMatchObject({ code: "EISDIR" });
  });

  it("fails in its time when the volume does not answer the read, and keeps its turn until the read ends", async () => {
    const at = await file("stuck.log", "one\ntwo\n");
    reads.stuck = at;
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 100, maxConcurrentIngests: 1 });
    await expect(files.ingest({ name: "stuck.log", source: { path: at } })).rejects.toMatchObject({ code: "timeout", message: "stuck.log took too long to read (more than 100 ms). Split it, or save it as plain text, and attach that." });
    // The read still holds the turn: the next ingest waits for it, at most ingestTimeoutMs more.
    let done = false;
    const next = files.ingest({ name: "next.md", bytes: utf8("# Next") }).then((meta) => {
      done = true;
      return meta;
    });
    await settle();
    expect(done).toBe(false);
    unstick();
    expect((await next).name).toBe("next.md");
  });

  it("gives up the parts read for the format, with the caller's reason, when the caller leaves", async () => {
    const at = await file("noname", "%PDF-1.4");
    reads.stuck = at;
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const controller = new AbortController();
    const ingest = files.ingest({ name: "noname", source: { path: at }, signal: controller.signal });
    while (opened(at) === 0) await settle();
    controller.abort(new Error("Left."));
    await expect(ingest).rejects.toThrow("Left.");
  });

  it("gives up a look at the file that does not answer (lstat), with the caller's reason, when the caller leaves", async () => {
    const at = await file("a.txt", "hello\n");
    reads.stuckStat = at;
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 60_000 });
    const controller = new AbortController();
    const reason = new Error("Left.");
    const events: string[] = [];
    const ingest = files.ingest({ name: "a.txt", source: { path: at }, signal: controller.signal, onEvent: (event) => events.push(event.type) }).catch((error: unknown) => error);
    while (!reads.looked.includes(at)) await settle();
    setTimeout(() => controller.abort(reason), 50);
    const result = await Promise.race([ingest, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000))]);
    expect(result).toBe(reason);
    expect(events).toEqual(["ingest.start", "ingest.error"]);
    expect(opened(at)).toBe(0);
  });

  it("fails, as the server's trouble, when a look at the file before its turn does not answer in time, with no signal", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 100 });
    // The lstat.
    const at = await file("a.txt", "hello\n");
    reads.stuckStat = at;
    const stat = await Promise.race([files.ingest({ name: "a.txt", source: { path: at } }).catch((error: unknown) => error), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000))]);
    expect(stat).not.toBeInstanceOf(IngestError);
    expect(stat).toMatchObject({ code: "ETIMEDOUT", syscall: "lstat", message: "The file to ingest did not answer within 100 ms." });
    // The parts read for the format of a file whose name says nothing.
    const noname = await file("noname", "%PDF-1.4");
    reads.stuck = noname;
    const sniff = await Promise.race([files.ingest({ name: "noname", source: { path: noname } }).catch((error: unknown) => error), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000))]);
    expect(sniff).not.toBeInstanceOf(IngestError);
    expect(sniff).toMatchObject({ code: "ETIMEDOUT", syscall: "read", message: "The file to ingest did not answer within 100 ms." });
  });

  it("takes a relative path against the working directory of the call, for every read of the file", async () => {
    const before = process.cwd();
    const first = path.join(directory, "a");
    const second = path.join(directory, "b");
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, "r.txt"), "The file of folder A.\n");
    await writeFile(path.join(second, "r.txt"), "The file of folder B, which is longer.\n");
    const library = heldLibrary();
    const { done } = await library.hold();
    try {
      process.chdir(first);
      let looked!: () => void;
      const started = new Promise<void>((resolve) => (looked = resolve));
      const ingest = library.files.ingest({ name: "r.txt", source: { path: "r.txt" }, onEvent: (event) => event.type === "ingest.start" && looked() });
      await started;
      // The working directory changes while the ingest waits for its turn.
      process.chdir(second);
      library.release();
      await done;
      const meta = await ingest;
      expect(meta).toMatchObject({ bytes: 22, sha256: sha256(utf8("The file of folder A.\n")) });
      expect(reads.looked).toContain(path.join(first, "r.txt"));
      expect(reads.opens.map((entry) => entry.file)).toEqual([path.join(first, "r.txt")]);
    } finally {
      process.chdir(before);
    }
  });

  // The working directory was asked for on every call, an absolute path's too: once it had been
  // removed, process.cwd() threw ENOENT, and a file that was there was told as unreadable storage.
  it("reads an absolute path when the working directory has been removed", async () => {
    if (process.platform === "win32") return;
    const before = process.cwd();
    const at = await file("r.txt", "Still here.\n");
    const removed = path.join(directory, "removed");
    await mkdir(removed);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    try {
      process.chdir(removed);
      await rm(removed, { recursive: true });
      expect(() => process.cwd()).toThrow();
      const meta = await files.ingest({ name: "r.txt", source: { path: at } });
      expect(meta).toMatchObject({ bytes: 12, sha256: sha256(utf8("Still here.\n")) });
      // A relative path has no working directory to be read against.
      await expect(files.ingest({ name: "r.txt", source: { path: "r.txt" } })).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(before);
    }
  });

  it("gives an extractor that reads paths (readsPath) the path made absolute at the call", async () => {
    const before = process.cwd();
    const paths: unknown[] = [];
    const extractor: Extractor = Object.assign(async (_bytes: Uint8Array, input: Parameters<Extractor>[1]) => {
      paths.push(input.path);
      return { text: "Read in a child." };
    }, { readsPath: true as const });
    await file("r.txt", "Read in a child.");
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extractor } });
    try {
      process.chdir(directory);
      await files.ingest({ name: "r.txt", source: { path: "r.txt" } });
    } finally {
      process.chdir(before);
    }
    expect(paths).toEqual([path.join(directory, "r.txt")]);
  });

  it("reads a '..' after a link as the system does, whether the path is relative or absolute", async () => {
    if (process.platform === "win32") return;
    const before = process.cwd();
    await writeFile(path.join(directory, "r.txt"), "The near file.\n");
    await mkdir(path.join(directory, "other", "deep"), { recursive: true });
    await writeFile(path.join(directory, "other", "r.txt"), "The file beyond the link.\n");
    // "link/.." is the folder above the link's target ("other"), not the folder that holds the link.
    await symlink(path.join(directory, "other", "deep"), path.join(directory, "link"));
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    try {
      process.chdir(directory);
      const absolute = `${process.cwd()}${path.sep}link/../r.txt`;
      const relative = await outcome(files, "link/../r.txt");
      expect(relative).toEqual(await outcome(files, absolute));
      expect(relative).toEqual({ bytes: 26, sha256: sha256(utf8("The file beyond the link.\n")) });
      // Each spelling reached the system as the same path, with its ".." in it.
      expect(reads.looked).toEqual([absolute, absolute]);
    } finally {
      process.chdir(before);
    }
  });

  it("reads a '/' at the end of a path as the system does, whether the path is relative or absolute", async () => {
    const before = process.cwd();
    await writeFile(path.join(directory, "r.txt"), "A file, not a folder.\n");
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    try {
      process.chdir(directory);
      const relative = await outcome(files, "r.txt/");
      expect(relative).toEqual(await outcome(files, `${process.cwd()}${path.sep}r.txt/`));
      // A file named as a folder is no file: the server's trouble, as the system tells it.
      if (process.platform !== "win32") expect(relative).toEqual({ code: "ENOTDIR" });
    } finally {
      process.chdir(before);
    }
  });

  it("reads a second name of a file (a hard link) as the file it is", async () => {
    const target = await file("a.log", "one\ntwo\n");
    const at = path.join(directory, "b.log");
    await link(target, at);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    expect((await files.ingest({ name: "b.log", source: { path: at } })).lines).toBe(2);
  });

  it("never writes, moves or deletes the file", async () => {
    const at = await file("kept.md", "# Kept\n\nAs it was.");
    const before = await stat(at);
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["markdown"] });
    const meta = await files.ingest({ name: "kept.md", source: { path: at } });
    expect(await files.delete(meta.id)).toBe(true);
    expect(await readFile(at, "utf8")).toBe("# Kept\n\nAs it was.");
    expect((await stat(at)).mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps the file in the store (keepOriginals) from the bytes read at its turn", async () => {
    const at = await file("notes.md", "# Notes");
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, keepOriginals: ["markdown"] });
    const meta = await files.ingest({ name: "notes.md", source: { path: at } });
    expect(meta.originalKept).toBe(true);
    expect(await files.getOriginal(meta.id)).toEqual(utf8("# Notes"));
    expect(opened(at)).toBe(1);
  });

  it("refuses an input with both bytes and a source, and a source without a path", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const both = { name: "a.log", bytes: utf8("a"), source: { path: "/tmp/a.log" } } as unknown as Parameters<typeof files.ingest>[0];
    await expect(files.ingest(both)).rejects.toThrow(new TypeError("Give the file as bytes or as source, not both."));
    await expect(files.ingest({ name: "a.log", source: { path: "" } })).rejects.toThrow(new TypeError("source.path must be the path of a file: a string that is not empty."));
  });
});

describe("absolutePath: a relative source path made absolute, as text", () => {
  it("puts the working directory and a separator before it, and normalizes nothing", () => {
    expect(absolutePath("link/../r.txt", path.posix, "/srv/app")).toBe("/srv/app/link/../r.txt");
    expect(absolutePath("r.txt/", path.posix, "/srv/app")).toBe("/srv/app/r.txt/");
    expect(absolutePath("./r.txt", path.posix, "/")).toBe("/./r.txt");
    expect(absolutePath("/srv/other/../r.txt/", path.posix, "/srv/app")).toBe("/srv/other/../r.txt/");
  });

  it("does the same on Windows, where a path relative to a drive's own working directory is resolved", () => {
    expect(absolutePath("link\\..\\r.txt", path.win32, "C:\\app")).toBe("C:\\app\\link\\..\\r.txt");
    expect(absolutePath("r.txt/", path.win32, "C:\\")).toBe("C:\\r.txt/");
    expect(absolutePath("\\\\server\\share\\r.txt", path.win32, "C:\\app")).toBe("\\\\server\\share\\r.txt");
    expect(absolutePath("D:\\data\\..\\r.txt", path.win32, "C:\\app")).toBe("D:\\data\\..\\r.txt");
    // "D:r.txt" is r.txt in the working directory of drive D, which only path.resolve knows.
    const resolved: string[] = [];
    const win32 = { ...path.win32, resolve: (...parts: string[]) => (resolved.push(...parts), "D:\\work\\r.txt") };
    expect(absolutePath("D:r.txt", win32, "C:\\app")).toBe("D:\\work\\r.txt");
    expect(resolved).toEqual(["D:r.txt"]);
  });
});

describe("ingests from paths waiting for their turn", () => {
  // Measured for 0.9.0 (docs/guides/deployment.md, scratch script d-queue-memory.mjs): 100 such
  // ingests waiting held 73 MB of RSS as paths, against 282 to 286 MB with their bytes given. The
  // test counts what is read, not the heap: a queued path holds none of its file.
  it("read nothing of their files while they wait: 100 files of 2 MB", async () => {
    const library = heldLibrary();
    const { done: first } = await library.hold();
    const bytes = utf8(serviceLog(23_000).slice(0, 2 * 1024 * 1024));
    const original = await file("upload-0.log", bytes);
    // Names of one file (hard links): 100 paths, 2 MB of disk.
    const paths = [original];
    for (let index = 1; index < 100; index++) {
      const at = path.join(directory, `upload-${index}.log`);
      await link(original, at);
      paths.push(at);
    }
    const controllers = paths.map(() => new AbortController());
    let started = 0;
    const ingests = paths.map((at, index) => library.files.ingest({
      name: path.basename(at),
      source: { path: at },
      signal: controllers[index]!.signal,
      onEvent: (event) => {
        if (event.type === "ingest.start") started++;
      },
    }).catch((error: unknown) => error));
    while (started < 100) await settle();
    await settle();
    // 100 ingests wait for the turn, and the server has read no byte of their files. With bytes
    // given (IngestInput.bytes), the 200 MB would be held all that time.
    expect(paths.reduce((sum, at) => sum + bytesRead(at), 0)).toBe(0);
    expect(reads.opens).toEqual([]);
    for (const controller of controllers) controller.abort(new Error("The uploader left."));
    for (const result of await Promise.all(ingests)) expect(result).toMatchObject({ message: "The uploader left." });
    library.release();
    await first;
    expect(reads.opens).toEqual([]);
  });
});
