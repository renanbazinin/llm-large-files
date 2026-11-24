// A signal of one tool call (`ToolCallHooks.signal`, new in 0.10.0, I9): it ends that call alone,
// while the store hangs or the model reads, and the other calls of the tool set go on. It is joined
// with the tool set's own signal.
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type DocumentContext, type DocumentStore, type GenerateText, type StoredDocument } from "../src/index.js";
import { serviceLog, utf8 } from "./fake-model.js";
import { library as pageLooks, sleep } from "./page-look-library.js";

/** Calls held by the stores of a test: each is let go at the test's end. */
const held: Array<() => void> = [];
afterEach(() => held.splice(0).forEach((release) => release()));
const hang = <T>(then: () => Promise<T>): Promise<T> => new Promise<void>((resolve) => held.push(resolve)).then(then);

/**
 * A memory store that also reads by range, and holds the calls for the documents in `hung` until
 * the test ends: their metadata (`getMeta`) when `metaHung`, else their ranged reads.
 */
class Holding implements DocumentStore {
  readonly hung = new Set<string>();
  metaHung = false;
  readonly #inner = new MemoryDocumentStore();
  put(document: StoredDocument, context?: DocumentContext) {
    return this.#inner.put(document, context);
  }
  get(id: string, context?: DocumentContext) {
    return this.#inner.get(id, context);
  }
  getMeta(id: string, context?: DocumentContext) {
    return this.metaHung && this.hung.has(id) ? hang(() => this.#inner.getMeta(id, context)) : this.#inner.getMeta(id, context);
  }
  delete(id: string, context?: DocumentContext) {
    return this.#inner.delete(id, context);
  }
  async readTextRange(id: string, start: number, end: number, context?: DocumentContext): Promise<Uint8Array | undefined> {
    const read = async () => {
      const document = await this.#inner.get(id, context);
      return document && utf8(document.text).subarray(start, end);
    };
    return !this.metaHung && this.hung.has(id) ? hang(read) : read();
  }
}

/** Two logs read by range (none is loaded whole), and their store. */
async function library() {
  const store = new Holding();
  const files = createLargeFiles({ store, budget: { inlineTokens: 10, mapChunkTokens: 2_000 }, wholeDocumentBytes: 0, cacheBytes: 0, scanChunkBytes: 4_096 });
  const slow = await files.ingest({ name: "slow.log", bytes: utf8(serviceLog(800)) });
  const quick = await files.ingest({ name: "quick.log", bytes: utf8(serviceLog(800)) });
  return { files, store, slow, quick };
}

/** Rejects with "still waiting" after `ms`: a call that ignores its signal fails the test instead of hanging it. */
const within = <T>(promise: Promise<T>, ms = 3_000): Promise<T> => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("still waiting")), ms))]);

const reason = () => new Error("stopped by the user");

describe("ToolCallHooks.signal", () => {
  it("ends one call whose store hangs, while the other calls of the tool set finish", async () => {
    const { files, store, slow, quick } = await library();
    const tools = files.tools([slow, quick]);
    // Opened once while the store answers: the next reads of slow.log go to its ranged reads.
    await tools.execute("read_document", { document_id: slow.id, start_line: 1, end_line: 2 });
    store.hung.add(slow.id);
    const stop = new AbortController();
    const stopped = tools.executeWithFiles("search_document", { document_id: slow.id, query: "ERROR", mode: "exact" }, {}, { signal: stop.signal });
    const other = tools.executeWithFiles("search_document", { document_id: quick.id, query: "ERROR", mode: "exact" }, {});
    setTimeout(() => stop.abort(reason()), 50);
    await expect(within(stopped)).rejects.toThrow("stopped by the user");
    const { result } = await within(other);
    expect(result.total_matching_lines).toBeGreaterThan(0);
    // The tool set goes on: another call of it runs.
    store.hung.clear();
    expect((await tools.execute("read_document", { document_id: quick.id, start_line: 1, end_line: 2 })).lines).toBe("1-2");
  });

  it("ends a call that waits for a document's metadata", async () => {
    const { files, store, slow } = await library();
    store.metaHung = true;
    store.hung.add(slow.id);
    const stop = new AbortController();
    const waiting = files.tools([slow]).executeWithFiles("get_document_overview", { document_id: slow.id }, {}, { signal: stop.signal });
    setTimeout(() => stop.abort(reason()), 50);
    await expect(within(waiting)).rejects.toThrow("stopped by the user");
  });

  it("ends a whole-file read: no more parts are sent once it aborts", async () => {
    const { files, slow } = await library();
    const stop = new AbortController();
    let parts = 0;
    const generate: GenerateText = async ({ signal }) => {
      parts++;
      if (parts === 2) stop.abort(reason());
      // A reader that waits for its request: the read's signal ends it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      signal?.throwIfAborted();
      return "A note (L1).";
    };
    const reading = files.tools([slow], { generate }).executeWithFiles("analyze_whole_document", { document_id: slow.id, task: "Summarize." }, {}, { signal: stop.signal });
    await expect(within(reading)).rejects.toThrow("stopped by the user");
    const sent = parts;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(parts).toBe(sent);
    expect(sent).toBeLessThanOrEqual(4);
  });

  it("ends a regex search, and an aborted signal ends a call before it starts", async () => {
    const { files, slow } = await library();
    const tools = files.tools([slow]);
    const done = new AbortController();
    done.abort(reason());
    await expect(tools.executeWithFiles("search_document", { document_id: slow.id, query: "ERR(O)R", mode: "regex" }, {}, { signal: done.signal })).rejects.toThrow("stopped by the user");
    await expect(tools.executeWithFiles("search_document", { document_id: slow.id, query: "ERROR", mode: "keywords" }, {}, { signal: done.signal })).rejects.toThrow("stopped by the user");
    // Without it, the same call runs.
    expect((await tools.executeWithFiles("search_document", { document_id: slow.id, query: "ERR(O)R", mode: "regex" })).result.total_matching_lines).toBeGreaterThan(0);
  });

  it("is joined with the tool set's own signal", async () => {
    const { files, store, slow } = await library();
    const whole = new AbortController();
    const tools = files.tools([slow], { signal: whole.signal });
    await tools.execute("read_document", { document_id: slow.id, start_line: 1, end_line: 2 });
    store.hung.add(slow.id);
    const own = new AbortController();
    const waiting = tools.executeWithFiles("search_document", { document_id: slow.id, query: "ERROR", mode: "exact" }, {}, { signal: own.signal });
    setTimeout(() => whole.abort(new Error("the question was stopped")), 50);
    await expect(within(waiting)).rejects.toThrow("the question was stopped");
  });

  it("ends a look at pages that waits for its turn, and one whose original is being read", async () => {
    // The first look holds the one turn while its original loads, until the test lets it go.
    let letGo!: () => void;
    const loading = new Promise<void>((resolve) => (letGo = resolve));
    const { look } = await pageLooks({ maxConcurrentPageLooks: 1, pageLookWaitMs: 60_000 }, (load) => (load === 0 ? loading : 0));
    const ownFirst = new AbortController();
    const first = look(undefined, { signal: ownFirst.signal });
    await sleep(30);
    const own = new AbortController();
    const second = look(undefined, { signal: own.signal });
    setTimeout(() => own.abort(reason()), 30);
    await expect(within(second)).rejects.toThrow("stopped by the user");
    // The first, while its original is read: its turn goes back, and a third look gets it.
    ownFirst.abort(reason());
    await expect(within(first)).rejects.toThrow("stopped by the user");
    const third = await within(look());
    expect(third.result).toMatchObject({ pages: "2" });
    letGo();
  });
});
