import { readdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPdfExtractor, PICTURE_ON_PAGE, type PdfExtractorOptions } from "../src/extract.js";
import { findPicturePages } from "../src/pdf-pictures.js";
import { filled, paint, PdfBuilder, pdfStream, textLine } from "./pdf-fixtures.js";

const input = { name: "a.pdf", mimeType: "application/pdf", format: "pdf" as const };
const read = async (bytes: Uint8Array, options?: PdfExtractorOptions) => (await createPdfExtractor(options)(bytes, input)).text;
/** The pages whose header is followed by the line that says the page shows a picture. */
const marked = (text: string): number[] => text.split("\n\n").flatMap((page) => {
  const [header, second] = page.split("\n");
  return second === PICTURE_ON_PAGE ? [Number(/^--- Page (\d+) ---$/.exec(header ?? "")?.[1])] : [];
});
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url)));

/** One page per content. Each page can paint /Im1, an image of its own. */
function pagesWith(contents: string[]): Uint8Array {
  const builder = new PdfBuilder();
  for (const content of contents) builder.page(content, { Im1: builder.image() });
  return builder.build();
}

const RED: [number, number, number] = [0.84, 0.15, 0.16];
const GREEN: [number, number, number] = [0.17, 0.63, 0.17];
const BLUE: [number, number, number] = [0.16, 0.44, 0.86];
/** Three bars in three colours: the least that counts as a chart. */
const BARS = [filled(BLUE, 100, 300, 60, 150), filled(RED, 200, 300, 60, 260), filled(GREEN, 300, 300, 60, 190)].join("\n");

describe("picture marks: images", () => {
  it("writes a line under the header of a page that shows a picture, and of no other page", async () => {
    const builder = new PdfBuilder();
    const photo = builder.image();
    const logo = builder.image();
    builder.page(textLine("Only text here."));
    builder.page(`${textLine("A page with a photo.")}\n${paint("Im1", 300, 200)}`, { Im1: photo });
    builder.page(`${textLine("A page with a small logo.")}\n${paint("Logo", 60, 20, 480, 740)}`, { Logo: logo });
    expect(await read(builder.build())).toBe([
      "--- Page 1 ---\nOnly text here.",
      "--- Page 2 ---\n[Picture on this page. This text cannot show it.]\nA page with a photo.",
      "--- Page 3 ---\nA page with a small logo.",
    ].join("\n\n"));
  });

  it("goes by the size a picture is shown at: the image here has 64 pixels", async () => {
    // The page is 612 x 792 units. A picture counts from 3% of that: 14,541 square units.
    const text = await read(pagesWith([
      `${textLine("Half the page.")}\n${paint("Im1", 306, 396)}`,
      `${textLine("An icon.")}\n${paint("Im1", 40, 30)}`,
      `${textLine("Just under 3 percent.")}\n${paint("Im1", 120, 110)}`,
      `${textLine("Just over 3 percent.")}\n${paint("Im1", 130, 115)}`,
      `${textLine("Four small pictures.")}\n${[0, 1, 2, 3].map((index) => paint("Im1", 70, 60, 72 + index * 90, 400)).join("\n")}`,
      `${textLine("Turned a quarter.")}\nq 0 200 -300 0 400 300 cm /Im1 Do Q`,
      `${textLine("Mostly off the page.")}\n${paint("Im1", 300, 200, 600, 400)}`,
    ]));
    expect(marked(text)).toEqual([1, 4, 5, 6]);
  });

  it("does not take a background or a logo that is on many pages for a picture, however large", async () => {
    const background = new PdfBuilder();
    const shared = background.image();
    for (let page = 1; page <= 5; page++) background.page(`${paint("Bg", 612, 792, 0, 0)}\n${textLine(`Page ${page} on the letterhead.`)}`, { Bg: shared });
    expect(marked(await read(background.build()))).toEqual([]);

    // The same pages with a picture of their own each.
    const album = new PdfBuilder();
    for (let page = 1; page <= 5; page++) album.page(`${paint("Im1", 612, 792, 0, 0)}\n${textLine(`Photo ${page}.`)}`, { Im1: album.image() });
    expect(marked(await read(album.build()))).toEqual([1, 2, 3, 4, 5]);

    // A figure that is shown twice in a long file is a picture both times.
    const report = new PdfBuilder();
    const figure = report.image();
    for (let page = 1; page <= 12; page++) report.page(page === 4 || page === 9 ? `${textLine("See the figure.")}\n${paint("Im1", 300, 200)}` : textLine(`Text of page ${page}.`), { Im1: figure });
    expect(marked(await read(report.build()))).toEqual([4, 9]);
  });

  it("finds a picture that is painted through a form, with the matrix of the form", async () => {
    const builder = new PdfBuilder();
    const inner = paint("Im1", 300, 200);
    const own = (entries = "") => builder.form(inner, `${entries} /Resources << /XObject << /Im1 ${builder.image()} 0 R >> >>`);
    const page = (label: string, form: number, onPage: Record<string, number> = {}) => builder.page(`${textLine(label)}\nq /Fm1 Do Q`, { Fm1: form, ...onPage });
    page("Through a form.", own());
    page("Through a form that shrinks it to a tenth.", own("/Matrix [0.1 0 0 0.1 0 0]"));
    // No resources of its own: the form takes /Im1 from the page that paints it.
    page("Through a form without resources.", builder.form(inner), { Im1: builder.image() });
    // A form that paints itself must not hang the reader.
    const loop = builder.form("");
    builder.replace(loop, pdfStream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /Self ${loop} 0 R >> >>`, "q /Self Do Q"));
    page("Through a form that paints itself.", loop);
    expect(marked(await read(builder.build()))).toEqual([1, 3]);
  });
});

describe("picture marks: drawings", () => {
  it("marks shapes filled in three colours, in any colour notation and any way of drawing them", async () => {
    const text = await read(pagesWith([
      `${textLine("A bar chart.")}\n${BARS}`,
      `${textLine("The same in CMYK.")}\n0 1 1 0 k 100 300 60 150 re f\n1 0 1 0 k 200 300 60 260 re f\n1 1 0 0 k 300 300 60 190 re f`,
      `${textLine("Drawn as paths, filled and stroked.")}\n${RED.join(" ")} rg 100 300 m 160 300 l 160 450 l 100 450 l h B\n${GREEN.join(" ")} rg 200 300 m 260 300 l 260 560 l h f*\n${BLUE.join(" ")} rg 300 300 m 380 300 400 400 360 490 c h b`,
      `${textLine("With a colour space.")}\n/Cs1 cs 0.9 0.1 0.1 sc 100 300 60 150 re f\n0.1 0.8 0.1 scn 200 300 60 260 re f\n0.1 0.1 0.9 sc 300 300 60 190 re f`,
    ]));
    expect(marked(text)).toEqual([1, 2, 3, 4]);
  });

  it("does not mark what a page of text also draws: one or two colours, greys, rules, dots, a background, outlines", async () => {
    const text = await read(pagesWith([
      `${textLine("Two colours.")}\n${filled(BLUE, 100, 300, 60, 150)}\n${filled(RED, 200, 300, 60, 260)}`,
      `${textLine("One colour, many bars.")}\n${[0, 1, 2, 3, 4].map((index) => filled(BLUE, 100 + index * 80, 300, 60, 100 + index * 30)).join("\n")}`,
      `${textLine("Black, white and greys.")}\n0 g 100 300 60 150 re f\n0.5 g 200 300 60 260 re f\n${filled([0.8, 0.8, 0.82], 300, 300, 60, 190)}\n1 g 400 300 60 90 re f`,
      `${textLine("Rules in three colours.")}\n${filled(RED, 72, 600, 400, 1)}\n${filled(GREEN, 72, 580, 400, 1)}\n${filled(BLUE, 72, 560, 400, 1)}`,
      `${textLine("Dots in three colours.")}\n${filled(RED, 72, 600, 3, 3)}\n${filled(GREEN, 82, 600, 3, 3)}\n${filled(BLUE, 92, 600, 3, 3)}`,
      `${filled([0.9, 0.95, 1], 0, 0, 612, 792)}\n${textLine("A coloured page with two colours on it.")}\n${filled(RED, 100, 300, 60, 150)}\n${filled(GREEN, 200, 300, 60, 150)}`,
      `${textLine("Outlines only.")}\n1 0 0 RG 100 300 60 150 re S\n0 1 0 RG 200 300 60 260 re S\n0 0 1 RG 300 300 60 190 re S`,
      `${textLine("Paths that are dropped without being painted.")}\n${RED.join(" ")} rg 100 300 60 150 re n\n${GREEN.join(" ")} rg 200 300 60 260 re W n\n${BLUE.join(" ")} rg 300 300 60 190 re n`,
    ]));
    expect(marked(text)).toEqual([]);
  });

  it("does not take the shading of a table's cells for a drawing", async () => {
    const cell = (x: number, y: number, value: string) => `BT /F1 10 Tf ${x} ${y} Td (${value}) Tj ET`;
    const rows = [["Site", "Opened", "Staff", "Status"], ["Leeds", "2019", "42", "on track"], ["Porto", "2021", "", "at risk"], ["Graz", "2024", "17", "late"]];
    const table = rows.flatMap((row, line) => row.flatMap((value, column) => (value ? [cell([72, 200, 260, 320][column]!, 700 - line * 20, value)] : []))).join("\n");
    // Green, yellow and red behind the last cell of each row.
    const shading = [filled([0.6, 0.9, 0.6], 316, 676, 70, 16), filled([1, 0.9, 0.4], 316, 656, 70, 16), filled([1, 0.6, 0.55], 316, 636, 70, 16)].join("\n");
    const text = await read(pagesWith([
      `${shading}\n${table}`,
      `${shading}\n${textLine("The same three coloured boxes with no table around them.")}`,
    ]));
    expect(text).toContain("| Site | Opened | Staff | Status |\n| Leeds | 2019 | 42 | on track |\n| Porto | 2021 |  | at risk |");
    expect(marked(text)).toEqual([2]);
  });

  it("is not misled by text that reads like drawing, by the data of an inline image, or by a comment", async () => {
    const text = await read(pagesWith([
      // The words of a string are not operators, whatever they say.
      `BT /F1 12 Tf 72 720 Td (q 500 0 0 500 0 0 cm /Im1 Do Q \\) and more) Tj ET`,
      `% ${paint("Im1", 500, 500)}\n${textLine("A comment is not content.")}`,
      // The bytes of an inline image may spell anything. What follows it is content again.
      `BI /W 4 /H 4 /BPC 8 /CS /G ID q 0.001 0 0 0.001 0 0 cm Do Q)(( EI\n${textLine("After an inline image.")}\n${paint("Im1", 300, 200)}`,
      // A matrix set inside q ... Q is gone after the Q.
      `q 0.01 0 0 0.01 0 0 cm Q\n${textLine("After a restored state.")}\n${paint("Im1", 300, 200)}`,
      `0.01 0 0 0.01 0 0 cm\n${textLine("Scaled down for good.")}\n${paint("Im1", 300, 200)}`,
    ]));
    expect(marked(text)).toEqual([3, 4]);
  });
});

describe("picture marks: when they are left out", () => {
  const withPicture = pagesWith([textLine("Text."), `${textLine("A photo.")}\n${paint("Im1", 300, 200)}`, paint("Im1", 300, 200)]);
  const PLAIN = "--- Page 1 ---\nText.\n\n--- Page 2 ---\nA photo.\n\n--- Page 3 ---\n[No text on this page. It may be a scan, a photo, or a chart.]";
  afterEach(() => vi.restoreAllMocks());

  it("marks a page that has a picture and no text with both lines", async () => {
    expect(await read(withPicture)).toBe([
      "--- Page 1 ---\nText.",
      "--- Page 2 ---\n[Picture on this page. This text cannot show it.]\nA photo.",
      "--- Page 3 ---\n[Picture on this page. This text cannot show it.]\n[No text on this page. It may be a scan, a photo, or a chart.]",
    ].join("\n\n"));
  });

  it("gives the text of 0.2.0 with pictures turned off", async () => {
    expect(await read(withPicture, { pictures: false })).toBe(PLAIN);
  });

  it("marks nothing in a file that declares more objects than are read for this", async () => {
    const builder = new PdfBuilder();
    builder.page(textLine("Text."));
    builder.page(`${textLine("A photo.")}\n${paint("Im1", 300, 200)}`, { Im1: builder.image() });
    expect(marked(await read(builder.build()))).toEqual([2]);
    expect(await read(builder.build(200_000))).toBe("--- Page 1 ---\nText.\n\n--- Page 2 ---\nA photo.");
  });

  it("marks nothing when finding the pictures takes too long", async () => {
    // A clock that jumps ten seconds every time it is read.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 10_000));
    expect(await read(withPicture)).toBe(PLAIN);
  });

  it("leaves a page unmarked when its content cannot be read, and marks one whose content is too large to be text", async () => {
    const builder = new PdfBuilder();
    const picture = `${textLine("A photo.")}\n${paint("Im1", 300, 200)}`;
    builder.page(picture, { Im1: builder.image() });
    // The same content stored with a predictor, which the library that reads the structure does
    // not undo (the text extractor does): nothing is said about this page.
    const columns = 8;
    const padded = picture.padEnd(Math.ceil(picture.length / columns) * columns, " ");
    const rows = Buffer.concat(Array.from({ length: padded.length / columns }, (_, row) => Buffer.from(`\0${padded.slice(row * columns, (row + 1) * columns)}`, "latin1")));
    builder.page(new Uint8Array(deflateSync(rows)), { Im1: builder.image() }, `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${columns} >>`);
    // More than two megabytes of path operators: a map or a technical drawing.
    builder.page(`${textLine("A very large drawing.")}\n${"10 10 m 20 20 l S\n".repeat(130_000)}`);
    const text = await read(builder.build());
    expect(text).toContain("--- Page 2 ---\nA photo.");
    expect(marked(text)).toEqual([1, 3]);
  });

  it("says nothing when the file does not have the pages the text was read from", async () => {
    const page = { view: [0, 0, 612, 792], transform: [1, 0, 0, -1, 0, 792], tables: [] };
    expect(await findPicturePages(withPicture, [page, page, page])).toEqual([false, true, true]);
    // Two readers that count different pages may not mean the same page by a number.
    expect(await findPicturePages(withPicture, [page, page])).toBeUndefined();
    expect(await findPicturePages(withPicture, [page, page, page, page])).toBeUndefined();
    // It never throws: a file that is not a PDF gives no answer either.
    expect(await findPicturePages(new TextEncoder().encode("not a PDF"), [page])).toBeUndefined();
  });

  it("marks the pictures of a PDF that is encrypted to restrict printing and copying", async () => {
    const plain = await PDFDocument.load(withPicture, { updateMetadata: false });
    plain.encrypt({ ownerPassword: "owner-secret", permissions: { printing: false, copying: false } });
    expect(marked(await read(await plain.save()))).toEqual([2, 3]);
  });
});

describe("picture marks in real files", () => {
  it("marks the chart and the photo, and not the logo, the text or the table with coloured cells (Chrome)", async () => {
    const text = await read(fixture("chrome-pictures.pdf"));
    expect(marked(text)).toEqual([2, 3]);
    expect(text).toContain("--- Page 2 ---\n[Picture on this page. This text cannot show it.]\nSales by region\nFigure 1 shows sales by region for the year.\nNorth South East West\nFigure 1: sales by region.");
    expect(text).toContain("--- Page 4 ---\nStatus by site\n| Site | Opened | Staff | Status |\n| Leeds | 2019 | 42 | on track |");
  });

  it("marks the photo, and not the logo in the page header or the table with shaded cells (Word)", async () => {
    expect(marked(await read(fixture("word-pictures.pdf")))).toEqual([2]);
  });

  it("marks the chart drawn with shapes and the photo, and not the logo of the slide master (PowerPoint)", async () => {
    expect(marked(await read(fixture("powerpoint-pictures.pdf")))).toEqual([1, 2]);
  });

  it("marks none of the files that hold only text and tables", async () => {
    const names = readdirSync(new URL("./fixtures/pdf/", import.meta.url)).filter((name) => name.endsWith(".pdf") && !name.includes("pictures"));
    expect(names).toHaveLength(9);
    for (const name of names) {
      const text = await read(fixture(name));
      expect(marked(text), name).toEqual([]);
      // And nothing else changed: the text is what it is without looking for pictures.
      expect(text, name).toBe(await read(fixture(name), { pictures: false }));
    }
  });
});
