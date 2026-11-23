// Function parts kept as Gemini's own (0.9.0): they are sized by the JSON of their call or
// response, as the stored rounds are, not as media at a token for each 256 characters. In probe-i1
// a follow-up with its rounds in `contents` was estimated about 15,000 tokens short, and the files
// were planned for room the request did not have.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type ChatMessage } from "llm-large-files";
import { fromGeminiContents, gemini, geminiApi, geminiToolTurns, type GeminiContent } from "llm-large-files/gemini";
import { fakeFetch, serviceLog, utf8 } from "llm-large-files/testing";

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
