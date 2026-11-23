// What errorInfoOf and uploadAnswerOf (0.9.0) make of the errors and events of an ingest from a
// path, of a store write or read that failed, and of a caller that left while the store was
// written (0.9.0): the error thrown and its ingest.error read the same, and neither names a path or
// a host. The lstat of a path can be held, as on a volume that hangs.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLargeFiles,
  DocumentStoreError,
  errorInfoOf,
  MemoryDocumentStore,
  type DocumentContext,
  type DocumentMeta,
  type ErrorInfo,
  type EventError,
  type IngestEvent,
  type LargeFiles,
  type StoredDocument,
} from "llm-large-files";
import { createDocumentHandlers, uploadAnswerOf } from "llm-large-files/node";
import { utf8 } from "./fake-model.js";
import { RangedStoreOf08 } from "./held-store.js";

/** The lstat of the path `stuck` does not answer until `unstick()`, as on a volume that hangs. */
const looks = vi.hoisted(() => ({ stuck: undefined as string | undefined, waiting: [] as Array<() => void> }));
const unstick = () => {
  looks.stuck = undefined;
  for (const release of looks.waiting.splice(0)) release();
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    if (String(args[0]) === looks.stuck) await new Promise<void>((resolve) => looks.waiting.push(resolve));
    return actual.lstat(...args);
  }) as typeof actual.lstat;
  return { ...actual, lstat, default: { ...actual, lstat } };
});

const HOST = "bucket-prod.internal.corp";

let directory: string;
let server: Server | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "llf-info-"));
});
afterEach(async () => {
  unstick();
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
    server = undefined;
  });
  await rm(directory, { recursive: true, force: true });
});

/** What an ingest threw, and the error of its ingest.error. */
async function failed(files: LargeFiles, input: Parameters<LargeFiles["ingest"]>[0]): Promise<{ thrown: unknown; event: EventError }> {
  const events: IngestEvent[] = [];
  const thrown = await files.ingest({ ...input, onEvent: (event: IngestEvent) => events.push(event) }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeDefined();
  const last = events.at(-1);
  expect(last?.type).toBe("ingest.error");
  return { thrown, event: (last as Extract<IngestEvent, { type: "ingest.error" }>).error };
}

/** Nothing a user may see names the test's folder, a host, or a stack. */
function expectNoPath(...values: unknown[]): void {
  const told = JSON.stringify(values);
  expect(told).not.toContain(directory);
  expect(told).not.toContain(HOST);
  expect(told).not.toMatch(/\n\s+at /);
}

describe("an ingest from a path that is not a file the library reads", () => {
  /** The paths that fail, by the code of their error. */
  async function paths(): Promise<Array<[code: string, at: string]>> {
    const cases: Array<[string, string]> = [["ENOENT", path.join(directory, "gone.log")], ["EISDIR", directory]];
    if (process.platform !== "win32") {
      const real = path.join(directory, "real.log");
      await writeFile(real, "real\n");
      const linked = path.join(directory, "linked.log");
      await symlink(real, linked);
      cases.push(["ELOOP", linked]);
      const pipe = path.join(directory, "pipe.log");
      execFileSync("mkfifo", [pipe]);
      cases.push(["EINVAL", pipe]);
    }
    return cases;
  }

  it("is the server's trouble, with its code and no path, in errorInfoOf of the error and of its ingest.error", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    for (const [code, at] of await paths()) {
      const { thrown, event } = await failed(files, { name: "notes.log", source: { path: at } });
      expect(thrown, code).toMatchObject({ code });
      expect(event, code).toEqual({ message: `The file could not be read from storage (${code}).`, name: "Error" });
      const expected: ErrorInfo = { category: "unknown", code, status: 500, retryable: false, message: `Something went wrong (${code}).` };
      expect(errorInfoOf(thrown), code).toEqual(expected);
      expect(errorInfoOf(event), code).toEqual(expected);
      expect(uploadAnswerOf(thrown), code).toEqual({ status: 500, error: `Upload failed (${code}).` });
      expectNoPath(event, errorInfoOf(thrown), errorInfoOf(event), uploadAnswerOf(thrown));
    }
  });

  it("does so for a look before the turn that does not answer (ETIMEDOUT)", async () => {
    const at = path.join(directory, "slow.log");
    await writeFile(at, "slow\n");
    looks.stuck = at;
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 100 });
    const { thrown, event } = await failed(files, { name: "slow.log", source: { path: at } });
    expect(thrown).toMatchObject({ code: "ETIMEDOUT", syscall: "lstat", message: "The file to ingest did not answer within 100 ms." });
    const expected: ErrorInfo = { category: "unknown", code: "ETIMEDOUT", status: 500, retryable: false, message: "Something went wrong (ETIMEDOUT)." };
    expect(errorInfoOf(thrown)).toEqual(expected);
    expect(errorInfoOf(event)).toEqual(expected);
    expect(uploadAnswerOf(thrown)).toEqual({ status: 500, error: "Upload failed (ETIMEDOUT)." });
    expectNoPath(thrown instanceof Error ? thrown.message : thrown, event, uploadAnswerOf(thrown));
  });

  it("is answered 500 with its code by the upload handlers, on JSON and on the event stream, without the path", async () => {
    if (process.platform === "win32") return;
    const real = path.join(directory, "real.txt");
    await writeFile(real, "real\n");
    const linked = path.join(directory, "upload.txt");
    await symlink(real, linked);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    // A LargeFiles of your own that ingests each upload from where it saved it: here, a link.
    const own: LargeFiles = { ...files, ingest: ({ bytes: _bytes, ...rest }) => files.ingest({ ...rest, source: { path: linked } }) };
    const documents = createDocumentHandlers(own);
    server = createServer((request, response) => void documents.upload(request, response));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const json = await fetch(base, { method: "POST", headers: { "X-File-Name": "upload.txt" }, body: "x" });
    expect(json.status).toBe(500);
    const answer = await json.text();
    expect(JSON.parse(answer)).toEqual({ error: "Upload failed (ELOOP)." });
    const stream = await (await fetch(base, { method: "POST", headers: { "X-File-Name": "upload.txt", Accept: "text/event-stream" }, body: "x" })).text();
    const data = stream.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { type: string; error?: EventError });
    const error = data.find((event) => event.type === "ingest.error")?.error;
    expect(error).toEqual({ message: "Upload failed (ELOOP).", status: 500 });
    expect(errorInfoOf(error)).toEqual({ category: "unknown", code: "ELOOP", status: 500, retryable: false, message: "Something went wrong (ELOOP)." });
    expectNoPath(answer, stream);
  });
});

/** A store's own subclass of DocumentStoreError, with a name of its own. */
class BucketStoreError extends DocumentStoreError {
  constructor(cause: unknown, operation: "read" | "write") {
    super(cause, { operation });
    this.name = "BucketStoreError";
  }
}

describe("a store that fails during an ingest", () => {
  const down = () => Object.assign(new Error(`connect ECONNREFUSED ${HOST}:443`), { code: "EIO", syscall: "connect" });

  it("emits an ingest.error of a store write that errorInfoOf reads as the store's, from a plain error or a subclass", async () => {
    for (const fails of [() => down(), () => new BucketStoreError(down(), "write")]) {
      class FailingStore extends MemoryDocumentStore {
        override async put(): Promise<void> {
          throw fails();
        }
      }
      const files = createLargeFiles({ store: new FailingStore() });
      const { thrown, event } = await failed(files, { name: "notes.md", bytes: utf8("# Notes") });
      expect(DocumentStoreError.is(thrown)).toBe(true);
      expect(event).toEqual({ message: "The document could not be stored. Try again later.", name: "DocumentStoreError", status: 503 });
      const fromEvent = errorInfoOf(event);
      expect(fromEvent).toEqual({ category: "store", status: 503, retryable: true, retryAfterMs: 5_000, message: "The document could not be stored. Try again later." });
      const fromError = errorInfoOf(thrown);
      expect(fromError).toMatchObject({ category: "store", status: 503, retryable: true, retryAfterMs: 5_000 });
      expect(uploadAnswerOf(thrown)).toMatchObject({ status: 503, retryAfterMs: 5_000 });
      expectNoPath(event, fromEvent, fromError, uploadAnswerOf(thrown));
    }
  });

  // A store's own subclass thrown on a read had its own name in ingest.error, and errorInfoOf read
  // the event as "unknown", while it read the error as the store's.
  it("emits an ingest.error of a store read that errorInfoOf reads as the store's, from a store's own subclass", async () => {
    class FailingStore extends MemoryDocumentStore {
      override async getMeta(): Promise<DocumentMeta | undefined> {
        throw new BucketStoreError(down(), "read");
      }
    }
    const files = createLargeFiles({ store: new FailingStore() });
    const { thrown, event } = await failed(files, { name: "notes.md", id: "upload-1", bytes: utf8("# Notes") });
    expect(thrown).toBeInstanceOf(BucketStoreError);
    expect(event).toEqual({ message: "The document store could not be read (EIO). Try again.", name: "DocumentStoreError", status: 503 });
    expect(errorInfoOf(event)).toEqual({ category: "store", status: 503, retryable: true, retryAfterMs: 5_000, message: "The document store could not be read (EIO). Try again." });
    expect(errorInfoOf(thrown)).toEqual({ ...errorInfoOf(event), code: "EIO" });
  });
});

describe("an ingest whose caller leaves while the store writes", () => {
  // The reasons a caller gives: an abort, a deadline, and an error of its own.
  const reasons: Array<[string, () => unknown, Omit<ErrorInfo, "message">]> = [
    ["an abort", () => new DOMException("This operation was aborted", "AbortError"), { category: "aborted", code: "aborted", status: 503, retryable: true }],
    ["a deadline", () => new DOMException("The operation timed out.", "TimeoutError"), { category: "aborted", code: "timeout", status: 504, retryable: true }],
    ["an error of its own", () => new Error(`The uploader left ${HOST}.`), { category: "unknown", status: 500, retryable: false }],
  ];

  for (const [what, reasonOf, expected] of reasons) {
    it(`throws the signal's reason, read by errorInfoOf as its ingest.error is: ${what}`, async () => {
      const store = new RangedStoreOf08();
      const files = createLargeFiles({ store, ttlMs: Infinity });
      const put = store.holds.hold("put");
      const controller = new AbortController();
      const reason = reasonOf();
      const events: IngestEvent[] = [];
      const ingest = files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nShort."), signal: controller.signal, onEvent: (event) => events.push(event) }).catch((error: unknown) => error);
      await put.reached;
      controller.abort(reason);
      put.release();
      const thrown = await ingest;
      expect(thrown).toBe(reason);
      expect(store.documents.size).toBe(0);
      const last = events.at(-1);
      expect(last?.type).toBe("ingest.error");
      const event = (last as Extract<IngestEvent, { type: "ingest.error" }>).error;
      expect(errorInfoOf(thrown)).toMatchObject(expected);
      expect(errorInfoOf(event)).toEqual(errorInfoOf(thrown));
      expectNoPath(errorInfoOf(thrown));
    });
  }
});

// The upload handlers abort the ingest when the client leaves. Before 0.9.0 an ingest aborted
// during its store write was stored all the same, and the hook would then have run for it.
describe("an upload whose client leaves while the store writes it", () => {
  it("is not stored, and onUploaded is not called", async () => {
    let writing!: () => void;
    const reached = new Promise<void>((resolve) => (writing = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const written: string[] = [];
    class SlowStore extends MemoryDocumentStore {
      override async put(document: StoredDocument, context?: DocumentContext): Promise<void> {
        writing();
        await released;
        written.push(document.meta.id);
        return super.put(document, context);
      }
    }
    const store = new SlowStore();
    const files = createLargeFiles({ store, ttlMs: Infinity });
    const onUploaded = vi.fn();
    let ended!: (error: unknown) => void;
    const ingestEnded = new Promise<unknown>((resolve) => (ended = resolve));
    let signal: AbortSignal | undefined;
    const own: LargeFiles = {
      ...files,
      ingest: (input) => {
        signal = input.signal;
        return files.ingest(input).then((meta) => (ended(undefined), meta), (error: unknown) => (ended(error), Promise.reject(error)));
      },
    };
    const documents = createDocumentHandlers(own, { onUploaded });
    server = createServer((request, response) => void documents.upload(request, response));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const client = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
      method: "POST",
      headers: { "X-File-Name": "notes.md" },
      body: "# Notes\n\nShort.",
      signal: controller.signal,
    }).catch(() => undefined);
    await reached;
    controller.abort();
    await client;
    // The handler sees the client gone, and the ingest's signal aborts, while the put still runs.
    await expect.poll(() => signal?.aborted).toBe(true);
    release();
    const error = await ingestEnded;
    expect(error).toMatchObject({ message: "The upload was cancelled: the client closed the connection." });
    expect(written).toHaveLength(1);
    expect(await store.getMeta(written[0]!)).toBeUndefined();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
