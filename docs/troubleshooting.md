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
  `Older tool results were shortened to make room in the request`. Each step is one line of plain
  text that can quote the model's words: show it as text, never as markdown or HTML.
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
    // status 200 and kind invalid: a reply that could not be read, such as a gateway's page.
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
Node versions that load ES modules that way by default: 22.12 and later in Node 22, and 23 and
later. Node 22.0 to 22.11 refuse. The library needs Node 22.12 or later in any case (20.19 until
0.9.0).

**Fix.** Upgrade Node, or load the package from CommonJS with `await import("llm-large-files")`
(and `import("llm-large-files/gemini")` and so on for the other entry points). In TypeScript this
needs `"module": "node16"` or `"nodenext"`: with `"commonjs"` the compiler turns `import()` into
`require()`, which fails the same way. The package has no CommonJS build.

See [Getting started](./getting-started.md).

### A PDF, DOCX or PPTX upload fails: "needs the optional dependency"

`files.ingest` throws one of these, and the upload handler answers `422` with it:

- `Reading PDF files needs the optional dependency "unpdf".`
- `Reading DOCX, PPTX and XLSX files needs the optional dependency "jszip".` (until 0.8.0:
  `Reading DOCX and PPTX files …`)

A package that is installed but fails to load, such as a version this Node cannot run, says so
since 0.8.0: `The optional dependency "unpdf" is installed but could not be loaded (…). Reinstall
it, or install a version this Node can run.` Its code is `"missing_dependency"` all the same.

A look at the pages of a PDF fails in `steps`, while uploads work:
`Look at report.pdf pages 12-14 — failed: report.pdf: Showing PDF pages needs the optional dependency "@cantoo/pdf-lib".`

**Cause.** The three packages are optional peer dependencies: `npm install llm-large-files` does
not install them. Or they are installed where you develop and missing where the server runs: kept
as `devDependencies` and left out of the production install, or missing from the image or the
bundle you deploy.

**Fix.** Install them as dependencies of the application that runs the upload route and the
questions: `npm install jszip unpdf @cantoo/pdf-lib` on Node 24 and later. On Node 22, name a
version of `unpdf` that runs there: `npm install jszip unpdf@1 @cantoo/pdf-lib` (see
[below](#a-pdf-upload-fails-the-unpdf-installed-would-stop-the-whole-server)).
Install `@cantoo/pdf-lib` before PDFs are uploaded: without it nothing fails at upload, but the
text of a PDF is written without the line that marks a page with a picture
(`[Picture on this page. This text cannot show it.]`), and a document keeps the text it was
ingested with.

See [PDFs and other formats](./guides/pdfs.md).

### A PDF upload fails: "The unpdf installed would stop the whole server"

`files.ingest` throws this, and the upload handler answers `422` with it:

`The unpdf installed would stop the whole server at the first PDF file on Node 22, so PDF files are not read. Install unpdf 1.6.1 or later, or run Node 24 or later.`

The number is the major version of the Node that runs the server. DOCX, PPTX and text files are
read as before.

**Cause.** unpdf 1.5.0 to 1.6.0 load a pdf.js that calls `Promise.try`, which Node 22 does not
have. In 0.5.0 the first PDF stopped the whole process, with a `TypeError` that nothing could
catch. Since 0.6.0 the library checks it before it reads a PDF.

unpdf 2 asks for Node 24, and on Node 24 a plain `npm install unpdf` installs it. A pdf.js that
cannot be loaded for another reason fails with unpdf's own message. (Until 0.9.0, on Node 20, that
failure came as `The unpdf installed cannot read PDF files on Node 20 (…)`. Node 20 is no longer
supported.)

**Fix.** Install the `unpdf` that runs on your Node, or move to Node 24:

| Node | `unpdf` to install |
|---|---|
| 22 | 1.4.0, or 1.6.1 or a later 1.x: `npm install unpdf@1`. |
| 24 and later | Any version from 1.4.0, 2.x included: `npm install unpdf`. |

If the server loads pdf.js when it starts, as [Deployment](./guides/deployment.md#uploads-and-ingest)
shows, an `unpdf` that cannot load pdf.js on that Node makes the start fail instead. With unpdf
1.5.0 to 1.6.0 on Node 22, pdf.js loads and the server starts: PDFs are then refused at upload,
with the message above.

See [PDFs and other formats](./guides/pdfs.md#formats).

### `npm install` stops with `ERESOLVE` over `unpdf`

**Cause.** llm-large-files 0.5.0 accepts `unpdf` ^1.4.0 only: with it, an install of unpdf 2, or
of 0.5.0 in an app that already has unpdf 2, stops with `ERESOLVE`. 0.6.0 accepts
`^1.4.0 || ^2.0.0`. So going back from 0.6.0 with unpdf 2 to 0.5.0 stops the same way
(`npm install llm-large-files@0.5.0`), and changes nothing.

**Fix.** Use 0.6.0. To go back to 0.5.0 from unpdf 2, install both in one command:
`npm install llm-large-files@0.5.0 unpdf@^1`, or restore `package.json` and `package-lock.json`
together.

See [PDFs and other formats](./guides/pdfs.md#formats).

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

### `503`: "The server is receiving other files right now. Try again in a moment."

New in 0.8.2. `createDocumentHandlers` answers `503` with `Retry-After: 5`, before reading the body.

**Cause.** The handlers already hold uploads, and this one would bring them past
`maxPendingUploadBytes` (twice `maxUploadBytes`, 200 MB by default). An upload is held from the
reading of its body to the end of its ingest, and its room is taken from its `Content-Length`
before its body arrives (`maxUploadBytes` for a body sent without a `Content-Length`, until it is
read: two such uploads fill the default room). Many users sending files at once, or a few clients
that send their headers and then their bodies slowly, fill it. With `uploadSpool` (new in 0.9.0),
the same answer comes when the spool's files reach `maxSpooledUploadBytes`.

**Fix.** Send the file again after `Retry-After` seconds, as the browser code in
[Web app](./guides/web-app.md#upload-from-the-browser) does. To take more at once, raise
`maxPendingUploadBytes` and size the server for it (each upload under way takes about three and a
half to five and a half times its size while it is ingested over a `FileDocumentStore`,
[measurements](./measurements.md#the-server); ingests take turns, `maxConcurrentIngests`). Put a
proxy that reads whole bodies before passing them on in front, so that slow clients hold no room.
Or take the bodies off the heap: `uploadSpool` writes the larger ones, and those without a
`Content-Length`, to temporary files, and `maxPendingUploadBytes` then counts only the bodies kept
in memory ([Deployment](./guides/deployment.md#uploads-and-ingest)).
"The server is reading other files right now." is another `503`: the readers of
`createIsolatedExtractors` are busy ([Node reference](./reference/node.md#uploadrequest-response)).
So is "The server has no room for this file right now. Try again later." (new in 0.9.0, with
`Retry-After: 30`): the disk the body was written to, the spool's or the folder of
`prepareUpload`, is full.

### `408`: "The upload stopped arriving: nothing came for 30 s. Send it again."

New in 0.8.2. **Cause.** The body of an upload stopped arriving for `uploadIdleTimeoutMs` (30 s):
the client's connection stalled, or a proxy held the body. The connection is closed. **Fix.** Send
the file again. For users on slow or unsteady links, raise `uploadIdleTimeoutMs` of
`createDocumentHandlers`.

### `503`: "Upload failed (ETIMEDOUT)." and `500`: "Upload failed (ELOOP)."

New in 0.9.0, for a body written to a file (the `path` of `prepareUpload`, or `uploadSpool`).

- **"ETIMEDOUT"**, a `503` with `Retry-After: 5` (a `500` before 0.10.0). A call to the disk
  (checking the folders of a path with a ref, opening the file, a write, closing it) did not end
  within `uploadIdleTimeoutMs` (30 s): the volume stopped answering, such as a network volume whose
  server is gone. The upload's room is given back, and the file is removed once the volume answers.
  **Fix.** Check the volume. The client may send the file again after `Retry-After`. A slow network
  volume can take long to close a file it held writes for: raise `uploadIdleTimeoutMs`.
- **"ELOOP"**, a `500`. `prepareUpload` gave a path that ends with the ref of its `original`, and a folder
  between that root and the file is a link. `fileOriginals` would never read the file back through
  it, so nothing is written. **Fix.** Replace the link with the folder itself, or mount the other
  disk there. The root itself may be a link.

See [saving the body](./reference/node.md#saving-the-body-prepareupload).

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

### `500`: "Upload failed (empty owner)." or "Upload failed (owner is not a string)."

`createDocumentHandlers` answers the upload `500` with `{ "error": "Upload failed (empty owner)." }`
or `{ "error": "Upload failed (owner is not a string)." }`. It answers before it reads the body, and
logs nothing. `files.ingest`, called directly with such an owner, throws a `TypeError`:
`owner must be a string that is not empty or only spaces, such as the signed-in user's ID. To let anyone with the document's ID use it, leave owner out.`

**Cause.** Since 0.6.0 an owner of `""`, of spaces only, or `null` is refused. It would be one owner
shared by every caller without a user: each of them could read and delete the documents of the
others. 0.5.0 accepted it.

- **"empty owner"**: `getOwner` returned `""`, spaces, or `null`. Most often it does
  `user?.id ?? ""` for a user who is not signed in, or reads a header that arrives empty
  (`req.headers["x-user-id"]`).
- **"owner is not a string"**: `getOwner` returned, from JavaScript, something that is neither a
  string nor a finite number: the user object (`req.user` in place of `req.user.id`), `true`, `NaN`,
  an array.

A numeric owner is accepted, as before. Under `requireOwner`, the default since 0.99.9, the
library refuses that owner on every call: `get`, `remove` and `list` then answer "The file could
not be looked up (empty owner).", "The file could not be deleted (empty owner)." and "The files
could not be listed (empty owner).", also `500`. Under `requireOwner: false`, `get`, `remove` and
questions that pass the owner `""` work as before, so documents that 0.5.0 stored with that owner
stay readable until they expire.

**Fix.** Return the user's ID, not the user object. For a request without a signed-in user, return
`undefined`: it is answered `401` "Sign in first." by default. Only under `requireOwner: false`
does `undefined` make an anonymous upload (`user?.id || undefined`): anyone who has the ID of such
a document may then use it.

See [`DocumentHandlerOptions`](./reference/node.md#documenthandleroptions) and
[Security](./security.md#ownership).

### `422` for a file the library cannot read

`files.ingest` throws an [`IngestError`](./reference/library.md#ingesterror) written for your
user, with a `code` for your app (`"not_text"`, `"compressed"`, `"no_text"`…), and the upload
handler answers `422` with its message. The common ones:

| Message | What the file is |
|---|---|
| `This file looks binary, not text. Attach a text, log, PDF, Word, PowerPoint, Excel or HTML file.` | An image, an audio file, any other binary file. Until 0.8.0 the message ended `Attach a text, log, PDF, DOCX, or PPTX file.` |
| `This is a Word, Excel or PowerPoint file of before 2007 (.doc, .xls, .ppt), an Outlook message (.msg), or an Office file protected by a password and stored that way. None of these can be read: save it as .docx, .xlsx, .pptx, PDF or text, without a password, and attach that.` | A legacy `.doc`, `.xls` or `.ppt`, a `.msg`, or a DOCX, PPTX or XLSX saved with a password. New in 0.8.0: the first were "binary", the last failed as damaged files. |
| `This PDF is protected by a password, so it cannot be read. Open it, print it to a new PDF without the password, and attach that.` | A PDF with a password. New in 0.8.0: pdf.js said "No password given". |
| `This file is a ZIP archive. Extract it, then attach the text file you need.` | A ZIP, or a format that is a ZIP inside and is not DOCX, PPTX or XLSX: ODT, ODS. Until 0.8.0 an XLSX got it too. |
| `This file is gzip-compressed. Decompress it, then attach the text file inside.` | A compressed log, such as `app.log.gz`. |
| `report.txt is empty.` | A file of 0 bytes. |
| `report.docx did not contain any text.` | Nothing left once read: a DOCX of pictures, a file of blank lines. |
| `This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.` | A scan, while PDFs are not kept. |
| `The unpdf installed would stop the whole server at the first PDF file on Node 22, …` | Any PDF, while the `unpdf` installed cannot run on this Node. See [above](#a-pdf-upload-fails-the-unpdf-installed-would-stop-the-whole-server). |
| `This PDF has 6,200 pages, more than the 5,000 read from one file. Split it, and attach the part you need.` | A PDF of more than `maxPdfPages` pages (5,000 by default). Refused before any page is read. |
| `This PDF holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.` | A PDF whose text passes `maxTextBytes` (100 MB by default, or `maxUploadBytes` when that is larger). |
| `notes.txt holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.` | The same, from the text extractor or one of your own: a UTF-16 file can grow by half in UTF-8. |
| `This DOCX holds more than 32 million characters of text, more than is read from one file. Split it, and attach the part you need.` | A DOCX or PPTX of more than 32 million characters of text, about 10,000 dense pages. With `maxTextBytes` below that: `This DOCX holds more than 10 MB of text, more than is kept from one file.` |
| `report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.` | The ingest took longer than `ingestTimeoutMs` (2 minutes by default). See [below](#an-upload-fails-took-too-long-to-read). |
| `This PDF lists the same page more than once. A file built that way can hold far more text than its size, so it is not read. Print it to a new PDF, and attach that.` | A PDF whose page tree lists one page several times. No PDF writer does this: a file of 3 KB built this way held 107 MB of text. |
| `This PDF draws more than 16 MB of text, over 100 times its size. A file that grows that much is not read: it may be built to exhaust the server.` | A PDF whose pages draw more than 100 times its size in text, past the first 16 MB: forms painted inside forms, many times over. Real PDFs hold less text than their size. |
| `This DOCX has more than 1,000,000 paragraphs, more than a document holds. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX of more than 1,000,000 paragraphs with text. |
| `This DOCX nests paragraphs more than 32 deep, which no document does. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX with paragraphs inside paragraphs, more than 32 deep. |
| `This DOCX has more than 20,000 parts, more than an Office document has. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX of more than 20,000 parts. They are counted the way JSZip will read them, whatever count the file gives: Office writes no file this large, a deck of 2,000 slides with notes and pictures has about 12,000. |
| `This DOCX lists its parts in a way that no Office program does: reading the list would take far more memory or time than an Office document needs. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX with more than 80,000 extra fields, or more than 8 MB of names, comments and extra-field data that JSZip would turn into text or go through byte by byte. The Office files we tried had at most 68 KB of them. |
| `This DOCX ends with a ZIP64 record that cannot be read, and reading it could hold the server without end. It may be built to exhaust the server, so it is not read.` | A DOCX or PPTX whose ZIP64 end record says it is longer than its fields: JSZip would read it in a loop that does not move on. |

**Fix.** Most messages say what the user can do. For a scanned PDF, keep PDFs
(`keepOriginals: ["pdf"]`): a scan of up to `scannedPdfPages` (30) pages is then accepted, and the
model reads it by looking at its pages. A longer scan needs OCR. To accept a format the library
refuses, such as an OpenDocument file (ODT, ODS), convert it to text or CSV before `files.ingest`,
or give a `text` extractor of your own that reads it: every file of a format the library does not
know goes to that one. To tell users in your own words or language, map `error.code`
([`IngestError`](./reference/library.md#ingesterror)).

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
busy with other ingests, which each take their share of the same process. A file read from a path
(`source: { path }`, an upload of `prepareUpload` or of the spool) gets the same message when its
volume stops answering while the file is read. Nothing is stored.

**Fix.** For a file read from a path, check its volume first: the file may be fine. For a file
that is slow to read, the user splits it, or saves it as plain text. For OCR or
another slow extractor of your own, raise `ingestTimeoutMs` (0 sets no limit), run the ingest in a
background job ([Web app](./guides/web-app.md#long-ingests-in-the-background)), and pass
`input.signal` on to the service it calls, so that the request stops at the limit too. Bound the
ingests that run at once on one server ([Deployment](./guides/deployment.md#uploads-and-ingest)).
If you ingest in a process or a worker with a timer of its own, set that timer above
`ingestTimeoutMs`, so that the user gets this message and not yours.

See [`LargeFilesOptions`](./reference/library.md#largefilesoptions) and
[Custom extractors](./guides/pdfs.md#custom-extractors).

### The server stops with "JavaScript heap out of memory" on a PDF

The process ends with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`,
or with `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`,
during an upload of a PDF, or when the model looks at its pages, and every answer streaming on
that server stops.

**Cause.** pdf.js and `@cantoo/pdf-lib` build each object of the PDF in one step, and nothing
checks the memory an object takes before it is built. A file built for it holds objects far larger
in memory than in the file, often packed in an object stream: a PDF of 732 bytes, whose object
stream is unpacked twice, ran a heap of 512 MB out of memory at ingest, and a look at the pages of
one of 8 MB ran a heap of 256 MB out of memory. The limits on the number of objects a file declares
do not see such files. A look parses the whole file again, on the server that answers the
question, and takes more than the ingest did. On that server, what `@cantoo/pdf-lib` keeps also
adds up from file to file ([Memory grows with large files or many users](#memory-grows-with-large-files-or-many-users)).

A stream that unpacks to hundreds of MB takes that memory outside the heap, and no such line is
printed: a PDF of 1.6 KB was read with 20 MB of heap, while the process took 1.6 GB of memory and
the server was held for 6 s. A container with less than that left runs out of memory.

**Fix.** Read PDFs you do not trust in child processes with a heap limit of their own: pass the
`extractors` of [`createIsolatedExtractors`](./reference/node.md#createisolatedextractorsoptions) to
`createLargeFiles`. Such a file then runs out of the child's heap, the upload is answered `422`
"report.pdf needed more memory than is allowed for reading one file (512 MB). …" (code
`"out_of_memory"`), and your server goes on. For the memory a stream takes outside the heap, give
the server, or an ingest process of its own, a memory limit too, such as a container of its own
([Deployment](./guides/deployment.md#uploads-and-ingest)). For their documents, do not offer
`view_pages` (`viewPages: false`), or keep no PDF originals. A larger heap only moves the size of
file that does it.

See [Security](./security.md#uploads) and the [measurements](./measurements.md#the-server).

### Letters look wrong, or show as �, in a text file

The model quotes words in letters of another alphabet, or with `�`, or says that the file is not in
UTF-8. The document's metadata, and the summary the upload answered with, has `encoding` (such as
`"windows-1252"`), `replacedCharacters` (a count), or both.

**Cause.** A text, log, CSV, JSON or Markdown file that is not valid UTF-8 is never refused for its
encoding. Since 0.6.0 it is read one of two ways:

- **In an older encoding** (`encoding`), when its lines with letters fit one: windows-1255
  (Hebrew), windows-1256 (Arabic), windows-1251 (Cyrillic), Shift_JIS (`"shift_jis"`, Japanese)
  or windows-1252 (Western European). ISO-8859-8 is read as windows-1255, and ISO-8859-1 as
  windows-1252. Lines of it that are valid UTF-8 are read as UTF-8.
- **As UTF-8**, as 0.5.0 read every file that was not UTF-16: when at least as many lines count as UTF-8 as count as
  not (a line counts as UTF-8 when it holds at least as many characters of more than one byte as
  characters that are not valid); when at most one line in 200 is not UTF-8, ASCII lines counted
  (a log cut at a byte count, a stray byte, a binary body in a log line); and when no older
  encoding fits.

Each character that was not valid in the encoding the file was read in is stored as `�`, and
counted in `replacedCharacters`. The model is told how the file was read: its card says
`This file is not in UTF-8. Its text was read as windows-1255: if its letters look wrong, ask the user to save it as UTF-8.`,
or `3 characters of this file were not valid UTF-8, and show as �.`, and a file sent whole says it
in its first frame line (`, read as windows-1255`).

Letters come out wrong where the encoding is not recognized, or is taken for another:

- Greek, Turkish, Central European (Polish, Czech, windows-1250), Icelandic, KOI8-R, the DOS code
  pages (437, 850, 866), Chinese, Korean and Thai are not recognized: the file is read as UTF-8,
  and almost every character of it outside ASCII is `�`, even one that windows-1252 has (Turkish
  `güzel` comes out as `g�zel`). So is a Japanese file with few or no kana, such as names and
  addresses in kanji only.
- Hungarian in windows-1250 or ISO-8859-2 is read as windows-1252, with õ and û in place of ő and
  ű: a search for a word with ő or ű finds nothing.
- ISO-8859-15 is read as windows-1252 when it has no œ: its € comes out as ¤. In windows-1252, œ
  is ½, which looks wrong inside a word (`c½ur`), and an encoding fits only when at most one word
  or sign in 50 looks wrong: in French prose, one such word needs about 20 lines with accents
  around it. So a file with œ in its words, a menu or a line or two of French, most often fits no
  encoding: it is read as UTF-8, and each of its accented letters is `�`.
- A file of a line or two, or of one long line (minified JSON), can be read in a wrong encoding:
  Greek capitals as windows-1251, `Straße` saved in DOS code page 850 as windows-1252 `Straáe`.
- In a log where at most one line in 200 is not UTF-8, those lines are `�` even when they are in
  an older encoding.
- A document that 0.5.0 stored from a file in an older encoding holds `�` where its letters were:
  0.5.0 read every file that was not UTF-16 as UTF-8.

**Fix.** Ask the user to save the file as UTF-8 and attach it again: in Excel, Save As
"CSV UTF-8 (Comma delimited)"; in Notepad, Save As with the encoding UTF-8. Show `encoding` and
`replacedCharacters` of the upload's summary next to the file ("read as windows-1255", "3
characters could not be read"), so that the user sees it before asking. Ingest again the files
that 0.5.0 stored.

See [`DocumentMeta`](./reference/library.md#documentmeta) and
[Text encodings](./guides/pdfs.md#text-encodings).

## Questions and answers

### "The last message must be the user's."

**Cause.** `askWithFiles` and `askGemini` take the conversation with the new question last. This is
thrown when `messages` is empty (or `askGemini` got neither `messages` nor `contents`), or when it
ends with an answer or a tool round.

**Fix.** Append the question: `[...history, { role: "user", text: question }]`. Stored tool rounds
(`toolTurns`) go between the question they belong to and its answer, never after the new question.

See [Conversations](./guides/conversations.md).

### `TypeError: owner is required: requireOwner is on (the default)`

The whole message: `owner is required: requireOwner is on (the default). Pass the user's ID as owner, or create the library with requireOwner: false to allow calls without one.`
It comes from `ingest`, `getMeta`, `getOriginal`, `delete`, `list`, `touch`, `update`, `prepare`,
`toolsFor`, `tools` without `access`, or a question (`askWithFiles`, `askStream`'s `result`,
`askGemini`; `run.error` says "Something went wrong."), before the store or a model is asked
anything. `createDocumentHandlers` throws its own:
`createDocumentHandlers needs getOwner: the library requires an owner on every call (requireOwner, on by default). Give getOwner, or create the library with requireOwner: false.`

**Cause.** Since 0.99.9 owner checks are on by default (`requireOwner`, off from 0.9.0 to 0.10.x),
and the call names no owner. Code written for 0.10 that never passed one now fails here.

The same change shows in code that already passes owners: documents stored without one, by an
earlier version, now read as missing. `getMeta` gives `undefined`, a question throws
`DocumentsNotFoundError` (below), `list` leaves them out. Nothing is deleted.

**Fix.** One of two:

- **Name the owner on every call**: `owner: userId` on `ingest` and on each question,
  `{ owner: userId }` as the `access` of `getMeta`, `delete`, `list` and the others,
  `access: { owner: userId }` for `tools` and `toolsFor`, and `getOwner` for the upload handlers.
- **Turn the checks off**, for an application with one user (a script, a command-line tool), or one
  that lets anyone with a document's ID use it: `createLargeFiles({ store, requireOwner: false })`.
  Everything then works as in 0.10, documents without an owner included.

Documents stored without an owner can be read again with `requireOwner: false`, or stored again
with an owner: [Upgrading to 0.99](./upgrading-0.99.md#owner-checks-are-on-by-default).

### `DocumentsNotFoundError`: "A document is no longer available: doc_…. Upload it again."

With several: `2 documents are no longer available: doc_…, doc_…. Upload them again.` The upload
handler's `get` answers `404` with `This file is no longer available.` for the same causes.

**Cause.** The question is thrown out before any model request because one of its `documentIds`:

- expired: documents are kept for `ttlMs`, 72 hours by default;
- was deleted;
- belongs to another `owner`, or has an owner while the question passes none. A document with an
  owner is reported as missing, never as forbidden;
- has no owner while the library checks owners (`requireOwner`, the default since 0.99.9): a
  document stored by an earlier version without one, or by a library made with
  `requireOwner: false` ([the entry above](#typeerror-owner-is-required-requireowner-is-on-the-default));
- was stored in a `MemoryDocumentStore` of another process, or of this one before it restarted;
- has lost its text in the store while its metadata stayed (removed outside the library). Since
  0.8.2 such a document is missing here too; before, a question about one read by range failed
  with a plain `Error`;
- is not a document ID at all (`isDocumentId` is false for it).

A chat that is still in use loses its files at `ttlMs` too: the expiry counts from the upload, not
from the last question. Since 0.99.13 `touchOnUse: true` keeps the files a question uses
([Documents that are gone](./guides/conversations.md#documents-that-are-gone)).

**Fix.** Pass the same `owner` to the question as to the upload: the value `getOwner` returned for
the same user. Use a store that every server shares and that outlives a restart. Show the user which
files to attach again: `error.ids` names the IDs, and your chat knows their file names. A
document's `expiresAt` says when it goes. Since 0.9.0 a question can go on without them:
`onMissingDocuments: "drop"` answers from the other files and lists the missing ones in
`result.missing`, and a function can ingest them again from uploads you kept
([missing documents](./reference/ask.md#missing-documents)).

See [Storage](./guides/storage.md) and
[`DocumentsNotFoundError`](./reference/ask.md#documentsnotfounderror).

### In your own loop, a tool answers "doc_… is no longer available on the server" for a document that is there

The whole result: `{ "error": "doc_… is no longer available on the server. Ask the user to attach the file again." }`,
from `read_document`, `search_document`, `get_document_overview`, `analyze_whole_document` or
`view_pages`.

**Cause.** Besides a document that expired or was deleted after the question was planned: since
0.6.0, `files.tools()` compares the owner stored with each document with the `owner` of the
`DocumentMeta` it was handed, and answers a mismatch as a document that is gone. Your loop passes
metadata that it built itself (from an ID, from its own database, from a `DocumentSummary`, which
has no owner) or that another owner's call returned. Under `requireOwner: false`, a document stored
without an owner is not checked.

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
- **The library does not read that part.** The pictures of DOCX and PPTX files are not read, nor
  the charts of a workbook. Comments of a DOCX and speaker notes of a PPTX are read since 0.8.0:
  a document ingested before keeps the text it had until it is uploaded again.
- **The document was not in the question.** Only the `documentIds` of this question are planned
  and searchable.
- **The server cut the prompt.** Some local servers shorten a prompt longer than the context they
  run with, without an error. The model answers from what was left. Set `contextTokens` on the
  adapter to the window the server really runs with.

See [How it works](./how-it-works.md) for the plan and the tools, and
[Tools](./reference/tools.md) for what each tool returns.

### The answer quotes text that the document does not show

The model cites a line that starts `[Hidden text, not shown in the document]`, or a slide whose
heading says `(hidden, not shown in the slide show)`, and the user does not see it in the file.

**Cause.** Since 0.6.0 the text of a DOCX run that Word hides (`<w:vanish/>`) is kept and marked: it
comes after the text of its paragraph that shows, each of its lines starting with that mark. A
slide that the slide show skips keeps its text, and its heading says so. The mark tells the model
what a reader of the document does not see. It is a hint: text hidden through a style, white or
tiny text, and hidden shapes are read as ordinary text, without it.

**Fix.** Nothing breaks. To have the model leave hidden text out of its answers, or name it as
hidden, say so in your `system` instruction.

See [PDFs and other formats](./guides/pdfs.md#docx-and-pptx).

### With `showCitations: false`, the answer reads only "lines 2 and 3" or "שורה 8"

**Cause.** The model answered with citations and nothing else, such as `(app.log L2, L3)`. Hidden,
they would leave the answer shown empty while `answered` is true. Since 0.99.13 the lines they cite
are shown in words instead, in Hebrew when the answer or the question is Hebrew, and a
`citations_only` notice (`display` `"none"`) says so. `result.citations` and `modelText` keep the
citations as the model wrote them. Until 0.99.12 such an answer was shown empty.

**Fix.** Nothing breaks. Show the notice as a hint that the model pointed at lines without saying
more, or ask again. The history keeps `modelText`
([Conversations](./guides/conversations.md#storing-a-conversation-and-asking-the-next-question)).

### `answered` is `false`

**Cause.** The model's last turn had no text:

- **The provider refused the prompt.** `blockReason` says why: Gemini's own reason, Claude's
  `refusal` (with its category: `refusal: <category>`), or `content_filter` from an
  OpenAI-compatible server. Nothing more is asked after a refusal.
- **The reply was cut off before any text.** `finishReason` is `MAX_TOKENS` (Gemini), `length`
  (OpenAI-compatible) or `max_tokens` (Claude): the output limit was spent, most often on thinking.
- **The reply was filtered** in the request that had to be the answer.
- **The request for the answer came back without text twice.** A reply to it that is empty, or
  holds a tool call the model was told not to make (Gemini's `UNEXPECTED_TOOL_CALL` or
  `MALFORMED_FUNCTION_CALL`), is asked for once more, with a note that is not kept. `steps` then
  holds `The model's answer was empty: it was asked again` or
  `The model called a tool instead of answering: it was asked again for the answer`. That second
  try is one of the two a question may make, and is not made after a refusal, a filter, a reply
  cut off with nothing in it, or once `limits.requests` or `limits.inputTokens` is reached. In
  0.5.0 the question ended at the first empty reply to the request for the answer.

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
  (`FileDocumentStore` and `MemoryDocumentStore` have both), or (0.9.0) the document was ingested
  with `original: { ref }` and the library has `originals`;
- the document was ingested after that: one ingested before has no file kept
  (`meta.originalKept` is not `true`);
- every model of the question can be sent a file: not `openAiCompatible()` without `pdfInput` or
  `imageInput`, not `anthropic({ toolFilePlacement: "none" })`;
- every model takes one kind of file (0.99.9): `gemini()` or `anthropic()` (PDF) next to
  `openAiCompatible({ imageInput: true })` (images) share none;
- the PDF is not sent to the model as the file itself (`documents`, 0.99.9): then the model has
  every page, and needs no look;
- the question does not pass `viewPages: false`.

A model that has the tool and does not call it may have found the answer in the text.

A model that looked and says it cannot see the page is most often Gemini 2.5 with the default
`toolFilePlacement: "inside"`: it accepts the pages inside a function response, bills them, and
does not see them.

**Fix.** Turn on `keepOriginals: ["pdf"]` and upload the PDFs again. For Gemini 2.5, pass
`toolFilePlacement: "beside"` to `askGemini` or `gemini()`. With `@cantoo/pdf-lib` missing, every
look fails: install it ([above](#a-pdf-docx-or-pptx-upload-fails-needs-the-optional-dependency)).

See [PDFs and other formats](./guides/pdfs.md).

### `view_pages` says a file "changed on the server since it was read"

The model reads `report.pdf changed on the server since it was read. Attach it again to look at its
pages.`, and `files.getOriginal` gives `undefined`.

**Cause.** The document was ingested with `original: { ref }` (0.9.0), and the file at that ref is
no longer the one that was ingested: its size or SHA-256 differs from `meta.original`. It was saved
again under the same name, cut short by a copy that failed, or edited. Its pages would not match the
text the model has, so none are shown.

**Fix.** Keep each upload under a name of its own, and never write over a file a document names.
To use the new file, ingest it again (`ifExists: "replace"` under the same `id`).

### `view_pages` answers "Showing pages as images needs unpdf 2 or later"

The model reads `report.pdf: Showing pages as images needs unpdf 2 or later, which runs on Node 24 or later.`,
or `…needs the optional dependency "@napi-rs/canvas".`, and answers from the text.

**Cause.** A model of the question takes images and no PDF (`openAiCompatible({ imageInput: true })`,
or `toolFileTypes` of your own), so `view_pages` draws each page as an image (0.99.9). That needs
unpdf 2 or later and `@napi-rs/canvas`, and unpdf 2 runs on Node 24 or later. The tool is offered
without them, and each look answers with what is missing. `…is installed but could not be loaded
(…)` is a canvas binary of another platform, or a broken install.

**Fix.** On Node 24 or later, `npm install unpdf@2 @napi-rs/canvas`, on the machine or in the image
the server runs on ([Deployment](./guides/deployment.md#optional-dependencies-in-production-images)).
On Node 22, use a model that takes PDF (`pdfInput: true`), or offer no pages:
`viewPages: false`. See [Pages as images](./guides/pdfs.md#pages-as-images).

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

### "Could not read any part of app.log: …"

`steps` holds, for example,
`Read all of app.log for “Summarize.” — failed: Could not read any part of app.log: The model refused the key or token it was sent (HTTP 401).`
A part that failed among parts that were read is counted in the result's `parts_that_failed`, and
its notes say `[This part could not be read: The model was busy (HTTP 429).]`. Since 0.99.13 such a
read's step ends in ", incomplete", its result has a `note` that tells the model to say the answer
is incomplete, and a `read_incomplete` notice gives the parts that failed (`counts`).

**Cause.** The model requests of the parts failed, after their retries. Since 0.6.0 the model, the
step and `toolTurns` are told why by the error's kind, its HTTP status or its connection code, never
by its message, which can name a project, a host, a key or a URL:

| Reason | The error |
|---|---|
| `The request was larger than the model takes (HTTP 400).` | Kind `context_overflow`: a part too large for the model, even read in halves. |
| `The model's quota has run out (HTTP 429).` | Kind `quota`. |
| `The model was busy (HTTP 429).` | Kind `rate_limit`. |
| `The model took too long to answer.` | Kind `timeout`, a part read that ran past its 180 s, an `AbortSignal.timeout` of your own, or an undici headers or body timeout. |
| `The model could not be reached.` | Kind `unreachable`, or a connection code on the error or its cause (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET`…). |
| `The model failed on its side (HTTP 503).` | Kind `server`. |
| `The model refused the key or token it was sent (HTTP 401).` | Kind `auth`. Without a status since 0.99.13: your key or token function threw (it was `The model request failed.` with Gemini, `The model could not be reached.` with OpenAI and Claude). |
| `The model refused the request (HTTP 400).` | Kind `invalid`. |
| `The model's reply could not be read (HTTP 200).` | A reply that was not JSON, such as a gateway's page. |
| `The model returned no text (SAFETY).` | A reply with no text to the package's part reader. The provider's reason is given only when it is a plain word. |
| `The model request failed.` | Any other error, such as a plain `Error` that a `generate` of your own throws. |

The HTTP status is given when the error has one. The store's own errors keep their message:
`[This part could not be read: The document store could not be read (EIO). Try again.]`.

**Fix.** Act on the kind, as for the chat requests ([Errors from the model](#errors-from-the-model)).
To see the provider's words, log them where they arrive: in the `fetch` option of the adapter, or
in a `generate` of your own. A `generate` of your own can give the model a reason by throwing an
error with a `kind` or an HTTP `status`.

See [`analyze_whole_document`](./reference/tools.md#analyze_whole_document).

### The model repeats the same calls

`steps` holds `… — already shown above`, or the same search in other words over and over, or
`3 more tool calls in this turn were not run (at most 8 a turn)` (for one:
`1 more tool call in this turn was not run (at most 8 a turn)`).

**Cause.** A call whose result is still in the conversation in full (the same search, or a read of
lines already shown) is not run again: the model gets a pointer to the earlier result, which costs
no file access. A search in other words is a new call and runs. A model that keeps searching uses
its tool turns, and then must answer. A smaller model does this more often. Two searches in a row
that fail with an error in the same mode get a hint: for `regex`, to try `exact` or `keywords`; for
the other modes, to check the arguments. A search that finds nothing is not a failure and gets no
hint.

Some calls run again by design. With Claude's context editing (an edit `clear_tool_uses_…` or
`compact_…` in `body.context_management`), Claude may no longer have an earlier result, so no call
is answered with a pointer. A read of one line from the tool rounds of an earlier question, and an
exact or regex search that 0.5.0 stored without its last match, run again too.

**Fix.** Nothing breaks: the question still ends with an answer within `limits.toolTurns`, plus one
more request when the answer comes back without text. To cap the cost of a model that loops, lower
`limits.toolTurns`. To loop less, give the searching to a stronger model as an
[explorer](./guides/explorer-model.md), and pass the `toolTurns` of earlier questions back, so that
a follow-up starts from what was already found.

See [Conversations](./guides/conversations.md) and [`AskLimits`](./reference/ask.md#asklimits).

## Errors from the model

A model request that fails, and is not mended by sending it again, reaches you as a
`ModelRequestError`: a `GeminiRequestError`, `OpenAiRequestError` or `AnthropicRequestError`. Its
`kind` says what went wrong, `status` is the HTTP status (0 when no answer came, the model sent
nothing for the whole wait, or a streamed reply was cut off; 200 for a reply that came and could
not be read), and its message is most often the provider's own. Log the message; show your own
words, chosen by `kind`. `partialResultOf(error)` gives what the question found and used until
then.

### `context_overflow`: the request is larger than the model takes

The provider's message, for example Vertex AI's `The input token count exceeds the maximum number of tokens allowed 1048576.`,
with `limitTokens` and `requestedTokens` when the message gives the numbers. A body over a size
limit (HTTP 413) is this kind too. So is a request larger than the tokens a minute
(or a day) that the account allows, though it comes as HTTP 429 or 413 and its words are those of
a rate limit: OpenAI's
`Request too large for gpt-4o in organization org-… on tokens per min (TPM): Limit 30000, Requested 45237.`,
or Groq's `… on tokens per minute (TPM): Limit 6000, Requested 6438 …`. Its `limitTokens` is that
allowance. In 0.5.0, which gave errors no kind, it was sent again three times as it was.

**Cause.** The loop recovers on its own when it can: it shortens older tool results and sends the
request again (at most twice a question), or, before any tool ran, plans the documents again,
once, for a smaller window worked out from the provider's numbers (see
[How it works](./how-it-works.md#a-request-too-large-for-the-model)). A request of this kind is
never sent again as it was. `steps` then holds
`The request was larger than the model takes: older tool results were shortened, and it was sent again`
or `The first request was larger than the model's window of … tokens: the files were planned again to fit it`.
For an allowance a minute they say so:
`The request was larger than the provider allows in a minute: older tool results were shortened, and it was sent again`,
`The first request was larger than the 30,000 tokens a minute that the provider allows: the files were planned again to fit it`,
or, when the message gives no number,
`The first request was larger than the provider allows in a minute: the files were planned again for a smaller request`
(`a day` for an allowance a day). The error reaches you when that was not enough:

- **The history is too long.** The loop never shortens a question or an answer you pass.
- **The model's window is smaller than the budget says.** The budget assumes 1M tokens unless you
  set `contextTokens` on the adapter or in the budget. Each question then starts with a request the
  provider refuses, and plans again; when the window it plans for is still too large, the error is
  thrown.
- **The model may not have its conversation rewritten.** Claude's conversation is append-only, so
  old tool results are never shortened for it.
- **The body is too large for a gateway.** Set `maxRequestBytes` to its limit.
- **The account allows fewer tokens a minute than the model's window.** Every request of a
  question must pass that allowance.

**Fix.** Keep the history under a limit you choose, dropping old tool rounds first, then old turns.
For a model or gateway with smaller limits, set `contextTokens` (and `maxRequestBytes`) on the
adapter (`gemini()`, `openAiCompatible()`, `anthropic()`), or with `askGemini` pass
`budget: { contextTokens, maxRequestBytes }` (or set them in the `budget` of `createLargeFiles`).
For an allowance a minute, set `contextTokens` below it, or raise the account's tier. Keep
`partialResultOf(error).toolTurns` with the conversation, and tell the user to start a new chat or
ask about fewer files.

A provider whose wording the library does not know gives kind `invalid`, and the loop does not
recover. Besides the wording of Gemini, OpenAI and Claude, it knows that of Text Generation
Inference and Together ("… tokens +
max_new_tokens must be <= 32769. Given: 40000 …"), LM Studio ("loaded with context length of only
4096 tokens"), Amazon Bedrock ("Input is too long for requested model."), and the message at the
top of the body that vLLM before its OpenAI-shaped errors, SGLang, FastChat and servers built on
FastAPI send.
`classifyModelError(status, message)` shows how a message is read; a wrapper around your adapter
can set the kind itself ([Your own adapter and loop](./guides/own-adapter-and-loop.md)).

See [Conversations](./guides/conversations.md) and
[Errors and reliability](./guides/errors-and-reliability.md).

### `quota` or `rate_limit`: HTTP 429

**Cause.** Too many requests or tokens for the account. The two kinds differ in one thing: a wait
mends a `rate_limit` (a quota per minute, Gemini's among them) and not a `quota`. The library sends
a `rate_limit` request again a few times, and throws a `quota` error at once. While it waits,
`onActivity` reports it: `The model did not answer (HTTP 429). Trying again in 2 s…`. A whole-file
read reaches a quota per minute first: up to 30 part reads, four at a time. Claude's HTTP 529
(overloaded) is neither: it is kind `server`.

A `quota` is a quota per day, or money: a Gemini quota per day (in the error's `details`, or named
in Vertex AI's message, `Quota exceeded for …requests_per_day…`), OpenAI's `insufficient_quota`,
HTTP 402 (DeepSeek's "Insufficient Balance", OpenRouter's "Insufficient credits"), Claude's "Your
credit balance is too low" (HTTP 400), and Claude's spending limits ("You have reached your API
usage limits", HTTP 400, or HTTP 429 with `enforced_spend_limit_reached`). 0.5.0 gave errors no
kind, and sent each of these that came as HTTP 429 again three times.

A request larger than the tokens a minute allows also comes as HTTP 429, and is
[`context_overflow`](#context_overflow-the-request-is-larger-than-the-model-takes): a wait does not
let it through.

**Fix.** For `rate_limit` under load, wait longer (`retry: { retries: 5, baseDelayMs: 2_000 }`),
raise the quota, or move the searching to an explorer on another model or project. Tell the user to
try again in a minute; `error.retryAfterMs` is the wait the provider named. A `quota` error is for
whoever runs the account: alert them, and tell the user the assistant is not available.

See [Errors and reliability](./guides/errors-and-reliability.md) for every kind and the waits,
[`RetryOptions`](./reference/errors-and-retries.md#retryoptions), and
[Gemini API and Vertex AI](./guides/vertex-and-gemini.md).

### `timeout`: "Gemini sent nothing for 600 s."

Or `Gemini sent nothing for 300 s.`, `The model sent nothing for 600 s.` (OpenAI-compatible),
`Claude sent nothing for 600 s.`. Status 0, kind `timeout`. Since 0.99.13 also
`Gemini took too long to answer (…).`, `The model took too long to answer (…).` and
`Claude took too long to answer (…).`: Node's own `fetch` gave up.

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
- the provider hangs;
- Node's `fetch` (undici) waits 300 s for the headers and 300 s between pieces of the body, and
  cuts the request then, before `firstByteTimeoutMs`. Until 0.99.12 that cut was kind
  `unreachable`, "could not be reached (fetch failed)", sent again 3 times.

**Fix.** For a model that thinks long, raise `firstByteTimeoutMs` (an option of `askGemini`,
`gemini()`, `openAiCompatible()` and `anthropic()`; 0 waits without end), or lower its thinking.
Above 300 s, also pass the adapter a `fetch` whose undici `Agent` waits longer
([Node's own time limits](./reference/errors-and-retries.md#nodes-own-time-limits)). To
fail sooner, lower both waits. Bound the whole question with a `signal` that aborts at your
deadline. Part reads of a whole-file read have a limit of their own, 180 s each: a part that runs
out is tried once more, then counted in the read's `parts_that_failed`.

See [Errors and reliability](./guides/errors-and-reliability.md).

### `unreachable`: "Gemini could not be reached (fetch failed)."

Or `The model could not be reached (…).` and `Claude could not be reached (…).`. Status 0, kind
`unreachable`. Since 0.99.13 also `Gemini could not be reached: its key or token could not be
fetched (ECONNRESET).`: your token function failed on a connection, such as the metadata server
on GKE (see [the next entry](#auth-vertex-ai-refuses-the-token)).

**Cause.** No HTTP answer came: a name that does not resolve, a refused connection, a proxy that
your server must go through, a certificate that Node does not trust (a corporate proxy that
inspects TLS). The request is sent again up to 3 times before you see this. While it waits,
`onActivity` says `The model could not be reached. Trying again…`.

The same kind comes for a reply that began and was cut off on its way: a connection that broke
while the reply arrived, a stream that closed before its end (an empty one too, see
["Gemini's reply ended before it was complete."](#geminis-reply-ended-before-it-was-complete)),
and a reply of HTTP 200 whose body was empty and not of type `text/event-stream`
(`Gemini could not be reached (the reply was empty).`, `The model could not be reached (the reply was empty).`,
`Claude could not be reached (the reply was empty).`). These are sent again too, unless text of
the reply was shown, and `onActivity` says
`The model's reply was cut off on its way. Trying again…`.

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

An error thrown by your `accessToken` function is a `GeminiRequestError` of status 0 since 0.99.13,
with what the function threw as its `cause`: log the `cause`. google-auth-library's "Could not load
the default credentials…" is kind `auth`, `Gemini was sent no key or token: the function that gives
it failed.`, and is not sent again: the application default credentials are missing where the
server runs. A connection that failed while the token was fetched (the metadata server reset,
"fetch failed") is kind `unreachable`, and is sent again. Events tell either one by its kind only
("The model refused the key or token it was sent.", "The model could not be reached."), never in
the token client's words. Until 0.99.12 such an error had no status and no kind, ended the
question without a retry, and with a `syscall` was told "The file could not be read from
storage".

After a 401, a token function is asked for a fresh token once (`{ refresh: true }`), and a `retry`
event with `reason: "auth_refresh"` says so ([Gemini API and Vertex AI](./guides/vertex-and-gemini.md#access-tokens-for-vertex-ai)).

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
- **A file it does not read** (0.99.9): with `documents: { formats: ["pdf", "pptx"] }` on Vertex AI,
  a deck sent as itself fails the question with HTTP 400, a MIME type Vertex does not support for
  the model. Vertex refused Office files on Gemini 3 models.
- **More images than vLLM allows** (0.99.9): with `imageInput`, a request with more pages than
  `--limit-mm-per-prompt` is refused with HTTP 400.

**Fix.** Give the explorer its own `explorerGenerationConfig`. Check the model name and location.
For an OpenAI-compatible server, set `answerWithoutTools: "omit"` or `stream: false`. On Vertex AI,
list `documents: { formats: ["pdf"] }` only. For vLLM, raise `--limit-mm-per-prompt` to the pages a
question may show, or lower `budget.reservedTokens`
([Pages as images](./guides/pdfs.md#pages-as-images)).

See [An explorer model](./guides/explorer-model.md) and
[OpenAI-compatible endpoints](./guides/openai-compatible.md).

### "Gemini's reply could not be read: it was not JSON (text/html)."

The whole message: `Gemini's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.`
From the other adapters it starts `The model's reply could not be read` (OpenAI-compatible) or
`Claude's reply could not be read`. The brackets hold the media type of the response, and are left
out when it has none. Status 200 (the status of the response), kind `invalid`, and the
`SyntaxError` of `JSON.parse` as `cause`.

**Cause.** A reply came with HTTP 200, but its body was not JSON: a gateway, a proxy or a sign-in
page answered with HTML. So does a reply asked for as a stream whose body starts like neither
events nor JSON. It is not sent again: the same page would most likely come back. In a whole-file
read, the part is told `The model's reply could not be read (HTTP 200).`

In 0.5.0 this was the `SyntaxError` itself, with no `status`, and a streamed Gemini request that
got such a page came back as an empty reply. A test of
`error instanceof SyntaxError` no longer matches: test `error.cause instanceof SyntaxError`. Kind
`invalid` alone also covers every other request that the provider refused.

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
- **The first request of a follow-up question.** The tool rounds of an earlier question are sent
  again without their `tool_turns_left` (since 0.6.0), and as their calls alone: a stored round
  keeps no thought signatures or thinking blocks, which the requests of its own question sent
  back. Either one makes that request read the cache only up to the tool rounds of the question
  before it: the documents, the cards and the turns before those rounds still hit. The later
  requests of the question hit as before.
- **The first request after the upgrade to 0.6.0.** The tool guide, the descriptions of
  `search_document` and `analyze_whole_document`, and the frame of every file sent whole changed,
  so the first request of each conversation reads from the cache at most what comes before the
  first text that changed. For a question with files to search, that is nothing on Claude and
  OpenAI-compatible endpoints, where the tools come first, and at most your own system text on
  Gemini, where the tool guide follows it in the system instruction. For a question whose files
  are all sent whole, it is your own system text, and `view_pages` with its guide when the pages of
  a PDF can be looked at. With Claude's `cache_control`, that request is a cache write.
  While servers of both versions answer the same conversations, each switch misses again.

**Fix.** Set ceilings for one question, and log the usage per user or session:

```ts
import { askGemini } from "llm-large-files/gemini";

const result = await askGemini({
  files, endpoint, documentIds, messages, owner,
  limits: {
    inputTokens: 1_000_000, // no tool request that, with the answer, would pass it
    requests: 20,           // chat requests and part reads together
    wholeDocumentReads: 0,  // no whole-file reads
  },
});

const { inputTokens, cachedInputTokens, outputTokens, requests, byModel } = result.usage;
console.log({ owner, inputTokens, cachedInputTokens, outputTokens, requests, byModel });
```

The ceilings are checked before each request that may use tools, looking ahead: when what the
question spent, the next tool request and the answer would pass `inputTokens`, the next request is
the answer. So a question can pass `inputTokens` by about one request, the answer's, with the
results of the last tool turn in it: set it that far below what must not be passed
([Costs and limits](./guides/costs-and-limits.md#the-ceiling-looks-ahead)). A
cheaper [explorer model](./guides/explorer-model.md) takes the searching and the part reads off the
model that answers.

See [Costs and limits](./guides/costs-and-limits.md) and [`AskLimits`](./reference/ask.md#asklimits).

### Every follow-up question searches again

**Cause.** The tool results of a question are in its result (`toolTurns`), not in the library. A
follow-up whose `messages` hold only the text of earlier turns has none of them.

**Fix.** Keep `result.toolTurns` with the conversation, and pass them back between the question
they belong to and its answer. A follow-up then gets a pointer to an earlier result instead of
running the same call again. With Claude's context editing, calls run again all the same (see
[above](#the-model-repeats-the-same-calls)).

See [Conversations](./guides/conversations.md).

### A question takes minutes

**Cause.** A question makes up to `limits.toolTurns` (12) chat requests, one after another. A model
that thinks takes long on each; a whole-file read adds its part reads, four at a time, each up to
180 s; a request that failed waits before it is sent again (up to `retry.maxDelayMs`, 60 s, when
the provider asks); a silent model is waited for 600 s, twice. Nothing streams while an explorer
works.

**Fix.** Show `onActivity` to the user: it says what the question is doing
(`Search app.log (exact) for “timeout”…`, `Writing the answer…`, and each retry). The events of
`askStream` or `onEvent` say more: each tool call, the parts of a whole-file read, and the retries
of its requests ([events](./reference/events.md)). Bound the time
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
  text, and the parsers of PDF, DOCX, PPTX and XLSX take memory of their own while they read, in
  the same heap as everything else, unless they run in the child processes of
  `createIsolatedExtractors`.
- `@cantoo/pdf-lib`, which reads PDFs for the page check, the picture marks and `view_pages`,
  keeps every name and every reference it has read for the life of the process. Real PDFs add
  little, as they share most of them, but each crafted one with other names or object numbers adds
  its own, and it never comes back: 2 MB of different names kept 37 MB, and files of 9 KB that each
  declared a million new objects kept about 140 MB each, until the fourth ingest ran a heap of
  512 MB out of memory, or the seventh look a heap of 1 GB. On the server that answers `view_pages`,
  it comes back only when that server restarts.

**Fix.** Give a store of your own `readTextRange` (and `putIndex` and `getIndex`, so that no pass
over the text is needed first). Lower `cacheBytes` and `maxConcurrentScans` to fit the memory of
the server, and `maxUploadBytes` and `maxTextBytes` to the files you expect. To keep a file that
needs too much memory from stopping the server, read it in a process of its own with its own heap
limit, as `createIsolatedExtractors` does: a worker thread does not keep it apart. Its children,
replaced after 50 files, also give back what `@cantoo/pdf-lib` kept, and so does a process for each
ingest when it ends. For the documents of users you do not trust, do not offer
`view_pages` (`viewPages: false`), or keep no PDF originals.

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
fails. When the error behind it has no `code`, the message has none. Inside a question's tool call,
the model gets it as the call's error, and `steps` shows
`… — failed: The document store could not be read (EIO). Try again.`. The upload handler's `get`
and `remove` answer `503` with that message (since 0.9.0; they answered `500`). Since 0.9.0 the
errors of writes are `DocumentStoreError`s too, with their own messages: "The document could not be
stored (EIO). Try again." from `files.ingest`, "The document could not be deleted (EIO). Try
again." from the store's own `delete`, "The document store could not be cleaned up (EIO). Try
again." from `files.sweep`.

**Cause.** The store failed while it was read: a network volume that did not answer, too many open
files, a database that is down. The documents are not gone.

**Fix.** Show the message (it names no path and no host) and let the user try again; do not ask
them to upload again. Log `error.cause`, the store's own error, and `error.code`. Fix the storage.

See [`DocumentStoreError`](./reference/library.md#documentstoreerror) and
[Storage](./guides/storage.md).

### "The document store could not be read (EACCES)" after an upgrade to 0.9.0

Uploads work on the server that took them, and every other server, or a backup or sweep job,
answers `EACCES` for the new documents.

**Cause.** Since 0.9.0, `FileDocumentStore` writes files `0600` and folders `0700`: only the user
that wrote them can read them. The servers or the job run as different users.

**Fix.** Run them all as one user. Or, for users of one group (a Kubernetes `fsGroup`), give every
store `fileMode: 0o640` and `directoryMode: 0o750`, and change the files written since the upgrade
once with `chmod`. See [Deployment](./guides/deployment.md#a-shared-store).

### `DocumentScopeError`: "The scope no longer exists."

An upload into a chat fails with a `DocumentScopeError` of code `"scope_missing"`. The upload
handler answers it `404` `{ "error": "This chat no longer exists." }`.

**Cause.** The store is a `FileDocumentStore` with `scopes`, and the folder of the chat is gone:
your application removed it when the chat was deleted, or never made it. The store makes its own
folder in a chat's folder, never the chat's folder itself, unless `createScopeFolders` is on.

**Fix.** For a deleted chat, nothing: tell the user the chat no longer exists. For a new chat, make
its folder (`mkdir` with `recursive: true`) when the chat starts, or set `createScopeFolders: true`.
See [Storage](./guides/storage.md#files-in-a-folder-per-user-or-per-chat).

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

### `503`: "The document could not be stored. Try again.", or `500` "Upload failed."

**Cause.** A store write that fails is a `DocumentStoreError` since 0.9.0 (it was thrown as it
came, and answered `500` "Upload failed."). The upload handler answers it `503` with its message,
"The document could not be stored (ENOSPC). Try again." when the store's error has a code, and
`Retry-After: 5`. Your database's own message is its `cause`, and may name its host, so it is not
sent, and the handlers log nothing.

An `ingest` of your own that throws a new error in its place, without a status, gets `500`
"Upload failed." since 0.9.0. Before, it got `422` with that error's message, which could name your
database's host (S12). Every case is in the [node reference](./reference/node.md#how-errors-are-answered).

**Fix.** Log `error.cause` where you catch it, and fix the storage. An `ingest` of your own must
pass the `DocumentStoreError` on as it is, or rebuild it, as `ingestInProcess` in
[Deployment](./guides/deployment.md#uploads-and-ingest) does. A route of your own answers it with
`uploadAnswerOf` ([Web app](./guides/web-app.md#filesingest-and-its-errors)).

### `500` "Upload failed." for a file your own `ingest` refused

**Cause.** Since 0.9.0, the upload handler answers `422` only an `IngestError`. A `LargeFiles` of
your own whose `ingest` throws a plain `Error` for a file it refuses gets `500` "Upload failed.",
without its message, which could name a host.

**Fix.** Throw `new IngestError(code, message)` (exported from `llm-large-files`), with a message
written for the user. Its code says why: `"unreadable"`, `"too_large"`, `"no_text"`…

See [Storage](./guides/storage.md) and [`llm-large-files/node` reference](./reference/node.md).

### `503`: "The document could not be stored (ENOSPC). Try again."

**Cause.** The disk of a `FileDocumentStore` is full. (Before 0.9.0 the answer was `500` "Upload
failed (ENOSPC).".) Expired documents are removed when they are
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

**Cause.** Text streams only when the loop asks for it as it is written (`streamText`, on by
default with `onText` and in `askStream`) and the adapter can stream:

- `askGemini` and `gemini()` stream only to an endpoint with a `streamUrl`. `geminiApi()` and
  `vertexAi()` set it; an endpoint you write for a gateway may not.
- `openAiCompatible({ stream: false })` and `anthropic({ stream: false })` do not stream, and a
  server that answers a streamed request in one piece, with JSON, is read whole. `onText` is then
  called once, with the whole text. (A reply that starts like events is read as a stream, whatever
  its content type.)
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

### `text` events come in one piece, at the end of each reply

You listen with `onEvent`, and the `text` events of the answer arrive all at once, after the
model has finished writing.

**Cause.** A listener of the events alone does not change how the model is asked: without `onText`,
`streamText` is `false`, and each reply's text comes in one `text` event once the reply is in.
`askStream` turns it on for you.

**Fix.** Pass `streamText: true` (or use `askStream`):

```ts
import { askWithFiles, type AskEvent } from "llm-large-files";

// files, model, documentIds, messages and owner are those of your question; send() is your own.
declare function send(event: AskEvent): void;
await askWithFiles({ files, model, documentIds, messages, owner, streamText: true, onEvent: send });
```

With it, a reply that fails after its first text is not sent again: the question throws, with what
was shown. With `streamText: false`, such a reply is sent again, but the user waits longer for the
first word, and the whole reply must arrive within the adapter's `firstByteTimeoutMs`. See
[Errors, retries and streams](./reference/errors-and-retries.md#retries-in-events).

### The events stop when the user leaves the page

`writeSseEvents` returns before `run.finish`, and the question ends with an `AbortError`: "The
events stopped being read."

**Cause.** This is expected. When the client goes away, `writeSseEvents` stops reading and ends
the iterator, and leaving an `askStream` (or an `eventStream`) early stops its question, so nothing
more is paid for. `await stream.result` then rejects with the abort, and `partialResultOf(error)`
gives what the question found until then.

When the question goes on instead, you passed a generator that wraps the stream: it stops only when
it next yields, and a question waiting on a long model request goes on until then. Pass the stream
itself, and change what is sent with `map` (return `undefined` to skip an event); or stop it
yourself:

```ts
import type { ServerResponse } from "node:http";
import { askStream, type AskOptions } from "llm-large-files";
import { sseMessageOf, writeSseEvents } from "llm-large-files/node";

export async function answer(response: ServerResponse, options: AskOptions) {
  const stream = askStream(options);
  // Notices the page does not show are skipped; every other event is sent as sseMessageOf sends it.
  await writeSseEvents(response, stream, {
    map: (event) => (event.type === "notice" && event.display === "none" ? undefined : sseMessageOf(event)),
  });
}
```

See [`askStream`](./reference/ask.md#askstreamoptions) and
[when the client goes away](./reference/node.md#when-the-client-goes-away).

### The stream to the browser stops or stalls

The browser's stream ends without your final event, or the events arrive all at once at the end.

**Cause.** A proxy or load balancer in front of your server closes a response on which nothing
arrived for a while, or ends one that runs longer than its limit, or buffers the events. A question
can be silent for minutes: an explorer at work, a model that thinks, a whole-file read.

**Fix.** Write an SSE comment line (`: keep-alive`) every 15 seconds or so, turn off buffering for
the route, and set the proxy's timeout above your own deadline for a question. `writeSseEvents`
sends the comment every 15 seconds and `X-Accel-Buffering: no` for you.

See [Web app](./guides/web-app.md) and [Deployment](./guides/deployment.md).

### "Gemini's reply ended before it was complete."

Or `The model's reply ended before it was complete.` and `Claude's reply ended before it was complete.`.
Status 0, kind `unreachable`.

**Cause.** A streamed reply closed without the event that says why it ended: a proxy or gateway
between your server and the provider cut it. The request is sent again when none of its text was
shown, and `onActivity` says `The model's reply was cut off on its way. Trying again…`. When some
text was shown, it cannot be taken back, and the error reaches you after the user saw part of an
answer.

Two kinds of reply are not cut off, and are read whole. A Gemini stream URL that a gateway answers
in one piece (a JSON array of chunks, as Gemini sends without `?alt=sse`) is read as one reply;
0.5.0 read it as an empty reply. A stream that said it is whole (`[DONE]`, Claude's
`message_stop`) and was then left open, or broke, keeps its reply: the body is read for one more
second at most, and then closed; 0.5.0 waited for such a connection to close, and failed the
request when it broke, as a model that could not be reached.

**Fix.** Keep the text that was shown and mark it as cut off, and keep `partialResultOf(error)`'s
`toolTurns` so that the user's next question starts from what was found. Raise the gateway's
timeouts for streams, or route the stream URL past it.

See [Errors and reliability](./guides/errors-and-reliability.md).

### "The model's reply could not be read: an event of its stream held more than 64,000,000 characters."

Or `Gemini's reply could not be read: …` and `Claude's reply could not be read: …`. Status 200 (the
status of the response), kind `invalid`.

**Cause.** One event of the streamed reply held more than 64,000,000 characters: a server or a
gateway that never ended an event, or sent data lines without the blank line that ends one. It is
not sent again: the same stream would most likely come back. In 0.5.0 nothing capped an event: it
grew one string, read again from its start with each piece that came, so the read slowed with the
square of its size. One event of 32 MB, in pieces of 16 KB, took 12.5 to 13.5 s on Node 24 on
Windows ([Measurements](./measurements.md#the-server)). Data lines without an end grew the same
string.

**Fix.** Look at the stream the server or the gateway sends: an answer of a model fits well within
the limit.

See [`parseSseJson`](./reference/errors-and-retries.md#parsessejsonstream-hooks).

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

The question then throws the signal's reason, at once: since 0.6.0 also with an adapter of your own
that does not stop its request, and when the adapter fails with its own error as it stops. Nothing
is sent after that, and text that arrives later is not shown. What it used until then was paid for:
`partialResultOf(error)` gives its `usage` when the reason is an object, so abort with no reason or
with an `Error`. Questions stopped by one shared signal all throw its one reason, and since 0.7.1
`partialResultOf` gives none of them a result for it: give each question a controller of its own,
or read `partial` from each question's `run.error` event (see
[`partialResultOf`](./reference/ask.md#partialresultoferror)). A request still running when the question stopped may be billed by the provider,
and is not counted there: pass the signal on to the request, as the built-in adapters do.

See [Web app](./guides/web-app.md).
