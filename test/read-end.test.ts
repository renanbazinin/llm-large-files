// read_document with a start_line past the end of the file (READ-END, 0.99.13, decision 11). Until
// 0.99.13 it was clamped to the last line: in a sparse workbook, "Row 400" passed as a line read the
// last row of a hidden sheet, with no error. It is now refused, as search_document refuses a
// from_line past the end, and a workbook's error says which line holds the row asked for and each
// sheet's rows and lines. Those name the sheets: events, steps and SSE get only the first sentence
// (principle 9, as aggregate_table's column errors).
import { describe, expect, it } from "vitest";
import { askStream, createLargeFiles, MemoryDocumentStore, type AskEvent, type ModelRequest } from "llm-large-files";
import { writeSseEvents } from "llm-large-files/node";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";
import { fakeResponse } from "./privacy-fixtures.js";
import { REL, RELS, S, zip } from "./xlsx-fixtures.js";

type Sheet = { name: string; hidden?: boolean; rows: Array<[number, Array<string | number>]> };
const esc = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const column = (n: number) => String.fromCharCode(64 + n);
/** A workbook of these sheets, each row at its own row number (specs/05-quick-fixes, F4). */
function book(sheets: Sheet[]): Promise<Uint8Array> {
  return zip({
    "xl/workbook.xml": `<workbook ${S}><sheets>${sheets.map((sheet, i) => `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"${sheet.hidden ? ' state="hidden"' : ""}/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships ${RELS}>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    ...Object.fromEntries(sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, `<worksheet ${S}><sheetData>${sheet.rows.map(([row, cells]) => `<row r="${row}">${cells.map((value, c) => typeof value === "number"
      ? `<c r="${column(c + 1)}${row}"><v>${value}</v></c>`
      : `<c r="${column(c + 1)}${row}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`])),
  });
}

const SPARSE: Sheet["rows"] = [[1, ["מלאי מחסן"]], [3, ["מק\"ט", "תיאור", "כמות"]], [10, ["A-17", "ברגים", 400]], [57, ["B-2", "דיבלים", 1200]], [58, ["", "", ""]], [400, ["C-9", "מסמרים", 75]], [1048, ["D-1", "אומים", 9]]];
const LOG = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

async function library() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  const workbook = await files.ingest({ id: "f4-sparse", name: "מלאי.xlsx", bytes: await book([{ name: "מלאי", rows: SPARSE }, { name: "ישן", hidden: true, rows: [[1, ["legacy"]], [8, ["x", 1]]] }]) });
  const log = await files.ingest({ id: "log-1", name: "app.log", bytes: utf8(LOG) });
  return { files, workbook, log, tools: files.tools([workbook, log]) };
}

describe("read_document past the end of the file", () => {
  it("refuses a workbook's start_line past its 13 lines, naming the line of Row 400 and each sheet's rows and lines", async () => {
    const { workbook, tools } = await library();
    expect(workbook.lines).toBe(13);
    expect(await tools.execute("read_document", { document_id: workbook.id, start_line: 400 })).toEqual({
      error: 'start_line 400 is past the end of the file, which has 13 lines. A line of a workbook is not its row: Row 400 is on line 7 (sheet "מלאי"). Its sheets: sheet "מלאי", rows 1–1048 on lines 3–8; sheet "ישן", rows 1–8 on lines 12–13.',
    });
    // A start sent as text is read the same way.
    expect(await tools.execute("read_document", { document_id: workbook.id, start_line: "400" })).toMatchObject({ error: expect.stringContaining("Row 400 is on line 7") });
  });

  it("refuses the line after the last, and reads the last line as before", async () => {
    const { workbook, tools } = await library();
    expect(await tools.execute("read_document", { document_id: workbook.id, start_line: 14 })).toEqual({
      error: 'start_line 14 is past the end of the file, which has 13 lines. A line of a workbook is not its row: no sheet has a Row 14. Its sheets: sheet "מלאי", rows 1–1048 on lines 3–8; sheet "ישן", rows 1–8 on lines 12–13.',
    });
    expect(await tools.execute("read_document", { document_id: workbook.id, start_line: 13 })).toEqual({ document: "מלאי.xlsx", lines: "13-13", total_lines: 13, text: "13| Row 8: | x | 1 |", note: "End of file." });
  });

  it("names a row in every sheet that has it", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "two.xlsx", bytes: await book([{ name: "East", rows: [[1, ["a"]], [30, ["b"]]] }, { name: "West", rows: [[30, ["c"]]] }]) });
    const result = await files.tools([meta]).execute("read_document", { document_id: meta.id, start_line: 30 });
    expect(result.error).toBe(`start_line 30 is past the end of the file, which has ${meta.lines} lines. A line of a workbook is not its row: Row 30 is on line 4 (sheet "East"), and on line 8 (sheet "West"). Its sheets: sheet "East", rows 1–30 on lines 3–4; sheet "West", row 30 on line 8.`);
  });

  it("refuses a log's start_line past its end in the words search_document uses for from_line", async () => {
    const { log, tools } = await library();
    const search = await tools.execute("search_document", { document_id: log.id, query: "line", mode: "exact", from_line: 9999 });
    expect(search).toEqual({ error: "from_line 9999 is past the end of the file, which has 50 lines." });
    expect(await tools.execute("read_document", { document_id: log.id, start_line: 9999 })).toEqual({ error: String(search.error).replace("from_line", "start_line") });
    expect(await tools.execute("read_document", { document_id: log.id, start_line: 51 })).toEqual({ error: "start_line 51 is past the end of the file, which has 50 lines." });
    expect(await tools.execute("read_document", { document_id: log.id, start_line: 50 })).toMatchObject({ lines: "50-50", note: "End of file." });
    // A start that is not a number reads from line 1, as before (a negative one too: 0.99.17).
    expect(await tools.execute("read_document", { document_id: log.id, start_line: "x", end_line: 2 })).toMatchObject({ lines: "1-2" });
    expect(await tools.execute("read_document", { document_id: log.id, start_line: -5, end_line: 2 })).toMatchObject({ lines: "1-2" });
  });

  it("refuses a start past the end after a read that showed the last line, with no pointer to that line", async () => {
    const { files, log } = await library();
    const read = (id: string, args: Record<string, unknown>) => ({ id, name: "read_document", args: { document_id: log.id, ...args } });
    const model = fakeModel([calls([read("c1", { start_line: 1, end_line: 50 })]), calls([read("c2", { start_line: 400 }), read("c3", { start_line: 40 })]), says("Done.")]);
    await askStream({ files, model, documentIds: [log.id], messages: [{ role: "user", text: "Line 400?" }] }).result;
    const answers = model.requests.at(-1)!.messages.flatMap((message) => (message.role === "tools" ? message.answers.map((answer) => answer.result) : []));
    expect(answers[1]).toEqual({ error: "start_line 400 is past the end of the file, which has 50 lines.", tool_turns_left: 9 });
    // A start within the lines shown is still pointed to them.
    expect(answers[2]).toMatchObject({ lines: "40-50", already_shown: true });
  });

  it("keeps planted sheet names out of events and SSE with eventResults off; the model gets them", async () => {
    const SHEETS = ["QZSHEETA", "QZSHEETB"];
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "book.xlsx", bytes: await book([{ name: SHEETS[0]!, rows: [[1, ["a", 1]], [400, ["b", 2]]] }, { name: SHEETS[1]!, hidden: true, rows: [[1, ["c", 3]]] }]) });
    const run = async (eventResults: boolean) => {
      const model = fakeModel([calls([{ id: "c1", name: "read_document", args: { document_id: meta.id, start_line: 400 } }]), says("Row 400 is b.")]);
      const events: AskEvent[] = [];
      const stream = askStream({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "Row 400?" }], eventResults, onEvent: (event) => events.push(event) });
      const response = fakeResponse();
      await writeSseEvents(response, stream, { heartbeatMs: 0 });
      return { result: await stream.result, events, sse: response.body(), requests: model.requests as ModelRequest[] };
    };
    const refusal = `start_line 400 is past the end of the file, which has ${meta.lines} lines.`;
    const off = await run(false);
    // The model gets the whole error, with each sheet's range.
    const sent = JSON.stringify(off.requests.at(-1)!.messages.filter((message) => message.role === "tools"));
    expect(sent).toContain(`${refusal} A line of a workbook is not its row: Row 400 is on line 4 (sheet \\"QZSHEETA\\")`);
    for (const name of SHEETS) {
      expect(JSON.stringify(off.events), name).not.toContain(name);
      expect(off.sse, name).not.toContain(name);
      expect(JSON.stringify(off.result.steps), name).not.toContain(name);
    }
    const end = off.events.find((event): event is Extract<AskEvent, { type: "tool.end" }> => event.type === "tool.end")!;
    expect(end).toMatchObject({ outcome: "error", error: refusal, step: `Read book.xlsx lines 400 — failed: ${refusal}` });
    expect(off.result.steps).toContain(`Read book.xlsx lines 400 — failed: ${refusal}`);
    // The tool rounds kept with the conversation hold what the model was sent.
    expect(JSON.stringify(off.result.toolTurns)).toContain("QZSHEETA");
    // With eventResults, the result as sent is in tool.end, as every result is; error and step stay short.
    const on = await run(true);
    const shown = on.events.find((event): event is Extract<AskEvent, { type: "tool.end" }> => event.type === "tool.end")!;
    expect(shown.error).toBe(refusal);
    expect(String(shown.result?.error)).toContain('sheet "QZSHEETA", rows 1–400');
  });
});
