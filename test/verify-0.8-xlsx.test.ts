import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractText } from "../src/extract.js";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { excelDate, formatKind } from "../src/xlsx.js";

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A workbook of one sheet, "Data", with these shared strings and number formats (one cell style each, from 1). */
async function workbook(sheetData: string, options: { strings?: string[]; formats?: Array<number | string> } = {}): Promise<Uint8Array> {
  const custom = (options.formats ?? []).flatMap((format, index) => typeof format === "string" ? [`<numFmt numFmtId="${164 + index}" formatCode="${format}"/>`] : []);
  const styles = (options.formats ?? []).map((format, index) => `<xf numFmtId="${typeof format === "string" ? 164 + index : format}"/>`);
  return zip({
    "xl/workbook.xml": `<workbook ${S}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData>${sheetData}</sheetData></worksheet>`,
    ...(options.strings ? { "xl/sharedStrings.xml": `<sst ${S}>${options.strings.map((text) => `<si><t xml:space="preserve">${text}</t></si>`).join("")}</sst>` } : {}),
    ...(options.formats ? { "xl/styles.xml": `<styleSheet ${S}><numFmts>${custom.join("")}</numFmts><cellXfs><xf numFmtId="0"/>${styles.join("")}</cellXfs></styleSheet>` } : {}),
  });
}

const read = async (bytes: Uint8Array, maxTextBytes?: number) => extractText(bytes, { name: "w.xlsx", mimeType: "", format: "xlsx", maxTextBytes });
const rowsOf = (text: string) => text.split("\n").filter((line) => line.startsWith("Row "));

const timed = async <T>(work: () => Promise<T>): Promise<{ value: T | unknown; ms: number }> => {
  const started = performance.now();
  const value = await work().catch((error: unknown) => error);
  return { value, ms: performance.now() - started };
};

describe("a row that names one long shared string many times (#0, #46)", () => {
  it("is refused at the cell that passes the text limit, before the rest of the row is read", async () => {
    // After the cells, a tag far longer than any Office file writes: it is reached only if the row
    // is read past the limit. Each cell stands for 100,000 characters; the limit is 1,000,000.
    const cells = '<c t="s"><v>0</v></c>'.repeat(1_000);
    const bytes = await workbook(`<row r="1">${cells}<c r="${"A".repeat(70_000)}"/></row>`, { strings: [`${"x".repeat(100_000)} y`] });
    await expect(read(bytes, 1_000_000)).rejects.toThrow(/more text than is kept from one file/);
  });

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

  it("counts a shared string against the limit once per row that names it, and reads a row that fits", async () => {
    const strings = ["x".repeat(400)];
    const fits = await workbook('<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row>', { strings });
    expect(rowsOf((await read(fits, 2_000)).text)).toEqual([`Row 1: | ${strings[0]} | ${strings[0]} |`]);
    const over = await workbook(`<row>${'<c t="s"><v>0</v></c>'.repeat(6)}</row>`, { strings });
    await expect(read(over, 2_000)).rejects.toThrow(/more text than is kept/);
  });

  it("leaves out a row whose cells hold only white space", async () => {
    const bytes = await workbook('<row r="1"><c t="s"><v>0</v></c><c t="inlineStr"><is><t xml:space="preserve">  </t></is></c></row><row r="2"><c><v>1</v></c></row>', { strings: ["   "] });
    expect(rowsOf((await read(bytes)).text)).toEqual(["Row 2: | 1 |"]);
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

  it("counts each sheet's heading and its empty-sheet line against the text limit", async () => {
    const count = 300;
    const files: Record<string, string> = {
      "xl/workbook.xml": `<workbook ${S}><sheets>${Array.from({ length: count }, (_, index) => `<sheet name="Empty ${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}>${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`,
    };
    for (let index = 1; index <= count; index++) files[`xl/worksheets/sheet${index}.xml`] = `<worksheet ${S}><sheetData/></worksheet>`;
    const bytes = await zip(files);
    // 300 sheets of "## Sheet N: Empty N" and "[No values on this sheet]" are about 14,000 characters.
    await expect(read(bytes, 5_000)).rejects.toThrow(/more text than is kept/);
    const { text, pages } = await read(bytes, 20_000);
    expect(pages).toBe(count);
    expect(text.length).toBeLessThan(20_000);
  });
});

describe("elapsed times (#17)", () => {
  it("tells a format of elapsed hours, minutes or seconds from a time of day", () => {
    for (const code of ["[h]:mm:ss", "[h]:mm", "[hh]:mm", "[H]:MM:SS", "[mm]:ss", "[m]:ss", "[s]", "[ss].00", '[h]" h "mm" min"', "[Red][h]:mm", "[$-409][h]:mm:ss", "[Red][<0]-[h]:mm;[h]:mm"]) expect(formatKind(code), code).toBe("duration");
    expect(formatKind("h:mm:ss")).toBe("time");
    expect(formatKind("mm:ss")).toBe("time");
    expect(formatKind("[$-409]h:mm AM/PM")).toBe("time");
    expect(formatKind("[hhh")).toBe("time");
  });

  it("writes an elapsed time as hours in total, with no date", async () => {
    const values = [1.5, 2.25, 1.25, 150 / 86_400, 0.5, -1.5, 1.5 + 30 / 86_400, 0.999995, 100];
    const formats = ["[h]:mm:ss", 46, "[hh]:mm", "[mm]:ss", "[h]:mm", "[h]:mm", "[h]:mm:ss", "[h]:mm:ss", "[h]"];
    const cells = values.map((value, index) => `<c s="${index + 1}"><v>${value}</v></c>`).join("");
    const { text } = await read(await workbook(`<row r="1">${cells}</row>`, { formats }));
    expect(rowsOf(text)).toEqual(["Row 1: | 36:00 | 54:00 | 30:00 | 0:02:30 | 12:00 | -36:00 | 36:00:30 | 24:00 | 2400:00 |"]);
  });
});

describe("Excel's escapes of characters XML cannot hold (#25)", () => {
  it("decodes _xHHHH_ in shared and inline strings, cached text, formulas and sheet names", async () => {
    const strings = ["Line one_x000D_\nLine two", "Tab_x0009_separated", "literal _x005F_x0041_ text", "not one: _x00G1_ _X000D_ _x0041", "smile _xD83D__xDE00_ _x00e9_"];
    const cells = [
      ...strings.map((_, index) => `<c t="s"><v>${index}</v></c>`),
      '<c t="inlineStr"><is><t>inline_x000D_</t><t>_x000A_next</t></is></c>',
      '<c t="str"><f>A1&amp;"_x000D_"</f><v>cached_x000A_value</v></c>',
      '<c><f>"a_x000D_b"</f></c>',
    ].join("");
    const bytes = await zip({
      "xl/workbook.xml": `<workbook ${S}><sheets><sheet name="Q1_x0020_sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
      "xl/sharedStrings.xml": `<sst ${S}>${strings.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>`,
    });
    const { text } = await read(bytes);
    expect(text.split("\n")[0]).toBe("## Sheet 1: Q1 sales");
    expect(rowsOf(text)).toEqual(["Row 1: | Line one Line two | Tab separated | literal _x0041_ text | not one: _x00G1_ _X000D_ _x0041 | smile 😀 é | inline next | cached value | =\"a b\" |"]);
  });

  it("finds a word that ended at an escaped carriage return", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.xlsx", bytes: await workbook('<row r="1"><c t="s"><v>0</v></c></row>', { strings: ["Shipped_x000D_\nDelayed"] }) });
    const found = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "Shipped", mode: "exact", whole_word: true });
    expect(found.total_matching_lines).toBe(1);
  });
});

describe("sheets where Excel did not put them (#26)", () => {
  const sheet = (word: string) => `<worksheet ${S}><sheetData><row r="1"><c t="inlineStr"><is><t>${word}</t></is></c></row></sheetData></worksheet>`;

  it("reads every worksheet the relationships name, wherever its part is, and no other kind of sheet", async () => {
    const listed = [
      { name: "Abs", type: "worksheet", target: "/xl/worksheets/sheet1.xml", part: "xl/worksheets/sheet1.xml" },
      { name: "Outside", type: "worksheet", target: "../sheets/s2.xml", part: "sheets/s2.xml" },
      { name: "OddPath", type: "worksheet", target: "sheet3.xml", part: "xl/sheet3.xml" },
      { name: "Upper", type: "worksheet", target: "Worksheets/Sheet4.xml", part: "xl/Worksheets/Sheet4.xml" },
      { name: "Strict", type: "strict", target: "data/strict.xml", part: "xl/data/strict.xml" },
      { name: "Case", type: "worksheet", target: "worksheets/CASE.xml", part: "xl/worksheets/case.xml" },
      { name: "Chart", type: "chartsheet", target: "worksheets/chart1.xml", part: "xl/worksheets/chart1.xml" },
      { name: "Macro", type: "macro", target: "macrosheets/sheet1.xml", part: "xl/macrosheets/sheet1.xml" },
      { name: "Dialog", type: "dialogsheet", target: "worksheets/dialog1.xml", part: "xl/worksheets/dialog1.xml" },
      { name: "Untyped", type: "", target: "worksheets/untyped.xml", part: "xl/worksheets/untyped.xml" },
    ];
    const typeOf = (type: string) => type === "strict" ? "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet"
      : type === "macro" ? "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet"
        : type ? `${REL}/${type}` : "";
    const files: Record<string, string> = {
      "xl/workbook.xml": `<workbook ${S}><sheets>${listed.map((entry, index) => `<sheet name="${entry.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}>${listed.map((entry, index) => `<Relationship Id="rId${index + 1}" Type="${typeOf(entry.type)}" Target="${entry.target}"/>`).join("")}</Relationships>`,
    };
    for (const entry of listed) files[entry.part] = sheet(`${entry.name.toLowerCase()}word`);
    const { text, pages } = await read(await zip(files));
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## Sheet 1: Abs", "## Sheet 2: Outside", "## Sheet 3: OddPath", "## Sheet 4: Upper", "## Sheet 5: Strict", "## Sheet 6: Case", "## Sheet 7: Untyped"]);
    expect(pages).toBe(7);
    for (const word of ["outsideword", "oddpathword", "strictword", "caseword", "untypedword"]) expect(text).toContain(word);
    for (const word of ["chartword", "macroword", "dialogword"]) expect(text).not.toContain(word);
  });

  it("finds the shared strings and styles through the workbook's relationships", async () => {
    const bytes = await zip({
      "xl/workbook.xml": `<workbook ${S}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}><Relationship Id="rId1" Type="${REL}/worksheet" Target="data/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="data/strings.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="data/look.xml"/></Relationships>`,
      "xl/data/sheet1.xml": `<worksheet ${S}><sheetData><row r="1"><c t="s"><v>0</v></c><c s="1"><v>46336</v></c></row></sheetData></worksheet>`,
      "xl/data/strings.xml": `<sst ${S}><si><t>Region</t></si></sst>`,
      "xl/data/look.xml": `<styleSheet ${S}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    });
    expect(rowsOf((await read(bytes)).text)).toEqual(["Row 1: | Region | 2026-11-10 |"]);
  });
});

describe("a time cell that float arithmetic left just under zero (#49)", () => {
  it("is written as 00:00, not as a date in 1899", async () => {
    for (const serial of [-1.1102230246251565e-16, -1e-17, -2.78e-17, -1e-12, -0]) expect(excelDate(serial, "time"), String(serial)).toBe("00:00");
    expect(excelDate(-0.5, "time")).toBe("1899-12-30 12:00");
    expect(excelDate(0.999995, "time")).toBe("00:00");
    const { text } = await read(await workbook('<row r="1"><c s="1"><v>-1.1102230246251565E-16</v></c><c s="1"><v>0.25</v></c></row>', { formats: [21] }));
    expect(rowsOf(text)).toEqual(["Row 1: | 00:00 | 06:00 |"]);
  });
});

describe("follow-ups of the check of the XLSX fixes", () => {
  it("decodes _xHHHH_ escapes in one pass, and leaves what is not one", async () => {
    const { decodeEscapesForTest } = await import("../src/xlsx.js");
    expect(decodeEscapesForTest("a_x000D_b_x005F_x0041_c _x12_ _x00G0_ _x0041")).toBe("a\rb_x0041_c _x12_ _x00G0_ _x0041");
    const many = "_x0041_".repeat(500_000);
    const started = performance.now();
    expect(decodeEscapesForTest(many)).toBe("A".repeat(500_000));
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
