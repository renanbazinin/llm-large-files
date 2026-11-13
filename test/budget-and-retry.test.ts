import { describe, expect, it } from "vitest";
import { createLargeFiles, DEFAULT_BUDGET, isRetryableStatus, MemoryDocumentStore, resolveBudget, retryAfterMs, withRetry, type GenerateText } from "llm-large-files";
import { httpError, serviceLog, utf8 } from "./fake-model.js";

describe("a budget", () => {
  it("is the one the library always had when nothing is given", () => {
    expect(resolveBudget()).toEqual(DEFAULT_BUDGET);
    expect(resolveBudget({})).toEqual(DEFAULT_BUDGET);
    expect(createLargeFiles({ store: new MemoryDocumentStore() }).budget).toEqual(DEFAULT_BUDGET);
    // A field set to undefined, as an unset setting gives, is a field that was not given.
    expect(resolveBudget({ contextTokens: undefined, inlineTokens: undefined } as never)).toEqual(DEFAULT_BUDGET);
  });

  it("follows the context window in what was left out", () => {
    expect(resolveBudget({ contextTokens: 200_000 })).toEqual({ contextTokens: 200_000, maxRequestBytes: 10_000_000, inlineTokens: 100_000, reservedTokens: 50_000, mapChunkTokens: 100_000, maxMapChunks: 30, toolResultCharacters: 24_000 });
    expect(resolveBudget({ contextTokens: 128_000 })).toMatchObject({ inlineTokens: 64_000, reservedTokens: 32_000, mapChunkTokens: 64_000, toolResultCharacters: 15_360 });
    expect(resolveBudget({ contextTokens: 32_000 })).toMatchObject({ inlineTokens: 16_000, reservedTokens: 8_000, mapChunkTokens: 16_000, toolResultCharacters: 3_840 });
    expect(resolveBudget({ contextTokens: 2_000_000 })).toMatchObject({ inlineTokens: 200_000, reservedTokens: 64_000, mapChunkTokens: 100_000, toolResultCharacters: 24_000 });
    // What was given stays as given.
    expect(resolveBudget({ contextTokens: 128_000, inlineTokens: 100_000, reservedTokens: 16_000 })).toMatchObject({ inlineTokens: 100_000, reservedTokens: 16_000, mapChunkTokens: 64_000 });
  });

  it("sends a small note whole for a model of any size, with only the window set", async () => {
    for (const contextTokens of [1_000_000, 200_000, 128_000, 64_000, 32_000]) {
      const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens } });
      const note = await files.ingest({ name: "note.txt", bytes: utf8("The meeting moved to Tuesday.\n") });
      const prepared = await files.prepare([note.id], { tokens: 3_000, bytes: 12_000 });
      expect(prepared.plan.inline.map((meta) => meta.name), `window ${contextTokens}`).toEqual(["note.txt"]);
      expect(files.budget.mapChunkTokens).toBeLessThan(contextTokens);
    }
  });

  it("refuses values that cannot work together, and values that are no sizes", () => {
    expect(() => createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 64_000, reservedTokens: 64_000 } }))
      .toThrow("budget.reservedTokens (64,000) must be smaller than budget.contextTokens (64,000): nothing would be left for the conversation.");
    expect(() => resolveBudget({ contextTokens: 64_000, mapChunkTokens: 100_000 }))
      .toThrow("budget.mapChunkTokens (100,000) must be smaller than budget.contextTokens (64,000): a part of a whole-file read would not fit the model.");
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "64000"]) {
      expect(() => resolveBudget({ contextTokens: value as never })).toThrow(/^budget\.contextTokens must be a number above 0/);
    }
  });

  it("is made to fit a model's own limits, lowering what was given for a larger one", () => {
    const fitted = resolveBudget({ inlineTokens: 150_000, reservedTokens: 64_000, toolResultCharacters: 24_000 }, { contextTokens: 100_000, maxRequestBytes: 4_000_000 });
    expect(fitted).toEqual({ contextTokens: 100_000, maxRequestBytes: 4_000_000, inlineTokens: 100_000, reservedTokens: 50_000, mapChunkTokens: 50_000, maxMapChunks: 30, toolResultCharacters: 24_000 });
    // A limit that is no smaller than the budget's own changes nothing.
    expect(resolveBudget({ contextTokens: 200_000, reservedTokens: 150_000 }, { contextTokens: 1_000_000, maxRequestBytes: 50_000_000 })).toMatchObject({ contextTokens: 200_000, maxRequestBytes: 10_000_000, reservedTokens: 150_000 });
  });

  it("can be another one for a single request, and the library's own stays as it was", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 150_000 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(1_000)) });
    const base = { tokens: 0, bytes: 0 };
    expect((await files.prepare([log.id], base)).plan.inline).toHaveLength(1);
    expect((await files.prepare([log.id], base, { budget: { inlineTokens: 1_000 } })).plan.searchable).toHaveLength(1);
    expect(files.budgetFor({ contextTokens: 64_000 })).toMatchObject({ contextTokens: 64_000, inlineTokens: 150_000, reservedTokens: 16_000 });
    expect(files.budgetFor(undefined, { contextTokens: 64_000 })).toMatchObject({ contextTokens: 64_000, inlineTokens: 64_000, reservedTokens: 16_000 });
    expect(files.budget.inlineTokens).toBe(150_000);
    // The tools take the same fields: a result cut to 3,000 characters for this tool set alone.
    const small = files.tools([log], { budget: { toolResultCharacters: 3_000 } });
    expect(JSON.stringify(await small.execute("read_document", { document_id: log.id, start_line: 1, end_line: 400 })).length).toBeLessThanOrEqual(3_000);
    expect(small.resultCharacters("read_document")).toBe(3_000);
    expect(files.tools([log]).resultCharacters("read_document")).toBe(24_000);
  });
});

describe("the tools of one question", () => {
  it("cut a result to the room a caller names, and say where to go on", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const tools = files.tools([log]);
    const read = { document_id: log.id, start_line: 1, end_line: 600 };
    const whole = (await tools.executeWithFiles("read_document", read)).result;
    const cut = (await tools.executeWithFiles("read_document", read, { maxResultCharacters: 5_000 })).result;
    expect(JSON.stringify(whole).length).toBeGreaterThan(15_000);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(5_000);
    const [from, to] = String(cut.lines).split("-").map(Number);
    expect(from).toBe(1);
    expect(cut.next_start_line).toBe(to! + 1);
    expect(String(cut.text).split("\n")).toHaveLength(to!);
    // A search is cut the same way, by dropping matches from the end.
    const search = (await tools.executeWithFiles("search_document", { document_id: log.id, query: "INFO", mode: "exact", max_results: 50 }, { maxResultCharacters: 2_000 })).result;
    expect(JSON.stringify(search).length).toBeLessThanOrEqual(2_000);
    expect(search.total_matching_lines).toBeGreaterThan(2_000);
    expect(String(search.note)).toMatch(/^Showing \d+ of 50 results/);
    // Room larger than the tool's own cap changes nothing.
    expect((await tools.executeWithFiles("read_document", read, { maxResultCharacters: 1_000_000 })).result).toEqual(whole);
    expect(tools.resultCharacters("analyze_whole_document")).toBe(40_000);
  });

  it("read a document whole once, and count a read that was refused for its size as none", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 40_000 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const other = await files.ingest({ name: "other.log", bytes: utf8(serviceLog(3_000)) });
    let requests = 0;
    const generate: GenerateText = async () => {
      requests++;
      return "Errors at (L97).";
    };
    const tools = files.tools([log, other], { generate });
    const whole = (id: string) => tools.execute("analyze_whole_document", { document_id: id, task: "List the errors." });
    expect((await whole(log.id)).answer).toBe("Errors at (L97).");
    const used = requests;
    expect((await whole(log.id)).error).toMatch(/^app\.log was already read whole for this question/);
    expect(requests).toBe(used);
    // The limit is for each document.
    expect((await whole(other.id)).answer).toBe("Errors at (L97).");
    // Two calls that arrive together do not both pass.
    const together = files.tools([log], { generate });
    const [first, second] = await Promise.all([together.execute("analyze_whole_document", { document_id: log.id, task: "a" }), together.execute("analyze_whole_document", { document_id: log.id, task: "b" })]);
    expect([typeof first!.answer, typeof second!.error]).toEqual(["string", "string"]);
    expect(files.tools([log], { generate, maxWholeDocumentReads: 0 }).declarations.map((tool) => tool.name)).toContain("analyze_whole_document");

    const tight = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 1_000, maxMapChunks: 3 } });
    const large = await tight.ingest({ name: "large.log", bytes: utf8(serviceLog(3_000)) });
    const refusing = tight.tools([large], { generate });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await refusing.execute("analyze_whole_document", { document_id: large.id, task: "x" })).error).toMatch(/over the limit of 3/);
    }
  });

  it("keep the time for regex searches when several of them are asked for at once", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    // One line that the pattern cannot get past, in a log of ordinary ones.
    const line = (i: number) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} took ${i % 900}ms`;
    const trapped = [...Array.from({ length: 300 }, (_, i) => line(i)), `checksum ${"a".repeat(48)}!`, ...Array.from({ length: 300 }, (_, i) => line(300 + i))].join("\n");
    const meta = await files.ingest({ name: "app.log", bytes: utf8(trapped) });
    const tools = files.tools([meta], { regexBudgetMs: 120 });
    const slow = () => tools.execute("search_document", { document_id: meta.id, query: "(a|a)+$", mode: "regex" });
    const results = await Promise.all([slow(), slow(), slow(), slow()]);
    // The first one uses the time up. The others waited their turn and were told so: asked for at
    // once, each would otherwise have counted the whole time as its own.
    expect(results[0]!.note).toMatch(/stopped early/);
    for (const later of results.slice(1)) expect(later.error).toMatch(/^The time for regex searches is used up/);
    // Searches of other kinds do not wait behind a regex search.
    expect((await tools.execute("search_document", { document_id: meta.id, query: "request 7 took", mode: "exact" })).total_matching_lines).toBe(1);
  });
});

describe("withRetry", () => {
  const quick = (more: object = {}) => {
    const waits: number[] = [];
    return { waits, retry: { random: () => 0, sleep: async (ms: number) => { waits.push(ms); }, ...more } };
  };

  it("retries what another try can mend, with a wait that doubles and is never the same for everyone", async () => {
    for (const status of [0, 408, 409, 429, 500, 502, 503, 504, 529]) expect(isRetryableStatus(status), String(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 413, 422]) expect(isRetryableStatus(status), String(status)).toBe(false);

    let attempts = 0;
    const { retry, waits } = quick();
    const value = await withRetry(async () => {
      if (++attempts < 4) throw httpError(503);
      return "done";
    }, { retry });
    expect(value).toBe("done");
    // With the jitter at its least: half of 500, 1,000 and 2,000.
    expect(waits).toEqual([250, 500, 1_000]);

    attempts = 0;
    const capped = quick({ maxDelayMs: 600, random: () => 1 });
    await expect(withRetry(async () => {
      attempts++;
      throw httpError(500);
    }, { retry: capped.retry })).rejects.toMatchObject({ status: 500 });
    expect(attempts).toBe(4);
    expect(capped.waits).toEqual([500, 600, 600]);
  });

  it("tries an error that says nothing once more at once, when asked to, and never one that names a refusal", async () => {
    let attempts = 0;
    const { retry, waits } = quick();
    const flaky = async () => {
      if (++attempts === 1) throw new Error("socket hang up");
      return "second time";
    };
    await expect(withRetry(flaky, { retry })).rejects.toThrow("socket hang up");
    attempts = 0;
    expect(await withRetry(flaky, { retry, unknownErrors: "once" })).toBe("second time");
    expect(waits).toEqual([]);
    attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new Error("always");
    }, { retry, unknownErrors: "once" })).rejects.toThrow("always");
    expect(attempts).toBe(2);
    attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw httpError(400, "bad request");
    }, { retry, unknownErrors: "once" })).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });

  it("stops waiting when the question is stopped", async () => {
    const stop = new AbortController();
    const pending = withRetry(async () => {
      throw httpError(503);
    }, { retry: { baseDelayMs: 60_000 }, signal: stop.signal });
    setTimeout(() => stop.abort(new Error("stopped")), 10);
    await expect(pending).rejects.toThrow("stopped");
  });

  it("reads the wait a provider asks for", () => {
    const headers = (values: Record<string, string>) => new Headers(values);
    expect(retryAfterMs(headers({ "retry-after": "17" }))).toBe(17_000);
    expect(retryAfterMs(headers({ "retry-after": "1.5" }))).toBe(1_500);
    expect(retryAfterMs(headers({ "retry-after-ms": "250", "retry-after": "17" }))).toBe(250);
    const now = Date.parse("2026-11-13T10:00:00Z");
    expect(retryAfterMs(headers({ "retry-after": "Fri, 13 Nov 2026 10:00:30 GMT" }), undefined, () => now)).toBe(30_000);
    expect(retryAfterMs(headers({}))).toBeUndefined();
    // Gemini says it in the body of the error.
    const body = { error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.Help" }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34.5s" }] } };
    expect(retryAfterMs(headers({}), body)).toBe(34_500);
    expect(retryAfterMs(undefined, { error: { details: "none" } })).toBeUndefined();
  });
});

describe("a whole-file read on a model that is busy", () => {
  it("waits before it asks again, and does not ask again for a request the model refused", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10, mapChunkTokens: 900_000 } });
    const log = await files.ingest({ name: "small.log", bytes: utf8(serviceLog(300)) });
    const waits: number[] = [];
    const retry = { random: () => 1, sleep: async (ms: number) => { waits.push(ms); } };
    let attempts = 0;
    const busy: GenerateText = async () => {
      if (++attempts <= 2) throw httpError(429, "Resource has been exhausted.");
      return "notes (L1)";
    };
    const result = await files.tools([log], { generate: busy, retry }).execute("analyze_whole_document", { document_id: log.id, task: "Summarize." });
    expect(result).toMatchObject({ parts_read: 1, parts_with_relevant_content: 1 });
    expect(waits).toEqual([500, 1_000]);

    attempts = 0;
    waits.length = 0;
    const refused: GenerateText = async () => {
      attempts++;
      throw httpError(400, "The request is not valid.");
    };
    const failed = await files.tools([log], { generate: refused, retry }).execute("analyze_whole_document", { document_id: log.id, task: "Summarize." });
    expect(failed.error).toBe("Could not read any part of small.log: The request is not valid.");
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });
});
