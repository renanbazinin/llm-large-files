# llm-large-files

Let an LLM answer questions about **books, logs, and other files larger than its request limit or
context window**.

Your users upload a 50 MB log or a 900-page book. Your model connector accepts 10 MB per request
and 1M tokens of context. This package bridges the gap:

- **Files that fit** go into the prompt whole.
- **Files that don't** become a short summary card, and the model gets tools to **search**,
  **read line ranges**, or **read the whole file in parts** (map-reduce). Answers cite line numbers.
- **Pictures in a PDF** are not in its text. The model can **look at the real pages** when it
  needs to: a chart, a photo, a scan.

It's a small library, not a framework: no model SDK, no server, and no UI are required. One tool
loop, `askWithFiles`, works with any model through an adapter. Adapters for **Gemini and Vertex
AI**, **any OpenAI-compatible endpoint** and **Claude** are included, and so are Node HTTP handlers.

```bash
npm install llm-large-files
```

## Quickstart

With Gemini on Vertex AI, and an access token from Application Default Credentials
(`npm install google-auth-library`; on your own machine, `gcloud auth application-default login`):

```ts
import { readFile } from "node:fs/promises";
import { GoogleAuth } from "google-auth-library";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";

const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });

// When a user uploads a file:
const doc = await files.ingest({ name: "app.log", bytes: await readFile("./app.log") });

// When they ask about it:
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!, // asked for on each request
});
const result = await askGemini({
  files,
  endpoint,
  documentIds: [doc.id],
  messages: [{ role: "user", text: "What caused the outage, and when? Cite lines." }],
  onText: (delta) => process.stdout.write(delta), // optional: the answer as it streams
});
```

`result.steps` lists the tool calls in order, such as
`Search app.log (exact) for “failover” — 12 matching lines`, with the loop's own notices among
them (`Older tool results were shortened to make room in the request`). Show it under the answer so
users can see where the answer came from, as plain text: the steps quote what the model sent.

Using the **Gemini API** with a key, or an **enterprise gateway**? Swap the endpoint:

```ts
import { geminiApi, type GeminiEndpoint } from "llm-large-files/gemini";

const withKey = geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.8-flash" });

// Your own proxy of Generate Content. Its headers are sent exactly as given.
const viaGateway: GeminiEndpoint = {
  url: "https://llm-gateway.example.com/v1/gemini:generateContent",
  streamUrl: "https://llm-gateway.example.com/v1/gemini:streamGenerateContent?alt=sse", // without it, no streaming
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GATEWAY_KEY}` },
};
```

## Any model

`askGemini` is `askWithFiles` with a Gemini model. With another provider, name the model yourself:

```ts
import { askWithFiles } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";
import { anthropic } from "llm-large-files/anthropic";

// OpenAI, Azure OpenAI, DeepSeek, LiteLLM, vLLM, Ollama, OpenRouter: anything that speaks Chat Completions.
const deepseek = openAiCompatible({ baseUrl: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY!, model: "deepseek-v4-pro" });
// Claude. `fallbacks` lets another model answer when a safety classifier declines the request.
const claude = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-5-5", fallbacks: "default" });

const withClaude = await askWithFiles({
  files,               // `files` and `doc` are those of the quickstart
  model: claude,       // writes the answer
  explorer: deepseek,  // optional: a second model, of any provider, that searches and reads
  documentIds: [doc.id],
  messages: [{ role: "user", text: "What caused the outage, and when? Cite lines." }],
  onText: (delta) => process.stdout.write(delta),
});

withClaude.answered;  // false when the last reply had no text (a blocked prompt, a reply cut off before any text, a tool call that could not be read): show your own message
withClaude.usage;     // { requests: 5, inputTokens: 32662, cachedInputTokens: 6086, outputTokens: 750, thoughtTokens: 0, byModel: { … } }
withClaude.evidence;  // [{ tool: "read_document", documentId, document: "app.log", lines: [[34100, 34110]] }, …]
withClaude.toolTurns; // pass these back in `messages`, between this question and its answer: a follow-up then needs no new search
```

How to keep a chat's history, tool turns included, across requests and servers:
[Conversations](docs/guides/conversations.md).

Every model gets the same loop. A failed request is sent again when another try can help (a lost
connection, HTTP 408, 409, 429 or 5xx), never for a quota that ran out or once text was shown. With
the built-in adapters, a model silent for 10 minutes before its reply (`firstByteTimeoutMs`) or 5
minutes inside it (`idleTimeoutMs`) is cut off and asked once more. A request the provider refuses
as too large is made smaller, or the files are planned again for a window a little smaller than the
one it names. An empty first reply, an unreadable tool call, or an answer that comes back without
text is asked for again, a repeated call gets a pointer to the result already shown, and by default
each file is read whole at most once a question.

A question that fails throws `DocumentsNotFoundError` for a file that expired, was deleted, or
belongs to another `owner`, `DocumentStoreError` when the store cannot be read, or a
`ModelRequestError` whose `kind` (`"rate_limit"`, `"quota"`, `"timeout"`, `"context_overflow"`, …)
tells you what to show the user. `partialResultOf(error)` gives what it found and paid for:
[Errors and reliability](docs/guides/errors-and-reliability.md).

A model that has no adapter needs one object with an `id`, its `capabilities` (at least `toolFiles`
and `pageTokens`) and a `send` method, plus `generateText` to read whole files in parts:
[your own adapter](docs/guides/own-adapter-and-loop.md).

## Add it to a web app

```ts
import express from "express";
import { createDocumentHandlers } from "llm-large-files/node";

const app = express();
// `files` is the quickstart's. getOwner names the signed-in user (here, set on req.user by your
// auth middleware): each upload is then theirs alone.
const documents = createDocumentHandlers(files, {
  getOwner: (req) => (req as typeof req & { user?: { id: string } }).user?.id,
});
app.post("/api/documents", documents.upload); // mount before express.json(): the body is the raw file
app.get("/api/documents/:id", (req, res) => documents.get(req, res, req.params.id));
app.delete("/api/documents/:id", (req, res) => documents.remove(req, res, req.params.id));
```

The browser uploads the raw file (`file` comes from an `<input type="file">`):

```ts
const response = await fetch("/api/documents", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
  body: file,
});
const summary = await response.json(); // 201: { id, name, format, lines, estimatedTokens, expiresAt, … }; otherwise { error }
```

When the user asks, pass the upload's `id` in `documentIds` and the same user as `owner`: a document
that has an owner is missing for anyone else. This `getOwner` returns `undefined` for an anonymous
upload. Never return an empty string: it would be one owner shared by every caller without a user,
and the upload is answered 500. Streaming the answer and its progress to the browser, and
cancelling, are in the [web app guide](docs/guides/web-app.md). There's also a
[one-file demo server](https://github.com/renanbazinin/llm-large-files/blob/main/examples/server.ts) and a [command-line script](https://github.com/renanbazinin/llm-large-files/blob/main/examples/ask-cli.ts): from a
clone of this repository, run `npm install` and `npm run build`, then run them with Node 22.18 or a
later 22.x, or Node 23.6 or later.

**Uploads you do not trust.** These handlers read each upload in your server's process. Ingest
limits the text, the pages and the time of one file, refuses the zip bombs and the PDFs built to
hold a server that its checks recognize, and pauses for other requests between pages and slices of
its work. It does not refuse every file built to hurt a server. While a file is read, it takes
memory from your server's heap. Some steps run in one block, and no other request is answered
meanwhile. pdf.js reads one page of a PDF in one block: up to about 1.5 s for a page of a small
file that passes the page check, longer in a large file. `@cantoo/pdf-lib` reads one object of a
PDF in one block: about 0.1 to 0.2 s for each MB of a crafted array of numbers, which can take many
times the file's size in heap (400 to 930 MB for a file of 32 MB). If your users can upload files you do not
trust, ingest them in a child process with its own heap limit and timer, as
[Deployment](docs/guides/deployment.md#uploads-and-ingest) shows. What is refused, and what still
holds the server: [Security](docs/security.md#uploads).

## Pictures, charts and scans in PDFs

A large PDF goes to the model as text, and text cannot show a chart. Keep the uploaded PDFs, and
the model gets a tool, `view_pages`, that hands it the pages it asks for as a small PDF:

```bash
npm install unpdf @cantoo/pdf-lib  # Node 24; for Node 20 and 22, see Requirements
```

```ts
// In place of the quickstart's files:
const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"], // off by default: a kept file takes disk space until it expires and is swept
});
setInterval(() => files.sweep().catch(console.error), 60 * 60 * 1000).unref(); // removes expired documents and their files
// askGemini needs no change. A step then reads: Look at report.pdf pages 12-14
```

`unpdf` reads the text of a PDF, and `@cantoo/pdf-lib` cuts its pages. With `askWithFiles`,
`view_pages` is offered only when every model of the question can be sent a file: `gemini()` and
`anthropic()` can by default, `openAiCompatible()` only with `pdfInput: true`. So the question
above, with DeepSeek exploring, is not offered `view_pages` at all.

Asked which bar of a chart is tallest, `gemini-3.5-flash-lite` said from the text that it could
not see the chart; with `view_pages` it looked at the page and answered correctly. It did not look
at a page for any of ten questions that the text answers. On Gemini a page costs about 530 tokens;
`anthropic()` counts 3,500 for Claude by default. Scans, tables, limits: [PDFs](docs/guides/pdfs.md).

## One model to explore, another to answer

Your application chooses the model: it is the `model` of the endpoint, and the package has no
default. That model does both halves of the work on a large file. It explores the file (searches,
reads, looks at pages), and then it answers. You can name a second model for the first half:

```ts
// In place of the quickstart's endpoint:
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",                        // writes the answer
  explorerModel: process.env.GEMINI_EXPLORER_MODEL, // optional: searches and reads
  accessToken: async () => (await auth.getAccessToken())!, // `auth` is the quickstart's
});
```

Left out or empty, nothing changes: one model does both. With an explorer, the many requests of a
search through a large file go to that model, which can be a cheaper or faster one, and `model`
gets what the tools returned and writes the answer in one request. In eleven live checks with
`gemini-3.5-flash-lite` exploring, the other model answered every one correctly from what it found.
What each model gets, and what it costs: [An explorer model](docs/guides/explorer-model.md).

## What it handles

| | |
|---|---|
| **Formats** | Text, Markdown, logs (UTF-8 and UTF-16, and Hebrew, Arabic, Cyrillic, Japanese and Western European text in its older encoding), JSON/JSONL, CSV/TSV, DOCX, PPTX, PDF (text layer, with tables rebuilt so empty cells stay empty; pages with a picture are marked, and the model can look at the pages themselves; scans of up to 30 pages when PDFs are kept) |
| **Logs** | Detected automatically; the card shows level counts, the time range, and the most frequent errors grouped by shape (`timeout after <n>ms to <ip>`) |
| **Books and documents** | An outline of headings with line numbers, including Markdown, "Chapter 12", numbered sections, and Hebrew chapter titles |
| **Limits** | One budget covers tokens *and* request bytes, so files fit both your context window and your connector's payload limit. It assumes 1M tokens and 10 MB: set `budget.contextTokens` for your model's window (an adapter's `contextTokens` can only make it smaller) |
| **Reliability** | Retries, waits on a silent model, recovery from a request too large, error kinds: see [Errors and reliability](docs/guides/errors-and-reliability.md) |
| **Models** | Gemini and Vertex AI, any OpenAI-compatible endpoint, Claude, or an adapter of your own. Two models of different providers can share a question |
| **Cost** | Usage summed over every request of a question, for each model, with ceilings on whole-file reads, requests and input tokens |
| **Privacy** | Documents can belong to an `owner`; other users can't plan, read, or delete them |
| **Hostile uploads** | Limits on the text, pages and time of one file; zip bombs and PDFs built to exhaust a server are refused when the checks recognize them; ingest pauses for other requests between pages and slices. Not every hostile file is refused, parsing shares your server's heap, and some steps hold the server for a while: ingest untrusted uploads in a process of their own ([Security](docs/security.md#uploads)) |
| **Storage** | In memory, on disk with expiry, or your own store (Redis, S3, a database) |

## Live results

With `gemini-3.8-flash` on the Gemini API, a 5 MB log of about 1.27M tokens, over the 1M window,
got the right root cause of an outage, citing the right lines, in about 60 s over 11 tool calls.
Every live result with its date, model and setup, and what has not been run live, such as the
Claude adapter: [Measurements](docs/measurements.md).

## Documentation

- [Documentation index](docs/README.md): where to start, which entry point to use, a glossary, and every page in one line.
- [Getting started](docs/getting-started.md): install, a quickstart that runs, and the integration in short steps.

Guides, one task each:

- [Gemini and Vertex AI](docs/guides/vertex-and-gemini.md): endpoints, access tokens, thinking, whole-file reads, pages, gateways, Vertex quotas and errors.
- [OpenAI-compatible endpoints](docs/guides/openai-compatible.md): OpenAI, Azure OpenAI, DeepSeek, OpenRouter, vLLM, Ollama, LiteLLM, llama.cpp.
- [Claude](docs/guides/anthropic.md): setup, thinking, streaming, conversations that may only grow, gateways.
- [An explorer model](docs/guides/explorer-model.md): a cheaper model that explores the files while another answers.
- [Web app](docs/guides/web-app.md): uploads, answers and progress streamed over Server-Sent Events, cancelling.
- [Conversations](docs/guides/conversations.md): the history you keep, tool turns included, across requests and servers.
- [Storage](docs/guides/storage.md): the store contract, owners, a layout per user and per chat session, retention.
- [Deployment](docs/guides/deployment.md): several servers, memory, sweeps, proxies and timeouts for streams, upgrades.
- [Errors and reliability](docs/guides/errors-and-reliability.md): every error and what to show the user, retries, waits, deadlines.
- [Costs and limits](docs/guides/costs-and-limits.md): the limits of a question, the budget per model, usage per user or session.
- [PDFs](docs/guides/pdfs.md): formats and optional packages, tables, pictures, `view_pages`, scans, extractors and OCR.
- [Your own adapter or loop](docs/guides/own-adapter-and-loop.md): a model without an adapter, or a tool loop of your own.
- [Testing](docs/guides/testing.md): testing your integration without a real model.

Reference, one page per module:

- [`llm-large-files`: the library and its documents](docs/reference/library.md): `createLargeFiles`, stores, budget, extractors.
- [`llm-large-files`: the tool loop](docs/reference/ask.md): `askWithFiles`, its options and result, the adapter contract.
- [`llm-large-files`: errors, retries, streams](docs/reference/errors-and-retries.md): `ModelRequestError` and its kinds, `withRetry`, `parseSseJson`.
- [`llm-large-files`: the tools](docs/reference/tools.md): every tool the model sees, its arguments, results and limits.
- [`llm-large-files/gemini`](docs/reference/gemini.md): `askGemini`, `gemini()`, `geminiApi()`, `vertexAi()`.
- [`llm-large-files/openai`](docs/reference/openai.md): `openAiCompatible()` and its options.
- [`llm-large-files/anthropic`](docs/reference/anthropic.md): `anthropic()` and its options.
- [`llm-large-files/node`](docs/reference/node.md): `createDocumentHandlers`, its routes and responses.

[Changelog](CHANGELOG.md): what each version changed, and what to change in your code when you upgrade.

Also: [How it works](docs/how-it-works.md), [Security](docs/security.md),
[Troubleshooting](docs/troubleshooting.md) and [Measurements](docs/measurements.md). For
maintainers: [Contributing](https://github.com/renanbazinin/llm-large-files/blob/main/CONTRIBUTING.md) and [Publishing](docs/publishing.md).

## Requirements

Node.js 20.19 or newer. The package is ESM; CommonJS code can `require()` it on Node 20.19+ and
22.12+. For DOCX/PPTX install `jszip`, for PDF install `unpdf`, and to mark and show the pages of a
PDF, and refuse a page built to hold the server before it is read, install `@cantoo/pdf-lib`. All
three are optional:

```bash
npm install jszip unpdf @cantoo/pdf-lib        # Node 24 and later
npm install jszip unpdf@1 @cantoo/pdf-lib      # Node 22
npm install jszip unpdf@1.7.0 @cantoo/pdf-lib  # Node 20
```

On Node 24 and later, `npm install unpdf` installs unpdf 2, which asks for Node 24. On Node 20,
unpdf 1.9 and later cannot load pdf.js, and on Node 20 and 22 the pdf.js of unpdf 1.5.0 to 1.6.0
would stop the whole process. Such an unpdf is refused at the first PDF, with a message that says
what to install.

## License

[MIT](LICENSE)
