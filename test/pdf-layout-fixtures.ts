// Text items as pdf.js reports them, built by hand, for the tests of the page layout
// (test/pdf-layout.test.ts and test/timing/review-0.99.10-parsers.timing.test.ts).
import type { PdfTextItem } from "../src/pdf-layout.js";

/** One piece of text at (x, y) in PDF units (y grows upwards). Each character is half a font size wide. */
export function piece(text: string, x: number, y: number, size = 10): PdfTextItem {
  return { str: text, transform: [size, 0, 0, size, x, y], width: text.length * size * 0.5, height: size, hasEOL: false };
}

/** A line the way pdf.js emits it: an empty line-end marker, then the pieces with a space item between them. */
export function line(y: number, cells: Array<[x: number, text: string]>, size = 10): PdfTextItem[] {
  const items: PdfTextItem[] = [{ str: "", transform: [size, 0, 0, size, cells[0]![0], y], width: 0, height: 0, hasEOL: true }];
  cells.forEach(([x, text], index) => {
    if (index > 0) items.push({ str: " ", transform: [size, 0, 0, size, x - 1, y], width: 1, height: 0, hasEOL: false });
    items.push(piece(text, x, y, size));
  });
  return items;
}
