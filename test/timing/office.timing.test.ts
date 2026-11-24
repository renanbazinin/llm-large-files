// The tests of the Word, PowerPoint and Excel readers that hold work to the clock: list numbers,
// hidden text, Office XML of odd shapes and hostile number formats read in bounded time, and the
// pieces the unpacking stream hands out between two turns of the event loop (from
// test/verify-0.8-office.test.ts, test/hygiene.test.ts, test/text-and-extract.test.ts and
// test/review-0.8.test.ts).
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractText, HIDDEN_TEXT, officeXmlParagraphs } from "../../src/extract.js";
import { officeReader, type ZipArchive } from "../../src/office.js";
import { formatNumber, WordNumbering } from "../../src/word-styles.js";
import { formatKind } from "../../src/xlsx.js";
import { docxText, listed, lvl, p, W, word } from "../word-fixtures.js";
import { timed } from "./clock.js";

/** The length of a piece of hidden text: a tenth under the wrap limit, less its mark (office.ts, html.ts). */
const HIDDEN_PIECE = Math.floor((2_000 - "[Hidden text, not shown in the document]".length - 1) * 0.9);

/** 20 paragraph styles, each based on the next; the last puts its paragraphs in list 1, at its ninth level. */
const CHAINED_STYLES = Array.from({ length: 20 }, (_, index) => `<w:style w:type="paragraph" w:styleId="s${index}"><w:name w:val="x${index}"/>${index < 19 ? `<w:basedOn w:val="s${index + 1}"/>` : `<w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="8"/></w:numPr></w:pPr>`}</w:style>`).join("");
/**
 * Nine levels whose number text is 32 numbers, the first its own and the others Roman numerals of
 * 15 letters each: 480 characters, before every paragraph.
 */
const ROMAN_NUMBERING = `<w:abstractNum w:abstractNumId="0">${Array.from({ length: 9 }, (_, index) => `<w:lvl w:ilvl="${index}"><w:start w:val="3888"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="${`%9${"%1%2%3%4%5%6%7%8".repeat(4)}`.slice(0, 64)}"/></w:lvl>`).join("")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;

describe("Word list numbers (findings 3, 18, 19)", () => {
  it("counts empty list paragraphs without writing their numbers, at the cost of plain ones", async () => {
    const empty = '<w:p><w:pPr><w:pStyle w:val="s0"/></w:pPr></w:p>';
    const body = `${empty.repeat(60_000)}${p("last", '<w:pStyle w:val="s0"/>')}`;
    const [withoutLists, withLists] = [await word(body, CHAINED_STYLES), await word(body, CHAINED_STYLES, ROMAN_NUMBERING)];
    const plain = await timed(() => docxText(withoutLists));
    const numbered = await timed(() => docxText(withLists));
    // The numbers cost about what reading the styles does: 60,000 of them, written and thrown away, took 3.5 s.
    expect(numbered.ms).toBeLessThan(Math.max(3 * plain.ms, 1_500));
    expect(plain.value).toBe("last");
    // Every empty paragraph was counted: the last one is number 3,888 + 60,000, past Roman numerals.
    expect(numbered.value.startsWith("63888MMMDCCCLXXXVIII")).toBe(true);
    expect(numbered.value.endsWith(" last")).toBe(true);
    // A number is cut where Word's own dialog would never reach.
    expect(numbered.value.length).toBeLessThanOrEqual(64 + " last".length);
  }, 15_000);

  it("writes a long list number in bounded time, at most 64 characters of it", async () => {
    const numbering = new WordNumbering(`<w:styles ${W}>${CHAINED_STYLES}</w:styles>`, `<w:numbering ${W}>${ROMAN_NUMBERING}</w:numbering>`);
    const { value, ms } = await timed(() => {
      let longest = 0;
      for (let index = 0; index < 50_000; index++) longest = Math.max(longest, numbering.label({ styleId: "s0" })?.length ?? 0);
      return longest;
    });
    expect(value).toBeLessThanOrEqual(64);
    expect(value).toBeGreaterThan(60);
    // 50,000 numbers of 480 characters took 2.5 s; of 64, about 0.15 s.
    expect(ms).toBeLessThan(3_000);
  }, 15_000);

  it("numbers the lists of a list style (numStyleLink), through the abstract list or the style", async () => {
    const levels = `${lvl(0, "decimal", "%1.")}${lvl(1, "decimal", "%1.%2")}`;
    const styles = `<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
      <w:style w:type="numbering" w:styleId="LegalList"><w:name w:val="Legal List"/><w:pPr><w:numPr><w:numId w:val="4"/></w:numPr></w:pPr></w:style>
      <w:style w:type="numbering" w:styleId="ByStyle"><w:name w:val="By Style"/><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style>
      <w:style w:type="numbering" w:styleId="Loop"><w:name w:val="Loop"/><w:pPr><w:numPr><w:numId w:val="9"/></w:numPr></w:pPr></w:style>`;
    const numbering = `<w:abstractNum w:abstractNumId="2"><w:styleLink w:val="LegalList"/>${levels}</w:abstractNum>
      <w:abstractNum w:abstractNumId="3"><w:numStyleLink w:val="LegalList"/></w:abstractNum>
      <w:abstractNum w:abstractNumId="6">${lvl(0, "lowerLetter", "(%1)")}</w:abstractNum>
      <w:abstractNum w:abstractNumId="8"><w:numStyleLink w:val="ByStyle"/></w:abstractNum>
      <w:abstractNum w:abstractNumId="10"><w:numStyleLink w:val="Loop"/></w:abstractNum>
      <w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>
      <w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>
      <w:num w:numId="7"><w:abstractNumId w:val="6"/></w:num>
      <w:num w:numId="8"><w:abstractNumId w:val="8"/></w:num>
      <w:num w:numId="9"><w:abstractNumId w:val="10"/></w:num>`;
    const body = [listed(5, 0, "LegalOne"), listed(5, 1, "LegalOneOne"), listed(5, 0, "LegalTwo"), listed(8, 0, "ByStyleOne"), listed(8, 0, "ByStyleTwo"), listed(9, 0, "Loop")].join("");
    const { value, ms } = await timed(async () => docxText(await word(body, styles, numbering)));
    expect(value.split("\n")).toEqual(["1. LegalOne", "1.1 LegalOneOne", "2. LegalTwo", "(a) ByStyleOne", "(b) ByStyleTwo", "Loop"]);
    expect(ms).toBeLessThan(2_000);
  });
});

describe("the pauses of the unpacking stream (finding 4)", () => {
  it("writes nothing more once it has paused, however much one block unpacks to", async () => {
    // One deflated block of this XML unpacks to megabytes, all handed out in one turn.
    const bytes = await word('<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(200_000), undefined, undefined, "DEFLATE");
    const archive = (await JSZip.loadAsync(bytes)) as unknown as ZipArchive;
    let turns = 0;
    let done = false;
    const ticker = (async () => {
      while (!done) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        turns++;
      }
    })();
    let turn = -1;
    let inTurn = 0;
    let most = 0;
    let total = 0;
    await officeReader(archive, "DOCX", bytes.byteLength, undefined).stream("word/document.xml", (piece) => {
      // Slow work on each piece, as costly paragraphs make it: the time slice ends after a few.
      const until = performance.now() + 1;
      while (performance.now() < until);
      if (turns !== turn) {
        turn = turns;
        inTurn = 0;
      }
      inTurn += piece.length;
      total += piece.length;
      most = Math.max(most, inTurn);
    });
    done = true;
    await ticker;
    expect(total).toBeGreaterThan(6_000_000);
    // A turn ends when the slice of 12 ms is over: about a dozen pieces of 16,384 characters. One
    // turn wrote 5.6 million characters.
    expect(most).toBeLessThan(1_500_000);
  }, 15_000);
});

describe("hidden content of Word and PowerPoint files (S14)", () => {
  const run = (text: string, properties = "") => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

  it("marks a hidden line of 16 million characters in well under a second", () => {
    // Each piece searched again for the end of its line: 10 to 25 seconds, holding the server.
    const xml = `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${"a".repeat(16_000_000)}</w:t></w:r></w:p>`;
    const started = performance.now();
    const [text] = officeXmlParagraphs(xml, "w");
    expect(performance.now() - started).toBeLessThan(1_000);
    const lines = text!.split("\n");
    expect(lines).toHaveLength(Math.ceil(16_000_000 / HIDDEN_PIECE));
    expect(lines.every((line) => line.startsWith(`${HIDDEN_TEXT} a`))).toBe(true);
  });

  it("refuses a hidden line far past the limit as soon as its marks pass it", async () => {
    // Marked piece by piece up to the limit, each piece searching to the end of the line: 7 seconds.
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document ${W}><w:body><w:p>${run("x".repeat(23_900_000), "<w:vanish/>")}</w:p></w:body></w:document>`);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const started = performance.now();
    await expect(extractText(bytes, { name: "a.docx", mimeType: "", format: "docx", maxTextBytes: 4_000_000 })).rejects.toThrow(/^This DOCX holds more than 3\.8 MB of text/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("extraction", () => {
  it("reads Office XML in time that follows its length, whatever its shape", () => {
    // Paragraphs or text runs that are never closed made each of them a scan to the end of the file.
    const shapes = ["<w:p>".repeat(200_000), `<w:p><w:r>${"<w:t>".repeat(200_000)}</w:r></w:p>`, `<w:p a="${"<w:p>".repeat(100_000)}`];
    for (const xml of shapes) {
      const started = performance.now();
      try {
        officeXmlParagraphs(xml, "w");
      } catch (error) {
        // Paragraphs opened inside each other without end are refused as soon as they pass 32.
        expect(String(error)).toMatch(/nests paragraphs more than 32 deep/);
      }
      expect(performance.now() - started).toBeLessThan(1_000);
    }
    expect(() => officeXmlParagraphs("<w:p>".repeat(200_000), "w")).toThrow(/nests paragraphs more than 32 deep/);
    // A ">" inside a quoted value does not end the tag.
    expect(officeXmlParagraphs("<w:p><w:r w:x=\"a>b\"><w:t>Text</w:t></w:r></w:p>", "w")).toEqual(["Text"]);
  });
});

describe("small hostile uploads that held the server", () => {
  it("writes a list number past what Roman numerals and letters can hold as a number, and clamps starts", async () => {
    expect(formatNumber(1_000_000_000, "lowerRoman")).toBe("1000000000");
    expect(formatNumber(1_000_000, "upperLetter")).toBe("1000000");
    expect(formatNumber(0, "lowerLetter")).toBe("0");
    expect(formatNumber(-3, "hebrew1")).toBe("-3");
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const zip = new JSZip();
    zip.file("word/numbering.xml", `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1000000000000"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="-5"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`);
    const item = (numId: number, text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    zip.file("word/document.xml", `<w:document ${W}><w:body>${item(1, "huge")}${item(2, "negative")}${item(2, "next")}</w:body></w:document>`);
    const { value, ms } = await timed(async () => (await extractText(await zip.generateAsync({ type: "uint8array" }), { name: "a.docx", mimeType: "", format: "docx" })).text);
    expect(ms).toBeLessThan(2_000);
    expect(value).toBe("32767. huge\n0) negative\na) next");
  });

  it("reads a number format with an unclosed bracket in linear time", async () => {
    expect((await timed(() => formatKind(`${"[".repeat(32_000)}yyyy`))).ms).toBeLessThan(100);
    expect(formatKind("[Red][<=100]0.00;[Blue]0.00")).toBe("number");
    expect(formatKind("[$-409]mmmm d, yyyy")).toBe("date");
  });

  it("orders a deck whose slide list repeats one slide many times in linear time", async () => {
    const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const zip = new JSZip();
    zip.file("ppt/presentation.xml", `<p:presentation ${P}><p:sldIdLst>${'<p:sldId id="256" r:id="rId1"/>'.repeat(150_000)}<p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`);
    for (const number of [1, 2]) zip.file(`ppt/slides/slide${number}.xml`, `<p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>slide ${number}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
    const { value, ms } = await timed(async () => (await extractText(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), { name: "d.pptx", mimeType: "", format: "pptx" })).text);
    expect(ms).toBeLessThan(5_000);
    expect(value).toBe("## Slide 1\nslide 1\n\n## Slide 2\nslide 2");
  });
});
