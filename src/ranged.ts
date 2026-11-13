/**
 * A document read from the store a range at a time, for stores that can (`readTextRange`): a tool
 * call reads the lines it needs, and a search reads the text in pieces, so no call holds a whole
 * large file in memory. The line index comes from the store (`getIndex`), or is built from the
 * text the first time an older document without one is opened, and saved for next time.
 */
import type { Limiter } from "./limiter.js";
import { pagesOfLines, pause, type DocumentSource, type ScanFeed, type TextChunk } from "./search.js";
import { canSerialize, parseTextIndex, positionOf, serializeTextIndex, TextIndexBuilder, type TextIndex } from "./text-index.js";
import { foldCase, LineIndex } from "./text.js";
import type { DocumentMeta, DocumentStore } from "./types.js";

export type RangeStore = Pick<DocumentStore, "getIndex" | "putIndex"> & Required<Pick<DocumentStore, "readTextRange">>;

export type ScanSettings = {
  /** About this many bytes of text are read and searched at a time. */
  chunkBytes: number;
  /** Bounds how many scans of whole documents run at once. */
  limiter: Limiter;
  /** Told when the stored text of a document did not agree with its index. */
  onBroken?: (id: string) => void;
  /**
   * Where decoded pieces of frequently searched documents are kept, within the cache's memory
   * limit, so that the next search of them reads and decodes nothing. A document whose decoded
   * text would take more than `maxDocumentBytes` is never kept: one scan of it would push out
   * everything else.
   */
  pieces?: PieceCache;
};

/** A piece of text kept in memory, and what it takes. */
export type CachedPiece = TextChunk & { readonly memoryBytes: number };

export type PieceCache = {
  get(key: string, version: string): CachedPiece | undefined;
  set(key: string, version: string, piece: CachedPiece): void;
  maxDocumentBytes: number;
};

/** The cache key of piece `at` of a document. All of them start with `${id}#`. */
export const pieceKey = (id: string, at: number) => `${id}#${at}`;

/** Bytes read at a time to build an index from the text. */
const BUILD_READ_BYTES = 4 * 1024 * 1024;
/** A pass shared by several scans lets other work run after this much time on the main thread. */
const YIELD_AFTER_MS = 15;
const decoder = new TextDecoder("utf-8");

const gone = (id: string) => new Error(`${id} is no longer available on the server. Ask the user to attach the file again.`);

/** A scan of a document: fed the pieces in order until it says it is done. */
type Consumer = { feed: ScanFeed; done: boolean; settle: (error?: unknown) => void };

export class RangedDocument implements DocumentSource {
  /**
   * Set when the stored text did not agree with the index. The library then drops this object and
   * opens the document again, building its index from the text.
   */
  broken = false;

  /** The version its pieces are kept under, and whether they are kept at all. */
  private readonly pieceVersion: string;
  private readonly keepPieces: boolean;
  private ranges?: Array<{ firstLine: number; lastLine: number; start: number; end: number }>;

  constructor(
    private readonly store: RangeStore,
    readonly meta: DocumentMeta,
    readonly index: TextIndex,
    private readonly settings: ScanSettings,
  ) {
    this.pieceVersion = `${meta.createdAt}|${index.textBytes}|${index.characters}|${settings.chunkBytes}`;
    // Decoded text is one byte a character when it is all ASCII, two otherwise; and its lowercased copy as much again.
    const decoded = index.characters * (index.textBytes === index.characters ? 1 : 2) * 2 + index.characterStarts.byteLength;
    this.keepPieces = settings.pieces !== undefined && decoded <= settings.pieces.maxDocumentBytes;
  }

  get lineCount(): number {
    return this.index.lineCount;
  }

  get characters(): number {
    return this.index.characters;
  }

  get passageStarts(): ArrayLike<number> {
    return this.index.passageStarts;
  }

  get memoryBytes(): number {
    const { lineStarts, characterStarts, passageStarts, pageStarts } = this.index;
    return lineStarts.byteLength + characterStarts.byteLength + passageStarts.byteLength + pageStarts.byteLength + 2_048;
  }

  pageOfLine(line: number): number | undefined {
    const starts = this.index.pageStarts;
    return starts.length === 0 || line < starts[0]! ? undefined : positionOf(starts, line);
  }

  pagesOfLines(from: number, to: number): string | undefined {
    return pagesOfLines(this.index.pageStarts, from, to);
  }

  async readLines(from: number, to: number): Promise<string[]> {
    const first = Math.max(1, from);
    const last = Math.min(to, this.index.lineCount);
    if (first > last) return [];
    const text = await this.read(...this.bytesOf(first, last));
    const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    if (lines.length !== last - first + 1) throw this.mismatch();
    return lines;
  }

  async readText(): Promise<string> {
    const text = await this.read(0, this.index.textBytes);
    if (text.length !== this.index.characters) throw this.mismatch();
    return text;
  }

  /**
   * The text in pieces of whole passages, about `chunkBytes` each. A scan waits for a slot of the
   * limiter first, and holds it until it ends or is abandoned. `scan` does the same for several
   * scans at once.
   */
  async *chunks(signal?: AbortSignal): AsyncGenerator<TextChunk> {
    const release = await this.settings.limiter.acquire(signal);
    try {
      for await (const chunk of this.pieces()) {
        signal?.throwIfAborted();
        yield chunk;
      }
    } finally {
      release();
    }
  }

  /**
   * Feeds the text, a piece at a time and in order, to `feed` until it returns true or the text
   * ends. Scans asked for while others of this document wait for a slot of the limiter join them:
   * the pieces are then read, decoded and lowercased once, for all of them. A scan asked for once
   * the pass has started waits for the next one, since every scan must see the text from the start.
   */
  scan(feed: ScanFeed, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => consumer.settle(signal!.reason);
      const consumer: Consumer = {
        feed,
        done: false,
        settle: (error?: unknown) => {
          if (consumer.done) return;
          consumer.done = true;
          signal?.removeEventListener("abort", onAbort);
          if (error === undefined) resolve();
          else reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.gathering) {
        this.gathering.push(consumer);
        return;
      }
      const group = [consumer];
      this.gathering = group;
      void this.pass(group);
    });
  }

  /** Scans waiting for a slot, open to more of them. */
  private gathering: Consumer[] | undefined;

  private async pass(group: Consumer[]): Promise<void> {
    const release = await this.settings.limiter.acquire();
    // From here on the group is closed.
    if (this.gathering === group) this.gathering = undefined;
    try {
      if (group.every((consumer) => consumer.done)) return;
      let slice = performance.now();
      for await (const chunk of this.pieces()) {
        let open = 0;
        for (const consumer of group) {
          if (consumer.done) continue;
          try {
            let more = consumer.feed(chunk);
            // A scan that asks for the same piece again has stopped part-way to let other work run.
            while (more === "again" && !consumer.done) {
              await pause();
              slice = performance.now();
              more = consumer.feed(chunk);
            }
            if (more === true) consumer.settle();
            else if (!consumer.done) open++;
          } catch (error) {
            consumer.settle(error);
          }
          // Many scans on one piece add up: give other work (answers streaming to other users) a turn.
          if (performance.now() - slice > YIELD_AFTER_MS) {
            await pause();
            slice = performance.now();
          }
        }
        if (open === 0) break;
      }
      for (const consumer of group) consumer.settle();
    } catch (error) {
      for (const consumer of group) consumer.settle(error);
    } finally {
      release();
    }
  }

  /**
   * The pieces, in order: kept ones from memory, the others read and decoded, the next one read
   * while the current one is used. Line breaks are where the index says, which each piece read is
   * checked against.
   */
  private async *pieces(): AsyncGenerator<TextChunk> {
    const count = this.chunkRanges().length;
    const load = (at: number) => {
      const promise = this.piece(at);
      // Read ahead: if the scan stops before it needs this piece, nobody waits for it.
      promise.catch(() => undefined);
      return promise;
    };
    let next = count > 0 ? load(0) : undefined;
    for (let at = 0; at < count; at++) {
      const chunk = await next!;
      next = at + 1 < count ? load(at + 1) : undefined;
      yield chunk;
    }
  }

  /** Piece `at`, from memory when it is kept there. */
  private async piece(at: number): Promise<TextChunk> {
    const cache = this.keepPieces ? this.settings.pieces : undefined;
    const kept = cache?.get(pieceKey(this.meta.id, at), this.pieceVersion);
    if (kept) return kept;
    const { firstLine, lastLine, start, end } = this.chunkRanges()[at]!;
    const text = await this.read(start, end);
    const { characterStarts, characters, lineCount } = this.index;
    const startCharacter = characterStarts[firstLine - 1]!;
    const endCharacter = lastLine < lineCount ? characterStarts[lastLine]! : characters;
    if (text.length !== endCharacter - startCharacter) throw this.mismatch();
    const starts = new Uint32Array(lastLine - firstLine + 1);
    for (let line = 0; line < starts.length; line++) {
      const lineStart = characterStarts[firstLine - 1 + line]! - startCharacter;
      // Each line but the first starts right after a line break.
      if (line > 0 && text.charCodeAt(lineStart - 1) !== 10) throw this.mismatch();
      starts[line] = lineStart;
    }
    if (lastLine < lineCount && text.charCodeAt(text.length - 1) !== 10) throw this.mismatch();
    let lower: string | undefined;
    const ascii = end - start === text.length;
    const piece: CachedPiece = {
      firstLine,
      startCharacter,
      text,
      lines: new LineIndex(text, starts),
      lower: () => (lower ??= foldCase(text)),
      // The text and, once a search needs it, its lowercased copy.
      memoryBytes: text.length * (ascii ? 1 : 2) * 2 + starts.byteLength + 256,
    };
    cache?.set(pieceKey(this.meta.id, at), this.pieceVersion, piece);
    return piece;
  }

  /** The bytes of lines `first` to `last`, which must exist. */
  private bytesOf(first: number, last: number): [number, number] {
    const { lineStarts, lineCount, textBytes } = this.index;
    return [lineStarts[first - 1]!, last < lineCount ? lineStarts[last]! : textBytes];
  }

  /** Line ranges of whole passages, each about `chunkBytes` (one passage at least). */
  private chunkRanges(): Array<{ firstLine: number; lastLine: number; start: number; end: number }> {
    if (this.ranges) return this.ranges;
    const { passageStarts, lineStarts, lineCount, textBytes } = this.index;
    const ranges: Array<{ firstLine: number; lastLine: number; start: number; end: number }> = [];
    for (let passage = 0; passage < passageStarts.length;) {
      const firstLine = passageStarts[passage]!;
      const start = lineStarts[firstLine - 1]!;
      let next = passage + 1;
      while (next < passageStarts.length && lineStarts[passageStarts[next]! - 1]! - start < this.settings.chunkBytes) next++;
      const end = next < passageStarts.length ? lineStarts[passageStarts[next]! - 1]! : textBytes;
      ranges.push({ firstLine, lastLine: next < passageStarts.length ? passageStarts[next]! - 1 : lineCount, start, end });
      passage = next;
    }
    this.ranges = ranges;
    return ranges;
  }

  private async read(start: number, end: number): Promise<string> {
    const bytes = await this.store.readTextRange(this.meta.id, start, end);
    if (!bytes) throw gone(this.meta.id);
    if (bytes.length !== end - start) throw this.mismatch();
    return decoder.decode(bytes);
  }

  private mismatch(): Error {
    if (!this.broken) {
      this.broken = true;
      this.settings.onBroken?.(this.meta.id);
    }
    return new Error(`The stored text of ${this.meta.name} did not match its index. Try the call again.`);
  }
}

/** Builds the index of a stored text by reading all of it once. Undefined when the text is gone. */
export async function buildIndexFromStore(store: RangeStore, id: string, limiter: Limiter): Promise<TextIndex | undefined> {
  const release = await limiter.acquire();
  try {
    const builder = new TextIndexBuilder();
    for (let position = 0; ;) {
      const bytes = await store.readTextRange(id, position, position + BUILD_READ_BYTES);
      if (!bytes) return undefined;
      builder.push(bytes);
      position += bytes.length;
      if (bytes.length < BUILD_READ_BYTES) break;
    }
    const index = builder.finish();
    return index.lineCount > 0 ? index : undefined;
  } finally {
    release();
  }
}

/**
 * Opens a document to be read by range. Uses the saved index when there is one that fits the
 * document; otherwise builds it from the text and saves it (best effort: a store that cannot
 * write, or another server writing the same index, changes nothing). Undefined when the text is gone.
 */
export async function openRangedDocument(
  store: RangeStore,
  meta: DocumentMeta,
  settings: ScanSettings,
  options: { ignoreSavedIndex?: boolean } = {},
): Promise<RangedDocument | undefined> {
  let index: TextIndex | undefined;
  if (!options.ignoreSavedIndex && store.getIndex) {
    const saved = await store.getIndex(meta.id).catch(() => undefined);
    if (saved) index = parseTextIndex(saved, meta);
  }
  if (!index) {
    index = await buildIndexFromStore(store, meta.id, settings.limiter);
    if (!index) return undefined;
    // An index that disagrees with the metadata describes a text that is not what was ingested.
    // It is used, since it is what the store holds, but not saved.
    if (store.putIndex && canSerialize(index) && index.lineCount === meta.lines && index.characters === meta.characters) {
      await store.putIndex(meta.id, serializeTextIndex(index)).catch(() => undefined);
    }
  }
  return new RangedDocument(store, meta, index, settings);
}
