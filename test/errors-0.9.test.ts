import { describe, expect, it, vi } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DocumentScopeError,
  DocumentsNotFoundError,
  DocumentStoreError,
  IngestError,
  MemoryDocumentStore,
  ModelRequestError,
  type AskEvent,
} from "llm-large-files";
import { eventErrorOf } from "../src/events.js";
import { fakeModel, says } from "./fake-model.js";

const eio = () => Object.assign(new Error("EIO: i/o error, read '/srv/large-files/doc_1.json'"), { code: "EIO", syscall: "read" });

describe("DocumentStoreError", () => {
  it("says what the store was doing, with status 503 and no path", () => {
    const cases = [
      [undefined, "The document store could not be read (EIO). Try again."],
      ["read", "The document store could not be read (EIO). Try again."],
      ["write", "The document could not be stored (EIO). Try again."],
      ["delete", "The document could not be deleted (EIO). Try again."],
      ["sweep", "The document store could not be cleaned up (EIO). Try again."],
    ] as const;
    for (const [operation, message] of cases) {
      const cause = eio();
      const error = new DocumentStoreError(cause, operation ? { operation } : undefined);
      expect(error).toMatchObject({ name: "DocumentStoreError", operation: operation ?? "read", status: 503, code: "EIO", syscall: "read", message });
      expect(error.cause).toBe(cause);
      expect(error.message).not.toContain("/srv");
    }
    // A store's error that is not a system error: no code in the message.
    expect(new DocumentStoreError(new Error("mongo-1.internal:27017 refused"), { operation: "write" }).message).toBe("The document could not be stored. Try again.");
  });

  it("shows a cause's code only when it reads as one, never a driver's text such as a host", () => {
    expect(new DocumentStoreError(Object.assign(new Error("x"), { code: "EIO", syscall: "read" })).message).toBe("The document store could not be read (EIO). Try again.");
    const hosted = new DocumentStoreError(Object.assign(new Error("x"), { code: "mongo-1.internal:27017" }), { operation: "write" });
    expect(hosted.message).toBe("The document could not be stored. Try again.");
    expect(hosted.message).not.toContain("mongo");
  });

  it("takes a code of its own, such as NEWER_VERSION", () => {
    const error = new DocumentStoreError(new RangeError("metaVersion 2"), { code: "NEWER_VERSION" });
    expect(error).toMatchObject({ operation: "read", status: 503, code: "NEWER_VERSION", message: "The document was stored by a newer version of llm-large-files. Try again." });
    expect(new DocumentStoreError(eio(), { operation: "write", code: "ETIMEDOUT" }).message).toBe("The document could not be stored (ETIMEDOUT). Try again.");
  });
});

describe("DocumentScopeError", () => {
  it("is a TypeError with a code, and a message of its own for each", () => {
    const required = new DocumentScopeError("scope_required");
    expect(required).toBeInstanceOf(TypeError);
    expect(required).toMatchObject({ name: "DocumentScopeError", code: "scope_required", message: "A scope is required: pass the scope of the document, such as [userId, chatId]." });
    expect(new DocumentScopeError("scope_invalid").message).toBe("The scope is not valid.");
    expect(new DocumentScopeError("scope_missing").message).toBe("The scope no longer exists.");
    expect(new DocumentScopeError("scope_missing", "This chat no longer exists.", { cause: eio() })).toMatchObject({ message: "This chat no longer exists.", code: "scope_missing" });
  });
});

describe("DocumentsNotFoundError and IngestError", () => {
  it("give a code and an HTTP status", () => {
    const missing = new DocumentsNotFoundError(["doc_1"]);
    expect(missing).toMatchObject({ code: "documents_missing", status: 404, ids: ["doc_1"], message: "A document is no longer available: doc_1. Upload it again." });
    expect(new IngestError("exists", "a.txt: a document with this ID already exists.")).toMatchObject({ code: "exists", status: 409 });
    expect(new IngestError("busy", "busy").status).toBe(503);
    expect(new IngestError("too_large", "large").status).toBe(413);
    expect(new IngestError("unreadable", "damaged").status).toBe(422);
  });

  it("keep their own words in events, though they have a status as model errors do", async () => {
    // A status made the event tell the error as a model's: "The model refused the request (HTTP 404)."
    expect(eventErrorOf(new DocumentsNotFoundError(["doc_1", "doc_2"]))).toEqual({
      message: "2 documents are no longer available: doc_1, doc_2. Upload them again.",
      status: 404,
      name: "DocumentsNotFoundError",
    });
    expect(eventErrorOf(new DocumentStoreError(eio()))).toEqual({ message: "The document store could not be read (EIO). Try again.", status: 503, name: "DocumentStoreError" });
    expect(eventErrorOf(new IngestError("exists", "a.txt: a document with this ID already exists."))).toEqual({
      message: "a.txt: a document with this ID already exists.",
      name: "IngestError",
      code: "exists",
      status: 409,
    });
    expect(eventErrorOf(new IngestError("unreadable", "a.txt could not be read."))).toEqual({ message: "a.txt could not be read.", name: "IngestError", code: "unreadable" });

    const events: AskEvent[] = [];
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const asking = askWithFiles({
      files,
      model: fakeModel([says("never")]),
      documentIds: ["doc_0123456789abcdef0123456789abcdef"],
      messages: [{ role: "user", text: "What does it say?" }],
      onEvent: (event) => events.push(event),
    });
    await expect(asking).rejects.toBeInstanceOf(DocumentsNotFoundError);
    const failed = events.find((event) => event.type === "run.error");
    expect(failed && "error" in failed ? failed.error.message : undefined).toBe("A document is no longer available: doc_0123456789abcdef0123456789abcdef. Upload it again.");
  });
});

describe("is()", () => {
  it("tells the package's errors apart, from this copy of the package or another one", async () => {
    const errors = await import("../src/errors.js");
    const model = await import("../src/model.js");
    vi.resetModules();
    const otherErrors = await import("../src/errors.js");
    const otherModel = await import("../src/model.js");
    expect(otherErrors.DocumentStoreError).not.toBe(errors.DocumentStoreError);
    expect(otherModel.ModelRequestError).not.toBe(model.ModelRequestError);

    const made = [
      [errors.DocumentStoreError, new otherErrors.DocumentStoreError(eio())],
      [errors.DocumentScopeError, new otherErrors.DocumentScopeError("scope_invalid")],
      [errors.IngestError, new otherErrors.IngestError("empty", "a.txt is empty.")],
      [model.DocumentsNotFoundError, new otherModel.DocumentsNotFoundError(["doc_1"])],
      [model.ModelRequestError, new otherModel.ModelRequestError("The model was busy.", 429)],
    ] as const;
    for (const [type, error] of made) {
      // `instanceof` fails across two copies: that is what `is` is for.
      expect(error instanceof type, type.name).toBe(false);
      expect(type.is(error), type.name).toBe(true);
      for (const [other] of made) if (other !== type) expect(other.is(error), `${other.name} of ${type.name}`).toBe(false);
    }
    // The classes exported by the package are the same as those of this copy.
    expect(DocumentStoreError.is(new errors.DocumentStoreError(eio()))).toBe(true);
    expect(ModelRequestError.is(new model.ModelRequestError("x", 500))).toBe(true);
  });

  it("is true for a kind of ModelRequestError, and false for what only looks like one", () => {
    class GatewayError extends ModelRequestError {}
    expect(ModelRequestError.is(new GatewayError("The gateway failed.", 502))).toBe(true);
    const lookalikes: unknown[] = [
      Object.assign(new Error("The document store could not be read (EIO). Try again."), { name: "DocumentStoreError", code: "EIO", status: 503 }),
      { name: "IngestError", code: "empty", status: 422 },
      new TypeError("scope"),
      null,
      undefined,
      "DocumentsNotFoundError",
      new Proxy({}, { get() { throw new Error("no"); } }),
    ];
    for (const value of lookalikes) {
      expect(DocumentStoreError.is(value)).toBe(false);
      expect(IngestError.is(value)).toBe(false);
      expect(DocumentScopeError.is(value)).toBe(false);
      expect(DocumentsNotFoundError.is(value)).toBe(false);
      expect(ModelRequestError.is(value)).toBe(false);
    }
  });
});
