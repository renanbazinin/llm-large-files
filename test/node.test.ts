import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(maxUploadBytes = 1024 * 1024): Promise<string> {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes });
  const documents = createDocumentHandlers(files, {
    getOwner: (request) => (request.headers["x-user"] as string | undefined) || undefined,
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
});
