// The first request of a question whose stored rounds would make it too large (0.9.0): their results
// are shortened before it is sent, as 0.8.2 shortened them after the provider refused it. probe-l3
// showed a first request estimated at 124,000 tokens against a limit of 112,000, sent as it was:
// one refused request for each such question, and Claude, which may not have its conversation
// shortened, failed the question.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, ModelRequestError, type AskEvent, type ChatMessage, type LargeFiles, type ModelMessage, type ModelRequest, type ToolTurn } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

/** Four earlier questions, each with a stored read of 200 lines: about 13,700 estimated tokens a round. */
async function history() {
  const files = createLargeFiles({ store: new MemoryDocumentStore() });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
  const tools = files.tools([meta]);
  const messages: ChatMessage[] = [];
  for (let n = 0; n < 4; n++) {
    const args = { document_id: meta.id, start_line: 1 + n * 200, end_line: 200 + n * 200 };
    const turn: ToolTurn = { role: "tools", calls: [{ name: "read_document", args, result: await tools.execute("read_document", args) }] };
    messages.push({ role: "user", text: `Question ${n + 1}?` }, turn, { role: "assistant", text: `Answer ${n + 1}.` });
  }
  messages.push({ role: "user", text: "And now?" });
  return { files, meta, messages };
}

/** Fixed fields, so that only the window differs between two questions. */
const budget = (contextTokens: number) => ({ contextTokens, inlineTokens: 1_000, reservedTokens: 2_000, toolResultCharacters: 24_000, mapChunkTokens: 5_000 });
/** Which stored results of a request are stand-ins, round by round. */
const dropped = (messages: ModelMessage[]) => messages.flatMap((message) => (message.role === "tools" ? [message.answers.every((answer) => answer.result.dropped === true)] : []));
/** A request as the provider gets it. */
const body = (request: ModelRequest) => JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools, toolChoice: request.toolChoice });
/** A model with a window of `window` estimated tokens: a request over it is refused, as a provider refuses it. */
const windowOf = (window: number, events: AskEvent[], then: Parameters<typeof fakeModel>[0][number]) => () => {
  const start = events.filter((event) => event.type === "request.start").at(-1);
  const estimated = start?.type === "request.start" ? start.estimatedInputTokens ?? 0 : 0;
  if (estimated > window) return new ModelRequestError(`This model's maximum context length is ${window} tokens. However, your messages resulted in ${estimated} tokens.`, 400);
  return typeof then === "function" ? then({} as ModelRequest, 0, {}) : then;
};

async function ask(files: LargeFiles, documentIds: string[], messages: ChatMessage[], contextTokens: number, script: (events: AskEvent[]) => Parameters<typeof fakeModel>[0], appendOnly = false) {
  const events: AskEvent[] = [];
  const model = fakeModel(script(events), appendOnly ? { appendOnly: true } : {});
  const result = await askWithFiles({ files, model, documentIds, messages, budget: budget(contextTokens), onEvent: (event) => events.push(event) });
  return { model, result, events };
}

describe("the first request of a question with stored rounds too large for it", () => {
  it("is sent with their results shortened, and is not refused", async () => {
    const { files, meta, messages } = await history();
    // The window holds the request with one stored round in full, not two.
    const { model, result, events } = await ask(files, [meta.id], messages, 30_000, (seen) => [windowOf(29_000, seen, says("From what was read before."))]);
    expect(model.requests).toHaveLength(1);
    expect(dropped(model.requests[0]!.messages)).toEqual([true, true, true, false]);
    expect(result).toMatchObject({ answered: true, text: "From what was read before.", steps: ["Older tool results were shortened to make room in the request"] });
    expect(events.some((event) => event.type === "notice" && event.code === "results_shortened")).toBe(true);
    expect(events.some((event) => event.type === "notice" && event.code === "room_made")).toBe(false);
  });

  it("is what 0.8.2 sent after the provider refused it, without the refused request", async () => {
    const { files, meta, messages } = await history();
    const now = await ask(files, [meta.id], messages, 30_000, () => [says("Done.")]);
    // 0.8.2: a budget that did not know the window, and a provider that refused the first request,
    // with its count (the estimate) and its window (30,000).
    let refused = false;
    const then = await ask(files, [meta.id], messages, 1_000_000, (seen) => [() => {
      if (refused) return says("Done.");
      refused = true;
      const start = seen.find((event) => event.type === "request.start");
      const estimated = start?.type === "request.start" ? start.estimatedInputTokens! : 0;
      return new ModelRequestError(`This model's maximum context length is 30000 tokens. However, your messages resulted in ${estimated} tokens.`, 400);
    }]);
    expect(then.model.requests).toHaveLength(2);
    expect(dropped(then.model.requests[0]!.messages)).toEqual([false, false, false, false]);
    expect(now.model.requests).toHaveLength(1);
    expect(body(now.model.requests[0]!)).toBe(body(then.model.requests[1]!));
  });

  it("is shortened for a model whose conversation may only grow, which failed the question before", async () => {
    const { files, meta, messages } = await history();
    const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const { model, result } = await ask(files, [meta.id], messages, 30_000, (seen) => [windowOf(29_000, seen, calls([search])), windowOf(29_000, seen, says("51 errors."))], true);
    expect(result).toMatchObject({ answered: true, text: "51 errors." });
    expect(dropped(model.requests[0]!.messages)).toEqual([true, true, true, false]);
    // The rounds of this question are not shortened: only the stored ones were, before anything was sent.
    expect(dropped(model.requests[1]!.messages)).toEqual([true, true, true, false, false]);
  });

  it("is shortened in a question with no file to search", async () => {
    const { files, messages } = await history();
    const { model, result } = await ask(files, [], messages, 30_000, (seen) => [windowOf(29_000, seen, says("From before."))]);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools).toBeUndefined();
    expect(dropped(model.requests[0]!.messages)).toEqual([true, true, true, false]);
    expect(result.answered).toBe(true);
  });

  it("is left as it is when it fits", async () => {
    const { files, meta, messages } = await history();
    const { model, result } = await ask(files, [meta.id], messages, 1_000_000, () => [says("Done.")]);
    expect(dropped(model.requests[0]!.messages)).toEqual([false, false, false, false]);
    expect(result.steps).toEqual([]);
  });
});
