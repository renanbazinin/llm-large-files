# Changelog

What changed in each version of `llm-large-files`, for the developers who use it. Each version
says what you need to change when you upgrade, what you can add, what works differently, and what
was fixed. Versions follow [semantic versioning](https://semver.org). While the version is 0.x, a
minor version (0.5 to 0.6) may need changes in your code or settings, and a patch (0.6.0 to 0.6.1)
does not. The **Upgrading** part of each version says what to change, and it is there even when
the answer is "nothing".

<!--
Template of an entry, for maintainers. Put the newest version first.

## X.Y.Z — not released yet
(At release, the date replaces "not released yet": ## X.Y.Z — YYYY-MM-DD.)

Two to four sentences: what this version is about.

### Upgrading: what you need to change

Always present. First, whether code written for the previous version compiles as it is (check
the diff of the public .d.ts files). Then each behavior difference an app may need to act on:
what changed, who it affects, and what to do. Write "Nothing." when there is none.

### New: what you can add

Each addition in one or two lines, with a link to the page that explains it. A short sample for
the ones most apps will use.

### Changed: what works differently

One or two lines each.

### Fixed

Grouped by area. One or two lines each, written for an app developer, with the numbers that
matter.
-->

## 0.99.11 — not released yet

The docs, checked. Every TypeScript sample of the README and the docs is now compiled against the
source in CI, which found one sample that did not compile. A new page has the whole integration of
a chatbot in one place. No code of the package changed.

### Upgrading: what you need to change

Nothing. The code of the package is that of 0.99.10.

### New: what you can add

- **[A chatbot in one page](docs/guides/chatbot.md).** The whole integration for a chatbot on
  Vertex AI, in about 120 lines: what to decide before you start, the library and the model, chats
  and their history in MongoDB, uploads into a folder per user and chat (`scope`), questions
  streamed over Server-Sent Events, and deleting a chat. Each part links to the guide that
  explains it.
- **Where tools of your own go.** `askGemini` and `askWithFiles` offer the model only the
  library's tools. The docs now say so where you choose an entry point, and where to go when your
  model also calls tools of your application
  ([Which entry point](docs/README.md#which-entry-point)).

### Fixed

- **The browser page of the web app guide did not compile.** Its `MARKS` had no entry for the
  outcome `"redacted"` (new in 0.10.0), so `Record<ToolOutcome, string>` refused it
  ([Reading the events in the browser](docs/guides/web-app.md#reading-the-events-in-the-browser)).
  The table of `tool.end` in that guide, and the page of `examples/server.ts`, which showed
  `undefined` as the mark of such a call, name the outcome too.
- **Six samples that were not code, or that leaned on a name they did not import**, now compile on
  their own: the `retry` event and `QUESTION_ID_PATTERN` in the reference, the signature of
  `executeWithFiles`, the `map` of `writeSseEvents`, the wrapped extractors of
  `createIsolatedExtractors`, and the usage of each model in the explorer guide.

## 0.99.10 — 2026-11-25

A patch from an outside review of the code. Each finding was checked against 0.99.9, and each one
that held was reproduced in a test before it was fixed: seven in what a server exposes (a redacted
look at pages, the environment of the isolated readers, a delete that waited, an upload that was
refused, the size of an event of a stream, a PDF page that unpacks to gigabytes, a page that held
the server for half a minute), and smaller ones in the loop, whole-file reads, the adapters, the
Node handlers, the parsers, search and tables. The instructions, the tool guide and the tool
descriptions are those of 0.99.9: a question sends the same text unless a tool result is one of
those fixed below.

### Upgrading: what you need to change

Code written for 0.99.9 compiles as it is. Five changes of behavior may need a line in an
application:

- **`onToolResult`: a replaced result goes without its pages.** A hook that returns `{ result }`
  for a `view_pages` call no longer sends the pages of the result it replaced: the model gets the
  replacement alone. Before, a hook that returned `{ result: { note: "redacted" } }` still showed
  the model the PDF pages. **What to do:** nothing for a hook that only masks text results. A hook
  that changes the result of a look at pages and wants the pages sent returns
  `{ result, keepFiles: true }` ([security](docs/security.md#tool-results-ontoolresult)).
- **Isolated readers get a short list of environment variables**, not the server's whole
  environment: where programs, libraries and temporary files are, the time zone and the language,
  Node's own settings, and what Windows needs. **What to do:** nothing with the library's own child
  script. A `childScript` of your own that reads another variable gets it through the new `env`
  option; `env: process.env` passes everything, as before
  ([`IsolatedExtractorOptions`](docs/reference/node.md#isolatedextractoroptions)).
- **`uploadSpool` removes its own old files.** With `uploadSpool`, the handlers remove the files
  named `llf-upload-<UUID>` in the spool's folder (the system's temporary folder by default) that
  were last written more than a day ago: when they are made, and at most once an hour after that.
  Nothing of another name is touched. **What to do:** nothing, or `uploadSpool: { sweepAfterMs: 0 }`
  to remove none ([`UploadSpoolOptions`](docs/reference/node.md#uploadspooloptions)).
- **The event of a store error has a new field, `storeCode`.** A test that compares the whole
  `error` of a `run.error` or `ingest.error` with `toEqual` needs it
  (`{ message, name: "DocumentStoreError", status: 503, storeCode: "EIO" }`).
- **Keyword search in Hebrew ranks differently** for a query word that starts with prefix letters
  (המשרד), and the `score` values of its passages differ: a test that pins them needs the new ones
  ([Changed](#changed-what-works-differently)).

### New: what you can add

- `ToolResultContext.files`: the files a call hands the model next to its result (the pages of
  `view_pages`: their names, types and bytes), for a check of your own; and
  `ToolResultVerdict`'s `keepFiles` ([`onToolResult`](docs/reference/ask.md#toolresultcontext-and-toolresultverdict)).
- `IsolatedExtractorOptions.env`: more environment variables for the isolated readers.
- `UploadSpoolOptions.sweepAfterMs`: the age past which the spool's own files are removed (24
  hours; 0 for none).
- `EventError.storeCode`: the code of a `DocumentStoreError` (`"ETIMEDOUT"`, `"STORE_STUCK"`,
  `"NEWER_VERSION"`, `"EIO"`), so that `errorInfoOf(event.error)` gives the `code` that
  `errorInfoOf` of the thrown error gives ([events](docs/reference/events.md#errors-eventerror)).
- `OpenAiRequestError.param` also names the field of a one-problem FastAPI `detail` (its `loc`).

### Changed: what works differently

- **A question planned again that then fails says why.** When the first request is refused as too
  large, the documents are planned again; when that second plan failed before it sent anything,
  the provider's overflow was thrown, whatever had happened. Now a stop throws the signal's reason,
  a store that failed its `DocumentStoreError`, a document that went meanwhile
  `DocumentsNotFoundError`, and a scope that cannot be used `DocumentScopeError`, each with what
  the first try found (`partialResultOf`). A budget of yours that cannot work with the smaller
  window is still reported as the overflow.
- **`files.delete` removes only the document it looked up.** See Fixed, below: it returns `false`
  when another document was stored under the ID while it waited.
- **`classifyModelError`: HTTP 413, and the codes `context_length_exceeded` and
  `request_too_large`, are a `"context_overflow"` whatever the message says.** Words of throttling
  in the message ("please try again later", "per minute") made them `"invalid"`, and the files were
  not planned again. Such words still decide for a message that only reads like an overflow, and
  HTTP 429 is as before ([errors and retries](docs/reference/errors-and-retries.md)).
- **Keyword search in Hebrew: a stem for each prefix letter.** A query word with prefix letters
  searches a stem for each letter taken off (המשרד: משרד and שרד), where it searched the shortest
  alone (שרד): a file that writes משרד ranked below passages with שרד inside other words. A query
  of more than 12 terms keeps its words before the stems ([tools](docs/reference/tools.md)).
- **An error passed on in its own words loses its credentials.** `EventError.message`, and the
  answer of the upload handlers for an error with a `status` of its own, still tell an error of
  your own code by its message. A URL with a user name or a password in it is now told by its
  scheme alone (`postgres://…`), the value of a URL parameter named as a key, a token, a secret, a
  password or a signature is left out, and an error with a `code` and an `errno` and no `syscall`
  (node-fetch's, a database driver's) is told as "Something went wrong.". A host name or a path in
  such a message still passes: keep them out of the errors your hooks throw, or show
  `errorInfoOf(error).message`, which passes no words but the library's own.
- **`writeSseEvents`: `heartbeatMs: Infinity`, or any time past 2,147,483,647 ms, sends no
  keep-alive.** It sent one every millisecond (Node's timer took such a time for 1 ms).
- **OpenAI-compatible: a server that refuses `stream_options` is asked again without it**, and
  later streams of that adapter leave it out; their replies then carry no usage unless the server
  sends it anyway. The request used to fail (Azure OpenAI before 2024-09-01, servers that take no
  field they do not know).

### Fixed

- **Security.**
  - *A redacted look at pages still showed the pages.* `onToolResult` returning `{ result }` for a
    `view_pages` call replaced the JSON result and kept the PDF (or the page images) next to it.
    The pages now go only with a result the hook kept, or with `keepFiles: true`; the hook is given
    them in `files`; and no evidence of pages the model did not get is recorded.
  - *The isolated readers had every secret of the server.* A child that parses files you do not
    trust was given the whole environment but `NODE_OPTIONS` (134 variables on the test machine).
    It now gets a fixed short list.
  - *A delete that waited could remove another owner's document.* `files.delete` checked the
    document, then waited its turn behind other deletes (up to `storeTimeoutMs`), then deleted by
    ID. When the document expired meanwhile and another owner stored one under the same
    application ID, that one was removed. The store is now asked again in the delete's turn, and
    only the document that was looked up (the same `createdAt`, usable by the caller) is removed.
  - *A refused upload could hold its connection.* After an answer sent before the body was read
    (no name, too large, no room), a client that stopped sending, or sent a byte now and then, kept
    the connection until Node's `requestTimeout` (5 minutes; for ever at 0). The rest of the body
    is now dropped for `uploadIdleTimeoutMs` of silence at most, and 2 minutes in all.
  - *An event of a stream could grow past `maxEventLength`.* White space after `data:`, arriving
    in pieces, was not counted and was kept: 48 million spaces held about 96 MiB under any limit.
    It is no longer kept.
  - *A PDF page was decoded whatever it unpacked to.* A look at pages (`view_pages`) and the
    picture marks checked only the stored size of a page's content (4 MB and 2 MB): a page of
    33 KB that unpacks to 33 MB was decoded whole, and 4 MB can hold 4 GB. A page's content is now
    decoded up to 32 MB for a look and 16 MB for the marks, all its streams together; past that, a
    look keeps every image the page lists, and the page is marked as a drawing. At ingest, content
    stored behind two filters could make `@cantoo/pdf-lib` decode one block of any size (a block
    of 1.3 MB asked for 134 MB): each decoder is now held to 64 MB, and the file is refused as
    before.
  - *A page of many short lines held the server.* The search for tables in a PDF page took the
    cube of its lines: a page of 2,000 lines of a label and a number took 26 s, and a table of
    8,000 rows 21 s. Both take under a second, with the same text. The search now has a limit of
    work for each page: a table that starts among several hundred such lines is not found, and a
    page of 300 rows of 200 columns stays text
    ([PDF tables](docs/guides/pdfs.md#pdf-tables)).
- **The loop.**
  - The request for the answer, replied to with a tool call that could not be read and a remark
    before it ("Let me look at the errors."), returned the remark as the answer, `answered: true`.
    It is asked for once more, as in a tool turn, and is not an answer when it comes again.
  - A call that repeated an earlier one, in a turn that shortened that earlier result to make
    room, runs after all; its room was not counted, so it shared the room made for the other calls
    and came back cut (63 of 90 lines in the test), or was not run, while older rounds could still
    be shortened. The room is now counted again with it.
- **Whole-file reads.**
  - A part read as two halves takes two requests more than planned (the one refused, and one for
    each half), and was counted as one: a read with `maxRequests` 6 over three parts made 7 part
    requests and had none left for its answer. It now stays within the limit and writes the answer.
  - A part read that lists items, replied to with an empty wrapped list (`{"items": []}`), counted
    the wrapper as an item that could not be checked (`unverified_items: 1`). It has no item.
  - A server built on FastAPI that refuses the larger output limit of a thinking model with HTTP
    422 was asked for it again for every part; it is remembered, as after a 400.
- **Events and errors.** `errorInfoOf(event.error)` of a store error had no `code`, though the
  thrown error's had (`"ETIMEDOUT"`, `"STORE_STUCK"`, `"NEWER_VERSION"`): the event now carries it
  (`storeCode`).
- **Adapters.**
  - *Claude:* a body of HTTP 200 that is an error (`{ "type": "error", … }`, as a gateway may
    answer) is thrown with the status of its type (529 for `overloaded_error`, and sent again), for
    chat requests and part reads. It was read as an empty reply.
  - *OpenAI-compatible:* a server that refuses the name of the output limit with HTTP 422
    ("Extra inputs are not permitted") is sent the other name, as after a 400, and
    `openAiResponses()` drops `include` after a 422 too. An error of `type` `insufficient_quota`
    with `code: null` is kind `"quota"` and is not sent again; it was `"rate_limit"`, sent again
    three times.
  - *All three:* an error inside a stream whose type or code is a word such as `constructor` got a
    function as its `status`. It is 500, as for any unknown word.
  - *Gemini:* a part read with an empty system text sends no `systemInstruction`, as a chat request
    does.
- **Node handlers.**
  - *Isolated readers:* a file that ran its reader out of memory could be refused as
    `"unreadable"` where only the standard error tells it (Windows), and a warning kept from an
    earlier file could make any later crash of that reader `"out_of_memory"`.
  - *Upload spool:* a server killed in the middle of an upload left its temporary file for good
    (now swept, above); the removal of a temporary file is tried again on `EACCES` too.
  - *`prepareUpload`:* for a file saved at the root of a Windows drive with a ref, the link check
    compared against the drive's working folder, and could refuse the upload with "Upload failed
    (ELOOP).".
  - *`writeSseEvents`:* a keep-alive whose `write` throws rejects the call instead of raising an
    uncaught exception; on an HTTP/2 response it no longer sets `Connection: keep-alive`, which
    Node dropped with a warning.
- **Search and tables.**
  - A keyword search for a word found 200,000 times or more (a large log, `error`) returned no
    passage and the note that no passage contains it. It returns passages that hold the word.
  - A regex with `\p{…}` that is not valid with the Unicode flag (`\p{Hebrew}` for
    `\p{Script=Hebrew}`) was searched as the text `p{Hebrew}` and answered 0 matching lines. It is
    an `Invalid regex` error.
  - `aggregate_table` with `header_rows` of 3 to 5 took 2 rows for the header of a CSV file, and 1
    row for a header of 2 below a title row. It takes the rows asked for.
  - `aggregate_table` read spaced digits as a number: a date `2026 03 14` as 20,260,314, and a
    column of phone numbers was summed. A space or an apostrophe counts only between thousands
    (`1 234 567`). `(-100)` was read as 100; it is -100.
- **HTML.**
  - The parameters of an address (`?a=1&copy=2&reg=us`) were read as `©=2®=us`, in a link and in
    text: a name without its `;` is decoded only where HTML reads one, and never before `=`. A
    picture's alt text was decoded twice (`&amp;copy;` became ©).
  - An end tag of a skipped element that was not opened (`</script>` inside `<noscript>`,
    `<template>` or `<svg>`) ended the skip, and the rest of that element was read as text of the
    page.
- **Office files.**
  - *XLSX:* a cell that names a shared string without a number (`<c t="s"></c>`, an empty `<v>`)
    showed the first string of the workbook. It is empty.
  - *DOCX, PPTX, XLSX:* half of a surrogate pair written as a character reference (`&#xD800;`) or
    as an Excel escape (`_xD800_`) reached the stored text and the request, which Claude's API
    refuses. It is stored as U+FFFD; two that make a pair (`&#xD83D;&#xDE00;`) stay the character.
- **Docs.** [security](docs/security.md) said that the frame quotes a file's name as a JSON string:
  the frame of a file sent whole does; the card of a searched file, and the requests of a
  whole-file read, write it as it is, on one line. The page says so now.

### Checked, and left as they are

Findings of the review that the code already answers, or that are how the library is meant to
work:

- *Owner checks off by default:* on by default since 0.99.9.
- *Claude's `signature_delta` replaces the signature:* the API sends one such event for a thinking
  block, and Anthropic's own SDKs assign it too. *A part read at 32,768 output tokens is not
  streamed:* the 10-minute rule is a check of Anthropic's SDKs, not an HTTP 400 of the API, and a
  part read is bounded by its own time limit.
- *An event of a stream that is not JSON is `"unreachable"`, and sent again:* a reply cut off on
  its way is the usual cause, and it is sent again only while no text was shown (documented).
- *The ZIP directory check can be passed with a negative size:* every case where the check gives
  up is one where `jszip` itself throws before it reads a part (15 crafted archives and 831
  mutated ones: none got through), and the names it does not count are read, and counted, from
  the local headers.
- *`@cantoo/pdf-lib` is patched in places:* each patch checks the shape it changes and falls back
  to the library's own behavior; a new test compares a cut written through the patch with pdf-lib's
  own, byte for byte, and fails when the pinned version moves to one that differs.
- *Gemini's stream has no end-of-reply grace:* it has no event that says the reply is whole.
- *`isolated.close()` can be used again:* documented, and a child started after it does not hold
  the process.
- *The upload handlers answer an error with a `status` in its own words:* documented, and the
  recipes for refusals of your own rely on it; credentials are now taken out (Changed).
- *One document larger than `cacheBytes` is kept apart for a minute:* documented since 0.10.2;
  `wholeDocumentBytes` bounds it.
- *`header_rows: 0` still leaves a title row out:* documented, and the row is reported in `title`.
- *Cards have no mark, and whole-file reads put a part between `<part>` tags:* documented under
  [The frame around a file](docs/security.md#the-frame-around-a-file). Changing it changes the text
  every question sends, and is not part of a patch.

## 0.99.9 — 2026-11-25

The candidate for 1.0, without a promise yet that the API stays as it is: versions 0.99.x keep the
rules of 0.x versions. Every call names its owner by default, the options 0.10.0 kept for one
version are removed, and the stored shapes are tested across versions. New and optional: the OpenAI
Responses API, page images for models without PDF input, small visual files sent as themselves,
and question IDs for requests sent again.
[Upgrading to 0.99](docs/upgrading-0.99.md) takes an application from 0.10.x step by step.

### Upgrading: what you need to change

Most code compiles as it is, and a question asked without the new options sends what 0.10.2 sent,
byte for byte. Three changes reach applications: every call names its owner unless the library is
created with `requireOwner: false`, the two options 0.10.0 kept for one version are removed, and a
mock of the library or of the upload handlers needs the members that are now required.
[Does my code compile?](docs/upgrading-0.99.md#does-my-code-compile) lists what does not compile.

- **Owner checks are on by default.** `requireOwner` defaults to `true`. Every call (`ingest`,
  `getMeta`, `getOriginal`, `delete`, `list`, `touch`, `update`, `prepare`, `tools`, `toolsFor`,
  `askWithFiles`, `askStream`, `askGemini`) must name its owner. A call without one throws a
  `TypeError` that says how to turn the checks off. Documents stored without an owner, by any
  earlier version, read as missing until you pass `requireOwner: false` or store them again with an
  owner. Nothing is deleted. `sweep` takes no owner. Only `false` turns the checks off: any other
  value leaves them on. Both paths are in
  [Upgrading to 0.99](docs/upgrading-0.99.md#owner-checks-are-on-by-default).
- `createDocumentHandlers` needs `getOwner` unless the library has `requireOwner: false`. A request
  without an owner is answered `401` "Sign in first.". A `LargeFiles` of your own without `access`
  counts as requiring an owner.
- `CreatedLargeFiles` has `list`, `touch` and `update` as required members, and `DocumentHandlers`
  a required `list`. A mock of either type needs them (TS2739, TS2741). Type a mock of the library
  as `LargeFiles`.
- **`inlineTables` and `numberInline` are removed** from `askWithFiles` and `askGemini`, with
  `inlineTables: "text"` and `numberInline: false`, the ways back to 0.9's text that 0.10.0 kept
  for one version. Tables sent whole always get the tools, and files sent whole are always
  numbered. Any value but `"tools"` and `true` is a `TypeError` before any request. Questions asked
  without them send what 0.10.2 sent, byte for byte.
  **What to do:** delete both options
  ([Upgrading to 0.99](docs/upgrading-0.99.md#the-way-back-to-09s-text)). `files.prepare()` keeps
  them, off by default, for loops of your own.
- **`ModelAdapter.estimateTokens` is removed.** It was deprecated in 0.6.0 and never called. An
  adapter object typed `ModelAdapter` that declares it no longer compiles (TS2353); a class that
  implements `ModelAdapter` with the method still does.
  **What to do:** delete it, and set `capabilities.tokenScale` for a model that counts tokens
  differently.
- **`geminiToolTurns`, `openAiToolTurns`, `anthropicToolTurns` and `compactToolTurns` refuse a
  stored round of a newer version**, or one whose `version` is not a number (NaN, or a string such
  as `"1"`), with the `TypeError` of `askWithFiles`. They converted it as a round of version 1.
  **What to do:** store `version` as the number the round had. Unless servers of two versions
  answer one chat, nothing else: there, leave such rounds out, as with `askWithFiles`.

### New: what you can add

- **`handlers.list(request, response)`**: a `GET` route for `files.list`. It answers
  `{ "documents": [summary, …] }` for the request's owner and scope, the oldest first. A request
  with neither an owner nor a scope is answered `401`
  ([`list`](docs/reference/node.md#listrequest-response)).
- **`prepareUpload` can return `dedupe` and `appData`**, passed to `ingest`. A file uploaded again
  gives back the document stored before (`UploadedContext.reused`), and the file saved for that
  upload is removed. The application's data comes from the server, never from the client as sent,
  and is checked before the body is read. The `onUploaded` of a reused upload never deletes the
  document. An upload given a document whose own `onUploaded` is still running waits for it (at
  most 30 seconds), and is answered `409` when that hook failed or the document is gone
  ([Web app](docs/guides/web-app.md#the-same-file-twice-and-your-own-data-dedupe-and-appdata)).
- **`openAiResponses()`** in `llm-large-files/openai` (A1): a model behind OpenAI's Responses API,
  for OpenAI's reasoning models with tools, which reason while they call the document tools.
  Through Chat Completions, newer OpenAI models refuse function tools unless the effort is
  `"none"`, and some refuse them altogether. Each request sends `store: false` and the whole
  conversation, and gives each reasoning item back, with its encrypted content, in the later
  requests of the same question. Azure OpenAI works with
  `baseUrl: "https://{resource}.openai.azure.com/openai/v1"`. It was built from OpenAI's and Azure's
  documentation and tested against fake servers: it has not been run against either
  ([OpenAI's Responses API](docs/guides/openai-compatible.md#openais-responses-api)).

  ```ts
  import { openAiResponses } from "llm-large-files/openai";

  const model = openAiResponses({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-5.5",
    contextTokens: 1_050_000,
    body: { reasoning: { effort: "medium" } },
  });
  ```
- It can send the pages of `view_pages` inside the tool's output or after it (`toolFilePlacement`:
  `"inside"` or `"beside"`). It sends none by default, so `view_pages` is not offered.
- **A question ID that survives a retry (H14).** `AskOptions.questionId` names one question of a
  chat, as the client made it (a UUID). Every event of the question and its result carry it; the
  model never sees it, and the requests are the same with and without it
  ([`AskOptions`](docs/reference/ask.md#askoptions)).
- **`createQuestionRegistry()`** runs questions by owner, scope and question ID. A request sent
  again after its stream broke joins the question still running, or gets its answer for 10 minutes
  after it ended, instead of asking the model again. A question nobody waits for goes on for 30
  seconds, then stops. Another question under the same ID is a `QuestionConflictError` (409). In
  memory, one registry per process ([Question IDs](docs/reference/ask.md#question-ids),
  [When the stream breaks](docs/guides/web-app.md#when-the-stream-breaks-a-question-id)).
- **Page images for models that take no PDF** (G-13): `openAiCompatible({ imageInput: true })`, for
  vLLM, DeepSeek and other servers that read images. `view_pages` then sends each page as a JPEG
  of 1,568 pixels on its longest side (`PAGE_IMAGE_SIDE`), drawn with unpdf 2 and the optional
  `@napi-rs/canvas`, which need Node 24. A look draws at most 5 pages, within the bytes left and 5
  seconds (a page under way is not cut short), and timers and other requests run between two pages.
  Nothing bounds the memory of one page: keep `view_pages` off for files you do not trust. An adapter of your own says what
  it takes with `capabilities.toolFileTypes`: the loop sends a PDF when every model takes one,
  else a JPEG, else a PNG. `openAiResponses()` with a `toolFilePlacement` takes both
  ([Pages as images](docs/guides/pdfs.md#pages-as-images)).
- **The `documents` capability**: with `gemini(endpoint, { documents: { formats: ["pdf"] } })`, or
  the same option of `openAiCompatible()`, `openAiResponses()`, `anthropic()` and `askGemini`, a
  small visual file sent whole also goes to the model as the file itself, before its text. That is
  a PDF with a picture or a scanned page, or a slide deck (PPTX, Gemini API only), of at most 10
  pages and 4 MiB, whose original is kept. A log, a table to count, a DOCX and a searched file never
  go. The text still goes, so citations and counts work as before, and such a PDF gets no
  `view_pages`. Off unless the adapters declare it; `nativeDocuments: false` turns it off for one
  question ([The file itself](docs/guides/pdfs.md#the-file-itself-for-small-visual-files)).
- `ModelTextMessage.files`, `PrepareOptions.nativeDocuments`, `PreparedContext.native`,
  `ToolOptions.pageImages`, `PAGE_IMAGE_SIDE`, `DEFAULT_NATIVE_FILE_BYTES` and
  `DEFAULT_NATIVE_PAGES`, for loops and adapters of your own. Evidence has an entry with
  `tool: "original"` for a file sent as it is. Files an application puts in `ModelTextMessage.files`
  go first in their turn: each built-in adapter sends a PDF or an image, and throws a `TypeError`
  for a type it cannot send (`gemini()` sends any type as `inlineData`). Files belong in a turn of
  the user: `openAiCompatible()`, `openAiResponses()` and `anthropic()` throw a `TypeError` for
  files in a turn of the assistant.
- `@napi-rs/canvas` (`^0.1.69 || ^1.0.0`) is a new optional peer dependency, needed only for page
  images.

### Changed: what works differently

- The `TypeError` of a call without an owner reads "owner is required: requireOwner is on (the
  default). Pass the user's ID as owner, or create the library with requireOwner: false to allow
  calls without one.". It starts as before, for code that looks for that start.
- `files.list(…)`, `files.touch(…)` and `files.update(…)` need no `!` on what `createLargeFiles`
  returns.
- **What earlier versions stored is read in CI (H7).** The files that `FileDocumentStore` of 0.8.2,
  0.9.0 and 0.10.2 wrote, and the `toolTurns` they returned, are kept as fixtures and read by every
  build, on Ubuntu and Windows. Metadata with `metaVersion` 2 and a round with `version` 2 are
  refused. `metaVersion` and `ToolTurn.version` stay 1. 0.99.9 reads every shape stored since 0.2;
  from 0.99.9 on, each version reads at least the shape of the version before it
  ([Stored documents and rounds](docs/upgrading-0.99.md#stored-documents-and-rounds)).
- `openAiCompatible()` sends what 0.10.2 sent, byte for byte: the Responses API is a separate
  adapter, `openAiResponses()`.
- `errorInfoOf` reads `QuestionConflictError`: category `"input"`, code `"question_conflict"`,
  status 409.
- `sseMessageOf` and `writeSseEvents` keep `questionId` in `run.finish` and `run.error`, and in the
  result of `run.finish`, for a question that has one.
- `anthropic()` sends a file that a tool returns as an `image` block when it is an image; it sent
  every file as a `document` block. `openAiCompatible()` with `pdfInput` sends one as an
  `image_url` part. Only a tool set of your own returned images before 0.99.9.

**Release**

- CI checks performance budgets in a job of its own (`perf`, Node 22 on Ubuntu): the time and
  memory of 100 uploads of 2 MB ingested at once, the time, memory and longest stall of a 100 MB log
  ingested, and the time and memory of one search of it and of eight at once. Each bar is three
  times the slowest time, or twice the most memory, recorded for the same work, and an ingest may
  take at most 5.5 times the log, as Deployment says to size for
  ([Performance budgets](docs/measurements.md#performance-budgets-0999)). `npm run perf` runs them
  on your machine.

### Fixed

- **Two sweeps at once on Windows** could count one document twice (26 for 25). When the losing
  call could not remove its own claim for another reason than "not found", `FileDocumentStore`
  counted the removal. It now counts it only when the claim's name is still there. No document was
  lost.
- `files.list` listed metadata whose `metaVersion` is NaN, which `getMeta` refuses. It leaves it out
  now, as `ingest`'s `dedupe` does.
- **Docs:** the OpenAI recipe of `openAiCompatible()` said that `reasoning_effort: "none"` is the
  default of GPT-5.4 and later, so it could be left out of `body`. GPT-5.5 defaults to `"medium"`
  (OpenAI's model page): set `"none"` for tool calls through Chat Completions, or use
  `openAiResponses()` to reason with tools
  ([OpenAI](docs/guides/openai-compatible.md#openai)).

## 0.10.2 — 2026-11-25

Storage for a chatbot that keeps its files in the library: the files of a chat in one call, an
expiry counted from the last use, the application's own data on a document, and one document for a
file uploaded twice. Stored tool rounds can be kept small. A large document over a store without
`readTextRange` is no longer loaded again for every tool call. The text sent to the model is the
same as 0.10.1's.

### Upgrading: what you need to change

Nothing. Code written for 0.10.1 compiles as it is: the new store methods, library members and
options are optional, and the requests are byte for byte those of 0.10.1. (A store or a
`LargeFiles` of your own that already has a member named `list`, `patchMeta`, `touch` or `update`
with another signature no longer matches the interface: rename it.)

- A subclass of `MemoryDocumentStore` or `FileDocumentStore` with its own `put`, `get`, `getMeta` or
  `delete` is used as if it had no `list` and no `patchMeta` until it has its own: the built-in ones
  would go past its own reads and writes. Its conformance checks pass as before.

- A store of your own that keeps a fixed list of metadata fields drops `appData`, the new field of
  `DocumentMeta`: keep `meta` whole, as the storage guide says
  ([The methods](docs/guides/storage.md#the-methods)).
- `documentStoreChecks` checks `list` and `patchMeta` only for a store that has them: your store's
  tests pass as before.

### New: what you can add

- **`files.list(access)`**: the documents of exactly the caller's owner and scope, the oldest first,
  for a chat's file panel without a second list in your database. A document without an owner is
  listed only to a caller without one. It needs the store's new optional
  `list(context)`, which `MemoryDocumentStore` and `FileDocumentStore` have
  ([`files.list`](docs/reference/library.md#fileslistaccess)).
- **`files.touch(id, access)`**: the document's expiry is counted again from now (H5), so `ttlMs`
  becomes the time a file is kept after its last use. Only the expiry is changed, through the
  store's new optional `patchMeta(id, { createdAt, owner?, scope?, expiresAt?, appData? }, context)`:
  field by field, and only in the document of that `createdAt`, owner and scope, so a document
  stored again under the same ID meanwhile is never changed, and a `touch` and an `update` at once
  both stay. `FileDocumentStore` makes them take turns with its `put` and `delete` of the document;
  across servers sharing a folder, see [Storage](docs/guides/storage.md#filedocumentstore)
  ([Expiry from the last use](docs/guides/storage.md#expiry-from-the-last-use)).
- **`appData`**: the application's own data about a document (`DocumentMeta.appData`, a JSON object
  of at most 16 KB, `MAX_APP_DATA_BYTES`), set with `ingest({ appData })` and changed with
  `files.update(id, { appData }, access)`. Never sent to the model, nor in a summary.

  ```ts
  const meta = await files.ingest({ name, bytes, owner: userId, scope: [userId, chatId], appData: { rowId } });
  await files.update!(meta.id, { appData: { rowId, label: "contract" } }, { owner: userId, scope: [userId, chatId] });
  ```
- **`ingest({ dedupe: true })`**: a file uploaded again gives back the document of the same owner
  and scope with the same SHA-256, with its expiry counted again, instead of a second copy (H6). The
  file is read once to hash it, not extracted. Never across owners or scopes; not with `id`. The
  document keeps its `createdAt`, which tells it from a new one
  ([`IngestInput`](docs/reference/library.md#ingestinput)).
- **`storeRounds: "compact"`** and **`compactToolTurns(turns)`**: stored tool rounds with each large
  result replaced by the stand-in the loop already sends when it drops a result (I2), a few hundred
  bytes a call instead of up to 24,000 characters. A later question sends the stand-ins, and the
  model reads again what it needs ([`compactToolTurns`](docs/reference/ask.md#compacttoolturnsturns)).
- `documentStoreChecks` checks `list` and `patchMeta`; `StoreCheckPart` has `"list"` and `"meta"`.

### Changed: what works differently

- **The last document larger than the whole cache is kept apart** for a minute after its last use
  (P4): over a store without `readTextRange`, the tool calls of a question no longer each load and
  index it again (250 ms a read, and about 2 GB of RSS at 100 MB in the 0.6 review). One at most, on
  top of `cacheBytes`; `cacheBytes: 0` keeps none; `stats().cache.bytes` counts it,
  `stats().cache.entries` does not.
- **`FileDocumentStore.sweep` removes metadata whose text is gone**, once it is older than
  `orphanAgeMs`, as it removes files of no document: a document changed on one server while another
  deleted it can be left so, and reads already took it as missing.
- **An ingest's own reads of a path upload count as stuck calls** (the `lstat`, the parts read for
  the format, and, when `ingestTimeoutMs` is a time limit, the read of the file), as its store calls
  do, once they have run the time the ingest gives them: a volume that does not answer now shows in `stats().stuckStoreCalls`, and past
  `maxStuckStoreCalls` store calls fail at once with `"STORE_STUCK"`
  ([A store that stops answering](docs/guides/deployment.md#a-store-that-stops-answering)).

## 0.10.1 — 2026-11-25

A patch from the review of 0.10.0 against its code: a few pages said more, or less, than the code
does, `checkCitations` read a line number written with commas as its first digits, and one test
failed on a slow runner. The text sent to the model is the same as 0.10.0's.

### Upgrading: what you need to change

Nothing. Code written for 0.10.0 compiles as it is, and the requests are byte for byte those of
0.10.0.

### New: what you can add

- `HeaderSource` and `HeaderContext` are exported: the type of `vertexAi({ headers })` and of a
  headers function that takes `{ refresh }`
  ([VertexAiOptions](docs/reference/gemini.md#vertexaioptions)).

### Fixed

- **`checkCitations` read "(app.log L1,200)" as line 1.** A number written in groups of three after
  commas is now one number ("L1,200", "line 12,345", "שורה 1,200"), in `AskResult.citations` too;
  "L1,20" is still line 1.
- **Docs that did not match the code:**
  - after a whole-file read with `output: "items"`, only the lines of its items count as shown, not
    the whole file ([`CitationCheck`](docs/reference/ask.md#citationcheck));
  - a reply over a table sent whole that ended for a reason asking again cannot mend (`"other"`) is
    not asked for again ([Tables sent whole](docs/guides/costs-and-limits.md#tables-sent-whole));
  - `body` of `askGemini` and `gemini()` reaches the chat requests, not the part reads of a
    whole-file read, which take `analysisBody`: the upgrade guide's worked example labelled only
    the chat requests, and now sets both
    ([The worked example](docs/upgrading-0.10.md#the-worked-example));
  - `has("aggregate_table")` is true while the text tools are declared; of two keyword passages with
    one score, the one met first comes first, not always the earlier in the file;
    `maxStuckStoreCalls` is half the libuv pool, at least 1; a Gemini error in a stream is retried
    for 408 and 409 too; its `code` is its status only from 400 to 599; `location` is not checked
    when `host` is given; the printed `VertexAiOptions` shows the fields it refuses;
  - the 0.10.0 entry below and the upgrade guide: what the opt-outs do not give back (also the
    prompts of merges, the answer to an unknown tool, and results cut in tokens), which finish
    reasons 0.9 already did not ask again for, the 3-row rule (for tables sent whole only), the
    item check (it takes out a short `\u` escape), and the mocks that need `stats` and `toolsFor`;
  - `docs/measurements.md` listed thought signatures of earlier questions as if 0.10.0 sent them:
    it ran them as a probe, and sends none.
- **Tests:** a search test that stops at a 5 ms budget ran out of time before its first match on a
  Windows runner; it now doubles the budget until a scan finds lines.

## 0.10.0 — 2026-11-25

Counts that are right and a cost that is bounded, for a chatbot on Gemini. Tables sent whole get
exact counts, files sent whole get line numbers, and every question has a ceiling on input tokens
by default. Answers say how they ended, a store that stops answering no longer holds a question or
a server, Gemini requests take fields of your own, and a PDF whose headings are set in larger type,
Hebrew included, gets an outline. The text sent to the model changes on purpose, all at once: each
chat with files misses the provider's prompt cache once at the upgrade.
[Upgrading to 0.10](docs/upgrading-0.10.md) takes an application from 0.9.0 step by step, with the
Hebrew chatbot of the 0.9 guide carried over.

### Upgrading: what you need to change

Code written for 0.9.0 compiles with 0.10.0, except in these cases
([Does my code compile?](docs/upgrading-0.10.md#does-my-code-compile)):

- `NoticeCode` has two new members, `"answer_filtered"` and `"answer_cut"`; `ToolOutcome` one,
  `"redacted"`; and `ModelReply.finish` one, `"other"`, which the `finish` of a `request.end` event
  has too. An exhaustive `switch` over any of them, or a `Record` keyed by it, needs them. The new
  `AskResult.finish` has the same members.
- The plan of `run.finish` and `run.error` (`EventResult.plan`) holds
  `Omit<DocumentMeta, "owner" | "scope" | "sha256" | "original" | "metaVersion">`, and the result
  of `eventResults: true` leaves those fields out at run time too. Code that reads them there fails
  with TS2339. Read them from `AskResult.plan`.
- `createLargeFiles` returns `CreatedLargeFiles`, a `LargeFiles` whose `stats()` and `toolsFor()`
  are required. A value typed `ReturnType<typeof createLargeFiles>` and made by hand (a mock), or a
  variable whose type was inferred from it and that you later give a `LargeFiles` of your own,
  fails with TS2322. Type it `LargeFiles`.
- `DocumentHandlers` has a required `stats()`. A `DocumentHandlers` made by hand (a mock) fails
  with TS2741.
- `LargeFiles` has two new optional methods, `stats` and `toolsFor`. A `LargeFiles` of your own
  with a member of either name and another type fails with TS2322 or TS2416. Rename it.
- `vertexAi` takes `VertexAiOptions`, a union of the token form and express mode (`apiKey`), and
  its token function is typed with its `{ refresh }` argument. A value typed
  `Parameters<typeof vertexAi>[0]` whose `project` you read as a string, or whose `accessToken`
  you call with no argument, fails with TS2322 or TS2554. Type it
  `Extract<VertexAiOptions, { project: string }>`, and call `accessToken({ refresh: false })`.
- A subclass of `UsageMeter` whose `add` takes a parameter of its own after `usage` fails with
  TS2416: `add(model, usage, estimatedInputTokens?)` takes that place. Put yours after it.

The other changes to the public types add exports, options, fields and optional members.
`ModelReply.responseId` and `responseModel`, `ExtractedText.headings`, `ToolSet.wholeReadsLeft` and
`PreparedContext.toolable` are optional, so an adapter, an extractor, a tool set or a `LargeFiles`
of your own still compiles, unless it already has a field of the same name and another type. The
type of `askGemini`'s options is now `Omit<AskOptions, "model" | "explorer" | "messages"> &
GeminiOwnOptions`: no field was removed, and every option of `askWithFiles` reaches the loop. No
export was removed or renamed. The new exports are under **New**.

Some behavior is different. Check each point against your app:

- **One prompt-cache miss for each chat with files at the upgrade.** The text sent changes once:
  files sent whole are numbered (`12| `), and when no file is searched the system text gets the
  line `Cite line numbers like (report.docx L12).`; a table sent whole gets three tool
  declarations, its `document_id` in its frame line, and a line of the system text that says to
  count with them; `analyze_whole_document` is declared with two more arguments, `output` and
  `labels`; the closing request after files shown in full asks for an answer from those files and
  what the tools returned, with line citations, where 0.9's named only what the tools returned; and
  on a card, a size between 999,500 and 999,999 tokens reads "1.0M", and one between 1,048,064 and
  1,048,575 bytes "1 MB", on a card and in `get_document_overview`'s `size` (LLF-059); error
  messages that print a size in that range (upload and text limits, `view_pages`) read "1 MB" too.
  After that one miss, the cache works across questions as in 0.9: a follow-up still differs from
  its first stored round, which goes back as its calls.
  **What to do:** nothing; the first question of each chat after the deploy costs its full input
  ([Prompt caching](docs/guides/costs-and-limits.md#prompt-caching)).
- **A ceiling on input tokens by default.** A question that sets no `limits.inputTokens` stops
  calling tools once what it spent, its next tool request and the answer would pass the larger of
  `DEFAULT_INPUT_TOKENS` (1,000,000) and `toolTurns` times the estimate of its first request, plus
  room for the whole-file reads it may make. It looks ahead before each tool request, and a request
  that reports no input counts by its estimate. A question of four tool turns over a 3 MB log uses
  less than half of it.
  **What to do:** nothing, or set your own ceiling. `limits: { inputTokens: Infinity }` gives 0.9's
  behavior ([The default ceiling](docs/guides/costs-and-limits.md#the-default-ceiling)).
- **At most 2 whole-file reads per question**, over all its documents. A third is refused with its
  reason. **What to do:** `limits: { wholeReadsPerQuestion: Infinity }` gives 0.9's rule.
- **Tables sent whole get tools** (`inlineTables: "tools"`, the default of `askWithFiles` and
  `askGemini`). A CSV, an XLSX workbook, or a DOCX, PPTX, PDF, HTML or Markdown file with a table of
  at least 3 `| cell |` rows that is sent whole gets `search_document`, `read_document` and
  `aggregate_table`, and the question runs the tool loop. A question with no count stays at one
  request when the model answers at once; a count takes 2 or 3 (live, a median of 2 on both
  models), each sending the table again; at most, about `toolTurns` times the first request (about
  1.5M input tokens for a CSV of 3,000 invoices), bounded by the ceiling. Live, input tokens on the
  eval's cases shared with 0.9.0 were about 2.3 to 2.4 times 0.9.0's, and counts were right in 24
  of 24 on both models
  ([Measurements](docs/measurements.md#tables-sent-whole-p1s-live-gate)). Gemini 3.5 Flash-Lite
  looks a row up with a tool even when the table is shown in full: 21 of 39 questions with no count
  took one request (Gemini 3.8 Flash: 38 of 39), so a lookup takes 2, each sending the table. This
  is recorded, not tuned. Limits sized for 0.9's one request (`toolTurns: 1`, `requests: 1`, an
  `inputTokens` between one and two requests with the table) leave no tool turn: such a question
  makes 0.9's one request, without tools.
  **What to do:** nothing, or `inlineTables: "text"` for 0.9's cost and counts by eye
  ([Tables sent whole](docs/guides/costs-and-limits.md#tables-sent-whole)).
- **Files sent whole are numbered** (`numberInline: true`, the default of `askWithFiles` and
  `askGemini`), so that answers cite their lines: about 8% to 16% more tokens for each file, and a
  file at the edge of `inlineTokens` may become a card. When no file is searched, the system text
  gets the line `Cite line numbers like (report.docx L12).`.
  **What to do:** nothing, or `numberInline: false` to send them as 0.9 did.
- **`AskResult.evidence` lists each file sent whole first**, as
  `{ tool: "inline", documentId, document, lines: [[1, n]], whole: true }`, with no `callId`.
  **What to do:** code that counts tool calls from evidence, or maps it to `tool.end`, skips the
  entries without a `callId`.
- **What the opt-outs do not give back.** `inlineTables: "text"` and `numberInline: false` each
  give 0.9's bytes for what they cover. With both, these stay: the `whole_file` hint of a
  `read_document` result cut short, and the `filter_note` of `aggregate_table`; the declaration of
  `analyze_whole_document` and the prompts of its part reads and merges (M8); the card sizes of
  LLF-059; the loop's own answer to a call of an unknown tool ("Unknown tool “x”. The tools are:
  …", LLF-049); and tool results cut to their room in tokens, at each document's own characters per
  token, so a result cut at the room differs from 0.9's
  ([What has a way back](docs/upgrading-0.10.md#going-back-to-09s-text)).
- **Rolling deploys.** What 0.10.0 stores is what 0.9 stores, so servers of both versions share a
  store and nothing fails. But they send different text, so a chat answered by 0.9 and 0.10 servers
  in turn misses the prompt cache on every switch.
  **What to do:** deploy every server at once, or route each chat to one version until the rollout
  ends. Run the sweep from a server of 0.10.0
  ([Rolling deploys](docs/upgrading-0.10.md#rolling-deploys)).
- **Store calls have a time limit.** A `getMeta`, a read of a text, its index or its original, or a
  `delete` that does not end within `storeTimeoutMs` (30 s) fails with a `DocumentStoreError` of
  code `"ETIMEDOUT"` (503, to retry), where it hung. In a question, a store call that times out,
  in a tool call or in a part of a whole-file read too, ends it with `run.error`: `execute` and
  `executeWithFiles` throw it, where they returned an error result, and a page look at a hung
  original is that error, where the model was told the file could not be read in time. While
  `maxStuckStoreCalls` calls of the process are stuck past their limit (half of
  `UV_THREADPOOL_SIZE`: 2 by default), store calls fail at once with code `"STORE_STUCK"` (503).
  **What to do:** on servers that use a network volume, set `UV_THREADPOOL_SIZE=32`. Raise
  `storeTimeoutMs` for a slow store, or set 0 for none
  ([A store that stops answering](docs/guides/deployment.md#a-store-that-stops-answering)).
- **Transient system errors are 503 and retryable.** `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`,
  `EPIPE`, `EAI_AGAIN`, `EAGAIN`, `EBUSY`, `EMFILE`, `ENFILE`, `ESTALE`, `EHOSTUNREACH` and
  `ENETUNREACH` are 503 with `Retry-After: 5` in `errorInfoOf` and the upload handlers, and
  `ENOSPC` and `EDQUOT` 503 with 30 s. They were 500, not to retry: "Upload failed (ETIMEDOUT)." is
  now a 503. A path upload whose read does not answer within `ingestTimeoutMs` is such an
  `ETIMEDOUT`, not the `IngestError` `"timeout"` (422) it was.
  **What to do:** tell users to try again when `errorInfoOf(error).retryable` is true
  ([Transient errors](docs/guides/errors-and-reliability.md#transient-errors-a-store-or-a-disk-that-does-not-answer)).
- **Gemini errors inside a stream, or in a reply of HTTP 200, are retried.** One with no numeric
  code gets the status of its `google.rpc` name (`UNAVAILABLE` 503, `RESOURCE_EXHAUSTED` 429,
  `DEADLINE_EXCEEDED` 504, 500 for a name it does not know), and a transient one is sent again up to
  `retry.retries` times (3), unless text was already shown. It had status 200 and was not sent
  again. A daily quota is still `"quota"`, and not sent again.
  **What to do:** nothing.
- **Part reads that run out of time** are a `ModelRequestError` of kind `"timeout"` and status 0
  in every adapter, sent again once after the first wait of `retry`. Before, it was the timer's
  abort error, with no status. `timeoutMs: 0` now sets no limit; it aborted every part read at once.
  **What to do:** nothing; `gemini({ timeoutMs })` and `askGemini`'s `timeoutMs` set the limit
  ([Part reads](docs/guides/errors-and-reliability.md#part-reads-have-a-time-limit-of-their-own)).
- **Filtered and cut answers say so.** `result.finish` tells how the answer ended, an
  `answer_filtered` or `answer_cut` notice comes before `run.finish`, and a reply that a filter or
  another reason that asking again cannot mend ended (`finish` `"filtered"` or `"other"`) is not
  asked for again. 0.9 already stopped so after the filters it knew; a reason it did not know made
  4 requests over a searched file, and now makes 2. Gemini's `MODEL_ARMOR`,
  `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION` and `IMAGE_OTHER` are now `"filtered"` (as
  `IMAGE_SAFETY` was), and `OTHER`, `LANGUAGE` and four more `"other"`; they gave no finish.
  `MALFORMED_RESPONSE` is now `"malformed_call"`: the turn is asked for once more.
  **What to do:** switch on `answerInfoOf(result)` for the message to show. With
  `filteredAnswer: "drop"`, take back streamed text when the notice has `discardText`
  ([Filtered and cut answers](docs/guides/errors-and-reliability.md#filtered-and-cut-answers)).
- **A PDF ingested from 0.10.0 on** whose text gives fewer than 3 headings gets an outline from its
  lines set at least 15% larger than its body, when 3 or more of them are found in its text. Its
  card gains an "Outline" block, `get_document_overview` lists it, and search hits gain `section`.
  A PDF with a title alone keeps the card and hits of 0.9. Documents already stored keep their
  metadata until they are ingested again; `metaVersion` stays 1. A wrapper around the built-in PDF
  extractor that returns only `text` and `pages` keeps the 0.9 outline.
  **What to do:** pass `headings` on in such a wrapper (`{ ...extracted, text }`)
  ([PDF outline](docs/guides/pdfs.md#pdf-outline)).
- **Tests that compare results, events or requests whole.** Requests change as the first point
  says. `usage` gains `estimatedInputTokens` and `unmeasuredRequests` when a request reports no
  input. Replies gain `responseId` and `responseModel` where the provider gives them. A malformed
  call on the last tool turn now gets a closing request: one request more (LLF-048). The loop
  answers a call of an unknown tool itself ("Unknown tool “x”. The tools are: …"), with outcome
  `"refused"` and no `onActivity` line, where the tool set returned an `"error"`. A size between
  1,048,064 and 1,048,575 bytes reads "1 MB" on a card, in `get_document_overview` and in error
  messages (LLF-059).
  **What to do:** update the tests that compare these whole.

### New: what you can add

**Answers and costs**

- **How an answer ended:** `AskResult.finish`, the notices `"answer_filtered"` and `"answer_cut"`,
  `AskOptions.filteredAnswer` (`"keep"` or `"drop"`, with `discardText` on the notice), and
  `answerInfoOf(result)` with `AnswerInfo`: one value to switch on, `"filtered"`, `"cut"`,
  `"blocked"`, `"language"` (Gemini's `LANGUAGE`, not a filter), `"no_answer"` or `"other"`
  ([Filtered and cut answers](docs/guides/errors-and-reliability.md#filtered-and-cut-answers)).
- **Citations checked:** `AskResult.citations` and `checkCitations` (`CitationCheck`). They read
  "(name L12)", ranges, "line N", "Row N", and the Hebrew "שורה N" and "שורות N-M", and check each
  against what the tools showed; a workbook's rows are unchecked (S3,
  [CitationCheck](docs/reference/ask.md#citationcheck)).
- **`onToolResult`** (`ToolResultContext`, `ToolResultVerdict`): see each tool result before the
  model does, and keep it, replace it (outcome `"redacted"`) or refuse it
  ([Security](docs/security.md#tool-results-ontoolresult)).
- **Limits:** `limits.wholeReadsPerQuestion` and `DEFAULT_INPUT_TOKENS`; `UsageTotals`
  `estimatedInputTokens` and `unmeasuredRequests`, and `UsageMeter.add(model, usage,
  estimatedInputTokens?)` ([Costs and limits](docs/guides/costs-and-limits.md#the-limits-of-a-question)).
- **Response IDs:** `ModelReply.responseId` and `responseModel` from Gemini, OpenAI-compatible
  servers and Claude, on `request.end` too.

**Tables and line numbers**

- `AskOptions.inlineTables` (`"tools"` by default) and `AskOptions.numberInline` (`true` by
  default), also in `askGemini`. For loops of your own, `PrepareOptions.inlineTables` and
  `numberInline` (off by default) and `PreparedContext.toolable`; and for the tool set,
  `ToolOptions.inline` (the files sent whole) and `ToolOptions.declare` (exactly these tools), with
  `declarationsFor(names)` and `ToolName`
  ([Numbered lines and tables sent whole](docs/how-it-works.md#numbered-lines-and-tables-sent-whole)).

The chat of a Hebrew chatbot on Vertex AI and MongoDB:

```ts
import { answerInfoOf, hashedScopeSegment } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";

const turn = { role: "user" as const, text: question };
const result = await askGemini({
  files,
  endpoint: vertexAi({ project, location: "global", model, accessToken }), // accessToken({ refresh })
  body: { labels: { app: "chatbot", team: "hr" } }, // billing labels: no user IDs
  documentIds: chat.documentIds,
  messages: [...chat.messages, turn], // the stored turns and tool rounds, as in 0.9
  owner: userId,
  scope: [hashedScopeSegment(userId), chatId],
  onMissingDocuments: "drop",
  filteredAnswer: "drop",
});
const info = answerInfoOf(result); // complete, or why not: one switch for the Hebrew message
const answer = result.answered ? [{ role: "assistant" as const, text: result.text }] : [];
await chats.updateOne({ _id: chatId }, {
  $push: { messages: { $each: [turn, ...result.toolTurns, ...answer] } }, // as in 0.9
});
```

**Whole-file reads and tools**

- `analyze_whole_document` with `output: "items"` and `labels`: items judged by meaning, each
  checked against its line, and counted by code (`total_items`, `counts_by_label`, `items`,
  `unverified_items`, `parts_failed`, `parts_cut_short`; M9,
  [Items](docs/reference/tools.md#items-output-items)).
- `notes_left_out` on a whole-read result, and `whole_file` on a `read_document` result cut short
  of its range when a whole read would run.
- `ToolCallHooks.signal` (I9) and `ToolSet.wholeReadsLeft(documentId)`.

**Gemini and Vertex AI**

- `gemini()` and `askGemini` take `body`, `analysisBody` and `functionCallingMode` (`"AUTO"` or
  `"VALIDATED"`), and `timeoutMs` for part reads; `askGemini` also `explorerBody`. Types
  `GeminiRequestFields` and `GeminiOwnOptions` (A5,
  [Fields of your own](docs/guides/vertex-and-gemini.md#fields-of-your-own-safety-settings-labels-and-more)).
- `answerWithoutTools` in `gemini()` and `askGemini`: `"omit"` (the default) or `"mode_none"` for
  the request of the answer (NEW-answer-request-tools).
- `vertexAi({ headers, host, apiKey })` (`VertexAiOptions`); `apiKey` is Vertex AI express mode
  (NEW-vertex-endpoint-options).
- `accessToken({ refresh })` and a `HeaderSource` that takes a context: after a 401, the request is
  sent once more with a fresh token. `GeminiEndpoint.refreshable`
  ([Access tokens](docs/guides/vertex-and-gemini.md#access-tokens-for-vertex-ai)).

**Operations**

- `storeTimeoutMs` (30,000), `sweepTimeoutMs` and `maxStuckStoreCalls` in `createLargeFiles`, and
  the `DocumentStoreError` codes `"ETIMEDOUT"` and `"STORE_STUCK"`
  ([Deployment](docs/guides/deployment.md#a-store-that-stops-answering)).
- `AccessOptions.signal`: ends the caller's own wait for the store.
- `files.stats()` (`LargeFilesStats`) and `handlers.stats()` (`DocumentHandlerStats`): counters for
  metrics, alerts and readiness, read without a store call
  ([files.stats()](docs/reference/library.md#filesstats)).
- `files.toolsFor(ids, options)` (I6), and the type `CreatedLargeFiles`.
- `sseMessageOf` sends `finish` and `citations` in `run.finish`.

**PDFs**

- `ExtractedText.headings`: a PDF's lines set larger than its body, with page, level and title,
  and `skip`, how many lines above it on its page read the same (a contents list). The built-in
  extractor returns them; an extractor of your own may too
  ([PDF outline](docs/guides/pdfs.md#pdf-outline)).

### Changed: what works differently

**Costs and limits**

- The ceiling on input tokens looks ahead before each tool request. A whole-file read is priced
  before it starts by what its requests send: its numbered lines, its prompts, its merges, and the
  heading line a part starts under. An items read is priced at its parts, with a frame of 650
  tokens.
- A reply ended by a reason that asking again cannot mend (`"filtered"`, `"other"`) is neither
  nudged nor asked for again. Over files sent whole alone (nothing searched or viewed), one with no
  text that ended so, or at the output limit, ends the question without a closing request. Otherwise the closing request is made once, and
  a filtered closing is not asked for again.
- The room for tool results is shared in tokens, at each document's own characters per token. A
  result that would still pass the room is cut before the model gets it, in call order.
- A question that is stopped ends at once, even while `files.prepare`, a tool call or
  `onToolResult` waits on a store that hangs.

**Tables, numbers and citations**

- A file sent whole counts as having a table, for the tools of `inlineTables: "tools"`, when it has
  3 rows of one table. Whether a searched file gets `aggregate_table` is decided by its format, as
  in 0.9.
- `aggregate_table`: a filter that orders a column (`>`, `>=`, `<`, `<=`) against a value that
  names another column compares the two cells of each row, and says so in `filter_note`. A column
  letter works in every table. Over a table sent whole, a grouped result ends with a `cite` line.
- With an explorer, a question in which no file is searched, and a table sent whole gets the tools,
  is run by the answering model alone: the files sent whole are not sent to two models.

**Whole-file reads, search and tools**

- Part reads send the part first and the task last, with the heading line the part starts under
  first, and their system text marks the part as file content. Merges and the read's answer send
  their notes first and the task last (M8).
- `analyze_whole_document` keeps 0.9.0's description word for word: items are told in `output`
  only. A new description made Gemini 3.5 Flash-Lite skip whole reads.
- The item check counts a quote near its named line as verified (up to one letter in five
  differs), finds a clause's line by the number it starts with, and takes out a `\u` escape with
  fewer than four hex digits, which a model writes by mistake (the near check allows for the gap). The
  rule asks for five to twelve words of the line, copied exactly.
- A whole read with more parts than `ToolCallLimits.maxRequests` is refused before any request; one
  given `maxRequests` stops merging at it (`notes_left_out`, or `notes_only` when no request is left
  for the answer). A whole read that could read no part is not tried again, even when
  `maxWholeDocumentReads` is above 1.
- With `declare`, a tool set answers only the declared tools. `ToolSet.resultCharacters` is 600 for
  a name the tool set does not answer.
- Exact search counts past 1,000,000 matching lines, within the time of a regex search (P8).
  Keyword search keeps its top passages in a heap (P9).
- Measured live: Gemini 3.5 Flash-Lite's timeline of a diary read whole lost a date in about one
  run in three, when a part replied `NOTHING RELEVANT`. An A/B with 0.9.0, 8 reads each, lost no
  date on either. This is recorded as a limit of Flash-Lite, not tuned
  ([Measurements](docs/measurements.md#whole-file-reads-and-items-package-t)).

**Gemini and other providers**

- A Gemini part read stopped by a filter or for an `"other"` reason is flagged as incomplete.
- A Vertex AI 401 with a token from a function is sent once more with a fresh token, in chat
  requests, part reads and the explorer. A second 401 is the error; a refresh that throws keeps the
  401 as the error, with the refresh's error as its `cause`.
- A non-streamed Gemini reply that is a list of chunks is read chunk by chunk, and an error inside
  a stream carries its `retryDelay`.
- `timeoutMs: 0` sets no limit in `openAiCompatible()` and `anthropic()` too.

**Storage and operations**

- Deletes of one library run one at a time, and one time limit covers a whole delete.
- `FileDocumentStore` writes a text longer than 1 Mi UTF-16 units in slices: a 50 MB put held the
  event loop for 379 ms, and now for about 20 ms, with the same bytes.
- `FileDocumentStore` claims a removal by renaming the metadata to a name of its own, and counts
  only its own removals.
- The upload handlers' calls to the disk past `uploadIdleTimeoutMs`, and ingest's store calls past
  `ingestTimeoutMs`, count as stuck. At the limit, a sweep and ingest's store calls are refused too;
  ingest's clean-up removal is not.

**PDFs**

- The outline of a PDF from type sizes: levels 1 to 3 from the sizes used by several headings, and
  a title or cover line set larger than all of them is level 1. Not headings: table rows (a gap of
  more than 3 times the type size between pieces), running headers and footers (a line repeated on
  3 or more pages, or on at least half of them), page numbers (lines that differ only by their
  numbers, on at least half the pages, and that do not count up as section numbers do, on one page
  or from page to page; the same number in a page's header and footer is one page number, while
  headings that count up, such as "פרק 1" to "פרק 5" on the odd pages, are kept; chapters one to a
  page, on pages in a row covering at least half the document, are taken for page numbers), lines
  over 120 characters, and lines with fewer than 3 letters or more digits than letters. A PDF with
  3 or more text-rule headings keeps its outline, and the text of a PDF does not change.

**Release**

- The release workflow runs by hand as a dry run, the default: it builds and checks the tarball on
  any branch or tag, then runs `npm publish --dry-run` in a job with no identity token
  ([Publishing](docs/publishing.md#a-dry-run-of-the-release-workflow), LO-6).
- An eval suite of 48 Hebrew and English cases (in `evals/`, not published) replays its recorded
  requests on every pull request. The prompt changes of this version were gated on it live, on
  Gemini 3.5 Flash-Lite and 3.8 Flash: tables and line numbers by P1's gate (pass^3, at 64a4ec8),
  whole-file reads and items by T's (at c1fbbb5)
  ([Measurements](docs/measurements.md#tables-sent-whole-p1s-live-gate)). Each of its 96
  recordings (48 cases on 2 models) replays against 0.10.0, so 0.10.0 sends the requests that were
  recorded live, byte for byte but for keys and project IDs (T4;
  [Testing](docs/guides/testing.md#the-librarys-own-evals)).

### Fixed

**Questions and costs**

- **No ceiling by default, and a set one overshot (L5, L7):** a runaway question made 13 requests
  and about 6.9M input tokens; a ceiling of 500,000 let 1,219,683 through, and never tripped when the
  provider reported no usage.
- **L1:** results over tables of numbers took 2.22 times their room.
- **LLF-048:** on the last tool turn, the remark of a reply whose tool call could not be read was
  taken for the answer.
- **LLF-049:** calls of unknown tools took room, and shortened earlier results.
- **LLF-058:** a whole-file read that had failed was priced again, instead of refused with its
  reason.
- **N12:** a whole-file read passed `limits.requests`: 40 requests against 32, 42 through
  `askWithFiles`.
- **A6, NEW-filtered-answer:** a reply that Gemini ended with `MODEL_ARMOR`, `OTHER`, `LANGUAGE` or
  another reason 0.9 did not know (the image filters, `NO_IMAGE`, `TOO_MANY_TOOL_CALLS`,
  `MISSING_THOUGHT_SIGNATURE`) cost 4 requests and gave no finish, and a filtered or cut answer
  read as complete ("The employee's medical leave was", `answered: true`). A reason 0.10.0 does not
  know either is still asked for again.
- **LO-7:** with `eventResults`, event plans held owner, scope, sha256 and original at run time.
- `alreadyShown` could point to a result that `onToolResult` replaced.

**Tables and citations**

- **NEW-inline-table-tools:** a CSV of 3,000 Hebrew invoices went whole with no tools, and its 750
  late invoices were counted by eye. Live, counts over tables were right in 24 of 24 on both
  models.
- **L12:** files sent whole had no line numbers, citation line or evidence.
- **LLF-059:** card sizes read "1024 KB" and "1000K", and so did the size of
  `get_document_overview` and of some error messages; they read "1 MB" and "1.0M".
- **LLF-061:** `describe()` of a `read_document` call left out an end line given as a string
  (`"250"`), which the tool reads: it now says "lines 1-250".

**Providers**

- **LLF-018:** a Gemini error in a stream or a reply of HTTP 200 with no numeric code had status
  200; a part read whose body of HTTP 200 held an error reported "The model returned no text".
- **LLF-034:** an OpenAI call without an ID got an ID in its tool message that the call itself did
  not have.
- **LLF-035:** a stream without `index` that repeated the ID on every piece made one call per piece.
- **LLF-036:** an aborted part read waited for another question's request: 1.5 s after an abort at
  50 ms, now 51 ms.
- **LLF-056, A11:** the time limit of a Gemini part read (180 s) could not be changed, and a part
  read failed after 6 minutes; a timeout was not of kind `"timeout"`.
- **LLF-057:** Gemini encoded tool files with its own base64, beside the shared cache.
- A Gemini part read whose body was a list of chunks kept only the first chunk, and missed an error
  in a later one.
- A part read's time limit did not end the wait for a `fetch` that ignores its signal, in all three
  adapters.

**Storage and operations**

- **NEW-store-call-timeout:** a store that did not answer held a question, `files.delete`, the
  DELETE route and the upload handler's rollback delete forever.
- **Four stuck calls froze a pod:** with the default thread pool, every file call and DNS look-up of
  the process waited.
- On Windows, two sweeps could count one document twice, and two deletes of one document could both
  return true.

**PDFs**

- **An unnumbered Hebrew PDF had no outline** (HARNESS-LESSONS item 4): Hebrew has no capitals, and
  pdf.js gives no blank lines. A Hebrew lease now gets its title, sections and subsections, and the
  isolated child returns the same outline as the server.

**Docs**

- **A1:** the OpenAI recipe uses `reasoning_effort: "none"`, which tool calls on GPT-5.4 and later
  need through Chat Completions.
- **DeepSeek:** in a request with tools, its thinking mode asks for the reasoning of every earlier
  assistant turn, those of earlier questions included, and refuses a request without it (HTTP 400,
  as DeepSeek's guide says). The library does not keep the reasoning of an earlier question, so the
  guide says to turn thinking off for chat requests in a chat of several questions
  ([DeepSeek](docs/guides/openai-compatible.md#deepseek)).

In all, this version fixes LLF-018, -034, -035, -036, -048, -049, -056, -057, -058, -059 and
-061. It closes the roadmap items A5, A6, A11, I6 (`files.toolsFor`), I9 (`ToolCallHooks.signal`),
L1, L5, L7, L12, M8, M9, N12, P8, P9, S3 (in part: the citation check), T4, the leftovers of 0.9.0
(LO-1, LO-2 (the write half), LO-3 to LO-7), NEW-answer-request-tools, NEW-filtered-answer,
NEW-inline-table-tools, NEW-store-call-timeout and NEW-vertex-endpoint-options, and the Hebrew PDF
outline (HARNESS-LESSONS item 4).

## 0.9.0 — 2026-11-24

One server process for every user and chat. Every store call carries the scope and the owner of
the call, `FileDocumentStore` keeps the files of each chat in a folder of its own, documents can
take your application's IDs, and the uploads your application keeps are read where they are
instead of copied into the store. The upload handlers can save each upload where you keep it,
record it in your database and hold large uploads on disk; errors are typed, and `errorInfoOf`
puts them in your users' words. The text sent to the model is the same as in 0.8.2 for ordinary
chats, so conversations keep the provider's prompt cache at the upgrade.
[Upgrading to 0.9](docs/upgrading-0.9.md) takes an application from 0.8.x step by step, with a
worked example of a chatbot on a shared volume.

### Upgrading: what you need to change

Code written for 0.8.2 compiles with 0.9.0, except in these cases
([Does my code compile?](docs/upgrading-0.9.md#does-my-code-compile)):

- `NoticeCode` has three new members, `"documents_missing"`, `"document_gone"` and
  `"page_looks_busy"`, and `IngestErrorCode` one, `"exists"`. An exhaustive `switch` over either,
  or a `Record` keyed by either, needs them.
- `EventError.code` is now `IngestErrorCode | DocumentScopeErrorCode`: the `run.error` or
  `ingest.error` of a scope error carries `"scope_missing"`, `"scope_invalid"` or
  `"scope_required"`. Code that indexes a `Record<IngestErrorCode, …>` with it, or passes it where
  an `IngestErrorCode` is expected, must check it first. A `switch` over it with a `never` check
  needs `"exists"` and the three scope codes.
- `LargeFiles.ingest` takes `IngestInput | IngestFromSource`. Code that reads `input.bytes` of its
  argument fails with TS18048 or TS2532: a `LargeFiles` of your own whose `ingest` parameter is
  inferred (`{ ...files, ingest: (input) => … }`), the calls of a spy or mock of `files.ingest`
  (`spy.mock.calls[0][0].bytes`), and a value typed `Parameters<LargeFiles["ingest"]>[0]`. Code
  that passes `input` to a function that takes `IngestInput` fails with TS2345. Narrow it:
  `if (input.bytes)`, or `"source" in input`. Annotating `(input: IngestInput)` compiles too, but
  only suits a wrapper that is never given a path: `createDocumentHandlers` gives one with
  `uploadSpool` or `prepareUpload`.
- A store of your own, or a subclass of `FileDocumentStore` or `MemoryDocumentStore`, whose method
  takes a parameter of its own after those of 0.8 (`get(id, options?)`, `sweep(now?, dryRun?)`,
  `readTextRange(id, start, end, signal?)`) fails with TS2322 or TS2416. The new `context` takes
  that place, and the library passes it there. Put your parameter after `context`.
- A subclass of `DocumentStoreError` that declares its own `status`, or of
  `DocumentsNotFoundError` that declares its own `status` or `code`: these are now `503`, and `404`
  and `"documents_missing"`.
- A subclass of `IngestError`, `DocumentStoreError`, `DocumentsNotFoundError` or
  `ModelRequestError` whose own static `is` does not fit `(value: unknown) => value is …` (one
  that returns `boolean`, say) fails with TS2417: each of them has a static `is` now. Make yours
  return `value is` your class, or rename it.
- `fromGeminiContents` passed as a callback (`histories.map(fromGeminiContents)`) fails with
  TS2345: its new second parameter would get the index. Write
  `histories.map((contents) => fromGeminiContents(contents))`.
- Code that reads the `messages` of an `AskGeminiOptions` back and reads `text` of a turn fails with
  TS2339, and code that passes them where `Array<ChatTurn | ToolTurn>` is expected with TS2345:
  `messages` is now `ChatMessage[]`, as `askWithFiles` takes it, and a turn may have `parts` instead
  of `text`. Type the history `Array<ChatTurn | ToolTurn>`, or check `"text" in turn`.

The other changes to the public types add exports, options, fields and optional parameters. Each
`DocumentStore` method takes a last, optional `context`: a store whose methods take only the
arguments of 0.8 still implements the interface. The new exports are under **New**.

Some behavior is different. Check each point against your app:

- **Node.js 22.12 or later.** `engines.node` is `>=22.12` (was `>=20.19`): Node 22.0 to 22.11 cannot
  `require()` the package from CommonJS, which the docs promise. CI runs Node 22, 24 and 26, on
  Ubuntu and Windows, and 22.12.0 on Ubuntu, where it also checks `require()` of every subpath of
  the packed tarball. npm only warns (`EBADENGINE`) unless `engine-strict` is set, so an app on
  Node 20 still installs, untested. There, an `unpdf` that cannot load pdf.js now throws its own
  error, not "The unpdf installed cannot read PDF files on Node 20".
  **What to do:** run Node 22.12 or later, and `@types/node` 22 or later in TypeScript projects.
- **The upload handler answers 422 only for an `IngestError` (S12).** A plain `Error` from a
  `LargeFiles` of your own, without a `status` or a system `code`, is answered 500
  `{ "error": "Upload failed." }`: it was 422 with its message, which could name a database host.
  A file of code `"unreadable"` gets fixed words ("This file could not be read. It may be damaged,
  or not of the type its name says."), not its parser's or extractor's message. A model's error
  thrown by an ingest of yours gets the status and words of `errorInfoOf`, not the provider's. A
  `DocumentScopeError` is a 404 "This chat no longer exists." for `"scope_missing"`, and a 500 for
  the other codes. Only the handler's own 413s (its size check, and `IngestError` `"too_large"`)
  get the upload-limit message. `Content-Type` is no longer URI-decoded (`X-File-Type` still is).
  **What to do:** throw `new IngestError(code, message)` for a file you refuse, as the
  `ingestInProcess` recipe of [Deployment](docs/guides/deployment.md#uploads-and-ingest) now does. A
  route of your own answers the same way with `uploadAnswerOf`
  ([node](docs/reference/node.md#how-errors-are-answered)).
- **A store that fails is a `DocumentStoreError`, answered 503.** A failed write of `files.ingest`
  throws one with `operation: "write"` (code `"ETIMEDOUT"` for a write that did not end within
  `ingestTimeoutMs`), a failed `files.delete` one with `"delete"`, a failed `files.sweep` one with
  `"sweep"`. Before, the store's own error came out as it was; it is now the `cause`. The upload
  handler answers a failed write 503 with `Retry-After: 5` (it was a 500), and `get` and `remove`
  answer a store that fails 503 with `Retry-After: 5` (it was a 500, such as "The file could not be
  looked up (EIO)."). The `ingest.error` event of a failed write has `name: "DocumentStoreError"`
  and `status: 503`.
  **What to do:** code that catches its own store error class reads `error.cause`. Log
  `error.cause`: the handlers log nothing
  ([Store failures](docs/upgrading-0.9.md#store-failures-are-documentstoreerror)).
- **`DocumentStoreError` has `status: 503`, and `DocumentsNotFoundError` has `status: 404` and
  `code: "documents_missing"`.** Their `run.error` events carry the status too.
  **What to do:** code that takes any error with a numeric `status` for a model's error checks
  these first: `DocumentStoreError.is(error)`, `DocumentsNotFoundError.is(error)`, or
  `errorInfoOf(error)`.
- **Every store call carries a context.** The library passes `{ scope, owner }` as the last argument
  of every `DocumentStore` method. A wrapper or a subclass that passes only the ID on
  (`super.getMeta(id)`, `(id) => inner.getMeta(id)`) still compiles, but drops it. Over a store that
  keeps scopes apart, such a call does not find the documents stored in a scope. Over a
  `FileDocumentStore` with `scopes`, every call but `sweep` throws a `DocumentScopeError`
  `"scope_required"`. With `unscoped: "root"`, the documents go to the root folder without an error,
  outside the chat's folder, so removing that folder does not erase them. And a `sweep` that drops
  it sweeps every scope: `files.sweep({ scope })` removes the expired documents of every chat. A
  store that ignores the context still keeps scopes apart for the library, through `meta.scope`,
  and then needs application IDs that are unique in the whole store.
  **What to do:** pass the context on (`super.getMeta(id, context)`), and run `documentStoreChecks`
  of `llm-large-files/testing` on your store
  ([Stores of your own](docs/upgrading-0.9.md#stores-of-your-own)).
- **A store that writes the text before the record.** The storage guide's example
  `BlobDocumentStore` wrote the text, then inserted the record under a unique key. When two servers
  ingest one application's ID at the same moment, the ingest that loses has then written its text
  over the winner's. The library now reads the winner's document as missing when the two texts
  differ in length or lines; otherwise it serves the loser's text.
  **What to do:** insert the record first, hidden from `getMeta` until the text is written, as the
  example now does ([Example: object storage and a database](docs/guides/storage.md#example-object-storage-and-a-database)).
  Two ingests of one ID that overlap then both fail with a 503 instead of storing the wrong text.
  With an ID of its own for each upload, as `attach()` and the worked example make, none of this
  happens ([Write the record before the text](docs/upgrading-0.9.md#write-the-record-before-the-text)).
- **New fields in what you store.** `ingest` writes `metaVersion: 1` and `sha256` into every
  `DocumentMeta`, and `scope` and `original` when it is given them. Every `ToolTurn` that
  `askWithFiles` returns has `version: 1`.
  **What to do:** tests that compare a meta or a round whole expect these fields. A schema that
  refuses fields it does not know (a MongoDB `$jsonSchema` with `additionalProperties: false`, a
  Mongoose schema in strict mode that throws) must allow them, for the metadata a store of yours
  keeps and for the rounds you keep with each question: otherwise every ingest fails with a 503.
  Change it before the first server of 0.9.0 starts
  ([Allow the new fields](docs/upgrading-0.9.md#allow-the-new-fields)).
- **Data written by a newer version is refused, not taken for missing.** Metadata with
  `metaVersion` above 1 makes `getMeta`, `getOriginal`, `delete`, `prepare`, `askWithFiles` and the
  tools throw a `DocumentStoreError` of code `"NEWER_VERSION"`, so that your app does not ingest
  the file again over newer data. A stored `ToolTurn` with `version` above 1 makes `askWithFiles`
  throw a `TypeError`, before any request. Servers of 0.8 ignore both fields.
  **What to do:** nothing now. While servers of 0.9 and a later version share a store, let such a
  call be tried again on a newer server; catch the `TypeError` to ask again without the old rounds.
- **Servers of 0.8 and 0.9 on one store.** In the flat layout of `FileDocumentStore`, servers of 0.8
  read what 0.9.0 writes under the library's IDs, and ignore the new fields; 0.9.0 reads what 0.8
  wrote. Servers of 0.8 do not see documents under an application's ID, nor the folders of a store
  with `scopes`, nor an original kept by reference, and they do not check `meta.scope`.
  **What to do:** upgrade first with your settings as they are. Turn on `scopes`, application IDs,
  originals by reference, `requireOwner` and `requireScope` in a later deploy: on every server at
  once, or with each chat kept on servers of one setting. Run the sweep from a server of 0.9.0
  ([Several servers and rolling deploys](docs/upgrading-0.9.md#several-servers-and-rolling-deploys)).
- **`requireOwner` and `requireScope`** (new, off by default) make `createDocumentHandlers` throw a
  `TypeError` without `getOwner`, or without `getScope`. Under `requireOwner`, an owner of
  `undefined` or `null` is answered 401 `{ "error": "Sign in first." }` on every route, and `""` a
  500 "(empty owner)". Documents stored without an owner or a scope then read as missing: those of
  0.8, and those that 0.5.0 stored with the owner `""`.
  **What to do:** give `getOwner` and `getScope`, and turn them on once no server writes documents
  without them ([Moving the documents of 0.8](docs/upgrading-0.9.md#moving-the-documents-of-08)).
- **`FileDocumentStore` writes files `0600` and folders `0700`.** Before, `0666` and `0777` minus the
  umask: `0664` and `0775` under the usual `0002`. Servers, sidecars, and backup or sweep jobs that
  run as other users of one group (a Kubernetes `fsGroup`) read "The document store could not be
  read (EACCES)".
  **What to do:** for those, set `fileMode: 0o640` and `directoryMode: 0o750` on every store. Files
  written before keep their modes: `chmod` them once to narrow them.
- **`FileDocumentStore` follows no link at a document's file name**, except on Windows, which
  cannot refuse one. A document whose `.json` or `.txt` file is a link (left by a migration or a
  deduplication, say) reads as missing on Linux and macOS, and a kept copy (`.bin`) that is a link
  as not kept.
  **What to do:** replace such links with the files they point to before you upgrade.
- **`FileDocumentStore.delete` returns true once the metadata is gone.** A text, index or original
  it cannot remove is left for `sweep`; it used to throw. Removals are tried again for about 2.6 s
  on `EPERM`, `EACCES` and `EBUSY`, as renames are.
  **What to do:** for erasure, keep a sweep running, or remove the scope's folder. Tests that mock
  `fs.rm` to make a removal fail must mock `unlink`.
- **MIME types are cleaned.** `meta.mimeType` is a lowercased type/subtype without parameters
  (`"Text/CSV; charset=x"` is stored as `"text/csv"`). A value that is not a valid type/subtype of at
  most 127 characters, or holds anything but printable ASCII, is stored as
  `application/octet-stream`.
  **What to do:** compare `meta.mimeType` with the clean form.
- **Looks at pages take turns.** In a library, one `view_pages` look runs at a time
  (`maxConcurrentPageLooks: 1`), and the others wait up to 30 s (`pageLookWaitMs`). Past that the
  model is told the server is busy, and the question gets a `"page_looks_busy"` notice. A look
  holds its turn while its PDF is read for at most `ingestTimeoutMs`.
  **What to do:** nothing. On a server with heap to spare, raise `maxConcurrentPageLooks`;
  `Infinity` runs every look at once, as in 0.8.2 ([PDFs](docs/guides/pdfs.md#view_pages)).
- **`fromGeminiContents` turns the library's tool rounds back into stored rounds**, and so does
  `askGemini` with `contents`. Pointers and stand-ins then apply, as with `toolTurns`. The first
  request is the same, byte for byte, for rounds that `geminiToolTurns` wrote. Rounds that 0.5.0
  converted hold `tool_turns_left` in their responses: they are now sent without it, so such a
  conversation misses the prompt cache once.
  **What to do:** nothing. `{ rounds: false }` gives the output of 0.8. With `askGemini`, pass it as
  `messages`: `askGemini({ …, messages: fromGeminiContents(contents, { rounds: false }) })`.
- **Tests of the tool loop.** A first request that stored rounds make too large is shortened before
  it is sent: a test sees a `"results_shortened"` step and one request fewer, not a refused request
  and `"room_made"`. A result that its stand-in would not make smaller (a short grouped search, a
  small `aggregate_table` result) stays whole. An error of an adapter of yours with a `status` and
  no `kind`, as `httpError` of `llm-large-files/testing` makes, gets a `kind` in its `EventError`
  (`"server"` for a 503), and is retried by that kind: a 429 of code `"insufficient_quota"` is a
  quota, and is not sent again. The loop goes by that kind too: an `httpError(413)`, a 429 "Request
  too large … tokens per min" or a 400 of code `context_length_exceeded` is an overflow it mends.
  Older results are shortened and the request is sent again (`"room_made"`), or a first request is
  planned again (`"replanned"`), so a test that expected the question to fail at once sees one more
  request. Thrown plain data with a status is "Something went wrong." in its event.
  **What to do:** update the tests that compare these whole.
- **`isDocumentId` accepts application IDs.** It tests `APP_DOCUMENT_ID_PATTERN`, which the
  library's `doc_` IDs match too.
  **What to do:** to tell the library's IDs from yours, test `DOCUMENT_ID_PATTERN`.
- **If you give documents your own IDs** (`IngestInput.id`, new): they reach the model, in what it
  is sent of each document and in its tool calls, so they must hold no personal data. A taken ID is
  an `IngestError` `"exists"` (409), and so is a second ingest of one ID while the first is under way
  in the library. In a folder that `FileDocumentStore` shares with your files, an ingest under the
  ID `report` writes over your `report.txt`.
  **What to do:** use random IDs, or IDs with a prefix per tenant
  ([Application IDs](docs/guides/storage.md#application-ids)).
- **If you keep the uploads yourself:** `keepOriginals` still copies each kept file into the store.
  With `original: { ref }` and `originals` (`fileOriginals(root)` of `llm-large-files/node`), the
  store keeps no copy, and `view_pages` reads your file, checked against the size and SHA-256 it had
  at ingest. The library never writes, moves or deletes it. Documents ingested before keep their
  copy. A server of 0.8 finds no copy of such a file: its `view_pages` answers that the original is
  no longer on the server.
  **What to do:** remove the file with its chat
  ([The file your application keeps](docs/guides/storage.md#the-file-your-application-keeps)).
- **The text sent to the model** is that of 0.8.2 for ordinary chats. Text is new only when its case
  happens: the line for documents left out under `onMissingDocuments: "drop"`, the busy answer of
  `view_pages`, and its answers for a file kept by reference that changed and for a PDF the store
  did not return in time. A document ingested under your ID is named by that ID. A right-to-left
  PDF table ingested from 0.9.0 on can read in another order (LLF-037, under **Fixed**); documents
  ingested before keep their text.
  **What to do:** nothing.

### New: what you can add

**Owners, scopes and IDs**

- **Scopes:** `IngestInput.scope`, `AccessOptions.scope`, `AskOptions.scope` (also in `askStream`
  and `askGemini`) and `files.sweep({ scope })`, with the types `DocumentScope` and
  `DocumentContext`. A document with a scope serves only a caller of the same scope
  ([Scopes](docs/guides/storage.md#scopes)).
- **`requireOwner` and `requireScope`** in `createLargeFiles`, both off: a call without an owner, or
  without a scope, throws a `TypeError`. `files.access` says which are on
  ([Storage](docs/guides/storage.md#requiring-an-owner-and-a-scope)).
- **Application IDs:** `IngestInput.id`, `ifExists` (`"fail"` by default, or `"replace"`) and
  `APP_DOCUMENT_ID_PATTERN` ([Application IDs](docs/guides/storage.md#application-ids)).
- **A folder per user and chat:** `FileDocumentStore`'s `scopes` option
  (`{ depth, folder, createScopeFolders, unscoped }`) keeps each scope's files in
  `<root>/<user>/<chat>/.llm-large-files/`, under one library for the process. Also its options
  `fileMode`, `directoryMode` and `sweepConcurrency`, the types `FileDocumentStoreOptions` and
  `FileDocumentScopes`, and `isSafeScopeSegment` and `hashedScopeSegment`
  ([Files in a folder per user or per chat](docs/guides/storage.md#files-in-a-folder-per-user-or-per-chat)).
- **`MemoryDocumentStore`** keeps each scope's documents apart.
- **`ToolOptions.access`:** `files.tools()` checks the owner and scope the store holds, not those
  of the metadata it is given ([Your own loop](docs/guides/own-adapter-and-loop.md#your-own-loop)).

**Ingest**

- **Ingest from a path:** `files.ingest({ name, source: { path } })` (`IngestFromSource`,
  `IngestSource`). The file is looked at with `lstat` at the call, and read once at its turn, so
  ingests that wait hold none of their files: 100 ingests of 2 MB waiting for their turn held 73 MB
  as paths, against 282 to 286 MB with their bytes
  ([IngestFromSource](docs/reference/library.md#ingestfromsource)).
- **Originals by reference:** `IngestInput.original: { ref }`, `LargeFilesOptions.originals`
  (`OriginalsReader`, `OriginalReadContext`), and `fileOriginals(root)` in `llm-large-files/node`.
  `meta.original` records the ref, the size and the SHA-256
  ([Storage](docs/guides/storage.md#the-file-your-application-keeps)).
- **`DocumentMeta.sha256`:** the SHA-256 of each upload, to find the same file twice in a chat. The
  library does not dedupe.
- **`Extractor.readsPath`**, with `ExtractInput.path`, `ExtractInput.maxUploadBytes` and
  `ExtractedText.file`: an extractor that reads the file itself. `createIsolatedExtractors` sets it
  ([Extractor](docs/reference/library.md#extractor)).

**Upload handlers** (`llm-large-files/node`)

- **`getScope(request)`:** the scope of each upload, get and delete
  ([node](docs/reference/node.md#what-getscope-returns)).
- **`onUploaded` and `onRemoved`:** record an upload in your database before it is answered, and a
  removal after it. `{ answer }` joins the 201 and `ingest.finish.app`. Types `UploadedContext`,
  `UploadedResult` and `RemovedContext`
  ([hooks](docs/reference/node.md#the-hooks-onuploaded-and-onremoved)).
- **`prepareUpload(request, { name, owner, scope })`:** the upload's ID, and a path where its body
  is saved as it arrives, kept by reference with `original`. Types `PrepareUploadInfo` and
  `PreparedUpload`, and `uploadFileMode` (`0o600`)
  ([Web app](docs/guides/web-app.md#save-each-upload-where-you-keep-it-prepareupload)).
- **`uploadSpool`** (`true`, or `UploadSpoolOptions`; off by default) and `maxSpooledUploadBytes`
  (ten times `maxUploadBytes`): bodies over 1 MiB, or without a `Content-Length`, wait for their
  ingest on disk ([spooling](docs/reference/node.md#spooling-uploadspool)).
- **`uploadAnswerOf(error)`** and `UploadAnswer`: how the handlers answer an error, for a route of
  your own ([node](docs/reference/node.md#how-errors-are-answered)).

**Questions**

- **`onMissingDocuments`** in `askWithFiles`, `askStream` and `askGemini`: `"throw"` (the default),
  `"drop"`, or a function that can ingest them again (`{ retry: true }`, `{ replace }`). Also
  `AskResult.missing`, and the types `MissingDocumentsAction` and `MissingDocumentsContext`
  ([missing documents](docs/reference/ask.md#missing-documents)).
- **Notices** `"documents_missing"`, `"document_gone"` and `"page_looks_busy"`, and `documentIds`
  on the `notice` event ([events](docs/reference/events.md#noticecode-and-noticedisplay)).
- **`maxConcurrentPageLooks`** (1) and **`pageLookWaitMs`** (30,000) in `createLargeFiles`. For
  loops of your own: `ToolCallLimits.maxWaitMs`, and `ToolCallHooks.onDocumentGone` and
  `onPagesBusy` ([library](docs/reference/library.md#largefilesoptions)).
- **`fromGeminiContents(contents, { rounds })`** and `FromGeminiContentsOptions`
  ([gemini](docs/reference/gemini.md#fromgeminicontentscontents-options)).
- **`AskGeminiOptions.messages` takes what `askWithFiles` takes (`ChatMessage[]`):** plain turns,
  stored tool rounds, and turns with parts, such as `fromGeminiContents(contents, { rounds: false })`
  gives. It was `Array<ChatTurn | ToolTurn>` ([gemini](docs/reference/gemini.md#askgeminioptions)).

**Errors and versions**

- **`errorInfoOf(error)`**, with `ErrorInfo` and `ErrorCategory`: one record for any error of the
  library, or its `EventError`: a category, a code, the HTTP status, whether to retry and after how
  long, and an English message that is safe to show. One `switch` maps it to your users' language
  ([Errors and reliability](docs/guides/errors-and-reliability.md#your-users-words-errorinfoof)).
- **`DocumentScopeError`** (`"scope_required"`, `"scope_invalid"`, `"scope_missing"`) and
  `DocumentScopeErrorCode`. `DocumentStoreError` takes `{ operation, code }`, and has `operation`
  (`DocumentStoreOperation`). `IngestErrorCode` `"exists"` (409).
- **A static `is(value)`** on `DocumentStoreError`, `DocumentScopeError`, `DocumentsNotFoundError`,
  `IngestError` and `ModelRequestError`, which works across two copies of the package
  ([errors](docs/reference/errors-and-retries.md#telling-errors-apart-across-copies-of-the-package)).
- **`DOCUMENT_META_VERSION`** and **`TOOL_TURN_VERSION`**, and the fields `DocumentMeta.metaVersion`
  and `ToolTurn.version` ([library](docs/reference/library.md#document_meta_version)).

**Testing**

- **`llm-large-files/testing`:** `fakeModel` (with `says`, `calls` and `httpError`), `fakeFetch`
  (with `sse`), the test documents `utf8` and `serviceLog`, and `documentStoreChecks`, the checks a
  store of your own must pass. It needs no test framework
  ([reference](docs/reference/testing.md), [guide](docs/guides/testing.md)).

One library for a chat server, with a folder per user and chat:

```ts
import { createLargeFiles, FileDocumentStore, hashedScopeSegment } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";

const VOLUME = "/mnt/documents";

export const files = createLargeFiles({
  store: new FileDocumentStore(VOLUME, { scopes: { depth: 2 } }), // <user>/<chat>/.llm-large-files/
  keepOriginals: ["pdf"],
  requireOwner: true,
  requireScope: true,
});

// The scope is [hashedScopeSegment(userId), chatId]: a user ID may hold capitals or an "@", which
// cannot name a folder. Make the folder <VOLUME>/<user>/<chat> when you create the chat: the store
// makes only .llm-large-files inside it (createScopeFolders is off).
export const documents = createDocumentHandlers(files, {
  getOwner: (request) => userIdOf(request),
  getScope: (request) => [hashedScopeSegment(userIdOf(request)!), chatIdOf(request)],
});
// Ask with the same owner and scope: askGemini({ files, endpoint, owner: userId, scope: [hashedScopeSegment(userId), chatId], … }).
```

`userIdOf` is your sign-in, and `chatIdOf` one of the user's own chats, as an ID that passes
`isSafeScopeSegment`. To save each upload where you keep it and read it there, add
`prepareUpload` and `originals`, as the
[worked example](docs/upgrading-0.9.md#a-worked-example-a-hebrew-chatbot-on-gemini-mongodb-and-a-shared-volume)
does.

### Changed: what works differently

**Storage**

- One ID in two scopes is two documents everywhere, in memory too. The cache, the decoded pieces
  and the documents being opened are kept per scope, and a copy is checked against the owner the
  store holds. A delete or a re-ingest of an ID forgets its copies in every scope.
- An owner or a scope of `null` from a store (MongoDB writes left-out fields that way) counts as
  absent. Metadata that a store returns for another ID than the one asked for reads as missing. So
  does a text read whole whose length or number of lines is not what its metadata says, and a text
  read by range whose index, built again, does not match its metadata: the index is built again
  when none is saved, or when the text does not end where the saved one says. A store that writes
  the text and the metadata apart can give one document's metadata with another's text, when two
  servers ingest one ID at the same moment. Before, a text read whole was not checked, and an index
  built again from a text that did not match its metadata was used. A text of the same length and
  lines is not caught. Opening a document through its saved index reads one byte across the end of
  its text: one `readTextRange` call more.
- The reads of a document's text (`get`, `readTextRange`, `getIndex`, and `putIndex` when an index
  is built again) carry the caller's scope and the document's owner. `getMeta`, `getOriginal` and
  `delete` carry the caller's ([Writing a store of your own](docs/guides/storage.md#writing-a-store-of-your-own)).
- After a tool call or `prepare` reads a document by range, and after `getOriginal` or `view_pages`
  reads an original, the library calls `getMeta` once more. The read is missing unless the store
  still describes the same document, of the same owner and scope. A kept original must also have
  the document's size and, for documents of 0.9.0 and later, its SHA-256.
- `MemoryDocumentStore.getOriginal` returns a copy of the bytes (S7).
- `FileDocumentStore.sweep` reads 16 files at once (`sweepConcurrency`): 5,000 documents took about
  1.1 s instead of 2.5 s on a local SSD. It counts only the documents whose metadata it removed
  itself, and follows no link. In a folder shared with your files, it removes files of no document
  only under the library's IDs, or temporary files.
- `FileDocumentStore` follows no link at a file name: such a document counts as missing. Windows
  cannot refuse such a link, so there it is followed.

**Ingest**

- Every ingest hashes its upload with SHA-256, in 1 MB slices between other work: a few
  milliseconds of CPU for each MB. 100 ingests of 2 MB logs took the same time in all as without it.
- `createIsolatedExtractors` reads a file ingested from a path in its child process, and the
  server reads none of it, unless the store keeps a copy (`keepOriginals` with a store that has
  `putOriginal`, and no `original`).
- `keepOriginals`, the acceptance of a scanned PDF and the offer of `view_pages` count a file kept
  by reference when the library has `originals`.

**Upload handlers**

- `maxPendingUploadBytes` counts only the bodies held in memory: a body written to a file (the
  spool, or the path of `prepareUpload`) takes no room of it.
- `uploadIdleTimeoutMs` (30 s) also bounds each disk call for a body written to a file: the check
  of the folders of a ref, the opening, each write and the closing. A volume that stops answering
  fails the upload with 500 `{ "error": "Upload failed (ETIMEDOUT)." }` and gives its room back. A
  removal of such a file is waited for no longer than that, and then goes on alone. On a slow
  network volume, raise `uploadIdleTimeoutMs`: a close can wait for the writes the system held back.
- An upload whose `request.body` holds an object with fields (`express.json()` in front) gets its
  400 before the check of room.
- An ingest of your own that sends `ingest.finish` and then fails ends the event stream with
  `ingest.error`.
- The `ingest.error` of the handlers names a store that failed (`"DocumentStoreError"`), documents
  that are gone (`"DocumentsNotFoundError"`) and a scope error (`"DocumentScopeError"`, with its
  code), and carries the `kind` of a model's error, so `errorInfoOf` reads it as the error.
- `sseMessageOf` sends `missing` in the result of `run.finish` and in the partial of `run.error`.

**Questions**

- Stored rounds that would make the first request larger than its room in tokens are shortened
  before it is sent, for every model, Claude included. The request is what 0.8.2 sent after the
  provider refused it, without the refused request.
- A function part kept in Gemini's own form is sized by the JSON of its call or response, a thought
  signature included in bytes, not as media. A chat whose history is in `contents` may plan a file
  as a card one question earlier.
- A result is not replaced by a stand-in as large as itself or larger.
- A tool call that finds a document gone during the question gives a `"document_gone"` notice.
- With `eventResults: true`, the full `DocumentMeta` in events also holds `scope`, `sha256` and
  `original`, with its ref, as `AskResult.plan` does. Keep such events on your server.

**Errors**

- A model's `EventError` always has its `kind`. An error with a `status` of 0 or 400 to 599 and no
  `kind` of its own gets the one `classifyModelError` gives its status, message and code. The
  library's own errors with a status (`DocumentStoreError`, `DocumentsNotFoundError`, `IngestError`,
  `DocumentScopeError`) get none.
- `withRetry` sends such an error again by that kind: a 429 of code `"insufficient_quota"` (a quota)
  or a 429 "Request too large … tokens per min" (an overflow) is not sent again. Before, both were
  sent again by their status. The library's own adapters do not change.
- The loop acts on that kind too. For such an error of kind `"context_overflow"` (an
  `httpError(413)`, a 429 for the tokens a minute, a 400 of code `context_length_exceeded`), it makes
  the request smaller, plans the documents again, or reads a part of a whole-file read as two
  halves, with the numbers its message gives, as for a `ModelRequestError` of that kind. Before, the
  question failed. The message of an error that is not an `Error` (an SDK's own class) gives its
  kind too, in its event as in the loop and `errorInfoOf`.
- The `EventError` message of thrown plain data with a status, or of a status that is not a model's,
  is "Something went wrong.".
- An extractor's own subclass of `IngestError` is named `"IngestError"` in its `EventError`, and a
  store's subclass of `DocumentStoreError` `"DocumentStoreError"`, so `errorInfoOf` reads their
  events.

**Release**

- Each release publishes the tarball CI checked, byte for byte. A job without npm's identity token
  builds, tests and packs it, then checks it as npm installs it: with and without the optional
  dependencies, `import` and `require()` of every subpath, an ingest in a child process of
  `createIsolatedExtractors`, a consumer compiled under NodeNext, Bundler and Node10 with
  `skipLibCheck: false`, publint and arethetypeswrong. A second job, the only one with the token,
  stages that file with `npm stage publish` and provenance
  ([Publishing](docs/publishing.md#what-the-release-workflow-does)).
- The package is type-checked without the DOM library (`lib: ["ES2023"]`), as a server app compiles:
  its declarations need only `@types/node`.

### Fixed

**Access and storage**

- **S3:** `files.tools()` given metadata read straight from the store (`await store.getMeta(id)`)
  could read another user's document. With `access` it cannot, and `askWithFiles` always passes it.
- **S12:** a `LargeFiles` of your own whose `ingest` threw a database driver's error sent that
  error's host to the browser, in a 422. An error that your store gave its own `status` reached the
  client with its message too; it is now the `cause` of a `DocumentStoreError`.
- **A Node system error whose `code` is not a code** (a driver may put "db-prod.internal:27017"
  there) gave that host in the upload answer, in its `ingest.error` and `run.error`, and in a tool
  result sent to the model. A code is now told only when it reads as one: capitals, digits and `_`.
- **S11:** an upload's MIME type with CRLF, U+202E, tag characters or 8 KB of text was stored as
  given, and reached the metadata, the summaries, `ingest.finish` and logs. The handler also
  URI-decoded a `Content-Type` such as `text/plain%0D%0A…` into a line break.
- **S10:** `FileDocumentStore` files were readable by every user of the machine (`0664` under umask
  `0002`).
- **S8:** `FileDocumentStore.getMeta`, `get` and `getOriginal` threw when an expired document could
  not be removed, on every try, for a document that was gone. They return undefined, and `sweep`
  tries again.
- **S9, LLF-027:** `files.delete` failed on Windows while another process held a file open for a
  moment (`EBUSY`, `EPERM`), and threw when the metadata was gone but the text could not be removed.
- **An ingest whose caller left during the store write** still stored the document, never cleaned
  under `ttlMs: Infinity`. Once the writes end, what they stored is now removed, and `ingest` throws
  `signal.reason`. With the upload handlers, a client that leaves before its ingest ends leaves
  nothing stored, and `onUploaded` is not called.
- **An owner of `null` from a store** read as missing in `getMeta`, and as open to all in the tools.
- **LLF-055:** the docs said renames are tried again for about three seconds; the pauses add up to
  2.63 s.
- **LLF-022:** `examples/server.ts` listened on every interface, gave uploads no owner, so any
  browser could read any upload by its ID, and kept chats by chat ID alone. It listens on 127.0.0.1
  unless `HOST` is set, gives each browser a random `HttpOnly`, `SameSite=Strict` cookie as its
  owner, runs with `requireOwner`, keeps chats by owner and chat, reads PDF and Office files with
  `createIsolatedExtractors`, and says it is not for production as is. It also no longer crashes on
  an unhandled rejection when the body of a chat request is cut off.

**Questions**

- A first request whose stored rounds were over the token limit was sent before anything was
  shortened: one refused request per question on most models, and a failed question on Claude,
  whose conversation may not be shortened.
- Function parts in a `contents` history were sized as media: about 15,000 tokens short in a test
  of two calls, so planning left too little room.
- A stand-in could be larger than the result it replaced: 845 characters grew to 1,073, and 877 to
  1,041.
- Six looks at pages at once ran together: each about four times slower, and 352 MB more than one
  look (P10).
- A document that expired (`ttlMs`, 72 hours by default) failed the whole next question. With
  `onMissingDocuments: "drop"`, the question is answered without it.
- The docs gave `tool_turns_left` as the only reason why the first request of a follow-up misses
  the prompt cache. Stored rounds also drop the model's thought signatures and thinking blocks: the
  docs say so now, and the change in code waits for 0.10.0.

**PDFs**

- **LLF-037:** in a right-to-left PDF table (Hebrew, Arabic), a Latin name or number that pdf.js
  gives as several items was written backwards: a city cell of "New" and "York" read "York New", a
  model "AB" + "-12" read "-12AB", and "8,300" + ",000" read ",0008,300". Each run of words in a
  cell now reads in its own direction, and the runs follow the direction of the table. A Hebrew
  phrase in several items inside a left-to-right table, also reversed before, reads right too. A
  number before its unit or currency ("16 GB", "1,000 USD") reads as before. Documents ingested
  before keep their text: upload such a PDF again.

**Uploads**

- Without a `Content-Length`, an upload took `maxUploadBytes` of room until it was read, so two
  filled the default `maxPendingUploadBytes`, and a third got a 503 while they arrived. With
  `uploadSpool` they wait on disk, and three or more fit.
- A client that left while `getOwner` ran, when a framework had already read the body
  (`express.raw()` in front), was not noticed: its upload was ingested and stored for nobody. It now
  stores nothing, as for a client that leaves later.

**Docs**

- [Deployment](docs/guides/deployment.md#memory-on-each-server) sized an ingest from figures
  recorded before 0.6.0 (five to seven times the log above the upload), and gave 34 ms as its
  longest stall, for a 99 MB log. Measured again on 0.9.0 with Node 22 on Linux, over a
  `FileDocumentStore`, on a busy laptop: three and a half to five and a half times the log (135 MB
  for 25 MB, 345 MB for 95 MB), and a longest stall of 56 to 64 ms for 25 MB and 0.23 to 0.36 s for
  95 MB. The old figures stay in [Measurements](docs/measurements.md#the-server), marked as history.

## 0.8.2 — 2026-11-23

Memory when many users upload at once. A review of how the library holds files found that every
upload a server received was ingested at the same time, with nothing to bound the memory, and that
the meta `ingest` returns kept the whole text of its file in memory. Ingests now take turns, two at
a time in each library; the upload handler takes uploads up to twice the upload limit at once, and
answers the others 503 with `Retry-After` before reading them; and the meta is a copy. Measured
with 100 logs of 2 MB sent at once: a peak of 329 to 356 MB of memory instead of 817 to 830 MB
(about 190 MB of it the 100 uploads themselves), the first user answered after 0.5 to 0.7 s instead
of 25 to 39 s, half of them after 13 to 17 s instead of 27 to 40 s, and all of them in 28 to 33 s,
against 28 to 42 s. It is a patch: no code needs to change, and since 0.8.0 an upload could already
be answered 503 with `Retry-After` (by busy readers of `createIsolatedExtractors`).

### Upgrading: what you need to change

Code written for 0.8.1 compiles with 0.8.2 as it is: the three new options are optional.

- **Ingests of one library take turns, two at a time** (`maxConcurrentIngests`).
  **What to do:** nothing. To have every ingest start at once, as before, set
  `maxConcurrentIngests: Infinity`. With `createIsolatedExtractors({ concurrency })` above 2, raise
  `maxConcurrentIngests` to at least `concurrency`, or the extra readers stay idle. An app that makes
  a library per chat or per request ([Storage](docs/guides/storage.md#files-in-a-folder-per-user-or-per-chat)) gets
  a queue per library, so ingests of different chats still all work at once: bound them for the
  process yourself.
- **`createDocumentHandlers` answers an upload 503, with `Retry-After: 5`, when uploads are already
  held and that one would bring them past twice `maxUploadBytes`** (200 MB by default).
  **What to do:** a client that sends many files at once sends a refused one again after
  `Retry-After`, as it does for a busy `createIsolatedExtractors` ([the browser code in Web
  app](docs/guides/web-app.md#upload-from-the-browser) now does). To change the limit, set
  `maxPendingUploadBytes`; `Infinity` turns it off.
- **An upload whose body stops arriving for 30 s is answered 408** and its connection closed
  (`uploadIdleTimeoutMs`).
  **What to do:** nothing, unless your users send large files over links that stall for longer:
  raise `uploadIdleTimeoutMs`, or set 0 to wait as before.
- **A store write that does not end within `ingestTimeoutMs` (2 minutes by default, and when it is
  0) fails the ingest**, as a failure of the store (`The store did not finish writing app.log within
  2 min.`; the upload handler answers 500), and the document is removed once the write ends. Such a
  write held the ingest, and with the new limits its turn and its upload's room, forever.
  **What to do:** nothing, unless your store takes longer than that to write a file: raise
  `ingestTimeoutMs`.
- **A `LargeFiles` of your own given to `createDocumentHandlers` must have `maxUploadBytes`**, as its
  type says: without a number above 0 (from JavaScript), `createDocumentHandlers` throws a
  `TypeError`. Such an object had no upload limit at all.
  **What to do:** keep the `maxUploadBytes` of the library it wraps (`{ ...files, ingest }` does).

### New: what you can add

- **`maxConcurrentIngests`** in `createLargeFiles` (see
  [the options](docs/reference/library.md#largefilesoptions)): how many ingests do their work at
  once in the library, 2 by default.
- **`maxPendingUploadBytes`** in `createDocumentHandlers` (see
  [the options](docs/reference/node.md#documenthandleroptions)): the most bytes of uploads the
  handlers hold at once, twice `maxUploadBytes` by default.
- **`uploadIdleTimeoutMs`** in `createDocumentHandlers`: how long the body of an upload may stop
  arriving, 30,000 ms by default.

### Changed: what works differently

- **Ingests take turns.** The others wait in the order they came; their `ingestTimeoutMs` starts
  when their turn comes, and a caller that gives up while it waits gets its own reason, with
  nothing stored. An empty file, or one over `maxUploadBytes`, is refused without waiting. An
  ingest keeps its turn until its work ends: when its time is up or its caller left while an
  extractor goes on (one that does not stop on the signal, such as the parse of a PDF by
  `@cantoo/pdf-lib`), until that extractor ends, or `ingestTimeoutMs` more (2 minutes when that is
  0) when it never does, so that it cannot stop every later ingest. An extractor of your own must not wait on an ingest of the same library
  (to store the parts of an archive, say): that ingest waits for a turn like the others, and with
  every turn held by such extractors, each waits on itself until its time is up. A library sends `createIsolatedExtractors` at most `maxConcurrentIngests` files at
  once, so its own queue fills only when several libraries share one set of readers.
- **The upload handler holds a bounded number of bytes.** An upload is held from the reading of
  its body to the end of its ingest, on the event-stream path too (also after its client went
  away, until its ingest stops). Its room is taken before its body is read: its `Content-Length`,
  or `maxUploadBytes` until its body is read when it declares none. One upload alone is always
  taken. A `Content-Length`, or a body a framework already read, over `maxUploadBytes` is answered
  413 before any check of room. A client that sends its headers and then nothing holds its room
  until `uploadIdleTimeoutMs`; one that trickles, until `server.requestTimeout`: a proxy that reads
  whole bodies before passing them on avoids both
  ([Deployment](docs/guides/deployment.md#uploads-and-ingest)).
- **Docs:** a search of a document read by range takes tens of MB at its peak (60 to 80 MB for a
  log of 95 MB on Windows, 49 MB above the process for one of 100 MB on Linux), not "a few MB"
  ([Deployment](docs/guides/deployment.md#memory-on-each-server)).

### Fixed

- **The meta that `ingest` returns no longer keeps the whole text of its file in memory.** The
  first and last timestamps of a log, and the headings of an outline, were pieces of the text, and
  a piece keeps the whole text it was cut from: a meta an application held took 25 MB of heap for a
  log of 10 MB in Hebrew, 194 MB for one of 100 MB, and 13 MB for 5.5 MB of Markdown. It is now a
  copy made through JSON, as `FileDocumentStore` gives it back, and takes a few KB. The store's copy
  was never affected.
- **A document whose text was removed while its metadata stayed is reported missing**, by
  `prepare` and by `askWithFiles` (`DocumentsNotFoundError` with its ID), as one whose metadata is
  gone. When it was read by range (more than `wholeDocumentBytes` of text, 2 MB by default), the
  question failed with a plain `Error` ("doc_… is no longer available on the server"). A cleanup
  outside the library that removes only the text files (or a lifecycle rule of an object store on
  the text objects) leaves documents so.

## 0.8.1 — 2026-11-23

Exact numbers from tables. `aggregate_table` counts, sums, averages and groups the rows of a CSV
file, a sheet of a workbook or a `| cell |` table of any document, reading every row, with no code
run; it finds headers of several rows and a title above them. Search hits say which section and
which table header they belong to. A file whose name says nothing is known by its bytes, and the
card says which PDF pages have no text or a garbled one. Checked live with the Gemini API on
`gemini-3.5-flash-lite` and `gemini-3.8-flash`: a sum and a count by region of a workbook, averages
per region, refunded orders of a CSV with a title row, and a row found by search named by its
header; all eight answers right, the counts with one `aggregate_table` call.

### Upgrading: what you need to change

Code written for 0.8.0 compiles with 0.8.1 as it is: every change to the public types is an
addition (`TOOL_NAMES.aggregate`, optional fields of `DocumentMeta`, an optional third parameter of
`detectFormat`). A `Record` of your own keyed by the tool names needs the new one.

- **A new tool, `aggregate_table`, is offered with CSV, XLSX, DOCX, PPTX, PDF, HTML and Markdown
  documents**, with one more line in the tool guide. The tool set and the guide the model is sent
  change for those documents, so the provider's prompt cache misses once.
  **What to do:** nothing. A loop of your own that runs `files.tools()` gets it too.
- **Search results have two more fields:** `section` on a match in a document with an outline, and
  `table_headers` on a result whose matches are rows of a table. Tests that compare whole results
  need them.
  **What to do:** nothing, unless your tests compare search results whole.

### New: what you can add

- **`aggregate_table`** (see [`aggregate_table`](docs/reference/tools.md#aggregate_table)): `metrics`
  (`count`, `sum:Column`, `avg:`, `min:`, `max:`, `count_distinct:`), `group_by` (up to 3 columns,
  a date column by `:year`, `:month` or `:day`), `filters` (`=`, `!=`, `>`, `>=`, `<`, `<=`,
  `contains`, `not_contains`, `starts_with`, `empty`, `not_empty`), `order_by`, `limit`, `table` (a
  sheet's name or number, a table's number) and `header_rows`. Numbers are read as people write
  them ("1,234.5", "(1,200)", "₪4,750", "12,5"); cells that are not numbers are counted apart. A
  header of two or three rows is joined ("Q1 / January"), a title row above it is left out, and a
  header repeated inside the table is not a row. Each group cites the lines of its first rows.
- **`DocumentMeta.pagesWithoutText`, `garbledPages` and `scripts`**, worked out at ingest and shown
  on the card: the PDF pages with no text (scans, photos) and those whose text looks garbled, with
  a pointer to `view_pages` when they can be looked at, and the scripts of a text that is not in
  Latin letters alone ("Written in: Hebrew 81%, Latin 19%").
- **`detectFormat(name, mimeType, bytes?)`** and `ingest`: a file whose name and type give no format
  is known by its bytes (a PDF header, the parts of a DOCX, PPTX or XLSX, a first `<html>`). A file
  named `.txt` stays text.

### Changed: what works differently

- **Search hits say where they sit** (F15): `section` is the heading above a match ("2.1 Rent",
  "Sheet 2: Sales"); `table_headers` gives the first row of each table a match is in (line 1 of a
  CSV file, a sheet's first row, a `| cell |` table's first row), so a hit like `Row 812: | 4,200 |`
  is understood without another read.

## 0.8.0 — 2026-11-23

Files from an enterprise, read with their structure, and counted exactly. Word files keep their
headings, clause numbers and tables; PowerPoint decks their order, tables and speaker notes; Excel
workbooks and HTML pages are read for the first time. Search works in every script (Hebrew with
its prefix letters, Hindi, Thai, Chinese, text composed or decomposed), can search part of a file,
show the last matches, and count matching lines per hour, per code or per message shape in one
call. Untrusted PDF and Office files can be read in child processes with a memory limit and a kill
timer, and every refusal says why with a code. 0.7.1 was never published: its fifteen fixes ship
here, and its points are part of this entry. Checked live with the Gemini API on
`gemini-3.5-flash-lite` and `gemini-3.8-flash`: hourly counts and the last line of a log in one
search, a clause of a Hebrew lease answered in Hebrew, a row of a workbook, a table of an HTML page.

### Upgrading: what you need to change

Code written for 0.7.0 compiles with 0.8.0, with one exception: `DocumentFormat` has two new
members, `"xlsx"` and `"html"`. An exhaustive `switch` on a document's format, or a
`Record<DocumentFormat, …>` of your own, needs the two cases. Every other change to the public
types is an addition: `IngestError`, `ingestErrorCodeOf` and the type `IngestErrorCode` in
`llm-large-files`; `createIsolatedExtractors` and the types `IsolatedExtractorOptions` and
`IsolatedExtractors` in `llm-large-files/node`; an optional `code` in `EventError`.

Some behavior is different. Check each point against your app:

- **Excel and HTML files are read.** An `.xlsx` (and `.xlsm`) upload was refused with "This file is
  a ZIP archive"; it is now a document of format `"xlsx"`. An `.html` or `.htm` file was read as
  text, tags and all, with format `"text"`; it is now format `"html"`, with the text a browser
  shows. Both need nothing new: XLSX uses the optional `jszip`, as DOCX does.
  **What to do:** if your app lists the formats it accepts, add them. See
  [formats](docs/reference/library.md#documentformat).
- **Word and PowerPoint files are read with their structure.** A DOCX heading is written as a
  Markdown heading, a numbered paragraph with its number (`## 2.1 Rent`, `(a) the flat`), a table
  as rows of `| cell | cell |  |` with its empty cells, and the footnotes, endnotes, comments,
  headers and footers each under a heading of its own (a repeated header once). A PPTX is numbered
  in the order of its slide show, with its tables and its speaker notes. Documents ingested by
  0.7.0 keep the text they have until they are uploaded again.
  **What to do:** nothing, unless your tests compare the text of a DOCX or PPTX: update them.
- **`ingest` throws `IngestError` for a file it cannot read.** It is an `Error` with the same
  message as before, a `code` (`"too_large"`, `"no_text"`, `"hostile"`…), the HTTP `status` the
  upload handler answers with, and the extractor's error as `cause`. A store that failed, a caller
  that gave up, a listener that threw and a system error from an extractor of your own are thrown
  as before. `ingest.error` events carry the `code`, and name `"IngestError"` where they named
  `"Error"`.
  **What to do:** nothing; to tell users in your own words (another language), map `error.code`.
  A test that expects `name: "Error"` in an `ingest.error` event needs `"IngestError"`.
- **The answer is asked for in the language of the question.** The three closing requests
  (`FINAL_ANSWER_REQUEST`, `FINAL_ANSWER_AFTER_PAGES`, `FINAL_ANSWER_WITHOUT_TOOLS`) end with
  "Answer in the language of my question." A model asked in Hebrew answered in English after an
  English closing request.
  **What to do:** nothing; to have answers in one language whatever the question, say so in
  `system`.
- **The text the model is sent changed:** the description of `search_document` (its new
  arguments), the tool guide (two lines: counts by group and paging; searching the bare form of a
  word), and the closing requests. The provider's prompt cache misses once after the upgrade.
  **What to do:** nothing. See **Changed** for what models now do.
- **Text is composed (NFC) at ingest.** "e" followed by a combining accent becomes "é". Line counts
  do not change; `characters` and the sizes of such a text can be a little smaller. A run of more
  than 30 marks on one letter, which no script writes, gets an invisible combining grapheme joiner
  (U+034F) after each 30, as Unicode's stream-safe form does: composing such a run took time by its
  square, and 600 KB of them held the server 80 seconds.
  **What to do:** nothing.
- **More files are taken for logs.** A `.txt` of nginx or Apache access lines, JSON log lines,
  klog or logfmt is now format `"log"`, with a log profile; levels in lower case, in brackets,
  after `level=`, in a JSON field or as pino numbers are counted.
  **What to do:** nothing, unless your app switches on `format === "text"` for such files.
- **From 0.7.1** (never published), some values that were taken in silence and did not work are
  refused:

  - **NaN in a number option of `createLargeFiles` throws.** `ttlMs`, `maxUploadBytes`,
    `scannedPdfPages`, `cacheBytes`, `cacheSize`, `wholeDocumentBytes`, `scanChunkBytes` and
    `maxConcurrentScans` throw a `RangeError` for NaN (what `Number(process.env.X)` gives for a
    variable that is not set), and a `TypeError` for a value that is not a number, such as a string
    read from the environment. `scanChunkBytes: Infinity` throws too. With NaN, `maxConcurrentScans`
    made every search of a document read by range wait forever, `ttlMs` failed every upload with
    "Invalid time value", and `maxUploadBytes` took off the upload limit.
    **What to do:** nothing, unless you pass such values. Leave an option out for its default, or
    read a variable with a fallback: `Number(process.env.SCANS ?? 4)`.
  - **NaN in `AskOptions.limits` throws, before any request.** A field of `limits` that is NaN throws
    a `RangeError` ("limits.toolTurns must be a number, and is NaN. Leave it out for the default."),
    and one that is not a number a `TypeError`. NaN used to give a question with no tool, refuse
    every call, or take off the cap on whole-file reads and the ceilings on tokens and requests.
    `ToolOptions.maxWholeDocumentReads` is checked the same way. `Infinity` still means no ceiling.
    **What to do:** as above.
  - **`partialResultOf(error)` gives `undefined` for an error that several questions threw.** Questions
    stopped by one shared signal all throw its one reason (`AbortSignal.any` passes it on as it is).
    `partialResultOf` gave each the result of whichever failed last: another user's tool rounds and
    usage. Now it gives none, and each question's `run.error` event still carries its own `partial`.
    **What to do:** if you stop many questions with one signal and keep their partial results, give
    each question an `AbortController` of its own that the shared signal aborts with a new reason.
    See [`partialResultOf`](docs/reference/ask.md#partialresultoferror).
  - **`vertexAi()` and `vertexHost()` check `location`.** One that is not lowercase letters and digits
    joined by single hyphens (`"global"`, `"us"`, `"europe-west4"`) throws a `TypeError`. With `/`,
    `?`, `#` or `@`, it named another host, which got the access token.
    **What to do:** nothing, unless a location comes from a user; then expect the `TypeError`.
  - **An upload answered before its body was read drains the rest, up to 8 MB.** The `413` of an
    upload over `maxUploadBytes` (and every answer sent before the body was read to its end) is
    written at once, and ends once the rest of the body has been read and dropped. A body that goes
    on more than 8 MB past the limit is cut off by closing the connection.
    **What to do:** nothing. See [`node`](docs/reference/node.md).
  - **An adapter of your own whose `capabilities` lack `pageTokens` or `toolFiles`.** A `pageTokens`
    that is missing, NaN or negative counts as 1,000, and a `toolFiles` that is none of `"inside"`,
    `"beside"` and `"none"` counts as `"none"`, so `view_pages` is not offered to that model. Both
    fields are required by the type, so this concerns only an adapter written in JavaScript or cast.
    **What to do:** declare both.

### New: what you can add

- **`createIsolatedExtractors(options?)`** in `llm-large-files/node`: PDF, DOCX, PPTX and XLSX files
  read in child processes, each with a heap flag (`maxHeapMb`, 512), a kill timer (120 s), at most
  `concurrency` (2) at once and `maxQueue` (8) waiting. A file that exhausts its child's memory is
  refused (`"out_of_memory"`) and the server goes on; a full queue refuses at once (`"busy"`), and
  the upload handler answers that with 503 and `Retry-After`. Children are replaced after 50 files
  and stopped when idle. A reader that cannot start (a missing `childScript`, an `execArgv` Node
  does not know) is the server's trouble: an `Error` with `status` 500, not an `IngestError`; one
  that cannot be started for want of process slots is `"busy"`. For a server that bundles its code,
  `llm-large-files/node/ingest-child.js` is exported, and `childScript` takes a path or a file
  URL. See [isolated ingest](docs/reference/node.md#createisolatedextractorsoptions).

  ```ts
  import { createLargeFiles, FileDocumentStore } from "llm-large-files";
  import { createIsolatedExtractors } from "llm-large-files/node";

  const isolated = createIsolatedExtractors({ maxHeapMb: 512, concurrency: 2 });
  const files = createLargeFiles({ store: new FileDocumentStore("./data"), extractors: isolated.extractors });
  // A SIGTERM listener replaces Node's own exit: stop your HTTP server there too, or it goes on serving.
  process.once("SIGTERM", () => {
    server.close();
    void isolated.close();
  });
  ```

- **`IngestError`**, with `code`, `status` and, for `"busy"`, `retryAfterMs`; and
  `ingestErrorCodeOf(message)`. The codes: `empty`, `too_large`, `too_much_text`,
  `too_many_pages`, `not_text`, `compressed`, `legacy_office`, `encrypted`, `no_text`, `hostile`,
  `timeout`, `out_of_memory`, `busy`, `missing_dependency`, `unreadable`. See
  [`IngestError`](docs/reference/library.md#ingesterror).

  ```ts
  import { IngestError, type IngestErrorCode } from "llm-large-files";

  // Your own words for some refusals; the library's message for the rest.
  const hebrew: Partial<Record<IngestErrorCode, string>> = {
    too_large: "הקובץ גדול מדי.",
    no_text: "אין בקובץ טקסט לקריאה (ייתכן שהוא סרוק).",
    busy: "השרת עסוק. נסו שוב בעוד רגע.",
  };

  try {
    await files.ingest({ name, bytes, owner });
  } catch (error) {
    if (!(error instanceof IngestError)) throw error; // the store, or your own code
    console.log(error.status, hebrew[error.code] ?? error.message);
  }
  ```

- **`search_document` arguments** (see [`search_document`](docs/reference/tools.md#search_document)):
  - `from_line` and `to_line`: search part of a file, in every mode; the result says
    `searched_lines`.
  - `next_from_line` in a result of exact or regex search that shows the first matches of more:
    search again from it for the ones after.
  - `order: "last"`: the last `max_results` matching lines, in file order.
  - `group_by`: count the matching lines by group and show none: `"capture"` (the regex's first
    group), `"minute"`, `"hour"`, `"day"` (the timestamp of the line: ISO, nginx, Apache, syslog,
    klog, epoch times of JSON logs) or `"shape"` (the line with its numbers and IDs taken out). The
    result has `groups` of `{ key, count, first_line, last_line }`, `total_groups`, and the lines
    of further groups or with no key apart. Up to 200 groups are shown (`max_results`, default 50).
  - `whole_word`: exact text only as a whole word, letters of every script counted.
- **`EventError.code`**: the `IngestError` code in `ingest.error` events and in the
  `ingest.error` of an upload with `Accept: text/event-stream`.

### Changed: what works differently

Search:

- **Every script.** Keyword terms keep a mark with its letter (Hindi, Bengali, Tamil, Thai and
  pointed Hebrew lost their words), split Chinese, Japanese and Thai into words, and drop the
  points of a Hebrew query word, which then finds the word with or without points in the text
  (בראשית finds בְּרֵאשִׁית). A Hebrew word with prefix letters (בחוזה, והחוזה) also searches its
  stem (חוזה), and one that ends in a final letter its plain form too (כסף finds כספים); an acronym
  keeps its gershayim or geresh (ש״ח, עו״ד are one term each).
- **One way to write a character.** Queries are composed as the text is; a search that ignores
  case also folds Greek final sigma, curly quotes and primes, dashes and the minus sign, no-break
  and thin spaces, Hebrew geresh, gershayim and maqaf, and full-width forms: "don't" finds
  "don’t", צה"ל finds צה״ל.
- **Regex `\w`, `\W`, `\b` and `\B` know the letters of every script**: `\bחוזה\b` matched
  nothing, and `\w+` stopped at "é". Emoji variation selectors and enclosing marks are not word
  characters, for them and for `whole_word`. A repeated group whose repeats a literal character separates,
  as in `(\d{1,3}\.){3}\d{1,3}` or `(\w+\.)+com`, is no longer refused as a nested quantifier.
- **Exact search counts every line where a text across lines starts** ("a\na" in "a\na\na" was
  counted once), and skips the rest of a line once it is counted: a short common text costs what
  its lines do, not its occurrences. It runs in slices with pauses, as a regex search does, and
  its count stays whole; with `whole_word` or `group_by`, whose work grows with each occurrence,
  it stops after 3 seconds (the result then says the counts are lower bounds). A document held in
  memory is scanned in pieces too.
- **`case_sensitive` and `whole_word` given as text or as 1** ("true", "1", 1) are read as true; in
  0.7.0, `case_sensitive: "true"` searched ignoring case. A search of this kind stored by 0.7.0 is
  run again, not answered from what was stored.
- **A cut list of matches says how to see the rest**: "search again with from_line 1941, or count
  them with group_by", where it said "narrow the search".
- **Models count by group.** Live, asked for PAY-5031 errors per hour and the last one, both models
  made one search with `group_by: "hour"` and gave every hourly count and the last line right.

Documents:

- **Word:** headings from paragraph styles (also in documents written in Hebrew, whose styles keep
  English names), list numbers in Word's formats (decimal, letters, roman numerals, Hebrew letters
  and numerals, bullets as "-", restarted lists), tables with empty and merged cells kept in their
  columns (text another program left in a continued merged cell is kept), lists defined through a
  list style, legal numbering (`w:isLgl`: "Section 1.01"), non-breaking hyphens ("555-0199" read
  "5550199") and symbol characters.
- **PowerPoint:** slides in the order of `presentation.xml`, numbered by position ("Slide 5" for the
  third slide is gone); tables; speaker notes after `[Speaker notes]`, the notes' own text only (not
  the slide number, date and footer of the notes page).
- **Excel:** each sheet a section, `## Sheet 1: Sales`, then `Columns: | A | B | C |` and a line a
  row, `Row 12: | East | 2026-03-01 | 1200.5 |`, with shared and inline strings, the values Excel
  last computed for formulas, dates and times from number formats (1900 and 1904 systems),
  percentages, durations of a day or more (`[h]:mm`: 36:00), Excel's `_x000D_` escapes, and hidden
  sheets marked. Every row of every sheet is read, within the text limit.
- **HTML:** scripts and styles dropped, headings, lists, tables (`colspan` and `rowspan` keep the
  cells in their columns), `text (https://…)` for links, alt text for images, entities decoded
  ("AT&T" is found), text a page hides (`hidden`, an inline `display: none`) marked as Word's hidden
  text is, older encodings read as text files are.
- **Logs:** the profile reads more timestamps (nginx's error log, access logs, syslog) and levels
  (see **Upgrading**).
- **Outlines** take no heading from a fenced code block, nor from the `#` comments of a text file
  that reads as code (a script, a configuration file).
- **Refusals in words for the person:** an Office file of before 2007, an Outlook message or an
  Office file with a password ("This is a Word, Excel or PowerPoint file of before 2007…"), where
  it said "looks binary"; and a PDF with a password, where pdf.js said "No password given".

### Fixed

Search and documents:

- **Keyword queries in scripts with marks found nothing** (LLF-014): see **Changed**.
- **A common query word no longer skews keyword ranking toward the start of a file** (LLF-015). A
  term counted only up to 200,000 hits gave passages before the cap a score passages after it
  could not get; such a term is now not scored.
- **Overlapping texts across lines are all counted** (LLF-042), and repeated occurrences on a
  counted line cost nothing (LLF-044, exact search).
- **Common safe regexes are accepted** (LLF-043): IPv4 addresses, domains, dashed numbers.
- **Case-insensitive search finds what case-sensitive search finds** (LLF-045): an upper-case
  word that ends in Σ, and composed against decomposed text.
- **`#` comments in code blocks and scripts are no longer headings** (LLF-016).
- **Logs with lower-case levels get a profile** (LLF-017).
- **Slides are numbered in the order of the show** (LLF-023), **non-breaking hyphens and symbols of
  Word are kept** (LLF-024).
- **Page text can no longer forge a page line** (LLF-025): a line of a PDF page that reads
  "--- Page 3 ---", or one of the extractor's notes, is moved by a space, so search, page numbers
  and `view_pages` are not sent to the wrong page.
- **A saved line index whose text size is not the document's is not used** (LLF-047): the last line
  read cut short, without an error.
- **An optional dependency that fails to load is not reported as missing** (LLF-054): the message
  says it is installed but could not be loaded, with the reason, and keeps the failure as `cause`.
- **A long run of spaces is counted in the token estimate** (LLF-046): about a token for each 16
  spaces after the first. 10,000 spaces were estimated at 0 tokens, so a padded or fixed-width
  report could be planned inline and refused by the provider. Indentation is priced as before.
- Unused code in `search.ts` is gone (LLF-060).

From 0.7.1:

Models:

- **A Claude stream no longer loses its input counts** (LLF-006). The input fields of the usage in
  `message_delta` may be null, and replaced the numbers of `message_start`: `inputTokens` and
  `cachedInputTokens` read 0, which also took `limits.inputTokens` and the room estimate off. Only
  the numbers of `message_delta` are taken now.
- **An OpenAI-compatible reply of 200 that holds an error throws it** (LLF-009). A body
  `{ "error": { "code": 502, … } }` with no `choices` (OpenRouter, once generation has started)
  was a reply with no text, and the question could end with no answer and no error. It is now an
  `OpenAiRequestError` with the status the error names, sent again like any 502, in a chat request
  and in a part read, as the same error in a stream already was.
- **Gemini gets no empty text parts** (LLF-028). A stored answer that came back empty became
  `{ "text": "" }`, which Vertex AI refuses with HTTP 400, so every later question of that
  conversation failed. Empty text parts are left out, and a turn left with none.
- **A whole-file part that Gemini blocks says why, and is not sent again** (LLF-030). A prompt
  blocked with `promptFeedback.blockReason` failed with "The model returned no text." and was sent
  once more; now "The model returned no text (PROHIBITED_CONTENT).", once.
- **An adapter class whose `generateText` is a method can read whole files** (LLF-051). It was
  called without its adapter, so a method that used `this` failed on every part.

The loop:

- **What a refusal showed lasts for the rest of the question** (LLF-040). After a request refused
  as too large, the loop raises its estimate up to 8 times what it counted; the next good reply
  brought it back to twice, the next turns filled the window again, and a question whose provider
  counts more than twice the estimate could fail after two such refusals. The estimate no longer
  falls below what the refusal showed, as [how it works](docs/how-it-works.md#a-request-too-large-for-the-model)
  says.
- **`limits` and the number options of `createLargeFiles` are checked** (LLF-007, LLF-008), and a
  queue of scans always has at least one slot, whatever it is given: see **Upgrading**.
- **A missing `pageTokens` no longer takes away the page limit and the room count** (LLF-041).
- **Questions stopped by one signal no longer get each other's partial result** (LLF-010).
- **`UsageMeter` keeps any adapter id as an entry of its own** (LLF-050). An id of `"__proto__"`
  counted the usage into `Object.prototype`, which set `requests` and the token counts of every
  object in the process to NaN; `"constructor"` and `"toString"` lost their usage.

Documents and uploads:

- **A document read by range whose line starts with U+FEFF can be searched** (LLF-013). Each range
  was decoded as a stream of its own, which dropped a U+FEFF at its start: when such a line began a
  piece, every search of the document failed ("did not match its index") and rebuilt the index in
  vain. Ingest has dropped such characters since 0.6.0, so this concerned documents stored by
  0.5.0. The store example in the [storage guide](docs/guides/storage.md) decodes the same way.
- **An upload over the limit no longer holds its connection** (LLF-033). The handler stopped
  reading at the limit and answered `413`, but the connection stayed open, with a client still
  sending into it. The comment said the rest was drained, and now it is, up to 8 MB: the client
  reads the `413` and can send its next request on the same connection. Past 8 MB the connection
  is closed. Closing it at once was tried, and lost the answer on Windows, which resets a
  connection closed while data still arrives.
- **`vertexAi()` checks its location** (LLF-029): see **Upgrading**.
- **The JSDoc of `ToolCallLimits.maxFileBytes`** gives its default as 3/8 of
  (`maxRequestBytes` − 262,144), 3,651,696 bytes for the default budget, which the code uses
  (LLF-062). It read as 3/8 of `maxRequestBytes`, less 262,144.

Tests: vitest 4.1.12 in place of 3.2.7, whose advisories are fixed (LLF-019); `npm audit` is
clean. The tests run only from `test/`.

## 0.7.0 — 2026-11-22

A question and an ingest now say what they do as typed events, in order: the plan, each model
request with its retries and usage, each tool call with how it ended, the answer's text, and the
result or the error at the end. `askStream` gives a question's events as an async iterable,
`writeSseEvents` sends them to a browser as Server-Sent Events, and an upload can answer with its
progress. The callbacks of 0.6.0 (`onText`, `onActivity`, `onStep`) get the same strings at the
same moments, and events carry no tool results, which hold document text, unless you ask
for them. A live check with the
Gemini API passed: the events of a search, of a question with an explorer and of a whole-file read
were counted and paired, and a question was sent end to end over SSE. See
[Events](docs/reference/events.md).

### Upgrading: what you need to change

Code written for 0.6.0 compiles with 0.7.0 as it is. Every change to the public types is an
addition: new optional options and fields, an optional fourth parameter of
`ToolSet.executeWithFiles`, and new exports. `llm-large-files` adds `askStream`, `eventStream`,
`newRunId` and the types `AskEvent`, `IngestEvent`, `LibraryEvent`, `EventBase`, `EventError`,
`EventResult`, `EventStream`, `DocumentRef`, `IngestStage`, `NoticeCode`, `NoticeDisplay`,
`RequestRole`, `RequestPurpose`, `ToolOutcome`, `ExtractProgress`, `ToolCallHooks`,
`ToolRequestHandle`, `ToolRequestStart` and `ToolRequestEnd`; `llm-large-files/node` adds
`writeSseEvents`, `sseMessageOf` and the types `SseMessage` and `SseWriteOptions`;
`llm-large-files/gemini` adds the type `AskEvent`.

Some behavior is different. Check each point against your app:

- **Each entry of `AskResult.evidence` now has `callId`.** `askWithFiles` and `askGemini` set it
  to the id of the tool call it came from (`"call_1"`, `"call_2"`…), the id its events use. Code
  or a test that compares `result.evidence` with objects that have no `callId`, by deep equality
  (`toEqual`, `assert.deepStrictEqual`), now fails.
  **What to do:** add `callId` to the objects you compare with, or compare with `toMatchObject`.
  `evidenceOf()` in a loop of your own does not set it.
- **A throw from `onActivity` during a whole-file read now ends the question.** In 0.6.0, a throw
  of `onActivity` on the progress of `analyze_whole_document` ("Reading app.log: part 3 of 12…")
  became the tool's error: the model was sent your error's message, and the question went on. Now
  the read and the other calls of its turn stop, and `askWithFiles` throws that error. A throw of
  `onEvent` there does the same.
  **What to do:** nothing, unless your `onActivity` can throw, such as one that writes to a
  connection that may have closed. Catch its errors inside it.
- **`ToolSet.executeWithFiles` takes an optional fourth argument, `hooks`** (`ToolCallHooks`). It
  matters only for a `ToolSet` of your own, such as a wrapper around `files.tools()` in a
  `LargeFiles` of your own. A wrapper that drops the argument still works, but `askWithFiles`
  then gets no `tool.progress` events and no events for the requests of a whole-file read.
  **What to do:** in such a wrapper, pass `hooks` on.
- **`ExtractInput` has an optional `onProgress`.** An extractor of your own works as before, and
  its file reports no `extract` progress. An extractor that wraps a built-in one with an
  `ExtractInput` of its own should pass `onProgress` on.
  **What to do:** nothing; call it to report progress (see **New**).

### New: what you can add

The samples assume what your app already has: `files` from `createLargeFiles()`, `model` from an
adapter, and the `documentIds` and `question` of the chat.

- **The events of a question: `AskOptions.onEvent`.** Every event of the question, in order:
  `run.start`, `plan`, `request.start`, `retry`, `text`, `request.end`, `tool.start`,
  `tool.progress`, `tool.end`, `notice`, and last `run.finish` or `run.error`. Each has `seq`
  (1, 2, 3… without gaps), `runId` and `time`. Requests and tool calls come in pairs with ids
  (`req_1`, `call_1`), and tool ends come in call order. Notices say what the callbacks said, and
  three things they never did (`budget_reached`, `no_room`, `blocked`). Errors in events are told
  in words for users: a model error by its kind and status, never in the provider's words, which
  stay on the error that is thrown. See [`AskEvent`](docs/reference/events.md#askevent) and
  [The order of the events](docs/reference/events.md#the-order-of-the-events).
- **`askStream(options)`**: `askWithFiles` as an async iterable of its events, with `result` and
  `abort()`. Leaving the loop early stops the question; the loop never throws (read `run.error`,
  or await `result`). The answer is asked for as it is written unless `streamText: false`. See
  [`askStream`](docs/reference/events.md#askstreamoptions).

  ```ts
  import { askStream } from "llm-large-files";

  const stream = askStream({ files, model, documentIds, messages: [{ role: "user", text: question }] });
  for await (const event of stream) {
    if (event.type === "tool.start") console.log(`${event.label}…`);
    if (event.type === "text") process.stdout.write(event.delta);
    if (event.type === "run.error") console.log(`Failed: ${event.error.message}`);
  }
  const result = await stream.result.catch(() => undefined); // keep result.toolTurns with the chat
  ```

- **`eventStream(run, options?)`**: the same for any function that takes an `onEvent` and a
  `signal`, such as `askGemini` or `files.ingest`. See
  [`eventStream`](docs/reference/events.md#eventstreamrun-options).
- **`AskOptions.runId`**: the `runId` of the events, to tie them to a request of your app.
  Defaults to `"run_"` and 16 hex digits; `newRunId(prefix?)` makes one.
- **`AskOptions.eventResults`**: put each tool result in its `tool.end` event, and `toolTurns` and
  the full plan (each document's `DocumentMeta`) in the result of `run.finish` and `run.error`.
  Off by default, since they hold document text: without it, that plan names the documents only. See
  [Documents](docs/reference/events.md#documents-eventresults-and-eventresult).
- **`AskOptions.streamText`**: whether the model is asked for the answer as it is written. It
  defaults to `true` with `onText` and in `askStream`, and to `false` otherwise, as 0.6.0 did:
  `onEvent` alone never changes how the model is asked. See
  [`streamText`](docs/reference/events.md#streamtext).
- **The events of an ingest: `IngestInput.onEvent` and `IngestInput.runId`.** `ingest.start`,
  `ingest.progress` for each stage (`check`, `extract`, `pictures`, `decode`, `prepare`, `index`,
  `store`, in pages, parts, bytes or characters, at most one every 12 ms for a stage, and the last
  one), then `ingest.finish` with the `DocumentSummary`, or `ingest.error`. See
  [`IngestEvent`](docs/reference/events.md#ingestevent).
- **`ExtractInput.onProgress`**, for an extractor of your own to report its progress, as the
  built-in ones do for each page of a PDF and each part of a DOCX or PPTX. See
  [`ExtractInput.onProgress`](docs/reference/events.md#extractinputonprogress-for-an-extractor-of-your-own).
- **`ToolCallHooks`**, the optional fourth argument of `ToolSet.executeWithFiles`: the progress
  and the model requests of one call, for a loop of your own in which two whole-file reads run at
  once. See [`ToolCallHooks`](docs/reference/events.md#toolcallhooks).
- **`writeSseEvents(response, events, options?)` and `sseMessageOf(event)`**, in
  `llm-large-files/node`: events to a browser as Server-Sent Events, one message per event
  (`id` is `seq`, `event` is `type`, `data` the event itself), with the event-stream headers,
  keep-alive comments and back-pressure. It stops an `askStream` passed to it when the client goes
  away. `sseMessageOf`, its default, sends the result of `run.finish` without `toolTurns`, `plan`,
  `budget` and `lastUsage`. See
  [`writeSseEvents`](docs/reference/events.md#writesseeventsresponse-events-options).

  ```ts
  import { askStream } from "llm-large-files";
  import { writeSseEvents } from "llm-large-files/node";

  // In your route, with Node's response.
  const stream = askStream({ files, model, documentIds, messages: [{ role: "user", text: question }] });
  await writeSseEvents(response, stream);
  ```

- **Uploads with progress.** `createDocumentHandlers().upload` answers a request with
  `Accept: text/event-stream` with `200` and the ingest's events, ending with `ingest.finish`
  (its `document` is the summary a `201` holds) or `ingest.error` (its `error` is the message and
  status a JSON answer would have). A missing name, a refused owner and a file too large still get
  an HTTP error in JSON, and without the header nothing changes. See
  [Uploads with progress](docs/reference/events.md#uploads-with-progress).
- **`askGemini` takes `onEvent`, `runId`, `eventResults` and `streamText`**, and passes them to
  `askWithFiles`. See [`askGemini`](docs/reference/events.md#askgemini).

### Changed: what works differently

Besides the points under **Upgrading**:

- **`Evidence.callId`**: each entry of `AskResult.evidence`, and of `partialResultOf(error)`,
  names its tool call, as `tool.end` does.
- **A turn that fails stops its other tool calls.** When a turn ends with an error (the question
  was stopped, or a callback threw), the calls of that turn still waiting for their turn do not
  run, and those running are told to stop. In 0.6.0, after a callback threw, they went on
  running after the question had thrown.
- **`examples/server.ts`** asks with `askStream` and sends the events with `writeSseEvents`. The
  page shows the tool calls with how each ended, a counter for whole-file reads, the status line
  and the answer, and uploads with progress. The tool rounds of each chat stay on the server, so
  the page no longer sends them back, and the question's body has a size limit.

### Fixed

- **The status line of the example page shows.** The page of `examples/server.ts` wrote its
  status to `status`, which in a browser is `window.status`, not the element with that id: retries,
  "Writing the answer…", errors and the usage at the end never showed. The page now looks the
  element up by its id.

## 0.6.0 — 2026-11-22

Questions fail less often, and when one fails, you can tell why and keep what it found: every
model error has a kind, a request too large for the model is made smaller and sent again, a model
that goes silent is stopped after a wait, an empty or broken turn is asked for again, and a call
whose result is still in the conversation is answered with a pointer, not run again. Uploads
are guarded: an upload with an empty owner is refused, `files.tools()` checks the owner of each
document, many files built to exhaust the server are refused, and ingest lets other requests run
while it reads a file, within limits on its text, its pages and its time; one page of a PDF can
still hold the server, and a crafted PDF can still run it out of memory. A search shows the last
matching line, a text file in an older encoding, such as a Hebrew CSV from Excel, is read in that
encoding, and the rest are fixes in the tool loop, whole-file reads, the three adapters and the
text the model is sent. Some of these change what the library sends, throws or refuses: read
**Upgrading** before you update.

### Upgrading: what you need to change

Code written for 0.5.0 compiles with 0.6.0 as it is, but for two cases. The turns of
`geminiFunctionResponses` and `geminiFunctionResponseTurns` now have `GeminiPart[]` parts, where
they had `unknown[]` (see **Changed**). Code that adds to those `parts` a string, or a value typed
`unknown`, `object` or by an interface (another SDK's `Part`), no longer compiles: add an object
literal, or `{ ...part }`. And an object typed as `ModelRequestError` or one of its subclasses,
but made other than by its constructor, needs the new `kind`. Every other change to the public
types is an addition: new fields and new optional options (under **New**), wider parameter types
(`parseSseJson` takes hooks and Node streams), and new exports. `llm-large-files` adds
`partialResultOf`, `classifyModelError`, `errorKindOf`, the error class `SseEventTooLongError`, the
constants `DEFAULT_FIRST_BYTE_TIMEOUT_MS`, `DEFAULT_IDLE_TIMEOUT_MS`, `DEFAULT_MAX_TEXT_BYTES`,
`DEFAULT_MAX_PDF_PAGES` and `DEFAULT_INGEST_TIMEOUT_MS`, and the types `ModelErrorKind`,
`ModelErrorClass`, `IdleWaits`, `RetryNotice` and `SseHooks`; `llm-large-files/gemini` adds
`partialResultOf` and `SseEventTooLongError`. One member is marked deprecated:
`ModelAdapter.estimateTokens` (see "Your own adapter" below).

Some behavior is different. Check each point against your app.

Uploads and stored documents:

- **An upload whose owner is empty is refused.** An owner of `""` (what `user?.id ?? ""` gives a
  caller who is not signed in), of spaces only, or `null` was one owner shared by every such
  caller: each of them could read and delete the documents of the others whose IDs it had.
  `files.ingest` now throws a `TypeError`:
  `owner must be a string that is not empty or only spaces, such as the signed-in user's ID. To let anyone with the document's ID use it, leave owner out.`
  So does an owner from JavaScript that is neither a string nor a finite number (`req.user` in
  place of `req.user.id`, `true`, `NaN`, an array). `createDocumentHandlers` answers such an
  upload with a 500 before it reads the body, and logs nothing:
  `{ "error": "Upload failed (empty owner)." }` when `getOwner` returns `""`, spaces only or `null`
  (a user header that arrives empty gives `""`), and
  `{ "error": "Upload failed (owner is not a string)." }` for the others. 0.5.0 accepted all of
  these owners. Signed-in uploads and numeric owners are unchanged. Reads and deletes with
  `owner: ""` work as before, so the documents stored with that owner stay readable until they
  expire.
  **What to do:** in `getOwner`, return the user's ID, not the user object. Where every upload
  needs a signed-in user, throw an error with `status: 401` for a request without one
  ([Requiring a signed-in user in the handlers](docs/security.md#requiring-a-signed-in-user-in-the-handlers)).
  Only where anonymous uploads are meant, return `undefined` for such a caller
  (`user?.id || undefined`): anyone with the ID of such a document can then read and delete it, as
  the message says. See [Ownership](docs/security.md#ownership) and
  [`DocumentHandlerOptions`](docs/reference/node.md#documenthandleroptions).
- **Uploads past the new limits are refused.** `files.ingest` throws, and
  `createDocumentHandlers` answers 422 with the message:
  - a PDF of more than `maxPdfPages` pages (5,000 by default), before any page is read:
    `This PDF has 6,200 pages, more than the 5,000 read from one file. Split it, and attach the part you need.`
  - a file whose text takes more than `maxTextBytes` in UTF-8 (100 MB by default, or
    `maxUploadBytes` when you set that higher):
    `This PDF holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.`,
    or for a text file `notes.txt holds more than 100 MB of text, …` with the same end. A file's
    text can be larger than the file: the text of a DOCX is often 2 to 4 times its size, a UTF-16
    file of Chinese or Japanese text grows by half in UTF-8, and a small PDF can draw far more
    text than its size.
  - a DOCX or PPTX of more than 32 million characters of text (about 10,000 dense pages), whatever
    `maxTextBytes` allows:
    `This DOCX holds more than 32 million characters of text, more than is read from one file. Split it, and attach the part you need.`
  - a PDF that draws more than 100 times its size in text, past the first 16 MB:
    `This PDF draws more than 16 MB of text, over 100 times its size. A file that grows that much is not read: it may be built to exhaust the server.`
    Real PDFs hold less text than their size.
  - files built to exhaust the server, which no program writes: a PDF whose page tree lists one
    page more than once; a DOCX or PPTX with paragraphs nested more than 32 deep, more than
    1,000,000 paragraphs with text, more than 20,000 parts
    (`This DOCX has more than 20,000 parts, more than an Office document has. It may be built to exhaust the server, so it is not read.`),
    or a list of parts that would take JSZip far more memory or time than an Office document needs
    (the list is read before JSZip reads it, the way JSZip will, not from the count the file gives);
  - with `@cantoo/pdf-lib` installed, a PDF with a page whose content would take pdf.js far longer
    to read than its file explains (past about 1 to 1.5 s of pdf.js, or 32 times the size of the
    file when that is more), found before pdf.js reads any page
    ([Pages that would hold the server](docs/guides/pdfs.md#pages-that-would-hold-the-server)):
    `Page 1 of this PDF draws far more than its file holds, and reading it would hold the server for a long time. A file built that way is not read: it may be built to exhaust the server. Print it to a new PDF, and attach that.`
    Pages that each pass but add up to more than four times as much are refused with
    `This PDF draws far more than its file holds, …` with the same end. A page whose content is
    stored in a way that cannot be decoded before pdf.js reads it (a filter that only images use,
    such as JPEG) is refused with
    `Page 1 of this PDF stores its content in a way that cannot be checked before it is read, so it is not read. Print it to a new PDF, and attach that.`
    The pages of the documents tested ran up to 11% of that limit.

  **What to do:** nothing, unless your users upload PDFs of more than 5,000 pages, or files with
  more than 100 MB of text: then raise `maxPdfPages` or `maxTextBytes`. If real PDFs of your users
  are refused for a page that would hold the server, read them with
  `createPdfExtractor({ checkPages: false })`, in a process of its own. Every message is in
  [PDFs and other formats](docs/guides/pdfs.md#what-is-refused).
- **An ingest that takes more than 2 minutes throws.** `ingestTimeoutMs` (120,000 by default)
  bounds the extraction, the line index and the log profile, not the store's writes. Past it,
  `ingest` throws
  `report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.`,
  stores nothing, and `createDocumentHandlers` answers 422 with that message. An extractor of your
  own that calls a slow service, such as OCR of a long scan, can take longer than that.
  **What to do:** for such an extractor, raise `ingestTimeoutMs`, or set it to 0 for no limit, and
  pass `input.signal` on to the work it does (`fetch(url, { signal: input.signal })`): at the limit
  `ingest` stops waiting for the extractor, but only the extractor can stop its own work. If you
  ingest in a worker or a process with a timer of its own, set that timer above
  `ingestTimeoutMs`, so that the user gets the library's message.
- **With `@cantoo/pdf-lib` installed, every PDF is read with it before its text.** The PDF
  extractor reads the file into objects before pdf.js reads any page, for the page check and the
  picture marks together; 0.5.0 read it after the text, for the marks only. With picture marks on
  (the default), that costs nothing measurable: PDFs of 300 to 2,000 pages took the same time
  within the spread of three runs, and the longest stall did not grow. With `pictures: false`,
  0.5.0 did not read the file this way at all, and now does, for the page check: 0.1 to 0.3 s more
  for 300 to 2,000 pages, up to 90 MB more memory at the peak, and, for the first PDF of a process,
  about 0.4 s in one block to load `@cantoo/pdf-lib`, unless the server loads it when it starts
  ([Deployment](docs/guides/deployment.md#uploads-and-ingest)). See
  [Measurements](docs/measurements.md#the-server).
  **What to do:** nothing, unless you set `pictures: false` to keep ingest light, in a process with
  little memory to spare. Then give it that room, or pass
  `createPdfExtractor({ pictures: false, checkPages: false })` to read PDFs as 0.5.0 did, without
  the page check.
- **`files.tools()` answers a document whose owner does not match as no longer available.** Each
  tool call now compares the owner stored with the document with the `owner` of the `DocumentMeta`
  that `tools()` was handed. When they differ, the call answers the model
  `doc_… is no longer available on the server. Ask the user to attach the file again.`, and
  `view_pages` shows no page. A document stored without an owner is open to any metadata, as
  before. The metadata that `prepare(ids, base, { owner })` and `getMeta(id, { owner })` return
  carries the stored owner, so `askWithFiles`, `askGemini`, and a loop of your own written as the
  docs show, work as before.
  **What to do:** nothing, unless your loop builds `DocumentMeta` objects itself, from IDs or from
  your own database (a `DocumentSummary` has no owner). Take them from `prepare` or `getMeta` with
  the caller's owner. See [Security](docs/security.md#tool-scoping).
- **A text file that is not UTF-8 is read in the encoding it was saved in.** 0.5.0 decoded every
  text, log, CSV, JSON and Markdown file as UTF-8: a CSV that Excel saved in windows-1255 was
  stored as replacement characters (U+FFFD), and accepted without a word. `files.ingest` now reads
  a file in one of these encodings when the letters of its lines show which, and records it in
  `meta.encoding`: `windows-1255` (Hebrew; ISO-8859-8 too), `windows-1256` (Arabic),
  `windows-1251` (Cyrillic), `shift_jis` (Japanese in Shift_JIS, half-width katakana too) and
  `windows-1252` (Western European; ISO-8859-1 too). The encoding is chosen on the lines that are
  not UTF-8 and hold letters, wherever they are in the file, up to 64 KB of them. A line that is
  valid UTF-8 is read as UTF-8 all the same. A byte that the encoding does not have is stored as
  U+FFFD, and counted in `meta.replacedCharacters`.

  No text file is refused for its encoding. Valid UTF-8 and UTF-16 files are decoded as before. A
  file is read as UTF-8, as 0.5.0 read it, with its characters that are not valid counted in
  `meta.replacedCharacters`, when its encoding is not recognized, when at least as many of its
  lines count as UTF-8 as count as not, or when at most one line in 200 is not UTF-8 (a log cut at
  a byte count, a log with stray bytes): those lines become U+FFFD even when they are in an older
  encoding. As a rule, these are not recognized: Greek, Turkish, Central European (windows-1250),
  Icelandic, KOI8-R, the DOS code pages (437, 850, 866), Chinese, Korean and Thai, and Japanese
  with few or no kana. Some files are read in a wrong encoding, which `meta.encoding` names:
  Hungarian in windows-1250 or ISO-8859-2 as windows-1252, with õ and û in place of ő and ű (a
  search for a word with ő or ű finds nothing); ISO-8859-15 without œ as windows-1252, with ¤ in
  place of € (with œ in its words, it is most often read as UTF-8 with U+FFFD); and a short file,
  or one long line, whose few stray bytes happen to fit another encoding
  ("Straße" saved in DOS code page 850 as windows-1252 "Straáe"). An editor that opens such a file
  as UTF-8 shows the lines read in an older encoding as �: a person who checks the file there does
  not see what the model reads.

  A `DocumentStore` of your own must keep the two new fields, as it keeps the rest of `meta`
  ([Writing a store of your own](docs/guides/storage.md#writing-a-store-of-your-own)). One that
  checks `meta` against a fixed list of fields (a MongoDB `$jsonSchema` with
  `additionalProperties: false`) refuses the ingest of every text file that is not valid UTF-8,
  and `createDocumentHandlers` then answers 500 `{ "error": "Upload failed." }`. One that drops
  them (fixed columns of a table, a Mongoose schema in strict mode) keeps the text, read right, but
  the model is not told how it was read. The upload answer (`DocumentSummary`) holds both
  fields when they are set.
  **What to do:** nothing, if your store keeps `meta` whole and your client accepts fields it
  does not know. Show `meta.encoding` to the user ("read as windows-1255"), and when letters look
  wrong, ask for the file in UTF-8 (in Excel, "CSV UTF-8 (Comma delimited)"). Documents stored
  before the upgrade from files in these encodings still hold U+FFFD: ingest them again. See
  [Text encodings](docs/guides/pdfs.md#text-encodings), how the encoding is chosen in
  [How it works](docs/how-it-works.md#text-encodings),
  [Text files that were not UTF-8](docs/security.md#text-files-that-were-not-utf-8) and
  [`DocumentMeta`](docs/reference/library.md#documentmeta).
- **Some files are stored with other text than 0.5.0 stored.** Besides a text file that is not
  valid UTF-8 (above), ingest now removes characters that show nothing, such as tag characters,
  zero-width spaces and control characters U+0080-U+009F, and the terminal escape sequences that
  start with U+009B; makes U+0085 a line break in a text that has no other; marks text that Word
  hides, line by line; and marks the heading of a slide that the slide show skips (see
  **Changed**). File names lose tag characters, zero-width spaces and the other characters that
  show nothing too. Their control characters, line and paragraph separators and text-direction
  controls, the marks of right-to-left text included, became a space in 0.5.0 already, and still
  do: an escape sequence loses only its ESC (`re\x1b[31mport.txt` is stored as `re [31mport.txt`).
  Lines move in three cases: in a DOCX with hidden text, in a text whose records end with U+0085,
  and after a line of more than 2,000 characters that lost such characters, which can now be cut
  into fewer lines. A file with none of these gets the same text and line index as 0.5.0 gave it,
  and the same outline, but in a document of more than 400 headings with 20 to 399 at the top
  level (see **Fixed**, Ingest). Documents stored before the upgrade keep their text and outline
  until they expire.
  **What to do:** nothing. To have a document stored before the upgrade read the new way, ingest
  its file again.
- **An `unpdf` that cannot read PDFs on your version of Node is refused, with what to install,
  and unpdf 2 is accepted.** With 0.5.0, on Node 20.19 and 22.12, unpdf 1.5.0 to 1.6.0 stopped the
  whole process at the first PDF (`TypeError: Promise.try is not a function`, thrown where nothing
  could catch it). On Node 20, unpdf 1.9 and later failed every PDF with
  `Serverless PDF.js bundle could not be resolved: ReferenceError: Iterator is not defined`. Now
  `files.ingest` throws, and `createDocumentHandlers` answers 422, with a message that names the
  major version of Node and says what to install:
  - unpdf 1.5.0 to 1.6.0 on Node 22:
    `The unpdf installed would stop the whole server at the first PDF file on Node 22, so PDF files are not read. Install unpdf 1.6.1 or later, or run Node 24 or later.`
    On Node 20 the message ends `Install unpdf 1.7.0 (npm install unpdf@1.7.0), or run Node 24 or later.`
  - unpdf 1.9 and later, 2.x included, on Node 20:
    `The unpdf installed cannot read PDF files on Node 20 (Serverless PDF.js bundle could not be resolved: ReferenceError: Iterator is not defined). Install unpdf 1.7.0 (npm install unpdf@1.7.0), or run Node 22 or later.`
    The part in parentheses is unpdf's own message.

  The optional peer range of `unpdf` is now `^1.4.0 || ^2.0.0`; it was `^1.4.0`. An app that
  upgrades keeps the unpdf its lock file has. On Node 24 and later, a new `npm install unpdf` next
  to 0.6.0 installs unpdf 2 and saves `^2` in `package.json`, where it got 1.9.1 next to 0.5.0. On
  Node 20 and 22, npm 11 (the version checked) picks a 1.x whose engines fit: 1.7.0 and 1.9.1.
  **What to do:** nothing, if your PDFs are read today. Otherwise install the unpdf that runs on
  your Node: on Node 20, 1.4.0 or 1.6.1 to 1.8.1 (1.7.0 is the last that does not ask for
  Node 22); on Node 22, 1.4.0, or 1.6.1 or a later 1.x; on Node 24 and later, any version from
  1.4.0, 2.x included. To go back to 0.5.0 after moving to unpdf 2, install both in one command:
  `npm install llm-large-files@0.5.0 unpdf@^1`. `npm install llm-large-files@0.5.0` alone stops
  with `ERESOLVE` and changes nothing. Restoring `package.json` and `package-lock.json` together
  works too. See [PDFs and other formats](docs/guides/pdfs.md#formats).
- **One page of a PDF still holds the server while it is read, and a crafted PDF can still run it
  out of memory.** 0.5.0 did the same. Between two pages, the PDF extractor lets other requests run
  and looks at the time limit and the signal; within a page it cannot, and neither
  `ingestTimeoutMs` nor `IngestInput.signal` cuts a page short. The page check (above) refuses the
  pages that would take far longer than their file explains. What it leaves:
  - a page that passes holds the server for up to about 1.5 s in a small file, and longer in a
    large one: a page of a 10 MB file may run 320 MB of content, about a minute of pdf.js;
  - without `@cantoo/pdf-lib`, on a file it cannot read or that declares more than 150,000
    objects, and with `checkPages: false`, no page is checked: a 3 KB page of forms inside forms
    held the event loop for 13 s, and one of 4 KB for about 100 s. A file built to be read one way
    by `@cantoo/pdf-lib` and another way by pdf.js passes the check too;
  - `@cantoo/pdf-lib` reads each object in one step, at ingest and on each look of `view_pages`:
    about 0.1 to 0.35 s for each MB of one object (a crafted PDF of 16 MB with one array of numbers
    held the server 1.6 to 3.2 s at ingest, and 1.7 to 3.5 s on each look), and 0.7 s for each
    million objects that a cross-reference stream declares;
  - a DOCX or PPTX packed hundreds of times tighter than documents are holds it for about 0.2 s at
    a time while JSZip unpacks a piece.

  Nothing checks the memory an object of a PDF takes before pdf.js or `@cantoo/pdf-lib` builds it,
  and a stream unpacked twice packs objects thousands of times. Measured on Node 24: a PDF of 732
  bytes whose object stream holds 4 MB of empty dictionaries ran a heap of 512 MB out of memory at
  ingest; one array of one-digit numbers in a PDF of 16 MB ran a heap of 256 MB out of memory at
  ingest, and one of 512 MB on a look at its pages; a PDF of 1.6 KB whose object stream unpacks to
  512 MB was read with 20 MB of heap, but the process took 1.6 GB, outside the heap, where
  `--max-old-space-size` does not limit it; and `@cantoo/pdf-lib` keeps every name and reference it
  reads for the life of the process, so that files of 9 KB that each declared a million new objects
  ran a heap of 512 MB out of memory at the fourth ingest. A check of each object before it is
  built is not in 0.6.0: it would be easy to get around. See
  [Objects of a PDF](docs/security.md#uploads) and the [measurements](docs/measurements.md#the-server).
  **What to do:** if your users can upload files you do not trust, ingest them in a child process
  of their own, with its own `--max-old-space-size` and a memory limit of its own, such as a
  container of its own, as [Deployment](docs/guides/deployment.md#uploads-and-ingest) shows: such
  a file then holds or stops that process, not your server, and its time limit stops it. Not in a
  worker thread, as the security page of 0.5.0 suggested: a `--max-old-space-size` of the process,
  on the command line or in `NODE_OPTIONS`, replaces the `resourceLimits.maxOldGenerationSizeMb`
  of every worker (with `--max-old-space-size=1024`, a worker given 512 MB had 1,216 MB on
  Node 24), and a worker that runs out of memory can stop the whole process. If you ingest in a
  worker, move to the child process of `ingestInProcess` in that guide. Do not offer `view_pages`
  on their documents (`viewPages: false`), or keep no PDF originals: a look parses the file again
  on the server that answers the question, can need more memory than the ingest did, and what
  `@cantoo/pdf-lib` keeps there comes back only when that server restarts
  ([Memory on each server](docs/guides/deployment.md#memory-on-each-server)).
- **An upload whose store fails while it writes is answered 500, not 422.** When `put`,
  `putOriginal` or `putIndex` throws an error that has no `status` or `statusCode` from 400 to 599
  and is not a Node system error, `createDocumentHandlers` answers 500
  `{ "error": "Upload failed." }`. 0.5.0 answered 422 with the error's own message, which may name
  a database host. A thrown value that is not an `Error` also gets 500 "Upload failed.", where it
  was 422 with the value as text. Errors with a status, Node system errors (an `Error` or not) and
  files that cannot be read are answered as before.
  **What to do:** for a more specific answer, throw your store's write errors with a `status` and
  a message of your own (a 503 that says to try again), and log the cause in your store: the
  handlers log nothing. Two paths still answer a store's error 422 with its message: an `ingest` of
  your own that throws a new error in its place, as `ingestInProcess` in
  [Deployment](docs/guides/deployment.md#uploads-and-ingest) does, and a route of your own, as in
  [Web app](docs/guides/web-app.md#filesingest-and-its-errors). A status on the error avoids it.
  See the [node reference](docs/reference/node.md#uploadrequest-response).

Model errors and retries:

- **A model that sends nothing now fails, after a wait.** In 0.5.0 a chat request had no time
  limit: a provider that stopped answering held the question, and the user, until your own
  timeout. Now each adapter aborts a chat request that gets nothing for 600 s before the first
  piece of its reply, or for 300 s between two pieces, and sends it once more; `onActivity` then
  says "The model sent nothing for too long. Trying again…". If that try is silent too, the
  question throws a `ModelRequestError` with `kind: "timeout"` and `status: 0` ("Gemini sent
  nothing for 600 s."). A reply whose text was already streamed to the user is not sent again: it
  fails at once. Headers do not count as a piece, because a model that thinks sends nothing until
  it has thought; keep-alives count. A reply that keeps arriving has no limit. A reply that is not
  streamed comes whole at the end, so it must be written within `firstByteTimeoutMs`: Gemini and
  OpenAI-compatible requests without `onText` (an explorer's requests among them), Gemini
  requests to an endpoint without `streamUrl`, and every request of `openAiCompatible()` or
  `anthropic()` with `stream: false`. Part reads of a whole-file read are not watched this way:
  they keep their limit of 180 s.
  **What to do:** handle the `"timeout"` kind (see the sample under **New**). With the defaults,
  a model that never answers fails after about 20 minutes (two waits of 600 s). To give up
  sooner, or never, set `firstByteTimeoutMs` and `idleTimeoutMs` on `askGemini`, `gemini()`,
  `openAiCompatible()` or `anthropic()`; `0` waits without end, as 0.5.0 did. A proxy, load
  balancer or gateway that closes a silent connection sooner still closes it first: keep the
  timeouts on the way longer than these waits, or set the waits shorter. See
  [Waits on a silent model](docs/guides/errors-and-reliability.md#waits-on-a-silent-model) and
  [The order of the timeouts](docs/guides/deployment.md#the-order-of-the-timeouts).
- **A reply cut off on its way is sent again, and can fail a question after its text was shown.**
  A stream that closes without saying why it ended, and DeepSeek's `insufficient_system_resource`,
  are no longer taken for a whole reply (see **Fixed**), and a reply of HTTP 200 whose body is
  empty is no longer a `SyntaxError` (below). Such a reply is sent again when none of it was
  shown (see **Changed**, The adapters). When some of it was already streamed to the user, the
  question throws at once: a `ModelRequestError` with status 0 and kind `"unreachable"`
  ("Gemini's reply ended before it was complete."), or status 503 and kind `"server"` for
  DeepSeek. In 0.5.0 the cut text was returned as the answer.
  **What to do:** if you stream with `onText`, handle an error that comes after part of the
  answer was shown: mark that text as incomplete and offer to ask again. `partialResultOf(error)`
  has what the question found.
- **Quota errors are not sent again.** These now have `kind: "quota"`, and are thrown at once:
  OpenAI's `insufficient_quota`, inside a stream too (HTTP 429 there); a Gemini quota per day
  (HTTP 429 whose `details` name a quota per day, or, on Vertex AI, only its message); HTTP 402
  (DeepSeek's "Insufficient Balance", OpenRouter's "Insufficient credits"); Claude's "Your credit
  balance is too low" (HTTP 400); and Claude's spending limits ("You have reached your API usage
  limits"), which come as HTTP 429 with `enforced_spend_limit_reached`, or as HTTP 400. 0.5.0 sent
  the ones of HTTP 429 again three times (the default of `retry.retries`). A Gemini quota per
  minute is `"rate_limit"`, and is waited for as before.
  **What to do:** if you show "busy, try again" for every HTTP 429, show another message for
  `"quota"`, and tell whoever runs the service: trying again soon does not help.
- **A request larger than the tokens a minute allows is made smaller, not sent again as it was.**
  This covers OpenAI's "Request too large for gpt-4o … on tokens per min (TPM): Limit 30000,
  Requested 45237" (HTTP 429) and Groq's "… on tokens per minute (TPM): Limit 6000, Requested 6438"
  (HTTP 413 or 429), and the same per day: kind `"context_overflow"`, with `limitTokens` and
  `requestedTokens`. 0.5.0 sent the 429 again three times as it was, though only a smaller request
  can pass. Now the loop shortens older tool results, or plans the files again for that limit, as
  for a request too large for the model (see **Changed**), and a part read is read in halves. The
  steps say so: "The first request was larger than the 30,000 tokens a minute that the provider
  allows: the files were planned again to fit it", or "The request was larger than the provider
  allows in a minute: older tool results were shortened, and it was sent again". `withRetry` does
  not send an error of kind `"context_overflow"` again, whatever its status.
  **What to do:** nothing, unless an adapter of your own sets `kind: "context_overflow"` on an
  error that a wait would mend. See
  [A request too large for the model](docs/guides/errors-and-reliability.md#a-request-too-large-for-the-model).
- **A reply of HTTP 200 whose body is not JSON is a `ModelRequestError`, not a `SyntaxError`.** A
  page from a proxy or a gateway that answered in the model's place (a sign-in page) now throws a
  `GeminiRequestError`, `OpenAiRequestError` or `AnthropicRequestError`, with `kind: "invalid"`,
  the status of the response (200), and the `SyntaxError` as `cause`:
  `Gemini's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.`
  For an OpenAI-compatible endpoint the message starts "The model's reply …", and for Claude
  "Claude's reply …"; without a content type, the part in parentheses is left out. It is not sent
  again, by the loop or by a part read. 0.5.0 threw the `SyntaxError`, and a streamed Gemini
  request that got such a page returned an empty reply. A reply of HTTP 200 whose body is empty is
  a reply cut off on its way: kind `"unreachable"`, status 0,
  `Gemini could not be reached (the reply was empty).` ("The model could not be reached …" and
  "Claude could not be reached …" for the others), and it is sent again; 0.5.0 threw a
  `SyntaxError` and did not.
  **What to do:** if you test `error instanceof SyntaxError`, test
  `error.cause instanceof SyntaxError` instead (kind `"invalid"`, status 200). Kind `"invalid"`
  alone also covers every other request that the provider refused. See
  [The kind of a model error](docs/guides/errors-and-reliability.md#the-kind-of-a-model-error).
- **An error inside a stream has the status, and the kind, that its type names.** On an
  OpenAI-compatible endpoint, `context_length_exceeded` is HTTP 400, kind `"context_overflow"`
  (the request is made smaller), `insufficient_quota` HTTP 429, kind `"quota"`, and any other the
  server's failure, HTTP 500 unless it names another status, sent again when none of its text was
  shown. On Claude, `invalid_request_error` is 400, `authentication_error` 401 (kind `"auth"`),
  `billing_error` 402 (kind `"quota"`), `permission_error` 403, `not_found_error` 404 and
  `request_too_large` 413, and a type the adapter does not know is the server's failure, 500, sent
  again when none of the reply was shown. 0.5.0 gave all of these the stream's 200, and sent none
  of them again; only Claude's `overloaded_error`, `rate_limit_error`, `api_error` and
  `timeout_error` had a status of their own, as they still do. `OpenAiRequestError.code` holds the
  code.
  **What to do:** nothing, unless you show your own words by status.
- **A whole-file read tells the model why a model request failed by its kind, its HTTP status or
  a connection code, never by the error's words.** Its result, its line in `onStep` and `steps`,
  and `toolTurns` now say, for example, "Could not read any part of app.log: The model refused the
  key or token it was sent (HTTP 401)." In 0.5.0 they carried the provider's message, which can
  name a project, a host, a masked key, or a URL with a key in it. The same holds for a part that
  could not be read among others, for a last step that failed (`notes_only`), and for every error
  a `generate` throws, yours included. An error is told by its `kind` ("The model's quota has run
  out", "The model was busy", with " (HTTP 429)" when it has a status), or by the kind that its
  HTTP status (`status`, `statusCode` or `response.status`) and message give, as
  `classifyModelError` works it out. A connection code such as `ECONNREFUSED` gives "The model
  could not be reached.", a timeout (an error named `TimeoutError`, or undici's
  `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT`) "The model took too long to answer.", and
  any other error, such as a plain `Error`, "The model request failed.". A part reader of the
  package's that got a reply with no text is still told "The model returned no text (SAFETY).",
  without the provider's reason when it is not a plain word, and an error of the document store
  keeps its own message.
  **What to do:** if you read the provider's words from the steps, log them in your own `fetch`,
  adapter or `generate` instead. To give the model a specific reason, throw an error with a `kind`
  or an HTTP `status`. See
  [Failures inside tools](docs/guides/errors-and-reliability.md#failures-inside-tools).
- **A retry option that is not a finite number takes its default.** `retries`, `baseDelayMs` and
  `maxDelayMs` (of the `retry` option and of `withRetry`) count as not set when they are `NaN`,
  `Infinity`, `-Infinity` or not a number at all, such as a string from an environment variable.
  They are then 3, 500 and 60,000. In 0.5.0, `retries: Infinity` sent a failing request again
  without end, `-Infinity` counted as 0, and a string counted as the number in it. For `NaN`, see
  **Fixed**.
  **What to do:** nothing, unless you set one of them to `Infinity`, `-Infinity` or a string. Pass
  a finite number: `retries: 0` to turn retries off, a larger `maxDelayMs` to take a long
  `Retry-After`, and `Number(process.env.RETRIES)` rather than the string. See
  [`RetryOptions`](docs/reference/errors-and-retries.md#retryoptions).
- **Gemini part reads send no temperature.** By default, the `generationConfig` of a part read in
  a whole-file read, and of `createGeminiGenerateText`, is `{ maxOutputTokens }`. It was
  `{ maxOutputTokens, temperature: 0.2 }`. Gemini 3.6 and later ignore the temperature, and Google
  says later models will refuse it.
  **What to do:** to keep it for an older model, pass
  `analysisConfig: (maxOutputTokens) => ({ maxOutputTokens, temperature: 0.2 })` to `gemini()` or
  `askGemini`, or a `generationConfig` that does the same to `createGeminiGenerateText`. See
  [Whole-file reads in parts](docs/guides/vertex-and-gemini.md#whole-file-reads-in-parts).

What the model is sent, and what the loop does:

- **The frame around a file sent whole carries a mark, before the file's name.** Its two lines
  were `--- Attached file: report.txt (text, 6 lines) ---` and
  `--- End attached file: report.txt ---`. For every file sent whole, they are now
  `--- Attached file [mark 1f0c3a9e]: "report.txt" (text, 6 lines; it ends only at the line with mark 1f0c3a9e) ---`
  and `--- End attached file [mark 1f0c3a9e] ---`. The mark is eight hex digits made from the
  document ID, which is made after the file's text was written, so a line of the file that copies
  the end of the frame has no mark or a wrong one. The mark is not a secret (someone who knows a
  document's ID can write its mark into a file uploaded later), and it does not make the model
  obey. The name comes after the mark, quoted as JSON. A file that is not valid UTF-8 adds how it
  was read after the count of lines (see **Changed**), and a file of one line says `1 line`. The
  whole first line is
  `--- Attached file [mark <8 hex digits>]: <name as JSON> (<format>, <lines> line|lines[, read as <encoding>[, <n> character|characters not valid in it, shown as �] | , <n> character|characters not valid UTF-8, shown as �]; it ends only at the line with mark <8 hex digits>) ---`,
  with commas in the count of lines (`3,000`). The text between the two lines is the same as
  before. The card of a file too large to send whole keeps its first line,
  `--- Large attached file: app.log ---`.
  **What to do:** if your code or tests look for these lines in `PreparedContext.blocks` or in the
  requests, match the new form. To match the start of any of them, use `--- Attached file [mark `.
  To find one file, look for `]: ` followed by its name as a JSON string (`JSON.stringify(name)`)
  and ` (`: a quote or a backslash in the name is escaped. A test that compares the prompts of two
  uploads must allow for the mark, as it allows for the document ID. See
  [`PreparedContext`](docs/reference/library.md#preparedcontext) and
  [The frame around a file](docs/security.md#the-frame-around-a-file).
- **The provider's prompt cache misses once after the upgrade, and then on each follow-up
  question from the rounds of the question before it.** The tool guide in the system instruction
  changed (see **Changed**), and so did the descriptions of `search_document` (next point) and
  `analyze_whole_document`, the frame of every file sent whole, and, for a question without
  `analyze_whole_document`, the cards.
  The first request of each conversation after the upgrade therefore shares little or nothing of
  its start with what 0.5.0 sent: its input costs what it costs without a cache (with Claude's
  `cache_control`, a cache write). The mark of a document is the same in every request, so from
  then on the cache reuses the files again. One miss stays: the tool rounds of an earlier
  question are now sent without `tool_turns_left` (see below), so the first request of a
  follow-up question differs from the requests of the question before it from that question's
  first tool round on. Those rounds are billed at the full price once, in that request (with
  Claude's `cache_control`, as a cache write); the cards, and the turns before those rounds, are
  still read from the cache. While servers of both versions answer the same conversation, each
  switch from one version to the other misses again.
  **What to do:** nothing. During a rolling upgrade, keep a conversation on one version if you can
  ([Servers of two versions](docs/guides/deployment.md#servers-of-two-versions)). See
  [Prompt caching](docs/guides/costs-and-limits.md#prompt-caching).
- **A search in exact or regex mode shows the last matching line too.** When more lines match
  than `max_results` (20 by default, 50 at most), `matches` holds the first `max_results` lines
  and then the last matching line of the file: up to `max_results` + 1 entries. `note` says how
  many are shown:
  `21 of the 442 matching lines are shown: the first 20 and the last (line 15269). To see the ones in between, narrow the search.`
  With `max_results` + 1 matches, every one is shown, and there is no note. A search with no more
  matches than `max_results` is unchanged, unless its result is cut to the room it has. A cut
  result, whatever its number of matches, drops matches from the end of the first ones, so that
  the last one stays, and its note reads
  `Showing 6 of the 442 matching lines to stay within the size limit: the first 5 and the last (line 15269). Narrow the query or read specific lines.`
  In 0.5.0 that note counted the lines the result held, not the lines that matched
  (`Showing 5 of 20 results to stay within the size limit. …`). A search that stopped early shows
  no last line, since it did not reach it. Its note is now
  `The scan stopped early; the total is a lower bound, and the last match in the file is not known.`,
  and when such a result is cut too, the note of the cut follows that sentence. The `evidence` of
  a search, and the stand-in that later replaces its result, list the lines of the last match too.
  The description of the tool, which the model reads, now says that exact mode "finds the lines
  that contain the text", and that "For exact and regex, total_matching_lines counts every
  matching line, and the result shows the first max_results of them and the last one". It said
  that exact mode "returns every line containing the text".
  **What to do:** nothing, unless your code expects at most `max_results` entries in `matches`, or
  your tests compare a search result whole. See
  [`search_document`](docs/reference/tools.md#search_document).
- **A repeated call is answered with a pointer.** A call whose result is still in the
  conversation in full is not run again: the same search, the same read, the same overview, or a
  read of lines inside a read that is shown, in this question or in the stored tool rounds of an
  earlier one. The model gets a pointer to that result. Its step reads
  "Search app.log (exact) for “timeout” — already shown above", its result in `toolTurns` has
  `already_shown: true` and a note, and it adds no entry to `evidence`. The same call made twice
  in one turn is run once. A call is run again when the earlier result failed, was cut to its
  room, was replaced by a stand-in, or came from a search that stopped early; when it is an exact
  or regex search stored before 0.6.0 with more matches than it shows (it lacks the last match); and
  when it is a read of one line from the rounds of an earlier question, since 0.5.0 cut a long line
  to the room it had without saying so (no `text_cut`). With an adapter whose provider may clear
  old tool results (`clearsToolResults`, under **New**), a call made again is run again.
  **What to do:** if you parse `steps` or the lines of `onStep`, or expect one `evidence` entry
  per call, allow for these. See
  [Repeated calls in a follow-up](docs/guides/conversations.md#repeated-calls-in-a-follow-up).
- **The tool rounds of an earlier question are sent without `tool_turns_left`.** That count was of
  the turns their own question had left, and a model could take a 0 there for its own. What
  `toolTurns` stores is unchanged. `geminiToolTurns`, `openAiToolTurns` and `anthropicToolTurns`
  leave the field out too, so a history kept in a provider's form gives the same request as one
  kept as `toolTurns`; contents converted before 0.6.0 keep it.
  **What to do:** nothing, unless your tests compare the output of a converter with the stored
  `toolTurns`: leave `tool_turns_left` out of the expected value. See
  [What `toolTurns` holds](docs/guides/conversations.md#what-toolturns-holds).
- **An empty or broken turn is asked for once more, at the cost of a request.** When the model's
  first reply is empty, or holds a tool call that could not be read (Gemini's
  `MALFORMED_FUNCTION_CALL` or `UNEXPECTED_TOOL_CALL`), it is asked once more with a short note;
  0.5.0 wrote the answer from the document cards alone, and it looked like any other. When the
  request for the answer (the last one of the tool loop, sent with `toolChoice: "none"`) comes back
  empty, or with a tool call the model was told not to make (`UNEXPECTED_TOOL_CALL`,
  `MALFORMED_FUNCTION_CALL`, or calls from an adapter of your own), it is sent once more, with a
  note at its end that is not kept:
  `Your last reply had no text. No tool can be called in this reply: write the answer now, in text, from what is above.`
  0.5.0 ended such a question with `answered: false` and no text; a model that still writes no
  text ends that way, one request later. A question makes at most two such second tries. Each is a
  chat request: it counts toward `limits.requests` and takes a turn of `limits.toolTurns`, and the
  one for the answer can be one request past `limits.toolTurns`. The answer is not asked for again
  after a refusal, a filter, a reply cut off at the output limit with nothing in it, or once
  `limits.requests` or `limits.inputTokens` is reached. With an explorer, the answering model gets
  the note too.
  **What to do:** if you set `limits.requests` or `limits.toolTurns` close to what a question
  needs, add two. If a test fake of yours answers with nothing, or answers the answer's request
  with a tool call, expect one more request and one more step: a fake with a fixed queue of
  replies runs out. See [Empty or broken turns](docs/guides/errors-and-reliability.md#empty-or-broken-turns)
  and [The limits of a question](docs/guides/costs-and-limits.md#the-limits-of-a-question).
- **Steps say more, on one line of plain text.** New steps say when a call was pointed to
  ("— already shown above"), when a turn was asked for again ("The model's first reply was empty:
  it was asked again", "The model's tool call could not be read: it was asked to send it again",
  "The model's answer was empty: it was asked again", "The model called a tool instead of
  answering: it was asked again for the answer"), and when a request was made smaller ("The
  request was larger than the model takes: older tool results were shortened, and it was sent
  again"). In the lines of `onStep`, `onActivity` and `result.steps`, a line break, a tab or another
  control character in what the model sent becomes one space, together with the blanks around it,
  and the characters that ingest drops from file text are dropped (see **Changed**), soft hyphens
  and byte order marks included. "](" becomes "] (", so that a markdown link or picture in what the
  model wrote stays text. A query is cut at 80 characters and a task at 100, never in the middle
  of a character. A call to a tool that does
  not exist is shown as `Call “do_magic” — failed: Unknown tool “do_magic”.`, with the name cut at
  64 characters, and its activity line is `Call “do_magic”…`; 0.5.0 started the step with the
  whole name. The model gets `Unknown tool “do_magic”.`, and so does `files.tools().execute()`: it
  was `Unknown tool do_magic.`. Steps still quote the model's words, HTML tags and web addresses
  included.
  **What to do:** if you parse steps or match the unknown-tool error, allow for these changes. Show
  steps and activity lines as plain text, never as markdown or HTML. See
  [What the library logs](docs/security.md#what-the-library-logs).
- **`anthropicToolTurns` and `openAiToolTurns` give a call without an ID a random one**
  (`toolu_` or `call_` and 24 hex characters). Gemini's calls, for one, may come without an ID.
  0.5.0 numbered them from 1 on each call (`toolu_1_1`), so the stored rounds of two questions had
  the same IDs, which Claude's Messages API refuses. A call that came with an ID keeps it. In
  `anthropicToolTurns`, an ID the API would refuse is changed (see **Fixed**, The adapters).
  **What to do:** nothing, unless you compare these IDs, or convert the same tool turns again for
  each request: each conversion now gives new IDs. Convert once and store the messages when you
  need the same IDs every time. See
  [Histories in a provider's own form](docs/guides/conversations.md#histories-in-a-providers-own-form).
- **A question stopped while its adapter is being called ends with the signal's reason.** When
  the signal aborts while the adapter is being called (from `onText`, say), `askWithFiles` now
  throws the signal's reason, as it does for every other way of stopping, whatever the adapter
  then does. When the adapter then failed with its own error, 0.5.0 threw that error (a 503, say);
  when it answered anyway, 0.5.0 returned its reply as the answer, with `answered: true`. The
  question also stops at once when the adapter does not look at the signal (see **Changed**).
  **What to do:** if a test expects the adapter's error, or its reply, there, expect the signal's
  reason.

Your own adapter or loop:

- **Your own adapter (optional).** An adapter written for 0.5.0 works as before. To get the new
  recovery, set `ModelReply.finish` (`"malformed_call"` lets the loop ask again for a call that
  could not be read), and throw a `ModelRequestError` from `send` and `generateText`. Its `kind`
  is told from the status and the message, or you pass it: `"context_overflow"` makes the request
  smaller (and a part read in halves), `"timeout"` with status 0 is sent again once, and
  `"quota"` is not sent again. In your own loop, `withRetry` follows the same rules: an error of
  kind `"quota"` or `"context_overflow"` is thrown at once, and one of kind `"timeout"` with
  status 0 is sent again once (not at all when `retry.retries` is 0). `ModelAdapter.estimateTokens`
  is now deprecated: the library never called it, and a later version may remove it. An adapter
  that declares it still compiles; leave it out, and set `capabilities.tokenScale` for a tokenizer
  that counts differently from the library's estimate. See
  [Your own adapter or loop](docs/guides/own-adapter-and-loop.md).
- **If you call `parseSseJson` yourself.** It also reads the body of node-fetch and other async
  iterables, and takes `{ onData, onDone, signal, maxEventLength }` (see **New**); calls written
  for 0.5.0 compile as before. It now takes a CR alone for a line end, as the format allows (0.5.0
  threw a `SyntaxError` on such a stream). An event of more than 64,000,000 characters ends the
  stream with an `SseEventTooLongError`. And it no longer waits for the `cancel()` of the stream,
  or the `return()` of an iterable, when it stops.
  **What to do:** nothing, unless your stream can send one event of more than 64,000,000
  characters: then pass a larger `maxEventLength`, or `Infinity`.

Tests:

- **Tests that compare exact output need new expectations.** A test that pins what the library
  writes fails where 0.6.0 writes something else. The cases, each explained above or under
  **Changed**:
  - prompts: the tool guide, the description of `analyze_whole_document`, the frame of a file sent
    whole, and the card (`1 line`, `1 page`, the line on how a file that is not valid UTF-8 was
    read, and the line of a question without a whole-file read);
  - searches: up to `max_results` + 1 `matches`, the `note`, the `evidence`, and the description
    of `search_document`;
  - steps: the new steps, the cleaned text, the unknown tool, and "1 matching line", "1 passage",
    "1 part" and "1 more tool call in this turn was not run";
  - tool results: `already_shown`, `text_cut`, `notes_only` and `answer_shortened`, and the IDs
    listed with an unknown `document_id`;
  - fakes: a model with a fixed queue of replies gets one more request after an empty reply, a call
    that could not be read, or an answer without text, and none for a call repeated while its
    result is shown; a fake `fetch` given to `gemini()`, `openAiCompatible()` or `anthropic()` gets
    the request again when it never answers (after `firstByteTimeoutMs`; a second silence fails
    with kind `"timeout"`), when its stream ends without its end mark (Gemini's `finishReason`, a
    `finish_reason` or `[DONE]`, Claude's `stop_reason`) or is cut off, and when it answers HTTP 200
    with an empty body, but fails at once when part of the reply was already shown; a streamed
    reply that is not of type `text/event-stream` is read by what it holds; an adapter that fails,
    or answers, after the question was stopped gives the signal's reason;
  - errors: `error.cause instanceof SyntaxError` for a reply that is not JSON, the status and kind
    of an error inside a stream, the kinds of `classifyModelError` (a request larger than a minute
    allows is `{ kind: "context_overflow", limitTokens: 30000, requestedTokens: 45237 }`), and the
    reasons of a whole-file read that failed;
  - `geminiToolTurns`, `openAiToolTurns` and `anthropicToolTurns`: no `tool_turns_left`, and
    random IDs for calls without one; `anthropic().capabilities` with context editing in `body`:
    `clearsToolResults: true`; the body of a Gemini part read: no `temperature`;
  - ingest: the stored text of a file with characters that show nothing, text that Word hides, a
    hidden slide, or an older encoding; `owner: ""`; the 500 of an upload whose store fails; and
    `MemoryDocumentStore.getMeta(id)`, a new object each time, so `toBe` between two calls fails.

  **What to do:** update those expectations. Compare steps and evidence to the tools that ran
  rather than to whole sentences, and leave the library's prompts out of what you compare whole,
  as [What to assert](docs/guides/testing.md#what-to-assert) advises. The testing guide shows the
  new forms in [Output that 0.6.0 changed](docs/guides/testing.md#output-that-060-changed).

If you ran main between 0.5.0 and 0.6.0:

- **Rounds that main stored, its ingest worker, and the kinds it gave.** Tool rounds that main
  stored can hold pointers (`already_shown: true`). A pointer to a search that lacks its last
  match, or to a read of one line from an earlier question, is now sent as the stand-in
  `Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it.`,
  and so is every pointer of an earlier question when the adapter sets `clearsToolResults`. The
  ingest worker of main's deployment guide (`ingestInWorker`), which set the heap flag in
  `NODE_OPTIONS`, did not hold its memory limit (see "One page of a PDF still holds the server"
  above, under Uploads). Some kinds differ from main's: HTTP 402, Claude's credit balance and
  spending limits, and a Vertex AI quota per day that only the message names are `"quota"` (they
  were `"invalid"` or `"rate_limit"`); a request larger than the tokens a minute allow is
  `"context_overflow"` (it was `"rate_limit"`); `insufficient_quota` inside an OpenAI-compatible
  stream is 429 `"quota"` (it was 500 `"server"`, sent three more times); Claude's errors inside a
  stream have their type's status (an `authentication_error` was `"invalid"`, and is `"auth"`);
  and a streamed Gemini reply that is a page of HTML is `"invalid"` (it was `"unreachable"`, sent
  three more times).
  **What to do:** nothing for stored rounds. Replace an ingest worker with the child process of
  `ingestInProcess` in [Deployment](docs/guides/deployment.md#uploads-and-ingest), and check code
  that chooses by these kinds.

### New: what you can add

The samples assume what your app already has: `files` from `createLargeFiles()`, `endpoint` from
`vertexAi()`, and the `documentIds` and `question` of the chat.

Errors and failed questions:

- **The kind of every model error.** `ModelRequestError` has `kind`, and so have the errors that
  extend it (`GeminiRequestError`, `OpenAiRequestError`, `AnthropicRequestError`):
  `"context_overflow"`, `"quota"`, `"rate_limit"`, `"timeout"`, `"unreachable"`, `"server"`,
  `"auth"` or `"invalid"`. It is told from the status, the message and the provider's own code
  (Gemini's `error.status` and `details`, OpenAI's `code`, Claude's `type`). For a request too
  large for the model, `limitTokens` and `requestedTokens` are the provider's numbers when its
  message gives them (the one Vertex AI sent in a live check gave only the limit).
  `errorKindOf(error)` reads the kind of any error,
  `classifyModelError(status, message, signals?)` tells it for errors of your own, and the types
  are `ModelErrorKind` and `ModelErrorClass`. The constructor of each error class takes `kind`,
  `code` and `details`. See
  [The kind of a model error](docs/guides/errors-and-reliability.md#the-kind-of-a-model-error) and
  [`ModelErrorKind`](docs/reference/errors-and-retries.md#modelerrorkind).
- **What a failed question found: `partialResultOf(error)`.** The question still throws the
  provider's error. `partialResultOf(error)` gives what it had done until then, as an `AskResult`
  with `answered: false`: its steps, evidence, tool rounds and usage. It is undefined for an error
  thrown before the question started (a document that is missing). Exported from
  `llm-large-files` and `llm-large-files/gemini`. See
  [`partialResultOf(error)`](docs/reference/ask.md#partialresultoferror) and
  [Keeping what a failed question found](docs/guides/errors-and-reliability.md#keeping-what-a-failed-question-found).

  ```ts
  import { errorKindOf, partialResultOf } from "llm-large-files";
  import { askGemini } from "llm-large-files/gemini";

  try {
    const result = await askGemini({ files, endpoint, documentIds, messages: [{ role: "user", text: question }] });
    console.log(result.text);
  } catch (error) {
    const partial = partialResultOf(error);
    // Not an answer, but paid for: count its usage, and keep its tool rounds if you store them.
    if (partial) console.log(partial.usage.requests, partial.usage.inputTokens, partial.toolTurns.length);
    const kind = errorKindOf(error);
    if (kind === "quota") console.log("The model's quota is used up. Try again later.");
    else if (kind === "timeout" || kind === "rate_limit") console.log("The model did not answer. Try again in a minute.");
    else throw error; // another kind, or not a model error (a missing document, a bug)
  }
  ```

  ```ts
  import { classifyModelError } from "llm-large-files";

  classifyModelError(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.");
  // { kind: "context_overflow", limitTokens: 128000, requestedTokens: 130512 }
  ```

- **Waits on a silent model: `firstByteTimeoutMs` and `idleTimeoutMs`**, on `askGemini`,
  `gemini()`, `openAiCompatible()` and `anthropic()`. The defaults are the new exports
  `DEFAULT_FIRST_BYTE_TIMEOUT_MS` (600,000) and `DEFAULT_IDLE_TIMEOUT_MS` (300,000); the type
  `IdleWaits` holds the two options. See
  [Waits on a silent model](docs/guides/errors-and-reliability.md#waits-on-a-silent-model) and
  [`IdleWaits`](docs/reference/errors-and-retries.md#idlewaits).

  ```ts
  import { askGemini } from "llm-large-files/gemini";
  import { openAiCompatible } from "llm-large-files/openai";

  // A chat that streams to a user: give up sooner than the defaults.
  const result = await askGemini({
    files,
    endpoint,
    documentIds,
    messages: [{ role: "user", text: question }],
    firstByteTimeoutMs: 180_000, // the first piece of a reply within 3 minutes
    idleTimeoutMs: 60_000, // then no pause longer than 1 minute
    onText: (delta) => process.stdout.write(delta),
  });

  // A local model that reads a long prompt slowly: wait for its first piece without end.
  const local = openAiCompatible({ baseUrl: "http://localhost:8000/v1", model: "local-model", firstByteTimeoutMs: 0 });
  ```

- **`RetryNotice`**: the type of what `withRetry` passes to `onRetry`: `error`, `attempt` (the
  number of the retry to come) and `delayMs` (the wait). 0.5.0 passed the same notice but did not
  export its type. See
  [Errors, retries and streams](docs/reference/errors-and-retries.md#retrynotice).
- **`OpenAiRequestError.param` and `.code`**: the server's `error.param` (`"max_tokens"`) and
  `error.code` (`"unsupported_parameter"`, `"context_length_exceeded"`). See
  [`OpenAiRequestError`](docs/reference/openai.md#openairequesterror).

Your own adapter or loop:

- **`ModelReply.finish`**: how a reply ended, in terms every adapter maps its own to:
  `"complete"`, `"cut"` (at the output limit, or Claude's full window), `"filtered"` (by the
  provider's safety filters) or `"malformed_call"` (a tool call that could not be read: Gemini's
  `MALFORMED_FUNCTION_CALL` and `UNEXPECTED_TOOL_CALL`). The three adapters set it. See
  [`ModelReply`](docs/reference/ask.md#modelreply) and
  [How the reply ended](docs/guides/own-adapter-and-loop.md#how-the-reply-ended-finish).
- **`ModelCapabilities.clearsToolResults`**: for an adapter whose provider may clear old tool
  results on its side. A call made again is then run again, not answered with a pointer to a
  result the model may no longer have, and the pointers in stored rounds become stand-ins that say
  to call again. `anthropic()` sets it when `body.context_management` has an edit that clears tool
  uses (`clear_tool_uses_…`) or compacts the conversation (`compact_…`). The loop still counts
  every result as sent, so its room runs out at the same point as without context editing. An
  adapter of your own sets it itself. See [`ModelCapabilities`](docs/reference/ask.md#modelcapabilities).
- **`ToolCallLimits.maxRequests`**: the model requests a whole-file read may make. It does not
  stop the read: a part the model refuses as too large is read as two halves only while it allows.
  `askWithFiles` passes the read's own requests and a share of what the question has left of
  `limits.requests`; in your own loop, pass it to `executeWithFiles`. See
  [Tools](docs/reference/tools.md#toolcalllimits).
- **`PrepareOptions.wholeDocumentAnalysis`**: whether your tool set has `analyze_whole_document`.
  Defaults to `true`. In your own loop, pass `wholeDocumentAnalysis: false` to `files.prepare()`
  when you call `files.tools()` without `generate`: the tool guide then does not name the tool,
  and the cards do not offer a whole-file read. See
  [The library and its documents](docs/reference/library.md#prepareoptions).
- **`SseHooks`**: the second argument of `parseSseJson`: `onData` (bytes arrived, keep-alives
  included), `onDone` (`data: [DONE]` arrived), `signal`, and `maxEventLength`, the most
  characters one event may hold, counted on its data. It defaults to 64,000,000; `Infinity` sets
  no limit. A longer event ends the stream with an `SseEventTooLongError`
  (`An event of the stream held more than 64,000,000 characters.`), whose `limit` holds the limit.
  The class is exported from `llm-large-files` and `llm-large-files/gemini`. The same event would
  come again, so an adapter of your own should not send the request again for it. See
  [`SseHooks`](docs/reference/errors-and-retries.md#ssehooks).

Uploads:

- **`maxTextBytes`**: the most text kept from one file, in UTF-8 bytes. Defaults to
  `DEFAULT_MAX_TEXT_BYTES`, 100 MB, or to `maxUploadBytes` when that is larger. The PDF, DOCX and
  PPTX extractors refuse a file as soon as its text passes it (a PDF page by page), and `ingest`
  refuses a larger text from any other extractor, yours included. See
  [`LargeFilesOptions`](docs/reference/library.md#largefilesoptions).
- **`maxPdfPages`**: the most pages read from one PDF. Defaults to `DEFAULT_MAX_PDF_PAGES`, 5,000.
  A PDF with more is refused before any page is read. See
  [the library reference](docs/reference/library.md#default_max_pdf_pages).
- **`ingestTimeoutMs`**: the most time one `ingest` may take. Defaults to
  `DEFAULT_INGEST_TIMEOUT_MS`, 120,000 (2 minutes); 0 sets no limit, and so does a value past
  what a timer can wait (2,147,483,647 ms, 24.8 days). See
  [`LargeFilesOptions`](docs/reference/library.md#largefilesoptions).
- **`IngestInput.signal`**: stops an ingest, for example when the uploader goes away. `ingest`
  throws the signal's `reason` and stores nothing. The PDF, DOCX and PPTX extractors stop between
  pages and pieces, and the text extractor between the steps of a file that is not valid UTF-8.
  `createDocumentHandlers` passes one that aborts when the client closes the connection. See
  [`IngestInput`](docs/reference/library.md#ingestinput).
- **`ExtractInput.signal`, `ExtractInput.maxTextBytes` and `ExtractInput.maxPages`**: the signal
  of the ingest (aborted at `ingestTimeoutMs` or by `IngestInput.signal`) and the two limits, for
  an extractor of your own to honour. See
  [Custom extractors](docs/guides/pdfs.md#custom-extractors).
- **`createPdfExtractor({ checkPages: false })`** turns the page check off. With
  `pictures: false` too, PDFs are not read with `@cantoo/pdf-lib` at ingest. See
  [`PdfExtractorOptions`](docs/reference/library.md#pdfextractoroptions).
- **`DocumentMeta.encoding` and `DocumentMeta.replacedCharacters`**, and the same two fields of
  `DocumentSummary` and `ExtractedText`: how a text file that is not valid UTF-8 was read.
  `encoding` is the older encoding the file was read in, as TextDecoder names it
  (`"windows-1255"`); lines of the file that are valid UTF-8 were read as UTF-8 all the same.
  `replacedCharacters` is the number of characters that were not valid in the encoding the file
  was read in (UTF-8, or `encoding`), each stored as U+FFFD. Both are absent for valid UTF-8, for
  UTF-16, PDF, DOCX and PPTX, and on documents stored before 0.6.0; `encoding` is absent too for a
  file read as UTF-8 with characters that are not valid. `toDocumentSummary` passes them on, so
  the upload route of `createDocumentHandlers` answers with them. An extractor of your own may
  report them in `ExtractedText`: `encoding` is kept when it is a name, such as `iso-8859-2`, other
  than UTF-8 or UTF-16, and `replacedCharacters` when it is a whole number above 0. See
  [`DocumentMeta`](docs/reference/library.md#documentmeta).

```ts
import type { ServerResponse } from "node:http";
import { createLargeFiles, FileDocumentStore, type DocumentMeta } from "llm-large-files";

const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  maxTextBytes: 50 * 1024 * 1024, // keep at most 50 MB of text from one file
  maxPdfPages: 2_000,             // refuse a longer PDF before reading a page of it
  ingestTimeoutMs: 60_000,        // give up on a file after one minute
});

// In an upload route of your own: stop reading the file when the uploader goes away.
async function ingestUpload(response: ServerResponse, name: string, bytes: Uint8Array, owner: string): Promise<DocumentMeta> {
  const uploaderLeft = new AbortController();
  response.on("close", () => uploaderLeft.abort(new Error("The upload was cancelled.")));
  const meta = await files.ingest({ name, bytes, owner, signal: uploaderLeft.signal });
  // Tell the user how a file that was not in UTF-8 was read.
  if (meta.encoding) console.log(`${meta.name} was read as ${meta.encoding}.`);
  if (meta.replacedCharacters) console.log(`${meta.replacedCharacters} characters of ${meta.name} show as �.`);
  return meta;
}
```

### Changed: what works differently

Besides the points under **Upgrading**:

The tool loop:

- **A request too large for the model is made smaller and sent again**, where 0.5.0 failed the
  question. The loop takes the provider's count and window for the rest of the question,
  replaces older tool results with short stand-ins (the latest round too, if it must), and sends
  the request again, at most twice a question. When the first requests are too large before any
  tool ran, the documents are planned again, once, for a smaller window worked out from the
  provider's numbers, or 7/10 of the window assumed when it gives none. Vertex AI's message names
  1,048,576 tokens and no count: with the default window of 1,000,000, the documents are planned
  for 838,860. What the first try paid for, and the tool turns it took, are counted. When Claude is
  one of the models, nothing is shortened (its conversation may only grow), so only the second
  plan applies. The wordings known include those of Text Generation Inference and Together, LM
  Studio, Amazon Bedrock and vLLM, besides Gemini's, OpenAI's and Claude's. See
  [A request too large for the model](docs/how-it-works.md#a-request-too-large-for-the-model).
- **Two searches in a row that failed in the same mode** get a hint added to the error: after two
  regex searches, to try exact or keywords mode; after two of another mode, to check the arguments
  or answer from what the model has.
- **An unknown `document_id`** is answered with the IDs the model may use, and their file names
  (up to 20). An ID longer than 64 characters is quoted cut, in the error and in its step.
- **The tool guide, and the description of `analyze_whole_document`, send counting and listing to
  exact search.** Both sent "every occurrence" to `analyze_whole_document`, which missed items in
  our live tests (492 of 1,200; 91 of 120), while `search_document` in exact or regex mode gives
  an exact `total_matching_lines`. The whole-file read is now for what needs meaning: a summary, a
  timeline, items judged one by one. See [The tool guide](docs/reference/tools.md#the-tool-guide)
  and [`analyze_whole_document`](docs/reference/tools.md#analyze_whole_document).
- **In `askWithFiles` and `askGemini`, the tool guide names `analyze_whole_document`, and the
  cards offer a whole-file read, only when the question has the tool.** With
  `wholeDocumentAnalysis: false`, or a model that explores without `generateText`, they still
  offered a whole-file read when a file was small enough for one, and a model that called it was
  answered "Unknown tool analyze_whole_document.". Each card now says "Use the document tools to
  search it and to read line ranges.", and the guide leaves the tool's line out. In your own loop,
  pass `wholeDocumentAnalysis: false` to `files.prepare()` for the same (see **New**). See
  [Tools](docs/reference/tools.md#which-tools-are-offered).
- **A part of a whole-file read that the model refuses as too large is read as two halves**,
  while `maxMapChunks` and the requests the question has left allow it.
- **A part that the provider stopped before its end is said to be incomplete**, as one cut off at
  the output limit is: Gemini's `SAFETY` and its other filter reasons, OpenAI's `content_filter`,
  Claude's `refusal`, and Claude's `model_context_window_exceeded` (its window was full).
- **Tool results have new fields**: `already_shown` (a pointer), `text_cut` (a `read_document`
  whose text was cut to its room), and, on a whole-file read, `notes_only` and
  `answer_shortened` (see **Fixed**). The step of a whole-file read that returned its notes ends
  in ", notes only". See [Tools](docs/reference/tools.md).
- **A question stops when its signal aborts, even with an adapter that does not.** The loop no
  longer waits for an adapter (or a part reader of a whole-file read) that does not look at
  `signal`. With 0.5.0, an adapter whose request never ended held the question for good after an
  abort. `askWithFiles` now throws the signal's reason at once (310 ms after an abort at 300 ms),
  also when `onText` stopped it or when it was stopped between two requests, with
  `partialResultOf`; nothing is sent after the stop, no further part of a whole-file read either;
  and text that such an adapter sends later is not shown. `partialResultOf(error).usage` is what
  was counted when the question stopped: a request still running then may be billed by the
  provider, and is not counted. See [Cancelling](docs/guides/web-app.md#cancelling).
- **`geminiFunctionResponses` returns a `GeminiContent & { role: "user" }`, and
  `geminiFunctionResponseTurns` an array of them**, which go into a `GeminiContent[]` without a
  cast. Their parts were typed `unknown[]` (see **Upgrading**). See
  [`llm-large-files/gemini`](docs/reference/gemini.md#geminifunctionresponsescalls).

Ingest:

- **Ingest lets other requests run while it reads a file.** Each step works in slices of about
  12 ms, with a pause for other requests between two slices: the PDF extractor between pages, the
  DOCX and PPTX extractors as they unpack, the text extractor as it reads a file that is not valid
  UTF-8, and then `ingest` as it cleans the text, measures it, and builds the outline, the log
  profile and the line index. Ingests that run at once take turns, one slice each. Picture marks
  pause every 12 ms between pages, and their limit of 5 s counts only the work, not the pauses. An
  ingest of a 99 MB log takes 1.9 s, as before, now in slices.
- **`createDocumentHandlers` stops reading an upload when the client goes away.** Its upload
  handler passes `IngestInput.signal`, aborted when the connection closes before the answer is
  sent: nothing is stored.
- **`ingest` stops waiting for an extractor** when the ingest's signal aborts (`ingestTimeoutMs`,
  or `IngestInput.signal`), whether or not the extractor looks at the signal.
- **DOCX and PPTX take memory by their text, not by their XML.** Each paragraph becomes one string
  when it closes, and an empty paragraph is dropped. Text is counted as it reads, not as the XML
  writes it (`&amp;` is one character).
- **`view_pages` and picture marks pause by time.** `@cantoo/pdf-lib` reads the whole file into
  objects first, and on its own pauses for other requests after a count of objects: 0.5.0 used
  4,000, which took 0.5 to 0.8 s in a large file, while a file of fewer objects never paused. It
  now pauses after every 12 ms of work (up to 40 ms on Windows, where a pause takes about 15 ms).
  Measured on Windows with Node 24: a file of 4,000 large arrays held the event loop for 28 to
  32 ms at a time, and a 2,000-page PDF 19 to 38 ms. A whole read takes 0.91 to 0.96 s for a file
  of 61,000 small objects and 1.35 to 1.43 s for one of large objects, against 1.65 to 1.87 s and
  1.13 to 1.22 s with a pause every 500 objects; 0.5.0's pause every 4,000 was not timed this way.
  Your app's own use of `@cantoo/pdf-lib` is not changed.
- **The model is told how a text file that is not valid UTF-8 was read.** The card of a large
  file gets one more line:
  `This file is not in UTF-8. Its text was read as windows-1255: if its letters look wrong, ask the user to save it as UTF-8.`
  When bytes of the file are not in that encoding, the line goes on:
  ` 1 character of it was not valid in windows-1255, and shows as �.` For a file read as UTF-8
  with characters that are not valid, the line is
  `3 characters of this file were not valid UTF-8, and show as �.`
  The first line of the frame of a file sent whole says the same in short, after the count of
  lines: `, read as windows-1255`, `, read as windows-1255, 1 character not valid in it, shown as �`,
  or `, 3 characters not valid UTF-8, shown as �`. A file that is valid UTF-8 or UTF-16 gets no
  such line. See [The card](docs/how-it-works.md#the-card).
- **A text file that is not valid UTF-8 is read in slices,** with pauses for other requests, and
  it stops when the ingest's signal aborts. Reading it takes about twice as long as 0.5.0's decode,
  which gave U+FFFD: 0.27 to 0.28 s against 0.11 to 0.16 s for a 30 MB CSV in windows-1255, in
  steps of 15 ms at most. A file whose lines take turns between UTF-8 and an older encoding takes
  longer, the shorter its lines are: for 30 MB, 0.50 to 0.53 s in lines of 100 bytes, and 2.1 to
  2.2 s in lines of one letter (Node 24, Windows). See
  [Text encodings](docs/guides/pdfs.md#text-encodings).
- **Ingest removes characters that show nothing** from the text: control characters
  U+0080-U+009F, which 0.5.0 kept (a U+0085 can become a line break instead; see the next point),
  and an escape sequence that starts with U+009B, such as `\u009b31m`, whole (0.5.0 stored
  `x\u009b31mERROR` as it was; it is now `xERROR`), but for a U+009B right after a character of
  U+0080-U+00FF, which is the end of a letter of UTF-8 read as Latin-1 ("ś" is C5 9B) and goes
  alone ("Coś? Tak" keeps its "? Tak"); Unicode tag characters
  (U+E0000-U+E007F); the text-direction controls that reorder what a person sees (U+202A-U+202E,
  U+2066-U+2069); the zero-width space, the word joiner and the invisible operators (U+200B,
  U+2060-U+2064); the deprecated format characters (U+206A-U+206F); a byte order mark inside the
  text; and the soft hyphen, except at the end of a line. Kept: the marks right-to-left text needs
  (U+200E, U+200F, U+061C), zero-width joiners and non-joiners (emoji, Persian), variation
  selectors, and the flags of England, Scotland and Wales; other flags written with tag characters,
  such as Texas, keep only the black flag. A file name loses the same characters, but its control
  characters and text-direction controls become a space, as in 0.5.0. Of these
  removals, two move lines: in a text with no line feed, where U+0085 ends lines, and after a line
  of more than 2,000 characters that lost some of them, which can now be cut into fewer lines;
  hidden text in a DOCX moves lines too (below). A file read as 0.5.0 read it that holds none of
  these characters, and has no hidden text or hidden slide, is stored as before, byte for byte (25
  inputs compared, 12 PDFs among them). Cleaning takes 2 to 7% longer on an ASCII log, and 10 to
  20% on Hebrew in UTF-8; a whole ingest did not take longer beyond the spread of runs. See
  [Characters that show nothing](docs/security.md#characters-that-show-nothing).
- **U+0085 ends a line in a text that has no other line break.** Some files end each record with
  U+0085 (NEXT LINE) and contain no line feed, such as z/OS data converted to UTF-8 with iconv
  (IBM-1047). 0.5.0 stored such a file as one line, with the U+0085 characters in it. Each record
  is now a line of its own, and an empty record is dropped. A record that ends in a character of
  U+0080-U+00FF, such as É, ° or £, still runs into the next one: there a U+0085 is taken for the
  last byte of a UTF-8 letter read as Latin-1 ("ą" is C4 85), and removed. A file of one line,
  such as minified JSON, has no other line break either, so a U+0085 inside one of its strings
  becomes a line break too. In a text with other line breaks, a U+0085 is removed with the other
  C1 control characters. The same export in ISO-8859-1, with a byte 0x85 at the end of each
  record, is read as windows-1252, where 0x85 is "…", and stays one long line, cut every 2,000
  characters: convert such a file to UTF-8 instead.
- **Text that Word hides is marked.** The text of a run hidden in Word (`<w:vanish/>`) was stored
  as ordinary text. It now comes after the text of its paragraph that shows, and each of its lines
  starts with `[Hidden text, not shown in the document]`, so that the model can tell it from what
  a reader sees; a line break in it starts a new marked line, and a line longer than about 1,950
  characters is cut into pieces, each marked. The marks count toward `maxTextBytes` and the 32
  million characters of a DOCX. The mark is a hint, not a filter: text hidden through a style,
  white or 1-point text, and a few rarer forms are read as ordinary text, and a document's own
  text can write the mark. See
  [Hidden text in Word and PowerPoint](docs/security.md#hidden-text-in-word-powerpoint-and-html).
- **A hidden slide says so.** The heading of a slide that the slide show skips (`show="0"`) reads
  `## Slide 2 (hidden, not shown in the slide show)`. Its text is kept. Shapes hidden on a slide
  that shows are read as ordinary text. See [DOCX and PPTX](docs/guides/pdfs.md#docx-and-pptx).
- **`MemoryDocumentStore` copies the metadata** it is given and the metadata it hands out, as a
  store that writes it somewhere does. `getOriginal` still returns the kept bytes themselves: treat
  them as read-only. See [`MemoryDocumentStore`](docs/reference/library.md#memorydocumentstore).

The adapters:

- **A request sent again after its reply was cut off on its way says so.** `onActivity` gets
  "The model's reply was cut off on its way. Trying again…" for a stream that closed before its
  end, a connection that failed once the reply had begun, or a reply of HTTP 200 that came empty.
  "The model could not be reached. Trying again…" stays for a connection that failed before any
  reply.
- **A reply asked for as a stream is read by what it holds when its content type is not
  `text/event-stream`.** It is read as events when it starts like them (a field such as `data:`,
  or a comment), and as JSON when it starts with `{` or `[`. A body that starts with more than
  65,536 characters of white space is read as JSON, whatever follows it. A gateway that streams
  under `application/octet-stream`, or under no type, failed with a `SyntaxError` on the
  OpenAI-compatible and Claude adapters. Gemini's chunks in a list, as it sends them without
  `alt=sse`, are read too. See
  [A stream cut off](docs/guides/errors-and-reliability.md#a-stream-cut-off).
- **Claude: `x-should-retry: false` is followed.** A request that the API says not to try again is
  not sent again, whatever its status, as Anthropic's own SDKs do.

### Fixed

Uploads you do not trust (the numbers before were measured on main at 5157e7f, whose ingest, PDF
and Office code is that of 0.5.0):

- **A DOCX of 1.5 MB no longer stops a server with a heap of 512 MB.** It held 120 MB of empty
  paragraphs, each of which 0.5.0 kept until the end of the file: the process ran out of memory
  and stopped, and every answer streaming on it with it. The same file is now refused
  ("padded.docx did not contain any text.") in 3.0 to 3.2 s, with the process at 115 MB. A DOCX
  of 3 MB that unpacks to 1,000 MB of XML, which stopped the same server, is refused at its
  millionth paragraph in 0.9 s, at 165 MB.
- **A DOCX of many parts, or with a list of parts built to exhaust JSZip, no longer stops the
  server.** 0.5.0 had no limit on the parts of an Office file: 300,000 empty parts took over
  500 MB in JSZip, and a DOCX of 88 MB with a million parts ran a heap of 1.5 GB out of memory.
  The parts are now counted, and the list read, before JSZip reads it, as JSZip will read it.
  Unicode Path fields that ran over the records after them ran a heap of 256 MB out of memory from
  a DOCX of 0.17 MB, and a ZIP64 end record of a file of 636 bytes held the process until it was
  killed. Such files are refused in 40 to 90 ms, with the heap at 8 to 9 MB. Real files are read
  as before (245 ZIP files of Office, Java and other programs compared), and a DOCX just under
  every limit at once is read in 0.46 to 0.48 s. See [Measurements](docs/measurements.md#the-server).
- **A PDF of a few KB no longer stores 100 MB of text, or holds the server for minutes.** These
  files are now refused, each in under 0.3 s:
  - a page tree that lists one dense page 150 times (3 KB, 107 MB of text) or 600 times (6 KB:
    it held the event loop for 205 s with a heap of 1.5 GB, and ran a heap of 512 MB out of
    memory);
  - 140 pages that all paint one dense content stream (23 KB, 99.5 MB of text), and 60 pages that
    all show one stream of 4 MB (25 KB, 1.3 s a page, 38 s in all);
  - a page that paints a form that paints the next one 50 or 100 times, three levels deep (3 KB,
    13 s, 350 to 380 MB; 4 KB, about 100 s), files of 2 to 21 KB built the same way, 2 to 6 levels
    deep (17 s to 2 minutes), eight forms that each paint all eight (6 s), and forms painted from
    content that only pdf.js could decode (10 s);
  - a page that runs 160 MB of text operators packed 250 times (650 KB, 23 to 29 s), and three
    pages that each run 40 MB (160 KB, 6 to 14 s at a time);
  - a Type3 font whose one glyph paints a form 390,000 times, which pdf.js ran when a page set the
    font (3 KB, 9 s at 730 MB).

  All but the first need `@cantoo/pdf-lib` installed (the page check, under **Upgrading**);
  without it, the 23 KB file is refused at 16 MB of text, in under 6 s. Two forms that paint each
  other are read, as pdf.js reads them.
- **A large upload no longer holds the server while it is read.** An ingest held the event loop
  for most of its time, and every answer streaming on that server stopped with it. Measured on one
  machine (Node 24, Windows), three times each, the longest gap of a 5 ms timer during the ingest
  of a 99 MB log went from 1.9 to 2.0 s down to 31 to 34 ms, and of a 2,000-page PDF from 4.4 to
  4.5 s down to 0.16 s. The log took 1.9 s to ingest either way; the PDF 4.9 to 5.0 s, against 4.6
  to 4.9 s. A line of megabytes is cleaned in pieces too: one line of 30 MB with a control
  character between its letters held the event loop for 1.9 s, with 761 MB of memory, and now for
  71 to 76 ms, with 250 MB. What is left comes from the cut of a long line into lines of 2,000
  characters, which still runs in one block: 0.21 to 0.23 s for a line of 66 million characters.
- **A look at the pages of a PDF lets other requests run while it parses the file, copies the
  pages and writes the cut.** In 0.5.0 a look held the event loop for nearly its whole time: one
  page that refers to 20,000 large arrays held it 1.87 to 2.02 s of 3.8 to 3.9 s, and pages of a
  2,000-page PDF 159 to 177 ms of 163 to 185 ms. Now the longest holds are 43 to 47 ms and 19 to
  20 ms (Windows, Node 24). A cut is the same to the byte as before (65 cuts of 50 PDFs compared).
  Each look still reads and parses the whole file, and the first look of a process loads
  `@cantoo/pdf-lib` in one block (about 0.4 s, unless the server loads it when it starts).
- **A PDF name escaped again and again no longer holds the server.** A name such as
  `/#2323...2341` loses one level each time it is decoded, and both the page check and a look at
  the pages decoded every name of a page until nothing changed, in one block: time grew with the
  square of its length. A name is now decoded at most three times, and one that would still
  change is taken as a name that cannot be read: the page check counts it as naming any drawing,
  and a look keeps every image of the page. Measured on one machine (Linux, Node 22), the ingest
  of a 0.4 MB PDF with one such name of 400,000 characters in its resources ran over 90 s and now
  takes 0.27 s, and a look at its page ran over 90 s and now takes under 0.2 s; a PDF of under 20 KB whose content paints 40 such
  names of 30,000 characters went from 11.7 s to 0.41 s. Names that real files write are read as
  before.

Access:

- **`files.tools()` checks the owner of each document it reads.** In 0.5.0, a loop of your own
  that built a `DocumentMeta` from an ID a client sent could read the text of another owner's
  document through the tools, and show the pages of its PDF (see **Upgrading**).
- **Changing metadata that `MemoryDocumentStore` handed out no longer changes the document.**
  `ingest` and `getMeta` returned the store's own object: deleting `owner` from it before sending
  it to a browser opened the document to every owner. `FileDocumentStore` was not affected.

Searches:

- **A model asked when something last happened can now see the last matching line.** In a live
  check on Vertex AI, with gemini-3.1-flash-lite and a 3 MB production log, the model counted the
  442 PAY-5031 errors right, then named line 12,088 as the last one. It was line 15,269: the
  search showed the first matches only, and said nothing of the others (see **Upgrading**). A way
  to page through all the matches is planned for 0.7.0.
- **A search that stopped early and was cut to the size limit still says that its total is a
  lower bound.** 0.5.0 replaced that note with the note of the cut.
- **Steps say "1 matching line", "1 passage", "1 part" and "1 more tool call in this turn was not
  run"**, where 0.5.0 said "1 matching lines" and so on. Likewise, a file of one line is `1 line`
  in its frame and its card, and a PDF of one page is `1 page` in its card.

Text files and what the model reads:

- **A Hebrew CSV that Excel saved in windows-1255 can be searched.** 0.5.0 stored its 30 rows as
  U+FFFD, and "ירושלים" was found in none of them; now it is found in all 30. Arabic in
  windows-1256, Russian in windows-1251, French in windows-1252, and Japanese in Shift_JIS are read
  the same way (see **Upgrading**).
- **An export in CESU-8 is read with its emoji.** An Oracle database in its character set `UTF8`,
  and Java's modified UTF-8, write a character past U+FFFF as two halves of a surrogate pair. When
  that is the only thing wrong with a file, it is read as UTF-8, with the pairs joined. 0.5.0
  stored each such emoji as six U+FFFD.
- **Tag characters, and the controls that reorder what a person sees, are removed at ingest.** A
  line with 44 Unicode tag characters, which spell out an instruction that a model reads and a
  person does not see, sent all 44 to the model, and a file name kept them too. Characters that
  scripts and emoji need are kept, and a crafted file can still carry data a person does not see
  in them ([Characters that show nothing](docs/security.md#characters-that-show-nothing)). The
  library does not detect instructions.
- **An exact search finds a word split by a zero-width space or a soft hyphen**, in a file
  ingested from now on: `pass\u200bword` now matches a search for "password".
- **A file's own lines, and its name, no longer pass for the end of its frame.** A file sent whole
  could hold `--- End attached file: report.txt ---`, the same line the library writes. The frame
  lines now carry a mark that the file cannot know (see **Upgrading**); it does not make the model
  obey, and it is not a secret ([The frame around a file](docs/security.md#the-frame-around-a-file)).
- **No half of an emoji reaches Claude.** 0.5.0 cut text inside a character outside the basic
  plane, which JSON writes as `\ud83d` and Claude's API refuses: in tool results, search lines,
  stand-ins, the first lines of a card, log templates, the problem message of a call whose
  arguments could not be read, and file names, cut at 255 characters. These are now cut before
  such a character. What 0.5.0 stored cut that way (log templates, search windows in stored tool
  rounds, names) is sent with U+FFFD in place of the half, and `getMeta` returns a name the same
  way; the stored data is not changed. An emoji of several characters, such as a flag, can still
  lose its end at the cut of a name.

Ingest:

- **An outline of 20 to 399 top-level headings keeps each of them once, in order.** In a document
  of more than 400 headings, such an outline took its entries from the first headings only, some
  more than once: with 20 top-level headings, the first one 20 times. It was so in 0.5.0 and every
  version before. Ingest a document again to rebuild its outline.

The tool loop:

- **The calls of a turn share the room that is left.** Each call took its whole cap in call
  order, so the first calls could take all the room, and the next were told "no room left, answer
  now". The room is now shared evenly, and only calls that cannot each get 1,500 characters are
  refused.
- **Whole-file reads in one turn are counted together** against `limits.requests` and
  `limits.inputTokens`: two reads that each fit passed the ceiling together (16 requests against
  11 in a probe). Their input tokens are counted by the `tokenScale` of the model that reads the
  parts, and the provider's count of a request by that of the model that gave it, not by the
  largest scale of the question.
- **Part reads of a `generateText` that does not call `onUsage` count toward `limits.requests`**
  and `usage.requests`. They were left out.
- **The request for an answer after no tool ran is `FINAL_ANSWER_WITHOUT_TOOLS`**, also when the
  first reply was empty or no turn was left for tools. It said "using only what the tools returned
  above".

Whole-file reads:

- **A read whose last step failed returns the notes of its parts**, with `notes_only: true`,
  instead of an error that lost every part already paid for.
- **A model that asks again for a read that could read no part is told that it failed, and why**,
  not to "use the answer of that read". A read that failed before any model request (a store that
  could not be read) can be made again.
- **A long answer is cut at its end**, with `answer_shortened`, and the other fields
  (`parts_read`, the notes on what is incomplete) are kept. It was cut as JSON, which dropped them.
- **A part that could not be read from storage no longer shows the model the server's file
  path**, only the error code ("The file could not be read from storage (EACCES). Try the call
  again.").
- **One HTTP 400 no longer turns the larger output limit off for every later question.** A part
  refused as too large for the window with 32,768 output tokens was taken for a model that refuses
  that limit: every later part on that model, in that process, was sent with 4,096, and a model
  that thinks got no text.
- **One part refused by the per-minute token limit no longer blocks whole-file reads for the rest
  of the process.** The larger output limit stayed learned, and every later part asked for it
  again and was refused. Now an allowance of no more than 32,768 tokens turns it off for the model.
  With a fake OpenAI-compatible server, 12 of 12 parts were read in 15 requests, where main
  (5157e7f) read none in 34.
- **Claude: a part read that thought most of its output limit away is asked again with the larger
  limit** (`THINKING_OUTPUT_TOKENS`), as Gemini and OpenAI-compatible part reads are. Its notes
  came back cut: two lines out of 4,096 tokens.

The adapters:

- **All three: a connection that failed while the body of a reply arrived is sent again**, like
  one that failed before the reply. In 0.5.0 a chat reply that came in one piece was not.
- **A stream that closes without saying why it ended is not taken for a whole reply**: Gemini's
  last chunk has a `finishReason`, an OpenAI-compatible stream a `finish_reason` or `[DONE]`, and
  a Claude stream a `stop_reason`. A proxy or a dropped connection made a cut answer, or a cut turn
  of tool calls, count as whole (see **Upgrading**). On Claude, a call whose block was never closed
  is answered "send it again", not run with no arguments. DeepSeek's
  `insufficient_system_resource` is the server's failure (HTTP 503), not a whole reply.
- **OpenAI-compatible and Claude: a stream that said it is whole returns its reply, though the
  server then left the connection open, or the connection broke.** After `[DONE]` or
  `message_stop`, the body is read for at most one more second, and then cancelled. With 0.5.0,
  such a request waited until the server closed the connection, and failed when it broke.
- **A streamed reply through a `fetch` whose body is a Node stream** (node-fetch) failed with
  "stream.getReader is not a function". Both kinds of body are read.
- **A streamed event longer than 64,000,000 characters ends the reply**, with an error of kind
  `"invalid"` and status 200 that is not sent again:
  `The model's reply could not be read: an event of its stream held more than 64,000,000 characters.`
  (Claude's and Gemini's say the same). Such a reply now ends after about 62 MB, in 0.4 s, with
  165 MB more memory. 0.5.0 had no cap: it grew one string with the event, and searched all of it
  again for each piece that came (see the next point). On main (5157e7f), whose parser did the
  same, an event without an end grew a string until it failed, with 600 to 740 MB more memory, or
  ran the heap out of memory. A reply made of many events, and a reply that is not streamed, have
  no cap yet.
- **`parseSseJson` reads each piece of a body once.** One event of 8 MB in pieces of 16 KB took
  0.97 to 1.19 s with 0.5.0; it now takes 10 to 20 ms (ten runs each, Node 24, Windows). See
  [Measurements](docs/measurements.md#the-server).
- **OpenAI-compatible: an error whose message is at the top of the body is read** (`message`
  from vLLM before its OpenAI-shaped errors, SGLang and FastChat; `detail` from servers built on
  FastAPI). A request too large for the model failed with "The model returned HTTP 400."; it now
  carries the server's message, with kind `"context_overflow"`, and is made smaller (see
  **Changed**).
- **OpenAI-compatible: a streamed reply keeps its `refusal`, and OpenRouter's `reasoning` and
  `reasoning_details`** (the thought signature of a Gemini 3 model behind OpenRouter).
- **OpenAI-compatible: a server that sends the name of a tool call again with each piece** no
  longer makes it `search_documentsearch_document`, an unknown tool.
- **OpenAI-compatible: a call whose arguments are empty or not JSON goes back as `"{}"`.** vLLM
  before 0.29 refused the next request (HTTP 400).
- **OpenAI-compatible: part reads send `max_completion_tokens` to every Azure OpenAI host.** When
  `maxTokensField` is not set, a server that refuses the name it was sent (HTTP 400 naming it) is
  sent the other, and the adapter keeps it.
- **OpenAI-compatible: two user turns in a row are sent as one.** DeepSeek's reasoner and the chat
  templates of Mistral and Gemma models refuse them.
- **Claude: an empty text block is not sent back** ("text content blocks must be non-empty"),
  unless a thinking block follows it in the turn.
- **Claude: calls of other providers and of earlier questions get IDs the API takes**, each once
  in a request: Kimi's `functions.search:0` becomes `functions_search_0`.

Retries:

- **`retries: NaN` no longer sends a failing request again without end.** A `NaN`, such as
  `Number(process.env.RETRIES)` with the variable unset, never ran out: a request that kept failing
  with status 0, 408, 409, 429 or 5xx was sent again until the signal aborted. A `baseDelayMs` or
  `maxDelayMs` of `NaN` cut the waits to about 1 ms. Each now takes its default.

Packaging:

- **npm installs llm-large-files next to unpdf 2** (`^1.4.0 || ^2.0.0`; unpdf 2 asks for Node
  24). With 0.5.0, an app that already had unpdf 2 could not install llm-large-files: npm stopped
  with `ERESOLVE`. The 12 PDFs of the tests give the same text, pages, picture marks and page cuts
  with every unpdf from 1.4.0 to 2.2.1, and CI runs the tests with unpdf 1.7.0 on Node 20, the
  newest 1.x on Node 22 and 24, and the newest 2.x on Node 24.

## 0.5.0 and earlier

Versions 0.1.0 to 0.5.0 are recorded in the
[full history up to 0.5.0](https://github.com/renanbazinin/llm-large-files/blob/v0.5.0/CHANGELOG.md).
Each of them but 0.1.0 is a [tag of the repository](https://github.com/renanbazinin/llm-large-files/tags);
from 0.6.0 on, each release is also on the
[GitHub releases page](https://github.com/renanbazinin/llm-large-files/releases).
