import { decodeNotUtf8, type DecodedText } from "./encoding.js";
import { TimeSlicer } from "./pause.js";
import type { Extractor } from "./types.js";

// Text files: their bytes decoded, in UTF-8, UTF-16 or the older encoding they were saved in.

const NOT_TEXT = "This file looks binary, not text. Attach a text, log, PDF, Word, PowerPoint, Excel or HTML file.";

/**
 * Decodes text bytes, honoring UTF-8 and UTF-16 byte-order marks (common for Windows logs).
 * A file that is not UTF-8 is read in the older encoding it was saved in, or as UTF-8 with its
 * characters that are not valid as U+FFFD (see encoding.ts). Throws a readable error for
 * compressed and other binary files.
 */
export function decodeText(bytes: Uint8Array): string {
  const steps = decodeSteps(bytes);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value.text;
}

/** `decodeText` in steps: it yields between the steps of a file that is not valid UTF-8. */
export function* decodeSteps(bytes: Uint8Array): Generator<void, DecodedText> {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)) };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)) };
  // Rotated logs often arrive as app.log.gz. Compressed bytes have few zeros, so name them here.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    throw new Error("This file is gzip-compressed. Decompress it, then attach the text file inside.");
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    throw new Error("This file is a ZIP archive. Extract it, then attach the text file you need.");
  }
  const sample = bytes.subarray(0, 8_192);
  let zeros = 0;
  for (const byte of sample) if (byte === 0) zeros++;
  // UTF-16 without a BOM: about half the bytes of ASCII text are zero.
  if (sample.length > 64 && zeros / sample.length > 0.3) {
    let oddZeros = 0;
    let evenText = 0;
    for (let index = 0; index < sample.length; index++) {
      if (index % 2 === 1 && sample[index] === 0) oddZeros++;
      if (index % 2 === 0 && sample[index] !== 0) evenText++;
    }
    const half = sample.length / 2;
    if (oddZeros / half > 0.6 && evenText / half > 0.6) return { text: new TextDecoder("utf-16le").decode(bytes) };
  }
  if (sample.length > 0 && zeros / sample.length > 0.01) throw new Error(NOT_TEXT);
  // Compressed, encrypted, and media files spread control bytes evenly: about 1 byte in 10.
  // Text has almost none, in UTF-8 or in a legacy single-byte encoding. Tab, line breaks, form
  // feed, and ESC (colour codes) do not count.
  let controls = 0;
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b) || byte === 0x7f) controls++;
  }
  if (sample.length >= 64 && controls / sample.length > 0.03) throw new Error(NOT_TEXT);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  // Not valid UTF-8: decoded as it is, the text would be replacement characters.
  return yield* decodeNotUtf8(bytes);
}

/**
 * Text files. One that is not UTF-8 is read in the older encoding it was saved in, when that can
 * be recognized, and other requests get a turn while it is read.
 */
export const plainText: Extractor = async (bytes, input) => {
  const slicer = new TimeSlicer(input?.signal);
  const steps = decodeSteps(bytes);
  let step = steps.next();
  // Only a file that is not UTF-8 takes steps: its decoding is told as one piece of progress, at the end.
  const stepped = !step.done;
  while (!step.done) {
    await slicer.maybePause();
    step = steps.next();
  }
  if (stepped) input?.onProgress?.({ stage: "decode", done: bytes.byteLength, total: bytes.byteLength, unit: "bytes" });
  const { text, encoding, replacedCharacters } = step.value;
  return { text, ...(encoding ? { encoding } : {}), ...(replacedCharacters ? { replacedCharacters } : {}) };
};

