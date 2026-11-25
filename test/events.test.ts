import { describe, expect, it } from "vitest";
import {
  askStream,
  askWithFiles,
  createLargeFiles,
  MemoryDocumentStore,
  ModelRequestError,
  partialResultOf,
  type AskEvent,
  type DocumentMeta,
  type GenerateText,
  type RetryOptions,
  type ToolCall,
} from "llm-large-files";
import { calls, fakeModel, httpError, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];

/** A wait that takes no time, and notes how long it was asked to be. */
function quickRetry(more: RetryOptions = {}): { retry: RetryOptions; waits: number[] } {
  const waits: number[] = [];
  return { waits, retry: { random: () => 1, sleep: async (ms) => { waits.push(ms); }, ...more } };
}

async function largeLog(lines = 5_000, budget: Record<string, number> = {}) {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(lines)) });
  return { files, meta };
}

type Of<T extends AskEvent["type"]> = Extract<AskEvent, { type: T }>;
const only = <T extends AskEvent["type"]>(events: AskEvent[], type: T): Array<Of<T>> => events.filter((event): event is Of<T> => event.type === type);
const notices = (events: AskEvent[]) => only(events, "notice");

/**
 * What every run must hold: `seq` from 1 without gaps, one run, `run.start` first and one terminal
 * event last, every request and call ended after it started, with its retries, text and progress
 * between. A run that failed may leave a request or a call open (its end came after the terminal event).
 */
function checkRun(events: AskEvent[]): AskEvent[] {
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect(new Set(events.map((event) => event.runId)).size).toBe(1);
  expect(events[0]!.type).toBe("run.start");
  const terminal = events.filter((event) => event.type === "run.finish" || event.type === "run.error");
  expect(terminal).toHaveLength(1);
  expect(events.at(-1)).toBe(terminal[0]);
  const requests = new Set<string>();
  const ended = new Set<string>();
  const tools = new Set<string>();
  const done = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case "request.start":
        expect(requests.has(event.requestId) || ended.has(event.requestId)).toBe(false);
        requests.add(event.requestId);
        if (event.role === "reader") expect(tools.has(event.callId!)).toBe(true);
        break;
      case "retry":
      case "text":
        expect(requests.has(event.requestId)).toBe(true);
        break;
      case "request.end":
        expect(requests.delete(event.requestId)).toBe(true);
        ended.add(event.requestId);
        break;
      case "tool.start":
        expect(tools.has(event.callId) || done.has(event.callId)).toBe(false);
        tools.add(event.callId);
        break;
      case "tool.progress":
        expect(tools.has(event.callId)).toBe(true);
        break;
      case "tool.end":
        expect(tools.delete(event.callId)).toBe(true);
        done.add(event.callId);
        break;
      default:
        break;
    }
  }
  if (events.at(-1)!.type === "run.finish") {
    expect([...requests]).toEqual([]);
    expect([...tools]).toEqual([]);
  }
  return events;
}

/** A turn of two searches and a read, then the answer. */
/** A result as run.finish carries it without eventResults: the plan names its documents only. */
function asEvent<T extends { plan: { inline: DocumentMeta[]; searchable: DocumentMeta[] } }>(result: T) {
  const ref = (meta: DocumentMeta) => ({ id: meta.id, name: meta.name, format: meta.format, estimatedTokens: meta.estimatedTokens, ...(meta.pages !== undefined ? { pages: meta.pages } : {}) });
  return { ...result, plan: { inline: result.plan.inline.map(ref), searchable: result.plan.searchable.map(ref) } };
}

function loopScript(id: string) {
  return fakeModel([
    calls([
      { id: "s", name: "search_document", args: { document_id: id, query: "ERROR", mode: "exact", max_results: 3 } },
      { id: "r", name: "read_document", args: { document_id: id, start_line: 95, end_line: 99 } },
    ], { usage: { inputTokens: 1_000, outputTokens: 20 }, finishReason: "tool_calls" }),
    says("Line 97 is the first error.", { usage: { inputTokens: 2_000, outputTokens: 10 }, finishReason: "stop" }),
  ]);
}

describe("the events of a question", () => {
  it("runs in order: a run.start, the plan, requests and tool calls in pairs, text, and run.finish", async () => {
    const { files, meta } = await largeLog();
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("Where is the first error?"), runId: "run_test", onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(events.every((event) => event.runId === "run_test" && typeof event.time === "number")).toBe(true);
    expect(events[0]).toMatchObject({ type: "run.start", models: { answer: "fake-model" }, documentIds: [meta.id] });
    expect((events[0] as Of<"run.start">).models.explorer).toBeUndefined();
    expect(events[1]).toMatchObject({ type: "plan", inline: [], searchable: [{ id: meta.id, name: "app.log", format: "log", estimatedTokens: meta.estimatedTokens }] });
    expect(notices(events)).toEqual([expect.objectContaining({ code: "searching_instead", display: "activity", message: "Too large to read at once: app.log. Searching instead…" })]);

    const starts = only(events, "request.start");
    expect(starts.map((event) => [event.requestId, event.role, event.purpose, event.model, event.turn])).toEqual([["req_1", "tools", "turn", "fake-model", 1], ["req_2", "tools", "turn", "fake-model", 2]]);
    expect(starts.every((event) => typeof event.estimatedInputTokens === "number" && event.estimatedInputTokens > 0)).toBe(true);
    const ends = only(events, "request.end");
    expect(ends[0]).toMatchObject({ requestId: "req_1", outcome: "ok", usage: { inputTokens: 1_000, outputTokens: 20 }, finishReason: "tool_calls", toolCalls: 2 });
    expect(ends[1]).toMatchObject({ requestId: "req_2", outcome: "ok", finishReason: "stop", toolCalls: 0 });

    const toolStarts = only(events, "tool.start");
    expect(toolStarts.map((event) => [event.callId, event.providerCallId, event.tool, event.documentId, event.round])).toEqual([
      ["call_1", "s", "search_document", meta.id, 1],
      ["call_2", "r", "read_document", meta.id, 1],
    ]);
    expect(toolStarts[0]!.args).toEqual({ document_id: meta.id, query: "ERROR", mode: "exact", max_results: 3 });
    expect(toolStarts[0]!.label).toBe("Search app.log (exact) for “ERROR”");
    const toolEnds = only(events, "tool.end");
    // In call order, each with the step `onStep` got.
    expect(toolEnds.map((event) => [event.callId, event.outcome])).toEqual([["call_1", "ok"], ["call_2", "ok"]]);
    expect(toolEnds.map((event) => event.step)).toEqual(result.steps);
    expect(toolEnds.every((event) => typeof event.resultCharacters === "number" && event.resultCharacters > 0 && event.ms >= 0)).toBe(true);

    // The text of the answer, as it arrived, is the result's text, all of it in the request that wrote it.
    const text = only(events, "text");
    expect(text.map((event) => event.delta).join("")).toBe(result.text);
    expect(new Set(text.map((event) => event.requestId))).toEqual(new Set(["req_2"]));
    // Not streamed for a listener of the events alone: the text comes in one piece, once the reply is in.
    expect(text).toHaveLength(1);

    // Evidence names its call, in the result and in the call's end.
    expect(result.evidence.map((shown) => shown.callId)).toEqual(["call_1", "call_2"]);
    for (const shown of result.evidence) expect(toolEnds.find((event) => event.callId === shown.callId)!.evidence).toEqual(shown);

    // The result, a copy without the tool rounds, which hold the text of the documents.
    const { toolTurns, ...rest } = result;
    const finish = events.at(-1) as Of<"run.finish">;
    expect(finish.result).toEqual(asEvent(rest));
    expect(finish.result).not.toBe(result);
    expect(toolTurns).toHaveLength(1);
  });

  it("gives the old callbacks the same strings as before, and says the same in the events", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    const generateText: GenerateText = async ({ onUsage }) => {
      onUsage?.({ inputTokens: 100, outputTokens: 5 });
      return "An error at (L97).";
    };
    const script = () => fakeModel([
      httpError(503),
      calls([
        { name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } },
        { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } },
      ]),
      says(""),
      says("Errors at line 97."),
    ], { generateText });
    const heard = () => ({ text: [] as string[], activity: [] as string[], steps: [] as string[] });
    const run = async (onEvent?: (event: AskEvent) => void) => {
      const got = heard();
      const result = await askWithFiles({
        files,
        model: script(),
        documentIds: [meta.id],
        messages: question("?"),
        retry: quickRetry().retry,
        onText: (delta) => got.text.push(delta),
        onActivity: (line) => got.activity.push(line),
        onStep: (line) => got.steps.push(line),
        ...(onEvent ? { onEvent } : {}),
      });
      return { got, result };
    };
    const before = await run();
    const events: AskEvent[] = [];
    const after = await run((event) => events.push(event));
    checkRun(events);
    expect(after.got).toEqual(before.got);
    expect(after.result.steps).toEqual(before.result.steps);
    expect(after.result.text).toBe(before.result.text);
    // The progress of the read is told once, through the call's own listener.
    expect(before.got.activity.filter((line) => line.startsWith("Reading app.log: part")).length).toBeGreaterThan(1);

    // Each step is a tool call's end or a notice, in the same order, word for word.
    const steps = events.flatMap((event) => (event.type === "tool.end" && event.step !== undefined ? [event.step] : event.type === "notice" && event.display === "step" ? [event.message] : []));
    expect(steps).toEqual(after.got.steps);
    // What went to onActivity: notices, retries, the calls as they start, and the progress of the read.
    const activity = events.flatMap((event) => {
      if (event.type === "notice" && event.display === "activity") return [event.message];
      if (event.type === "retry") return [event.message];
      if (event.type === "tool.start") return [`${event.label}…`];
      if (event.type === "tool.progress") return [`${event.message}…`];
      return [];
    });
    expect([...activity].sort()).toEqual([...after.got.activity].sort());
    expect(only(events, "text").map((event) => event.delta)).toEqual(after.got.text);
    expect(notices(events).map((event) => event.code)).toEqual(["searching_instead", "writing_answer"]);
    expect(only(events, "request.start").filter((event) => event.role !== "reader").map((event) => `${event.role}/${event.purpose}`)).toEqual(["tools/turn", "tools/turn", "answer/closing"]);
    expect(only(events, "retry")).toEqual([expect.objectContaining({ requestId: "req_1", attempt: 1 })]);
  });

  it("tells a retry with its wait, its error and the words onActivity gets", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    const model = fakeModel([httpError(503), says("Heron.")]);
    const events: AskEvent[] = [];
    const activity: string[] = [];
    const { retry, waits } = quickRetry();
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry, onActivity: (line) => activity.push(line), onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(waits).toEqual([500]);
    const [retried] = only(events, "retry");
    // In the library's words: the provider's stay on the error, for the log.
    expect(retried).toMatchObject({ requestId: "req_1", attempt: 1, delayMs: 500, error: { message: "The model failed on its side (HTTP 503).", status: 503 }, message: "The model did not answer (HTTP 503). Trying again…" });
    expect(activity).toEqual([retried!.message]);
    expect(only(events, "request.start")).toEqual([expect.objectContaining({ requestId: "req_1", role: "answer", purpose: "direct", turn: 1 })]);
    expect(events.map((event) => event.type)).toEqual(["run.start", "plan", "request.start", "retry", "text", "request.end", "run.finish"]);
  });

  it("ends a request that failed, and the run with run.error and what the question found", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
      httpError(401, "bad key"),
    ]);
    const events: AskEvent[] = [];
    const failure = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event) }).catch((error: unknown) => error);
    checkRun(events);
    const said = "The model refused the key or token it was sent (HTTP 401).";
    expect(only(events, "request.end").at(-1)).toMatchObject({ requestId: "req_2", outcome: "error", error: { message: said, status: 401 } });
    const last = events.at(-1) as Of<"run.error">;
    expect(last).toMatchObject({ type: "run.error", error: { message: said, status: 401 } });
    expect(last.partial).toMatchObject({ answered: false, steps: [expect.stringContaining("Search app.log")] });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("bad key");
    // The partial result without its tool rounds; partialResultOf still has them.
    expect(last.partial).not.toHaveProperty("toolTurns");
    expect(partialResultOf(failure)!.toolTurns).toHaveLength(1);
  });

  it("ends with run.error when the question is stopped, and says nothing after it, though a part read ends later", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    const stop = new AbortController();
    let reading = 0;
    let finished = 0;
    // A part reader that does not stop when asked: its reads end later, after the question.
    const generateText: GenerateText = ({ onUsage }) => new Promise((resolve) => {
      reading++;
      if (reading === 2) setTimeout(() => stop.abort(new Error("stopped by the user")), 5);
      setTimeout(() => {
        finished++;
        onUsage?.({ inputTokens: 10 });
        resolve("An error at (L97).");
      }, 40);
    });
    const model = fakeModel([calls([
      { name: "analyze_whole_document", args: { document_id: meta.id, task: "everything" } },
      { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } },
    ]), says("never")], { generateText });
    const events: AskEvent[] = [];
    const activity: string[] = [];
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), signal: stop.signal, onActivity: (line) => activity.push(line), onEvent: (event) => events.push(event) })).rejects.toThrow("stopped by the user");
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(finished).toBeGreaterThan(0);
    expect(events).toHaveLength(count);
    checkRun(events);
    expect(events.at(-1)).toMatchObject({ type: "run.error", error: { message: "stopped by the user" } });
    // The calls that started were ended before it, with the reason.
    const ended = only(events, "tool.end");
    expect(ended.length).toBe(only(events, "tool.start").length);
    expect(ended.find((event) => event.callId === "call_1")).toMatchObject({ outcome: "error", error: "stopped by the user" });
    expect(only(events, "request.start").filter((event) => event.role === "reader").length).toBe(only(events, "request.end").filter((event) => event.requestId !== "req_1").length);
  });

  it("gives the same events through askStream, and stops the question when the loop is left", async () => {
    const { files, meta } = await largeLog();
    const events: AskEvent[] = [];
    const forwarded: AskEvent[] = [];
    const stream = askStream({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("Where is the first error?"), onEvent: (event) => forwarded.push(event) });
    for await (const event of stream) events.push(event);
    const result = await stream.result;
    checkRun(events);
    expect(forwarded).toEqual(events);
    // askStream asks for the text as it is written: askWithFiles does with streamText.
    expect(only(events, "text").length).toBeGreaterThan(1);
    const direct: AskEvent[] = [];
    await askWithFiles({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("Where is the first error?"), streamText: true, onEvent: (event) => direct.push(event) });
    const shape = (list: AskEvent[]) => list.map(({ seq, type }) => `${seq}:${type}`);
    expect(shape(events)).toEqual(shape(direct));
    const { toolTurns: _toolTurns, ...rest } = result;
    expect((events.at(-1) as Of<"run.finish">).result).toEqual(asEvent(rest));

    // A second request that would never end: leaving the loop stops it.
    const hangs = fakeModel([
      calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
      () => new Promise<never>(() => undefined),
    ]);
    const seen: AskEvent[] = [];
    const left = askStream({ files, model: hangs, documentIds: [meta.id], messages: question("?"), onEvent: (event) => seen.push(event) });
    for await (const event of left) {
      if (event.type === "request.start" && event.requestId === "req_2") break;
    }
    await expect(left.result).rejects.toMatchObject({ name: "AbortError" });
    expect(hangs.requests).toHaveLength(2);
    checkRun(seen);
    expect(seen.at(-1)).toMatchObject({ type: "run.error", error: { name: "AbortError" } });
  });

  it("plans again within one run: one run.start, two plans, a replanned notice between them", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { contextTokens: 200_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(600)) });
    const model = fakeModel([(request) => {
      const text = request.messages[0]!.role === "tools" ? "" : request.messages[0]!.parts.map((part) => part.text ?? "").join("\n");
      return /^--- Attached file/.test(text)
        ? new ModelRequestError("This model's maximum context length is 8192 tokens. However, your messages resulted in 21000 tokens.", 400)
        : says("Answered from the card.");
    }]);
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(only(events, "run.start")).toHaveLength(1);
    const plans = only(events, "plan");
    expect(plans.map((plan) => [plan.inline.map((ref) => ref.id), plan.searchable.map((ref) => ref.id)])).toEqual([[[meta.id], []], [[], [meta.id]]]);
    const replanned = notices(events).find((event) => event.code === "replanned")!;
    expect(replanned).toMatchObject({ display: "step", message: result.steps[0] });
    expect(events.indexOf(plans[0]!)).toBeLessThan(events.indexOf(replanned));
    expect(events.indexOf(replanned)).toBeLessThan(events.indexOf(plans[1]!));
    // The ids go on counting across the two tries.
    expect(only(events, "request.start").map((event) => [event.requestId, event.purpose, event.turn])).toEqual([["req_1", "direct", 1], ["req_2", "turn", 2]]);
    expect(only(events, "request.end")[0]).toMatchObject({ requestId: "req_1", outcome: "error", error: { kind: "context_overflow", status: 400 } });
  });

  it("reports the requests of whole-file reads with their call, and the progress of each read apart", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, mapChunkTokens: 40_000 } });
    const first = await files.ingest({ name: "first.log", bytes: utf8(serviceLog(5_000)) });
    const second = await files.ingest({ name: "second.log", bytes: utf8(serviceLog(4_000)) });
    const generateText: GenerateText = async ({ onUsage }) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      onUsage?.({ inputTokens: 100, outputTokens: 5 });
      return "An error at (L97).";
    };
    const whole = (id: string): ToolCall => ({ name: "analyze_whole_document", args: { document_id: id, task: "List the errors." } });
    const model = fakeModel([calls([whole(first.id), whole(second.id)]), says("Done.")], { generateText });
    const events: AskEvent[] = [];
    const activity: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [first.id, second.id], messages: question("?"), onActivity: (line) => activity.push(line), onEvent: (event) => events.push(event) });
    checkRun(events);
    const calls_ = only(events, "tool.start");
    const nameOf = new Map(calls_.map((event) => [event.callId, event.documentId === first.id ? "first.log" : "second.log"]));
    expect(calls_.map((event) => event.callId)).toEqual(["call_1", "call_2"]);

    const readers = only(events, "request.start").filter((event) => event.role === "reader");
    expect(readers.length).toBeGreaterThan(4);
    for (const callId of ["call_1", "call_2"]) {
      const own = readers.filter((event) => event.callId === callId);
      expect(own.map((event) => event.purpose)).toContain("part");
      expect(own.at(-1)).toMatchObject({ purpose: "final", detail: "the answer", model: "fake-model" });
      const parts = own.filter((event) => event.purpose === "part");
      expect(parts.map((event) => event.detail).sort()).toEqual(parts.map((_, index) => `part ${index + 1} of ${parts.length}`).sort());
    }
    // Each ends with the usage its part reader reported.
    const ends = new Map(only(events, "request.end").map((event) => [event.requestId, event]));
    for (const reader of readers) expect(ends.get(reader.requestId)).toMatchObject({ outcome: "ok", usage: { inputTokens: 100, outputTokens: 5 } });

    // The progress of each read is told with its own call, between that call's start and end.
    const progress = only(events, "tool.progress");
    expect(new Set(progress.map((event) => event.callId))).toEqual(new Set(["call_1", "call_2"]));
    for (const event of progress) expect(event.message).toContain(nameOf.get(event.callId)!);
    // And to onActivity, once each.
    expect(activity.filter((line) => /^(Reading|Combining|Writing the answer from)/.test(line))).toEqual(progress.map((event) => `${event.message}…`));

    const ended = only(events, "tool.end");
    expect(ended.map((event) => [event.callId, event.outcome])).toEqual([["call_1", "ok"], ["call_2", "ok"]]);
    expect(ended.map((event) => event.evidence)).toEqual(result.evidence);
    expect(result.evidence.map((shown) => [shown.callId, shown.whole])).toEqual([["call_1", true], ["call_2", true]]);
  });

  it("holds tool results only when asked to", async () => {
    const { files, meta } = await largeLog();
    const plain: AskEvent[] = [];
    await askWithFiles({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("?"), onEvent: (event) => plain.push(event) });
    expect(only(plain, "tool.end").every((event) => !("result" in event))).toBe(true);
    const full: AskEvent[] = [];
    const result = await askWithFiles({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("?"), eventResults: true, onEvent: (event) => full.push(event) });
    const ended = only(full, "tool.end");
    expect(ended.map((event) => event.result)).toEqual(result.toolTurns[0]!.calls.map(({ result: returned }) => returned));
    for (const event of ended) expect(event.resultCharacters).toBe(JSON.stringify(event.result).length);
  });

  it("ends each kind of call with its outcome: refused, already shown, not well formed, not run", async () => {
    const { files, meta } = await largeLog();
    const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const model = fakeModel([
      calls([search, search, { name: "read_document", args: {}, problem: "The arguments could not be read." }, { name: "get_document_overview", args: { document_id: meta.id } }]),
      calls([search, { name: "analyze_whole_document", args: { document_id: meta.id, task: "all" } }]),
      says("Done."),
    ], { generateText: async () => "notes" });
    const events: AskEvent[] = [];
    const steps: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), limits: { callsPerTurn: 3, wholeDocumentReads: 0 }, onStep: (line) => steps.push(line), onEvent: (event) => events.push(event) });
    checkRun(events);
    const ended = only(events, "tool.end");
    expect(ended.map((event) => [event.callId, event.outcome])).toEqual([
      ["call_1", "ok"],
      ["call_2", "already_shown"],
      ["call_3", "error"],
      ["call_4", "not_run"],
      ["call_5", "already_shown"],
      ["call_6", "error"],
    ]);
    expect(ended[2]!.error).toBe("The arguments could not be read.");
    expect(ended[3]!.step).toBeUndefined();
    expect(ended[3]!.error).toMatch(/^Not run: one turn runs at most 3 tool calls/);
    // A call settled at once starts as the turn is planned, before the calls that run.
    expect(only(events, "tool.start").map((event) => [event.callId, event.round])).toEqual([["call_2", 1], ["call_3", 1], ["call_1", 1], ["call_4", 1], ["call_5", 2], ["call_6", 2]]);
    const notRun = notices(events).find((event) => event.code === "calls_not_run")!;
    expect(notRun).toMatchObject({ display: "step", message: "1 more tool call in this turn was not run (at most 3 a turn)" });
    // The not-run call's start and end come before the notice that says it.
    expect(events.indexOf(ended[3]!)).toBeLessThan(events.indexOf(notRun));
    expect(steps).toEqual(result.steps);
  });

  it("names the explorer and the answering model, and why each request is made", async () => {
    const { files, meta } = await largeLog();
    const explorer = fakeModel([
      says(""),
      calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
      says("DONE"),
    ], { id: "explorer" });
    const model = fakeModel([says(""), says("The answer.")], { id: "writer" });
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(events[0]).toMatchObject({ type: "run.start", models: { answer: "writer", explorer: "explorer" } });
    expect(only(events, "request.start").map((event) => [event.role, event.purpose, event.model, event.turn])).toEqual([
      ["explorer", "turn", "explorer", 1],
      ["explorer", "nudge", "explorer", 2],
      ["explorer", "turn", "explorer", 3],
      ["answer", "closing", "writer", 4],
      ["answer", "answer_again", "writer", 5],
    ]);
    expect(notices(events).map((event) => [event.code, event.display])).toEqual([
      ["searching_instead", "activity"],
      ["nudged", "step"],
      ["writing_answer", "activity"],
      ["answer_again", "step"],
    ]);
    // The explorer's words are not shown: only the answer's.
    expect(only(events, "text").map((event) => event.delta).join("")).toBe(result.text);
    expect(new Set(only(events, "text").map((event) => event.requestId))).toEqual(new Set(["req_5"]));
  });
});

describe("notices that earlier versions did not show", () => {
  it("says when the provider refused the prompt", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    const model = fakeModel([says("I started to", { blockReason: "refusal: cyber", finishReason: "refusal" })]);
    const events: AskEvent[] = [];
    const steps: string[] = [];
    const activity: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onStep: (line) => steps.push(line), onActivity: (line) => activity.push(line), onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(notices(events)).toEqual([expect.objectContaining({ code: "blocked", display: "none", message: "The provider refused the prompt: refusal: cyber." })]);
    expect([steps, activity, result.steps]).toEqual([[], [], []]);
  });

  it("says once that a ceiling of the question stopped the tools", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
      // The answer comes back empty, and the ceiling keeps it from being asked for again.
      says(""),
    ]);
    const events: AskEvent[] = [];
    const steps: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), limits: { requests: 2 }, onStep: (line) => steps.push(line), onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(model.requests).toHaveLength(2);
    const said = notices(events).filter((event) => event.code === "budget_reached");
    expect(said).toEqual([expect.objectContaining({ display: "none", message: "No more tools: the question reached its limit of input tokens or requests." })]);
    // Before the answer's request.
    const closing = only(events, "request.start").find((event) => event.purpose === "closing")!;
    expect(events.indexOf(said[0]!)).toBeLessThan(events.indexOf(closing));
    expect(steps).toEqual(result.steps);
    expect(steps.some((line) => line.includes("limit"))).toBe(false);
  });

  it("says once that there is no room left for another tool result", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { contextTokens: 64_000, reservedTokens: 8_000, inlineTokens: 30_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(60_000)) });
    let next = 1;
    const model = fakeModel([(request) => {
      if (request.toolChoice === "none") return says("From what I read.");
      const batch = Array.from({ length: 4 }, (_, index) => ({ name: "read_document", args: { document_id: meta.id, start_line: next + index * 600, end_line: next + index * 600 + 599 } }));
      next += 2_400;
      return calls(batch);
    }], { appendOnly: true });
    const events: AskEvent[] = [];
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(notices(events).filter((event) => event.code === "no_room")).toEqual([expect.objectContaining({ display: "none", message: "There is no room left in this conversation for another tool result." })]);
    const refused = only(events, "tool.end").filter((event) => event.outcome === "refused");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]!.error).toMatch(/^Not run: there is no room left in this conversation/);
  });
});

describe("what events tell of errors", () => {
  const SECRET = "upstream said: https://x.example/v1/models?key=SECRET123 for project-777 was refused";
  const leaks = (events: AskEvent[]) => events.filter((event) => /SECRET123|project-777/.test(JSON.stringify(event)));

  it("never tells the provider's own words: not in a retry, a request's end, a call's end or run.error", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    let parts = 0;
    const generateText: GenerateText = async ({ onUsage }) => {
      parts++;
      // A reader request retried, and one that fails for good (its part is not read).
      if (parts === 1) throw new ModelRequestError(SECRET, 503);
      if (parts === 2) throw new ModelRequestError(SECRET, 400);
      onUsage?.({ inputTokens: 100 });
      return "An error at (L97).";
    };
    const model = fakeModel([
      // A chat request retried.
      new ModelRequestError(SECRET, 503),
      calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } }]),
      // The question fails for good.
      new ModelRequestError(SECRET, 401),
    ], { generateText });
    const events: AskEvent[] = [];
    const failure = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry, onEvent: (event) => events.push(event) }).catch((error: unknown) => error);
    checkRun(events);
    // The provider's words stay on the error that is thrown, for the log.
    expect((failure as Error).message).toBe(SECRET);
    const readers = new Set(only(events, "request.start").filter((event) => event.role === "reader").map((event) => event.requestId));
    const retries = only(events, "retry");
    expect(retries.some((event) => readers.has(event.requestId))).toBe(true);
    expect(retries.some((event) => !readers.has(event.requestId))).toBe(true);
    expect(only(events, "request.end").filter((event) => event.outcome === "error" && readers.has(event.requestId))).not.toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "run.error", error: { message: "The model refused the key or token it was sent (HTTP 401).", status: 401, kind: "auth", name: "ModelRequestError" } });
    expect(leaks(events)).toEqual([]);

    // A call ended because its turn failed: the question was stopped with a provider's error.
    const stop = new AbortController();
    const hanging: GenerateText = ({ signal }) => new Promise((_resolve, reject) => {
      setTimeout(() => stop.abort(new ModelRequestError(SECRET, 500)), 1);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const stopped = fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "everything" } }]), says("never")], { generateText: hanging });
    const more: AskEvent[] = [];
    await expect(askWithFiles({ files, model: stopped, documentIds: [meta.id], messages: question("?"), signal: stop.signal, onEvent: (event) => more.push(event) })).rejects.toThrow("SECRET123");
    checkRun(more);
    expect(only(more, "tool.end")).toEqual([expect.objectContaining({ callId: "call_1", outcome: "error", error: "The model failed on its side (HTTP 500)." })]);
    expect(leaks(more)).toEqual([]);
  });

  it("tells a thrown value that is not an Error plainly, and throws it as it came", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    // It cannot be made a string: String() of it throws.
    const odd = Object.create(null) as object;
    const model = fakeModel([() => { throw odd; }]);
    const retry = quickRetry({ retries: 0 }).retry;
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry })).rejects.toBe(odd);
    const events: AskEvent[] = [];
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry, onEvent: (event) => events.push(event) })).rejects.toBe(odd);
    checkRun(events);
    expect(events.at(-1)).toMatchObject({ type: "run.error", error: { message: "Something went wrong." } });
  });
});

describe("the result in run.finish and run.error", () => {
  it("holds no text of the documents unless eventResults is set; the result returned keeps it", async () => {
    const { files, meta } = await largeLog();
    const lines = serviceLog(5_000).split("\n");
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event) });
    checkRun(events);
    for (const event of events) {
      const sent = JSON.stringify(event);
      expect(lines.find((line) => sent.includes(line))).toBeUndefined();
    }
    // The result returned has the lines the read showed.
    expect(JSON.stringify(result.toolTurns)).toContain(lines[96]!);

    const full: AskEvent[] = [];
    const again = await askWithFiles({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("?"), eventResults: true, onEvent: (event) => full.push(event) });
    const finish = full.at(-1) as Of<"run.finish">;
    expect(finish.result.toolTurns).toEqual(again.toolTurns);
    expect(finish.result).not.toBe(again);
  });

  it("names the documents of its plan only: no owner, outline or lines of a log unless eventResults is set", async () => {
    // A log the plan searches (its card holds its commonest lines) and a short page it sends whole
    // (its meta holds the outline), both of one owner.
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const owner = "user-4711-secret";
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)), owner });
    const page = await files.ingest({ name: "notes.md", bytes: utf8("# Quarterly Heron Plan\n\nShort notes."), owner });
    const events: AskEvent[] = [];
    const result = await askWithFiles({ files, owner, model: fakeModel([says("Done.")]), documentIds: [log.id, page.id], messages: question("?"), onEvent: (event) => events.push(event) });
    checkRun(events);
    expect(JSON.stringify(result.plan)).toContain(owner);
    expect(JSON.stringify(result.plan)).toContain("Quarterly Heron Plan");
    const finish = events.at(-1) as Of<"run.finish">;
    for (const ref of [...finish.result.plan.inline, ...finish.result.plan.searchable]) {
      expect(Object.keys(ref).sort()).toEqual(expect.arrayContaining(["estimatedTokens", "format", "id", "name"]));
      expect(ref).not.toHaveProperty("owner");
      expect(ref).not.toHaveProperty("outline");
    }
    for (const event of events) {
      const sent = JSON.stringify(event);
      expect(sent).not.toContain(owner);
      expect(sent).not.toContain("Quarterly Heron Plan");
    }

    // With eventResults the plan has the full metadata, but never the owner (since 0.10.0).
    const full: AskEvent[] = [];
    await askWithFiles({ files, owner, model: fakeModel([says("Done.")]), documentIds: [log.id, page.id], messages: question("?"), eventResults: true, onEvent: (event) => full.push(event) });
    expect(JSON.stringify((full.at(-1) as Of<"run.finish">).result.plan)).toContain("Quarterly Heron Plan");
    expect(JSON.stringify((full.at(-1) as Of<"run.finish">).result.plan)).not.toContain(owner);
  });
});

describe("streamText", () => {
  /** A model that notes whether each request was asked to stream (it was given onText). */
  function noting() {
    const streamed: boolean[] = [];
    const model = fakeModel([(_request, _call, hooks) => {
      streamed.push(hooks.onText !== undefined);
      return says("The code word is heron.");
    }]);
    return { model, streamed };
  }
  const notes = async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    return { files, documentIds: [meta.id], messages: question("?") };
  };

  it("is off for a listener of the events alone: the request is the one it was, and the text comes once the reply is in", async () => {
    const asked = await notes();
    const { model, streamed } = noting();
    const events: AskEvent[] = [];
    const result = await askWithFiles({ ...asked, model, onEvent: (event) => events.push(event) });
    expect(streamed).toEqual([false]);
    expect(only(events, "text").map((event) => event.delta)).toEqual([result.text]);
    checkRun(events);
  });

  it("is on with onText, with streamText: true, and in askStream unless it says false", async () => {
    const asked = await notes();
    const run = async (more: { onText?: (delta: string) => void; streamText?: boolean }) => {
      const { model, streamed } = noting();
      const events: AskEvent[] = [];
      await askWithFiles({ ...asked, model, ...more, onEvent: (event) => events.push(event) });
      return { streamed, text: only(events, "text").length };
    };
    expect(await run({ onText: () => undefined })).toEqual({ streamed: [true], text: 2 });
    expect(await run({ streamText: true })).toEqual({ streamed: [true], text: 2 });
    expect(await run({ onText: () => undefined, streamText: false })).toEqual({ streamed: [false], text: 1 });

    for (const [streamText, expected] of [[undefined, true], [false, false]] as const) {
      const { model, streamed } = noting();
      const stream = askStream({ ...asked, model, ...(streamText !== undefined ? { streamText } : {}) });
      const events: AskEvent[] = [];
      for await (const event of stream) events.push(event);
      expect(streamed).toEqual([expected]);
      checkRun(events);
    }
  });
});

describe("a listener that throws", () => {
  /** A listener that keeps every event, and throws once, on the first event `when` picks. */
  function throwing(when: (event: AskEvent) => boolean) {
    const events: AskEvent[] = [];
    const thrown = new Error("the listener broke");
    let done = false;
    const onEvent = (event: AskEvent) => {
      events.push(event);
      if (!done && when(event)) {
        done = true;
        throw thrown;
      }
    };
    return { events, thrown, onEvent };
  }
  /** Every request and call that started ended, before the run.error. */
  function allEnded(events: AskEvent[]) {
    const requests = new Set<string>();
    const calls_ = new Set<string>();
    for (const event of events) {
      if (event.type === "request.start") requests.add(event.requestId);
      if (event.type === "request.end") requests.delete(event.requestId);
      if (event.type === "tool.start") calls_.add(event.callId);
      if (event.type === "tool.end") calls_.delete(event.callId);
    }
    expect([...requests]).toEqual([]);
    expect([...calls_]).toEqual([]);
  }
  async function wholeRead() {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    let reads = 0;
    const generateText: GenerateText = async ({ onUsage }) => {
      reads++;
      // The first part read is sent again once.
      if (reads === 1) throw new ModelRequestError("busy", 503);
      onUsage?.({ inputTokens: 10 });
      return "An error at (L97).";
    };
    const model = fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } }]), says("Done.")], { generateText });
    return { files, meta, model };
  }

  it.each<[string, (event: AskEvent) => boolean]>([
    ["the start of a reader request", (event) => event.type === "request.start" && event.role === "reader"],
    ["the end of a reader request", (event) => event.type === "request.end" && event.requestId !== "req_1"],
    ["the retry of a reader request", (event) => event.type === "retry"],
    ["the progress of a whole-file read", (event) => event.type === "tool.progress"],
  ])("on %s, ends the question with its error, not with a tool error", async (_name, when) => {
    const { files, meta, model } = await wholeRead();
    const { events, thrown, onEvent } = throwing(when);
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry, onEvent })).rejects.toBe(thrown);
    checkRun(events);
    allEnded(events);
    expect(events.at(-1)).toMatchObject({ type: "run.error", error: { message: "the listener broke" } });
    expect(only(events, "tool.end")).toEqual([expect.objectContaining({ callId: "call_1", outcome: "error", error: "the listener broke" })]);
    // The answer was never asked for.
    expect(model.requests).toHaveLength(1);
  });

  it("in onActivity, on the progress of a whole-file read, ends the question with its error (0.6.0 made it a tool error)", async () => {
    const { files, meta, model } = await wholeRead();
    const thrown = new Error("the status line broke");
    const onActivity = (line: string) => {
      if (line.startsWith("Reading app.log: part")) throw thrown;
    };
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry, onActivity })).rejects.toBe(thrown);
    expect(model.requests).toHaveLength(1);
  });

  it("on the start of a chat request, still ends it, before run.error", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    const model = fakeModel([says("Heron.")]);
    const { events, thrown, onEvent } = throwing((event) => event.type === "request.start");
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent })).rejects.toBe(thrown);
    checkRun(events);
    expect(events.map((event) => event.type)).toEqual(["run.start", "plan", "request.start", "request.end", "run.error"]);
    expect(events[3]).toMatchObject({ outcome: "error", error: { message: "the listener broke" } });
    expect(model.requests).toHaveLength(0);
  });

  it("on the start of a call settled at once, ends the turn: the other calls do not run", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([
        { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 5 } },
        { name: "read_document", args: {}, problem: "The arguments could not be read." },
        { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } },
      ]),
      says("never"),
    ]);
    const { events, thrown, onEvent } = throwing((event) => event.type === "tool.start");
    const activity: string[] = [];
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onActivity: (line) => activity.push(line), onEvent })).rejects.toBe(thrown);
    // Wait for anything that was scheduled: nothing of it may start.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(activity).toEqual(["Too large to read at once: app.log. Searching instead…"]);
    checkRun(events);
    allEnded(events);
    expect(only(events, "tool.start").map((event) => event.callId)).toEqual(["call_2"]);
    expect(only(events, "tool.end")).toEqual([expect.objectContaining({ callId: "call_2", outcome: "error", error: "the listener broke" })]);
    expect(model.requests).toHaveLength(1);
  });

  it("in askStream, on the last event, still lets the stream end with it", async () => {
    const { files, meta } = await largeLog();
    const thrown = new Error("the listener broke");
    const stream = askStream({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("?"), onEvent: (event) => {
      if (event.type === "run.finish") throw thrown;
    } });
    const events: AskEvent[] = [];
    for await (const event of stream) events.push(event);
    await expect(stream.result).rejects.toBe(thrown);
    checkRun(events);
    expect(events.at(-1)!.type).toBe("run.finish");

    // On an event before it: the stream has that event, then run.error.
    const early = askStream({ files, model: loopScript(meta.id), documentIds: [meta.id], messages: question("?"), onEvent: (event) => {
      if (event.type === "plan") throw thrown;
    } });
    const seen: AskEvent[] = [];
    for await (const event of early) seen.push(event);
    await expect(early.result).rejects.toBe(thrown);
    checkRun(seen);
    expect(seen.map((event) => event.type)).toEqual(["run.start", "plan", "run.error"]);
  });
});

describe("the order of the events", () => {
  it("starts with run.start even when the options do not work", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const events: AskEvent[] = [];
    await expect(askWithFiles({ files, model: undefined as never, documentIds: "doc_1" as never, messages: question("?"), onEvent: (event) => events.push(event) })).rejects.toThrow();
    checkRun(events);
    expect(events[0]).toMatchObject({ type: "run.start", models: { answer: "" }, documentIds: [] });
    expect(events.map((event) => event.type)).toEqual(["run.start", "run.error"]);
  });

  it("ends the calls of a turn that failed in call order, not in the order they started", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    const stop = new AbortController();
    const generateText: GenerateText = ({ signal }) => new Promise((_resolve, reject) => {
      setTimeout(() => stop.abort(new Error("stopped by the user")), 1);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const model = fakeModel([calls([
      { name: "analyze_whole_document", args: { document_id: meta.id, task: "everything" } },
      // Settled at once, so it starts first.
      { name: "read_document", args: {}, problem: "The arguments could not be read." },
    ]), says("never")], { generateText });
    const events: AskEvent[] = [];
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), signal: stop.signal, onEvent: (event) => events.push(event) })).rejects.toThrow("stopped by the user");
    checkRun(events);
    expect(only(events, "tool.start").map((event) => event.callId)).toEqual(["call_2", "call_1"]);
    expect(only(events, "tool.end").map((event) => [event.callId, event.outcome])).toEqual([["call_1", "error"], ["call_2", "error"]]);
  });
});
