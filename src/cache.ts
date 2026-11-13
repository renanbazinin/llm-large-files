import type { DocumentMeta } from "./types.js";

/** Something the cache can hold: it says how much memory it takes. */
export type Sized = { readonly memoryBytes: number };

/**
 * What identifies the contents of a document. A document ID is never reused, but a store can be
 * restored from a backup or written by another program: a cached copy is used only while the
 * store still describes the same text.
 */
export function documentVersion(meta: DocumentMeta): string {
  return `${meta.createdAt}|${meta.textBytes}|${meta.characters}|${meta.lines}`;
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

  constructor(
    private readonly maxBytes: number,
    /** An optional cap on the number of documents too (the `cacheSize` of 0.3.x). */
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  /** Memory taken by the cached documents, by their own estimate. */
  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: string, version: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
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
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
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
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.total -= entry.bytes;
    if (entry.owner === undefined) this.documents--;
  }

  /** Drops every entry whose key starts with `prefix`: all the pieces of one document. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }
}
