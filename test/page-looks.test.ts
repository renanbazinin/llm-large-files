// Looks at pages take their turns in a library (P10, 0.9.0): `maxConcurrentPageLooks` (default 1)
// and `pageLookWaitMs` (default 30,000). Six looks at once ran together, each about four times
// slower, and held 352 MB more than one. A look waits for its turn before its PDF is loaded.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, TOOL_NAMES, type AskEvent, type LargeFilesOptions } from "llm-large-files";
import { calls, fakeModel, says } from "./fake-model.js";
import { numberedPdf } from "./pdf-fixtures.js";

const BUSY = "report.pdf: The pages cannot be looked at right now; the server is busy. Answer from the text, or look again later.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A library that keeps PDFs, over a store whose originals take `loadMs` to load, and that counts the loads under way. */
async function library(options: Partial<LargeFilesOptions> = {}, loadMs: (load: number) => number = () => 20) {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, keepOriginals: ["pdf"], ...options });
  const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(3) });
  const loads = { started: 0, now: 0, most: 0 };
  const getOriginal = store.getOriginal.bind(store);
  store.getOriginal = async (id, context) => {
    const load = loads.started++;
    loads.most = Math.max(loads.most, ++loads.now);
    try {
      await sleep(loadMs(load));
      return await getOriginal(id, context);
    } finally {
      loads.now--;
    }
  };
  /** A look from a tool set of its own, as each question has. */
  const look = (signal?: AbortSignal, busy?: (id: string) => void) => files.tools([meta], { viewPages: true, ...(signal ? { signal } : {}) })
    .executeWithFiles(TOOL_NAMES.view, { document_id: meta.id, from_page: 2 }, {}, busy ? { onPagesBusy: busy } : {});
  return { files, meta, loads, look };
}

describe("looks at pages", () => {
  it("take their turns over the tool sets of a library: one at a time by default", async () => {
    const { loads, look } = await library();
    const outputs = await Promise.all(Array.from({ length: 6 }, () => look()));
    expect(outputs.every((output) => output.files.length === 1 && output.result.pages === "2")).toBe(true);
    expect(loads).toMatchObject({ started: 6, most: 1 });
  });

  it("take as many turns at once as maxConcurrentPageLooks says, and all of them with Infinity", async () => {
    const three = await library({ maxConcurrentPageLooks: 3 });
    await Promise.all(Array.from({ length: 6 }, () => three.look()));
    expect(three.loads.most).toBe(3);
    const all = await library({ maxConcurrentPageLooks: Infinity });
    await Promise.all(Array.from({ length: 6 }, () => all.look()));
    expect(all.loads.most).toBe(6);
  });

  it("tell the model that the server is busy past pageLookWaitMs, without loading the PDF", async () => {
    // The first look holds its turn for 400 ms; the second waits 50.
    const { loads, look, meta } = await library({ pageLookWaitMs: 50 }, (load) => (load === 0 ? 400 : 1));
    const busy: string[] = [];
    const first = look();
    const second = await look(undefined, (id) => busy.push(id));
    expect(second).toEqual({ result: { error: BUSY }, files: [] });
    expect(busy).toEqual([meta.id]);
    expect(loads.started).toBe(1);
    expect((await first).files).toHaveLength(1);
    // The turn is free again: the next look runs.
    expect((await look()).files).toHaveLength(1);
  });

  it("stop waiting when the tool set is stopped, and load nothing", async () => {
    const { loads, look } = await library({}, (load) => (load === 0 ? 200 : 1));
    const first = look();
    const stop = new AbortController();
    const reason = new Error("The user stopped the question.");
    const waiting = look(stop.signal);
    await sleep(20);
    stop.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    await first;
    expect(loads.started).toBe(1);
    expect((await look()).files).toHaveLength(1);
    expect(loads.started).toBe(2);
  });

  it("give a page_looks_busy notice in a question", async () => {
    const { files, meta } = await library({ pageLookWaitMs: 30 }, (load) => (load === 0 ? 300 : 1));
    const view = { name: "view_pages", args: { document_id: meta.id, from_page: 2 } };
    // Another question's look holds the turn.
    const other = askWithFiles({ files, model: fakeModel([calls([view]), says("Page 2.")]), documentIds: [meta.id], messages: [{ role: "user", text: "Page 2?" }] });
    await sleep(10);
    const events: AskEvent[] = [];
    const model = fakeModel([calls([view]), says("The pages could not be looked at.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "Page 2?" }], onEvent: (event) => events.push(event) });
    expect(result.answered).toBe(true);
    const end = events.find((event) => event.type === "tool.end");
    expect(end).toMatchObject({ outcome: "error", error: BUSY });
    expect(events.filter((event) => event.type === "notice" && event.code === "page_looks_busy")).toEqual([
      expect.objectContaining({ display: "none", documentIds: [meta.id], message: "The pages of report.pdf were not looked at: the server was busy with other looks at pages." }),
    ]);
    expect((await other).answered).toBe(true);
  });

  it("refuse a limit that is not a number", async () => {
    const store = new MemoryDocumentStore();
    expect(() => createLargeFiles({ store, maxConcurrentPageLooks: "2" as unknown as number })).toThrow(new TypeError('maxConcurrentPageLooks must be a number, and is "2".'));
    expect(() => createLargeFiles({ store, pageLookWaitMs: Number.NaN })).toThrow(new RangeError("pageLookWaitMs must be a number, and is NaN. Leave it out for the default."));
  });
});
