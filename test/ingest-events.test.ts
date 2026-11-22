import "./load-pdf-libraries.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, toDocumentSummary, type ExtractInput, type Extractor, type IngestEvent, type StoredDocument } from "llm-large-files";
import { isStoreWriteFailure } from "../src/errors.js";
import { numberedPdf } from "./pdf-fixtures.js";

const encoder = new TextEncoder();
type Progress = Extract<IngestEvent, { type: "ingest.progress" }>;

/** Collects the events of one ingest. */
function recorder() {
  const events: IngestEvent[] = [];
  return {
    events,
    onEvent: (event: IngestEvent) => void events.push(event),
    progress: (stage?: Progress["stage"]) => events.filter((event): event is Progress => event.type === "ingest.progress" && (stage === undefined || event.stage === stage)),
    /** The stages in the order they first reported. */
    stages: () => [...new Set(events.flatMap((event) => (event.type === "ingest.progress" ? [event.stage] : [])))],
  };
}

/** What every ingest's events have in common: seq from 1 without gaps, one run, start first, one terminal event last. */
function expectWellFormed(events: IngestEvent[]): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect(new Set(events.map((event) => event.runId)).size).toBe(1);
  expect(events[0]!.type).toBe("ingest.start");
  const terminal = events.filter((event) => event.type === "ingest.finish" || event.type === "ingest.error");
  expect(terminal).toHaveLength(1);
  expect(events.at(-1)).toBe(terminal[0]);
}

/** The last progress of a stage says it ran to its end. */
function expectStageEnded(progress: Progress[], unit: Progress["unit"], total?: number): void {
  expect(progress.length).toBeGreaterThan(0);
  const last = progress.at(-1)!;
  expect(last.unit).toBe(unit);
  if (total !== undefined) expect(last.total).toBe(total);
  expect(last.done).toBe(last.total);
  // Done never goes back within a stage.
  for (let index = 1; index < progress.length; index++) expect(progress[index]!.done).toBeGreaterThanOrEqual(progress[index - 1]!.done);
}

function logText(lines: number): string {
  const out: string[] = [];
  for (let index = 1; index <= lines; index++) {
    const second = String(index % 60).padStart(2, "0");
    out.push(index % 500 === 0
      ? `2026-05-01 12:00:${second} ERROR payment-service: timeout after ${index}ms calling ledger`
      : `2026-05-01 12:00:${second} INFO handled request ${index} in ${index % 40}ms`);
  }
  return out.join("\n");
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fileStore(): Promise<FileDocumentStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "llm-ingest-events-"));
  directories.push(directory);
  return new FileDocumentStore(directory);
}

describe("ingest events", () => {
  it("reports a PDF page by page: the check, the text, the pictures, then the writes", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
    const record = recorder();
    const bytes = numberedPdf(30);
    const meta = await files.ingest({ name: "report.pdf", bytes, onEvent: record.onEvent });
    const { events } = record;
    expectWellFormed(events);
    expect(events[0]).toMatchObject({ type: "ingest.start", name: "report.pdf", format: "pdf", bytes: bytes.byteLength });
    expect(events[0]!.runId).toMatch(/^ing_[0-9a-f]{16}$/);
    expect(events.at(-1)).toMatchObject({ type: "ingest.finish", document: toDocumentSummary(meta) });
    expectStageEnded(record.progress("check"), "pages", 30);
    expectStageEnded(record.progress("extract"), "pages", 30);
    expectStageEnded(record.progress("pictures"), "pages", 30);
    expectStageEnded(record.progress("prepare"), "characters");
    // The file kept, then the text. This store keeps no line index.
    expectStageEnded(record.progress("store"), "parts", 2);
    expect(record.stages()).toEqual(["check", "extract", "pictures", "prepare", "store"]);
    // Each stage ends before the next starts.
    const order = record.progress().map((event) => event.stage);
    expect(order).toEqual([...order].sort((left, right) => record.stages().indexOf(left) - record.stages().indexOf(right)));
  });

  it("reports the parts of a DOCX and of a PPTX", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const docx = new JSZip();
    docx.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Body text</w:t></w:r></w:p></w:body></w:document>");
    docx.file("word/header1.xml", "<w:hdr><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>");
    docx.file("word/footer1.xml", "<w:ftr><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:ftr>");
    const record = recorder();
    await files.ingest({ name: "notes.docx", bytes: await docx.generateAsync({ type: "uint8array" }), onEvent: record.onEvent });
    expectWellFormed(record.events);
    expectStageEnded(record.progress("extract"), "parts", 3);
    expect(record.events.at(-1)!.type).toBe("ingest.finish");

    const pptx = new JSZip();
    for (let slide = 1; slide <= 4; slide++) pptx.file(`ppt/slides/slide${slide}.xml`, `<p:sld><a:p><a:t>Slide ${slide}</a:t></a:p></p:sld>`);
    const deck = recorder();
    await files.ingest({ name: "deck.pptx", bytes: await pptx.generateAsync({ type: "uint8array" }), onEvent: deck.onEvent });
    expectWellFormed(deck.events);
    expectStageEnded(deck.progress("extract"), "parts", 4);
  });

  it("reports the preparing, indexing and storing of a log, under the run id given", async () => {
    const files = createLargeFiles({ store: await fileStore() });
    const record = recorder();
    const meta = await files.ingest({ name: "app.log", bytes: encoder.encode(logText(20_000)), runId: "upload_7", onEvent: record.onEvent });
    const { events } = record;
    expectWellFormed(events);
    expect(events.every((event) => event.runId === "upload_7")).toBe(true);
    expect(meta.format).toBe("log");
    expectStageEnded(record.progress("prepare"), "characters");
    expectStageEnded(record.progress("index"), "characters", meta.characters);
    // The line index, then the text.
    expectStageEnded(record.progress("store"), "parts", 2);
    // A UTF-8 text file is not decoded in steps, and the built-in text extractor reports nothing else.
    expect(record.stages()).toEqual(["prepare", "index", "store"]);
  });

  it("reports the decoding of a file that is not UTF-8 when it ends", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    // "café crème" in windows-1252, many times over.
    const line = [0x63, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x0a];
    const bytes = new Uint8Array(Array.from({ length: 200 }, () => line).flat());
    const record = recorder();
    await files.ingest({ name: "menu.txt", bytes, onEvent: record.onEvent });
    expectWellFormed(record.events);
    expect(record.progress("decode")).toEqual([expect.objectContaining({ stage: "decode", done: bytes.byteLength, total: bytes.byteLength, unit: "bytes" })]);
  });

  it("ends a refused file with ingest.error, and nothing after it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const record = recorder();
    await expect(files.ingest({ name: "app.log.gz", bytes: gzipSync(encoder.encode("hello")), onEvent: record.onEvent })).rejects.toThrow(/gzip/);
    expectWellFormed(record.events);
    expect(record.events.map((event) => event.type)).toEqual(["ingest.start", "ingest.error"]);
    expect(record.events.at(-1)).toMatchObject({ error: { message: expect.stringMatching(/gzip-compressed/), name: "Error" } });

    const empty = recorder();
    await expect(files.ingest({ name: "empty.txt", bytes: new Uint8Array(0), onEvent: empty.onEvent })).rejects.toThrow(/empty/);
    expect(empty.events.map((event) => event.type)).toEqual(["ingest.start", "ingest.error"]);
  });

  it("ends an aborted ingest with ingest.error, and drops the progress of an extractor that goes on", async () => {
    let late: (() => void) | undefined;
    // An extractor of your own that does not look at the signal, and reports after the ingest gave up.
    const slow: Extractor = async (_bytes, input) => {
      input.onProgress?.({ done: 1, total: 3, unit: "parts" });
      await new Promise<void>((resolve) => (late = resolve));
      input.onProgress?.({ done: 3, total: 3, unit: "parts" });
      return { text: "too late" };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: slow } });
    const record = recorder();
    const controller = new AbortController();
    const ingest = files.ingest({ name: "notes.txt", bytes: encoder.encode("text"), signal: controller.signal, onEvent: record.onEvent });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new DOMException("The upload was cancelled.", "AbortError"));
    await expect(ingest).rejects.toThrow("The upload was cancelled.");
    const seen = record.events.length;
    late!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(record.events).toHaveLength(seen);
    expectWellFormed(record.events);
    expect(record.events.at(-1)).toMatchObject({ type: "ingest.error", error: { name: "AbortError", message: "The upload was cancelled." } });
    expect(record.progress("extract")).toEqual([expect.objectContaining({ done: 1, total: 3, unit: "parts" })]);
  });

  it("reports no extract progress for an extractor of your own that never calls onProgress", async () => {
    const quiet: Extractor = async () => ({ text: "line one\nline two\n" });
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: quiet } });
    const record = recorder();
    await files.ingest({ name: "notes.txt", bytes: encoder.encode("ignored"), onEvent: record.onEvent });
    expectWellFormed(record.events);
    expect(record.progress("extract")).toEqual([]);
    expect(record.stages()).toEqual(["prepare", "store"]);
  });

  it("sends at most one progress event every 12 ms for a stage, and the last one", { timeout: 30_000 }, async () => {
    // An extractor that reports 20,000 times as fast as it can.
    const chatty: Extractor = async (_bytes, input) => {
      for (let done = 1; done <= 20_000; done++) input.onProgress?.({ done, total: 20_000, unit: "parts" });
      return { text: "done" };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: chatty } });
    const record = recorder();
    const started = performance.now();
    await files.ingest({ name: "notes.txt", bytes: encoder.encode("ignored"), onEvent: record.onEvent });
    const extract = record.progress("extract");
    expect(extract.length).toBeLessThanOrEqual(2 + Math.ceil((performance.now() - started) / 12));
    expect(extract[0]!.done).toBe(1);
    expect(extract.at(-1)).toMatchObject({ done: 20_000, total: 20_000 });

    // A large log: the steps between two events of a stage, but its last, are at least about 12 ms apart.
    const big = createLargeFiles({ store: await fileStore() });
    const log = recorder();
    await big.ingest({ name: "big.log", bytes: encoder.encode(logText(400_000)), onEvent: log.onEvent });
    expectWellFormed(log.events);
    for (const stage of log.stages()) {
      const progress = log.progress(stage);
      // Date.now() counts whole milliseconds: 12 ms apart can read as 11.
      for (let index = 1; index < progress.length - 1; index++) expect(progress[index]!.time - progress[index - 1]!.time).toBeGreaterThanOrEqual(11);
    }
  });

  it("passes on an error of the listener, and stores nothing", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
    const thrown = new Error("The listener failed.");
    const onEvent = (event: IngestEvent) => {
      if (event.type === "ingest.progress" && event.stage === "store") throw thrown;
    };
    const error = await files.ingest({ name: "report.pdf", bytes: numberedPdf(2), onEvent }).catch((caught: unknown) => caught);
    expect(error).toBe(thrown);
    expect(isStoreWriteFailure(error)).toBe(false);
    expect(await store.sweep(new Date(8.64e15))).toBe(0);

    // The page check gives up quietly on its own troubles, not on those of the listener.
    const onCheck = (event: IngestEvent) => {
      if (event.type === "ingest.progress" && event.stage === "check") throw thrown;
    };
    await expect(files.ingest({ name: "report.pdf", bytes: numberedPdf(2), onEvent: onCheck })).rejects.toBe(thrown);
  });

  it("keeps the throttle of each stage when stages take turns, and sends what each held back in the order they began", { timeout: 30_000 }, async () => {
    // An extractor that reports two stages in turn on every page, as fast as it can.
    const alternating: Extractor = async (_bytes, input) => {
      for (let done = 1; done <= 20_000; done++) {
        input.onProgress?.({ done, total: 20_000, unit: "pages" });
        input.onProgress?.({ stage: "pictures", done, total: 20_000, unit: "pages" });
      }
      return { text: "done" };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: alternating } });
    const record = recorder();
    const started = performance.now();
    await files.ingest({ name: "notes.txt", bytes: encoder.encode("ignored"), onEvent: record.onEvent });
    const most = 3 + Math.ceil((performance.now() - started) / 12);
    for (const stage of ["extract", "pictures"] as const) {
      const progress = record.progress(stage);
      expect(progress.length).toBeLessThanOrEqual(most);
      expect(progress.at(-1)).toMatchObject({ done: 20_000, total: 20_000 });
    }

    // Held back, then sent when the extractor returns: first the stage that began first.
    const halfway: Extractor = async (_bytes, input) => {
      input.onProgress?.({ done: 1, total: 3, unit: "pages" });
      input.onProgress?.({ stage: "pictures", done: 1, total: 3, unit: "pages" });
      input.onProgress?.({ done: 2, total: 3, unit: "pages" });
      input.onProgress?.({ stage: "pictures", done: 2, total: 3, unit: "pages" });
      return { text: "done" };
    };
    const held = recorder();
    await createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: halfway } })
      .ingest({ name: "notes.txt", bytes: encoder.encode("ignored"), onEvent: held.onEvent });
    expectWellFormed(held.events);
    expect(held.progress().slice(0, 4).map((event) => [event.stage, event.done])).toEqual([["extract", 1], ["pictures", 1], ["extract", 2], ["pictures", 2]]);
  });

  it("drops what an extractor reports after it returned", async () => {
    let report: ExtractInput["onProgress"];
    // An extractor of your own whose progress comes from elsewhere (a timer, a worker) and goes on after it returns.
    const lingering: Extractor = async (_bytes, input) => {
      report = input.onProgress;
      report?.({ done: 1, total: 2, unit: "parts" });
      return { text: "line one\nline two\n" };
    };
    // The late reports come while the document is written.
    class LateStore extends MemoryDocumentStore {
      override async put(document: StoredDocument): Promise<void> {
        report?.({ done: 2, total: 2, unit: "parts" });
        report?.({ stage: "check", done: 2, total: 2, unit: "pages" });
        await super.put(document);
      }
    }
    const files = createLargeFiles({ store: new LateStore(), extractors: { text: lingering } });
    const record = recorder();
    await files.ingest({ name: "notes.txt", bytes: encoder.encode("ignored"), onEvent: record.onEvent });
    expectWellFormed(record.events);
    expect(record.progress("extract")).toEqual([expect.objectContaining({ done: 1, total: 2 })]);
    expect(record.progress("check")).toEqual([]);
    expect(record.stages()).toEqual(["extract", "prepare", "store"]);
  });

  it("removes the document when the listener throws on ingest.finish", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
    const thrown = new Error("The listener failed.");
    const types: string[] = [];
    const onEvent = (event: IngestEvent) => {
      types.push(event.type);
      if (event.type === "ingest.finish") throw thrown;
    };
    await expect(files.ingest({ name: "report.pdf", bytes: numberedPdf(2), onEvent })).rejects.toBe(thrown);
    expect(types.at(-1)).toBe("ingest.finish");
    expect(await store.sweep(new Date(8.64e15))).toBe(0);
  });

  it("says only that the document could not be stored when the store fails, whatever it throws", async () => {
    // A string, and an error with a status and a name of its own: neither reaches the event.
    const failures: unknown[] = ["disk full at /srv/documents/tenant-7", Object.assign(new Error("PUT https://bucket.internal/doc failed"), { status: 503, name: "S3ServiceException" })];
    for (const failure of failures) {
      class FailingStore extends MemoryDocumentStore {
        override async put(): Promise<void> {
          throw failure;
        }
      }
      const files = createLargeFiles({ store: new FailingStore() });
      const record = recorder();
      await expect(files.ingest({ name: "notes.txt", bytes: encoder.encode("text"), onEvent: record.onEvent })).rejects.toBe(failure);
      expectWellFormed(record.events);
      expect((record.events.at(-1) as Extract<IngestEvent, { type: "ingest.error" }>).error).toEqual({ message: "The document could not be stored. Try again later." });
    }
  });

  it("tells other errors in words for users: a system error by its code, anything else that is not an Error plainly", async () => {
    const systemError = Object.assign(new Error("ENOENT: no such file or directory, open '/srv/secret/fonts.bin'"), { code: "ENOENT", syscall: "open" });
    const cases: Array<[unknown, string]> = [
      [systemError, "The file could not be read from storage (ENOENT)."],
      ["token sk-123 rejected", "Something went wrong."],
    ];
    for (const [thrown, message] of cases) {
      const failing: Extractor = async () => {
        throw thrown;
      };
      const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: failing } });
      const record = recorder();
      await expect(files.ingest({ name: "notes.txt", bytes: encoder.encode("text"), onEvent: record.onEvent })).rejects.toBe(thrown);
      expectWellFormed(record.events);
      expect(record.events.at(-1)).toMatchObject({ type: "ingest.error", error: { message } });
    }
  });

  it("sends ingest.start first and ends with ingest.error even when what it was given is refused, or the listener throws on the start", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const bad = { name: "notes.txt", bytes: encoder.encode("text"), owner: "  " };
    const plain = await files.ingest(bad).catch((caught: unknown) => caught);
    expect(plain).toBeInstanceOf(TypeError);

    const record = recorder();
    const listened = await files.ingest({ ...bad, onEvent: record.onEvent }).catch((caught: unknown) => caught);
    // The same error as without a listener.
    expect(listened).toBeInstanceOf(TypeError);
    expect((listened as Error).message).toBe((plain as Error).message);
    expectWellFormed(record.events);
    expect(record.events.map((event) => event.type)).toEqual(["ingest.start", "ingest.error"]);
    expect(record.events[0]).toMatchObject({ name: "notes.txt", format: "text", bytes: 4 });
    expect(record.events[1]).toMatchObject({ error: { message: (plain as Error).message, name: "TypeError" } });

    // A name that is not a string: the start names nothing, and the error is the one thrown without a listener.
    const unnamed = { name: 42 as unknown as string, bytes: encoder.encode("text") };
    const plainUnnamed = await files.ingest(unnamed).catch((caught: unknown) => caught);
    const nameless = recorder();
    const listenedUnnamed = await files.ingest({ ...unnamed, onEvent: nameless.onEvent }).catch((caught: unknown) => caught);
    expect(listenedUnnamed).toBeInstanceOf(TypeError);
    expect((listenedUnnamed as Error).message).toBe((plainUnnamed as Error).message);
    expect(nameless.events.map((event) => event.type)).toEqual(["ingest.start", "ingest.error"]);
    expect(nameless.events[0]).toMatchObject({ name: "", format: "text", bytes: 4 });

    const thrown = new Error("The listener failed.");
    const types: string[] = [];
    const onEvent = (event: IngestEvent) => {
      types.push(event.type);
      if (event.type === "ingest.start") throw thrown;
    };
    await expect(files.ingest({ name: "notes.txt", bytes: encoder.encode("text"), onEvent })).rejects.toBe(thrown);
    expect(types).toEqual(["ingest.start", "ingest.error"]);
  });
});
