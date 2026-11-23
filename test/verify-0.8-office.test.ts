// Regression tests for the verified findings of 0.8.0 in the Office readers: Word's list numbers,
// the pauses of the unpacking stream, PowerPoint's notes pages and Word's table rows. Those that
// hold the work to the clock are in test/timing/office.timing.test.ts.
import { describe, expect, it } from "vitest";
import { extractText, SPEAKER_NOTES } from "../src/extract.js";
import { docxText, listed, lvl, p, word, zip } from "./word-fixtures.js";

const cell = (text: string, properties = "") => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ""}${p(text)}</w:tc>`;

describe("Word list numbers (findings 3, 18, 19)", () => {
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
