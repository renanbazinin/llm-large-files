# API reference

Three entry points:

| Import | Contents |
|---|---|
| `llm-large-files` | Core: `createLargeFiles`, stores, types, helpers. Provider-neutral. |
| `llm-large-files/gemini` | `askGemini`, endpoints, Gemini adapters. |
| `llm-large-files/node` | `createDocumentHandlers` for Node HTTP servers. |

## `llm-large-files`

### `createLargeFiles(options): LargeFiles`

| Option | Type | Default |
|---|---|---|
| `store` | `DocumentStore` | required |
| `budget` | `Partial<Budget>` | see [configuration](configuration.md#budget) |
| `ttlMs` | `number` | 72 hours |
| `maxUploadBytes` | `number` | 100 MB |
| `extractors` | `Partial<Record<DocumentFormat, Extractor>>` | built-ins |
| `cacheBytes` | `number` | 256 MB: memory that documents kept ready between tool calls may take. Each use checks the store first. 0 keeps none |
| `cacheSize` | `number` | no limit: also caps the number of documents kept |
| `wholeDocumentBytes` | `number` | 2 MB: larger documents are read by range when the store can ([details](configuration.md#large-files-many-users-several-servers)). `Infinity` loads all whole |
| `scanChunkBytes` | `number` | 1 MB: text read and searched at a time, reading by range |
| `maxConcurrentScans` | `number` | 4: searches of a document read by range that run at once; the others wait |
| `keepOriginals` | `DocumentFormat[]` | `[]`: only text is kept. `["pdf"]` keeps uploaded PDFs, which `view_pages` needs ([details](configuration.md#keeping-the-uploaded-file)) |
| `scannedPdfPages` | `number` | 30: the longest PDF without any text that is accepted when its original is kept. 0 refuses them all |

### `LargeFiles`

| Member | Description |
|---|---|
| `ingest({ name, mimeType?, bytes, owner? })` | Extracts, normalizes, profiles, and stores a file. Returns `DocumentMeta`. Throws an `Error` with a user-readable message for empty, oversized, binary, or text-less files. |
| `getMeta(id, { owner }?)` | `DocumentMeta`, or `undefined` if unknown, expired, or owned by someone else. |
| `getOriginal(id, { owner }?)` | The uploaded file as a `Uint8Array`, when it was kept. `undefined` otherwise, and for another owner. |
| `delete(id, { owner }?)` | `true` if deleted. |
| `sweep()` | Removes expired documents; returns the count. |
| `prepare(ids, base, { owner?, viewPages? }?)` | Plans one request. `base` is `{ tokens, bytes }` for everything else in the request. Returns `PreparedContext`. `viewPages: true` says that your loop can pass files to the model. |
| `tools(documents, { generate?, onProgress?, signal?, viewPages? })` | A `ToolSet` scoped to these documents. `generate` enables `analyze_whole_document`. `viewPages` (`true`, or a list of documents such as `prepared.viewable`) enables `view_pages`. |
| `budget`, `maxUploadBytes` | The effective settings. |

### `PreparedContext`

```ts
{
  plan: { inline: DocumentMeta[]; searchable: DocumentMeta[]; inlineTokens: number; inlineBytes: number };
  blocks: Map<string, string>;  // per document ID: full text (inline) or a summary card (searchable)
  instruction: string;          // add to the system prompt; empty when there is nothing to search or to look at
  missing: string[];            // IDs not found (never uploaded, expired, or another owner's)
  viewable: DocumentMeta[];     // PDFs whose pages view_pages can show; empty without viewPages: true
}
```

### `ToolSet`

```ts
{
  declarations: ToolDeclaration[];        // { name, description, parameters: JSON Schema }
  has(name): boolean;
  execute(name, args): Promise<ToolResult>; // errors come back as { error } for the model to read
  executeWithFiles(name, args, { maxFileBytes?, maxPages? }?): Promise<{ result: ToolResult; files: ToolFile[] }>;
  describe(name, args): string;           // "Search app.log (exact) for “timeout”"
}
```

`executeWithFiles` runs any tool. Its `files` (`{ name, mimeType, bytes }`) are empty for all but
`view_pages`. `execute("view_pages", …)` returns an error, because it has no place for the file.

| Tool | Arguments | Returns |
|---|---|---|
| `search_document` | `document_id`, `query`, `mode`: `keywords` (default) \| `exact` \| `regex`, `max_results`, `context_lines`, `case_sensitive` | `keywords`: ranked passages with numbered lines. `exact`/`regex`: matching lines and `total_matching_lines`. |
| `read_document` | `document_id`, `start_line`, `end_line?` | Up to 600 numbered lines, and `next_start_line` if there's more |
| `get_document_overview` | `document_id` | Format, size, outline, log profile, first and last lines |
| `analyze_whole_document` | `document_id`, `task` | `answer` from a map-reduce read, plus part counts |
| `view_pages` | `document_id`, `from_page`, `to_page?` | Up to 5 pages of a PDF as one PDF file, with `pages` ("12-14"), `total_pages`, `file` (its name), and `next_page` when fewer pages were given than asked. Declared only with `viewPages`, for PDFs whose original is kept. |

For a PDF that `view_pages` can show, the results of `search_document` and `read_document` also
carry page numbers: `page` on each matching line, `pages` on a passage and on a range that was read.

### Stores

- `new MemoryDocumentStore({ now? })`: in-process, for tests and single-instance demos.
- `new FileDocumentStore(directory, { now?, orphanAgeMs? })`: `<id>.txt`, `<id>.json` and the line
  index `<id>.idx` per document, and `<id>.bin` for a kept original. Safe for several servers on one
  volume: files are written whole, large documents are read by range, and `sweep` leaves files
  younger than `orphanAgeMs` (1 hour) that belong to no document yet.
- Implement `DocumentStore` (`put`, `get`, `getMeta`, `delete`, `sweep?`, `putOriginal?` with
  `getOriginal?` to keep originals, and `readTextRange?` with `putIndex?` and `getIndex?` to read
  large documents by range) for anything else.

### Helpers

- `toDocumentSummary(meta)`: the browser-safe fields (`DocumentSummary`).
- `toolResultSummary(label, result)`: `" — 12 matching lines"`, for step lists.
- `isDocumentId(value)`, `DOCUMENT_ID_PATTERN`.
- `estimateTokens(text)`, `utf8Bytes(text)`, `jsonBytes(text)`.
- `detectFormat(name, mimeType)`, `defaultExtractors`, `TOOL_NAMES`, `DEFAULT_BUDGET`,
  `MAX_VIEW_PAGES` (5).
- `createPdfExtractor({ tables?: boolean, pictures?: boolean })`: the built-in PDF extractor with
  an option changed. `tables: false` gives the text in pdf.js order, without rebuilt tables
  (see [PDF tables](configuration.md#pdf-tables)). `pictures: false` leaves out the line that marks
  a page with a picture (see [Pictures in PDFs](configuration.md#pictures-in-pdfs)).

### Key types

```ts
type DocumentFormat = "text" | "markdown" | "log" | "json" | "csv" | "pdf" | "docx" | "pptx";

type DocumentMeta = {
  id: string; owner?: string; name: string; mimeType: string; format: DocumentFormat;
  bytes: number; textBytes: number; characters: number; lines: number; estimatedTokens: number;
  wrappedLines: number; pages?: number;
  originalKept?: boolean;   // the uploaded file is in the store next to the text
  outline: { line: number; level: number; title: string }[];
  logProfile?: { levels: Record<string, number>; firstTimestamp?: string; lastTimestamp?: string;
                 topIssues: { template: string; level: string; count: number; firstLine: number }[] };
  createdAt: string; expiresAt: string;
};

type GenerateText = (request: {
  system: string; prompt: string; maxOutputTokens: number; signal?: AbortSignal;
  onTruncated?: () => void; // call it when the model stopped at maxOutputTokens
}) => Promise<string>;
type Extractor = (bytes: Uint8Array, input: { name: string; mimeType: string; format: DocumentFormat; scannedPages?: number }) => Promise<{ text: string; pages?: number }>;
// scannedPages: set when a PDF without any text is welcome, with the most pages it may have.

type ToolFile = { name: string; mimeType: string; bytes: Uint8Array };
```

## `llm-large-files/gemini`

### `askGemini(options): Promise<AskGeminiResult>`

| Option | Description |
|---|---|
| `files`, `endpoint`, `documentIds` | Required. |
| `messages` | `{ role: "user" \| "model" \| "assistant", text }[]`; the last must be the user's. |
| `contents` | Instead of `messages`: raw Gemini `contents` (images, inline PDFs…). Not mutated. |
| `system` | System instruction; the tool guide is appended when needed. |
| `generationConfig` | Sent with every chat request. |
| `explorerGenerationConfig` | The same, for the requests of an [explorer model](configuration.md#an-explorer-model). Defaults to `generationConfig`. Not used without an explorer. |
| `owner` | Only documents with this owner (or no owner) are used. |
| `documentPlacement` | `"first"` (default): document text and cards go at the start of the first user turn and stay there, so follow-up questions reuse Gemini's prompt cache. `"last"`: appended to the latest user turn, as in 0.1.0. |
| `maxToolTurns` | Default 12. The most requests for one question, counting the answer. If the model is still calling tools on the last one, it is sent with no tools so the model must answer. With an explorer model the answer is always the last request, so the explorer has one less. |
| `wholeDocumentAnalysis` | Default `true`. Set `false` to withhold the costly whole-file tool. |
| `viewPages` | Default `true`. Offers `view_pages` for PDFs whose original is kept. It changes nothing for a library that keeps no originals. |
| `toolFilePlacement` | `"inside"` (default): the pages go in the function response itself, which Gemini 3 models read. `"beside"`: in a user turn of their own after the function responses, for Gemini 2.5, which does not see a file inside a function response. See [Where the pages go](configuration.md#where-the-pages-go-toolfileplacement). |
| `analysisConfig` | `(maxOutputTokens) => generationConfig` for whole-file part reads. The explorer model reads the parts when there is one, so write it for that model. |
| `onText`, `onActivity`, `onStep` | Streaming answer text, transient status, completed steps. |
| `fetch`, `signal` | Custom fetch (proxies, tests) and cancellation. |

Returns `{ text, answered, blockReason?, steps, plan, turns, finishReason?, usage? }`.

`answered` is `false` when the model's last turn had no text: the prompt was blocked
(`blockReason` says why), the reply was cut off before any text, or the model produced a malformed
tool call and the tool-free retry came back empty too. `text` is then empty or holds only a remark
the model made before a tool call, so show your own message:

```ts
const result = await askGemini({ ... });
if (!result.answered) show(result.blockReason ? "The request was blocked." : "No answer this time. Try again.");
```

It throws `DocumentsNotFoundError` (`.ids`) before calling the model, `GeminiRequestError` (`.status`)
for HTTP errors, and `Error` when the last message isn't the user's.

With an [explorer model](configuration.md#an-explorer-model), `text` and `onText` carry only what
the answering model wrote, `turns` counts the requests of both models, and `usage` and
`finishReason` are those of the answer. An explorer that fails throws `GeminiRequestError` too.

### Endpoints

- `geminiApi({ apiKey, model, explorerModel?, apiVersion = "v1beta", baseUrl? })`
- `vertexAi({ project, model, explorerModel?, location = "global", accessToken, apiVersion = "v1" })`,
  where `accessToken` can be a string or `() => string | Promise<string>`.
- Or any `{ url, streamUrl?, headers, explorerUrl? }` (`headers` can be a function).

`model` is the model that answers. `explorerModel` names a second one that makes the tool calls and
reads whole files in parts, so that `model` only writes the answer. Left out, empty, or the same as
`model`, one model does both, as before. In an endpoint of your own it is `explorerUrl`: the
`...:generateContent` URL of the explorer, called with the same headers. See
[An explorer model](configuration.md#an-explorer-model).

### Lower-level helpers

- `createGeminiGenerateText({ url, headers, fetchImpl?, generationConfig?, timeoutMs? })`: a `GenerateText` for your own loop.
- `toGeminiTools(declarations)`: `{ functionDeclarations }`.
- `geminiFunctionResponses([{ call, result, files? }])`: the `user` turn answering function
  calls. Files from `executeWithFiles` go inside their function response, as base64.
- `geminiFunctionResponseTurns([{ call, result, files? }], { files?: "inside" | "beside" })`: the
  turns to add to `contents`. That is the one turn above, or with `"beside"` the function
  responses followed by a `user` turn that holds the files.
- `FINAL_ANSWER_REQUEST`, `FINAL_ANSWER_AFTER_PAGES`: the messages `askGemini` adds when the model
  must stop using tools. The second is used when `view_pages` was the only tool.
- `FINAL_ANSWER_WITHOUT_TOOLS`, `EXPLORER_INSTRUCTION`: the two texts `askGemini` adds for an
  explorer model. The first asks the answering model for the answer when the explorer called no
  tool. The second is the line in the explorer's system instruction that says what its part is.
- `parseSseJson(stream)`: async iterator over a Generate Content SSE stream.

## `llm-large-files/node`

### `createDocumentHandlers(files, { getOwner? })`

Returns `{ upload(req, res), get(req, res, id), remove(req, res, id) }`.

- **upload**: the body is the raw file. Name it with an `X-File-Name` header (URI-encoded) or a
  `?name=` query parameter, and optionally set `X-File-Type`. Responds 201 with a `DocumentSummary`,
  or 400/413/422/500 with `{ error }`. If a framework already parsed the body into a `Buffer`
  (`express.raw()`), that buffer is used.
- **get**: 200 with a `DocumentSummary`, or 404.
- **remove**: `{ deleted: boolean }`.

Each handler answers its errors itself and never rejects, so it needs no `catch`. 422 is a file
that cannot be read. 500 is the server's trouble, such as a store that fails: the message says
what failed and gives a system error's code (`Upload failed (ENOSPC).`), never a path or a host.

`getOwner` runs before the upload is read. To refuse a request, throw an error with a `status`
(or `statusCode`) between 400 and 599, as the `http-errors` package makes:
`throw Object.assign(new Error("Sign in first."), { status: 401 })`. The handler answers with that
status and message. Any other error from `getOwner` is a 500 that does not repeat its message.
