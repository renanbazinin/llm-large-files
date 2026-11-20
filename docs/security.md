# Security

Uploaded files often hold sensitive data: production logs, contracts, customer exports. This page
says what the library does to keep each document to its owner and each question within bounds,
what it leaves to your application, and what reaches your model provider. Read it before you
deploy.

## Ownership

A document can have an owner: one string, such as the signed-in user's ID or a tenant's, compared
exactly as it is. Set it at ingest, and pass the same owner to every call that reaches the
document:

```ts
import { askWithFiles } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";

// `files` is your createLargeFiles() instance, `model` your adapter (for Vertex AI,
// gemini(vertexAi({ ... }))) and `endpoint` a vertexAi({ ... }) endpoint. `userId` comes from
// your sign-in session, never from the request body. `bytes`, `documentIds` and `messages` (an
// array of `ChatTurn` and `ToolTurn`, which both calls take) are yours.
const owner = userId;

const meta = await files.ingest({ name: "app.log", bytes, owner });
const current = await files.getMeta(meta.id, { owner });
const original = await files.getOriginal(meta.id, { owner });
const result = await askWithFiles({ files, model, documentIds, messages, owner });
// askGemini passes `owner` on to askWithFiles.
const geminiResult = await askGemini({ files, endpoint, documentIds, messages, owner });
const deleted = await files.delete(meta.id, { owner });
```

A document that has an owner is used only by calls that pass that owner. A call with another
owner, or with none, gets what it gets for a document that does not exist: `undefined`, `false`,
`missing`, `DocumentsNotFoundError` or a 404 (the table is in
[Storage](./guides/storage.md#how-ownership-works)).

A caller cannot tell a document of another owner from one that never existed or has expired.
`toDocumentSummary`, which the upload handlers answer with, leaves the owner out.

**A document ingested without an owner is open to every call that has its ID**, with an owner or
without. Its ID then works like a password. An ID is `doc_` and 32 hex digits, a random UUID with
122 random bits: it cannot be guessed, but it can leak. The ID of a document the model reads
through tools is in its card and in the system instruction your model provider receives (so a
model can repeat it in an answer), and IDs end up in your URLs, in browser storage and in logs.
Give every document an owner.

What the owner should be (a user, or a user and a chat session), and how to keep a list of a
session's documents, is in [Storage](./guides/storage.md). The owner stops one user from reaching
another's documents. It does not stop one user from mixing documents of their own sessions: take
`documentIds` from your session record, not from the browser.

### Requiring a signed-in user in the handlers

`createDocumentHandlers` calls `getOwner` for every request. When it returns `undefined`, the
request is anonymous: an upload is stored without an owner, and GET and DELETE reach only documents
that have none. To refuse a request instead, throw an error with a `status` (or `statusCode`)
between 400 and 599: the handler answers with that status and the error's message. Any other error
is answered with a 500 that does not repeat its message. `getOwner` runs before the body is read,
so a refused upload is not buffered.

```ts
import type { IncomingMessage } from "node:http";
import { createDocumentHandlers } from "llm-large-files/node";

// `files` is your createLargeFiles() instance. Your sign-in middleware sets `request.user`.
type SignedInRequest = IncomingMessage & { user?: { id: string } };

export const documentHandlers = createDocumentHandlers(files, {
  getOwner(request) {
    const user = (request as SignedInRequest).user;
    // Returning undefined would store the upload without an owner, open to anyone with its ID.
    if (!user) throw Object.assign(new Error("Sign in first."), { status: 401 });
    return user.id;
  },
});
```

The routes, statuses and the rest of the upload flow are in [Web app](./guides/web-app.md) and the
[node reference](./reference/node.md).

## Tool scoping

`files.tools(documents)` reads only the documents it was made with. A model, or a prompt injected
into a file, that names any other document ID is answered `Unknown document_id …`, with the IDs it
may use. `view_pages` has its own list: the PDFs whose original is kept (in a store that has
`getOriginal`), among the documents passed to `tools()` (`viewPages: true`) or in the list given as
`viewPages`. A call for any other document is refused: one that `tools()` reads as text is answered
that only its text was kept, any other is an unknown `document_id`.

`askWithFiles` and `askGemini` make one tool set per question, from the plan that `prepare` made
with the question's owner. You have nothing to do.

**`files.tools()` takes no owner and checks none.** It trusts the metadata it is given, and checks
only that each document is still in the store and has not expired. In a tool loop of your own, give
it only metadata that `prepare(ids, base, { owner })` or `getMeta(id, { owner })` returned, never
objects built from IDs a client sent:

```ts
import { DocumentsNotFoundError } from "llm-large-files";

// Your own loop: `base` is the size of the rest of your request.
const prepared = await files.prepare(documentIds, base, { owner });
if (prepared.missing.length > 0) throw new DocumentsNotFoundError(prepared.missing);
const tools = files.tools(prepared.plan.searchable);
```

Writing your own loop is covered in [Your own adapter and loop](./guides/own-adapter-and-loop.md),
and every tool, its arguments and its limits in the [tools reference](./reference/tools.md).

## What is sent to model providers

The library sends data only through the adapters: to the provider's API (each adapter's default),
or to the URL you configure instead (an endpoint, a `baseUrl` or `url`, or your own gateway). It
makes no other network request and sends no telemetry.

A question's requests can hold:

- **The whole text of every document that fits**, framed by its name, at the start of the first
  user turn by default (`documentPlacement`). It is in every request of the question, and it is
  planned again, and sent again, for every later question that names the document.
- **A card for each document too large to send whole**: its name, ID, format, size, lines, pages
  and estimated tokens; for a log, its levels, time range and up to 8 message templates; up to 40
  outline headings; and its first 25 lines.
- **Tool results**: excerpts of the text (search hits, line ranges, the first and last lines), each
  up to `toolResultCharacters` (24,000 characters by default); the answer of a whole-file read is a
  tool result too, up to 40,000 characters (or `toolResultCharacters` when that is larger).
- **The whole text of a file read whole** (`analyze_whole_document`), in parts of up to
  `mapChunkTokens`, through the adapter's `generateText`.
- **Pages**: with `view_pages`, a small PDF of up to 5 pages cut from the kept original, for each
  call. The pages stay in the later requests of that question, unless room runs out: older
  results, pages included, are then replaced by a note of what they showed (never for a model whose
  conversation may only grow, as Claude's). They are not kept in `toolTurns`: only that they were
  shown.
- **File names, and the IDs of the documents read through tools.** Not the owner, and no original
  file other than those page cuts.
- **Whatever you pass in `messages`**: earlier questions' `toolTurns`, which hold excerpts of the
  files, and parts in a provider's own form.

All of this but the parts of a whole-file read goes to every model of the question. With an
[explorer model](./guides/explorer-model.md), both models get the conversation with the
documents; the explorer makes the tool calls and alone reads files whole in parts, and the
answering model gets those calls and their results (the read's answer, not its parts), pages
included. When the two are of different providers, the files reach both.

What a provider keeps, for how long, and where it processes the data is set by your agreement with
it and by the endpoint you choose: for Vertex AI, the `location` of `vertexAi()`, which is
`"global"` by default ([Gemini API and Vertex AI](./guides/vertex-and-gemini.md)). Prompt caching
keeps a copy at the provider for a while: the Claude adapter asks for it by default (`cache: true`,
five minutes; `false` sends none), and `documentPlacement: "first"`, the default, puts the
documents where a provider's own cache can reuse them.

## Prompt injection

The model reads text you do not control: the content of the files, their names, the pages it looks
at. A file can hold instructions ("ignore previous instructions…"), and lines that look like the
frame the library puts around a file (`--- End attached file: … ---`). The library does not escape,
filter or detect them.

What limits the damage:

- **The tools only read**, and only the documents of the question ([Tool scoping](#tool-scoping)).
  No tool changes your data or reaches anything but the store and the models of the question (a
  whole-file read sends the file to the model that explores, in parts).
- **The cost of a question is bounded** ([What a question can cost](#what-a-question-can-cost)),
  whatever a file asks for.
- **A file name cannot add lines to the instruction.** At ingest it is reduced to one printable line
  (see [Uploads](#uploads)), and the system instruction quotes it as a JSON string. It is still text
  the model reads, like the file's content.

What a hostile file can still do:

- **Steer the answer**: state false things, leave things out, claim that another file says
  something. `result.evidence` lists the documents, lines and pages each tool call showed the model,
  and the model is asked to cite line numbers: show them, so a user can check.
- **Bring another document of the same question into the answer.** Every document of the question
  is within reach of the tools, so a file can ask for another's text to be written into the answer,
  for example inside a link or an image URL. Treat the answer, and the text that `onText` streams,
  as untrusted: escape it, and do not load images or open links from it on your own. The library
  does not render anything; this is up to your interface.
- **Reach every model of the question**, an explorer model included.
- **Stay in the conversation.** The `toolTurns` you store hold the text the tools returned,
  injected instructions included, and they go back to the model with every later question. A call
  that repeats one of them is not run again: the model is pointed to the stored result.

**Tools that act.** `askWithFiles` takes no tools of your own. To give a model tools that act
(send an email, change a ticket), write your own loop
([Your own adapter and loop](./guides/own-adapter-and-loop.md)), and treat every call the model
makes as untrusted input: check it, and ask the user before anything that cannot be undone.

**History from the client.** Keep each conversation, with its `toolTurns`, on your server. The loop
sends stored tool rounds, and parts in a provider's own form, as they are. A client that could send
its own could put any text into what the model takes for a tool result, that is, for what a file
says, and any provider part (for Gemini, any part of `contents`) into the request.
[Conversations](./guides/conversations.md) covers storing them.

## Storage and retention

- **Expiry.** A document expires `ttlMs` after its upload (72 hours by default). Its `expiresAt` is
  set at ingest and no call moves it. `ttlMs: Infinity` keeps documents until they are deleted
  (`expiresAt` is then `NEVER_EXPIRES`). An expired document is never returned, by any call, on any
  server. Set the time to live to match your data policy.
- **Removing expired files is up to you.** `files.sweep()` asks the store to remove expired
  documents and returns how many it removed. Nothing calls it for you: run it on a schedule, from
  one place ([Deployment](./guides/deployment.md)). A store without `sweep` removes nothing, and
  `files.sweep()` returns 0. `FileDocumentStore` also removes an expired document when it next reads
  its metadata, and its `sweep` removes the files of failed uploads once they are `orphanAgeMs` old
  (one hour by default). `FileDocumentStore`'s `sweep` throws nothing: a directory it cannot read
  gives 0, and a document it cannot remove is left for the next sweep. Watch the count it returns,
  and the volume, to know that expired files really go.
- **A delete takes effect on every server that shares the store, from the next tool call on.**
  Every use of a document first asks the store whether it is still there. A copy kept in memory
  (within `cacheBytes`, 256 MB by default) is used only after that, and dropped when the document
  is gone.
- **What a delete or an expiry does not reach.** The `toolTurns` you stored with a conversation hold
  excerpts of the files word for word, up to `toolResultCharacters` each, and are sent again with
  later questions. Neither reaches the answers, steps and evidence you stored, your logs, or what
  your model provider keeps. To forget a document, also drop the tool rounds that name it from the
  stored conversation ([Conversations](./guides/conversations.md)).
- **`FileDocumentStore` writes plain files** in one directory: `<id>.txt`, the text; `<id>.json`,
  the metadata (owner, file name, MIME type, sizes, dates, outline headings and, for a log, its
  message templates); `<id>.idx`, a line index; `<id>.bin`, the original with `keepOriginals`; and
  `.tmp` files while it writes. Nothing is encrypted, and a delete removes the files without
  overwriting them. Use an encrypted volume, or write a `DocumentStore` over storage with encryption
  at rest ([Storage](./guides/storage.md)).
- **No path traversal.** Only IDs that match `DOCUMENT_ID_PATTERN` (`doc_` and 32 lowercase hex
  digits) reach the file system. File names never become paths.
- `MemoryDocumentStore` keeps everything in the memory of one process, until it restarts. It is for
  tests and single-process demos.

## Original files

With `keepOriginals` (for example `["pdf"]`), the uploaded file itself is stored next to its text
(`<id>.bin` in `FileDocumentStore`). That is off by default, and a store without `putOriginal`
keeps none. When you turn it on:

- **More is kept than before.** The text of a PDF leaves out its pictures, signatures, stamps and
  hidden layers; the file has them all, and its metadata (author, software, dates). Treat the store
  as you treat the uploads themselves.
- **It follows the document.** The file has the document's owner and its expiry.
  `files.getOriginal(id, { owner })` returns it only to the document's owner, or to any caller with
  the ID when the document has none. It returns `undefined` once the document has expired, and
  `delete` and `sweep` remove the file from disk. A store of your own must do the same in its
  `delete` and `sweep`.
- **Serving it is up to you.** `createDocumentHandlers` has no route that returns an original. If
  you send the bytes of `getOriginal` to a browser, do not take the content type from the stored
  `mimeType`: the client declared it at upload ([Uploads](#uploads)). Choose it from `format`, and
  send the file as a download (`Content-Disposition: attachment`).
- **It takes space.** Up to `maxUploadBytes` (100 MB) per document, for `ttlMs` (72 hours). Lower
  either, or sweep more often, if disk is short.
- **Pages go to the model.** `view_pages` sends the pages the model asks for to every model of the
  question, as the text of the file already goes. A PDF that is encrypted only to restrict printing
  or copying is opened with an empty password, and the cut is not encrypted: the restriction does
  not travel with it. A PDF that needs a password to open is not shown.

How `view_pages` works, and what to weigh before you keep originals, is in [PDFs](./guides/pdfs.md).

## Reading PDFs for pages and pictures

Two features read the whole PDF into objects with `@cantoo/pdf-lib`, in your process, on a file a
user uploaded:

- **`view_pages`** reads the kept original again for every call, to cut the pages out of it.
- **Picture marks** read every PDF at ingest, when `@cantoo/pdf-lib` is installed, whether or not
  originals are kept. A page that shows a picture or a drawing then gets the line
  `[Picture on this page. This text cannot show it.]`.

What bounds them:

- **Memory.** About twice the size of the file, plus 1 to 1.6 KB for each object in it
  ([measured](./measurements.md#what-a-cut-costs-the-server)). Before reading,
  the library looks up the number of objects the file declares. `view_pages` refuses a file that
  declares more than 1,000,000 objects, or more than 60% of the free heap holds at 1,700 bytes an
  object: the model is told
  `report.pdf: This PDF has 1,200,000 objects, too many to cut pages from it in memory.`
  Picture marks skip a file past 150,000 objects: it is ingested with no page marked. Both checks
  trust what the file declares: a file that declares fewer objects than it has, or none, is read.
- **Time.** Reading cannot be interrupted once it has started, not even by the question's `signal`.
  It pauses every 4,000 objects so other requests get a turn, but a crafted file can still hold the
  process for seconds ([Measurements](./measurements.md)). `view_pages` has no time limit. Picture
  marks stop after 5 seconds of work once the file is read, and then no page is marked; the reading
  itself has no limit.
- **Errors** are caught. `view_pages` tells the model why the pages cannot be shown, and the model
  answers from the text. Picture marks that fail leave every page unmarked.

To turn them off: without `keepOriginals` for PDFs, `view_pages` is never offered
(`viewPages: false` turns it off for one question). Picture marks are turned off in the PDF
extractor, or by not installing `@cantoo/pdf-lib`; a `view_pages` call then fails too, so keep no
PDF originals either.

```ts
import { createLargeFiles, createPdfExtractor, FileDocumentStore } from "llm-large-files";

const files = createLargeFiles({
  store: new FileDocumentStore("./data/documents"),
  // No picture marks: PDFs are not read with @cantoo/pdf-lib at ingest.
  extractors: { pdf: createPdfExtractor({ pictures: false }) },
  // No keepOriginals: no original is kept, so view_pages is never offered.
});
```

For uploads you do not trust, run ingest and the questions in a worker thread or a separate
process, with a memory limit and a timeout ([Deployment](./guides/deployment.md)). The parsers of
PDF text and of DOCX and PPTX files then run there too ([Uploads](#uploads)).

## Uploads

- **Size.** `maxUploadBytes` is 100 MB by default. `createDocumentHandlers` refuses a larger
  `Content-Length` before reading, and counts the body as it reads it, stopping at the limit: 413
  "The file is larger than the 100 MB upload limit." When a body parser in front (such as
  `express.raw()`) has already read the body, it buffered it under its own `limit`: set that one
  too. `files.ingest` checks the bytes you give it, which are already in memory.
- **Memory.** The handlers buffer the whole upload, up to `maxUploadBytes`, before reading its
  text, and an ingest then holds several copies of the text at once (several times the size of the
  file), on the main thread. Cap concurrent uploads in front (a reverse proxy, a rate limiter), or
  ingest in a worker: [Deployment](./guides/deployment.md) has measurements and a worker.
- **Parsers.** PDF text is read with `unpdf` (pdf.js), pages and pictures with `@cantoo/pdf-lib`,
  and DOCX and PPTX are unpacked with `jszip`. They are optional dependencies, and they run on
  untrusted input in your process. Keep them updated, and for high-risk deployments move extraction
  to a worker or a sandbox.
- **Zip bombs.** A DOCX or PPTX is unpacked a piece at a time, and refused as it grows past 100
  times its size (after the first 16 MB) or past 128 MB of XML: "This DOCX unpacks to more than
  16 MB, over 100 times its size. A file that grows that much is not read: it may be a zip bomb. Save
  it as text or PDF, and attach that." Only the parts that hold text are unpacked (in a DOCX the
  document, its headers, footers, footnotes and endnotes; in a PPTX the slides, not their speaker
  notes). Pictures and fonts stay packed.
- **Binary files are refused**, with a message for the user: "This file looks binary, not text…".
  Compressed ones (`.gz`, `.zip`) get a message that says to decompress first.
- **Scanned PDFs** (no text at all) are refused, unless PDF originals are kept (`keepOriginals`
  includes `"pdf"` and the store has `putOriginal`) and the file has at most `scannedPdfPages` pages
  (30 by default): their pages can then be shown.
- **File names** are reduced at ingest to one printable line: the last path segment, without
  control characters, line breaks or text-direction overrides, at most 255 characters (`file` when
  nothing is left).
- **The MIME type is the client's word.** The handlers take it from an `X-File-Type` header, or
  from `Content-Type` unless that is `application/octet-stream`. The format is picked from the file
  name first, then from it. It is stored, and returned in summaries: do not trust it.
- **Text is cleaned.** Control characters other than tab and line breaks, and terminal escape
  sequences, are removed. An `ESC ]` without its end on the same line loses only those two
  characters, not the lines after it.

Formats, optional dependencies and the messages of refused files are in [PDFs](./guides/pdfs.md);
the upload routes in [Web app](./guides/web-app.md).

## Regex search

The model writes the regex, and the model reads untrusted file text, so a file can ask for a slow
pattern. These bound the cost:

- **Refused up front:** a pattern longer than 300 characters, one that is not valid, and one with a
  nested quantifier such as `(a+)+`. The model reads why. The nested-quantifier check is a quick
  filter, not a guarantee: `(a|a)+$` and `((a+))+$` pass it.
- **3 seconds for one search.** Node's `vm` timeout interrupts a match that is still backtracking.
  The search returns what it found, with the note "The scan stopped early; the total is a lower
  bound."
- **Slices of 250 ms.** The scan runs a slice at a time, and other requests get a turn between two
  slices. A line that two whole slices cannot get past ends the search: a pattern stuck on one line
  costs three slices at most, under a second, not 3 seconds.
- **6 seconds for the regex searches of one tool set** (`REGEX_BUDGET_MS`). `askWithFiles` and
  `askGemini` make one tool set per question; in your own loop, `regexBudgetMs` of `files.tools()`
  sets it. Past it, a regex search is refused: "The time for regex searches is used up for this
  answer. Search with mode "exact" or "keywords" instead." The regex searches of one turn run one
  after another, each with what the ones before it left.
- **8 tool calls of one model turn** are run (`limits.callsPerTurn`), 4 at a time. The others are
  answered "Not run: one turn runs at most 8 tool calls. Send this call again if you still need it."

The 6 seconds are per question, not per process: several questions at once each have their own. A
slice is synchronous, so a slow pattern holds the event loop for up to a quarter of a second at a
time. If that matters for the latency of other users' streams, run the questions in a worker thread.

What does hold per library (per `createLargeFiles` call, so per process when you create it once
per process, as [Deployment](./guides/deployment.md#what-lives-where) advises): scans of documents
read by range (searches, counting the parts of a file) run at most `maxConcurrentScans` (4) at a
time, and the others wait their turn; the documents kept ready in memory between tool calls take at
most `cacheBytes` (256 MB).

## What a question can cost

A file can ask a model to do expensive things, and a model can decide to on its own. These bound one
question, whatever the model:

- **Chat requests:** `limits.toolTurns` (12), counting the answer. Tools run in all but the last,
  with at most `limits.callsPerTurn` (8) calls run in each.
- **Whole-file reads:** one of each document (`limits.wholeDocumentReads`). A read is up to
  `maxMapChunks` (30) part requests of up to `mapChunkTokens` each (100,000 at the default window of
  1M tokens: 3M input tokens), plus the requests that merge the notes and write the read's answer.
  With an explorer model, that model reads the parts.
- **Pages:** at most 5 a call, and for the question what half of `reservedTokens` holds at the
  adapter's `pageTokens`. They stay in the later requests of the question, which bills them again,
  unless room runs out and older results are replaced by a note of what they showed (never for a
  model whose conversation may only grow, as Claude's).
- **Requests sent again:** a request that failed is retried (`retry.retries`, 3 by default). One
  the provider refuses as too large is sent again smaller, at most twice a question (never for a
  model whose conversation may only grow, as Claude's), and a question whose first request is too
  large, before any tool ran, is planned again once. None of these takes a tool turn. A retried
  request counts once in the usage.
- **Ceilings, unset by default:** `limits.inputTokens` and `limits.requests` cover the whole question,
  part reads included. A whole-file read that would pass one is refused before it starts. Once
  `inputTokens` is reached, no more tools run, but the request that crosses it has already been
  sent, and the answer request is still sent with the whole conversation: a question can pass the
  ceiling by up to about two requests (the one that crosses it, and the answer). `requests` counts
  answered requests and keeps one for the answer.

`result.usage` is what a question used, in all and for each model. A question that fails or is
stopped returns nothing: `partialResultOf(error)` gives what it had used until then. Log both per
user. [Costs and limits](./guides/costs-and-limits.md) explains every lever, the budget, and cost
per user or session.

## How long a question can take

There is no overall time limit on a question. Each model request waits up to 600 s for its first
piece and 300 s between pieces, and is retried after waits of up to 60 s
([Errors and reliability](./guides/errors-and-reliability.md#waits-on-a-silent-model)). A question
is up to 12 chat requests, not counting retries, and part reads besides, so it can run for many
minutes. Give it a deadline with `signal`, and abort it too when the client goes away
([Web app](./guides/web-app.md)). This sample sets a deadline and logs what each question used,
failed ones included:

```ts
import { askWithFiles, partialResultOf, type UsageTotals } from "llm-large-files";

function recordUsage(owner: string, usage: UsageTotals): void {
  console.log(JSON.stringify({ owner, requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }));
}

// `files`, `model`, `documentIds`, `messages` and `owner` as in the first sample.
try {
  const result = await askWithFiles({
    files, model, documentIds, messages, owner,
    limits: { inputTokens: 2_000_000, requests: 40 },
    // 15 minutes: above firstByteTimeoutMs (10 minutes), so a silent request can be sent again.
    // Work that cannot be interrupted (reading a PDF for view_pages) finishes first.
    signal: AbortSignal.timeout(15 * 60_000),
  });
  recordUsage(owner, result.usage);
} catch (error) {
  // A question that failed, or was stopped, was still paid for until then.
  const partial = partialResultOf(error);
  if (partial) recordUsage(owner, partial.usage);
  throw error;
}
```

Waits, retries and deadlines are explained in
[Errors and reliability](./guides/errors-and-reliability.md).

## Storage errors

A store's own errors can name paths and hosts. Reads reach users and models only as
`DocumentStoreError`, whose message names neither, with the original error as its `cause`. Writes
are passed on as they came, and the upload handler answers a write error that has neither a
`status` nor a Node system error's `code` and `syscall` with 422 and the error's own message: a
database driver's message, with its host, can reach the browser that way. Give your store's write
errors a status and a message of your own, and log the cause yourself, since the handlers log
nothing: see [Storage](./guides/storage.md#errors) and the
[node reference](./reference/node.md#how-errors-are-answered). What to show a user is in
[Errors and reliability](./guides/errors-and-reliability.md).

## What the library logs

Nothing. It writes no log, reads no environment variable, and makes no network request but the
adapters' requests: to the provider's API (each adapter's default), or to the URL you configure
instead. Two of its optional dependencies do write: pdf.js, which `unpdf` bundles, prints its own
warnings with `console.warn` (for example `Warning: Indexing all PDF objects`, for a damaged PDF),
and `@cantoo/pdf-lib` warns the same way about some malformed PDFs (for example
`Removing parsed object: 0 0 R`) when it reads one for picture marks or `view_pages`.

What you log is your choice, and some of what the library hands you holds user data:

- **Steps and activity.** The lines of `onStep`, `onActivity` and `result.steps` name the files,
  quote what the model searched for (up to 80 characters) or asked a whole-file read to do (up to
  100), and a failed step ends with the error the tool returned.
- **`result.toolTurns`** hold the text of the files; `result.evidence` names the documents, lines
  and pages that were shown.
- **Errors.** The `cause` of a `DocumentStoreError` names paths or hosts. A `ModelRequestError`
  carries the provider's own message, unfiltered, and "could not be reached (…)" adds the HTTP
  client's message. Log them on the server, and show users a message of your own. In a whole-file
  read, the error of a part that failed is written into the result the model reads (only the code,
  for a Node system error).

## Before you deploy

- Give every document an owner, pass it to every call, and refuse anonymous requests in `getOwner`
  ([Ownership](#ownership)).
- Take `documentIds` and the conversation, `toolTurns` included, from your server, not from the
  browser ([Prompt injection](#prompt-injection)).
- Set `ttlMs` to your data policy, run `sweep` on a schedule, and make your deletion rules cover
  stored `toolTurns` ([Storage and retention](#storage-and-retention)).
- Keep the store on encrypted storage.
- Turn on `keepOriginals` only if you want `view_pages`, and knowing what it keeps
  ([Original files](#original-files)).
- Set `limits` and a deadline, and log `usage` for failed questions too
  ([What a question can cost](#what-a-question-can-cost)).
- Cap concurrent uploads, and set the limit of any body parser in front of the handlers
  ([Uploads](#uploads)).
- For untrusted uploads, run ingest and the questions in a worker or a separate process with a
  memory limit, and keep `unpdf`, `@cantoo/pdf-lib` and `jszip` updated.
- Render answers as untrusted text.
- Check what your model provider keeps, and where it processes the data
  ([What is sent to model providers](#what-is-sent-to-model-providers)).

## Related pages

- [Storage](./guides/storage.md): owners per user or per session, a store of your own, retention.
- [Web app](./guides/web-app.md): uploads, streaming, cancelling.
- [Conversations](./guides/conversations.md): what `toolTurns` hold and how to store them.
- [PDFs](./guides/pdfs.md): formats, `view_pages`, picture marks, scans.
- [Costs and limits](./guides/costs-and-limits.md) and
  [Errors and reliability](./guides/errors-and-reliability.md).
- [Deployment](./guides/deployment.md): several servers, workers, memory, sweep.
- [library.md](./reference/library.md) (`createLargeFiles`, stores, `DocumentStoreError`),
  [ask.md](./reference/ask.md), [tools.md](./reference/tools.md) and [node.md](./reference/node.md).
