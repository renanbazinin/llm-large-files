import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import {
  askGemini,
  EXPLORER_INSTRUCTION,
  FINAL_ANSWER_AFTER_PAGES,
  FINAL_ANSWER_REQUEST,
  FINAL_ANSWER_WITHOUT_TOOLS,
  GeminiRequestError,
  geminiApi,
  vertexAi,
  type GeminiEndpoint,
} from "llm-large-files/gemini";
import { numberedPdf } from "./pdf-fixtures.js";

const encoder = new TextEncoder();
const MODELS = "https://generativelanguage.googleapis.com/v1beta/models";
const EXPLORER_URL = `${MODELS}/gemini-explorer:generateContent`;
const endpoint = geminiApi({ apiKey: "test-key", model: "gemini-answer", explorerModel: "gemini-explorer" });
const NOTE = `\n\n${EXPLORER_INSTRUCTION}`;

function log(lines: number): string {
  return Array.from({ length: lines }, (_, index) => (index + 1) % 250 === 0
    ? `2026-05-01 12:00:00 ERROR db: deadlock detected on table orders (tx ${index + 1})`
    : `2026-05-01 12:00:00 INFO request ${index + 1} ok`).join("\n");
}

type Body = Record<string, any>;
type Sent = { url: string; headers: Record<string, string>; body: Body };

const say = (value: string, extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, ...extra }] });
const call = (name: string, args: Record<string, unknown>) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const question = (text: string) => [{ role: "user" as const, text }];
const toolNames = (body: Body): string[] => (body.tools?.[0]?.functionDeclarations ?? []).map((tool: { name: string }) => tool.name);
const systemOf = (body: Body): string => body.systemInstruction?.parts?.[0]?.text ?? "";
const pdfsOf = (body: Body): string[] => (body.contents as Body[]).flatMap((content) => content.parts as Body[])
  .flatMap((part) => [part, ...((part.functionResponse?.parts ?? []) as Body[])])
  .filter((part) => part.inlineData?.mimeType === "application/pdf").map((part) => part.inlineData.data as string);

/**
 * A Gemini that answers each request from a script and notes where the request went. The last
 * entry repeats. A request to a streaming URL is answered with a stream.
 */
function fakeGemini(replies: Array<object | ((sent: Sent) => object | Response)>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request: Sent = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Body };
    sent.push(request);
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    const value = typeof reply === "function" ? reply(request) : reply;
    if (value instanceof Response) return value;
    if (!request.url.includes(":streamGenerateContent")) return Response.json(value);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\r\n\r\n`));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  return { fetch, sent };
}

async function largeLog(budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "app.log", bytes: encoder.encode(log(5_000)) });
  return { files, meta };
}

describe("an explorer model in the endpoint", () => {
  it("adds the explorer's URL next to the model's own", () => {
    expect(endpoint.url).toBe(`${MODELS}/gemini-answer:generateContent`);
    expect(endpoint.streamUrl).toBe(`${MODELS}/gemini-answer:streamGenerateContent?alt=sse`);
    expect(endpoint.explorerUrl).toBe(EXPLORER_URL);
    expect(geminiApi({ apiKey: "k", model: "a", explorerModel: " b ", apiVersion: "v1", baseUrl: "https://gateway.example/" }).explorerUrl)
      .toBe("https://gateway.example/v1/models/b:generateContent");
    const vertex = vertexAi({ project: "p", model: "a", explorerModel: "b", location: "eu", accessToken: "t" });
    expect(vertex.url).toBe("https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu/publishers/google/models/a:generateContent");
    expect(vertex.explorerUrl).toBe("https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu/publishers/google/models/b:generateContent");
  });

  it("names none when the setting is left out, empty, or the model itself", () => {
    // What an unset or empty environment variable gives, passed as it is.
    for (const explorerModel of [undefined, "", "   ", "gemini-answer"]) {
      expect("explorerUrl" in geminiApi({ apiKey: "k", model: "gemini-answer", explorerModel })).toBe(false);
      expect("explorerUrl" in vertexAi({ project: "p", model: "gemini-answer", explorerModel, accessToken: "t" })).toBe(false);
    }
    expect(geminiApi({ apiKey: "k", model: "gemini-answer", explorerModel: "" })).toEqual(geminiApi({ apiKey: "k", model: "gemini-answer" }));
  });
});

describe("askGemini with an explorer model", () => {
  it("sends the tool turns to the explorer and asks the endpoint's model for the answer", async () => {
    const { files, meta } = await largeLog();
    const search = { name: "search_document", args: { document_id: meta.id, query: "deadlock", mode: "exact" }, id: "call-1" };
    const explored = [
      { text: "The log is large, so I will search it.", thought: true },
      { text: "Checking." },
      { functionCall: search, thoughtSignature: "signature-of-the-explorer" },
    ];
    const gemini = fakeGemini([
      { candidates: [{ content: { role: "model", parts: explored } }] },
      say("DONE"),
      say("20 deadlocks (app.log L250).", { finishReason: "STOP" }),
    ]);
    const deltas: string[] = [];
    const activity: string[] = [];
    const result = await askGemini({
      files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], system: "Be brief.", generationConfig: { temperature: 0.3 },
      messages: question("How many deadlocks?"),
      onText: (delta) => deltas.push(delta),
      onActivity: (value) => activity.push(value),
    });
    const [first, second, answer] = gemini.sent;
    // Two requests to the explorer, in one piece each, and the answer streamed from the endpoint's model.
    expect(gemini.sent.map((request) => request.url)).toEqual([EXPLORER_URL, EXPLORER_URL, endpoint.streamUrl]);
    expect(gemini.sent.map((request) => request.headers["x-goog-api-key"])).toEqual(["test-key", "test-key", "test-key"]);

    // The explorer gets the tools, the same settings, and the guide with a line about its part.
    expect(toolNames(first!.body)).toEqual(["search_document", "read_document", "get_document_overview", "analyze_whole_document"]);
    expect(first!.body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(first!.body.generationConfig).toEqual({ temperature: 0.3 });
    expect(systemOf(first!.body).startsWith("Be brief.\n\nSome attached files are too large for your context")).toBe(true);
    expect(systemOf(first!.body).endsWith(NOTE)).toBe(true);
    // Its own turn goes back to it unchanged: Gemini 3 wants its thought signatures.
    expect(second!.body.contents.at(-2)).toEqual({ role: "model", parts: explored });

    // The answering model: no tools, the guide without that line, and the same conversation.
    expect(answer!.body.tools).toBeUndefined();
    expect(answer!.body.toolConfig).toBeUndefined();
    expect(answer!.body.generationConfig).toEqual({ temperature: 0.3 });
    expect(systemOf(answer!.body)).toBe(systemOf(first!.body).slice(0, -NOTE.length));
    expect(answer!.body.contents[0]).toEqual(first!.body.contents[0]);
    // From the explorer it gets the call and what the call returned: no signature, remark or thought.
    expect(answer!.body.contents).toHaveLength(4);
    expect(answer!.body.contents[1]).toEqual({ role: "model", parts: [{ functionCall: search }] });
    expect(answer!.body.contents[2]).toEqual(second!.body.contents.at(-1));
    expect(answer!.body.contents[2].parts[0].functionResponse).toMatchObject({ name: "search_document", id: "call-1", response: { total_matching_lines: 20, tool_turns_left: 10 } });
    expect(answer!.body.contents[3]).toEqual({ role: "user", parts: [{ text: FINAL_ANSWER_REQUEST }] });
    const raw = JSON.stringify(answer!.body);
    for (const absent of ["thoughtSignature", "signature-of-the-explorer", "Checking.", "I will search it", "DONE"]) expect(raw).not.toContain(absent);

    // Only the answering model's words are shown.
    expect(result).toMatchObject({ text: "20 deadlocks (app.log L250).", answered: true, turns: 3, finishReason: "STOP" });
    expect(deltas.join("")).toBe(result.text);
    expect(result.steps).toEqual(["Search app.log (exact) for “deadlock” — 20 matching lines"]);
    expect(activity.at(-1)).toBe("Writing the answer…");
  });

  it("asks for the answer from the conversation when the explorer used no tool", async () => {
    const { files, meta } = await largeLog();
    // A hand-built endpoint, as for a gateway, with headers that are resolved for each call of askGemini.
    const gateway: GeminiEndpoint = {
      url: "https://gateway.example/answer:generateContent",
      explorerUrl: "https://gateway.example/explorer:generateContent",
      headers: async () => ({ Authorization: "Bearer token" }),
    };
    // An explorer that answers itself instead of stopping: its answer is not the answer.
    const gemini = fakeGemini([say("The file is called other.log."), say("It is app.log.", { finishReason: "STOP" })]);
    const deltas: string[] = [];
    const result = await askGemini({ files, endpoint: gateway, fetch: gemini.fetch, documentIds: [meta.id], messages: question("What is the file called?"), onText: (delta) => deltas.push(delta) });
    const [first, answer] = gemini.sent;
    expect(gemini.sent.map((request) => request.url)).toEqual([gateway.explorerUrl, gateway.url]);
    expect(gemini.sent.map((request) => request.headers.Authorization)).toEqual(["Bearer token", "Bearer token"]);
    expect(answer!.body.tools).toBeUndefined();
    expect(answer!.body.contents).toEqual([first!.body.contents[0], { role: "user", parts: [{ text: FINAL_ANSWER_WITHOUT_TOOLS }] }]);
    expect(result).toMatchObject({ text: "It is app.log.", answered: true, steps: [], turns: 2 });
    expect(deltas).toEqual(["It is app.log."]);
  });

  it("gives the explorer its own generationConfig when one is set", async () => {
    const { files, meta } = await largeLog();
    const gemini = fakeGemini([say("DONE"), say("ok")]);
    const generationConfig = { temperature: 0.7, thinkingConfig: { thinkingLevel: "high" } };
    const explorerGenerationConfig = { temperature: 0, thinkingConfig: { thinkingBudget: 0 } };
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("?"), generationConfig, explorerGenerationConfig });
    expect(gemini.sent.map((request) => request.body.generationConfig)).toEqual([explorerGenerationConfig, generationConfig]);

    // With no settings at all, neither request carries any.
    const bare = fakeGemini([say("DONE"), say("ok")]);
    await askGemini({ files, endpoint, fetch: bare.fetch, documentIds: [meta.id], messages: question("?") });
    expect(bare.sent.map((request) => "generationConfig" in request.body)).toEqual([false, false]);
  });

  it("does not call the explorer for a document that is sent whole", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: encoder.encode("# Notes\n\nThe code word is heron.") });
    const gemini = fakeGemini([say("Heron.")]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], system: "Be brief.", explorerGenerationConfig: { temperature: 0 }, messages: question("What is the code word?") });
    expect(gemini.sent.map((request) => request.url)).toEqual([endpoint.url]);
    expect(systemOf(gemini.sent[0]!.body)).toBe("Be brief.");
    expect(gemini.sent[0]!.body.generationConfig).toBeUndefined();
    expect(result).toMatchObject({ text: "Heron.", answered: true, turns: 1 });
  });

  it("has the explorer read a whole file in parts", async () => {
    const { files, meta } = await largeLog({ mapChunkTokens: 40_000 });
    const partRead = (body: Body) => body.systemInstruction?.role === "system";
    const explored = (body: Body) => (body.contents as Body[]).some((content) => content.parts.some((part: Body) => part.functionResponse));
    const gemini = fakeGemini([({ body }) => {
      if (partRead(body)) return say("Deadlocks on table orders (L250).", { finishReason: "STOP" });
      if (!body.tools) return say("Deadlocks, twenty of them.", { finishReason: "STOP" });
      return explored(body) ? say("DONE") : call("analyze_whole_document", { document_id: meta.id, task: "List every kind of error." });
    }]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("Which errors are in the file?"), analysisConfig: (maxOutputTokens) => ({ maxOutputTokens, temperature: 0 }) });
    const parts = gemini.sent.filter((request) => partRead(request.body));
    expect(parts.length).toBeGreaterThan(2);
    // Every part read, like every tool turn, goes to the explorer. Only the answer does not.
    expect(parts.every((request) => request.url === EXPLORER_URL)).toBe(true);
    expect(parts[0]!.body.generationConfig).toEqual({ maxOutputTokens: 4_096, temperature: 0 });
    expect(gemini.sent.filter((request) => request.url !== EXPLORER_URL).map((request) => request.url)).toEqual([endpoint.url]);
    expect(gemini.sent.at(-1)!.url).toBe(endpoint.url);
    expect(gemini.sent.at(-1)!.body.contents.at(-2).parts[0].functionResponse.response.answer).toBe("Deadlocks on table orders (L250).");
    // The part reads are not counted as turns: two of the explorer's, and the answer.
    expect(result).toMatchObject({ text: "Deadlocks, twenty of them.", answered: true, turns: 3 });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatch(/^Read all of app\.log for “List every kind of error\.” — \d+ parts, \d+ relevant$/);
  });

  it("stops an explorer that keeps calling tools, and still gets the answer from the other model", async () => {
    const { files, meta } = await largeLog();
    const gemini = fakeGemini([({ body }) => (body.tools ? call("read_document", { document_id: meta.id, start_line: 1 }) : say("Best effort answer."))]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], maxToolTurns: 3, wholeDocumentAnalysis: false, messages: question("?") });
    // Three requests in all, as without an explorer: two of them the explorer's.
    expect(gemini.sent.map((request) => request.url)).toEqual([EXPLORER_URL, EXPLORER_URL, endpoint.url]);
    expect(toolNames(gemini.sent[0]!.body)).not.toContain("analyze_whole_document");
    const sent = gemini.sent.at(-1)!.body.contents as Array<{ role: string; parts: Array<Record<string, any>> }>;
    expect(sent.flatMap((content) => content.parts).filter((part) => part.functionCall)).toHaveLength(2);
    expect(sent.flatMap((content) => content.parts).filter((part) => part.functionResponse)).toHaveLength(2);
    expect(sent.at(-2)!.parts[0]!.functionResponse).toMatchObject({ response: { tool_turns_left: 0 } });
    expect(sent.at(-1)!.parts[0]!.text).toBe(FINAL_ANSWER_REQUEST);
    expect(result).toMatchObject({ text: "Best effort answer.", answered: true, turns: 3 });
    expect(result.steps).toHaveLength(2);

    // With one request allowed there is no exploring: that one request is the answer.
    const single = fakeGemini([say("From the card alone.")]);
    const one = await askGemini({ files, endpoint, fetch: single.fetch, documentIds: [meta.id], maxToolTurns: 1, messages: question("?") });
    expect(single.sent.map((request) => request.url)).toEqual([endpoint.url]);
    expect(single.sent[0]!.body.tools).toBeUndefined();
    expect(single.sent[0]!.body.contents.at(-1)).toEqual({ role: "user", parts: [{ text: FINAL_ANSWER_WITHOUT_TOOLS }] });
    expect(one).toMatchObject({ text: "From the card alone.", answered: true, turns: 1 });
  });

  it("asks for the answer when the explorer's last turn is empty, and says so when the answer is empty too", async () => {
    const { files, meta } = await largeLog();
    const replies = [
      call("search_document", { document_id: meta.id, query: "deadlock", mode: "exact" }),
      { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL", content: { parts: [] } }] },
      say("20 deadlocks (app.log L250).", { finishReason: "STOP" }),
    ];
    const gemini = fakeGemini(replies);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("How many deadlocks?") });
    expect(gemini.sent.map((request) => request.url)).toEqual([EXPLORER_URL, EXPLORER_URL, endpoint.url]);
    expect(result).toMatchObject({ text: "20 deadlocks (app.log L250).", answered: true, turns: 3, finishReason: "STOP" });

    replies[2] = { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] };
    const empty = await askGemini({ files, endpoint, fetch: fakeGemini(replies).fetch, documentIds: [meta.id], messages: question("How many deadlocks?") });
    expect(empty).toMatchObject({ text: "", answered: false, finishReason: "MAX_TOKENS" });
  });

  it("does not ask for an answer when the explorer's prompt was blocked", async () => {
    const { files, meta } = await largeLog();
    const gemini = fakeGemini([{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("?") });
    expect(gemini.sent.map((request) => request.url)).toEqual([EXPLORER_URL]);
    expect(result).toMatchObject({ text: "", answered: false, blockReason: "PROHIBITED_CONTENT", turns: 1 });
  });

  it("reports an explorer that fails, instead of going on without it", async () => {
    const { files, meta } = await largeLog();
    const gemini = fakeGemini([() => Response.json({ error: { message: "models/gemini-explorer is not found" } }, { status: 404 })]);
    const failure = askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("?") });
    await expect(failure).rejects.toBeInstanceOf(GeminiRequestError);
    await expect(failure).rejects.toMatchObject({ status: 404, message: "models/gemini-explorer is not found" });
    expect(gemini.sent.map((request) => request.url)).toEqual([EXPLORER_URL]);
  });

  it("treats an explorer that is the model itself as no explorer", async () => {
    const { files, meta } = await largeLog();
    const plain = geminiApi({ apiKey: "test-key", model: "gemini-answer" });
    const script = () => fakeGemini([
      { candidates: [{ content: { role: "model", parts: [{ text: "Checking." }, { functionCall: { name: "search_document", args: { document_id: meta.id, query: "deadlock", mode: "exact" } }, thoughtSignature: "sig" }] } }] },
      say("20 deadlocks (app.log L250).", { finishReason: "STOP" }),
    ]);
    const ask = (gemini: ReturnType<typeof fakeGemini>, target: GeminiEndpoint) => askGemini({ files, endpoint: target, fetch: gemini.fetch, documentIds: [meta.id], messages: question("How many deadlocks?"), explorerGenerationConfig: { temperature: 0 } });
    const without = script();
    const withItself = script();
    const expected = await ask(without, plain);
    const result = await ask(withItself, { ...plain, explorerUrl: plain.url });
    // The same two requests, byte for byte, and the model's own answer, remark included.
    expect(withItself.sent).toEqual(without.sent);
    expect(withItself.sent).toHaveLength(2);
    expect(result).toEqual(expected);
    expect(result.text).toBe("Checking.\n\n20 deadlocks (app.log L250).");
  });

  it.each(["inside", "beside"] as const)("hands the pages the explorer looked at to the answering model (pages %s)", async (toolFilePlacement) => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const look = { name: "view_pages", args: { document_id: meta.id, from_page: 2, to_page: 3 } };
    const gemini = fakeGemini([
      { candidates: [{ content: { role: "model", parts: [{ functionCall: look, thoughtSignature: "signature-of-the-explorer" }] } }] },
      say("DONE"),
      say("Page 2 shows a bar chart.", { finishReason: "STOP" }),
    ]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("What does the chart on page 2 show?"), toolFilePlacement });
    const [first, second, answer] = gemini.sent;
    expect(gemini.sent.map((request) => request.url)).toEqual([EXPLORER_URL, EXPLORER_URL, endpoint.url]);
    // The text is in the prompt, so the explorer has one tool: a look at the pages.
    expect(toolNames(first!.body)).toEqual(["view_pages"]);
    expect(systemOf(first!.body).endsWith(NOTE)).toBe(true);
    // The pages it was shown are in the answering model's request too, where they were.
    expect(pdfsOf(second!.body)).toHaveLength(1);
    expect(pdfsOf(answer!.body)).toEqual(pdfsOf(second!.body));
    expect(answer!.body.contents.slice(2, -1)).toEqual(second!.body.contents.slice(2));
    expect(answer!.body.contents[1]).toEqual({ role: "model", parts: [{ functionCall: look }] });
    expect(answer!.body.contents.at(-1)).toEqual({ role: "user", parts: [{ text: FINAL_ANSWER_AFTER_PAGES }] });
    expect(answer!.body.tools).toBeUndefined();
    expect(result).toMatchObject({ text: "Page 2 shows a bar chart.", answered: true, turns: 3, steps: ["Look at report.pdf pages 2-3"] });
  });
});
