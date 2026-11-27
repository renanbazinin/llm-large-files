// DX-1 (0.99.13): the chatbot guide's own samples, run as docs/guides/chatbot.md has them, against
// a memory store on a clock the test moves and a scripted Gemini (test/chatbot-guide-harness.ts).
// A change to the guide's chats.ts or server.ts is tested here as it is written there.
//
// The gate, from the expiry probe of specs/05-quick-fixes (recipe B): one file expires and one is
// deleted; on day 3 the documents_missing notice reaches the page with the names the chat kept, and
// neither file's text is in the request. With touchOnUse, a file used at 47 hours is still there at
// 73 hours, and one used at 10 hours is not touched.
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Harness = typeof import("./chatbot-guide-harness.js");
type Chats = { createChat(userId: string, chatId: string): Promise<void>; filesOf(chatId: string): Promise<Map<string, string>> };

const USER = "u1";
const CANARY = { contract: "Clause 6: notice 30 days.", salary: "Dana: 31,000 ILS a month.", notes: "Locker code 4417." };

let harness: Harness;
let chats: Chats;
let server: Server;
let base: string;
let removeSamples: () => void;

// The first import transforms the library, which takes seconds on a busy machine: done once, here.
beforeAll(async () => {
  const [warm] = await Promise.all([import("./chatbot-guide-harness.js"), import("llm-large-files/node")]);
  rmSync(warm.DOCUMENTS_DIR, { recursive: true, force: true }); // each test loads the harness again, with a folder of its own
}, 60_000);

beforeEach(async () => {
  vi.resetModules(); // a new store, clock, database and app for each test
  harness = await import("./chatbot-guide-harness.js");
  const samples = harness.writeGuideSamples();
  removeSamples = samples.remove;
  // The guide's stand-in for your sign-in: the user's ID, or undefined.
  vi.stubGlobal("currentUserId", (request: { headers: Record<string, unknown> }) => request.headers["x-user-id"]);
  vi.stubGlobal("fetch", harness.fetchWithGemini(globalThis.fetch));
  chats = (await import(`${samples.folder}/chats.ts`)) as Chats;
  const { app } = (await import(`${samples.folder}/server.ts`)) as { app: Parameters<typeof createServer>[1] };
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  removeSamples();
  rmSync(harness.DOCUMENTS_DIR, { recursive: true, force: true });
});

/** What a page of the same site sends: the browser adds Sec-Fetch-Site. */
const page = { "X-User-Id": USER, "Sec-Fetch-Site": "same-origin" };

async function upload(chatId: string, name: string, text: string, headers: Record<string, string> = page): Promise<Response> {
  return fetch(`${base}/api/documents`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), "X-Chat-Id": chatId },
    body: text,
  });
}

async function uploaded(chatId: string, name: string, text: string): Promise<string> {
  const response = await upload(chatId, name, text);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Asks a question as the page does, and reads the events it gets: the data of each SSE message. */
async function ask(chatId: string, question: string): Promise<{ events: Array<Record<string, any>>; bodies: string[] }> {
  const sentBefore = harness.geminiBodies.length;
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { ...page, "Content-Type": "application/json" }, body: JSON.stringify({ chatId, question }) });
  expect(response.status).toBe(200);
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
  expect(events.at(-1)?.type).toBe("run.finish");
  return { events, bodies: harness.geminiBodies.slice(sentBefore) };
}

describe("the chatbot guide's recipe for files that expire or are deleted (DX-1)", () => {
  it("names the files that are gone on the page, and sends none of their text", async () => {
    await chats.createChat(USER, "c1");
    const contract = await uploaded("c1", "contract.txt", `Clause 5: penalty 10,000 ILS.\n${CANARY.contract}\n`);
    const salary = await uploaded("c1", "salary.txt", `${CANARY.salary}\n`);
    const notes = await uploaded("c1", "notes.txt", `${CANARY.notes}\n`);

    // Day 0: the model reads all three files, and the rounds are kept in full.
    harness.geminiSays(
      { calls: [contract, salary, notes].map((id) => ({ name: "read_document", args: { document_id: id, start_line: 1 } })) },
      { text: "The penalty is 10,000 ILS (contract.txt L1); Dana earns 31,000 (salary.txt L1)." },
    );
    const first = await ask("c1", "Penalty and Dana's salary?");
    expect(first.bodies.at(-1)).toContain(CANARY.contract);
    expect(first.bodies.at(-1)).toContain(CANARY.salary);

    // Day 1: salary.txt is deleted by something other than the guide's DELETE route, so the chat
    // still has its name; notes.txt is deleted by the user, through the route.
    harness.later(24);
    expect(await harness.files.delete(salary, { owner: USER, scope: [USER, "c1"] })).toBe(true);
    const removed = await fetch(`${base}/api/documents/${notes}`, { method: "DELETE", headers: { ...page, "X-Chat-Id": "c1" } });
    expect(await removed.json()).toEqual({ deleted: true });

    // Day 3: a new file comes; contract.txt is past its 72 hours.
    harness.later(48);
    const policy = await uploaded("c1", "policy.txt", "Refunds within 14 days.\n");
    harness.later(1);
    expect((await harness.files.list({ owner: USER, scope: [USER, "c1"] })).map((document) => document.id)).toEqual([policy]);

    const second = await ask("c1", "And what is the penalty in clause 5 again?");
    const notices = second.events.filter((event) => event.type === "notice" && event.code === "documents_missing");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.documentIds).toEqual([contract, salary]);
    expect(notices[0]!.names).toEqual(["contract.txt", "salary.txt"]); // what the page shows
    expect(second.events.at(-1)!.result.missing).toEqual([contract, salary]);
    expect(second.bodies.length).toBeGreaterThan(0);
    for (const body of second.bodies) {
      expect(body).not.toContain(CANARY.contract);
      expect(body).not.toContain(CANARY.salary);
      expect(body).not.toContain(CANARY.notes);
      expect(body).toContain("policy.txt"); // the file that is still there is attached
    }

    // The notice was shown once: the chat has forgotten those files, and the next question names none.
    expect([...(await chats.filesOf("c1")).values()]).toEqual(["policy.txt"]);
    const third = await ask("c1", "Anything about refunds?");
    expect(third.events.filter((event) => event.type === "notice" && event.code === "documents_missing")).toEqual([]);
    for (const body of third.bodies) for (const canary of Object.values(CANARY)) expect(body).not.toContain(canary);
  });

  it("keeps a file used at 47 hours past 72 hours, and does not touch one used at 10 hours (touchOnUse)", async () => {
    await chats.createChat(USER, "early");
    await chats.createChat(USER, "late");
    const early = await uploaded("early", "early.txt", "Used at 10 hours.\n");
    const late = await uploaded("late", "late.txt", "Used at 47 hours.\n");
    const expiry = (await harness.files.getMeta(early, { owner: USER, scope: [USER, "early"] }))!.expiresAt;
    expect(Date.parse(expiry)).toBe(harness.startedAt + 72 * harness.HOUR);

    harness.later(10);
    await ask("early", "What does it say?");
    expect(harness.patched).toEqual([]); // more than half of 72 hours left: no write
    expect((await harness.files.getMeta(early, { owner: USER, scope: [USER, "early"] }))!.expiresAt).toBe(expiry);

    harness.later(37);
    await ask("late", "What does it say?");
    expect(harness.patched).toEqual([late]);
    expect(Date.parse((await harness.files.getMeta(late, { owner: USER, scope: [USER, "late"] }))!.expiresAt)).toBe(harness.startedAt + (47 + 72) * harness.HOUR);

    harness.later(26); // 73 hours after both uploads
    expect(await harness.files.getMeta(late, { owner: USER, scope: [USER, "late"] })).toBeDefined();
    expect(await harness.files.getMeta(early, { owner: USER, scope: [USER, "early"] })).toBeUndefined();
  });

  it("refuses an upload that a page of another site sends (refuseCrossSite)", async () => {
    await chats.createChat(USER, "c1");
    const response = await upload("c1", "planted.txt", "From another site.\n", { "X-User-Id": USER, "Sec-Fetch-Site": "cross-site" });
    expect(response.status).toBe(403);
    expect((await chats.filesOf("c1")).size).toBe(0);
    expect(await harness.files.list({ owner: USER, scope: [USER, "c1"] })).toEqual([]);
  });
});
