// A complete chat server for large files in one file: an upload endpoint, answers streamed over
// Server-Sent Events, and a minimal web page. It needs nothing beyond this package and, for some
// formats, its optional peers: unpdf for PDF, jszip for DOCX and PPTX, @cantoo/pdf-lib for the
// pages of a PDF.
//
//   npm install
//   npm run build
//   GEMINI_API_KEY=... node examples/server.ts      →  http://localhost:3000
//
// GEMINI_MODEL picks the model. GEMINI_EXPLORER_MODEL is optional: a second model that searches
// and reads the files, so that GEMINI_MODEL only writes the answer.
//
// Runs on Node 22.18+ or 24 (built-in TypeScript type stripping).
import { createServer, type IncomingMessage } from "node:http";
import { setInterval } from "node:timers";
import { createLargeFiles, DocumentStoreError, errorKindOf, FileDocumentStore, partialResultOf, type ToolTurn } from "llm-large-files";
import { askGemini, DocumentsNotFoundError, geminiApi, type ChatTurn } from "llm-large-files/gemini";
import { createDocumentHandlers } from "llm-large-files/node";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Set GEMINI_API_KEY.");
const endpoint = geminiApi({
  apiKey,
  model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
  // Unset or empty, there is no explorer: the one model searches, reads and answers.
  explorerModel: process.env.GEMINI_EXPLORER_MODEL,
});

// keepOriginals lets the model look at the pages of an uploaded PDF (charts, photos, scans). It
// needs the optional dependency @cantoo/pdf-lib, and keeps each PDF on disk until it expires.
const files = createLargeFiles({ store: new FileDocumentStore(".data/large-files"), keepOriginals: ["pdf"] });
// An expired document, and its PDF, stay on disk until they are looked up again or swept.
setInterval(() => files.sweep().catch(console.error), 60 * 60 * 1000).unref();
// In a real app, return the signed-in user's ID so uploads stay private to them.
const getOwner = (_request: IncomingMessage) => undefined;
const documents = createDocumentHandlers(files, { getOwner });

type ChatBody = { messages: Array<ChatTurn | ToolTurn>; documentIds: string[] };

async function json(request: IncomingMessage): Promise<ChatBody> {
  // Decoded once, whole: a character split between two chunks would otherwise be lost.
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** What to tell the user. The provider's own message is for the server's log. */
function userMessage(error: unknown): string {
  if (error instanceof DocumentsNotFoundError) return "A file expired. Attach it again.";
  if (error instanceof DocumentStoreError) return "The files could not be read just now. Try again.";
  switch (errorKindOf(error)) {
    case "context_overflow": return "This chat is too long for the model. Start a new chat, or ask about fewer files.";
    case "rate_limit": return "The model is busy. Try again in a minute.";
    case "quota": return "The model is not available right now.";
    case "timeout": return "The model took too long to answer. Try again.";
    case "unreachable":
    case "server": return "The model could not answer just now. Try again.";
    default: return "Something went wrong. The server's log says what.";
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && url.pathname === "/api/documents") return documents.upload(request, response);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/documents/")) {
    return documents.remove(request, response, url.pathname.split("/").pop()!);
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    let body: ChatBody;
    try {
      body = await json(request);
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ error: "Send JSON: { messages, documentIds }." }));
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (name: string, data: unknown) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    try {
      const owner = getOwner(request);
      const result = await askGemini({
        files, endpoint, messages: body.messages, documentIds: body.documentIds,
        ...(owner ? { owner } : {}),
        signal: controller.signal,
        onText: (text) => event("text", text),
        onActivity: (text) => event("activity", text),
        onStep: (text) => event("step", text),
      });
      // The page keeps toolTurns with the conversation: a follow-up question then needs no new search.
      event("done", { answered: result.answered, toolTurns: result.toolTurns, usage: result.usage });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(error);
        // What the question found before it failed is kept too, so asking again does not search again.
        event("error", { message: userMessage(error), toolTurns: partialResultOf(error)?.toolTurns ?? [] });
      }
    }
    return response.end();
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(PAGE);
}).listen(3000, () => console.log("Open http://localhost:3000"));

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>llm-large-files demo</title>
<style>body{font:15px system-ui;max-width:760px;margin:40px auto;padding:0 16px}#log{white-space:pre-wrap}
.step{color:#666;font-size:13px}.status{color:#888;font-style:italic}input,button{font:inherit}</style>
<h1>Ask about a large file</h1>
<p><input type="file" id="file"> <span id="info"></span></p>
<p><input id="question" size="60" placeholder="What does this file say about…?"> <button id="ask">Ask</button></p>
<div id="steps"></div><p class="status" id="status"></p><div id="log"></div>
<script>
let documentIds = [];
const history = [];
file.onchange = async () => {
  const chosen = file.files[0];
  info.textContent = "Uploading…";
  const response = await fetch("/api/documents", { method: "POST", body: chosen,
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(chosen.name) } });
  const result = await response.json();
  if (!response.ok) { info.textContent = result.error; return; }
  documentIds = [result.id];
  info.textContent = result.format + " · " + result.lines.toLocaleString() + " lines · ~" + result.estimatedTokens.toLocaleString() + " tokens";
};
ask.onclick = async () => {
  const asked = { role: "user", text: question.value };
  steps.innerHTML = ""; log.textContent = ""; status.textContent = "";
  const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [...history, asked], documentIds }) });
  if (!response.ok) { status.textContent = "Error: " + (await response.json()).error; return; }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", answer = "", answered = false, toolTurns = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\\n\\n")) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const name = block.match(/^event: (.*)$/m)[1], data = JSON.parse(block.match(/^data: (.*)$/m)[1]);
      if (name === "text") { answer += data; log.textContent = answer; status.textContent = ""; }
      if (name === "activity") status.textContent = data;
      if (name === "step") steps.insertAdjacentHTML("beforeend", "<div class=step>✓ " + data.replace(/</g, "&lt;") + "</div>");
      if (name === "error") { status.textContent = "Error: " + data.message; toolTurns = data.toolTurns; }
      if (name === "done") {
        answered = data.answered; toolTurns = data.toolTurns;
        status.textContent = answered
          ? data.usage.requests + " model requests · " + data.usage.inputTokens.toLocaleString() + " input tokens"
          : "No answer this time. Ask again, or ask more precisely.";
      }
    }
  }
  // The question and its tool rounds are kept, the answer only when there is one: the model would
  // read an error message as its own words.
  history.push(asked, ...toolTurns);
  if (answered) history.push({ role: "model", text: answer });
};
</script>`;
