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
for llm-large-files/mcp, @napi-rs/canvas for page images); eight entry points; what a store holds. -->

## Does my code compile?

<!-- owner: CreatedLargeFiles list/touch/update required (mocks); the handlers' getOwner rule.
shapes: AskOptions.inlineTables / numberInline and ModelAdapter.estimateTokens removed. A table
"Code of yours | The error | What to write", as in upgrading-0.10.md. -->

## Owner checks are on by default

<!-- owner: both paths (pass owners; requireOwner: false), documents stored without an owner, the
new TypeError text, createDocumentHandlers and getOwner, tests of your own. -->

## Removed options

<!-- shapes: inlineTables: "text", numberInline: false, ModelAdapter.estimateTokens; what a JS
caller that still passes them gets. -->

### The way back to 0.9's text

<!-- shapes -->

## Stored documents and rounds

<!-- shapes: what 0.99.9 reads (every shape stored since 0.2), what each later version promises
(the shape before its own), the error for a newer shape. -->

## Upload handlers

<!-- owner: dedupe and appData from prepareUpload, UploadedContext.reused, the list route. -->

## Behavior to check

<!-- every package: behavior that changed without a compile error. -->

### Performance budgets in CI

Nothing to change. CI now holds ingest and search to bars of time and memory on every pull request
([Performance budgets](./measurements.md#performance-budgets-0999)). The package, its defaults and
the requests it sends are not changed by it: `npm run perf` is a script of the repository, not of
the package.

## Rolling deploys

<!-- owner and shapes: servers of 0.10 and 0.99.9 on one store; owner checks during a rollout. -->

## New and optional

<!-- responses: openAiResponses() (#the-openai-responses-api), not run live. -->
<!-- visual: page images for models without PDF input; small visual files sent as themselves. -->
<!-- questions: question IDs (AskOptions.questionId, createQuestionRegistry). -->
<!-- aisdk: llm-large-files/ai-sdk; examples for LangChain.js/LangGraph, the OpenAI Agents SDK, Google ADK. -->
<!-- MCP (removable): llm-large-files/mcp, one entry. -->
