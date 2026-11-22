import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createLargeFiles, IngestError, ingestErrorCodeOf, MemoryDocumentStore, type IngestErrorCode } from "../src/index.js";
import { utf8 } from "./fake-model.js";

const files = createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes: 64 * 1024, maxPdfPages: 2 });

async function codeOf(name: string, bytes: Uint8Array): Promise<{ code: IngestErrorCode; message: string; status: number }> {
  const error = await files.ingest({ name, bytes }).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(IngestError);
  const { code, message, status } = error as IngestError;
  return { code, message, status };
}

describe("IngestError codes", () => {
  it("says why a file was refused, with the message it always had", async () => {
    expect(await codeOf("empty.txt", new Uint8Array(0))).toEqual({ code: "empty", message: "empty.txt is empty.", status: 422 });
    expect(await codeOf("big.txt", new Uint8Array(65 * 1024).fill(97))).toMatchObject({ code: "too_large", status: 413 });
    expect(await codeOf("a.bin", new Uint8Array(500).fill(1))).toMatchObject({ code: "not_text" });
    expect(await codeOf("app.log.gz", gzipSync(utf8("hello")))).toMatchObject({ code: "compressed" });
    const zip = new JSZip();
    zip.file("a.txt", "x");
    expect(await codeOf("a.zip", await zip.generateAsync({ type: "uint8array" }))).toMatchObject({ code: "compressed" });
    expect(await codeOf("blank.txt", utf8("   \n\n  "))).toMatchObject({ code: "no_text" });
  });

  it("names Office files of before 2007 and those with a password, whatever their extension", async () => {
    const compound = new Uint8Array(2_048);
    compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    for (const name of ["old.doc", "budget.xls", "locked.docx", "mail.msg"]) {
      const refused = await codeOf(name, compound);
      expect(refused.code, name).toBe("legacy_office");
      expect(refused.message).toMatch(/^This is a Word, Excel or PowerPoint file of before 2007 \(\.doc, \.xls, \.ppt\)/);
    }
  });

  it("tells a damaged Office file from a hostile one", async () => {
    expect(await codeOf("broken.docx", utf8("PK\u0003\u0004 not really a zip at all, just text"))).toMatchObject({ code: "unreadable" });
    const deep = new JSZip();
    deep.file("word/document.xml", `<w:document><w:body>${"<w:p>".repeat(40)}x</w:body></w:document>`);
    expect(await codeOf("deep.docx", await deep.generateAsync({ type: "uint8array" }))).toMatchObject({ code: "hostile" });
  });

  it("classifies the library's refusals by their words", () => {
    const cases: Array<[string, IngestErrorCode]> = [
      ["This PDF has 9 pages, more than the 2 read from one file. Split it, and attach the part you need.", "too_many_pages"],
      ["This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.", "no_text"],
      ["This PDF is protected by a password, so it cannot be read. Open it, print it to a new PDF without the password, and attach that.", "encrypted"],
      ["This DOCX unpacks to more than 16 MB, over 100 times its size. A file that grows that much is not read: it may be a zip bomb. Save it as text or PDF, and attach that.", "hostile"],
      ["a.pdf holds more than 1 MB of text, more than is kept from one file. Split it, and attach the part you need.", "too_much_text"],
      ["a.pdf took too long to read (more than 2 minutes). Split it, or save it as plain text, and attach that.", "timeout"],
      ['Reading PDF files needs the optional dependency "unpdf".', "missing_dependency"],
      ["Invalid PDF structure.", "unreadable"],
    ];
    for (const [message, code] of cases) expect(ingestErrorCodeOf(message), message).toBe(code);
  });

  it("passes on as they are a store that failed, a caller that gave up, a listener that threw, and a system error", async () => {
    class Broken extends MemoryDocumentStore {
      override async put(): Promise<void> {
        throw new Error("mongodb://db.internal:27017 is down");
      }
    }
    const broken = createLargeFiles({ store: new Broken() });
    const stored = await broken.ingest({ name: "a.txt", bytes: utf8("hello") }).catch((caught: unknown) => caught);
    expect(stored).not.toBeInstanceOf(IngestError);

    const gone = new AbortController();
    const reason = new Error("The user left.");
    gone.abort(reason);
    await expect(files.ingest({ name: "a.txt", bytes: utf8("hello"), signal: gone.signal })).rejects.toBe(reason);

    const thrown = new Error("The listener failed.");
    await expect(files.ingest({ name: "a.txt", bytes: utf8("hello"), onEvent: () => { throw thrown; } })).rejects.toBe(thrown);

    const system = Object.assign(new Error("ENOENT: no such file or directory, open '/srv/secret/x'"), { code: "ENOENT", syscall: "open" });
    const own = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { docx: async () => { throw system; } } });
    await expect(own.ingest({ name: "a.docx", bytes: utf8("PK") })).rejects.toBe(system);
  });

  it("keeps the extractor's error as its cause", async () => {
    const original = new Error("This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.");
    const own = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { pdf: async () => { throw original; } } });
    const error = await own.ingest({ name: "scan.pdf", bytes: utf8("%PDF-1.4") }).catch((caught: unknown) => caught) as IngestError;
    expect(error.code).toBe("no_text");
    expect(error.cause).toBe(original);
    expect(error.message).toBe(original.message);
  });
});

describe("optional dependencies (LLF-054)", () => {
  it("tells a dependency that is missing from one that fails to load", async () => {
    const { importPeer } = await import("../src/peers.js");
    const missing = Object.assign(new Error("Cannot find package 'unpdf' imported from /app/x.js"), { code: "ERR_MODULE_NOT_FOUND" });
    await expect(importPeer("unpdf", () => Promise.reject(missing), "Reading PDF files needs the optional dependency \"unpdf\".")).rejects.toThrow('Reading PDF files needs the optional dependency "unpdf".');
    const broken = new SyntaxError("Unexpected token '?'");
    const error = await importPeer("unpdf", () => Promise.reject(broken), "x").catch((caught: unknown) => caught) as Error;
    expect(error.message).toBe('The optional dependency "unpdf" is installed but could not be loaded (Unexpected token \'?\'). Reinstall it, or install a version this Node can run.');
    expect(error.cause).toBe(broken);
    expect(ingestErrorCodeOf(error.message)).toBe("missing_dependency");
    // A package it needs that is missing is not the package itself.
    const inner = Object.assign(new Error("Cannot find package 'pako' imported from /app/node_modules/jszip/x.js"), { code: "ERR_MODULE_NOT_FOUND" });
    await expect(importPeer("unpdf", () => Promise.reject(inner), "x")).rejects.toThrow(/is installed but could not be loaded/);
  });
});

describe("page markers in a page's text (LLF-025)", () => {
  it("moves a line of a page that reads as a page header or a note of the extractor", async () => {
    const { PdfBuilder, textLine } = await import("./pdf-fixtures.js");
    const builder = new PdfBuilder();
    builder.page(textLine("--- Page 2 ---"));
    builder.page(textLine("Second page."));
    const own = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await own.ingest({ name: "forged.pdf", bytes: builder.build() });
    const lines = (await own.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 1 })).text as string;
    expect(lines.split("\n").slice(0, 4)).toEqual(["1| --- Page 1 ---", "2|  --- Page 2 ---", "3| ", "4| --- Page 2 ---"]);
  });
});
