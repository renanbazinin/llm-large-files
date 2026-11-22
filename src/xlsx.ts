import { officeReader, openOffice, type OfficeParts } from "./office.js";
import type { Extractor } from "./types.js";
import { readRelationships, readXml, XmlStream, type XmlAttributes } from "./xml-stream.js";

/**
 * Excel workbooks (XLSX, XLSM). Each sheet, in the order of the workbook, is a section:
 *
 *     ## Sheet 1: Sales
 *     Columns: | A | B | C |
 *     Row 1: | Region | Q1 | Q2 |
 *     Row 2: | East | 1200 | 1350.5 |
 *
 * A row is written with its number in the sheet, so an answer can name the row a person finds in
 * Excel, and as `| cell | cell |`, its empty cells kept up to its last value, as tables of other
 * files are. A cell holds the value Excel last computed for it (a formula without one is written
 * as `=` and the formula); a date as 2026-11-10 (with the time when it has one), a percentage as
 * 12.5%, a number as Excel stores it, to 15 significant digits. Empty rows are left out. Nothing is
 * cut short: every row of every sheet is written, within the limits on text that every file has.
 */

/** The shared strings of a workbook, at most: Excel's rows (1,048,576) times two. */
const MAX_SHARED_STRINGS = 2_097_152;
/** Columns of a sheet listed in its `Columns:` line, at most: past it, the line gives the range. */
const MAX_LISTED_COLUMNS = 52;
/** Excel's last column, XFD. */
const MAX_COLUMN = 16_384;

/** Number formats Excel has built in that show a date, a time, or both. */
const BUILT_IN_DATES = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILT_IN_TIMES = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);
const BUILT_IN_PERCENT = new Set([9, 10]);

type ValueKind = "date" | "time" | "percent" | "number";

/** What a number format shows, from its code: a date, a time, a percentage, or a number. */
export function formatKind(code: string): ValueKind {
  // Quoted text, escaped characters, colours and locales ([Red], [$-409]) hold no date part.
  const bare = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, "").toLowerCase();
  if (bare === "general" || bare === "") return "number";
  if (/[yd]/.test(bare) || /(^|[^a-z])m{3,}/.test(bare)) return "date";
  if (/[hs]/.test(bare)) return "time";
  if (bare.includes("%")) return "percent";
  return "number";
}

/** The letters of a column number: 1 is A, 27 is AA. */
export function columnName(column: number): string {
  let name = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  return name;
}

/** The column and row of a cell reference ("AB12"), or undefined. */
function cellAt(reference: string | undefined): { column: number; row: number } | undefined {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(reference ?? "");
  if (!match) return undefined;
  let column = 0;
  for (const letter of match[1]!.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * An Excel date serial as text. In the 1900 date system Excel counts 29 February 1900, which did
 * not exist, so serials from 61 on are one day off a plain count from 30 December 1899. In the
 * 1904 system (`date1904`) days count from 1 January 1904.
 */
export function excelDate(serial: number, kind: "date" | "time", date1904 = false): string {
  const days = Math.floor(serial);
  let milliseconds = Math.round((serial - days) * 86_400_000);
  let whole = days;
  if (milliseconds >= 86_400_000) {
    whole++;
    milliseconds -= 86_400_000;
  }
  const seconds = Math.round(milliseconds / 1_000);
  const time = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}${seconds % 60 !== 0 ? `:${pad(seconds % 60)}` : ""}`;
  // A time of day alone, as a format that shows no date writes it.
  if (kind === "time" && whole === 0) return time;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, whole >= 61 ? 30 : 31);
  const date = new Date(base + whole * 86_400_000);
  if (Number.isNaN(date.getTime())) return String(serial);
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return seconds === 0 && kind === "date" ? day : `${day} ${time}`;
}

/** A number as Excel stores it, to the 15 significant digits Excel keeps: 0.30000000000000004 is 0.3. */
function numberText(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number.parseFloat(value.toPrecision(15)));
}

/** What a workbook says of itself: its sheets in order, the 1904 date system, and how each cell style shows a number. */
type Workbook = {
  sheets: Array<{ name: string; part: string; hidden: boolean }>;
  date1904: boolean;
  /** The kind of value each cell style (`s`) shows, by its index. */
  styles: ValueKind[];
};

async function readWorkbook(read: OfficeParts, parts: Set<string>): Promise<Workbook> {
  const workbookXml = await read.small("xl/workbook.xml");
  if (!workbookXml) throw new Error("This XLSX does not contain xl/workbook.xml.");
  const relationships = readRelationships(await read.small("xl/_rels/workbook.xml.rels"), "xl");
  const sheets: Workbook["sheets"] = [];
  let date1904 = false;
  readXml(workbookXml, {
    open(name, attributes) {
      if (name === "workbookPr" || name.endsWith(":workbookPr")) date1904 = attributes.date1904 === "1" || attributes.date1904 === "true";
      if (name !== "sheet" && !name.endsWith(":sheet")) return;
      const id = attributes["r:id"] ?? Object.entries(attributes).find(([key]) => key.endsWith(":id"))?.[1];
      const part = id ? relationships.get(id)?.target : undefined;
      // A chart sheet has no cells; a sheet whose part is missing has nothing to read.
      if (!part || !parts.has(part) || !/worksheets\//i.test(part)) return;
      sheets.push({ name: attributes.name ?? `Sheet ${sheets.length + 1}`, part, hidden: attributes.state === "hidden" || attributes.state === "veryHidden" });
    },
  });
  return { sheets, date1904, styles: readCellStyles(await read.small("xl/styles.xml")) };
}

/** The kind of value each cell style shows, from the number format it names. */
function readCellStyles(xml: string | undefined): ValueKind[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  const styles: ValueKind[] = [];
  let inCellStyles = false;
  readXml(xml, {
    open(name, attributes) {
      const local = name.slice(name.indexOf(":") + 1);
      if (local === "numFmt") custom.set(Number(attributes.numFmtId), attributes.formatCode ?? "");
      else if (local === "cellXfs") inCellStyles = true;
      else if (inCellStyles && local === "xf") {
        const id = Number(attributes.numFmtId ?? 0);
        const code = custom.get(id);
        styles.push(code !== undefined ? formatKind(code)
          : BUILT_IN_DATES.has(id) ? "date"
            : BUILT_IN_TIMES.has(id) ? "time"
              : BUILT_IN_PERCENT.has(id) ? "percent" : "number");
      }
    },
    close(name) {
      if (name.slice(name.indexOf(":") + 1) === "cellXfs") inCellStyles = false;
    },
  });
  return styles;
}

/** The shared strings of a workbook, read a piece at a time; the text of phonetic runs (`rPh`) is left out. */
async function readSharedStrings(read: OfficeParts): Promise<string[]> {
  const strings: string[] = [];
  let current: string[] | undefined;
  let inText = false;
  let inPhonetic = 0;
  let characters = 0;
  const xml = new XmlStream({
    open(name, _attributes, empty) {
      const local = name.slice(name.indexOf(":") + 1);
      if (local === "si" && !empty) current = [];
      else if (local === "si") strings.push("");
      else if (local === "rPh" && !empty) inPhonetic++;
      else if (local === "t" && !empty) inText = true;
    },
    close(name) {
      const local = name.slice(name.indexOf(":") + 1);
      if (local === "t") inText = false;
      else if (local === "rPh" && inPhonetic > 0) inPhonetic--;
      else if (local === "si" && current) {
        if (strings.length >= MAX_SHARED_STRINGS) throw new Error(`This XLSX has more than ${MAX_SHARED_STRINGS.toLocaleString("en-US")} different texts, more than a workbook holds. It may be built to exhaust the server, so it is not read.`);
        const text = current.join("");
        strings.push(text.length < 13 ? text : (" " + text).slice(1));
        current = undefined;
      }
    },
    text(text) {
      if (!current || !inText || inPhonetic > 0) return;
      characters += text.length;
      if (characters > read.limits.maxCharacters) throw new Error("This XLSX holds more text than is kept from one file. Split it, and attach the part you need.");
      current.push(text);
    },
  });
  await read.stream("xl/sharedStrings.xml", (piece) => xml.write(piece));
  return strings;
}

/** A cell as it is read: its type (`t`), style (`s`), cached value and formula. */
type CellReading = { column: number; type: string; style: number; value: string[]; formula: string[]; inline: string[] };

/**
 * Reads the rows of one sheet, a piece at a time, and gives each line of its section to `line`:
 * the `Columns:` line first (from the sheet's `dimension`, when it has one), then a line per row
 * that has a value.
 */
function sheetReader(workbook: Workbook, strings: string[], line: (text: string) => void, held: (characters: number) => void): XmlStream {
  let firstColumn = 1;
  let wroteColumns = false;
  let row: Map<number, string> | undefined;
  let rowNumber = 0;
  let nextColumn = 1;
  let cell: CellReading | undefined;
  /** Which text of the cell is being read: its value, its formula, or the text of an inline string. */
  let reading: "value" | "formula" | "inline" | undefined;
  let inInline = false;
  let inPhonetic = 0;
  const columns = (last: number) => {
    if (wroteColumns) return;
    wroteColumns = true;
    const count = last - firstColumn + 1;
    if (count <= 0) return;
    line(count <= MAX_LISTED_COLUMNS
      ? `Columns: | ${Array.from({ length: count }, (_, index) => columnName(firstColumn + index)).join(" | ")} |`
      : `Columns: ${columnName(firstColumn)} to ${columnName(last)}`);
  };
  const valueOf = (reading: CellReading): string => {
    const raw = reading.value.join("");
    switch (reading.type) {
      case "s": return strings[Number(raw)] ?? "";
      case "inlineStr": return reading.inline.join("");
      case "str": return raw;
      case "b": return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
      case "e": return raw;
      case "d": return raw.replace("T", " ").replace(/(?::00)?(?:\.0+)?Z?$/, "");
    }
    if (raw === "") {
      const formula = reading.formula.join("");
      return formula ? `=${formula}` : "";
    }
    const number = Number(raw);
    if (!Number.isFinite(number)) return raw;
    const kind = workbook.styles[reading.style] ?? "number";
    if (kind === "date" || kind === "time") return excelDate(number, kind, workbook.date1904);
    if (kind === "percent") return `${numberText(number * 100)}%`;
    return numberText(number);
  };
  const local = (name: string) => name.slice(name.indexOf(":") + 1);
  return new XmlStream({
    open(name, attributes: XmlAttributes, empty) {
      const tag = local(name);
      if (tag === "dimension") {
        const [from, to] = (attributes.ref ?? "").split(":");
        const start = cellAt(from);
        const end = cellAt(to ?? from);
        if (start && end && start.column <= end.column && end.column <= MAX_COLUMN) {
          firstColumn = start.column;
          columns(end.column);
        }
      } else if (tag === "row") {
        rowNumber = Number(attributes.r) || rowNumber + 1;
        nextColumn = firstColumn;
        row = new Map();
        if (empty) row = undefined;
      } else if (tag === "c" && row) {
        const at = cellAt(attributes.r);
        const column = at ? at.column : nextColumn;
        nextColumn = column + 1;
        // Past Excel's last column there is no cell: a row of millions of them is not kept.
        cell = empty || column > MAX_COLUMN ? undefined : { column, type: attributes.t ?? "n", style: Number(attributes.s ?? 0), value: [], formula: [], inline: [] };
      } else if (cell) {
        if (tag === "v" && !empty) reading = "value";
        else if (tag === "f" && !empty) reading = "formula";
        else if (tag === "is" && !empty) inInline = true;
        else if (tag === "rPh" && !empty) inPhonetic++;
        else if (tag === "t" && inInline && !empty) reading = "inline";
      }
    },
    close(name) {
      const tag = local(name);
      if (tag === "v" || tag === "f" || tag === "t") {
        reading = undefined;
      } else if (tag === "is") {
        inInline = false;
      } else if (tag === "rPh") {
        if (inPhonetic > 0) inPhonetic--;
      } else if (tag === "c" && cell && row) {
        const text = valueOf(cell);
        if (text !== "") row.set(cell.column, text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
        cell = undefined;
      } else if (tag === "row" && row) {
        if (row.size > 0) {
          if (!wroteColumns) columns(Math.max(...row.keys()));
          let last = 0;
          for (const column of row.keys()) if (column > last) last = column;
          const cells: string[] = [];
          for (let column = Math.min(firstColumn, ...row.keys()); column <= last; column++) cells.push(row.get(column) ?? "");
          line(`Row ${rowNumber}: | ${cells.join(" | ")} |`);
        }
        row = undefined;
      }
    },
    text(text) {
      if (!cell || reading === undefined) return;
      // What a row holds is counted before the row ends: one cell can be megabytes of text.
      held(text.length);
      if (reading === "inline") {
        if (inPhonetic === 0) cell.inline.push(text);
      } else {
        cell[reading].push(text);
      }
    },
  });
}

export const xlsx: Extractor = async (bytes, input) => {
  input?.signal?.throwIfAborted();
  const archive = await openOffice(bytes, "XLSX");
  input?.signal?.throwIfAborted();
  const read = officeReader(archive, "XLSX", bytes.byteLength, input);
  const parts = new Set(Object.keys(archive.files));
  const workbook = await readWorkbook(read, parts);
  if (workbook.sheets.length === 0) throw new Error("This XLSX does not contain any sheets with cells.");
  const strings = parts.has("xl/sharedStrings.xml") ? await readSharedStrings(read) : [];
  const sections: string[] = [];
  const tooMuch = () => new Error(read.limits.byTextLimit
    ? "This XLSX holds more text than is kept from one file. Split it, and attach the part you need."
    : "This XLSX holds more text than is read from one file. Split it, and attach the part you need.");
  for (const [index, sheet] of workbook.sheets.entries()) {
    const lines: string[] = [`## Sheet ${index + 1}: ${sheet.name.replace(/\s+/g, " ")}${sheet.hidden ? " (hidden sheet)" : ""}`];
    const before = lines.length;
    let holding = 0;
    const reader = sheetReader(workbook, strings, (text) => {
      holding = 0;
      read.count.characters += text.length + 1;
      if (read.count.characters > read.limits.maxCharacters) throw tooMuch();
      lines.push(text);
    }, (characters) => {
      holding += characters;
      if (read.count.characters + holding > read.limits.maxCharacters) throw tooMuch();
    });
    await read.stream(sheet.part, (piece) => reader.write(piece));
    // A sheet with no value says so, rather than leaving its heading alone.
    if (!lines.slice(before).some((text) => text.startsWith("Row "))) {
      lines.length = before;
      lines.push("[No values on this sheet]");
    }
    sections.push(lines.join("\n"));
    input?.onProgress?.({ done: index + 1, total: workbook.sheets.length, unit: "parts" });
  }
  return { text: sections.join("\n\n"), pages: workbook.sheets.length };
};
