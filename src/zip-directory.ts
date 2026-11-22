/**
 * Reads the directory of a ZIP file the way JSZip 3.10 reads it, before JSZip does, and adds up
 * what JSZip would keep from it. JSZip reads the whole directory into memory before it unpacks any
 * part, and the directory is written by whoever made the file: its count of parts, where it
 * starts, and how long each record is. So the count of parts is not taken from the end record. The
 * directory is found where JSZip will find it, and its records are walked as JSZip will walk them,
 * each by its own lengths, until JSZip would stop, or the file is past a limit.
 */

/** What JSZip would keep in memory from the directory of a ZIP file. */
export type ZipDirectory = {
  /** The parts JSZip would read, counted to one past the limit. */
  parts: number;
  /** Their extra fields, counted to one past the limit: JSZip keeps about 250 bytes for each. */
  extraFields: number;
  /**
   * The bytes JSZip turns into text, or goes through one by one, counted until they pass the
   * limit: the comment of the file, and for each part the name in the local header it points to
   * (a header that many parts point to counts once for each), its comment, and the data of its
   * ZIP64 (1), Unicode Path (0x7075) and Unicode Comment (0x6375) extra fields. That data may run
   * past the record, over the records after it.
   */
  textBytes: number;
  /**
   * The ZIP64 end record says it is longer than its fields. JSZip reads what follows in a loop that
   * does not move on: it stops when it runs out of data, or never.
   */
  endless: boolean;
};

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const LOCATOR = 0x07064b50;
const END64 = 0x06064b50;

/**
 * What JSZip would keep from the directory of `bytes`, up to the limits. Undefined when JSZip
 * would stop before it reads any part: the file is not a ZIP, or is damaged, and JSZip will say
 * so.
 *
 * JSZip reads the whole directory, then the local header of each part, and stops at the first part
 * it cannot read (a local header that is not there, an unknown way of packing). The names and
 * comments of the parts after it are counted too: such a file is not read either way.
 */
export function readZipDirectory(bytes: Uint8Array, limits: { parts: number; extraFields: number; textBytes: number }): ZipDirectory | undefined {
  const length = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // JSZip reads 4 bytes as a signed number, and of 8 bytes only the low 4, as a signed number.
  const int = (at: number) => view.getInt32(at, true);
  const short = (at: number) => view.getUint16(at, true);
  const at4 = (at: number, signature: number) => at >= 0 && at + 4 <= length && view.getUint32(at, true) === signature;
  // JSZip looks for a record from the end of the whole file, not only of its last 64 KB.
  const whole = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lastIndexOf = (signature: number) => {
    const needle = Buffer.alloc(4);
    needle.writeUInt32LE(signature);
    return whole.lastIndexOf(needle);
  };

  // The end record: 22 bytes, then its comment.
  const end = lastIndexOf(END);
  if (end < 0 || end + 22 > length || end + 22 + short(end + 20) > length) return undefined;
  let size = int(end + 12);
  let offset = int(end + 16);
  let zip64 = 0;
  if ([4, 6, 8, 10].some((field) => short(end + field) === 0xffff) || size === -1 || offset === -1) {
    // A field too small for its value: JSZip reads the ZIP64 end record where the last ZIP64
    // locator of the file says it is, or else the last ZIP64 end record of the file.
    const locator = lastIndexOf(LOCATOR);
    if (locator < 0 || locator + 20 > length || int(locator + 16) > 1) return undefined;
    let end64 = int(locator + 8);
    if (end64 < 0 || end64 + 4 > length) return undefined;
    if (!at4(end64, END64)) end64 = lastIndexOf(END64);
    if (end64 < 0 || end64 + 56 > length) return undefined;
    if (int(end64 + 4) > 44) return { parts: 0, extraFields: 0, textBytes: 0, endless: true };
    zip64 = 20 + 12 + int(end64 + 4);
    size = int(end64 + 40);
    offset = int(end64 + 48);
  }
  // Bytes before the archive, such as a program that unpacks it: JSZip reads every offset after them.
  const before = end - (offset + size + zip64);
  if (before < 0 || offset < 0 || before + offset > length) return undefined;

  const directory: ZipDirectory = { parts: 0, extraFields: 0, textBytes: short(end + 20), endless: false };
  /** Adds bytes JSZip turns into text or goes through, and says whether they are past the limit. */
  const text = (count: number) => (directory.textBytes += count) > limits.textBytes;
  let at = before + offset;
  // A record: 46 bytes, the name, the extra fields and the comment.
  while (at4(at, CENTRAL) && at + 46 <= length) {
    // JSZip stops at an encrypted part.
    if (short(at + 8) & 1) break;
    const extraStart = at + 46 + short(at + 28);
    const extraEnd = extraStart + short(at + 30);
    if (extraEnd > length) break;
    // Each extra field is 4 bytes and its data, read while more than 4 bytes are left. JSZip keeps
    // the last ZIP64 field (id 1) and goes on from the end of the extra fields.
    let field = extraStart;
    let zip64Data = -1;
    let zip64End = -1;
    while (field + 4 < extraEnd) {
      if (++directory.extraFields > limits.extraFields) return directory;
      const id = short(field);
      const fieldEnd = field + 4 + short(field + 2);
      // JSZip goes through the data of these fields byte by byte, and decodes the Unicode ones as
      // text, even when the data runs past the extra fields of the record.
      if ((id === 1 || id === 0x7075 || id === 0x6375) && text(fieldEnd - field - 4)) return directory;
      if (id === 1) {
        zip64Data = field + 4;
        zip64End = fieldEnd;
      }
      field = fieldEnd;
    }
    if (field > length) break;
    let local = int(at + 42);
    if (zip64Data >= 0) {
      // The ZIP64 field holds, 8 bytes each, the sizes and the offset the record has no room for,
      // in that order.
      const values = [int(at + 24), int(at + 20), local].filter((value) => value === -1).length;
      if (zip64Data + 8 * values > zip64End) break;
      if (local === -1) local = int(zip64Data + 8 * values - 8);
    }
    const comment = short(at + 32);
    const next = extraEnd + comment;
    if (next > length) break;
    if (++directory.parts > limits.parts) return directory;
    if (text(comment)) return directory;
    // The name is decoded from the local header the part points to.
    const header = before + local;
    if (local >= 0 && at4(header, LOCAL) && header + 30 <= length && header + 30 + short(header + 26) <= length) {
      if (text(short(header + 26))) return directory;
    }
    at = next;
  }
  return directory;
}
