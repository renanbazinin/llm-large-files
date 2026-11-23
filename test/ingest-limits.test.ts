import "./load-pdf-libraries.js";
import { crc32, deflateSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createLargeFiles, createPdfExtractor, DEFAULT_MAX_TEXT_BYTES, MemoryDocumentStore } from "llm-large-files";
import { buildLogProfile, buildLogProfileInSlices, buildOutline, buildOutlineInSlices } from "../src/analyze.js";
import { TimeSlicer } from "../src/pause.js";
import { parsePdf } from "../src/pdf-pictures.js";
import { checkPageWork, pageWorkLimit } from "../src/pdf-work.js";
import { buildTextIndex, buildTextIndexInSlices, serializeTextIndex } from "../src/text-index.js";
import { estimateTokens, measureText, normalizeText, prepareText, textSizes, wrapLongLines } from "../src/text.js";
import { readZipDirectory } from "../src/zip-directory.js";
import { serviceLog } from "./fake-model.js";
import { FORM, formsInForms, HELVETICA, numberedPdf, pageObject as page, pdfFromObjects, pdfStream, textLine } from "./pdf-fixtures.js";

const encoder = new TextEncoder();

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

describe("ingest work in slices gives the results of 0.5.0", () => {
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

  it("keeps the text of a DOCX larger than a lower upload limit: maxTextBytes stays 100 MB", async () => {
    // A DOCX is packed XML: its text is often 2 to 4 times the size of the file.
    const paragraph = "<w:p><w:r><w:t>Forty characters of text in a paragraph.</w:t></w:r></w:p>";
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document><w:body>${paragraph.repeat(30_000)}</w:body></w:document>`);
    const docx = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(docx.length).toBeLessThan(200_000);
    const files = createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes: 200_000 });
    // 30,000 lines of 40 characters: about 1.2 MB of text, six times the upload limit.
    const meta = await files.ingest({ name: "long.docx", bytes: docx });
    expect(meta.lines).toBe(30_000);
    // A larger upload limit raises it.
    expect(DEFAULT_MAX_TEXT_BYTES).toBe(100 * 1024 * 1024);
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
});

/** One part of a ZIP built by hand: stored, not packed. */
type ZipPart = { name: string; data?: Uint8Array };
const LIMITS = { parts: 20_000, extraFields: 80_000, textBytes: 8 * 1024 * 1024 };
const WORD_XML = "<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>";
const TOO_MANY_PARTS = "This DOCX has more than 20,000 parts, more than an Office document has. It may be built to exhaust the server, so it is not read.";
const BUILT_LIST = "This DOCX lists its parts in a way that no Office program does: reading the list would take far more memory or time than an Office document needs. It may be built to exhaust the server, so it is not read.";

function localHeader(name: Buffer, data: Uint8Array): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, data]);
}

function centralRecord(name: Buffer, data: Uint8Array, offset: number, extra: Uint8Array = new Uint8Array(0), comment: Uint8Array = new Uint8Array(0)): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(comment.length, 32);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name, extra, comment]);
}

function endRecord(count: number, size: number, offset: number, comment: Uint8Array = new Uint8Array(0)): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count & 0xffff, 8);
  end.writeUInt16LE(count & 0xffff, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([end, comment]);
}

/**
 * A ZIP of `parts`, with `count` written as its count of parts (the low 16 bits of it), and `after`
 * bytes after the end record that are not its comment. `extra` is given to every record.
 */
function zipOf(parts: ZipPart[], { count = parts.length, after = 0, extra }: { count?: number; after?: number; extra?: Uint8Array } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const data = part.data ?? new Uint8Array(0);
    const local = localHeader(name, data);
    records.push(centralRecord(name, data, offset, extra));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(records);
  return new Uint8Array(Buffer.concat([...locals, directory, endRecord(count, directory.length, offset), Buffer.alloc(after)]));
}

/** A DOCX with word/document.xml and `empty` empty parts besides. */
const docxParts = (empty: number): ZipPart[] => [
  { name: "word/document.xml", data: encoder.encode(WORD_XML) },
  ...Array.from({ length: empty }, (_, n) => ({ name: `customXml/item${n}.xml` })),
];

/** The same ZIP with a ZIP64 directory: an end record of 0xFFFF, a locator and a ZIP64 end record that says `count`. */
function asZip64(bytes: Uint8Array, count: number): Uint8Array {
  const zip = Buffer.from(bytes);
  const end = zip.length - 22;
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeBigUInt64LE(BigInt(count), 24);
  end64.writeBigUInt64LE(BigInt(count), 32);
  end64.writeBigUInt64LE(BigInt(size), 40);
  end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(end), 8);
  locator.writeUInt32LE(1, 16);
  return new Uint8Array(Buffer.concat([zip.subarray(0, end), end64, locator, endRecord(0xffff, size, offset)]));
}

describe("the parts of a DOCX or PPTX are counted as JSZip reads them, before it does", () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore() });

  it("counts the parts JSZip reads, whatever the end record says", async () => {
    const zip = new JSZip();
    for (let n = 0; n < 5; n++) zip.file(`part${n}.xml`, "<x/>");
    zip.file("word/document.xml", WORD_XML);
    const bytes = await zip.generateAsync({ type: "uint8array", comment: "A comment." });
    // 5 parts, the "word/" folder JSZip adds, and word/document.xml. Their names and the comment of
    // the file are 77 bytes.
    expect(readZipDirectory(bytes, LIMITS)).toEqual({ parts: 7, extraFields: 0, textBytes: 77, endless: false });
    expect(readZipDirectory(encoder.encode("not a zip"), LIMITS)).toBeUndefined();
    // Its end record says 30,000 parts: JSZip reads 7, and so does ingest.
    const patched = Buffer.from(bytes);
    const end = patched.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    patched.writeUInt16LE(30_000, end + 8);
    patched.writeUInt16LE(30_000, end + 10);
    expect(readZipDirectory(patched, LIMITS)?.parts).toBe(7);
    expect((await files.ingest({ name: "parts.docx", bytes: patched })).lines).toBe(1);
    // A program before the archive, as in a self-extracting file: JSZip reads every offset after it.
    const prefixed = new Uint8Array(Buffer.concat([Buffer.from("#!/bin/sh\n".repeat(30)), bytes]));
    expect(readZipDirectory(prefixed, LIMITS)?.parts).toBe(7);
    expect((await files.ingest({ name: "prefixed.docx", bytes: prefixed })).lines).toBe(1);
  });

  it("refuses more than 20,000 parts, when the end record says fewer", async () => {
    // 20,001 parts, with an end record that says 2, or 0.
    const parts = docxParts(20_000);
    for (const count of [2, 0]) {
      await expect(files.ingest({ name: "parts.docx", bytes: zipOf(parts, { count }) })).rejects.toThrow(TOO_MANY_PARTS);
    }
    // 70,001 parts, written with the low 16 bits of the count (4,465), as a ZIP program without ZIP64 does.
    const wrapped = zipOf(docxParts(70_000), { count: 70_001 });
    expect(readZipDirectory(wrapped, LIMITS)?.parts).toBe(20_001);
    await expect(files.ingest({ name: "wrapped.pptx", bytes: wrapped })).rejects.toThrow(TOO_MANY_PARTS.replace("DOCX", "PPTX"));
    // The end record followed by 70 KB that is not its comment: JSZip finds it all the same.
    await expect(files.ingest({ name: "after.docx", bytes: zipOf(parts, { after: 70_000 }) })).rejects.toThrow(TOO_MANY_PARTS);
    // A ZIP64 directory that says 2.
    await expect(files.ingest({ name: "zip64.docx", bytes: asZip64(zipOf(parts), 2) })).rejects.toThrow(TOO_MANY_PARTS);
    // 20,000 parts are read.
    expect((await files.ingest({ name: "many.docx", bytes: zipOf(docxParts(19_999), { count: 2 }) })).lines).toBe(1);
  });

  it("reads a ZIP64 directory as JSZip does", async () => {
    const bytes = asZip64(zipOf(docxParts(3)), 70_000);
    expect(readZipDirectory(bytes, LIMITS)?.parts).toBe(4);
    expect((await files.ingest({ name: "zip64.docx", bytes })).lines).toBe(1);
  });

  it("refuses more than 8 MB of names, comments and field data", async () => {
    const document = encoder.encode(WORD_XML);
    const first = localHeader(Buffer.from("word/document.xml"), document);
    const empty = localHeader(Buffer.alloc(0), new Uint8Array(0));
    /** word/document.xml, the local header `shared`, and `n` records that point to it, then `pad` bytes counted in the directory. */
    const build = (shared: Buffer, n: number, record: Buffer, pad = 0) => {
      const records = [centralRecord(Buffer.from("word/document.xml"), document, 0)];
      for (let k = 0; k < n; k++) records.push(record);
      const directory = Buffer.concat([...records, Buffer.alloc(pad)]);
      return new Uint8Array(Buffer.concat([first, shared, directory, endRecord(records.length, directory.length, first.length + shared.length)]));
    };
    /** 200 parts whose one extra field says it is 65,535 bytes long, and runs over the records after it. */
    const overrun = (id: number, head: number[]) => {
      const field = Buffer.from([id & 0xff, id >> 8, 0xff, 0xff, ...head]);
      return build(empty, 200, centralRecord(Buffer.alloc(0), new Uint8Array(0), first.length, field), 70_000);
    };
    const cases = {
      // 130 parts that point to one local header with a name of 65,535 bytes: JSZip decodes it once
      // for each, 8.5 MB of names from a file of 70 KB.
      names: build(localHeader(Buffer.alloc(65_535, 0x61), new Uint8Array(0)), 130, centralRecord(Buffer.alloc(0), new Uint8Array(0), first.length)),
      // 130 parts with a comment of 65,535 bytes each.
      comments: build(empty, 130, centralRecord(Buffer.alloc(0), new Uint8Array(0), first.length, undefined, Buffer.alloc(65_535, 0x61))),
      // A Unicode Path field (0x7075) of version 1, with the CRC of the empty name: JSZip decodes the
      // rest as the name of the part. 2,000 such parts in 0.17 MB ran a heap of 256 MB out of memory.
      upath: overrun(0x7075, [1, 0, 0, 0, 0]),
      // A ZIP64 field (1): JSZip goes through its data byte by byte. 20,000 such parts held the
      // server for 4.5 s.
      zip64: overrun(1, [0]),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      expect(readZipDirectory(bytes, LIMITS)?.textBytes, name).toBeGreaterThan(8 * 1024 * 1024);
      await expect(files.ingest({ name: `${name}.docx`, bytes }), name).rejects.toThrow(BUILT_LIST);
    }
  });

  it("reads Unicode Path fields and comments, as Info-ZIP writes them", async () => {
    // Info-ZIP adds a Unicode Path field when a name is not ASCII: version 1, the CRC of the name
    // as stored, and the name in UTF-8. The parts and the file may have comments.
    const unicodePath = (stored: Buffer, name: string) => {
      const utf8 = Buffer.from(name);
      const field = Buffer.alloc(9);
      field.writeUInt16LE(0x7075, 0);
      field.writeUInt16LE(5 + utf8.length, 2);
      field[4] = 1;
      field.writeUInt32LE(crc32(stored), 5);
      return Buffer.concat([field, utf8]);
    };
    const document = encoder.encode(WORD_XML);
    const parts = [
      { stored: Buffer.from("word/document.xml"), name: "word/document.xml", data: document, comment: "The text." },
      { stored: Buffer.from("customXml/\x82l\x82ment.xml", "latin1"), name: "customXml/élément.xml", data: new Uint8Array(0), comment: "" },
    ];
    const locals: Buffer[] = [];
    const records: Buffer[] = [];
    let offset = 0;
    for (const part of parts) {
      records.push(centralRecord(part.stored, part.data, offset, unicodePath(part.stored, part.name), Buffer.from(part.comment)));
      locals.push(localHeader(part.stored, part.data));
      offset += locals.at(-1)!.length;
    }
    const directory = Buffer.concat(records);
    const bytes = new Uint8Array(Buffer.concat([...locals, directory, endRecord(records.length, directory.length, offset, Buffer.from("Made by hand."))]));
    // Names 17 and 21, comments 9 and 0, Unicode Path data 22 and 28, and the comment of the file, 13.
    expect(readZipDirectory(bytes, LIMITS)).toEqual({ parts: 2, extraFields: 2, textBytes: 110, endless: false });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toEqual(["word/document.xml", "customXml/élément.xml"]);
    expect((await files.ingest({ name: "info-zip.docx", bytes })).lines).toBe(1);
  });

  it("refuses more than 80,000 extra fields", async () => {
    // 6 parts with 16,383 empty extra fields each: 98,298 fields in 390 KB, about 25 MB in JSZip.
    const extra = Buffer.alloc(16_383 * 4);
    for (let n = 0; n < 16_383; n++) extra.writeUInt16LE(n + 2, n * 4);
    const bytes = zipOf(docxParts(5), { extra });
    expect(readZipDirectory(bytes, LIMITS)?.extraFields).toBe(80_001);
    await expect(files.ingest({ name: "fields.docx", bytes })).rejects.toThrow(BUILT_LIST);
    // One field for each part, as ZIP programs write them, is read.
    const timestamps = Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]);
    expect((await files.ingest({ name: "timestamps.docx", bytes: zipOf(docxParts(5), { extra: timestamps }) })).lines).toBe(1);
  });

  it("refuses a ZIP64 end record that JSZip reads without end", async () => {
    // A ZIP64 end record of 56 + 6 bytes: JSZip reads the 6 as a field of 2 bytes and a length of
    // 4, in a loop that does not move on. A length of -6 takes it back to where it read it.
    const looping = (length: number) => {
      const zip = Buffer.from(asZip64(zipOf(docxParts(1)), 2));
      const end64 = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
      const field = Buffer.alloc(6);
      field.writeUInt16LE(1, 0);
      field.writeInt32LE(length, 2);
      const record = Buffer.concat([zip.subarray(end64, end64 + 56), field]);
      record.writeBigUInt64LE(50n, 4);
      const tail = Buffer.from(zip.subarray(end64 + 56));
      tail.writeBigUInt64LE(BigInt(end64), 8);
      return new Uint8Array(Buffer.concat([zip.subarray(0, end64), record, tail]));
    };
    expect(readZipDirectory(looping(-6), LIMITS)).toMatchObject({ endless: true, parts: 0 });
    // With a length past the end of the file, JSZip stops (with its own error): the file is refused all the same.
    await expect(files.ingest({ name: "end.docx", bytes: looping(1_000_000) })).rejects.toThrow("This DOCX ends with a ZIP64 record that cannot be read, and reading it could hold the server without end. It may be built to exhaust the server, so it is not read.");
  });
});

/** Lines of text operators, `megabytes` of them, packed with Flate: a few kilobytes. */
function packedText(megabytes: number): Uint8Array {
  const line = `(${"A".repeat(200)}) '\n`;
  return deflateSync(Buffer.from(`BT /F1 8 Tf 10 780 Td 10 TL\n${line.repeat(Math.ceil((megabytes * 1024 * 1024) / line.length))}ET`, "latin1"), { level: 9 });
}

describe("a PDF page that would hold the server is refused before pdf.js reads it", () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore() });
  const heavy = "Page 1 of this PDF draws far more than its file holds, and reading it would hold the server for a long time.";

  it("refuses a page whose content is packed hundreds of times", async () => {
    const content = packedText(12);
    const pdf = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "<< /Font << /F1 4 0 R >> >>"), HELVETICA, pdfStream("/Filter /FlateDecode", content)]);
    expect(pdf.length).toBeLessThan(100_000);
    await expect(files.ingest({ name: "packed.pdf", bytes: pdf })).rejects.toThrow(heavy);
  });

  it("refuses pages that are each within the limit but together draw far more than the file", async () => {
    // 20 pages show one stream of 2 MB of text: 40 MB for pdf.js to read, from a few kilobytes.
    const kids = Array.from({ length: 20 }, (_, index) => `${5 + index} 0 R`);
    const pdf = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids.join(" ")}] /Count 20 >>`, pdfStream("/Filter /FlateDecode", packedText(2)), HELVETICA,
      ...kids.map(() => page("3 0 R", "<< /Font << /F1 4 0 R >> >>"))]);
    await expect(files.ingest({ name: "shared.pdf", bytes: pdf })).rejects.toThrow("This PDF draws far more than its file holds, and reading it would hold the server for a long time.");
  });

  it("refuses a Type3 font whose glyph paints forms inside forms", async () => {
    // pdf.js runs every glyph program of a Type3 font when a page sets it, and this 3 KB file's
    // glyph paints 125,000 forms: 2.9 s of pdf.js.
    const objects: Array<string | Uint8Array> = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "<< /Font << /T3 7 0 R /F1 4 0 R >> >>"), HELVETICA,
      pdfStream("", `BT /T3 12 Tf 72 700 Td (a) Tj ET ${textLine("A line of plain text.", 650)}`),
      pdfStream("", "1000 0 0 0 1000 1000 d1 q /X Do Q"),
      "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1000] /Resources << /XObject << /X 11 0 R >> >> >>",
      pdfStream(`${FORM} /Resources << /Font << /F1 4 0 R >> >>`, textLine("Inside a glyph."))];
    for (let level = 1; level <= 3; level++) objects.push(pdfStream(`${FORM} /Resources << /XObject << /X ${7 + level} 0 R >> >>`, "q /X Do Q\n".repeat(50)));
    await expect(files.ingest({ name: "glyphs.pdf", bytes: pdfFromObjects(objects) })).rejects.toThrow(heavy);
  });

  it("follows a name cut between two streams of a page's content", async () => {
    // pdf.js joins the streams with nothing between them: "q /" and "X Do Q" paint /X.
    await expect(files.ingest({ name: "split.pdf", bytes: formsInForms(3, 50, { split: true }) })).rejects.toThrow(heavy);
  });

  it("counts content it cannot read as painting all it can name, and refuses content it cannot decode", async () => {
    // A page's content stored with a predictor, which pdf-lib does not undo (pdf.js does): "q /X Do Q"
    // in rows of 3 bytes, each after a 0 that says the row is stored as it is. It paints forms inside forms.
    const content = "q /X Do Q";
    const rows = Buffer.from(Array.from({ length: content.length / 3 }, (_, row) => `\0${content.slice(row * 3, row * 3 + 3)}`).join(""), "latin1");
    const predicted = pdfStream("/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 3 >>", deflateSync(rows));
    await expect(files.ingest({ name: "predicted.pdf", bytes: formsInForms(3, 50, { content: predicted }) })).rejects.toThrow(heavy);
    // Content behind a filter that only images use: pdf.js would decode it, and nothing here can.
    const jpeg = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "<< /Font << /F1 4 0 R >> >>"), HELVETICA,
      pdfStream("/Filter /DCTDecode", "\xff\xd8\xff\xd9")]);
    await expect(files.ingest({ name: "jpeg.pdf", bytes: jpeg })).rejects.toThrow("Page 1 of this PDF stores its content in a way that cannot be checked before it is read, so it is not read.");
  });

  it("reads such a page with checkPages: false", async () => {
    // 14,400 paints of a form with text: past the limit, and about 1.1 s of pdf.js.
    const bomb = formsInForms(2, 120);
    await expect(files.ingest({ name: "forms.pdf", bytes: bomb })).rejects.toThrow(heavy);
    const unchecked = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { pdf: createPdfExtractor({ checkPages: false }) } });
    expect((await unchecked.ingest({ name: "forms.pdf", bytes: bomb })).pages).toBe(1);
  });

  it("passes a page that paints a small form with text 10,000 times, as a CAD drawing can", async () => {
    // pdf.js reads it in about 0.7 s, under the limit of about 1 to 1.5 s.
    const bytes = formsInForms(1, 10_000);
    const parsed = await parsePdf(bytes);
    const work = await checkPageWork(parsed!.library, parsed!.document, bytes.byteLength);
    expect(work).toBeGreaterThan(pageWorkLimit(bytes.byteLength) * 0.6);
    expect(work).toBeLessThan(pageWorkLimit(bytes.byteLength));
  });

  it("reads a page that paints a drawing without text 50,000 times, as a chart does", async () => {
    // pdf.js runs a form without text once, and skips its other paints: so does the count.
    const marks = Array.from({ length: 50_000 }, (_, index) => `q 1 0 0 1 ${index % 600} ${Math.floor(index / 600)} cm /M Do Q`).join("\n");
    const pdf = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "<< /XObject << /M 6 0 R >> /Font << /F1 4 0 R >> >>"), HELVETICA,
      pdfStream("/Filter /FlateDecode", deflateSync(Buffer.from(`${marks}\n${textLine("A scatter plot of 50,000 points.")}`, "latin1"))),
      pdfStream(`${FORM} /Resources << >>`, "0 0 m 1 1 l S")]);
    const meta = await files.ingest({ name: "chart.pdf", bytes: pdf });
    expect(meta.pages).toBe(1);
    expect(await files.tools([meta]).execute("read_document", { document_id: meta.id })).toMatchObject({ text: expect.stringContaining("A scatter plot of 50,000 points.") });
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
