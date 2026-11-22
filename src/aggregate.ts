import { scanSource, type DocumentSource } from "./search.js";
import { composed, foldCase, sliceWhole } from "./text.js";

/**
 * `aggregate_table`: counts, sums, averages, minimums and maximums over the rows of one table of a
 * document, with filters and groups, exactly, without code and without the model reading the rows.
 * A model that adds up 50,000 rows by reading them needs hundreds of calls and gets it wrong; this
 * reads them once. Every group says the lines of its first rows, so an answer can cite them.
 *
 * The tables it reads:
 * - a CSV or TSV file (format "csv"): the whole file, its first line the header; the separator is
 *   found from the first lines (comma, semicolon, tab or "|"), and quoted fields may hold separators,
 *   quotes and line breaks;
 * - a sheet of an Excel workbook (format "xlsx"), as the XLSX extractor writes it: `## Sheet 2:
 *   name`, `Columns: …`, then `Row 7: | a | b |` lines; its first row is the header unless every
 *   value of it is a number, and then the columns are named by their letters;
 * - any run of `| cell | cell |` lines in another document: the tables of DOCX, PPTX, PDF, HTML and
 *   Markdown files, numbered in the order of the file. A Markdown separator row (`|---|`) is skipped.
 */

/** The most groups counted one by one; rows of further groups are counted together. */
export const MAX_AGGREGATE_GROUPS = 10_000;
/** The most groups shown in a result. */
export const MAX_SHOWN_GROUPS = 200;
/** Lines of the first rows kept for each group, to cite. */
const CITED_LINES = 3;
/** Columns a row may have, at most: past it, the rest are left out. */
const MAX_COLUMNS = 1_024;
/** A CSV record may span this many lines, at most (a quoted field with line breaks). */
const MAX_RECORD_LINES = 1_000;
/** A value is compared and grouped by its first this many characters. */
const MAX_VALUE = 500;

export type AggregateOp = "count" | "sum" | "avg" | "min" | "max" | "count_distinct";
export const AGGREGATE_OPS: readonly AggregateOp[] = ["count", "sum", "avg", "min", "max", "count_distinct"];
export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "not_contains" | "starts_with" | "empty" | "not_empty";
export const FILTER_OPS: readonly FilterOp[] = ["=", "!=", ">", ">=", "<", "<=", "contains", "not_contains", "starts_with", "empty", "not_empty"];
/** A date column grouped by a part of its dates: `"Date:month"` groups 2026-03-14 under 2026-03. */
export type DatePart = "year" | "month" | "day";

export type AggregateRequest = {
  /** Which table: a sheet's name or number for a workbook, a table's number for other documents. Defaults to the first. */
  table?: string | number;
  filters?: Array<{ column: string; op: FilterOp; value?: string | number }>;
  /** Up to 3 columns; each may end in ":year", ":month" or ":day" for a column of dates. */
  groupBy?: string[];
  /** "count", or an op and a column: "sum:Revenue", "avg:Price", "count_distinct:Customer". Defaults to ["count"]. */
  metrics?: string[];
  /** "metric" (the default): the largest value of the first metric first; "key": by the groups' values, in order. */
  orderBy?: "metric" | "key";
  /**
   * How many rows at the top of the table are its header: 0 when it has none (columns are named by
   * their letters in a workbook, "Column 1"… elsewhere), up to 5. Unset: one for a CSV file; for a
   * sheet or a `| cell |` table it is found (see `aggregateTable`).
   */
  headerRows?: number;
  /** Groups shown, at most. Defaults to 50. */
  limit?: number;
};

export type AggregateGroup = {
  /** The value of each group-by column, as the first row of the group writes it. */
  key: Record<string, string>;
  count: number;
  /** Each metric by its name ("sum:Revenue"). Null when no row of the group had a number in its column. */
  values: Record<string, number | string | null>;
  /** The lines of the group's first rows. */
  lines: number[];
};

export type AggregateResult = {
  /** Which table was read: "Sheet 2: Sales", "table 3 of 5", "the CSV file". */
  table: string;
  /** How many tables the document has: sheets, or `| cell |` tables. */
  tables: number;
  columns: string[];
  headerLine: number;
  rowsRead: number;
  rowsMatched: number;
  groups: AggregateGroup[];
  totalGroups: number;
  /** Rows of groups past `MAX_AGGREGATE_GROUPS`. */
  otherRows: number;
  /** The rows taken for the header, and a title row above them that was left out. */
  headerRows: number;
  title?: string;
  /** Rows the same as the header, found again inside the table (a header a PDF repeats on each page): left out. */
  repeatedHeaders: number;
  /** Rows with another number of cells than the header: read, and counted here, as a sign of a table read wrong. */
  irregularRows: number;
  /** For each numeric metric, how many matched rows had a value in its column that is not a number (left out). */
  notNumbers: Record<string, number>;
};

/**
 * A number as a person writes it in a table: "1,234.5", "-12", "(1,200)" for a negative, "₪4,750",
 * "$ 12.00", "12%" (12), "1.5e3", "1 234" with a space or a no-break space between thousands.
 * A value with a comma and no dot is taken for thousands when the comma is followed by three digits
 * ("4,750"), and for a decimal comma otherwise ("12,5"). Undefined for anything else.
 */
export function parseNumber(raw: string): number | undefined {
  let text = raw.trim();
  if (!text || text.length > 64) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  // Currency signs and codes, before or after, and a percent sign after.
  text = text.replace(/^[-+]?\s*(?:[$€£¥₪₹]|USD|EUR|GBP|ILS|NIS|ש"ח|ש״ח)\s*/i, (found) => (found.trim().startsWith("-") ? "-" : ""))
    .replace(/\s*(?:[$€£¥₪₹%]|USD|EUR|GBP|ILS|NIS|ש"ח|ש״ח)$/i, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }
  text = text.replace(/[\s  ']/g, "");
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(text)) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d+$/.test(text)) text = text.replace(",", ".");
  if (!/^(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? (negative ? -value : value) : undefined;
}

/** A value as it is compared and grouped: composed, case folded, white space collapsed, cut long. */
const valueKey = (value: string) => sliceWhole(foldCase(composed(value.replace(/\s+/g, " ").trim())), MAX_VALUE);

/** An ISO date at the start of a value: what `Date:month` and comparisons of dates read. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Splits a `| a | b |` row into its cells, honouring `\|` inside a cell. */
export function pipeCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let at = 0; at < body.length; at++) {
    const character = body[at]!;
    if (character === "\\" && body[at + 1] === "|") {
      current += "|";
      at++;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
      if (cells.length >= MAX_COLUMNS) return cells;
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** A Markdown separator row: `| --- | :---: |`. */
const SEPARATOR_ROW = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** The separator of a CSV file, from its first lines: the one found the same number of times (above 0) on most of them. */
export function csvSeparator(lines: string[]): string {
  let best = ",";
  let bestScore = -1;
  for (const separator of [",", ";", "\t", "|"]) {
    const counts = lines.map((line) => splitCsvLine(line, separator).fields.length - 1).filter((count) => count > 0);
    if (counts.length === 0) continue;
    const common = mode(counts);
    const score = counts.filter((count) => count === common).length * 1_000 + common;
    if (score > bestScore) {
      best = separator;
      bestScore = score;
    }
  }
  return best;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0]!;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > (counts.get(best) ?? 0)) best = value;
  }
  return best;
}

/**
 * The fields of a CSV line. `open`: the line ends inside a quoted field, which goes on on the next
 * line; `carry` is the field so far, to be joined with it.
 */
function splitCsvLine(line: string, separator: string, carry?: { fields: string[]; field: string }): { fields: string[]; open: boolean; field: string } {
  const fields = carry ? [...carry.fields] : [];
  let field = carry ? `${carry.field}\n` : "";
  let quoted = carry !== undefined;
  for (let at = 0; at < line.length; at++) {
    const character = line[at]!;
    if (quoted) {
      if (character === "\"") {
        if (line[at + 1] === "\"") {
          field += "\"";
          at++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === "\"" && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (character === separator) {
      fields.push(field.trim());
      field = "";
      if (fields.length >= MAX_COLUMNS) return { fields, open: false, field: "" };
    } else {
      field += character;
    }
  }
  if (quoted) return { fields, open: true, field };
  fields.push(field.trim());
  return { fields, open: false, field: "" };
}

/** A column a request names, resolved against the header: its index, and the part of a date to group by. */
type ColumnRef = { index: number; name: string; datePart?: DatePart };

/** Finds a column by its header name (ignoring case and spaces), its letter ("C"), or its number ("3"). */
function columnOf(header: string[], given: string, letters: boolean): ColumnRef {
  let name = given.trim();
  let datePart: DatePart | undefined;
  const part = /:(year|month|day)$/i.exec(name);
  if (part) {
    datePart = part[1]!.toLowerCase() as DatePart;
    name = name.slice(0, part.index).trim();
  }
  const wanted = valueKey(name);
  let index = header.findIndex((column) => valueKey(column) === wanted);
  // A header of two rows joins its names ("Q2 / מאי"): the lower name alone finds the column when only one has it.
  if (index === -1) {
    const lower = header.flatMap((column, at) => (valueKey(column.split(" / ").at(-1) ?? "") === wanted ? [at] : []));
    if (lower.length === 1) index = lower[0]!;
  }
  if (index === -1 && letters && /^[A-Z]{1,3}$/i.test(name)) {
    let number = 0;
    for (const letter of name.toUpperCase()) number = number * 26 + letter.charCodeAt(0) - 64;
    if (number <= header.length) index = number - 1;
  }
  if (index === -1 && /^\d+$/.test(name) && Number(name) >= 1 && Number(name) <= header.length) index = Number(name) - 1;
  if (index === -1) {
    const listed = header.slice(0, 40).map((column) => JSON.stringify(column)).join(", ");
    throw new Error(`No column ${JSON.stringify(sliceWhole(name, 80))} in this table. Its columns are: ${listed}${header.length > 40 ? ", …" : ""}.`);
  }
  return { index, name: header[index]!, ...(datePart ? { datePart } : {}) };
}

type Metric = { name: string; op: AggregateOp; column?: ColumnRef };
type Filter = { column: ColumnRef; op: FilterOp; value: string; number: number | undefined; key: string };
type GroupState = { key: Record<string, string>; count: number; sums: number[]; numbers: number[]; minimums: Array<number | string | undefined>; maximums: Array<number | string | undefined>; distinct: Array<Set<string> | undefined>; lines: number[] };

/** The value of a cell for comparing: a number when it is one, a date as written, or folded text. */
function compare(cell: string, filter: Filter): boolean {
  const key = valueKey(cell);
  switch (filter.op) {
    case "empty": return key === "";
    case "not_empty": return key !== "";
    case "contains": return key.includes(filter.key);
    case "not_contains": return !key.includes(filter.key);
    case "starts_with": return key.startsWith(filter.key);
  }
  const number = parseNumber(cell);
  // A cell that is not a number is neither more nor less than a number: "n/a" is not >= 900.
  if (filter.number !== undefined && number === undefined && filter.op !== "=" && filter.op !== "!=") return false;
  // Two numbers compare as numbers; two ISO dates, and anything else, as text.
  const order = number !== undefined && filter.number !== undefined
    ? Math.sign(number - filter.number)
    : key === filter.key ? 0 : key < filter.key ? -1 : 1;
  switch (filter.op) {
    case "=": return order === 0;
    case "!=": return order !== 0;
    case ">": return order > 0;
    case ">=": return order >= 0;
    case "<": return order < 0;
    case "<=": return order <= 0;
  }
  return false;
}

/** A number of a result, without the noise of binary fractions: 0.1 + 0.2 is 0.3. */
const tidy = (value: number) => Number(value.toPrecision(15));

/**
 * Reads the rows of one table and aggregates them. Throws an error the model can act on: no table,
 * a table that does not exist, an unknown column or operation.
 */
export async function aggregateTable(source: DocumentSource, request: AggregateRequest, signal?: AbortSignal): Promise<AggregateResult> {
  const format = source.meta.format;
  const kind: "csv" | "sheets" | "pipes" = format === "csv" ? "csv" : format === "xlsx" ? "sheets" : "pipes";
  const wantedTable = request.table;
  const metricsGiven = request.metrics && request.metrics.length > 0 ? request.metrics : ["count"];
  const limit = Math.min(MAX_SHOWN_GROUPS, Math.max(1, Math.trunc(request.limit ?? 50)));
  if ((request.groupBy?.length ?? 0) > 3) throw new Error("group_by takes at most 3 columns.");

  // The table being read: its number, its title, its header, and what the request resolved against it.
  let tableNumber = 0;
  let tableTitle = "";
  let chosenTitle = "";
  let chosen = false;
  /** Pipe tables: whether the lines read are rows of a table (a new table starts after other lines). */
  let inPipeTable = false;
  let header: string[] | undefined;
  let headerLine = 0;
  let letters = false;
  let filters: Filter[] = [];
  let groupColumns: ColumnRef[] = [];
  let metrics: Metric[] = [];
  const groups = new Map<string, GroupState>();
  let rowsRead = 0;
  let rowsMatched = 0;
  let otherRows = 0;
  // The first rows of the chosen table, held until its header is known.
  const pending: Array<{ row: string[]; line: number }> = [];
  let headerCount = 0;
  let title: string | undefined;
  let lastHeaderKey: string | undefined;
  let repeatedHeaders = 0;
  let irregularRows = 0;
  let notNumbers: number[] = [];
  // CSV: the separator, the first lines read to find it, and a record that spans lines.
  let separator: string | undefined;
  const firstLines: Array<{ line: number; text: string }> = [];
  let open: { fields: string[]; field: string; line: number; lines: number } | undefined;

  const isWanted = (number: number, title: string): boolean => {
    if (wantedTable === undefined || wantedTable === "") return number === 1;
    const given = String(wantedTable).trim();
    if (/^\d+$/.test(given)) return Number(given) === number;
    const name = valueKey(given.replace(/^sheet\s*\d*\s*:?\s*/i, ""));
    return valueKey(title) === name || valueKey(title).includes(name) && name.length >= 3;
  };

  const resolve = (row: string[]) => {
    header = row.map((cell, index) => cell || (letters ? columnLetter(index + 1) : `Column ${index + 1}`));
    const columns = header;
    filters = (request.filters ?? []).map((filter) => {
      if (!FILTER_OPS.includes(filter.op)) throw new Error(`A filter's op must be one of ${FILTER_OPS.map((op) => `"${op}"`).join(", ")}.`);
      const value = filter.value === undefined || filter.value === null ? "" : String(filter.value);
      if (value === "" && filter.op !== "empty" && filter.op !== "not_empty" && filter.op !== "=" && filter.op !== "!=") throw new Error(`The filter on ${JSON.stringify(filter.column)} needs a value.`);
      return { column: columnOf(columns, String(filter.column ?? ""), letters), op: filter.op, value, number: parseNumber(value), key: valueKey(value) };
    });
    groupColumns = (request.groupBy ?? []).map((name) => columnOf(columns, String(name), letters));
    metrics = metricsGiven.map((given) => {
      const text = String(given).trim();
      const [rawOp, ...rest] = text.split(":");
      const op = (rawOp ?? "").trim().toLowerCase() as AggregateOp;
      if (!AGGREGATE_OPS.includes(op)) throw new Error(`A metric must be "count", or one of ${AGGREGATE_OPS.filter((name) => name !== "count").map((name) => `"${name}:<column>"`).join(", ")}.`);
      const columnName = rest.join(":").trim();
      if (op === "count") return { name: "count", op };
      if (!columnName) throw new Error(`The metric "${op}" needs a column: "${op}:<column>".`);
      const column = columnOf(columns, columnName, letters);
      return { name: `${op}:${column.name}`, op, column };
    });
    notNumbers = metrics.map(() => 0);
  };

  const groupValue = (cell: string, column: ColumnRef): string => {
    if (!column.datePart) return cell;
    const date = ISO_DATE.exec(cell.trim());
    if (!date) return cell;
    return column.datePart === "year" ? date[1]! : column.datePart === "month" ? `${date[1]}-${date[2]}` : `${date[1]}-${date[2]}-${date[3]}`;
  };

  /** Whether a row holds a value that is a number: a row of data. A year (1900-2100) in a header row is a name, not data. */
  const hasNumber = (row: string[], first: boolean) => row.some((cell) => {
    const number = parseNumber(cell);
    return number !== undefined && !(first && Number.isInteger(number) && number >= 1900 && number <= 2100 && /^\d{4}$/.test(cell.trim()));
  });
  const filled = (row: string[]) => row.filter((cell) => cell.trim() !== "").length;

  /**
   * Decides the header from the first rows of the table, and reads the rest as data:
   * - a first row with one value over a table of more (a title, "Sales 2026") is left out;
   * - a CSV file has one header row;
   * - a sheet or a `| cell |` table has as header the rows above its first row with a number, up
   *   to 3 (a header of two rows: "Q1" over "January | February"); a first row with numbers means
   *   no header. The header rows are joined column by column with " / ", a header cell left empty
   *   by a merged cell taking the one to its left.
   * `header_rows` says it outright.
   */
  const decideHeader = () => {
    let start = 0;
    if (pending.length > 1 && filled(pending[0]!.row) === 1 && filled(pending[1]!.row) > 1) {
      title = pending[0]!.row.find((cell) => cell.trim() !== "")!.trim();
      start = 1;
    }
    if (request.headerRows !== undefined) {
      headerCount = Math.min(5, Math.max(0, Math.trunc(request.headerRows)));
    } else if (kind === "csv") {
      headerCount = 1;
    } else {
      const firstData = pending.findIndex((entry, index) => index >= start && hasNumber(entry.row, index === start));
      headerCount = firstData === -1 ? 1 : Math.min(3, firstData - start);
    }
    headerCount = Math.min(headerCount, pending.length - start);
    const rows = pending.slice(start, start + headerCount).map((entry) => entry.row);
    if (rows.length === 0) {
      letters = kind === "sheets";
      resolve((pending[start]?.row ?? []).map(() => ""));
    } else {
      const width = Math.max(...rows.map((row) => row.length));
      const upper = rows.slice(0, -1).map((row) => {
        let left = "";
        return Array.from({ length: width }, (_, index) => {
          const cell = (row[index] ?? "").trim();
          if (cell) left = cell;
          return cell || left;
        });
      });
      const names = Array.from({ length: width }, (_, index) => {
        const parts = [...upper.map((row) => row[index]!), (rows.at(-1)![index] ?? "").trim()].filter(Boolean);
        return [...new Set(parts)].join(" / ");
      });
      headerLine = pending[start + headerCount - 1]!.line;
      lastHeaderKey = rows.at(-1)!.map(valueKey).join("\u0000");
      resolve(names);
    }
    const rest = pending.splice(0).slice(start + headerCount);
    for (const entry of rest) addRow(entry.row, entry.line);
  };

  const addRow = (row: string[], line: number) => {
    if (!header) {
      pending.push({ row, line });
      // The header is known once a row of data is seen, or enough rows are held to say there is none.
      if ((kind !== "csv" && hasNumber(row, pending.length === 1)) || kind === "csv" || pending.length >= 20 || request.headerRows !== undefined) {
        if (kind === "csv" && pending.length < 2 && request.headerRows === undefined) return;
        decideHeader();
      }
      return;
    }
    // A header repeated inside the table (on each page of a PDF) is not a row.
    if (lastHeaderKey !== undefined && row.map(valueKey).join("\u0000") === lastHeaderKey) {
      repeatedHeaders++;
      return;
    }
    // A value past the header's columns, or a CSV record of another length: the table is not as its header says.
    if (row.slice(header.length).some((cell) => cell !== "") || (kind === "csv" && row.length !== header.length)) irregularRows++;
    rowsRead++;
    const cell = (column: ColumnRef) => row[column.index] ?? "";
    for (const filter of filters) if (!compare(cell(filter.column), filter)) return;
    rowsMatched++;
    const values = groupColumns.map((column) => groupValue(cell(column), column));
    const key = values.map(valueKey).join("\u0000");
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= MAX_AGGREGATE_GROUPS) {
        otherRows++;
        return;
      }
      group = {
        key: Object.fromEntries(groupColumns.map((column, index) => [column.datePart ? `${column.name}:${column.datePart}` : column.name, values[index]!])),
        count: 0,
        sums: metrics.map(() => 0),
        numbers: metrics.map(() => 0),
        minimums: metrics.map(() => undefined),
        maximums: metrics.map(() => undefined),
        distinct: metrics.map((metric) => (metric.op === "count_distinct" ? new Set<string>() : undefined)),
        lines: [],
      };
      groups.set(key, group);
    }
    group.count++;
    if (group.lines.length < CITED_LINES) group.lines.push(line);
    metrics.forEach((metric, index) => {
      if (!metric.column) return;
      const raw = cell(metric.column);
      if (metric.op === "count_distinct") {
        const distinct = group!.distinct[index]!;
        if (raw.trim() && distinct.size < MAX_AGGREGATE_GROUPS) distinct.add(valueKey(raw));
        return;
      }
      if (!raw.trim()) return;
      const number = parseNumber(raw);
      if (number === undefined) {
        // min and max of dates (or of any text) compare as text; sums and averages need numbers.
        if ((metric.op === "min" || metric.op === "max") && ISO_DATE.test(raw.trim())) {
          const current = metric.op === "min" ? group!.minimums[index] : group!.maximums[index];
          const text = raw.trim();
          if (current === undefined || (typeof current === "string" && (metric.op === "min" ? text < current : text > current))) {
            if (metric.op === "min") group!.minimums[index] = text;
            else group!.maximums[index] = text;
          }
          return;
        }
        notNumbers[index]!++;
        return;
      }
      group!.sums[index]! += number;
      group!.numbers[index]!++;
      const minimum = group!.minimums[index];
      const maximum = group!.maximums[index];
      if (minimum === undefined || (typeof minimum === "number" && number < minimum)) group!.minimums[index] = number;
      if (maximum === undefined || (typeof maximum === "number" && number > maximum)) group!.maximums[index] = number;
    });
  };

  // Every table is gone through, to count them; only the one asked for is read.
  const pipeLine = (text: string, line: number) => {
    const trimmed = text.trim();
    const isRow = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
    if (!isRow) {
      inPipeTable = false;
      chosen = false;
      return;
    }
    if (!inPipeTable) {
      inPipeTable = true;
      tableNumber++;
      chosen = !header && isWanted(tableNumber, `table ${tableNumber}`);
      if (chosen) chosenTitle = `table ${tableNumber}`;
    }
    if (!chosen || SEPARATOR_ROW.test(trimmed)) return;
    addRow(pipeCells(trimmed), line);
  };

  const sheetLine = (text: string, line: number) => {
    const sheet = /^## Sheet (\d+): (.*?)(?: \(hidden sheet\))?$/.exec(text);
    if (sheet) {
      tableNumber = Number(sheet[1]);
      tableTitle = `Sheet ${tableNumber}: ${sheet[2]}`;
      chosen = !header && isWanted(tableNumber, sheet[2]!);
      if (chosen) chosenTitle = tableTitle;
      return;
    }
    if (!chosen) return;
    const row = /^Row (\d+): (\|.*\|)\s*$/.exec(text);
    if (row) addRow(pipeCells(row[2]!), line);
  };

  const csvLine = (text: string, line: number) => {
    if (separator === undefined) {
      if (text.trim()) firstLines.push({ line, text });
      if (firstLines.length < 20) return;
      startCsv();
      return;
    }
    readCsv(text, line);
  };
  const startCsv = () => {
    separator = csvSeparator(firstLines.map((entry) => entry.text));
    tableNumber = 1;
    chosenTitle = "the CSV file";
    chosen = true;
    for (const entry of firstLines.splice(0)) readCsv(entry.text, entry.line);
  };
  const readCsv = (text: string, line: number) => {
    if (open) {
      const split = splitCsvLine(text, separator!, open);
      if (split.open && open.lines < MAX_RECORD_LINES) {
        open = { fields: split.fields, field: split.field, line: open.line, lines: open.lines + 1 };
        return;
      }
      const started = open.line;
      open = undefined;
      addRow(split.fields, started);
      return;
    }
    if (!text.trim()) return;
    const split = splitCsvLine(text, separator!);
    if (split.open) {
      open = { fields: split.fields, field: split.field, line, lines: 1 };
      return;
    }
    addRow(split.fields, line);
  };

  const feedLine = kind === "csv" ? csvLine : kind === "sheets" ? sheetLine : pipeLine;
  await scanSource(source, (chunk) => {
    const count = chunk.lines.lineCount;
    for (let local = 1; local <= count; local++) feedLine(chunk.lines.line(local), chunk.firstLine + local - 1);
  }, signal);
  if (kind === "csv" && separator === undefined && firstLines.length > 0) startCsv();
  if (kind === "csv" && open) {
    const started = open.line;
    const fields = [...open.fields, open.field];
    open = undefined;
    addRow(fields, started);
  }
  // A table that ended before its header was decided (no row of data, fewer than 20 rows).
  if (!header && pending.length > 0) decideHeader();
  if (!header) {
    if (tableNumber === 0) throw new Error("This file has no table to aggregate: aggregate_table reads CSV and TSV files, Excel sheets, and tables written as | cell | cell | rows. Use search_document instead.");
    throw new Error(wantedTable !== undefined
      ? `No table ${JSON.stringify(String(wantedTable))} in this file: it has ${tableNumber} ${kind === "sheets" ? (tableNumber === 1 ? "sheet" : "sheets") : tableNumber === 1 ? "table" : "tables"}. Name a sheet or give a number from 1 to ${tableNumber}.`
      : "The table is empty.");
  }
  const results: AggregateGroup[] = [...groups.values()].map((group) => ({
    key: group.key,
    count: group.count,
    values: Object.fromEntries(metrics.map((metric, index) => {
      if (metric.op === "count") return [metric.name, group.count];
      if (metric.op === "count_distinct") return [metric.name, group.distinct[index]!.size];
      if (metric.op === "sum") return [metric.name, group.numbers[index]! > 0 ? tidy(group.sums[index]!) : null];
      if (metric.op === "avg") return [metric.name, group.numbers[index]! > 0 ? tidy(group.sums[index]! / group.numbers[index]!) : null];
      const extreme = metric.op === "min" ? group.minimums[index] : group.maximums[index];
      return [metric.name, extreme === undefined ? null : typeof extreme === "number" ? tidy(extreme) : extreme];
    })),
    lines: group.lines,
  }));
  const first = metrics[0]!;
  const valueOf = (group: AggregateGroup) => {
    const value = group.values[first.name];
    return typeof value === "number" ? value : Number.NEGATIVE_INFINITY;
  };
  if (request.orderBy === "key") {
    results.sort((left, right) => compareKeys(Object.values(left.key), Object.values(right.key)));
  } else {
    results.sort((left, right) => valueOf(right) - valueOf(left) || (left.lines[0] ?? 0) - (right.lines[0] ?? 0));
  }
  return {
    table: kind === "pipes" ? `${chosenTitle} of ${tableNumber}` : chosenTitle,
    tables: tableNumber,
    columns: header,
    headerLine,
    rowsRead,
    rowsMatched,
    groups: results.slice(0, limit),
    totalGroups: groups.size,
    otherRows,
    headerRows: headerCount,
    ...(title !== undefined ? { title } : {}),
    repeatedHeaders,
    irregularRows,
    notNumbers: Object.fromEntries(metrics.flatMap((metric, index) => (notNumbers[index]! > 0 && (metric.op === "sum" || metric.op === "avg" || metric.op === "min" || metric.op === "max") ? [[metric.name, notNumbers[index]!]] : []))),
  };
}

/** Group keys in order: numbers as numbers, the rest as text. */
function compareKeys(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? "";
    const b = right[index] ?? "";
    const x = parseNumber(a);
    const y = parseNumber(b);
    const order = x !== undefined && y !== undefined ? x - y : valueKey(a) < valueKey(b) ? -1 : valueKey(a) > valueKey(b) ? 1 : 0;
    if (order !== 0) return order;
  }
  return 0;
}

/** The letters of a column number: 1 is A, 27 is AA. */
function columnLetter(column: number): string {
  let name = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  return name;
}
