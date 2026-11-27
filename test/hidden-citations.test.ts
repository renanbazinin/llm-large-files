// 0.99.12: an answer shown without its citations (`AskOptions.showCitations: false`,
// `hideCitations`, `CitationHider`), and the list of what it cited (`CitationCheck.cited`).
import { describe, expect, it } from "vitest";
import {
  askStream,
  askWithFiles,
  checkCitations,
  CitationHider,
  createLargeFiles,
  hideCitations,
  MemoryDocumentStore,
  type AskEvent,
  type Evidence,
  type ModelAdapter,
  type ModelReply,
  type ModelRequest,
} from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const NAMES = { doc_contract: "contract.docx", doc_hebrew: "חוזה.docx", doc_log: "app.log" };
const question = (text: string) => [{ role: "user" as const, text }];

/** Each case: what the model wrote, and what is shown without its citations. */
const HIDDEN: Array<[string, string]> = [
  ["## Payment terms (L188-L200)\nPayment is due in 30 days (contract.docx L188-L200).", "## Payment terms\nPayment is due in 30 days."],
  ["**Late delivery (L188–L200)**", "**Late delivery**"],
  ["Errors rose (app.log L5, L9; app.log lines 12-14) after the deploy.", "Errors rose after the deploy."],
  ["התשלום תוך 30 יום (חוזה.docx שורות 188-200).", "התשלום תוך 30 יום."],
  ["התשלום תוך 30 יום (בשורה 12 בחוזה.docx)", "התשלום תוך 30 יום"],
  ["The fee (contract.docx, line 40) and the cap (Row 12).", "The fee and the cap."],
  ["A page too (report.pdf p. 3, L120).", "A page too."],
  ["- (L12) The first point", "- The first point"],
  ["(L12) A line that starts with one", "A line that starts with one"],
  ["  (L12) An indented line\n    (L13)  Deeper", "  An indented line\n    Deeper"],
  ["word(L12) next", "word next"],
  ["| 30 days | (contract.docx L12) |", "| 30 days | |"],
  ["Two in a row (L1) (L2).", "Two in a row."],
  // Seen in Gemini's answers: a file name in backticks, and the word for lines before a range.
  ["Due (`report.docx` L17, L28) and (`חוזה.docx` שורות 3-4).", "Due and."],
  ["### שבוע 1: 1 עד 7 באוקטובר (שורות L1–L306)\nטקסט", "### שבוע 1: 1 עד 7 באוקטובר\nטקסט"],
  // Emphasis around a citation goes with it; emphasis around more text stays.
  ["Text **(L12)**. And *(L3)* here.", "Text. And here."],
  ["**(L12)** Start", "Start"],
  ["**(L5) Title** and **Title (L6)**", "**Title** and **Title**"],
  // A list item, or a line, left with nothing but citations goes, with its end.
  ["- a\n- (L12)\n- b\n  1. (L3)\n* (L4)\n- (L5)", "- a\n- b\n"],
  ["Text\n(L12)\nMore", "Text\nMore"],
  ["12. An item (L3)\n2026 was (L4) good\n-5 degrees (L6)", "12. An item\n2026 was good\n-5 degrees"],
  // Code is shown as it is written; the citation after it goes.
  ["Call `fn(L12)` here (L3).", "Call `fn(L12)` here."],
  ["```\nfoo (L12)\n```\nafter (L3)", "```\nfoo (L12)\n```\nafter"],
  ["  ```js\n  x(L1)\n  ```\nok (L2).", "  ```js\n  x(L1)\n  ```\nok."],
  // A parenthesis of document IDs alone says nothing to the user.
  ["The contract (doc_contract) and both (`doc_contract`, doc_log) say so.", "The contract and both say so."],
  // A backtick inside a parenthesis that is not a citation opens no code past its ")".
  ["(see `x) then (L12).\nnext (L13).", "(see `x) then.\nnext."],
];

/** Each case: a parenthesis that is not citations alone, or a citation outside parentheses, which stay. */
const KEPT = [
  "An L2 cache (L2 cache) is fast.",
  "As (see the table, L12) shows.",
  "The file (report-L3.docx) is attached.",
  "Line 12 of contract.docx says so, and so does app.log L40.",
  "An open one (contract.docx L12",
  "Nested (a (b) L12) stays.",
  "Trailing space   ",
  "Numbers (12) and (2024) stay.",
  "Due [L12] and [report.docx L12].",
  "A time (1312ms, L22776) with words.",
  "- \n- An empty item the model wrote",
  "Line one  \nLine two",
  "Inline `(L12)` and ``(L3) `x` ``.",
  "The file (contract.docx) is named, and (see doc_contract) has words.",
];

/**
 * The cases above that the 0.99.14 rules (CIT-4, the default) show otherwise, on purpose: a whole
 * table cell or list item of citations is put into words; square brackets, a run at the end of a
 * parenthesis and a document ID in prose are new forms.
 */
const SHOWN_0_99_14: Record<string, string> = {
  "| 30 days | (contract.docx L12) |": "| 30 days | line 12 |",
  "- a\n- (L12)\n- b\n  1. (L3)\n* (L4)\n- (L5)": "- a\n- שורה 12\n- b\n  1. שורה 3\n* שורה 4\n- שורה 5",
  "As (see the table, L12) shows.": "As (see the table) shows.",
  "Due [L12] and [report.docx L12].": "Due and.",
  "A time (1312ms, L22776) with words.": "A time (1312ms) with words.",
  "The file (contract.docx) is named, and (see doc_contract) has words.": "The file (contract.docx) is named, and (see contract.docx) has words.",
};

describe("hideCitations", () => {
  it("takes the citations in parentheses out, with the space before them, in English and Hebrew", () => {
    for (const [written, shown] of HIDDEN) expect(hideCitations(written, NAMES), written).toBe(SHOWN_0_99_14[written] ?? shown);
  });

  it("keeps a parenthesis with other words in it, a citation outside parentheses, and an open parenthesis", () => {
    for (const written of KEPT) expect(hideCitations(written, NAMES), written).toBe(SHOWN_0_99_14[written] ?? written);
  });

  it("is the hider of 0.99.12, case for case, with rules: \"0.99.12\"", () => {
    for (const [written, shown] of HIDDEN) expect(hideCitations(written, NAMES, [], { rules: "0.99.12" }), written).toBe(shown);
    for (const written of KEPT) expect(hideCitations(written, NAMES, [], { rules: "0.99.12" }), written).toBe(written);
  });

  it("takes out the citations of a file name it was not given, when the name has a known extension", () => {
    expect(hideCitations("Due in 30 days (other.docx L12).")).toBe("Due in 30 days.");
    // A name without a known extension is words: the parenthesis stays.
    expect(hideCitations("Due in 30 days (other L12).")).toBe("Due in 30 days (other L12).");
  });

  it("takes out a citation that names the file by its document ID, as the tool guide shows it", () => {
    expect(hideCitations("Due in 45 days (contract-1 L3).", { "contract-1": "חוזה שירותי תחזוקה.docx" })).toBe("Due in 45 days.");
    // An ID too short, or without a letter, is not a name: ordinary words and numbers would match it.
    expect(hideCitations("Due (7 L3) and (ab L4).", { "7": "a.docx", ab: "b.docx" })).toBe("Due (7 L3) and (ab L4).");
  });

  it("gives a parenthesis that does not close within 200 characters back as it was written", () => {
    const long = `Before (contract.docx L12 ${"x".repeat(250)}) after.`;
    expect(hideCitations(long, NAMES)).toBe(long);
  });
});

describe("parentheses of document IDs alone", () => {
  const IDS = { "policy-1": "מדיניות משאבי אנוש 2026.docx", "contract-1": "חוזה.docx", "64f1a2b3c4d5e6f7a8b9c0d1": "x.pdf" };

  it("go: an ID alone, in backticks, or several, says nothing to the user", () => {
    expect(hideCitations("על פי מדיניות משאבי אנוש 2026 (policy-1):", IDS)).toBe("על פי מדיניות משאבי אנוש 2026:");
    // The comma between two groups that go goes with them (0.99.14; 0.99.12 left "Per, and.").
    expect(hideCitations("Per (`policy-1`), (policy-1, contract-1) and (policy-1 and contract-1).", IDS)).toBe("Per and.");
    expect(hideCitations("Per (`policy-1`), (policy-1, contract-1) and (policy-1 and contract-1).", IDS, [], { rules: "0.99.12" })).toBe("Per, and.");
    expect(hideCitations("Stored as (64f1a2b3c4d5e6f7a8b9c0d1).", IDS)).toBe("Stored as.");
    expect(hideCitations("**Policy (policy-1)**", IDS)).toBe("**Policy**");
  });

  it("stay when the ID is a word of the files, the file's name, too short, part of a longer word, or among other words", () => {
    expect(hideCitations("The form (policy-1) applies.", IDS, ["Form policy-1 applies to everyone."])).toBe("The form (policy-1) applies.");
    expect(hideCitations("The file (report.docx) and (report) stay.", { "report.docx": "report.docx", report: "report.docx" })).toBe("The file (report.docx) and (report) stay.");
    expect(hideCitations("Item (7) and (ab) stay.", { "7": "a.docx", ab: "b.docx" })).toBe("Item (7) and (ab) stay.");
    // An ID among other words: the parenthesis stays, and since 0.99.14 the ID is shown as its file's name.
    expect(hideCitations("Not (policy-12), nor (see policy-1).", IDS)).toBe("Not (policy-12), nor (see מדיניות משאבי אנוש 2026.docx).");
    expect(hideCitations("Not (policy-12), nor (see policy-1).", IDS, [], { rules: "0.99.12" })).toBe("Not (policy-12), nor (see policy-1).");
  });
});

describe("citation forms written in the files (CitationHider.addContent)", () => {
  const REPORT = ["4| Disc bulge at L4-L5, mild narrowing at L1.", "9| Support tiers: L2 and L3.", "12| Enter the total on line 12."];

  it("keeps a parenthesis with no file name whose form is written in the files the model read", () => {
    expect(hideCitations("Herniation at (L4–L5), and (L1) is fine.", NAMES, REPORT)).toBe("Herniation at (L4–L5), and (L1) is fine.");
    expect(hideCitations("Escalate to (L2) or (L3).", NAMES, REPORT)).toBe("Escalate to (L2) or (L3).");
    expect(hideCitations("Enter it on Form 1040 (line 12).", NAMES, REPORT)).toBe("Enter it on Form 1040 (line 12).");
    // Without the files' text, the same parentheses are citations. Right after "at", a place the
    // answer needs, the 0.99.14 rules put it in words; 0.99.12 took it out.
    expect(hideCitations("Herniation at (L4–L5), and (L1) is fine.", NAMES)).toBe("Herniation at lines 4–5, and is fine.");
    expect(hideCitations("Herniation at (L4–L5), and (L1) is fine.", NAMES, [], { rules: "0.99.12" })).toBe("Herniation at, and is fine.");
  });

  it("knows a range by itself or by both of its ends, whatever its dash, its case, or its \"L\" before the end", () => {
    for (const written of ["(L4-L5)", "(L4–L5)", "(L4־L5)", "(l4-5)", "(L4)", "(L5)"]) expect(hideCitations(`At ${written}.`, {}, ["Disc L4-L5."]), written).toBe(`At ${written}.`);
    expect(hideCitations("At (L4-L5).", {}, ["Disc L4 and disc L5."])).toBe("At (L4-L5).");
    expect(hideCitations("At (L4-L6).", {}, ["Disc L4-L5."])).toBe("At lines 4–6.");
    expect(hideCitations("At (L4-L6).", {}, ["Disc L4-L5."], { rules: "0.99.12" })).toBe("At.");
  });

  it("matches whole words only: \"XL2\" and \"L20\" in a file do not keep (L2)", () => {
    expect(hideCitations("Tier (L2) here.", {}, ["Sizes XL2 and L20, row L2x, and A-L2B."])).toBe("Tier here.");
    // The form counts: "line 2" in a file does not keep "(L2)", nor "L2" a "(line 2)".
    expect(hideCitations("At (L2) and (line 2).", {}, ["Read line 2."])).toBe("At line 2 and (line 2).");
    expect(hideCitations("At (L2) and (line 2).", {}, ["Read line 2."], { rules: "0.99.12" })).toBe("At and (line 2).");
  });

  it("does not read the library's own markers as the file's words (0.99.14): \"Row 8:\", \"12|\", headings, page markers", () => {
    const sheet = ["## Sheet 1: לקוחות\nColumns: | A | B |\nRow 1: | שם | עיר |\nRow 8: | דני כהן | אשדוד |"];
    expect(hideCitations("דני כהן גר באשדוד (Row 8).", { "customers-1": "לקוחות.xlsx" }, sheet)).toBe("דני כהן גר באשדוד.");
    // A read result: each line after its number ("40| Row 8: | … |").
    expect(hideCitations("The total is 40 (Row 8).", {}, ["39| Row 7: | a | 10 |\n40| Row 8: | total | 40 |"])).toBe("The total is 40.");
    // A word of the file stays: "Row 8" written in a cell.
    expect(hideCitations("See the note (Row 8).", {}, ["40| Row 3: | note | see Row 8 |"])).toBe("See the note (Row 8).");
    // 0.99.12 read "Row 8:" as a word of the file, and kept the citation.
    expect(hideCitations("דני כהן גר באשדוד (Row 8).", { "customers-1": "לקוחות.xlsx" }, sheet, { rules: "0.99.12" })).toBe("דני כהן גר באשדוד (Row 8).");
  });

  it("hides a citation that names a file, whatever the files say", () => {
    expect(hideCitations("The disc (contract.docx L4-L5).", NAMES, ["Disc L4-L5."])).toBe("The disc.");
  });

  it("reads the text of a tool result, but not its outline, its hint on how to cite, its notes or its errors", () => {
    const hider = new CitationHider(NAMES);
    hider.addToolResult({
      outline: ["L2 Introduction"], cite: "Cite the lines listed, like (contract.docx L3).", note: "Showing L4 of 9.", other_note: "L5", error: "L6",
      matches: [{ line: 40, text: "tier L7 support" }], text: "41| also L8",
    });
    const shown = hider.push("A (L2) B (L3) C (L4) D (L5) E (L6) F (L7) G (L8).") + hider.flush();
    expect(shown).toBe("A B C D E F (L7) G (L8).");
  });
});

describe("CitationHider", () => {
  const text = [...HIDDEN.map(([written]) => written), ...KEPT].join("\n");
  const whole = hideCitations(text, NAMES);

  it("shows the same text whatever pieces the answer comes in", () => {
    for (let size = 1; size <= 16; size++) {
      const hider = new CitationHider(NAMES);
      let shown = "";
      for (let at = 0; at < text.length; at += size) shown += hider.push(text.slice(at, at + size));
      expect(shown + hider.flush(), `pieces of ${size}`).toBe(whole);
    }
    // Pieces of every size at once, the same each run.
    let seed = 7;
    const hider = new CitationHider(NAMES);
    let shown = "";
    for (let at = 0; at < text.length;) {
      seed = (seed * 48_271) % 2_147_483_647;
      const size = 1 + (seed % 23);
      shown += hider.push(text.slice(at, at + size));
      at += size;
    }
    expect(shown + hider.flush()).toBe(whole);
  });

  it("never shows a part of a citation, and holds back no more than it must", () => {
    const hider = new CitationHider(NAMES);
    const shown: string[] = [];
    for (const char of "Due (contract.docx L12). Next") shown.push(hider.push(char));
    // Nothing of the citation was shown at any point.
    expect(shown.join("")).not.toContain("L12");
    expect(shown.join("")).not.toContain("(");
    // The text before it came at once, the space before "(" only once it was clear.
    expect(shown.slice(0, 3).join("")).toBe("Due");
    expect(shown.join("") + hider.flush()).toBe("Due. Next");
  });

  it("gives back what it holds when the answer ends", () => {
    const hider = new CitationHider(NAMES);
    expect(hider.push("Open (contract.docx L1")).toBe("Open");
    expect(hider.flush()).toBe(" (contract.docx L1");
    expect(hider.flush()).toBe("");
  });
});

describe("CitationCheck.cited", () => {
  const read = (documentId: string, document: string, lines: Array<[number, number]>): Evidence => ({ tool: "read_document", documentId, document, lines });

  it("lists every citation in order: its file, its lines, its form, and what was found", () => {
    const evidence = [read("doc_log", "app.log", [[90, 120]])];
    const names = { doc_log: "app.log", doc_db: "db.log", doc_book: "book.xlsx" };
    const text = "Errors at (app.log L95-L99) and (app.log L400); the database at (db.log L3); a row (book.xlsx Row 12).\nAnd one more (L7).";
    expect(checkCitations(text, evidence, names, { doc_book: "xlsx" }).cited).toEqual([
      { document: "app.log", documentId: "doc_log", from: 95, to: 99, form: "line", status: "supported" },
      { document: "app.log", documentId: "doc_log", from: 400, to: 400, form: "line", status: "unsupported" },
      { document: "db.log", documentId: "doc_db", from: 3, to: 3, form: "line", status: "unsupported" },
      // A row of a workbook may be Excel's row: unchecked, with its file.
      { document: "book.xlsx", documentId: "doc_book", from: 12, to: 12, form: "row", status: "unchecked" },
      // No file name, and three files: unchecked, with none.
      { from: 7, to: 7, form: "line", status: "unchecked" },
    ]);
  });

  it("names the file of two of one name that shows the lines", () => {
    const evidence = [read("first", "app.log", [[1, 10]]), read("second", "app.log", [[50, 60]])];
    const { cited } = checkCitations("At (app.log L55) and (app.log L99).", evidence, { first: "app.log", second: "app.log" });
    expect(cited).toEqual([
      { document: "app.log", documentId: "second", from: 55, to: 55, form: "line", status: "supported" },
      { document: "app.log", documentId: "first", from: 99, to: 99, form: "line", status: "unsupported" },
    ]);
  });

  it("is empty for an answer without citations", () => {
    expect(checkCitations("Nothing cited.", [], NAMES).cited).toEqual([]);
  });
});

/** A model that streams `text` in pieces of `size` characters: a citation is cut in the middle. */
function streaming(text: string, size: number): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: "streaming",
    capabilities: { toolFiles: "none", pageTokens: 500 },
    requests,
    async send(request, hooks = {}): Promise<ModelReply> {
      requests.push(request);
      if (hooks.onText) for (let at = 0; at < text.length; at += size) hooks.onText(text.slice(at, at + size));
      return { text, calls: [], finish: "complete" };
    },
  };
}

describe("AskOptions.showCitations", () => {
  const NOTE = "# Notes\n\nThe code word is heron.\nThe nightly import runs at 02:00 UTC.\n";
  const ANSWER = "## The code word (notes.md L3)\nThe code word is heron (notes.md L3), and the import runs at 02:00 (L4).";
  const SHOWN = "## The code word\nThe code word is heron, and the import runs at 02:00.";

  async function noteLibrary() {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    return { files, meta };
  }

  it("false: shows the answer without its citations, as it streams, and still checks and lists them", async () => {
    const { files, meta } = await noteLibrary();
    for (const size of [1, 3, 7, 1_000]) {
      const model = streaming(ANSWER, size);
      const deltas: string[] = [];
      const texts: string[] = [];
      const result = await askWithFiles({
        files, model, documentIds: [meta.id], messages: question("What is the code word?"), showCitations: false,
        onText: (delta) => deltas.push(delta),
        onEvent: (event) => { if (event.type === "text") texts.push(event.delta); },
      });
      expect(deltas.join(""), `pieces of ${size}`).toBe(SHOWN);
      expect(texts.join("")).toBe(SHOWN);
      expect(deltas.every((delta) => !delta.includes("L3") && !delta.includes("("))).toBe(true);
      expect(result.text).toBe(SHOWN);
      expect(result.answered).toBe(true);
      // Read from the answer as the model wrote it.
      expect(result.citations).toEqual({
        checked: 3, supported: 3, unchecked: 0, unsupported: [],
        cited: [
          { document: "notes.md", documentId: meta.id, from: 3, to: 3, form: "line", status: "supported" },
          { document: "notes.md", documentId: meta.id, from: 3, to: 3, form: "line", status: "supported" },
          { document: "notes.md", documentId: meta.id, from: 4, to: 4, form: "line", status: "supported" },
        ],
      });
    }
  });

  it("asks the model for citations as the default does: the requests are the same", async () => {
    const { files, meta } = await noteLibrary();
    const hidden = streaming(ANSWER, 5);
    const shown = streaming(ANSWER, 5);
    await askWithFiles({ files, model: hidden, documentIds: [meta.id], messages: question("?"), showCitations: false });
    const result = await askWithFiles({ files, model: shown, documentIds: [meta.id], messages: question("?") });
    expect(hidden.requests).toEqual(shown.requests);
    // The default shows the answer as the model wrote it.
    expect(result.text).toBe(ANSWER);
    const asTrue = await askWithFiles({ files, model: streaming(ANSWER, 5), documentIds: [meta.id], messages: question("?"), showCitations: true });
    expect(asTrue.text).toBe(ANSWER);
  });

  it("false: streams, at every piece size, exactly the text of the result, with emphasis, list items and code around citations", async () => {
    const { files, meta } = await noteLibrary();
    const answer = "## The word **(L3)**\n- (notes.md L3)\n- The word is heron (L3).\n**(L4)** The import\nCall `run(L4)` at 02:00 (`notes.md` L4).";
    // A list item of nothing but citations is put into words (0.99.14).
    const shown = "## The word\n- line 3\n- The word is heron.\nThe import\nCall `run(L4)` at 02:00.";
    for (let size = 1; size <= 16; size++) {
      const deltas: string[] = [];
      const result = await askWithFiles({ files, model: streaming(answer, size), documentIds: [meta.id], messages: question("?"), showCitations: false, onText: (delta) => deltas.push(delta) });
      expect(deltas.join(""), `pieces of ${size}`).toBe(result.text);
      // Pieces are never taken back: their sum being the result means no piece held a part of what went.
      expect(result.text, `pieces of ${size}`).toBe(shown);
    }
  });

  it("false: keeps a citation form that is written in a file sent whole, or in what a tool showed", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const report = await files.ingest({ name: "mri.md", bytes: utf8("# MRI\n\nDisc bulge at L4-L5.\nNo change at L1.\n") });
    const whole = await askWithFiles({ files, model: fakeModel([says("A bulge at (L4–L5) (mri.md L3), none at (L1) (L6).")]), documentIds: [report.id], messages: question("?"), showCitations: false });
    // "L4-L5" and "L1" are words of the report; "(mri.md L3)" names the file, and "L6" is no word of it.
    expect(whole.text).toBe("A bulge at (L4–L5), none at (L1).");
    expect(whole.citations?.checked).toBe(4);

    const log = await files.ingest({ name: "support.log", bytes: utf8(Array.from({ length: 3_000 }, (_, at) => (at === 1_499 ? "2026-11-12 escalated to tier L2 support" : `2026-11-12 line ${at + 1} ok`)).join("\n")) });
    const search = { id: "c1", name: "search_document", args: { document_id: log.id, query: "tier", mode: "exact" } };
    const searched = await askWithFiles({ files, model: fakeModel([calls([search]), says("Escalated to (L2) (support.log L1500), at (L1500).")]), documentIds: [log.id], messages: question("?"), showCitations: false });
    // Right after "at", the place is put into words (0.99.14).
    expect(searched.text).toBe("Escalated to (L2), at line 1500.");
  });

  it("false: hides a document ID alone, though the frame of a table sent whole names it, and keeps one written in a file", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const sheet = await files.ingest({ name: "sales.csv", id: "sales-1", bytes: utf8("Region,Amount\nEast,10\nWest,20\n") });
    const model = fakeModel([says("Per the sheet (sales-1), East sold 10 (sales.csv L2).")]);
    const result = await askWithFiles({ files, model, documentIds: [sheet.id], messages: question("?"), showCitations: false });
    // The table gets the tools, so its frame says its document_id: that is the library's text, not the file's.
    expect(JSON.stringify(model.requests[0]!.messages)).toContain("document_id sales-1");
    expect(result.text).toBe("Per the sheet, East sold 10.");

    const forms = await files.ingest({ name: "forms.md", id: "form-7", bytes: utf8("# Forms\n\nUse form-7 for travel.\n") });
    const kept = await askWithFiles({ files, model: fakeModel([says("Use the travel form (form-7).")]), documentIds: [forms.id], messages: question("?"), showCitations: false });
    expect(kept.text).toBe("Use the travel form (form-7).");
  });

  it("false: works through askGemini, over a streamed reply", async () => {
    const { files, meta } = await noteLibrary();
    const encoder = new TextEncoder();
    const pieces = ["## The word **(L", "3)**\n- (notes", ".md L3)\nThe word is heron (`notes.md` L", "3)."];
    const fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: piece }] } }] })}\r\n\r\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }] })}\r\n\r\n`));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const deltas: string[] = [];
    const result = await askGemini({ files, endpoint: geminiApi({ apiKey: "test-key", model: "gemini-test" }), fetch, documentIds: [meta.id], messages: question("?"), showCitations: false, onText: (delta) => deltas.push(delta) });
    expect(result.text).toBe("## The word\n- line 3\nThe word is heron.");
    expect(deltas.join("")).toBe(result.text);
    expect(result.citations?.cited?.length).toBe(3);
  });

  it("false: hides them in a reply that was not streamed too", async () => {
    const { files, meta } = await noteLibrary();
    const result = await askWithFiles({ files, model: fakeModel([says(ANSWER)]), documentIds: [meta.id], messages: question("?"), showCitations: false });
    expect(result.text).toBe(SHOWN);
  });

  it("false: hides them in a remark before a tool call and in the answer after it, through askStream", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    const search = { id: "c1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact", max_results: 3 } };
    const model = fakeModel([calls([search], { text: "Checking (app.log L1)." }), says("51 errors, the first at (app.log L97).")]);
    const run = askStream({ files, model, documentIds: [log.id], messages: question("How many errors?"), showCitations: false });
    const texts: string[] = [];
    for await (const event of run as AsyncIterable<AskEvent>) if (event.type === "text") texts.push(event.delta);
    const result = await run.result;
    expect(texts.join("")).toBe("Checking.\n\n51 errors, the first at line 97.");
    expect(result.text).toBe("Checking.\n\n51 errors, the first at line 97.");
    expect(result.citations?.cited?.map((one) => [one.from, one.status])).toEqual([[1, "unsupported"], [97, "supported"]]);
  });

  it("is a TypeError before any request when it is not true or false", async () => {
    const { files, meta } = await noteLibrary();
    const model = fakeModel([says("Heron.")]);
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), showCitations: "no" as unknown as boolean })).rejects.toThrow(new TypeError('showCitations must be true or false, and is "no".'));
    expect(model.requests).toHaveLength(0);
  });

  it("changes nothing in a question without documents", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const result = await askWithFiles({ files, model: fakeModel([says("A cache (L2) is small.")]), documentIds: [], messages: question("?"), showCitations: false });
    expect(result.text).toBe("A cache (L2) is small.");
  });
});
