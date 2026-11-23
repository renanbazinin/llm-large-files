# `llm-large-files/testing`

New in 0.9.0. This page lists every export of `llm-large-files/testing`: the fakes that the
library's own tests use, for the tests of your application. A scripted model, a `fetch` for the
real adapters, and test documents. How to write the tests is in the guide
[Testing an integration](../guides/testing.md).

```ts
import { calls, fakeFetch, fakeModel, httpError, says, serviceLog, sse, utf8 } from "llm-large-files/testing";
import type { FakeFetch, FakeModel, FakeReply, Scripted, Sent } from "llm-large-files/testing";
// What the signatures below use from the main entry:
import type { GenerateText, ModelAdapter, ModelCapabilities, ModelReply, ModelRequest, SendHooks, ToolCall } from "llm-large-files";
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
| Any field of [`ModelCapabilities`](./ask.md#modelcapabilities) | `toolFiles: "inside"` (as Gemini's), `pageTokens: 500` | The capabilities: `toolFiles: "none"` for a model that takes no files (no `view_pages`), `appendOnly: true` for a model the loop treats as Claude, `contextTokens` and `maxRequestBytes` to make the budget of a question fit a model. |

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
there. For the error classes of the
library, throw [`ModelRequestError`](./errors-and-retries.md#modelrequesterror).

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
