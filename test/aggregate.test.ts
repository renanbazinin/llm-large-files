import { describe, expect, it } from "vitest";
import { aggregateTable, csvSeparator, parseNumber, pipeCells } from "../src/aggregate.js";
import { SearchableDocument } from "../src/search.js";
import type { DocumentFormat } from "../src/types.js";

const doc = (format: DocumentFormat, text: string) => new SearchableDocument({ meta: { id: "doc_a", name: `t.${format}`, format } as never, text });

const CSV = [
  "Region,Month,Customer,Revenue",
  "East,2026-01-15,Acme,\"1,200.50\"",
  "West,2026-01-20,Globex,900",
  "East,2026-02-03,\"Initech, Ltd\",300",
  "North,2026-02-11,Umbrella,n/a",
  "east,2026-03-01,\"Hooli",
  "and sons\",1000",
  "West,2026-03-09,Acme,(100)",
].join("\n");

describe("parseNumber", () => {
  it("reads numbers as people write them in tables", () => {
    const cases: Array<[string, number | undefined]> = [
      ["1,234.5", 1234.5], ["-12", -12], ["(1,200)", -1200], ["₪4,750", 4750], ["4,750 ₪", 4750], ["$ 12.00", 12],
      ["12%", 12], ["1.5e3", 1500], ["1 234", 1234], ["12,5", 12.5], ["1.234,56", 1234.56], ["-$5", -5], ["4,750 ש\"ח", 4750],
      ["", undefined], ["n/a", undefined], ["12abc", undefined], ["2026-01-15", undefined], ["1,2,3", undefined],
    ];
    for (const [text, value] of cases) expect(parseNumber(text), text).toBe(value);
  });
});

describe("aggregateTable", () => {
  it("sums, averages and counts a CSV by group, with quoted fields across lines", async () => {
    const result = await aggregateTable(doc("csv", CSV), { groupBy: ["Region"], metrics: ["count", "sum:Revenue", "avg:Revenue", "max:Revenue"] });
    expect(result.table).toBe("the CSV file");
    expect(result.columns).toEqual(["Region", "Month", "Customer", "Revenue"]);
    expect(result.rowsRead).toBe(6);
    expect(result.groups).toEqual([
      { key: { Region: "East" }, count: 3, values: { count: 3, "sum:Revenue": 2500.5, "avg:Revenue": 833.5, "max:Revenue": 1200.5 }, lines: [2, 4, 6] },
      { key: { Region: "West" }, count: 2, values: { count: 2, "sum:Revenue": 800, "avg:Revenue": 400, "max:Revenue": 900 }, lines: [3, 8] },
      { key: { Region: "North" }, count: 1, values: { count: 1, "sum:Revenue": null, "avg:Revenue": null, "max:Revenue": null }, lines: [5] },
    ]);
    expect(result.notNumbers).toEqual({ "sum:Revenue": 1, "avg:Revenue": 1, "max:Revenue": 1 });
  });

  it("filters rows, compares numbers as numbers and dates as text, and groups dates by month", async () => {
    const big = await aggregateTable(doc("csv", CSV), { filters: [{ column: "revenue", op: ">=", value: 900 }], metrics: ["count", "sum:Revenue"] });
    expect(big.groups).toEqual([{ key: {}, count: 3, values: { count: 3, "sum:Revenue": 3100.5 }, lines: [2, 3, 6] }]);
    const months = await aggregateTable(doc("csv", CSV), { groupBy: ["Month:month"], metrics: ["sum:Revenue"], orderBy: "key" });
    expect(months.groups.map((group) => [group.key["Month:month"], group.values["sum:Revenue"]])).toEqual([["2026-01", 2100.5], ["2026-02", 300], ["2026-03", 900]]);
    const february = await aggregateTable(doc("csv", CSV), { filters: [{ column: "Month", op: ">=", value: "2026-02-01" }, { column: "Month", op: "<", value: "2026-03-01" }], metrics: ["count", "min:Month", "max:Month"] });
    expect(february.groups[0]!.values).toEqual({ count: 2, "min:Month": "2026-02-03", "max:Month": "2026-02-11" });
    const named = await aggregateTable(doc("csv", CSV), { filters: [{ column: "Customer", op: "contains", value: "acme" }], metrics: ["count_distinct:Region"] });
    expect(named.groups[0]!.values).toEqual({ "count_distinct:Region": 2 });
  });

  it("finds the separator of a CSV file, and reads a TSV or a semicolon file", async () => {
    expect(csvSeparator(["a;b;c", "1;2,5;3", "4;5;6"])).toBe(";");
    expect(csvSeparator(["a\tb", "1\t2"])).toBe("\t");
    const result = await aggregateTable(doc("csv", "Name;Amount\nA;1,5\nB;2,5\n"), { metrics: ["sum:Amount"] });
    expect(result.groups[0]!.values).toEqual({ "sum:Amount": 4 });
  });

  it("reads a sheet of a workbook by name or number, and names columns by letter when the first row is numbers", async () => {
    const text = [
      "## Sheet 1: Notes", "Columns: | A |", "Row 1: | hello |", "",
      "## Sheet 2: Sales 2026", "Columns: | A | B | C |", "Row 1: | Region | Customer | Revenue |", "Row 2: | East | ירושלים בע\"מ | 1719 |", "Row 4: | East | B \\| C | 281 |", "Row 5: | West | D | 50 |", "",
      "## Sheet 3: Raw", "Columns: | A | B |", "Row 1: | 1 | 10 |", "Row 2: | 2 | 20 |",
    ].join("\n");
    const sales = await aggregateTable(doc("xlsx", text), { table: "sales 2026", groupBy: ["Region"], metrics: ["sum:Revenue"] });
    expect(sales.table).toBe("Sheet 2: Sales 2026");
    expect(sales.tables).toBe(3);
    expect(sales.groups.map((group) => [group.key.Region, group.values["sum:Revenue"], group.lines])).toEqual([["East", 2000, [8, 9]], ["West", 50, [10]]]);
    const raw = await aggregateTable(doc("xlsx", text), { table: 3, metrics: ["sum:B"] });
    expect(raw.columns).toEqual(["A", "B"]);
    expect(raw.groups[0]!.values).toEqual({ "sum:B": 30 });
    await expect(aggregateTable(doc("xlsx", text), { table: "Budget" })).rejects.toThrow('No table "Budget" in this file: it has 3 sheets. Name a sheet or give a number from 1 to 3.');
  });

  it("reads the | cell | tables of other documents, by number", async () => {
    const text = ["# Report", "| Region | Q1 |", "| --- | --- |", "| East | 10 |", "| West | 5 |", "", "Text between.", "| Item | Price |", "| Pen | ₪3.50 |", "| Book | ₪42 |"].join("\n");
    const second = await aggregateTable(doc("docx", text), { table: 2, metrics: ["sum:Price", "count"] });
    expect(second.table).toBe("table 2 of 2");
    expect(second.groups[0]!.values).toEqual({ "sum:Price": 45.5, count: 2 });
    const first = await aggregateTable(doc("pdf", text), { metrics: ["sum:Q1"] });
    expect(first.groups[0]!.values).toEqual({ "sum:Q1": 15 });
    expect(pipeCells("| a \\| b | | c |")).toEqual(["a | b", "", "c"]);
  });

  it("says what is wrong: no table, an unknown column, a bad metric or filter", async () => {
    await expect(aggregateTable(doc("text", "just prose\nno table"), {})).rejects.toThrow(/This file has no table to aggregate/);
    await expect(aggregateTable(doc("csv", CSV), { metrics: ["sum:Profit"] })).rejects.toThrow('No column "Profit" in this table. Its columns are: "Region", "Month", "Customer", "Revenue".');
    await expect(aggregateTable(doc("csv", CSV), { metrics: ["median:Revenue"] })).rejects.toThrow(/A metric must be "count", or one of/);
    await expect(aggregateTable(doc("csv", CSV), { metrics: ["sum"] })).rejects.toThrow('The metric "sum" needs a column: "sum:<column>".');
    await expect(aggregateTable(doc("csv", CSV), { filters: [{ column: "Region", op: "like" as never, value: "x" }] })).rejects.toThrow(/A filter's op must be one of/);
    await expect(aggregateTable(doc("csv", CSV), { groupBy: ["a", "b", "c", "d"] })).rejects.toThrow("group_by takes at most 3 columns.");
  });

  it("counts groups past the cap together, and shows at most the limit", async () => {
    const rows = ["id,v", ...Array.from({ length: 10_050 }, (_, index) => `${index},1`)].join("\n");
    const result = await aggregateTable(doc("csv", rows), { groupBy: ["id"], limit: 5 });
    expect(result.totalGroups).toBe(10_000);
    expect(result.otherRows).toBe(50);
    expect(result.groups).toHaveLength(5);
  });
});

describe("a filter whose value names a column (0.10.0)", () => {
  // The budget of the evals, short: a title row, then a header of two rows, as Flash-Lite counted it.
  const BUDGET = [
    "## Sheet 1: תקציב", "Columns: | A |", "Row 1: | תקציב מחלקות 2026 |",
    "Row 2: | מחלקה | רבעון 1 |  | רבעון 2 |  |", "Row 3: |  | תקציב | ביצוע | תקציב | ביצוע |",
    "Row 4: | רכש | 150 | 105 | 160 | 120 |", "Row 5: | כספים | 187 | 195 | 201 | 190 |", "Row 6: | שיווק | 261 | 284 | 283 | 249 |",
  ].join("\n");

  it("compares each row's cell with the cell of the column its value names, for >, >=, < and <=", async () => {
    // It compared the name as text before, matched no row and said nothing: Flash-Lite then counted
    // 48 rows by eye, and missed one.
    const named = await aggregateTable(doc("xlsx", BUDGET), { filters: [{ column: "רבעון 1 / ביצוע", op: ">", value: "רבעון 1 / תקציב" }] });
    expect(named.rowsMatched).toBe(2);
    expect(named.groups).toEqual([{ key: {}, count: 2, values: { count: 2 }, lines: [7, 8] }]);
    expect(named.compared).toEqual([{ column: "רבעון 1 / ביצוע", op: ">", with: "רבעון 1 / תקציב" }]);
    // Letters for both: "C" is the column, "B" the other one.
    expect((await aggregateTable(doc("xlsx", BUDGET), { filters: [{ column: "C", op: ">", value: "B" }] })).compared).toEqual([{ column: "רבעון 1 / ביצוע", op: ">", with: "רבעון 1 / תקציב" }]);
    expect((await aggregateTable(doc("xlsx", BUDGET), { filters: [{ column: "רבעון 2 / ביצוע", op: "<", value: "רבעון 2 / תקציב" }], metrics: ["sum:רבעון 2 / ביצוע"] })).groups[0]!.values).toEqual({ "sum:רבעון 2 / ביצוע": 559 });
    // A lower name of a joined header that two columns have says which.
    await expect(aggregateTable(doc("xlsx", BUDGET), { filters: [{ column: "רבעון 1 / ביצוע", op: "<=", value: "תקציב" }] })).rejects.toThrow('"תקציב" names 2 columns of this table: "רבעון 1 / תקציב", "רבעון 2 / תקציב". Name one of them in full, to compare "רבעון 1 / ביצוע" with it in each row.');
    // In a CSV file too, ignoring case and spaces; an empty cell, or a number against a text, does not match.
    const csv = await aggregateTable(doc("csv", "Item,Budget,Actual\nA,10,12\nB,10,8\nC,10,\nD,n/a,40\nE,7,7\n"), { filters: [{ column: "Actual", op: ">=", value: " budget " }] });
    expect(csv.groups[0]!.lines).toEqual([2, 6]);
    // Dates as text: shipped after it was ordered.
    const dates = await aggregateTable(doc("csv", "Order,Ordered,Shipped\n1,2026-03-01,2026-03-04\n2,2026-03-05,2026-03-02\n"), { filters: [{ column: "Shipped", op: ">", value: "Ordered" }] });
    expect(dates.groups[0]!.lines).toEqual([2]);
  });

  it("keeps a filter whose value is a column's name only by chance: equality, text, a number, a letter for a named column", async () => {
    const table = "Department,Total,Grade\nSales,10,A\nTotal,30,C\nSupport,20,B\n";
    // A summary row whose label is also a column's name.
    expect((await aggregateTable(doc("csv", table), { filters: [{ column: "Department", op: "!=", value: "Total" }] })).rowsMatched).toBe(2);
    expect((await aggregateTable(doc("csv", table), { filters: [{ column: "Department", op: "contains", value: "total" }] })).rowsMatched).toBe(1);
    // A letter is a value when the column is named by its name: grades from B on.
    expect((await aggregateTable(doc("csv", table), { filters: [{ column: "Grade", op: ">=", value: "B" }] })).rowsMatched).toBe(2);
    // A number is a value, even where years name the columns.
    expect((await aggregateTable(doc("pdf", "| Region | 2024 | 2025 |\n| East | 10 | 12 |\n| West | 5 | 6 |"), { filters: [{ column: "2025", op: ">", value: 2024 }] })).rowsMatched).toBe(0);
  });

  it("names a column by its letter in a table with a header too, as the tool's description says", async () => {
    // "No column \"C\"" before, in every table but a sheet with no header.
    const sheet = await aggregateTable(doc("xlsx", BUDGET), { metrics: ["sum:C"] });
    expect(sheet.groups[0]!.values).toEqual({ "sum:רבעון 1 / ביצוע": 584 });
    const csv = await aggregateTable(doc("csv", CSV), { metrics: ["sum:D"], filters: [{ column: "a", op: "=", value: "West" }] });
    expect(csv.groups[0]!.values).toEqual({ "sum:Revenue": 800 });
    // A column of that name comes first, and a letter past the last column is no column.
    expect((await aggregateTable(doc("csv", "B,A\n1,2\n"), { metrics: ["sum:A"] })).groups[0]!.values).toEqual({ "sum:A": 2 });
    await expect(aggregateTable(doc("csv", CSV), { metrics: ["sum:E"] })).rejects.toThrow('No column "E" in this table.');
  });
});

describe("the aggregate_table tool", () => {
  const SALES = ["Region,Month,Revenue", ...Array.from({ length: 3_000 }, (_, index) => `${["East", "West", "North"][index % 3]},2026-0${1 + (index % 6)}-01,${100 + (index % 7)}`)].join("\n");

  async function both() {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createLargeFiles, FileDocumentStore, MemoryDocumentStore } = await import("../src/index.js");
    const bytes = new TextEncoder().encode(SALES);
    const memory = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const ranged = createLargeFiles({ requireOwner: false, store: new FileDocumentStore(await mkdtemp(path.join(tmpdir(), "llf-agg-"))), budget: { inlineTokens: 10 }, wholeDocumentBytes: 0, scanChunkBytes: 1_024 });
    return [
      { files: memory, meta: await memory.ingest({ name: "sales.csv", bytes }), how: "in memory" },
      { files: ranged, meta: await ranged.ingest({ name: "sales.csv", bytes }), how: "by range" },
    ];
  }

  it("is offered for a CSV, answers with exact groups, and agrees in memory and by range", async () => {
    let expected: unknown;
    for (const { files, meta, how } of await both()) {
      const tools = files.tools([meta]);
      expect(tools.declarations.map((declaration) => declaration.name), how).toContain("aggregate_table");
      const result = await tools.execute("aggregate_table", { document_id: meta.id, group_by: ["Region"], metrics: ["count", "sum:Revenue"], filters: [{ column: "Month", op: ">=", value: "2026-04-01" }] });
      expect(result.error, how).toBeUndefined();
      expect(result.rows_read, how).toBe(3_000);
      expect(result.rows_matched, how).toBe(1_500);
      expect(result.columns, how).toEqual(["Region", "Month", "Revenue"]);
      const groups = result.groups as Array<{ group: { Region: string }; count: number; "sum:Revenue": number; lines: number[] }>;
      expect(groups.map((group) => group.group.Region).sort(), how).toEqual(["East", "North", "West"]);
      expect(groups.reduce((sum, group) => sum + group.count, 0), how).toBe(1_500);
      expected ??= result.groups;
      expect(result.groups, how).toEqual(expected);
      expect(tools.describe("aggregate_table", { document_id: meta.id, group_by: ["Region"], metrics: ["sum:Revenue"], filters: [{ column: "Month", op: ">=", value: "2026-04-01" }] }), how).toBe("Aggregate sales.csv: sum:Revenue by Region where Month >= 2026-04-01");
    }
  });

  it("tells a model what is wrong in words it can act on", async () => {
    const { files, meta } = (await both())[0]!;
    const tools = files.tools([meta]);
    expect((await tools.execute("aggregate_table", { document_id: meta.id, metrics: ["sum:Profit"] })).error).toMatch(/^No column "Profit" in this table\. Its columns are: "Region", "Month", "Revenue"\.$/);
    expect((await tools.execute("aggregate_table", { document_id: meta.id, filters: [{ column: "Region", op: "like", value: "E" }] })).error).toMatch(/A filter's op must be one of/);
    expect((await tools.execute("aggregate_table", { document_id: meta.id, group_by: "Region" })).error).toBeUndefined();
  });

  it("says when a filter compared two cells of each row, as its value names a column (0.10.0)", async () => {
    const { createLargeFiles, MemoryDocumentStore } = await import("../src/index.js");
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "budget.csv", bytes: new TextEncoder().encode("Department,Budget,Actual\nSales,10,12\nSupport,10,8\nOps,5,9\n") });
    const result = await files.tools([meta]).execute("aggregate_table", { document_id: meta.id, filters: [{ column: "Actual", op: ">", value: "Budget" }] });
    expect(result.rows_matched).toBe(2);
    expect(result.filter_note).toBe('Each row\'s "Actual" was compared with its own "Budget" (>), as the filter\'s value names that column.');
    expect((await files.tools([meta]).execute("aggregate_table", { document_id: meta.id, filters: [{ column: "Actual", op: ">", value: 9 }] })).filter_note).toBeUndefined();
  });

  it("says how to cite the lines it lists, with the file's name, for a table sent whole (0.10.0)", async () => {
    const { files, meta } = (await both())[0]!;
    const east = { document_id: meta.id, filters: [{ column: "Region", op: "=", value: "East" }], metrics: ["sum:Revenue"] };
    // Flash-Lite answered counts over a table shown in full with no line cited.
    const whole = await files.tools([meta], { inline: [meta.id] }).execute("aggregate_table", east);
    expect((whole.groups as Array<{ lines: number[] }>)[0]!.lines).toEqual([2, 5, 8]);
    expect(whole.cite).toBe("Cite the lines listed in your answer, like (sales.csv L2, L5, L8).");
    expect(Object.keys(whole).at(-1)).toBe("cite");
    // A grouped result: the first group's lines.
    const grouped = await files.tools([meta], { inline: [meta.id] }).execute("aggregate_table", { document_id: meta.id, group_by: ["Region"] });
    expect(grouped.cite).toBe(`Cite the lines listed in your answer, like (sales.csv ${(grouped.groups as Array<{ lines: number[] }>)[0]!.lines.map((line) => `L${line}`).join(", ")}).`);
    // Searched, the guide asks for citations already; and no row matched, there is no line to cite.
    expect((await files.tools([meta]).execute("aggregate_table", east)).cite).toBeUndefined();
    expect((await files.tools([meta], { inline: [meta.id] }).execute("aggregate_table", { document_id: meta.id, filters: [{ column: "Region", op: "=", value: "South" }] })).cite).toBeUndefined();
  });

  it("cites the header and each group's first rows, and keeps the groups when shortened", async () => {
    const { evidenceOf, stubResult, toolResultSummary } = await import("../src/index.js");
    const { files, meta } = (await both())[0]!;
    const call = { id: "c1", name: "aggregate_table", args: { document_id: meta.id, group_by: ["Month:month"], metrics: ["avg:Revenue"], order_by: "key" } };
    const result = await files.tools([meta]).execute(call.name, call.args);
    const groups = result.groups as Array<{ group: Record<string, string> }>;
    expect(groups.map((group) => group.group["Month:month"])).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
    // The header and the first rows of each month: lines 2 to 19, next to the header.
    expect(evidenceOf(call, result)!.lines).toEqual([[1, 19]]);
    expect(toolResultSummary("", result)).toBe(" — 3,000 rows, 6 groups");
    const stub = stubResult(call, { ...result, padding: "x".repeat(800) })!;
    expect(stub.dropped).toBe(true);
    expect((stub.groups as unknown[]).length).toBe(6);
  });

  it("is not offered for a log, and the tool guide names it only with a table", async () => {
    const { createLargeFiles, MemoryDocumentStore } = await import("../src/index.js");
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const log = await files.ingest({ name: "app.log", bytes: new TextEncoder().encode("2026-01-01 10:00:00 INFO x\n".repeat(200)) });
    const csv = await files.ingest({ name: "s.csv", bytes: new TextEncoder().encode(SALES) });
    expect(files.tools([log]).declarations.map((declaration) => declaration.name)).not.toContain("aggregate_table");
    expect((await files.prepare([log.id], { tokens: 0, bytes: 0 })).instruction).not.toContain("aggregate_table");
    expect((await files.prepare([csv.id], { tokens: 0, bytes: 0 })).instruction).toContain("use aggregate_table: it reads every row");
  });
});

describe("headers of more than one row", () => {
  it("skips a title row and joins a header of two rows, a merged cell taking the one to its left", async () => {
    const text = [
      "## Sheet 1: דוח",
      "Row 1: | דוח מכירות 2026 |",
      "Row 2: | אזור | Q1 |  | Q2 |  |",
      "Row 3: |  | ינואר | פברואר | אפריל | מאי |",
      "Row 4: | צפון | 10 | 20 | 30 | 40 |",
      "Row 5: | דרום | 1 | 2 | 3 | 4 |",
    ].join("\n");
    const result = await aggregateTable(doc("xlsx", text), { metrics: ["sum:Q1 / פברואר", "sum:מאי"] });
    expect(result.title).toBe("דוח מכירות 2026");
    expect(result.headerRows).toBe(2);
    expect(result.headerLine).toBe(4);
    expect(result.columns).toEqual(["אזור", "Q1 / ינואר", "Q1 / פברואר", "Q2 / אפריל", "Q2 / מאי"]);
    expect(result.groups[0]!.values).toEqual({ "sum:Q1 / פברואר": 22, "sum:Q2 / מאי": 44 });
  });

  it("takes years for column names, leaves out a header repeated inside the table, and counts odd rows", async () => {
    const text = ["| Region | 2024 | 2025 |", "| East | 10 | 12 |", "| Region | 2024 | 2025 |", "| West | 5 | 6 |", "| North | 1 | 2 | 99 |"].join("\n");
    const result = await aggregateTable(doc("pdf", text), { metrics: ["sum:2025"] });
    expect(result.columns).toEqual(["Region", "2024", "2025"]);
    expect(result.rowsRead).toBe(3);
    expect(result.repeatedHeaders).toBe(1);
    expect(result.irregularRows).toBe(1);
    expect(result.groups[0]!.values).toEqual({ "sum:2025": 20 });
  });

  it("takes one header row for a table with no numbers, and follows header_rows when given", async () => {
    const names = ["| Name | City |", "| Dana | Haifa |", "| Avi | Eilat |", "| Noa | Haifa |"].join("\n");
    const counted = await aggregateTable(doc("docx", names), { groupBy: ["City"] });
    expect(counted.columns).toEqual(["Name", "City"]);
    expect(counted.groups.map((group) => [group.key.City, group.count])).toEqual([["Haifa", 2], ["Eilat", 1]]);
    const none = await aggregateTable(doc("docx", names), { headerRows: 0, metrics: ["count"] });
    expect(none.columns).toEqual(["Column 1", "Column 2"]);
    expect(none.rowsRead).toBe(4);
    const csv = await aggregateTable(doc("csv", "Report of March\nItem,Amount\nA,1\nB,2\n"), { metrics: ["sum:Amount"] });
    expect(csv.title).toBe("Report of March");
    expect(csv.groups[0]!.values).toEqual({ "sum:Amount": 3 });
  });
});

describe("header_rows given with a title row", () => {
  it("counts the header rows below the title", async () => {
    const text = ["## Sheet 1: דוח", "Row 1: | דוח מכירות 2026 |", "Row 2: | אזור | ינואר |  | פברואר |  |", "Row 3: |  | יחידות | הכנסות | יחידות | הכנסות |", "Row 4: | צפון | 1 | 10 | 2 | 20 |", "Row 5: | דרום | 3 | 30 | 4 | 40 |"].join("\n");
    for (const headerRows of [undefined, 2]) {
      const result = await aggregateTable(doc("xlsx", text), { metrics: ["sum:פברואר / הכנסות"], ...(headerRows !== undefined ? { headerRows } : {}) });
      expect(result.title).toBe("דוח מכירות 2026");
      expect(result.groups[0]!.values).toEqual({ "sum:פברואר / הכנסות": 60 });
    }
    const one = await aggregateTable(doc("xlsx", text), { metrics: ["count"], headerRows: 1 });
    expect(one.columns[0]).toBe("אזור");
  });
});

describe("a lower header name of several columns", () => {
  it("says which columns it names", async () => {
    const text = ["## Sheet 1: S", "Row 1: | אזור | ינואר |  | פברואר |  |", "Row 2: |  | יחידות | הכנסות | יחידות | הכנסות |", "Row 3: | צפון | 1 | 10 | 2 | 20 |"].join("\n");
    await expect(aggregateTable(doc("xlsx", text), { metrics: ["sum:הכנסות"] })).rejects.toThrow('"הכנסות" names 2 columns of this table: "ינואר / הכנסות", "פברואר / הכנסות". Name one of them in full.');
  });
});
