# llm-large-files documentation

`llm-large-files` lets a language model answer questions about files larger than its context window
or its request size limit: logs, books and other text, CSV, JSON, HTML, Word, PowerPoint, Excel and
PDF files. A file that fits goes into the prompt whole; a larger one becomes a short card, and the
model searches it, reads line ranges, reads all of it in parts or looks at the pages of a PDF, in
one tool loop that works with Gemini and Vertex AI, OpenAI-compatible endpoints, Claude or a model
of your own. This page is the map: where to start, which entry point to use, the words the other
pages use, and every page in one line.

## Start here

### A chatbot on Gemini or Vertex AI

For an application where users upload files into a chat, ask about them and watch the answer
stream in, with Gemini on Vertex AI or the Gemini API. Read in this order:

1. [Getting started](./getting-started.md): install, a quickstart that runs, and the integration
   in short steps.
2. [Gemini API and Vertex AI](./guides/vertex-and-gemini.md): endpoints and access tokens,
   `askGemini`, thinking, whole-file reads, pages, gateways, Vertex quotas and errors.
3. [Web app](./guides/web-app.md): uploads, answers and progress streamed to the browser,
   cancelling.
4. [Conversations](./guides/conversations.md): the history you keep, tool turns included, across
   requests and servers.
5. [Storage](./guides/storage.md): where documents live, owners, a layout per user and per chat
   session, retention.
6. [Errors and reliability](./guides/errors-and-reliability.md): what each failure means and what
   to show the user.
7. [Costs and limits](./guides/costs-and-limits.md): what one question may spend, and its usage per
   user or session.
8. [An explorer model](./guides/explorer-model.md): a cheaper model that searches the files while
   yours writes the answer.
9. [Deployment](./guides/deployment.md): several servers, memory, sweeps, proxies, upgrades.

### Another model

For OpenAI, Azure OpenAI, DeepSeek, a local server, Claude, or a model that has no adapter yet:

1. [Getting started](./getting-started.md).
2. [OpenAI-compatible endpoints](./guides/openai-compatible.md) or [Claude](./guides/anthropic.md):
   the adapter and its settings for your provider.
3. [Your own adapter and loop](./guides/own-adapter-and-loop.md): when your model has no adapter,
   or you already run a tool loop of your own.

Then go on with steps 3 to 9 of the first path. Those guides are not tied to a provider.

## Which entry point

There are three ways to ask a question. All three use the same `LargeFiles` object from
`createLargeFiles()`, so your documents, store and owners stay as they are when you move from one
to another.

| Entry point | Pick it when | What you do yourself |
|---|---|---|
| `askGemini`, from `llm-large-files/gemini` | Your model is Gemini, on the Gemini API or Vertex AI. One endpoint (`vertexAi()`, `geminiApi()`, or your gateway's URL and headers) says where the model is and can name an explorer model, and you may pass the history as Gemini `contents`. | Keep the history and show the answer; the loop does the rest. The explorer can only be another Gemini model, called with the same headers. |
| `askWithFiles` with an adapter, from `llm-large-files` | Any other model (`openAiCompatible()`, `anthropic()`, an adapter of your own), an explorer of another provider than the answering model, or an adapter you wrap for logging, quotas or a gateway. With `gemini()`, it also lets you declare the model's `contextTokens`, `maxRequestBytes` and `id` on the adapter. | The same as with `askGemini`. |
| Your own loop, with `files.prepare()` and `files.tools()` | You already run a tool loop, such as an agent framework, and want only the documents in it. `prepare()` gives the plan, the text or card of each document and the system instruction; `tools()` gives the tool declarations and runs the calls. | The loop: sending requests, retries, keeping the request inside the window, limits, usage, evidence and history. `withRetry`, `parseSseJson`, `evidenceOf`, `stubResult` and `UsageMeter` help with parts of it. |

`askGemini` is `askWithFiles` with a `gemini()` adapter for the endpoint, and a second one for its
explorer model when the endpoint names one. Both return the same `AskResult`. Here are the three
ways in; the third stops where your own loop takes over:

```ts
import { askWithFiles, createLargeFiles, FileDocumentStore } from "llm-large-files";
import { askGemini, gemini, vertexAi } from "llm-large-files/gemini";

// Assumed: getAccessToken() returns an OAuth access token for Vertex AI (see the Vertex guide),
// and documentId is the `id` that files.ingest() returned for an upload.
const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: "gemini-3.8-flash",
  accessToken: getAccessToken,
});
const documentIds = [documentId];
const messages = [{ role: "user" as const, text: "What caused the outage, and when? Cite lines." }];

// 1. askGemini: the endpoint says where the model is.
const first = await askGemini({ files, endpoint, documentIds, messages });

// 2. askWithFiles: the same loop, with the model as an adapter you can swap or wrap.
const model = gemini(endpoint);
const second = await askWithFiles({ files, model, documentIds, messages });
console.log(first.text, second.steps, second.usage);

// 3. Your own loop: the plan, the cards and the tools, for a loop you already have.
// The second argument is the size of the rest of your request: system prompt and messages.
const context = await files.prepare(documentIds, { tokens: 1_000, bytes: 4_000 });
// By default, the instruction and the cards offer analyze_whole_document for a file that can be
// read whole. The tool exists only when you pass `generate` (here the Gemini adapter's own).
// Without it, pass { wholeDocumentAnalysis: false } as prepare's third argument, so that the
// instruction and the cards do not offer the tool.
const tools = files.tools(context.plan.searchable, { generate: model.generateText });
// Put context.instruction in your system prompt and context.blocks (a text for each document) in
// the user turn, offer tools.declarations to your model, and run each call with tools.execute().
```

[Getting started](./getting-started.md) has a quickstart that runs. The third way is explained in
[your own adapter and loop](./guides/own-adapter-and-loop.md).

## Glossary

Each term links to the page that explains it. The defaults and limits are on those pages.

- **Adapter**: a `ModelAdapter`, the object through which the loop talks to one model: an `id`,
  its `capabilities` (at least `toolFiles` and `pageTokens`) and `send()`, plus `generateText()`
  when it can do whole-file reads. Built in: `gemini()`, `openAiCompatible()`, `openAiResponses()`
  and `anthropic()`.
  See [`ModelAdapter`](./reference/ask.md#modeladapter) and
  [your own adapter and loop](./guides/own-adapter-and-loop.md).
- **Budget**: the sizes one request must fit (`Budget`): the model's context window
  (`contextTokens`), the largest request body (`maxRequestBytes`), and the shares inside them:
  document text sent whole, tokens kept free, the part size of a whole-file read, one tool result.
  `askWithFiles` fits the budget to the window and body size each adapter declares, and the
  built-in adapters declare a window only when you give them `contextTokens`. See
  [`Budget`](./reference/library.md#budget) and [costs and limits](./guides/costs-and-limits.md).
- **Card**: what the model sees of a document that is not inline: its name and `document_id`, its
  format and size, for a text file that was not valid UTF-8 the encoding it was read in or how
  many of its characters were not valid, for a log its levels, time range and most frequent
  problems, the start of its outline, and its first lines, numbered. It tells the model to use the
  tools for the rest. See [how it works](./how-it-works.md).
- **Document**: a file after `files.ingest()`: its extracted text, which the tools read by line
  number, and its metadata (`DocumentMeta`), kept in the store under an ID the library makes
  (`doc_` and 32 hex characters). It expires after `ttlMs`. The uploaded file itself is kept only
  for the formats in `keepOriginals`: in the store, or where your application keeps it (0.9.0). See
  [storage](./guides/storage.md).
- **Evidence**: `AskResult.evidence`, one entry for each tool call that showed the model part of a
  document: which document, and which lines or pages, as ranges (`Evidence`). A whole-file read is
  marked `whole: true`. Keep it with the answer for citations or an audit trail. See
  [`AskResult`](./reference/ask.md#askresult).
- **Events**: what a question or an ingest does as it runs, as typed data in order (`AskEvent`,
  `IngestEvent`): each model request, tool call, piece of text and notice, numbered by `seq`, and
  last `run.finish` or `run.error` (`ingest.finish` or `ingest.error`). Get them with `onEvent`,
  or with `askStream` as an async iterable, and send them to a browser with `writeSseEvents`. New
  in 0.7.0. See [events](./reference/events.md).
- **Explorer model**: an optional second model (`explorer` in `askWithFiles`, `explorerModel` in
  `vertexAi()` and `geminiApi()`) that makes the tool calls and does the whole-file reads. The
  answering model then gets what the tools returned, not what the explorer wrote, and writes the
  answer in a request of its own. Without one, one model does both. See
  [an explorer model](./guides/explorer-model.md).
- **Inline**: a document whose whole text goes into the prompt because it fits the budget, between
  two frame lines that carry a mark made from its ID, which the file's own lines cannot copy. By
  default (`documentPlacement: "first"`) it goes at the start of the first user turn, where a
  provider's prompt cache can reuse it on follow-up questions. See [how it works](./how-it-works.md).
- **Limits**: `AskLimits`, how much work one question may do: chat requests (`toolTurns`), tool
  calls in one turn (`callsPerTurn`), whole-file reads of each document (`wholeDocumentReads`),
  and optional ceilings on input tokens (`inputTokens`) and requests (`requests`). The budget is
  about size; the limits are about work, and so about cost. See
  [`AskLimits`](./reference/ask.md#asklimits) and [costs and limits](./guides/costs-and-limits.md).
- **Owner**: a string you set at ingest, usually the ID of the user or tenant. It must not be
  empty: `ingest` refuses `""`, a string of spaces and `null`. Every later call for the document
  must pass the same string; with another one, the document is treated as missing and
  `askWithFiles` throws `DocumentsNotFoundError`. A document without an owner can be used by anyone
  who has its ID. The library only compares the strings: chat sessions, and which documents
  belong to one, are your application's to keep. See [storage](./guides/storage.md) and
  [security](./security.md).
- **Plan**: the split of a question's documents into inline and searchable (`DocumentPlan`, also in
  `AskResult.plan`). The smallest documents go in whole first, while they fit the budget's room for
  document text and the request size; the others get a card and the tools. `files.prepare()` makes
  it for each question. See [`DocumentPlan`](./reference/library.md#documentplan) and
  [how it works](./how-it-works.md).
- **Pointer**: a short result (`already_shown: true`) given in place of running a tool call again,
  when an earlier result still in the conversation holds in full what the call would return. The
  earlier result may be from this question or from an earlier one passed back as tool turns. It
  saves room in the request. See [conversations](./guides/conversations.md).
- **Question**: one call of `askGemini` or `askWithFiles`: the user's latest message and every
  model request made to answer it. Limits, usage and whole-file reads count per question. See
  [`askWithFiles`](./reference/ask.md#askwithfilesoptions).
- **Stand-in**: a short result put in place of an older tool result when the request runs out of
  room (`dropped: true`). It names the document and the lines or pages that were shown, so the
  model can read them again. When a model of the question may only grow its conversation
  (`appendOnly`, as Claude's), no older result is replaced to make room: when the room runs out,
  the question is answered with what it has. A look at pages kept in `toolTurns`, and a pointer
  whose result is gone, are still stand-ins. See
  [conversations](./guides/conversations.md) and [how it works](./how-it-works.md).
- **Steps**: one short line for each tool call, in order, such as
  `Search app.log (exact) for “timeout” — 12 matching lines`, and lines for what the loop itself
  did, such as `Older tool results were shortened to make room in the request`. They arrive live
  through `onStep`, and all together in `AskResult.steps`. Each is one line of plain text that can
  quote the model's words: show it as plain text, never as markdown or HTML. See
  [`AskResult`](./reference/ask.md#askresult) and [web app](./guides/web-app.md).
- **Store**: a `DocumentStore`, where the text and metadata of documents live and, when the store
  supports it, their original files and line indexes. Built in: `MemoryDocumentStore` and
  `FileDocumentStore`; write your own for a database or object storage. Servers that share a store
  share the documents. See [storage](./guides/storage.md) and
  [`DocumentStore`](./reference/library.md#documentstore).
- **Tool turns**: `AskResult.toolTurns`, the tool rounds of a question as plain JSON (`ToolTurn`),
  each call with its result. Store them with the chat and pass them back in `messages`, between
  that question and its answer: a later question then sees what was found and need not search
  again. Pages that were shown are not in them. See [conversations](./guides/conversations.md) and
  [`ToolTurn`](./reference/ask.md#toolturn). Not the same as `limits.toolTurns` and the
  `tool_turns_left` field of each result, which count the chat requests of a question (see
  **Limits**).
- **Tools**: what the model calls to reach the documents: `search_document`, `read_document`,
  `get_document_overview`, `analyze_whole_document` (a whole-file read) and `view_pages` (the pages
  of a PDF whose original is kept). A tool set reaches only the documents it was made for. See
  [tools](./reference/tools.md).
- **Usage**: `AskResult.usage` (`UsageTotals`), the requests and tokens of a whole question (input,
  cached input, output, thinking), whole-file part reads included, in total and for each model
  (`byModel`). Multiply by your prices for the cost of a question. See
  [costs and limits](./guides/costs-and-limits.md) and
  [`UsageTotals`](./reference/ask.md#usagetotals).
- **Whole-file read (map-reduce)**: the `analyze_whole_document` tool. The file is cut into parts
  of up to `mapChunkTokens`, each part is read by a model request of its own, several at a time,
  and their notes are merged into one answer. A file that would need more than `maxMapChunks` parts
  is refused. `askWithFiles` offers it only when the adapter that makes the tool calls has
  `generateText` and `wholeDocumentAnalysis` is not `false`; in your own loop, only when you pass
  `generate` to `files.tools()`. Without `generate`, pass `wholeDocumentAnalysis: false` to
  `files.prepare()`, so that the instruction does not name it and the cards do not offer it. See
  [tools](./reference/tools.md) and [how it works](./how-it-works.md).

## Guides

One task each, with samples:

- [Gemini API and Vertex AI](./guides/vertex-and-gemini.md): the Gemini API and Vertex AI in
  production: endpoints, access tokens, `gemini()` and `askGemini` setup, thinking, whole-file
  reads, pages, gateways, Vertex quotas and errors.
- [OpenAI-compatible endpoints](./guides/openai-compatible.md): recipes for OpenAI, Azure OpenAI,
  DeepSeek, OpenRouter, vLLM, Ollama, LiteLLM and llama.cpp.
- [Claude](./guides/anthropic.md): setup, thinking, streaming, conversations that may only grow,
  gateways.
- [An explorer model](./guides/explorer-model.md): a second, cheaper model that explores the
  documents while another answers: who does what, what changes for your app, cost, any pair of
  providers.
- [Web app](./guides/web-app.md): uploads (`createDocumentHandlers`, its hooks, saving each upload
  in the chat's folder, spooling to disk, direct `ingest`, the browser), answers and progress
  streamed over server-sent events, cancelling.
- [Conversations](./guides/conversations.md): the message format, keeping tool turns, history
  across requests and servers, staying inside the window, converters, pointers for repeated calls,
  mixing providers.
- [Storage](./guides/storage.md): the `DocumentStore` contract and writing your own, the built-in
  stores, owners and a layout per user and per session, retention, original files (a copy in the
  store, or the uploads your application keeps), the cache.
- [Deployment](./guides/deployment.md): several servers, memory sizing, sweeps, proxies and
  timeouts for streams, rolling upgrades, Node.js and ESM.
- [Errors and reliability](./guides/errors-and-reliability.md): every error and its kind and what
  to show a user, retries, waits on a silent model, deadlines, requests too large, empty or broken
  turns, `partialResultOf`.
- [Costs and limits](./guides/costs-and-limits.md): `AskLimits`, the budget for each model, usage
  totals, cost per user or session, what costs most.
- [PDFs and other formats](./guides/pdfs.md): formats and their optional dependencies, PDF tables,
  pictures, the page marker, `view_pages`, scanned PDFs, `toolFilePlacement`, your own extractors
  and OCR.
- [Your own adapter and loop](./guides/own-adapter-and-loop.md): writing or wrapping a
  `ModelAdapter`, your own loop with `prepare()` and `tools()`, `parseSseJson`, `withRetry`.
- [Testing an integration](./guides/testing.md): tests without a real model: a scripted model and
  the real adapters with a fake `fetch` (both from `llm-large-files/testing`), errors, expiry and
  owners, and a few cheap live tests.

## Reference by module

Every export and option, one page per part of the package. The first column is the name you
import from.

| Import from | Reference | What is there |
|---|---|---|
| `llm-large-files` | [The library and its documents](./reference/library.md) | `createLargeFiles`, `LargeFiles` and its options, `IngestError`, the budget, stores, extractors, document types, text helpers |
| | [The tool loop and the adapter contract](./reference/ask.md) | `askWithFiles`, its options, limits and result, conversation types, the `ModelAdapter` contract, usage, evidence |
| | [Errors, retries and streams](./reference/errors-and-retries.md) | `ModelRequestError` and error kinds, `withRetry`, timeouts, `parseSseJson` |
| | [Tools](./reference/tools.md) | each tool the model sees: name, arguments, results, limits; `ToolSet` and its types |
| | [Events](./reference/events.md) | `askStream`, `eventStream`, the events of a question (`AskEvent`) and of an ingest (`IngestEvent`), `EventError` |
| `llm-large-files/gemini` | [Gemini](./reference/gemini.md) | `askGemini`, `gemini()`, `geminiApi()`, `vertexAi()` and the other Gemini exports |
| `llm-large-files/openai` | [OpenAI-compatible](./reference/openai.md) | `openAiCompatible()`, `openAiResponses()` (new in 0.99.9) and the other OpenAI exports |
| `llm-large-files/anthropic` | [Claude](./reference/anthropic.md) | `anthropic()` and the other Anthropic exports |
| `llm-large-files/node` | [Node HTTP handlers](./reference/node.md) | `createDocumentHandlers`: routes, requests, responses and statuses, `prepareUpload` and `uploadSpool`; `createIsolatedExtractors`, files read in child processes; `fileOriginals`, the uploads your application keeps, read back by their ref; `writeSseEvents` and `sseMessageOf`, events as Server-Sent Events |
| `llm-large-files/testing` | [Testing](./reference/testing.md) | New in 0.9.0. `fakeModel`, a scripted model; `fakeFetch`, a `fetch` for the real adapters; test documents; `documentStoreChecks`, the checks of a store of your own |
| `llm-large-files/ai-sdk` | [AI SDK](./reference/ai-sdk.md) | New in 0.99.9. `aiSdkTools`, the tools of a question for the AI SDK 7; `compactToolResults` for `prepareStep`; `uiMessageStreamOf`, events as the AI SDK UI stream; `aiSdkGenerateText` |
| `llm-large-files/mcp` | [MCP](./reference/mcp.md) | New in 0.99.9. `registerLargeFilesTools`, the document tools on an MCP server; `mcpProgress`, events as MCP progress |

## Internals and measurements

- [How it works](./how-it-works.md): the internals end to end: ingest, text encodings, the plan,
  the frame and the cards, room in the request, token estimates, the tools, whole-file reads, the
  loop.
- [Security](./security.md): owners and scoping, prompt injection (the frame around a file,
  characters that show nothing, hidden text, older encodings), retention, original files, PDFs,
  uploads, regular expressions, cost, storage errors, what the library logs.
- [Measurements](./measurements.md): every live result and measurement, with its date.
- [Troubleshooting](./troubleshooting.md): symptom, cause, fix.

Older links: [api.md](./api.md) and [configuration.md](./configuration.md) keep their old
headings, each pointing to its new home.

## Maintainers

- [Publishing](./publishing.md): releasing a version to npm.
- [Contributing](https://github.com/renanbazinin/llm-large-files/blob/main/CONTRIBUTING.md): how to work on the code and its tests.

## Changelog and upgrading

[CHANGELOG.md](../CHANGELOG.md) says what changed in each version. From 0.6.0 on, each version
starts with what you must change when you upgrade, then what you can add, what works differently
and what was fixed.

[Upgrading to 0.99](./upgrading-0.99.md) takes an application from 0.10.x to 0.99.9: owner checks on
by default, the removed options, stored shapes across versions, the upload handlers, and what is new
and optional.

[Upgrading to 0.10](./upgrading-0.10.md) takes an application from 0.9.0 to 0.10.0: what no longer
compiles, the one prompt-cache miss, behavior to check, the worked example of the 0.9 guide carried
over, loops of your own, Vertex AI controls, operations on a shared volume and rolling deploys.

[Upgrading to 0.9](./upgrading-0.9.md) takes an application from 0.8.x to 0.9.0: what no longer
compiles, behavior to check, stores of your own, servers of two versions on one store, and a worked
example of a chatbot with a folder per user and chat on a shared volume.
