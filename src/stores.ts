import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentMeta, DocumentStore, StoredDocument } from "./types.js";

export const DOCUMENT_ID_PATTERN = /^doc_[a-f0-9]{32}$/;

function expired(meta: DocumentMeta, now = new Date()): boolean {
  return Date.parse(meta.expiresAt) <= now.getTime();
}

/** Keeps documents in process memory. Good for tests and single-process demos. */
export class MemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();
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
      this.documents.delete(id);
      return undefined;
    }
    return document;
  }

  async getMeta(id: string): Promise<DocumentMeta | undefined> {
    return (await this.get(id))?.meta;
  }

  async delete(id: string): Promise<boolean> {
    return this.documents.delete(id);
  }

  async sweep(now = this.now()): Promise<number> {
    let removed = 0;
    for (const [id, document] of this.documents) {
      if (expired(document.meta, now)) {
        this.documents.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * Keeps each document as `<id>.txt` plus `<id>.json` in one directory, so files survive a
 * server restart. Only IDs matching DOCUMENT_ID_PATTERN ever reach the file system.
 */
export class FileDocumentStore implements DocumentStore {
  private readonly now: () => Date;

  constructor(private readonly directory: string, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private paths(id: string): { text: string; meta: string } | undefined {
    if (!DOCUMENT_ID_PATTERN.test(id)) return undefined;
    return { text: path.join(this.directory, `${id}.txt`), meta: path.join(this.directory, `${id}.json`) };
  }

  async put(document: StoredDocument): Promise<void> {
    const paths = this.paths(document.meta.id);
    if (!paths) throw new Error("Invalid document ID.");
    await mkdir(this.directory, { recursive: true });
    await writeFile(paths.text, document.text, "utf8");
    // Write metadata last: a document without metadata is treated as absent.
    await writeFile(paths.meta, JSON.stringify(document.meta), "utf8");
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

  async delete(id: string): Promise<boolean> {
    const paths = this.paths(id);
    if (!paths) return false;
    const existed = Boolean(await readFile(paths.meta, "utf8").catch(() => null));
    await Promise.all([rm(paths.meta, { force: true }), rm(paths.text, { force: true })]);
    return existed;
  }

  async sweep(now = this.now()): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      const id = entry.replace(/\.(json|txt)$/, "");
      if (!entry.endsWith(".json") || !DOCUMENT_ID_PATTERN.test(id)) continue;
      const meta = await readFile(path.join(this.directory, entry), "utf8").then((value) => JSON.parse(value) as DocumentMeta).catch(() => null);
      if (!meta || expired(meta, now)) {
        await this.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
