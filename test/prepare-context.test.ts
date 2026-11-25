// What planning (src/prepare.ts) asks of the library since `prepare` moved there in 0.10.0. The
// library makes the caller of each call (`PrepareContext.callerOf`), and planning makes every store
// call for that caller. So what the library puts on a caller reaches each of them, with no change to
// prepare.ts.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, resolveBudget, type DocumentMeta, type PrepareOptions } from "llm-large-files";
import type { Caller } from "../src/access.js";
import { prepareDocuments, type PrepareContext } from "../src/prepare.js";
import { SearchableDocument } from "../src/search.js";
import { utf8 } from "./fake-model.js";

const TEXT = "first line\nsecond line\n";
const base = { tokens: 0, bytes: 0 };

/** A context over one document, whose store calls note the caller they are made for. */
async function planning(callerOf: PrepareContext["callerOf"]) {
  const meta: DocumentMeta = await createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() }).ingest({ name: "notes.txt", bytes: utf8(TEXT) });
  const callers: Array<[string, Caller]> = [];
  const context: PrepareContext = {
    callerOf,
    metaFor: async (id, caller) => {
      callers.push(["metaFor", caller]);
      return id === meta.id ? meta : undefined;
    },
    load: async (_id, caller) => {
      callers.push(["load", caller]);
      return new SearchableDocument({ meta, text: TEXT });
    },
    stillOpened: async (_document, caller) => {
      callers.push(["stillOpened", caller]);
      return true;
    },
    budgetFor: (overrides) => resolveBudget(overrides),
    viewableMeta: () => false,
    rules: { requireOwner: false, requireScope: false },
  };
  return { meta, callers, context };
}

describe("PrepareContext.callerOf", () => {
  it("makes the caller from the options as given, and planning reads for that caller", async () => {
    const caller: Caller = { owner: "alice", context: { owner: "alice" }, key: "" };
    const given: Array<PrepareOptions | undefined> = [];
    const { meta, callers, context } = await planning((access) => {
      given.push(access);
      return caller;
    });
    const options: PrepareOptions = { owner: "alice", wholeDocumentAnalysis: false };
    const prepared = await prepareDocuments(context, [meta.id, "doc_gone"], base, options);
    expect(given).toHaveLength(1);
    expect(given[0]).toBe(options);
    expect(callers.map(([call]) => call)).toEqual(["metaFor", "metaFor", "load", "stillOpened"]);
    for (const [, made] of callers) expect(made).toBe(caller);
    expect(prepared.missing).toEqual(["doc_gone"]);
    expect(prepared.blocks.get(meta.id)).toContain("second line");
  });

  it("stops before any store call when the library refuses the caller", async () => {
    const { meta, callers, context } = await planning(() => {
      throw new TypeError("An owner is required.");
    });
    await expect(prepareDocuments(context, [meta.id], base)).rejects.toThrow(TypeError);
    expect(callers).toEqual([]);
  });

  it("is the library's own check of owner and scope", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: true });
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8(TEXT), owner: "alice" });
    await expect(files.prepare([meta.id], base)).rejects.toThrow(TypeError);
    expect((await files.prepare([meta.id], base, { owner: "alice" })).missing).toEqual([]);
    expect((await files.prepare([meta.id], base, { owner: "bob" })).missing).toEqual([meta.id]);
  });
});
