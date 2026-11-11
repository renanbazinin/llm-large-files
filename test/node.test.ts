import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type DocumentStore } from "llm-large-files";
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
    const summary = await response.json();
    expect(summary).toMatchObject({ name: "יומן.log", format: "log", lines: 10 });
    expect(Object.keys(summary)).not.toContain("owner");
    expect((await (await fetch(`${base}/${summary.id}`)).json()).name).toBe("יומן.log");
  });

  it("accepts the name as a query parameter", async () => {
    const base = await start();
    const response = await fetch(`${base}?name=notes.md`, { method: "POST", body: "# Notes" });
    expect((await response.json()).format).toBe("markdown");
  });

  it("keeps each user's uploads private", async () => {
    const base = await start();
    const upload = await fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt", "X-User": "alice" }, body: "alice's notes" });
    const { id } = await upload.json();
    expect((await fetch(`${base}/${id}`, { headers: { "X-User": "bob" } })).status).toBe(404);
    expect(await (await fetch(`${base}/${id}`, { method: "DELETE", headers: { "X-User": "bob" } })).json()).toEqual({ deleted: false });
    expect((await fetch(`${base}/${id}`, { headers: { "X-User": "alice" } })).status).toBe(200);
    expect(await (await fetch(`${base}/${id}`, { method: "DELETE", headers: { "X-User": "alice" } })).json()).toEqual({ deleted: true });
  });

  it("returns JSON errors for a missing name, unreadable files, and oversized uploads", async () => {
    const base = await start(1_000);
    const unnamed = await fetch(base, { method: "POST", body: "x" });
    expect(unnamed.status).toBe(400);
    expect((await unnamed.json()).error).toMatch(/X-File-Name/);
    const binary = await fetch(base, { method: "POST", headers: { "X-File-Name": "a.bin" }, body: new Uint8Array(500) });
    expect(binary.status).toBe(422);
    expect((await binary.json()).error).toMatch(/binary/);
    const big = await fetch(base, { method: "POST", headers: { "X-File-Name": "a.txt" }, body: "x".repeat(5_000) });
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe("The file is larger than the 1000 B upload limit.");
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
});
