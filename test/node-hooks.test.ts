// The upload handlers of 0.9.0: getScope, onUploaded and onRemoved, requireOwner and requireScope,
// the answers to errors (S12, uploadAnswerOf) and the Content-Type taken as it came (S11).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DocumentScopeError,
  DocumentStoreError,
  FileDocumentStore,
  IngestError,
  MemoryDocumentStore,
  ModelRequestError,
  type DocumentMeta,
  type DocumentScope,
  type IngestErrorCode,
  type IngestInput,
  type LargeFiles,
} from "llm-large-files";
import { createDocumentHandlers, uploadAnswerOf, type DocumentHandlerOptions, type UploadedContext } from "llm-large-files/node";
import { fakeModel, says, serviceLog } from "./fake-model.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
  server = undefined;
}));

/** Serves the three handlers at /api/documents and /api/documents/:id. The upload URL. */
async function serve(files: LargeFiles, options: DocumentHandlerOptions = {}): Promise<string> {
  const documents = createDocumentHandlers(files, options);
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = /^\/api\/documents\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === "POST" && url.pathname === "/api/documents") return void documents.upload(request, response);
    if (id !== undefined && request.method === "GET") return void documents.get(request, response, id);
    if (id !== undefined && request.method === "DELETE") return void documents.remove(request, response, id);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/documents`;
}

/** The user of a request: its X-User header. */
const userOf = (request: IncomingMessage) => (typeof request.headers["x-user"] === "string" ? request.headers["x-user"] : undefined);
/** The scope of a request: [user, chat], from X-User and X-Chat. */
const scopeOf = (request: IncomingMessage): DocumentScope | undefined => {
  const chat = request.headers["x-chat"];
  return typeof chat === "string" ? [userOf(request) ?? "anonymous", chat] : undefined;
};
const asUser = (user: string, chat?: string): Record<string, string> => ({ "X-User": user, ...(chat ? { "X-Chat": chat } : {}) });

const upload = (base: string, headers: Record<string, string>, body = "The meeting is on Tuesday.", events = false) =>
  fetch(base, { method: "POST", headers: { "X-File-Name": "notes.txt", ...headers, ...(events ? { Accept: "text/event-stream" } : {}) }, body });

type Message = { id?: string; event?: string; data?: Record<string, unknown> };
/** The messages of an event stream. */
function parse(body: string): Message[] {
  const messages: Message[] = [];
  for (const block of body.split("\n\n")) {
    const message: Message = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) message.id = line.slice(4);
      else if (line.startsWith("event: ")) message.event = line.slice(7);
      else if (line.startsWith("data: ")) message.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
    }
    if (Object.keys(message).length) messages.push(message);
  }
  return messages;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const aborted = (signal: AbortSignal | undefined) => new Promise<void>((resolve) => {
  if (!signal || signal.aborted) return resolve();
  signal.addEventListener("abort", () => resolve(), { once: true });
});

describe("onUploaded", () => {
  it("runs once the document is stored, before the 201, and its answer joins the 201", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const seen: Array<{ document: DocumentMeta; context: UploadedContext; stored: boolean }> = [];
    let entered!: () => void;
    const inHook = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const base = await serve(files, {
      getOwner: userOf,
      getScope: scopeOf,
      onUploaded: async (document, context) => {
        seen.push({ document, context, stored: (await files.getMeta(document.id, { owner: "alice", scope: ["alice", "c1"] })) !== undefined });
        entered();
        await released;
        // `id` and `name` are the summary's: the hook cannot change them.
        return { answer: { chatFileId: "f-1", id: "not-this", name: "not-this" } };
      },
    });
    let settled = false;
    const answered = upload(base, asUser("alice", "c1")).finally(() => (settled = true));
    await inHook;
    await pause(50);
    expect(settled).toBe(false);
    release();
    const response = await answered;
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(seen).toHaveLength(1);
    const [{ document, context, stored }] = seen as [(typeof seen)[0]];
    expect(stored).toBe(true);
    expect(body).toMatchObject({ chatFileId: "f-1", id: document.id, name: "notes.txt", format: "text" });
    expect(body).not.toHaveProperty("owner");
    expect(body).not.toHaveProperty("scope");
    // The whole metadata, with the owner and the scope.
    expect(document).toMatchObject({ owner: "alice", scope: ["alice", "c1"], name: "notes.txt" });
    expect(context).toMatchObject({ owner: "alice", scope: ["alice", "c1"], clientGone: false });
    expect(context.request.headers["x-file-name"]).toBe("notes.txt");
    // The body's bytes are not in the context.
    expect(Object.keys(context).sort()).toEqual(["clientGone", "owner", "request", "scope"]);
    expect(Object.values(context).some((value) => value instanceof Uint8Array)).toBe(false);
  });

  it("runs before ingest.finish on the event stream, and its answer is ingest.finish.app", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const called: string[] = [];
    let answer: Record<string, unknown> | undefined = { chatFileId: "f-2" };
    const base = await serve(files, {
      getOwner: userOf,
      onUploaded: (document) => {
        called.push(document.id);
        return answer === undefined ? undefined : { answer };
      },
    });
    const messages = parse(await (await upload(base, asUser("alice"), "x\n".repeat(2_000), true)).text());
    const last = messages.at(-1)!;
    expect(last.event).toBe("ingest.finish");
    expect(called).toHaveLength(1);
    expect(last.data).toMatchObject({ type: "ingest.finish", seq: messages.length, document: { id: called[0], name: "notes.txt" }, app: { chatFileId: "f-2" } });
    expect(last.data!.document).not.toHaveProperty("chatFileId");
    // A hook that returns nothing adds no `app`.
    answer = undefined;
    const plain = parse(await (await upload(base, asUser("alice"), "notes", true)).text()).at(-1)!;
    expect(plain.event).toBe("ingest.finish");
    expect(plain.data).not.toHaveProperty("app");
    expect(called).toHaveLength(2);
  });

  it("deletes the document when it throws, and answers with the error's status and message", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const stored: string[] = [];
    let thrown: unknown = Object.assign(new Error("This chat has too many files."), { status: 409 });
    const base = await serve(files, {
      getOwner: userOf,
      onUploaded: (document) => {
        stored.push(document.id);
        throw thrown;
      },
    });
    const refused = await upload(base, asUser("alice"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "This chat has too many files." });
    expect(await files.getMeta(stored[0]!, { owner: "alice" })).toBeUndefined();

    const streamed = parse(await (await upload(base, asUser("alice"), "notes", true)).text());
    expect(streamed.map((message) => message.event)).not.toContain("ingest.finish");
    expect(streamed.at(-1)).toMatchObject({ event: "ingest.error", data: { type: "ingest.error", error: { message: "This chat has too many files.", status: 409 } } });
    expect(await files.getMeta(stored[1]!, { owner: "alice" })).toBeUndefined();

    // An error without a status is a 500 that does not repeat its message.
    thrown = new Error("MongoServerSelectionError: connect ECONNREFUSED mongo-prod.internal.corp:27017");
    const failed = await upload(base, asUser("alice"));
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe(JSON.stringify({ error: "Upload failed." }));
    expect(await files.getMeta(stored[2]!, { owner: "alice" })).toBeUndefined();
    const failedEvents = await (await upload(base, asUser("alice"), "notes", true)).text();
    expect(failedEvents).not.toContain("mongo-prod");
    expect(parse(failedEvents).at(-1)).toMatchObject({ event: "ingest.error", data: { error: { message: "Upload failed.", status: 500 } } });
    expect(stored).toHaveLength(4);
  });

  it("answers the hook's error even when the delete after it throws at once", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const own: LargeFiles = {
      ...files,
      delete: () => {
        throw new Error("The delete of your own failed at mongo-prod.internal.corp:27017.");
      },
    };
    const base = await serve(own, {
      onUploaded: () => {
        throw Object.assign(new Error("This chat has too many files."), { status: 409 });
      },
    });
    const response = await upload(base, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This chat has too many files." });
  });

  it("fails the upload, and deletes the document, for an answer that is not a plain object JSON can hold", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const stored: string[] = [];
    const answers: unknown[] = [["a"], "text", new Date(), { big: 1n }];
    const base = await serve(files, {
      onUploaded: (document) => {
        stored.push(document.id);
        return { answer: answers[stored.length - 1] } as { answer: Record<string, unknown> };
      },
    });
    for (const _ of answers) {
      const response = await upload(base, {});
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Upload failed." });
    }
    for (const id of stored) expect(await files.getMeta(id)).toBeUndefined();
    // What a database returns, without an `answer`, adds nothing and fails nothing.
    const base2 = await serve(files, { onUploaded: () => ({ acknowledged: true, insertedId: "x" }) as never });
    expect(Object.keys((await (await upload(base2, {})).json()) as object)).not.toContain("acknowledged");
  });

  // A client that left after its file was stored: the document is there, and the app must know.
  async function leaveOnceStored(events: boolean): Promise<{ context: UploadedContext; files: LargeFiles; id: string }> {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    let isStored!: () => void;
    const storedNow = new Promise<void>((resolve) => (isStored = resolve));
    // An ingest that stores the file, then answers only once the client is gone.
    const own: LargeFiles = {
      ...files,
      async ingest(input) {
        const meta = await files.ingest({ ...input, signal: undefined });
        isStored();
        await aborted(input.signal);
        return meta;
      },
    };
    const contexts: Array<{ context: UploadedContext; id: string }> = [];
    const base = await serve(own, { onUploaded: (document, context) => void contexts.push({ context, id: document.id }) });
    const url = new URL(base);
    const client = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-File-Name": "notes.txt", ...(events ? { Accept: "text/event-stream" } : {}) } });
    client.on("error", () => undefined);
    client.end("The meeting is on Tuesday.");
    await storedNow;
    client.destroy();
    await expect.poll(() => contexts.length).toBe(1);
    await pause(20);
    // Once.
    expect(contexts).toHaveLength(1);
    return { ...contexts[0]!, files };
  }

  it("still runs when the client left, with clientGone, and the document stays", async () => {
    const { context, files, id } = await leaveOnceStored(false);
    expect(context.clientGone).toBe(true);
    expect(await files.getMeta(id)).toMatchObject({ id, name: "notes.txt" });
  });

  it("still runs when the client of an event stream left, with clientGone, once", async () => {
    const { context, files, id } = await leaveOnceStored(true);
    expect(context.clientGone).toBe(true);
    expect(await files.getMeta(id)).toMatchObject({ id, name: "notes.txt" });
  });

  it("is not called for an upload that failed", async () => {
    const onUploaded = vi.fn();
    const base = await serve(createLargeFiles({ store: new MemoryDocumentStore() }), { onUploaded });
    expect((await upload(base, {}, "   \n")).status).toBe(422);
    expect((await upload(base, {}, "   \n", true)).status).toBe(200);
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe("onRemoved", () => {
  it("runs after a delete that removed the document, with the owner and the scope", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const removed: Array<{ id: string; owner?: string; scope?: DocumentScope; gone: boolean }> = [];
    const base = await serve(files, {
      getOwner: userOf,
      getScope: scopeOf,
      onRemoved: async (id, context) => {
        removed.push({ id, owner: context.owner, scope: context.scope, gone: (await files.getMeta(id, context)) === undefined });
      },
    });
    const { id } = (await (await upload(base, asUser("alice", "c1"))).json()) as { id: string };
    const remove = (headers: Record<string, string>) => fetch(`${base}/${id}`, { method: "DELETE", headers }).then((response) => response.json());
    expect(await remove(asUser("bob", "c1"))).toEqual({ deleted: false });
    expect(await remove(asUser("alice", "c2"))).toEqual({ deleted: false });
    expect(removed).toEqual([]);
    expect(await remove(asUser("alice", "c1"))).toEqual({ deleted: true });
    expect(removed).toEqual([{ id, owner: "alice", scope: ["alice", "c1"], gone: true }]);
    expect(await remove(asUser("alice", "c1"))).toEqual({ deleted: false });
    expect(removed).toHaveLength(1);
  });

  it("answers what it throws, the document deleted all the same", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const base = await serve(files, {
      onRemoved: () => {
        throw Object.assign(new Error("The chat record could not be updated."), { status: 502 });
      },
    });
    const { id } = (await (await upload(base, {})).json()) as { id: string };
    const response = await fetch(`${base}/${id}`, { method: "DELETE" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "The chat record could not be updated." });
    expect(await files.getMeta(id)).toBeUndefined();
  });
});

describe("requireOwner and requireScope in the handlers", () => {
  it("cannot be made without getOwner or getScope when the library requires them", () => {
    const store = new MemoryDocumentStore();
    const owned = createLargeFiles({ store, requireOwner: true });
    expect(() => createDocumentHandlers(owned)).toThrow(TypeError);
    expect(() => createDocumentHandlers(owned, { getScope: scopeOf })).toThrow("createDocumentHandlers needs getOwner: the library requires an owner on every call (requireOwner).");
    expect(() => createDocumentHandlers(owned, { getOwner: userOf })).not.toThrow();
    const scoped = createLargeFiles({ store, requireScope: true });
    expect(() => createDocumentHandlers(scoped, { getOwner: userOf })).toThrow("createDocumentHandlers needs getScope: the library requires a scope on every call (requireScope).");
    expect(() => createDocumentHandlers(scoped, { getScope: scopeOf })).not.toThrow();
    // Without the rules (a LargeFiles of your own without `access`), both stay optional.
    const { access: _access, ...own } = owned;
    expect(() => createDocumentHandlers(own)).not.toThrow();
    // A hook that is not a function is refused at once.
    expect(() => createDocumentHandlers(createLargeFiles({ store }), { onUploaded: "record" as never })).toThrow("onUploaded must be a function, and is string.");
  });

  it("answers an upload without an owner 401 before its body is read", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: true });
    const ingest = vi.fn((input: IngestInput) => files.ingest(input));
    const base = await serve({ ...files, ingest }, { getOwner: userOf });
    const url = new URL(base);
    // The body is never finished: the answer comes all the same.
    const answer = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const client = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-File-Name": "notes.txt", "Transfer-Encoding": "chunked" } });
      client.on("response", (response) => {
        response.setEncoding("utf8");
        response.once("data", (body: string) => {
          resolve({ status: response.statusCode, body });
          client.destroy();
        });
      });
      client.on("error", (error) => (client.destroyed ? undefined : reject(error)));
      client.write("The first piece of a body that never ends.");
    });
    expect(answer).toEqual({ status: 401, body: JSON.stringify({ error: "Sign in first." }) });
    expect(ingest).not.toHaveBeenCalled();
    for (const method of ["GET", "DELETE"]) {
      const refused = await fetch(`${base}/doc_0123456789abcdef0123456789abcdef`, { method });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "Sign in first." });
    }
    expect((await upload(base, asUser("alice"))).status).toBe(201);
  });
});

describe("getScope", () => {
  it("scopes the upload, and is passed to getMeta and delete", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const calls: Array<[string, unknown]> = [];
    const own: LargeFiles = {
      ...files,
      ingest: (input) => {
        calls.push(["ingest", { owner: input.owner, scope: input.scope }]);
        return files.ingest(input);
      },
      getMeta: (id, access) => {
        calls.push(["getMeta", access]);
        return files.getMeta(id, access);
      },
      delete: (id, access) => {
        calls.push(["delete", access]);
        return files.delete(id, access);
      },
    };
    const base = await serve(own, { getOwner: userOf, getScope: scopeOf });
    const { id } = (await (await upload(base, asUser("alice", "c1"))).json()) as { id: string };
    expect(await files.getMeta(id, { owner: "alice", scope: ["alice", "c1"] })).toMatchObject({ scope: ["alice", "c1"] });
    expect((await fetch(`${base}/${id}`, { headers: asUser("alice", "c2") })).status).toBe(404);
    expect((await fetch(`${base}/${id}`, { headers: asUser("alice") })).status).toBe(404);
    expect((await fetch(`${base}/${id}`, { headers: asUser("alice", "c1") })).status).toBe(200);
    expect(await (await fetch(`${base}/${id}`, { method: "DELETE", headers: asUser("alice", "c2") })).json()).toEqual({ deleted: false });
    expect(await (await fetch(`${base}/${id}`, { method: "DELETE", headers: asUser("alice", "c1") })).json()).toEqual({ deleted: true });
    expect(calls).toEqual([
      ["ingest", { owner: "alice", scope: ["alice", "c1"] }],
      ["getMeta", { owner: "alice", scope: ["alice", "c2"] }],
      ["getMeta", { owner: "alice" }],
      ["getMeta", { owner: "alice", scope: ["alice", "c1"] }],
      ["delete", { owner: "alice", scope: ["alice", "c2"] }],
      ["delete", { owner: "alice", scope: ["alice", "c1"] }],
    ]);
  });

  it("answers a scope that is not valid, or none under requireScope, with a 500 before the body is read", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), requireScope: true });
    const ingest = vi.fn((input: IngestInput) => files.ingest(input));
    let scope: unknown = ["alice", "a/b"];
    const base = await serve({ ...files, ingest }, { getScope: () => scope as DocumentScope });
    const invalid = await upload(base, {});
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toEqual({ error: "Upload failed (invalid scope)." });
    expect(await (await fetch(`${base}/doc_0123456789abcdef0123456789abcdef`)).json()).toEqual({ error: "The file could not be looked up (invalid scope)." });
    expect(await (await fetch(`${base}/doc_0123456789abcdef0123456789abcdef`, { method: "DELETE" })).json()).toEqual({ error: "The file could not be deleted (invalid scope)." });
    scope = undefined;
    const none = await upload(base, {});
    expect(none.status).toBe(500);
    expect(await none.json()).toEqual({ error: "Upload failed (no scope)." });
    scope = ["alice", "c1"];
    expect((await upload(base, {})).status).toBe(201);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("answers an upload into a chat whose folder is gone 404 'This chat no longer exists.'", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llf-hooks-"));
    try {
      const files = createLargeFiles({ store: new FileDocumentStore(root, { scopes: { depth: 2 } }) });
      const base = await serve(files, { getOwner: userOf, getScope: scopeOf });
      const gone = await upload(base, asUser("alice", "c1"));
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({ error: "This chat no longer exists." });
      expect(parse(await (await upload(base, asUser("alice", "c1"), "notes", true)).text()).at(-1)).toMatchObject({
        event: "ingest.error",
        data: { error: { message: "This chat no longer exists.", status: 404 } },
      });
      await mkdir(path.join(root, "alice", "c1"), { recursive: true });
      expect((await upload(base, asUser("alice", "c1"))).status).toBe(201);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("errors as the upload answers them (S12)", () => {
  it("answers a plain Error of a LargeFiles of your own 500 'Upload failed.', without its host", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const failing: LargeFiles = {
      ...files,
      ingest: async () => {
        throw new Error("MongoServerSelectionError: connect ECONNREFUSED mongo-prod.internal.corp:27017");
      },
    };
    const base = await serve(failing);
    const response = await upload(base, {});
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ error: "Upload failed." }));
    const events = await (await upload(base, {}, "notes", true)).text();
    expect(events).not.toContain("mongo-prod");
    expect(parse(events).at(-1)).toMatchObject({ event: "ingest.error", data: { error: { message: "Upload failed.", status: 500 } } });
  });

  it("answers a store that failed 503 with Retry-After: 5, on every route", async () => {
    class DownStore extends MemoryDocumentStore {
      override async put(): Promise<void> {
        throw new Error("MongoServerSelectionError: connect ECONNREFUSED mongo-prod.internal.corp:27017");
      }
      override async getMeta(): Promise<undefined> {
        throw new Error("MongoServerSelectionError: connect ECONNREFUSED mongo-prod.internal.corp:27017");
      }
    }
    const base = await serve(createLargeFiles({ store: new DownStore() }));
    const answers = [
      await upload(base, {}),
      await fetch(`${base}/doc_0123456789abcdef0123456789abcdef`),
      await fetch(`${base}/doc_0123456789abcdef0123456789abcdef`, { method: "DELETE" }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(503);
      expect(answer.headers.get("retry-after")).toBe("5");
      expect(await answer.text()).not.toContain("mongo");
    }
  });

  it("answers an IngestError 422 with its message, from any copy of the package", async () => {
    vi.resetModules();
    const other = await import("../src/errors.js");
    expect(other.IngestError).not.toBe(IngestError);
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    let thrown: unknown = new IngestError("unreadable", "report.docx could not be read.");
    const base = await serve({ ...files, ingest: async () => { throw thrown; } });
    const answer = async () => {
      const response = await upload(base, {});
      return { status: response.status, body: await response.json() };
    };
    expect(await answer()).toEqual({ status: 422, body: { error: "report.docx could not be read." } });
    thrown = new other.IngestError("no_text", "scan.pdf has no text layer.");
    expect(await answer()).toEqual({ status: 422, body: { error: "scan.pdf has no text layer." } });
  });

  it("uploadAnswerOf: each IngestErrorCode gets its status and code", () => {
    const statuses = {
      empty: 422,
      too_large: 413,
      too_much_text: 422,
      too_many_pages: 422,
      not_text: 422,
      compressed: 422,
      legacy_office: 422,
      encrypted: 422,
      no_text: 422,
      hostile: 422,
      timeout: 422,
      out_of_memory: 422,
      busy: 503,
      missing_dependency: 422,
      unreadable: 422,
      exists: 409,
    } satisfies Record<IngestErrorCode, number>;
    for (const [code, status] of Object.entries(statuses) as Array<[IngestErrorCode, number]>) {
      expect(uploadAnswerOf(new IngestError(code, `a.txt: ${code}.`)), code).toEqual({ status, error: `a.txt: ${code}.`, code });
    }
    expect(uploadAnswerOf(new IngestError("busy", "Busy.", { retryAfterMs: 5_000 }))).toEqual({ status: 503, error: "Busy.", code: "busy", retryAfterMs: 5_000 });
  });

  it("uploadAnswerOf: the library's other errors, errors with a status, and everything else", () => {
    const host = "mongo-prod.internal.corp:27017";
    const cases: Array<[unknown, ReturnType<typeof uploadAnswerOf>]> = [
      [new DocumentStoreError(new Error(host), { operation: "write" }), { status: 503, error: "The document could not be stored. Try again.", retryAfterMs: 5_000 }],
      [new DocumentStoreError(Object.assign(new Error(`EIO ${host}`), { code: "EIO", syscall: "write" }), { operation: "write" }), { status: 503, error: "The document could not be stored (EIO). Try again.", retryAfterMs: 5_000 }],
      [new DocumentScopeError("scope_missing"), { status: 404, error: "This chat no longer exists." }],
      // A scope the server gave wrong is its own bug: not the client's 4xx.
      [new DocumentScopeError("scope_invalid"), { status: 500, error: "Upload failed." }],
      [new DocumentScopeError("scope_required"), { status: 500, error: "Upload failed." }],
      [Object.assign(new Error("Sign in again."), { status: 401 }), { status: 401, error: "Sign in again." }],
      [Object.assign(new Error("Later."), { statusCode: 503, retryAfterMs: 2_500 }), { status: 503, error: "Later.", retryAfterMs: 2_500 }],
      [Object.assign(new Error(""), { status: 400 }), { status: 400, error: "Upload failed." }],
      [Object.assign(new Error(`ENOSPC: no space left, write '/srv/uploads/a'`), { code: "ENOSPC", syscall: "write" }), { status: 500, error: "Upload failed (ENOSPC)." }],
      [new Error(`MongoServerSelectionError: connect ECONNREFUSED ${host}`), { status: 500, error: "Upload failed." }],
      [new TypeError("owner must be a string"), { status: 500, error: "Upload failed." }],
      [Object.assign(new Error("Not a status."), { status: 200 }), { status: 500, error: "Upload failed." }],
      ["a string", { status: 500, error: "Upload failed." }],
      [undefined, { status: 500, error: "Upload failed." }],
      [new Proxy({}, { get() { throw new Error("no"); }, getPrototypeOf() { throw new Error("no"); } }), { status: 500, error: "Upload failed." }],
      // A model's error: never the provider's words, nor its status (a 401 is the server's key, not the user's sign-in).
      [new ModelRequestError("API key not valid for project acme-prod-7.", 401), { status: 500, error: "The model refused the key or token it was sent (HTTP 401)." }],
      [new ModelRequestError("Quota exceeded for acme-prod-7.", 429, { retryAfterMs: 30_000 }), { status: 429, error: "The model was busy (HTTP 429).", retryAfterMs: 30_000 }],
    ];
    for (const [index, [error, answer]] of cases.entries()) {
      expect(uploadAnswerOf(error), `case ${index}`).toEqual(answer);
    }
  });
});

describe("the MIME type of an upload (S11)", () => {
  it("takes Content-Type as it came, and decodes only X-File-Type", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const types: Array<string | undefined> = [];
    const base = await serve({
      ...files,
      ingest: (input) => {
        types.push(input.mimeType);
        return files.ingest(input);
      },
    });
    // A Content-Type cannot hold a line break; decoded, this one would.
    await upload(base, { "Content-Type": "text/plain%0D%0AX-Injected:%201" });
    await upload(base, { "Content-Type": "text/markdown; charset=utf-8" });
    await upload(base, { "Content-Type": "text/plain", "X-File-Type": "text%2Fmarkdown" });
    expect(types).toEqual(["text/plain%0D%0AX-Injected:%201", "text/markdown; charset=utf-8", "text/markdown"]);
  });
});

describe("what reaches the model", () => {
  it("never holds the owner, the scope, the MIME type or the hook's answer of an upload", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 2_000 } });
    const base = await serve(files, {
      getOwner: () => "owner-7f3a",
      getScope: () => ["owner-7f3a", "chat-91c2"],
      onUploaded: () => ({ answer: { secret: "answer-5d1e" } }),
    });
    const small = (await (await upload(base, { "X-File-Type": "text%2Fx-private-type" }, "The meeting is on Tuesday.")).json()) as { id: string; secret: string };
    const large = (await (await upload(base, { "Content-Type": "text/x-other-private-type" }, serviceLog(2_000), true)).text());
    const largeId = (parse(large).at(-1)!.data as { document: { id: string } }).document.id;
    expect(small.secret).toBe("answer-5d1e");
    const model = fakeModel([says("On Tuesday.")]);
    const result = await askWithFiles({
      files,
      model,
      documentIds: [small.id, largeId],
      owner: "owner-7f3a",
      scope: ["owner-7f3a", "chat-91c2"],
      messages: [{ role: "user", text: "When is the meeting?" }],
    });
    expect(result.plan.inline.map((document) => document.id)).toEqual([small.id]);
    expect(result.plan.searchable.map((document) => document.id)).toEqual([largeId]);
    const sent = JSON.stringify(model.requests);
    expect(sent).toContain("The meeting is on Tuesday.");
    for (const secret of ["owner-7f3a", "chat-91c2", "x-private-type", "x-other-private-type", "answer-5d1e"]) expect(sent).not.toContain(secret);
  });
});
