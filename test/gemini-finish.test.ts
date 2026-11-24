// Gemini's finish reasons in the terms of ModelReply.finish (A6, 0.10.0): MODEL_ARMOR and the image
// reasons are "filtered", MALFORMED_RESPONSE is "malformed_call", and the known reasons that asking
// again does not mend are "other". LANGUAGE is "other", not "filtered": it is no safety filter.
import { describe, expect, it } from "vitest";
import { createGeminiGenerateText, gemini, geminiApi } from "llm-large-files/gemini";
import { fakeFetch } from "llm-large-files/testing";

const finished = (reason: string, text = "") => Response.json({ candidates: [{ finishReason: reason, content: { role: "model", parts: text ? [{ text }] : [] } }], usageMetadata: { promptTokenCount: 10 } });
const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "hi" }] }] };

/** Each reason, and the finish it is read as. */
const TABLE: Array<[string, string | undefined]> = [
  ["STOP", "complete"],
  ["MAX_TOKENS", "cut"],
  ["SAFETY", "filtered"],
  ["RECITATION", "filtered"],
  ["BLOCKLIST", "filtered"],
  ["PROHIBITED_CONTENT", "filtered"],
  ["SPII", "filtered"],
  ["IMAGE_SAFETY", "filtered"],
  ["MODEL_ARMOR", "filtered"],
  ["IMAGE_PROHIBITED_CONTENT", "filtered"],
  ["IMAGE_RECITATION", "filtered"],
  ["IMAGE_OTHER", "filtered"],
  ["MALFORMED_FUNCTION_CALL", "malformed_call"],
  ["UNEXPECTED_TOOL_CALL", "malformed_call"],
  ["MALFORMED_RESPONSE", "malformed_call"],
  ["OTHER", "other"],
  ["FINISH_REASON_UNSPECIFIED", "other"],
  ["NO_IMAGE", "other"],
  ["TOO_MANY_TOOL_CALLS", "other"],
  ["MISSING_THOUGHT_SIGNATURE", "other"],
  ["LANGUAGE", "other"],
  ["A_REASON_OF_LATER", undefined],
];

describe("Gemini finish reasons since 0.10.0", () => {
  it("reads each reason as its finish, and keeps the reason itself", async () => {
    const seen: Array<[string, string | undefined]> = [];
    for (const [reason] of TABLE) {
      const reply = await gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: fakeFetch([finished(reason, "Some text.")]).fetch }).send(request);
      expect(reply.finishReason).toBe(reason);
      seen.push([reason, reply.finish]);
    }
    expect(seen).toEqual(TABLE);
  });

  it("reads them the same in a stream", async () => {
    const streamed = (reason: string) => new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Partial" }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ finishReason: reason, content: { role: "model", parts: [] } }] })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    for (const [reason, finish] of [["MODEL_ARMOR", "filtered"], ["LANGUAGE", "other"], ["MALFORMED_RESPONSE", "malformed_call"]] as const) {
      const reply = await gemini(geminiApi({ apiKey: "k", model: "gemini-test" }), { fetch: fakeFetch([streamed(reason)]).fetch }).send(request, { onText: () => undefined });
      expect(reply).toMatchObject({ text: "Partial", finishReason: reason, finish });
    }
  });

  it("says a part read stopped by Model Armor, or for another reason, is not all there is", async () => {
    for (const reason of ["MODEL_ARMOR", "OTHER", "LANGUAGE"]) {
      let truncated = 0;
      const read = createGeminiGenerateText({ url: `https://gemini.example/v1/models/m-${reason}:generateContent`, headers: {}, fetchImpl: fakeFetch([finished(reason, "Notes on lines 1-40 (L3).")]).fetch });
      const text = await read({ system: "s", prompt: "p", maxOutputTokens: 100, onTruncated: () => { truncated++; } });
      expect(text).toBe("Notes on lines 1-40 (L3).");
      expect(truncated, reason).toBe(1);
    }
    // A reply that ended as it should is whole.
    let truncated = 0;
    const read = createGeminiGenerateText({ url: "https://gemini.example/v1/models/m-stop:generateContent", headers: {}, fetchImpl: fakeFetch([finished("STOP", "Notes.")]).fetch });
    await read({ system: "s", prompt: "p", maxOutputTokens: 100, onTruncated: () => { truncated++; } });
    expect(truncated).toBe(0);
  });
});
