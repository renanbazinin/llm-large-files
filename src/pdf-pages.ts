/**
 * Cuts pages out of a PDF into a small PDF of their own, so a model can be shown the real pages.
 * Needs the optional dependency "@cantoo/pdf-lib".
 *
 * Copying pages the way a PDF library offers it is not enough. A link to another page takes that
 * page's content along, and a resource dictionary that pages share takes along every image it
 * lists: the contents page of a report came out at 89% of its file. So, before copying:
 * - every page that is not wanted is replaced by an empty one, so a reference to it costs nothing;
 * - a wanted page gets its own resource dictionary, without the images it does not paint.
 */
import { getHeapStatistics } from "node:v8";
import type { PDFContext, PDFDict, PDFObject, PDFPage, PDFPageLeaf } from "@cantoo/pdf-lib";
import { formatBytes } from "./plan.js";

type PdfLibrary = typeof import("@cantoo/pdf-lib");

export type PageCut = {
  /** A PDF with pages `from` to `to` of the original. */
  bytes: Uint8Array;
  from: number;
  /** The last page in the cut. Lower than the page asked for when the pages did not all fit. */
  to: number;
  /** How many pages the original has. */
  pageCount: number;
};

/** Objects parsed between two pauses that let other work on the server run. */
const OBJECTS_PER_TICK = 4_000;
/** Memory one parsed object takes, measured on files of 300,000 objects (1.0 to 1.6 KB). */
const BYTES_PER_OBJECT = 1_700;
/** At 13 microseconds an object, a file past this takes over 13 seconds to parse. */
const MAX_OBJECTS = 1_000_000;
/** Content streams larger than this are not read to find out which images a page paints. */
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
/** Not needed to show a page, and able to hold a lot: editor data, article threads, actions, a thumbnail. */
const DROPPED_PAGE_ENTRIES = ["PieceInfo", "B", "AA", "Thumb"];
const UNREADABLE = "This PDF could not be read to cut pages from it. It may be damaged.";

/** Bytes as a string of the same length: each byte becomes the character with that code. */
export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

export async function loadPdfLibrary(): Promise<PdfLibrary> {
  try {
    return await import("@cantoo/pdf-lib");
  } catch {
    throw new Error("Showing PDF pages needs the optional dependency \"@cantoo/pdf-lib\".");
  }
}

/**
 * The content of a stream as text, one character per byte, or undefined when it cannot be had:
 * the stream is larger than `maxBytes`, uses a filter the library does not undo, or is damaged.
 */
export function decodeContent(library: PdfLibrary, context: PDFContext, stream: PDFObject | undefined, maxBytes: number): string | undefined {
  const { PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } = library;
  if (!(stream instanceof PDFRawStream) || stream.contents.length > maxBytes) return undefined;
  // The library does not undo a predictor, and would hand back bytes that are not the content.
  const parameters = stream.dict.lookup(PDFName.of("DecodeParms"));
  const list = parameters instanceof PDFArray ? parameters.asArray().map((entry) => context.lookup(entry)) : [parameters];
  if (list.some((entry) => entry instanceof PDFDict && entry.has(PDFName.of("Predictor")))) return undefined;
  try {
    return latin1(decodePDFRawStream(stream).decode());
  } catch {
    return undefined;
  }
}

/**
 * How many objects the file says it has: the largest /Size in its trailer or in its
 * cross-reference stream. Undefined when neither is found where a well-formed file has it.
 */
export function declaredObjectCount(bytes: Uint8Array): number | undefined {
  const text = (start: number, end: number) => latin1(bytes.subarray(Math.max(0, start), Math.min(bytes.length, end)));
  let found = 0;
  const read = (chunk: string) => {
    for (const match of chunk.matchAll(/\/Size[\s\0]+(\d{1,12})/g)) found = Math.max(found, Number(match[1]));
  };
  const tail = text(bytes.length - 2048, bytes.length);
  read(tail);
  // A cross-reference stream keeps /Size in its own dictionary, which can be far from the end.
  const start = [...tail.matchAll(/startxref[\s\0]+(\d{1,15})/g)].at(-1);
  if (start) {
    const offset = Number(start[1]);
    if (offset < bytes.length) read(text(offset, offset + 2048));
  }
  return found > 0 ? found : undefined;
}

/**
 * The library reads the whole file into objects before anything can be done with a page. The
 * number of objects a file declares, when that is more than `most` or more than this process can
 * hold; undefined when the file can be read.
 */
export function tooManyObjects(original: Uint8Array, most = MAX_OBJECTS): number | undefined {
  const objects = declaredObjectCount(original);
  if (objects === undefined) return undefined;
  const heap = getHeapStatistics();
  const free = heap.heap_size_limit - heap.used_heap_size;
  return objects > most || objects * BYTES_PER_OBJECT > free * 0.6 ? objects : undefined;
}

/** A PDF name as the characters it stands for, so that "#20" and a space are the same name. */
export function canonicalName(raw: string): string {
  let name = raw;
  // Until nothing changes: a library may keep an escape it did not decode as literal characters.
  for (;;) {
    const next = name.replace(/#([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === name) return name;
    name = next;
  }
}

const REGULAR_CHARACTER = "[^\\x00\\t\\n\\f\\r /\\[\\]<>(){}%]";
/** `/Name Do`: the operator that paints an image or a form. */
const PAINTED = new RegExp(`/(${REGULAR_CHARACTER}*)[\\x00\\t\\n\\f\\r ]+Do(?!${REGULAR_CHARACTER})`, "g");

/**
 * Gives a page its own resource dictionary without the images it does not paint. FPDF, TCPDF,
 * jsPDF and others list every image of the file in one dictionary that all pages share.
 *
 * It only keeps more than is needed, never less: a name found anywhere in the content counts as
 * painted, and nothing is dropped unless every stream that can name an image of this dictionary
 * was read.
 */
function dropUnusedImages(library: PdfLibrary, context: PDFContext, page: PDFPageLeaf): void {
  const { PDFArray, PDFDict, PDFName, PDFStream } = library;
  const key = (value: string) => PDFName.of(value);
  const resources = page.Resources();
  if (!resources) return;
  const xobjects = resources.lookup(key("XObject"));
  if (!(xobjects instanceof PDFDict)) return;
  const entries = xobjects.entries();
  if (entries.length < 2) return;
  const byName = new Map(entries.map(([name, value]) => [canonicalName(name.asString().slice(1)), value]));

  let readable = true;
  /** Names found in content that looks them up in this page's dictionary, still to be followed. */
  const found: string[] = [];
  const decode = (stream: PDFObject | undefined) => decodeContent(library, context, stream, MAX_CONTENT_BYTES);
  const read = (text: string) => {
    for (const match of text.matchAll(PAINTED)) found.push(canonicalName(match[1]!));
  };
  const readStream = (stream: PDFObject | undefined) => {
    const text = decode(stream);
    if (text === undefined) readable = false;
    else read(text);
  };
  // A form, a pattern, a Type 3 glyph or an annotation's appearance that has no resource dictionary
  // of its own (old PDFs allow that), or has this page's, takes its names from this page's
  // dictionary: read it. One with its own dictionary is independent, but can hold more content of
  // the first kind: look inside.
  const seen = new Set<PDFDict>();
  const content = (object: PDFObject | undefined) => {
    if (!(object instanceof PDFStream)) return;
    const own = object.dict.lookup(key("Resources"));
    if (own instanceof PDFDict && own !== resources) inside(own);
    else readStream(object);
  };
  const patternsAndFonts = (dictionary: PDFDict) => {
    const patterns = dictionary.lookup(key("Pattern"));
    if (patterns instanceof PDFDict) for (const [, value] of patterns.entries()) content(context.lookup(value));
    const fonts = dictionary.lookup(key("Font"));
    if (!(fonts instanceof PDFDict)) return;
    for (const [, value] of fonts.entries()) {
      const font = context.lookup(value);
      if (!(font instanceof PDFDict) || font.lookup(key("Subtype")) !== key("Type3")) continue;
      const own = font.lookup(key("Resources"));
      if (own instanceof PDFDict && own !== resources) {
        inside(own);
        continue;
      }
      const glyphs = font.lookup(key("CharProcs"));
      if (glyphs instanceof PDFDict) for (const [, glyph] of glyphs.entries()) readStream(context.lookup(glyph));
    }
  };
  const inside = (dictionary: PDFDict) => {
    if (seen.has(dictionary)) return;
    seen.add(dictionary);
    const forms = dictionary.lookup(key("XObject"));
    if (forms instanceof PDFDict) {
      for (const [, value] of forms.entries()) {
        const object = context.lookup(value);
        if (object instanceof PDFStream && object.dict.lookup(key("Subtype")) === key("Form")) content(object);
      }
    }
    patternsAndFonts(dictionary);
  };

  // 1. The page's own content. Split over several streams it is still one text: "/Im1" may end one
  //    stream and "Do" start the next.
  const contents = page.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((entry) => context.lookup(entry)) : contents ? [contents] : [];
  const parts = streams.map(decode);
  if (parts.includes(undefined)) readable = false;
  else read(parts.join(" "));
  // 2. The page's patterns and Type 3 fonts, and what its annotations show. Which of them the page
  //    uses is not worked out: all count.
  patternsAndFonts(resources);
  const annotations = page.Annots();
  if (annotations) {
    for (const entry of annotations.asArray()) {
      const annotation = context.lookup(entry);
      const appearances = annotation instanceof PDFDict ? annotation.lookup(key("AP")) : undefined;
      if (!(appearances instanceof PDFDict)) continue;
      for (const [, value] of appearances.entries()) {
        const appearance = context.lookup(value);
        if (appearance instanceof PDFStream) content(appearance);
        else if (appearance instanceof PDFDict) for (const [, state] of appearance.entries()) content(context.lookup(state));
      }
    }
  }
  // 3. Follow what is painted: a form that is painted paints more.
  const painted = new Set<string>();
  while (found.length > 0) {
    const next = found.pop()!;
    if (painted.has(next)) continue;
    painted.add(next);
    const value = byName.get(next);
    const object = value ? context.lookup(value) : undefined;
    if (object instanceof PDFStream && object.dict.lookup(key("Subtype")) === key("Form")) content(object);
  }
  if (!readable) return;

  const kept = entries.filter(([name]) => painted.has(canonicalName(name.asString().slice(1))));
  if (kept.length === entries.length) return;
  const fewer = context.obj({});
  for (const [name, value] of kept) fewer.set(name, value);
  const own = resources.clone(context);
  own.set(key("XObject"), fewer);
  page.set(key("Resources"), own);
}

/** A PDF with pages `from` to `last` of `source`. Changes `source`: use it only for smaller cuts afterwards. */
async function copyPages(library: PdfLibrary, source: import("@cantoo/pdf-lib").PDFDocument, pages: PDFPage[], from: number, last: number): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFObjectCopier, PDFPage: Page, PDFPageLeaf: Leaf } = library;
  const { context } = source;
  const wanted = pages.slice(from - 1, last);
  const wantedReferences = new Set(wanted.map((page) => page.ref));
  // Every other page becomes an empty one, so a link, a form field or a thread that leads to it
  // copies a few bytes and not the page.
  for (const page of pages) {
    if (!wantedReferences.has(page.ref)) context.assign(page.ref, context.obj({ Type: "Page" }));
  }
  for (const page of wanted) {
    for (const entry of DROPPED_PAGE_ENTRIES) page.node.delete(PDFName.of(entry));
    try {
      dropUnusedImages(library, context, page.node);
    } catch {
      // An unusual resource dictionary: the page is copied with everything it lists.
    }
  }
  const target = await PDFDocument.create({ updateMetadata: false });
  // One copier for everything, and each page copied through its reference: an annotation's /P then
  // points at the copied page, and the layer settings below name the layers the pages use.
  const copier = PDFObjectCopier.for(context, target.context);
  for (const page of wanted) {
    const reference = copier.copy(page.ref);
    const node = target.context.lookup(reference);
    if (!(node instanceof Leaf)) throw new Error("A page of this PDF is not a page object.");
    target.addPage(Page.of(node, reference, target));
  }
  // Without these, a layer that the file hides would be shown.
  const layers = source.catalog.get(PDFName.of("OCProperties"));
  if (layers) target.catalog.set(PDFName.of("OCProperties"), copier.copy(layers));
  return target.save();
}

/**
 * Cuts pages `from` to `to` (1-based, inclusive) out of a PDF. When the cut is larger than
 * `maxBytes`, pages are left off the end until it fits; `to` in the result says where it stopped.
 * Throws an Error whose message can be shown to a model: for a file that cannot be opened, a page
 * that does not exist, and a first page that does not fit by itself.
 *
 * `expectedPages` is the page count the text of the file was extracted with. The text came from
 * another PDF reader; if the two do not count the same pages, a page number may not mean the same
 * page in both, and showing the wrong page is worse than showing none.
 */
export async function cutPdfPages(original: Uint8Array, from: number, to: number, maxBytes: number, expectedPages?: number): Promise<PageCut> {
  const library = await loadPdfLibrary();
  // Refuse a file that says it has more objects than this process can hold, instead of running out of memory.
  const objects = tooManyObjects(original);
  if (objects !== undefined) throw new Error(`This PDF has ${objects.toLocaleString("en-US")} objects, too many to cut pages from it in memory.`);
  let source: import("@cantoo/pdf-lib").PDFDocument;
  let pages: PDFPage[];
  try {
    // An empty password opens the many PDFs that are encrypted only to restrict printing or copying.
    source = await library.PDFDocument.load(original, { updateMetadata: false, parseSpeed: OBJECTS_PER_TICK, password: "" });
    pages = source.getPages();
  } catch (error) {
    const needsPassword = /password/i.test(error instanceof Error ? error.message : String(error));
    throw new Error(needsPassword ? "This PDF needs a password to open, so its pages cannot be shown." : UNREADABLE);
  }
  const pageCount = pages.length;
  // A damaged file can be read as a file without pages: the library skips what it cannot parse.
  if (pageCount === 0) throw new Error(UNREADABLE);
  if (expectedPages !== undefined && pageCount !== expectedPages) {
    throw new Error(`The pages of this PDF could not be matched to its text (${pageCount} pages against ${expectedPages}), so they cannot be shown.`);
  }
  if (from < 1 || from > pageCount) throw new Error(`There is no page ${from}: the file has ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`);
  let smallest = 0;
  for (let last = Math.min(Math.max(to, from), pageCount); last >= from; last--) {
    let bytes: Uint8Array;
    try {
      bytes = await copyPages(library, source, pages, from, last);
    } catch {
      throw new Error("The pages could not be cut out of this PDF. It may be damaged.");
    }
    if (bytes.length <= maxBytes) return { bytes, from, to: last, pageCount };
    smallest = bytes.length;
  }
  throw new Error(`Page ${from} is ${formatBytes(smallest)} as a file, more than the ${formatBytes(Math.max(0, maxBytes))} that fit in this request.`);
}
