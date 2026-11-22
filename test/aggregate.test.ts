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

describe("the aggregate_table tool", () => {
  const SALES = ["Region,Month,Revenue", ...Array.from({ length: 3_000 }, (_, index) => `${["East", "West", "North"][index % 3]},2026-0${1 + (index % 6)}-01,${100 + (index % 7)}`)].join("\n");

  async function both() {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createLargeFiles, FileDocumentStore, MemoryDocumentStore } = await import("../src/index.js");
    const bytes = new TextEncoder().encode(SALES);
    const memory = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const ranged = createLargeFiles({ store: new FileDocumentStore(await mkdtemp(path.join(tmpdir(), "llf-agg-"))), budget: { inlineTokens: 10 }, wholeDocumentBytes: 0, scanChunkBytes: 1_024 });
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
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const log = await files.ingest({ name: "app.log", bytes: new TextEncoder().encode("2026-01-01 10:00:00 INFO x\n".repeat(200)) });
    const csv = await files.ingest({ name: "s.csv", bytes: new TextEncoder().encode(SALES) });
    expect(files.tools([log]).declarations.map((declaration) => declaration.name)).not.toContain("aggregate_table");
    expect((await files.prepare([log.id], { tokens: 0, bytes: 0 })).instruction).not.toContain("aggregate_table");
    expect((await files.prepare([csv.id], { tokens: 0, bytes: 0 })).instruction).toContain("use aggregate_table: it reads every row");
  });
});
