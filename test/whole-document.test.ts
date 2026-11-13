import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type GenerateText } from "llm-large-files";
import { createGeminiGenerateText, THINKING_OUTPUT_TOKENS } from "llm-large-files/gemini";
import { saysNothingRelevant } from "../src/map-reduce.js";
import { estimateParts } from "../src/plan.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const book = (chapters: number) => Array.from({ length: chapters }, (_, i) => `Chapter ${i + 1}\n\n${`The ledger of chapter ${i + 1} was moved again that night. `.repeat(40)}`).join("\n\n");

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** What a model answers: text, why it stopped, and how many tokens it spent thinking. */
type Reply = { text?: string; finishReason?: string; thoughts?: number; status?: number };

/** A stand-in for `generateContent` that records the output limit of each request. */
function fakeModel(reply: (limit: number, call: number) => Reply | Promise<Reply>) {
  const limits: number[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const limit = JSON.parse(String(init?.body)).generationConfig.maxOutputTokens as number;
    limits.push(limit);
    mostInFlight = Math.max(mostInFlight, ++inFlight);
    try {
      const { text = "", finishReason = "STOP", thoughts = 0, status = 200 } = await reply(limit, limits.length);
      if (status !== 200) return Response.json({ error: { message: `max_output_tokens is too large (HTTP ${status})` } }, { status });
      return Response.json({
        candidates: [{ finishReason, content: { role: "model", parts: text ? [{ text }] : [] } }],
        usageMetadata: { thoughtsTokenCount: thoughts },
      });
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  return { fetchImpl, limits, mostInFlight: () => mostInFlight };
}

// What is learned about a model is kept by URL for the life of the process: each test has its own.
let urls = 0;
const freshUrl = () => `https://test.invalid/v1/models/thinking-${++urls}:generateContent`;
const request = { system: "Take notes.", prompt: "<part>…</part>", maxOutputTokens: 4_096 };

describe("a part read on a model that counts its thoughts in the output limit", () => {
  it("asks again with room to think when the limit went on thoughts, and starts there from then on", async () => {
    const model = fakeModel((limit) => (limit < THINKING_OUTPUT_TOKENS
      ? { text: "", finishReason: "MAX_TOKENS", thoughts: 4_093 }
      : { text: "ERROR at 08:00 (L12).", thoughts: 7_000 }));
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl: model.fetchImpl });
    let truncated = false;
    expect(await generate({ ...request, onTruncated: () => { truncated = true; } })).toBe("ERROR at 08:00 (L12).");
    expect(model.limits).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    // The second reply was whole: nothing was cut off.
    expect(truncated).toBe(false);
    // The next part does not pay for the wasted request.
    expect(await generate(request)).toBe("ERROR at 08:00 (L12).");
    expect(model.limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, THINKING_OUTPUT_TOKENS]);
  });

  it("also when a few lines were written after the thoughts", async () => {
    const model = fakeModel((limit) => (limit < THINKING_OUTPUT_TOKENS
      ? { text: "Two lines, then cut", finishReason: "MAX_TOKENS", thoughts: 3_931 }
      : { text: "All the notes." }));
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl: model.fetchImpl });
    expect(await generate(request)).toBe("All the notes.");
    expect(model.limits).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
  });

  it("leaves notes that are simply long as they are, and says that they were cut off", async () => {
    const model = fakeModel(() => ({ text: "A long list…", finishReason: "MAX_TOKENS", thoughts: 0 }));
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl: model.fetchImpl });
    let truncated = false;
    expect(await generate({ ...request, onTruncated: () => { truncated = true; } })).toBe("A long list…");
    expect(model.limits).toEqual([4_096]);
    expect(truncated).toBe(true);
  });

  it("keeps what it has when the larger limit is refused, and does not ask for it again", async () => {
    const model = fakeModel((limit) => (limit < THINKING_OUTPUT_TOKENS
      ? { text: "Two lines, then cut", finishReason: "MAX_TOKENS", thoughts: 3_900 }
      : { status: 400 }));
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl: model.fetchImpl });
    let truncated = false;
    expect(await generate({ ...request, onTruncated: () => { truncated = true; } })).toBe("Two lines, then cut");
    expect(truncated).toBe(true);
    expect(await generate(request)).toBe("Two lines, then cut");
    expect(model.limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, 4_096]);
  });

  it("does not take a failure of another kind for a refusal of the limit", async () => {
    let failed = false;
    const model = fakeModel((limit) => {
      if (limit < THINKING_OUTPUT_TOKENS) return { text: "Two lines, then cut", finishReason: "MAX_TOKENS", thoughts: 3_900 };
      if (!failed) {
        failed = true;
        return { status: 503 };
      }
      return { text: "All the notes." };
    });
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl: model.fetchImpl });
    // The model was overloaded when it was asked again: this part keeps its two lines.
    expect(await generate(request)).toBe("Two lines, then cut");
    // The next one starts with room to think.
    expect(await generate(request)).toBe("All the notes.");
    expect(model.limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, THINKING_OUTPUT_TOKENS]);
  });

  it("reports the refusal when the first reply had no text at all", async () => {
    const model = fakeModel((limit) => (limit < THINKING_OUTPUT_TOKENS ? { text: "", finishReason: "MAX_TOKENS", thoughts: 4_093 } : { status: 400 }));
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl: model.fetchImpl });
    await expect(generate(request)).rejects.toThrow(/too large/);
    await expect(generate(request)).rejects.toThrow(/returned no text \(MAX_TOKENS\)/);
  });

  it("lets the first request find out, so that a whole-file read wastes one request and not four", async () => {
    const model = fakeModel(async (limit) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return limit < THINKING_OUTPUT_TOKENS ? { text: "", finishReason: "MAX_TOKENS", thoughts: 4_093 } : { text: "Notes." };
    });
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl: model.fetchImpl });
    expect(await Promise.all(Array.from({ length: 4 }, () => generate(request)))).toEqual(["Notes.", "Notes.", "Notes.", "Notes."]);
    expect(model.limits).toEqual([4_096, THINKING_OUTPUT_TOKENS, THINKING_OUTPUT_TOKENS, THINKING_OUTPUT_TOKENS, THINKING_OUTPUT_TOKENS]);
    // The other three ran together, once the first had answered.
    expect(model.mostInFlight()).toBe(3);
  });

  it("passes the limit it uses through a generationConfig of the caller", async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)).generationConfig);
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Notes." }] } }] });
    }) as typeof fetch;
    const generate = createGeminiGenerateText({ url: freshUrl(), headers: {}, fetchImpl, generationConfig: (maxOutputTokens) => ({ maxOutputTokens, thinkingConfig: { thinkingLevel: "low" } }) });
    await generate(request);
    expect(seen).toEqual([{ maxOutputTokens: 4_096, thinkingConfig: { thinkingLevel: "low" } }]);
  });
});

describe("the reply of a part that found nothing", () => {
  it("is known whatever a model puts around it, unless it goes on to cite a line", () => {
    for (const reply of ["NOTHING RELEVANT", "Nothing relevant.", "**NOTHING RELEVANT**", "> NOTHING RELEVANT", "`NOTHING RELEVANT`", "\n\n_Nothing relevant in this part._", "NOTHING RELEVANT\n[These notes were cut off at the output limit.]"]) {
      expect(saysNothingRelevant(reply), reply).toBe(true);
    }
    for (const reply of ["The refund was issued (L12).", "NOTHING RELEVANT to refunds, but a chargeback is logged (L88).", "[This part could not be read: quota]", ""]) {
      expect(saysNothingRelevant(reply), reply).toBe(false);
    }
  });

  it("does not count as a part with something relevant", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    const generate: GenerateText = async ({ prompt }) => (prompt.includes("<part>") ? "**NOTHING RELEVANT**" : "An invented summary");
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: "Find a refund" });
    expect(result.parts_with_relevant_content).toBe(0);
    expect(result.answer).toMatch(/^No part of novel\.txt contained anything relevant/);
  });
});

describe("a merge of notes that fails", () => {
  it("loses no notes: the answer is written from them as they are", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { mapChunkTokens: 1_500 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(8)) });
    let merges = 0;
    let finalPrompt = "";
    const generate: GenerateText = async ({ system, prompt }) => {
      if (prompt.includes("<part>")) return `The ledger moved (L${/lines (\d+)-/.exec(prompt)![1]}). ${"It was heavy. ".repeat(120)}`;
      if (system.startsWith("You merge")) {
        merges++;
        throw new Error("quota");
      }
      finalPrompt = prompt;
      return "FINAL";
    };
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: "Where did the ledger go?" });
    // Each merge was tried twice, in one round only.
    expect(merges).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
    expect(result.answer).toBe("FINAL");
    // Every part's notes reached the final step.
    expect(finalPrompt.match(/### Lines \d+-\d+/g)).toHaveLength(result.parts_read as number);
  });
});

describe("a file too large for a whole-document read", () => {
  const budget = { inlineTokens: 10, mapChunkTokens: 1_000, maxMapChunks: 3 };
  const generate: GenerateText = async () => "notes";

  it("is not offered one: not in its card, not in the guide, not among the tools", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget });
    const large = await files.ingest({ name: "novel.txt", bytes: bytes(book(12)) });
    const prepared = await files.prepare([large.id], { tokens: 0, bytes: 0 });
    expect(prepared.blocks.get(large.id)).toContain("It is too large to be analyzed whole.");
    expect(prepared.blocks.get(large.id)).not.toContain("analyze all of it");
    expect(prepared.instruction).not.toContain("analyze_whole_document");
    const tools = files.tools(prepared.plan.searchable, { generate });
    expect(tools.declarations.map((declaration) => declaration.name)).toEqual(["search_document", "read_document", "get_document_overview"]);
    // A call of it still says why, as before.
    expect((await tools.execute("analyze_whole_document", { document_id: large.id, task: "summarize" })).error).toMatch(/over the limit of 3/);
    const overview = await tools.execute("get_document_overview", { document_id: large.id });
    expect(overview.whole_document_analysis).toMatch(/^Not available for this file/);
  });

  it("changes nothing for a file that can be read whole, alone or next to a large one", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget });
    const small = await files.ingest({ name: "story.txt", bytes: bytes(book(2)) });
    const large = await files.ingest({ name: "novel.txt", bytes: bytes(book(12)) });
    const prepared = await files.prepare([small.id, large.id], { tokens: 0, bytes: 0 });
    expect(prepared.blocks.get(small.id)).toContain("or analyze all of it.");
    expect(prepared.blocks.get(large.id)).toContain("It is too large to be analyzed whole.");
    expect(prepared.instruction).toContain("analyze_whole_document");
    const tools = files.tools(prepared.plan.searchable, { generate });
    expect(tools.has("analyze_whole_document")).toBe(true);
    expect(tools.declarations.map((declaration) => declaration.name)).toContain("analyze_whole_document");
    expect((await tools.execute("get_document_overview", { document_id: small.id })).whole_document_analysis).toBeUndefined();
  });
});

describe("get_document_overview of a document read by range", () => {
  it("counts the parts from the metadata, without reading the text", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-overview-"));
    let read = 0;
    class Counting extends FileDocumentStore {
      override async readTextRange(id: string, start: number, end: number) {
        const range = await super.readTextRange(id, start, end);
        read += range?.length ?? 0;
        return range;
      }
    }
    const files = createLargeFiles({ store: new Counting(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 10, mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(40)) });
    const tools = files.tools([meta]);
    read = 0;
    const overview = await tools.execute("get_document_overview", { document_id: meta.id });
    expect(overview.parts_for_whole_document_analysis).toBe(estimateParts(meta, files.budget));
    // The first and the last lines, not the whole text.
    expect(read).toBeLessThan(meta.textBytes / 4);
  });
});
