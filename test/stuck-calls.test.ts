// Store calls left stuck (LO-5, 0.10.0): a call past `storeTimeoutMs` counts as stuck until it
// ends, whether its caller timed out or left; the count is the process's, as libuv's pool of
// threads is; while it is at `maxStuckStoreCalls` (half of UV_THREADPOOL_SIZE, 2 by default), new
// store calls fail at once with "STORE_STUCK", without calling the store. A sweep never counts.
// Probes p6b and p6c: 4 file calls that do not answer froze every file call and DNS look-up of a
// process with the default pool of 4 threads. Fake timers, set once the documents are ingested (a
// PDF parser waits on timers of its own): no wall-clock bound.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, DocumentStoreError, MemoryDocumentStore, TOOL_NAMES, type DocumentContext, type DocumentStore, type StoredDocument } from "llm-large-files";
import { utf8 } from "llm-large-files/testing";
import { numberedPdf } from "./pdf-fixtures.js";

/** Calls held by the stores of a test: each is let go at the test's end, so that none stays stuck. */
const held: Array<() => void> = [];
const releaseAll = () => held.splice(0).forEach((release) => release());

const POOL = "UV_THREADPOOL_SIZE";
let pool: string | undefined;
beforeEach(() => {
  pool = process.env[POOL];
  delete process.env[POOL];
});
afterEach(async () => {
  releaseAll();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  if (pool === undefined) delete process.env[POOL];
  else process.env[POOL] = pool;
});

/** A memory store whose named methods do not answer while their name is in `hung`, and that counts its calls. */
class Holding implements DocumentStore {
  readonly hung = new Set<string>();
  readonly calls: string[] = [];
  readonly #inner = new MemoryDocumentStore();

  #maybe<T>(method: string, then: () => Promise<T>): Promise<T> {
    this.calls.push(method);
    if (!this.hung.has(method)) return then();
    return new Promise<void>((resolve) => held.push(resolve)).then(then);
  }

  put(document: StoredDocument, context?: DocumentContext) {
    return this.#maybe("put", () => this.#inner.put(document, context));
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
  /** A sweep that takes `sweepMs` of the (fake) clock. */
  sweepMs = 0;
  async sweep(now?: Date, context?: DocumentContext) {
    this.calls.push("sweep");
    await new Promise((resolve) => setTimeout(resolve, this.sweepMs));
    return this.#inner.sweep(now, context);
  }
}

/** Lets the promises that are due settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);
/**
 * Turns of the event loop (real ones: an ingest pauses with setImmediate, which the fake timers
 * leave alone) until `reached` holds. The fake clock does not move meanwhile.
 */
async function turnsUntil(reached: () => boolean): Promise<void> {
  for (let turn = 0; turn < 10_000 && !reached(); turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(reached()).toBe(true);
}
/** The clock of the timers, from here on: moved by the test. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

/** A library over a `Holding` store, with two documents; then the timers are fake, unless `fake` is false. */
async function setUp(options: Parameters<typeof createLargeFiles>[0] extends infer O ? Partial<O> : never = {}, fake = true) {
  const store = new Holding();
  const files = createLargeFiles({ store, keepOriginals: ["pdf"], ...options });
  const a = await files.ingest({ name: "a.txt", bytes: utf8("alpha\n") });
  const b = await files.ingest({ name: "b.txt", bytes: utf8("beta\n") });
  store.calls.length = 0;
  if (fake) fakeTimers();
  return { store, files, a, b };
}

describe("calls past the time limit", () => {
  it("count once past storeTimeoutMs; at 2 (the default pool), the next call fails at once; the count drops as they end", async () => {
    const { store, files, a, b } = await setUp();
    expect(files.stats()).toMatchObject({ stuckStoreCalls: 0, maxStuckStoreCalls: 2 });
    store.hung.add("getMeta");
    const first = files.getMeta(a.id).catch((error: unknown) => error);
    const second = files.getMeta(b.id).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(files.stats().stuckStoreCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toMatchObject({ code: "ETIMEDOUT" });
    expect(await second).toMatchObject({ code: "ETIMEDOUT" });
    expect(files.stats().stuckStoreCalls).toBe(2);

    // The third fails at once, and the store is not called.
    store.hung.clear();
    const calls = store.calls.length;
    const third = await files.getMeta(a.id).catch((error: unknown) => error);
    expect(DocumentStoreError.is(third)).toBe(true);
    expect(third).toMatchObject({ code: "STORE_STUCK", operation: "read", status: 503, message: "The document store could not be read (STORE_STUCK). Try again." });
    expect(store.calls.length).toBe(calls);
    // Every store call of the library: delete, prepare, the tools, getOriginal.
    await expect(files.delete(a.id)).rejects.toMatchObject({ code: "STORE_STUCK" });
    await expect(files.prepare([a.id], { tokens: 0, bytes: 0 })).rejects.toMatchObject({ code: "STORE_STUCK" });
    await expect(files.getOriginal(a.id)).rejects.toMatchObject({ code: "STORE_STUCK" });
    expect(store.calls.length).toBe(calls);

    // The calls that hung end: the count drops, and the store is called again.
    releaseAll();
    await settle();
    expect(files.stats().stuckStoreCalls).toBe(0);
    expect((await files.getMeta(a.id))?.name).toBe("a.txt");
  });

  it("is half of UV_THREADPOOL_SIZE, read when the library is made, and at least 1", async () => {
    const limitWith = (size: string | undefined, given?: number) => {
      if (size === undefined) delete process.env[POOL];
      else process.env[POOL] = size;
      return createLargeFiles({ store: new MemoryDocumentStore(), ...(given !== undefined ? { maxStuckStoreCalls: given } : {}) }).stats().maxStuckStoreCalls;
    };
    expect(limitWith(undefined)).toBe(2);
    expect(limitWith("32")).toBe(16);
    expect(limitWith("4")).toBe(2);
    expect(limitWith("1")).toBe(1);
    expect(limitWith("7")).toBe(3);
    expect(limitWith("not a number")).toBe(2);
    expect(limitWith("32", 5)).toBe(5);
    expect(limitWith(undefined, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(() => limitWith(undefined, Number.NaN)).toThrow(RangeError);
    // Read when the library is made: a later change of the variable changes nothing.
    process.env[POOL] = "32";
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    process.env[POOL] = "2";
    expect(files.stats().maxStuckStoreCalls).toBe(16);
  });

  it("lets 16 calls be stuck with UV_THREADPOOL_SIZE=32 before the next fails at once", async () => {
    process.env[POOL] = "32";
    const { store, files, a } = await setUp();
    store.hung.add("getMeta");
    const stuck = Array.from({ length: 16 }, () => files.getMeta(a.id).catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(30_000);
    for (const call of stuck) expect(await call).toMatchObject({ code: "ETIMEDOUT" });
    expect(files.stats()).toMatchObject({ stuckStoreCalls: 16, maxStuckStoreCalls: 16 });
    await expect(files.getMeta(a.id)).rejects.toMatchObject({ code: "STORE_STUCK" });
  });

  it("does not count a call whose caller left, when the call ends within the limit", async () => {
    const { store, files, a } = await setUp();
    store.hung.add("getMeta");
    const controllers = [new AbortController(), new AbortController()];
    const calls = controllers.map((controller) => files.getMeta(a.id, { signal: controller.signal }).catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(10_000);
    // Two users press stop during reads that are slow, but end.
    for (const controller of controllers) controller.abort(new Error("Stopped."));
    for (const call of calls) expect(await call).toMatchObject({ message: "Stopped." });
    await vi.advanceTimersByTimeAsync(10_000);
    releaseAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(files.stats().stuckStoreCalls).toBe(0);
    store.hung.clear();
    expect((await files.getMeta(a.id))?.name).toBe("a.txt");
  });

  it("counts a call whose caller left once the call passes the limit, until it ends", async () => {
    const { store, files, a } = await setUp();
    store.hung.add("getMeta");
    const controller = new AbortController();
    const call = files.getMeta(a.id, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort(new Error("Stopped."));
    expect(await call).toMatchObject({ message: "Stopped." });
    expect(files.stats().stuckStoreCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(files.stats().stuckStoreCalls).toBe(1);
    releaseAll();
    await settle();
    expect(files.stats().stuckStoreCalls).toBe(0);
  });

  it("is one count for the process: the calls of one library refuse those of another, each by its own limit", async () => {
    const one = await setUp({}, false);
    const two = await setUp({ maxStuckStoreCalls: 3 });
    one.store.hung.add("getMeta");
    const stuck = [one.files.getMeta(one.a.id), one.files.getMeta(one.b.id)].map((call) => call.catch(() => undefined));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(stuck);
    expect(two.files.stats()).toMatchObject({ stuckStoreCalls: 2, maxStuckStoreCalls: 3 });
    await expect(one.files.getMeta(one.a.id)).rejects.toMatchObject({ code: "STORE_STUCK" });
    expect((await two.files.getMeta(two.a.id))?.name).toBe("a.txt");
  });

  it("does not count a sweep of 40 s: reads go on meanwhile; sweepTimeoutMs gives up on one, which still never counts", async () => {
    const { store, files, a } = await setUp();
    store.sweepMs = 40_000;
    let swept: number | undefined;
    const sweeping = files.sweep().then((count) => (swept = count));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(files.stats().stuckStoreCalls).toBe(0);
    expect((await files.getMeta(a.id))?.name).toBe("a.txt");
    await vi.advanceTimersByTimeAsync(5_000);
    await sweeping;
    expect(swept).toBe(0);

    const limited = createLargeFiles({ store, sweepTimeoutMs: 1_000 });
    const failed = limited.sweep().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await failed).toMatchObject({ name: "DocumentStoreError", operation: "sweep", code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(limited.stats().stuckStoreCalls).toBe(0);
  });

  it("counts a look at pages whose original does not answer, and gives its turn back", async () => {
    const store = new Holding();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"], maxConcurrentPageLooks: 1 });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(3) });
    store.hung.add("getOriginal");
    fakeTimers();
    const look = files.tools([meta], { viewPages: true }).executeWithFiles(TOOL_NAMES.view, { document_id: meta.id, from_page: 1 }).catch((error: unknown) => error);
    await settle();
    expect(files.stats().pageLooks.active).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await look;
    expect(JSON.stringify(result)).toContain("ETIMEDOUT");
    expect(files.stats()).toMatchObject({ stuckStoreCalls: 1, pageLooks: { active: 0, waiting: 0 } });
    releaseAll();
    await settle();
    expect(files.stats().stuckStoreCalls).toBe(0);
  });
});

describe("the store calls of an ingest", () => {
  it("count once past the time the ingest gives them, and are refused at the limit without calling the store", async () => {
    const { store, files, a } = await setUp({ ingestTimeoutMs: 1_000 });
    store.hung.add("put");
    const first = files.ingest({ name: "c.txt", bytes: utf8("gamma\n") }).catch((error: unknown) => error);
    // Its turn of the clock comes once the text is read: the time limit of its writes starts then.
    await turnsUntil(() => store.calls.includes("put"));
    await vi.advanceTimersByTimeAsync(999);
    expect(files.stats().stuckStoreCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(files.stats().stuckStoreCalls).toBe(1);
    // Its removal of what was written waits for the write, as long again.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toMatchObject({ name: "DocumentStoreError", code: "ETIMEDOUT", operation: "write" });
    expect(files.stats().stuckStoreCalls).toBe(1);

    // A read past the limit brings the process to 2, the default limit.
    store.hung.add("getMeta");
    const read = files.getMeta(a.id).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await read).toMatchObject({ code: "ETIMEDOUT" });
    expect(files.stats().stuckStoreCalls).toBe(2);

    // An ingest now is refused at its writes, and the store is not called.
    store.hung.clear();
    const calls = store.calls.length;
    const events: string[] = [];
    const refused = files.ingest({ name: "d.txt", bytes: utf8("delta\n"), onEvent: (event) => events.push(event.type) }).catch((error: unknown) => error);
    await turnsUntil(() => events.includes("ingest.error"));
    expect(await refused).toMatchObject({ name: "DocumentStoreError", code: "STORE_STUCK", operation: "write", status: 503 });
    expect(store.calls.length).toBe(calls);
    // So is an ingest under an application's ID, at its first look at the store.
    await expect(files.ingest({ name: "e.txt", bytes: utf8("epsilon\n"), id: "upload-1" })).rejects.toMatchObject({ code: "STORE_STUCK", operation: "read" });
    expect(store.calls.length).toBe(calls);

    // The calls that hung end: the count drops, and ingests are stored again.
    releaseAll();
    await settle();
    expect(files.stats().stuckStoreCalls).toBe(0);
    const stored = files.ingest({ name: "f.txt", bytes: utf8("zeta\n"), id: "upload-2" });
    await turnsUntil(() => store.calls.includes("put"));
    expect((await stored).id).toBe("upload-2");
  });

  it("count the look-up of an application's ID once past the time the ingest gives it", async () => {
    const { store, files } = await setUp({ ingestTimeoutMs: 1_000 });
    store.hung.add("getMeta");
    const ingest = files.ingest({ name: "c.txt", bytes: utf8("gamma\n"), id: "upload-1" }).catch((error: unknown) => error);
    await settle();
    expect(store.calls).toEqual(["getMeta"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(files.stats().stuckStoreCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ingest).toMatchObject({ name: "DocumentStoreError", code: "ETIMEDOUT", operation: "read" });
    expect(files.stats().stuckStoreCalls).toBe(1);
    releaseAll();
    await settle();
    expect(files.stats().stuckStoreCalls).toBe(0);
  });
});

describe("removals in a library", () => {
  it("run one at a time, and a removal that does not answer holds the turn until it ends", async () => {
    const { store, files, a, b } = await setUp({ maxStuckStoreCalls: Number.POSITIVE_INFINITY });
    store.hung.add("delete");
    const first = files.delete(a.id).catch((error: unknown) => error);
    const second = files.delete(b.id).catch((error: unknown) => error);
    await settle();
    // The second waits for its turn: the store has one removal.
    expect(store.calls.filter((call) => call === "delete")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ code: "ETIMEDOUT", operation: "delete" });
    // The second gave up on its turn after the same time, without calling the store.
    expect(await second).toMatchObject({ code: "ETIMEDOUT", operation: "delete" });
    expect(store.calls.filter((call) => call === "delete")).toHaveLength(1);
    // The first removal ends: the turn is free again.
    store.hung.clear();
    releaseAll();
    await settle();
    expect(await files.delete(b.id)).toBe(true);
    expect(await files.getMeta(a.id)).toBeUndefined();
  });

  it("gives the turn back to the next removal as soon as one ends", async () => {
    const { store, files, a, b } = await setUp();
    store.hung.add("delete");
    const first = files.delete(a.id);
    const second = files.delete(b.id);
    await settle();
    expect(store.calls.filter((call) => call === "delete")).toHaveLength(1);
    store.hung.clear();
    releaseAll();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });
});
