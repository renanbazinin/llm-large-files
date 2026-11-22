/**
 * Cuts pages out of a PDF into a small PDF of their own, so a model can be shown the real pages.
 * Needs the optional dependency "@cantoo/pdf-lib".
 *
 * Copying pages the way a PDF library offers it is not enough. A link to another page takes that
 * page's content along, and a resource dictionary that pages share takes along every image it
 * lists: the contents page of a report came out at 89% of its file. So, before copying:
 * - every page that is not wanted is set to null, so a reference to it costs nothing;
 * - a wanted page gets its own resource dictionary, without the images it does not paint.
 */
import { getHeapStatistics } from "node:v8";
import { importPeer } from "./peers.js";
import type { PDFContext, PDFDict, PDFObject, PDFObjectCopier, PDFPage, PDFPageLeaf, PDFRef } from "@cantoo/pdf-lib";
import { TimeSlicer } from "./pause.js";
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

/**
 * Objects parsed between two pauses that let other work on the server run, when the parse cannot
 * be paused by time (see `loadPdf`). A count is a poor measure: 500 objects of large arrays took
 * 100 to 180 ms.
 */
export const OBJECTS_PER_TICK = 500;
/** Pauses while one file is parsed, at most. Each is a timer: about 15 ms on Windows, 1 ms elsewhere. */
const MOST_TICKS = 100;
const MOST_OBJECTS_PER_TICK = 4_000;

/**
 * The `parseSpeed` for pdf-lib: `OBJECTS_PER_TICK`, or more for a file that declares so many
 * objects that pausing that often would add seconds of waiting (300 pauses of 15 ms for 150,000).
 */
export function objectsPerTick(bytes: Uint8Array): number {
  const objects = declaredObjectCount(bytes) ?? 0;
  return Math.min(MOST_OBJECTS_PER_TICK, Math.max(OBJECTS_PER_TICK, Math.ceil(objects / MOST_TICKS)));
}

/**
 * Work between two pauses of a parse, at least. A slice also runs twice as long as a pause took,
 * up to `MOST_PARSE_SLICE_MS`: a pause is a timer, which waits about 15 ms on Windows and 1 ms
 * elsewhere, and waiting should not take most of the parse.
 */
const PARSE_SLICE_MS = 12;
const MOST_PARSE_SLICE_MS = 40;

/** What pdf-lib's parsers and writers offer to change how they pause. Not in its types: checked before use. */
type Pausing = { shouldWaitForTick?: unknown };
/** What pdf-lib's cross-reference stream keeps. Not in its types: checked before use. */
type CrossReferences = { entries?: unknown; appendEntry?: unknown };
type CrossReference = { ref?: { objectNumber?: unknown } };

/** The files `loadPdf` is reading, each with how many reads of it are running. */
const timedFiles = new WeakMap<Uint8Array, number>();
/** The documents (their contexts) that `copyPages` saves. */
const timedSaves = new WeakSet<object>();
/** The factories of pdf-lib changed here, by class: one class for each copy of pdf-lib loaded. */
const changedFactories = new WeakMap<object, Set<string>>();

/**
 * pdf-lib asks after each object it parses or writes whether to pause, and pauses with a timer
 * when told so. This answers by time: once a slice of work has run its length. The time of the
 * pauses is not counted.
 */
function pauseByTime(): () => boolean {
  let sliceStart = performance.now();
  let pausedAt: number | undefined;
  /** The shortest pause seen, with the one object parsed after it. */
  let pauseMs = 0;
  return () => {
    const now = performance.now();
    if (pausedAt !== undefined) {
      pauseMs = pauseMs === 0 ? now - pausedAt : Math.min(pauseMs, now - pausedAt);
      pausedAt = undefined;
      sliceStart = now;
      return false;
    }
    if (now - sliceStart < Math.min(MOST_PARSE_SLICE_MS, Math.max(PARSE_SLICE_MS, 2 * pauseMs))) return false;
    pausedAt = now;
    return true;
  };
}

/** Makes a parser or a writer of pdf-lib pause by time. */
function pauseInTime(made: unknown): void {
  const pausing = made as Pausing | undefined;
  if (typeof pausing?.shouldWaitForTick === "function") pausing.shouldWaitForTick = pauseByTime();
}

/**
 * Has `change` look at what `owner[name]`, a static factory of one of pdf-lib's classes, creates,
 * with the first argument it was given: once for each class. Any other use of pdf-lib in the
 * process is left as it was. A version of pdf-lib built otherwise is left as it is: its parse and
 * its writer pause by the count they are given.
 */
function changeFactory(owner: unknown, name: string, change: (first: unknown, made: unknown) => void): void {
  if (typeof owner !== "function") return;
  const factories = owner as unknown as Record<string, unknown>;
  const create = factories[name];
  const done = changedFactories.get(owner) ?? new Set<string>();
  if (typeof create !== "function" || done.has(name)) return;
  try {
    factories[name] = (first: unknown, ...rest: unknown[]) => {
      const made: unknown = create.call(owner, first, ...rest);
      change(first, made);
      return made;
    };
    done.add(name);
    changedFactories.set(owner, done);
  } catch {
    // A class that cannot be changed.
  }
}

/** Makes pdf-lib's parsers of the files in `timedFiles` pause by time. */
function timeParsers(library: PdfLibrary): void {
  const parsers = (library as unknown as { PDFParser?: unknown }).PDFParser;
  changeFactory(parsers, "forBytesWithOptions", (bytes, parser) => {
    if (timedFiles.has(bytes as Uint8Array)) pauseInTime(parser);
  });
}

/**
 * Makes pdf-lib's writers of the documents in `timedSaves` pause by time. Left to itself, a writer
 * of a cut never paused: it counts objects, and the objects it packs into streams 50 at a time
 * make the count miss every multiple of 50 it pauses at.
 *
 * The writer also adds each object to its cross-reference stream by searching all the entries
 * added so far for where it goes, though the objects come in order: the time grows with the square
 * of their count, 0.5 s in one block for 20,000 objects. For these documents an entry that goes
 * after the last one is added at the end at once, which gives the same entries in the same order.
 */
function timeWriters(library: PdfLibrary): void {
  const classes = library as unknown as { PDFWriter?: unknown; PDFStreamWriter?: unknown; PDFCrossRefStream?: unknown };
  for (const writers of [classes.PDFWriter, classes.PDFStreamWriter]) {
    changeFactory(writers, "forContext", (context, writer) => {
      if (timedSaves.has(context as object)) pauseInTime(writer);
    });
  }
  // The writer makes its stream with a dictionary of the document it writes.
  changeFactory(classes.PDFCrossRefStream, "create", (dictionary, stream) => {
    const context = (dictionary as { context?: unknown } | undefined)?.context;
    if (typeof context === "object" && context !== null && timedSaves.has(context)) appendInOrder(stream);
  });
}

/** Adds an entry that goes after the last one to the end of `stream` at once. Entries are kept by object number. */
function appendInOrder(stream: unknown): void {
  const references = stream as CrossReferences | undefined;
  const append = references?.appendEntry;
  if (!references || typeof append !== "function" || !Array.isArray(references.entries)) return;
  references.appendEntry = (entry: CrossReference) => {
    const entries = references.entries as CrossReference[];
    const last = entries.at(-1)?.ref?.objectNumber;
    const number = entry?.ref?.objectNumber;
    if (typeof last === "number" && typeof number === "number" && last <= number) entries.push(entry);
    else append.call(references, entry);
  };
}

/**
 * Reads a PDF into objects with pdf-lib, which cannot be stopped once it has started, and pauses
 * after every 12 to 40 ms of work so that other requests get a turn. pdf-lib itself pauses by a
 * count of objects, and objects differ in cost a hundred times: a count of 500 held the server for
 * 100 to 180 ms on a file of large arrays, and a file of 150,000 objects, parsed 1,500 at a time,
 * for 0.2 to 0.55 s. What pdf-lib reads in one step still holds the server for as long as it
 * takes, and grows with the file: one object (about 0.15 s for each MB of an array of numbers,
 * about 0.03 s for each MB of a stream whose length the file does not give directly), and a
 * cross-reference table written as text (0.15 s for 150,000 objects).
 *
 * The file is read with an empty password, which opens the many PDFs that are encrypted only to
 * restrict printing or copying. Throws what pdf-lib throws.
 */
export async function loadPdf(library: PdfLibrary, bytes: Uint8Array): Promise<import("@cantoo/pdf-lib").PDFDocument> {
  timeParsers(library);
  timedFiles.set(bytes, (timedFiles.get(bytes) ?? 0) + 1);
  try {
    // parseSpeed pauses the parse by count, when it could not be timed.
    return await library.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: objectsPerTick(bytes), password: "" });
  } finally {
    const reads = (timedFiles.get(bytes) ?? 1) - 1;
    if (reads > 0) timedFiles.set(bytes, reads);
    else timedFiles.delete(bytes);
  }
}

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
  return importPeer("@cantoo/pdf-lib", () => import("@cantoo/pdf-lib"), "Showing PDF pages needs the optional dependency \"@cantoo/pdf-lib\".");
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

/**
 * Decodings that may still change a name. A library may keep an escape it did not decode as
 * literal characters, so a name is decoded again; no writer escapes a name more deeply than that.
 */
const NAME_DECODINGS = 3;

/**
 * A PDF name as the characters it stands for, so that "#20" and a space are the same name.
 * Undefined for a name that still changes after `NAME_DECODINGS` decodings: only a file built to
 * hold the server writes one ("#2323...2341" loses one level a decoding, and decoding it until
 * nothing changed took 20 s for 400,000 characters). Callers treat it as a name they cannot read.
 */
export function canonicalName(raw: string): string | undefined {
  let name = raw;
  for (let decoding = 0; decoding <= NAME_DECODINGS; decoding++) {
    if (!name.includes("#")) return name;
    const next = name.replace(/#([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === name) return name;
    name = next;
  }
  return undefined;
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
  const names = entries.map(([name]) => canonicalName(name.asString().slice(1)));
  // A name that cannot be read cannot be matched with what the content paints: keep every image.
  if (names.includes(undefined)) return;
  const byName = new Map(entries.map(([, value], index) => [names[index]!, value]));

  let readable = true;
  /** Names found in content that looks them up in this page's dictionary, still to be followed. */
  const found: string[] = [];
  const decode = (stream: PDFObject | undefined) => decodeContent(library, context, stream, MAX_CONTENT_BYTES);
  const read = (text: string) => {
    for (const match of text.matchAll(PAINTED)) {
      const name = canonicalName(match[1]!);
      if (name === undefined) readable = false;
      else found.push(name);
    }
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

  const kept = entries.filter((_entry, index) => painted.has(names[index]!));
  if (kept.length === entries.length) return;
  const fewer = context.obj({});
  for (const [name, value] of kept) fewer.set(name, value);
  const own = resources.clone(context);
  own.set(key("XObject"), fewer);
  page.set(key("Resources"), own);
}

/** A PDF with pages `from` to `last` of `source`. Changes `source`: use it only for smaller cuts afterwards. */
async function copyPages(library: PdfLibrary, source: import("@cantoo/pdf-lib").PDFDocument, pages: PDFPage[], from: number, last: number): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFNull, PDFObjectCopier, PDFPage: Page, PDFPageLeaf: Leaf } = library;
  const { context } = source;
  const wanted = pages.slice(from - 1, last);
  const wantedReferences = new Set(wanted.map((page) => page.ref));
  // Every other page becomes nothing, so a link, a form field or a thread that leads to it copies
  // a few bytes and not the page. (Null, not an empty page: the cut must not hold objects that
  // call themselves pages and are not among its pages.)
  for (const page of pages) {
    if (!wantedReferences.has(page.ref)) context.assign(page.ref, PDFNull);
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
  // Without these, a layer that the file hides would be shown.
  const layers = source.catalog.get(PDFName.of("OCProperties"));
  const roots: PDFObject[] = wanted.map((page) => page.ref);
  await copyInTurns(library, copier, context, target.context, layers ? [...roots, layers] : roots);
  for (const page of wanted) {
    const reference = copier.copy(page.ref);
    const node = target.context.lookup(reference);
    if (!(node instanceof Leaf)) throw new Error("A page of this PDF is not a page object.");
    target.addPage(Page.of(node, reference, target));
  }
  if (layers) target.catalog.set(PDFName.of("OCProperties"), copier.copy(layers));
  timeWriters(library);
  timedSaves.add(target.context);
  return target.save();
}

/**
 * Does the work of `copier.copy(root)` for each of `roots`, with pauses so that other requests get
 * a turn. pdf-lib's copier follows every reference at once: a page that refers to 4,000 large
 * arrays held the server for 0.3 s, and one that refers to 20,000 for 0.9 s. So the objects are
 * first numbered in the order the copier would number them, which keeps the cut the same to the
 * byte, then copied one at a time. `copier.copy(root)` afterwards finds them copied. A copier built
 * otherwise is left to copy everything at once.
 */
async function copyInTurns(library: PdfLibrary, copier: PDFObjectCopier, source: PDFContext, target: PDFContext, roots: PDFObject[]): Promise<void> {
  const copied = (copier as unknown as { traversedObjects?: unknown }).traversedObjects;
  if (!(copied instanceof Map)) return;
  const { PDFArray, PDFDict, PDFName, PDFPageLeaf: Leaf, PDFRef, PDFStream } = library;
  const slicer = new TimeSlicer();
  /** Each object referred to, with its number in the cut, in the order the copier numbers them. */
  const numbered: [PDFRef, PDFRef][] = [];
  const seen = new Set<PDFObject>();
  /** What the copier copies next, when it copies `object`: undefined when there is nothing more. */
  const inside = (object: PDFObject): PDFObject[] | undefined => {
    if (object instanceof PDFRef) {
      if (copied.has(object)) return undefined;
      const reference = target.nextRef();
      copied.set(object, reference);
      numbered.push([object, reference]);
      const value = source.lookup(object);
      return value ? [value] : undefined;
    }
    if (object instanceof Leaf) {
      // As the copier copies a page: with what it inherits from the page tree, without its parent.
      const page = object.clone();
      for (const name of Leaf.InheritableEntries) {
        const key = PDFName.of(name);
        const value = page.getInheritableAttribute(key);
        if (!page.get(key) && value) page.set(key, value);
      }
      page.delete(PDFName.of("Parent"));
      return page.entries().map(([, value]) => value);
    }
    if (!(object instanceof PDFDict || object instanceof PDFArray || object instanceof PDFStream) || seen.has(object)) return undefined;
    seen.add(object);
    if (object instanceof PDFArray) return object.asArray();
    return (object instanceof PDFStream ? object.dict : object).entries().map(([, value]) => value);
  };
  // Depth first, each object before what it refers to, as the copier goes.
  const stack: { items: PDFObject[]; at: number }[] = [];
  const enter = (object: PDFObject) => {
    const items = inside(object);
    if (items !== undefined && items.length > 0) stack.push({ items, at: 0 });
  };
  let steps = 0;
  for (const root of roots) {
    enter(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.at === top.items.length) stack.pop();
      else enter(top.items[top.at++]!);
      if (++steps % 1_000 === 0) await slicer.maybePause();
    }
  }
  for (const [original, reference] of numbered) {
    const value = source.lookup(original);
    if (value) target.assign(reference, copier.copy(value));
    await slicer.maybePause();
  }
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
    source = await loadPdf(library, original);
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
