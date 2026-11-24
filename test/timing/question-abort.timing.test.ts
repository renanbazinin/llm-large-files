// The question's abort while a store hangs (0.10.0), held to the clock: the question ends within
// 50 ms of the abort, whether it waits for planning or for a tool call (probes p2-hung-store and
// p3-hung-tool; 0.9 was still waiting after 3 and 4 s). The other tests of the abort are in
// test/question-abort.test.ts.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type DocumentStore } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "../fake-model.js";

const never = new Promise<never>(() => undefined);

function hungStore(methods: string[]) {
  const inner = new MemoryDocumentStore();
  const hang = { on: false };
  const store = new Proxy(inner, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => (hang.on && methods.includes(String(key)) ? never : (value as (...given: unknown[]) => unknown).apply(target, args));
    },
  }) as DocumentStore;
  return { store, hang };
}

/** Milliseconds from the abort to the end of the question. */
async function sinceAbort(asking: Promise<unknown>, abortedAt: () => number | undefined): Promise<number> {
  await asking.catch(() => undefined);
  return Date.now() - abortedAt()!;
}

describe("the question's abort over a store that hangs", () => {
  it("ends the question within 50 ms while it plans (a 300 ms signal)", async () => {
    const { store, hang } = hungStore(["getMeta", "get", "delete"]);
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    hang.on = true;
    const stop = new AbortController();
    let abortedAt: number | undefined;
    setTimeout(() => {
      abortedAt = Date.now();
      stop.abort(new Error("stopped"));
    }, 300);
    const asking = askWithFiles({ files, model: fakeModel([says("ok")]), documentIds: [meta.id], messages: [{ role: "user", text: "q" }], signal: stop.signal });
    expect(await sinceAbort(asking, () => abortedAt)).toBeLessThan(50);
  });

  it("ends the question within 50 ms while a search waits for the store (aborted at 500 ms)", async () => {
    const { store, hang } = hungStore(["getMeta", "get", "readTextRange", "getIndex"]);
    const files = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
    const stop = new AbortController();
    let abortedAt: number | undefined;
    const model = fakeModel([() => {
      hang.on = true;
      setTimeout(() => {
        abortedAt = Date.now();
        stop.abort(new Error("stopped"));
      }, 500);
      return calls([{ id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR" } }]);
    }, says("done")]);
    const asking = askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "count errors" }], signal: stop.signal });
    expect(await sinceAbort(asking, () => abortedAt)).toBeLessThan(50);
  });
});
