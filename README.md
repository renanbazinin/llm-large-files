# llm-large-files

Let an LLM answer questions about **books, logs, and other files larger than its request limit or
context window**.

Your users upload a 50 MB log or a 900-page book. Your model connector accepts 10 MB per request
and 1M tokens of context. This package bridges the gap:

- **Files that fit** go into the prompt whole.
- **Files that don't** become a short summary card, and the model gets tools to **search**,
  **read line ranges**, or **read the whole file in parts** (map-reduce). Answers cite line numbers.

It's a small library, not a framework: no model SDK, no server, and no UI are required. A drop-in
Gemini / Vertex AI helper and Node HTTP handlers are included for the common case.

```bash
npm install llm-large-files
```

## Quickstart (Gemini, 10 lines)

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";

const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });

// When a user uploads a file:
const doc = await files.ingest({ name: "app.log", bytes: fileBytes });

// When they ask about it:
const { text, steps } = await askGemini({
  files,
  endpoint: geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.8-flash" }),
  documentIds: [doc.id],
  messages: [{ role: "user", text: "What caused the outage, and when? Cite lines." }],
  onText: (delta) => process.stdout.write(delta), // optional streaming
});
```

`steps` lists what the model did, for example
`Search app.log (exact) for “failover” — 1 matching lines`. Show it under the answer so users can
see where the answer came from.

Using **Vertex AI** or an **enterprise gateway**? Swap the endpoint:

```ts
import { vertexAi } from "llm-large-files/gemini";
const endpoint = vertexAi({ project: "my-project", model: "gemini-3.8-flash", accessToken: getToken });
// or your own proxy:
const endpoint = { url: "https://llm-gw.corp/v1/gemini:generateContent", headers: { Authorization: `Bearer ${key}` } };
```

## Add it to a web app

```ts
import express from "express";
import { createDocumentHandlers } from "llm-large-files/node";

const documents = createDocumentHandlers(files, { getOwner: (req) => req.user?.id });
app.post("/api/documents", documents.upload);          // mount before express.json()
app.delete("/api/documents/:id", (req, res) => documents.remove(req, res, req.params.id));
```

The browser uploads the raw file:

```ts
await fetch("/api/documents", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
  body: file,
}); // → { id, name, format, lines, estimatedTokens, expiresAt, ... }
```

The full walkthrough, with streaming to the browser, is in the [integration guide](docs/getting-started.md).
There's also a [one-file demo server](examples/server.ts).

## What it handles

| | |
|---|---|
| **Formats** | Text, Markdown, logs (UTF-8 and UTF-16), JSON/JSONL, CSV/TSV, DOCX, PPTX, PDF (text layer) |
| **Logs** | Detected automatically; the card shows level counts, the time range, and the most frequent errors grouped by shape (`timeout after <n>ms to <ip>`) |
| **Books and documents** | An outline of headings with line numbers, including Markdown, "Chapter 12", numbered sections, and Hebrew chapter titles |
| **Limits** | One budget covers tokens *and* request bytes, so files fit both your context window and your connector's payload limit |
| **Privacy** | Documents can belong to an `owner`; other users can't plan, read, or delete them |
| **Storage** | In memory, on disk with expiry, or your own store (Redis, S3, a database) |

## Live results

With `gemini-3.8-flash` on the Gemini API:

| File | Question | Result |
|---|---|---|
| 5 MB log, about 1.27M tokens (over the 1M limit) | "What caused the outage?" | Correct root cause, citing the right lines, in about 60 s over 11 tool calls |
| 467 KB novel, about 117K tokens | "Where was the ledger hidden?" | Sent whole; correct. Estimated 116,840 tokens; Gemini billed 116,842 |
| Same novel, map-reduce | "Read all of it…" | 4 parts read in parallel; correct, cited answer in 32 s |

## Documentation

- [Integration guide](docs/getting-started.md): Express, plain Node, browser upload, streaming, Vertex AI, gateways, existing chat history
- [API reference](docs/api.md)
- [Configuration](docs/configuration.md): budget, stores, formats, extractors
- [How it works](docs/how-it-works.md): planner, cards, tools, map-reduce, and the Gemini quirks it handles
- [Security](docs/security.md): owners, tool scoping, retention, regex safety

## Requirements

Node.js 20.19 or newer. The package is ESM; CommonJS projects can `require()` it on Node 20.19+ and 22.12+.
For DOCX/PPTX install `jszip`, and for PDF install `unpdf`. Both are optional:

```bash
npm install jszip unpdf
```

## License

[MIT](LICENSE)
