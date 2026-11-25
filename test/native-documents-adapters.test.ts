// The `documents` option of the built-in adapters (0.99.9): declared only when given, checked when
// the adapter is made, and the files of a turn (`ModelTextMessage.files`) sent first in that turn.
// A file an adapter cannot send is a TypeError.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type ModelRequest, type ToolFile } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { askGemini, gemini, geminiApi } from "llm-large-files/gemini";
import { openAiCompatible, openAiResponses } from "llm-large-files/openai";
import { fakeFetch } from "llm-large-files/testing";
import { pdfWithPictures } from "./pdf-fixtures.js";

type Json = Record<string, any>;

const PDF: ToolFile = { name: "attached-1.pdf", mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) };
const DECK: ToolFile = { name: "attached-2.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: new Uint8Array([80, 75, 3, 4]) };
const PHOTO: ToolFile = { name: "photo.png", mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };
const base64 = (file: ToolFile) => Buffer.from(file.bytes).toString("base64");
/** A request whose user turn carries `files`, with a line and the documents' text after them. */
const withFiles = (files: ToolFile[]): ModelRequest => ({ system: "", messages: [{ role: "user", parts: [{ text: "The file attached above is …" }, { text: "Document text." }, { text: "What is in it?" }], files }] });

const geminiReply = () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "A chart." }] }, finishReason: "STOP" }] });
const openAiReply = () => Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "A chart." } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const claudeReply = () => Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "A chart." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } });
const responsesReply = () => Response.json({ id: "resp_1", object: "response", status: "completed", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "A chart.", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } });

describe("gemini() and askGemini", () => {
  it("declare documents only when given, and send the files as inlineData before the text of the turn", async () => {
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-3.5-flash-lite" });
    expect(gemini(endpoint).capabilities).toEqual({ toolFiles: "inside", pageTokens: 530 });
    const server = fakeFetch([geminiReply()]);
    const model = gemini(endpoint, { documents: { formats: ["pdf", "pptx", "pdf"] }, fetch: server.fetch });
    expect(model.capabilities).toEqual({ toolFiles: "inside", pageTokens: 530, documents: { formats: ["pdf", "pptx"], maxFileBytes: 4_194_304, maxPages: 10 } });
    await model.send(withFiles([PDF, DECK]));
    expect(server.sent[0]!.body.contents).toEqual([{ role: "user", parts: [
      { inlineData: { mimeType: "application/pdf", data: base64(PDF) } },
      { inlineData: { mimeType: DECK.mimeType, data: base64(DECK) } },
      { text: "The file attached above is …" },
      { text: "Document text." },
      { text: "What is in it?" },
    ] }]);
    // A turn with files and no text is kept.
    await model.send({ system: "", messages: [{ role: "user", parts: [{ text: "" }], files: [PHOTO] }] });
    expect(server.sent[1]!.body.contents).toEqual([{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: base64(PHOTO) } }] }]);
  });

  it("askGemini passes documents to the model and to its explorer", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: pdfWithPictures(1) });
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-3.8-flash", explorerModel: "gemini-3.5-flash-lite" });
    const server = fakeFetch([geminiReply()]);
    // The file goes only when both models declare documents: the request shows that both do.
    await askGemini({ files, endpoint, fetch: server.fetch, documents: { formats: ["pdf"] }, documentIds: [meta.id], messages: [{ role: "user", text: "What does the picture show?" }] });
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "application/pdf", data: expect.any(String) } });
    const without = fakeFetch([geminiReply()]);
    await askGemini({ files, endpoint, fetch: without.fetch, documentIds: [meta.id], messages: [{ role: "user", text: "What does the picture show?" }] });
    expect(JSON.stringify(without.sent[0]!.body)).not.toContain("inlineData");
  });
});

describe("openAiCompatible()", () => {
  it("sends a file part before the text, an image as image_url, and refuses pptx", () => {
    expect(() => openAiCompatible({ model: "m", documents: { formats: ["pptx"] } })).toThrow(new TypeError('openAiCompatible(): documents.formats may name only "pdf", and names "pptx".'));
    const model = openAiCompatible({ model: "m", documents: { formats: ["pdf"], maxPages: 4 } });
    expect(model.capabilities).toEqual({ toolFiles: "none", pageTokens: 1_000, documents: { formats: ["pdf"], maxFileBytes: 4_194_304, maxPages: 4 } });
  });

  it("puts the files first in the turn, and throws for a file of a type it cannot send", async () => {
    const server = fakeFetch([openAiReply()]);
    const model = openAiCompatible({ model: "gpt-5.5", documents: { formats: ["pdf"] }, fetch: server.fetch });
    await model.send(withFiles([PDF, PHOTO]));
    expect(server.sent[0]!.body.messages).toEqual([{ role: "user", content: [
      { type: "file", file: { filename: "attached-1.pdf", file_data: `data:application/pdf;base64,${base64(PDF)}` } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64(PHOTO)}` } },
      { type: "text", text: "The file attached above is …\n\nDocument text.\n\nWhat is in it?" },
    ] }]);
    // Without files, the turn is a string, as before.
    await model.send({ system: "", messages: [{ role: "user", parts: [{ text: "Hi." }] }] });
    expect(server.sent[1]!.body.messages).toEqual([{ role: "user", content: "Hi." }]);
    await expect(model.send(withFiles([DECK]))).rejects.toThrow(new TypeError(`openAiCompatible(): a file of a message must be a PDF or a PNG, JPEG, GIF or WebP image, and "attached-2.pptx" is ${DECK.mimeType}.`));
    expect(server.sent).toHaveLength(2);
  });
});

describe("anthropic()", () => {
  it("sends a document block before the text, an image block for an image, and refuses pptx", async () => {
    expect(() => anthropic({ model: "claude-opus-5-5", documents: { formats: ["pdf", "pptx"] } })).toThrow(new TypeError('anthropic(): documents.formats may name only "pdf", and names "pptx".'));
    expect(anthropic({ model: "claude-opus-5-5" }).capabilities).not.toHaveProperty("documents");
    const server = fakeFetch([claudeReply()]);
    const model = anthropic({ model: "claude-opus-5-5", apiKey: "k", stream: false, cache: false, documents: { formats: ["pdf"] }, fetch: server.fetch });
    expect(model.capabilities.documents).toEqual({ formats: ["pdf"], maxFileBytes: 4_194_304, maxPages: 10 });
    await model.send(withFiles([PDF, PHOTO]));
    expect((server.sent[0]!.body as Json).messages).toEqual([{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64(PDF) } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64(PHOTO) } },
      { type: "text", text: "The file attached above is …" },
      { type: "text", text: "Document text." },
      { type: "text", text: "What is in it?" },
    ] }]);
    await expect(model.send(withFiles([DECK]))).rejects.toThrow(/^anthropic\(\): a file of a message must be a PDF or a PNG, JPEG, GIF or WebP image/);
  });
});

describe("openAiResponses()", () => {
  it("takes documents and both kinds of tool file, and sends files as input_file or input_image before the text", async () => {
    expect(openAiResponses({ model: "gpt-5.5" }).capabilities).toEqual({ toolFiles: "none", pageTokens: 1_000 });
    expect(openAiResponses({ model: "gpt-5.5", toolFilePlacement: "beside" }).capabilities).toEqual({ toolFiles: "beside", pageTokens: 1_000, toolFileTypes: ["application/pdf", "image/png", "image/jpeg"] });
    expect(() => openAiResponses({ model: "gpt-5.5", documents: { formats: ["pptx"] } })).toThrow(new TypeError('openAiResponses(): documents.formats may name only "pdf", and names "pptx".'));
    const server = fakeFetch([responsesReply()]);
    const model = openAiResponses({ model: "gpt-5.5", documents: { formats: ["pdf"] }, encryptedReasoning: false, fetch: server.fetch });
    expect(model.capabilities.documents).toEqual({ formats: ["pdf"], maxFileBytes: 4_194_304, maxPages: 10 });
    await model.send(withFiles([PDF, PHOTO]));
    expect(server.sent[0]!.body.input).toEqual([{ role: "user", content: [
      { type: "input_file", filename: "attached-1.pdf", file_data: `data:application/pdf;base64,${base64(PDF)}` },
      { type: "input_image", image_url: `data:image/png;base64,${base64(PHOTO)}`, detail: "auto" },
      { type: "input_text", text: "The file attached above is …\n\nDocument text.\n\nWhat is in it?" },
    ] }]);
    await expect(model.send(withFiles([DECK]))).rejects.toThrow(/^openAiResponses\(\): a file of a message must be a PDF/);
  });
});

describe("the documents option", () => {
  it("is checked when the adapter is made, with messages that say what is wrong", () => {
    const endpoint = geminiApi({ apiKey: "k", model: "gemini-3.8-flash" });
    const make = (documents: unknown) => () => gemini(endpoint, { documents: documents as never });
    expect(make("pdf")).toThrow(new TypeError('gemini(): documents must be an object with a list of formats, and is "pdf".'));
    expect(make(null)).toThrow(new TypeError("gemini(): documents must be an object with a list of formats, and is null."));
    expect(make({ formats: "pdf" })).toThrow(new TypeError('gemini(): documents.formats must be a list of formats, and is "pdf".'));
    expect(make({ formats: [] })).toThrow(new TypeError("gemini(): documents.formats must name at least one format."));
    expect(make({ formats: ["docx"] })).toThrow(new TypeError('gemini(): documents.formats may name only "pdf" and "pptx", and names "docx".'));
    expect(make({ formats: ["pdf"], maxFileBytes: 0 })).toThrow(new RangeError("gemini(): documents.maxFileBytes must be a whole number above 0, and is 0."));
    expect(make({ formats: ["pdf"], maxFileBytes: 1.5 })).toThrow(RangeError);
    expect(make({ formats: ["pdf"], maxPages: "3" })).toThrow(new TypeError('gemini(): documents.maxPages must be a whole number above 0, and is "3".'));
    expect(() => openAiCompatible({ model: "m", documents: { formats: ["pdf"], maxPages: -1 } })).toThrow(new RangeError("openAiCompatible(): documents.maxPages must be a whole number above 0, and is -1."));
  });
});
