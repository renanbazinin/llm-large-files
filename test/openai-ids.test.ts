// The IDs of OpenAI-compatible tool calls (LLF-034, LLF-035; 0.10.0), from probe p4 of the 0.10.0
// plan: a call that came without an ID is given one, once, in the call and in the turn that goes
// back, so its tool message names the same ID; and a stream without `index` that sends the ID with
// every piece of a call makes one call, not one for each piece.
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelToolRound, ToolDeclaration } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";
import { fakeFetch, sse } from "llm-large-files/testing";

type Json = Record<string, any>;

const tool: ToolDeclaration = { name: "search_document", description: "", parameters: { type: "object", properties: {} } };
const request: ModelRequest = { system: "", messages: [{ role: "user", parts: [{ text: "hi" }] }], tools: [tool] };
const done = Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });

/** The next request of the loop, with the reply's calls answered. */
const roundOf = (reply: Awaited<ReturnType<ReturnType<typeof openAiCompatible>["send"]>>): ModelToolRound => ({ role: "tools", calls: reply.calls, answers: reply.calls.map((call) => ({ call, result: { ok: true } })), raw: reply.raw });

describe("OpenAI-compatible tool calls without an ID, since 0.10.0", () => {
  it("are given one ID, the same in the call, the turn sent back and its tool message", async () => {
    const api = fakeFetch([
      Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
        { type: "function", function: { name: "search_document", arguments: "{\"query\":\"a\"}" } },
        { id: "", type: "function", function: { name: "search_document", arguments: "{\"query\":\"b\"}" } },
        { id: "call_server", type: "function", function: { name: "search_document", arguments: "{\"query\":\"c\"}" } },
      ] } }] }),
      done,
    ]);
    const model = openAiCompatible({ model: "m", apiKey: "k", fetch: api.fetch });
    const reply = await model.send(request);
    const ids = reply.calls.map((call) => call.id);
    expect(ids[0]).toMatch(/^call_[0-9a-f]{24}$/);
    expect(ids[1]).toMatch(/^call_[0-9a-f]{24}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe("call_server");
    await model.send({ ...request, messages: [...request.messages, roundOf(reply)] });
    const sent = api.sent[1]!.body.messages as Json[];
    const assistant = sent.find((message) => message.role === "assistant")!;
    expect(assistant.tool_calls.map((call: Json) => call.id)).toEqual(ids);
    expect(sent.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(ids);
  });

  it("are given one in a stream too", async () => {
    const api = fakeFetch([
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: { name: "search_document", arguments: "{\"query\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]),
      done,
    ]);
    const model = openAiCompatible({ model: "m", apiKey: "k", fetch: api.fetch });
    const reply = await model.send(request, { onText: () => undefined });
    expect(reply.calls).toHaveLength(1);
    const id = reply.calls[0]!.id;
    expect(id).toMatch(/^call_[0-9a-f]{24}$/);
    expect((reply.raw as Json).tool_calls[0].id).toBe(id);
    await model.send({ ...request, messages: [...request.messages, roundOf(reply)] });
    const sent = api.sent[1]!.body.messages as Json[];
    expect(sent.find((message) => message.role === "tool")!.tool_call_id).toBe(id);
  });
});

describe("OpenAI-compatible streams without index, since 0.10.0", () => {
  it("make one call of the pieces that carry the same ID", async () => {
    const api = fakeFetch([sse([
      { choices: [{ delta: { tool_calls: [{ id: "c1", type: "function", function: { name: "search_document", arguments: "{\"query\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "c1", function: { arguments: "\"x\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ])]);
    const reply = await openAiCompatible({ model: "m", apiKey: "k", fetch: api.fetch }).send(request, { onText: () => undefined });
    expect(reply.calls).toEqual([{ id: "c1", name: "search_document", args: { query: "x" } }]);
  });

  it("start a new call at a piece with another ID, and add a piece without one to the last", async () => {
    const api = fakeFetch([sse([
      { choices: [{ delta: { tool_calls: [{ id: "c1", type: "function", function: { name: "search_document", arguments: "{\"query\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: "\"x\"}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "c2", type: "function", function: { name: "search_document", arguments: "{\"query\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "c2", function: { arguments: "\"y\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ])]);
    const reply = await openAiCompatible({ model: "m", apiKey: "k", fetch: api.fetch }).send(request, { onText: () => undefined });
    expect(reply.calls).toEqual([
      { id: "c1", name: "search_document", args: { query: "x" } },
      { id: "c2", name: "search_document", args: { query: "y" } },
    ]);
  });
});
