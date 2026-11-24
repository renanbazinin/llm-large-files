// Stored rounds that keep Gemini's own model turn (`ToolTurn.native`, L15-ext adapter side; 0.10.0):
// geminiToolTurns writes that turn, thought signatures included, and fromGeminiContents with `model`
// reads such a round back as a stored round that keeps it. Without `model`, a signed round stays
// as it is, as in 0.9.
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
  native: { model: "gemini-3.8-flash", turn: signed },
};

describe("geminiToolTurns since 0.10.0", () => {
  it("writes a round with its own model turn, signatures and all", () => {
    const contents = geminiToolTurns([turn]);
    expect(contents[0]).toEqual(signed);
    // The responses are those of 0.9: without the tool turns the question had left.
    expect(contents[1]).toEqual({ role: "user", parts: [
      { functionResponse: { name: "search_document", id: "c1", response: { total_matching_lines: 51 } } },
      { functionResponse: { name: "read_document", response: { text: "97| ERROR" } } },
    ] });
  });

  it("writes the calls alone for a round without it, or with a turn that is not Gemini's own for these calls", () => {
    const plain = geminiToolTurns([{ ...turn, native: undefined }]);
    expect(plain[0]).toEqual({ role: "model", parts: [{ functionCall: search }, { functionCall: read }] });
    for (const native of [
      { model: "deepseek-v4-pro", turn: { role: "assistant", content: null, tool_calls: [] } },
      { model: "gemini-3.8-flash", turn: { role: "model", parts: [{ functionCall: search }] } },
      { model: "gemini-3.8-flash", turn: { role: "model", parts: [{ functionCall: read }, { functionCall: search }] } },
      { model: "gemini-3.8-flash", turn: "not a turn" },
    ]) {
      expect(geminiToolTurns([{ ...turn, native }])).toEqual(plain);
    }
  });
});

describe("fromGeminiContents with model, since 0.10.0", () => {
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "How many errors?" }] }, ...geminiToolTurns([turn]), { role: "model", parts: [{ text: "51." }] }, { role: "user", parts: [{ text: "And the first?" }] }];

  it("reads a signed round back as a stored round that keeps its turn for that adapter", () => {
    const messages = fromGeminiContents(contents, { model: "gemini-3.8-flash" });
    expect(messages.map((message) => message.role)).toEqual(["user", "tools", "assistant", "user"]);
    expect(messages[1]).toEqual({
      role: "tools",
      version: 1,
      calls: [{ ...search, result: { total_matching_lines: 51 } }, { ...read, result: { text: "97| ERROR" } }],
      native: { model: "gemini-3.8-flash", turn: signed },
    });
    // And back again, the same contents.
    expect(geminiToolTurns([messages[1] as ToolTurn])).toEqual(contents.slice(1, 3));
  });

  it("leaves a signed round as it is without model, as before", () => {
    const messages = fromGeminiContents(contents);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages.some((message) => message.role === "tools")).toBe(false);
  });

  it("keeps no turn for a round in the library's plain form", () => {
    const plain: GeminiContent[] = [{ role: "user", parts: [{ text: "?" }] }, ...geminiToolTurns([{ ...turn, native: undefined }]), { role: "user", parts: [{ text: "Again?" }] }];
    const messages = fromGeminiContents(plain, { model: "gemini-3.8-flash" });
    expect(messages[1]).toEqual({ role: "tools", version: 1, calls: [{ ...search, result: { total_matching_lines: 51 } }, { ...read, result: { text: "97| ERROR" } }] });
    expect(fromGeminiContents(plain)).toEqual(messages);
  });

  it("still leaves a round with anything else in it as it is", () => {
    const response = { role: "user" as const, parts: [{ functionResponse: { name: search.name, id: "c1", response: { n: 1 } } }] };
    for (const asked of [
      // A call of the application's own.
      { role: "model" as const, parts: [{ functionCall: { name: "get_weather", args: {} }, thoughtSignature: "s" }] },
      // A part the library does not write.
      { role: "model" as const, parts: [{ functionCall: search, thoughtSignature: "s" }, { inlineData: { mimeType: "image/png", data: "x" } }] },
      // Text alone.
      { role: "model" as const, parts: [{ text: "No call.", thoughtSignature: "s" }] },
    ]) {
      const messages = fromGeminiContents([{ role: "user", parts: [{ text: "?" }] }, asked, response, { role: "user", parts: [{ text: "!" }] }], { model: "gemini-3.8-flash" });
      expect(messages.some((message) => message.role === "tools"), JSON.stringify(asked)).toBe(false);
    }
  });
});
