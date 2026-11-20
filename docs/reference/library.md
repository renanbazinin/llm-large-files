# `llm-large-files`: the library and its documents

This is the reference for the part of the main entry point that ingests, stores and plans
documents: `createLargeFiles` and the `LargeFiles` object it returns, the budget, the stores, the
extractors, and the types that describe a document. It is for developers who wire the library into
an application or write a store, an extractor or a loop of their own.

```ts
import {
  createLargeFiles, DEFAULT_CACHE_BYTES, DEFAULT_WHOLE_DOCUMENT_BYTES, NEVER_EXPIRES, isDocumentId, toDocumentSummary,
  DEFAULT_BUDGET, resolveBudget,
  MemoryDocumentStore, FileDocumentStore, DOCUMENT_ID_PATTERN, DocumentStoreError,
  createPdfExtractor, defaultExtractors, detectFormat,
  estimateTokens, utf8Bytes, jsonBytes,
} from "llm-large-files";
import type {
  LargeFilesOptions, LargeFiles, AccessOptions, IngestInput, PrepareOptions, ToolOptions, PreparedContext, DocumentPlan,
  Budget, ModelLimits, DocumentStore, StoredDocument, PdfExtractorOptions, Extractor, ExtractInput, ExtractedText,
  DocumentMeta, DocumentSummary, DocumentFormat, OutlineEntry, LogIssue, LogProfile, ProgressEvent, ProgressListener,
} from "llm-large-files";
```

The signature blocks below assume these imports, and `ToolSet`, `GenerateText` and `RetryOptions`
from the same entry point.

Contents:

- [The library](#the-library): [`createLargeFiles(options)`](#createlargefilesoptions),
  [`LargeFilesOptions`](#largefilesoptions), [`LargeFiles`](#largefiles), [`IngestInput`](#ingestinput),
  [`AccessOptions`](#accessoptions), [`PrepareOptions`](#prepareoptions), [`ToolOptions`](#tooloptions),
  [`PreparedContext`](#preparedcontext), [`DocumentPlan`](#documentplan),
  [`DEFAULT_CACHE_BYTES`](#default_cache_bytes), [`DEFAULT_WHOLE_DOCUMENT_BYTES`](#default_whole_document_bytes),
  [`NEVER_EXPIRES`](#never_expires), [`isDocumentId(value)`](#isdocumentidvalue),
  [`toDocumentSummary(meta)`](#todocumentsummarymeta)
- [The budget](#the-budget): [`Budget`](#budget), [`DEFAULT_BUDGET`](#default_budget),
  [`resolveBudget(budget?, limits?)`](#resolvebudgetbudget-limits), [`ModelLimits`](#modellimits)
- [Stores](#stores): [`DocumentStore`](#documentstore), [`StoredDocument`](#storeddocument),
  [`MemoryDocumentStore`](#memorydocumentstore), [`FileDocumentStore`](#filedocumentstore),
  [`DOCUMENT_ID_PATTERN`](#document_id_pattern), [`DocumentStoreError`](#documentstoreerror)
- [Extraction](#extraction): [`Extractor`](#extractor), [`ExtractInput`](#extractinput),
  [`ExtractedText`](#extractedtext), [`defaultExtractors`](#defaultextractors),
  [`createPdfExtractor(options?)`](#createpdfextractoroptions), [`PdfExtractorOptions`](#pdfextractoroptions),
  [`detectFormat(name, mimeType)`](#detectformatname-mimetype)
- [Text sizes](#text-sizes): [`estimateTokens(text)`](#estimatetokenstext), [`utf8Bytes(text)`](#utf8bytestext),
  [`jsonBytes(text)`](#jsonbytestext)
- [Document types](#document-types): [`DocumentMeta`](#documentmeta), [`DocumentSummary`](#documentsummary),
  [`DocumentFormat`](#documentformat), [`OutlineEntry`](#outlineentry), [`LogIssue`](#logissue),
  [`LogProfile`](#logprofile)
- [Progress of whole-document reads](#progress-of-whole-document-reads): [`ProgressEvent`](#progressevent),
  [`ProgressListener`](#progresslistener)

The same entry point also exports the tool loop and the adapter contract ([ask.md](./ask.md)),
errors, retries and streams ([errors-and-retries.md](./errors-and-retries.md)), and the tools the
model sees ([tools.md](./tools.md)).

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
  extractors?: Partial<Record<DocumentFormat, Extractor>>;
  keepOriginals?: DocumentFormat[];
  scannedPdfPages?: number;
  cacheBytes?: number;
  cacheSize?: number;
  wholeDocumentBytes?: number;
  scanChunkBytes?: number;
  maxConcurrentScans?: number;
  now?: () => Date;
};
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `store` | [`DocumentStore`](#documentstore) | required | Where the text, the metadata, kept originals and line indexes live: `new FileDocumentStore(dir)`, `new MemoryDocumentStore()`, or your own. |
| `budget` | `Partial<Budget>` | [`DEFAULT_BUDGET`](#default_budget) | The limits of your model connection. Fields you leave out follow `contextTokens` (see [`Budget`](#budget)): for a model with a smaller window, setting `contextTokens` is enough. |
| `ttlMs` | `number` | 72 hours (259,200,000) | How long a document is kept after it is ingested. `expiresAt` is set at ingest, and the library never extends it. `Infinity`, or any time that would end at or after the end of year 9999, keeps documents until they are deleted: `expiresAt` is then [`NEVER_EXPIRES`](#never_expires). |
| `maxUploadBytes` | `number` | 100 MB (104,857,600) | The largest file `ingest` accepts. The upload handler of [`llm-large-files/node`](./node.md) reads no more than this. |
| `extractors` | `Partial<Record<DocumentFormat, Extractor>>` | the built-ins, [`defaultExtractors`](#defaultextractors) | An [`Extractor`](#extractor) per format, used in place of the built-in one. The formats are fixed ([`DocumentFormat`](#documentformat)): you can replace the extractor of a format, not add a format. |
| `keepOriginals` | `DocumentFormat[]` | `[]` | Formats whose uploaded file is kept in the store next to its text, for example `["pdf"]`, which `view_pages` needs. Takes effect only with a store that has `putOriginal`. A kept file takes as much space as the upload until its document expires or is deleted. |
| `scannedPdfPages` | `number` | 30 | The most pages a PDF without any text (a scan) may have and still be accepted, so that its pages can be shown to the model. It applies only when `"pdf"` is in `keepOriginals` and the store has `putOriginal`. Otherwise, and with 0, such a PDF is refused. Your own PDF extractor receives it as `ExtractInput.scannedPages`. |
| `cacheBytes` | `number` | [`DEFAULT_CACHE_BYTES`](#default_cache_bytes), 256 MB | The most memory that documents kept ready between tool calls may take, together with the decoded pieces of documents read by range. The least recently used go first. A document that would take more than this is not kept and is read again for each call. A document whose decoded text would take more than a quarter of it keeps no pieces. 0 keeps nothing. Each use of a kept document asks the store first, so a document deleted or expired on another server is never served from memory. |
| `cacheSize` | `number` | no limit | Also caps the number of documents kept. The pieces of a document read by range are not counted, and leave with their document. 0 keeps nothing. |
| `wholeDocumentBytes` | `number` | [`DEFAULT_WHOLE_DOCUMENT_BYTES`](#default_whole_document_bytes), 2 MB | Documents whose text (`textBytes`) is at most this size are loaded whole into memory. Larger ones are read by range when the store has `readTextRange`, as `FileDocumentStore` does: a tool call reads only the lines it needs, and a search reads the text a piece at a time. `Infinity` loads every document whole; 0 reads every one by range. |
| `scanChunkBytes` | `number` | 1 MB (1,048,576) | Reading by range: about how many bytes of text are read and searched at a time. At least 1. |
| `maxConcurrentScans` | `number` | 4 | Reading by range: how many scans of whole documents (searches, counting the parts of a file) run at once in this library (each `createLargeFiles` call has its own queue). The others wait their turn. At least 1. |
| `now` | `() => Date` | `() => new Date()` | The clock, for tests. It dates `createdAt` and `expiresAt`, decides whether a document has expired, and is passed to the store's `sweep`. |

Guides: [storage](../guides/storage.md) for the store, owners and retention,
[costs and limits](../guides/costs-and-limits.md) for the budget, [PDFs](../guides/pdfs.md) for
`keepOriginals`, `scannedPdfPages` and `extractors`, and [deployment](../guides/deployment.md) for
the memory settings.

### `LargeFiles`

```ts
interface LargeFiles {
  readonly budget: Budget;
  budgetFor(overrides?: Partial<Budget>, limits?: ModelLimits): Budget;
  readonly maxUploadBytes: number;
  ingest(input: IngestInput): Promise<DocumentMeta>;
  getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined>;
  getOriginal(id: string, access?: AccessOptions): Promise<Uint8Array | undefined>;
  delete(id: string, access?: AccessOptions): Promise<boolean>;
  sweep(): Promise<number>;
  prepare(ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext>;
  tools(documents: DocumentMeta[], options?: ToolOptions): ToolSet;
}
```

The object `createLargeFiles` returns. Below, its members are shown on a `LargeFiles` named `files`.

The members that read the store (`getMeta`, `getOriginal`, `delete` and `prepare`) throw
[`DocumentStoreError`](#documentstoreerror) when the store cannot be read: retry, the document is
not gone. A tool call that meets it answers the model with its message instead. What the store
throws while writing (in `ingest`, the removal in `delete`, `sweep`) is passed on unchanged: log it,
and do not show it to a user, since its message may name a path or a host.

#### `files.ingest(input)`

`ingest(input: IngestInput): Promise<DocumentMeta>`

Extracts the text of a file, normalizes it, profiles it, and stores it under a new ID. Returns the
new document's [`DocumentMeta`](#documentmeta).

1. The name is cleaned (see [`IngestInput`](#ingestinput)), and the format is picked by
   [`detectFormat(name, mimeType)`](#detectformatname-mimetype).
2. The extractor of that format turns the bytes into text.
3. The text is normalized: a byte-order mark is removed, line endings become `\n`, and terminal
   escape sequences and control characters other than tab and newline are removed. Lines longer
   than 2,000 characters are split, so every line can be read by number (`wrappedLines` counts them).
4. A `text` document becomes a `log`, and gets a `logProfile`, when it has at least 5 non-blank
   lines and at least 40% of its first 200 non-blank lines start with a timestamp or a log level
   (`ERROR`, `WARN`, `INFO`...).
5. The store is written: the original file (when it is kept), then the line index (when the store
   has `putIndex`), then `put` last.

| It throws | When |
|---|---|
| `Error("<name> is empty.")` | The file has no bytes. |
| `Error("<name> is larger than the 100 MB upload limit.")` | The file is larger than `maxUploadBytes`. The message gives your limit. |
| The extractor's `Error` | The extractor refused the file: a binary or compressed file, a PDF without text, a missing optional dependency, a possible zip bomb. The built-in messages, listed under [`defaultExtractors`](#defaultextractors), are written for a user. |
| `Error("<name> did not contain any text.")` | The extracted text is blank. |
| The store's own error | A write failed. `ingest` first calls `store.delete(id)` to remove what was written (an error of that call is ignored), then throws the store's error unchanged. It is not a `DocumentStoreError`. |

The errors of the file and the store's error are all plain `Error`s, with no class to tell them
apart. The upload handler of [`llm-large-files/node`](./node.md) takes an error that carries an
HTTP `status` or `statusCode` (400 to 599), or a Node system error (`code` and `syscall`), for the
store's: it answers with that status, or with 500 and the code. It answers any other error with 422
and its message. A store that throws other errors needs a rule of your own. See
[errors and reliability](../guides/errors-and-reliability.md).

Guides: [web app](../guides/web-app.md) for uploads, [PDFs](../guides/pdfs.md) for what PDF
extraction writes.

#### `files.getMeta(id, access?)`

`getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined>`

The document's metadata, or `undefined` when the ID does not match
[`DOCUMENT_ID_PATTERN`](#document_id_pattern), the document was never there, was deleted, has
expired (the library compares `expiresAt` with its clock itself, whatever the store returns), or
belongs to another owner ([`AccessOptions`](#accessoptions)). Throws `DocumentStoreError` when the
store cannot be read.

#### `files.getOriginal(id, access?)`

`getOriginal(id: string, access?: AccessOptions): Promise<Uint8Array | undefined>`

The uploaded file, when it was kept (`keepOriginals`). `undefined` in every case where `getMeta`
gives `undefined`, and when the document has no `originalKept`, the store has no `getOriginal`, or
the store returns none. Treat the bytes as read-only: `MemoryDocumentStore` returns the very bytes
it keeps, not a copy, so changing them changes the stored file.
Throws `DocumentStoreError` when the store cannot be read.

#### `files.delete(id, access?)`

`delete(id: string, access?: AccessOptions): Promise<boolean>`

Removes a document, with its original and its index. It looks the document up as `getMeta` does,
and returns `false` when it is not there for this caller: another owner's document is never
deleted. Otherwise it drops what this process keeps of the document in memory and returns what
`store.delete(id)` returns. Throws `DocumentStoreError` when the look-up cannot read the store; an
error of `store.delete` itself is passed on unchanged.

#### `files.sweep()`

`sweep(): Promise<number>`

Calls the store's `sweep` with the library's clock and returns how many expired documents it
removed: 0 when the store has no `sweep`. Errors of the store are passed on unchanged. The library
never sweeps on its own: run it on a schedule, from one place (see [deployment](../guides/deployment.md)).

#### `files.prepare(ids, base, options?)`

`prepare(ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext>`

Plans one model request: which documents go into the prompt whole, and which become cards that the
model reads through the tools.

| Argument | Type | What it is |
|---|---|---|
| `ids` | `string[]` | The document IDs of the request. A repeated ID counts once. |
| `base` | `{ tokens: number; bytes: number }` | The size of everything else in the request: messages, system prompt, other files. `estimateTokens` and `jsonBytes` measure text the way the plan does. |
| `options` | [`PrepareOptions`](#prepareoptions) | The owner, a budget for this request, and whether your loop can show pages. |

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

It does not check owners. Pass documents that you got from `prepare` or `getMeta` with the
caller's owner.

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
type IngestInput = { name: string; mimeType?: string; bytes: Uint8Array; owner?: string };
```

The argument of [`files.ingest`](#filesingestinput).

| Field | Type | Default | What it does |
|---|---|---|---|
| `name` | `string` | required | The file name. It is cleaned to one printable line: the last segment of a path, with control characters, line breaks and text-direction controls replaced by spaces, runs of spaces made one, trimmed, and cut to 255 characters (`"file"` when nothing is left). With the MIME type it picks the format. |
| `mimeType` | `string` | `"application/octet-stream"` | The MIME type, trimmed. Blank counts as absent. Used when the extension names no format. |
| `bytes` | `Uint8Array` | required | The file. A Node `Buffer` is one. Empty, or larger than `maxUploadBytes`, is refused. |
| `owner` | `string` | none | The user or tenant the document belongs to. Every later call must pass the same owner. Without one, anyone who has the ID can use the document. |

Guide: [web app](../guides/web-app.md).

### `AccessOptions`

```ts
type AccessOptions = { owner?: string };
```

Who is asking. `getMeta`, `getOriginal`, `delete` and `prepare` (through
[`PrepareOptions`](#prepareoptions)) take it, and so does `askWithFiles`.

| Field | Type | Default | What it does |
|---|---|---|---|
| `owner` | `string` | none | Compared with the document's `owner` with `===`. A document that has an owner can be used only with that exact owner. A document without one can be used by anyone. Another owner's document looks exactly like a missing one. |

The library has no notion of a session and cannot list documents by owner: record the IDs in your
own data. See [storage](../guides/storage.md) and [security](../security.md).

### `PrepareOptions`

```ts
type PrepareOptions = AccessOptions & { budget?: Partial<Budget>; viewPages?: boolean };
```

The options of [`files.prepare`](#filesprepareids-base-options).

| Option | Type | Default | What it does |
|---|---|---|---|
| `owner` | `string` | none | As in [`AccessOptions`](#accessoptions). Another owner's documents are listed in `missing` and are not read. |
| `budget` | `Partial<Budget>` | the library's | The budget fields to change for this request, as in `LargeFilesOptions.budget`. `askWithFiles` passes the budget fitted to its model. |
| `viewPages` | `boolean` | `false` | Says that your loop can pass files to the model. `viewable` then lists the PDFs whose original is kept (with a store that has `getOriginal`), and the instruction and the cards tell the model about `view_pages`. Without it, `viewable` is empty and nothing mentions `view_pages`. |

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

### `ToolOptions`

```ts
type ToolOptions = {
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
| `generate` | [`GenerateText`](./ask.md#generatetext) | none | A plain text completion. It enables `analyze_whole_document`, which reads a whole file in parts. The tool is declared only when at least one of the documents is small enough: about `maxMapChunks` parts or fewer. |
| `onProgress` | [`ProgressListener`](#progresslistener) | none | Progress of whole-document reads, for status messages. |
| `signal` | `AbortSignal` | none | Stops searches and whole-document reads. Once it has aborted, a call that fails throws instead of answering `{ error }`. |
| `regexBudgetMs` | `number` | [`REGEX_BUDGET_MS`](./tools.md#regex_budget_ms), 6,000 | The most time, in milliseconds, that the regex searches of this tool set may take together. Past it, a regex search answers with an error that tells the model to search another way. One search stops after 3,000 ms on its own. |
| `maxWholeDocumentReads` | `number` | [`MAX_WHOLE_DOCUMENT_READS`](./tools.md#max_whole_document_reads), 1 | How many times each document may be read whole by this tool set. A call past it answers with an error that tells the model to use what it has. 0 turns whole reads off. |
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
| `blocks` | `Map<string, string>` | The prompt text of each document, by ID. For a document sent whole, its text between `--- Attached file: <name> (<format>, <lines> lines) ---` and `--- End attached file: <name> ---`. For a searchable one, a card: its `document_id`, size, log profile, outline (up to 40 headings) and first 25 lines. |
| `instruction` | `string` | The guide to the tools, for the system prompt, when a document is searchable or viewable; `""` otherwise. It names `analyze_whole_document` when a searchable file is small enough for it: give `generate` to `tools`, or a call of it is answered as an unknown tool. |
| `missing` | `string[]` | The IDs that were not found: never uploaded, not a document ID, deleted, expired, or another owner's. |
| `viewable` | `DocumentMeta[]` | The PDFs whose pages `view_pages` can show, whether their text is in the prompt or searched. Empty unless `prepare` was called with `viewPages: true`. Pass it to `tools(..., { viewPages })`. |

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

`true` for a string that matches [`DOCUMENT_ID_PATTERN`](#document_id_pattern). Use it to check IDs
that come from a browser. The library's own methods already treat any other string as a missing
document.

### toDocumentSummary(meta)

```ts
declare function toDocumentSummary(meta: DocumentMeta): DocumentSummary;
```

The fields of a document that are safe to send to a browser (see
[`DocumentSummary`](#documentsummary)). `pages` is included only when the document has pages. The
handlers of [`llm-large-files/node`](./node.md) answer with it.

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
  put(document: StoredDocument): Promise<void>;
  get(id: string): Promise<StoredDocument | undefined>;
  getMeta(id: string): Promise<DocumentMeta | undefined>;
  delete(id: string): Promise<boolean>;
  sweep?(now?: Date): Promise<number>;
  putOriginal?(id: string, bytes: Uint8Array): Promise<void>;
  getOriginal?(id: string): Promise<Uint8Array | undefined>;
  readTextRange?(id: string, start: number, end: number): Promise<Uint8Array | undefined>;
  putIndex?(id: string, index: Uint8Array): Promise<void>;
  getIndex?(id: string): Promise<Uint8Array | undefined>;
}
```

Where the extracted text lives, with its metadata, and optionally the uploaded file and a line
index. Use [`MemoryDocumentStore`](#memorydocumentstore) or [`FileDocumentStore`](#filedocumentstore),
or implement it over a database, Redis or S3.

| Method | Required | What it must do, and when the library calls it |
|---|---|---|
| `put(document)` | yes | Store the text and the metadata. Called last at ingest. A document should exist once its metadata does: `FileDocumentStore` writes the metadata last. |
| `get(id)` | yes | The whole document, or `undefined` when there is no such document. It may return an expired one: the library checks `expiresAt` itself. Called to load a document whole: its text is at most `wholeDocumentBytes`, or the store has no `readTextRange`. |
| `getMeta(id)` | yes | The metadata, or `undefined` when there is no such document (an expired one may be returned; the library checks `expiresAt`). Called by every `prepare`, `getMeta`, `getOriginal` and `delete`, and by every tool call: keep it cheap, apart from the text. |
| `delete(id)` | yes | Remove the document, its original and its index, and return whether it existed. Also called by `ingest` after a failed write, so it must cope with a document that was written only in part. |
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
- What `put`, `putOriginal` and `putIndex` throw at ingest is thrown by `ingest` unchanged, after it
  calls `delete(id)`. What `delete` and `sweep` throw is passed on unchanged.
- The library compares `expiresAt` with its clock itself, so an expired document is never used. The
  store must still remove it, in `sweep` or by its own expiry.

The library makes the IDs (see [`DOCUMENT_ID_PATTERN`](#document_id_pattern)), and every method
except `put` receives only the ID: no owner, no metadata. A store that lays documents out per user
or per chat session needs its own way from an ID to a place.

Guide: [storage](../guides/storage.md), which also shows a store of your own.

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
  put(document: StoredDocument): Promise<void>;
  get(id: string): Promise<StoredDocument | undefined>;
  getMeta(id: string): Promise<DocumentMeta | undefined>;
  delete(id: string): Promise<boolean>;
  sweep(now?: Date): Promise<number>;
  putOriginal(id: string, bytes: Uint8Array): Promise<void>;
  getOriginal(id: string): Promise<Uint8Array | undefined>;
}
```

Keeps documents, and kept originals, in the memory of the process: for tests, scripts and
one-process demos. They are lost on restart and not shared between processes. It has no
`readTextRange`, so every document is loaded whole, whatever `wholeDocumentBytes` says. `get` and
`getMeta` remove an expired document and return `undefined`. `putOriginal` keeps a copy of the
bytes, so the caller may reuse its buffer.

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
(a random UUID without its dashes). [`isDocumentId`](#isdocumentidvalue) tests a value against it.

### `DocumentStoreError`

```ts
declare class DocumentStoreError extends Error {
  readonly code?: string;
  readonly syscall?: string;
  constructor(cause: unknown);
}
```

The store could not be read just now: a volume that did not answer, too many open files, a database
that is down. It does not mean that the document is gone, and the same call may work a moment
later: retry it, rather than ask the user to upload the file again.

| Field | Type | What it holds |
|---|---|---|
| `name` | `string` | `"DocumentStoreError"`. |
| `message` | `string` | `The document store could not be read (<code>). Try again.`, or without the code when there is none. It names no path and no host: it is safe to show to a user or a model. |
| `code` | `string \| undefined` | The code of the system error behind it (`EIO`, `EMFILE`, `ETIMEDOUT`), when there is one. |
| `syscall` | `string \| undefined` | The system call that failed (`open`, `read`), when there is one. |
| `cause` | `unknown` | What the store threw. Log it on the server; it may name a path or a host. |

`files.getMeta`, `files.getOriginal`, `files.delete` (its look-up) and `files.prepare` throw it,
and so does `askWithFiles`. A tool call that meets it answers the model with its message instead of
throwing. Errors of writes are never wrapped in it (see [`DocumentStore`](#documentstore)).

```ts
import { DocumentStoreError, toDocumentSummary, type LargeFiles } from "llm-large-files";

// `files` is your library.
async function documentSummary(files: LargeFiles, id: string, owner: string) {
  try {
    const meta = await files.getMeta(id, { owner });
    return meta ? { status: 200, body: toDocumentSummary(meta) } : { status: 404, body: { error: "Not found." } };
  } catch (error) {
    if (!(error instanceof DocumentStoreError)) throw error;
    console.error(error.cause); // what the store threw: for your log only
    return { status: 503, body: { error: error.message } };
  }
}
```

Guide: [errors and reliability](../guides/errors-and-reliability.md).

## Extraction

### `Extractor`

```ts
type Extractor = (bytes: Uint8Array, input: ExtractInput) => Promise<ExtractedText>;
```

Turns the bytes of an uploaded file into text, for one format. To refuse a file, throw an `Error`
whose message a user can read: `ingest` passes it on unchanged. The library then normalizes the
text, splits long lines and refuses blank text, as described under
[`files.ingest`](#filesingestinput). For a PDF, write a line `--- Page N ---` before the text of
each page, counting from 1, as the built-in one does: the page numbers in tool results and
`view_pages` are read from those lines.

```ts
import { createLargeFiles, defaultExtractors, MemoryDocumentStore, type Extractor } from "llm-large-files";

// An .html file is detected as "text". This extractor drops its tags before the text is stored.
const text: Extractor = async (bytes, input) => {
  const extracted = await defaultExtractors.text(bytes, input);
  if (!input.name.toLowerCase().endsWith(".html")) return extracted;
  return { text: extracted.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ") };
};

const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text } });
```

Guide: [PDFs](../guides/pdfs.md), for OCR and other PDF extractors.

### `ExtractInput`

```ts
type ExtractInput = { name: string; mimeType: string; format: DocumentFormat; scannedPages?: number };
```

| Field | Type | What it holds |
|---|---|---|
| `name` | `string` | The cleaned file name (see [`IngestInput`](#ingestinput)). |
| `mimeType` | `string` | The MIME type, `"application/octet-stream"` when none was given. |
| `format` | [`DocumentFormat`](#documentformat) | The format from `detectFormat`. A text file that turns out to be a log is still `"text"` here: logs are recognized after extraction. |
| `scannedPages` | `number \| undefined` | Set for a PDF when one without any text may be accepted: `"pdf"` is in `keepOriginals`, the store has `putOriginal`, and `scannedPdfPages` is above 0. It is the most pages such a PDF may have. Unset, a PDF without text is to be refused. An extractor of your own may ignore it. |

### `ExtractedText`

```ts
type ExtractedText = { text: string; pages?: number };
```

| Field | Type | What it holds |
|---|---|---|
| `text` | `string` | The text of the file. |
| `pages` | `number \| undefined` | The number of pages (or slides), stored as `DocumentMeta.pages`. |

### `defaultExtractors`

```ts
declare const defaultExtractors: Record<DocumentFormat, Extractor>;
```

The built-in extractor of each format, used for every format you do not replace in
`LargeFilesOptions.extractors`. Call one from an extractor of your own to wrap it.

| Format | What the extractor does |
|---|---|
| `text`, `markdown`, `log`, `json`, `csv` | Decodes the bytes as UTF-8, or as UTF-16 when they start with a byte-order mark or look like little-endian UTF-16 without one. Refuses gzip, ZIP and other binary files. |
| `pdf` | [`createPdfExtractor()`](#createpdfextractoroptions). Needs the optional dependency `unpdf`, and `@cantoo/pdf-lib` to mark pages with pictures. |
| `docx` | The paragraphs of the main document first, then those of its endnotes, footers, footnotes and headers (in the order of their part names), one line each, with a blank line between parts. A text box is read once. Needs the optional dependency `jszip`. |
| `pptx` | One `## Slide N` section per slide, in order, with `[No text on this slide]` for a slide without text. `pages` is the number of slides. Needs `jszip`. |

The messages they refuse a file with, which `ingest` throws:

- `This file looks binary, not text. Attach a text, log, PDF, DOCX, or PPTX file.`
- `This file is gzip-compressed. Decompress it, then attach the text file inside.`
- `This file is a ZIP archive. Extract it, then attach the text file you need.`
- `Reading PDF files needs the optional dependency "unpdf".`
- `This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.`
- `This PDF has no text layer (it may be scanned) and <n> pages. Without text it can only be read by looking at its pages, which works for up to <m> pages. It needs OCR first.`
- `Reading DOCX and PPTX files needs the optional dependency "jszip".`
- `This DOCX does not contain word/document.xml.` and `This PPTX does not contain any slides.`
- `This DOCX unpacks to more than <n> MB, over 100 times its size. A file that grows that much is not read: it may be a zip bomb. Save it as text or PDF, and attach that.` (past the first 16 MB; `PPTX` for a presentation)
- `This DOCX unpacks to more than 128 MB of XML, more than is read from one file. Save it as text or PDF, and attach that.`

A PDF or an Office file that is damaged fails with the error of pdf.js or JSZip.

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
type PdfExtractorOptions = { tables?: boolean; pictures?: boolean };
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `tables` | `boolean` | `true` | Rebuilds tables from the position of the text, and writes each row as `\| cell \| cell \|  \|`, so an empty cell stays an empty cell. `false` gives the text in pdf.js order, as in version 0.1.0. |
| `pictures` | `boolean` | `true` | Writes `[Picture on this page. This text cannot show it.]` under the page line of every page that shows a picture or a drawing, so the model knows that the text does not tell all of that page. Needs the optional dependency `@cantoo/pdf-lib`; without it, and with `false`, no page is marked. |

### detectFormat(name, mimeType)

```ts
declare function detectFormat(name: string, mimeType: string): DocumentFormat;
```

The format of a file: from the extension after the last dot (in any case), then from the MIME type,
else `"text"`. The MIME type is lowercased and compared whole, so `text/csv; charset=utf-8` names no
format. A name without a dot is looked up whole, so a file named `log` is a `log`. `ingest` uses it,
then turns a `"text"` document that reads like a log into `"log"`.

| Format | Extensions | MIME types |
|---|---|---|
| `log` | `.log`, `.out`, `.err` | none (also text recognized as a log at ingest) |
| `markdown` | `.md`, `.markdown` | `text/markdown` |
| `json` | `.json`, `.jsonl`, `.ndjson` | `application/json` |
| `csv` | `.csv`, `.tsv` | `text/csv` |
| `pdf` | `.pdf` | `application/pdf` |
| `docx` | `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `pptx` | `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `text` | any other | any other |

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
  owner?: string;
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
  originalKept?: boolean;
  outline: OutlineEntry[];
  logProfile?: LogProfile;
  createdAt: string;
  expiresAt: string;
};
```

The metadata of a stored document, made by `ingest`. It holds the owner and text from the file
(the outline, the log profile): send [`toDocumentSummary(meta)`](#todocumentsummarymeta) to a
browser instead.

| Field | Type | What it holds |
|---|---|---|
| `id` | `string` | `doc_` and 32 hexadecimal digits ([`DOCUMENT_ID_PATTERN`](#document_id_pattern)). |
| `owner` | `string \| undefined` | The owner given at ingest. Absent when none was given. |
| `name` | `string` | The cleaned file name. |
| `mimeType` | `string` | The MIME type given, trimmed, or `"application/octet-stream"`. |
| `format` | [`DocumentFormat`](#documentformat) | The format. |
| `bytes` | `number` | The size of the uploaded file. |
| `textBytes` | `number` | The size of the extracted text in UTF-8. |
| `jsonBytes` | `number \| undefined` | The bytes the text takes inside a JSON request body, with the escapes JSON adds. Absent on a document ingested before 0.4.1: planning then assumes `textBytes` × 1.08. |
| `characters` | `number` | The length of the text, in UTF-16 code units (a JavaScript string's `length`). |
| `lines` | `number` | The number of lines of the text. A final line break does not start another line. |
| `estimatedTokens` | `number` | [`estimateTokens`](#estimatetokenstext) of the text. |
| `wrappedLines` | `number` | How many lines longer than 2,000 characters were split into several, so that every line can be read by number. |
| `pages` | `number \| undefined` | The pages of a PDF, the slides of a PPTX, or what your extractor returned. |
| `originalKept` | `boolean \| undefined` | `true` when the uploaded file is kept in the store (`keepOriginals`). Absent otherwise. Documents ingested before you turned `keepOriginals` on have no original. |
| `outline` | [`OutlineEntry[]`](#outlineentry) | The headings found in the text, at most 400. Empty for `log`, `json` and `csv`. |
| `logProfile` | [`LogProfile`](#logprofile) or `undefined` | The log profile, for a `log` document only. |
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
  expiresAt: string;
};
```

A JSON-safe summary of a document for API responses and browser state, made by
[`toDocumentSummary`](#todocumentsummarymeta). Its fields mean what they mean in
[`DocumentMeta`](#documentmeta); `pages` is there only when the document has pages. It leaves out
`owner`, `textBytes`, `jsonBytes`, `characters`, `wrappedLines`, `originalKept`, `outline`,
`logProfile` and `createdAt`.

Guide: [web app](../guides/web-app.md).

### `DocumentFormat`

```ts
type DocumentFormat = "text" | "markdown" | "log" | "json" | "csv" | "pdf" | "docx" | "pptx";
```

The format of a document. It picks the extractor and decides whether a document gets an outline (not
`log`, `json` or `csv`) and a log profile (`log` only). See [`detectFormat`](#detectformatname-mimetype).

### `OutlineEntry`

```ts
type OutlineEntry = { line: number; level: number; title: string };
```

One heading of a document's outline. The headings are found in the text: Markdown headings (the
slides of a PPTX are `## Slide N`), lines that start with "Chapter", "Part", "Book", "Section" or
"Appendix" (or the Hebrew words for chapter, part and appendix), numbered headings such as `2.1 Results`, and short lines in capitals; all but the
Markdown ones only after a blank line. When there are more than 400, at most 400 are kept, taken at
even steps across the document; when at least 20 of them are top-level headings (of the shallowest
level found), only those are used. With 400 top-level headings or more, that gives 400 spread across
the document. With 20 to 399, version 0.6.0 gets the steps wrong: the outline holds as many entries
as there are top-level headings, but it takes them from the first ones only, some more than once
(with 100, the first 25, four times each; with 300, the first 225).

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

### `ProgressListener`

```ts
type ProgressListener = (event: ProgressEvent) => void;
```

The type of `ToolOptions.onProgress`. [`askWithFiles`](./ask.md#askwithfilesoptions) passes each
event's message, followed by "…", to its own `onActivity` instead.

Guide: [web app](../guides/web-app.md).
