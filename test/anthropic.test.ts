import { describe, expect, it, vi } from "vitest";
import { askWithFiles, createLargeFiles, FINAL_ANSWER_REQUEST, MemoryDocumentStore, ModelRequestError, type ModelRequest, type ToolTurn } from "llm-large-files";
import { anthropic, ANTHROPIC_VERSION, anthropicToolTurns, AnthropicRequestError, fromAnthropicMessages } from "llm-large-files/anthropic";
import { THINKING_OUTPUT_TOKENS } from "llm-large-files/gemini";
import { numberedPdf } from "./pdf-fixtures.js";
import { fakeModel, calls as modelCalls, says, serviceLog, utf8 } from "./fake-model.js";

type Json = Record<string, any>;
type Sent = { url: string; headers: Record<string, string>; body: Json };

const encoder = new TextEncoder();
const question = (text: string) => [{ role: "user" as const, text }];
const message = (content: Json[], stop = "end_turn", usage: Json = { input_tokens: 900, output_tokens: 30 }, more: Json = {}) => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content, stop_reason: stop, usage, ...more });
const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, input: Json) => ({ type: "tool_use", id, name, input });
/** A response as a stream of events, each under its event name, as the API sends them. */
const sse = (events: Json[]) => new Response(new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    controller.close();
  },
}), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });

/** The events of one finished message, with text and tool input in two pieces each. */
function streamOf(content: Json[], stop = "end_turn", usage: Json = { input_tokens: 900, output_tokens: 30 }, stopDetails?: Json): Json[] {
  const events: Json[] = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { ...usage, output_tokens: 1 } } }, { type: "ping" }];
  content.forEach((block, index) => {
    const half = (value: string) => [value.slice(0, Math.ceil(value.length / 2)), value.slice(Math.ceil(value.length / 2))];
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of half(block.text)) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const piece of half(block.thinking)) events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: piece } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      for (const piece of half(typeof block.input === "string" ? block.input : JSON.stringify(block.input))) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: usage.output_tokens } }, { type: "message_stop" });
  return events;
}

/** An API that answers each request from a script and notes what it was sent. The last entry repeats. */
function fakeApi(replies: Array<object | Response | ((sent: Sent) => object | Response)>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request: Sent = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Json };
    sent.push(request);
    const entry = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    const value = typeof entry === "function" ? entry(request) : entry;
    if (value instanceof Response) return value.clone();
    // A request that asks for a stream gets one.
    return request.body.stream ? sse(streamOf((value as Json).content, (value as Json).stop_reason, (value as Json).usage, (value as Json).stop_details)) : Response.json(value);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

async function largeLog(budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "prod.log", bytes: utf8(serviceLog(5_000)) });
  return { files, meta };
}

const request = (value: string, more: Partial<ModelRequest> = {}): ModelRequest => ({ system: "", messages: [{ role: "user", parts: [{ text: value }] }], ...more });

describe("Claude through the Messages API", () => {
  it("is called with the key, the version and the settings of the adapter", async () => {
    const api = fakeApi([message([text("Hello.")])]);
    let keys = 0;
    const model = anthropic({ model: "claude-opus-5-5", apiKey: () => `sk-${++keys}`, fetch: api.fetch });
    expect(model.id).toBe("claude-opus-5-5");
    expect(model.capabilities).toEqual({ maxRequestBytes: 32_000_000, toolFiles: "inside", pageTokens: 3_500, tokenScale: 1.35, outputTokens: 64_000, appendOnly: true });
    await model.send(request("Hi", { system: "Be brief." }));
    await model.send(request("Hi"));
    expect(api.sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(api.sent[0]!.headers).toEqual({ "Content-Type": "application/json", "anthropic-version": ANTHROPIC_VERSION, "x-api-key": "sk-1" });
    expect(api.sent[1]!.headers["x-api-key"]).toBe("sk-2");
    // Streamed, cached up to its last block, and with room for a long reply.
    expect(api.sent[0]!.body).toEqual({ model: "claude-opus-5-5", max_tokens: 64_000, system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], stream: true, cache_control: { type: "ephemeral" } });
    expect("system" in api.sent[1]!.body).toBe(false);

    const gateway = fakeApi([message([text("ok")])]);
    const other = anthropic({
      model: "claude-haiku-4-5", baseUrl: "https://llm-gateway.corp.example/anthropic/", authToken: "tok", headers: { "X-Team": "search" }, version: "2023-06-01",
      betas: ["context-management-2025-06-27"], maxTokens: 8_000, cache: "1h", stream: false, contextTokens: 200_000, pageTokens: 2_000, tokenScale: 1.2, toolFilePlacement: "none",
      body: { output_config: { effort: "low" }, context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } }, fetch: gateway.fetch,
    });
    expect(other.capabilities).toEqual({ contextTokens: 200_000, maxRequestBytes: 32_000_000, toolFiles: "none", pageTokens: 2_000, tokenScale: 1.2, outputTokens: 8_000, appendOnly: true });
    expect((await other.send(request("Hi"))).text).toBe("ok");
    expect(gateway.sent[0]!.url).toBe("https://llm-gateway.corp.example/anthropic/v1/messages");
    expect(gateway.sent[0]!.headers).toEqual({ "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "context-management-2025-06-27", Authorization: "Bearer tok", "X-Team": "search" });
    expect(gateway.sent[0]!.body).toEqual({
      model: "claude-haiku-4-5", max_tokens: 8_000, messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], cache_control: { type: "ephemeral", ttl: "1h" },
      output_config: { effort: "low" }, context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    });
    const bare = fakeApi([message([text("ok")])]);
    await anthropic({ model: "m", apiKey: "k", cache: false, fetch: bare.fetch }).send(request("Hi"));
    expect("cache_control" in bare.sent[0]!.body).toBe(false);
  });

  it("runs the tool loop: its own turn back unchanged, every result in one user turn, the tools kept for the answer", async () => {
    const { files, meta } = await largeLog();
    const thinking = { type: "thinking", thinking: "", signature: "sig-bound-to-this-conversation" };
    const first = [thinking, text("Checking."), toolUse("toolu_1", "search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 2 }), toolUse("toolu_2", "read_document", { document_id: "doc_unknown", start_line: 1 })];
    const api = fakeApi([
      message(first, "tool_use", { input_tokens: 50, cache_creation_input_tokens: 800, cache_read_input_tokens: 0, output_tokens: 40 }),
      (sent) => (sent.body.tool_choice ? message([text("51 errors, the first at L97.")], "end_turn", { input_tokens: 30, cache_creation_input_tokens: 300, cache_read_input_tokens: 2_100, output_tokens: 20 })
        : message([{ ...thinking, signature: "sig-2" }, toolUse("toolu_3", "read_document", { document_id: meta.id, start_line: 96, end_line: 98 })], "tool_use", { input_tokens: 20, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 850, output_tokens: 25 })),
    ]);
    const model = anthropic({ model: "claude-opus-5-5", apiKey: "k", fetch: api.fetch });
    const deltas: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], system: "Be brief.", limits: { toolTurns: 3 }, messages: question("How many errors?"), onText: (delta) => deltas.push(delta) });
    const [one, two, three] = api.sent;
    expect(Object.keys(one!.body)).toEqual(["model", "max_tokens", "system", "messages", "tools", "stream", "cache_control"]);
    expect(one!.body.tools[0]).toEqual({ name: "search_document", description: expect.any(String), input_schema: expect.objectContaining({ type: "object", required: ["document_id", "query"] }), eager_input_streaming: true });
    expect(one!.body.system).toMatch(/^Be brief\.\n\nSome attached files are too large/);
    // The card and the question: two blocks of one user turn.
    expect(one!.body.messages).toHaveLength(1);
    expect(one!.body.messages[0].content.map((block: Json) => block.type)).toEqual(["text", "text"]);
    expect(one!.body.messages[0].content[1]).toEqual({ type: "text", text: "How many errors?" });

    // The second request: the assistant turn exactly as it came, thinking block and all.
    expect(two!.body.messages[1]).toEqual({ role: "assistant", content: first });
    const results = two!.body.messages[2].content as Json[];
    expect(two!.body.messages[2].role).toBe("user");
    expect(results.map((block) => [block.type, block.tool_use_id, block.is_error])).toEqual([["tool_result", "toolu_1", undefined], ["tool_result", "toolu_2", true]]);
    expect(JSON.parse(results[0]!.content)).toMatchObject({ document: "prod.log", total_matching_lines: 51, tool_turns_left: 1 });
    expect(JSON.parse(results[1]!.content).error).toMatch(/^Unknown document_id doc_unknown/);
    // Nothing that was sent before is changed in a later request: the thinking of a turn is tied to what came before it.
    expect(two!.body.messages.slice(0, 1)).toEqual(one!.body.messages);
    expect(three!.body.messages.slice(0, 3)).toEqual(two!.body.messages);
    expect(three!.body.system).toBe(one!.body.system);
    // The answer: the same tools, a choice of none, and the request for it after the results, in their turn.
    expect(three!.body.tools).toEqual(one!.body.tools);
    expect(three!.body.tool_choice).toEqual({ type: "none" });
    expect(one!.body.tool_choice).toBeUndefined();
    const last = three!.body.messages.at(-1);
    expect(three!.body.messages.map((sent: Json) => sent.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(last.content.map((block: Json) => block.type)).toEqual(["tool_result", "text"]);
    expect(last.content[1]).toEqual({ type: "text", text: FINAL_ANSWER_REQUEST });

    expect(result).toMatchObject({ text: "Checking.\n\n51 errors, the first at L97.", answered: true, turns: 3, finishReason: "end_turn" });
    expect(deltas.join("")).toBe(result.text);
    // The prompt is what was read from the cache, what was written to it, and the rest.
    expect(result.usage).toMatchObject({ requests: 3, inputTokens: 850 + 2_070 + 2_430, cachedInputTokens: 2_950, outputTokens: 85 });
    expect(result.lastUsage).toMatchObject({ cache_read_input_tokens: 2_100, output_tokens: 20 });
  });

  it("never rewrites a conversation: old results stay as they were, and the room that runs out ends the tools", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { reservedTokens: 8_000, inlineTokens: 30_000 } });
    const meta = await files.ingest({ name: "prod.log", bytes: utf8(serviceLog(60_000)) });
    let next = 1;
    let id = 0;
    const api = fakeApi([(sent) => {
      if (sent.body.tool_choice) return message([text("From what I read.")]);
      const batch = [0, 1, 2].map(() => {
        const start = next;
        next += 600;
        return toolUse(`toolu_${++id}`, "read_document", { document_id: meta.id, start_line: start, end_line: start + 599 });
      });
      return message([{ type: "thinking", thinking: "", signature: `sig-${id}` }, ...batch], "tool_use");
    }]);
    // A window of 102,600 of Claude's tokens is 76,000 by the estimate, and the 16,200 kept for the reply are 12,000 of them.
    const model = anthropic({ model: "claude-test", apiKey: "k", contextTokens: 102_600, maxTokens: 16_200, fetch: api.fetch });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    expect(result.budget.contextTokens).toBe(64_000);
    expect(result.answered).toBe(true);
    for (let index = 1; index < api.sent.length; index++) {
      const before = api.sent[index - 1]!.body.messages as Json[];
      const now = api.sent[index]!.body.messages as Json[];
      // Every message but the last is as it was; the last one only grew (the request for the answer joins the results).
      expect(now.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    }
    expect(JSON.stringify(api.sent.at(-1)!.body)).not.toContain("dropped");
    expect(result.steps.some((step) => step.includes("no room left"))).toBe(true);
    expect(result.steps).not.toContain("Older tool results were shortened to make room in the request");
  });

  it("puts the pages of a PDF in the tool result, as a document, or after the results", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const script = () => fakeApi([message([toolUse("toolu_1", "view_pages", { document_id: meta.id, from_page: 2, to_page: 3 })], "tool_use"), message([text("Page 2 shows a bar chart.")])]);
    const inside = script();
    const result = await askWithFiles({ files, model: anthropic({ model: "claude-test", apiKey: "k", fetch: inside.fetch }), documentIds: [meta.id], messages: question("What is on page 2?") });
    expect(inside.sent[0]!.body.tools.map((tool: Json) => tool.name)).toEqual(["view_pages"]);
    const [block] = inside.sent[1]!.body.messages.at(-1).content as Json[];
    expect(block!.type).toBe("tool_result");
    expect(JSON.parse(block!.content[0].text)).toEqual({ document: "report.pdf", pages: "2-3", total_pages: 6, file: "pages-2-3.pdf", tool_turns_left: 10 });
    expect(block!.content[1]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: expect.stringMatching(/^JVBERi0/) } });
    expect(result.steps).toEqual(["Look at report.pdf pages 2-3"]);

    const beside = script();
    await askWithFiles({ files, model: anthropic({ model: "claude-test", apiKey: "k", toolFilePlacement: "beside", fetch: beside.fetch }), documentIds: [meta.id], messages: question("What is on page 2?") });
    const turn = beside.sent[1]!.body.messages.at(-1).content as Json[];
    expect(turn.map((part) => part.type)).toEqual(["tool_result", "text", "document"]);
    expect(typeof turn[0]!.content).toBe("string");
    expect(turn[1]).toEqual({ type: "text", text: "pages-2-3.pdf (returned by view_pages):" });

    const none = script();
    await askWithFiles({ files, model: anthropic({ model: "claude-test", apiKey: "k", toolFilePlacement: "none", fetch: none.fetch }), documentIds: [meta.id], messages: question("What is on page 2?") });
    expect(none.sent[0]!.body.tools).toBeUndefined();
  });

  it("reads a streamed reply: text as it comes, thinking with its signature, tool input from its pieces", async () => {
    const thinking = { type: "thinking", thinking: "The user wants line 97.", signature: "sig-abc" };
    const call = toolUse("toolu_7", "read_document", { document_id: "doc_1", start_line: 96, end_line: 98 });
    const api = fakeApi([sse(streamOf([thinking, text("Looking at it."), call], "tool_use", { input_tokens: 10, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 44 }))]);
    const model = anthropic({ model: "claude-test", apiKey: "k", fetch: api.fetch });
    const deltas: string[] = [];
    const reply = await model.send(request("?"), { onText: (delta) => deltas.push(delta) });
    expect(deltas).toEqual(["Looking", " at it."]);
    expect(reply).toEqual({
      text: "Looking at it.",
      calls: [{ id: "toolu_7", name: "read_document", args: { document_id: "doc_1", start_line: 96, end_line: 98 } }],
      raw: [thinking, text("Looking at it."), call],
      finishReason: "tool_use",
      usage: { inputTokens: 710, cachedInputTokens: 700, outputTokens: 44, thoughtTokens: 0 },
      providerUsage: { input_tokens: 10, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 44 },
    });
  });

  it("does not run a call that was cut off or whose input is not JSON, and reports a refusal as one", async () => {
    const api = fakeApi([
      sse(streamOf([toolUse("toolu_1", "read_document", "{\"document_id\": \"doc" as never), toolUse("toolu_2", "read_document", { document_id: "d", start_line: 1 })], "tool_use")),
      message([text("Let me read it."), toolUse("toolu_3", "read_document", { document_id: "d" })], "max_tokens"),
      message([text("I can help with")], "refusal", { input_tokens: 5, output_tokens: 4 }, { stop_details: { type: "refusal", category: "cyber", explanation: "…" } }),
      message([], "refusal", { input_tokens: 5, output_tokens: 0 }, { stop_details: null }),
    ]);
    const model = anthropic({ model: "claude-test", apiKey: "k", stream: false, fetch: api.fetch });
    const streamed = await anthropic({ model: "claude-test", apiKey: "k", fetch: api.fetch }).send(request("?"));
    expect(streamed.calls[0]).toEqual({ id: "toolu_1", name: "read_document", args: {}, problem: "The arguments of this call were not valid JSON, and it was not run: {\"document_id\": \"doc. Send the call again." });
    expect(streamed.calls[1]).toEqual({ id: "toolu_2", name: "read_document", args: { document_id: "d", start_line: 1 } });
    // What goes back has an object where the input was, so the turn can be answered.
    expect((streamed.raw as Json[])[0]).toEqual({ type: "tool_use", id: "toolu_1", name: "read_document", input: {} });

    const cut = await model.send(request("?"));
    expect(cut.finishReason).toBe("max_tokens");
    expect(cut.calls).toEqual([{ id: "toolu_3", name: "read_document", args: { document_id: "d" }, problem: "This call was cut off at the output limit before its arguments were complete, and was not run. Send it again." }]);

    expect(await model.send(request("?"))).toMatchObject({ text: "I can help with", calls: [], finishReason: "refusal", blockReason: "refusal: cyber" });
    expect(await model.send(request("?"))).toMatchObject({ text: "", calls: [], blockReason: "refusal" });
  });

  it("asks another model to answer a declined request when told to, and echoes its turn as the API wants it", async () => {
    const declined = [{ type: "thinking", thinking: "", signature: "sig-declined" }, text("Partial "), { type: "fallback", from: { model: "claude-fable-5-2" }, to: { model: "claude-opus-4-8" } }, { type: "thinking", thinking: "", signature: "sig-fallback" }, toolUse("toolu_9", "read_document", { document_id: "d", start_line: 1 })];
    const usage = { input_tokens: 40, output_tokens: 12, iterations: [{ type: "message", input_tokens: 900, output_tokens: 6 }, { type: "fallback_message", input_tokens: 40, cache_read_input_tokens: 860, output_tokens: 12 }] };
    const api = fakeApi([message(declined, "tool_use", usage), message([text("ok")])]);
    const model = anthropic({ model: "claude-fable-5-2", apiKey: "k", stream: false, betas: ["context-management-2025-06-27"], fallbacks: "default", fetch: api.fetch });
    const reply = await model.send(request("?"));
    expect(api.sent[0]!.headers["anthropic-beta"]).toBe("context-management-2025-06-27,server-side-fallback-2026-07-01");
    expect(api.sent[0]!.body.fallbacks).toBe("default");
    // Both attempts were billed.
    expect(reply.usage).toEqual({ inputTokens: 1_800, cachedInputTokens: 860, outputTokens: 18, thoughtTokens: 0 });
    expect(reply.calls).toEqual([{ id: "toolu_9", name: "read_document", args: { document_id: "d", start_line: 1 } }]);
    // Of the model that declined, the text is kept and the thinking is not; the switch stays where it was.
    expect((reply.raw as Json[]).map((block) => block.signature ?? block.type)).toEqual(["text", "fallback", "sig-fallback", "tool_use"]);
    const listed = fakeApi([message([text("ok")])]);
    await anthropic({ model: "claude-fable-5-2", apiKey: "k", fallbacks: [{ model: "claude-opus-4-8" }], fetch: listed.fetch }).send(request("?"));
    expect(listed.sent[0]!.body.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
    expect(listed.sent[0]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
  });

  it("reports an HTTP error with its kind and the wait it names, and an overload in the stream as one to retry", async () => {
    const api = fakeApi([
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your rate limit." }, request_id: "req_1" }), { status: 429, headers: { "retry-after": "12" } }),
      new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.5.content.0: Invalid `signature` in `thinking` block." } }), { status: 400 }),
      new Response("<html>bad gateway</html>", { status: 502 }),
      sse([{ type: "message_start", message: { usage: { input_tokens: 5 } } }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]),
    ]);
    const model = anthropic({ model: "claude-test", apiKey: "k", fetch: api.fetch });
    const limited = await model.send(request("?")).catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(AnthropicRequestError);
    expect(limited).toBeInstanceOf(ModelRequestError);
    expect(limited).toMatchObject({ name: "AnthropicRequestError", status: 429, type: "rate_limit_error", retryAfterMs: 12_000, message: "This request would exceed your rate limit." });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 400, type: "invalid_request_error" });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 502, message: "Claude returned HTTP 502." });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 529, type: "overloaded_error", message: "Overloaded" });
    const down = anthropic({ model: "claude-test", apiKey: "k", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.send(request("?"))).rejects.toMatchObject({ status: 0, message: "Claude could not be reached (fetch failed)." });
  });

  it("reads a part of a file without sampling settings, and asks again when thinking used the whole limit", async () => {
    const api = fakeApi([(sent) => (sent.body.max_tokens < THINKING_OUTPUT_TOKENS
      ? message([{ type: "thinking", thinking: "", signature: "s" }], "max_tokens", { input_tokens: 25_000, output_tokens: sent.body.max_tokens })
      : message([{ type: "thinking", thinking: "", signature: "s" }, text("Deadlocks at (L250).")], "end_turn", { input_tokens: 25_000, output_tokens: 1_100 }))]);
    const model = anthropic({ model: "claude-opus-5-5", apiKey: "k", analysisBody: () => ({ output_config: { effort: "low" } }), fetch: api.fetch });
    const used: unknown[] = [];
    expect(await model.generateText!({ system: "Take notes.", prompt: "PART", maxOutputTokens: 4_096, onUsage: (usage) => used.push(usage) })).toBe("Deadlocks at (L250).");
    expect(api.sent.map((sent) => sent.body.max_tokens)).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    // No stream, no cache marker on a prompt that is never sent twice, and nothing the API of this version refuses.
    expect(api.sent[0]!.body).toEqual({ model: "claude-opus-5-5", max_tokens: 4_096, system: "Take notes.", messages: [{ role: "user", content: "PART" }], output_config: { effort: "low" } });
    expect(used).toHaveLength(2);
    expect(used[1]).toEqual({ inputTokens: 25_000, cachedInputTokens: 0, outputTokens: 1_100, thoughtTokens: 0 });
  });

  it("answers after an explorer of another kind, from the calls and results alone", async () => {
    const { files, meta } = await largeLog();
    const explorer = fakeModel([modelCalls([{ name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } }], { text: "Reading." }), says("DONE")], { id: "explorer" });
    const api = fakeApi([message([text("Two lines of INFO.")])]);
    const result = await askWithFiles({ files, model: anthropic({ model: "claude-test", apiKey: "k", fetch: api.fetch }), explorer, documentIds: [meta.id], messages: question("?") });
    const messages = api.sent[0]!.body.messages as Json[];
    expect(messages.map((sent) => sent.role)).toEqual(["user", "assistant", "user"]);
    // A call that came without an ID is given one, the same in its result.
    expect(messages[1]!.content).toEqual([{ type: "tool_use", id: "toolu_1_1", name: "read_document", input: { document_id: meta.id, start_line: 1, end_line: 2 } }]);
    expect(messages[2]!.content.map((block: Json) => [block.type, block.tool_use_id])).toEqual([["tool_result", "toolu_1_1"], ["text", undefined]]);
    expect(JSON.stringify(api.sent[0]!.body)).not.toContain("Reading.");
    expect(api.sent[0]!.body.tool_choice).toEqual({ type: "none" });
    expect(result).toMatchObject({ text: "Two lines of INFO.", answered: true });
    expect(Object.keys(result.usage.byModel).sort()).toEqual(["claude-test", "explorer"]);
  });

  it("converts a history kept as Messages API messages, both ways", () => {
    const turns: ToolTurn[] = [{ role: "tools", calls: [
      { id: "toolu_a", name: "read_document", args: { document_id: "doc_1", start_line: 1 }, result: { lines: "1-2", text: "1| a\n2| b" } },
      { name: "search_document", args: { document_id: "doc_1", query: "x" }, result: { error: "Unknown document_id doc_1." } },
    ] }];
    const native = anthropicToolTurns(turns);
    expect(native).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "read_document", input: { document_id: "doc_1", start_line: 1 } }, { type: "tool_use", id: "toolu_1_2", name: "search_document", input: { document_id: "doc_1", query: "x" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "{\"lines\":\"1-2\",\"text\":\"1| a\\n2| b\"}" },
        { type: "tool_result", tool_use_id: "toolu_1_2", content: "{\"error\":\"Unknown document_id doc_1.\"}", is_error: true },
      ] },
    ]);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const messages = fromAnthropicMessages([
      { role: "user", content: [image, { type: "text", text: "What is in the picture and the file?" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "old" }, ...native[0]!.content as Json[]] },
      native[1]!,
      { role: "assistant", content: "Two lines." },
      { role: "user", content: "And then?" },
    ]);
    expect(messages).toEqual([
      { role: "user", parts: [{ native: image }, { text: "What is in the picture and the file?" }] },
      { role: "tools", calls: [{ ...turns[0]!.calls[0] }, { id: "toolu_1_2", ...turns[0]!.calls[1] }] },
      { role: "assistant", parts: [{ text: "Two lines." }] },
      { role: "user", parts: [{ text: "And then?" }] },
    ]);
  });
});
