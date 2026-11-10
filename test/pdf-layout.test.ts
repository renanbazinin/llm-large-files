import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPdfExtractor, extractText } from "../src/extract.js";
import { layoutPageText, plainPageText, type PdfTextItem } from "../src/pdf-layout.js";

// ---------- Text items as pdf.js reports them, built by hand ----------

/** One piece of text at (x, y) in PDF units (y grows upwards). Each character is half a font size wide. */
function piece(text: string, x: number, y: number, size = 10): PdfTextItem {
  return { str: text, transform: [size, 0, 0, size, x, y], width: text.length * size * 0.5, height: size, hasEOL: false };
}

/** A line the way pdf.js emits it: an empty line-end marker, then the pieces with a space item between them. */
function line(y: number, cells: Array<[x: number, text: string]>, size = 10): PdfTextItem[] {
  const items: PdfTextItem[] = [{ str: "", transform: [size, 0, 0, size, cells[0]![0], y], width: 0, height: 0, hasEOL: true }];
  cells.forEach(([x, text], index) => {
    if (index > 0) items.push({ str: " ", transform: [size, 0, 0, size, x - 1, y], width: 1, height: 0, hasEOL: false });
    items.push(piece(text, x, y, size));
  });
  return items;
}

/** Rows of a table: `columns` are the left edges, an empty string leaves the cell out. */
function rows(top: number, step: number, columns: number[], values: string[][]): PdfTextItem[] {
  return values.flatMap((row, index) => line(top - index * step, row.flatMap((text, column) => (text ? [[columns[column]!, text] as [number, string]] : []))));
}

const SENTENCE = "The committee reviewed the quarterly figures and found steady growth.";
const tableRows = (text: string) => text.split("\n").filter((row) => row.startsWith("|"));

describe("layoutPageText", () => {
  it("keeps an empty cell empty", () => {
    const items = [
      ...line(760, [[72, "Revenue by region"]]),
      ...rows(730, 20, [72, 200, 260, 320], [["Region", "Q1", "Q2", "Q3"], ["North", "120", "135", "150"], ["EMEA", "80", "", "95"], ["Asia", "", "70", "85"]]),
      ...line(640, [[72, SENTENCE]]),
    ];
    const text = layoutPageText(items);
    expect(tableRows(text)).toEqual(["| Region | Q1 | Q2 | Q3 |", "| North | 120 | 135 | 150 |", "| EMEA | 80 |  | 95 |", "| Asia |  | 70 | 85 |"]);
    // Read in file order, the same rows lose the empty cells: this is what the rows above fix.
    expect(plainPageText(items)).toContain("EMEA 80 95");
    expect(text).toContain("Revenue by region\n| Region");
    expect(text).toContain(`| Asia |  | 70 | 85 |\n${SENTENCE}`);
  });

  it("leaves running text exactly as pdf.js gives it", () => {
    const items = [760, 746, 732, 718, 704].flatMap((y) => line(y, [[72, SENTENCE]]));
    expect(layoutPageText(items)).toBe(plainPageText(items));
  });

  it("leaves two columns alone: lists, key and value, a table of contents", () => {
    const items = rows(760, 14, [72, 96], [["1.", "Download the installer."], ["2.", "Close the application."], ["3.", "Restart the computer."], ["4.", "Sign in again."]]);
    expect(layoutPageText(items)).toBe(plainPageText(items));
  });

  it("does not turn justified text into a table, even where the gaps between words are wide", () => {
    // Four lines flush left and right, with words 12 to 20 units apart at positions that do not line up.
    const items = [
      ...line(760, [[72, "Costs"], [118, "rose"], [160, "more"], [203, "slowly"], [258, "than"]]),
      ...line(746, [[72, "revenue,"], [131, "which"], [178, "improved"], [243, "the"], [263, "third"]]),
      ...line(732, [[72, "operating"], [137, "margin"], [189, "for"], [222, "every"], [268, "site"]]),
      ...line(718, [[72, "quarter"], [125, "in"], [151, "a"], [172, "row,"], [211, "although"], [273, "not"]]),
    ];
    expect(layoutPageText(items)).toBe(plainPageText(items));
  });

  it("does not pull the text of the next page column into a table", () => {
    const table = rows(700, 20, [72, 130, 190], [["Year", "Units", "Share"], ["2023", "1,204", "11%"], ["2024", "1,530", ""], ["2025", "1,911", "17%"]]);
    // File order: the whole left column, then the right column from the top of the page.
    const right = [760, 746, 732, 718, 704, 690, 676, 662, 648, 634].map((y) => line(y, [[320, "Customer satisfaction scores stayed flat this year."]])).flat();
    const text = layoutPageText([...line(760, [[72, SENTENCE.slice(0, 40)]]), ...table, ...right]);
    expect(tableRows(text)).toEqual(["| Year | Units | Share |", "| 2023 | 1,204 | 11% |", "| 2024 | 1,530 |  |", "| 2025 | 1,911 | 17% |"]);
    expect(text.split("\n").filter((row) => row === "Customer satisfaction scores stayed flat this year.")).toHaveLength(10);
  });

  it("joins the lines of a wrapped cell when the rows are spaced apart", () => {
    const items = [
      ...line(700, [[72, "ID"], [110, "Requirement"], [330, "Priority"], [400, "Owner"]]),
      ...line(670, [[72, "R-1"], [110, "The system exports every report as a PDF"], [330, "High"], [400, "Dana"]]),
      ...line(658, [[110, "file and as a CSV file."]]),
      ...line(628, [[72, "R-2"], [110, "Users can reset their own password."], [400, "Omar"]]),
      ...line(598, [[72, "R-3"], [110, "All changes are written to an audit log"], [330, "Low"]]),
      ...line(586, [[110, "that is kept for seven years."]]),
    ];
    expect(tableRows(layoutPageText(items))).toEqual([
      "| ID | Requirement | Priority | Owner |",
      "| R-1 | The system exports every report as a PDF file and as a CSV file. | High | Dana |",
      "| R-2 | Users can reset their own password. |  | Omar |",
      "| R-3 | All changes are written to an audit log that is kept for seven years. | Low |  |",
    ]);
  });

  it("keeps close lines apart when each of them has a number in the same column", () => {
    // Two groups of rows with a wider step between the groups: every line is a row of its own.
    const items = rows(700, 12, [72, 200, 260], [["Region", "Q1", "Q2"], ["North", "120", "135"], ["South", "80", "95"]])
      .concat(rows(640, 12, [72, 200, 260], [["East", "60", "70"], ["West", "30", "32"], ["Total", "290", "332"]]));
    expect(tableRows(layoutPageText(items))).toHaveLength(6);
  });

  it("writes a right-to-left table from right to left, and puts the pieces of a cell in reading order", () => {
    // The first column is the rightmost one. Chrome emits "1" before "רבעון" inside the heading cell.
    const items = [
      ...line(700, [[500, "אזור"], [430, "1"], [438, "רבעון"], [360, "2"], [368, "רבעון"], [290, "3"], [298, "רבעון"]]),
      ...line(680, [[500, "צפון"], [430, "120"], [360, "135"], [290, "150"]]),
      ...line(660, [[500, "מרכז"], [430, "80"], [290, "95"]]),
      ...line(640, [[500, "דרום"], [360, "70"], [290, "85"]]),
    ];
    expect(tableRows(layoutPageText(items))).toEqual(["| אזור | רבעון 1 | רבעון 2 | רבעון 3 |", "| צפון | 120 | 135 | 150 |", "| מרכז | 80 |  | 95 |", "| דרום |  | 70 | 85 |"]);
  });

  it("reads a table that is printed sideways", () => {
    // Text running up the page: rows go left to right, cells from the bottom of the page upwards.
    const sideways = (text: string, x: number, y: number): PdfTextItem => ({ str: text, transform: [0, 10, -10, 0, x, y], width: text.length * 5, height: 10, hasEOL: false });
    const grid = [["Month", "Orders", "Returns"], ["January", "410", "12"], ["February", "388", ""], ["March", "455", "19"]];
    const items = grid.flatMap((row, rowIndex) => row.flatMap((text, column) => (text ? [sideways(text, 100 + rowIndex * 20, 200 + column * 80)] : [])));
    expect(tableRows(layoutPageText(items))).toEqual(["| Month | Orders | Returns |", "| January | 410 | 12 |", "| February | 388 |  |", "| March | 455 | 19 |"]);
  });

  it("applies the rotation of the page", () => {
    const upright = rows(700, 20, [72, 200, 260], [["Region", "Q1", "Q2"], ["North", "120", "135"], ["EMEA", "", "95"]]);
    // The same page turned a quarter: (x, y) -> (y, 800 - x), with the text running upwards, and a
    // viewport matrix that turns it back.
    const turned = upright.map((item) => ({ ...item, transform: [0, 10, -10, 0, 800 - item.transform[5]!, item.transform[4]!] }));
    expect(tableRows(layoutPageText(turned, [0, -1, -1, 0, 800, 800]))).toEqual(tableRows(layoutPageText(upright)));
    expect(tableRows(layoutPageText(turned, [0, -1, -1, 0, 800, 800]))).toContain("| EMEA |  | 95 |");
  });

  it("writes a heading that spans two columns in the first of them", () => {
    const body = [
      ...line(700, [[72, "Product"], [200, "H1"], [260, "H2"], [320, "H1"], [380, "H2"]]),
      ...rows(680, 20, [72, 200, 260, 320, 380], [["Sensors", "14", "18", "21", ""], ["Gateways", "6", "", "9", "11"], ["Licences", "40", "44", "", "52"]]),
    ];
    const bodyRows = ["| Product | H1 | H2 | H1 | H2 |", "| Sensors | 14 | 18 | 21 |  |", "| Gateways | 6 |  | 9 | 11 |", "| Licences | 40 | 44 |  | 52 |"];
    // A heading wide enough to lie over both columns it spans is a row of the table.
    const wide = layoutPageText([...line(720, [[205, "Year 2025 total"], [325, "Year 2026 total"]]), ...body]);
    expect(tableRows(wide)).toEqual(["|  | Year 2025 total |  | Year 2026 total |  |", ...bodyRows]);
    // A short one that sits between them is left as a line above the table.
    const short = layoutPageText([...line(720, [[226, "2025"], [346, "2026"]]), ...body]);
    expect(tableRows(short)).toEqual(bodyRows);
    expect(short).toContain("2025 2026\n| Product | H1 | H2 | H1 | H2 |");
  });

  it("does not take a caption above a table for one of its rows", () => {
    const items = [...line(720, [[72, "Table 1: Revenue by region (USD millions)"]]), ...rows(700, 20, [72, 200, 260], [["Region", "Q1", "Q2"], ["North", "120", "135"], ["EMEA", "", "95"]])];
    expect(layoutPageText(items).trim().split("\n")[0]).toBe("Table 1: Revenue by region (USD millions)");
  });

  it("separates two tables that sit under each other on different columns", () => {
    const invoice = rows(690, 16, [72, 330, 380, 460], [["Item", "Qty", "Price", "Amount"], ["Seed drill service", "2", "340.00", "680.00"], ["Call-out fee", "1", "", "60.00"], ["Discount", "", "", "-40.00"]]);
    // The values of the block above start between the columns of the table (200), or inside its first column (150).
    for (const valueColumn of [200, 150]) {
      const details = rows(760, 16, [72, valueColumn], [["Invoice number", "INV-20931"], ["Customer", "Brightwater Farms"], ["Purchase order", ""], ["Currency", "EUR"]]);
      const text = layoutPageText([...details, ...invoice]);
      expect(tableRows(text)).toEqual(["| Item | Qty | Price | Amount |", "| Seed drill service | 2 | 340.00 | 680.00 |", "| Call-out fee | 1 |  | 60.00 |", "| Discount |  |  | -40.00 |"]);
      expect(text).toContain("Invoice number INV-20931\nCustomer Brightwater Farms\nPurchase order\nCurrency EUR\n| Item");
    }
  });

  it("splits two cells that sit a word space apart when other rows show two columns there", () => {
    // "Anchor bolts" ends 2 units before "1,200" starts: closer than a space, so they read as one piece.
    const items = [
      ...line(700, [[72, "Product"], [134, "Units"], [200, "Price"], [260, "Amount"]]),
      ...line(680, [[72, "Anchor bolts"], [134, "1,200"], [200, "0.85"], [260, "1,020"]]),
      ...line(660, [[72, "Wall plugs"], [200, "0.12"]]),
      ...line(640, [[72, "Hex nuts"], [134, "8,000"], [200, "0.04"], [260, "320"]]),
    ];
    expect(tableRows(layoutPageText(items))).toEqual(["| Product | Units | Price | Amount |", "| Anchor bolts | 1,200 | 0.85 | 1,020 |", "| Wall plugs |  | 0.12 |  |", "| Hex nuts | 8,000 | 0.04 | 320 |"]);
  });

  it("keeps a footnote mark with its number", () => {
    const items = [
      ...rows(700, 20, [72, 200, 260], [["Drug", "Dose", "Responders"], ["Placebo", "0", "12"], ["Arm A", "50", "31"], ["Arm B", "100", ""]]),
      { ...piece("a", 270.5, 685, 6), hasEOL: false },
    ];
    expect(tableRows(layoutPageText(items))).toContain("| Placebo | 0 | 12a |");
  });

  it("escapes a bar inside a cell", () => {
    const items = rows(700, 20, [72, 200, 260], [["Flag", "Short", "Meaning"], ["--all|-a", "-a", "everything"], ["--none", "", "nothing"]]);
    expect(layoutPageText(items)).toContain("| --all\\|-a | -a | everything |");
  });

  it("adds the space pdf.js leaves out between right-to-left pieces", () => {
    // Word emits the pieces of a Hebrew line from right to left, with nothing between them.
    const items = [piece("יתרת סגירה", 400, 700), piece("4,167.90", 355, 700), { ...piece("ש\"ח.", 330, 700), hasEOL: true }];
    expect(plainPageText(items)).toBe("יתרת סגירה4,167.90ש\"ח.\n");
    expect(layoutPageText(items)).toBe("יתרת סגירה 4,167.90 ש\"ח.\n");
  });

  it("survives items it cannot place", () => {
    const odd = [{ str: "x", transform: [] as number[], width: 0, height: 0 }, { str: "y", transform: [Number.NaN, 0, 0, 1, 0, 0], width: 1, height: 1 }];
    expect(layoutPageText(odd)).toBe("xy");
    expect(layoutPageText([])).toBe("");
  });
});

// ---------- Real files: the same pages printed to PDF by Chrome and by Word ----------

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/pdf/${name}.pdf`, import.meta.url)));
const read = async (name: string) => (await extractText(fixture(name), { name: `${name}.pdf`, mimeType: "application/pdf", format: "pdf" })).text;

describe("PDF tables in real files", () => {
  it("keeps empty cells in a bordered table (Word)", async () => {
    const text = await read("word-simple");
    expect(tableRows(text)).toEqual([
      "| Region | Q1 | Q2 | Q3 | Q4 |",
      "| North America | 120 | 135 | 150 | 161 |",
      "| EMEA | 80 |  | 95 | 101 |",
      "| Asia Pacific | 60 | 70 |  | 92 |",
      "| Latin America |  | 32 | 41 | 44 |",
      "| Total | 260 | 237 | 286 | 398 |",
    ]);
    expect(text).toContain("Table 1: Revenue by region (USD millions)\n| Region");
    expect(text).toMatch(/^--- Page 1 ---\nRevenue report\n/);
  });

  it("gives the 0.1.0 text when tables are turned off", async () => {
    const plain = (await createPdfExtractor({ tables: false })(fixture("word-simple"), { name: "a.pdf", mimeType: "application/pdf", format: "pdf" })).text;
    expect(plain).not.toContain("|");
    expect(plain).toContain("EMEA 80 95 101");
  });

  it("joins wrapped cells and cells centred between their lines (Word)", async () => {
    const found = tableRows(await read("word-wrapped"));
    expect(found).toHaveLength(5);
    expect(found[1]).toBe("| R-1 | The system must export every report as a PDF file and as a CSV file, including the reports that were created before the migration. | High | Dana |");
    expect(found[3]).toBe("| R-3 | All changes to customer records are written to an audit log that is kept for at least seven years and can be searched by date and by user. | Medium |  |");
  });

  it("finds a table inside a page column and one across the page, and leaves the columns of text alone (Chrome)", async () => {
    const text = await read("chrome-two-column");
    expect(tableRows(text)).toEqual([
      "| Year | Units | Share |", "| 2023 | 1,204 | 11% |", "| 2024 | 1,530 |  |", "| 2025 | 1,911 | 17% |",
      "| Site | Opened | Staff | Area (m2) | Manager |", "| Leeds | 2019 | 42 | 3,100 | A. Khan |", "| Porto | 2021 |  | 2,450 | M. Silva |", "| Graz | 2024 | 17 |  | L. Huber |",
    ]);
    expect(text).toContain("\nsurvey showed that delivery times are still the\n");
  });

  it("finds no table in justified text or in lists (Chrome)", async () => {
    expect(tableRows(await read("chrome-justified"))).toEqual([]);
  });

  it("reads a right-to-left table (Word, Chrome)", async () => {
    expect(tableRows(await read("word-hebrew"))).toEqual(["| אזור | רבעון 1 | רבעון 2 | רבעון 3 |", "| צפון | 120 | 135 | 150 |", "| מרכז | 80 |  | 95 |", "| דרום | 60 | 70 |  |", "| ירושלים |  | 32 | 41 |"]);
    const statement = tableRows(await read("chrome-hebrew-statement"));
    expect(statement[0]).toBe("| תאריך | פרטים | חובה | זכות | יתרה |");
    expect(statement[1]).toBe("| 02/01 | תשלום בכרטיס ל-SuperMarket סניף 447 | 64.10 |  | 1,935.90 |");
    expect(statement[2]).toBe("| 03/01 | משכורת |  | 2,400.00 | 4,335.90 |");
  });

  it("separates columns that are closer together than a space (Word, no cell padding)", async () => {
    const found = tableRows(await read("word-dense"));
    expect(found[0]).toBe("| Site | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Total |");
    expect(found[1]).toBe("| Plant A-100 |  | 1,613 | 2,226 | 2,839 | 3,452 | 4,065 | 4,678 | 5,291 | 5,904 | 200,000 |");
    expect(found[11]).toBe("| Plant K-130 | 10,770 | 11,383 | 11,996 | 12,609 | 13,222 | 13,835 | 14,448 | 15,061 | 15,674 | 323,450 |");
    expect(found).toHaveLength(22);
  });

  it("reads a sideways table and a grouped heading (Word)", async () => {
    expect(tableRows(await read("word-sideways"))).toEqual(["| Month | Orders | Returns | Net |", "| January | 410 | 12 | 398 |", "| February | 388 |  | 388 |", "| March | 455 | 19 | 436 |"]);
    const grouped = tableRows(await read("word-grouped"));
    expect(grouped).toContain("|  | Gateways | 6 |  | 9 | 11 |");
    expect(grouped).toContain("| Software | Support | 12 | 12 | 13 | 15 |");
  });
});

// ---------- Pages without text ----------

function pdfWithPages(pages: string[]): Uint8Array {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((body, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return new TextEncoder().encode(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

describe("PDF pages without text", () => {
  const chart = "0.2 0.4 0.8 rg 110 300 40 120 re f 170 300 40 200 re f";
  const input = { name: "a.pdf", mimeType: "application/pdf", format: "pdf" as const };

  it("says so on the page, so the model does not guess what a chart shows", async () => {
    const result = await extractText(pdfWithPages(["BT /F1 12 Tf 72 720 Td (See the chart on the next page.) Tj ET", chart]), input);
    expect(result.pages).toBe(2);
    expect(result.text).toBe("--- Page 1 ---\nSee the chart on the next page.\n\n--- Page 2 ---\n[No text on this page. It may be a scan, a photo, or a chart.]");
  });

  it("still refuses a PDF with no text at all", async () => {
    await expect(extractText(pdfWithPages([chart, chart]), input)).rejects.toThrow(/no text layer/);
  });
});
