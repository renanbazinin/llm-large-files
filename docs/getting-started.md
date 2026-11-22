# Getting started

This page takes you from `npm install` to a first answer about a file, then through the steps of
adding the library to an app. Each step is short and links to the guide that explains it.

## Install

```bash
npm install llm-large-files
```

The library needs Node.js 20.19 or later. It is an ES module, and its TypeScript types come with
it. From CommonJS code, `require("llm-large-files")` works on the Node versions that load ES
modules with `require()` by default: 20.19 and later in Node 20, 22.12 and later, and 23 and later.
On Node 21 and on 22.0 to 22.11, load it with `import("llm-large-files")`.

Text, Markdown, logs, JSON and CSV need nothing more. Three optional packages add the rest:

```bash
npm install jszip unpdf @cantoo/pdf-lib        # Node 24 and later
npm install jszip unpdf@1 @cantoo/pdf-lib      # Node 22
npm install jszip unpdf@1.7.0 @cantoo/pdf-lib  # Node 20
```

| Package | What it enables |
| --- | --- |
| `jszip` | DOCX, PPTX and XLSX files. |
| `unpdf` | PDF files: their text, with tables rebuilt as rows. |
| `@cantoo/pdf-lib` | The model can look at the pages of a PDF (`view_pages`, with `keepOriginals`). The text of a PDF also marks the pages that show a picture. |

Without the package a format needs, its upload fails with an error that names the package, such
as `Reading PDF files needs the optional dependency "unpdf".` Install `@cantoo/pdf-lib` before you
turn on `keepOriginals`: without it, every look at a page fails. The details are in
[PDFs](./guides/pdfs.md).

On Node 24 and later, `npm install unpdf` installs unpdf 2, which asks for Node 24. On Node 22,
install `unpdf@1`, and on Node 20, `unpdf@1.7.0`. An unpdf that cannot read PDFs on your version
of Node is refused at the first PDF, with a message that says what to install, such as
`The unpdf installed cannot read PDF files on Node 20 (…). Install unpdf 1.7.0 (npm install unpdf@1.7.0), or run Node 22 or later.`

The Vertex AI samples on this page also use Google's auth library, which is not a dependency of
this package:

```bash
npm install google-auth-library
```

## Quickstart

This script ingests one file and asks one question about it, with Gemini on Vertex AI. You need a
Google Cloud project with Vertex AI turned on, and Application Default Credentials (on your own
machine, `gcloud auth application-default login`).

```ts
// quickstart.mts
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { GoogleAuth } from "google-auth-library";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";

const [path, question] = process.argv.slice(2);
if (!path || !question) throw new Error('Usage: node quickstart.mts <file> "<question>"');

// 1. The library. This one keeps documents in memory, for as long as the process runs.
const files = createLargeFiles({ store: new MemoryDocumentStore() });

// 2. Ingest the file: its text is extracted, measured and stored.
const doc = await files.ingest({ name: basename(path), bytes: await readFile(path) });
console.log(`${doc.name}: ${doc.format}, ${doc.lines} lines, about ${doc.estimatedTokens} tokens\n`);

// 3. Ask. The access token comes from Application Default Credentials.
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global", // the default; or "us", "eu", or a region such as "europe-west4"
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
});

const result = await askGemini({
  files,
  endpoint,
  documentIds: [doc.id],
  messages: [{ role: "user", text: question }],
  onText: (delta) => process.stdout.write(delta), // the answer, as it streams
});

console.log(`\n\n${result.plan.inline.length > 0 ? "Read whole" : "Searched with tools"}, ${result.turns} chat request(s)`);
for (const step of result.steps) console.log(`- ${step}`);
```

Node 22.18 and later in Node 22, and Node 23.6 and later, run TypeScript files directly:

```bash
GOOGLE_CLOUD_PROJECT=your-project-id node quickstart.mts ./app.log "What failed first, and when?"
```

In PowerShell, set the variable with `$env:GOOGLE_CLOUD_PROJECT = "your-project-id"`, then run
`node quickstart.mts ./app.log "What failed first, and when?"`. On older versions of Node, compile
the file first, with `typescript` and `@types/node` installed:
`npx tsc --module nodenext --target es2022 quickstart.mts`. Then run `node quickstart.mjs` with
the same arguments.

What happened:

- `ingest` extracted the text of the file, counted its lines and estimated its tokens, and stored
  it. The `doc.id` it returned is how you name the document from then on.
- `askGemini` planned the request. A document that fits the budget goes into the prompt whole: by
  default up to 200,000 tokens of document text, in a window of 1,000,000 tokens and a request of
  10 MB. A larger one becomes a short card, and the model gets tools to search it, read lines of
  it, get an overview of it, and read it whole in parts.
- When the model used tools, the loop ran its calls and sent it what they returned, until it
  answered: at most 12 chat requests by default, the last of which must be answered in text, and
  one more when that answer comes back without text. `result.steps` lists what it did, for example
  `Search app.log (exact) for “timeout” — 12 matching lines`.

The details of the plan and the loop are in [How it works](./how-it-works.md).

The quickstart works the same with other providers. Each sample below replaces its step 3, from
`const auth` to the end of the `askGemini` call. Put the sample's imports in place of the two
Vertex AI imports, those of `google-auth-library` and `llm-large-files/gemini`.

### With a Gemini API key

`askGemini` takes the Gemini Developer API with an API key:

```ts
import { askGemini, geminiApi } from "llm-large-files/gemini";

const result = await askGemini({
  files,
  endpoint: geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.8-flash" }),
  documentIds: [doc.id],
  messages: [{ role: "user", text: question }],
  onText: (delta) => process.stdout.write(delta),
});
```

### With an OpenAI-compatible model

`askGemini` is `askWithFiles` with a Gemini model. With any other model, call `askWithFiles` and
pass the model as an adapter. `openAiCompatible()` speaks Chat Completions: OpenAI, Azure OpenAI,
DeepSeek, OpenRouter, vLLM, Ollama, LiteLLM, llama.cpp.

```ts
import { askWithFiles } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";

const model = openAiCompatible({
  baseUrl: "https://api.openai.com/v1", // the default; DeepSeek, OpenRouter, vLLM, Ollama: their own
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5.5",
  contextTokens: 400_000, // your model's context window: the plan follows it
});

const result = await askWithFiles({
  files,
  model,
  documentIds: [doc.id],
  messages: [{ role: "user", text: question }],
  onText: (delta) => process.stdout.write(delta),
});
```

Set `contextTokens` to the window of your model. Without it, the plan assumes the library's
window, 1,000,000 tokens unless you set another. The recipe for each server is in
[OpenAI-compatible endpoints](./guides/openai-compatible.md).

### With Claude

```ts
import { askWithFiles } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";

const model = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-5-5",
  contextTokens: 1_000_000, // your model's context window: the plan follows it
});

const result = await askWithFiles({
  files,
  model,
  documentIds: [doc.id],
  messages: [{ role: "user", text: question }],
  onText: (delta) => process.stdout.write(delta),
});
```

Thinking, streaming and gateways for Claude are in [Claude](./guides/anthropic.md).

## Integrate it into your app

The quickstart holds everything in one process for one question. An app creates the library once,
takes uploads in one request and questions in others, and keeps the conversation between them.
The samples below use Gemini on Vertex AI. With another provider, use `askWithFiles` as above:
the options these samples use are the same, with `model` in place of `endpoint`. Model settings
that `askGemini` takes (`generationConfig`, `toolFilePlacement`, the waits) are options of the
adapter there.

### 1. Create the library once

Create the library and the endpoint when the server starts, and share them between requests.

```ts
// large-files.ts: created once, when the server starts, and shared by every request.
import { GoogleAuth } from "google-auth-library";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { vertexAi } from "llm-large-files/gemini";

export const files = createLargeFiles({
  // Text extracted from uploads is kept here. Several servers need one shared store.
  store: new FileDocumentStore(process.env.LARGE_FILES_DIR ?? "./data/large-files"),
  // The context window of the model that answers (1,000,000 is the default). The rest follows it.
  budget: { contextTokens: 1_000_000 },
});

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
export const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
});

// An expired document is ignored at once. This frees the space it took.
setInterval(() => {
  files.sweep().catch((error) => console.error("sweep failed", error));
}, 60 * 60 * 1000).unref();
```

Documents are kept for 72 hours (`ttlMs`), and uploads are taken up to 100 MB
(`maxUploadBytes`). To let the model look at the pages of a PDF, add `keepOriginals: ["pdf"]`
([PDFs](./guides/pdfs.md)). Every option is in the
[library reference](./reference/library.md#largefilesoptions).

Where the documents live is up to your app: a shared volume for `FileDocumentStore`, or a store of
your own over your database or object storage, laid out per user and per chat session. See
[Storage](./guides/storage.md), and [Deployment](./guides/deployment.md) for several servers.
Vertex AI settings for production (credentials, location, quotas) are in
[Gemini and Vertex AI](./guides/vertex-and-gemini.md).

### 2. Accept uploads

`createDocumentHandlers` gives you upload, get and delete handlers for any Node HTTP server:
`node:http`, Express, Fastify (`request.raw`, `reply.raw`), and Next.js API routes on the Node
runtime (Fastify and Next.js need a step first: see
[Web app](./guides/web-app.md#mount-them-in-plain-nodehttp)).

```ts
import express from "express";
import { createDocumentHandlers } from "llm-large-files/node";
import { files } from "./large-files.js";

const app = express();
const documents = createDocumentHandlers(files, {
  // Uploads become private to this user. undefined: anonymous. currentUserId is your auth.
  getOwner: (request) => currentUserId(request),
});

// Before any body parser: the body of an upload is the raw file.
app.post("/api/documents", documents.upload);
app.get("/api/documents/:id", (req, res) => documents.get(req, res, req.params.id));
app.delete("/api/documents/:id", (req, res) => documents.remove(req, res, req.params.id));
app.use(express.json());
```

The browser posts the raw file, with its name in an `X-File-Name` header (URI-encoded). The
response is a `201` with a `DocumentSummary`: `id`, `name`, `format`, `lines`, `estimatedTokens`,
`expiresAt` and more. A text file that was not valid UTF-8 also has `encoding`, the older encoding
it was read in (`"windows-1255"`), or `replacedCharacters`, the characters stored as �, or both.
Keep the `id` with the chat session. Not on a Node HTTP server, or taking multipart forms? Call
`files.ingest({ name, mimeType, bytes, owner })` yourself and return `toDocumentSummary(meta)`.

`getOwner` returns the signed-in user's ID, or `undefined` for an anonymous upload. An empty
string, a string of spaces or `null` would be one owner shared by every caller without a user, so
the upload is refused: `500` with `{ "error": "Upload failed (empty owner)." }`. Return the ID
itself, not the user object (`{ "error": "Upload failed (owner is not a string)." }`). Both come
before the body is read.

The browser side, every status and other servers are in [Web app](./guides/web-app.md); the
routes in full are in the [node reference](./reference/node.md).

### 3. Ask with the user's history, and stream the answer

Send the whole conversation on every turn, with all the documents of the session. The plan is made
again for each question, because the history grows.

```ts
// chat.ts
import type { ChatTurn, ToolTurn } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";
import { endpoint, files } from "./large-files.js";

// A chat session as your app stores it: who owns it, its documents, and its turns.
export type Session = { userId: string; documentIds: string[]; turns: StoredTurn[] };
export type StoredTurn = { question: string; toolTurns: ToolTurn[]; answer: string };

export async function ask(session: Session, question: string, send: (event: string, data: unknown) => void, signal: AbortSignal) {
  // The whole history, on every turn, with the tool rounds of each earlier question in its place.
  const messages: Array<ChatTurn | ToolTurn> = session.turns.flatMap((turn): Array<ChatTurn | ToolTurn> => [
    { role: "user", text: turn.question },
    ...turn.toolTurns,
    { role: "assistant", text: turn.answer },
  ]);
  messages.push({ role: "user", text: question });

  const result = await askGemini({
    files,
    endpoint,
    messages,
    documentIds: session.documentIds, // every document of the session, on every turn
    owner: session.userId,
    signal,
    onText: (delta) => send("text", delta),       // the answer, as it streams
    onActivity: (text) => send("activity", text), // short-lived: "Search app.log (keywords) for “timeout”…"
    onStep: (text) => send("step", text),         // done: "Search app.log (exact) for “timeout” — 12 matching lines"
  });

  if (!result.answered) {
    send("error", "No answer came back. Please ask again.");
    return;
  }
  // Keep what the question read with its answer: the next question starts from it.
  session.turns.push({ question, toolTurns: result.toolTurns, answer: result.text });
  send("done", {});
}
```

- The last message must be the user's question. `"model"` is accepted for `"assistant"`.
- `owner` must be the owner the documents were uploaded with. A document of another owner is
  treated as missing.
- `send` stands for your transport: in a web app, a Server-Sent Event. The answer streams when
  `onText` is set and the endpoint has a stream URL, as `vertexAi()` and `geminiApi()` do.
- Show the steps and activity lines as plain text, never as markdown or HTML: they quote what the
  model sent, which a file can steer ([Security](./security.md#what-the-library-logs)).
- Abort `signal` when the client goes away, so the question stops.
- `answered` is `false` when the model's last turn had no text: a blocked prompt, a reply cut off,
  or a tool call that could not be read. An answer that comes back empty, or with a tool call in
  place of the text, is asked for once more first. Show your own message then.

The route, the browser side and cancelling are in [Web app](./guides/web-app.md). To have a
second, cheaper model search the files while this one writes the answer, add `explorerModel` to
`vertexAi()`: see [An explorer model](./guides/explorer-model.md).

### 4. Keep `toolTurns` with the answer

`result.toolTurns` holds the tool calls of the question and what they returned, as plain JSON.
Store it with the answer, and put it back between the question and the answer, as `ask()` does
above. The model then sees what it found before, and a follow-up question often needs no new
search. A call whose result is still in the conversation in full is not run again: the model gets
a pointer to it, and the step ends with `— already shown above`.

Storing history across servers, keeping it inside the window, and converting history that is in a
provider's own form are in [Conversations](./guides/conversations.md).

### 5. Handle errors

Before a question fails, the loop sends a failed request again when a wait can mend it, recovers
from a request too large, and asks once more after an empty or unreadable turn
([Errors and reliability](./guides/errors-and-reliability.md)). What still fails is thrown:

```ts
import { DocumentsNotFoundError, DocumentStoreError, errorKindOf, partialResultOf } from "llm-large-files";
import { ask } from "./chat.js";

// session, question, send and signal: as in step 3.
try {
  await ask(session, question, send, signal);
} catch (error) {
  if (!signal.aborted) send("error", messageFor(error)); // after an abort, no one is listening
  // What a failed question had found and used, or undefined.
  const partial = partialResultOf(error);
  if (partial) console.warn(`The failed question used ${partial.usage.inputTokens} input tokens`);
}

function messageFor(error: unknown): string {
  if (error instanceof DocumentsNotFoundError) return "A file is no longer available. Please attach it again.";
  if (error instanceof DocumentStoreError) return "Your files could not be read just now. Please try again.";
  switch (errorKindOf(error)) {
    case "quota":
      return "The assistant is not available right now. Please tell support.";
    case "rate_limit":
      return "The assistant is busy. Please try again in a minute.";
    case "auth":
    case "invalid":
      return "The assistant is not set up correctly. Please tell support.";
    case "context_overflow":
      return "This conversation is too long for the model. Please start a new chat.";
    case undefined:
      return "Something went wrong. Please try again.";
    default:
      return "The model did not answer. Please try again.";
  }
}
```

- `DocumentsNotFoundError` (`.ids`): a document expired, was deleted, was never uploaded, or
  belongs to another owner. It is thrown before any model request.
- `DocumentStoreError`: the store could not be read just now. It does not mean the documents are
  gone: the same request may work a moment later.
- `ModelRequestError`: the model failed. `.kind` says how (`quota`, `rate_limit`, `timeout`,
  `unreachable`, `server`, `auth`, `invalid`, `context_overflow`), and `.status` is the HTTP
  status, or 0 when no answer came. `errorKindOf(error)` reads the kind of any error that has one.
- `partialResultOf(error)` gives the steps, `toolTurns` and `usage` of a question that failed
  under way, so you can still keep and count them.

What to tell the user for each case, and how to change the retries and the waits, are in
[Errors and reliability](./guides/errors-and-reliability.md).

### 6. Set limits

A question costs what its requests take in. These options bound it:

```ts
import { askGemini } from "llm-large-files/gemini";

// files, endpoint, messages and session: as in step 3.
const result = await askGemini({
  files,
  endpoint,
  messages,
  documentIds: session.documentIds,
  owner: session.userId,
  limits: {
    toolTurns: 8,          // chat requests for one question, the answer included; part reads not counted (default 12)
    inputTokens: 400_000,  // input tokens for one question, over all its requests (default: none)
  },
});
console.log(result.usage.inputTokens, result.usage.outputTokens, result.usage.requests);
```

- `budget.contextTokens` in `createLargeFiles` is the window the plan fits the request into. With
  `askWithFiles`, an adapter's `contextTokens` applies too, and the smaller wins.
- `limits` also takes `callsPerTurn` (default 8), `wholeDocumentReads` (default 1 per document)
  and `requests` (default: none). See [`AskLimits`](./reference/ask.md#asklimits). An answer that
  comes back without text is asked for once more, which can be one request past `toolTurns`; it is
  not made once `requests` or `inputTokens` is reached.
- `result.usage` is what the question used, in all and for each model: input, cached input, output
  and thought tokens, and requests. Store it per user or per session to count costs.

What costs most, and how to set the budget for each model, are in
[Costs and limits](./guides/costs-and-limits.md).

## Run the demo

The repository has two examples that run as they are, with a Gemini API key:

```bash
git clone https://github.com/renanbazinin/llm-large-files
cd llm-large-files
npm install
npm run build
GEMINI_API_KEY=... node examples/server.ts      # then open http://localhost:3000
GEMINI_API_KEY=... node examples/ask-cli.ts ./big.log "What failed first, and when?"
```

- `examples/server.ts` is a chat server in one file, on `node:http`: an upload route
  (`createDocumentHandlers`), answers streamed as Server-Sent Events, and a small web page. It
  stores uploads in `.data/large-files` and keeps PDFs, so the model can look at their pages.
  `GEMINI_MODEL` picks the model (default `gemini-3.8-flash`), and `GEMINI_EXPLORER_MODEL` adds an
  explorer model. Every upload is anonymous.
- `examples/ask-cli.ts` asks one question about one file from the command line. Two more
  arguments are optional: the model, and an explorer model.

Both need a Node that runs TypeScript directly: 22.18 and later in Node 22, or 23.6 and later.
Build first: the examples import
the package by name, which resolves to the repository's own `dist/`. `npm install` in the
repository also installs the optional packages, so every format works. In PowerShell, set the key
with `$env:GEMINI_API_KEY = "..."` and then run `node examples/server.ts`.

## Next steps

- [Gemini and Vertex AI](./guides/vertex-and-gemini.md): endpoints, access tokens, thinking,
  gateways, Vertex quotas and errors.
- [OpenAI-compatible endpoints](./guides/openai-compatible.md) and [Claude](./guides/anthropic.md):
  the other adapters.
- [An explorer model](./guides/explorer-model.md): a cheaper model that searches while another
  answers.
- [Web app](./guides/web-app.md): uploads, streaming over SSE, cancelling.
- [Conversations](./guides/conversations.md): history, `toolTurns`, converters.
- [Storage](./guides/storage.md): your own store, per user and per session.
- [Deployment](./guides/deployment.md): several servers, memory, proxies and timeouts.
- [Errors and reliability](./guides/errors-and-reliability.md) and
  [Costs and limits](./guides/costs-and-limits.md).
- [PDFs](./guides/pdfs.md): tables, pictures, scans and page views.
- [Your own adapter and loop](./guides/own-adapter-and-loop.md) and
  [Testing](./guides/testing.md).
- [How it works](./how-it-works.md), [Security](./security.md) and
  [Troubleshooting](./troubleshooting.md).
- [The documentation index](./README.md), with the reference for every export, and the
  [changelog](../CHANGELOG.md).
