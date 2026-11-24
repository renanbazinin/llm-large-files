// What an application adds to Gemini's request bodies (A5, NEW-answer-request-tools, LLF-057; 0.10.0):
// `body` for chat requests, `analysisBody` for part reads, `explorerBody` for an explorer,
// `functionCallingMode`, and `answerWithoutTools: "mode_none"`. Without them, the bodies are those
// of 0.9 (test/request-bodies.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type ModelRequest, type ModelToolRound, type ToolDeclaration } from "llm-large-files";
import { askGemini, gemini, geminiApi, type GeminiRequestFields } from "llm-large-files/gemini";
import { fakeFetch, serviceLog, utf8, type Sent } from "llm-large-files/testing";

type Body = Record<string, any>;

const say = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10 } });
const call = (name: string, args: Body) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name, args } }] } }], usageMetadata: { promptTokenCount: 10 } });
const offersTools = (sent: Sent) => Array.isArray(sent.body.tools);
const partRead = (sent: Sent) => sent.body.systemInstruction?.role === "system";
const question = (text: string) => [{ role: "user" as const, text }];

const SAFETY: GeminiRequestFields["safetySettings"] = [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }];
const tool: ToolDeclaration = { name: "search_document", description: "Search.", parameters: { type: "object", properties: {} } };
const asking = (more: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief.", messages: [{ role: "user", parts: [{ text: "hi" }] }], ...more });

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, mapChunkTokens: 40_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
  return { files, meta };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gemini({ body }) since 0.10.0", () => {
  it("merges body last into every chat request, the tool turns and the request for the answer", async () => {
    const { files, meta } = await largeLog();
    const api = fakeFetch([(sent) => (offersTools(sent) ? call("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" }) : say("51 errors."))]);
    const body: GeminiRequestFields = { safetySettings: SAFETY, labels: { app: "chatbot", team: "hr" }, serviceTier: "flex" };
    const result = await askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: api.fetch, documentIds: [meta.id], messages: question("How many errors?"), limits: { toolTurns: 2 }, body });
    expect(result.text).toBe("51 errors.");
    expect(api.sent).toHaveLength(2);
    for (const sent of api.sent) {
      expect(sent.body).toMatchObject(body);
      // After the library's own fields.
      expect(Object.keys(sent.body).slice(-3)).toEqual(["safetySettings", "labels", "serviceTier"]);
    }
    // The request for the answer still declares no tools ("omit").
    expect(offersTools(api.sent[0]!)).toBe(true);
    expect(api.sent[1]!.body.tools).toBeUndefined();
    expect(api.sent[1]!.body.toolConfig).toBeUndefined();
  });

  it("counts body in requestBytes, as it is sent", async () => {
    const api = fakeFetch([say("ok")]);
    const body: GeminiRequestFields = { labels: { app: "chatbot" }, cachedContent: "cachedContents/abc" };
    const model = gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: api.fetch, body });
    const request = asking({ tools: [tool], toolChoice: "auto" });
    const bytes = model.requestBytes!(request);
    await model.send(request);
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(api.sent[0]!.body)));
    expect(bytes).toBeGreaterThan(gemini(geminiApi({ apiKey: "k", model: "gemini-test" })).requestBytes!(request));
  });

  it("merges analysisBody, given the output limit, last into part reads, and not into chat requests", async () => {
    const api = fakeFetch([say("Notes (L1).")]);
    const limits: number[] = [];
    const model = gemini(geminiApi({ apiKey: "k", model: "gemini-analysis-body" }), {
      fetch: api.fetch,
      body: { labels: { use: "chat" } },
      analysisBody: (maxOutputTokens) => {
        limits.push(maxOutputTokens);
        return { labels: { use: "parts" }, safetySettings: SAFETY };
      },
    });
    await model.generateText!({ system: "Read the part.", prompt: "Lines 1-40", maxOutputTokens: 4_096 });
    expect(limits).toEqual([4_096]);
    expect(api.sent[0]!.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "Lines 1-40" }] }],
      systemInstruction: { role: "system", parts: [{ text: "Read the part." }] },
      generationConfig: { maxOutputTokens: 4_096 },
      labels: { use: "parts" },
      safetySettings: SAFETY,
    });
    await model.send(asking());
    expect(api.sent[1]!.body.labels).toEqual({ use: "chat" });
    expect(api.sent[1]!.body.safetySettings).toBeUndefined();
  });

  it("gives askGemini's explorer explorerBody, or body when it has none, and the part reads analysisBody", async () => {
    const { files, meta } = await largeLog();
    const script = () => fakeFetch([(sent) => {
      if (partRead(sent)) return say("Errors at (L97).");
      if (sent.url.includes("gemini-answer")) return say("Every 97th line.");
      const turns = (sent.body.contents as Body[]).filter((content) => content.role === "model").length;
      if (turns === 0) return call("analyze_whole_document", { document_id: meta.id, task: "List the errors." });
      return say("DONE");
    }]);
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-answer", explorerModel: "gemini-explorer" });
    const api = script();
    await askGemini({
      files, endpoint, fetch: api.fetch, documentIds: [meta.id], messages: question("Which errors?"),
      body: { labels: { model: "answer" } },
      explorerBody: { labels: { model: "explorer" } },
      analysisBody: () => ({ labels: { model: "parts" } }),
    });
    const labelsOf = (match: (sent: Sent) => boolean) => [...new Set(api.sent.filter(match).map((sent) => JSON.stringify(sent.body.labels)))];
    expect(labelsOf((sent) => partRead(sent))).toEqual([JSON.stringify({ model: "parts" })]);
    expect(labelsOf((sent) => !partRead(sent) && sent.url.includes("gemini-explorer"))).toEqual([JSON.stringify({ model: "explorer" })]);
    expect(labelsOf((sent) => sent.url.includes("gemini-answer"))).toEqual([JSON.stringify({ model: "answer" })]);

    const same = script();
    await askGemini({ files, endpoint, fetch: same.fetch, documentIds: [meta.id], messages: question("Which errors?"), body: { labels: { model: "one" } } });
    expect([...new Set(same.sent.filter((sent) => !partRead(sent)).map((sent) => JSON.stringify(sent.body.labels)))]).toEqual([JSON.stringify({ model: "one" })]);
    // Part reads get no body: only analysisBody.
    expect(same.sent.filter(partRead).every((sent) => sent.body.labels === undefined)).toBe(true);
  });
});

describe("gemini({ functionCallingMode }) since 0.10.0", () => {
  it("sends VALIDATED only with tools, and AUTO by default", async () => {
    const api = fakeFetch([say("ok")]);
    const validated = gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: api.fetch, functionCallingMode: "VALIDATED" });
    await validated.send(asking({ tools: [tool], toolChoice: "auto" }));
    await validated.send(asking());
    await validated.send(asking({ tools: [tool], toolChoice: "none" }));
    await gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: api.fetch }).send(asking({ tools: [tool], toolChoice: "auto" }));
    expect(api.sent.map((sent) => sent.body.toolConfig)).toEqual([
      { functionCallingConfig: { mode: "VALIDATED" } },
      undefined,
      undefined,
      { functionCallingConfig: { mode: "AUTO" } },
    ]);
    expect(api.sent[0]!.body.tools).toEqual([{ functionDeclarations: [tool] }]);
  });
});

describe("gemini({ answerWithoutTools }) since 0.10.0", () => {
  it("keeps the tools with mode NONE in the request for the answer under \"mode_none\"", async () => {
    const api = fakeFetch([say("ok")]);
    await gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: api.fetch, answerWithoutTools: "mode_none", functionCallingMode: "VALIDATED" }).send(asking({ tools: [tool], toolChoice: "none" }));
    await gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: api.fetch, answerWithoutTools: "omit" }).send(asking({ tools: [tool], toolChoice: "none" }));
    expect(api.sent[0]!.body).toMatchObject({ tools: [{ functionDeclarations: [tool] }], toolConfig: { functionCallingConfig: { mode: "NONE" } } });
    expect(api.sent[1]!.body.tools).toBeUndefined();
    expect(api.sent[1]!.body.toolConfig).toBeUndefined();
  });

  it("asks once more when the model calls a tool anyway", async () => {
    const { files, meta } = await largeLog();
    const search = { document_id: meta.id, query: "ERROR", mode: "exact" };
    let closings = 0;
    const api = fakeFetch([(sent) => {
      const mode = sent.body.toolConfig?.functionCallingConfig?.mode;
      if (mode !== "NONE") return call("search_document", search);
      return ++closings === 1 ? call("search_document", search) : say("51 errors.");
    }]);
    const steps: string[] = [];
    const result = await askGemini({
      files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: api.fetch, documentIds: [meta.id], messages: question("How many errors?"),
      limits: { toolTurns: 2 }, answerWithoutTools: "mode_none", onStep: (step) => steps.push(step),
    });
    expect(api.sent.map((sent) => sent.body.toolConfig?.functionCallingConfig?.mode)).toEqual(["AUTO", "NONE", "NONE"]);
    expect(api.sent.every(offersTools)).toBe(true);
    expect(steps).toContain("The model called a tool instead of answering: it was asked again for the answer");
    expect(result).toMatchObject({ text: "51 errors.", answered: true });
  });
});

describe("the files of a tool round since 0.10.0", () => {
  it("are turned into base64 once for every adapter that sends them", async () => {
    const bytes = utf8(`%PDF-1.7 ${"page ".repeat(2_000)}`);
    const round: ModelToolRound = {
      role: "tools",
      calls: [{ id: "c1", name: "view_pages", args: { document_id: "doc-1", pages: "2" } }],
      answers: [{ call: { id: "c1", name: "view_pages", args: { document_id: "doc-1", pages: "2" } }, result: { file: "pages-2.pdf" }, files: [{ name: "pages-2.pdf", mimeType: "application/pdf", bytes }] }],
    };
    const encode = vi.spyOn(Buffer.prototype, "toString");
    const encodings = () => encode.mock.calls.filter(([encoding], index) => encoding === "base64" && (encode.mock.contexts[index] as Buffer).length === bytes.length).length;
    const api = fakeFetch([say("ok")]);
    const request = asking({ messages: [{ role: "user", parts: [{ text: "Look at page 2." }] }, round] });
    await gemini(geminiApi({ apiKey: "k", model: "gemini-a" }), { fetch: api.fetch }).send(request);
    await gemini(geminiApi({ apiKey: "k", model: "gemini-b" }), { fetch: api.fetch, toolFilePlacement: "beside" }).send(request);
    expect(encodings()).toBe(1);
    const inside = api.sent[0]!.body.contents[2].parts[0].functionResponse.parts[0].inlineData.data;
    const beside = api.sent[1]!.body.contents[3].parts[1].inlineData.data;
    expect(inside).toBe(Buffer.from(bytes).toString("base64"));
    expect(beside).toBe(inside);
  });
});
