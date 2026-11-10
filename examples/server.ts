// A complete chat server for large files in one file, with no dependencies beyond this package:
// upload endpoint, streaming answers over Server-Sent Events, and a minimal web page.
//
//   npm run build
//   GEMINI_API_KEY=... node examples/server.ts      →  http://localhost:3000
//
// Runs on Node 22.18+ or 24 (built-in TypeScript type stripping).
import { createServer, type IncomingMessage } from "node:http";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { askGemini, DocumentsNotFoundError, geminiApi, type ChatTurn } from "llm-large-files/gemini";
import { createDocumentHandlers } from "llm-large-files/node";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Set GEMINI_API_KEY.");
const endpoint = geminiApi({ apiKey, model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash" });

// keepOriginals lets the model look at the pages of an uploaded PDF (charts, photos, scans). It
// needs the optional dependency @cantoo/pdf-lib, and keeps each PDF on disk until it expires.
const files = createLargeFiles({ store: new FileDocumentStore(".data/large-files"), keepOriginals: ["pdf"] });
// In a real app, return the signed-in user's ID so uploads stay private to them.
const getOwner = (_request: IncomingMessage) => undefined;
const documents = createDocumentHandlers(files, { getOwner });

async function json(request: IncomingMessage): Promise<{ messages: ChatTurn[]; documentIds: string[] }> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && url.pathname === "/api/documents") return documents.upload(request, response);
  if (request.method === "DELETE" && url.pathname.startsWith("/api/documents/")) {
    return documents.remove(request, response, url.pathname.split("/").pop()!);
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    const { messages, documentIds } = await json(request);
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (name: string, data: unknown) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    try {
      const owner = getOwner(request);
      await askGemini({
        files, endpoint, messages, documentIds,
        ...(owner ? { owner } : {}),
        signal: controller.signal,
        onText: (text) => event("text", text),
        onActivity: (text) => event("activity", text),
        onStep: (text) => event("step", text),
      });
      event("done", {});
    } catch (error) {
      const message = error instanceof DocumentsNotFoundError
        ? "A file expired. Attach it again."
        : error instanceof Error ? error.message : String(error);
      if (!controller.signal.aborted) event("error", message);
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
  history.push({ role: "user", text: question.value });
  steps.innerHTML = ""; log.textContent = "";
  const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history, documentIds }) });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", answer = "";
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
      if (name === "error") status.textContent = "Error: " + data;
      if (name === "done") status.textContent = "";
    }
  }
  history.push({ role: "model", text: answer });
};
</script>`;
