// Originals by reference (0.9.0): the application keeps the uploaded file, the library records
// where (`IngestInput.original.ref`) with its size and SHA-256, and reads it back through
// `LargeFilesOptions.originals` (`fileOriginals` in llm-large-files/node) instead of keeping a copy.
import "./load-pdf-libraries.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DocumentStoreError,
  MemoryDocumentStore,
  toDocumentSummary,
  type AskEvent,
  type DocumentContext,
  type DocumentStore,
  type IngestEvent,
  type OriginalReadContext,
  type OriginalsReader,
  type StoredDocument,
} from "llm-large-files";
import { fileOriginals } from "llm-large-files/node";
import { calls, fakeModel, says } from "./fake-model.js";
import { numberedPdf, paint, PdfBuilder } from "./pdf-fixtures.js";

const SCOPE = ["user-a1", "chat-b2"];
const OWNER = "owner-7f3k";
const ACCESS = { owner: OWNER, scope: SCOPE };
const REF = "user-a1/chat-b2/uploads/upload-c3";
const CHANGED = "report.pdf changed on the server since it was read. Attach it again to look at its pages.";
const GONE = "The original file of report.pdf is no longer on the server, so its pages cannot be shown. Answer from the text.";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A store that counts the original files it is given and asked for. */
class CountingStore extends MemoryDocumentStore {
  puts = 0;
  gets = 0;
  override async putOriginal(id: string, bytes: Uint8Array, context?: DocumentContext) {
    this.puts++;
    return super.putOriginal(id, bytes, context);
  }
  override async getOriginal(id: string, context?: DocumentContext) {
    this.gets++;
    return super.getOriginal(id, context);
  }
}

/** A store that keeps no original files: it has neither `putOriginal` nor `getOriginal`. */
function storeWithoutOriginals(): DocumentStore {
  const documents = new Map<string, StoredDocument>();
  return {
    put: async (document) => void documents.set(document.meta.id, structuredClone(document)),
    get: async (id) => structuredClone(documents.get(id)),
    getMeta: async (id) => structuredClone(documents.get(id)?.meta),
    delete: async (id) => documents.delete(id),
  };
}

/** A scan: every page is one picture, and there is no text anywhere. */
function scan(pages: number): Uint8Array {
  const builder = new PdfBuilder();
  for (let page = 0; page < pages; page++) builder.page(paint("Im1", 612, 792, 0, 0), { Im1: builder.image() });
  return builder.build();
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llf-originals-"));
  await mkdir(path.join(root, "user-a1", "chat-b2", "uploads"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Saves an upload where the application keeps it, and returns its path. */
async function save(bytes: Uint8Array, ref = REF): Promise<string> {
  const at = path.join(root, ref);
  await writeFile(at, bytes);
  return at;
}

/** A library over `store` that keeps PDFs by their ref, and one PDF in it, ingested from where it is saved. */
async function withRef(bytes = numberedPdf(3), store: DocumentStore = new CountingStore(), reader: OriginalsReader = fileOriginals(root)) {
  const files = createLargeFiles({ requireOwner: false, store, keepOriginals: ["pdf"], originals: reader });
  const at = await save(bytes);
  const meta = await files.ingest({ name: "report.pdf", source: { path: at }, original: { ref: REF }, ...ACCESS });
  const view = async (from = 1) => (await files.tools([meta], { viewPages: true, access: ACCESS }).executeWithFiles("view_pages", { document_id: meta.id, from_page: from, to_page: from + 1 }));
  return { files, meta, store, at, view };
}

describe("originals by reference", () => {
  it("records where the file is, with its size and SHA-256, and never copies it into the store", async () => {
    const pdf = numberedPdf(3);
    const { files, meta, store } = await withRef(pdf);
    expect((store as CountingStore).puts).toBe(0);
    expect(meta.originalKept).toBe(true);
    expect(meta.original).toEqual({ ref: REF, bytes: pdf.byteLength, sha256: sha256(pdf) });
    expect(meta.sha256).toBe(sha256(pdf));
    expect(await files.getOriginal(meta.id, ACCESS)).toEqual(pdf);
    // Not from the store.
    expect((store as CountingStore).gets).toBe(0);
    expect(await store.getOriginal!(meta.id, ACCESS)).toBeUndefined();
  });

  it("shows pages through fileOriginals, for prepare and for view_pages", async () => {
    const { files, meta, view } = await withRef();
    const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 }, { ...ACCESS, viewPages: true });
    expect(prepared.viewable.map((viewable) => viewable.id)).toEqual([meta.id]);
    const { result, files: shown } = await view(1);
    expect(result).toMatchObject({ document: "report.pdf", pages: "1-2", total_pages: 3 });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.mimeType).toBe("application/pdf");
  });

  it("answers that a file changed since it was read: of another size, or of the same size with other bytes", async () => {
    const pdf = numberedPdf(3);
    const { files, meta, at, view } = await withRef(pdf);
    await writeFile(at, numberedPdf(4));
    expect((await view()).result).toEqual({ error: CHANGED });
    expect(await files.getOriginal(meta.id, ACCESS)).toBeUndefined();
    const same = pdf.slice();
    same[0] = 0x20;
    await writeFile(at, same);
    expect((await view()).result).toEqual({ error: CHANGED });
    expect(await files.getOriginal(meta.id, ACCESS)).toBeUndefined();
    // Back as it was: its pages are shown again.
    await writeFile(at, pdf);
    expect((await view()).files).toHaveLength(1);
  });

  it("answers that a file is gone when it is not there, or is reached through a link", async () => {
    const { files, meta, at, view } = await withRef();
    await rm(at);
    expect((await view()).result).toEqual({ error: GONE });
    expect(await files.getOriginal(meta.id, ACCESS)).toBeUndefined();
    if (process.platform === "win32") return;
    // A link at the file's name, to a file inside the folder: refused, not followed.
    await save(numberedPdf(3), "user-a1/chat-b2/uploads/real");
    await symlink(path.join(root, "user-a1/chat-b2/uploads/real"), at);
    expect((await view()).result).toEqual({ error: GONE });
    // A link at a folder on the way.
    await rm(at);
    await save(numberedPdf(3));
    await rm(path.join(root, "user-a1", "chat-b2"), { recursive: true });
    await mkdir(path.join(root, "elsewhere", "uploads"), { recursive: true });
    await writeFile(path.join(root, "elsewhere", "uploads", "upload-c3"), numberedPdf(3));
    await symlink(path.join(root, "elsewhere"), path.join(root, "user-a1", "chat-b2"));
    expect(await readFile(at)).toEqual(Buffer.from(numberedPdf(3)));
    expect((await view()).result).toEqual({ error: GONE });
  });

  it("follows a link at the folder of fileOriginals itself", async () => {
    if (process.platform === "win32") return;
    const linked = `${root}-link`;
    await symlink(root, linked);
    try {
      const pdf = numberedPdf(3);
      await save(pdf);
      expect(await fileOriginals(linked).read(REF, { id: "a", bytes: pdf.byteLength })).toEqual(new Uint8Array(pdf));
    } finally {
      await rm(linked);
    }
  });

  it("refuses a ref outside its folder, with a TypeError the library passes on as a store error", async () => {
    const reader = fileOriginals(path.join(root, "user-a1"));
    await writeFile(path.join(root, "secret"), "not for you");
    const context = { id: "a", bytes: 11 };
    for (const ref of ["../secret", path.join(root, "secret"), "chat-b2/../../secret", "", ".", "a\0b", "x".repeat(1_025)]) {
      await expect(reader.read(ref, context)).rejects.toThrow(new TypeError("The ref of an original must be a relative path to a file inside the folder of fileOriginals."));
    }
    // Through the library: the ingest records the ref; reading it back fails as the store's read.
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"], originals: reader });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(3), original: { ref: "../secret" } });
    const error = await files.getOriginal(meta.id).catch((caught: unknown) => caught);
    expect(DocumentStoreError.is(error)).toBe(true);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    const { result } = await files.tools([meta], { viewPages: true }).executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 });
    expect(result).toEqual({ error: "The document store could not be read. Try again." });
  });

  it("reads no more than one byte past the size the file had", async () => {
    const at = await save(new Uint8Array(10_000).fill(65));
    expect((await fileOriginals(root).read(REF, { id: "a", bytes: 100 }))!.byteLength).toBe(101);
    expect((await fileOriginals(root).read(REF, { id: "a", bytes: 20_000 }))!.byteLength).toBe(10_000);
    expect(await readFile(at)).toHaveLength(10_000);
  });

  it("leaves the file where it is when the document is deleted", async () => {
    const pdf = numberedPdf(3);
    const { files, meta, at } = await withRef(pdf);
    expect(await files.delete(meta.id, ACCESS)).toBe(true);
    expect(await files.getMeta(meta.id, ACCESS)).toBeUndefined();
    expect(new Uint8Array(await readFile(at))).toEqual(pdf);
  });

  it("accepts a scanned PDF when a reader reads it back, over a store that keeps no copies", async () => {
    const files = createLargeFiles({ requireOwner: false, store: storeWithoutOriginals(), keepOriginals: ["pdf"], originals: fileOriginals(root) });
    const at = await save(scan(2));
    const meta = await files.ingest({ name: "scan.pdf", source: { path: at }, original: { ref: REF } });
    expect(meta).toMatchObject({ pages: 2, originalKept: true });
    expect((await files.tools([meta], { viewPages: true }).executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 })).files).toHaveLength(1);
    // Without a ref, the store cannot keep it, and a scan is refused as before.
    await expect(files.ingest({ name: "scan.pdf", source: { path: at } })).rejects.toThrow("This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.");
  });

  it("keeps the formats of keepOriginals only, and needs a reader", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"], originals: fileOriginals(root) });
    const notes = await files.ingest({ name: "notes.md", bytes: new TextEncoder().encode("# Notes"), original: { ref: REF } });
    expect(notes.originalKept).toBeUndefined();
    expect(notes.original).toBeUndefined();
    const without = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    await expect(without.ingest({ name: "report.pdf", bytes: numberedPdf(3), original: { ref: REF } })).rejects.toThrow(new TypeError("original needs LargeFilesOptions.originals, which reads the file from its ref."));
    await expect(files.ingest({ name: "report.pdf", bytes: numberedPdf(3), original: { ref: "x".repeat(1_025) } })).rejects.toThrow(new TypeError("original.ref must be a string of 1 to 1,024 characters."));
    expect(() => createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), originals: {} as OriginalsReader })).toThrow(TypeError);
    // A library over the same store without a reader cannot show those pages, and does not offer them.
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(3), original: { ref: REF } });
    const other = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    expect(await other.getOriginal(meta.id)).toBeUndefined();
  });

  it("asks the reader with the call's scope and owner, the document's ID and size, and the ref the store holds", async () => {
    const pdf = numberedPdf(3);
    const asked: Array<[string, OriginalReadContext]> = [];
    const reader: OriginalsReader = { read: async (ref, context) => { asked.push([ref, context]); return pdf; } };
    const { files, meta } = await withRef(pdf, new MemoryDocumentStore(), reader);
    // Metadata handed in with another ref: the one the store holds is read.
    const forged = { ...meta, original: { ...meta.original!, ref: "../../etc/passwd" } };
    expect((await files.tools([forged], { viewPages: true, access: ACCESS }).executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 })).files).toHaveLength(1);
    expect(asked).toEqual([[REF, { scope: SCOPE, owner: OWNER, id: meta.id, bytes: pdf.byteLength }]]);
  });

  it("never sends the ref, the SHA-256, the scope, the owner or the MIME type to the model, nor the ref and the SHA-256 in events or summaries", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"], originals: fileOriginals(root), budget: { inlineTokens: 1 } });
    const at = await save(numberedPdf(3));
    const ingestEvents: IngestEvent[] = [];
    const meta = await files.ingest({ name: "report.pdf", mimeType: "application/x-llf-upload", source: { path: at }, original: { ref: REF }, ...ACCESS, onEvent: (event) => ingestEvents.push(event) });
    expect(meta.mimeType).toBe("application/x-llf-upload");
    const model = fakeModel([
      calls([{ id: "c1", name: "view_pages", args: { document_id: meta.id, from_page: 1 } }, { id: "c2", name: "read_document", args: { document_id: meta.id, start_line: 1 } }]),
      says("Page 1 says what it says."),
    ]);
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "What is on page 1?" }], ...ACCESS, onEvent: (event) => events.push(event) });
    expect(result.answered).toBe(true);
    const look = events.find((event) => event.type === "tool.start" && event.tool === "view_pages");
    expect(events.find((event) => event.type === "tool.end" && look?.type === "tool.start" && event.callId === look.callId)).toMatchObject({ outcome: "ok" });
    const sent = JSON.stringify(model.requests);
    for (const secret of [REF, "upload-c3", meta.sha256!, ...SCOPE, OWNER, "application/x-llf-upload"]) expect(sent).not.toContain(secret);
    const told = JSON.stringify([ingestEvents, events, toDocumentSummary(meta)]);
    for (const secret of [REF, "upload-c3", meta.sha256!]) expect(told).not.toContain(secret);
  });

  // The answer that a file changed is the model's to tell, as a tool's result: it is not an error
  // of the question, so neither run.error nor errorInfoOf has anything to read, and it names
  // neither the ref nor the folder.
  it("tells the model that a file changed, and the question goes on to its answer", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"], originals: fileOriginals(root), budget: { inlineTokens: 1 } });
    const at = await save(numberedPdf(3));
    const meta = await files.ingest({ name: "report.pdf", source: { path: at }, original: { ref: REF }, ...ACCESS });
    await writeFile(at, numberedPdf(4));
    const model = fakeModel([calls([{ id: "c1", name: "view_pages", args: { document_id: meta.id, from_page: 1 } }]), says("It changed; attach it again.")]);
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "What is on page 1?" }], ...ACCESS, onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ answered: true, text: "It changed; attach it again." });
    expect(events.find((event) => event.type === "tool.end")).toMatchObject({ outcome: "error", error: CHANGED });
    expect(events.some((event) => event.type === "run.error")).toBe(false);
    expect(events.at(-1)?.type).toBe("run.finish");
    const sent = JSON.stringify(model.requests);
    expect(sent).toContain(CHANGED);
    for (const told of [sent, JSON.stringify(events)]) {
      for (const secret of [REF, "upload-c3", root, meta.sha256!]) expect(told).not.toContain(secret);
    }
  });
});
