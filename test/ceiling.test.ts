// The ceiling on the input tokens of a question (0.10.0): a default one, checked before each tool
// request by looking ahead, counted by estimate for requests that report no usage, with room for
// whole-file reads; at most 2 whole-file reads per question; and a read that failed is refused
// with its own reason, not priced again (LLF-058).
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DEFAULT_INPUT_TOKENS,
  MemoryDocumentStore,
  type AskEvent,
  type AskOptions,
  type GenerateText,
  type LargeFiles,
  type ModelAdapter,
  type ToolSet,
  UsageMeter,
} from "llm-large-files";
import { wholeReadCost } from "../src/whole-cost.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
type Start = Extract<AskEvent, { type: "request.start" }>;

/** The estimates of the chat's requests, in order, and the notices, as the events tell them. */
function recorder() {
  const starts: Start[] = [];
  const codes: string[] = [];
  return {
    starts,
    codes,
    onEvent: (event: AskEvent) => {
      if (event.type === "request.start" && event.role !== "reader") starts.push(event);
      if (event.type === "notice") codes.push(event.code);
    },
    estimates: () => starts.map((start) => start.estimatedInputTokens ?? 0),
  };
}

/** probe2's log: 60,000 lines of a service log, searched with the tools. */
let probe2: Promise<{ files: LargeFiles; id: string }> | undefined;
const runawayLog = () => (probe2 ??= (async () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(60_000)) });
  return { files, id: meta.id };
})());

/** probe2's runaway model: every turn reads 8 more pieces of 600 lines, and it never answers on its own. */
function runaway(id: string, usage: (estimate: number) => number | undefined) {
  let n = 0;
  const estimates: number[] = [];
  const model = fakeModel([(request) => {
    if (request.toolChoice === "none") return says("From what I read.", { usage: { inputTokens: usage(estimates.at(-1) ?? 0) ?? 0 } });
    const reads = Array.from({ length: 8 }, () => {
      n++;
      return { id: `c${n}`, name: "read_document", args: { document_id: id, start_line: 1 + (n * 600) % 59_000, end_line: 600 + (n * 600) % 59_000 } };
    });
    const reported = usage(estimates.at(-1) ?? 0);
    return calls(reads, reported === undefined ? {} : { usage: { inputTokens: reported } });
  }]);
  return { model, estimates };
}

describe("the default ceiling", () => {
  it("stops probe2's runaway at the ceiling plus one request, counting by estimate when no usage is reported", async () => {
    const { files, id } = await runawayLog();
    const record = recorder();
    // probe2's model reports an input of 0 tokens: no usage, as far as the ceiling can tell.
    const { model } = runaway(id, () => 0);
    const result = await askWithFiles({ files, model, documentIds: [id], messages: question("q"), onEvent: record.onEvent });
    // 0.9 made 13 requests of about 6.9M tokens in all.
    expect(model.requests.length).toBeLessThan(13);
    expect(model.requests.at(-1)!.toolChoice).toBe("none");
    expect(record.codes.filter((code) => code === "budget_reached")).toHaveLength(1);
    const spent = result.usage.inputTokens + (result.usage.estimatedInputTokens ?? 0);
    expect(result.usage).toMatchObject({ inputTokens: 0, unmeasuredRequests: model.requests.length });
    expect(result.usage.estimatedInputTokens).toBe(record.estimates().reduce((sum, tokens) => sum + tokens, 0));
    // The ceiling is DEFAULT_INPUT_TOKENS: 12 times the first request is less, and no file can be read whole here.
    expect(12 * record.estimates()[0]!).toBeLessThan(DEFAULT_INPUT_TOKENS);
    expect(spent).toBeLessThanOrEqual(DEFAULT_INPUT_TOKENS + record.estimates().at(-1)!);
    expect(spent).toBeGreaterThan(DEFAULT_INPUT_TOKENS / 2);
  }, 60_000);

  it("is toolTurns times the first request when that is larger", async () => {
    const { files, id } = await runawayLog();
    // A first request made large by a long conversation raises the ceiling with it.
    const long = [{ role: "user" as const, text: "Earlier question. ".repeat(40_000) }, { role: "assistant" as const, text: "Earlier answer." }, ...question("q")];
    const big = recorder();
    const second = runaway(id, () => 0);
    await askWithFiles({ files, model: second.model, documentIds: [id], messages: long, onEvent: big.onEvent });
    const firstBig = big.estimates()[0]!;
    const spentBig = big.estimates().reduce((sum, tokens) => sum + tokens, 0);
    expect(12 * firstBig).toBeGreaterThan(DEFAULT_INPUT_TOKENS);
    expect(spentBig).toBeGreaterThan(DEFAULT_INPUT_TOKENS);
    expect(spentBig).toBeLessThanOrEqual(12 * firstBig + big.estimates().at(-1)!);
  }, 60_000);

  it("is turned off by Infinity, as in 0.9", async () => {
    const { files, id } = await runawayLog();
    const { model } = runaway(id, () => 0);
    const result = await askWithFiles({ files, model, documentIds: [id], messages: question("q"), limits: { inputTokens: Infinity, toolTurns: 6 } });
    // Every tool turn ran, then the answer.
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "auto", "auto", "auto", "none"]);
    expect(result.usage.estimatedInputTokens).toBeGreaterThan(0);
  }, 60_000);

  it("leaves typical questions as they were: a 3 MB log and 4 tool turns stay under half of it, with the same requests", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "service.log", bytes: utf8(serviceLog(33_000)) });
    expect(meta.bytes).toBeGreaterThan(2_900_000);
    const script = () => fakeModel([
      calls([{ id: "a", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }], { usage: { inputTokens: 9_000 } }),
      calls([{ id: "b", name: "read_document", args: { document_id: meta.id, start_line: 90, end_line: 300 } }], { usage: { inputTokens: 14_000 } }),
      calls([{ id: "c", name: "search_document", args: { document_id: meta.id, query: "WARN", mode: "exact", max_results: 30 } }], { usage: { inputTokens: 22_000 } }),
      calls([{ id: "d", name: "read_document", args: { document_id: meta.id, start_line: 9_000, end_line: 9_400 } }], { usage: { inputTokens: 30_000 } }),
      says("There are 340 errors (service.log L97).", { usage: { inputTokens: 41_000 } }),
    ]);
    const capped = script();
    const open = script();
    const asked = (model: ModelAdapter, limits?: AskOptions["limits"]) => askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors, and what happened around them?"), ...(limits ? { limits } : {}) });
    const result = await asked(capped);
    await asked(open, { inputTokens: Infinity });
    expect(result.plan.searchable).toHaveLength(1);
    expect(result).toMatchObject({ answered: true, turns: 5 });
    expect(result.usage.inputTokens).toBeLessThan(DEFAULT_INPUT_TOKENS / 2);
    expect(JSON.stringify(capped.requests)).toBe(JSON.stringify(open.requests));
  }, 60_000);
});

describe("a ceiling that is set", () => {
  it("holds within one request when usage is reported: 500,000 lets at most one request past it", async () => {
    const { files, id } = await runawayLog();
    const record = recorder();
    // The provider reports the estimate of each request as its input.
    const { model } = runaway(id, () => record.estimates().at(-1));
    const result = await askWithFiles({ files, model, documentIds: [id], messages: question("q"), limits: { inputTokens: 500_000 }, onEvent: record.onEvent });
    // 0.9 checked the ceiling only after each request, and spent 1,219,683 here.
    expect(result.usage.inputTokens).toBeLessThanOrEqual(500_000 + record.estimates().at(-1)!);
    expect(result.usage.unmeasuredRequests).toBeUndefined();
    expect(model.requests.at(-1)!.toolChoice).toBe("none");
    expect(record.codes.filter((code) => code === "budget_reached")).toHaveLength(1);
  }, 60_000);

  it("stops by estimate when the provider reports no usage at all", async () => {
    const { files, id } = await runawayLog();
    const record = recorder();
    const { model } = runaway(id, () => undefined);
    const result = await askWithFiles({ files, model, documentIds: [id], messages: question("q"), limits: { inputTokens: 500_000 }, onEvent: record.onEvent });
    // 0.9 never stopped: every one of the 12 requests, the last one the answer.
    expect(model.requests.length).toBeLessThan(12);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.estimatedInputTokens).toBeLessThanOrEqual(500_000 + record.estimates().at(-1)!);
  }, 60_000);

  it("counts the part reads of a whole-file read that report no usage by their estimate", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 8_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    let parts = 0;
    const generateText: GenerateText = async () => {
      parts++;
      return "Notes (L97).";
    };
    const model = fakeModel([calls([{ id: "a", name: "analyze_whole_document", args: { document_id: meta.id, task: "errors" } }], { usage: { inputTokens: 3_000 } }), says("Done.", { usage: { inputTokens: 4_000 } })], { generateText });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("Which errors?") });
    expect(parts).toBeGreaterThan(2);
    // Each part sends its share of the log's lines: together about the log's tokens, and more.
    expect(result.usage).toMatchObject({ inputTokens: 7_000, unmeasuredRequests: parts });
    expect(result.usage.estimatedInputTokens).toBeGreaterThan(meta.estimatedTokens);
  }, 60_000);
});

describe("whole-file reads under the ceiling", () => {
  it("lets probe5's read run with the default ceiling: the room for whole-file reads", async () => {
    // probe5: a log of 20,000 lines (1.77 MB) read in parts of 60,000 tokens, about 1.5M tokens a read.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 60_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
    let parts = 0;
    const generateText: GenerateText = async () => {
      parts++;
      return "Nothing much (L1).";
    };
    const model = fakeModel([calls([{ id: "a", name: "analyze_whole_document", args: { document_id: meta.id, task: "list every failure with its time" } }]), says("Done.")], { generateText });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("List every failure with its time.") });
    // The read costs more than DEFAULT_INPUT_TOKENS: without the room for it, it would be refused.
    expect(wholeReadCost(meta, result.budget, 1).inputTokens).toBeGreaterThan(DEFAULT_INPUT_TOKENS);
    expect(parts).toBe(26);
    expect(result.evidence).toEqual([expect.objectContaining({ tool: "analyze_whole_document", whole: true })]);
    expect(result.toolTurns[0]!.calls[0]!.result.error).toBeUndefined();
  }, 60_000);

  it("refuses a third whole-file read in one question (wholeReadsPerQuestion), and Infinity gives 0.9's rule", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 8_000 } });
    const logs = await Promise.all(["a.log", "b.log", "c.log"].map((name) => files.ingest({ name, bytes: utf8(serviceLog(1_500)) })));
    const reads = logs.map((meta, index) => ({ id: `r${index}`, name: "analyze_whole_document", args: { document_id: meta.id, task: "errors" } }));
    const generateText: GenerateText = async () => "Notes (L97).";
    const asked = async (limits?: AskOptions["limits"]) => {
      const events: AskEvent[] = [];
      const model = fakeModel([calls(reads), says("Done.")], { generateText });
      const result = await askWithFiles({ files, model, documentIds: logs.map((meta) => meta.id), messages: question("Errors?"), ...(limits ? { limits } : {}), onEvent: (event) => events.push(event) });
      return { result, events };
    };
    const { result, events } = await asked();
    const [first, second, third] = result.toolTurns[0]!.calls;
    expect(first!.result.error).toBeUndefined();
    expect(second!.result.error).toBeUndefined();
    expect(third!.result.error).toBe("Not run: one question makes at most 2 whole-file reads, and this one has made them. Use search_document and read_document on c.log.");
    expect(events.filter((event) => event.type === "tool.end").map((event) => (event as { outcome: string }).outcome)).toEqual(["ok", "ok", "refused"]);
    // In later turns too.
    const again = fakeModel([calls(reads.slice(0, 2)), calls(reads.slice(2)), says("Done.")], { generateText });
    const later = await askWithFiles({ files, model: again, documentIds: logs.map((meta) => meta.id), messages: question("Errors?") });
    expect(later.toolTurns[1]!.calls[0]!.result.error).toMatch(/^Not run: one question makes at most 2 whole-file reads/);

    const open = await asked({ wholeReadsPerQuestion: Infinity });
    expect(open.result.toolTurns[0]!.calls.map((call) => call.result.error)).toEqual([undefined, undefined, undefined]);
    const one = await asked({ wholeReadsPerQuestion: 1 });
    expect(one.result.toolTurns[0]!.calls[1]!.result.error).toBe("Not run: one question makes at most 1 whole-file read, and this one has made it. Use search_document and read_document on b.log.");
  }, 60_000);

  it("refuses a whole-file read that would pass the ceiling with the price of wholeReadCost", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 8_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const model = fakeModel([calls([{ id: "a", name: "analyze_whole_document", args: { document_id: meta.id, task: "errors" } }], { usage: { inputTokens: 1_000 } }), says("Done.")], { generateText: async () => "Notes." });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), limits: { inputTokens: 250_000 } });
    const price = wholeReadCost(meta, result.budget, 1).inputTokens;
    // The price counts the line numbers, the prompts and the merges: more than the document's tokens.
    expect(price).toBeGreaterThan(meta.estimatedTokens);
    expect(price).toBeGreaterThan(249_000);
    expect(result.toolTurns[0]!.calls[0]!.result.error).toBe(`Not run: reading all of app.log takes about ${price.toLocaleString("en-US")} input tokens, and 249,000 are left of the 250,000 this question may use. Use search_document and read_document.`);
  }, 60_000);
});

describe("LLF-058: a whole-file read that failed", () => {
  it("is refused again with its own reason, not priced again (probe3)", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 50_000, inlineTokens: 10 } });
    const meta = await files.ingest({ name: "big.log", bytes: utf8(serviceLog(6_000)) });
    const generateText: GenerateText = async () => {
      throw Object.assign(new Error("boom"), { status: 400 });
    };
    const model = fakeModel([
      calls([{ id: "a1", name: "analyze_whole_document", args: { document_id: meta.id, task: "summary" } }], { usage: { inputTokens: 10_000 } }),
      calls([{ id: "a2", name: "analyze_whole_document", args: { document_id: meta.id, task: "summary again" } }], { usage: { inputTokens: 380_000 } }),
      says("answer"),
    ], { generateText });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("q"), limits: { inputTokens: 600_000 } });
    expect(result.toolTurns[0]!.calls[0]!.result.error).toMatch(/^Could not read any part of big\.log/);
    // 0.9 priced it again: "Not run: reading all of big.log takes about …".
    expect(result.toolTurns[1]!.calls[0]!.result.error).toMatch(/^The whole-file read of big\.log failed earlier in this question \(.*\), and is not tried again\./);
  }, 60_000);

  it("takes the word of a tool set that says no read is left (wholeReadsLeft)", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 8_000, inlineTokens: 10 } });
    const meta = await files.ingest({ name: "big.log", bytes: utf8(serviceLog(3_000)) });
    const own: LargeFiles = {
      ...files,
      tools(documents, options) {
        const real = files.tools(documents, options);
        const set: ToolSet = {
          ...real,
          wholeReadsLeft: () => 0,
          async executeWithFiles(name, args, limits, hooks) {
            if (name === "analyze_whole_document") return { result: { error: "big.log was read whole by another means." }, files: [] };
            return real.executeWithFiles(name, args, limits, hooks);
          },
        };
        return set;
      },
    };
    const model = fakeModel([calls([{ id: "a", name: "analyze_whole_document", args: { document_id: meta.id, task: "errors" } }], { usage: { inputTokens: 1_000 } }), says("Done.")], { generateText: async () => "Notes." });
    const result = await askWithFiles({ files: own, model, documentIds: [meta.id], messages: question("?"), limits: { inputTokens: 20_000 } });
    // Not the price (the read would pass 20,000), but the tool set's own reason.
    expect(result.toolTurns[0]!.calls[0]!.result.error).toBe("big.log was read whole by another means.");
  }, 60_000);
});

describe("UsageMeter", () => {
  it("counts a request without its input by the estimate it is given, apart from the reported tokens", () => {
    const meter = new UsageMeter();
    meter.add("m", { inputTokens: 1_000, outputTokens: 10 }, 900);
    expect(meter.totals).not.toHaveProperty("estimatedInputTokens");
    meter.add("m", undefined, 1_200.4);
    meter.add("m", { inputTokens: 0, outputTokens: 5 }, 800);
    // Without an estimate, as before 0.10.0.
    meter.add("m", undefined);
    expect(meter.totals).toMatchObject({ requests: 4, inputTokens: 1_000, outputTokens: 15, estimatedInputTokens: 1_201 + 800, unmeasuredRequests: 2 });
    expect(meter.totals.byModel.m).toEqual({ requests: 4, inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 15, thoughtTokens: 0 });
  });
});
