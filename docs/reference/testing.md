# `llm-large-files/testing`

New in 0.9.0. This page lists every export of `llm-large-files/testing`: the fakes that the
library's own tests use, for the tests of your application. A scripted model, a `fetch` for the
real adapters, test documents, and the checks of a store of your own. How to write the tests is in
the guide [Testing an integration](../guides/testing.md).

```ts
import { calls, documentStoreChecks, fakeFetch, fakeModel, httpError, says, serviceLog, sse, utf8 } from "llm-large-files/testing";
import type {
  DocumentStoreCheck, DocumentStoreChecksOptions, FakeFetch, FakeModel, FakeReply, Scripted, Sent, StoreCheckEnvironment, StoreCheckPart,
} from "llm-large-files/testing";
// What the signatures below use from the main entry:
import type { DocumentScope, DocumentStore, GenerateText, ModelAdapter, ModelCapabilities, ModelReply, ModelRequest, SendHooks, ToolCall } from "llm-large-files";
```

The entry point depends on no test framework: it works with Vitest, Jest or `node:test`. It is
code to import in tests, not in your server, but it does nothing when it is loaded.

## Contents

- [A scripted model](#a-scripted-model): [`fakeModel()`](#fakemodelscript-options),
  [`says()`](#saystext-more), [`calls()`](#callslist-more), [`httpError()`](#httperrorstatus-message-retryafterms),
  [`Scripted`](#scripted), [`FakeModel`](#fakemodel)
- [A fetch for the real adapters](#a-fetch-for-the-real-adapters): [`fakeFetch()`](#fakefetchreplies),
  [`sse()`](#sseevents), [`FakeFetch`](#fakefetch), [`FakeReply`](#fakereply), [`Sent`](#sent)
- [Test documents](#test-documents): [`utf8()`](#utf8text), [`serviceLog()`](#serviceloglines)
- [Checking a store](#checking-a-store): [`documentStoreChecks()`](#documentstorechecksoptions),
  [`DocumentStoreChecksOptions`](#documentstorechecksoptions-1), [`StoreCheckEnvironment`](#storecheckenvironment),
  [`DocumentStoreCheck`](#documentstorecheck)

## A scripted model

### fakeModel(script, options?)

```ts
declare function fakeModel(
  script: Scripted[],
  options?: Partial<ModelCapabilities> & { id?: string; generateText?: GenerateText },
): FakeModel;
```

A [`ModelAdapter`](./ask.md#modeladapter) that answers each request with the next entry of
`script`. The last entry repeats, so a script of one entry answers every request the same way.

| Entry | What `send` does |
|---|---|
| A reply (`Partial<ModelReply>`) | Returns it, with `text` `""` and `calls` `[]` where it has none. |
| An `Error` | Throws it, as an adapter throws a request that failed. |
| A function `(request, call, hooks)` | Calls it with the request, its number (1 for the first) and the hooks, and uses what it returns (or resolves to) as above. |

When the loop passes `hooks.onText` (your code set `onText` or `streamText`, or uses `askStream`),
the text of a reply is passed to it in two pieces, as a stream would arrive.

| Option | Default | What it does |
|---|---|---|
| `id` | `"fake-model"` | The model's `id`: its name in `usage.byModel`. Give two fakes different ones. |
| `generateText` | None | The part reader of whole-file reads. Without it, `analyze_whole_document` is not offered. |
| Any field of [`ModelCapabilities`](./ask.md#modelcapabilities) | `toolFiles: "inside"` (as Gemini's), `pageTokens: 500` | The capabilities: `toolFiles: "none"` for a model that takes no files (no `view_pages`), `appendOnly: true` for a model the loop treats as Claude, `contextTokens` and `maxRequestBytes` to make the budget of a question fit a model. Since 0.99.9, `toolFileTypes: ["image/jpeg"]` for a model shown pages as images, and `documents: { formats: ["pdf"] }` for one sent small visual files as they are. |

### says(text, more?)

```ts
declare function says(text: string, more?: Partial<ModelReply>): Partial<ModelReply>;
```

A reply of text. `more` adds fields: `usage`, `finishReason`, `blockReason`.

### calls(list, more?)

```ts
declare function calls(list: ToolCall[], more?: Partial<ModelReply>): Partial<ModelReply>;
```

A reply that calls tools. Its `raw` is `{ own: [the names of the tools] }`: the turn in a
"provider's own form", so that a test can tell where the loop gives that form back to the model.

### httpError(status, message?, retryAfterMs?)

```ts
declare function httpError(status: number, message?: string, retryAfterMs?: number): Error;
```

An `Error` with a `status` (and a `retryAfterMs`, when given), as an adapter of your own may throw
for an HTTP status. The message is `HTTP <status>` by default. The loop sends a request again
after a status worth trying again (408, 409, 429 or 5xx), and waits `retryAfterMs` when it is
there. It has no `kind`: its status, message and a `code` you add give one, as
[`classifyModelError`](./errors-and-retries.md#classifymodelerrorstatus-message-signals) does, and
a 429 of a quota (`code: "insufficient_quota"`) is not sent again (since 0.9.0). A 413, or a 429
"Request too large … tokens per min", is a `"context_overflow"`: the loop makes the request smaller
and sends it again, or plans the documents again, as for a `ModelRequestError` of that kind (since
0.9.0). For the error classes of the library, throw
[`ModelRequestError`](./errors-and-retries.md#modelrequesterror).

### Scripted

```ts
type Scripted =
  | Partial<ModelReply>
  | Error
  | ((request: ModelRequest, call: number, hooks: SendHooks) => Partial<ModelReply> | Error | Promise<Partial<ModelReply> | Error>);
```

One entry of a script.

### FakeModel

```ts
type FakeModel = ModelAdapter & { readonly requests: ModelRequest[] };
```

`requests` holds every request `send` was called with, in order, failed attempts and requests
sent again included. Each is a copy of the request as it was sent, with a copy of its list of
messages, so that what the loop does later does not change it.

## A fetch for the real adapters

### fakeFetch(replies)

```ts
declare function fakeFetch(replies: FakeReply[]): FakeFetch;
```

A `fetch` that answers from a script, without the network. Give its `fetch` to an adapter: the
`fetch` option of `gemini()`, `askGemini()`, `openAiCompatible()` or `anthropic()`. Each request
gets the next reply, and the last one repeats. A `Response` is answered with a copy (its body can
be read only once), and a function is called with the request and its number (1 for the first).
Every request is recorded in `sent`. It throws a `TypeError` when `replies` is empty.

### sse(events)

```ts
declare function sse(events: unknown[]): Response;
```

A streamed reply: Server-Sent Events, one `data:` line for each event, each object written as JSON.
A string is sent as it is (`"[DONE]"`). The `Content-Type` is `text/event-stream`.

### FakeFetch

```ts
type FakeFetch = { fetch: typeof globalThis.fetch; readonly sent: Sent[] };
```

### FakeReply

```ts
type FakeReply = Response | ((sent: Sent, call: number) => Response | Promise<Response>);
```

### Sent

```ts
type Sent = { url: string; method: string; headers: Record<string, string>; body: Record<string, any> };
```

A request as the adapter sent it. `headers` keep the names the adapter wrote (`Authorization`,
`x-api-key`); headers given as a `Headers` object have their names in lower case. `body` is the
body parsed as JSON, typed loosely so that a test reads into it without a cast, and `{}` when
there is no body or it is not JSON.

## Test documents

### utf8(text)

```ts
declare function utf8(text: string): Uint8Array;
```

The bytes of `text` in UTF-8, as `ingest` takes them.

### serviceLog(lines)

```ts
declare function serviceLog(lines: number): string;
```

A service log of `lines` lines of about 90 characters, the same on every call: an `ERROR` line
every 97 lines (97, 194, …), a `WARN` line every 13, and `INFO` lines in between. 400 lines hold 4
errors; 5,000 lines, about 440 KB, hold 51.

## Checking a store

### documentStoreChecks(options)

```ts
declare function documentStoreChecks(options: DocumentStoreChecksOptions): DocumentStoreCheck[];
```

New in 0.9.0. The checks a [`DocumentStore`](./library.md#documentstore) must pass, as a list: each
has a name, a time limit, and a `run` that rejects with an `Error` saying what the store did wrong.
Give each to your test framework:

```ts
// blob-document-store.test.ts (Vitest; Jest takes the same line with `test`)
import { it } from "vitest";
import { documentStoreChecks } from "llm-large-files/testing";
import { BlobDocumentStore } from "./blob-document-store.js";
import { blobsFor, recordsFor, dropStorage } from "./test-storage.js"; // your own: a bucket prefix and a collection per name

const checks = documentStoreChecks({
  create: ({ storage }) => new BlobDocumentStore(blobsFor(storage), recordsFor(storage)),
  dispose: (_store, { storage }) => dropStorage(storage),
});
for (const check of checks) it(check.name, check.run, check.timeoutMs);
```

With `node:test`: `for (const check of checks) test(check.name, { timeout: check.timeoutMs }, check.run);`.
`run` takes no argument, so Jest does not wait for a `done` callback.

What the checks cover:

- `put` and `get` keep the text exactly (CRLF, Hebrew, an emoji, a byte-order mark inside), and
  copy the metadata on the way in and out.
- An unknown ID gives `undefined`, and `delete` gives `false`.
- Fields of the metadata the store does not know are kept: those a later version adds.
- A field left out comes back absent, never `null`: `owner`, `scope` and others.
- An expired document is read without an error: as `undefined`, or as it was, for the library to
  refuse. After `sweep`, it is gone.
- `delete` removes every part, a second one gives `false`, and two at once do not fail. The original
  and the index of a document written only in part are removed too.
- `readTextRange` gives UTF-8 bytes across characters, fewer or none past the end, and `undefined`
  after a delete ("ranges").
- The line index is kept byte for byte, as a copy, the last one written ("index").
- The original is kept byte for byte, as a copy ("originals").
- `sweep(now)` removes the documents expired at `now`, not at the time of day, every part of them
  (the text, the original and the index), and no other ("sweep"). An original or an index the sweep
  left shows when a document is put again under the ID. With `isolatesScopes`, a sweep with a scope
  removes only that scope's.
- The IDs an application may choose ([`APP_DOCUMENT_ID_PATTERN`](./library.md#app_document_id_pattern)).
- Since 0.10.2, when the store has them: `list` gives the documents of a scope, not the deleted
  ones, as copies ("list"); `patchMeta` changes its fields alone, only for the document of that
  `createdAt`, owner and scope, keeps the later expiry, and keeps both of two changes made at once
  ("meta").
- Every method takes a context. Without `requiresScope`, also no context, `{}`, and an owner alone.
- With `requiresScope`: a call without a scope throws a
  [`DocumentScopeError`](./library.md#documentscopeerror) of code `"scope_required"`, and `sweep`
  without one sweeps every scope.
- With `isolatesScopes`: one ID in two scopes is two documents on every method, so the context
  reaches every call, and a document of one scope is missing from another scope and from no scope.
  A wrapper that forwards only the ID fails here.
- Two stores over one storage, as two servers, see each other's writes and deletes ("shared").
  The first store reads the document, the second deletes it, then puts a new one under the ID: the
  first gives `undefined`, then the new text and metadata. A store that keeps what it read, on each
  server, fails here.
- The library over the store, with `wholeDocumentBytes: 0` (every document read by range), gives
  the same metadata, prepared blocks, search and read results, original and delete as over
  `MemoryDocumentStore`.

Each check makes its own store with `create`, over storage of its own (`environment.storage`), and
gives every store it made to `dispose` at the end. The checks pass a scope (and an owner) on most
calls. A check a patch release adds runs only for a method the store did not have before (0.10.2:
`list` and `patchMeta`, checked only when the store has them, and for a subclass of a built-in store
with its own `put`, `get`, `getMeta` or `delete` only when it has its own), so a patch release never
fails a store that passed.

### `DocumentStoreChecksOptions`

```ts
type StoreCheckPart = "originals" | "ranges" | "index" | "sweep" | "shared" | "list" | "meta"; // "list", "meta": new in 0.10.2

type DocumentStoreChecksOptions = {
  create(environment: StoreCheckEnvironment): DocumentStore | Promise<DocumentStore>;
  dispose?(store: DocumentStore, environment: StoreCheckEnvironment): void | Promise<void>;
  isolatesScopes?: boolean;
  requiresScope?: boolean;
  scopeDepth?: number;
  skip?: readonly StoreCheckPart[];
};
```

| Field | Default | What it does |
|---|---|---|
| `create` | Required | Makes a new store over new, empty storage named by `environment.storage`. Called again with the same name, it gives a second store over the same storage, as a second server opens it. Give the store `environment.now` as its clock, if it has one. |
| `dispose` | None | Called at the end of each check for each store it made: close it, and remove its storage. |
| `isolatesScopes` | `false` | The store keeps the documents of each scope apart, as `MemoryDocumentStore` and a scoped `FileDocumentStore` do. Adds the checks of scopes. Leave it false for a store that ignores the context: the library then keeps scopes apart by `meta.scope`. |
| `requiresScope` | `false` | The store refuses a call without a scope, as a `FileDocumentStore` with `scopes` does. The checks then always pass one, and one more checks the refusal. |
| `scopeDepth` | `2` | How many segments the scopes of the checks have, from 1 to 8: `["user-1", "chat-a"]` with 2. |
| `skip` | `[]` | The parts the store does not have: `"originals"` (`putOriginal` and `getOriginal`), `"ranges"` (`readTextRange`), `"index"` (`putIndex` and `getIndex`), `"sweep"`, and `"shared"` for storage two stores cannot share (`MemoryDocumentStore`). A check of a part the store lacks, not skipped, fails and says to skip it. Since 0.10.2, `"list"` (`list`) and `"meta"` (`patchMeta`): those are checked only when the store has them, so a store written for 0.10.1 passes as before; `skip` leaves them out for a store that has them. |

`documentStoreChecks` throws a `TypeError` without `create`, or for a `scopeDepth` outside 1 to 8.

### `StoreCheckEnvironment`

```ts
type StoreCheckEnvironment = {
  readonly now: () => Date;
  readonly storage: string;
  readonly scopes: readonly DocumentScope[];
};
```

| Field | What it holds |
|---|---|
| `now` | The clock of the check: the time it started, rounded down to a second. A check may move it forward. |
| `storage` | A name for the storage of the store, of lowercase letters, digits and `-`, new for each check: a folder, a key prefix, a collection. |
| `scopes` | The two scopes the checks use, `scopeDepth` lowercase segments each, which pass `isSafeScopeSegment`. Make their place first when your store needs it, as for the folders of a `FileDocumentStore` without `createScopeFolders`. |

### `DocumentStoreCheck`

```ts
type DocumentStoreCheck = {
  readonly name: string;
  readonly timeoutMs: number;
  readonly run: () => Promise<void>;
};
```

| Field | What it holds |
|---|---|
| `name` | What the store must do, as a sentence: the name of the test. |
| `timeoutMs` | The time the check may take: 10 s, and 30 s for the check through the library. |
| `run` | Runs the check. It resolves when the store passes, and rejects with an `Error` whose message starts "The store failed the check:" and says what was expected and what came back. When the store throws, the message names the call and its arguments, such as `readTextRange("check-delete", 0, 4, {…})`, and the error the store threw is its `cause`. An error that `create` or `dispose` throws is named after them, and any other after the check. |

How the library's own tests run them on `MemoryDocumentStore` and `FileDocumentStore`, and what to
check by hand besides (a database that is down, writes that fail), is in
[Storage](../guides/storage.md#checking-your-store).
