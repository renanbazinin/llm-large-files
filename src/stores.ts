import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentMeta, DocumentStore, StoredDocument } from "./types.js";

export const DOCUMENT_ID_PATTERN = /^doc_[a-f0-9]{32}$/;

function expired(meta: DocumentMeta, now = new Date()): boolean {
  return Date.parse(meta.expiresAt) <= now.getTime();
}

/** Keeps documents in process memory. Good for tests and single-process demos. */
export class MemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly originals = new Map<string, Uint8Array>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async put(document: StoredDocument): Promise<void> {
    this.documents.set(document.meta.id, document);
  }

  async get(id: string): Promise<StoredDocument | undefined> {
    const document = this.documents.get(id);
    if (document && expired(document.meta, this.now())) {
      await this.delete(id);
      return undefined;
    }
    return document;
  }

  async getMeta(id: string): Promise<DocumentMeta | undefined> {
    return (await this.get(id))?.meta;
  }

  async delete(id: string): Promise<boolean> {
    this.originals.delete(id);
    return this.documents.delete(id);
  }

  async sweep(now = this.now()): Promise<number> {
    let removed = 0;
    for (const [id, document] of this.documents) {
      if (expired(document.meta, now)) {
        await this.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async putOriginal(id: string, bytes: Uint8Array): Promise<void> {
    // A copy: the caller may reuse its buffer after the upload.
    this.originals.set(id, bytes.slice());
  }

  async getOriginal(id: string): Promise<Uint8Array | undefined> {
    return await this.get(id) ? this.originals.get(id) : undefined;
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
    let meta: DocumentMeta;
    try {
      meta = JSON.parse(await readFile(paths.meta, "utf8")) as DocumentMeta;
    } catch {
      return undefined;
    }
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
    } catch {
      return undefined;
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
    await Promise.all([paths.meta, paths.text, paths.original, paths.index].map((file) => rm(file, { force: true })));
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
    } catch {
      return undefined;
    }
  }

  /**
   * Removes expired documents and returns how many. Also removes files that belong to no
   * document, and temporary files, once they are older than `orphanAgeMs`. A document whose
   * metadata cannot be read is removed only when that file is that old too: it may be being
   * written by a server of an older version, which does not write whole files.
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
        const meta = await readFile(path.join(this.directory, metaFile), "utf8").then((value) => JSON.parse(value) as DocumentMeta).catch(() => null);
        if (meta ? expired(meta, now) : await old(metaFile)) {
          await this.delete(id);
          removed++;
          continue;
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
