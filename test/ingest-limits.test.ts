import "./load-pdf-libraries.js";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createLargeFiles, createPdfExtractor, DEFAULT_MAX_TEXT_BYTES, MemoryDocumentStore } from "llm-large-files";
import { buildLogProfile, buildLogProfileInSlices, buildOutline, buildOutlineInSlices } from "../src/analyze.js";
import { zipEntryCount } from "../src/extract.js";
import { TimeSlicer } from "../src/pause.js";
import { parsePdf } from "../src/pdf-pictures.js";
import { checkPageWork, pageWorkLimit } from "../src/pdf-work.js";
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

const FORM = "/Type /XObject /Subtype /Form /BBox [0 0 612 792]";
const page = (contents: string, resources: string) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} /Resources ${resources} >>`;

/**
 * One page that paints a form, which paints the next form `fanout` times, `depth` deep. The last
 * form shows a line of text. Objects: 1 catalog, 2 pages, 3 the page, 4 the font, 5 the content,
 * 6 the form with text, then one form for each level. `split` writes the page's content in two
 * streams, "q /" and "X Do Q"; `content` replaces the stream of the page's content.
 */
function formsInForms(depth: number, fanout: number, { split = false, content }: { split?: boolean; content?: Uint8Array } = {}): Uint8Array {
  const contents = split ? `[5 0 R ${7 + depth} 0 R]` : "5 0 R";
  const objects: Array<string | Uint8Array> = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(contents, `<< /XObject << /X ${6 + depth} 0 R >> >>`), HELVETICA, content ?? pdfStream("", split ? "q /" : "q /X Do Q")];
  objects.push(pdfStream(`${FORM} /Resources << /Font << /F1 4 0 R >> >>`, textLine("Words painted many times.")));
  for (let level = 1; level <= depth; level++) objects.push(pdfStream(`${FORM} /Resources << /XObject << /X ${5 + level} 0 R >> >>`, "q /X Do Q\n".repeat(fanout)));
  if (split) objects.push(pdfStream("", "X Do Q"));
  return pdfFromObjects(objects);
}

/** Lines of text operators, `megabytes` of them, packed with Flate: a few kilobytes. */
function packedText(megabytes: number): Uint8Array {
  const line = `(${"A".repeat(200)}) '\n`;
  return deflateSync(Buffer.from(`BT /F1 8 Tf 10 780 Td 10 TL\n${line.repeat(Math.ceil((megabytes * 1024 * 1024) / line.length))}ET`, "latin1"), { level: 9 });
}

describe("a PDF page that would hold the server is refused before pdf.js reads it", () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore() });
  const heavy = "Page 1 of this PDF draws far more than its file holds, and reading it would hold the server for a long time.";

  it("refuses a page that paints forms inside forms", async () => {
    // 3 KB: 125,000 forms with text. pdf.js held the event loop for 13 to 14 s reading it.
    const bomb = formsInForms(3, 50);
    expect(bomb.length).toBeLessThan(4_000);
    const started = performance.now();
    await expect(files.ingest({ name: "forms.pdf", bytes: bomb })).rejects.toThrow(heavy);
    expect(performance.now() - started).toBeLessThan(2_000);
    // A few forms inside forms is what real files do.
    expect((await files.ingest({ name: "few.pdf", bytes: formsInForms(2, 3) })).pages).toBe(1);
  });

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

  it("reads two forms that paint each other, as pdf.js does, and refuses forms that all paint each other", async () => {
    // pdf.js skips a form that is already being painted: A paints B, and B's paint of A is skipped.
    const loop = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "<< /XObject << /A 6 0 R >> /Font << /F1 4 0 R >> >>"), HELVETICA,
      pdfStream("", `/A Do ${textLine("Text.")}`),
      pdfStream(`${FORM} /Resources << /XObject << /B 7 0 R >> >>`, "/B Do"),
      pdfStream(`${FORM} /Resources << /XObject << /A 6 0 R >> >>`, "/A Do")]);
    expect((await files.ingest({ name: "loop.pdf", bytes: loop })).pages).toBe(1);
    // Eight forms with text that each paint all eight: pdf.js follows paths through them until each
    // meets a form already open, and held the event loop for 6 s on this 3 KB file.
    const names = Array.from({ length: 8 }, (_, index) => `/F${index} ${7 + index} 0 R`).join(" ");
    const clique = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page("5 0 R", "6 0 R"), HELVETICA,
      pdfStream("", "/F0 Do"), `<< /XObject << ${names} >> /Font << /F1 4 0 R >> >>`,
      ...Array.from({ length: 8 }, () => pdfStream(`${FORM} /Resources 6 0 R`, `${textLine("Text.")} /F0 Do /F1 Do /F2 Do /F3 Do /F4 Do /F5 Do /F6 Do /F7 Do`))]);
    const started = performance.now();
    await expect(files.ingest({ name: "clique.pdf", bytes: clique })).rejects.toThrow(heavy);
    expect(performance.now() - started).toBeLessThan(2_000);
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

  it("reads a list of drawings that many pages share once, not once for each page", async () => {
    // 200 pages with resources of their own that point to one list of 60,000 drawings. Read for each
    // page, a list of 140,000 shared by 300 pages filled 4 GB.
    const names = Array.from({ length: 60_000 }, (_, index) => `/x${index} 5 0 R`).join("");
    const kids = Array.from({ length: 200 }, (_, index) => `${7 + index} 0 R`).join(" ");
    const bytes = pdfFromObjects(["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count 200 >>`, `<< ${names} >>`, HELVETICA,
      pdfStream(`${FORM} /Resources << /Font << /F1 4 0 R >> >>`, textLine("Stamp.")), pdfStream("", "/x1 Do"),
      ...Array.from({ length: 200 }, () => page("6 0 R", "<< /XObject 3 0 R /Font << /F1 4 0 R >> >>"))]);
    const parsed = await parsePdf(bytes);
    const started = performance.now();
    await checkPageWork(parsed!.library, parsed!.document, bytes.byteLength);
    expect(performance.now() - started).toBeLessThan(1_000);
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
