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
it is read: ingest pauses for other requests, limits the text, the pages and the time one file may
take, and refuses a PDF page built to hold the server before pdf.js reads it. A PDF built with
objects or streams far larger in memory than in the file can still run the server out of memory:
ingest files you do not trust in a process with a memory limit of its own. `files.tools()` checks the owner of each
document it reads, a search shows the last matching line, and a text file saved in an older
encoding, such as a Hebrew CSV from Excel, is read in that encoding. The rest are
fixes from a review of 0.6.0: in the adapters, the tool loop, the text the model is sent, and the
data that 0.5.0 and 0.6.0 stored.

### Upgrading: what you need to change

Code written for 0.6.0 compiles with 0.6.1 as it is. Every change to the public types is an
addition: three options of `createLargeFiles`, one of `createPdfExtractor`, `IngestInput.signal`,
three fields of `ExtractInput`, two constants, two fields (`encoding` and `replacedCharacters`) of
`DocumentMeta`, `DocumentSummary` and `ExtractedText`, `ModelCapabilities.clearsToolResults`, and
`SseHooks.maxEventLength`.

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
  `{ "error": "Upload failed (owner is not a string)." }` for the others. 0.6.0 accepted all of
  these owners. Signed-in uploads and numeric owners are unchanged. Reads and deletes with
  `owner: ""` work as before, so the documents that 0.6.0 stored with that owner stay readable
  until they expire.
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
    1,000,000 paragraphs with text, or more than 20,000 parts:
    `This DOCX has more than 20,000 parts, more than an Office document has. It may be built to exhaust the server, so it is not read.`
    The parts are counted before JSZip reads them, the way JSZip will read them, not from the
    count the file gives. A DOCX or PPTX with more than 80,000 extra fields, or more than 8 MB of
    names, comments and extra-field data that JSZip turns into text or goes through byte by byte,
    is refused with
    `This DOCX lists its parts in a way that no Office program does: reading the list would take far more memory or time than an Office document needs. It may be built to exhaust the server, so it is not read.`,
    and one whose ZIP64 end record says it is longer than its fields with
    `This DOCX ends with a ZIP64 record that cannot be read, and reading it could hold the server without end. It may be built to exhaust the server, so it is not read.`
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
- **A text file that is not UTF-8 is read in the encoding it was saved in.** 0.6.0 decoded every
  text, log, CSV, JSON and Markdown file as UTF-8: a CSV that Excel saved in windows-1255 was
  stored as replacement characters (U+FFFD), and accepted without a word. `files.ingest` now reads
  a file in one of these encodings when the letters of its lines show which, and records it in
  `meta.encoding`: `windows-1255` (Hebrew; ISO-8859-8 too), `windows-1256` (Arabic),
  `windows-1251` (Cyrillic), `shift_jis` (Japanese in Shift_JIS, half-width katakana too) and
  `windows-1252` (Western European; ISO-8859-1 too). The encoding is chosen on the lines that are
  not UTF-8 and hold letters, wherever they are in the file, up to 64 KB of them. A line that is
  valid UTF-8 is read as UTF-8 all the same. A byte that the encoding does not have is stored as
  U+FFFD, and counted in `meta.replacedCharacters`.

  No text file is refused for its encoding. A file whose encoding is not recognized is read as
  UTF-8, as 0.6.0 read it, and its characters that are not valid are counted in
  `meta.replacedCharacters`. So is a file in which at least as many lines count as UTF-8 as count
  as not, or in which at most one line in 200 is not UTF-8, ASCII lines counted: a log cut at a
  byte count, a part made by `split -b`, a log with stray bytes or a binary body in a few lines. A
  line counts as UTF-8 when it holds at least as many characters of more than one byte as
  characters that are not valid: so a few lines of half-width katakana in Shift_JIS, whose bytes
  can pair into valid UTF-8 by chance, can be read as UTF-8 with U+FFFD. Files that are valid
  UTF-8, and UTF-16 files, are decoded as in 0.6.0.

  As a rule, these are not recognized, and are read as UTF-8 with U+FFFD: Greek, Turkish,
  Central European (windows-1250), Icelandic, KOI8-R, the DOS code pages (437, 850, 866),
  Chinese, Korean and Thai, and a Japanese file with few or no kana (names and cities in kanji
  only). Some files are read in a wrong encoding, and `meta.encoding` names it:
  - Hungarian in windows-1250 or ISO-8859-2 is read as windows-1252, with õ and û in place of ő
    and ű. A search for a word with ő or ű finds nothing.
  - ISO-8859-15 is read as windows-1252 when it has no œ, with ¤ in place of €. A file with œ in
    its words (cœur, sœur) is most often read as UTF-8 with U+FFFD instead: in windows-1252 its œ is
    ½, which does not fit between two letters. A 15-line menu with œ in 4 of its lines was, and so
    is a line or two of French with œ.
  - A file of a line or two can fit another encoding: Greek capitals as windows-1251, and "Straße"
    saved in DOS code page 850 as windows-1252 "Straáe".
  - So can a file of fewer than 200 lines, or of one long line such as minified JSON, whose few
    stray bytes happen to fit one.

  In a file where at most one line in 200 is not UTF-8, those lines become U+FFFD even when they
  are in an older encoding. And when a file was read in an older encoding, an editor that opens it
  as UTF-8 shows those lines as �: a person who checks the file there does not see what the model
  reads.

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
  wrong, ask for the file in UTF-8 (in Excel, "CSV UTF-8 (Comma delimited)"). Documents that
  0.6.0 stored from files in these encodings still hold U+FFFD: ingest them again. See
  [Text encodings](docs/guides/pdfs.md#text-encodings), how the encoding is chosen in
  [How it works](docs/how-it-works.md#text-encodings),
  [Text files that were not UTF-8](docs/security.md#text-files-that-were-not-utf-8) and
  [`DocumentMeta`](docs/reference/library.md#documentmeta).
- **Some files are stored with other text than 0.6.0 stored.** Besides a text file that is not
  valid UTF-8 (above), ingest now removes characters that show nothing, such as tag characters,
  zero-width spaces and control characters U+0080-U+009F, and the terminal escape sequences that
  start with U+009B; makes U+0085 a line break in a text that has no other; marks text that Word
  hides, line by line; and marks the heading of a slide that the slide show skips (see
  **Changed**). File names lose tag characters, zero-width spaces and the other characters that
  show nothing too. Their control characters, line and paragraph separators and text-direction
  controls, the marks of right-to-left text included, became a space in 0.6.0 already, and still
  do: an escape sequence loses only its ESC (`re\x1b[31mport.txt` is stored as `re [31mport.txt`).
  Lines move in three cases: in a DOCX with hidden text, in a text whose records end with U+0085,
  and after a line of more than 2,000 characters that lost such characters, which can now be cut
  into fewer lines. A file with none of these gets the same text, outline and line index as 0.6.0
  gave it. Documents that 0.6.0 stored keep their text until they expire.
  **What to do:** nothing. To have a document that 0.6.0 stored read the new way, ingest its file
  again.
- **An `unpdf` that cannot read PDFs on your version of Node is refused, with what to install,
  and unpdf 2 is accepted.** In 0.6.0, on Node 20.19 and 22.12, unpdf 1.5.0 to 1.6.0 stopped the
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

  The optional peer range of `unpdf` is now `^1.4.0 || ^2.0.0`. An app that upgrades keeps the
  unpdf its lock file has. On Node 24 and later, a new `npm install unpdf` next to 0.6.1 installs
  unpdf 2 and saves `^2` in `package.json`, where 0.6.0 got 1.9.1. On Node 20 and 22, npm 11 (the
  version checked) picks a 1.x whose engines fit: 1.7.0 and 1.9.1.
  **What to do:** nothing, if your PDFs are read today. Otherwise install the unpdf that runs on
  your Node: on Node 20, 1.4.0 or 1.6.1 to 1.8.1 (1.7.0 is the last that does not ask for
  Node 22); on Node 22, 1.4.0, or 1.6.1 or a later 1.x; on Node 24 and later, any version from
  1.4.0, 2.x included. To go back to 0.6.0 after moving to unpdf 2, install both in one command:
  `npm install llm-large-files@0.6.0 unpdf@^1`. `npm install llm-large-files@0.6.0` alone stops
  with `ERESOLVE` and changes nothing. Restoring `package.json` and `package-lock.json` together
  works too. See [PDFs and other formats](docs/guides/pdfs.md#formats).
- **`view_pages` and picture marks pause by time.** `@cantoo/pdf-lib` reads the whole file into
  objects first. On its own it pauses for other requests after a count of objects: 0.6.0 used
  4,000, and 4,000 objects of a large file took 0.5 to 0.8 s, while a file of fewer objects never
  paused. Objects differ in cost a hundred times. It now pauses after every 12 ms of work. A slice
  also runs twice as long as a pause takes, up to 40 ms: a pause is a timer, about 15 ms on
  Windows and 1 ms elsewhere. Measured on Windows with Node 24, against a pause every 500
  objects: a file of 4,000 large arrays held the event loop for 164 to 179 ms at a time, now 28 to
  32 ms. A 2,000-page PDF held it 32 to 106 ms, now 19 to 38 ms. A file of many small objects is
  read faster (61,000 objects: 1.65 to 1.87 s, now 0.91 to 0.96 s). A file of large objects takes
  up to a quarter longer on Windows (1.13 to 1.22 s, now 1.35 to 1.43 s). What pdf-lib reads in
  one step still holds the server, and grows with the file. One object takes about 0.1 to 0.35 s
  for each MB, by what it holds: a crafted PDF of 16 MB with one array of numbers held the server
  1.6 to 2.7 s at ingest and 1.7 to 2.5 s on each look, and up to 3.5 s on each look when its
  numbers were of one digit, on a heap that could hold it (that look took 984 MB). What such an
  object takes from the heap is below, in "A crafted PDF can still run the server out of memory". It takes about 0.03 s for each MB of a stream whose length the file gives
  by reference. A cross-reference table written as text takes 0.15 s for 150,000 objects, and a
  cross-reference stream inside the file 0.7 s for each million objects it declares. When pdf-lib
  cannot be timed this way (a version built otherwise), it pauses by count: every 500 objects, or
  more in a file of more than 50,000 objects (up to 4,000), so that it pauses about 100 times at
  most. Your app's own use of `@cantoo/pdf-lib` is not changed.
  **What to do:** nothing. If users can upload files you do not trust, ingest them in a process of
  their own, as [Deployment](docs/guides/deployment.md#uploads-and-ingest) shows. What a look
  takes from the heap of the server that answers questions is in
  [Memory on each server](docs/guides/deployment.md#memory-on-each-server).
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
- **A crafted PDF can still run the server out of memory.** pdf.js and `@cantoo/pdf-lib` build
  each object of a PDF in one step, and nothing checks the memory an object takes before it is
  built. One MB of a file took 6 to 91 MB of heap in `@cantoo/pdf-lib`, by what it holds (empty
  dictionaries the most), and a stream unpacked twice packs such objects thousands of times: 8 MB
  of empty dictionaries fit in a PDF of 759 bytes. `@cantoo/pdf-lib` builds every object of the
  file, at ingest for the page check and the picture marks (both on by default) and again for each
  look of `view_pages`. pdf.js builds the objects a page needs, and every object of an object
  stream once it needs one of them, as it does for the catalog. Measured on Node 24 with
  `--max-old-space-size` of 256 and 512:
  - one array of one-digit numbers in a PDF of 16 MB ran a heap of 256 MB out of memory at ingest,
    and a look at its pages a heap of 512 MB; a look at one of 8 MB took 422 to 427 MB, where its
    ingest took 232 to 244 MB;
  - a PDF of 732 bytes whose object stream, unpacked twice, holds the catalog and 4 MB of empty
    dictionaries ran a heap of 512 MB out of memory at ingest. With `checkPages: false` and
    `pictures: false`, pdf.js alone did so for 8 MB of them, in a file of 759 bytes;
  - what a stream unpacks to is held outside the heap, where `--max-old-space-size` does not limit
    it: a PDF of 1.6 KB whose object stream unpacks to 512 MB was read with 20 MB of heap, but the
    process took 1.6 GB of memory, and pdf.js held the server 6.1 to 6.4 s. A look at its pages
    took 1.1 GB;
  - a cross-reference stream inside a file of 8.7 KB that declared four million objects ran a heap
    of 512 MB out of memory: `@cantoo/pdf-lib` makes an entry for each, whatever the stream holds;
  - `@cantoo/pdf-lib` keeps every name and every reference it reads for the life of the process,
    and each file with other names or object numbers adds its own. After the document was dropped,
    2 MB of different names still took 37 MB, and a million declared objects about 140 MB. Files
    of 9 KB that each declared a million new objects ran a heap of 512 MB out of memory at the
    fourth ingest, and a heap of 1 GB (`--max-old-space-size=832`) at the seventh look.

  The limits on the number of objects a file declares do not see these files. 0.6.0 did the same.
  A check of each object before it is built is not in 0.6.1: pdf.js reads an object where the
  cross-reference table points, also inside what reads as the data of a stream, and the object
  streams of an encrypted file cannot be unpacked before they are decrypted, so it would be easy
  to get around. See [Objects of a PDF](docs/security.md#uploads) and the
  [measurements](docs/measurements.md#the-server).
  **What to do:** if your users can upload files you do not trust, ingest them in a child process
  with its own `--max-old-space-size`, as [Deployment](docs/guides/deployment.md#uploads-and-ingest)
  shows, and with a memory limit of its own, such as a container of its own: such a file then
  stops that process, not your server. A heap limit alone does not stop a stream that unpacks to
  hundreds of MB. Do not offer `view_pages` on their documents (`viewPages: false`), or keep no
  PDF originals: a look parses the file again on the server that answers the question, can need
  more memory than the ingest did, and what `@cantoo/pdf-lib` keeps there comes back only when
  that server restarts.

What the model is sent, and what the loop does:

- **The frame around a file sent whole carries a mark, before the file's name.** Its two lines
  were `--- Attached file: report.txt (text, 6 lines) ---` and
  `--- End attached file: report.txt ---`. For every file sent whole, they are now
  `--- Attached file [mark 1f0c3a9e]: "report.txt" (text, 6 lines; it ends only at the line with mark 1f0c3a9e) ---`
  and `--- End attached file [mark 1f0c3a9e] ---`. The mark is eight hex digits made from the
  document ID, which is made after the file's text was written. So a line of the file that copies
  the end of the frame has no mark or a wrong one, and the first line tells the model that the
  file ends only at the line with the mark. The mark is not a secret: someone who knows a document's ID
  can write its mark into a file uploaded later. And it does not make the model obey: a model can
  still follow an instruction inside the file. The uploader chooses the name along with the text,
  so the name comes after the mark, quoted as JSON, and the last line holds only the mark: a name
  cannot put a mark of its own first. A file that is not valid UTF-8 adds how it was read after
  the count of lines (see **Changed**), and a file of one line says `1 line`. The whole first
  line is
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
- **The provider's prompt cache misses once after the upgrade.** The description of
  `search_document` changed (see the next point), and so did the frame of every file sent whole.
  The first request of each conversation after the upgrade therefore shares no cached start with
  what 0.6.0 sent: nothing on Claude and OpenAI-compatible endpoints, where the tools come first,
  and only the system instruction on Gemini. Its input costs what it costs without a cache (with
  Claude's `cache_control`, a cache write). The mark of a document is the same in every request,
  so from then on the cache reuses the file again; the first request of each follow-up question
  still misses from the tool rounds of the question before it (see the point on
  `tool_turns_left` below). While servers of both versions answer the same conversation, each
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
  When the room holds only the last match and that note does not fit with it, the note is
  `Showing 1 of the 442 matching lines: the last (line 15269). Narrow the search.`
  A search that stopped early shows no last line, since it did not reach it. Its note is now
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
- **A search that 0.6.0 stored is run again.** An exact or regex search that 0.6.0 stored, with
  more matching lines than `max_results`, holds only the first ones. When a later question makes
  the same call, the call now runs, and its result has the last match. 0.6.0 answered it with a
  pointer ("Not run: this exact call was answered earlier in this conversation, …"). A pointer
  that 0.6.0 stored to such a result is sent as the stand-in
  `Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it.`
  **What to do:** nothing.
- **The tool rounds of an earlier question are sent without `tool_turns_left`.** That count was of
  the turns their own question had left, and a model could take a 0 there for its own. What
  `toolTurns` stores is unchanged. `geminiToolTurns`, `openAiToolTurns` and `anthropicToolTurns`
  leave the field out too, so a history kept in a provider's form gives the same request as one
  kept as `toolTurns`; contents that 0.6.0 converted keep it. So the first request of a follow-up
  question differs from the requests of the question before it, from that question's first tool
  round on: the provider's prompt cache misses from there, and those rounds are billed at the full
  price once, in that request (with Claude's `cache_control`, as a cache write). The cards, and the
  turns before those rounds, are still read from the cache.
  **What to do:** nothing, unless your tests compare the output of a converter with the stored
  `toolTurns`: leave `tool_turns_left` out of the expected value. See
  [What `toolTurns` holds](docs/guides/conversations.md#what-toolturns-holds).
- **An answer that comes back without text is asked for once more.** When the request for the
  answer (the last one of the tool loop, sent with `toolChoice: "none"`) comes back empty, or with
  a tool call the model was told not to make (Gemini's `UNEXPECTED_TOOL_CALL` or
  `MALFORMED_FUNCTION_CALL`, or calls from an adapter of your own), it is sent once more, with a
  note at its end that is not kept:
  `Your last reply had no text. No tool can be called in this reply: write the answer now, in text, from what is above.`
  `steps` gets "The model's answer was empty: it was asked again" or "The model called a tool
  instead of answering: it was asked again for the answer". It is one of the two second tries a
  question may make. It is not made after a refusal, a filter, a reply cut off at the output limit
  with nothing in it, or once `limits.requests` or `limits.inputTokens` is reached. It can be one
  request past `limits.toolTurns`. With an explorer, the answering model gets this note too. In
  0.6.0 such a question ended with `answered: false` and no text; a model that still writes no
  text ends that way, one request later.
  **What to do:** if a test fake of yours answers the answer's request with nothing, or with a tool
  call, expect one more request, with `toolChoice: "none"`, and one more step: a fake with a fixed
  queue of replies runs out. To cap the requests of a question exactly, use `limits.requests`. See
  [Empty or broken turns](docs/guides/errors-and-reliability.md#empty-or-broken-turns).
- **Steps are one line of plain text.** In the lines of `onStep`, `onActivity` and
  `result.steps`, a line break, a tab or another control character in what the model sent becomes
  one space, together with the blanks around it. Steps drop what ingest drops from file text and
  names (see **Changed**): text-direction embeddings, overrides and isolates, zero-width spaces,
  word joiners and invisible operators, the deprecated format characters, byte order marks, soft
  hyphens and tag characters. As file text does, they keep LRM, RLM, ALM, ZWJ, ZWNJ, the flags of
  England, Scotland and Wales, and the other format characters, a few that show nothing among them
  (U+180E, U+FFF9-U+FFFB). "](" becomes "] (", so that a markdown link or picture in what the
  model wrote stays text. A query is cut at 80 characters and a task at 100, never in the middle
  of a character. A call to a tool that does not exist is shown as
  `Call “do_magic” — failed: Unknown tool “do_magic”.`, with the name cut at 64 characters, and
  its activity line is `Call “do_magic”…`; the step started with the whole name, and held it twice.
  The model gets `Unknown tool “do_magic”.`, and so does `files.tools().execute()`: it was
  `Unknown tool do_magic.`. Steps still quote the model's words, HTML tags and web addresses
  included.
  **What to do:** if you parse steps or match the unknown-tool error, allow for these changes. Show
  steps and activity lines as plain text, never as markdown or HTML. See
  [What the library logs](docs/security.md#what-the-library-logs).
- **A question stopped while its adapter is being called ends with the signal's reason.** When
  the signal aborts while the adapter is being called (from `onText`, say), and the adapter then
  fails at once with its own error, `askWithFiles` now throws the signal's reason, as it does for
  every other way of stopping. 0.5.0 and 0.6.0 threw the adapter's error (a 503, say). The
  question also stops at once when the adapter does not look at the signal (see **Changed**).
  **What to do:** if a test expects the adapter's error there, expect the signal's reason.

Model errors:

- **A reply of HTTP 200 whose body is not JSON is a `ModelRequestError`, not a `SyntaxError`.** A
  page from a proxy or a gateway that answered in the model's place (a sign-in page) now throws a
  `GeminiRequestError`, `OpenAiRequestError` or `AnthropicRequestError`, with `kind: "invalid"`,
  the status of the response (200), and the `SyntaxError` as `cause`:
  `Gemini's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.`
  For an OpenAI-compatible endpoint the message starts "The model's reply …", and for Claude
  "Claude's reply …"; without a content type, the part in parentheses is left out. It is still
  not sent again, and a part read no longer tries it once more. A streamed Gemini request that got
  such a page was sent again up to three times (the default `retries`), as a reply cut off on its
  way; it now fails at once, in the same way. A reply of HTTP 200 whose body is empty is a reply
  cut off on its way: kind `"unreachable"`, status 0,
  `Gemini could not be reached (the reply was empty).` ("The model could not be reached …" and
  "Claude could not be reached …" for the others), and it is sent again. It was a `SyntaxError`
  that was not sent again. A streamed reply of type `text/event-stream` that comes empty still
  gives `Gemini's reply ended before it was complete.` ("The model's reply …", "Claude's reply …"),
  as in 0.6.0, and is sent again.
  **What to do:** if you test `error instanceof SyntaxError`, test
  `error.cause instanceof SyntaxError` instead (kind `"invalid"`, status 200). Kind `"invalid"`
  alone also covers every other request that the provider refused. See
  [The kind of a model error](docs/guides/errors-and-reliability.md#the-kind-of-a-model-error).
- **More refusals are kind `"quota"`, and are not sent again.** These are HTTP 402 (DeepSeek's
  "Insufficient Balance", OpenRouter's "Insufficient credits"), Claude's "Your credit balance is
  too low" (HTTP 400), Claude's spending limits ("You have reached your API usage limits"), and a
  Vertex AI quota per day that only the message names. Claude's spending limits come as HTTP 429
  with `enforced_spend_limit_reached`, which was sent again three times, or as HTTP 400. These
  refusals were `"invalid"` or `"rate_limit"`.
  **What to do:** nothing, unless you show your own words by kind: these now get the words of
  `"quota"`.
- **An error inside a stream has the status, and the kind, that its type names.** On an
  OpenAI-compatible endpoint, `context_length_exceeded` is now HTTP 400, kind
  `"context_overflow"`, and `insufficient_quota` HTTP 429, kind `"quota"`: both were HTTP 500,
  kind `"server"`, and sent three more times (see **Fixed**). On Claude, `invalid_request_error`
  is 400, `authentication_error` 401, `billing_error` 402, `permission_error` 403,
  `not_found_error` 404 and `request_too_large` 413: they kept the stream's 200, so an
  authentication error was kind `"invalid"`, and is now `"auth"`, and a billing error is now
  `"quota"`. A type Claude's adapter does not know is the server's failure, 500, and is sent again
  when none of the reply was shown; it kept the 200, and was not sent again.
  **What to do:** nothing, unless you show your own words by kind or by status.
- **A request larger than the tokens a minute allows is kind `"context_overflow"`.** This covers
  OpenAI's "Request too large for gpt-4o … on tokens per min (TPM): Limit 30000, Requested 45237"
  (HTTP 429) and Groq's "… on tokens per minute (TPM): Limit 6000, Requested 6438" (HTTP 413 or
  429), and the same per day. The error carries `limitTokens` and `requestedTokens`. These
  refusals were `"rate_limit"`, sent again three times as they were though only a smaller request
  can pass, or `"invalid"` for Groq's 413. Now the loop makes the request smaller, or plans the
  files again for that limit, and a part read is read in halves. The steps say "The first request
  was larger than the 30,000 tokens a minute that the provider allows: the files were planned
  again to fit it", "The first request was larger than the provider allows in a minute: the files
  were planned again for a smaller request" (when the message gives no limit), or "The request was
  larger than the provider allows in a minute: older tool results were shortened, and it was sent
  again". `withRetry` no longer sends again an error of kind `"context_overflow"`, whatever its
  status.
  **What to do:** nothing, unless an adapter of your own sets `kind: "context_overflow"` on an
  error that a wait would mend. See
  [A request too large for the model](docs/guides/errors-and-reliability.md#a-request-too-large-for-the-model).
- **A whole-file read tells the model why a model request failed by its kind, its HTTP status or
  a connection code, never by the error's words.** Its result, its line in `onStep` and `steps`,
  and `toolTurns` now say, for example, "Could not read any part of app.log: The model refused the
  key or token it was sent (HTTP 401)." They carried the provider's message, which can name a
  project, a host, a masked key, or a URL with a key in it. The same holds for a part that could
  not be read among others, and for a last step that failed (`notes_only`). This applies to every
  error a `generate` throws, the package's adapters' and your own:
  - an error with a `kind` is told by its kind: "The request was larger than the model takes",
    "The model's quota has run out", "The model was busy", "The model took too long to answer",
    "The model could not be reached", "The model failed on its side", "The model refused the key
    or token it was sent" or "The model refused the request", with " (HTTP 429)" when it has a
    status; a reply with a status of success that could not be read is "The model's reply could
    not be read (HTTP 200).";
  - an error with an HTTP status and no kind (`status`, `statusCode` or `response.status`, as
    provider SDKs, got and axios set them) has its kind worked out from its status and message, as
    `classifyModelError` does;
  - an error whose code, or its cause's code, is that of a connection that failed
    (`ECONNREFUSED`, `ENOTFOUND`, undici's `UND_ERR_SOCKET`…) is "The model could not be
    reached.", and a timeout (an error named `TimeoutError`, from an `AbortSignal.timeout` or a
    part reader's `timeoutMs`, or undici's `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT`)
    is "The model took too long to answer.";
  - any other error, such as a plain `Error` or a thrown string, is "The model request failed.".

  A part reader of the package's that got a reply with no text is still told in the package's
  words, "The model returned no text (SAFETY).", but the provider's reason is left out when it is
  not a plain word. An error of the document store keeps its own message ("The document store
  could not be read (EIO). Try again.").
  **What to do:** if you read the provider's words from the steps, log them in your own `fetch`,
  adapter or `generate` instead. To give the model a specific reason, throw an error with a `kind`
  or an HTTP `status`. See
  [Failures inside tools](docs/guides/errors-and-reliability.md#failures-inside-tools).
- **Gemini part reads send no temperature.** By default, the `generationConfig` of a part read in
  a whole-file read, and of `createGeminiGenerateText`, is `{ maxOutputTokens }`. It was
  `{ maxOutputTokens, temperature: 0.2 }`. Gemini 3.6 and later ignore the temperature, and Google
  says later models will refuse it.
  **What to do:** to keep it for an older model, pass
  `analysisConfig: (maxOutputTokens) => ({ maxOutputTokens, temperature: 0.2 })` to `gemini()` or
  `askGemini`, or a `generationConfig` that does the same to `createGeminiGenerateText`. See
  [Whole-file reads in parts](docs/guides/vertex-and-gemini.md#whole-file-reads-in-parts).

Tests:

- **Tests that compare exact output need new expectations.** A test that pins what the library
  writes fails where 0.6.1 writes something else. The cases, each with the point that explains it:
  - the frame of a file sent whole: its mark, the quoted name, `1 line` for a file of one line
    (above, "The frame around a file sent whole");
  - a search: up to `max_results` + 1 `matches`, its `note`, its `evidence` lines, and the
    description of `search_document` (above, "A search in exact or regex mode");
  - steps: "1 matching line", "1 passage", "1 part", "1 more tool call in this turn was not run",
    the steps of a request larger than a minute allows, the cleaned text, and the step and error
    of an unknown tool (above, "Steps are one line of plain text", and **Fixed**, Searches);
  - the card: `1 line` and `1 page` (**Fixed**, Searches), and the line on how a file that is not
    valid UTF-8 was read (**Changed**);
  - the stored text of a file with characters that show nothing, with text that Word hides, or
    with a hidden slide (above, "Some files are stored with other text");
  - `error instanceof SyntaxError` for a reply that is not JSON: test
    `error.cause instanceof SyntaxError` (above, "A reply of HTTP 200");
  - `classifyModelError` of a request larger than a minute allows, now
    `{ kind: "context_overflow", limitTokens: 30000, requestedTokens: 45237 }`, and of the
    refusals that are now `"quota"`, and the status and kind of an error inside a stream (above);
  - `anthropic().capabilities` with context editing in `body`: it gains
    `clearsToolResults: true` (**New**);
  - the output of `geminiToolTurns`, `openAiToolTurns` and `anthropicToolTurns`: no
    `tool_turns_left` (above, "The tool rounds of an earlier question");
  - the reasons of a whole-file read that failed (above, "A whole-file read tells the model");
  - a fake model with a fixed queue of replies, whose answer comes back empty or as a tool call:
    one more request, with `toolChoice: "none"` (above, "An answer that comes back without text");
  - a fake adapter that fails after the question was stopped: the signal's reason (above, "A
    question stopped while its adapter is being called");
  - the body of a Gemini part read: no `temperature` (above, "Gemini part reads");
  - a fake `fetch` whose streamed reply is not of type `text/event-stream`: it is read by what it
    holds (**Changed**, "A reply asked for as a stream"); and one whose reply of HTTP 200 is empty:
    it is sent again (above, "A reply of HTTP 200");
  - `ingest` with `owner: ""` (above, "An upload whose owner is empty");
  - `MemoryDocumentStore`: `getMeta(id)` gives a new object each time, so `toBe` between two
    calls fails (**Changed**).

  **What to do:** update those expectations. Compare steps and evidence to the tools that ran
  rather than to whole sentences, and leave the library's prompts out of what you compare whole,
  as [What to assert](docs/guides/testing.md#what-to-assert) advises. The testing guide lists
  these changes too, in [Output that 0.6.1 changed](docs/guides/testing.md#output-that-061-changed).

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
  pages and pieces, and the text extractor between the steps of a file that is not valid UTF-8.
  `createDocumentHandlers` passes one that aborts when the client closes the connection. See
  [`IngestInput`](docs/reference/library.md#ingestinput).
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

- **`DocumentMeta.encoding` and `DocumentMeta.replacedCharacters`**, and the same two fields of
  `DocumentSummary` and `ExtractedText`: how a text file that is not valid UTF-8 was read.
  - `encoding` is the older encoding the file was read in, as TextDecoder names it
    (`"windows-1255"`). Lines of the file that are valid UTF-8 were read as UTF-8 all the same.
  - `replacedCharacters` is the number of characters that were not valid in the encoding the file
    was read in (UTF-8, or `encoding`), each stored as U+FFFD. A byte that `encoding` has no
    character for is counted even where TextDecoder gives a control character for it
    (windows-1252 0x81, 0x8D, 0x8F, 0x90 and 0x9D, windows-1255 0x8A and others).

  Both are absent for valid UTF-8, for UTF-16, PDF, DOCX and PPTX, and on documents stored before
  0.6.1; `encoding` is absent too for a file read as UTF-8 with characters that are not valid.
  `toDocumentSummary` passes them on, so the upload route of `createDocumentHandlers` answers with
  them. An extractor of your own may report them in `ExtractedText`: `encoding` is kept when it is
  a name, such as `iso-8859-2`, and not one of UTF-8 or UTF-16 (`utf8`, `unicode`…), and
  `replacedCharacters` when it is a whole number above 0. See
  [`DocumentMeta`](docs/reference/library.md#documentmeta) and
  [Custom extractors](docs/guides/pdfs.md#custom-extractors).

  ```ts
  const meta = await files.ingest({ name, bytes, owner });
  // Tell the user how a file that was not in UTF-8 was read.
  if (meta.encoding) console.log(`${meta.name} was read as ${meta.encoding}.`);
  if (meta.replacedCharacters) console.log(`${meta.replacedCharacters} characters of ${meta.name} show as �.`);
  ```

- **`ModelCapabilities.clearsToolResults`**: for an adapter whose provider may clear old tool
  results on its side. A call made again is then run again, not answered with a pointer to a
  result the model may no longer have, and the pointers in stored rounds become stand-ins that say
  to call again. `anthropic()` sets it when `body.context_management` has an edit that clears tool
  uses (`clear_tool_uses_…`) or compacts the conversation (`compact_…`). An adapter of your own
  sets it itself. See [`ModelCapabilities`](docs/reference/ask.md#modelcapabilities).
- **`SseHooks.maxEventLength`**: the most characters one event may hold in `parseSseJson`. It
  counts what its data lines hold after `data:` and the spaces after it, and the line feeds that
  join them; a line of another field (a comment, `event:`, `id:`) counts in full with the event
  while it is read. It defaults to 64,000,000; `Infinity` sets no limit, and a value that is not
  a positive number counts as not set. A longer event ends the stream with an error named
  `SseEventTooLongError` (`An event of the stream held more than 64,000,000 characters.`), however
  the stream is cut into pieces. The class is exported from `llm-large-files` and
  `llm-large-files/gemini`, and its `limit` holds the limit that was passed. The same event would
  come again, so an adapter of your own should not send the request again for it. See
  [`SseHooks`](docs/reference/errors-and-retries.md#ssehooks).

### Changed: what works differently

Besides the points under **Upgrading**:

- **Ingest lets other requests run while it reads a file.** Each step works in slices of about
  12 ms, with a pause for other requests between two slices: the PDF extractor between pages, the
  DOCX and PPTX extractors as they unpack, the text extractor as it reads a file that is not valid
  UTF-8, and then `ingest` as it cleans the text, measures it, and builds the outline, the log
  profile and the line index. Ingests that run at once take turns, one slice each. Picture marks
  pause every 12 ms between pages, and their limit of 5 s counts only the work, not the pauses.
- **`createDocumentHandlers` stops reading an upload when the client goes away.** Its upload
  handler passes `IngestInput.signal`, aborted when the connection closes before the answer is
  sent: nothing is stored.
- **DOCX and PPTX take memory by their text, not by their XML.** Each paragraph becomes one string
  when it closes, and an empty paragraph is dropped. Text is counted as it reads, not as the XML
  writes it (`&amp;` is one character). An Office file of more than 20,000 parts is refused before
  JSZip reads it. The parts are counted the way JSZip will read them, not from the count the file
  gives.
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
  0.6.0, now in slices. These changes leave the stored text, outline, profile and index as 0.6.0
  made them. Other changes of 0.6.1 change them for some files: a text file that is not valid
  UTF-8 (see **Upgrading**), and the characters, line breaks, hidden text and hidden slides of
  the points below.
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
- **A text file that is not valid UTF-8 is read in slices,** with pauses for other requests, also
  between the encodings it tries and inside a long line, and it stops when the ingest's signal
  aborts. On a 30 MB CSV in windows-1255, the longest step of the decoder was 13 to 16 ms; on
  30 MB files whose lines mix UTF-8 and an older encoding, 9 to 22 ms, a single line of 30 MB
  included. Reading such a file takes about twice as long as 0.6.0's decode, which gave U+FFFD:
  0.25 to 0.29 s against 0.11 to 0.16 s for a 30 MB CSV in windows-1255 or windows-1251. A file
  whose lines take turns between UTF-8 and an older encoding takes longer, the shorter its lines
  are. For 30 MB: 0.4 to 0.53 s in lines of 100 bytes, about 1 s in rows of 20 bytes, and 2.1 to
  2.2 s in lines of one letter. Measured on Node 24, on Windows, on a machine shared with other
  work.
- **Ingest removes characters that show nothing** from the text: control characters
  U+0080-U+009F (in a text with no other line break, a U+0085 becomes one instead; see
  the next point), and an escape sequence that starts with U+009B and a parameter, such as
  `\u009b31m`, whole, unless the U+009B comes right after a character of U+0080-U+00FF, where it
  is the end of a letter of UTF-8 read as Latin-1 and goes alone; Unicode tag characters (U+E0000-U+E007F); the text-direction controls that
  reorder what a person sees (embeddings, overrides and isolates: U+202A-U+202E, U+2066-U+2069);
  the zero-width space, the word joiner and the invisible operators (U+200B, U+2060-U+2064); the
  deprecated format characters (U+206A-U+206F); a byte order mark inside the text; and the soft
  hyphen, except one at the end of a line, where it shows. Kept: the marks right-to-left text
  needs (U+200E, U+200F, U+061C), zero-width joiners and non-joiners (emoji, Persian), variation
  selectors, and the flags of England, Scotland and Wales. Other flags written with tag
  characters, such as Texas or Bavaria, keep only the black flag, which is how most systems show
  them anyway. A file name loses the same characters, except that control characters, line and
  paragraph separators and every text-direction control, the marks of right-to-left text
  included, become a space, as in 0.6.0, and an escape sequence keeps all but its ESC, which
  becomes a space (`re\x1b[31mport.txt` is stored as `re [31mport.txt`). Lines move in two cases
  only: in a text with no line feed, where U+0085 ends lines, and after a line of more than 2,000
  characters that lost some of these characters, which can now be cut into fewer lines. A file
  read as 0.6.0 read it (valid UTF-8 or UTF-16, or not a text file) that holds none of these
  characters, and, for a DOCX or PPTX, has no hidden text or hidden slide, is stored as before,
  byte for byte. 25 inputs were compared: logs, coloured logs, CSV, JSONL, Markdown in six
  scripts, UTF-16, Hebrew and Arabic with their marks, DOCX, PPTX and 12 PDFs. Cleaning a text that
  holds none of them takes a little longer: 2 to 7% (4 to 15 ms per 100 MB) on an ASCII log, 10 to
  20% on Hebrew in UTF-8; the time of a whole ingest did not change beyond the spread of runs.
  Documents stored before keep their text until they expire. See
  [Characters that show nothing](docs/security.md#characters-that-show-nothing).
- **U+0085 ends a line in a text that has no other line break.** Some files end each record with
  U+0085 (NEXT LINE) and contain no line feed, such as z/OS data converted to UTF-8 with iconv
  (IBM-1047). 0.6.0 stored such a file as one line, with the U+0085 characters in it. Each record
  is now a line of its own; a line break at the very end of the file does not count. There are two
  exceptions. A record that ends in a character of U+0080-U+00FF, such as É, ° or £, still runs
  into the next one: a U+0085 right after such a character is taken for the last byte of a UTF-8
  letter read as Latin-1 ("ą" is C4 85) and removed, so that the word stays whole. An empty record
  is dropped. A file of one line, such as minified JSON, has no other line break either, so a
  U+0085 inside one of its strings becomes a line break too; such a line was already cut every
  2,000 characters, sometimes inside a string. In a text with other line breaks, a U+0085 is more
  often inside a JSON string or a CSV field, or is a windows-1252 "…" that another program read as
  ISO-8859-1. There it is removed with the other C1 control characters, and adds no line break. In
  text that Word hides, a U+0085 starts a new marked line. This applies to text in UTF-8 (or UTF-16
  with a byte order mark). The same export converted to ISO-8859-1, with a byte 0x85 at the end of
  each record, stays one long line, cut every 2,000 characters: it is read as windows-1252, where
  0x85 is "…" (0.6.0 put U+FFFD there). Convert such a file to UTF-8 instead. Documents stored
  before keep their text until they expire.
- **Text that Word hides is marked.** The text of a run hidden in Word (`<w:vanish/>`) was stored
  as ordinary text. It now comes after the text of its paragraph that shows, and each of its lines
  starts with `[Hidden text, not shown in the document]`, so that the model can tell it from what
  a reader sees. A carriage return, a U+0085 or a line separator in it starts a new marked line.
  The text of a run inside a hidden run, such as the reading of a ruby, is marked too, and so is
  the rest of the hidden run after it. A line longer than about 1,950 characters is cut into
  pieces, each marked, so that no piece is ever stored without its mark. The marks count toward
  `maxTextBytes` and the 32 million characters of a DOCX, so a DOCX close to either limit with
  hidden text is refused a little sooner. The mark is a hint, not a filter: text hidden through a
  style, white or 1-point text, and a few rarer forms are read as ordinary text, and a document's
  own text can write the mark. Reading a DOCX takes about as long as before. See
  [Hidden text in Word and PowerPoint](docs/security.md#hidden-text-in-word-and-powerpoint).
- **A hidden slide says so.** The heading of a slide that the slide show skips (`show="0"`) reads
  `## Slide 2 (hidden, not shown in the slide show)`. Its text is kept. Shapes hidden on a slide
  that shows are read as ordinary text. See [DOCX and PPTX](docs/guides/pdfs.md#docx-and-pptx).
- **`MemoryDocumentStore` copies the metadata** it is given and the metadata it hands out, as a
  store that writes it somewhere does. `getOriginal` still returns the kept bytes themselves: treat
  them as read-only. See [`MemoryDocumentStore`](docs/reference/library.md#memorydocumentstore).
- **A question stops when its signal aborts, even with an adapter that does not.** The loop no
  longer waits for an adapter (or a part reader of a whole-file read) that does not look at
  `signal`. `askWithFiles` throws the signal's reason, with `partialResultOf`; nothing is sent
  after the stop, no further part of a whole-file read either; and text that such an adapter
  sends later is not shown. `partialResultOf(error).usage` is what was counted when the question
  stopped: a request still running then may be billed by the provider, and is not counted. See
  [Cancelling](docs/guides/web-app.md#cancelling).
- **A read of one line from the rounds of an earlier question is run again**, not answered with a
  pointer. 0.5.0 cut a long line to the room it had without saying so (no `text_cut`), and stored
  reads cannot be told apart from those. Reads of more lines, and reads of the same question, are
  pointed to as before. A pointer that 0.6.0 stored to such a read, in a later question than the
  read, is sent as the stand-in that says to call again. See
  [Repeated calls in a follow-up](docs/guides/conversations.md#repeated-calls-in-a-follow-up).
- **A request sent again after its reply was cut off on its way says so.** `onActivity` gets
  "The model's reply was cut off on its way. Trying again…" in three cases: a stream that closed
  before its end, a connection that failed once the reply had begun, or a reply of HTTP 200 that
  came empty. It said "The model could not be reached. Trying again…", which is kept for a
  connection that failed before any reply.
- **A reply asked for as a stream is read by what it holds when its content type is not
  `text/event-stream`.** It is read as events when it starts like them (a field such as `data:`,
  or a comment), and as JSON when it starts with `{` or `[`. A body that starts with more than
  65,536 characters of white space is read as JSON, whatever follows it. A gateway that streams
  under `application/octet-stream`, or under no type, failed with a `SyntaxError` on the
  OpenAI-compatible and Claude adapters, and Gemini took a reply in one piece for a cut stream.
  Gemini's chunks in a list, as it sends them without `alt=sse`, are read too. See
  [A stream cut off](docs/guides/errors-and-reliability.md#a-stream-cut-off).
- **Claude: `x-should-retry: false` is followed.** A request that the API says not to try again is
  not sent again, whatever its status, as Anthropic's own SDKs do.
- **Claude: an error inside a stream gets the status of its type** (see **Upgrading**).

### Fixed

Uploads you do not trust:

- **A DOCX of 1.5 MB no longer stops a server with a heap of 512 MB.** It held 120 MB of empty
  paragraphs, each of which 0.6.0 kept until the end of the file: the process ran out of memory
  and stopped, and every answer streaming on it with it. The same file is now refused
  ("padded.docx did not contain any text.") in 3.0 to 3.2 s, with the process at 115 MB. A DOCX
  of 3 MB that unpacks to 1,000 MB of XML, which stopped the same server, is refused at its
  millionth paragraph in 0.9 s, at 165 MB.
- **A DOCX that understates its parts no longer stops a server with a heap of 256 MB.** The limit
  of 20,000 parts took the count from the end of the file, which whoever made the file writes.
  300,002 parts with a count of 2, or 270,002 whose count kept only its low 16 bits, went past it,
  took 440 to 490 MB in JSZip, and ran a heap of 256 MB out of memory, as in 0.6.0. The directory
  is now read before JSZip reads it, as JSZip will read it: from where JSZip finds it, record by
  record, each by its own lengths. Such a file is refused in 40 to 90 ms, nearly all of it loading
  JSZip, with the heap at 8 to 9 MB. The same reading refuses other files that no ZIP program
  writes, which stopped 0.6.0 as well: more than 8 MB of names, comments and extra-field data,
  which JSZip turns into text or goes through byte by byte (a name is decoded once for each part
  that points to its header, and a field gives all the data it says it has, even past its
  record); more than 80,000 extra fields, for which JSZip keeps about 250 bytes each; and a ZIP64
  end record that says it is longer than its fields, which JSZip reads in a loop that does not
  move on. Unicode Path fields that ran over the records after them ran a heap of 256 MB out of
  memory from a DOCX of 0.17 MB, and one of 512 MB from 1.1 MB; ZIP64 fields built the same way
  held the event loop for 4.5 s from 1 MB; long names ran a heap of 256 MB out of memory from a
  DOCX of 94 MB; 4.9 million extra fields ran one of 512 MB out of memory from 19 MB; and the
  ZIP64 end record held the process from a file of 636 bytes until it was killed. Real files are
  read as before: 223 ZIP files of Word, PowerPoint, Excel, Java and other programs, and 22 of a
  deck from PowerPoint and of Word files written again by Python, Info-ZIP, git, .NET,
  System.IO.Packaging, bsdtar and jar, gave the parts and the bytes of text that JSZip reads. Their
  101 Office files were read or refused as before, none for their directory; the most text in
  one was 68 KB. A DOCX just under every limit at once is read in 0.46 to 0.48 s, with the heap at
  126 to 140 MB. See [Measurements](docs/measurements.md#the-server).
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
- **A text of megabytes on one line no longer holds the server while it is cleaned.** Ingest
  cleans a text a slice at a time, but a slice runs on to the next line break, so a line of
  megabytes was cleaned in one go. In 0.6.0, which did not pause at all, one line of 30 MB with a
  control character between its letters held the event loop for 1.9 s, with 761 MB of memory, and
  one full of terminal escape sequences for 0.7 s. A long line is now cleaned in pieces of 256K
  characters, escape sequences included, with a pause between them, and the text is the same. On
  such lines of 30 MB the event loop now waits 31 to 88 ms at most, and 0.1 to 0.28 s on a line
  of 99 MB. That wait no longer comes from the cleaning. It comes from the cut of the line into
  lines of 2,000 characters, which still runs in one block, as for a long line with nothing to
  clean, and grows with what is left of the line: 62 to 76 ms for 20 million characters, and 0.21
  to 0.23 s for 66 million. Measured on Node 24, on Windows, on a machine shared with other work.
- **A look at the pages of a PDF lets other requests run while it parses the file, copies the
  pages and writes the cut.** In 0.6.0 a look held the event loop for nearly its whole time.
  Measured on Windows with Node 24: pages 1,800 to 1,802 of a 6.2 MB, 2,000-page PDF held it 159
  to 177 ms of 163 to 185 ms. One page that refers to 4,000 large arrays held it 0.73 to 0.75 s of
  1.27 to 1.30 s, and one that refers to 20,000 held it 1.87 to 2.02 s of 3.8 to 3.9 s. Now the
  longest holds are 19 to 20 ms (19 to 48 ms on a busy machine), 39 to 50 ms and 43 to 47 ms,
  for looks of 0.2 s, 1.5 to 1.6 s and 4.0 s in all. pdf-lib's copier followed every reference in one go, and its writer never
  paused when it packed objects into streams. The writer also searched its list of objects for
  each new one, a block that grew with the square of their count (0.5 s for 20,000 objects). A
  cut is the same to the byte as before (65 cuts of 50 PDFs compared). Each look still reads and
  parses the whole file. Still in one block: the first look of a process loads `@cantoo/pdf-lib`
  (about 0.4 s, unless the server loads it when it starts), and what pdf-lib reads in one
  step (see **Upgrading**). A page whose resources list 140,000 pictures takes about 0.15 s to
  drop the ones it does not paint, and one content stream of 8 MB takes about 0.1 s to read for
  the pictures it paints.
- **An ingest has a time limit.** In 0.6.0 nothing bounded it: a file that is slow to read held
  its upload, and its share of the server, for as long as it took (see **Upgrading**).

Access:

- **`files.tools()` checks the owner of each document it reads.** In 0.6.0, a loop of your own
  that built a `DocumentMeta` from an ID a client sent could read the text of another owner's
  document through the tools, and show the pages of its PDF: `tools()` checked only that the
  document was still there. It was so in every version before.
- **An owner of `""` no longer makes one owner of every caller without a user** (see
  **Upgrading**).
- **Changing metadata that `MemoryDocumentStore` handed out no longer changes the document.**
  `ingest` and `getMeta` returned the store's own object: deleting `owner` from it before sending
  it to a browser opened the document to every owner, and setting `expiresAt` kept it past its
  expiry. `FileDocumentStore` was not affected.

Searches:

- **A model asked when something last happened can now see the last matching line.** In 0.6.0
  an exact or regex search showed the first `max_results` matching lines (50 at most) and said
  nothing when more lines matched. Its description told the model that exact mode "returns every
  line containing the text". In the review, on Vertex AI with gemini-3.1-flash-lite and a 3 MB
  production log, the model counted the 442 PAY-5031 errors right, then named line 12,088 as the
  last one. It was line 15,269. Now the description says which lines are shown, the result shows
  the last one, and the note says how many of how many (see **Upgrading**). A way to page through
  all the matches is planned for 0.7.0.
- **A search that stopped early and was cut to the size limit still says that its total is a
  lower bound.** Its note is now "The scan stopped early; the total is a lower bound, and the
  last match in the file is not known. Showing 26 of 50 results to stay within the size limit.
  Narrow the query or read specific lines." 0.6.0 lost its first sentence.
- **Steps say "1 matching line", "1 passage", "1 part" and "1 more tool call in this turn was not
  run"**, where 0.6.0 said "1 matching lines", "1 passages", "1 parts" and "1 more tool calls in
  this turn were not run": `Search report.pdf (exact) for “Page 4 of” — 1 matching line`. Likewise,
  a file of one line is `1 line` in its frame and its card, and a PDF of one page is `1 page` in
  its card.

Text files:

- **A Hebrew CSV that Excel saved in windows-1255 can be searched.** 0.6.0 stored its 30 rows as
  U+FFFD: "ירושלים" was found in none of them, and the model saw nothing of the names. It is now
  read as windows-1255, the word is found in all 30 rows, and `meta.encoding` is
  `"windows-1255"`. Arabic in windows-1256, Russian in windows-1251 (in capitals too), French in
  windows-1252, and Japanese in Shift_JIS are read the same way. A file whose encoding is not
  recognized is stored as UTF-8, as before, and its characters that are not valid are counted.
- **An export in CESU-8 is read with its emoji.** An Oracle database in its character set `UTF8`,
  and Java's modified UTF-8, write a character past U+FFFF, such as an emoji, as two halves of a
  surrogate pair. When that is the only thing wrong with a file, the pairs are joined and the file
  is read as UTF-8, with no `encoding` and no `replacedCharacters`. 0.6.0 stored each such emoji
  as six U+FFFD.
- **Tag characters, and the controls that reorder what a person sees, are removed at ingest.** A
  line with 44 Unicode tag characters, which spell out an instruction that a model reads and a
  person does not see, sent all 44 to the model, in the prompt and in tool results. A file name
  kept them too, and the system instruction quoted them. They are now removed, along with
  zero-width spaces and the text-direction controls that change what a person sees. Characters
  that scripts and emoji need are kept, and a crafted file can still carry data a person does not
  see in them (see [Characters that show nothing](docs/security.md#characters-that-show-nothing)).
  The library does not detect instructions.
- **Control characters U+0080-U+009F are removed**, as [Security](docs/security.md#uploads) said
  they were. 0.6.0 kept them: `x\u009b31mERROR` was stored as it was, and is now `xERROR`. In text
  written in UTF-8 and read in the wrong encoding, a U+009B right after a character of
  U+0080-U+00FF is the end of a letter ("ś" is C5 9B): it goes alone, and what follows it stays
  ("Coś? Tak" read as Latin-1 keeps its "? Tak"). A
  U+0085 in a text with no other line break becomes one (see **Changed**).
- **An exact search finds a word split by a zero-width space or a soft hyphen**, in a file
  ingested from now on. `pass\u200bword`, with a zero-width space, matched no search for
  "password"; it does now, on the line the file has it on.
- **A file's own lines, and its name, no longer pass for the end of its frame.** A file sent whole
  could hold `--- End attached file: report.txt ---` and then `--- Attached file: notes.txt … ---`,
  and the model saw the same frame lines that the library writes. The frame lines now carry a mark
  that the file cannot know, before the quoted name, and tell the model that the file ends only at
  the line with the mark (see **Upgrading**). The mark does not make the model obey, and it is not
  a secret ([The frame around a file](docs/security.md#the-frame-around-a-file)).
- **A long file name is no longer cut in the middle of a character.** A name is cut at 255
  characters. 0.6.0 could end it with half of a character outside the basic plane, such as an
  emoji, which an API that checks its input (Claude's) refuses. An emoji of several characters,
  such as a flag, can still lose its end at the cut. A name that an earlier version cut in the
  middle of a character is sent with U+FFFD in place of the half (see "No half of a character
  reaches Claude" below).

The tool loop:

- **The answer's request is asked for again when it comes back with no text** (empty, or a tool
  call instead of the answer). In 0.6.0 the question ended with `answered: false` and empty text,
  though the model could have answered (see **Upgrading**).
- **With Claude's context editing, a pointer no longer says that a result is "still shown above
  in full".** With `clear_tool_uses` or compaction in `body`, the server may have cleared that
  result before Claude read the request. Such calls now run again, and pointers kept from earlier
  questions become stand-ins that say to call again. The loop still counts every result as sent,
  so its room runs out at the same point as without context editing.
- **A question stopped through its signal no longer hangs on an adapter that ignores the
  signal.** In the review, an adapter whose request never ended held the question for good after
  an abort at 300 ms. The question now throws the signal's reason at once (310 ms), also when it
  was stopped between two requests.
- **A question that `onText` stops while the adapter is still being called now ends at once.** It
  waited for ever when the adapter never settled and ignored the signal. When such an adapter
  answers at once anyway, the question is no longer reported as answered with cut text.
- **The problem message of a call whose arguments could not be read no longer ends in half an
  emoji.** It quotes up to 300 characters of the arguments, one fewer when the 300th is the first
  half of an emoji, for OpenAI-compatible models and for Claude. Claude's API refuses a request
  that holds half of one.
- **A step no longer passes on line breaks, text-direction controls, or a markdown link or
  picture that the model put in its arguments**, and no step starts with the name of an unknown
  tool (see **Upgrading**). An unknown tool with a name of 200,000 characters made a step of
  400,025 characters; it is now 162. Steps still quote the model's words, HTML tags included: show
  them as plain text.

Whole-file reads:

- **One HTTP 400 no longer turns the larger output limit off for every later question.** A part
  refused as too large for the model's window with 32,768 output tokens was taken for a model that
  refuses that limit. After that, every later part of every question on that model, in that
  process, was sent with 4,096, and a model that thinks got no text. Such a refusal now says
  nothing about the limit, unless the window is no larger than 32,768.
- **A whole-file read is no longer blocked for the rest of the process by one part that the
  per-minute token limit refused.** A part reader of a reasoning model can ask for the larger
  output limit (32,768 tokens). When the provider refused that request as larger than its
  allowance a minute (OpenAI's 429 "Request too large … on tokens per min (TPM)", or Groq's 413 or
  429), the larger limit stayed learned, and every later part of every question for that model
  asked for it again and was refused: "Could not read any part of app.log: The request was larger
  than the model takes (HTTP 429)." Now an allowance of no more than 32,768 tokens turns the
  larger limit off for the model, and a larger one makes it forget the learned limit, as a refusal
  by the window does. With a fake OpenAI-compatible server, 12 of 12 parts were read in 15
  requests, where none were read in 34.

The adapters:

- **OpenAI-compatible: an error whose message is at the top of the body is read.** vLLM before
  its OpenAI-shaped errors, SGLang and FastChat put `message` there, and servers built on FastAPI
  put `detail` there (a list of problems gives their `msg` joined with "; "). A request too large
  for the model became "The model returned HTTP 400.", kind `"invalid"`, so the loop did not make
  it smaller.
- **OpenAI-compatible: an error inside a stream keeps its code.** `context_length_exceeded` (now
  HTTP 400, kind `"context_overflow"`) and `insufficient_quota` (HTTP 429, kind `"quota"`) were
  taken for server errors (HTTP 500) and sent three more times. `OpenAiRequestError.code` holds the
  code.
- **More wordings of a request too large for the model are known.** Text Generation Inference and
  Together ("`inputs` tokens + `max_new_tokens` must be <= 32769. Given: 40000 …", with both
  numbers), LM Studio ("loaded with context length of only 4096 tokens"), Amazon Bedrock ("Input
  is too long for requested model."), and the count in vLLM's newer "your request has 40000 input
  tokens".
- **OpenAI-compatible and Claude: a stream that said it is whole returns its reply, though the
  server then left the connection open, or the connection broke.** After `[DONE]` or
  `message_stop`, the body is read for at most one more second, and then it is cancelled, which
  closes the connection. With the whole answer already shown, such a stream failed: with kind
  `"timeout"` after `idleTimeoutMs` (300 s by default), or with kind `"unreachable"` when the
  connection broke.
- **A request whose body never finishes being cancelled no longer hangs** once its wait ran out.
  This happened with a `fetch` of a library or a test whose stream `cancel()` never settles. It
  fails with kind `"timeout"`, as it should.
- **`parseSseJson` no longer waits for the `return()` of an async iterable it reads**, as it does
  not wait for the `cancel()` of a web stream. An iterable of your own whose `return()` never
  settles held the caller for ever: on an event that is not JSON, after a `break`, and even at the
  end of a whole stream. So did an async generator that wraps a web stream whose `cancel()` never
  settles. A `return()`, or a `cancel()` of a reader of your own, that gives no promise or throws
  is no longer an error of the caller's either.
- **A streamed event longer than 64,000,000 characters ends the reply**, with an error of kind
  `"invalid"` and status 200 that is not sent again:
  `The model's reply could not be read: an event of its stream held more than 64,000,000 characters.`
  (Claude's and Gemini's say the same.) A server that sent one event without an end grew a string
  until it failed as `"unreachable"` ("The model could not be reached (Invalid string length)."),
  with 600 to 740 MB more memory, and the request was sent again up to three times. A server that
  sent data lines without the blank line that ends an event could stop the process with a heap out
  of memory. Such a reply now ends after about 62 MB of it, in 0.4 s, with 165 MB more memory. A
  reply made of many events, and a reply that is not streamed, have no cap yet.
- **OpenAI-compatible: a server that sends the name of a tool call again with each piece** no
  longer makes it `search_documentsearch_document`, which the loop answered as an unknown tool.
- **`parseSseJson` takes a CR alone for a line end**, as the format allows, and reads each piece
  of a body once. One event of 8 MB in pieces of 16 KB took about 0.95 s, because it was scanned
  again with every piece. It now takes 11 to 17 ms.
- **Claude: a part read that thought most of its output limit away and wrote a little is asked
  again with the larger limit** (`THINKING_OUTPUT_TOKENS`), as Gemini and OpenAI-compatible part
  reads are. Claude does not count its thoughts apart, so they are now taken as what it wrote
  besides its text, when it thought. Its notes came back cut: two lines out of 4,096 tokens.

Data written by 0.5.0 and 0.6.0:

- **A read that 0.5.0 cut without saying so is run again** when the model asks for those lines,
  instead of "already shown above in full". A pointer that 0.6.0 stored to such a read no longer
  says it either.
- **A search that 0.6.0 stored without its last match is run again**, not pointed to as one that
  "would return the same" (see **Upgrading**).
- **No half of a character reaches Claude.** 0.5.0 cut some log templates in the metadata, and
  search windows in stored tool rounds, inside an emoji, and 0.6.0 and earlier cut long file names
  that way; Claude's API refuses a request that holds such a half. The card, the frame, the tool
  guide, `get_document_overview`, tool results, steps and the rounds passed back now send a
  replacement character (U+FFFD) in its place, and `getMeta` returns a name the same way. The
  stored data is not changed, and text that is whole is sent as before.

Packaging:

- **npm installs llm-large-files next to unpdf 2.** The optional peer range of `unpdf` is now
  `^1.4.0 || ^2.0.0`. With 0.6.0, an app that already had unpdf 2 (on Node 24, what
  `npm install unpdf` gives) could not install llm-large-files: npm stopped with `ERESOLVE`.
  unpdf 2 asks for Node 24. The 12 PDFs of the tests give the same text, pages, picture marks and
  page cuts with every unpdf from 1.4.0 to 2.2.1.
- **unpdf 1.5.0 to 1.6.0 no longer stop the process on Node 20 and 22, and unpdf 1.9 and later
  fail on Node 20 with a message that says what to install** (see **Upgrading**). CI now also runs
  the tests with unpdf 1.7.0 on Node 20, the newest 1.x on Node 22 and 24, and the newest 2.x on
  Node 24, and checks the two refusals.
- **Tests reach paths that none reached:** the retry of a refused rename in `FileDocumentStore`
  (made to fail on every system, not only on Windows), the size limit of an upload, the page
  numbers of a PDF read by range, waits of 0 for a silent model, and a pointer whose result is
  shortened in the same turn.

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
