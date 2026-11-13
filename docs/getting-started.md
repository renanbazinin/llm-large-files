# Integration guide

This guide adds large-file support to an existing chatbot backend in four steps. The examples use
Express and Gemini, with notes for other setups.

## 1. Install

```bash
npm install llm-large-files
npm install jszip unpdf        # optional: DOCX/PPTX and PDF support
npm install @cantoo/pdf-lib    # optional: let the model look at pages of a PDF (pictures, charts)
```

## 2. Create the library once

```ts
// large-files.ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.LARGE_FILES_DIR ?? "./data/large-files"),
  // Your connector's real limits. Anything left out uses the defaults in docs/configuration.md.
  budget: { contextTokens: 1_000_000, maxRequestBytes: 10_000_000 },
  ttlMs: 72 * 60 * 60 * 1000,      // keep uploads for 3 days
  maxUploadBytes: 100 * 1024 * 1024,
  // Optional: keep uploaded PDFs, so the model can look at their pages (see "Pictures" below).
  // keepOriginals: ["pdf"],
});

// Reclaim disk space from expired uploads (expired files are already ignored on read).
setInterval(() => void files.sweep(), 60 * 60 * 1000).unref();
```

Running several server instances? Give them a shared store. Use a shared disk, or implement
`DocumentStore` over Redis, S3, or your database (see [configuration](configuration.md#stores)).

## 3. Accept uploads

```ts
import express from "express";
import { createDocumentHandlers } from "llm-large-files/node";

const app = express();
const documents = createDocumentHandlers(files, {
  // Uploads become private to this user. Return undefined to allow anonymous use.
  getOwner: (req) => (req as any).user?.id,
});

// Mount before express.json(): the body is the raw file, not JSON.
app.post("/api/documents", documents.upload);
app.get("/api/documents/:id", (req, res) => documents.get(req, res, req.params.id));
app.delete("/api/documents/:id", (req, res) => documents.remove(req, res, req.params.id));
app.use(express.json());
```

The response is a `DocumentSummary`:

```json
{ "id": "doc_3f9c…", "name": "app.log", "mimeType": "text/plain", "format": "log",
  "bytes": 5082044, "lines": 60000, "estimatedTokens": 1270511, "expiresAt": "2026-11-09T07:43:14.435Z" }
```

Errors are JSON `{ "error": "…" }`: 400 when there's no file name, 413 when the file is too large,
422 for an unreadable file (binary, empty, a zip bomb, or a scanned PDF that cannot be shown page by
page), and 500 when the server fails, as when the store's disk is full. `getOwner` can refuse a
request by throwing an error with a `status`, such as 401 (see the [API reference](api.md)).

**Other servers.** The handlers take Node's `IncomingMessage` / `ServerResponse`, so they work with
`node:http`, Express, Koa (`ctx.req`, `ctx.res`), Fastify (`request.raw`, `reply.raw`), and Next.js
API routes on the Node runtime. Not using Node HTTP? Call `files.ingest({ name, mimeType, bytes, owner })`
yourself and return `toDocumentSummary(meta)`.

### Browser

```ts
async function uploadLargeFile(file: File) {
  const response = await fetch("/api/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Type": file.type,
    },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result; // keep result.id with the conversation
}
```

**Which files should go to the server?** Anything your current inline path can't handle. A
practical rule is text over about 512 KB and PDFs over about 7 MB (base64 makes them about a
third bigger). Smaller files can keep your existing path. PDFs under your payload limit are better
sent inline, because Gemini then reads every page with its layout and images. For larger PDFs,
turn on `keepOriginals` (below) so the model can ask for the pages it needs.

## 4. Answer questions

### With Gemini or Vertex AI: `askGemini`

```ts
import { askGemini, DocumentsNotFoundError, geminiApi } from "llm-large-files/gemini";

const endpoint = geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.8-flash" });

app.post("/api/chat", async (req, res) => {
  const { messages, documentIds } = req.body; // messages: [{ role: "user" | "model", text }]
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    await askGemini({
      files, endpoint, messages, documentIds,
      owner: (req as any).user?.id,
      system: "You are our support assistant.",
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      signal: abort.signal,
      onText: (text) => send("text", text),            // answer, streamed
      onActivity: (text) => send("activity", text),    // "Searching app.log for “timeout”…"
      onStep: (text) => send("step", text),            // "Search app.log … — 12 matching lines"
    });
    send("done", {});
  } catch (error) {
    send("error", error instanceof DocumentsNotFoundError
      ? "A file has expired. Please attach it again."
      : String((error as Error).message));
  }
  res.end();
});
```

What `askGemini` does each turn:

1. Measures the rest of the request (history, system prompt, other files).
2. Plans the documents against your budget. Each one goes in whole, or becomes a card plus tools.
3. Adds each document's text or card at the start of the first user message, where it stays for
   the whole conversation (so follow-up questions reuse Gemini's prompt cache), and a short tool
   guide to the system prompt.
4. Runs the tool loop if needed (up to `limits.toolTurns` requests, default 12). If the model keeps
   searching, the last request is sent without tools so it has to answer. `result.answered` is
   `false` in the rare case that there is still no answer (a blocked prompt, or an empty reply).
5. Sends a request again when the model was busy or could not be reached, keeps the request
   inside the model's window as tool results add up, and returns what the question used
   (`result.usage`) and what it read (`result.evidence`).

`askGemini` is `askWithFiles` with a Gemini model. Everything it does, it does for
[any other model](#with-another-model-askwithfiles) too.

**Vertex AI:**

```ts
import { GoogleAuth } from "google-auth-library";
import { vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const endpoint = vertexAi({
  project: "my-project",
  location: "global",               // or "us", "eu", "europe-west4", …
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
});
```

**An enterprise gateway** that proxies Generate Content:

```ts
const endpoint = {
  url: "https://llm-gateway.corp.example/gemini/models/gemini-3.8-flash:generateContent",
  streamUrl: "https://llm-gateway.corp.example/gemini/models/gemini-3.8-flash:streamGenerateContent?alt=sse", // optional
  headers: { Authorization: `Bearer ${process.env.GATEWAY_TOKEN}`, "Content-Type": "application/json" },
};
```

Without `streamUrl`, answers arrive in one piece (and `onText` fires once).

**Existing Gemini history.** If your chat already stores Gemini `contents` (with images or inline
PDFs), pass `contents` instead of `messages`; document text is added at the start of the first user turn.

**A second model for the searching (optional).** The model you name does both halves of the work:
it searches and reads a large file, and it answers. `explorerModel` gives the first half to another
model, for example a cheaper one, and `model` then only writes the answer:

```ts
const endpoint = geminiApi({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.8-flash",
  explorerModel: process.env.GEMINI_EXPLORER_MODEL, // unset or empty: one model does both
});
```

`vertexAi()` takes it the same way, and an endpoint of your own takes the explorer's URL as
`explorerUrl`. What each model gets, and what it costs, is in
[An explorer model](configuration.md#an-explorer-model).

### Pictures, charts and scans in PDFs

The text of a PDF does not hold its pictures. To let the model look at a page when the text is not
enough, install `@cantoo/pdf-lib` and keep the uploaded PDFs:

```ts
export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"],
});
```

`askGemini` needs no change. It offers the model a tool, `view_pages`, and sends the pages it asks
for (up to five a call) as a small PDF. A look shows up among the steps:

```
✓ Look at report.pdf pages 12-14
```

With originals kept, a scanned PDF of up to 30 pages is accepted too, and read page by page.
Kept files take disk space until they expire, which is why this is off by default. The limits, the
costs and the measurements are in [Pictures in PDFs](configuration.md#pictures-in-pdfs), and what
to think about before turning it on in [Security](security.md#original-files).

### With another model: `askWithFiles`

The loop is not Gemini's. `askWithFiles` takes the model as an adapter, and two adapters come with
the package next to Gemini's:

```ts
import { askWithFiles, DocumentsNotFoundError, ModelRequestError } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";
import { anthropic } from "llm-large-files/anthropic";

// Any Chat Completions endpoint: OpenAI, Azure OpenAI, DeepSeek, LiteLLM, vLLM, Ollama, OpenRouter.
const model = openAiCompatible({
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-pro",
  contextTokens: 1_000_000,          // the budget of a question follows it
  body: { temperature: 0.3 },
});

// Or Claude:
const claude = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-5-5", fallbacks: "default" });

const result = await askWithFiles({
  files, model, documentIds, messages,
  owner: req.user?.id,
  system: "You are our support assistant.",
  signal: abort.signal,
  onText: (text) => send("text", text),
  onActivity: (text) => send("activity", text),
  onStep: (text) => send("step", text),
});
```

`messages` are `{ role: "user" | "assistant", text }`. A turn that holds more than text takes
parts, with anything but text in the provider's own form:
`{ role: "user", parts: [{ text: "What is in this picture?" }, { native: { type: "image_url", image_url: { url } } }] }`.

**Two models, of two providers.** `explorer` is a second adapter. It makes the tool calls and
reads whole files in parts, and `model` writes the answer from what the tools returned:

```ts
await askWithFiles({ files, model: claude, explorer: model, documentIds, messages });
```

**Errors.** A model's HTTP error is a `ModelRequestError` with a `status` (0 when the model could
not be reached). It reaches you after the request was tried again, when another try could have
helped.

**A model without an adapter** needs one object with a `send` method:
[your own adapter](api.md#your-own-adapter). `files.prepare()` and `files.tools()` are still there
for a loop that is all your own; `view_pages` in such a loop is described in
[Your own loop](configuration.md#your-own-loop).

## Keeping the conversation working

- Send the **full history** each turn when files are attached. The plan is recomputed each time,
  because the history grows. Stateful APIs that keep history server-side (such as Gemini
  Interactions with `previous_interaction_id`) don't mix with per-turn planning.
- Keep the document IDs with the conversation, not with one message. Pass all of them on every turn.
- Keep **what a question read** with the conversation too. `result.toolTurns` is plain JSON: store
  it between the question and its answer, and pass it back in `messages` in that place. The model
  then sees its earlier searches and reads, and a follow-up question often needs no new one. In a
  live check a follow-up took one request instead of three.

  ```ts
  const messages = history.flatMap((turn) => [
    { role: "user", text: turn.question }, ...turn.toolTurns, { role: "assistant", text: turn.answer },
  ]).concat({ role: "user", text: newQuestion });
  ```

  If your history is Gemini `contents`, `geminiToolTurns(result.toolTurns)` gives the rounds in
  that form.
- `result.evidence` lists, for each tool call, the document and the lines or pages the model was
  shown. Store it with the answer if you want to show sources, or to check a citation later.
- Expired documents raise `DocumentsNotFoundError` (with `.ids`). Ask the user to attach them again.
  A store that could not be read raises `DocumentStoreError` instead: the documents are still
  there, so retry the request. With `ttlMs: Infinity` documents do not expire at all.

## Run the demo

```bash
git clone https://github.com/renanbazinin/llm-large-files && cd llm-large-files
npm install && npm run build
GEMINI_API_KEY=... node examples/server.ts          # http://localhost:3000
GEMINI_API_KEY=... node examples/ask-cli.ts big.log "What failed first?"
```

The examples need Node 22.18+ or 24 to run TypeScript directly.
