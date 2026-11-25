// The search for tables on a PDF page of thousands of lines (review of 0.99.9). Lines that held
// together and were not a table were searched again from each of them, and each line was tried on
// a copy of every cell before it: 2,000 lines of a label and a number held the server for 26 s,
// and a real table of 2,000 rows for 1 s. Each test holds that work to the clock; what the reader
// writes for such pages is checked here too, with the times.
import { describe, expect, it } from "vitest";
import { layoutPageText, plainPageText, type PdfTextItem } from "../../src/pdf-layout.js";
import { line } from "../pdf-layout-fixtures.js";
import { timed } from "./clock.js";

/** `count` lines of a label and a number, from `top` down: two columns, which is not a table. */
const labelled = (count: number, top: number): PdfTextItem[] => Array.from({ length: count }, (_, index) => line(top - index * 12, [[72, `Item ${index + 1}`], [300, String(index * 7)]])).flat();
/** `count` rows of `columns` cells, from `top` down. */
const table = (count: number, columns: number, top: number): PdfTextItem[] =>
  Array.from({ length: count }, (_, row) => line(top - row * 12, Array.from({ length: columns }, (_, column) => [72 + column * 60, `${(row * 7 + column) % 1000}`] as [number, string]))).flat();
const tableRows = (text: string) => text.split("\n").filter((row) => row.startsWith("|"));

describe("the search for tables on a page of thousands of lines (review 0.99.10)", () => {
  it("leaves 4,000 lines of a label and a number as they are, in a fraction of a second", async () => {
    // About 0.2 s on an idle machine. 0.99.9 took 26 s for 2,000 such lines, and minutes for 4,000.
    const items = labelled(4_000, 100_000);
    const { value, ms } = await timed(() => layoutPageText(items));
    expect(value).toBe(plainPageText(items));
    expect(ms).toBeLessThan(5_000);
  });

  it("still writes the table that follows 2,000 such lines", async () => {
    // The table starts 4.5 lines under the list: far enough not to be rows of the same lines.
    const rows = table(6, 4, 100_000 - 2_000 * 12 - 45);
    const items = [...labelled(2_000, 100_000), ...rows];
    const { value, ms } = await timed(() => layoutPageText(items));
    expect(tableRows(value)).toEqual(tableRows(layoutPageText(rows)));
    expect(tableRows(value)).toHaveLength(6);
    expect(value.startsWith(plainPageText(labelled(2_000, 100_000)))).toBe(true);
    expect(ms).toBeLessThan(5_000);
  });

  it("writes a table of 8,000 rows in a fraction of a second", async () => {
    // About 0.2 s on an idle machine. In 0.99.9 the time grew with the square of the rows: 1 s for 2,000.
    const items = table(8_000, 3, 200_000);
    const { value, ms } = await timed(() => layoutPageText(items));
    expect(tableRows(value)).toHaveLength(8_000);
    expect(tableRows(value)[7_999]).toBe("| 993 | 994 | 995 |");
    expect(ms).toBeLessThan(5_000);
  });

  it("gives up on a page of 300 lines of 200 columns, and keeps its text", async () => {
    // 60,000 cells, each held against 200 columns for every line: past what a page may take.
    // About 0.3 s on an idle machine.
    const items = table(300, 200, 100_000);
    const { value, ms } = await timed(() => layoutPageText(items));
    expect(value).toBe(plainPageText(items));
    expect(ms).toBeLessThan(8_000);
  });
});
