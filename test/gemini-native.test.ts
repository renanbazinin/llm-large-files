// Gemini's own model turns in stored contents, as in 0.9: geminiToolTurns writes a round as its
// calls alone, and fromGeminiContents makes a round of the library's plain form a stored round. A
// signed round (thought signatures, text next to its calls) stays as it is, signatures and all.
import { describe, expect, it } from "vitest";
import type { ToolTurn } from "llm-large-files";
import { fromGeminiContents, geminiToolTurns, type GeminiContent } from "llm-large-files/gemini";

const search = { id: "c1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact" } };
const read = { name: "read_document", args: { document_id: "log-1", start_line: 96, end_line: 98 } };
const signed: GeminiContent = { role: "model", parts: [{ text: "Searching.", thought: true }, { text: "Checking." }, { functionCall: search, thoughtSignature: "sig-1" }, { functionCall: read }] };
const turn: ToolTurn = {
  role: "tools",
  version: 1,
  calls: [{ ...search, result: { total_matching_lines: 51, tool_turns_left: 3 } }, { ...read, result: { text: "97| ERROR", tool_turns_left: 3 } }],
};
const responses: GeminiContent = { role: "user", parts: [
  { functionResponse: { name: "search_document", id: "c1", response: { total_matching_lines: 51 } } },
  { functionResponse: { name: "read_document", response: { text: "97| ERROR" } } },
] };

describe("geminiToolTurns", () => {
  it("writes a round as its calls, and its responses without the tool turns the question had left", () => {
    expect(geminiToolTurns([turn])).toEqual([{ role: "model", parts: [{ functionCall: search }, { functionCall: read }] }, responses]);
  });
});

describe("fromGeminiContents and a signed round", () => {
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "How many errors?" }] }, signed, responses, { role: "model", parts: [{ text: "51." }] }, { role: "user", parts: [{ text: "And the first?" }] }];

  it("leaves a signed round as it is", () => {
    const messages = fromGeminiContents(contents);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages.some((message) => message.role === "tools")).toBe(false);
  });

  it("makes a round in the library's plain form a stored round", () => {
    const plain: GeminiContent[] = [{ role: "user", parts: [{ text: "?" }] }, ...geminiToolTurns([turn]), { role: "user", parts: [{ text: "Again?" }] }];
    const messages = fromGeminiContents(plain);
    expect(messages[1]).toEqual({ role: "tools", version: 1, calls: [{ ...search, result: { total_matching_lines: 51 } }, { ...read, result: { text: "97| ERROR" } }] });
  });

  it("leaves a round with anything else in it as it is", () => {
    const response = { role: "user" as const, parts: [{ functionResponse: { name: search.name, id: "c1", response: { n: 1 } } }] };
    for (const asked of [
      // A call of the application's own.
      { role: "model" as const, parts: [{ functionCall: { name: "get_weather", args: {} }, thoughtSignature: "s" }] },
      // A part the library does not write.
      { role: "model" as const, parts: [{ functionCall: search, thoughtSignature: "s" }, { inlineData: { mimeType: "image/png", data: "x" } }] },
      // Text alone.
      { role: "model" as const, parts: [{ text: "No call.", thoughtSignature: "s" }] },
    ]) {
      const messages = fromGeminiContents([{ role: "user", parts: [{ text: "?" }] }, asked, response, { role: "user", parts: [{ text: "!" }] }]);
      expect(messages.some((message) => message.role === "tools"), JSON.stringify(asked)).toBe(false);
    }
  });
});
