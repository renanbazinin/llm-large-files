# Upgrading to 0.99

This page takes an application from 0.10.x to 0.99.9. Read [Requirements](#requirements),
[Does my code compile?](#does-my-code-compile) and
[Owner checks are on by default](#owner-checks-are-on-by-default) first: most applications change
one line, or none. Every change is in the [changelog](../CHANGELOG.md).

0.99.9 is the candidate for 1.0, without a promise yet that the API stays as it is. Versions 0.99.x
keep the rules of 0.x versions: a minor version may need changes in your code, and its
**Upgrading** part says what. The library is safe by default: every call names its owner. Options
kept for one version in 0.10.0 are removed. Everything else is new and optional.

## Contents

- [Requirements](#requirements)
- [Does my code compile?](#does-my-code-compile)
- [Owner checks are on by default](#owner-checks-are-on-by-default)
- [Removed options](#removed-options)
- [Stored documents and rounds](#stored-documents-and-rounds)
- [Upload handlers](#upload-handlers)
- [Behavior to check](#behavior-to-check)
- [Rolling deploys](#rolling-deploys)
- [New and optional](#new-and-optional)

## Requirements

<!-- skeleton: Node and @types/node unchanged (22.12); the optional peers and their ranges (jszip,
unpdf, @cantoo/pdf-lib unchanged); six entry points. -->

- **A new optional peer, `@napi-rs/canvas`** (`^0.1.69 || ^1.0.0`), for pages drawn as images only.
  With unpdf 2 it needs Node 24 or later: unpdf 2 declares it, and npm installs it on Node 22 only
  with an `EBADENGINE` warning, unsupported. Nothing else needs it, and nothing installs it for you
  ([Page images and the files themselves](#page-images-and-the-files-themselves)).

- **What a store holds is unchanged.** `DocumentMeta` keeps `metaVersion: 1`, `ToolTurn` keeps
  `version: 1`, and the files of `FileDocumentStore` keep their names and format. Servers of 0.10.x
  and 0.99.9 read what the other stores. Documents and rounds stored before 0.9.0, without a
  version, are read as before ([Stored documents and rounds](#stored-documents-and-rounds)).

## Does my code compile?

Most code does. A call without an owner compiles, and throws at run time: see
[Owner checks are on by default](#owner-checks-are-on-by-default). These do not compile:

| Code of yours | The error | What to write |
|---|---|---|
| A mock typed `CreatedLargeFiles` or `ReturnType<typeof createLargeFiles>` without `list`, `touch` and `update` (TS2739) | They are required members since 0.99.9 | Add them, or type the mock `LargeFiles`, whose members they stay optional on |
| A `DocumentHandlers` made by hand, such as a mock (TS2741) | `list` is required | Add `list`, or type the mock as the part you use |
| `inlineTables` or `numberInline` in the options of `askWithFiles` or `askGemini` (TS2353), or `Pick<AskOptions, "inlineTables" \| "numberInline">` (TS2344) | Both options were removed | Delete them. Tables sent whole always get the tools, and files sent whole are always numbered ([The way back to 0.9's text](#the-way-back-to-09s-text)) |
| An adapter object typed `ModelAdapter` that has `estimateTokens` (TS2353) | `ModelAdapter.estimateTokens` was removed | Delete it. Set `capabilities.tokenScale` for a model that counts tokens differently |

Code that compiles and still needs a look:

- **`files.list!(…)`, `files.touch!(…)` and `files.update!(…)`** compile as before; the `!` can go.
- **A `LargeFiles` of your own handed to `createDocumentHandlers`** without `access` counts as
  requiring an owner: it throws a `TypeError` without `getOwner`. Give `getOwner`, or pass
  `access: { requireOwner: false, requireScope: false }` on it.
- **A `LargeFiles` of your own whose `ingest` returns a copy** of the metadata its library gave
  loses the mark of a document `dedupe` gave back: the upload handlers then take it for a new one,
  and delete it when `onUploaded` throws, as in 0.10.2. Return the object `ingest` gave.
- **Options spread in from another object, or code in JavaScript:** `inlineTables: "text"`,
  `numberInline: false` or any value but `"tools"` and `true` is a `TypeError` before any request.
- **A class that implements `ModelAdapter` with an `estimateTokens` method** compiles. The loop
  never called it, and does not now.

## Owner checks are on by default

`requireOwner` is now `true` unless you pass `false`. Every call that reads or changes documents
must name its owner: `ingest`, `getMeta`, `getOriginal`, `delete`, `list`, `touch`, `update`,
`prepare`, `toolsFor`, `askWithFiles`, `askStream`, `askGemini`, and `tools`, which then needs
`access`. A call without one throws, before the store is asked anything:

    TypeError: owner is required: requireOwner is on (the default). Pass the user's ID as owner, or create the library with requireOwner: false to allow calls without one.

Its start is that of 0.9.0 to 0.10.x, for code that looks for it. Only `false` turns the checks
off: any other value (`"false"` from an environment file, `0`) leaves them on.

Documents stored without an owner, by any earlier version, now read as missing: `getMeta` gives
undefined, `delete` gives false, a question lists them as missing (`DocumentsNotFoundError` by
default), `list` leaves them out, and `touch` and `update` give undefined. Nothing is deleted: they
stay in the store until they expire. `sweep` takes no owner, and removes expired documents of
every owner, those without one included.

Choose one of two paths.

### Keep 0.10's behavior: `requireOwner: false`

For an application with one user (a script, a command-line tool), or one that lets anyone with a
document's ID use it:

```ts
const files = createLargeFiles({ store, requireOwner: false });
```

Everything then works as in 0.10, documents without an owner included. The upload handlers need no
`getOwner`.

### Name the owner on every call

```ts
const meta = await files.ingest({ name, bytes, owner: userId });
const result = await askGemini({ files, endpoint, documentIds: [meta.id], messages, owner: userId });
const tools = files.tools([meta], { access: { owner: userId } });
const documents = createDocumentHandlers(files, { getOwner: (request) => userIdOf(request) });
```

In the upload handlers, a request whose `getOwner` gives `undefined` or `null` is answered `401`
`{"error":"Sign in first."}`, before its body is read. Without `getOwner`, `createDocumentHandlers`
throws a `TypeError`:

    TypeError: createDocumentHandlers needs getOwner: the library requires an owner on every call (requireOwner, on by default). Give getOwner, or create the library with requireOwner: false.

A `LargeFiles` of your own handed to it without `access` counts as requiring an owner: give
`getOwner`, or pass `access: { requireOwner: false, requireScope: false }`.

Documents stored without an owner are refused until you store them again with one:

- **Wait.** With the default `ttlMs` (72 hours), they expire within 3 days, and `sweep` removes
  them.
- **Ask users to attach the files again.** Each new upload is stored with its owner.
- **Store them again yourself**, when you can read the file again (its kept original, or your own
  copy). Use a second library with the checks off for the old documents:

  ```ts
  const legacy = createLargeFiles({ store, requireOwner: false });
  for (const old of await legacy.list({ scope })) {           // the documents of that scope without an owner
    const bytes = await legacy.getOriginal(old.id, { scope }); // or your own copy of the file
    if (!bytes) continue;
    const userId = ownerOf(old.id);                            // from your own records
    const stored = await files.ingest({ name: old.name, mimeType: old.mimeType, bytes, owner: userId, scope, ...(old.appData ? { appData: old.appData } : {}) });
    await legacy.delete(old.id, { scope });
    await recordNewId(old.id, stored.id);                      // the ID changes
  }
  ```

  Under an application ID (`ingest({ id })`), delete the old document first, then ingest under the
  same ID: `ifExists: "replace"` never replaces a document of another owner. Keep the bytes until
  the new ingest has succeeded.

### Tests

A test that is not about owners can make its library with `requireOwner: false`. A test of what
users see should pass the owner, as your server does. `documentStoreChecks` passes owners already:
the checks of a store of your own run as before.

## Removed options

0.99.9 removes the two options of `askWithFiles` and `askGemini` that 0.10.0 kept for one version,
and `ModelAdapter.estimateTokens`, deprecated since 0.6.0. TypeScript refuses the options, and an
adapter object typed `ModelAdapter` that declares `estimateTokens`. Code in JavaScript, or options
spread in from another object, still reach the loop: a removed option with a value that would
change something is a `TypeError` before any request, and an `estimateTokens` member is ignored, as
it always was.

### The way back to 0.9's text

0.10.0 kept two options for one version, to send what 0.9 sent
([Going back to 0.9's text](./upgrading-0.10.md#going-back-to-09s-text)). 0.99.9 removes both from
`askWithFiles` and `askGemini`:

| Removed | What happens now |
|---|---|
| `inlineTables: "text"` | A table sent whole always gets `search_document`, `read_document` and `aggregate_table` |
| `numberInline: false` | Files sent whole always have numbered lines, and the citation line when no file is searched |

A question asked without them sends what 0.10.2 sent, byte for byte. Nothing misses the cache at
the upgrade for this reason.

**Who:** apps that pass either option.

**What happens:** TypeScript refuses both. At run time, any value but `"tools"` and `true` is a
`TypeError` before any request:

> inlineTables was removed in 0.99.9, and is "text": a table sent whole always gets the tools that
> count it, as "tools" did. Leave it out.

> numberInline was removed in 0.99.9, and is false: the lines of files sent whole are always
> numbered, as true did. Leave it out.

**What to do:** delete the options. To bound what a table sent whole costs, you have two choices:

- Set `limits.toolTurns` or `limits.inputTokens`. Limits sized for one request (`toolTurns: 1`,
  `requests: 1`) make one request without the tools, its lines numbered.
- Lower `budget.inlineTokens`, so the table is searched instead of sent whole
  ([Tables sent whole](./guides/costs-and-limits.md#tables-sent-whole)).

No option gives 0.9's text back. A loop of your own keeps `PrepareOptions.numberInline` and
`inlineTables`, off by default.

### `ModelAdapter.estimateTokens`

It was deprecated in 0.6.0 and never called: the loop sizes every request with the library's
`estimateTokens`, scaled by `capabilities.tokenScale`.

**Who:** adapters of your own that declare it.

**What to do:** delete it. Set `capabilities.tokenScale` instead, for example 1.33 for a tokenizer
that counts a third more ([Capabilities](./guides/own-adapter-and-loop.md#capabilities)).

## Stored documents and rounds

0.99.9 reads every shape stored since 0.2; from 0.99.9 on, each version reads at least the shape
of the version before it. 0.99.9 changes neither shape: `DocumentMeta.metaVersion` and
`ToolTurn.version` stay 1, as from 0.9.0 to 0.10.2, and metadata and rounds without a version
(stored before 0.9.0) are read as before. Every build of the library reads, in its tests, the files
that `FileDocumentStore` of 0.8.2, 0.9.0 and 0.10.2 wrote and the `toolTurns` they returned.

A later version that changes a shape raises `DOCUMENT_META_VERSION` or `TOOL_TURN_VERSION`, and
still reads the shape before it. A version refuses what is stored in a shape newer than its own,
with an error that says so:

| What is stored | Where | What happens |
|---|---|---|
| Metadata of a newer `metaVersion` | `getMeta`, `getOriginal`, `delete`, `prepare`, the tools, `askWithFiles`, and `ingest` with `ifExists: "replace"` | A `DocumentStoreError` of code `"NEWER_VERSION"`, status 503, retryable in `errorInfoOf`. The document is never taken for missing, and never replaced |
| The same | `files.list` and ingest's `dedupe` | Left out, without an error: `dedupe` ingests a new copy |
| A round of a newer `version` | `askWithFiles` (and `askStream` and `askGemini`), and since 0.99.9 `compactToolTurns`, `geminiToolTurns`, `openAiToolTurns` and `anthropicToolTurns` | A `TypeError` that names the version, before any request |

> A stored tool round (toolTurns) has version 2: a newer version of llm-large-files made it, and
> this one reads up to version 1. Leave it out of messages.

Since 0.99.9 `files.list` also leaves out metadata whose `metaVersion` is NaN, which `getMeta`
refuses.

**Who:** apps whose servers of two versions share a store or answer one chat.

**What to do:** nothing for 0.99.9. When a later version raises a number, let a `NEWER_VERSION` call
be tried again on a newer server, and leave a refused round out of `messages`, or ask on a newer
server ([Servers of two versions](./guides/deployment.md#servers-of-two-versions)).

## Upload handlers

Owner checks change who may call them (above). The rest is new and optional:

- **`handlers.list(request, response)`** answers a `GET` with the documents of the request's owner
  and scope, the oldest first, as `{ "documents": [summary, …] }`: route `GET /api/documents` to
  it for a chat's file panel. A request with neither an owner nor a scope (possible only under
  `requireOwner: false`) is answered `401` "Sign in first.": its list would hand out the IDs of
  every document stored without an owner
  ([`list`](./reference/node.md#listrequest-response)).
- **`prepareUpload` can return `dedupe` and `appData`**, the server's own values, passed to
  `ingest`. With `dedupe: true`, a file uploaded again into the same chat answers `201` with the
  document stored before, and `onUploaded` is told `reused: true`: do not record it twice. Such a
  document is never deleted by the handlers, even when `onUploaded` throws, and the file saved to
  `path` for that upload is removed. `appData` is checked before the body is read, kept in the
  metadata, and never answered. Build both on the server, not from what the client sent
  ([Web app](./guides/web-app.md#the-same-file-twice-and-your-own-data-dedupe-and-appdata)).

## Behavior to check

<!-- every package: behavior that changed without a compile error. -->

### Performance budgets in CI

Nothing to change. CI now holds ingest and search to bars of time and memory on every pull request
([Performance budgets](./measurements.md#performance-budgets-0999)). The package, its defaults and
the requests it sends are not changed by it: `npm run perf` is a script of the repository, not of
the package.

### Image files from a tool set of your own

`anthropic()` sends a file that a tool returns as an `image` block when its `mimeType` is an image
type; it sent every file as a `document` block, which the Messages API takes for PDF only.
`openAiCompatible({ pdfInput: true })` sends one as an `image_url` part, not a `file` part. The
library's own tools returned no image before 0.99.9.

**Who:** apps whose own tools return images through `executeWithFiles`-style answers to these
adapters. **What to do:** nothing; the new blocks are the ones the providers document for images.

### Readers of stored rounds refuse a newer round

`geminiToolTurns`, `openAiToolTurns`, `anthropicToolTurns` and `compactToolTurns` throw the
`TypeError` of `askWithFiles` for a round whose `version` is above `TOOL_TURN_VERSION` (1). They
converted it as a round of version 1. No round that 0.99.9 or an earlier version stored is refused.

**Who:** apps that convert stored rounds while servers of a newer version answer the same chats.
**What to do:** nothing for 0.99.9 ([Stored documents and rounds](#stored-documents-and-rounds)).

## Rolling deploys

- **Owner checks.** While servers of 0.10 and 0.99.9 share a store, set `requireOwner` explicitly
  on both if your application ever ingests without an owner. A 0.10 server checks no owner by
  default, and a 0.99.9 server reads a document stored without one as missing: a chat answered by
  both in turn would find its files on one and not on the other. Once every server runs 0.99.9, the
  setting can go back to the default. An application that passes owners on every call needs
  nothing.
- **Stored shapes.** Servers of 0.10.x and 0.99.9 share a store and conversations: neither changes
  what is stored. From 0.99.9 on, a version that changes the shape of `DocumentMeta` or `ToolTurn`
  raises `DOCUMENT_META_VERSION` or `TOOL_TURN_VERSION` and still reads the shape before it. The
  older server refuses what a newer one wrote in a newer shape:
  - a document, with a `DocumentStoreError` of code `"NEWER_VERSION"` (503: retry on a newer
    server);
  - a stored round, with a `TypeError` that names its version. Since 0.99.9 this also comes from
    `geminiToolTurns`, `openAiToolTurns`, `anthropicToolTurns` and `compactToolTurns`
    ([Servers of two versions](./guides/deployment.md#servers-of-two-versions)).

## New and optional

- **`handlers.list`**: the files of a chat at a `GET` route ([Upload handlers](#upload-handlers)).
- **`prepareUpload` returning `dedupe` and `appData`**, and **`UploadedContext.reused`**
  ([Upload handlers](#upload-handlers)).
- **`openAiResponses()`**: OpenAI's Responses API, for reasoning models that call the document
  tools ([The OpenAI Responses API](#the-openai-responses-api)).
- **Page images** for models without PDF input, and **small visual files sent as themselves**
  ([Page images and the files themselves](#page-images-and-the-files-themselves)).

### Page images and the files themselves

Nothing to change. Both are off until an adapter declares them, and the requests of a question
without them are byte for byte those of 0.10.2: the same tool declarations, system text and
capabilities. Only a tool set of your own that returns images sees a change
([Image files from a tool set of your own](#image-files-from-a-tool-set-of-your-own)).

- **A model without PDF input** (vLLM, DeepSeek, most servers behind Chat Completions) can now look
  at pages as images. It needs Node 24, `npm install unpdf@2 @napi-rs/canvas`, and:

  ```ts
  import { openAiCompatible } from "llm-large-files/openai";

  const model = openAiCompatible({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", apiKey: process.env.DEEPSEEK_API_KEY!, imageInput: true });
  ```

  With unpdf 1, which Node 22 runs, each look answers "Showing pages as images needs unpdf 2 or
  later, which runs on Node 24 or later." and the model answers from the text. On Node 22, unpdf 2
  installs with an `EBADENGINE` warning; it drew pages in our test on Node 22.23.5, but neither
  unpdf nor CI supports it.
- **Small visual files as the files themselves**: keep their originals (`keepOriginals: ["pdf"]`,
  and `"pptx"` for decks), then declare what the model reads:

  ```ts
  import { gemini, geminiApi } from "llm-large-files/gemini";

  // On the Gemini API, formats: ["pdf", "pptx"]. On Vertex AI, ["pdf"] only.
  const model = gemini(geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.5-flash-lite" }), { documents: { formats: ["pdf"] } });
  ```

  On Vertex AI list `"pdf"` only: Vertex refused an Office file with HTTP 400 on Gemini 3 models.
  Each such file costs its pages again on every question (about 530 tokens a page on Gemini,
  3,500 on Claude). With an explorer, both models must declare it.
- **An adapter of your own** compiles as it is. Declare `toolFileTypes` or `documents` only once it
  places image tool files and `ModelTextMessage.files` (first in the turn); until then the loop
  sends it neither.
- **A loop of your own**: `ToolOptions.pageImages` gives one image file per page
  (`result.images` names them), and `prepare({ nativeDocuments })` lists in `native` the files to
  send before the text ([Your own tool loop](./guides/pdfs.md#your-own-tool-loop)).

### Question IDs

Nothing to change: question IDs are new and optional, and the requests are the same with and
without them.

- **`AskOptions.questionId`** labels a question for its retries. Every event
  (`EventBase.questionId`) and the result (`AskResult.questionId`) carry it, and nothing of it
  reaches the model.
- **`createQuestionRegistry()`** keeps a request sent again from paying twice: run the question
  through its `ask()` or `askStream()`, with the same `owner`, `scope` and `questionId` on the
  retry. Create one registry per process, at startup
  ([Question IDs](./reference/ask.md#question-ids),
  [When the stream breaks](./guides/web-app.md#when-the-stream-breaks-a-question-id)).
- **A request that joins a running question** gets its events from then on: no `run.start`, and a
  first `seq` above 1. A page that reads such a stream shows `result.text` of `run.finish` in place
  of the text it got.
- **Does my code compile?** Yes. Only a type built from `keyof EventBase` or `keyof AskResult` sees
  a new optional key, `questionId`.


### The OpenAI Responses API

Nothing to change: `openAiCompatible()` sends what it sent in 0.10.2. If you call GPT-5.4 or later
through it with `reasoning_effort: "none"` so that tool calls work, `openAiResponses()` lets the
model reason while it calls the tools:

```ts
import { openAiCompatible, openAiResponses } from "llm-large-files/openai";

const apiKey = process.env.OPENAI_API_KEY!;
// 0.10.x: Chat Completions, tool calls without reasoning.
const before = openAiCompatible({ apiKey, model: "gpt-5.5", contextTokens: 1_050_000,
  body: { reasoning_effort: "none" }, analysisBody: () => ({ reasoning_effort: "low" }) });
// 0.99.9: the Responses API, which reasons while it calls the tools.
const after = openAiResponses({ apiKey, model: "gpt-5.5", contextTokens: 1_050_000,
  body: { reasoning: { effort: "medium" } }, analysisBody: () => ({ reasoning: { effort: "low" } }) });
```

- `body` and `analysisBody` take fields of the Responses API: `reasoning: { effort }` for
  `reasoning_effort`, `max_output_tokens` for `max_completion_tokens`.
- `maxTokensField`, `systemRole`, `answerWithoutTools` and `pdfInput` are not options of
  `openAiResponses()`: part reads send `max_output_tokens`, the system text goes in
  `instructions`, the request for the answer sends `tool_choice: "none"`, and pages go where
  `toolFilePlacement` says (`"none"` by default).
- Errors are `OpenAiRequestError`, as before, and usage fills the same fields.
- Stored rounds (`toolTurns`) need no change: they hold no provider's form, and the rounds of one
  adapter go to the other.
- Azure OpenAI: `baseUrl: "https://{resource}.openai.azure.com/openai/v1"`, `headers: { "api-key": key }`
  or an Entra ID token as `apiKey`, and `model` is the deployment name.
- It has not been run live. Try it on a staging deployment before you move traffic to it
  ([OpenAI's Responses API](./guides/openai-compatible.md#openais-responses-api)).
