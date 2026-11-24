# How it works

This page follows a file from upload to answer: what ingest stores, how a request is planned, what
the model sees, what each tool does, and how the tool loop keeps every request inside the model's
limits. It is for developers who want to know why the library behaves as it does; the
[guides](./README.md) show how to use each part.

```text
upload ─► ingest ─► store        extract · normalize · profile · line index
                                 (and the uploaded file, for formats in keepOriginals)

question ─► plan the documents for the room left in the request, smallest first
              ├─ fits ─────► its whole text in the first user turn
              └─ too big ──► its card in the first user turn
                             + the tool guide in the system instruction
                             + tools: search · read · overview
                                      · aggregate (when a file may hold a table)
                                      · analyze-all (when the exploring model can read parts
                                        and a file is within maxMapChunks)
              a kept PDF, in either branch, when every model can be sent a file
                           ─► + tool: view_pages (the real pages, as a small PDF),
                                and its lines in the tool guide

         ─► tool loop: run the calls of a turn, fit their results to the room left, repeat
         ─► the answer: the model's last turn, or one more request that must be answered in text
```

## Ingest

`files.ingest({ name, bytes, mimeType?, owner?, signal? })` does five things, in order.

1. **Check.** An owner that is empty, spaces only or `null` is refused
   ([Security](./security.md#ownership)). The name is cleaned to one printable line: the last path
   segment, without control characters, line breaks, text-direction controls or most other
   characters that show nothing (variation selectors, joiners and Hangul fillers are kept), 255
   characters at most, never cut in the middle of a character. An empty file, or one over
   `maxUploadBytes` (100 MB by default), is refused.
2. **Extract** text by format, with the built-in extractors or your own (`extractors`). The format
   comes from the extension, then the MIME type, and is `text` otherwise.
   - **PDF** (needs the optional `unpdf`). Each page starts with a `--- Page N ---` line. Tables
     are rebuilt from the position of their text and written as `| cell | cell |  |` rows, so an
     empty cell stays an empty cell. A page that shows a picture or a drawing gets the line
     `[Picture on this page. This text cannot show it.]`. Those pages are found from the structure
     of the file: a small interpreter follows each page's drawing instructions and notes where
     images are painted and which shapes are filled, without decoding any image. That needs the
     optional `@cantoo/pdf-lib`; without it, and for a file of over 150,000 objects or one that
     takes over 5 seconds to go through, no page is marked. A page without text says
     `[No text on this page. It may be a scan, a photo, or a chart.]`.
   - **A PDF without any text** (a scan) is refused, unless its original is kept: then one of up
     to `scannedPdfPages` (30) pages is stored, to be read by looking at its pages.
   - **PPTX**: a `## Slide N` heading for each slide, numbered in the order of the slide show,
     with its tables as `| cell | cell |` rows and its speaker notes after `[Speaker notes]`, and
     the slide count as the document's `pages`. A slide that the slide show skips is headed
     `## Slide N (hidden, not shown in the slide show)`, and its text is kept. **DOCX**: the body,
     with its headings as Markdown headings, list numbers as Word shows them (`2.1`, `(a)`) and
     tables as rows of cells, then the footnotes, endnotes, comments, headers and footers, each
     under a heading of its own (a repeated header once). The text of a run that Word hides comes
     after the text of its paragraph that shows, each of its lines starting with
     `[Hidden text, not shown in the document]`, and a long line is cut into pieces, each marked.
     Text hidden through a style is not told apart
     ([Security](./security.md#hidden-text-in-word-powerpoint-and-html)). **XLSX**: a `## Sheet N: name`
     section for each sheet, a `Columns:` line, then a line a row, `Row 12: | East | 1200.5 |`,
     and the sheet count as `pages`. **HTML**: the text a browser shows, with headings, lists,
     tables and the addresses of links; text the page hides (the `hidden` attribute, an inline
     `display: none` or `visibility: hidden`) comes after its line, marked as Word's is. DOCX, PPTX and XLSX need the optional `jszip`.
   - **Text, logs, Markdown, JSON and CSV** are read as UTF-8, or as UTF-16 when they start with a
     byte-order mark or about half of their first bytes are zeros. A file that is not valid UTF-8
     is read in the older encoding it was saved in, or as UTF-8 with its characters that are not
     valid counted ([Text encodings](#text-encodings)). A compressed or other binary file is
     refused.
   - **Limits.** A PDF of more than `maxPdfPages` (5,000) pages is refused before its pages are
     read, and one whose page tree lists a page twice as soon as it does. With `@cantoo/pdf-lib`,
     the same reading of the file that finds the pictures first adds up what each page would make
     pdf.js run (its content, each form every time it is painted, the glyph programs of its Type3
     fonts), and refuses a page that would hold the server for more than about 1.5 s, or 32 times
     the size of the file in content when that is more, before pdf.js reads any page ([Pages that
     would hold the server](./guides/pdfs.md#pages-that-would-hold-the-server)). The text is counted
     as it is read, a PDF page by page and an Office file paragraph by paragraph or row by row, and
     the file is refused once it passes `maxTextBytes` (100 MB by default, or `maxUploadBytes` when
     that is larger); a PDF also past 100 times its size in text (after the first 16 MB); a DOCX,
     PPTX or XLSX also past 32 million characters of text, 1,000,000 paragraphs with text,
     paragraphs nested 32 deep, or 20,000 parts. The text of any other extractor, yours included, is
     checked when it returns.

   Formats, tables, the picture line, the refusals and your own extractors:
   [PDFs and other formats](./guides/pdfs.md).
3. **Normalize.** Strip a BOM, turn every line ending into `\n`, and remove most of what a person
   does not see in the file:
   - terminal escape sequences (colour codes, window titles, character-set selection), and control
     characters other than tab and newline, C1 (U+0080-U+009F) included;
   - characters that show nothing and that no script needs: tag characters, the zero-width space,
     the word joiner, the text-direction controls that reorder what a person sees, a byte order
     mark inside the text, and a soft hyphen that is not at the end of a line. What scripts and
     emoji need is kept: the marks of right-to-left text, zero-width joiners and non-joiners,
     variation selectors ([Security](./security.md#characters-that-show-nothing) lists both);
   - U+0085 (next line), which becomes a line break in a text that has no other one, such as a
     mainframe file converted to UTF-8, and is removed in any other text. Right after
     U+0080-U+00FF it is part of a UTF-8 letter read as Latin-1, and is removed there too.

   Then the text is composed (NFC): "e" followed by a combining accent becomes "é", as a model
   writes it in a query (since 0.8.0). No line break is added or removed, but for U+0085 in a text
   with no line feed. A text without these characters is kept as it is, and a line of megabytes is
   cleaned in pieces of 256K characters. Then lines over 2,000 characters are split, after a space
   or one of `,;}` near the end of a piece when there is one. A line that lost characters can be
   split into fewer pieces than 0.5.0 split it, which moves the lines after it. Every line-based
   tool then returns bounded output. A file with no text left is refused: "app.log did not contain
   any text."
4. **Profile.**
   - Count lines and characters, [estimate tokens](#token-estimates), and measure two sizes: the
     UTF-8 bytes, and the bytes the text takes as a string in a JSON request body (`jsonBytes`),
     which is what a request limit counts. Quotes, backslashes, tabs and line breaks take two bytes
     there; the planner uses this size.
   - A file detected as plain text becomes a **log** when it has at least 5 non-empty lines and at
     least 40% of the first 200 of them start with a timestamp or a level, or have the shape of an
     access log, a JSON log line, klog or logfmt.
   - Build an **outline**: headings with their line numbers. Markdown headings; after a blank
     line, lines that start with Chapter, Part, Book, Section or Appendix, or the Hebrew words for
     chapter, part and appendix, numbered headings such as `2.1 Scope`, and short lines in
     capitals. At most 400 entries: past that, the top-level headings alone when there are 20
     to 400 of them, each once and in order; otherwise 400 taken at even steps over the file,
     from the top-level headings when there are more than 400 of them, or from all the headings
     when there are fewer than 20 (see [`OutlineEntry`](./reference/library.md#outlineentry)).
     Logs, JSON and CSV get no outline. No heading is taken from a fenced code block, and in a
     plain text file that reads as code (a script, a configuration file) a `#` line is a comment,
     not a heading; in other plain text, only one after a blank line and not followed by another.
   - For a log, build a **profile**: lines by level (ERR counts as ERROR, WARNING as WARN, CRITICAL
     as FATAL; since 0.8.0 also a level in lower case in brackets, after `level=` or in a JSON
     field, pino's numbers and klog's letter), the first and last timestamp, and the ERROR, FATAL
     and WARN lines grouped by shape. Timestamps are removed, and UUIDs, IP addresses, hex, quoted
     values and numbers become `<id>`, `<ip>`, `<hex>`, `<s>` and `<n>`. So 81 timeouts to three
     hosts become one entry, `[ERROR ×81, L6] ERROR Connection timeout after <n>ms to <ip>`: the
     level, the count, the first line, and the template, which keeps the level word. The profile
     keeps 15 entries, FATAL first, then ERROR, then WARN, each by count.
5. **Store**, in this order: the uploaded file (when its format is in `keepOriginals` and the store
   has `putOriginal`), the line index (when the store has `putIndex`), then the text and its
   metadata (`put`). A document exists once its metadata does; if a write fails, what was written
   is deleted. The ID is `doc_` and 32 hex characters, and `expiresAt` is `ttlMs` (72 hours) later.

Steps 2 to 4 share the server with other requests. Each works in slices of about 12 ms, with a pause
between two slices: the PDF extractor and the picture marks between pages, the DOCX, PPTX and XLSX
extractors as they unpack, the text extractor as it decodes a file that is not UTF-8, and then the
normalizing, the measures, the outline, the log profile and the line index. Ingests that run at once
take turns, one slice each. They run under one signal, aborted by the caller's `signal` or after
`ingestTimeoutMs` (2 minutes): `ingest` then throws, and nothing is stored. A step under way when it
aborts, such as one page of pdf.js, runs to its end in the background, and holds the server while it
runs: pdf.js reads a page without a pause. [Security](./security.md#uploads) has the limits and the
stalls measured.

The **line index** holds, for each line, where it starts in the UTF-8 bytes and in the string, which
lines start a passage for keyword search (about 1,500 characters or 40 lines), and which lines are
`--- Page N ---` markers. That is a few bytes a line. It is written by any store that keeps one, even
one the library then loads whole. No term index is built: keyword search counts its terms when it
runs.

### Text encodings

A text file whose bytes are not all valid UTF-8 is one of two things. It is UTF-8 with a few
characters that are not valid: a log cut at a byte count, a stray byte, a binary body in a log
line. Or it was saved in an older encoding: Excel saves a Hebrew CSV in windows-1255. The text
extractor looks at each line, about a megabyte at a time with a pause in between, and decides:

1. **CESU-8.** When every fault is half of a surrogate pair, as an Oracle export or Java's modified
   UTF-8 writes an emoji, the pairs are joined and the file is read as UTF-8, emoji included.
2. **UTF-8, with a count.** A line counts as UTF-8 when it holds at least as many characters of
   more than one byte as characters that are not valid, as not UTF-8 when it holds more that are
   not valid, and as ASCII when it holds neither. When at least as many lines count as UTF-8 as
   count as not, or when at most one line in 200 is not UTF-8 (ASCII lines counted), the file is
   read as UTF-8. Each character that is not valid becomes U+FFFD, and
   `meta.replacedCharacters` counts them. A character cut in two by the start or the end of the
   file counts as UTF-8, and a byte-order mark always means UTF-8.
3. **An older encoding.** Otherwise the lines that are not UTF-8 and hold letters (a byte of 0xC0 or
   more), wherever they are in the file, up to 64 KB of them, choose the encoding. It is the first
   of these in which they read as the words of one script: windows-1255 (Hebrew; ISO-8859-8 too),
   windows-1256 (Arabic), windows-1251 (Cyrillic), Shift_JIS (Japanese, half-width katakana
   included) and windows-1252 (Western European; ISO-8859-1 too). Lines of signs alone (– ’ € °)
   choose only when no line has letters, and Shift_JIS is tried on the first 64 KB of the lines
   that are not UTF-8. When no line is UTF-8, the whole file is read in that encoding; otherwise
   each line that is valid UTF-8 is read as UTF-8, and the others in that encoding. A byte that the
   encoding does not have becomes U+FFFD and is counted. `meta.encoding` names the encoding.
4. **UTF-8 again.** When no encoding fits, the file is read as UTF-8 with the count, as 0.5.0 read
   it. No text file is refused for its encoding.

The model is told. The frame of a file sent whole adds `read as windows-1255`, or
`3 characters not valid UTF-8, shown as �`, after its line count ([The card](#the-card)), and the
card of a larger one has a line such as
`This file is not in UTF-8. Its text was read as windows-1255: if its letters look wrong, ask the user to save it as UTF-8.`
A file that is valid UTF-8, or UTF-16, is read as before, byte for byte.

What it gets wrong, as a rule:

- **Encodings it does not recognize** are read as UTF-8, with U+FFFD and the count: Greek, Turkish,
  Central European (windows-1250), Icelandic, KOI8-R and KOI8-U, the DOS code pages (437, 850,
  866), ISO-8859-5 and -6, EUC-JP, Chinese, Korean and Thai. So is a Japanese file of kanji with few
  or no kana.
- **A wrong encoding** is chosen for a file of a line or two (Greek capitals as windows-1251,
  "Dzień dobry." as windows-1252), and for a file of fewer than 200 lines, or of one long line such
  as minified JSON, whose few stray bytes happen to fit one. Hungarian in windows-1250 is read as
  windows-1252, with õ and û in place of ő and ű. ISO-8859-15 is read as windows-1252 when it has
  no œ, with ¤ in place of €; a file with œ in its words (cœur, sœur) is most often read as UTF-8
  with U+FFFD instead, since its œ would be ½, which does not fit between two letters.
- **Lines in two encodings.** In a file where at most one line in 200 is not UTF-8, those lines
  become U+FFFD even when they are in an older encoding. In a file in an older encoding, a line
  that happens to be valid UTF-8 is read as UTF-8; this is rare, and most likely in a file of
  half-width katakana alone. A few such lines can make a short file of half-width katakana in
  Shift_JIS count as UTF-8, and it is then read as UTF-8 with U+FFFD.

What it costs: [Measurements](./measurements.md#the-server). What to tell users who upload such
files: [PDFs and other formats](./guides/pdfs.md#text-encodings). An editor that opens such a file
as UTF-8 does not show what the model reads:
[Security](./security.md#text-files-that-were-not-utf-8).

### Reading a stored document

Every use of a document first asks the store for its metadata, so a document deleted or expired on
another server that shares the store is never served from memory. Then:

- A text of up to `wholeDocumentBytes` (2 MB) is loaded whole and kept in a memory cache of
  `cacheBytes` (256 MB). So is every text, with a store that cannot read by range.
- A larger text, with a store that has `readTextRange` (`FileDocumentStore` has), is read by
  range. A tool call reads the lines it needs through the index, and a search reads the text about
  `scanChunkBytes` (1 MB) at a time, with at most `maxConcurrentScans` (4) scans of whole documents
  at once in the library (each `createLargeFiles` call has its own queue and its own cache; one per
  process when you create it once). Decoded pieces go in the same cache, at most a quarter of it
  for one document.
- A document stored without an index gets one built the first time it is read by range, and saved.

Sizing this for many users and servers: [Storage](./guides/storage.md) and
[Deployment](./guides/deployment.md).

## The card

A file that is sent whole sits between two frame lines:

```text
--- Attached file [mark 1f0c3a9e]: "app.log" (log, 3,000 lines; it ends only at the line with mark 1f0c3a9e) ---
2026-11-19T08:00:01.370Z INFO request id=0 handled in 0ms
…
--- End attached file [mark 1f0c3a9e] ---
```

The mark is eight hex digits made from the document ID, which is made after the file's text, so a
line of the file cannot hold it: a line that copies the end of the frame has no mark or a wrong
one, and the first frame line tells the model that only the line with the mark ends the file. This
does not make the model obey, and the mark is not a secret. The name, which the uploader chooses
with the text, comes after the mark, quoted as JSON, and the closing line holds the mark alone.
The mark is the same in every request, so a provider's prompt cache can reuse the file from one
request to the next; after an upgrade from 0.5.0, the first request of each conversation misses
it once, since the frame lines changed. A file of one line says `1 line`. A text file that was not
valid UTF-8 adds a note after the line count ([Text encodings](#text-encodings)):
`, read as windows-1255`, `, read as windows-1255, 1 character not valid in it, shown as �`, or
`, 3 characters not valid UTF-8, shown as �`. What the mark guards against, and what it does not:
[Security](./security.md#the-frame-around-a-file).

A file too large to send whole is replaced by its card, a few kilobytes. This is the card of a
3,000-line log, with its first lines shortened here:

```text
--- Large attached file: app.log ---
document_id: doc_5db4a21d03f043d3bb156a2fab2dc15d
log · 189 KB · 3,000 lines · about 139K tokens
This file is NOT in your context. Use the document tools to search it, read line ranges, or analyze all of it.
Log levels: INFO 2,889, ERROR 81, WARN 29, FATAL 1
Time range: 2026-11-19T08:00:01.370Z → 2026-11-19T09:08:30.000Z
Most frequent problems (count, first line):
  [FATAL ×1, L2901] FATAL Primary database unreachable, failing over to replica <ip>
  [ERROR ×81, L6] ERROR Connection timeout after <n>ms to <ip>
  [WARN ×29, L8] WARN Slow query took <n>ms on table <s>
First lines:
  1| 2026-11-19T08:00:01.370Z INFO request id=0 handled in 0ms
  2| 2026-11-19T08:00:02.740Z INFO request id=1eef handled in 1ms
  …
  25| 2026-11-19T08:00:34.250Z INFO request id=2e668 handled in 24ms
--- End large attached file: app.log ---
```

A card holds:

- The name and `document_id`.
- The format, size, line count, page count (a PDF's pages, a PPTX's slides, an XLSX's sheets) and estimated tokens.
- A line that says the file is not in the model's context. When a whole-file read would be refused
  (the file is estimated at more than `maxMapChunks` parts, with 5% leeway), it says instead that
  the file can be searched and read by line ranges, and is too large to be analyzed whole. When
  `prepare` gets `wholeDocumentAnalysis: false` ([The plan](#how-the-plan-is-made)), it says only
  that the file can be searched and read by line ranges, whatever its size.
- For a PDF whose pages can be looked at, a line that sends the model to `view_pages` for pictures,
  charts and layout.
- For a text file that was not valid UTF-8, a line that says so: the encoding it was read in, how
  many characters were not valid, or both
  (`3 characters of this file were not valid UTF-8, and show as �.`).
- For a log: the levels, the time range, and the first 8 of the 15 problems the profile keeps
  (FATAL first, then ERROR, then WARN, each by count).
- The first 40 headings of the outline, and how many there are.
- The first 25 lines, numbered, each cut to 300 characters.

A model can often aim its first call from the card alone: a FATAL line with its line number, or a
heading of the outline. The rest of the profile and the whole outline are in
`get_document_overview`.

When any file is searchable or its pages can be looked at, the **tool guide** goes into the system
instruction, after yours. It names those files (quoted, so a file name that reads like an
instruction stays a name), says which tool does what, sends counting and listing to exact or regex
search, keeps the whole-file read for tasks that need meaning (a summary, a timeline, items judged
one by one), asks the model to call independent tools in the same turn, and to cite line numbers
like `(app.log L1203)`. The line on `analyze_whole_document` is left out when `prepare` gets
`wholeDocumentAnalysis: false` ([The plan](#how-the-plan-is-made)), or when every searchable file
is too large for it. For PDFs whose pages can be looked at, it adds when to use `view_pages`, what
its page numbers are, and not to describe a picture the model has not looked at.

## The plan

The plan decides which documents go into the request whole and which become cards.
[`askWithFiles`](./reference/ask.md#askwithfilesoptions) makes it once for each question, for the
budget fitted to its models, and once more after a request too large for the model
([below](#a-request-too-large-for-the-model)). In your own loop you make it with
`files.prepare(ids, base, options)` ([Your own adapter and loop](./guides/own-adapter-and-loop.md)).

### The budget of a question

The library's budget describes one model connection: `contextTokens`, `maxRequestBytes`, and the
fields that follow from them ([Costs and limits](./guides/costs-and-limits.md)). `askWithFiles`
fits it to the models of the question, the answering model and the explorer:

- **The window** is the smallest of the budget's `contextTokens` and every model's
  `capabilities.contextTokens`. It is then divided by the largest `tokenScale` of the models: the
  budget counts in the library's estimate, which is fitted to Gemini, and a tokenizer that counts
  1.35 times as many tokens (Claude's default) leaves a window that much smaller in those terms.
- **The reply.** The largest `capabilities.outputTokens` (Claude's `maxTokens`, 64,000 by default)
  comes out of that window, which never goes below a quarter of itself.
- **The request size** is the smallest of the budget's `maxRequestBytes` and every model's
  `capabilities.maxRequestBytes`.
- **Fields you set** with `budget` (on the library, or on the question) are kept, and lowered when
  they are too large for a smaller window. Fields you left out follow the window: a quarter kept
  free (`reservedTokens`, 64,000 at most), half of it for document text (`inlineTokens`, 200,000 at
  most) and for one part of a whole-file read (`mapChunkTokens`, 100,000 at most), and 12% of it,
  in characters, for one tool result (`toolResultCharacters`, from 1,000 to 24,000).

`result.budget` is the budget the question ran with. `files.budgetFor(overrides, limits)` gives the
library's budget fitted to any window and request size, as in the sample below.

### How the plan is made

For each question (in your own loop, each request you plan), `prepare(ids, base)` takes the size of
everything else in the request (`base.tokens`, `base.bytes`). `askWithFiles` passes the system
instruction, the conversation as it was asked, and the tool rounds of earlier questions in it, with
a margin of 2,000 tokens and 8,000 bytes. The plan needs only the metadata. It fills the room left,
smallest documents first, by estimated tokens:

- token room = `min(inlineTokens, contextTokens − reservedTokens − base.tokens)`
- byte room = `maxRequestBytes − 256 KB − base.bytes`

A document is sent whole if, with the ones chosen before it, it fits both. Its bytes are its JSON
size and 200 more. Otherwise it becomes searchable. The 256 KB are kept for the cards, the tool
declarations and the JSON around them.

- An ID given twice counts once. A document that was never there, was deleted, has expired or
  belongs to another owner is in `missing`, and `askWithFiles` throws `DocumentsNotFoundError` for
  it. One that disappears while its text or card is read is moved to `missing`, and the plan is
  made again.
- With `viewPages`, `viewable` lists the PDFs whose original is kept (and a store that can give it
  back), whether their text is sent whole or searched.
- Whether a whole-file read is offered for a file is decided from its metadata: about how many parts
  it takes, counting the `12345| ` prefix of every line, at most `maxMapChunks` with 5% leeway.
  `prepare` with `wholeDocumentAnalysis: false` offers it for no file: the tool guide does not name
  it, and no card offers it. Pass that when you call `files.tools()` without `generate`, its part
  reader ([Your own adapter and loop](./guides/own-adapter-and-loop.md)). `askWithFiles` passes it
  when you set `wholeDocumentAnalysis: false`, and when its exploring model has no `generateText`.

`askWithFiles` puts the texts and cards, in the order of `documentIds`, at the start of the first
user turn (`documentPlacement: "first"`, the default). They stay there as the conversation grows,
so a provider's prompt cache, which matches the start of a request, can reuse them on every
follow-up question: Gemini's own cache, and Claude's `cache_control`. `"last"` appends them to the
latest user turn instead, where they move with every turn and are billed in full each time. A
question with no searchable file and no viewable PDF is then one request, without tools.

To see a plan and a budget without asking a model:

```ts
import { readFile } from "node:fs/promises";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";

const files = createLargeFiles({ store: new MemoryDocumentStore() });
const meta = await files.ingest({ name: "app.log", bytes: await readFile("app.log") });

// The budget of a question on a model with a window of 128,000 tokens:
// inlineTokens 64,000 · reservedTokens 32,000 · mapChunkTokens 64,000 · toolResultCharacters 15,360
const budget = files.budgetFor(undefined, { contextTokens: 128_000 });

// The plan of a request whose other parts take about 3,000 tokens and 12,000 bytes.
const prepared = await files.prepare([meta.id], { tokens: 3_000, bytes: 12_000 }, { budget });
console.log(prepared.plan.inline.map((document) => document.name)); // sent whole
console.log(prepared.plan.searchable.map((document) => document.name)); // cards and tools
console.log(prepared.blocks.get(meta.id)); // the text or the card
console.log(prepared.instruction); // the tool guide, or ""
```

## Token estimates

`estimateTokens(text)` walks the text once and prices each kind of character, because the number
of characters in a token depends on the kind of text. Digits cost about a token each, so a flat 4
characters per token is right for a novel and three times too low for a log. The weights:

| Character | Tokens |
|---|---|
| A run of ASCII letters | 1.1 for the run, 1.3 more at each change of case inside it (`camelCase`, base64), 0.18 for each letter past the 6th (the 3rd for capitals), 0.5 for each past the 20th |
| A digit | 1.2 |
| A run of ASCII punctuation | 0.85, for its first character only |
| A line break | 2.2 |
| A tab | 1 |
| A space | 0 before a letter, 0.2 before anything else (once for a run of spaces). A run of spaces also costs 1 for each 16 spaces after its first, so 10,000 spaces are about 625 tokens; until 0.8.0 they cost nothing |
| Latin letters with accents (é, ü, ß) | 0.6 |
| Greek, Cyrillic | 0.4, 0.3 |
| Hebrew, Arabic | 0.52, 0.41 |
| Han, kana, Hangul | 0.7, 0.56, 0.7 |
| Other alphabets and syllabaries (Devanagari, Thai, Georgian) | 0.45 |
| Half of an emoji or another character outside the basic plane | 0.5 |
| Dashes, quotes, arrows, box drawing, anything else | 1 |

The sum is rounded up. The weights were fitted to Gemini's `countTokens` on 60 texts: prose in
eleven languages, source code, JSON, CSV and eight log formats (Gemini 2.5, 3.5 and 3.8 count
identically). On them the estimate lands between 0.98 and 1.7 times Gemini's count. It leans high
on purpose: overestimating only makes a file searchable a little sooner. The one kind of text it
counts low, at about 70%, is a long run of random letters in one case with no digits. The counts
by kind of text are in [Measurements](./measurements.md).

```ts
import { estimateTokens, jsonBytes } from "llm-large-files";

estimateTokens("2026-11-19T08:14:03.512Z ERROR payment-gateway timeout after 30000ms to 10.4.2.17"); // 53: 81 characters
estimateTokens("It was a bright cold day in April, and the clocks were striking thirteen."); // 18: 73 characters
jsonBytes('He said "no".\n'); // 19: the 14 characters, an escape for each quote and the line break, and two quotes
```

Tokenizers differ between providers. An adapter's `tokenScale` says how many of its model's tokens
one estimated token comes to: 1 for Gemini, and by default 1 for an OpenAI-compatible model and 1.35
for Claude. A tokenizer that groups digits counts fewer tokens than this estimate on logs and data, the
safe direction.

During a question the provider's own count corrects the estimate. After each reply the loop compares
the input tokens the provider counted (divided by that model's `tokenScale`) with its estimate of
the request, and multiplies its later estimates by the ratio, kept between 1 and 2. A provider that
refuses a request as too large can raise it to 8 ([below](#a-request-too-large-for-the-model)).

## Tools

A model reaches a searchable file only through tools, and only the documents of the question: an
unknown `document_id` is answered with the IDs it may use. This section says what each tool does and
why it is built that way. Each tool's arguments, results, defaults, limits and error texts, and the
rules every tool follows, are in the [tools reference](./reference/tools.md).

- **`search_document`** finds lines. In `keywords` mode (the default) it ranks the passages of the
  line index by BM25, computed when the search runs from substring hits: there is no term index to
  build or keep up to date, it works in any language, and "timeout" also matches "timeouts". The
  words of a query are split the way each script writes them (Chinese, Japanese and Thai have no
  spaces), and a Hebrew word with prefix letters also searches its stem. In
  `exact` and `regex` modes it returns the first `max_results` matching lines and the last one in
  the file (with the lines around each when `context_lines` asks for them; none by default), and
  `total_matching_lines` counts every matching line in the file, not only those shown; a line with
  several matches counts once. When not all are shown, a note says how many of how many, and
  `next_from_line` where to go on:
  `21 of the 442 matching lines are shown: the first 20 and the last (line 15269). To see the ones in between, search again with from_line 3108, or count them with group_by.`
  It can also search a range of lines (`from_line`, `to_line`), show the last matches
  (`order: "last"`), or count the matching lines per hour, per code or per message shape and show
  none (`group_by`): a question about errors per hour is one call. In regex mode `\w` and `\b`
  know the letters of every script.
  The last match is there for a question about when something last happened: shown only the first
  ones and the count, a model named a wrong line as the last
  ([Measurements](./measurements.md#reading-a-whole-file)). The count is exact unless the scan
  stopped early, which the result says; then the last match is not known, and not shown. A regex
  scan runs in short time slices with other work in between, under a time limit of its own and a
  budget the regex searches of a question share, so a pattern that backtracks without end returns
  partial results instead of holding the process.
- **`read_document`** returns a numbered line range, read through the line index, and says where to
  go on.
- **`get_document_overview`** returns more than the card: the whole log profile, the whole outline,
  the first and last lines, and about how many parts a whole-file read would take. That count is
  estimated from the metadata, without reading the text, and the overview says when it is over
  `maxMapChunks`.
- **`aggregate_table`** (new in 0.8.1) counts, sums, averages and groups the rows of one table of a
  file: a CSV file, a sheet of a workbook, a `| cell |` table of another document. It reads every
  row once, finds the header (a title row above it, a header of two or three rows), and runs no
  code, so a total over 50,000 rows is exact and costs one call; each group cites the lines of its
  first rows ([`aggregate_table`](./reference/tools.md#aggregate_table)). It is declared when a
  searchable file is a CSV, XLSX, DOCX, PPTX, PDF, HTML or Markdown file.
- **`analyze_whole_document`** reads a whole file in parts ([Map-reduce](#map-reduce)). It is
  declared when the exploring model has a part reader (`generateText`), `wholeDocumentAnalysis` is
  not `false`, and at least one searchable file is estimated within `maxMapChunks`.
- **`view_pages`** returns pages of a PDF as a file ([Looking at pages](#looking-at-pages)). It is
  declared when a kept PDF can be shown to every model of the question. The text tools are left out
  only when no file is searchable and there are pages to look at.

A tool that fails returns `{ error }`, with a message that names no path on the server, so the model
can try another way. What the scope means for prompt injection and owners:
[Security](./security.md).

Every result is capped at `toolResultCharacters` (the answer of a whole-file read at the larger of
that and 40,000 characters). In the loop it is cut further, never below 600 characters: to its
share of the room left in the request or, for the answer of a whole-file read, to the room the
other results of its turn left ([Room in the request](#room-in-the-request)). A list loses
entries from its end (an exact or regex search loses them from the end of its first matches, and
keeps the last one; with `order: "last"` it loses the earliest; with `group_by` it loses its
smallest groups, and by time keeps the others in time order), a read loses lines, and the result
says what was cut and where to go on.

## Looking at pages

Text cannot show a chart. `view_pages(document_id, from_page, to_page)` gives the model the pages
themselves: up to five a call (`MAX_VIEW_PAGES`), cut out of the kept original into one PDF of their
own. The adapter hands that PDF to the model: inside the function response for Gemini, as a
document block for Claude, as a `file` part after the tool results for an OpenAI-compatible model
with `pdfInput: true` ([the table below](#what-differs-between-providers)).

It is offered for a PDF whose original is kept (`keepOriginals: ["pdf"]`, and a store with
`putOriginal` and `getOriginal`), unless `viewPages` is `false`, and only when every model of the
question can be sent a file. An OpenAI-compatible model without `pdfInput`, or Claude with
`toolFilePlacement: "none"`, rules it out. A PDF whose text fits in the prompt gets `view_pages`
too, and only that: such a file is often a slide deck, with little text and a picture on every
page. Page numbers are the N of the `--- Page N ---` lines.

Cutting pages out of a PDF sounds like copying them. Copied the way PDF libraries offer it, a page
brings along everything it refers to:

- **Links.** A contents page links to every section. Each link holds a reference to its target
  page, so a copy took those pages too, with their pictures: the contents page of a report came out
  at 89% of the size of its file. Before copying, every page that is not wanted is replaced by null,
  so a link to it copies a few bytes and not the page. (Not an empty page: the cut must hold no
  objects that call themselves pages and are not among its pages.)
- **Shared resources.** FPDF, TCPDF, jsPDF and others write one list of all images of the file and
  give it to every page. A copy of one page carried all of them. The content of each wanted page is
  read to see which images it paints (with its forms, patterns, Type 3 fonts and the appearances of
  its annotations), and the page gets a list of only those. Nothing is dropped unless all content
  that could name an image was read.
- **Layers.** A file can hide a layer. The settings that say so are copied with the pages, or the
  hidden layer would show.
- **Page extras** that can hold a lot and are not needed to show the page (editor data, article
  threads, actions, a thumbnail) are dropped.

The cut needs `@cantoo/pdf-lib`. A file that declares over a million objects, or more objects than
60% of the free heap can hold at 1,700 bytes an object, is refused before it is read. An empty
password is tried, which opens the many files encrypted only against printing or copying. When the
library counts other pages than the text extractor did, the pages are not shown: a wrong page is
worse than none. Pages are left off the end until the cut fits; the result then says how many were
shown and where to go on.

The pages are counted against the request twice. As **bytes**: base64 makes them a third larger, and
they stay in the request until the question is answered, so the room for the next look shrinks.
The loop keeps a tenth of `maxRequestBytes` free (256 KB at least) and gives each look what is left
of the request, which the adapter measures as it would send it. As **tokens**: what the model bills
for a page (`pageTokens`: by default 530 for Gemini, 1,000 for an OpenAI-compatible model and 3,500
for Claude; the largest of the question's models, divided by the largest `tokenScale` of those
models), against half of
`reservedTokens`. With the default budget and Gemini that is 60 pages a question. When either runs
out, the tool says so and the model answers from what it has. The looks of one turn run one after
another, each with the room the one before it left.

The looks of all questions of a library take their turns too (new in 0.9.0). A look parses the
whole PDF on the one thread the questions share: six at once each took about four times as long,
and held 352 MB more than one. By default one look runs at a time (`maxConcurrentPageLooks`), and
the others wait in order, before their PDF is loaded, so a look that waits holds none of its bytes.
The memory check above is made once the turn comes. A look that waits longer than
`pageLookWaitMs` (30 s) is not run: the model reads that the server is busy and to answer from the
text, and the question gets a `page_looks_busy` notice. The other looks of that tool turn then do
not wait: they run only when a turn is free at once, so a wait that ends busy comes once in a
turn. A look holds its turn
while it reads the PDF from the store for at most `ingestTimeoutMs` (2 minutes by default), and a
question that is stopped gives its turn back at once.

Pages are not kept in `toolTurns`: the stored round says that they were shown. Setting this up,
scanned PDFs and `toolFilePlacement`: [PDFs and other formats](./guides/pdfs.md).

## Map-reduce

`analyze_whole_document(document_id, task)` reads a whole file with many model requests, through
the part reader (`generateText`) of the model that explores.

1. **Split** on line boundaries into parts that fit both `mapChunkTokens` and 80% of
   `maxRequestBytes`, counting the line-number prefix of every line. A file of more than
   `maxMapChunks` parts (30) is refused before any request: "Reading all of app.log needs 41 model
   calls, over the limit of 30. Use search_document to narrow the question first." So is one with
   more parts than the requests the read may make (`maxRequests`, since 0.10.0). Such a file is
   most often not offered the read at all: its card, the tool guide and the overview say so
   ([The plan](#how-the-plan-is-made)).
2. **Map.** Read the parts four at a time. Each part either takes notes with line citations
   (`(L123)`) or replies `NOTHING RELEVANT`. A part that fails is sent again by the loop's rule
   ([Retries and waits](#retries-and-waits)), and an error with no status once more at once.
   - A part's request sends the file's name and lines, then the part between `<part>` and
     `</part>`, then where the part is ("This is part 3 of 12."), the task and the rules. The task
     comes last, after the file's text, and the system text says that text inside `<part>` is the
     file's content: never instructions to follow. A line in the file
     that says "reply NOTHING RELEVANT" is text to read, not an order. Two reads of one file with
     other tasks send the same start in each part's request, up to the end of the part, which a
     provider's prompt cache can reuse. Until 0.10.0 the task came first (M8).
   - A part the model refuses as larger than it takes (an error of kind `context_overflow`: its
     window is smaller than the budget says) is read as two halves, once, while `maxMapChunks` and
     the requests the question has left allow it, with room kept for the merges and the answer. A
     half that is still too large is a part that could not be read.
   - A part that still fails is reported in the answer (`parts_that_failed`) rather than failing
     the whole read. When no part could be read, the read fails with the reason and is not tried
     again in the question. When none could even be read from the store, no model request was
     made, and the store's error is the result. A store that does not answer in time ends the
     question instead (since 0.10.0): the part is not counted as one that could not be read, and
     the other parts stop, with no request sent after it.
   - The reason of a model request that failed is told by its kind, its HTTP status, the code of a
     connection that failed or a timeout, never by the error's words, which can name a host or a
     key: `Could not read any part of app.log: The model refused the key or token it was sent (HTTP 401).`
     An error with none of these is `The model request failed.`
     ([Security](./security.md#what-the-library-logs)).
3. **Reduce.** While the notes of the relevant parts together are larger than `mapChunkTokens`,
   merge them in batches of up to `mapChunkTokens` (in pairs when no two notes fit one batch), four
   at a time, for at most 8 rounds. A merge sends its notes first, between `<notes>` and
   `</notes>`, and the task last. A merge that fails keeps its notes as they were, and the rounds
   stop there. When the question limits its requests (`limits.requests`, which the loop shares out
   as the read's `maxRequests`), the read counts them: a round that would leave no request for the
   answer is not made, and the answer is written from the notes that fit one request, in the order
   of the file, saying that the notes of the other parts are left out (`notes_left_out`). Until
   0.10.0 the merges went past the limit: a read of 27 parts given 32 requests made 40 (N12).
4. **Answer.** Write one answer from the notes, flagging contradictions, gaps and parts that could
   not be read. When this last step fails, or no request is left for it, the notes are the answer,
   with `notes_only: true`: they were paid for.

The result holds `parts_read`, `parts_with_relevant_content`, `parts_that_failed`,
`notes_cut_short`, `notes_left_out`, `answer_cut_short`, `notes_only` and the `answer`. While it
runs, the progress goes to `onActivity`: "Reading app.log: part 3 of 12…", and, with `onEvent`, comes
as `tool.progress` events with the `callId` of the read, each part a `request.start` and
`request.end` of role `"reader"`.

**Items.** With `output: "items"` (new in 0.10.0, M9), the parts list what the task asks for, and no
model writes the count. Each part replies with one JSON object a line, an item each: its line, a
label from the call's `labels`, a value, and a quote of its line. Code reads the replies leniently,
keeps an item only when its quote is on its line (compared without case, Hebrew points or final
letters), or on just one other line of its part, which it then takes; counts the same item once;
and counts the items by label.
There is no merge and no answer of the read: one request a part, so a read of 5 parts makes 5
requests. A part whose list is cut at the output limit is read again in halves, two levels at
most, within the requests the question has left. The result gives `total_items`,
`counts_by_label`, the first 50 items, and `unverified_items` for those that were listed but not
found on their line ([Tools](./reference/tools.md#items-output-items)). Its evidence holds the lines
of its items, which an answer can cite.

**Output limits.** Part notes and merged notes start at 4,096 output tokens, the answer at 8,192.
When a reply reaches its limit, or a provider's filter stops it (Gemini `SAFETY` and the like,
`content_filter`, Claude's `refusal` or `model_context_window_exceeded`), the result says the answer
is incomplete and points the model to exact search.

A model that thinks counts its thoughts in that limit. When a reply stops at the limit with nothing
written, or with half of the limit or more spent on thoughts, each adapter's part reader asks once
more with 32,768 (`THINKING_OUTPUT_TOKENS`, exported by `llm-large-files/gemini`), and starts there for later requests to that model in
the process. The first request to a model finds this out while the others wait, so one request is
wasted, not four. A model that refuses the larger limit (HTTP 400) is not asked for it again, but a
refusal of the request as too large for the model's window with that limit is no such refusal,
unless the window is 32,768 tokens or less. A request refused as larger than the tokens a minute
that the provider allows counts the same way, with that allowance for the window. Claude does not
count its thoughts apart: when a reply has thinking blocks, its part reader takes for thoughts the
output tokens it billed besides its text.

**Counting is search's job.** Even within its limits a model can skip items of a long list, so for
a complete list or an exact count, `search_document` in exact or regex mode is the reliable tool: it
reports `total_matching_lines`. The tool guide says so, and keeps the whole-file read for what
needs meaning: a summary, a timeline, items that must be judged one by one. A search shows the
first `max_results` matching lines (50 at most) and the last one; a longer list is read on with
`next_from_line`, its end with `order: "last"`, and counted by group with `group_by`, which shows
up to 200 groups. The live checks are in [Measurements](./measurements.md).

## The loop (`askWithFiles`)

One loop serves every model. A provider is an adapter that turns the loop's request into its own and
reads the reply back. Planning, tools, limits, room, retries, usage and the forced answer happen
once, in the core. `askGemini` is this loop with Gemini adapters ([below](#gemini-askgemini-gemini)).

A question goes like this:

1. Fit the budget to the models, and [plan the documents](#how-the-plan-is-made). Documents that
   are missing are settled by `onMissingDocuments`: by default the question fails before any
   request; with `"drop"` it is answered without them, with one line in the system instruction
   that says how many files are no longer available.
2. Send a request with the tools (`toolChoice: "auto"`) to the model that explores.
3. A reply without tool calls ends the tool requests. Its text is the answer, unless it is empty,
   the prompt was blocked, or it comes from an explorer. A reply with calls is a turn: its calls run, each result gets
   `tool_turns_left`, and the round of calls and results joins the conversation, sent again with
   every later request until the question is answered. The rounds come back in
   `result.toolTurns`; passed back in `messages` with the conversation, they let a later question
   use what this one found ([Conversations](./guides/conversations.md)). They are sent then
   without `tool_turns_left`, which counted the turns of their own question.
4. Repeat from 2 until the model answers, or until the tool turns, the room or the question's
   ceilings run out. Then one more request [must be answered in text](#the-request-for-the-answer).

### The calls of a turn

- **At most `limits.callsPerTurn` calls run** (8 by default; every limit is in
  [`AskLimits`](./reference/ask.md#asklimits)). The others are answered "Not run: one turn runs at
  most 8 tool calls. Send this call again if you still need it.", and a step says how many.
- **Before anything runs**, each call is looked at in order. A call that did not arrive whole is
  answered with what was wrong ([below](#empty-or-broken-turns)). A call made twice in the turn, or
  whose result is already in the conversation, is answered with a pointer
  ([below](#pointers-to-repeated-calls)). A whole-file read that would pass a ceiling of the
  question is refused with the numbers. The others run.
- **They run together**, four at a time, and are answered in the order they were made. Looks at
  pages run one after another, because each is given the room the one before it left. Regex
  searches do too: they share the time of the tool set.
- **Two searches in a row that failed in the same mode** get a hint with the second error: after
  two failed regex searches, to try exact or keywords mode; after two other failures, to check the
  arguments against the tool's description or answer from what it has.
- **Whole-file reads.** By default (`limits.wholeDocumentReads: 1`) each document may be read whole
  once a question; 0 refuses every read. A model that asks again, with the task put another way, is
  told to use the answer it has. A read that could read no part is not tried again either, and a
  model that asks again is told that it failed and why. A read refused before any model request
  (too many parts, a store that could not be read) is not counted. A read is priced before it
  starts, at its estimated parts and 3 more requests, and its file's estimated tokens in the
  exploring model's terms; one that would pass `limits.inputTokens` or `limits.requests` is
  refused with the numbers. The reads of one turn are counted together, and each may make its own
  requests and an even share of what the question has left.
- **`tool_turns_left`** in every result tells the model how many tool turns are left after this
  one: 0 when the room ran out. The tool guide asks it to call independent tools in one turn and to
  answer as soon as it has enough. The results of an earlier question, passed back in `messages`,
  are sent without it, so a model cannot take their 0 for its own. The first request of each
  follow-up question then differs from the requests of the question before it from that
  question's first tool round on, and a provider's prompt cache misses from there, once in each
  follow-up question.

### Room in the request

Every tool result stays in the conversation until the question is answered, and is sent again with
each later request. The loop counts the request as it grows, by the library's estimate and, once the
provider has answered, by the provider's own count ([Token estimates](#token-estimates)).

- **The limits.** Tool results may grow the request until half of `reservedTokens` is left free in
  the window; that half is kept for the answer. In bytes, the request may grow to
  `maxRequestBytes` less 2% (32 KB at least). The room left is counted in characters: two for each
  token left, and a third of each byte left, whichever is less.
- **Shared among the calls of a turn.** Before the calls of a turn run, the room that is left is
  shared among those that return text: each gets an even share, up to its cap
  (`toolResultCharacters`), and what a call with a smaller cap does not need goes to the others. A
  result is cut to its share and says where to go on. A call that is refused, or answered with a
  pointer, takes no room, and looks at pages have [room of their own](#looking-at-pages).
- **The answer of a whole-file read**, which cannot be asked for again, is not cut to a share: once
  the other results of the turn are in, it gets all the room they left (up to the larger of
  `toolResultCharacters` and 40,000 characters, and never below 600). An answer that does not fit
  is cut at its end, and says so in `answer_shortened`; the other fields stay.
- **Making room.** When the room is less than the calls of the turn could return together, older
  results are replaced by [stand-ins](#stand-ins): those of all but the last three tool rounds, then
  all but the last two, then all but the last one, as far as needed. `steps` then holds "Older tool
  results were shortened to make room in the request". When any model of the question, the
  answering model or the explorer, may only grow its conversation (`capabilities.appendOnly`:
  Claude), nothing is replaced during the question, for either model.
- **Before the first request** (new in 0.9.0), when the stored rounds of earlier questions make it
  larger than the room it has in tokens, their results are replaced the same way, as far as
  needed, before it is sent. Only the estimate of its tokens is checked, as after a refused
  request: a request is not shortened for its bytes alone. Nothing of the question was sent yet, and a stored round has no thinking in it, so
  this is done for an append-only model too. The request is what an overflow would have had sent
  again ([below](#a-request-too-large-for-the-model)), without the refused request before it.
- **No room left.** Calls that still cannot each get 1,500 characters (or their cap, when it is
  smaller) are answered "Not run: there is no room left in this conversation for another tool
  result. Answer now, from what the tools returned so far.", the last calls of the turn first, and
  the next request is the answer.

### Stand-ins

A stand-in is a short result in place of one that was dropped to make room. It keeps which document
it was about and what it showed, says `dropped: true`, and tells the model how to get it back. What
each tool's stand-in keeps, and which results are too small to replace, is in
[`stubResult`](./reference/ask.md#stubresultcall-result-hadfiles). Since 0.9.0 a result is never
replaced by a stand-in as large as itself or larger: a search counted by group, or an
`aggregate_table` result, of a few short groups stays as it is. The tool rounds a question
returns in `toolTurns` hold stand-ins for pages, since a file cannot be kept as JSON
([Conversations](./guides/conversations.md)).

### Pointers to repeated calls

A call whose result is still in the conversation in full is not run again: the files do not change,
so it would return the same and only take room. It is answered with a pointer, and its step says
"already shown above". That covers:

- the same search (same document, query and mode, and the same number of results, context and
  case, the defaults filled in) or the same overview: "Not run: this exact call was answered
  earlier in this conversation, and its result is still shown above in full…";
- a read of lines inside a read that is shown in full: "Not run: lines 40-60 are already shown above
  in full, in the result that has lines 1-200 of this file…";
- the same search, read or overview made twice in one turn: "Not run: call 2 of this turn is the
  same call, and its result is next to this one. Use it.";
- results in the tool rounds of earlier questions, passed back in `messages`.

A result of an earlier turn that was cut to its room (a list that says "Showing…", a read with
`text_cut`), replaced by a stand-in, that failed, or from a search that stopped early is not
pointed to: the call runs, and may get more. When a call is made twice in one turn, the second gets
the pointer whatever the first returns, even an error or a cut result. Only when the first is
refused for lack of room is the second refused the same way. Whole-file reads and looks at pages
are never pointed to. When a result is later replaced by a stand-in, the pointers to it become
stand-ins too, which say that the call was not run then and can be made again; a call of the
current turn that would have pointed to it runs instead.

Three more cases run the call again:

- **A read of one line in the rounds of an earlier question.** 0.5.0 cut a long line to its room
  without saying so, and stored reads cannot be told apart. Reads of more lines, and reads of the
  same question, are pointed to.
- **An exact or regex search that 0.5.0 stored**, with fewer matches than `total_matching_lines`
  and no note: it holds only the first matches, and a search made now shows the last one too.
- **Any call, with a model whose provider may clear old tool results on its side**
  (`capabilities.clearsToolResults`: Claude with `clear_tool_uses` or compaction in
  `body.context_management`). The model may no longer have the result a pointer names, so no call
  is answered with a pointer, every stored pointer is sent as the stand-in above, and the same call
  made twice in one turn runs twice.

### Empty or broken turns

- **A call that did not arrive whole** is answered with what was wrong, and not run: arguments that
  are not a JSON object, a call cut off at the output limit, or a Claude tool block that was never
  closed. The answer asks the model to send the call again.
- **A turn whose call could not be read at all** (Gemini's `MALFORMED_FUNCTION_CALL` or
  `UNEXPECTED_TOOL_CALL`), **or an empty reply** while no call of the question has been answered
  yet, is asked for once more, with a short note that says what was wrong. Without it the answer
  would be written from the cards alone, and look like any other. An empty reply that was cut off
  at the output limit or stopped by a filter is not asked for again.
- That second try happens at most twice a question, only when a turn is left besides the answer's,
  and not after a blocked prompt or once the question's ceilings are reached. It takes a tool turn.
  `steps` says "The model's tool call could not be read: it was asked to send it again" or "The
  model's first reply was empty: it was asked again". An explorer's note tells it to reply DONE.
- **The note is not kept in the conversation**, so the start of later requests stays the one the
  provider's cache holds. The exception is an exploring model whose conversation may only grow
  (`appendOnly`: Claude), which keeps it, because what it thinks next follows the note; when that
  model also answers, its later requests, the answer's included, have the note. An answering model
  other than the explorer never gets the explorer's notes.
- **An answer that comes back without text** (empty, or with a tool call the model was told not to
  make, such as Gemini's `UNEXPECTED_TOOL_CALL`) is asked for once more, with a note at its end
  that is not kept: "Your last reply had no text. No tool can be called in this reply: write the
  answer now, in text, from what is above." It is one of the two second tries of the question, and
  can be one request past `limits.toolTurns`, but it is not made after a refusal, a filter or a
  reply cut off at the output limit with nothing in it, nor once `limits.requests` or
  `limits.inputTokens` is reached. `steps` says "The model's answer was empty: it was asked again"
  or "The model called a tool instead of answering: it was asked again for the answer". With an
  explorer, this note goes to the answering model.

Gemini is the one adapter that reports a broken call as a turn of its own (`finish:
"malformed_call"`). The OpenAI-compatible and Claude adapters mark the call itself, which the
first point covers.

### A request too large for the model

The budget can assume a larger window than the model has, or the estimate can run low. A provider
that refuses a request as larger than the model takes (an error of kind `context_overflow`) does not
end the question:

- **Shorten and send again.** The loop takes the provider's numbers for the rest of the question:
  its count of the request raises the estimate (up to 8 times), and the window it names lowers the
  limit of the room. A later report of the input tokens, which otherwise moves the estimate within
  twice the estimate, does not take that back (since 0.7.1; before, the next good reply brought it
  down to twice, and the turn after filled the window and was refused again). It then replaces older results with stand-ins, the latest round too if needed,
  and sends the request again. `steps` says "The request was larger than the model takes: older tool
  results were shortened, and it was sent again". That happens at most twice a question, and once
  for any one request. When any model of the question may only grow its conversation (Claude),
  nothing is shortened. Since 0.9.0 the first request of a question is checked against the loop's
  own estimate first, and the stored rounds of earlier questions are shortened before it is sent
  ([making room](#room-in-the-request)): a history that grew past the window no longer costs a
  refused request, and no longer fails a question on Claude.
- **Plan again.** When it happens to the first requests of a question, before any tool call was
  answered or any text shown, the documents are planned again for a smaller window, once, as for a
  model that declares it. The window is the one the provider named, or seven tenths of the window
  the budget assumed when it named none, divided by how much more than the estimate the provider
  counted (by 1.25 when it named a window but gave no count). A result that is not smaller than the
  assumed window becomes seven tenths of it. This applies to any model, Claude included. What the first try paid
  for, the tool turns it took and its steps are carried over, and `steps` says why.
- **Otherwise** the error is thrown, with `kind: "context_overflow"` and the provider's
  `limitTokens` and `requestedTokens` when its message gives them.

A request larger than the tokens a minute that the provider allows (OpenAI's "Request too large …
on tokens per min (TPM)", HTTP 429, or Groq's, HTTP 413 or 429) is of the same kind, with that
allowance for the window: only a smaller request can pass it. Its steps name the allowance, as
"The first request was larger than the 30,000 tokens a minute that the provider allows: the files
were planned again to fit it".

### Retries and waits

- **Retries.** A chat request that failed with HTTP 408, 409, 429 or 5xx, or got no answer (status
  0), is sent again up to `retry.retries` (3) more times. The wait doubles from `baseDelayMs`
  (500 ms) with jitter, so it is 0.25 to 0.5 s, then 0.5 to 1 s, then 1 to 2 s, up to `maxDelayMs`
  (60 s), or it is the wait the provider asks for (`retry-after-ms`, `Retry-After`, or the
  `retryDelay` of Gemini's `RetryInfo`). A provider that asks for more than `maxDelayMs` is not
  waited for: the error is reported. Meanwhile `onActivity` says "The model did not answer (HTTP
  503). Trying again in 1 s…", and a `retry` event says the same, with the error's kind and status.
- **Not sent again**: a refusal such as 400, 401, 403 or 404; a quota that does not come back soon
  (kind `quota`: OpenAI's `insufficient_quota`, HTTP 402, Claude's credit balance and spending
  limits, a Gemini quota per day); an error of kind `context_overflow`, whatever its status, which
  only a smaller request can pass; one that Claude's API marks `x-should-retry: false`; a reply of
  HTTP 200 that is not JSON, such as a gateway's sign-in page (kind `invalid`); a request whose
  reply already showed text; a request after you stopped the question; and, in a chat request, an
  error with no status.
- **Silence.** Each adapter watches a chat request. One that gets nothing for `firstByteTimeoutMs`
  (600 s) before the first piece of its reply, or for `idleTimeoutMs` (300 s) between two pieces, is
  aborted (kind `timeout`, status 0) and sent again once, unless text of it was shown. Headers do
  not count as a piece: a model that thinks sends nothing until it has thought. Keep-alives do. A
  reply that keeps arriving has no limit. 0 turns a wait off.
- **A stream that closes without saying why it ended** was cut off on its way, by a proxy or a
  dropped connection. It is not taken for a whole reply: it is sent again when none of it was shown,
  and is an error otherwise. So is a reply of HTTP 200 whose body is empty. `onActivity` then says
  "The model's reply was cut off on its way. Trying again…".
- **A stream that said it is whole** (`[DONE]`, Claude's `message_stop`) returns its reply, though
  the server then leaves the connection open, or the connection breaks: its body is read for at
  most one more second, then cancelled. One event of a stream holds at most 64,000,000 characters;
  a longer one ends the reply with kind `invalid`, and it is not sent again. A reply asked for as a
  stream that comes under another content type is read as events or as JSON, as its first
  characters show; one that starts with more than 65,536 characters of white space is read as
  JSON, whatever follows.
- **Part reads** of a whole-file read follow the same rule, and an error with no status is tried once
  more at once. Their retries are not told to `onActivity`; since 0.7.0 they are `retry` events.
  They have no silence waits: each request has a limit of 180 s instead (`timeoutMs`
  of `openAiCompatible()` and `anthropic()`; fixed for `gemini()`). An error your token or header
  function throws in a part read has no status with `gemini()`; with `openAiCompatible()` and
  `anthropic()` it is a failed connection (status 0), sent again like one.
- **An HTTP error or a failed connection** is a `ModelRequestError` (`GeminiRequestError`,
  `OpenAiRequestError`, `AnthropicRequestError`) with a `status` and a `kind`:
  `context_overflow`, `quota`, `rate_limit`, `timeout`, `unreachable`, `server`, `auth` or
  `invalid` ([`ModelErrorKind`](./reference/errors-and-retries.md#modelerrorkind)). So is a reply
  of HTTP 200 whose body is not JSON: kind `invalid`, status 200, and the `SyntaxError` as its
  `cause`. Other errors have no kind: `DocumentsNotFoundError`, `DocumentStoreError`, an error your
  own token or header function throws in a chat request, an abort.
- **Stopping.** When the question's `signal` aborts, the question stops at once and throws the
  signal's reason, even when an adapter or a part reader does not look at the signal. Nothing is
  sent after that, and text that such an adapter sends later is not shown. A request still running
  then may be billed by the provider; it is not counted in the usage.
- **What a failed question found.** A question that fails once under way leaves its steps,
  evidence, tool rounds and usage to `partialResultOf(error)`, with `answered: false`. It is
  undefined for an error raised before the question was under way: a missing document, a budget
  that cannot work, a store that failed while the documents were planned.

What to show a user for each error: [Errors and reliability](./guides/errors-and-reliability.md).
The retry rule and the waits as exports:
[Errors, retries and streams](./reference/errors-and-retries.md).

### The request for the answer

When the model's last turn has text and no calls, that text is the answer. Otherwise one more request
is sent to the answering model, and it must be answered in text:

- **When.** The tool turns ran out (`limits.toolTurns`, 12 by default: tools run in at most 11
  requests, so no request is made whose calls would be thrown away), the room ran out, the question
  reached `limits.inputTokens` or all but one of `limits.requests`, or the model's last turn had no
  text (cut off, stopped by a filter, or a broken call). With an explorer it is always made. It is
  not made after a blocked prompt, which would only be blocked again.
- **What.** The conversation, then a user message: `FINAL_ANSWER_REQUEST` after text tools,
  `FINAL_ANSWER_AFTER_PAGES` when the only tool offered was `view_pages` (every text was in the
  prompt), or `FINAL_ANSWER_WITHOUT_TOOLS` when no call was answered at all. For Gemini the request
  declares no tools; for an OpenAI-compatible endpoint and for Claude it keeps them and sets the
  tool choice to none.
- **Its result.** `answered` is true when the reply has text and the prompt was not blocked. A
  reply with no text is asked for once more ([Empty or broken turns](#empty-or-broken-turns)). When
  even that has no text, or the provider blocked the prompt, `answered` is `false` (with
  `blockReason`), so your application can show its own message instead of an empty answer.

### An explorer model

One model does all of the above unless the question has an explorer: `askWithFiles({ model,
explorer })`, where the two may be of different providers, or an `askGemini` endpoint that names one
([An explorer model](./guides/explorer-model.md)). Then the loop is split in two:

- **The requests with tools go to the explorer.** It gets the same conversation, the same tool guide
  and `EXPLORER_INSTRUCTION`: gather what the answer needs, then reply `DONE`. Its turns go back to
  it unchanged, thought signatures included. Reading a whole file in parts is its work too, with its
  own part reader. Its words are not shown, and nothing it writes is the answer.
- **The request for the answer goes to the answering model**, and with an explorer it is always
  made. It holds the conversation, the explorer's tool calls and their results, pages included,
  and the closing user message. It does not hold the explorer's thoughts, its thought signatures,
  its remarks or its notes: the answer is written from what the files say.
- **The budget fits both models**: the smaller window, the larger `tokenScale`, and pages at the
  larger `pageTokens`. `view_pages` needs both to take a file. `limits.toolTurns` counts the
  explorer's requests and the answer's, so the explorer has one less.

### Usage and evidence

- **Usage** is summed over every request of the question that was answered: the chat's, the
  explorer's and the part reads, in all and for each model (`usage.byModel`, by adapter `id`). A
  request that failed and was sent again counts once. A part reader that does not report its tokens
  still counts its requests. `turns` counts the chat requests alone, and `lastUsage` is the
  provider's own usage object of the last chat response. Turning it into a cost:
  [Costs and limits](./guides/costs-and-limits.md).
- **Evidence** is read from the tool calls, in call order: for each call that ran, the document and
  the lines or pages it showed (merged into ranges). A search adds its query and mode, and an exact
  or regex search its `totalMatchingLines`. An overview shows the first 30 and last 20 lines. A
  whole-file read is marked `whole: true`, with its task as the query. Calls that failed or were
  refused, pointers and stand-ins add nothing.

### What your application sees

- `onText`: the answer as it arrives. Without an explorer, a remark the model makes before a tool
  call is shown too, separated by a blank line, and is part of `text`; `answered` is about the last
  turn.
- `onActivity`: short-lived status. "Too large to read at once: app.log. Searching instead…", each
  call as it runs ("Search app.log (exact) for “timeout”…"), the parts of a whole-file read,
  retries, and "Writing the answer…".
- `onStep` and `steps`: each finished call with what it found ("Search app.log (exact) for
  “timeout” — 12 matching lines"), and what the loop did to the conversation.
- `onEvent`, or `askStream` (new in 0.7.0): all of the above and more, as typed events in order,
  each with a `seq` from 1, from `run.start` to `run.finish` or `run.error`. The three callbacks
  get the same strings, at the same moments, with or without it. See
  [Events](./reference/events.md).

Where the events of a question come from:

| Event | Sent by | When |
|---|---|---|
| `run.start` | `askWithFiles` | First, before the options are checked or the documents planned. |
| `plan` | the plan | Once the documents are planned; again after a question planned again (a `replanned` notice comes first). |
| `request.start`, `request.end` | each chat request (`role` `"tools"`, `"explorer"` or `"answer"`) and each request of a whole-file read (`"reader"`, with its `callId`) | Around the request, its retries included. An overflow made smaller is a new request. |
| `retry` | the retry rule ([Retries and waits](#retries-and-waits)) | Before each wait, between the request's start and end. |
| `text` | the answering model's replies | As the text arrives with `streamText`; otherwise once each reply is in. The same text as `onText`. |
| `tool.start`, `tool.progress`, `tool.end` | the calls of a turn ([The calls of a turn](#the-calls-of-a-turn)) | A call starts when it runs, so starts and ends of one turn interleave; ends come in call order. `tool.progress` is the progress of a whole-file read. |
| `notice` | the loop | What it did that is not a request or a call: `searching_instead`, `writing_answer`, `replanned`, `room_made`, `nudged`, `results_shortened`, `answer_again`, `calls_not_run`, and those that the callbacks never got: `budget_reached`, `no_room`, `blocked`, and, new in 0.9.0, `documents_missing`, `document_gone` and `page_looks_busy`. |
| `run.finish`, `run.error` | `askWithFiles` | Last, once. Nothing comes after them, not even a part read still running. |

The events tell a model error by its kind and status, never in the provider's words, and carry no
text of the documents unless the question is asked with `eventResults: true`. An ingest has its own events, from `ingest.start` to
`ingest.finish` or `ingest.error` ([`files.ingest`](./reference/library.md#filesingestinput)).

Activity lines and steps are each one line of plain text, cleaned of what file text drops, and a
call to a tool that does not exist is shown as `Call “<name>”`. They quote the model's words: show
them as plain text ([Security](./security.md#what-the-library-logs)).

In this sample, `files` and `meta` come from the sample in
[How the plan is made](#how-the-plan-is-made), and `accessToken` is the function shown in
[Gemini API and Vertex AI](./guides/vertex-and-gemini.md), which returns a Vertex AI access token.

```ts
import { askWithFiles, partialResultOf } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";

// files and meta: from the sample in "How the plan is made".
// accessToken: the function of the Gemini API and Vertex AI guide.
const model = gemini(vertexAi({ project: process.env.GOOGLE_CLOUD_PROJECT!, model: "gemini-3.8-flash", accessToken }));

try {
  const result = await askWithFiles({
    files,
    model,
    documentIds: [meta.id],
    messages: [{ role: "user", text: "Why did the database fail over?" }],
    onActivity: (text) => console.log(`[now] ${text}`),
    onStep: (text) => console.log(`[step] ${text}`),
  });
  console.log(result.answered, result.text);
  console.log(result.plan.searchable.length, result.budget.contextTokens); // the plan and the fitted budget
  console.log(result.evidence, result.usage.requests, result.turns);
} catch (error) {
  // What the question found and paid for before it failed, when it was under way.
  console.log(partialResultOf(error)?.steps);
  throw error;
}
```

### What differs between providers

What differs is in the adapters:

| | Gemini (`gemini()`) | OpenAI-compatible (`openAiCompatible()`) | Claude (`anthropic()`) |
|---|---|---|---|
| The model's turn goes back | unchanged: thought signatures | unchanged (`reasoning_content`, OpenRouter's `reasoning_details`), but arguments that are not a JSON object, or are empty, go back as JSON (`"{}"`) | unchanged (thinking blocks), but an empty text block after the last thinking block is left out |
| The request for the answer | no tools declared | `tool_choice: "none"`, tools kept; `answerWithoutTools: "omit"` leaves them out | `tool_choice: { type: "none" }`, tools kept |
| Pages of `view_pages` | inside the function response, or in a user turn of their own with `toolFilePlacement: "beside"` | a `file` part in a user message after the results, only with `pdfInput: true`; otherwise not offered | a document block in the tool result; after the results with `toolFilePlacement: "beside"`; not offered with `"none"` |
| A page costs (`pageTokens`) | 530 by default | 1,000 by default | 3,500 by default |
| `tokenScale` | 1 | 1 by default (`tokenScale`) | 1.35 by default (`tokenScale`) |
| Kept free in the window for the reply | nothing | nothing | `maxTokens`, 64,000 by default |
| Request size declared | none, unless you set `maxRequestBytes` | none, unless you set `maxRequestBytes` | 32,000,000 bytes by default (`maxRequestBytes`) |
| Old results shortened for room | yes, unless Claude is the other model of the question | yes, unless Claude is the other model of the question | no: the conversation may only grow (`appendOnly`); with Claude as the answering model or the explorer, nothing is shortened for either during the question. The stored rounds of earlier questions are, before its first request, when they make it too large (since 0.9.0) |
| Prompt cache | the provider's own | the provider's own | `cache_control` on each request: 5 minutes, `cache: "1h"`, or `false` for none |
| Streams the chat | when the loop asks for the text as it is written (`streamText`: with `onText`, or in `askStream`) and the endpoint has a `streamUrl` | when the loop asks for the text as it is written, unless `stream: false` | always, unless `stream: false` |
| A whole stream ends with | a chunk with a `finishReason` | a `finish_reason`, or `[DONE]` | a stop reason |

The adapters also handle what their providers do differently:

- **OpenAI-compatible.** Two user turns in a row are sent as one, since some servers refuse them.
  The output limit of a part read is `max_completion_tokens` on OpenAI and Azure OpenAI hosts and
  `max_tokens` elsewhere, and a server that refuses the name it got is sent the other, which is
  kept. An error inside a stream that began with 200 gets the status its code or type names, or
  500, and keeps its code (`context_length_exceeded`, `insufficient_quota`). An error whose message
  is at the top of the body (vLLM before its OpenAI-shaped errors, SGLang, FastChat) or in FastAPI's
  `detail` is read. DeepSeek's `insufficient_system_resource` is a 503, sent again. A tool name sent
  again with each piece of a stream is taken once. A refusal is kept as the reply's text.
  [OpenAI-compatible endpoints](./guides/openai-compatible.md).
- **Claude.** Call IDs of other providers and of stored rounds are rewritten to what the API takes,
  each once in a request. After a server-side fallback, the thinking and tool-use blocks written
  before the switch are left out of the turn that goes back, and the tool calls among them are not
  run. A refusal is reported as `blockReason` (`refusal`, with its category). A failed tool result
  is marked `is_error`. An error inside a stream gets the status of its type
  (`invalid_request_error` 400, `authentication_error` 401, `billing_error` 402,
  `permission_error` 403, `not_found_error` 404, `request_too_large` 413), and a type it does not
  know is 500, sent again when none of the reply was shown. With `clear_tool_uses` or compaction in
  `body.context_management`, the adapter declares `clearsToolResults`
  ([Pointers to repeated calls](#pointers-to-repeated-calls)). [Claude](./guides/anthropic.md).

## Gemini (`askGemini`, `gemini()`)

`askGemini` is `askWithFiles` with a `gemini()` model for the endpoint. When the endpoint names an
explorer (`explorerUrl`, which `explorerModel` of `geminiApi()` and `vertexAi()` sets), it makes a
second `gemini()` for it, called with the same headers, without streaming, with
`explorerGenerationConfig` or else `generationConfig`. `maxToolTurns` and `maxToolCallsPerTurn` are
the names that `limits.toolTurns` and `limits.callsPerTurn` had before 0.5.0; `limits` wins.
`contents` are converted to messages with `fromGeminiContents`: since 0.9.0 the tool rounds that
`geminiToolTurns` wrote come back as stored rounds, so pointers and stand-ins apply to them, and any
other function part is sized by its JSON. Everything above applies; what is Gemini's own:

- **The model's turns go back unchanged**, so Gemini 3 thought signatures stay intact. A signature
  belongs to the model that wrote it: with an explorer, the answering model gets the explorer's
  function calls without them, and its request ends with the closing user message after the
  function responses.
- **The request for the answer declares no tools at all.** Gemini can ignore
  `functionCallingConfig: { mode: "NONE" }` and keep calling tools on the turn meant to force an
  answer. The tool requests use mode `AUTO`.
- **Finish reasons.** `MAX_TOKENS` is a reply cut off at the output limit. `SAFETY`, `RECITATION`,
  `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` and `IMAGE_SAFETY` mark a reply a filter stopped.
  `MALFORMED_FUNCTION_CALL` and `UNEXPECTED_TOOL_CALL` are a broken call, asked for once more. A
  prompt Gemini blocks (`promptFeedback.blockReason`) ends the question with `answered: false` and
  `blockReason`.
- **Pages** go inside the function response: `functionResponse.parts` holds the PDF, and the result
  names it as `{ "$ref": "pages-12-14.pdf" }`. Gemini 2.5 does not see a file there, so
  `toolFilePlacement: "beside"` sends the pages in a user turn of their own, right after the turn of
  function responses. They do not share that turn, because Vertex AI refuses a turn in which
  anything follows a function response.
- **Errors.** `error.status` and `details` tell the kind: a 429 whose `QuotaFailure` names a quota
  per day, or whose message alone does, is `quota`, not sent again, while a quota per minute is
  waited for; `API_KEY_INVALID` is `auth`. The `retryDelay` of `RetryInfo` is the wait. A streamed
  reply that comes as one JSON chunk, or a list of them, is read.
- **Usage.** Input is `promptTokenCount` plus `toolUsePromptTokenCount`, cached input
  `cachedContentTokenCount`, output `candidatesTokenCount` plus `thoughtsTokenCount`.
- **Part reads** go to the non-streaming URL of the model that explores, with
  `{ maxOutputTokens }`, with no temperature (Gemini 3.6 and later ignore one), unless
  `analysisConfig` says otherwise, and a limit of 180 s per request. Headers are asked for with
  every request, chat or part, so an access token renewed meanwhile is used.

Setting up Gemini and Vertex AI, thinking, quotas and gateways:
[Gemini API and Vertex AI](./guides/vertex-and-gemini.md).

## Live results

The live checks of the loop, the token estimate, map-reduce and `view_pages` are in
[Measurements](./measurements.md).

The events of 0.7.0 were checked live on the Gemini API in November 2026, with
`gemini-3.1-flash-lite` answering and `gemini-3.5-flash-lite` exploring, on a log of 60,000 lines
(7.2 MB) and a smaller one read whole. In each question the events ran in order from `run.start`
to `run.finish`, every request and call that started ended, the `text` events joined to the
answer, and `onStep` got the same steps as before. The explorer's requests were marked `role: "explorer"` and the answer's
`role: "answer"`. A whole-file read made 7 part requests, each with the `callId` of its call and a
`tool.progress` for each part, and its 21 retries came as `retry` events. `writeSseEvents` sent a
question to a client over HTTP, one message per event, ending with `run.finish` without
`toolTurns`.
