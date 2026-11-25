// The review of 0.99.9 (0.99.10), the loop and the library: what `onToolResult` does with the pages
// of view_pages, a delete that waited while its document was replaced, the text of an error an
// application did not expect, and the smaller fixes of the loop and of whole-file reads.
import "./load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, DocumentsNotFoundError, DocumentStoreError, errorInfoOf, MemoryDocumentStore, type AskEvent, type GenerateText, type ModelMessage, type ModelToolRound, type ToolResultContext } from "llm-large-files";
import { uploadAnswerOf } from "llm-large-files/node";
import { eventErrorOf } from "../src/events.js";
import { parseItemLines } from "../src/map-reduce.js";
import { completeWithinLimit, type LimitedReply } from "../src/output-limit.js";
import { numberedPdf } from "./pdf-fixtures.js";
import { calls, fakeModel, httpError, says, serviceLog, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const look = (id: string, from: number, to = from) => ({ id: `c${from}`, name: "view_pages", args: { document_id: id, from_page: from, to_page: to } });

describe("onToolResult and the pages of view_pages", () => {
  /** A library of one user that keeps PDFs, and a PDF of six pages. */
  async function report() {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    return { files, meta };
  }
  const answerOf = (model: ReturnType<typeof fakeModel>) => (model.requests[1]!.messages.at(-1) as ModelToolRound).answers[0]!;

  it("gives the hook the pages, and sends them when it keeps the result", async () => {
    const { files, meta } = await report();
    const seen: ToolResultContext[] = [];
    const model = fakeModel([calls([look(meta.id, 2, 3)]), says("Two pages.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What is on pages 2 and 3?"), onToolResult: (context) => { seen.push(context); return undefined; } });
    expect(seen[0]!.files?.map((file) => [file.name, file.mimeType])).toEqual([["pages-2-3.pdf", "application/pdf"]]);
    expect(seen[0]!.files![0]!.bytes.length).toBeGreaterThan(100);
    expect(answerOf(model).files).toHaveLength(1);
  });

  it("does not send the pages of a result the hook replaced", async () => {
    const { files, meta } = await report();
    const model = fakeModel([calls([look(meta.id, 2, 3)]), says("I could not see them.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What is on pages 2 and 3?"), onToolResult: () => ({ result: { note: "REDACTED BY DLP" } }) });
    const answer = answerOf(model);
    expect(answer.result).toMatchObject({ note: "REDACTED BY DLP", redacted: true });
    expect(answer.files ?? []).toEqual([]);
  });

  it("sends the pages with a replacement that asks to keep them", async () => {
    const { files, meta } = await report();
    const model = fakeModel([calls([look(meta.id, 2, 3)]), says("Two pages.")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What is on pages 2 and 3?"), onToolResult: ({ result }) => ({ result: { ...result, document: "[name]" }, keepFiles: true }) });
    const answer = answerOf(model);
    expect(answer.result).toMatchObject({ document: "[name]", pages: "2-3", redacted: true });
    expect(answer.files).toHaveLength(1);
  });

  it("refuses a keepFiles that is not a boolean", async () => {
    const { files, meta } = await report();
    const model = fakeModel([calls([look(meta.id, 2)]), says("?")]);
    const outcome = askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onToolResult: () => ({ result: {}, keepFiles: "yes" as never }) });
    await expect(outcome).rejects.toThrow(TypeError);
    expect(model.requests).toHaveLength(1);
  });
});

describe("files.delete: the document it looked up", () => {
  /** A library with a clock, over a store whose first delete stays open until `open()`, as a slow store holds it. */
  function slowDeletes() {
    const time = { now: new Date("2026-11-25T10:00:00Z") };
    const store = new MemoryDocumentStore({ now: () => time.now });
    let open!: () => void;
    const held = new Promise<void>((resolve) => (open = resolve));
    const remove = store.delete.bind(store);
    let deletes = 0;
    store.delete = async (id, context) => {
      if (deletes++ === 0) await held;
      return remove(id, context);
    };
    const files = createLargeFiles({ store, ttlMs: 60_000, now: () => time.now });
    return { files, time, open };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("leaves the document another owner stored under the ID while the delete waited its turn", async () => {
    const { files, time, open } = slowDeletes();
    await files.ingest({ name: "other.txt", bytes: utf8("other"), id: "other", owner: "alice" });
    await files.ingest({ name: "a.txt", bytes: utf8("alice's"), id: "shared-id", owner: "alice" });
    const slow = files.delete("other", { owner: "alice" });
    // Looked up, and waiting behind the slow delete.
    const queued = files.delete("shared-id", { owner: "alice" });
    await tick();
    // Alice's document expires, and Bob stores his under the same ID.
    time.now = new Date(time.now.getTime() + 61_000);
    await files.ingest({ name: "b.txt", bytes: utf8("bob's"), id: "shared-id", owner: "bob" });
    open();
    await slow;
    expect(await queued).toBe(false);
    expect(await files.getMeta("shared-id", { owner: "bob" })).toMatchObject({ name: "b.txt", owner: "bob" });
  });

  it("leaves the document the same owner stored again under the ID meanwhile", async () => {
    const { files, time, open } = slowDeletes();
    await files.ingest({ name: "other.txt", bytes: utf8("other"), id: "other", owner: "alice" });
    await files.ingest({ name: "old.txt", bytes: utf8("old"), id: "notes", owner: "alice" });
    const slow = files.delete("other", { owner: "alice" });
    const queued = files.delete("notes", { owner: "alice" });
    await tick();
    time.now = new Date(time.now.getTime() + 61_000);
    await files.ingest({ name: "new.txt", bytes: utf8("new"), id: "notes", owner: "alice" });
    open();
    await slow;
    expect(await queued).toBe(false);
    expect(await files.getMeta("notes", { owner: "alice" })).toMatchObject({ name: "new.txt" });
  });

  it("still removes a document that waited its turn and did not change", async () => {
    const { files, open } = slowDeletes();
    await files.ingest({ name: "other.txt", bytes: utf8("other"), id: "other", owner: "alice" });
    await files.ingest({ name: "a.txt", bytes: utf8("alice's"), id: "notes", owner: "alice" });
    const slow = files.delete("other", { owner: "alice" });
    const queued = files.delete("notes", { owner: "alice" });
    await tick();
    open();
    expect(await slow).toBe(true);
    expect(await queued).toBe(true);
    expect(await files.getMeta("notes", { owner: "alice" })).toBeUndefined();
  });
});

describe("the error of an event", () => {
  it("keeps the code of a store error, so that errorInfoOf reads the event as it reads the error", () => {
    for (const code of ["ETIMEDOUT", "STORE_STUCK", "NEWER_VERSION", "EIO"]) {
      const error = new DocumentStoreError(Object.assign(new Error("db-1.internal did not answer"), { code }), { operation: "read", code });
      const data = eventErrorOf(error);
      expect(data).toMatchObject({ name: "DocumentStoreError", status: 503, storeCode: code });
      expect(errorInfoOf(data), code).toEqual(errorInfoOf(error));
      expect(errorInfoOf(data).code).toBe(code);
    }
    // A code that does not read as one (a driver may put a host in it) is not told.
    const odd = eventErrorOf(new DocumentStoreError(Object.assign(new Error("x"), { code: "db-1.internal:5432" })));
    expect(odd).not.toHaveProperty("storeCode");
    expect(JSON.stringify(odd)).not.toContain("db-1");
    // An event of 0.99.9, without the field, reads as before.
    expect(errorInfoOf({ message: "The document store could not be read (EIO). Try again.", name: "DocumentStoreError", status: 503 })).toMatchObject({ category: "store", status: 503, retryable: true });
  });

  it("takes credentials out of a message it passes on as written", () => {
    const told = (message: string) => eventErrorOf(new Error(message)).message;
    expect(told("connect to postgres://admin:s3cr3t@prod-db.internal:5432/dlp failed")).toBe("connect to postgres://… failed");
    expect(told("redis://:hunter2@cache.internal:6379 is down")).toBe("redis://… is down");
    expect(told("request to https://gateway.example/v1/models?key=AIzaSyABC123&alt=sse failed")).toBe("request to https://gateway.example/v1/models?key=…&alt=sse failed");
    expect(told("GET https://files.example/a.pdf?X-Amz-Signature=abcdef0123&api_key=k1 403")).toBe("GET https://files.example/a.pdf?X-Amz-Signature=…&api_key=… 403");
    // The library's own refusals, and words without credentials, are told as they are written.
    expect(told("app.log is empty.")).toBe("app.log is empty.");
    expect(told("See https://example.com/help?topic=limits for the limits of user@example.com.")).toBe("See https://example.com/help?topic=limits for the limits of user@example.com.");
  });

  it("tells a system error a client passed on under its own class without its message", () => {
    class FetchError extends Error {}
    const failed = Object.assign(new FetchError("request to https://gateway.internal/v1?k=abc failed, reason: getaddrinfo ENOTFOUND gateway.internal"), { type: "system", errno: "ENOTFOUND", code: "ENOTFOUND" });
    expect(eventErrorOf(failed).message).toBe("Something went wrong.");
    const refused = Object.assign(new Error("Access denied for user 'admin'@'10.0.0.5' (using password: YES)"), { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 });
    expect(eventErrorOf(refused).message).toBe("Something went wrong.");
    // An error of the application with a code of its own keeps its words.
    expect(eventErrorOf(Object.assign(new Error("This chat was closed."), { code: "CHAT_CLOSED" })).message).toBe("This chat was closed.");
  });

  it("answers an upload without the credentials of an error that has a status of its own", () => {
    const refused = Object.assign(new Error("This chat is closed."), { status: 403 });
    expect(uploadAnswerOf(refused)).toEqual({ status: 403, error: "This chat is closed." });
    const sdk = Object.assign(new Error("502 from https://scan:hunter2@scanner.internal/v1?token=abc123"), { status: 502 });
    expect(uploadAnswerOf(sdk)).toEqual({ status: 502, error: "502 from https://…" });
  });

  it("sends run.error without the credentials of what a hook of the application threw", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8(Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n")) });
    const events: AskEvent[] = [];
    const model = fakeModel([calls([{ id: "r1", name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 3 } }]), says("?")]);
    const secret = "postgres://admin:s3cr3t@prod-db.internal:5432/dlp";
    const outcome = askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event), onToolResult: () => { throw new Error(`DLP log failed: ${secret}`); } });
    // The error that is thrown keeps its words, for the server's log.
    await expect(outcome).rejects.toThrow(secret);
    const last = events.at(-1) as Extract<AskEvent, { type: "run.error" }>;
    expect(last.type).toBe("run.error");
    expect(JSON.stringify(events)).not.toContain("s3cr3t");
    expect(JSON.stringify(events)).not.toContain("prod-db.internal");
    expect(last.error.message).toBe("DLP log failed: postgres://…");
  });
});

describe("a whole-file read that reads a part as two halves", () => {
  /**
   * A log read in three parts whose notes need no merge, by a model that refuses the second and
   * the third part whole, as larger than it takes: every request, counted by what it is.
   */
  async function readWith(maxRequests: number) {
    // Parts of 16,000 tokens: the notes of three parts, at the output limit, fit one request (no merge is priced).
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 16_000, contextTokens: 200_000, inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(600)) });
    const made = { parts: 0, refused: 0, halves: 0, answers: 0 };
    const generate: GenerateText = async ({ system, prompt }) => {
      if (system.startsWith("You write a complete answer")) {
        made.answers++;
        return "The answer (L1).";
      }
      made.parts++;
      expect(prompt).toMatch(/This is part \d of 3/);
      if (/ half\.$/m.test(prompt)) made.halves++;
      else if (!prompt.includes("part 1 of 3")) {
        made.refused++;
        throw Object.assign(new Error("too large"), { status: 400, kind: "context_overflow" });
      }
      return "A note (L1).";
    };
    const { result } = await files.tools([meta], { generate, retry: { retries: 0 } }).executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every failure" }, { maxRequests });
    return { result, made, total: made.parts + made.answers };
  }

  it("counts two requests more for it, and stays within maxRequests", async () => {
    // Three parts and the answer: 4. With two more, one part can be halved (the request that was
    // refused, then one for each half), and the answer is still written.
    const six = await readWith(6);
    expect(six.made).toEqual({ parts: 5, refused: 2, halves: 2, answers: 1 });
    expect(six.total).toBe(6);
    expect(six.result).toMatchObject({ answer: "The answer (L1).", parts_that_failed: 1 });
    // With one more only, no part is halved: before 0.99.10 one was, and the answer's request went to it.
    const five = await readWith(5);
    expect(five.made).toEqual({ parts: 3, refused: 2, halves: 0, answers: 1 });
    expect(five.result).toMatchObject({ answer: "The answer (L1).", parts_that_failed: 2 });
    // Room for both.
    const eight = await readWith(8);
    expect(eight.made).toEqual({ parts: 7, refused: 2, halves: 4, answers: 1 });
    expect(eight.total).toBe(8);
  });
});

describe("a question planned again for a smaller window", () => {
  /**
   * A log sent whole that the model refuses as too large (413), so that the question is planned
   * again, over a store whose `getMeta` does `onSecondPlan` once the first request was refused.
   */
  async function refusedOnce(onSecondPlan: () => void) {
    const store = new MemoryDocumentStore();
    const files = createLargeFiles({ requireOwner: false, store, budget: { contextTokens: 200_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(600)) });
    let refused = false;
    const getMeta = store.getMeta.bind(store);
    store.getMeta = async (id, context) => {
      if (refused) onSecondPlan();
      return getMeta(id, context);
    };
    const model = fakeModel([() => {
      refused = true;
      return httpError(413);
    }]);
    return { files, meta, model, store };
  }

  it("throws the reason of a stop that came while the documents were planned again, not the overflow", async () => {
    const stop = new AbortController();
    const reason = new DOMException("The user left.", "AbortError");
    const { files, meta, model } = await refusedOnce(() => stop.abort(reason));
    const outcome = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), signal: stop.signal }).then(() => undefined, (error: unknown) => error);
    expect(outcome).toBe(reason);
    expect(model.requests).toHaveLength(1);
  });

  it("throws the store's error when the store failed while the documents were planned again", async () => {
    const { files, meta, model } = await refusedOnce(() => {
      throw Object.assign(new Error("EIO: i/o error, read '/srv/files/doc.json'"), { code: "EIO", syscall: "read" });
    });
    const outcome = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") }).then(() => undefined, (error: unknown) => error);
    expect(DocumentStoreError.is(outcome)).toBe(true);
    expect(errorInfoOf(outcome)).toMatchObject({ category: "store", code: "EIO", retryable: true });
  });

  it("throws DocumentsNotFoundError when a document went while the documents were planned again", async () => {
    let deleted = false;
    const { files, meta, model, store } = await refusedOnce(() => {
      if (!deleted) void store.delete(meta.id);
      deleted = true;
    });
    const outcome = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") }).then(() => undefined, (error: unknown) => error);
    expect(DocumentsNotFoundError.is(outcome)).toBe(true);
    expect(errorInfoOf(outcome)).toMatchObject({ category: "missing", code: "documents_missing" });
  });
});

describe("the request for the answer, replied to with a tool call that could not be read", () => {
  async function largeLog() {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    return { files, meta };
  }
  const search = (id: string) => ({ id: "c1", name: "search_document", args: { document_id: id, query: "ERROR", mode: "exact" } });

  it("is asked again: the remark before the call is not the answer", async () => {
    const { files, meta } = await largeLog();
    const steps: string[] = [];
    const model = fakeModel([
      calls([search(meta.id)]),
      // The last tool turn: its remark is not the answer, so the answer is asked for.
      says("Let me look at the error lines.", { finish: "malformed_call" }),
      // The answer's request, replied to the same way: before 0.99.10 this remark was the answer.
      says("I will read lines 90 to 100.", { finish: "malformed_call" }),
      says("There are 20 errors (app.log L97)."),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), limits: { toolTurns: 3 }, onStep: (line) => steps.push(line) });
    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none", "none"]);
    expect(steps).toContain("The model called a tool instead of answering: it was asked again for the answer");
    expect(result.answered).toBe(true);
    expect(result.text.endsWith("There are 20 errors (app.log L97).")).toBe(true);
  });

  it("is not an answer when it comes again after the second request", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([
      calls([search(meta.id)]),
      says("Let me look at the error lines.", { finish: "malformed_call" }),
      says("I will read lines 90 to 100.", { finish: "malformed_call" }),
      says("Reading them now.", { finish: "malformed_call" }),
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many errors?"), limits: { toolTurns: 3 } });
    expect(model.requests).toHaveLength(4);
    expect(result.answered).toBe(false);
  });
});

describe("a part read that lists items, replied to with an empty wrapped list", () => {
  it("has no item: the wrapper is not counted as an item that could not be checked", () => {
    for (const reply of ['{"items": []}', '{ "items": [ ] }', "```json\n{\"items\": []}\n```", '{"results": [], "note": "no such item in this part"}']) {
      expect(parseItemLines(reply), reply).toEqual({ objects: [], skipped: 0 });
    }
    // A wrapped list with items, and an item of its own with an empty list in it, read as before.
    expect(parseItemLines('{"items": [{"line": 3, "quote": "a b c"}]}').objects).toEqual([{ line: 3, quote: "a b c" }]);
    expect(parseItemLines('{"line": 3, "value": "x", "tags": []}').objects).toEqual([{ line: 3, value: "x", tags: [] }]);
  });

  it("is told to the model as a part with no item, with nothing unverified", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(200)) });
    const generate: GenerateText = async () => '{"items": []}';
    const { result } = await files.tools([meta], { generate }).executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every refund", output: "items" });
    // Before 0.99.10: unverified_items 1, the wrapper itself.
    expect(result).toMatchObject({ total_items: 0, items: [], unverified_items: 0, note: "No part of app.log listed an item for: list every refund." });
  });
});

describe("a call that pointed to a result shortened in its own turn", () => {
  it("is given room of its own: older rounds are shortened further for it", async () => {
    // Four reads in four turns, then a turn with a new read and the first read again. The window
    // has room for the new read once the first round is shortened: the repeated read, which pointed
    // to that round, then runs after all. Before 0.99.10 its room was not counted: it shared the
    // room made for the new read, and came back cut (63 of its 90 lines), while two older rounds
    // could still be shortened.
    const lines = Array.from({ length: 6_000 }, (_, i) => {
      const n = i + 1;
      return `2026-11-12T08:00:${String(n % 60).padStart(2, "0")}Z ${n % 50 === 0 ? "ERROR" : "INFO"} [w-${n % 8}] req=${(n * 2654435761 >>> 0).toString(16)} GET /api/orders/${n} took ${(n * 37) % 900}ms`;
    });
    const contextTokens = 31_500;
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { contextTokens, inlineTokens: 1_000, toolResultCharacters: 8_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(lines.join("\n")) });
    const read = (from: number, count: number) => ({ name: "read_document", args: { document_id: meta.id, start_line: from, end_line: from + count - 1 } });
    const turns = [[read(1, 90)], [read(601, 90)], [read(1_201, 90)], [read(3_000, 30)], [read(1_801, 90), read(1, 90)]];
    const model = fakeModel([(_request, call) => {
      const list = turns[call - 1];
      return list ? calls(list.map((entry, index) => ({ id: `c${call}_${index}`, ...entry }))) : says("Done.");
    }], { toolFiles: "none", contextTokens });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("List the errors."), limits: { toolTurns: 8 } });
    const rounds = (model.requests.at(-1)!.messages as ModelMessage[]).filter((message): message is ModelToolRound => message.role === "tools");
    const answerOf = (id: string) => rounds.flatMap((round) => round.answers).find((answer) => answer.call.id === id)?.result;
    // The first shortening of the question is in the last turn.
    expect(result.steps.filter((line) => line === "Older tool results were shortened to make room in the request")).toHaveLength(1);
    expect(result.steps.at(-3)).toBe("Older tool results were shortened to make room in the request");
    expect(answerOf("c1_0")).toMatchObject({ dropped: true });
    // Run again, and whole: the second and third rounds were shortened for it.
    expect(answerOf("c5_1")).not.toHaveProperty("already_shown");
    expect(answerOf("c5_1")).toMatchObject({ lines: "1-90" });
    expect(answerOf("c2_0")).toMatchObject({ dropped: true });
    expect(String(answerOf("c5_0")!.lines)).toMatch(/^1801-/);
  });
});

describe("the larger output limit of a part read, refused with HTTP 422", () => {
  it("is not asked for again, as after a 400", async () => {
    for (const status of [400, 422]) {
      const model = `https://example.invalid/review-0.99.10-${status}-${Date.now()}`;
      const limits: number[] = [];
      // Every reply at the usual limit is cut off with nothing written; the larger limit is refused.
      const send = async (limit: number): Promise<LimitedReply> => {
        limits.push(limit);
        if (limit > 4_096) throw Object.assign(new Error("Input should be less than or equal to 4096"), { status });
        return { text: "", cutOff: true, thoughts: 0 };
      };
      await expect(completeWithinLimit(model, 4_096, send), String(status)).rejects.toMatchObject({ status });
      await expect(completeWithinLimit(model, 4_096, send), String(status)).rejects.toThrow("The model returned no text");
      // The second read did not ask for the larger limit: before 0.99.10, after a 422, it did.
      expect(limits, String(status)).toEqual([4_096, 32_768, 4_096]);
    }
  });
});
