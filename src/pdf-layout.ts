/**
 * Rebuilds table rows from the position of each piece of text on a PDF page.
 *
 * A PDF has no tables, only text placed at coordinates. Read in file order, a row with an empty
 * cell looks the same as a row without that column, so values slide under the wrong header. This
 * module finds the tables by their geometry and writes each row as `| cell | cell |  | cell |`.
 * Everything that is not a table is left in the order pdf.js gives it.
 *
 * It is conservative on purpose: when the evidence for a table is weak, the text stays as it was.
 */

/** One piece of text as pdf.js reports it (`page.getTextContent().items`). */
export type PdfTextItem = {
  str: string;
  /** `[a, b, c, d, e, f]`: the text matrix in PDF units. `e` and `f` are the position. */
  transform: number[];
  /** Length of the text along its direction, in PDF units. */
  width: number;
  /** Font size, in PDF units. */
  height: number;
  hasEOL?: boolean;
};

type Piece = { index: number; group: number; text: string; x0: number; x1: number; y: number; size: number };
type Segment = { x0: number; x1: number; pieces: Piece[] };
type Line = { y: number; size: number; segments: Segment[] };
type Column = { x0: number; x1: number };
/** grid[line][column]: the pieces of each cell, one line of text at a time. */
type Grid = Piece[][][];
type Table = { indexes: number[]; rows: string[] };

// All distances below are in multiples of the font size.
/** Pieces whose baselines are closer than this are on one line. */
const BASELINE_TOLERANCE = 0.4;
/** A smaller piece of text this close above or below the line is a footnote mark or an index. */
const SCRIPT_TOLERANCE = 0.7;
/** pdf.js keeps words up to this far apart in one piece; a wider gap may be a space or a column. */
const WORD_GAP = 0.6;
/** Pieces closer than this are read as one cell: a bold word, a change of script, a wide space. */
const PIECE_GAP = 0.35;
/** A gap this wide inside one column means the line was laid out on other columns. */
const CELL_GAP = 0.8;
/** A gap that can be seen at all: narrower ones are kerning inside a word. */
const VISIBLE_GAP = 0.1;
/** How close a piece of text must come to a column to count as part of it. */
const COLUMN_TOUCH = 0.25;
/** How close two cells' edges or centres must be to count as lined up, while a table is traced. */
const ROW_ALIGNMENT = 0.3;
/** The tallest step between two lines of one table. */
const ROW_STEP = 4;
/** A step down or up in file order larger than these starts a separate block of text. */
const BLOCK_STEP_DOWN = 5;
const BLOCK_STEP_UP = 12;
/** Lines of one wrapped cell are at most this far apart. */
const WRAPPED_STEP = 1.55;
/** Lines that span several columns (a sub-heading inside a table) tolerated in a row. */
const SPANNING_LINES = 2;
/** A column of whole sentences (a page column, not a table column) has cells at least this long. */
const PROSE_CELL_CHARACTERS = 30;
const MIN_COLUMNS = 3;

const QUARTER_COS = [1, 0, -1, 0];
const QUARTER_SIN = [0, 1, 0, -1];
/** PDF space has y pointing up; without a viewport matrix, flip it. */
const FLIP_Y = [1, 0, 0, -1, 0, 0];

/** The page text in pdf.js order: what `unpdf.extractText` returns for one page. */
export function plainPageText(items: readonly PdfTextItem[]): string {
  let text = "";
  for (const item of items) if (typeof item.str === "string") text += item.str + (item.hasEOL ? "\n" : "");
  return text;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Text pieces in upright coordinates (x along the text, y down the page), grouped by the direction
 * the text runs in: a table printed sideways is analysed on its own, turned upright.
 */
function toPieces(items: readonly PdfTextItem[], viewport: readonly number[]): Piece[][] {
  const groups: Piece[][] = [[], [], [], []];
  items.forEach((item, index) => {
    if (typeof item.str !== "string" || !item.str.trim()) return;
    const matrix = item.transform;
    if (!Array.isArray(matrix) || matrix.length < 6) return;
    const a = viewport[0]! * matrix[0]! + viewport[2]! * matrix[1]!;
    const b = viewport[1]! * matrix[0]! + viewport[3]! * matrix[1]!;
    const x = viewport[0]! * matrix[4]! + viewport[2]! * matrix[5]! + viewport[4]!;
    const y = viewport[1]! * matrix[4]! + viewport[3]! * matrix[5]! + viewport[5]!;
    const scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const angle = Math.atan2(b, a);
    const quarter = Math.round(angle / (Math.PI / 2));
    if (Math.abs(angle - quarter * (Math.PI / 2)) > 0.09) return; // slanted text is left as it is
    const group = ((quarter % 4) + 4) % 4;
    const cos = QUARTER_COS[group]!;
    const sin = QUARTER_SIN[group]!;
    const size = item.height > 0 ? item.height : scale;
    const width = item.width > 0 ? item.width : item.str.length * size * 0.5;
    const x0 = x * cos + y * sin;
    groups[group]!.push({ index, group, text: item.str.trim(), x0, x1: x0 + width, y: y * cos - x * sin, size });
  });
  return groups;
}

/**
 * Splits text into blocks where the file order jumps far away, as it does from the foot of one
 * page column to the head of the next. Tables are only looked for inside a block, so the prose of
 * a neighbouring column is never mistaken for cells of the same row.
 */
function toBlocks(pieces: Piece[]): Piece[][] {
  const blocks: Piece[][] = [];
  let current: Piece[] = [];
  for (const piece of pieces) {
    const last = current.at(-1);
    if (last) {
      const size = Math.max(last.size, piece.size);
      const step = piece.y - last.y;
      if (step > BLOCK_STEP_DOWN * size || step < -BLOCK_STEP_UP * size) {
        blocks.push(current);
        current = [];
      }
    }
    current.push(piece);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** Lines of text, top to bottom. Pieces closer than `glue` font sizes form one segment. */
function toLines(pieces: Piece[], glue: number): Line[] {
  const sorted = [...pieces].sort((left, right) => left.y - right.y || left.x0 - right.x0);
  const groups: Piece[][] = [];
  let lineY = 0;
  let lineSize = 0;
  for (const piece of sorted) {
    const current = groups.at(-1);
    const larger = Math.max(piece.size, lineSize);
    const tolerance = Math.min(piece.size, lineSize) < 0.8 * larger ? SCRIPT_TOLERANCE : BASELINE_TOLERANCE;
    if (current && piece.y - lineY <= tolerance * larger) {
      current.push(piece);
      // A raised mark may come first: the line's baseline is that of its full-size text.
      if (piece.size > lineSize / 0.8) lineY = piece.y;
      lineSize = larger;
    } else {
      groups.push([piece]);
      lineY = piece.y;
      lineSize = piece.size;
    }
  }
  return groups.map((group) => {
    group.sort((left, right) => left.x0 - right.x0);
    const size = median(group.map((piece) => piece.size));
    const segments: Segment[] = [];
    for (const piece of group) {
      const last = segments.at(-1);
      if (last && piece.x0 - last.x1 < glue * size) {
        last.x1 = Math.max(last.x1, piece.x1);
        last.pieces.push(piece);
      } else {
        segments.push({ x0: piece.x0, x1: piece.x1, pieces: [piece] });
      }
    }
    // The baseline of the line is where its full-size text sits, not a raised footnote mark.
    return { y: median(group.filter((piece) => piece.size >= 0.8 * size).map((piece) => piece.y)), size, segments };
  });
}

/**
 * The pieces of a segment that have a visible gap between them. Pieces a word space apart are
 * read as one cell, but when the columns around them say otherwise (each part sits in a column
 * of its own), they are two cells whose columns happen to be that close.
 */
function partsOf(segment: Segment, size: number): Segment[] {
  const parts: Segment[] = [];
  for (const piece of segment.pieces) {
    const last = parts.at(-1);
    if (last && piece.x0 - last.x1 < VISIBLE_GAP * size) {
      last.x1 = Math.max(last.x1, piece.x1);
      last.pieces.push(piece);
    } else {
      parts.push({ x0: piece.x0, x1: piece.x1, pieces: [piece] });
    }
  }
  return parts;
}

const regionSize = (lines: Line[]): number => median(lines.map((line) => line.size)) || 1;
const tooFarBelow = (line: Line, previous: Line): boolean => line.y - previous.y > ROW_STEP * Math.max(line.size, previous.size);

// ---------- Finding a table: lines whose pieces keep to the same columns ----------

/** Where a cell goes: the column it lies in, "across" if it lies in several, else a column it nearly touches. */
function placeCell<T extends Column>(columns: T[], cell: Segment, touch: number): T | "across" | undefined {
  const under = columns.filter((column) => cell.x0 < column.x1 && cell.x1 > column.x0);
  if (under.length > 1) return "across";
  if (under.length === 1) return under[0];
  let nearest: T | undefined;
  let distance = touch;
  for (const column of columns) {
    const gap = Math.max(column.x0 - cell.x1, cell.x0 - column.x1);
    if (gap < distance) {
      distance = gap;
      nearest = column;
    }
  }
  return nearest;
}

/** A column while a region grows, with the cells seen in it so far. */
type GrowingColumn = Column & { cells: Column[] };

/**
 * The columns after adding a line, or undefined if the line is not a row of this table: its text
 * runs across two columns, or its cells do not line up with the cells above them. Cells of a
 * column share a left edge, a right edge or a centre; words of a sentence under a table sit in
 * the same columns by chance, but not on those edges.
 */
function addLine(columns: GrowingColumn[], line: Line): GrowingColumn[] | undefined {
  const touch = COLUMN_TOUCH * line.size;
  const tolerance = ROW_ALIGNMENT * line.size;
  const next = columns.map((column) => ({ ...column, cells: [...column.cells] }));
  let placed = 0;
  let aligned = 0;
  const put = (cell: Segment, mayAddColumn: boolean): boolean => {
    const column = placeCell(next, cell, touch);
    if (column === "across" || (!column && !mayAddColumn)) return false;
    if (column) {
      placed++;
      const centre = (cell.x0 + cell.x1) / 2;
      if (column.cells.some((other) => Math.abs(other.x0 - cell.x0) <= tolerance || Math.abs(other.x1 - cell.x1) <= tolerance
        || Math.abs((other.x0 + other.x1) / 2 - centre) <= tolerance)) aligned++;
      column.x0 = Math.min(column.x0, cell.x0);
      column.x1 = Math.max(column.x1, cell.x1);
      column.cells.push({ x0: cell.x0, x1: cell.x1 });
    } else {
      next.push({ x0: cell.x0, x1: cell.x1, cells: [{ x0: cell.x0, x1: cell.x1 }] });
    }
    return true;
  };
  for (const segment of line.segments) {
    if (put(segment, true)) continue;
    // Text across two columns may be two cells that sit close together: then each of its parts
    // lies in a column that is already there.
    const parts = partsOf(segment, line.size);
    if (parts.length < 2 || !parts.every((part) => put(part, false))) return undefined;
  }
  if (aligned * 2 < placed) return undefined;
  return next.sort((left, right) => left.x0 - right.x0);
}

/** Grows a table downwards from a line with at least two cells, while the columns hold. */
function growRegion(lines: Line[], start: number): number {
  let columns: GrowingColumn[] = lines[start]!.segments.map((segment) => ({ x0: segment.x0, x1: segment.x1, cells: [{ x0: segment.x0, x1: segment.x1 }] }));
  let end = start;
  let index = start + 1;
  while (index < lines.length) {
    // A line that crosses columns is accepted only if a normal row follows it closely.
    let probe = index;
    let added: GrowingColumn[] | undefined;
    while (probe < lines.length && probe - index <= SPANNING_LINES) {
      if (tooFarBelow(lines[probe]!, lines[probe - 1]!)) break;
      added = addLine(columns, lines[probe]!);
      if (added) break;
      probe++;
    }
    if (!added) break;
    if (probe > index && lines[probe]!.segments.length < 2) break;
    columns = added;
    end = probe;
    index = probe + 1;
  }
  // Text under the table that is not the rest of a wrapped cell does not belong to it.
  while (end > start) {
    const line = lines[end]!;
    if (line.segments.length >= 2) break;
    const segment = line.segments[0]!;
    let continues = false;
    for (let above = end - 1; above >= start && !continues; above--) {
      const lower = lines[above + 1]!;
      const upper = lines[above]!;
      if (lower.y - upper.y > WRAPPED_STEP * Math.max(lower.size, upper.size)) break;
      continues = upper.segments.some((other) => other.x0 < segment.x1 && other.x1 > segment.x0);
    }
    if (continues) break;
    end--;
  }
  return end;
}

/**
 * The columns of a region, taken from its most detailed lines first. A heading that spans two
 * columns then lies across both and is treated as a spanning cell, instead of gluing them together.
 */
function refineColumns(lines: Line[]): Column[] {
  const columns: Column[] = [];
  const detailedFirst = [...lines].sort((left, right) => right.segments.length - left.segments.length);
  for (const line of detailedFirst) {
    const touch = COLUMN_TOUCH * line.size;
    for (const segment of line.segments) {
      const across = placeCell(columns, segment, touch) === "across";
      for (const cell of across ? partsOf(segment, line.size) : [segment]) {
        const column = placeCell(columns, cell, touch);
        if (column === "across") continue;
        if (column) {
          column.x0 = Math.min(column.x0, cell.x0);
          column.x1 = Math.max(column.x1, cell.x1);
        } else if (!across) {
          columns.push({ x0: cell.x0, x1: cell.x1 });
        }
      }
    }
  }
  return columns.sort((left, right) => left.x0 - right.x0);
}

/** The columns a piece of text lies in. */
function columnsUnder(columns: Column[], segment: Segment): number[] {
  return columns.flatMap((column, index) => (segment.x0 < column.x1 && segment.x1 > column.x0 ? [index] : []));
}

function columnOf(columns: Column[], segment: Segment, rightToLeft: boolean): number {
  // A cell that spans columns goes in the first of them, in reading order.
  let chosen = -1;
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index]!;
    if (segment.x0 < column.x1 && segment.x1 > column.x0) {
      if (chosen === -1 || rightToLeft) chosen = index;
    }
  }
  if (chosen !== -1) return chosen;
  let nearest = 0;
  let distance = Infinity;
  columns.forEach((column, index) => {
    const gap = Math.max(column.x0 - segment.x1, segment.x0 - column.x1);
    if (gap < distance) {
      distance = gap;
      nearest = index;
    }
  });
  return nearest;
}

/**
 * The cells of a region. `clashes[line]` is true when two separate pieces of that line fall in one
 * column: the line was laid out on other columns than these, so it belongs to another table.
 * `spanning` counts the lines with a cell across several columns.
 */
function toGrid(lines: Line[], columns: Column[], rightToLeft: boolean): { grid: Grid; clashes: boolean[]; spanning: number } {
  const clashes: boolean[] = [];
  let spanning = 0;
  const grid = lines.map((line) => {
    const row: Piece[][] = columns.map(() => []);
    const edge: number[] = [];
    let clash = false;
    let across = false;
    for (const segment of line.segments) {
      // Text over two columns is two close cells if each of its parts sits in one column, and
      // otherwise a cell that spans them.
      let cells = [segment];
      if (columnsUnder(columns, segment).length > 1) {
        const parts = partsOf(segment, line.size);
        if (parts.length > 1 && parts.every((part) => columnsUnder(columns, part).length === 1)) cells = parts;
        else across = true;
      }
      for (const cell of cells) {
        const column = columnOf(columns, cell, rightToLeft);
        if (edge[column] !== undefined && cell.x0 - edge[column]! >= CELL_GAP * line.size) clash = true;
        edge[column] = cell.x1;
        row[column]!.push(...cell.pieces);
      }
    }
    clashes.push(clash);
    if (across) spanning++;
    return row;
  });
  return { grid, clashes, spanning };
}

/** The longest run of lines without a clash, as [first, last]. */
function longestClearRun(clashes: boolean[]): [number, number] {
  let best: [number, number] = [0, -1];
  let from = 0;
  for (let index = 0; index <= clashes.length; index++) {
    if (index < clashes.length && !clashes[index]) continue;
    if (index - from > best[1] - best[0] + 1) best = [from, index - 1];
    from = index + 1;
  }
  return best;
}

/**
 * A column with a single cell is usually not a column:
 * - a word that pdf.js kept apart from the rest of its cell (it sits a word space away), or
 * - a heading that spans two columns ("2025" above "H1" and "H2") and sits between them.
 * The first is joined to its cell; the second moves into the column before it, which is where a
 * spanning cell is conventionally written.
 */
function absorbLoneColumns(grid: Grid, rightToLeft: boolean): Grid {
  if (grid.length < 3) return grid;
  let columns = grid[0]!.length;
  for (let column = 0; column < columns && columns > 1; column++) {
    const filled = grid.flatMap((row, line) => (row[column]!.length > 0 ? [line] : []));
    if (filled.length !== 1) continue;
    const row = grid[filled[0]!]!;
    const cell = row[column]!;
    const size = Math.max(...cell.map((piece) => piece.size));
    const left = Math.min(...cell.map((piece) => piece.x0));
    const right = Math.max(...cell.map((piece) => piece.x1));
    const before = rightToLeft ? column + 1 : column - 1;
    const after = rightToLeft ? column - 1 : column + 1;
    const exists = (index: number) => index >= 0 && index < columns;
    const distance = (index: number) => {
      const other = row[index]!;
      if (other.length === 0) return Infinity;
      return index < column ? left - Math.max(...other.map((piece) => piece.x1)) : Math.min(...other.map((piece) => piece.x0)) - right;
    };
    const near = [before, after].filter(exists).find((index) => distance(index) <= WORD_GAP * size);
    const empty = [before, after].filter(exists).find((index) => row[index]!.length === 0);
    const target = near ?? empty;
    if (target === undefined) continue;
    row[target]!.push(...cell);
    for (const each of grid) each.splice(column, 1);
    columns--;
    column--;
  }
  return grid;
}

/**
 * Where a second table starts, if two tables with different columns sit directly under each other:
 * the first line from which some columns are never used again and others are used for the first time.
 */
function stackedTableStart(grid: Grid): number | undefined {
  const first: number[] = [];
  const last: number[] = [];
  for (let column = 0; column < grid[0]!.length; column++) {
    const used = grid.flatMap((row, line) => (row[column]!.length > 0 ? [line] : []));
    if (used.length === 0) continue;
    first.push(used[0]!);
    last.push(used.at(-1)!);
  }
  for (let line = 1; line < grid.length; line++) {
    if (last.some((value) => value < line) && first.some((value) => value >= line)) return line;
  }
  return undefined;
}

// ---------- Checks that tell a table from text that merely lines up ----------

const RIGHT_TO_LEFT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/g;
const LEFT_TO_RIGHT = /[A-Za-z\u00c0-\u024f\u0370-\u052f]/g;

function isRightToLeft(lines: Line[]): boolean {
  let rightToLeft = 0;
  let leftToRight = 0;
  for (const line of lines) {
    for (const segment of line.segments) {
      for (const piece of segment.pieces) {
        rightToLeft += piece.text.match(RIGHT_TO_LEFT)?.length ?? 0;
        leftToRight += piece.text.match(LEFT_TO_RIGHT)?.length ?? 0;
      }
    }
  }
  return rightToLeft > leftToRight;
}

/** Digits with hardly any letters: "1,204", "17%", "(310)", "2026-01-03". "H1" and "Q2" are labels. */
function isNumeric(text: string): boolean {
  const digits = text.match(/\d/g)?.length ?? 0;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return digits > 0 && letters * 2 <= digits;
}

/** The text of one line's pieces in one cell, in reading order. */
function joinPieces(pieces: Piece[], rightToLeft: boolean): string {
  const ordered = [...pieces].sort((left, right) => (rightToLeft ? right.x0 - left.x0 : left.x0 - right.x0));
  let text = "";
  ordered.forEach((piece, index) => {
    if (index > 0) {
      const previous = ordered[index - 1]!;
      const gap = rightToLeft ? previous.x0 - piece.x1 : piece.x0 - previous.x1;
      if (gap > VISIBLE_GAP * Math.max(piece.size, previous.size)) text += " ";
    }
    text += piece.text;
  });
  return text;
}

/** Columns that are their own run of whole sentences in file order: page columns, not table columns. */
function proseColumns(grid: Grid, rightToLeft: boolean): number[] {
  const order = grid.flatMap((row) => row.flatMap((cell) => cell.map((piece) => piece.index))).sort((left, right) => left - right);
  const rank = new Map(order.map((index, position) => [index, position]));
  const result: number[] = [];
  for (let column = 0; column < grid[0]!.length; column++) {
    const cells = grid.map((row) => row[column]!).filter((cell) => cell.length > 0);
    if (cells.length < 3) continue;
    if (median(cells.map((cell) => joinPieces(cell, rightToLeft).length)) < PROSE_CELL_CHARACTERS) continue;
    const ranks = cells.flatMap((cell) => cell.map((piece) => rank.get(piece.index)!));
    if (Math.max(...ranks) - Math.min(...ranks) + 1 === ranks.length) result.push(column);
  }
  return result;
}

/** How many of `values` lie within `tolerance` of the most common value. */
function largestCluster(values: number[], tolerance: number): number {
  let best = 0;
  for (const value of values) best = Math.max(best, values.filter((other) => Math.abs(other - value) <= tolerance).length);
  return best;
}

/**
 * Cells of a real column share a left edge, a right edge, or a centre. Words of justified prose
 * that happen to sit under each other do not, apart from the two margins, so the columns between
 * the first and the last are the ones that count.
 */
function hasAlignedColumns(grid: Grid, lines: Line[]): boolean {
  const size = regionSize(lines);
  const gaps = lines.flatMap((line) => line.segments.slice(1).map((segment, index) => segment.x0 - line.segments[index]!.x1));
  // Wide gaps cannot be word spaces, so positions may be loose (scans with a text layer are).
  // Narrow gaps can be, so the cells must line up exactly, as they do in a typeset table.
  const tolerance = median(gaps) >= 2 * size ? 0.3 * size : Math.max(0.75, 0.1 * size);
  const columns = grid[0]!.length;
  let candidates = 0;
  let aligned = 0;
  let inner = 0;
  let innerAligned = 0;
  for (let column = 0; column < columns; column++) {
    const cells = grid.map((row) => row[column]!).filter((cell) => cell.length > 0);
    if (cells.length < 2) continue;
    const left = cells.map((cell) => Math.min(...cell.map((piece) => piece.x0)));
    const right = cells.map((cell) => Math.max(...cell.map((piece) => piece.x1)));
    const centre = left.map((value, index) => (value + right[index]!) / 2);
    const best = Math.max(largestCluster(left, tolerance), largestCluster(right, tolerance), largestCluster(centre, tolerance));
    const isAligned = best >= Math.max(2, Math.ceil(0.6 * cells.length));
    candidates++;
    if (isAligned) aligned++;
    if (column > 0 && column < columns - 1) {
      inner++;
      if (isAligned) innerAligned++;
    }
  }
  if (candidates < 2 || inner === 0) return false;
  // With two or three lines there is little evidence, so every column has to line up.
  if (lines.length <= 3) return aligned === candidates;
  return innerAligned >= Math.ceil(0.7 * inner) && aligned >= 2;
}

function looksLikeTable(grid: Grid, lines: Line[]): boolean {
  if (grid[0]!.length < MIN_COLUMNS) return false;
  const filledPerLine = grid.map((row) => row.filter((cell) => cell.length > 0).length);
  return filledPerLine.filter((count) => count >= 2).length >= 2
    && filledPerLine.some((count) => count >= 3)
    && hasAlignedColumns(grid, lines);
}

// ---------- Writing the rows ----------

/**
 * Which lines start a new row. A row with a wrapped cell takes several lines; they are joined
 * only when the table clearly has two kinds of step (within a row, and between rows) and the
 * joined lines do not look like rows of their own.
 */
function rowStarts(lines: Line[], grid: Grid): boolean[] {
  const starts = lines.map(() => true);
  if (lines.length < 3) return starts;
  const size = regionSize(lines);
  const steps = lines.slice(1).map((line, index) => (line.y - lines[index]!.y) / size);
  const tight = steps.filter((step) => step <= WRAPPED_STEP);
  const loose = steps.filter((step) => step > WRAPPED_STEP);
  if (tight.length === 0 || loose.length === 0 || Math.min(...loose) < 1.3 * Math.max(...tight)) return starts;
  let from = 0;
  for (let index = 1; index <= lines.length; index++) {
    if (index < lines.length && steps[index - 1]! <= WRAPPED_STEP) continue;
    // Lines from..index-1 are one candidate row.
    const count = index - from;
    if (count > 1) {
      let filledColumns = 0;
      let fullColumns = 0;
      let repeatedNumbers = false;
      for (let column = 0; column < grid[0]!.length; column++) {
        const cells = [];
        for (let line = from; line < index; line++) if (grid[line]![column]!.length > 0) cells.push(grid[line]![column]!);
        if (cells.length === 0) continue;
        filledColumns++;
        if (cells.length === count) fullColumns++;
        if (cells.filter((cell) => isNumeric(cell.map((piece) => piece.text).join(""))).length > 1) repeatedNumbers = true;
      }
      // Two numbers in one column, or most columns filled on every line: these are separate rows.
      if (!repeatedNumbers && fullColumns * 2 <= filledColumns) {
        for (let line = from + 1; line < index; line++) starts[line] = false;
      }
    }
    from = index;
  }
  return starts;
}

function cellText(lines: Piece[][], rightToLeft: boolean): string {
  let text = "";
  for (const pieces of lines) {
    if (pieces.length === 0) continue;
    const part = joinPieces(pieces, rightToLeft);
    // "long-" + "standing" is one word; anything else gets a space.
    text += text === "" || (/[A-Za-z0-9]-$/.test(text) && /^[A-Za-z0-9]/.test(part)) ? part : ` ${part}`;
  }
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function toTable(lines: Line[], grid: Grid, rightToLeft: boolean): Table {
  const columnCount = grid[0]!.length;
  const starts = rowStarts(lines, grid);
  const rows: string[] = [];
  let row: Grid = [];
  const flush = () => {
    if (row.length === 0) return;
    const cells = Array.from({ length: columnCount }, (_, column) => cellText(row.map((line) => line[column]!), rightToLeft));
    if (rightToLeft) cells.reverse();
    rows.push(`| ${cells.join(" | ")} |`);
    row = [];
  };
  grid.forEach((line, index) => {
    if (starts[index]) flush();
    row.push(line);
  });
  flush();
  return { indexes: grid.flatMap((line) => line.flatMap((cell) => cell.map((piece) => piece.index))), rows };
}

// ---------- The search ----------

function findTables(pieces: Piece[], depth = 0): Table[] {
  return pieces.length < 5 ? [] : tablesInLines(toLines(pieces, PIECE_GAP), depth);
}

function tablesInLines(lines: Line[], depth: number): Table[] {
  const tables: Table[] = [];
  const taken = new Set<Line>();
  let start = 0;
  while (start < lines.length) {
    if (lines[start]!.segments.length < 2) {
      start++;
      continue;
    }
    let end = growRegion(lines, start);
    let region: Line[] = [];
    let rightToLeft = false;
    let grid: Grid = [];
    let clashes: boolean[] = [];
    let spanning = 0;
    const look = (first: number, last: number) => {
      end = start + last;
      start += first;
      region = lines.slice(start, end + 1);
      rightToLeft = isRightToLeft(region);
      ({ grid, clashes, spanning } = toGrid(region, refineColumns(region), rightToLeft));
    };
    look(0, end - start);
    if (clashes.some(Boolean)) {
      // Lines laid out on other columns (another table right above or below): keep the longest
      // stretch that agrees, and look at what comes before it on its own.
      const [first, last] = longestClearRun(clashes);
      if (first > 0 && depth < 4) tables.push(...tablesInLines(region.slice(0, first), depth + 1));
      look(first, last);
    }
    const second = region.length > 1 ? stackedTableStart(grid) : undefined;
    if (second !== undefined) look(0, second - 1);
    if (region.length < 2) {
      start++;
      continue;
    }
    grid = absorbLoneColumns(grid, rightToLeft);

    const prose = proseColumns(grid, rightToLeft);
    if (prose.length > 0) {
      // Set the page columns aside and look again at what is left on these lines.
      if (depth < 4) {
        const rest = grid.flatMap((row) => row.flatMap((cell, column) => (prose.includes(column) ? [] : cell)));
        tables.push(...findTables(rest.sort((left, right) => left.index - right.index), depth + 1));
      }
      start = end + 1;
      continue;
    }
    // A note or a heading may run across the columns of a table; running text does on most lines.
    if (spanning > Math.max(1, Math.floor(region.length / 5)) || !looksLikeTable(grid, region)) {
      start++;
      continue;
    }
    // Heading lines right above, whose cells sit so close together that each line read as one
    // piece of text: taken in when every part of them lies in one column of the table.
    const columns = refineColumns(region);
    const covered = new Set<number>();
    let headingLines = 0;
    for (let above = start - 1; above >= 0 && start - above <= 3; above--) {
      const line = lines[above]!;
      const below = lines[above + 1]!;
      const step = (below.y - line.y) / Math.max(below.size, line.size);
      if (taken.has(line) || step > (above === start - 1 ? ROW_STEP : WRAPPED_STEP)) break;
      const under = line.segments.flatMap((segment) => partsOf(segment, line.size)).map((part) => columnsUnder(columns, part));
      // "2025" above "H1" and "H2" spans two columns; a caption is one piece across most of them.
      if (!under.every((found) => found.length >= 1) || (under.length === 1 && under[0]!.length > 1)) break;
      for (const found of under) for (const column of found) covered.add(column);
      headingLines++;
    }
    if (headingLines > 0 && covered.size >= Math.max(2, Math.ceil(columns.length / 2))) {
      look(-headingLines, end - start);
      grid = absorbLoneColumns(grid, rightToLeft);
    }
    for (const line of region) taken.add(line);
    tables.push(toTable(region, grid, rightToLeft));
    start = end + 1;
  }
  return tables;
}

// ---------- The page ----------

/** `[left, top, right, bottom]` in the coordinates the viewport transform gives. */
export type LayoutBox = [number, number, number, number];

/** Where a table lies on the page: the box around its text, widened by about one line for the padding of its cells. */
function tableBox(table: Table, items: readonly PdfTextItem[], viewport: readonly number[]): LayoutBox {
  const box: LayoutBox = [Infinity, Infinity, -Infinity, -Infinity];
  let padding = 0;
  for (const index of table.indexes) {
    const item = items[index]!;
    const matrix = item.transform;
    const a = viewport[0]! * matrix[0]! + viewport[2]! * matrix[1]!;
    const b = viewport[1]! * matrix[0]! + viewport[3]! * matrix[1]!;
    const x = viewport[0]! * matrix[4]! + viewport[2]! * matrix[5]! + viewport[4]!;
    const y = viewport[1]! * matrix[4]! + viewport[3]! * matrix[5]! + viewport[5]!;
    const scale = Math.hypot(a, b) || 1;
    const size = item.height > 0 ? item.height : scale;
    const width = item.width > 0 ? item.width : item.str.length * size * 0.5;
    // Along the text, and from the baseline up to the top of the letters.
    const along = [a / scale * width, b / scale * width];
    const up = [b / scale * size, -a / scale * size];
    for (const [px, py] of [[x, y], [x + along[0]!, y + along[1]!], [x + up[0]!, y + up[1]!], [x + along[0]! + up[0]!, y + along[1]! + up[1]!]]) {
      box[0] = Math.min(box[0], px!);
      box[1] = Math.min(box[1], py!);
      box[2] = Math.max(box[2], px!);
      box[3] = Math.max(box[3], py!);
    }
    padding = Math.max(padding, size);
  }
  return [box[0] - padding, box[1] - padding, box[2] + padding, box[3] + padding];
}

/**
 * The text of one PDF page, with tables written as `| cell | cell |` rows.
 *
 * @param items `page.getTextContent().items` from pdf.js.
 * @param viewportTransform `page.getViewport({ scale: 1 }).transform`, which applies the page's
 *   rotation. Without it, the page is assumed to be upright.
 */
export function layoutPageText(items: readonly PdfTextItem[], viewportTransform: readonly number[] = FLIP_Y): string {
  return layoutPage(items, viewportTransform).text;
}

/** As `layoutPageText`, and also where the tables it found lie on the page. */
export function layoutPage(items: readonly PdfTextItem[], viewportTransform: readonly number[] = FLIP_Y): { text: string; tables: LayoutBox[] } {
  const tableOf = new Map<number, Table>();
  const pieceOf = new Map<number, Piece>();
  for (const group of toPieces(items, viewportTransform)) {
    for (const piece of group) pieceOf.set(piece.index, piece);
    for (const block of toBlocks(group)) {
      for (const table of findTables(block)) for (const index of table.indexes) tableOf.set(index, table);
    }
  }

  let text = "";
  const written = new Set<Table>();
  let insideTable = false;
  /** The text piece written last, while nothing (no space, no line end) has followed it. */
  let last: Piece | undefined;
  items.forEach((item, index) => {
    if (typeof item.str !== "string") return;
    const table = tableOf.get(index);
    if (table) {
      if (!written.has(table)) {
        written.add(table);
        if (text && !text.endsWith("\n")) text += "\n";
        text += `${table.rows.join("\n")}\n`;
      }
      insideTable = true;
      last = undefined;
      return;
    }
    // Spaces and line ends between cells were replaced by the rows above.
    if (insideTable && !item.str.trim()) return;
    insideTable = false;
    const piece = pieceOf.get(index);
    // pdf.js adds the space between two pieces only when the second is to the right of the first.
    // Right-to-left text runs the other way, so its words would be glued together.
    if (piece && last && last.group === piece.group && Math.abs(piece.y - last.y) <= BASELINE_TOLERANCE * Math.max(piece.size, last.size)
      && last.x0 - piece.x1 > VISIBLE_GAP * Math.max(piece.size, last.size) && !/\s$/.test(text) && !/^\s/.test(item.str)) {
      text += " ";
    }
    text += item.str + (item.hasEOL ? "\n" : "");
    last = piece && !item.hasEOL && item.str.trim() ? piece : undefined;
  });
  return { text, tables: [...new Set(tableOf.values())].map((table) => tableBox(table, items, viewportTransform)) };
}
