// Regression tests for the verified findings of 0.8.0 in the Office readers: Word's list numbers,
// the pauses of the unpacking stream, PowerPoint's notes pages and Word's table rows.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractText, SPEAKER_NOTES } from "../src/extract.js";
import { officeReader, type ZipArchive } from "../src/office.js";
import { WordNumbering } from "../src/word-styles.js";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string, properties = "") => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const listed = (numId: number, level: number, text: string) => p(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
const cell = (text: string, properties = "") => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ""}${p(text)}</w:tc>`;
const lvl = (index: number, format: string, text: string, extra = "") => `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${extra}<w:lvlText w:val="${text}"/></w:lvl>`;

const timed = async <T>(work: () => T | Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
};

async function zip(files: Record<string, string>, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "uint8array", compression, compressionOptions: { level: 9 } });
}

async function word(body: string, styles?: string, numbering?: string, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Uint8Array> {
  return zip({
    "word/document.xml": `<w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...(styles ? { "word/styles.xml": `<w:styles ${W}>${styles}</w:styles>` } : {}),
    ...(numbering ? { "word/numbering.xml": `<w:numbering ${W}>${numbering}</w:numbering>` } : {}),
  }, compression);
}

const docxText = async (bytes: Uint8Array) => (await extractText(bytes, { name: "a.docx", mimeType: "", format: "docx" })).text;

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

  it("writes every number of a legal level (isLgl) in Arabic digits", async () => {
    const numbering = `<w:abstractNum w:abstractNumId="0">${lvl(0, "upperRoman", "Article %1.")}${lvl(1, "decimalZero", "Section %1.%2", "<w:isLgl/>")}${lvl(2, "lowerLetter", "(%3)")}${lvl(3, "lowerRoman", "%1.%3.%4", '<w:isLgl w:val="1"/>')}${lvl(4, "lowerRoman", "%1-%5", '<w:isLgl w:val="0"/>')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    const body = [listed(1, 0, "Definitions"), listed(1, 0, "Payment"), listed(1, 1, "Rent"), listed(1, 1, "Deposit"), listed(1, 2, "cash"), listed(1, 3, "deep"), listed(1, 4, "not legal")].join("");
    expect((await docxText(await word(body, undefined, numbering))).split("\n")).toEqual([
      "Article I. Definitions",
      "Article II. Payment",
      "Section 2.01 Rent",
      "Section 2.02 Deposit",
      "(a) cash",
      "2.1.1 deep",
      "II-i not legal",
    ]);
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

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const shape = (text: string, placeholder = "") => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${text.split("\n").map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;

async function deckWithNotes(notes: string): Promise<string> {
  const bytes = await zip({
    "ppt/slides/slide1.xml": `<p:sld ${P}><p:cSld><p:spTree>${shape("Welcome")}</p:spTree></p:cSld></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": `<p:notes ${P}><p:cSld><p:spTree>${notes}</p:spTree></p:cSld></p:notes>`,
  });
  return (await extractText(bytes, { name: "d.pptx", mimeType: "", format: "pptx" })).text;
}

describe("PowerPoint notes pages (finding 20)", () => {
  it("keeps the notes and the presenter's own text boxes, not the slide number, date, header or footer", async () => {
    const page = [
      shape("", '<p:ph type="sldImg"/>'),
      shape("Say hello\n42\nThen discuss 2025", '<p:ph type="body" idx="1"/>'),
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>`,
      shape("Company Confidential", '<p:ph type="ftr" idx="4"/>'),
      shape("11/23/2026", '<p:ph type="dt" idx="1"/>'),
      shape("Quarterly review", "<p:ph type='hdr' sz=\"quarter\"/>"),
      shape("7"),
    ].join("");
    expect(await deckWithNotes(page)).toBe(`## Slide 1\nWelcome\n${SPEAKER_NOTES}\nSay hello\n42\nThen discuss 2025\n7`);
  });

  it("writes no notes for a notes page that holds only its slide number and footer", async () => {
    const page = shape("3", '<p:ph type="sldNum" idx="5"/>') + shape("Company Confidential", '<p:ph type="ftr"/>');
    expect(await deckWithNotes(page)).toBe("## Slide 1\nWelcome");
  });
});

describe("Word table rows (findings 21, 22)", () => {
  it("keeps the text of a cell that continues a merged cell, and leaves an empty one empty", async () => {
    const table = `<w:tbl><w:tr>${cell("TopMerged", '<w:vMerge w:val="restart"/>')}${cell("R1")}</w:tr><w:tr>${cell("ContinuedText", "<w:vMerge/>")}${cell("R2")}</w:tr><w:tr><w:tc><w:tcPr><w:vMerge w:val="continue"/></w:tcPr><w:p/></w:tc>${cell("R3")}</w:tr></w:tbl>`;
    expect(await docxText(await word(table))).toBe("| TopMerged | R1 |\n| ContinuedText | R2 |\n|  | R3 |");
  });

  it("keeps the columns of a row that starts or ends past grid columns (gridBefore, gridAfter)", async () => {
    const table = `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>
      <w:tr>${cell("A")}${cell("B")}${cell("C")}</w:tr>
      <w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${cell("OnlyRight", '<w:gridSpan w:val="2"/>')}</w:tr>
      <w:tr><w:trPr><w:gridAfter w:val="2"/></w:trPr>${cell("OnlyLeft")}</w:tr>
      <w:tr><w:trPr><w:gridBefore w:val="2"/><w:trPrChange w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"><w:trPr><w:gridBefore w:val="1"/></w:trPr></w:trPrChange></w:trPr>${cell("Changed")}</w:tr>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:tcPrChange w:id="2" w:author="a" w:date="2026-01-01T00:00:00Z"><w:tcPr><w:gridSpan w:val="3"/></w:tcPr></w:tcPrChange></w:tcPr>${p("Wide")}</w:tc>${cell("Z")}</w:tr>
      <w:tr><w:trPr><w:gridBefore w:val="100000"/></w:trPr>${cell("Far")}</w:tr>
    </w:tbl>`;
    const lines = (await docxText(await word(table))).split("\n");
    // The properties a change records are those before it: the row and the cell keep their own.
    expect(lines.slice(0, 5)).toEqual(["| A | B | C |", "|  | OnlyRight |  |", "| OnlyLeft |  |  |", "|  |  | Changed |", "| Wide |  | Z |"]);
    // A count past the 63 columns Word allows is cut to them.
    expect(lines[5]).toBe(`| ${Array.from({ length: 63 }, () => "").join(" | ")} | Far |`);
  });
});
