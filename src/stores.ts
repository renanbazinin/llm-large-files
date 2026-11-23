import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkScope, scopeKey } from "./scope.js";
import type { DocumentContext, DocumentMeta, DocumentScope, DocumentStore, StoredDocument } from "./types.js";

/** The shape of the document IDs the library makes: "doc_" and 32 hex digits. */
export const DOCUMENT_ID_PATTERN = /^doc_[a-f0-9]{32}$/;

/**
 * The shape of a document ID an application may choose (`IngestInput.id`): lowercase letters,
 * digits, "_" and "-", up to 64 characters, starting with a letter or a digit. The IDs the library
 * makes have it too. New in 0.9.0.
 */
export const APP_DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function expired(meta: DocumentMeta, now = new Date()): boolean {
  return Date.parse(meta.expiresAt) <= now.getTime();
}

/** The documents of one scope in a `MemoryDocumentStore`, and the scope as it was given. */
type Shelf = { scope: DocumentScope | undefined; documents: Map<string, StoredDocument>; originals: Map<string, Uint8Array> };

/**
 * Keeps documents in process memory. Good for tests and single-process demos.
 *
 * The documents of each scope (`DocumentContext.scope`) are kept apart: one ID in two scopes is two
 * documents. Calls without a scope share the documents of no scope, as every call did before 0.9.0.
 */
export class MemoryDocumentStore implements DocumentStore {
  /** The documents of no scope, by ID, as all documents were kept before 0.9.0. */
  private readonly documents = new Map<string, StoredDocument>();
  /** The original files of the documents of no scope. */
  private readonly originals = new Map<string, Uint8Array>();
  private readonly unscoped: Shelf = { scope: undefined, documents: this.documents, originals: this.originals };
  /** The documents of each scope, by the key of the scope (`scopeKey`). */
  private readonly scoped = new Map<string, Shelf>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** The documents of the scope of `context`. Those of a scope that has none yet are made when `create` asks for them. */
  private shelf(context: DocumentContext | undefined, create: true): Shelf;
  private shelf(context: DocumentContext | undefined, create?: false): Shelf | undefined;
  private shelf(context: DocumentContext | undefined, create = false): Shelf | undefined {
    const scope = checkScope(context?.scope);
    if (scope === undefined) return this.unscoped;
    const key = scopeKey(scope);
    let shelf = this.scoped.get(key);
    if (!shelf && create) {
      shelf = { scope, documents: new Map(), originals: new Map() };
      this.scoped.set(key, shelf);
    }
    return shelf;
  }

  // The metadata is copied on the way in and on the way out, as a store that writes it somewhere
  // does: an app that changes the metadata it was handed (deletes its owner before sending it to a
  // browser) must not change the document's owner or expiry.
  async put(document: StoredDocument, context?: DocumentContext): Promise<void> {
    this.shelf(context, true).documents.set(document.meta.id, { meta: structuredClone(document.meta), text: document.text });
  }

  async get(id: string, context?: DocumentContext): Promise<StoredDocument | undefined> {
    const document = this.shelf(context)?.documents.get(id);
    if (document && expired(document.meta, this.now())) {
      await this.delete(id, context);
      return undefined;
    }
    return document && { meta: structuredClone(document.meta), text: document.text };
  }

  async getMeta(id: string, context?: DocumentContext): Promise<DocumentMeta | undefined> {
    return (await this.get(id, context))?.meta;
  }

  async delete(id: string, context?: DocumentContext): Promise<boolean> {
    const shelf = this.shelf(context);
    if (!shelf) return false;
    shelf.originals.delete(id);
    const existed = shelf.documents.delete(id);
    // A scope with nothing left takes no memory: one for each chat would add up.
    if (shelf !== this.unscoped && shelf.documents.size === 0 && shelf.originals.size === 0) this.scoped.delete(scopeKey(shelf.scope));
    return existed;
  }

  /** Removes expired documents: those of the scope of `context`, or those of every scope when it has none. */
  async sweep(now = this.now(), context?: DocumentContext): Promise<number> {
    const shelves = context?.scope === undefined ? [this.unscoped, ...this.scoped.values()] : [this.shelf(context)];
    let removed = 0;
    for (const shelf of shelves) {
      if (!shelf) continue;
      for (const [id, document] of shelf.documents) {
        if (expired(document.meta, now)) {
          await this.delete(id, shelf.scope === undefined ? undefined : { scope: shelf.scope });
          removed++;
        }
      }
    }
    return removed;
  }

  async putOriginal(id: string, bytes: Uint8Array, context?: DocumentContext): Promise<void> {
    // A copy: the caller may reuse its buffer after the upload.
    this.shelf(context, true).originals.set(id, bytes.slice());
  }

  async getOriginal(id: string, context?: DocumentContext): Promise<Uint8Array | undefined> {
    // A copy too, new in 0.9.0: a caller that changed the bytes it was handed changed the stored file.
    return await this.get(id, context) ? this.shelf(context)?.originals.get(id)?.slice() : undefined;
  }
}

/** The files of a document, and the temporary files written on the way to them. */
const FILE_NAME = /^(doc_[a-f0-9]{32})\.(json|txt|bin|idx)(\.[a-f0-9]{8}\.tmp)?$/;

/**
 * Errors a rename can meet on Windows while another process (a reader, an antivirus scanner) has
 * the file open for a moment. Retried with growing pauses for up to about three seconds, as
 * graceful-fs does.
 */
const RETRY_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_PAUSES_MS = [10, 20, 40, 80, 160, 320, 500, 500, 500, 500];

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** There is no such file. Every other failure (a volume that does not answer, too many open files) says nothing about the file. */
const missing = (error: unknown) => code(error) === "ENOENT";

/** Metadata as it was written, or undefined for text that is not that: cut short, or damaged. */
function parseMeta(raw: string): DocumentMeta | undefined {
  try {
    const meta = JSON.parse(raw) as DocumentMeta | null;
    return meta !== null && typeof meta === "object" && typeof meta.expiresAt === "string" ? meta : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes a file whole or not at all, as other processes see it: to a temporary name first, then
 * renamed. A server reading a shared volume never sees half of a file another server is writing.
 */
async function writeWhole(target: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temporary, data);
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        if (attempt >= RENAME_PAUSES_MS.length || !RETRY_RENAME.has(code(error) as string)) throw error;
        await new Promise((resolve) => setTimeout(resolve, RENAME_PAUSES_MS[attempt]));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Keeps each document as `<id>.txt` plus `<id>.json` in one directory, so files survive a
 * server restart, its line index as `<id>.idx`, and its original file as `<id>.bin` when one is
 * kept. Only IDs matching DOCUMENT_ID_PATTERN ever reach the file system.
 *
 * Several servers may share the directory (a network volume): every file is written whole under
 * a temporary name and then renamed, a tool call reads only the lines it needs (`readTextRange`),
 * and `sweep` never removes the files of an upload that is still being written.
 */
export class FileDocumentStore implements DocumentStore {
  private readonly now: () => Date;
  private readonly orphanAgeMs: number;

  constructor(private readonly directory: string, options: {
    now?: () => Date;
    /**
     * `sweep` removes files that belong to no document (an upload that failed, a server that
     * stopped while writing) once they are this old. Younger ones may be an upload in progress,
     * on this server or another one. Defaults to one hour.
     */
    orphanAgeMs?: number;
  } = {}) {
    this.now = options.now ?? (() => new Date());
    this.orphanAgeMs = options.orphanAgeMs ?? 60 * 60 * 1000;
  }

  private paths(id: string): { text: string; meta: string; original: string; index: string } | undefined {
    if (!DOCUMENT_ID_PATTERN.test(id)) return undefined;
    const file = (extension: string) => path.join(this.directory, `${id}.${extension}`);
    return { text: file("txt"), meta: file("json"), original: file("bin"), index: file("idx") };
  }

  async put(document: StoredDocument): Promise<void> {
    const paths = this.paths(document.meta.id);
    if (!paths) throw new Error("Invalid document ID.");
    await mkdir(this.directory, { recursive: true });
    await writeWhole(paths.text, document.text);
    // Write metadata last: a document without metadata is treated as absent.
    await writeWhole(paths.meta, JSON.stringify(document.meta));
  }

  async getMeta(id: string): Promise<DocumentMeta | undefined> {
    const paths = this.paths(id);
    if (!paths) return undefined;
    let raw: string;
    try {
      raw = await readFile(paths.meta, "utf8");
    } catch (error) {
      // Only a file that is not there means that the document is not there. A read that failed for
      // another reason is thrown, so that a busy volume is not taken for a deleted document.
      if (missing(error)) return undefined;
      throw error;
    }
    // Metadata that cannot be parsed is an upload being written by a server of 0.3.x, or damaged: absent.
    const meta = parseMeta(raw);
    if (!meta) return undefined;
    if (expired(meta, this.now())) {
      await this.delete(id);
      return undefined;
    }
    return meta;
  }

  async get(id: string): Promise<StoredDocument | undefined> {
    const meta = await this.getMeta(id);
    const paths = this.paths(id);
    if (!meta || !paths) return undefined;
    try {
      return { meta, text: await readFile(paths.text, "utf8") };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async readTextRange(id: string, start: number, end: number): Promise<Uint8Array | undefined> {
    const paths = this.paths(id);
    if (!paths) return undefined;
    let handle;
    try {
      handle = await open(paths.text, "r");
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw error;
    }
    try {
      // Not zero-filled first: every byte that is returned is read from the file.
      const buffer = Buffer.allocUnsafe(Math.max(0, end - start));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return filled === buffer.length ? buffer : buffer.subarray(0, filled);
    } finally {
      await handle.close();
    }
  }

  async putIndex(id: string, index: Uint8Array): Promise<void> {
    const paths = this.paths(id);
    if (!paths) throw new Error("Invalid document ID.");
    await mkdir(this.directory, { recursive: true });
    await writeWhole(paths.index, index);
  }

  async getIndex(id: string): Promise<Uint8Array | undefined> {
    const paths = this.paths(id);
    if (!paths) return undefined;
    try {
      const file = await readFile(paths.index);
      return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    } catch {
      return undefined;
    }
  }

  async delete(id: string): Promise<boolean> {
    const paths = this.paths(id);
    if (!paths) return false;
    const existed = Boolean(await readFile(paths.meta, "utf8").catch(() => null));
    // The metadata first: a document is there while its metadata is. If that file cannot be removed,
    // nothing else is, and the document stays whole. The other way round, a document whose text is
    // gone would still be listed.
    await rm(paths.meta, { force: true });
    await Promise.all([paths.text, paths.original, paths.index].map((file) => rm(file, { force: true })));
    return existed;
  }

  async putOriginal(id: string, bytes: Uint8Array): Promise<void> {
    const paths = this.paths(id);
    if (!paths) throw new Error("Invalid document ID.");
    await mkdir(this.directory, { recursive: true });
    // Written before the metadata (see put): until that exists, the document is treated as absent.
    await writeWhole(paths.original, bytes);
  }

  async getOriginal(id: string): Promise<Uint8Array | undefined> {
    const paths = this.paths(id);
    // The metadata decides whether the document is still there. getMeta also removes an expired one.
    if (!paths || !await this.getMeta(id)) return undefined;
    try {
      const file = await readFile(paths.original);
      return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  /**
   * Removes expired documents and returns how many. Also removes files that belong to no
   * document, and temporary files, once they are older than `orphanAgeMs`. A document whose
   * metadata is not valid is removed only when that file is that old too: it may be being
   * written by a server of an older version, which does not write whole files.
   *
   * A document whose metadata could not be read at all (the volume did not answer, too many files
   * were open) is left alone, whatever its age: the next sweep looks at it again. A document that
   * cannot be removed is left for the next sweep too, and does not stop this one.
   */
  async sweep(now = this.now()): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return 0;
    }
    const files = new Map<string, string[]>();
    for (const entry of entries) {
      const match = FILE_NAME.exec(entry);
      if (!match) continue;
      const list = files.get(match[1]!) ?? [];
      list.push(entry);
      files.set(match[1]!, list);
    }
    const old = async (entry: string) => {
      const info = await stat(path.join(this.directory, entry)).catch(() => undefined);
      return info !== undefined && now.getTime() - info.mtimeMs >= this.orphanAgeMs;
    };
    let removed = 0;
    for (const [id, names] of files) {
      const metaFile = `${id}.json`;
      if (names.includes(metaFile)) {
        let raw: string | undefined;
        try {
          raw = await readFile(path.join(this.directory, metaFile), "utf8");
        } catch (error) {
          // Not read is not the same as not valid: nothing of this document is touched.
          if (!missing(error)) continue;
        }
        if (raw !== undefined) {
          const meta = parseMeta(raw);
          if (meta ? expired(meta, now) : await old(metaFile)) {
            if (await this.delete(id).then(() => true, () => false)) removed++;
            continue;
          }
        }
      }
      // Temporary files of this document, and every file of one without metadata, once they are old.
      for (const entry of names) {
        if (entry === metaFile || (!entry.endsWith(".tmp") && names.includes(metaFile))) continue;
        if (await old(entry)) await rm(path.join(this.directory, entry), { force: true }).catch(() => undefined);
      }
    }
    return removed;
  }
}
