// Function parts kept as Gemini's own (0.9.0): they are sized by the JSON of their call or
// response, as the stored rounds are, not as media at a token for each 256 characters. In probe-i1
// a follow-up with its rounds in `contents` was estimated about 15,000 tokens short, and the files
// were planned for room the request did not have.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type ChatMessage, type LargeFiles } from "llm-large-files";
import { fromGeminiContents, gemini, geminiApi, geminiToolTurns, type GeminiContent } from "llm-large-files/gemini";
import { calls, fakeFetch, fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";
import { numberedPdf } from "./pdf-fixtures.js";
import { withPrepareOf09 } from "./prepare-of-09.js";

/** 0.8.2's `maxFileBytes` for the first look of `roomForPages()` (below). */
const ROOM_082 = 6_742_642;
const say = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }] });

describe("a function part of Gemini's own form", () => {
  it("is estimated within a tenth of the same round stored as toolTurns", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
    const tools = files.tools([meta]);
    const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const read = { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 400 } };
    const turns = [{ role: "tools" as const, calls: [{ ...search, result: await tools.execute(search.name, search.args) }, { ...read, result: await tools.execute(read.name, read.args) }] }];
    const estimate = async (messages: ChatMessage[]) => {
      const events: AskEvent[] = [];
      const model = gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: fakeFetch([say("ok")]).fetch });
      await askWithFiles({ files, model, documentIds: [meta.id], messages, onEvent: (event) => events.push(event) });
      const start = events.find((event) => event.type === "request.start");
      return start?.type === "request.start" ? start.estimatedInputTokens! : 0;
    };
    const asTurns = await estimate([{ role: "user", text: "errors?" }, ...turns, { role: "assistant", text: "51." }, { role: "user", text: "again?" }]);
    // Kept as Gemini's own parts: not turned into stored rounds.
    const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "errors?" }] }, ...geminiToolTurns(turns), { role: "model", parts: [{ text: "51." }] }, { role: "user", parts: [{ text: "again?" }] }];
    const messages = fromGeminiContents(contents, { rounds: false });
    expect(messages.some((message) => message.role === "tools")).toBe(false);
    const asNative = await estimate(messages);
    expect(Math.abs(asNative - asTurns) / asTurns).toBeLessThan(0.1);
  });

  it("with a file in it is still sized as media", () => {
    const part = { functionResponse: { name: "own_tool", response: { ok: true }, parts: [{ inlineData: { mimeType: "image/png", data: "iVBOR" } }] } };
    expect(fromGeminiContents([{ role: "user", parts: [part] }])).toEqual([{ role: "user", parts: [{ native: part }] }]);
  });
});

/**
 * The bytes a question's first request is estimated at, as `view_pages` sees them: with a model
 * that does not measure its requests (no `requestBytes`), a look may fill
 * (maxRequestBytes - what is kept free - the estimate) * 3/4 bytes (`maxFileBytes`).
 */
async function roomForPages(before: ChatMessage[] = []): Promise<number | undefined> {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, keepOriginals: ["pdf"], requireOwner: false });
  const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(3) });
  const seen: Array<number | undefined> = [];
  // The PDF sent whole as 0.8.2 sent it: without line numbers, which 0.10.0 added (from a prepare
  // of 0.9, since 0.99.9 removed `numberInline`).
  const spy: LargeFiles = {
    ...withPrepareOf09(files),
    tools: (documents, options) => {
      const set = files.tools(documents, options);
      return {
        ...set,
        executeWithFiles: (name, args, limits, hooks) => {
          seen.push(limits?.maxFileBytes);
          return set.executeWithFiles(name, args, limits, hooks);
        },
      };
    },
  };
  const model = fakeModel([calls([{ name: "view_pages", args: { document_id: meta.id, from_page: 2 } }]), says("Page 2.")]);
  await askWithFiles({ files: spy, model, documentIds: [meta.id], messages: [...before, { role: "user", text: "What is on page 2?" }] });
  expect(seen).toHaveLength(1);
  return seen[0];
}

describe("the bytes of a request", () => {
  it("of a question with nothing missing are those of 0.8.2", async () => {
    // 0.9.0 before its checks counted 2 bytes more in every question: the two quotes of an empty
    // line for documents left out. The number is what 0.8.2's sizing gives this question.
    expect(await roomForPages()).toBe(ROOM_082);
  });

  it("count a thought signature of a function part kept as Gemini's own", async () => {
    // 0.9.0 before its checks sized such a part by the JSON of its call alone: a signature of
    // 40,000 characters added nothing. Its tokens are still those of the call.
    const own = (signature?: string): ChatMessage[] => fromGeminiContents([
      { role: "user", parts: [{ text: "Weather?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Haifa" } }, ...(signature ? { thoughtSignature: signature } : {}) }] },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { celsius: 31 } } }] },
      { role: "model", parts: [{ text: "31 degrees." }] },
    ]);
    const without = await roomForPages(own());
    const withSignature = await roomForPages(own("s".repeat(40_000)));
    expect(without! - withSignature!).toBeGreaterThanOrEqual(Math.floor((40_000 + '"thoughtSignature":"",'.length) * 3 / 4) - 1);
  });
});
