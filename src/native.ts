// Small visual files sent as themselves (`ModelCapabilities.documents`, new in 0.99.9): what an
// adapter is given and declares, checked; what every model of a question shares; which documents
// are visual; and the file and the line the loop sends before the text of the documents. The text
// always goes too: citations, counts and the tools work from it.
import type { ModelAdapter } from "./model.js";
import type { DocumentMeta, NativeDocumentFormat, ToolFile } from "./types.js";

/** The most bytes of one file sent as it is, unless the capability says otherwise: 4 MiB. New in 0.99.9. */
export const DEFAULT_NATIVE_FILE_BYTES = 4 * 1024 * 1024;
/** The most pages (slides, for a deck) of one file sent as it is, unless the capability says otherwise. New in 0.99.9. */
export const DEFAULT_NATIVE_PAGES = 10;
/** The formats a model may be sent as they are. */
export const NATIVE_FORMATS: readonly NativeDocumentFormat[] = ["pdf", "pptx"];
/** The MIME type each of them is sent with. */
export const NATIVE_MIME_TYPES: Readonly<Record<NativeDocumentFormat, string>> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** A capability with its defaults filled in. */
export type Documents = { formats: NativeDocumentFormat[]; maxFileBytes: number; maxPages: number };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A value in an error: a string quoted, a number as it is, else its type. */
const shown = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : typeof value === "number" ? String(value) : value === null ? "null" : Array.isArray(value) ? "a list" : typeof value);
const isNativeFormat = (value: unknown): value is NativeDocumentFormat => NATIVE_FORMATS.includes(value as NativeDocumentFormat);

/**
 * An adapter's `documents` option, checked, with its defaults filled in. Undefined when it was left
 * out. A value that is not valid is a TypeError (a RangeError for a number out of range) when the
 * adapter is made.
 */
export function documentsOption(adapter: string, value: unknown, allowed: readonly NativeDocumentFormat[]): Documents | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new TypeError(`${adapter}: documents must be an object with a list of formats, and is ${shown(value)}.`);
  const { formats, maxFileBytes, maxPages } = value as { formats?: unknown; maxFileBytes?: unknown; maxPages?: unknown };
  if (!Array.isArray(formats)) throw new TypeError(`${adapter}: documents.formats must be a list of formats, and is ${shown(formats)}.`);
  if (formats.length === 0) throw new TypeError(`${adapter}: documents.formats must name at least one format.`);
  const bad = formats.findIndex((format: unknown) => !allowed.includes(format as NativeDocumentFormat));
  if (bad >= 0) {
    const list = allowed.map((format) => JSON.stringify(format)).join(" and ");
    throw new TypeError(`${adapter}: documents.formats may name only ${list}, and names ${shown(formats[bad])}.`);
  }
  const whole = (name: string, given: unknown, fallback: number): number => {
    if (given === undefined) return fallback;
    if (typeof given === "number" && Number.isSafeInteger(given) && given > 0) return given;
    throw new (typeof given === "number" ? RangeError : TypeError)(`${adapter}: documents.${name} must be a whole number above 0, and is ${shown(given)}.`);
  };
  return {
    formats: [...new Set(formats as NativeDocumentFormat[])],
    maxFileBytes: whole("maxFileBytes", maxFileBytes, DEFAULT_NATIVE_FILE_BYTES),
    maxPages: whole("maxPages", maxPages, DEFAULT_NATIVE_PAGES),
  };
}

/**
 * What a model declares (`capabilities.documents`), read as the loop reads capabilities: leniently.
 * Undefined unless it is an object with a list of formats, of which one at least is known. A limit
 * that is not a number above 0 is its default.
 */
export function documentsOf(adapter: ModelAdapter): Documents | undefined {
  const given: unknown = (adapter.capabilities as { documents?: unknown }).documents;
  if (!isObject(given) || !Array.isArray(given.formats)) return undefined;
  const formats = [...new Set((given.formats as unknown[]).filter(isNativeFormat))];
  if (formats.length === 0) return undefined;
  const limit = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);
  return { formats, maxFileBytes: limit(given.maxFileBytes, DEFAULT_NATIVE_FILE_BYTES), maxPages: limit(given.maxPages, DEFAULT_NATIVE_PAGES) };
}

/**
 * What every model of a question shares: the formats all of them read, and the smallest limits.
 * Undefined when one declares none, or they share no format.
 */
export function sharedDocuments(models: readonly ModelAdapter[]): Documents | undefined {
  let shared: Documents | undefined;
  for (const model of models) {
    const own = documentsOf(model);
    if (!own) return undefined;
    shared = shared
      ? { formats: shared.formats.filter((format) => own.formats.includes(format)), maxFileBytes: Math.min(shared.maxFileBytes, own.maxFileBytes), maxPages: Math.min(shared.maxPages, own.maxPages) }
      : own;
  }
  return shared && shared.formats.length > 0 ? shared : undefined;
}

/**
 * The line of a page that shows a picture, or that has no text, right under its header: only the
 * extractor writes these (a line the document only quotes is moved by a space).
 */
const PICTURE_OR_SCAN = /^--- Page \d+ ---\n\[(?:Picture on this page\. This text cannot show it|No text on this page\. It may be a scan, a photo, or a chart)\.\]$/m;

/**
 * True for a file whose pages show what its text cannot: a PDF with a page without text or with a
 * picture line, and every deck (PPTX). False for every other format.
 */
export function visualFile(meta: Pick<DocumentMeta, "format" | "pagesWithoutText">, text: string): boolean {
  if (meta.format === "pptx") return true;
  if (meta.format !== "pdf") return false;
  return (meta.pagesWithoutText?.length ?? 0) > 0 || PICTURE_OR_SCAN.test(text);
}

/** The uploaded file of a document as the loop sends it: `attached-${index}.${format}`, with the format's MIME type. */
export function nativeFile(meta: Pick<DocumentMeta, "format">, bytes: Uint8Array, index: number): ToolFile {
  const format = meta.format as NativeDocumentFormat;
  return { name: `attached-${index}.${format}`, mimeType: NATIVE_MIME_TYPES[format] ?? "application/octet-stream", bytes };
}

/** The line, before the documents' text, that names the files sent above it, by the names of their documents. */
export function nativeFilesLine(names: readonly string[]): string {
  const list = names.map((name) => JSON.stringify(name)).join(", ");
  return names.length === 1
    ? `The file attached above is ${list}, as it was uploaded. Look at it for its pictures, charts and layout. Cite and count from its text below.`
    : `The ${names.length} files attached above are ${list}, in this order, as they were uploaded. Look at them for their pictures, charts and layout. Cite and count from their text below.`;
}

/** The image types a turn of a message may carry to OpenAI and Claude. */
const MESSAGE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * How an adapter of OpenAI or Claude sends a file of a message (`ModelTextMessage.files`): "pdf"
 * or "image". A file of another type is a TypeError, before anything is sent.
 */
export function messageFileKind(adapter: string, file: ToolFile): "pdf" | "image" {
  const type = String(file?.mimeType);
  if (type === "application/pdf") return "pdf";
  if (MESSAGE_IMAGE_TYPES.has(type)) return "image";
  throw new TypeError(`${adapter}: a file of a message must be a PDF or a PNG, JPEG, GIF or WebP image, and ${JSON.stringify(String(file?.name))} is ${type}.`);
}
