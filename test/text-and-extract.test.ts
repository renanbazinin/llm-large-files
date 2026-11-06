import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildLogProfile, buildOutline, logTemplate, looksLikeLog } from "../src/analyze.js";
import { decodeText, detectFormat, extractText, officeXmlParagraphs } from "../src/extract.js";
import { estimateTokens, LineIndex, normalizeText, utf8Bytes, wrapLongLines } from "../src/text.js";

function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe("text utilities", () => {
  it("indexes lines, ignoring a trailing newline", () => {
    const index = new LineIndex("alpha\nbeta\ngamma\n");
    expect(index.lineCount).toBe(3);
    expect(index.line(3)).toBe("gamma");
    expect(index.lineAt(6)).toBe(2);
    expect(index.numbered(2, 9)).toBe("2| beta\n3| gamma");
  });

  it("normalizes line endings, BOMs, and control characters", () => {
    expect(normalizeText("﻿a\r\nb\rc\x00d")).toBe("a\nb\ncd");
  });

  it("wraps very long lines at a soft break", () => {
    const { text, wrapped } = wrapLongLines(`${"word ".repeat(1_000)}`, 100);
    expect(wrapped).toBe(1);
    expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(100);
    expect(text.replace(/\n/g, "")).toBe("word ".repeat(1_000));
  });

  it("estimates more tokens per character for non-Latin scripts", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("ש".repeat(300))).toBe(200);
    expect(utf8Bytes("aש😀")).toBe(1 + 2 + 4);
  });
});

describe("extraction", () => {
  it("detects formats by extension, then MIME type", () => {
    expect(detectFormat("server.LOG", "")).toBe("log");
    expect(detectFormat("notes", "text/markdown")).toBe("markdown");
    expect(detectFormat("data.jsonl", "")).toBe("json");
    expect(detectFormat("readme.txt", "text/plain")).toBe("text");
  });

  it("decodes UTF-16 logs with and without a BOM, and rejects binary data", () => {
    const utf16 = (value: string) => new Uint8Array(Buffer.from(value, "utf16le"));
    expect(decodeText(new Uint8Array([0xff, 0xfe, ...utf16("hello log")]))).toBe("hello log");
    expect(decodeText(utf16("2026-01-01 INFO started service\n".repeat(10)))).toContain("INFO started");
    expect(() => decodeText(new Uint8Array(Array.from({ length: 2_000 }, (_, index) => (index % 7 === 0 ? 0 : 200))))).toThrow(/binary/);
  });

  it("reads Office XML paragraphs, tabs, breaks, and entities", () => {
    const xml = "<w:body><w:p><w:pPr/><w:r><w:t>Fish &amp; chips</w:t><w:tab/><w:t xml:space=\"preserve\"> now</w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two &#x05E9;</w:t></w:r></w:p></w:body>";
    expect(officeXmlParagraphs(xml, "w")).toEqual(["Fish & chips\t now", "Line\ntwo ש"]);
  });

  it("extracts DOCX and PPTX text through jszip", async () => {
    const docx = new JSZip();
    docx.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Chapter 1</w:t></w:r></w:p></w:body></w:document>");
    const docxBytes = await docx.generateAsync({ type: "uint8array" });
    expect((await extractText(docxBytes, { name: "a.docx", mimeType: "", format: "docx" })).text).toBe("Chapter 1");

    const pptx = new JSZip();
    pptx.file("ppt/slides/slide2.xml", "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>");
    pptx.file("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>");
    const result = await extractText(await pptx.generateAsync({ type: "uint8array" }), { name: "a.pptx", mimeType: "", format: "pptx" });
    expect(result.text).toBe("## Slide 1\nFirst\n\n## Slide 2\nSecond");
    expect(result.pages).toBe(2);
  });

  it("extracts PDF text with page markers through unpdf", async () => {
    const result = await extractText(minimalPdf("Hello PDF world"), { name: "a.pdf", mimeType: "application/pdf", format: "pdf" });
    expect(result.pages).toBe(1);
    expect(result.text).toContain("--- Page 1 ---");
    expect(result.text).toContain("Hello PDF world");
  });
});

describe("analysis", () => {
  const log = [
    "2026-03-01 10:00:00 INFO service started",
    "2026-03-01 10:00:01 ERROR Connection timeout after 3000ms to 10.0.0.5:5432",
    "2026-03-01 10:00:02 WARN retrying request id=4f1c2a9e-1111-2222-3333-444455556666",
    "2026-03-01 10:00:03 ERROR Connection timeout after 2950ms to 10.0.0.7:5432",
    "2026-03-01 10:00:04 INFO request done",
    "2026-03-01 10:00:05 FATAL out of memory",
  ];

  it("recognizes logs and groups repeated errors into one template", () => {
    expect(looksLikeLog(log)).toBe(true);
    expect(looksLikeLog(["Once upon a time", "there was a log", "of wood", "in a forest", "the end"])).toBe(false);
    expect(logTemplate(log[1]!)).toBe("ERROR Connection timeout after <n>ms to <ip>");
    const profile = buildLogProfile(log);
    expect(profile.levels).toEqual({ INFO: 2, ERROR: 2, WARN: 1, FATAL: 1 });
    expect(profile.firstTimestamp).toBe("2026-03-01 10:00:00");
    expect(profile.lastTimestamp).toBe("2026-03-01 10:00:05");
    expect(profile.topIssues[0]).toMatchObject({ level: "FATAL", count: 1, firstLine: 6 });
    expect(profile.topIssues[1]).toMatchObject({ level: "ERROR", count: 2, firstLine: 2 });
  });

  it("builds an outline from Markdown headings and chapter titles", () => {
    const outline = buildOutline(["# Title", "", "Chapter 1: The Start", "text", "", "## Details", "", "פרק 2", "", "1.2 Scope of work"], "markdown");
    expect(outline.map((entry) => [entry.line, entry.level, entry.title])).toEqual([
      [1, 1, "Title"],
      [3, 2, "Chapter 1: The Start"],
      [6, 2, "Details"],
      [8, 2, "פרק 2"],
      [10, 3, "1.2 Scope of work"],
    ]);
  });
});
