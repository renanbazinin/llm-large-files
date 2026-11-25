// askGemini takes the options of askWithFiles by their type, and gives them to it as they are (0.10.0):
// an option new in askWithFiles reaches the loop with no change to askGemini.
import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type AskOptions } from "llm-large-files";
import { askGemini, gemini, geminiApi } from "llm-large-files/gemini";
import { fakeFetch, utf8 } from "llm-large-files/testing";

/** What askGemini gave askWithFiles: askWithFiles itself still runs. */
const given = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../src/ask.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ask.js")>();
  return {
    ...actual,
    askWithFiles: (options: AskOptions) => {
      given.push(options as unknown as Record<string, unknown>);
      return actual.askWithFiles(options);
    },
  };
});

/** The options each part reader of `gemini()` was made with: createGeminiGenerateText itself still runs. */
const readers = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../src/gemini/generate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gemini/generate.js")>();
  return {
    ...actual,
    createGeminiGenerateText: (options: Parameters<typeof actual.createGeminiGenerateText>[0]) => {
      readers.push(options as unknown as Record<string, unknown>);
      return actual.createGeminiGenerateText(options);
    },
  };
});

const say = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }] });

async function notes() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
  const meta = await files.ingest({ name: "notes.md", bytes: utf8("The code word is heron.\n") });
  return { files, meta };
}

describe("askGemini's options since 0.10.0", () => {
  it("gives askWithFiles every option of its own that askGemini does not name", async () => {
    const { files, meta } = await notes();
    const onToolResult: AskOptions["onToolResult"] = () => undefined;
    given.length = 0;
    const result = await askGemini({
      files,
      endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }),
      fetch: fakeFetch([say("Heron.")]).fetch,
      documentIds: [meta.id],
      messages: [{ role: "user", text: "The code word?" }],
      documentPlacement: "last",
      storeRounds: "compact",
      filteredAnswer: "drop",
      onToolResult,
      limits: { wholeReadsPerQuestion: 1, toolTurns: 4 },
      maxToolCallsPerTurn: 3,
    });
    expect(result.text).toBe("Heron.");
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({ documentPlacement: "last", storeRounds: "compact", filteredAnswer: "drop", onToolResult });
    // limits keep their old names, and win over them.
    expect(given[0]!.limits).toEqual({ callsPerTurn: 3, wholeReadsPerQuestion: 1, toolTurns: 4 });
    // askGemini's own options do not go on: the models carry them.
    for (const own of ["endpoint", "fetch", "contents", "generationConfig", "body", "maxToolCallsPerTurn"]) expect(given[0]).not.toHaveProperty(own);
  });
});

describe("the part-read time limit of gemini() and askGemini, since 0.10.0", () => {
  it("goes to the part reader as it is given, 0 included, and is left to its default when not given", async () => {
    readers.length = 0;
    gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { timeoutMs: 0 });
    gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { timeoutMs: 50 });
    gemini(geminiApi({ apiKey: "k", model: "gemini-test" }));
    expect(readers.map((options) => options.timeoutMs)).toEqual([0, 50, undefined]);
    expect(readers[2]).not.toHaveProperty("timeoutMs");

    // askGemini gives it to both models: the answering one and the explorer.
    const { files, meta } = await notes();
    readers.length = 0;
    await askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test", explorerModel: "gemini-explorer" }), fetch: fakeFetch([say("Heron.")]).fetch, documentIds: [meta.id], messages: [{ role: "user", text: "The code word?" }], timeoutMs: 0 });
    expect(readers.map((options) => [String(options.url).includes("gemini-explorer"), options.timeoutMs])).toEqual([[false, 0], [true, 0]]);
  });
});
