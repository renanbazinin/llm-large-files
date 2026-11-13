import { describe, expect, it, vi } from "vitest";
import { askWithFiles, createLargeFiles, FINAL_ANSWER_REQUEST, MemoryDocumentStore, ModelRequestError, type ModelRequest, type ToolTurn } from "llm-large-files";
import { fromOpenAiMessages, openAiCompatible, openAiToolTurns, OpenAiRequestError } from "llm-large-files/openai";
import { THINKING_OUTPUT_TOKENS } from "llm-large-files/gemini";
import { numberedPdf } from "./pdf-fixtures.js";
import { fakeModel, calls as modelCalls, says, serviceLog, utf8 } from "./fake-model.js";

type Json = Record<string, any>;
type Sent = { url: string; headers: Record<string, string>; body: Json };

const encoder = new TextEncoder();
const question = (text: string) => [{ role: "user" as const, text }];
const reply = (message: Json, finish = "stop", usage: Json = { prompt_tokens: 900, completion_tokens: 30 }) => ({ choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }], usage });
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const sse = (events: unknown[]) => new Response(new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`));
    controller.close();
  },
}), { status: 200, headers: { "Content-Type": "text/event-stream" } });

/** An endpoint that answers each request from a script and notes what it was sent. The last entry repeats. */
function fakeEndpoint(replies: Array<object | Response | ((sent: Sent) => object | Response)>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request: Sent = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Json };
    sent.push(request);
    const entry = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    const value = typeof entry === "function" ? entry(request) : entry;
    return value instanceof Response ? value.clone() : Response.json(value);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "prod.log", bytes: utf8(serviceLog(5_000)) });
  return { files, meta };
}

const request = (text: string, more: Partial<ModelRequest> = {}): ModelRequest => ({ system: "", messages: [{ role: "user", parts: [{ text }] }], ...more });

describe("an OpenAI-compatible endpoint", () => {
  it("is called at the URL of its API, with the key and headers of the moment", async () => {
    const endpoint = fakeEndpoint([reply({ content: "Hello." })]);
    let tokens = 0;
    const model = openAiCompatible({ baseUrl: "https://api.deepseek.com/v1/", model: "deepseek-v4-pro", apiKey: () => `key-${++tokens}`, headers: async () => ({ "X-Tenant": "acme" }), fetch: endpoint.fetch });
    expect(model.id).toBe("deepseek-v4-pro");
    expect(model.capabilities).toEqual({ toolFiles: "none", pageTokens: 1_000 });
    await model.send(request("Hi"));
    await model.send(request("Hi again"));
    expect(endpoint.sent.map((sent) => sent.url)).toEqual(["https://api.deepseek.com/v1/chat/completions", "https://api.deepseek.com/v1/chat/completions"]);
    expect(endpoint.sent.map((sent) => sent.headers.Authorization)).toEqual(["Bearer key-1", "Bearer key-2"]);
    expect(endpoint.sent[0]!.headers).toMatchObject({ "Content-Type": "application/json", "X-Tenant": "acme" });
    expect(endpoint.sent[0]!.body).toEqual({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "Hi" }] });

    // The whole URL, for Azure or a gateway, and no key of this kind.
    const azure = fakeEndpoint([reply({ content: "ok" })]);
    await openAiCompatible({ url: "https://acme.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2026-06-01", model: "gpt", headers: { "api-key": "k" }, fetch: azure.fetch }).send(request("Hi"));
    expect(azure.sent[0]!.url).toContain("/deployments/gpt/chat/completions?api-version=");
    expect(azure.sent[0]!.headers).toEqual({ "Content-Type": "application/json", "api-key": "k" });
    expect(openAiCompatible({ model: "gpt-5.5", fetch: azure.fetch, contextTokens: 400_000, maxRequestBytes: 20_000_000, tokenScale: 1.1 }).capabilities)
      .toEqual({ contextTokens: 400_000, maxRequestBytes: 20_000_000, toolFiles: "none", pageTokens: 1_000, tokenScale: 1.1 });
  });

  it("runs the tool loop: system first, the card in the first user message, tool results as tool messages", async () => {
    const { files, meta } = await largeLog();
    const assistant = { content: null, reasoning_content: "The log is large.", tool_calls: [toolCall("call_1", "search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 2 })] };
    const endpoint = fakeEndpoint([
      reply(assistant, "tool_calls", { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 12 } }),
      reply({ content: "51 errors, the first at L97." }, "stop", { prompt_tokens: 1_400, completion_tokens: 20, prompt_cache_hit_tokens: 800 }),
    ]);
    const model = openAiCompatible({ baseUrl: "https://llm.example/v1", model: "any-model", apiKey: "k", body: { temperature: 0.2 }, fetch: endpoint.fetch });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], system: "Be brief.", messages: question("How many errors?") });
    const [first, second] = endpoint.sent;
    expect(Object.keys(first!.body)).toEqual(["model", "messages", "tools", "temperature"]);
    expect(first!.body.tools.map((tool: Json) => [tool.type, tool.function.name])).toEqual([["function", "search_document"], ["function", "read_document"], ["function", "get_document_overview"], ["function", "analyze_whole_document"]]);
    expect(first!.body.tools[0].function.parameters.required).toEqual(["document_id", "query"]);
    expect(first!.body.messages[0]).toEqual({ role: "system", content: expect.stringMatching(/^Be brief\.\n\nSome attached files are too large/) });
    expect(first!.body.messages[1].role).toBe("user");
    expect(first!.body.messages[1].content).toMatch(/^--- Large attached file: prod\.log ---[\s\S]*\n\nHow many errors\?$/);
    // The model's own message goes back as it came, what the server put in it included.
    expect(second!.body.messages[2]).toEqual({ role: "assistant", ...assistant });
    expect(second!.body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(JSON.parse(second!.body.messages[3].content)).toMatchObject({ document: "prod.log", total_matching_lines: 51, tool_turns_left: 10 });
    expect(second!.body.tool_choice).toBeUndefined();
    expect(result).toMatchObject({ text: "51 errors, the first at L97.", answered: true, turns: 2, finishReason: "stop", steps: ["Search prod.log (exact) for “ERROR” — 51 matching lines"] });
    expect(result.usage).toMatchObject({ requests: 2, inputTokens: 2_300, cachedInputTokens: 900, outputTokens: 50, thoughtTokens: 12 });
    expect(result.usage.byModel["any-model"]!.requests).toBe(2);
    expect(result.lastUsage).toEqual({ prompt_tokens: 1_400, completion_tokens: 20, prompt_cache_hit_tokens: 800 });
  });

  it("asks for the answer with the tools still listed and tool_choice none, or without them for a server that asks", async () => {
    const { files, meta } = await largeLog();
    const script = () => fakeEndpoint([(sent) => (sent.body.tool_choice === "none" || !sent.body.tools
      ? reply({ content: "Best effort." })
      : reply({ content: null, tool_calls: [toolCall(`call_${sent.body.messages.length}`, "read_document", { document_id: meta.id, start_line: 1, end_line: 2 })] }, "tool_calls"))]);
    const kept = script();
    const result = await askWithFiles({ files, model: openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: kept.fetch }), documentIds: [meta.id], limits: { toolTurns: 3 }, messages: question("?") });
    expect(kept.sent.map((sent) => sent.body.tool_choice)).toEqual([undefined, undefined, "none"]);
    expect(kept.sent[2]!.body.tools).toEqual(kept.sent[0]!.body.tools);
    expect(kept.sent[2]!.body.messages.at(-1)).toEqual({ role: "user", content: FINAL_ANSWER_REQUEST });
    expect(kept.sent[2]!.body.messages.filter((message: Json) => message.role === "tool")).toHaveLength(2);
    expect(result).toMatchObject({ text: "Best effort.", answered: true, turns: 3 });

    const omitted = script();
    await askWithFiles({ files, model: openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", answerWithoutTools: "omit", fetch: omitted.fetch }), documentIds: [meta.id], limits: { toolTurns: 2 }, messages: question("?") });
    expect(omitted.sent.map((sent) => [Boolean(sent.body.tools), sent.body.tool_choice])).toEqual([[true, undefined], [false, undefined]]);
  });

  it("streams the answer, and puts a tool call together from its pieces", async () => {
    const { files, meta } = await largeLog();
    const args = JSON.stringify({ document_id: meta.id, start_line: 96, end_line: 98 });
    const chunk = (delta: Json, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    const endpoint = fakeEndpoint([
      sse([
        chunk({ role: "assistant", content: "Look" }),
        chunk({ content: "ing." }),
        chunk({ reasoning_content: "I should read around line 97." }),
        chunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "read_document", arguments: "" }, extra_content: { google: { thought_signature: "sig" } } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 20) } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(20) } }] }),
        chunk({}, "tool_calls"),
        { choices: [], usage: { prompt_tokens: 700, completion_tokens: 25 } },
        "[DONE]",
      ]),
      sse([chunk({ content: "Line 97 " }), chunk({ content: "is an error." }), chunk({}, "stop"), { choices: [], usage: { prompt_tokens: 900, completion_tokens: 8 } }, "[DONE]"]),
    ]);
    const deltas: string[] = [];
    const model = openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: endpoint.fetch });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What is on line 97?"), onText: (delta) => deltas.push(delta) });
    expect(endpoint.sent[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas).toEqual(["Look", "ing.", "\n\n", "Line 97 ", "is an error."]);
    // The message that goes back holds the call whole, and what the server sent with it.
    expect(endpoint.sent[1]!.body.messages.at(-2)).toEqual({
      role: "assistant",
      content: "Looking.",
      reasoning_content: "I should read around line 97.",
      tool_calls: [{ id: "call_9", type: "function", function: { name: "read_document", arguments: args }, extra_content: { google: { thought_signature: "sig" } } }],
    });
    expect(JSON.parse(endpoint.sent[1]!.body.messages.at(-1).content).lines).toBe("96-98");
    expect(result).toMatchObject({ text: "Looking.\n\nLine 97 is an error.", answered: true, finishReason: "stop", steps: ["Read prod.log lines 96-98"] });
    expect(result.usage).toMatchObject({ requests: 2, inputTokens: 1_600, outputTokens: 33 });

    // Without a listener nothing is streamed; a server that answers a stream request in one piece is read as it is.
    const plain = fakeEndpoint([reply({ content: "ok" })]);
    const quiet = openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: plain.fetch });
    expect((await quiet.send(request("Hi"))).text).toBe("ok");
    expect(plain.sent[0]!.body.stream).toBeUndefined();
    const got: string[] = [];
    expect((await quiet.send(request("Hi"), { onText: (delta) => got.push(delta) })).text).toBe("ok");
    expect(plain.sent[1]!.body.stream).toBe(true);
    expect(got).toEqual(["ok"]);
    await openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", stream: false, fetch: plain.fetch }).send(request("Hi"), { onText: () => undefined });
    expect(plain.sent[2]!.body.stream).toBeUndefined();
  });

  it("does not run a call whose arguments are not JSON, or that was cut off", async () => {
    const endpoint = fakeEndpoint([
      reply({ content: null, tool_calls: [toolCall("a", "read_document", "{\"document_id\": \"doc"), toolCall("b", "read_document", { document_id: "d", start_line: 1 })] }, "tool_calls"),
      reply({ content: null, tool_calls: [toolCall("c", "read_document", { document_id: "d" })] }, "length"),
      reply({ content: null }, "content_filter"),
    ]);
    const model = openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: endpoint.fetch });
    const first = await model.send(request("?"));
    expect(first.calls[0]).toEqual({ id: "a", name: "read_document", args: {}, problem: "The arguments of this call were not a JSON object, and it was not run: {\"document_id\": \"doc. Send the call again." });
    expect(first.calls[1]).toEqual({ id: "b", name: "read_document", args: { document_id: "d", start_line: 1 } });
    const cut = await model.send(request("?"));
    expect(cut.finishReason).toBe("length");
    expect(cut.calls[0]!.problem).toMatch(/^This call was cut off at the output limit/);
    expect(await model.send(request("?"))).toMatchObject({ text: "", calls: [], finishReason: "content_filter", blockReason: "content_filter" });
  });

  it("reports an HTTP error with its status and the wait it names, and a connection that failed as one to retry", async () => {
    const endpoint = fakeEndpoint([
      new Response(JSON.stringify({ error: { message: "Rate limit reached.", type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "7" } }),
      // Gemini's layer wraps the error in a list.
      new Response(JSON.stringify([{ error: { code: 400, message: "Invalid value at 'messages'.", status: "INVALID_ARGUMENT" } }]), { status: 400 }),
      new Response("upstream timed out", { status: 504 }),
      sse([{ choices: [{ index: 0, delta: { content: "Par" } }] }, { error: { message: "The server had an error.", code: 503 } }]),
    ]);
    const model = openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: endpoint.fetch });
    const limited = await model.send(request("?")).catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(OpenAiRequestError);
    expect(limited).toBeInstanceOf(ModelRequestError);
    expect(limited).toMatchObject({ name: "OpenAiRequestError", status: 429, message: "Rate limit reached.", retryAfterMs: 7_000 });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 400, message: "Invalid value at 'messages'." });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 504, message: "The model returned HTTP 504." });
    await expect(model.send(request("?"), { onText: () => undefined })).rejects.toMatchObject({ status: 503, message: "The server had an error." });

    const down = openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.send(request("?"))).rejects.toMatchObject({ name: "OpenAiRequestError", status: 0, message: "The model could not be reached (fetch failed)." });
    // Stopped by the caller: the caller's own reason, not an error of the model.
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    const aborted = openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: (async (_url: unknown, init?: RequestInit) => { throw init!.signal!.reason; }) as unknown as typeof fetch });
    await expect(aborted.send(request("?"), { signal: stop.signal })).rejects.toThrow("stopped");
  });

  it("reads a part of a file with the output limit its server knows, and asks again when the limit went on reasoning", async () => {
    const limits: Array<Record<string, unknown>> = [];
    const endpoint = fakeEndpoint([(sent) => {
      limits.push(sent.body);
      const limit = (sent.body.max_tokens ?? sent.body.max_completion_tokens) as number;
      return limit < THINKING_OUTPUT_TOKENS
        ? reply({ content: "" }, "length", { prompt_tokens: 25_000, completion_tokens: limit, completion_tokens_details: { reasoning_tokens: limit } })
        : reply({ content: "Deadlocks at (L250)." }, "stop", { prompt_tokens: 25_000, completion_tokens: 900 });
    }]);
    const used: unknown[] = [];
    const model = openAiCompatible({ model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.example/v1", analysisBody: () => ({ reasoning_effort: "low" }), fetch: endpoint.fetch });
    const generate = model.generateText!;
    expect(await generate({ system: "Take notes.", prompt: "PART", maxOutputTokens: 4_096, onUsage: (usage) => used.push(usage) })).toBe("Deadlocks at (L250).");
    expect(limits.map((body) => body.max_tokens)).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    expect(limits[0]).toEqual({ model: "deepseek-v4-pro", messages: [{ role: "system", content: "Take notes." }, { role: "user", content: "PART" }], max_tokens: 4_096, reasoning_effort: "low" });
    // Both requests were billed, and both are reported.
    expect(used).toEqual([
      { inputTokens: 25_000, cachedInputTokens: 0, outputTokens: 4_096, thoughtTokens: 4_096 },
      { inputTokens: 25_000, cachedInputTokens: 0, outputTokens: 900, thoughtTokens: 0 },
    ]);
    // The next part starts with the larger limit.
    await generate({ system: "s", prompt: "p", maxOutputTokens: 4_096 });
    expect(limits.at(-1)!.max_tokens).toBe(THINKING_OUTPUT_TOKENS);

    // OpenAI's own API, and Azure's, name the limit the newer way.
    for (const [baseUrl, field] of [[undefined, "max_completion_tokens"], ["https://acme.openai.azure.com/openai/v1", "max_completion_tokens"], ["https://ollama.internal:11434/v1", "max_tokens"]] as const) {
      const server = fakeEndpoint([reply({ content: "notes" })]);
      await openAiCompatible({ model: `m-${field}-${baseUrl}`, baseUrl, fetch: server.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 });
      expect(Object.keys(server.sent[0]!.body), String(baseUrl)).toContain(field);
    }
    const truncated = vi.fn();
    const long = fakeEndpoint([reply({ content: "partial notes, ORD-" }, "length")]);
    expect(await openAiCompatible({ model: "long", baseUrl: "https://llm.example/v1", maxTokensField: "max_completion_tokens", fetch: long.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100, onTruncated: truncated })).toBe("partial notes, ORD-");
    expect(truncated).toHaveBeenCalledTimes(1);
    expect(long.sent[0]!.body.max_completion_tokens).toBe(100);
  });

  it("gives calls that came without an ID one, the same in the call and in its result", async () => {
    const { files, meta } = await largeLog();
    // An explorer of another kind, whose calls carry no ID, and this endpoint for the answer.
    const explorer = fakeModel([
      modelCalls([{ name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } }, { name: "read_document", args: { document_id: meta.id, start_line: 5, end_line: 6 } }]),
      modelCalls([{ name: "get_document_overview", args: { document_id: meta.id } }]),
      says("DONE"),
    ], { id: "explorer" });
    const endpoint = fakeEndpoint([reply({ content: "Two reads and an overview." })]);
    await askWithFiles({ files, model: openAiCompatible({ model: "answerer", baseUrl: "https://llm.example/v1", fetch: endpoint.fetch }), explorer, documentIds: [meta.id], messages: question("?") });
    const messages = endpoint.sent[0]!.body.messages as Json[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool", "assistant", "tool", "user"]);
    expect(messages[2]).toEqual({ role: "assistant", content: null, tool_calls: [
      { id: "call_1_1", type: "function", function: { name: "read_document", arguments: JSON.stringify({ document_id: meta.id, start_line: 1, end_line: 2 }) } },
      { id: "call_1_2", type: "function", function: { name: "read_document", arguments: JSON.stringify({ document_id: meta.id, start_line: 5, end_line: 6 }) } },
    ] });
    expect(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["call_1_1", "call_1_2", "call_2_1"]);
    expect(messages[5]!.tool_calls[0].id).toBe("call_2_1");
    expect(endpoint.sent[0]!.body.tool_choice).toBe("none");
  });

  it("can be sent the pages of a PDF, in a user message after the tool results, when its model reads PDFs", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const script = () => fakeEndpoint([
      reply({ content: null, tool_calls: [toolCall("call_1", "view_pages", { document_id: meta.id, from_page: 2, to_page: 3 })] }, "tool_calls"),
      reply({ content: "Page 2 shows a bar chart." }),
    ]);
    const without = script();
    await askWithFiles({ files, model: openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", fetch: without.fetch }), documentIds: [meta.id], messages: question("What is on page 2?") });
    // By default nothing is offered that the model could not be shown: one request, no tools.
    expect(without.sent).toHaveLength(1);
    expect(without.sent[0]!.body.tools).toBeUndefined();

    const withPages = script();
    const model = openAiCompatible({ model: "m", baseUrl: "https://llm.example/v1", pdfInput: true, pageTokens: 800, fetch: withPages.fetch });
    expect(model.capabilities).toMatchObject({ toolFiles: "beside", pageTokens: 800 });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What is on page 2?") });
    expect(withPages.sent[0]!.body.tools.map((tool: Json) => tool.function.name)).toEqual(["view_pages"]);
    const messages = withPages.sent[1]!.body.messages as Json[];
    expect(messages.slice(-3).map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
    expect(JSON.parse(messages.at(-2)!.content)).toEqual({ document: "report.pdf", pages: "2-3", total_pages: 6, file: "pages-2-3.pdf", tool_turns_left: 10 });
    const [label, file] = messages.at(-1)!.content as Json[];
    expect(label).toEqual({ type: "text", text: "pages-2-3.pdf (returned by view_pages):" });
    expect(file!.type).toBe("file");
    expect(file!.file.filename).toBe("pages-2-3.pdf");
    expect(file!.file.file_data).toMatch(/^data:application\/pdf;base64,JVBERi0/);
    expect(result.steps).toEqual(["Look at report.pdf pages 2-3"]);
    // What is kept of the round holds no file: it says that the pages were shown.
    expect(result.toolTurns[0]!.calls[0]!.result).toMatchObject({ document: "report.pdf", pages: "2-3", dropped: true });
  });

  it("converts a history kept as Chat Completions messages, both ways", () => {
    const turns: ToolTurn[] = [{ role: "tools", calls: [
      { id: "call_a", name: "read_document", args: { document_id: "doc_1", start_line: 1 }, result: { lines: "1-2", text: "1| a\n2| b" } },
      { name: "search_document", args: { document_id: "doc_1", query: "x" }, result: { error: "Unknown document_id doc_1." } },
    ] }];
    const native = openAiToolTurns(turns);
    expect(native).toEqual([
      { role: "assistant", content: null, tool_calls: [
        { id: "call_a", type: "function", function: { name: "read_document", arguments: "{\"document_id\":\"doc_1\",\"start_line\":1}" } },
        { id: "call_1_2", type: "function", function: { name: "search_document", arguments: "{\"document_id\":\"doc_1\",\"query\":\"x\"}" } },
      ] },
      { role: "tool", tool_call_id: "call_a", content: "{\"lines\":\"1-2\",\"text\":\"1| a\\n2| b\"}" },
      { role: "tool", tool_call_id: "call_1_2", content: "{\"error\":\"Unknown document_id doc_1.\"}" },
    ]);
    const history = [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "What is in the picture and the file?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
      ...native,
      { role: "assistant", content: "Two lines." },
      { role: "user", content: "And then?" },
    ];
    const { system, messages } = fromOpenAiMessages(history);
    expect(system).toBe("Be brief.");
    expect(messages).toEqual([
      { role: "user", parts: [{ text: "What is in the picture and the file?" }, { native: { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } } }] },
      { role: "tools", calls: [{ ...turns[0]!.calls[0] }, { id: "call_1_2", ...turns[0]!.calls[1] }] },
      { role: "assistant", parts: [{ text: "Two lines." }] },
      { role: "user", parts: [{ text: "And then?" }] },
    ]);
  });
});
