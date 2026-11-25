// Pages drawn by the real renderer: unpdf 2 with @napi-rs/canvas (0.99.9). Skipped unless both are
// installed, which needs Node 24 or later: CI installs them in the rows "unpdf ^2 on Node 24/26".
import "./load-pdf-libraries.js";
import { PDFDocument } from "@cantoo/pdf-lib";
import { readFile } from "node:fs/promises";
import * as unpdf from "unpdf";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, PAGE_IMAGE_SIDE, type ModelToolRound } from "llm-large-files";
import { loadRenderBackend, renderPdfPages } from "../src/pdf-images.js";
import { numberedPdf, pdfWithPages, pdfWithPictures, textLine } from "./pdf-fixtures.js";
import { calls, fakeModel, says } from "./fake-model.js";

// Held in a variable: the package is not a dependency, and a literal import would not compile.
const CANVAS = "@napi-rs/canvas";
type Canvas = { loadImage(bytes: Uint8Array): Promise<{ width: number; height: number }>; createCanvas(width: number, height: number): { getContext(kind: "2d"): { drawImage(image: unknown, x: number, y: number): void; getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray } } } };
const canvas = await import(CANVAS).then((module: { default?: Canvas } & Canvas) => module, () => undefined) as Canvas | undefined;
const RENDERER = typeof (unpdf as { inspectPages?: unknown }).inspectPages === "function" && canvas !== undefined;

/** The width and height of a JPEG, from its first start-of-frame marker (baseline or progressive). */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) throw new Error("Not a JPEG marker.");
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker === 0xc0 || marker === 0xc2) return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    at += 2 + length;
  }
  throw new Error("No start-of-frame marker.");
}

/** The width and height of a PNG, from its IHDR chunk. */
const pngSize = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const options = (format: "png" | "jpeg", longestSide = PAGE_IMAGE_SIDE) => ({ format, longestSide, maxBytes: 20_000_000 });

describe.skipIf(!RENDERER)("pages drawn by unpdf 2 and @napi-rs/canvas", () => {
  it("draws a page of a real PDF as a JPEG of PAGE_IMAGE_SIDE on its longest side", async () => {
    const pdf = new Uint8Array(await readFile(new URL("./fixtures/pdf/word-pictures.pdf", import.meta.url)));
    const drawn = await renderPdfPages(pdf, 1, 1, options("jpeg"), await loadRenderBackend());
    const bytes = drawn.images[0]!.bytes;
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    const { width, height } = jpegSize(bytes);
    expect(Math.abs(Math.max(width, height) - PAGE_IMAGE_SIDE)).toBeLessThanOrEqual(1);
    expect(drawn).toMatchObject({ from: 1, to: 1, pageCount: 3 });
  });

  it("draws a PNG at the size asked", async () => {
    const drawn = await renderPdfPages(numberedPdf(2), 2, 2, options("png", 512), await loadRenderBackend());
    const bytes = drawn.images[0]!.bytes;
    expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const { width, height } = pngSize(bytes);
    expect(Math.abs(height - 512)).toBeLessThanOrEqual(1);
    expect(Math.abs(width - Math.round(512 * 612 / 792))).toBeLessThanOrEqual(1);
  });

  it("draws text in a standard font the file does not embed", async () => {
    // Ten lines in Helvetica, which the file does not embed, and a blank page.
    const lines = Array.from({ length: 10 }, (_, index) => textLine("The quick brown fox jumps over the lazy dog.", 720 - index * 20)).join("\n");
    const drawn = await renderPdfPages(pdfWithPages([lines, "q Q"]), 1, 2, options("png"), await loadRenderBackend());
    const darkPixels = async (bytes: Uint8Array) => {
      const image = await canvas!.loadImage(bytes);
      const surface = canvas!.createCanvas(image.width, image.height);
      const context = surface.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let dark = 0;
      for (let at = 0; at < pixels.length; at += 4) if (pixels[at]! < 128 && pixels[at + 3]! > 0) dark++;
      return dark;
    };
    expect(await darkPixels(drawn.images[0]!.bytes)).toBeGreaterThan(1_000);
    expect(await darkPixels(drawn.images[1]!.bytes)).toBe(0);
  });

  it("draws a page of pictures", async () => {
    const drawn = await renderPdfPages(pdfWithPictures(2), 1, 2, options("jpeg", 1_024), await loadRenderBackend());
    expect(drawn.images.map((image) => image.page)).toEqual([1, 2]);
    // The picture is noise: it does not compress, so the image is much larger than a page of text.
    expect(drawn.images[1]!.bytes.length).toBeGreaterThan(20_000);
  });

  it("refuses a PDF that needs a password with the cut's message", async () => {
    const plain = await PDFDocument.load(numberedPdf(2), { updateMetadata: false });
    plain.encrypt({ ownerPassword: "owner-secret", userPassword: "open-me" });
    await expect(renderPdfPages(await plain.save(), 1, 1, options("jpeg"), await loadRenderBackend())).rejects.toThrow("This PDF needs a password to open, so its pages cannot be shown.");
  });

  it("goes end to end through askWithFiles with a model that takes images", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "album.pdf", bytes: pdfWithPictures(3) });
    const model = fakeModel([calls([{ id: "c1", name: "view_pages", args: { document_id: meta.id, from_page: 1, to_page: 2 } }]), says("Two pictures.")], { toolFileTypes: ["image/png", "image/jpeg"] });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "What do pages 1 and 2 show?" }] });
    const answer = (model.requests[1]!.messages.at(-1) as ModelToolRound).answers[0]!;
    expect(answer.result).toMatchObject({ document: "album.pdf", pages: "1-2", total_pages: 3, images: ["page-1.jpg", "page-2.jpg"] });
    expect(answer.files?.map((file) => [file.mimeType, file.bytes[0], file.bytes[1]])).toEqual([["image/jpeg", 0xff, 0xd8], ["image/jpeg", 0xff, 0xd8]]);
    expect(result).toMatchObject({ answered: true, text: "Two pictures." });
  });
});
