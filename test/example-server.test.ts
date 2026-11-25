// examples/server.ts (LLF-022): it listens on 127.0.0.1 unless HOST is set, gives each browser an
// owner of its own in a cookie, and keeps each owner's files and chats apart.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "llm-large-files";
import { createDemoServer, demoAddress, demoLibrary } from "../examples/server.js";
import { fakeModel, says } from "./fake-model.js";

let server: Server | undefined;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/** A browser: it keeps the cookies the server sets, and sends them back. */
function browser(base: string) {
  let cookie = "";
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), ...(cookie ? { Cookie: cookie } : {}) } });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return response;
  };
  return { request, cookie: () => cookie };
}

describe("examples/server.ts", () => {
  it("listens on 127.0.0.1 unless HOST is set", async () => {
    expect(demoAddress({})).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(demoAddress({ HOST: "0.0.0.0", PORT: "8080" })).toEqual({ host: "0.0.0.0", port: 8080 });
    const { files, isolated } = demoLibrary(new MemoryDocumentStore());
    close = () => isolated.close();
    server = createDemoServer({ files, model: fakeModel([says("Hi.")]) });
    await new Promise<void>((resolve) => server!.listen(0, demoAddress({}).host, resolve));
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("gives each browser an owner of its own: two browsers cannot read each other's uploads or chats", async () => {
    const { files, isolated } = demoLibrary(new MemoryDocumentStore());
    close = () => isolated.close();
    // The library requires an owner: no document is ever anyone's.
    expect(files.access).toEqual({ requireOwner: true, requireScope: false });
    const model = fakeModel([says("On Tuesday.")]);
    server = createDemoServer({ files, model });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Without the cookie of the page, an upload is refused before it is read.
    const stranger = await fetch(`${base}/api/documents`, { method: "POST", headers: { "X-File-Name": "a.txt" }, body: "notes" });
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: "Sign in first." });

    const alice = browser(base);
    const bob = browser(base);
    const page = await alice.request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toMatch(/^demo-owner=[0-9a-f]{32}; HttpOnly; SameSite=Strict; Path=\/$/);
    await bob.request("/");
    expect(alice.cookie()).not.toBe(bob.cookie());
    // The page does not give a browser that has an owner a new one.
    expect((await alice.request("/")).headers.get("set-cookie")).toBeNull();

    const uploaded = await alice.request("/api/documents", { method: "POST", headers: { "X-File-Name": "notes.txt" }, body: "The meeting is on Tuesday." });
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };

    expect((await bob.request(`/api/documents/${id}`)).status).toBe(404);
    expect(await (await bob.request(`/api/documents/${id}`, { method: "DELETE" })).json()).toEqual({ deleted: false });
    const ask = (who: typeof alice, question: string) => who.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "chat-1", question, documentIds: [id] }),
    }).then((response) => response.text());
    const bobs = await ask(bob, "What is in it?");
    expect(bobs).toContain("event: run.error");
    expect(bobs).toContain("A file expired. Attach it again.");
    expect(model.requests).toHaveLength(0);

    expect((await alice.request(`/api/documents/${id}`)).status).toBe(200);
    expect(await ask(alice, "When is the meeting?")).toContain("event: run.finish");
    // Bob's chat of the same ID is not Alice's: his question is sent without her history.
    const plain = await bob.request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: "chat-1", question: "Anything?", documentIds: [] }) });
    expect(await plain.text()).toContain("event: run.finish");
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).not.toContain("When is the meeting?");
    expect(await (await alice.request(`/api/documents/${id}`, { method: "DELETE" })).json()).toEqual({ deleted: true });
  });

  it("lists the browser's uploads at GET /api/documents", async () => {
    const { files, isolated } = demoLibrary(new MemoryDocumentStore());
    close = () => isolated.close();
    server = createDemoServer({ files, model: fakeModel([says("Hi.")]) });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Without the cookie of the page: nobody's list.
    const stranger = await fetch(`${base}/api/documents`);
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: "Sign in first." });

    const alice = browser(base);
    const bob = browser(base);
    await alice.request("/");
    await bob.request("/");
    const uploaded = await alice.request("/api/documents", { method: "POST", headers: { "X-File-Name": "notes.txt" }, body: "The meeting is on Tuesday." });
    const summary = (await uploaded.json()) as { id: string };
    const listed = await alice.request("/api/documents");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ documents: [summary] });
    expect(await (await bob.request("/api/documents")).json()).toEqual({ documents: [] });
  });
});
