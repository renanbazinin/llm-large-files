// What the review of 0.99.9 found in the readers of PDF, ZIP and Office files, each with a test
// that failed before its fix: content of a PDF that decodes to far more than its stream holds, a
// spreadsheet cell that names a shared string without a number, and half of a surrogate pair
// written as a character reference. Tests held to the clock (the search for tables on a page of
// thousands of lines) are in test/timing/review-0.99.10-parsers.timing.test.ts.
import "./load-pdf-libraries.js";
import { deflateSync } from "node:zlib";
import * as pdfLib from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { cutPdfPages, DecodedTooMuch, decodeContent, limitDecoders, type DecodeAllowance } from "../src/pdf-pages.js";
import { findPicturePages } from "../src/pdf-pictures.js";
import { wellFormed } from "../src/text.js";
import { decodeEntities, XmlStream } from "../src/xml-stream.js";
import { readZipDirectory } from "../src/zip-directory.js";
import { HELVETICA, paint, pdfFromObjects, pdfStream, pdfWithPictures, textLine } from "./pdf-fixtures.js";
import { docxText, p, W, word } from "./word-fixtures.js";
import { read as readWorkbook, REL, RELS, rowsOf, S, workbook, zip } from "./xlsx-fixtures.js";

const { PDFContext, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = pdfLib;
const MB = 1024 * 1024;

/** `megabytes` of spaces after `content`, packed with Flate: about a kilobyte for each megabyte. */
const packed = (megabytes: number, content = ""): Uint8Array => deflateSync(Buffer.concat([Buffer.from(content, "latin1"), Buffer.alloc(megabytes * MB, 0x20)]));

/**
 * A Flate stream of one block that decodes to about `length` spaces, 160 times its size. A program
 * that packs data writes a new block every few megabytes; a file written by hand need not.
 */
function oneBlock(length: number): Uint8Array {
  const copies = Math.floor((length - 1) / 258);
  const out = Buffer.alloc(2 + Math.ceil((3 + 8 + copies * 13 + 7) / 8) + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  let at = 16;
  const bit = (value: number) => {
    if (value) out[at >> 3]! |= 1 << (at & 7);
    at++;
  };
  // A code of the fixed table, its first bit first.
  const code = (value: number, size: number) => {
    for (let shift = size - 1; shift >= 0; shift--) bit((value >> shift) & 1);
  };
  // The last block, packed with the fixed table.
  bit(1);
  bit(1);
  bit(0);
  // A space, then "copy 258 bytes from 1 back" (13 bits) again and again, then the end of the block.
  code(0x30 + 0x20, 8);
  for (let copy = 0; copy < copies; copy++) {
    code(0xc5, 8);
    code(0, 5);
  }
  code(0, 7);
  return new Uint8Array(out);
}

const IMAGE = pdfStream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", "\x00\xff\xff\x00");

/**
 * One page whose resources list two images, as the programs that keep every image of a file in
 * one dictionary write them. `contents` is the page's /Contents, and `streams` the objects from 6 on.
 */
function pageOfTwoImages(contents: string, streams: Uint8Array[]): Uint8Array {
  const first = 6 + streams.length;
  return pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    HELVETICA,
    `<< /Font << /F1 3 0 R >> /XObject << /I1 ${first} 0 R /I2 ${first + 1} 0 R >> >>`,
    `<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents ${contents} >>`,
    ...streams,
    IMAGE,
    IMAGE,
  ]);
}

/** How many entries the XObject dictionary of the first page of `bytes` has. */
async function imagesKept(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const xobjects = document.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"));
  return xobjects instanceof PDFDict ? xobjects.entries().length : 0;
}

const PAINTS_FIRST = `${textLine("A page that paints the first of its two images.")}\n${paint("I1", 200, 100)}\n`;

describe("PDF content that decodes to far more than its stream holds (review 0.99.10)", () => {
  it("does not decode a stream past what the reader may still read", () => {
    // 5 MB of spaces in about 5 KB. 0.99.9 looked only at the 5 KB, and decoded all of it.
    const context = PDFContext.create();
    const bomb = PDFRawStream.of(context.obj({ Filter: PDFName.of("FlateDecode") }), packed(5));
    expect(bomb.contents.length).toBeLessThan(10_000);
    const small: DecodeAllowance = { left: 100_000 };
    expect(decodeContent(pdfLib, context, bomb, 100_000, small)).toBeUndefined();
    expect(small).toEqual({ left: 100_000, passed: true });
    // Once a stream did not fit, no stream after it is read: one reading has one allowance.
    const tiny = PDFRawStream.of(context.obj({ Filter: PDFName.of("FlateDecode") }), deflateSync(Buffer.from("q Q")));
    expect(decodeContent(pdfLib, context, tiny, 100_000, small)).toBeUndefined();

    // With room for it, the same stream is read, and what it holds is taken from the allowance.
    const large: DecodeAllowance = { left: 8 * MB };
    expect(decodeContent(pdfLib, context, bomb, 100_000, large)).toHaveLength(5 * MB);
    expect(large).toEqual({ left: 3 * MB });
    expect(decodeContent(pdfLib, context, tiny, 100_000, large)).toBe("q Q");
  });

  it("reads Flate streams as pdf-lib does: a wrong or missing checksum is read, a cut stream is not", () => {
    const context = PDFContext.create();
    const whole = deflateSync(Buffer.from("q /I1 Do Q"));
    type Dictionary = Parameters<typeof PDFRawStream.of>[0];
    const read = (data: Uint8Array, dictionary: Dictionary = context.obj({ Filter: PDFName.of("FlateDecode") })) => decodeContent(pdfLib, context, PDFRawStream.of(dictionary, data), MB, { left: MB });
    expect(read(whole)).toBe("q /I1 Do Q");
    expect(read(Buffer.concat([whole, Buffer.from("\r\n")]))).toBe("q /I1 Do Q");
    expect(read(Buffer.concat([whole.subarray(0, -4), Buffer.from([1, 2, 3, 4])]))).toBe("q /I1 Do Q");
    expect(read(whole.subarray(0, -4))).toBe("q /I1 Do Q");
    expect(read(whole.subarray(0, -6))).toBeUndefined();
    expect(read(Buffer.from("q /I1 Do Q"))).toBeUndefined();
    expect(read(new Uint8Array(0))).toBeUndefined();
    // No filter, a filter in an array, two filters, and a filter pdf-lib does not have.
    expect(read(Buffer.from("q /I1 Do Q"), context.obj({}))).toBe("q /I1 Do Q");
    expect(read(whole, context.obj({ Filter: [PDFName.of("FlateDecode")] }))).toBe("q /I1 Do Q");
    expect(read(Buffer.from(`${Buffer.from(whole).toString("hex")}>`), context.obj({ Filter: [PDFName.of("ASCIIHexDecode"), PDFName.of("FlateDecode")] }))).toBe("q /I1 Do Q");
    expect(read(whole, context.obj({ Filter: PDFName.of("DCTDecode") }))).toBeUndefined();
  });

  it("holds pdf-lib's own decoders to a size, inside one block and behind a second filter", () => {
    const context = PDFContext.create();
    // One block of 8 MB in 50 KB. Asked for 64 KB, pdf-lib's Flate decoder decodes the whole block.
    const block = oneBlock(8 * MB);
    expect(block.length).toBeLessThan(60_000);
    const flate = () => decodePDFRawStream(PDFRawStream.of(context.obj({ Filter: PDFName.of("FlateDecode") }), block));
    const unlimited = flate() as unknown as { getBytes(length: number): Uint8Array; bufferLength: number };
    unlimited.getBytes(65_536);
    expect(unlimited.bufferLength).toBeGreaterThan(8 * MB - 258);

    const limited = flate() as unknown as { getBytes(length: number): Uint8Array; buffer: Uint8Array };
    expect(limitDecoders(limited, MB)).toBe(1);
    expect(() => limited.getBytes(65_536)).toThrow(DecodedTooMuch);
    expect(limited.buffer.length).toBeLessThanOrEqual(MB);

    // The same block written in hexadecimal: two decoders, each held to the size.
    const hex = PDFRawStream.of(context.obj({ Filter: [PDFName.of("ASCIIHexDecode"), PDFName.of("FlateDecode")] }), Buffer.from(`${Buffer.from(block).toString("hex")}>`));
    expect(limitDecoders(decodePDFRawStream(hex), MB)).toBe(2);
    const allowance: DecodeAllowance = { left: MB };
    expect(decodeContent(pdfLib, context, hex, MB, allowance)).toBeUndefined();
    expect(allowance.passed).toBe(true);
    expect(decodeContent(pdfLib, context, hex, MB, { left: 16 * MB })).toHaveLength(1 + 258 * Math.floor((8 * MB - 1) / 258));
    // Something that is not a decoder of pdf-lib is left alone, and counted as not limited.
    expect(limitDecoders({ getBytes: () => new Uint8Array(0) }, MB)).toBe(0);
    expect(limitDecoders(undefined, MB)).toBe(0);
  });

  // About 0.4 s alone; 33 MB are decoded once.
  it("cuts a page whose content decodes past 32 MB without reading it, and keeps every image the page lists", { timeout: 30_000 }, async () => {
    // Within the limit, the image the page does not paint is left out of the cut.
    const usual = pageOfTwoImages("6 0 R", [pdfStream("/Filter /FlateDecode", packed(1, PAINTS_FIRST))]);
    expect(await imagesKept((await cutPdfPages(usual, 1, 1, 10 * MB)).bytes)).toBe(1);
    // 33 MB in 33 KB. What the page paints is not known, so nothing is left out: 0.99.9 decoded it all.
    const bomb = pageOfTwoImages("6 0 R", [pdfStream("/Filter /FlateDecode", packed(33, PAINTS_FIRST))]);
    expect(bomb.length).toBeLessThan(60_000);
    const cut = await cutPdfPages(bomb, 1, 1, 10 * MB);
    expect(cut).toMatchObject({ from: 1, to: 1, pageCount: 1 });
    expect(await imagesKept(cut.bytes)).toBe(2);
  });

  it("still reads the content of a file that is encrypted only to restrict printing", { timeout: 30_000 }, async () => {
    // Its streams are decrypted first, then decoded: the image the page does not paint is left out.
    const restricted = await PDFDocument.load(pageOfTwoImages("6 0 R", [pdfStream("/Filter /FlateDecode", packed(1, PAINTS_FIRST))]), { updateMetadata: false });
    restricted.encrypt({ ownerPassword: "owner-secret", permissions: { printing: false, copying: false, modifying: false } });
    const saved = await restricted.save();
    expect(Buffer.from(saved).includes("/Encrypt")).toBe(true);
    expect(await imagesKept((await cutPdfPages(saved, 1, 1, 10 * MB)).bytes)).toBe(1);
  });

  // About 0.3 s alone.
  it("counts a stream each time a page names it: 20 times 4 MB is past the limit too", { timeout: 30_000 }, async () => {
    const stream = pdfStream("/Filter /FlateDecode", packed(4));
    const first = pdfStream("/Filter /FlateDecode", deflateSync(Buffer.from(PAINTS_FIRST, "latin1")));
    const few = pageOfTwoImages("[6 0 R 7 0 R 7 0 R]", [first, stream]);
    expect(await imagesKept((await cutPdfPages(few, 1, 1, 10 * MB)).bytes)).toBe(1);
    const many = pageOfTwoImages(`[6 0 R ${"7 0 R ".repeat(20)}]`, [first, stream]);
    expect(await imagesKept((await cutPdfPages(many, 1, 1, 10 * MB)).bytes)).toBe(2);
  });

  // About 0.5 s alone.
  it("marks a page whose content decodes past 16 MB as a drawing, as before, without decoding the rest", { timeout: 30_000 }, async () => {
    const geometry = { view: [0, 0, 612, 792], transform: [1, 0, 0, -1, 0, 792], tables: [] };
    const stream = pdfStream("/Filter /FlateDecode", packed(4));
    // 18 MB: one stream of 17 MB and a small one, then one stream of 4 MB named five times.
    const inOne = pageOfTwoImages("[6 0 R 7 0 R]", [pdfStream("/Filter /FlateDecode", packed(17)), stream]);
    const inMany = pageOfTwoImages(`[${"7 0 R ".repeat(5)}6 0 R]`, [pdfStream("/Filter /FlateDecode", deflateSync(Buffer.from(textLine("Text."), "latin1"))), stream]);
    expect(await findPicturePages(inOne, [geometry])).toEqual([true]);
    expect(await findPicturePages(inMany, [geometry])).toEqual([true]);
    // A form that holds more than the page may still read: the page is a drawing too.
    const form = pdfStream("/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Filter /FlateDecode", packed(17));
    const withForm = pdfFromObjects([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      HELVETICA,
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 5 0 R >>",
      pdfStream("", `${textLine("A page that paints a form.")}\nq /Fm1 Do Q`),
      form,
    ]);
    expect(await findPicturePages(withForm, [geometry])).toEqual([true]);
    // A page of text is not marked.
    const text = pageOfTwoImages("6 0 R", [pdfStream("", textLine("Only text."))]);
    expect(await findPicturePages(text, [geometry])).toEqual([false]);
  });

  // About 1 s alone, and 3 s beside the other files on a busy machine: pdf-lib decodes 64 MB before the block is refused.
  it("refuses, at ingest, content whose one block behind a second filter decodes past 64 MB, before it is decoded whole", { timeout: 60_000 }, async () => {
    // 200 MB in one block of 1.3 MB, written in hexadecimal. Read 64 KB at a time, 0.99.9 still
    // decoded the whole block at the first read, and made room for 256 MB.
    const block = oneBlock(200 * MB);
    const pdf = pdfFromObjects([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>",
      HELVETICA,
      pdfStream("/Filter [/ASCIIHexDecode /FlateDecode]", `${Buffer.from(block).toString("hex")}>`),
    ]);
    // The most room a decoder of pdf-lib is given while the file is read.
    const sample = decodePDFRawStream(PDFRawStream.of(PDFContext.create().obj({ Filter: PDFName.of("FlateDecode") }), deflateSync(Buffer.from("x"))));
    const decoders = Object.getPrototypeOf(Object.getPrototypeOf(sample)) as { ensureBuffer(requested: number): Uint8Array };
    const ensureBuffer = decoders.ensureBuffer;
    let most = 0;
    decoders.ensureBuffer = function (this: unknown, requested: number) {
      most = Math.max(most, requested);
      return ensureBuffer.call(this, requested);
    };
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    try {
      await expect(files.ingest({ name: "block.pdf", bytes: pdf })).rejects.toThrow("Page 1 of this PDF stores its content in a way that cannot be checked before it is read, so it is not read.");
    } finally {
      decoders.ensureBuffer = ensureBuffer;
    }
    expect(most).toBeGreaterThan(MB);
    expect(most).toBeLessThanOrEqual(64 * MB);
  });
});

describe("XLSX: a cell that names a shared string (review 0.99.10)", () => {
  it("reads a cell without the number of its string as empty, not as the first string", async () => {
    // Read as a number, no digits are 0: in 0.99.9 each of these cells showed "First".
    const cells = ['<c r="A1" t="s"><v>0</v></c>', '<c r="B1" t="s"></c>', '<c r="C1" t="s"><v></v></c>', '<c r="D1" t="s"><v> </v></c>', '<c r="E1" t="s"><v/></c>', '<c r="F1" t="s"><v>1</v></c>'];
    const bytes = await workbook(`<row r="1">${cells.join("")}</row>`, { strings: ["First", "Second"] });
    expect(rowsOf((await readWorkbook(bytes)).text)).toEqual(["Row 1: | First |  |  |  |  | Second |"]);
  });

  it("takes only digits as the number of a string", async () => {
    // "-0" and "0x1" are numbers to JavaScript, and named the first and the second string.
    const cells = ['<c r="A1" t="s"><v> 1 </v></c>', '<c r="B1" t="s"><v>-0</v></c>', '<c r="C1" t="s"><v>0x1</v></c>', '<c r="D1" t="s"><v>1e0</v></c>', '<c r="E1" t="s"><v>1.0</v></c>', '<c r="F1" t="s"><v>7</v></c>', '<c r="G1" t="s"><v>01</v></c>'];
    const bytes = await workbook(`<row r="1">${cells.join("")}</row>`, { strings: ["First", "Second"] });
    expect(rowsOf((await readWorkbook(bytes)).text)).toEqual(["Row 1: | Second |  |  |  |  |  | Second |"]);
  });
});

describe("half of a surrogate pair in an Office file (review 0.99.10)", () => {
  const EMOJI = "\u{1f600}";

  it("decodes a reference to half of a pair as U+FFFD, and two that make a pair as their character", () => {
    expect(decodeEntities("a&#xD800;b")).toBe("a�b");
    expect(decodeEntities("a&#56320;b")).toBe("a�b");
    expect(decodeEntities("&#xDC00;&#xD800;")).toBe("��");
    expect(decodeEntities("&#xD83D;&#xDE00; &#55357;&#56832; &#x1F600;")).toBe(`${EMOJI} ${EMOJI} ${EMOJI}`);
    // What was not a reference to a character before is still left as it is written.
    expect(decodeEntities("&#0; &#x110000; &amp; &#65;&#x42;")).toBe("&#0; &#x110000; & AB");
  });

  it("keeps a pair of references whole when the XML is cut between them", () => {
    const texts: string[] = [];
    const stream = new XmlStream({ text: (text) => texts.push(text) });
    for (const piece of ["<t>a&#xD83D;", "&#xDE00;b &#55357;", "&#56832;c &#xD83D;", "</t><t>&#xD800", ";d</t>"]) stream.write(piece);
    expect(texts.every((text) => wellFormed(text) === text)).toBe(true);
    expect(texts.join("")).toBe(`a${EMOJI}b ${EMOJI}c ��d`);
  });

  it("stores no half of a pair from a DOCX: in a paragraph, a table cell and a list number", async () => {
    const numbering = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="&#xD800;%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    const body = [
      p("before &#xD800; after"),
      p("an emoji in two references: &#55357;&#56832;"),
      `<w:tbl><w:tr><w:tc>${p("cell &#xDFFF;")}</w:tc><w:tc>${p("next")}</w:tc></w:tr></w:tbl>`,
      p("item", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    ].join("");
    const text = await docxText(await word(body, undefined, numbering));
    expect(wellFormed(text)).toBe(text);
    expect(text.split("\n")).toEqual(["before � after", `an emoji in two references: ${EMOJI}`, "| cell � | next |", "�1. item"]);

    // As an application reads it: nothing that is half a character is stored.
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ requireOwner: false, store });
    const meta = await files.ingest({ name: "halves.docx", bytes: await word(body, undefined, numbering) });
    const stored = await store.get(meta.id);
    expect(stored && wellFormed(stored.text) === stored.text).toBe(true);
    expect(stored?.text).toContain("before � after");
  });

  it("stores no half of a pair from an XLSX: in a reference, an Excel escape and a sheet name", async () => {
    const rows = [
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>inline &#xDC00;</t></is></c><c r="C1" t="str"><v>cached _xD800_</v></c></row>',
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>_xD83D__xDE00_ &#xD83D;&#xDE00;</t></is></c></row>',
    ];
    const bytes = await zip({
      "xl/workbook.xml": `<workbook ${S}><sheets><sheet name="Q1 &#xD800;_xDBFF_" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData>${rows.join("")}</sheetData></worksheet>`,
      "xl/sharedStrings.xml": `<sst ${S}><si><t>shared &#xD800; _xDFFF_</t></si><si><t>plain</t></si></sst>`,
    });
    const { text } = await readWorkbook(bytes);
    expect(wellFormed(text)).toBe(text);
    expect(text.split("\n")).toEqual([
      "## Sheet 1: Q1 ��",
      "Columns: | A | B | C |",
      "Row 1: | shared � � | inline � | cached � |",
      `Row 2: | plain | ${EMOJI} ${EMOJI} |`,
    ]);
  });
});

// ---------- Checked, and left as it is ----------

/** The ZIP64 form of a ZIP: an end record of 0xFFFF, a locator, and a ZIP64 end record that `change` may alter. */
function asZip64(zipped: Uint8Array, change: (end64: Buffer, fields: { size: number; offset: number }) => void = () => {}): Uint8Array {
  const bytes = Buffer.from(zipped);
  const end = bytes.length - 22;
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeBigUInt64LE(2n, 24);
  end64.writeBigUInt64LE(2n, 32);
  end64.writeBigUInt64LE(BigInt(size), 40);
  end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(end), 8);
  locator.writeUInt32LE(1, 16);
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0xffff, 8);
  record.writeUInt16LE(0xffff, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  change(end64, { size, offset });
  return new Uint8Array(Buffer.concat([bytes.subarray(0, end), end64, locator, record]));
}

describe("the directory of a ZIP, read before JSZip reads it (review 0.99.10: nothing to fix)", () => {
  const LIMITS = { parts: 20_000, extraFields: 80_000, textBytes: 8 * 1024 * 1024 };

  it("leaves a file uncounted only where JSZip itself stops before it reads a part", async () => {
    // The review read "undefined" as a way past the limits, by a ZIP64 end record whose size is
    // negative. JSZip does the same sums, and stops at the same places with an error of its own.
    const archive = new JSZip();
    archive.file("word/document.xml", `<w:document ${W}><w:body>${p("Text.")}</w:body></w:document>`);
    for (let part = 0; part < 20; part++) archive.file(`customXml/item${part}.xml`, "<x/>");
    const zipped = await archive.generateAsync({ type: "uint8array" });
    expect(readZipDirectory(asZip64(zipped), LIMITS)?.parts).toBe(23);
    const cases: Array<[string, Uint8Array]> = [
      ["a ZIP64 end record with a negative size", asZip64(zipped, (end64) => end64.writeInt32LE(-1, 4))],
      ["a negative size that leaves the directory where it is", asZip64(zipped, (end64, { offset }) => {
        end64.writeInt32LE(-1_000, 4);
        end64.writeInt32LE(offset + 1_044, 48);
      })],
      ["a directory 5 bytes longer than the file has room for", asZip64(zipped, (end64, { size }) => end64.writeInt32LE(size + 5, 40))],
      ["a directory before the start of the file", asZip64(zipped, (end64) => end64.writeInt32LE(-5, 48))],
      ["a directory past the end of the file", asZip64(zipped, (end64) => end64.writeInt32LE(0x7fffffff, 48))],
    ];
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    for (const [name, bytes] of cases) {
      const directory = readZipDirectory(bytes, LIMITS);
      expect(directory === undefined || directory.parts === 0, name).toBe(true);
      await expect(JSZip.loadAsync(bytes), name).rejects.toThrow(/Corrupted zip|End of data reached/);
      await expect(files.ingest({ name: "end.docx", bytes }), name).rejects.toThrow();
    }
  });

  it("counts the name of a part where JSZip reads it: in the local header, not in the directory", async () => {
    // 150 records whose names in the directory are 60,000 bytes each, 9 MB together, past the
    // limit of 8 MB had they counted. JSZip skips them: it takes each name from the local header.
    const locals: Buffer[] = [];
    const records: Buffer[] = [];
    let offset = 0;
    for (let part = 0; part < 150; part++) {
      const name = Buffer.from(`p${part}`);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(name.length, 26);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(60_000, 28);
      record.writeUInt32LE(offset, 42);
      locals.push(local, name);
      records.push(record, Buffer.alloc(60_000, 0x41));
      offset += 30 + name.length;
    }
    const directory = Buffer.concat(records);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(150, 8);
    end.writeUInt16LE(150, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    const bytes = new Uint8Array(Buffer.concat([...locals, directory, end]));
    expect(directory.length).toBeGreaterThan(LIMITS.textBytes);
    // "p0" to "p149": 10 names of 2 characters, 90 of 3 and 50 of 4.
    expect(readZipDirectory(bytes, LIMITS)).toEqual({ parts: 150, extraFields: 0, textBytes: 490, endless: false });
    const read = await JSZip.loadAsync(bytes);
    expect(Object.keys(read.files)).toEqual(Array.from({ length: 150 }, (_, part) => `p${part}`));
  });
});

describe("pdf-lib's writer, changed to add the objects of a cut in order (review 0.99.10: a guard)", () => {
  it("writes the cut pdf-lib's own method writes, to the byte, and is still in use", async () => {
    // `appendInOrder` (src/pdf-pages.ts) adds an object to the end of the writer's list where
    // pdf-lib's `appendEntry` searches the list for its place. It reaches into the library, so
    // this fails when a new version of pdf-lib no longer has that shape, or orders otherwise.
    const file = pdfWithPictures(6, { shared: true, links: true });
    // The first cut readies pdf-lib's writer; the second is the one compared.
    await cutPdfPages(file, 2, 4, 10 * MB);
    const inOrder = await cutPdfPages(file, 2, 4, 10 * MB);
    const { PDFCrossRefStream } = pdfLib;
    const create = PDFCrossRefStream.create;
    let changed = 0;
    PDFCrossRefStream.create = (dictionary, encode) => {
      const stream = create(dictionary, encode);
      // The method was put on the stream itself: without it, the stream has pdf-lib's own again.
      if (Object.hasOwn(stream, "appendEntry")) {
        delete (stream as unknown as { appendEntry?: unknown }).appendEntry;
        changed++;
      }
      return stream;
    };
    let searched: Awaited<ReturnType<typeof cutPdfPages>>;
    try {
      searched = await cutPdfPages(file, 2, 4, 10 * MB);
    } finally {
      PDFCrossRefStream.create = create;
    }
    expect(changed).toBeGreaterThan(0);
    expect(Buffer.from(inOrder.bytes).equals(Buffer.from(searched.bytes))).toBe(true);
  });
});
