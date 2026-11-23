// `fileOriginals`: the uploaded files an application keeps in a folder of its own, read back by
// their ref (`IngestInput.original`) for `LargeFilesOptions.originals`. Read only: nothing here
// writes, moves or deletes a file. New in 0.9.0.
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { OriginalReadContext, OriginalsReader } from "../library.js";
import { readSource } from "../source.js";

/** The longest ref read, as `IngestInput.original.ref` allows. */
const MAX_REF_LENGTH = 1_024;

/** The refusal of a ref that does not name a file inside the folder. It does not repeat the ref. */
const OUTSIDE = "The ref of an original must be a relative path to a file inside the folder of fileOriginals.";

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/**
 * A read that found no file to read: none there, a part of its path that is a file, a link at its
 * name (which is not followed: `O_NOFOLLOW`; Linux and macOS say ELOOP, FreeBSD EMLINK), or a folder
 * or another thing that is not a file (as `readSource` says).
 */
const notThere = (error: unknown) => ["ENOENT", "ENOTDIR", "ELOOP", "EMLINK", "EISDIR", "EINVAL"].includes(codeOf(error) as string);

/**
 * Reads the uploaded files that an application keeps under the folder `root`, for
 * `createLargeFiles({ originals })`. A ref (`IngestInput.original.ref`) is a path relative to `root`,
 * such as `${userId}/${chatId}/uploads/${uploadId}`:
 *
 * - One that is not inside `root` (absolute elsewhere, or with ".." that leads out) is a TypeError,
 *   which the library passes on as a `DocumentStoreError` with it as `cause`.
 * - One with a link at any level below `root`, whether it points inside or out, reads as missing
 *   (undefined): its real path must be the path it names. `root` itself may be a link. The file
 *   is opened without following a link at its name, where the platform can (not on Windows).
 * - A file that is not there, or a folder, reads as missing.
 * - A file is read once, and no more than one byte past the size it had at ingest
 *   (`OriginalReadContext.bytes`): the library then finds that it has changed.
 *
 * New in 0.9.0.
 */
export function fileOriginals(root: string): OriginalsReader {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) throw new TypeError("fileOriginals needs the path of a folder: a string that is not empty.");
  const base = path.resolve(root);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  /** The real path of `root`, found once; found again after a failure. */
  let realBase: Promise<string> | undefined;
  return Object.freeze({
    async read(ref: string, context?: OriginalReadContext): Promise<Uint8Array | undefined> {
      if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_REF_LENGTH || ref.includes("\0")) throw new TypeError(OUTSIDE);
      const file = path.resolve(base, ref);
      if (!file.startsWith(prefix) || file.length === prefix.length) throw new TypeError(OUTSIDE);
      let real: string;
      try {
        real = await realpath(file);
      } catch (error) {
        if (notThere(error)) return undefined;
        throw error;
      }
      realBase ??= realpath(base);
      let realRoot: string;
      try {
        realRoot = await realBase;
      } catch (error) {
        realBase = undefined;
        throw error;
      }
      // A link at any level below the root: its real path is not the path the ref names.
      if (real !== path.join(realRoot, path.relative(base, file))) return undefined;
      const expected = context?.bytes;
      const most = typeof expected === "number" && Number.isSafeInteger(expected) && expected >= 0 ? expected : Number.POSITIVE_INFINITY;
      try {
        return (await readSource(file, most, { keep: true })).bytes;
      } catch (error) {
        if (notThere(error)) return undefined;
        throw error;
      }
    },
  });
}
