import { officeReader, openOffice, type OfficeParts } from "./office.js";
import { sliceWhole, wellFormed } from "./text.js";
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
 * as `=` and the formula); a date as 2026-11-10 (with the time when it has one), an elapsed time
 * as its hours in total (36:00), a percentage as 12.5%, a number as Excel stores it, to 15
 * significant digits. Empty rows are left out. Nothing is cut short: every row of every sheet is
 * written, within the limits on text that every file has.
 */

/** The shared strings of a workbook, at most: Excel's rows (1,048,576) times two. */
const MAX_SHARED_STRINGS = 2_097_152;
/** Columns of a sheet listed in its `Columns:` line, at most: past it, the line gives the range. */
const MAX_LISTED_COLUMNS = 52;
/** A sheet's name is kept up to this many characters. */
const MAX_SHEET_NAME = 100;
/** The longest part name looked up: no part of a workbook has a name near it. */
const MAX_PART_NAME = 1_024;
/** Excel's last date, 9999-12-31, as a serial. */
const LAST_SERIAL = 2_958_465.99999;
/** Excel's last column, XFD. */
const MAX_COLUMN = 16_384;
/** Written under the heading of a sheet with no value. */
const NO_VALUES = "[No values on this sheet]";

/** Number formats Excel has built in that show a date, a time, or both. */
const BUILT_IN_DATES = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILT_IN_TIMES = new Set([18, 19, 20, 21, 32, 33, 45, 47, 55, 56]);
/** Built-in format 46 is `[h]:mm:ss`: the hours elapsed, past 24. */
const BUILT_IN_DURATIONS = new Set([46]);
const BUILT_IN_PERCENT = new Set([9, 10]);

type ValueKind = "date" | "time" | "duration" | "percent" | "number";

/** What a number format shows, from its code: a date, a time of day, an elapsed time, a percentage, or a number. */
export function formatKind(code: string): ValueKind {
  // Quoted text, escaped characters, colours and locales ([Red], [$-409]) hold no date part; the
  // brackets of elapsed time ([h], [mm], [ss]) are kept. A format of Excel has at most 255
  // characters; a bracket body stops at the next bracket, so an unclosed "[" costs no scan to the
  // end of the code.
  const bare = code.slice(0, 255).replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?!(?:h+|m+|s+)\])[^[\]]*\]/gi, "").toLowerCase();
  if (bare === "general" || bare === "") return "number";
  // Hours, minutes or seconds in total, which go on past a day: 1.5 is 36 hours, not a date.
  if (/\[(?:h+|m+|s+)\]/.test(bare)) return "duration";
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
  // Rounded to the second first, then split into days and seconds: 23:59:59.6 is the next day's 00:00.
  const total = Math.round(serial * 86_400);
  const whole = Math.floor(total / 86_400);
  const seconds = total - whole * 86_400;
  const time = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}${seconds % 60 !== 0 ? `:${pad(seconds % 60)}` : ""}`;
  // A time of day alone, as a format that shows no date writes it: 23:59:59.7 rounds to 00:00. So
  // is what float arithmetic leaves of a difference of equal times (-1.1e-16): it rounds to day 0.
  if (kind === "time" && (whole === 0 || Math.floor(serial) === 0)) return whole === 0 ? time : "00:00";
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, whole >= 61 ? 30 : 31);
  const date = new Date(base + whole * 86_400_000);
  if (Number.isNaN(date.getTime())) return String(serial);
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return seconds === 0 && kind === "date" ? day : `${day} ${time}`;
}

/**
 * An elapsed time, as a format of `[h]`, `[m]` or `[s]` shows it: its hours in total, and no date,
 * so 1.5 days is 36:00. As a time of day, it is rounded to the second, and its seconds are written
 * when there are some.
 */
function excelDuration(serial: number): string {
  // Past Excel's last day (9999-12-31) a duration is a number Excel cannot show: written as it is.
  if (!Number.isFinite(serial) || Math.abs(serial) > LAST_SERIAL) return numberText(serial);
  const total = Math.round(Math.abs(serial) * 86_400);
  const seconds = total % 60;
  return `${serial < 0 && total > 0 ? "-" : ""}${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}${seconds !== 0 ? `:${pad(seconds)}` : ""}`;
}

/**
 * Excel writes a character that XML cannot hold as `_xHHHH_`: a carriage return of pasted text is
 * `_x000D_`. An underscore that would start such an escape is written `_x005F_`, so the text
 * `_x0041_` is `_x005F_x0041_`; read from left to right, each comes back as it was.
 */
function decodeEscapes(text: string): string {
  let at = text.indexOf("_x");
  if (at === -1) return text;
  // One pass with indexOf and slices: a replace with a callback kept a string and its parts for
  // each of millions of escapes, and a 405 KB workbook took 890 MB.
  const pieces: string[] = [];
  let kept = 0;
  let halves = false;
  for (; at !== -1; at = text.indexOf("_x", at + 1)) {
    if (at < kept || text.charCodeAt(at + 6) !== 95 || !HEX4.test(text.slice(at + 2, at + 6))) continue;
    const code = Number.parseInt(text.slice(at + 2, at + 6), 16);
    if (code >= 0xd800 && code <= 0xdfff) halves = true;
    pieces.push(text.slice(kept, at), String.fromCharCode(code));
    kept = at + 7;
    at = kept - 1;
  }
  if (pieces.length === 0) return text;
  pieces.push(text.slice(kept));
  // Two escapes make a character outside the basic plane ("_xD83D__xDE00_"). Half of one alone
  // is not a character: U+FFFD, as for a character reference to it (`decodeEntities`).
  return halves ? wellFormed(pieces.join("")) : pieces.join("");
}

const HEX4 = /^[0-9A-Fa-f]{4}$/;

/**
 * The text of a cell as a cell of a `| cell | cell |` row: on one line, its pipes escaped, as the
 * tables of other files are written. Only white space that changes is matched (a run of it, a tab,
 * a line break): the single spaces between words, most of a text, are not each replaced.
 */
function cellText(text: string): string {
  return text.replace(/\s{2,}|[^\S ]/g, " ").replace(/\|/g, "\\|").trim();
}

/** A number as Excel stores it, to the 15 significant digits Excel keeps: 0.30000000000000004 is 0.3. */
function numberText(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number.parseFloat(value.toPrecision(15)));
}

/**
 * What a workbook says of itself: its sheets in order, the part of its shared strings, the 1904
 * date system, and how each cell style shows a number.
 */
type Workbook = {
  sheets: Array<{ name: string; part: string; hidden: boolean }>;
  sharedStrings: string | undefined;
  date1904: boolean;
  /** The kind of value each cell style (`s`) shows, by its index. */
  styles: ValueKind[];
};

/**
 * The kind of sheet a relationship of the workbook names, at the end of its type. Only a worksheet
 * holds cells of data: a chart sheet, a dialog sheet or a macro sheet does not.
 */
const SHEET_KIND = /\/(worksheet|chartsheet|dialogsheet|xlMacrosheet|xlIntlMacrosheet)$/i;

async function readWorkbook(read: OfficeParts, names: string[]): Promise<Workbook> {
  const workbookXml = await read.small("xl/workbook.xml");
  if (!workbookXml) throw new Error("This XLSX does not contain xl/workbook.xml.");
  const relationships = readRelationships(await read.small("xl/_rels/workbook.xml.rels"), "xl");
  // Letter case does not count in the names of the parts of a package, as it does in a ZIP: a
  // relationship to worksheets/Sheet1.xml names the part xl/worksheets/sheet1.xml.
  const parts = new Set(names);
  let byLowerCase: Map<string, string> | undefined;
  /** Each relationship's part, worked out once: a workbook can name one relationship in 400,000 sheets. */
  const resolved = new Map<string, string | undefined>();
  const partOf = (target: string): string | undefined => {
    if (parts.has(target)) return target;
    if (resolved.has(target)) return resolved.get(target);
    byLowerCase ??= new Map(names.map((name) => [name.toLowerCase(), name]));
    const part = target.length > MAX_PART_NAME ? undefined : byLowerCase.get(target.toLowerCase());
    resolved.set(target, part);
    return part;
  };
  /** The part that a relationship of this type names, or else the part where Excel puts it, when the file has it. */
  const related = (type: string, usual: string): string | undefined => {
    for (const relationship of relationships.values()) {
      const part = !relationship.external && relationship.type.endsWith(`/${type}`) ? partOf(relationship.target) : undefined;
      if (part) return part;
    }
    return partOf(usual);
  };
  const sheets: Workbook["sheets"] = [];
  const listed = new Set<string>();
  let date1904 = false;
  readXml(workbookXml, {
    open(name, attributes) {
      if (name === "workbookPr" || name.endsWith(":workbookPr")) date1904 = attributes.date1904 === "1" || attributes.date1904 === "true";
      if (name !== "sheet" && !name.endsWith(":sheet")) return;
      const id = attributes["r:id"] ?? Object.entries(attributes).find(([key]) => key.endsWith(":id"))?.[1];
      const relationship = id ? relationships.get(id) : undefined;
      // A sheet whose part is missing has nothing to read.
      const part = relationship && !relationship.external ? partOf(relationship.target) : undefined;
      if (!relationship || !part) return;
      // The type of the relationship tells a worksheet, wherever its part is, from a chart sheet,
      // which has no cells. A relationship that names no kind of sheet is told by the folder that
      // Excel puts worksheets in.
      const kind = SHEET_KIND.exec(relationship.type)?.[1];
      if (kind ? kind.toLowerCase() !== "worksheet" : !/worksheets\//i.test(part)) return;
      // A part listed again is not read again: a workbook can list one sheet 300,000 times.
      if (listed.has(part)) return;
      listed.add(part);
      // Excel's names have at most 31 characters, LibreOffice's a few more: a name of thousands is cut.
      sheets.push({ name: sliceWhole(decodeEscapes(attributes.name ?? `Sheet ${sheets.length + 1}`), MAX_SHEET_NAME), part, hidden: attributes.state === "hidden" || attributes.state === "veryHidden" });
    },
  });
  const styles = related("styles", "xl/styles.xml");
  return { sheets, sharedStrings: related("sharedStrings", "xl/sharedStrings.xml"), date1904, styles: readCellStyles(styles ? await read.small(styles) : undefined) };
}

/** The kind of value each cell style shows, from the number format it names. */
function readCellStyles(xml: string | undefined): ValueKind[] {
  if (!xml) return [];
  /** The kind of each custom format, worked out once: a workbook may name one in thousands of styles. */
  const custom = new Map<number, ValueKind>();
  const styles: ValueKind[] = [];
  let inCellStyles = false;
  readXml(xml, {
    open(name, attributes) {
      const local = name.slice(name.indexOf(":") + 1);
      if (local === "numFmt") custom.set(Number(attributes.numFmtId), formatKind(attributes.formatCode ?? ""));
      else if (local === "cellXfs") inCellStyles = true;
      else if (inCellStyles && local === "xf") {
        const id = Number(attributes.numFmtId ?? 0);
        const kind = custom.get(id);
        styles.push(kind !== undefined ? kind
          : BUILT_IN_DATES.has(id) ? "date"
            : BUILT_IN_TIMES.has(id) ? "time"
              : BUILT_IN_DURATIONS.has(id) ? "duration"
                : BUILT_IN_PERCENT.has(id) ? "percent" : "number");
      }
    },
    close(name) {
      if (name.slice(name.indexOf(":") + 1) === "cellXfs") inCellStyles = false;
    },
  });
  return styles;
}

/**
 * The shared strings of a workbook, read a piece at a time; the text of phonetic runs (`rPh`) is
 * left out. Each is kept as a cell is written (`cellText`), made so once: a row can name one string
 * thousands of times.
 */
async function readSharedStrings(read: OfficeParts, part: string): Promise<string[]> {
  const strings: string[] = [];
  let current: string[] | undefined;
  let inText = false;
  let inPhonetic = 0;
  let characters = 0;
  const xml = new XmlStream({
    open(name, _attributes, empty) {
      const local = name.slice(name.indexOf(":") + 1);
      if (local === "si" && !empty) current = [];
      else if (local === "si") {
        if (strings.length >= MAX_SHARED_STRINGS) throw new Error(`This XLSX has more than ${MAX_SHARED_STRINGS.toLocaleString("en-US")} different texts, more than a workbook holds. It may be built to exhaust the server, so it is not read.`);
        strings.push("");
      }
      else if (local === "rPh" && !empty) inPhonetic++;
      else if (local === "t" && !empty) inText = true;
    },
    close(name) {
      const local = name.slice(name.indexOf(":") + 1);
      if (local === "t") inText = false;
      else if (local === "rPh" && inPhonetic > 0) inPhonetic--;
      else if (local === "si" && current) {
        if (strings.length >= MAX_SHARED_STRINGS) throw new Error(`This XLSX has more than ${MAX_SHARED_STRINGS.toLocaleString("en-US")} different texts, more than a workbook holds. It may be built to exhaust the server, so it is not read.`);
        const text = cellText(decodeEscapes(current.join("")));
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
  await read.stream(part, (piece) => xml.write(piece));
  return strings;
}

/** A cell as it is read: its type (`t`), style (`s`), cached value and formula. */
type CellReading = { column: number; type: string; style: number; value: string[]; formula: string[]; inline: string[] };

/**
 * Reads the rows of one sheet, a piece at a time, and gives each line of its section to `line`:
 * the `Columns:` line first (from the sheet's `dimension`, when it has one), then a line per row
 * that has a value. `holding` is told, as the row grows, how many characters the row being read
 * holds, to refuse it before it ends.
 */
function sheetReader(workbook: Workbook, strings: string[], line: (text: string) => void, holding: (characters: number) => void): XmlStream {
  let firstColumn = 1;
  let wroteColumns = false;
  let row: Map<number, string> | undefined;
  let rowNumber = 0;
  /** The characters of the row being read: the text of its cells in the XML, and the shared strings they name. */
  let held = 0;
  const hold = (characters: number) => {
    held += characters;
    holding(held);
  };
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
  /** The value of a cell other than a shared string, as Excel shows it. */
  const valueOf = (reading: CellReading): string => {
    const raw = reading.value.join("");
    switch (reading.type) {
      case "inlineStr": return decodeEscapes(reading.inline.join(""));
      case "str": return decodeEscapes(raw);
      case "b": return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
      case "e": return raw;
      case "d": return raw.replace("T", " ").replace(/(?::00)?(?:\.0+)?Z?$/, "");
    }
    if (raw === "") {
      const formula = reading.formula.join("");
      return formula ? `=${decodeEscapes(formula)}` : "";
    }
    const number = Number(raw);
    if (!Number.isFinite(number)) return raw;
    const kind = workbook.styles[reading.style] ?? "number";
    if (kind === "date" || kind === "time") return excelDate(number, kind, workbook.date1904);
    if (kind === "duration") return excelDuration(number);
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
        held = 0;
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
        let text: string;
        if (cell.type === "s") {
          // A shared string counts at its length each time a cell names it, before the row keeps
          // it: in a few bytes each, one row can name a string of a million characters thousands
          // of times. It was made a cell's text when it was read, and is kept, not copied.
          // The cell names it by its number, in digits. A cell without one (`<c t="s"></c>`, an
          // empty `<v>`) is empty: read as a number, no digits are 0, the first string.
          const index = cell.value.join("").trim();
          text = /^\d+$/.test(index) ? strings[Number(index)] ?? "" : "";
          hold(text.length);
        } else {
          text = cellText(valueOf(cell));
        }
        if (text !== "") row.set(cell.column, text);
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
      hold(text.length);
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
  const workbook = await readWorkbook(read, Object.keys(archive.files));
  if (workbook.sheets.length === 0) throw new Error("This XLSX does not contain any sheets with cells.");
  const strings = workbook.sharedStrings ? await readSharedStrings(read, workbook.sharedStrings) : [];
  const sections: string[] = [];
  const tooMuch = () => new Error(read.limits.byTextLimit
    ? "This XLSX holds more text than is kept from one file. Split it, and attach the part you need."
    : "This XLSX holds more text than is read from one file. Split it, and attach the part you need.");
  /** Counts a line of the text kept, and refuses the file past the limit. */
  const kept = (text: string) => {
    read.count.characters += text.length + 1;
    if (read.count.characters > read.limits.maxCharacters) throw tooMuch();
  };
  for (const [index, sheet] of workbook.sheets.entries()) {
    // The heading is text kept, as a row is: a workbook can have thousands of empty sheets.
    const heading = `## Sheet ${index + 1}: ${sheet.name.replace(/\s+/g, " ")}${sheet.hidden ? " (hidden sheet)" : ""}`;
    kept(heading);
    const lines: string[] = [];
    const reader = sheetReader(workbook, strings, (text) => {
      kept(text);
      lines.push(text);
    }, (characters) => {
      if (read.count.characters + characters > read.limits.maxCharacters) throw tooMuch();
    });
    await read.stream(sheet.part, (piece) => reader.write(piece));
    // A sheet with no value says so, rather than leaving its heading alone, or with its columns.
    if (!lines.some((text) => text.startsWith("Row "))) {
      for (const text of lines) read.count.characters -= text.length + 1;
      lines.length = 0;
      lines.push(NO_VALUES);
      kept(NO_VALUES);
    }
    sections.push(`${heading}\n${lines.join("\n")}`);
    input?.onProgress?.({ done: index + 1, total: workbook.sheets.length, unit: "parts" });
  }
  return { text: sections.join("\n\n"), pages: workbook.sheets.length };
};

/** `decodeEscapes`, for tests. */
export const decodeEscapesForTest = decodeEscapes;
