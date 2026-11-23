import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type ToolResult } from "../src/index.js";
import { utf8 } from "./fake-model.js";

const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
type Match = { line: number; section?: string; text: string };
const matchesOf = (result: ToolResult) => result.matches as Match[];

describe("where a search hit sits", () => {
  it("gives the header row of a CSV file with its hits", async () => {
    const csv = ["Region,Month,Revenue", ...Array.from({ length: 200 }, (_, index) => `${index % 2 ? "East" : "West"},2026-01,${index}`)].join("\n");
    const meta = await files.ingest({ name: "sales.csv", bytes: utf8(csv) });
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "East", mode: "exact", max_results: 3 });
    expect(result.table_headers).toEqual([{ line: 1, text: "Region,Month,Revenue" }]);
    expect(matchesOf(result)[0]!.section).toBeUndefined();
  });

  it("gives the first row of each sheet a hit is in, and the sheet as its section", async () => {
    const text = ["## Sheet 1: North", "Columns: | A | B |", "Row 1: | City | Amount |", "Row 2: | Haifa | 10 |", "", "## Sheet 2: South", "Columns: | A | B |", "Row 1: | City | Amount |", "Row 2: | Eilat | 20 |", "Row 3: | Beersheba | 30 |"].join("\n");
    const own = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 }, extractors: { xlsx: async () => ({ text }) } });
    const meta = await own.ingest({ name: "cities.xlsx", bytes: utf8("PK") });
    const result = await own.tools([meta]).execute("search_document", { document_id: meta.id, query: "\\| \\d0 \\|", mode: "regex" });
    expect(result.table_headers).toEqual([{ line: 3, text: "Row 1: | City | Amount |" }, { line: 8, text: "Row 1: | City | Amount |" }]);
    expect(matchesOf(result).map((match) => [match.line, match.section])).toEqual([[4, "Sheet 1: North"], [9, "Sheet 2: South"], [10, "Sheet 2: South"]]);
  });

  it("gives the first row of a | cell | table, and the heading above a hit", async () => {
    const text = ["# Contract", "", "## 2.1 Rent", "The rent is paid monthly.", "", "| Year | Rent |", "| --- | --- |", "| 2027 | 4,750 |", "| 2028 | 4,900 |", "", "## 3. Term", "The term is 24 months."].join("\n");
    const meta = await files.ingest({ name: "lease.md", bytes: utf8(text) });
    const rent = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "4,900", mode: "exact" });
    expect(rent.table_headers).toEqual([{ line: 6, text: "| Year | Rent |" }]);
    expect(matchesOf(rent)).toEqual([{ line: 9, section: "2.1 Rent", text: "| 2028 | 4,900 |" }]);
    const term = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "24 months", mode: "exact" });
    expect(term.table_headers).toBeUndefined();
    expect(matchesOf(term)[0]!.section).toBe("3. Term");
  });

  it("gives no section in a log, and no header for a row that is the table's first", async () => {
    const log = await files.ingest({ name: "app.log", bytes: utf8("2026-01-01 10:00:00 ERROR a\n".repeat(30)) });
    const result = await files.tools([log]).execute("search_document", { document_id: log.id, query: "ERROR", mode: "exact", max_results: 2 });
    expect(matchesOf(result).every((match) => match.section === undefined)).toBe(true);
    expect(result.table_headers).toBeUndefined();
    const table = await files.ingest({ name: "t.md", bytes: utf8("| Year | Rent |\n| 2027 | 1 |\n") });
    const first = await files.tools([table]).execute("search_document", { document_id: table.id, query: "Year", mode: "exact" });
    expect(first.table_headers).toBeUndefined();
  });
});
