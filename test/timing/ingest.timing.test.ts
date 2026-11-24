// The tests of ingest that hold work to the clock: how often a timer gets a turn while a large
// file is ingested (from test/ingest-limits.test.ts), and how many progress events a stage sends
// in the time it takes (from test/ingest-events.test.ts).
import "../load-pdf-libraries.js";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type Extractor } from "llm-large-files";
import { serviceLog } from "../fake-model.js";
import { expectWellFormed, fileStore, logText, recorder, removeFileStores } from "../ingest-recorder.js";
import { numberedPdf } from "../pdf-fixtures.js";
import { beatsDuring } from "./clock.js";

const encoder = new TextEncoder();

afterEach(removeFileStores);

async function docxOf(documentXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "uint8array" });
}

describe("ingest lets other work run", () => {
  it("pauses while a large log is ingested", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const bytes = encoder.encode(serviceLog(120_000));
    const { beats, result } = await beatsDuring(() => files.ingest({ name: "app.log", bytes }));
    expect(result.lines).toBe(120_000);
    // Before 0.6.0 the whole ingest was one block, and a timer never ran during it.
    expect(beats).toBeGreaterThanOrEqual(3);
  });

  it("pauses between the pages of a PDF", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const { beats, result } = await beatsDuring(() => files.ingest({ name: "book.pdf", bytes: numberedPdf(300) }));
    expect(result.pages).toBe(300);
    expect(beats).toBeGreaterThanOrEqual(3);
  });

  it("pauses while a large DOCX is unpacked", async () => {
    const docx = await docxOf(`<w:document><w:body>${"<w:p><w:r><w:t>Forty characters of text in a paragraph.</w:t></w:r></w:p>".repeat(150_000)}</w:body></w:document>`);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const { beats, result } = await beatsDuring(() => files.ingest({ name: "long.docx", bytes: docx }));
    expect(result.lines).toBe(150_000);
    expect(beats).toBeGreaterThanOrEqual(3);
  });
});

describe("ingest events", () => {
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
      // Measured as the library spaces them, by performance.now() (events are sent at once, so
      // they arrive when they are sent): the wall clock of `time` can be moved on a busy machine,
      // and read 7 ms between events sent 12 ms apart. A pause of the collector between the
      // library's reading of the clock and the listener's can still take a few ms off a gap (9.4 ms
      // on a CI machine); events sent at every step would be microseconds apart.
      for (let index = 1; index < progress.length - 1; index++) expect(log.arrived.get(progress[index]!)! - log.arrived.get(progress[index - 1]!)!).toBeGreaterThanOrEqual(6);
    }
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
});
