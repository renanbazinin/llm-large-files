// What the loop and the adapters do when a model goes silent, refuses a request as too large,
// sends an empty or broken turn, or is asked the same thing twice: the fixes taken from other
// agent harnesses after the 0.5.0 review.
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  classifyModelError,
  createLargeFiles,
  errorKindOf,
  FINAL_ANSWER_WITHOUT_TOOLS,
  MemoryDocumentStore,
  ModelRequestError,
  partialResultOf,
  withRetry,
  type GenerateText,
  type ModelMessage,
  type ModelToolRound,
  type RetryOptions,
  type ToolResult,
} from "llm-large-files";
import { gemini, geminiApi, GeminiRequestError } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { anthropic } from "llm-large-files/anthropic";
import { calls, fakeModel, httpError, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");
const answersOf = (messages: ModelMessage[]) => roundsOf(messages).flatMap((round) => round.answers.map((answer) => answer.result));
const textOf = (message: ModelMessage | undefined) => (message && message.role !== "tools" ? message.parts.map((part) => part.text ?? "").join("\n") : "");
const quick = (): RetryOptions => ({ random: () => 1, sleep: async () => undefined });

async function largeLog(lines = 5_000, budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(lines)) });
  return { files, meta };
}

/** A fetch that never answers: it ends only when its signal aborts, with the signal's reason. */
const hangingFetch = (sent: string[] = []) => (async (url: string | URL | Request, init?: RequestInit) => {
  sent.push(String(url));
  return new Promise<Response>((_, reject) => {
    // As fetch does: a signal that is aborted already ends the request at once.
    if (init?.signal?.aborted) reject(init.signal.reason);
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
}) as typeof globalThis.fetch;

/** A body that sends `pieces` one at a time, `everyMs` apart. */
function slowBody(pieces: string[], everyMs: number, contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      if (index < pieces.length) controller.enqueue(encoder.encode(pieces[index++]!));
      else controller.close();
    },
  }), { status: 200, headers: { "Content-Type": contentType } });
}

const sse = (events: unknown[], done = false) => new Response(
  `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`,
  { status: 200, headers: { "Content-Type": "text/event-stream" } },
);

describe("the kind of a model error", () => {
  it("tells a request larger than the model takes from every provider's wording, with the numbers it gives", () => {
    const cases: Array<[number, string, Partial<ReturnType<typeof classifyModelError>>, Record<string, unknown>?]> = [
      [400, "The input token count (1251225) exceeds the maximum number of tokens allowed (1048576).", { limitTokens: 1_048_576, requestedTokens: 1_251_225 }],
      // Vertex AI's own words, as it answered a request of 1.78M tokens to gemini-3.1-flash-lite (November 2026).
      [400, "The input token count exceeds the maximum number of tokens allowed 1048576.", { limitTokens: 1_048_576 }],
      [400, "Unable to submit request because the input token count is 1251225 but model only supports up to 1048576. Reduce the input token count and try again.", { limitTokens: 1_048_576, requestedTokens: 1_251_225 }],
      [400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens (including 1204 in the functions). Please reduce the length of the messages or functions.", { limitTokens: 128_000, requestedTokens: 130_512 }],
      [400, "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (35000 in the messages, 5000 in the completion).", { limitTokens: 32_768, requestedTokens: 35_000 }],
      [400, "prompt is too long: 210417 tokens > 200000 maximum", { limitTokens: 200_000, requestedTokens: 210_417 }],
      [400, "Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length", { limitTokens: 32_768, requestedTokens: 40_000 }],
      [400, "the request exceeds the available context size, try increasing it", {}],
      [413, "Request entity too large", {}],
      [400, "Something about the prompt", {}, { code: "context_length_exceeded" }],
    ];
    for (const [status, message, numbers, signals] of cases) {
      expect(classifyModelError(status, message, signals), message).toEqual({ kind: "context_overflow", ...numbers });
    }
  });

  it("does not take throttling or other refusals for an overflow, and tells a quota only from what the provider marks", () => {
    // Larger than a whole minute allows: only a smaller request can pass (since 0.6.0; it was "rate_limit").
    expect(classifyModelError(429, "Request too large for gpt-4o in organization org-1 on tokens per min (TPM): Limit 30000, Requested 50000.")).toEqual({ kind: "context_overflow", limitTokens: 30_000, requestedTokens: 50_000 });
    expect(classifyModelError(429, "Rate limit reached for gpt-4o in organization org-1 on tokens per min (TPM): Limit 30000, Used 28000, Requested 5000. Please try again in 6s.").kind).toBe("rate_limit");
    // Vertex AI's answer to an output limit it does not take (November 2026): the request is wrong, not too large.
    expect(classifyModelError(400, "Unable to submit request because it has a maxOutputTokens value of 5000000 but the maximum supported value is 1048576. Update the value and try again.", { code: "INVALID_ARGUMENT" }).kind).toBe("invalid");
    expect(classifyModelError(400, "Too many tokens, please wait before trying again.").kind).toBe("invalid");
    expect(classifyModelError(429, "You exceeded your current quota, please check your plan and billing details.", { code: "insufficient_quota" }).kind).toBe("quota");
    // Gemini says "quota" of a limit per minute too: a wait mends that one.
    const quotaFailure = (quotaId: string) => [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId }] }];
    expect(classifyModelError(429, "You exceeded your current quota.", { code: "RESOURCE_EXHAUSTED", details: quotaFailure("GenerateRequestsPerMinutePerProjectPerModel-FreeTier") }).kind).toBe("rate_limit");
    expect(classifyModelError(429, "You exceeded your current quota.", { code: "RESOURCE_EXHAUSTED", details: quotaFailure("GenerateRequestsPerDayPerProjectPerModel-FreeTier") }).kind).toBe("quota");
    expect(classifyModelError(400, "API key not valid. Please pass a valid API key.", { details: [{ reason: "API_KEY_INVALID" }] }).kind).toBe("auth");
    expect(classifyModelError(401, "Unauthorized").kind).toBe("auth");
    expect(classifyModelError(404, "models/gemini-x is not found").kind).toBe("invalid");
    expect(classifyModelError(503, "The model is overloaded.").kind).toBe("server");
    expect(classifyModelError(0, "fetch failed").kind).toBe("unreachable");
    expect(new ModelRequestError("x", 0, { kind: "timeout" }).kind).toBe("timeout");
    expect(errorKindOf(new Error("plain"))).toBeUndefined();
  });

  it("is read from a Gemini error body: its status and details", async () => {
    const body = { error: { code: 429, message: "You exceeded your current quota.", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }] } };
    const model = gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: (async () => Response.json(body, { status: 429 })) as typeof globalThis.fetch });
    const failure = await model.send({ system: "", messages: [{ role: "user", parts: [{ text: "?" }] }] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GeminiRequestError);
    expect(failure).toMatchObject({ status: 429, kind: "quota" });
  });
});

describe("sending again", () => {
  it("does not send again after a quota error, and sends again only once after a silence", async () => {
    let runs = 0;
    await expect(withRetry(async () => {
      runs++;
      throw new ModelRequestError("no credit", 429, { code: "insufficient_quota" });
    }, { retry: quick() })).rejects.toMatchObject({ kind: "quota" });
    expect(runs).toBe(1);

    runs = 0;
    await expect(withRetry(async () => {
      runs++;
      throw new ModelRequestError("silent", 0, { kind: "timeout" });
    }, { retry: quick() })).rejects.toMatchObject({ kind: "timeout" });
    expect(runs).toBe(2);

    // A silence and then another failure: the other failure is retried by its own rule.
    runs = 0;
    const result = await withRetry(async () => {
      runs++;
      if (runs === 1) throw new ModelRequestError("silent", 0, { kind: "timeout" });
      if (runs === 2) throw new ModelRequestError("busy", 503);
      return "ok";
    }, { retry: quick() });
    expect({ result, runs }).toEqual({ result: "ok", runs: 3 });
  });

  // An adapter's error without a kind of its own was sent again by its status alone, while its
  // events and errorInfoOf called it a quota (or a request too large), not to be retried.
  it("reads the kind of an error without one from its status and code, as its events do", async () => {
    const sentAgain = async (error: unknown) => {
      let runs = 0;
      await withRetry(async () => {
        runs++;
        throw error;
      }, { retry: quick() }).catch(() => undefined);
      return runs;
    };
    expect(await sentAgain(Object.assign(httpError(429, "Too many."), { code: "insufficient_quota" }))).toBe(1);
    expect(await sentAgain(httpError(429, "Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 45237."))).toBe(1);
    expect(await sentAgain(httpError(429, "Too many."))).toBe(4);
    // Thrown plain data is not an adapter's error: it has no kind, and is sent again by its status.
    expect(await sentAgain({ status: 429, code: "insufficient_quota", message: "Too many." })).toBe(4);
  });
});

describe("a model that goes silent (firstByteTimeoutMs, idleTimeoutMs)", () => {
  const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
  const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "?" }] }] };

  it("aborts a Gemini request that gets nothing back for the whole wait, as a timeout, not as the caller's stop", async () => {
    const sent: string[] = [];
    const model = gemini(endpoint, { fetch: hangingFetch(sent), firstByteTimeoutMs: 30 });
    const failure = await model.send(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GeminiRequestError);
    expect(failure).toMatchObject({ status: 0, kind: "timeout", message: "Gemini sent nothing for 0 s." });

    // The caller's own stop is reported as it is.
    const stop = new AbortController();
    const stopped = model.send(request, { signal: stop.signal }).catch((error: unknown) => error);
    stop.abort(new Error("stopped by the user"));
    expect(await stopped).toMatchObject({ message: "stopped by the user" });
  });

  it("does not cut off a streamed reply that keeps arriving, however long it takes in all", async () => {
    const chunk = (text: string, finish?: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(finish ? { finishReason: finish } : {}) }] })}\n\n`;
    const pieces = ["one ", "two ", "three ", "four ", "five ", "six"].map((text, index, all) => chunk(text, index === all.length - 1 ? "STOP" : undefined));
    // Six pieces 25 ms apart: 150 ms in all, against a wait of 80 ms between pieces.
    const model = gemini(endpoint, { fetch: (async () => slowBody(pieces, 25)) as typeof globalThis.fetch, idleTimeoutMs: 80 });
    const reply = await model.send(request, { onText: () => undefined });
    expect(reply.text).toBe("one two three four five six");
  });

  it("counts the keep-alive lines of a body that is not streamed (DeepSeek sends blank lines while a request waits)", async () => {
    const body = JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done waiting." } }] });
    const model = openAiCompatible({ model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.test/v1", apiKey: "k", idleTimeoutMs: 80, fetch: (async () => slowBody(["\n", "\n", "\n", "\n", body], 30, "application/json")) as typeof globalThis.fetch });
    const reply = await model.send(request);
    expect(reply.text).toBe("Done waiting.");
  });

  it("is sent again once in the loop, then reported with what the question had", async () => {
    const { files, meta } = await largeLog();
    const sent: string[] = [];
    const model = gemini(endpoint, { fetch: hangingFetch(sent), firstByteTimeoutMs: 20 });
    const activity: string[] = [];
    const failure = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), onActivity: (line) => activity.push(line) }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "timeout" });
    expect(sent).toHaveLength(2);
    expect(activity).toContain("The model sent nothing for too long. Trying again…");
    expect(partialResultOf(failure)).toMatchObject({ answered: false, turns: 1, toolTurns: [] });
  });

  it("applies to the OpenAI-compatible and Claude adapters too", async () => {
    const openAi = openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", fetch: hangingFetch(), firstByteTimeoutMs: 20 });
    await expect(openAi.send(request)).rejects.toMatchObject({ status: 0, kind: "timeout" });
    const claude = anthropic({ model: "claude-test", apiKey: "k", fetch: hangingFetch(), firstByteTimeoutMs: 20 });
    await expect(claude.send(request)).rejects.toMatchObject({ status: 0, kind: "timeout" });
  });
});

describe("a stream that ends before its end", () => {
  const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "?" }] }] };

  it("is not taken for a whole Gemini reply, and is sent again when none of it was shown", async () => {
    const { files, meta } = await largeLog();
    let number = 0;
    const fetch = (async () => {
      number++;
      // The first stream closes after a call, with no chunk that says why it ended.
      if (number === 1) return sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } } }] } }] }]);
      if (number === 2) return sse([{ candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } } }] } }] }]);
      return sse([{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "51 errors." }] } }] }]);
    }) as typeof globalThis.fetch;
    const model = gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), retry: quick(), onText: () => undefined });
    expect(number).toBe(3);
    expect(result).toMatchObject({ text: "51 errors.", answered: true });
    expect(result.steps).toEqual(["Search app.log (exact) for “ERROR” — 51 matching lines"]);
  });

  it("on an OpenAI-compatible stream: no finish_reason and no [DONE] is cut off; [DONE] alone is enough", async () => {
    const chunk = (content: string, finish?: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }] });
    const replies = [sse([chunk("Half an ans")]), sse([chunk("A whole answer.")], true)];
    const model = openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", fetch: (async () => replies.shift()!) as typeof globalThis.fetch });
    await expect(model.send(request, { onText: () => undefined })).rejects.toMatchObject({ status: 0, message: "The model's reply ended before it was complete." });
    expect((await model.send(request, { onText: () => undefined })).text).toBe("A whole answer.");
  });

  it("DeepSeek's insufficient_system_resource is the server's failure, sent again", async () => {
    let number = 0;
    const fetch = (async () => {
      number++;
      return Response.json({ choices: [{ index: 0, finish_reason: number === 1 ? "insufficient_system_resource" : "stop", message: { role: "assistant", content: number === 1 ? "Par" : "Whole." } }] });
    }) as typeof globalThis.fetch;
    const model = openAiCompatible({ model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.test/v1", fetch });
    await expect(model.send(request)).rejects.toMatchObject({ status: 503, kind: "server" });
    expect(await withRetry(() => model.send(request), { retry: quick() })).toMatchObject({ text: "Whole.", finish: "complete" });
  });
});

describe("a request larger than the model takes", () => {
  it("shortens older tool results and sends it again, and remembers that the model counts more", async () => {
    const { files, meta } = await largeLog();
    const read = (from: number) => ({ name: "read_document", args: { document_id: meta.id, start_line: from, end_line: from + 199 } });
    let refused = 0;
    const model = fakeModel([
      calls([read(1)]),
      calls([read(1_001)]),
      // The third request is refused as too large: the window is smaller than the budget assumed.
      (request) => {
        if (refused === 0 && roundsOf(request.messages).every((round) => round.answers.every((answer) => answer.result.dropped !== true))) {
          refused++;
          return new ModelRequestError("The input token count (130000) exceeds the maximum number of tokens allowed (100000).", 400);
        }
        return says("Both ranges are INFO lines (app.log L1-L200, L1001-L1200).");
      },
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick() });
    expect(refused).toBe(1);
    expect(result).toMatchObject({ answered: true, text: "Both ranges are INFO lines (app.log L1-L200, L1001-L1200)." });
    expect(result.steps).toContain("The request was larger than the model takes: older tool results were shortened, and it was sent again");
    // The request sent again holds stand-ins for the reads, which say which lines they showed.
    const resent = answersOf(model.requests.at(-1)!.messages);
    expect(resent.every((answer) => answer.dropped === true)).toBe(true);
    expect(resent.map((answer) => answer.lines)).toEqual(["1-200", "1001-1200"]);
  });

  it("plans the documents again for a smaller window when the very first request is too large", async () => {
    // 600 lines fit the budget whole, but not the model's real window.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 200_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(600)) });
    const steps: string[] = [];
    const model = fakeModel([(request) => {
      const whole = /^--- Attached file \[mark [0-9a-f]{8}\]: "app\.log"/.test(textOf(request.messages[0]));
      return whole
        ? new ModelRequestError("This model's maximum context length is 8192 tokens. However, your messages resulted in 21000 tokens.", 400)
        : says("Answered from the card.");
    }]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onStep: (line) => steps.push(line) });
    expect(model.requests).toHaveLength(2);
    expect(textOf(model.requests[1]!.messages[0])).toContain("--- Large attached file: app.log");
    expect(result.plan.searchable.map((document) => document.id)).toEqual([meta.id]);
    expect(result.steps[0]).toBe("The first request was larger than the model's window of 8,192 tokens: the files were planned again to fit it");
    expect(steps[0]).toBe(result.steps[0]);
    expect(result).toMatchObject({ answered: true, turns: 2 });
    // Planned for the window the provider named: the estimate did not count less than it.
    expect(result.budget.contextTokens).toBe(8_192);
  });

  it("reports the provider's overflow when the document is gone, or the store fails, before the second plan", async () => {
    // Since 0.9.0 DocumentsNotFoundError (404) and DocumentStoreError (503) have a status; neither is
    // the model's error, so the first try's overflow is still the one reported, with its partial result.
    for (const failure of ["deleted", "store"] as const) {
      const store = new MemoryDocumentStore();
      const files = createLargeFiles({ store, budget: { contextTokens: 200_000 } });
      const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(600)) });
      const overflow = new ModelRequestError("This model's maximum context length is 8192 tokens. However, your messages resulted in 21000 tokens.", 400);
      const model = fakeModel([async () => {
        if (failure === "deleted") await files.delete(meta.id);
        else store.getMeta = async () => { throw Object.assign(new Error("read failed"), { code: "EIO", syscall: "read" }); };
        return overflow;
      }]);
      const error = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") }).catch((caught: unknown) => caught);
      expect(error, failure).toBe(overflow);
      expect(model.requests, failure).toHaveLength(1);
    }
  });

  it("is reported, with what the question found, for a model whose conversation may only grow", async () => {
    const { files, meta } = await largeLog();
    const usage = { inputTokens: 900, outputTokens: 10 };
    const model = fakeModel([
      calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }], { usage }),
      new ModelRequestError("prompt is too long: 210417 tokens > 200000 maximum", 400),
    ], { appendOnly: true });
    const failure = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick() }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "context_overflow", limitTokens: 200_000, requestedTokens: 210_417 });
    // Sent once: there is nothing it may shorten, and resending the same request would fail the same way.
    expect(model.requests).toHaveLength(2);
    const partial = partialResultOf(failure)!;
    expect(partial).toMatchObject({ answered: false, usage: { requests: 1, inputTokens: 900 } });
    expect(partial.toolTurns[0]!.calls[0]!.result).toMatchObject({ total_matching_lines: 51 });
    expect(partial.evidence[0]).toMatchObject({ documentId: meta.id, query: "ERROR" });
  });

  it("keeps what was found when any request fails after tools ran", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([calls([{ name: "get_document_overview", args: { document_id: meta.id } }]), httpError(401, "token expired")]);
    const failure = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick() }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 401, message: "token expired" });
    expect(partialResultOf(failure)).toMatchObject({ answered: false, steps: ["Overview of app.log"], toolTurns: [{ role: "tools" }] });
    expect(partialResultOf(new Error("another"))).toBeUndefined();
  });

  it("reads a part of a whole-file read that is too large as two halves", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 200_000 });
    const parts: string[] = [];
    const generateText: GenerateText = async ({ prompt }) => {
      const lines = /lines (\d+)-(\d+)\./.exec(prompt);
      if (!lines) return "All errors are timeouts (L97).";
      parts.push(`${lines[1]}-${lines[2]}`);
      // The model's window holds 2,000 lines of this log, not the 2,000 to 3,000 of one part.
      if (Number(lines[2]) - Number(lines[1]) >= 2_000) throw new ModelRequestError("This model's maximum context length is 100000 tokens. However, your messages resulted in 160000 tokens.", 400);
      return `Errors near (L${lines[1]}).`;
    };
    const model = fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } }]), says("Done.")], { generateText });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick() });
    // Two parts, each refused, then each read as two halves. The halves are not halved again.
    expect([...parts].sort()).toEqual(["1-1412", "1-2823", "1413-2823", "2824-3912", "2824-5000", "3913-5000"].sort());
    expect(answersOf(model.requests[1]!.messages)[0]).toMatchObject({ parts_read: 4, parts_with_relevant_content: 4, answer: "All errors are timeouts (L97)." });
  });
});

describe("an empty or broken turn", () => {
  it("is asked for again once, with a note that is not kept, when the model's tool call could not be read", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      says("", { finish: "malformed_call", finishReason: "MALFORMED_FUNCTION_CALL" }),
      calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
      says("51 errors (app.log L97)."),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?") });
    expect(model.requests).toHaveLength(3);
    // The note goes at the end of the question, in the same turn: the start of the request is unchanged.
    expect(model.requests[1]!.messages).toHaveLength(1);
    expect(textOf(model.requests[1]!.messages[0])).toMatch(/How many errors\?\nYour last reply tried to call a tool, but the call could not be read/);
    expect(textOf(model.requests[2]!.messages[0])).not.toContain("could not be read");
    expect(result).toMatchObject({ text: "51 errors (app.log L97).", answered: true });
    expect(result.steps).toEqual(["The model's tool call could not be read: it was asked to send it again", "Search app.log (exact) for “ERROR” — 51 matching lines"]);
  });

  it("is asked for again at most twice in a question, and not for a reply cut off by its output limit", async () => {
    const { files, meta } = await largeLog();
    const broken = says("", { finish: "malformed_call" });
    const search = (query: string) => calls([{ name: "search_document", args: { document_id: meta.id, query, mode: "exact" } }]);
    const model = fakeModel([broken, search("ERROR"), broken, search("WARN"), broken, broken, says("Done.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    expect(result.steps.filter((line) => line.startsWith("The model's tool call could not be read"))).toHaveLength(2);
    // The third broken turn is not asked for again: the answer is asked for instead.
    expect(model.requests.at(-1)!.toolChoice).toBe("none");

    const cut = fakeModel([says("", { finish: "cut", finishReason: "MAX_TOKENS" }), says("From the card.")]);
    await askWithFiles({ files, model: cut, documentIds: [meta.id], messages: question("?") });
    expect(cut.requests.map((request) => request.toolChoice)).toEqual(["auto", "none"]);
    expect(textOf(cut.requests[1]!.messages.at(-1))).toBe(FINAL_ANSWER_WITHOUT_TOOLS);
  });

  it("asks an explorer that replied with nothing to gather, then reply DONE", async () => {
    const { files, meta } = await largeLog();
    const explorer = fakeModel([says(""), calls([{ name: "get_document_overview", args: { document_id: meta.id } }]), says("DONE")], { id: "explorer" });
    const model = fakeModel([says("The log is 5,000 lines.")], { id: "answerer" });
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("How long is the log?") });
    expect(textOf(explorer.requests[1]!.messages.at(-1))).toMatch(/Your last reply was empty\. Call the tools to gather what the answer needs from the files, then reply DONE\.$/);
    expect(result).toMatchObject({ text: "The log is 5,000 lines.", answered: true });
  });

  it("is a part read that the provider's filter stopped: kept, and said to be incomplete", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 40_000 });
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.systemInstruction?.role === "system") {
        return Response.json({ candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "Timeouts at (L97)." }] } }] });
      }
      return Response.json(body.tools && !body.contents.some((content: { parts: Array<Record<string, unknown>> }) => content.parts.some((part) => part.functionResponse))
        ? { candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } } }] } }] }
        : { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Done." }] } }] });
    }) as typeof globalThis.fetch;
    const sent: Array<Record<string, unknown>> = [];
    const model = gemini(endpoint, { fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return fetch(url, init);
    }) as typeof globalThis.fetch });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    const responses = sent.flatMap((body) => (body.contents as Array<{ parts: Array<Record<string, any>> }>).flatMap((content) => content.parts)).filter((part) => part.functionResponse);
    expect(responses.at(-1)!.functionResponse.response).toMatchObject({ notes_cut_short: expect.any(Number) });
  });
});

describe("a call that was answered already (no second run, no second result in the request)", () => {
  const search = (id: string, query: string, more: Record<string, unknown> = {}) => ({ name: "search_document", args: { document_id: id, query, mode: "exact", ...more } });

  it("is answered with a pointer to the result that is still shown, in a later turn and in the same turn", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([search(meta.id, "ERROR"), search(meta.id, "ERROR", { max_results: 20, case_sensitive: false })]),
      calls([search(meta.id, "ERROR")]),
      says("51 errors."),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    const [first, twin, again] = answersOf(model.requests[2]!.messages);
    expect(first).toMatchObject({ total_matching_lines: 51 });
    expect(twin).toEqual({ already_shown: true, note: "Not run: call 1 of this turn is the same call, and its result is next to this one. Use it.", tool_turns_left: 10 });
    expect(again).toMatchObject({ document: "app.log", already_shown: true, note: expect.stringMatching(/^Not run: this exact call was answered earlier/) });
    expect(result.steps).toEqual([
      "Search app.log (exact) for “ERROR” — 51 matching lines",
      "Search app.log (exact) for “ERROR” — already shown above",
      "Search app.log (exact) for “ERROR” — already shown above",
    ]);
    // Evidence is recorded once, for the call that ran.
    expect(result.evidence).toHaveLength(1);
  });

  it("points a read of lines inside one shown in full to it, and runs a read that goes beyond it", async () => {
    const { files, meta } = await largeLog();
    const read = (from: number, to: number) => ({ name: "read_document", args: { document_id: meta.id, start_line: from, end_line: to } });
    const model = fakeModel([calls([read(100, 299)]), calls([read(150, 200), read(250, 350)]), says("Done.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    const [, inside, beyond] = answersOf(model.requests[2]!.messages);
    expect(inside).toMatchObject({ lines: "150-200", already_shown: true, note: expect.stringMatching(/^Not run: lines 150-200 are already shown above in full, in the result that has lines 100-299/) });
    expect(beyond).toMatchObject({ lines: "250-350", total_lines: 5_000 });
    expect(beyond!.already_shown).toBeUndefined();
  });

  it("runs the call again when the earlier result was cut to its room, replaced by a stand-in, or failed", async () => {
    const { files, meta } = await largeLog();
    const tools = files.tools([meta]);
    const args = search(meta.id, "ERROR").args;
    const full = await tools.execute("search_document", args);
    const stored = (result: ToolResult) => [{ role: "user" as const, text: "Earlier" }, { role: "tools" as const, calls: [{ name: "search_document", args, result }] }, { role: "assistant" as const, text: "Earlier answer." }, { role: "user" as const, text: "And now?" }];
    const run = async (result: ToolResult) => {
      const model = fakeModel([calls([search(meta.id, "ERROR")]), says("Done.")]);
      await askWithFiles({ files, model, documentIds: [meta.id], messages: stored(result) });
      return answersOf(model.requests[1]!.messages).at(-1)!;
    };
    // Shown in full in a round of an earlier question: pointed to.
    expect(await run(full)).toMatchObject({ already_shown: true });
    expect(await run({ ...full, note: "Showing 3 of 20 results to stay within the size limit. Narrow the query or read specific lines." })).toMatchObject({ total_matching_lines: 51 });
    expect(await run({ document: "app.log", dropped: true, note: "dropped" })).toMatchObject({ total_matching_lines: 51 });
    expect(await run({ error: "The scan failed." })).toMatchObject({ total_matching_lines: 51 });
    // As main stored it: the first 20 matches, without the last one and without a note. Run now, it gets the last one.
    const { note: _note, ...older } = full;
    const matches = full.matches as Array<{ line: number }>;
    expect(matches).toHaveLength(21);
    const again = await run({ ...older, matches: matches.slice(0, 20) });
    expect(again).toMatchObject({ total_matching_lines: 51, note: full.note });
    expect((again.matches as Array<{ line: number }>).at(-1)!.line).toBe(matches.at(-1)!.line);
  });

  it("runs a search again whose result main stored, and makes a pointer main made to it a stand-in", async () => {
    const { files, meta } = await largeLog();
    const args = search(meta.id, "ERROR").args;
    const full = await files.tools([meta]).execute("search_document", args);
    const { note: _note, ...older } = full;
    const stored = { ...older, matches: (full.matches as unknown[]).slice(0, 20) };
    const pointer = { document: "app.log", already_shown: true, note: "Not run: this exact call was answered earlier in this conversation, and its result is still shown above in full. The file has not changed, so it would return the same. Use that result. For more, read other lines, or search with other words or another mode." };
    const model = fakeModel([calls([search(meta.id, "ERROR")]), says("Done.")]);
    const result = await askWithFiles({
      files, model, documentIds: [meta.id], messages: [
        { role: "user", text: "Errors?" }, { role: "tools", calls: [{ name: "search_document", args, result: stored }] }, { role: "assistant", text: "51." },
        { role: "user", text: "Again?" }, { role: "tools", calls: [{ name: "search_document", args, result: pointer }] }, { role: "assistant", text: "Same." },
        { role: "user", text: "Which is the last one?" },
      ],
    });
    const [kept, then, now] = answersOf(model.requests[1]!.messages);
    expect(kept).toEqual(stored);
    expect(then).toEqual({ document: "app.log", dropped: true, note: "Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it." });
    expect(now).toMatchObject({ total_matching_lines: 51, matches: full.matches });
    expect(result.steps).toEqual(["Search app.log (exact) for “ERROR” — 51 matching lines"]);
  });

  it("adds a hint to the second search in a row that failed in the same mode", async () => {
    const { files, meta } = await largeLog();
    const regex = (query: string) => ({ name: "search_document", args: { document_id: meta.id, query, mode: "regex" } });
    const model = fakeModel([calls([regex("(a+)+$")]), calls([regex("(b+)+$")]), says("Done.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    const [first, second] = answersOf(model.requests[2]!.messages);
    expect(first!.error).not.toMatch(/Two regex searches/);
    expect(second!.error).toMatch(/Two regex searches in a row failed\. Try mode "exact"/);
  });

  it("names the files the model may use when it sends an ID that is not one of them", async () => {
    const { files, meta } = await largeLog();
    const result = await files.tools([meta]).execute("read_document", { document_id: "doc_nope", start_line: 1 });
    expect(result.error).toBe(`Unknown document_id doc_nope. Use one of: ${meta.id} ("app.log").`);
    // An ID of any length is quoted cut, so that it does not fill the error and the step.
    const long = await files.tools([meta]).execute("read_document", { document_id: `doc_${"a".repeat(200_000)}`, start_line: 1 });
    expect(long.error).toBe(`Unknown document_id doc_${"a".repeat(60)}…. Use one of: ${meta.id} ("app.log").`);
  });
});

describe("the tool guide", () => {
  it("sends counting and listing to exact search, and keeps the whole-file read for what needs meaning", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([says("Done.")], { generateText: async () => "notes" });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    const system = model.requests[0]!.system;
    expect(system).toContain("To count or list what can be matched as text (a word, an ID, an error code, a log level, a pattern), use search_document in exact or regex mode: its total_matching_lines is exact.");
    expect(system).not.toContain("every occurrence");
    const analyze = model.requests[0]!.tools!.find((tool) => tool.name === "analyze_whole_document")!;
    expect(analyze.description).toMatch(/use search_document in exact or regex mode instead/);
  });
});

/** A body whose pieces come after the delays given: `[delay, piece]`, in milliseconds. */
function pacedBody(pieces: Array<[number, string]>, contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (index >= pieces.length) {
        controller.close();
        return;
      }
      const [delay, piece] = pieces[index++]!;
      await new Promise((resolve) => setTimeout(resolve, delay));
      controller.enqueue(encoder.encode(piece));
    },
  }), { status: 200, headers: { "Content-Type": contentType } });
}

/** A response as node-fetch gives it: its body is a Node stream, with no `getReader`. */
function nodeStyleResponse(text: string, contentType: string): Response {
  const body = (async function* () {
    for (let at = 0; at < text.length; at += 40) yield Buffer.from(text.slice(at, at + 40));
  })();
  return { ok: true, status: 200, headers: new Headers({ "Content-Type": contentType }), body, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
}

describe("since the review of these changes", () => {
  const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
  const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "?" }] }] };
  const geminiChunk = (text: string, finish?: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(finish ? { finishReason: finish } : {}) }] })}\n\n`;

  it("waits longer for the first piece of a reply than between pieces: a model that thinks sends nothing, headers or not", async () => {
    // Headers at once, then 150 ms of silence while the model thinks, then pieces 10 ms apart.
    const thinking = gemini(endpoint, { fetch: (async () => pacedBody([[150, geminiChunk("Thought ")], [10, geminiChunk("it over.", "STOP")]])) as typeof globalThis.fetch, firstByteTimeoutMs: 1_000, idleTimeoutMs: 60 });
    expect((await thinking.send(request, { onText: () => undefined })).text).toBe("Thought it over.");
    // Once the reply has started, the shorter wait holds.
    const stalls = gemini(endpoint, { fetch: (async () => pacedBody([[10, geminiChunk("Half ")], [300, geminiChunk("never.", "STOP")]])) as typeof globalThis.fetch, firstByteTimeoutMs: 1_000, idleTimeoutMs: 60 });
    await expect(stalls.send(request, { onText: () => undefined })).rejects.toMatchObject({ status: 0, kind: "timeout" });
  });

  it("reads the body of a fetch that is not the global one (node-fetch: a Node stream with no getReader)", async () => {
    const reply = JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "From a Node stream, in one piece." }] } }] });
    const whole = gemini(endpoint, { fetch: (async () => nodeStyleResponse(reply, "application/json")) as typeof globalThis.fetch });
    expect((await whole.send(request)).text).toBe("From a Node stream, in one piece.");
    const streamed = gemini(endpoint, { fetch: (async () => nodeStyleResponse(geminiChunk("From a Node stream, ") + geminiChunk("streamed.", "STOP"), "text/event-stream")) as typeof globalThis.fetch });
    expect((await streamed.send(request, { onText: () => undefined })).text).toBe("From a Node stream, streamed.");
    const openAi = openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", fetch: (async () => nodeStyleResponse(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OpenAI-compatible too." } }] }), "application/json")) as typeof globalThis.fetch });
    expect((await openAi.send(request)).text).toBe("OpenAI-compatible too.");
  });

  it("does not show a reply in one piece that DeepSeek stopped short, so that it can be sent again", async () => {
    const shown: string[] = [];
    const model = openAiCompatible({ model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.test/v1", stream: false, fetch: (async () => Response.json({ choices: [{ index: 0, finish_reason: "insufficient_system_resource", message: { role: "assistant", content: "Par" } }] })) as typeof globalThis.fetch });
    await expect(model.send(request, { onText: (delta) => shown.push(delta) })).rejects.toMatchObject({ status: 503 });
    expect(shown).toEqual([]);
  });

  it("takes a wait longer than a timer holds for no limit, not for one of a millisecond", async () => {
    const late = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Late, but here." }] } }] });
    }) as typeof globalThis.fetch;
    const model = gemini(endpoint, { fetch: late, firstByteTimeoutMs: 2 ** 31, idleTimeoutMs: 30 * 24 * 3_600_000 });
    expect((await model.send(request)).text).toBe("Late, but here.");
  });

  it("does not count the time a key or token takes to get as the model's silence", async () => {
    const slowKey = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "k";
    };
    const answer = (async () => Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Fine." } }] })) as typeof globalThis.fetch;
    const openAi = openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", apiKey: slowKey, fetch: answer, firstByteTimeoutMs: 40 });
    expect((await openAi.send(request)).text).toBe("Fine.");
    const claudeAnswer = (async () => Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "Fine." }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 1 } })) as typeof globalThis.fetch;
    const claude = anthropic({ model: "claude-test", apiKey: slowKey, fetch: claudeAnswer, firstByteTimeoutMs: 40, stream: false });
    expect((await claude.send(request)).text).toBe("Fine.");
  });

  it("sends a provider's own timeout (HTTP 408) again as often as any failure worth it, not once", async () => {
    let runs = 0;
    await expect(withRetry(async () => {
      runs++;
      throw new ModelRequestError("Request timed out.", 408);
    }, { retry: quick() })).rejects.toMatchObject({ status: 408, kind: "timeout" });
    expect(runs).toBe(4);
  });

  it("tells Claude's older wording of a request larger than its window, with its numbers", () => {
    expect(classifyModelError(400, "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again", { code: "invalid_request_error" }))
      .toEqual({ kind: "context_overflow", limitTokens: 200_000, requestedTokens: 188_240 });
  });

  it("says a Claude part read that stopped because the window was full is incomplete", async () => {
    const claude = anthropic({ model: "claude-test", apiKey: "k", fetch: (async () => Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "Notes: (L1) …" }], stop_reason: "model_context_window_exceeded", usage: { input_tokens: 9, output_tokens: 1 } })) as typeof globalThis.fetch });
    let truncated = false;
    const text = await claude.generateText!({ system: "s", prompt: "p", maxOutputTokens: 4_096, onTruncated: () => { truncated = true; } });
    expect({ text, truncated }).toEqual({ text: "Notes: (L1) …", truncated: true });
  });

  it("makes a pointer whose result was dropped to make room a stand-in that says to call again", async () => {
    const { files, meta } = await largeLog();
    const args = { document_id: meta.id, query: "ERROR", mode: "exact" };
    const stored = [
      { role: "user" as const, text: "Errors?" },
      { role: "tools" as const, calls: [{ name: "search_document", args, result: { document: "app.log", dropped: true, mode: "exact", query: "ERROR", total_matching_lines: 51, note: "dropped" } }] },
      { role: "tools" as const, calls: [{ name: "search_document", args, result: { document: "app.log", already_shown: true, note: "Not run: this exact call was answered earlier in this conversation, and its result is still shown above in full." } }] },
      { role: "assistant" as const, text: "51." },
      { role: "user" as const, text: "And WARN?" },
    ];
    const model = fakeModel([says("Done.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: stored });
    const [first, second] = answersOf(model.requests[0]!.messages);
    expect(first).toMatchObject({ dropped: true, total_matching_lines: 51 });
    expect(second).toEqual({ document: "app.log", dropped: true, note: "Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it." });
  });

  it("does not point to a search that ran out of time: a later question has time of its own", async () => {
    const { files, meta } = await largeLog();
    const args = { document_id: meta.id, query: "ERROR.*ms", mode: "regex" };
    const stored = [
      { role: "user" as const, text: "Errors?" },
      { role: "tools" as const, calls: [{ name: "search_document", args, result: { document: "app.log", mode: "regex", total_matching_lines: 12, note: "The scan stopped early; the total is a lower bound.", matches: [] } }] },
      { role: "assistant" as const, text: "At least 12." },
      { role: "user" as const, text: "Exactly?" },
    ];
    const model = fakeModel([calls([{ name: "search_document", args }]), says("51.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: stored });
    expect(answersOf(model.requests[1]!.messages).at(-1)).toMatchObject({ total_matching_lines: 51 });
  });

  it("counts what the first try paid for when the documents are planned again, and shows its steps", async () => {
    const { files, meta } = await largeLog();
    const explorer = fakeModel([says("DONE", { usage: { inputTokens: 50_000, outputTokens: 2 } })], { id: "explorer" });
    let answers = 0;
    const model = fakeModel([() => (++answers === 1
      ? new ModelRequestError("This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", 400)
      : says("Answered.", { usage: { inputTokens: 6_000, outputTokens: 5 } }))], { id: "answerer" });
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("?") });
    expect(result).toMatchObject({ answered: true, text: "Answered.", turns: 4 });
    expect(result.usage.byModel.explorer).toMatchObject({ requests: 2, inputTokens: 100_000 });
    expect(result.usage).toMatchObject({ requests: 3, inputTokens: 106_000 });
    expect(result.steps[0]).toMatch(/^The first request was larger than the model's window of 8,192 tokens/);
  });

  it("fits the application's budget to the smaller window when it plans again, as for a window the model declares", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 128_000, reservedTokens: 24_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(600)) });
    const model = fakeModel([(request) => (/^--- Attached file \[mark [0-9a-f]{8}\]: "app\.log"/.test(textOf(request.messages[0]))
      ? new ModelRequestError("This model's maximum context length is 32768 tokens. However, your messages resulted in 61000 tokens.", 400)
      : says("Answered from the card."))]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    expect(result).toMatchObject({ answered: true, text: "Answered from the card." });
    expect(result.budget.reservedTokens).toBeLessThan(24_000);
  });

  it("tells an explorer whose call could not be read to reply DONE, not to answer", async () => {
    const { files, meta } = await largeLog();
    const explorer = fakeModel([says("", { finish: "malformed_call" }), says("DONE")], { id: "explorer" });
    const model = fakeModel([says("Answered.")], { id: "answerer" });
    await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("?") });
    expect(textOf(explorer.requests[1]!.messages.at(-1))).toMatch(/or reply DONE if the results above already hold what the answer needs\.$/);
  });

  it("counts a second try against limits.toolTurns: the last request is still the answer's", async () => {
    const { files, meta } = await largeLog();
    const broken = says("", { finish: "malformed_call" });
    const two = fakeModel([broken, says("Answered.")]);
    const result = await askWithFiles({ files, model: two, documentIds: [meta.id], messages: question("?"), limits: { toolTurns: 2 } });
    expect(two.requests.map((sent) => sent.toolChoice)).toEqual(["auto", "none"]);
    expect(result.steps).toEqual([]);
    const three = fakeModel([broken, broken, says("Answered.")]);
    await askWithFiles({ files, model: three, documentIds: [meta.id], messages: question("?"), limits: { toolTurns: 3 } });
    expect(three.requests.map((sent) => sent.toolChoice)).toEqual(["auto", "auto", "none"]);
  });

  it("keeps the note in the conversation of a model whose conversation may only grow", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([says(""), calls([{ name: "get_document_overview", args: { document_id: meta.id } }]), says("Done.")], { appendOnly: true });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    // Claude thought after the note: every later request has it where it was.
    expect(textOf(model.requests[1]!.messages[0])).toMatch(/Your last reply was empty\./);
    expect(textOf(model.requests[2]!.messages[0])).toMatch(/Your last reply was empty\./);
  });

  it("refuses the second of two same calls in a turn the way the first was refused, when the first had no room", async () => {
    const { files, meta } = await largeLog(5_000, { inlineTokens: 500 });
    const read = (from: number) => ({ name: "read_document", args: { document_id: meta.id, start_line: from, end_line: from + 599 } });
    const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    let found = false;
    // The window where the read gets room and the search does not.
    for (let window = 6_000; window <= 40_000 && !found; window += 250) {
      const model = fakeModel([calls([read(1), search, search]), says("Done.")], { contextTokens: window });
      try {
        await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
      } catch {
        continue;
      }
      if (model.requests.length < 2) continue;
      const [first, second, third] = answersOf(model.requests[1]!.messages);
      if (first?.error === undefined && typeof second?.error === "string" && second.error.startsWith("Not run: there is no room left")) {
        found = true;
        expect(third).toMatchObject({ error: second.error });
        expect(third!.already_shown).toBeUndefined();
      }
    }
    expect(found).toBe(true);
  });

  it("reads parts as halves only while the requests the read may make, and maxMapChunks, allow it", async () => {
    const run = async (maxRequests: number | undefined, budget: Record<string, number> = {}) => {
      const { files, meta } = await largeLog(5_000, { mapChunkTokens: 200_000, ...budget });
      const sent: string[] = [];
      const generate: GenerateText = async ({ prompt }) => {
        const lines = /lines (\d+)-(\d+)\./.exec(prompt);
        if (!lines) return "Answer (L97).";
        sent.push(`${lines[1]}-${lines[2]}`);
        if (Number(lines[2]) - Number(lines[1]) >= 2_000) throw new ModelRequestError("This model's maximum context length is 100000 tokens. However, your messages resulted in 160000 tokens.", 400);
        return `Errors near (L${lines[1]}).`;
      };
      const tools = files.tools([meta], { generate, retry: quick() });
      const output = await tools.executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "List the errors." }, maxRequests === undefined ? {} : { maxRequests });
      return { sent, result: output.result };
    };
    // Two parts. A read that may make its parts, a merge and its answer: no part is halved.
    const tight = await run(2 + 2);
    expect(tight.sent).toHaveLength(2);
    expect(tight.result.error).toMatch(/^Could not read any part of app\.log/);
    // One request more: one part is halved.
    const one = await run(2 + 2 + 1);
    expect(one.sent).toHaveLength(4);
    expect(one.result).toMatchObject({ parts_read: 3, parts_that_failed: 1 });
    // maxMapChunks of 2: the parts are as many as it allows, and none is halved.
    expect((await run(undefined, { maxMapChunks: 2 })).sent).toHaveLength(2);
    // No ceiling: both are halved.
    expect((await run(undefined)).sent).toHaveLength(6);
  });

  it("gives a whole-file read the requests the question has left", async () => {
    const { files, meta } = await largeLog(5_000, { mapChunkTokens: 200_000 });
    let asked: number | undefined;
    const model = fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: meta.id, task: "List the errors." } }]), says("Done.")], { generateText: async () => "Notes (L1)." });
    // What the loop passes the tool is seen by wrapping the library's tool set.
    const spy = Object.create(files) as typeof files;
    spy.tools = (documents, options) => {
      const real = files.tools(documents, options);
      const executeWithFiles = real.executeWithFiles.bind(real);
      return { ...real, executeWithFiles: async (name, args, limits) => {
        if (name === "analyze_whole_document") asked = limits?.maxRequests;
        return executeWithFiles(name, args, limits);
      } };
    };
    await askWithFiles({ files: spy, model, documentIds: [meta.id], messages: question("?"), limits: { requests: 40 } });
    // 40, less the request already made, less the answer of the question.
    expect(asked).toBe(40 - 1 - 1);
  });
});

describe("since the second review of these changes", () => {
  const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "?" }] }] };
  const openAiChunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

  it("leaves no read unhandled when the caller stops the question from onText (an unhandled rejection ends a Node server)", async () => {
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", note);
    try {
      // As the global fetch does: the body errors when the request's signal aborts.
      const fetch = (async (_url: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(openAiChunk("Hello")));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } })) as typeof globalThis.fetch;
      const model = openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", fetch });
      const stop = new AbortController();
      const failure = await model.send(request, { signal: stop.signal, onText: () => stop.abort(new Error("client disconnected")) }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: "client disconnected" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", note);
    }
  });

  it("ends a read of a Node stream that the fetch does not end when the wait runs out, instead of hanging", async () => {
    const silentAfterOne = () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: (async function* () {
        yield Buffer.from(openAiChunk("Half"));
        await new Promise(() => undefined);
      })(),
    }) as unknown as Response;
    const model = openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", fetch: (async () => silentAfterOne()) as typeof globalThis.fetch, idleTimeoutMs: 40 });
    const started = Date.now();
    await expect(model.send(request, { onText: () => undefined })).rejects.toMatchObject({ status: 0, kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("shares what limits.requests leaves among the whole-file reads of one turn: together they never pass it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, mapChunkTokens: 40_000 } });
    const first = await files.ingest({ name: "a.log", bytes: utf8(serviceLog(5_000)) });
    const second = await files.ingest({ name: "b.log", bytes: utf8(serviceLog(3_000)) });
    const given: number[] = [];
    const spy = Object.create(files) as typeof files;
    spy.tools = (documents, options) => {
      const real = files.tools(documents, options);
      const executeWithFiles = real.executeWithFiles.bind(real);
      return { ...real, executeWithFiles: async (name, args, limits) => {
        if (name === "analyze_whole_document") given.push(limits?.maxRequests ?? Number.NaN);
        return executeWithFiles(name, args, limits);
      } };
    };
    const whole = (id: string) => ({ name: "analyze_whole_document", args: { document_id: id, task: "List the errors." } });
    const model = fakeModel([calls([whole(first.id), whole(second.id)]), says("Done.")], { generateText: async () => "Notes (L1)." });
    await askWithFiles({ files: spy, model, documentIds: [first.id, second.id], messages: question("?"), limits: { requests: 30 } });
    expect(given).toHaveLength(2);
    // 30, less the request that asked for the reads, less the answer of the question.
    expect(given[0]! + given[1]!).toBeLessThanOrEqual(30 - 1 - 1);
  });

  it("does not send the answering model a note meant for the explorer", async () => {
    const { files, meta } = await largeLog();
    const overview = calls([{ name: "get_document_overview", args: { document_id: meta.id } }]);
    // A Gemini-like explorer and a Claude-like answering model: the note is not kept at all.
    const explorer = fakeModel([says(""), overview, says("DONE")], { id: "explorer" });
    const model = fakeModel([says("The log is 5,000 lines.")], { id: "answerer", appendOnly: true });
    await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("How long is the log?") });
    expect(JSON.stringify(model.requests[0]!.messages)).not.toContain("Your last reply was empty");
    expect(JSON.stringify(explorer.requests[2]!.messages)).not.toContain("Your last reply was empty");
    // An explorer whose conversation may only grow keeps it; the answering model still does not get it.
    const keeps = fakeModel([says(""), overview, says("DONE")], { id: "explorer", appendOnly: true });
    const answers = fakeModel([says("The log is 5,000 lines.")], { id: "answerer" });
    await askWithFiles({ files, model: answers, explorer: keeps, documentIds: [meta.id], messages: question("How long is the log?") });
    expect(JSON.stringify(keeps.requests[2]!.messages)).toContain("Your last reply was empty");
    expect(textOf(answers.requests[0]!.messages[0])).toMatch(/How long is the log\?$/);
    expect(JSON.stringify(answers.requests[0]!.messages)).not.toContain("Your last reply was empty");
  });

  it("goes on counting the tool turns of a first try when it plans the documents again", async () => {
    const { files, meta } = await largeLog();
    // Searches that find nothing: small results, so that room is not what ends the tool turns.
    const search = (query: string) => calls([{ name: "search_document", args: { document_id: meta.id, query, mode: "exact" } }], { usage: { inputTokens: 1_000 } });
    const explorer = fakeModel([says("DONE", { usage: { inputTokens: 1_000 } }), search("no-such-a"), search("no-such-b"), says("DONE")], { id: "explorer" });
    let answers = 0;
    const model = fakeModel([() => (++answers === 1
      ? new ModelRequestError("This model's maximum context length is 60000 tokens.", 400)
      : says("Answered.", { usage: { inputTokens: 1_000 } }))], { id: "answerer" });
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("?"), limits: { toolTurns: 3 } });
    // Three chat requests answered in all, as toolTurns says: the first DONE, one round, the answer.
    expect(result.usage.requests).toBe(3);
    expect(result).toMatchObject({ answered: true, text: "Answered." });
  });

  it("keeps the pointer of a call made twice in a turn whose first failed: that result is still next to it", async () => {
    const { files, meta } = await largeLog();
    const args = { document_id: meta.id, query: "(", mode: "regex" };
    const stored = [
      { role: "user" as const, text: "Errors?" },
      { role: "tools" as const, calls: [
        { name: "search_document", args, result: { error: "Invalid regex: Unterminated group." } },
        { name: "search_document", args, result: { already_shown: true, note: "Not run: call 1 of this turn is the same call, and its result is next to this one. Use it." } },
      ] },
      { role: "assistant" as const, text: "The search failed." },
      { role: "user" as const, text: "Try again." },
    ];
    const model = fakeModel([says("Done.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: stored });
    expect(answersOf(model.requests[0]!.messages)[1]).toMatchObject({ already_shown: true });
  });

  it("checks the pointers of a long history in one pass", async () => {
    const { files, meta } = await largeLog();
    const stored: Array<Record<string, unknown>> = [{ role: "user", text: "Start." }];
    for (let round = 0; round < 1_500; round++) {
      const args = { document_id: meta.id, query: `term-${round}`, mode: "exact" };
      stored.push({ role: "tools", calls: [
        { name: "search_document", args, result: { document: "app.log", mode: "exact", total_matching_lines: 0, matches: [] } },
        { name: "search_document", args, result: { already_shown: true, note: "Not run: this exact call was answered earlier in this conversation." } },
        { name: "read_document", args: { document_id: meta.id, start_line: round + 1, end_line: round + 1 }, result: { document: "app.log", lines: `${round + 1}-${round + 1}`, total_lines: 5_000, text: "x" } },
        { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 1 }, result: { lines: "1-1", already_shown: true, note: "Not run: lines 1-1 are already shown." } },
      ] });
    }
    stored.push({ role: "assistant", text: "Done." }, { role: "user", text: "And now?" });
    const model = fakeModel([says("Done.")]);
    const started = Date.now();
    await askWithFiles({ files, model, documentIds: [meta.id], messages: stored as never });
    expect(Date.now() - started).toBeLessThan(3_000);
    // Every pointer still holds: its result is there.
    expect(answersOf(model.requests[0]!.messages).filter((answer) => answer.dropped === true)).toEqual([]);
  });
});
