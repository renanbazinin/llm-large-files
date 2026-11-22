# Errors and reliability

This guide is for anyone who calls `askWithFiles` or `askGemini` from a server. It says what the
library does on its own when a model request fails, what reaches your code when that is not
enough, and how to turn each error into a message for your user and an HTTP status. The exact
signatures are in [the reference for errors and retries](../reference/errors-and-retries.md).

The samples assume what a question needs: `files` from `createLargeFiles`, `endpoint` from
`vertexAi()` (see [Getting started](../getting-started.md) and
[Gemini and Vertex AI](./vertex-and-gemini.md)), and the question's `documentIds`, `messages` and
`owner`.

## What the library does for you

A question makes many model requests. Most failures are handled inside it, and your code never
sees them:

- A request that failed in a way another try can mend (no answer, HTTP 408, 409, 429 or 5xx) is
  sent again, up to 3 more times, after a wait that doubles or the wait the provider asked for. See
  [Retries](#retries).
- A request that gets nothing from the model for 10 minutes before its reply, or for 5 minutes in
  the middle of it, is aborted and sent again, once. See
  [Waits on a silent model](#waits-on-a-silent-model).
- A request larger than the model takes, or than the tokens the provider allows in a minute, is
  made smaller and sent again, or the documents are planned again for a smaller request. See
  [A request too large for the model](#a-request-too-large-for-the-model).
- A first reply with nothing in it, a tool call that cannot be read, and an answer that comes back
  without text are asked for once more. See [Empty or broken turns](#empty-or-broken-turns).
- A streamed reply that stops before its end is sent again, when none of it was shown. See
  [A stream cut off](#a-stream-cut-off).
- A tool that fails (a pattern that does not compile, a store that did not answer, a whole-file
  read whose parts all failed) returns its error to the model, which tries another way. Nothing is
  thrown. See [Failures inside tools](#failures-inside-tools).

What is left for you: catch what the question throws, show your own words for it, keep what a
failed question found, check `answered`, and set an overall deadline.

## What a question can throw

`askWithFiles` and `askGemini` throw the same errors:

| Error | When | Fields to use | `partialResultOf` |
|---|---|---|---|
| `DocumentsNotFoundError` | A document ID was never uploaded, has expired, was deleted, or belongs to another `owner`. Thrown before any model request. | `ids`: the IDs that are missing. | No |
| `DocumentStoreError` | The store could not be read while the question planned its documents: a volume that did not answer, a database that is down. The documents are not gone, and the same question may work a moment later. | `code` (`EIO`, `EMFILE`) and `syscall` when a system error is behind it; `cause`, the error that was caught. | No |
| `ModelRequestError`: a `GeminiRequestError`, `OpenAiRequestError` or `AnthropicRequestError` | A model request failed in a way that was not worth sending again, or still failed after the retries. A reply of HTTP 200 whose body is not JSON (a gateway's page in the model's place) is one too, of kind `invalid`, with status 200 and the `SyntaxError` as `cause`; it is not sent again. A reply of HTTP 200 whose body is empty is of kind `unreachable`, status 0, and is sent again first. | `kind`, `status` (0 when no answer came, or the reply stopped on its way), `retryAfterMs`, `limitTokens`, `requestedTokens`, `cause`. `OpenAiRequestError` adds `param` and `code`; `AnthropicRequestError` adds `type`. | Yes |
| The reason of your `signal` | You stopped the question, or your deadline ran out. See [An overall deadline](#an-overall-deadline). | Test your signals, not the error. | Yes, for a reason that is an object |
| `Error` | A mistake in the call: "The last message must be the user's.", or a budget that cannot work, such as "budget.reservedTokens (…) must be smaller than budget.contextTokens (…): nothing would be left for the conversation." | `message`, for your log. | No |

Until 0.6.0, a reply of HTTP 200 that was not JSON threw a `SyntaxError`, with no `status` (a
streamed Gemini request got an empty reply instead). Now the `SyntaxError` is the `cause` of the
`ModelRequestError`: where you tested
`error instanceof SyntaxError`, test `error.cause instanceof SyntaxError`. Kind `invalid` alone
also covers every other request that the provider refused.

Whose words each message is:

- `DocumentsNotFoundError`: "A document is no longer available: doc_…. Upload it again." It names
  document IDs. Your user knows the files by name, so map the IDs to the names you keep with the
  chat.
- `DocumentStoreError`: "The document store could not be read (EIO). Try again." It is written to
  be shown: it names no path and no host. Log its `cause` on the server.
- `ModelRequestError`: the provider's own message, or, when it gave none, the adapter's: "Gemini
  returned HTTP 503.", "The model returned HTTP 503." (OpenAI-compatible, and Gemini's part reads)
  or "Claude returned HTTP 503.". It can name your project, model, region or quota. Log it, and
  show your own words, chosen by its [`kind`](#the-kind-of-a-model-error). The adapters' own
  messages, with "Gemini's", "The model's" or "Claude's" first:
  - a reply of HTTP 200 that is not JSON: "Gemini's reply could not be read: it was not JSON
    (text/html). A proxy or gateway may have answered in its place." The part in parentheses is the
    content type of the reply, and is left out when it has none;
  - a reply of HTTP 200 that is empty: "Gemini could not be reached (the reply was empty).", "The
    model could not be reached (the reply was empty)." or "Claude could not be reached (the reply
    was empty).";
  - a streamed event longer than 64,000,000 characters: "Gemini's reply could not be read: an event
    of its stream held more than 64,000,000 characters."

### Telling them apart

Use `instanceof` for the classes, and `errorKindOf(error)` for the kind. `errorKindOf` reads the
`kind` field of any error that has one, so it also works when two copies of the package are
installed side by side, where `instanceof` fails. The four model error classes are all
`ModelRequestError`.

| Export | Entry point |
|---|---|
| `ModelRequestError`, `errorKindOf`, `classifyModelError`, `DocumentsNotFoundError`, `DocumentStoreError`, `partialResultOf` | `llm-large-files` |
| `GeminiRequestError`, and `DocumentsNotFoundError` and `partialResultOf` again | `llm-large-files/gemini` |
| `OpenAiRequestError` | `llm-large-files/openai` |
| `AnthropicRequestError` | `llm-large-files/anthropic` |

## The kind of a model error

`kind` is told from the HTTP status, the provider's message, and the provider's own word for the
error (Gemini's `error.status` and `details`, OpenAI's `error.code`, Claude's `error.type`):

| `kind` | Cause | Sent again | What to tell the user |
|---|---|---|---|
| `context_overflow` | The request was larger than the model takes: its context window, or the size of the body (HTTP 413). Or larger than the tokens the provider lets through in a minute, which only a smaller request can pass: OpenAI's "Request too large for gpt-4o … on tokens per min (TPM): Limit 30000, Requested 45237" (HTTP 429), and Groq's "… on tokens per minute (TPM): Limit 6000, Requested 6438" (HTTP 413 or 429). `limitTokens` and `requestedTokens` are the provider's numbers, when its message gives them. | Never by the retry rule, whatever its status. The loop makes the request smaller, at most twice, or plans the documents again, once. It throws when neither helps. | "This chat is too long for the model. Start a new chat, or ask about fewer files." |
| `quota` | A quota that does not come back soon: OpenAI's `insufficient_quota`; HTTP 402 (DeepSeek's "Insufficient Balance", OpenRouter's "Insufficient credits"); Claude's "Your credit balance is too low" and its spending limits ("You have reached your API usage limits", or HTTP 429 with `enforced_spend_limit_reached`); a Gemini quota per day (HTTP 429 with a `QuotaFailure` whose quota is per day, or a Vertex AI quota per day that only the message names). | Never. | "The assistant is not available right now." Alert whoever runs the account. |
| `rate_limit` | Too many requests or tokens for now: any other HTTP 429, a Gemini quota per minute among them. | Up to `retries` times, after the wait the provider asked for, or a wait that doubles. Not when the provider asks for more than `maxDelayMs`. | "The assistant is busy. Try again in a minute." Use `retryAfterMs` when it is set. |
| `timeout` | Status 0: nothing came from the model for the adapter's wait (`firstByteTimeoutMs`, `idleTimeoutMs`). Or HTTP 408 from the provider or a gateway. | The adapter's wait: once. HTTP 408: up to `retries` times. | "The model took too long to answer. Try again." |
| `unreachable` | Status 0: the connection failed, before or during the reply, a stream ended before its end, or a reply of HTTP 200 came empty. | Up to `retries` times. | "The model could not be reached. Try again." |
| `server` | HTTP 5xx: the provider failed on its side. Claude's 529 (overloaded) and DeepSeek's `insufficient_system_resource` (taken as 503) are among them. | Up to `retries` times. | "The model could not answer just now. Try again." |
| `auth` | HTTP 401 or 403, or a Gemini API key that is not valid (`API_KEY_INVALID`, which comes as HTTP 400). | Never. | A general error. It is your configuration: an expired token, a wrong key, a missing role. Log it. |
| `invalid` | Any other HTTP 4xx, or an error a Gemini reply reported after HTTP 200 without a status of its own (see [A stream cut off](#a-stream-cut-off)): the provider refused the request as it was. Also a reply of HTTP 200 that is not JSON (a gateway's page), and a streamed event longer than 64,000,000 characters, both with status 200. | Never, except HTTP 409, which is sent again like a 5xx. | A general error. Log it, with the model and its options. |

Nothing is sent again once text of the reply was shown to the user, or after your `signal`
aborted.

The kind depends on the provider's wording. The wording of Gemini, Vertex AI, OpenAI, Claude, vLLM,
Mistral and llama.cpp for a request too large is known, and so is that of Text Generation Inference
and Together ("`inputs` tokens + `max_new_tokens` must be <= 32769. Given: 40000 …"), LM Studio
("loaded with context length of only 4096 tokens"), Amazon Bedrock ("Input is too long for
requested model.") and vLLM's newer "your request has 40000 input tokens". An OpenAI-compatible
server's message is read from `error`, from a `message` at the top of the body (vLLM before its
OpenAI-shaped errors, SGLang, FastChat) or from FastAPI's `detail`. Throttling that shares words
with a request too large ("tokens per minute") is not taken for one, except the TPM refusal of a
single request larger than the minute's allowance. A message the classifier does not know is
`invalid`, and the loop does not recover from it.
`classifyModelError(status, message, { code, details })` shows how a message is read. An adapter
of your own, or a wrapper around a gateway, can set the kind itself:
`new ModelRequestError(message, 400, { kind: "context_overflow" })`. See
[Your own adapter and loop](./own-adapter-and-loop.md).

## Retries

Every model request of a question, the chat's and the part reads of a whole-file read, is sent
again by one rule (`withRetry`), each request on its own count:

- **What is sent again**: an error with status 0 (no answer), 408, 409, 429 or 5xx
  (`isRetryableStatus`).
- **How often**: up to `retries` more times (3). A wait on a silent model that ran out (status 0,
  kind `timeout`) is sent again only once: another such wait is long, and a model that went silent
  twice will most likely do so again.
- **How long it waits**: `baseDelayMs` (500), twice as long for each earlier try, with jitter: 0.25
  to 0.5 s, then 0.5 to 1 s, then 1 to 2 s, and never more than `maxDelayMs` (60 s). When the
  provider asks for a wait (a `Retry-After` header in seconds or as a date, `retry-after-ms`, or the
  `retryDelay` of Gemini's `RetryInfo`, such as "17s"), that wait is used instead. When it asks for
  more than `maxDelayMs`, the request is not sent again: the error is thrown, with `retryAfterMs`
  set.
- **What is not sent again**: a `quota` error; a `context_overflow` error, whatever its status (a
  TPM refusal comes as HTTP 429: only a smaller request can pass); an error the provider said not
  to send again (Claude's `x-should-retry: false` header), whatever its status; any other status
  (400, 401, 403, 404, 413…), among them a reply of HTTP 200 that is not JSON and a streamed event
  too long to read (kind `invalid`, status 200); a chat request whose error has no status; a
  request once text of it was shown to the user; anything after your `signal` aborted.
- **Part reads** of a whole-file read also try once more, at once, an error that has no status,
  their own time limit among them. A part that still fails is reported to the model as a part that
  could not be read, and the question goes on.

While a chat request waits to be sent again, `onActivity` gets a line such as "The model did not
answer (HTTP 429). Trying again in 17 s…", "The model could not be reached. Trying again…" (no
reply began), "The model's reply was cut off on its way. Trying again…" (a stream that closed
before its end, a connection that broke once the reply had begun, or a reply of HTTP 200 that came
empty) or "The model sent nothing for too long. Trying again…". Show it as a passing status.

Set the rule with `retry`, an option of `askWithFiles` and `askGemini` that also applies to part
reads: `retries` (3; 0 turns retries off, the one after a silent model too), `baseDelayMs` (500)
and `maxDelayMs` (60,000). Every field:
[`RetryOptions`](../reference/errors-and-retries.md#retryoptions).

```ts
import { askGemini } from "llm-large-files/gemini";

const result = await askGemini({
  files,
  endpoint,
  documentIds,
  messages,
  owner,
  // A user is waiting: two more tries at most, and no wait longer than 20 s.
  retry: { retries: 2, maxDelayMs: 20_000 },
});
```

### Your own calls with `withRetry`

Your app may make model requests of its own next to a question: a title for the chat, a summary for
a notification. `withRetry` sends them again by the same rule. It reads three fields of what your
call throws: `status`, a number (0 for no answer); `kind` (`"quota"` and `"context_overflow"` are
never sent again, `"timeout"` with status 0 only once); and `retryAfterMs`. Throw a
`ModelRequestError` and the error gets its `kind` from the status and the message. Pass the
service's error code as `code` (or set `kind: "quota"` yourself) so a quota is not sent again: a
quota is told from `code: "insufficient_quota"`, Gemini's `details`, HTTP 402, or words that only
a quota uses (no credit left, a spending cap, a quota per day). An HTTP 429 without them is a
`rate_limit`, which is sent again.

```ts
import { ModelRequestError, retryAfterMs, withRetry } from "llm-large-files";

/** A title for the chat, from a model service of your own. */
export async function chatTitle(question: string, signal?: AbortSignal): Promise<string> {
  return withRetry(async () => {
    let response: Response;
    try {
      response = await fetch(process.env.TITLE_SERVICE_URL ?? "", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TITLE_SERVICE_KEY}` },
        body: JSON.stringify({ text: question, maxWords: 6 }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // No answer at all: status 0, which is sent again.
      throw new ModelRequestError("The title service could not be reached.", 0, { cause: error });
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const wait = retryAfterMs(response.headers, body);
      const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
      throw new ModelRequestError(`The title service returned HTTP ${response.status}.`, response.status, {
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
        ...(typeof code === "string" ? { code } : {}), // "insufficient_quota" makes it a quota: not sent again
      });
    }
    return String((body as { title?: unknown } | null)?.title ?? "");
  }, {
    retry: { retries: 2 },
    signal,
    onRetry: ({ attempt, delayMs }) => console.warn(`Title request failed: retry ${attempt} in ${Math.round(delayMs)} ms`),
  });
}
```

Two more options: `canRetry`, a function that returns false once the attempt did something that
must not happen twice (the loop uses it for text that was shown), and `unknownErrors: "once"`,
which tries an error without a status once more, at once (the part reads use it).

## Waits on a silent model

Each adapter watches a chat request for silence. `firstByteTimeoutMs` (600 s) bounds the wait for
the first piece of a reply, headers not counted, and `idleTimeoutMs` (300 s) the gap between two
pieces, keep-alives counted; 0 waits without end
([`IdleWaits`](../reference/errors-and-retries.md#idlewaits)).

They are options of `gemini()`, `askGemini`, `openAiCompatible()` and `anthropic()`. The first wait
is long because a model that thinks sends nothing while it does (Gemini without its thoughts,
OpenAI's reasoning models), and a reply that is not streamed arrives whole at the end: on Gemini and
OpenAI-compatible endpoints any request without `onText` (an explorer's among them); on Gemini also
any request to an endpoint without a `streamUrl`; on OpenAI-compatible endpoints also any with
`stream: false` or from a gateway that answers without a stream; on Claude only with `stream: false`
or from a gateway that answers without a stream. A reply that keeps arriving has no time limit.

When a wait runs out, the adapter aborts the request and throws its error, with status 0 and kind
`timeout`: "Gemini sent nothing for 600 s.", "The model sent nothing for 600 s." (OpenAI-compatible)
or "Claude sent nothing for 600 s.". The loop sends it again once, unless text of it was shown or
`retries` is 0, and then throws it.

```ts
import { askGemini, gemini } from "llm-large-files/gemini";
import { anthropic } from "llm-large-files/anthropic";

// A model that does not think long: fail sooner than the defaults.
const answer = await askGemini({ files, endpoint, documentIds, messages, owner, firstByteTimeoutMs: 120_000, idleTimeoutMs: 60_000 });

// The same options on an adapter, for askWithFiles.
const model = gemini(endpoint, { firstByteTimeoutMs: 120_000, idleTimeoutMs: 60_000 });
const claude = anthropic({ model: "claude-opus-5-5", apiKey: process.env.ANTHROPIC_API_KEY, idleTimeoutMs: 120_000 });
```

These waits are for one request. A proxy between your server and your user may cut a stream that
is quiet for less: see [Deployment](./deployment.md).

### Part reads have a time limit of their own

The waits cover chat requests. Each request of a whole-file read (a part read) has a limit on its
whole time instead: `timeoutMs` of `openAiCompatible()` and `anthropic()`, 180,000 by default. For
Gemini it is 180 s, and neither `gemini()` nor `askGemini` has an option for it. A part read that
runs out of time is tried once more, at once. If it fails again, the tool's result says the part
could not be read (`parts_that_failed`), and the question goes on.

To give Gemini part reads more time, replace the adapter's `generateText` and call
`askWithFiles`:

```ts
import { askWithFiles, type ModelAdapter } from "llm-large-files";
import { createGeminiGenerateText, gemini } from "llm-large-files/gemini";

const patient: ModelAdapter = {
  ...gemini(endpoint),
  // Each part read may take 5 minutes.
  generateText: createGeminiGenerateText({ url: endpoint.url, headers: endpoint.headers, timeoutMs: 300_000 }),
};
const result = await askWithFiles({ files, model: patient, documentIds, messages, owner });
```

`analysisConfig` of `gemini()` is `generationConfig` here, if you set one. With an
[explorer model](./explorer-model.md), the part reads are the explorer's: replace its
`generateText`.

## An overall deadline

A question has no time limit of its own. It makes up to `limits.toolTurns` (12) answered chat
requests, plus up to three that the provider refused as too large and the loop recovered from (see
[A request too large for the model](#a-request-too-large-for-the-model)). Each may wait
`firstByteTimeoutMs` twice and be tried up to 4 times, and a whole-file read adds its part reads. To bound the time your user waits, pass a `signal` that aborts at your deadline,
joined with one that aborts when the user leaves:

```ts
import type { ServerResponse } from "node:http";
import { askGemini } from "llm-large-files/gemini";

export async function ask(response: ServerResponse): Promise<string | undefined> {
  const userLeft = new AbortController();
  response.on("close", () => userLeft.abort());
  const deadline = AbortSignal.timeout(15 * 60_000); // 15 minutes for the whole question: above firstByteTimeoutMs (10 minutes)

  try {
    const result = await askGemini({ files, endpoint, documentIds, messages, owner, signal: AbortSignal.any([userLeft.signal, deadline]) });
    return result.text;
  } catch (error) {
    if (deadline.aborted) return "The question took too long. Ask again, or ask about less.";
    if (userLeft.signal.aborted) return undefined; // nobody is waiting for the answer
    throw error;
  }
}
```

When the signal aborts, the request under way stops, the tool calls of the turn stop, and nothing
more is sent or sent again, no further part of a whole-file read either. The question stops at
once, even with an adapter of your own, or a part reader, that does not look at the signal: the
loop no longer waits for it, and text that such an adapter sends later is not shown. The question
throws the signal's reason: a `DOMException` named "TimeoutError" for `AbortSignal.timeout`, a
`DOMException` named "AbortError" for `controller.abort()`, and your reason for
`controller.abort(reason)`. It does so also when the adapter then fails at once with its own error.
When the abort comes just after a request failed, that request's error may be thrown instead. So
test which signal aborted, as above, not the error.

`partialResultOf(error)` works for a stopped question too, when the reason is an object. Abort with
an `Error`, or with no reason, rather than a string. When several questions share the signal, they
all throw the same reason, and `partialResultOf` gives none of them a result for it (since 0.7.1;
before, each got the result of the one that failed last): give each question an `AbortController`
of its own that the shared signal aborts with a new reason. Its `usage` is what was counted when the
question stopped: a request still running then, in an adapter that did not stop, may be billed by
the provider, and is not counted.

How the client side cancels a streamed answer is in [Web app](./web-app.md).

## A request too large for the model

When the provider refuses a request as larger than the model takes (kind `context_overflow`), the
loop does not give up at once. The same holds for a request larger than the tokens the provider
lets through in a minute (OpenAI's and Groq's TPM, or a day's allowance): that allowance then
stands for the window.

1. It takes the provider's count and window for the rest of the question, replaces tool results
   with stand-ins (those of all but the last three tool rounds, then all but the last two, then all
   but the last one, then all of them, as far as needed), and sends the request again, at most
   twice in a question. The step says "The request was larger than the model takes: older tool
   results were shortened, and it was sent again", or for an allowance, "The request was larger
   than the provider allows in a minute: older tool results were shortened, and it was sent again".
2. When shortening does not help (nothing is left to shorten, a model of the question may only grow
   its conversation, such as Claude, or the request sent again shorter was refused again), and no
   tool call of this question was answered and no text shown yet, it plans
   the documents again for a smaller window and starts over, once. A document that was sent whole
   may now be searched instead. The step says "The first request was larger than the model's
   window of 131,072 tokens: the files were planned again to fit it", or "…for a smaller window".
   For an allowance it says "The first request was larger than the 30,000 tokens a minute that the
   provider allows: the files were planned again to fit it", or, when the message gives no limit,
   "The first request was larger than the provider allows in a minute: the files were planned again
   for a smaller request" ("a day" for an allowance per day).
   What the first try used counts in `usage` and against `limits`.
3. Otherwise it throws the error, with `partialResultOf`.

How the smaller window is worked out from the provider's numbers is in
[How it works](../how-it-works.md#a-request-too-large-for-the-model).

A part of a whole-file read that the model refuses as too large, for its window or for the minute's
allowance, is read as two halves, inside the tool. It does not throw. A refusal of a part that asked
for the larger output limit of a thinking model (32,768 tokens) turns that limit off for the model
only when the window, or the allowance, is no larger than it; otherwise later parts may still get
it.

When the error reaches you, one of these is the cause:

- **The conversation is too long.** The library does not shorten the text turns of the history.
  Drop old turns, or start a new chat. See [Conversations](./conversations.md).
- **The model's window is smaller than the budget assumes** (1,000,000 tokens by default). Give the
  adapter its `contextTokens`, so every question is planned for it. A gateway whose body limit is
  below 10 MB answers 413: give the adapter its `maxRequestBytes`. `askGemini` has neither option:
  set them in the budget instead, `createLargeFiles({ store, budget: { contextTokens: 128_000,
  maxRequestBytes: 8_000_000 } })`, or in `budget` of `askGemini` for one question. See
  [Costs and limits](./costs-and-limits.md).
- **The question names too many documents.** Ask about fewer.
- **The provider lets through fewer tokens a minute than a request needs** (OpenAI's TPM on a low
  tier, Groq's free tier). `limitTokens` is that allowance. Give the adapter a `contextTokens` below
  it, or ask the provider for a higher limit.
- **The provider's wording is not known**, and the error came as `invalid`. See
  [The kind of a model error](#the-kind-of-a-model-error).

## Empty or broken turns

In the tool loop (when a document is searched rather than sent whole, or a PDF's pages can be
looked at), two kinds of reply are asked for once more, with a short note at the end of the request
that says what was wrong:

- **A tool call that could not be read**: Gemini's `MALFORMED_FUNCTION_CALL` or
  `UNEXPECTED_TOOL_CALL`. The step says "The model's tool call could not be read: it was asked to
  send it again".
- **A first reply with nothing in it**: no text and no tool call, before any tool call of the
  question was answered, and not cut off at the output limit or stopped by a filter. The step says
  "The model's first reply was empty: it was asked again".

Without the second try, the answer would be written from the document cards alone and look like any
other. At most two such second tries are made in a question, and each takes one of
`limits.toolTurns`. When they are made, and which model keeps the note, is in
[How it works](../how-it-works.md#empty-or-broken-turns). When the second try is empty too, the
loop asks for the answer, as it does at the end of every question.

**The answer's second try.** The request for the answer (`toolChoice: "none"`) is asked for once
more when its reply has no text: when it is empty, or holds a tool call the model was told not to
make (Gemini's `UNEXPECTED_TOOL_CALL` or `MALFORMED_FUNCTION_CALL`, or calls from an adapter of
your own). The note at the end of that request is "Your last reply had no text. No tool can be
called in this reply: write the answer now, in text, from what is above.", and it is not kept. The
step says "The model's answer was empty: it was asked again", or "The model called a tool instead
of answering: it was asked again for the answer". It is one of the two second tries of the
question, and it can be one request past `limits.toolTurns`. It is not made after a refusal, a
filter, or a reply cut off at the output limit with nothing in it, nor once `limits.requests` or
`limits.inputTokens` is reached. When its reply has no text either, `answered` is false.

A single call that cannot be run is not a broken turn: arguments that are not a JSON object, a call
cut off at the output limit, a Claude call whose block never closed. It is answered with an error
that says why and asks the model to send it again, and the other calls of the turn run. A turn with
more calls than `limits.callsPerTurn` (8) runs the first 8 and answers the others "Not run: one turn
runs at most 8 tool calls. Send this call again if you still need it."

## A stream cut off

A streamed reply ends with the provider's word for why it ended: a `finishReason` in Gemini's last
chunk, a `finish_reason` or `[DONE]` in an OpenAI-compatible stream, a `stop_reason` in Claude's. A
stream that closes without it was cut off on its way, by a proxy or a dropped connection. The
adapter does not take it for a whole reply: it throws an error with status 0, of kind
`unreachable`: "Gemini's reply ended before it was complete.", "The model's reply ended before it
was complete." or "Claude's reply ended before it was complete.". A connection that fails while the
reply arrives is the same, and so is a reply of HTTP 200 whose body is empty.

A stream that said it is whole (`[DONE]` on an OpenAI-compatible stream, `message_stop` on
Claude's) has its reply, whatever the connection does next. The body is read for one more second
at most, then cancelled, which closes the connection: a server or gateway that leaves it open does
not hold the request until `idleTimeoutMs`. A connection that breaks after the end marker loses
nothing either. 0.5.0 waited for such a connection to close, and took one that broke for a model
that could not be reached, with the whole answer already shown.

A reply asked for as a stream is read as one when its content type is `text/event-stream`. Of any
other type (a gateway that streams under `application/octet-stream`, or under none), it is read by
its first characters: as events when it starts with `data:` or a comment, as JSON when it starts
with `{` or `[` (Gemini's chunks in a list, as it sends them without `alt=sse`). A body that starts
with more than 65,536 characters of white space is read as JSON, whatever follows. A body that is
neither, such as an HTML page, is a reply that is not JSON: kind `invalid`, status 200, not sent
again. One event of a stream may hold 64,000,000 characters at most; a longer one ends the reply
with kind `invalid` and status 200, and is not sent again: it would come again.

An error the provider sends inside a stream that began with HTTP 200 takes the status the error
names, and is sent again or not by that status:

- On Gemini, its `code`. An error without one keeps the stream's 200, and is not sent again.
- On an OpenAI-compatible stream, its `code` or `type`: `context_length_exceeded` is 400 (kind
  `context_overflow`), `insufficient_quota` 429 (kind `quota`), and `code` and `param` stay on the
  error. One that names no status the adapter knows counts as a 500.
- On Claude, its `type`: `overloaded_error` 529, `rate_limit_error` 429, `api_error` 500,
  `timeout_error` 408, `invalid_request_error` 400, `authentication_error` 401, `billing_error`
  402, `permission_error` 403, `not_found_error` 404, `request_too_large` 413 (kind
  `context_overflow`). A type the adapter does not know is the server's failure, 500.

What happens next depends on what your user saw:

- **Nothing of that reply was passed to `onText`**: a turn of tool calls, an explorer's request, a
  request without `onText`, a reply that failed before its first word. It is sent again, by the
  retry rule.
- **Text of it was shown**: it is not sent again, since a second reply would repeat or contradict
  what is on the screen. The error is thrown, and `partialResultOf(error).text` is the text that
  was shown.

So in your UI, keep the text that arrived, mark it as cut off, and offer to ask again. This holds
for every error after the first word of an answer, not only for a cut stream.

## Failures inside tools

The tools answer the model, not you. When a call fails, its result is `{ error: "…" }`, and the
model reads it and tries another way: a regex that does not compile, a page past the end of a PDF
(`view_pages`), a store that did not answer ("The document store could not be read (EIO). Try again."), a whole-file read
whose parts all failed. The question goes on, and can still be answered. A failed call shows:

- in `steps`, as a line that ends in " — failed: " and the error;
- in `toolTurns`, as a call whose `result.error` is a string;
- not in `evidence`, which lists only what was shown.

A whole-file read tells the model why a model request failed by the error's kind, its HTTP status
or the code of a connection that failed, never by the error's words: the provider's message, or an
HTTP client's, can name a project, a host, a masked key, or a URL with a key in it. The same words
are in its step and in `toolTurns`: "Read all of app.log for “Summarize.” — failed: Could not read
any part of app.log: The model refused the key or token it was sent (HTTP 401)." The reasons:

| The error | The reason |
|---|---|
| A reply with no text, from a part reader of the package | "The model returned no text (SAFETY).", with the provider's reason when it is a plain word, or "The model returned no text." |
| An error with a `kind` (the package's adapters set one) | By its kind, with " (HTTP n)" when it has a status: "The request was larger than the model takes", "The model's quota has run out", "The model was busy", "The model took too long to answer", "The model could not be reached", "The model failed on its side", "The model refused the key or token it was sent", "The model refused the request". Kind `invalid` with a status of success: "The model's reply could not be read (HTTP 200)." |
| An error with an HTTP status and no kind (`status`, `statusCode` or `response.status`, as a provider's SDK, got and axios set them) | Its kind is told from its status and message, as `classifyModelError` does, and the reason follows from it: "The model failed on its side (HTTP 503)." |
| An error whose `code`, or that of its `cause`, is that of a connection that failed (`ECONNREFUSED`, `ENOTFOUND`, undici's `UND_ERR_SOCKET`…) | "The model could not be reached." |
| An error named `TimeoutError` (an `AbortSignal.timeout`, or a part reader's `timeoutMs`), or undici's `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT` | "The model took too long to answer." |
| Anything else: a plain `Error` of a `generate` of your own, a thrown string | "The model request failed." ("The model request failed (HTTP 302)." for a status from 100 to 399) |

These reasons go into "Could not read any part of app.log: …", "[This part could not be read: …]",
the note of a read whose last step failed (`notes_only`), and "The whole-file read of app.log failed
earlier in this question (…)". A failure to read a part's lines from the store keeps the store's
own message, which names no path or host: "The document store could not be read (EIO). Try again."
The provider's words belong in your log: log them in your own `fetch`, adapter or `generate`. To
give the model a specific reason from a `generate` of your own, throw an error with a `kind` or an
HTTP `status`.

A whole-file read that worked in part says so in its result (`parts_that_failed`, `notes_only`,
`notes_cut_short`, `answer_cut_short`). Its step ends in ", notes only" when the answer is only the
notes of the parts, and otherwise in ", incomplete" when notes or the answer were cut short. A read
that only lost parts has no such mark: its step ends in " — 12 parts, 3 relevant" as a complete
read's does, the failed parts among the 12. Look for `parts_that_failed` in its result in
`toolTurns`.

Most failed calls are the model's own mistakes, which it mends in its next turn. To see trouble on
your side, such as a store that fails often, log them:

```ts
// result: what askWithFiles or askGemini returned.
const failed = result.toolTurns.flatMap((turn) => turn.calls).filter((call) => typeof call.result.error === "string");
for (const call of failed) console.warn(`Tool ${call.name} failed: ${String(call.result.error)}`);
```

## When there is no answer: `answered` and `finishReason`

A question can end without an error and without an answer. `answered` is false when the model's
last turn had no text:

- **The provider refused the prompt.** `blockReason` says why: Gemini's `promptFeedback.blockReason`
  (such as "SAFETY"), "refusal" or "refusal: " and its category for Claude, "content_filter" for an
  OpenAI-compatible reply that was filtered with nothing in it. Nothing more is asked after it.
- **The last reply ended without text**: cut off at the output limit before its first word, stopped
  by a filter, or an answer with no text (empty, or a tool call) after its one second try.

`text` may then be empty, hold only a remark the model wrote before a tool call, or the start of a
reply the provider then refused. Show your own message instead.

`finishReason` is the provider's own word for how the last chat reply ended: "STOP", "MAX_TOKENS"
or "SAFETY" from Gemini, "stop", "length" or "content_filter" from an OpenAI-compatible server,
"end_turn", "max_tokens" or "refusal" from Claude. An answer can be `answered: true` and still be
cut off at the output limit. Tell the user, or raise the model's output limit (`maxOutputTokens` in
Gemini's `generationConfig`, the limit in `body` of `openAiCompatible()`, `maxTokens` of
`anthropic()`). Claude's `model_context_window_exceeded` means its window filled: shorten the chat
rather than raise the output limit.

```ts
import type { AskResult } from "llm-large-files";

/** The words of the output limit, as each provider says them. */
const CUT_OFF = new Set(["MAX_TOKENS", "length", "max_tokens"]);

export function shownAnswer(result: AskResult): { text: string; note?: string } {
  if (!result.answered) {
    return { text: result.blockReason ? "This question was blocked by the model's safety filters." : "No answer this time. Ask again, or ask more precisely." };
  }
  if (result.finishReason === "model_context_window_exceeded") {
    return { text: result.text, note: "The answer was cut off: the chat filled the model's window." };
  }
  if (result.finishReason !== undefined && CUT_OFF.has(result.finishReason)) {
    return { text: result.text, note: "The answer was cut off at the model's output limit." };
  }
  return { text: result.text };
}
```

## Keeping what a failed question found

`askWithFiles` throws the error as it came, and what the question did until then is not lost.
`partialResultOf(error)` gives an `AskResult` with `answered: false`: the `steps`, `evidence`,
`toolTurns`, `usage` and `turns` of the question so far, its `plan` and `budget`, and the `text`
that was shown. The requests in `usage` were paid for: count them. Keep the tool rounds as you keep
those of an answered question (see [Conversations](./conversations.md)), so that asking again does
not search again.

It is undefined for an error that did not come from a question under way: `DocumentsNotFoundError`,
a `DocumentStoreError` while the documents were planned, a budget that cannot work, a last message
that is not the user's, and an abort whose reason is a string.

```ts
import { askWithFiles, partialResultOf, type ModelAdapter } from "llm-large-files";

// recordUsage and keepToolTurns are your app's own: usage per user, tool rounds per chat session.
export async function askAndRecord(model: ModelAdapter, sessionId: string) {
  try {
    const result = await askWithFiles({ files, model, documentIds, messages, owner });
    await recordUsage(owner, result.usage);
    await keepToolTurns(sessionId, result.toolTurns);
    return result;
  } catch (error) {
    const partial = partialResultOf(error);
    if (partial) {
      await recordUsage(owner, partial.usage);
      await keepToolTurns(sessionId, partial.toolTurns);
    }
    throw error;
  }
}
```

## Errors of uploads and of the store

`files.ingest` throws a plain `Error`, with a message written for the user, when it cannot take a
file: it is empty, larger than `maxUploadBytes` (100 MB by default), has no text, is a gzip or ZIP
archive, is binary, needs an optional dependency that is not installed (`jszip` for DOCX and PPTX,
`unpdf` for PDF) or an `unpdf` that runs on this Node, or is a PDF without a text layer (see
[PDFs](./pdfs.md)). Show its message. A text file is never refused for its encoding: one that is
not UTF-8 is read in the encoding it was saved in, or as UTF-8 with the characters that are not
valid counted ([Text encodings](./pdfs.md#text-encodings)).

It throws a `TypeError` for an owner of `""`, spaces only or `null`: a mistake of your code, not of
the file. `createDocumentHandlers` answers it 500 `{ "error": "Upload failed (empty owner)." }`, or
`{ "error": "Upload failed (owner is not a string)." }` for an owner that is neither a string nor a
finite number, before it reads the upload ([Storage](./storage.md#how-ownership-works)).

A file the parser cannot read (a damaged DOCX, PPTX or PDF) throws the parser's own error (jszip's,
or pdf.js's `InvalidPDFException`), and an extractor of your own throws its own. Their messages are
not written for users: show "This file could not be read." for an error whose message you do not
recognise.

A store that fails while it writes throws its own error, as it came: its message may name a path or
a host, so log it and show a general message. `createDocumentHandlers` answers a file it cannot take
with 422 and the error's message, and a Node system error of the store (one with a `code` and a
`syscall`) with 500 and only its code ("Upload failed (ENOSPC)."). Any other store error, one
without a `status` (or `statusCode`) from 400 to 599, is answered 500 "Upload failed.", without its
message, and so is a thrown value that is not an `Error`. The handlers log nothing: log the error in
your store before you throw it. Two paths still answer a store's error 422 with its message, which
may name a host: an `ingest` of your own that throws a new error in its place, as `ingestInProcess`
in [Deployment](./deployment.md#uploads-and-ingest) does, and a route of your own, as in
[Web app](./web-app.md#filesingest-and-its-errors). So a custom store should throw an error with a
`status` and a message fit for the user (both are sent as they are): every path keeps that status.
See [the node reference](../reference/node.md#uploadrequest-response).

Every read of the store goes through the library: `prepare`, `getMeta`, `getOriginal`, the tools.
What the store throws there becomes a `DocumentStoreError`, which does not mean the document is
gone. A store's own `delete` and `sweep` pass on its error as it came. A document that is gone, or
of another owner, is not an error of the store: `prepare` lists it in `missing`, and `askWithFiles`
throws `DocumentsNotFoundError` for it. What a store must do is in [Storage](./storage.md).

## Putting it together: a chat route

A route that answers a question in one JSON response, and turns each error into a status and a
message. Call `answerChat` from your route once the user is signed in and the body is read: `owner`
is the user, and `messages` and `documentIds` come from your chat session.

```ts
import type { ServerResponse } from "node:http";
import { DocumentsNotFoundError, DocumentStoreError, errorKindOf, ModelRequestError, partialResultOf, type ToolTurn } from "llm-large-files";
import { askGemini, type ChatTurn } from "llm-large-files/gemini";

type Failure = { status: number; message: string; retryAfterSeconds?: number };

/** What to tell the user about an error of a question, and the HTTP status to answer with. */
export function toUserError(error: unknown): Failure {
  if (error instanceof DocumentsNotFoundError) {
    return { status: 404, message: "A file of this chat is no longer available. Attach it again." };
  }
  if (error instanceof DocumentStoreError) {
    return { status: 503, message: "Your files could not be read just now. Try again in a moment." };
  }
  switch (errorKindOf(error)) {
    case "context_overflow":
      return { status: 413, message: "This chat is too long for the model. Start a new chat, or ask about fewer files." };
    case "rate_limit": {
      const wait = error instanceof ModelRequestError ? error.retryAfterMs : undefined;
      return { status: 429, message: "The assistant is busy. Try again in a minute.", ...(wait ? { retryAfterSeconds: Math.ceil(wait / 1_000) } : {}) };
    }
    case "quota":
      return { status: 503, message: "The assistant is not available right now." };
    case "timeout":
      return { status: 504, message: "The model took too long to answer. Try again." };
    case "unreachable":
    case "server":
      return { status: 502, message: "The model could not answer just now. Try again." };
    default:
      // auth, invalid, and errors without a kind: your configuration or your code.
      return { status: 500, message: "Something went wrong on our side. Try again later." };
  }
}

export async function answerChat(response: ServerResponse, question: { owner: string; messages: Array<ChatTurn | ToolTurn>; documentIds: string[] }): Promise<void> {
  const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(value));
  };
  const userLeft = new AbortController();
  response.on("close", () => userLeft.abort());
  const deadline = AbortSignal.timeout(15 * 60_000);

  try {
    const result = await askGemini({ files, endpoint, ...question, signal: AbortSignal.any([userLeft.signal, deadline]) });
    if (!result.answered) {
      const message = result.blockReason ? "This question was blocked by the model's safety filters." : "No answer this time. Ask again, or ask more precisely.";
      send(200, { answered: false, message });
      return;
    }
    send(200, { answered: true, text: result.text });
  } catch (error) {
    // What a failed question used was paid for: count it with the user's usage.
    const partial = partialResultOf(error);
    if (partial) console.info(`A failed question of ${question.owner} used`, partial.usage);
    if (deadline.aborted) {
      send(504, { error: "The question took too long. Ask again, or ask about less." });
      return;
    }
    if (userLeft.signal.aborted) return; // nobody is waiting for the answer
    // The provider's own message is for your log, not for the user.
    console.error("A question failed", error);
    const failure = toUserError(error);
    send(
      failure.status,
      { error: failure.message, ...(error instanceof DocumentsNotFoundError ? { missing: error.ids } : {}) },
      failure.retryAfterSeconds ? { "Retry-After": String(failure.retryAfterSeconds) } : {},
    );
  }
}
```

With a streamed answer (Server-Sent Events), the status 200 is sent before the first word, and an
error cannot change it. Send the same message in an error event instead, and when
`partialResultOf(error)?.text` is not empty, say that the answer above it is incomplete. The events,
progress and cancelling are in [Web app](./web-app.md).

To see how your route handles each error without calling a real model, give it an adapter that
throws them: see [Testing](./testing.md).

## Reference

- [Errors, retries and streams](../reference/errors-and-retries.md): `ModelRequestError`,
  `ModelErrorKind`, `classifyModelError`, `errorKindOf`, `withRetry`, `RetryOptions`,
  `RetryNotice`, `isRetryableStatus`, `retryAfterMs`, the default waits.
- [The tool loop](../reference/ask.md): `askWithFiles`, `AskResult`, `partialResultOf`,
  `DocumentsNotFoundError`.
- [The library](../reference/library.md): `DocumentStoreError`, `ingest`, `prepare`.
- The adapters and their options: [Gemini](../reference/gemini.md),
  [OpenAI-compatible](../reference/openai.md), [Claude](../reference/anthropic.md).
- [Troubleshooting](../troubleshooting.md): symptoms, causes and fixes.
