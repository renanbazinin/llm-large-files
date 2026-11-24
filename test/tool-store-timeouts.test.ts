// A store that does not answer in time, inside a tool call (0.10.0): the call throws the
// `DocumentStoreError` of code "ETIMEDOUT" (or "STORE_STUCK") instead of answering the model with
// an error, so the question ends with `run.error`, a 503 to try again, and the model is sent no
// new text. Before, the model read "The document store could not be read (ETIMEDOUT). Try again."
// and went on. Other store errors are still told to the model.
import { afterEach, describe, expect, it } from "vitest";
import {
  askWithFiles, createLargeFiles, DocumentStoreError, errorInfoOf, MemoryDocumentStore,
  type AskEvent, type DocumentContext, type DocumentStore, type GenerateText, type StoredDocument,
} from "../src/index.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const held: Array<() => void> = [];
afterEach(() => held.splice(0).forEach((release) => release()));

const storeError = (code: string) => new DocumentStoreError(Object.assign(new Error(`The store said ${code}.`), { code }), { code });

/** A memory store that also reads by range; its ranged reads throw what `failure` returns, when it returns something, or hang while `hung`. */
class Ranged implements DocumentStore {
  failure?: () => unknown;
  hung = false;
  readonly #inner = new MemoryDocumentStore();
  put(document: StoredDocument, context?: DocumentContext) {
    return this.#inner.put(document, context);
  }
  get(id: string, context?: DocumentContext) {
    return this.#inner.get(id, context);
  }
  getMeta(id: string, context?: DocumentContext) {
    return this.#inner.getMeta(id, context);
  }
  delete(id: string, context?: DocumentContext) {
    return this.#inner.delete(id, context);
  }
  async readTextRange(id: string, start: number, end: number, context?: DocumentContext): Promise<Uint8Array | undefined> {
    const failure = this.failure?.();
    if (failure) throw failure;
    if (this.hung) await new Promise<void>((resolve) => held.push(resolve));
    const document = await this.#inner.get(id, context);
    return document && utf8(document.text).subarray(start, end);
  }
}

/** A log read by range, opened once while the store answers, so that the calls after read its text by range. */
async function opened(options: { storeTimeoutMs?: number } = {}) {
  const store = new Ranged();
  const files = createLargeFiles({ store, budget: { inlineTokens: 10, mapChunkTokens: 2_000 }, wholeDocumentBytes: 0, cacheBytes: 0, scanChunkBytes: 4_096, ...options });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(800)) });
  const tools = files.tools([meta]);
  await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 2 });
  return { store, files, meta, tools };
}

const search = (id: string) => ["search_document", { document_id: id, query: "ERROR", mode: "exact" }] as const;

describe("a store timeout inside a tool call", () => {
  it("is thrown by execute, not told to the model: ETIMEDOUT and STORE_STUCK", async () => {
    for (const code of ["ETIMEDOUT", "STORE_STUCK"]) {
      const { store, meta, tools } = await opened();
      store.failure = () => storeError(code);
      const [name, args] = search(meta.id);
      await expect(tools.execute(name, args)).rejects.toMatchObject({ name: "DocumentStoreError", code });
      await expect(tools.executeWithFiles("read_document", { document_id: meta.id, start_line: 400, end_line: 420 })).rejects.toMatchObject({ code });
    }
  });

  it("is thrown when the library's own time limit ends a ranged read that hangs", async () => {
    const { store, meta, tools } = await opened({ storeTimeoutMs: 50 });
    store.hung = true;
    const [name, args] = search(meta.id);
    await expect(tools.execute(name, args)).rejects.toMatchObject({ name: "DocumentStoreError", code: "ETIMEDOUT" });
  });

  it("is thrown from a part of a whole-file read, not taken for a part that could not be read", async () => {
    const { store, meta, files } = await opened();
    let parts = 0;
    const generate: GenerateText = async () => {
      parts++;
      return "A note (L1).";
    };
    const tools = files.tools([meta], { generate });
    store.failure = () => storeError("ETIMEDOUT");
    await expect(tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(parts).toBe(0);
    // The read was no read: it may be asked for again once the store answers.
    expect(tools.wholeReadsLeft?.(meta.id)).toBe(1);
    store.failure = undefined;
    expect((await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." })).parts_read).toBeGreaterThan(0);
  });

  it("stops the other parts of a whole-file read: no model request is sent after execute throws", async () => {
    for (const output of ["answer", "items"]) {
      const { store, meta, files } = await opened();
      let requests = 0;
      let afterwards = 0;
      let thrown = false;
      // The store gives up on the ranged read after the third part's request: other parts are under way then.
      let armed = false;
      store.failure = () => {
        if (!armed) return undefined;
        armed = false;
        return storeError("ETIMEDOUT");
      };
      const generate: GenerateText = async () => {
        requests++;
        if (thrown) afterwards++;
        if (requests === 3) armed = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return output === "items" ? "NOTHING RELEVANT" : "A note (L1).";
      };
      // 14 parts, read four at a time.
      const tools = files.tools([meta], { generate, budget: { mapChunkTokens: 4_000 } });
      const error = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize.", output }).then(() => undefined, (failed: unknown) => failed);
      thrown = true;
      expect(error).toMatchObject({ code: "ETIMEDOUT" });
      const before = requests;
      expect(before).toBeGreaterThanOrEqual(3);
      expect(before).toBeLessThan(10);
      // 0.10.0 before this fix: the other three workers read every part left, 20 requests and more.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(afterwards).toBe(0);
      expect(requests).toBe(before);
    }
  });

  it("keeps any other store error as an error result the model reads", async () => {
    const { store, meta, tools } = await opened();
    store.failure = () => storeError("EIO");
    const [name, args] = search(meta.id);
    expect(await tools.execute(name, args)).toEqual({ error: "The document store could not be read (EIO). Try again." });
  });

  it("ends the question with run.error, a 503 to try again, and the model sees no new text", async () => {
    const { store, files, meta } = await opened();
    // The store stops answering once the question is planned and the model asks for a search.
    const model = fakeModel([() => {
      store.failure = () => storeError("ETIMEDOUT");
      return calls([{ id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]);
    }, says("unused")]);
    const events: AskEvent[] = [];
    const asked = askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "How many errors?" }], onEvent: (event) => events.push(event) });
    const error = await asked.then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "DocumentStoreError", code: "ETIMEDOUT" });
    expect(errorInfoOf(error)).toMatchObject({ status: 503, retryable: true });
    expect(model.requests).toHaveLength(1);
    expect(events.some((event) => event.type === "run.error")).toBe(true);
    expect(events.some((event) => event.type === "run.finish")).toBe(false);
  });
});
