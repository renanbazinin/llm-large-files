// The question's abort where it waits (0.10.0): `askWithFiles` races `files.prepare` and every tool
// call with its signal, so that a store that hangs cannot hold the question past its abort, with
// any `LargeFiles`. The access the question passes on carries the signal too, for a library that
// ends its own waits with it. A tool call that rejects ends the question with `run.error`.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type DocumentStore, type LargeFiles, type PrepareOptions, type ToolOptions } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const never = new Promise<never>(() => undefined);

/** A memory store whose calls of `methods` never settle once `hang.on` is set. */
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

/** How the question ended, and how long after the abort, or "pending" when it had not after `patience` ms. */
async function settleAfterAbort(asking: Promise<unknown>, abortedAt: () => number | undefined, patience: number) {
  const outcome = await Promise.race([
    asking.then(() => ({ how: "resolved" as const }), (error: unknown) => ({ how: "rejected" as const, error })),
    new Promise<{ how: "pending" }>((resolve) => setTimeout(() => resolve({ how: "pending" }), patience)),
  ]);
  return { ...outcome, after: Date.now() - (abortedAt() ?? Date.now()) };
}

describe("the question's abort", () => {
  it("ends a question whose store hangs while it plans the documents (p2-hung-store)", async () => {
    const { store, hang } = hungStore(["getMeta", "get", "delete"]);
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    hang.on = true;
    const stop = new AbortController();
    let abortedAt: number | undefined;
    setTimeout(() => {
      abortedAt = Date.now();
      stop.abort(new Error("The user stopped the question."));
    }, 300);
    const events: AskEvent[] = [];
    const model = fakeModel([says("ok")]);
    const asking = askWithFiles({ files, model, documentIds: [meta.id], messages: question("q"), signal: stop.signal, onEvent: (event) => events.push(event) });
    // 0.9 was still waiting after 3 s.
    const outcome = await settleAfterAbort(asking, () => abortedAt, 3_000);
    expect(outcome).toMatchObject({ how: "rejected", error: { message: "The user stopped the question." } });
    expect(outcome.after).toBeLessThan(1_000);
    expect(model.requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "run.error", error: { message: "The user stopped the question." } });
  });

  it("ends a question whose store hangs inside a tool call (p3-hung-tool)", async () => {
    const { store, hang } = hungStore(["getMeta", "get", "readTextRange", "getIndex"]);
    const files = createLargeFiles({ store, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
    const stop = new AbortController();
    let abortedAt: number | undefined;
    const events: AskEvent[] = [];
    // The store hangs once the documents are planned: from the first model request on.
    const model = fakeModel([() => {
      hang.on = true;
      setTimeout(() => {
        abortedAt = Date.now();
        stop.abort(new Error("The user stopped the question."));
      }, 500);
      return calls([{ id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR" } }]);
    }, says("done")]);
    const asking = askWithFiles({ files, model, documentIds: [meta.id], messages: question("count errors"), signal: stop.signal, onEvent: (event) => events.push(event) });
    // 0.9 was still waiting after 4 s.
    const outcome = await settleAfterAbort(asking, () => abortedAt, 4_000);
    expect(outcome).toMatchObject({ how: "rejected", error: { message: "The user stopped the question." } });
    expect(outcome.after).toBeLessThan(1_000);
    expect(model.requests).toHaveLength(1);
    // The call that hung was ended, and nothing came after the error.
    expect(events.filter((event) => event.type === "tool.end")).toEqual([expect.objectContaining({ outcome: "error", error: "The user stopped the question." })]);
    expect(events.at(-1)).toMatchObject({ type: "run.error" });
  });

  it("passes the question's signal on with the access of every store call it asks for", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const prepared: Array<PrepareOptions | undefined> = [];
    const tooled: Array<ToolOptions | undefined> = [];
    const own: LargeFiles = {
      ...files,
      prepare: (ids, base, options) => {
        prepared.push(options);
        return files.prepare(ids, base, options);
      },
      tools: (documents, options) => {
        tooled.push(options);
        return files.tools(documents, options);
      },
    };
    const stop = new AbortController();
    const model = fakeModel([calls([{ id: "c1", name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } }]), says("done")]);
    await askWithFiles({ files: own, model, owner: "user-1", documentIds: [meta.id], messages: question("?"), signal: stop.signal });
    expect(prepared[0]).toMatchObject({ owner: "user-1", signal: stop.signal });
    expect(tooled[0]!.access).toEqual({ owner: "user-1", signal: stop.signal });
    // Without a signal, none.
    await askWithFiles({ files: own, model: fakeModel([says("done")]), documentIds: [meta.id], messages: question("?") });
    expect(prepared[1]).not.toHaveProperty("signal");
  });
});

describe("a tool call that rejects", () => {
  it("ends the question with run.error, and the model gets nothing of it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const timeout = Object.assign(new Error("The document store did not answer within 30 s."), { name: "DocumentStoreError", code: "ETIMEDOUT", status: 503 });
    const own: LargeFiles = {
      ...files,
      tools: (documents, options) => ({ ...files.tools(documents, options), executeWithFiles: async () => Promise.reject(timeout) }),
    };
    const events: AskEvent[] = [];
    const model = fakeModel([calls([{ id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]), says("done")]);
    const outcome = await askWithFiles({ files: own, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event) }).then(() => undefined, (error: unknown) => error);
    expect(outcome).toBe(timeout);
    expect(model.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.end")).toEqual([expect.objectContaining({ outcome: "error" })]);
    expect(events.at(-1)).toMatchObject({ type: "run.error", error: { status: 503 } });
  });
});
