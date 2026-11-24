// A signed round of an earlier question, handed to askGemini in `contents`, goes out with its
// thought signature (0.10.0). In 0.9 such a round stayed as it was and was sent as it came. A round
// made a stored round keeps the signed turn only in `ToolTurn.native`, so askGemini makes it one only
// once the loop sends `native` back; until then the round stays as it is, on every endpoint.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, geminiApi, vertexAi, type GeminiContent } from "llm-large-files/gemini";
import { fakeFetch, utf8 } from "llm-large-files/testing";

const say = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }] });

describe("signed rounds in askGemini's contents", () => {
  for (const [label, endpoint, nativeRounds] of [
    ["the Gemini API", geminiApi({ apiKey: "k", model: "gemini-test" }), undefined],
    ["the Gemini API, nativeRounds true", geminiApi({ apiKey: "k", model: "gemini-test" }), true],
    ["the Gemini API, nativeRounds false", geminiApi({ apiKey: "k", model: "gemini-test" }), false],
    ["Vertex AI", vertexAi({ project: "p", model: "gemini-test", accessToken: "t" }), undefined],
  ] as const) {
    it(`sends the thought signature of an earlier question's round again (${label})`, async () => {
      const files = createLargeFiles({ store: new MemoryDocumentStore() });
      const meta = await files.ingest({ name: "notes.md", bytes: utf8("The code word is heron.\n") });
      const signed: GeminiContent = {
        role: "model",
        parts: [{ text: "Looking it up.", thought: true }, { functionCall: { name: "search_document", args: { document_id: meta.id, query: "code word" } }, thoughtSignature: "SIG-OF-ROUND-1" }],
      };
      const api = fakeFetch([say("Heron.")]);
      await askGemini({
        files, endpoint, fetch: api.fetch, documentIds: [meta.id],
        ...(nativeRounds === undefined ? {} : { nativeRounds }),
        contents: [
          { role: "user", parts: [{ text: "What is the code word?" }] },
          signed,
          { role: "user", parts: [{ functionResponse: { name: "search_document", response: { total_matching_lines: 1 } } }] },
          { role: "model", parts: [{ text: "Heron." }] },
          { role: "user", parts: [{ text: "And again?" }] },
        ],
      });
      const models = (api.sent[0]!.body.contents as GeminiContent[]).filter((content) => content.role === "model");
      // The signed turn, as it came: the thought, the call and its signature.
      expect(models[0]).toEqual(signed);
    });
  }
});
