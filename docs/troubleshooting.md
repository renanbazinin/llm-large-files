# Troubleshooting

This page is for developers whose integration of llm-large-files does something they did not
expect. Each entry starts from what you see (an error message, an HTTP status, an answer that is
wrong), then gives the cause, the fix, and the page that explains it. The library's own messages
are quoted exactly. A provider's messages (Google's, OpenAI's, Anthropic's) are given as examples:
their wording is theirs and can change.

The samples assume what a question needs, as in [Getting started](./getting-started.md): `files`
from `createLargeFiles`, `endpoint` from `vertexAi()`, and the question's `documentIds`,
`messages` and `owner`.

- [Start here: what to log](#start-here-what-to-log)
- [Setup and install](#setup-and-install)
- [Uploads and formats](#uploads-and-formats)
- [Questions and answers](#questions-and-answers)
- [Errors from the model](#errors-from-the-model)
- [Performance and cost](#performance-and-cost)
- [Storage and several servers](#storage-and-several-servers)
- [Streaming](#streaming)

## Start here: what to log

Most symptoms are explained by what the question returns. Log it while you look for a cause:

```ts
import { askGemini } from "llm-large-files/gemini";

const result = await askGemini({ files, endpoint, documentIds, messages, owner });

console.log(JSON.stringify({
  answered: result.answered,         // false: the last turn had no answer
  finishReason: result.finishReason, // why the last reply ended, in the provider's word
  blockReason: result.blockReason,   // why the provider refused the prompt, when it did
  window: result.budget.contextTokens, // the window the documents were planned for
  sentWhole: result.plan.inline.map((meta) => meta.name),
  searched: result.plan.searchable.map((meta) => meta.name),
  steps: result.steps,               // every tool call, and what the loop did on its own
  evidence: result.evidence,         // the lines and pages each call showed the model
  turns: result.turns,
  usage: result.usage,               // tokens and requests, in all and for each model
}, null, 2));
```

- **`plan`** says which documents went into the prompt whole (`inline`) and which the model could
  reach only through its tools (`searchable`). The model sees of a searched document only what its
  searches and reads returned. `budget` is what the plan was made for: the library's budget, fitted
  to the models.
- **`steps`** holds one line for each tool call, such as
  `Search app.log (exact) for “timeout” — 12 matching lines`, or `… — failed: <reason>` when the
  call failed, and a line for each thing the loop did on its own, such as
  `Older tool results were shortened to make room in the request`.
- **`turns`** counts the chat requests that were sent (one that failed counts, and one sent again
  smaller after an overflow counts again); `usage.requests` counts the requests that were
  answered, the part reads of a whole-file read included.

When a question throws, log the error's class, `kind`, `status` and message, and what the question
had done before it failed:

```ts
import { DocumentsNotFoundError, DocumentStoreError, ModelRequestError, partialResultOf } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";

try {
  await askGemini({ files, endpoint, documentIds, messages, owner });
} catch (error) {
  if (error instanceof ModelRequestError) {
    // status 0: no answer, a silent model (kind timeout), or a reply cut off on its way.
    // limitTokens and requestedTokens: the provider's numbers of an overflow.
    console.error(error.name, error.kind, error.status, error.limitTokens, error.requestedTokens, error.message, error.cause);
  } else if (error instanceof DocumentsNotFoundError) {
    console.error("missing documents", error.ids);
  } else if (error instanceof DocumentStoreError) {
    console.error("store not readable", error.code, error.cause);
  } else {
    console.error(error);
  }
  // Undefined for an error raised before the question got under way (a missing document, a bad budget).
  const partial = partialResultOf(error);
  if (partial) console.error(partial.steps, partial.usage);
}
```

What each error and `kind` means, and what to tell your user, is in
[Errors and reliability](./guides/errors-and-reliability.md).

## Setup and install

### `require("llm-large-files")` throws `ERR_REQUIRE_ESM`

**Cause.** The package is an ES module only. CommonJS code can load it with `require()` only on the
Node versions that load ES modules that way by default: 20.19 and later in Node 20, 22.12 and later
in Node 22, and 23 and later. Node 21 and Node 22.0 to 22.11 refuse. The library needs Node 20.19
or later in any case.

**Fix.** Upgrade Node, or load the package from CommonJS with `await import("llm-large-files")`
(and `import("llm-large-files/gemini")` and so on for the other entry points). In TypeScript this
needs `"module": "node16"` or `"nodenext"`: with `"commonjs"` the compiler turns `import()` into
`require()`, which fails the same way. The package has no CommonJS build.

See [Getting started](./getting-started.md).

### A PDF, DOCX or PPTX upload fails: "needs the optional dependency"

`files.ingest` throws one of these, and the upload handler answers `422` with it:

- `Reading PDF files needs the optional dependency "unpdf".`
- `Reading DOCX and PPTX files needs the optional dependency "jszip".`

A look at the pages of a PDF fails in `steps`, while uploads work:
`Look at report.pdf pages 12-14 — failed: report.pdf: Showing PDF pages needs the optional dependency "@cantoo/pdf-lib".`

**Cause.** The three packages are optional peer dependencies: `npm install llm-large-files` does
not install them. Or they are installed where you develop and missing where the server runs: kept
as `devDependencies` and left out of the production install, or missing from the image or the
bundle you deploy.

**Fix.** Install them as dependencies of the application that runs the upload route and the
questions: `npm install jszip unpdf @cantoo/pdf-lib`. Install `@cantoo/pdf-lib` before PDFs are
uploaded: without it nothing fails at upload, but the text of a PDF is written without the line
that marks a page with a picture (`[Picture on this page. This text cannot show it.]`), and a
document keeps the text it was ingested with.

See [PDFs and other formats](./guides/pdfs.md).

### `createLargeFiles` throws an error about `budget`

One of:

- `budget.contextTokens must be a number above 0, and is NaN.`
- `budget.reservedTokens (64,000) must be smaller than budget.contextTokens (32,000): nothing would be left for the conversation.`
- `budget.mapChunkTokens (100,000) must be smaller than budget.contextTokens (32,000): a part of a whole-file read would not fit the model.`

**Cause.** Every budget field must be a finite number above 0. `NaN` most often comes from
`Number(process.env.SOMETHING)` with the variable unset. The other two come from fields you set
that cannot work together: a field you set stays as you set it, and a field you leave out follows
`contextTokens`. The same errors come from the `budget` option of a question.

**Fix.** For a model with a smaller window, set `contextTokens` (and `maxRequestBytes`) and leave
the other fields out. Read numbers from the environment with a check:

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

const contextTokens = Number(process.env.MODEL_CONTEXT_TOKENS);

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.DOCUMENTS_DIR ?? "./data/large-files"),
  // Set the field only when the variable holds a number: Number(undefined) is NaN.
  ...(Number.isFinite(contextTokens) && contextTokens > 0 ? { budget: { contextTokens } } : {}),
});
```

See [`Budget`](./reference/library.md#budget) and [Costs and limits](./guides/costs-and-limits.md).

### Importing the library fails in an edge runtime

**Cause.** The library runs on Node.js. It imports `node:crypto` and `node:fs` and uses `Buffer`,
which edge runtimes and browsers do not have.

**Fix.** Run the routes that upload and ask on the Node.js runtime. Browser code sends the file
and reads the answer stream; it never imports the library.

See [Web app](./guides/web-app.md).

### `instanceof ModelRequestError` is false for a model error

**Cause.** Two copies of the package are installed (two versions, or a linked copy next to an
installed one). The error comes from the classes of one copy, and your `instanceof` checks against
the other.

**Fix.** Install one copy (`npm ls llm-large-files` lists them). Or test the kind with
`errorKindOf(error)`, which reads the `kind` field of any error that has one, whatever copy made it.

See [`ModelRequestError`](./reference/errors-and-retries.md#modelrequesterror).

## Uploads and formats

### `413`: "The file is larger than the 100 MB upload limit."

`createDocumentHandlers` answers `413` with `{ "error": "The file is larger than the 100 MB upload limit." }`.
`files.ingest`, called directly, throws `report.pdf is larger than the 100 MB upload limit.` The
number is your `maxUploadBytes` (100 MB by default).

**Cause.** The file is larger than `maxUploadBytes`. The handler tells it from `Content-Length`
before it reads anything, or stops keeping the bytes once the body passes the limit.

A `413` that comes before your handler runs, often with an HTML body, is not the library's: a proxy
in front of the server has its own limit (nginx's `client_max_body_size` is 1 MB unless you set it),
or a body parser mounted before the route has one (Express's `express.raw()` takes 100 kB unless
you set `limit`).

**Fix.** Raise `maxUploadBytes`, and the limit of each proxy in front of the route. Mount the upload
handler without a body parser: it reads the body itself. An upload is held in memory whole while it
is read and its text extracted, so a higher limit is more memory for each upload under way.

See [Web app](./guides/web-app.md) and [Deployment](./guides/deployment.md).

### `400`: "Name the file with an X-File-Name header or a ?name= query parameter."

**Cause.** The upload request names no file. The name decides the format, and is shown to the
model.

**Fix.** Send `X-File-Name: encodeURIComponent(file.name)`, or `?name=` in the URL.

See [Web app](./guides/web-app.md).

### `400`: "The upload body was already parsed by another middleware. …"

The whole message: `The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream.`

**Cause.** A body parser (`express.json()`, `express.urlencoded()`, a multipart parser) ran before
the handler and turned the file into an object.

**Fix.** Mount the upload route before the body parsers, and send the file with
`Content-Type: application/octet-stream`, which a JSON or form parser leaves alone. A `Buffer` in
`request.body`, as `express.raw()` leaves it, is used as the file.

See [Web app](./guides/web-app.md).

### `422` for a file the library cannot read

`files.ingest` throws an error written for your user, and the upload handler answers `422` with it.
The common ones:

| Message | What the file is |
|---|---|
| `This file looks binary, not text. Attach a text, log, PDF, DOCX, or PPTX file.` | An image, a legacy `.doc` or `.xls`, any other binary file. |
| `This file is a ZIP archive. Extract it, then attach the text file you need.` | A ZIP, or a format that is a ZIP inside and is not DOCX or PPTX: XLSX, ODT. |
| `This file is gzip-compressed. Decompress it, then attach the text file inside.` | A compressed log, such as `app.log.gz`. |
| `report.txt is empty.` | A file of 0 bytes. |
| `report.docx did not contain any text.` | Nothing left once read: a DOCX of pictures, a file of blank lines. |
| `This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.` | A scan, while PDFs are not kept. |
| `This PDF has 6,200 pages, more than the 5,000 read from one file. Split it, and attach the part you need.` | A PDF of more than `maxPdfPages` pages (5,000 by default). Refused before any page is read. |
| `This PDF holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.` | A PDF whose text passes `maxTextBytes` (by default `maxUploadBytes`, 100 MB). |
| `notes.txt holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.` | The same, from the text extractor or one of your own: a UTF-16 file can grow by half in UTF-8. |
| `This DOCX holds more than 32 million characters of text, more than is read from one file. Split it, and attach the part you need.` | A DOCX or PPTX of more than 32 million characters of text, about 10,000 dense pages. With `maxTextBytes` below that: `This DOCX holds more than 10 MB of text, more than is kept from one file.` |
| `report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.` | The ingest took longer than `ingestTimeoutMs` (2 minutes by default). See [below](#an-upload-fails-took-too-long-to-read). |
| `This PDF lists the same page more than once. A file built that way can hold far more text than its size, so it is not read. Print it to a new PDF, and attach that.` | A PDF whose page tree lists one page several times. No PDF writer does this: a file of 3 KB built this way held 107 MB of text. |
| `This PDF draws more than 16 MB of text, over 100 times its size. A file that grows that much is not read: it may be built to exhaust the server.` | A PDF whose pages draw more than 100 times its size in text, past the first 16 MB: forms painted inside forms, many times over. Real PDFs hold less text than their size. |
| `This DOCX has more than 1,000,000 paragraphs, more than a document holds. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX of more than 1,000,000 paragraphs with text. |
| `This DOCX nests paragraphs more than 32 deep, which no document does. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX with paragraphs inside paragraphs, more than 32 deep. |
| `This DOCX has 30,000 parts, more than an Office document has. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX whose ZIP directory lists more than 20,000 parts. |

**Fix.** Most messages say what the user can do. For a scanned PDF, keep PDFs
(`keepOriginals: ["pdf"]`): a scan of up to `scannedPdfPages` (30) pages is then accepted, and the
model reads it by looking at its pages. A longer scan needs OCR. To accept a format the library
refuses, such as XLSX, convert it to text or CSV before `files.ingest`, or give a `text` extractor
of your own that reads it: every file of a format the library does not know goes to that one.

For a file past a limit, the user splits it and attaches the part the question is about. If your
users need larger files, raise `maxPdfPages` or `maxTextBytes` in `createLargeFiles`: the numbers
in the messages are yours. The last four messages are for files built to exhaust a server, not
written by Word, PowerPoint or a PDF printer: keep the limits. A file from a real program that
meets one is written the usual way once it is opened there and saved again, or printed to a new
PDF.

See [PDFs and other formats](./guides/pdfs.md#what-is-refused), which lists every refusal.

### An upload fails: "took too long to read"

The whole message: `report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.`
The number is your `ingestTimeoutMs`: in milliseconds below a second ("500 ms"), in seconds
below 2 minutes ("45 s"), in minutes from there ("2 min").

**Cause.** One `ingest` (extracting the text, its line index and its profile) took longer than
`ingestTimeoutMs`, 120,000 ms by default. Most often: a PDF with many pages that are slow to read;
an extractor of your own that waits on a slow service, such as OCR of a long scan; or a server
busy with other ingests, which each take their share of the same process. Nothing is stored.

**Fix.** For a file that is slow to read, the user splits it, or saves it as plain text. For OCR or
another slow extractor of your own, raise `ingestTimeoutMs` (0 sets no limit), run the ingest in a
background job ([Web app](./guides/web-app.md#long-ingests-in-the-background)), and pass
`input.signal` on to the service it calls, so that the request stops at the limit too. Bound the
ingests that run at once on one server ([Deployment](./guides/deployment.md#uploads-and-ingest)).
If you ingest in a process or a worker with a timer of its own, set that timer above
`ingestTimeoutMs`, so that the user gets this message and not yours.

See [`LargeFilesOptions`](./reference/library.md#largefilesoptions) and
[Custom extractors](./guides/pdfs.md#custom-extractors).

## Questions and answers

### "The last message must be the user's."

**Cause.** `askWithFiles` and `askGemini` take the conversation with the new question last. This is
thrown when `messages` is empty (or `askGemini` got neither `messages` nor `contents`), or when it
ends with an answer or a tool round.

**Fix.** Append the question: `[...history, { role: "user", text: question }]`. Stored tool rounds
(`toolTurns`) go between the question they belong to and its answer, never after the new question.

See [Conversations](./guides/conversations.md).

### `DocumentsNotFoundError`: "A document is no longer available: doc_…. Upload it again."

With several: `2 documents are no longer available: doc_…, doc_…. Upload them again.` The upload
handler's `get` answers `404` with `This file is no longer available.` for the same causes.

**Cause.** The question is thrown out before any model request because one of its `documentIds`:

- expired: documents are kept for `ttlMs`, 72 hours by default;
- was deleted;
- belongs to another `owner`, or has an owner while the question passes none. A document with an
  owner is reported as missing, never as forbidden;
- was stored in a `MemoryDocumentStore` of another process, or of this one before it restarted;
- is not a document ID at all (`isDocumentId` is false for it).

**Fix.** Pass the same `owner` to the question as to the upload: the value `getOwner` returned for
the same user. Use a store that every server shares and that outlives a restart. Show the user which
files to attach again: `error.ids` names the IDs, and your chat knows their file names. A
document's `expiresAt` says when it goes.

See [Storage](./guides/storage.md) and
[`DocumentsNotFoundError`](./reference/ask.md#documentsnotfounderror).

### In your own loop, a tool answers "doc_… is no longer available on the server" for a document that is there

The whole result: `{ "error": "doc_… is no longer available on the server. Ask the user to attach the file again." }`,
from `read_document`, `search_document`, `get_document_overview`, `analyze_whole_document` or
`view_pages`.

**Cause.** Besides a document that expired or was deleted after the question was planned: since
0.6.1, `files.tools()` compares the owner stored with each document with the `owner` of the
`DocumentMeta` it was handed, and answers a mismatch as a document that is gone. Your loop passes
metadata that it built itself (from an ID, from its own database, from a `DocumentSummary`, which
has no owner) or that another owner's call returned. A document stored without an owner is not
checked.

**Fix.** Pass `tools()` the metadata that `prepare(ids, base, { owner })` returned
(`prepared.plan.searchable`, `prepared.viewable`), or `getMeta(id, { owner })`, with the owner of
the user who asks. `askWithFiles` and `askGemini` do this for you.

See [`files.tools`](./reference/library.md#filestoolsdocuments-options) and
[Security](./security.md#tool-scoping).

### The answer says it found nothing, or ignores part of the file

Log the result ([Start here](#start-here-what-to-log)) and look for one of these:

- **The document is in `plan.searchable`.** It did not fit in the room for whole documents
  (`inlineTokens`, 200,000 tokens by default, shared by the documents of the question, smallest
  first), and the model saw only what its searches and reads returned (`evidence`). A keyword
  search ranks passages by the words of the model's query; an exact search finds only the file's
  own spelling. A model that searched with the wrong words did not see the answer. Ask with the
  words the file uses, or give the search to a stronger model, as
  [an explorer](./guides/explorer-model.md).
- **The question ran out of room or turns.** `steps` holds
  `… — failed: Not run: there is no room left in this conversation for another tool result. …`, or
  `turns` reached `limits.toolTurns` (12), or `usage` reached your `limits.inputTokens` or
  `limits.requests`. The last request then asks the model to answer from what it has and to say
  plainly what it could not find.
- **An explorer called no tool.** With an [explorer model](./guides/explorer-model.md), `steps` is
  empty while `plan.searchable` lists documents: the explorer replied `DONE` at once, and the
  answering model was told to say plainly what is not shown.
- **The answer is in a picture.** The text of a PDF page says
  `[No text on this page. It may be a scan, a photo, or a chart.]` or
  `[Picture on this page. This text cannot show it.]`. Without `view_pages` the model cannot see it
  (see [below](#the-model-never-looks-at-a-page-or-says-it-cannot-see-it)).
- **The library does not read that part.** Comments and speaker notes of DOCX and PPTX files are
  not read, and neither are their pictures.
- **The document was not in the question.** Only the `documentIds` of this question are planned
  and searchable.
- **The server cut the prompt.** Some local servers shorten a prompt longer than the context they
  run with, without an error. The model answers from what was left. Set `contextTokens` on the
  adapter to the window the server really runs with.

See [How it works](./how-it-works.md) for the plan and the tools, and
[Tools](./reference/tools.md) for what each tool returns.

### `answered` is `false`

**Cause.** The model's last turn had no text:

- **The provider refused the prompt.** `blockReason` says why: Gemini's own reason, Claude's
  `refusal` (with its category: `refusal: <category>`), or `content_filter` from an
  OpenAI-compatible server. Nothing more is asked after a refusal.
- **The reply was cut off before any text.** `finishReason` is `MAX_TOKENS` (Gemini), `length`
  (OpenAI-compatible) or `max_tokens` (Claude): the output limit was spent, most often on thinking.
- **The reply was filtered**, or the model made a tool call that could not be read, in the request
  that had to be the answer.

`text` is then empty, holds only a remark the model made before a tool call, or holds the start of
a reply the provider then refused.

**Fix.** Do not show `text` as the answer: show your own message, and log `finishReason` and
`blockReason`. For a cut-off reply, raise the output limit or lower the thinking. The same prompt
asked again is most often refused again.

See [Errors and reliability](./guides/errors-and-reliability.md).

### The answer stops in the middle of a sentence

`answered` is `true`, and `finishReason` is `MAX_TOKENS`, `length` or `max_tokens`.

**Cause.** The answer reached the output limit: `maxOutputTokens` in Gemini's `generationConfig`,
`max_completion_tokens` or `max_tokens` in the `body` of `openAiCompatible()`, `maxTokens` of
`anthropic()` (64,000 by default). A model that thinks counts its thoughts in that limit. The library
does not continue a reply that was cut.

**Fix.** Raise the limit, or lower the thinking (`thinkingConfig` for Gemini). Tell the user when
`finishReason` says the answer was cut.

See [Gemini API and Vertex AI](./guides/vertex-and-gemini.md),
[OpenAI-compatible endpoints](./guides/openai-compatible.md) and [Claude](./guides/anthropic.md).

### The answer begins with "Let me search the log…"

**Cause.** Without an explorer, `text` is everything the model wrote, and that includes a remark it
made before a tool call. Streaming shows it as it comes.

**Fix.** Accept it, ask for no remarks in your `system` instruction, or use an
[explorer model](./guides/explorer-model.md): the explorer's words are never shown, and `text` is
only what the answering model wrote.

### The model never looks at a page, or says it cannot see it

`steps` holds no `Look at …` line, or holds one and the model then says it cannot see the page.

**Cause.** The model gets `view_pages` for a PDF only when all of these hold:

- `keepOriginals` lists `"pdf"`, and the store has `putOriginal` and `getOriginal`
  (`FileDocumentStore` and `MemoryDocumentStore` have both);
- the document was ingested after that: one ingested before has no file kept
  (`meta.originalKept` is not `true`);
- every model of the question can be sent a file: not `openAiCompatible()` without `pdfInput`, not
  `anthropic({ toolFilePlacement: "none" })`;
- the question does not pass `viewPages: false`.

A model that has the tool and does not call it may have found the answer in the text.

A model that looked and says it cannot see the page is most often Gemini 2.5 with the default
`toolFilePlacement: "inside"`: it accepts the pages inside a function response, bills them, and
does not see them.

**Fix.** Turn on `keepOriginals: ["pdf"]` and upload the PDFs again. For Gemini 2.5, pass
`toolFilePlacement: "beside"` to `askGemini` or `gemini()`. With `@cantoo/pdf-lib` missing, every
look fails: install it ([above](#a-pdf-docx-or-pptx-upload-fails-needs-the-optional-dependency)).

See [PDFs and other formats](./guides/pdfs.md).

### Whole-file reads never happen, or are refused

`steps` holds no `Read all of …` line, or holds one that failed:

- `… — failed: Reading all of app.log needs 41 model calls, over the limit of 30. Use search_document to narrow the question first.`
- `… — failed: app.log was already read whole for this question, and is not read whole again. …`
- `… — failed: Not run: reading all of app.log takes about … input tokens, and … are left of the … this question may use. …`

**Cause.** `analyze_whole_document` reads a file in parts, one model request each. It is offered
only for documents that are searched (a document sent whole is already in the prompt), only when
the model that explores has `generateText` (the built-in adapters do; an adapter of your own may
not), and not with `wholeDocumentAnalysis: false`. A file may take at most `maxMapChunks` parts
(30 parts of up to `mapChunkTokens`, 100,000 tokens, by default). When no searched document fits
in that (estimated from its size, with 5% to spare), the tool is not offered at all. When another
one fits, a call on the larger file fails with the `needs 41 model calls` error above. Each
document may be read whole `limits.wholeDocumentReads` times a question (1), and a read that would
pass `limits.inputTokens` or `limits.requests` is not started.

**Fix.** Ask about a part of the file, so that searches and reads answer it. Raise `maxMapChunks`
only with its cost in mind: each part is a request of up to `mapChunkTokens` input tokens.

See [Tools](./reference/tools.md) and [Costs and limits](./guides/costs-and-limits.md).

### The model repeats the same calls

`steps` holds `… — already shown above`, or the same search in other words over and over, or
`… more tool calls in this turn were not run (at most 8 a turn)`.

**Cause.** A call whose result is still in the conversation in full (the same search, or a read of
lines already shown) is not run again: the model gets a pointer to the earlier result, which costs
no file access. A search in other words is a new call and runs. A model that keeps searching uses
its tool turns, and then must answer. A smaller model does this more often. Two searches in a row
that fail with an error in the same mode get a hint: for `regex`, to try `exact` or `keywords`; for
the other modes, to check the arguments. A search that finds nothing is not a failure and gets no
hint.

**Fix.** Nothing breaks: the question still ends with an answer within `limits.toolTurns`. To cap
the cost of a model that loops, lower `limits.toolTurns`. To loop less, give the searching to a
stronger model as an [explorer](./guides/explorer-model.md), and pass the `toolTurns` of earlier
questions back, so that a follow-up starts from what was already found.

See [Conversations](./guides/conversations.md) and [`AskLimits`](./reference/ask.md#asklimits).

## Errors from the model

A model request that fails, and is not mended by sending it again, reaches you as a
`ModelRequestError`: a `GeminiRequestError`, `OpenAiRequestError` or `AnthropicRequestError`. Its
`kind` says what went wrong, `status` is the HTTP status (0 when no answer came, the model sent
nothing for the whole wait, or a streamed reply was cut off), and its message is most often the
provider's own. Log the message; show your own words, chosen by `kind`.
`partialResultOf(error)` gives what the question found and used until then.

### `context_overflow`: the request is larger than the model takes

The provider's message, for example Vertex AI's `The input token count exceeds the maximum number of tokens allowed 1048576.`,
with `limitTokens` and `requestedTokens` when the message gives the numbers. A body over a size
limit (HTTP 413) is this kind too.

**Cause.** The loop recovers on its own when it can: it shortens older tool results and sends the
request again (at most twice a question), or, before any tool ran, plans the documents again,
once, for a smaller window worked out from the provider's numbers (see
[How it works](./how-it-works.md#a-request-too-large-for-the-model)). `steps` then holds
`The request was larger than the model takes: older tool results were shortened, and it was sent again`
or `The first request was larger than the model's window of … tokens: the files were planned again to fit it`.
The error reaches you when that was not enough:

- **The history is too long.** The loop never shortens a question or an answer you pass.
- **The model's window is smaller than the budget says.** The budget assumes 1M tokens unless you
  set `contextTokens` on the adapter or in the budget. Each question then starts with a request the
  provider refuses, and plans again; when the window it plans for is still too large, the error is
  thrown.
- **The model may not have its conversation rewritten.** Claude's conversation is append-only, so
  old tool results are never shortened for it.
- **The body is too large for a gateway.** Set `maxRequestBytes` to its limit.

**Fix.** Keep the history under a limit you choose, dropping old tool rounds first, then old turns.
For a model or gateway with smaller limits, set `contextTokens` (and `maxRequestBytes`) on the
adapter (`gemini()`, `openAiCompatible()`, `anthropic()`), or with `askGemini` pass
`budget: { contextTokens, maxRequestBytes }` (or set them in the `budget` of `createLargeFiles`).
Keep `partialResultOf(error).toolTurns` with the conversation, and tell the user to start a new
chat or ask about fewer files.

A provider whose wording the library does not know gives kind `invalid`, and the loop does not
recover. `classifyModelError(status, message)` shows how a message is read; a wrapper around your
adapter can set the kind itself ([Your own adapter and loop](./guides/own-adapter-and-loop.md)).

See [Conversations](./guides/conversations.md) and
[Errors and reliability](./guides/errors-and-reliability.md).

### `quota` or `rate_limit`: HTTP 429

**Cause.** Too many requests or tokens for the account. The two kinds differ in one thing: a wait
mends a `rate_limit` (a quota per minute, Gemini's among them) and not a `quota` (a Gemini quota
per day, OpenAI's `insufficient_quota`). The library sends a `rate_limit` request again a few
times, and throws a `quota` error at once. While it waits, `onActivity` reports it:
`The model did not answer (HTTP 429). Trying again in 2 s…`. A whole-file read reaches a quota per
minute first: up to 30 part reads, four at a time. Claude's HTTP 529 (overloaded) is neither: it
is kind `server`.

**Fix.** For `rate_limit` under load, wait longer (`retry: { retries: 5, baseDelayMs: 2_000 }`),
raise the quota, or move the searching to an explorer on another model or project. Tell the user to
try again in a minute; `error.retryAfterMs` is the wait the provider named. A `quota` error is for
whoever runs the account: alert them, and tell the user the assistant is not available.

See [Errors and reliability](./guides/errors-and-reliability.md) for every kind and the waits,
[`RetryOptions`](./reference/errors-and-retries.md#retryoptions), and
[Gemini API and Vertex AI](./guides/vertex-and-gemini.md).

### `timeout`: "Gemini sent nothing for 600 s."

Or `Gemini sent nothing for 300 s.`, `The model sent nothing for 600 s.` (OpenAI-compatible),
`Claude sent nothing for 600 s.`. Status 0, kind `timeout`.

**Cause.** Each adapter aborts a chat request that gets nothing for `firstByteTimeoutMs` (600 s)
before its reply starts, or for `idleTimeoutMs` (300 s) between two pieces of it. The loop sends it
again once, unless text of it was shown, so by the time you see the error the user may have waited
twice that long. What makes a model silent that long:

- a model that thinks long on a large request sends nothing while it thinks;
- a reply that is not streamed arrives whole at the end. On Gemini and OpenAI-compatible
  endpoints that is an explorer's requests, every request when you pass no `onText`, every request
  of `openAiCompatible({ stream: false })`, and every request to a Gemini endpoint without
  `streamUrl`. `anthropic()` streams every request unless you pass `stream: false`;
- a gateway between your server and the provider holds the stream back;
- the provider hangs.

**Fix.** For a model that thinks long, raise `firstByteTimeoutMs` (an option of `askGemini`,
`gemini()`, `openAiCompatible()` and `anthropic()`; 0 waits without end), or lower its thinking. To
fail sooner, lower both waits. Bound the whole question with a `signal` that aborts at your
deadline. Part reads of a whole-file read have a limit of their own, 180 s each: a part that runs
out is tried once more, then counted in the read's `parts_that_failed`.

See [Errors and reliability](./guides/errors-and-reliability.md).

### `unreachable`: "Gemini could not be reached (fetch failed)."

Or `The model could not be reached (…).` and `Claude could not be reached (…).`. Status 0, kind
`unreachable`.

**Cause.** No HTTP answer came: a name that does not resolve, a refused connection, a proxy that
your server must go through, a certificate that Node does not trust (a corporate proxy that
inspects TLS). The request is sent again up to 3 times before you see this.

**Fix.** Log `error.cause`: it is the error of `fetch`, whose own `cause` usually names the system
error (`ENOTFOUND`, `ECONNREFUSED`, a certificate error). Node's `fetch` does not go through a proxy
unless it is set up to: every adapter and `askGemini` take a `fetch` option for one that does. A
corporate certificate authority is added with the `NODE_EXTRA_CA_CERTS` environment variable.

See [Errors and reliability](./guides/errors-and-reliability.md).

### `auth`: Vertex AI refuses the token

HTTP 401 or 403, kind `auth`, with Google's message. It is not sent again.

**Cause.**

- **401**: the access token expired or is not one. A string given as `accessToken` is sent as it is
  for as long as the endpoint lives, and an access token expires after an hour by default: the
  first questions work, the later ones fail.
- **403**: the identity has no role that may call the model (Vertex AI User,
  `roles/aiplatform.user`), the Vertex AI API is not enabled in the project, or the project is not
  the one you meant.
- On the Gemini API, a key that is not valid comes as HTTP 400 and is kind `auth` too.

**Fix.** Give `vertexAi()` a function as `accessToken`. It is called before every request, part
reads included:

```ts
import { GoogleAuth } from "google-auth-library";
import { vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

export const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: "gemini-3.8-flash",
  // GoogleAuth keeps the token and renews it before it expires.
  accessToken: async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("No access token from the application default credentials.");
    return token;
  },
});
```

For a 403, check which identity the server runs as, give it the role, and enable the API in the
project.

An error thrown by your `accessToken` function (such as google-auth-library's "Could not load the
default credentials…") is not a `ModelRequestError`: it has no status and no kind. In a chat
request it ends the question, without a retry. The application default credentials are missing
where the server runs.

See [Gemini API and Vertex AI](./guides/vertex-and-gemini.md).

### Azure OpenAI refuses `max_tokens`

HTTP 400, kind `invalid`, with a message such as
"Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead". The
`OpenAiRequestError` has `param` `"max_tokens"` when the server names the field.

**Cause.** Reasoning deployments on Azure OpenAI (and OpenAI's newer models) take
`max_completion_tokens`, not `max_tokens`. The adapter sends no output limit in a chat request: one
there comes from your `body`. In the part reads of a whole-file read it chooses the name from the
URL (`max_completion_tokens` on Azure OpenAI's hosts) and, when a server refuses the name it was
sent, switches to the other. A gateway on another host gets `max_tokens` first, and one that
rewrites the error leaves the adapter nothing to learn from.

**Fix.** Put `max_completion_tokens` in `body`, and behind a gateway set `maxTokensField`:

```ts
import { openAiCompatible } from "llm-large-files/openai";

export const azure = openAiCompatible({
  // https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<version>
  url: process.env.AZURE_OPENAI_CHAT_URL!,
  headers: { "api-key": process.env.AZURE_OPENAI_API_KEY! },
  model: process.env.AZURE_OPENAI_DEPLOYMENT!,
  body: { max_completion_tokens: 16_000 }, // not max_tokens
  maxTokensField: "max_completion_tokens", // the name in part reads, whatever the host
});
```

See [OpenAI-compatible endpoints](./guides/openai-compatible.md).

### `invalid`: HTTP 400 or 404 for a setting

**Cause.** The provider refused the request as it was, and sending it again would not help. The
usual ones:

- **A setting one model does not take.** With an explorer, both models get your `generationConfig`
  unless you give `explorerGenerationConfig`. Given a `thinkingLevel`, `gemini-2.5-flash-lite` on
  Vertex AI answered HTTP 400 "thinking_level is not supported by this model".
- **A model the location does not serve, or a wrong model name** (HTTP 404).
- **A server that does not know `tool_choice`.** The request that must be answered in text sends
  `tool_choice: "none"`, so a question fails when it needs that request: always with an explorer,
  and when the tool turns run out.
- **A server that cannot stream** and refuses the streamed request.

**Fix.** Give the explorer its own `explorerGenerationConfig`. Check the model name and location.
For an OpenAI-compatible server, set `answerWithoutTools: "omit"` or `stream: false`.

See [An explorer model](./guides/explorer-model.md) and
[OpenAI-compatible endpoints](./guides/openai-compatible.md).

### A `SyntaxError` from `JSON.parse`

Often one that starts `Unexpected token '<'`. It has no `status` and no `kind`.

**Cause.** A reply that was not streamed came with HTTP 200, but its body was not JSON: a gateway,
a proxy or a sign-in page answered with HTML. A chat request is not sent again for it.

**Fix.** Call the URL the way the adapter does and look at what comes back. Fix the gateway's route
or its sign-in, or give the adapter the URL that answers JSON.

See [Errors and reliability](./guides/errors-and-reliability.md).

## Performance and cost

### Costs are higher than expected

Look at `result.usage`: `inputTokens`, `cachedInputTokens` (read from the provider's prompt cache),
`outputTokens` (thoughts included), `thoughtTokens`, `requests`, and the same for each model in
`byModel`.

**Cause.** What costs most:

- **Whole-file reads.** One read is up to `maxMapChunks` (30) part requests of up to
  `mapChunkTokens` (100,000) tokens: up to 3M input tokens.
- **Documents sent whole, in a tool loop.** Every request of a question carries the documents that
  went in whole, up to `inlineTokens` (200,000 tokens), and a question makes up to
  `limits.toolTurns` (12) chat requests. A prompt cache makes the repeats cheaper:
  `cachedInputTokens` shows how much it served.
- **Pages.** A page shown to the model costs about 530 tokens on Gemini (3,500 by default for
  Claude), and stays in every later request of the question. With `keepOriginals: ["pdf"]`, a
  question about a PDF sent whole can take several requests, because `view_pages` is offered for it.
- **Thinking.** Thoughts are billed as output.
- **`documentPlacement: "last"`.** The documents then move to the latest turn, and a prompt cache
  cannot reuse them: keep the default, `"first"`.

**Fix.** Set ceilings for one question, and log the usage per user or session:

```ts
import { askGemini } from "llm-large-files/gemini";

const result = await askGemini({
  files, endpoint, documentIds, messages, owner,
  limits: {
    inputTokens: 1_000_000, // no more tools once the question has sent this many input tokens
    requests: 20,           // chat requests and part reads together
    wholeDocumentReads: 0,  // no whole-file reads
  },
});

const { inputTokens, cachedInputTokens, outputTokens, requests, byModel } = result.usage;
console.log({ owner, inputTokens, cachedInputTokens, outputTokens, requests, byModel });
```

The ceilings are checked before each request that may use tools. Once one is reached, the next
request is the answer, which is still made: a question can pass `inputTokens` by about two
requests (the one that crossed it, and the answer): set it that far below what must not be passed
([Costs and limits](./guides/costs-and-limits.md#inputtokens-and-requests-are-checked-between-turns)). A
cheaper [explorer model](./guides/explorer-model.md) takes the searching and the part reads off the
model that answers.

See [Costs and limits](./guides/costs-and-limits.md) and [`AskLimits`](./reference/ask.md#asklimits).

### Every follow-up question searches again

**Cause.** The tool results of a question are in its result (`toolTurns`), not in the library. A
follow-up whose `messages` hold only the text of earlier turns has none of them.

**Fix.** Keep `result.toolTurns` with the conversation, and pass them back between the question
they belong to and its answer. A follow-up then gets a pointer to an earlier result instead of
running the same call again.

See [Conversations](./guides/conversations.md).

### A question takes minutes

**Cause.** A question makes up to `limits.toolTurns` (12) chat requests, one after another. A model
that thinks takes long on each; a whole-file read adds its part reads, four at a time, each up to
180 s; a request that failed waits before it is sent again (up to `retry.maxDelayMs`, 60 s, when
the provider asks); a silent model is waited for 600 s, twice. Nothing streams while an explorer
works.

**Fix.** Show `onActivity` to the user: it says what the question is doing
(`Search app.log (exact) for “timeout”…`, `Writing the answer…`, and each retry). Bound the time
with a `signal` that aborts at your deadline. Lower `limits.toolTurns`, turn off whole-file reads,
or use a faster model as the explorer.

See [Errors and reliability](./guides/errors-and-reliability.md) and [Web app](./guides/web-app.md).

### Memory grows with large files or many users

**Cause.**

- Each library (each `createLargeFiles` call) keeps documents ready for repeated tool calls, up to
  `cacheBytes` (256 MB). Several libraries in one process, such as one per chat, each have their
  own.
- A document larger than `wholeDocumentBytes` (2 MB) is read by range only when the store has
  `readTextRange`, as `FileDocumentStore` does. With a store of your own without it, and with
  `MemoryDocumentStore`, every document is loaded whole.
- An upload is held in memory whole while it is read and extracted, with several copies of its
  text, and the parsers of PDF, DOCX and PPTX take memory of their own while they read, in the
  same heap as everything else.

**Fix.** Give a store of your own `readTextRange` (and `putIndex` and `getIndex`, so that no pass
over the text is needed first). Lower `cacheBytes` and `maxConcurrentScans` to fit the memory of
the server, and `maxUploadBytes` and `maxTextBytes` to the files you expect. To keep a file that
needs too much memory from stopping the server, ingest in a process of its own with its own heap
limit: a worker thread does not keep it apart.

See [Storage](./guides/storage.md) and [Deployment](./guides/deployment.md#uploads-and-ingest).

### Other requests are slow while a question searches

**Cause.** A regex search runs on the server's event loop, in slices of up to 250 ms. One search
stops after 3 s, and the regex searches of one question share 6 s (`REGEX_BUDGET_MS`); a pattern
with a nested quantifier, such as `(a+)+`, is refused before it runs. So the model's patterns can
hold up other requests of the same process for up to a quarter of a second at a time.

**Fix.** Run several server processes, so that one busy process does not hold up the others. In a
tool loop of your own, `regexBudgetMs` of `files.tools()` lowers the shared time.

See [Security](./security.md) and [Tools](./reference/tools.md).

## Storage and several servers

### `DocumentStoreError`: "The document store could not be read (EIO). Try again."

Thrown by a question, `files.getMeta`, `files.getOriginal`, and by `files.delete` when the look-up
fails (a failure of the store's own `delete` comes as the store's error). When the error behind it
has no `code`, the message has none. Inside a question's tool call, the model gets it as the
call's error, and `steps` shows
`… — failed: The document store could not be read (EIO). Try again.`. The upload
handler's `get` and `remove` answer `500` with `The file could not be looked up (EIO).` or
`The file could not be deleted (EIO).`.

**Cause.** The store failed while it was read: a network volume that did not answer, too many open
files, a database that is down. The documents are not gone.

**Fix.** Show the message (it names no path and no host) and let the user try again; do not ask
them to upload again. Log `error.cause`, the store's own error, and `error.code`. Fix the storage.

See [`DocumentStoreError`](./reference/library.md#documentstoreerror) and
[Storage](./guides/storage.md).

### Documents are found on one server and missing on another

`DocumentsNotFoundError` for documents that were just uploaded, on some requests and not others, or
for every document after a restart.

**Cause.** The servers do not share the store: a `MemoryDocumentStore` (each process has its own,
and loses it when it stops), or a `FileDocumentStore` on each server's local disk.

**Fix.** Use one store that every server reads: `FileDocumentStore` on a shared volume, or a store
of your own on shared storage. The library keeps nothing else between requests that another server
would need.

See [Deployment](./guides/deployment.md) and [Storage](./guides/storage.md).

### A store outage shows up as expired documents

Users are told to upload files again while your database is down.

**Cause.** A store of your own returns `undefined` when its read fails. `undefined` means "this
document does not exist", so the library reports the documents as missing.

**Fix.** Return `undefined` only for a document that is not there or has expired, and let every
other failure throw. The library turns a thrown error into a `DocumentStoreError`, which says to
try again.

See [Storage](./guides/storage.md) and [`DocumentStore`](./reference/library.md#documentstore).

### `500`: "Upload failed.", or `422` with your database's message

**Cause.** A store write that fails is thrown as it came, not as a `DocumentStoreError`. The upload
handler answers it `500` with `{ "error": "Upload failed." }` when it has no `status` (or
`statusCode`) from 400 to 599 and is not a Node system error with `code` and `syscall`. Its message
is your database's own and may name its host, so it is not sent, and the handlers log nothing.

Two paths answer it `422` with your database's message instead, as a file that cannot be read: an
`ingest` of your own that throws a new error in its place, as `ingestInProcess` in
[Deployment](./guides/deployment.md#uploads-and-ingest) does, and a route of your own, as in
[Web app](./guides/web-app.md#filesingest-and-its-errors). Every case is in the
[node reference](./reference/node.md#uploadrequest-response).

**Fix.** In a store of your own, log a write that fails, and throw an error with a `status` (a
`503`, say) whose message is fit for a user. An `ingest` of your own must copy that status, and a
system error's `code` and `syscall`, onto the error it throws, as `ingestInProcess` in
[Deployment](./guides/deployment.md#uploads-and-ingest) does.

See [Storage](./guides/storage.md) and [`llm-large-files/node` reference](./reference/node.md).

### `500`: "Upload failed (ENOSPC)."

**Cause.** The disk of a `FileDocumentStore` is full. Expired documents are removed when they are
next looked up, or by `files.sweep()`: one that nobody asks for again stays on disk until a sweep.
Kept originals (`keepOriginals`) take space up to the upload limit each, until they expire.

**Fix.** Run `files.sweep()` on a timer. It also removes files that belong to no document (an
upload that failed) once they are an hour old.

```ts
// `files` from createLargeFiles.
setInterval(() => {
  files.sweep().then(
    (removed) => console.log(`sweep removed ${removed} expired documents`),
    (error: unknown) => console.error("sweep failed", error),
  );
}, 60 * 60 * 1000).unref();
```

Lower `ttlMs` if documents need not live 72 hours.

See [Deployment](./guides/deployment.md) and [Storage](./guides/storage.md).

## Streaming

### The answer arrives in one piece

**Cause.** Text streams only when you pass `onText` and the adapter can stream:

- `askGemini` and `gemini()` stream only to an endpoint with a `streamUrl`. `geminiApi()` and
  `vertexAi()` set it; an endpoint you write for a gateway may not.
- `openAiCompatible({ stream: false })` and `anthropic({ stream: false })` do not stream, and a
  server that answers without `text/event-stream` is read in one piece. `onText` is then called
  once, with the whole text.
- With an explorer, nothing streams until the answering model starts.
- A proxy or a compression middleware between your server and the browser holds the events back.

**Fix.** Give a gateway endpoint its stream URL:

```ts
import { askGemini, type GeminiEndpoint } from "llm-large-files/gemini";

const model = `${process.env.LLM_GATEWAY_URL}/v1/models/gemini-3.8-flash`;
const endpoint: GeminiEndpoint = {
  url: `${model}:generateContent`,
  streamUrl: `${model}:streamGenerateContent?alt=sse`, // without it, the answer arrives in one piece
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_GATEWAY_TOKEN}` },
};

await askGemini({ files, endpoint, documentIds, messages, owner, onText: (delta) => process.stdout.write(delta) });
```

On the way to the browser, send `X-Accel-Buffering: no` for nginx and leave the route out of
compression.

See [Web app](./guides/web-app.md).

### The stream to the browser stops or stalls

The browser's stream ends without your final event, or the events arrive all at once at the end.

**Cause.** A proxy or load balancer in front of your server closes a response on which nothing
arrived for a while, or ends one that runs longer than its limit, or buffers the events. A question
can be silent for minutes: an explorer at work, a model that thinks, a whole-file read.

**Fix.** Write an SSE comment line (`: keep-alive`) every 15 seconds or so, turn off buffering for
the route, and set the proxy's timeout above your own deadline for a question.

See [Web app](./guides/web-app.md) and [Deployment](./guides/deployment.md).

### "Gemini's reply ended before it was complete."

Or `The model's reply ended before it was complete.` and `Claude's reply ended before it was complete.`.
Status 0, kind `unreachable`.

**Cause.** A streamed reply closed without the event that says why it ended: a proxy or gateway
between your server and the provider cut it. For Gemini, a gateway that drops `?alt=sse` from the
stream URL does the same: Gemini then answers with a JSON array, not with events. The request is
sent again when none of its text was shown. When some was, it cannot be taken back, and the error
reaches you after the user saw part of an answer.

**Fix.** Keep the text that was shown and mark it as cut off, and keep `partialResultOf(error)`'s
`toolTurns` so that the user's next question starts from what was found. Raise the gateway's
timeouts for streams, or route the stream URL past it.

See [Errors and reliability](./guides/errors-and-reliability.md).

### The question goes on after the user leaves

The model keeps working, and billing, after the user closed the tab or pressed Stop.

**Cause.** A question stops only when its `signal` aborts.

**Fix.** Abort it when the response closes:

```ts
import type { ServerResponse } from "node:http";
import { askGemini } from "llm-large-files/gemini";

export async function answer(response: ServerResponse) {
  const userLeft = new AbortController();
  // The response's close, not the request's: the request closes once its body has been read.
  response.on("close", () => userLeft.abort());
  return askGemini({ files, endpoint, documentIds, messages, owner, signal: userLeft.signal });
}
```

The question then throws the signal's reason. What it used until then was paid for:
`partialResultOf(error)` gives its `usage` when the reason is an object, so abort with no reason or
with an `Error`.

See [Web app](./guides/web-app.md).
