// Files sent whole in askWithFiles (P1 of 0.10.0): a table sent whole gets the tools that count it
// (`inlineTables`, "tools" by default), and the lines of every file sent whole are numbered
// (`numberInline`, true by default), with their evidence listed first. A question whose tools read
// only files sent whole runs the loop on the answering model, without the explorer.
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  EXPLORER_INSTRUCTION,
  FINAL_ANSWER_REQUEST,
  MemoryDocumentStore,
  type AskEvent,
  type AskOptions,
  type LargeFiles,
  type ModelReply,
  type ModelRequest,
  type ModelToolRound,
  type ToolResult,
} from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { calls, fakeFetch, fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";
import { FINAL_ANSWER_WITH_FILES } from "../src/ask.js";
import { INLINE_CITATION_LINE, INLINE_TABLES_LINE, numberedSize, numberedText, renderInline } from "../src/plan.js";
import { p, word, zip } from "./word-fixtures.js";

/** probe4's CSV: 3,000 invoices in Hebrew, 750 of them late ("באיחור"). */
function invoices(rows = 3000): string {
  const statuses = ["שולם", "באיחור", "בוטל", "פתוח"];
  const lines = ["מספר,לקוח,סכום,סטטוס,תאריך"];
  for (let i = 1; i <= rows; i++) lines.push(`${i},לקוח ${i % 211},${(i * 7919) % 50000}.${i % 100},${statuses[(i * 7) % 4]},2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
  return lines.join("\n");
}

const NOTE = "# Notes\n\nThe code word is heron.\nThe nightly import runs at 02:00 UTC.\n";
const question = (text: string) => ({ role: "user" as const, text });
const names = (request: ModelRequest | undefined) => request?.tools?.map((tool) => tool.name);
const textOf = (request: ModelRequest) => request.messages.flatMap((message) => ("parts" in message ? message.parts.map((part) => part.text ?? "") : [])).join("\n");
/** The results of the tool rounds of a request, in order. */
const resultsOf = (request: ModelRequest): ToolResult[] => request.messages.filter((message): message is ModelToolRound => message.role === "tools").flatMap((round) => round.answers.map((answer) => answer.result));

async function library(budget: Record<string, number> = {}): Promise<LargeFiles> {
  return createLargeFiles({ store: new MemoryDocumentStore(), budget });
}

const cell = (text: string) => `<w:tc>${p(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;
/** A Hebrew policy in Word with a table of three rows. */
const hebrewDocx = () => word([
  p("נוהל החזר הוצאות"),
  p("הטבלה מפרטת את התקרות לפי סוג ההוצאה."),
  `<w:tbl>${row("סוג", "תקרה")}${row("נסיעות", "500")}${row("ארוחות", "120")}</w:tbl>`,
].join(""));
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const drawingCell = (text: string) => `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
/** A deck of one slide with a table of three rows. */
const deckWithTable = () => zip({
  "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
  "ppt/slides/slide1.xml": `<p:sld ${P}><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl>${[["אזור", "מכירות"], ["צפון", "10"], ["דרום", "12"]].map((cells) => `<a:tr>${cells.map(drawingCell).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
});

describe("tables sent whole get the tools that count them (inlineTables)", () => {
  it("probe4: aggregate_table is declared for the CSV sent whole, and its count of 750 comes back with lines to cite", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices()) });
    const count = { id: "c1", name: "aggregate_table", args: { document_id: meta.id, metrics: ["count"], filters: [{ column: "סטטוס", op: "=", value: "באיחור" }] } };
    const model = fakeModel([calls([count]), says("יש 750 חשבוניות באיחור (חשבוניות.csv L4).")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("כמה חשבוניות באיחור?")] });
    // Sent whole, as before: about 113K tokens, now numbered.
    expect(result.plan.inline.map((document) => document.id)).toEqual([meta.id]);
    expect(result.plan.searchable).toEqual([]);
    // The tools of a table shown in full: not the overview, not a whole-file read.
    expect(names(model.requests[0])).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(model.requests[0]!.toolChoice).toBe("auto");
    expect(model.requests[0]!.system).toBe(`${INLINE_TABLES_LINE}\n${INLINE_CITATION_LINE}`);
    // The count is exact, and its result names lines to cite.
    const [counted] = resultsOf(model.requests[1]!);
    expect(counted).toMatchObject({ rows_matched: 750 });
    expect((counted!.groups as Array<{ count: number; lines: number[] }>)[0]).toMatchObject({ count: 750 });
    // Invoice 3, the first late one, is on line 4, under the header.
    expect((counted!.groups as Array<{ lines: number[] }>)[0]!.lines[0]).toBe(4);
    expect(model.requests).toHaveLength(2);
    expect(result.answered).toBe(true);
    expect(result.text).toBe("יש 750 חשבוניות באיחור (חשבוניות.csv L4).");
    expect(result.citations).toEqual({ checked: 1, supported: 1, unchecked: 0, unsupported: [] });
    // The file sent whole, then what aggregate_table showed.
    expect(result.evidence.map((entry) => entry.tool)).toEqual(["inline", "aggregate_table"]);
  });

  it("answers a question over a table sent whole that needs no count in one request, with the tools declared", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    const model = fakeModel([says("העמודות הן מספר, לקוח, סכום, סטטוס ותאריך (חשבוניות.csv L1).")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("אילו עמודות יש בקובץ?")] });
    expect(model.requests).toHaveLength(1);
    expect(names(model.requests[0])).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(result.turns).toBe(1);
    expect(result.answered).toBe(true);
    expect(result.citations?.supported).toBe(1);
  });

  it("gives the tools to a Hebrew Word file and a deck whose tables have three rows, not to a note", async () => {
    const files = await library();
    const docx = await files.ingest({ name: "נוהל.docx", bytes: await hebrewDocx() });
    const pptx = await files.ingest({ name: "מצגת.pptx", bytes: await deckWithTable() });
    for (const meta of [docx, pptx]) {
      const model = fakeModel([says("500")]);
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("מה התקרה לנסיעות?")] });
      expect(result.plan.inline.map((document) => document.id)).toEqual([meta.id]);
      expect(names(model.requests[0]), meta.name).toEqual(["search_document", "read_document", "aggregate_table"]);
    }
    const note = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    const model = fakeModel([says("Heron.")]);
    await askWithFiles({ files, model, documentIds: [note.id], messages: [question("What is the code word?")] });
    expect(model.requests[0]!.tools).toBeUndefined();
    expect(model.requests[0]!.system).toBe(INLINE_CITATION_LINE);
  });

  it("runs the loop on the answering model when every file is sent whole: the explorer gets no request", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    // A question that needs no count: one request, to the answering model.
    const explorer = fakeModel([says("DONE")], { id: "fake-explorer" });
    const model = fakeModel([says("העמודות: מספר, לקוח, סכום, סטטוס, תאריך.")], { id: "fake-answer" });
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: [question("אילו עמודות יש בקובץ?")] });
    expect(explorer.requests).toHaveLength(0);
    expect(model.requests).toHaveLength(1);
    expect(names(model.requests[0])).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(model.requests[0]!.system).not.toContain(EXPLORER_INSTRUCTION);
    expect(result.answered).toBe(true);
    expect(result.text).toBe("העמודות: מספר, לקוח, סכום, סטטוס, תאריך.");

    // A count: the answering model calls aggregate_table itself, and answers from its result.
    const again = fakeModel([says("DONE")], { id: "fake-explorer" });
    const counting = fakeModel([calls([{ id: "c1", name: "aggregate_table", args: { document_id: meta.id, metrics: ["count"], filters: [{ column: "סטטוס", op: "=", value: "באיחור" }] } }]), says("10 חשבוניות באיחור.")], { id: "fake-answer" });
    const counted = await askWithFiles({ files, model: counting, explorer: again, documentIds: [meta.id], messages: [question("כמה חשבוניות באיחור?")] });
    expect(again.requests).toHaveLength(0);
    expect(counting.requests).toHaveLength(2);
    expect(resultsOf(counting.requests[1]!)[0]).toMatchObject({ rows_matched: 10 });
    expect(counted.text).toBe("10 חשבוניות באיחור.");
  });

  it("keeps the explorer when a file is searched, and it counts the table sent whole too", async () => {
    const files = await library({ inlineTokens: 5_000 });
    const csv = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const explorer = fakeModel([calls([{ id: "c1", name: "aggregate_table", args: { document_id: csv.id, metrics: ["count"] } }]), says("DONE")], { id: "fake-explorer" });
    const model = fakeModel([says("40 invoices.")], { id: "fake-answer" });
    const result = await askWithFiles({ files, model, explorer, documentIds: [csv.id, log.id], messages: [question("How many invoices?")] });
    expect(result.plan.inline.map((document) => document.id)).toEqual([csv.id]);
    expect(result.plan.searchable.map((document) => document.id)).toEqual([log.id]);
    expect(explorer.requests).toHaveLength(2);
    expect(names(explorer.requests[0])).toEqual(["search_document", "read_document", "get_document_overview", "aggregate_table"]);
    expect(explorer.requests[0]!.system).toContain(EXPLORER_INSTRUCTION);
    expect(explorer.requests[0]!.system).toContain(INLINE_TABLES_LINE);
    // A file is searched: its guide asks for citations, and no second line does.
    expect(explorer.requests[0]!.system).not.toContain(INLINE_CITATION_LINE);
    expect(resultsOf(explorer.requests[1]!)[0]).toMatchObject({ rows_matched: 40 });
    // The closing request names the files shown in full.
    expect(model.requests).toHaveLength(1);
    expect(textOf(model.requests[0]!).endsWith(FINAL_ANSWER_WITH_FILES)).toBe(true);
  });

  it("does not declare analyze_whole_document for tables sent whole, and it refuses a file sent whole when a searched file has it declared", async () => {
    const files = await library({ inlineTokens: 5_000 });
    const csv = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    const analyze = { id: "c1", name: "analyze_whole_document", args: { document_id: csv.id, task: "Count the late invoices." } };
    const generateText = async () => "unused";
    const alone = fakeModel([calls([analyze]), says("10.")], { generateText });
    await askWithFiles({ files, model: alone, documentIds: [csv.id], messages: [question("How many are late?")] });
    expect(names(alone.requests[0])).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(resultsOf(alone.requests[1]!)[0]!.error).toBe("Unknown tool “analyze_whole_document”. The tools are: search_document, read_document, aggregate_table.");

    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const mixed = fakeModel([calls([analyze]), says("10.")], { generateText });
    await askWithFiles({ files, model: mixed, documentIds: [csv.id, log.id], messages: [question("How many are late?")] });
    expect(names(mixed.requests[0])).toEqual(["search_document", "read_document", "get_document_overview", "aggregate_table", "analyze_whole_document"]);
    expect(resultsOf(mixed.requests[1]!)[0]!.error).toMatch(/^"?חשבוניות\.csv"? is shown in full above/);
  });

  it("asks for the answer from the files shown in full and the tools when the tool turns run out", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    const search = { id: "c1", name: "search_document", args: { document_id: meta.id, query: "באיחור", mode: "exact" } };
    const model = fakeModel([calls([search]), says("10.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("כמה באיחור?")], limits: { toolTurns: 2 } });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.toolChoice).toBe("none");
    expect(textOf(model.requests[1]!).endsWith(FINAL_ANSWER_WITH_FILES)).toBe(true);
    expect(FINAL_ANSWER_WITH_FILES).not.toBe(FINAL_ANSWER_REQUEST);
  });

  it("sends a table whole without tools under \"text\"", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    const model = fakeModel([says("10.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("כמה באיחור?")], inlineTables: "text" });
    expect(model.requests[0]!.tools).toBeUndefined();
    // Numbered still: the citation line alone.
    expect(model.requests[0]!.system).toBe(INLINE_CITATION_LINE);
    expect(result.evidence).toEqual([{ tool: "inline", documentId: meta.id, document: "חשבוניות.csv", lines: [[1, 41]], whole: true }]);
  });

  it("is passed on by askGemini, which forwards both options", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    const endpoint = geminiApi({ apiKey: "test-key", model: "gemini-test" });
    const reply = () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Five columns." }] }, finishReason: "STOP" }] });
    const tools = fakeFetch([reply()]);
    await askGemini({ files, endpoint, fetch: tools.fetch, documentIds: [meta.id], messages: [question("Which columns?")] });
    expect(tools.sent[0]!.body.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name)).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(tools.sent[0]!.body.contents[0].parts[0].text).toContain("\n1| מספר,לקוח,סכום,סטטוס,תאריך\n");
    const plain = fakeFetch([reply()]);
    await askGemini({ files, endpoint, fetch: plain.fetch, documentIds: [meta.id], messages: [question("Which columns?")], inlineTables: "text", numberInline: false });
    expect(plain.sent[0]!.body.tools).toBeUndefined();
    expect(plain.sent[0]!.body.systemInstruction).toBeUndefined();
    expect(plain.sent[0]!.body.contents[0].parts[0].text).toContain("\nמספר,לקוח,סכום,סטטוס,תאריך\n");
  });

  it("gives the document_id of each table that gets the tools in its frame line: a model that reads only the request counts with it", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store });
    const csv = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices()) });
    const note = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    // The model knows no ID but what the request says: it takes the CSV's from its frame line.
    const fromFrame = (request: ModelRequest): Partial<ModelReply> => {
      const found = /"חשבוניות\.csv" \(csv, [^)]*; document_id ([^;\s]+); it ends only/.exec(textOf(request));
      if (!found) return says("The file has no document_id.");
      return calls([{ id: "c1", name: "aggregate_table", args: { document_id: found[1], metrics: ["count"], filters: [{ column: "סטטוס", op: "=", value: "באיחור" }] } }]);
    };
    const model = fakeModel([fromFrame, says("750 חשבוניות באיחור (חשבוניות.csv L4).")]);
    const result = await askWithFiles({ files, model, documentIds: [csv.id, note.id], messages: [question("כמה חשבוניות באיחור?")] });
    expect(model.requests).toHaveLength(2);
    expect(resultsOf(model.requests[1]!)[0]).toMatchObject({ rows_matched: 750 });
    expect(result.citations?.supported).toBe(1);
    // In the frame of the table only: the note sent whole gets no tools, and no ID.
    const sent = textOf(model.requests[0]!);
    expect(sent).toContain(renderInline(csv, numberedText((await store.get(csv.id))!.text), true));
    expect(sent).toContain(renderInline(note, numberedText((await store.get(note.id))!.text)));
    expect(JSON.stringify(model.requests[0])).not.toContain(note.id);
    // "text": the frame of 0.9, with no ID in the request.
    const plain = fakeModel([fromFrame]);
    await askWithFiles({ files, model: plain, documentIds: [csv.id], messages: [question("כמה חשבוניות באיחור?")], inlineTables: "text" });
    expect(JSON.stringify(plain.requests[0])).not.toContain(csv.id);
    expect(plain.requests[0]!.tools).toBeUndefined();
  });

  it("ends a question over tables sent whole on a reply that a filter, OTHER or the output limit ended before any text, as the direct request did", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(40)) });
    const ended = { filtered: says("", { finish: "filtered", finishReason: "SAFETY" }), other: says("", { finish: "other", finishReason: "LANGUAGE" }), cut: says("", { finish: "cut", finishReason: "MAX_TOKENS" }) } as const;
    const run = async (reply: Partial<ModelReply>, shape: Pick<AskOptions, "inlineTables">, first: Partial<ModelReply>[] = []) => {
      const events: AskEvent[] = [];
      const model = fakeModel([...first, reply]);
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("כמה באיחור?")], onEvent: (event) => events.push(event), ...shape });
      const notices = events.flatMap((event) => (event.type === "notice" ? [event.code] : []));
      const kinds = events.flatMap((event) => (event.type === "request.start" ? [`${event.role} ${event.purpose}`] : []));
      return { result, notices, kinds, requests: model.requests };
    };
    for (const [finish, reply] of Object.entries(ended)) {
      const tools = await run(reply, {});
      const text = await run(reply, { inlineTables: "text" });
      // One request, as with "text": no request for the answer that would send the table again.
      expect(tools.kinds, finish).toEqual(["tools turn"]);
      expect(text.kinds, finish).toEqual(["answer direct"]);
      expect(tools.result.answered, finish).toBe(false);
      expect(tools.result.finish, finish).toBe(finish);
      expect(tools.notices, finish).toEqual(text.notices);
    }
    expect((await run(ended.filtered, {})).notices).toEqual(["answer_filtered"]);
    expect((await run(ended.cut, {})).notices).toEqual(["answer_cut"]);
    // After a count too: the reply that follows its result ends the question.
    const count = calls([{ id: "c1", name: "aggregate_table", args: { document_id: meta.id, metrics: ["count"] } }]);
    const after = await run(ended.filtered, {}, [count]);
    expect(after.kinds).toEqual(["tools turn", "tools turn"]);
    expect(after.notices).toEqual(["answer_filtered"]);
    // A file searched keeps the request for the answer after such a reply.
    const searched = await createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 2_000 } });
    const log = await searched.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const events: AskEvent[] = [];
    await askWithFiles({ files: searched, model: fakeModel([ended.filtered]), documentIds: [log.id], messages: [question("Errors?")], onEvent: (event) => events.push(event) });
    expect(events.flatMap((event) => (event.type === "request.start" ? [event.purpose] : []))).toEqual(["turn", "closing"]);
  });

  it("asks a question over tables sent whole in one request without the tools when not one tool turn fits, with no notice", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(600)) });
    const run = async (shape: Pick<AskOptions, "inlineTables" | "limits">) => {
      const events: AskEvent[] = [];
      const model = fakeModel([says("Five columns.")]);
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("Which columns?")], onEvent: (event) => events.push(event), ...shape });
      return {
        result,
        model,
        notices: events.flatMap((event) => (event.type === "notice" ? [event.code] : [])),
        starts: events.flatMap((event) => (event.type === "request.start" ? [event] : [])),
      };
    };
    // A ceiling between one request with the table and two (sized for 0.9), one request, one tool turn.
    for (const limits of [{ inputTokens: Math.ceil(meta.estimatedTokens * 1.6) }, { requests: 1 }, { toolTurns: 1 }]) {
      const tools = await run({ limits });
      const text = await run({ limits, inlineTables: "text" });
      const label = JSON.stringify(limits);
      expect(tools.model.requests, label).toHaveLength(1);
      expect(tools.starts.map((start) => `${start.role} ${start.purpose}`), label).toEqual(["answer direct"]);
      expect(tools.notices, label).toEqual([]);
      expect(tools.result.answered, label).toBe(true);
      // The request of "text": no tools, no line that says to count with them, no closing note.
      const [sent] = tools.model.requests;
      expect(sent!.tools, label).toBeUndefined();
      expect(sent!.toolChoice, label).toBeUndefined();
      expect(sent!.system, label).toBe(INLINE_CITATION_LINE);
      expect(sent!.system, label).toBe(text.model.requests[0]!.system);
      expect(textOf(sent!).endsWith("Which columns?"), label).toBe(true);
      // Counted as that request: the same estimate.
      expect(tools.starts[0]!.estimatedInputTokens, label).toBe(text.starts[0]!.estimatedInputTokens);
    }
    // With room for a tool turn, the tools.
    const roomy = await run({ limits: { requests: 2 } });
    expect(roomy.model.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["search_document", "read_document", "aggregate_table"]);
  });

  it("refuses an inlineTables or numberInline it cannot be, before any request", async () => {
    const files = await library();
    const model = fakeModel([says("x")]);
    const base: AskOptions = { files, model, documentIds: [], messages: [question("q")] };
    await expect(askWithFiles({ ...base, inlineTables: "Text" as never })).rejects.toThrow(new TypeError('inlineTables must be "tools" or "text", and is "Text".'));
    await expect(askWithFiles({ ...base, numberInline: "false" as never })).rejects.toThrow(new TypeError('numberInline must be true or false, and is "false".'));
    expect(model.requests).toHaveLength(0);
  });
});

describe("files sent whole are numbered (numberInline)", () => {
  it("numbers the block as read_document numbers lines, asks for citations, and supports a citation of it", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    const model = fakeModel([says("The code word is heron (notes.md L3). The import runs at 02:00 (notes.md L9).")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("What is the code word?")] });
    const block = renderInline(meta, numberedText((await store.get(meta.id))!.text));
    expect(model.requests[0]!.messages[0]).toEqual({ role: "user", parts: [{ text: block }, { text: "What is the code word?" }] });
    expect(block).toContain("\n1| # Notes\n2| \n3| The code word is heron.\n4| The nightly import runs at 02:00 UTC.\n");
    expect(model.requests[0]!.system).toBe(INLINE_CITATION_LINE);
    expect(model.requests[0]!.tools).toBeUndefined();
    // Line 9 is past the end of the file.
    expect(result.citations).toEqual({ checked: 2, supported: 1, unchecked: 0, unsupported: [{ document: "notes.md", line: 9 }] });
  });

  it("plans a file sent whole by its numbered size: at the edge of inlineTokens it is searched", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "notes.md", bytes: utf8(Array.from({ length: 400 }, (_, i) => `Line ${i + 1} of the notes on the nightly import.`).join("\n")) });
    // Room for the text, not for its line numbers.
    const budget = { inlineTokens: Math.floor((meta.estimatedTokens + numberedSize(meta).tokens) / 2) };
    const ask = (numberInline: boolean) => askWithFiles({ files, model: fakeModel([says("At 02:00.")]), documentIds: [meta.id], messages: [question("When?")], budget, numberInline });
    const numbered = await ask(true);
    expect(numbered.plan.inline).toEqual([]);
    expect(numbered.plan.searchable.map((document) => document.id)).toEqual([meta.id]);
    const plain = await ask(false);
    expect(plain.plan.inline.map((document) => document.id)).toEqual([meta.id]);
    expect(plain.plan.inlineTokens).toBe(meta.estimatedTokens);
  });

  it("sends the block of 0.9 with numberInline false, and no citation line", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ store });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    const model = fakeModel([says("Heron.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("What is the code word?")], numberInline: false });
    expect(model.requests[0]!.messages[0]).toEqual({ role: "user", parts: [{ text: renderInline(meta, (await store.get(meta.id))!.text) }, { text: "What is the code word?" }] });
    expect(model.requests[0]!.system).toBe("");
  });

  it("lists each file sent whole first in the evidence, in the order of its block and without a callId, then the tool calls", async () => {
    const files = await library({ inlineTokens: 2_000 });
    const note = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    const runbook = await files.ingest({ name: "runbook.md", bytes: utf8("# Runbook\nRestart the payment worker.\n") });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const search = { id: "c1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact", max_results: 3 } };
    const model = fakeModel([calls([search]), says("20 errors (app.log L97).")]);
    const result = await askWithFiles({ files, model, documentIds: [runbook.id, log.id, note.id], messages: [question("How many errors?")] });
    expect(result.evidence.slice(0, 2)).toEqual([
      { tool: "inline", documentId: runbook.id, document: "runbook.md", lines: [[1, 2]], whole: true },
      { tool: "inline", documentId: note.id, document: "notes.md", lines: [[1, 4]], whole: true },
    ]);
    expect(result.evidence[2]).toMatchObject({ tool: "search_document", documentId: log.id, callId: "call_1" });
    expect(result.evidence).toHaveLength(3);
    // The system text: the guide to the searched file, which asks for citations itself.
    expect(model.requests[0]!.system).not.toContain(INLINE_CITATION_LINE);
    expect(result.citations?.supported).toBe(1);
  });

  it("adds no citation line for a library of your own whose prepare is that of 0.9", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    const own: LargeFiles = {
      ...files,
      // 0.9's PreparedContext: no guide, no listing, no toolable, no placement.
      async prepare(ids, base, options) {
        const { plan, blocks, instruction, missing, viewable } = await files.prepare(ids, base, { ...options, numberInline: false, inlineTables: "text" });
        return { plan, blocks, instruction, missing, viewable };
      },
    };
    const model = fakeModel([says("Heron.")]);
    const result = await askWithFiles({ files: own, model, documentIds: [meta.id], messages: [question("What is the code word?")] });
    expect(model.requests[0]!.system).toBe("");
    expect(result.evidence).toEqual([{ tool: "inline", documentId: meta.id, document: "notes.md", lines: [[1, 4]], whole: true }]);
  });
});
