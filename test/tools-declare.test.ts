// The tool set's side of 0.10.0's budget and of tables sent whole: `ToolOptions.declare` and `inline`,
// `declarationsFor`, `ToolSet.wholeReadsLeft` (LLF-058), the room kept for an unknown tool
// (LLF-049), and no pointer to a result the application replaced.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, declarationsFor, MemoryDocumentStore, TOOL_NAMES, type GenerateText, type ToolName } from "../src/index.js";
import { alreadyShown, LEAST_RESULT_CHARACTERS } from "../src/tools.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const csv = () => ["Region,Amount", ...Array.from({ length: 300 }, (_, index) => `${["North", "South"][index % 2]},${index}`)].join("\n");

async function library() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 4_000 } });
  const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(400)) });
  const sales = await files.ingest({ name: "sales.csv", bytes: utf8(csv()) });
  return { files, log, sales };
}

const notes: GenerateText = async () => "The worker answered in time (L1).";
const names = (declarations: Array<{ name: string }>) => declarations.map((declaration) => declaration.name);

describe("declarationsFor", () => {
  it("gives the declarations in the order a tool set declares them, whatever the order asked", () => {
    const asked: ToolName[] = ["view_pages", "analyze_whole_document", "search_document", "aggregate_table", "get_document_overview", "read_document"];
    expect(names(declarationsFor(asked))).toEqual(["search_document", "read_document", "get_document_overview", "aggregate_table", "analyze_whole_document", "view_pages"]);
    expect(names(declarationsFor(["aggregate_table", "search_document"]))).toEqual(["search_document", "aggregate_table"]);
    expect(declarationsFor([])).toEqual([]);
    // A name that is no tool's is left out.
    expect(names(declarationsFor(["read_document", "lookup_ticket" as ToolName]))).toEqual(["read_document"]);
  });

  it("gives the bytes the tool set declares", async () => {
    const { files, log, sales } = await library();
    const tools = files.tools([log, sales], { generate: notes });
    expect(JSON.stringify(declarationsFor(names(tools.declarations) as ToolName[]))).toBe(JSON.stringify(tools.declarations));
  });
});

describe("ToolOptions.declare", () => {
  it("declares exactly the tools named, in today's order, and those equal declarationsFor", async () => {
    const { files, log } = await library();
    const declare: ToolName[] = ["aggregate_table", "read_document", "search_document"];
    const tools = files.tools([log], { declare });
    // The log has no table: without `declare`, aggregate_table is not declared, and get_document_overview is.
    expect(names(tools.declarations)).toEqual(["search_document", "read_document", "aggregate_table"]);
    expect(tools.declarations).toEqual(declarationsFor(declare));
  });

  it("answers a declared tool that cannot run with its reason", async () => {
    const { files, log } = await library();
    const tools = files.tools([log], { declare: ["search_document", "read_document", "aggregate_table"] });
    expect(await tools.execute(TOOL_NAMES.aggregate, { document_id: log.id })).toEqual({ error: "No attached file has a table: aggregate_table needs one." });
    // view_pages declared with no PDF to look at.
    const viewing = files.tools([log], { declare: ["search_document", "view_pages"] });
    expect(names(viewing.declarations)).toEqual(["search_document", "view_pages"]);
    const look = await viewing.executeWithFiles(TOOL_NAMES.view, { document_id: log.id, from_page: 1 });
    expect(look).toEqual({ result: { error: "No attached file has pages to look at: view_pages needs a PDF whose original file is kept. Answer from the text." }, files: [] });
    // The tools that can run still do.
    expect(await tools.execute(TOOL_NAMES.read, { document_id: log.id, start_line: 1, end_line: 2 })).toMatchObject({ lines: "1-2" });
  });

  it("answers no tool it does not declare, and keeps the least room for a tool that cannot run", async () => {
    const { files, log } = await library();
    let requests = 0;
    const generate: GenerateText = async () => {
      requests++;
      return "A note (L1).";
    };
    // 0.10.0 before this fix: an undeclared analyze_whole_document ran a read, and aggregate_table was answered.
    const none = files.tools([log], { generate, declare: [] });
    expect(none.declarations).toEqual([]);
    expect(none.has(TOOL_NAMES.analyze)).toBe(false);
    expect(await none.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize." })).toEqual({ error: "Unknown tool “analyze_whole_document”." });
    expect(await none.execute(TOOL_NAMES.aggregate, { document_id: log.id })).toEqual({ error: "Unknown tool “aggregate_table”." });
    expect(requests).toBe(0);
    expect(none.resultCharacters(TOOL_NAMES.analyze)).toBe(LEAST_RESULT_CHARACTERS);
    // Declared with no part reader, or with no table: the call answers its reason in a few words, and
    // no more room is kept for it (0.10.0 before this fix kept 40,000 for the whole-file read).
    const cannot = files.tools([log], { declare: ["search_document", "aggregate_table", "analyze_whole_document"] });
    expect(await cannot.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize." })).toEqual({ error: "Whole-document analysis is not enabled." });
    expect(cannot.resultCharacters(TOOL_NAMES.analyze)).toBe(LEAST_RESULT_CHARACTERS);
    expect(cannot.resultCharacters(TOOL_NAMES.aggregate)).toBe(LEAST_RESULT_CHARACTERS);
    expect(cannot.resultCharacters(TOOL_NAMES.search)).toBe(files.budget.toolResultCharacters);
    // With a part reader it may answer at length.
    expect(files.tools([log], { generate, declare: ["analyze_whole_document"] }).resultCharacters(TOOL_NAMES.analyze)).toBe(40_000);
  });

  it("with today's set gives today's bytes", async () => {
    const { files, log, sales } = await library();
    const today = files.tools([log, sales], { generate: notes });
    const declared = files.tools([log, sales], { generate: notes, declare: ["search_document", "read_document", "get_document_overview", "aggregate_table", "analyze_whole_document"] });
    expect(JSON.stringify(declared.declarations)).toBe(JSON.stringify(today.declarations));
  });
});

describe("ToolOptions.inline", () => {
  it("makes analyze_whole_document refuse a document shown in full, with no request", async () => {
    const { files, sales } = await library();
    let requests = 0;
    const generate: GenerateText = async () => {
      requests++;
      return "unused";
    };
    // Declared for the documents that are searched: here, a call of it names the one shown in full.
    const tools = files.tools([sales], { generate, inline: [sales.id], declare: ["search_document", "read_document", "aggregate_table", "analyze_whole_document"] });
    const result = await tools.execute(TOOL_NAMES.analyze, { document_id: sales.id, task: "Sum the amounts." });
    expect(result).toEqual({ error: "sales.csv is shown in full above: answer from it, and use search_document or aggregate_table for exact counts." });
    expect(requests).toBe(0);
    expect(tools.wholeReadsLeft?.(sales.id)).toBe(0);
    // The other tools still reach it: its table can be counted.
    expect(await tools.execute(TOOL_NAMES.aggregate, { document_id: sales.id })).toMatchObject({ rows_matched: 300 });
  });
});

describe("ToolSet.wholeReadsLeft", () => {
  it("counts down the reads of each document, and is 0 at the cap", async () => {
    const { files, log, sales } = await library();
    const tools = files.tools([log, sales], { generate: notes, maxWholeDocumentReads: 2 });
    expect(tools.wholeReadsLeft?.(log.id)).toBe(2);
    await tools.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize." });
    expect(tools.wholeReadsLeft?.(log.id)).toBe(1);
    expect(tools.wholeReadsLeft?.(sales.id)).toBe(2);
    await tools.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize again." });
    expect(tools.wholeReadsLeft?.(log.id)).toBe(0);
    expect(await tools.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Once more." })).toEqual({ error: "app.log was already read whole for this question 2 times, and is not read whole again. Use the answer of that read, or search_document and read_document for the details." });
  });

  it("is 0 once a read of the document could read no part, and that read is not tried again under a higher cap", async () => {
    const { files, log } = await library();
    let requests = 0;
    const failing: GenerateText = async () => {
      requests++;
      throw Object.assign(new Error("boom"), { status: 400 });
    };
    const tools = files.tools([log], { generate: failing, maxWholeDocumentReads: 3, retry: { retries: 0 } });
    expect((await tools.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize." })).error).toMatch(/^Could not read any part of app\.log/);
    const sent = requests;
    expect(tools.wholeReadsLeft?.(log.id)).toBe(0);
    expect(await tools.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize again." })).toEqual({ error: "The whole-file read of app.log failed earlier in this question (The model refused the request (HTTP 400).), and is not tried again. Use search_document and read_document." });
    expect(requests).toBe(sent);
  });

  it("is 0 for a document the tool set cannot read whole", async () => {
    const { files, log } = await library();
    expect(files.tools([log]).wholeReadsLeft?.(log.id)).toBe(0);
    expect(files.tools([log], { generate: notes }).wholeReadsLeft?.("doc_other")).toBe(0);
    expect(files.tools([log], { generate: notes, maxWholeDocumentReads: 0 }).wholeReadsLeft?.(log.id)).toBe(0);
  });

  it("lets askWithFiles refuse a read that failed with its own reason, not its price (probe3, LLF-058)", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 50_000, inlineTokens: 10 } });
    const meta = await files.ingest({ name: "big.log", bytes: utf8(serviceLog(6_000)) });
    const generateText: GenerateText = async () => {
      throw Object.assign(new Error("boom"), { status: 400 });
    };
    const model = fakeModel([
      calls([{ id: "a1", name: "analyze_whole_document", args: { document_id: meta.id, task: "summary" } }], { usage: { inputTokens: 10_000 } }),
      calls([{ id: "a2", name: "analyze_whole_document", args: { document_id: meta.id, task: "summary again" } }], { usage: { inputTokens: 380_000 } }),
      says("answer"),
    ], { generateText });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "q" }], limits: { inputTokens: 600_000 }, retry: { retries: 0 } });
    expect(result.toolTurns[0]!.calls[0]!.result.error).toMatch(/^Could not read any part of big\.log/);
    expect(result.toolTurns[1]!.calls[0]!.result.error).toMatch(/^The whole-file read of big\.log failed earlier in this question .*, and is not tried again\./);
  });
});

describe("the room kept for a call (LLF-049)", () => {
  it("is the least a result takes for a name the tool set does not answer", async () => {
    const { files, log, sales } = await library();
    const tools = files.tools([log, sales], { generate: notes });
    expect(tools.resultCharacters("lookup_ticket_3")).toBe(LEAST_RESULT_CHARACTERS);
    expect(tools.resultCharacters(TOOL_NAMES.search)).toBe(files.budget.toolResultCharacters);
    expect(tools.resultCharacters(TOOL_NAMES.analyze)).toBe(Math.max(files.budget.toolResultCharacters, 40_000));
  });
});

describe("alreadyShown", () => {
  it("never points to a result the application replaced (redacted)", () => {
    const call = { name: TOOL_NAMES.read, args: { document_id: "doc_a", start_line: 1, end_line: 20 } };
    const result = { document: "a.log", lines: "1-20", total_lines: 400, text: "1| …" };
    expect(alreadyShown(call, { call, result })).toMatchObject({ already_shown: true });
    expect(alreadyShown(call, { call, result: { ...result, redacted: true } })).toBeUndefined();
    const search = { name: TOOL_NAMES.search, args: { document_id: "doc_a", query: "x", mode: "exact" } };
    const found = { document: "a.log", mode: "exact", total_matching_lines: 1, matches: [{ line: 3, text: "x" }] };
    expect(alreadyShown(search, { call: search, result: found })).toMatchObject({ already_shown: true });
    expect(alreadyShown(search, { call: search, result: { ...found, redacted: true } })).toBeUndefined();
  });
});
