// What the events of a question carry (0.10.0): the plan of `run.finish` and `run.error` never
// holds what is to stay on the server (LO-7), even with `eventResults: true`; `request.end` has
// the provider's response ID and model when the adapter gives them.
import { describe, expect, it } from "vitest";
import { askStream, askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const SERVER_FIELDS = ["owner", "scope", "sha256", "original", "metaVersion"];

describe("the plan in run.finish and run.error", () => {
  it("has no owner, scope, sha256, original or metaVersion with eventResults (p4-event-results)", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), originals: { read: async () => undefined } });
    const meta = await files.ingest({ name: "a.txt", bytes: utf8("hello\nworld"), owner: "user-17", scope: ["u17", "chat9"], id: "up-1", original: { ref: "u17/chat9/uploads/up-1" } });
    // The stored metadata holds them all: the result keeps them, for the server.
    expect(meta).toMatchObject({ owner: "user-17", scope: ["u17", "chat9"] });
    expect(typeof meta.sha256).toBe("string");
    const stream = askStream({ files, model: fakeModel([says("ok")]), documentIds: [meta.id], owner: "user-17", scope: ["u17", "chat9"], messages: [{ role: "user", text: "q" }], eventResults: true });
    const events: AskEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result;
    expect(result.plan.inline[0]).toMatchObject({ owner: "user-17", sha256: meta.sha256 });
    const finish = events.at(-1) as Extract<AskEvent, { type: "run.finish" }>;
    const sent = finish.result.plan.inline[0]!;
    for (const field of SERVER_FIELDS) expect(sent).not.toHaveProperty(field);
    // The rest of the metadata is there, as before.
    expect(sent).toMatchObject({ id: "up-1", name: "a.txt", lines: 2 });
    const text = JSON.stringify(events);
    for (const secret of ["user-17", "u17/chat9/uploads/up-1", meta.sha256!]) expect(text).not.toContain(secret);
  });

  it("has none of them in the partial result of run.error either", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)), owner: "user-17", scope: ["u17", "chat9"] });
    const events: AskEvent[] = [];
    const model = fakeModel([calls([{ id: "c1", name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 2 } }]), new Error("The provider went away.")]);
    await askWithFiles({ files, model, owner: "user-17", scope: ["u17", "chat9"], documentIds: [meta.id], messages: [{ role: "user", text: "q" }], eventResults: true, retry: { retries: 0 }, onEvent: (event) => events.push(event) }).catch(() => undefined);
    const failed = events.at(-1) as Extract<AskEvent, { type: "run.error" }>;
    expect(failed.type).toBe("run.error");
    expect(failed.partial!.toolTurns).toHaveLength(1);
    const plan = failed.partial!.plan.searchable[0]!;
    for (const field of SERVER_FIELDS) expect(plan).not.toHaveProperty(field);
    expect(JSON.stringify(failed)).not.toContain("user-17");
  });
});

describe("request.end", () => {
  it("carries the provider's response ID and model when the adapter gives them", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nShort.\n") });
    const events: AskEvent[] = [];
    await askWithFiles({ files, model: fakeModel([says("ok", { responseId: "resp_81f3", responseModel: "gemini-3.8-flash-001" })]), documentIds: [meta.id], messages: [{ role: "user", text: "q" }], onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === "request.end")).toMatchObject({ outcome: "ok", responseId: "resp_81f3", responseModel: "gemini-3.8-flash-001" });
    const plain: AskEvent[] = [];
    await askWithFiles({ files, model: fakeModel([says("ok")]), documentIds: [meta.id], messages: [{ role: "user", text: "q" }], onEvent: (event) => plain.push(event) });
    const end = plain.find((event) => event.type === "request.end")!;
    expect(end).not.toHaveProperty("responseId");
    expect(end).not.toHaveProperty("responseModel");
  });
});
