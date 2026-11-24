// Gemini's errors that come inside a reply of HTTP 200, or in a body that is a list (LLF-018, 0.10.0):
// an error event of a stream without a numeric code takes its status from its google.rpc name, so a
// busy server is tried again; a list body keeps its message and its details; a part read whose body
// of HTTP 200 holds an error throws it with its status (probes p3 and p6 of the 0.10.0 plan).
import { describe, expect, it } from "vitest";
import { createLargeFiles, errorInfoOf, MemoryDocumentStore, ModelRequestError } from "llm-large-files";
import { askGemini, createGeminiGenerateText, gemini, geminiApi, GeminiRequestError } from "llm-large-files/gemini";
import { fakeFetch, sse, utf8, type FakeReply } from "llm-large-files/testing";

const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "hi" }] }] };

/** What one chat request to `gemini()` threw, streamed. */
async function failure(replies: FakeReply[], stream = true): Promise<GeminiRequestError> {
  try {
    await gemini(endpoint, { fetch: fakeFetch(replies).fetch }).send(request, stream ? { onText: () => undefined } : {});
  } catch (error) {
    expect(error).toBeInstanceOf(GeminiRequestError);
    return error as GeminiRequestError;
  }
  throw new Error("The request did not fail.");
}

const dailyQuota = {
  error: {
    code: 429,
    message: "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model with base model: gemini-3. Please submit a quota increase request.",
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }],
  },
};

describe("Gemini errors inside a reply of HTTP 200, since 0.10.0", () => {
  it("gives an error event of a stream without a code the status of its name", async () => {
    const unavailable = await failure([sse([{ error: { message: "The service is currently unavailable.", status: "UNAVAILABLE" } }])]);
    expect(unavailable).toMatchObject({ status: 503, kind: "server", message: "The service is currently unavailable." });
    expect(errorInfoOf(unavailable).retryable).toBe(true);

    const exhausted = await failure([sse([{ error: { message: "Resource exhausted. Please try again later.", status: "RESOURCE_EXHAUSTED" } }])]);
    expect(exhausted).toMatchObject({ status: 429, kind: "rate_limit" });
    expect(errorInfoOf(exhausted).retryable).toBe(true);

    const deadline = await failure([sse([{ error: { message: "Deadline expired before operation could complete.", status: "DEADLINE_EXCEEDED" } }])]);
    expect(deadline.status).toBe(504);

    // A code wins over the name; a name it does not know, or none, is Gemini's failure.
    expect((await failure([sse([{ error: { code: 503, message: "Busy.", status: "INVALID_ARGUMENT" } }])])).status).toBe(503);
    expect((await failure([sse([{ error: { message: "Something.", status: "A_NAME_OF_LATER" } }])])).status).toBe(500);
    expect((await failure([sse([{ error: { status: "UNAVAILABLE" } }])]))).toMatchObject({ status: 503, message: "Gemini reported an error." });
  });

  it("keeps a daily quota a quota, which is not tried again", async () => {
    const quota = await failure([sse([{ error: { message: dailyQuota.error.message, status: "RESOURCE_EXHAUSTED", details: dailyQuota.error.details } }])]);
    expect(quota).toMatchObject({ status: 429, kind: "quota" });
    expect(errorInfoOf(quota).retryable).toBe(false);
  });

  it("reads an error in a body of HTTP 200 that is not streamed the same way", async () => {
    const error = await failure([Response.json({ error: { message: "The model is overloaded.", status: "UNAVAILABLE" } })], false);
    expect(error).toMatchObject({ status: 503, kind: "server", message: "The model is overloaded." });
  });

  it("sends a question again after an unnamed error in its stream, while no text was shown", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("The code word is heron.\n") });
    const api = fakeFetch([
      sse([{ error: { message: "The service is currently unavailable.", status: "UNAVAILABLE" } }]),
      sse([{ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Heron." }] } }] }]),
    ]);
    const result = await askGemini({ files, endpoint, fetch: api.fetch, documentIds: [meta.id], messages: [{ role: "user", text: "The code word?" }], onText: () => undefined, retry: { sleep: async () => undefined } });
    expect(api.sent).toHaveLength(2);
    expect(result).toMatchObject({ text: "Heron.", answered: true });
  });
});

describe("Gemini error bodies that are a list, since 0.10.0", () => {
  it("keeps the message, the code and the details of the first entry", async () => {
    const quota = await failure([Response.json([dailyQuota], { status: 429 })]);
    expect(quota).toMatchObject({ status: 429, kind: "quota", message: dailyQuota.error.message });

    const overflow = { error: { code: 400, message: "The input token count exceeds the maximum number of tokens allowed 1048576.", status: "INVALID_ARGUMENT" } };
    const tooLarge = await failure([Response.json([overflow], { status: 400 })]);
    expect(tooLarge).toMatchObject({ status: 400, kind: "context_overflow", limitTokens: 1_048_576, message: overflow.error.message });
  });

  it("does the same in a part read", async () => {
    const read = createGeminiGenerateText({ url: "https://gemini.example/v1/models/list-body:generateContent", headers: {}, fetchImpl: fakeFetch([Response.json([dailyQuota], { status: 429 })]).fetch });
    await expect(read({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ status: 429, kind: "quota", message: dailyQuota.error.message });
  });
});

describe("a Gemini part read whose body of HTTP 200 holds an error, since 0.10.0", () => {
  it("throws that error with its status, not a reply with no text", async () => {
    const body = { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } };
    const read = createGeminiGenerateText({ url: "https://gemini.example/v1/models/m-200:generateContent", headers: {}, fetchImpl: fakeFetch([Response.json(body)]).fetch });
    const error = await read({ system: "s", prompt: "p", maxOutputTokens: 100 }).then(() => undefined, (failed: unknown) => failed);
    expect(error).toBeInstanceOf(GeminiRequestError);
    expect(ModelRequestError.is(error)).toBe(true);
    expect(error).toMatchObject({ status: 503, kind: "server", message: body.error.message });

    // Without a code: the status of its name.
    const named = createGeminiGenerateText({ url: "https://gemini.example/v1/models/m-200-named:generateContent", headers: {}, fetchImpl: fakeFetch([Response.json([{ error: { message: "Slow down.", status: "RESOURCE_EXHAUSTED" } }])]).fetch });
    await expect(named({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ status: 429, kind: "rate_limit" });
  });
});

describe("a Gemini part read whose body of HTTP 200 is a list of chunks, since 0.10.0", () => {
  const chunk = (text: string, finishReason?: string, usageMetadata?: Record<string, unknown>) => ({
    candidates: [{ ...(finishReason ? { finishReason } : {}), content: { role: "model", parts: [{ text }] } }],
    ...(usageMetadata ? { usageMetadata } : {}),
  });

  it("reads every chunk: the whole text, the last finish reason and the last usage", async () => {
    // As Gemini gives a reply without `alt=sse`, which a gateway may pass on.
    const body = [chunk("Line one of the notes. ", undefined, { promptTokenCount: 10 }), chunk("Line two. "), chunk("Line three.", "STOP", { promptTokenCount: 10, candidatesTokenCount: 9, thoughtsTokenCount: 4 })];
    const used: unknown[] = [];
    let truncated = false;
    const read = createGeminiGenerateText({ url: "https://gemini.example/v1/models/list-chunks:generateContent", headers: {}, fetchImpl: fakeFetch([Response.json(body)]).fetch });
    const text = await read({ system: "s", prompt: "p", maxOutputTokens: 100, onUsage: (usage) => used.push(usage), onTruncated: () => { truncated = true; } });
    expect(text).toBe("Line one of the notes. Line two. Line three.");
    expect(truncated).toBe(false);
    expect(used).toEqual([expect.objectContaining({ inputTokens: 10, outputTokens: 13 })]);

    // Stopped by a filter in its last chunk: the part says that it is not whole.
    const cut = createGeminiGenerateText({ url: "https://gemini.example/v1/models/list-chunks-cut:generateContent", headers: {}, fetchImpl: fakeFetch([Response.json([chunk("Line one. "), chunk("Line t", "SAFETY")])]).fetch });
    let stopped = false;
    expect(await cut({ system: "s", prompt: "p", maxOutputTokens: 100, onTruncated: () => { stopped = true; } })).toBe("Line one. Line t");
    expect(stopped).toBe(true);
  });

  it("throws an error that comes after part of the text, with its status", async () => {
    const body = [chunk("Partial notes. "), { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }];
    const read = createGeminiGenerateText({ url: "https://gemini.example/v1/models/list-chunks-error:generateContent", headers: {}, fetchImpl: fakeFetch([Response.json(body)]).fetch });
    await expect(read({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ status: 503, kind: "server", message: "The model is overloaded." });
  });
});
