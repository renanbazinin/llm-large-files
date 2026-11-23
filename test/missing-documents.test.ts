// Documents that are gone when a question is asked (0.9.0): `onMissingDocuments` says what to do,
// and a tool call that finds a document gone during the question gives a "document_gone" notice.
// Before, a document that expired failed the whole next question with DocumentsNotFoundError.
import { describe, expect, it } from "vitest";
import {
  askStream,
  askWithFiles,
  createLargeFiles,
  DocumentsNotFoundError,
  MemoryDocumentStore,
  ModelRequestError,
  type AskEvent,
  type AskOptions,
  type MissingDocumentsContext,
  type ModelMessage,
} from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { calls, fakeFetch, fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";

const question = (text: string) => [{ role: "user" as const, text }];
const LINE_ONE = "1 of the attached files is no longer available; say so if the question needs it.";
const textOf = (message: ModelMessage | undefined) => (message && message.role !== "tools" ? message.parts.map((part) => part.text ?? "").join("\n") : "");

/** A library with a small note and a large log, both kept, and one ID that is gone. */
async function documents(owner?: string, scope?: string[]) {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, budget: { inlineTokens: 1_000 } });
  const access = { ...(owner ? { owner } : {}), ...(scope ? { scope } : {}) };
  const note = await files.ingest({ name: "note.txt", bytes: utf8("The total is 42.\n"), id: "note-1", ...access });
  const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)), id: "log-1", ...access });
  const old = await files.ingest({ name: "old.txt", bytes: utf8("The old total was 7.\n"), id: "old-1", ...access });
  await files.delete(old.id, access);
  return { files, store, note, log, old, access };
}

describe("onMissingDocuments", () => {
  it("fails the question by default, before any request, as in 0.8.2", async () => {
    const { files, note, old } = await documents();
    const model = fakeModel([says("never")]);
    const error = await askWithFiles({ files, model, documentIds: [note.id, old.id], messages: question("?") }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentsNotFoundError);
    expect(error).toMatchObject({ ids: [old.id], message: "A document is no longer available: old-1. Upload it again." });
    expect(model.requests).toHaveLength(0);
    const named = await askWithFiles({ files, model, documentIds: [old.id], messages: question("?"), onMissingDocuments: "throw" }).catch((caught: unknown) => caught);
    expect(named).toBeInstanceOf(DocumentsNotFoundError);
  });

  it("'drop' answers from the others, says so in one line of the system text, and lists them", async () => {
    const { files, note, log, old } = await documents();
    const events: AskEvent[] = [];
    const model = fakeModel([says("The total is 42 (note.txt L1).")]);
    const result = await askWithFiles({ files, model, system: "Be brief.", documentIds: [note.id, old.id, log.id], messages: question("Total?"), onMissingDocuments: "drop", onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ answered: true, missing: [old.id] });
    expect(result.plan.inline.map((meta) => meta.id)).toEqual([note.id]);
    expect(result.plan.searchable.map((meta) => meta.id)).toEqual([log.id]);
    const system = model.requests[0]!.system;
    expect(system.startsWith("Be brief.\n\n")).toBe(true);
    expect(system.endsWith(`\n\n${LINE_ONE}`)).toBe(true);
    expect(system.split(LINE_ONE)).toHaveLength(2);
    // The note is still in the prompt; the missing one is named nowhere.
    expect(textOf(model.requests[0]!.messages[0])).toContain("The total is 42.");
    expect(JSON.stringify(model.requests[0])).not.toContain(old.id);
    const notice = events.find((event) => event.type === "notice" && event.code === "documents_missing");
    expect(notice).toMatchObject({ display: "none", documentIds: [old.id], message: "1 of the attached files is no longer available: the question is answered without it." });
    // Before the plan, and in the result of run.finish.
    expect(events.findIndex((event) => event === notice)).toBeLessThan(events.findIndex((event) => event.type === "plan"));
    const finish = events.at(-1);
    expect(finish?.type === "run.finish" && finish.result.missing).toEqual([old.id]);
    // Steps are as they were: the notice is not one.
    expect(result.steps).toEqual([]);

    // The next question, without the missing one: no line, no `missing`.
    const next = fakeModel([says("42.")]);
    const again = await askWithFiles({ files, model: next, system: "Be brief.", documentIds: [note.id, log.id], messages: question("Total?"), onMissingDocuments: "drop" });
    expect(again.missing).toBeUndefined();
    expect(next.requests[0]!.system).not.toContain("no longer available");
  });

  it("'drop' with no document left is a plain chat, with no tools", async () => {
    const { files, old, store } = await documents();
    const other = await files.ingest({ name: "b.txt", bytes: utf8("b\n") });
    await store.delete(other.id);
    const model = fakeModel([says("Those files are no longer available.")]);
    const result = await askWithFiles({ files, model, documentIds: [old.id, other.id], messages: question("Total?"), onMissingDocuments: "drop" });
    expect(result).toMatchObject({ answered: true, missing: [old.id, other.id], plan: { inline: [], searchable: [] } });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools).toBeUndefined();
    expect(model.requests[0]!.system).toBe("2 of the attached files are no longer available; say so if the question needs them.");
  });

  it("asks a function, with who asks, and plans again once after it ingested them again under the same IDs", async () => {
    const owner = "user-1";
    const scope = ["user-1", "chat-1"];
    const { files, note, old, access } = await documents(owner, scope);
    const stop = new AbortController();
    const asked: Array<{ missing: string[]; context: MissingDocumentsContext }> = [];
    const model = fakeModel([says("It was 7 (old.txt L1).")]);
    const result = await askWithFiles({
      files, model, owner, scope, signal: stop.signal, documentIds: [note.id, old.id], messages: question("Old total?"),
      onMissingDocuments: async (missing, context) => {
        asked.push({ missing, context });
        for (const id of missing) await files.ingest({ name: "old.txt", bytes: utf8("The old total was 7.\n"), id, ...access });
        return { retry: true };
      },
    });
    expect(asked).toEqual([{ missing: [old.id], context: { owner, scope, signal: stop.signal } }]);
    expect(result).toMatchObject({ answered: true });
    expect(result.missing).toBeUndefined();
    expect(result.plan.inline.map((meta) => meta.id)).toEqual([note.id, old.id]);
    expect(textOf(model.requests[0]!.messages[0])).toContain("The old total was 7.");
  });

  it("fails with DocumentsNotFoundError when a retry finds them still missing", async () => {
    const { files, note, old } = await documents();
    let calls = 0;
    const model = fakeModel([says("never")]);
    const error = await askWithFiles({ files, model, documentIds: [note.id, old.id], messages: question("?"), onMissingDocuments: () => {
      calls++;
      return { retry: true };
    } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentsNotFoundError);
    expect((error as DocumentsNotFoundError).ids).toEqual([old.id]);
    expect(calls).toBe(1);
    expect(model.requests).toHaveLength(0);
  });

  it("uses the new IDs of a replace", async () => {
    const { files, note, log, old } = await documents();
    let fresh = "";
    const model = fakeModel([says("It was 7 (old.txt L1).")]);
    const result = await askWithFiles({ files, model, documentIds: [note.id, old.id, log.id], messages: question("?"), onMissingDocuments: async () => {
      fresh = (await files.ingest({ name: "old.txt", bytes: utf8("The old total was 7.\n"), id: "old-2" })).id;
      return { replace: { [old.id]: fresh } };
    } });
    expect(fresh).toBe("old-2");
    expect(result.plan.inline.map((meta) => meta.id)).toEqual([note.id, "old-2"]);
    expect(result.missing).toBeUndefined();
    // In the place of the old one, before the log's card.
    const first = textOf(model.requests[0]!.messages[0]);
    expect(first.indexOf("The old total was 7.")).toBeGreaterThan(first.indexOf("The total is 42."));
    expect(first.indexOf("The old total was 7.")).toBeLessThan(first.indexOf("--- Large attached file: app.log"));
    // A replace that names an ID still missing fails the question.
    const failed = await askWithFiles({ files, model: fakeModel([says("never")]), documentIds: [old.id], messages: question("?"), onMissingDocuments: () => ({ replace: { [old.id]: "old-3" } }) }).catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ name: "DocumentsNotFoundError", ids: ["old-3"] });
  });

  it("passes on what the function throws, and stops when the question is stopped while it waits", async () => {
    const { files, note, old } = await documents();
    const own = new Error("The uploads bucket could not be read.");
    const model = fakeModel([says("never")]);
    await expect(askWithFiles({ files, model, documentIds: [note.id, old.id], messages: question("?"), onMissingDocuments: () => {
      throw own;
    } })).rejects.toBe(own);
    await expect(askWithFiles({ files, model, documentIds: [note.id, old.id], messages: question("?"), onMissingDocuments: async () => Promise.reject(own) })).rejects.toBe(own);

    // A function that does not look at the signal still does not hold the question.
    const stop = new AbortController();
    const reason = new Error("The user stopped the question.");
    const asking = askWithFiles({ files, model, signal: stop.signal, documentIds: [note.id, old.id], messages: question("?"), onMissingDocuments: () => new Promise(() => undefined) });
    setTimeout(() => stop.abort(reason), 10);
    await expect(asking).rejects.toBe(reason);
    expect(model.requests).toHaveLength(0);
  });

  it("refuses what it cannot be, and what a function cannot return", async () => {
    const { files, note, old } = await documents();
    const model = fakeModel([says("never")]);
    const ask = (more: Partial<AskOptions>) => askWithFiles({ files, model, documentIds: [note.id, old.id], messages: question("?"), ...more });
    await expect(ask({ onMissingDocuments: "skip" as "drop" })).rejects.toThrow(new TypeError('onMissingDocuments must be "throw", "drop" or a function, and is "skip".'));
    for (const value of ["skip", { retry: false }, { replace: { [old.id]: 7 } }, { replace: [] }, null, { retry: true, replace: {} }]) {
      await expect(ask({ onMissingDocuments: () => value as never }), JSON.stringify(value)).rejects.toThrow(TypeError);
    }
    await expect(ask({ onMissingDocuments: () => "skip" as never })).rejects.toThrow('onMissingDocuments returned "skip": it must return "throw", "drop", { retry: true } or { replace: { [oldId]: newId } }.');
  });

  it("is not asked again when the question is planned again for a smaller window", async () => {
    const { files, note, old } = await documents();
    let asked = 0;
    let refused = false;
    const model = fakeModel([() => {
      if (refused) return says("42.");
      refused = true;
      return new ModelRequestError("This model's maximum context length is 8192 tokens. However, your messages resulted in 21000 tokens.", 400);
    }]);
    const result = await askWithFiles({ files, model, documentIds: [note.id, old.id], messages: question("?"), onMissingDocuments: () => {
      asked++;
      return "drop";
    } });
    expect(asked).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect(result).toMatchObject({ answered: true, missing: [old.id] });
    expect(result.steps[0]).toMatch(/^The first request was larger than the model's window/);
    for (const request of model.requests) expect(request.system).toContain(LINE_ONE);
  });

  it("is passed on by askStream and askGemini", async () => {
    const { files, note, old } = await documents();
    const stream = askStream({ files, model: fakeModel([says("42.")]), documentIds: [note.id, old.id], messages: question("?"), onMissingDocuments: "drop" });
    const codes: string[] = [];
    for await (const event of stream) if (event.type === "notice") codes.push(event.code);
    expect(codes).toContain("documents_missing");
    expect((await stream.result).missing).toEqual([old.id]);

    const gemini = fakeFetch([Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "42." }] } }] })]);
    const result = await askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: gemini.fetch, documentIds: [note.id, old.id], messages: question("?"), onMissingDocuments: "drop" });
    expect(result.missing).toEqual([old.id]);
    expect(gemini.sent[0]!.body.systemInstruction.parts[0].text).toBe(LINE_ONE);
  });
});

describe("a document found gone during a question", () => {
  it("is told to the model by the tool, and in one document_gone notice", async () => {
    const { files, log } = await documents();
    const search = { name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact" } };
    const events: AskEvent[] = [];
    const model = fakeModel([
      calls([search]),
      async () => {
        // Deleted, or expired, after the first call.
        await files.delete(log.id);
        return calls([search, { name: "read_document", args: { document_id: log.id, start_line: 1 } }]);
      },
      says("The log is no longer available."),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [log.id], messages: question("Errors?"), onEvent: (event) => events.push(event) });
    expect(result.answered).toBe(true);
    const ends = events.flatMap((event) => (event.type === "tool.end" ? [event] : []));
    expect(ends.map((end) => end.outcome)).toEqual(["ok", "already_shown", "error"]);
    expect(ends[2]!.error).toBe("log-1 is no longer available on the server. Ask the user to attach the file again.");
    const notices = events.filter((event) => event.type === "notice" && event.code === "document_gone");
    expect(notices).toEqual([expect.objectContaining({ message: "app.log is no longer available on the server.", display: "none", documentIds: [log.id] })]);
    expect(result.steps.every((line) => !line.includes("document_gone"))).toBe(true);
  });
});
