// S3 (0.10.0): the line citations of an answer, checked against what the tools showed
// (`checkCitations`, `AskResult.citations`), Hebrew forms included.
import { describe, expect, it } from "vitest";
import { askWithFiles, checkCitations, createLargeFiles, MemoryDocumentStore, type Evidence } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const read = (documentId: string, document: string, lines: Array<[number, number]>): Evidence => ({ tool: "read_document", documentId, document, lines });

describe("checkCitations", () => {
  const names = { "doc_log": "app.log", "doc_db": "db.log" };
  const evidence = [read("doc_log", "app.log", [[90, 120]]), read("doc_db", "db.log", [[1, 40]])];

  it("tells citations of lines that were shown from those that were not", () => {
    const text = "The first error is at (app.log L97), and the database failed at (db.log L12). The retry is at (app.log L400).";
    expect(checkCitations(text, evidence, names)).toEqual({ checked: 3, supported: 2, unchecked: 0, unsupported: [{ document: "app.log", line: 400 }] });
  });

  it("reads ranges, lists in one pair of parentheses, and a name before the line", () => {
    const text = "See (app.log L95-110, L118) and db.log L39-41; also app.log line 100 and (app.log L97–L99).";
    expect(checkCitations(text, evidence, names)).toEqual({ checked: 5, supported: 4, unchecked: 0, unsupported: [{ document: "db.log", line: 41 }] });
  });

  it("reads a line number written with commas between groups of three as one number", () => {
    const big = [read("doc_log", "app.log", [[1_150, 1_250]])];
    const names1 = { "doc_log": "app.log" };
    // 0.10.0 read "L1,200" as line 1.
    expect(checkCitations("The timeout is at (app.log L1,200), the retry at (app.log line 1,240-1,245).", big, names1)).toEqual({ checked: 2, supported: 2, unchecked: 0, unsupported: [] });
    expect(checkCitations("Then (app.log L12,345,678).", big, names1)).toEqual({ checked: 1, supported: 0, unchecked: 0, unsupported: [{ document: "app.log", line: 12_345_678 }] });
    expect(checkCitations("בשורה 1,200 של app.log", big, names1)).toEqual({ checked: 1, supported: 1, unchecked: 0, unsupported: [] });
    // A group has three digits: "L1,20" is line 1, then something else.
    expect(checkCitations("(app.log L1,20)", big, names1)).toEqual({ checked: 1, supported: 0, unchecked: 0, unsupported: [{ document: "app.log", line: 1 }] });
  });

  it("counts a citation with no file name as unchecked when there are several files, and as the file's when there is one", () => {
    expect(checkCitations("It failed (L97).", evidence, names)).toEqual({ checked: 0, supported: 0, unchecked: 1, unsupported: [] });
    expect(checkCitations("It failed (L97), then (L500).", [evidence[0]!], { "doc_log": "app.log" })).toEqual({ checked: 2, supported: 1, unchecked: 0, unsupported: [{ document: "app.log", line: 500 }] });
    // A bare "L2" outside parentheses, with no file name next to it, is no citation.
    expect(checkCitations("The L2 cache was full.", [evidence[0]!], { "doc_log": "app.log" })).toEqual({ checked: 0, supported: 0, unchecked: 0, unsupported: [] });
  });

  it("matches two files of one name by either", () => {
    const twins = { "doc_a": "report.docx", "doc_b": "report.docx" };
    const shown = [read("doc_a", "report.docx", [[1, 10]]), read("doc_b", "report.docx", [[50, 60]])];
    expect(checkCitations("(report.docx L5) and (report.docx L55) and (report.docx L30)", shown, twins)).toEqual({ checked: 3, supported: 2, unchecked: 0, unsupported: [{ document: "report.docx", line: 30 }] });
  });

  it("counts a file read or sent whole as shown, every line of it, and no line past its end", () => {
    const whole: Evidence[] = [{ tool: "inline", documentId: "doc_log", document: "app.log", whole: true }];
    expect(checkCitations("(app.log L4000)", whole, { "doc_log": "app.log" })).toEqual({ checked: 1, supported: 1, unchecked: 0, unsupported: [] });
    // With its lines, as P1's evidence of a file sent whole has them: a line the file does not have is not supported.
    const counted: Evidence[] = [{ tool: "inline", documentId: "doc_n", document: "notes.md", lines: [[1, 3]], whole: true }];
    expect(checkCitations("(notes.md L3) and (notes.md L4000)", counted, { "doc_n": "notes.md" })).toEqual({ checked: 2, supported: 1, unchecked: 0, unsupported: [{ document: "notes.md", line: 4000 }] });
  });

  it("binds a citation to the nearer name, before or after it, across no comma or \"and\"", () => {
    const hebrewNames = { "doc_c": "חוזה.docx", "doc_i": "חשבוניות.csv" };
    // The contract showed lines 10-20 and the invoices lines 35-45: every citation below is right.
    const shown = [read("doc_c", "חוזה.docx", [[10, 20]]), read("doc_i", "חשבוניות.csv", [[35, 45]])];
    const right = { checked: 2, supported: 2, unchecked: 0, unsupported: [] };
    // The line, then its file: before this, line 40 was checked against the contract.
    expect(checkCitations("התשלום נקבע בשורה 12 בקובץ חוזה.docx, והאיחור מופיע בשורה 40 בקובץ חשבוניות.csv.", shown, hebrewNames)).toEqual(right);
    expect(checkCitations("(שורה 12 בחוזה.docx, שורה 40 בחשבוניות.csv)", shown, hebrewNames)).toEqual(right);
    expect(checkCitations("(L12 חוזה.docx, L40 חשבוניות.csv)", shown, hebrewNames)).toEqual(right);
    expect(checkCitations("שורה 12 בחוזה.docx ושורה 40 בחשבוניות.csv", shown, hebrewNames)).toEqual(right);
    // The file, then its line.
    expect(checkCitations("התשלום נקבע בחוזה.docx בשורה 12, והאיחור מופיע בחשבוניות.csv בשורה 40.", shown, hebrewNames)).toEqual(right);
    // In English, both ways.
    expect(checkCitations("app.log L97 and db.log L12", evidence, names)).toMatchObject({ checked: 2, supported: 2 });
    expect(checkCitations("See lines 95 to 99 of app.log, and line 12 of db.log.", evidence, names)).toMatchObject({ checked: 2, supported: 2 });
    expect(checkCitations("app.log: line 97; db.log: line 12", evidence, names)).toMatchObject({ checked: 2, supported: 2 });
  });

  it("gives a citation right after \"name, \" to that name, unless a name after it is introduced as its own", () => {
    const both = { "doc_c": "חוזה.docx", "doc_i": "חשבוניות.csv" };
    const shown = [read("doc_c", "חוזה.docx", [[10, 20]]), read("doc_i", "חשבוניות.csv", [[35, 45]])];
    const one = { checked: 1, supported: 1, unchecked: 0, unsupported: [] };
    // Before this, both went with the second name, which had not shown those lines.
    expect(checkCitations("In app.log, line 97 shows the timeout that db.log reports.", evidence, names)).toEqual(one);
    expect(checkCitations("לפי חוזה.docx, שורה 12 סותרת את חשבוניות.csv.", shown, both)).toEqual(one);
    // Introduced: the name after.
    expect(checkCitations("ראו חוזה.docx, שורה 40 בקובץ חשבוניות.csv.", shown, both)).toEqual(one);
    expect(checkCitations("ראו חוזה.docx, שורה 40 בחשבוניות.csv.", shown, both)).toEqual(one);
    expect(checkCitations("See app.log, line 12 of db.log.", evidence, names)).toEqual(one);
  });

  it("reads citations with Hebrew points, marks of direction, a maqaf range, and \"L 97\" or \"l97\"", () => {
    const both = { "doc_c": "חוזה.docx", "doc_log": "app.log" };
    const shown = [read("doc_c", "חוזה.docx", [[10, 20]]), read("doc_log", "app.log", [[90, 120]])];
    // Each was not read at all before this, neither checked nor unchecked.
    expect(checkCitations("לפי חוזה.docx, שׁוּרָה 12, השוכר משלם.", shown, both)).toEqual({ checked: 1, supported: 1, unchecked: 0, unsupported: [] });
    expect(checkCitations("ראו חוזה.docx שורה‏ 12.", shown, both)).toEqual({ checked: 1, supported: 1, unchecked: 0, unsupported: [] });
    expect(checkCitations("(app.log L 97) (app.log l98) (‎app.log‎ L99)", shown, both)).toEqual({ checked: 3, supported: 3, unchecked: 0, unsupported: [] });
    // A range with a maqaf is the whole range: before this, it was read as line 12 alone.
    expect(checkCitations("ראו חוזה.docx שורות 12־30.", shown, both)).toEqual({ checked: 1, supported: 0, unchecked: 0, unsupported: [{ document: "חוזה.docx", line: 21 }] });
  });

  it("reads the Hebrew forms in a Hebrew sentence, with a prefix letter, before or after the file name", () => {
    const hebrewNames = { "doc_c": "חוזה.docx", "doc_i": "חשבוניות.csv" };
    const shown = [read("doc_c", "חוזה.docx", [[10, 20]]), read("doc_i", "חשבוניות.csv", [[1, 100]])];
    const text = "לפי חוזה.docx, שורה 12, השוכר משלם 4,167.90 ש\"ח. החשבוניות באיחור מופיעות בחשבוניות.csv בשורות 40-45, והסכום הכולל בשורה 250 של חשבוניות.csv. ראו גם (חוזה.docx שורות 18–22).";
    expect(checkCitations(text, shown, hebrewNames)).toEqual({ checked: 4, supported: 2, unchecked: 0, unsupported: [{ document: "חשבוניות.csv", line: 250 }, { document: "חוזה.docx", line: 21 }] });
  });

  it("counts a row of a workbook as unchecked, and its L citations as lines", () => {
    const sheet = { "doc_x": "sales.xlsx" };
    const shown = [read("doc_x", "sales.xlsx", [[1, 30]])];
    const formats = { "doc_x": "xlsx" as const };
    expect(checkCitations("The total is in sales.xlsx, Row 12, and in (sales.xlsx L12).", shown, sheet, formats)).toEqual({ checked: 1, supported: 1, unchecked: 1, unsupported: [] });
    expect(checkCitations("הסכום מופיע ב-sales.xlsx בשורה 12.", shown, sheet, formats)).toEqual({ checked: 0, supported: 0, unchecked: 1, unsupported: [] });
    // Of a CSV, a row is a line.
    expect(checkCitations("sales.csv Row 12", [read("doc_s", "sales.csv", [[1, 30]])], { "doc_s": "sales.csv" }, { "doc_s": "csv" })).toMatchObject({ checked: 1, supported: 1 });
  });

  it("finds nothing in a text without citations, and takes the names of evidence it was not given", () => {
    expect(checkCitations("There are 51 errors.", evidence, names)).toEqual({ checked: 0, supported: 0, unchecked: 0, unsupported: [] });
    expect(checkCitations("", evidence, names)).toEqual({ checked: 0, supported: 0, unchecked: 0, unsupported: [] });
    expect(checkCitations("(app.log L97) (db.log L3)", evidence, {})).toMatchObject({ checked: 2, supported: 2 });
    // A part of a file name is no citation.
    expect(checkCitations("(report-L3.docx L5)", [read("doc_r", "report-L3.docx", [[1, 9]])], { "doc_r": "report-L3.docx" })).toEqual({ checked: 1, supported: 1, unchecked: 0, unsupported: [] });
  });
});

describe("AskResult.citations", () => {
  it("checks the answer's citations against the evidence of the question, a file sent whole as shown", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    const note = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe nightly import runs at 02:00 UTC.\n") });
    const model = fakeModel([
      calls([{ id: "r", name: "read_document", args: { document_id: log.id, start_line: 90, end_line: 100 } }]),
      says("The first error is at (app.log L97), the import at (notes.md L3), and another at (app.log L194)."),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [log.id, note.id], messages: [{ role: "user", text: "When did it fail?" }] });
    expect(result.citations).toEqual({ checked: 3, supported: 2, unchecked: 0, unsupported: [{ document: "app.log", line: 194 }] });
    // The run's end carries it too.
    const events: unknown[] = [];
    await askWithFiles({ files, model: fakeModel([says("Nothing cited.")]), documentIds: [note.id], messages: [{ role: "user", text: "?" }], onEvent: (event) => events.push(event) });
    expect(events.at(-1)).toMatchObject({ type: "run.finish", result: { citations: { checked: 0, supported: 0, unchecked: 0, unsupported: [] } } });
  });

  it("does not support a line past the end of a file sent whole or read whole", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, mapChunkTokens: 8_000 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(1_500)) });
    const note = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe nightly import runs at 02:00 UTC.\n") });
    const model = fakeModel([
      calls([{ id: "a", name: "analyze_whole_document", args: { document_id: log.id, task: "errors" } }]),
      says(`The import (notes.md L3), not (notes.md L${note.lines + 40}); errors at (app.log L97) and (app.log L${log.lines + 1}).`),
    ], { generateText: async () => "Notes (L97)." });
    const result = await askWithFiles({ files, model, documentIds: [log.id, note.id], messages: [{ role: "user", text: "When?" }] });
    // The file sent whole first, with every line (since 0.10.0), then the whole-file read.
    expect(result.evidence).toEqual([
      { tool: "inline", documentId: note.id, document: "notes.md", lines: [[1, note.lines]], whole: true },
      expect.objectContaining({ tool: "analyze_whole_document", whole: true }),
    ]);
    // The evidence of the read is as it was: its lines are the check's own.
    expect(result.evidence[1]).not.toHaveProperty("lines");
    expect(result.citations).toEqual({ checked: 4, supported: 2, unchecked: 0, unsupported: [{ document: "notes.md", line: note.lines + 40 }, { document: "app.log", line: log.lines + 1 }] });
  });

  it("is absent for a question without documents", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const result = await askWithFiles({ files, model: fakeModel([says("Hello (L1).")]), documentIds: [], messages: [{ role: "user", text: "Hi" }] });
    expect(result).not.toHaveProperty("citations");
  });
});
