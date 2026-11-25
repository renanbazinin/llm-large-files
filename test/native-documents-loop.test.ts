// The loop sends small visual files as they are (0.99.9): only when every model declares
// `documents`, before the text of the documents, with a line that names them, and counted in the
// estimate. The text still goes, so citations and counts work as before.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { askWithFiles, checkCitations, createLargeFiles, DocumentStoreError, MemoryDocumentStore, type AskEvent, type DocumentsCapability, type ModelRequest, type ModelTextMessage } from "llm-large-files";
import { nativeFilesLine } from "../src/native.js";
import { numberedPdf, pdfWithPictures } from "./pdf-fixtures.js";
import { fakeModel, says } from "./fake-model.js";

const PDF_ONLY: DocumentsCapability = { formats: ["pdf"] };

/** A library of one user that keeps PDFs, with a PDF that shows a picture on each of its two pages. */
async function withPictures(name = "report.pdf", store = new MemoryDocumentStore()) {
  const files = createLargeFiles({ requireOwner: false, store, keepOriginals: ["pdf"] });
  const bytes = pdfWithPictures(2);
  const meta = await files.ingest({ name, bytes });
  return { files, meta, bytes, store };
}

const turn = (request: ModelRequest, index = 0) => request.messages[index] as ModelTextMessage;
const ask = (text: string) => [{ role: "user" as const, text }];

describe("small visual files sent as they are", () => {
  it("sends the file itself before the text, with the line that names it, in the first user turn", async () => {
    const { files, meta, bytes } = await withPictures();
    const model = fakeModel([says("A bar chart.")], { documents: PDF_ONLY });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: ask("What does the picture on page 2 show?") });
    const first = turn(model.requests[0]!);
    expect(first.files).toEqual([{ name: "attached-1.pdf", mimeType: "application/pdf", bytes }]);
    expect(Buffer.from(first.files![0]!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(first.parts[0]).toEqual({ text: nativeFilesLine(["report.pdf"]) });
    expect(first.parts[1]!.text).toContain("--- Page 1 ---");
    expect(first.parts[1]!.text).toContain("[Picture on this page. This text cannot show it.]");
    expect(first.parts[2]).toEqual({ text: "What does the picture on page 2 show?" });
  });

  it("answers in one request, without tools, when the file itself takes the place of view_pages", async () => {
    const { files, meta } = await withPictures();
    const looking = fakeModel([says("A bar chart.")]);
    await askWithFiles({ files, model: looking, documentIds: [meta.id], messages: ask("What does the picture show?") });
    // Without documents the PDF gets view_pages.
    expect(looking.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["view_pages"]);
    const model = fakeModel([says("A bar chart.")], { documents: PDF_ONLY });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: ask("What does the picture show?") });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools).toBeUndefined();
    expect(model.requests[0]!.system).not.toContain("view_pages");
    expect(result).toMatchObject({ answered: true, turns: 1, text: "A bar chart." });
  });

  it("puts the files with the text in the last turn with documentPlacement last", async () => {
    const { files, meta } = await withPictures();
    const model = fakeModel([says("Yes.")], { documents: PDF_ONLY });
    const messages = [
      { role: "user" as const, text: "Hello." },
      { role: "assistant" as const, text: "Hello. How can I help?" },
      { role: "user" as const, text: "Is there a chart?" },
    ];
    await askWithFiles({ files, model, documentIds: [meta.id], messages, documentPlacement: "last" });
    const request = model.requests[0]!;
    expect(turn(request, 0).files).toBeUndefined();
    expect(turn(request, 2).files?.map((file) => file.name)).toEqual(["attached-1.pdf"]);
    expect(turn(request, 2).parts.map((part) => part.text?.slice(0, 20))).toEqual(["Is there a chart?", nativeFilesLine(["report.pdf"]).slice(0, 20), "--- Attached file [m"]);
  });

  it("sends nothing when one model does not declare documents, or nativeDocuments is false", async () => {
    const { files, meta } = await withPictures();
    const run = async (modelDocuments?: DocumentsCapability, explorerDocuments?: DocumentsCapability, nativeDocuments?: boolean) => {
      const model = fakeModel([says("Done.")], modelDocuments ? { documents: modelDocuments } : {});
      const explorer = fakeModel([says("DONE")], { id: "explorer", ...(explorerDocuments ? { documents: explorerDocuments } : {}) });
      await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: ask("Is there a chart?"), ...(nativeDocuments !== undefined ? { nativeDocuments } : {}) });
      return JSON.stringify([...model.requests, ...explorer.requests]);
    };
    const plain = await run();
    expect(plain).not.toContain("attached-1.pdf");
    expect(await run(PDF_ONLY)).toBe(plain);
    expect(await run(undefined, PDF_ONLY)).toBe(plain);
    expect(await run(PDF_ONLY, PDF_ONLY, false)).toBe(plain);
    expect(await run(PDF_ONLY, PDF_ONLY)).toContain("attached-1.pdf");
  });

  it("shares the formats and limits of the model and its explorer", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const one = await files.ingest({ name: "one.pdf", bytes: pdfWithPictures(1) });
    const two = await files.ingest({ name: "two.pdf", bytes: pdfWithPictures(2) });
    const model = fakeModel([says("Done.")], { documents: { formats: ["pdf", "pptx"], maxPages: 10 } });
    const explorer = fakeModel([says("DONE")], { id: "explorer", documents: { formats: ["pdf"], maxPages: 1 } });
    await askWithFiles({ files, model, explorer, documentIds: [one.id, two.id], messages: ask("Which has a chart?") });
    const sent = [...model.requests, ...explorer.requests].flatMap((request) => turn(request).files ?? []);
    expect(new Set(sent.map((file) => file.name))).toEqual(new Set(["attached-1.pdf"]));
    expect(turn(model.requests[0]!).parts[0]).toEqual({ text: nativeFilesLine(["one.pdf"]) });
  });

  it("adds evidence of tool original after the inline evidence, and checkCitations still flags a line past the end", async () => {
    const { files, meta } = await withPictures();
    const model = fakeModel([says(`The chart is on page 2 (report.pdf L4). See also (report.pdf L${meta.lines + 5}).`)], { documents: PDF_ONLY });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: ask("Where is the chart?") });
    expect(result.evidence).toEqual([
      { tool: "inline", documentId: meta.id, document: "report.pdf", lines: [[1, meta.lines]], whole: true },
      { tool: "original", documentId: meta.id, document: "report.pdf", pages: [[1, 2]] },
    ]);
    expect(result.citations).toMatchObject({ checked: 2, supported: 1, unsupported: [{ document: "report.pdf", line: meta.lines + 5 }] });
    // The entry of the file alone shows no line.
    expect(checkCitations("(report.pdf L1)", [result.evidence[1]!], { [meta.id]: "report.pdf" })).toMatchObject({ checked: 1, supported: 0 });
  });

  it("counts the pages of the files in the request's estimate", async () => {
    const { files, meta, bytes } = await withPictures();
    const estimateOf = async (documents?: DocumentsCapability) => {
      const events: AskEvent[] = [];
      const model = fakeModel([says("Done.")], { pageTokens: 1_000, ...(documents ? { documents } : {}) });
      // No view_pages either way: only the file makes the difference.
      await askWithFiles({ files, model, documentIds: [meta.id], messages: ask("Is there a chart?"), viewPages: false, onEvent: (event) => events.push(event) });
      const start = events.find((event) => event.type === "request.start");
      return start?.type === "request.start" ? start.estimatedInputTokens! : Number.NaN;
    };
    const without = await estimateOf();
    const withFile = await estimateOf(PDF_ONLY);
    const line = Math.ceil(nativeFilesLine(["report.pdf"]).length / 4);
    expect(withFile - without).toBeGreaterThanOrEqual(2 * 1_000);
    expect(withFile - without).toBeLessThanOrEqual(2 * 1_000 + line + 40);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("goes on without a file whose original is gone, and fails with the store's error when the read fails", async () => {
    const store = new MemoryDocumentStore();
    const { files, meta } = await withPictures("report.pdf", store);
    (store as unknown as { originals: Map<string, Uint8Array> }).originals.delete(meta.id);
    const model = fakeModel([says("Done.")], { documents: PDF_ONLY });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: ask("Is there a chart?") });
    expect(result.answered).toBe(true);
    expect(turn(model.requests[0]!).files).toBeUndefined();
    expect(turn(model.requests[0]!).parts[0]!.text).toContain('--- Attached file');

    const failing = new MemoryDocumentStore();
    const broken = await withPictures("report.pdf", failing);
    failing.getOriginal = async () => {
      throw new Error("disk read failed");
    };
    const refused = askWithFiles({ files: broken.files, model: fakeModel([says("Done.")], { documents: PDF_ONLY }), documentIds: [broken.meta.id], messages: ask("Is there a chart?") });
    await expect(refused).rejects.toThrow(DocumentStoreError);
    await expect(refused).rejects.toMatchObject({ operation: "read", cause: { message: "disk read failed" } });
  });

  it("keeps the files in a request asked again with a note, and in the conversation of a model that only grows", async () => {
    // A table sent whole gives the question tools, so an empty first reply is asked for again.
    const { files, meta } = await withPictures();
    const table = await files.ingest({ name: "sales.csv", bytes: new TextEncoder().encode("region,total\nEast,10\nWest,12\n") });
    for (const appendOnly of [false, true]) {
      const model = fakeModel([says(""), says("A chart of sales.")], { documents: PDF_ONLY, appendOnly });
      const result = await askWithFiles({ files, model, documentIds: [meta.id, table.id], messages: ask("What does the chart show?") });
      expect(result.steps).toContain("The model's first reply was empty: it was asked again");
      expect(model.requests).toHaveLength(2);
      for (const request of model.requests) expect(turn(request).files?.map((file) => file.name)).toEqual(["attached-1.pdf"]);
      expect(turn(model.requests[1]!).parts.at(-1)!.text).not.toBe("What does the chart show?");
    }
  });

  it("keeps files the application put in messages, and counts them", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const photo = { name: "photo.png", mimeType: "image/png", bytes: new Uint8Array(30_000).fill(7) };
    const estimates: number[] = [];
    const run = async (withPhoto: boolean) => {
      const model = fakeModel([says("A cat.")]);
      const messages: ModelTextMessage[] = [{ role: "user", parts: [{ text: "What is in the photo?" }], ...(withPhoto ? { files: [photo] } : {}) }];
      await askWithFiles({ files, model, documentIds: [], messages, onEvent: (event) => (event.type === "request.start" ? estimates.push(event.estimatedInputTokens!) : undefined) });
      return model.requests[0]!;
    };
    const plain = await run(false);
    expect("files" in turn(plain)).toBe(false);
    const sent = await run(true);
    expect(turn(sent).files).toEqual([photo]);
    // 40,000 bytes of base64: about 157 tokens in the stand-in for media.
    expect(estimates[1]! - estimates[0]!).toBe(Math.ceil(40_000 / 256));
  });

  it("checks nativeDocuments", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const model = fakeModel([says("Done.")]);
    await expect(askWithFiles({ files, model, documentIds: [], messages: ask("Hi."), nativeDocuments: "yes" as unknown as boolean })).rejects.toThrow(new TypeError('nativeDocuments must be true or false, and is "yes".'));
    expect(model.requests).toHaveLength(0);
    const plain = await files.ingest({ name: "plain.pdf", bytes: numberedPdf(1) });
    await expect(askWithFiles({ files, model, documentIds: [plain.id], messages: ask("Hi."), nativeDocuments: true })).resolves.toMatchObject({ answered: true });
  });
});
