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
 * catalog. Written with a classic cross-reference table. `declaredSize` writes another number of
 * objects into the trailer than the file has.
 */
export function pdfFromObjects(objects: Array<string | Uint8Array>, declaredSize = objects.length + 1): Uint8Array {
  const chunks: Uint8Array[] = [latin1("%PDF-1.5\n")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    const chunk = concat([latin1(`${index + 1} 0 obj\n`), typeof body === "string" ? latin1(body) : body, latin1("\nendobj\n")]);
    offsets.push(offset);
    chunks.push(chunk);
    offset += chunk.length;
  });
  chunks.push(latin1(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${declaredSize} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
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

/** Bytes that do not compress, the same on every run. */
function noise(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = (seed * 2_654_435_761) >>> 0 || 1;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

export type PicturePdfOptions = {
  /** Size of the image on each page, in bytes of uncompressed RGB. Defaults to 60,000. */
  imageBytes?: number;
  /**
   * One resource dictionary for the whole file, listing every image, as FPDF, TCPDF and jsPDF
   * write it. Each page still paints only its own image.
   */
  shared?: boolean;
  /** As `shared`, but each page paints its image through a form that has no resources of its own. */
  sharedThroughForm?: boolean;
  /** As `shared`, but the content writes the name of its image with an escape: "/I#31" for "/I1". */
  sharedWithEscapedNames?: boolean;
  /** A link on every page to the next one (and from the last to the first). */
  links?: boolean;
};

/**
 * `count` pages that each say "Page N of the test file." and show a picture of their own. The
 * pictures are noise: what matters is their size, and where the file keeps them.
 */
export function pdfWithPictures(count: number, options: PicturePdfOptions = {}): Uint8Array {
  const shared = Boolean(options.shared || options.sharedThroughForm || options.sharedWithEscapedNames);
  const width = 200;
  const height = Math.max(1, Math.round((options.imageBytes ?? 60_000) / (width * 3)));
  // 1 catalog, 2 page tree, 3 font, 4 the shared resources (or nothing of interest), then per
  // page: the page, its content, its image, a form, a link.
  const PER_PAGE = 5;
  const page = (index: number) => 5 + index * PER_PAGE;
  const objects: Array<string | Uint8Array> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${page(index)} 0 R`).join(" ")}] /Count ${count} /MediaBox [0 0 612 792] >>`,
    HELVETICA,
    `<< /Font << /F1 3 0 R >> /XObject << ${Array.from({ length: count }, (_, index) => `/I${index + 1} ${page(index) + 2} 0 R /Fm${index + 1} ${page(index) + 3} 0 R`).join(" ")} >> >>`,
  ];
  for (let index = 0; index < count; index++) {
    const number = index + 1;
    // "#3N" is the digit N: the same name as in the dictionary, written another way.
    const image = options.sharedWithEscapedNames ? `/I#3${String(number)[0]}${String(number).slice(1)}` : shared ? `/I${number}` : "/Im1";
    const place = `q ${width} 0 0 ${height} 72 500 cm`;
    const resources = shared ? "4 0 R" : `<< /Font << /F1 3 0 R >> /XObject << /Im1 ${page(index) + 2} 0 R >> >>`;
    const annotations = options.links ? ` /Annots [${page(index) + 4} 0 R]` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /Resources ${resources} /Contents ${page(index) + 1} 0 R${annotations} >>`);
    objects.push(pdfStream("", `${textLine(`Page ${number} of the test file.`)}\n${options.sharedThroughForm ? `q /Fm${number} Do Q` : `${place} ${image} Do Q`}`));
    objects.push(pdfStream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8`, noise(width * height * 3, number)));
    // No /Resources on purpose: old PDFs let a form take its names from the page that paints it.
    objects.push(pdfStream("/Type /XObject /Subtype /Form /BBox [0 0 612 792]", `${place} /I${number} Do Q`));
    objects.push(`<< /Type /Annot /Subtype /Link /Rect [72 700 300 712] /Border [0 0 0] /P ${page(index)} 0 R /Dest [${page((index + 1) % count)} 0 R /Fit] >>`);
  }
  return pdfFromObjects(objects);
}

/**
 * A PDF put together object by object, for tests that need a particular structure. Object 3 is
 * the font /F1 (Helvetica), which every page gets.
 */
export class PdfBuilder {
  private readonly objects: Array<string | Uint8Array> = ["", "", HELVETICA];
  private readonly pages: number[] = [];

  /** Adds an object and returns its number. */
  add(body: string | Uint8Array): number {
    this.objects.push(body);
    return this.objects.length;
  }

  /** A small image (noise). How large it shows is decided by the content that paints it. */
  image(): number {
    return this.add(pdfStream("/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8", noise(64, this.objects.length)));
  }

  /** A form: content that a page paints with `/Name Do`. `entries` are added to its dictionary. */
  form(content: string, entries = ""): number {
    return this.add(pdfStream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] ${entries}`, content));
  }

  /** Puts another body in the place of an object: for one that has to name itself. */
  replace(number: number, body: string | Uint8Array): void {
    this.objects[number - 1] = body;
  }

  /**
   * A page of 612 x 792 units. `xobjects` names the images and forms its content may paint.
   * `dictionary` adds entries to the content stream, for content that is stored encoded.
   */
  page(content: string | Uint8Array, xobjects: Record<string, number> = {}, dictionary = ""): number {
    const stream = this.add(pdfStream(dictionary, content));
    const named = Object.entries(xobjects).map(([name, object]) => `/${name} ${object} 0 R`).join(" ");
    const page = this.add(`<< /Type /Page /Parent 2 0 R /Contents ${stream} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << ${named} >> >> >>`);
    this.pages.push(page);
    return page;
  }

  build(declaredSize?: number): Uint8Array {
    this.objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    this.objects[1] = `<< /Type /Pages /Kids [${this.pages.map((page) => `${page} 0 R`).join(" ")}] /Count ${this.pages.length} /MediaBox [0 0 612 792] >>`;
    return pdfFromObjects(this.objects, declaredSize);
  }
}

/** Content that paints the image or form `name` in a box of `width` x `height` units at (x, y). */
export function paint(name: string, width: number, height: number, x = 72, y = 400): string {
  return `q ${width} 0 0 ${height} ${x} ${y} cm /${name} Do Q`;
}

/** Content that fills a rectangle with a colour given as red, green and blue between 0 and 1. */
export function filled(colour: [number, number, number], x: number, y: number, width: number, height: number): string {
  return `${colour.join(" ")} rg ${x} ${y} ${width} ${height} re f`;
}

/**
 * Two pages with one layer that is shown and one that is hidden, a rotation and a crop box that
 * the pages inherit from the page tree.
 */
export function layeredPdf(): Uint8Array {
  const layers = "/Properties << /Shown 5 0 R /Hidden 6 0 R >>";
  return pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /Name (Default) /ON [5 0 R] /OFF [6 0 R] /Order [5 0 R 6 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 /MediaBox [0 0 595 842] /CropBox [20 20 575 822] /Rotate 90 >>",
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> ${layers} >> /Contents 7 0 R >>`,
    HELVETICA,
    "<< /Type /OCG /Name (Shown layer) >>",
    "<< /Type /OCG /Name (Hidden layer) >>",
    pdfStream("", `/OC /Shown BDC ${textLine("This line is on the layer that is shown.", 700)} EMC\n/OC /Hidden BDC ${textLine("This line is on the layer that is hidden.", 650)} EMC`),
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> ${layers} >> /Contents 9 0 R >>`,
    pdfStream("", textLine("Page two, outside any layer.", 700)),
  ]);
}
