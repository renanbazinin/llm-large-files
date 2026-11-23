# `llm-large-files`: the library and its documents

This is the reference for the part of the main entry point that ingests, stores and plans
documents: `createLargeFiles` and the `LargeFiles` object it returns, the budget, the stores, the
extractors, and the types that describe a document. It is for developers who wire the library into
an application or write a store, an extractor or a loop of their own.

```ts
import {
  createLargeFiles, DEFAULT_CACHE_BYTES, DEFAULT_WHOLE_DOCUMENT_BYTES, DEFAULT_MAX_PDF_PAGES, DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_INGEST_TIMEOUT_MS, NEVER_EXPIRES, isDocumentId, toDocumentSummary, IngestError, ingestErrorCodeOf,
  DEFAULT_BUDGET, resolveBudget,
  MemoryDocumentStore, FileDocumentStore, DOCUMENT_ID_PATTERN, APP_DOCUMENT_ID_PATTERN, DOCUMENT_META_VERSION,
  DocumentStoreError, DocumentScopeError,
  createPdfExtractor, defaultExtractors, detectFormat,
  estimateTokens, utf8Bytes, jsonBytes,
} from "llm-large-files";
import type {
  LargeFilesOptions, LargeFiles, AccessOptions, IngestInput, PrepareOptions, ToolOptions, PreparedContext, DocumentPlan,
  Budget, ModelLimits, DocumentStore, DocumentContext, DocumentScope, StoredDocument, PdfExtractorOptions, Extractor, ExtractInput, ExtractProgress,
  ExtractedText, DocumentMeta, DocumentSummary, DocumentFormat, OutlineEntry, LogIssue, LogProfile, ProgressEvent,
  ProgressListener, ToolCallHooks, ToolRequestHandle, ToolRequestStart, ToolRequestEnd, IngestEvent, IngestErrorCode,
  DocumentStoreOperation, DocumentScopeErrorCode,
} from "llm-large-files";
```

The signature blocks below assume these imports, and `ToolSet`, `GenerateText` and `RetryOptions`
from the same entry point.

Contents:

- [The library](#the-library): [`createLargeFiles(options)`](#createlargefilesoptions),
  [`LargeFilesOptions`](#largefilesoptions), [`LargeFiles`](#largefiles), [`IngestInput`](#ingestinput),
  [`IngestError`](#ingesterror), [`ingestErrorCodeOf(message)`](#ingesterrorcodeofmessage),
  [`AccessOptions`](#accessoptions), [`PrepareOptions`](#prepareoptions), [`ToolOptions`](#tooloptions),
  [`PreparedContext`](#preparedcontext), [`DocumentPlan`](#documentplan),
  [`DEFAULT_CACHE_BYTES`](#default_cache_bytes), [`DEFAULT_WHOLE_DOCUMENT_BYTES`](#default_whole_document_bytes),
  [`DEFAULT_MAX_PDF_PAGES`](#default_max_pdf_pages), [`DEFAULT_MAX_TEXT_BYTES`](#default_max_text_bytes),
  [`DEFAULT_INGEST_TIMEOUT_MS`](#default_ingest_timeout_ms),
  [`NEVER_EXPIRES`](#never_expires), [`isDocumentId(value)`](#isdocumentidvalue),
  [`toDocumentSummary(meta)`](#todocumentsummarymeta)
- [The budget](#the-budget): [`Budget`](#budget), [`DEFAULT_BUDGET`](#default_budget),
  [`resolveBudget(budget?, limits?)`](#resolvebudgetbudget-limits), [`ModelLimits`](#modellimits)
- [Stores](#stores): [`DocumentStore`](#documentstore), [`DocumentContext`](#documentcontext),
  [`DocumentScope`](#documentscope), [`StoredDocument`](#storeddocument),
  [`MemoryDocumentStore`](#memorydocumentstore), [`FileDocumentStore`](#filedocumentstore),
  [`DOCUMENT_ID_PATTERN`](#document_id_pattern), [`APP_DOCUMENT_ID_PATTERN`](#app_document_id_pattern),
  [`DOCUMENT_META_VERSION`](#document_meta_version), [`DocumentStoreError`](#documentstoreerror),
  [`DocumentScopeError`](#documentscopeerror)
- [Extraction](#extraction): [`Extractor`](#extractor), [`ExtractInput`](#extractinput),
  [`ExtractProgress`](#extractprogress), [`ExtractedText`](#extractedtext), [`defaultExtractors`](#defaultextractors),
  [`createPdfExtractor(options?)`](#createpdfextractoroptions), [`PdfExtractorOptions`](#pdfextractoroptions),
  [`detectFormat(name, mimeType)`](#detectformatname-mimetype-bytes)
- [Text sizes](#text-sizes): [`estimateTokens(text)`](#estimatetokenstext), [`utf8Bytes(text)`](#utf8bytestext),
  [`jsonBytes(text)`](#jsonbytestext)
- [Document types](#document-types): [`DocumentMeta`](#documentmeta), [`DocumentSummary`](#documentsummary),
  [`DocumentFormat`](#documentformat), [`OutlineEntry`](#outlineentry), [`LogIssue`](#logissue),
  [`LogProfile`](#logprofile)
- [Progress of whole-document reads](#progress-of-whole-document-reads): [`ProgressEvent`](#progressevent),
  [`ProgressListener`](#progresslistener), [`ToolCallHooks`](#toolcallhooks),
  [`ToolRequestHandle`](#toolrequesthandle), [`ToolRequestStart`](#toolrequeststart),
  [`ToolRequestEnd`](#toolrequestend)

The same entry point also exports the tool loop and the adapter contract ([ask.md](./ask.md)),
errors, retries and streams ([errors-and-retries.md](./errors-and-retries.md)), the tools the
model sees ([tools.md](./tools.md)), and the events of a question and of an ingest
([events.md](./events.md)).

## The library

### createLargeFiles(options)

```ts
declare function createLargeFiles(options: LargeFilesOptions): LargeFiles;
```

Creates the library over one store. Create it once per process and share it: it keeps the cache of
documents ready to search and the queue of scans. Everything else lives in the store, so several
servers can share one store.

It throws an `Error` when `options.budget` holds a value that is not a finite number above 0, or
values that cannot work together (see [`resolveBudget`](#resolvebudgetbudget-limits)). It does not
call the store.

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

const files = createLargeFiles({
  store: new FileDocumentStore(process.env.DOCUMENTS_DIR ?? "./documents"),
  budget: { contextTokens: 1_000_000, maxRequestBytes: 10_000_000 },
  ttlMs: 24 * 60 * 60 * 1000,
  keepOriginals: ["pdf"],
});
```

### `LargeFilesOptions`

```ts
type LargeFilesOptions = {
  store: DocumentStore;
  budget?: Partial<Budget>;
  ttlMs?: number;
  maxUploadBytes?: number;
  maxTextBytes?: number;
  maxPdfPages?: number;
  ingestTimeoutMs?: number;
  extractors?: Partial<Record<DocumentFormat, Extractor>>;
  keepOriginals?: DocumentFormat[];
  scannedPdfPages?: number;
  cacheBytes?: number;
  cacheSize?: number;
  wholeDocumentBytes?: number;
  scanChunkBytes?: number;
  maxConcurrentScans?: number;
  maxConcurrentIngests?: number;
  requireOwner?: boolean; // new in 0.9.0
  requireScope?: boolean; // new in 0.9.0
  now?: () => Date;
};
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `store` | [`DocumentStore`](#documentstore) | required | Where the text, the metadata, kept originals and line indexes live: `new FileDocumentStore(dir)`, `new MemoryDocumentStore()`, or your own. |
| `budget` | `Partial<Budget>` | [`DEFAULT_BUDGET`](#default_budget) | The limits of your model connection. Fields you leave out follow `contextTokens` (see [`Budget`](#budget)): for a model with a smaller window, setting `contextTokens` is enough. |
| `ttlMs` | `number` | 72 hours (259,200,000) | How long a document is kept after it is ingested. `expiresAt` is set at ingest, and the library never extends it. `Infinity`, or any time that would end at or after the end of year 9999, keeps documents until they are deleted: `expiresAt` is then [`NEVER_EXPIRES`](#never_expires). |
| `maxUploadBytes` | `number` | 100 MB (104,857,600) | The largest file `ingest` accepts. The upload handler of [`llm-large-files/node`](./node.md) reads no more than this. |
| `maxTextBytes` | `number` | [`DEFAULT_MAX_TEXT_BYTES`](#default_max_text_bytes), 100 MB, or `maxUploadBytes` when that is larger | The most text kept from one file, in UTF-8 bytes. A file's text can be larger than the file: a PDF of 3 KB built for it drew 107 MB. The PDF, DOCX, PPTX and XLSX extractors refuse a file as soon as its text passes this (a PDF page by page, and also past 100 times its size after the first 16 MB; an Office file also past 32 million characters, whatever this allows), and `ingest` refuses a larger text from any other extractor, the text extractor and yours included. Your extractor receives it as `ExtractInput.maxTextBytes`. At least 1. |
| `maxPdfPages` | `number` | [`DEFAULT_MAX_PDF_PAGES`](#default_max_pdf_pages), 5,000 | The most pages read from one PDF. A PDF with more is refused before any page is read. Your PDF extractor receives it as `ExtractInput.maxPages`. At least 1. |
| `ingestTimeoutMs` | `number` | [`DEFAULT_INGEST_TIMEOUT_MS`](#default_ingest_timeout_ms), 120,000 (2 minutes) | The most time one `ingest` may take to extract the text, build its line index and profile it, in milliseconds. The store's writes are not counted, but a store write that does not end within this time (2 minutes when it is 0) fails the ingest as a failure of the store, and the document is removed once the write ends (new in 0.8.2). Since 0.9.0 that is a `DocumentStoreError` of operation `"write"` and code `"ETIMEDOUT"`, whose `cause` says `The store did not finish writing <name> within 2 min.`; it was a plain `Error` with that message. Past it, `ingest` throws `<name> took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.`, and stores nothing. 0 sets no limit, and so does a value past what a timer can wait (2,147,483,647 ms, 24.8 days). Your extractor receives the limit as `ExtractInput.signal`. Within one page of a PDF the limit is not looked at: see [security](../security.md#uploads). |
| `extractors` | `Partial<Record<DocumentFormat, Extractor>>` | the built-ins, [`defaultExtractors`](#defaultextractors) | An [`Extractor`](#extractor) per format, used in place of the built-in one. The formats are fixed ([`DocumentFormat`](#documentformat)): you can replace the extractor of a format, not add a format. |
| `keepOriginals` | `DocumentFormat[]` | `[]` | Formats whose uploaded file is kept in the store next to its text, for example `["pdf"]`, which `view_pages` needs. Takes effect only with a store that has `putOriginal`. A kept file takes as much space as the upload until its document expires or is deleted. |
| `scannedPdfPages` | `number` | 30 | The most pages a PDF without any text (a scan) may have and still be accepted, so that its pages can be shown to the model. It applies only when `"pdf"` is in `keepOriginals` and the store has `putOriginal`. Otherwise, and with 0, such a PDF is refused. Your own PDF extractor receives it as `ExtractInput.scannedPages`. |
| `cacheBytes` | `number` | [`DEFAULT_CACHE_BYTES`](#default_cache_bytes), 256 MB | The most memory that documents kept ready between tool calls may take, together with the decoded pieces of documents read by range. The least recently used go first. A document that would take more than this is not kept and is read again for each call. A document whose decoded text would take more than a quarter of it keeps no pieces. 0 keeps nothing. Each use of a kept document asks the store first, so a document deleted or expired on another server is never served from memory. |
| `cacheSize` | `number` | no limit | Also caps the number of documents kept. The pieces of a document read by range are not counted, and leave with their document. 0 keeps nothing. |
| `wholeDocumentBytes` | `number` | [`DEFAULT_WHOLE_DOCUMENT_BYTES`](#default_whole_document_bytes), 2 MB | Documents whose text (`textBytes`) is at most this size are loaded whole into memory. Larger ones are read by range when the store has `readTextRange`, as `FileDocumentStore` does: a tool call reads only the lines it needs, and a search reads the text a piece at a time. `Infinity` loads every document whole; 0 reads every one by range. |
| `scanChunkBytes` | `number` | 1 MB (1,048,576) | Reading by range: about how many bytes of text are read and searched at a time. At least 1. |
| `maxConcurrentScans` | `number` | 4 | Reading by range: how many scans of whole documents (searches, counting the parts of a file) run at once in this library (each `createLargeFiles` call has its own queue). The others wait their turn. At least 1. |
| `maxConcurrentIngests` | `number` | 2 | How many ingests do their work at once in this library. The others wait their turn, in the order they came; their `ingestTimeoutMs` starts when their turn comes, and a caller that aborts its `signal` while it waits gets its own reason, with nothing stored. An empty file, or one over `maxUploadBytes`, is refused without waiting. An ingest holds about five times its file in memory while it works, and the steps it runs in your server's thread share that thread with the others: more of them at once do not finish sooner (100 logs of 2 MB: all answered in 28 to 42 s all at once, 28 to 33 s two at a time, with a peak of 817 to 830 MB of memory against 329 to 356 MB). An ingest keeps its turn until its work ends: when its time is up or its caller left while an extractor goes on (one that does not stop on the signal, such as the parse of a PDF by `@cantoo/pdf-lib`), until that extractor ends; such an extractor that never ends gives the turn back after `ingestTimeoutMs` more (2 minutes when that is 0), and a store write that never ends fails the ingest after `ingestTimeoutMs` (above). An extractor of your own must not wait on an ingest of the same library (to store the parts of an archive, say): that ingest waits for a turn like any other, and with every turn held by such extractors, each waits on itself until its time is up. With [`createIsolatedExtractors`](./node.md#createisolatedextractorsoptions), at most this many files reach its readers at once from this library. `Infinity` for no limit, as before 0.8.2. At least 1. New in 0.8.2. |
| `requireOwner` | `boolean` | `false` | Every call must name its owner: `ingest`, `getMeta`, `getOriginal`, `delete`, `prepare`, `askWithFiles`, `askStream` and `askGemini`, and `tools`, which then needs `access`. A call without one throws `TypeError("owner is required: requireOwner is on")`, before the store is asked anything. An owner that `ingest` would refuse (`""`, spaces only) is refused too. A document stored without an owner reads as missing. Use it on a server where every document belongs to a signed-in user: a call that forgot the owner fails, rather than reaching every document stored without one. New in 0.9.0. |
| `requireScope` | `boolean` | `false` | The same for scopes ([`DocumentScope`](#documentscope)): a call without one throws `TypeError("scope is required: requireScope is on")`, and a document stored without a scope reads as missing. `files.sweep()` without a scope is still allowed: it is upkeep, not a user's access. New in 0.9.0. |
| `now` | `() => Date` | `() => new Date()` | The clock, for tests. It dates `createdAt` and `expiresAt`, decides whether a document has expired, and is passed to the store's `sweep`. |

Since 0.7.1, `ttlMs`, `maxUploadBytes`, `scannedPdfPages`, `cacheBytes`, `cacheSize`,
`wholeDocumentBytes`, `scanChunkBytes` and `maxConcurrentScans` (and `maxConcurrentIngests`, new in
0.8.2) are checked when the library is
made: NaN, which `Number(process.env.X)` gives for a variable that is not set, throws a
`RangeError` ("maxConcurrentScans must be a number, and is NaN. Leave it out for the default."),
a value that is not a number throws a `TypeError`, and so does `Infinity` for `scanChunkBytes`. NaN
used to pass through: `maxConcurrentScans` left every scan of a document read by range waiting
forever, `ttlMs` failed every upload, `maxUploadBytes` took off the upload limit. A number below
the least an option takes is raised to it, as before. `maxTextBytes`, `maxPdfPages` and
`ingestTimeoutMs` take NaN as left out, as they have since 0.6.0.

Guides: [storage](../guides/storage.md) for the store, owners and retention,
[costs and limits](../guides/costs-and-limits.md) for the budget, [PDFs](../guides/pdfs.md) for
`keepOriginals`, `scannedPdfPages`, `extractors` and the files the limits refuse,
[security](../security.md#uploads) for `maxTextBytes`, `maxPdfPages` and `ingestTimeoutMs`, and
[deployment](../guides/deployment.md) for the memory settings.

### `LargeFiles`

```ts
interface LargeFiles {
  readonly budget: Budget;
  budgetFor(overrides?: Partial<Budget>, limits?: ModelLimits): Budget;
  readonly maxUploadBytes: number;
  readonly access?: { readonly requireOwner: boolean; readonly requireScope: boolean }; // new in 0.9.0
  ingest(input: IngestInput): Promise<DocumentMeta>;
  getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined>;
  getOriginal(id: string, access?: AccessOptions): Promise<Uint8Array | undefined>;
  delete(id: string, access?: AccessOptions): Promise<boolean>;
  sweep(options?: { scope?: DocumentScope }): Promise<number>;
  prepare(ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext>;
  tools(documents: DocumentMeta[], options?: ToolOptions): ToolSet;
}
```

The object `createLargeFiles` returns. Below, its members are shown on a `LargeFiles` named `files`.

The members that read the store (`getMeta`, `getOriginal`, `delete` and `prepare`) throw
[`DocumentStoreError`](#documentstoreerror) when the store cannot be read: retry, the document is
not gone. A tool call that meets it answers the model with its message instead. Since 0.9.0, what
the store throws while writing is a `DocumentStoreError` too, with the store's own error as
`cause`: operation `"write"` in `ingest`, `"delete"` in `delete`, `"sweep"` in `sweep`. Before, it
was passed on unchanged. Log `error.cause`, and do not show it to a user, since its message may name
a path or a host. A [`DocumentScopeError`](#documentscopeerror) the store throws is passed on as it
is, for reads and writes alike: it is a mistake of the call, not a store to try again.

Every store call carries a [`DocumentContext`](#documentcontext), new in 0.9.0: the scope and the
owner of the call (of the document, at ingest). It is a frozen object, and a field that is absent is
left out, so a call without either gets `{}`. A document a store returns for another ID, or with
the owner `null` (as a MongoDB driver writes a field that was left out), is read as missing, or as
without an owner.

#### `files.access`

`readonly access?: { readonly requireOwner: boolean; readonly requireScope: boolean }`

New in 0.9.0. What the library requires of every call: `requireOwner` and `requireScope` as they
were given, `false` when left out. The object is frozen. Code that serves a library, such as the
upload handlers, reads it to require an owner or a scope too. It is optional in the type, so a
`LargeFiles` of your own still compiles.

#### `files.ingest(input)`

`ingest(input: IngestInput): Promise<DocumentMeta>`

Extracts the text of a file, normalizes it, profiles it, and stores it under a new ID, or under the
ID the application gives (`input.id`, new in 0.9.0). Returns the new document's
[`DocumentMeta`](#documentmeta).

1. The owner, the scope and the ID are checked (see [`IngestInput`](#ingestinput)), the name is
   cleaned, and the format is picked by [`detectFormat(name, mimeType)`](#detectformatname-mimetype-bytes).
   With an `id`, the store is asked whether a document of that ID is there
   ([`ifExists`](#ingestinput)), before the file is read. That question is given the same time
   as the writes (`ingestTimeoutMs`), and an aborted `signal` stops waiting for it. An `id` that
   another ingest of this library is storing is refused at once.
2. The extractor of that format turns the bytes into text. It receives the limits `maxTextBytes`
   and `maxPdfPages`, the ingest's signal, and, when someone listens to the ingest's events, an
   `onProgress` to report how far it is ([`ExtractInput`](#extractinput)). A text longer
   than `maxTextBytes` is refused, whichever extractor made it. The extractor may say how the text
   was read ([`ExtractedText`](#extractedtext)): the built-in one reads a text file that is not
   valid UTF-8 in the older encoding its lines fit, when one does, and `encoding` and
   `replacedCharacters` of the metadata record how it was read
   ([Text encodings](../guides/pdfs.md#text-encodings)).
3. The text is normalized: a byte-order mark is removed, line endings become `\n`, and terminal
   escape sequences and control characters other than tab and newline are removed, C1 controls
   (U+0080-U+009F) included. So are most characters that show nothing: Unicode tag characters (the
   flags of England, Scotland and Wales are kept), the text-direction embeddings, overrides and
   isolates (U+202A-U+202E, U+2066-U+2069), the zero-width space, the word joiner and the invisible
   operators (U+200B, U+2060-U+2064), the deprecated format characters (U+206A-U+206F), a byte-order
   mark inside the text, and a soft hyphen that is not at the end of a line. The characters that
   scripts and emoji need are kept: LRM, RLM and ALM, zero-width joiners and non-joiners, variation
   selectors. In a text with no other line break, U+0085 (next line) ends a line, except right after
   U+0080-U+00FF; elsewhere it is removed. No other line moves. The text is then composed (NFC), as
   a model writes its queries: "e" followed by a combining accent becomes "é" (new in 0.8.0; line
   counts do not change, and `characters` can be a little smaller). Lines longer than 2,000
   characters are split, so every line can be read by number (`wrappedLines` counts them).
4. A `text` document becomes a `log`, and gets a `logProfile`, when it has at least 5 non-blank
   lines and at least 40% of its first 200 non-blank lines start with a timestamp or a log level
   (`ERROR`, `WARN`, `INFO`...), or have the shape of an access log of nginx or Apache, a JSON log
   line, klog or logfmt (since 0.8.0).
5. The store is written: the original file (when it is kept), then the line index (when the store
   has `putIndex`), then `put` last. Each call carries the document's owner and scope. With an
   `id`, the store is asked again just before, for a document stored under it meanwhile; one that
   `ifExists: "replace"` replaces is deleted first.

Steps 2 to 4 work in slices of about 12 ms, with a pause for other requests between two slices:
between the pages of a PDF, as a DOCX, PPTX or XLSX is unpacked, and while the text is normalized,
measured, outlined, profiled and indexed. Ingests that run at once take turns, one slice each.
They run under one signal, aborted by `IngestInput.signal` or after `ingestTimeoutMs` (2 minutes
by default). When it aborts, `ingest` stops waiting for the extractor, throws, and writes nothing
to the store. The writes of step 5 are not under the signal. One page of a PDF is read without a
pause, and the signal is looked at only between pages.

**Events.** New in 0.7.0. With `IngestInput.onEvent`, the ingest tells what it does as typed
[`IngestEvent`](./events.md#ingestevent)s, in order: `ingest.start` first (the cleaned name, the
format the name and type say, the size), even for a file that is then refused; `ingest.progress` for
each stage that reports; and last `ingest.finish`, with the document's
[`DocumentSummary`](#documentsummary), or `ingest.error`. The stages, in the order they run:
`decode` (a text file that is not UTF-8, once, when it is decoded), `check` (the pages of a PDF
checked before they are read, with `@cantoo/pdf-lib`), `extract` (the pages of a PDF, the parts of a
DOCX, the slides of a PPTX, the sheets of an XLSX), `pictures` (the pages of a PDF looked at for
pictures, with `@cantoo/pdf-lib`), `prepare` and `index` (characters of the text), and `store` (each
write) ([stages and units](./events.md#stages-and-units)). A stage sends at most one
`ingest.progress` about every 12 ms, and its last one when it ends. An extractor of your own reports
only what it passes to `onProgress`. The error of `ingest.error` is told in words for users, with
the `code` of an [`IngestError`](#ingesterror) (new in 0.8.0): a store that failed to write is "The
document could not be stored. Try again later.", whatever it threw, and `ingest` throws a
`DocumentStoreError` whose `cause` is the store's own error (new in 0.9.0: it threw the store's
error itself). A listener that throws ends the ingest with that error, and nothing is stored;
a throw on `ingest.finish` removes the document that was just stored. With an `id`, it is removed
only while it is still this ingest's own: one another server stored under the ID meanwhile stays. `createDocumentHandlers` sends
these events to a client that asks for them with `Accept: text/event-stream` ([upload with
progress](./node.md#upload-with-progress-accept-textevent-stream)).

| It throws | When |
|---|---|
| `TypeError("owner must be a string that is not empty or only spaces, such as the signed-in user's ID. To let anyone with the document's ID use it, leave owner out.")` | `owner` is `""`, spaces only or `null`, or, from JavaScript, neither a string nor a finite number (an object, `true`, `NaN`). Before anything is read. New in 0.6.0: 0.5.0 accepted them. |
| `TypeError("owner is required: requireOwner is on")`, `TypeError("scope is required: requireScope is on")` | The library requires an owner or a scope, and `input` has none. Before anything is read. New in 0.9.0. |
| [`DocumentScopeError`](#documentscopeerror) `"scope_invalid"` | `scope` is not a valid [`DocumentScope`](#documentscope). Before anything is read. New in 0.9.0. |
| `TypeError('id must be lowercase letters, digits, "_" and "-", up to 64 characters, starting with a letter or a digit (APP_DOCUMENT_ID_PATTERN).')` | `id` does not match [`APP_DOCUMENT_ID_PATTERN`](#app_document_id_pattern). The message does not repeat the ID. New in 0.9.0. |
| `TypeError('ifExists must be "fail" or "replace".')` | Another `ifExists`. New in 0.9.0. |
| `IngestError` `"exists"`: `<name>: a document with this ID already exists.` | A document of `id` is there and `ifExists` does not let it be replaced; or another ingest of this library is storing `id` at the moment, whatever `ifExists` says; or a write failed and the document under `id` by then is another's (stored by another server). Status 409. It says nothing of the document that has the ID, but it does say that the ID is taken ([Application IDs](../guides/storage.md#application-ids)). New in 0.9.0. |
| [`IngestError`](#ingesterror) `"empty"`: `<name> is empty.` | The file has no bytes. |
| `IngestError` `"too_large"`: `<name> is larger than the 100 MB upload limit.` | The file is larger than `maxUploadBytes`. The message gives your limit. |
| An `IngestError` with the extractor's message | The extractor refused the file: a binary or compressed file, an Office file of before 2007 or with a password, a PDF with a password or without text, a missing optional dependency or an `unpdf` that cannot run on this Node, a possible zip bomb, a file past `maxTextBytes` or `maxPdfPages`, a file built to exhaust the server; or a parser failed on a damaged file. The `code` comes from the message ([`ingestErrorCodeOf`](#ingesterrorcodeofmessage)), `"unreadable"` for one the library does not know, and the extractor's error is `cause`. A text file is never refused for its encoding. The built-in messages, listed under [`defaultExtractors`](#defaultextractors), are written for a user. |
| `IngestError` `"too_much_text"`: `<name> holds more than 100 MB of text, more than is kept from one file. Split it, and attach the part you need.` | The text an extractor returned is larger than `maxTextBytes`. The message gives your limit. |
| `IngestError` `"timeout"`: `<name> took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.` | The ingest took longer than `ingestTimeoutMs`. The message gives your limit: "500 ms" below a second, "45 s" below 2 minutes, "2 min" from there. |
| `signal.reason` | `IngestInput.signal` was aborted, before or during the ingest. |
| `IngestError` `"no_text"`: `<name> did not contain any text.` | The extracted text is blank. |
| What an extractor of your own threw | An error with a `status` or `statusCode`, a Node system error (one with a `code` and a `syscall`), and a value that is not an `Error`, as they are. Any other `Error` becomes an `IngestError`, as above. |
| [`DocumentStoreError`](#documentstoreerror), operation `"write"` | A write failed, or did not end within `ingestTimeoutMs` (code `"ETIMEDOUT"`; 2 minutes when that is 0). `ingest` first calls `store.delete(id)` to remove what was written (an error of that call is ignored). With an `id`, only when nothing is under the ID by then, or the document there is this ingest's own (the same `createdAt`, owner and scope); otherwise it is left, and the ingest throws `IngestError` `"exists"`. The store's error is `cause`, and the message names no path or host: `The document could not be stored (EIO). Try again.` New in 0.9.0: it threw the store's error unchanged, and the time limit as `The store did not finish writing <name> within 2 min.`, which is now the message of `cause`. A `DocumentScopeError` of the store is thrown as it is. |
| `DocumentStoreError`, operation `"read"` | With an `id`: the store could not be read when it was asked whether the ID is taken, or did not answer within `ingestTimeoutMs` (code `"ETIMEDOUT"`), before the file was read or just before the writes. Code `"NEWER_VERSION"` when `ifExists: "replace"` meets a document written by a newer version of the package, which is never replaced. New in 0.9.0. |

Until 0.8.0 the refusals were plain `Error`s, with the same messages. The `TypeError` of an owner is
a mistake of the server's code, not of the file: the upload handler of
[`llm-large-files/node`](./node.md) checks the owner itself, and answers `500` before it reads the
body. The store's `DocumentStoreError`, a listener of the events that threw, and the reason of an
aborted signal are thrown as they are, never as an `IngestError`. The upload handler of
[`llm-large-files/node`](./node.md) answers an error that carries an HTTP `status` or `statusCode`
(400 to 599) with that status and its message, and a Node system error (`code` and `syscall`) with
500 and the code. A `DocumentStoreError` has the status 503, and a message that names no path or
host: since 0.9.0 a store that failed to write is answered 503 `{ "error": "The document could not
be stored (EIO). Try again." }`, where it was a 500. An `IngestError` carries a `status` too, and is
answered with it: 422, 413 for `"too_large"`, 409 for `"exists"`, 503 with `Retry-After` for
`"busy"`. A thrown value that is not an `Error` is answered 500 `{ "error": "Upload failed." }`, and
any other `Error` 422 with its message, as a file that cannot be read (see [the upload
handler](./node.md#uploadrequest-response)). Behind an `ingest` of your own, throw a
`DocumentStoreError` for a store that failed. See
[errors and reliability](../guides/errors-and-reliability.md).

Guides: [web app](../guides/web-app.md) for uploads, [PDFs](../guides/pdfs.md) for what PDF
extraction writes.

#### `files.getMeta(id, access?)`

`getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined>`

The document's metadata, or `undefined` when the ID has neither shape of a document ID
([`isDocumentId`](#isdocumentidvalue)), the document was never there, was deleted, has expired (the
library compares `expiresAt` with its clock itself, whatever the store returns), or belongs to
another owner or another scope ([`AccessOptions`](#accessoptions)). The store is asked with the
caller's owner and scope. Metadata the store returns for another ID is missing too (new in 0.9.0).
An owner of `null` is left out of the metadata returned (new in 0.9.0). Throws `DocumentStoreError` when the
store cannot be read, and, new in 0.9.0, with code `"NEWER_VERSION"` when a newer version of the
package wrote the metadata ([`DOCUMENT_META_VERSION`](#document_meta_version)). A name that 0.5.0
or earlier stored cut inside an emoji comes back with a replacement character (U+FFFD) in place of
the half, as the model and the steps get it; the stored metadata is not changed.

#### `files.getOriginal(id, access?)`

`getOriginal(id: string, access?: AccessOptions): Promise<Uint8Array | undefined>`

The uploaded file, when it was kept (`keepOriginals`). `undefined` in every case where `getMeta`
gives `undefined`, and when the document has no `originalKept`, the store has no `getOriginal`, or
the store returns none. Since 0.9.0 the store is asked for the metadata again once the bytes are
read: `undefined` too when the document is not the same by then (deleted, and another stored under
its ID, by another server), or when the bytes are not the size of the file that was ingested
(`meta.bytes`). `view_pages` reads the file the same way. Treat the bytes as read-only: a store of
your own may return the bytes it keeps. `MemoryDocumentStore` returns a copy since 0.9.0; it returned the very bytes it kept.
Throws `DocumentStoreError` as `getMeta` does.

#### `files.delete(id, access?)`

`delete(id: string, access?: AccessOptions): Promise<boolean>`

Removes a document, with its original and its index. It looks the document up as `getMeta` does,
and returns `false` when it is not there for this caller: another owner's document is never
deleted. Otherwise it drops what this process keeps of the document in memory, in every scope,
and returns what `store.delete(id, context)` returns. Throws `DocumentStoreError` when the look-up
cannot read the store, and, new in 0.9.0, a `DocumentStoreError` of operation `"delete"` when
`store.delete` fails, with the store's error as `cause` (it was passed on unchanged). Its message
names no path: `The document could not be deleted (EPERM). Try again.`

#### `files.sweep(options?)`

`sweep(options?: { scope?: DocumentScope }): Promise<number>`

Calls the store's `sweep` with the library's clock and returns how many expired documents it
removed: 0 when the store has no `sweep`. With `scope` (new in 0.9.0), the store is asked to sweep
that scope only (`store.sweep(now, { scope })`); without one, every scope (`store.sweep(now, {})`).
It needs no scope under `requireScope`. A scope that is not valid is a `DocumentScopeError`. Since
0.9.0 a store that fails is a `DocumentStoreError` of operation `"sweep"`, with the store's error as
`cause` (it was passed on unchanged). The library never sweeps on its own: run it on a schedule,
from one place (see [deployment](../guides/deployment.md)).

#### `files.prepare(ids, base, options?)`

`prepare(ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext>`

Plans one model request: which documents go into the prompt whole, and which become cards that the
model reads through the tools.

| Argument | Type | What it is |
|---|---|---|
| `ids` | `string[]` | The document IDs of the request. A repeated ID counts once. |
| `base` | `{ tokens: number; bytes: number }` | The size of everything else in the request: messages, system prompt, other files. `estimateTokens` and `jsonBytes` measure text the way the plan does. |
| `options` | [`PrepareOptions`](#prepareoptions) | The owner and the scope, a budget for this request, whether your loop can show pages, and whether your tools have `analyze_whole_document`. |

Documents are taken smallest first, by `estimatedTokens`. Each one goes in whole when, with the
ones already taken, it still fits both the token room,
`min(inlineTokens, contextTokens − reservedTokens − base.tokens)`, and the byte room,
`maxRequestBytes − 256 KB − base.bytes`. Otherwise it is searchable. See
[how it works](../how-it-works.md) for the details.

Returns a [`PreparedContext`](#preparedcontext). A document that cannot be used is not an error
here: its ID is listed in `missing`, and a document that disappears while the plan is made is moved
there and the plan is made again. ([`askWithFiles`](./ask.md#askwithfilesoptions) throws
[`DocumentsNotFoundError`](./ask.md#documentsnotfounderror) for them instead.) Throws
`DocumentStoreError` when the store cannot be read, and an `Error` for a `budget` that cannot work.

```ts
import { estimateTokens, jsonBytes, type GenerateText, type LargeFiles } from "llm-large-files";

// One question in a loop of your own. `generate` is a plain text completion of your model.
async function planQuestion(files: LargeFiles, generate: GenerateText, documentIds: string[], userId: string, question: string) {
  const instructions = "Answer questions about the attached files. Cite line numbers.";
  const base = {
    tokens: estimateTokens(instructions) + estimateTokens(question),
    bytes: jsonBytes(instructions) + jsonBytes(question),
  };
  // viewPages: true only when your loop runs tools with executeWithFiles and sends their files to the model.
  const prepared = await files.prepare(documentIds, base, { owner: userId, viewPages: true });
  if (prepared.missing.length > 0) throw new Error(`Not found: ${prepared.missing.join(", ")}`);

  const tools = files.tools(prepared.plan.searchable, { generate, viewPages: prepared.viewable });
  const system = [instructions, prepared.instruction].filter(Boolean).join("\n\n");
  const user = [...prepared.blocks.values(), question].join("\n\n");
  return { system, user, tools };
}
```

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

#### `files.tools(documents, options?)`

`tools(documents: DocumentMeta[], options?: ToolOptions): ToolSet`

A [`ToolSet`](./tools.md#toolset) scoped to `documents`: a call that names any other `document_id`
answers with an error that lists the IDs it may use. Pass `prepared.plan.searchable`. Make one tool
set for each question: the time budget of regex searches and the count of whole-document reads
belong to the tool set.

Each call that reads a document's text or the pages of its PDF asks the store for the document,
and checks the owner and the scope the store holds. A document that the caller may not use is
answered as one that is gone: `doc_… is no longer available on the server. Ask the user to attach
the file again.`, and `view_pages` shows no page.

- With `access` (new in 0.9.0), the caller is `access`: the store is asked with its owner and scope,
  and the document's are compared with them, as `getMeta(id, access)` does. The metadata handed in
  decides nothing: metadata read from the store for another user reads nothing. `askWithFiles`
  passes it. Under `requireOwner` or `requireScope`, `access` is required, with the owner or scope:
  without it `tools` throws the `TypeError` of [`LargeFilesOptions`](#largefilesoptions).
- Without `access`, as before 0.9.0, the caller of each document is the `owner` and `scope` of the
  `DocumentMeta` handed in for it. So metadata built from an ID alone, or with another owner or
  scope, reads nothing of a document that has one. A document stored without an owner is read
  whatever the metadata says. Pass documents that you got from `prepare` or `getMeta` with the
  caller's owner and scope. An owner of `null` counts as none (new in 0.9.0: such a document was
  missing for `getMeta`, and open to the tools).

It declares `search_document`, `read_document` and `get_document_overview`;
`analyze_whole_document` when `generate` is given and at least one document is small enough to be
read whole; and `view_pages` when `viewPages` names at least one PDF whose original is kept and the
store has `getOriginal`. With no `documents` and pages to show, it declares only `view_pages`. The
tools, their arguments and their results are in [tools.md](./tools.md).

Throws an `Error` for a `budget` that cannot work.

#### `files.budget`

`readonly budget: Budget`

The library's own budget: [`resolveBudget(options.budget)`](#resolvebudgetbudget-limits). The fields
you set stay as set, and the others follow your `contextTokens` (see [`Budget`](#budget)). With no
`budget`, it equals [`DEFAULT_BUDGET`](#default_budget). It is not fitted to any model.

#### `files.budgetFor(overrides?, limits?)`

`budgetFor(overrides?: Partial<Budget>, limits?: ModelLimits): Budget`

The budget of one request: the fields the library was given, with `overrides` in their place, made
to fit `limits` (a model's context window and request size, when they are smaller). Fields that
neither sets follow the window that results. Without either argument it returns `files.budget`.
Throws as `resolveBudget` does. `askWithFiles` calls it with the limits its models declare.

Guide: [costs and limits](../guides/costs-and-limits.md).

#### `files.maxUploadBytes`

`readonly maxUploadBytes: number`

The upload limit in effect: `options.maxUploadBytes`, or 104,857,600 (100 MB).

### `IngestInput`

```ts
type IngestInput = {
  name: string;
  mimeType?: string;
  bytes: Uint8Array;
  owner?: string;
  signal?: AbortSignal;
  onEvent?: (event: IngestEvent) => void;
  runId?: string;
  id?: string; // new in 0.9.0
  ifExists?: "fail" | "replace"; // new in 0.9.0
  scope?: DocumentScope; // new in 0.9.0
};
```

The argument of [`files.ingest`](#filesingestinput).

| Field | Type | Default | What it does |
|---|---|---|---|
| `name` | `string` | required | The file name. It is cleaned to one printable line: the last segment of a path, with control characters, line breaks and text-direction controls replaced by spaces, the characters that show nothing removed as from the text (tag characters, zero-width spaces, word joiners, soft hyphens, a byte-order mark), runs of spaces made one, trimmed, and cut to 255 characters, never in the middle of a character (`"file"` when nothing is left; an emoji of several characters, such as a flag, can lose its end). With the MIME type it picks the format. |
| `mimeType` | `string` | `"application/octet-stream"` | The MIME type, trimmed. Blank counts as absent. Used when the extension names no format. |
| `bytes` | `Uint8Array` | required | The file. A Node `Buffer` is one. Empty, or larger than `maxUploadBytes`, is refused. |
| `owner` | `string` | none | The user or tenant the document belongs to. Every later call must pass the same owner. Without one, anyone who has the ID can use the document. It must be a string that is not empty or only spaces: `""`, spaces only and `null` throw a `TypeError` (see [`files.ingest`](#filesingestinput)), since each would be one owner shared by every caller without a user. A number from JavaScript is taken, as before. Reads with the owner `""` work as before. |
| `signal` | `AbortSignal` | none | Stops the ingest when it aborts, for example when the uploader goes away: `ingest` throws `signal.reason` and stores nothing. The PDF, DOCX, PPTX, XLSX and HTML extractors stop between pages and pieces; `ingest` stops waiting for an extractor of your own at once. A signal that aborts once the store is being written changes nothing. `createDocumentHandlers` passes one that aborts when the client closes the connection before the answer. |
| `onEvent` | `(event: IngestEvent) => void` | none | What the ingest does as it goes: `ingest.start`, `ingest.progress` for each stage, then `ingest.finish` or `ingest.error` (see [`files.ingest`](#filesingestinput) and [events](./events.md)). Progress is worked out only when it is given. New in 0.7.0. |
| `runId` | `string` | `"ing_"` and 16 hex digits | The `runId` of those events. New in 0.7.0. |
| `id` | `string` | `"doc_"` and 32 hex digits, made | The document's ID, chosen by the application, such as the ID of its upload. It must match [`APP_DOCUMENT_ID_PATTERN`](#app_document_id_pattern): lowercase letters, digits, `_` and `-`, up to 64 characters, starting with a letter or a digit. Another ID is a `TypeError`. The model sees the ID (in the cards and the tool calls), so it must hold no personal data, such as an email address. Over a store that keeps no scopes apart, it must be unique in the whole store: `ifExists` makes sure. A 409 tells the caller that the ID is taken, so make IDs random, or prefix them per tenant. New in 0.9.0. |
| `ifExists` | `"fail" \| "replace"` | `"fail"` | What to do when a document of `id` is already there, as the store sees it for this scope. `"fail"`: an `IngestError` `"exists"` (status 409). `"replace"`: the document is deleted, then the new one is stored; only one of the same owner and scope. One of another owner or scope is `"exists"` too, even when its text is gone. A document that has expired is written over in both cases. The store is asked before the file is read and again just before the writes. While one ingest of this library stores `id`, another ingest of `id` is `"exists"`, whatever its `ifExists`. Replacing is not atomic for readers on other servers: for a moment the document is missing. New in 0.9.0. |
| `scope` | [`DocumentScope`](#documentscope) | none | Where the document belongs, such as `[userId, chatId]`. Every store call of the ingest carries it, and it is kept in `meta.scope`, a copy: only a caller of the same scope may use the document, segment by segment. Never sent to the model, nor in a summary or an event. Not valid: a `DocumentScopeError`. `null` counts as none. New in 0.9.0. |

Guide: [web app](../guides/web-app.md).

### `IngestError`

```ts
declare class IngestError extends Error {
  readonly code: IngestErrorCode;
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(code: IngestErrorCode, message: string, options?: { cause?: unknown; retryAfterMs?: number });
  static is(value: unknown): value is IngestError; // new in 0.9.0
}

type IngestErrorCode =
  | "empty" | "too_large" | "too_much_text" | "too_many_pages" | "not_text" | "compressed" | "legacy_office"
  | "encrypted" | "no_text" | "hostile" | "timeout" | "out_of_memory" | "busy" | "missing_dependency" | "unreadable"
  | "exists"; // new in 0.9.0
```

New in 0.8.0. [`files.ingest`](#filesingestinput) could not read a file. The message says why, in
words for the person who uploaded it, as it did before; `code` says it for your application, so
that it can tell the user in its own words or language. Until 0.8.0 the same refusals were plain
`Error`s, with the same messages.

| Field | Type | What it holds |
|---|---|---|
| `name` | `string` | `"IngestError"`. |
| `message` | `string` | The reason, written for a user: "app.log is empty.", "This PDF has no text layer (it may be scanned). …". |
| `code` | `IngestErrorCode` | Why, as one of the codes below. |
| `status` | `number` | The HTTP status the upload handler of [`llm-large-files/node`](./node.md#uploadrequest-response) answers with: 413 for `"too_large"`, 409 for `"exists"`, 503 for `"busy"`, 422 for every other code. |
| `retryAfterMs` | `number \| undefined` | For `"busy"`: how long to wait before trying again, in milliseconds (5,000 from `createIsolatedExtractors`). The upload handler sends it as `Retry-After`, in seconds. |
| `cause` | `unknown` | The error of the extractor, the parser or the isolated reader, when there is one. Its message is in `message`. |

| `code` | What the file is |
|---|---|
| `"empty"` | It has no bytes. |
| `"too_large"` | It is larger than `maxUploadBytes`. |
| `"too_much_text"` | It has more text than `maxTextBytes`, or more than one file is read for (an Office file of more than 32 million characters, or of more than 128 MB of XML). |
| `"too_many_pages"` | A PDF with more pages than `maxPdfPages`. |
| `"not_text"` | A binary file of a kind the library does not read. |
| `"compressed"` | A gzip or ZIP archive, to extract first. |
| `"legacy_office"` | A Word, Excel or PowerPoint file of before 2007 (`.doc`, `.xls`, `.ppt`), an Outlook message (`.msg`), or an Office file protected by a password: all are stored the same way, and none can be read. |
| `"encrypted"` | A PDF protected by a password. |
| `"no_text"` | Nothing to read: a PDF without a text layer (a scan), a deck without slides, a workbook without sheets, a file of white space. |
| `"hostile"` | A file built the way files that exhaust a server are: a zip bomb, a PDF that draws far more text than its size or lists a page twice, pages that would hold the server, a structure no program writes. Most of these messages say "it may be built to exhaust the server" or "it may be a zip bomb". |
| `"timeout"` | Reading it took longer than `ingestTimeoutMs`, or the kill timer of an isolated reader ([`createIsolatedExtractors`](./node.md#createisolatedextractorsoptions)). |
| `"out_of_memory"` | An isolated reader ran out of the memory it is given (`maxHeapMb`). |
| `"busy"` | Every isolated reader is busy and its queue is full, it is shutting down, or a reader process could not be started for want of process slots or file handles: try again in a moment (`retryAfterMs`). |
| `"missing_dependency"` | The optional dependency for the format is not installed, is installed and could not be loaded, or (unpdf) cannot run on this version of Node. |
| `"unreadable"` | Any other error of reading the file: it is damaged, or not of the type its name says. |
| `"exists"` | Not the file: a document with the ID the application gave (`IngestInput.id`) is already stored. Status 409. New in 0.9.0: a `switch` over every code needs a case for it. |

`IngestError.is(value)` tells whether a value is one, also when another copy of the package made it,
where `instanceof` is `false` (see [errors](./errors-and-retries.md#telling-errors-apart-across-copies-of-the-package)).
New in 0.9.0.

`ingest.error` events carry the code as [`EventError.code`](./events.md#errors-eventerror).

```ts
import { IngestError, toDocumentSummary, type IngestErrorCode, type LargeFiles } from "llm-large-files";

// Your words for some codes; the library's message for the others.
const hebrew: Partial<Record<IngestErrorCode, string>> = {
  too_large: "הקובץ גדול מדי.",
  no_text: "אין בקובץ טקסט לקרוא.",
  busy: "השרת עסוק. נסו שוב בעוד רגע.",
};

// `files` is your library.
async function upload(files: LargeFiles, name: string, bytes: Uint8Array, owner: string) {
  try {
    return { status: 201, body: toDocumentSummary(await files.ingest({ name, bytes, owner })) };
  } catch (error) {
    if (!(error instanceof IngestError)) throw error; // the store, an abort, your own code
    return { status: error.status, body: { error: hebrew[error.code] ?? error.message, code: error.code } };
  }
}
```

Guide: [errors and reliability](../guides/errors-and-reliability.md).

### ingestErrorCodeOf(message)

```ts
declare function ingestErrorCodeOf(message: string): IngestErrorCode;
```

New in 0.8.0. The code of a refusal of the library, read from its message: `"hostile"` for
"…It may be built to exhaust the server, so it is not read.", `"compressed"` for "This file is a ZIP
archive. …", `"busy"` for the busy and shutting-down refusals of the isolated readers, and so on.
`"unreadable"` for any other message. It gives the code only: an `IngestError` made from a message
has no `retryAfterMs`, so wait your own time before a retry of a `"busy"` one. `ingest` gives the
plain `Error` of an extractor its code this way. Use it where only the message is left, such as a reply from a
process of your own that ingests:

```ts
import { IngestError, ingestErrorCodeOf } from "llm-large-files";

// `message` came back from your ingest process.
const error = new IngestError(ingestErrorCodeOf(message), message);
```

### `AccessOptions`

```ts
type AccessOptions = { owner?: string; scope?: DocumentScope };
```

Who is asking. `getMeta`, `getOriginal`, `delete` and `prepare` (through
[`PrepareOptions`](#prepareoptions)) take it, `tools` as `ToolOptions.access`, and `askWithFiles`
takes the same two options. Each store call carries both ([`DocumentContext`](#documentcontext)).

| Field | Type | Default | What it does |
|---|---|---|---|
| `owner` | `string` | none | Compared with the document's `owner` with `===`. A document that has an owner can be used only with that exact owner. A document without one can be used by anyone, unless the library has `requireOwner`. Another owner's document looks exactly like a missing one. `null` counts as none. |
| `scope` | [`DocumentScope`](#documentscope) | none | The scope of the caller, such as `[userId, chatId]`. A document stored with a scope serves only a caller of the same scope, segment by segment: a caller with another scope, a longer or shorter one, or none, finds it missing. A document stored without a scope serves any caller, unless the library has `requireScope`. A store that keeps scopes apart (`MemoryDocumentStore`) does not even find a document of another scope. Not valid: a `DocumentScopeError`. `null` counts as none. New in 0.9.0. |

The library has no notion of a session and cannot list documents by owner: record the IDs in your
own data. See [storage](../guides/storage.md) and [security](../security.md).

### `PrepareOptions`

```ts
type PrepareOptions = AccessOptions & {
  budget?: Partial<Budget>;
  viewPages?: boolean;
  wholeDocumentAnalysis?: boolean;
};
```

The options of [`files.prepare`](#filesprepareids-base-options).

| Option | Type | Default | What it does |
|---|---|---|---|
| `owner` | `string` | none | As in [`AccessOptions`](#accessoptions). Another owner's documents are listed in `missing` and are not read. |
| `scope` | [`DocumentScope`](#documentscope) | none | As in [`AccessOptions`](#accessoptions). Documents of another scope are listed in `missing`. New in 0.9.0. |
| `budget` | `Partial<Budget>` | the library's | The budget fields to change for this request, as in `LargeFilesOptions.budget`. `askWithFiles` passes the budget fitted to its model. |
| `viewPages` | `boolean` | `false` | Says that your loop can pass files to the model. `viewable` then lists the PDFs whose original is kept (with a store that has `getOriginal`), and the instruction and the cards tell the model about `view_pages`. Without it, `viewable` is empty and nothing mentions `view_pages`. |
| `wholeDocumentAnalysis` | `boolean` | `true` | Says whether your tool set has `analyze_whole_document`. Pass `false` when you call `tools` without `generate`: the instruction then does not name it, and the cards do not offer a whole-file read or say that a file is too large for one. Each says `This file is NOT in your context. Use the document tools to search it and to read line ranges.` `askWithFiles` passes `false` when the model that explores has no `generateText`, and when its own `wholeDocumentAnalysis` is `false`. |

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

### `ToolOptions`

```ts
type ToolOptions = {
  access?: AccessOptions; // new in 0.9.0
  generate?: GenerateText;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
  regexBudgetMs?: number;
  maxWholeDocumentReads?: number;
  retry?: RetryOptions;
  budget?: Partial<Budget>;
  viewPages?: boolean | DocumentMeta[];
};
```

The options of [`files.tools`](#filestoolsdocuments-options).

| Option | Type | Default | What it does |
|---|---|---|---|
| `access` | [`AccessOptions`](#accessoptions) | none | Who uses the tools. With it, each call checks the owner and scope the store holds against `access`, not against the metadata handed in ([`files.tools`](#filestoolsdocuments-options)). Required under `requireOwner` or `requireScope`. `askWithFiles` passes it. New in 0.9.0. |
| `generate` | [`GenerateText`](./ask.md#generatetext) | none | A plain text completion. It enables `analyze_whole_document`, which reads a whole file in parts. The tool is declared only when at least one of the documents is small enough: about `maxMapChunks` parts or fewer. Without `generate`, pass `wholeDocumentAnalysis: false` to `prepare`, so that the instruction does not name the tool and the cards do not offer a whole-file read. |
| `onProgress` | [`ProgressListener`](#progresslistener) | none | Progress of whole-document reads, for status messages. |
| `signal` | `AbortSignal` | none | Stops searches and whole-document reads. Once it has aborted, a call that fails throws instead of answering `{ error }`. |
| `regexBudgetMs` | `number` | [`REGEX_BUDGET_MS`](./tools.md#regex_budget_ms), 6,000 | The most time, in milliseconds, that the regex searches of this tool set may take together. Past it, a regex search answers with an error that tells the model to search another way. One search stops after 3,000 ms on its own. |
| `maxWholeDocumentReads` | `number` | [`MAX_WHOLE_DOCUMENT_READS`](./tools.md#max_whole_document_reads), 1 | How many times each document may be read whole by this tool set. A call past it answers with an error that tells the model to use what it has. 0 turns whole reads off. NaN throws a `RangeError`, and a value that is not a number a `TypeError` (since 0.7.1: NaN allowed any number of whole reads). |
| `retry` | [`RetryOptions`](./errors-and-retries.md#retryoptions) | 3 retries, a first wait of 250 to 500 ms (500 ms before the jitter) that doubles, 60 s at most | How a failed model request of a whole-document read is sent again. An error without an HTTP status is sent again once, at once. |
| `budget` | `Partial<Budget>` | the library's | The budget fields to change for these tools: their result cap and part size. Use the budget you planned the request with. |
| `viewPages` | `boolean \| DocumentMeta[]` | none | Offers `view_pages`, which hands the model real pages of a PDF as a file. `true` offers it for the PDFs among `documents`; a list offers it for exactly those, which may include PDFs whose text is already in the prompt: pass `prepared.viewable`. Only PDFs with `originalKept` count, and only with a store that has `getOriginal`. Turn it on only when your loop runs tools with `executeWithFiles` and sends the files to the model. |

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

### `PreparedContext`

```ts
type PreparedContext = {
  plan: DocumentPlan;
  blocks: Map<string, string>;
  instruction: string;
  missing: string[];
  viewable: DocumentMeta[];
};
```

What [`files.prepare`](#filesprepareids-base-options) returns.

| Field | Type | What it holds |
|---|---|---|
| `plan` | [`DocumentPlan`](#documentplan) | Which documents go in whole and which are searched. |
| `blocks` | `Map<string, string>` | The prompt text of each document, by ID. For a document sent whole, its text between two frame lines (see below). For a searchable one, a card: its `document_id`, size, log profile, outline (up to 40 headings) and first 25 lines, and a line that says how a text file that was not valid UTF-8 was read. |
| `instruction` | `string` | The guide to the tools, for the system prompt, when a document is searchable or viewable; `""` otherwise. It names `analyze_whole_document` when a searchable file is small enough for it and `prepare` was not given `wholeDocumentAnalysis: false`. Then give `generate` to `tools`, or a call of it is answered as an unknown tool. |
| `missing` | `string[]` | The IDs that were not found: never uploaded, not a document ID, deleted, expired, or another owner's. |
| `viewable` | `DocumentMeta[]` | The PDFs whose pages `view_pages` can show, whether their text is in the prompt or searched. Empty unless `prepare` was called with `viewPages: true`. Pass it to `tools(..., { viewPages })`. |

A document sent whole sits between these two lines (new in 0.6.0, for every document):

```text
--- Attached file [mark <mark>]: <name> (<format>, <lines> lines<reading>; it ends only at the line with mark <mark>) ---
<the text>
--- End attached file [mark <mark>] ---
```

- `<mark>` is eight hex digits made from the document ID, the same in every request, so a
  provider's prompt cache reuses the file. After an upgrade from 0.5.0, the first request of each
  conversation reads nothing of the file from the cache, since the frame lines changed. The
  file's own text cannot hold its mark: a line that
  copies the end of the frame has no mark or a wrong one, and the first line tells the model that
  only the line with the mark ends the file. This does not make the model obey, and the mark is
  not a secret (see [Security](../security.md#the-frame-around-a-file)).
- `<name>` is the name as a JSON string (`"report.txt"`): a quote in it is escaped.
  It comes after the mark, and the last line holds the mark alone, since the uploader chooses the
  name along with the text.
- `<lines>` has commas in the en-US way (`3,000 lines`), and a file of one line says `1 line`.
- `<reading>`, for a text file that was not valid UTF-8, is `, read as windows-1255`, then, when
  some characters were not valid in that encoding, `, 1 character not valid in it, shown as �`; or,
  for a file read as UTF-8, `, 3 characters not valid UTF-8, shown as �`. It is empty for any other
  file.

For example `--- Attached file [mark 1f0c3a9e]: "app.log" (log, 3,000 lines; it ends only at the line with mark 1f0c3a9e) ---`.
In 0.5.0 the lines were `--- Attached file: app.log (log, 3,000 lines) ---` and
`--- End attached file: app.log ---`. Code or tests that look for one file in `blocks` or in a
request can look for `]: `, then `JSON.stringify(name)`, then ` (`; `--- Attached file [mark `
starts every frame.

A card starts with `--- Large attached file: <name> ---`, as before. Its third line is
`<format> · <size> · <lines> lines · <pages> pages · about <tokens> tokens`, with `1 line` and
`1 page` for one. For a text file that was not valid UTF-8, a line after the way to read it says
`This file is not in UTF-8. Its text was read as windows-1255: if its letters look wrong, ask the user to save it as UTF-8.`,
followed, when some characters were not valid in it, by
` 3 characters of it were not valid in windows-1255, and show as �.`; or, for a file read as UTF-8,
`3 characters of this file were not valid UTF-8, and show as �.` For one character:
`1 character of it was not valid in windows-1255, and shows as �.` and
`1 character of this file was not valid UTF-8, and shows as �.`

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

### `DocumentPlan`

```ts
type DocumentPlan = { inline: DocumentMeta[]; searchable: DocumentMeta[]; inlineTokens: number; inlineBytes: number };
```

| Field | Type | What it holds |
|---|---|---|
| `inline` | `DocumentMeta[]` | The documents whose full text goes into the prompt, smallest first. |
| `searchable` | `DocumentMeta[]` | The documents the model reaches only through the tools. |
| `inlineTokens` | `number` | The `estimatedTokens` of the inline documents, added up. |
| `inlineBytes` | `number` | What the inline documents take in a JSON request body: for each, its `jsonBytes` (or `textBytes` × 1.08 when that is absent) plus 200. |

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

### `DEFAULT_CACHE_BYTES`

```ts
declare const DEFAULT_CACHE_BYTES: number; // 268_435_456 (256 MB)
```

The default of `LargeFilesOptions.cacheBytes`.

### `DEFAULT_WHOLE_DOCUMENT_BYTES`

```ts
declare const DEFAULT_WHOLE_DOCUMENT_BYTES: number; // 2_097_152 (2 MB)
```

The default of `LargeFilesOptions.wholeDocumentBytes`.

### `DEFAULT_MAX_PDF_PAGES`

```ts
declare const DEFAULT_MAX_PDF_PAGES = 5000;
```

The default of `LargeFilesOptions.maxPdfPages`. New in 0.6.0.

### `DEFAULT_MAX_TEXT_BYTES`

```ts
declare const DEFAULT_MAX_TEXT_BYTES: number; // 104_857_600 (100 MB)
```

The default of `LargeFilesOptions.maxTextBytes`, when `maxUploadBytes` is not larger. New in
0.6.0.

### `DEFAULT_INGEST_TIMEOUT_MS`

```ts
declare const DEFAULT_INGEST_TIMEOUT_MS = 120000; // 2 minutes
```

The default of `LargeFilesOptions.ingestTimeoutMs`. New in 0.6.0.

### `NEVER_EXPIRES`

```ts
declare const NEVER_EXPIRES = "9999-12-31T23:59:59.999Z";
```

The `expiresAt` of a document ingested with `ttlMs: Infinity`, or with any time to live that would
end at or after this instant. It is a date, so that every comparison, and a server of an older version,
reads it as any other.

### isDocumentId(value)

```ts
declare function isDocumentId(value: unknown): value is string;
```

`true` for a string that has the shape of a document ID: one `ingest` makes
([`DOCUMENT_ID_PATTERN`](#document_id_pattern)), or, since 0.9.0, one an application gives
([`APP_DOCUMENT_ID_PATTERN`](#app_document_id_pattern), which the made ones match too). Use it to
check IDs that come from a browser. The library's own methods already treat any other string as a
missing document.

### toDocumentSummary(meta)

```ts
declare function toDocumentSummary(meta: DocumentMeta): DocumentSummary;
```

The fields of a document that are safe to send to a browser (see
[`DocumentSummary`](#documentsummary)). `pages` is included only when the document has pages, and
`encoding` and `replacedCharacters` only when they are set. The handlers of
[`llm-large-files/node`](./node.md) answer with it.

## The budget

### `Budget`

```ts
type Budget = {
  contextTokens: number;
  maxRequestBytes: number;
  inlineTokens: number;
  reservedTokens: number;
  mapChunkTokens: number;
  maxMapChunks: number;
  toolResultCharacters: number;
};
```

The limits of the model connection that the documents must fit through. A field you leave out
follows the context window, so for a model with a smaller window, setting `contextTokens` is enough.

| Field | Default | Left out, it is | What it does |
|---|---|---|---|
| `contextTokens` | 1,000,000 | 1,000,000, or a model's smaller window | The model's context window, in tokens. |
| `maxRequestBytes` | 10,000,000 | 10,000,000, or a model's smaller limit | The largest request body your model connection accepts, in bytes. It is checked apart from tokens: non-English text and JSON escapes make bytes grow faster than tokens. |
| `inlineTokens` | 200,000 | half the window, 200,000 at most | The most document text sent whole in one request, in tokens. |
| `reservedTokens` | 64,000 | a quarter of the window, 64,000 at most | Tokens kept free for the answer, tool results and the growing conversation. Must be smaller than `contextTokens`. |
| `mapChunkTokens` | 100,000 | half the window, 100,000 at most | The size of each part when a whole document is read in parts. Must be smaller than `contextTokens`. |
| `maxMapChunks` | 30 | 30 | A whole-document read that needs more parts than this is refused. It counts parts: combining the notes and writing the answer are further model requests. `analyze_whole_document` is offered only for files whose estimate is within it, with 5% to spare. |
| `toolResultCharacters` | 24,000 | 12% of the window, between 1,000 and 24,000 | The cap on the characters of one tool result sent back to the model. The answer of `analyze_whole_document` may take up to 40,000 when this is lower. |

A field you set stays as you set it, except against a model's own limits
([`ModelLimits`](#modellimits)). `maxRequestBytes` drops to a model's smaller request size. When a
model's window is smaller than the one the values were given for, `contextTokens` drops to it and
the other values are lowered to fit it: `inlineTokens` to at most the window, `reservedTokens` and `mapChunkTokens` to at
most half of it, and `toolResultCharacters` to at most the window (at least 1,000). `maxMapChunks`
never changes.

Guide: [costs and limits](../guides/costs-and-limits.md).

### `DEFAULT_BUDGET`

```ts
declare const DEFAULT_BUDGET: Budget;
// { contextTokens: 1_000_000, maxRequestBytes: 10_000_000, inlineTokens: 200_000, reservedTokens: 64_000,
//   mapChunkTokens: 100_000, maxMapChunks: 30, toolResultCharacters: 24_000 }
```

The budget when nothing is set: a model with a 1M-token window behind a 10 MB request limit. It is
what `resolveBudget()` returns.

### resolveBudget(budget?, limits?)

```ts
declare function resolveBudget(budget?: Partial<Budget>, limits?: ModelLimits): Budget;
```

A whole [`Budget`](#budget) from the fields that are given, by the rules in its table. A field set to
`undefined` counts as not given. With `limits`, the smaller window and the smaller request size
hold, the fields left out follow that window, and the given ones are lowered to fit it.

| It throws | When |
|---|---|
| `Error("budget.<field> must be a number above 0, and is <value>.")` | A given field is not a finite number above 0: 0, a negative number, `NaN`, `Infinity`, a string. |
| `Error("budget.reservedTokens (<n>) must be smaller than budget.contextTokens (<n>): nothing would be left for the conversation.")` | `reservedTokens` is at or above `contextTokens`. |
| `Error("budget.mapChunkTokens (<n>) must be smaller than budget.contextTokens (<n>): a part of a whole-file read would not fit the model.")` | `mapChunkTokens` is at or above `contextTokens`. |

```ts
import { resolveBudget } from "llm-large-files";

resolveBudget({ contextTokens: 128_000 });
// { contextTokens: 128000, maxRequestBytes: 10000000, inlineTokens: 64000, reservedTokens: 32000,
//   mapChunkTokens: 64000, maxMapChunks: 30, toolResultCharacters: 15360 }

resolveBudget({ inlineTokens: 150_000 }, { contextTokens: 100_000, maxRequestBytes: 4_000_000 });
// { contextTokens: 100000, maxRequestBytes: 4000000, inlineTokens: 100000, reservedTokens: 25000,
//   mapChunkTokens: 50000, maxMapChunks: 30, toolResultCharacters: 12000 }
```

### `ModelLimits`

```ts
type ModelLimits = { contextTokens?: number | undefined; maxRequestBytes?: number | undefined };
```

A model's own limits, which a budget must stay within. `resolveBudget` and `files.budgetFor` take
it. `askWithFiles` builds it from what its adapters declare in
[`ModelCapabilities`](./ask.md#modelcapabilities).

| Field | Type | Default | What it does |
|---|---|---|---|
| `contextTokens` | `number \| undefined` | none | The model's context window. When it is smaller than the budget's, it holds: the fields left out follow it, and the given ones are lowered to fit it. Ignored unless it is a finite number above 0. |
| `maxRequestBytes` | `number \| undefined` | none | The largest request the model takes. The smaller of this and the budget's holds. Ignored unless it is a finite number above 0. |

## Stores

### `DocumentStore`

```ts
interface DocumentStore {
  put(document: StoredDocument, context?: DocumentContext): Promise<void>;
  get(id: string, context?: DocumentContext): Promise<StoredDocument | undefined>;
  getMeta(id: string, context?: DocumentContext): Promise<DocumentMeta | undefined>;
  delete(id: string, context?: DocumentContext): Promise<boolean>;
  sweep?(now?: Date, context?: DocumentContext): Promise<number>;
  putOriginal?(id: string, bytes: Uint8Array, context?: DocumentContext): Promise<void>;
  getOriginal?(id: string, context?: DocumentContext): Promise<Uint8Array | undefined>;
  readTextRange?(id: string, start: number, end: number, context?: DocumentContext): Promise<Uint8Array | undefined>;
  putIndex?(id: string, index: Uint8Array, context?: DocumentContext): Promise<void>;
  getIndex?(id: string, context?: DocumentContext): Promise<Uint8Array | undefined>;
}
```

Where the extracted text lives, with its metadata, and optionally the uploaded file and a line
index. Use [`MemoryDocumentStore`](#memorydocumentstore) or [`FileDocumentStore`](#filedocumentstore),
or implement it over a database, Redis or S3.

Every method takes a last, optional `context` ([`DocumentContext`](#documentcontext)): the scope
and the owner of the call. New in 0.9.0. A store written for 0.8, whose methods take no context,
still compiles and works: TypeScript lets a method with fewer parameters implement one with more.
A store that wraps another one, or a subclass that overrides a method, passes the context on:
`super.getMeta(id, context)`, `(id, context) => inner.getMeta(id, context)`. Without `context.scope`,
`sweep` removes the expired documents of every scope; with one, only those of that scope.

| Method | Required | What it must do, and when the library calls it |
|---|---|---|
| `put(document)` | yes | Store the text and the metadata. Called last at ingest. A document should exist once its metadata does: `FileDocumentStore` writes the metadata last. Keep every field of `meta`, the optional ones too, and those a later version adds (0.6.0 added `encoding` and `replacedCharacters`): a store that keeps a fixed list of fields loses them, and one that checks `meta` against a fixed schema refuses the ingest of every file that has them. |
| `get(id)` | yes | The whole document, or `undefined` when there is no such document. It may return an expired one: the library checks `expiresAt` itself. Called to load a document whole: its text is at most `wholeDocumentBytes`, or the store has no `readTextRange`. |
| `getMeta(id)` | yes | The metadata, or `undefined` when there is no such document (an expired one may be returned; the library checks `expiresAt`). Called by every `prepare`, `getMeta`, `getOriginal` and `delete`, by every tool call, and by `ingest` with an application's `id`: keep it cheap, apart from the text. Return the owner absent, not `null` (the library reads `null` as none). |
| `delete(id)` | yes | Remove the document, its original and its index, and return whether it existed. Also called by `ingest` after a failed write, so it must cope with a document that was written only in part, and before a document that `ifExists: "replace"` replaces. |
| `sweep(now?)` | no | Remove the documents expired at `now` (with their originals and indexes) and return how many. Without it, `files.sweep()` returns 0; expire the data another way, such as a TTL index of your database. |
| `putOriginal(id, bytes)` | no | Keep the uploaded file. Called at ingest, before `putIndex` and `put`, for the formats in `keepOriginals`. Without it, no original is kept, whatever `keepOriginals` says. |
| `getOriginal(id)` | no | The kept file, or `undefined` when none was kept or there is no such document. Without it, `view_pages` is never offered. |
| `readTextRange(id, start, end)` | no | Bytes `start` (inclusive) to `end` (exclusive) of the text exactly as given to `put`, as UTF-8: the line index is built from those bytes. Return fewer bytes at the end of the text, and `undefined` when the document is gone. Called only after `getMeta` found the document. Without it, every document is loaded whole. |
| `putIndex(id, index)` | no | Keep the line index of a document (a few bytes a line). Called at ingest before `put`, and when a document ingested without an index is first read by range (an error then is ignored). Without it, the index is built from the text each time a large document is opened. |
| `getIndex(id)` | no | The index kept by `putIndex`, or `undefined`. A damaged one is noticed and built again. An error is taken as no index. |

Errors:

- Return `undefined` (or `false` from `delete`) only when the document is not there. Throw for
  anything else: a volume that does not answer, a database that is down. What `get`, `getMeta`,
  `readTextRange` and `getOriginal` throw reaches the caller as
  [`DocumentStoreError`](#documentstoreerror), so that it retries instead of telling a user that the
  file is gone. A `DocumentStoreError` you throw yourself is passed on as it is.
- What `put`, `putOriginal` and `putIndex` throw at ingest reaches the caller as a
  `DocumentStoreError` of operation `"write"`, after `ingest` calls `delete(id)`; what `delete` and
  `sweep` throw, as one of operation `"delete"` or `"sweep"`. Your error is `cause`. Before 0.9.0
  they were passed on unchanged.
- Throw a [`DocumentScopeError`](#documentscopeerror) for a scope your store cannot keep, or a call
  without one when your store needs one.
- Keep fields of `meta` you do not know, `metaVersion` included
  ([`DOCUMENT_META_VERSION`](#document_meta_version)): a newer version of the package may add some.
- The library compares `expiresAt` with its clock itself, so an expired document is never used. The
  store must still remove it, in `sweep` or by its own expiry.

The library makes the IDs (see [`DOCUMENT_ID_PATTERN`](#document_id_pattern)), or the application
gives them ([`APP_DOCUMENT_ID_PATTERN`](#app_document_id_pattern)), and every method except `put`
receives only the ID and the context: no metadata. A store that lays documents out per user or per
chat session finds the place from `context.scope`. A store that ignores the context still works:
the library keeps scopes apart through `meta.scope`, and an application's IDs must then be unique
in the whole store.

Guide: [storage](../guides/storage.md), which also shows a store of your own.

### `DocumentContext`

```ts
type DocumentContext = { readonly scope?: DocumentScope; readonly owner?: string };
```

New in 0.9.0. Who a store call is for: the last argument of every [`DocumentStore`](#documentstore)
method. A store may keep the documents of each scope apart, as `MemoryDocumentStore` does. It keeps
at most one document of an ID in a scope: the owner says who may use a document, not where it is.
The library always passes one, frozen, with the fields that are absent left out: `{}` for a call
without a scope or an owner. Which one:

- At ingest, every call carries the document's owner and scope.
- `getMeta`, `getOriginal` and `delete` carry the caller's (`AccessOptions`), or for `tools` without
  `access`, those of the metadata handed in.
- The reads of a document's text (`get`, `readTextRange`, `getIndex`, and `putIndex` when its index
  is built again) carry the document's own owner and scope, once the library has checked that the
  caller may use it. The library keeps one copy of a document for every caller of its scope, so these
  reads carry the same context whoever's call made them. For a document without an owner, they have
  no owner, whoever asked.
- `sweep` gets the scope only.

| Field | Type | What it holds |
|---|---|---|
| `scope` | [`DocumentScope`](#documentscope) or `undefined` | Where the document belongs, such as `[userId, chatId]`. |
| `owner` | `string \| undefined` | The owner of the call, or of the document for the reads of its text. The library checks the owner of a document itself: a store need not. |

### `DocumentScope`

```ts
type DocumentScope = readonly string[];
```

New in 0.9.0. Where a document belongs, from the widest part to the narrowest: `[userId, chatId]`.
A scope has 1 to 8 segments. Each segment has 1 to 256 characters (UTF-16 units), holds no control
character, no `/` and no `\`, and is not `.` or `..`. A scope that breaks these rules is refused with
a [`DocumentScopeError`](#documentscopeerror) of code `"scope_invalid"`. Segments are compared
exactly: `"Alice"` and `"alice"` are two scopes.

### `StoredDocument`

```ts
type StoredDocument = { meta: DocumentMeta; text: string };
```

What a store keeps for a document, and what `put` receives and `get` returns.

| Field | Type | What it holds |
|---|---|---|
| `meta` | [`DocumentMeta`](#documentmeta) | The metadata. |
| `text` | `string` | The extracted, normalized text. Keep it byte for byte: `readTextRange` must return ranges of exactly this text as UTF-8. |

### `MemoryDocumentStore`

```ts
declare class MemoryDocumentStore implements DocumentStore {
  constructor(options?: { now?: () => Date });
  put(document: StoredDocument, context?: DocumentContext): Promise<void>;
  get(id: string, context?: DocumentContext): Promise<StoredDocument | undefined>;
  getMeta(id: string, context?: DocumentContext): Promise<DocumentMeta | undefined>;
  delete(id: string, context?: DocumentContext): Promise<boolean>;
  sweep(now?: Date, context?: DocumentContext): Promise<number>;
  putOriginal(id: string, bytes: Uint8Array, context?: DocumentContext): Promise<void>;
  getOriginal(id: string, context?: DocumentContext): Promise<Uint8Array | undefined>;
}
```

Keeps documents, and kept originals, in the memory of the process: for tests, scripts and
one-process demos. They are lost on restart and not shared between processes. It has no
`readTextRange`, so every document is loaded whole, whatever `wholeDocumentBytes` says. `get` and
`getMeta` remove an expired document and return `undefined`. `putOriginal` keeps a copy of the
bytes, so the caller may reuse its buffer. The metadata is copied too, on the way in (`put`) and
on the way out (`get`, `getMeta`), as a store that writes it somewhere does: changing the metadata
that `ingest` or `getMeta` returned (deleting its `owner` before it goes to a browser, say) changes
nothing stored. Until 0.6.0 it handed out its own object. `getOriginal` returns a copy of the kept
bytes too, since 0.9.0: until then it returned the bytes themselves.

The documents of each scope (`context.scope`) are kept apart, new in 0.9.0: one ID in two scopes is
two documents, and a call with one scope never sees the documents of another. Calls without a
scope share the documents of no scope, as every call did before. `sweep` without a scope removes
the expired documents of every scope. A scope that is not valid is a
[`DocumentScopeError`](#documentscopeerror).

| Option | Type | Default | What it does |
|---|---|---|---|
| `now` | `() => Date` | `() => new Date()` | The clock that decides expiry, and the default `now` of `sweep`. |

Guide: [testing](../guides/testing.md).

### `FileDocumentStore`

```ts
declare class FileDocumentStore implements DocumentStore {
  constructor(directory: string, options?: { now?: () => Date; orphanAgeMs?: number });
  put(document: StoredDocument): Promise<void>;
  get(id: string): Promise<StoredDocument | undefined>;
  getMeta(id: string): Promise<DocumentMeta | undefined>;
  delete(id: string): Promise<boolean>;
  sweep(now?: Date): Promise<number>;
  putOriginal(id: string, bytes: Uint8Array): Promise<void>;
  getOriginal(id: string): Promise<Uint8Array | undefined>;
  readTextRange(id: string, start: number, end: number): Promise<Uint8Array | undefined>;
  putIndex(id: string, index: Uint8Array): Promise<void>;
  getIndex(id: string): Promise<Uint8Array | undefined>;
}
```

Keeps each document as files in one directory, so documents survive a restart, and several servers
can share the directory on a network volume. It has every method, `readTextRange`, `putIndex` and
`getIndex` included, so large documents are read by range.

| File | What it holds |
|---|---|
| `<id>.json` | The metadata. A document exists while this file does. |
| `<id>.txt` | The text, as UTF-8. |
| `<id>.idx` | The line index. |
| `<id>.bin` | The uploaded file, when it is kept. |

- The directory is created at the first write.
- Every file is written under a temporary name (`<file>.<8 hex digits>.tmp`) and then renamed, so
  no server reads half a file. A rename that meets `EPERM`, `EACCES` or `EBUSY` (on Windows, another
  process has the file open for a moment) is tried again, for about 2.6 seconds in all.
- `put` writes the text, then the metadata. `put`, `putOriginal` and `putIndex` throw
  `Error("Invalid document ID.")` for an ID that does not match `DOCUMENT_ID_PATTERN`; for such an
  ID the reads return `undefined` and `delete` returns `false`. Only matching IDs reach the file system.
- `getMeta` returns `undefined` when the metadata file is missing or cannot be parsed (damaged, or
  being written by a server of 0.3.x), and removes an expired document and returns `undefined`.
  `get`, `readTextRange` and `getOriginal` return `undefined` for a missing file. Any other failure
  of a read is thrown. `getIndex` returns `undefined` for any failure.
- `delete` removes the metadata first, then the text, the index and the original, and returns
  whether the metadata existed. When the metadata cannot be removed, nothing else is, and the
  document stays whole.
- `sweep(now?)` removes expired documents and returns how many, counting a document whose metadata
  is not valid and is older than `orphanAgeMs`. It also removes files that belong to no document,
  and temporary files, once they are older than `orphanAgeMs` (these are not counted). A document
  whose metadata could not be read at all, or that could not be removed, is left for the next
  sweep. When the directory cannot be read, it returns 0.

| Option | Type | Default | What it does |
|---|---|---|---|
| `now` | `() => Date` | `() => new Date()` | The clock that decides expiry, and the default `now` of `sweep`. |
| `orphanAgeMs` | `number` | 3,600,000 (1 hour) | `sweep` removes files that belong to no document (an upload that failed, a server that stopped while writing) and temporary files only once they are this old. Younger ones may be an upload in progress, on this server or another one. |

Guides: [storage](../guides/storage.md), [deployment](../guides/deployment.md).

### `DOCUMENT_ID_PATTERN`

```ts
declare const DOCUMENT_ID_PATTERN: RegExp; // /^doc_[a-f0-9]{32}$/
```

The shape of every document ID that `ingest` makes: `doc_` and 32 lowercase hexadecimal digits
(a random UUID without its dashes), when the application gives none (`IngestInput.id`).

### `APP_DOCUMENT_ID_PATTERN`

```ts
declare const APP_DOCUMENT_ID_PATTERN: RegExp; // /^[a-z0-9][a-z0-9_-]{0,63}$/
```

New in 0.9.0. The shape of a document ID an application chooses (`IngestInput.id`): lowercase
letters, digits, `_` and `-`, up to 64 characters, starting with a letter or a digit. The IDs
`ingest` makes have it too. [`isDocumentId`](#isdocumentidvalue) tests a value against it.

### `DOCUMENT_META_VERSION`

```ts
declare const DOCUMENT_META_VERSION: 1;
```

New in 0.9.0. The version of [`DocumentMeta`](#documentmeta) this version of the package writes, as
`metaVersion`, and the highest it reads. Metadata without `metaVersion` (or with `null`) was
written before 0.9.0, and is read as before. Metadata with a higher one was written by a newer
version: `getMeta`, `getOriginal`, `delete`, `prepare`, `askWithFiles` and the tools refuse it
with a [`DocumentStoreError`](#documentstoreerror) of code `"NEWER_VERSION"`, not as a missing
document, so that an application does not ingest the file again over newer data. This happens
while servers of two versions share a store: let the call be tried again on a newer one.

### `DocumentStoreError`

```ts
type DocumentStoreOperation = "read" | "write" | "delete" | "sweep";

declare class DocumentStoreError extends Error {
  readonly code?: string;
  readonly syscall?: string;
  readonly operation: DocumentStoreOperation; // new in 0.9.0
  readonly status: 503; // new in 0.9.0
  constructor(cause: unknown, options?: { operation?: DocumentStoreOperation; code?: string });
  static is(value: unknown): value is DocumentStoreError; // new in 0.9.0
}
```

The store failed just now: a volume that did not answer, too many open files, a database that is
down. It does not mean that the document is gone, and the same call may work a moment later: retry
it, rather than ask the user to upload the file again.

| Field | Type | What it holds |
|---|---|---|
| `name` | `string` | `"DocumentStoreError"`. |
| `message` | `string` | By `operation`: `The document store could not be read (<code>). Try again.` ("read"), `The document could not be stored (<code>). Try again.` ("write"), `The document could not be deleted (<code>). Try again.` ("delete"), `The document store could not be cleaned up (<code>). Try again.` ("sweep"), each without the code when there is none. For code `"NEWER_VERSION"`: `The document was stored by a newer version of llm-large-files. Try again.` It names no path and no host: it is safe to show to a user or a model. |
| `code` | `string \| undefined` | The code of the system error behind it (`EIO`, `EMFILE`, `ETIMEDOUT`), when there is one, or the code it was made with: `"NEWER_VERSION"` for metadata a newer version of the package wrote ([`DOCUMENT_META_VERSION`](#document_meta_version)). |
| `syscall` | `string \| undefined` | The system call that failed (`open`, `read`), when there is one. |
| `operation` | `"read" \| "write" \| "delete" \| "sweep"` | What the store was doing. `"read"` unless it was made with another. New in 0.9.0. |
| `status` | `503` | The HTTP status to answer with. New in 0.9.0. |
| `cause` | `unknown` | What the store threw. Log it on the server; it may name a path or a host. |

`DocumentStoreError.is(value)` tells whether a value is one, also when another copy of the package
made it (two versions installed side by side, or one in a bundle), where `instanceof` is `false`.
New in 0.9.0.

`files.getMeta`, `files.getOriginal`, `files.delete` (its look-up) and `files.prepare` throw it,
and so does `askWithFiles`. A tool call that meets it answers the model with its message instead of
throwing. Since 0.9.0 the library also wraps the errors of writes in it: `files.ingest` (operation
`"write"`, and code `"ETIMEDOUT"` for a write that did not end in time), `files.delete`
(`"delete"`) and `files.sweep` (`"sweep"`). Until then they were passed on unchanged (see
[`DocumentStore`](#documentstore)). A `DocumentScopeError` is never wrapped.

```ts
import { DocumentStoreError, toDocumentSummary, type LargeFiles } from "llm-large-files";

// `files` is your library.
async function documentSummary(files: LargeFiles, id: string, owner: string) {
  try {
    const meta = await files.getMeta(id, { owner });
    return meta ? { status: 200, body: toDocumentSummary(meta) } : { status: 404, body: { error: "Not found." } };
  } catch (error) {
    if (!DocumentStoreError.is(error)) throw error;
    console.error(error.cause); // what the store threw: for your log only
    return { status: error.status, body: { error: error.message } };
  }
}
```

Guide: [errors and reliability](../guides/errors-and-reliability.md).

### `DocumentScopeError`

```ts
type DocumentScopeErrorCode = "scope_required" | "scope_invalid" | "scope_missing";

declare class DocumentScopeError extends TypeError {
  readonly code: DocumentScopeErrorCode;
  constructor(code: DocumentScopeErrorCode, message?: string, options?: { cause?: unknown });
  static is(value: unknown): value is DocumentScopeError;
}
```

New in 0.9.0. A scope ([`DocumentScope`](#documentscope)) that cannot be used. It is a mistake in
the call, not a failure of the store: the same call fails again, so do not retry it. The library
passes it on as it is. Its message never repeats a segment of the scope, which may be a user's ID.

| Code | When | Message, unless another is given |
|---|---|---|
| `"scope_invalid"` | The scope breaks the rules of [`DocumentScope`](#documentscope), or the store cannot keep it. | Which rule, and which segment: `scope segment 2 cannot be "." or "..".` |
| `"scope_required"` | The store needs a scope, and the call had none. | `A scope is required: pass the scope of the document, such as [userId, chatId].` |
| `"scope_missing"` | The store keeps the scope in a place that is gone (the chat was deleted). | `The scope no longer exists.` |

`DocumentScopeError.is(value)` works across copies of the package, as `DocumentStoreError.is` does.

## Extraction

### `Extractor`

```ts
type Extractor = (bytes: Uint8Array, input: ExtractInput) => Promise<ExtractedText>;
```

Turns the bytes of an uploaded file into text, for one format. To refuse a file, throw an `Error`
whose message a user can read: `ingest` throws it as an [`IngestError`](#ingesterror) with the same
message, the code its message gives (`"unreadable"` for words the library does not know), and your
error as `cause`. Throw an `IngestError` yourself to choose the code. The library then normalizes the
text, splits long lines and refuses blank text, as described under
[`files.ingest`](#filesingestinput). For a PDF, write a line `--- Page N ---` before the text of
each page, counting from 1, as the built-in one does: the page numbers in tool results and
`view_pages` are read from those lines.

```ts
import { createLargeFiles, defaultExtractors, MemoryDocumentStore, type Extractor } from "llm-large-files";

// An .xml file is detected as "text". This extractor drops its tags before the text is stored.
const text: Extractor = async (bytes, input) => {
  const extracted = await defaultExtractors.text(bytes, input);
  if (!input.name.toLowerCase().endsWith(".xml")) return extracted;
  return { ...extracted, text: extracted.text.replace(/<[^>]+>/g, " ") };
};

const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text } });
```

Guide: [PDFs](../guides/pdfs.md), for OCR and other PDF extractors.

### `ExtractInput`

```ts
type ExtractInput = {
  name: string;
  mimeType: string;
  format: DocumentFormat;
  scannedPages?: number;
  signal?: AbortSignal;
  maxTextBytes?: number;
  maxPages?: number;
  onProgress?: (progress: ExtractProgress) => void;
};
```

| Field | Type | What it holds |
|---|---|---|
| `name` | `string` | The cleaned file name (see [`IngestInput`](#ingestinput)). |
| `mimeType` | `string` | The MIME type, `"application/octet-stream"` when none was given. |
| `format` | [`DocumentFormat`](#documentformat) | The format from `detectFormat`. A text file that turns out to be a log is still `"text"` here: logs are recognized after extraction. |
| `scannedPages` | `number \| undefined` | Set for a PDF when one without any text may be accepted: `"pdf"` is in `keepOriginals`, the store has `putOriginal`, and `scannedPdfPages` is above 0. It is the most pages such a PDF may have. Unset, a PDF without text is to be refused. An extractor of your own may ignore it. |
| `signal` | `AbortSignal \| undefined` | The signal of the ingest: aborted after `ingestTimeoutMs`, or when `IngestInput.signal` aborts. Its `reason` is the error to throw. The PDF, DOCX, PPTX, XLSX and HTML extractors stop between pages and pieces. The text extractor decodes valid UTF-8 and UTF-16 in one step, and a file that is not valid UTF-8 a step at a time, whatever it is read in, stopping between two steps. `ingest` sets it, and stops waiting for your extractor when it aborts, but cannot stop the work your extractor does: pass it on (to `fetch`, for example), or check it between steps with `signal.throwIfAborted()`. |
| `maxTextBytes` | `number \| undefined` | `LargeFilesOptions.maxTextBytes`: the most text to keep, in UTF-8 bytes. `ingest` sets it, and refuses a larger text from any extractor once it returns. An extractor that refuses as soon as its text grows past it spares the memory. |
| `maxPages` | `number \| undefined` | `LargeFilesOptions.maxPdfPages`: the most pages to read from one PDF. `ingest` sets it for every format; only the built-in PDF extractor uses it. `ingest` does not check it for you. |
| `onProgress` | `((progress: ExtractProgress) => void) \| undefined` | Call it as the extraction goes on, so that `ingest` can report progress ([`ExtractProgress`](#extractprogress)). Set only when someone listens to the ingest's events (`IngestInput.onEvent`). The built-in extractors call it for each page of a PDF, each part of a DOCX, each slide of a PPTX and each sheet of an XLSX, and once when an HTML file is decoded. An extractor of your own may ignore it: the ingest then sends no `extract` progress. What it reports after it returned is dropped. It can throw, when the listener of the events throws: let that error end the extraction. New in 0.7.0. |

### `ExtractProgress`

```ts
type ExtractProgress = {
  stage?: "extract" | "check" | "pictures" | "decode";
  done: number;
  total?: number;
  unit: "pages" | "parts" | "bytes";
};
```

New in 0.7.0. How far an extraction is, for `ExtractInput.onProgress`. Each call becomes an
`ingest.progress` event of that stage, at most one about every 12 ms for each stage, and the last
one when the stage ends. A call whose `stage` or `unit` is not one of these, or whose `done` is not
a number of 0 or more, is left out.

| Field | Type | What it holds |
|---|---|---|
| `stage` | `"extract" \| "check" \| "pictures" \| "decode"`, optional | `"extract"` (the default): text read. `"check"`: pages checked before they are read. `"pictures"`: pages looked at for pictures. `"decode"`: bytes of a text file decoded. |
| `done` | `number` | How many are done. |
| `total` | `number`, optional | How many there are, when it is known. |
| `unit` | `"pages" \| "parts" \| "bytes"` | What `done` and `total` count. |

```ts
import { createLargeFiles, MemoryDocumentStore, type Extractor } from "llm-large-files";

// readPage is your own: the text of one page of a PDF, from an OCR service.
declare function readPage(bytes: Uint8Array, page: number, signal?: AbortSignal): Promise<string>;
declare function pageCount(bytes: Uint8Array): Promise<number>;

const pdf: Extractor = async (bytes, input) => {
  const pages = await pageCount(bytes);
  const texts: string[] = [];
  for (let page = 1; page <= pages; page++) {
    input.signal?.throwIfAborted();
    texts.push(`--- Page ${page} ---\n${await readPage(bytes, page, input.signal)}`);
    input.onProgress?.({ done: page, total: pages, unit: "pages" }); // an ingest.progress of stage "extract"
  }
  return { text: texts.join("\n\n"), pages };
};

const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { pdf } });
```

### `ExtractedText`

```ts
type ExtractedText = { text: string; pages?: number; encoding?: string; replacedCharacters?: number };
```

| Field | Type | What it holds |
|---|---|---|
| `text` | `string` | The text of the file. |
| `pages` | `number \| undefined` | The number of pages (the slides of a PPTX, the sheets of an XLSX), stored as `DocumentMeta.pages`. |
| `encoding` | `string \| undefined` | The older encoding the file was read in, when it is not UTF-8, such as `"windows-1255"`. Stored as `DocumentMeta.encoding` when it is a name (letters, digits, `.`, `_`, `:` and `-`, up to 40 characters) and not a name of UTF-8 or UTF-16 (`utf-8`, `utf8`, `unicode`, `utf-16be`…): a name `TextDecoder` does not know is kept. New in 0.6.0. |
| `replacedCharacters` | `number \| undefined` | The characters that were not valid in the encoding the file was read in, each now U+FFFD (�). Stored as `DocumentMeta.replacedCharacters` when it is a whole number above 0. New in 0.6.0. |

The model is told of both, on the card and in the frame of a file sent whole (see
[`PreparedContext`](#preparedcontext)).

### `defaultExtractors`

```ts
declare const defaultExtractors: Record<DocumentFormat, Extractor>;
```

The built-in extractor of each format, used for every format you do not replace in
`LargeFilesOptions.extractors`. Call one from an extractor of your own to wrap it.

| Format | What the extractor does |
|---|---|
| `text`, `markdown`, `log`, `json`, `csv` | Decodes the bytes as UTF-8, or as UTF-16 when they start with a byte-order mark or look like little-endian UTF-16 without one. A file that is not valid UTF-8 is read as UTF-8 when it starts with a UTF-8 byte-order mark, when at least as many of its lines count as UTF-8 as count as not (a line counts as UTF-8 when it holds at least as many characters of more than one byte as characters that are not valid), or when at most one line in 200 is not UTF-8. Otherwise it is read in windows-1255, windows-1256, windows-1251, Shift_JIS or windows-1252 when its lines with letters fit one, its lines that are valid UTF-8 as UTF-8; and when none fits, as UTF-8, as 0.5.0 read it. Each character that is not valid in the encoding it is read in becomes U+FFFD. It returns `encoding` and `replacedCharacters` ([`ExtractedText`](#extractedtext)), and reads such a file a step at a time, with pauses for other requests. It never refuses a file for its encoding. It refuses gzip, ZIP and other binary files, and the Office files of before 2007 or with a password. See [Text encodings](../guides/pdfs.md#text-encodings). |
| `pdf` | [`createPdfExtractor()`](#createpdfextractoroptions). Needs the optional dependency `unpdf`, in a version that runs on this Node, and `@cantoo/pdf-lib` to mark pages with pictures and to refuse a page that would hold the server. |
| `docx` | The paragraphs of the main document first, one line each. A paragraph of a heading style (`Heading 1` to `Heading 6`, also in a Hebrew document, whose styles keep English names), of the `Title` style or with an outline level is a Markdown heading (`## 2.1 Rent`). A paragraph of a list starts with the number Word shows before it, in Word's formats (`2.1`, `(a)`, roman numerals, Hebrew letters and numerals, `-` for a bullet, lists that restart). A table is a line a row, `\| cell \| cell \|  \|`, its empty cells kept, and a merged cell followed by an empty cell for each column it covers. Non-breaking hyphens and the characters of symbol fonts are kept. Then the footnotes, endnotes, comments, headers and footers, in that order, each part under a heading of its own (`# Footnotes`, `# Endnotes`, `# Comments`, `# Header`, `# Footer`), with a blank line between parts; a header or footer whose text repeats one already read is left out. A text box is read once. The text of a run that Word hides (`<w:vanish/>`) comes after the text of its paragraph that shows, each of its lines starting with `[Hidden text, not shown in the document]`: a carriage return, a U+0085 or a line separator in it starts a new marked line, a line of more than about 1,950 characters is cut into marked pieces, and the text of a run inside a hidden run (the reading of a ruby) is marked too. The marks count toward the limits of text. Text hidden through a style is read as ordinary text. Needs the optional dependency `jszip`. Headings, numbers, tables and comments are new in 0.8.0: documents ingested before keep their text until they are uploaded again. |
| `pptx` | One `## Slide N` section per slide, numbered in the order of the slide show (the list in `ppt/presentation.xml`; the part names when it has none), with its text, its tables as rows of `\| cell \| cell \|`, and its speaker notes after a line `[Speaker notes]`. `[No text on this slide]` for a slide without text. A slide that the slide show skips (`show="0"`) keeps its text, under `## Slide N (hidden, not shown in the slide show)`. `pages` is the number of slides. Needs `jszip`. Until 0.8.0 slides were numbered in the order of their part names, without tables or notes. |
| `xlsx` | New in 0.8.0. Excel workbooks (`.xlsx`, `.xlsm`, `.xltx`, `.xltm`). Each sheet, in the order of the workbook, is a section: `## Sheet 1: Sales` (with ` (hidden sheet)` for a hidden one), then a line `Columns: \| A \| B \| C \|` (`Columns: A to BZ` past 52 columns), then a line a row, `Row 12: \| East \| 2026-03-01 \| 1200.5 \|`, numbered as in Excel, its empty cells kept up to its last value. A cell holds the value Excel last computed (a formula without one is written as `=` and the formula); dates and times from their number formats (1900 and 1904 date systems), percentages as `12.5%`, numbers to 15 significant digits. Empty rows are left out, and a sheet without a value says `[No values on this sheet]`. Every row of every sheet is read, within the limits on text. `pages` is the number of sheets. Needs `jszip`. |
| `html` | New in 0.8.0. The text a browser shows: scripts, styles and other content that is not read are dropped; headings become Markdown headings, list items `- item` (or `1. item`), table rows `\| cell \| cell \|`, a link `text (https://…)`, a picture its alt text. A cell that spans columns or rows (`colspan`, `rowspan`) is followed by empty cells, so each row keeps its columns. Text the page hides (the `hidden` attribute, an inline `display: none` or `visibility: hidden`) is kept, each line marked `[Hidden text, not shown in the document]` as Word's hidden text is; hiding through a style sheet or a class is not seen. The title becomes a `#` heading when no heading of the page holds it; a `<title>` never closed names nothing, and the text after it is read as the page. Entities are decoded: `AT&amp;T` is found as "AT&T". The bytes are decoded as a text file's are, in an older encoding when it is not UTF-8, and binary files are refused the same way. |

The messages they refuse a file with, which `ingest` throws as [`IngestError`](#ingesterror)s, each
with the code of its words ([`ingestErrorCodeOf`](#ingesterrorcodeofmessage)):

- `This file looks binary, not text. Attach a text, log, PDF, Word, PowerPoint, Excel or HTML file.` (until 0.8.0: `… Attach a text, log, PDF, DOCX, or PPTX file.`)
- `This file is gzip-compressed. Decompress it, then attach the text file inside.`
- `This file is a ZIP archive. Extract it, then attach the text file you need.` (a ZIP whose name is not of a DOCX, PPTX or XLSX: `.zip`, `.odt`)
- `This is a Word, Excel or PowerPoint file of before 2007 (.doc, .xls, .ppt), an Outlook message (.msg), or an Office file protected by a password and stored that way. None of these can be read: save it as .docx, .xlsx, .pptx, PDF or text, without a password, and attach that.` (new in 0.8.0: until then such a file was refused as binary, or failed as a damaged file)
- `This PDF is protected by a password, so it cannot be read. Open it, print it to a new PDF without the password, and attach that.` (new in 0.8.0: pdf.js said "No password given")
- `Reading PDF files needs the optional dependency "unpdf".`
- `The optional dependency "<name>" is installed but could not be loaded (<the reason>). Reinstall it, or install a version this Node can run.` (new in 0.8.0: it was reported as missing; the failure is `cause`)
- `The unpdf installed would stop the whole server at the first PDF file on Node <n>, so PDF files are not read.`, followed by what to install: before Node 24 `Install unpdf 1.6.1 or later, or run Node 24 or later.`, on a later Node `Install unpdf 1.6.1 or later.` (an `unpdf` from 1.5.0 to 1.6.0, which loads a pdf.js that calls `Promise.try` where Node does not have it; new in 0.6.0. Until 0.9.0, Node 20 was told to install unpdf 1.7.0.)
- An `unpdf` that cannot load its pdf.js fails with unpdf's own error. (Until 0.9.0, on Node 20, that error was wrapped as `The unpdf installed cannot read PDF files on Node 20 (<unpdf's message>). …`.)
- `This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.`
- `This PDF has no text layer (it may be scanned) and <n> pages. Without text it can only be read by looking at its pages, which works for up to <m> pages. It needs OCR first.`
- `Reading DOCX, PPTX and XLSX files needs the optional dependency "jszip".` (until 0.8.0: `Reading DOCX and PPTX files …`)
- `This DOCX does not contain word/document.xml.`, `This PPTX does not contain any slides.`, `This XLSX does not contain xl/workbook.xml.` and `This XLSX does not contain any sheets with cells.`
- `This XLSX has more than 2,097,152 different texts, more than a workbook holds. It may be built to exhaust the server, so it is not read.`
- `This XLSX holds more text than is kept from one file. Split it, and attach the part you need.` (`maxTextBytes`; `… than is read from one file.` past 32 million characters)
- `This DOCX unpacks to more than <n> MB, over 100 times its size. A file that grows that much is not read: it may be a zip bomb. Save it as text or PDF, and attach that.` (past the first 16 MB; `PPTX` for a presentation)
- `This DOCX unpacks to more than 128 MB of XML, more than is read from one file. Save it as text or PDF, and attach that.`
- `This PDF has <n> pages, more than the <m> read from one file. Split it, and attach the part you need.` (`maxPdfPages`, before any page is read)
- `This PDF holds more than <n> MB of text, more than is kept from one file. Split it, and attach the part you need.` (`maxTextBytes`, counted page by page; `KB` below 1 MB, `B` below 1 KB)
- `This PDF draws more than <n> MB of text, over 100 times its size. A file that grows that much is not read: it may be built to exhaust the server.` (text past 100 times the size of the file, after the first 16 MB, when that comes before `maxTextBytes`)
- `This PDF lists the same page more than once. A file built that way can hold far more text than its size, so it is not read. Print it to a new PDF, and attach that.`
- `This DOCX holds more than 32 million characters of text, more than is read from one file. Split it, and attach the part you need.` (from one Office file, whatever `maxTextBytes` allows; the marks of hidden text count)
- `This DOCX holds more than <n> MB of text, more than is kept from one file. Split it, and attach the part you need.` (when `maxTextBytes` is below 32 million)
- `This DOCX has more than 1,000,000 paragraphs, more than a document holds. It may be built to exhaust the server, so it is not read.` (paragraphs with text), or `… 1,000,000 paragraphs and table cells, …` when table cells, empty ones included, bring the count past it
- `The XML has a tag far longer than any Office file writes. It may be built to exhaust the server, so it is not read.`
- `This DOCX nests paragraphs more than 32 deep, which no document does. It may be built to exhaust the server, so it is not read.`
- `This DOCX has more than 20,000 parts, more than an Office document has. It may be built to exhaust the server, so it is not read.` (before JSZip reads the file: its ZIP directory is read the way JSZip will read it, record by record, whatever count of parts the file gives)
- `This DOCX lists its parts in a way that no Office program does: reading the list would take far more memory or time than an Office document needs. It may be built to exhaust the server, so it is not read.` (more than 80,000 extra fields, or more than 8 MB of names, comments and extra-field data that JSZip would turn into text or go through byte by byte: a name is counted once for each part that points to it, and a field for all the data it says it has, even past its record)
- `This DOCX ends with a ZIP64 record that cannot be read, and reading it could hold the server without end. It may be built to exhaust the server, so it is not read.` (a ZIP64 end record that says it is longer than its fields, which JSZip reads in a loop that does not move on)

The Office messages say `PPTX` for a presentation and `XLSX` for a workbook. A PDF or an Office
file that is damaged fails with the message of pdf.js or JSZip, as an `IngestError` of code
`"unreadable"` whose `cause` is their error.

### createPdfExtractor(options?)

```ts
declare function createPdfExtractor(options?: PdfExtractorOptions): Extractor;
```

The built-in PDF extractor, with an option changed. It needs the optional dependency `unpdf`. It
writes each page as a line `--- Page N ---` followed by the page's text, and
`[No text on this page. It may be a scan, a photo, or a chart.]` for a page without text. With
`pictures`, a page that shows a picture or a drawing gets the line
`[Picture on this page. This text cannot show it.]` under its page line. It returns the number of
pages. It throws the PDF messages listed under [`defaultExtractors`](#defaultextractors).

```ts
import { createLargeFiles, createPdfExtractor, MemoryDocumentStore } from "llm-large-files";

// The text in pdf.js order, without rebuilt tables, as in version 0.1.0.
const files = createLargeFiles({
  store: new MemoryDocumentStore(),
  extractors: { pdf: createPdfExtractor({ tables: false }) },
});
```

Guide: [PDFs](../guides/pdfs.md).

### `PdfExtractorOptions`

```ts
type PdfExtractorOptions = { tables?: boolean; pictures?: boolean; checkPages?: boolean };
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `tables` | `boolean` | `true` | Rebuilds tables from the position of the text, and writes each row as `\| cell \| cell \|  \|`, so an empty cell stays an empty cell. `false` gives the text in pdf.js order, as in version 0.1.0. |
| `pictures` | `boolean` | `true` | Writes `[Picture on this page. This text cannot show it.]` under the page line of every page that shows a picture or a drawing, so the model knows that the text does not tell all of that page. Needs the optional dependency `@cantoo/pdf-lib`; without it, and with `false`, no page is marked. |
| `checkPages` | `boolean` | `true` | Before pdf.js reads any page, adds up what each page would make it run, and refuses a file with a page that would hold the server for a long time ([Pages that would hold the server](../guides/pdfs.md#pages-that-would-hold-the-server)). Needs the optional dependency `@cantoo/pdf-lib`; without it, and with `false`, every page is read however long it takes. With `false` and `pictures: false`, the file is not read with `@cantoo/pdf-lib` at ingest. New in 0.6.0. |

### detectFormat(name, mimeType, bytes?)

```ts
declare function detectFormat(name: string, mimeType: string, bytes?: Uint8Array): DocumentFormat;
```

The format of a file: from the extension after the last dot (in any case), then from the MIME type,
else `"text"`. New in 0.8.1: with `bytes`, a file that would be `"text"` and is not named `.txt`
is known by its content: `"pdf"` when it starts with `%PDF-` (after a byte order mark or white
space), `"docx"`, `"pptx"` or `"xlsx"` for a ZIP archive with the parts of one (`word/document.xml`,
`ppt/presentation.xml`, `xl/workbook.xml`), `"html"` when it starts with `<!DOCTYPE html` or
`<html`. `ingest` passes the bytes: a DOCX uploaded without its extension was told "This file is a
ZIP archive". The MIME type is lowercased and compared whole, so `text/csv; charset=utf-8` names no
format. A name without a dot is looked up whole, so a file named `log` is a `log`. `ingest` uses it,
then turns a `"text"` document that reads like a log into `"log"`.

| Format | Extensions | MIME types |
|---|---|---|
| `log` | `.log`, `.out`, `.err` | none (also text recognized as a log at ingest) |
| `markdown` | `.md`, `.markdown` | `text/markdown` |
| `json` | `.json`, `.jsonl`, `.ndjson` | `application/json` |
| `csv` | `.csv`, `.tsv` | `text/csv` |
| `pdf` | `.pdf` | `application/pdf` |
| `docx` | `.docx`, `.docm` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `pptx` | `.pptx`, `.pptm` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `xlsx` | `.xlsx`, `.xlsm`, `.xltx`, `.xltm` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel.sheet.macroenabled.12` |
| `html` | `.html`, `.htm`, `.xhtml` | `text/html`, `application/xhtml+xml` |
| `text` | any other | any other |

`xlsx` and `html` are new in 0.8.0: until then an `.xlsx` was refused as a ZIP archive, and an
`.html` file was `text`, read with its tags.

Guide: [PDFs](../guides/pdfs.md).

## Text sizes

### estimateTokens(text)

```ts
declare function estimateTokens(text: string): number;
```

Estimates how many tokens a model counts for `text`, without calling it. It prices each kind of
character (runs of letters, digits at about one token each, punctuation, line breaks, and each
script), because characters per token vary from about 4.5 for English prose to 1 or 2 for logs and
CSV. It was fitted to Gemini's `countTokens` on 60 texts and lands between 0.98 and 1.7 times that
count: it leans high, which only makes a file searchable sooner. The one kind of text it counts low,
at about 70%, is a long run of random letters in one case with no digits. `ingest` stores it as
`estimatedTokens`. See [how it works](../how-it-works.md).

### utf8Bytes(text)

```ts
declare function utf8Bytes(text: string): number;
```

The size of `text` in UTF-8, in bytes, without encoding a copy. `utf8Bytes("héllo")` is 6.

### jsonBytes(text)

```ts
declare function jsonBytes(text: string): number;
```

The bytes `text` takes as a string in a JSON request body, which is what a request limit counts: its
UTF-8 bytes, one more for each quote, backslash, line break, tab, carriage return, backspace and
form feed, five more for any other control character, three more for half of a surrogate pair on
its own, and the two quotes around it.
`jsonBytes('say "hi"\n')` is 14.

## Document types

### `DocumentMeta`

```ts
type DocumentMeta = {
  id: string;
  metaVersion?: number; // new in 0.9.0
  owner?: string;
  scope?: string[]; // new in 0.9.0
  name: string;
  mimeType: string;
  format: DocumentFormat;
  bytes: number;
  textBytes: number;
  jsonBytes?: number;
  characters: number;
  lines: number;
  estimatedTokens: number;
  wrappedLines: number;
  pages?: number;
  encoding?: string;
  replacedCharacters?: number;
  originalKept?: boolean;
  outline: OutlineEntry[];
  logProfile?: LogProfile;
  pagesWithoutText?: number[]; // new in 0.8.1
  garbledPages?: number[]; // new in 0.8.1
  scripts?: Array<{ script: string; percent: number }>; // new in 0.8.1
  createdAt: string;
  expiresAt: string;
};
```

The metadata of a stored document, made by `ingest`. It holds the owner and text from the file
(the outline, the log profile): send [`toDocumentSummary(meta)`](#todocumentsummarymeta) to a
browser instead.

| Field | Type | What it holds |
|---|---|---|
| `id` | `string` | `doc_` and 32 hexadecimal digits ([`DOCUMENT_ID_PATTERN`](#document_id_pattern)), or the ID the application gave (`IngestInput.id`, new in 0.9.0). |
| `metaVersion` | `number \| undefined` | The version of this shape: [`DOCUMENT_META_VERSION`](#document_meta_version) (1) on documents ingested by 0.9.0 and later, absent on older ones. A higher one is refused. Never sent to the model. New in 0.9.0. |
| `owner` | `string \| undefined` | The owner given at ingest. Absent when none was given. |
| `scope` | `string[] \| undefined` | The scope given at ingest (`IngestInput.scope`), as a copy. Absent when none was given. Only a caller of the same scope may use the document. Never sent to the model, nor in a summary or an event. New in 0.9.0. |
| `name` | `string` | The cleaned file name (see [`IngestInput`](#ingestinput)). |
| `mimeType` | `string` | The MIME type given, trimmed, or `"application/octet-stream"`. |
| `format` | [`DocumentFormat`](#documentformat) | The format. |
| `bytes` | `number` | The size of the uploaded file. |
| `textBytes` | `number` | The size of the extracted text in UTF-8. |
| `jsonBytes` | `number \| undefined` | The bytes the text takes inside a JSON request body, with the escapes JSON adds. Absent on a document ingested before 0.4.1: planning then assumes `textBytes` × 1.08. |
| `characters` | `number` | The length of the text, in UTF-16 code units (a JavaScript string's `length`). |
| `lines` | `number` | The number of lines of the text. A final line break does not start another line. |
| `estimatedTokens` | `number` | [`estimateTokens`](#estimatetokenstext) of the text. |
| `wrappedLines` | `number` | How many lines longer than 2,000 characters were split into several, so that every line can be read by number. |
| `pages` | `number \| undefined` | The pages of a PDF, the slides of a PPTX, the sheets of an XLSX, or what your extractor returned. |
| `encoding` | `string \| undefined` | The older encoding a text file was read in, because it is not UTF-8, as `TextDecoder` names it: `"windows-1255"` for a Hebrew CSV that Excel saved, or `"windows-1256"`, `"windows-1251"`, `"shift_jis"`, `"windows-1252"`. Lines of it that are valid UTF-8 are read as UTF-8 all the same. Absent for valid UTF-8, for a file read as UTF-8 with characters that are not valid (see `replacedCharacters`), for UTF-16, for PDF, DOCX, PPTX and XLSX, and on documents from before 0.6.0. An HTML file is decoded as a text file is, and can have one. An extractor of your own may set another name ([`ExtractedText`](#extractedtext)). How the encoding is chosen: [Text encodings](../guides/pdfs.md#text-encodings). New in 0.6.0. |
| `replacedCharacters` | `number \| undefined` | The characters of a text file that were not valid in the encoding it was read in (UTF-8, or `encoding`), such as a character cut in two at the end of a UTF-8 log, or a byte that `encoding` does not have: each is stored as U+FFFD (�). Absent when there were none, and on documents from before 0.6.0. New in 0.6.0. |
| `originalKept` | `boolean \| undefined` | `true` when the uploaded file is kept in the store (`keepOriginals`). Absent otherwise. Documents ingested before you turned `keepOriginals` on have no original. |
| `outline` | [`OutlineEntry[]`](#outlineentry) | The headings found in the text, at most 400. Empty for `log`, `json` and `csv`. |
| `logProfile` | [`LogProfile`](#logprofile) or `undefined` | The log profile, for a `log` document only. |
| `pagesWithoutText` | `number[]` or `undefined` | The pages of a PDF with no text at all (scans, photos, charts), up to 200. Absent when there are none, and on documents from before 0.8.1. The card names them, and points to `view_pages` when they can be looked at. New in 0.8.1. |
| `garbledPages` | `number[]` or `undefined` | The pages of a PDF whose text looks garbled: of at least 40 characters, fewer than 3 in 10 letters or digits, or more than max(6, 3%) replacement characters (a font without a Unicode map). Up to 200. The card says not to rely on them. New in 0.8.1. |
| `scripts` | `{ script, percent }[]` or `undefined` | The scripts of the text by their share of its letters, from its first 2 MB, those of 5% or more: "Latin", "Hebrew", "Arabic", "Cyrillic", "Greek", "CJK", "Devanagari", "Thai". Absent for a text in Latin letters alone, one with fewer than 200 letters, and documents from before 0.8.1. The card says "Written in: Hebrew 81%, Latin 19%. Search in the language of the text." New in 0.8.1. |
| `createdAt` | `string` | When it was ingested, as an ISO 8601 date. |
| `expiresAt` | `string` | When it expires, as an ISO 8601 date: `createdAt` plus `ttlMs`, or [`NEVER_EXPIRES`](#never_expires). |

### `DocumentSummary`

```ts
type DocumentSummary = {
  id: string;
  name: string;
  mimeType: string;
  format: DocumentFormat;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  pages?: number;
  encoding?: string;
  replacedCharacters?: number;
  expiresAt: string;
};
```

A JSON-safe summary of a document for API responses and browser state, made by
[`toDocumentSummary`](#todocumentsummarymeta). Its fields mean what they mean in
[`DocumentMeta`](#documentmeta); `pages` is there only when the document has pages, and `encoding`
and `replacedCharacters` only for a text file that was not valid UTF-8 (new in 0.6.0): a UI can say
"read as windows-1255", or that some characters could not be read. A client that checks the
answer against a fixed list of fields must allow the two. It leaves out `owner`, `textBytes`,
`jsonBytes`, `characters`, `wrappedLines`, `originalKept`, `outline`, `logProfile` and
`createdAt`.

Guide: [web app](../guides/web-app.md).

### `DocumentFormat`

```ts
type DocumentFormat = "text" | "markdown" | "log" | "json" | "csv" | "pdf" | "docx" | "pptx" | "xlsx" | "html";
```

The format of a document. It picks the extractor and decides whether a document gets an outline (not
`log`, `json` or `csv`) and a log profile (`log` only). See [`detectFormat`](#detectformatname-mimetype-bytes),
and for what each extractor writes, [`defaultExtractors`](#defaultextractors).

`"xlsx"` (Excel workbooks) and `"html"` (web pages) are new in 0.8.0: an exhaustive `switch` on a
document's format, or a `Record<DocumentFormat, …>` of your own, needs the two cases.

### `OutlineEntry`

```ts
type OutlineEntry = { line: number; level: number; title: string };
```

One heading of a document's outline. The headings are found in the text: Markdown headings (the
slides of a PPTX are `## Slide N`), lines that start with "Chapter", "Part", "Book", "Section" or
"Appendix" (or the Hebrew words for chapter, part and appendix), numbered headings such as `2.1 Results`, and short lines in capitals; all but the
Markdown ones only after a blank line. When there are more than 400, the outline keeps only the
top-level headings (of the shallowest level found) when there are at least 20 of them, and all the
headings otherwise. With 20 to 400 top-level headings, each one is kept once, in order. Otherwise
(more than 400 top-level headings, or fewer than 20) the outline has 400 entries, in order, taken
at even steps across the document from the top-level headings or from all of them.

| Field | Type | What it holds |
|---|---|---|
| `line` | `number` | The line of the heading in the extracted text, from 1. |
| `level` | `number` | Its level: 1 is the top. |
| `title` | `string` | The heading. |

### `LogIssue`

```ts
type LogIssue = { template: string; level: string; count: number; firstLine: number };
```

One frequent message shape of a log, at level `FATAL`, `ERROR` or `WARN`.

| Field | Type | What it holds |
|---|---|---|
| `template` | `string` | The message with timestamps removed, and IDs, IP addresses, hexadecimal numbers, quoted values and numbers replaced by `<id>`, `<ip>`, `<hex>`, `<s>` and `<n>`. At most 180 characters. |
| `level` | `string` | `"FATAL"`, `"ERROR"` or `"WARN"`. |
| `count` | `number` | How many lines have this shape. |
| `firstLine` | `number` | The line of the first of them, from 1. |

### `LogProfile`

```ts
type LogProfile = { levels: Record<string, number>; firstTimestamp?: string; lastTimestamp?: string; topIssues: LogIssue[] };
```

What a log contains, found at ingest. It is on every card of a log and in the overview tool.

| Field | Type | What it holds |
|---|---|---|
| `levels` | `Record<string, number>` | Lines per level: `FATAL`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE`. `ERR` counts as `ERROR`, `WARNING` as `WARN`, `CRITICAL` as `FATAL`. |
| `firstTimestamp` | `string \| undefined` | The first date and time (`2026-11-19 08:00:01` or ISO 8601) in the log, as written. |
| `lastTimestamp` | `string \| undefined` | The last one. |
| `topIssues` | [`LogIssue[]`](#logissue) | Up to 15 message shapes: `FATAL` first, then `ERROR`, then `WARN`, and the most frequent first within each level. |

## Progress of whole-document reads

### `ProgressEvent`

```ts
type ProgressEvent = { kind: "map" | "reduce"; message: string; done: number; total: number };
```

One step of a whole-document read (`analyze_whole_document`), for a status display.

| Field | Type | What it holds |
|---|---|---|
| `kind` | `"map" \| "reduce"` | `"map"`: a part of the file was read. `"reduce"`: notes were combined, or the answer is being written. |
| `message` | `string` | A line to show: `Reading app.log: part 3 of 12`, `Combining notes on app.log (round 1): 2 of 4`, `Writing the answer from 9 relevant parts of app.log`. |
| `done` | `number` | The steps of this kind done so far (0 for the step that writes the answer). |
| `total` | `number` | The steps of this kind (1 for the step that writes the answer). |

It is not one of the events of `onEvent` ([events](./events.md)). In `askWithFiles`, each
`ProgressEvent` of a whole-file read is also a `tool.progress` event, with the `callId` of its call
and the same `done`, `total` and `message`, and `kind` as `stage`.

### `ProgressListener`

```ts
type ProgressListener = (event: ProgressEvent) => void;
```

The type of `ToolOptions.onProgress` and of `ToolCallHooks.onProgress`.
[`askWithFiles`](./ask.md#askwithfilesoptions) passes each event's message, followed by "…", to its
own `onActivity` instead.

### `ToolCallHooks`

```ts
type ToolCallHooks = {
  onProgress?: ProgressListener;
  onRequest?: (request: ToolRequestStart) => ToolRequestHandle;
};
```

New in 0.7.0. Listeners for one tool call: the fourth argument of
[`executeWithFiles`](./tools.md#toolset), next to its limits. With them, the progress and the model
requests of two whole-file reads that run at once can be told apart. Only `analyze_whole_document`
calls them; the other tools ignore them. `askWithFiles` passes its own for each call, and turns
them into `tool.progress`, `request.start`, `retry` and `request.end` events
([events in your own loop](./events.md#toolcallhooks)).

| Field | Type | What it does |
|---|---|---|
| `onProgress` | [`ProgressListener`](#progresslistener), optional | Progress of this call, in place of `ToolOptions.onProgress` for it. Without it, the tool set's own listener is called. |
| `onRequest` | `(request: ToolRequestStart) => ToolRequestHandle`, optional | Called as each model request of this call starts ([`ToolRequestStart`](#toolrequeststart)). Return a [`ToolRequestHandle`](#toolrequesthandle): the read tells it of each retry of that request, and once when the request ends. |

Do not let them throw. The read takes a throw from `onRequest` or from a handle for a failure of
that request: the part is reported as not read, and a merge or the answer falls back to the notes.
A throw from `onProgress` ends the read, and `executeWithFiles` returns it as the tool's
`{ error }`. To end your question on an error of your listener, as `askWithFiles` does, catch it in
the listener, keep it, and abort the tool set's `signal`.

```ts
import type { LargeFiles, ToolCall, ToolCallHooks } from "llm-large-files";

// files is your createLargeFiles(); prepared comes from files.prepare(); generate is your GenerateText.
declare const files: LargeFiles;
declare const prepared: Awaited<ReturnType<LargeFiles["prepare"]>>;
declare const generate: NonNullable<Parameters<LargeFiles["tools"]>[1]>["generate"];

const tools = files.tools(prepared.plan.searchable, { ...(generate ? { generate } : {}) });

// Each call reports apart: "call 2: Reading app.log: part 3 of 12".
async function run(call: ToolCall, index: number) {
  const hooks: ToolCallHooks = {
    onProgress: (event) => console.log(`call ${index}: ${event.message}`),
    onRequest: (start) => {
      const began = Date.now();
      return {
        retry: ({ attempt, delayMs }) => console.log(`call ${index}: ${start.detail}, retry ${attempt} in ${delayMs} ms`),
        end: ({ outcome, usage }) => console.log(`call ${index}: ${start.detail} ${outcome} in ${Date.now() - began} ms`, usage),
      };
    },
  };
  return tools.executeWithFiles(call.name, call.args, {}, hooks);
}
```

### `ToolRequestHandle`

```ts
type ToolRequestHandle = {
  retry(notice: { attempt: number; delayMs: number; error: unknown }): void;
  end(end: ToolRequestEnd): void;
};
```

New in 0.7.0. One model request of a tool call, as `ToolCallHooks.onRequest` returns it.

| Member | What it is told |
|---|---|
| `retry(notice)` | The request failed and is sent again after `delayMs`, as a [`RetryNotice`](./errors-and-retries.md#retrynotice): `attempt` is 1 for the first retry, and `error` is the error as it was thrown. The retry of an error without a status, which has no wait, is not told. |
| `end(end)` | The request ended, after any retries ([`ToolRequestEnd`](#toolrequestend)). Called once. |

### `ToolRequestStart`

```ts
type ToolRequestStart = { purpose: "part" | "merge" | "final"; detail: string };
```

New in 0.7.0. A model request of a whole-file read, as it starts.

| Field | Type | What it holds |
|---|---|---|
| `purpose` | `"part" \| "merge" \| "final"` | `"part"`: a part of the file is read. `"merge"`: notes are combined. `"final"`: the answer of the read is written. |
| `detail` | `string` | Which one: `"part 3 of 12"`, `"first half of part 3 of 12"` (a part read again in halves), `"round 2: 1 of 4"`, `"the answer"`. |

### `ToolRequestEnd`

```ts
type ToolRequestEnd = { outcome: "ok" | "error"; usage?: GenerateUsage; error?: unknown };
```

New in 0.7.0. A model request of a tool call, as it ends.

| Field | Type | What it holds |
|---|---|---|
| `outcome` | `"ok" \| "error"` | `"error"` when the request failed in the end. A part that failed does not end the read: it is reported to the model. |
| `usage` | [`GenerateUsage`](./ask.md#generateusage), optional | The tokens of the request, summed over what its part reader passed to `onUsage`. Absent when it passed nothing. |
| `error` | `unknown`, optional | With `"error"`: the error as it was thrown. It can hold the provider's own words: keep it for your logs. |

Guide: [web app](../guides/web-app.md).
