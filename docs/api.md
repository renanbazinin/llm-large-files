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
| `cacheSize` | `number` | 6 parsed documents in memory |

### `LargeFiles`

| Member | Description |
|---|---|
| `ingest({ name, mimeType?, bytes, owner? })` | Extracts, normalizes, profiles, and stores a file. Returns `DocumentMeta`. Throws an `Error` with a user-readable message for empty, oversized, binary, or text-less files. |
| `getMeta(id, { owner }?)` | `DocumentMeta`, or `undefined` if unknown, expired, or owned by someone else. |
| `delete(id, { owner }?)` | `true` if deleted. |
| `sweep()` | Removes expired documents; returns the count. |
| `prepare(ids, base, { owner }?)` | Plans one request. `base` is `{ tokens, bytes }` for everything else in the request. Returns `PreparedContext`. |
| `tools(documents, { generate?, onProgress?, signal? })` | A `ToolSet` scoped to these documents. `generate` enables `analyze_whole_document`. |
| `budget`, `maxUploadBytes` | The effective settings. |

### `PreparedContext`

```ts
{
  plan: { inline: DocumentMeta[]; searchable: DocumentMeta[]; inlineTokens: number; inlineBytes: number };
  blocks: Map<string, string>;  // per document ID: full text (inline) or a summary card (searchable)
  instruction: string;          // add to the system prompt; empty when nothing is searchable
  missing: string[];            // IDs not found (never uploaded, expired, or another owner's)
}
```

### `ToolSet`

```ts
{
  declarations: ToolDeclaration[];        // { name, description, parameters: JSON Schema }
  has(name): boolean;
  execute(name, args): Promise<ToolResult>; // errors come back as { error } for the model to read
  describe(name, args): string;           // "Search app.log (exact) for “timeout”"
}
```

| Tool | Arguments | Returns |
|---|---|---|
| `search_document` | `document_id`, `query`, `mode`: `keywords` (default) \| `exact` \| `regex`, `max_results`, `context_lines`, `case_sensitive` | `keywords`: ranked passages with numbered lines. `exact`/`regex`: matching lines and `total_matching_lines`. |
| `read_document` | `document_id`, `start_line`, `end_line?` | Up to 600 numbered lines, and `next_start_line` if there's more |
| `get_document_overview` | `document_id` | Format, size, outline, log profile, first and last lines |
| `analyze_whole_document` | `document_id`, `task` | `answer` from a map-reduce read, plus part counts |

### Stores

- `new MemoryDocumentStore({ now? })`: in-process, for tests and single-instance demos.
- `new FileDocumentStore(directory, { now? })`: `<id>.txt` and `<id>.json` per document.
- Implement `DocumentStore` (`put`, `get`, `getMeta`, `delete`, `sweep?`) for anything else.

### Helpers

- `toDocumentSummary(meta)`: the browser-safe fields (`DocumentSummary`).
- `toolResultSummary(label, result)`: `" — 12 matching lines"`, for step lists.
- `isDocumentId(value)`, `DOCUMENT_ID_PATTERN`.
- `estimateTokens(text)`, `utf8Bytes(text)`, `jsonBytes(text)`.
- `detectFormat(name, mimeType)`, `defaultExtractors`, `TOOL_NAMES`, `DEFAULT_BUDGET`.
- `createPdfExtractor({ tables?: boolean })`: the built-in PDF extractor with an option changed.
  `tables: false` gives the text in pdf.js order, without rebuilt tables
  (see [PDF tables](configuration.md#pdf-tables)).

### Key types

```ts
type DocumentFormat = "text" | "markdown" | "log" | "json" | "csv" | "pdf" | "docx" | "pptx";

type DocumentMeta = {
  id: string; owner?: string; name: string; mimeType: string; format: DocumentFormat;
  bytes: number; textBytes: number; characters: number; lines: number; estimatedTokens: number;
  wrappedLines: number; pages?: number;
  outline: { line: number; level: number; title: string }[];
  logProfile?: { levels: Record<string, number>; firstTimestamp?: string; lastTimestamp?: string;
                 topIssues: { template: string; level: string; count: number; firstLine: number }[] };
  createdAt: string; expiresAt: string;
};

type GenerateText = (request: {
  system: string; prompt: string; maxOutputTokens: number; signal?: AbortSignal;
  onTruncated?: () => void; // call it when the model stopped at maxOutputTokens
}) => Promise<string>;
type Extractor = (bytes: Uint8Array, input: { name: string; mimeType: string; format: DocumentFormat }) => Promise<{ text: string; pages?: number }>;
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
| `owner` | Only documents with this owner (or no owner) are used. |
| `documentPlacement` | `"first"` (default): document text and cards go at the start of the first user turn and stay there, so follow-up questions reuse Gemini's prompt cache. `"last"`: appended to the latest user turn, as in 0.1.0. |
| `maxToolTurns` | Default 12. The most requests for one question, counting the answer. If the model is still calling tools on the last one, it is sent with no tools so the model must answer. |
| `wholeDocumentAnalysis` | Default `true`. Set `false` to withhold the costly whole-file tool. |
| `analysisConfig` | `(maxOutputTokens) => generationConfig` for whole-file part reads. |
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

### Endpoints

- `geminiApi({ apiKey, model, apiVersion = "v1beta", baseUrl? })`
- `vertexAi({ project, model, location = "global", accessToken, apiVersion = "v1" })`, where
  `accessToken` can be a string or `() => string | Promise<string>`.
- Or any `{ url, streamUrl?, headers }` (`headers` can be a function).

### Lower-level helpers

- `createGeminiGenerateText({ url, headers, fetchImpl?, generationConfig?, timeoutMs? })`: a `GenerateText` for your own loop.
- `toGeminiTools(declarations)`: `{ functionDeclarations }`.
- `geminiFunctionResponses([{ call, result }])`: the `user` turn answering function calls.
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
