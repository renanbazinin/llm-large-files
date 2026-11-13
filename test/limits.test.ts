import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore } from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { grepSource, SearchableDocument } from "../src/search.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const line = (i: number) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} took ${i % 900}ms`;
/** A log with one line that `(a|a)+$` cannot get past: the quick check lets that pattern through. */
const trapped = (lines: number) => [
  ...Array.from({ length: lines }, (_, i) => line(i)),
  `checksum ${"a".repeat(48)}!`,
  ...Array.from({ length: lines }, (_, i) => line(lines + i)),
].join("\n");
const SLOW = "(a|a)+$";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Runs `work` and reports how long it took and how often a timer of another "request" got a turn meanwhile. */
async function watched<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; turns: number }> {
  let turns = 0;
  const beat = setInterval(() => turns++, 5);
  const started = performance.now();
  try {
    const value = await work();
    return { value, ms: performance.now() - started, turns };
  } finally {
    clearInterval(beat);
  }
}

describe("a regex that cannot get past a line", () => {
  it("stops the search at that line, long before the time limit, and keeps what was found", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(trapped(300)) });
    const tools = files.tools([meta]);
    const { value, ms, turns } = await watched(() => tools.execute("search_document", { document_id: meta.id, query: SLOW, mode: "regex" }));
    expect(value.note).toMatch(/stopped early/);
    // The time limit of one search is 3 seconds. Two slices on the line, and it is over.
    expect(ms).toBeLessThan(2_000);
    // Other work ran while it searched.
    expect(turns).toBeGreaterThan(0);
    // The tool set still works.
    expect((await tools.execute("search_document", { document_id: meta.id, query: "request 7 took", mode: "exact" })).total_matching_lines).toBe(1);
  });

  it("does the same for a document read by range", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-limits-"));
    const files = createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0, scanChunkBytes: 4_096, budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(trapped(300)) });
    const tools = files.tools([meta]);
    const { value, ms } = await watched(() => tools.execute("search_document", { document_id: meta.id, query: SLOW, mode: "regex" }));
    expect(value.note).toMatch(/stopped early/);
    expect(ms).toBeLessThan(2_000);
  });

  it("finds the same lines as before for a pattern that is not slow", async () => {
    const text = trapped(300);
    const document = new SearchableDocument({ meta: { id: "doc_x", name: "app.log" } as never, text });
    const result = await grepSource(document, "request 1\\d took 1\\dms$", { regex: true, maxResults: 50, contextLines: 1 });
    const expected = text.split("\n").flatMap((value, index) => (/request 1\d took 1\dms$/.test(value) ? [index + 1] : []));
    expect(result.stoppedEarly).toBe(false);
    expect(result.matches.map((match) => match.line)).toEqual(expected);
    expect(result.totalMatchingLines).toBe(expected.length);
  });
});

describe("the time for regex searches of one tool set", () => {
  it("is counted over all of them, and other searches go on when it is used up", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(trapped(300)) });
    const tools = files.tools([meta], { regexBudgetMs: 120 });
    const first = await tools.execute("search_document", { document_id: meta.id, query: SLOW, mode: "regex" });
    expect(first.note).toMatch(/stopped early/);
    const second = await tools.execute("search_document", { document_id: meta.id, query: "request \\d+", mode: "regex" });
    expect(second.error).toMatch(/time for regex searches is used up/);
    expect((await tools.execute("search_document", { document_id: meta.id, query: "request 7 took", mode: "exact" })).total_matching_lines).toBe(1);
    expect((await tools.execute("search_document", { document_id: meta.id, query: "checksum" })).passages).toHaveLength(1);
    // Another tool set (another question) starts with its own.
    const next = await files.tools([meta]).execute("search_document", { document_id: meta.id, query: "request 7 took", mode: "regex" });
    expect(next.total_matching_lines).toBe(1);
  });
});

describe("regex search and Unicode", () => {
  it("knows letters of any script and characters outside the basic plane, and still takes patterns of the old kind", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 5 } });
    const meta = await files.ingest({ name: "notes.txt", bytes: bytes("שלום עולם\nhello world\nprix: 12 €\nÉcole normale 😀😀\nab@example.com\n") });
    const tools = files.tools([meta]);
    const count = async (query: string) => {
      const result = await tools.execute("search_document", { document_id: meta.id, query, mode: "regex" });
      return result.error ?? result.total_matching_lines;
    };
    expect(await count("^\\p{L}+")).toBe(5);
    expect(await count("\\p{Script=Hebrew}+")).toBe(1);
    expect(await count("😀{2}")).toBe(1);
    expect(await count("école")).toBe(1);
    // Valid only without the Unicode flag: a class with a range that ends in a set.
    expect(await count("[\\w-.]+@example")).toBe(1);
    expect(String(await count("(unclosed"))).toMatch(/Invalid regex/);
  });
});

describe("askGemini and a turn with many tool calls", () => {
  const endpoint = geminiApi({ apiKey: "test-key", model: "gemini-test" });
  const says = (text: string) => ({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }] });

  async function ask(calls: number, options: { maxToolCallsPerTurn?: number } = {}) {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(Array.from({ length: 5_000 }, (_, i) => line(i)).join("\n")) });
    const bodies: Array<Record<string, any>> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length > 1) return Response.json(says("Done."));
      return Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: Array.from({ length: calls }, (_, i) => ({ functionCall: { name: "read_document", args: { document_id: meta.id, start_line: 1 + i * 10, end_line: 5 + i * 10 } } })) } }] });
    });
    const result = await askGemini({ files, endpoint, fetch, documentIds: [meta.id], messages: [{ role: "user", text: "Read it." }], ...options });
    const responses = (bodies[1]!.contents.at(-1).parts as Array<{ functionResponse: { response: Record<string, unknown> } }>).map((part) => part.functionResponse.response);
    return { result, responses };
  }

  it("runs the first eight, and answers the others so that the model can send them again", async () => {
    const { result, responses } = await ask(12);
    // Every call has its answer, in order, as Gemini requires.
    expect(responses).toHaveLength(12);
    expect(responses.slice(0, 8).every((response) => typeof response.text === "string")).toBe(true);
    for (const response of responses.slice(8)) {
      expect(response.error).toMatch(/^Not run: one turn runs at most 8 tool calls/);
      expect(response.tool_turns_left).toBe(10);
    }
    expect(result.steps).toHaveLength(9);
    expect(result.steps.at(-1)).toBe("4 more tool calls in this turn were not run (at most 8 a turn)");
    expect(result).toMatchObject({ text: "Done.", answered: true });
  });

  it("changes nothing for a turn within the limit, and takes another limit", async () => {
    const within = await ask(8);
    expect(within.result.steps).toHaveLength(8);
    expect(within.responses.every((response) => response.error === undefined)).toBe(true);
    const two = await ask(5, { maxToolCallsPerTurn: 2 });
    expect(two.result.steps).toHaveLength(3);
    expect(two.responses.filter((response) => response.error === undefined)).toHaveLength(2);
  });
});
