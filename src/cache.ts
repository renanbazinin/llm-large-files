import type { DocumentMeta } from "./types.js";

/** Something the cache can hold: it says how much memory it takes. */
export type Sized = { readonly memoryBytes: number };

/**
 * Whose a document is: its owner and its scope, as one string. Part of every version of a document
 * kept in memory, so that a copy of one owner's or scope's document is never served to another.
 */
export function holderOf(meta: DocumentMeta): string {
  return JSON.stringify([meta.owner ?? null, meta.scope ?? null]);
}

/**
 * What identifies the contents of a document. An application's ID (0.9.0) is reused: a document is
 * deleted and another stored under its ID, by another owner or in another scope, possibly within
 * the same millisecond and with a text of the same size. A store can also be restored from a backup
 * or written by another program. So a cached copy is used only while the store still describes the
 * same text, of the same owner and scope.
 */
export function documentVersion(meta: DocumentMeta): string {
  return `${meta.createdAt}|${meta.textBytes}|${meta.characters}|${meta.lines}|${holderOf(meta)}`;
}

/**
 * Documents ready to read and search, kept between tool calls, the least recently used dropped
 * first. Bounded by the memory the documents take, not by their number: six small files and
 * six 50 MB files are not the same load.
 *
 * An entry can belong to another one, as a decoded piece of a document's text belongs to that
 * document: it counts toward the memory, not toward the number of documents, and it is dropped
 * when the entry it belongs to is dropped for being one document too many.
 *
 * The cache never decides whether a document still exists. The caller asks the store first,
 * every time (see `createLargeFiles`), so a document deleted or expired on another server is
 * not served from here.
 */
export class DocumentCache<T extends Sized> {
  private readonly entries = new Map<string, { version: string; value: T; bytes: number; owner?: string }>();
  /** Entries that belong to no other: the documents. */
  private documents = 0;
  private total = 0;
  /**
   * The last document larger than the whole cache, kept apart for `OVERSIZE_KEEP_MS` after its
   * last use (P4, 0.10.2): the tool calls of one question that read it again do not each load and
   * index it again, as they did over a store without `readTextRange`. One at most.
   */
  private oversize: { id: string; version: string; value: T; bytes: number; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(
    private readonly maxBytes: number,
    /** An optional cap on the number of documents too (the `cacheSize` of 0.3.x). */
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  /** Memory taken by the cached documents, by their own estimate: the last oversize document too. */
  get bytes(): number {
    return this.total + (this.oversize?.bytes ?? 0);
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: string, version: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return this.lastOversize(id, version);
    if (entry.version !== version) {
      this.delete(id);
      return undefined;
    }
    // Most recently used last.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  /**
   * Keeps a document. One larger than the whole cache is not kept: it is used for this call only.
   * `owner` is the key of the entry this one belongs to (a piece of that document's text).
   */
  set(id: string, version: string, value: T, owner?: string): void {
    const existing = this.entries.get(id);
    if (existing?.value === value && existing.version === version) return;
    this.delete(id);
    const bytes = Math.max(0, value.memoryBytes);
    if (this.maxEntries < 1) return;
    if (bytes > this.maxBytes) {
      // A document (not a piece), with a cache that keeps any: the last one is kept apart.
      if (owner === undefined && this.maxBytes > 0) this.keepOversize(id, version, value, bytes);
      return;
    }
    this.entries.set(id, { version, value, bytes, ...(owner !== undefined ? { owner } : {}) });
    this.total += bytes;
    if (owner === undefined) this.documents++;
    // One document too many: the one used longest ago goes, with what belongs to it.
    while (this.documents > this.maxEntries) {
      let oldest: string | undefined;
      for (const [key, entry] of this.entries) {
        if (entry.owner === undefined) {
          oldest = key;
          break;
        }
      }
      if (oldest === undefined) break;
      this.delete(oldest);
      for (const [key, entry] of [...this.entries]) if (entry.owner === oldest) this.delete(key);
    }
    // Too much memory: the entries used longest ago go, whatever they are.
    for (const [oldest] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.delete(oldest);
    }
  }

  delete(id: string): void {
    if (this.oversize?.id === id) this.dropOversize();
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.total -= entry.bytes;
    if (entry.owner === undefined) this.documents--;
  }

  /** Drops every entry whose key starts with `prefix`: all the pieces of one document. */
  deletePrefix(prefix: string): void {
    this.deleteWhere((key) => key.startsWith(prefix));
  }

  /** Drops every entry whose key passes `test`: one document in every scope, with its pieces. */
  deleteWhere(test: (key: string) => boolean): void {
    if (this.oversize && test(this.oversize.id)) this.dropOversize();
    for (const key of [...this.entries.keys()]) if (test(key)) this.delete(key);
  }

  /** The last oversize document, when it is this one: its time is counted again from now. */
  private lastOversize(id: string, version: string): T | undefined {
    const kept = this.oversize;
    if (kept?.id !== id) return undefined;
    if (kept.version !== version) {
      this.dropOversize();
      return undefined;
    }
    kept.timer.refresh();
    return kept.value;
  }

  private keepOversize(id: string, version: string, value: T, bytes: number): void {
    this.dropOversize();
    // A timer that does not keep the process alive: an idle server lets the document go.
    const timer = setTimeout(() => this.dropOversize(), OVERSIZE_KEEP_MS);
    timer.unref?.();
    this.oversize = { id, version, value, bytes, timer };
  }

  private dropOversize(): void {
    if (!this.oversize) return;
    clearTimeout(this.oversize.timer);
    this.oversize = undefined;
  }
}

/** How long the last document larger than the whole cache is kept after its last use (P4). New in 0.10.2. */
export const OVERSIZE_KEEP_MS = 60_000;
