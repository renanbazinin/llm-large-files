import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, DocumentStoreError, FileDocumentStore, MemoryDocumentStore, resolveBudget, type GenerateText } from "llm-large-files";
import { SearchableDocument, type DocumentSource } from "../src/search.js";
import { createDocumentTools } from "../src/tools.js";
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
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    const generate: GenerateText = async ({ prompt }) => (prompt.includes("<part>") ? "**NOTHING RELEVANT**" : "An invented summary");
    const result = await files.tools([meta], { generate }).execute("analyze_whole_document", { document_id: meta.id, task: "Find a refund" });
    expect(result.parts_with_relevant_content).toBe(0);
    expect(result.answer).toMatch(/^No part of novel\.txt contained anything relevant/);
  });
});

describe("a merge of notes that fails", () => {
  it("loses no notes: the answer is written from them as they are", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 1_500 } });
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

describe("a last step of a whole-document read that fails", () => {
  it("returns the notes of the parts, which were paid for, and says that it is notes only", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    let parts = 0;
    const generate: GenerateText = async ({ system, prompt }) => {
      if (system.startsWith("You write a complete answer")) throw Object.assign(new Error("The request is too large."), { status: 400 });
      parts++;
      return `The ledger moved (L${/lines (\d+)-/.exec(prompt)![1]}).`;
    };
    const tools = files.tools([meta], { generate, retry: { retries: 0 } });
    const result = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Where did the ledger go?" });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ parts_read: parts, parts_with_relevant_content: parts, notes_only: true });
    expect(result.note).toBe("The last step of this read, which writes one answer from the notes of the parts, failed (The model refused the request (HTTP 400).). The answer is those notes: answer from them.");
    expect(String(result.answer).match(/### Lines \d+-\d+\nThe ledger moved \(L\d+\)\./g)).toHaveLength(parts);
  });
});

describe("a whole-document read that could read no part", () => {
  it("is not tried again for the question, and a later call is told that it failed, not that it has an answer", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    let requests = 0;
    const generate: GenerateText = async () => {
      requests++;
      throw Object.assign(new Error("quota exceeded"), { status: 429 });
    };
    const tools = files.tools([meta], { generate, retry: { retries: 0 } });
    const first = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize" });
    expect(first.error).toBe("Could not read any part of novel.txt: The model was busy (HTTP 429).");
    const sent = requests;
    const again = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize it all" });
    expect(again.error).toBe("The whole-file read of novel.txt failed earlier in this question (The model was busy (HTTP 429).), and is not tried again. Use search_document and read_document.");
    expect(requests).toBe(sent);
  });

  it("is not counted when it failed before any model request, so the call can be made again", async () => {
    // A store read by range whose second read (the first piece of the scan that counts the parts,
    // after the index was built from the first) fails once.
    const store = new MemoryDocumentStore();
    let reads = 0;
    Object.assign(store, {
      readTextRange: async (id: string, start: number, end: number) => {
        if (++reads === 2) throw Object.assign(new Error("EIO: i/o error, read '/srv/docs/x.txt'"), { code: "EIO", syscall: "read" });
        const stored = await store.get(id);
        return stored && new TextEncoder().encode(stored.text).slice(start, end);
      },
    });
    const files = createLargeFiles({ requireOwner: false, store, budget: { mapChunkTokens: 3_000 }, wholeDocumentBytes: 0 });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    let requests = 0;
    const generate: GenerateText = async () => {
      requests++;
      return "The ledger moved (L1).";
    };
    const tools = files.tools([meta], { generate });
    const first = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize" });
    expect(first.error).toBe("The document store could not be read (EIO). Try again.");
    expect(requests).toBe(0);
    const again = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize" });
    expect(again.error).toBeUndefined();
    expect(again.answer).toBe("The ledger moved (L1).");
  });
});

describe("the answer of a whole-document read in little room", () => {
  it("is cut at its end, and the other fields of the result are kept", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    const generate: GenerateText = async ({ system }) => (system.startsWith("You write a complete answer") ? `The ledger "moved" (L1).\n${"It was heavy. ".repeat(400)}` : "The ledger moved (L1).");
    const tools = files.tools([meta], { generate });
    const { result } = await tools.executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "Where?" }, { maxResultCharacters: 1_500 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_500);
    expect(result).toMatchObject({ document: "novel.txt", parts_with_relevant_content: expect.any(Number), answer_shortened: expect.any(String) });
    expect(String(result.answer)).toMatch(/^The ledger "moved" \(L1\)\.\nIt was heavy\. [\s\S]*…$/);
  });
});

describe("a file too large for a whole-document read", () => {
  const budget = { inlineTokens: 10, mapChunkTokens: 1_000, maxMapChunks: 3 };
  const generate: GenerateText = async () => "notes";

  it("is not offered one: not in its card, not in the guide, not among the tools", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget });
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
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget });
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

describe("a tool set without a whole-document read (no generate)", () => {
  const budget = { inlineTokens: 10, mapChunkTokens: 1_000, maxMapChunks: 3 };

  it("is not named in the guide or the cards when prepare is told so", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget });
    const small = await files.ingest({ name: "story.txt", bytes: bytes(book(2)) });
    const large = await files.ingest({ name: "novel.txt", bytes: bytes(book(12)) });
    const prepared = await files.prepare([small.id, large.id], { tokens: 0, bytes: 0 }, { wholeDocumentAnalysis: false });
    expect(prepared.plan.searchable).toHaveLength(2);
    expect(prepared.instruction).toContain("search_document");
    expect(prepared.instruction).not.toContain("analyze_whole_document");
    for (const meta of [small, large]) {
      expect(prepared.blocks.get(meta.id)).toContain("Use the document tools to search it and to read line ranges.\n");
      expect(prepared.blocks.get(meta.id)).not.toMatch(/analyze/);
    }
    // The tools it stands for: without generate, there is no such tool.
    expect(files.tools(prepared.plan.searchable).has("analyze_whole_document")).toBe(false);
    // Nothing changes without the option.
    const usual = await files.prepare([small.id, large.id], { tokens: 0, bytes: 0 });
    expect(usual.instruction).toContain("analyze_whole_document");
    expect(usual.blocks.get(small.id)).toContain("or analyze all of it.");
    expect(usual.blocks.get(large.id)).toContain("It is too large to be analyzed whole.");
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
    const files = createLargeFiles({ requireOwner: false, store: new Counting(directory), wholeDocumentBytes: 0, budget: { inlineTokens: 10, mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(40)) });
    const tools = files.tools([meta]);
    read = 0;
    const overview = await tools.execute("get_document_overview", { document_id: meta.id });
    expect(overview.parts_for_whole_document_analysis).toBe(estimateParts(meta, files.budget));
    // The first and the last lines, not the whole text.
    expect(read).toBeLessThan(meta.textBytes / 4);
  });
});

describe("the bookkeeping of whole-document reads, since the review of 0.5.0", () => {
  const eio = () => new DocumentStoreError(Object.assign(new Error("EIO: i/o error, read '/srv/docs/x.txt'"), { code: "EIO", syscall: "read" }));
  async function realSource() {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ requireOwner: false, store, budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    return { meta, inner: new SearchableDocument((await store.get(meta.id))!) };
  }
  /** A source read by range: `chunks` feeds the scan that counts the parts, `readLines` the parts. */
  function wrap(inner: SearchableDocument, hooks: { chunks?: () => void; readLines?: () => void }): DocumentSource {
    return {
      meta: inner.meta,
      lineCount: inner.lineCount,
      characters: inner.characters,
      passageStarts: inner.passageStarts,
      memoryBytes: inner.memoryBytes,
      pageOfLine: (line) => inner.pageOfLine(line),
      pagesOfLines: (from, to) => inner.pagesOfLines(from, to),
      readLines: async (from, to) => {
        hooks.readLines?.();
        return inner.readLines(from, to);
      },
      readText: () => inner.readText(),
      async *chunks() {
        hooks.chunks?.();
        yield* inner.chunks();
      },
    };
  }

  it("does not count a read in which no part could be read from the store: no model request was made", async () => {
    const { meta, inner } = await realSource();
    let down = true;
    const source = wrap(inner, { readLines: () => { if (down) throw eio(); } });
    let requests = 0;
    const generate: GenerateText = async () => {
      requests++;
      return "notes (L1)";
    };
    const tools = createDocumentTools({ load: async () => source, documentIds: [meta.id], budget: resolveBudget({ mapChunkTokens: 3_000 }), generate, retry: { retries: 0 } });
    const first = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize" });
    expect(first.error).toBe("The document store could not be read (EIO). Try again.");
    expect(requests).toBe(0);
    down = false;
    const again = await tools.execute("analyze_whole_document", { document_id: meta.id, task: "Summarize" });
    expect(again.error).toBeUndefined();
    expect(requests).toBeGreaterThan(0);
  });

  it("gives back the count of a read that failed before any model request, not the count of another read of the turn", async () => {
    const { meta, inner } = await realSource();
    let scans = 0;
    const source = wrap(inner, { chunks: () => { if (++scans === 1) throw eio(); } });
    let finals = 0;
    const generate: GenerateText = async ({ system }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (system.startsWith("You write a complete answer")) finals++;
      return "The ledger moved (L1).";
    };
    const tools = createDocumentTools({ load: async () => source, documentIds: [meta.id], budget: resolveBudget({ mapChunkTokens: 3_000 }), generate, maxWholeDocumentReads: 2 });
    const read = (task: string) => tools.execute("analyze_whole_document", { document_id: meta.id, task });
    const first = await Promise.all([read("A"), read("B")]);
    expect(first.map((result) => result.error === undefined)).toEqual([false, true]);
    const second = await Promise.all([read("C"), read("D")]);
    expect(second.filter((result) => result.error === undefined)).toHaveLength(1);
    expect(finals).toBe(2);
  });

  it("cuts an answer full of quotes and line breaks to the room, keeping as much of it as fits, and never half of a character", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 3_000 } });
    const meta = await files.ingest({ name: "novel.txt", bytes: bytes(book(4)) });
    const answers = [`${"\"quoted\" line\n".repeat(4_000)}`, `${"Found 😀 here (L1). ".repeat(3_000)}`];
    for (const answer of answers) {
      const generate: GenerateText = async ({ system }) => (system.startsWith("You write a complete answer") ? answer : "The ledger moved (L1).");
      const tools = files.tools([meta], { generate, maxWholeDocumentReads: 100 });
      for (const limit of [1_500, 1_501, 1_502, 1_503, 5_000]) {
        const { result } = await tools.executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "Where?" }, { maxResultCharacters: limit });
        const json = JSON.stringify(result);
        expect(json.length).toBeLessThanOrEqual(limit);
        // Most of the room holds the answer: it is cut by the size it takes as JSON, not by a guess.
        expect(json.length).toBeGreaterThan(limit - 40);
        expect(String(result.answer)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
        expect(result.answer_shortened).toBeDefined();
      }
    }
  });
});
