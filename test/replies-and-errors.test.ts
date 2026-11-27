// How the three adapters read replies and errors, since the 0.6 review: provider wordings,
// streams that end or hang in odd ways, bodies that are not what was asked for, and what a failed
// part read tells the model.
import { describe, expect, it, vi } from "vitest";
import { askWithFiles, classifyModelError, createLargeFiles, DocumentStoreError, MemoryDocumentStore, ModelRequestError, resolveBudget, withRetry, type GenerateText, type ModelAdapter, type ModelRequest } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { createGeminiGenerateText, gemini, geminiApi, THINKING_OUTPUT_TOKENS, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { streamedReply, until } from "../src/http.js";
import { analyzeWholeDocument } from "../src/map-reduce.js";
import { SearchableDocument } from "../src/search.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

type Json = Record<string, any>;

const encoder = new TextEncoder();
/** The promise, or a failure when it has not settled within the wait: a test that hangs fails at once. */
async function settles<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Still waiting after ${ms} ms.`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const request: ModelRequest = { system: "", messages: [{ role: "user", parts: [{ text: "?" }] }] };
const question = (text: string) => [{ role: "user" as const, text }];
const quick = { random: () => 1, sleep: async () => undefined };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
/** A body that sends these pieces, then closes, or stays open. */
const body = (pieces: string[], open = false) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const piece of pieces) controller.enqueue(encoder.encode(piece));
    if (!open) controller.close();
  },
});
const sse = (events: unknown[]) => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
const claudeSse = (events: Json[]) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const chunk = (delta: Json, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const reply = (content: string) => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });
/** The events of a whole Claude message with this text. */
const claudeMessage = (text: string): Json[] => [
  { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];

/** A fetch that answers each request with what `answer` gives, and counts them. */
function counting(answer: (sent: number, body: Json) => Response | Promise<Response>) {
  const state = { sent: 0, bodies: [] as Json[] };
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    state.sent++;
    const sent = JSON.parse(String(init?.body)) as Json;
    state.bodies.push(sent);
    return answer(state.sent, sent);
  });
  return Object.assign(state, { fetch: fetch as unknown as typeof globalThis.fetch });
}

const openAi = (fetch: typeof globalThis.fetch, more: Json = {}) => openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", fetch, ...more });
const claude = (fetch: typeof globalThis.fetch, more: Json = {}) => anthropic({ model: "claude-test", apiKey: "k", fetch, ...more });
const geminiModel = (fetch: typeof globalThis.fetch, more: Json = {}) => gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch, ...more });

describe("errors of OpenAI-compatible servers, since the 0.6 review", () => {
  it("reads a message at the top of the body (vLLM before 0.29, SGLang, FastChat) and FastAPI's detail", async () => {
    const overflow = "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (38000 in the messages, 2000 in the completion). Please reduce the length of the messages or completion.";
    const cases: Array<[number, unknown, Json]> = [
      [400, { object: "error", message: overflow, type: "BadRequestError", param: null, code: 400 }, { message: overflow, kind: "context_overflow", limitTokens: 32_768, requestedTokens: 38_000 }],
      [400, { detail: "This model's maximum context length is 8192 tokens." }, { message: "This model's maximum context length is 8192 tokens.", kind: "context_overflow", limitTokens: 8_192 }],
      [422, { detail: [{ loc: ["body", "messages"], msg: "field required", type: "value_error.missing" }, { loc: ["body", "model"], msg: "field required" }] }, { message: "field required; field required", kind: "invalid" }],
      // A top-level word of the server is read too, when there is no error object.
      [400, { message: "Too long.", code: "context_length_exceeded" }, { message: "Too long.", kind: "context_overflow", code: "context_length_exceeded" }],
      // The usual shape, as before.
      [400, { error: { message: overflow, type: "BadRequestError", code: 400 } }, { message: overflow, kind: "context_overflow", limitTokens: 32_768 }],
      [500, { unknown: true }, { message: "The model returned HTTP 500.", kind: "server" }],
    ];
    for (const [status, sent, expected] of cases) {
      const model = openAi((async () => json(sent, status)) as typeof globalThis.fetch);
      await expect(model.send(request), JSON.stringify(sent)).rejects.toMatchObject({ name: "OpenAiRequestError", status, ...expected });
    }
  });

  it("keeps the code of an error inside a stream: a request too large is made smaller, and no credit left is not sent again", async () => {
    const cases: Array<[Json, Json]> = [
      [{ message: "Input too long.", type: "invalid_request_error", code: "context_length_exceeded" }, { status: 400, kind: "context_overflow", code: "context_length_exceeded" }],
      [{ message: "You exceeded your current quota.", type: "insufficient_quota", param: null, code: "insufficient_quota" }, { status: 429, kind: "quota", code: "insufficient_quota" }],
      // An error the server did not name is its own, as before: sent again.
      [{ message: "The server had an error.", type: "server_error", code: null }, { status: 500, kind: "server" }],
    ];
    for (const [failed, expected] of cases) {
      const server = counting(() => new Response(body(sse([chunk({ role: "assistant" }), { error: failed }])), { headers: { "Content-Type": "text/event-stream" } }));
      const model = openAi(server.fetch);
      await expect(withRetry(() => model.send(request, { onText: () => undefined }), { retry: quick })).rejects.toMatchObject({ message: failed.message, ...expected });
      expect(server.sent, failed.message).toBe(expected.kind === "server" ? 4 : 1);
    }
  });

  it("does not send again a request larger than a minute's allowance of tokens, but plans the files for it", async () => {
    const tooLarge = { error: { message: "Request too large for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Requested 45237. The input or output tokens must be reduced in order to run successfully.", type: "tokens", param: null, code: "rate_limit_exceeded" } };
    const alone = counting(() => json(tooLarge, 429));
    await expect(withRetry(() => openAi(alone.fetch).send(request), { retry: quick })).rejects.toMatchObject({ status: 429, kind: "context_overflow", limitTokens: 30_000, requestedTokens: 45_237 });
    expect(alone.sent).toBe(1);

    // In a question: the log was put in the prompt whole, which is more than the minute allows.
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 400_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const server = counting((_sent, sent) => (JSON.stringify(sent).length > 200_000 ? json(tooLarge, 429) : json(reply("Answered from the card."))));
    const result = await askWithFiles({ files, model: openAi(server.fetch), documentIds: [meta.id], messages: question("?"), retry: quick });
    expect(server.sent).toBe(2);
    expect(result).toMatchObject({ text: "Answered from the card.", answered: true });
    // The 30,000 are the tokens of a minute, not the model's window: the step says so.
    expect(result.steps[0]).toBe("The first request was larger than the 30,000 tokens a minute that the provider allows: the files were planned again to fit it");

    // Groq says "per minute", and sends it as HTTP 413 (or 429). A rate limit a wait mends stays one.
    const groq = "Request too large for model `llama-3.3-70b-versatile` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 15000, please reduce your message size and try again.";
    for (const status of [413, 429]) expect(classifyModelError(status, groq, { code: "rate_limit_exceeded" }), String(status)).toEqual({ kind: "context_overflow", limitTokens: 12_000, requestedTokens: 15_000 });
    expect(classifyModelError(429, "Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 11000, Requested 2000. Please try again in 5s.", { code: "rate_limit_exceeded" }).kind).toBe("rate_limit");
  });

  it("says that a request was larger than the provider allows in a minute when it shortens older tool results for it", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    const read = (from: number) => ({ name: "read_document", args: { document_id: meta.id, start_line: from, end_line: from + 199 } });
    const tooLarge = "Request too large for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Requested 45237.";
    let refused = false;
    const model = fakeModel([
      calls([read(1)]),
      calls([read(1_001)]),
      (sent) => {
        if (refused || sent.messages.some((message) => message.role === "tools" && message.answers.some((answer) => answer.result.dropped === true))) return says("Both ranges are INFO lines.");
        refused = true;
        return new ModelRequestError(tooLarge, 429);
      },
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick });
    expect(result).toMatchObject({ answered: true, text: "Both ranges are INFO lines." });
    expect(result.steps).toContain("The request was larger than the provider allows in a minute: older tool results were shortened, and it was sent again");
  });

  it("puts a streamed call together whose name the server sends again with each piece, or in pieces", async () => {
    const piece = (name: string, args: string, id?: string) => chunk({ tool_calls: [{ index: 0, ...(id ? { id, type: "function" } : {}), function: { name, arguments: args } }] });
    const streams = [
      [piece("search_document", "{\"query\":", "c1"), piece("search_document", "\"x\"}")],
      [piece("search_", "{\"query\":", "c1"), piece("document", "\"x\"}")],
      [piece("search_document", "{\"query\":", "c1"), piece("", "\"x\"}")],
    ];
    for (const events of streams) {
      const model = openAi((async () => new Response(body(sse([...events, chunk({}, "tool_calls"), "[DONE]"])), { headers: { "Content-Type": "text/event-stream" } })) as typeof globalThis.fetch);
      const got = await model.send(request, { onText: () => undefined });
      expect(got.calls).toEqual([{ id: "c1", name: "search_document", args: { query: "x" } }]);
      expect((got.raw as Json).tool_calls[0].function.name).toBe("search_document");
    }
  });
});

describe("the kind of a refusal, since the 0.6 review", () => {
  it("tells a quota from HTTP 402, from no credit left, from a spending cap, and from a quota per day named in the message", () => {
    const quota: Array<[number, string, Json?]> = [
      [402, "Insufficient Balance"], // DeepSeek
      [402, "Insufficient credits. Add more using https://openrouter.ai/settings/credits"], // OpenRouter
      [400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", { code: "invalid_request_error" }],
      [429, "You have reached your API usage limits: your organization has crossed its monthly API usage threshold.", { code: "rate_limit_error" }],
      [400, "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.", { code: "invalid_request_error" }],
      [429, "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_day_per_project_per_base_model with base model: gemini-2.5-pro. Please submit a quota increase request.", { code: "RESOURCE_EXHAUSTED" }],
    ];
    for (const [status, message, signals] of quota) expect(classifyModelError(status, message, signals).kind, message).toBe("quota");
    // A quota per minute is waited for, as before.
    expect(classifyModelError(429, "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model with base model: gemini-2.5-pro. Please submit a quota increase request.", { code: "RESOURCE_EXHAUSTED" }).kind).toBe("rate_limit");
    expect(classifyModelError(429, "You exceeded your current quota, please check your plan and billing details.", { code: "RESOURCE_EXHAUSTED" }).kind).toBe("rate_limit");
    expect(classifyModelError(503, "Insufficient resources on the server.").kind).toBe("server");
  });

  it("tells more wordings of a request larger than the model takes, with the numbers they give", () => {
    const cases: Array<[number, string, Json]> = [
      // Text Generation Inference, Hugging Face and Together.
      [422, "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32769. Given: 40000 `inputs` tokens and 1024 `max_new_tokens`", { limitTokens: 32_769, requestedTokens: 40_000 }],
      [422, "Input validation error: `inputs` must have less than 4096 tokens. Given: 5000", { limitTokens: 4_096, requestedTokens: 5_000 }],
      // LM Studio.
      [400, "Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input", { limitTokens: 4_096 }],
      [400, "The number of tokens to keep from the initial prompt is greater than the context length.", {}],
      // Amazon Bedrock.
      [400, "Input is too long for requested model.", {}],
      // vLLM since its errors changed.
      [400, "This model's maximum context length is 32768 tokens. However, your request has 40000 input tokens. Please reduce the length of the input messages.", { limitTokens: 32_768, requestedTokens: 40_000 }],
    ];
    for (const [status, message, numbers] of cases) expect(classifyModelError(status, message), message).toEqual({ kind: "context_overflow", ...numbers });
  });

  it("does not send again Claude's spending cap, nor a request the API says not to try again", async () => {
    const capped = counting(() => json({ type: "error", error: { type: "rate_limit_error", message: "You have reached your API usage limits.", details: { error_code: "enforced_spend_limit_reached" } } }, 429));
    await expect(withRetry(() => claude(capped.fetch, { stream: false }).send(request), { retry: quick })).rejects.toMatchObject({ status: 429, kind: "quota", type: "rate_limit_error" });
    expect(capped.sent).toBe(1);

    const failed = { type: "error", error: { type: "api_error", message: "Internal server error" } };
    const told = counting(() => json(failed, 500, { "x-should-retry": "false" }));
    await expect(withRetry(() => claude(told.fetch, { stream: false }).send(request), { retry: quick })).rejects.toMatchObject({ status: 500, kind: "server" });
    expect(told.sent).toBe(1);
    // Without the header, or with it set to true, a server error is sent again as before.
    for (const headers of [{}, { "x-should-retry": "true" }] as Array<Record<string, string>>) {
      const again = counting(() => json(failed, 500, headers));
      await expect(withRetry(() => claude(again.fetch, { stream: false }).send(request), { retry: quick })).rejects.toMatchObject({ status: 500 });
      expect(again.sent).toBe(4);
    }
  });

  it("gives a Claude error inside a stream the status of its type, and a type it does not know the server's", async () => {
    const cases: Array<[string, Json]> = [
      ["invalid_request_error", { status: 400, kind: "invalid" }],
      ["billing_error", { status: 402, kind: "quota" }],
      ["permission_error", { status: 403, kind: "auth" }],
      ["request_too_large", { status: 413, kind: "context_overflow" }],
      ["overloaded_error", { status: 529, kind: "server" }],
      ["a_new_error", { status: 500, kind: "server" }],
    ];
    for (const [type, expected] of cases) {
      const events = claudeSse([{ type: "message_start", message: { usage: {} } }, { type: "error", error: { type, message: `${type} happened` } }]);
      const model = claude((async () => new Response(body(events), { headers: { "Content-Type": "text/event-stream" } })) as typeof globalThis.fetch);
      await expect(model.send(request, { onText: () => undefined }), type).rejects.toMatchObject({ name: "AnthropicRequestError", type, ...expected });
    }
  });
});

describe("streams that end or hang, since the 0.6 review", () => {
  it("ends a request once its wait ran out, though the body never finishes being cancelled", async () => {
    const hanging = () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => undefined), cancel: () => new Promise<void>(() => undefined) }), { headers: { "Content-Type": "text/event-stream" } });
    const waits = { firstByteTimeoutMs: 50, idleTimeoutMs: 50 };
    const fetch = (async () => hanging()) as typeof globalThis.fetch;
    const models: Array<[string, ModelAdapter]> = [["openai", openAi(fetch, waits)], ["claude", claude(fetch, waits)], ["gemini", geminiModel(fetch, waits)]];
    for (const [name, model] of models) {
      for (const streamed of [true, false]) {
        const started = Date.now();
        await expect(model.send(request, streamed ? { onText: () => undefined } : {}), `${name}, streamed ${streamed}`).rejects.toMatchObject({ status: 0, kind: "timeout" });
        expect(Date.now() - started).toBeLessThan(2_000);
      }
    }
  });

  it("returns a reply whose stream said it is whole, though the server left the connection open", async () => {
    const waits = { firstByteTimeoutMs: 100, idleTimeoutMs: 100 };
    const openAiEvents = sse([chunk({ content: "The whole answer." }), chunk({}, "stop"), "[DONE]"]);
    const shown: string[] = [];
    const left = openAi((async () => new Response(body(openAiEvents, true), { headers: { "Content-Type": "text/event-stream" } })) as typeof globalThis.fetch, waits);
    expect((await left.send(request, { onText: (delta) => shown.push(delta) })).text).toBe("The whole answer.");
    expect(shown).toEqual(["The whole answer."]);
    const claudeLeft = claude((async () => new Response(body(claudeSse(claudeMessage("The whole answer.")), true), { headers: { "Content-Type": "text/event-stream" } })) as typeof globalThis.fetch, waits);
    expect((await claudeLeft.send(request, { onText: () => undefined })).text).toBe("The whole answer.");

    // A body that ends as usual is not held for the grace.
    const closed = openAi((async () => new Response(body(openAiEvents), { headers: { "Content-Type": "text/event-stream" } })) as typeof globalThis.fetch, waits);
    const started = Date.now();
    expect((await closed.send(request, { onText: () => undefined })).text).toBe("The whole answer.");
    expect(Date.now() - started).toBeLessThan(900);
    // Events after "[DONE]" in the same piece are still read, as before.
    const after = openAi((async () => new Response(body([openAiEvents.slice(0, 1).join("") + "data: [DONE]\n\n" + sse([chunk({}, "stop")]).join("")]), { headers: { "Content-Type": "text/event-stream" } })) as typeof globalThis.fetch, waits);
    expect(await after.send(request, { onText: () => undefined })).toMatchObject({ text: "The whole answer.", finishReason: "stop" });
  });

  it("lets go of a body left open after the reply said it is whole, also when it came under another content type", async () => {
    const cases: Array<[string, (fetch: typeof globalThis.fetch) => ModelAdapter, string[]]> = [
      ["openai", (fetch) => openAi(fetch), sse([chunk({ content: "The whole answer." }), chunk({}, "stop"), "[DONE]"])],
      ["claude", (fetch) => claude(fetch), claudeSse(claudeMessage("The whole answer."))],
    ];
    for (const [name, make, events] of cases) {
      for (const type of ["text/event-stream", "application/octet-stream"]) {
        let cancelled = false;
        const open = () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events) controller.enqueue(encoder.encode(event));
          },
          cancel() {
            cancelled = true;
          },
        }), { headers: { "Content-Type": type } });
        expect((await make((async () => open()) as typeof globalThis.fetch).send(request, { onText: () => undefined })).text, `${name}, ${type}`).toBe("The whole answer.");
        // The body the server left open is cancelled, so that its connection is closed.
        await vi.waitFor(() => expect(cancelled, `${name}, ${type}`).toBe(true), { timeout: 1_000 });
      }
    }
  }, 15_000);

  it("keeps a reply whose stream said it is whole, though the connection then broke rather than end", async () => {
    const breaking = (events: string[]) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
      },
      pull(controller) {
        controller.error(new TypeError("terminated"));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const openAiEvents = sse([chunk({ content: "The whole answer." }), chunk({}, "stop"), "[DONE]"]);
    const broken = openAi((async () => breaking(openAiEvents)) as typeof globalThis.fetch);
    expect((await broken.send(request, { onText: () => undefined })).text).toBe("The whole answer.");
    const claudeBroken = claude((async () => breaking(claudeSse(claudeMessage("The whole answer.")))) as typeof globalThis.fetch);
    expect((await claudeBroken.send(request, { onText: () => undefined })).text).toBe("The whole answer.");
    // Before its end, it is a reply cut off on its way, as before.
    await expect(openAi((async () => breaking(openAiEvents.slice(0, 2))) as typeof globalThis.fetch).send(request, { onText: () => undefined })).rejects.toMatchObject({ status: 0, kind: "unreachable", message: "The model could not be reached (terminated)." });
    await expect(claude((async () => breaking(claudeSse(claudeMessage("The whole answer.")).slice(0, 5))) as typeof globalThis.fetch).send(request, { onText: () => undefined })).rejects.toMatchObject({ status: 0, kind: "unreachable", message: "Claude could not be reached (terminated)." });
  });

  it("says that a reply was cut off on its way, not that the model could not be reached, when it is sent again", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "note.txt", bytes: utf8("The meeting moved to Tuesday.\n") });
    const stream = (events: string[]) => new Response(body(events), { headers: { "Content-Type": "text/event-stream" } });
    const geminiChunk = (parts: Json[], finishReason?: string) => ({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] });
    const cut: Array<[string, (fetch: typeof globalThis.fetch) => ModelAdapter, string[], string[]]> = [
      ["openai", (fetch) => openAi(fetch), sse([chunk({ role: "assistant" })]), sse([chunk({ content: "Tuesday." }), chunk({}, "stop"), "[DONE]"])],
      ["gemini", (fetch) => geminiModel(fetch), sse([geminiChunk([])]), sse([geminiChunk([{ text: "Tuesday." }], "STOP")])],
      ["claude", (fetch) => claude(fetch), claudeSse(claudeMessage("").slice(0, 2)), claudeSse(claudeMessage("Tuesday."))],
    ];
    for (const [name, make, first, second] of cut) {
      const server = counting((sent) => stream(sent === 1 ? first : second));
      const activity: string[] = [];
      const result = await askWithFiles({ files, model: make(server.fetch), documentIds: [meta.id], messages: question("When?"), onText: () => undefined, onActivity: (line) => activity.push(line), retry: quick });
      expect(result.text, name).toBe("Tuesday.");
      expect(activity, name).toEqual(["The model's reply was cut off on its way. Trying again…"]);
    }
    // A connection that failed before any reply is still one that could not be reached.
    let calls = 0;
    const down = openAi((async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return stream(sse([chunk({ content: "Tuesday." }), chunk({}, "stop"), "[DONE]"]));
    }) as typeof globalThis.fetch);
    const activity: string[] = [];
    await askWithFiles({ files, model: down, documentIds: [meta.id], messages: question("When?"), onText: () => undefined, onActivity: (line) => activity.push(line), retry: quick });
    expect(activity).toEqual(["The model could not be reached. Trying again…"]);
  });

  it("says so too when the body broke on its way, streamed or not, or came empty", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "note.txt", bytes: utf8("The meeting moved to Tuesday.\n") });
    /** A body that sends its first piece, then breaks; or, with no piece, one that ends empty. */
    const broken = (first: string | undefined, type: string) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (first === undefined) controller.close();
        else controller.enqueue(encoder.encode(first));
      },
      pull(controller) {
        controller.error(new TypeError("terminated"));
      },
    }), { headers: { "Content-Type": type } });
    const geminiReply = { candidates: [{ content: { role: "model", parts: [{ text: "Tuesday." }] }, finishReason: "STOP" }] };
    const claudeReply = { content: [{ type: "text", text: "Tuesday." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } };
    const geminiFirst = sse([{ candidates: [{ content: { role: "model", parts: [] } }] }])[0]!;
    const cases: Array<[string, (fetch: typeof globalThis.fetch) => ModelAdapter, boolean, string | undefined, string, () => Response]> = [
      // Streamed: an event came, then the connection broke.
      ["openai streamed", (fetch) => openAi(fetch), true, sse([chunk({ role: "assistant" })])[0], "text/event-stream", () => new Response(body(sse([chunk({ content: "Tuesday." }), chunk({}, "stop"), "[DONE]"])), { headers: { "Content-Type": "text/event-stream" } })],
      ["gemini streamed", (fetch) => geminiModel(fetch), true, geminiFirst, "text/event-stream", () => new Response(body(sse([geminiReply])), { headers: { "Content-Type": "text/event-stream" } })],
      ["claude streamed", (fetch) => claude(fetch), true, claudeSse(claudeMessage(""))[0], "text/event-stream", () => new Response(body(claudeSse(claudeMessage("Tuesday."))), { headers: { "Content-Type": "text/event-stream" } })],
      // Streamed under another type: it broke before enough came to tell events from JSON.
      ["openai streamed, told by its start", (fetch) => openAi(fetch), true, "da", "application/octet-stream", () => json(reply("Tuesday."))],
      // In one piece: the body broke while it arrived, or came empty.
      ["openai in one piece", (fetch) => openAi(fetch), false, "{\"choices\":", "application/json", () => json(reply("Tuesday."))],
      ["gemini in one piece", (fetch) => geminiModel(fetch), false, "{\"candidates\":", "application/json", () => json(geminiReply)],
      ["claude in one piece", (fetch) => claude(fetch, { stream: false }), false, "{\"content\":", "application/json", () => json(claudeReply)],
      ["openai empty", (fetch) => openAi(fetch), false, undefined, "application/json", () => json(reply("Tuesday."))],
      ["gemini streamed, empty", (fetch) => geminiModel(fetch), true, undefined, "application/json", () => json(geminiReply)],
      ["claude empty", (fetch) => claude(fetch, { stream: false }), false, undefined, "application/json", () => json(claudeReply)],
    ];
    for (const [name, make, streamed, first, type, whole] of cases) {
      const server = counting((sent) => (sent === 1 ? broken(first, type) : whole()));
      const activity: string[] = [];
      const result = await askWithFiles({ files, model: make(server.fetch), documentIds: [meta.id], messages: question("When?"), ...(streamed ? { onText: () => undefined } : {}), onActivity: (line) => activity.push(line), retry: quick });
      expect(result.text, name).toBe("Tuesday.");
      expect(activity, name).toEqual(["The model's reply was cut off on its way. Trying again…"]);
    }
    // An empty body is not a page in the model's place: it is sent again, as a reply that did not arrive.
    for (const [who, make] of [["The model", openAi], ["Claude", (fetch: typeof globalThis.fetch) => claude(fetch, { stream: false })], ["Gemini", geminiModel]] as Array<[string, (fetch: typeof globalThis.fetch) => ModelAdapter]>) {
      const server = counting(() => broken(undefined, "application/json"));
      await expect(withRetry(() => make(server.fetch).send(request), { retry: quick }), who).rejects.toMatchObject({ status: 0, kind: "unreachable", message: `${who} could not be reached (the reply was empty).` });
      expect(server.sent, who).toBe(4);
    }
  });
});

describe("a request raced against the caller's signal", () => {
  it("takes a value or a thenable from an adapter written in plain JavaScript, as a promise", async () => {
    const live = new AbortController().signal;
    expect(await until("a plain reply", live)).toBe("a plain reply");
    const thenable = (value: string) => ({ then: (resolve: (value: string) => void) => resolve(value) }) as unknown as PromiseLike<string>;
    expect(await until(thenable("a thenable"), live)).toBe("a thenable");
    const stopped = new AbortController();
    stopped.abort(new Error("stopped by the caller"));
    await expect(until("a plain reply", stopped.signal)).rejects.toThrow("stopped by the caller");
    await expect(until({ then: () => undefined } as unknown as PromiseLike<string>, stopped.signal)).rejects.toThrow("stopped by the caller");
  });
});

describe("bodies that are not what was asked for, since the 0.6 review", () => {
  it("reads a stream that a gateway sent under another content type, or none", async () => {
    const openAiEvents = sse([chunk({ content: "hi" }), chunk({}, "stop"), "[DONE]"]);
    for (const headers of [{ "Content-Type": "application/octet-stream" }, { "Content-Type": "text/plain" }, {}] as Array<Record<string, string>>) {
      const model = openAi((async () => new Response(body(openAiEvents), { headers })) as typeof globalThis.fetch);
      expect((await model.send(request, { onText: () => undefined })).text, JSON.stringify(headers)).toBe("hi");
      const claudeModel = claude((async () => new Response(body(claudeSse(claudeMessage("hi"))), { headers })) as typeof globalThis.fetch);
      expect((await claudeModel.send(request, { onText: () => undefined })).text, JSON.stringify(headers)).toBe("hi");
    }
    // A keep-alive comment first, in pieces that cut its words.
    const pieces = [": keep", "-alive\n\n", ...openAiEvents];
    expect((await openAi((async () => new Response(body(pieces), { headers: { "Content-Type": "application/octet-stream" } })) as typeof globalThis.fetch).send(request, { onText: () => undefined })).text).toBe("hi");
    // Blank lines first, short of 64 KB.
    expect((await openAi((async () => new Response(body(["\n".repeat(32_768), ...openAiEvents]), { headers: { "Content-Type": "application/octet-stream" } })) as typeof globalThis.fetch).send(request, { onText: () => undefined })).text).toBe("hi");
    // Spaces, or a byte order mark, before the first event: an event parser would read
    // "  data: ..." as a field named "  data" and drop the first event.
    for (const start of ["   ", "\t \r\n  ", "﻿", "﻿  "]) {
      const spaced = openAi((async () => new Response(body([start, ...sse([chunk({ content: "first " }), chunk({ content: "second" }), chunk({}, "stop"), "[DONE]"])]), { headers: { "Content-Type": "application/octet-stream" } })) as typeof globalThis.fetch);
      expect((await spaced.send(request, { onText: () => undefined })).text, JSON.stringify(start)).toBe("first second");
    }
  });

  it("tells a body that starts with white space alone for what it is after 64 KB, without reading on to its end", async () => {
    // Pieces of 1 KB of blank lines, a megabyte of them, and then the body stays open.
    let pulled = 0;
    const blank = encoder.encode("\n".repeat(1_024));
    const open = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ < 1_024) controller.enqueue(blank);
        else return new Promise<void>(() => undefined);
      },
    }, { highWaterMark: 0 });
    const told = await settles(streamedReply(new Response(open, { headers: { "Content-Type": "application/octet-stream" } }), { pulse: () => undefined, signal: undefined }));
    expect(told.events).toBe(false);
    expect(pulled).toBeLessThan(70);
    // What comes after so much white space is read as JSON, which events are not.
    const late = openAi((async () => new Response(body(["\n".repeat(70_000), ...sse([chunk({ content: "hi" }), chunk({}, "stop"), "[DONE]"])]), { headers: { "Content-Type": "application/octet-stream" } })) as typeof globalThis.fetch);
    await expect(late.send(request, { onText: () => undefined })).rejects.toMatchObject({ status: 200, kind: "invalid", message: "The model's reply could not be read: it was not JSON (application/octet-stream). A proxy or gateway may have answered in its place." });
  });

  it("tells a body by how much white space it starts with, however its pieces are cut", async () => {
    const told = async (pieces: string[]) => (await settles(streamedReply(new Response(body(pieces), { headers: { "Content-Type": "application/octet-stream" } }), { pulse: () => undefined, signal: undefined }))).events;
    const events = "data: {}\n\n";
    // More than 65,536 characters of it: JSON, whether the events come in the same piece or not.
    expect(await told(["\n".repeat(70_000) + events])).toBe(false);
    expect(await told(["\n".repeat(70_000), events])).toBe(false);
    expect(await told(["\n".repeat(60_000), "\n".repeat(10_000) + events])).toBe(false);
    expect(await told(["\n".repeat(70_000) + "dat", "a: {}\n\n"])).toBe(false);
    // 65,536 of them: events, whether the events come in the same piece or not.
    expect(await told(["\n".repeat(65_536) + events])).toBe(true);
    expect(await told(["\n".repeat(65_536), events])).toBe(true);
    // Through an adapter, with the white space and the events in one piece.
    const whole = openAi((async () => new Response(body(["\n".repeat(70_000) + sse([chunk({ content: "hi" }), chunk({}, "stop"), "[DONE]"]).join("")]), { headers: { "Content-Type": "application/octet-stream" } })) as typeof globalThis.fetch);
    await expect(whole.send(request, { onText: () => undefined })).rejects.toMatchObject({ status: 200, kind: "invalid" });
  });

  it("does not send a request again whose stream has an event too long to read", async () => {
    const megabyte = new Uint8Array(1_048_576).fill(0x61);
    /** An event that starts, and goes on past 64,000,000 characters: its pieces are made as they are read. */
    const endless = (start: string) => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) controller.enqueue(encoder.encode(start));
          else if (sent > 66) controller.close();
          else controller.enqueue(megabyte);
          sent++;
        },
      }, { highWaterMark: 0 });
    };
    const cases: Array<[string, (fetch: typeof globalThis.fetch) => ModelAdapter, string, string]> = [
      ["OpenAiRequestError", (fetch) => openAi(fetch), "The model's", "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\""],
      ["AnthropicRequestError", (fetch) => claude(fetch), "Claude's", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\""],
      ["GeminiRequestError", (fetch) => geminiModel(fetch), "Gemini's", "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\""],
    ];
    for (const [name, make, who, start] of cases) {
      const server = counting(() => new Response(endless(start), { headers: { "Content-Type": "text/event-stream" } }));
      await expect(withRetry(() => make(server.fetch).send(request, { onText: () => undefined }), { retry: quick }), name).rejects.toMatchObject({
        name,
        status: 200,
        kind: "invalid",
        message: `${who} reply could not be read: an event of its stream held more than 64,000,000 characters.`,
      });
      expect(server.sent, name).toBe(1);
    }
  });

  it("reads a reply in one piece that came to a request for a stream, whatever its content type", async () => {
    const geminiReply = { candidates: [{ content: { role: "model", parts: [{ text: "In one piece." }] }, finishReason: "STOP" }] };
    for (const make of [(text: string) => new Response(text), (text: string) => new Response(text, { headers: { "Content-Type": "application/json" } })]) {
      expect((await openAi((async () => make(JSON.stringify(reply("In one piece.")))) as typeof globalThis.fetch).send(request, { onText: () => undefined })).text).toBe("In one piece.");
      // Gemini's chunks in a list, as it sends them without alt=sse, or one alone.
      for (const sent of [geminiReply, [geminiReply]]) {
        const shown: string[] = [];
        expect((await geminiModel((async () => make(JSON.stringify(sent))) as typeof globalThis.fetch).send(request, { onText: (delta) => shown.push(delta) })).text).toBe("In one piece.");
        expect(shown).toEqual(["In one piece."]);
      }
    }
  });

  it("tells a page that came with HTTP 200 for what it is, and does not send the request again", async () => {
    const page = () => new Response("<!DOCTYPE html><html><body>Sign in to the proxy</body></html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    const cases: Array<[string, (fetch: typeof globalThis.fetch) => ModelAdapter, string]> = [
      ["OpenAiRequestError", (fetch) => openAi(fetch), "The model's"],
      ["AnthropicRequestError", (fetch) => claude(fetch), "Claude's"],
      ["GeminiRequestError", (fetch) => geminiModel(fetch), "Gemini's"],
    ];
    for (const [name, make, who] of cases) {
      const message = `${who} reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.`;
      for (const streamed of [true, false]) {
        const server = counting(page);
        await expect(withRetry(() => make(server.fetch).send(request, streamed ? { onText: () => undefined } : {}), { retry: quick }), `${name}, streamed ${streamed}`).rejects.toMatchObject({ name, status: 200, kind: "invalid", message });
        expect(server.sent).toBe(1);
      }
      const parts = counting(page);
      await expect(make(parts.fetch).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ name, status: 200, kind: "invalid", message });
    }
    // No content type at all.
    await expect(openAi((async () => new Response(new Blob(["<html></html>"]).stream())) as typeof globalThis.fetch).send(request)).rejects.toMatchObject({ message: "The model's reply could not be read: it was not JSON. A proxy or gateway may have answered in its place." });
  });
});

describe("part reads, since the 0.6 review", () => {
  it("does not tell the model the provider's words when a part read fails: only its kind and status", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)) });
    const failures: Array<[Error, string]> = [
      [new ModelRequestError("Incorrect API key provided: sk-proj-****wxyz.", 401), "The model refused the key or token it was sent (HTTP 401)."],
      [new ModelRequestError("Permission denied on resource '//aiplatform.googleapis.com/projects/acme-prod-123/locations/global'.", 403), "The model refused the key or token it was sent (HTTP 403)."],
      [new ModelRequestError("The model could not be reached (request to https://gw.test/v1?key=AIzaSECRET failed, reason: getaddrinfo ENOTFOUND gw.test).", 0), "The model could not be reached."],
      [new ModelRequestError("Quota exceeded for project acme-prod-123.", 429, { kind: "quota" }), "The model's quota has run out (HTTP 429)."],
      [new ModelRequestError("Gemini's reply could not be read: it was not JSON (text/html).", 200, { kind: "invalid" }), "The model's reply could not be read (HTTP 200)."],
      // The errors of a provider's SDK, in a generate of the app's own: a status, and no kind.
      [Object.assign(new Error("401 Incorrect API key provided: sk-proj-****wxyz."), { status: 401, code: "invalid_api_key" }), "The model refused the key or token it was sent (HTTP 401)."],
      [Object.assign(new Error("429 You exceeded your current quota, please check your plan and billing details."), { status: 429, code: "insufficient_quota" }), "The model's quota has run out (HTTP 429)."],
      [Object.assign(new Error("Upstream acme-gw-7.internal failed."), { status: 502 }), "The model failed on its side (HTTP 502)."],
      // A kind that is not one of the package's is told from the status too.
      [Object.assign(new Error("Upstream acme-gw-7.internal failed."), { status: 503, kind: "constructor" }), "The model failed on its side (HTTP 503)."],
    ];
    for (const [error, reason] of failures) {
      const failing: GenerateText = async () => { throw error; };
      const result = await files.tools([meta], { generate: failing, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
      expect(result).toEqual({ error: `Could not read any part of app.log: ${reason}` });
    }
    // A part that failed among others that were read, and a last step that failed.
    let part = 0;
    const prompts: string[] = [];
    const mixed: GenerateText = async ({ system, prompt }) => {
      prompts.push(prompt);
      if (system.startsWith("You write a complete answer")) throw new ModelRequestError("Upstream acme-gw-7.internal failed.", 503);
      if (++part === 1) throw new ModelRequestError("Upstream acme-gw-7.internal failed.", 503);
      return `Requests handled (L${/lines (\d+)-/.exec(prompt)![1]}).`;
    };
    const result = await files.tools([meta], { generate: mixed, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
    // Since 0.99.13 the part that failed is told after it (LOOP-5).
    expect(result.note).toBe("The last step of this read, which writes one answer from the notes of the parts, failed (The model failed on its side (HTTP 503).). The answer is those notes: answer from them. Incomplete: 1 of the 7 parts could not be read, so this answer misses what they hold. Tell the user it is incomplete.");
    expect(JSON.stringify(result)).not.toContain("acme");
    expect(prompts.join("\n")).not.toContain("acme");
    // A last step that was too large is no part: its words fit any request.
    const notesTooLarge: GenerateText = async ({ system, prompt }) => {
      if (system.startsWith("You write a complete answer")) throw new ModelRequestError("This model's maximum context length is 8192 tokens.", 400);
      return `Requests handled (L${/lines (\d+)-/.exec(prompt)![1]}).`;
    };
    const tooLarge = await files.tools([meta], { generate: notesTooLarge, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
    expect(tooLarge.note).toBe("The last step of this read, which writes one answer from the notes of the parts, failed (The request was larger than the model takes (HTTP 400).). The answer is those notes: answer from them.");
    // An error of a generate that says nothing of its kind does not have its words told either.
    const plain: GenerateText = async () => { throw new Error("quota exceeded"); };
    expect(await files.tools([meta], { generate: plain, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." })).toEqual({ error: "Could not read any part of app.log: The model request failed." });
  });

  it("tells the errors of other HTTP clients, and errors with no status at all, without their words", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)) });
    const secret = "llm-gw.acme-prod-4471.corp.internal/v1?key=AIzaSECRET";
    const failures: Array<[unknown, string]> = [
      // got and http-errors (`statusCode`), axios (`response.status`).
      [Object.assign(new Error(`Permission denied on ${secret}.`), { statusCode: 403 }), "The model refused the key or token it was sent (HTTP 403)."],
      [Object.assign(new Error(`Request failed with status code 503 at ${secret}`), { response: { status: 503, data: secret } }), "The model failed on its side (HTTP 503)."],
      // A connection that failed: node-fetch's FetchError (a code, and no syscall), Node's own
      // error, and undici's "fetch failed" with the code on its cause.
      [Object.assign(new Error(`request to http://${secret} failed, reason: connect ECONNREFUSED 10.20.30.40:80`), { name: "FetchError", type: "system", code: "ECONNREFUSED", errno: "ECONNREFUSED", erroredSysCall: "connect" }), "The model could not be reached."],
      [Object.assign(new Error(`connect ECONNREFUSED 10.20.30.40:443 (${secret})`), { code: "ECONNREFUSED", syscall: "connect" }), "The model could not be reached."],
      [new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${secret}`), { code: "ENOTFOUND", syscall: "getaddrinfo" }) }), "The model could not be reached."],
      // Nothing to tell it by: a plain error, a string, the error of an SDK that put its status in its words.
      [new Error(`The gateway said: ${secret}`), "The model request failed."],
      [`raw: ${secret}`, "The model request failed."],
      [Object.assign(new Error(`[VertexAI.ClientError]: got status: 403 Forbidden. ${secret}`), { name: "ClientError" }), "The model request failed."],
      [Object.assign(new Error(`Failed after 3 attempts. ${secret}`), { name: "AI_RetryError", code: "acme-prod-4471" }), "The model request failed."],
    ];
    for (const [error, reason] of failures) {
      const failing: GenerateText = async () => { throw error; };
      const result = await files.tools([meta], { generate: failing, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
      expect(result, String(error)).toEqual({ error: `Could not read any part of app.log: ${reason}` });
    }
    // The built-in Gemini part reader, whose token could not be renewed during the read: since
    // 0.99.13 a token function that fails on anything but a connection is an "auth" error (ADAPT-3).
    const vertex = gemini(vertexAi({ project: "p", model: "gemini-test", accessToken: () => { throw new Error(`impersonation of sa@acme-prod-4471.iam.gserviceaccount.com failed`); } }), { fetch: (async () => json({})) as typeof globalThis.fetch });
    expect(await files.tools([meta], { generate: vertex.generateText!, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." })).toEqual({ error: "Could not read any part of app.log: The model refused the key or token it was sent." });
    // A part that failed among others that were read, and a last step that failed: the model is
    // told neither in the notes it writes the answer from, nor in the result.
    let part = 0;
    const prompts: string[] = [];
    const mixed: GenerateText = async ({ system, prompt }) => {
      prompts.push(prompt);
      if (system.startsWith("You write a complete answer") || ++part === 1) throw new Error(`The gateway said: ${secret}`);
      return `Requests handled (L${/lines (\d+)-/.exec(prompt)![1]}).`;
    };
    const result = await files.tools([meta], { generate: mixed, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
    // Since 0.99.13 the part that failed is told after it (LOOP-5).
    expect(result.note).toBe("The last step of this read, which writes one answer from the notes of the parts, failed (The model request failed.). The answer is those notes: answer from them. Incomplete: 1 of the 7 parts could not be read, so this answer misses what they hold. Tell the user it is incomplete.");
    expect(result.answer).toContain("[This part could not be read: The model request failed.]");
    expect(JSON.stringify(result)).not.toContain("acme");
    expect(prompts.join("\n")).not.toContain("acme");
  });

  it("still tells a store that could not be read in the store's own words, among parts that were read", async () => {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ requireOwner: false, store, budget: { inlineTokens: 10, mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)) });
    const document = new SearchableDocument((await store.get(meta.id))!);
    const readLines = document.readLines.bind(document);
    let reads = 0;
    Object.assign(document, {
      readLines: async (from: number, to: number) => {
        if (++reads > 1) throw new DocumentStoreError(Object.assign(new Error("EIO: i/o error, read 'D:\\data\\acme-prod-4471\\text'"), { code: "EIO", syscall: "read" }));
        return readLines(from, to);
      },
    });
    const prompts: string[] = [];
    const result = await analyzeWholeDocument({
      document,
      task: "Summarize.",
      generate: async ({ prompt }) => {
        prompts.push(prompt);
        return "Requests handled (L1).";
      },
      budget: resolveBudget({ mapChunkTokens: 3_000 }),
      retry: { retries: 0 },
    });
    expect(result.parts).toBeGreaterThan(1);
    expect(result.failedParts).toBe(result.parts - 1);
    expect(prompts.at(-1)).toContain("[This part could not be read: The document store could not be read (EIO). Try again.]");
    expect(prompts.join("\n")).not.toContain("acme");
  });

  it("still tells a reply with no text to a part reader of the package's in the package's words", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)) });
    const empty = (finish: string) => json({ choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: "" } }] });
    const cases: Array<[GenerateText, string]> = [
      [openAi((async () => empty("content_filter")) as typeof globalThis.fetch).generateText!, "The model returned no text (content_filter)."],
      [claude((async () => json({ content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } })) as typeof globalThis.fetch).generateText!, "The model returned no text (refusal)."],
      [geminiModel((async () => json({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }], usageMetadata: { promptTokenCount: 1 } })) as typeof globalThis.fetch).generateText!, "The model returned no text (SAFETY)."],
      // A prompt that was blocked gives its block reason (since 0.7.1, LLF-030: before, none).
      [geminiModel((async () => json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 1 } })) as typeof globalThis.fetch).generateText!, "The model returned no text (PROHIBITED_CONTENT)."],
      // A gateway may put any words in its reason: only a plain word is told.
      [openAi((async () => empty("blocked by the policy of acme-prod-4471")) as typeof globalThis.fetch).generateText!, "The model returned no text."],
      // The same words from a generate of the app's own are not the package's, and are not told.
      [async () => { throw new Error("The model returned no text (acme-prod-4471)."); }, "The model request failed."],
    ];
    for (const [generate, reason] of cases) {
      const result = await files.tools([meta], { generate, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
      expect(result, reason).toEqual({ error: `Could not read any part of app.log: ${reason}` });
    }
    // A last step with no text: the notes are the answer, and the note says why.
    const server = counting((_sent, sent) => (JSON.stringify(sent).includes("You write a complete answer") ? empty("content_filter") : json(reply("Requests handled (L1)."))));
    const result = await files.tools([meta], { generate: openAi(server.fetch).generateText!, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
    expect(result.note).toBe("The last step of this read, which writes one answer from the notes of the parts, failed (The model returned no text (content_filter).). The answer is those notes: answer from them.");
  });

  it("tells a timeout as one, takes no other code or number for a connection or a status, and tells an error that throws when read", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(300)) });
    const secret = "llm-gw.acme-prod-4471.corp.internal";
    const failures: Array<[unknown, string]> = [
      // An `AbortSignal.timeout` of the app's, and undici's wait for the headers.
      [new DOMException(`The operation was aborted due to timeout (${secret})`, "TimeoutError"), "The model took too long to answer."],
      [new TypeError("fetch failed", { cause: Object.assign(new Error(`Headers Timeout Error (${secret})`), { code: "UND_ERR_HEADERS_TIMEOUT" }) }), "The model took too long to answer."],
      [new TypeError("fetch failed", { cause: Object.assign(new Error(`other side closed (${secret})`), { code: "UND_ERR_SOCKET" }) }), "The model could not be reached."],
      // An error of undici's that is no failed connection.
      [Object.assign(new Error(`invalid onError method (${secret})`), { code: "UND_ERR_INVALID_ARG" }), "The model request failed."],
      // Numbers that are no HTTP status.
      [Object.assign(new Error(secret), { status: -1 }), "The model request failed."],
      [Object.assign(new Error(secret), { statusCode: 999 }), "The model request failed."],
      [Object.assign(new Error(secret), { status: 302.5, statusCode: 503 }), "The model failed on its side (HTTP 503)."],
      // A field that throws when it is read.
      [Object.defineProperty(new Error(secret), "statusCode", { get() { throw new Error(`getter of ${secret}`); } }), "The model request failed."],
    ];
    for (const [error, reason] of failures) {
      const failing: GenerateText = async () => { throw error; };
      const result = await files.tools([meta], { generate: failing, retry: { retries: 0 } }).execute("analyze_whole_document", { document_id: meta.id, task: "Summarize." });
      expect(result, reason).toEqual({ error: `Could not read any part of app.log: ${reason}` });
    }
  });

  it("keeps the words of a provider's refusal out of the steps of a question too", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    let turn = 0;
    const server = counting((_sent, sent) => {
      if (!sent.tools) return json({ error: { message: "Incorrect API key provided: sk-proj-****wxyz.", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
      if (++turn === 1) return json({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "analyze_whole_document", arguments: JSON.stringify({ document_id: meta.id, task: "Summarize." }) } }] } }] });
      return json(reply("It could not be read."));
    });
    const steps: string[] = [];
    await askWithFiles({ files, model: openAi(server.fetch, { apiKey: "k" }), documentIds: [meta.id], messages: question("Summarize."), onStep: (line) => steps.push(line), retry: quick });
    expect(steps).toEqual(["Read all of app.log for “Summarize.” — failed: Could not read any part of app.log: The model refused the key or token it was sent (HTTP 401)."]);
    const toolMessage = (server.bodies.filter((sent) => sent.tools).at(-1)!.messages as Json[]).find((message) => message.role === "tool")!;
    expect(toolMessage.content).not.toContain("wxyz");
  });

  it("sends Gemini part reads no temperature", async () => {
    const server = counting(() => json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "notes" }] } }] }));
    await geminiModel(server.fetch).generateText!({ system: "s", prompt: "p", maxOutputTokens: 4_096 });
    await createGeminiGenerateText({ url: "https://g.test/v1/models/m:generateContent", headers: {}, fetchImpl: server.fetch })({ system: "s", prompt: "p", maxOutputTokens: 1_000 });
    expect(server.bodies.map((sent) => sent.generationConfig)).toEqual([{ maxOutputTokens: 4_096 }, { maxOutputTokens: 1_000 }]);
    // An analysisConfig of the app is sent as it is, as before.
    await geminiModel(server.fetch, { analysisConfig: (maxOutputTokens: number) => ({ maxOutputTokens, temperature: 0.2 }) }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 4_096 });
    expect(server.bodies.at(-1)!.generationConfig).toEqual({ maxOutputTokens: 4_096, temperature: 0.2 });
  });

  it("asks Claude again with the larger limit when it thought most of the limit away and wrote a little", async () => {
    const notes = "- 10:02 timeout at (L250)\n- 10:03 retry";
    const partRead = (model: string, content: Json[]) => {
      const server = counting((_sent, sent) => json({ content, stop_reason: "max_tokens", usage: { input_tokens: 20_000, output_tokens: sent.max_tokens } }));
      return { server, read: claude(server.fetch, { model }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 4_096 }) };
    };
    const thought = partRead("claude-thought-most", [{ type: "thinking", thinking: "x".repeat(15_000), signature: "s" }, { type: "text", text: notes }]);
    expect(await thought.read).toBe(notes);
    expect(thought.server.bodies.map((sent) => sent.max_tokens)).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    // Notes that took most of the limit themselves are cut, not starved: not asked again.
    const long = "- a line of notes on the part (L1)\n".repeat(500);
    for (const [model, content] of [["claude-wrote-most", [{ type: "thinking", thinking: "short", signature: "s" }, { type: "text", text: long }]], ["claude-no-thinking", [{ type: "text", text: notes }]]] as Array<[string, Json[]]>) {
      const read = partRead(model, content);
      await read.read;
      expect(read.server.bodies.map((sent) => sent.max_tokens), model).toEqual([4_096]);
    }
  });
});
