import { describe, expect, it, vi } from "vitest";
import {
  DocumentScopeError,
  DocumentsNotFoundError,
  DocumentStoreError,
  errorInfoOf,
  IngestError,
  ModelRequestError,
  type ErrorInfo,
  type IngestErrorCode,
} from "llm-large-files";
import { GeminiRequestError } from "llm-large-files/gemini";
import { eventErrorOf } from "../src/events.js";

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
    const system = errorInfoOf(Object.assign(new Error(`ENOSPC: no space left on device, write '${PATH}'`), { code: "ENOSPC", syscall: "write" }));
    expect(system).toEqual({ category: "unknown", code: "ENOSPC", status: 500, retryable: false, message: "Something went wrong (ENOSPC)." });
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
