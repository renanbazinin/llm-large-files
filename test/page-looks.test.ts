// Looks at pages take their turns in a library (P10, 0.9.0): `maxConcurrentPageLooks` (default 1)
// and `pageLookWaitMs` (default 30,000). Six looks at once ran together, each about four times
// slower, and held 352 MB more than one. A look waits for its turn before its PDF is loaded.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, TOOL_NAMES, type AskEvent, type LargeFilesOptions, type ToolCallHooks } from "llm-large-files";
import { calls, fakeModel, says } from "./fake-model.js";
import { numberedPdf } from "./pdf-fixtures.js";

const BUSY = "report.pdf: The pages cannot be looked at right now; the server is busy. Answer from the text, or look again later.";
const LATE = "The original file of report.pdf could not be read in time, so its pages cannot be shown. Answer from the text.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A library that keeps PDFs, over a store whose originals take `loadMs` to load (or until the
 * promise it returns settles), and that counts the loads under way. The PDF is ingested by a
 * library of its own, so that `options` (a short `ingestTimeoutMs`) apply to the looks alone.
 */
async function library(options: Partial<LargeFilesOptions> = {}, loadMs: (load: number) => number | Promise<unknown> = () => 20) {
  const store = new MemoryDocumentStore();
  const meta = await createLargeFiles({ store, keepOriginals: ["pdf"] }).ingest({ name: "report.pdf", bytes: numberedPdf(3) });
  const files = createLargeFiles({ store, keepOriginals: ["pdf"], ...options });
  const loads = { started: 0, now: 0, most: 0 };
  const getOriginal = store.getOriginal.bind(store);
  store.getOriginal = async (id, context) => {
    const load = loads.started++;
    loads.most = Math.max(loads.most, ++loads.now);
    try {
      const wait = loadMs(load);
      await (typeof wait === "number" ? sleep(wait) : wait);
      return await getOriginal(id, context);
    } finally {
      loads.now--;
    }
  };
  /** A look from a tool set of its own, as each question has. */
  const look = (signal?: AbortSignal, hooks: ToolCallHooks | ((id: string) => void) = {}) => files.tools([meta], { viewPages: true, ...(signal ? { signal } : {}) })
    .executeWithFiles(TOOL_NAMES.view, { document_id: meta.id, from_page: 2 }, {}, typeof hooks === "function" ? { onPagesBusy: hooks } : hooks);
  return { files, meta, loads, look, store };
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

  it("give their turn back when the question is stopped during a slow load, and cut no pages then", async () => {
    // 0.9.0 before its checks: the load went on with the turn held, and the stopped look still
    // cut its pages once the load returned. Every other look of the library was told "busy".
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { loads, look } = await library({ pageLookWaitMs: 300 }, (load) => (load === 0 ? gate : 1));
    const stop = new AbortController();
    const reason = new Error("The user stopped the question.");
    const holder = look(stop.signal);
    await sleep(20);
    expect(loads.now).toBe(1);
    stop.abort(reason);
    const ended = await Promise.race([holder.then(() => "resolved", (error: unknown) => error), sleep(200).then(() => "pending")]);
    expect(ended).toBe(reason);
    // The turn is free: the next look runs, without waiting for the load that was given up.
    const next = await look();
    expect(next.files).toHaveLength(1);
    finish();
  });

  it("give their turn back after the library's store-call cap when the original never comes", async () => {
    // A store whose getOriginal never answers (a network read without a time limit) held the turn
    // of every look of the library: each later look was told "busy". The cap is that of the
    // library's store writes: ingestTimeoutMs.
    const { loads, look } = await library({ ingestTimeoutMs: 150, pageLookWaitMs: 2_000 }, (load) => (load === 0 ? new Promise(() => undefined) : 1));
    const stuck = look();
    const next = look();
    expect((await next).files).toHaveLength(1);
    expect(await stuck).toEqual({ result: { error: LATE }, files: [] });
    expect(loads.started).toBe(2);
  });

  it("tell the hooks that a document deleted while its look waited is gone", async () => {
    const { files, look, meta } = await library({ pageLookWaitMs: 2_000 }, (load) => (load === 0 ? 150 : 1));
    const first = look();
    const gone: string[] = [];
    const waiting = look(undefined, { onDocumentGone: (id) => gone.push(id) });
    await sleep(20);
    await files.delete(meta.id);
    expect(await waiting).toEqual({ result: { error: `${meta.id} is no longer available on the server. Ask the user to attach the file again.` }, files: [] });
    expect(gone).toEqual([meta.id]);
    await first;
  });

  it("say that the original is gone, with no notice, when only the original is", async () => {
    const { look, store } = await library();
    store.getOriginal = async () => undefined;
    const gone: string[] = [];
    expect(await look(undefined, { onDocumentGone: (id) => gone.push(id) })).toEqual({
      result: { error: "The original file of report.pdf is no longer on the server, so its pages cannot be shown. Answer from the text." },
      files: [],
    });
    expect(gone).toEqual([]);
  });

  it("wait once in a turn: once a look of the turn was busy, its other looks do not wait", async () => {
    // Three looks of one turn, while another question held the turn, each waited pageLookWaitMs
    // in their turn: 90 s with the default.
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { files, meta } = await library({ pageLookWaitMs: 500 }, (load) => (load === 0 ? gate : 1));
    const view = (page: number) => ({ name: "view_pages", args: { document_id: meta.id, from_page: page } });
    const other = askWithFiles({ files, model: fakeModel([calls([view(1)]), says("Page 1.")]), documentIds: [meta.id], messages: [{ role: "user", text: "Page 1?" }] });
    await sleep(20);
    const events: AskEvent[] = [];
    const started = Date.now();
    const result = await askWithFiles({ files, model: fakeModel([calls([view(1), view(2), view(3)]), says("Busy.")]), documentIds: [meta.id], messages: [{ role: "user", text: "All pages?" }], onEvent: (event) => events.push(event) });
    const took = Date.now() - started;
    finish();
    expect(result.answered).toBe(true);
    expect(events.flatMap((event) => (event.type === "tool.end" ? [event.error] : []))).toEqual([BUSY, BUSY, BUSY]);
    expect(events.filter((event) => event.type === "notice" && event.code === "page_looks_busy")).toHaveLength(3);
    // One wait of 500 ms, not three.
    expect(took).toBeLessThan(1_000);
    expect((await other).answered).toBe(true);
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
