import { Agent, createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type DocumentStore, type DocumentSummary } from "llm-large-files";
import { createDocumentHandlers, type DocumentHandlerOptions } from "llm-large-files/node";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** A well-formed document id that no document has. */
const UNKNOWN_ID = "doc_0123456789abcdef0123456789abcdef";

async function start(maxUploadBytes = 1024 * 1024, options: { store?: DocumentStore; getOwner?: DocumentHandlerOptions["getOwner"] } = {}): Promise<string> {
  const files = createLargeFiles({ store: options.store ?? new MemoryDocumentStore(), maxUploadBytes });
  const documents = createDocumentHandlers(files, {
    getOwner: options.getOwner ?? ((request) => (request.headers["x-user"] as string | undefined) || undefined),
  });
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.pathname.split("/")[3] ?? "";
    if (request.method === "POST" && url.pathname === "/api/documents") return void documents.upload(request, response);
    if (request.method === "GET") return void documents.get(request, response, id);
    if (request.method === "DELETE") return void documents.remove(request, response, id);
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/documents`;
}

describe("createDocumentHandlers", () => {
  it("uploads raw bytes and returns a summary", async () => {
    const base = await start();
    const response = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("יומן.log") },
      body: "2026-01-01 10:00:00 INFO a\n".repeat(10),
    });
    expect(response.status).toBe(201);
    const summary = (await response.json()) as DocumentSummary;
    expect(summary).toMatchObject({ name: "יומן.log", format: "log", lines: 10 });
    expect(Object.keys(summary)).not.toContain("owner");
    expect(((await (await fetch(`${base}/${summary.id}`)).json()) as DocumentSummary).name).toBe("יומן.log");
  });

  it("accepts the name as a query parameter", async () => {
    const base = await start();
    const response = await fetch(`${base}?name=notes.md`, { method: "POST", body: "# Notes" });
    expect(((await response.json()) as DocumentSummary).format).toBe("markdown");
  });

  it("keeps each user's uploads private", async () => {
    const base = await start();
    const upload = await fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt", "X-User": "alice" }, body: "alice's notes" });
    const { id } = (await upload.json()) as DocumentSummary;
    expect((await fetch(`${base}/${id}`, { headers: { "X-User": "bob" } })).status).toBe(404);
    expect(await (await fetch(`${base}/${id}`, { method: "DELETE", headers: { "X-User": "bob" } })).json()).toEqual({ deleted: false });
    expect((await fetch(`${base}/${id}`, { headers: { "X-User": "alice" } })).status).toBe(200);
    expect(await (await fetch(`${base}/${id}`, { method: "DELETE", headers: { "X-User": "alice" } })).json()).toEqual({ deleted: true });
  });

  it("returns JSON errors for a missing name, unreadable files, and oversized uploads", async () => {
    const base = await start(1_000);
    const unnamed = await fetch(base, { method: "POST", body: "x" });
    expect(unnamed.status).toBe(400);
    expect(((await unnamed.json()) as { error: string }).error).toMatch(/X-File-Name/);
    const binary = await fetch(base, { method: "POST", headers: { "X-File-Name": "a.bin" }, body: new Uint8Array(500) });
    expect(binary.status).toBe(422);
    expect(((await binary.json()) as { error: string }).error).toMatch(/binary/);
    const big = await fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt" }, body: "x".repeat(5_000) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toBe("The file is larger than the 1000 B upload limit.");
  });

  // LLF-033: the rest of a body over the limit is drained after the 413, up to 8 MB, so that a
  // client still sending reads the answer and can use the connection again. It was left unread:
  // the connection stayed open with the client stuck sending into it.
  /** A chunked upload of `bytes` through `agent`, as a client that sends its whole body does. */
  function chunkedUpload(base: string, bytes: number, agent?: Agent) {
    const url = new URL(base);
    return new Promise<{ status?: number; body: string } | { error: string }>((resolve) => {
      const request = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", agent, headers: { "X-File-Name": "a.txt", "Transfer-Encoding": "chunked" } });
      request.on("response", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (piece: string) => (body += piece));
        response.on("end", () => resolve({ status: response.statusCode, body }));
        response.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.message }));
      });
      request.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.message }));
      const piece = Buffer.alloc(64 * 1024, 120);
      let sent = 0;
      const pump = () => {
        while (sent < bytes && !request.destroyed) {
          sent += piece.byteLength;
          if (!request.write(piece)) return void request.once("drain", pump);
        }
        if (!request.destroyed) request.end();
      };
      pump();
    });
  }
  const connections = () => new Promise<number>((resolve) => server!.getConnections((_error, count) => resolve(count)));

  it("drains the rest of an upload over the limit, answers 413, and keeps the connection for the next request", async () => {
    const base = await start(1_000);
    let opened = 0;
    server!.on("connection", () => opened++);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const answer = await chunkedUpload(base, 4 * 1024 * 1024, agent);
      expect(answer).toEqual({ status: 413, body: JSON.stringify({ error: "The file is larger than the 1000 B upload limit." }) });
      // The next request goes on the same connection, and is answered.
      const next = await new Promise<number | undefined>((resolve, reject) => {
        httpRequest(`${base}/${UNKNOWN_ID}`, { agent }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on("error", reject).end();
      });
      expect(next).toBe(404);
      expect(opened).toBe(1);
    } finally {
      agent.destroy();
      server!.closeAllConnections();
    }
  });

  it("closes the connection of an upload that goes on more than 8 MB past the limit", async () => {
    const base = await start(1_000);
    try {
      const answer = await chunkedUpload(base, 64 * 1024 * 1024);
      // The 413 when the client read it before the connection closed, else the reset.
      if ("status" in answer) expect(answer.status).toBe(413);
      await expect.poll(connections).toBe(0);
    } finally {
      server!.closeAllConnections();
    }
  });

  // The server below answers with `void documents.get(…)`: a handler that rejected would end the
  // process (it did for a getOwner that throws, or a store that fails).
  it("answers a getOwner that throws, with the status it carries, and keeps serving", async () => {
    const base = await start(1024 * 1024, {
      getOwner: (request) => {
        const user = request.headers["x-user"];
        if (user === "expired") throw Object.assign(new Error("Sign in again."), { status: 401 });
        if (user === "broken") throw new Error("The session store at 10.0.0.5:6379 refused the connection.");
        return typeof user === "string" ? user : undefined;
      },
    });
    for (const method of ["GET", "DELETE"]) {
      const refused = await fetch(`${base}/${UNKNOWN_ID}`, { method, headers: { "X-User": "expired" } });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "Sign in again." });
      const failed = await fetch(`${base}/${UNKNOWN_ID}`, { method, headers: { "X-User": "broken" } });
      expect(failed.status).toBe(500);
      expect(JSON.stringify(await failed.json())).not.toContain("10.0.0.5");
    }
    expect((await fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt", "X-User": "expired" }, body: "notes" })).status).toBe(401);
    expect((await fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt", "X-User": "alice" }, body: "notes" })).status).toBe(201);
  });

  it("answers a store that fails with a 500 that gives the error code and no server path", async () => {
    const failure = (code: string, call: string) => Object.assign(new Error(`${code}: failed, ${call} 'C:\\srv\\large-files\\doc_1.txt'`), { code, syscall: call });
    class FailingStore extends MemoryDocumentStore {
      override async put(): Promise<void> {
        throw failure("ENOSPC", "write");
      }
      override async getMeta(): Promise<undefined> {
        throw failure("EIO", "open");
      }
    }
    const base = await start(1024 * 1024, { store: new FailingStore() });
    const upload = await fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt" }, body: "notes" });
    expect(upload.status).toBe(500);
    expect(await upload.json()).toEqual({ error: "Upload failed (ENOSPC)." });
    const lookup = await fetch(`${base}/${UNKNOWN_ID}`);
    expect(lookup.status).toBe(500);
    expect(await lookup.json()).toEqual({ error: "The file could not be looked up (EIO)." });
    const removal = await fetch(`${base}/${UNKNOWN_ID}`, { method: "DELETE" });
    expect(await removal.json()).toEqual({ error: "The file could not be deleted (EIO)." });
  });

  it("answers a custom store's own error with a 500 that does not repeat its message", async () => {
    let failing: Error | string | undefined;
    class CustomStore extends MemoryDocumentStore {
      override async put(...args: Parameters<MemoryDocumentStore["put"]>): Promise<void> {
        if (failing !== undefined) throw failing;
        return super.put(...args);
      }
    }
    const base = await start(1024 * 1024, { store: new CustomStore() });
    const upload = () => fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt" }, body: "notes" });
    // A database driver's error, with no status and no system call: its message names the host.
    for (const thrown of [new Error("connect ECONNREFUSED: topology was destroyed, mongo-prod-1.internal.example:27017"), "mongo-prod-1.internal.example refused"]) {
      failing = thrown;
      const failed = await upload();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "Upload failed." });
    }
    // An error the store gave a status, as http-errors does, is answered with that status and its message.
    failing = Object.assign(new Error("The document database is down. Try again in a minute."), { status: 503 });
    const refused = await upload();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "The document database is down. Try again in a minute." });
    // A file that cannot be read is still the client's 422, with the reason.
    failing = undefined;
    const empty = await fetch(base, { method: "POST", headers: { "X-File-Name": "blank.txt" }, body: "   \n\n" });
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ error: "blank.txt did not contain any text." });
  });

  // On Node 22 the client's fetch keeps the aborted connection about 4 s.
  it("stops reading an upload when the client goes away", { timeout: 15_000 }, async () => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    let stoppedWith: unknown;
    // An extractor that reads until it is told to stop.
    const files = createLargeFiles({
      store: new MemoryDocumentStore(),
      extractors: {
        text: (_bytes, input) => new Promise((_resolve, reject) => {
          started();
          input?.signal?.addEventListener("abort", () => {
            stoppedWith = input.signal!.reason;
            reject(input.signal!.reason);
          }, { once: true });
        }),
      },
    });
    const documents = createDocumentHandlers(files);
    server = createServer((request, response) => void documents.upload(request, response));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const client = new AbortController();
    const upload = fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`, {
      method: "POST",
      headers: { "X-File-Name": "a.txt" },
      body: "notes",
      signal: client.signal,
    }).catch((error: unknown) => error);
    await reading;
    client.abort();
    await upload;
    await expect.poll(() => stoppedWith).toBeInstanceOf(Error);
    expect((stoppedWith as Error).message).toMatch(/client closed the connection/);
  });
});
