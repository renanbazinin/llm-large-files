import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DocumentsNotFoundError,
  FINAL_ANSWER_REQUEST,
  FINAL_ANSWER_WITHOUT_TOOLS,
  MemoryDocumentStore,
  type GenerateText,
  type ModelMessage,
  type ModelToolRound,
  type RetryOptions,
} from "llm-large-files";
import { calls, fakeModel, httpError, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");
const textOf = (message: ModelMessage | undefined) => (message && message.role !== "tools" ? message.parts.map((part) => part.text ?? "").join("\n") : "");

/** A wait that takes no time, and notes how long it was asked to be. */
function quickRetry(more: RetryOptions = {}): { retry: RetryOptions; waits: number[] } {
  const waits: number[] = [];
  return { waits, retry: { random: () => 1, sleep: async (ms) => { waits.push(ms); }, ...more } };
}

async function largeLog(lines = 5_000, budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(lines)) });
  return { files, meta };
}

describe("askWithFiles", () => {
  it("sends a document that fits in full, in one request without tools", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    const model = fakeModel([says("Heron.", { finishReason: "stop", usage: { inputTokens: 40, outputTokens: 3 }, providerUsage: { prompt: 40 } })]);
    const deltas: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], system: "Be brief.", messages: question("What is the code word?"), onText: (delta) => deltas.push(delta) });
    expect(model.requests).toHaveLength(1);
    const [request] = model.requests;
    expect(request!.tools).toBeUndefined();
    expect(request!.system).toBe("Be brief.");
    // The document first, the question last, in the one user turn.
    expect(request!.messages).toHaveLength(1);
    expect(textOf(request!.messages[0])).toMatch(/^--- Attached file: notes\.md[\s\S]*The code word is heron\.[\s\S]*What is the code word\?$/);
    expect(result).toMatchObject({ text: "Heron.", answered: true, steps: [], evidence: [], toolTurns: [], turns: 1, finishReason: "stop", lastUsage: { prompt: 40 } });
    expect(result.usage).toEqual({ requests: 1, inputTokens: 40, cachedInputTokens: 0, outputTokens: 3, thoughtTokens: 0, byModel: { "fake-model": { requests: 1, inputTokens: 40, cachedInputTokens: 0, outputTokens: 3, thoughtTokens: 0 } } });
    expect(deltas.join("")).toBe("Heron.");
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("runs the tool loop, hands a model its own turn back, and answers", async () => {
    const { files, meta } = await largeLog();
    const search = { id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 3 } };
    const model = fakeModel([calls([search], { text: "Checking." }), says("51 errors (app.log L97).")]);
    const steps: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), onStep: (step) => steps.push(step) });
    const [first, second] = model.requests;
    expect(first!.tools!.map((tool) => tool.name)).toEqual(["search_document", "read_document", "get_document_overview"]);
    expect(first!.toolChoice).toBe("auto");
    expect(first!.system).toMatch(/^Some attached files are too large for your context/);
    const [round] = roundsOf(second!.messages);
    // Its own turn, as it came, and the result of the call.
    expect(round!.raw).toEqual({ own: ["search_document"] });
    expect(round!.calls).toEqual([search]);
    expect(round!.answers[0]!.result).toMatchObject({ document: "app.log", total_matching_lines: 51, tool_turns_left: 10 });
    expect(result).toMatchObject({ text: "Checking.\n\n51 errors (app.log L97).", answered: true, turns: 2 });
    expect(result.steps).toEqual(["Search app.log (exact) for “ERROR” — 51 matching lines"]);
    expect(steps).toEqual(result.steps);
  });

  it("refuses documents of another owner before any request", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("secret"), owner: "alice" });
    const model = fakeModel([says("no")]);
    await expect(askWithFiles({ files, model, documentIds: [meta.id], owner: "bob", messages: question("?") })).rejects.toBeInstanceOf(DocumentsNotFoundError);
    await expect(askWithFiles({ files, model, documentIds: [], messages: [{ role: "assistant", text: "hi" }] })).rejects.toThrow("The last message must be the user's.");
    expect(model.requests).toHaveLength(0);
  });
});

describe("a model request that fails", () => {
  it("is sent again after a wait that doubles, and the steps taken so far are kept", async () => {
    const { files, meta } = await largeLog();
    const read = { name: "read_document", args: { document_id: meta.id, start_line: 90, end_line: 99 } };
    const model = fakeModel([calls([read]), httpError(503, "The model is overloaded."), httpError(503, "The model is overloaded."), says("Line 97 has the error.")]);
    const { retry, waits } = quickRetry();
    const activity: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry, onActivity: (text) => activity.push(text) });
    expect(model.requests).toHaveLength(4);
    expect(waits).toEqual([500, 1_000]);
    expect(activity.filter((text) => text.startsWith("The model did not answer"))).toEqual([
      "The model did not answer (HTTP 503). Trying again…",
      "The model did not answer (HTTP 503). Trying again in 1 s…",
    ]);
    // Two requests were answered: the failed ones are neither turns nor usage.
    expect(result).toMatchObject({ text: "Line 97 has the error.", answered: true, turns: 2, steps: ["Read app.log lines 90-99"] });
    expect(result.usage.requests).toBe(2);
  });

  it("gives up after the tries it is allowed, and at once for a request the model refused", async () => {
    const { files, meta } = await largeLog();
    const busy = fakeModel([httpError(429, "quota exceeded")]);
    const { retry, waits } = quickRetry({ retries: 2 });
    await expect(askWithFiles({ files, model: busy, documentIds: [meta.id], messages: question("?"), retry })).rejects.toMatchObject({ status: 429, message: "quota exceeded" });
    expect(busy.requests).toHaveLength(3);
    expect(waits).toEqual([500, 1_000]);

    for (const status of [400, 401, 403, 404]) {
      const refused = fakeModel([httpError(status)]);
      await expect(askWithFiles({ files, model: refused, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry })).rejects.toMatchObject({ status });
      expect(refused.requests).toHaveLength(1);
    }
    const off = fakeModel([httpError(503)]);
    await expect(askWithFiles({ files, model: off, documentIds: [meta.id], messages: question("?"), retry: { retries: 0 } })).rejects.toMatchObject({ status: 503 });
    expect(off.requests).toHaveLength(1);
  });

  it("waits as long as the provider asks, unless that is longer than the caller allows", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([httpError(429, "slow down", 17_000), says("ok")]);
    const { retry, waits } = quickRetry();
    const activity: string[] = [];
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry, onActivity: (text) => activity.push(text) });
    expect(waits).toEqual([17_000]);
    expect(activity).toContain("The model did not answer (HTTP 429). Trying again in 17 s…");

    const long = fakeModel([httpError(429, "come back in ten minutes", 600_000), says("ok")]);
    const patient = quickRetry({ maxDelayMs: 30_000 });
    await expect(askWithFiles({ files, model: long, documentIds: [meta.id], messages: question("?"), retry: patient.retry })).rejects.toMatchObject({ status: 429 });
    expect(patient.waits).toEqual([]);
    expect(long.requests).toHaveLength(1);
  });

  it("is not sent again once text of it was shown, or after the question was stopped", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("alpha") });
    const broken = fakeModel([(_request, _call, hooks) => {
      hooks.onText?.("The answer is ");
      return httpError(0, "The model could not be reached (terminated).");
    }]);
    const shown: string[] = [];
    await expect(askWithFiles({ files, model: broken, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry, onText: (delta) => shown.push(delta) })).rejects.toMatchObject({ status: 0 });
    expect(broken.requests).toHaveLength(1);
    expect(shown).toEqual(["The answer is "]);

    // The same failure before any text was shown: a connection that failed is worth another try.
    const unreachable = fakeModel([httpError(0, "The model could not be reached."), says("alpha")]);
    expect((await askWithFiles({ files, model: unreachable, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry, onText: () => undefined })).text).toBe("alpha");

    const stop = new AbortController();
    const stopped = fakeModel([() => {
      stop.abort(new Error("stopped by the user"));
      return httpError(503);
    }]);
    await expect(askWithFiles({ files, model: stopped, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry, signal: stop.signal })).rejects.toMatchObject({ status: 503 });
    expect(stopped.requests).toHaveLength(1);
  });
});

describe("usage of a question", () => {
  it("is summed over every request, part reads included, for each model", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    let parts = 0;
    const partReader: GenerateText = async ({ system, onUsage }) => {
      parts++;
      onUsage?.({ inputTokens: 40_000, cachedInputTokens: 0, outputTokens: 200, thoughtTokens: 50 });
      return system.includes("complete answer") ? "Errors on every 97th line." : "ERROR at (L97).";
    };
    const explorer = fakeModel([
      calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } }], { usage: { inputTokens: 1_000, outputTokens: 20 } }),
      says("DONE", { usage: { inputTokens: 1_500, cachedInputTokens: 900, outputTokens: 2 } }),
    ], { id: "explorer", generateText: partReader });
    const model = fakeModel([says("Every 97th line is an error.", { usage: { inputTokens: 1_600, outputTokens: 30, thoughtTokens: 10 }, providerUsage: { own: true } })], { id: "answerer" });
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("Which errors?") });
    expect(parts).toBeGreaterThan(2);
    expect(result.turns).toBe(3);
    expect(result.usage.byModel.answerer).toEqual({ requests: 1, inputTokens: 1_600, cachedInputTokens: 0, outputTokens: 30, thoughtTokens: 10 });
    expect(result.usage.byModel.explorer).toEqual({ requests: 2 + parts, inputTokens: 2_500 + parts * 40_000, cachedInputTokens: 900, outputTokens: 22 + parts * 200, thoughtTokens: parts * 50 });
    expect(result.usage).toMatchObject({ requests: 3 + parts, inputTokens: 4_100 + parts * 40_000, outputTokens: 52 + parts * 200 });
    expect(result.lastUsage).toEqual({ own: true });
  });

  it("stops the tools at a ceiling on input tokens, and does not start a whole-file read that would pass it", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    let parts = 0;
    const generateText: GenerateText = async () => {
      parts++;
      return "notes";
    };
    const analyze = { name: "analyze_whole_document", args: { document_id: meta.id, task: "everything" } };
    const read = { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 5 } };
    const model = fakeModel([
      calls([analyze], { usage: { inputTokens: 2_000 } }),
      calls([read], { usage: { inputTokens: 2_500 } }),
      calls([read], { usage: { inputTokens: 3_000 } }),
      (request) => (request.toolChoice === "none" ? says("From what I have.") : calls([read], { usage: { inputTokens: 3_000 } })),
    ], { generateText });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), limits: { inputTokens: 7_000 } });
    // The read of the whole file would take far more than is left: it is refused with the numbers.
    expect(parts).toBe(0);
    const [first] = roundsOf(model.requests[1]!.messages);
    expect(first!.answers[0]!.result.error).toMatch(/^Not run: reading all of app\.log takes about [\d,]+ input tokens, and 5,000 are left of the 7,000 this question may use\./);
    // 2,000 + 2,500 + 3,000 input tokens is over the ceiling: the next request is the answer.
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "auto", "none"]);
    expect(result).toMatchObject({ text: "From what I have.", answered: true, turns: 4 });

    const few = fakeModel([calls([read]), calls([read]), (request) => (request.toolChoice === "none" ? says("ok") : calls([read]))]);
    await askWithFiles({ files, model: few, documentIds: [meta.id], messages: question("?"), limits: { requests: 3 } });
    expect(few.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none"]);
  });
});

describe("the tool calls of one turn", () => {
  it("run together, and are answered in the order they were made", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, mapChunkTokens: 40_000 } });
    const first = await files.ingest({ name: "first.log", bytes: utf8(serviceLog(3_000)) });
    const second = await files.ingest({ name: "second.log", bytes: utf8(serviceLog(3_000)) });
    let reading = 0;
    let most = 0;
    const order: string[] = [];
    const generateText: GenerateText = async ({ prompt }) => {
      reading++;
      most = Math.max(most, reading);
      order.push(/Document: (\S+),/.exec(prompt)?.[1] ?? "answer");
      // Long enough for the second read to start on a slow machine while the first has parts on their way.
      await new Promise((resolve) => setTimeout(resolve, 60));
      reading--;
      return "NOTHING RELEVANT";
    };
    const whole = (id: string) => ({ name: "analyze_whole_document", args: { document_id: id, task: "List every error." } });
    const model = fakeModel([
      calls([whole(first.id), { name: "read_document", args: { document_id: second.id, start_line: 1, end_line: 2 } }, whole(second.id)]),
      says("Nothing."),
    ], { generateText });
    const steps: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [first.id, second.id], messages: question("Errors?"), onStep: (step) => steps.push(step) });
    // Each read of a whole file sends four parts at a time: more than four at once means the two reads overlapped.
    expect(most).toBeGreaterThan(4);
    expect(new Set(order.slice(0, 6)).size).toBe(2);
    const [round] = roundsOf(model.requests[1]!.messages);
    expect(round!.answers.map((answer) => answer.result.document)).toEqual(["first.log", "second.log", "second.log"]);
    expect(result.steps.map((step) => step.split(" — ")[0])).toEqual(["Read all of first.log for “List every error.”", "Read second.log lines 1-2", "Read all of second.log for “List every error.”"]);
    expect(steps).toEqual(result.steps);
  });

  it("reads a file whole once for a question, however the model asks again", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    let parts = 0;
    const generateText: GenerateText = async () => {
      parts++;
      return "Errors at (L97).";
    };
    const whole = (task: string) => ({ name: "analyze_whole_document", args: { document_id: meta.id, task } });
    const script = () => fakeModel([calls([whole("List every ERROR"), whole("Build a timeline")]), calls([whole("Count the errors")]), says("Done.")], { generateText });
    const once = script();
    const result = await askWithFiles({ files, model: once, documentIds: [meta.id], messages: question("?") });
    const perRead = parts;
    expect(perRead).toBeGreaterThan(2);
    const answers = roundsOf(once.requests[2]!.messages).flatMap((round) => round.answers.map((answer) => answer.result));
    expect(answers[0]).toMatchObject({ document: "app.log", answer: "Errors at (L97)." });
    for (const refused of answers.slice(1)) {
      expect(refused.error).toBe("app.log was already read whole for this question, and is not read whole again. Use the answer of that read, or search_document and read_document for the details.");
    }
    expect(result.steps[1]).toMatch(/^Read all of app\.log for “Build a timeline” — failed: app\.log was already read whole/);

    parts = 0;
    await askWithFiles({ files, model: script(), documentIds: [meta.id], messages: question("?"), limits: { wholeDocumentReads: 2 } });
    expect(parts).toBe(perRead * 2);

    parts = 0;
    const none = script();
    await askWithFiles({ files, model: none, documentIds: [meta.id], messages: question("?"), limits: { wholeDocumentReads: 0 } });
    expect(parts).toBe(0);
    expect(roundsOf(none.requests[1]!.messages)[0]!.answers[0]!.result.error).toMatch(/^Whole-file reads are turned off for this question\./);
  });

  it("answers a call that did not arrive whole instead of running it", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([
        { id: "a", name: "read_document", args: {}, problem: "The arguments of this call were not valid JSON, and it was not run: {\"document_id\": \"doc. Send the call again." },
        { id: "b", name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } },
      ]),
      says("ok"),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    const [round] = roundsOf(model.requests[1]!.messages);
    expect(round!.answers[0]!.result).toEqual({ error: "The arguments of this call were not valid JSON, and it was not run: {\"document_id\": \"doc. Send the call again.", tool_turns_left: 10 });
    expect(round!.answers[1]!.result.lines).toBe("1-2");
    // What is kept of the question does not carry the note for the loop.
    expect(result.toolTurns[0]!.calls[0]).toEqual({ id: "a", name: "read_document", args: {}, result: round!.answers[0]!.result });
  });
});

describe("the room a request has for tool results", () => {
  // About 58 tokens a line by the estimate: a read of 600 lines is cut to 24,000 characters, some 12,000 tokens.
  const reads = (id: string, from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    name: "read_document",
    args: { document_id: id, start_line: from + index * 600, end_line: from + index * 600 + 599 },
  }));

  it("is counted: results are cut to what is left, old ones are shortened, and the answer is asked for when nothing fits", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 128_000, reservedTokens: 16_000, inlineTokens: 100_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(60_000)) });
    let next = 1;
    const model = fakeModel([(request) => {
      if (request.toolChoice === "none") return says("The outage was caused by the errors.");
      const batch = reads(meta.id, next, 3);
      next += 1_800;
      return calls(batch);
    }]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What caused the outage?") });
    expect(result.answered).toBe(true);
    // No request is larger than the window, by the library's own estimate of its text.
    const { estimateTokens } = await import("llm-large-files");
    const sizes = model.requests.map((request) => estimateTokens(JSON.stringify(request.messages.map((message) => (message.role === "tools" ? { calls: message.calls, answers: message.answers } : message.parts)))));
    expect(Math.max(...sizes)).toBeLessThan(128_000);
    // Older results were replaced by stand-ins that say which lines they showed.
    const last = roundsOf(model.requests.at(-1)!.messages);
    const stubs = last.flatMap((round) => round.answers).filter((answer) => answer.result.dropped === true);
    expect(stubs.length).toBeGreaterThan(0);
    expect(stubs[0]!.result).toEqual({
      document: "app.log",
      dropped: true,
      lines: expect.stringMatching(/^1-\d+$/),
      total_lines: 60_000,
      note: "These lines were shown to you earlier and were dropped from the conversation to make room. Read them again with read_document if you need them.",
    });
    // The latest results are whole.
    expect(last.at(-1)!.answers.every((answer) => answer.result.dropped !== true)).toBe(true);
    expect(result.steps).toContain("Older tool results were shortened to make room in the request");
    // The model's own turns are still its own after the results were shortened.
    expect(last.every((round) => round.raw !== undefined)).toBe(true);
  });

  it("gives a call the room that is left, and answers the rest with a reason, for a model whose conversation may only grow", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 64_000, reservedTokens: 8_000, inlineTokens: 30_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(60_000)) });
    let next = 1;
    const model = fakeModel([(request) => {
      if (request.toolChoice === "none") return says("From what I read.");
      const batch = reads(meta.id, next, 4);
      next += 2_400;
      return calls(batch);
    }], { appendOnly: true });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    const rounds = roundsOf(model.requests.at(-1)!.messages);
    const answers = rounds.flatMap((round) => round.answers.map((answer) => answer.result));
    // Nothing was rewritten: no stand-ins, and every request before the last is a prefix of the next.
    expect(answers.some((answer) => answer.dropped === true)).toBe(false);
    for (let index = 1; index < model.requests.length; index++) {
      const before = model.requests[index - 1]!.messages;
      expect(model.requests[index]!.messages.slice(0, before.length)).toEqual(before);
    }
    const refused = answers.filter((answer) => typeof answer.error === "string");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]!.error).toBe("Not run: there is no room left in this conversation for another tool result. Answer now, from what the tools returned so far.");
    expect(refused[0]!.tool_turns_left).toBe(0);
    // A result that was cut to the room says where to go on.
    const cut = answers.find((answer) => typeof answer.next_start_line === "number" && typeof answer.lines === "string" && JSON.stringify(answer).length < 20_000);
    expect(cut).toBeDefined();
    // Once a call found no room, the next request is the answer.
    expect(model.requests.at(-1)!.toolChoice).toBe("none");
    expect(model.requests.at(-2)!.toolChoice).toBe("auto");
    expect(result).toMatchObject({ text: "From what I read.", answered: true });
    expect(result.steps.some((step) => step.includes("failed: Not run: there is no room left"))).toBe(true);
  });

  it("follows the window and the reply size a model declares, and the scale of its tokens", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const small = await files.ingest({ name: "note.txt", bytes: utf8("The meeting moved to Tuesday.\n") });
    const large = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(4_000)) });
    // About 230,000 tokens by the estimate: whole for a 1M model, a card for a 200K one.
    const wide = fakeModel([says("ok")]);
    const whole = await askWithFiles({ files, model: wide, documentIds: [small.id, large.id], messages: question("?") });
    expect(whole.plan.inline.map((meta) => meta.name)).toEqual(["note.txt"]);
    expect(whole.budget).toEqual(files.budget);

    const narrow = fakeModel([says("ok")], { contextTokens: 64_000 });
    const result = await askWithFiles({ files, model: narrow, documentIds: [small.id], messages: question("?") });
    expect(result.plan.inline.map((meta) => meta.name)).toEqual(["note.txt"]);
    expect(result.budget).toMatchObject({ contextTokens: 64_000, reservedTokens: 16_000, inlineTokens: 32_000, mapChunkTokens: 32_000, toolResultCharacters: 7_680 });

    // A tokenizer that counts 1.6 times as many, and 12,800 tokens kept for the reply: 64,000 / 1.6 - 8,000.
    const dense = fakeModel([says("ok")], { contextTokens: 64_000, tokenScale: 1.6, outputTokens: 12_800 });
    expect((await askWithFiles({ files, model: dense, documentIds: [small.id], messages: question("?") })).budget.contextTokens).toBe(32_000);
    // The smaller window of two models holds, and a field given for the question wins over what follows the window.
    const both = await askWithFiles({ files, model: wide, explorer: narrow, documentIds: [small.id], messages: question("?"), budget: { reservedTokens: 4_000 } });
    expect(both.budget).toMatchObject({ contextTokens: 64_000, reservedTokens: 4_000 });
  });
});

describe("the edges of the loop", () => {
  it("stops every call of a turn when the question is stopped, and leaves no promise unheard", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    const stop = new AbortController();
    let reading = 0;
    const generateText: GenerateText = ({ signal }) => new Promise((_resolve, reject) => {
      reading++;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      // Stop once the parts of the read are on their way.
      if (reading === 4) setTimeout(() => stop.abort(new Error("stopped by the user")), 5);
    });
    const unheard: unknown[] = [];
    const listen = (reason: unknown) => unheard.push(reason);
    process.on("unhandledRejection", listen);
    try {
      const model = fakeModel([calls([
        { name: "analyze_whole_document", args: { document_id: meta.id, task: "everything" } },
        { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } },
        { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } },
      ]), says("never")], { generateText });
      await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), signal: stop.signal })).rejects.toThrow("stopped by the user");
      expect(model.requests).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unheard).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });

  it("answers a call of a tool that does not exist, and goes on", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([calls([{ id: "x", name: "do_magic", args: { document_id: meta.id } }]), says("No magic here.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    expect(roundsOf(model.requests[1]!.messages)[0]!.answers[0]!.result).toEqual({ error: "Unknown tool do_magic.", tool_turns_left: 10 });
    expect(result).toMatchObject({ text: "No magic here.", answered: true, steps: ["do_magic — failed: Unknown tool do_magic."], evidence: [] });
  });

  it("shortens the rounds of earlier questions before those of this one", async () => {
    // A result may be 24,000 characters here, as for a large model: for a window of 64,000 the default is a third of that.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 64_000, reservedTokens: 8_000, inlineTokens: 20_000, toolResultCharacters: 24_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
    const tools = files.tools([meta]);
    const read = async (from: number) => {
      const args = { document_id: meta.id, start_line: from, end_line: from + 599 };
      return { name: "read_document", args, result: await tools.execute("read_document", args) };
    };
    // Four rounds of an earlier question, about 12,000 tokens each: most of a window of 64,000.
    const earlier = [];
    for (let round = 0; round < 4; round++) earlier.push({ role: "tools" as const, calls: [await read(1 + round * 600)] });
    const model = fakeModel([calls([{ name: "read_document", args: { document_id: meta.id, start_line: 9_000, end_line: 9_599 } }]), says("Read.")]);
    const result = await askWithFiles({
      files, model, documentIds: [meta.id],
      messages: [{ role: "user", text: "Read the start." }, ...earlier, { role: "assistant", text: "Done." }, { role: "user", text: "Now read from line 9000." }],
    });
    const sent = roundsOf(model.requests[1]!.messages);
    expect(sent).toHaveLength(5);
    // The oldest rounds became stand-ins, and the read of this question is whole.
    expect(sent[0]!.answers[0]!.result).toMatchObject({ dropped: true, lines: expect.stringMatching(/^1-\d+$/) });
    expect(sent.at(-1)!.answers[0]!.result.dropped).toBeUndefined();
    expect(String(sent.at(-1)!.answers[0]!.result.lines)).toMatch(/^9000-/);
    expect(result.steps[0]).toBe("Older tool results were shortened to make room in the request");
    // Only the round of this question is returned as new.
    expect(result.toolTurns).toHaveLength(1);
  });

  it("takes an explorer that is the model itself for none, and counts requests of a model that reports no usage", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([calls([{ name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } }], { text: "Reading." }), says("Two lines.")]);
    const result = await askWithFiles({ files, model, explorer: model, documentIds: [meta.id], messages: question("?") });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]!.system).not.toContain("DONE");
    expect(result).toMatchObject({ text: "Reading.\n\nTwo lines.", answered: true, turns: 2 });
    expect(result.usage).toEqual({ requests: 2, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtTokens: 0, byModel: { "fake-model": { requests: 2, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtTokens: 0 } } });
    expect(result.lastUsage).toBeUndefined();
  });
});

describe("what a question read", () => {
  it("is returned as evidence, and as tool rounds that a later question can be given", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([
        { id: "s", name: "search_document", args: { document_id: meta.id, query: "worker-3] req=", mode: "exact", max_results: 2, context_lines: 1 } },
        { id: "k", name: "search_document", args: { document_id: meta.id, query: "orders 4999 took" } },
      ]),
      calls([{ id: "r", name: "read_document", args: { document_id: meta.id, start_line: 95, end_line: 99 } }, { id: "o", name: "get_document_overview", args: { document_id: meta.id } }]),
      says("Line 97 is the first error."),
    ]);
    const first = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("Where is the first error?") });
    expect(first.evidence).toEqual([
      { tool: "search_document", documentId: meta.id, document: "app.log", lines: [[2, 4], [10, 12]], query: "worker-3] req=", mode: "exact", totalMatchingLines: 625 },
      { tool: "search_document", documentId: meta.id, document: "app.log", lines: expect.any(Array), query: "orders 4999 took", mode: "keywords" },
      { tool: "read_document", documentId: meta.id, document: "app.log", lines: [[95, 99]] },
      { tool: "get_document_overview", documentId: meta.id, document: "app.log", lines: [[1, 30], [4_981, 5_000]] },
    ]);
    // Plain JSON, in the order of the rounds, with each result as the model had it.
    expect(first.toolTurns).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(first.toolTurns))).toEqual(first.toolTurns);
    expect(first.toolTurns[1]!.calls.map((call) => [call.id, call.name])).toEqual([["r", "read_document"], ["o", "get_document_overview"]]);
    expect(first.toolTurns[1]!.calls[0]!.result).toMatchObject({ lines: "95-99", tool_turns_left: 9 });

    // The follow-up question, with those rounds between the first question and its answer.
    const again = fakeModel([says("It took 0ms.")]);
    await askWithFiles({
      files,
      model: again,
      documentIds: [meta.id],
      messages: [{ role: "user", text: "Where is the first error?" }, ...first.toolTurns, { role: "assistant", text: first.text }, { role: "user", text: "How long did that request take?" }],
    });
    const sent = again.requests[0]!.messages;
    expect(sent.map((message) => message.role)).toEqual(["user", "tools", "tools", "assistant", "user"]);
    const [, earlier] = roundsOf(sent);
    // No provider's own form: any model can be given them.
    expect(earlier!.raw).toBeUndefined();
    expect(earlier!.calls).toEqual([{ id: "r", name: "read_document", args: { document_id: meta.id, start_line: 95, end_line: 99 } }, { id: "o", name: "get_document_overview", args: { document_id: meta.id } }]);
    expect(earlier!.answers[0]!.result).toEqual(first.toolTurns[1]!.calls[0]!.result);
    // The card of the file is still at the start of the first user turn.
    expect(textOf(sent[0])).toMatch(/^--- Large attached file: app\.log ---/);
  });

  it("goes to an answering model of another kind without the explorer's own turns", async () => {
    const { files, meta } = await largeLog();
    const read = { id: "x", name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 3 } };
    const explorer = fakeModel([calls([read], { text: "Let me look." }), says("DONE")], { id: "explorer" });
    const model = fakeModel([says("Three lines of INFO.")], { id: "answerer" });
    const shown: string[] = [];
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], system: "Be brief.", messages: question("What is at the top?"), onText: (delta) => shown.push(delta) });
    expect(explorer.requests).toHaveLength(2);
    expect(explorer.requests[0]!.system.endsWith("reply with the single word DONE instead of an answer.")).toBe(true);
    // The explorer gets its own turn back.
    expect(roundsOf(explorer.requests[1]!.messages)[0]!.raw).toEqual({ own: ["read_document"] });
    const [answer] = model.requests;
    expect(answer!.system.startsWith("Be brief.\n\nSome attached files")).toBe(true);
    expect(answer!.system).not.toContain("DONE");
    expect(answer!.toolChoice).toBe("none");
    expect(answer!.tools!.length).toBeGreaterThan(0);
    const [round] = roundsOf(answer!.messages);
    expect(round!.raw).toBeUndefined();
    expect(round!.calls).toEqual([read]);
    expect(round!.answers[0]!.result.lines).toBe("1-3");
    expect(textOf(answer!.messages.at(-1))).toBe(FINAL_ANSWER_REQUEST);
    expect(result).toMatchObject({ text: "Three lines of INFO.", answered: true, turns: 3 });
    expect(shown.join("")).toBe("Three lines of INFO.");

    // An explorer that used no tool: the answer is asked for from the conversation.
    const idle = fakeModel([says("DONE")], { id: "explorer" });
    const alone = fakeModel([says("It is a log.")], { id: "answerer" });
    await askWithFiles({ files, model: alone, explorer: idle, documentIds: [meta.id], messages: question("What is it?") });
    expect(textOf(alone.requests[0]!.messages.at(-1))).toBe(FINAL_ANSWER_WITHOUT_TOOLS);
  });

  it("does not take what a model wrote before a refusal for an answer, and asks nothing more", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([says("I started to", { blockReason: "refusal: cyber", finishReason: "refusal" })]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    expect(model.requests).toHaveLength(1);
    expect(result).toMatchObject({ answered: false, blockReason: "refusal: cyber", finishReason: "refusal", turns: 1 });
  });
});
