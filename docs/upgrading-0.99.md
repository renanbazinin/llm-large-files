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

Most code does. A call without an owner compiles, and throws at run time: see
[Owner checks are on by default](#owner-checks-are-on-by-default). These do not compile:

| Code of yours | The error | What to write |
|---|---|---|
| A mock typed `CreatedLargeFiles` or `ReturnType<typeof createLargeFiles>` without `list`, `touch` and `update` (TS2739) | They are required members since 0.99.9 | Add them, or type the mock `LargeFiles`, whose members they stay optional on |
| A `DocumentHandlers` made by hand, such as a mock (TS2741) | `list` is required | Add `list`, or type the mock as the part you use |

<!-- shapes: AskOptions.inlineTables / numberInline and ModelAdapter.estimateTokens removed: rows
of the table above. -->

Code that compiles and still needs a look:

- **`files.list!(…)`, `files.touch!(…)` and `files.update!(…)`** compile as before; the `!` can go.
- **A `LargeFiles` of your own handed to `createDocumentHandlers`** without `access` counts as
  requiring an owner: it throws a `TypeError` without `getOwner`. Give `getOwner`, or pass
  `access: { requireOwner: false, requireScope: false }` on it.
- **A `LargeFiles` of your own whose `ingest` returns a copy** of the metadata its library gave
  loses the mark of a document `dedupe` gave back: the upload handlers then take it for a new one,
  and delete it when `onUploaded` throws, as in 0.10.2. Return the object `ingest` gave.

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

<!-- shapes: inlineTables: "text", numberInline: false, ModelAdapter.estimateTokens; what a JS
caller that still passes them gets. -->

### The way back to 0.9's text

<!-- shapes -->

## Stored documents and rounds

<!-- shapes: what 0.99.9 reads (every shape stored since 0.2), what each later version promises
(the shape before its own), the error for a newer shape. -->

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

## Rolling deploys

While servers of 0.10 and 0.99.9 share a store, set `requireOwner` explicitly on both if your
application ever ingests without an owner. A 0.10 server checks no owner by default, and a 0.99.9
server reads a document stored without one as missing: a chat answered by both in turn would find
its files on one and not on the other. Once every server runs 0.99.9, the setting can go back to
the default. An application that passes owners on every call needs nothing.

<!-- shapes: servers of 0.10 and 0.99.9 on one store (stored shapes). -->

## New and optional

- **`handlers.list`**: the files of a chat at a `GET` route ([Upload handlers](#upload-handlers)).
- **`prepareUpload` returning `dedupe` and `appData`**, and **`UploadedContext.reused`**
  ([Upload handlers](#upload-handlers)).
<!-- responses: openAiResponses() (#the-openai-responses-api), not run live. -->
<!-- visual: page images for models without PDF input; small visual files sent as themselves. -->
<!-- questions: question IDs (AskOptions.questionId, createQuestionRegistry). -->
<!-- aisdk: llm-large-files/ai-sdk; examples for LangChain.js/LangGraph, the OpenAI Agents SDK, Google ADK. -->
<!-- MCP (removable): llm-large-files/mcp, one entry. -->
