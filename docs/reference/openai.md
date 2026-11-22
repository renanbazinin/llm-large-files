# `llm-large-files/openai`

This page lists every export of `llm-large-files/openai` with its options, defaults, return values
and errors: the `openAiCompatible()` adapter, its error class, and the converters for a history
kept as Chat Completions messages. It is for you if a model of your question sits behind a Chat
Completions endpoint: OpenAI, Azure OpenAI, DeepSeek, OpenRouter, vLLM, Ollama, LiteLLM, llama.cpp,
or the OpenAI layer of the Gemini API. The recipe for each server is in the guide
[OpenAI-compatible endpoints](../guides/openai-compatible.md).

```ts
import { fromOpenAiMessages, openAiCompatible, openAiToolTurns, OpenAiRequestError } from "llm-large-files/openai";
import type { OpenAiCompatibleOptions, OpenAiMessage } from "llm-large-files/openai";
// What the signatures below use from the main entry:
import { ModelRequestError } from "llm-large-files";
import type { ChatMessage, ModelAdapter, ModelErrorKind, ToolTurn } from "llm-large-files";
```

The entry point needs no OpenAI SDK: it posts JSON to the URL you give, with `fetch`.

## Contents

- [The model adapter](#the-model-adapter): [`openAiCompatible()`](#openaicompatibleoptions),
  [`OpenAiCompatibleOptions`](#openaicompatibleoptions-1)
- [Errors](#errors): [`OpenAiRequestError`](#openairequesterror)
- [Chat Completions messages](#chat-completions-messages): [`OpenAiMessage`](#openaimessage),
  [`fromOpenAiMessages()`](#fromopenaimessageshistory), [`openAiToolTurns()`](#openaitoolturnsturns)

## The model adapter

### openAiCompatible(options)

```ts
declare function openAiCompatible(options: OpenAiCompatibleOptions): ModelAdapter;
```

A model behind a Chat Completions endpoint, as a [`ModelAdapter`](./ask.md#modeladapter) for
[`askWithFiles`](./ask.md#askwithfilesoptions): the model that answers, or the `explorer`. It makes
no request when it is created and throws nothing. The options are in
[`OpenAiCompatibleOptions`](#openaicompatibleoptions-1).

The adapter it returns:

| Member | Value |
|---|---|
| `id` | `options.id`, else `options.model`. It names the model in `usage.byModel` and in messages. |
| `capabilities` | `toolFiles` is `"beside"` with `pdfInput`, else `"none"`. `pageTokens` is `options.pageTokens`, else 1,000. `contextTokens`, `maxRequestBytes` and `tokenScale` are there only when you set them (0 counts as not set), so the loop counts a scale of 1 by default. No `outputTokens`, not `appendOnly`. See [`ModelCapabilities`](./ask.md#modelcapabilities). |
| `send(request, hooks?)` | One chat request, described below. |
| `requestBytes(request)` | The size in bytes of the JSON body of that request, without the two fields a stream adds. |
| `generateText` | The part reader of whole-file reads, described below. With it, `analyze_whole_document` can be offered when this adapter is the model that uses the tools (the explorer, when there is one), unless `wholeDocumentAnalysis` is `false`. |

**Where it posts.** Every request goes to `url`, or to `baseUrl` (default
`https://api.openai.com/v1`, trailing slashes removed) followed by `/chat/completions`. Its headers
are `Content-Type: application/json`; `Authorization: Bearer {apiKey}` when `apiKey` gives a
non-empty string; then `headers`, which can replace either. `apiKey` and `headers` are resolved
before every request, chat requests and part reads alike, so a function can return a renewed key.

**The body of a chat request**, in this order, a later field replacing an earlier one:

- `model`.
- `messages`: the system instruction first, as a message of role `systemRole` (`"system"`), when it
  is not empty; then the conversation.
- `tools`, each as `{ type: "function", function: declaration }`, when the request offers tools. A
  request that must be answered in text adds `tool_choice: "none"`. With
  `answerWithoutTools: "omit"` it sends neither `tools` nor `tool_choice`.
- `stream: true` and `stream_options: { include_usage: true }`, when the request is streamed.
- Every field of `body`.

A chat request carries no output limit and no sampling field unless you put them in `body`.

**The conversation in the request.**

- A turn of text is a message whose `content` is a string: its text parts, joined by a blank line.
  A turn with native parts has a list as `content`: `{ type: "text", text }` for each text part,
  and each native part as it is.
- User turns that follow each other are made one, because some servers (DeepSeek's reasoner, the
  chat templates of Mistral and Gemma models) refuse two user turns in a row.
- A model turn of this question goes back as it came (`ModelReply.raw`), with any
  `reasoning_content`, `reasoning`, `reasoning_details` or `refusal` in it: a server may want them
  again. A stored tool round (the `toolTurns` of an earlier question, or a round of another
  adapter) becomes an assistant message with `content: null` and `tool_calls`, the arguments as a
  JSON string. A call without an ID is given `call_{round}_{n}`.
- Each result is a message `{ role: "tool", tool_call_id, content }`, `content` being the result as
  JSON. With `pdfInput`, the files the tools returned (the pages of `view_pages`) follow in one user
  message: for each file, a text part `"{file name} (returned by view_pages):"` and a part
  `{ type: "file", file: { filename, file_data: "data:application/pdf;base64,…" } }`.

**Streaming.** A chat request is streamed when `hooks.onText` is given and `stream` is not `false`.
Under `askWithFiles` that is the answering model's request when you pass `onText`; an explorer's
requests are never streamed. Each piece of text goes to `onText` as it arrives.

- A reply of type `text/event-stream` is read as events. A reply of another type, or of none, is
  read by its first characters (since 0.6.0): as events when it starts like them (`data:`,
  `event:`, `id:`, `retry:` or a comment), as one piece otherwise. A body that starts with more
  than 65,536 characters of white space is read as one piece. A reply read whole gives `onText`
  its text at once.
- `[DONE]` ends the reply. A server that then leaves the connection open is read for one more
  second at most, and the body is cancelled, which closes the connection; a connection that breaks
  after `[DONE]` keeps the reply too. 0.5.0 waited for such a connection to close, and failed a
  request whose connection broke after `[DONE]` with status 0, with the whole answer already shown.
- A server that sends the name of a tool call again with each piece of the call does not make it
  longer (since 0.6.0; it gave `search_documentsearch_document`). A name sent in pieces is joined.

**The reply** ([`ModelReply`](./ask.md#modelreply)):

- `text` is the message's content. When there is none and the model refused, it is the `refusal`,
  which goes to `onText` too.
- `calls` are the `tool_calls` that have a name. Arguments that are not a JSON object give the call
  a `problem`: the loop answers it with that message instead of running it, and the model can send
  it again. In the turn that goes back, those arguments, and empty ones, become `"{}"`, and
  arguments that came as an object become their JSON text. When
  `finish_reason` is `"length"`, every call gets a `problem` that says it was cut off at the output
  limit, and none is run.
- `raw` is the assistant message as it goes back: the content, `refusal`, `reasoning_content`
  (DeepSeek), `reasoning` and `reasoning_details` (OpenRouter; the streamed pieces of one detail
  are joined, its other fields kept), and `tool_calls`.
- `finishReason` is `finish_reason`. `finish` is `"complete"` for `stop`, `tool_calls` and
  `function_call`, `"cut"` for `length`, and `"filtered"` for `content_filter`. A `content_filter`
  reply with no text and no calls has `blockReason: "content_filter"`.
- `usage`: `inputTokens` is `prompt_tokens`; `cachedInputTokens` is
  `prompt_tokens_details.cached_tokens`, or DeepSeek's `prompt_cache_hit_tokens`; `outputTokens` is
  `completion_tokens`; `thoughtTokens` is `completion_tokens_details.reasoning_tokens`. A missing
  number counts 0. `providerUsage` is the `usage` object as it came. A stream reports usage only
  when the server sends it.

**Part reads** (`generateText`, for `analyze_whole_document`) go to the same URL with the same
headers and are never streamed. The body is `model`, a message of role `systemRole` and a user
message, the output limit under the name `maxTokensField`, then the fields of
`analysisBody(limit)`. `body` is not used. Each request may take `timeoutMs` (180 s). A reply cut
off with nothing written, or with half its limit or more spent thinking, while the limit was below
32,768, is asked again with 32,768 output tokens
([`THINKING_OUTPUT_TOKENS`](./gemini.md#thinking_output_tokens)), and later part reads to the same
URL and model start there. A server that refuses that limit with HTTP 400 is not asked for it
again. A refusal of the request as too large is not taken for that (since 0.6.0): one for the
model's window (HTTP 400), or for the tokens a minute the provider allows (OpenAI's 429, Groq's 413
or 429), turns the larger limit off only when the window or allowance it names is 32,768 tokens or
less; otherwise a later part may still get it. In 0.5.0 one 400 for the window turned it off for
every later question on that model, in that process.

**Errors.** `send` throws, and does not send anything again itself:
[`askWithFiles`](./ask.md#askwithfilesoptions) decides what is retried
([`RetryOptions`](./errors-and-retries.md#retryoptions)).

| Case | Error | `status` | `kind` |
|---|---|---|---|
| The server answered with an HTTP error | [`OpenAiRequestError`](#openairequesterror) with the body's `error.message` (or `error`, when it is a string; a body wrapped in a list, as the Gemini API's layer sends it, is read too); else, since 0.6.0, a `message` at the top of the body (vLLM before its OpenAI-shaped errors, SGLang, FastChat) or a FastAPI `detail` (a string, or the `msg` of each problem in a list, joined with "; "); else "The model returned HTTP {status}." (for example "The model returned HTTP 503."). With `param`, `code` and `retryAfterMs` when the server gave them, in `error` or at the top of the body. | The HTTP status | Told from the status, the message and `code` |
| An error object inside a stream that began with 200 | `OpenAiRequestError` with its `message`, else "The model reported an error.", with its `code` and `param` when they are strings (since 0.6.0). | Its `code` when that is a status from 400 to 599; else from its `type` or `code`: `server_error`, `api_error`, `internal_error`, `internal_server_error` 500; `service_unavailable` 503; `rate_limit_exceeded`, `rate_limit_error`, `tokens_exceeded`, `insufficient_quota` 429; `timeout` 408; `invalid_request_error`, `context_length_exceeded` 400; any other 500. In 0.5.0: its `code` when that was a number, else the response's 200, not sent again | Told from the status, the message and `code`: `context_length_exceeded` is `"context_overflow"`, and `insufficient_quota` `"quota"`, neither sent again |
| The connection failed, before or while the reply arrived, or an event of the stream was not JSON | `OpenAiRequestError`: "The model could not be reached (fetch failed).", the reason being the HTTP client's message | 0 | `"unreachable"` |
| A reply of HTTP 200 whose body is empty | `OpenAiRequestError`: "The model could not be reached (the reply was empty).", new in 0.6.0. When the reply's type is `text/event-stream`, "The model's reply ended before it was complete." Either is sent again as a reply cut off on its way. | 0 | `"unreachable"` |
| Nothing arrived for a whole wait (`firstByteTimeoutMs`, `idleTimeoutMs`) | `OpenAiRequestError`: "The model sent nothing for {seconds} s.", the wait that ran out (600 s or 300 s by default) | 0 | `"timeout"` |
| A stream that closed with no `finish_reason` and no `[DONE]` | `OpenAiRequestError`: "The model's reply ended before it was complete." | 0 | `"unreachable"` |
| `finish_reason` `"insufficient_system_resource"` (DeepSeek's servers ran short) | `OpenAiRequestError`: "The model's server stopped the reply: it ran short of resources." | 503 | `"server"` |
| A reply whose body is not JSON (a gateway's HTML page) | `OpenAiRequestError`: "The model's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.", the brackets holding the response's media type (left out when it has none), with the `SyntaxError` as `cause`. Not sent again. Until 0.6.0, the `SyntaxError` itself. | The response's, 200 | `"invalid"` |
| An event of the stream longer than 64,000,000 characters | `OpenAiRequestError`: "The model's reply could not be read: an event of its stream held more than 64,000,000 characters." Not sent again. New in 0.6.0. | The response's, 200 | `"invalid"` |
| `hooks.signal` aborted | The signal's reason, as it is | none | none |

A part read throws as `send` does for an HTTP error, a connection that failed, an empty body,
`insufficient_system_resource`, an abort and a body that is not JSON. It has no waits of
`firstByteTimeoutMs` and `idleTimeoutMs`; instead, a request that ran past `timeoutMs` throws the
error of its abort (a `TimeoutError`). A reply with no text throws
`Error("The model returned no text (length).")`, the reason in brackets being `finish_reason`.
These two have no `status`. In a whole-file read, the model is told why a part failed by the
error's kind and status, never by the server's message: "The model took too long to answer." for
the `TimeoutError`, "The model returned no text (length)." for a reply with no text, the reason
only when it is a plain word (see [`analyze_whole_document`](./tools.md#analyze_whole_document)).

```ts
import { askWithFiles } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";

// files, documentIds and messages come from your application.
const model = openAiCompatible({
  model: "gpt-5.5",
  apiKey: process.env.OPENAI_API_KEY!,
  contextTokens: 400_000,            // set this to your model's context window
  body: { reasoning_effort: "low" }, // any field of the chat request
});

const result = await askWithFiles({
  files,
  model,
  documentIds,
  messages,
  onText: (delta) => process.stdout.write(delta), // the answer streams
});
console.log(result.usage.byModel["gpt-5.5"]);
```

Guide: [OpenAI-compatible endpoints](../guides/openai-compatible.md), with a recipe for each server
and the pairing with Gemini. A second model that explores while this one answers, or the other way
round: [explorer model](../guides/explorer-model.md).

### `OpenAiCompatibleOptions`

```ts
type OpenAiCompatibleOptions = {
  model: string;
  baseUrl?: string | undefined;
  url?: string | undefined;
  apiKey?: string | (() => string | Promise<string>) | undefined;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  body?: Record<string, unknown> | undefined;
  analysisBody?: ((maxOutputTokens: number) => Record<string, unknown>) | undefined;
  maxTokensField?: "max_tokens" | "max_completion_tokens" | undefined;
  systemRole?: "system" | "developer" | undefined;
  answerWithoutTools?: "tool_choice" | "omit" | undefined;
  pdfInput?: boolean | undefined;
  stream?: boolean | undefined;
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

The options of [`openAiCompatible()`](#openaicompatibleoptions).

| Option | Type | Default | What it does |
|---|---|---|---|
| `model` | `string` | required | The model name the endpoint knows, sent as `model` in every chat request and part read: `"gpt-5.5"`, `"deepseek-v4-pro"`, an Azure deployment name. |
| `baseUrl` | `string` | `"https://api.openai.com/v1"` | The base of the API. Trailing slashes are removed and `/chat/completions` is added. DeepSeek: `https://api.deepseek.com/v1`. The Gemini API's OpenAI layer: `https://generativelanguage.googleapis.com/v1beta/openai`. Not used when `url` is set. |
| `url` | `string` | `baseUrl` + `/chat/completions` | The whole Chat Completions URL, used as it is, query string included: Azure OpenAI, a gateway. Its host also sets the default of `maxTokensField`. |
| `apiKey` | `string \| (() => string \| Promise<string>)` | none | Sent as `Authorization: Bearer {key}`. A function is called before every request. Left out, or an empty string, no `Authorization` header is sent. |
| `headers` | `Record<string, string> \| (() => Record<string, string> \| Promise<Record<string, string>>)` | none | More headers, merged last: they can replace `Content-Type` and `Authorization`. Azure's `api-key` goes here. A function is called before every request. |
| `body` | `Record<string, unknown>` | none | More fields for the body of every chat request: `temperature`, `reasoning_effort`, `max_completion_tokens`. Spread last, so a field here replaces the adapter's own, `model`, `messages`, `tools` and `stream` included; a field set to `undefined` is left out of the JSON. Not sent with part reads. |
| `analysisBody` | `(maxOutputTokens: number) => Record<string, unknown>` | none | More fields for the body of each part read, given the output limit that request is sent with. Spread last. |
| `maxTokensField` | `"max_tokens" \| "max_completion_tokens"` | `"max_completion_tokens"` when the host is `openai.com` or ends in `.openai.com` or `.openai.azure.com`, or ends in `.cognitiveservices.azure.com` or `.services.ai.azure.com` with `/openai/` in the path; `"max_tokens"` anywhere else | The name of the output limit in a part read. Left out, a part read that the server refuses with HTTP 400 for that name (by `param` and `code`, or in its message) is sent again with the other name, and the adapter keeps the other name from then on. Set, it is always used. |
| `systemRole` | `"system" \| "developer"` | `"system"` | The role of the system message, in chat requests and in part reads. `"developer"` for an endpoint that wants the newer name. |
| `answerWithoutTools` | `"tool_choice" \| "omit"` | `"tool_choice"` | How the request that must be answered in text says so. `"tool_choice"` keeps the tools and sends `tool_choice: "none"`. `"omit"` leaves the tools out and sends no `tool_choice`, for a server that does not know `tool_choice`. |
| `pdfInput` | `boolean` | `false` | Send the pages of `view_pages` to the model, as `file` parts in a user message after the tool messages of the round. It makes `capabilities.toolFiles` `"beside"`. Off, `toolFiles` is `"none"`, and `view_pages` is not offered to any model of the question. Turn it on only for a model that reads PDF input: a tool message holds text only, and many servers behind this API take no PDF at all. |
| `stream` | `boolean` | `true` | Stream a chat request that has `onText`. `false` never streams, for a server without streaming. A request without `onText` is not streamed either way. |
| `contextTokens` | `number` | none | The model's context window in tokens. Set as `capabilities.contextTokens`, it keeps the budget of a question within it. Without it the library's budget holds: 1,000,000 tokens unless you set another. |
| `maxRequestBytes` | `number` | none | The largest request body the endpoint takes, in bytes. Set as `capabilities.maxRequestBytes`, it keeps the budget within it. Without it the library's budget holds: 10,000,000 bytes unless you set another. |
| `pageTokens` | `number` | `1_000` | Tokens one PDF page shown by `view_pages` costs. The loop sizes the pages a question may look at from it. It matters only with `pdfInput`. |
| `tokenScale` | `number` | none, counted as 1 | This model's tokens for one token of the library's estimate, which is fitted to Gemini. A model whose tokenizer counts a third more for the same text takes 1.33, and its documents are planned for a window that much smaller. |
| `timeoutMs` | `number` | `180_000` | The longest a part read's request may take, in milliseconds, each try counted apart, except that a request sent again with the other name of the output limit (see `maxTokensField`) shares the time of the first. A request that runs longer is aborted. Not used for chat requests. |
| `firstByteTimeoutMs` | `number` | `600_000` | The longest wait, in milliseconds, for the first piece of a chat reply. Headers do not count: a model that thinks sends nothing until it has thought, and a reply that is not streamed comes whole at the end. A request that gets nothing for that long is aborted with an `OpenAiRequestError` (`status` 0, `kind` `"timeout"`), which `askWithFiles` sends again once. 0, a negative or a non-finite number waits without end. The key and headers are resolved before the wait starts. Not used for part reads. |
| `idleTimeoutMs` | `number` | `300_000` | The longest wait, in milliseconds, between two pieces of a chat reply once it has started to arrive. Any bytes count, keep-alives included. The same error; `askWithFiles` sends the request again once, unless text of it was shown. 0 waits without end. Not used for part reads. |
| `id` | `string` | `model` | The name of the model in `usage.byModel` and in messages. |
| `fetch` | `typeof fetch` | the global `fetch` | Used for chat requests and part reads: a proxy, logging, tests. A `fetch` whose body is a Node stream (node-fetch) works too. |

The two waits default to [`DEFAULT_FIRST_BYTE_TIMEOUT_MS`](./errors-and-retries.md#default_first_byte_timeout_ms)
and [`DEFAULT_IDLE_TIMEOUT_MS`](./errors-and-retries.md#default_idle_timeout_ms). What to set
them to: [errors and reliability](../guides/errors-and-reliability.md). What a page costs and how
the budget follows the model: [costs and limits](../guides/costs-and-limits.md),
[PDFs](../guides/pdfs.md).

## Errors

### `OpenAiRequestError`

```ts
declare class OpenAiRequestError extends ModelRequestError {
  readonly param?: string;
  readonly code?: string;
  constructor(message: string, status: number, options?: {
    retryAfterMs?: number;
    cause?: unknown;
    kind?: ModelErrorKind;
    code?: string | undefined;
    details?: unknown;
    param?: string;
  });
}
```

A request to an OpenAI-compatible endpoint that failed: the server answered with an HTTP error, or
could not be reached (`status` 0). It is a
[`ModelRequestError`](./errors-and-retries.md#modelrequesterror), so code that handles every
provider through `ModelRequestError` and `kind` needs no case of its own for it. The table under
[`openAiCompatible()`](#openaicompatibleoptions) lists when the adapter throws one.

| Field | Type | What it holds |
|---|---|---|
| `name` | `string` | `"OpenAiRequestError"`. |
| `message` | `string` | The server's own message, or one of the adapter's (see the table above). It is the provider's text: log it, and do not show it to your users as it is. |
| `status` | `number` | The HTTP status, or the status of an error inside a stream; 0 when no answer came; 200 for a reply that came and could not be read. |
| `kind` | [`ModelErrorKind`](./errors-and-retries.md#modelerrorkind) | What went wrong, told from `status`, the message and `code`: `code` `"insufficient_quota"` makes it `"quota"`, and so does HTTP 402 (DeepSeek's "Insufficient Balance", OpenRouter's "Insufficient credits"); `"context_length_exceeded"` with a 4xx status makes it `"context_overflow"`, and so does a request larger than the tokens a minute allow (OpenAI's 429 "Request too large … on tokens per min (TPM)", Groq's 413 or 429). The adapter sets `"timeout"` itself for a wait that ran out, and `"invalid"` for a reply of HTTP 200 it could not read. New in 0.6.0. |
| `retryAfterMs` | `number \| undefined` | The wait the server asked for: its `retry-after-ms` or `Retry-After` header, or the `retryDelay` of a `google.rpc.RetryInfo` in the error body (the Gemini API's OpenAI layer). |
| `limitTokens`, `requestedTokens` | `number \| undefined` | For `kind` `"context_overflow"`: the model's limit and the tokens of the request, when the message gives them. New in 0.6.0. |
| `param` | `string \| undefined` | `error.param` of an HTTP error's body (or `param` at its top), or of an error inside a stream, when it is a string: the request field the error is about, such as `"max_tokens"`. New in 0.6.0. |
| `code` | `string \| undefined` | `error.code` of an HTTP error's body (or `code` at its top), or of an error inside a stream, when it is a string: the server's own word, such as `"unsupported_parameter"`, `"context_length_exceeded"` or `"insufficient_quota"`. New in 0.6.0. |
| `cause` | `unknown` | The HTTP client's error, for a request that could not be reached. |

The constructor takes the options of `ModelRequestError` and `param`. `code` sets the field and is
also used to tell the kind; `kind` given wins over what the status and message say. You build one
yourself only in a test or in a wrapper around the adapter.

```ts
import { askWithFiles, partialResultOf } from "llm-large-files";
import { OpenAiRequestError } from "llm-large-files/openai";

// files, model, documentIds and messages as above.
try {
  await askWithFiles({ files, model, documentIds, messages });
} catch (error) {
  if (error instanceof OpenAiRequestError) {
    console.error(error.status, error.kind, error.code, error.param, error.message);
    console.error(partialResultOf(error)?.usage); // what the question used before it failed
  }
  throw error;
}
```

Guide: [errors and reliability](../guides/errors-and-reliability.md), with what to show your users
for each `kind`.

## Chat Completions messages

### `OpenAiMessage`

```ts
type OpenAiMessage = { role: string; [key: string]: unknown };
```

A Chat Completions message as the API takes and returns it: `{ role: "user", content: "…" }`, an
assistant message with `tool_calls`, a `tool` message. Any field a server adds is allowed by the
type. [`fromOpenAiMessages`](#fromopenaimessageshistory) reads only `role`, `content`, `tool_calls`
and `tool_call_id`; other fields of a stored message, such as a user message's `name` or an
assistant message's `reasoning_content` or `refusal`, are dropped.

### fromOpenAiMessages(history)

```ts
declare function fromOpenAiMessages(history: OpenAiMessage[]): { system: string; messages: ChatMessage[] };
```

A conversation kept as Chat Completions messages, as `askWithFiles` takes it: `system` for its
`system` option, and `messages` ([`ChatMessage[]`](./ask.md#chatmessage)) for its `messages`. It
does not change `history`, and throws nothing.

| Message in `history` | What it becomes |
|---|---|
| `system` or `developer` | Its text (a string `content`, or the `text` parts of a list), added to `system`. Several are joined by a blank line; empty ones are left out. |
| `user`, or `assistant` with no `tool_calls` | A turn of that role. A string `content` is one text part. A list keeps its `text` parts as text and every other part (an `image_url`, a `file`) as a native part, in order. |
| `assistant` with `tool_calls` | A stored tool round ([`ToolTurn`](./ask.md#toolturn)): for each call its `id` (or `call_{n}_{m}` when it has none), its name, and its arguments parsed (`{}` when they are not a JSON object). Any `content` of that message is not kept. |
| `tool` | The result of the call with the same `tool_call_id` in an earlier round: the content parsed as a JSON object, else `{ text: content }`. A `tool` message that answers no known call is left out. |
| Any other role | Left out. |

A call that no `tool` message answers keeps the result
`{ error: "No result was kept for this call." }`.

Native parts reach every model of the question as they are. With a model of another provider (an
explorer on Gemini, say), both models must read parts in OpenAI's form.

### openAiToolTurns(turns)

```ts
declare function openAiToolTurns(turns: ToolTurn[]): OpenAiMessage[];
```

The tool rounds a question returned ([`AskResult.toolTurns`](./ask.md#askresult)) as Chat
Completions messages, for an application that keeps its history in that form. Put them between the
question and its answer. It throws nothing.

Each round becomes an assistant message `{ role: "assistant", content: null, tool_calls }`, the
arguments as a JSON string, followed by one `{ role: "tool", tool_call_id, content }` for each call,
`content` being the result as JSON, without `tool_turns_left`, which counted the turns of its own
question (since 0.6.0, as `askWithFiles` sends stored rounds). No files: `toolTurns` keep none. A call with an ID keeps it. A
call without one is given a new random ID, `call_` and 24 hex digits, a different one each time the
function runs, so that the rounds of two questions kept in one history never share an ID. (Before
0.6.0 such calls were numbered from 1.)

```ts
import { askWithFiles } from "llm-large-files";
import { fromOpenAiMessages, openAiToolTurns, type OpenAiMessage } from "llm-large-files/openai";

// files, model and documentIds as above. history is the chat so far, kept by your application
// as Chat Completions messages, ending with the user's question.
async function answer(history: OpenAiMessage[]): Promise<string> {
  const { system, messages } = fromOpenAiMessages(history);
  const result = await askWithFiles({ files, model, system, documentIds, messages });
  // Keep what the tools returned between the question and the answer: a follow-up question
  // then finds it without searching again.
  history.push(...openAiToolTurns(result.toolTurns), { role: "assistant", content: result.text });
  return result.text;
}
```

Guides: [conversations](../guides/conversations.md), which covers keeping `toolTurns` and the
history across requests, and [OpenAI-compatible endpoints](../guides/openai-compatible.md).
