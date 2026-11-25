# `llm-large-files/anthropic`

This page lists every export of `llm-large-files/anthropic` with its options, defaults, return
values and errors: the `anthropic()` adapter for Claude through the Messages API, the API version
it is written for, its error class, and the converters for a history kept as Messages API
messages. How to set Claude up, and what its append-only conversation means for your application,
is in the guide [Claude](../guides/anthropic.md).

```ts
import { anthropic, ANTHROPIC_VERSION, anthropicToolTurns, AnthropicRequestError, fromAnthropicMessages } from "llm-large-files/anthropic";
import type { AnthropicMessage, AnthropicOptions } from "llm-large-files/anthropic";
// What the signatures below use from the main entry:
import { ModelRequestError } from "llm-large-files";
import type { ChatMessage, ModelAdapter, ModelErrorKind, ToolTurn } from "llm-large-files";
```

The entry point needs no Anthropic SDK: it posts JSON to the Messages URL with `fetch`, signed in
with a key or a token, or through a gateway that speaks the same API.

## Contents

- [The model adapter](#the-model-adapter): [`anthropic()`](#anthropicoptions),
  [`AnthropicOptions`](#anthropicoptions-1), [`ANTHROPIC_VERSION`](#anthropic_version)
- [Errors](#errors): [`AnthropicRequestError`](#anthropicrequesterror)
- [Messages API messages](#messages-api-messages): [`AnthropicMessage`](#anthropicmessage),
  [`fromAnthropicMessages()`](#fromanthropicmessageshistory),
  [`anthropicToolTurns()`](#anthropictoolturnsturns)

## The model adapter

### anthropic(options)

```ts
declare function anthropic(options: AnthropicOptions): ModelAdapter;
```

A Claude model, as a [`ModelAdapter`](./ask.md#modeladapter) for
[`askWithFiles`](./ask.md#askwithfilesoptions): the model that answers, or the `explorer`. It makes
no request when it is created and throws nothing. The options are in
[`AnthropicOptions`](#anthropicoptions-1).

The adapter it returns:

| Member | Value |
|---|---|
| `id` | `options.id`, else `options.model`. It names the model in `usage.byModel` and in messages. |
| `capabilities` | `maxRequestBytes` 32,000,000; `toolFiles` from `toolFilePlacement` (`"inside"`); `pageTokens` 3,500; `tokenScale` 1.35; `outputTokens` equal to `maxTokens` (64,000); `appendOnly: true`; `contextTokens` only when you set it; `clearsToolResults: true` only when `body.context_management.edits` holds an edit whose `type` starts with `clear_tool_uses` or `compact` (new in 0.6.0). Each value but `appendOnly` comes from an option: `toolFiles` from `toolFilePlacement`, `outputTokens` from `maxTokens`, `clearsToolResults` from `body`, the others from the option of the same name. See [`ModelCapabilities`](./ask.md#modelcapabilities). |
| `send(request, hooks?)` | One chat request, described below. |
| `requestBytes(request)` | The size in bytes of the JSON body that `send` would post. |
| `generateText` | The part reader of whole-file reads, described below. With it, `analyze_whole_document` can be offered when this adapter is the model that uses the tools (the explorer, when there is one), unless `wholeDocumentAnalysis` is `false`. |

`appendOnly: true` tells the loop that Claude's conversation may only grow: Claude checks its
thinking blocks against the conversation they were written in, so an earlier turn that is rewritten
makes the request invalid. The loop then never shortens old tool results to make room; when the
room runs out, the question is answered with what it has.

`clearsToolResults: true` tells the loop that Claude may clear old tool results on its side, with
context editing (`clear_tool_uses`) or compaction, before it reads the request. The loop then
answers no call made again with a pointer to an earlier result: each runs again. `clear_thinking`
alone changes nothing.

**Where it posts.** Every request goes to `url`, or to `baseUrl` (default
`https://api.anthropic.com`, trailing slashes removed) followed by `/v1/messages`. Its headers are:

- `Content-Type: application/json`;
- `anthropic-version`: `version`, default [`ANTHROPIC_VERSION`](#anthropic_version);
- `anthropic-beta`, when there is any: the values of `betas`, and `server-side-fallback-2026-07-01`
  when `fallbacks` is set, each once, joined by commas;
- `x-api-key` when `apiKey` gives a non-empty string, and `Authorization: Bearer {authToken}` when
  `authToken` does;
- then `headers`, which can replace any of them.

`apiKey`, `authToken` and `headers` are resolved before every request, chat requests and part
reads alike, so a function can return a renewed key or token.

**The body of a chat request**, in this order, a later field replacing an earlier one:

- `model` and `max_tokens` (`maxTokens`).
- `system`, when the system instruction is not empty.
- `messages`.
- `tools`, each as `{ name, description, input_schema }`, when the request offers tools, with
  `eager_input_streaming: true` on each when the request is streamed and `eagerInputStreaming` is
  on. A request that must be answered in text keeps the tools and adds
  `tool_choice: { type: "none" }`: Claude ties its thinking to the tools of the conversation.
- `stream: true`, when the request is streamed.
- `cache_control: { type: "ephemeral" }`, with `ttl: "1h"` for `cache: "1h"`, unless
  `cache: false`.
- `fallbacks`, when set.
- Every field of `body`.

No `temperature` or other sampling field is sent. `body` would send one, but the API version in
`ANTHROPIC_VERSION` refuses `temperature`: see [Claude](../guides/anthropic.md).

**The conversation in the request.**

- A turn of text becomes content blocks: `{ type: "text", text }` for each text part that is not
  empty (the API refuses an empty text block), and each native part as it is. Turns of the same role
  that follow each other are made one message, and a turn left with no blocks is dropped.
- A model turn of this question goes back as it came, thinking blocks and their signatures
  included. Two kinds of block are left out of it: an empty text block (one a stream opened and
  closed with nothing in it, which the API refuses) that no thinking block follows, and, in a reply
  that has a `fallback` block, the thinking and tool-use blocks before the last `fallback` (those of
  the model that declined).
- A stored tool round (the `toolTurns` of an earlier question, or a round of another adapter)
  becomes an assistant turn of `{ type: "tool_use", id, name, input }` blocks. Its call IDs are made
  to fit the API: each character other than `A-Z`, `a-z`, `0-9`, `_` and `-` becomes `_`; a call
  without an ID is given `toolu_{round}_{n}`; an ID already used earlier in the request gets `_2`,
  `_3` and so on. The IDs of Claude's own turns are kept as they are.
- The results follow in one user turn of `{ type: "tool_result", tool_use_id, content }` blocks,
  `content` being the result as JSON, with `is_error: true` when the result is an error. With
  `toolFilePlacement` `"inside"`, the pages of `view_pages` are `document` blocks inside the
  `tool_result`, after its JSON. With `"beside"`, they come after all the results of the turn, each
  after a text block `"{file name} (returned by view_pages):"`.

**Streaming.** Every chat request is streamed unless `stream` is `false`, whether `onText` is given
or not: the explorer's requests too. Each piece of text goes to `onText` as it arrives.

- A response of type `text/event-stream` is read as events. A response of another type, or of none,
  is read by its first characters (since 0.6.0): as events when it starts like them (`data:`,
  `event:`, `id:`, `retry:` or a comment), whole otherwise, as a gateway that answered without
  streaming sends it. `onText` then gets its text at once. A body that starts with more than 65,536
  characters of white space is read whole.
- `message_stop` ends the reply. A gateway that then leaves the connection open is read for one
  more second at most, and the body is cancelled, which closes the connection; a connection that
  breaks after `message_stop` keeps the reply too. 0.5.0 waited for such a connection to close,
  and failed a request whose connection broke after `message_stop` with status 0, with the whole
  answer already shown.

**The reply** ([`ModelReply`](./ask.md#modelreply)):

- `text` is the text of the `text` blocks. Thinking is not part of it.
- `calls` are the `tool_use` blocks, those after the last `fallback` block when there is one, with
  their `input` as `args` (`{}` when it is not an object). In a stream, input whose pieces do not
  make a JSON object gives the call a `problem` (the loop answers it with that message instead of
  running it, and the model can send it again), and a tool-use block whose stream never closed gets
  "This call did not arrive whole, and was not run. Send it again.". When
  `stop_reason` is `"max_tokens"`, every call gets a `problem` that says it was cut off at the output
  limit. A reply with `stop_reason` `"refusal"` has no calls.
- `raw` is the content as it goes back (see above). Thinking, signatures and citations are kept.
- `finishReason` is `stop_reason`. `finish` is `"complete"` for `end_turn`, `tool_use` and
  `stop_sequence`; `"cut"` for `max_tokens` and `model_context_window_exceeded`; `"filtered"` for
  `refusal`.
- `blockReason` is `"refusal"` for a refusal, followed by `": {category}"` when the API gives
  `stop_details.category`. A question whose reply was refused ends with `answered: false`, even when
  some text had streamed.
- `usage`: `inputTokens` is `input_tokens` + `cache_creation_input_tokens` +
  `cache_read_input_tokens`, the whole prompt; `cachedInputTokens` is `cache_read_input_tokens`;
  `outputTokens` is `output_tokens`; `thoughtTokens` stays 0, as the adapter reads no count of
  thinking apart. With fallbacks, the attempts in `usage.iterations` are added up. `providerUsage`
  is the API's `usage` as it came; in a stream, that of `message_start` updated by `message_delta`.
- `responseId` and `responseModel` are the message's `id` and `model` (in a stream, those of
  `message_start`), when the API gives them. New in 0.10.0.

**Part reads** (`generateText`, for `analyze_whole_document`) go to the same URL with the same
headers and are never streamed. The body is `model`, `max_tokens` (the limit of that read),
`system`, one user message, then the fields of `analysisBody(limit)`: no `body`, no
`cache_control`, no `fallbacks`, no tools. Each request may take `timeoutMs` (180 s; 0 for none,
since 0.10.0). A reply that
stopped for `refusal` or `model_context_window_exceeded` is kept and marked incomplete, as one cut
off at its limit is. A reply cut off with nothing written, or with half its limit or more spent
thinking, while the limit was below 32,768, is asked again with 32,768 output tokens
([`THINKING_OUTPUT_TOKENS`](./gemini.md#thinking_output_tokens)), and later part reads to the same
URL and model start there. Claude does not count its thoughts apart: when the reply has thinking
blocks, its thoughts are taken as its `output_tokens` less its text, estimated with `tokenScale`
(new in 0.6.0: 0.5.0 counted none, so a part that thought most of its limit away came back cut,
with the little text it wrote). A model that refuses that limit with HTTP 400 is not asked for it again. A
refusal of the request as too large for the model's window is not taken for that (since 0.6.0): it
turns the larger limit off only when the window it names is 32,768 tokens or less.

**Errors.** `send` throws, and does not send anything again itself:
[`askWithFiles`](./ask.md#askwithfilesoptions) decides what is retried
([`RetryOptions`](./errors-and-retries.md#retryoptions)).

| Case | Error | `status` | `kind` |
|---|---|---|---|
| The API answered with an HTTP error | [`AnthropicRequestError`](#anthropicrequesterror) with the body's `error.message`, else "Claude returned HTTP {status}." (for example "Claude returned HTTP 529."). With `type` (the body's `error.type`) and `retryAfterMs` when the API gave them. A spending cap of the organization (HTTP 429 with `error.details.error_code` `enforced_spend_limit_reached`) has kind `"quota"` (since 0.6.0; it was sent again three times). A response with the header `x-should-retry: false` is not sent again, whatever its status, as Anthropic's own SDKs do (since 0.6.0). | The HTTP status | Told from the status, the message and `type` |
| An `error` event inside the stream | `AnthropicRequestError` with its message, else "Claude reported an error.", and its `type` | From its `type`: `overloaded_error` 529, `rate_limit_error` 429, `api_error` 500, `timeout_error` 408, and since 0.6.0 `invalid_request_error` 400, `authentication_error` 401, `billing_error` 402, `permission_error` 403, `not_found_error` 404, `request_too_large` 413. Any other type, or none: 500, sent again when none of the reply was shown (in 0.5.0, the response's 200, not sent again) | Told from the status, the message and `type` |
| The connection failed, before or while the reply arrived, or an event of the stream was not JSON | `AnthropicRequestError`: "Claude could not be reached (fetch failed).", the reason being the HTTP client's message | 0 | `"unreachable"` |
| A reply of HTTP 200 whose body is empty | `AnthropicRequestError`: "Claude could not be reached (the reply was empty).", new in 0.6.0. When the reply's type is `text/event-stream`, "Claude's reply ended before it was complete." Either is sent again as a reply cut off on its way. | 0 | `"unreachable"` |
| Nothing arrived for a whole wait (`firstByteTimeoutMs`, `idleTimeoutMs`) | `AnthropicRequestError`: "Claude sent nothing for {seconds} s.", the wait that ran out (600 s or 300 s by default) | 0 | `"timeout"` |
| A stream that closed with no `stop_reason` | `AnthropicRequestError`: "Claude's reply ended before it was complete." | 0 | `"unreachable"` |
| A reply whose body is not JSON (a gateway's HTML page) | `AnthropicRequestError`: "Claude's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.", the brackets holding the response's media type (left out when it has none), with the `SyntaxError` as `cause`. Not sent again. Until 0.6.0, the `SyntaxError` itself. | The response's, 200 | `"invalid"` |
| An event of the stream longer than 64,000,000 characters | `AnthropicRequestError`: "Claude's reply could not be read: an event of its stream held more than 64,000,000 characters." Not sent again. New in 0.6.0. | The response's, 200 | `"invalid"` |
| `hooks.signal` aborted | The signal's reason, as it is | none | none |

A part read throws as `send` does for an HTTP error, a connection that failed, an empty body, an
abort and a body that is not JSON. It has no waits of `firstByteTimeoutMs` and `idleTimeoutMs`;
instead, a request that ran past `timeoutMs` throws an `AnthropicRequestError` "Claude took longer
than 180 s to answer.", status 0, kind `"timeout"` (since 0.10.0; before, the error of its abort, a
`TimeoutError` with no status), which a whole-file read sends again once. A reply with no text
throws `Error("The model returned no text (refusal).")`, the reason in brackets being
`stop_reason`; it has no `status`. In a whole-file read, the model is told why a part failed by the
error's kind and status, never by the API's message: "The model took too long to answer." for a
timeout, "The model returned no text (refusal)." for a reply with no text
(see [`analyze_whole_document`](./tools.md#analyze_whole_document)).

```ts
import { askWithFiles } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";

// files, documentIds, messages and userId (their owner) come from your application.
const model = anthropic({
  model: "claude-opus-5-5",
  apiKey: process.env.ANTHROPIC_API_KEY!,
  contextTokens: 1_000_000, // set this to your model's context window
  cache: "1h",              // follow-up questions within the hour read the cached prompt
});

const result = await askWithFiles({
  files,
  model,
  owner: userId,
  documentIds,
  messages,
  onText: (delta) => process.stdout.write(delta),
});
if (result.blockReason) console.log(`Refused: ${result.blockReason}`);
```

Guide: [Claude](../guides/anthropic.md): the window, thinking and effort, caching, fallbacks,
gateways and hosts other than the Claude API, and Claude next to Gemini. A second model that
explores while Claude answers: [explorer model](../guides/explorer-model.md).

### `AnthropicOptions`

```ts
type AnthropicOptions = {
  model: string;
  apiKey?: string | (() => string | Promise<string>) | undefined;
  authToken?: string | (() => string | Promise<string>) | undefined;
  baseUrl?: string | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  version?: string | undefined;
  betas?: string[] | undefined;
  maxTokens?: number | undefined;
  body?: Record<string, unknown> | undefined;
  analysisBody?: ((maxOutputTokens: number) => Record<string, unknown>) | undefined;
  fallbacks?: "default" | Array<Record<string, unknown> & { model: string }> | undefined;
  cache?: boolean | "5m" | "1h" | undefined;
  toolFilePlacement?: "inside" | "beside" | "none" | undefined;
  stream?: boolean | undefined;
  eagerInputStreaming?: boolean | undefined;
  contextTokens?: number | undefined;
  maxRequestBytes?: number | undefined;
  pageTokens?: number | undefined;
  tokenScale?: number | undefined;
  timeoutMs?: number | undefined;
  firstByteTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  id?: string | undefined;
  fetch?: typeof fetch | undefined;
};
```

The options of [`anthropic()`](#anthropicoptions).

| Option | Type | Default | What it does |
|---|---|---|---|
| `model` | `string` | required | The model ID, sent as `model` in every chat request and part read: `"claude-opus-5-5"`. |
| `apiKey` | `string \| (() => string \| Promise<string>)` | none | Sent as `x-api-key`. A function is called before every request. An empty string sends no header. |
| `authToken` | `string \| (() => string \| Promise<string>)` | none | Sent as `Authorization: Bearer {token}`, for an OAuth token or a gateway. A function is called before every request. |
| `baseUrl` | `string` | `"https://api.anthropic.com"` | The base of the API. Trailing slashes are removed and `/v1/messages` is added. Not used when `url` is set. |
| `url` | `string` | `baseUrl` + `/v1/messages` | The whole Messages URL, used as it is. Its host also sets the default of `eagerInputStreaming`. |
| `headers` | `Record<string, string> \| (() => Record<string, string> \| Promise<Record<string, string>>)` | none | More headers, merged last: they can replace any header the adapter writes. A function is called before every request. |
| `version` | `string` | [`ANTHROPIC_VERSION`](#anthropic_version), `"2026-10-21"` | The `anthropic-version` header. |
| `betas` | `string[]` | none | Values for the `anthropic-beta` header, such as the beta that a `context_management` field in `body` needs. |
| `maxTokens` | `number` | `64_000` | `max_tokens` of every chat request: the most Claude may write, thinking included. Cut to a whole number, at least 1. It is also `capabilities.outputTokens`: it comes out of the context window, so the budget of a question keeps it free. Part reads send their own limit instead. |
| `body` | `Record<string, unknown>` | none | More fields for the body of every chat request: `thinking`, `output_config`, `context_management`, `metadata`. Spread last, so a field here replaces the adapter's own; a field set to `undefined` is left out of the JSON. Not sent with part reads. |
| `analysisBody` | `(maxOutputTokens: number) => Record<string, unknown>` | none | More fields for the body of each part read, given the `max_tokens` that request is sent with. Spread last. |
| `fallbacks` | `"default" \| Array<Record<string, unknown> & { model: string }>` | none | Have another model answer when this one's safety classifiers decline a request: `"default"`, or a list of `{ model }`. It adds the `fallbacks` field and the beta `server-side-fallback-2026-07-01`. Off unless set: it is offered on the Claude API, not on Amazon Bedrock, Vertex AI or Microsoft Foundry, and not for every model. |
| `cache` | `boolean \| "5m" \| "1h"` | `true` | Prompt caching: a top-level `cache_control`, which caches the request up to its last block, so each request of the tool loop, and a follow-up question, reads what the one before wrote. `true` and `"5m"` send `{ type: "ephemeral" }`, which the API keeps five minutes; `"1h"` adds `ttl: "1h"`; `false` sends none. Part reads are not cached. |
| `toolFilePlacement` | `"inside" \| "beside" \| "none"` | `"inside"` | Where the pages of `view_pages` go: `"inside"` the tool result as `document` blocks; `"beside"` it, after the tool results of the turn; `"none"` sends no file, and `view_pages` is then not offered to any model of the question. It is `capabilities.toolFiles`. |
| `stream` | `boolean` | `true` | Stream every chat request, which keeps a long reply from timing out. `false` for a gateway without streaming. Part reads are never streamed. |
| `eagerInputStreaming` | `boolean` | `true` when the host of the URL is `api.anthropic.com`, else `false` | Set `eager_input_streaming: true` on each tool of a streamed request, so that tool input arrives as it is written. Off by default for any other URL, which may refuse the field. Never sent when `stream` is `false`. |
| `contextTokens` | `number` | none | The model's context window in tokens. Set as `capabilities.contextTokens`, it keeps the budget of a question within it. Without it the library's budget holds: 1,000,000 tokens unless you set another. |
| `maxRequestBytes` | `number` | `32_000_000` | The largest request body in bytes, the limit of the Claude API (32 MB). It keeps the budget within it. |
| `pageTokens` | `number` | `3_500` | Tokens billed for one PDF page shown by `view_pages`: its text and its picture. The loop sizes the pages a question may look at from it. |
| `tokenScale` | `number` | `1.35` | Claude's tokens for one token of the library's estimate, which is fitted to Gemini: documents are planned for a window that much smaller. 1.35 is a cautious guess for the tokenizer of the current models; during a question, the token count the API reports with each reply corrects the estimate. |
| `timeoutMs` | `number` | `180_000` | The longest a part read's request may take, in milliseconds, each try counted apart. A request that runs longer is aborted, and is an `AnthropicRequestError` of kind `"timeout"` and status 0 (since 0.10.0). 0 sets no limit (since 0.10.0; before, it aborted every part read at once). Not used for chat requests. |
| `firstByteTimeoutMs` | `number` | `600_000` | The longest wait, in milliseconds, for the first piece of a chat reply. Headers do not count: a model that thinks sends nothing until it has thought, and a reply that is not streamed comes whole at the end. A request that gets nothing for that long is aborted with an `AnthropicRequestError` (`status` 0, `kind` `"timeout"`), which `askWithFiles` sends again once. 0, a negative or a non-finite number waits without end. The key, token and headers are resolved before the wait starts. Not used for part reads. |
| `idleTimeoutMs` | `number` | `300_000` | The longest wait, in milliseconds, between two pieces of a chat reply once it has started to arrive. Any bytes count, Claude's `ping` events included. The same error; `askWithFiles` sends the request again once, unless text of it was shown. 0 waits without end. Not used for part reads. |
| `id` | `string` | `model` | The name of the model in `usage.byModel` and in messages. |
| `fetch` | `typeof fetch` | the global `fetch` | Used for chat requests and part reads: a proxy, logging, tests. |

The two waits default to [`DEFAULT_FIRST_BYTE_TIMEOUT_MS`](./errors-and-retries.md#default_first_byte_timeout_ms)
and [`DEFAULT_IDLE_TIMEOUT_MS`](./errors-and-retries.md#default_idle_timeout_ms). What to set
them to: [errors and reliability](../guides/errors-and-reliability.md). How `contextTokens`,
`maxTokens` and `tokenScale` shape the room of a question: [Claude](../guides/anthropic.md) and
[costs and limits](../guides/costs-and-limits.md). Pages: [PDFs](../guides/pdfs.md).

### `ANTHROPIC_VERSION`

```ts
const ANTHROPIC_VERSION = "2026-10-21";
```

The version of the Messages API that the adapter's requests and its reading of replies are written
for. It is the default of `version`, sent as the `anthropic-version` header.

## Errors

### `AnthropicRequestError`

```ts
declare class AnthropicRequestError extends ModelRequestError {
  readonly type?: string;
  constructor(message: string, status: number, options?: {
    retryAfterMs?: number;
    cause?: unknown;
    kind?: ModelErrorKind;
    code?: string | undefined;
    details?: unknown;
    type?: string;
  });
}
```

A request to Claude that failed: the API answered with an HTTP error, or could not be reached
(`status` 0). It is a [`ModelRequestError`](./errors-and-retries.md#modelrequesterror), so code
that handles every provider through `ModelRequestError` and `kind` needs no case of its own for it.
The table under [`anthropic()`](#anthropicoptions) lists when the adapter throws one.

| Field | Type | What it holds |
|---|---|---|
| `name` | `string` | `"AnthropicRequestError"`. |
| `message` | `string` | The API's own message, or one of the adapter's (see the table above). It is the provider's text: log it, and do not show it to your users as it is. |
| `status` | `number` | The HTTP status, or the status of an `error` event in the stream; 0 when no answer came; 200 for a reply that came and could not be read. |
| `kind` | [`ModelErrorKind`](./errors-and-retries.md#modelerrorkind) | What went wrong, told from `status`, the message and `type`: `type` `"request_too_large"` with a 4xx status makes it `"context_overflow"`, an `overloaded_error` (529) `"server"`, a `rate_limit_error` (429) `"rate_limit"`. "Your credit balance is too low" (HTTP 400) and the spending limits ("You have reached your API usage limits", HTTP 400, or HTTP 429 with `enforced_spend_limit_reached`) make it `"quota"`. The adapter sets `"timeout"` itself for a wait that ran out, and `"invalid"` for a reply of HTTP 200 it could not read. New in 0.6.0. |
| `retryAfterMs` | `number \| undefined` | The wait the API asked for: its `retry-after-ms` or `Retry-After` header, or the `retryDelay` of a `google.rpc.RetryInfo` in the error body. |
| `limitTokens`, `requestedTokens` | `number \| undefined` | For `kind` `"context_overflow"`: the model's limit and the tokens of the request, when the message gives them. New in 0.6.0. |
| `type` | `string \| undefined` | The API's own word for the error, its `error.type`: `"rate_limit_error"`, `"overloaded_error"`, `"request_too_large"`. |
| `cause` | `unknown` | The HTTP client's error, for a request that could not be reached. |

The constructor takes the options of `ModelRequestError` and `type`. `type` sets the field and is
used to tell the kind, in place of any `code` given; `kind` given wins over what the status and
message say. You build one yourself only in a test or in a wrapper around the adapter.

```ts
import { askWithFiles } from "llm-large-files";
import { AnthropicRequestError } from "llm-large-files/anthropic";

// files, model, documentIds, messages and userId as above.
try {
  await askWithFiles({ files, model, owner: userId, documentIds, messages });
} catch (error) {
  if (error instanceof AnthropicRequestError && error.type === "overloaded_error") {
    console.error(`Claude is overloaded (HTTP ${error.status}); retries ran out.`);
  }
  throw error;
}
```

Guide: [errors and reliability](../guides/errors-and-reliability.md), with what to show your users
for each `kind`.

## Messages API messages

### `AnthropicMessage`

```ts
type AnthropicMessage = { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> };
```

A message of the Messages API as it takes and returns it: a string, or a list of content blocks
(`text`, `image`, `document`, `tool_use`, `tool_result`, `thinking`, and any other). There is no
system role: the system prompt goes in `askWithFiles`'s `system` option.

### fromAnthropicMessages(history)

```ts
declare function fromAnthropicMessages(history: AnthropicMessage[]): ChatMessage[];
```

A conversation kept as Messages API messages, as `askWithFiles` takes it in `messages`
([`ChatMessage[]`](./ask.md#chatmessage)). It does not change `history`, and throws nothing.

| Block in a message | What it becomes |
|---|---|
| A string `content` | Read as one `text` block. |
| `text` | A text part. An empty one is left out. |
| `thinking`, `redacted_thinking` | Left out: they belong to the conversation they were written in. |
| `tool_use`, in an assistant message | A call of a stored tool round ([`ToolTurn`](./ask.md#toolturn)): its `id`, `name`, and `input` (`{}` when it is not an object). |
| `tool_result`, in a user message | The result of the call with the same `tool_use_id` in an earlier message: its text (a string `content`, or the `text` blocks of a list, joined) parsed as a JSON object, else `{ text }`. One that answers no known call is left out. |
| Any other block (an `image`, a `document`) | A native part, as it is. |

The parts of a message become one turn of its role, when it has any, and its `tool_use` blocks
become one tool round after that turn. A call that no `tool_result` answers keeps the result
`{ error: "No result was kept for this call." }`.

Native parts reach every model of the question as they are. With a model of another provider (an
explorer on Gemini, say), both models must read blocks in the Messages API's form.

### anthropicToolTurns(turns)

```ts
declare function anthropicToolTurns(turns: ToolTurn[]): AnthropicMessage[];
```

The tool rounds a question returned ([`AskResult.toolTurns`](./ask.md#askresult)) as Messages API
messages, for an application that keeps its history in that form. Put them between the question and
its answer. It throws only for a round of a newer version (`version` above `TOOL_TURN_VERSION`), or
whose `version` is not a number (NaN, or a string such as `"1"`): the `TypeError` of `askWithFiles`
(since 0.99.9).

Each round becomes two messages: an assistant message of `{ type: "tool_use", id, name, input }`
blocks, and a user message of `{ type: "tool_result", tool_use_id, content }` blocks, `content`
being the result as JSON, without `tool_turns_left`, which counted the turns of its own question
(since 0.6.0, as `askWithFiles` sends stored rounds), with `is_error: true` when the result is an
error. No document blocks: `toolTurns` keep no files.

A call with an ID keeps it. A call without one is given a new random ID, `toolu_` and 24 hex
digits, a different one each time the function runs, so that the rounds of two questions kept in
one history never share an ID. (Before 0.6.0 such calls were numbered from 1.) The IDs are then
made to fit the API: each character other than `A-Z`, `a-z`, `0-9`, `_` and `-` becomes `_` (a
call from another provider, such as `functions.search:0`, becomes `functions_search_0`), and an ID
already used earlier in the returned list gets `_2`, `_3` and so on.

```ts
import { askWithFiles } from "llm-large-files";
import { anthropicToolTurns, fromAnthropicMessages, type AnthropicMessage } from "llm-large-files/anthropic";

// files, model, documentIds and userId as above; system is your system prompt. history is the chat so
// far, kept by your application as Messages API messages, ending with the user's question.
async function answer(history: AnthropicMessage[]): Promise<string> {
  const result = await askWithFiles({ files, model, owner: userId, system, documentIds, messages: fromAnthropicMessages(history) });
  // Keep what the tools returned between the question and the answer: a follow-up question
  // then finds it without searching again.
  history.push(...anthropicToolTurns(result.toolTurns), { role: "assistant", content: result.text });
  return result.text;
}
```

Guides: [conversations](../guides/conversations.md), which covers keeping `toolTurns` and the
history across requests, and [Claude](../guides/anthropic.md), on a conversation that may only grow.
