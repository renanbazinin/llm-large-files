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
unpdf, @cantoo/pdf-lib unchanged; new: ai for llm-large-files/ai-sdk, @modelcontextprotocol/server
for llm-large-files/mcp, @napi-rs/canvas for page images); eight entry points. -->

- **What a store holds is unchanged.** `DocumentMeta` keeps `metaVersion: 1`, `ToolTurn` keeps
  `version: 1`, and the files of `FileDocumentStore` keep their names and format. Servers of 0.10.x
  and 0.99.9 read what the other stores. Documents and rounds stored before 0.9.0, without a
  version, are read as before ([Stored documents and rounds](#stored-documents-and-rounds)).

## Does my code compile?

<!-- owner: CreatedLargeFiles list/touch/update required (mocks); the handlers' getOwner rule.
Rows in the table below, "Code of yours | The error | What to write", as in upgrading-0.10.md. -->

| Code of yours | The error | What to write |
|---|---|---|
| `inlineTables` or `numberInline` in the options of `askWithFiles` or `askGemini` (TS2353), or `Pick<AskOptions, "inlineTables" \| "numberInline">` (TS2344) | Both options were removed | Delete them. Tables sent whole always get the tools, and files sent whole are always numbered ([The way back to 0.9's text](#the-way-back-to-09s-text)) |
| An adapter object typed `ModelAdapter` that has `estimateTokens` (TS2353) | `ModelAdapter.estimateTokens` was removed | Delete it. Set `capabilities.tokenScale` for a model that counts tokens differently |

Code that compiles and still needs a look:

- **Options spread in from another object, or code in JavaScript:** `inlineTables: "text"`,
  `numberInline: false` or any value but `"tools"` and `true` is a `TypeError` before any request.
- **A class that implements `ModelAdapter` with an `estimateTokens` method** compiles. The loop
  never called it, and does not now.

## Owner checks are on by default

<!-- owner: both paths (pass owners; requireOwner: false), documents stored without an owner, the
new TypeError text, createDocumentHandlers and getOwner, tests of your own. -->

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

<!-- owner: dedupe and appData from prepareUpload, UploadedContext.reused, the list route. -->

## Behavior to check

<!-- every package: behavior that changed without a compile error. -->

### Readers of stored rounds refuse a newer round

`geminiToolTurns`, `openAiToolTurns`, `anthropicToolTurns` and `compactToolTurns` throw the
`TypeError` of `askWithFiles` for a round whose `version` is above `TOOL_TURN_VERSION` (1). They
converted it as a round of version 1. No round that 0.99.9 or an earlier version stored is refused.

**Who:** apps that convert stored rounds while servers of a newer version answer the same chats.
**What to do:** nothing for 0.99.9 ([Stored documents and rounds](#stored-documents-and-rounds)).

## Rolling deploys

<!-- owner: owner checks during a rollout. -->

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

<!-- responses: openAiResponses() (#the-openai-responses-api), not run live. -->
<!-- visual: page images for models without PDF input; small visual files sent as themselves. -->
<!-- questions: question IDs (AskOptions.questionId, createQuestionRegistry). -->
<!-- aisdk: llm-large-files/ai-sdk; examples for LangChain.js/LangGraph, the OpenAI Agents SDK, Google ADK. -->
<!-- MCP (removable): llm-large-files/mcp, one entry. -->
