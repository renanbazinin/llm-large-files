// The provider's ID of each response and the model that wrote it, in `ModelReply.responseId` and
// `responseModel` (0.10.0): Gemini's `responseId` and `modelVersion`, the `id` and `model` of OpenAI
// and of Claude, streamed or not.
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { fakeFetch, sse } from "llm-large-files/testing";

const request: ModelRequest = { system: "", messages: [{ role: "user", parts: [{ text: "hi" }] }] };
const streamed = { onText: () => undefined };

describe("responseId and responseModel since 0.10.0", () => {
  it("come from Gemini's responseId and modelVersion", async () => {
    const chunk = { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Hi." }] } }], responseId: "resp-7", modelVersion: "gemini-3.8-flash-001" };
    const plain = await gemini(geminiApi({ apiKey: "k", model: "gemini-3.8-flash" }), { fetch: fakeFetch([Response.json(chunk)]).fetch }).send(request);
    expect(plain).toMatchObject({ text: "Hi.", responseId: "resp-7", responseModel: "gemini-3.8-flash-001" });
    const stream = await gemini(geminiApi({ apiKey: "k", model: "gemini-3.8-flash" }), { fetch: fakeFetch([sse([{ ...chunk, candidates: [{ content: { role: "model", parts: [{ text: "Hi." }] } }] }, chunk])]).fetch }).send(request, streamed);
    expect(stream).toMatchObject({ responseId: "resp-7", responseModel: "gemini-3.8-flash-001" });
    // None when Gemini names none.
    const none = await gemini(geminiApi({ apiKey: "k", model: "gemini-3.8-flash" }), { fetch: fakeFetch([Response.json({ candidates: chunk.candidates })]).fetch }).send(request);
    expect("responseId" in none || "responseModel" in none).toBe(false);
  });

  it("come from OpenAI's id and model", async () => {
    const body = { id: "chatcmpl-9", model: "gpt-5.5-2026-08-01", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hi." } }] };
    const plain = await openAiCompatible({ model: "gpt-5.5", apiKey: "k", fetch: fakeFetch([Response.json(body)]).fetch }).send(request);
    expect(plain).toMatchObject({ text: "Hi.", responseId: "chatcmpl-9", responseModel: "gpt-5.5-2026-08-01" });
    const stream = await openAiCompatible({ model: "gpt-5.5", apiKey: "k", fetch: fakeFetch([sse([
      { id: "chatcmpl-9", model: "gpt-5.5-2026-08-01", choices: [{ index: 0, delta: { content: "Hi." } }] },
      { id: "chatcmpl-9", model: "gpt-5.5-2026-08-01", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ])]).fetch }).send(request, streamed);
    expect(stream).toMatchObject({ text: "Hi.", responseId: "chatcmpl-9", responseModel: "gpt-5.5-2026-08-01" });
  });

  it("come from Claude's id and model", async () => {
    const message = { id: "msg_42", type: "message", role: "assistant", model: "claude-opus-5-5-20261101", content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    const plain = await anthropic({ model: "claude-opus-5-5", apiKey: "k", stream: false, fetch: fakeFetch([Response.json(message)]).fetch }).send(request);
    expect(plain).toMatchObject({ text: "Hi.", responseId: "msg_42", responseModel: "claude-opus-5-5-20261101" });
    const stream = await anthropic({ model: "claude-opus-5-5", apiKey: "k", fetch: fakeFetch([sse([
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ])]).fetch }).send(request, streamed);
    expect(stream).toMatchObject({ text: "Hi.", responseId: "msg_42", responseModel: "claude-opus-5-5-20261101" });
  });
});
