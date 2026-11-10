// Small PDFs written by hand for the tests: no PDF library is needed to make them.

const encoder = new TextEncoder();

/** Bytes of a string whose characters are all below 256 (PDF syntax, or binary data as Latin-1). */
function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A stream object body: `dictionary` holds the entries other than /Length. */
export function pdfStream(dictionary: string, data: string | Uint8Array): Uint8Array {
  const bytes = typeof data === "string" ? latin1(data) : data;
  return concat([latin1(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, latin1("\nendstream")]);
}

/**
 * A PDF file from the bodies of its objects: `objects[0]` is object 1, and object 1 must be the
 * catalog. Written with a classic cross-reference table.
 */
export function pdfFromObjects(objects: Array<string | Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [latin1("%PDF-1.5\n")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    const chunk = concat([latin1(`${index + 1} 0 obj\n`), typeof body === "string" ? latin1(body) : body, latin1("\nendobj\n")]);
    offsets.push(offset);
    chunks.push(chunk);
    offset += chunk.length;
  });
  chunks.push(latin1(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return concat(chunks);
}

export const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** The content of a page that shows one line of text. */
export function textLine(text: string, y = 720): string {
  return `BT /F1 12 Tf 72 ${y} Td (${text}) Tj ET`;
}

/** A PDF with one page per content stream. Every page has the font /F1 (Helvetica). */
export function pdfWithPages(contents: string[]): Uint8Array {
  // 1 catalog, 2 page tree, 3 font, then a page and its content for each entry.
  const objects: Array<string | Uint8Array> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${contents.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${contents.length} /MediaBox [0 0 612 792] >>`,
    HELVETICA,
  ];
  contents.forEach((content, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(pdfStream("", content));
  });
  return pdfFromObjects(objects);
}

/** `count` pages that each say "Page N of the test file." */
export function numberedPdf(count: number): Uint8Array {
  return pdfWithPages(Array.from({ length: count }, (_, index) => textLine(`Page ${index + 1} of the test file.`)));
}

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
