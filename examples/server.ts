// A complete chat server for large files in one file: an upload endpoint, answers streamed over
// Server-Sent Events, and a minimal web page. It needs nothing beyond this package and, for some
// formats, its optional peers: unpdf for PDF, jszip for DOCX and PPTX, @cantoo/pdf-lib for the
// pages of a PDF.
//
// NOT FOR PRODUCTION AS IS. It is a demo: there is no sign-in. Each browser gets a random owner in
// a cookie, so that two browsers cannot read each other's files, but anyone who has that cookie is
// that owner. Chats are kept in memory. Put your own sign-in in getOwner, and keep the chats in your
// database. It listens on 127.0.0.1 only, unless HOST is set.
//
//   npm install
//   npm run build
//   GEMINI_API_KEY=... node examples/server.ts      →  http://127.0.0.1:3000
//
// GEMINI_MODEL picks the model. GEMINI_EXPLORER_MODEL is optional: a second model that searches
// and reads the files, so that GEMINI_MODEL only writes the answer. HOST and PORT change where it
// listens (HOST=0.0.0.0 for every interface: only behind your own sign-in).
//
// Runs on Node 22.18+ or 24 (built-in TypeScript type stripping).
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setInterval } from "node:timers";
import { fileURLToPath } from "node:url";
import {
  askStream,
  createLargeFiles,
  FileDocumentStore,
  partialResultOf,
  type DocumentStore,
  type EventError,
  type LargeFiles,
  type ModelAdapter,
  type ToolTurn,
} from "llm-large-files";
import { gemini, geminiApi, type ChatTurn } from "llm-large-files/gemini";
import { createDocumentHandlers, createIsolatedExtractors, sseMessageOf, writeSseEvents, type IsolatedExtractors } from "llm-large-files/node";

/** Where the demo listens: 127.0.0.1 unless HOST is set, port 3000 unless PORT is. */
export function demoAddress(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  return { host: env.HOST || "127.0.0.1", port: Number(env.PORT) || 3000 };
}

/**
 * The library of the demo. PDF and Office files are read in child processes, each with a memory
 * limit and a kill timer, so that a file built to exhaust a server is refused and the server goes
 * on. keepOriginals lets the model look at the pages of an uploaded PDF (charts, photos, scans): it
 * needs the optional dependency @cantoo/pdf-lib, and keeps each PDF in the store until it expires.
 * Owner checks are on by default (requireOwner): every call names its owner, so that no document is
 * ever anyone's.
 */
export function demoLibrary(store: DocumentStore = new FileDocumentStore(".data/large-files")): { files: LargeFiles; isolated: IsolatedExtractors } {
  const isolated = createIsolatedExtractors();
  const files = createLargeFiles({ store, keepOriginals: ["pdf"], extractors: isolated.extractors });
  return { files, isolated };
}

/** The cookie that holds the demo's owner: 32 random hex digits, made when the page is loaded. */
const OWNER_COOKIE = "demo-owner";
const OWNER_SHAPE = /^[0-9a-f]{32}$/;

/** The owner of a request: its cookie, when it has one of the right shape. In a real app, your sign-in. */
function ownerOf(request: IncomingMessage): string | undefined {
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const [name, value] = pair.trim().split("=");
    if (name === OWNER_COOKIE && value !== undefined && OWNER_SHAPE.test(value)) return value;
  }
  return undefined;
}

type ChatBody = { chatId: string; question: string; documentIds: string[] };
const BODY_LIMIT = 64 * 1024;
const QUESTION_LIMIT = 4_000;

/** The question asked, or the status and error to answer with. */
async function chatBody(request: IncomingMessage): Promise<ChatBody | { status: number; error: string }> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) return { status: 413, error: "The question is too long." };
  // Decoded once, whole: a character split between two chunks would otherwise be lost.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > BODY_LIMIT) {
      // Nothing more is kept; the rest is read so that the page gets the answer.
      request.resume();
      return { status: 413, error: "The question is too long." };
    }
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ChatBody> | null;
    if (typeof body?.question === "string" && body.question.length > QUESTION_LIMIT) {
      return { status: 400, error: `Ask in at most ${QUESTION_LIMIT.toLocaleString("en")} characters.` };
    }
    const valid = typeof body?.chatId === "string" && body.chatId.length <= 100 && typeof body.question === "string"
      && body.question.trim() !== "" && Array.isArray(body.documentIds) && body.documentIds.length <= 100
      && body.documentIds.every((id) => typeof id === "string");
    if (valid) return body as ChatBody;
  } catch {
    // Not JSON: answered below.
  }
  return { status: 400, error: "Send JSON: { chatId, question, documentIds }." };
}

/** What to tell the user. The provider's own message is for the server's log. */
function userMessage(error: EventError): string {
  if (error.name === "DocumentsNotFoundError") return "A file expired. Attach it again.";
  if (error.name === "DocumentStoreError") return "The files could not be read just now. Try again.";
  switch (error.kind) {
    case "context_overflow": return "This chat is too long for the model. Start a new chat, or ask about fewer files.";
    case "rate_limit": return "The model is busy. Try again in a minute.";
    case "quota": return "The model is not available right now.";
    case "timeout": return "The model took too long to answer. Try again.";
    case "unreachable":
    case "server": return "The model could not answer just now. Try again.";
    default: return "Something went wrong. The server's log says what.";
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** The demo's server, not yet listening: the page, the upload routes and the chat route. */
export function createDemoServer({ files, model, explorer }: { files: LargeFiles; model: ModelAdapter; explorer?: ModelAdapter }): Server {
  // An upload sent with `Accept: text/event-stream` is answered with its progress, then its summary
  // (in `document`). A request without the cookie is answered 401 "Sign in first.", before its
  // body is read: the library requires an owner.
  const documents = createDocumentHandlers(files, { getOwner: ownerOf });

  // Each chat's turns, its tool rounds among them, stay on the server: a follow-up question then
  // needs no new search, and the page never handles them. They are kept by owner and chat, so that
  // nobody reads another's chat by its ID. This Map is for the demo only: it lives in memory, keeps
  // the latest questions of the latest chats, and two questions sent at once in one chat each keep
  // only their own turns. In a real app, keep the turns in your database.
  const chats = new Map<string, Array<ChatTurn | ToolTurn>>();
  const CHATS_KEPT = 1_000;
  const QUESTIONS_KEPT = 20;
  function remember(key: string, turns: Array<ChatTurn | ToolTurn>): void {
    // Only the latest questions of a chat are kept, each with its tool rounds and its answer.
    const questions = turns.flatMap((turn, index) => (turn.role === "user" ? [index] : []));
    const kept = questions.length > QUESTIONS_KEPT ? turns.slice(questions[questions.length - QUESTIONS_KEPT]) : turns;
    chats.delete(key);
    chats.set(key, kept);
    // The chat used longest ago goes first.
    if (chats.size > CHATS_KEPT) chats.delete(chats.keys().next().value!);
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = /^\/api\/documents\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === "POST" && url.pathname === "/api/documents") return documents.upload(request, response);
    // The browser's documents, the oldest first: those of its owner (the cookie), and only those.
    if (request.method === "GET" && url.pathname === "/api/documents") return documents.list(request, response);
    if (id !== undefined && request.method === "GET") return documents.get(request, response, id);
    if (id !== undefined && request.method === "DELETE") return documents.remove(request, response, id);
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const owner = ownerOf(request);
      if (!owner) return sendJson(response, 401, { error: "Sign in first." });
      const body = await chatBody(request);
      if ("error" in body) return sendJson(response, body.status, { error: body.error });
      const key = `${owner}/${body.chatId}`;
      const history = chats.get(key) ?? [];
      const asked: ChatTurn = { role: "user", text: body.question };
      const stream = askStream({ files, model, explorer, messages: [...history, asked], documentIds: body.documentIds, owner });
      // The page gets every event as sseMessageOf sends it, an error in the app's own words. The
      // stream is passed as it is, so that the question stops as soon as the page goes away.
      await writeSseEvents(response, stream, {
        map: (event) => sseMessageOf(event.type === "run.error" ? { ...event, error: { ...event.error, message: userMessage(event.error) } } : event),
      });
      try {
        const result = await stream.result;
        // The answer is kept only when there is one: the model would read an error message as its own words.
        remember(key, [...history, asked, ...result.toolTurns, ...(result.answered ? [{ role: "model" as const, text: result.text }] : [])]);
      } catch (error) {
        // A question stopped because the page went away is no error of the server's.
        if ((error as Error | undefined)?.name !== "AbortError") console.error(error);
        // What the question found before it failed is kept too, so asking again does not search again.
        remember(key, [...history, asked, ...(partialResultOf(error)?.toolTurns ?? [])]);
      }
      return;
    }
    // The page gives a browser without the cookie an owner of its own: HttpOnly, so that no script
    // reads it, and SameSite=Strict, so that no other site's page sends it.
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
    if (!ownerOf(request)) headers["Set-Cookie"] = `${OWNER_COOKIE}=${randomBytes(16).toString("hex")}; HttpOnly; SameSite=Strict; Path=/`;
    response.writeHead(200, headers);
    response.end(PAGE);
  }

  return createServer((request, response) => {
    // A request that fails (a chat body cut off on its way) must not stop the server.
    route(request, response).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: "Something went wrong." });
      else response.destroy();
    });
  });
}

// The page sets only textContent from what the server sends: no file name, label or answer is read as HTML.
const PAGE = `<!doctype html>
<meta charset="utf-8"><title>llm-large-files demo</title>
<style>body{font:15px system-ui;max-width:760px;margin:40px auto;padding:0 16px}#log{white-space:pre-wrap}
#tools{color:#666;font-size:13px;padding-left:18px}.error,.refused{color:#a40}.status{color:#888;font-style:italic}input,button{font:inherit}</style>
<h1>Ask about a large file</h1>
<p><input type="file" id="file"> <span id="info"></span></p>
<p><input id="question" size="60" placeholder="What does this file say about…?"> <button id="ask">Ask</button></p>
<ul id="tools"></ul><p class="status" id="activity"></p><div id="log"></div>
<script>
// By getElementById: an id such as "status" would not be a global, as window.status is taken.
const activity = document.getElementById("activity");
const chatId = crypto.randomUUID();
let documentIds = [];

/** Calls on(name, data) for each message of an event stream. Comments (keep-alive) are skipped. */
async function readEvents(response, on) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\\n\\n")) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      // Line by line: a field's value runs to the end of its line.
      let name = "message";
      const data = [];
      for (const line of block.split("\\n")) {
        if (line.startsWith("event: ")) name = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (!data.length) continue;
      // One message the page cannot read does not stop the others.
      try { on(name, JSON.parse(data.join("\\n"))); } catch (error) { console.error(error); }
    }
  }
}

file.onchange = async () => {
  const chosen = file.files[0];
  info.textContent = "Uploading…";
  const response = await fetch("/api/documents", { method: "POST", body: chosen, headers: {
    "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(chosen.name), Accept: "text/event-stream" } });
  if (!response.ok) { info.textContent = (await response.json()).error; return; }
  await readEvents(response, (name, data) => {
    if (name === "ingest.progress") info.textContent = "Reading the file (" + data.stage + "): " + data.done.toLocaleString()
      + (data.total ? " of " + data.total.toLocaleString() : "") + " " + data.unit + "…";
    if (name === "ingest.error") info.textContent = data.error.message;
    if (name === "ingest.finish") {
      const summary = data.document;
      documentIds = [summary.id];
      info.textContent = summary.format + " · " + summary.lines.toLocaleString() + " lines · ~" + summary.estimatedTokens.toLocaleString() + " tokens";
    }
  });
};

const MARKS = { ok: "✓", error: "✗", refused: "–", already_shown: "↺", not_run: "–", redacted: "✂" };
ask.onclick = async () => {
  tools.replaceChildren(); log.textContent = ""; activity.textContent = "";
  const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, question: question.value, documentIds }) });
  if (!response.ok) { activity.textContent = "Error: " + (await response.json()).error; return; }
  const calls = new Map();
  const line = (text, className) => {
    const item = document.createElement("li");
    item.textContent = text;
    if (className) item.className = className;
    tools.append(item);
    return item;
  };
  let answer = "";
  await readEvents(response, (name, data) => {
    if (name === "tool.start") {
      calls.set(data.callId, { label: data.label, item: line("… " + data.label) });
      activity.textContent = data.label + "…";
    }
    if (name === "tool.progress") {
      // A whole-file read: how many of its parts are read.
      const call = calls.get(data.callId);
      if (call) call.item.textContent = "… " + call.label + " (" + data.done + "/" + data.total + ")";
      activity.textContent = data.message + "…";
    }
    if (name === "tool.end") {
      const call = calls.get(data.callId);
      if (call) { call.item.textContent = MARKS[data.outcome] + " " + (data.step || call.label); call.item.className = data.outcome; }
    }
    if (name === "notice" && data.display === "activity") activity.textContent = data.message;
    if (name === "notice" && data.display === "step") line("· " + data.message);
    if (name === "retry") activity.textContent = data.message;
    if (name === "text") { answer += data.delta; log.textContent = answer; activity.textContent = ""; }
    if (name === "run.finish") {
      const result = data.result;
      activity.textContent = result.answered
        ? result.usage.requests + " model requests · " + result.usage.inputTokens.toLocaleString() + " input tokens"
        : "No answer this time. Ask again, or ask more precisely.";
    }
    if (name === "run.error") activity.textContent = "Error: " + data.error.message;
  });
};
</script>`;

/** Whether this file is the script Node was started with (`node examples/server.ts`), not a module imported by a test. */
function isMain(): boolean {
  const started = process.argv[1];
  if (!started) return false;
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Set GEMINI_API_KEY.");
  const endpoint = geminiApi({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
    // Unset or empty, there is no explorer: the one model searches, reads and answers.
    explorerModel: process.env.GEMINI_EXPLORER_MODEL,
  });
  // A second model for the requests that use tools, when the endpoint names one.
  const explorer = endpoint.explorerUrl && endpoint.explorerUrl !== endpoint.url ? gemini({ url: endpoint.explorerUrl, headers: endpoint.headers }) : undefined;
  const { files, isolated } = demoLibrary();
  // An expired document, and its PDF, stay on disk until they are looked up again or swept.
  setInterval(() => files.sweep().catch(console.error), 60 * 60 * 1000).unref();
  const { host, port } = demoAddress();
  const server = createDemoServer({ files, model: gemini(endpoint), ...(explorer ? { explorer } : {}) });
  server.listen(port, host, () => console.log(`Open http://${host.includes(":") ? `[${host}]` : host}:${port}`));
  process.once("SIGTERM", () => {
    server.close();
    void isolated.close();
  });
}
