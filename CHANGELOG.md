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
  [Hidden text in Word and PowerPoint](docs/security.md#hidden-text-in-word-and-powerpoint).
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
