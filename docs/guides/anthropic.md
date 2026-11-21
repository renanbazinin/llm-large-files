# Claude

This guide is for you if Claude answers the questions about your files. It covers what
`anthropic()` needs, the options that matter, gateways, what a conversation that may only grow
changes in the tool loop, pages of PDFs, errors, conversations you keep as Messages API messages,
and Claude answering while a Gemini model explores. Every option and its default is in the
reference: [`llm-large-files/anthropic`](../reference/anthropic.md).

## Set up `anthropic()`

`anthropic()` from `llm-large-files/anthropic` makes Claude a model of `askWithFiles`. It needs no
SDK: it posts to the Messages API with `fetch`. It needs two things:

- `model`: the model ID, such as `"claude-opus-5-5"`.
- A credential: `apiKey`, sent as `x-api-key`, or `authToken`, sent as `Authorization: Bearer …`
  (an OAuth token, or a gateway's token). Either can be a function: it is called for each request,
  so a token can be renewed.

```ts
import { readFile } from "node:fs/promises";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";

const files = createLargeFiles({ store: new MemoryDocumentStore() });
const meta = await files.ingest({ name: "app.log", bytes: await readFile("app.log") });

const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-5-5",
  contextTokens: 1_000_000, // your model's window: the budget of a question follows it
  fallbacks: "default",     // another model answers when a safety classifier declines
});

const result = await askWithFiles({
  files,
  model: claude,
  documentIds: [meta.id],
  messages: [{ role: "user", text: "Why did the nightly import fail?" }],
  onText: (delta) => process.stdout.write(delta),
});
if (!result.answered) console.log(result.blockReason ? "\nThe request was declined." : "\nNo answer this time.");
```

With these options, each chat request is a `POST` to `https://api.anthropic.com/v1/messages` with:

- the headers `x-api-key`, `anthropic-version: 2026-10-21` (the exported `ANTHROPIC_VERSION`) and,
  because `fallbacks` is set, `anthropic-beta: server-side-fallback-2026-07-01`;
- a body of `model`, `max_tokens: 64000`, `system` (when there is one), `messages`,
  `stream: true`, `cache_control: { type: "ephemeral" }` and `fallbacks`, plus `tools` when the
  question uses them (and `tool_choice: { type: "none" }` in the request for the answer).

No sampling settings are sent: the API version in `ANTHROPIC_VERSION` refuses `temperature`, so do
not add sampling settings in `body`.

`usage.byModel` names the model by its `model` ID; set `id` for another name.

The adapter has not been run against the real Messages API, in 0.6.0 or any earlier version. It
is tested against the request and response shapes of the Messages API documentation.
[Measurements](../measurements.md) lists what has been run live.

## The options that matter

| Option | Default | What it does |
|---|---|---|
| `contextTokens` | none | The model's context window. The budget of a question follows it. |
| `maxTokens` | 64,000 | `max_tokens` of a chat request: the most the model may write, thinking included. It is kept free in the window. |
| `tokenScale` | 1.35 | How many of Claude's tokens one token of the library's estimate comes to. |
| `body`, `analysisBody` | none | More fields for every chat request, and `(maxOutputTokens) => fields` for the part reads of a whole-file read: `thinking`, `output_config`. |
| `firstByteTimeoutMs`, `idleTimeoutMs` | 600,000 and 300,000 | Waits on a chat reply that sends nothing. 0 waits without end. |
| `timeoutMs` | 180,000 | Milliseconds one part read of a whole-file read may take. |

The sections below explain each, and more: `stream` and `eagerInputStreaming` in
[Streaming and waits](#streaming-and-waits), `cache` in [Prompt caching](#prompt-caching),
`fallbacks` in [Fallbacks and refusals](#fallbacks-and-refusals), the gateway options in
[Gateways and other hosts](#gateways-and-other-hosts), and `toolFilePlacement` and `pageTokens` in
[PDF pages and pictures](#pdf-pages-and-pictures). Every other option is in
[the reference](../reference/anthropic.md).

### The window: `contextTokens`, `maxTokens`, `tokenScale`

The library plans a question in its own estimate of tokens (`estimateTokens`), which is fitted to
Gemini. Three numbers turn Claude's window into that budget:

1. **The window** is the smaller of the library's `budget.contextTokens` and the adapter's
   `contextTokens`. `anthropic()` declares none unless you set it, so without it the library's
   window holds: 1,000,000 tokens unless you set another in `createLargeFiles({ budget })`.
2. **`tokenScale`** divides it: Claude counts 1.35 tokens, by default, for one token of the
   estimate, so its window is that much smaller in the library's terms.
3. **`maxTokens`**, divided the same way, is kept free: Claude counts `max_tokens` against the
   window. At least a quarter of the window is left for the prompt.

The rest of the budget (room for documents, for tool results, for pages) follows the window that
is left. `result.budget` shows what a question ran with:

| `contextTokens` | `maxTokens` | `result.budget.contextTokens` |
|---|---|---|
| not set | 64,000 (default) | 693,332 |
| 200,000 | 64,000 (default) | 100,740 |
| 200,000 | 16,000 | 136,296 |
| 102,600 | 16,200 | 64,000 |

- **Set `contextTokens`** whenever your model's window is smaller than the library's. A budget
  larger than the window makes requests the API refuses, and with Claude the loop can recover
  from that only before the first tool ran ([below](#a-conversation-that-may-only-grow)).
- **`maxTokens` is room every request keeps free**, and the room the model has to think and write.
  A reply cut at the limit (`finishReason: "max_tokens"`) loses every tool call in it, including
  calls whose input was complete: each is answered "This call was cut off at the output limit…"
  and not run. Lower it for a small window only as far as your answers allow.
- **`tokenScale` is a cautious guess.** During a question, the count Claude reports with each reply
  raises the estimate when the text costs more than the scale says; it never lowers it below the
  scale. If you measure the ratio for your own files (Anthropic's count of a text against
  `estimateTokens` of it), set `tokenScale` to it.

The adapter also says that Claude takes requests of up to 32 MB (`maxRequestBytes`). A question
sends no more than the smaller of that and the library's `budget.maxRequestBytes`, which is 10 MB
by default. Raise the library's when you want the 32 MB, for example for pages of PDFs.

### Thinking and effort

The adapter sends no `thinking` or `output_config` field of its own, so the model's own defaults
apply. Put the fields in `body` for chat requests and in `analysisBody` for the part reads of a
whole-file read:

```ts
import { anthropic } from "llm-large-files/anthropic";

const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-5-5",
  body: { output_config: { effort: "high" } },                // every chat request
  analysisBody: () => ({ output_config: { effort: "low" } }), // the part reads
});
```

Which `thinking` and `output_config` values a model takes is the API's business: see Anthropic's
documentation for your model. What the library does with thinking is the same for every model:

- **It goes back unchanged to Claude.** A turn of Claude's, thinking blocks included, is sent back
  as it came in Claude's later requests of the question, except for what the API would refuse: an
  empty text block that a stream left after the last thinking block is left out, and a call whose
  input was not valid JSON goes back with `{}`. Another model of the question (the answering
  model, when Claude explores) gets the turn rebuilt from its tool calls, without thinking blocks.
- **It is not shown.** `onText` and `result.text` carry text blocks only.
- **It is not stored.** `result.toolTurns` hold the calls and their results, and
  `fromAnthropicMessages` leaves thinking blocks out: they belong to the question they were
  written in.
- **It is counted in `outputTokens`.** The adapter reports no `thoughtTokens` (always 0), for part
  reads too.
- **It counts against `maxTokens`.** A part read that comes back cut off at its limit with no text,
  or that thought most of its limit away and wrote a little, is asked for once more with 32,768
  tokens (`THINKING_OUTPUT_TOKENS`, exported by `llm-large-files/gemini`), and later part reads of
  that model start there. Claude does not count its thoughts apart: in a part read that thought,
  they are taken as what it wrote besides its text (its `output_tokens` less the tokens of the
  text). In 0.6.0 such notes came back cut: two lines out of 4,096 tokens.

`body` and `analysisBody` are added last, so a field in them replaces the adapter's own. Set
`max_tokens` with `maxTokens`, streaming with `stream` and caching with `cache`: the budget and the
reading of the reply follow the options, not `body`.

### Streaming and waits

- **Every chat request is streamed** (`stream: true`), whether or not you pass `onText`. With
  `onText`, the answer's text arrives as it is written. A reply that is not `text/event-stream` is
  read by what its body starts with: as events after `data:` or a comment (a gateway that streams
  under `application/octet-stream`, or under no type), as JSON in one piece after `{`. `stream:
  false` asks for no stream.
- **`eagerInputStreaming`** sets `eager_input_streaming: true` on each tool of a streamed request,
  so the input of a call arrives as it is written. It defaults to `true` for api.anthropic.com and
  `false` for any other URL, which may refuse the field. Either way the input is read once its
  block is complete, and only a JSON object is taken. A call whose input is not one, any call of a
  reply cut off at `max_tokens`, and a call whose block never closed are answered with what was
  wrong and not run, and Claude can send them again.
- **Waits on silence.** A chat request that gets nothing for `firstByteTimeoutMs` (600 s) before the
  first piece of its reply, or for `idleTimeoutMs` (300 s) between two pieces, is aborted and sent
  again, once, unless text of it was already shown. Headers do not count as a piece; any bytes of
  the stream do, Claude's pings included. The error is an `AnthropicRequestError` that names the
  wait that ran out ("Claude sent nothing for 600 s.", or 300 s between pieces), with `status` 0
  and `kind: "timeout"`. 0 waits without end. With `stream: false` the reply comes whole at the
  end, so `firstByteTimeoutMs` must cover all of it.
- **A stream cut short is not a reply.** A stream that ends before the `message_delta` event that
  gives `stop_reason` (a gateway that closed it early) throws "Claude's reply ended before it was
  complete." with `status` 0. It is sent again when none of it was shown, and `onActivity` says
  "The model's reply was cut off on its way. Trying again…".
- **A stream that ended is a reply.** After `message_stop`, the body is read for one more second at
  most, then cancelled: a gateway that leaves the connection open does not hold the request until
  `idleTimeoutMs`, and a connection that breaks after `message_stop` loses nothing. In 0.6.0 both
  failed, with the whole answer already shown.
- **Part reads are not streamed.** Each may take `timeoutMs` (180 s); one that takes longer is
  stopped and tried once more.

Streaming the answer on to a browser is in [web app](./web-app.md), and proxies that cut long
streams in [deployment](./deployment.md).

### Prompt caching

With `cache: true` (the default) each chat request carries a top-level
`cache_control: { type: "ephemeral" }`. It caches the request up to its last block, so each request
of the tool loop, and a follow-up question, reads what the one before wrote. `"5m"` is the same,
`"1h"` keeps it an hour (`ttl: "1h"`), and `false` sends none. Part reads carry none: each part is
sent once. Keep `documentPlacement` at `"first"`, the default of `askWithFiles`: the documents
then stay at the start of the conversation, where a follow-up question reads them from the cache.

In `usage`, `inputTokens` counts every token of the prompts: those not cached, those written to
the cache, and those read from it. `cachedInputTokens` is the part read. Cache writes have no field
of their own, and Anthropic bills them at another rate than plain input. To price them, read
Claude's own usage of each reply, `providerUsage`, by wrapping the adapter:

```ts
import type { ModelAdapter } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";

const base = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-5-5" });

const claude: ModelAdapter = {
  ...base,
  async send(request, hooks) {
    const reply = await base.send(request, hooks);
    // Claude's usage object: input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens.
    console.log(base.id, reply.providerUsage);
    return reply;
  },
};
```

`result.lastUsage` is the same object for the last chat request of a question. Turning usage into
cost per user or session is in [costs and limits](./costs-and-limits.md).

### Fallbacks and refusals

`fallbacks: "default"`, or a list such as `[{ model: "claude-opus-4-8" }]`, adds the `fallbacks`
field to every chat request and `server-side-fallback-2026-07-01` to `anthropic-beta`: when a
safety classifier declines the request, another model answers it. It is off unless you set it. The
adapter's own note says it is offered on the Claude API, not on Amazon Bedrock, Vertex AI or
Microsoft Foundry, and not for every model.

- A reply in which another model took over goes back with what came after the last switch: the
  thinking and calls of the model that declined are left out, and its text is kept.
- `usage` counts every attempt of such a reply: both were billed.

When the request is declined (`stop_reason: "refusal"`; with `fallbacks`, by every model), the
result has `answered: false` and `blockReason: "refusal"`, or `"refusal: cyber"` when the API names
a category. No call of that reply runs, and nothing more is asked. Text that Claude wrote before it
stopped was already passed to `onText` and is in `result.text`: replace it with your own message.

## Gateways and other hosts

A gateway that speaks the Messages API takes the same adapter:

| Option | Default | What it does |
|---|---|---|
| `baseUrl` | `https://api.anthropic.com` | The base of the API: `/v1/messages` is added to it. |
| `url` | `baseUrl` + `/v1/messages` | The whole Messages URL, when it is not that. |
| `authToken` | none | Sent as `Authorization: Bearer …`. A function is called for each request. |
| `headers` | none | More headers, or a function that returns them for each request. Added last, so they can replace the adapter's own. |
| `version` | `ANTHROPIC_VERSION` (`"2026-10-21"`) | The `anthropic-version` header. |
| `betas` | none | Values of the `anthropic-beta` header, joined with commas. |
| `maxRequestBytes` | 32,000,000 | The largest request the gateway takes, when it is lower. |
| `fetch` | the global `fetch` | Your own `fetch`: a proxy, logging, tests. |

A gateway that cannot stream needs `stream: false`, and one that passes `eager_input_streaming` on
can take `eagerInputStreaming: true`: see [Streaming and waits](#streaming-and-waits).

```ts
import { anthropic } from "llm-large-files/anthropic";

const claude = anthropic({
  model: "claude-opus-5-5",
  baseUrl: process.env.CLAUDE_GATEWAY_URL!, // "https://llm-gateway.example.com/anthropic"
  authToken: () => process.env.CLAUDE_GATEWAY_TOKEN!, // called for each request: return a fresh token here
  headers: { "X-Team": "search" },
  maxRequestBytes: 8_000_000,               // the gateway's own limit
  contextTokens: 1_000_000,
});
```

A gateway that refuses a request with HTTP 413 is taken to have refused it as too large
(`kind: "context_overflow"`), so give it the gateway's limit in `maxRequestBytes` and the request
stays under it.

### Claude on Vertex AI, Amazon Bedrock or Microsoft Foundry

The adapter speaks the Claude API's own Messages endpoint: it posts to `url`, sends the
`anthropic-version` header and `model` in the body. Whether a cloud platform's Claude endpoint
takes requests in that form has not been checked, and `fallbacks` is not offered there. The `fetch`
option sees every request (URL, headers and body) and can change it on its way, but no such path
is tested. If you run Claude on one of these platforms, put a gateway that takes the Messages API
in front of it, or [write an adapter](./own-adapter-and-loop.md) for the platform's own form.

## A conversation that may only grow

`anthropic()` declares `capabilities.appendOnly: true`. Claude checks its thinking blocks against
the conversation they were written in, so an earlier turn that is rewritten makes the later ones
invalid. The loop therefore never rewrites a turn of a question in which a model that is
append-only takes part: Claude alone, Claude answering, or Claude exploring. Three things change.

**Old results are never replaced by stand-ins.** With other models, when the room in the request
runs short, the loop replaces the results of older tool rounds with short stand-ins, and `steps`
says "Older tool results were shortened to make room in the request". With Claude every result
stays as it was. When the calls of a turn do not all fit, the last ones are answered "Not run:
there is no room left in this conversation for another tool result. Answer now, from what the
tools returned so far.", and the next request is the answer. This holds for the whole question:
with Claude answering and Gemini exploring, the explorer's rounds are not shortened either.

**Notes stay in the conversation.** After a first reply with nothing in it, the loop asks once
more with a short note ("Your last reply was empty. …"). A model whose adapter reports a tool call
it could not form (`gemini()` does) gets another note; Claude never needs that one, because a call
of Claude's that cannot be read is answered with a tool result that says what was wrong (see
[Streaming and waits](#streaming-and-waits)). Other models get the note in that one request. When
Claude makes the tool calls, the note stays in its conversation for the rest of the question,
because Claude's later thinking follows it; when Claude is the only model, its request for the
answer has the note too. When Claude only answers, after an explorer of another provider, it never
gets the explorer's notes. The note of the answer's own second try, sent when the answer comes back
without text ("Your last reply had no text. …"), is in that one request only, for Claude too: it
is the last request of the question.

**A request too large is recovered only by planning again.** When Claude refuses a request as
larger than it takes ("prompt is too long: 210417 tokens > 200000 maximum", the error type
`request_too_large`, or HTTP 413), the loop has nothing it may shorten, and does not send the same
request again. If no tool call was answered yet and no text was shown, it plans the documents again
for a smaller window, once a question: the window Claude named, divided by how far Claude's count
was above the estimate (by 1.25 when it gave no count), or, when Claude named none, 7/10 of the
window the budget assumed, divided by that ratio when Claude gave a count; a window that comes out
no smaller than the assumed one becomes 7/10 of it. `steps` then says so: "The first request was
larger than the model's window of 200,000 tokens: the files were planned again to fit it".
Otherwise the error is thrown, with `kind: "context_overflow"`, `limitTokens` and
`requestedTokens`, and `partialResultOf(error)` holds what the question found. [How it works](../how-it-works.md) has the details of both
recoveries.

What this means for your application:

- **Set `contextTokens`** to your model's window, and keep `maxTokens` no larger than you need. A
  right budget is what keeps Claude's requests inside its window.
- **Keep the history in check between questions.** The library shortens no plain turn of the
  history, for any model, and with Claude it shortens no stored tool round either. A long history
  leaves less room for each new question: its documents become cards sooner, fewer results fit,
  and at last its first request is too large. Between two questions the history you pass is yours
  to shorten: it holds no thinking blocks, and the rule above is about the turns of one question.
  Keeping the text of every turn and the `toolTurns` of the last few questions is a simple rule.
  The prompt cache misses once from the first turn you change. See
  [conversations](./conversations.md).
- **Bound a question** with `limits` (`toolTurns`, `inputTokens`, `requests`): see
  [costs and limits](./costs-and-limits.md).

`body` and `betas` pass the API's own features through, context editing among them:

```ts
import { anthropic } from "llm-large-files/anthropic";

const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-5-5",
  betas: ["context-management-2025-06-27"],
  body: { context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } },
});
```

With an edit that clears tool uses (`clear_tool_uses_…`) or compacts the conversation
(`compact_…`) in `body.context_management`, `anthropic()` declares
`capabilities.clearsToolResults: true`. The API may then have cleared a result before Claude reads
the request, so the loop answers no repeated call with a pointer to an earlier result ("already
shown above"): each runs again, and the pointers in stored rounds become stand-ins that say to call
again ([Conversations](./conversations.md#repeated-calls-in-a-follow-up)). In 0.6.0 a pointer could
say a result was "still shown above in full" when the server had cleared it. An edit of
`clear_thinking` alone changes nothing.

The loop still counts every result as sent, so its room runs out at the same point as without
context editing. What clearing does to the bill and the cache is the API's: see Anthropic's
documentation.

## PDF pages and pictures

When the library keeps the original of a PDF, the model gets `view_pages` and can look at up to
five pages a call, as a PDF. [PDFs](./pdfs.md) covers what that needs (`keepOriginals`, the
optional dependencies) and when it helps.

Claude sees a picture, chart or drawing in a PDF only through `view_pages`: the text of a document
cannot show it. With the optional dependency `@cantoo/pdf-lib`, the text marks each page that
shows one ("[Picture on this page. This text cannot show it.]"), so Claude knows which pages to
look at. [PDFs](./pdfs.md) covers the marker, scanned pages and what they need. With Claude:

- **Where the pages go** is `toolFilePlacement`. `"inside"` (the default) puts them in the tool
  result, as a `document` block after the result's JSON. `"beside"` puts them after all the tool
  results of the turn, each after a line such as "pages-2-3.pdf (returned by view_pages):".
  `"none"` turns `view_pages` off, for every model of the question.
- **What a page costs** is `pageTokens`, 3,500 by default: its text and its picture. In the
  library's terms that is divided by `tokenScale`. A question may show pages up to half of
  `reservedTokens`: with the default `maxTokens`, 12 pages when `contextTokens` is not set, and 4
  with a window of 200,000.
- **Pages stay** in every later request of the question, as base64, because Claude's conversation
  only grows. They count against the request size, which is 10 MB unless you raise the library's
  `budget.maxRequestBytes`. The `toolTurns` of the question say that the pages were shown; they do
  not hold them.

```ts
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";

const files = createLargeFiles({
  store: new MemoryDocumentStore(),
  keepOriginals: ["pdf"],                  // view_pages needs the original
  budget: { maxRequestBytes: 32_000_000 }, // Claude's limit, not the library's 10 MB
});
const claude = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-5-5", toolFilePlacement: "inside" });
```

## Errors: `AnthropicRequestError`

A request Claude did not answer throws `AnthropicRequestError`, a `ModelRequestError` with the
API's own word for the error in `type`. Its fields, and every case the adapter throws one for:
[`AnthropicRequestError`](../reference/anthropic.md#anthropicrequesterror). Which errors inside a
stream are sent again: [A stream cut off](./errors-and-reliability.md#a-stream-cut-off).

Two failures of a chat request are not an `AnthropicRequestError`, and have no status or kind: an
error thrown by your `apiKey`, `authToken` or `headers` function, as it was thrown and not sent
again; and the abort of your own `signal`, thrown as it came. A part read of a whole-file read
differs in the first: an error of your `apiKey`, `authToken` or `headers` function becomes an
`AnthropicRequestError` with `status` 0 and `kind: "unreachable"` ("Claude could not be reached
(…)."), and the part read is sent again, as after a connection that failed.

What else the adapter reads from a reply:

- **A body that is not JSON.** A gateway's HTTP 200 whose body is not JSON (an HTML error page) is
  an `AnthropicRequestError` of kind `"invalid"`, status 200, with the `SyntaxError` as `cause`:
  "Claude's reply could not be read: it was not JSON (text/html). A proxy or gateway may have
  answered in its place." It is not sent again, in a chat request or a part read. Until 0.6.1 it
  was the `SyntaxError` itself. An empty body of HTTP 200 is "Claude could not be reached (the
  reply was empty).", status 0, and is sent again.
- **`x-should-retry: false`.** A request that the API says not to try again is not sent again,
  whatever its status, as Anthropic's own SDKs do.
- **No credit, or a spending limit reached.** "Your credit balance is too low" (HTTP 400) and the
  spending limits of an organization ("You have reached your API usage limits", or HTTP 429 with
  `enforced_spend_limit_reached`) are of kind `"quota"`, and are not sent again. The 429 was sent
  again three times before 0.6.1.
- **An error inside a stream** gets the status of its type: `overloaded_error` 529,
  `rate_limit_error` 429, `api_error` 500, `timeout_error` 408, `invalid_request_error` 400,
  `authentication_error` 401, `billing_error` 402, `permission_error` 403, `not_found_error` 404,
  `request_too_large` 413. A type the adapter does not know is the server's failure, 500, and is
  sent again when none of the reply was shown.

The API refuses a request that holds half of a character outside the basic plane, such as half of
an emoji (HTTP 400). Since 0.6.1 the library sends none: a file name, a log template or a search
window that 0.5.0 or 0.6.0 stored cut inside an emoji is sent with U+FFFD in place of the half, and
the message to Claude about a call whose input was not valid JSON quotes up to 300 characters of
it, one fewer when the 300th is the first half of an emoji.

```ts
import { askWithFiles, partialResultOf } from "llm-large-files";
import { AnthropicRequestError } from "llm-large-files/anthropic";

// files, claude and meta as in the first sample.
try {
  const result = await askWithFiles({ files, model: claude, documentIds: [meta.id], messages: [{ role: "user", text: "Which jobs failed?" }] });
  console.log(result.text);
} catch (error) {
  if (error instanceof AnthropicRequestError) {
    // For your logs, not for your users: the message is the API's own.
    console.error(error.status, error.type, error.kind, error.message);
  }
  const partial = partialResultOf(error); // what the question found and paid for before it failed
  if (partial) console.error(`${partial.usage.requests} requests were answered before it failed`);
  throw error;
}
```

What to show your users for each kind, and how retries and deadlines work, is in
[errors and reliability](./errors-and-reliability.md).

## Conversations kept as Messages API messages

If your application keeps its chats as Messages API messages, two functions convert them:

- **`fromAnthropicMessages(history)`** gives the `messages` of `askWithFiles`. Text blocks become
  text. A `tool_use` block and the `tool_result` that answers it become a stored tool round, with
  the result read back from its JSON. A call with no result kept is answered
  `{ error: "No result was kept for this call." }`. Every other block (an image, a document) is
  kept as a native part, which Claude reads. Thinking blocks are left out. `system` is not part of
  the history: pass it to `askWithFiles` as `system`.
- **`anthropicToolTurns(result.toolTurns)`** gives the tool rounds of a question as Messages API
  messages: for each round, an assistant message of `tool_use` blocks and a user message of
  `tool_result` blocks (`is_error: true` for a result with an `error`). Put them between the
  question and its answer.

```ts
import { askWithFiles } from "llm-large-files";
import { anthropicToolTurns, fromAnthropicMessages, type AnthropicMessage } from "llm-large-files/anthropic";

// files, claude and meta as in the first sample. `history` is what your application keeps for the chat.
const history: AnthropicMessage[] = [];

async function ask(question: string): Promise<string> {
  const result = await askWithFiles({
    files,
    model: claude,
    documentIds: [meta.id],
    messages: fromAnthropicMessages([...history, { role: "user", content: question }]),
  });
  // Convert the tool rounds once, and keep what you got: a call without an ID gets a new random one each time.
  history.push({ role: "user", content: question }, ...anthropicToolTurns(result.toolTurns));
  if (result.answered) history.push({ role: "assistant", content: result.text });
  return result.text;
}
```

The IDs of the calls:

- **Since 0.6.0, `anthropicToolTurns` gives a call that came without an ID a random one**,
  `toolu_` and 24 hex digits, the same in its result. Before, it numbered them `toolu_1_1`,
  `toolu_1_2`, … each time, so the stored rounds of two questions had the same IDs, which the
  Messages API refuses. If your code expected IDs of that form, make it accept any ID.
- **IDs of other providers are made valid.** The API takes only the characters `A-Z`, `a-z`, `0-9`,
  `_` and `-`, and each ID once in a request. Others become `_` (Kimi's
  `functions.read_document:0` is sent as `functions_read_document_0`), and an ID used twice gets a
  suffix (`toolu_1_1_2`). `anthropicToolTurns` does this, and so does the adapter for every request,
  so rounds stored from another provider's model can go to Claude as they are. Claude's own turns
  keep their IDs.

A native part goes to every model of a question as it is: with an explorer of another provider, a
block in Claude's form goes to that model too. Keeping toolTurns, history across servers and
mixing providers are in [conversations](./conversations.md).

## Claude answering, Gemini exploring

With an explorer, a second model makes the tool calls and reads whole files in parts, and Claude
writes the answer from what the tools returned. A cheap Gemini model on Vertex AI can explore:

```ts
import { GoogleAuth } from "google-auth-library";
import { askWithFiles } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, vertexAi } from "llm-large-files/gemini";

// files and meta as in the first sample.
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

const explorer = gemini(vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.5-flash-lite",
  accessToken: async () => (await auth.getAccessToken())!,
}));
const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-5-5",
  contextTokens: 1_000_000,
  fallbacks: "default",
});

const result = await askWithFiles({
  files,
  model: claude, // writes the answer
  explorer,      // searches, reads, looks at pages, reads whole files in parts
  documentIds: [meta.id],
  messages: [{ role: "user", text: "Which jobs failed last night, and why?" }],
  onText: (delta) => process.stdout.write(delta),
});
console.log(result.usage.byModel); // "claude-opus-5-5", and "gemini-3.5-flash-lite" when the explorer ran
```

What the pair changes:

- **The explorer works only when there is something to explore**: when every document fits whole
  and no PDF pages can be looked at, Claude answers in one request and Gemini is not called.
- **The budget is planned in Claude's tokens.** Each adapter has its own `tokenScale`: Claude 1.35,
  Gemini 1 (`gemini()` declares none). A question uses the largest, because both models get the
  same conversation. The window is the smallest one declared (or the library's), `maxTokens` is
  kept free, and a page costs Claude's 3,500. Give the Gemini adapter its own `contextTokens` when
  its window is the smaller one.
- **Each count is read by its own model's scale.** The count Gemini reports with a reply is read by
  Gemini's scale, Claude's by Claude's, so the estimate rises when either model counted more than
  its scale says. Before 0.6.0 every count was read by the largest scale, and a Gemini explorer's
  could not raise it.
- **No result is shortened.** Claude is append-only, so the rule
  [above](#a-conversation-that-may-only-grow) holds for the explorer's rounds too.
- **Claude gets the calls and what they returned**, in its own form: an assistant turn of
  `tool_use` blocks and a user turn of `tool_result` blocks. A call that came without an ID is
  given one (`toolu_1_1`: round 1, call 1), the same in its result. Claude does not get the
  explorer's thoughts, its words or its notes.
- **The answer is one request**, with the tools listed and `tool_choice: { type: "none" }`, and a
  line after the last results that asks for the answer: `FINAL_ANSWER_REQUEST`, or
  `FINAL_ANSWER_AFTER_PAGES` when pages were the only thing to look at, or
  `FINAL_ANSWER_WITHOUT_TOOLS` when no tool ran.
- **Pages** are offered when both models can take them: `gemini()` and `anthropic()` both can by
  default.

Claude can explore too (`explorer: anthropic(…)`): its notes then stay in its conversation, and its
requests stream though nothing it writes is shown. Who does what, the cost, and any other pair of
providers are in [explorer model](./explorer-model.md); the Vertex AI setup is in
[Vertex AI and Gemini](./vertex-and-gemini.md).
