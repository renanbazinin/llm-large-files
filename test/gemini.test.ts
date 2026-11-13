import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, createGeminiGenerateText, DocumentsNotFoundError, GeminiRequestError, geminiApi, vertexAi } from "llm-large-files/gemini";

const encoder = new TextEncoder();

function log(lines: number): string {
  return Array.from({ length: lines }, (_, index) => (index + 1) % 250 === 0
    ? `2026-05-01 12:00:00 ERROR db: deadlock detected on table orders (tx ${index + 1})`
    : `2026-05-01 12:00:00 INFO request ${index + 1} ok`).join("\n");
}

function sse(chunks: unknown[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const text = (value: string, extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, ...extra }] });
const endpoint = geminiApi({ apiKey: "test-key", model: "gemini-test" });

describe("endpoints", () => {
  it("builds Gemini API and Vertex AI URLs", async () => {
    expect(endpoint.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(endpoint.streamUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
    expect(endpoint.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    const global = vertexAi({ project: "p", model: "m", accessToken: async () => "tok" });
    expect(global.url).toBe("https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent");
    expect(await (global.headers as () => Promise<Record<string, string>>)()).toMatchObject({ Authorization: "Bearer tok" });
    expect(vertexAi({ project: "p", model: "m", location: "eu", accessToken: "t" }).url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\/v1\/projects\/p\/locations\/eu\//);
    expect(vertexAi({ project: "p", model: "m", location: "europe-west4", accessToken: "t" }).url).toMatch(/^https:\/\/europe-west4-aiplatform\.googleapis\.com\//);
  });
});

describe("askGemini", () => {
  it("sends a document that fits in full, without tools", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: encoder.encode("# Notes\n\nThe code word is heron.") });
    const fetch = vi.fn(async () => Response.json(text("Heron.")));
    const result = await askGemini({ files, endpoint, fetch, documentIds: [meta.id], system: "Be brief.", messages: [{ role: "user", text: "What is the code word?" }] });
    expect(result).toMatchObject({ text: "Heron.", answered: true, steps: [], turns: 1 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint.url);
    const body = JSON.parse(String(init.body));
    expect(body.tools).toBeUndefined();
    expect(body.systemInstruction.parts[0].text).toBe("Be brief.");
    // The document comes first and the question last.
    expect(body.contents[0].parts[0].text).toContain("The code word is heron.");
    expect(body.contents[0].parts[1].text).toBe("What is the code word?");
  });

  it("keeps the document in the first user turn, so a follow-up question shares its prefix", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: encoder.encode("# Notes\n\nThe code word is heron.") });
    const bodies: Array<Record<string, any>> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(text("ok"));
    });
    const first = [{ role: "user" as const, text: "What is the code word?" }];
    const followUp = [...first, { role: "model" as const, text: "Heron." }, { role: "user" as const, text: "Spell it backwards." }];
    await askGemini({ files, endpoint, fetch, documentIds: [meta.id], messages: first });
    await askGemini({ files, endpoint, fetch, documentIds: [meta.id], messages: followUp });
    // The first turn is byte-for-byte the same in both requests: that is what a prompt cache reuses.
    expect(bodies[1]!.contents[0]).toEqual(bodies[0]!.contents[0]);
    expect(bodies[1]!.contents[0].parts[0].text).toContain("The code word is heron.");
    expect(bodies[1]!.contents[2]).toEqual({ role: "user", parts: [{ text: "Spell it backwards." }] });

    // documentPlacement "last" keeps the 0.1.0 layout: the document rides on the latest question.
    await askGemini({ files, endpoint, fetch, documentIds: [meta.id], messages: followUp, documentPlacement: "last" });
    expect(bodies[2]!.contents[0]).toEqual({ role: "user", parts: [{ text: "What is the code word?" }] });
    expect(bodies[2]!.contents[2].parts[0].text).toBe("Spell it backwards.");
    expect(bodies[2]!.contents[2].parts[1].text).toContain("The code word is heron.");
  });

  it("streams a tool loop for a document that does not fit", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: encoder.encode(log(5_000)) });
    const bodies: Array<Record<string, any>> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return sse([{ candidates: [{ content: { parts: [
          { text: "Checking." },
          { functionCall: { name: "search_document", args: { document_id: meta.id, query: "deadlock", mode: "exact" } }, thoughtSignature: "sig" },
        ] } }] }]);
      }
      return sse([text("20 deadlocks (app.log L250)."), text("", { finishReason: "STOP" })]);
    });
    const deltas: string[] = [];
    const activity: string[] = [];
    const result = await askGemini({
      files, endpoint, fetch, documentIds: [meta.id],
      messages: [{ role: "user", text: "Earlier question" }, { role: "assistant", text: "Earlier answer" }, { role: "user", text: "How many deadlocks?" }],
      onText: (delta) => deltas.push(delta),
      onActivity: (value) => activity.push(value),
    });
    expect(fetch.mock.calls[0]![0]).toBe(endpoint.streamUrl);
    expect(bodies[0]!.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name)).toContain("analyze_whole_document");
    expect(bodies[0]!.contents[1]).toEqual({ role: "model", parts: [{ text: "Earlier answer" }] });
    expect(bodies[1]!.contents.at(-2).parts[1]).toEqual({ functionCall: { name: "search_document", args: { document_id: meta.id, query: "deadlock", mode: "exact" } }, thoughtSignature: "sig" });
    expect(bodies[1]!.contents.at(-1).parts[0].functionResponse.response).toMatchObject({ total_matching_lines: 20, tool_turns_left: 10 });
    expect(result.text).toBe("Checking.\n\n20 deadlocks (app.log L250).");
    expect(deltas.join("")).toBe(result.text);
    expect(result.steps).toEqual(["Search app.log (exact) for “deadlock” — 20 matching lines"]);
    expect(result).toMatchObject({ turns: 2, finishReason: "STOP" });
    expect(activity[0]).toMatch(/^Too large to read at once: app\.log/);
  });

  it("finishes with a tool-free turn when the model keeps calling tools", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: encoder.encode(log(5_000)) });
    const bodies: Array<Record<string, any>> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json(body.tools
        ? { candidates: [{ content: { parts: [{ functionCall: { name: "read_document", args: { document_id: meta.id, start_line: 1 } } }] } }] }
        : text("Best effort answer."));
    });
    const result = await askGemini({ files, endpoint, fetch, documentIds: [meta.id], maxToolTurns: 3, wholeDocumentAnalysis: false, messages: [{ role: "user", text: "?" }] });
    // Three requests in all: two that run tools, then the answer. None is made only to be thrown away.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bodies[0]!.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name)).not.toContain("analyze_whole_document");
    expect(bodies.map((body) => Boolean(body.tools))).toEqual([true, true, false]);
    expect(bodies.at(-1)!.toolConfig).toBeUndefined();
    expect(bodies.at(-1)!.contents.at(-1).parts[0].text).toMatch(/^Stop using tools now/);
    // Every tool call the model made got its result back.
    const sent = bodies.at(-1)!.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(sent.flatMap((content) => content.parts).filter((part) => part.functionCall)).toHaveLength(2);
    expect(sent.flatMap((content) => content.parts).filter((part) => part.functionResponse)).toHaveLength(2);
    expect(sent.at(-2)!.parts[0]!.functionResponse).toMatchObject({ response: { tool_turns_left: 0 } });
    expect(result).toMatchObject({ text: "Best effort answer.", answered: true, turns: 3 });
    expect(result.steps).toHaveLength(2);
  });

  it("asks for the answer when the model's last turn has no text, instead of returning an earlier remark", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: encoder.encode(log(5_000)) });
    const bodies: Array<Record<string, any>> = [];
    const replies = [
      { candidates: [{ content: { parts: [{ text: "Let me search the log." }, { functionCall: { name: "search_document", args: { document_id: meta.id, query: "deadlock", mode: "exact" } } }] } }] },
      { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL", content: { parts: [] } }] },
      text("20 deadlocks (app.log L250).", { finishReason: "STOP" }),
    ];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(replies[bodies.length - 1]);
    });
    const result = await askGemini({ files, endpoint, fetch, documentIds: [meta.id], messages: [{ role: "user", text: "How many deadlocks?" }] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bodies[2]!.tools).toBeUndefined();
    expect(result).toMatchObject({ text: "Let me search the log.\n\n20 deadlocks (app.log L250).", answered: true, turns: 3, finishReason: "STOP" });

    // If even the tool-free request comes back empty, the result says there is no answer.
    bodies.length = 0;
    replies[2] = { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "internal reasoning", thought: true } as never] } }] } as never;
    const empty = await askGemini({ files, endpoint, fetch, documentIds: [meta.id], messages: [{ role: "user", text: "How many deadlocks?" }] });
    expect(empty).toMatchObject({ text: "Let me search the log.", answered: false, finishReason: "MAX_TOKENS" });
  });

  it("reports a blocked prompt instead of an empty answer", async () => {
    const blocked = vi.fn(async () => Response.json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }));
    const small = createLargeFiles({ store: new MemoryDocumentStore() });
    const inline = await small.ingest({ name: "a.txt", bytes: encoder.encode("alpha") });
    expect(await askGemini({ files: small, endpoint, fetch: blocked, documentIds: [inline.id], messages: [{ role: "user", text: "?" }] }))
      .toMatchObject({ text: "", answered: false, blockReason: "PROHIBITED_CONTENT", turns: 1 });

    // With tools on offer too, and without a second request that would only be blocked again.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const large = await files.ingest({ name: "app.log", bytes: encoder.encode(log(5_000)) });
    blocked.mockClear();
    expect(await askGemini({ files, endpoint, fetch: blocked, documentIds: [large.id], messages: [{ role: "user", text: "?" }] }))
      .toMatchObject({ text: "", answered: false, blockReason: "PROHIBITED_CONTENT", turns: 1 });
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it("tells a whole-document read when Gemini stopped at the output limit", async () => {
    const replies = [text("partial notes, ORD-", { finishReason: "MAX_TOKENS" }), text("complete notes", { finishReason: "STOP" })];
    const fetch = vi.fn(async () => Response.json(replies.shift()));
    const generate = createGeminiGenerateText({ url: endpoint.url, headers: {}, fetchImpl: fetch as unknown as typeof globalThis.fetch });
    const truncated = vi.fn();
    expect(await generate({ system: "s", prompt: "p", maxOutputTokens: 100, onTruncated: truncated })).toBe("partial notes, ORD-");
    expect(truncated).toHaveBeenCalledTimes(1);
    expect(await generate({ system: "s", prompt: "p", maxOutputTokens: 100, onTruncated: truncated })).toBe("complete notes");
    expect(truncated).toHaveBeenCalledTimes(1);
  });

  it("treats other owners' documents as missing and reports HTTP errors", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "a.txt", bytes: encoder.encode("secret"), owner: "alice" });
    const fetch = vi.fn(async () => Response.json({ error: { message: "quota exceeded" } }, { status: 429 }));
    await expect(askGemini({ files, endpoint, fetch, documentIds: [meta.id], owner: "bob", messages: [{ role: "user", text: "?" }] }))
      .rejects.toBeInstanceOf(DocumentsNotFoundError);
    expect(fetch).not.toHaveBeenCalled();
    // Without a second try: what is sent again, and when, has tests of its own.
    const failure = askGemini({ files, endpoint, fetch, documentIds: [meta.id], owner: "alice", retry: { retries: 0 }, messages: [{ role: "user", text: "?" }] });
    await expect(failure).rejects.toBeInstanceOf(GeminiRequestError);
    await expect(failure).rejects.toMatchObject({ status: 429, message: "quota exceeded" });
  });

  it("accepts raw Gemini contents and leaves the caller's array untouched", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "a.txt", bytes: encoder.encode("alpha") });
    const contents = [{ role: "user" as const, parts: [{ text: "Describe the image and the file." }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] }];
    const fetch = vi.fn(async () => Response.json(text("ok")));
    await askGemini({ files, endpoint, fetch, documentIds: [meta.id], contents });
    expect(contents[0]!.parts).toHaveLength(2);
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.contents[0].parts).toHaveLength(3);
    await expect(askGemini({ files, endpoint, fetch, documentIds: [], messages: [{ role: "assistant", text: "hi" }] })).rejects.toThrow("The last message must be the user's.");
  });
});
