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
  MemoryDocumentStore,
  type DocumentScope,
  type Extractor,
  type IngestFromSource,
  type IngestInput,
  type LargeFiles,
} from "llm-large-files";
import { createDocumentHandlers, fileOriginals, type DocumentHandlerOptions, type PrepareUploadInfo, type UploadedContext } from "llm-large-files/node";
import { fakeModel, says, serviceLog } from "./fake-model.js";
import { numberedPdf } from "./pdf-fixtures.js";

/**
 * The files the handlers opened to write ("wx"), and the flags of every opening of a file. With
 * `fullUnder` set, a write to a file under that folder fails as a full disk does (ENOSPC). With
 * `writesHeldUnder` set, each write to such a file waits for `writesGate`, as on a volume that
 * stopped answering, then runs.
 */
const disk = vi.hoisted(() => ({
  opens: [] as Array<{ file: string; flags: unknown; mode: unknown }>,
  fullUnder: undefined as string | undefined,
  writesHeldUnder: undefined as string | undefined,
  writesGate: Promise.resolve(),
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
    return handle;
  }) as typeof actual.open;
  return { ...actual, open, default: { ...actual, open } };
});

/** The servers of a test, closed after it. */
const servers: Server[] = [];
let root: string;
beforeEach(async () => {
  // A distinctive folder name, looked for in every answer, event and model request.
  root = await mkdtemp(path.join(tmpdir(), "llf-saved-root-"));
  await mkdir(path.join(root, "alice", "chat-1", "uploads"), { recursive: true });
  disk.opens.length = 0;
  disk.fullUnder = undefined;
  disk.writesHeldUnder = undefined;
});
afterEach(async () => {
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
    void documents.upload(request, response);
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

const upload = (base: string, name: string, body: string | Uint8Array, headers: Record<string, string> = {}, events = false) =>
  fetch(base, { method: "POST", headers: { "X-File-Name": name, ...ALICE, ...headers, ...(events ? { Accept: "text/event-stream" } : {}) }, body });

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

function library(extractors?: Record<string, Extractor>, maxUploadBytes?: number) {
  return createLargeFiles({
    store: new FileDocumentStore(root, { scopes: { depth: 2 } }),
    keepOriginals: ["pdf"],
    originals: fileOriginals(root),
    requireOwner: true,
    requireScope: true,
    ...(extractors ? { extractors } : {}),
    ...(maxUploadBytes ? { maxUploadBytes } : {}),
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

  it("removes the file when the upload fails: too large, stopped, left, refused, a taken ID, a full disk", async () => {
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
      uploadIdleTimeoutMs: 200,
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
  it("removes the file, and answers 500 (ETIMEDOUT), when a write does not end within uploadIdleTimeoutMs", async () => {
    const files = library();
    const { options, saved } = chatbot({ uploadIdleTimeoutMs: 200 });
    const base = await serve(files, options);
    let release!: () => void;
    disk.writesHeldUnder = root;
    disk.writesGate = new Promise<void>((resolve) => (release = resolve));
    for (const events of [false, true]) {
      const response = await upload(base, "notes.txt", "The meeting is on Tuesday.", {}, events);
      expect(response.status).toBe(500);
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

  it("answers a folder that is not there with its code, and makes no folder", async () => {
    const files = library();
    const base = await serve(files, { getOwner: userOf, getScope: scopeOf, prepareUpload: (_request, info) => ({ path: path.join(root, ...info.scope!, "gone", "up-1") }) });
    const response = await upload(base, "notes.txt", "Notes.");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Upload failed (ENOENT)." });
    expect(await exists(path.join(root, "alice", "chat-1", "gone"))).toBe(false);
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
