// uploadSpool in the upload handlers (0.9.0): the bodies of uploads over minBytes, or without a
// Content-Length, are written to a temporary file of mode 0o600 and ingested from its path,
// instead of being held in memory, and the file is removed once the ingest ends, whatever the end.
// maxSpooledUploadBytes bounds the files; maxPendingUploadBytes then counts only the bodies held
// in memory. A wrapper of node:fs/promises can make the disk full.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  MemoryDocumentStore,
  type Extractor,
  type IngestFromSource,
  type IngestInput,
  type LargeFiles,
} from "llm-large-files";
import { createDocumentHandlers, type DocumentHandlerOptions, type UploadedContext } from "llm-large-files/node";
import { fakeModel, says, serviceLog } from "./fake-model.js";

/**
 * The files opened "wx" (made new) by the handlers. With `fullUnder` set, a write to such a file
 * under that folder fails as a full disk does (ENOSPC). With `hold` set, one call to the disk for
 * such a file (its opening, each write, or its closing) waits for `hold.gate`, as on a volume that
 * stopped answering, then runs. With `removalsHeld` set, a removal (`rm`) of a file under its folder
 * waits for its gate, then runs.
 */
const disk = vi.hoisted(() => ({
  made: [] as string[],
  fullUnder: undefined as string | undefined,
  hold: undefined as { under: string; call: "open" | "write" | "close"; gate: Promise<void> } | undefined,
  removalsHeld: undefined as { under: string; gate: Promise<void> } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const file = String(args[0]);
    const held = disk.hold !== undefined && file.startsWith(disk.hold.under) && args[1] === "wx" ? disk.hold : undefined;
    if (held?.call === "open") await held.gate;
    const handle = await actual.open(...args);
    if (args[1] === "wx") disk.made.push(file);
    if (disk.fullUnder !== undefined && file.startsWith(disk.fullUnder) && args[1] === "wx") {
      (handle as { write: unknown }).write = async () => {
        throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), { code: "ENOSPC", errno: -28, syscall: "write" });
      };
    }
    if (held?.call === "write" || held?.call === "close") {
      const call = held.call;
      const real = (handle[call] as (...rest: unknown[]) => Promise<unknown>).bind(handle);
      (handle as unknown as Record<string, unknown>)[call] = async (...rest: unknown[]) => {
        await held.gate;
        return real(...rest);
      };
    }
    return handle;
  }) as typeof actual.open;
  const rm = (async (...args: Parameters<typeof actual.rm>) => {
    const held = disk.removalsHeld;
    if (held !== undefined && String(args[0]).startsWith(held.under)) await held.gate;
    return actual.rm(...args);
  }) as typeof actual.rm;
  return { ...actual, open, rm, default: { ...actual, open, rm } };
});

/**
 * The idle time of the tests that hold a call to the disk. Every other call must end within it too:
 * on a Windows runner, opening a new file took more than 200 ms (the virus scanner), and the upload
 * failed with ETIMEDOUT where the test held only the removal. Each call held waits that long: the
 * tests that use it are given 30 s. On Windows 2 s: on Node 26 runners (Nov 2026) calls the test
 * does not hold still passed 1 s, and uploads that should have been 201 were 503 (ETIMEDOUT), on
 * main as on branches. At most six calls are held in one test: 12 s of the 30.
 */
const IDLE_MS = process.platform === "win32" ? 2_000 : 1_000;

/** The servers of a test, closed after it. */
const servers: Server[] = [];
let spool: string;
beforeEach(async () => {
  // A distinctive folder name, looked for in every answer, event and model request.
  spool = await mkdtemp(path.join(tmpdir(), "llf-spool-dir-"));
  disk.fullUnder = undefined;
  disk.hold = undefined;
  disk.removalsHeld = undefined;
  disk.made.length = 0;
});
afterEach(async () => {
  // The spool is removed by a removal that is not held.
  disk.removalsHeld = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(spool, { recursive: true, force: true });
});

async function serve(files: LargeFiles, options: DocumentHandlerOptions): Promise<string> {
  const documents = createDocumentHandlers(files, options);
  const server = createServer((request, response) => void documents.upload(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/documents`;
}

const upload = (base: string, name: string, body: string, events = false, signal?: AbortSignal) =>
  fetch(base, { method: "POST", headers: { "X-File-Name": name, ...(events ? { Accept: "text/event-stream" } : {}) }, body, ...(signal ? { signal } : {}) });

/**
 * The upload after a held call, which shows that the room is back. On a Windows runner a call to
 * the disk for a new file can itself pass IDLE_MS (the virus scanner looks at a file just written),
 * and the upload is answered 503 "Upload failed (ETIMEDOUT).": that alone is tried again, twice.
 * An answer of no room is never tried again: it is what the test is there to see. Gives the status
 * and the body, so that a failure says which 503 it was.
 */
async function uploadAfterHold(base: string, name: string, body: string): Promise<{ status: number; body: string }> {
  for (let attempt = 1; ; attempt++) {
    const answer = await upload(base, name, body);
    const text = await answer.text();
    if (attempt < 3 && answer.status === 503 && text === JSON.stringify({ error: "Upload failed (ETIMEDOUT)." })) continue;
    return { status: answer.status, body: text };
  }
}

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };
/**
 * An upload through node:http, chunked (without a Content-Length): it writes `pieces`, then ends
 * the body once `ending` resolves, or goes away (`leave`, and the answer never comes).
 */
function chunked(base: string, name: string, pieces: string[], how: { ending?: Promise<unknown>; leave?: boolean; hang?: boolean } = {}): Promise<Answer> {
  const url = new URL(base);
  return new Promise<Answer>((resolve, reject) => {
    let answered = false;
    const client = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-File-Name": name, "Transfer-Encoding": "chunked" } }, (response) => {
      answered = true;
      let body = "";
      const done = () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
      response.setEncoding("utf8");
      response.on("data", (piece: string) => (body += piece));
      response.on("end", done);
      response.on("error", done);
    });
    client.on("error", (error) => (how.leave || answered ? undefined : reject(error)));
    void (async () => {
      for (const piece of pieces) {
        client.write(piece);
        await pause(20);
      }
      await how.ending;
      if (how.leave) client.destroy();
      else if (!how.hang) client.end();
    })();
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const spooled = () => readdir(spool);

/** A text extractor that holds each file whose name starts with "held" until `releaseAll`, or until its ingest is stopped. */
function heldText() {
  const waiting: Array<() => void> = [];
  const state = { running: 0, releaseAll: () => waiting.splice(0).forEach((release) => release()) };
  const extract: Extractor = async (bytes, input) => {
    if (input.name.startsWith("held")) {
      state.running++;
      try {
        await new Promise<void>((resolve, reject) => {
          waiting.push(resolve);
          input.signal?.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
        });
      } finally {
        state.running--;
      }
    }
    return { text: new TextDecoder().decode(bytes) };
  };
  return { state, extract };
}

/**
 * A library that records how each upload reached ingest (bytes, or a path of the spool), and what
 * was at that path while it was ingested.
 */
function recording(files: LargeFiles) {
  const seen: Array<{ bytes?: number; path?: string; mode?: number }> = [];
  const own: LargeFiles = {
    ...files,
    async ingest(input: IngestInput | IngestFromSource) {
      if ("source" in input && input.source) {
        const info = await stat(input.source.path);
        seen.push({ path: input.source.path, mode: info.mode & 0o777 });
      } else seen.push({ bytes: input.bytes?.byteLength ?? 0 });
      return files.ingest(input);
    },
  };
  return { own, seen };
}

describe("uploadSpool", () => {
  it("writes bodies over minBytes, and those without a Content-Length, to a 0600 file it ingests from, then removes", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const { own, seen } = recording(files);
    const base = await serve(own, { uploadSpool: { directory: spool, minBytes: 100 } });
    // At minBytes or under: in memory, as without a spool.
    expect((await upload(base, "small.txt", "x".repeat(100))).status).toBe(201);
    // Over it: a file of the spool.
    const large = await upload(base, "large.txt", "The meeting is on Tuesday. ".repeat(10));
    expect(large.status).toBe(201);
    expect(await large.json()).toMatchObject({ name: "large.txt", bytes: 270 });
    // Without a Content-Length: a file of the spool, whatever its size.
    expect((await chunked(base, "chunked.txt", ["a few", " words"])).status).toBe(201);
    // On the event stream too.
    const events = await (await upload(base, "events.txt", "y".repeat(500), true)).text();
    expect(events).toContain('"type":"ingest.finish"');
    expect(seen[0]).toEqual({ bytes: 100 });
    for (const entry of seen.slice(1)) {
      expect(path.dirname(entry.path!)).toBe(spool);
      expect(path.basename(entry.path!)).toMatch(/^llf-upload-[0-9a-f-]{36}$/);
      if (process.platform !== "win32") expect(entry.mode).toBe(0o600);
    }
    expect(new Set(seen.slice(1).map((entry) => entry.path)).size).toBe(3);
    // Each was removed once its ingest ended.
    expect(await spooled()).toEqual([]);
    // `true` takes the defaults: os.tmpdir(), and 1 MiB.
    const defaults = await serve(own, { uploadSpool: true });
    expect((await upload(defaults, "small.txt", "x".repeat(1024 * 1024))).status).toBe(201);
    expect(seen.at(-1)).toEqual({ bytes: 1024 * 1024 });
    expect((await upload(defaults, "large.txt", "x".repeat(1024 * 1024 + 1))).status).toBe(201);
    expect(path.dirname(seen.at(-1)!.path!)).toBe(path.resolve(tmpdir()));
  });

  it("removes the file when the upload fails: refused, too large, stopped, or onUploaded throws", { timeout: 30_000 }, async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes: 1_000 });
    const stored: string[] = [];
    const contexts: UploadedContext[] = [];
    const base = await serve(files, {
      uploadSpool: { directory: spool, minBytes: 0 },
      uploadIdleTimeoutMs: IDLE_MS,
      onUploaded: async (document, context) => {
        stored.push(document.id);
        contexts.push(context);
        // The file of the spool is gone before the hook runs.
        expect(await spooled()).toEqual([]);
        if (document.name.startsWith("refused")) throw Object.assign(new Error("This chat has too many files."), { status: 409 });
      },
    });
    expect((await upload(base, "blank.txt", "   \n\n  ")).status).toBe(422);
    expect(await spooled()).toEqual([]);
    expect((await chunked(base, "big.txt", ["x".repeat(600), "x".repeat(600)])).status).toBe(413);
    expect(await spooled()).toEqual([]);
    expect((await chunked(base, "stalled.txt", ["x".repeat(10)], { hang: true })).status).toBe(408);
    expect(await spooled()).toEqual([]);
    // A hook that passes: the upload is stored, and its file is gone all the same.
    expect((await upload(base, "kept.txt", "Notes.")).status).toBe(201);
    expect(await files.getMeta(stored.at(-1)!)).toMatchObject({ name: "kept.txt" });
    // The hook throws: the document is deleted, on both paths; there is no file left to remove.
    const json = await upload(base, "refused.txt", "Notes.");
    expect(json.status).toBe(409);
    const streamed = await (await upload(base, "refused.txt", "Notes.", true)).text();
    expect(streamed).toContain('"type":"ingest.error"');
    for (const id of stored.slice(1)) expect(await files.getMeta(id)).toBeUndefined();
    expect(stored).toHaveLength(3);
    // The spool's path is not the app's: the hook is not told it.
    for (const context of contexts) expect(context).not.toHaveProperty("path");
    expect(await spooled()).toEqual([]);
    // Each of those bodies was written to a file of the spool.
    expect(disk.made).toHaveLength(6);
    for (const file of disk.made) expect(path.dirname(file)).toBe(spool);
  });

  it("removes the file when the client leaves, while its body arrives or while it is ingested", async () => {
    const { state, extract } = heldText();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extract } });
    const base = await serve(files, { uploadSpool: { directory: spool, minBytes: 0 } });
    // While the body arrives.
    let leave!: () => void;
    void chunked(base, "left.txt", ["x".repeat(100)], { ending: new Promise<void>((resolve) => (leave = resolve)), leave: true });
    await expect.poll(async () => (await spooled()).length).toBe(1);
    leave();
    await expect.poll(() => spooled()).toEqual([]);
    // While it is ingested: the ingest stops, nothing is stored, and the file goes.
    const leaving = new AbortController();
    void upload(base, "held.txt", "Held.", false, leaving.signal).catch(() => undefined);
    await expect.poll(() => state.running).toBe(1);
    expect(await spooled()).toHaveLength(1);
    leaving.abort();
    await expect.poll(() => spooled()).toEqual([]);
    await expect.poll(() => state.running).toBe(0);
  });

  it("answers 503 with Retry-After when the disk is full (ENOSPC), and leaves no file", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const base = await serve(files, { uploadSpool: { directory: spool, minBytes: 0 } });
    disk.fullUnder = spool;
    const full = await upload(base, "notes.txt", "x".repeat(500));
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("30");
    expect(await full.json()).toEqual({ error: "The server has no room for this file right now. Try again later." });
    expect(await spooled()).toEqual([]);
    disk.fullUnder = undefined;
    expect((await upload(base, "notes.txt", "x".repeat(500))).status).toBe(201);
  });

  // A volume that stops answering (a network volume whose server is gone) held the upload: no
  // answer, and its room of the spool kept for good, so that the next upload got a 503.
  it("answers 503 (ETIMEDOUT) when the disk does not answer within uploadIdleTimeoutMs, and gives the room back", { timeout: 30_000 }, async () => {
    // The held call counts as stuck until it is let go, and so does an upload's call that a slow
    // disk ran past IDLE_MS (tried again by uploadAfterHold): this test is about the answer and the
    // room, not the stuck limit (stuck-calls.test.ts).
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const base = await serve(files, { uploadSpool: { directory: spool, minBytes: 0 }, maxSpooledUploadBytes: 1_000, uploadIdleTimeoutMs: IDLE_MS });
    for (const call of ["open", "write", "close"] as const) {
      for (const send of [(name: string) => upload(base, name, "x".repeat(800), false, AbortSignal.timeout(10_000)), (name: string) => chunked(base, name, ["x".repeat(400), "x".repeat(400)])]) {
        let release!: () => void;
        disk.hold = { under: spool, call, gate: new Promise<void>((resolve) => (release = resolve)) };
        const hung = await send(`${call}.txt`);
        disk.hold = undefined;
        // A 503, to try again, since 0.10.0 (a 500 before).
        expect(hung.status).toBe(503);
        const body = hung instanceof Response ? await hung.text() : hung.body;
        expect(body).toBe(JSON.stringify({ error: "Upload failed (ETIMEDOUT)." }));
        // Its room is back: another upload of 800 bytes is taken.
        expect(await uploadAfterHold(base, "next.txt", "y".repeat(800))).toMatchObject({ status: 201 });
        // The file is removed at once, or once the call that hung ends (an opening that made it late).
        release();
        await expect.poll(() => spooled()).toEqual([]);
      }
    }
  });

  // A volume that stopped answering after a write failed: the closing or the removal of the file
  // held the answer, and the room of the spool for good.
  it("answers a full disk when the closing or the removal of the file does not end within uploadIdleTimeoutMs, and gives the room back", { timeout: 30_000 }, async () => {
    // The held call counts as stuck until it is let go, and so does an upload's call that a slow
    // disk ran past IDLE_MS (tried again by uploadAfterHold): this test is about the answer and the
    // room, not the stuck limit (stuck-calls.test.ts).
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const base = await serve(files, { uploadSpool: { directory: spool, minBytes: 0 }, maxSpooledUploadBytes: 1_000, uploadIdleTimeoutMs: IDLE_MS });
    for (const hung of ["close", "removal"] as const) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      if (hung === "close") disk.hold = { under: spool, call: "close", gate };
      else disk.removalsHeld = { under: spool, gate };
      disk.fullUnder = spool;
      const full = await upload(base, `${hung}.txt`, "x".repeat(800), false, AbortSignal.timeout(10_000));
      disk.fullUnder = undefined;
      disk.hold = undefined;
      disk.removalsHeld = undefined;
      expect(full.status).toBe(503);
      expect(await full.json()).toEqual({ error: "The server has no room for this file right now. Try again later." });
      // Its room is back: another upload of 800 bytes is taken.
      expect(await uploadAfterHold(base, "next.txt", "y".repeat(800))).toMatchObject({ status: 201 });
      // The file is removed at once, or once the call that hung ends.
      release();
      await expect.poll(() => spooled()).toEqual([]);
    }
  });

  // A volume that stopped answering while the file was ingested: its removal held the answer, and
  // the room of the spool for good, so that the next upload got a 503.
  it("answers once the ingest ends when the removal of the file does not end within uploadIdleTimeoutMs, and gives the room back", { timeout: 30_000 }, async () => {
    // Removals stuck past uploadIdleTimeoutMs count as stuck calls: two of them would refuse the
    // third ingest at the default limit (0.10.0). This test is about the answer and the room.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const base = await serve(files, { uploadSpool: { directory: spool, minBytes: 0 }, maxSpooledUploadBytes: 1_000, uploadIdleTimeoutMs: IDLE_MS });
    let release!: () => void;
    disk.removalsHeld = { under: spool, gate: new Promise<void>((resolve) => (release = resolve)) };
    expect((await upload(base, "first.txt", "x".repeat(800), false, AbortSignal.timeout(10_000))).status).toBe(201);
    // Its room is back: the next upload of 800 bytes is taken, on the event-stream path too.
    const streamed = await upload(base, "second.txt", "y".repeat(800), true, AbortSignal.timeout(10_000));
    // With the body, so that a failure says what it was.
    expect({ status: streamed.status, body: await streamed.text() }).toMatchObject({ status: 200, body: expect.stringContaining('"type":"ingest.finish"') });
    expect((await upload(base, "third.txt", "z".repeat(800), false, AbortSignal.timeout(10_000))).status).toBe(201);
    // A file that cannot be read is answered too.
    expect((await upload(base, "blank.txt", "   \n\n  ", false, AbortSignal.timeout(10_000))).status).toBe(422);
    // The removals go on, and end once the volume answers.
    expect(await spooled()).toHaveLength(4);
    release();
    await expect.poll(() => spooled()).toEqual([]);
  });

  // In memory, a body without a Content-Length takes maxUploadBytes of room until it is read: two
  // of them filled the default room (twice maxUploadBytes), and the third got a 503.
  it("takes three chunked uploads at once, where the third got a 503 in memory", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes: 4_000 });
    const threeAtOnce = async (options: DocumentHandlerOptions) => {
      let owners = 0;
      const base = await serve(files, { ...options, getOwner: () => void owners++ });
      let end!: () => void;
      const ending = new Promise<void>((resolve) => (end = resolve));
      const first = chunked(base, "a.txt", ["x".repeat(300)], { ending });
      const second = chunked(base, "b.txt", ["x".repeat(300)], { ending });
      await expect.poll(() => owners).toBe(2);
      await pause(50);
      const third = chunked(base, "c.txt", ["x".repeat(300)], { ending });
      await expect.poll(() => owners).toBe(3);
      await pause(50);
      end();
      return (await Promise.all([first, second, third])).map((answer) => answer.status);
    };
    expect(await threeAtOnce({})).toEqual([201, 201, 503]);
    expect(await threeAtOnce({ uploadSpool: { directory: spool } })).toEqual([201, 201, 201]);
    expect(await spooled()).toEqual([]);
  });

  it("answers 503 with Retry-After once the files held reach maxSpooledUploadBytes, while memory still takes small bodies", async () => {
    const { state, extract } = heldText();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extract }, maxConcurrentIngests: 10 });
    const base = await serve(files, { uploadSpool: { directory: spool, minBytes: 100 }, maxSpooledUploadBytes: 1_000, maxPendingUploadBytes: 1_000 });
    const first = upload(base, "held-1.txt", "x".repeat(600));
    await expect.poll(() => state.running).toBe(1);
    const refused = await upload(base, "held-2.txt", "x".repeat(600));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toEqual({ error: "The server is receiving other files right now. Try again in a moment." });
    // A body held in memory counts in maxPendingUploadBytes only.
    const small = upload(base, "held-small.txt", "x".repeat(90));
    await expect.poll(() => state.running).toBe(2);
    // One that fits what is left of the spool.
    const fits = upload(base, "held-3.txt", "x".repeat(300));
    await expect.poll(() => state.running).toBe(3);
    expect(await spooled()).toHaveLength(2);
    state.releaseAll();
    expect((await first).status).toBe(201);
    expect((await small).status).toBe(201);
    expect((await fits).status).toBe(201);
    expect(await spooled()).toEqual([]);
    // Once their files are removed, the room is back.
    const again = upload(base, "held-4.txt", "x".repeat(600));
    await expect.poll(() => state.running).toBe(1);
    state.releaseAll();
    expect((await again).status).toBe(201);
  });

  it("checks its options when the handlers are made", () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    expect(() => createDocumentHandlers(files, { uploadSpool: "yes" as never })).toThrow("uploadSpool must be true, false, or { directory?, minBytes? }.");
    expect(() => createDocumentHandlers(files, { uploadSpool: { directory: "" } })).toThrow("uploadSpool.directory must be the path of a folder: a string that is not empty.");
    expect(() => createDocumentHandlers(files, { uploadSpool: { minBytes: -1 } })).toThrow("uploadSpool.minBytes must be a number of 0 or more, and is -1. Leave it out for the default.");
    expect(() => createDocumentHandlers(files, { maxSpooledUploadBytes: 0 })).toThrow("maxSpooledUploadBytes must be a number above 0, and is 0. Leave it out for the default.");
    expect(() => createDocumentHandlers(files, { uploadSpool: false, maxSpooledUploadBytes: Number.POSITIVE_INFINITY })).not.toThrow();
    expect(() => createDocumentHandlers(files, { uploadSpool: { minBytes: Number.POSITIVE_INFINITY } })).not.toThrow();
  });

  it("never sends the spool's path: not in an answer, an event or a model request", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 2_000 } });
    const base = await serve(files, { uploadSpool: { directory: spool, minBytes: 0 } });
    const small = (await (await upload(base, "notes.txt", "The meeting is on Tuesday.")).json()) as { id: string };
    const large = await (await upload(base, "app.log", serviceLog(2_000), true)).text();
    const largeId = /"id":"(doc_[0-9a-f]+)"/.exec(large)![1]!;
    const refused = await (await upload(base, "blank.txt", "   \n", true)).text();
    // A spool folder that is gone: answered with the code only.
    const gone = await serve(files, { uploadSpool: { directory: path.join(spool, "gone"), minBytes: 0 } });
    const missing = await (await upload(gone, "notes.txt", "Notes.")).text();
    expect(missing).toBe(JSON.stringify({ error: "Upload failed (ENOENT)." }));
    const model = fakeModel([says("On Tuesday.")]);
    await askWithFiles({ files, model, documentIds: [small.id, largeId], messages: [{ role: "user", text: "When is the meeting?" }] });
    const sent = JSON.stringify(model.requests);
    expect(sent).toContain("The meeting is on Tuesday.");
    for (const text of [JSON.stringify(small), large, refused, missing, sent]) {
      for (const secret of [spool, "llf-spool-dir-", "llf-upload-"]) expect(text).not.toContain(secret);
    }
  });
});
