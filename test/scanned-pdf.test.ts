import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, createPdfExtractor, MemoryDocumentStore, type DocumentStore, type StoredDocument } from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { paint, PdfBuilder, textLine } from "./pdf-fixtures.js";

/** A scan: every page is one picture of its own, and there is no text anywhere. */
function scan(pages: number): Uint8Array {
  const builder = new PdfBuilder();
  for (let page = 0; page < pages; page++) builder.page(paint("Im1", 612, 792, 0, 0), { Im1: builder.image() });
  return builder.build();
}

const REFUSED = "This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.";
const SCANNED_PAGE = "[Picture on this page. This text cannot show it.]\n[No text on this page. It may be a scan, a photo, or a chart.]";

describe("a PDF without any text", () => {
  it("is refused when its pages cannot be shown, as it always was", async () => {
    const plain = createLargeFiles({ store: new MemoryDocumentStore() });
    await expect(plain.ingest({ name: "scan.pdf", bytes: scan(3) })).rejects.toThrow(REFUSED);

    // Originals are asked for, but this store cannot keep them.
    const documents = new Map<string, StoredDocument>();
    const store: DocumentStore = {
      put: async (document) => void documents.set(document.meta.id, document),
      get: async (id) => documents.get(id),
      getMeta: async (id) => documents.get(id)?.meta,
      delete: async (id) => documents.delete(id),
    };
    await expect(createLargeFiles({ store, keepOriginals: ["pdf"] }).ingest({ name: "scan.pdf", bytes: scan(3) })).rejects.toThrow(REFUSED);

    // Originals of other formats do not help a PDF.
    await expect(createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["docx"] }).ingest({ name: "scan.pdf", bytes: scan(3) })).rejects.toThrow(REFUSED);
    // And the caller can keep refusing scans.
    await expect(createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], scannedPdfPages: 0 }).ingest({ name: "scan.pdf", bytes: scan(3) })).rejects.toThrow(REFUSED);
  });

  it("is accepted when its original is kept: each page says that it has no text and shows a picture", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store, keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "scan.pdf", bytes: scan(3) });
    expect(meta).toMatchObject({ format: "pdf", pages: 3, originalKept: true, lines: 11 });
    expect((await store.get(meta.id))!.text).toBe([1, 2, 3].map((page) => `--- Page ${page} ---\n${SCANNED_PAGE}`).join("\n\n"));
    const { result, files: returned } = await files.tools([meta], { viewPages: true }).executeWithFiles("view_pages", { document_id: meta.id, from_page: 2, to_page: 3 });
    expect(result).toMatchObject({ pages: "2-3", total_pages: 3 });
    expect(returned).toHaveLength(1);
  });

  it("is refused past the number of pages that can be looked at, and the message says so", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    expect((await files.ingest({ name: "scan.pdf", bytes: scan(30) })).pages).toBe(30);
    await expect(files.ingest({ name: "scan.pdf", bytes: scan(31) })).rejects.toThrow(
      "This PDF has no text layer (it may be scanned) and 31 pages. Without text it can only be read by looking at its pages, which works for up to 30 pages. It needs OCR first.",
    );
    const generous = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], scannedPdfPages: 40 });
    expect((await generous.ingest({ name: "scan.pdf", bytes: scan(31) })).pages).toBe(31);
  });

  it("does not change what happens to a PDF that has text on any page", async () => {
    const builder = new PdfBuilder();
    builder.page(textLine("A cover page with a title."));
    for (let page = 0; page < 40; page++) builder.page(paint("Im1", 612, 792, 0, 0), { Im1: builder.image() });
    // 41 pages, 40 of them scans: accepted with and without originals, as in 0.2.0.
    for (const options of [{}, { keepOriginals: ["pdf" as const] }]) {
      const meta = await createLargeFiles({ store: new MemoryDocumentStore(), ...options }).ingest({ name: "mixed.pdf", bytes: builder.build() });
      expect(meta.pages).toBe(41);
    }
  });

  it("is refused by the extractor unless it is told that scans are welcome", async () => {
    const extractor = createPdfExtractor();
    const input = { name: "scan.pdf", mimeType: "application/pdf", format: "pdf" as const };
    await expect(extractor(scan(2), input)).rejects.toThrow(REFUSED);
    await expect(extractor(scan(2), { ...input, scannedPages: 1 })).rejects.toThrow(/and 2 pages\..*up to 1 pages/);
    expect((await extractor(scan(2), { ...input, scannedPages: 2 })).pages).toBe(2);
  });

  it("gets view_pages from askGemini, which is the only way to read it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "scan.pdf", bytes: scan(3) });
    const bodies: Array<Record<string, any>> = [];
    const replies = [
      { candidates: [{ content: { parts: [{ functionCall: { name: "view_pages", args: { document_id: meta.id, from_page: 1, to_page: 3 } } }] } }] },
      { candidates: [{ content: { parts: [{ text: "It is an invoice." }] }, finishReason: "STOP" }] },
    ];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(replies[bodies.length - 1]);
    });
    const result = await askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "m" }), fetch, documentIds: [meta.id], messages: [{ role: "user", text: "What is this document?" }] });
    expect(bodies[0]!.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name)).toEqual(["view_pages"]);
    expect(bodies[0]!.contents[0].parts[0].text).toContain(`--- Page 1 ---\n${SCANNED_PAGE}`);
    expect(bodies[0]!.systemInstruction.parts[0].text).toContain(`"scan.pdf" (document_id ${meta.id}, 3 pages)`);
    const response = bodies[1]!.contents.at(-1).parts[0].functionResponse;
    expect(response.response).toMatchObject({ pages: "1-3", total_pages: 3 });
    expect(response.parts[0].inlineData.mimeType).toBe("application/pdf");
    expect(result).toMatchObject({ text: "It is an invoice.", answered: true, steps: ["Look at scan.pdf pages 1-3"] });
  });
});
