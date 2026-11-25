// The body of an upload, as `createDocumentHandlers` receives it: read into memory, or written to a
// file as it arrives. The file is the path `prepareUpload` gave (the application's, kept once its
// document is stored), or a temporary file of the spool (`uploadSpool`), removed once the ingest
// ends. Either way each piece of the body is counted against the upload limit (413) and waited for
// no longer than the idle time (408), and so is each call to the disk (503 "ETIMEDOUT", with
// Retry-After, since 0.10.0: a 500 before; a removal past it is left to end alone, and the upload
// answered all the same; since 0.10.0 it counts as a stuck call of the process until it ends). A file is always made new: opened with "wx", so that a
// file or a link already at its name is never written through. New in 0.9.0; the reading into
// memory moved here from handlers.ts.
import { randomUUID } from "node:crypto";
import { lstat, open, opendir, realpath, rm, type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { watchStuck } from "../access.js";
import { IngestError } from "../errors.js";

export class HttpError extends Error {
  /** `close`: answer, then close the connection, without waiting for the rest of the body. */
  constructor(readonly status: number, message: string, readonly close = false) {
    super(message);
  }
}

/** What an upload refused for want of room is told: by `maxPendingUploadBytes`, or `maxSpooledUploadBytes`. */
const BUSY = "The server is receiving other files right now. Try again in a moment.";
/** When a client refused for want of room is told to try again. */
export const BUSY_RETRY_MS = 5_000;
/** What an upload is told when the disk it is written to is full (`ENOSPC`, `EDQUOT`). */
const NO_ROOM = "The server has no room for this file right now. Try again later.";
/** When a client refused for a full disk is told to try again. */
export const NO_ROOM_RETRY_MS = 30_000;
/** What an upload is told when a file is already at the path `prepareUpload` gave. */
const ALREADY_SAVED = "A file is already saved for this upload.";

/** The longest a timer can wait. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** Whether `idleMs` is a time a timer can wait: 0 and Infinity are no limit. */
export const timed = (idleMs: number) => idleMs > 0 && idleMs <= LONGEST_TIMER_MS;

/** `next`, or the error `late` makes once `idleMs` pass without it. */
function within<T>(next: Promise<T>, idleMs: number, late: () => Error): Promise<T> {
  // Once the upload is refused, what it waited on ends later (with the connection, or when the
  // disk answers), or never: nobody awaits it.
  next.catch(() => undefined);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // After the thread was held longer than `idleMs`, timers run before the data that came in the
      // meantime is read: it is read first, in this turn of the loop, and the upload goes on.
      setImmediate(() => {
        if (!settled) reject(late());
      });
    }, idleMs);
  });
  return Promise.race([next.finally(() => (settled = true)), idle]).finally(() => clearTimeout(timer));
}

/** `next`, or a 408 once `idleMs` pass without it. */
function withinIdle<T>(next: Promise<T>, idleMs: number): Promise<T> {
  const after = idleMs >= 1_000 ? `${Math.round(idleMs / 1_000)} s` : `${idleMs} ms`;
  return within(next, idleMs, () => new HttpError(408, `The upload stopped arriving: nothing came for ${after}. Send it again.`, true));
}

/**
 * A call to the disk for an upload's file (`syscall`: the check of its folders, its opening, a
 * write, its closing) that did not end within the idle time: the volume stopped answering.
 * Answered as a system error, with its code only: 503 "Upload failed (ETIMEDOUT).", with
 * Retry-After: 5 (since 0.10.0: a 500 before).
 */
class DiskTimeout extends Error {
  readonly code = "ETIMEDOUT";
  constructor(readonly syscall: string) {
    super("A call to the disk for the upload's file did not end in time.");
  }
}

/**
 * `call`, a call to the disk, or a `DiskTimeout` once `idleMs` pass without it (0 for no limit).
 * Past `idleMs`, the call counts as stuck in the process until it ends, as a store call past its
 * time limit does (`LargeFilesStats.stuckStoreCalls`, 0.10.0): it holds a thread of the pool.
 */
const inTime = <T>(call: Promise<T>, idleMs: number, syscall: string): Promise<T> => (timed(idleMs) ? within(watchStuck(call, idleMs), idleMs, () => new DiskTimeout(syscall)) : call);

/**
 * Waits for `call`, a call to the disk whose end nobody needs (a removal), no longer than `idleMs`
 * (0 for no limit): past it, the call goes on alone, and the upload is answered all the same.
 * Never rejects.
 */
const atMost = (call: Promise<unknown>, idleMs: number): Promise<void> => inTime(call, idleMs, "unlink").then(() => undefined, () => undefined);

/**
 * The body a framework already read into `request.body` (a `Buffer`, as `express.raw()` leaves
 * it), or undefined. An object with fields there (`express.json()`) is a 400.
 */
export function parsedBody(request: IncomingMessage): Uint8Array | undefined {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed instanceof Uint8Array) return parsed;
  if (parsed !== undefined && typeof parsed === "object" && parsed !== null && Object.keys(parsed).length) {
    throw new HttpError(400, "The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream.");
  }
  return undefined;
}

/**
 * Reads the request's body a piece at a time and gives each to `take`, which may wait (a write to a
 * file): the next piece is read once it is done. A body over `limit`, declared or read, is a 413:
 * the piece that passes it is not given. `idleMs`: the longest wait for the next piece (0 for no
 * limit). Returns the size of the body.
 */
async function eachPiece(request: IncomingMessage, limit: number, idleMs: number, take: (piece: Buffer) => void | Promise<void>): Promise<number> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "");
  let size = 0;
  // Leaving the loop early must not destroy the request: the rest of the body is drained after
  // the answer (see `drain` in handlers.ts), which a destroyed request would not do.
  const pieces = request.iterator({ destroyOnReturn: false });
  const waits = timed(idleMs);
  try {
    for (;;) {
      const next = pieces.next();
      const { done, value: chunk } = waits ? await withinIdle(next, idleMs) : await next;
      if (done) break;
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += piece.byteLength;
      if (size > limit) throw new HttpError(413, "");
      const taking = take(piece);
      if (taking) await taking;
    }
  } finally {
    // As a `for await` does on leaving early; the request is not destroyed (see above).
    void pieces.return?.().catch(() => undefined);
  }
  return size;
}

/**
 * Reads the raw body into memory, or uses one a framework already parsed into a Buffer (e.g.
 * express.raw()). `idleMs`: the longest wait for the next piece of the body (0 for no limit).
 */
export async function readBody(request: IncomingMessage, limit: number, idleMs = 0): Promise<Uint8Array> {
  const parsed = parsedBody(request);
  if (parsed) {
    if (parsed.byteLength > limit) throw new HttpError(413, "");
    return parsed;
  }
  const pieces: Buffer[] = [];
  await eachPiece(request, limit, idleMs, (piece) => void pieces.push(piece));
  const body = Buffer.concat(pieces);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/** The most bytes given to one write: each is waited for no longer than the idle time. */
const WRITE_BYTES = 1024 * 1024;

/**
 * Writes all of `bytes` at the end of what `handle` has written, a MiB at a time at most (a body a
 * framework read may be the whole upload), each write within `idleMs`.
 */
async function writeAll(handle: FileHandle, bytes: Uint8Array, idleMs: number): Promise<void> {
  for (let at = 0; at < bytes.byteLength; ) {
    const { bytesWritten } = await inTime(handle.write(bytes, at, Math.min(WRITE_BYTES, bytes.byteLength - at)), idleMs, "write");
    if (bytesWritten <= 0) throw Object.assign(new Error("The upload could not be written."), { code: "EIO", syscall: "write" });
    at += bytesWritten;
  }
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/**
 * An error of writing an upload's file, as the upload is answered: a file already at the path is a
 * 409 (it was not written, nor removed), without the code "exists", which is a document ID's that
 * is taken; and a full disk "busy" (503, with a wait). Any other error is passed on: a 413 or a 408
 * of the body, a client that left, or a system error, answered with its code only (a folder that
 * is not there is `ENOENT`, a disk that does not answer `ETIMEDOUT`).
 */
function writeError(error: unknown): unknown {
  const code = codeOf(error);
  if (code === "EEXIST") return new HttpError(409, ALREADY_SAVED);
  if (code === "ENOSPC" || code === "EDQUOT") return new IngestError("busy", NO_ROOM, { cause: error, retryAfterMs: NO_ROOM_RETRY_MS });
  return error;
}

/**
 * Errors a removal can meet for a moment: another process (a reader, an antivirus scanner) has the
 * file open, on Windows, or the process is out of file handles just now.
 */
const REMOVAL_RETRY_CODES = new Set<unknown>(["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE"]);
/** The pauses before the second, third and fourth try of a removal. */
const REMOVAL_PAUSES_MS = [50, 100, 150];

/**
 * Removes a file the handlers wrote, once nobody needs it. A removal that fails for a moment (a
 * file another process holds open, on Windows) is tried four times in all, then left: the upload
 * is answered all the same, and the spool's sweep removes the file later (`sweepSpool`). The tries
 * are made here since 0.99.10. Before, Node's `rm` was asked for them (`maxRetries`): its
 * documentation says it makes none for a single file (Node 22 and 24 do make them), and it never
 * tries `EACCES` again.
 */
export async function removeFile(file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(file, { force: true });
      return;
    } catch (error) {
      const pause = REMOVAL_PAUSES_MS[attempt];
      if (pause === undefined || !REMOVAL_RETRY_CODES.has(codeOf(error))) return;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

/**
 * After a failure, closes `handle` and removes `file`, each waited for no longer than `idleMs`.
 * When a call to the disk did not end in time (`hung`), or the closing does not, the handle closes
 * only once that call ends, if ever, and the volume may hold a removal too: neither is waited for,
 * and the upload is answered at once. The file is removed now (Node opens a file so that it can be
 * removed while open, on Windows too), and once more when the handle closes if that removal failed.
 */
async function discard(handle: FileHandle, file: string, hung: boolean, idleMs: number): Promise<void> {
  const closed = handle.close().catch(() => undefined);
  if (!hung && (await inTime(closed, idleMs, "close").then(() => true, () => false))) {
    await atMost(removeFile(file), idleMs);
    return;
  }
  void rm(file, { force: true }).catch(() => closed.then(() => removeFile(file)));
}

/**
 * Writes the request's body to a new file at `file`, as it arrives, and returns its size. The file
 * is opened with "wx": one already there, or a link at its name, is never written through (a 409),
 * and is left as it is. It is made with `mode`, minus the umask. A body a framework already read
 * (`request.body`) is written whole. Each call to the disk (the opening, each write, the closing)
 * is waited for no longer than `idleMs`: past it, the upload fails with a `DiskTimeout`. On any
 * failure (a 413 or a 408, a client that left, a full disk, a disk that does not answer), the file
 * is removed before the error is thrown, or once the disk answers: the closing and the removal are
 * waited for no longer than `idleMs` either.
 */
export async function writeBody(request: IncomingMessage, file: string, options: { limit: number; idleMs: number; mode: number }): Promise<number> {
  const parsed = parsedBody(request);
  if (parsed && parsed.byteLength > options.limit) throw new HttpError(413, "");
  const { idleMs } = options;
  const opening = open(file, "wx", options.mode);
  let handle: FileHandle;
  try {
    handle = await inTime(opening, idleMs, "open");
  } catch (error) {
    // An opening that ends after all made the file: it is closed and removed then.
    if (error instanceof DiskTimeout) void opening.then((late) => discard(late, file, false, idleMs), () => undefined);
    throw writeError(error);
  }
  let size: number;
  try {
    if (parsed) {
      await writeAll(handle, parsed, idleMs);
      size = parsed.byteLength;
    } else {
      size = await eachPiece(request, options.limit, idleMs, (piece) => writeAll(handle, piece, idleMs));
    }
    // A disk that is full may say so only when the file is closed, and a network volume writes
    // there what it kept back.
    await inTime(handle.close(), idleMs, "close");
  } catch (error) {
    await discard(handle, file, error instanceof DiskTimeout, idleMs);
    throw writeError(error);
  }
  return size;
}

/**
 * Refuses, before the body is read, a `file` that `fileOriginals` could not read back by its `ref`:
 * when the path ends with the ref (`<root>/<ref>`, as `fileOriginals(root)` reads it), a link in a
 * folder below that root (the root itself may be one). `"wx"` refuses a link only at the file's own
 * name: a link in a folder above it is followed, and the upload would be stored with a ref that is
 * never read back, its body written where the link leads. Refused as a system error, `ELOOP`: 500
 * "Upload failed (ELOOP).". A ref that is not the end of the path is one of a reader of your own,
 * and a folder that is not there is the opening's to tell (`ENOENT`): neither is checked here. The
 * check of the folders is waited for no longer than `idleMs` (0 for no limit): past it, the upload
 * fails with a `DiskTimeout`, before anything is written.
 */
export async function checkRefFolders(file: string, ref: string, idleMs: number): Promise<void> {
  const folders = refFoldersOf(file, ref);
  if (folders === undefined) return;
  const { root, folder } = folders;
  let real: string;
  let realRoot: string;
  try {
    // One look after the other, within the one limit: a look that does not answer holds a thread of
    // libuv's pool (4 by default) until the volume answers, so each upload holds one, not two. The
    // root first: when the folder is the root (a ref of one part), it is looked at once.
    [real, realRoot] = await inTime((async () => {
      const rootFound = await realpath(root);
      return [folder === root ? rootFound : await realpath(folder), rootFound] as const;
    })(), idleMs, "realpath");
  } catch (error) {
    // A volume that does not answer fails the upload; any other error is the opening's to tell.
    if (error instanceof DiskTimeout) throw error;
    return;
  }
  if (real !== path.join(realRoot, path.relative(root, folder))) {
    throw Object.assign(new Error("A folder on the path of the upload's file is a link."), { code: "ELOOP", syscall: "open" });
  }
}

/**
 * The folders `checkRefFolders` looks at for a `file` saved under a `ref`: the root the ref is read
 * under (`<root>/<ref>` is the file) and the file's own folder. Undefined when the path does not
 * end with the ref, or the ref is not one of a file below a root: nothing is checked then.
 * `paths`: the path functions of the platform (`path.win32` in the tests).
 */
export function refFoldersOf(file: string, ref: string, paths: path.PlatformPath = path): { root: string; folder: string } | undefined {
  const target = paths.resolve(file);
  let tail = paths.normalize(ref);
  while (tail.endsWith(paths.sep)) tail = tail.slice(0, -1);
  if (!tail || tail === "." || paths.isAbsolute(tail) || tail === ".." || tail.startsWith(`..${paths.sep}`) || !target.endsWith(`${paths.sep}${tail}`)) return undefined;
  // The path without the ref and the separator before it. For a file at the root of a volume that
  // is shorter than the root: "" for "/a.pdf", and "C:" for "C:\a.pdf", which Windows reads as the
  // working folder of the drive, not its root (0.99.10: the check then compared the wrong folders).
  const cut = target.slice(0, target.length - tail.length - 1);
  const top = paths.parse(target).root;
  return { root: cut.length < top.length ? top : cut, folder: paths.dirname(target) };
}

/** The start of the name of a temporary file of the spool. */
const SPOOL_PREFIX = "llf-upload-";
/** The name of a temporary file of the spool: the prefix and a random UUID, as `spoolFileIn` makes it. */
const SPOOL_NAME = /^llf-upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A new name for a temporary file of the spool in `directory`: never one that is there ("wx" makes sure). */
export const spoolFileIn = (directory: string): string => path.join(directory, `${SPOOL_PREFIX}${randomUUID()}`);

/**
 * Removes the files a server left in the spool's folder when it was killed in the middle of an
 * upload, or could not remove (a file held open, on Windows): those named as the spool names its
 * files (`llf-upload-<UUID>`) and last written more than `ageMs` ago. A file an upload still uses
 * is younger than that, also when another server process wrote it, so a folder several processes
 * share is safe. Nothing else is touched: not a file of another name, a folder, a link, nor (where
 * files have an owner) a file of another user. Returns how many it removed. It never rejects: a
 * folder that cannot be read, or a file that cannot be removed, is left for the next time. New in
 * 0.99.10.
 */
export async function sweepSpool(directory: string, ageMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  const user = typeof process.getuid === "function" ? process.getuid() : undefined;
  try {
    // One entry at a time: the default folder is the system's temporary folder, which may hold many.
    for await (const entry of await opendir(directory)) {
      if (!SPOOL_NAME.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      try {
        // Looked at without following a link: a link at such a name is not the spool's.
        const found = await lstat(file);
        if (!found.isFile() || !(now - found.mtimeMs > ageMs) || (user !== undefined && found.uid !== user)) continue;
        await rm(file, { force: true });
        removed++;
      } catch {
        // Gone meanwhile (another process swept it), or not removable now.
      }
    }
  } catch {
    // The folder is not there, or cannot be read.
  }
  return removed;
}

/**
 * The file an upload's body was written to, while its ingest runs. `kept`: the application's file
 * (`prepareUpload`), which stays once the document is stored, and is removed when the upload fails.
 * Otherwise a temporary file of the spool, removed once the ingest ends, whatever the end. The
 * removal is waited for no longer than `idleMs` (0 for no limit): on a volume that stopped
 * answering it goes on alone, and the upload is answered, and gives its room back, all the same.
 */
export class BodyFile {
  #stored = false;
  #removing: Promise<void> | undefined;
  readonly #idleMs: number;

  constructor(readonly path: string, readonly kept: boolean, idleMs: number) {
    this.#idleMs = idleMs;
  }

  /**
   * Follows the ingest of the file (`ingesting`): when it ends, a temporary file is removed, and
   * the application's file too when it failed, or when `keeps` says that the document the ingest
   * gave back does not refer to it (one stored before, `dedupe`; new in 0.99.9). It settles once
   * that is done, as the ingest did.
   */
  async settle<T>(ingesting: Promise<T>, keeps: (value: T) => boolean): Promise<T> {
    try {
      const value = await ingesting;
      this.#stored = keeps(value);
      return value;
    } finally {
      await this.end();
    }
  }

  /** Removes the file, once: for an upload that failed after its document was stored (`onUploaded` threw). */
  remove(): Promise<void> {
    return (this.#removing ??= atMost(removeFile(this.path), this.#idleMs));
  }

  /** At the end of the upload: removes a temporary file, or the application's file of a document that was not stored. */
  async end(): Promise<void> {
    if (!this.kept || !this.#stored) await this.remove();
  }
}

/** Room taken by one upload in a `Room`. */
export type Held = {
  /** The upload's size, once known: its room becomes that. */
  resize(bytes: number): void;
  /** Gives the room back, once. */
  release(): void;
};

/**
 * Bytes of uploads held at once, under `limit`: `maxPendingUploadBytes` for the bodies held in
 * memory, `maxSpooledUploadBytes` for the files of the spool. `Infinity` refuses nothing, and since
 * 0.10.0 still counts, for `handlers.stats()`.
 */
export class Room {
  #used = 0;

  constructor(readonly limit: number) {}

  /** The bytes held now (`handlers.stats()`). */
  get used(): number {
    return this.#used;
  }

  /**
   * Room for an upload of `bytes` (at most the limit itself), taken before its body is read. One
   * that would bring the room past its limit while another upload holds some is refused: an
   * `IngestError` "busy", answered 503 with a wait. One upload alone is always taken. With no limit,
   * an upload of no known size (the upload limit is Infinity too) counts 0 until it is read, so that
   * the count stays a number.
   */
  take(bytes: number): Held {
    let held = Math.min(bytes, this.limit);
    if (!Number.isFinite(held)) held = 0;
    if (this.limit !== Number.POSITIVE_INFINITY && this.#used > 0 && this.#used + held > this.limit) throw new IngestError("busy", BUSY, { retryAfterMs: BUSY_RETRY_MS });
    this.#used += held;
    return {
      resize: (size) => {
        this.#used += size - held;
        held = size;
      },
      release: () => {
        this.#used -= held;
        held = 0;
      },
    };
  }
}
