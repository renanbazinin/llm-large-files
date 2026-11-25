// openAiResponses(): OpenAI's Responses API, and Azure OpenAI's, against fake servers. The shapes of
// the requests, events and replies follow OpenAI's API reference and guides (reasoning, function
// calling, streaming) and Azure OpenAI's Responses API page, read on 2026-11-25. Nothing here has
// been run against OpenAI or Azure.
import "./load-pdf-libraries.js";
import { describe, expect, it, vi } from "vitest";
import { askWithFiles, createLargeFiles, FINAL_ANSWER_REQUEST, MemoryDocumentStore, ModelRequestError, type ModelRequest, type ModelToolRound } from "llm-large-files";
import { THINKING_OUTPUT_TOKENS } from "llm-large-files/gemini";
import { openAiCompatible, OpenAiRequestError, openAiResponses } from "llm-large-files/openai";
import { calls as modelCalls, fakeFetch, fakeModel, says, serviceLog, sse, utf8 } from "llm-large-files/testing";
import { isCutReply } from "../src/http.js";
import { responsesErrorStatus } from "../src/openai/responses.js";
import { numberedPdf } from "./pdf-fixtures.js";

type Json = Record<string, any>;

const encoder = new TextEncoder();
const question = (text: string) => [{ role: "user" as const, text }];
const request = (text: string, more: Partial<ModelRequest> = {}): ModelRequest => ({ system: "", messages: [{ role: "user", parts: [{ text }] }], ...more });
const quick = { random: () => 1, sleep: async () => undefined };

const USAGE = { input_tokens: 900, input_tokens_details: { cached_tokens: 100 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 930 };
/** A response object of the Responses API, with these output items. */
const response = (output: unknown[], more: Json = {}): Json => ({ id: "resp_1", object: "response", model: "gpt-5.5-2026-04-23", status: "completed", error: null, incomplete_details: null, output, usage: USAGE, ...more });
const reply = (output: unknown[], more: Json = {}) => Response.json(response(output, more));
const message = (text: string, id = "msg_1"): Json => ({ type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const reasoning = (id: string, encrypted?: string): Json => ({ type: "reasoning", id, summary: [], ...(encrypted ? { encrypted_content: encrypted } : {}) });
const functionCall = (id: string, callId: string, name: string, args: unknown): Json => ({ type: "function_call", id, call_id: callId, name, arguments: typeof args === "string" ? args : JSON.stringify(args), status: "completed" });
const answer = (text: string) => reply([message(text)]);
const kindOf = (item: Json) => item.type ?? item.role;

/**
 * The events of a streamed response, as OpenAI sends them: each item added, its text or its
 * arguments in one piece, the item done, then the end of the response (`response.incomplete` for a
 * response of that status).
 */
function streamOf(items: Json[], terminal: Json = response(items)): unknown[] {
  const events: unknown[] = [{ type: "response.created", response: { ...terminal, status: "in_progress", output: [], usage: null } }];
  items.forEach((item, index) => {
    if (item.type === "function_call") {
      events.push({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } });
      events.push({ type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: item.arguments });
      events.push({ type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: item.arguments });
    } else if (item.type === "message") {
      events.push({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", content: [] } });
      for (const part of item.content as Json[]) {
        if (part.type === "output_text") events.push({ type: "response.output_text.delta", output_index: index, content_index: 0, item_id: item.id, delta: part.text });
      }
    } else {
      events.push({ type: "response.output_item.added", output_index: index, item: { type: item.type, id: item.id, summary: [] } });
    }
    events.push({ type: "response.output_item.done", output_index: index, item });
  });
  events.push({ type: terminal.status === "incomplete" ? "response.incomplete" : "response.completed", response: terminal });
  return events;
}

/** A body of events written by hand, sent in the pieces given, as bytes. */
function eventBody(pieces: Uint8Array[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

/** A fetch that never answers, until the request's signal aborts. */
const hangingFetch = () => (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
  if (init?.signal?.aborted) reject(init.signal.reason);
  init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
})) as typeof globalThis.fetch;

// One user: these tests are about the adapter, so the libraries do not ask for owners.
async function largeLog() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "prod.log", bytes: utf8(serviceLog(5_000)) });
  return { files, meta };
}

async function smallNote() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
  const meta = await files.ingest({ name: "note.txt", bytes: utf8("The meeting moved to Tuesday.\n") });
  return { files, meta };
}

describe("openAiResponses: requests", () => {
  it("posts to /responses with the key and headers of the moment, and says what it can take", async () => {
    const endpoint = fakeFetch([answer("Hello.")]);
    let tokens = 0;
    const model = openAiResponses({ model: "gpt-5.5", apiKey: () => `key-${++tokens}`, headers: async () => ({ "X-Tenant": "acme" }), fetch: endpoint.fetch });
    expect(model.id).toBe("gpt-5.5");
    expect(model.capabilities).toEqual({ toolFiles: "none", pageTokens: 1_000 });
    expect((await model.send(request("Hi"))).text).toBe("Hello.");
    await model.send(request("Hi again", { system: "Be brief." }));
    expect(endpoint.sent.map((sent) => sent.url)).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"]);
    expect(endpoint.sent.map((sent) => sent.headers.Authorization)).toEqual(["Bearer key-1", "Bearer key-2"]);
    expect(endpoint.sent[0]!.headers).toMatchObject({ "Content-Type": "application/json", "X-Tenant": "acme" });
    // No instructions when the system text is empty; the encrypted reasoning is asked for.
    expect(endpoint.sent[0]!.body).toEqual({ model: "gpt-5.5", input: [{ role: "user", content: "Hi" }], store: false, include: ["reasoning.encrypted_content"] });
    expect(Object.keys(endpoint.sent[1]!.body)).toEqual(["model", "instructions", "input", "store", "include"]);
    expect(endpoint.sent[1]!.body.instructions).toBe("Be brief.");
    // The size of a request is that of the body that would be posted.
    expect(model.requestBytes!(request("Hi"))).toBe(Buffer.byteLength(JSON.stringify(endpoint.sent[0]!.body)));

    // A base with a trailing slash, the whole URL of a gateway, and Azure OpenAI's v1 API with its own key header.
    const other = fakeFetch([answer("ok")]);
    await openAiResponses({ model: "m", baseUrl: "https://gateway.example/v1/", fetch: other.fetch }).send(request("Hi"));
    await openAiResponses({ model: "m", url: "https://gateway.example/llm/responses?tenant=acme", fetch: other.fetch }).send(request("Hi"));
    expect(other.sent.map((sent) => sent.url)).toEqual(["https://gateway.example/v1/responses", "https://gateway.example/llm/responses?tenant=acme"]);
    const azure = fakeFetch([answer("ok")]);
    await openAiResponses({ model: "gpt-5-deployment", baseUrl: "https://acme.openai.azure.com/openai/v1", headers: { "api-key": "k" }, fetch: azure.fetch }).send(request("Hi"));
    expect(azure.sent[0]!.url).toBe("https://acme.openai.azure.com/openai/v1/responses");
    expect(azure.sent[0]!.headers).toEqual({ "Content-Type": "application/json", "api-key": "k" });

    const sized = openAiResponses({ model: "gpt-5.5", id: "openai", contextTokens: 400_000, maxRequestBytes: 20_000_000, tokenScale: 1.1, pageTokens: 800 });
    expect(sized.id).toBe("openai");
    expect(sized.capabilities).toEqual({ contextTokens: 400_000, maxRequestBytes: 20_000_000, toolFiles: "none", pageTokens: 800, tokenScale: 1.1 });
    expect(Object.keys(sized.capabilities)).toEqual(["contextTokens", "maxRequestBytes", "toolFiles", "pageTokens", "tokenScale"]);
  });

  it("runs the tool loop: instructions, input items, function tools with strict false, outputs as function_call_output", async () => {
    const { files, meta } = await largeLog();
    const turn = [reasoning("rs_1", "encrypted-1"), message("Checking.", "msg_1"), functionCall("fc_1", "call_1", "search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 2 })];
    const last = { input_tokens: 1_400, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1_420 };
    const endpoint = fakeFetch([reply(turn), reply([message("51 errors, the first at L97.", "msg_2")], { usage: last })]);
    const model = openAiResponses({ model: "gpt-5.5", apiKey: "k", body: { temperature: 0.2 }, fetch: endpoint.fetch });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], system: "Be brief.", messages: question("How many errors?") });
    const [first, second] = endpoint.sent;
    expect(Object.keys(first!.body)).toEqual(["model", "instructions", "input", "tools", "store", "include", "temperature"]);
    expect(first!.body.tools[0]).toEqual({ type: "function", name: "search_document", description: expect.any(String), parameters: expect.objectContaining({ required: ["document_id", "query"] }), strict: false });
    expect(first!.body.tools.map((tool: Json) => [tool.name, tool.strict])).toEqual([["search_document", false], ["read_document", false], ["get_document_overview", false], ["analyze_whole_document", false]]);
    expect(first!.body.instructions).toMatch(/^Be brief\.\n\nSome attached files are too large/);
    expect(first!.body.input).toEqual([{ role: "user", content: expect.stringMatching(/^--- Large attached file: prod\.log ---[\s\S]*\n\nHow many errors\?$/) }]);
    // The model's own items go back as they came, in order, and the result follows them.
    expect(second!.body.input.map(kindOf)).toEqual(["user", "reasoning", "message", "function_call", "function_call_output"]);
    expect(second!.body.input.slice(1, 4)).toEqual(turn);
    expect(second!.body.input[4]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(JSON.parse(second!.body.input[4].output)).toMatchObject({ document: "prod.log", total_matching_lines: 51 });
    expect(second!.body.tool_choice).toBeUndefined();
    expect(result).toMatchObject({ answered: true, turns: 2, finishReason: "completed", steps: ["Search prod.log (exact) for “ERROR” — 51 matching lines"] });
    expect(result.text).toMatch(/51 errors, the first at L97\.$/);
    expect(result.usage).toMatchObject({ requests: 2, inputTokens: 2_300, cachedInputTokens: 900, outputTokens: 50, thoughtTokens: 12 });
    expect(result.usage.byModel["gpt-5.5"]!.requests).toBe(2);
    expect(result.lastUsage).toEqual(last);
  });

  it("replays every reasoning item of the question in order, and none in the stored rounds or a later question", async () => {
    const { files, meta } = await largeLog();
    const search = functionCall("fc_1", "call_1", "search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 2 });
    const read = functionCall("fc_2", "call_2", "read_document", { document_id: meta.id, start_line: 96, end_line: 98 });
    const endpoint = fakeFetch([reply([reasoning("rs_1", "encrypted-1"), search]), reply([reasoning("rs_2", "encrypted-2"), read]), answer("Line 97 is the first error.")]);
    const asked = "Where is the first error?";
    const result = await askWithFiles({ files, model: openAiResponses({ model: "gpt-5.5", fetch: endpoint.fetch }), documentIds: [meta.id], messages: question(asked) });
    const third = endpoint.sent[2]!.body.input as Json[];
    expect(third.map(kindOf)).toEqual(["user", "reasoning", "function_call", "function_call_output", "reasoning", "function_call", "function_call_output"]);
    expect(third.filter((item) => item.type === "reasoning").map((item) => item.id)).toEqual(["rs_1", "rs_2"]);
    expect(third.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual(["call_1", "call_2"]);
    // What a question returns holds no item of the provider's.
    expect(result.toolTurns.flatMap((turn) => turn.calls.map((call) => Object.keys(call).sort()))).toEqual([["args", "id", "name", "result"], ["args", "id", "name", "result"]]);
    expect(JSON.stringify(result.toolTurns)).not.toMatch(/encrypted|rs_/);

    const later = fakeFetch([answer("Yes.")]);
    await askWithFiles({
      files, model: openAiResponses({ model: "gpt-5.5", fetch: later.fetch }), documentIds: [meta.id],
      messages: [...question(asked), ...result.toolTurns, { role: "assistant", text: result.text }, ...question("Are you sure?")],
    });
    const input = later.sent[0]!.body.input as Json[];
    expect(input.some((item) => item.type === "reasoning")).toBe(false);
    const stored = input.filter((item) => item.type === "function_call");
    expect(stored.map((item) => item.call_id)).toEqual(["call_1", "call_2"]);
    // Without an item ID: a stored round is linked to no stored or reasoning item.
    expect(stored.every((item) => !("id" in item))).toBe(true);
    expect(stored[0]).toEqual({ type: "function_call", call_id: "call_1", name: "search_document", arguments: search.arguments });
  });

  it("leaves out a reasoning item that came without encrypted content, unless the body stores responses", async () => {
    const { files, meta } = await largeLog();
    const search = functionCall("fc_1", "call_1", "search_document", { document_id: meta.id, query: "ERROR", mode: "exact" });
    const run = async (body?: Record<string, unknown>) => {
      const endpoint = fakeFetch([reply([reasoning("rs_1"), search]), answer("51 errors.")]);
      await askWithFiles({ files, model: openAiResponses({ model: "gpt-5.5", body, fetch: endpoint.fetch }), documentIds: [meta.id], messages: question("How many errors?") });
      return endpoint.sent[1]!;
    };
    // Under store: false the server keeps nothing, and would refuse the bare item by its ID.
    const bare = await run();
    expect(bare.body.input.map(kindOf)).toEqual(["user", "function_call", "function_call_output"]);
    expect(bare.body.input[1]).toEqual(search);
    const stored = await run({ store: true });
    expect(stored.body.store).toBe(true);
    expect(stored.body.input.map(kindOf)).toEqual(["user", "reasoning", "function_call", "function_call_output"]);
    expect(stored.body.input[1]).toEqual(reasoning("rs_1"));
  });

  it("asks for the answer with the tools still listed and tool_choice none", async () => {
    const { files, meta } = await largeLog();
    const endpoint = fakeFetch([(sent) => (sent.body.tool_choice === "none"
      ? answer("Best effort.")
      : reply([functionCall(`fc_${sent.body.input.length}`, `call_${sent.body.input.length}`, "read_document", { document_id: meta.id, start_line: 1, end_line: 2 })]))]);
    const result = await askWithFiles({ files, model: openAiResponses({ model: "gpt-5.5", fetch: endpoint.fetch }), documentIds: [meta.id], limits: { toolTurns: 3 }, messages: question("?") });
    expect(endpoint.sent.map((sent) => sent.body.tool_choice)).toEqual([undefined, undefined, "none"]);
    expect(endpoint.sent[2]!.body.tools).toEqual(endpoint.sent[0]!.body.tools);
    expect(Object.keys(endpoint.sent[2]!.body)).toEqual(["model", "instructions", "input", "tools", "tool_choice", "store", "include"]);
    expect(endpoint.sent[2]!.body.input.at(-1)).toEqual({ role: "user", content: FINAL_ANSWER_REQUEST });
    expect(endpoint.sent[2]!.body.input.filter((item: Json) => item.type === "function_call_output")).toHaveLength(2);
    expect(result).toMatchObject({ text: "Best effort.", answered: true, turns: 3 });
  });

  it("drops include after a server refuses it, keeps it off, and never with encryptedReasoning set", async () => {
    const refusal = (message: string, param: string | null) => new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param, code: null } }), { status: 400, headers: { "Content-Type": "application/json" } });
    const refused = () => refusal("Encrypted content is not supported with this model.", "include");
    const endpoint = fakeFetch([refused(), answer("ok"), answer("again")]);
    const model = openAiResponses({ model: "o-legacy", fetch: endpoint.fetch });
    expect((await model.send(request("Hi"))).text).toBe("ok");
    expect(endpoint.sent.map((sent) => "include" in sent.body)).toEqual([true, false]);
    expect((await model.send(request("Hi"))).text).toBe("again");
    expect(endpoint.sent).toHaveLength(3);
    expect("include" in endpoint.sent[2]!.body).toBe(false);
    expect(model.requestBytes!(request("Hi"))).toBe(Buffer.byteLength(JSON.stringify(endpoint.sent[2]!.body)));

    // The refusal under store: true names no field: its message tells it.
    const persisted = fakeFetch([refusal("Encrypted content cannot be requested for persisted responses.", null), answer("ok")]);
    await openAiResponses({ model: "m", body: { store: true }, fetch: persisted.fetch }).send(request("Hi"));
    expect(persisted.sent.map((sent) => "include" in sent.body)).toEqual([true, false]);

    const strict = fakeFetch([refused()]);
    await expect(openAiResponses({ model: "m", encryptedReasoning: true, fetch: strict.fetch }).send(request("Hi"))).rejects.toMatchObject({ name: "OpenAiRequestError", status: 400, param: "include" });
    expect(strict.sent).toHaveLength(1);

    const never = fakeFetch([answer("ok")]);
    const off = openAiResponses({ model: "m", encryptedReasoning: false, fetch: never.fetch });
    await off.send(request("Hi"));
    await off.send(request("Hi"), { onText: () => undefined });
    expect(never.sent.map((sent) => "include" in sent.body)).toEqual([false, false]);

    // Another field refused is the request's own error: it is not sent again.
    const other = fakeFetch([new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: "invalid_request_error", param: "temperature", code: "unsupported_parameter" } }), { status: 400 })]);
    await expect(openAiResponses({ model: "m", body: { temperature: 0.2 }, fetch: other.fetch }).send(request("Hi"))).rejects.toMatchObject({ status: 400, param: "temperature", code: "unsupported_parameter" });
    expect(other.sent).toHaveLength(1);
  });

  it("sends the pages of view_pages inside the function_call_output, or beside it, when placed so", async () => {
    const pdf = utf8("%PDF-1.7 two pages");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const call = { id: "call_1", name: "view_pages", args: { document_id: "d", from_page: 2, to_page: 3 } };
    const result = { document: "report.pdf", pages: "2-3", total_pages: 6, file: "pages-2-3.pdf" };
    const round = (files: Array<{ name: string; mimeType: string; bytes: Uint8Array }>): ModelToolRound => ({ role: "tools", calls: [call], answers: [{ call, result, files }] });
    const pages = { name: "pages-2-3.pdf", mimeType: "application/pdf", bytes: pdf };
    const pdfPart = { type: "input_file", filename: "pages-2-3.pdf", file_data: `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}` };
    const asked = { type: "function_call", call_id: "call_1", name: "view_pages", arguments: JSON.stringify(call.args) };
    const sendWith = async (placement: "inside" | "beside" | undefined, files: Array<typeof pages>, after: string[] = []) => {
      const endpoint = fakeFetch([answer("A chart.")]);
      const model = openAiResponses({ model: "m", toolFilePlacement: placement, fetch: endpoint.fetch });
      await model.send({ system: "", messages: [{ role: "user", parts: [{ text: "What is on page 2?" }] }, round(files), ...after.map((text) => ({ role: "user" as const, parts: [{ text }] }))] });
      return { model, input: endpoint.sent[0]!.body.input as Json[] };
    };

    const inside = await sendWith("inside", [pages]);
    expect(inside.model.capabilities.toolFiles).toBe("inside");
    expect(inside.input).toEqual([
      { role: "user", content: "What is on page 2?" },
      asked,
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: JSON.stringify(result) }, pdfPart] },
    ]);
    // A page image is an input_image.
    const image = await sendWith("inside", [{ name: "page-2.png", mimeType: "image/png", bytes: png }]);
    expect(image.input[2]!.output[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, detail: "auto" });

    // Beside: the output is text, and the files follow in a user turn, which the next user turn joins.
    const beside = await sendWith("beside", [pages], ["Answer now."]);
    expect(beside.model.capabilities.toolFiles).toBe("beside");
    expect(beside.input.slice(1)).toEqual([
      asked,
      { type: "function_call_output", call_id: "call_1", output: JSON.stringify(result) },
      { role: "user", content: [{ type: "input_text", text: "pages-2-3.pdf (returned by view_pages):" }, pdfPart, { type: "input_text", text: "Answer now." }] },
    ]);
    // None, the default: no file goes.
    const none = await sendWith(undefined, [pages]);
    expect(none.model.capabilities.toolFiles).toBe("none");
    expect(none.input.slice(2)).toEqual([{ type: "function_call_output", call_id: "call_1", output: JSON.stringify(result) }]);

    // Through the loop: view_pages is offered only when the pages can go.
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const script = () => fakeFetch([reply([functionCall("fc_1", "call_1", "view_pages", { document_id: meta.id, from_page: 2, to_page: 3 })]), answer("Page 2 shows a bar chart.")]);
    const without = script();
    await askWithFiles({ files, model: openAiResponses({ model: "m", fetch: without.fetch }), documentIds: [meta.id], messages: question("What is on page 2?") });
    expect(without.sent).toHaveLength(1);
    expect(without.sent[0]!.body.tools).toBeUndefined();
    const withPages = script();
    const looked = await askWithFiles({ files, model: openAiResponses({ model: "m", toolFilePlacement: "inside", pageTokens: 800, fetch: withPages.fetch }), documentIds: [meta.id], messages: question("What is on page 2?") });
    expect(withPages.sent[0]!.body.tools.map((tool: Json) => tool.name)).toEqual(["view_pages"]);
    const output = (withPages.sent[1]!.body.input as Json[]).find((item) => item.type === "function_call_output")!;
    expect(JSON.parse(output.output[0].text)).toEqual({ document: "report.pdf", pages: "2-3", total_pages: 6, file: "pages-2-3.pdf", tool_turns_left: 10 });
    expect(output.output[1]).toMatchObject({ type: "input_file", filename: "pages-2-3.pdf", file_data: expect.stringMatching(/^data:application\/pdf;base64,JVBERi0/) });
    expect(looked.steps).toEqual(["Look at report.pdf pages 2-3"]);
  });

  it("sends rounds of another model or of a stored question as function_call items without IDs of their own", async () => {
    const { files, meta } = await largeLog();
    const first = { document_id: meta.id, start_line: 1, end_line: 2 };
    const second = { document_id: meta.id, start_line: 5, end_line: 6 };
    const explorer = fakeModel([
      modelCalls([{ name: "read_document", args: first }, { name: "read_document", args: second }]),
      modelCalls([{ name: "get_document_overview", args: { document_id: meta.id } }]),
      says("DONE"),
    ], { id: "explorer" });
    const endpoint = fakeFetch([answer("Two reads and an overview.")]);
    await askWithFiles({ files, model: openAiResponses({ model: "answerer", fetch: endpoint.fetch }), explorer, documentIds: [meta.id], messages: question("?") });
    const input = endpoint.sent[0]!.body.input as Json[];
    expect(input.map(kindOf)).toEqual(["user", "function_call", "function_call", "function_call_output", "function_call_output", "function_call", "function_call_output", "user"]);
    expect(input.slice(1, 3)).toEqual([
      { type: "function_call", call_id: "call_1_1", name: "read_document", arguments: JSON.stringify(first) },
      { type: "function_call", call_id: "call_1_2", name: "read_document", arguments: JSON.stringify(second) },
    ]);
    expect(input[5]).toEqual({ type: "function_call", call_id: "call_2_1", name: "get_document_overview", arguments: JSON.stringify({ document_id: meta.id }) });
    expect(input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual(["call_1_1", "call_1_2", "call_2_1"]);
    expect(endpoint.sent[0]!.body.tool_choice).toBe("none");
  });

  it("does not send its own turn to another model of the question", async () => {
    const { files, meta } = await largeLog();
    const call = functionCall("fc_9", "call_9", "search_document", { document_id: meta.id, query: "ERROR", mode: "exact" });
    const explorerServer = () => fakeFetch([(sent) => ((sent.body.input as Json[]).some((item) => item.type === "function_call_output")
      ? reply([reasoning("rs_2", "encrypted-2"), message("DONE")])
      : reply([reasoning("rs_1", "encrypted-1"), call]))]);
    const explorer = explorerServer();
    const writer = fakeFetch([Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "51 errors." } }] })]);
    const result = await askWithFiles({
      files, documentIds: [meta.id], messages: question("How many errors?"),
      explorer: openAiResponses({ model: "gpt-5.5", fetch: explorer.fetch }),
      model: openAiCompatible({ model: "gpt-4.1", fetch: writer.fetch }),
    });
    expect(result.text).toBe("51 errors.");
    // Its own reasoning goes back to the explorer within the question...
    expect((explorer.sent[1]!.body.input as Json[]).filter((item) => item.type !== undefined).map(kindOf)).toEqual(["reasoning", "function_call", "function_call_output"]);
    expect((explorer.sent[1]!.body.input as Json[]).find((item) => item.type === "reasoning")).toEqual(reasoning("rs_1", "encrypted-1"));
    // ...and the other model gets the calls alone.
    const toWriter = (writer.sent[0]!.body.messages as Json[]).find((sent) => sent.role === "assistant");
    expect(toWriter).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "search_document", arguments: call.arguments } }] });

    // A writer of the same kind is another adapter: it gets the call without its item ID, and no reasoning.
    const again = explorerServer();
    const sameKind = fakeFetch([answer("51 errors.")]);
    await askWithFiles({
      files, documentIds: [meta.id], messages: question("How many errors?"),
      explorer: openAiResponses({ model: "gpt-5.5", fetch: again.fetch }),
      model: openAiResponses({ model: "gpt-5.5-writer", fetch: sameKind.fetch }),
    });
    const input = sameKind.sent[0]!.body.input as Json[];
    expect(input.some((item) => item.type === "reasoning")).toBe(false);
    expect(input.filter((item) => item.type === "function_call")).toEqual([{ type: "function_call", call_id: "call_9", name: "search_document", arguments: call.arguments }]);
  });
});

describe("openAiResponses: replies", () => {
  it("streams the answer, and puts a call together from its events", async () => {
    const args = { document_id: "d", start_line: 96, end_line: 98 };
    const thought = reasoning("rs_1", "encrypted-1");
    const said = message("Looking.", "msg_1");
    const read = functionCall("fc_1", "call_9", "read_document", args);
    const events = [
      { type: "response.created", sequence_number: 0, response: { id: "resp_9", object: "response", model: "gpt-5.5-2026-04-23", status: "in_progress", output: [] } },
      { type: "response.in_progress", sequence_number: 1, response: { id: "resp_9", object: "response", model: "gpt-5.5-2026-04-23", status: "in_progress", output: [] } },
      // The encrypted content of an item that was added may not be whole: the one of its done event is kept.
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encry" } },
      { type: "response.output_item.done", output_index: 0, item: thought },
      { type: "response.output_item.added", output_index: 1, item: { ...said, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 1, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, item_id: "msg_1", delta: "Look", obfuscation: "aBc" },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, item_id: "msg_1", delta: "ing.", obfuscation: "dE" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, item_id: "msg_1", text: "Looking." },
      { type: "response.output_item.done", output_index: 1, item: said },
      { type: "response.output_item.added", output_index: 2, item: { ...read, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: read.arguments.slice(0, 20) },
      { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: read.arguments.slice(20) },
      { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_1", arguments: read.arguments },
      { type: "response.output_item.done", output_index: 2, item: read },
      { type: "response.completed", response: response([thought, said, read], { id: "resp_9" }) },
    ];
    const endpoint = fakeFetch([sse(events)]);
    const deltas: string[] = [];
    const model = openAiResponses({ model: "gpt-5.5", fetch: endpoint.fetch });
    const turn = await model.send(request("What is on line 97?"), { onText: (delta) => deltas.push(delta) });
    expect(Object.keys(endpoint.sent[0]!.body)).toEqual(["model", "input", "store", "include", "stream"]);
    expect(endpoint.sent[0]!.body.stream).toBe(true);
    expect(deltas).toEqual(["Look", "ing."]);
    expect(turn.text).toBe("Looking.");
    expect(turn.calls).toEqual([{ id: "call_9", name: "read_document", args }]);
    expect(turn.raw).toEqual([thought, said, read]);
    expect(turn).toMatchObject({ finishReason: "completed", finish: "complete", responseId: "resp_9", responseModel: "gpt-5.5-2026-04-23" });
    expect(turn.usage).toEqual({ inputTokens: 900, cachedInputTokens: 100, outputTokens: 30, thoughtTokens: 12 });
    expect(turn.providerUsage).toEqual(USAGE);

    // Without a listener nothing is streamed; with stream: false never; a server that answers a stream request in one piece is read as it is.
    const plain = fakeFetch([answer("ok")]);
    const quiet = openAiResponses({ model: "m", fetch: plain.fetch });
    expect((await quiet.send(request("Hi"))).text).toBe("ok");
    expect(plain.sent[0]!.body.stream).toBeUndefined();
    const shown: string[] = [];
    expect((await quiet.send(request("Hi"), { onText: (delta) => shown.push(delta) })).text).toBe("ok");
    expect(plain.sent[1]!.body.stream).toBe(true);
    expect(shown).toEqual(["ok"]);
    await openAiResponses({ model: "m", stream: false, fetch: plain.fetch }).send(request("Hi"), { onText: () => undefined });
    expect(plain.sent[2]!.body.stream).toBeUndefined();
  });

  it("puts parallel calls together by output_index, whatever order their events come in", async () => {
    const { files, meta } = await largeLog();
    const one = functionCall("fc_1", "call_1", "read_document", { document_id: meta.id, start_line: 1, end_line: 2 });
    const two = functionCall("fc_2", "call_2", "search_document", { document_id: meta.id, query: "ERROR", mode: "exact" });
    const half = (item: Json, part: 0 | 1) => (part === 0 ? item.arguments.slice(0, 15) : item.arguments.slice(15));
    const interleaved = (finish: boolean): unknown[] => [
      { type: "response.created", response: { id: "resp_1", model: "m", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...one, arguments: "", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 1, item: { ...two, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: half(one, 0) },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: half(two, 0) },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: half(one, 1) },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: half(two, 1) },
      ...(finish ? [
        { type: "response.function_call_arguments.done", output_index: 1, arguments: two.arguments },
        { type: "response.output_item.done", output_index: 1, item: two },
        { type: "response.function_call_arguments.done", output_index: 0, arguments: one.arguments },
        { type: "response.output_item.done", output_index: 0, item: one },
      ] : []),
      { type: "response.completed", response: response(finish ? [one, two] : []) },
    ];
    const whole = await openAiResponses({ model: "m", fetch: fakeFetch([sse(interleaved(true))]).fetch }).send(request("?"), { onText: () => undefined });
    expect(whole.calls).toEqual([{ id: "call_1", name: "read_document", args: JSON.parse(one.arguments) }, { id: "call_2", name: "search_document", args: JSON.parse(two.arguments) }]);
    expect(whole.raw).toEqual([one, two]);
    // The arguments of each call are put together under its index, from the pieces alone.
    const pieces = await openAiResponses({ model: "m", fetch: fakeFetch([sse(interleaved(false))]).fetch }).send(request("?"), { onText: () => undefined });
    expect(pieces.calls.map((call) => [call.id, call.args])).toEqual([["call_1", JSON.parse(one.arguments)], ["call_2", JSON.parse(two.arguments)]]);

    const endpoint = fakeFetch([sse(interleaved(true)), sse(streamOf([message("Both done.")]))]);
    await askWithFiles({ files, model: openAiResponses({ model: "m", fetch: endpoint.fetch }), documentIds: [meta.id], messages: question("?"), onText: () => undefined });
    const input = endpoint.sent[1]!.body.input as Json[];
    expect(input.slice(1).map((item) => [item.type, item.call_id])).toEqual([["function_call", "call_1"], ["function_call", "call_2"], ["function_call_output", "call_1"], ["function_call_output", "call_2"]]);
  });

  it("reads a stream whose bytes split a character, with event: lines and CRLF", async () => {
    const frame = (event: Json) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
    const head = frame({ type: "response.created", response: { id: "resp_1", model: "m", status: "in_progress", output: [] } })
      + frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } });
    const delta = frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "שלום" });
    const tail = frame({ type: "response.output_item.done", output_index: 0, item: message("שלום") }) + frame({ type: "response.completed", response: response([message("שלום")]) });
    const bytes = encoder.encode(head + delta + tail);
    // Each Hebrew letter is two bytes: the cut falls inside the second.
    const cut = encoder.encode(head + delta.slice(0, delta.indexOf("שלום"))).length + 3;
    const deltas: string[] = [];
    const model = openAiResponses({ model: "m", fetch: fakeFetch([() => eventBody([bytes.slice(0, cut), bytes.slice(cut)])]).fetch });
    const turn = await model.send(request("Say hello in Hebrew."), { onText: (piece) => deltas.push(piece) });
    expect(turn.text).toBe("שלום");
    expect(deltas.join("")).toBe("שלום");
    expect(turn.finish).toBe("complete");
  });

  it("keeps the text of several message items apart, streamed or not", async () => {
    const items = [message("One.", "msg_1"), functionCall("fc_1", "call_1", "read_document", { document_id: "d", start_line: 1, end_line: 2 }), message("Two.", "msg_2")];
    const deltas: string[] = [];
    const streamed = await openAiResponses({ model: "m", fetch: fakeFetch([sse(streamOf(items))]).fetch }).send(request("?"), { onText: (delta) => deltas.push(delta) });
    expect(deltas).toEqual(["One.", "\n\nTwo."]);
    expect(streamed.text).toBe("One.\n\nTwo.");
    expect(streamed.raw).toEqual(items);
    const whole = await openAiResponses({ model: "m", fetch: fakeFetch([reply(items)]).fetch }).send(request("?"));
    expect(whole.text).toBe("One.\n\nTwo.");
  });

  it("tells how a response ended", async () => {
    const call = functionCall("fc_1", "call_1", "read_document", "{\"document_id\":\"d\",\"start_line\":1}");
    const cases: Array<[name: string, output: Json[], more: Json, expected: Json, absent: string[]]> = [
      ["completed", [message("Done.")], {}, { text: "Done.", finishReason: "completed", finish: "complete" }, ["blockReason"]],
      ["cut at the output limit", [call], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, { finishReason: "max_output_tokens", finish: "cut" }, ["blockReason"]],
      ["filtered, with nothing written", [], { status: "incomplete", incomplete_details: { reason: "content_filter" } }, { text: "", calls: [], finishReason: "content_filter", finish: "filtered", blockReason: "content_filter" }, []],
      ["incomplete for another reason", [message("Partly.")], { status: "incomplete", incomplete_details: { reason: "max_messages" } }, { finishReason: "max_messages" }, ["finish", "blockReason"]],
      ["incomplete with no reason", [message("Partly.")], { status: "incomplete" }, { finishReason: "incomplete" }, ["finish"]],
    ];
    for (const [name, output, more, expected, absent] of cases) {
      const terminal = response(output, more);
      for (const streamed of [false, true]) {
        const server = fakeFetch([streamed ? sse(streamOf(output, terminal)) : Response.json(terminal)]);
        const turn = await openAiResponses({ model: "m", fetch: server.fetch }).send(request("?"), streamed ? { onText: () => undefined } : {});
        expect(turn, `${name}, ${streamed ? "streamed" : "in one piece"}`).toMatchObject(expected);
        for (const field of absent) expect(turn, `${name}: ${field}`).not.toHaveProperty(field);
        if (name === "cut at the output limit") expect(turn.calls[0]!.problem).toMatch(/^This call was cut off at the output limit/);
      }
    }
    // A proxy's "[DONE]" alone ends the reply: whole, with no reason given.
    const done = await openAiResponses({ model: "m", fetch: fakeFetch([sse([...streamOf([message("Hi.")]).slice(0, -1), "[DONE]"])]).fetch }).send(request("?"), { onText: () => undefined });
    expect(done.text).toBe("Hi.");
    expect(done).not.toHaveProperty("finishReason");
    expect(done).not.toHaveProperty("finish");
    expect(done.raw).toEqual([message("Hi.")]);
  });

  it("does not run a call whose arguments are not JSON, sends it back with {}, and marks one that did not arrive whole", async () => {
    const model = (server: ReturnType<typeof fakeFetch>) => openAiResponses({ model: "m", fetch: server.fetch });
    const broken = await model(fakeFetch([reply([
      functionCall("fc_1", "a", "read_document", "{\"document_id\": \"doc"),
      functionCall("fc_2", "b", "get_document_overview", ""),
      functionCall("fc_3", "c", "read_document", { document_id: "d", start_line: 1 }),
      { type: "function_call", id: "fc_4", call_id: "d", name: "", arguments: "{}", status: "completed" },
    ])])).send(request("?"));
    expect(broken.calls).toEqual([
      { id: "a", name: "read_document", args: {}, problem: "The arguments of this call were not a JSON object, and it was not run: {\"document_id\": \"doc. Send the call again." },
      { id: "b", name: "get_document_overview", args: {} },
      { id: "c", name: "read_document", args: { document_id: "d", start_line: 1 } },
    ]);
    // A call without a name is in neither the calls nor the turn that goes back.
    expect((broken.raw as Json[]).map((item) => [item.call_id, item.arguments])).toEqual([["a", "{}"], ["b", "{}"], ["c", "{\"document_id\":\"d\",\"start_line\":1}"]]);

    // Added, and its arguments arrived, but it never ended before the response did.
    const args = "{\"document_id\":\"d\",\"start_line\":1}";
    const unfinished = await model(fakeFetch([sse([
      { type: "response.created", response: { id: "resp_1", model: "m", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_document", arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: args },
      { type: "response.completed", response: response([]) },
    ])])).send(request("?"), { onText: () => undefined });
    expect(unfinished.calls).toEqual([{ id: "call_1", name: "read_document", args: { document_id: "d", start_line: 1 }, problem: "This call did not arrive whole, and was not run. Send it again." }]);
    expect((unfinished.raw as Json[])[0]).toMatchObject({ type: "function_call", call_id: "call_1", arguments: args });

    // A call without a call ID is given one, in the call and in the item that goes back, and its output names it.
    const { files, meta } = await largeLog();
    const nameless = { type: "function_call", id: "fc_1", name: "read_document", arguments: JSON.stringify({ document_id: meta.id, start_line: 1, end_line: 2 }), status: "completed" };
    const alone = await model(fakeFetch([reply([nameless])])).send(request("?"));
    expect(alone.calls[0]!.id).toMatch(/^call_[0-9a-f]{24}$/);
    expect((alone.raw as Json[])[0]!.call_id).toBe(alone.calls[0]!.id);
    const endpoint = fakeFetch([reply([nameless]), answer("Two lines.")]);
    await askWithFiles({ files, model: model(endpoint), documentIds: [meta.id], messages: question("?") });
    const input = endpoint.sent[1]!.body.input as Json[];
    const given = input.find((item) => item.type === "function_call")!.call_id as string;
    expect(given).toMatch(/^call_[0-9a-f]{24}$/);
    expect(input.find((item) => item.type === "function_call_output")!.call_id).toBe(given);
  });

  it("keeps a refusal as the text, streamed or not", async () => {
    const refused = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I can't help with that." }] };
    const shown: string[] = [];
    const streamed = await openAiResponses({ model: "m", fetch: fakeFetch([sse([
      { type: "response.created", response: { id: "resp_1", model: "m", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...refused, status: "in_progress", content: [] } },
      { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "I can't help " },
      { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "with that." },
      { type: "response.output_item.done", output_index: 0, item: refused },
      { type: "response.completed", response: response([refused]) },
    ])]).fetch }).send(request("?"), { onText: (delta) => shown.push(delta) });
    expect(streamed.text).toBe("I can't help with that.");
    expect(shown).toEqual(["I can't help with that."]);
    const told: string[] = [];
    const whole = await openAiResponses({ model: "m", fetch: fakeFetch([reply([refused])]).fetch }).send(request("?"), { onText: (delta) => told.push(delta) });
    expect(whole.text).toBe("I can't help with that.");
    expect(told).toEqual(["I can't help with that."]);
  });
});

describe("openAiResponses: errors", () => {
  it("reports HTTP errors with their status, code, param and wait, and a connection that failed", async () => {
    const endpoint = fakeFetch([
      new Response(JSON.stringify({ error: { message: "Rate limit reached.", type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "7" } }),
      new Response(JSON.stringify({ error: { message: "Your input exceeds the context window of this model.", type: "invalid_request_error", code: "context_length_exceeded", param: "input" } }), { status: 400 }),
      new Response(JSON.stringify({ error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429 }),
      new Response("upstream timed out", { status: 504 }),
      new Response("<html>Bad gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      new Response("", { status: 200 }),
    ]);
    const model = openAiResponses({ model: "m", fetch: endpoint.fetch });
    const limited = await model.send(request("?")).catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(OpenAiRequestError);
    expect(limited).toBeInstanceOf(ModelRequestError);
    expect(limited).toMatchObject({ name: "OpenAiRequestError", status: 429, message: "Rate limit reached.", retryAfterMs: 7_000, kind: "rate_limit" });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 400, kind: "context_overflow", code: "context_length_exceeded", param: "input" });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 429, kind: "quota" });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 504, message: "The model returned HTTP 504." });
    await expect(model.send(request("?"))).rejects.toMatchObject({ status: 200, kind: "invalid", message: "The model's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place." });
    const empty = await model.send(request("?")).catch((error: unknown) => error);
    expect(empty).toMatchObject({ status: 0, kind: "unreachable", message: "The model could not be reached (the reply was empty)." });
    expect(isCutReply(empty)).toBe(true);

    const down = openAiResponses({ model: "m", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.send(request("?"))).rejects.toMatchObject({ name: "OpenAiRequestError", status: 0, kind: "unreachable", message: "The model could not be reached (fetch failed)." });
  });

  it("reads an error event, flat or nested, and response.failed, with the status of its type or code", async () => {
    expect(responsesErrorStatus({ type: "too_many_requests", code: "no_capacity" })).toBe(429);
    expect(responsesErrorStatus({ type: "forbidden" })).toBe(403);
    expect(responsesErrorStatus({ code: "server_error" })).toBe(500);
    expect(responsesErrorStatus({ code: "invalid_image_format" })).toBe(400);
    expect(responsesErrorStatus({ code: "invalid_prompt" })).toBe(400);
    expect(responsesErrorStatus({ code: "vector_store_timeout" })).toBe(408);
    expect(responsesErrorStatus({ code: "rate_limit_exceeded" })).toBe(429);
    expect(responsesErrorStatus({ code: "503" })).toBe(503);
    expect(responsesErrorStatus({})).toBe(500);
    expect(responsesErrorStatus("boom")).toBe(500);

    const created = { type: "response.created", response: { id: "resp_1", model: "m", status: "in_progress", output: [] } };
    const failing = (events: unknown[]) => openAiResponses({ model: "m", fetch: fakeFetch([sse(events)]).fetch }).send(request("?"), { onText: () => undefined });
    await expect(failing([created, { type: "error", code: "server_error", message: "boom", param: null, sequence_number: 3 }])).rejects.toMatchObject({ name: "OpenAiRequestError", status: 500, message: "boom", code: "server_error" });
    // Azure's error event holds an error object, whose type tells the status.
    await expect(failing([created, { type: "error", error: { type: "too_many_requests", code: "no_capacity", message: "Too many requests.", param: null } }])).rejects.toMatchObject({ status: 429, kind: "rate_limit", code: "no_capacity", message: "Too many requests." });
    await expect(failing([created, { type: "error" }])).rejects.toMatchObject({ status: 500, message: "The model reported an error." });
    await expect(failing([created, { type: "response.failed", response: { id: "resp_1", status: "failed", error: { code: "invalid_prompt", message: "Invalid prompt: flagged." }, output: [] } }])).rejects.toMatchObject({ status: 400, kind: "invalid", code: "invalid_prompt", message: "Invalid prompt: flagged." });
    await expect(failing([{ error: { message: "Upstream failed.", code: 502 } }])).rejects.toMatchObject({ status: 502, message: "Upstream failed." });
    // A response of 200 in one piece that failed.
    await expect(openAiResponses({ model: "m", fetch: fakeFetch([Response.json({ id: "resp_1", status: "failed", error: { code: "server_error", message: "The server had an error." }, output: [] })]).fetch }).send(request("?")))
      .rejects.toMatchObject({ status: 500, kind: "server", message: "The server had an error." });

    // A failure the server names as its own is sent again when nothing of it was shown.
    const { files, meta } = await smallNote();
    const endpoint = fakeFetch([sse([created, { type: "error", code: "server_error", message: "The server had an error.", param: null }]), sse(streamOf([message("Tuesday.")]))]);
    const shown: string[] = [];
    const result = await askWithFiles({ files, model: openAiResponses({ model: "m", fetch: endpoint.fetch }), documentIds: [meta.id], messages: question("When?"), retry: quick, onText: (delta) => shown.push(delta) });
    expect(endpoint.sent).toHaveLength(2);
    expect(result.text).toBe("Tuesday.");
    expect(shown.join("")).toBe("Tuesday.");
  });

  it("says a stream that ended without a terminal event was cut off, and sends it again when nothing was shown", async () => {
    const created = { type: "response.created", response: { id: "resp_1", model: "m", status: "in_progress", output: [] } };
    const text = [created, { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } }, { type: "response.output_text.delta", output_index: 0, delta: "Tues" }];
    const cut = await openAiResponses({ model: "m", fetch: fakeFetch([sse(text)]).fetch }).send(request("?"), { onText: () => undefined }).catch((error: unknown) => error);
    expect(cut).toMatchObject({ name: "OpenAiRequestError", status: 0, kind: "unreachable", message: "The model's reply ended before it was complete." });
    expect(isCutReply(cut)).toBe(true);
    // An event that is not JSON is a reply cut off on its way too.
    const garbled = await openAiResponses({ model: "m", fetch: fakeFetch([() => eventBody([encoder.encode(`data: ${JSON.stringify(created)}\n\ndata: {"type":"resp\n\n`)])]).fetch }).send(request("?"), { onText: () => undefined }).catch((error: unknown) => error);
    expect(garbled).toMatchObject({ status: 0, kind: "unreachable" });
    expect(isCutReply(garbled)).toBe(true);

    // Cut off before any text: the loop sends it again, and the second stream answers.
    const { files, meta } = await smallNote();
    const endpoint = fakeFetch([sse([created, { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } }]), sse(streamOf([message("Tuesday.")]))]);
    const shown: string[] = [];
    const result = await askWithFiles({ files, model: openAiResponses({ model: "m", fetch: endpoint.fetch }), documentIds: [meta.id], messages: question("When?"), retry: quick, onText: (delta) => shown.push(delta) });
    expect(endpoint.sent).toHaveLength(2);
    expect(result.text).toBe("Tuesday.");
    expect(shown).toEqual(["Tuesday."]);

    // A connection that breaks after the response ended loses nothing of it.
    let pulls = 0;
    const whole = encoder.encode(streamOf([message("Kept.")]).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    const breaking = () => new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(whole);
        else controller.error(new TypeError("terminated"));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    expect((await openAiResponses({ model: "m", fetch: fakeFetch([breaking]).fetch }).send(request("?"), { onText: () => undefined })).text).toBe("Kept.");

    // User turns that follow each other are made one.
    const joined = fakeFetch([answer("ok")]);
    const model = openAiResponses({ model: "m", fetch: joined.fetch });
    await model.send({ system: "", messages: [{ role: "user", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "b" }] }, { role: "assistant", parts: [{ text: "c" }] }, { role: "user", parts: [{ text: "d" }] }] });
    expect(joined.sent[0]!.body.input).toEqual([{ role: "user", content: "a\n\nb" }, { role: "assistant", content: "c" }, { role: "user", content: "d" }]);
    // Native parts: as they are, the text beside them as input_text from the user and output_text from the assistant.
    const image = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" };
    await model.send({ system: "", messages: [
      { role: "user", parts: [{ text: "Look:" }, { native: image }] },
      { role: "user", parts: [{ text: "" }] },
      { role: "user", parts: [{ text: "What is it?" }] },
      { role: "assistant", parts: [{ text: "A square." }, { native: { type: "refusal", refusal: "" } }] },
    ] });
    expect(joined.sent[1]!.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Look:" }, image, { type: "input_text", text: "What is it?" }] },
      { role: "assistant", content: [{ type: "output_text", text: "A square." }, { type: "refusal", refusal: "" }] },
    ]);
  });

  it("stops with the caller's reason, and reports a silent server as a timeout", async () => {
    // A body that sends one piece of text, and then nothing, without end.
    const stop = new AbortController();
    const endless = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "Tues" })}\n\n`));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const stopped = openAiResponses({ model: "m", fetch: fakeFetch([endless]).fetch }).send(request("?"), { signal: stop.signal, onText: () => stop.abort(new Error("stopped by the user")) });
    await expect(stopped).rejects.toThrow("stopped by the user");

    const silent = await openAiResponses({ model: "m", fetch: hangingFetch(), firstByteTimeoutMs: 20 }).send(request("?")).catch((error: unknown) => error);
    expect(silent).toBeInstanceOf(OpenAiRequestError);
    expect(silent).toMatchObject({ status: 0, kind: "timeout", message: "The model sent nothing for 0 s." });
    // Stopped before it was sent: the caller's own reason, not an error of the model.
    const before = new AbortController();
    before.abort(new Error("stopped"));
    await expect(openAiResponses({ model: "m", fetch: hangingFetch() }).send(request("?"), { signal: before.signal })).rejects.toThrow("stopped");
  });
});

describe("openAiResponses: part reads", () => {
  it("reads a part with max_output_tokens and store false, and asks again when the limit went on reasoning", async () => {
    const bodies: Json[] = [];
    const endpoint = fakeFetch([(sent) => {
      bodies.push(sent.body);
      const limit = sent.body.max_output_tokens as number;
      return limit < THINKING_OUTPUT_TOKENS
        ? reply([reasoning("rs_1")], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 25_000, output_tokens: limit, output_tokens_details: { reasoning_tokens: limit } } })
        : reply([reasoning("rs_2"), message("Deadlocks at (L250).")], { usage: { input_tokens: 25_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 900, output_tokens_details: { reasoning_tokens: 600 } } });
    }]);
    const used: unknown[] = [];
    const model = openAiResponses({ model: "gpt-5.5-part-reads", body: { temperature: 0.2 }, analysisBody: () => ({ reasoning: { effort: "low" } }), fetch: endpoint.fetch });
    expect(await model.generateText!({ system: "Take notes.", prompt: "PART", maxOutputTokens: 4_096, onUsage: (usage) => used.push(usage) })).toBe("Deadlocks at (L250).");
    expect(bodies.map((body) => body.max_output_tokens)).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    // No include, no tools, not the chat's body.
    expect(bodies[0]).toEqual({ model: "gpt-5.5-part-reads", instructions: "Take notes.", input: [{ role: "user", content: "PART" }], max_output_tokens: 4_096, store: false, reasoning: { effort: "low" } });
    expect(Object.keys(bodies[0]!)).toEqual(["model", "instructions", "input", "max_output_tokens", "store", "reasoning"]);
    expect(endpoint.sent.map((sent) => sent.url)).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"]);
    // Both requests were billed, and both are reported.
    expect(used).toEqual([
      { inputTokens: 25_000, cachedInputTokens: 0, outputTokens: 4_096, thoughtTokens: 4_096 },
      { inputTokens: 25_000, cachedInputTokens: 0, outputTokens: 900, thoughtTokens: 600 },
    ]);
    // The next part starts with the larger limit.
    await model.generateText!({ system: "s", prompt: "p", maxOutputTokens: 4_096 });
    expect(bodies.at(-1)!.max_output_tokens).toBe(THINKING_OUTPUT_TOKENS);

    // Cut off with notes written: they are kept, and said to be incomplete.
    const truncated = vi.fn();
    const long = fakeFetch([reply([message("partial notes, ORD-")], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })]);
    expect(await openAiResponses({ model: "long", fetch: long.fetch }).generateText!({ system: "", prompt: "p", maxOutputTokens: 100, onTruncated: truncated })).toBe("partial notes, ORD-");
    expect(truncated).toHaveBeenCalledTimes(1);
    expect(long.sent[0]!.body).toEqual({ model: "long", input: [{ role: "user", content: "p" }], max_output_tokens: 100, store: false });
    // Filtered with nothing written: no text, and why.
    const filtered = fakeFetch([reply([], { status: "incomplete", incomplete_details: { reason: "content_filter" } })]);
    await expect(openAiResponses({ model: "filtered", fetch: filtered.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toThrow("The model returned no text (content_filter).");
    const failed = fakeFetch([Response.json({ id: "resp_1", status: "failed", error: { code: "rate_limit_exceeded", message: "Slow down." }, output: [] })]);
    await expect(openAiResponses({ model: "failed", fetch: failed.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ status: 429, kind: "rate_limit", message: "Slow down." });

    const slow = openAiResponses({ model: "slow", timeoutMs: 20, fetch: hangingFetch() });
    const timedOut = await slow.generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(OpenAiRequestError);
    expect(timedOut).toMatchObject({ status: 0, kind: "timeout", message: "The model took longer than 20 ms to answer." });
    // 0 sets no time limit: the request goes without a signal. A connection that failed is no timeout.
    const unlimited = fakeFetch([answer("Notes (L1).")]);
    expect(await openAiResponses({ model: "unlimited", timeoutMs: 0, fetch: unlimited.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("Notes (L1).");
    const down = openAiResponses({ model: "down", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ status: 0, kind: "unreachable", message: "The model could not be reached (fetch failed)." });
  });
});
