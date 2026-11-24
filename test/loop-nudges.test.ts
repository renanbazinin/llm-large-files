// Replies the loop asks for again, and those it does not (0.10.0): a reply ended by a reason that
// asking again cannot mend ("filtered", "other") is not nudged, nor asked for again as the answer;
// a turn whose tool call could not be read is not the answer, even with a remark (LLF-048).
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type ModelMessage } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const lastText = (messages: ModelMessage[]) => {
  const last = messages.at(-1)!;
  return last.role === "tools" ? "" : last.parts.map((part) => part.text ?? "").join("\n");
};

async function largeLog(lines = 2_000) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(lines)) });
  return { files, meta };
}

describe("a reply that asking again does not mend", () => {
  it("costs 2 requests with finish \"other\" and no text, not 4", async () => {
    const { files, meta } = await largeLog();
    const events: AskEvent[] = [];
    // Gemini's OTHER, LANGUAGE, MODEL_ARMOR and the like, as an adapter maps them.
    const model = fakeModel([says("", { finish: "other", finishReason: "OTHER" })]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), onEvent: (event) => events.push(event) });
    // The turn, then the closing request: no nudge, no answer_again.
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "none"]);
    expect(result).toMatchObject({ answered: false, finish: "other", finishReason: "OTHER", turns: 2 });
    const codes = events.filter((event) => event.type === "notice").map((event) => (event as { code: string }).code);
    expect(codes).not.toContain("nudged");
    expect(codes).not.toContain("answer_again");
  });

  it("costs 2 requests with finish \"filtered\" and no text, and says the answer was filtered", async () => {
    const { files, meta } = await largeLog();
    const events: AskEvent[] = [];
    const model = fakeModel([says("", { finish: "filtered", finishReason: "MODEL_ARMOR" })]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), onEvent: (event) => events.push(event) });
    expect(model.requests).toHaveLength(2);
    expect(result).toMatchObject({ answered: false, finish: "filtered" });
    expect(events.filter((event) => event.type === "notice" && event.code === "answer_filtered")).toHaveLength(1);
  });

  it("still asks again after an empty reply of no known reason, and after an empty answer", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([says(""), says(""), says(""), says("51 errors.")]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?") });
    // Nudged, then the closing request, asked for again: as in 0.9.
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none", "none"]);
    expect(result).toMatchObject({ text: "51 errors.", answered: true });
  });
});

describe("LLF-048: a turn whose tool call could not be read", () => {
  it("is not the answer on the last tool turn: the closing request is", async () => {
    // probe1's case: a search, then a remark with a call that could not be read, on the last tool turn.
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([{ id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
      says("Let me look at the error lines.", { finish: "malformed_call" }),
      says("There are 20 errors (app.log L97)."),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), limits: { toolTurns: 3 } });
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]!.toolChoice).toBe("none");
    expect(lastText(model.requests[2]!.messages)).toContain("Stop using tools now.");
    expect(result).toMatchObject({ answered: true, text: "Let me look at the error lines.\n\nThere are 20 errors (app.log L97)." });
    expect(result).not.toHaveProperty("finish");
  });

  it("is not the answer after its nudge either", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      says("I will search.", { finish: "malformed_call" }),
      says("Searching now.", { finish: "malformed_call" }),
      says("I could not search the file."),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?") });
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none"]);
    expect(result.answered).toBe(true);
    expect(result.text.endsWith("I could not search the file.")).toBe(true);
  });
});
