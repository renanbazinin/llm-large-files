// NODE-1 (0.99.13): the JSON error bodies of the Node handlers carry the `code` and `category` of
// `errorInfoOf`, and `retryAfterMs` when they set Retry-After, next to `error` in the words it had.
// Before, the body was `{ error }` alone, in English: a page in Hebrew could not tell a legacy .doc
// from an empty file, while the event stream already carried the code.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, DocumentStoreError, errorInfoOf, MemoryDocumentStore, type LargeFiles } from "llm-large-files";
import { createDocumentHandlers, uploadAnswerOf, type DocumentHandlerOptions, type ErrorBody } from "llm-large-files/node";
import { utf8 } from "llm-large-files/testing";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** Serves the handlers at /api/documents (upload, get, delete, list). Its URL. */
async function serve(files: LargeFiles, options: DocumentHandlerOptions = {}): Promise<string> {
  const documents = createDocumentHandlers(files, options);
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.pathname.split("/")[3];
    if (request.method === "POST") return void documents.upload(request, response);
    if (request.method === "GET" && id === undefined) return void documents.list(request, response);
    if (request.method === "GET") return void documents.get(request, response, id!);
    return void documents.remove(request, response, id ?? "");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/documents`;
}

const upload = (base: string, name: string, body: Uint8Array | string, headers: Record<string, string> = {}) =>
  fetch(base, { method: "POST", headers: { "X-File-Name": encodeURIComponent(name), ...headers }, body });

/** What the library's own ingest throws for the same file: the error the body must agree with. */
async function thrownBy(files: LargeFiles, name: string, bytes: Uint8Array): Promise<unknown> {
  try {
    await files.ingest({ name, bytes });
  } catch (error) {
    return error;
  }
  throw new Error(`${name} was stored`);
}

const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array<number>(600).fill(0)]);

describe("the JSON error bodies of the Node handlers (NODE-1)", () => {
  it("gives each refused file its code and category, as errorInfoOf reads the same error, in the words of before", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), maxUploadBytes: 1_000 });
    const base = await serve(files);
    const cases: Array<{ name: string; bytes: Uint8Array; status: number; code: string; error: string | RegExp }> = [
      { name: "old.doc", bytes: OLE, status: 422, code: "legacy_office", error: /Word, Excel or PowerPoint file of before 2007/ },
      { name: "e.txt", bytes: new Uint8Array(), status: 422, code: "empty", error: "e.txt is empty." },
      { name: "x.pdf", bytes: utf8("%PDF-1.4 garbage"), status: 422, code: "unreadable", error: "This file could not be read. It may be damaged, or not of the type its name says." },
      // Refused by the handler from its Content-Length, before it is read: the same refusal as ingest's.
      { name: "big.txt", bytes: new Uint8Array(2_000).fill(65), status: 413, code: "too_large", error: "The file is larger than the 1000 B upload limit." },
    ];
    for (const one of cases) {
      const response = await upload(base, one.name, one.bytes);
      expect(response.status, one.name).toBe(one.status);
      expect(response.headers.get("retry-after"), one.name).toBeNull();
      const body = (await response.json()) as ErrorBody;
      expect(Object.keys(body), one.name).toEqual(["error", "code", "category"]);
      expect(body, one.name).toMatchObject({ code: one.code, category: "ingest", error: one.error });
      const info = errorInfoOf(await thrownBy(files, one.name, one.bytes));
      expect({ code: body.code, category: body.category }, one.name).toEqual({ code: info.code, category: info.category });
      // The event stream told the code before 0.99.13, and still does.
      if (one.status === 422) {
        const stream = await (await upload(base, one.name, one.bytes, { Accept: "text/event-stream" })).text();
        expect(stream, one.name).toContain(`"code":"${one.code}"`);
      }
    }
  });

  it("answers a store that fails on write 503, with retryAfterMs 5000 as Retry-After: 5 says", async () => {
    class DownStore extends MemoryDocumentStore {
      override async put(): Promise<void> {
        throw new DocumentStoreError(new Error("connect ECONNREFUSED mongo-prod.internal:27017"), { operation: "write" });
      }
    }
    const files = createLargeFiles({ requireOwner: false, store: new DownStore() });
    const base = await serve(files);
    const response = await upload(base, "a.txt", "hello");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const body = (await response.json()) as ErrorBody;
    expect(body).toEqual({ error: "The document could not be stored. Try again.", category: "store", retryAfterMs: 5000 });
    const info = errorInfoOf(await thrownBy(files, "a.txt", utf8("hello")));
    expect(info).toMatchObject({ category: body.category, retryAfterMs: body.retryAfterMs });
    expect(info.code).toBe(body.code);
    expect(JSON.stringify(body)).not.toContain("mongo-prod");
  });

  it("gives every other JSON error a category: the handlers' own refusals, a missing document, a hook's status", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const base = await serve(files, {
      getOwner: (request) => {
        if (request.headers["x-banned"]) throw Object.assign(new Error("This account is suspended."), { status: 403 });
        return typeof request.headers["x-user"] === "string" ? request.headers["x-user"] : undefined;
      },
    });
    const alice = { "X-User": "alice" };
    const answers: Array<[number, unknown]> = [];
    const answer = async (pending: Promise<Response>) => {
      const response = await pending;
      answers.push([response.status, await response.json()]);
    };
    await answer(upload(base, "a.txt", "notes"));
    await answer(fetch(base, { method: "POST", headers: alice, body: "notes" }));
    await answer(upload(base, "a.txt", "notes", { ...alice, "X-Banned": "1" }));
    await answer(fetch(`${base}/doc_0123456789abcdef0123456789abcdef`, { headers: alice }));
    await answer(fetch(base));
    expect(answers).toEqual([
      [401, { error: "Sign in first.", category: "unknown" }],
      [400, { error: "Name the file with an X-File-Name header or a ?name= query parameter.", category: "unknown" }],
      [403, { error: "This account is suspended.", category: "unknown" }],
      [404, { error: "This file is no longer available.", code: "documents_missing", category: "missing" }],
      [401, { error: "Sign in first.", category: "unknown" }],
    ]);
    // Never read as a model's error, which errorInfoOf makes of an error with a status alone.
    expect(errorInfoOf(Object.assign(new Error("This account is suspended."), { status: 403 })).category).toBe("model");
  });

  it("keeps uploadAnswerOf as it was: the status, the words, an IngestErrorCode and the wait", () => {
    expect(uploadAnswerOf(new DocumentStoreError(new Error("down"), { operation: "write" }))).toEqual({ status: 503, error: "The document could not be stored. Try again.", retryAfterMs: 5000 });
    expect(uploadAnswerOf(new Error("mongo-prod.internal"))).toEqual({ status: 500, error: "Upload failed." });
  });
});
