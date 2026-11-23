import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocumentScopeError } from "./errors.js";
import { Limiter } from "./limiter.js";
import { checkScope, MAX_SCOPE_SEGMENTS, scopeKey } from "./scope.js";
import type { DocumentContext, DocumentMeta, DocumentScope, DocumentStore, StoredDocument } from "./types.js";

/** The shape of the document IDs the library makes: "doc_" and 32 hex digits. */
export const DOCUMENT_ID_PATTERN = /^doc_[a-f0-9]{32}$/;

/**
 * The shape of a document ID an application may choose (`IngestInput.id`): lowercase letters,
 * digits, "_" and "-", up to 64 characters, starting with a letter or a digit, and not a name
 * Windows keeps for a device (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`), which
 * cannot name a file there. The IDs the library makes have it too. New in 0.9.0.
 */
export const APP_DOCUMENT_ID_PATTERN = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The version of `DocumentMeta` this package writes (`metaVersion`), and the highest it reads.
 * New in 0.9.0: metadata without a version is that of an earlier version, and is read as before.
 */
export const DOCUMENT_META_VERSION = 1;

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
  readonly #unscoped: Shelf = { scope: undefined, documents: this.documents, originals: this.originals };
  /** The documents of each scope, by the key of the scope (`scopeKey`). */
  readonly #scoped = new Map<string, Shelf>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** The documents of the scope of `context`. Those of a scope that has none yet are made when `create` asks for them. */
  #shelf(context: DocumentContext | undefined, create: true): Shelf;
  #shelf(context: DocumentContext | undefined, create?: false): Shelf | undefined;
  #shelf(context: DocumentContext | undefined, create = false): Shelf | undefined {
    const scope = checkScope(context?.scope);
    if (scope === undefined) return this.#unscoped;
    const key = scopeKey(scope);
    let shelf = this.#scoped.get(key);
    if (!shelf && create) {
      shelf = { scope, documents: new Map(), originals: new Map() };
      this.#scoped.set(key, shelf);
    }
    return shelf;
  }

  // The metadata is copied on the way in and on the way out, as a store that writes it somewhere
  // does: an app that changes the metadata it was handed (deletes its owner before sending it to a
  // browser) must not change the document's owner or expiry.
  async put(document: StoredDocument, context?: DocumentContext): Promise<void> {
    this.#shelf(context, true).documents.set(document.meta.id, { meta: structuredClone(document.meta), text: document.text });
  }

  async get(id: string, context?: DocumentContext): Promise<StoredDocument | undefined> {
    const document = this.#shelf(context)?.documents.get(id);
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
    const shelf = this.#shelf(context);
    if (!shelf) return false;
    shelf.originals.delete(id);
    const existed = shelf.documents.delete(id);
    // A scope with nothing left takes no memory: one for each chat would add up.
    if (shelf !== this.#unscoped && shelf.documents.size === 0 && shelf.originals.size === 0) this.#scoped.delete(scopeKey(shelf.scope));
    return existed;
  }

  /** Removes expired documents: those of the scope of `context`, or those of every scope when it has none. */
  async sweep(now = this.now(), context?: DocumentContext): Promise<number> {
    const shelves = context?.scope === undefined ? [this.#unscoped, ...this.#scoped.values()] : [this.#shelf(context)];
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
    this.#shelf(context, true).originals.set(id, bytes.slice());
  }

  async getOriginal(id: string, context?: DocumentContext): Promise<Uint8Array | undefined> {
    // A copy too, new in 0.9.0: a caller that changed the bytes it was handed changed the stored file.
    return await this.get(id, context) ? this.#shelf(context)?.originals.get(id)?.slice() : undefined;
  }
}

/**
 * The files of a document, and the temporary files written on the way to them. Since 0.9.0 the ID
 * may be an application's (`APP_DOCUMENT_ID_PATTERN`), which the IDs the library makes fit too.
 */
const FILE_NAME = /^([a-z0-9][a-z0-9_-]{0,63})\.(json|txt|bin|idx)(\.[a-f0-9]{8}\.tmp)?$/;

/**
 * Names Windows keeps for devices, with or without an extension: `con.json` is the console, not a
 * file. Refused as scope segments and as file names, since a volume may be shared with Windows.
 */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** A name of one folder of a scope (`isSafeScopeSegment`): the shape of an application's document ID. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A name of the store's own folder in each scope's folder (`scopes.folder`). */
const FOLDER_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Errors a rename or a removal can meet on Windows while another process (a reader, an antivirus
 * scanner) has the file open for a moment. Tried again after each of these pauses, as graceful-fs
 * does: ten more tries, and 2,630 ms of pauses in all, so about 2.6 seconds.
 */
const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_PAUSES_MS = [10, 20, 40, 80, 160, 320, 500, 500, 500, 500];

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** There is no such file. Every other failure (a volume that does not answer, too many open files) says nothing about the file. */
const missing = (error: unknown) => code(error) === "ENOENT";
/** There is no such file or folder, or a part of its path is a file. */
const absent = (error: unknown) => code(error) === "ENOENT" || code(error) === "ENOTDIR";
/** The file is a link, which a read does not follow (READ_FLAGS): Linux and macOS say ELOOP, FreeBSD EMLINK. */
const linked = (error: unknown) => code(error) === "ELOOP" || code(error) === "EMLINK";

/**
 * How a document's file is opened for reading: without following a link at its name, where the
 * platform can (`O_NOFOLLOW`; Windows has none). Folders are checked by their real path instead.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** The refusal of a folder of a scope that is a link, or under one. */
const LINKED_FOLDER = "The folder of the scope is a link, or inside one: this store follows no folder links below its directory.";

/**
 * How long a read takes a folder of a scope that passed its check as still checked, and how many
 * such folders a store remembers. Writes, deletes and removals always check again.
 */
const CHECK_KEPT_MS = 1_000;
const CHECKS_KEPT = 4_096;

/**
 * Whether `value` can name a folder of a scope in a `FileDocumentStore` with `scopes`: lowercase
 * letters, digits, "_" and "-", 1 to 64 characters, starting with a letter or a digit, and not a
 * name Windows keeps for a device (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`). Lower
 * case only, because SMB and Azure Files ignore case: `Alice` and `alice` would be one folder. Use
 * `hashedScopeSegment` for an ID that does not pass. New in 0.9.0.
 */
export function isSafeScopeSegment(value: string): boolean {
  return typeof value === "string" && SAFE_SEGMENT.test(value) && !DEVICE_NAME.test(value);
}

/**
 * A segment that `isSafeScopeSegment` accepts, made from any string: "h" and the first 40 hex
 * digits of its SHA-256. For user or chat IDs in mixed case, or in Hebrew. The same value always
 * gives the same segment, and two values almost surely two. Use it for every value of that level of
 * the scope, not only for those that would not pass, and pass the result as the scope's segment:
 * the store never hashes on its own. New in 0.9.0.
 */
export function hashedScopeSegment(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("hashedScopeSegment needs a string that is not empty.");
  return `h${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40)}`;
}

/** An ID that may become a file name: an application's ID shape, and not a device name. */
const fileId = (id: unknown): id is string => typeof id === "string" && APP_DOCUMENT_ID_PATTERN.test(id) && !DEVICE_NAME.test(id);

/** Metadata as it was written, or undefined for text that is not that: cut short, or damaged. */
function parseMeta(raw: string): DocumentMeta | undefined {
  try {
    const meta = JSON.parse(raw) as DocumentMeta | null;
    return meta !== null && typeof meta === "object" && typeof meta.expiresAt === "string" ? meta : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `task`, and again after each pause of RETRY_PAUSES_MS while it fails with a code of RETRY_CODES. */
async function retried<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= RETRY_PAUSES_MS.length || !RETRY_CODES.has(code(error) as string)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSES_MS[attempt]));
    }
  }
}

/**
 * Removes a file, trying again as a rename is (Node's own `rm` retries neither `EACCES` nor a file
 * without `recursive`). True when it was there, false when it was not.
 */
async function removeFile(file: string): Promise<boolean> {
  try {
    await retried(() => unlink(file));
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/**
 * Writes a file whole or not at all, as other processes see it: to a temporary name first, then
 * renamed. A server reading a shared volume never sees half of a file another server is writing.
 * The temporary file is made with `mode`, and the rename keeps it.
 */
async function writeWhole(target: string, data: string | Uint8Array, mode: number): Promise<void> {
  const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temporary, data, { mode });
    await retried(() => rename(temporary, target));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The files of a document in `folder`. */
function filesOf(folder: string, id: string): { text: string; meta: string; original: string; index: string } {
  const file = (extension: string) => path.join(folder, `${id}.${extension}`);
  return { text: file("txt"), meta: file("json"), original: file("bin"), index: file("idx") };
}

/** Where the documents of a scope go, when the store keeps each scope in a folder of its own. New in 0.9.0. */
export type FileDocumentScopes = {
  /**
   * How many segments every scope has, from 1 to 8: 2 for `[userId, chatId]`. A scope of another
   * length is a `DocumentScopeError` of code "scope_invalid".
   */
  depth: number;
  /**
   * The folder of the store in the folder of each scope: `<directory>/<scope...>/<folder>/<id>.json`.
   * Defaults to ".llm-large-files". "" puts the files in the scope's folder itself, beside files of
   * the application's own. The names `<id>.json`, `.txt`, `.idx` and `.bin`, and their temporary
   * files, are then the store's for every ID it is given: keep files of your own in a subfolder.
   */
  folder?: string;
  /**
   * Whether a write makes the folders of a scope that has none. Defaults to false: the folders of a
   * scope are the application's, and the store only makes its own `folder` in them. A write into a
   * scope whose folder is gone (the chat was deleted) is then a `DocumentScopeError` of code
   * "scope_missing", and the folder is not made again. With true, they are made one level at a time,
   * each checked to be a folder and not a link before the next is made in it.
   */
  createScopeFolders?: boolean;
  /**
   * What a call without a scope does. "refuse", the default: it throws a `DocumentScopeError` of
   * code "scope_required". "root": it uses the files directly in the directory, as a store without
   * `scopes` does, to keep reading documents written there before.
   */
  unscoped?: "refuse" | "root";
};

/** The options of a `FileDocumentStore`. */
export type FileDocumentStoreOptions = {
  /** The clock that decides expiry, and the default `now` of `sweep`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * `sweep` removes files that belong to no document (an upload that failed, a server that
   * stopped while writing) once they are this old. Younger ones may be an upload in progress,
   * on this server or another one. Defaults to one hour.
   */
  orphanAgeMs?: number;
  /** Keep the documents of each scope in a folder of their own. Without it, every document is in `directory`. New in 0.9.0. */
  scopes?: FileDocumentScopes;
  /** The mode of every file the store writes, minus the umask of the process. Defaults to 0o600. New in 0.9.0. */
  fileMode?: number;
  /** The mode of every folder the store makes, minus the umask of the process. Defaults to 0o700. New in 0.9.0. */
  directoryMode?: number;
  /** How many reads of metadata, listings and checks of a file's age `sweep` runs at once. Defaults to 16. New in 0.9.0. */
  sweepConcurrency?: number;
};

/** A folder of documents: the store's directory, or the folder of a scope. */
type Place = {
  folder: string;
  /**
   * Whether files of the application may sit in the folder too: the directory without scopes, or
   * the folder of a scope with `folder: ""`. There, a file of no document is removed by `sweep` only
   * when its name is an ID the library makes, or a temporary file: `notes.txt` may be the
   * application's, not the text of a document "notes".
   */
  shared: boolean;
  /** Whether the folder is a scope's, which a write must not make again (`createScopeFolders`). */
  scoped: boolean;
};

/** Runs file system calls of one sweep, at most `concurrency` at once. */
type Pool = <T>(task: () => Promise<T>) => Promise<T>;

function checkMode(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 0o777) throw new TypeError(`${name} must be a file mode from 0 to 0o777, such as 0o640.`);
  return value;
}

/**
 * Keeps each document as `<id>.txt` plus `<id>.json` in one directory, so files survive a
 * server restart, its line index as `<id>.idx`, and its original file as `<id>.bin` when one is
 * kept. Only IDs matching APP_DOCUMENT_ID_PATTERN (which leaves out names Windows keeps for
 * devices) ever reach the file system. Those names, for every ID it is given, are the store's: keep
 * files of your own in a subfolder. A read does not follow a link at a file name, except on Windows.
 *
 * With `scopes`, the documents of each scope are kept in a folder of their own:
 * `<directory>/<userId>/<chatId>/.llm-large-files/<id>.json`. New in 0.9.0.
 *
 * Several servers may share the directory (a network volume): every file is written whole under
 * a temporary name and then renamed, a tool call reads only the lines it needs (`readTextRange`),
 * and `sweep` never removes the files of an upload that is still being written.
 */
export class FileDocumentStore implements DocumentStore {
  private readonly now: () => Date;
  private readonly orphanAgeMs: number;
  readonly #scopes: Required<FileDocumentScopes> | undefined;
  readonly #fileMode: number;
  readonly #directoryMode: number;
  readonly #sweepConcurrency: number;
  /** The directory, with links resolved, once it was found. */
  #realDirectory: Promise<string> | undefined;
  /** The folders of scopes that passed `#checkReal`, and when (`Date.now()`), the oldest first. */
  readonly #checked = new Map<string, number>();

  constructor(private readonly directory: string, options: FileDocumentStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.orphanAgeMs = options.orphanAgeMs ?? 60 * 60 * 1000;
    this.#fileMode = checkMode("fileMode", options.fileMode, 0o600);
    this.#directoryMode = checkMode("directoryMode", options.directoryMode, 0o700);
    const concurrency = options.sweepConcurrency ?? 16;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("sweepConcurrency must be a whole number of 1 or more.");
    this.#sweepConcurrency = concurrency;
    const scopes = options.scopes;
    if (scopes === undefined) {
      this.#scopes = undefined;
      return;
    }
    if (!Number.isInteger(scopes.depth) || scopes.depth < 1 || scopes.depth > MAX_SCOPE_SEGMENTS) {
      throw new TypeError(`scopes.depth must be a whole number from 1 to ${MAX_SCOPE_SEGMENTS}.`);
    }
    const folder = scopes.folder ?? ".llm-large-files";
    if (folder !== "" && (!FOLDER_NAME.test(folder) || folder === "." || folder === "..")) {
      throw new TypeError('scopes.folder must be "" or the name of one folder: letters, digits, ".", "_" and "-", such as ".llm-large-files".');
    }
    const unscoped = scopes.unscoped ?? "refuse";
    if (unscoped !== "refuse" && unscoped !== "root") throw new TypeError('scopes.unscoped must be "refuse" or "root".');
    this.#scopes = { depth: scopes.depth, folder, createScopeFolders: scopes.createScopeFolders === true, unscoped };
  }

  /** The scope of a call, checked against the rules of this store, or undefined for none. */
  #scopeOf(context: DocumentContext | undefined): DocumentScope | undefined {
    const scope = checkScope(context?.scope);
    if (scope === undefined || this.#scopes === undefined) return scope;
    if (scope.length !== this.#scopes.depth) {
      throw new DocumentScopeError("scope_invalid", `This store keeps scopes of ${this.#scopes.depth} segments (scopes.depth); the scope has ${scope.length}.`);
    }
    scope.forEach((segment, index) => {
      if (!isSafeScopeSegment(segment)) {
        throw new DocumentScopeError("scope_invalid", `scope segment ${index + 1} cannot name a folder: use lowercase letters, digits, "_" and "-", up to 64 characters, and no name Windows keeps for a device (isSafeScopeSegment), or hashedScopeSegment(value).`);
      }
    });
    return scope;
  }

  /** The directory itself: that of a store without scopes, or of a call without a scope under `unscoped: "root"`. */
  #root(): Place {
    if (this.#scopes && this.#scopes.unscoped !== "root") throw new DocumentScopeError("scope_required");
    return { folder: this.directory, shared: true, scoped: false };
  }

  /** The folder of a scope, and that of the store in it. */
  #folders(scope: DocumentScope): { scope: string; documents: string } {
    const scopeFolder = path.join(this.directory, ...scope);
    return { scope: scopeFolder, documents: this.#scopes!.folder ? path.join(scopeFolder, this.#scopes!.folder) : scopeFolder };
  }

  /**
   * Checks that `folder` is where its path says, with no link on the way below the directory, and
   * so inside the directory. Throws its error when it is not there. A folder that passes is
   * remembered for CHECK_KEPT_MS, for reads (`#find`); one that fails is forgotten.
   */
  async #checkReal(folder: string): Promise<void> {
    try {
      const real = await realpath(folder);
      this.#realDirectory ??= realpath(this.directory);
      let directory: string;
      try {
        directory = await this.#realDirectory;
      } catch (error) {
        this.#realDirectory = undefined;
        throw error;
      }
      if (real !== path.join(directory, path.relative(this.directory, folder))) throw new DocumentScopeError("scope_invalid", LINKED_FOLDER);
    } catch (error) {
      this.#checked.delete(folder);
      throw error;
    }
    this.#checked.delete(folder);
    this.#checked.set(folder, Date.now());
    if (this.#checked.size > CHECKS_KEPT) this.#checked.delete(this.#checked.keys().next().value!);
  }

  /** Whether `folder` passed `#checkReal` less than CHECK_KEPT_MS ago. A clock set back counts as not. */
  #checkedRecently(folder: string): boolean {
    const at = this.#checked.get(folder);
    if (at === undefined) return false;
    const age = Date.now() - at;
    if (age >= 0 && age < CHECK_KEPT_MS) return true;
    this.#checked.delete(folder);
    return false;
  }

  /**
   * Whether a read's error means that the file is not there to read: missing, or a link, which is
   * not followed. A file that is missing makes the next call check its folder again.
   */
  #unreadable(place: Place, error: unknown): boolean {
    if (absent(error)) {
      if (place.scoped) this.#checked.delete(place.folder);
      return true;
    }
    return linked(error);
  }

  /**
   * The folder of the documents of a call, or undefined when it is not there, and so neither are
   * they. A read (`fresh` false) takes a folder checked less than CHECK_KEPT_MS ago as it was; a
   * delete or a sweep checks it again.
   */
  async #find(context: DocumentContext | undefined, fresh = false): Promise<Place | undefined> {
    if (!this.#scopes) return { folder: this.directory, shared: true, scoped: false };
    const scope = this.#scopeOf(context);
    if (scope === undefined) return this.#root();
    const folders = this.#folders(scope);
    if (fresh || !this.#checkedRecently(folders.documents)) {
      try {
        await this.#checkReal(folders.documents);
      } catch (error) {
        if (absent(error)) return undefined;
        throw error;
      }
    }
    return { folder: folders.documents, shared: this.#scopes.folder === "", scoped: true };
  }

  /**
   * Makes the folders of a scope (`createScopeFolders`) one level at a time. Each is made, or found,
   * as a folder and not a link before the next is made in it, so nothing is made where a link
   * points. A file where a folder should be stops it: the check that follows finds the scope missing.
   */
  async #makeScopeFolders(scope: DocumentScope): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: this.#directoryMode });
    let level = this.directory;
    for (const segment of scope) {
      level = path.join(level, segment);
      await mkdir(level, { mode: this.#directoryMode }).catch((error: unknown) => {
        if (code(error) !== "EEXIST") throw error;
      });
      const info = await lstat(level);
      if (info.isSymbolicLink()) throw new DocumentScopeError("scope_invalid", LINKED_FOLDER);
      if (!info.isDirectory()) return;
    }
  }

  /** The folder of the documents of a call, made when it is not there yet. */
  async #make(context: DocumentContext | undefined): Promise<Place> {
    const scope = this.#scopes ? this.#scopeOf(context) : undefined;
    if (scope === undefined) {
      const place = this.#scopes ? this.#root() : { folder: this.directory, shared: true, scoped: false };
      await mkdir(this.directory, { recursive: true, mode: this.#directoryMode });
      return place;
    }
    const scopes = this.#scopes!;
    const folders = this.#folders(scope);
    const place = { folder: folders.documents, shared: scopes.folder === "", scoped: true };
    try {
      await this.#checkReal(folders.documents);
      return place;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    try {
      // Made only when asked to: the application may have removed the folder of a chat it deleted.
      if (scopes.createScopeFolders) await this.#makeScopeFolders(scope);
      await this.#checkReal(folders.scope);
      if (folders.documents !== folders.scope) {
        // Not recursive: if the scope's folder went in the meantime, it is not made again.
        await mkdir(folders.documents, { mode: this.#directoryMode }).catch((error: unknown) => {
          if (code(error) !== "EEXIST") throw error;
        });
        await this.#checkReal(folders.documents);
      }
    } catch (error) {
      if (absent(error)) throw new DocumentScopeError("scope_missing", undefined, { cause: error });
      throw error;
    }
    return place;
  }

  /** Writes one file of a document whole. A scope's folder that went while it was written is "scope_missing". */
  async #write(place: Place, target: string, data: string | Uint8Array): Promise<void> {
    try {
      await writeWhole(target, data, this.#fileMode);
    } catch (error) {
      if (place.scoped && absent(error)) throw new DocumentScopeError("scope_missing", undefined, { cause: error });
      throw error;
    }
  }

  async put(document: StoredDocument, context?: DocumentContext): Promise<void> {
    if (!fileId(document.meta.id)) throw new Error("Invalid document ID.");
    const place = await this.#make(context);
    const files = filesOf(place.folder, document.meta.id);
    await this.#write(place, files.text, document.text);
    // Write metadata last: a document without metadata is treated as absent.
    await this.#write(place, files.meta, JSON.stringify(document.meta));
  }

  /** The metadata of a document in `place`, or undefined. An expired one is removed, as far as that works. */
  async #meta(place: Place, id: string): Promise<DocumentMeta | undefined> {
    let raw: string;
    try {
      raw = await readFile(filesOf(place.folder, id).meta, { encoding: "utf8", flag: READ_FLAGS });
    } catch (error) {
      // Only a file that is not there (or a link, not followed) means that the document is not
      // there. A read that failed for another reason is thrown, so that a busy volume is not taken
      // for a deleted document.
      if (this.#unreadable(place, error)) return undefined;
      throw error;
    }
    // Metadata that cannot be parsed is an upload being written by a server of 0.3.x, or damaged: absent.
    const meta = parseMeta(raw);
    if (!meta) return undefined;
    if (expired(meta, this.now())) {
      // Expired is missing, whether or not its files could be removed now: sweep tries again. The
      // folder is checked again first: a read may have taken it as checked a moment ago.
      await (place.scoped ? this.#checkReal(place.folder) : Promise.resolve())
        .then(() => this.#remove(place, id))
        .catch(() => undefined);
      return undefined;
    }
    return meta;
  }

  async getMeta(id: string, context?: DocumentContext): Promise<DocumentMeta | undefined> {
    if (!fileId(id)) return undefined;
    const place = await this.#find(context);
    return place && this.#meta(place, id);
  }

  async get(id: string, context?: DocumentContext): Promise<StoredDocument | undefined> {
    if (!fileId(id)) return undefined;
    const place = await this.#find(context);
    const meta = place && await this.#meta(place, id);
    if (!place || !meta) return undefined;
    try {
      return { meta, text: await readFile(filesOf(place.folder, id).text, { encoding: "utf8", flag: READ_FLAGS }) };
    } catch (error) {
      if (this.#unreadable(place, error)) return undefined;
      throw error;
    }
  }

  async readTextRange(id: string, start: number, end: number, context?: DocumentContext): Promise<Uint8Array | undefined> {
    if (!fileId(id)) return undefined;
    const place = await this.#find(context);
    if (!place) return undefined;
    let handle;
    try {
      handle = await open(filesOf(place.folder, id).text, READ_FLAGS);
    } catch (error) {
      if (this.#unreadable(place, error)) return undefined;
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

  async putIndex(id: string, index: Uint8Array, context?: DocumentContext): Promise<void> {
    if (!fileId(id)) throw new Error("Invalid document ID.");
    const place = await this.#make(context);
    await this.#write(place, filesOf(place.folder, id).index, index);
  }

  async getIndex(id: string, context?: DocumentContext): Promise<Uint8Array | undefined> {
    if (!fileId(id)) return undefined;
    const place = await this.#find(context);
    if (!place) return undefined;
    try {
      const file = await readFile(filesOf(place.folder, id).index, { flag: READ_FLAGS });
      return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    } catch (error) {
      this.#unreadable(place, error);
      return undefined;
    }
  }

  /**
   * Removes the metadata, then the other files. When the metadata cannot be removed, the error is
   * thrown and nothing else is touched: the document stays whole. Once it is gone, the document is
   * gone: a text, index or original that cannot be removed now is left for `sweep`.
   */
  async #remove(place: Place, id: string): Promise<boolean> {
    const files = filesOf(place.folder, id);
    const existed = await removeFile(files.meta);
    await Promise.allSettled([files.text, files.original, files.index].map(removeFile));
    return existed;
  }

  async delete(id: string, context?: DocumentContext): Promise<boolean> {
    if (!fileId(id)) return false;
    const place = await this.#find(context, true);
    return place ? this.#remove(place, id) : false;
  }

  async putOriginal(id: string, bytes: Uint8Array, context?: DocumentContext): Promise<void> {
    if (!fileId(id)) throw new Error("Invalid document ID.");
    const place = await this.#make(context);
    // Written before the metadata (see put): until that exists, the document is treated as absent.
    await this.#write(place, filesOf(place.folder, id).original, bytes);
  }

  async getOriginal(id: string, context?: DocumentContext): Promise<Uint8Array | undefined> {
    if (!fileId(id)) return undefined;
    const place = await this.#find(context);
    // The metadata decides whether the document is still there, and removes an expired one.
    if (!place || !await this.#meta(place, id)) return undefined;
    try {
      const file = await readFile(filesOf(place.folder, id).original, { flag: READ_FLAGS });
      return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    } catch (error) {
      if (this.#unreadable(place, error)) return undefined;
      throw error;
    }
  }

  /**
   * Removes expired documents and returns how many: those whose metadata this sweep removed, so
   * that two sweeps at once count each document once. Also removes files that belong to no
   * document, and temporary files, once they are older than `orphanAgeMs`. A document whose
   * metadata is not valid is removed only when that file is that old too: it may be being
   * written by a server of an older version, which does not write whole files.
   *
   * A document whose metadata could not be read at all (the volume did not answer, too many files
   * were open) is left alone, whatever its age: the next sweep looks at it again. A document that
   * cannot be removed is left for the next sweep too, and does not stop this one.
   *
   * With `scopes`: with a scope in `context`, the folder of that scope only. Without one, every
   * scope's: it goes down exactly `scopes.depth` levels of folders, into folders whose names pass
   * `isSafeScopeSegment` only, and follows no link. With `unscoped: "root"`, the directory itself too.
   * Without `scopes`, the context is not used.
   */
  async sweep(now = this.now(), context?: DocumentContext): Promise<number> {
    const slots = new Limiter(this.#sweepConcurrency);
    const pool: Pool = async (task) => {
      const release = await slots.acquire();
      try {
        return await task();
      } finally {
        release();
      }
    };
    const scopes = this.#scopes;
    if (!scopes) return this.#sweepFolder({ folder: this.directory, shared: true, scoped: false }, now, pool);
    const scope = this.#scopeOf(context);
    if (scope !== undefined) {
      const place = await this.#find({ scope }, true);
      return place ? this.#sweepFolder(place, now, pool) : 0;
    }
    let removed = scopes.unscoped === "root" ? await this.#sweepFolder({ folder: this.directory, shared: true, scoped: false }, now, pool) : 0;
    // The folders of the scopes, a few at a time: one pool bounds the file system calls of all of them.
    const running = new Set<Promise<void>>();
    for await (const folder of this.#scopeFolders(pool)) {
      const sweeping: Promise<void> = this.#sweepFolder({ folder, shared: scopes.folder === "", scoped: true }, now, pool)
        .then((count) => { removed += count; }, () => undefined)
        .finally(() => running.delete(sweeping));
      running.add(sweeping);
      if (running.size >= this.#sweepConcurrency) await Promise.race(running);
    }
    await Promise.all(running);
    return removed;
  }

  /** The folders of the store in every scope's folder, found one level at a time, depth first. */
  async *#scopeFolders(pool: Pool): AsyncGenerator<string> {
    const scopes = this.#scopes!;
    const walk = async function* (folder: string, level: number): AsyncGenerator<string> {
      let entries: Dirent[];
      try {
        entries = await pool(() => readdir(folder, { withFileTypes: true }));
      } catch {
        return;
      }
      for (const entry of entries) {
        // A link is not a directory here: it is never followed. Nor is a folder the application
        // keeps beside the scopes, whose name is not one a scope may have.
        if (!entry.isDirectory() || !isSafeScopeSegment(entry.name)) continue;
        const next = path.join(folder, entry.name);
        if (level + 1 < scopes.depth) {
          yield* walk(next, level + 1);
          continue;
        }
        if (!scopes.folder) {
          yield next;
          continue;
        }
        const documents = path.join(next, scopes.folder);
        const info = await pool(() => lstat(documents)).catch(() => undefined);
        if (info?.isDirectory()) yield documents;
      }
    };
    yield* walk(this.directory, 0);
  }

  /** Sweeps one folder. Never throws: a folder that cannot be listed gives 0. */
  async #sweepFolder(place: Place, now: Date, pool: Pool): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await pool(() => readdir(place.folder, { withFileTypes: true }));
    } catch {
      return 0;
    }
    const files = new Map<string, string[]>();
    for (const entry of entries) {
      const match = entry.isFile() ? FILE_NAME.exec(entry.name) : null;
      if (!match) continue;
      const list = files.get(match[1]!) ?? [];
      list.push(entry.name);
      files.set(match[1]!, list);
    }
    const counts = await Promise.all([...files].map(([id, names]) => this.#sweepDocument(place, id, names, now, pool)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /** Sweeps the files of one ID in a folder: 1 when it removed an expired or broken document. */
  async #sweepDocument(place: Place, id: string, names: string[], now: Date, pool: Pool): Promise<number> {
    const old = async (entry: string) => {
      const info = await pool(() => stat(path.join(place.folder, entry))).catch(() => undefined);
      return info !== undefined && now.getTime() - info.mtimeMs >= this.orphanAgeMs;
    };
    // In a folder of the store's own, every file named like a document's is the store's. In one the
    // application shares, a file of an application's ID is, only when its metadata names it.
    const ours = !place.shared || DOCUMENT_ID_PATTERN.test(id);
    const metaFile = `${id}.json`;
    const hasMeta = names.includes(metaFile);
    if (hasMeta) {
      let raw: string | undefined;
      try {
        raw = await pool(() => readFile(path.join(place.folder, metaFile), { encoding: "utf8", flag: READ_FLAGS }));
      } catch (error) {
        // Not read is not the same as not valid: nothing of this document is touched.
        if (!missing(error)) return 0;
      }
      if (raw !== undefined) {
        const meta = parseMeta(raw);
        const known = meta !== undefined && (ours || meta.id === id);
        if (known ? expired(meta!, now) : ours && await old(metaFile)) {
          // 1 only when this sweep removed the metadata: another sweep at the same time may have.
          return await pool(() => this.#remove(place, id)).then((existed) => (existed ? 1 : 0), () => 0);
        }
      }
    }
    // Temporary files of this ID, and, when they are the store's, the files of a document without
    // metadata, once they are old.
    for (const entry of names) {
      if (entry === metaFile || (!entry.endsWith(".tmp") && (hasMeta || !ours))) continue;
      if (await old(entry)) await pool(() => rm(path.join(place.folder, entry), { force: true })).catch(() => undefined);
    }
    return 0;
  }
}
