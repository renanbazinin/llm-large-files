// The tests of the HTML reader that hold work to the clock: pages built to make it work far longer
// than their size, read in bounded time and with turns of the event loop between pieces (from
// test/verify-0.8-html.test.ts, test/review-0.8.test.ts and test/formats-0.8.test.ts).
import { describe, expect, it } from "vitest";
import { extractText } from "../../src/extract.js";
import { html, htmlToText } from "../../src/html.js";
import { parseAttributes } from "../../src/xml-stream.js";
import { utf8 } from "../fake-model.js";
import { timed } from "./clock.js";

/**
 * The beats of a 5 ms timer while `work` ran (0 when the work never let a timer run), and the
 * longest time the timer waited: about the longest step that held the event loop.
 */
async function beatsDuring<T>(work: () => Promise<T>): Promise<{ value: T; beats: number; gap: number }> {
  let beats = 0;
  let gap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    beats++;
    gap = Math.max(gap, now - last);
    last = now;
  }, 5);
  try {
    const value = await work();
    gap = Math.max(gap, performance.now() - last);
    return { value, beats, gap };
  } finally {
    clearInterval(timer);
  }
}

describe("preformatted text (finding 1)", () => {
  it("trims the end of a line in linear time, whatever white space it holds", async () => {
    // `/\s+$/` on the line: 4.7 seconds for 40,000 spaces, 28 for 120,000.
    const run = " ".repeat(50_000);
    for (const [page, text] of [
      [`<html><body><pre>a${run}b</pre></body></html>`, `a${run}b`],
      [`<textarea>a${"\t ".repeat(25_000)}b</textarea>`, `a${"\t ".repeat(25_000)}b`],
      [`<xmp>a${"   ".repeat(17_000)}b</xmp>`, `a${"   ".repeat(17_000)}b`],
      [`<plaintext>a${run}b`, `a${run}b`],
      [`<pre>a${run}</pre><p>after</p>`, "a\nafter"],
      [`<pre>a${run}\n${run}b${run}\r\nc</pre>`, `a\n${run}b\nc`],
    ] as const) {
      const { value, ms } = await timed(() => htmlToText(page));
      expect(ms).toBeLessThan(1_000);
      expect(value).toBe(text);
    }
  });
});

describe("large pages (finding 2)", () => {
  it("refuses a page as soon as its text passes maxTextBytes", async () => {
    // 2.5 MB of list items make 11.5 million characters of text: built whole before ingest looked.
    const page = `${"<ol>".repeat(7)}${"<li>x".repeat(500_000)}`;
    const input = { name: "a.html", mimeType: "", format: "html" as const, maxTextBytes: 1_000_000 };
    const { ms } = await timed(() => expect(extractText(utf8(page), input)).rejects.toThrow(/^This HTML page holds more than 977 KB of text, more than is kept from one file\./));
    expect(ms).toBeLessThan(3_000);
    // At the limit exactly, the text is kept; the title counts too.
    const exact = `<p>${"x".repeat(1_000)}</p>`;
    expect((await html(utf8(exact), { ...input, maxTextBytes: 1_000 })).text).toHaveLength(1_000);
    await expect(html(utf8(exact), { ...input, maxTextBytes: 999 })).rejects.toThrow(/of text, more than is kept/);
    await expect(html(utf8(`<title>T</title>${exact}`), { ...input, maxTextBytes: 1_003 })).rejects.toThrow(/of text, more than is kept/);
    expect((await html(utf8(`<title>T</title>${exact}`), { ...input, maxTextBytes: 1_005 })).text).toBe(`# T\n\n${"x".repeat(1_000)}`);
    // Cells, their separators, and the empty cells of merged ones count as they are read.
    const row = `<table><tr>${"<td>x".repeat(200_000)}</table>`;
    await expect(html(utf8(row), { ...input, maxTextBytes: 100_000 })).rejects.toThrow(/of text, more than is kept/);
    const spans = `<table>${"<tr><td colspan=64>x".repeat(20_000)}</table>`;
    await expect(html(utf8(spans), { ...input, maxTextBytes: 100_000 })).rejects.toThrow(/of text, more than is kept/);
  });

  it("reads a page of megabytes with no block in it a piece at a time, with pauses", async () => {
    // One line, its spaces made one and then trimmed in single calls: 16 MB held the server for
    // four seconds, and 100 MB ran out of memory. Read that way, the page lets no timer run.
    const page = "a\n".repeat(2 * 1024 * 1024);
    const { value, beats, gap } = await beatsDuring(() => htmlToText(page));
    expect(beats).toBeGreaterThan(1);
    expect(gap).toBeLessThan(1_000);
    expect(value).toHaveLength(4 * 1024 * 1024 - 1);
    expect(value.startsWith("a a a")).toBe(true);
    expect(value.endsWith("a a")).toBe(true);
  });

  it("reads a row of many cells without a step over all of them", async () => {
    const page = `<table><tr>${"<td>x".repeat(300_000)}</table>`;
    const { value, beats, gap } = await beatsDuring(() => htmlToText(page));
    expect(beats).toBeGreaterThan(1);
    expect(gap).toBeLessThan(1_000);
    expect(value).toBe(`|${" x |".repeat(300_000)}`);
  });

  it("looks for the title at the start of the text only", async () => {
    // A title written to be found nowhere, in a body of 8 MB: 5.9 seconds to look for it.
    const title = `${"a".repeat(500)}b${"a".repeat(499)}`;
    const page = `<title>${title}</title><h1>x</h1><p>${"a".repeat(8 * 1024 * 1024)}</p>`;
    const { value, ms } = await timed(() => htmlToText(page));
    expect(ms).toBeLessThan(2_000);
    expect(value.startsWith(`# ${title}\n\n# x\n`)).toBe(true);
    // A title is kept up to 1,000 characters; a title the first heading says is not written twice.
    expect((await htmlToText(`<title>${"word ".repeat(1_000)}</title><p>x</p>`)).split("\n")[0]).toBe(`# ${"word ".repeat(200).trim()}`);
    expect(await htmlToText("<title>Report</title><h1>Report</h1><p>x</p>")).toBe("# Report\nx");
  });

  it("reads the rest of the page after a title that never ends, and looks for its end once", async () => {
    const { value, ms } = await timed(() => htmlToText(`${"<title>".repeat(200_000)}<p>Text</p>`));
    expect(ms).toBeLessThan(2_000);
    expect(value).toBe("Text");
    expect(await htmlToText("<html><head><title>Broken<body><p>Text</p>")).toBe("Broken\nText");
  });
});

describe("merged table cells (finding 16)", () => {
  it("writes the empty cells of merged ones in the first 64 columns only", async () => {
    const wide = await htmlToText("<table><tr><td colspan=100000>a</td><td>b</td></tr></table>");
    expect(wide).toBe(`| a |${"  |".repeat(63)} b |`);
    // Thousands of cells spanning every row, then rows of one cell: 65 cells a row, not 2,001.
    const page = `<table><tr>${"<td rowspan=0>h".repeat(2_000)}</tr>${"<tr><td>x".repeat(2_000)}</table>`;
    const { value, ms } = await timed(() => htmlToText(page));
    expect(ms).toBeLessThan(3_000);
    const lines = value.split("\n");
    expect(lines).toHaveLength(2_001);
    expect(lines.slice(1).every((line) => line === `|${"  |".repeat(64)} x |`)).toBe(true);
  });
});

describe("follow-ups of the check of the HTML fixes", () => {
  it("does not decode a huge attribute of references whole", async () => {
    const references = "&amp;".repeat(2_000_000);
    for (const page of [`<img alt="${references}">`, `<a href="${references}">x</a>`, `<ol start="${references}"><li>a</ol>`, `<table><tr><td colspan="${references}">c</td></tr></table>`]) {
      const started = performance.now();
      await htmlToText(page);
      expect(performance.now() - started).toBeLessThan(3_000);
    }
    // A picture whose address is a data URL of megabytes keeps its alt text, read after it.
    expect(await htmlToText(`<img src="data:image/png;base64,${"A".repeat(3_000_000)}" alt="Sales chart">`)).toBe("[Image: Sales chart]");
  });
});

describe("small hostile uploads that held the server", () => {
  it("reads the attributes of a long tag with no \"=\" in linear time, and those of HTML", async () => {
    expect((await timed(() => parseAttributes(` ${"x".repeat(64_000)}`))).ms).toBeLessThan(200);
    const page = `<html><body>${Array.from({ length: 3 }, () => `<a ${"x".repeat(60_000)}>link</a>`).join("")}<p>after</p></body></html>`;
    const { value, ms } = await timed(() => htmlToText(page));
    expect(ms).toBeLessThan(2_000);
    expect(value).toContain("after");
    expect(parseAttributes(` href=https://x.test/a?b=1 disabled title='it"s' data-x = "1&amp;2" /`)).toEqual({ href: "https://x.test/a?b=1", disabled: "", title: "it\"s", "data-x": "1&2" });
  });
});

describe("hostile spreadsheets and pages", () => {
  it("indents lists nested thousands deep by a few levels only", async () => {
    const started = performance.now();
    const text = await htmlToText("<ul><li>x".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThan(20);
  });
});
