// The Node layer after the review of 0.99.9 (0.99.10): what the children of
// createIsolatedExtractors are given of the server's environment, how the death of a child is
// told apart (its standard error read to the end, and only that of the file it was reading), the
// drain of a refused upload under a time bound, the removal of a spooled file tried again, the
// files a killed server left in the spool, the root of a ref at the root of a Windows drive, and
// writeSseEvents with a heartbeat no timer can wait, a write that throws, and HTTP/2.
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectHttp2, createServer as createHttp2Server, type Http2Server } from "node:http2";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, IngestError, MemoryDocumentStore } from "llm-large-files";
import { createDocumentHandlers, createIsolatedExtractors, writeSseEvents } from "llm-large-files/node";
import { refFoldersOf, removeFile, sweepSpool } from "../src/node/spool.js";

/**
 * `fork`: when set, the next child process is the one it makes, not a real one. `removals`: the
 * codes the removals (`rm`) of `file` fail with, one a call, before one works.
 */
const fakes = vi.hoisted(() => ({
  fork: undefined as undefined | (() => unknown),
  removals: undefined as undefined | { file: string; codes: string[]; calls: number },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fork = ((...args: Parameters<typeof actual.fork>) => (fakes.fork ? fakes.fork() : actual.fork(...args))) as typeof actual.fork;
  return { ...actual, fork, default: { ...actual, fork } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const remove = (async (...args: Parameters<typeof actual.rm>) => {
    const failing = fakes.removals;
    if (failing !== undefined && String(args[0]) === failing.file) {
      failing.calls++;
      const code = failing.codes.shift();
      if (code !== undefined) throw Object.assign(new Error(`${code}: unlink '${failing.file}'`), { code, syscall: "unlink" });
    }
    return actual.rm(...args);
  }) as typeof actual.rm;
  return { ...actual, rm: remove, default: { ...actual, rm: remove } };
});

let directory: string;
const servers: Array<Server | Http2Server> = [];
const sockets: Socket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "llf-review-node-"));
});

afterEach(async () => {
  fakes.fork = undefined;
  fakes.removals = undefined;
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    (server as Server).closeAllConnections?.();
    server.close();
  }
  await rm(directory, { recursive: true, force: true });
});

/** Serves `listener` on 127.0.0.1, and returns its port. */
async function serve(listener: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** The real timer, also while a test stops the clock of `setTimeout` (the drain's two minutes). */
const realSetTimeout = setTimeout;
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** Waits, a few milliseconds at a time, until `ready` holds (at most about `ms`). */
async function until(ready: () => boolean | Promise<boolean>, ms = 3_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (await ready()) return true;
  return ready();
}

const PDF_INPUT = { name: "report.pdf", mimeType: "application/pdf", format: "pdf" as const };

/** Writes a child script of the tests: it speaks as ingest-child.js does, and answers `body` for each file. */
async function childScript(name: string, body: string): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, [
    "let files = 0;",
    'process.on("message", (message) => {',
    '  if (message?.type !== "extract") return;',
    "  files++;",
    body,
    "});",
    'process.on("disconnect", () => process.exit(0));',
    'process.send({ type: "ready" });',
  ].join("\n"));
  return file;
}

describe("the environment of the children of createIsolatedExtractors", () => {
  /** The environment a child of `options` runs with, as the child itself reads it. */
  async function childEnvironment(options: Parameters<typeof createIsolatedExtractors>[0]): Promise<Record<string, string>> {
    const script = await childScript("env-child.mjs", '  process.send({ type: "done", id: message.id, result: { text: JSON.stringify(process.env) } });');
    const isolated = createIsolatedExtractors({ concurrency: 1, ...options, childScript: script });
    try {
      const read = await isolated.extractors.pdf!(new Uint8Array([1]), PDF_INPUT);
      return JSON.parse(read.text) as Record<string, string>;
    } finally {
      await isolated.close();
    }
  }

  // Starts a child process: well under a second, a few on a busy machine.
  it("is a short list of the server's variables: not its keys and passwords, nor NODE_OPTIONS", { timeout: 20_000 }, async () => {
    vi.stubEnv("LLF_REVIEW_API_KEY", "sk-live-0123456789");
    vi.stubEnv("DATABASE_URL", "postgres://admin:s3cr3t@db.internal:5432/app");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI");
    vi.stubEnv("NODE_AUTH_TOKEN", "npm_0123456789");
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=4096");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TZ", "Asia/Jerusalem");
    vi.stubEnv("LC_TIME", "he_IL.UTF-8");
    const env = await childEnvironment({});
    for (const secret of ["LLF_REVIEW_API_KEY", "DATABASE_URL", "AWS_SECRET_ACCESS_KEY", "NODE_AUTH_TOKEN", "NODE_OPTIONS"]) expect(env).not.toHaveProperty(secret);
    expect(JSON.stringify(env)).not.toMatch(/s3cr3t|sk-live|wJalr|npm_0123/);
    // What Node needs to start, and to read a file as the server would.
    expect(env).toMatchObject({ NODE_ENV: "production", TZ: "Asia/Jerusalem", LC_TIME: "he_IL.UTF-8" });
    if (process.env.PATH !== undefined) expect(env.PATH).toBe(process.env.PATH);
  });

  it("takes more variables from `env`, all of the server's with process.env, and never NODE_OPTIONS", { timeout: 20_000 }, async () => {
    vi.stubEnv("LLF_REVIEW_API_KEY", "sk-live-0123456789");
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=4096");
    vi.stubEnv("NODE_ENV", "production");
    const added = await childEnvironment({ env: { OCR_LANGUAGES: "heb+eng", NODE_ENV: undefined, NODE_OPTIONS: "--max-old-space-size=8192" } });
    expect(added.OCR_LANGUAGES).toBe("heb+eng");
    // undefined takes a variable of the short list out.
    expect(added).not.toHaveProperty("NODE_ENV");
    expect(added).not.toHaveProperty("LLF_REVIEW_API_KEY");
    expect(added).not.toHaveProperty("NODE_OPTIONS");
    // As before 0.99.10: everything but NODE_OPTIONS, whose heap flag would replace the child's.
    const all = await childEnvironment({ env: process.env });
    expect(all).toMatchObject({ LLF_REVIEW_API_KEY: "sk-live-0123456789", NODE_ENV: "production" });
    expect(all).not.toHaveProperty("NODE_OPTIONS");
  });

  it("refuses an env that is not an object", () => {
    expect(() => createIsolatedExtractors({ env: "PATH=/bin" as unknown as Record<string, string> })).toThrow(new TypeError("env must be an object of environment variables, such as { TZ: \"UTC\" } or process.env, and is string."));
    expect(() => createIsolatedExtractors({ env: null as unknown as Record<string, string> })).toThrow(TypeError);
  });
});

describe("why a child of createIsolatedExtractors died", () => {
  /** A child process that is no process: the test says what it does. */
  function fakeChild() {
    const child = Object.assign(new EventEmitter(), {
      pid: 4_242,
      connected: true,
      stderr: new PassThrough(),
      channel: { ref: () => undefined, unref: () => undefined },
      ref: () => undefined,
      unref: () => undefined,
      kill: () => true,
      sent: [] as unknown[],
      send(message: unknown, callback?: (error: Error | null) => void) {
        child.sent.push(message);
        callback?.(null);
        child.emit("sent");
        return true;
      },
    });
    setImmediate(() => child.emit("message", { type: "ready" }));
    return child;
  }

  it("reads the child's standard error to its end: an out-of-memory message that comes after its exit still counts", async () => {
    const child = fakeChild();
    fakes.fork = () => child;
    // As on Windows, where a heap that ran out ends the process with a plain exit code: the
    // message on the standard error is all that tells it, and here it comes after the exit.
    child.once("sent", () => setImmediate(() => {
      child.emit("exit", 3, null);
      setImmediate(() => child.stderr.end("\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n"));
    }));
    const isolated = createIsolatedExtractors({ concurrency: 1, maxHeapMb: 64 });
    try {
      const error = await isolated.extractors.pdf!(new Uint8Array([1]), PDF_INPUT).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(IngestError);
      expect((error as IngestError).code).toBe("out_of_memory");
      expect((error as Error).message).toMatch(/^report\.pdf needed more memory than is allowed for reading one file \(64 MB\)/);
    } finally {
      await isolated.close();
    }
  });

  it("tells a death by SIGABRT at once, without waiting for the standard error", async () => {
    const child = fakeChild();
    fakes.fork = () => child;
    // The standard error never ends here, and the clock of the wait for it stands still: the
    // file is refused only if the signal alone says enough.
    child.once("sent", () => setImmediate(() => child.emit("exit", null, "SIGABRT")));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const isolated = createIsolatedExtractors({ concurrency: 1 });
    try {
      const error = await isolated.extractors.pdf!(new Uint8Array([1]), PDF_INPUT).catch((caught: unknown) => caught);
      expect((error as IngestError).code).toBe("out_of_memory");
    } finally {
      vi.useRealTimers();
      await isolated.close();
    }
  });

  it("waits a second at most for a standard error that does not end", async () => {
    const child = fakeChild();
    fakes.fork = () => child;
    child.once("sent", () => setImmediate(() => child.emit("exit", 1, null)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const isolated = createIsolatedExtractors({ concurrency: 1 });
    try {
      let settled = false;
      const reading = isolated.extractors.pdf!(new Uint8Array([1]), PDF_INPUT).catch((caught: unknown) => caught).finally(() => (settled = true));
      await sleep(60);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await reading;
      expect((error as IngestError).code).toBe("unreadable");
      expect((error as Error).message).toBe("report.pdf could not be read: its reader stopped (exit code 1).");
    } finally {
      vi.useRealTimers();
      await isolated.close();
    }
  });

  // Starts a child process, which reads two files.
  it("judges a death by what the child wrote while it read that file, not an earlier one", { timeout: 20_000 }, async () => {
    // The first file leaves a warning that reads like a heap that ran out; the child lives on, and
    // dies of something else on the second.
    const script = await childScript("stale-child.mjs", [
      "  if (files === 1) process.stderr.write(\"Warning: Array buffer allocation failed\\n\", () => process.send({ type: \"done\", id: message.id, result: { text: \"one\" } }));",
      "  else process.exit(1);",
    ].join("\n"));
    const isolated = createIsolatedExtractors({ concurrency: 1, childScript: script });
    try {
      expect((await isolated.extractors.pdf!(new Uint8Array([1]), PDF_INPUT)).text).toBe("one");
      // The warning has reached the server by now.
      await sleep(150);
      const error = await isolated.extractors.pdf!(new Uint8Array([2]), { ...PDF_INPUT, name: "second.pdf" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(IngestError);
      expect((error as IngestError).code).toBe("unreadable");
      expect((error as Error).message).toBe("second.pdf could not be read: its reader stopped (exit code 1).");
    } finally {
      await isolated.close();
    }
  });
});

describe("the drain of a refused upload", () => {
  /** Opens a connection to the upload route and sends `head`: what came back, and when it closed. */
  function rawUpload(port: number, head: string) {
    const socket = connect(port, "127.0.0.1");
    sockets.push(socket);
    const state = { socket, received: "", closed: false };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (state.received += chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => (state.closed = true));
    socket.write(head);
    return state;
  }

  const NO_NAME = "POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\n\r\n";

  async function uploadPort(uploadIdleTimeoutMs: number) {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const documents = createDocumentHandlers(files, { uploadIdleTimeoutMs });
    return { documents, port: await serve((request, response) => void documents.upload(request, response)) };
  }

  it("ends the connection of a client that stops sending: nothing for uploadIdleTimeoutMs", async () => {
    const { documents, port } = await uploadPort(150);
    // No name: answered 400 before the body is read. 100,000 bytes are declared, 10 sent, then nothing.
    const upload = rawUpload(port, `${NO_NAME}0123456789`);
    expect(await until(() => upload.closed, 2_000)).toBe(true);
    expect(upload.received).toMatch(/^HTTP\/1\.1 400 /);
    expect(upload.received).toContain("Name the file with an X-File-Name header or a ?name= query parameter.");
    expect(documents.stats().uploadsInFlight).toBe(0);
  });

  // The handler's timers run on a clock the test moves; the connection and the waits are real.
  for (const [name, uploadIdleTimeoutMs] of [["under the default idle time", 30_000], ["with no idle limit", 0]] as const) {
    it(`ends the connection of a client that sends a byte now and then, after two minutes (${name})`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { port } = await uploadPort(uploadIdleTimeoutMs);
        const upload = rawUpload(port, NO_NAME);
        expect(await until(() => upload.received.includes("Name the file"))).toBe(true);
        // A byte every 20 s: never idle for 30 s, and 100,000 bytes would take 23 days.
        for (let seconds = 20; seconds < 120; seconds += 20) {
          await vi.advanceTimersByTimeAsync(20_000);
          upload.socket.write("x");
          await sleep(40);
          expect(upload.closed).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await until(() => upload.closed, 2_000)).toBe(true);
        expect(upload.received).toMatch(/^HTTP\/1\.1 400 /);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("still lets a client that sends the rest of its body read the answer, and use the connection again", async () => {
    const { port } = await uploadPort(150);
    const upload = rawUpload(port, "POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\n0123456789");
    await sleep(50);
    upload.socket.write("0123456789");
    // The answer ends once the body does: the last chunk of its chunked body.
    expect(await until(() => upload.received.endsWith("0\r\n\r\n"), 2_000)).toBe(true);
    expect(upload.received).toMatch(/^HTTP\/1\.1 400 /);
    // The connection is kept: the next request on it is answered, well past the idle time.
    await sleep(400);
    expect(upload.closed).toBe(false);
    const before = upload.received.length;
    upload.socket.write("POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n");
    expect(await until(() => upload.received.slice(before).endsWith("0\r\n\r\n"), 2_000)).toBe(true);
    expect(upload.received.slice(before)).toMatch(/^HTTP\/1\.1 400 /);
  });
});

describe("the files of the spool", () => {
  it("removeFile tries again a removal that fails for a moment, with EACCES as with EBUSY", async () => {
    const file = path.join(directory, "llf-upload-held");
    await writeFile(file, "x");
    // Node's own rm does not try EACCES again: a scanner that holds the file open can give either.
    fakes.removals = { file, codes: ["EACCES", "EBUSY"], calls: 0 };
    await removeFile(file);
    expect(fakes.removals.calls).toBe(3);
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removeFile gives up after four tries, and at once on an error that will not pass", async () => {
    const held = path.join(directory, "llf-upload-busy");
    await writeFile(held, "x");
    fakes.removals = { file: held, codes: ["EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY"], calls: 0 };
    await expect(removeFile(held)).resolves.toBeUndefined();
    expect(fakes.removals.calls).toBe(4);
    expect((await lstat(held)).isFile()).toBe(true);
    const readOnly = path.join(directory, "llf-upload-rofs");
    await writeFile(readOnly, "x");
    fakes.removals = { file: readOnly, codes: ["EROFS", "EROFS"], calls: 0 };
    await expect(removeFile(readOnly)).resolves.toBeUndefined();
    expect(fakes.removals.calls).toBe(1);
  });

  const OLD = "llf-upload-11111111-2222-4333-8444-555555555555";
  const FRESH = "llf-upload-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const DAY = 24 * 60 * 60 * 1_000;

  /** Makes `name` in the test's folder, last written `ageMs` ago. */
  async function aged(name: string, ageMs: number, make: (file: string) => Promise<unknown> = (file) => writeFile(file, "left behind")): Promise<string> {
    const file = path.join(directory, name);
    await make(file);
    const then = new Date(Date.now() - ageMs);
    await utimes(file, then, then).catch(() => undefined);
    return file;
  }

  it("sweepSpool removes the spool's own old files, and nothing else", async () => {
    await aged(OLD, 2 * DAY);
    await aged(FRESH, 60_000);
    // Not the spool's names: a file of the application, a name that only starts like one.
    await aged("report.pdf", 2 * DAY);
    await aged("llf-upload-notes.txt", 2 * DAY);
    await aged(`${OLD}.bak`, 2 * DAY);
    // The spool's name, but not a file it wrote: a folder, and a link.
    await aged("llf-upload-99999999-2222-4333-8444-555555555555", 2 * DAY, (file) => mkdir(file));
    const target = await aged("kept.txt", 2 * DAY);
    const link = path.join(directory, "llf-upload-88888888-2222-4333-8444-555555555555");
    const linked = await symlink(target, link).then(() => true, () => false);
    expect(await sweepSpool(directory, DAY)).toBe(1);
    const left = (await readdir(directory)).sort();
    expect(left).not.toContain(OLD);
    expect(left).toEqual(expect.arrayContaining([FRESH, "report.pdf", "llf-upload-notes.txt", `${OLD}.bak`, "llf-upload-99999999-2222-4333-8444-555555555555", "kept.txt"]));
    if (linked) expect(left).toContain(path.basename(link));
    // A folder that is not there, or cannot be read, removes nothing and does not throw.
    expect(await sweepSpool(path.join(directory, "missing"), DAY)).toBe(0);
  });

  it("the handlers remove what a killed server left in the spool when they are made: files older than a day", async () => {
    const old = await aged(OLD, 2 * DAY);
    const fresh = await aged(FRESH, 60 * 60 * 1_000);
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    createDocumentHandlers(files, { uploadSpool: { directory } });
    expect(await until(() => lstat(old).then(() => false, () => true))).toBe(true);
    expect((await lstat(fresh)).isFile()).toBe(true);
  });

  it("sweepAfterMs sets the age, and 0 removes nothing", async () => {
    const hourOld = await aged(OLD, 60 * 60 * 1_000);
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    createDocumentHandlers(files, { uploadSpool: { directory, sweepAfterMs: 0 } });
    await sleep(200);
    expect((await lstat(hourOld)).isFile()).toBe(true);
    createDocumentHandlers(files, { uploadSpool: { directory, sweepAfterMs: 30 * 60 * 1_000 } });
    expect(await until(() => lstat(hourOld).then(() => false, () => true))).toBe(true);
    expect(() => createDocumentHandlers(files, { uploadSpool: { directory, sweepAfterMs: -1 } })).toThrow(new RangeError("uploadSpool.sweepAfterMs must be a number of 0 or more, and is -1. Leave it out for the default."));
    expect(() => createDocumentHandlers(files, { uploadSpool: { directory, sweepAfterMs: Number.NaN } })).toThrow(RangeError);
  });
});

describe("the root of a ref (checkRefFolders)", () => {
  it("is the root of the drive for a file at the root of a Windows drive, not the drive's working folder", () => {
    // "C:" alone names the working folder of the drive C, whatever it is.
    expect(refFoldersOf("C:\\upload.pdf", "upload.pdf", path.win32)).toEqual({ root: "C:\\", folder: "C:\\" });
    expect(refFoldersOf("C:\\uploads\\u1\\a.pdf", "u1\\a.pdf", path.win32)).toEqual({ root: "C:\\uploads", folder: "C:\\uploads\\u1" });
    expect(refFoldersOf("C:\\uploads\\u1\\a.pdf", "u1/a.pdf", path.win32)).toEqual({ root: "C:\\uploads", folder: "C:\\uploads\\u1" });
    expect(refFoldersOf("\\\\server\\share\\a.pdf", "a.pdf", path.win32)).toEqual({ root: "\\\\server\\share\\", folder: "\\\\server\\share\\" });
  });

  it("is as before elsewhere", () => {
    expect(refFoldersOf("/upload.pdf", "upload.pdf", path.posix)).toEqual({ root: "/", folder: "/" });
    expect(refFoldersOf("/data/uploads/u1/a.pdf", "u1/a.pdf", path.posix)).toEqual({ root: "/data/uploads", folder: "/data/uploads/u1" });
    // A ref that is not the end of the path, or leaves its root, is not checked.
    expect(refFoldersOf("/data/uploads/u1/a.pdf", "other/a.pdf", path.posix)).toBeUndefined();
    expect(refFoldersOf("/data/uploads/u1/a.pdf", "../u1/a.pdf", path.posix)).toBeUndefined();
    expect(refFoldersOf("/data/uploads/u1/a.pdf", "/data/uploads/u1/a.pdf", path.posix)).toBeUndefined();
  });
});

describe("writeSseEvents", () => {
  type Event = { type: string; seq: number };

  /** Two events, 250 ms apart. */
  async function* slowly(): AsyncGenerator<Event> {
    yield { type: "one", seq: 1 };
    await sleep(250);
    yield { type: "two", seq: 2 };
  }

  for (const heartbeatMs of [Number.POSITIVE_INFINITY, 2 ** 31, 1e12]) {
    it(`sends no keep-alive for a heartbeat no timer can wait (${heartbeatMs} ms), where Node's timer fired every millisecond`, async () => {
      const warnings: string[] = [];
      const onWarning = (warning: Error) => warnings.push(warning.name);
      process.on("warning", onWarning);
      try {
        const port = await serve((_request, response) => void writeSseEvents(response, slowly(), { heartbeatMs }));
        const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        expect(body).toContain("event: one");
        expect(body).toContain("event: two");
        expect(body.split(": keep-alive").length - 1).toBe(0);
        await sleep(10);
        expect(warnings).not.toContain("TimeoutOverflowWarning");
      } finally {
        process.off("warning", onWarning);
      }
    });
  }

  it("still sends keep-alives at the heartbeat", async () => {
    const port = await serve((_request, response) => void writeSseEvents(response, slowly(), { heartbeatMs: 20 }));
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(body.split(": keep-alive").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("rejects with the error of a keep-alive whose write throws, and stops the events, instead of an uncaught exception", async () => {
    let returned = false;
    const events: AsyncIterable<Event> = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: () => (sent ? new Promise<IteratorResult<Event>>(() => undefined) : ((sent = true), Promise.resolve({ done: false as const, value: { type: "one", seq: 1 } }))),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };
    let outcome: Promise<unknown> | undefined;
    const port = await serve((_request, response) => {
      // A response a middleware wraps: its write fails once the stream is open.
      const write = response.write.bind(response) as (chunk: string) => boolean;
      response.write = ((chunk: string) => {
        if (chunk.startsWith(": keep-alive")) throw new Error("The wrapped response cannot be written.");
        return write(chunk);
      }) as typeof response.write;
      outcome = writeSseEvents(response, events, { heartbeatMs: 20 }).then(() => "resolved", (error: unknown) => error);
    });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.text();
    expect(body).toContain("event: one");
    expect(await outcome).toEqual(new Error("The wrapped response cannot be written."));
    expect(returned).toBe(true);
  });

  it("sends no Connection header on HTTP/2, which forbids it (Node dropped it with a warning)", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(`${warning.name}: ${warning.message}`);
    process.on("warning", onWarning);
    const server = createHttp2Server((_request, response) => void writeSseEvents(response as unknown as ServerResponse, slowly(), { heartbeatMs: 0 }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = connectHttp2(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      const stream = client.request({ ":path": "/" });
      const headers = await new Promise<Record<string, unknown>>((resolve) => stream.once("response", resolve));
      let body = "";
      stream.setEncoding("utf8");
      for await (const chunk of stream) body += chunk as string;
      expect(headers[":status"]).toBe(200);
      expect(headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(headers["cache-control"]).toBe("no-cache, no-transform");
      expect(headers).not.toHaveProperty("connection");
      expect(body).toContain("event: one");
      expect(body).toContain("event: two");
      await sleep(10);
      expect(warnings.filter((warning) => /connection header/i.test(warning))).toEqual([]);
    } finally {
      process.off("warning", onWarning);
      client.close();
    }
  });

  it("keeps the Connection header on HTTP/1.1", async () => {
    const port = await serve((_request, response) => void writeSseEvents(response, slowly(), { heartbeatMs: 0 }));
    const response = await fetch(`http://127.0.0.1:${port}/`);
    await response.text();
    expect(response.headers.get("connection")).toBe("keep-alive");
  });
});
