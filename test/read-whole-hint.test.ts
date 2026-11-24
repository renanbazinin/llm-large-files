// `read_document`'s `whole_file` (0.10.0): a read cut short of its range by the size limit says that
// `analyze_whole_document` reads all of the file, when the tool set declares that read, can run it,
// and the file can be read whole. Gemini Flash-Lite and Flash read a contract to summarize in ranges
// of about 16 lines and answered from those (evals/results/0100-t-live-3.md). Each test checks a
// read that has the hint next to one that must not: each fails without it.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, TOOL_NAMES, type GenerateText, type ToolSet } from "../src/index.js";
import { serviceLog, utf8 } from "./fake-model.js";

const notes: GenerateText = async () => "The worker answered in time (L1).";

/** A library whose tool results have 2,000 characters, and a log of 400 lines, about 100 characters each. */
async function library(budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 4_000, toolResultCharacters: 2_000, ...budget } });
  const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(400)) });
  return { files, log };
}

const read = (tools: ToolSet, id: string, start = 1, end = 200) => tools.execute(TOOL_NAMES.read, { document_id: id, start_line: start, end_line: end });

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
