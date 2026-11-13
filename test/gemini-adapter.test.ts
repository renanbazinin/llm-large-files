import { describe, expect, it, vi } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, ModelRequestError, type ToolTurn } from "llm-large-files";
import { askGemini, createGeminiGenerateText, fromGeminiContents, gemini, geminiApi, GeminiRequestError, geminiToolTurns, vertexAi, type GeminiEndpoint } from "llm-large-files/gemini";
import { serviceLog, utf8 } from "./fake-model.js";

type Body = Record<string, any>;
type Sent = { url: string; headers: Record<string, string>; body: Body };

const say = (value: string, usage?: Body, extra: Body = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP", ...extra }], ...(usage ? { usageMetadata: usage } : {}) });
const call = (name: string, args: Body, usage?: Body) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args }, thoughtSignature: "sig" }] } }], ...(usage ? { usageMetadata: usage } : {}) });
const question = (text: string) => [{ role: "user" as const, text }];
const partRead = (body: Body) => body.systemInstruction?.role === "system";

/** A Gemini that answers each request from a script and notes what it was sent. The last entry repeats. */
function fakeGemini(replies: Array<object | Response | ((sent: Sent, number: number) => object | Response)>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request: Sent = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Body };
    sent.push(request);
    const entry = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    const value = typeof entry === "function" ? entry(request, sent.length) : entry;
    return value instanceof Response ? value.clone() : Response.json(value);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

const busy = (status = 503, more: Body = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { code: status, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE", ...more } }), { status, headers });
const quickRetry = () => {
  const waits: number[] = [];
  return { waits, retry: { random: () => 1, sleep: async (ms: number) => { waits.push(ms); } } };
};

async function largeLog(budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
  return { files, meta };
}

describe("askGemini since 0.5.0", () => {
  it("asks for the headers with every request, so a token that was renewed is used", async () => {
    const { files, meta } = await largeLog({ mapChunkTokens: 40_000 });
    let tokens = 0;
    const endpoint = vertexAi({ project: "p", model: "gemini-test", accessToken: async () => `token-${++tokens}` });
    const gemini = fakeGemini([(sent) => {
      if (partRead(sent.body)) return say("Errors at (L97).");
      const turns = (sent.body.contents as Body[]).filter((content) => content.role === "model").length;
      if (turns === 0) return call("read_document", { document_id: meta.id, start_line: 1, end_line: 2 });
      if (turns === 1) return call("analyze_whole_document", { document_id: meta.id, task: "List the errors." });
      return say("Done.");
    }]);
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("?") });
    const used = gemini.sent.map((sent) => sent.headers.Authorization);
    expect(gemini.sent.filter((sent) => partRead(sent.body)).length).toBeGreaterThan(2);
    // No token is used twice: each request asked for one, the part reads of the whole-file read too.
    expect(new Set(used).size).toBe(used.length);
    expect(tokens).toBe(gemini.sent.length);
  });

  it("returns the usage of the whole question, and Gemini's own count of the last response apart", async () => {
    const { files, meta } = await largeLog({ mapChunkTokens: 40_000 });
    const gemini = fakeGemini([(sent) => {
      if (partRead(sent.body)) return say("Errors at (L97).", { promptTokenCount: 40_000, candidatesTokenCount: 30, thoughtsTokenCount: 70, totalTokenCount: 40_100 });
      const turns = (sent.body.contents as Body[]).filter((content) => content.role === "model").length;
      if (turns === 0) return call("analyze_whole_document", { document_id: meta.id, task: "List the errors." }, { promptTokenCount: 1_000, candidatesTokenCount: 20, totalTokenCount: 1_020 });
      return say("Every 97th line.", { promptTokenCount: 1_500, cachedContentTokenCount: 900, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 1_515 });
    }]);
    const result = await askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: gemini.fetch, documentIds: [meta.id], messages: question("Which errors?") });
    const parts = gemini.sent.filter((sent) => partRead(sent.body)).length;
    expect(parts).toBeGreaterThan(2);
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({
      requests: 2 + parts,
      inputTokens: 2_500 + parts * 40_000,
      cachedInputTokens: 900,
      outputTokens: 35 + parts * 100,
      thoughtTokens: 5 + parts * 70,
      byModel: { "gemini-test": { requests: 2 + parts, inputTokens: 2_500 + parts * 40_000, cachedInputTokens: 900, outputTokens: 35 + parts * 100, thoughtTokens: 5 + parts * 70 } },
    });
    expect(result.lastUsage).toEqual({ promptTokenCount: 1_500, cachedContentTokenCount: 900, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 1_515 });
    expect(result.evidence).toEqual([{ tool: "analyze_whole_document", documentId: meta.id, document: "app.log", whole: true, query: "List the errors." }]);
  });

  it("sends a request again when Gemini was busy, after the wait Gemini asks for, and keeps the steps", async () => {
    const { files, meta } = await largeLog();
    const retryInfo = { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }] };
    const gemini = fakeGemini([
      call("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" }),
      busy(503),
      busy(429, retryInfo),
      say("51 errors."),
    ]);
    const { retry, waits } = quickRetry();
    const steps: string[] = [];
    const result = await askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: gemini.fetch, documentIds: [meta.id], messages: question("?"), retry, onStep: (step) => steps.push(step) });
    expect(gemini.sent).toHaveLength(4);
    expect(waits).toEqual([500, 3_000]);
    // The three requests after the search are one and the same.
    expect(gemini.sent[2]!.body).toEqual(gemini.sent[1]!.body);
    expect(gemini.sent[3]!.body).toEqual(gemini.sent[1]!.body);
    expect(result).toMatchObject({ text: "51 errors.", answered: true, turns: 2 });
    expect(steps).toEqual(["Search app.log (exact) for “ERROR” — 51 matching lines"]);

    const down = fakeGemini([busy(503)]);
    const failure = await askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: down.fetch, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GeminiRequestError);
    expect(failure).toBeInstanceOf(ModelRequestError);
    expect(failure).toMatchObject({ name: "GeminiRequestError", status: 503, message: "The model is overloaded. Please try again later." });
    expect(down.sent).toHaveLength(4);
    const refused = fakeGemini([new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 })]);
    await expect(askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: refused.fetch, documentIds: [meta.id], messages: question("?"), retry: quickRetry().retry })).rejects.toMatchObject({ status: 400, message: "API key not valid." });
    expect(refused.sent).toHaveLength(1);
    const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: offline, documentIds: [meta.id], messages: question("?"), retry: { retries: 0 } })).rejects.toMatchObject({ name: "GeminiRequestError", status: 0, message: "Gemini could not be reached (fetch failed)." });
  });

  it("takes the limits under their new names, and the old names still", async () => {
    const { files, meta } = await largeLog();
    const script = () => fakeGemini([(sent) => (sent.body.tools ? call("read_document", { document_id: meta.id, start_line: 1, end_line: 2 }) : say("Best effort."))]);
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
    const old = script();
    await askGemini({ files, endpoint, fetch: old.fetch, documentIds: [meta.id], messages: question("?"), maxToolTurns: 3 });
    const now = script();
    await askGemini({ files, endpoint, fetch: now.fetch, documentIds: [meta.id], messages: question("?"), limits: { toolTurns: 3 } });
    expect(old.sent.map((sent) => Boolean(sent.body.tools))).toEqual([true, true, false]);
    expect(now.sent.map((sent) => sent.body)).toEqual(old.sent.map((sent) => sent.body));
    // `limits` wins where both are given.
    const both = script();
    await askGemini({ files, endpoint, fetch: both.fetch, documentIds: [meta.id], messages: question("?"), maxToolTurns: 9, limits: { toolTurns: 2 } });
    expect(both.sent).toHaveLength(2);
  });
});

describe("gemini() as a model of askWithFiles", () => {
  it("is named after the model in its URL, and says what the model takes", () => {
    const model = gemini(geminiApi({ apiKey: "k", model: "gemini-3.8-flash" }));
    expect(model.id).toBe("gemini-3.8-flash");
    expect(model.capabilities).toEqual({ toolFiles: "inside", pageTokens: 530 });
    expect(gemini(vertexAi({ project: "p", model: "gemini-4-carbon", accessToken: "t" })).id).toBe("gemini-4-carbon");
    const custom: GeminiEndpoint = { url: "https://gateway.example/llm/answer", headers: {} };
    expect(gemini(custom).id).toBe("gateway.example");
    expect(gemini(custom, { id: "house-model", toolFilePlacement: "beside", contextTokens: 128_000, maxRequestBytes: 4_000_000, pageTokens: 260 }).capabilities)
      .toEqual({ contextTokens: 128_000, maxRequestBytes: 4_000_000, toolFiles: "beside", pageTokens: 260 });
  });

  it("answers with two Gemini models that are adapters of their own", async () => {
    const { files, meta } = await largeLog();
    const api = fakeGemini([(sent) => {
      if (sent.url.includes("gemini-answer")) return say("51 errors.", { promptTokenCount: 800, candidatesTokenCount: 5 });
      const explored = (sent.body.contents as Body[]).some((content) => content.parts.some((part: Body) => part.functionResponse));
      return explored ? say("DONE", { promptTokenCount: 700, candidatesTokenCount: 1 }) : call("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" }, { promptTokenCount: 600, candidatesTokenCount: 9 });
    }]);
    const model = gemini(geminiApi({ apiKey: "k", model: "gemini-answer" }), { fetch: api.fetch, generationConfig: { temperature: 0.3 } });
    const explorer = gemini(geminiApi({ apiKey: "k", model: "gemini-explorer" }), { fetch: api.fetch, generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } } });
    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("How many errors?") });
    expect(api.sent.map((sent) => /models\/([^:]+):/.exec(sent.url)![1])).toEqual(["gemini-explorer", "gemini-explorer", "gemini-answer"]);
    expect(api.sent.map((sent) => sent.body.generationConfig)).toEqual([{ thinkingConfig: { thinkingLevel: "minimal" } }, { thinkingConfig: { thinkingLevel: "minimal" } }, { temperature: 0.3 }]);
    // The explorer gets its signature back; the answering model gets the call alone.
    expect(api.sent[1]!.body.contents[1].parts[0].thoughtSignature).toBe("sig");
    expect(api.sent[2]!.body.contents[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } } }] });
    expect(api.sent[2]!.body.tools).toBeUndefined();
    expect(result).toMatchObject({ text: "51 errors.", answered: true, turns: 3 });
    expect(result.usage.byModel).toEqual({
      "gemini-explorer": { requests: 2, inputTokens: 1_300, cachedInputTokens: 0, outputTokens: 10, thoughtTokens: 0 },
      "gemini-answer": { requests: 1, inputTokens: 800, cachedInputTokens: 0, outputTokens: 5, thoughtTokens: 0 },
    });
  });

  it("is given the tool rounds of an earlier question, as messages or as contents", async () => {
    const { files, meta } = await largeLog();
    const turns: ToolTurn[] = [{ role: "tools", calls: [{ id: "c1", name: "read_document", args: { document_id: meta.id, start_line: 96, end_line: 98 }, result: { document: "app.log", lines: "96-98", total_lines: 5_000, text: "96| a\n97| b\n98| c", tool_turns_left: 10 } }] }];
    const asContents = geminiToolTurns(turns);
    expect(asContents).toEqual([
      { role: "model", parts: [{ functionCall: { name: "read_document", args: { document_id: meta.id, start_line: 96, end_line: 98 }, id: "c1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "read_document", id: "c1", response: turns[0]!.calls[0]!.result } }] },
    ]);
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
    const viaMessages = fakeGemini([say("Line 97 took 0ms.")]);
    await askGemini({ files, endpoint, fetch: viaMessages.fetch, documentIds: [meta.id], messages: [{ role: "user", text: "What is on line 97?" }, ...turns, { role: "model", text: "An error." }, { role: "user", text: "How long did it take?" }] });
    const viaContents = fakeGemini([say("Line 97 took 0ms.")]);
    await askGemini({
      files, endpoint, fetch: viaContents.fetch, documentIds: [meta.id],
      contents: [{ role: "user", parts: [{ text: "What is on line 97?" }] }, ...asContents, { role: "model", parts: [{ text: "An error." }] }, { role: "user", parts: [{ text: "How long did it take?" }] }],
    });
    const sent = viaMessages.sent[0]!.body.contents as Body[];
    expect(sent.map((content) => content.role)).toEqual(["user", "model", "user", "model", "user"]);
    expect(sent.slice(1, 3)).toEqual(asContents);
    expect(sent[0]!.parts[0].text).toMatch(/^--- Large attached file: app\.log ---/);
    // The same request either way.
    expect(viaContents.sent[0]!.body).toEqual(viaMessages.sent[0]!.body);
    expect(fromGeminiContents([{ role: "model", parts: [{ text: "Hi", thoughtSignature: "s" }, { inlineData: { mimeType: "image/png", data: "x" } }] }]))
      .toEqual([{ role: "assistant", parts: [{ native: { text: "Hi", thoughtSignature: "s" }, text: "Hi" }, { native: { inlineData: { mimeType: "image/png", data: "x" } } }] }]);
  });
});

describe("createGeminiGenerateText since 0.5.0", () => {
  it("reports what each request used, and an error with its status and the wait it names", async () => {
    const used: unknown[] = [];
    let headers = 0;
    const replies: Array<object | Response> = [
      say("notes", { promptTokenCount: 25_000, cachedContentTokenCount: 0, candidatesTokenCount: 40, thoughtsTokenCount: 60 }),
      busy(429, { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "21s" }] }),
      busy(503, {}, { "retry-after": "2" }),
    ];
    const fetch = vi.fn(async () => {
      const next = replies.shift()!;
      return next instanceof Response ? next : Response.json(next);
    });
    const generate = createGeminiGenerateText({ url: "https://example.invalid/usage-test:generateContent", headers: () => ({ Authorization: `Bearer ${++headers}` }), fetchImpl: fetch as unknown as typeof globalThis.fetch });
    expect(await generate({ system: "s", prompt: "p", maxOutputTokens: 4_096, onUsage: (usage) => used.push(usage) })).toBe("notes");
    expect(used).toEqual([{ inputTokens: 25_000, cachedInputTokens: 0, outputTokens: 100, thoughtTokens: 60 }]);
    await expect(generate({ system: "s", prompt: "p", maxOutputTokens: 4_096 })).rejects.toMatchObject({ name: "GeminiRequestError", status: 429, retryAfterMs: 21_000 });
    await expect(generate({ system: "s", prompt: "p", maxOutputTokens: 4_096 })).rejects.toMatchObject({ status: 503, retryAfterMs: 2_000 });
    expect(headers).toBe(3);
  });
});
