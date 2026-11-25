// The list route of the upload handlers (0.99.9): `handlers.list` answers GET with the documents of
// exactly the request's owner and scope, as summaries, the oldest first. It reads nothing from the
// request but what getOwner and getScope read, and refuses a request with neither an owner nor a
// scope, whose list would hand out the IDs of documents without an owner.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLargeFiles,
  DocumentScopeError,
  MemoryDocumentStore,
  toDocumentSummary,
  type DocumentContext,
  type DocumentScope,
  type DocumentStore,
  type LargeFiles,
} from "llm-large-files";
import { createDocumentHandlers, type DocumentHandlerOptions } from "llm-large-files/node";
import { utf8 } from "./fake-model.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
  server = undefined;
}));

/** Serves the handlers at /api/documents (GET lists, POST uploads) and /api/documents/:id. The URL of the list. */
async function serve(files: LargeFiles, options: DocumentHandlerOptions = {}): Promise<string> {
  const documents = createDocumentHandlers(files, options);
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = /^\/api\/documents\/([^/]+)$/.exec(url.pathname)?.[1];
    if (url.pathname === "/api/documents" && request.method === "GET") return void documents.list(request, response);
    if (url.pathname === "/api/documents" && request.method === "POST") return void documents.upload(request, response);
    if (id !== undefined && request.method === "GET") return void documents.get(request, response, id);
    if (id !== undefined && request.method === "DELETE") return void documents.remove(request, response, id);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/documents`;
}

/** The user of a request: its X-User header. */
const userOf = (request: IncomingMessage) => (typeof request.headers["x-user"] === "string" ? request.headers["x-user"] : undefined);
/** The scope of a request: [chat], from X-Chat. */
const chatOf = (request: IncomingMessage): DocumentScope | undefined => {
  const chat = request.headers["x-chat"];
  return typeof chat === "string" ? [chat] : undefined;
};
const as = (user?: string, chat?: string): Record<string, string> => ({ ...(user ? { "X-User": user } : {}), ...(chat ? { "X-Chat": chat } : {}) });
const list = (base: string, headers: Record<string, string> = {}, query = "") => fetch(`${base}${query}`, { headers });

/** A clock the test moves, so that each document has a `createdAt` of its own. */
const clock = (start = Date.parse("2026-11-25T08:00:00Z")) => {
  let at = start;
  return { now: () => new Date(at), advance: (ms: number) => (at += ms) };
};

/** A store over a memory store whose `list` is `listed` (by default the memory store's). */
function storeWith(listed: (context?: DocumentContext) => Promise<never>): DocumentStore {
  const memory = new MemoryDocumentStore();
  return { put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c), list: listed };
}

describe("handlers.list", () => {
  it("lists the request's documents of its scope, the oldest first, as summaries", async () => {
    const time = clock();
    const store = new MemoryDocumentStore({ now: time.now });
    const files = createLargeFiles({ store, now: time.now });
    // Stored newest first: the list is still the oldest first.
    time.advance(60_000);
    const a2 = await files.ingest({ name: "b.txt", bytes: utf8("second\n"), owner: "alice", scope: ["chat-1"] });
    time.advance(-30_000);
    const a1 = await files.ingest({ name: "a.txt", bytes: utf8("first\n"), owner: "alice", scope: ["chat-1"], appData: { rowId: "7" } });
    await files.ingest({ name: "bob.txt", bytes: utf8("bob's\n"), owner: "bob", scope: ["chat-1"] });
    await files.ingest({ name: "other-chat.txt", bytes: utf8("another chat\n"), owner: "alice", scope: ["chat-2"] });
    await files.ingest({ name: "no-chat.txt", bytes: utf8("no chat\n"), owner: "alice" });
    const base = await serve(files, { getOwner: userOf, getScope: chatOf });

    const response = await list(base, as("alice", "chat-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ documents: [toDocumentSummary(a1), toDocumentSummary(a2)] });
    // A summary: no owner, scope, application data, hash or original.
    for (const key of ['"owner"', '"scope"', '"appData"', '"sha256"', '"original"', "rowId"]) expect(raw).not.toContain(key);
    // Each chat, and each user, sees only its own.
    expect(await (await list(base, as("alice", "chat-2"))).json()).toEqual({ documents: [expect.objectContaining({ name: "other-chat.txt" })] });
    expect(await (await list(base, as("alice"))).json()).toEqual({ documents: [expect.objectContaining({ name: "no-chat.txt" })] });
    expect(await (await list(base, as("bob", "chat-1"))).json()).toEqual({ documents: [expect.objectContaining({ name: "bob.txt" })] });
    expect(await (await list(base, as("carol", "chat-1"))).json()).toEqual({ documents: [] });
  });

  it("reads nothing from the request but what getOwner and getScope read", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    await files.ingest({ name: "a.txt", bytes: utf8("alice's\n"), owner: "alice", scope: ["chat-1"] });
    await files.ingest({ name: "b.txt", bytes: utf8("bob's\n"), owner: "bob", scope: ["x"] });
    const base = await serve(files, { getOwner: userOf, getScope: chatOf });
    const plain = await (await list(base, as("alice", "chat-1"))).json();
    expect(await (await list(base, { ...as("alice", "chat-1"), "X-Owner": "bob", "X-Scope": "x" }, "?owner=bob&scope=x&chat=x")).json()).toEqual(plain);
    expect(plain).toEqual({ documents: [expect.objectContaining({ name: "a.txt" })] });
  });

  it("answers 401 without an owner under the default, and without an owner and a scope under requireOwner: false, before files.list", async () => {
    const owned = createLargeFiles({ store: new MemoryDocumentStore() });
    const listOwned = vi.fn(owned.list);
    const base = await serve({ ...owned, list: listOwned }, { getOwner: userOf, getScope: chatOf });
    for (const headers of [as(), as(undefined, "chat-1")]) {
      const response = await list(base, headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Sign in first." });
    }
    expect(listOwned).not.toHaveBeenCalled();
    server!.closeAllConnections();
    server!.close();

    const open = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
    await open.ingest({ name: "anyone.txt", bytes: utf8("anyone's\n") });
    const listOpen = vi.fn(open.list);
    const anonymous = await serve({ ...open, list: listOpen }, { getScope: chatOf });
    const response = await list(anonymous);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in first." });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it("lists the documents without an owner of the request's scope under requireOwner: false, and never to a request with an owner", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
    await files.ingest({ name: "shared.txt", bytes: utf8("the chat's\n"), scope: ["chat-1"] });
    await files.ingest({ name: "mine.txt", bytes: utf8("alice's\n"), owner: "alice", scope: ["chat-1"] });
    await files.ingest({ name: "elsewhere.txt", bytes: utf8("another chat's\n"), scope: ["chat-2"] });
    const base = await serve(files, { getOwner: userOf, getScope: chatOf });
    expect(await (await list(base, as(undefined, "chat-1"))).json()).toEqual({ documents: [expect.objectContaining({ name: "shared.txt" })] });
    expect(await (await list(base, as("alice", "chat-1"))).json()).toEqual({ documents: [expect.objectContaining({ name: "mine.txt" })] });
  });

  it("answers an empty owner, an owner that is not a string, an invalid scope, and no scope under requireScope with a 500 that says which", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const listed = vi.fn(files.list);
    const answers: unknown[] = [];
    const cases: Array<[LargeFiles, DocumentHandlerOptions]> = [
      [files, { getOwner: () => "" }],
      [files, { getOwner: () => "   " }],
      [files, { getOwner: () => ({ id: "alice" }) as never }],
      [files, { getOwner: () => "alice", getScope: () => ["chat/1"] }],
      [createLargeFiles({ store: new MemoryDocumentStore(), requireScope: true }), { getOwner: () => "alice", getScope: () => undefined }],
    ];
    for (const [library, options] of cases) {
      const base = await serve({ ...library, list: listed }, options);
      const response = await list(base);
      answers.push([response.status, await response.json()]);
      server!.closeAllConnections();
      server!.close();
      server = undefined;
    }
    expect(answers).toEqual([
      [500, { error: "The files could not be listed (empty owner)." }],
      [500, { error: "The files could not be listed (empty owner)." }],
      [500, { error: "The files could not be listed (owner is not a string)." }],
      [500, { error: "The files could not be listed (invalid scope)." }],
      [500, { error: "The files could not be listed (no scope)." }],
    ]);
    expect(listed).not.toHaveBeenCalled();
  });

  it("answers 500 'The files could not be listed.' over a store without list, and for a LargeFiles of your own without list", async () => {
    const memory = new MemoryDocumentStore();
    const bare: DocumentStore = { put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c) };
    const base = await serve(createLargeFiles({ store: bare }), { getOwner: userOf });
    const response = await list(base, as("alice"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The files could not be listed." });
    server!.closeAllConnections();
    server!.close();

    const { list: _list, ...own } = createLargeFiles({ store: new MemoryDocumentStore() });
    const ours = await serve(own, { getOwner: userOf });
    const answered = await list(ours, as("alice"));
    expect(answered.status).toBe(500);
    expect(await answered.json()).toEqual({ error: "The files could not be listed." });
  });

  it("answers 503 with Retry-After: 5 when the store cannot be read, and 404 for a scope the store says is gone", async () => {
    const down = storeWith(async () => {
      throw Object.assign(new Error("EIO: i/o error, scandir '/srv/volume/alice'"), { code: "EIO", syscall: "scandir" });
    });
    const base = await serve(createLargeFiles({ store: down }), { getOwner: userOf, getScope: chatOf });
    const response = await list(base, as("alice", "chat-1"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const { error } = (await response.json()) as { error: string };
    expect(error).toMatch(/^The document store could not be read/);
    expect(error).not.toContain("/srv/volume");
    server!.closeAllConnections();
    server!.close();

    const gone = storeWith(async () => {
      throw new DocumentScopeError("scope_missing");
    });
    const chats = await serve(createLargeFiles({ store: gone }), { getOwner: userOf, getScope: chatOf });
    const answered = await list(chats, as("alice", "chat-1"));
    expect(answered.status).toBe(404);
    expect(await answered.json()).toEqual({ error: "This chat no longer exists." });
  });

  it("answers what getOwner or getScope throws with a status, with that status and message", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const listed = vi.fn(files.list);
    const base = await serve({ ...files, list: listed }, {
      getOwner: (request) => {
        if (request.headers["x-banned"]) throw Object.assign(new Error("This account is suspended."), { status: 403 });
        return userOf(request);
      },
      getScope: () => {
        throw Object.assign(new Error("This chat no longer exists."), { statusCode: 404 });
      },
    });
    const banned = await list(base, { ...as("alice", "chat-1"), "X-Banned": "1" });
    expect(banned.status).toBe(403);
    expect(await banned.json()).toEqual({ error: "This account is suspended." });
    const gone = await list(base, as("alice", "chat-1"));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "This chat no longer exists." });
    // A hook that throws without a status: a 500 that does not repeat its words.
    const plain = await serve(files, { getOwner: () => { throw new Error("db.users is not reachable at 10.0.0.7"); } });
    const failed = await list(plain);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "The files could not be listed." });
    expect(listed).not.toHaveBeenCalled();
  });

  it("answers a document stored without an owner as missing on every route under the default", async () => {
    const store = new MemoryDocumentStore();
    const legacy = await createLargeFiles({ store, requireOwner: false }).ingest({ name: "old.txt", bytes: utf8("stored without an owner\n") });
    const files = createLargeFiles({ store });
    const mine = await files.ingest({ name: "mine.txt", bytes: utf8("alice's\n"), owner: "alice" });
    const base = await serve(files, { getOwner: userOf });
    const looked = await fetch(`${base}/${legacy.id}`, { headers: as("alice") });
    expect(looked.status).toBe(404);
    expect(await looked.json()).toEqual({ error: "This file is no longer available." });
    expect(await (await fetch(`${base}/${legacy.id}`, { method: "DELETE", headers: as("alice") })).json()).toEqual({ deleted: false });
    expect(await (await list(base, as("alice"))).json()).toEqual({ documents: [toDocumentSummary(mine)] });
    // Still in the store.
    expect(await store.getMeta(legacy.id)).toBeDefined();
  });
});
