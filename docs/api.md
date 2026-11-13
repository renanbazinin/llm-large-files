# API reference

Five entry points:

| Import | Contents |
|---|---|
| `llm-large-files` | Core: `createLargeFiles`, `askWithFiles`, stores, types, helpers. Provider-neutral. |
| `llm-large-files/gemini` | `gemini()`, `askGemini`, endpoints, Gemini helpers. |
| `llm-large-files/openai` | `openAiCompatible()` for any Chat Completions endpoint. |
| `llm-large-files/anthropic` | `anthropic()` for Claude. |
| `llm-large-files/node` | `createDocumentHandlers` for Node HTTP servers. |

## `llm-large-files`

### `createLargeFiles(options): LargeFiles`

| Option | Type | Default |
|---|---|---|
| `store` | `DocumentStore` | required |
| `budget` | `Partial<Budget>` | see [configuration](configuration.md#budget). What is left out follows `contextTokens`; values that cannot work together throw |
| `ttlMs` | `number` | 72 hours. `Infinity` keeps documents until they are deleted (`expiresAt` is then `NEVER_EXPIRES`) |
| `maxUploadBytes` | `number` | 100 MB |
| `extractors` | `Partial<Record<DocumentFormat, Extractor>>` | built-ins |
| `cacheBytes` | `number` | 256 MB: memory that documents kept ready between tool calls may take. Each use checks the store first. 0 keeps none |
| `cacheSize` | `number` | no limit: also caps the number of documents kept. The pieces kept of a document read by range are not counted |
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
| `prepare(ids, base, { owner?, viewPages?, budget? }?)` | Plans one request. `base` is `{ tokens, bytes }` for everything else in the request. Returns `PreparedContext`. `viewPages: true` says that your loop can pass files to the model. `budget` changes budget fields for this request. |
| `tools(documents, { generate?, onProgress?, signal?, viewPages?, regexBudgetMs?, maxWholeDocumentReads?, retry?, budget? })` | A `ToolSet` scoped to these documents: make one for each question. `generate` enables `analyze_whole_document`, for documents small enough for it. `viewPages` (`true`, or a list of documents such as `prepared.viewable`) enables `view_pages`. `regexBudgetMs` (default 6,000) is the time the regex searches of the tool set may take together. `maxWholeDocumentReads` (default 1) is how often each document may be read whole. `retry` is how a part read that failed is sent again. |
| `budgetFor(overrides?, limits?)` | The budget for one request: the library's, with `overrides` in place of its fields, made to fit `limits` (`{ contextTokens?, maxRequestBytes? }` of a model). |

`getMeta`, `getOriginal`, `delete`, `prepare` and the tools read the store. When it cannot be read
(a volume that does not answer, a database that is down) they throw `DocumentStoreError`, and a
tool call answers with its message. That is not "the document is gone": retry. The message names
no path and no host; `error.cause` is what the store threw, for your log.
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
  executeWithFiles(name, args, { maxFileBytes?, maxPages?, maxResultCharacters? }?): Promise<{ result: ToolResult; files: ToolFile[] }>;
  describe(name, args): string;           // "Search app.log (exact) for “timeout”"
  resultCharacters(name): number;         // the most characters a result of this tool can have
}
```

`executeWithFiles` runs any tool. Its `files` (`{ name, mimeType, bytes }`) are empty for all but
`view_pages`. `execute("view_pages", …)` returns an error, because it has no place for the file.
`maxResultCharacters` is the room your request has left for this result, when that is less than
the tool's own cap: the result is cut to it and says where to go on.

A second `analyze_whole_document` of the same document by one tool set answers with an error that
tells the model to use the first answer (`maxWholeDocumentReads`).

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
  `MAX_VIEW_PAGES` (5), `MAX_WHOLE_DOCUMENT_READS` (1).
- `resolveBudget(partial?, limits?)`: a whole `Budget` from the fields you give
  (see [configuration](configuration.md#budget)).
- `evidenceOf(call, result)`, `stubResult(call, result)`, `mergeRanges(ranges)`: what a tool call
  showed, the short stand-in for a result that is dropped, and line ranges made one. For a loop of
  your own.
- `withRetry(run, { retry?, signal?, canRetry?, onRetry? })`, `isRetryableStatus(status)`,
  `retryAfterMs(headers, body?)`: the retry rule of the loop, for an adapter or a loop of your own.
- `parseSseJson(stream)`: async iterator over the JSON events of a `text/event-stream` body.
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
  onUsage?: (usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; thoughtTokens?: number }) => void;
                            // call it once for every request that was answered
}) => Promise<string>;
type Extractor = (bytes: Uint8Array, input: { name: string; mimeType: string; format: DocumentFormat; scannedPages?: number }) => Promise<{ text: string; pages?: number }>;
// scannedPages: set when a PDF without any text is welcome, with the most pages it may have.

type ToolFile = { name: string; mimeType: string; bytes: Uint8Array };
```

## `askWithFiles(options): Promise<AskResult>`

The tool loop, for any model. It plans the documents, offers the tools, runs the calls within the
limits of the request, and ends with a request that must be answered in text.

| Option | Description |
|---|---|
| `files`, `model`, `documentIds`, `messages` | Required. `model` is an adapter: `gemini()`, `openAiCompatible()`, `anthropic()`, or [your own](#your-own-adapter). |
| `explorer` | A second adapter, of any provider. It makes the tool calls and reads whole files in parts, and `model` writes the answer from what the tools returned. See [An explorer model](configuration.md#an-explorer-model). |
| `messages` | The conversation; the last must be the user's. Plain turns `{ role: "user" \| "assistant", text }`, the `toolTurns` an earlier question returned, and turns with parts in the provider's own form: `{ role, parts: [{ text }, { native: anImagePart }] }`. |
| `system` | System instruction; the tool guide is appended when needed. |
| `owner` | Only documents with this owner (or no owner) are used. |
| `documentPlacement` | `"first"` (default): document text and cards go at the start of the first user turn and stay there, so follow-up questions reuse the provider's prompt cache. `"last"`: appended to the latest user turn. |
| `limits` | `toolTurns` (12): the most chat requests for one question, counting the answer. `callsPerTurn` (8): the most tool calls of one turn that are run. `wholeDocumentReads` (1): how often each document may be read whole. `inputTokens`, `requests` (none): ceilings for the whole question, part reads included. |
| `retry` | `{ retries = 3, baseDelayMs = 500, maxDelayMs = 60_000 }`. See [Limits and retries](configuration.md#limits-and-retries). |
| `budget` | Budget fields for this question, in place of the library's. |
| `wholeDocumentAnalysis` | Default `true`. Set `false` to withhold the costly whole-file tool. |
| `viewPages` | Default `true`. Offers `view_pages` for PDFs whose original is kept, when every model of the question can be sent a file. |
| `onText`, `onActivity`, `onStep` | Answer text as it arrives, transient status, completed steps. |
| `signal` | Stops the question. |

Returns:

```ts
{
  text: string;             // everything the answering model wrote
  answered: boolean;        // false when its last turn had no text, or the prompt was refused
  blockReason?: string;
  steps: string[];          // "Search app.log (exact) for “timeout” — 12 matching lines"
  evidence: Evidence[];     // per tool call: { tool, documentId, document, lines?, pages?, query?, mode?, totalMatchingLines?, whole? }
  toolTurns: ToolTurn[];    // the tool rounds as plain JSON, to keep with the conversation
  plan: DocumentPlan;       // which documents went in whole and which were searched
  budget: Budget;           // the budget the question ran with
  turns: number;            // chat requests, an explorer's among them; part reads are not counted
  finishReason?: string;
  usage: {                  // every request that was answered, part reads included
    requests: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; thoughtTokens: number;
    byModel: Record<string, { requests; inputTokens; cachedInputTokens; outputTokens; thoughtTokens }>;
  };
  lastUsage?: Record<string, unknown>; // the provider's own usage object of the last chat response
}
```

`inputTokens` counts every token of the prompts, those read from a cache included, and
`cachedInputTokens` is the part that was. `outputTokens` includes thoughts.

`answered` is `false` when the model's last turn had no text: the prompt was blocked
(`blockReason` says why), the reply was cut off before any text, or the model produced a malformed
tool call and the request for the answer came back empty too. `text` is then empty or holds only a
remark the model made before a tool call, so show your own message:

```ts
const result = await askWithFiles({ ... });
if (!result.answered) show(result.blockReason ? "The request was blocked." : "No answer this time. Try again.");
```

It throws `DocumentsNotFoundError` (`.ids`) before calling the model, `DocumentStoreError` when the
store could not be read (retry: the documents are not gone), `ModelRequestError` (`.status`, and
`.retryAfterMs` when the provider named a wait) for an HTTP error that another try did not mend,
and `Error` when the last message isn't the user's. `status` is 0 for a connection that failed.
Each adapter throws its own subclass: `GeminiRequestError`, `OpenAiRequestError`,
`AnthropicRequestError`.

### Keeping what a question read

`toolTurns` are the tool rounds of the question, with each result as the model had it. Store them
between the question and its answer, and pass them back:

```ts
const first = await askWithFiles({ files, model, documentIds, messages: [{ role: "user", text: question }] });
await saveTurn(sessionId, { question, toolTurns: first.toolTurns, answer: first.text });

// The next question of the conversation:
const messages = [
  { role: "user", text: question }, ...first.toolTurns, { role: "assistant", text: first.text },
  { role: "user", text: "And how long did recovery take?" },
];
```

The model then sees what it read before, and a follow-up is often answered without a new search.
The rounds are plain JSON and belong to no provider. The pages of a PDF are not in them: a stored
round says that they were shown. They count against the budget like any other part of the
conversation, and late in a long question the oldest are shortened first.

### Your own adapter

```ts
import type { ModelAdapter } from "llm-large-files";

const model: ModelAdapter = {
  id: "my-model",                                   // names the model in usage totals
  capabilities: { toolFiles: "none", pageTokens: 0 }, // and, when you know them: contextTokens, maxRequestBytes, outputTokens, tokenScale, appendOnly
  async send(request, hooks) {
    // request: { system, messages, tools?, toolChoice? }
    // messages: { role: "user" | "assistant", parts: [{ text } | { native }] }
    //         | { role: "tools", calls, answers: [{ call, result, files? }], raw? }
    // Turn them into your provider's request, post it with hooks.signal, and call hooks.onText
    // with the text as it arrives.
    return { text, calls: [{ id, name, args }], raw: theTurnAsYourProviderSentIt, finishReason, usage: { inputTokens, outputTokens } };
  },
  generateText: async ({ system, prompt, maxOutputTokens, signal, onUsage, onTruncated }) => "…", // optional: enables whole-file reads
};
```

- A `tools` message is one round: the model's calls and the results, in call order. `raw` is the
  turn as your `send` returned it, given back only to the adapter that produced it. Without `raw`
  (an explorer of another provider made the calls, or the round was stored), build the turn from
  `calls`.
- `toolChoice: "none"` means the model must answer in text. The tools are still in `tools`, for a
  provider that wants them declared next to earlier calls.
- Throw `ModelRequestError(message, status, { retryAfterMs })` for an HTTP error, with status 0
  for a connection that failed. The loop retries the ones worth retrying.
- Give a call whose arguments did not parse a `problem`: the loop answers it with that message and
  does not run it.
- `capabilities.toolFiles` says where a file from a tool goes (`"inside"` the result, `"beside"`
  it, or `"none"`: `view_pages` is then not offered). `appendOnly: true` tells the loop never to
  rewrite an earlier turn of the conversation.

## `llm-large-files/gemini`

### `gemini(endpoint, options?): ModelAdapter`

A Gemini model for `askWithFiles`. `endpoint` is `geminiApi()`, `vertexAi()`, or your own
`{ url, streamUrl?, headers }`; its `explorerUrl` is not used here, because an explorer is an
adapter of its own.

| Option | Description |
|---|---|
| `generationConfig` | Sent with every chat request. |
| `toolFilePlacement` | `"inside"` (default) or `"beside"`: see [Where the pages go](configuration.md#where-the-pages-go-toolfileplacement). |
| `analysisConfig` | `(maxOutputTokens) => generationConfig` for whole-file part reads. |
| `contextTokens`, `maxRequestBytes` | The model's window and the largest request, when the budget of a question should follow them. |
| `pageTokens` | Tokens billed for one PDF page. Default 530. |
| `id`, `fetch` | The name in usage totals (default: the model in the URL), and a custom fetch. |

```ts
const model = gemini(geminiApi({ apiKey, model: "gemini-3.8-flash" }), { generationConfig: { temperature: 0.3 } });
const explorer = gemini(geminiApi({ apiKey, model: "gemini-3.5-flash-lite" }));
await askWithFiles({ files, model, explorer, documentIds, messages });
```

`fromGeminiContents(contents)` turns Gemini `contents` into `messages`, and
`geminiToolTurns(toolTurns)` gives stored tool rounds as `contents`.

### `askGemini(options): Promise<AskGeminiResult>`

`askWithFiles` with a `gemini()` model for the endpoint, and a second one for its explorer model
when it names one. It takes Gemini `contents` as well as `messages`.

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
| `limits`, `retry`, `budget` | As in `askWithFiles`. |
| `maxToolTurns` | `limits.toolTurns` under its older name. Default 12. The most requests for one question, counting the answer. If the model is still calling tools on the last one, it is sent with no tools so the model must answer. With an explorer model the answer is always the last request, so the explorer has one less. |
| `maxToolCallsPerTurn` | `limits.callsPerTurn` under its older name. Default 8. The most tool calls of one model turn that are run. The others are answered with an error that tells the model to send them again if it still needs them. |
| `wholeDocumentAnalysis` | Default `true`. Set `false` to withhold the costly whole-file tool. |
| `viewPages` | Default `true`. Offers `view_pages` for PDFs whose original is kept. It changes nothing for a library that keeps no originals. |
| `toolFilePlacement` | `"inside"` (default): the pages go in the function response itself, which Gemini 3 models read. `"beside"`: in a user turn of their own after the function responses, for Gemini 2.5, which does not see a file inside a function response. See [Where the pages go](configuration.md#where-the-pages-go-toolfileplacement). |
| `analysisConfig` | `(maxOutputTokens) => generationConfig` for whole-file part reads. The explorer model reads the parts when there is one, so write it for that model. Without it a part is asked for with `{ maxOutputTokens, temperature: 0.2 }`. A model that thinks counts its thoughts in that limit: a reply that it cut off that way is asked for again with 32,768, and later parts start there. |
| `onText`, `onActivity`, `onStep` | Streaming answer text, transient status, completed steps. |
| `fetch`, `signal` | Custom fetch (proxies, tests) and cancellation. |

Returns what `askWithFiles` returns. **`usage` is the total of the question since 0.5.0**; Gemini's
own `usageMetadata` of the last response, which `usage` was before, is `lastUsage`.

It throws what `askWithFiles` throws; the model's errors are `GeminiRequestError` (`.status`, 0
for a connection that failed).

With an [explorer model](configuration.md#an-explorer-model), `text` and `onText` carry only what
the answering model wrote, `turns` counts the requests of both models, `usage.byModel` has an
entry for each, and `finishReason` and `lastUsage` are those of the answer. An explorer that
fails throws `GeminiRequestError` too.

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

- `createGeminiGenerateText({ url, headers, fetchImpl?, generationConfig?, timeoutMs? })`: a `GenerateText` for your own loop. `headers` can be a function, called for every request.
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

## `llm-large-files/openai`

### `openAiCompatible(options): ModelAdapter`

Any Chat Completions endpoint: OpenAI, Azure OpenAI, DeepSeek, LiteLLM, vLLM, Ollama, OpenRouter,
Gemini's OpenAI layer.

| Option | Description |
|---|---|
| `model` | Required: the model name the endpoint knows. |
| `baseUrl` | `/chat/completions` is added to it. Default `https://api.openai.com/v1`. |
| `url` | The whole URL, when it is not `baseUrl` + `/chat/completions` (Azure, a gateway). |
| `apiKey`, `headers` | `Authorization: Bearer …`, and more headers. A function is called for each request. |
| `body` | More fields for every chat request: `temperature`, `reasoning_effort`, `max_completion_tokens`. |
| `analysisBody` | `(maxOutputTokens) => fields` for whole-file part reads. |
| `maxTokensField` | The name of the output limit in a part read. Default `max_completion_tokens` for api.openai.com and Azure OpenAI, `max_tokens` elsewhere. |
| `answerWithoutTools` | `"tool_choice"` (default): the request for the answer keeps the tools and sends `tool_choice: "none"`. `"omit"`: it leaves them out, for a server that does not know `tool_choice`. |
| `pdfInput` | Default `false`. Send the pages of `view_pages` as a `file` part in a user message after the tool results. For a model that reads PDF input: many servers behind this API do not (Gemini's layer answers HTTP 400). Not run against OpenAI itself. |
| `stream`, `systemRole` | `false` for a server without streaming; `"developer"` for one that wants the newer role name. |
| `contextTokens`, `maxRequestBytes`, `tokenScale`, `pageTokens` | What the model takes, when the budget should follow it. |
| `id`, `timeoutMs`, `fetch` | The name in usage totals, the time a part read may take (180 s), a custom fetch. |

The model's own message goes back to it as it came (a server may want its `reasoning_content` or a
signature again). `fromOpenAiMessages(history)` returns `{ system, messages }` for a history kept
as Chat Completions messages, and `openAiToolTurns(toolTurns)` gives stored rounds in that form.

## `llm-large-files/anthropic`

### `anthropic(options): ModelAdapter`

Claude through the Messages API. Not run against the API for this release: it is tested against
the request and response shapes of its documentation.

| Option | Description |
|---|---|
| `model` | Required: `"claude-opus-5-5"`. |
| `apiKey`, `authToken` | `x-api-key`, or `Authorization: Bearer …`. A function is called for each request. |
| `baseUrl`, `url`, `headers`, `version`, `betas` | For a gateway that speaks the same API: `/v1/messages` is added to `baseUrl`. `version` is the `anthropic-version` header (default `2026-10-21`). |
| `maxTokens` | `max_tokens` of a chat request. Default 64,000. It comes out of the context window, so the budget of a question keeps it free. |
| `body` | More fields for every chat request: `thinking`, `output_config`, `context_management`. |
| `analysisBody` | `(maxOutputTokens) => fields` for whole-file part reads, such as `{ output_config: { effort: "low" } }`. |
| `fallbacks` | `"default"`, or a list of `{ model }`: another model answers when a safety classifier declines the request. Off unless set: it adds a beta header that Bedrock, Vertex AI and Foundry do not take. |
| `cache` | Prompt caching. `true` (default) for five minutes, `"1h"`, or `false`. A cache write costs a quarter more than plain input, and a read a tenth. |
| `toolFilePlacement` | `"inside"` (default): pages go into the tool result as a document block. `"beside"`: after the tool results. `"none"`: `view_pages` is not offered. |
| `stream` | Default `true`: chat requests are streamed, which keeps a long reply from timing out. |
| `contextTokens`, `maxRequestBytes`, `pageTokens`, `tokenScale` | Defaults: none, 32 MB, 3,500, and 1.35 (a guess for the current tokenizer, corrected during a question by the count the API reports). |
| `id`, `timeoutMs`, `fetch` | As above. |

What the adapter takes care of:

- The model's turn goes back exactly as it came, thinking blocks included, and the conversation is
  never rewritten: Claude checks its thinking blocks against the conversation they were written
  in. So old tool results are not shortened for Claude. When the room runs out, the next request is
  the answer. For long conversations, turn on the API's own clearing of old tool results with
  `body: { context_management: … }` and its beta in `betas`.
- The request for the answer keeps the tools and sends `tool_choice: { type: "none" }`.
- A refusal (`stop_reason: "refusal"`) is `blockReason: "refusal: <category>"`.
- No sampling settings are sent: the API of this version refuses `temperature`.

`fromAnthropicMessages(history)` and `anthropicToolTurns(toolTurns)` convert a history kept as
Messages API messages.

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
