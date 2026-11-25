import { describe, expect, it } from "vitest";
import { aggregateTable, parseNumber } from "../src/aggregate.js";
import { decodeHtmlEntities, htmlToText } from "../src/html.js";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { grep, grepSource, rankPassages, rankSource, SearchableDocument, searchTerms, unsafeRegexReason } from "../src/search.js";
import type { DocumentFormat } from "../src/types.js";
import { utf8 } from "./fake-model.js";

// The findings of the review of 0.99.9 in the table tool, the search and the HTML reader, each as
// the review saw it and as it reads once fixed.

const doc = (format: DocumentFormat, text: string) => new SearchableDocument({ meta: { id: "doc_a", name: `t.${format}`, format } as never, text });

describe("header_rows of more rows than were held when the header was decided", () => {
  it("takes three header rows of a CSV file (it took two)", async () => {
    const csv = ["Region,Sales,Sales", ",2025,2026", ",Units,Units", "North,10,20", "South,1,2"].join("\n");
    const result = await aggregateTable(doc("csv", csv), { headerRows: 3, metrics: ["sum:Sales / 2026 / Units"] });
    expect(result.headerRows).toBe(3);
    expect(result.headerLine).toBe(3);
    expect(result.columns).toEqual(["Region", "Sales / 2025 / Units", "Sales / 2026 / Units"]);
    expect(result.rowsRead).toBe(2);
    expect(result.groups[0]!.values).toEqual({ "sum:Sales / 2026 / Units": 22 });
  });

  it("takes two header rows of a CSV file below a title row (it took one)", async () => {
    const csv = ["Report of March", "Region,Q1,Q1", ",January,February", "North,10,20", "South,1,2"].join("\n");
    const result = await aggregateTable(doc("csv", csv), { headerRows: 2, metrics: ["sum:Q1 / February"] });
    expect(result.title).toBe("Report of March");
    expect(result.headerRows).toBe(2);
    expect(result.columns).toEqual(["Region", "Q1 / January", "Q1 / February"]);
    expect(result.rowsRead).toBe(2);
    expect(result.groups[0]!.values).toEqual({ "sum:Q1 / February": 22 });
  });

  it("takes the header rows of a sheet whose second header row holds numbers", async () => {
    // The quarter numbers of row 2 read as data: the header was decided there, two rows held.
    const text = ["## Sheet 1: Plan", "Row 1: | Region | Quarter |  |", "Row 2: |  | 1 | 2 |", "Row 3: |  | Units | Units |", "Row 4: | North | 10 | 20 |", "Row 5: | South | 1 | 2 |"].join("\n");
    const result = await aggregateTable(doc("xlsx", text), { headerRows: 3, metrics: ["sum:Quarter / 2 / Units"] });
    expect(result.headerRows).toBe(3);
    expect(result.columns).toEqual(["Region", "Quarter / 1 / Units", "Quarter / 2 / Units"]);
    expect(result.rowsRead).toBe(2);
    expect(result.groups[0]!.values).toEqual({ "sum:Quarter / 2 / Units": 22 });
  });

  it("takes five header rows, and the rows there are when the table has fewer", async () => {
    const rows = ["a,b", "c,d", "e,f", "g,h", "i,j", "1,2", "3,4"];
    const five = await aggregateTable(doc("csv", rows.join("\n")), { headerRows: 5, metrics: ["sum:b / d / f / h / j"] });
    expect(five.headerRows).toBe(5);
    expect(five.rowsRead).toBe(2);
    expect(five.groups[0]!.values).toEqual({ "sum:b / d / f / h / j": 6 });
    const short = await aggregateTable(doc("csv", rows.slice(0, 3).join("\n")), { headerRows: 5, metrics: ["count"] });
    expect(short.headerRows).toBe(3);
    expect(short.rowsRead).toBe(0);
  });

  it("decides the header of a short table where the table ends, and takes no row of the next one", async () => {
    // Two sheets that the name given both fit: the first has its two header rows and nothing more.
    const sheets = ["## Sheet 1: Data 2025", "Row 1: | Region | Sales |", "Row 2: |  | 2025 |", "", "## Sheet 2: Data 2026", "Row 1: | Region | Sales |", "Row 2: | North | 10 |"].join("\n");
    const sheet = await aggregateTable(doc("xlsx", sheets), { table: "Data", headerRows: 2, metrics: ["count"] });
    expect([sheet.table, sheet.columns, sheet.rowsRead, sheet.tables]).toEqual(["Sheet 1: Data 2025", ["Region", "Sales / 2025"], 0, 2]);
    const pipes = ["| Region | Sales |", "|  | 2025 |", "", "Some text.", "", "| Region | Sales |", "| North | 10 |"].join("\n");
    const first = await aggregateTable(doc("markdown", pipes), { table: "table", headerRows: 2, metrics: ["count"] });
    expect([first.table, first.columns, first.rowsRead]).toEqual(["table 1 of 2", ["Region", "Sales / 2025"], 0]);
  });

  it("reads the same rows as before with header_rows of 0, 1 and 2", async () => {
    const csv = ["Region,Amount", "North,10", "South,1"].join("\n");
    const none = await aggregateTable(doc("csv", csv), { headerRows: 0, metrics: ["count"] });
    expect([none.headerRows, none.rowsRead, none.columns]).toEqual([0, 3, ["Column 1", "Column 2"]]);
    const one = await aggregateTable(doc("csv", csv), { headerRows: 1, metrics: ["sum:Amount"] });
    expect([one.headerRows, one.rowsRead, one.groups[0]!.values]).toEqual([1, 2, { "sum:Amount": 11 }]);
    const two = await aggregateTable(doc("csv", csv), { headerRows: 2, metrics: ["count"] });
    expect([two.headerRows, two.rowsRead, two.columns]).toEqual([2, 1, ["Region / North", "Amount / 10"]]);
  });
});

describe("a search for the last matches, with lines around them", () => {
  const text = Array.from({ length: 40 }, (_, index) => (index % 10 === 0 ? `ERROR ${index + 1}` : `line ${index + 1}`)).join("\n");

  it("shows the first match without lines around it, not with blank ones", async () => {
    const options = { maxResults: 2, contextLines: 1, order: "last" as const };
    const held = grep(doc("text", text), "ERROR", options);
    const read = await grepSource(doc("text", text), "ERROR", options);
    for (const result of [held, read]) {
      expect(result.totalMatchingLines).toBe(4);
      expect(result.first).toEqual({ line: 1, text: "ERROR 1" });
      expect(result.matches).toEqual([
        { line: 21, text: "ERROR 21", before: ["20| line 20"], after: ["22| line 22"] },
        { line: 31, text: "ERROR 31", before: ["30| line 30"], after: ["32| line 32"] },
      ]);
    }
  });
});

describe("character references of an HTML page", () => {
  it("leaves the parameters of an address as they are written", async () => {
    const address = "https://example.com/list?a=1&copy=2&reg=us&sect=3&not=4&times=5&lt=6&le=7&sum=8&pi=9";
    expect(await htmlToText(`<p><a href="${address}">The list</a></p>`)).toBe(`The list (${address})`);
    // Written out as text too: the address stays one a reader can follow, and is said once.
    expect(await htmlToText(`<p>${address}</p>`)).toBe(address);
    expect(await htmlToText(`<p><a href="${address}">${address}</a></p>`)).toBe(address);
  });

  it("reads a name without its semicolon only where HTML does", () => {
    // The names of HTML 4's Latin-1 table are read without one, but not before "=".
    expect(decodeHtmlEntities("&copy 2026 Acme &amp Sons, 5 &lt 6, caf&eacute")).toBe("© 2026 Acme & Sons, 5 < 6, café");
    expect(decodeHtmlEntities("&copy=2 &reg=us &amp=1")).toBe("&copy=2 &reg=us &amp=1");
    // Every other name needs its semicolon.
    expect(decodeHtmlEntities("a &mdash b &le 5 &pi &euro 3 &hellip")).toBe("a &mdash b &le 5 &pi &euro 3 &hellip");
    expect(decodeHtmlEntities("a &mdash; b &le; 5 &pi; &euro; 3 &hellip;")).toBe("a — b ≤ 5 π € 3 …");
    // With the semicolon, before "=" too; and numbers as before.
    expect(decodeHtmlEntities("&copy;=2 &#169=2 &#xA9;=2 AT&T ?a=1&b=2")).toBe("©=2 ©=2 ©=2 AT&T ?a=1&b=2");
  });

  it("decodes a picture's alt text once", async () => {
    expect(await htmlToText('<p>Write <img alt="&amp;copy; for the &amp;lt; sign"> here</p>')).toBe("Write [Image: &copy; for the &lt; sign] here");
    expect(await htmlToText('<table><tr><td><img alt="AT&amp;amp;T"></td><td>1</td></tr></table>')).toBe("| [Image: AT&amp;T] | 1 |");
    expect(await htmlToText('<p><img alt="Fish &amp; chips &copy; 2026"></p>')).toBe("[Image: Fish & chips © 2026]");
  });
});

describe("an end tag of a skipped element that was not opened", () => {
  it("does not end the element being left out", async () => {
    for (const stray of ["</script>", "</style>", "</svg>", "</select>", "</iframe>"]) {
      for (const [open, close] of [["<noscript>", "</noscript>"], ["<template>", "</template>"], ["<svg>", "</svg>"]] as const) {
        if (stray === close) continue;
        const page = `<p>before</p>${open}<b>left</b>${stray}<b>out</b>${close}<p>after</p>`;
        expect(await htmlToText(page), `${stray} in ${open}`).toBe("before\nafter");
      }
    }
  });

  it("still ends each skipped element at its own end tag, nested ones too", async () => {
    expect(await htmlToText("<p>a</p><svg><style>x{}</style><noscript>n</noscript>s</svg><p>b</p><noscript>n</noscript><p>c</p>")).toBe("a\nb\nc");
    expect(await htmlToText("<p>a</p></script></style></noscript><p>b</p>")).toBe("a\nb");
    expect(await htmlToText("<p>a</p><svg><svg>x</svg>y</svg><p>b</p>")).toBe("a\nb");
  });
});

describe("parseNumber", () => {
  it("does not read a date, a phone number or other spaced digits as a number", () => {
    for (const text of ["2026 03 14", "14 03 2026", "052 123 4567", "03 123 4567", "1 2 3", "12 34", "1234 567", "1  234", "1 234 56", "1 234,5 6", "10 000 000 0"]) {
      expect(parseNumber(text), text).toBeUndefined();
    }
  });

  it("still reads a space, a no-break space or an apostrophe between thousands", () => {
    const cases: Array<[string, number]> = [
      ["1 234", 1234], ["1 234 567", 1234567], ["12 345,67", 12345.67], ["1 234.5", 1234.5], ["1\u00a0234\u00a0567", 1234567], ["1\u202f234", 1234],
      ["1'234'567.89", 1234567.89], ["₪ 1 234", 1234], ["1 234 ₪", 1234], ["- 1 234", -1234], ["(1 234)", -1234], ["12 %", 12], ["$ 12.00", 12], ["+ 5", 5],
    ];
    for (const [text, value] of cases) expect(parseNumber(text), text).toBe(value);
  });

  it("reads a minus sign inside brackets as one negative, not as two", () => {
    expect(parseNumber("(-100)")).toBe(-100);
    expect(parseNumber("(-$1,200.50)")).toBe(-1200.5);
    expect(parseNumber("(100)")).toBe(-100);
    expect(parseNumber("-100")).toBe(-100);
  });

  it("sums a column with such values as the table means them", async () => {
    const csv = ["Item,Phone,Amount", "A,052 123 4567,(-100)", "B,03 123 4567,1 250", "C,2026 03 14,50"].join("\n");
    const result = await aggregateTable(doc("csv", csv), { metrics: ["sum:Amount", "sum:Phone"] });
    expect(result.groups[0]!.values).toEqual({ "sum:Amount": 1200, "sum:Phone": null });
    expect(result.notNumbers).toEqual({ "sum:Phone": 3 });
  });
});

describe("a keyword found more often than is counted", () => {
  // 210,000 lines with "error", past the 200,000 occurrences counted of a term.
  const log = Array.from({ length: 210_000 }, (_, index) => `error ${index % 7}`).join("\n");

  it("still gives passages that hold it, not none", async () => {
    const document = doc("log", log);
    const held = rankPassages(document, "error", 3);
    expect(held).toHaveLength(3);
    for (const passage of held) expect(document.lines.line(passage.from)).toContain("error");
    const common = { terms: [] as string[] };
    const read = await rankSource(document, "error", 3, undefined, undefined, common);
    expect(read).toEqual(held);
    expect(common.terms).toEqual(["error"]);
  });

  it("ranks by the rarer term when the query has one, as before", () => {
    const common = { terms: [] as string[] };
    const found = rankPassages(doc("log", `${log}\nerror timeout in the payment service\n${log}`), "error timeout", 3, undefined, common);
    // Only the passage with "timeout": "error", found too often, does not rank the others.
    expect(found).toHaveLength(1);
    expect(found[0]!.from).toBeLessThanOrEqual(210_001);
    expect(found[0]!.to).toBeGreaterThanOrEqual(210_001);
    expect(common.terms).toEqual([]);
  });

  it("ranks by the common term when the other terms of the query are not in the file", () => {
    const common = { terms: [] as string[] };
    const found = rankPassages(doc("log", log), "error nothinglikethis", 3, undefined, common);
    expect(found).toHaveLength(3);
    expect(common.terms).toEqual(["error"]);
  });

  it("is not answered with a note that no passage contains it", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log) });
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "error" });
    expect(result.note ?? "").not.toContain("No passage contains these keywords");
    expect((result.passages as unknown[]).length).toBeGreaterThan(0);
    // A term with no hit at all is still answered so.
    const none = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "nothinglikethis" });
    expect(none.note).toBe("No passage contains these keywords. Try other words, synonyms, or exact mode.");
  });
});

describe("a regex with an escape that only the Unicode flag reads", () => {
  const text = ["שלום עולם", "hello world", "p{Hebrew} written out"].join("\n");

  it("is refused when it is not valid with the flag, not searched as other text", async () => {
    // Without the flag, \p{Hebrew} is the text "p{Hebrew}": 1 matching line of another kind, or none.
    expect(unsafeRegexReason("\\p{Hebrew}+")).toMatch(/^Invalid regex: .*Invalid property name/);
    expect(() => grep(doc("text", text), "\\p{Hebrew}+", { regex: true, maxResults: 5, contextLines: 0 })).toThrow(/Invalid regex/);
    expect(unsafeRegexReason("[\\w-.]\\p{L}")).toMatch(/^Invalid regex: /);
    expect(unsafeRegexReason("\\u{110000}")).toMatch(/^Invalid regex: /);
    expect(unsafeRegexReason("[^\\P{Nope}]")).toMatch(/^Invalid regex: /);
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8(text) });
    const result = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "\\p{Hebrew}+", mode: "regex" });
    expect(result.error).toMatch(/^Invalid regex: /);
    expect(result.total_matching_lines).toBeUndefined();
  });

  it("runs as before when it is valid, and when the escape is of a backslash", () => {
    const options = { regex: true, maxResults: 5, contextLines: 0 };
    expect(grep(doc("text", text), "\\p{Script=Hebrew}+", options).matches.map((match) => match.line)).toEqual([1]);
    expect(grep(doc("text", text), "\\u{5E9}", options).matches.map((match) => match.line)).toEqual([1]);
    // A pattern valid only without the flag still runs, when it has no such escape.
    expect(unsafeRegexReason("[\\w-.]+")).toBeNull();
    // "\\p{" is a backslash and the text "p{": no escape.
    expect(unsafeRegexReason("\\\\p\\{Hebrew")).toBeNull();
    expect(grep(doc("text", text), "p\\{Hebrew\\}", options).matches.map((match) => match.line)).toEqual([3]);
  });
});

describe("the stems of a Hebrew word with prefix letters", () => {
  it("gives a stem for each prefix letter taken off, not only the shortest", () => {
    expect(searchTerms("המשרד").map(({ term }) => term)).toEqual(["המשרד", "משרד", "שרד"]);
    expect(searchTerms("והחוזה").map(({ term }) => term)).toEqual(["והחוזה", "החוזה", "חוזה"]);
    expect(searchTerms("השכירות").map(({ term }) => term)).toEqual(["השכירות", "שכירות", "כירות", "ירות"]);
    // One letter off, and none: as before.
    expect(searchTerms("בחוזה").map(({ term }) => term)).toEqual(["בחוזה", "חוזה"]);
    expect(searchTerms("מחיר").map(({ term }) => term)).toEqual(["מחיר", "חיר"]);
    expect(searchTerms("בית").map(({ term }) => term)).toEqual(["בית"]);
  });

  it("ranks a passage with the word above passages that hold its shortest stem in other words", () => {
    // The file writes משרד (office) once, in a long passage, and שרד (survived) often, in short ones.
    const filler = (count: number, from: number) => Array.from({ length: count }, (_, index) => `סעיף ${from + index}: הצדדים מצהירים כי קראו את ההוראות והבינו את תוכנן, וכי אין להם כל טענה בעניין זה.`);
    const survived = (number: number) => `מהדוח ${number} עולה כי העסק שרד את המשבר, כי הענף כולו שרד, וכי מי ששרד את השנה הראשונה שרד גם את השנייה.`;
    const lines: string[] = [];
    for (let block = 0; block < 40; block++) {
      lines.push(...filler(12, block * 100));
      if (block === 17) lines.push("משרד החברה נמצא בחיפה, ברחוב העצמאות, ופתוח לקהל בימים א׳ עד ה׳.");
      if (block % 5 === 1) lines.push(survived(block), survived(block + 1), survived(block + 2));
    }
    const office = lines.findIndex((line) => line.startsWith("משרד")) + 1;
    const document = doc("text", lines.join("\n"));
    for (const query of ["המשרד", "במשרד", "משרד"]) {
      const best = rankPassages(document, query, 5)[0]!;
      // Until 0.99.10, המשרד and במשרד searched שרד alone, and the passage came after all eight with שרד.
      expect([query, best.from <= office && best.to >= office]).toEqual([query, true]);
    }
  });

  it("keeps every word of a long query before the stems, within its 12 terms", () => {
    // Ten words that each start with a prefix letter: with a stem after each word, the last four words were dropped.
    const words = ["בחוזה", "השכירות", "מופיעה", "התחייבות", "לתשלום", "מראש", "בגין", "שלושה", "חודשים", "לפחות"];
    const terms = searchTerms(words.join(" ")).map(({ term }) => term);
    expect(terms).toEqual([...words, "חוזה", "שכירות"]);
    // A query that fits keeps the order it had: each word, then its stems.
    expect(searchTerms("בחוזה השכירות").map(({ term }) => term)).toEqual(["בחוזה", "חוזה", "השכירות", "שכירות", "כירות", "ירות"]);
    // A stem that is also a word of the query is kept as a word.
    const repeated = searchTerms(`${words.join(" ")} חוזה`).map(({ term }) => term);
    expect(repeated.indexOf("חוזה")).toBeLessThan(10);
    for (const word of words) expect(repeated, word).toContain(word);
  });
});
