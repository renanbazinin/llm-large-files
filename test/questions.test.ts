// Question IDs (H14, 0.99.9): `AskOptions.questionId` labels a question, its events and its
// result, and never reaches the model; `createQuestionRegistry()` runs questions by owner, scope
// and question ID, so that a request sent again joins the question still running, or gets its
// kept answer, instead of asking the model twice.
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  createQuestionRegistry,
  errorInfoOf,
  MemoryDocumentStore,
  partialResultOf,
  QUESTION_ID_PATTERN,
  QuestionConflictError,
  type AskEvent,
  type AskResult,
  type ChatMessage,
  type ModelReply,
  type ModelRequest,
  type QuestionAskOptions,
  type SendHooks,
} from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8, type FakeModel } from "./fake-model.js";

const OWNER = "user-1";
const question = (text: string): ChatMessage[] => [{ role: "user", text }];
const NOT_AN_ID = "questionId must be a string of 1 to 128 characters: letters, digits, \".\", \"_\", \":\" or \"-\", starting with a letter or a digit, such as a UUID the client made for this question.";
const CONFLICT = "This questionId was already used for another question: other messages, documents or models. Use a new questionId for a new question.";
const NOBODY_WAITED = "Nobody waited for the answer to this question.";

/** A library that requires an owner, with a note small enough to go in whole: one request answers it. */
async function smallNote() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: true });
  const meta = await files.ingest({ name: "notes.txt", bytes: utf8("The meeting is on Tuesday at 10."), owner: OWNER });
  return { files, meta };
}

/** A library that requires an owner, with a log too large to send: the model searches it, then answers. */
async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: true, budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)), owner: OWNER });
  const search = { id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
  return { files, meta, search };
}

/**
 * A reply that waits until `open()`, or ends with the request's abort. `started` resolves once the
 * request is in; `signal` is the last request's. Once open, it answers at once, each time.
 */
function held(reply: Partial<ModelReply> | Error = says("On Tuesday.")) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let enter!: () => void;
  const started = new Promise<void>((resolve) => (enter = resolve));
  const seen: { signal?: AbortSignal } = {};
  const scripted = async (_request: ModelRequest, _call: number, hooks: SendHooks): Promise<Partial<ModelReply> | Error> => {
    seen.signal = hooks.signal;
    enter();
    await new Promise<void>((resolve, reject) => {
      const signal = hooks.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void opened.then(resolve);
    });
    return reply;
  };
  return { scripted, open, started, seen };
}

/** The events a caller gets, and its onEvent. */
function recorder() {
  const events: AskEvent[] = [];
  return { events, onEvent: (event: AskEvent) => void events.push(event) };
}

const settled = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));

describe("AskOptions.questionId", () => {
  it("a question ID is on every event and on the result", async () => {
    const { files, meta, search } = await largeLog();
    const { events, onEvent } = recorder();
    const model = fakeModel([calls([search]), says("51 errors.")]);
    const result = await askWithFiles({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("How many errors?"), questionId: "q-1", onEvent });
    expect(result.questionId).toBe("q-1");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.start", "plan", "request.start", "tool.start", "tool.end", "text", "run.finish"]));
    for (const event of events) expect(event.questionId).toBe("q-1");
    const finish = events.at(-1) as Extract<AskEvent, { type: "run.finish" }>;
    expect(finish.result.questionId).toBe("q-1");

    // A question that fails: its run.error, its partial result and partialResultOf carry it too.
    const failing = fakeModel([calls([search]), new Error("The model broke.")]);
    const failed = recorder();
    const outcome = await settled(askWithFiles({ files, model: failing, owner: OWNER, documentIds: [meta.id], messages: question("How many errors?"), questionId: "q-2", onEvent: failed.onEvent }));
    const error = (outcome as { error: unknown }).error;
    expect(partialResultOf(error)).toMatchObject({ questionId: "q-2", answered: false });
    expect(failed.events.at(-1)).toMatchObject({ type: "run.error", questionId: "q-2", partial: { questionId: "q-2" } });
  });

  it("without a question ID, events and results have no such key", async () => {
    const { files, meta, search } = await largeLog();
    const { events, onEvent } = recorder();
    const model = fakeModel([calls([search]), says("51 errors.")]);
    const result = await askWithFiles({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("How many errors?"), onEvent });
    expect("questionId" in result).toBe(false);
    expect(events.filter((event) => "questionId" in event)).toEqual([]);
    expect("questionId" in (events.at(-1) as Extract<AskEvent, { type: "run.finish" }>).result).toBe(false);
  });

  it("refuses a question ID that is not 1 to 128 safe characters", async () => {
    const { files, meta } = await smallNote();
    expect(QUESTION_ID_PATTERN.test("7d444840-9dc0-11d1-b245-5ffdce74fad2")).toBe(true);
    expect(QUESTION_ID_PATTERN.test(`a${"b".repeat(127)}`)).toBe(true);
    expect(QUESTION_ID_PATTERN.test("chat-12:turn_3.retry")).toBe(true);
    const registry = createQuestionRegistry();
    for (const bad of ["", "a b", "x".repeat(129), 42, "-first", "q\n", "q/1", "ä"] as unknown[]) {
      const { events, onEvent } = recorder();
      const model = fakeModel([says("On Tuesday.")]);
      const asked = { files, model, owner: OWNER, documentIds: [meta.id], messages: question("When?"), questionId: bad as string };
      await expect(askWithFiles({ ...asked, onEvent })).rejects.toThrow(new TypeError(NOT_AN_ID));
      expect(events.map((event) => event.type)).toEqual(["run.start", "run.error"]);
      expect("questionId" in events[0]!).toBe(false);
      expect(events[1]).toMatchObject({ error: { message: NOT_AN_ID, name: "TypeError" } });
      await expect(registry.ask(asked)).rejects.toThrow(new TypeError(NOT_AN_ID));
      expect(() => registry.askStream(asked)).toThrow(new TypeError(NOT_AN_ID));
      expect(model.requests).toHaveLength(0);
    }
    // The registry needs one: its type requires it, and a caller in JavaScript gets a TypeError.
    const model = fakeModel([says("On Tuesday.")]);
    const plain = { files, model, owner: OWNER, documentIds: [meta.id], messages: question("When?") };
    // @ts-expect-error The options of a registry need a questionId.
    void (() => registry.ask(plain));
    const without = plain as unknown as QuestionAskOptions;
    await expect(registry.ask(without)).rejects.toThrow(new TypeError("registry.ask needs options.questionId: the client's ID for this question, such as a UUID."));
    expect(() => registry.askStream(without)).toThrow(new TypeError("registry.askStream needs options.questionId: the client's ID for this question, such as a UUID."));
    expect(model.requests).toHaveLength(0);
    expect(registry.stats()).toEqual({ running: 0, kept: 0, keptBytes: 0 });
  });

  it("sends the same requests with and without a question ID", async () => {
    const { files, meta, search } = await largeLog();
    /** A model that notes whether each request was given onText, which asks for streaming. */
    const noting = () => {
      const streamed: boolean[] = [];
      const model = fakeModel([
        (_request, _call, hooks) => {
          streamed.push(hooks.onText !== undefined);
          return calls([search]);
        },
        (_request, _call, hooks) => {
          streamed.push(hooks.onText !== undefined);
          return says("51 errors.");
        },
      ]);
      return { model, streamed };
    };
    const asked = { files, owner: OWNER, documentIds: [meta.id], messages: question("How many errors?") };
    for (const onText of [undefined, () => undefined]) {
      const hook = onText ? { onText } : {};
      const plain = noting();
      await askWithFiles({ ...asked, ...hook, model: plain.model });
      const labelled = noting();
      await askWithFiles({ ...asked, ...hook, model: labelled.model, questionId: "q-1", onEvent: () => undefined });
      const registered = noting();
      await createQuestionRegistry().ask({ ...asked, ...hook, model: registered.model, questionId: "q-1" });
      expect(plain.model.requests).toHaveLength(2);
      expect(JSON.stringify(labelled.model.requests)).toBe(JSON.stringify(plain.model.requests));
      expect(JSON.stringify(registered.model.requests)).toBe(JSON.stringify(plain.model.requests));
      expect(JSON.stringify(plain.model.requests)).not.toContain("q-1");
      expect(labelled.streamed).toEqual(plain.streamed);
      expect(registered.streamed).toEqual(plain.streamed);
      expect(plain.streamed).toEqual([onText !== undefined, onText !== undefined]);
    }
  });
});

describe("createQuestionRegistry", () => {
  it("a retry while the question runs joins it", async () => {
    const { files, meta } = await smallNote();
    const gate = held();
    const model = fakeModel([gate.scripted]);
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const first = recorder();
    const one = registry.ask({ ...asked(), onEvent: first.onEvent });
    await gate.started;
    expect(registry.stats()).toEqual({ running: 1, kept: 0, keptBytes: 0 });
    const second = recorder();
    const two = registry.ask({ ...asked(), onEvent: second.onEvent });
    gate.open();
    const [r1, r2] = await Promise.all([one, two]);
    expect(model.requests).toHaveLength(1);
    expect(r1).toEqual(r2);
    expect(r1).not.toBe(r2);
    expect(r1).toMatchObject({ answered: true, text: "On Tuesday.", questionId: "q-1" });
    expect(first.events[0]).toMatchObject({ type: "run.start", seq: 1 });
    expect(second.events[0]!.seq).toBeGreaterThan(1);
    expect(second.events.map((event) => event.type)).not.toContain("run.start");
    expect(second.events.at(-1)).toEqual(first.events.at(-1));
    expect(second.events.at(-1)?.type).toBe("run.finish");
    expect(first.events.slice(-second.events.length)).toEqual(second.events);
  });

  it("a retry after the answer gets the kept answer, and the run's run.finish event, without a model request", async () => {
    const { files, meta } = await smallNote();
    const model = fakeModel([says("On Tuesday.")]);
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const first = recorder();
    const r1 = await registry.ask({ ...asked(), onEvent: first.onEvent });
    const stats = registry.stats();
    expect(stats).toMatchObject({ running: 0, kept: 1 });
    expect(stats.keptBytes).toBeGreaterThan(0);
    const again = recorder();
    const r2 = await registry.ask({ ...asked(), onEvent: again.onEvent });
    expect(model.requests).toHaveLength(1);
    expect(r2).toEqual(r1);
    expect(r2).not.toBe(r1);
    expect(again.events).toEqual([first.events.at(-1)]);
    expect(again.events[0]).toMatchObject({ type: "run.finish", questionId: "q-1", runId: first.events[0]!.runId });
    // A caller cannot change the answer the next one gets.
    r2.text = "changed";
    expect((await registry.ask(asked())).text).toBe("On Tuesday.");
    // A throw from the listener rejects that caller with it.
    const thrown = new Error("The page went away.");
    await expect(registry.ask({ ...asked(), onEvent: () => { throw thrown; } })).rejects.toBe(thrown);
    expect(model.requests).toHaveLength(1);
  });

  it("a listener that changes run.finish changes neither another caller's event nor the kept answer", async () => {
    const { files, meta } = await smallNote();
    const gate = held();
    const model = fakeModel([gate.scripted]);
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const spoil = (event: AskEvent) => {
      if (event.type !== "run.finish") return;
      event.result.text = "redacted";
      event.result.steps.push("x");
    };
    const one = registry.ask({ ...asked(), onEvent: spoil });
    await gate.started;
    const joined = recorder();
    const two = registry.ask({ ...asked(), onEvent: joined.onEvent });
    gate.open();
    await Promise.all([one, two]);
    const finish = joined.events.at(-1);
    expect(finish).toMatchObject({ type: "run.finish", result: { text: "On Tuesday." } });
    expect(finish?.type === "run.finish" && finish.result.steps).not.toContain("x");
    const later = recorder();
    const kept = await registry.ask({ ...asked(), onEvent: later.onEvent });
    expect(model.requests).toHaveLength(1);
    expect(kept.text).toBe("On Tuesday.");
    expect(kept.steps).not.toContain("x");
    expect(later.events).toEqual([finish]);
  });

  it("a listener that throws on the kept run.finish rejects that caller", async () => {
    const { files, meta } = await smallNote();
    const model = fakeModel([says("On Tuesday.")]);
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    await registry.ask(asked());
    const thrown = new Error("The page went away.");
    await expect(registry.ask({ ...asked(), onEvent: () => { throw thrown; } })).rejects.toBe(thrown);
    expect(model.requests).toHaveLength(1);
  });

  it("the kept answer expires after keepMs", async () => {
    const { files, meta } = await smallNote();
    const model = fakeModel([says("On Tuesday.")]);
    let clock = 1_000_000;
    const registry = createQuestionRegistry({ keepMs: 1_000, now: () => clock });
    const asked = (text = "When is the meeting?"): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question(text), questionId: "q-1" });
    await registry.ask(asked());
    clock += 999;
    await registry.ask(asked());
    expect(model.requests).toHaveLength(1);
    await expect(registry.ask(asked("Where is it?"))).rejects.toBeInstanceOf(QuestionConflictError);
    clock += 1;
    expect(registry.stats()).toEqual({ running: 0, kept: 0, keptBytes: 0 });
    // Expired: the ID may name a new question.
    await registry.ask(asked("Where is it?"));
    expect(model.requests).toHaveLength(2);
    // keepMs 0 keeps nothing.
    const none = createQuestionRegistry({ keepMs: 0 });
    await none.ask(asked());
    await none.ask(asked());
    expect(model.requests).toHaveLength(4);
    expect(none.stats().kept).toBe(0);
  });

  it("another owner or scope under the same question ID is another question", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: true });
    const bytes = utf8("The meeting is on Tuesday at 10.");
    const ofA = await files.ingest({ name: "notes.txt", bytes, owner: "user-a" });
    const ofB = await files.ingest({ name: "notes.txt", bytes, owner: "user-b" });
    const inChat1 = await files.ingest({ name: "notes.txt", bytes, owner: "user-a", scope: ["user-a", "chat-1"] });
    const inChat2 = await files.ingest({ name: "notes.txt", bytes, owner: "user-a", scope: ["user-a", "chat-2"] });
    const model = fakeModel([says("On Tuesday.")]);
    const registry = createQuestionRegistry();
    const messages = question("When is the meeting?");
    await registry.ask({ files, model, owner: "user-a", documentIds: [ofA.id], messages, questionId: "q-1" });
    await registry.ask({ files, model, owner: "user-b", documentIds: [ofB.id], messages, questionId: "q-1" });
    await registry.ask({ files, model, owner: "user-a", scope: ["user-a", "chat-1"], documentIds: [inChat1.id], messages, questionId: "q-1" });
    await registry.ask({ files, model, owner: "user-a", scope: ["user-a", "chat-2"], documentIds: [inChat2.id], messages, questionId: "q-1" });
    expect(model.requests).toHaveLength(4);
    expect(registry.stats().kept).toBe(4);
    // Each gets its own answer back.
    await registry.ask({ files, model, owner: "user-b", documentIds: [ofB.id], messages, questionId: "q-1" });
    expect(model.requests).toHaveLength(4);
  });

  it("the same ID with other messages, documents or model is a QuestionConflictError", async () => {
    const { files, meta } = await smallNote();
    const other = await files.ingest({ name: "other.txt", bytes: utf8("Lunch is at noon."), owner: OWNER });
    const gate = held();
    const model = fakeModel([gate.scripted], { id: "model-a" });
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const running = registry.ask(asked());
    await gate.started;
    const others: QuestionAskOptions[] = [
      { ...asked(), messages: question("When is lunch?") },
      { ...asked(), documentIds: [meta.id, other.id] },
      { ...asked(), model: fakeModel([says("x")], { id: "model-b" }) },
      { ...asked(), explorer: fakeModel([says("x")], { id: "explorer" }) },
      { ...asked(), system: "Answer in Hebrew." },
    ];
    // While it runs, and after it ended: the kept answer conflicts until it expires.
    for (const phase of ["running", "kept"]) {
      for (const options of others) {
        const outcome = await settled(registry.ask(options));
        const error = (outcome as { error: QuestionConflictError }).error;
        expect(error).toBeInstanceOf(QuestionConflictError);
        expect(error).toBeInstanceOf(Error);
        expect(QuestionConflictError.is(error)).toBe(true);
        expect(error).toMatchObject({ name: "QuestionConflictError", code: "question_conflict", questionId: "q-1", message: CONFLICT });
        expect("status" in error).toBe(false);
        expect(errorInfoOf(error)).toEqual({ category: "input", code: "question_conflict", status: 409, retryable: false, message: CONFLICT });
        expect(() => registry.askStream(options)).toThrow(QuestionConflictError);
      }
      if (phase === "running") {
        gate.open();
        await running;
      }
    }
    // Limits, budget, the explorer given as the model itself, and callbacks are not part of the question.
    await registry.ask({ ...asked(), limits: { toolTurns: 3 }, budget: { inlineTokens: 50_000 }, explorer: model, onStep: () => undefined });
    expect(model.requests).toHaveLength(1);
    expect(QuestionConflictError.is({ name: "QuestionConflictError", code: "question_conflict" })).toBe(false);
  });

  it("a caller that leaves does not stop the question while another waits", async () => {
    const { files, meta } = await smallNote();
    const gate = held();
    const model = fakeModel([gate.scripted]);
    const registry = createQuestionRegistry({ detachedMs: 0 });
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const leaving = new AbortController();
    const one = registry.ask({ ...asked(), signal: leaving.signal });
    await gate.started;
    const two = registry.ask(asked());
    const reason = new DOMException("The tab was closed.", "AbortError");
    leaving.abort(reason);
    await expect(one).rejects.toBe(reason);
    expect(gate.seen.signal?.aborted).toBe(false);
    gate.open();
    await expect(two).resolves.toMatchObject({ answered: true, text: "On Tuesday." });
    expect(registry.stats()).toMatchObject({ running: 0, kept: 1 });
    // A caller whose signal already aborted joins nothing.
    const gone = new AbortController();
    gone.abort(reason);
    await expect(registry.ask({ ...asked(), signal: gone.signal })).rejects.toBe(reason);
  });

  it("a question nobody waits for goes on for detachedMs", async () => {
    const { files, meta } = await smallNote();
    const registry = createQuestionRegistry({ detachedMs: 200 });

    // Left, then asked again within detachedMs: the second request gets the answer of the first run.
    const gate = held();
    const model = fakeModel([gate.scripted]);
    const asked = (questionId: string, signal?: AbortSignal): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId, ...(signal ? { signal } : {}) });
    const broken = new AbortController();
    const one = registry.ask(asked("q-1", broken.signal));
    await gate.started;
    broken.abort(new Error("The stream broke."));
    await expect(one).rejects.toThrow("The stream broke.");
    expect(registry.stats().running).toBe(1);
    const retry = registry.ask(asked("q-1"));
    gate.open();
    await expect(retry).resolves.toMatchObject({ answered: true, text: "On Tuesday." });
    expect(model.requests).toHaveLength(1);

    // Left, and never asked again: stopped after detachedMs, with a reason that says so.
    const lonely = held();
    const alone = fakeModel([lonely.scripted]);
    const left = new AbortController();
    const two = registry.ask({ ...asked("q-2", left.signal), model: alone });
    await lonely.started;
    left.abort(new Error("The stream broke."));
    await expect(two).rejects.toThrow("The stream broke.");
    expect(lonely.seen.signal?.aborted).toBe(false);
    await expect.poll(() => lonely.seen.signal?.aborted, { timeout: 2_000 }).toBe(true);
    expect(lonely.seen.signal?.reason).toMatchObject({ name: "AbortError", message: NOBODY_WAITED });
    expect(registry.stats()).toMatchObject({ running: 0 });
    // Not kept: the same request runs the question again.
    lonely.open();
    await registry.ask({ ...asked("q-2"), model: alone });
    expect(alone.requests).toHaveLength(2);
  });

  it("detachedMs 0 stops it when its last caller leaves; Infinity runs it to the end and keeps the answer", async () => {
    const { files, meta } = await smallNote();
    const asked = (model: FakeModel, signal: AbortSignal): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1", signal });

    const now = held();
    const stopped = createQuestionRegistry({ detachedMs: 0 });
    const leaving = new AbortController();
    const one = stopped.ask(asked(fakeModel([now.scripted]), leaving.signal));
    await now.started;
    leaving.abort(new Error("Gone."));
    await expect(one).rejects.toThrow("Gone.");
    expect(now.seen.signal?.aborted).toBe(true);
    expect(now.seen.signal?.reason).toMatchObject({ name: "AbortError", message: NOBODY_WAITED });
    expect(stopped.stats().running).toBe(0);

    for (const detachedMs of [Number.POSITIVE_INFINITY, 2 ** 40]) {
      const gate = held();
      const model = fakeModel([gate.scripted]);
      const registry = createQuestionRegistry({ detachedMs });
      const away = new AbortController();
      const two = registry.ask(asked(model, away.signal));
      await gate.started;
      away.abort(new Error("Gone."));
      await expect(two).rejects.toThrow("Gone.");
      // 2^40 ms does not fit a timer (Node would fire it at once): it counts as Infinity.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(gate.seen.signal?.aborted).toBe(false);
      gate.open();
      await expect.poll(() => registry.stats().kept).toBe(1);
      await expect(registry.ask({ ...asked(model, new AbortController().signal) })).resolves.toMatchObject({ text: "On Tuesday." });
      expect(model.requests).toHaveLength(1);
    }
  });

  it("a failed question is not kept", async () => {
    const { files, meta, search } = await largeLog();
    const gate = held(new Error("The model broke."));
    const model = fakeModel([calls([search]), gate.scripted]);
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("How many errors?"), questionId: "q-1" });
    const first = recorder();
    const one = settled(registry.ask({ ...asked(), onEvent: first.onEvent }));
    await gate.started;
    const two = settled(registry.ask(asked()));
    gate.open();
    const [e1, e2] = [((await one) as { error: unknown }).error, ((await two) as { error: unknown }).error];
    expect(e1).toBeInstanceOf(Error);
    expect(e2).toBe(e1);
    expect(partialResultOf(e1)).toMatchObject({ answered: false, questionId: "q-1", steps: [expect.stringContaining("Search app.log")] });
    expect(first.events.at(-1)).toMatchObject({ type: "run.error", questionId: "q-1" });
    expect(registry.stats()).toEqual({ running: 0, kept: 0, keptBytes: 0 });
    // Asked again: it runs again (the last entry of the script repeats: the model fails again).
    await expect(registry.ask(asked())).rejects.toThrow("The model broke.");
    expect(model.requests).toHaveLength(3);
  });

  it("a listener that throws detaches its caller only", async () => {
    const { files, meta } = await smallNote();
    const gate = held();
    const model = fakeModel([gate.scripted]);
    const registry = createQuestionRegistry({ detachedMs: 0 });
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const thrown = new Error("The listener failed.");
    const one = registry.ask({ ...asked(), onEvent: (event) => { if (event.type === "request.end") throw thrown; } });
    await gate.started;
    const texts: string[] = [];
    const steps: string[] = [];
    const two = registry.ask({ ...asked(), onText: (delta) => void texts.push(delta), onStep: (step) => void steps.push(step) });
    const textThrows = registry.ask({ ...asked(), onText: () => { throw thrown; } });
    gate.open();
    await expect(one).rejects.toBe(thrown);
    await expect(textThrows).rejects.toBe(thrown);
    await expect(two).resolves.toMatchObject({ answered: true, text: "On Tuesday." });
    expect(texts.join("")).toBe("On Tuesday.");
    expect(model.requests).toHaveLength(1);
    expect(registry.stats().kept).toBe(1);
  });

  it("stop() ends a running question for every caller", async () => {
    const { files, meta } = await smallNote();
    const gate = held();
    const model = fakeModel([gate.scripted]);
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const one = settled(registry.ask(asked()));
    await gate.started;
    const two = settled(registry.ask(asked()));
    expect(registry.stop("q-1", { owner: "someone-else" })).toBe(false);
    expect(registry.stop("q-2", { owner: OWNER })).toBe(false);
    expect(registry.stop("q-1", { owner: OWNER })).toBe(true);
    expect(registry.stats().running).toBe(0);
    const e1 = ((await one) as { error: unknown }).error;
    expect(e1).toMatchObject({ name: "AbortError", message: "The question was stopped." });
    expect(((await two) as { error: unknown }).error).toBe(e1);
    expect(gate.seen.signal?.aborted).toBe(true);
    expect(registry.stop("q-1", { owner: OWNER })).toBe(false);

    // With a reason of its own; a kept answer stays.
    gate.open();
    const answered = await registry.ask(asked());
    expect(answered.text).toBe("On Tuesday.");
    expect(registry.stop("q-1", { owner: OWNER })).toBe(false);
    expect(registry.stats().kept).toBe(1);
    const late = held();
    const slow = fakeModel([late.scripted]);
    const three = registry.ask({ ...asked(), model: slow, questionId: "q-3" });
    await late.started;
    const reason = new Error("The chat was deleted.");
    expect(registry.stop("q-3", { owner: OWNER }, reason)).toBe(true);
    await expect(three).rejects.toBe(reason);
  });

  it("keeps at most maxQuestions and maxBytes of answers, the oldest first out; an answer over maxBytes is not kept", async () => {
    const { files, meta } = await smallNote();
    const model = fakeModel([says("On Tuesday.")]);
    const asked = (questionId: string): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId });

    const two = createQuestionRegistry({ maxQuestions: 2 });
    for (const id of ["q-1", "q-2", "q-3"]) await two.ask(asked(id));
    expect(two.stats().kept).toBe(2);
    await two.ask(asked("q-3"));
    await two.ask(asked("q-2"));
    expect(model.requests).toHaveLength(3);
    await two.ask(asked("q-1")); // pushed out first: it runs again, and pushes out q-2
    expect(model.requests).toHaveLength(4);
    expect(two.stats().kept).toBe(2);

    const measure = createQuestionRegistry();
    await measure.ask(asked("q-1"));
    const one = measure.stats().keptBytes;
    const bounded = createQuestionRegistry({ maxBytes: Math.floor(one * 1.5) });
    await bounded.ask(asked("q-1"));
    await bounded.ask(asked("q-2"));
    expect(bounded.stats()).toEqual({ running: 0, kept: 1, keptBytes: one });
    const before = model.requests.length;
    await bounded.ask(asked("q-2"));
    expect(model.requests).toHaveLength(before);
    await bounded.ask(asked("q-1"));
    expect(model.requests).toHaveLength(before + 1);

    const tiny = createQuestionRegistry({ maxBytes: one - 1 });
    await tiny.ask(asked("q-1"));
    expect(tiny.stats()).toEqual({ running: 0, kept: 0, keptBytes: 0 });
  });

  it("when every slot runs a question, a new one runs unkept", async () => {
    const { files, meta } = await smallNote();
    const gate = held();
    // Only the first question waits.
    const model = fakeModel([(request, call, hooks) => (JSON.stringify(request.messages).includes("first") ? gate.scripted(request, call, hooks) : says("Now."))]);
    const registry = createQuestionRegistry({ maxQuestions: 1 });
    const asked = (questionId: string, text: string): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question(text), questionId });
    const first = registry.ask(asked("q-1", "The first question"));
    await gate.started;
    const { events, onEvent } = recorder();
    await expect(registry.ask({ ...asked("q-2", "Another"), onEvent })).resolves.toMatchObject({ text: "Now.", questionId: "q-2" });
    expect(events[0]).toMatchObject({ type: "run.start", questionId: "q-2" });
    expect(registry.stats()).toEqual({ running: 1, kept: 0, keptBytes: 0 });
    await registry.ask(asked("q-2", "Another"));
    expect(model.requests).toHaveLength(3);
    gate.open();
    await first;
    expect(registry.stats()).toMatchObject({ running: 0, kept: 1 });
    // A kept answer makes room: the oldest goes.
    await registry.ask(asked("q-2", "Another"));
    expect(registry.stats().kept).toBe(1);
    await registry.ask(asked("q-2", "Another"));
    expect(model.requests).toHaveLength(4);
  });

  it("askStream gives a joiner the events from when it joined, then run.finish", async () => {
    const { files, meta } = await smallNote();
    const gate = held();
    const model = fakeModel([gate.scripted]);
    const registry = createQuestionRegistry();
    const asked = (): QuestionAskOptions => ({ files, model, owner: OWNER, documentIds: [meta.id], messages: question("When is the meeting?"), questionId: "q-1" });
    const read = async (stream: AsyncIterable<AskEvent>) => {
      const events: AskEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    };
    const first = registry.askStream(asked());
    const reading = read(first);
    await gate.started;
    const second = registry.askStream(asked());
    const joined = read(second);
    // A third joins and leaves before any event, as a loop left early leaves: only it is detached.
    const third = registry.askStream(asked());
    await third[Symbol.asyncIterator]().return?.();
    await expect(third.result).rejects.toMatchObject({ name: "AbortError", message: "The events stopped being read." });
    gate.open();
    const [a, b] = await Promise.all([reading, joined]);
    expect(a[0]).toMatchObject({ type: "run.start", seq: 1, questionId: "q-1" });
    expect(a.map((event) => event.type)).toContain("text");
    expect(b[0]!.seq).toBeGreaterThan(1);
    expect(b.at(-1)).toMatchObject({ type: "run.finish", questionId: "q-1" });
    expect(a.slice(-b.length)).toEqual(b);
    const r1: AskResult = await first.result;
    const r2: AskResult = await second.result;
    expect(r2).toEqual(r1);
    expect(model.requests).toHaveLength(1);
    // Once it is kept, a stream of it is its run.finish alone.
    const kept = registry.askStream(asked());
    expect(await read(kept)).toEqual([a.at(-1)]);
    await expect(kept.result).resolves.toEqual(r1);
  });

  it("checks its options", async () => {
    expect(() => createQuestionRegistry({ keepMs: "600000" as unknown as number })).toThrow(new TypeError("keepMs must be a number, and is \"600000\"."));
    expect(() => createQuestionRegistry({ detachedMs: Number.NaN })).toThrow(new RangeError("detachedMs must be a number, and is NaN. Leave it out for the default."));
    expect(() => createQuestionRegistry({ maxBytes: -1 })).toThrow(new RangeError("maxBytes must be 0 or more, and is -1."));
    expect(() => createQuestionRegistry({ keepMs: -5 })).toThrow(new RangeError("keepMs must be 0 or more, and is -5."));
    expect(() => createQuestionRegistry({ maxQuestions: 0.5 })).toThrow(new RangeError("maxQuestions must be 1 or more, and is 0.5."));
    expect(() => createQuestionRegistry({ maxQuestions: -3 })).toThrow(new RangeError("maxQuestions must be 1 or more, and is -3."));
    expect(() => createQuestionRegistry({ maxQuestions: null as unknown as number })).toThrow(new TypeError("maxQuestions must be a number, and is object."));
    expect(() => createQuestionRegistry({ now: 5 as unknown as () => number })).toThrow(new TypeError("now must be a function, such as Date.now, and is number."));
    expect(createQuestionRegistry({ keepMs: Number.POSITIVE_INFINITY, maxQuestions: Number.POSITIVE_INFINITY, maxBytes: 0, detachedMs: 0 }).stats()).toEqual({ running: 0, kept: 0, keptBytes: 0 });

    // What the question is made of must be JSON, to tell a request sent again from another question.
    const { files, meta } = await smallNote();
    const model = fakeModel([says("On Tuesday.")]);
    const registry = createQuestionRegistry();
    const big = [{ role: "user", text: "When?", native: 1n }] as unknown as ChatMessage[];
    await expect(registry.ask({ files, model, owner: OWNER, documentIds: [meta.id], messages: big, questionId: "q-1" })).rejects.toThrow(new TypeError("questionId needs messages, documentIds and system that JSON can hold: Do not know how to serialize a BigInt."));
    const loop: Record<string, unknown> = { role: "user", text: "When?" };
    loop.self = loop;
    const circular = { files, model, owner: OWNER, documentIds: [meta.id], messages: [loop] as unknown as ChatMessage[], questionId: "q-1" };
    expect(() => registry.askStream(circular)).toThrow(/^questionId needs messages, documentIds and system that JSON can hold: Converting circular structure to JSON\.$/);
    expect(model.requests).toHaveLength(0);
  });
});
