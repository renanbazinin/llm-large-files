// The ceiling of askWithFiles prices a whole-file read before it lets it run (0.10.0): a read that
// lists items (`output: "items"`) at its parts alone, in input tokens and in requests, and an answer
// read at its parts, a merge of their notes and its answer. Before, every read was priced as an
// answer read, so an items read that fitted was refused.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type LargeFiles, type ModelRequest, type ModelToolRound, type ToolResult } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";
import { estimateParts } from "../src/plan.js";
import { wholeReadCost } from "../src/whole-cost.js";

const question = (text: string) => ({ role: "user" as const, text });
/** The results of the tool rounds of a request, in order. */
const resultsOf = (request: ModelRequest): ToolResult[] => request.messages.filter((message): message is ModelToolRound => message.role === "tools").flatMap((round) => round.answers.map((answer) => answer.result));

async function library(budget: Record<string, number> = {}): Promise<LargeFiles> {
  return createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget });
}

describe("a whole-file read that lists items is priced at its parts", () => {
  it("runs an items read within limits.requests where an answer read of the same file is refused", async () => {
    const budget = { inlineTokens: 1_000, mapChunkTokens: 4_000 };
    const files = await library(budget);
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(1_000)) });
    const parts = estimateParts(meta, files.budgetFor(budget));
    expect(parts).toBeGreaterThan(2);
    const read = (output: "answer" | "items") => ({ id: "c1", name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors.", output } });
    const run = async (output: "answer" | "items") => {
      let partReads = 0;
      const generateText = async () => {
        partReads++;
        return "NOTHING RELEVANT";
      };
      const model = fakeModel([calls([read(output)]), says("Done.")], { generateText });
      // The first chat request, the read's parts, and the answer: an items read takes all of them.
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("List the errors.")], limits: { requests: parts + 2 } });
      return { result, partReads, sent: resultsOf(model.requests[1]!)[0]! };
    };
    const items = await run("items");
    expect(items.sent.error).toBeUndefined();
    expect(items.partReads).toBe(parts);
    expect(items.result.usage.requests).toBe(parts + 2);
    const answer = await run("answer");
    expect(answer.partReads).toBe(0);
    expect(answer.sent.error).toBe(`Not run: reading all of app.log takes about ${parts + 3} model requests, and ${parts + 1} are left of the ${parts + 2} this question may make. Use search_document and read_document.`);
  });

  it("says 1 is left, in the singular, when one request is left", async () => {
    const budget = { inlineTokens: 1_000, mapChunkTokens: 4_000 };
    const files = await library(budget);
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(1_000)) });
    const parts = estimateParts(meta, files.budgetFor(budget));
    const model = fakeModel([calls([{ id: "c1", name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors.", output: "answer" } }]), says("Done.")], { generateText: async () => "NOTHING RELEVANT" });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("List the errors.")], limits: { requests: 2 } });
    expect(resultsOf(model.requests[1]!)[0]!.error).toBe(`Not run: reading all of app.log takes about ${parts + 3} model requests, and 1 is left of the 2 this question may make. Use search_document and read_document.`);
  });

  it("prices an items read at its parts against the ceiling of input tokens", async () => {
    const budget = { inlineTokens: 1_000, mapChunkTokens: 4_000 };
    const files = await library(budget);
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const priced = (output: "answer" | "items") => wholeReadCost(meta, files.budgetFor(budget), 1, output).inputTokens;
    expect(priced("items")).toBeLessThan(priced("answer"));
    const refusal = async (output: "answer" | "items") => {
      const model = fakeModel([calls([{ id: "c1", name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors.", output } }]), says("Done.")], { generateText: async () => "NOTHING RELEVANT" });
      await askWithFiles({ files, model, documentIds: [meta.id], messages: [question("List the errors.")], limits: { inputTokens: 40_000 } });
      return String(resultsOf(model.requests[1]!)[0]!.error);
    };
    expect(await refusal("items")).toMatch(new RegExp(`^Not run: reading all of app\\.log takes about ${priced("items").toLocaleString("en-US")} input tokens`));
    expect(await refusal("answer")).toMatch(new RegExp(`^Not run: reading all of app\\.log takes about ${priced("answer").toLocaleString("en-US")} input tokens`));
  });
});
