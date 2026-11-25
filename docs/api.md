# API reference

The API reference is no longer one page. It is split by module of the package: one page for each
of the five other entry points, and four for the main entry, `llm-large-files`. This page keeps the headings of the old
page, so that links to them still work, and each one points to its new home. The guides that
explain each task are listed in the [documentation index](./README.md).

| Entry point | Reference |
|---|---|
| `llm-large-files` | [The library and its documents](./reference/library.md), [the tool loop and the adapter contract](./reference/ask.md), [errors, retries and streams](./reference/errors-and-retries.md), [the tools the model sees](./reference/tools.md) |
| `llm-large-files/gemini` | [Gemini API and Vertex AI: `gemini()`, `askGemini`, the endpoints](./reference/gemini.md) |
| `llm-large-files/openai` | [OpenAI-compatible endpoints: `openAiCompatible()`, `openAiResponses()`](./reference/openai.md) |
| `llm-large-files/anthropic` | [Claude: `anthropic()`](./reference/anthropic.md) |
| `llm-large-files/node` | [Node HTTP handlers: `createDocumentHandlers`](./reference/node.md) |
| `llm-large-files/testing` | [Testing: `fakeModel`, `fakeFetch`, `documentStoreChecks`](./reference/testing.md) |

## `llm-large-files`

Now four pages: [the library and its documents](./reference/library.md), [the tool loop and the adapter contract](./reference/ask.md), [errors, retries and streams](./reference/errors-and-retries.md), and [the tools the model sees](./reference/tools.md).

### `createLargeFiles(options): LargeFiles`

Now [`createLargeFiles`](./reference/library.md#createlargefilesoptions) in the library reference, with every option in [`LargeFilesOptions`](./reference/library.md#largefilesoptions).

### `LargeFiles`

Now [`LargeFiles`](./reference/library.md#largefiles) in the library reference, with the options of its methods and [`DocumentStoreError`](./reference/library.md#documentstoreerror).

### `PreparedContext`

Now [`PreparedContext`](./reference/library.md#preparedcontext) and [`DocumentPlan`](./reference/library.md#documentplan) in the library reference.

### `ToolSet`

Now [`ToolSet`](./reference/tools.md#toolset); each tool's arguments, results and limits are in [Tools](./reference/tools.md).

### Stores

Now [`DocumentStore`](./reference/library.md#documentstore), [`MemoryDocumentStore`](./reference/library.md#memorydocumentstore) and [`FileDocumentStore`](./reference/library.md#filedocumentstore) in the library reference; choosing a store and writing your own are in [Storage](./guides/storage.md).

### Helpers

Each helper is now on the page of its module: text sizes, formats, extractors, budgets, document IDs and `toDocumentSummary` in [the library reference](./reference/library.md); `toolResultSummary` and the tool constants in [Tools](./reference/tools.md); `evidenceOf`, `stubResult`, `mergeRanges` and `partialResultOf` in [the tool loop reference](./reference/ask.md); retries, error kinds, `parseSseJson` and the waits of the adapters in [Errors, retries and streams](./reference/errors-and-retries.md).

### Key types

Now [`DocumentMeta`](./reference/library.md#documentmeta), [`DocumentSummary`](./reference/library.md#documentsummary), [`DocumentFormat`](./reference/library.md#documentformat), [`Extractor`](./reference/library.md#extractor) and [`ExtractedText`](./reference/library.md#extractedtext) in the library reference, [`GenerateText`](./reference/ask.md#generatetext) and [`ModelCapabilities`](./reference/ask.md#modelcapabilities) in the tool loop reference, and [`ToolFile`](./reference/tools.md#toolfile) in Tools.

## `askWithFiles(options): Promise<AskResult>`

Now [`askWithFiles`](./reference/ask.md#askwithfilesoptions), [`AskOptions`](./reference/ask.md#askoptions), [`AskLimits`](./reference/ask.md#asklimits) and [`AskResult`](./reference/ask.md#askresult). What it throws ([`DocumentsNotFoundError`](./reference/ask.md#documentsnotfounderror), [`DocumentStoreError`](./reference/library.md#documentstoreerror), and [`ModelRequestError`](./reference/errors-and-retries.md#modelrequesterror) with its [`ModelErrorKind`](./reference/errors-and-retries.md#modelerrorkind)) and [`partialResultOf`](./reference/ask.md#partialresultoferror) are on those pages; what to show a user is in [Errors and reliability](./guides/errors-and-reliability.md).

### Keeping what a question read

Now in [Conversations](./guides/conversations.md); the type is [`ToolTurn`](./reference/ask.md#toolturn).

### Your own adapter

Now in [Your own adapter and loop](./guides/own-adapter-and-loop.md); the contract is [`ModelAdapter`](./reference/ask.md#modeladapter).

## `llm-large-files/gemini`

Now [the `llm-large-files/gemini` reference](./reference/gemini.md); setting up the Gemini API or Vertex AI is in [Gemini API and Vertex AI](./guides/vertex-and-gemini.md).

### `gemini(endpoint, options?): ModelAdapter`

Now in [the `llm-large-files/gemini` reference](./reference/gemini.md), with its options.

### `askGemini(options): Promise<AskGeminiResult>`

Now in [the `llm-large-files/gemini` reference](./reference/gemini.md), with its options and its result.

### Endpoints

`geminiApi`, `vertexAi`, `vertexHost` and the `GeminiEndpoint` type (an endpoint of your own) are now in [the `llm-large-files/gemini` reference](./reference/gemini.md); access tokens and gateways are in [Gemini API and Vertex AI](./guides/vertex-and-gemini.md).

### Lower-level helpers

`createGeminiGenerateText`, `toGeminiTools`, `geminiFunctionResponses` and `geminiFunctionResponseTurns` are now in [the `llm-large-files/gemini` reference](./reference/gemini.md); `FINAL_ANSWER_REQUEST`, `FINAL_ANSWER_AFTER_PAGES`, `FINAL_ANSWER_WITHOUT_TOOLS` and `EXPLORER_INSTRUCTION` in [the tool loop reference](./reference/ask.md); `parseSseJson` in [Errors, retries and streams](./reference/errors-and-retries.md); `llm-large-files/gemini` still exports them all, as [its reference](./reference/gemini.md) lists.

## `llm-large-files/openai`

Now [the `llm-large-files/openai` reference](./reference/openai.md); recipes for OpenAI, Azure OpenAI, DeepSeek, OpenRouter, vLLM, Ollama, LiteLLM and llama.cpp are in [OpenAI-compatible endpoints](./guides/openai-compatible.md).

### `openAiCompatible(options): ModelAdapter`

Now in [the `llm-large-files/openai` reference](./reference/openai.md), with its options.

## `llm-large-files/anthropic`

Now [the `llm-large-files/anthropic` reference](./reference/anthropic.md); setting up Claude is in [Claude](./guides/anthropic.md).

### `anthropic(options): ModelAdapter`

Now in [the `llm-large-files/anthropic` reference](./reference/anthropic.md), with its options.

## `llm-large-files/node`

Now [the `llm-large-files/node` reference](./reference/node.md); uploads and streamed answers are in [Web app](./guides/web-app.md).

### `createDocumentHandlers(files, { getOwner? })`

Now in [the `llm-large-files/node` reference](./reference/node.md), with its options, routes and statuses.
