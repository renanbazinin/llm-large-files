// The rounds of earlier questions in an OpenAI-compatible server's own form (A2, L15-ext; 0.10.0).
// DeepSeek's thinking mode asks for the `reasoning_content` of every earlier turn in a request with
// tools, and refuses one without it (HTTP 400; api-docs.deepseek.com/guides/thinking_mode, read on
// 2026-11-24). `openAiToolTurns(turns, { native: true })` writes it back for an application that
// keeps Chat Completions messages, and the adapters say they take their own turns back.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type ToolTurn } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { openAiCompatible, openAiToolTurns } from "llm-large-files/openai";
import { fakeFetch, serviceLog, utf8 } from "llm-large-files/testing";

type Json = Record<string, any>;

const search = { id: "call_1", name: "search_document", args: { document_id: "doc-1", query: "ERROR", mode: "exact" } };
const asked = { role: "assistant", content: "", reasoning_content: "The log is large: search it for ERROR.", tool_calls: [{ id: "call_1", type: "function", function: { name: "search_document", arguments: JSON.stringify(search.args) } }] };
const turn: ToolTurn = { role: "tools", version: 1, calls: [{ ...search, result: { total_matching_lines: 51, tool_turns_left: 3 } }], native: { model: "deepseek-v4-pro", turn: asked } };

describe("openAiToolTurns(turns, { native }) since 0.10.0", () => {
  it("writes the reasoning of a round's own assistant message back", () => {
    expect(openAiToolTurns([turn], { native: true })).toEqual([
      { role: "assistant", content: null, reasoning_content: "The log is large: search it for ERROR.", tool_calls: asked.tool_calls },
      { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ total_matching_lines: 51 }) },
    ]);
  });

  it("writes what it wrote in 0.9 without native, or for a round with no reasoning", () => {
    const plain = openAiToolTurns([{ ...turn, native: undefined }]);
    expect(openAiToolTurns([turn])).toEqual(plain);
    expect(openAiToolTurns([{ ...turn, native: undefined }], { native: true })).toEqual(plain);
    // The turn of another provider, or one without reasoning, adds nothing.
    expect(openAiToolTurns([{ ...turn, native: { model: "gemini-3", turn: { role: "model", parts: [] } } }], { native: true })).toEqual(plain);
    expect(openAiToolTurns([{ ...turn, native: { model: "gpt-5.5", turn: { ...asked, reasoning_content: "" } } }], { native: true })).toEqual(plain);
    expect(plain[0]).toEqual({ role: "assistant", content: null, tool_calls: asked.tool_calls });
  });
});

describe("capabilities.nativeRounds of the OpenAI-compatible and Claude adapters, since 0.10.0", () => {
  it("is true: they take their own turns back", () => {
    expect(openAiCompatible({ model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1" }).capabilities.nativeRounds).toBe(true);
    expect(anthropic({ model: "claude-opus-5-5", apiKey: "k" }).capabilities.nativeRounds).toBe(true);
  });

  it("does not send an adapter's own turn to another model of the question", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
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
