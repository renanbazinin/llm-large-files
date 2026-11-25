// `read_document`'s `whole_file` (0.10.0): a read cut short of its range by the size limit says that
// `analyze_whole_document` reads all of the file, when the tool set declares that read, can run it,
// and the file can be read whole. Gemini Flash-Lite and Flash read a contract to summarize in ranges
// of about 16 lines and answered from those (evals/results/0100-t-live-3.md). Each test checks a
// read that has the hint next to one that must not: each fails without it.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, TOOL_NAMES, type GenerateText, type ToolCallLimits, type ToolSet } from "../src/index.js";
import { canBeReadWhole, estimateParts } from "../src/plan.js";
import { wholeReadCost } from "../src/whole-cost.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const notes: GenerateText = async () => "The worker answered in time (L1).";

/** A library whose tool results have 2,000 characters, and a log of 400 lines, about 100 characters each. */
async function library(budget: Record<string, number> = {}) {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 4_000, toolResultCharacters: 2_000, ...budget } });
  const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(400)) });
  return { files, log };
}

const read = (tools: ToolSet, id: string, start = 1, end = 200) => tools.execute(TOOL_NAMES.read, { document_id: id, start_line: start, end_line: end });
/** A read with the limits of one call. */
const readWith = async (tools: ToolSet, id: string, limits: ToolCallLimits, start = 1, end = 200) => (await tools.executeWithFiles(TOOL_NAMES.read, { document_id: id, start_line: start, end_line: end }, limits)).result;

/** The hint of a read that shows `shown` lines of a file of `total`. */
const hint = (shown: number, total: number) => `Only ${shown} ${shown === 1 ? "line fits" : "lines fit"} here. To read all ${total} lines for a task that needs all of them, such as a full summary or a timeline, use analyze_whole_document.`;

/** The lines a read shows, from its `lines`. */
const shownOf = (result: Record<string, unknown>) => {
  const [from, to] = String(result.lines).split("-").map(Number);
  return to! - from! + 1;
};

describe("read_document's whole_file", () => {
  it("says, on a read cut short of its range, how many lines fit and that analyze_whole_document reads them all", async () => {
    const { files, log } = await library();
    const tools = files.tools([log], { generate: notes });
    const cut = await read(tools, log.id);
    expect(shownOf(cut)).toBeLessThan(200);
    expect(cut).toMatchObject({ document: "app.log", total_lines: 400, next_start_line: shownOf(cut) + 1, whole_file: hint(shownOf(cut), 400) });
    // The hint is the result's last field, and the result stays within its cap.
    expect(Object.keys(cut).at(-1)).toBe("whole_file");
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(2_000);
    // The other fields are those of a read without it: the same lines, the same text.
    const plain = await read(files.tools([log]), log.id);
    expect({ ...cut, whole_file: undefined }).toEqual({ ...plain, whole_file: undefined });
  });

  it("is left off a read that was not cut: all the lines asked for fit", async () => {
    const { files, log } = await library();
    const tools = files.tools([log], { generate: notes });
    expect(await read(tools, log.id, 1, 200)).toHaveProperty("whole_file");
    const whole = await read(tools, log.id, 1, 5);
    expect(whole).toMatchObject({ lines: "1-5", next_start_line: 6 });
    expect(whole).not.toHaveProperty("whole_file");
    // The last lines of the file, all of them shown.
    const end = await read(tools, log.id, 396, 400);
    expect(end).toMatchObject({ lines: "396-400", note: "End of file." });
    expect(end).not.toHaveProperty("whole_file");
  });

  it("is left off when the tool set does not declare analyze_whole_document, or cannot run it", async () => {
    const { files, log } = await library();
    expect(await read(files.tools([log], { generate: notes }), log.id)).toHaveProperty("whole_file");
    // No part reader: the read is not declared.
    const without = files.tools([log]);
    expect(without.declarations.map((declaration) => declaration.name)).not.toContain(TOOL_NAMES.analyze);
    expect(await read(without, log.id)).not.toHaveProperty("whole_file");
    // A part reader, but the read is not among the tools declared.
    const undeclared = files.tools([log], { generate: notes, declare: ["search_document", "read_document"] });
    expect(await read(undeclared, log.id)).not.toHaveProperty("whole_file");
    // Declared with no part reader: each call of it answers with an error.
    const cannot = files.tools([log], { declare: ["search_document", "read_document", "analyze_whole_document"] });
    expect(await read(cannot, log.id)).not.toHaveProperty("whole_file");
  });

  it("is left off when the file has more parts than a whole read may read", async () => {
    // Parts of 4,000 tokens and at most 2 of them: the short log can be read whole, the long one cannot.
    const { files, log } = await library({ maxMapChunks: 2 });
    const short = await files.ingest({ name: "short.log", bytes: utf8(serviceLog(60)) });
    const both = files.tools([short, log], { generate: notes });
    expect(both.declarations.map((declaration) => declaration.name)).toContain(TOOL_NAMES.analyze);
    const readable = await read(both, short.id, 1, 60);
    expect(readable).toMatchObject({ total_lines: 60, whole_file: hint(shownOf(readable), 60) });
    const tooLarge = await read(both, log.id);
    expect(shownOf(tooLarge)).toBeLessThan(200);
    expect(tooLarge).not.toHaveProperty("whole_file");
  });

  it("is left off for a file sent whole in the prompt, which analyze_whole_document refuses", async () => {
    const { files, log } = await library();
    const short = await files.ingest({ name: "short.log", bytes: utf8(serviceLog(60)) });
    const tools = files.tools([short, log], { generate: notes, inline: [short.id] });
    expect(await read(tools, log.id)).toHaveProperty("whole_file");
    const inline = await read(tools, short.id, 1, 60);
    expect(shownOf(inline)).toBeLessThan(60);
    expect(inline).not.toHaveProperty("whole_file");
  });

  it("is left off once no whole read of the file is left: turned off, made, or failed", async () => {
    const { files, log } = await library();
    expect(await read(files.tools([log], { generate: notes, maxWholeDocumentReads: 1 }), log.id)).toHaveProperty("whole_file");
    expect(await read(files.tools([log], { generate: notes, maxWholeDocumentReads: 0 }), log.id)).not.toHaveProperty("whole_file");
    // Read whole already, as often as it may be.
    const once = files.tools([log], { generate: notes });
    expect(await read(once, log.id)).toHaveProperty("whole_file");
    expect(await once.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize the log." })).toHaveProperty("answer");
    expect(await read(once, log.id)).not.toHaveProperty("whole_file");
    // A read of it that could read no part is not tried again.
    const failing = files.tools([log], { generate: async () => { throw new Error("The model refused the request."); }, retry: { retries: 0 } });
    expect(await read(failing, log.id)).toHaveProperty("whole_file");
    expect(await failing.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize the log." })).toHaveProperty("error");
    expect(await read(failing, log.id)).not.toHaveProperty("whole_file");
  });

  it("is left off once no whole read of the file is left after one that failed, while the cap allows two", async () => {
    const { files, log } = await library();
    // Two reads allowed: the count of reads alone would let a second one through.
    const failing = files.tools([log], { generate: async () => { throw new Error("The model refused the request."); }, retry: { retries: 0 }, maxWholeDocumentReads: 2 });
    expect(await read(failing, log.id)).toHaveProperty("whole_file");
    expect(await failing.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize the log." })).toHaveProperty("error");
    expect(failing.wholeReadsLeft!(log.id)).toBe(0);
    expect(await read(failing, log.id)).not.toHaveProperty("whole_file");
    // A read that worked leaves the second one, and the hint.
    const working = files.tools([log], { generate: notes, maxWholeDocumentReads: 2 });
    expect(await working.execute(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize the log." })).toHaveProperty("answer");
    expect(working.wholeReadsLeft!(log.id)).toBe(1);
    expect(await read(working, log.id)).toHaveProperty("whole_file");
  });

  it("is left off when the file has more parts than the call's maxRequests, which analyze_whole_document refuses", async () => {
    const { files, log } = await library();
    const parts = estimateParts(log, files.budget);
    expect(parts).toBeGreaterThan(1);
    const tools = files.tools([log], { generate: notes });
    expect(await readWith(tools, log.id, { maxRequests: parts })).toHaveProperty("whole_file");
    expect(await readWith(tools, log.id, { maxRequests: Number.POSITIVE_INFINITY })).toHaveProperty("whole_file");
    for (const maxRequests of [parts - 1, 1, 0]) expect(await readWith(tools, log.id, { maxRequests })).not.toHaveProperty("whole_file");
    // The read it would point at is refused with those requests, before any of them is sent.
    const refused = await tools.executeWithFiles(TOOL_NAMES.analyze, { document_id: log.id, task: "Summarize the log." }, { maxRequests: parts - 1 });
    expect(String(refused.result.error)).toMatch(/^Reading all of app\.log takes \d+ model requests, one for each part/);
  });

  it("is left off at the border of maxMapChunks, which the declaration lets through", async () => {
    // Parts of 500 tokens: the log has 21 or more by the estimate.
    const small = await library({ mapChunkTokens: 500 });
    const parts = estimateParts(small.log, small.files.budget);
    expect(parts).toBeGreaterThanOrEqual(21);
    const within = await library({ mapChunkTokens: 500, maxMapChunks: parts });
    expect(await read(within.files.tools([within.log], { generate: notes }), within.log.id)).toHaveProperty("whole_file");
    // One part fewer: within the margin of 5% that the declaration gives the estimate, so the read
    // is declared, but it may count more parts than it may read.
    const border = await library({ mapChunkTokens: 500, maxMapChunks: parts - 1 });
    expect(canBeReadWhole(border.log, border.files.budget)).toBe(true);
    const tools = border.files.tools([border.log], { generate: notes });
    expect(tools.declarations.map((declaration) => declaration.name)).toContain(TOOL_NAMES.analyze);
    expect(await read(tools, border.log.id)).not.toHaveProperty("whole_file");
  });

  it("says that not even one line fits when the first line of the range is cut", async () => {
    const { files } = await library();
    // Line 3 alone is longer than the room the result keeps for its text.
    const text = ["first", "second", "word ".repeat(380).trim(), ...Array.from({ length: 40 }, (_, index) => `line ${index + 4}`)].join("\n");
    const long = await files.ingest({ name: "long.txt", bytes: utf8(text) });
    const cut = await read(files.tools([long], { generate: notes }), long.id, 3, 10);
    expect(cut).toMatchObject({ lines: "3-3", text_cut: true, next_start_line: 4 });
    expect(cut.whole_file).toBe(`Not even one line fits here: the text of line 3 is cut. To read all ${long.lines} lines for a task that needs all of them, such as a full summary or a timeline, use analyze_whole_document.`);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(2_000);
    // One line that fits whole is still "Only 1 line fits here".
    expect(await read(files.tools([long], { generate: notes }), long.id, 2, 3)).toMatchObject({ lines: "2-2", whole_file: expect.stringMatching(/^Only 1 line fits here\. /) });
  });

  it("is left off when it would take the result past its cap", async () => {
    const { files, log } = await library();
    // A file name of 224 characters with 110 quote marks, each two characters in JSON: the lines
    // fill the room the result keeps for its text, and the name and the hint would not fit what is left.
    const named = await files.ingest({ name: `${'"ח'.repeat(110)}.log`, bytes: utf8(serviceLog(400)) });
    const cut = await read(files.tools([named], { generate: notes }), named.id);
    expect(shownOf(cut)).toBeLessThan(200);
    expect(cut).not.toHaveProperty("whole_file");
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(2_000);
    // The same lines of a file with a short name have it.
    expect(await read(files.tools([log], { generate: notes }), log.id)).toMatchObject({ lines: cut.lines, whole_file: hint(shownOf(cut), 400) });
  });
});

describe("read_document's whole_file in askWithFiles", () => {
  const question = [{ role: "user" as const, text: "Summarize the log." }];
  const readCall = (id: string, callId = "r") => ({ id: callId, name: "read_document", args: { document_id: id, start_line: 1, end_line: 200 } });
  const analyzeCall = (id: string) => ({ id: "a", name: "analyze_whole_document", args: { document_id: id, task: "Summarize the log." } });
  /** What the model got for each call of its first tool turn. */
  const firstTurn = async (files: Awaited<ReturnType<typeof library>>["files"], ids: string[], turn: ReturnType<typeof calls>, limits: Parameters<typeof askWithFiles>[0]["limits"]) => {
    const model = fakeModel([turn, says("Done.")], { generateText: notes });
    const result = await askWithFiles({ files, model, documentIds: ids, messages: question, ...(limits ? { limits } : {}) });
    return result.toolTurns[0]!.calls.map((call) => call.result);
  };

  /**
   * What the model got for each call of its first two tool turns: a read of lines, then the whole
   * read the hint points at, which it can call only on the turn after the read's.
   */
  const twoTurns = async (files: Awaited<ReturnType<typeof library>>["files"], id: string, usage: [number, number] | undefined, limits: Parameters<typeof askWithFiles>[0]["limits"]) => {
    const [first, second] = usage ? usage.map((inputTokens) => ({ usage: { inputTokens } })) : [{}, {}];
    const model = fakeModel([calls([readCall(id)], first), calls([analyzeCall(id)], second), says("Done.")], { generateText: notes });
    const result = await askWithFiles({ files, model, documentIds: [id], messages: question, ...(limits ? { limits } : {}) });
    return result.toolTurns.map((turn) => turn.calls[0]!.result);
  };

  it("is left off when the whole read, called on the next turn, would pass the question's ceiling on input tokens", async () => {
    const { files, log } = await library();
    const price = wholeReadCost(log, files.budget, 1).inputTokens;
    // Room for the read past the 1,000 tokens of the first request, but not for the request of the
    // next turn, which calls it: no hint, and the read the hint would point at is refused there.
    const [over, refused] = await twoTurns(files, log.id, [1_000, 1_000], { inputTokens: 1_000 + price });
    expect(shownOf(over!)).toBeLessThan(200);
    expect(over).not.toHaveProperty("whole_file");
    expect(String(refused!.error)).toMatch(/^Not run: reading all of app\.log takes about [\d,]+ input tokens/);
    // Room for the read past the first request and a second of 20,000 tokens, far more than the
    // conversation the first turn counts for it: the hint, and the read of the next turn runs.
    const [fits, read] = await twoTurns(files, log.id, [1_000, 20_000], { inputTokens: 1_000 + 20_000 + price });
    expect(shownOf(fits!)).toBe(shownOf(over!));
    expect(fits).toMatchObject({ whole_file: expect.stringMatching(/use analyze_whole_document\.$/) });
    expect(read).toHaveProperty("answer");
    expect(read).not.toHaveProperty("error");
  });

  it("is left off when the whole read, called on the next turn, would pass the question's ceiling on requests", async () => {
    const { files, log } = await library();
    const parts = estimateParts(log, files.budget);
    // One request made, one for the next turn, which calls the read; the read takes its parts, a
    // merge and its answer; and one is the answer of the question.
    const [cut, read] = await twoTurns(files, log.id, undefined, { requests: parts + 5 });
    expect(cut).toHaveProperty("whole_file");
    expect(read).toHaveProperty("answer");
    expect(read).not.toHaveProperty("error");
    // One fewer: no hint, and the read the hint would point at is refused on the next turn.
    const [over, refused] = await twoTurns(files, log.id, undefined, { requests: parts + 4 });
    expect(shownOf(over!)).toBe(shownOf(cut!));
    expect(over).not.toHaveProperty("whole_file");
    expect(String(refused!.error)).toMatch(/^Not run: reading all of app\.log takes about [\d,]+ model requests/);
  });

  it("is left off when the question has made its whole reads, or one of this turn takes the file's read", async () => {
    const { files, log } = await library();
    const turn = calls([readCall(log.id)]);
    expect(await firstTurn(files, [log.id], turn, {}).then(([result]) => result)).toHaveProperty("whole_file");
    expect(await firstTurn(files, [log.id], turn, { wholeReadsPerQuestion: 0 }).then(([result]) => result)).not.toHaveProperty("whole_file");
    // A read of the file in the same turn as its one whole read, called before it.
    const [cut, whole] = await firstTurn(files, [log.id], calls([readCall(log.id), analyzeCall(log.id)]), {});
    expect(whole).toHaveProperty("answer");
    expect(shownOf(cut!)).toBeLessThan(200);
    expect(cut).not.toHaveProperty("whole_file");
    // Another file's read is still pointed at.
    const other = await files.ingest({ name: "other.log", bytes: utf8(serviceLog(400)) });
    const [first, , second] = await firstTurn(files, [log.id, other.id], calls([readCall(log.id), analyzeCall(log.id), readCall(other.id, "r2")]), {});
    expect(first).not.toHaveProperty("whole_file");
    expect(second).toHaveProperty("whole_file");
  });

  it("is left off when a whole read of this turn takes the file's last read, before the tool set counts it", async () => {
    const { files, log } = await library();
    // Four calls of a turn run at once: the whole read, the fifth, starts once a read of lines has
    // ended, so the tool set's own count of reads does not have it yet. The ceilings are far above
    // the read, and the question may make two: only the file's one read, taken in the turn, holds the hint back.
    const reads = [1, 41, 81, 121].map((start, index) => ({ ...readCall(log.id, `r${index}`), args: { document_id: log.id, start_line: start, end_line: start + 199 } }));
    const turn = calls([...reads, analyzeCall(log.id)]);
    const results = await firstTurn(files, [log.id], turn, { inputTokens: 100_000_000 });
    expect(results.at(-1)).toHaveProperty("answer");
    for (const cut of results.slice(0, 4)) {
      expect(shownOf(cut!)).toBeLessThan(200);
      expect(cut).not.toHaveProperty("whole_file");
    }
    // Two reads of the file allowed: one is left after the turn's, and each read of lines points at it.
    const two = await firstTurn(files, [log.id], turn, { inputTokens: 100_000_000, wholeDocumentReads: 2 });
    expect(two.at(-1)).toHaveProperty("answer");
    for (const cut of two.slice(0, 4)) expect(cut).toHaveProperty("whole_file");
  });
});
