// Store calls that cannot hang (0.10.0): each store call of the library has a time limit
// (`storeTimeoutMs`), a caller's signal ends its own wait and nobody else's, and the upload
// handlers' rollback delete and DELETE route end within the limit. Before, a store that did not
// answer held the call forever (probe p2-hung-store: files.delete still pending after 1 s).
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askWithFiles, createLargeFiles, DocumentStoreError, errorInfoOf, FileDocumentStore, MemoryDocumentStore,
  type AskEvent, type DocumentContext, type DocumentMeta, type DocumentStore, type StoredDocument,
} from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";
import { fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";

/** Calls held by the stores of a test: each is let go at the test's end, so that none stays stuck. */
const held: Array<() => void> = [];
/** A call that does not answer until the test ends (or `release`). */
const hang = <T>(then: () => Promise<T>): Promise<T> => new Promise<void>((resolve) => held.push(resolve)).then(then);
const releaseAll = () => held.splice(0).forEach((release) => release());

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  releaseAll();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/**
 * A memory store whose named methods do not answer while their name is in `hung`. It wraps one,
 * rather than extends it: `MemoryDocumentStore.getMeta` calls its own `get`.
 */
class Hanging implements DocumentStore {
  readonly hung = new Set<string>();
  readonly calls: string[] = [];
  readonly #inner = new MemoryDocumentStore();

  #maybe<T>(method: string, then: () => Promise<T>): Promise<T> {
    this.calls.push(method);
    return this.hung.has(method) ? hang(then) : then();
  }

  put(document: StoredDocument, context?: DocumentContext) {
    return this.#inner.put(document, context);
  }
  get(id: string, context?: DocumentContext) {
    return this.#maybe("get", () => this.#inner.get(id, context));
  }
  getMeta(id: string, context?: DocumentContext) {
    return this.#maybe("getMeta", () => this.#inner.getMeta(id, context));
  }
  delete(id: string, context?: DocumentContext) {
    return this.#maybe("delete", () => this.#inner.delete(id, context));
  }
  putOriginal(id: string, bytes: Uint8Array, context?: DocumentContext) {
    return this.#inner.putOriginal(id, bytes, context);
  }
  getOriginal(id: string, context?: DocumentContext) {
    return this.#maybe("getOriginal", () => this.#inner.getOriginal(id, context));
  }
  sweep(now?: Date, context?: DocumentContext) {
    return this.#maybe("sweep", () => this.#inner.sweep(now, context));
  }
}

/**
 * A file store whose ranged reads do not answer while `hung` is set, nor its saved indexes while
 * `indexHung` is. It counts the ranged reads, the looks at a saved index and the indexes written.
 */
class HangingFiles extends FileDocumentStore {
  hung = false;
  indexHung = false;
  ranges = 0;
  indexLooks = 0;
  indexWrites = 0;
  override readTextRange(id: string, start: number, end: number, context?: DocumentContext) {
    this.ranges++;
    return this.hung ? hang(() => super.readTextRange(id, start, end, context)) : super.readTextRange(id, start, end, context);
  }
  override getIndex(id: string, context?: DocumentContext) {
    this.indexLooks++;
    return this.indexHung ? hang(() => super.getIndex(id, context)) : super.getIndex(id, context);
  }
  override putIndex(id: string, index: Uint8Array, context?: DocumentContext) {
    this.indexWrites++;
    return super.putIndex(id, index, context);
  }
}

/** What `promise` came to within `ms`: its value, its error, or "pending". */
async function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"pending">((resolve) => (timer = setTimeout(() => resolve("pending"), ms)));
  try {
    return await Promise.race([promise.then((value) => ({ value }), (error: unknown) => ({ error })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Expects `promise` to reject within a generous bound with a `DocumentStoreError` "ETIMEDOUT" of `operation`. */
async function timesOut(promise: Promise<unknown>, operation: string): Promise<void> {
  const outcome = await within(promise, 10_000);
  expect(outcome).not.toBe("pending");
  const error = (outcome as { error?: unknown }).error;
  expect(DocumentStoreError.is(error)).toBe(true);
  expect(error).toMatchObject({ code: "ETIMEDOUT", operation, status: 503 });
}

const bytes = (text: string) => utf8(text);

describe("store calls with a time limit (storeTimeoutMs)", () => {
  // p2-hung-store, through each call of the library that waits on the store.
  it("ends getMeta, get, delete and the look-up of delete that never answer, within the limit", async () => {
    const store = new Hanging();
    const files = createLargeFiles({ requireOwner: false, store, storeTimeoutMs: 50, maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(serviceLog(200)) });

    store.hung.add("getMeta");
    await timesOut(files.getMeta(meta.id), "read");
    // files.delete looks the document up first: it was still pending after 1 s.
    await timesOut(files.delete(meta.id), "read");
    store.hung.clear();

    store.hung.add("get");
    await timesOut(files.prepare([meta.id], { tokens: 0, bytes: 0 }), "read");
    store.hung.clear();

    store.hung.add("delete");
    await timesOut(files.delete(meta.id), "delete");
    store.hung.clear();
    // The delete given up on goes on, and ends once the store answers.
    releaseAll();
    await expect.poll(() => files.getMeta(meta.id)).toBeUndefined();
  });

  it("ends a tool call whose ranged read never answers, within the limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llf-timeouts-"));
    directories.push(directory);
    const store = new HangingFiles(directory);
    const files = createLargeFiles({ requireOwner: false, store, wholeDocumentBytes: 0, storeTimeoutMs: 50, maxStuckStoreCalls: Number.POSITIVE_INFINITY, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(serviceLog(2_000)) });
    store.hung = true;
    const tools = files.tools([meta]);
    const outcome = await within(tools.execute("read_document", { document_id: meta.id, start_line: 5, end_line: 9 }), 10_000);
    expect(outcome).not.toBe("pending");
    // A tool set of 0.10.0's package T ends the question on it; this one answers with the error.
    const result = "value" in (outcome as object) ? (outcome as { value: unknown }).value : (outcome as { error: unknown }).error;
    expect(JSON.stringify(result)).toContain("ETIMEDOUT");
  });

  // A saved index that did not answer in time was taken for none: the opening read the whole text
  // to build it again, and wrote it, on the store that was not answering. On a store where every
  // read hangs, one tool call waited twice the limit and left two calls stuck: the default limit.
  it("ends a ranged opening whose saved index does not answer after one limit, with one call stuck, and does not build the index again", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llf-timeouts-"));
    directories.push(directory);
    const store = new HangingFiles(directory);
    const files = createLargeFiles({ requireOwner: false, store, wholeDocumentBytes: 0, storeTimeoutMs: 1_000, maxStuckStoreCalls: Number.POSITIVE_INFINITY, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(serviceLog(2_000)) });
    store.indexHung = true;
    store.ranges = 0;
    store.indexWrites = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: unknown;
    const reading = files.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 5, end_line: 9 }).then((value) => (result = value), (error: unknown) => (result = error));
    // The look-up reads the disk: the clock moves once the saved index is asked for.
    for (let turn = 0; turn < 10_000 && store.indexLooks === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(store.indexLooks).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await reading;
    // A tool set of 0.10.0's package T ends the question on it; this one answers with the error.
    expect(JSON.stringify(result)).toContain("ETIMEDOUT");
    expect(files.stats().stuckStoreCalls).toBe(1);
    expect(store.ranges).toBe(0);
    expect(store.indexWrites).toBe(0);
  });

  it("gives up after 30 s by default, and never with 0", async () => {
    const store = new Hanging();
    const meta = await createLargeFiles({ requireOwner: false, store }).ingest({ name: "a.txt", bytes: bytes("alpha\n") });
    store.hung.add("getMeta");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const files = createLargeFiles({ requireOwner: false, store, maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    let settled = false;
    const looking = files.getMeta(meta.id).finally(() => (settled = true));
    looking.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(looking).rejects.toMatchObject({ code: "ETIMEDOUT", message: "The document store could not be read (ETIMEDOUT). Try again." });
    expect(((await looking.catch((error: unknown) => error)) as Error).cause).toMatchObject({ message: "The store did not answer within 30 s." });

    const unlimited = createLargeFiles({ requireOwner: false, store, storeTimeoutMs: 0, maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    let done = false;
    const waiting = unlimited.getMeta(meta.id).then((found) => {
      done = true;
      return found;
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(done).toBe(false);
    releaseAll();
    expect((await waiting)?.name).toBe("a.txt");
  });

  it("is a run.error of a question whose errorInfoOf is a store failure, 503, to retry", async () => {
    const store = new Hanging();
    const files = createLargeFiles({ requireOwner: false, store, storeTimeoutMs: 50, maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });
    store.hung.add("get");
    const events: AskEvent[] = [];
    const asked = askWithFiles({ files, model: fakeModel([says("ok")]), documentIds: [meta.id], messages: [{ role: "user", text: "What is on line 2?" }], onEvent: (event) => events.push(event) });
    const outcome = await within(asked, 10_000);
    expect(outcome).not.toBe("pending");
    const failure = (outcome as { error?: unknown }).error;
    expect(errorInfoOf(failure)).toMatchObject({ category: "store", code: "ETIMEDOUT", status: 503, retryable: true });
    const last = events.at(-1)!;
    expect(last.type).toBe("run.error");
    expect(errorInfoOf((last as Extract<AskEvent, { type: "run.error" }>).error)).toMatchObject({ category: "store", status: 503, retryable: true });
  });
});

describe("AccessOptions.signal: each caller stops its own wait", () => {
  it("leaves the other caller of one opening waiting, and serves it once the store answers", async () => {
    const store = new Hanging();
    const files = createLargeFiles({ requireOwner: false, store, storeTimeoutMs: 0 });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\nthree\n") });
    store.hung.add("get");
    store.calls.length = 0;
    const first = new AbortController();
    const second = new AbortController();
    const left = new Error("The first user pressed stop.");
    const one = files.prepare([meta.id], { tokens: 0, bytes: 0 }, { signal: first.signal });
    const two = files.prepare([meta.id], { tokens: 0, bytes: 0 }, { signal: second.signal });
    await expect.poll(() => store.calls.filter((call) => call === "get").length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both wait on the one opening of the document.
    expect(store.calls.filter((call) => call === "get")).toHaveLength(1);
    first.abort(left);
    expect(await within(one, 5_000)).toEqual({ error: left });
    expect(await within(two, 50)).toBe("pending");
    releaseAll();
    const prepared = await two;
    expect(prepared.missing).toEqual([]);
    expect(prepared.blocks.get(meta.id)).toContain("one\ntwo\nthree");
    expect(store.calls.filter((call) => call === "get")).toHaveLength(1);
    // The document opened for the second caller is kept: the next look reads it from memory.
    await files.prepare([meta.id], { tokens: 0, bytes: 0 });
    expect(store.calls.filter((call) => call === "get")).toHaveLength(1);
  });

  it("ends the app's wait in getMeta, getOriginal and delete with the signal's reason", async () => {
    const store = new Hanging();
    const files = createLargeFiles({ requireOwner: false, store, storeTimeoutMs: 0, keepOriginals: ["text"] });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("one\ntwo\n") });
    for (const method of ["getMeta", "getOriginal", "delete"] as const) {
      store.hung.add(method);
      const controller = new AbortController();
      const reason = new Error(`Stopped ${method}.`);
      const call: Promise<unknown> = method === "getMeta" ? files.getMeta(meta.id, { signal: controller.signal })
        : method === "getOriginal" ? files.getOriginal(meta.id, { signal: controller.signal })
          : files.delete(meta.id, { signal: controller.signal });
      await expect.poll(() => store.calls.at(-1)).toBe(method);
      controller.abort(reason);
      expect(await within(call, 5_000), method).toEqual({ error: reason });
      store.hung.clear();
      releaseAll();
    }
    // A caller that has left starts no call.
    const gone = AbortSignal.abort(new Error("Gone."));
    store.calls.length = 0;
    await expect(files.getMeta(meta.id, { signal: gone })).rejects.toThrow("Gone.");
    expect(store.calls).toEqual([]);
    // A signal that is not an AbortSignal is a mistake of the call.
    await expect(files.getMeta(meta.id, { signal: "soon" as unknown as AbortSignal })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the upload handlers and a store that does not answer (LO-3)", () => {
  async function serve(store: DocumentStore, onUploaded?: () => void): Promise<string> {
    const files = createLargeFiles({ requireOwner: false, store, storeTimeoutMs: 100, maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    const handlers = createDocumentHandlers(files, onUploaded ? { onUploaded } : {});
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "DELETE") void handlers.remove(request, response, url.pathname.slice(1));
      else void handlers.upload(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("answers the hook's error once the rollback delete passes the limit, and the delete goes on alone", async () => {
    const store = new Hanging();
    store.hung.add("delete");
    const base = await serve(store, () => {
      throw Object.assign(new Error("This chat has too many files."), { status: 409 });
    });
    const answer = await within(fetch(`${base}/`, { method: "POST", headers: { "X-File-Name": "notes.txt" }, body: "one\ntwo\n", signal: AbortSignal.timeout(20_000) }), 10_000);
    expect(answer).not.toBe("pending");
    const response = (answer as { value: Response }).value;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This chat has too many files.", category: "unknown" });
    expect(store.calls).toContain("delete");
  });

  it("answers the DELETE route 503 with Retry-After when the store does not answer", async () => {
    const store = new Hanging();
    const meta: DocumentMeta = await createLargeFiles({ requireOwner: false, store }).ingest({ name: "notes.txt", bytes: bytes("one\n") });
    store.hung.add("delete");
    const base = await serve(store);
    const answer = await within(fetch(`${base}/${meta.id}`, { method: "DELETE", signal: AbortSignal.timeout(20_000) }), 10_000);
    expect(answer).not.toBe("pending");
    const response = (answer as { value: Response }).value;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "The document could not be deleted (ETIMEDOUT). Try again.", code: "ETIMEDOUT", category: "store", retryAfterMs: 5000 });
  });
});
