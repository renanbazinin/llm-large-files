# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org).

## [Unreleased]

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
