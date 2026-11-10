# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org).

## [0.3.0] - 2026-11-10

The model can look at the pages of a large PDF. Until now such a PDF reached it as text only, and
pictures, charts and diagrams were lost. Everything here is off until you turn it on: an
application that changes nothing, and does not install the new optional dependency, sends the same
requests as with 0.2.0 (checked byte for byte against the published 0.2.0 over eight scenarios).

### Added

- **`view_pages`: the real pages of a PDF, on request.** The tool cuts up to five pages out of the
  uploaded file and returns them as one small PDF, which Gemini reads like any PDF. Asked which bar
  of a chart is tallest, `gemini-3.5-flash-lite` said from the text alone that it could not see the
  chart; with the tool it looked at the page unasked and answered correctly. For ten questions that
  the text answers, it did not look at a page once. A page costs about 530 tokens. See
  [Pictures in PDFs](docs/configuration.md#pictures-in-pdfs) for the limits and the measurements.
  - It needs the new optional dependency `@cantoo/pdf-lib`, and the uploaded file (next item).
  - `askGemini` offers it for every PDF whose original is kept, also for one whose text fits in
    the prompt (a slide deck of photos has little text). `viewPages: false` turns it off.
    `toolFilePlacement: "beside"` sends the pages next to the function response instead of inside
    it, for an endpoint that refuses the first; Vertex AI has not been checked.
  - In a loop of your own: `prepare(ids, base, { viewPages: true })` lists the PDFs in
    `PreparedContext.viewable`, `tools(documents, { viewPages })` declares the tool, and
    `ToolSet.executeWithFiles(name, args, { maxFileBytes, maxPages })` returns `{ result, files }`.
    The tool is declared only on request, and `execute()` answers it with an error, because a loop
    that drops the file would tell the model that pages are attached with nothing attached.
  - Search and read results carry page numbers (`page`, `pages`) for a PDF that can be shown.
- **`keepOriginals`: keep the uploaded file.** `createLargeFiles({ keepOriginals: ["pdf"] })`
  stores the file next to its text. It is off by default, because a kept file takes disk space, up
  to the upload limit, until the document expires. `DocumentStore` has two new optional methods,
  `putOriginal` and `getOriginal`; a store without them works as before and keeps nothing.
  `FileDocumentStore` writes `<id>.bin`, and delete, expiry and sweep remove it.
  `DocumentMeta.originalKept` records it, and `files.getOriginal(id, { owner })` returns the file
  to its owner.
- **Scanned PDFs of up to 30 pages are accepted** when their original is kept: the model reads them
  by looking at the pages. `scannedPdfPages` sets the limit, and 0 refuses them as before. A longer
  scan, and any scan without a kept original, is still refused.
- `createPdfExtractor({ pictures })`, `ExtractInput.scannedPages`, `MAX_VIEW_PAGES`,
  `FINAL_ANSWER_AFTER_PAGES`, and the types `ToolFile`, `ToolOutput`, `ToolFileLimits`,
  `PrepareOptions` and `GeminiToolFilePlacement`.

### Changed

- **A page of a PDF that shows a picture is marked**, with one line under its header:
  `[Picture on this page. This text cannot show it.]`. A picture is images that cover 3% of the
  page or more, other than a logo or background that is on most pages; a drawing is shapes filled
  in three or more colours, outside the tables. The pages are found from the structure of the file,
  without decoding any image: a PDF of 200 photos took 0.3 s to ingest before and takes 0.8 s now.
  This needs `@cantoo/pdf-lib`. Without it, and with `createPdfExtractor({ pictures: false })`, the
  text is exactly that of 0.2.0. Documents already in a store keep the text they were ingested
  with.
- `ToolSet` has a new method, `executeWithFiles`, `LargeFiles` has `getOriginal`, and
  `PreparedContext` has `viewable`. Code that builds these objects itself (a test double, for
  example) has to add them.

### Known limits

- A chart in one or two colours, and a drawing made only of lines, is not marked. The model can
  still look at the page: it did so for a one-colour chart that had only a caption.
- Every look reads the whole PDF into memory: 0.06 s for 100 MB of photos, but 4 to 5 seconds and
  700 MB for a file of 330,000 objects. A file that declares more objects than memory allows is
  refused. Reading cannot be interrupted, so a crafted PDF can hold the process for a long time:
  see [Security](docs/security.md#reading-pdfs-for-pages-and-pictures).
- Tested with PDFs made by Chrome, Word and PowerPoint. PDFs made by LaTeX and InDesign were not
  tested. For FPDF, Ghostscript and scanners, the structures they are known to write were tested
  with files made for the purpose, not with files from those tools. Encrypted PDFs were tested
  with files encrypted by the library itself, and confirmed as encrypted by pdf.js.

## [0.2.0] - 2026-11-10

### Fixed

- **Token estimates were far too low for logs and data files.** `estimateTokens` assumed 4
  characters per token, which holds for prose only: Gemini counts about one token per digit. A
  service log was estimated at 37% of its real size and a CSV of numbers at 26%, so such files were
  sent whole, and split into parts, at about three times the configured budget. The estimate now
  prices each kind of character and was fitted to Gemini's `countTokens` on 60 texts; it lands
  between 0.98 and 1.7 times the real count. Documents already in a store keep the estimate they
  were ingested with until they expire.
- **A regex search could freeze the server.** Patterns such as `((a+))+$` and `(a|a)+$` passed the
  nested-quantifier check and never finished on a 40-character line; the 3-second limit was only
  checked between lines. Regex scans now run under a hard time limit that interrupts a match in
  progress.
- **`askGemini` could return a remark instead of an answer.** If the model wrote "Let me search…"
  with a tool call and its next turn came back empty (cut off, or a malformed tool call), that
  remark was returned as the answer. The tool-free request is now sent whenever the model's last
  turn has no text.
- **A blocked prompt resolved as an empty answer with no reason.** The result now has
  `answered: false` and `blockReason`.
- **One model request was wasted when the tool turns ran out.** The last request was sent with
  tools, its calls were discarded, and then another was sent without tools. `askGemini` now goes
  straight to the tool-free request, so it never makes more than `maxToolTurns` requests.
- **Case-insensitive search found nothing in a file containing "İ"** (U+0130), in exact and
  keyword mode: the whole file silently fell back to case-sensitive matching.
- **Coloured logs lost their profile.** Only the ESC byte of a terminal colour code was removed,
  leaving `[31mERROR[0m`, which no longer matched as a level. Whole escape sequences are removed.
- **Compressed files were accepted as text.** A `.gz` log became a document of garbage. Gzip and
  ZIP files are refused with a message that says what to do, and other binary files without zero
  bytes are now detected too.
- **Ingest failed with "Maximum call stack size exceeded"** on files with a few hundred thousand
  short heading-like lines.
- **A file name could add lines to the prompt.** Control characters, line breaks, and
  text-direction overrides are removed from names at ingest, and names are quoted in the system
  instruction.
- **Whole-document reads hid that they were incomplete.** When part notes or the final answer
  reach the output limit, the tool result now says so (`notes_cut_short`, `answer_cut_short`, and a
  `note` telling the model to say so and to use exact search for complete lists). If no part can be
  read, the tool returns an error instead of an answer written from nothing.
- `read_document` reported a line range past the end of the file when no end line was given.

- **Words of right-to-left text in a PDF were glued together** when the file stores them piece by
  piece (as Word does): `יתרת סגירה4,167.90`. pdf.js adds the space only between pieces that run
  left to right. The space is now added from the positions.

### Changed

- **PDF tables are rebuilt.** A PDF stores text at positions, not tables. In file order, a row
  with an empty cell reads like a row without that column, so a model takes the next value for the
  missing one. The PDF extractor now finds tables by the position of their text and writes each
  row as `| cell | cell |  | cell |`. In a live test (`gemini-3.5-flash-lite`, 110 questions about
  single cells of seven PDFs made by Word and Chrome), 44 answers were right from the old text and
  110 from the new. It also handles tables in one column of a two-column page, right-to-left and
  sideways tables, headings that span columns, and wrapped cells; text that is not a table is left
  as it was. Two-column tables are left as text. See
  [PDF tables](docs/configuration.md#pdf-tables) for the limits.
  `createPdfExtractor({ tables: false })` gives the previous text. Documents already in a store
  keep the text they were ingested with.
- **A PDF page without any text is marked** `[No text on this page. It may be a scan, a photo, or a
  chart.]` instead of being left empty, so the model can say that it cannot see the page.
- **Documents are placed at the start of the first user turn**, not appended to the latest one.
  The document then stays in the same place as the conversation grows, so Gemini's prompt cache
  reuses it: in a live test, a follow-up question about a 53,000-token document had 96% of its
  input served from cache, against 0% before. Pass `documentPlacement: "last"` to `askGemini` for
  the previous layout.
- `maxToolTurns` is now the most requests one question can make, counting the answer. Tools still
  run in at most `maxToolTurns - 1` of them, as before.

### Added

- `createPdfExtractor({ tables })`, exported from the main entry point.
- `AskGeminiResult.answered` and `AskGeminiResult.blockReason`.
- `GenerateText` requests carry an optional `onTruncated` callback; `createGeminiGenerateText`
  calls it when Gemini stops at `MAX_TOKENS`.

## [0.1.0] - 2026-11-06

First release, extracted from the large-file support in the Gemini Prep chatbot.

### Added

- `createLargeFiles`: ingest, per-request planning against a token *and* byte budget, summary
  cards, and scoped tools (`search_document`, `read_document`, `get_document_overview`,
  `analyze_whole_document`).
- Extraction for text, Markdown, logs (UTF-8/UTF-16), JSON/JSONL, CSV/TSV, DOCX and PPTX (optional
  `jszip`), and PDF (optional `unpdf`).
- Log profiles (levels, time range, most frequent error shapes) and outlines for books and documents.
- Map-reduce over whole documents with parallel part reads, a retry, and rounds of merging.
- `MemoryDocumentStore` and `FileDocumentStore` with expiry.
- Document owners: documents are private to the user who uploaded them.
- `llm-large-files/gemini`: `askGemini` (streaming tool loop that always ends in an answer),
  `geminiApi` and `vertexAi` endpoints, and lower-level adapters.
- `llm-large-files/node`: upload, get, and delete handlers for any Node HTTP server.
