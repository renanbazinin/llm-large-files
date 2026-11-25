// Drawing pages as images holds the event loop one page at a time (0.99.9): a timer runs between two
// pages. Skipped unless unpdf 2 and @napi-rs/canvas are installed (Node 24 or later).
import "../load-pdf-libraries.js";
import * as unpdf from "unpdf";
import { describe, expect, it } from "vitest";
import { loadRenderBackend, renderPdfPages, type RenderBackend } from "../../src/pdf-images.js";
import { pdfWithPictures } from "../pdf-fixtures.js";

const CANVAS = "@napi-rs/canvas";
const hasCanvas = await import(CANVAS).then(() => true, () => false);
const RENDERER = typeof (unpdf as { inspectPages?: unknown }).inspectPages === "function" && hasCanvas;

describe.skipIf(!RENDERER)("drawing pages as images", () => {
  it("lets a timer run between pages", async () => {
    // The real backend, with the time each page starts and ends noted.
    const real = await loadRenderBackend();
    const spans: Array<{ start: number; end: number }> = [];
    const noting: RenderBackend = {
      async open(bytes) {
        const document = await real.open(bytes);
        return {
          pageCount: document.pageCount,
          pageSize: (page) => document.pageSize(page),
          async draw(page, options) {
            const start = performance.now();
            const bytes = await document.draw(page, options);
            spans.push({ start, end: performance.now() });
            return bytes;
          },
          close: () => document.close(),
        };
      },
    };
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(performance.now()), 1);
    try {
      const drawn = await renderPdfPages(pdfWithPictures(3), 1, 3, { format: "jpeg", longestSide: 1_024, maxBytes: 50_000_000 }, noting);
      expect(drawn.images).toHaveLength(3);
    } finally {
      clearInterval(timer);
    }
    expect(spans).toHaveLength(3);
    for (let page = 1; page < spans.length; page++) {
      const between = ticks.filter((tick) => tick >= spans[page - 1]!.end && tick <= spans[page]!.start);
      expect(between.length, `a timer between pages ${page} and ${page + 1}`).toBeGreaterThanOrEqual(1);
    }
  });
});
