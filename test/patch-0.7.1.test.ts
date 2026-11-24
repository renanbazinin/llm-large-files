// Fixes of the 0.7.1 patch, from the code review of 0.5.0 (LLF-…). Each test failed before its fix.
import "./load-pdf-libraries.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DEFAULT_BUDGET,
  estimateTokens,
  FileDocumentStore,
  MemoryDocumentStore,
  ModelRequestError,
  partialResultOf,
  type AskEvent,
  type GenerateText,
  type ModelAdapter,
  type ModelMessage,
  type ModelReply,
  type ModelRequest,
  type ModelToolRound,
  type RetryOptions,
  UsageMeter,
  withRetry,
} from "llm-large-files";
import { createGeminiGenerateText, gemini, vertexAi, vertexHost } from "llm-large-files/gemini";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";
import { numberedPdf } from "./pdf-fixtures.js";
import { Limiter } from "../src/limiter.js";

const question = (text: string) => [{ role: "user" as const, text }];
const quick = (): RetryOptions => ({ random: () => 1, sleep: async () => undefined });
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");

async function largeLog(lines = 5_000, budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(lines)) });
  return { files, meta };
}

describe("LLF-040: what a refusal showed lasts for the rest of the question", () => {
  it("does not fall back to twice the estimate after the next good reply, and overflows only once", async () => {
    const { files, meta } = await largeLog(20_000, { contextTokens: 200_000 });
    // A provider that counts four times the library's estimate, and takes 120,000 of its tokens.
    const window = 120_000;
    const counted = (messages: ModelMessage[]) => 4 * estimateTokens(JSON.stringify(messages));
    let refusals = 0;
    let turn = 0;
    const model = fakeModel([(request) => {
      const tokens = counted(request.messages);
      if (tokens > window) {
        refusals++;
        return new ModelRequestError(`This model's maximum context length is ${window} tokens. However, your messages resulted in ${tokens} tokens.`, 400);
      }
      turn++;
      if (turn > 30) return says("Done.", { usage: { inputTokens: tokens } });
      const from = 1 + (turn - 1) * 50;
      return calls([{ name: "read_document", args: { document_id: meta.id, start_line: from, end_line: from + 49 } }], { usage: { inputTokens: tokens } });
    }]);
    // No ceiling on input tokens: 30 tool turns near the window pass the default one of 0.10.0.
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), retry: quick(), limits: { toolTurns: 40, inputTokens: Infinity } });
    expect(result.answered).toBe(true);
    expect(refusals).toBe(1);
    expect(roundsOf(model.requests.at(-1)!.messages).length).toBeGreaterThan(0);
  });
});

describe("LLF-041: a model's pageTokens that is missing or not a number", () => {
  it("counts a page as 1,000 tokens, so the question keeps its limit of pages", async () => {
    // Half of 6,000 reserved tokens, at 1,000 a page: three pages for the question.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget: { reservedTokens: 6_000 } });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(8) });
    for (const pageTokens of [undefined, Number.NaN]) {
      const model = fakeModel([
        calls([{ name: "view_pages", args: { document_id: meta.id, from_page: 1, to_page: 5 } }]),
        says("Seen."),
      ], { pageTokens: pageTokens as unknown as number });
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What is on the first pages?") });
      expect(result.answered).toBe(true);
      const shown = roundsOf(model.requests[1]!.messages)[0]!.answers[0]!;
      expect(shown.result).toMatchObject({ pages: "1-3" });
      expect(shown.files).toHaveLength(1);
    }
  });

  it("does not offer view_pages to a model whose toolFiles is missing", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(3) });
    const model = fakeModel([says("From the text.")], { toolFiles: undefined as unknown as "none" });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });
    expect((model.requests[0]!.tools ?? []).map((tool) => tool.name)).not.toContain("view_pages");
  });
});

describe("LLF-007: the number options of createLargeFiles", () => {
  const store = () => new MemoryDocumentStore();
  // What `Number(process.env.X)` gives for a variable that is not set.
  const unset = Number(process.env.LLF_NOT_SET_ANYWHERE);

  it("refuses NaN, which hung every scan of a document read by range or failed every upload", () => {
    for (const name of ["ttlMs", "maxUploadBytes", "cacheBytes", "cacheSize", "wholeDocumentBytes", "scanChunkBytes", "maxConcurrentScans", "scannedPdfPages"] as const) {
      expect(() => createLargeFiles({ store: store(), [name]: unset }), name).toThrow(RangeError);
      expect(() => createLargeFiles({ store: store(), [name]: unset }), name).toThrow(`${name} must be a`);
    }
  });

  it("refuses a value that is not a number, and an endless scanChunkBytes", () => {
    expect(() => createLargeFiles({ store: store(), maxConcurrentScans: "4" as unknown as number })).toThrow(new TypeError('maxConcurrentScans must be a number, and is "4".'));
    expect(() => createLargeFiles({ store: store(), scanChunkBytes: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("still takes what it took before: Infinity where it means no limit, and values it raises to the least", () => {
    expect(() => createLargeFiles({ store: store(), ttlMs: Number.POSITIVE_INFINITY, wholeDocumentBytes: Number.POSITIVE_INFINITY, cacheBytes: Number.POSITIVE_INFINITY, maxConcurrentScans: Number.POSITIVE_INFINITY })).not.toThrow();
    expect(() => createLargeFiles({ store: store(), maxConcurrentScans: 0, scanChunkBytes: 0, cacheBytes: -1 })).not.toThrow();
  });

  it("gives a Limiter of NaN or 0 one slot, rather than none", async () => {
    for (const max of [Number.NaN, 0, -3]) {
      const limiter = new Limiter(max);
      const release = await limiter.acquire();
      expect(limiter.load).toEqual({ active: 1, waiting: 0 });
      const second = limiter.acquire();
      expect(limiter.load).toEqual({ active: 1, waiting: 1 });
      release();
      (await second)();
      expect(limiter.load).toEqual({ active: 0, waiting: 0 });
    }
  });
});

describe("LLF-008: the limits of a question", () => {
  it("refuses NaN in any field before a request is made", async () => {
    const { files, meta } = await largeLog(2_000);
    for (const field of ["toolTurns", "callsPerTurn", "wholeDocumentReads", "inputTokens", "requests"] as const) {
      const model = fakeModel([says("Answer.")]);
      const failure = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), limits: { [field]: Number.NaN } }).catch((error: unknown) => error);
      expect(failure, field).toBeInstanceOf(RangeError);
      expect((failure as Error).message).toBe(`limits.${field} must be a number, and is NaN. Leave it out for the default.`);
      expect(model.requests).toHaveLength(0);
    }
  });

  it("refuses a value that is not a number, and keeps Infinity as no ceiling", async () => {
    const { files, meta } = await largeLog(2_000);
    const model = fakeModel([says("Answer.")]);
    await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), limits: { requests: "5" as unknown as number } })).rejects.toThrow(new TypeError('limits.requests must be a number, and is "5".'));
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), limits: { inputTokens: Number.POSITIVE_INFINITY, requests: Number.POSITIVE_INFINITY } });
    expect(result.answered).toBe(true);
  });

  it("refuses a maxWholeDocumentReads of NaN in a tool set, which allowed any number of whole reads", async () => {
    const { files, meta } = await largeLog(2_000);
    expect(() => files.tools([meta], { maxWholeDocumentReads: Number.NaN })).toThrow(new RangeError("maxWholeDocumentReads must be a number, and is NaN."));
    expect(() => files.tools([meta], { maxWholeDocumentReads: "2" as unknown as number })).toThrow(new TypeError('maxWholeDocumentReads must be a number, and is "2".'));
  });
});

describe("LLF-010: questions stopped by one shared signal", () => {
  it("never give one question's partial result for another's", async () => {
    const { files, meta } = await largeLog(2_000);
    const controller = new AbortController();
    let searching = 0;
    let allSearched!: () => void;
    const searched = new Promise<void>((resolve) => (allSearched = resolve));
    const modelOf = (id: string) => fakeModel([
      calls([{ name: "search_document", args: { document_id: meta.id, query: id === "A" ? "ERROR" : "WARN", mode: "exact" } }], { usage: { inputTokens: 100 } }),
      // The second request waits until the question is stopped.
      (_request, _call, hooks) => {
        if (++searching === 2) allSearched();
        return new Promise((_resolve, reject) => hooks.signal?.addEventListener("abort", () => reject(hooks.signal!.reason), { once: true }));
      },
    ], { id });
    const errors: Record<string, AskEvent[]> = { A: [], B: [] };
    const ask = (id: string) => askWithFiles({
      files,
      model: modelOf(id),
      documentIds: [meta.id],
      messages: question("?"),
      // Each question joins the server's signal, as a web app does: the reason passes on as it is.
      signal: AbortSignal.any([controller.signal]),
      onEvent: (event) => void (event.type === "run.error" && errors[id]!.push(event)),
    }).catch((error: unknown) => error);
    const both = Promise.all([ask("A"), ask("B")]);
    await searched;
    controller.abort();
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(a).toBe(controller.signal.reason);
    // The same object for both: neither question's result is given for it.
    expect(partialResultOf(a)).toBeUndefined();
    // Each question's own run.error still carries its own.
    for (const id of ["A", "B"]) {
      const event = errors[id]![0] as Extract<AskEvent, { type: "run.error" }>;
      expect(Object.keys(event.partial!.usage.byModel)).toEqual([id]);
    }
  });

  it("still gives the partial result of a question stopped by a signal of its own", async () => {
    const { files, meta } = await largeLog(2_000);
    const controller = new AbortController();
    const model = fakeModel([
      calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }], { usage: { inputTokens: 100 } }),
      (_request, _call, hooks) => {
        queueMicrotask(() => controller.abort());
        return new Promise((_resolve, reject) => hooks.signal?.addEventListener("abort", () => reject(hooks.signal!.reason), { once: true }));
      },
    ]);
    const error = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), signal: controller.signal }).catch((thrown: unknown) => thrown);
    expect(error).toBe(controller.signal.reason);
    expect(partialResultOf(error)).toMatchObject({ answered: false, usage: { requests: 1, inputTokens: 100 } });
  });
});

describe("LLF-013: a U+FEFF that starts a range of a document read by range", () => {
  it("is kept, so the search of the document works and a read gives the line as it is", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "large-files-bom-"));
    try {
      const files = createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0, scanChunkBytes: 1 });
      // Ingest drops a U+FEFF inside the text since 0.6.0. A document stored before it kept one: "€",
      // three bytes and one character like U+FEFF, holds its place and is swapped in the stored text.
      const lines = Array.from({ length: 40 }, (_, n) => `first file line ${n + 1}`);
      const meta = await files.ingest({ name: "all.log", bytes: utf8([...lines, "€second file line 1", "second needle", ""].join("\n")) });
      const textFile = path.join(directory, `${meta.id}.txt`);
      await writeFile(textFile, (await readFile(textFile, "utf8")).replace("€", "\uFEFF"));
      const tools = files.tools([meta]);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await tools.execute("search_document", { document_id: meta.id, query: "needle", mode: "exact" })).toMatchObject({ total_matching_lines: 1 });
      }
      const read = await tools.execute("read_document", { document_id: meta.id, start_line: 41, end_line: 42 }) as { text: string };
      expect(read.text).toContain("41| \uFEFFsecond file line 1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("LLF-028: Gemini and empty text", () => {
  it("leaves out empty text parts, and a turn left with none, which Vertex AI refuses", async () => {
    const sent: Array<Record<string, any>> = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
    }) as unknown as typeof globalThis.fetch;
    const model = gemini({ url: "https://gemini.test/v1beta/models/m:generateContent", headers: {} }, { fetch });
    await model.send({
      system: "",
      messages: [
        { role: "user", parts: [{ text: "q1" }] },
        // A stored answer of a question that got none.
        { role: "assistant", parts: [{ text: "" }] },
        { role: "user", parts: [{ text: "" }, { text: "q2" }, { native: { inlineData: { mimeType: "image/png", data: "AA==" } }, text: "" }] },
      ],
    });
    expect(sent[0]!.contents).toEqual([
      { role: "user", parts: [{ text: "q1" }] },
      { role: "user", parts: [{ text: "q2" }, { inlineData: { mimeType: "image/png", data: "AA==" } }] },
    ]);
  });
});

describe("LLF-029: the location of Vertex AI", () => {
  it("is checked, so that it cannot send the access token to another host", () => {
    for (const location of ["attacker.example/x", "attacker.example?", "evil.example#", "user@evil.example", "Europe-West4", "", "us--central1", "-us"]) {
      expect(() => vertexHost(location), location).toThrow(TypeError);
      expect(() => vertexAi({ project: "p", model: "m", location, accessToken: "t" }), location).toThrow(TypeError);
    }
    expect(vertexAi({ project: "p", model: "m", location: "europe-west4", accessToken: "t" }).url)
      .toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/publishers/google/models/m:generateContent");
    expect(vertexHost("global")).toBe("https://aiplatform.googleapis.com");
    expect(vertexHost("us")).toBe("https://aiplatform.us.rep.googleapis.com");
  });
});

describe("LLF-030: a part read whose prompt Gemini blocked", () => {
  it("fails with the block reason, and is not sent again", async () => {
    let requests = 0;
    const fetch = (async () => {
      requests++;
      return Response.json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 900, totalTokenCount: 900 } });
    }) as unknown as typeof globalThis.fetch;
    const generate = createGeminiGenerateText({ url: "https://gemini.test/v1beta/models/blocked-part:generateContent", headers: {}, fetchImpl: fetch });
    const read = () => generate({ system: "Take notes.", prompt: "PART", maxOutputTokens: 1_000 });
    // As a whole-file read sends a part: an error without a status is tried once more.
    const error = await withRetry(read, { unknownErrors: "once", retry: quick() }).catch((thrown: unknown) => thrown);
    expect((error as Error).message).toBe("The model returned no text (PROHIBITED_CONTENT).");
    expect(requests).toBe(1);
  });
});

describe("LLF-050: usage by model, for any id", () => {
  it("keeps an id such as __proto__ or constructor as an entry of its own, and leaves Object.prototype alone", () => {
    const meter = new UsageMeter();
    try {
      meter.add("__proto__", { inputTokens: 5 });
      meter.add("constructor", { inputTokens: 7, outputTokens: 1 });
      meter.add("toString", { inputTokens: 2 });
      expect(({} as Record<string, unknown>).requests).toBeUndefined();
      expect(({} as Record<string, unknown>).inputTokens).toBeUndefined();
      expect(Object.keys(meter.totals.byModel)).toEqual(["__proto__", "constructor", "toString"]);
      expect(Object.getOwnPropertyDescriptor(meter.totals.byModel, "__proto__")?.value).toMatchObject({ requests: 1, inputTokens: 5 });
      expect(meter.totals.byModel.constructor).toMatchObject({ requests: 1, inputTokens: 7, outputTokens: 1 });
      expect(meter.totals).toMatchObject({ requests: 3, inputTokens: 14 });
      // The usage of a result is a copy, as `partialResultOf` gives it: the entries stay.
      expect(Object.keys(structuredClone(meter.totals).byModel)).toEqual(["__proto__", "constructor", "toString"]);
    } finally {
      for (const key of ["requests", "inputTokens", "cachedInputTokens", "outputTokens", "thoughtTokens"]) delete (Object.prototype as Record<string, unknown>)[key];
    }
  });
});

describe("LLF-051: a part reader that is a method of an adapter class", () => {
  it("is called with its adapter as this, so a whole-file read works", async () => {
    const { files, meta } = await largeLog(3_000);
    class NotesAdapter implements ModelAdapter {
      readonly id = "notes-adapter";
      readonly capabilities = { toolFiles: "none" as const, pageTokens: 1_000 };
      private readonly prefix = "notes:";
      private turn = 0;
      async send(_request: ModelRequest): Promise<ModelReply> {
        return ++this.turn === 1
          ? { text: "", calls: [{ name: "analyze_whole_document", args: { document_id: meta.id, task: "sum the times" } }] }
          : { text: "Summed.", calls: [] };
      }
      async generateText(..._args: Parameters<GenerateText>): Promise<string> {
        return `${this.prefix} ok`;
      }
    }
    const result = await askWithFiles({ files, model: new NotesAdapter(), documentIds: [meta.id], messages: question("?"), retry: quick() });
    expect(result.steps[0]).toMatch(/^Read all of app\.log for “sum the times” — \d+ parts?/);
    expect(result.steps[0]).not.toContain("failed");
  });
});

describe("LLF-062: the default of ToolCallLimits.maxFileBytes, as its JSDoc gives it", () => {
  it("is 3/8 of (maxRequestBytes − 262,144), the number the code uses", async () => {
    const source = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
    const doc = source.slice(0, source.indexOf("maxFileBytes?: number;"));
    const comment = doc.slice(doc.lastIndexOf("/**")).replace(/\s*\n\s*\*\s*/g, " ");
    expect(comment).toContain("3/8 of (`maxRequestBytes` − 262,144)");
    expect(Math.floor((DEFAULT_BUDGET.maxRequestBytes - 262_144) * 3 / 8)).toBe(3_651_696);
    expect(comment).toContain("3,651,696 bytes for the default budget");
  });
});
