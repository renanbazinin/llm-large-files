// prepareUpload in the upload handlers (0.9.0): the body is saved where the application keeps its
// uploads, as it arrives, ingested from there, and kept by reference (fileOriginals): the
// chatbot's <user>/<chat>/uploads/<id>, written once. The file stays once its document is stored,
// and is removed when the upload fails, whatever the reason. The writes of the handlers are seen
// through a wrapper of node:fs/promises, which can also make the disk full.
import "./load-pdf-libraries.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  FileDocumentStore,
  IngestError,
  MemoryDocumentStore,
  type DocumentScope,
  type Extractor,
  type IngestFromSource,
  type IngestInput,
  type LargeFiles,
} from "llm-large-files";
import { createDocumentHandlers, fileOriginals, uploadAnswerOf, type DocumentHandlerOptions, type PrepareUploadInfo, type UploadedContext } from "llm-large-files/node";
import { checkRefFolders, writeBody } from "../src/node/spool.js";
import { fakeModel, says, serviceLog } from "./fake-model.js";
import { numberedPdf } from "./pdf-fixtures.js";

/**
 * The files the handlers opened to write ("wx"), and the flags of every opening of a file. With
 * `fullUnder` set, a write to a file under that folder fails as a full disk does (ENOSPC). With
 * `writesHeldUnder` set, each write to such a file waits for `writesGate`, as on a volume that
 * stopped answering, then runs. With `realpathHeldUnder` set, a look at the real path of a file
 * under that folder does not end until `releaseRealpaths()` (each test's end): a call to the disk
 * left past its time limit counts as stuck in the process until it ends (0.10.0), and would refuse
 * the store calls of the next tests; `realpaths` has the path of every look. With `removalsHeldUnder` set, a removal (`rm`) of a file under that
 * folder waits for `removalsGate`, then runs. With `closesHeldUnder` set, the closing of a file
 * opened to write ("wx") under that folder waits for `closesGate`, as on a network volume that
 * writes then what it held back; `closesWaiting` counts the closings that wait.
 */
const disk = vi.hoisted(() => ({
  opens: [] as Array<{ file: string; flags: unknown; mode: unknown }>,
  fullUnder: undefined as string | undefined,
  writesHeldUnder: undefined as string | undefined,
  writesGate: Promise.resolve(),
  realpathHeldUnder: undefined as string | undefined,
  realpaths: [] as string[],
  realpathsHeld: [] as Array<() => void>,
  removalsHeldUnder: undefined as string | undefined,
  removalsGate: Promise.resolve(),
  closesHeldUnder: undefined as string | undefined,
  closesGate: Promise.resolve(),
  closesWaiting: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const file = String(args[0]);
    disk.opens.push({ file, flags: args[1], mode: args[2] });
    if (disk.fullUnder !== undefined && file.startsWith(disk.fullUnder) && args[1] === "wx") {
      (handle as { write: unknown }).write = async () => {
        throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), { code: "ENOSPC", errno: -28, syscall: "write" });
      };
    }
    if (disk.writesHeldUnder !== undefined && file.startsWith(disk.writesHeldUnder) && args[1] === "wx") {
      const write = handle.write.bind(handle) as (...rest: unknown[]) => Promise<unknown>;
      const gate = disk.writesGate;
      (handle as { write: unknown }).write = async (...rest: unknown[]) => {
        await gate;
        return write(...rest);
      };
    }
    if (disk.closesHeldUnder !== undefined && file.startsWith(disk.closesHeldUnder) && args[1] === "wx") {
      const close = handle.close.bind(handle);
      const gate = disk.closesGate;
      (handle as { close: unknown }).close = async () => {
        disk.closesWaiting++;
        await gate;
        return close();
      };
    }
    return handle;
  }) as typeof actual.open;
  const realpath = ((...args: Parameters<typeof actual.realpath>) => {
    disk.realpaths.push(String(args[0]));
    if (disk.realpathHeldUnder === undefined || !String(args[0]).startsWith(disk.realpathHeldUnder)) return actual.realpath(...args);
    return new Promise<void>((resolve) => disk.realpathsHeld.push(resolve)).then(() => actual.realpath(...args));
  }) as typeof actual.realpath;
  const rm = (async (...args: Parameters<typeof actual.rm>) => {
    if (disk.removalsHeldUnder !== undefined && String(args[0]).startsWith(disk.removalsHeldUnder)) await disk.removalsGate;
    return actual.rm(...args);
  }) as typeof actual.rm;
  return { ...actual, open, realpath, rm, default: { ...actual, open, realpath, rm } };
});

/**
 * The idle time of the tests that hold a call to the disk, or a body. Every other call must end
 * within it too: on a Windows runner, opening a new file can take more than 200 ms (the virus
 * scanner). Each call held waits that long: the tests that use it are given 30 s.
 */
const IDLE_MS = 1_000;

/** The servers of a test, closed after it. */
const servers: Server[] = [];
/** The uploads the servers of a test handled, each until its handler returned. */
const handled: Array<Promise<void>> = [];
let root: string;
beforeEach(async () => {
  // A distinctive folder name, looked for in every answer, event and model request.
  root = await mkdtemp(path.join(tmpdir(), "llf-saved-root-"));
  await mkdir(path.join(root, "alice", "chat-1", "uploads"), { recursive: true });
  disk.opens.length = 0;
  disk.fullUnder = undefined;
  disk.writesHeldUnder = undefined;
  disk.realpathHeldUnder = undefined;
  disk.realpaths.length = 0;
  disk.removalsHeldUnder = undefined;
  disk.closesHeldUnder = undefined;
  disk.closesWaiting = 0;
  handled.length = 0;
});
afterEach(async () => {
  // The folder of the test is removed by a removal that is not held.
  disk.realpathHeldUnder = undefined;
  for (const release of disk.realpathsHeld.splice(0)) release();
  disk.removalsHeldUnder = undefined;
  disk.closesHeldUnder = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

/** Serves the handlers at /api/documents, with `request.body` set from X-Parsed-Body as express.raw() would. The upload URL. */
async function serve(files: LargeFiles, options: DocumentHandlerOptions): Promise<string> {
  const documents = createDocumentHandlers(files, options);
  const server = createServer((request, response) => {
    const parsed = request.headers["x-parsed-body"];
    if (typeof parsed === "string") (request as IncomingMessage & { body?: unknown }).body = Buffer.from(parsed);
    handled.push(documents.upload(request, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/documents`;
}

const userOf = (request: IncomingMessage) => (typeof request.headers["x-user"] === "string" ? request.headers["x-user"] : undefined);
const scopeOf = (request: IncomingMessage): DocumentScope | undefined => {
  const chat = request.headers["x-chat"];
  return typeof chat === "string" ? [userOf(request) ?? "anonymous", chat] : undefined;
};
const ALICE = { "X-User": "alice", "X-Chat": "chat-1" };
const ACCESS = { owner: "alice", scope: ["alice", "chat-1"] };

const upload = (base: string, name: string, body: string | Uint8Array, headers: Record<string, string> = {}, events = false, signal?: AbortSignal) =>
  fetch(base, { method: "POST", headers: { "X-File-Name": name, ...ALICE, ...headers, ...(events ? { Accept: "text/event-stream" } : {}) }, body, ...(signal ? { signal } : {}) });

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };
/**
 * An upload through node:http, chunked: it writes `pieces` and ends the body, or leaves it open
 * (`hang`), or goes away after them (`leave`, and the answer never comes).
 */
function chunked(base: string, name: string, pieces: string[], how: { hang?: boolean; leave?: boolean } = {}): Promise<Answer> {
  const url = new URL(base);
  return new Promise<Answer>((resolve, reject) => {
    let answered = false;
    const client = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-File-Name": name, ...ALICE, "Transfer-Encoding": "chunked" } }, (response) => {
      answered = true;
      let body = "";
      const done = () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
      response.setEncoding("utf8");
      response.on("data", (piece: string) => (body += piece));
      response.on("end", done);
      response.on("error", done);
    });
    // A connection the server closes after its answer (a 408) is no error of the test.
    client.on("error", (error) => (how.leave || answered ? undefined : reject(error)));
    void (async () => {
      for (const piece of pieces) {
        client.write(piece);
        await pause(20);
      }
      if (how.leave) client.destroy();
      else if (!how.hang) client.end();
    })();
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const uploads = () => readdir(path.join(root, "alice", "chat-1", "uploads"));
const exists = (file: string) => lstat(file).then(() => true, () => false);
/** The openings of `file` to write it: by the handlers ("wx") or anyone else (not a number of read flags). */
const writes = (file: string) => disk.opens.filter((entry) => entry.file === file && typeof entry.flags !== "number");

/** The chatbot's handlers: each upload saved as <root>/<user>/<chat>/uploads/<id>, its ref under the root. */
function chatbot(extra: Partial<DocumentHandlerOptions> = {}) {
  let count = 0;
  const infos: PrepareUploadInfo[] = [];
  const contexts: UploadedContext[] = [];
  const options: DocumentHandlerOptions = {
    getOwner: userOf,
    getScope: scopeOf,
    prepareUpload: (_request, info) => {
      infos.push(info);
      const id = `up-${++count}`;
      const ref = [...info.scope!, "uploads", id].join("/");
      return { id, path: path.join(root, ref), original: { ref } };
    },
    onUploaded: (_document, context) => void contexts.push(context),
    ...extra,
  };
  return { options, infos, contexts, saved: (id: string) => path.join(root, "alice", "chat-1", "uploads", id) };
}

function library(extractors?: Record<string, Extractor>, maxUploadBytes?: number, maxStuckStoreCalls?: number) {
  return createLargeFiles({
    store: new FileDocumentStore(root, { scopes: { depth: 2 } }),
    keepOriginals: ["pdf"],
    originals: fileOriginals(root),
    requireOwner: true,
    requireScope: true,
    ...(extractors ? { extractors } : {}),
    ...(maxUploadBytes ? { maxUploadBytes } : {}),
    ...(maxStuckStoreCalls ? { maxStuckStoreCalls } : {}),
  });
}

describe("prepareUpload with a path", () => {
  it("saves the body once, 0600, ingests it from there and keeps it by reference: no .bin, and view_pages reads it", async () => {
    const files = library();
    const { options, infos, contexts, saved } = chatbot();
    const base = await serve(files, options);
    const pdf = numberedPdf(3);
    const response = await upload(base, "report.pdf", pdf);
    expect(response.status).toBe(201);
    const answer = (await response.json()) as { id: string; name: string; pages: number };
    expect(answer).toMatchObject({ id: "up-1", name: "report.pdf", pages: 3 });
    expect(infos).toEqual([{ name: "report.pdf", owner: "alice", scope: ["alice", "chat-1"] }]);

    // Written once, by the handler, new ("wx"), and kept.
    const file = saved("up-1");
    expect(writes(file)).toEqual([{ file, flags: "wx", mode: 0o600 }]);
    expect(new Uint8Array(await readFile(file))).toEqual(pdf);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    // onUploaded is told where.
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ owner: "alice", scope: ["alice", "chat-1"], clientGone: false, path: file });

    // The store keeps no copy: the meta has the ref, and there is no .bin.
    const meta = (await files.getMeta("up-1", ACCESS))!;
    expect(meta.original).toEqual({ ref: "alice/chat-1/uploads/up-1", bytes: pdf.byteLength, sha256: sha256(pdf) });
    expect(meta.originalKept).toBe(true);
    const stored = await readdir(path.join(root, "alice", "chat-1", ".llm-large-files"));
    expect(stored).toContain("up-1.json");
    expect(stored.filter((name) => name.endsWith(".bin"))).toEqual([]);

    // view_pages reads the upload itself, through fileOriginals.
    const { result, files: shown } = await files.tools([meta], { viewPages: true, access: ACCESS }).executeWithFiles("view_pages", { document_id: "up-1", from_page: 1, to_page: 2 });
    expect(result).toMatchObject({ document: "report.pdf", pages: "1-2", total_pages: 3 });
    expect(shown).toHaveLength(1);
    // Read, never written again.
    expect(writes(file)).toHaveLength(1);
    expect(new Uint8Array(await readFile(file))).toEqual(pdf);

    // The same on the event stream.
    const streamed = await (await upload(base, "notes.txt", "The meeting is on Tuesday.", {}, true)).text();
    expect(streamed).toContain('"type":"ingest.finish"');
    expect(streamed).toContain('"id":"up-2"');
    expect(await readFile(saved("up-2"), "utf8")).toBe("The meeting is on Tuesday.");
    expect(contexts[1]).toMatchObject({ path: saved("up-2"), clientGone: false });
    // A text file is not a format kept (keepOriginals: ["pdf"]): no ref is recorded, and the file is the app's all the same.
    const notes = await files.getMeta("up-2", ACCESS);
    expect(notes).toMatchObject({ id: "up-2", name: "notes.txt" });
    expect(notes?.originalKept).not.toBe(true);
    expect(notes).not.toHaveProperty("original");
  });

  it("never writes over a file or through a link at the path: 409, and what was there stays", async () => {
    const files = library();
    const ingest = vi.fn((input: IngestInput | IngestFromSource) => files.ingest(input));
    const there = path.join(root, "alice", "chat-1", "uploads", "taken");
    const target = path.join(root, "target.txt");
    const link = path.join(root, "alice", "chat-1", "uploads", "link");
    await writeFile(there, "mine");
    await writeFile(target, "the target");
    await symlink(target, link);
    let at = there;
    const base = await serve({ ...files, ingest }, { getOwner: userOf, getScope: scopeOf, prepareUpload: () => ({ path: at }) });
    for (const events of [false, true]) {
      for (const where of [there, link]) {
        at = where;
        const response = await upload(base, "notes.txt", "Someone else's words.", {}, events);
        // Answered before the stream starts, with the ID's code.
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "A file is already saved for this upload." });
      }
    }
    expect(await readFile(there, "utf8")).toBe("mine");
    expect(await readFile(target, "utf8")).toBe("the target");
    expect(await readlink(link)).toBe(target);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("removes the file when the upload fails: too large, stopped, left, refused, a taken ID, a full disk", { timeout: 30_000 }, async () => {
    // A text extractor that holds a file named slow.txt until its ingest is stopped.
    let holding = 0;
    const text: Extractor = async (bytes, input) => {
      if (input.name === "slow.txt") {
        holding++;
        await new Promise<never>((_, reject) => input.signal?.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
      }
      return { text: new TextDecoder().decode(bytes) };
    };
    const files = library({ text }, 1_000);
    let next = "";
    const ids: string[] = [];
    const base = await serve(files, {
      getOwner: userOf,
      getScope: scopeOf,
      uploadIdleTimeoutMs: IDLE_MS,
      prepareUpload: (_request, info) => {
        const id = next || `up-${ids.length + 1}`;
        ids.push(id);
        return { id, path: path.join(root, ...info.scope!, "uploads", `${info.name}-${ids.length}`) };
      },
    });

    // Past maxUploadBytes while it is written: 413.
    const tooLarge = await chunked(base, "big.txt", ["x".repeat(600), "x".repeat(600)]);
    expect(tooLarge.status).toBe(413);
    expect(await uploads()).toEqual([]);
    // A body that stops arriving: 408.
    const stopped = await chunked(base, "stalled.txt", ["x".repeat(100)], { hang: true });
    expect(stopped.status).toBe(408);
    expect(await uploads()).toEqual([]);
    // A client that leaves while its body is written.
    void chunked(base, "left.txt", ["x".repeat(100)], { leave: true });
    const left = path.join(root, "alice", "chat-1", "uploads", "left.txt-3");
    await expect.poll(() => writes(left).length).toBe(1);
    await expect.poll(() => exists(left)).toBe(false);
    // A client that leaves during the ingest: the ingest stops, nothing is stored, and the file goes.
    const leaving = new AbortController();
    void fetch(base, { method: "POST", headers: { "X-File-Name": "slow.txt", ...ALICE }, body: "Held.", signal: leaving.signal }).catch(() => undefined);
    await expect.poll(() => holding).toBe(1);
    expect(await uploads()).toEqual(["slow.txt-4"]);
    leaving.abort();
    await expect.poll(() => uploads()).toEqual([]);
    expect(await files.getMeta("up-4", ACCESS)).toBeUndefined();
    // A file the ingest refuses: 422.
    const refused = await upload(base, "blank.txt", "   \n\n  ");
    expect(refused.status).toBe(422);
    expect(await uploads()).toEqual([]);
    // An ID that is taken: 409, and the first upload's file stays.
    next = "same";
    expect((await upload(base, "first.txt", "First.")).status).toBe(201);
    const kept = await uploads();
    expect(kept).toHaveLength(1);
    const taken = await upload(base, "second.txt", "Second.");
    expect(taken.status).toBe(409);
    expect(await uploads()).toEqual(kept);
    // A full disk: 503, with a wait.
    next = "";
    disk.fullUnder = path.join(root, "alice");
    const full = await upload(base, "notes.txt", "x".repeat(300));
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("30");
    expect(await full.json()).toEqual({ error: "The server has no room for this file right now. Try again later." });
    expect(await uploads()).toEqual(kept);
  });

  it("removes the file, and deletes the document, when onUploaded throws, on both paths", async () => {
    const files = library();
    const there: boolean[] = [];
    const { options, saved } = chatbot({
      onUploaded: async (_document, context) => {
        // The saved file is there while the hook runs.
        there.push(await exists(context.path!));
        throw Object.assign(new Error("This chat has too many files."), { status: 409 });
      },
    });
    const base = await serve(files, options);
    const json = await upload(base, "notes.txt", "The meeting is on Tuesday.");
    expect(json.status).toBe(409);
    expect(await json.json()).toEqual({ error: "This chat has too many files." });
    const streamed = await (await upload(base, "notes.txt", "The meeting is on Tuesday.", {}, true)).text();
    expect(streamed).toContain('"type":"ingest.error"');
    expect(streamed).toContain("This chat has too many files.");
    expect(streamed).not.toContain('"type":"ingest.finish"');
    expect(there).toEqual([true, true]);
    for (const id of ["up-1", "up-2"]) {
      expect(await exists(saved(id))).toBe(false);
      expect(await files.getMeta(id, ACCESS)).toBeUndefined();
    }
    expect(await uploads()).toEqual([]);
  });

  it("keeps the file of a document stored after the client left, and tells the hook", async () => {
    const files = library();
    let isStored!: () => void;
    const storedNow = new Promise<void>((resolve) => (isStored = resolve));
    // An ingest that stores the file, then answers only once the client is gone.
    const own: LargeFiles = {
      ...files,
      async ingest(input) {
        const meta = await files.ingest({ ...input, signal: undefined });
        isStored();
        await new Promise<void>((resolve) => (input.signal?.aborted ? resolve() : input.signal?.addEventListener("abort", () => resolve(), { once: true })));
        return meta;
      },
    };
    const { options, contexts, saved } = chatbot();
    const base = await serve(own, options);
    const url = new URL(base);
    const client = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-File-Name": "notes.txt", ...ALICE } });
    client.on("error", () => undefined);
    client.end("The meeting is on Tuesday.");
    await storedNow;
    client.destroy();
    await expect.poll(() => contexts.length).toBe(1);
    expect(contexts[0]).toMatchObject({ clientGone: true, path: saved("up-1") });
    expect(await readFile(saved("up-1"), "utf8")).toBe("The meeting is on Tuesday.");
    expect(await files.getMeta("up-1", ACCESS)).toMatchObject({ id: "up-1" });
  });

  it("saves a body a framework already read, and checks what prepareUpload returns", async () => {
    const files = library();
    const ingest = vi.fn((input: IngestInput | IngestFromSource) => files.ingest(input));
    let prepared: unknown = { id: "up-raw", path: path.join(root, "alice", "chat-1", "uploads", "up-raw") };
    const base = await serve({ ...files, ingest }, { getOwner: userOf, getScope: scopeOf, prepareUpload: () => prepared as never, uploadFileMode: 0o640 });
    // express.raw(): the body is in request.body, and is saved all the same.
    const raw = await upload(base, "notes.txt", "", { "X-Parsed-Body": "Parsed by express.raw()." });
    expect(raw.status).toBe(201);
    expect(await readFile(path.join(root, "alice", "chat-1", "uploads", "up-raw"), "utf8")).toBe("Parsed by express.raw().");
    expect(ingest.mock.calls[0]![0]).toMatchObject({ id: "up-raw", source: { path: path.join(root, "alice", "chat-1", "uploads", "up-raw") } });
    expect(ingest.mock.calls[0]![0]).not.toHaveProperty("bytes");
    // uploadFileMode, minus the umask, as a file of the same mode made here.
    if (process.platform !== "win32") {
      const reference = path.join(root, "reference");
      await writeFile(reference, "", { mode: 0o640 });
      expect((await stat(path.join(root, "alice", "chat-1", "uploads", "up-raw"))).mode & 0o777).toBe((await stat(reference)).mode & 0o777);
    }
    // Nothing, or null fields, is no preparation: the body is held in memory as before.
    for (const nothing of [undefined, null, { id: null, path: null, original: null }]) {
      prepared = nothing;
      const plain = await upload(base, "notes.txt", "Plain.");
      expect(plain.status).toBe(201);
      expect(ingest.mock.calls.at(-1)![0]).toHaveProperty("bytes");
    }
    // A relative path, a ref without a path, an ID that is not a string: the server's mistake.
    ingest.mockClear();
    const before = await uploads();
    for (const wrong of [{ path: "alice/chat-1/uploads/x" }, { original: { ref: "alice/chat-1/uploads/x" } }, { id: 7 }, { path: 7 }, "path", { path: `${root}/a\0b` }]) {
      prepared = wrong;
      const response = await upload(base, "notes.txt", "Wrong.");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Upload failed." });
    }
    expect(ingest).not.toHaveBeenCalled();
    expect(await uploads()).toEqual(before);
    // An error with a status refuses the upload, before its body is read.
    const refusing = await serve(files, {
      getOwner: userOf,
      getScope: scopeOf,
      prepareUpload: () => {
        throw Object.assign(new Error("This chat has too many files."), { status: 403 });
      },
    });
    const refused = await upload(refusing, "notes.txt", "Refused.");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "This chat has too many files." });
    // Checked when the handlers are made.
    expect(() => createDocumentHandlers(files, { getOwner: userOf, getScope: scopeOf, prepareUpload: "uploads" as never })).toThrow("prepareUpload must be a function, and is string.");
    expect(() => createDocumentHandlers(files, { getOwner: userOf, getScope: scopeOf, uploadFileMode: 0o1000 })).toThrow("uploadFileMode must be a file mode from 0 to 0o777, such as 0o640.");
    expect(() => createDocumentHandlers(files, { getOwner: userOf, getScope: scopeOf, uploadFileMode: 1.5 })).toThrow(TypeError);
  });

  it("removes the file when the library cannot keep the ref (no originals)", async () => {
    const files = createLargeFiles({ store: new FileDocumentStore(root, { scopes: { depth: 2 } }), keepOriginals: ["pdf"] });
    const { options } = chatbot();
    const base = await serve(files, options);
    const response = await upload(base, "report.pdf", numberedPdf(1));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Upload failed." });
    expect(writes(path.join(root, "alice", "chat-1", "uploads", "up-1"))).toHaveLength(1);
    expect(await uploads()).toEqual([]);
  });

  // A volume that stopped answering held the upload, unanswered, with its file.
  it("removes the file, and answers 503 (ETIMEDOUT), when a write does not end within uploadIdleTimeoutMs", { timeout: 30_000 }, async () => {
    const files = library();
    const { options, saved } = chatbot({ uploadIdleTimeoutMs: IDLE_MS });
    const base = await serve(files, options);
    let release!: () => void;
    disk.writesHeldUnder = root;
    disk.writesGate = new Promise<void>((resolve) => (release = resolve));
    for (const events of [false, true]) {
      const response = await upload(base, "notes.txt", "The meeting is on Tuesday.", {}, events);
      // A 503, to try again, since 0.10.0 (a 500 before).
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toEqual({ error: "Upload failed (ETIMEDOUT)." });
    }
    expect(writes(saved("up-1"))).toHaveLength(1);
    expect(writes(saved("up-2"))).toHaveLength(1);
    await expect.poll(() => uploads()).toEqual([]);
    release();
    await pause(20);
    expect(await uploads()).toEqual([]);
    expect(await files.getMeta("up-1", ACCESS)).toBeUndefined();
  });

  // The look at the folders of the ref came before the first timed call to the disk: on a volume
  // that stopped answering, such an upload was never answered.
  it("answers 503 (ETIMEDOUT), and writes nothing, when the look at the folders of the ref does not end within uploadIdleTimeoutMs", { timeout: 30_000 }, async () => {
    const files = library();
    const { options } = chatbot({ uploadIdleTimeoutMs: IDLE_MS });
    const base = await serve(files, options);
    disk.realpathHeldUnder = root;
    for (const events of [false, true]) {
      // Answered before the event stream starts: JSON on both paths.
      const response = await upload(base, "notes.txt", "The meeting is on Tuesday.", {}, events, AbortSignal.timeout(10_000));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Upload failed (ETIMEDOUT)." });
    }
    expect(disk.opens.filter((entry) => entry.flags === "wx")).toEqual([]);
    expect(await uploads()).toEqual([]);
    // One look at a time: each upload left one look that does not end (one thread of libuv's pool
    // held), at the root of the ref, and never looked at its folder.
    expect(disk.realpaths).toEqual([root, root]);
    // Two looks stuck: at the default limit of stuck calls, the store is not called (0.10.0).
    expect(files.stats()).toMatchObject({ stuckStoreCalls: 2, maxStuckStoreCalls: 2 });
    // The volume answers again: the looks end.
    disk.realpathHeldUnder = undefined;
    for (const release of disk.realpathsHeld.splice(0)) release();
    await expect.poll(() => files.stats().stuckStoreCalls).toBe(0);
    disk.realpaths.length = 0;
    expect((await upload(base, "notes.txt", "The meeting is on Tuesday.")).status).toBe(201);
    expect(await uploads()).toEqual(["up-3"]);
    expect(disk.realpaths.slice(0, 2)).toEqual([root, path.join(root, "alice", "chat-1", "uploads")]);
  });

  // The folder of a ref of one part is the root: it was looked at twice.
  it("looks once at the folder of a ref of one part", async () => {
    await checkRefFolders(path.join(root, "up-1"), "up-1", 200);
    expect(disk.realpaths).toEqual([root]);
    // A link in place of the folder of a ref of two parts is still refused.
    await symlink(path.join(root, "alice"), path.join(root, "linked"));
    await expect(checkRefFolders(path.join(root, "linked", "up-1"), "linked/up-1", 200)).rejects.toMatchObject({ code: "ELOOP" });
  });

  // A volume that stopped answering after the body was written: the removal of the file of an
  // upload that failed held its answer.
  it("answers an upload that failed when the removal of its file does not end within uploadIdleTimeoutMs, on both paths", { timeout: 30_000 }, async () => {
    // Each removal held past uploadIdleTimeoutMs counts as a stuck call of the process (0.10.0),
    // which would refuse the library's own store calls past 2: this test is about the answers.
    const files = library(undefined, undefined, Number.POSITIVE_INFINITY);
    const { options, saved } = chatbot({
      uploadIdleTimeoutMs: IDLE_MS,
      onUploaded: (document) => {
        if (document.name.startsWith("refused")) throw Object.assign(new Error("This chat has too many files."), { status: 409 });
      },
    });
    const base = await serve(files, options);
    let release!: () => void;
    disk.removalsHeldUnder = path.join(root, "alice", "chat-1", "uploads");
    disk.removalsGate = new Promise<void>((resolve) => (release = resolve));
    for (const events of [false, true]) {
      // The ingest refuses the file (422), or onUploaded throws (409).
      const blank = await upload(base, "blank.txt", "   \n\n  ", {}, events, AbortSignal.timeout(10_000));
      const refused = await upload(base, "refused.txt", "Notes.", {}, events, AbortSignal.timeout(10_000));
      if (events) {
        for (const response of [blank, refused]) expect(await response.text()).toContain('"type":"ingest.error"');
      } else {
        expect(blank.status).toBe(422);
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({ error: "This chat has too many files." });
      }
    }
    // The document of a refused upload is deleted all the same.
    expect(await files.getMeta("up-2", ACCESS)).toBeUndefined();
    expect(await files.getMeta("up-4", ACCESS)).toBeUndefined();
    // The removals go on, and end once the volume answers. Until then each counts as stuck.
    expect(await uploads()).toHaveLength(4);
    expect(files.stats().stuckStoreCalls).toBe(4);
    release();
    await expect.poll(() => uploads()).toEqual([]);
    await expect.poll(() => files.stats().stuckStoreCalls).toBe(0);
    for (const id of ["up-1", "up-2", "up-3", "up-4"]) expect(await exists(saved(id))).toBe(false);
  });

  // fileOriginals refuses a link at any level below its root: such an upload was answered 201, its
  // ref recorded, and view_pages then found the file gone. Written through a link that left the
  // root, the body was saved outside it.
  it("refuses a link in the folders between the root of the ref and the file, before the body is read", async () => {
    const files = library();
    const { options } = chatbot();
    const base = await serve(files, options);
    const chat = path.join(root, "alice", "chat-1");
    const outside = await mkdtemp(path.join(tmpdir(), "llf-outside-"));
    try {
      // chat-1: uploads is a link to a folder beside it; chat-2: to a folder outside the root.
      await rm(path.join(chat, "uploads"), { recursive: true });
      await mkdir(path.join(chat, "real-uploads"));
      await symlink(path.join(chat, "real-uploads"), path.join(chat, "uploads"), "junction");
      await mkdir(path.join(root, "alice", "chat-2"));
      await symlink(outside, path.join(root, "alice", "chat-2", "uploads"), "junction");
      for (const chatId of ["chat-1", "chat-2"]) {
        for (const events of [false, true]) {
          const response = await upload(base, "report.pdf", numberedPdf(1), { "X-Chat": chatId }, events);
          expect(response.status).toBe(500);
          expect(await response.json()).toEqual({ error: "Upload failed (ELOOP)." });
        }
      }
      expect(disk.opens.filter((entry) => entry.flags === "wx")).toEqual([]);
      expect(await readdir(path.join(chat, "real-uploads"))).toEqual([]);
      expect(await readdir(outside)).toEqual([]);

      // The root itself may be a link, as for fileOriginals: taken, and view_pages reads the file.
      const volume = path.join(outside, "volume");
      await symlink(root, volume, "junction");
      const linked = createLargeFiles({ store: new FileDocumentStore(volume, { scopes: { depth: 2 } }), keepOriginals: ["pdf"], originals: fileOriginals(volume), requireOwner: true, requireScope: true });
      const throughLink = await serve(linked, {
        getOwner: userOf,
        getScope: scopeOf,
        prepareUpload: (_request, info) => {
          const ref = [...info.scope!, "real-uploads", "up-9"].join("/");
          return { id: "up-9", path: path.join(volume, ref), original: { ref } };
        },
      });
      expect((await upload(throughLink, "report.pdf", numberedPdf(2))).status).toBe(201);
      const meta = (await linked.getMeta("up-9", ACCESS))!;
      expect(meta.original).toMatchObject({ ref: "alice/chat-1/real-uploads/up-9" });
      const { result } = await linked.tools([meta], { viewPages: true, access: ACCESS }).executeWithFiles("view_pages", { document_id: "up-9", from_page: 1, to_page: 1 });
      expect(result).toMatchObject({ document: "report.pdf", pages: "1", total_pages: 2 });

      // A ref that is not the end of the path is a reader's of your own: not checked.
      const own = createLargeFiles({
        store: new FileDocumentStore(root, { scopes: { depth: 2 } }),
        keepOriginals: ["pdf"],
        originals: { read: async (ref) => new Uint8Array(await readFile(path.join(chat, "real-uploads", ref.slice("upload:".length)))) },
        requireOwner: true,
        requireScope: true,
      });
      const byOwnRef = await serve(own, { getOwner: userOf, getScope: scopeOf, prepareUpload: () => ({ id: "up-10", path: path.join(chat, "uploads", "up-10"), original: { ref: "upload:up-10" } }) });
      expect((await upload(byOwnRef, "report.pdf", numberedPdf(1))).status).toBe(201);
      expect(await readdir(path.join(chat, "real-uploads"))).toEqual(["up-10", "up-9"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // "exists" is the code of a document ID that is taken (IngestError); a file at the path is not one.
  it("tells a file already at the path apart from a taken ID: a 409 without the code \"exists\"", async () => {
    const there = path.join(root, "alice", "chat-1", "uploads", "taken");
    await writeFile(there, "mine");
    const request = { headers: {} } as IncomingMessage;
    const error = await writeBody(request, there, { limit: 1_000, idleMs: 0, mode: 0o600 }).catch((thrown: unknown) => thrown);
    expect(uploadAnswerOf(error)).toEqual({ status: 409, error: "A file is already saved for this upload." });
    expect(IngestError.is(error)).toBe(false);
    expect(await readFile(there, "utf8")).toBe("mine");
  });

  it("answers a folder that is not there with its code, and makes no folder", async () => {
    const files = library();
    const base = await serve(files, { getOwner: userOf, getScope: scopeOf, prepareUpload: (_request, info) => ({ path: path.join(root, ...info.scope!, "gone", "up-1") }) });
    const response = await upload(base, "notes.txt", "Notes.");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Upload failed (ENOENT)." });
    expect(await exists(path.join(root, "alice", "chat-1", "gone"))).toBe(false);
  });
});

/** Sends an upload whole through node:http, and gives the client, to destroy. */
function sendWhole(base: string, name: string, body: string, headers: Record<string, string> = {}) {
  const url = new URL(base);
  const client = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-File-Name": name, ...ALICE, ...headers } });
  client.on("error", () => undefined);
  client.end(body);
  return client;
}

/** How many connections of the last server closed: once one has, its answer was told the client left. */
function closedConnections(): () => number {
  let closed = 0;
  servers.at(-1)!.on("connection", (socket) => socket.once("close", () => closed++));
  return () => closed;
}

describe("a client that leaves once its body has arrived", () => {
  // Closing the body's file is where a network volume writes what it held back, and it can take
  // long. A client that leaves then is noticed, as one that leaves earlier: no document is kept,
  // the hook is not called, the file goes, and so does the upload's room.
  const BODY = "The meeting is on Tuesday at ten.";
  for (const { label, events, spooled } of [
    { label: "saved by prepareUpload, JSON", events: false, spooled: false },
    { label: "saved by prepareUpload, events", events: true, spooled: false },
    { label: "spooled, JSON", events: false, spooled: true },
    { label: "spooled, events", events: true, spooled: true },
  ]) {
    it(`is noticed while the file is closed: ${label}`, async () => {
      const files = library();
      const spoolFolder = path.join(root, "spool");
      await mkdir(spoolFolder);
      let count = 0;
      const { options, contexts } = chatbot(spooled
        ? { prepareUpload: () => ({ id: `up-${++count}` }), uploadSpool: { directory: spoolFolder, minBytes: 0 }, maxSpooledUploadBytes: BODY.length }
        : {});
      const base = await serve(files, options);
      const closed = closedConnections();
      const held = spooled ? spoolFolder : path.join(root, "alice", "chat-1", "uploads");
      let openGate!: () => void;
      disk.closesGate = new Promise<void>((resolve) => (openGate = resolve));
      disk.closesHeldUnder = held;

      const client = sendWhole(base, "notes.txt", BODY, events ? { Accept: "text/event-stream" } : {});
      await expect.poll(() => disk.closesWaiting).toBe(1);
      client.destroy();
      await expect.poll(closed).toBe(1);
      openGate();
      await expect.poll(() => handled.length).toBe(1);
      await Promise.all(handled);
      expect(contexts.map((context) => context.clientGone)).toEqual([]);
      expect(await files.getMeta("up-1", ACCESS)).toBeUndefined();
      expect(await readdir(held)).toEqual([]);

      // The next upload is stored: the room of the first was given back (maxSpooledUploadBytes holds one).
      disk.closesHeldUnder = undefined;
      const next = await upload(base, "next.txt", BODY);
      expect(next.status).toBe(201);
      expect(contexts.map((context) => context.clientGone)).toEqual([false]);
      expect(await files.getMeta("up-2", ACCESS)).toMatchObject({ id: "up-2" });
    });
  }

  it("is noticed when it left before a body a framework read was saved", async () => {
    const files = library();
    let asked = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const { options, contexts, saved } = chatbot({
      getOwner: async (request) => {
        asked++;
        await gate;
        return userOf(request);
      },
    });
    const base = await serve(files, options);
    const closed = closedConnections();
    // express.raw(): the body is in request.body, and nothing more is read from the client.
    const client = sendWhole(base, "notes.txt", BODY, { "X-Parsed-Body": BODY });
    await expect.poll(() => asked).toBe(1);
    client.destroy();
    await expect.poll(closed).toBe(1);
    openGate();
    await expect.poll(() => handled.length).toBe(1);
    await Promise.all(handled);
    expect(contexts.map((context) => context.clientGone)).toEqual([]);
    expect(await files.getMeta("up-1", ACCESS)).toBeUndefined();
    expect(await exists(saved("up-1"))).toBe(false);
  });
});

describe("what leaves the server", () => {
  it("never holds the path or the ref of a saved upload: not in an answer, an event or a model request", async () => {
    const files = createLargeFiles({
      store: new FileDocumentStore(root, { scopes: { depth: 2 } }),
      keepOriginals: ["pdf"],
      originals: fileOriginals(root),
      budget: { inlineTokens: 2_000 },
    });
    const { options } = chatbot();
    const base = await serve(files, options);
    const small = await (await upload(base, "notes.txt", "The meeting is on Tuesday.")).text();
    const large = await (await upload(base, "app.log", serviceLog(2_000), {}, true)).text();
    const pdf = await (await upload(base, "report.pdf", numberedPdf(2), {}, true)).text();
    // A failure that names a path in its own words (ENOENT) is answered with its code only.
    const failing = await serve(files, { ...options, prepareUpload: () => ({ path: path.join(root, "nowhere", "up-x") }) });
    const failed = await (await upload(failing, "notes.txt", "Notes.")).text();
    const streamedFailure = await (await upload(failing, "notes.txt", "Notes.", {}, true)).text();
    const model = fakeModel([says("On Tuesday.")]);
    await askWithFiles({ files, model, documentIds: ["up-1", "up-2", "up-3"], ...ACCESS, messages: [{ role: "user", text: "When is the meeting?" }] });
    const sent = JSON.stringify(model.requests);
    expect(sent).toContain("The meeting is on Tuesday.");
    for (const text of [small, large, pdf, failed, streamedFailure, sent]) {
      for (const secret of [root, "llf-saved-root-", "uploads/up-", "uploads\\\\up-", "nowhere"]) expect(text).not.toContain(secret);
    }
    expect(failed).toBe(JSON.stringify({ error: "Upload failed (ENOENT)." }));
  });
});

describe("prepareUpload without a path", () => {
  it("gives the ID to an upload held in memory, and refuses a taken ID with a 409", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const base = await serve(files, { getOwner: userOf, getScope: scopeOf, prepareUpload: () => ({ id: "chat-file-1" }) });
    const first = await upload(base, "notes.txt", "Notes.");
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id: "chat-file-1" });
    const again = await upload(base, "notes.txt", "Notes.");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "notes.txt: a document with this ID already exists." });
  });
});
