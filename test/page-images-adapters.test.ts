// Where the adapters put a page drawn as an image that a tool returned (0.99.9): `image_url` for
// OpenAI-compatible servers (`imageInput`), an `image` block for Claude, `inlineData` of its type for
// Gemini. The capabilities of an adapter change only with the new option.
import { describe, expect, it } from "vitest";
import type { ModelRequest, ToolCall, ToolFile } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { fakeFetch } from "llm-large-files/testing";

type Json = Record<string, any>;

const JPEG: ToolFile = { name: "page-2.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) };
const PDF: ToolFile = { name: "pages-2.pdf", mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) };
const data = (file: ToolFile) => Buffer.from(file.bytes).toString("base64");
const look: ToolCall = { id: "call_1", name: "view_pages", args: { document_id: "doc_1", from_page: 2 } };
const RESULT = { document: "report.pdf", pages: "2", total_pages: 6, images: ["page-2.jpg"] };
/** A question, the call of view_pages and its answer with one file. */
const lookedAt = (file: ToolFile): ModelRequest => ({
  system: "",
  messages: [
    { role: "user", parts: [{ text: "What does the chart on page 2 show?" }] },
    { role: "tools", calls: [look], answers: [{ call: look, result: RESULT, files: [file] }] },
  ],
});

const openAiReply = () => Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Sales by month." } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const claudeReply = () => Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Sales by month." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } });
const geminiReply = () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Sales by month." }] }, finishReason: "STOP" }] });

describe("openAiCompatible() and page images", () => {
  it("takes images beside with imageInput: an image_url part after the tool messages", async () => {
    const server = fakeFetch([openAiReply()]);
    const model = openAiCompatible({ model: "deepseek-v4-flash", imageInput: true, fetch: server.fetch });
    expect(model.capabilities).toEqual({ toolFiles: "beside", pageTokens: 1_000, toolFileTypes: ["image/png", "image/jpeg"] });
    await model.send(lookedAt(JPEG));
    const messages = server.sent[0]!.body.messages as Json[];
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: JSON.stringify(RESULT) });
    expect(messages[3]).toEqual({ role: "user", content: [
      { type: "text", text: "page-2.jpg (returned by view_pages):" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data(JPEG)}` } },
    ] });
  });

  it("lists PDF first with pdfInput and imageInput, and keeps the object of 0.10 without imageInput", async () => {
    expect(openAiCompatible({ model: "gpt-5.5", pdfInput: true, imageInput: true }).capabilities).toEqual({ toolFiles: "beside", pageTokens: 1_000, toolFileTypes: ["application/pdf", "image/png", "image/jpeg"] });
    expect(openAiCompatible({ model: "gpt-5.5", pdfInput: true }).capabilities).toEqual({ toolFiles: "beside", pageTokens: 1_000 });
    expect(openAiCompatible({ model: "gpt-5.5" }).capabilities).toEqual({ toolFiles: "none", pageTokens: 1_000 });
    // A PDF still goes as a file part.
    const server = fakeFetch([openAiReply()]);
    await openAiCompatible({ model: "gpt-5.5", pdfInput: true, imageInput: true, fetch: server.fetch }).send(lookedAt(PDF));
    expect((server.sent[0]!.body.messages as Json[]).at(-1)!.content[1]).toEqual({ type: "file", file: { filename: "pages-2.pdf", file_data: `data:application/pdf;base64,${data(PDF)}` } });
    // Without either option, no file goes.
    const none = fakeFetch([openAiReply()]);
    await openAiCompatible({ model: "gpt-5.5", fetch: none.fetch }).send(lookedAt(JPEG));
    expect((none.sent[0]!.body.messages as Json[]).map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });
});

describe("anthropic() and page images", () => {
  it("sends an image tool file as an image block, inside the tool result and beside it", async () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: data(JPEG) } };
    const inside = fakeFetch([claudeReply()]);
    await anthropic({ model: "claude-opus-5-5", apiKey: "k", stream: false, cache: false, fetch: inside.fetch }).send(lookedAt(JPEG));
    const insideTurn = (inside.sent[0]!.body.messages as Json[]).at(-1)!;
    expect(insideTurn.content).toEqual([{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: JSON.stringify(RESULT) }, image] }]);

    const beside = fakeFetch([claudeReply()]);
    await anthropic({ model: "claude-opus-5-5", apiKey: "k", stream: false, cache: false, toolFilePlacement: "beside", fetch: beside.fetch }).send(lookedAt(JPEG));
    expect((beside.sent[0]!.body.messages as Json[]).at(-1)!.content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: JSON.stringify(RESULT) },
      { type: "text", text: "page-2.jpg (returned by view_pages):" },
      image,
    ]);
    // A PDF is still a document block.
    const pdf = fakeFetch([claudeReply()]);
    await anthropic({ model: "claude-opus-5-5", apiKey: "k", stream: false, cache: false, fetch: pdf.fetch }).send(lookedAt(PDF));
    expect((pdf.sent[0]!.body.messages as Json[]).at(-1)!.content[0].content[1]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data(PDF) } });
  });
});

describe("gemini() and page images", () => {
  it("sends an image tool file as inlineData of its type, inside and beside", async () => {
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-3.5-flash-lite" });
    const inside = fakeFetch([geminiReply()]);
    await gemini(endpoint, { fetch: inside.fetch }).send(lookedAt(JPEG));
    const response = (inside.sent[0]!.body.contents as Json[]).at(-1)!.parts[0].functionResponse;
    // `images` is a list: Gemini's reference by file name goes in `files`.
    expect(response).toEqual({
      name: "view_pages", id: "call_1",
      response: { ...RESULT, files: [{ $ref: "page-2.jpg" }] },
      parts: [{ inlineData: { mimeType: "image/jpeg", displayName: "page-2.jpg", data: data(JPEG) } }],
    });
    const beside = fakeFetch([geminiReply()]);
    await gemini(endpoint, { toolFilePlacement: "beside", fetch: beside.fetch }).send(lookedAt(JPEG));
    expect((beside.sent[0]!.body.contents as Json[]).at(-1)).toEqual({ role: "user", parts: [
      { text: "page-2.jpg (returned by view_pages):" },
      { inlineData: { mimeType: "image/jpeg", data: data(JPEG) } },
    ] });
  });
});
