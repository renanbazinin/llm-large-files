// The review of 0.99.9, the adapters and the event streams: what the stream reader holds, the
// statuses of errors named by a word, errors in a body of HTTP 200, refusals that come as HTTP 422,
// and a quota named by its type alone.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { classifyModelError, withRetry, type ModelRequest } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { createGeminiGenerateText, parseSseJson } from "llm-large-files/gemini";
import { openAiCompatible, openAiResponses } from "llm-large-files/openai";
import { fakeFetch, sse } from "llm-large-files/testing";
import { streamErrorStatus } from "../src/openai/adapter.js";
import { responsesErrorStatus } from "../src/openai/responses.js";

type Json = Record<string, any>;

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

/**
 * The memory still in use after full collections, a turn of the loop apart: one collection right
 * after heavy work leaves garbage for the next (test/limits-0.8.2.test.ts). The heap and what is
 * kept outside it: Node keeps the characters of a long decoded string there (`external`).
 */
async function memoryKept(): Promise<number> {
  for (let round = 0; round < 4; round++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    collectGarbage();
  }
  const used = process.memoryUsage();
  return used.heapUsed + used.external;
}

const encoder = new TextEncoder();
const request = (text: string, more: Partial<ModelRequest> = {}): ModelRequest => ({ system: "", messages: [{ role: "user", parts: [{ text }] }], ...more });
const quick = { baseDelayMs: 0, sleep: async () => undefined };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A stream that delivers these pieces one read at a time, as a network does. */
function streamOf(pieces: Iterable<string | Uint8Array>): ReadableStream<Uint8Array> {
  const each = pieces[Symbol.iterator]();
  return new ReadableStream({
    pull(controller) {
      const next = each.next();
      if (next.done) controller.close();
      else controller.enqueue(typeof next.value === "string" ? encoder.encode(next.value) : next.value);
    },
  });
}

async function events(pieces: Iterable<string | Uint8Array>, maxEventLength?: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of parseSseJson(streamOf(pieces), maxEventLength === undefined ? {} : { maxEventLength })) out.push(event);
  return out;
}

describe("the white space after `data:` in a stream", () => {
  it("is not counted in the event, however the line is cut into pieces", async () => {
    const spaces = " ".repeat(100);
    // In one piece, and in a hundred: 10,000 spaces before a value of 7 characters, under a limit of 64.
    expect(await events([`data:${spaces.repeat(100)}{"n":1}\n\n`], 64)).toEqual([{ n: 1 }]);
    expect(await events(["data:", ...Array.from({ length: 100 }, () => spaces), "{\"n\":1}\n\n"], 64)).toEqual([{ n: 1 }]);
    expect(await events(["da", `ta: \t${spaces}`, spaces, " {\"n\":", "2}\n\n"], 64)).toEqual([{ n: 2 }]);
    // White space inside the value is the value's, and counts.
    await expect(events(["data: \"", spaces], 64)).rejects.toMatchObject({ name: "SseEventTooLongError" });
  });

  // 48 million spaces after `data:`, a megabyte at a time. The memory still in use after full
  // collections is read before the first of them and after the last, while the line has not ended:
  // a reader that kept the spaces held them all then (96 MiB, as Node keeps them). About 0.5 s in a
  // usual run, 3 s on a busy machine.
  it("is not held: a line of nothing else does not grow in memory", { timeout: 30_000 }, async () => {
    const megabyte = new Uint8Array(1_048_576).fill(0x20);
    const kept: number[] = [];
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Each piece is asked for when the one before it has been read: nothing waits in a queue.
        if (sent === 0) controller.enqueue(encoder.encode("data:"));
        else if (sent <= 48) {
          if (sent === 1) kept.push(await memoryKept());
          controller.enqueue(megabyte);
        } else {
          kept.push(await memoryKept());
          controller.enqueue(encoder.encode("{\"n\":1}\n\n"));
          controller.close();
        }
        sent++;
      },
    }, { highWaterMark: 0 });
    const out: unknown[] = [];
    for await (const event of parseSseJson(body, { maxEventLength: 64 })) out.push(event);
    expect(out).toEqual([{ n: 1 }]);
    expect(kept).toHaveLength(2);
    expect(kept[1]! - kept[0]!).toBeLessThan(8 * 1_048_576);
  });
});

describe("the status of an error named by a word", () => {
  it("is 500 for a word that only names a property every object has", async () => {
    for (const word of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(streamErrorStatus({ type: word }), word).toBe(500);
      expect(streamErrorStatus({ code: word }), word).toBe(500);
      expect(responsesErrorStatus({ type: word }), word).toBe(500);
      expect(responsesErrorStatus({ code: word }), word).toBe(500);
    }
    // The words of the tables are read as before.
    expect(streamErrorStatus({ type: "rate_limit_exceeded" })).toBe(429);
    expect(responsesErrorStatus({ type: "too_many_requests" })).toBe(429);

    // Claude: an error event in a stream that began with 200.
    const failing = (type: string) => anthropic({ model: "claude-test", apiKey: "k", fetch: fakeFetch([sse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "error", error: { type, message: "Something failed." } }])]).fetch }).send(request("?"));
    for (const word of ["constructor", "toString", "__proto__"]) {
      const error = await failing(word).catch((thrown: unknown) => thrown);
      expect(error, word).toMatchObject({ name: "AnthropicRequestError", status: 500, kind: "server", message: "Something failed." });
    }
    await expect(failing("overloaded_error")).rejects.toMatchObject({ status: 529, kind: "server", type: "overloaded_error" });

    // A chat stream of an OpenAI-compatible server.
    const openAi = openAiCompatible({ model: "m", baseUrl: "https://words.example/v1", fetch: fakeFetch([sse([{ error: { type: "constructor", message: "Upstream failed." } }])]).fetch });
    await expect(openAi.send(request("?"), { onText: () => undefined })).rejects.toMatchObject({ name: "OpenAiRequestError", status: 500, kind: "server" });
  });
});

describe("Claude: an error in a body of HTTP 200", () => {
  const overloaded = () => json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const message = (text: string) => json({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 3 } });

  it("is thrown with the status of its type, and sent again, rather than read as an empty reply", async () => {
    // A gateway that answers in one piece, to a request with streaming off and to one that asked for a stream.
    for (const stream of [false, true]) {
      const api = fakeFetch([overloaded(), message("Tuesday.")]);
      const model = anthropic({ model: "claude-test", apiKey: "k", stream, fetch: api.fetch });
      await expect(model.send(request("?")), String(stream)).rejects.toMatchObject({ name: "AnthropicRequestError", status: 529, kind: "server", type: "overloaded_error", message: "Overloaded" });
      // A busy server is asked again.
      const again = fakeFetch([overloaded(), message("Tuesday.")]);
      const reply = await withRetry(() => anthropic({ model: "claude-test", apiKey: "k", stream, fetch: again.fetch }).send(request("?")), { retry: quick });
      expect(reply.text).toBe("Tuesday.");
      expect(again.sent).toHaveLength(2);
    }
    // A request the API refused is not sent again.
    const refused = fakeFetch([json({ type: "error", error: { type: "invalid_request_error", message: "messages: at least one message is required" } })]);
    await expect(withRetry(() => anthropic({ model: "claude-test", apiKey: "k", stream: false, fetch: refused.fetch }).send(request("?")), { retry: quick })).rejects.toMatchObject({ status: 400, kind: "invalid" });
    expect(refused.sent).toHaveLength(1);
  });

  it("is thrown by a part read too", async () => {
    const api = fakeFetch([overloaded()]);
    const model = anthropic({ model: "claude-part-read-200", apiKey: "k", fetch: api.fetch });
    await expect(model.generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ name: "AnthropicRequestError", status: 529, type: "overloaded_error" });
  });
});

describe("an OpenAI-compatible server that refuses a field with HTTP 422", () => {
  /** FastAPI's answer to a field its model of the request does not have. */
  const extra = (field: string) => json({ detail: [{ type: "extra_forbidden", loc: ["body", field], msg: "Extra inputs are not permitted", input: 100 }] }, 422);
  const notes = (text: string) => json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 9, completion_tokens: 3 } });

  it("is sent the other name of the output limit, which is then kept", async () => {
    const server = fakeFetch([extra("max_tokens"), notes("first notes"), notes("second notes")]);
    const model = openAiCompatible({ model: "fastapi-422", baseUrl: "https://fastapi.example/v1", fetch: server.fetch });
    expect(await model.generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("first notes");
    expect(await model.generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("second notes");
    expect(server.sent.map((sent) => Object.keys(sent.body).find((key) => key.startsWith("max_")))).toEqual(["max_tokens", "max_completion_tokens", "max_completion_tokens"]);

    // A message that names the field, with 422.
    const worded = fakeFetch([json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 422), notes("notes")]);
    expect(await openAiCompatible({ model: "worded-422", baseUrl: "https://worded.example/v1", fetch: worded.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("notes");
    expect(worded.sent).toHaveLength(2);
  });

  it("names the field of the problem in `param`, and takes a value that is refused for what it is", async () => {
    // The number is refused, not the name: nothing is sent again.
    const tooLarge = fakeFetch([json({ detail: [{ type: "less_than_equal", loc: ["body", "max_tokens"], msg: "Input should be less than or equal to 64", input: 100 }] }, 422)]);
    await expect(openAiCompatible({ model: "value-422", baseUrl: "https://value.example/v1", fetch: tooLarge.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 }))
      .rejects.toMatchObject({ name: "OpenAiRequestError", status: 422, param: "max_tokens", message: "Input should be less than or equal to 64" });
    expect(tooLarge.sent).toHaveLength(1);
    // A place inside the body, and two problems at once, which name no single field.
    const nested = fakeFetch([json({ detail: [{ type: "string_type", loc: ["body", "messages", 0, "content"], msg: "Input should be a valid string" }] }, 422)]);
    await expect(openAiCompatible({ model: "m", baseUrl: "https://nested.example/v1", fetch: nested.fetch }).send(request("?"))).rejects.toMatchObject({ status: 422, param: "messages.0.content" });
    const two = fakeFetch([json({ detail: [{ loc: ["body", "model"], msg: "Field required" }, { loc: ["body", "messages"], msg: "Field required" }] }, 422)]);
    const error = await openAiCompatible({ model: "m", baseUrl: "https://two.example/v1", fetch: two.fetch }).send(request("?")).catch((thrown: unknown) => thrown) as { param?: string; message: string };
    expect(error.message).toBe("Field required; Field required");
    expect(error.param).toBeUndefined();
  });

  it("is sent a stream without `stream_options`, which is then left out", async () => {
    const chunk = (delta: Json, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    const answer = () => sse([chunk({ content: "Tuesday." }), chunk({}, "stop"), "[DONE]"]);
    const refusals: Array<[string, () => Response]> = [
      ["FastAPI", () => extra("stream_options")],
      ["Azure OpenAI", () => json({ error: { message: "Unrecognized request argument supplied: stream_options", type: "invalid_request_error", param: null, code: null } }, 400)],
      ["a named field", () => json({ error: { message: "Unknown parameter: 'stream_options'.", type: "invalid_request_error", param: "stream_options", code: "unknown_parameter" } }, 400)],
    ];
    for (const [name, refusal] of refusals) {
      const server = fakeFetch([refusal(), answer(), answer()]);
      const model = openAiCompatible({ model: "m", baseUrl: "https://strict.example/v1", fetch: server.fetch });
      expect((await model.send(request("?"), { onText: () => undefined })).text, name).toBe("Tuesday.");
      expect((await model.send(request("?"), { onText: () => undefined })).text, name).toBe("Tuesday.");
      expect(server.sent.map((sent) => [sent.body.stream, "stream_options" in sent.body]), name).toEqual([[true, true], [true, false], [true, false]]);
    }

    // Another refusal is the request's own error, and the next request still asks for the usage.
    const other = fakeFetch([json({ error: { message: "Invalid value for 'model'.", type: "invalid_request_error", param: "model", code: null } }, 400), answer()]);
    const model = openAiCompatible({ model: "m", baseUrl: "https://other.example/v1", fetch: other.fetch });
    await expect(model.send(request("?"), { onText: () => undefined })).rejects.toMatchObject({ status: 400, param: "model" });
    await model.send(request("?"), { onText: () => undefined });
    expect(other.sent.map((sent) => "stream_options" in sent.body)).toEqual([true, true]);

    // A request that fails without the field too: its error is the one reported, and the field is asked for again.
    const both = fakeFetch([extra("stream_options"), json({ error: { message: "The model is overloaded." } }, 503), answer()]);
    const busy = openAiCompatible({ model: "m", baseUrl: "https://busy.example/v1", fetch: both.fetch });
    await expect(busy.send(request("?"), { onText: () => undefined })).rejects.toMatchObject({ status: 503 });
    await busy.send(request("?"), { onText: () => undefined });
    expect(both.sent.map((sent) => "stream_options" in sent.body)).toEqual([true, false, true]);

    // A `stream_options` of the application's own is its to mend: the refusal is reported.
    const own = fakeFetch([extra("stream_options"), answer()]);
    await expect(openAiCompatible({ model: "m", baseUrl: "https://own.example/v1", body: { stream_options: { include_usage: false } }, fetch: own.fetch }).send(request("?"), { onText: () => undefined }))
      .rejects.toMatchObject({ status: 422, param: "stream_options" });
    expect(own.sent).toHaveLength(1);
    expect(own.sent[0]!.body.stream_options).toEqual({ include_usage: false });
  });

  it("is sent a Responses request without `include`", async () => {
    const answer = () => json({ id: "resp_1", status: "completed", model: "m", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 9, output_tokens: 3 } });
    const server = fakeFetch([extra("include"), answer(), answer()]);
    const model = openAiResponses({ model: "m", baseUrl: "https://responses.example/v1", fetch: server.fetch });
    expect((await model.send(request("Hi"))).text).toBe("ok");
    await model.send(request("Hi"));
    expect(server.sent.map((sent) => "include" in sent.body)).toEqual([true, false, false]);
  });
});

describe("a quota named by the type of the error alone", () => {
  // OpenAI's own error of 2023, which servers that copy it still send: `code` is null.
  const spent = { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", param: null, code: null } };

  it("is a quota, and is not sent again", async () => {
    const server = fakeFetch([json(spent, 429)]);
    const model = openAiCompatible({ model: "m", baseUrl: "https://quota.example/v1", fetch: server.fetch });
    await expect(withRetry(() => model.send(request("?")), { retry: quick })).rejects.toMatchObject({ name: "OpenAiRequestError", status: 429, kind: "quota" });
    expect(server.sent).toHaveLength(1);

    // Inside a stream, and in a body of 200.
    const streamed = fakeFetch([sse([spent])]);
    await expect(withRetry(() => openAiCompatible({ model: "m", baseUrl: "https://quota.example/v1", fetch: streamed.fetch }).send(request("?"), { onText: () => undefined }), { retry: quick })).rejects.toMatchObject({ status: 429, kind: "quota" });
    expect(streamed.sent).toHaveLength(1);
    await expect(openAiCompatible({ model: "m", baseUrl: "https://quota.example/v1", fetch: fakeFetch([json(spent)]).fetch }).send(request("?"))).rejects.toMatchObject({ status: 429, kind: "quota" });
    await expect(openAiResponses({ model: "m", baseUrl: "https://quota.example/v1", fetch: fakeFetch([json(spent, 429)]).fetch }).send(request("?"))).rejects.toMatchObject({ status: 429, kind: "quota" });

    // A rate limit a wait mends stays one.
    const limited = fakeFetch([json({ error: { message: "Rate limit reached for requests.", type: "requests", param: null, code: "rate_limit_exceeded" } }, 429)]);
    await expect(openAiCompatible({ model: "m", baseUrl: "https://quota.example/v1", fetch: limited.fetch }).send(request("?"))).rejects.toMatchObject({ status: 429, kind: "rate_limit" });
  });
});

describe("a request too large that the provider names outright", () => {
  it("is one whatever its message says of trying again", () => {
    // HTTP 413, and the provider's own word: the words of throttling in the message do not undo them.
    expect(classifyModelError(413, "Request body too large. Please try again later with a smaller request.").kind).toBe("context_overflow");
    expect(classifyModelError(413, "Payload too large for the rate limit tier of this deployment.").kind).toBe("context_overflow");
    expect(classifyModelError(400, "The request could not be served, please try again later.", { code: "context_length_exceeded" }).kind).toBe("context_overflow");
    expect(classifyModelError(400, "Too many tokens per minute in this request.", { code: "request_too_large" }).kind).toBe("context_overflow");
    // The words of the message alone still do not say it when they are those of throttling too.
    expect(classifyModelError(400, "Too many tokens, please wait before trying again.").kind).toBe("invalid");
    expect(classifyModelError(400, "The input tokens exceed the limit per minute, please try again later.").kind).toBe("invalid");
    // HTTP 429 is waited for, whatever word comes with it.
    expect(classifyModelError(429, "Please try again later.", { code: "context_length_exceeded" }).kind).toBe("rate_limit");
  });
});

describe("Gemini: a part read with no system text", () => {
  it("sends no system instruction, as a chat request does", async () => {
    const reply = () => json({ candidates: [{ content: { role: "model", parts: [{ text: "notes" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } });
    const api = fakeFetch([reply()]);
    const read = createGeminiGenerateText({ url: "https://gemini.example/v1/models/no-system:generateContent", headers: {}, fetchImpl: api.fetch });
    expect(await read({ system: "", prompt: "p", maxOutputTokens: 100 })).toBe("notes");
    expect(await read({ system: "Take notes.", prompt: "p", maxOutputTokens: 100 })).toBe("notes");
    expect("systemInstruction" in api.sent[0]!.body).toBe(false);
    expect(api.sent[1]!.body.systemInstruction).toEqual({ role: "system", parts: [{ text: "Take notes." }] });
  });
});
