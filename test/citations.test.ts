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

  it("counts a file read or sent whole as shown, every line of it", () => {
    const whole: Evidence[] = [{ tool: "inline", documentId: "doc_log", document: "app.log", whole: true }];
    expect(checkCitations("(app.log L4000)", whole, { "doc_log": "app.log" })).toEqual({ checked: 1, supported: 1, unchecked: 0, unsupported: [] });
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
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
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

  it("is absent for a question without documents", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const result = await askWithFiles({ files, model: fakeModel([says("Hello (L1).")]), documentIds: [], messages: [{ role: "user", text: "Hi" }] });
    expect(result).not.toHaveProperty("citations");
  });
});
