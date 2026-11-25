/**
 * Finds a page of a PDF that would hold the server for a long time while pdf.js reads its text,
 * before pdf.js reads any page.
 *
 * pdf.js reads the text of a page in one go: until it is done, no timer and no other request runs,
 * and nothing stops it. What it runs for a page:
 * - the content of the page;
 * - each form the content paints, again each time it is painted, with what that form paints. A
 *   form that shows no text is skipped after its first paint in the same content;
 * - each font the content sets, the first time any page sets it: the font program and its maps are
 *   read, and every glyph program of a Type3 font is run, with the forms, patterns and soft masks
 *   it paints (each form again each time). Images in glyphs are not decoded to read text.
 * This adds that up from the structure of the file, read with @cantoo/pdf-lib, without running
 * anything. Where it cannot tell, it counts high: every name before a `Do` may be the one painted,
 * and a form with anything that looks like a text operator shows text. It follows pdf.js 5.4
 * (unpdf 1.4); another version of pdf.js may run more.
 *
 * Units are about one byte of content: pdf.js read 160 MB of text operators in 23 to 29 s, about
 * 0.16 µs a byte. A form costs more than its bytes each time it is run (`TEXT_PAINT`,
 * `GLYPH_PAINT`).
 */
import { createInflate, inflateSync } from "node:zlib";
import type { PDFDict, PDFDocument, PDFObject, PDFRawStream } from "@cantoo/pdf-lib";
import { TimeSlicer } from "./pause.js";
import { canonicalName, DecodedTooMuch, latin1, limitDecoders } from "./pdf-pages.js";

type PdfLibrary = typeof import("@cantoo/pdf-lib");
type Mode = "text" | "glyph";
/**
 * What a run of content costs, and whether pdf.js would find text in it. `reach`: the depth of the
 * shallowest open form it paints again, which pdf.js skips (Infinity when none).
 */
type Cost = { units: number; text: boolean; reach: number };
/** The forms being run, each with its depth: pdf.js skips a form that is already open. */
type Path = Map<PDFObject, number>;

/**
 * A form run for its text, each time: pdf.js took 75 to 85 µs (one form painted 10,000 times, or
 * forms inside forms 2 to 4 deep), and about 100 µs in an earlier run of forms 3 to 6 deep.
 */
export const TEXT_PAINT = 640;
/** A form run inside a Type3 glyph, each time: about 23 µs measured, and 1.8 KB kept until the page is read. */
export const GLYPH_PAINT = 256;
/**
 * A page may run this much whatever the size of its file: about 1 to 1.5 s of pdf.js. The pages
 * of the documents tested run 0.01 to 0.18 million units.
 */
export const PAGE_WORK_ALLOWANCE = 8 * 1024 * 1024;
/**
 * Past the allowance, a page may run this many times the size of the whole file. The content of
 * real pages is packed 3 to 10 times; a page past this draws far more than its file can explain.
 */
export const PAGE_WORK_EXPANSION = 32;
/**
 * The pages of a file together may run this many pages' limits, and no more content is decoded
 * to check it: 60 pages that show one 4 MB stream of a 25 KB file kept pdf.js busy for 40 s.
 */
const FILE_WORK_PAGES = 4;
/**
 * What looking at one entry of a resource dictionary costs the check, against the same budget as
 * the content it decodes: content can make it look through a dictionary of a million entries again
 * and again (a 4 MB file made it fill 4 GB). Real pages look at tens of entries.
 */
const VISIT = 16;
/** A resource dictionary with more entries than this is kept apart: not compared with others. */
const MAX_COMPARED = 4_096;
/** Forms inside forms that are followed, at most. Real files nest a few. */
const MAX_DEPTH = 64;
/** Content decoded by @cantoo/pdf-lib, which keeps all it decodes: past this one stream is refused. */
const MAX_KEPT = 64 * 1024 * 1024;
/** Decoded content is read in pieces of this size, and decoded in one go below `SMALL`. */
const PIECE = 64 * 1024;
const SMALL = 1024 * 1024;
/** Distinct names kept between two `Do`s. Past it, every drawing the content can name may be painted. */
const MAX_NAMES = 10_000;
/** A token longer than this is not a name of the file: the content may name any of its drawings. */
const MAX_TOKEN = 4_096;

/**
 * Why a file is refused: a page runs more than the limit (`heavy`), the pages together hold far
 * more content than the file (`file`), or a page's content cannot be measured here (`unreadable`).
 */
export class HeavyPage extends Error {
  constructor(readonly reason: "heavy" | "file" | "unreadable", readonly page = 0) {
    super(reason);
  }
}

const REGULAR = "[^\\x00\\t\\n\\f\\r /\\[\\]<>(){}%]";
/** A name, or the operator `Do`, read with no regard to strings and comments: over, never under. */
const TOKEN = new RegExp(`/(${REGULAR}*)|(?<!${REGULAR})Do(?!${REGULAR})`, "g");
/** White space and delimiters of PDF syntax, by character code. */
const SPECIAL = new Uint8Array(256);
for (const character of "\x00\t\n\f\r /[]<>(){}%") SPECIAL[character.charCodeAt(0)] = 1;
/** What pdf.js could turn into text: Tj, TJ, ' and ". */
const TEXT_OPERATOR = /Tj|TJ|['"]/;

/**
 * Reads the decoded content of a run a piece at a time: its length, whether it may show text,
 * and the names written before each `Do` (a window). The content is split into tokens at white
 * space and delimiters only, so a `Do` or a name inside a string or a comment counts too: pdf.js
 * paints at most what this finds, whatever the content hides in strings, comments and images.
 */
class Scan {
  length = 0;
  text = false;
  /** Names written anywhere: the fonts, patterns and shadings that may be set. Null: any. */
  seen: Set<string> | null = new Set();
  /** The windows closed since `take` was last called. Null: any drawing may be painted. */
  private windows: Array<Set<string> | null> = [];
  private names: Set<string> | null = new Set();
  private carry = "";
  private last = "";

  feed(piece: string): void {
    this.length += piece.length;
    if (!this.text && TEXT_OPERATOR.test(this.last + piece)) this.text = true;
    this.last = piece.slice(-1);
    const text = this.carry + piece;
    // A token cut at the end of the piece goes on in the next one. A name keeps its "/".
    let cut = text.length;
    while (cut > 0 && SPECIAL[text.charCodeAt(cut - 1)] !== 1) cut--;
    if (cut > 0 && text.charCodeAt(cut - 1) === 47) cut--;
    this.tokens(text.slice(0, cut));
    this.carry = text.slice(cut);
    if (this.carry.length > MAX_TOKEN) {
      this.names = null;
      this.seen = null;
      this.carry = "";
    }
  }

  /**
   * The end of one stream of a page's content. pdf.js joins the next one to it with nothing
   * between, so a token cut here goes on in the next stream; it is also read as ending here.
   */
  boundary(): void {
    if (this.carry) this.tokens(`${this.carry} `);
  }

  end(): void {
    this.tokens(`${this.carry} `);
    this.carry = "";
  }

  /**
   * Content whose tokens cannot be read (stored with a predictor): it may show text, set anything,
   * and paint any drawing it can name once every 4 bytes ("/ Do" is the shortest paint).
   */
  blind(length: number): void {
    this.length += length;
    this.text = true;
    this.seen = null;
    this.names = null;
    this.blindPaints += Math.ceil(length / 4);
  }

  /** Paints in content that `blind` counted, since `take` was last called. */
  private blindPaints = 0;

  /** The windows closed since the last call, each with how many paints it stands for. */
  take(): Array<[Set<string> | null, number]> {
    const taken: Array<[Set<string> | null, number]> = this.windows.map((window) => [window, 1]);
    if (this.blindPaints > 0) taken.push([null, this.blindPaints]);
    this.windows = [];
    this.blindPaints = 0;
    return taken;
  }

  private tokens(text: string): void {
    for (const match of text.matchAll(TOKEN)) {
      if (match[1] !== undefined) {
        const name = canonicalName(match[1]);
        if (name === undefined) {
          // A name that cannot be read may be any of them.
          this.names = null;
          this.seen = null;
          continue;
        }
        if (this.names && this.names.add(name).size > MAX_NAMES) this.names = null;
        if (this.seen && this.seen.add(name).size > MAX_NAMES) this.seen = null;
      } else {
        this.windows.push(this.names);
        this.names = new Set();
      }
    }
  }
}

/** The entries of a resource dictionary of one kind, by name as content writes it, each once. */
type Named = Map<string, PDFObject[]>;
const NONE: Named = new Map();

/** The resource dictionaries' kinds that change what content costs. */
const KINDS = ["XObject", "Font", "ExtGState", "Pattern", "Shading"];

class PageWork {
  /** The cost of a form (or a pattern) run with resources, by `resourcesKey`. */
  private readonly memo: Record<Mode, Map<PDFObject, Map<string, Cost>>> = { text: new Map(), glyph: new Map() };
  /**
   * The entries of each dictionary of one kind of resource (XObject, Font...), kept by that
   * dictionary: many resource dictionaries can share one, so it is read once, whatever its size.
   */
  private readonly named = new Map<PDFDict, Named>();
  /** Every entry of a dictionary once: what content that may name anything may use. */
  private readonly every = new WeakMap<Named, PDFObject[]>();
  /** A number for each such dictionary, the same for dictionaries written the same. */
  private readonly groupIds = new Map<PDFDict, number>();
  private readonly groupTexts = new Map<string, number>();
  private readonly keys = new Map<PDFDict, string>();
  private readonly ids = new Map<PDFObject, number>();
  /** The units of the content of pages measured so far, by content stream and `resourcesKey`. */
  private readonly pages = new Map<PDFObject, Map<string, number>>();
  /** Fonts read so far: pdf.js reads a font once for the whole file. */
  private readonly fonts = new Set<PDFObject>();
  /** Content decoded and entries looked at so far, for the whole file, against `budget`. */
  private spent = 0;
  /** Fonts read for the page being measured. */
  private extra = 0;

  constructor(
    private readonly library: PdfLibrary,
    private readonly document: PDFDocument,
    private readonly limit: number,
    private readonly budget: number,
    private readonly slicer: TimeSlicer,
  ) {}

  /** The units pdf.js would run for the text of a page. Throws `HeavyPage` past the limit. */
  async page(contents: PDFObject[], resources: PDFDict | undefined): Promise<number> {
    this.extra = 0;
    // Pages that show the same content with the same resources cost the same: it is read once here
    // (pdf.js runs it for each page, between which other requests get a turn).
    const single = contents.length === 1 ? this.lookup(contents[0]) : undefined;
    const key = this.resourcesKey(resources);
    const known = single ? this.pages.get(single)?.get(key) : undefined;
    if (known !== undefined) return known;
    const { units } = await this.run(contents, resources, "text", new Map());
    const total = units + this.extra;
    if (total > this.limit) throw new HeavyPage("heavy");
    if (single) {
      let byResources = this.pages.get(single);
      if (!byResources) this.pages.set(single, (byResources = new Map()));
      byResources.set(key, units);
    }
    return total;
  }

  /**
   * Resource dictionaries that name the same objects the same way give content the same cost.
   * Pages often have dictionaries of their own written the same, so this is what costs are kept by.
   */
  private resourcesKey(resources: PDFDict | undefined): string {
    if (!resources) return "";
    let key = this.keys.get(resources);
    if (key !== undefined) return key;
    key = KINDS.map((kind) => this.groupId(this.group(resources, kind))).join(" ");
    this.keys.set(resources, key);
    return key;
  }

  /** The number of a dictionary of one kind of resource: worked out once for each dictionary. */
  private groupId(group: PDFDict | undefined): number {
    if (!group) return -1;
    let known = this.groupIds.get(group);
    if (known !== undefined) return known;
    if (this.entriesOf(group).size > MAX_COMPARED) {
      // Sorting and writing out every entry would cost more than sharing a cost saves.
      this.groupIds.set(group, (known = -2 - this.groupIds.size));
      return known;
    }
    const id = (object: PDFObject) => {
      let number = this.ids.get(object);
      if (number === undefined) this.ids.set(object, (number = this.ids.size));
      return number;
    };
    const text = JSON.stringify([...this.entriesOf(group)]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, objects]) => [name, objects.map(id)]));
    known = this.groupTexts.get(text);
    if (known === undefined) this.groupTexts.set(text, (known = this.groupTexts.size));
    this.groupIds.set(group, known);
    return known;
  }

  private over(units: number): void {
    if (units + this.extra > this.limit) throw new HeavyPage("heavy");
  }

  /** Spends `amount` of the file's budget. Throws `HeavyPage` past it. */
  private spend(amount: number): void {
    this.spent += amount;
    if (this.spent > this.budget) throw new HeavyPage("file");
  }

  /** One entry of a resource dictionary looked at: it costs `VISIT`, and others get their turn. */
  private async visit(): Promise<void> {
    this.spend(VISIT);
    await this.slicer.maybePause();
  }

  private lookup(object: PDFObject | undefined): PDFObject | undefined {
    return object === undefined ? undefined : this.document.context.lookup(object);
  }


  /** The dictionary of `kind` (XObject, Font, Pattern, Shading, ExtGState) in a resource dictionary. */
  private group(resources: PDFDict | undefined, kind: string): PDFDict | undefined {
    const group = resources ? this.lookup(resources.get(this.library.PDFName.of(kind))) : undefined;
    return group instanceof this.library.PDFDict ? group : undefined;
  }

  /** The entries of `kind` in a resource dictionary. */
  private entries(resources: PDFDict | undefined, kind: string): Named {
    const group = this.group(resources, kind);
    return group ? this.entriesOf(group) : NONE;
  }

  private entriesOf(group: PDFDict): Named {
    let named = this.named.get(group);
    if (named) return named;
    // Names written apart can be one name ("/a" and "/#61"); an object listed many times counts once.
    const sets = new Map<string, Set<PDFObject>>();
    for (const [key, value] of group.entries()) {
      const object = this.lookup(value);
      if (object === undefined) continue;
      // A key that cannot be read keeps its escapes: no name read from content (which has none
      // left) can be the same, so only content that may name anything reaches it.
      const raw = key.asString().slice(1);
      const name = canonicalName(raw) ?? raw;
      let set = sets.get(name);
      if (!set) sets.set(name, (set = new Set()));
      set.add(object);
    }
    named = new Map([...sets].map(([name, set]) => [name, [...set]]));
    this.named.set(group, named);
    return named;
  }

  /** The entries of `kind` that `names` may name: all of them, each once, when `names` is null. */
  private pick(named: Named, names: Set<string> | null): PDFObject[] {
    if (names === null) {
      let all = this.every.get(named);
      if (!all) this.every.set(named, (all = [...new Set([...named.values()].flat())]));
      return all;
    }
    const picked: PDFObject[] = [];
    for (const name of names) {
      const objects = named.get(name);
      if (objects) picked.push(...objects);
    }
    return picked;
  }

  /**
   * The decoded content of a stream, a piece at a time, as pdf.js reads it: a stream it cannot
   * decode from the start is empty to it, and one damaged on the way gives what came before the
   * damage. Throws `HeavyPage` for content stored in a way pdf-lib does not decode.
   */
  private async *pieces(object: PDFObject | undefined): AsyncGenerator<string> {
    const { PDFArray, PDFName, PDFRawStream, UnsupportedEncodingError, decodePDFRawStream } = this.library;
    const stream = this.lookup(object);
    if (!(stream instanceof PDFRawStream)) return;
    const filter = this.lookup(stream.dict.get(PDFName.of("Filter")));
    const filters = filter instanceof PDFArray ? filter.asArray().map((entry) => this.lookup(entry)) : filter ? [filter] : [];
    const count = (piece: { length: number }) => this.spend(piece.length);
    const flate = filters.length === 1 && (filters[0] === PDFName.of("FlateDecode") || filters[0] === PDFName.of("Fl"));
    if (filters.length === 0 || flate) {
      let data = stream.contents;
      if (stream.transform) {
        // An encrypted file: decrypted first, with nothing else undone.
        data = decodePDFRawStream(PDFRawStream.of(this.document.context.obj({}), stream.contents, stream.transform)).decode();
      }
      if (!flate) {
        for (let at = 0; at < data.length; at += PIECE) {
          const piece = data.subarray(at, at + PIECE);
          count(piece);
          yield latin1(piece);
          await this.slicer.maybePause();
        }
        return;
      }
      let whole: Buffer | undefined;
      try {
        whole = inflateSync(data, { maxOutputLength: SMALL });
      } catch {
        // Larger than SMALL, or damaged: in pieces below.
      }
      if (whole) {
        count(whole);
        yield latin1(whole);
        return;
      }
      const inflate = createInflate({ chunkSize: PIECE });
      inflate.end(data);
      const output = (inflate as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      try {
        for (;;) {
          let next: IteratorResult<Buffer>;
          try {
            next = await output.next();
          } catch {
            return; // Damaged: pdf.js runs what came before.
          }
          if (next.done) return;
          count(next.value);
          yield latin1(next.value);
          await this.slicer.maybePause();
        }
      } finally {
        inflate.destroy();
      }
    }
    let decoder: ReturnType<typeof decodePDFRawStream>;
    try {
      decoder = decodePDFRawStream(stream);
    } catch (error) {
      // A filter pdf-lib does not have (pdf.js has more): the content cannot be measured.
      if (error instanceof UnsupportedEncodingError) throw new HeavyPage("unreadable");
      return;
    }
    // Read a piece at a time, pdf-lib's Flate decoder still decodes a block in one go, whatever
    // the block holds: behind a second filter, one block of 2 MB filled 320 MB before the count
    // below was looked at. Each decoder is held to what one stream may keep.
    const limited = limitDecoders(decoder, MAX_KEPT);
    const flateInside = filters.some((name) => name === PDFName.of("FlateDecode") || name === PDFName.of("Fl"));
    if (flateInside && limited < filters.length + (stream.transform ? 1 : 0)) throw new HeavyPage("unreadable");
    let kept = 0;
    for (;;) {
      let piece: Uint8Array;
      try {
        const bytes = decoder.getBytes(PIECE);
        piece = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (error) {
        if (error instanceof DecodedTooMuch) throw new HeavyPage("unreadable");
        // Damaged on the way: what was decoded before it, as pdf.js runs it.
        const state = decoder as unknown as { buffer?: Uint8Array; bufferLength?: number; pos?: number };
        if (state.buffer && typeof state.bufferLength === "number" && typeof state.pos === "number" && state.bufferLength > state.pos) {
          const rest = state.buffer.subarray(state.pos, state.bufferLength);
          count(rest);
          yield latin1(rest);
        }
        return;
      }
      if (piece.length === 0) return;
      count(piece);
      kept += piece.length;
      if (kept > MAX_KEPT) throw new HeavyPage("unreadable");
      yield latin1(piece);
      await this.slicer.maybePause();
    }
  }

  /**
   * Whether a stream is stored with a predictor. pdf-lib does not undo one (pdf.js does): what it
   * decodes is about as long as the content, but its tokens are not those of the content.
   */
  private predicted(object: PDFObject | undefined): boolean {
    const { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream } = this.library;
    const stream = this.lookup(object);
    if (!(stream instanceof PDFRawStream)) return false;
    const parameters = this.lookup(stream.dict.get(PDFName.of("DecodeParms")));
    const list = parameters instanceof PDFArray ? parameters.asArray().map((entry) => this.lookup(entry)) : [parameters];
    return list.some((entry) => {
      const value = entry instanceof PDFDict ? this.lookup(entry.get(PDFName.of("Predictor"))) : undefined;
      return value instanceof PDFNumber && value.asNumber() > 1;
    });
  }

  private async length(stream: PDFObject | undefined): Promise<number> {
    let length = 0;
    for await (const piece of this.pieces(stream)) length += piece.length;
    return length;
  }

  /**
   * Runs content as pdf.js would for text (`text`), or for a glyph of a Type3 font (`glyph`), and
   * returns what it costs. `path` holds the forms being run, each with its depth.
   */
  private async run(contents: PDFObject[], resources: PDFDict | undefined, mode: Mode, path: Path): Promise<Cost> {
    const { PDFName, PDFRawStream } = this.library;
    const scan = new Scan();
    const drawings = this.entries(resources, "XObject");
    const form = PDFName.of("Form");
    const subtype = PDFName.of("Subtype");
    let units = 0;
    let text = false;
    let reach = Number.POSITIVE_INFINITY;
    /** Forms without text painted so far: pdf.js skips them after their first paint. */
    const once = new Set<PDFObject>();
    /**
     * What a paint that may be of any drawing costs, once worked out for this content: the same each
     * time, as the forms without text are already counted.
     */
    let anyPaint: number | undefined;
    const charge = async () => {
      for (const [window, times] of scan.take()) {
        let best = window === null ? anyPaint : undefined;
        if (best === undefined) {
          best = 0;
          // An image painted costs nothing here: pdf.js does not decode it to read text.
          for (const object of this.pick(drawings, window)) {
            await this.visit();
            if (!(object instanceof PDFRawStream) || this.lookup(object.dict.get(subtype)) !== form) continue;
            const pending = this.form(object, resources, mode, path);
            const cost = pending instanceof Promise ? await pending : pending;
            reach = Math.min(reach, cost.reach);
            if (mode === "glyph") best = Math.max(best, GLYPH_PAINT + cost.units);
            else if (cost.text) {
              text = true;
              best = Math.max(best, TEXT_PAINT + cost.units);
            } else if (!once.has(object)) {
              once.add(object);
              units += TEXT_PAINT + cost.units;
            }
          }
          if (window === null) anyPaint = best;
        }
        units += best * times;
        this.over(units + scan.length);
      }
    };
    for (const stream of contents) {
      const blind = this.predicted(stream);
      for await (const piece of this.pieces(stream)) {
        if (blind) scan.blind(piece.length);
        else scan.feed(piece);
        await charge();
        this.over(units + scan.length);
      }
      scan.boundary();
    }
    scan.end();
    await charge();
    units += scan.length;
    this.over(units);
    text ||= scan.text;
    await this.fontsOf(resources, scan.seen);
    if (mode === "glyph") {
      const extras = await this.glyphExtras(resources, scan.seen, path);
      units += extras.units;
      reach = Math.min(reach, extras.reach);
    }
    this.over(units);
    return { units, text, reach };
  }

  /**
   * The cost of running a form once: known at once when it has been run with the same resources.
   * A form that is already being run is skipped by pdf.js, which costs nothing.
   */
  private form(object: PDFRawStream, painter: PDFDict | undefined, mode: Mode, path: Path): Cost | Promise<Cost> {
    const open = path.get(object);
    if (open !== undefined) return { units: 0, text: false, reach: open };
    const own = this.lookup(object.dict.get(this.library.PDFName.of("Resources")));
    // A form without resources of its own uses those of the content that paints it.
    const resources = own instanceof this.library.PDFDict ? own : painter;
    const key = this.resourcesKey(resources);
    return this.memo[mode].get(object)?.get(key) ?? this.firstRun(object, resources, key, mode, path);
  }

  private async firstRun(object: PDFRawStream, resources: PDFDict | undefined, key: string, mode: Mode, path: Path): Promise<Cost> {
    const depth = path.size;
    if (depth >= MAX_DEPTH) throw new HeavyPage("heavy");
    path.set(object, depth);
    let cost: Cost;
    try {
      cost = await this.run([object], resources, mode, path);
    } finally {
      path.delete(object);
    }
    // A form that paints a form open further up costs what it costs only on this path: pdf.js
    // skips that form here, and may run it in full where it is not open. Such a cost is not kept,
    // so it is worked out again on each path (forms that all paint each other soon pass the limit).
    if (cost.reach < depth) return cost;
    const kept = { ...cost, reach: Number.POSITIVE_INFINITY };
    let byResources = this.memo[mode].get(object);
    if (!byResources) this.memo[mode].set(object, (byResources = new Map()));
    byResources.set(key, kept);
    return kept;
  }

  /** Reads the fonts the content may set that no page has set yet: the units go to the page. */
  private async fontsOf(resources: PDFDict | undefined, seen: Set<string> | null): Promise<void> {
    const { PDFArray, PDFDict } = this.library;
    const fonts = [...this.pick(this.entries(resources, "Font"), seen)];
    // A graphics state can set a font too.
    for (const state of this.pick(this.entries(resources, "ExtGState"), seen)) {
      await this.visit();
      const entry = state instanceof PDFDict ? this.lookup(state.get(this.library.PDFName.of("Font"))) : undefined;
      const font = entry instanceof PDFArray && entry.size() > 0 ? this.lookup(entry.get(0)) : undefined;
      if (font) fonts.push(font);
    }
    for (const font of fonts) {
      await this.visit();
      if (!(font instanceof PDFDict) || this.fonts.has(font)) continue;
      this.fonts.add(font);
      this.extra += await this.font(font, resources);
      this.over(0);
    }
  }

  /** What pdf.js reads to load a font: its programs and maps, and every glyph program of a Type3 font. */
  private async font(font: PDFDict, listed: PDFDict | undefined): Promise<number> {
    const { PDFArray, PDFDict, PDFName } = this.library;
    const get = (dict: PDFDict, key: string) => this.lookup(dict.get(PDFName.of(key)));
    let units = 0;
    if (get(font, "Subtype") === PDFName.of("Type3")) {
      const procs = get(font, "CharProcs");
      const own = get(font, "Resources");
      const resources = own instanceof PDFDict ? own : listed;
      if (procs instanceof PDFDict) {
        for (const [, value] of procs.entries()) {
          await this.visit();
          // Each glyph program is run on its own, with no forms open.
          units += (await this.run([value], resources, "glyph", new Map())).units;
          this.over(units);
        }
      }
    }
    const descendants = get(font, "DescendantFonts");
    const parts = [font, ...(descendants instanceof PDFArray ? descendants.asArray().map((entry) => this.lookup(entry)) : [])];
    for (const part of parts) {
      await this.visit();
      if (!(part instanceof PDFDict)) continue;
      const descriptor = get(part, "FontDescriptor");
      const streams = [get(part, "ToUnicode"), get(part, "Encoding"), get(part, "CIDToGIDMap")];
      if (descriptor instanceof PDFDict) streams.push(get(descriptor, "FontFile"), get(descriptor, "FontFile2"), get(descriptor, "FontFile3"));
      for (const stream of streams) units += await this.length(stream);
    }
    return units;
  }

  /** What a glyph may paint besides its forms: patterns, shadings, and soft masks. */
  private async glyphExtras(resources: PDFDict | undefined, seen: Set<string> | null, path: Path): Promise<{ units: number; reach: number }> {
    const { PDFArray, PDFDict, PDFName, PDFRawStream } = this.library;
    let units = 0;
    let reach = Number.POSITIVE_INFINITY;
    const paint = async (object: PDFRawStream) => {
      const cost = await this.form(object, resources, "glyph", path);
      reach = Math.min(reach, cost.reach);
      return GLYPH_PAINT + cost.units;
    };
    const shading = async (object: PDFObject | undefined) => {
      let sum = await this.length(object);
      const dict = object instanceof PDFRawStream ? object.dict : object;
      const functions = dict instanceof PDFDict ? this.lookup(dict.get(PDFName.of("Function"))) : undefined;
      for (const entry of functions instanceof PDFArray ? functions.asArray() : [functions]) {
        await this.visit();
        sum += await this.length(this.lookup(entry));
      }
      return sum;
    };
    for (const pattern of this.pick(this.entries(resources, "Pattern"), seen)) {
      await this.visit();
      if (pattern instanceof PDFRawStream) units += await paint(pattern);
      else if (pattern instanceof PDFDict) units += await shading(this.lookup(pattern.get(PDFName.of("Shading"))));
      this.over(units);
    }
    for (const object of this.pick(this.entries(resources, "Shading"), seen)) {
      await this.visit();
      units += await shading(object);
      this.over(units);
    }
    for (const state of this.pick(this.entries(resources, "ExtGState"), seen)) {
      await this.visit();
      const mask = state instanceof PDFDict ? this.lookup(state.get(PDFName.of("SMask"))) : undefined;
      const group = mask instanceof PDFDict ? this.lookup(mask.get(PDFName.of("G"))) : undefined;
      if (group instanceof PDFRawStream) units += await paint(group);
      this.over(units);
    }
    return { units, reach };
  }
}

/** The most a page of a file of `fileBytes` may run before it is refused. */
export function pageWorkLimit(fileBytes: number): number {
  return Math.max(PAGE_WORK_ALLOWANCE, fileBytes * PAGE_WORK_EXPANSION);
}

/**
 * Throws `HeavyPage` (with the page number) for the first page of a PDF whose text would take
 * pdf.js more than `pageWorkLimit` of the file's size to read, or whose content cannot be measured
 * here, and for a file whose pages together take more than `FILE_WORK_PAGES` such pages. Other
 * requests get a turn every few milliseconds, and an aborted `signal` stops it. Returns the work
 * of the heaviest page, in units. `onProgress` is told the pages checked so far, after each page.
 */
export async function checkPageWork(
  library: PdfLibrary,
  document: PDFDocument,
  fileBytes: number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const limit = pageWorkLimit(fileBytes);
  const budget = limit * FILE_WORK_PAGES;
  const slicer = new TimeSlicer(signal);
  const work = new PageWork(library, document, limit, budget, slicer);
  const { PDFArray } = library;
  const measured = new Set<PDFObject>();
  let heaviest = 0;
  let total = 0;
  const leaves = document.getPages().map((page) => page.node);
  for (let index = 0; index < leaves.length; index++) {
    const leaf = leaves[index]!;
    // A page listed twice is refused by the text extractor, with its own message.
    if (measured.has(leaf)) {
      onProgress?.(index + 1, leaves.length);
      continue;
    }
    measured.add(leaf);
    const contents = leaf.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    try {
      const units = await work.page(streams, leaf.Resources());
      heaviest = Math.max(heaviest, units);
      // Pages that are each within the limit can still add up to far more than the file holds:
      // one stream of 4 MB shown by 60 pages of a 25 KB file kept pdf.js busy for 40 s.
      total += units;
      if (total > budget) throw new HeavyPage("file");
    } catch (error) {
      if (error instanceof HeavyPage) throw new HeavyPage(error.reason, index + 1);
      throw error;
    }
    onProgress?.(index + 1, leaves.length);
    await slicer.maybePause();
  }
  return heaviest;
}
