// Regression tests for the independent review of 0.8.0: each finding, with an input that showed it.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildOutline } from "../src/analyze.js";
import { extractText } from "../src/extract.js";
import { htmlToText } from "../src/html.js";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { grep, rankPassages, SearchableDocument, unsafeRegexReason } from "../src/search.js";
import { composed } from "../src/text.js";
import { toolCallKey } from "../src/tools.js";
import { formatNumber } from "../src/word-styles.js";
import { excelDate, formatKind } from "../src/xlsx.js";
import { parseAttributes } from "../src/xml-stream.js";
import { utf8 } from "./fake-model.js";

const timed = async <T>(work: () => T | Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
};

describe("small hostile uploads that held the server", () => {
  it("composes a long run of marks of two classes in linear time (stream-safe form)", async () => {
    const zalgo = `a${"̖́".repeat(160_000)}`;
    const { value, ms } = await timed(() => composed(zalgo));
    expect(ms).toBeLessThan(2_000);
    // A combining grapheme joiner after every 30 marks; each run of 30 is composed as NFC composes it.
    expect(value.split("\u034f").length).toBe(Math.ceil(320_000 / 30));
    const sixty = `a${"\u0301\u0316".repeat(30)}`;
    expect(composed(sixty)).toBe(`${sixty.slice(0, 31).normalize("NFC")}\u034f${sixty.slice(31).normalize("NFC")}`);
    expect(composed(`a${"\u0301\u0316".repeat(15)}`)).toBe(`a${"\u0301\u0316".repeat(15)}`.normalize("NFC"));
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const ingest = await timed(() => files.ingest({ name: "zalgo.txt", bytes: utf8(zalgo) }));
    expect(ingest.ms).toBeLessThan(10_000);
    // Real text is untouched: Hebrew with points and cantillation has a few marks a letter.
    expect(composed("בְּרֵאשִׁ֖ית")).toBe("בְּרֵאשִׁ֖ית".normalize("NFC"));
  });

  it("reads the attributes of a long tag with no \"=\" in linear time, and those of HTML", async () => {
    expect((await timed(() => parseAttributes(` ${"x".repeat(64_000)}`))).ms).toBeLessThan(200);
    const page = `<html><body>${Array.from({ length: 3 }, () => `<a ${"x".repeat(60_000)}>link</a>`).join("")}<p>after</p></body></html>`;
    const { value, ms } = await timed(() => htmlToText(page));
    expect(ms).toBeLessThan(2_000);
    expect(value).toContain("after");
    expect(parseAttributes(` href=https://x.test/a?b=1 disabled title='it"s' data-x = "1&amp;2" /`)).toEqual({ href: "https://x.test/a?b=1", disabled: "", title: "it\"s", "data-x": "1&2" });
  });

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

  it("decides whether a text is code without backtracking over leading spaces", async () => {
    const lines = Array.from({ length: 300 }, () => `${" ".repeat(40_000)}x`);
    expect((await timed(() => buildOutline(lines, "text"))).ms).toBeLessThan(1_000);
  });
});

describe("search", () => {
  it("counts every match of a regex search with groups or the last matches, whatever the time slices cut", () => {
    const text = Array.from({ length: 400_000 }, (_, index) => (index % 3 === 0 ? `ERROR code=${index % 11} took ${index}ms` : `INFO ok ${index}`)).join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_big", name: "big.log" } as never, text });
    const grouped = grep(document, "ERROR code=(\\d+)", { regex: true, maxResults: 20, contextLines: 0, groupBy: "shape" });
    const counted = grouped.groups!.groups.reduce((sum, group) => sum + group.count, 0) + grouped.groups!.otherCount + grouped.groups!.ungrouped;
    expect(counted).toBe(grouped.totalMatchingLines);
    const last = grep(document, "ERROR", { regex: true, maxResults: 3, contextLines: 0, order: "last" });
    expect(last.matches.map((match) => match.line)).toEqual([399_994, 399_997, 400_000]);
  });

  it("says that the last matches of a search that stopped early are the last it found", async () => {
    const text = Array.from({ length: 300_000 }, (_, index) => `line ${index} ${"ab".repeat(30)}`).join("\n");
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "slow.txt", bytes: utf8(text) });
    const result = await files.tools([meta], { regexBudgetMs: 5 }).execute("search_document", { document_id: meta.id, query: "(ab)*line \\d+", mode: "regex", order: "last" });
    expect(result.note).toMatch(/^These are the last \d+ matching lines found before the search stopped early .* The file may have later ones, after line \d+: search again with from_line \d+\.$/);
  });

  it("checks a repeated group with \\w as it is compiled, for letters of every script", () => {
    expect(unsafeRegexReason("(\\w+é)+$")).toMatch(/nested quantifier/);
    expect(unsafeRegexReason("(\\w+\\.)+com")).toBeNull();
  });

  it("does not compare a call whose group_by the search refuses", () => {
    expect(toolCallKey("search_document", { document_id: "doc_1", query: "x", mode: "exact", group_by: "week" })).toBeUndefined();
  });

  it("counts only the hits in the lines ranked, toward the cap too", () => {
    const lines = Array.from({ length: 205_000 }, (_, index) => `error ${index}`);
    for (let index = 204_000; index < 204_100; index++) lines[index] = `error payment failed ${index}`;
    const document = new SearchableDocument({ meta: { id: "doc_r", name: "r.log" } as never, text: lines.join("\n") });
    const ranked = rankPassages(document, "error", 3, { from: 204_000, to: 204_100 });
    expect(ranked.length).toBeGreaterThan(0);
    for (const passage of ranked) expect(passage.to >= 204_000 && passage.from <= 204_100).toBe(true);
  });
});

describe("Excel times", () => {
  it("rounds to the second before carrying into the next day", () => {
    expect(excelDate(45000.999995, "date")).toBe("2023-03-16");
    expect(excelDate(0.999995, "time")).toBe("00:00");
    expect(excelDate(0.75, "time")).toBe("18:00");
  });
});
