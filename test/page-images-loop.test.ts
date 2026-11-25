// The loop picks the kind of page every model takes (0.99.9): one small PDF; else a JPEG of each
// page, else a PNG; else no view_pages. The renderer is a fake: this file replaces the loader of
// src/pdf-images.ts, so no unpdf 2 or canvas is needed.
import "./load-pdf-libraries.js";
import { describe, expect, it, vi } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type ModelRequest, type ModelToolRound, type ToolFileType } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";
import { fakeFetch } from "llm-large-files/testing";
import type { RenderBackend } from "../src/pdf-images.js";
import { numberedPdf, pdfWithPictures } from "./pdf-fixtures.js";
import { calls, fakeModel, says } from "./fake-model.js";

type Json = Record<string, any>;

/** What the fake renderer draws: the bytes of each image, and the formats it was asked for. */
const drawing = vi.hoisted(() => ({ imageBytes: 2_000, formats: [] as string[] }));

vi.mock("../src/pdf-images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pdf-images.js")>();
  // The pages of the test PDFs, counted from their page objects.
  const backend: RenderBackend = {
    async open(bytes) {
      const pageCount = Buffer.from(bytes).toString("latin1").match(/\/Type \/Page /g)?.length ?? 0;
      return {
        pageCount,
        pageSize: async () => ({ width: 612, height: 792 }),
        async draw(page, { format }) {
          drawing.formats.push(format);
          return new Uint8Array(drawing.imageBytes).fill(page % 251);
        },
        close: async () => undefined,
      };
    },
  };
  return { ...actual, loadRenderBackend: async () => backend };
});

/** A library of one user that keeps PDFs, and a PDF of `pages` pages with a picture on each. */
async function album(pages = 6, budget: Record<string, number> = {}) {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget });
  const meta = await files.ingest({ name: "album.pdf", bytes: pdfWithPictures(pages) });
  return { files, meta };
}

const toolNames = (request: ModelRequest) => request.tools?.map((tool) => tool.name) ?? [];
const lastRound = (request: ModelRequest) => request.messages.at(-1) as ModelToolRound;
const look = (id: string, from: number, to = from) => ({ id: `c${from}`, name: "view_pages", args: { document_id: id, from_page: from, to_page: to } });

describe("the kind of page a question shows", () => {
  it("offers view_pages as images to a model that takes images and no PDF", async () => {
    const { files, meta } = await album();
    drawing.formats = [];
    const model = fakeModel([calls([look(meta.id, 2, 3)]), says("Two charts.")], { toolFileTypes: ["image/png", "image/jpeg"] });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "What do pages 2 and 3 show?" }] });
    expect(toolNames(model.requests[0]!)).toEqual(["view_pages"]);
    const answer = lastRound(model.requests[1]!).answers[0]!;
    expect(answer.result).toEqual({ document: "album.pdf", pages: "2-3", total_pages: 6, images: ["page-2.jpg", "page-3.jpg"], tool_turns_left: 10 });
    expect(answer.files?.map((file) => [file.name, file.mimeType])).toEqual([["page-2.jpg", "image/jpeg"], ["page-3.jpg", "image/jpeg"]]);
    expect(drawing.formats).toEqual(["jpeg", "jpeg"]);
    expect(result.evidence.at(-1)).toMatchObject({ tool: "view_pages", pages: [[2, 3]] });
    expect(result.steps).toEqual(["Look at album.pdf pages 2-3"]);
  });

  it("sends a PDF when every model takes one, though they take images too", async () => {
    const { files, meta } = await album();
    const model = fakeModel([calls([look(meta.id, 2)]), says("A chart.")], { toolFileTypes: ["image/jpeg", "application/pdf"] });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "What does page 2 show?" }] });
    expect(lastRound(model.requests[1]!).answers[0]!.files?.map((file) => file.mimeType)).toEqual(["application/pdf"]);
  });

  it("draws a PNG when every model takes PNG and not all take JPEG", async () => {
    const { files, meta } = await album();
    drawing.formats = [];
    const model = fakeModel([says("DONE")], { toolFileTypes: ["image/png", "image/jpeg"] });
    const explorer = fakeModel([calls([look(meta.id, 1)]), says("DONE")], { id: "explorer", toolFileTypes: ["image/png"] });
    await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: [{ role: "user", text: "What does page 1 show?" }] });
    expect(lastRound(explorer.requests[1]!).answers[0]!.files?.map((file) => [file.name, file.mimeType])).toEqual([["page-1.png", "image/png"]]);
    expect(drawing.formats).toEqual(["png"]);
  });

  it("offers no view_pages when the models share no kind of file", async () => {
    const { files, meta } = await album();
    const run = async (modelTypes: ToolFileType[] | "none", explorerTypes: ToolFileType[] | "none") => {
      const capabilities = (types: ToolFileType[] | "none") => (types === "none" ? { toolFiles: "none" as const } : { toolFileTypes: types });
      const model = fakeModel([says("Answer.")], capabilities(modelTypes));
      const explorer = fakeModel([says("DONE")], { id: "explorer", ...capabilities(explorerTypes) });
      await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: [{ role: "user", text: "What is on page 1?" }] });
      return [...model.requests, ...explorer.requests];
    };
    const apart = await run(["image/png"], ["image/jpeg", "application/pdf"]);
    expect(apart.flatMap(toolNames)).toEqual([]);
    expect(apart[0]!.system).not.toContain("view_pages");
    expect(JSON.stringify(apart)).toBe(JSON.stringify(await run("none", "none")));
    // An empty list takes nothing, and toolFiles "none" ignores the list.
    expect((await run([], [])).flatMap(toolNames)).toEqual([]);
    const none = fakeModel([says("Answer.")], { toolFiles: "none", toolFileTypes: ["image/jpeg"] });
    await askWithFiles({ files, model: none, documentIds: [meta.id], messages: [{ role: "user", text: "?" }] });
    expect(toolNames(none.requests[0]!)).toEqual([]);
  });

  it("counts each image as a page against the pages a question may show", async () => {
    // reservedTokens 16,384: half of it is for pages, which is 2 pages of 4,000 tokens.
    const { files, meta } = await album(6, { reservedTokens: 16_384 });
    const model = fakeModel([calls([look(meta.id, 1, 2)]), calls([look(meta.id, 3)]), says("Seen.")], { toolFileTypes: ["image/jpeg"], pageTokens: 4_000 });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "Describe the pages." }] });
    expect(lastRound(model.requests[1]!).answers[0]!.result).toMatchObject({ pages: "1-2", images: ["page-1.jpg", "page-2.jpg"] });
    expect(lastRound(model.requests[2]!).answers[0]!.result).toMatchObject({ error: "No more pages can be looked at for this question. Answer from the pages and the text you already have." });
  });

  it("keeps every request under the byte limit with images", async () => {
    // Twelve pages of 100,000 bytes each, as images sent as base64, and a server that takes 900,000 bytes.
    const limit = 900_000;
    drawing.imageBytes = 100_000;
    try {
      const { files, meta } = await album(12, { maxRequestBytes: limit });
      const sizes: number[] = [];
      const server = fakeFetch([(sent) => {
        sizes.push(Buffer.byteLength(JSON.stringify(sent.body)));
        const messages = sent.body.messages as Json[];
        const tool = [...messages].reverse().find((message) => message.role === "tool");
        const last = tool ? JSON.parse(tool.content as string) as Json : undefined;
        if (last?.error || messages.at(-1)?.content === undefined) return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "That is all I could look at." } }] });
        const call = { id: `call_${sizes.length}`, type: "function", function: { name: "view_pages", arguments: JSON.stringify({ document_id: meta.id, from_page: last?.next_page ?? 1, to_page: 12 }) } };
        return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [call] } }] });
      }]);
      const model = openAiCompatible({ model: "qwen3-vl", imageInput: true, fetch: server.fetch });
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "Describe every picture." }] });
      expect(sizes.length).toBeGreaterThanOrEqual(3);
      for (const size of sizes) expect(size).toBeLessThanOrEqual(limit);
      // The images are in the requests: the second is large, and still fits.
      expect(sizes[1]).toBeGreaterThan(250_000);
      expect(result.steps[0]).toMatch(/^Look at album\.pdf pages 1-12 — got pages 1-\d$/);
      expect(result.text).toBe("That is all I could look at.");
    } finally {
      drawing.imageBytes = 2_000;
    }
  });

  it("changes nothing for a model that does not say what it takes", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(2) });
    const model = fakeModel([calls([look(meta.id, 1)]), says("Text only.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "Page 1?" }] });
    expect(lastRound(model.requests[1]!).answers[0]!.result).toMatchObject({ file: "pages-1.pdf" });
  });
});
