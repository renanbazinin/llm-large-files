// The body of an upload, as `createDocumentHandlers` receives it: read into memory, or written to a
// file as it arrives. The file is the path `prepareUpload` gave (the application's, kept once its
// document is stored), or a temporary file of the spool (`uploadSpool`), removed once the ingest
// ends. Either way each piece of the body is counted against the upload limit (413) and waited for
// no longer than the idle time (408), and a file is always made new: opened with "wx", so that a
// file or a link already at its name is never written through. New in 0.9.0; the reading into
// memory moved here from handlers.ts.
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

/** `next`, or a 408 once `idleMs` pass without it. */
function withinIdle<T>(next: Promise<T>, idleMs: number): Promise<T> {
  // Once the upload is refused, the read it waited on ends with the connection: nobody awaits it.
  next.catch(() => undefined);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    const after = idleMs >= 1_000 ? `${Math.round(idleMs / 1_000)} s` : `${idleMs} ms`;
    timer = setTimeout(() => {
      // After the thread was held longer than `idleMs`, timers run before the data that came in the
      // meantime is read: it is read first, in this turn of the loop, and the upload goes on.
      setImmediate(() => {
        if (!settled) reject(new HttpError(408, `The upload stopped arriving: nothing came for ${after}. Send it again.`, true));
      });
    }, idleMs);
  });
  return Promise.race([next.finally(() => (settled = true)), idle]).finally(() => clearTimeout(timer));
}

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
  const timed = idleMs > 0 && idleMs <= LONGEST_TIMER_MS;
  try {
    for (;;) {
      const next = pieces.next();
      const { done, value: chunk } = timed ? await withinIdle(next, idleMs) : await next;
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

/** Writes all of `bytes` at the end of what `handle` has written. */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.byteLength; ) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.byteLength - at);
    if (bytesWritten <= 0) throw Object.assign(new Error("The upload could not be written."), { code: "EIO", syscall: "write" });
    at += bytesWritten;
  }
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/**
 * An error of writing an upload's file, as the upload is answered: a file already at the path is
 * "exists" (409; it was not written, nor removed), and a full disk "busy" (503, with a wait). Any
 * other error is passed on: a 413 or a 408 of the body, a client that left, or a system error,
 * answered with its code only (a folder that is not there is `ENOENT`).
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
 * Writes the request's body to a new file at `file`, as it arrives, and returns its size. The file
 * is opened with "wx": one already there, or a link at its name, is never written through (an
 * `IngestError` "exists"), and is left as it is. It is made with `mode`, minus the umask. A body a
 * framework already read (`request.body`) is written whole. On any failure (a 413 or a 408, a
 * client that left, a full disk), the file is removed before the error is thrown.
 */
export async function writeBody(request: IncomingMessage, file: string, options: { limit: number; idleMs: number; mode: number }): Promise<number> {
  const parsed = parsedBody(request);
  if (parsed && parsed.byteLength > options.limit) throw new HttpError(413, "");
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", options.mode);
  } catch (error) {
    throw writeError(error);
  }
  let size: number;
  try {
    if (parsed) {
      await writeAll(handle, parsed);
      size = parsed.byteLength;
    } else {
      size = await eachPiece(request, options.limit, options.idleMs, (piece) => writeAll(handle, piece));
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeFile(file);
    throw writeError(error);
  }
  try {
    // A disk that is full may say so only when the file is closed.
    await handle.close();
  } catch (error) {
    await removeFile(file);
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
