# Changelog

What changed in each version of `llm-large-files`, for the developers who use it. Each version
says what you need to change when you upgrade, what you can add, what works differently, and what
was fixed. Versions follow [semantic versioning](https://semver.org). While the version is 0.x, a
minor version (0.5 to 0.6) may need changes in your code or settings: the **Upgrading** part of
each version says which, and it is there even when the answer is "nothing".

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

## 0.6.1 — not released yet

Uploads built to hurt the server are refused, and a large upload no longer holds the server while
it is read. Ingest now pauses for other requests between the pages of a PDF and between slices of
its own work, limits the text, the pages and the time one file may take, and refuses a PDF page
built to hold the server before pdf.js reads it. `files.tools()` checks the owner of each document
it reads. These are fixes from a review of how 0.6.0 handles hostile files.

### Upgrading: what you need to change

Code written for 0.6.0 compiles with 0.6.1 as it is. Every change to the public types is an
addition: three options of `createLargeFiles`, one of `createPdfExtractor`, `IngestInput.signal`,
three fields of `ExtractInput`, and two constants.

Some behavior is different. Check each point against your app:

- **Uploads past the new limits are refused.** `files.ingest` throws, and
  `createDocumentHandlers` answers 422 with the message:
  - a PDF of more than `maxPdfPages` pages (5,000 by default), before any page is read:
    `This PDF has 6,200 pages, more than the 5,000 read from one file. Split it, and attach the part you need.`
  - a file whose text takes more than `maxTextBytes` in UTF-8 (by default `maxUploadBytes`,
    100 MB): `This PDF holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.`,
    or for a text file `notes.txt holds more than 100 MB of text, …` with the same end. A file's
    text can be larger than the file: a UTF-16 file of Chinese or Japanese text grows by half in
    UTF-8, and a small PDF can draw far more text than its size.
  - a DOCX or PPTX of more than 32 million characters of text (about 10,000 dense pages), whatever
    `maxTextBytes` allows:
    `This DOCX holds more than 32 million characters of text, more than is read from one file. Split it, and attach the part you need.`
  - a PDF that draws more than 100 times its size in text, past the first 16 MB:
    `This PDF draws more than 16 MB of text, over 100 times its size. A file that grows that much is not read: it may be built to exhaust the server.`
    A page that paints a form inside a form, many times over, draws the text of the innermost one
    each time. Real PDFs hold less text than their size.
  - files that no program writes, built to exhaust the server: a PDF whose page tree lists one
    page more than once, and a DOCX or PPTX with paragraphs nested more than 32 deep, more than
    1,000,000 paragraphs with text, or more than 20,000 parts.
  - with `@cantoo/pdf-lib` installed, a PDF with a page whose text would take pdf.js far longer to
    read than its file explains, found before pdf.js reads any page: past about 1 to 1.5 s of
    pdf.js, or 32 times the size of the file in content when that is more, counting each form
    every time it is painted and the glyph programs of the Type3 fonts the page sets
    ([Pages that would hold the server](docs/guides/pdfs.md#pages-that-would-hold-the-server)):
    `Page 1 of this PDF draws far more than its file holds, and reading it would hold the server for a long time. A file built that way is not read: it may be built to exhaust the server. Print it to a new PDF, and attach that.`
    Pages that are each within that, but add up to more than four times as much:
    `This PDF draws far more than its file holds, …` with the same end. A page whose content is
    stored in a way that cannot be decoded first (a filter that only images use, such as JPEG):
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
- **If you copied the ingest worker of the 0.6.0 deployment guide, its memory limit did not
  hold.** A `--max-old-space-size` of the process, on the command line or in `NODE_OPTIONS` (as
  that guide set it), replaces a worker's `resourceLimits.maxOldGenerationSizeMb`: the worker given
  512 MB had 1,216 MB. And a worker that runs out of memory can stop the whole process.
  **What to do:** ingest untrusted uploads in a child process with its own
  `--max-old-space-size`, as [Deployment](docs/guides/deployment.md#uploads-and-ingest) now shows
  (`ingestInProcess`, which replaces `ingestInWorker`), or in a service of its own.
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
- **`view_pages` and picture marks pause more often.** `@cantoo/pdf-lib` now parses 500 objects
  between two pauses for other requests, not 4,000: in 0.6.0, 4,000 objects of a large file took
  0.5 to 0.8 s, and a file of fewer than about 4,000 objects never paused. A file of more than
  50,000 objects parses more between two pauses (up to 4,000), so that it pauses about 100 times
  at most: each pause is a timer, about 15 ms on Windows. The work is the same; on a busy server,
  a look at pages waits more often for the other requests.
  **What to do:** nothing.
- **One page of a PDF still holds the server while pdf.js reads it.** Between two pages, the PDF
  extractor lets other requests run and looks at the time limit and the signal. Within a page it
  cannot: pdf.js gives no way to stop a page, and does all of it without letting a timer run.
  Neither `ingestTimeoutMs` nor `IngestInput.signal` cuts a page short. The page check (above)
  refuses the pages that would take far longer than their file explains: forms painted inside
  forms, content packed hundreds of times, Type3 glyphs that paint either. What it leaves:
  - a page that passes holds the server for up to about 1.5 s in a small file, and longer in a
    large one: a page of a 10 MB file may run 320 MB of content, about a minute of pdf.js;
  - without `@cantoo/pdf-lib`, on a file it cannot read or that declares more than 150,000
    objects, and with `checkPages: false`, no page is checked: a 3 KB page of forms inside forms
    held the event loop for 13 s, and one of 4 KB for about 100 s;
  - a file built to be read one way by `@cantoo/pdf-lib` and another way by pdf.js passes it.

  Likewise, a DOCX or PPTX packed hundreds of times tighter than documents are holds it for about
  0.2 s at a time while JSZip unpacks a piece; a 4 MB DOCX written the usual way, with 32 MB of
  XML, never held it for 30 ms.
  **What to do:** if your users can upload files you do not trust, ingest them in a child process
  of their own, as [Deployment](docs/guides/deployment.md#uploads-and-ingest) shows, so that only
  that process waits, and its time limit stops it.

### New: what you can add

- **`maxTextBytes`**: the most text kept from one file, in UTF-8 bytes. Defaults to
  `maxUploadBytes`. The PDF, DOCX and PPTX extractors refuse a file as soon as its text passes it
  (a PDF page by page), and `ingest` refuses a larger text from any other extractor, yours
  included. See [`LargeFilesOptions`](docs/reference/library.md#largefilesoptions).
- **`maxPdfPages`**: the most pages read from one PDF. Defaults to `DEFAULT_MAX_PDF_PAGES`, 5,000.
  A PDF with more is refused before any page is read.
- **`ingestTimeoutMs`**: the most time one `ingest` may take. Defaults to
  `DEFAULT_INGEST_TIMEOUT_MS`, 120,000 (2 minutes); 0 sets no limit, and so does a value past
  what a timer can wait (2,147,483,647 ms, 24.8 days).
- **`IngestInput.signal`**: stops an ingest, for example when the uploader goes away. `ingest`
  throws the signal's `reason` and stores nothing. The PDF, DOCX and PPTX extractors stop between
  pages and pieces. `createDocumentHandlers` passes one that aborts when the client closes the
  connection. See [`IngestInput`](docs/reference/library.md#ingestinput).
- **`ExtractInput.signal`, `ExtractInput.maxTextBytes` and `ExtractInput.maxPages`**: the signal
  of the ingest (aborted at `ingestTimeoutMs` or by `IngestInput.signal`) and the two limits, for
  an extractor of your own to honour. See
  [Custom extractors](docs/guides/pdfs.md#custom-extractors).
- **`DEFAULT_MAX_PDF_PAGES`** (5,000) and **`DEFAULT_INGEST_TIMEOUT_MS`** (120,000): the defaults
  above, exported. See [the library reference](docs/reference/library.md#default_max_pdf_pages).
- **`createPdfExtractor({ checkPages: false })`** turns the page check off. With
  `pictures: false` too, PDFs are not read with `@cantoo/pdf-lib` at ingest. See
  [`PdfExtractorOptions`](docs/reference/library.md#pdfextractoroptions).

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
  return files.ingest({ name, bytes, owner, signal: uploaderLeft.signal });
}
```

### Changed: what works differently

Besides the points under **Upgrading**:

- **Ingest lets other requests run while it reads a file.** Each step works in slices of about
  12 ms, with a pause for other requests between two slices: the PDF extractor between pages, the
  DOCX and PPTX extractors as they unpack, and then `ingest` as it cleans the text, measures it,
  and builds the outline, the log profile and the line index. Ingests that run at once take turns,
  one slice each. Picture marks pause every 12 ms between pages, and their limit of 5 s counts only
  the work, not the pauses.
- **`createDocumentHandlers` stops reading an upload when the client goes away.** Its upload
  handler passes `IngestInput.signal`, aborted when the connection closes before the answer is
  sent: nothing is stored.
- **DOCX and PPTX take memory by their text, not by their XML.** Each paragraph becomes one string
  when it closes, and an empty paragraph is dropped. Text is counted as it reads, not as the XML
  writes it (`&amp;` is one character). An Office file whose ZIP directory lists more than 20,000
  parts (a ZIP64 directory included) is refused before JSZip reads it.
- **`ingest` stops waiting for an extractor** when the ingest's signal aborts (`ingestTimeoutMs`,
  or `IngestInput.signal`), whether or not the extractor looks at the signal.
- **A PDF is read with `@cantoo/pdf-lib` once, before its text.** When it is installed, the PDF
  extractor reads the file into objects before pdf.js reads any page, for the page check and the
  picture marks together; 0.6.0 read it after the text, for the marks only. With
  `pictures: false`, the file is now read too, for the check, unless `checkPages: false`.
  With picture marks on (the default), that costs nothing measurable: PDFs of 300 to 2,000 pages
  took the same time within the spread of three runs, and the longest stall did not grow. With
  `pictures: false`, the reading is new: 0.1 to 0.3 s more for 300 to 2,000 pages, and up to
  90 MB more memory at the peak. The first PDF of a process now loads `@cantoo/pdf-lib` even with
  `pictures: false`, in one block of about 0.4 s, unless the server loads it when it starts
  ([Deployment](docs/guides/deployment.md#uploads-and-ingest)). See
  [Measurements](docs/measurements.md#the-server).
- **A text without a line over 2,000 characters is not split and joined again** at ingest, a
  text that needs no cleaning is not copied, and a text file is taken for a log from its first 200
  non-empty lines without going through the rest. An ingest of a 99 MB log takes 1.9 s, as with
  0.6.0, now in slices. The stored text, outline, profile and index are the same as 0.6.0 made.

### Fixed

Uploads you do not trust:

- **A DOCX of 1.5 MB no longer stops a server with a heap of 512 MB.** It held 120 MB of empty
  paragraphs, each of which 0.6.0 kept until the end of the file: the process ran out of memory
  and stopped, and every answer streaming on it with it. The same file is now refused
  ("padded.docx did not contain any text.") in 3.0 to 3.2 s, with the process at 115 MB. A DOCX
  of 3 MB that unpacks to 1,000 MB of XML, which stopped the same server, is refused at its
  millionth paragraph in 0.9 s, at 165 MB.
- **A PDF of 3 KB no longer stores 107 MB of text.** Its page tree listed one dense page 150
  times, and each listing gave the text of the page again. A page tree that lists a page twice is
  now refused, in under 0.3 s.
- **A PDF of 6 KB no longer freezes the server for 205 s.** The same kind of file, with 600
  listings, held the event loop for 205 s with a heap of 1.5 GB, and ran a heap of 512 MB out of
  memory. It is refused in under 0.3 s.
- **A PDF of 23 KB no longer stores 99.5 MB of text.** Its 140 pages all paint one dense content
  stream: they add up to far more than the file holds, and it is now refused before pdf.js reads a
  page, in under 0.03 s. Without `@cantoo/pdf-lib`, it is refused at 16 MB of text, in under 6 s.
- **A PDF of 3 KB no longer holds the server for 13 s, nor one of 4 KB for about 100 s.** The page
  of each paints a form that paints the next one 50 (or 100) times, three levels deep, and the
  last one shows a line of text: 125,000 (or 1,000,000) runs of a form for pdf.js, in one block.
  The second was refused only once read, for its 16 MB of text. With `@cantoo/pdf-lib` installed,
  both are refused before pdf.js reads them, in under 0.03 s, with the process at 70 MB, where the
  first took 350 to 380 MB. Files of 2 to 21 KB built the same way, 2 to 6 levels deep, held it
  for 17 s to 2 minutes, and are refused as fast.
- **A PDF of 650 KB no longer holds the server for 23 to 29 s.** Its one page runs 160 MB of text
  operators, packed 250 times. It is refused in 0.05 s. One of 160 KB, whose three pages each run
  40 MB, held it for 6 to 14 s at a time; it is refused in 0.03 s.
- **Forms that all paint each other, and content stored with a predictor, no longer hold the
  server.** Eight forms of a 3 KB file that each paint all eight held the event loop for 6 s, and
  forms inside forms painted from content that only pdf.js could decode (a predictor, which
  `@cantoo/pdf-lib` does not undo) for 10 s. Both are refused in under 0.05 s. Two forms that
  paint each other are read, as pdf.js reads them.
- **A PDF of 25 KB no longer keeps pdf.js busy for 38 s.** Its 60 pages all show one stream of
  4 MB, and each page held the event loop for 1.3 s. Its pages add up to far more than the file
  holds: it is refused in 0.04 s.
- **A Type3 font no longer holds the server while a page loads it.** pdf.js runs every glyph
  program of a Type3 font when a page sets it: a 3 KB file whose one glyph paints a form 390,000
  times, through forms inside forms, held the event loop for 9 s, at 730 MB. It is refused in
  under 0.02 s.
- **A large upload no longer holds the server while it is read.** In the review, a 100 MB log held
  the event loop for 3.5 s, and a 2,000-page PDF for 8.3 s: every answer streaming on that server
  stopped for that long. Measured again on one machine (Node 24, Windows), 0.6.0 and 0.6.1 in
  turn, three times each, the longest gap of a 5 ms timer during the ingest of a 99 MB log went
  from 1.9 to 2.0 s down to 31 to 34 ms, and of a 2,000-page PDF from 4.4 to 4.5 s down to 0.16 s.
  The log took 1.9 s to ingest either way; the PDF 4.9 to 5.0 s, against 4.6 to 4.9 s.
- **An ingest has a time limit.** In 0.6.0 nothing bounded it: a file that is slow to read held
  its upload, and its share of the server, for as long as it took (see **Upgrading**).

Access:

- **`files.tools()` checks the owner of each document it reads.** In 0.6.0, a loop of your own
  that built a `DocumentMeta` from an ID a client sent could read the text of another owner's
  document through the tools, and show the pages of its PDF: `tools()` checked only that the
  document was still there. It was so in every version before.

## 0.6.0 — not released yet

Questions fail less often, and when one fails, you can tell why and keep what it found. Every
model error now has a kind, a request too large for the model is made smaller and sent again, a
model that goes silent is stopped after a wait, an empty or broken turn is asked for again, and a
call whose result is still in the conversation is not run twice. The rest are fixes from a review
of 0.5.0, in the tool loop, whole-file reads and the three adapters.

### Upgrading: what you need to change

Code written for 0.5.0 compiles with 0.6.0 as it is, but for one case. The turns of
`geminiFunctionResponses` and `geminiFunctionResponseTurns` now have `GeminiPart[]` parts, where
they had `unknown[]` (see **Changed**). Code that adds to those `parts` a string, or a value typed
`unknown`, `object` or by an interface (another SDK's `Part`), no longer compiles. Add an object
literal, or `{ ...part }`. Every other change to the public types is an addition: new exports, new
fields, new optional options, and wider parameter types. One member is marked deprecated:
`ModelAdapter.estimateTokens` (see **Your own adapter** below).

Some behavior is different. Check each point against your app:

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
  [Errors and reliability](docs/guides/errors-and-reliability.md) and
  [Deployment](docs/guides/deployment.md).
- **A reply cut off on its way can fail a question after its text was shown.** A stream that
  closes without saying why it ended, or DeepSeek's `insufficient_system_resource`, is no longer
  taken for a whole reply (see **Fixed**). It is sent again when none of it was shown. When some
  of it was already streamed to the user, the question throws at once: a `ModelRequestError` with
  status 0 and kind `"unreachable"` ("Gemini's reply ended before it was complete."), or status
  503 and kind `"server"` for DeepSeek. In 0.5.0 the cut text was returned as the answer.
  **What to do:** if you stream with `onText`, handle an error that comes after part of the
  answer was shown: mark that text as incomplete and offer to ask again. `partialResultOf(error)`
  has what the question found.
- **Quota errors are no longer sent again.** OpenAI's `insufficient_quota`, and a Gemini quota per
  day (HTTP 429 whose `details` name a per-day quota), now have `kind: "quota"` and are thrown at
  once, where 0.5.0 tried three more times (the default of `retry.retries`). A Gemini quota per
  minute is `"rate_limit"`, and is waited for as before.
  **What to do:** if you show "busy, try again" for every HTTP 429, show another message for
  `"quota"`, and tell whoever runs the service: trying again soon does not help.
- **`anthropicToolTurns` and `openAiToolTurns` give a call without an ID a random one**
  (`toolu_` or `call_` and 24 hex characters). Gemini's calls, for one, may come without an ID.
  0.5.0 numbered them from 1 on each call (`toolu_1_1`), so the stored rounds of two questions had
  the same IDs, which Claude's Messages API refuses. A call that came with an ID keeps it. In
  `anthropicToolTurns`, an ID the API would refuse is changed (see **Fixed**, Claude).
  **What to do:** nothing, unless you compare these IDs, or convert the same tool turns again for
  each request: each conversion now gives new IDs. Convert once and store the messages when you
  need the same IDs every time. See [Conversations](docs/guides/conversations.md).
- **The tool guide changed, so the provider's prompt cache misses once.** The system instruction
  of a question with tools now sends counting and listing to exact search (see **Changed**). With
  `wholeDocumentAnalysis: false`, or a model that explores without `generateText`, the cards
  change too, and the guide no longer names `analyze_whole_document`. The first request of each
  conversation after the upgrade misses the cache, so its input costs what it costs without one.
  **What to do:** nothing.
- **A second try costs a request and a tool turn.** When the model's first reply is empty, or it
  wrote a tool call that could not be read, the loop asks once more, at most twice a question
  (see **Changed**). Each second try is a chat request: it counts toward `limits.requests` and
  takes a turn of `limits.toolTurns`. It is only made while the answer's request is still left,
  so the question still ends with an answer, but with one tool turn fewer.
  **What to do:** if you set `limits.requests` or `limits.toolTurns` close to what a question
  needs, add two. See [Costs and limits](docs/guides/costs-and-limits.md).
- **A repeated call is answered with a pointer.** A call whose result is still in the
  conversation in full is not run again (see **Changed**). Its step reads
  "Search app.log (exact) for “timeout” — already shown above", its result in `toolTurns` has
  `already_shown: true` and a note, and it adds no entry to `evidence`. New steps also say when a
  turn was asked for again, or a request was made smaller, such as "The model's first reply was
  empty: it was asked again".
  **What to do:** if you parse `steps` or the lines of `onStep`, or expect one `evidence` entry
  per call, allow for these.
- **Your own adapter (optional).** An adapter written for 0.5.0 works as before. To get the new
  recovery, set `ModelReply.finish` (`"malformed_call"` lets the loop ask again for a call that
  could not be read), and throw a `ModelRequestError` from `send` and `generateText`. Its `kind`
  is told from the status and the message, or you pass it: `"context_overflow"` makes the request
  smaller (and a part read in halves), `"timeout"` with status 0 is sent again once, and
  `"quota"` is not sent again. In your own loop, `withRetry` follows the same rules: an error of
  kind `"quota"` is thrown at once, and one of kind `"timeout"` with status 0 is sent again once
  (not at all when `retry.retries` is 0). `ModelAdapter.estimateTokens` is now deprecated: the
  library never called it, and a later version may remove it. An adapter that declares it still
  compiles; leave it out, and set `capabilities.tokenScale` for a tokenizer that counts
  differently from the library's estimate. See
  [Your own adapter or loop](docs/guides/own-adapter-and-loop.md).
- **`parseSseJson` takes hooks and Node streams.** `parseSseJson(stream, hooks?)` also reads the
  body of node-fetch, and takes `{ onData, onDone, signal }`. Calls written for 0.5.0 work as
  before.
- **An upload whose store fails while it writes is answered 500, not 422.** When `put`,
  `putOriginal` or `putIndex` throws an error that has no `status` or `statusCode` from 400 to 599
  and is not a Node system error, `createDocumentHandlers` answers 500
  `{ "error": "Upload failed." }`. It answered 422 with the error's own message, which may name a
  database host (see **Fixed**). A thrown value that is not an `Error` also gets 500 "Upload
  failed.", where it was 422 with the value as text. Errors with a status, Node system errors (an
  `Error` or not) and files that cannot be read are answered as before.
  **What to do:** for a more specific answer, throw your store's write errors with a `status` and
  a message of your own (a 503 that says to try again), and log the cause in your store: the
  handlers log nothing. Two paths still answer a store's error 422 with its message: an `ingest` of
  your own that throws a new error in its place, as `ingestInWorker` in
  [Deployment](docs/guides/deployment.md#uploads-and-ingest) does, and a route of your own, as in
  [Web app](docs/guides/web-app.md#filesingest-and-its-errors). A status on the error avoids it.
  See the [node reference](docs/reference/node.md#uploadrequest-response).
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

### New: what you can add

The samples assume what your app already has: `files` from `createLargeFiles()`, `endpoint` from
`vertexAi()`, and the `documentIds` and `question` of the chat.

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
  [Errors and reliability](docs/guides/errors-and-reliability.md) and
  [Errors, retries and streams](docs/reference/errors-and-retries.md).

  ```ts
  import { errorKindOf, ModelRequestError } from "llm-large-files";
  import { askGemini } from "llm-large-files/gemini";

  try {
    const result = await askGemini({ files, endpoint, documentIds, messages: [{ role: "user", text: question }] });
    console.log(result.text);
  } catch (error) {
    const kind = errorKindOf(error);
    if (kind === "quota") console.log("The model's quota is used up. Try again later.");
    else if (kind === "timeout" || kind === "rate_limit") console.log("The model did not answer. Try again in a minute.");
    else if (error instanceof ModelRequestError && kind === "context_overflow") console.warn(error.requestedTokens, error.limitTokens);
    else throw error; // another kind, or not a model error (a missing document, a bug)
  }
  ```

  What to show for each kind: [Errors and reliability](docs/guides/errors-and-reliability.md).

  ```ts
  import { classifyModelError } from "llm-large-files";

  classifyModelError(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.");
  // { kind: "context_overflow", limitTokens: 128000, requestedTokens: 130512 }
  ```

- **What a failed question found: `partialResultOf(error)`.** The question still throws the
  provider's error. `partialResultOf(error)` gives what it had done until then, as an `AskResult`
  with `answered: false`: its steps, evidence, tool rounds and usage. It is undefined for an error
  thrown before the question started (a document that is missing). Exported from
  `llm-large-files` and `llm-large-files/gemini`. See
  [The tool loop and the adapter contract](docs/reference/ask.md).

  ```ts
  import { partialResultOf } from "llm-large-files";
  import { askGemini } from "llm-large-files/gemini";

  try {
    const result = await askGemini({ files, endpoint, documentIds, messages: [{ role: "user", text: question }] });
    console.log(result.text);
  } catch (error) {
    const partial = partialResultOf(error);
    if (partial) {
      // Not an answer, but paid for: count its usage, and keep its tool rounds if you store them.
      console.log(partial.usage.requests, partial.usage.inputTokens, partial.usage.outputTokens);
      console.log(partial.steps.join("\n"), partial.toolTurns.length);
    }
    throw error;
  }
  ```

- **Waits on a silent model: `firstByteTimeoutMs` and `idleTimeoutMs`**, on `askGemini`,
  `gemini()`, `openAiCompatible()` and `anthropic()`. The defaults are the new exports
  `DEFAULT_FIRST_BYTE_TIMEOUT_MS` (600,000) and `DEFAULT_IDLE_TIMEOUT_MS` (300,000); the type
  `IdleWaits` holds the two options. See
  [Errors and reliability](docs/guides/errors-and-reliability.md).

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

- **`ModelReply.finish`**: how a reply ended, in terms every adapter maps its own to:
  `"complete"`, `"cut"` (at the output limit, or Claude's full window), `"filtered"` (by the
  provider's safety filters) or `"malformed_call"` (a tool call that could not be read: Gemini's
  `MALFORMED_FUNCTION_CALL` and `UNEXPECTED_TOOL_CALL`). The three adapters set it. See [The tool loop and the adapter contract](docs/reference/ask.md).
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
  included), `onDone` (`data: [DONE]` arrived) and `signal`. See
  [Errors, retries and streams](docs/reference/errors-and-retries.md).
- **`RetryNotice`**: the type of what `withRetry` passes to `onRetry`: `error`, `attempt` (the
  number of the retry to come) and `delayMs` (the wait). 0.5.0 passed the same notice but did not
  export its type. See
  [Errors, retries and streams](docs/reference/errors-and-retries.md#retrynotice).
- **`OpenAiRequestError.param` and `.code`**: the server's `error.param` (`"max_tokens"`) and
  `error.code` (`"unsupported_parameter"`). See [`llm-large-files/openai`](docs/reference/openai.md).

### Changed: what works differently

Besides the points under **Upgrading**:

- **A request too large for the model is made smaller and sent again**, where it failed the
  question. The loop takes the provider's count and window for the rest of the question,
  replaces older tool results with short stand-ins (the latest round too, if it must), and sends
  the request again, at most twice a question. When the first requests are too large before any
  tool ran, the documents are planned again, once, for a smaller window: the one the provider
  named, made smaller by as much as its count of the request passed the library's estimate (by a
  fifth when it gives no count). When it names none, it is 7/10 of the window assumed, made
  smaller the same way when the provider gave a count; and when the result is not smaller than the
  window assumed, it is 7/10 of the window assumed. Vertex AI's message names 1,048,576 tokens
  and no count: with the default window of 1,000,000, the documents are planned for 838,860. What the
  first try paid for, and the tool turns it took, are counted. When Claude is one of the models,
  nothing is shortened (its conversation may only grow), so only the second plan applies. See
  [How it works](docs/how-it-works.md).
- **An empty first reply, or a tool call that could not be read** (Gemini's
  `MALFORMED_FUNCTION_CALL` or `UNEXPECTED_TOOL_CALL`), **is asked for once more** with a short note, at most twice a
  question. Before, the answer was written from the document cards alone, and looked like any
  other. The note is not kept in the conversation, except when the model that explores is Claude,
  and an answering model other than the explorer never gets it.
- **A call whose result is still in the conversation in full is not run again**: the same search,
  the same read, the same overview, a read of lines inside one that is shown, in this question or
  in the stored tool rounds of an earlier one. The model gets a pointer to that result. A result
  of an earlier turn that failed, was cut to its room, was replaced by a stand-in, or came from a
  search that stopped early is not pointed to. The same search, read or overview made twice in
  one turn is not run twice: the second is pointed to the first. Live on Vertex AI, a follow-up
  that repeated its first search got the pointer and answered from the result.
- **Two searches in a row that failed in the same mode** get a hint added to the error: after two
  regex searches, to try exact or keywords mode; after two of another mode, to check the arguments
  or answer from what the model has.
- **An unknown `document_id`** is answered with the IDs the model may use, and their file names
  (up to 20).
- **The tool guide sends counting and listing to exact search.** It sent "every occurrence" to
  `analyze_whole_document`, which missed items in our live tests (492 of 1,200; 91 of 120), while
  `search_document` in exact or regex mode gives an exact `total_matching_lines`. The whole-file
  read is now for what needs meaning: a summary, a timeline, items judged one by one. See
  [Tools](docs/reference/tools.md).
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
- **`geminiFunctionResponses` returns a `GeminiContent & { role: "user" }`, and
  `geminiFunctionResponseTurns` an array of them**, which go into a `GeminiContent[]` without a
  cast. Their parts were typed `unknown[]` (see **Upgrading**). See
  [`llm-large-files/gemini`](docs/reference/gemini.md#geminifunctionresponsescalls).

### Fixed

The tool loop:

- **The calls of a turn share the room that is left.** Each call took its whole cap
  (`toolResultCharacters`, or at least 40,000 characters for a whole-file read) in call order, so
  the first calls could take all the room and the next were told "no room left, answer now". On
  Claude with a window of 64,000 tokens, four searches of about 300 characters each, after four
  rounds of reads, ran three and forced the answer. The room is now shared evenly, and only calls
  that cannot each get 1,500 characters are refused. The answer of a whole-file read gets all the
  room the other results of its turn leave.
- **Whole-file reads in one turn are counted together** against `limits.requests` and
  `limits.inputTokens`. Each was checked alone, so two reads that each fit passed the ceiling
  together: 16 requests against a ceiling of 11 in a probe. The input tokens of a read are now
  counted by the `tokenScale` of the model that reads its parts, not by the largest scale of the
  question, which refused reads that fit.
- **The provider's count of a request is read by the `tokenScale` of the model that gave it**,
  not by the largest scale of the question. With a Gemini explorer and Claude answering, the
  request for the answer came to 66,000 tokens of Claude's window of 60,000.
- **Part reads of a `generateText` that does not call `onUsage` count toward `limits.requests`**
  and `usage.requests`. They were left out.
- **The request for an answer after no tool ran is `FINAL_ANSWER_WITHOUT_TOOLS`**, also when the
  first reply was empty or `limits.toolTurns` left no turn for tools. It said "using only what
  the tools returned above".
- **Text that is cut is no longer cut inside an emoji** (a character outside the basic plane),
  which JSON writes as `\ud83d` and Claude's API refuses: results, search lines, stand-ins, the
  first lines of a card, and log templates of documents ingested from now on.

Whole-file reads:

- **A read whose last step failed returns the notes of its parts**, with `notes_only: true`,
  instead of an error that lost every part already paid for.
- **A model that asks again for a read that could read no part is told that it failed, and why.**
  It was told to "use the answer of that read", which there was not. A read that failed before any model request
  (a store that could not be read) is not counted, so the model can make it again.
- **A long answer is cut at its end**, with `answer_shortened`, and the other fields
  (`parts_read`, the notes on what is incomplete) are kept. It was cut as JSON, which dropped them.
- **A part that could not be read from storage no longer shows the model the server's file
  path.** Its note, and the error of a read that read no part, give only the error code ("The
  file could not be read from storage (EACCES)"), as the other tools do.

The adapters:

- **All three: a connection that failed while the body of a reply arrived is sent again**, like
  one that failed before the reply. In 0.5.0 a chat reply that came in one piece, not streamed,
  was not. A body that came whole but is not JSON (a gateway's HTML page) is not sent again; a
  part read tries it once more.
- **OpenAI-compatible: an error inside a stream is taken for the server's** (HTTP 500 unless it
  names another), and sent again when none of its text was shown. It was taken for HTTP 200 and
  never sent again.
- **OpenAI-compatible: a streamed reply keeps its `refusal`, and OpenRouter's `reasoning` and
  `reasoning_details`**, which hold the thought signature of a Gemini 3 model behind OpenRouter.
  A refusal was lost, so the question was not answered.
- **OpenAI-compatible: a call whose arguments are empty or not JSON goes back as `"{}"`.** vLLM
  before 0.29 refused the next request (HTTP 400).
- **OpenAI-compatible: part reads send `max_completion_tokens` to every Azure OpenAI host**
  (`*.openai.azure.com`, and the `/openai/` paths of `*.cognitiveservices.azure.com` and
  `*.services.ai.azure.com`). When `maxTokensField` is not set, a server that refuses the name it
  was sent (HTTP 400 naming it) is sent the other, and the adapter keeps it.
- **OpenAI-compatible: two user turns in a row are sent as one.** DeepSeek's reasoner and the chat
  templates of Mistral and Gemma models refuse them.
- **Claude: a stream that ended without saying why (no `stop_reason`) is not taken for a whole
  reply.** A gateway that ended it early made a cut answer count as answered; it is now sent
  again when none of it was shown. A call whose block was never closed is answered "send it
  again", not run with no arguments.
- **Claude: an empty text block is not sent back** ("text content blocks must be non-empty"),
  unless a thinking block follows it in the turn.
- **Claude: calls of other providers and of earlier questions get IDs the API takes**, each once
  in a request: Kimi's `functions.search:0` becomes `functions_search_0`, and the second of two
  stored rounds numbered alike gets a suffix.

Replies cut off on their way:

- **A stream that closes without saying why it ended is not taken for a whole reply**: Gemini's
  last chunk has a `finishReason`, and an OpenAI-compatible stream a `finish_reason` or `[DONE]`.
  A proxy or a dropped connection made a cut answer, or a cut turn of tool calls, count as whole.
  It is sent again when none of it was shown (see **Upgrading** for when some was).
- **DeepSeek's `insufficient_system_resource`** is the server's failure (HTTP 503), and is sent
  again when none of the reply was shown. It was taken for a whole reply.
- **A streamed reply through a `fetch` whose body is a Node stream** (node-fetch) failed with
  "stream.getReader is not a function". Both kinds of body are read.

Retries:

- **`retries: NaN` no longer sends a failing request again without end.** A `NaN`, such as
  `Number(process.env.RETRIES)` with the variable unset, never ran out: in `askWithFiles`,
  `askGemini`, `files.tools()` and `withRetry`, a request that kept failing with status 0, 408,
  409, 429 or 5xx was sent again until the signal aborted. A `baseDelayMs` or `maxDelayMs` of
  `NaN` cut the waits the library works out to about 1 ms, and a `maxDelayMs` of `NaN` took any
  wait the provider asked for. Each now takes its default. It was so in 0.5.0.

Ingest:

- **An outline of 20 to 399 top-level headings keeps each of them once, in order.** In a document
  of more than 400 headings, such an outline took its entries from the first headings only, some
  more than once: with 20 top-level headings, the first one 20 times; with 100, the first 25, four
  times each; with 300, the first 225. It was so in 0.5.0 and every version before. This applies
  to documents ingested from now on: ingest a document again to rebuild its outline.

Uploads:

- **The upload handler no longer sends a store's own error message to the browser.** When a
  store failed to write a document with an error that has no `status` or `statusCode` from 400 to
  599 and is not a Node system error, `createDocumentHandlers` answered 422 with the store's
  message, which may name a database host. It now answers 500 "Upload failed." (see
  **Upgrading**). It was so in 0.5.0 and every version before.

## Before 0.6.0

Versions 0.1.0 to 0.5.0 are recorded in the
[full history up to 0.5.0](https://github.com/renanbazinin/llm-large-files/blob/v0.5.0/CHANGELOG.md).
Each of them but 0.1.0 is a [tag of the repository](https://github.com/renanbazinin/llm-large-files/tags);
from 0.6.0 on, each release is also on the
[GitHub releases page](https://github.com/renanbazinin/llm-large-files/releases).
