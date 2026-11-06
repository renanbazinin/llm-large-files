import type { DocumentFormat, ExtractedText, Extractor } from "./types.js";

const EXTENSION_FORMATS: Record<string, DocumentFormat> = {
  log: "log", out: "log", err: "log",
  md: "markdown", markdown: "markdown",
  json: "json", jsonl: "json", ndjson: "json",
  csv: "csv", tsv: "csv",
  pdf: "pdf", docx: "docx", pptx: "pptx",
};

const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/markdown": "markdown",
  "application/json": "json",
  "text/csv": "csv",
};

/** Picks a format from the file name, then the MIME type. Unknown text-like files are "text". */
export function detectFormat(name: string, mimeType: string): DocumentFormat {
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  return EXTENSION_FORMATS[extension] ?? MIME_FORMATS[mimeType.toLowerCase()] ?? "text";
}

/** Decodes text bytes, honoring UTF-8 and UTF-16 byte-order marks (common for Windows logs). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
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
    if (oddZeros / half > 0.6 && evenText / half > 0.6) return new TextDecoder("utf-16le").decode(bytes);
  }
  if (sample.length > 0 && zeros / sample.length > 0.01) {
    throw new Error("This file looks binary, not text. Attach a text, log, PDF, DOCX, or PPTX file.");
  }
  return new TextDecoder("utf-8").decode(bytes);
}

const plainText: Extractor = async (bytes) => ({ text: decodeText(bytes) });

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Text of each `<prefix:p>` paragraph in Office XML. Regex keeps this free of an XML parser dependency. */
export function officeXmlParagraphs(xml: string, prefix: "w" | "a"): string[] {
  const paragraphs = xml.match(new RegExp(`<${prefix}:p[\\s>][\\s\\S]*?</${prefix}:p>`, "g")) ?? [];
  const textPattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:t>|<${prefix}:(tab|br)\\b[^>]*/>`, "g");
  return paragraphs.map((paragraph) => {
    let text = "";
    for (const match of paragraph.matchAll(textPattern)) {
      if (match[2] === "tab") text += "\t";
      else if (match[2] === "br") text += "\n";
      else text += decodeXmlEntities(match[1] ?? "");
    }
    return text;
  }).filter((text) => text.trim());
}

type ZipFile = { async(type: "string"): Promise<string> };
type ZipArchive = { files: Record<string, unknown>; file(name: string): ZipFile | null };

async function loadZip(bytes: Uint8Array): Promise<ZipArchive> {
  let JSZip: { loadAsync(data: Uint8Array): Promise<ZipArchive> };
  try {
    JSZip = (await import("jszip")).default as unknown as typeof JSZip;
  } catch {
    throw new Error("Reading DOCX and PPTX files needs the optional dependency \"jszip\".");
  }
  return JSZip.loadAsync(bytes);
}

const docx: Extractor = async (bytes) => {
  const archive = await loadZip(bytes);
  const names = Object.keys(archive.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name))
    .sort((left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right));
  if (!names.includes("word/document.xml")) throw new Error("This DOCX does not contain word/document.xml.");
  const sections: string[] = [];
  for (const name of names) {
    const xml = await archive.file(name)?.async("string");
    if (xml) sections.push(officeXmlParagraphs(xml, "w").join("\n"));
  }
  return { text: sections.filter(Boolean).join("\n\n") };
};

const pptx: Extractor = async (bytes) => {
  const archive = await loadZip(bytes);
  const slideNumber = (name: string) => Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const names = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  if (names.length === 0) throw new Error("This PPTX does not contain any slides.");
  const slides: string[] = [];
  for (const name of names) {
    const xml = await archive.file(name)?.async("string");
    const text = xml ? officeXmlParagraphs(xml, "a").join("\n") : "";
    slides.push(`## Slide ${slideNumber(name)}\n${text || "[No text on this slide]"}`);
  }
  return { text: slides.join("\n\n"), pages: names.length };
};

const pdf: Extractor = async (bytes) => {
  let unpdf: typeof import("unpdf");
  try {
    unpdf = await import("unpdf");
  } catch {
    throw new Error("Reading PDF files needs the optional dependency \"unpdf\".");
  }
  // pdf.js may detach the buffer it reads, so give it a copy.
  const document = await unpdf.getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await unpdf.extractText(document, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  if (!pages.some((page) => page.trim())) {
    throw new Error("This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.");
  }
  return {
    text: pages.map((page, index) => `--- Page ${index + 1} ---\n${page.trim()}`).join("\n\n"),
    pages: totalPages,
  };
};

export const defaultExtractors: Record<DocumentFormat, Extractor> = {
  text: plainText,
  markdown: plainText,
  log: plainText,
  json: plainText,
  csv: plainText,
  pdf,
  docx,
  pptx,
};

export async function extractText(
  bytes: Uint8Array,
  input: { name: string; mimeType: string; format: DocumentFormat },
  extractors: Partial<Record<DocumentFormat, Extractor>> = {},
): Promise<ExtractedText> {
  const extractor = extractors[input.format] ?? defaultExtractors[input.format];
  return extractor(bytes, input);
}
