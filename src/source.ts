// Files ingested from a path (`IngestFromSource`), and the SHA-256 of what is ingested. New in 0.9.0.
// A file is looked at before the ingest's turn without being read (its size), read once when its
// turn comes, never past the upload limit, and hashed a slice at a time as it is read. Nothing
// here writes, moves or deletes a file.
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { TimeSlicer } from "./pause.js";

/**
 * How a file is opened to be read: never through a link at its name, where the platform can
 * (`O_NOFOLLOW`; Windows has none), and without waiting for a writer when it is a pipe
 * (`O_NONBLOCK`, which changes nothing for a file). What is opened is then checked to be a file.
 */
export const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** How much is read, and hashed, between two looks at the clock: 1 MB. */
export const SLICE_BYTES = 1024 * 1024;

/**
 * The error of a path that names no file the library reads, in the shape of a system error: a code
 * and a system call, so that it is passed on as the server's trouble, not told as a file a user
 * sent that cannot be read. Its message names no path.
 */
function pathError(message: string, code: string, syscall: string): Error {
  return Object.assign(new Error(message), { code, syscall });
}

/** Throws unless `info` is that of a file: not a link, a folder, a pipe or a device. */
function checkFile(info: Stats, syscall: string): void {
  if (info.isSymbolicLink()) throw pathError("The file to ingest is a link, which is not followed.", "ELOOP", syscall);
  if (info.isDirectory()) throw pathError("The path to ingest is a folder, not a file.", "EISDIR", syscall);
  if (!info.isFile()) throw pathError("The path to ingest is not a file.", "EINVAL", syscall);
}

/**
 * The size of the file at `path`, from `lstat`: a link is refused, not followed, and so is anything
 * that is not a file. Nothing of the file is read.
 */
export async function statSource(path: string): Promise<number> {
  const info = await lstat(path);
  checkFile(info, "lstat");
  return info.size;
}

/** An array of exactly `size` bytes, not filled: every byte is written before it is used. */
function unfilled(size: number): Uint8Array {
  const buffer = Buffer.allocUnsafeSlow(size);
  // A plain Uint8Array over the whole of its own memory, which is exactly `size` bytes: once it is
  // filled, nothing under it is left unwritten.
  return new Uint8Array(buffer.buffer, buffer.byteOffset, size);
}

/** What `readSource` read: the bytes when they were kept, how many there were, and their SHA-256. */
export type SourceRead = {
  /** The bytes read, in an array of exactly `size` bytes, when they were kept. */
  bytes?: Uint8Array;
  /** How many bytes were read: the size of the file, or `maxBytes + 1` when it has more than `maxBytes`. */
  size: number;
  /** The SHA-256 of the bytes read, as 64 lowercase hex digits. */
  sha256: string;
};

/**
 * Reads the file at `path` once, from its start: at most `maxBytes + 1` bytes, so that a file that
 * has grown past `maxBytes` since it was looked at is told (`size` above `maxBytes`) without
 * reading the rest: the caller refuses it. The bytes are hashed a slice (`SLICE_BYTES`) at a time, `slicer` may pause
 * between two slices, and `signal` stops the read between two slices. `keep` false hashes the bytes
 * and lets each slice go: only the size and the SHA-256 come back.
 */
export async function readSource(path: string, maxBytes: number, options: { keep: boolean; slicer?: TimeSlicer; signal?: AbortSignal }): Promise<SourceRead> {
  const { keep, slicer, signal } = options;
  signal?.throwIfAborted();
  const limit = maxBytes + 1;
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat();
    checkFile(info, "fstat");
    const hash = createHash("sha256");
    // Kept: the first array has the size the file has now (no more than the limit), so the usual
    // file is read into one array of its exact size; a file that grows meanwhile goes on in arrays
    // of a slice. Not kept: one slice is read into again and again.
    const full: Uint8Array[] = [];
    let current = unfilled(keep ? Math.min(info.size, limit) : SLICE_BYTES);
    let filled = 0;
    let size = 0;
    while (size < limit) {
      if (filled === current.byteLength) {
        if (keep) {
          if (filled > 0) full.push(current);
          current = unfilled(Math.min(SLICE_BYTES, limit - size));
        }
        filled = 0;
      }
      const { bytesRead } = await handle.read(current, filled, Math.min(SLICE_BYTES, current.byteLength - filled), size);
      if (bytesRead === 0) break;
      hash.update(current.subarray(filled, filled + bytesRead));
      filled += bytesRead;
      size += bytesRead;
      signal?.throwIfAborted();
      await slicer?.maybePause();
    }
    const sha256 = hash.digest("hex");
    if (!keep) return { size, sha256 };
    if (full.length === 0 && filled === current.byteLength) return { bytes: current, size, sha256 };
    if (full.length === 1 && filled === 0) return { bytes: full[0]!, size, sha256 };
    // A file that shrank, or grew, while it was read: its bytes in one array of their exact size.
    const bytes = unfilled(size);
    let at = 0;
    for (const part of [...full, current.subarray(0, filled)]) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    return { bytes, size, sha256 };
  } finally {
    await handle.close();
  }
}

/**
 * Bytes `start` (inclusive) to `end` (exclusive) of each range of the file at `path`, read in one
 * opening of it, as `readSource` opens it: fewer at the end of a file that has shrunk.
 */
export async function readRanges(path: string, ranges: ReadonlyArray<readonly [number, number]>): Promise<Uint8Array[]> {
  const handle = await open(path, READ_FLAGS);
  try {
    checkFile(await handle.stat(), "fstat");
    const parts: Uint8Array[] = [];
    for (const [start, end] of ranges) {
      const part = new Uint8Array(Math.max(0, end - start));
      let filled = 0;
      while (filled < part.byteLength) {
        const { bytesRead } = await handle.read(part, filled, part.byteLength - filled, start + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      parts.push(part.subarray(0, filled));
    }
    return parts;
  } finally {
    await handle.close();
  }
}

/**
 * The SHA-256 of `bytes`, as 64 lowercase hex digits, hashed a slice (`SLICE_BYTES`) at a time:
 * `slicer` may pause between two slices, so that a large file does not hold the server.
 */
export async function sha256InSlices(bytes: Uint8Array, slicer?: TimeSlicer): Promise<string> {
  const hash = createHash("sha256");
  for (let at = 0; at < bytes.byteLength; at += SLICE_BYTES) {
    hash.update(bytes.subarray(at, at + SLICE_BYTES));
    await slicer?.maybePause();
  }
  return hash.digest("hex");
}

/** Whether `value` is a SHA-256 as the library writes it: 64 lowercase hex digits. */
export const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
