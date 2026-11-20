import "./load-pdf-libraries.js";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { buildLogProfile, buildLogProfileInSlices, buildOutline, buildOutlineInSlices } from "../src/analyze.js";
import { zipEntryCount } from "../src/extract.js";
import { TimeSlicer } from "../src/pause.js";
import { buildTextIndex, buildTextIndexInSlices, serializeTextIndex } from "../src/text-index.js";
import { estimateTokens, measureText, normalizeText, prepareText, textSizes, wrapLongLines } from "../src/text.js";
import { serviceLog } from "./fake-model.js";
import { HELVETICA, numberedPdf, pdfFromObjects, pdfStream, textLine } from "./pdf-fixtures.js";

const encoder = new TextEncoder();

/** Counts the beats of a 2 ms timer while `work` runs: 0 when the work never lets a timer run. */
async function beatsDuring<T>(work: () => Promise<T>): Promise<{ beats: number; result: T }> {
  let beats = 0;
  const timer = setInterval(() => beats++, 2);
  try {
    const result = await work();
    return { beats, result };
  } finally {
    clearInterval(timer);
  }
}

async function docxOf(documentXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "uint8array" });
}

/** Text of many kinds, with line breaks, quotes, tabs, Hebrew, emoji and control characters. */
function mixedText(lines: number): string {
  const kinds = [
    (n: number) => `2026-11-20T08:00:${String(n % 60).padStart(2, "0")}Z INFO request ${n} took ${n % 900}ms`,
    (n: number) => `"quoted" \\ back\tslash ${n}`,
    (n: number) => `שלום עולם ${n} — הדוח השנתי`,
    (n: number) => `emoji 😀 ${n} and 🚀🚀`,
    (n: number) => `CamelCaseIdentifier${n} HTTPServer base64 QUJDREVGR0hJSktMTU5PUA==`,
    (n: number) => `\u0007 bell and ${n} \u001b escape`,
  ];
  return Array.from({ length: lines }, (_, n) => kinds[n % kinds.length]!(n)).join("\n");
}

describe("ingest work in slices gives the results of 0.6.0", () => {
  it("measures a text the same, slice by slice", async () => {
    for (const text of [mixedText(20_000), mixedText(20_000) + "\n", "", "one line without a break", mixedText(3)]) {
      const measured = await measureText(text, new TimeSlicer());
      expect(measured).toEqual({ tokens: estimateTokens(text), ...textSizes(text) });
    }
  });

  it("builds the same log profile, outline and line index", async () => {
    const log = serviceLog(30_000).split("\n");
    expect(await buildLogProfileInSlices(log, new TimeSlicer())).toEqual(buildLogProfile(log));
    const book = Array.from({ length: 30_000 }, (_, n) => (n % 7 === 0 ? `## Chapter ${n}` : n % 7 === 1 ? "" : `Line ${n} of the book.`));
    expect(await buildOutlineInSlices(book, "markdown", new TimeSlicer())).toEqual(buildOutline(book, "markdown"));
    expect(await buildOutlineInSlices(log, "log", new TimeSlicer())).toEqual([]);
    const text = mixedText(40_000);
    expect(serializeTextIndex(await buildTextIndexInSlices(text, new TimeSlicer()))).toEqual(serializeTextIndex(buildTextIndex(text)));
  });

  it("prepares a text the same, slice by slice", async () => {
    const pieces = [
      mixedText(30_000),
      "﻿" + mixedText(30_000).replaceAll("\n", "\r\n") + "\r\n",
      `${"y".repeat(300_000)}\r\nshort\n${"z ".repeat(4_000)}`,
      "old\rmac\rline\rends",
      "\u001b[31mred\u001b[0m\n\u001b]0;title\u0007after\n",
      "",
      "\n\n\n",
    ];
    for (const raw of pieces) {
      const { text, wrapped } = wrapLongLines(normalizeText(raw));
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      const prepared = await prepareText(raw, new TimeSlicer());
      expect(prepared.text).toBe(text);
      expect(prepared.wrapped).toBe(wrapped);
      if (text) expect(prepared.lines).toEqual(lines);
    }
  });

  it("indexes a half of a character outside the basic plane where a slice ends as the whole text would", () => {
    const at = (1 << 18) - 1;
    for (const tail of ["\ud83d" + "b", "😀" + "b", "\ude00" + "b", "\ud83d"]) {
      const text = "a".repeat(at) + tail + "\nmore";
      const index = buildTextIndex(text);
      expect(index.textBytes).toBe(Buffer.byteLength(text, "utf8"));
      expect(index.lineCount).toBe(2);
    }
  });

  it("leaves a text without long lines as it is", () => {
    const text = mixedText(1_000);
    expect(wrapLongLines(text)).toEqual({ text, wrapped: 0 });
    const long = `short\n${"x".repeat(5_000)}\nshort`;
    expect(wrapLongLines(long).wrapped).toBe(1);
    expect(wrapLongLines(long).text.split("\n").every((line) => line.length <= 2_000)).toBe(true);
  });
});

describe("ingest lets other work run", () => {
  it("pauses while a large log is ingested", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const bytes = encoder.encode(serviceLog(120_000));
    const { beats, result } = await beatsDuring(() => files.ingest({ name: "app.log", bytes }));
    expect(result.lines).toBe(120_000);
    // Before 0.6.1 the whole ingest was one block, and a timer never ran during it.
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

describe("limits on what one file may cost", () => {
  it("refuses a PDF with more pages than maxPdfPages, before reading them", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxPdfPages: 3 });
    await expect(files.ingest({ name: "long.pdf", bytes: numberedPdf(5) })).rejects.toThrow("This PDF has 5 pages, more than the 3 read from one file.");
    expect((await files.ingest({ name: "short.pdf", bytes: numberedPdf(3) })).pages).toBe(3);
  });

  it("refuses a PDF whose page tree lists one page more than once", async () => {
    const pdf = pdfFromObjects([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [4 0 R 4 0 R 4 0 R] /Count 3 /MediaBox [0 0 612 792] >>",
      HELVETICA,
      "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
      pdfStream("", textLine("The same page, listed three times.")),
    ]);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await expect(files.ingest({ name: "repeat.pdf", bytes: pdf })).rejects.toThrow("This PDF lists the same page more than once.");
  });

  it("refuses a PDF, a DOCX and the result of an extractor of your own past maxTextBytes", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxTextBytes: 600 });
    await expect(files.ingest({ name: "many.pdf", bytes: numberedPdf(40) })).rejects.toThrow("This PDF holds more than 600 B of text");
    const docx = await docxOf(`<w:document><w:body>${"<w:p><w:r><w:t>Forty characters of text in a paragraph.</w:t></w:r></w:p>".repeat(30)}</w:body></w:document>`);
    await expect(files.ingest({ name: "long.docx", bytes: docx })).rejects.toThrow("This DOCX holds more than 600 B of text");
    const own = createLargeFiles({ store: new MemoryDocumentStore(), maxTextBytes: 600, extractors: { text: async () => ({ text: "x".repeat(700) }) } });
    await expect(own.ingest({ name: "notes.txt", bytes: encoder.encode("short") })).rejects.toThrow("notes.txt holds more than 600 B of text");
    // Within the limit, nothing changes.
    expect((await files.ingest({ name: "short.pdf", bytes: numberedPdf(2) })).pages).toBe(2);
  });

  it("counts the text of a Word paragraph as it reads, not as the XML writes it", async () => {
    // 1,000 characters of XML, 200 of text: under a limit of 600 bytes.
    const docx = await docxOf(`<w:document><w:body><w:p><w:r><w:t>${"&amp;".repeat(200)}</w:t></w:r></w:p></w:body></w:document>`);
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxTextBytes: 600 });
    expect((await files.ingest({ name: "ampersands.docx", bytes: docx })).characters).toBe(200);
  });

  it("drops empty Word paragraphs as it reads, and keeps the text", async () => {
    const docx = await docxOf(`<w:document><w:body>${"<w:p></w:p>".repeat(300_000)}<w:p><w:r><w:t>The one line of text.</w:t></w:r></w:p>${"<w:p><w:r><w:t> </w:t></w:r></w:p>".repeat(1_000)}</w:body></w:document>`);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "padded.docx", bytes: docx });
    expect(meta.lines).toBe(1);
    expect(await files.tools([meta]).execute("read_document", { document_id: meta.id })).toMatchObject({ text: "1| The one line of text." });
  });

  it("refuses paragraphs nested without end", async () => {
    const docx = await docxOf(`<w:document><w:body>${"<w:p><w:r><w:t>x".repeat(100_000)}</w:body></w:document>`);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await expect(files.ingest({ name: "deep.docx", bytes: docx })).rejects.toThrow("This DOCX nests paragraphs more than 32 deep");
  });

  it("reads how many parts a ZIP has, and refuses an Office file with too many", async () => {
    const zip = new JSZip();
    for (let n = 0; n < 5; n++) zip.file(`part${n}.xml`, "<x/>");
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    // 5 parts, the "word/" folder JSZip adds, and word/document.xml.
    expect(zipEntryCount(bytes)).toBe(7);
    expect(zipEntryCount(encoder.encode("not a zip"))).toBeUndefined();
    // The same file, with its end record saying it has 30,000 parts.
    const patched = new Uint8Array(bytes);
    const end = patched.length - 22;
    expect([patched[end], patched[end + 1], patched[end + 2], patched[end + 3]]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    patched[end + 8] = 30_000 & 0xff;
    patched[end + 9] = 30_000 >> 8;
    patched[end + 10] = 30_000 & 0xff;
    patched[end + 11] = 30_000 >> 8;
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await expect(files.ingest({ name: "parts.docx", bytes: patched })).rejects.toThrow("This DOCX has 30,000 parts, more than an Office document has.");
    expect((await files.ingest({ name: "fine.docx", bytes })).lines).toBe(1);
  });

  it("reads the count of a ZIP64 file from its ZIP64 record", () => {
    // A ZIP64 end record (56 bytes), its locator (20) and the end record (22), with no parts.
    const bytes = new Uint8Array(98);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x06064b50, true);
    view.setBigUint64(32, 70_000n, true);
    view.setUint32(56, 0x07064b50, true);
    view.setBigUint64(64, 0n, true);
    view.setUint32(76, 0x06054b50, true);
    view.setUint16(86, 0xffff, true);
    expect(zipEntryCount(bytes)).toBe(70_000);
    // Without a locator, the end record's 65,535 is all there is to go on.
    view.setUint32(56, 0, true);
    expect(zipEntryCount(bytes)).toBe(0xffff);
  });
});

describe("time limit and abort", () => {
  const never = async () => new Promise<{ text: string }>(() => undefined);

  it("gives up on an ingest that takes longer than ingestTimeoutMs", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 50, extractors: { text: never } });
    const started = performance.now();
    await expect(files.ingest({ name: "stuck.txt", bytes: encoder.encode("text") })).rejects.toThrow("stuck.txt took too long to read (more than 50 ms)");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("stops when the caller's signal is aborted", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: never } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("The uploader went away.")), 20);
    await expect(files.ingest({ name: "gone.txt", bytes: encoder.encode("text"), signal: controller.signal })).rejects.toThrow("The uploader went away.");
    const before = new AbortController();
    before.abort(new Error("Aborted before."));
    await expect(files.ingest({ name: "app.log", bytes: encoder.encode(serviceLog(10)), signal: before.signal })).rejects.toThrow("Aborted before.");
  });

  it("stops a PDF between its pages", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const controller = new AbortController();
    const ingest = files.ingest({ name: "book.pdf", bytes: numberedPdf(2_000), signal: controller.signal });
    setTimeout(() => controller.abort(new Error("Stop reading.")), 30);
    await expect(ingest).rejects.toThrow("Stop reading.");
  });

  it("sets no limit with 0", async () => {
    const slow = async () => new Promise<{ text: string }>((resolve) => setTimeout(() => resolve({ text: "done" }), 60));
    const files = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 0, extractors: { text: slow } });
    expect((await files.ingest({ name: "slow.txt", bytes: encoder.encode("x") })).lines).toBe(1);
    // A limit longer than a timer can wait (24.8 days) is none either, not one that fires at once.
    const long = createLargeFiles({ store: new MemoryDocumentStore(), ingestTimeoutMs: 2 ** 31, extractors: { text: slow } });
    expect((await long.ingest({ name: "slow.txt", bytes: encoder.encode("x") })).lines).toBe(1);
  });
});

describe("files.tools() checks the owner of each document", () => {
  it("reads a document only for the owner it was handed in with", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const alice = await files.ingest({ name: "salaries.txt", bytes: encoder.encode("Alice salary 250000\nBob salary 90000"), owner: "alice" });
    const open = await files.ingest({ name: "open.txt", bytes: encoder.encode("Anyone may read this.") });
    const read = (meta: typeof alice) => files.tools([meta]).execute("read_document", { document_id: meta.id });

    expect(await read(alice)).toMatchObject({ text: expect.stringContaining("Alice salary") });
    // Metadata built from the ID alone, or with another owner, reads nothing.
    const { owner: _owner, ...withoutOwner } = alice;
    expect(await read(withoutOwner)).toEqual({ error: expect.stringContaining("is no longer available") });
    expect(await read({ ...alice, owner: "bob" })).toEqual({ error: expect.stringContaining("is no longer available") });
    // A document stored without an owner stays open to every caller, as before.
    expect(await read({ ...open, owner: "bob" })).toMatchObject({ text: expect.stringContaining("Anyone may read") });
  });

  it("shows the pages of a PDF only for its owner", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const pdf = await files.ingest({ name: "report.pdf", bytes: numberedPdf(2), owner: "alice" });
    const look = (meta: typeof pdf) => files.tools([], { viewPages: [meta] }).executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 });
    expect((await look(pdf)).files).toHaveLength(1);
    const forged = await look({ ...pdf, owner: "mallory" });
    expect(forged.files ?? []).toHaveLength(0);
    expect(forged.result).toEqual({ error: expect.stringContaining("is no longer available") });
  });
});
