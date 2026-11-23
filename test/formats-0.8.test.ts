import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildOutline, levelOf, looksLikeLog } from "../src/analyze.js";
import { createLargeFiles, detectFormat, MemoryDocumentStore } from "../src/index.js";
import { extractText, officeXmlParagraphs, SPEAKER_NOTES } from "../src/extract.js";
import { decodeHtmlEntities, htmlToText } from "../src/html.js";
import { formatNumber, WordNumbering } from "../src/word-styles.js";
import { columnName, excelDate, formatKind } from "../src/xlsx.js";
import { XmlStream } from "../src/xml-stream.js";
import { utf8 } from "./fake-model.js";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string, properties = "") => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const styled = (style: string, text: string) => p(text, `<w:pStyle w:val="${style}"/>`);
const listed = (numId: number, level: number, text: string) => p(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
const cell = (text: string, properties = "") => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ""}${p(text)}</w:tc>`;

const STYLES = `<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:basedOn w:val="1"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
  <w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/></w:style>
</w:styles>`;

const NUMBERING = `<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="hebrew1"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
  <w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>
  <w:num w:numId="5"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
</w:numbering>`;

const DOCUMENT = `<w:document ${W}><w:body>
  ${styled("Title", "Lease agreement")}
  ${styled("1", "Definitions")}
  ${p("In this lease the following words have these meanings.")}
  ${styled("2", "Scope")}
  ${listed(2, 0, "the flat")}
  ${listed(2, 0, "the parking space")}
  ${styled("1", "Payment")}
  ${styled("2", "Rent")}
  ${listed(3, 0, "monthly")}
  ${listed(5, 0, "restarted list")}
  ${listed(4, 0, "סעיף ראשון")}
  ${listed(4, 0, "סעיף שני")}
  <w:p><w:r><w:t>Call 555</w:t></w:r><w:r><w:noBreakHyphen/></w:r><w:r><w:t>0199 </w:t></w:r><w:r><w:sym w:font="Symbol" w:char="F02B"/></w:r><w:r><w:t> more</w:t></w:r></w:p>
  <w:tbl>
    <w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>
    <w:tr>${cell("Region")}${cell("Q1")}${cell("Q2")}${cell("Q3")}</w:tr>
    <w:tr>${cell("Sales")}${cell("120")}<w:tc><w:p/></w:tc>${cell("140")}</w:tr>
    <w:tr>${cell("Merged", '<w:gridSpan w:val="2"/>')}${cell("x | y")}${cell("z", '<w:vMerge w:val="restart"/>')}</w:tr>
    <w:tr>${cell("Last")}${cell("1")}${cell("2")}${cell("hidden", "<w:vMerge/>")}</w:tr>
  </w:tbl>
  ${p("After the table.")}
</w:body></w:document>`;

async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "uint8array" });
}

async function lease(): Promise<Uint8Array> {
  return zip({
    "word/document.xml": DOCUMENT,
    "word/styles.xml": STYLES,
    "word/numbering.xml": NUMBERING,
    "word/footnotes.xml": `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1">${p("")}</w:footnote><w:footnote w:id="1">${p("See the annex.")}</w:footnote></w:footnotes>`,
    "word/comments.xml": `<w:comments ${W}><w:comment w:id="0" w:author="Legal">${p("Check the rent clause.")}</w:comment></w:comments>`,
    "word/header1.xml": `<w:hdr ${W}>${p("ACME Ltd. — confidential")}</w:hdr>`,
    "word/header2.xml": `<w:hdr ${W}>${p("ACME Ltd. — confidential")}</w:hdr>`,
    "word/footer10.xml": `<w:ftr ${W}>${p("Page footer")}</w:ftr>`,
  });
}

const docxInput = { name: "lease.docx", mimeType: "", format: "docx" as const };

describe("Word files (F4, F5, LLF-024)", () => {
  it("writes headings, list numbers and tables as Word shows them", async () => {
    const { text } = await extractText(await lease(), docxInput);
    const lines = text.split("\n");
    expect(lines.slice(0, 13)).toEqual([
      "# Lease agreement",
      "# 1. Definitions",
      "In this lease the following words have these meanings.",
      "## 1.1 Scope",
      "(a) the flat",
      "(b) the parking space",
      "# 2. Payment",
      "## 2.1 Rent",
      "- monthly",
      "(a) restarted list",
      "א. סעיף ראשון",
      "ב. סעיף שני",
      "Call 555-0199 + more",
    ]);
    expect(lines.slice(13, 17)).toEqual([
      "| Region | Q1 | Q2 | Q3 |",
      "| Sales | 120 |  | 140 |",
      "| Merged |  | x \\| y | z |",
      "| Last | 1 | 2 |  |",
    ]);
    expect(lines[17]).toBe("After the table.");
  });

  it("puts footnotes, comments, headers and footers under headings of their own, each header once", async () => {
    const { text } = await extractText(await lease(), docxInput);
    const tail = text.slice(text.indexOf("After the table.") + "After the table.".length).trim();
    expect(tail).toBe([
      "# Footnotes\nSee the annex.",
      "# Comments\nCheck the rent clause.",
      "# Header\nACME Ltd. — confidential",
      "# Footer\nPage footer",
    ].join("\n\n"));
  });

  it("gives the document an outline, and finds a clause by its number", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "lease.docx", bytes: await lease() });
    expect(meta.outline.map((entry) => `${entry.level} ${entry.title}`)).toEqual(expect.arrayContaining(["1 1. Definitions", "2 1.1 Scope", "1 2. Payment", "2 2.1 Rent", "1 Footnotes"]));
    const found = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "2.1", mode: "exact" });
    expect(found.total_matching_lines).toBe(1);
  });

  it("reads documents without styles or numbering as before, and joins a cell's paragraphs", () => {
    const xml = `<w:document ${W}><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>plain</w:t></w:r></w:p><w:tbl><w:tr><w:tc>${p("two")}${p("lines")}</w:tc><w:tc><w:tbl><w:tr>${cell("inner")}</w:tr></w:tbl></w:tc></w:tr></w:tbl></w:body></w:document>`;
    expect(officeXmlParagraphs(xml, "w")).toEqual(["plain", "| two lines | inner |"]);
  });

  it("formats list numbers in Word's formats", () => {
    expect([1, 2, 26, 27].map((value) => formatNumber(value, "lowerLetter"))).toEqual(["a", "b", "z", "aa"]);
    expect([4, 9, 14, 1999].map((value) => formatNumber(value, "upperRoman"))).toEqual(["IV", "IX", "XIV", "MCMXCIX"]);
    expect([1, 10, 11, 15, 16, 20, 100, 400, 500].map((value) => formatNumber(value, "hebrew1"))).toEqual(["א", "י", "יא", "טו", "טז", "כ", "ק", "ת", "תק"]);
    expect([1, 22, 23].map((value) => formatNumber(value, "hebrew2"))).toEqual(["א", "ת", "א"]);
    expect(formatNumber(3, "decimalZero")).toBe("03");
  });

  it("follows styles based on other styles, and a list's level from the paragraph", () => {
    const numbering = new WordNumbering(STYLES, NUMBERING);
    expect(numbering.headingLevel({ styleId: "2" })).toBe(2);
    expect(numbering.headingLevel({ styleId: "Normal" })).toBeUndefined();
    expect(numbering.headingLevel({ styleId: "Normal", outlineLevel: 2 })).toBe(3);
    expect(numbering.label({ styleId: "1" })).toBe("1.");
    expect(numbering.label({ styleId: "1", numId: "0" })).toBeUndefined();
    expect(numbering.label({ styleId: "2" })).toBe("1.1");
  });
});

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (body: string) => `<p:sld ${P}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
const shape = (text: string) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const drawingCell = (text: string, attributes = "") => `<a:tc${attributes}><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function deck(): Promise<Uint8Array> {
  return zip({
    "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide(shape("Second in the show")),
    "ppt/slides/slide2.xml": slide(`${shape("First in the show")}<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>${drawingCell("Name")}${drawingCell("Total", ' gridSpan="2"')}${drawingCell("", ' hMerge="1"')}</a:tr><a:tr>${drawingCell("East")}${drawingCell("10")}${drawingCell("")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`),
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": `<p:notes ${P}><p:cSld><p:spTree>${shape("Mention the Q3 numbers.")}${shape("2")}</p:spTree></p:cSld></p:notes>`,
  });
}

describe("PowerPoint files (F9, LLF-023)", () => {
  it("numbers slides in the order of the show, with tables and speaker notes", async () => {
    const { text, pages } = await extractText(await deck(), { name: "deck.pptx", mimeType: "", format: "pptx" });
    expect(pages).toBe(2);
    expect(text).toBe([
      "## Slide 1\nFirst in the show\n| Name | Total |  |\n| East | 10 |  |",
      `## Slide 2\nSecond in the show\n${SPEAKER_NOTES}\nMention the Q3 numbers.`,
    ].join("\n\n"));
  });

  it("falls back to the order of the part numbers without a slide list", async () => {
    const bytes = await zip({ "ppt/slides/slide10.xml": slide(shape("ten")), "ppt/slides/slide2.xml": slide(shape("two")) });
    const { text } = await extractText(bytes, { name: "d.pptx", mimeType: "", format: "pptx" });
    expect(text).toBe("## Slide 1\ntwo\n\n## Slide 2\nten");
  });
});

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

async function workbook(sheet1: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
  return zip({
    "xl/workbook.xml": `<workbook ${S}><workbookPr/><sheets><sheet name="Sales 2026" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Chart" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst ${S}><si><t>Region</t></si><si><t>Date</t></si><si><r><t>Rev</t></r><r><rPr><b/></rPr><t>enue</t></r></si><si><t>East</t></si><si><t>ירושלים</t></si><si><t>漢字</t><rPh sb="0" eb="2"><t>カンジ</t></rPh></si></sst>`,
    "xl/styles.xml": `<styleSheet ${S}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="165" formatCode="&quot;₪&quot;#,##0.00"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": sheet1,
    "xl/worksheets/sheet2.xml": `<worksheet ${S}><sheetData/></worksheet>`,
    "xl/chartsheets/sheet1.xml": `<chartsheet ${S}/>`,
    ...extra,
  });
}

const SHEET = `<worksheet ${S}><dimension ref="A1:D6"/><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>Share | %</t></is></c></row>
  <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>46336</v></c><c r="C2" s="4"><v>1200.5</v></c><c r="D2" s="2"><v>0.125</v></c></row>
  <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="3"><v>46336.5</v></c><c r="C3"><f>C2*2</f><v>2401</v></c><c r="D3" t="b"><v>1</v></c></row>
  <row r="4"/>
  <row r="5"><c r="A5" t="s"><v>5</v></c><c r="D5"><f>SUM(C2:C3)</f></c></row>
  <row r="6"><c r="A6" t="e"><v>#DIV/0!</v></c><c r="B6"><v>0.30000000000000004</v></c><c r="C6" t="str"><f>A1&amp;"x"</f><v>Regionx</v></c></row>
</sheetData></worksheet>`;

describe("Excel files (F7)", () => {
  it("writes each sheet with its rows, values as Excel shows them", async () => {
    const { text } = await extractText(await workbook(SHEET), { name: "sales.xlsx", mimeType: "", format: "xlsx" });
    expect(text).toBe([
      [
        "## Sheet 1: Sales 2026",
        "Columns: | A | B | C | D |",
        "Row 1: | Region | Date | Revenue | Share \\| % |",
        "Row 2: | East | 2026-11-10 | 1200.5 | 12.5% |",
        "Row 3: | ירושלים | 2026-11-10 12:00 | 2401 | TRUE |",
        "Row 5: | 漢字 |  |  | =SUM(C2:C3) |",
        "Row 6: | #DIV/0! | 0.3 | Regionx |",
      ].join("\n"),
      "## Sheet 2: Notes (hidden sheet)\n[No values on this sheet]",
    ].join("\n\n"));
  });

  it("is detected by name and type, ingested, and searched by row", async () => {
    expect(detectFormat("q3.XLSX", "")).toBe("xlsx");
    expect(detectFormat("report", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xlsx");
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "sales.xlsx", bytes: await workbook(SHEET) });
    expect(meta.format).toBe("xlsx");
    expect(meta.outline.map((entry) => entry.title)).toEqual(["Sheet 1: Sales 2026", "Sheet 2: Notes (hidden sheet)"]);
    const found = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "ירושלים", mode: "exact" });
    expect((found.matches as Array<{ text: string }>)[0]!.text).toMatch(/^Row 3: /);
  });

  it("reads a sheet without a dimension, sparse rows and columns past Z", async () => {
    const sheet = `<worksheet ${S}><sheetData><row r="2"><c r="B2"><v>1</v></c><c r="AA2"><v>2</v></c></row><row r="9"><c r="C9"><v>3</v></c></row></sheetData></worksheet>`;
    const { text } = await extractText(await workbook(sheet), { name: "s.xlsx", mimeType: "", format: "xlsx" });
    const lines = text.split("\n");
    expect(lines[1]).toBe(`Columns: | ${Array.from({ length: 27 }, (_, index) => columnName(index + 1)).join(" | ")} |`);
    expect(lines[2]).toBe(`Row 2: |  | 1 | ${Array.from({ length: 24 }, () => "").join(" | ")} | 2 |`);
    expect(lines[3]).toBe("Row 9: |  |  | 3 |");
  });

  it("tells dates, times and percentages from their number formats", () => {
    expect(formatKind("yyyy\\-mm\\-dd")).toBe("date");
    expect(formatKind("[$-40D]dd/mm/yyyy")).toBe("date");
    expect(formatKind("h:mm:ss")).toBe("time");
    expect(formatKind("[h]:mm")).toBe("duration");
    expect(formatKind("0.00%")).toBe("percent");
    expect(formatKind('"₪"#,##0.00')).toBe("number");
    expect(formatKind("[Red]#,##0;-#,##0")).toBe("number");
    expect(formatKind("General")).toBe("number");
    expect(excelDate(1, "date")).toBe("1900-01-01");
    expect(excelDate(59, "date")).toBe("1900-02-28");
    expect(excelDate(61, "date")).toBe("1900-03-01");
    expect(excelDate(45000.75, "date")).toBe("2023-03-15 18:00");
    expect(excelDate(0.5, "time")).toBe("12:00");
    expect(excelDate(0, "date", true)).toBe("1904-01-01");
  });

  it("refuses a workbook with no sheet of cells", async () => {
    const bytes = await zip({ "xl/workbook.xml": `<workbook ${S}><sheets/></workbook>` });
    await expect(extractText(bytes, { name: "e.xlsx", mimeType: "", format: "xlsx" })).rejects.toThrow("This XLSX does not contain any sheets with cells.");
  });
});

describe("HTML pages (F13)", () => {
  it("writes the text a browser shows, with headings, lists, tables and links", async () => {
    const page = `<!DOCTYPE html><html><head><title>Q3 report</title><style>p { color: red }</style><script>if (a < b) { x = "</p>"; }</script></head>
<body><!-- a comment --><h1>Results for AT&amp;T&nbsp;Inc.</h1>
<p>Revenue   grew
 by 4&#37; &mdash; see <a href="https://example.com/q3">the full report</a> or <a href="#top">top</a>.</p>
<ul><li>East</li><li>West<ul><li>Coast</li></ul></li></ul>
<ol start="3"><li>third</li><li>fourth</li></ol>
<table><tr><th>Region</th><th>Q1</th><th>Q2</th></tr><tr><td>East</td><td></td><td>1|2</td></tr></table>
<img src="chart.png" alt="Revenue chart"><br>
<pre>line 1
  indented</pre>
<p>Contact <a href="mailto:ops@example.com">ops@example.com</a></p></body></html>`;
    expect(await htmlToText(page)).toBe([
      "# Q3 report",
      "",
      "# Results for AT&T Inc.",
      "Revenue grew by 4% — see the full report (https://example.com/q3) or top.",
      "- East",
      "- West",
      "  - Coast",
      "3. third",
      "4. fourth",
      "| Region | Q1 | Q2 |",
      "| East |  | 1\\|2 |",
      "[Image: Revenue chart]",
      "line 1",
      "  indented",
      "Contact ops@example.com",
    ].join("\n"));
  });

  it("decodes entities, and leaves an ampersand that is not one", () => {
    expect(decodeHtmlEntities("AT&amp;T &lt;b&gt; &#x5D0;&#1489; &copy; &bogus; a=1&b=2 &amp")).toBe("AT&T <b> אב © &bogus; a=1&b=2 &");
    // Names an object has from its prototype are not entities.
    expect(decodeHtmlEntities("&constructor; &toString; &__proto__; &hasOwnProperty;")).toBe("&constructor; &toString; &__proto__; &hasOwnProperty;");
  });

  it("is detected and ingested, and an older encoding is read as text files are", async () => {
    expect(detectFormat("index.htm", "")).toBe("html");
    expect(detectFormat("page", "text/html")).toBe("html");
    const hebrew = new Uint8Array([...utf8("<html><body><p>"), 0xe9, 0xf8, 0xe5, 0xf9, 0xec, 0xe9, 0xed, ...utf8(" &amp; more</p></body></html>")]);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "city.html", bytes: hebrew });
    expect(meta.format).toBe("html");
    expect(meta.encoding).toBe("windows-1255");
    const tools = files.tools([meta]);
    const found = await tools.execute("search_document", { document_id: meta.id, query: "ירושלים & more", mode: "exact" });
    expect(found.total_matching_lines).toBe(1);
  });
});

describe("the XML reader of Office parts", () => {
  it("reads the same tags and text whatever pieces the XML comes in", () => {
    const xml = `<?xml version="1.0"?><!-- c > --><a x="1>2" y='q'>t&amp;1<![CDATA[<raw>]]><b/></a>`;
    const events = (pieces: string[]) => {
      const seen: string[] = [];
      const stream = new XmlStream({
        open: (name, attributes, empty) => seen.push(`<${name} ${JSON.stringify(attributes)}${empty ? "/" : ""}>`),
        close: (name) => seen.push(`</${name}>`),
        text: (text) => seen.push(`"${text}"`),
      });
      for (const piece of pieces) stream.write(piece);
      // Text may come in more pieces: join neighbouring text events.
      return seen.join("").replace(/""/g, "");
    };
    const whole = events([xml]);
    expect(whole).toBe(`<a {"x":"1>2","y":"q"}>"t&1""<raw>"<b {}/></a>`.replace(/""/g, ""));
    for (let cut = 1; cut < xml.length; cut++) expect(events([xml.slice(0, cut), xml.slice(cut)]), `cut at ${cut}`).toBe(whole);
    expect(events([...xml])).toBe(whole);
  });

  it("refuses a tag far longer than any Office file writes", () => {
    const stream = new XmlStream({});
    expect(() => stream.write(`<a b="${"x".repeat(70_000)}">`)).toThrow(/far longer/);
  });
});

describe("format names", () => {
  it("names the new formats in the binary refusal", async () => {
    await expect(extractText(new Uint8Array(200).fill(1), { name: "x.bin", mimeType: "", format: "text" })).rejects.toThrow("Attach a text, log, PDF, Word, PowerPoint, Excel or HTML file.");
  });

  it("detects macro-enabled Office files", () => {
    expect(detectFormat("a.docm", "")).toBe("docx");
    expect(detectFormat("a.pptm", "")).toBe("pptx");
    expect(detectFormat("a.xlsm", "")).toBe("xlsx");
  });
});

describe("logs in other dialects (LLF-017, F12) and outlines of code (LLF-016)", () => {
  it("reads levels in brackets, after level=, in JSON fields, as pino numbers and klog letters", () => {
    expect(levelOf("2026/05/01 12:00:00 [error] 123#0: *1 connect() failed")).toBe("ERROR");
    expect(levelOf('time=2026-05-01T10:00:00Z level=warn msg="slow"')).toBe("WARN");
    expect(levelOf('{"level":"error","msg":"db down"}')).toBe("ERROR");
    expect(levelOf('{"level":50,"time":1762783397000,"msg":"x"}')).toBe("ERROR");
    expect(levelOf("E1110 14:03:17.123456   1 main.go:10] boom")).toBe("ERROR");
    expect(levelOf("[crit] disk")).toBe("FATAL");
    expect(levelOf("there were errors today")).toBeUndefined();
  });

  it("profiles a log of lower-case levels, and knows access and JSON logs as logs", async () => {
    const nginx = Array.from({ length: 20 }, (_, index) => `2026/11/10 14:${String(index).padStart(2, "0")}:00 [${index % 4 === 0 ? "error" : "warn"}] 77#0: upstream timed out (110) while reading`).join("\n");
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "error.txt", bytes: utf8(nginx) });
    expect(meta.format).toBe("log");
    expect(meta.logProfile?.levels).toEqual({ ERROR: 5, WARN: 15 });
    expect(meta.logProfile?.firstTimestamp).toBe("2026/11/10 14:00:00");
    const access = Array.from({ length: 10 }, (_, index) => `10.0.0.${index} - - [10/Nov/2026:14:03:1${index} +0000] "GET /api HTTP/1.1" 200 12`);
    expect(looksLikeLog(access)).toBe(true);
    expect(looksLikeLog(Array.from({ length: 10 }, (_, index) => `{"time":"2026-11-10T14:00:0${index}Z","level":"info","msg":"ok"}`))).toBe(true);
    expect(looksLikeLog(["Dear team,", "", "Thanks for the update.", "See you", "Bye", "Regards"])).toBe(false);
  });

  it("takes no heading from a fenced code block, nor from the comments of a script", () => {
    const readme = ["# Guide", "", "## Install", "", "```bash", "# install the deps", "npm ci", "```", "", "~~~", "# not either", "~~~", "## Use"];
    expect(buildOutline(readme, "markdown").map((entry) => entry.title)).toEqual(["Guide", "Install", "Use"]);
    const script = ["#!/bin/bash", "set -e", "", "# build the image", "docker build .", "", "# push it", "docker push x"];
    expect(buildOutline(script, "text")).toEqual([]);
    const notes = ["Meeting notes", "", "# Decisions", "We ship on Friday.", "", "# Actions", "Dana writes the release notes."];
    expect(buildOutline(notes, "text").map((entry) => entry.title)).toEqual(["Decisions", "Actions"]);
  });
});

describe("hostile spreadsheets and pages", () => {
  it("keeps no cell past Excel's last column, and refuses a cell over the text limit", async () => {
    const wide = `<worksheet ${S}><sheetData><row r="1">${"<c><v>1</v></c>".repeat(20_000)}</row></sheetData></worksheet>`;
    const { text } = await extractText(await workbook(wide), { name: "w.xlsx", mimeType: "", format: "xlsx" });
    const row = text.split("\n").find((line) => line.startsWith("Row 1:"))!;
    // "Row 1:" and 16,384 cells.
    expect(row.split(" | ").length).toBe(1 + 16_384);
    const huge = `<worksheet ${S}><sheetData><row r="1"><c t="inlineStr"><is><t>${"x".repeat(3_000)}</t></is></c></row></sheetData></worksheet>`;
    await expect(extractText(await workbook(huge), { name: "h.xlsx", mimeType: "", format: "xlsx", maxTextBytes: 1_000 })).rejects.toThrow(/more text than is kept/);
  });

  it("indents lists nested thousands deep by a few levels only", async () => {
    const started = performance.now();
    const text = await htmlToText("<ul><li>x".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThan(20);
  });
});
