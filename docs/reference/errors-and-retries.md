# Errors, retries and streams

This is the reference for the errors of model requests, the rule that sends a failed request again,
the waits on a silent model, and the parser of event streams, all from the main entry,
`llm-large-files`. Use it when you handle a failed question, write an adapter or a loop of your
own, or tune retries. What to show a user for each failure, and how the pieces work together, is
in [Errors and reliability](../guides/errors-and-reliability.md).

```ts
import {
  classifyModelError,
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  errorInfoOf,
  errorKindOf,
  isRetryableStatus,
  ModelRequestError,
  parseSseJson,
  retryAfterMs,
  withRetry,
} from "llm-large-files";
import type { ErrorCategory, ErrorInfo, EventError, IdleWaits, ModelErrorClass, ModelErrorKind, RetryNotice, RetryOptions, SseHooks } from "llm-large-files";
```

Contents:

- Errors: [`ModelRequestError`](#modelrequesterror), [`ModelErrorKind`](#modelerrorkind),
  [`ModelErrorClass`](#modelerrorclass),
  [`classifyModelError`](#classifymodelerrorstatus-message-signals),
  [`errorKindOf`](#errorkindoferror), [other error classes](#other-error-classes),
  [`errorInfoOf`](#errorinfooferror) and [`ErrorInfo`](#errorinfo),
  [errors in events: `EventError`](#errors-in-events-eventerror)
- Retries: [`withRetry`](#withretryrun-options), [`RetryOptions`](#retryoptions),
  [`RetryNotice`](#retrynotice), [retries in events](#retries-in-events),
  [`isRetryableStatus`](#isretryablestatusstatus), [`retryAfterMs`](#retryaftermsheaders-body-now)
- Waits on a reply: [`DEFAULT_FIRST_BYTE_TIMEOUT_MS`](#default_first_byte_timeout_ms),
  [`DEFAULT_IDLE_TIMEOUT_MS`](#default_idle_timeout_ms), [`IdleWaits`](#idlewaits)
- Streams: [`parseSseJson`](#parsessejsonstream-hooks), [`SseHooks`](#ssehooks)

## Errors

### `ModelRequestError`

```ts
declare class ModelRequestError extends Error {
  constructor(message: string, status: number, options?: {
    retryAfterMs?: number;
    cause?: unknown;
    kind?: ModelErrorKind;
    code?: string | undefined;
    details?: unknown;
  });
  readonly status: number;
  readonly kind: ModelErrorKind;
  readonly retryAfterMs?: number;
  readonly limitTokens?: number;
  readonly requestedTokens?: number;
  static is(value: unknown): value is ModelRequestError; // new in 0.9.0
}
```

A model request that failed: the provider answered with an HTTP error, or no answer came
(`status` 0). Every adapter of the package throws a subclass of it (see
[other error classes](#other-error-classes)), and `askWithFiles` and `askGemini` throw it as it
came when another try did not help or was not worth making. `name` is `"ModelRequestError"`; each
subclass sets its own.

| Field | Type | What it holds |
|---|---|---|
| `status` | `number` | The HTTP status of the provider's answer. 0 when no answer came: the connection failed, the adapter's wait on a silent model ran out (kind `"timeout"`), a stream ended before it was complete, or a reply of HTTP 200 came with an empty body. For an error event inside a stream whose response was HTTP 200, it is the status the event names or implies (Claude's `overloaded_error` is 529 and `invalid_request_error` 400; a Claude error with no `type`, or one the adapter does not map, is 500, as an OpenAI-compatible error the server does not name is). A Gemini error without a numeric `code` keeps the response's 200. A reply of HTTP 200 that the adapter could not read (a body that is not JSON, or a streamed event too long) keeps its 200, with kind `"invalid"`. See the adapter's page. |
| `kind` | `ModelErrorKind` | What went wrong. The `kind` option when it was given; otherwise `classifyModelError(status, message, { code, details }).kind`. New in 0.6.0. |
| `retryAfterMs` | `number`, optional | The wait the provider asked for, in milliseconds, when it named one. The adapters read it with [`retryAfterMs()`](#retryaftermsheaders-body-now). Unset otherwise. |
| `limitTokens` | `number`, optional | Only for kind `"context_overflow"`: the most input tokens the model takes, as the provider counts them, when its message names the number. New in 0.6.0. |
| `requestedTokens` | `number`, optional | Only for kind `"context_overflow"`: the tokens of the refused request that the provider counted against the window, when its message names them. Some providers (OpenRouter, vLLM) count the output it would have taken too. New in 0.6.0. |
| `message` | `string` | The provider's own message when its error body has one, otherwise the adapter's ("Claude returned HTTP 502."). It can name projects, quotas and models: log it, and show your users your own text. |
| `cause` | `unknown` | The `cause` option: for a request that got no answer, the error of `fetch`. |

The constructor options (`kind`, `code` and `details` are new in 0.6.0):

| Option | Type | Default | What it does |
|---|---|---|---|
| `retryAfterMs` | `number` | none | Sets `retryAfterMs`. |
| `cause` | `unknown` | none | Passed to `Error` as its `cause`. |
| `kind` | `ModelErrorKind` | told by `classifyModelError` | The kind, when you know it better than the status and message tell. Give `"timeout"` with status 0 when your own wait on the model ran out: without it, status 0 is `"unreachable"`. |
| `code` | `string \| undefined` | none | The provider's own word for the error, used to tell the kind: OpenAI's `error.code`, Claude's `error.type`, Gemini's `error.status`. `ModelRequestError` does not keep it. |
| `details` | `unknown` | none | The `details` array of a Gemini error body, used to tell a quota per day and an API key that is not valid. Not kept. |

`limitTokens` and `requestedTokens` are set only when the kind is `"context_overflow"` and
`classifyModelError` also reads the failure (its status, message and code) as an overflow, by the
checks of the [`ModelErrorKind`](#modelerrorkind) table. A `kind: "context_overflow"` you give gets
no numbers when the classifier reads the failure as another kind: status 0, a quota, a status of
500 and more, throttling wording beside overflow wording alone, or none of the signs of an overflow. The constructor throws
nothing.

```ts
import { ModelRequestError } from "llm-large-files";

const error = new ModelRequestError("prompt is too long: 210417 tokens > 200000 maximum", 400);
console.log(error.kind, error.limitTokens, error.requestedTokens); // "context_overflow" 200000 210417

console.log(new ModelRequestError("fetch failed", 0).kind);                            // "unreachable"
console.log(new ModelRequestError("Nothing for 600 s.", 0, { kind: "timeout" }).kind); // "timeout"
```

In a call of your own, throw it with the status, the provider's wait and its code, so that
[`withRetry`](#withretryrun-options) and your error handling can read them:

```ts
import { ModelRequestError, retryAfterMs } from "llm-large-files";

/** One request to a model service of your own. Its failures are ModelRequestErrors. */
export async function post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    // No answer at all: status 0, kind "unreachable".
    throw new ModelRequestError("The model could not be reached.", 0, { cause: error });
  }
  if (response.ok) return response.json();
  const data: unknown = await response.json().catch(() => null);
  const failure = (data as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  const wait = retryAfterMs(response.headers, data);
  throw new ModelRequestError(
    typeof failure?.message === "string" ? failure.message : `The model returned HTTP ${response.status}.`,
    response.status,
    {
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
      ...(typeof failure?.code === "string" ? { code: failure.code } : {}),
    },
  );
}
```

Writing a whole adapter: [Your own adapter and loop](../guides/own-adapter-and-loop.md). What to
do with each kind: [Errors and reliability](../guides/errors-and-reliability.md).

### `ModelErrorKind`

```ts
type ModelErrorKind = "context_overflow" | "quota" | "rate_limit" | "timeout" | "unreachable" | "server" | "auth" | "invalid";
```

What went wrong with a model request. `classifyModelError` runs its checks in the order of this
table, and the first that matches gives the kind:

| Kind | What went wrong | How `classifyModelError` tells it | `withRetry` |
|---|---|---|---|
| `"unreachable"` | No answer at all: the connection failed, a stream ended before it was complete, or a reply of HTTP 200 came with an empty body. | Status 0. | Sends it again, up to `retries` times. |
| `"quota"` | A quota that does not come back soon: a daily cap, no credit left, a spending limit reached. | The code `insufficient_quota` (OpenAI), at any status but 0. Status 402. Status 429 with a Gemini `details` entry whose `violations` name a quota per day (a `quotaId` or `quotaMetric` that matches "per day": "PerDay", "per_day"), or with [quota-per-day wording](#classifymodelerrorstatus-message-signals) in the message. A status below 500 with [no-credit wording](#classifymodelerrorstatus-message-signals). | Never. |
| `"context_overflow"` | The request was larger than the model takes: its context window, the size of the body, or the tokens a minute (or a day) that the provider allows. | Status 429 or 413 with [allowance wording](#classifymodelerrorstatus-message-signals) (OpenAI's and Groq's "Request too large … on tokens per min (TPM)"). Otherwise a status below 500 and not 429, and one of: status 413; the code `context_length_exceeded` or `request_too_large`; [overflow wording](#classifymodelerrorstatus-message-signals) in a message without [throttling wording](#classifymodelerrorstatus-message-signals). (Until 0.99.10, throttling wording undid the status and the codes too: a 413 that said "please try again later" was `"invalid"`.) | Never, whatever its status: only a smaller request can pass. `askWithFiles` makes room instead: see [`askWithFiles`](./ask.md#askwithfilesoptions). |
| `"rate_limit"` | Too many requests or tokens for now, a Gemini quota per minute among them. | Any other status 429. | Sends it again, up to `retries` times, after the wait the provider asked for or a wait that doubles. Not when the provider asks for more than `maxDelayMs`. |
| `"timeout"` | Nothing came from the model for the adapter's wait, or the provider or a gateway said the request timed out. | Status 408. The classifier never gives it for status 0: the adapters pass `kind: "timeout"` when their own wait runs out. | Status 0: once. Status 408: up to `retries` times. |
| `"server"` | The provider failed on its side. | Status 500 or more. | Sends it again, up to `retries` times. |
| `"auth"` | The key or token was refused. | Status 401 or 403, or a Gemini `details` entry with `reason: "API_KEY_INVALID"` (Gemini sends it as HTTP 400). | Never. |
| `"invalid"` | The provider refused the request as it was. The adapters also give it to a reply of HTTP 200 they could not read: a body that is not JSON (a gateway's page), or a streamed event too long. | Any other status: 400, 404, 409, 422… | Never, except status 409, which [`isRetryableStatus`](#isretryablestatusstatus) accepts. |

Nothing is sent again after the caller's signal aborted, once `canRetry` says no, or when the
provider said not to (Claude's `x-should-retry: false`): see [`withRetry`](#withretryrun-options).

Kinds are new in 0.6.0. 0.5.0 sent an error again by its status alone: every status 0, 408, 409,
429 and 500 or more, so a quota or a request too large that came as HTTP 429 was sent again as it
was, up to three times.

### `ModelErrorClass`

```ts
type ModelErrorClass = {
  kind: ModelErrorKind;
  limitTokens?: number;
  requestedTokens?: number;
};
```

What [`classifyModelError`](#classifymodelerrorstatus-message-signals) returns. New in 0.6.0.

| Field | Type | What it holds |
|---|---|---|
| `kind` | `ModelErrorKind` | The kind of the failure. |
| `limitTokens` | `number`, optional | For `"context_overflow"` only, when the message names it: the most input tokens the model takes. |
| `requestedTokens` | `number`, optional | For `"context_overflow"` only, when the message names it: the tokens the provider counted for the refused request. |

### classifyModelError(status, message, signals)

```ts
declare function classifyModelError(
  status: number,
  message: string,
  signals?: { code?: string | undefined; details?: unknown },
): ModelErrorClass;
```

Tells the kind of a failure from its HTTP status, the provider's message and the provider's own
signals, by the order of the [`ModelErrorKind`](#modelerrorkind) table. For an overflow it also
reads the provider's numbers from the message. `ModelRequestError` calls it in its constructor;
call it yourself to see how a message of your provider is read. New in 0.6.0.

| Parameter | Type | Default | What it is |
|---|---|---|---|
| `status` | `number` | required | The HTTP status. 0 for a request that got no answer. |
| `message` | `string` | required | The provider's message. |
| `signals.code` | `string \| undefined` | none | The provider's own word for the error: OpenAI's `error.code`, Claude's `error.type`, Gemini's `error.status`. Three values change the kind: `insufficient_quota`, `context_length_exceeded` and `request_too_large`. |
| `signals.details` | `unknown` | none | A Gemini error's `details` array: a `QuotaFailure` with a quota per day, or a `reason` of `API_KEY_INVALID`. |

Returns a [`ModelErrorClass`](#modelerrorclass). Throws nothing.

The wording is matched without regard to case.

- **Quota-per-day wording**, at status 429: "quota" followed, within 200 characters, by "per day",
  "per_day", "per-day" or "perday", as in Vertex AI's "Quota exceeded for
  aiplatform.googleapis.com/generate_content_requests_per_day_per_project_per_base_model".
- **No-credit wording**, at any status below 500: "credit balance is too low" (Claude),
  "insufficient balance" (DeepSeek), "insufficient credit(s)" (OpenRouter), "insufficient funds",
  "reached your (specified) API usage limits" (Claude's spending limits).
- **Allowance wording**, at status 429 or 413: "request too large for", then, within 200
  characters, "on tokens per min", "on tokens per minute" or "on tokens per day", as OpenAI's "Request too large for
  gpt-4o in organization org-… on tokens per min (TPM): Limit 30000, Requested 45237." and Groq's
  "… on tokens per minute (TPM): Limit 6000, Requested 6438". It is an overflow whatever else the
  message says.
- **Throttling wording**, which keeps the overflow wording of any other message from making it an
  overflow, even when it talks of tokens: "rate limit" (or "rate-limit", "ratelimit"), "too many
  requests", "please wait", "please try again later", "per minute", "per second", "per day", "TPM",
  "RPM", "throttl…". Since 0.99.10 it does not undo status 413, nor the codes
  `context_length_exceeded` and `request_too_large`, which say it outright.
- **Overflow wording**:
  - "context_length_exceeded" (or "context length exceeded"), "request_too_large";
  - "maximum context length", "maximum context size", "maximum context window";
  - "prompt is too long";
  - "input token count … exceeds" (within 40 characters), "input token count is N but",
    "input token(s) exceed(s)";
  - "model only supports up to";
  - "exceed(s) the maximum number of tokens";
  - "too large for (the) model with N maximum context";
  - "exceed(s) (the) context size", "… context window", "… context length", also with "available"
    or "model's" before "context";
  - "request payload size exceeds", "reduce the length of the messages", "exceed context limit";
  - "`inputs` tokens + `max_new_tokens` must be <=" and "`inputs` must have less than
    N tokens" (Text Generation Inference, Together), "loaded with context length of only" and
    "tokens to keep from the initial prompt is greater than the context length" (LM Studio),
    "input is too long for (the) (requested) model" (Amazon Bedrock).
- **The window** (`limitTokens`), the first that matches: "maximum context length is N", "maximum
  number of tokens allowed (N)" or "allowed N", "> N maximum", "with N maximum context", "configured
  limit of N tokens", "supports up to N", "context limit: A + B > N", "must be <= N", "must have
  less than N tokens", "context length of only N tokens", "Limit N, Requested" (or "Limit: N").
- **The request** (`requestedTokens`), the first that matches: "input token count (N)", "input
  token count is N", "context limit: N +", "(N in the messages", "resulted in N tokens", "too long:
  N tokens", "prompt contains N tokens", "requested (about) N tokens", "your request has N input
  tokens" (vLLM), "Given: N", "Requested N" (or "Requested: N").

Numbers may have commas ("1,048,576"). A number that is not above 0 is left out.

```ts
import { classifyModelError } from "llm-large-files";

// A request larger than the tokens a minute allows, at status 429:
// { kind: "context_overflow", limitTokens: 30000, requestedTokens: 50000 }
classifyModelError(429, "Request too large for gpt-4o in organization org-1 on tokens per min (TPM): Limit 30000, Requested 50000.");

// Any other 429 is a rate limit, even one that speaks of tokens: { kind: "rate_limit" }
classifyModelError(429, "Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.");

// Throttling wording keeps the words of a message from making it an overflow: { kind: "invalid" }
classifyModelError(400, "Input tokens exceed the limit. Please try again later.");

// Status 413 says it outright, whatever the message adds (since 0.99.10): { kind: "context_overflow" }
classifyModelError(413, "Request body too large. Please try again later with a smaller request.");

// No credit left: { kind: "quota" }
classifyModelError(402, "Insufficient Balance");

// A Gemini quota per day: { kind: "quota" }. With a quota per minute it is "rate_limit".
classifyModelError(429, "You exceeded your current quota.", {
  code: "RESOURCE_EXHAUSTED",
  details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }],
});

// Vertex AI's wording: { kind: "context_overflow", limitTokens: 1048576 }
classifyModelError(400, "The input token count exceeds the maximum number of tokens allowed 1048576.");
```

A message your provider words another way is `"invalid"`, and `askWithFiles` does not make room
for it. An adapter or a wrapper of your own can set the kind itself with the `kind` option of
[`ModelRequestError`](#modelrequesterror).

### errorKindOf(error)

```ts
declare function errorKindOf(error: unknown): ModelErrorKind | undefined;
```

The kind of a model error: the `kind` field of the value when it is a string, whatever the
string. That covers `ModelRequestError` and its subclasses, and any error of your own with the
same field. Returns `undefined` for a value without one, such as `DocumentsNotFoundError`,
`DocumentStoreError`, the default reason of an aborted signal, or a plain `Error`. Throws nothing.
New in 0.6.0.

Since 0.6.0 the adapters throw no `SyntaxError` for a reply that is not JSON: it is the `cause` of
a `ModelRequestError` of kind `"invalid"` and status 200. Test `error.cause instanceof SyntaxError`
where you tested `error instanceof SyntaxError`: kind `"invalid"` alone also covers every other
request that the provider refused.

```ts
import { errorKindOf, ModelRequestError } from "llm-large-files";

errorKindOf(new ModelRequestError("Too many requests.", 429)); // "rate_limit"
errorKindOf(new Error("socket hang up"));                       // undefined
errorKindOf({ kind: "quota" });                                 // "quota": any value with a string kind
```

### Other error classes

The adapters' errors are `ModelRequestError`s, so `instanceof ModelRequestError` and
`errorKindOf` work for all three. The four errors of the documents are not, and have no `kind`.

| Class | Exported from | Extends | Fields of its own | Reference |
|---|---|---|---|---|
| `GeminiRequestError` | `llm-large-files/gemini` | `ModelRequestError` | none | [gemini.md](./gemini.md) |
| `OpenAiRequestError` | `llm-large-files/openai` | `ModelRequestError` | `param`, `code` | [openai.md](./openai.md) |
| `AnthropicRequestError` | `llm-large-files/anthropic` | `ModelRequestError` | `type` | [anthropic.md](./anthropic.md) |
| `DocumentsNotFoundError` | `llm-large-files`, `llm-large-files/gemini` | `Error` | `ids`; `code` `"documents_missing"` and `status` 404, new in 0.9.0 | [ask.md](./ask.md#documentsnotfounderror) |
| `DocumentStoreError` | `llm-large-files` | `Error` | `code`, `syscall`, and the caught error as `cause`; `operation` (`"read"`, `"write"`, `"delete"`, `"sweep"`) and `status` 503, new in 0.9.0 | [library.md](./library.md#documentstoreerror) |
| `DocumentScopeError` | `llm-large-files` | `TypeError` | `code` (`"scope_required"`, `"scope_invalid"`, `"scope_missing"`). New in 0.9.0. The upload handlers answer `"scope_missing"` `404` "This chat no longer exists.", and the other two `500` | [library.md](./library.md#documentscopeerror) |
| `IngestError` | `llm-large-files` | `Error` | `code`, `status`, `retryAfterMs`, and the extractor's error as `cause`. New in 0.8.0. Code `"exists"` (status 409) is new in 0.9.0 | [library.md](./library.md#ingesterror) |
| `QuestionConflictError` | `llm-large-files` | `Error` | `code` `"question_conflict"`, `questionId`; no `status`. A question ID used again for another question in a `QuestionRegistry`. New in 0.99.9 | [ask.md](./ask.md#question-ids) |

`DocumentStoreError` is the store failing: retry the call. `DocumentScopeError` is a scope the call
should not have given, or should have: the same call fails again. The message of
`DocumentStoreError` names its operation, never a path or a host:

| `operation` | Message |
|---|---|
| `"read"` | `The document store could not be read (EIO). Try again.` |
| `"write"` | `The document could not be stored (EIO). Try again.` |
| `"delete"` | `The document could not be deleted (EIO). Try again.` |
| `"sweep"` | `The document store could not be cleaned up (EIO). Try again.` |
| code `"NEWER_VERSION"` | `The document was stored by a newer version of llm-large-files. Try again.` |

The library throws `"read"` from every look-up, `"write"` from `files.ingest` (code `"ETIMEDOUT"`
for a write that did not end within `ingestTimeoutMs`), `"delete"` from `files.delete` and
`"sweep"` from `files.sweep`. Until 0.9.0 the errors of writes came out as the store threw them. A
`DocumentScopeError` the store throws is never wrapped. Since 0.10.0 a store call that does not end
within `storeTimeoutMs` (30 s by default) is one of code `"ETIMEDOUT"`, and one refused at once
because `maxStuckStoreCalls` calls of the process are stuck is one of code `"STORE_STUCK"`
([`LargeFilesOptions`](./library.md#largefilesoptions)).

#### Telling errors apart across copies of the package

New in 0.9.0. Each of `ModelRequestError`, `DocumentsNotFoundError`, `DocumentStoreError`,
`DocumentScopeError` and `IngestError` has a static `is(value)`, and so does
`QuestionConflictError` (new in 0.99.9). It is `true` for an error of that
class, or of a class that extends it (`GeminiRequestError` for `ModelRequestError.is`), also when
another copy of the package made it: two versions installed side by side, or one bundled into a
dependency. `instanceof` is `false` then. `is` reads a mark that every copy puts on its errors
(`Symbol.for`), so it never throws, and is `false` for an object that only has the same `name`.

```ts
import { DocumentsNotFoundError, DocumentStoreError, IngestError } from "llm-large-files";

function statusOf(error: unknown): number {
  if (IngestError.is(error) || DocumentStoreError.is(error) || DocumentsNotFoundError.is(error)) return error.status;
  return 500;
}
```

### errorInfoOf(error)

```ts
declare function errorInfoOf(error: unknown): ErrorInfo;
```

New in 0.9.0. What any error of the library means, in one record: its category and code, the HTTP
status to answer with, whether to retry it, and an English message that is safe to show. Switch on
`category` and `code` to show your own words, in your users' language. It is built on the rules of
[`EventError`](#errors-in-events-eventerror): a model error is told by its kind, never in the
provider's words.

- It reads the errors of every copy of the package, by their brand (`IngestError.is` and the
  others), like the [`is` methods](#telling-errors-apart-across-copies-of-the-package).
- It also reads an [`EventError`](#errors-in-events-eventerror), the plain data of `run.error` and
  `ingest.error`, so that a `map` of `writeSseEvents` can word a failed question: an `IngestError`'s
  by its `code`, a `DocumentStoreError`'s and a `DocumentsNotFoundError`'s by their `name` (keeping
  their message, which the library wrote), a `DocumentScopeError`'s by its `name` and `code`, a
  model's by its `kind`, an `AbortError`'s, a `TypeError`'s and a `RangeError`'s by their name (the
  `ingest.error` of a call `ingest` refused is `"input"`, as the error), and a Node system error's by the code in
  the library's words for it ("The file could not be read from storage (ELOOP).", "Upload failed
  (ELOOP)."). The `ingest.error` of the
  [upload handlers](./node.md#upload-with-progress-accept-textevent-stream) is read the same way.
- Plain data with none of these is `"unknown"`, never a model's error: a model's `EventError`
  always has its `kind`, the kind its status, message and `code` give when the error had none of
  its own (an error of an adapter of yours, or `httpError` of the testing helpers). Plain data
  thrown, such as `{ status: 429, message }`, is not an adapter's error: it reads as
  `"unknown"`, and so does its `EventError`, which has no `kind`. Its `status` is kept when it is
  400 to 599 (the `ingest.error` of a hook of yours that threw a `409`), else 500, and it is
  `retryable` for 429, 502, 503 and 504. Before, such data with a status was read as a model's
  error: a store that failed (503) and a deleted chat (404) were "The model failed on its side" and
  "The model refused the request".
- The `message` of a model's `EventError` is kept when it is the library's own words for its kind
  ("The model failed on its side (HTTP 503)."), whatever status they name: the upload handlers'
  `ingest.error` names the provider's status in its message and the answer's (502) in `status`.
  Any other words are replaced by the library's, from its kind and `status`.
- It never throws. A value it cannot read is `"unknown"`.
- `message` never holds a path, a host, a stack or a provider's words. Log the error itself, with
  its `cause`, on the server.

| Error | `category` | `code` | `status` | `retryable` | `message` |
|---|---|---|---|---|---|
| [`IngestError`](./library.md#ingesterror) | `"ingest"` | its code: `"too_large"`, `"busy"`… | its status: 422, 413, 409, 503 | `true` for `"busy"` only, with its `retryAfterMs` | its message; for `"unreadable"`, "This file could not be read. It may be damaged, or not of the type its name says.", since its own is a parser's |
| [`DocumentStoreError`](./library.md#documentstoreerror) | `"store"` | its code, when it has one that reads as a code (capital letters, digits and `_`, as its message shows it): `"EIO"`, `"ETIMEDOUT"`, `"NEWER_VERSION"`. A driver may put a host in `code`: such a code is left out | 503 | `true`, `retryAfterMs` 5,000 | its message: "The document could not be stored (EIO). Try again." |
| [`DocumentsNotFoundError`](./ask.md#documentsnotfounderror) | `"missing"` | `"documents_missing"` | 404 | `false` | its message, which names the IDs |
| [`DocumentScopeError`](./library.md#documentscopeerror) `"scope_missing"` | `"missing"` | `"scope_missing"` | 404 | `false` | "This chat no longer exists." |
| [`ModelRequestError`](#modelrequesterror), or an error with a `kind`, or an `Error` with a `status` of 0 or 400 to 599 and no `kind` (an adapter of your own) | `"model"` | its [kind](#modelerrorkind), from its status, message and `code` (`"insufficient_quota"` is `quota`) when it has none of its own | by kind: `context_overflow` 413, `rate_limit` 429, `quota` 503, `timeout` 504, `unreachable` and `server` 502, `auth` and `invalid` 500 | `true` for `rate_limit`, `timeout`, `unreachable` and `server`, with the provider's `retryAfterMs` when it named one | by kind and status: "The model was busy (HTTP 429)." |
| An `AbortError` (a signal that aborted: the user left, the server stopped the question) | `"aborted"` | `"aborted"` | 503 | `true` | "It was stopped before it finished." |
| A `TimeoutError` (`AbortSignal.timeout`, a deadline) | `"aborted"` | `"timeout"` | 504 | `true` | "It took too long, and was stopped. Try again." |
| `DocumentScopeError` `"scope_invalid"` or `"scope_required"`, a `TypeError`, a `RangeError`, and their `EventError` | `"input"` | the scope error's code | 500 | `false` | "Something went wrong." It is a bug of the server, not something the user did. |
| [`QuestionConflictError`](./ask.md#question-ids): a question ID used again for another question. New in 0.99.9 | `"input"` | `"question_conflict"` | 409 | `false` | its message: "This questionId was already used for another question: other messages, documents or models. Use a new questionId for a new question." |
| A Node system error (a `code` and a `syscall`), such as a path `ingest` does not read (`ELOOP`, `EISDIR`, `EINVAL`, `ENOENT`), and its `EventError` | `"unknown"` | its code: `"EACCES"`, when it reads as one (capitals, digits and `_`). A code that does not, such as a host, is left out | 500 | `false` | "Something went wrong (EACCES).", or "Something went wrong." without a code |
| A Node system error whose code says the server, or a service it needs, could not answer just now ([transient](#transient-system-errors)), and its `EventError`. New in 0.10.0 | `"unknown"` | its code: `"ETIMEDOUT"`, `"ECONNRESET"`… | 503 | `true`, `retryAfterMs` 5,000; for a full disk (`ENOSPC`, `EDQUOT`) 30,000 | "The server could not do this just now (ETIMEDOUT). Try again in a moment."; for a full disk "The server has no room right now (ENOSPC). Try again later." |
| Plain data (an `EventError`) without a `kind`, and without a `code` or `name` of the rows above | `"unknown"` | none | its `status` when it is 400 to 599, else 500 | `true` for 429, 502, 503 and 504 | "Something went wrong." |
| Anything else | `"unknown"` | none | 500 | `false` | "Something went wrong." |

The statuses of model errors are those a server that asks a model for its user answers: the same as
`toUserError` in [Errors and reliability](../guides/errors-and-reliability.md#putting-it-together-a-chat-route).
The upload handlers answer with [`uploadAnswerOf`](./node.md#uploadansweroferror), which follows
the same rules for the library's errors and keeps the message of an error with a status.

#### Transient system errors

New in 0.10.0. A Node system error (one with a `code` and a `syscall`) whose code says that the
server, or a service it needs, could not answer just now is read as one to retry: `errorInfoOf`
gives status 503, `retryable: true` and `retryAfterMs` 5,000, and the upload handlers answer it
`503` with `Retry-After: 5`. A full disk is retryable too, later: 30,000 and `Retry-After: 30`.
Before 0.10.0 they were `"unknown"`, 500, and not retryable.

| Code | What it says |
|---|---|
| `ETIMEDOUT` | A call that did not answer in time: a volume, a connection, a path upload whose read did not answer within `ingestTimeoutMs` (new in 0.10.0: it was the `IngestError` `"timeout"`, 422) |
| `ECONNRESET`, `EPIPE` | A connection cut by the other end |
| `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH` | A service, a host or a network that could not be reached |
| `EAI_AGAIN` | A name that could not be looked up just now |
| `EAGAIN`, `EBUSY` | A resource busy for a moment |
| `EMFILE`, `ENFILE` | Too many files open, in the process or the system |
| `ESTALE` | A handle to a file of a network volume that the server no longer knows |
| `ENOSPC`, `EDQUOT` | A full disk, or a quota reached: 30 s to wait |

The code is read from the error itself, and from the library's words for it in an `EventError`
("Upload failed (ETIMEDOUT).", "The file could not be read from storage (ETIMEDOUT)."), whatever
status that data holds: the `ingest.error` of a 0.9 upload handler said 500. Other codes keep the
row above: 500, not retryable. A store's error is a `DocumentStoreError`, 503 whatever its code.

#### Your own words, in one switch

Switch on `category`, and on `code` where you want more detail. This one answers a Hebrew-speaking
user; [Errors and reliability](../guides/errors-and-reliability.md#your-users-words-errorinfoof) has
one for every code:

```ts
import { errorInfoOf } from "llm-large-files";

export function hebrewMessage(error: unknown): string {
  const info = errorInfoOf(error);
  switch (info.category) {
    case "ingest": return info.code === "too_large" ? "הקובץ גדול מדי." : "לא ניתן לקרוא את הקובץ.";
    case "store": return "לא ניתן לגשת לקבצים כרגע. נסו שוב בעוד רגע.";
    case "missing": return info.code === "scope_missing" ? "השיחה הזו כבר לא קיימת." : "אחד הקבצים כבר לא זמין. צרפו אותו שוב.";
    case "model": return info.retryable ? "העוזר עמוס כרגע. נסו שוב בעוד דקה." : "העוזר אינו זמין כרגע.";
    case "aborted": return "השאלה נעצרה.";
    default: return "משהו השתבש. נסו שוב מאוחר יותר."; // "input", "unknown", and later categories
  }
}
```

### `ErrorInfo`

```ts
type ErrorCategory = "ingest" | "store" | "missing" | "model" | "aborted" | "input" | "unknown";

type ErrorInfo = {
  category: ErrorCategory;
  code?: string;
  status: number;
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
};
```

New in 0.9.0. What [`errorInfoOf()`](#errorinfooferror) returns.

| Field | Type | What it holds |
|---|---|---|
| `category` | `ErrorCategory` | What kind of failure: a refused file, the store, documents or a chat that are gone, a model request, a stop, a mistake in the call, or anything else. A switch over every category must handle those a later version adds. |
| `code` | `string`, optional | More precise than the category: an `IngestErrorCode`, a `ModelErrorKind`, `"documents_missing"`, a `DocumentScopeErrorCode`, `"aborted"` or `"timeout"`, `"question_conflict"` (new in 0.99.9), or a system error's code. |
| `status` | `number` | The HTTP status to answer with: 400 to 599. |
| `retryable` | `boolean` | Whether the same call may work when it is made again, later. |
| `retryAfterMs` | `number`, optional | How long to wait first, in milliseconds, when that is known. |
| `message` | `string` | English words a user may see. Never a path, a host, a stack or a provider's words. |

### Errors in events: `EventError`

```ts
type EventError = { message: string; kind?: ModelErrorKind; status?: number; name?: string; code?: IngestErrorCode | DocumentScopeErrorCode };
```

New in 0.7.0. An error as the events of a question or an ingest carry it ([events](./events.md)):
in `retry`, in `request.end` with outcome `"error"`, in `run.error` and in `ingest.error`. It is
plain data, safe to send to a browser. The error that is thrown is unchanged, the provider's words
included: log that one.

| Field | Type | What it holds |
|---|---|---|
| `message` | `string` | Words your users may see. A model error is told by its kind and status, never in the provider's words, which can name projects, hosts or keys: "The model was busy (HTTP 429).", "The model's quota has run out (HTTP 429).", "The model could not be reached.", "The model refused the key or token it was sent (HTTP 401)." A Node system error is told by its code ("The file could not be read from storage (ENOENT)."), when the code reads as one (capitals, digits and `_`; since 0.9.0: a driver may put a host in `code`), a `DocumentStoreError` by its own message, which names only its code, and a store that failed to write in `ingest.error` as "The document could not be stored. Try again later." (with `name` `"DocumentStoreError"` and `status` 503 since 0.9.0). The library's own errors (a refused file, `DocumentsNotFoundError`, an abort, the error a listener threw) keep their message, and so does any other `Error` without a `kind` or a numeric `status`, such as one an adapter or a token function of your own throws: give such errors a status, or words of your own. A status that is not a model's (not 0 or 400 to 599), and plain data thrown with a status (`{ status: 429, message }`), are "Something went wrong.", as `errorInfoOf` reads them (since 0.9.0; before, a model's words). A value that is not an `Error` is "Something went wrong.". |
| `kind` | [`ModelErrorKind`](#modelerrorkind), optional | For a model error: its kind, as [`errorKindOf`](#errorkindoferror) reads it. Since 0.9.0 also for an `Error` with a `status` of 0 or 400 to 599 and no `kind` of its own (an adapter of yours, `httpError` of the testing helpers): the kind its status, message and `code` give ([`classifyModelError`](#classifymodelerrorstatus-message-signals)), as its message is told and as `errorInfoOf` reads the error. Not for plain data thrown (an object of no class), and never for the library's own errors (`DocumentStoreError`, `DocumentsNotFoundError`, `IngestError`, `DocumentScopeError`). |
| `status` | `number`, optional | For an HTTP error: its status. 0 when no answer came. Since 0.9.0 also the status of the library's own errors: 503 for `DocumentStoreError`, 404 for `DocumentsNotFoundError`, and for an `IngestError` the status of every code but those of 422 (413, 409, 503). |
| `name` | `string`, optional | The error's class name: `"ModelRequestError"`, `"GeminiRequestError"`, `"AbortError"`, `"DocumentsNotFoundError"`, `"DocumentStoreError"`, `"DocumentScopeError"`, `"IngestError"`, `"TypeError"`… Since 0.9.0 a store's own subclass of `DocumentStoreError` (one named `"BucketStoreError"`) is named `"DocumentStoreError"` here, and an extractor's own subclass of `IngestError` (one named `"OcrRefusal"`) `"IngestError"`, so that `errorInfoOf` reads them as a store's failure and a refused file. |
| `code` | [`IngestErrorCode`](./library.md#ingesterror) or [`DocumentScopeErrorCode`](./library.md#documentscopeerror), optional | For a file `ingest` could not read: why (`"too_large"`, `"no_text"`, `"busy"`, `"exists"`…). New in 0.8.0. Since 0.9.0 also, with `name` `"DocumentScopeError"`, why a scope could not be used: `"scope_missing"` (the chat was deleted), `"scope_invalid"` or `"scope_required"`. A table typed `Record<IngestErrorCode, string>` must check the code before it looks it up. |

To show your own words, map the error by `kind`, `status` or `name`, as you would the thrown one
(see [Errors and reliability](../guides/errors-and-reliability.md)).

## Retries

### withRetry(run, options)

```ts
declare function withRetry<T>(run: () => Promise<T>, options?: {
  retry?: RetryOptions | undefined;
  signal?: AbortSignal | undefined;
  canRetry?: () => boolean;
  onRetry?: (notice: RetryNotice) => void;
  unknownErrors?: "once" | "never";
}): Promise<T>;
```

Runs `run`, and runs it again when it failed in a way that another try can mend. It is the rule
`askWithFiles` and `askGemini` use for each chat request, and the whole-file part reads use for
each part. It reads three fields of what `run` throws, so any error with them works, not only a
`ModelRequestError`: `status` (a finite number), `kind` and `retryAfterMs`. An error without a
`kind` also has its `message` and `code` read, for the kind they give. `run` is called again as it
is: build the request inside it.

| Option | Type | Default | What it does |
|---|---|---|---|
| `retry` | [`RetryOptions`](#retryoptions) | the `RetryOptions` defaults: 3 retries, a base wait of 500 ms before the jitter, at most 60,000 ms | How many times, and how long the waits are. |
| `signal` | `AbortSignal` | none | Once it has aborted, a failure is thrown as it is. A wait that is under way ends with the signal's reason. |
| `canRetry` | `() => boolean` | always true | Asked after each failure. `false` throws the error as it is: return `false` once the attempt did something that must not happen twice. `askWithFiles` returns `false` once text of the reply was shown: passed to `onText` and the `text` events as it streamed (see [retries in events](#retries-in-events)). |
| `onRetry` | `(notice: RetryNotice) => void` | none | Called before each wait with a [`RetryNotice`](#retrynotice): the error, `attempt` (the number of the retry to come, counting every retry made so far, the one of `unknownErrors` included: 1 for the first) and `delayMs` (the wait). Not called for the retry of an error without a status, which has no wait. `askWithFiles` turns it into an `onActivity` line such as "The model did not answer (HTTP 503). Trying again in 2 s…", "The model could not be reached. Trying again…", or, for a reply that began and was cut off on its way, "The model's reply was cut off on its way. Trying again…", and into a `retry` event. |
| `unknownErrors` | `"once" \| "never"` | `"never"` | An error without a numeric `status` (a bug in `run`, the abort error of a time limit of your own): `"once"` runs it once more at once, without a wait; any other value throws it. The part reads of a whole-file read use `"once"`; the chat requests of the loop do not. |

What happens to an error, checked in this order:

1. The signal has aborted, or `canRetry()` returned `false`: it is thrown.
2. Its `kind` is `"quota"` or `"context_overflow"`: it is thrown. A wait does not mend a daily cap
   or an empty balance, and only a smaller request passes a limit of size, whatever its status
   (OpenAI's request larger than the tokens a minute allows comes as 429). 0.5.0, which had no
   kinds, sent both again when their status was 0, 408, 409, 429 or 500 and more. An error without
   a `kind` of its own that has a `status` of 0 or 400 to 599 (an adapter of yours, `httpError`)
   has the kind [`classifyModelError`](#classifymodelerrorstatus-message-signals) gives its status,
   message and `code`, as its events have it: a 429 of code `"insufficient_quota"` is a quota, and
   is thrown. Plain data thrown (an object of no class) has no kind. New in 0.9.0: such an error
   was sent again by its status, while its `retry` event and `errorInfoOf` called it not retryable.
3. The provider said not to send it again: the adapter took note of Claude's
   `x-should-retry: false`. It is thrown, whatever its status. The note is internal: an error of
   your own cannot carry it.
4. Its `kind` is `"timeout"` and its `status` 0 (the adapter's wait on a silent model ran out): the
   first in the whole run goes on to the checks below, like any status-0 failure; a second one is
   thrown. A 408 follows the rules below.
5. It has no numeric `status`: see `unknownErrors`.
6. Its status is one that [`isRetryableStatus`](#isretryablestatusstatus) refuses (400, 401, 403,
   404, 413, 422…): it is thrown.
7. `retries` retries were made already: it is thrown.
8. Otherwise `run` is called again after a wait. When the error has a `retryAfterMs` (a finite
   number, 0 or more), the wait is that; when that is longer than `maxDelayMs`, the error is
   thrown at once instead. Without one, the wait is `baseDelayMs × 2^n × (0.5 + random() / 2)`,
   where n is the number of retries made so far, and never more than `maxDelayMs`. With the
   defaults: 250 to 500 ms, then 500 to 1,000 ms, then 1,000 to 2,000 ms.

Every retry counts towards `retries`, the one after a silent model and the one of `unknownErrors`
included, so `retries: 0` turns them all off. The one of `unknownErrors` is still made when the
other retries have used up `retries`. Each call of `withRetry` has its own count.

Returns what `run` resolves to. Throws the last error of `run` as it came, not wrapped; or, when
the signal aborts during a wait, the signal's reason (with the default `sleep`).

```ts
import { withRetry } from "llm-large-files";

// post() is the function of the ModelRequestError sample above.
const controller = new AbortController();
const reply = await withRetry(
  () => post(`${process.env.MODEL_URL}/generate`, { prompt: "A title for this chat." }, controller.signal),
  {
    retry: { retries: 2, maxDelayMs: 20_000 },
    signal: controller.signal,
    onRetry: ({ attempt, delayMs }) => console.warn(`Retry ${attempt} in ${Math.round(delayMs)} ms`),
  },
);
```

How the loop retries and what your users see meanwhile:
[Errors and reliability](../guides/errors-and-reliability.md).

### `RetryOptions`

```ts
type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};
```

How a model request that failed is sent again. It is the `retry` option of `askWithFiles`
([`AskOptions`](./ask.md#askoptions)), of `askGemini` ([gemini.md](./gemini.md)), of
`files.tools()` ([`ToolOptions`](./library.md#tooloptions)) and of `withRetry`. In `askWithFiles`
and `askGemini` it applies to the chat requests and to the part reads of a whole-file read; in
`files.tools()`, to the part reads.

| Field | Type | Default | What it does |
|---|---|---|---|
| `retries` | `number` | 3 | How many times a failed request is sent again: at most 4 tries with the default, 5 when `unknownErrors: "once"` also retries an error without a status. A value that is not a finite number (`NaN`, `Infinity`, `-Infinity`, a string) counts as not set: 3. Any other number is cut to a whole number; 0 or less turns retries off. |
| `baseDelayMs` | `number` | 500 | The first wait, in milliseconds, before the jitter. Each later wait is twice as long. A value that is not a finite number (`NaN`, `Infinity`, `-Infinity`, a string) counts as not set: 500; any other negative number counts as 0. |
| `maxDelayMs` | `number` | 60,000 | The longest wait, in milliseconds. A computed wait is cut to it. When the provider asks for a longer one (`retryAfterMs`), the request is not sent again and the error is thrown at once. A value that is not a finite number (`NaN`, `Infinity`, `-Infinity`, a string) counts as not set: 60,000; any other negative number counts as 0. To allow longer waits, give a larger finite number, not `Infinity`. |
| `sleep` | `(ms, signal?) => Promise<void>` | a timer that ends early, with the signal's reason, when the signal aborts | For tests: the wait itself. It gets the `signal` of `withRetry`. |
| `random` | `() => number` | `Math.random` | For tests: the source of the jitter, a number from 0 up to 1. The wait is multiplied by `0.5 + random() / 2`: `() => 0` gives the shortest waits, `() => 1` the longest. |

```ts
import { ModelRequestError, withRetry, type RetryOptions } from "llm-large-files";

// In a test: record the waits instead of waiting, and take the shortest ones.
const waits: number[] = [];
const retry: RetryOptions = { random: () => 0, sleep: async (ms) => { waits.push(ms); } };

let tries = 0;
const value = await withRetry(async () => {
  if (++tries < 3) throw new ModelRequestError("The model is overloaded.", 503);
  return "done";
}, { retry });
console.log(value, tries, waits); // "done" 3 [250, 500]
```

Testing an integration without a real model: [Testing](../guides/testing.md).

### `RetryNotice`

```ts
type RetryNotice = {
  error: unknown;
  attempt: number;
  delayMs: number;
};
```

What [`withRetry`](#withretryrun-options) passes to its `onRetry` option before each wait. The retry
of an error without a status has no wait, and no notice. The type is exported so that you can write
the handler apart from the call.

| Field | Type | What it holds |
|---|---|---|
| `error` | `unknown` | The error of the attempt that failed, as `run` threw it. |
| `attempt` | `number` | The number of the retry to come, 1 for the first. It counts every retry made so far, the one of `unknownErrors: "once"` included, which has no notice. |
| `delayMs` | `number` | How long it waits, in milliseconds, before it sends the request again: the error's `retryAfterMs`, or the computed wait (see [`withRetry`](#withretryrun-options)). |

```ts
import { withRetry, type RetryNotice } from "llm-large-files";

// One handler for the retries of every request of your own.
const logRetry = ({ attempt, delayMs, error }: RetryNotice): void => {
  console.warn(`Retry ${attempt} in ${Math.round(delayMs)} ms:`, error);
};

// post() is the function of the ModelRequestError sample above.
const title = await withRetry(
  () => post(`${process.env.MODEL_URL}/generate`, { prompt: "A title for this chat." }),
  { onRetry: logRetry },
);
```

### Retries in events

New in 0.7.0. With `onEvent` (or [`askStream`](./ask.md#askstreamoptions)), each retry of a question
is a `retry` event, between the `request.start` and the `request.end` of its request:

```ts
import type { AskEvent } from "llm-large-files";

const event: AskEvent = { type: "retry", requestId: "req_3", attempt: 1, delayMs: 2000,
  error: { message: "The model failed on its side (HTTP 503).", kind: "server", status: 503, name: "GeminiRequestError" },
  message: "The model did not answer (HTTP 503). Trying again in 2 s…", seq: 9, runId: "run_…", time: 1795000000000 };
```

- **Structured, and safe to show.** `attempt` and `delayMs` are those of the
  [`RetryNotice`](#retrynotice). `error` is an [`EventError`](#errors-in-events-eventerror): told by
  its kind and status, never in the provider's words. `message` is the line `onActivity` gets.
- **The retries of whole-file reads are visible.** The requests of `analyze_whole_document` are
  `request.start` events with `role: "reader"` and the `callId` of their call, and their retries
  are `retry` events. Earlier versions, and `onActivity` still, did not tell them.
- **A reply that fails after its first text is not sent again.** With `streamText` (on by default
  with `onText`, and in `askStream`), the text comes as it is written, and once some of it was
  shown the request is not retried: its `request.end` has outcome `"error"`, and the question
  throws. With `streamText: false`, a reply's text comes once the reply is in, so a reply that
  fails on its way is sent again by the rule above, at the cost of a longer wait for the first
  word; the whole reply must then arrive within the adapter's `firstByteTimeoutMs`. A listener of
  the events alone does not ask for streaming.
- **The end tells the outcome.** `request.end` comes once for each request, after its retries,
  with `ms` from its start, waits included. An overflow made smaller is a new request: the first
  ends with an `EventError` of kind `"context_overflow"`.

### isRetryableStatus(status)

```ts
declare function isRetryableStatus(status: number): boolean;
```

Whether a request that failed with this status is worth sending again: `true` for 0 (no answer),
408, 409, 429 and every status from 500 up; `false` for every other, such as 400, 401, 403, 404,
413 and 422, which the provider would refuse again. Throws nothing. `withRetry` uses it after the
checks of `kind` (a `"quota"` or `"context_overflow"` error with status 429 is not sent again).

```ts
import { isRetryableStatus } from "llm-large-files";

isRetryableStatus(529); // true: Claude's "overloaded"
isRetryableStatus(400); // false
```

### retryAfterMs(headers, body, now)

```ts
declare function retryAfterMs(headers: Headers | undefined, body?: unknown, now?: () => number): number | undefined;
```

The wait a provider asked for, in milliseconds. It looks in three places and takes the first that
gives one:

1. The `retry-after-ms` header: a number, 0 or more, taken as it is.
2. The `Retry-After` header: a number of seconds, 0 or more (decimals are rounded to the
   millisecond), or an HTTP date: the time from `now()` until then, 0 when it has passed.
3. In the body, `error.details`: the first entry with a `retryDelay` written in seconds, such as
   `"17s"` or `"34.5s"`. That is Gemini's `google.rpc.RetryInfo`.

A header that is neither is passed over, and the next place is tried. In Node, a negative
`Retry-After` number reads as a past date and gives 0. Header names do not depend on case.

| Parameter | Type | Default | What it is |
|---|---|---|---|
| `headers` | `Headers \| undefined` | required | The headers of the response. `undefined` reads the body only. |
| `body` | `unknown` | none | The error body, parsed from JSON. |
| `now` | `() => number` | `Date.now` | The time now, in milliseconds, for a `Retry-After` date. For tests. |

Returns the wait, or `undefined` when none was asked for. Throws nothing.

```ts
import { retryAfterMs } from "llm-large-files";

retryAfterMs(new Headers({ "retry-after": "17" }));                          // 17000
retryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "17" })); // 250
retryAfterMs(undefined, {
  error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34.5s" }] },
}); // 34500
```

## Waits on a reply

### `DEFAULT_FIRST_BYTE_TIMEOUT_MS`

```ts
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 600_000; // 10 minutes
```

The default `firstByteTimeoutMs` of the adapters: the longest wait for the first piece of a reply.
Headers do not count, since some servers send them at once. It is long because a model that thinks
sends nothing while it does (Gemini without its thoughts, OpenAI's reasoning models), and a reply
that is not streamed comes whole at the end. New in 0.6.0.

### `DEFAULT_IDLE_TIMEOUT_MS`

```ts
const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes
```

The default `idleTimeoutMs` of the adapters: the longest wait between two pieces of a reply once
it has started to arrive. An event of a stream, a keep-alive and a piece of a body all count. A
model that is writing sends something well within it. New in 0.6.0.

### `IdleWaits`

```ts
type IdleWaits = {
  firstByteTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
};
```

How long an adapter waits on a chat request that sends nothing. `gemini()`, `askGemini`,
`openAiCompatible()` and `anthropic()` take these two options under the same names (see
[gemini.md](./gemini.md), [openai.md](./openai.md), [anthropic.md](./anthropic.md)). The type is
exported so that you can keep the pair in one setting; the watch itself is internal. New in 0.6.0.

| Field | Type | Default | What it does |
|---|---|---|---|
| `firstByteTimeoutMs` | `number` | 600,000 ([`DEFAULT_FIRST_BYTE_TIMEOUT_MS`](#default_first_byte_timeout_ms)) | The longest wait, in milliseconds, from the start of a chat request to the first piece of its reply. Headers do not count. |
| `idleTimeoutMs` | `number` | 300,000 ([`DEFAULT_IDLE_TIMEOUT_MS`](#default_idle_timeout_ms)) | The longest wait, in milliseconds, between two pieces of the reply once it has started. Keep-alives count. |

- `undefined` takes the default. 0, or any value that is not a positive finite number, waits
  without end; each of the two can be turned off alone.
- When a wait runs out, the adapter aborts the request and throws its error with `status` 0 and
  `kind` `"timeout"`: "Gemini sent nothing for 600 s.", "The model sent nothing for 600 s."
  (OpenAI-compatible) or "Claude sent nothing for 600 s.". The loop sends it again once, by the
  rule of [`withRetry`](#withretryrun-options), unless text of it was already shown. The error
  comes when the wait runs out, also with a `fetch` whose body never settles its `cancel()`.
- The waits are new in 0.6.0: 0.5.0 waited on a silent model without end.
- A reply that keeps arriving has no time limit.
- The waits watch the chat requests (`send`). The part reads of a whole-file read have a time
  limit of their own: see the adapter's page.

```ts
import { GoogleAuth } from "google-auth-library";
import type { IdleWaits } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, vertexAi } from "llm-large-files/gemini";

// One setting for every adapter of the app: give up sooner than the defaults.
const waits: IdleWaits = { firstByteTimeoutMs: 120_000, idleTimeoutMs: 60_000 };

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const model = gemini(vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
}), waits);
const claude = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-5-5", ...waits });
```

Choosing the waits, and proxies that cut a quiet stream sooner:
[Errors and reliability](../guides/errors-and-reliability.md) and
[Deployment](../guides/deployment.md).

## Streams

### parseSseJson(stream, hooks)

```ts
declare function parseSseJson<T>(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
  hooks?: SseHooks,
): AsyncGenerator<T>;
```

Parses a `text/event-stream` body into one JSON value for each event. The body is a web stream
(`response.body` of the global `fetch`) or any async iterable of bytes or strings (a Node stream,
from node-fetch and the like). The adapters read their streams with it, and
`llm-large-files/gemini` exports the same function.

- An event ends at a blank line. Lines may end with LF, CRLF or a CR alone (a CR alone since
  0.6.0). The bytes are decoded as UTF-8 across pieces, so an event, a line ending or a character
  cut between two reads is put together. Each piece is read once, however long the event it belongs
  to: one event of 8 MB in pieces of 16 KB, in memory, took 0.97 to 1.19 s in 0.5.0, and takes 10
  to 20 ms in 0.6.0, on Node 24 on Windows ([Measurements](../measurements.md#the-server)). On a
  machine busy with other Node processes, the same function at 5157e7f (main before the last changes
  of 0.6.0), which reads a stream as 0.5.0 does, took 1.1 to 3.6 s, and 0.6.0 takes 11 to 46 ms.
- Only `data:` lines count: the text after `data:`, without its leading white space. The `data:` lines
  of one event are joined with a newline. Comments (`: …`), `event:`, `id:` and `retry:` lines are
  passed over.
- An event without data gives nothing. `data: [DONE]` gives nothing and calls `onDone`.
- A last event that no blank line follows is read when the stream ends.
- The data of each event goes through `JSON.parse` and is yielded as `T`, unchecked.
- One event may hold at most `hooks.maxEventLength` characters, 64,000,000 by default (new in
  0.6.0). A longer one ends the stream with an error, whether it comes whole or in pieces: a server
  that never ends an event holds at most that many characters of your server's memory for each
  stream it sends. The limit is not on all streams together.

Throws a `SyntaxError` for an event whose data is not JSON (it is not passed over), the signal's
reason when `hooks.signal` aborts, and any error of the stream itself. For an event past
`maxEventLength` it throws an `SseEventTooLongError` (exported from `llm-large-files` and
`llm-large-files/gemini`, new in 0.6.0; its `limit` holds the limit), whose message is
`An event of the stream held more than 64,000,000 characters.`, the number being the limit in the
en-US way. The adapters turn it into their own
error, of kind `"invalid"`, that is not sent again (see their pages). Leaving the loop early
(`break`, `return`, a throw), or the end of the stream, ends the reading: a web stream's reader is
cancelled, and an async iterable's `return()` is called. Neither is waited for: a `cancel()` or
`return()` that never settles, that gives no promise, or that throws neither holds nor fails the
caller.

```ts
import { parseSseJson } from "llm-large-files";

type Chunk = { choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }> };

// Give up when nothing arrives for 60 s: each piece of the stream starts the wait again.
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
const arm = () => {
  clearTimeout(timer);
  timer = setTimeout(() => controller.abort(new Error("Nothing arrived for 60 s.")), 60_000);
};
arm();

let done = false;
let finished = false;
try {
  const response = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "Say hello." }] }),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

  for await (const chunk of parseSseJson<Chunk>(response.body, { onData: arm, onDone: () => { done = true; }, signal: controller.signal })) {
    process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
    if (chunk.choices?.[0]?.finish_reason) finished = true;
  }
} finally {
  clearTimeout(timer);
}
// A stream that closes with neither a finish_reason nor [DONE] was cut off on its way.
if (!done && !finished) throw new Error("The reply ended before it was complete.");
```

A Gemini stream (`streamGenerateContent?alt=sse`) reads the same way; it sends no `[DONE]`.
Streaming an adapter of your own: [Your own adapter and loop](../guides/own-adapter-and-loop.md).

### `SseHooks`

```ts
type SseHooks = {
  onData?: () => void;
  onDone?: () => void;
  signal?: AbortSignal | undefined;
  maxEventLength?: number;
};
```

What [`parseSseJson`](#parsessejsonstream-hooks) tells you as the stream goes, and the most one
event may hold. New in 0.6.0: 0.5.0's `parseSseJson` took the stream alone.

| Field | Type | Default | What it does |
|---|---|---|---|
| `onData` | `() => void` | none | Called for each piece of bytes that arrives, before it is parsed: an event, part of one, or a keep-alive comment. Use it to start a wait on silence again. |
| `onDone` | `() => void` | none | Called when an event's data is `[DONE]`, which OpenAI-compatible servers send at the end. The OpenAI-compatible adapter takes a stream that closes with neither `[DONE]` nor a `finish_reason` as cut off on its way. |
| `signal` | `AbortSignal \| undefined` | none | When it aborts, the next piece is not waited for: the generator throws the signal's reason, and the body is ended. |
| `maxEventLength` | `number` | 64,000,000 | The most characters one event may hold: what its data lines hold after `data:` and the spaces after it, and the line feeds that join them. A line of another field (a comment, `event:`, `id:`) counts in full with the event while it is read, as it is held until its end. A longer event ends the stream with an error named `SseEventTooLongError`, however the stream is cut into pieces. `Infinity` sets no limit; a value that is not a positive number counts as not set. New in 0.6.0. |
