// How an answer ended (new in 0.10.0): `AskResult.finish`, the "answer_filtered" and "answer_cut"
// notices, `filteredAnswer: "drop"` with `discardText` for text already streamed, and
// `answerInfoOf`. The finish values come from the fake model, as an adapter maps its provider's
// reasons (the Gemini mapping is the adapter's, and its question end to end is a joined test).
import { describe, expect, it } from "vitest";
import { answerInfoOf, askStream, askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
type Notice = Extract<AskEvent, { type: "notice" }>;
const notices = (events: AskEvent[]) => events.filter((event): event is Notice => event.type === "notice");

/** A library with a short note sent whole, and a log searched with the tools. */
async function library() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const note = await files.ingest({ name: "leave.md", bytes: utf8("# Leave\n\nThe employee's medical leave was approved for two weeks.\n") });
  const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
  return { files, note, log };
}

describe("AskResult.finish and the answer notices", () => {
  it("says a partial answer was filtered: finish, the notice, and the text kept by default", async () => {
    const { files, note } = await library();
    const events: AskEvent[] = [];
    const model = fakeModel([says("The employee's medical leave was", { finish: "filtered", finishReason: "SAFETY" })]);
    const result = await askWithFiles({ files, model, documentIds: [note.id], messages: question("Summarise."), onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ text: "The employee's medical leave was", answered: true, finish: "filtered", finishReason: "SAFETY" });
    expect(notices(events).map((event) => event.code)).toEqual(["answer_filtered"]);
    expect(notices(events)[0]).toMatchObject({ display: "none", message: "A filter of the provider stopped the answer before it was finished." });
    expect(notices(events)[0]).not.toHaveProperty("discardText");
    // The notice comes before run.finish, which carries the finish too.
    expect(events.at(-1)).toMatchObject({ type: "run.finish", result: { finish: "filtered" } });
    expect(answerInfoOf(result)).toEqual({ complete: false, reason: "filtered", finish: "filtered", finishReason: "SAFETY" });
  });

  it("tells a filter that stopped the answer before any text, after the tools", async () => {
    const { files, log } = await library();
    const events: AskEvent[] = [];
    const model = fakeModel([
      calls([{ id: "s1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact" } }]),
      says("", { finish: "filtered", finishReason: "SAFETY" }),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [log.id], messages: question("Which errors?"), onEvent: (event) => events.push(event) });
    // The filtered turn is not asked again, and its closing request is not either: 3 requests.
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none"]);
    expect(result).toMatchObject({ answered: false, finish: "filtered" });
    expect(notices(events).filter((event) => event.code === "answer_filtered")).toEqual([
      expect.objectContaining({ message: "A filter of the provider stopped the answer before any text came." }),
    ]);
  });

  it("drops a filtered answer under filteredAnswer \"drop\": no text, not answered, and nothing shown when it was not streamed", async () => {
    const { files, note } = await library();
    const events: AskEvent[] = [];
    const shown: string[] = [];
    const model = fakeModel([says("The employee's medical leave was", { finish: "filtered" })]);
    const result = await askWithFiles({ files, model, documentIds: [note.id], messages: question("Summarise."), filteredAnswer: "drop", onText: (delta) => shown.push(delta), streamText: false, onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ text: "", answered: false, finish: "filtered" });
    expect(shown).toEqual([]);
    expect(events.some((event) => event.type === "text")).toBe(false);
    const filtered = notices(events).find((event) => event.code === "answer_filtered")!;
    expect(filtered.message).toBe("A filter of the provider stopped the answer before it was finished: its text was dropped.");
    expect(filtered).not.toHaveProperty("discardText");
    expect(answerInfoOf(result)).toMatchObject({ complete: false, reason: "filtered" });
  });

  it("asks to discard the text already streamed, before run.finish", async () => {
    const { files, note } = await library();
    const model = fakeModel([says("The employee's medical leave was", { finish: "filtered" })]);
    const stream = askStream({ files, model, documentIds: [note.id], messages: question("Summarise."), filteredAnswer: "drop" });
    const events: AskEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result;
    expect(result).toMatchObject({ text: "", answered: false, finish: "filtered" });
    const types = events.map((event) => (event.type === "notice" ? `notice:${event.code}` : event.type));
    // The text went out as it came, then the notice that takes it back, then the end.
    expect(types.filter((type) => type === "text").length).toBeGreaterThan(0);
    expect(types.slice(-2)).toEqual(["notice:answer_filtered", "run.finish"]);
    expect(types.lastIndexOf("text")).toBeLessThan(types.indexOf("notice:answer_filtered"));
    expect(notices(events).find((event) => event.code === "answer_filtered")).toMatchObject({ discardText: true });
    expect(events.at(-1)).toMatchObject({ type: "run.finish", result: { text: "", answered: false } });
  });

  it("drops the earlier remarks too, which were shown, and says so", async () => {
    const { files, log } = await library();
    const events: AskEvent[] = [];
    const model = fakeModel([
      calls([{ id: "s1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact" } }], { text: "Searching." }),
      says("There were 51", { finish: "filtered" }),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [log.id], messages: question("How many errors?"), filteredAnswer: "drop", onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ text: "", answered: false, finish: "filtered" });
    // "Searching." went out in text events before the answer was filtered.
    expect(events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta).join("")).toBe("Searching.");
    expect(notices(events).find((event) => event.code === "answer_filtered")).toMatchObject({ discardText: true });
  });

  it("keeps a complete answer under \"drop\", and says nothing", async () => {
    const { files, note } = await library();
    const events: AskEvent[] = [];
    const model = fakeModel([says("Two weeks.", { finish: "complete", finishReason: "STOP" })]);
    const result = await askWithFiles({ files, model, documentIds: [note.id], messages: question("How long?"), filteredAnswer: "drop", onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ text: "Two weeks.", answered: true, finish: "complete" });
    expect(notices(events)).toEqual([]);
    expect(answerInfoOf(result)).toEqual({ complete: true, finish: "complete", finishReason: "STOP" });
  });

  it("refuses a filteredAnswer it cannot be before anything is asked: it would keep what was meant to be dropped", async () => {
    const { files, note } = await library();
    for (const [value, shown] of [["Drop", "\"Drop\""], [true, "boolean"], [null, "null"]] as const) {
      const model = fakeModel([says("Partial", { finish: "filtered" })]);
      const outcome = await askWithFiles({ files, model, documentIds: [note.id], messages: question("q"), filteredAnswer: value as never }).then(() => undefined, (error: unknown) => error);
      expect(outcome).toBeInstanceOf(TypeError);
      expect((outcome as Error).message).toBe(`filteredAnswer must be "keep" or "drop", and is ${shown}.`);
      expect(model.requests).toHaveLength(0);
    }
    // "keep" and undefined are the default.
    const kept = await askWithFiles({ files, model: fakeModel([says("Partial", { finish: "filtered" })]), documentIds: [note.id], messages: question("q"), filteredAnswer: "keep" });
    expect(kept).toMatchObject({ text: "Partial", answered: true });
  });

  it("says an answer was cut at the output limit, and keeps it", async () => {
    const { files, log } = await library();
    const events: AskEvent[] = [];
    const model = fakeModel([
      calls([{ id: "s1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact" } }]),
      says("The errors are at lines 97, 194, 291 and", { finish: "cut", finishReason: "MAX_TOKENS" }),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [log.id], messages: question("Where are the errors?"), filteredAnswer: "drop", onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ text: "The errors are at lines 97, 194, 291 and", answered: true, finish: "cut" });
    expect(notices(events).map((event) => event.code)).toEqual(["searching_instead", "answer_cut"]);
    expect(notices(events).at(-1)).toMatchObject({ display: "none", message: "The answer stopped at the model's output limit, so it is incomplete." });
    expect(answerInfoOf(result)).toEqual({ complete: false, reason: "cut", finish: "cut", finishReason: "MAX_TOKENS" });
  });

  it("gives the finish of the last reply when none answered, and none when the adapter does not say", async () => {
    const { files, note } = await library();
    const malformed = await askWithFiles({ files, model: fakeModel([says("", { finish: "malformed_call" })]), documentIds: [note.id], messages: question("?") });
    expect(malformed).toMatchObject({ answered: false, finish: "malformed_call" });
    const plain = await askWithFiles({ files, model: fakeModel([says("Two weeks.")]), documentIds: [note.id], messages: question("?") });
    expect(plain).not.toHaveProperty("finish");
    expect(answerInfoOf(plain)).toEqual({ complete: true });
  });
});
