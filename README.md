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

## Pictures, charts and scans in PDFs

A large PDF goes to the model as text, and text cannot show a chart. Keep the uploaded PDFs, and
the model gets a tool, `view_pages`, that hands it the pages it asks for as a small PDF:

```bash
npm install @cantoo/pdf-lib
```

```ts
const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"],   // off by default: a kept file takes disk space until it expires
});
// askGemini needs no change. A step then reads: Look at report.pdf pages 12-14
```

Asked which bar of a chart is tallest, `gemini-3.5-flash-lite` said from the text that it could
not see the chart; with `view_pages` it looked at the page and answered correctly. It did not look
at a page for any of ten questions that the text answers. A page costs about 530 tokens.
Details, limits and measurements: [Pictures in PDFs](docs/configuration.md#pictures-in-pdfs).

## One model to explore, another to answer

Your application chooses the model: it is the `model` of the endpoint, and the package has no
default. That model does both halves of the work on a large file. It explores the file (searches,
reads, looks at pages), and then it answers. You can name a second model for the first half:

```ts
const endpoint = geminiApi({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.8-flash",                        // writes the answer
  explorerModel: process.env.GEMINI_EXPLORER_MODEL, // optional: searches and reads
});
```

Left out or empty, nothing changes: one model does both. With an explorer, the many requests of a
search through a large file go to that model, which can be a cheaper or faster one, and `model`
gets what the tools returned and writes the answer in one request. In eleven live checks with
`gemini-3.5-flash-lite` exploring, the other model answered every one correctly from what it found.
What each model gets, and what it costs: [An explorer model](docs/configuration.md#an-explorer-model).

## What it handles

| | |
|---|---|
| **Formats** | Text, Markdown, logs (UTF-8 and UTF-16), JSON/JSONL, CSV/TSV, DOCX, PPTX, PDF (text layer, with tables rebuilt so empty cells stay empty; pages with a picture are marked, and the model can look at the pages themselves; scans of up to 30 pages) |
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
| PDF with a chart and photos (`gemini-3.5-flash-lite`) | "Which bar is tallest, and what number is on the sign?" | Looked at 2 pages unasked; all five facts right, in 3 s. From the text alone: "cannot see the chart" |

## Documentation

- [Integration guide](docs/getting-started.md): Express, plain Node, browser upload, streaming, Vertex AI, gateways, existing chat history
- [API reference](docs/api.md)
- [Configuration](docs/configuration.md): budget, an explorer model, stores, formats, extractors, pictures in PDFs
- [How it works](docs/how-it-works.md): planner, cards, tools, map-reduce, looking at pages, and the Gemini quirks it handles
- [Security](docs/security.md): owners, tool scoping, retention, original files, regex safety

## Requirements

Node.js 20.19 or newer. The package is ESM; CommonJS projects can `require()` it on Node 20.19+ and 22.12+.
For DOCX/PPTX install `jszip`, for PDF install `unpdf`, and to mark and show the pages of a PDF
install `@cantoo/pdf-lib`. All three are optional:

```bash
npm install jszip unpdf @cantoo/pdf-lib
```

## License

[MIT](LICENSE)
