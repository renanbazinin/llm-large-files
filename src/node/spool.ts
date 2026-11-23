// The body of an upload, as `createDocumentHandlers` receives it: read into memory, or written to a
// file as it arrives. The file is the path `prepareUpload` gave (the application's, kept once its
// document is stored), or a temporary file of the spool (`uploadSpool`), removed once the ingest
// ends. Either way each piece of the body is counted against the upload limit (413) and waited for
// no longer than the idle time (408), and so is each call to the disk (500 "ETIMEDOUT"). A file is
// always made new: opened with "wx", so that a file or a link already at its name is never written
// through. New in 0.9.0; the reading into memory moved here from handlers.ts.
import { randomUUID } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
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
const timed = (idleMs: number) => idleMs > 0 && idleMs <= LONGEST_TIMER_MS;

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
 * A call to the disk for an upload's file (`syscall`: its opening, a write, its closing) that did
 * not end within the idle time: the volume stopped answering. Answered as a system error, with its
 * code only: 500 "Upload failed (ETIMEDOUT).".
 */
class DiskTimeout extends Error {
  readonly code = "ETIMEDOUT";
  constructor(readonly syscall: string) {
    super("The upload's file could not be written in time.");
  }
}

/** `call`, a call to the disk, or a `DiskTimeout` once `idleMs` pass without it (0 for no limit). */
const inTime = <T>(call: Promise<T>, idleMs: number, syscall: string): Promise<T> => (timed(idleMs) ? within(call, idleMs, () => new DiskTimeout(syscall)) : call);

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
 * An error of writing an upload's file, as the upload is answered: a file already at the path is
 * "exists" (409; it was not written, nor removed), and a full disk "busy" (503, with a wait). Any
 * other error is passed on: a 413 or a 408 of the body, a client that left, or a system error,
 * answered with its code only (a folder that is not there is `ENOENT`, a disk that does not answer
 * `ETIMEDOUT`).
 */
function writeError(error: unknown): unknown {
  const code = codeOf(error);
  if (code === "EEXIST") return new IngestError("exists", ALREADY_SAVED, { cause: error });
  if (code === "ENOSPC" || code === "EDQUOT") return new IngestError("busy", NO_ROOM, { cause: error, retryAfterMs: NO_ROOM_RETRY_MS });
  return error;
}

/**
 * Removes a file the handlers wrote, once nobody needs it. A removal that fails (a file another
 * process holds open, on Windows) is tried a few times, then left: the upload is answered all the
 * same.
 */
export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
}

/**
 * After a failure, closes `handle` and removes `file`. When a call to the disk did not end in time
 * (`hung`), the handle closes only once that call ends, if ever, and the volume may hold a removal
 * too: neither is waited for, and the upload is answered at once. The file is removed now (Node
 * opens a file so that it can be removed while open, on Windows too), and once more when the handle
 * closes if that removal failed.
 */
async function discard(handle: FileHandle, file: string, hung: boolean): Promise<void> {
  const closed = handle.close().catch(() => undefined);
  if (!hung) {
    await closed;
    await removeFile(file);
    return;
  }
  void rm(file, { force: true }).catch(() => closed.then(() => removeFile(file)));
}

/**
 * Writes the request's body to a new file at `file`, as it arrives, and returns its size. The file
 * is opened with "wx": one already there, or a link at its name, is never written through (an
 * `IngestError` "exists"), and is left as it is. It is made with `mode`, minus the umask. A body a framework already read
 * (`request.body`) is written whole. Each call to the disk (the opening, each write, the closing)
 * is waited for no longer than `idleMs`: past it, the upload fails with a `DiskTimeout`. On any
 * failure (a 413 or a 408, a client that left, a full disk, a disk that does not answer), the file
 * is removed before the error is thrown, or once the disk answers.
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
    if (error instanceof DiskTimeout) void opening.then((late) => discard(late, file, false), () => undefined);
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
    await discard(handle, file, error instanceof DiskTimeout);
    throw writeError(error);
  }
  return size;
}

/** A new name for a temporary file of the spool in `directory`: never one that is there ("wx" makes sure). */
export const spoolFileIn = (directory: string): string => path.join(directory, `llf-upload-${randomUUID()}`);

/**
 * The file an upload's body was written to, while its ingest runs. `kept`: the application's file
 * (`prepareUpload`), which stays once the document is stored, and is removed when the upload fails.
 * Otherwise a temporary file of the spool, removed once the ingest ends, whatever the end.
 */
export class BodyFile {
  #stored = false;
  #removing: Promise<void> | undefined;

  constructor(readonly path: string, readonly kept: boolean) {}

  /**
   * Follows the ingest of the file (`ingesting`): when it ends, a temporary file is removed, and
   * the application's file too when it failed. It settles once that is done, as the ingest did.
   */
  async settle<T>(ingesting: Promise<T>): Promise<T> {
    try {
      const value = await ingesting;
      this.#stored = true;
      return value;
    } finally {
      await this.end();
    }
  }

  /** Removes the file, once: for an upload that failed after its document was stored (`onUploaded` threw). */
  remove(): Promise<void> {
    return (this.#removing ??= removeFile(this.path));
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
 * memory, `maxSpooledUploadBytes` for the files of the spool. `Infinity` counts nothing.
 */
export class Room {
  #used = 0;

  constructor(readonly limit: number) {}

  /**
   * Room for an upload of `bytes` (at most the limit itself, so that the count stays a number with
   * an upload limit of Infinity), taken before its body is read. One that would bring the room
   * past its limit while another upload holds some is refused: an `IngestError` "busy", answered
   * 503 with a wait. One upload alone is always taken.
   */
  take(bytes: number): Held {
    if (this.limit === Number.POSITIVE_INFINITY) return { resize: () => undefined, release: () => undefined };
    let held = Math.min(bytes, this.limit);
    if (this.#used > 0 && this.#used + held > this.limit) throw new IngestError("busy", BUSY, { retryAfterMs: BUSY_RETRY_MS });
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
