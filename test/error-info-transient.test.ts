// Transient system errors (LO-1, 0.10.0): a code that says the server, or a service it needs,
// could not answer just now is 503 and retryable, with 5 s to wait (a full disk: 30 s), from
// errorInfoOf and from the upload handlers, as a system error and in the handlers' words. Before,
// they were "unknown", 500, and not retryable (probe p1-etimedout). And a path upload whose read
// does not answer is a system ETIMEDOUT, 503, not the IngestError "timeout", 422 (LO-4).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, DocumentStoreError, errorInfoOf, IngestError, MemoryDocumentStore, type IngestEvent } from "llm-large-files";
import { createDocumentHandlers, uploadAnswerOf } from "llm-large-files/node";

/** The reads of the file `stuck` do not answer until `unstick()`, as a volume that hangs. */
const reads = vi.hoisted(() => ({ stuck: undefined as string | undefined, waiting: [] as Array<() => void> }));
const unstick = () => {
  reads.stuck = undefined;
  for (const release of reads.waiting.splice(0)) release();
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const file = String(args[0]);
    const read = handle.read.bind(handle) as (...given: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as { read: unknown }).read = async (...given: unknown[]) => {
      if (file === reads.stuck) await new Promise<void>((resolve) => reads.waiting.push(resolve));
      return read(...given);
    };
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  unstick();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const HOST = "10.0.0.5:27017";
const system = (code: string, syscall = "connect") => Object.assign(new Error(`${syscall} ${code} ${HOST}`), { code, syscall, errno: -110 });
const TRANSIENT = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ESTALE", "EHOSTUNREACH", "ENETUNREACH"];

describe("errorInfoOf and transient system errors", () => {
  it("reads ETIMEDOUT, ECONNRESET and EAGAIN as 503, to retry in 5 s (p1-etimedout)", () => {
    expect(errorInfoOf(system("ETIMEDOUT"))).toEqual({
      category: "unknown", code: "ETIMEDOUT", status: 503, retryable: true, retryAfterMs: 5_000,
      message: "The server could not do this just now (ETIMEDOUT). Try again in a moment.",
    });
    expect(errorInfoOf(system("ECONNRESET", "read"))).toMatchObject({ code: "ECONNRESET", status: 503, retryable: true, retryAfterMs: 5_000 });
    expect(errorInfoOf(system("EAGAIN", "open"))).toMatchObject({ code: "EAGAIN", status: 503, retryable: true, retryAfterMs: 5_000 });
  });

  it("reads every transient code so, and a full disk with 30 s; other codes stay 500", () => {
    for (const code of TRANSIENT) {
      const info = errorInfoOf(system(code));
      expect(info, code).toMatchObject({ category: "unknown", code, status: 503, retryable: true, retryAfterMs: 5_000 });
      expect(info.message, code).not.toContain(HOST);
    }
    for (const code of ["ENOSPC", "EDQUOT"]) {
      expect(errorInfoOf(system(code, "write")), code).toEqual({
        category: "unknown", code, status: 503, retryable: true, retryAfterMs: 30_000, message: `The server has no room right now (${code}). Try again later.`,
      });
    }
    for (const code of ["EACCES", "EPERM", "EIO", "ENOENT"]) {
      expect(errorInfoOf(system(code, "open")), code).toEqual({ category: "unknown", code, status: 500, retryable: false, message: `Something went wrong (${code}).` });
    }
  });

  it("reads them so in the words of the library's events, whatever status they hold", () => {
    // The upload handlers' ingest.error of 0.9.0, a 500, and the storage words of ingest.error.
    expect(errorInfoOf({ message: "Upload failed (ETIMEDOUT).", status: 500 })).toMatchObject({ code: "ETIMEDOUT", status: 503, retryable: true, retryAfterMs: 5_000 });
    expect(errorInfoOf({ message: "Upload failed (ENOSPC).", status: 500 })).toMatchObject({ code: "ENOSPC", status: 503, retryable: true, retryAfterMs: 30_000 });
    expect(errorInfoOf({ message: "The file could not be read from storage (ETIMEDOUT)." })).toMatchObject({ code: "ETIMEDOUT", status: 503, retryable: true });
    expect(errorInfoOf({ message: "Upload failed (EACCES).", status: 500 })).toMatchObject({ code: "EACCES", status: 500, retryable: false });
    // A store that failed is a store failure, as before.
    expect(errorInfoOf(new DocumentStoreError(system("ETIMEDOUT"), { operation: "write", code: "ETIMEDOUT" }))).toMatchObject({ category: "store", code: "ETIMEDOUT", status: 503, retryable: true, retryAfterMs: 5_000 });
  });

  it("makes the upload handlers answer them 503, with the wait", () => {
    for (const code of TRANSIENT) expect(uploadAnswerOf(system(code)), code).toEqual({ status: 503, error: `Upload failed (${code}).`, retryAfterMs: 5_000 });
    expect(uploadAnswerOf(system("EDQUOT", "write"))).toEqual({ status: 503, error: "Upload failed (EDQUOT).", retryAfterMs: 30_000 });
    expect(uploadAnswerOf(system("EACCES", "open"))).toEqual({ status: 500, error: "Upload failed (EACCES)." });
  });

  it("answers an upload whose hook fails on a database that did not answer: 503 with Retry-After, without the host", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const handlers = createDocumentHandlers(files, {
      onUploaded: () => {
        throw system("ETIMEDOUT");
      },
    });
    const server = createServer((request, response) => void handlers.upload(request, response));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const response = await fetch(url, { method: "POST", headers: { "X-File-Name": "notes.txt" }, body: "one\ntwo\n" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ error: "Upload failed (ETIMEDOUT)." }));
    expect(text).not.toContain(HOST);
    // On the event stream too: ingest.error says 503, which errorInfoOf reads in the browser.
    const streamed = await (await fetch(url, { method: "POST", headers: { "X-File-Name": "notes.txt", Accept: "text/event-stream" }, body: "one\n" })).text();
    const last = JSON.parse(streamed.trim().split("\n").filter((line) => line.startsWith("data: ")).at(-1)!.slice(6)) as IngestEvent;
    expect(last).toMatchObject({ type: "ingest.error", error: { message: "Upload failed (ETIMEDOUT).", status: 503 } });
    expect(errorInfoOf((last as Extract<IngestEvent, { type: "ingest.error" }>).error)).toMatchObject({ status: 503, retryable: true });
  });
});

describe("a path upload whose read does not answer (LO-4)", () => {
  it("is a system ETIMEDOUT, 503, not the IngestError timeout, 422", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llf-transient-"));
    directories.push(directory);
    const at = path.join(directory, "stuck.log");
    await writeFile(at, "one\ntwo\n");
    reads.stuck = at;
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 50 });
    const events: IngestEvent[] = [];
    const thrown = await files.ingest({ name: "stuck.log", source: { path: at }, onEvent: (event) => events.push(event) }).catch((error: unknown) => error);
    expect(thrown).not.toBeInstanceOf(IngestError);
    expect(thrown).toMatchObject({ code: "ETIMEDOUT", syscall: "read", message: "The file to ingest did not answer within 50 ms." });
    expect(errorInfoOf(thrown)).toMatchObject({ code: "ETIMEDOUT", status: 503, retryable: true, retryAfterMs: 5_000 });
    expect(uploadAnswerOf(thrown)).toEqual({ status: 503, error: "Upload failed (ETIMEDOUT).", retryAfterMs: 5_000 });
    const error = (events.at(-1) as Extract<IngestEvent, { type: "ingest.error" }>).error;
    expect(errorInfoOf(error)).toMatchObject({ code: "ETIMEDOUT", status: 503, retryable: true });
    expect(JSON.stringify(error)).not.toContain(directory);
    // A file that takes too long to extract is still "timeout", 422: the file's trouble, not the server's.
    unstick();
    const slow = createLargeFiles({
      store: new MemoryDocumentStore(),
      ingestTimeoutMs: 50,
      extractors: { log: () => new Promise(() => undefined), text: () => new Promise(() => undefined) },
    });
    const extracting = await slow.ingest({ name: "slow.log", source: { path: at } }).catch((failure: unknown) => failure);
    expect(extracting).toBeInstanceOf(IngestError);
    expect(extracting).toMatchObject({ code: "timeout", status: 422 });
  });
});
