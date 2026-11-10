/**
 * Finds the pages of a PDF that show a picture or a drawing, so their text can say so.
 *
 * It reads the structure of the file and decodes no image. Each page's content is a small program:
 * this follows its transformation matrix, and notes every image it paints with the box it is
 * painted in, and every shape it fills with its colour. Asking a PDF renderer for the same costs
 * 60 to 180 ms a photo, because the renderer decodes each one: 13 seconds for 72 photos that this
 * goes through in a tenth of a second.
 *
 * Needs the optional dependency "@cantoo/pdf-lib". Without it, no page is marked.
 */
import type { PDFContext, PDFDict, PDFObject } from "@cantoo/pdf-lib";
import { decodeContent, loadPdfLibrary, tooManyObjects } from "./pdf-pages.js";

type PdfLibrary = typeof import("@cantoo/pdf-lib");
/** `[x0, y0, x1, y1]` with x0 <= x1 and y0 <= y1. */
export type Box = [number, number, number, number];
/** `[a, b, c, d, e, f]`: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = readonly number[];

/** What the text extractor knows about a page, in the units of the page itself. */
export type PageGeometry = {
  /** The visible part of the page: `page.view` in pdf.js. */
  view: readonly number[];
  /** From page units to the coordinates `tables` are in: `page.getViewport({ scale: 1 }).transform`. */
  transform: readonly number[];
  /** The tables found on the page. A table's borders and shading are drawings too, and are not pictures. */
  tables: readonly Box[];
};

/** A file with more objects than this takes over two seconds to read into objects. */
const MAX_OBJECTS = 150_000;
/** Time for everything after the file is read into objects. Past it, no page is marked. */
const TIME_LIMIT_MS = 5_000;
/** A content stream past this size (compressed) is not text or a table: it is a drawing. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
/** Images must cover this share of the page together. A logo covers about 1%, a small figure 4%. */
const PICTURE_SHARE = 0.03;
/** An image on this share of the pages (and on three at least) is a logo, a background, a watermark. */
const FURNITURE_SHARE = 0.3;
/** A chart or a diagram fills shapes in several colours. A table shades its cells in one or two. */
const DRAWING_COLOURS = 3;
const MAX_SHAPES = 20_000;
const MAX_FORM_DEPTH = 4;

type Image = { id: number; box: Box };
type Shape = { box: Box; fill: string };
type Graphics = { images: Image[]; shapes: Shape[]; tooLarge: boolean };

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** Applies `first`, then `second`. */
function multiply(first: Matrix, second: Matrix): number[] {
  return [
    first[0]! * second[0]! + first[1]! * second[2]!, first[0]! * second[1]! + first[1]! * second[3]!,
    first[2]! * second[0]! + first[3]! * second[2]!, first[2]! * second[1]! + first[3]! * second[3]!,
    first[4]! * second[0]! + first[5]! * second[2]! + second[4]!, first[4]! * second[1]! + first[5]! * second[3]! + second[5]!,
  ];
}
const mapX = (matrix: Matrix, x: number, y: number) => matrix[0]! * x + matrix[2]! * y + matrix[4]!;
const mapY = (matrix: Matrix, x: number, y: number) => matrix[1]! * x + matrix[3]! * y + matrix[5]!;

// Character codes of PDF syntax.
const isWhite = (code: number) => code === 32 || code === 10 || code === 13 || code === 9 || code === 12 || code === 0;
const isDelimiter = (code: number) => code === 40 || code === 41 || code === 60 || code === 62 || code === 91 || code === 93 || code === 123 || code === 125 || code === 47 || code === 37;
/** The end of the data of an inline image: "EI" between white space. */
const INLINE_IMAGE_END = /[\x00\t\n\f\r ]EI(?![^\x00\t\n\f\r /\[\]<>(){}%])/g;

/**
 * Runs the content of a page, or of a form it paints, and adds what it draws to `found`.
 * It understands just enough: the matrix (q, Q, cm), paths and how they are painted, the fill
 * colour, and Do. Text, clipping and everything else pass through unread.
 */
function run(library: PdfLibrary, context: PDFContext, content: string, resources: PDFDict | undefined, matrix: Matrix, found: Graphics, depth: number, open: Set<PDFObject>): void {
  const { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } = library;
  const saved: Array<{ ctm: Matrix; fill: string }> = [];
  let ctm = matrix;
  let fill = "g:0";
  let numbers: number[] = [];
  let name: string | undefined;
  /** The path under construction, in page units. */
  let path: Box | undefined;
  const point = (x: number, y: number) => {
    const px = mapX(ctm, x, y);
    const py = mapY(ctm, x, y);
    if (!path) path = [px, py, px, py];
    else {
      if (px < path[0]) path[0] = px;
      if (py < path[1]) path[1] = py;
      if (px > path[2]) path[2] = px;
      if (py > path[3]) path[3] = py;
    }
  };
  const points = (count: number) => {
    if (numbers.length < count * 2) return;
    for (let index = numbers.length - count * 2; index < numbers.length; index += 2) point(numbers[index]!, numbers[index + 1]!);
  };

  const length = content.length;
  let at = 0;
  while (at < length) {
    let code = content.charCodeAt(at);
    if (isWhite(code)) {
      at++;
      continue;
    }
    if (code === 37) { // % a comment, to the end of the line
      while (at < length && content.charCodeAt(at) !== 10 && content.charCodeAt(at) !== 13) at++;
      continue;
    }
    if (code === 40) { // ( a string ), which may hold anything, balanced parentheses included
      let nesting = 1;
      at++;
      while (at < length && nesting > 0) {
        code = content.charCodeAt(at);
        if (code === 92) at++;
        else if (code === 40) nesting++;
        else if (code === 41) nesting--;
        at++;
      }
      continue;
    }
    if (code === 60) { // << a dictionary, or <a hex string>
      if (content.charCodeAt(at + 1) === 60) at += 2;
      else {
        const end = content.indexOf(">", at);
        at = end === -1 ? length : end + 1;
      }
      continue;
    }
    if (code === 62 || code === 91 || code === 93 || code === 123 || code === 125) { // > [ ] { }
      at++;
      continue;
    }
    const start = at++;
    while (at < length && !isWhite(code = content.charCodeAt(at)) && !isDelimiter(code)) at++;
    const token = content.slice(start, at);
    const first = token.charCodeAt(0);
    if (first === 47) { // /Name
      name = token.slice(1);
      continue;
    }
    if ((first >= 48 && first <= 57) || first === 45 || first === 43 || first === 46) {
      const number = Number(token);
      if (!Number.isNaN(number)) {
        numbers.push(number);
        continue;
      }
    }
    switch (token) {
      case "q":
        saved.push({ ctm, fill });
        break;
      case "Q": {
        const state = saved.pop();
        if (state) ({ ctm, fill } = state);
        break;
      }
      case "cm":
        if (numbers.length >= 6) ctm = multiply(numbers.slice(-6), ctm);
        break;
      case "re":
        if (numbers.length >= 4) {
          const [x, y, width, height] = numbers.slice(-4) as [number, number, number, number];
          point(x, y);
          point(x + width, y);
          point(x, y + height);
          point(x + width, y + height);
        }
        break;
      case "m": case "l":
        points(1);
        break;
      case "c":
        points(3);
        break;
      case "v": case "y":
        points(2);
        break;
      case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*":
        if (path && found.shapes.length < MAX_SHAPES) found.shapes.push({ box: path, fill });
        path = undefined;
        break;
      case "S": case "s": case "n":
        path = undefined;
        break;
      case "g":
        if (numbers.length >= 1) fill = `g:${numbers.at(-1)}`;
        break;
      case "rg":
        if (numbers.length >= 3) fill = `rgb:${numbers.slice(-3).join(",")}`;
        break;
      case "k":
        if (numbers.length >= 4) fill = `cmyk:${numbers.slice(-4).join(",")}`;
        break;
      case "sc": case "scn":
        // The colour space is not followed: three numbers are read as red, green and blue.
        fill = numbers.length === 1 ? `g:${numbers[0]}` : numbers.length === 3 ? `rgb:${numbers.join(",")}` : numbers.length === 4 ? `cmyk:${numbers.join(",")}` : "other";
        break;
      case "ID": { // the data of an inline image: bytes that are not content
        INLINE_IMAGE_END.lastIndex = at;
        at = INLINE_IMAGE_END.exec(content) ? INLINE_IMAGE_END.lastIndex : length;
        break;
      }
      case "Do": {
        const group = resources?.lookup(PDFName.of("XObject"));
        const value = group instanceof PDFDict && name !== undefined ? group.get(PDFName.of(name)) : undefined;
        const object = value ? context.lookup(value) : undefined;
        if (!(object instanceof PDFStream)) break;
        const subtype = object.dict.lookup(PDFName.of("Subtype"));
        if (subtype === PDFName.of("Image")) {
          // An image fills the unit square of the space it is painted in.
          const xs = [mapX(ctm, 0, 0), mapX(ctm, 1, 0), mapX(ctm, 0, 1), mapX(ctm, 1, 1)];
          const ys = [mapY(ctm, 0, 0), mapY(ctm, 1, 0), mapY(ctm, 0, 1), mapY(ctm, 1, 1)];
          found.images.push({ id: value instanceof PDFRef ? value.objectNumber : -1, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
        } else if (subtype === PDFName.of("Form") && depth < MAX_FORM_DEPTH && !open.has(object)) {
          const inner = decodeContent(library, context, object, MAX_CONTENT_BYTES);
          if (inner === undefined) break;
          const own = object.dict.lookup(PDFName.of("Resources"));
          const formMatrix = object.dict.lookup(PDFName.of("Matrix"));
          const values = formMatrix instanceof PDFArray ? formMatrix.asArray().map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : Number.NaN)) : [];
          open.add(object);
          // A form without resources of its own uses those of the content that paints it.
          run(library, context, inner, own instanceof PDFDict ? own : resources, values.length === 6 && values.every(Number.isFinite) ? multiply(values, ctm) : ctm, found, depth + 1, open);
          open.delete(object);
        }
        break;
      }
      default:
        break;
    }
    numbers = [];
    name = undefined;
  }
}

/** Red, green and blue between 0 and 1 for a fill colour, or undefined when it cannot be told. */
function rgb(fill: string): [number, number, number] | undefined {
  const [kind, list = ""] = fill.split(":");
  const values = list.split(",").map(Number);
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  if (kind === "g" && values.length === 1) return [values[0]!, values[0]!, values[0]!];
  if (kind === "rgb" && values.length === 3) return [values[0]!, values[1]!, values[2]!];
  if (kind === "cmyk" && values.length === 4) return [(1 - values[0]!) * (1 - values[3]!), (1 - values[1]!) * (1 - values[3]!), (1 - values[2]!) * (1 - values[3]!)];
  return undefined;
}

/** Whether a page shows a picture or a drawing, from what its content draws. */
function showsPicture(graphics: Graphics, geometry: PageGeometry, furniture: ReadonlySet<number>): boolean {
  if (graphics.tooLarge) return true;
  const [x0, y0, x1, y1] = geometry.view as [number, number, number, number];
  const pageArea = Math.max(1, (x1 - x0) * (y1 - y0));
  /** The part of a box that is on the page, as a share of the page. */
  const share = (box: Box) => Math.max(0, Math.min(box[2], x1) - Math.max(box[0], x0)) * Math.max(0, Math.min(box[3], y1) - Math.max(box[1], y0)) / pageArea;

  let images = 0;
  for (const image of graphics.images) if (!furniture.has(image.id)) images += share(image.box);
  if (images >= PICTURE_SHARE) return true;

  const colours = new Set<string>();
  for (const shape of graphics.shapes) {
    const size = share(shape.box);
    // Not a rule or a border, not a dot, not the background of the page.
    if (size < 0.0002 || size > 0.85 || Math.min(shape.box[2] - shape.box[0], shape.box[3] - shape.box[1]) < 1.5) continue;
    const colour = rgb(shape.fill);
    // Black, white and greys are what text, rules and plain shading use.
    if (!colour || Math.max(...colour) - Math.min(...colour) < 0.15) continue;
    // The shading of a table's cells belongs to the table.
    const centreX = (shape.box[0] + shape.box[2]) / 2;
    const centreY = (shape.box[1] + shape.box[3]) / 2;
    const x = mapX(geometry.transform, centreX, centreY);
    const y = mapY(geometry.transform, centreX, centreY);
    if (geometry.tables.some((table) => x >= table[0] && x <= table[2] && y >= table[1] && y <= table[3])) continue;
    colours.add(colour.map((value) => Math.round(value * 10)).join(","));
    if (colours.size >= DRAWING_COLOURS) return true;
  }
  return false;
}

/**
 * For each page, whether it shows a picture (images that cover a real share of the page, other
 * than one repeated on many pages) or a drawing (shapes filled in several colours, outside the
 * tables). Undefined when that could not be worked out: the library is not installed, the file has
 * too many objects or took too long, or it does not have the pages the text was extracted from.
 * It never throws.
 */
export async function findPicturePages(bytes: Uint8Array, pages: readonly PageGeometry[]): Promise<boolean[] | undefined> {
  try {
    if (tooManyObjects(bytes, MAX_OBJECTS) !== undefined) return undefined;
    const library = await loadPdfLibrary();
    const { PDFArray, PDFDocument, PDFRawStream } = library;
    const document = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: 4_000, password: "" });
    const leaves = document.getPages();
    if (leaves.length !== pages.length) return undefined;
    const { context } = document;
    const deadline = performance.now() + TIME_LIMIT_MS;
    const graphics: Graphics[] = [];
    for (const leaf of leaves) {
      if (performance.now() > deadline) return undefined;
      const found: Graphics = { images: [], shapes: [], tooLarge: false };
      graphics.push(found);
      try {
        const contents = leaf.node.Contents();
        const streams = contents instanceof PDFArray ? contents.asArray().map((entry) => context.lookup(entry)) : contents ? [contents] : [];
        if (streams.some((stream) => stream instanceof PDFRawStream && stream.contents.length > MAX_CONTENT_BYTES)) {
          found.tooLarge = true;
          continue;
        }
        const parts = streams.map((stream) => decodeContent(library, context, stream, MAX_CONTENT_BYTES));
        // Content that cannot be read is not guessed at: the page stays unmarked.
        if (!parts.includes(undefined)) run(library, context, parts.join(" "), leaf.node.Resources(), IDENTITY, found, 0, new Set());
      } catch {
        // An unusual page: unmarked.
      }
    }
    // An image painted on many pages is part of the page design, whatever its size.
    const pagesWith = new Map<number, number>();
    for (const found of graphics) for (const id of new Set(found.images.map((image) => image.id))) pagesWith.set(id, (pagesWith.get(id) ?? 0) + 1);
    const repeated = Math.max(3, Math.ceil(pages.length * FURNITURE_SHARE));
    const furniture = new Set([...pagesWith].filter(([, count]) => count >= repeated).map(([id]) => id));
    return graphics.map((found, index) => showsPicture(found, pages[index]!, furniture));
  } catch {
    return undefined;
  }
}
