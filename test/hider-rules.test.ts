// 0.99.14 (CIT-4): the rules of `CitationHider` beyond 0.99.12, its entries, `describe`, and the
// helper `attributedCitations`. The measurements are in specs/02-hiding (G1–G11).
import { describe, expect, it } from "vitest";
import { attributedCitations, checkCitations, CitationHider, hideCitations, type HiderEntry, type HiderPlace } from "llm-large-files";

const CONTRACT = { "contract-1": "חוזה.txt" };
const SHEET = { "customers-1": "לקוחות.xlsx" };
/** A workbook as the XLSX extractor writes it: two sheets, a hidden row 9 stored as an ordinary row. */
const WORKBOOK = [
  "## Sheet 1: לקוחות",
  "Columns: | A | B | C |",
  "Row 1: | שם | עיר | יתרה |",
  "Row 2: | רונית לוי | חיפה | 100 |",
  "Row 3: | אבי מזרחי | תל אביב | 200 |",
  "Row 8: | דני כהן | אשדוד | 300 |",
  "Row 9: | יעל ברק | חולון | 400 |",
  "",
  "## Sheet 2: סיכום",
  "Columns: | A | B |",
  "Row 1: | סה\"כ | 1000 |",
].join("\n");

/** Runs a text through a hider in pieces of `size` (0: whole), and returns what was shown and every entry. */
function run(text: string, names: Record<string, string>, content: string[] = [], size = 0, options: ConstructorParameters<typeof CitationHider>[2] = {}) {
  const hider = new CitationHider(names, content, options);
  let shown = "";
  const drained: HiderEntry[] = [];
  const pieces = size > 0 ? Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size)) : [text];
  for (const piece of pieces) {
    shown += hider.push(piece);
    for (const entry of hider.drainEntries()) {
      // A chip is given only once the text has reached it.
      if (entry.at !== undefined) expect(entry.at).toBeLessThanOrEqual(shown.length);
      drained.push(entry);
    }
  }
  shown += hider.flush();
  drained.push(...hider.drainEntries());
  return { shown, entries: hider.entries(), drained, hider };
}

describe("CitationHider, 0.99.14 rules (CIT-4)", () => {
  it("takes out lead-ins, brackets, lists and a whole lead-in sentence", () => {
    expect(hideCitations("התשלום תוך 30 ימים (מקור: חוזה.txt L4).", CONTRACT)).toBe("התשלום תוך 30 ימים.");
    expect(hideCitations("Due in 30 days [חוזה.txt L4].", CONTRACT)).toBe("Due in 30 days.");
    expect(hideCitations("Due in 30 days 【L4】.", CONTRACT)).toBe("Due in 30 days.");
    expect(hideCitations("הלקוחות (חוזה.txt שורות 12, 15 ו-18) שילמו.", CONTRACT)).toBe("הלקוחות שילמו.");
    expect(hideCitations("Payment is due in 30 days. Data source: חוזה.txt L4.", CONTRACT)).toBe("Payment is due in 30 days.");
    // A link or a reference stays.
    expect(hideCitations("See [the contract L4](https://example.com).", CONTRACT)).toBe("See [the contract L4](https://example.com).");
  });

  it("takes a run out of the end or the start of a parenthesis, and keeps its words (R2, R4)", () => {
    expect(hideCitations("קנס יומי (סעיף 3.5, שורה 31).", CONTRACT)).toBe("קנס יומי (סעיף 3.5).");
    expect(hideCitations("הספק משלם 500 ש\"ח ליום (L8: קנס יומי).", CONTRACT)).toBe("הספק משלם 500 ש\"ח ליום (קנס יומי).");
    expect(hideCitations("בדיקות סולר (כגון 84% ב-L12), ועוד.", CONTRACT)).toBe("בדיקות סולר (כגון 84%), ועוד.");
    expect(hideCitations("Started at 09:31 (L21880: `WARN failover started`).", { log: "app.log" })).toBe("Started at 09:31 (`WARN failover started`).");
    // A prefix letter with no hyphen is a word: "(הקנס מופיע בשורה 12)" stays.
    expect(hideCitations("הוא (הקנס מופיע בשורה 12).", CONTRACT)).toBe("הוא (הקנס מופיע בשורה 12).");
  });

  it("keeps a form written in the file beside a citation with a file name, and takes the citation out (R8)", () => {
    const names = { "mri-1": "סיכום בדיקת MRI.pdf" };
    const report = ["--- Page 1 ---\nממצאים:\nבלט דיסק בגובה L4-L5 הלוחץ על השורש."];
    expect(hideCitations("הבלט נמצא בגובה (L4-L5, סיכום בדיקת MRI.pdf L4).", names, report)).toBe("הבלט נמצא בגובה (L4-L5).");
    // With the name beside it, the same form is a citation.
    expect(hideCitations("נמצא בלט בגובה L4-L5 (סיכום בדיקת MRI.pdf L4-L5).", names, report)).toBe("נמצא בלט בגובה L4-L5.");
  });

  it("puts a citation the answer needs into words: after a colon, a prefix hyphen, a location word, a range word", () => {
    expect(hideCitations("דני כהן: (לקוחות.xlsx L10)", SHEET)).toBe("דני כהן: שורה 10");
    expect(hideCitations("הקנס מופיע ב-(L5).", CONTRACT)).toBe("הקנס מופיע בשורה 5.");
    expect(hideCitations("הקנס גבוה, ראו (L4).", CONTRACT)).toBe("הקנס גבוה, ראו שורה 4.");
    expect(hideCitations("The fee is described in (L4).", CONTRACT)).toBe("The fee is described in line 4.");
    // R10: the second end of a range is needed too.
    expect(hideCitations("החשבוניות מופיעות מ-(L3) ועד (L7).", CONTRACT)).toBe("החשבוניות מופיעות משורה 3 ועד שורה 7.");
    // N3: a place word right before the group takes only the number.
    expect(hideCitations("הקנס מופיע בשורה (L10).", CONTRACT)).toBe("הקנס מופיע בשורה 10.");
    // A direction mark between the hyphen and the parenthesis.
    expect(hideCitations("דני כהן מופיע ב-‏(L10).", CONTRACT)).toBe("דני כהן מופיע בשורה 10.");
    // A whole table cell, a whole list item, the whole answer.
    expect(hideCitations("| קנס | (L5) |", CONTRACT)).toBe("| קנס | שורה 5 |");
    expect(hideCitations("- (חוזה.txt L4)", CONTRACT)).toBe("- שורה 4");
    expect(hideCitations("**(L4)**", CONTRACT)).toBe("שורה 4");
  });

  it("writes the words in the answer's language, not the file name's (N2)", () => {
    expect(hideCitations("Avi Mizrahi is listed in (לקוחות.xlsx Row 7).", SHEET)).toBe("Avi Mizrahi is listed in row 7.");
    expect(hideCitations("אבי מזרחי רשום ב-(customers.xlsx Row 7).", { c: "customers.xlsx" })).toBe("אבי מזרחי רשום בשורה 7.");
  });

  it("keeps a place in words after a place the clause names, with its brackets (appositive)", () => {
    expect(hideCitations("דני כהן נמצא בגיליון לקוחות (שורה 8).", SHEET, [WORKBOOK])).toBe("דני כהן נמצא בגיליון לקוחות (שורה 8).");
    expect(hideCitations("Dani Cohen is on the customers sheet (Row 8).", SHEET, [WORKBOOK])).toBe("Dani Cohen is on the customers sheet (Row 8).");
    // Not after a place with a number: "מופיע בסעיף 148 (שורה 150)" names the place already.
    expect(hideCitations("הקנס מופיע בסעיף 148 (שורה 150):", CONTRACT)).toBe("הקנס מופיע בסעיף 148:");
  });

  it("does not read the library's own markers as the file's words (ROW-PREFIX): a hidden row's \"(Row 9)\" goes", () => {
    // HIDDEN-ROWS: 0.99.14 stores a hidden row as an ordinary "Row R:" line; its citation goes, with nothing left.
    const { shown, entries } = run("יעל ברק גרה בחולון (Row 9).", SHEET, [WORKBOOK]);
    expect(shown).toBe("יעל ברק גרה בחולון.");
    expect(entries).toEqual([expect.objectContaining({ kind: "removed", numbers: [{ from: 9, to: 9, form: "row" }], documentId: "customers-1" })]);
    expect(hideCitations("יעל ברק גרה בחולון (Row 9).", SHEET, [WORKBOOK], { rules: "0.99.12" })).toBe("יעל ברק גרה בחולון (Row 9).");
  });

  it("leaves a bare run outside brackets as it is written, and records it nowhere (out of scope)", () => {
    expect(hideCitations("According to L4, the fee is 5%.", CONTRACT)).toBe("According to L4, the fee is 5%.");
  });

  it("shows a run longer than its hold whole, never cut short (W04)", () => {
    const list = Array.from({ length: 450 }, (_, index) => `L${index + 3}`).join(", ");
    const text = `בגיליון יש 700 שורות (${list}).`;
    expect(text.length).toBeGreaterThan(2_000);
    expect(hideCitations(text, { s: "מכירות.xlsx" })).toBe(text);
    // Shorter, it goes whole.
    const short = `בגיליון יש 700 שורות (${list.slice(0, 1_400).replace(/, L?\d*$/, "")}).`;
    expect(hideCitations(short, { s: "מכירות.xlsx" })).toBe("בגיליון יש 700 שורות.");
  });

  it("reads a long run in time that grows with its length (HIDER-SPEED)", () => {
    const listOf = (count: number) => `x (${Array.from({ length: count }, (_, index) => `L${index + 1}`).join(", ")}) y`;
    const timed = (text: string) => {
      const start = performance.now();
      hideCitations(text, { s: "a.xlsx" });
      return performance.now() - start;
    };
    timed(listOf(50));
    // 0.99.14's first prototype took about 30 s on 2,145 characters; the bound is loose for slow runners.
    expect(timed(listOf(420))).toBeLessThan(1_500);
  });
});

describe("CitationHider entries (0.99.14)", () => {
  it("gives each citation once, in order, with its raw span, its chip's place and one number per number", () => {
    const text = "התשלום תוך 30 ימים (חוזה.txt L4). הקנס מופיע ב-(L5). הלקוחות (שורות 12, 15 ו-18) שילמו.";
    const { shown, drained, entries } = run(text, CONTRACT);
    expect(shown).toBe("התשלום תוך 30 ימים. הקנס מופיע בשורה 5. הלקוחות שילמו.");
    expect(drained).toEqual(entries);
    expect(drained.map((entry) => [entry.kind, entry.numbers.map((one) => one.from)])).toEqual([["removed", [4]], ["converted", [5]], ["removed", [12, 15, 18]]]);
    expect(text.slice(...drained[0]!.span)).toContain("(חוזה.txt L4)");
    expect(text.slice(...drained[1]!.span)).toBe("(L5)");
    expect(text.slice(...drained[2]!.span)).toContain("(שורות 12, 15 ו-18)");
    expect(drained[1]!.words).toBe("שורה 5");
    // Each chip right where the citation was: after "ימים", before "שורה 5", after "הלקוחות".
    expect(shown.slice(0, drained[0]!.at)).toBe("התשלום תוך 30 ימים");
    expect(shown.slice(drained[1]!.at)).toMatch(/^שורה 5/);
    expect(shown.slice(0, drained[2]!.at)).toMatch(/הלקוחות$/);
    expect(drained[0]).toMatchObject({ file: "חוזה.txt", documentId: "contract-1", ids: ["contract-1"] });
  });

  it("puts a chip after a list marker and after closing emphasis, never at a line's start", () => {
    const { shown, entries } = run("- (L12) first\n**18 days (L17)**.", CONTRACT);
    expect(shown).toBe("- first\n**18 days**.");
    expect(entries.map((entry) => entry.at)).toEqual([2, shown.indexOf("**.") + 2]);
  });

  it("holds an answer that may still be nothing but citations until it shows a word", () => {
    const hider = new CitationHider(CONTRACT);
    hider.push("(L4)");
    expect(hider.drainEntries()).toEqual([]);
    hider.push(" and more text");
    // Still held: the parenthesis waits for what follows it.
    hider.push(".");
    expect(hider.drainEntries().map((entry) => entry.kind)).toEqual(["removed"]);
  });

  it("records kept forms with no chip, and gives the 0.99.12 rules no entry", () => {
    const { entries } = run("Escalate to (L2).", CONTRACT, ["9| Support tiers: L2 and L3."]);
    expect(entries).toEqual([expect.objectContaining({ kind: "kept", rule: "file-form" })]);
    expect(entries[0]!.at).toBeUndefined();
    expect(run("Due (L4).", CONTRACT, [], 0, { rules: "0.99.12" }).entries).toEqual([]);
  });

  it("counts its holds (for lineTalk)", () => {
    const { hider } = run("Due (חוזה.txt L4) and (see the table).", CONTRACT);
    expect(hider.held().times).toBeGreaterThanOrEqual(2);
    expect(hider.held().characters).toBeGreaterThanOrEqual("(חוזה.txt L4".length);
  });
});

describe("CitationHider describe (0.99.14)", () => {
  it("asks for the words of a place the answer needs, at once, with its span, and falls back to its numbers", () => {
    const asked: HiderPlace[] = [];
    const describeIt = (place: HiderPlace) => {
      asked.push(place);
      return place.numbers[0]!.from === 10 ? "שורה 8 בגיליון לקוחות" : undefined;
    };
    const text = "דני כהן מופיע ב-(לקוחות.xlsx L10) וגם ב-(L11).";
    const { shown } = run(text, SHEET, [], 0, { describe: describeIt });
    expect(shown).toBe("דני כהן מופיע בשורה 8 בגיליון לקוחות וגם בשורה 11.");
    expect(asked[0]).toEqual({ ids: ["customers-1"], numbers: [{ from: 10, to: 10, form: "line" }], hebrew: true, span: asked[0]!.span });
    expect(text.slice(...asked[0]!.span)).toBe("(לקוחות.xlsx L10)");
    // An error in describe is its own numbers.
    expect(hideCitations("הקנס גבוה, ראו (L4).", CONTRACT, [], { describe: () => { throw new Error("no"); } })).toBe("הקנס גבוה, ראו שורה 4.");
  });

  it("puts an appositive's place in the app's words when they name another one (CIT-5)", () => {
    const describeIt = ({ numbers }: HiderPlace) => (numbers[0]!.from === 7 ? "שורה 5" : `שורה ${numbers[0]!.from}`);
    expect(hideCitations("אבי מזרחי מופיע בגיליון לקוחות (שורה 7).", SHEET, [WORKBOOK], { describe: describeIt })).toBe("אבי מזרחי מופיע בגיליון לקוחות (שורה 5).");
    expect(hideCitations("דני כהן נמצא בגיליון לקוחות (שורה 8).", SHEET, [WORKBOOK], { describe: describeIt })).toBe("דני כהן נמצא בגיליון לקוחות (שורה 8).");
  });

  it("does not show an answer of citations in words with wholeAnswer: false", () => {
    expect(hideCitations("(L4)", CONTRACT, [], { wholeAnswer: false })).toBe("");
  });
});

describe("CitationHider streaming (0.99.14)", () => {
  const CASES: Array<[string, Record<string, string>]> = [
    ["התשלום תוך 30 ימים (חוזה.txt L4). הקנס מופיע ב-‏(L5) 🙂 ועוד (סעיף 3.5, שורה 31).\n- (L12)\n| a | (L3) |", CONTRACT],
    ["Errors 👍 rose (app.log L5, L9; app.log lines 12-14) after the deploy (L21880: `WARN x`). Data source: app.log L4.", { log: "app.log" }],
    ["**שׁוּרָה** (שׁוּרָה 8) and *(L3)* and [L4](u) and ``(L3) `x` ``\n```\n(L1)\n```\nend (L2", CONTRACT],
  ];
  it("shows the same text and the same entries for every piece size from 1 to 7", () => {
    for (const [text, names] of CASES) {
      const whole = run(text, names);
      for (let size = 1; size <= 7; size++) {
        const split = run(text, names, [], size);
        expect(split.shown, `size ${size}`).toBe(whole.shown);
        expect(split.entries, `size ${size}`).toEqual(whole.entries);
        expect(split.drained, `size ${size}`).toEqual(whole.entries);
      }
      for (const entry of whole.entries) if (entry.at !== undefined) expect(entry.at).toBeLessThanOrEqual(whole.shown.length);
    }
  });

  it("waits for the second half of a character outside the basic plane", () => {
    const text = "fine 🙂 (L4) yes";
    const hider = new CitationHider(CONTRACT);
    let shown = "";
    for (const unit of text.split("")) shown += hider.push(unit);
    shown += hider.flush();
    expect(shown).toBe("fine 🙂 yes");
  });
});

describe("attributedCitations (0.99.14)", () => {
  const NAMES = { doc_contract: "contract.docx", doc_hebrew: "חוזה.docx", doc_log: "app.log" };
  it("lists what checkCitations reads, with places in the text as written and each citation's files", () => {
    const text = "Due (contract.docx L188-L200) and (app.log L5, L9); ‏בשׁוּרָה 12 בחוזה.docx.\nA bare L2 cache.";
    const found = attributedCitations(text, NAMES);
    const cited = checkCitations(text, [], NAMES).cited!;
    expect(found.map(({ from, to, form }) => ({ from, to, form }))).toEqual(cited.map(({ from, to, form }) => ({ from, to, form })));
    expect(found.map((one) => text.slice(one.start, one.end))).toEqual(["L188-L200", "L5", "L9", "בשׁוּרָה 12"]);
    expect(found.map((one) => one.ids)).toEqual([["doc_contract"], ["doc_log"], ["doc_log"], ["doc_hebrew"]]);
  });

  it("gives the one document of a question when none is named, and none when there are several", () => {
    expect(attributedCitations("Due (L4).", { a: "a.txt" })).toEqual([{ start: 5, end: 7, from: 4, to: 4, form: "line", ids: ["a"] }]);
    expect(attributedCitations("Due (L4).", { a: "a.txt", b: "b.txt" })).toEqual([{ start: 5, end: 7, from: 4, to: 4, form: "line" }]);
    expect(attributedCitations("", {})).toEqual([]);
  });
});
