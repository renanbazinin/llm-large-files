# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org).

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
