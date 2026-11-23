// The tests of the XLSX reader that hold work to the clock: workbooks built to make it read or
// write far more than they hold, read in bounded time (from test/verify-0.8-xlsx.test.ts).
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "../../src/index.js";
import { read, REL, RELS, rowsOf, S, workbook, zip } from "../xlsx-fixtures.js";

/** How long `work` took, and what it gave or threw. */
const timed = async <T>(work: () => Promise<T>): Promise<{ value: T | unknown; ms: number }> => {
  const started = performance.now();
  const value = await work().catch((error: unknown) => error);
  return { value, ms: performance.now() - started };
};

describe("a row that names one long shared string many times (#0, #46)", () => {
  it("refuses a 3 KB workbook that names a string of 1,000,000 characters 3,000 times, without running out of memory", async () => {
    const cells = '<c t="s"><v>0</v></c>'.repeat(3_000);
    const bytes = await workbook(`<row>${cells}</row>`, { strings: [`${"a".repeat(1_000_000)} b`] });
    expect(bytes.byteLength).toBeLessThan(5_000);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const { value, ms } = await timed(() => files.ingest({ name: "fanout.xlsx", bytes }));
    expect((value as Error).message).toMatch(/more text than is (kept|read) from one file/);
    expect(ms).toBeLessThan(3_000);
  });

  it("makes a shared string a cell's text once, not at every cell that names it", async () => {
    // A string of 500,000 tabs: making it one line took about 100 ms, at each of the cells.
    const cells = '<c t="s"><v>0</v></c>'.repeat(100);
    const bytes = await workbook(`<row>${cells}</row>`, { strings: ["a\t".repeat(500_000)] });
    const { value, ms } = await timed(() => read(bytes));
    expect((value as Error).message).toMatch(/more text than is read from one file/);
    expect(ms).toBeLessThan(3_000);
    const small = await workbook('<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>', { strings: ["  two\t\tspaced | piped  ", "a|b"] });
    expect(rowsOf((await read(small)).text)).toEqual(["Row 1: | two spaced \\| piped | two spaced \\| piped | a\\|b |"]);
  });
});

describe("a workbook that lists sheets many times (#5)", () => {
  it("reads a sheet part listed 50,000 times once", async () => {
    const bytes = await zip({
      "xl/workbook.xml": `<workbook ${S}><sheets>${'<sheet r:id="rId1"/>'.repeat(50_000)}<sheet name="Other" r:id="rId2"/><sheet name="Again" r:id="rId3"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData/></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet ${S}><sheetData><row r="1"><c><v>7</v></c></row></sheetData></worksheet>`,
    });
    const { value, ms } = await timed(() => read(bytes));
    expect(ms).toBeLessThan(5_000);
    const { text, pages } = value as { text: string; pages: number };
    expect(pages).toBe(2);
    expect(text).toBe("## Sheet 1: Sheet 1\n[No values on this sheet]\n\n## Sheet 2: Other\nColumns: | A |\nRow 1: | 7 |");
  });
});

describe("follow-ups of the check of the XLSX fixes", () => {
  it("decodes _xHHHH_ escapes in one pass, and leaves what is not one", async () => {
    const { decodeEscapesForTest } = await import("../../src/xlsx.js");
    expect(decodeEscapesForTest("a_x000D_b_x005F_x0041_c _x12_ _x00G0_ _x0041")).toBe("a\rb_x0041_c _x12_ _x00G0_ _x0041");
    const many = "_x0041_".repeat(500_000);
    const started = performance.now();
    expect(decodeEscapesForTest(many)).toBe("A".repeat(500_000));
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
