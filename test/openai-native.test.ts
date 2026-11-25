// A DeepSeek turn within one question: its own assistant message, with its `reasoning_content`, goes
// back to the explorer that wrote it, and the model that answers gets the calls alone. DeepSeek's
// thinking mode asks for that reasoning in a request with tools (api-docs.deepseek.com/guides/
// thinking_mode, read on 2026-11-24).
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";
import { fakeFetch, serviceLog, utf8 } from "llm-large-files/testing";

type Json = Record<string, any>;

describe("an OpenAI-compatible adapter's own turns within a question", () => {
  it("does not send an adapter's own turn to another model of the question", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    const call = { id: "call_9", type: "function", function: { name: "search_document", arguments: JSON.stringify({ document_id: meta.id, query: "ERROR", mode: "exact" }) } };
    const deepseek = fakeFetch([(sent) => {
      const answered = (sent.body.messages as Json[]).some((message) => message.role === "tool");
      return Response.json({ id: "r", model: "deepseek-v4-flash", choices: [{ index: 0, finish_reason: answered ? "stop" : "tool_calls", message: answered ? { role: "assistant", content: "DONE", reasoning_content: "Enough." } : { role: "assistant", content: "", reasoning_content: "Search it.", tool_calls: [call] } }] });
    }]);
    const writer = fakeFetch([Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "51 errors." } }] })]);
    const result = await askWithFiles({
      files, documentIds: [meta.id], messages: [{ role: "user", text: "How many errors?" }],
      explorer: openAiCompatible({ model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com/v1", fetch: deepseek.fetch }),
      model: openAiCompatible({ model: "gpt-5.5", fetch: writer.fetch }),
    });
    expect(result.text).toBe("51 errors.");
    // Its own reasoning goes back to the explorer within the question...
    expect((deepseek.sent[1]!.body.messages as Json[]).find((message) => message.role === "assistant")).toMatchObject({ reasoning_content: "Search it." });
    // ...and the other model gets the calls alone.
    const toWriter = (writer.sent[0]!.body.messages as Json[]).find((message) => message.role === "assistant")!;
    expect(toWriter).toEqual({ role: "assistant", content: null, tool_calls: [call] });
  });
});
