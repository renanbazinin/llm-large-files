// The eval `rows` fact (0.99.13): a correct number told with a wrong sheet row fails. Flash's
// recorded sales-hebrew answer gave East's sum and count right, and named its rows as 55, 108 and
// 161, the text lines of Excel rows 53, 106 and 159: no fact caught it, since a number fact matches
// any number of the answer. And `failsOn`, the models whose recorded answer is known to fail a case.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { fakeFetch, sse, utf8 } from "llm-large-files/testing";
import { evalCases, type EvalCase } from "../evals/cases.js";
import { buildFixtures, type EvalFacts, type EvalLibrary } from "../evals/fixtures.js";
import { checkFact, describeFact, rowsNamed, type Fact, type FactContext } from "../evals/lib/facts.js";
import { gateProblems } from "../evals/lib/gate.js";
import { markdown } from "../evals/lib/report.js";
import { runCase, type CaseRun } from "../evals/lib/runner.js";

const folders: string[] = [];
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** East's Excel rows in the sales workbook: every 53rd, from 53 to 1166. */
const EAST = Array.from({ length: 22 }, (_, index) => 53 * (index + 1));
const salesRows: Fact = { rows: { document: "sales-1", valid: EAST } };
/** The text the model reads of a workbook: a sheet line and a header line, then "Row N:" on line N + 2. */
const context: FactContext = {
  evidence: [],
  names: { "sales-1": "sales-2026.xlsx" },
  formats: { "sales-1": "xlsx" },
  linesWith: (id, phrase) => {
    const row = id === "sales-1" ? /^Row (\d+):$/.exec(phrase)?.[1] : undefined;
    return row !== undefined && Number(row) >= 2 && Number(row) <= 1200 ? [Number(row) + 2] : [];
  },
};
const status = (fact: Fact, text: string) => checkFact(fact, text, context).status;

describe("the rows fact", () => {
  it("holds the 6 synthetic controls: right rows pass, text lines fail, line citations and no row are not read", () => {
    const controls: Array<[string, "pass" | "fail"]> = [
      ["22 שורות (לדוגמה: שורה 53, 106, 159).", "pass"],
      ["22 rows, e.g. rows 53, 106 and 159.", "pass"],
      ["22 שורות (לדוגמה: שורות 55, 108 ו-161).", "fail"],
      ["22 rows (sales-2026.xlsx L55, L108, L161).", "pass"],
      ["22 שורות.", "pass"],
      ["Rows 53–106 hold East.", "pass"],
    ];
    expect(controls.map(([text]) => status(salesRows, text))).toEqual(controls.map(([, want]) => want));
  });

  it("reads Row N, שורה N, שורות N-M and the list that follows, in the answer as its facts read it", () => {
    expect(rowsNamed("**Row 32** (שורה 32 בגיליון)")).toEqual([32, 32]);
    expect(rowsNamed("שורה 55, 108, 161")).toEqual([55, 108, 161]);
    expect(rowsNamed("בשורות 5, 7 ו-9, ובשורה מס' 12; ושורות 20־24")).toEqual([5, 7, 9, 12, 20, 24]);
    expect(rowsNamed("rows 53 and 106, row 159 to 212")).toEqual([53, 106, 159, 212]);
    // A count before "rows", a line citation, and a row word with no number name no row.
    expect(rowsNamed("22 rows, 22 שורות (sales-2026.xlsx L55), the header row, שורת הכותרת 1")).toEqual([]);
    // A number that is part of a longer word is not a row.
    expect(rowsNamed("Rows 5x and row 7")).toEqual([7]);
  });

  it("says which wrong row is the text line of a right one, and names the fact by its rows", () => {
    expect(checkFact(salesRows, "שורה 55, 108 ושורה 400", context)).toEqual({
      fact: "names only rows 53, 106, 159 … 1166 (22 rows) of sales-1",
      status: "fail",
      detail: "row 55 is text line 55, Excel row 53; row 108 is text line 108, Excel row 106; row 400 is not a row of the answer",
    });
    expect(describeFact({ rows: { document: "budget-1", valid: [1] } })).toBe("names only row 1 of budget-1");
    expect(describeFact({ rows: { document: "budget-1", valid: [31, 32] } })).toBe("names only rows 31, 32 of budget-1");
  });

  it("is on the five cases, with East's rows taken from the fixture, and failsOn names the two answers it fails", async () => {
    const { facts } = await buildFixtures();
    expect(facts.sales.east.rows).toEqual(EAST);
    const cases = evalCases(facts as EvalFacts);
    const rowsFacts = Object.fromEntries(cases.flatMap((one) => one.turns.flatMap((turn) => turn.facts.flatMap((fact) => ("rows" in fact ? [[one.id, fact.rows]] : [])))));
    expect(rowsFacts).toEqual({
      "budget-which-row": { document: "budget-1", valid: [32] },
      "sales-east": { document: "sales-1", valid: EAST },
      "sales-east-searched": { document: "sales-1", valid: EAST },
      "sales-hebrew": { document: "sales-1", valid: EAST },
      "budget-units": { document: "budget-1", valid: [1] },
    });
    expect(Object.fromEntries(cases.filter((one) => one.failsOn).map((one) => [one.id, Object.keys(one.failsOn!)]))).toEqual({
      "sales-hebrew": ["gemini-3.8-flash"],
      "budget-units": ["gemini-3.5-flash-lite"],
    });
  });
});

describe("failsOn", () => {
  const question = { turn: 1, answered: true, facts: [{ fact: "says heron", status: "fail" as const }], passed: false, requests: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, thoughtTokens: 0, ms: 1, ceilingReached: false, citations: null, tools: [], wholeReads: 0, log: [] };
  const failed = (model: string): CaseRun => ({ case: "c", model, mode: "live", run: 1, language: "en", kinds: ["lookup"], questions: [question], passed: false });
  const known: EvalCase = { id: "c", language: "en", kinds: ["lookup"], turns: [{ question: "?", documentIds: [], facts: [{ says: "heron" }] }], failsOn: { "gemini-a": "It names a text line." } };

  it("keeps a live run of a listed model from failing pass^k, and only that model's", () => {
    expect(gateProblems(known, [failed("gemini-a")])).toEqual([]);
    expect(gateProblems(known, [failed("gemini-b")])).toEqual([expect.stringMatching(/^pass\^1 missed/)]);
    expect(markdown({ title: "T", notes: [], runs: [] }, [known])).toContain("- **c** on gemini-a: It names a text line.");
  });

  it("fails the replay of a listed model whose recorded answer passes: the entry is stale", async () => {
    const cassettes = mkdtempSync(path.join(tmpdir(), "llf-cassette-"));
    folders.push(cassettes);
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.\n"), id: "notes-1" });
    const library: EvalLibrary = { files, facts: {} as EvalLibrary["facts"], names: { "notes-1": "notes.md" }, formats: { "notes-1": "markdown" }, linesWith: () => [], budgetRowLine: 0 };
    const tiny: EvalCase = { id: "tiny", language: "en", kinds: ["lookup"], turns: [{ question: "What is the code word?", documentIds: ["notes-1"], facts: [{ says: "heron" }] }] };
    const answer = fakeFetch([sse([{ candidates: [{ content: { role: "model", parts: [{ text: "The code word is heron." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 6, totalTokenCount: 706 } }])]);
    const shared = { model: "gemini-test", library, cassettes };
    await runCase({ ...shared, mode: "record", evalCase: tiny, apiKey: "test-key", fetch: answer.fetch });
    expect((await runCase({ ...shared, mode: "replay", evalCase: { ...tiny, failsOn: { "gemini-other": "elsewhere" } } })).replayProblems).toEqual([]);
    expect((await runCase({ ...shared, mode: "replay", evalCase: { ...tiny, failsOn: { "gemini-test": "It used to fail." } } })).replayProblems).toEqual([
      'known to fail, and passes: case "gemini-test/tiny" is in failsOn for gemini-test, and its recorded answer passes every fact. Take it out of failsOn in evals/cases.ts.',
    ]);
  });
});
