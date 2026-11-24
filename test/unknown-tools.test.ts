// LLF-049 (0.10.0): a call of a tool the question does not have is refused by the loop before the
// room is planned. It says which tools there are, has outcome "refused", and takes no room: in 0.9
// it was given room at the cap of a result, and a turn of such calls shortened the results of the
// earlier turns for nothing.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type LargeFiles, type ModelMessage, type ModelToolRound, type ToolCallLimits } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");
const TOOLS = "The tools are: search_document, read_document, get_document_overview.";

describe("a call of an unknown tool", () => {
  it("shortens nothing on a 40K window (probe1)", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, contextTokens: 40_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(6_000)) });
    const script = [];
    for (let i = 0; i < 7; i++) script.push(calls([{ id: `r${i}`, name: "read_document", args: { document_id: meta.id, start_line: 1 + i * 200, end_line: 200 + i * 200 } }]));
    script.push(calls(Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, name: `lookup_ticket_${i}`, args: {} }))));
    script.push(says("done"));
    const model = fakeModel(script);
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("q"), limits: { toolTurns: 12 }, onEvent: (event) => events.push(event) });
    // 0.9 shortened 4 rounds to stand-ins here, to make room for 8 results that are a line each.
    expect(result.steps.filter((line) => line.includes("shortened"))).toEqual([]);
    expect(result.toolTurns.filter((turn) => turn.calls.some((call) => call.result.dropped))).toHaveLength(0);
    expect(result.toolTurns.at(-1)!.calls.map((call) => call.result.error)).toEqual(Array.from({ length: 8 }, (_, i) => `Unknown tool “lookup_ticket_${i}”. ${TOOLS}`));
    const ends = events.filter((event): event is Extract<AskEvent, { type: "tool.end" }> => event.type === "tool.end").slice(-8);
    expect(ends.map((event) => event.outcome)).toEqual(Array(8).fill("refused"));
    expect(result.text).toBe("done");
  });

  it("leaves its room to the calls of the turn that run", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, contextTokens: 40_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(6_000)) });
    const given: Array<ToolCallLimits | undefined> = [];
    const own: LargeFiles = {
      ...files,
      tools(documents, options) {
        const real = files.tools(documents, options);
        return { ...real, executeWithFiles: (name, args, limits, hooks) => {
          given.push(limits);
          return real.executeWithFiles(name, args, limits, hooks);
        } };
      },
    };
    const read = { id: "r", name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 600 } };
    const unknown = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, name: `lookup_${i}`, args: {} }));
    const model = fakeModel([calls([read, ...unknown]), says("done")]);
    await askWithFiles({ files: own, model, documentIds: [meta.id], messages: question("q") });
    // Only the read ran, and it was given the room whole: in 0.9 it shared it with 7 calls that do not exist.
    expect(given).toHaveLength(1);
    const alone = fakeModel([calls([read]), says("done")]);
    const before = given.length;
    await askWithFiles({ files: own, model: alone, documentIds: [meta.id], messages: question("q") });
    expect(given[before]).toEqual(given[0]);
    expect(roundsOf(model.requests[1]!.messages)[0]!.answers.slice(1).every((answer) => answer.result.error === `Unknown tool “${answer.call.name}”. ${TOOLS}`)).toBe(true);
  });
});
