// The record and replay of evals/lib/record.ts, the eval runner over it, the eval cassettes, and
// the workflows that run them: the evals-replay job of CI, the weekly live evals, and the dry run of
// the release workflow.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { askWithFiles, checkCitations, createLargeFiles, MemoryDocumentStore, type AskEvent, type LargeFiles, type ModelAdapter, type ModelRequest } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, geminiApi, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { calls, fakeFetch, fakeModel, says, serviceLog, sse, utf8 } from "llm-large-files/testing";
import type { EvalCase } from "../evals/cases.js";
import type { EvalLibrary } from "../evals/fixtures.js";
import { checkFact, hebrewShare, numbersIn } from "../evals/lib/facts.js";
import { CassetteMissError, normalizeUrl, readCassette, recordingFetch, recordingModel, replayFetch, replayModel, runRecorder } from "../evals/lib/record.js";
import { runCase } from "../evals/lib/runner.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const folders: string[] = [];
const folder = () => {
  const made = mkdtempSync(path.join(tmpdir(), "llf-cassette-"));
  folders.push(made);
  return made;
};
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** A streamed response that arrives in exactly these pieces. */
function pieces(chunks: Uint8Array[], type = "text/event-stream"): Response {
  let next = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(chunks[next++]!);
      else controller.close();
    },
  }), { headers: { "Content-Type": type } });
}

/** The text of server-sent events cut at these byte offsets, one of them inside a Hebrew letter. */
function cut(events: unknown[], at: number[]): Uint8Array[] {
  const bytes = utf8(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""));
  const out: Uint8Array[] = [];
  let from = 0;
  for (const to of [...[...new Set(at)].sort((left, right) => left - right), bytes.length]) {
    out.push(bytes.slice(from, to));
    from = to;
  }
  return out;
}

/** The offset of the second byte of the first Hebrew letter: a cut there splits the letter. */
const insideHebrew = (events: unknown[]) => Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")).indexOf(Buffer.from("ש")) + 1;

async function readPieces(response: Response): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

const REQUEST: ModelRequest = { system: "Be brief.", messages: [{ role: "user", parts: [{ text: "מה שלומך?" }] }] };

const STREAMS: Array<{ name: string; events: unknown[]; adapter: (fetch: typeof globalThis.fetch) => ModelAdapter }> = [
  {
    name: "Gemini",
    events: [
      { candidates: [{ content: { role: "model", parts: [{ text: "שלום, " }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "הכול טוב." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 } },
    ],
    adapter: (fetch) => gemini(geminiApi({ apiKey: "test-key", model: "gemini-test" }), { fetch }),
  },
  {
    name: "OpenAI",
    events: [
      { id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, delta: { role: "assistant", content: "שלום, " }, finish_reason: null }] },
      { id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, delta: { content: "הכול טוב." }, finish_reason: "stop" }] },
      { id: "chatcmpl-1", model: "gpt-test", choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      "[DONE]",
    ],
    adapter: (fetch) => openAiCompatible({ model: "gpt-test", apiKey: "test-key", fetch }),
  },
  {
    name: "Claude",
    events: [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 12, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "שלום, " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "הכול טוב." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ],
    adapter: (fetch) => anthropic({ model: "claude-test", apiKey: "test-key", fetch }),
  },
];

describe("record and replay of a stream (evals/lib/record.ts)", () => {
  for (const { name, events, adapter } of STREAMS) {
    it(`gives back a ${name} stream in the pieces it arrived in, and the same reply`, async () => {
      const dir = folder();
      // Three cuts: inside the first event's JSON, inside a Hebrew letter, and between two events.
      const sent = cut(events, [20, insideHebrew(events), Buffer.from(`data: ${JSON.stringify(events[0])}\n\n`).length]);
      let posted: { url: string; body: string } | undefined;
      const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
        posted = { url: String(input), body: String(init?.body) };
        return pieces(sent);
      }) as typeof fetch;

      const live: string[] = [];
      const first = await adapter(recordingFetch(dir, { fetch: upstream })).send(REQUEST, { onText: (delta) => live.push(delta) });
      const replayed: string[] = [];
      const replay = replayFetch(dir);
      const again = await adapter(replay).send(REQUEST, { onText: (delta) => replayed.push(delta) });

      expect(first.text).toBe("שלום, הכול טוב.");
      expect(again).toEqual(first);
      expect(replayed.join("")).toBe(live.join(""));
      expect(replay.misses).toEqual([]);
      expect(replay.unused()).toEqual([]);
      // The cut inside a letter is kept as bytes; the others as text.
      const [entry] = readCassette(dir);
      const chunks = (entry!.response as { chunks: unknown[] }).chunks;
      expect(chunks).toHaveLength(sent.length);
      expect(chunks.some((chunk) => typeof chunk === "object")).toBe(true);
      // Byte for byte, piece by piece.
      const back = await readPieces(await replayFetch(dir)(posted!.url, { method: "POST", body: posted!.body }));
      expect(back.map((piece) => Buffer.from(piece).toString("hex"))).toEqual(sent.map((piece) => Buffer.from(piece).toString("hex")));
    });
  }

  it("hands a stream on as it arrives, before it ends", async () => {
    const dir = folder();
    let release!: () => void;
    const later = new Promise<void>((resolve) => { release = resolve; });
    const [one, two] = cut(STREAMS[0]!.events, [Buffer.from(`data: ${JSON.stringify(STREAMS[0]!.events[0])}\n\n`).length]);
    const upstream = (async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(one!);
        await later;
        controller.enqueue(two!);
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
    const response = await recordingFetch(dir, { fetch: upstream })("https://x.test/v1/models/m:streamGenerateContent?alt=sse", { method: "POST", body: "{}" });
    const reader = response.body!.getReader();
    // The first piece arrives while the second is held back, and nothing is written yet.
    expect(Buffer.from((await reader.read()).value!).equals(Buffer.from(one!))).toBe(true);
    expect(readCassette(dir)).toEqual([]);
    release();
    expect(Buffer.from((await reader.read()).value!).equals(Buffer.from(two!))).toBe(true);
    expect((await reader.read()).done).toBe(true);
    expect((readCassette(dir)[0]!.response as { chunks: unknown[] }).chunks).toHaveLength(2);
  });

  it("writes a stream that failed partway with its pieces and its error, and a replay fails it at the same place", async () => {
    const dir = folder();
    const [one] = cut(STREAMS[0]!.events, [Buffer.from(`data: ${JSON.stringify(STREAMS[0]!.events[0])}\n\n`).length]);
    const upstream = (async () => {
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(one!);
          } else {
            controller.error(new TypeError("terminated: other side closed"));
          }
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const url = "https://x.test/v1/models/m:streamGenerateContent?alt=sse";
    const read = async (fetch: typeof globalThis.fetch) => {
      const got: string[] = [];
      const reader = (await fetch(url, { method: "POST", body: "{}" })).body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return { got, error: undefined };
          got.push(Buffer.from(value).toString());
        }
      } catch (error) {
        return { got, error: error as Error };
      }
    };
    const live = await read(recordingFetch(dir, { fetch: upstream }));
    expect(live.got).toEqual([Buffer.from(one!).toString()]);
    expect(live.error?.message).toBe("terminated: other side closed");
    expect(readCassette(dir)[0]!.response).toMatchObject({ status: 200, chunks: [Buffer.from(one!).toString()], streamError: { name: "TypeError", message: "terminated: other side closed" } });
    const again = await read(replayFetch(dir));
    expect(again.got).toEqual(live.got);
    expect(again.error).toMatchObject({ name: "TypeError", message: "terminated: other side closed" });
  });

  it("keeps a body that is not a stream, and an error status, and replays them in recorded order", async () => {
    const dir = folder();
    const upstream = fakeFetch([
      Response.json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, { status: 503, headers: { "Retry-After": "0" } }),
      Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Ready." }] }, finishReason: "STOP" }] }),
    ]);
    const quick = { retry: { sleep: async () => {} } };
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const ask = (fetch: typeof globalThis.fetch) => askWithFiles({ files, model: gemini(geminiApi({ apiKey: "test-key", model: "gemini-test" }), { fetch }), documentIds: [], messages: [{ role: "user", text: "Ready?" }], ...quick });
    const first = await ask(recordingFetch(dir, { fetch: upstream.fetch }));
    const replay = replayFetch(dir);
    const again = await ask(replay);
    expect(upstream.sent).toHaveLength(2);
    expect(again.text).toBe(first.text);
    expect(readCassette(dir).map((entry) => "status" in entry.response && entry.response.status)).toEqual([503, 200]);
    expect(replay.unused()).toEqual([]);
  });
});

/** A library: a note sent whole and a log searched with the tools, under fixed IDs, or IDs made at ingest. */
async function library(withIds = true): Promise<{ files: LargeFiles; ids: string[] }> {
  const now = () => new Date("2026-11-20T08:00:00.000Z");
  const files = createLargeFiles({ store: new MemoryDocumentStore({ now }), now, budget: { inlineTokens: 1_000 } });
  const notes = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.\n"), ...(withIds ? { id: "notes-1" } : {}) });
  const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)), ...(withIds ? { id: "log-1" } : {}) });
  return { files, ids: [notes.id, log.id] };
}

/** Gemini's replies for a question about the log: a search, then the answer. */
function geminiReplies(documentId: string) {
  return fakeFetch([
    Response.json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "search_document", args: { document_id: documentId, query: "ERROR", mode: "exact" } }, thoughtSignature: "c2lnbmF0dXJl" }] }, finishReason: "STOP" }] }),
    Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "20 errors (app.log L97)." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 9, totalTokenCount: 909 } }),
  ]);
}

async function askLog({ files, ids }: { files: LargeFiles; ids: string[] }, fetch: typeof globalThis.fetch, system = "Be brief.") {
  return askWithFiles({
    files, model: gemini(geminiApi({ apiKey: "test-key", model: "gemini-test" }), { fetch }), documentIds: ids, system,
    messages: [{ role: "user", text: "How many errors are in the log?" }], retry: { retries: 0 },
  });
}

describe("a replay that finds no recording", () => {
  it("names the first field that differs when the system text changed: prompt changed, re-record", async () => {
    const dir = folder();
    await askLog(await library(), recordingFetch(dir, { fetch: geminiReplies("log-1").fetch }));
    const replay = replayFetch(dir, { label: "log-errors" });
    await expect(askLog(await library(), replay, "Be very brief.")).rejects.toThrow();
    const [miss] = replay.misses;
    expect(miss).toBeInstanceOf(CassetteMissError);
    expect(miss!.field).toBe("systemInstruction.parts[0].text");
    expect(miss!.request).toBe(1);
    expect(miss!.message).toMatch(/^prompt changed: re-record\. Case "log-errors", request 1: systemInstruction\.parts\[0\]\.text differs from recording 1/);
  });

  it("matches two replays of one case with fresh ingests under the same IDs, and misses with new IDs", async () => {
    const dir = folder();
    const recorded = await askLog(await library(), recordingFetch(dir, { fetch: geminiReplies("log-1").fetch }));
    for (let run = 0; run < 2; run++) {
      const replay = replayFetch(dir);
      const again = await askLog(await library(), replay);
      expect(again.text).toBe(recorded.text);
      expect(replay.misses).toEqual([]);
      expect(replay.unused()).toEqual([]);
    }
    // IDs made at ingest change the cards and the frame marks: the first request misses.
    const replay = replayFetch(dir);
    await expect(askLog(await library(false), replay)).rejects.toThrow();
    expect(replay.misses[0]).toMatchObject({ request: 1 });
  });

  it("names the URL when only the model or the endpoint changed", async () => {
    const dir = folder();
    const ask = (model: string, fetch: typeof globalThis.fetch) => gemini(geminiApi({ apiKey: "test-key", model }), { fetch }).send(REQUEST);
    await ask("gemini-test", recordingFetch(dir, { fetch: geminiReplies("log-1").fetch }));
    const replay = replayFetch(dir, { label: "c" });
    await expect(ask("gemini-other", replay)).rejects.toThrow();
    const [miss] = replay.misses;
    expect(miss!.field).toBe("url");
    expect(miss!.message).toContain("url differs from recording 1 (was https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent, now https://generativelanguage.googleapis.com/v1beta/models/gemini-other:generateContent)");
  });

  it("matches in order when asked to, and says when the recording has no request left", async () => {
    const dir = folder();
    await askLog(await library(), recordingFetch(dir, { fetch: geminiReplies("log-1").fetch }));
    const ordered = replayFetch(dir, { match: "order" });
    await askLog(await library(), ordered);
    expect(ordered.unused()).toEqual([]);
    // A third request finds nothing.
    await expect(ordered("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent", { method: "POST", body: "{}" })).rejects.toMatchObject({ field: "request", request: 3 });
  });
});

describe("what a cassette keeps", () => {
  it("writes no key, token or project ID: not in a header, not in the URL", async () => {
    const dir = folder();
    const reply = () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Hi." }] }, finishReason: "STOP" }] });
    const openAiReply = () => Response.json({ id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hi." } }] });
    const claudeReply = () => Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
    const record = recordingFetch(dir, { fetch: (async (input: string | URL | Request) => (String(input).includes("openai") ? openAiReply() : String(input).includes("anthropic") ? claudeReply() : reply())) as typeof fetch });
    const secrets = ["acme-secret-project-4711", "ya29.secret-token-123", "AIzaSecretKey123", "AIzaSecretKey456", "sk-secret-789", "sk-ant-secret-000", "azure-secret-111"];
    await gemini(vertexAi({ project: "acme-secret-project-4711", location: "europe-west4", model: "gemini-test", accessToken: "ya29.secret-token-123" }), { fetch: record }).send(REQUEST);
    await gemini(geminiApi({ apiKey: "AIzaSecretKey123", model: "gemini-test" }), { fetch: record }).send(REQUEST);
    await gemini({ url: "https://gateway.example.com/v1/models/gemini-test:generateContent?key=AIzaSecretKey456&alt=json", headers: {} }, { fetch: record }).send(REQUEST);
    await openAiCompatible({ model: "gpt-test", apiKey: "sk-secret-789", fetch: record }).send(REQUEST);
    await openAiCompatible({ model: "gpt-test", url: "https://example.openai.azure.com/openai/deployments/x/chat/completions", headers: { "api-key": "azure-secret-111" }, fetch: record }).send(REQUEST);
    await anthropic({ model: "claude-test", apiKey: "sk-ant-secret-000", stream: false, fetch: record }).send(REQUEST);
    const written = readdirSync(dir).map((name) => readFileSync(path.join(dir, name), "utf8")).join("\n");
    for (const secret of secrets) expect(written, secret).not.toContain(secret);
    const urls = readCassette(dir).map((entry) => entry.request.url);
    expect(urls[0]).toContain("/projects/<project>/");
    expect(urls[2]).toBe("https://gateway.example.com/v1/models/gemini-test:generateContent?alt=json");
    expect(readCassette(dir).map((entry) => Object.entries(entry.request.headers).filter(([name]) => /authorization|api-key/.test(name)).map(([, value]) => value)).flat()).toEqual(Array(5).fill("<redacted>"));
  });

  it("normalizes the URL's key wherever it stands", () => {
    expect(normalizeUrl("https://x.test/a?key=1")).toBe("https://x.test/a");
    expect(normalizeUrl("https://x.test/a?alt=sse&key=1")).toBe("https://x.test/a?alt=sse");
    expect(normalizeUrl("https://x.test/a?key=1&alt=sse")).toBe("https://x.test/a?alt=sse");
    expect(normalizeUrl("https://x.test/v1/projects/p-1/locations/global/x")).toBe("https://x.test/v1/projects/<project>/locations/global/x");
  });

  it("keeps the outline of a request and its hash, not its text", async () => {
    const dir = folder();
    await askLog(await library(), recordingFetch(dir, { fetch: geminiReplies("log-1").fetch }));
    const written = readdirSync(dir).map((name) => readFileSync(path.join(dir, name), "utf8")).join("\n");
    expect(written).not.toContain("The code word is heron");
    expect(written).not.toContain("GET /api/v2/orders");
    const [entry] = readCassette(dir);
    expect(entry!.request.hash).toMatch(/^[0-9a-f]{16}$/);
    // The note and the card, then the question: each text as its length and a hash.
    const text = { text: expect.stringMatching(/^\d+ chars #[0-9a-f]{8}$/) };
    expect(entry!.request.outline).toMatchObject({ contents: [{ role: "user", parts: [text, text] }], systemInstruction: { parts: [text] } });
  });
});

describe("record and replay of a model adapter", () => {
  it("keeps the adapter's id, capabilities and generateText, and replays sends and part reads", async () => {
    const dir = folder();
    const generateText = async () => "Notes (L1).";
    const model = fakeModel([calls([{ id: "c1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact" } }]), says("20 errors.")], { id: "fake-x", contextTokens: 64_000, generateText });
    const { files } = await library();
    const ask = (adapter: ModelAdapter) => askWithFiles({ files, model: adapter, documentIds: ["log-1"], messages: [{ role: "user", text: "How many errors?" }], streamText: true });
    const first = await ask(recordingModel(model, dir));
    const replay = replayModel(dir);
    expect(replay.id).toBe("fake-x");
    expect(replay.capabilities).toEqual(model.capabilities);
    expect(typeof replay.generateText).toBe("function");
    const again = await ask(replay);
    expect(again.text).toBe(first.text);
    expect(again.toolTurns).toEqual(first.toolTurns);
    expect(replay.unused()).toEqual([]);
    // Another question misses, and names where.
    await expect(askWithFiles({ files, model: replayModel(dir, { label: "fake" }), documentIds: ["log-1"], messages: [{ role: "user", text: "How many warnings?" }] })).rejects.toThrow(CassetteMissError);
  });
});

describe("runRecorder", () => {
  it("keeps each request with its usage, and normalizes run IDs and times", async () => {
    const recorder = runRecorder();
    const { files } = await library();
    const model = fakeModel([says("Heron.", { usage: { inputTokens: 40, cachedInputTokens: 10, outputTokens: 2, thoughtTokens: 0 } })]);
    await askWithFiles({ files, model, documentIds: ["notes-1"], messages: [{ role: "user", text: "Code word?" }], onEvent: recorder.listener });
    expect(recorder.requests()).toEqual([expect.objectContaining({ requestId: "req_1", role: "answer", purpose: "direct", outcome: "ok", usage: expect.objectContaining({ inputTokens: 40, cachedInputTokens: 10 }) })]);
    expect(recorder.events().every((event: AskEvent) => event.runId === "<run>" && event.time === 0)).toBe(true);
  });
});

describe("the facts of the eval cases", () => {
  it("reads numbers with thousands separators, and the share of Hebrew letters", () => {
    expect(numbersIn("יתרת הסגירה היא 4,167.90 ש\"ח, ו-118 לחשמל")).toEqual([4167.9, 118]);
    expect(hebrewShare("נמצאו 37 שגיאות PAY-5031 ב-worker-3 (payments-service.log L21280).", ["payments-service.log"])).toBe(1);
    expect(hebrewShare("There are 37 errors.")).toBe(0);
    // A log line quoted in code is the file's language, not the answer's.
    expect(hebrewShare("השגיאה הראשונה נרשמה ב-`09:12:00`:\n```text\n2026-11-12T09:12:00.000Z ERROR [worker-3] PAY-5031 card processor timeout\n```")).toBe(1);
  });

  it("does not take a cited line for a number of the answer", () => {
    const context = { evidence: [], names: {}, formats: {}, linesWith: () => [] };
    expect(checkFact({ number: 750 }, "יש 749 חשבוניות (חשבוניות.csv L750)", context).status).toBe("fail");
    expect(checkFact({ number: 32 }, "בשורה 32 (תקציב.xlsx L34)", context).status).toBe("pass");
    expect(checkFact({ mustNotClaim: { number: 34 } }, "בשורה 32 (תקציב.xlsx L34)", context).status).toBe("pass");
  });

  it("reports a cited-line fact as not checked yet while checkCitations is not written", () => {
    const context = { evidence: [], names: { "policy-1": "policy.docx" }, formats: {}, linesWith: () => [17] };
    const result = checkFact({ mustCite: { document: "policy-1", text: "18" } }, "18 ימים (policy.docx L17)", context);
    let written = true;
    try {
      checkCitations("", [], {});
    } catch (error) {
      written = !/not available yet/.test(String(error));
    }
    // Once checkCitations is written, the fact is checked: here, the line cited holds it.
    expect(result.status).toBe(written ? "pass" : "not checked yet");
  });
  it("writes no project, gateway key or token from a header or a URL parameter it does not know", async () => {
    const dir = folder();
    const upstream = (async () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Hi." }] }, finishReason: "STOP" }] })) as typeof fetch;
    const record = recordingFetch(dir, { fetch: upstream });
    const secrets = ["secret-proj-3", "SECRETTOKEN4", "org-SECRET5", "SECRETKEY6", "SECRETTOKEN7", "SECRETSIG8", "SECRETPASS9"];
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Hi?" }] }] });
    await record(new Request("https://gateway.example.com/v1/models/gemini-test:generateContent?alt=json&api_key=SECRETKEY6&access_token=SECRETTOKEN7&sig=SECRETSIG8", {
      method: "POST", body,
      headers: { "Content-Type": "application/json", "x-goog-user-project": "secret-proj-3", "Helicone-Auth": "Bearer SECRETTOKEN4", "OpenAI-Organization": "org-SECRET5" },
    }));
    await record("https://user:SECRETPASS9@gateway.example.com/v1/x?api-version=2024-10-21", { method: "POST", body });
    const written = readdirSync(dir).map((name) => readFileSync(path.join(dir, name), "utf8")).join("\n");
    for (const secret of secrets) expect(written, secret).not.toContain(secret);
    const [first, second] = readCassette(dir);
    // The names stay, and the values that hold no secret.
    expect(first!.request.headers).toEqual({ "content-type": "application/json", "x-goog-user-project": "<redacted>", "helicone-auth": "<redacted>", "openai-organization": "<redacted>" });
    expect(first!.request.url).toBe("https://gateway.example.com/v1/models/gemini-test:generateContent?alt=json&api_key=<redacted>&access_token=<redacted>&sig=<redacted>");
    expect(second!.request.url).toBe("https://<redacted>@gateway.example.com/v1/x?api-version=2024-10-21");
    // A replay with another token still finds its recording: the hash holds no secret either.
    const replay = replayFetch(dir);
    await replay("https://gateway.example.com/v1/models/gemini-test:generateContent?alt=json&api_key=OTHER&access_token=OTHER&sig=OTHER", { method: "POST", body });
    expect(replay.misses).toEqual([]);
  });

});

describe("the eval runner over a cassette (evals/lib/runner.ts)", () => {
  /** An eval library of the two documents, with what the runner looks up. */
  async function evalLibraryOf(): Promise<EvalLibrary> {
    const { files } = await library();
    return { files, facts: {} as EvalLibrary["facts"], names: { "notes-1": "notes.md", "log-1": "app.log" }, formats: { "notes-1": "markdown", "log-1": "log" }, linesWith: () => [], budgetRowLine: 0 };
  }
  const tiny: EvalCase = { id: "tiny", language: "en", kinds: ["lookup"], turns: [{ question: "What is the code word?", documentIds: ["notes-1", "log-1"], facts: [{ says: "heron" }] }] };
  const answer = () => fakeFetch([sse([{ candidates: [{ content: { role: "model", parts: [{ text: "The code word is heron (notes.md L3)." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 700, cachedContentTokenCount: 100, candidatesTokenCount: 9, totalTokenCount: 709 } }])]);

  it("fails a deliberate change to what is sent with \"prompt changed: re-record\", and passes once recorded again", async () => {
    const cassettes = folder();
    const shared = { model: "gemini-test", library: await evalLibraryOf(), cassettes, apiKey: "test-key" };
    const recorded = await runCase({ ...shared, mode: "record", evalCase: tiny, fetch: answer().fetch });
    expect(recorded.passed).toBe(true);
    expect(recorded.questions[0]).toMatchObject({ requests: 1, inputTokens: 700, cachedInputTokens: 100 });
    expect(readdirSync(path.join(cassettes, "gemini-test", "tiny")).sort()).toEqual([expect.stringMatching(/^001-[0-9a-f]{16}\.json$/), "case.json"]);
    expect(await runCase({ ...shared, mode: "replay", evalCase: tiny })).toMatchObject({ passed: true, replayProblems: [] });

    // The note is planned as a card now: the first request changed.
    const changed: EvalCase = { ...tiny, budget: { inlineTokens: 10 } };
    const failed = await runCase({ ...shared, mode: "replay", evalCase: changed });
    expect(failed.replayProblems![0]).toMatch(/^prompt changed: re-record\. Case "gemini-test\/tiny", request 1: contents\[0\]\.parts\[0\]\.text differs/);

    await runCase({ ...shared, mode: "record", evalCase: changed, fetch: answer().fetch });
    expect(await runCase({ ...shared, mode: "replay", evalCase: changed })).toMatchObject({ passed: true, replayProblems: [] });
  });

  it("fails a replay of a case that was never recorded", async () => {
    const run = await runCase({ mode: "replay", evalCase: tiny, model: "gemini-test", library: await evalLibraryOf(), cassettes: folder() });
    expect(run.replayProblems![0]).toMatch(/^not recorded: /);
  });
});

/** The jobs of a workflow, each as the text of its block. */
function jobsOf(workflow: string): Record<string, string> {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const names = [...body.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)];
  return Object.fromEntries(names.map((match, index) => [match[1]!, body.slice(match.index, names[index + 1]?.index ?? body.length)]));
}
const workflow = (name: string) => readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
/** The lines of a job that are not comments. */
const code = (job: string) => job.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

describe("the workflows of the evals and of a release", () => {
  it("replays the evals in CI on every pull request, with no secret", () => {
    const job = jobsOf(workflow("ci.yml"))["evals-replay"];
    expect(job, "an evals-replay job in ci.yml").toBeDefined();
    expect(code(job!)).toContain("npm run eval:replay");
    expect(code(job!)).not.toContain("secrets.");
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; files: string[] });
    expect(Object.keys(scripts.scripts)).toEqual(expect.arrayContaining(["eval:record", "eval:replay", "eval:live"]));
    expect(scripts.files.some((entry) => entry.startsWith("evals"))).toBe(false);
  });

  it("runs the live evals weekly and on dispatch, and skips them with a message without the key", () => {
    const text = workflow("evals.yml");
    expect(text).toMatch(/^ {2}workflow_dispatch:/m);
    expect(text).toMatch(/^ {2}schedule:\n\s+- cron: "[^"]+"/m);
    const live = code(jobsOf(text).live ?? "");
    expect(live).toContain("GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}");
    expect(live).toMatch(/if \[ -z "\$\{?GEMINI_API_KEY\}?" \]/);
    expect(live).toMatch(/::notice[^\n]*skipped[^\n]*GEMINI_API_KEY/i);
    expect(live).toContain("npm run eval:live");
  });

  it("has a dispatch of the release workflow that builds and checks the tarball, and only dry-runs publish", () => {
    const text = workflow("release.yml");
    const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\njobs:\n"));
    expect(on).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+dry_run:\n(?:\s+[a-z_]+: [^\n]+\n)*?\s+type: boolean\n/);
    expect(on).toMatch(/dry_run:\n(?:\s+[a-z_]+: [^\n]+\n)*?\s+default: true\n/);
    const jobs = jobsOf(text);
    // The build runs on any ref; the tag must match package.json only for a tag.
    expect(code(jobs.build!)).toMatch(/- name: Check the tag matches package.json\n\s+if: github\.ref_type == 'tag'/);
    // Staging: on a pushed tag, or a dispatch on a tag that is no dry run.
    const publish = code(jobs.publish!);
    expect(publish).toMatch(/if: github\.event_name == 'push' \|\| \(inputs\.dry_run == false && github\.ref_type == 'tag'\)/);
    expect(publish).toContain("id-token: write");
    // The dry run: the same checks, no identity token, npm publish --dry-run.
    const dry = code(jobs["publish-dry"] ?? "");
    expect(dry).toContain("needs: build");
    expect(dry).toMatch(/if: github\.event_name == 'workflow_dispatch' && inputs\.dry_run/);
    expect(dry).not.toMatch(/^\s+id-token:/m);
    expect(dry).toContain("sha256sum --check --strict");
    expect(dry).toMatch(/npm publish "\.\/release\/\$\{TARBALL\}" [^\n]*--dry-run/);
    expect(dry).not.toMatch(/npm stage publish "/);
  });
});

describe("the cassettes of the evals (evals/cassettes)", () => {
  const CASSETTES = path.join(ROOT, "evals", "cassettes");
  const filesOf = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesOf(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    } catch {
      return [];
    }
  };

  it("stay under 5 MB in all", () => {
    const bytes = filesOf(CASSETTES).reduce((total, file) => total + statSync(file).size, 0);
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
  });

  it("hold no key: no x-goog-api-key or authorization value, no key parameter, no Google API key", () => {
    const key = process.env.GEMINI_API_KEY;
    for (const file of filesOf(path.join(ROOT, "evals"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/AIza[0-9A-Za-z_-]{30,}/);
      expect(text, file).not.toMatch(/"(?:x-goog-api-key|authorization|api-key|x-api-key)": "(?!<redacted>)/i);
      expect(text, file).not.toMatch(/[?&]key=[^&"\s<]/);
      if (key) expect(text.includes(key), `${file} holds GEMINI_API_KEY`).toBe(false);
    }
  });
});
