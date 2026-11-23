// Ingest from a path (`IngestFromSource`, 0.9.0): the file is looked at before its turn without
// being read, read once at its turn within the upload limit, and hashed as it is read. The reads
// of the server are counted through a wrapper of node:fs/promises.
import { createHash, randomBytes } from "node:crypto";
import { appendFile, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, IngestError, MemoryDocumentStore, type Extractor, type IngestEvent } from "../src/index.js";
import { serviceLog, utf8 } from "./fake-model.js";

/** What the server read, file by file: each opening of a file, and the bytes read through it. */
const reads = vi.hoisted(() => ({ opens: [] as Array<{ file: string; bytes: number }> }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const entry = { file: String(args[0]), bytes: 0 };
    reads.opens.push(entry);
    const read = handle.read.bind(handle) as (...given: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as { read: unknown }).read = async (...given: unknown[]) => {
      const result = await read(...given);
      entry.bytes += result.bytesRead;
      return result;
    };
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

/** The bytes the server read from `file`, through every opening of it. */
const bytesRead = (file: string) => reads.opens.filter((entry) => entry.file === file).reduce((sum, entry) => sum + entry.bytes, 0);
const opened = (file: string) => reads.opens.filter((entry) => entry.file === file).length;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "llf-path-"));
  reads.opens.length = 0;
});
afterEach(async () => {
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
