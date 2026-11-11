import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildLogProfile, buildOutline, logTemplate, looksLikeLog } from "../src/analyze.js";
import { decodeText, detectFormat, extractText, officeXmlParagraphs } from "../src/extract.js";
import { estimateTokens, foldCase, LineIndex, normalizeText, utf8Bytes, wrapLongLines } from "../src/text.js";

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

  it("counts UTF-8 bytes", () => {
    expect(utf8Bytes("aש😀")).toBe(1 + 2 + 4);
  });

  it("estimates tokens close to Gemini's own count for prose, logs, data, and code", () => {
    const { samples } = JSON.parse(readFileSync(new URL("./fixtures/token-samples.json", import.meta.url), "utf8")) as {
      samples: Array<{ name: string; geminiTokens: number; text: string }>;
    };
    expect(samples.length).toBeGreaterThan(8);
    for (const sample of samples) {
      const ratio = estimateTokens(sample.text) / sample.geminiTokens;
      // 0.1.0 estimated 4 characters per token and scored 0.26 to 0.45 on the logs and the CSV here.
      expect(ratio, `${sample.name}: estimate / Gemini`).toBeGreaterThan(0.85);
      expect(ratio, `${sample.name}: estimate / Gemini`).toBeLessThan(1.5);
    }
  });

  it("prices digits, identifiers, and long letter runs higher than plain words", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("the quick brown fox jumps over the lazy dog")).toBeLessThanOrEqual(12);
    expect(estimateTokens("1234567890")).toBeGreaterThanOrEqual(10);
    expect(estimateTokens("3fa9c1d2-7b1e-4c55-9a0f-5d2e8c7b6a10")).toBeGreaterThanOrEqual(30);
    expect(estimateTokens("getDocumentProxyForPage")).toBeGreaterThan(estimateTokens("getdocument"));
    expect(estimateTokens("x".repeat(400))).toBeGreaterThan(150);
    // Adding up lines gives about the same total as estimating the whole text (map-reduce relies on it).
    const lines = Array.from({ length: 200 }, (_, index) => `2026-05-01 12:00:${String(index % 60).padStart(2, "0")} INFO request ${index} ok`);
    const whole = estimateTokens(lines.join("\n"));
    const summed = lines.reduce((sum, line) => sum + estimateTokens(`${line}\n`), 0);
    expect(Math.abs(summed - whole) / whole).toBeLessThan(0.05);
  });

  it("removes terminal colour codes whole, not just the escape byte", () => {
    expect(normalizeText("\x1b[31mERROR\x1b[0m db down \x1b[1;32mOK\x1b[m")).toBe("ERROR db down OK");
    expect(normalizeText("\x1b]0;window title\x07prompt$ \x1b(Bls")).toBe("prompt$ ls");
    expect(normalizeText("a [not a code] b")).toBe("a [not a code] b");
    expect(buildLogProfile(normalizeText("2026-01-01 10:00:00 \x1b[31mERROR\x1b[0m boom\n2026-01-01 10:00:01 \x1b[32mINFO\x1b[0m ok").split("\n")).levels).toEqual({ ERROR: 1, INFO: 1 });
  });

  it("keeps the lines after an escape sequence that has no end", () => {
    // Two bytes in a logged user agent used to remove every line after them.
    const lines = Array.from({ length: 1_000 }, (_, index) => `2026-01-01 10:00:00 INFO request ${index + 1}`);
    lines[2] = "2026-01-01 10:00:00 INFO GET /x ua=\"evil\x1b]\" 200";
    const text = normalizeText(lines.join("\n"));
    expect(text.split("\n")).toHaveLength(1_000);
    expect(text.split("\n")[2]).toBe("2026-01-01 10:00:00 INFO GET /x ua=\"evil\" 200");
    // A window title whose end was cut off loses its two escape characters, not the next line.
    expect(normalizeText("\x1b]0;deploy@host: ~/app\nnext line")).toBe("0;deploy@host: ~/app\nnext line");
    // An OSC ended by ESC \ (a link), and the escapes that save and restore the cursor or reset.
    expect(normalizeText("see \x1b]8;;https://example.com\x1b\\the docs\x1b]8;;\x1b\\ now")).toBe("see the docs now");
    expect(normalizeText("\x1b7status line\x1b8 done\x1bc")).toBe("status line done");
  });

  it("lowercases for search without changing length", () => {
    const text = "İstanbul and ISTANBUL, Straße, ΑΒΓ, ok";
    const folded = foldCase(text);
    expect(folded).toHaveLength(text.length);
    expect(folded).toBe("istanbul and istanbul, straße, αβγ, ok");
    expect(foldCase("plain ASCII")).toBe("plain ascii");
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

  it("rejects compressed and other binary files that contain few zero bytes", async () => {
    const log = "2026-01-01 10:00:00 INFO request ok\n".repeat(2_000);
    expect(() => decodeText(new Uint8Array(gzipSync(log)))).toThrow(/gzip-compressed/);
    const zip = new JSZip();
    zip.file("app.log", log);
    const zipped = await zip.generateAsync({ type: "uint8array" });
    expect(() => decodeText(zipped)).toThrow(/ZIP archive/);
    // Encrypted or compressed data without a known header: bytes spread evenly, no zeros needed.
    const noise = new Uint8Array(randomBytes(8_192)).map((byte) => (byte === 0 ? 1 : byte));
    noise[0] = 0x41; // Never a byte-order mark or a known file signature by chance.
    expect(() => decodeText(noise)).toThrow(/binary/);
  });

  it("still accepts coloured logs and text in a legacy single-byte encoding", () => {
    const coloured = "2026-01-01 10:00:00 \x1b[31mERROR\x1b[0m boom\n".repeat(200);
    expect(decodeText(new TextEncoder().encode(coloured))).toBe(coloured);
    // Windows-1255 Hebrew: every letter is a byte above 0x7F, none of them control bytes.
    const legacy = new Uint8Array(Array.from({ length: 4_000 }, (_, index) => (index % 6 === 5 ? 0x20 : 0xe0 + (index % 27))));
    expect(() => decodeText(legacy)).not.toThrow();
    expect(decodeText(new TextEncoder().encode("col1\tcol2\x0c\nshort"))).toBe("col1\tcol2\x0c\nshort");
  });

  it("reads Office XML paragraphs, tabs, breaks, and entities", () => {
    const xml = "<w:body><w:p><w:pPr/><w:r><w:t>Fish &amp; chips</w:t><w:tab/><w:t xml:space=\"preserve\"> now</w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two &#x05E9;</w:t></w:r></w:p></w:body>";
    expect(officeXmlParagraphs(xml, "w")).toEqual(["Fish & chips\t now", "Line\ntwo ש"]);
  });

  it("reads a text box once, after the paragraph it is anchored in, and keeps the text around it", () => {
    // How Word writes a shape with text: once for programs that read shapes, again in VML for
    // older ones.
    const box = "<w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent>";
    const xml = [
      "<w:body><w:p><w:r><w:t>Before</w:t></w:r><w:r><mc:AlternateContent>",
      `<mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx>${box}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>`,
      `<mc:Fallback><w:pict><v:shape><v:textbox>${box}</v:textbox></v:shape></w:pict></mc:Fallback>`,
      "</mc:AlternateContent></w:r><w:r><w:t xml:space=\"preserve\"> and after the box</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>Next paragraph</w:t></w:r></w:p></w:body>",
    ].join("");
    expect(officeXmlParagraphs(xml, "w")).toEqual(["Before and after the box", "Box text", "Next paragraph"]);
  });

  it("does not take tab stops for tabs, and reads PowerPoint line breaks", () => {
    const word = "<w:p><w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"720\"/></w:tabs></w:pPr><w:r><w:t>Name</w:t><w:tab/><w:t>Value</w:t></w:r></w:p>";
    expect(officeXmlParagraphs(word, "w")).toEqual(["Name\tValue"]);
    const slide = "<a:p><a:pPr><a:tabLst><a:tab pos=\"914400\" algn=\"l\"/></a:tabLst></a:pPr><a:r><a:t>Quarterly</a:t></a:r><a:br><a:rPr lang=\"en-US\"/></a:br><a:r><a:t>Results</a:t></a:r></a:p>";
    expect(officeXmlParagraphs(slide, "a")).toEqual(["Quarterly\nResults"]);
  });

  it("reads Office XML in time that follows its length, whatever its shape", () => {
    // Paragraphs or text runs that are never closed made each of them a scan to the end of the file.
    const shapes = ["<w:p>".repeat(200_000), `<w:p><w:r>${"<w:t>".repeat(200_000)}</w:r></w:p>`, `<w:p a="${"<w:p>".repeat(100_000)}`];
    for (const xml of shapes) {
      const started = performance.now();
      officeXmlParagraphs(xml, "w");
      expect(performance.now() - started).toBeLessThan(1_000);
    }
    // A ">" inside a quoted value does not end the tag.
    expect(officeXmlParagraphs("<w:p><w:r w:x=\"a>b\"><w:t>Text</w:t></w:r></w:p>", "w")).toEqual(["Text"]);
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

  it("reads a long DOCX whose tags fall across the pieces it is unpacked in", async () => {
    const docx = new JSZip();
    const paragraphs = Array.from({ length: 5_000 }, (_, index) => `<w:p w:rsidR="00A1B2C3"><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:t xml:space="preserve">Paragraph ${index + 1} &amp; more.</w:t></w:r></w:p>`);
    docx.file("word/document.xml", `<w:document><w:body>${paragraphs.join("")}</w:body></w:document>`);
    const bytes = await docx.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const lines = (await extractText(bytes, { name: "a.docx", mimeType: "", format: "docx" })).text.split("\n");
    expect(lines).toHaveLength(5_000);
    expect(lines[0]).toBe("Paragraph 1 & more.");
    expect(lines[4_999]).toBe("Paragraph 5000 & more.");
  });

  it("refuses a DOCX that unpacks to far more than its size, before it is all unpacked", async () => {
    const docx = new JSZip();
    const paragraph = "<w:p><w:r><w:t>The same words, over and over again.</w:t></w:r></w:p>";
    docx.file("word/document.xml", `<w:document><w:body>${paragraph.repeat(300_000)}</w:body></w:document>`);
    const bytes = await docx.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    // About 20 MB of XML in a file of a few hundred kilobytes at most.
    expect(bytes.length).toBeLessThan(200_000);
    await expect(extractText(bytes, { name: "a.docx", mimeType: "", format: "docx" })).rejects.toThrow(/over 100 times its size.*zip bomb/);
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

  it("builds an outline for a file with hundreds of thousands of heading-like lines", () => {
    const lines = Array.from({ length: 600_000 }, (_, index) => (index % 2 === 0 ? `ITEM NUMBER ${index}` : ""));
    const outline = buildOutline(lines, "text");
    expect(outline).toHaveLength(400);
    expect(outline[0]).toMatchObject({ line: 1, title: "ITEM NUMBER 0" });
    expect(outline.at(-1)!.line).toBeGreaterThan(500_000);
  });
});
