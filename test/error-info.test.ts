import { describe, expect, it, vi } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DocumentScopeError,
  DocumentsNotFoundError,
  DocumentStoreError,
  errorInfoOf,
  IngestError,
  MemoryDocumentStore,
  ModelRequestError,
  type AskEvent,
  type ErrorInfo,
  type EventError,
  type IngestErrorCode,
} from "llm-large-files";
import { GeminiRequestError } from "llm-large-files/gemini";
import { eventErrorOf } from "../src/events.js";
import { fakeModel, httpError, utf8 } from "./fake-model.js";

const HOST = "mongo-prod.internal.corp:27017";
const PATH = "/srv/large-files/doc_1.json";

/** A message a user may see: no host, no path, no stack, no provider's project. */
function expectSafe(info: ErrorInfo): void {
  expect(info.message).not.toContain("mongo");
  expect(info.message).not.toContain("/srv");
  expect(info.message).not.toContain("acme-prod");
  expect(info.message).not.toMatch(/\n\s+at /);
  expect(info.status).toBeGreaterThanOrEqual(400);
  expect(info.status).toBeLessThanOrEqual(599);
}

describe("errorInfoOf", () => {
  it("ingest: a refused file, by its code and status", () => {
    expect(errorInfoOf(new IngestError("too_large", "a.log is larger than the 100 MB upload limit."))).toEqual({
      category: "ingest", code: "too_large", status: 413, retryable: false, message: "a.log is larger than the 100 MB upload limit.",
    });
    expect(errorInfoOf(new IngestError("busy", "The server is reading other files right now. Try again in a moment.", { retryAfterMs: 5_000 }))).toEqual({
      category: "ingest", code: "busy", status: 503, retryable: true, retryAfterMs: 5_000, message: "The server is reading other files right now. Try again in a moment.",
    });
    expect(errorInfoOf(new IngestError("exists", "a.txt: a document with this ID already exists."))).toMatchObject({ category: "ingest", code: "exists", status: 409, retryable: false });
    // An unreadable file has the parser's words, or those of an extractor of your own.
    const unreadable = errorInfoOf(new IngestError("unreadable", `Could not open ${PATH} on ${HOST}`));
    expect(unreadable).toEqual({ category: "ingest", code: "unreadable", status: 422, retryable: false, message: "This file could not be read. It may be damaged, or not of the type its name says." });
    const codes: IngestErrorCode[] = ["empty", "too_much_text", "too_many_pages", "not_text", "compressed", "legacy_office", "encrypted", "no_text", "hostile", "timeout", "out_of_memory", "missing_dependency"];
    for (const code of codes) expect(errorInfoOf(new IngestError(code, "x")), code).toMatchObject({ category: "ingest", code, status: 422, retryable: false, message: "x" });
  });

  it("store: a store that failed, retryable, without its host or path", () => {
    const read = errorInfoOf(new DocumentStoreError(Object.assign(new Error(`EIO: read '${PATH}'`), { code: "EIO", syscall: "read" })));
    expect(read).toEqual({ category: "store", code: "EIO", status: 503, retryable: true, retryAfterMs: 5_000, message: "The document store could not be read (EIO). Try again." });
    const write = errorInfoOf(new DocumentStoreError(new Error(`MongoServerSelectionError: ${HOST}`), { operation: "write" }));
    expect(write).toEqual({ category: "store", status: 503, retryable: true, retryAfterMs: 5_000, message: "The document could not be stored. Try again." });
    expectSafe(read);
    expectSafe(write);
  });

  // A driver may put a host in `code`: the store's message leaves such a code out, and so does the
  // info's `code` now (it passed it on as it was).
  it("store: gives the code only when it reads as one", () => {
    const hostCode = errorInfoOf(new DocumentStoreError(Object.assign(new Error("x"), { code: HOST })));
    expect(hostCode).toEqual({ category: "store", status: 503, retryable: true, retryAfterMs: 5_000, message: "The document store could not be read. Try again." });
    expect(errorInfoOf(new DocumentStoreError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).code).toBe("ECONNREFUSED");
    expect(errorInfoOf(new DocumentStoreError(undefined, { code: "NEWER_VERSION" })).code).toBe("NEWER_VERSION");
    expect(errorInfoOf(new DocumentStoreError(Object.assign(new Error("x"), { code: "eio" }))).code).toBeUndefined();
  });

  it("missing: documents that are gone, and a chat that is gone", () => {
    expect(errorInfoOf(new DocumentsNotFoundError(["doc_1"]))).toEqual({
      category: "missing", code: "documents_missing", status: 404, retryable: false, message: "A document is no longer available: doc_1. Upload it again.",
    });
    expect(errorInfoOf(new DocumentScopeError("scope_missing"))).toEqual({ category: "missing", code: "scope_missing", status: 404, retryable: false, message: "This chat no longer exists." });
  });

  it("model: by its kind, with the status a server answers, never the provider's words", () => {
    const cases: Array<[ModelRequestError, Partial<ErrorInfo>]> = [
      [new ModelRequestError("Request too large for acme-prod: Limit 30000, Requested 45237", 413), { code: "context_overflow", status: 413, retryable: false }],
      [new ModelRequestError("Resource exhausted for acme-prod.", 429, { retryAfterMs: 30_000 }), { code: "rate_limit", status: 429, retryable: true, retryAfterMs: 30_000 }],
      [new ModelRequestError("insufficient_quota acme-prod", 429, { code: "insufficient_quota" }), { code: "quota", status: 503, retryable: false }],
      [new ModelRequestError("Nothing came from acme-prod.", 0, { kind: "timeout" }), { code: "timeout", status: 504, retryable: true }],
      [new ModelRequestError("connect ECONNREFUSED acme-prod.example:443", 0), { code: "unreachable", status: 502, retryable: true }],
      [new GeminiRequestError("Internal error in acme-prod.", 500), { code: "server", status: 502, retryable: true }],
      [new ModelRequestError("API key not valid for acme-prod.", 401), { code: "auth", status: 500, retryable: false }],
      [new ModelRequestError("Bad request for acme-prod.", 400), { code: "invalid", status: 500, retryable: false }],
    ];
    for (const [error, expected] of cases) {
      const info = errorInfoOf(error);
      expect(info, error.message).toMatchObject({ category: "model", ...expected });
      expect(info.message).toMatch(/model/);
      expectSafe(info);
    }
    // An error of an adapter of your own, with a status and no kind.
    expect(errorInfoOf(Object.assign(new Error("acme-prod is busy"), { status: 503 }))).toMatchObject({ category: "model", code: "server", status: 502, retryable: true });
  });

  it("aborted: a stop, and a deadline", () => {
    expect(errorInfoOf(new DOMException("The run was stopped.", "AbortError"))).toEqual({ category: "aborted", code: "aborted", status: 503, retryable: true, message: "It was stopped before it finished." });
    const deadline = AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
    expect(errorInfoOf(deadline.reason)).toEqual({ category: "aborted", code: "timeout", status: 504, retryable: true, message: "It took too long, and was stopped. Try again." });
  });

  it("input: a mistake of the call, a bug of the server and not the user's", () => {
    expect(errorInfoOf(new TypeError("owner is required: requireOwner is on"))).toEqual({ category: "input", status: 500, retryable: false, message: "Something went wrong." });
    expect(errorInfoOf(new RangeError("budget.reservedTokens must be smaller"))).toMatchObject({ category: "input", status: 500 });
    expect(errorInfoOf(new DocumentScopeError("scope_invalid"))).toEqual({ category: "input", code: "scope_invalid", status: 500, retryable: false, message: "Something went wrong." });
    expect(errorInfoOf(new DocumentScopeError("scope_required"))).toMatchObject({ category: "input", code: "scope_required", status: 500 });
  });

  it("unknown: anything else, with the code of a system error and never its message", () => {
    const system = errorInfoOf(Object.assign(new Error(`EACCES: permission denied, write '${PATH}'`), { code: "EACCES", syscall: "write" }));
    expect(system).toEqual({ category: "unknown", code: "EACCES", status: 500, retryable: false, message: "Something went wrong (EACCES)." });
    // A full disk is 503, to try again later, since 0.10.0 (test/error-info-transient.test.ts).
    const full = errorInfoOf(Object.assign(new Error(`ENOSPC: no space left on device, write '${PATH}'`), { code: "ENOSPC", syscall: "write" }));
    expect(full).toEqual({ category: "unknown", code: "ENOSPC", status: 503, retryable: true, retryAfterMs: 30_000, message: "The server has no room right now (ENOSPC). Try again later." });
    expectSafe(full);
    const plain = errorInfoOf(new Error(`MongoServerSelectionError: connect ECONNREFUSED ${HOST}`));
    expect(plain).toEqual({ category: "unknown", status: 500, retryable: false, message: "Something went wrong." });
    for (const value of [undefined, null, "a string", 42, { message: HOST }]) {
      expect(errorInfoOf(value)).toEqual({ category: "unknown", status: 500, retryable: false, message: "Something went wrong." });
    }
    // Never throws, even for a value whose fields throw when read.
    const hostile = new Proxy({}, { get() { throw new Error(HOST); }, getPrototypeOf() { throw new Error(HOST); } });
    expect(errorInfoOf(hostile)).toEqual({ category: "unknown", status: 500, retryable: false, message: "Something went wrong." });
    expectSafe(system);
    expectSafe(plain);
  });

  it("reads an EventError, the plain data of run.error and ingest.error", () => {
    const events = [
      [eventErrorOf(new IngestError("no_text", "scan.pdf has no text layer.")), { category: "ingest", code: "no_text", status: 422, retryable: false, message: "scan.pdf has no text layer." }],
      [eventErrorOf(new IngestError("busy", "Busy.", { retryAfterMs: 5_000 })), { category: "ingest", code: "busy", status: 503, retryable: true }],
      // ingest.error of the upload handler: no name, and always a status.
      [{ message: "a.bin looks binary, not text.", status: 422, code: "not_text" }, { category: "ingest", code: "not_text", status: 422 }],
      [eventErrorOf(new DocumentStoreError(new Error(HOST), { operation: "write" })), { category: "store", status: 503, retryable: true, retryAfterMs: 5_000, message: "The document could not be stored. Try again." }],
      [eventErrorOf(new DocumentsNotFoundError(["doc_1"])), { category: "missing", code: "documents_missing", status: 404 }],
      [eventErrorOf(new ModelRequestError("Busy at acme-prod.", 429)), { category: "model", code: "rate_limit", status: 429, message: "The model was busy (HTTP 429)." }],
      [eventErrorOf(new DOMException("The run was stopped.", "AbortError")), { category: "aborted", code: "aborted" }],
      [eventErrorOf(new Error(`connect ${HOST}`)), { category: "unknown", status: 500, message: "Something went wrong." }],
    ] as const;
    for (const [data, expected] of events) {
      expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
      const info = errorInfoOf(data);
      expect(info, JSON.stringify(data)).toMatchObject(expected);
      expectSafe(info);
    }
    // A model's words in plain data are not taken: a model error is told by its kind.
    expect(errorInfoOf({ kind: "quota", status: 429, message: "Quota of acme-prod exceeded." }).message).toBe("The model's quota has run out (HTTP 429).");
    expect(errorInfoOf({ kind: "rate_limit", status: 429, message: "The model was busy (HTTP 429). acme-prod" }).message).toBe("The model was busy (HTTP 429).");
    expect(errorInfoOf({ kind: "server", status: 502, message: "The model was busy (HTTP 429)." }).message).toBe("The model failed on its side (HTTP 502).");
    // The library's own words for its kind are kept: the upload handlers' ingest.error names the
    // provider's status in them, and the answer's in `status`.
    expect(errorInfoOf({ kind: "server", status: 502, message: "The model failed on its side (HTTP 503)." })).toEqual({ category: "model", code: "server", status: 502, retryable: true, message: "The model failed on its side (HTTP 503)." });
    expect(errorInfoOf({ kind: "unreachable", status: 502, message: "The model could not be reached." }).message).toBe("The model could not be reached.");
    expect(errorInfoOf({ kind: "invalid", status: 500, message: "The model's reply could not be read (HTTP 200)." }).message).toBe("The model's reply could not be read (HTTP 200).");
  });

  // run.error of a scope error had no code: a deleted chat was "unknown" and 500.
  it("reads the EventError of a scope error by its name and code", () => {
    const gone = eventErrorOf(new DocumentScopeError("scope_missing"));
    expect(gone).toEqual({ message: "The scope no longer exists.", name: "DocumentScopeError", code: "scope_missing" });
    expect(errorInfoOf(gone)).toEqual({ category: "missing", code: "scope_missing", status: 404, retryable: false, message: "This chat no longer exists." });
    expect(errorInfoOf(eventErrorOf(new DocumentScopeError("scope_invalid")))).toEqual({ category: "input", code: "scope_invalid", status: 500, retryable: false, message: "Something went wrong." });
    expect(errorInfoOf(eventErrorOf(new DocumentScopeError("scope_required")))).toMatchObject({ category: "input", code: "scope_required", status: 500 });
    // Its own words, which a store of your own wrote, are not the info's.
    expect(errorInfoOf({ message: "Folder /srv/u1/c1 is gone.", name: "DocumentScopeError", code: "scope_missing" }).message).toBe("This chat no longer exists.");
    expect(errorInfoOf({ message: "x", name: "DocumentScopeError", code: "not_a_code" })).toEqual({ category: "input", status: 500, retryable: false, message: "Something went wrong." });
  });

  // Plain data with a status and no kind was read as a model's error: the handler's
  // { message: "Upload failed.", status: 500 } became "The model failed on its side", and 502.
  it("reads plain data without a kind, a name it knows or an ingest code as unknown, keeping its status", () => {
    const cases: Array<[Record<string, unknown>, ErrorInfo]> = [
      [{ message: "Upload failed.", status: 500 }, { category: "unknown", status: 500, retryable: false, message: "Something went wrong." }],
      [{ message: "This chat no longer exists.", status: 404 }, { category: "unknown", status: 404, retryable: false, message: "Something went wrong." }],
      [{ message: `Down at ${HOST}.`, status: 503 }, { category: "unknown", status: 503, retryable: true, message: "Something went wrong." }],
      [{ message: "Slow down.", status: 429 }, { category: "unknown", status: 429, retryable: true, message: "Something went wrong." }],
      // Not what eventErrorOf makes of a connection that failed: that one has its kind (below).
      [{ message: "No answer.", status: 0 }, { category: "unknown", status: 500, retryable: false, message: "Something went wrong." }],
      [{ message: "Not a status.", status: 200 }, { category: "unknown", status: 500, retryable: false, message: "Something went wrong." }],
      [Object.assign(Object.create(null) as object, { message: "x", status: 502 }), { category: "unknown", status: 502, retryable: true, message: "Something went wrong." }],
    ];
    for (const [data, expected] of cases) {
      const info = errorInfoOf(data);
      expect(info, JSON.stringify(data)).toEqual(expected);
      expectSafe(info);
    }
    // An Error with a status and no kind is still an adapter's of your own.
    expect(errorInfoOf(Object.assign(new Error("Busy."), { status: 503 }))).toMatchObject({ category: "model", code: "server" });
    // And its EventError has its kind: { message, status: 0, name: "Error" } read as "unknown", 500.
    const noAnswer = eventErrorOf(httpError(0, "No answer from acme-prod."));
    expect(noAnswer).toEqual({ message: "The model could not be reached.", status: 0, name: "Error", kind: "unreachable" });
    expect(errorInfoOf(noAnswer)).toEqual({ category: "model", code: "unreachable", status: 502, retryable: true, message: "The model could not be reached." });
  });

  // An adapter's Error with a status and no kind (httpError, an SDK's error) gave events without a
  // kind, and errorInfoOf read them as "unknown": a 429 was not "rate_limit", a 503 kept 503, and a
  // 401, the server's own key, kept 401 for the browser.
  it("reads the run.error, retry and request.end of a model error without a kind as the error itself", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    // The third item: whether the request is sent again, when that is not what `retryable` says.
    const cases: Array<[Error, Partial<ErrorInfo>, boolean?]> = [
      [httpError(429, "Busy at acme-prod."), { code: "rate_limit", status: 429, retryable: true, message: "The model was busy (HTTP 429)." }],
      [httpError(503, "acme-prod is down."), { code: "server", status: 502, retryable: true, message: "The model failed on its side (HTTP 503)." }],
      [httpError(401, "API key not valid for acme-prod."), { code: "auth", status: 500, retryable: false, message: "The model refused the key or token it was sent (HTTP 401)." }],
      [httpError(0, "connect ECONNREFUSED acme-prod.example:443"), { code: "unreachable", status: 502, retryable: true, message: "The model could not be reached." }],
      // Its code says what its words do not: the events read it, errorInfoOf does, and so does the
      // retry policy, which sent this 429 again by its status, between events that called it a quota.
      [Object.assign(httpError(429, "Too many."), { code: "insufficient_quota" }), { code: "quota", status: 503, retryable: false, message: "The model's quota has run out (HTTP 429)." }],
    ];
    for (const [error, expected, sentAgain = expected.retryable] of cases) {
      const events: AskEvent[] = [];
      const failure = await askWithFiles({
        files,
        model: fakeModel([error]),
        documentIds: [meta.id],
        messages: [{ role: "user", text: "What is the code word?" }],
        retry: { retries: 1, random: () => 1, sleep: async () => undefined },
        onEvent: (event) => events.push(event),
      }).catch((thrown: unknown) => thrown);
      const thrown = errorInfoOf(failure);
      expect(thrown, error.message).toEqual({ category: "model", ...expected });
      const errors: Array<[string, EventError]> = events.flatMap((event): Array<[string, EventError]> => {
        if (event.type === "run.error" || event.type === "retry") return [[event.type, event.error]];
        if (event.type === "request.end" && event.error) return [["request.end", event.error]];
        return [];
      });
      // A retry only for what is sent again; a request.end for each try.
      expect(errors.map(([type]) => type), error.message).toEqual(sentAgain ? ["retry", "request.end", "run.error"] : ["request.end", "run.error"]);
      for (const [type, data] of errors) {
        expect(data.kind, `${error.message}: ${type}`).toBe(expected.code);
        const info = errorInfoOf(data);
        expect(info, `${error.message}: ${type}`).toEqual(thrown);
        expect(info.status).not.toBe(401);
        expectSafe(info);
      }
    }
  });

  // errorInfoOf read an adapter's error without its `code`, while its EventError used it: a 429
  // "insufficient_quota" was rate_limit for the error and quota for its events. A status above 599
  // and thrown plain data got a model's kind in the event only, and then still a model's words
  // ("The model was busy (HTTP 429).") where errorInfoOf said "Something went wrong.".
  it("reads an adapter's error as its EventError: by its code, by a status of 400 to 599, and not as plain data", () => {
    const cases: Array<[unknown, Partial<ErrorInfo>]> = [
      [Object.assign(httpError(429, "Too many."), { code: "insufficient_quota" }), { category: "model", code: "quota", status: 503, retryable: false }],
      [Object.assign(httpError(400, "Bad request."), { code: "context_length_exceeded" }), { category: "model", code: "context_overflow", status: 413 }],
      [Object.assign(httpError(400, "Bad request."), { code: "request_too_large" }), { category: "model", code: "context_overflow", status: 413 }],
      [httpError(600, "Not HTTP."), { category: "unknown", status: 500, retryable: false, message: "Something went wrong." }],
      [{ status: 429, message: `Busy at ${HOST}.` }, { category: "unknown", status: 429, retryable: true, message: "Something went wrong." }],
      [{ status: 503, message: "Down." }, { category: "unknown", status: 503, retryable: true, message: "Something went wrong." }],
    ];
    for (const [error, expected] of cases) {
      const label = JSON.stringify(error) === "{}" ? String(error) : JSON.stringify(error);
      const info = errorInfoOf(error);
      expect(info, label).toMatchObject(expected);
      const data = eventErrorOf(error);
      if (expected.category !== "model") expect(data, label).not.toHaveProperty("kind");
      expect(errorInfoOf(data), label).toEqual(info);
      expect(data.message, label).toBe(info.message);
      expectSafe(info);
    }
  });

  // The library's own errors with a status are not a model's: their events never get a kind, from
  // any copy of the package.
  it("gives no kind to the events of the library's own errors", async () => {
    const own = (errors: typeof import("../src/errors.js"), model: typeof import("../src/model.js")): unknown[] => [
      new errors.DocumentStoreError(Object.assign(new Error("x"), { code: "EIO", syscall: "write" }), { operation: "write" }),
      new model.DocumentsNotFoundError(["doc_1"]),
      new errors.IngestError("busy", "Busy.", { retryAfterMs: 5_000 }),
      new errors.IngestError("too_large", "Too large."),
      new errors.IngestError("exists", "Exists."),
      new errors.IngestError("unreadable", "Invalid PDF structure."),
      new errors.DocumentScopeError("scope_missing"),
      new errors.DocumentScopeError("scope_invalid"),
    ];
    const here = own(await import("../src/errors.js"), await import("../src/model.js"));
    vi.resetModules();
    const other = own(await import("../src/errors.js"), await import("../src/model.js"));
    for (const error of [...here, ...other]) {
      const data = eventErrorOf(error);
      expect(data, JSON.stringify(data)).not.toHaveProperty("kind");
      expect(errorInfoOf(data).category, JSON.stringify(data)).not.toBe("model");
    }
  });

  it("reads the errors of another copy of the package", async () => {
    vi.resetModules();
    const errors = await import("../src/errors.js");
    const model = await import("../src/model.js");
    expect(errors.IngestError).not.toBe(IngestError);
    expect(model.ModelRequestError).not.toBe(ModelRequestError);
    expect(errorInfoOf(new errors.IngestError("busy", "Busy.", { retryAfterMs: 1_000 }))).toMatchObject({ category: "ingest", code: "busy", status: 503, retryAfterMs: 1_000 });
    expect(errorInfoOf(new errors.DocumentStoreError(new Error(HOST), { operation: "delete" }))).toMatchObject({ category: "store", status: 503, message: "The document could not be deleted. Try again." });
    expect(errorInfoOf(new errors.DocumentScopeError("scope_missing"))).toMatchObject({ category: "missing", code: "scope_missing", status: 404 });
    expect(errorInfoOf(new errors.DocumentScopeError("scope_invalid"))).toMatchObject({ category: "input", code: "scope_invalid", status: 500 });
    expect(errorInfoOf(new model.DocumentsNotFoundError(["doc_1"]))).toMatchObject({ category: "missing", code: "documents_missing", status: 404 });
    expect(errorInfoOf(new model.ModelRequestError("Busy at acme-prod.", 429))).toMatchObject({ category: "model", code: "rate_limit", status: 429, message: "The model was busy (HTTP 429)." });
    // The second copy's own errorInfoOf reads this copy's errors too.
    const { errorInfoOf: otherInfoOf } = await import("../src/error-info.js");
    expect(otherInfoOf).not.toBe(errorInfoOf);
    expect(otherInfoOf(new IngestError("exists", "x"))).toMatchObject({ category: "ingest", code: "exists", status: 409 });
    expect(otherInfoOf(new DocumentStoreError(new Error(HOST)))).toMatchObject({ category: "store", status: 503 });
  });
});
