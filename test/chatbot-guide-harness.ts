// What the samples of docs/guides/chatbot.md import from outside the library, for
// test/dx1-expiry-guide.test.ts, which runs those samples as the page has them. One module stands in
// for three: the guide's own large-files.ts (a memory store on a clock the test moves, and a Vertex AI
// endpoint answered by a scripted fetch), "mongodb" (a few collection methods, in memory) and
// "express" (routes, path parameters, express.json()). The test points the samples' imports of these
// at this file; every other import of the samples is the real one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { vertexAi } from "llm-large-files/gemini";
import { sse } from "llm-large-files/testing";

// ---- large-files.ts --------------------------------------------------------------------------

export const HOUR = 3_600_000;
let clock = Date.parse("2026-11-01T08:00:00Z");
const now = () => new Date(clock);
/** Moves the clock of the store and the library. */
export const later = (hours: number) => void (clock += hours * HOUR);
export const startedAt = clock;

/** The store, with each `patchMeta` call counted: a touch is one. */
export const store = new MemoryDocumentStore({ now });
export const patched: string[] = [];
const patchMeta = store.patchMeta.bind(store);
store.patchMeta = (id, patch, options) => {
  patched.push(id);
  return patchMeta(id, patch, options);
};

/** The guide's folder of chats: `createChat` makes a folder in it, `deleteChat` removes it. */
export const DOCUMENTS_DIR = mkdtempSync(path.join(tmpdir(), "chatbot-guide-"));
// Files this small would go into the prompt whole: an inline budget of 1 token makes the model read them with tools.
export const files = createLargeFiles({ store, now, requireScope: true, budget: { inlineTokens: 1 } });
export const endpoint = vertexAi({ project: "test-project", location: "global", model: "gemini-test", accessToken: "test-token" });

/** A reply of the scripted Gemini: text, or function calls. */
export type GeminiReply = { text: string } | { calls: Array<{ name: string; args: Record<string, unknown> }> };
const script: GeminiReply[] = [];
/** The body of every request sent to Gemini, in order. */
export const geminiBodies: string[] = [];
/** The next replies of Gemini; once they run out, it answers "ok". */
export const geminiSays = (...replies: GeminiReply[]) => void script.push(...replies);

/**
 * A `fetch` that answers Vertex AI from the script and sends every other request on: the samples
 * pass no `fetch` to `askGemini`, so the test puts this one in place of the global one.
 */
export function fetchWithGemini(realFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("aiplatform.googleapis.com")) return realFetch(input, init);
    geminiBodies.push(typeof init?.body === "string" ? init.body : "");
    const reply = script.shift() ?? { text: "ok" };
    const parts = "text" in reply ? [{ text: reply.text }] : reply.calls.map((call) => ({ functionCall: call }));
    const chunk = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    return url.includes(":streamGenerateContent") ? sse([chunk]) : Response.json(chunk);
  };
}

// ---- mongodb ---------------------------------------------------------------------------------

type Doc = Record<string, unknown>;
type Filter = Record<string, unknown>;

const matches = (filter: Filter) => (doc: Doc) =>
  Object.entries(filter).every(([key, wanted]) =>
    wanted !== null && typeof wanted === "object" && "$in" in wanted ? (wanted.$in as unknown[]).includes(doc[key]) : doc[key] === wanted);

class Collection {
  private docs: Doc[] = [];
  find(filter: Filter) {
    const found = () => this.docs.filter(matches(filter)).map((doc) => structuredClone(doc));
    return {
      sort: (by: Record<string, 1 | -1>) => {
        const [key, order] = Object.entries(by)[0]!;
        return { toArray: async () => found().sort((a, b) => order * (Number(a[key]) - Number(b[key]))) };
      },
      toArray: async () => found(),
    };
  }
  async insertOne(doc: Doc) {
    if (doc._id !== undefined && this.docs.some((kept) => kept._id === doc._id)) throw new Error(`E11000 duplicate key ${String(doc._id)}`);
    this.docs.push(structuredClone(doc));
    return { acknowledged: true };
  }
  async countDocuments(filter: Filter) {
    return this.docs.filter(matches(filter)).length;
  }
  async deleteMany(filter: Filter) {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matches(filter)(doc));
    return { deletedCount: before - this.docs.length };
  }
  async deleteOne(filter: Filter) {
    const index = this.docs.findIndex(matches(filter));
    if (index >= 0) this.docs.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  }
}

export class MongoClient {
  db() {
    const collections = new Map<string, Collection>();
    return { collection: (name: string) => collections.get(name) ?? collections.set(name, new Collection()).get(name)! };
  }
}

// ---- express ---------------------------------------------------------------------------------

type Request = IncomingMessage & { params: Record<string, string>; body?: unknown };
type Response = ServerResponse & { status(code: number): Response; json(body: unknown): Response };
type Handler = (request: Request, response: Response, next: () => Promise<void>) => unknown;

function express() {
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handlers: Handler[] }> = [];
  const app = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const request = incoming as Request;
    const response = Object.assign(outgoing, {
      status: (code: number) => ((outgoing.statusCode = code), response),
      json: (body: unknown) => (outgoing.setHeader("Content-Type", "application/json"), outgoing.end(JSON.stringify(body)), response),
    }) as Response;
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    for (const route of routes) {
      const found = route.method === request.method ? route.pattern.exec(pathname) : null;
      if (!found) continue;
      request.params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(found[index + 1]!)]));
      const step = async (index: number): Promise<void> => void (await route.handlers[index]?.(request, response, () => step(index + 1)));
      step(0).catch((error: unknown) => {
        if (!response.headersSent) response.status(500).json({ error: String(error) });
        else response.destroy();
      });
      return;
    }
    response.status(404).json({ error: "No such route." });
  };
  const add = (method: string) => (route: string, ...handlers: Handler[]) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${route.replace(/:(\w+)/g, (_, key: string) => (keys.push(key), "([^/]+)"))}$`);
    routes.push({ method, pattern, keys, handlers });
  };
  return Object.assign(app, { get: add("GET"), post: add("POST"), delete: add("DELETE") });
}

express.json = (): Handler => async (request, _response, next) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  request.body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  await next();
};

export default express;

// ---- the guide's samples ---------------------------------------------------------------------

const GUIDE = fileURLToPath(new URL("../docs/guides/chatbot.md", import.meta.url));
const HARNESS = fileURLToPath(import.meta.url);
/** The modules of the samples that this file stands in for. */
const STOOD_IN = new Set(["express", "mongodb", "./large-files.js"]);
/** The modules the samples may import as they are. */
const REAL = (specifier: string) => specifier.startsWith("node:") || specifier === "./chats.js" || /^llm-large-files(\/(node|gemini))?$/.test(specifier);

/** The TypeScript blocks of the guide, each by its first line ("// chats.ts"). */
function blocksOfGuide(): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const [, body] of readFileSync(GUIDE, "utf8").matchAll(/^```ts\n([\s\S]*?)^```$/gm)) {
    const first = body!.split("\n", 1)[0]!;
    if (blocks.has(first)) throw new Error(`Two blocks of the chatbot guide start with ${first}.`);
    blocks.set(first, body!);
  }
  return blocks;
}

/**
 * Writes chats.ts and server.ts of the chatbot guide, as the page has them (server.ts is its two
 * halves, one after the other), into a folder of their own, with their imports of express, mongodb
 * and large-files.ts pointed at this file. Returns the folder. Throws when a block is not found, or a
 * sample imports a module that is neither real here nor stood in for.
 */
export function writeGuideSamples(): { folder: string; remove: () => void } {
  const blocks = blocksOfGuide();
  const block = (first: string) => {
    const body = blocks.get(first);
    if (body === undefined) throw new Error(`The chatbot guide has no block that starts with "${first}".`);
    return body.replace(/^(import [^;]*? from |import )"([^"]+)";$/gm, (line, head: string, specifier: string) => {
      if (STOOD_IN.has(specifier)) return `${head}${JSON.stringify(HARNESS)};`;
      if (REAL(specifier)) return line;
      throw new Error(`A sample of the chatbot guide imports "${specifier}", which test/chatbot-guide-harness.ts does not provide.`);
    });
  };
  const folder = mkdtempSync(path.join(tmpdir(), "chatbot-guide-samples-"));
  writeFileSync(path.join(folder, "chats.ts"), block("// chats.ts"));
  writeFileSync(path.join(folder, "server.ts"), `${block("// server.ts, first half")}\n${block("// server.ts, second half")}`);
  return { folder, remove: () => rmSync(folder, { recursive: true, force: true }) };
}
