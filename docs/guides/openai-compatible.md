# OpenAI-compatible endpoints

This guide shows how to run `askWithFiles` on a model behind the Chat Completions API, with
`openAiCompatible()` from `llm-large-files/openai`: OpenAI, Azure OpenAI, DeepSeek, OpenRouter,
vLLM, Ollama, LiteLLM, llama.cpp, or a gateway of your own. It is for you if one of these is your
only model, or the second model next to Gemini. Every option, with its type and default, is in the
[reference](../reference/openai.md).

## The adapter in one sample

```ts
import { readFile } from "node:fs/promises";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";

const files = createLargeFiles({ store: new MemoryDocumentStore() });

const model = openAiCompatible({
  apiKey: process.env.OPENAI_API_KEY!, // sent as Authorization: Bearer …
  model: "gpt-5.5",                    // baseUrl defaults to https://api.openai.com/v1
  contextTokens: 400_000,              // your model's window: the budget of a question stays inside it
});

const log = await files.ingest({ name: "app.log", bytes: await readFile("app.log") });

const result = await askWithFiles({
  files,
  model,
  documentIds: [log.id],
  messages: [{ role: "user", text: "Which errors came just before the outage?" }],
  onText: (delta) => process.stdout.write(delta), // the answer streams as it is written
});
console.log(result.usage.byModel); // { "gpt-5.5": { requests, inputTokens, outputTokens, … } }
```

`openAiCompatible()` returns a `ModelAdapter`. Give it to `askWithFiles` as `model`, which writes
the answer, or as `explorer`, which searches and reads ([below](#next-to-gemini)). It needs no SDK:
it posts JSON with the global `fetch` and reads the reply, streamed or in one piece. Make each
adapter once, when your server starts, and use it for every question: what it learns about the
server ([the name of the output limit](#the-name-of-the-output-limit)) lives in the adapter.

What it needs to reach the model:

| Option | Default | What it does |
|---|---|---|
| `model` | required | The model name the server knows, sent in every request: `"gpt-5.5"`, an Azure deployment name. It also names the model in usage totals, unless you set `id`. |
| `baseUrl` | `https://api.openai.com/v1` | The base of the API. `/chat/completions` is added to it; slashes at its end are dropped. |
| `url` | `baseUrl` + `/chat/completions` | The whole URL, when it is not built that way: an Azure deployment with `?api-version=`, a gateway. It wins over `baseUrl`. |
| `apiKey` | none | Sent as `Authorization: Bearer …`. A function is called before each request, so a token can be renewed. Without it, no `Authorization` header is sent. |
| `headers` | none | More headers, as an object or a function called before each request. They are added last, so a header spelled the same way (`Content-Type`, `Authorization`) replaces the adapter's own. |
| `contextTokens` | none | The model's context window in tokens. The budget of a question uses the smaller of it and the library's `budget.contextTokens` (1,000,000 unless you set it in `createLargeFiles`). A larger value raises nothing. |

The time it takes to get a key or a token is not counted against the waits of a chat request
(`firstByteTimeoutMs`, `idleTimeoutMs`). In a part read it counts toward `timeoutMs`
([Waits](#waits)).

Set `contextTokens` for every model whose window is smaller than the library's budget. Without it,
the plan assumes a window of 1,000,000 tokens and puts up to 200,000 tokens of documents (the
default `inlineTokens`) into the prompt whole. A server with a smaller window refuses that request
as too large, and the loop has to plan again for a smaller window and send it again
([how](../how-it-works.md)). That costs a refused request in every question, and works only when
the server says so with an error.

## The options that matter for your server

| Option | Default | What it does |
|---|---|---|
| `body` | none | Fields added to every chat request: `temperature`, `reasoning_effort`, an output limit. |
| `analysisBody` | none | `(maxOutputTokens) => fields`, added to each part read of a whole-file read. |
| `maxTokensField` | by host | The name of the output limit in a part read: `"max_tokens"` or `"max_completion_tokens"` ([below](#the-name-of-the-output-limit)). |
| `systemRole` | `"system"` | `"developer"` for a server that wants the newer role name. Used in chat requests and part reads. |
| `answerWithoutTools` | `"tool_choice"` | How the request that must be answered in text says so. `"omit"` for a server that refuses `tool_choice`. |
| `stream` | `true` | `false` for a server that cannot stream. |
| `pdfInput` | `false` | `true` for a model that reads PDF input: `view_pages` is then offered ([Pages of PDFs](#pages-of-pdfs)). |

The waits are [below](#waits); `maxRequestBytes`, `tokenScale`, `pageTokens`, `id` and `fetch`
(a proxy, or a test double: [Testing](./testing.md)) are in the
[reference](../reference/openai.md).

### What goes into a request

The fields of a chat request and of a part read, in their order, are in the reference:
[the body of a chat request](../reference/openai.md#openaicompatibleoptions).

- **`body` is spread last**, so a field there replaces the adapter's own. Leave `model`,
  `messages`, `tools`, `tool_choice` and `stream_options` to the adapter, and use the `stream`
  option instead of a `stream` field.
- **A chat request has no output limit** unless `body` gives one: the server's default applies. If
  you set one there, name it as your server wants. `maxTokensField` is not used for chat requests.
- **`body` is not sent with part reads** of `analyze_whole_document`, which take `analysisBody`
  instead: a setting the part reads need too goes in both.

The request that must be answered in text is the last one of a question when the tool turns or the
room run out, when a `limits` ceiling is reached, when the model's last turn had no text, and
always when there is an explorer; never after a blocked prompt. By default it keeps the tools
listed and sends `tool_choice: "none"`: a server may want the tools declared next to the tool calls
already in the conversation. With `answerWithoutTools: "omit"` the tools are left out of that request instead.

## Recipes

Each recipe makes the adapter only. Use it as `model` or `explorer` in `askWithFiles`, as in the
first sample. The numbers given to `contextTokens` stand for your model's window: set the real one.

### OpenAI

```ts
import { openAiCompatible } from "llm-large-files/openai";

const openai = openAiCompatible({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5.5",
  contextTokens: 400_000,
  body: { reasoning_effort: "none" },                // every chat request: tool calls need it (below)
  analysisBody: () => ({ reasoning_effort: "low" }), // the part reads of a whole-file read, which offer no tools
});
```

- **Tool calls on GPT-5.4 and later need `reasoning_effort: "none"`** through Chat Completions,
  which is their default: with another effort and tools in the request, the API refuses the
  request. The chat requests of the loop offer tools, so leave the effort out of `body`, or set
  `"none"`. A part read offers no tools, and may reason. For reasoning with tools, OpenAI points to
  its Responses API, which this adapter does not speak (planned for 1.0.0).
- Part reads name their output limit `max_completion_tokens`, which OpenAI's newer models require.
- A reasoning model sends nothing while it thinks. `firstByteTimeoutMs` (600 s) is the wait for
  its first piece. Its `completion_tokens_details.reasoning_tokens` are counted as
  `usage.thoughtTokens`, and a part read that spent its limit on reasoning is asked again with a
  larger one ([below](#the-name-of-the-output-limit)).
- `insufficient_quota` (no credit left) is of kind `"quota"`, and is not sent again, in an HTTP
  error or inside a stream.
- OpenAI reports a failure inside a stream that began with HTTP 200 as
  `{ type: "server_error", code: null }`. The adapter takes it for HTTP 500, which is sent again
  when no text of the reply was shown.
- "Request too large for gpt-4o … on tokens per min (TPM): Limit 30000, Requested 45237" (HTTP
  429) is a single request larger than your tier lets through in a minute. No wait mends it, so it
  is of kind `"context_overflow"`, with that limit as `limitTokens`: the loop makes the request
  smaller, or plans the files again for 30,000 tokens, and a part read is read in halves. The step
  says "The first request was larger than the 30,000 tokens a minute that the provider allows: the
  files were planned again to fit it".
- `pdfInput: true` sends pages in the `file` part OpenAI documents for Chat Completions. It has not
  been run against OpenAI.

### Azure OpenAI

With a deployment URL and an API key:

```ts
import { openAiCompatible } from "llm-large-files/openai";

const resource = process.env.AZURE_OPENAI_RESOURCE!; // the name in https://<resource>.openai.azure.com
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT!;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION!;

const azure = openAiCompatible({
  url: `https://${resource}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
  headers: { "api-key": process.env.AZURE_OPENAI_API_KEY! },
  model: deployment, // sent in the body too, and names the model in usage totals
  contextTokens: 400_000,
});
```

With the `/openai/v1` path, `baseUrl` is enough, and `model` is the deployment name. Without a key,
pass a function as `apiKey` that returns a Microsoft Entra ID token: it is called before every
request and sent as `Authorization: Bearer …`.

```ts
import { DefaultAzureCredential } from "@azure/identity";
import { openAiCompatible } from "llm-large-files/openai";

const credential = new DefaultAzureCredential();

const azure = openAiCompatible({
  baseUrl: `https://${process.env.AZURE_OPENAI_RESOURCE}.openai.azure.com/openai/v1`,
  apiKey: async () => (await credential.getToken("https://cognitiveservices.azure.com/.default")).token,
  model: process.env.AZURE_OPENAI_DEPLOYMENT!,
  contextTokens: 400_000,
});
```

Azure OpenAI answers on three kinds of host. On Azure OpenAI's own paths, the adapter names the
output limit of a part read `max_completion_tokens`, because reasoning deployments refuse
`max_tokens`:

| Host | Paths | Output limit in a part read |
|---|---|---|
| `*.openai.azure.com` | all | `max_completion_tokens` |
| `*.cognitiveservices.azure.com`, `*.services.ai.azure.com` | paths with `/openai/` | `max_completion_tokens` |
| `*.cognitiveservices.azure.com`, `*.services.ai.azure.com` | other paths, such as `/models/…` | `max_tokens`: other models are served there |

Azure's "Could not finish the message because max_tokens or model output limit was reached" names
a field without refusing it: the adapter does not change the name for it, and the part read fails
with that message as its error.

### DeepSeek

```ts
import { openAiCompatible } from "llm-large-files/openai";

const deepseek = openAiCompatible({
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-pro", // or "deepseek-reasoner"
  contextTokens: 128_000,
});
```

- **Two user turns in a row are sent as one**, joined by a blank line. The loop can send the
  question and the request for an answer with no turn between them, and DeepSeek's reasoner
  refuses two user turns in a row.
- **The model's own turn goes back with its `reasoning_content`**, streamed or not
  ([the reply](../reference/openai.md#openaicompatibleoptions)). Within a question the loop sends
  it back.
- **Thinking mode and follow-up questions.** In a request with tools, DeepSeek's thinking mode
  asks for the `reasoning_content` of every earlier assistant turn, those of earlier questions
  included, even a turn that made no tool call, and refuses a request without it (HTTP 400). So
  says its [thinking mode guide](https://api-docs.deepseek.com/guides/thinking_mode) (read in
  November 2026). Without tools in the request, earlier reasoning is ignored. The library does not
  keep the reasoning of an answer yet: `AskResult` does not give it, and a stored answer is a
  `ChatTurn` of text. So a follow-up question that offers tools goes out without the reasoning of
  the earlier answers, and DeepSeek refuses it. Thinking is on by default on DeepSeek's current
  models. In a chat of several questions, turn it off for chat requests. The part reads of a
  whole-file read offer no tools and do not use `body`, so they keep thinking:

  ```ts
  const deepseek = openAiCompatible({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: "deepseek-v4-pro",
    contextTokens: 128_000,
    body: { thinking: { type: "disabled" } }, // chat requests: a follow-up offers tools
  });
  ```

  A first question, with no earlier answer in `messages`, works with thinking on. The tool rounds
  of earlier questions can carry their reasoning already: `openAiToolTurns(result.toolTurns, { native: true })`
  writes it in Chat Completions messages ([below](#conversations-kept-as-chat-completions-messages)),
  and `capabilities.nativeRounds` is true for the loop that sends stored rounds in their own form.
  The reasoning of the answer turns is planned for a later 0.10.x.
- **`insufficient_system_resource`**: DeepSeek stops a reply when its servers run short. The
  adapter takes that for the server's failure, HTTP 503, and the loop sends the request again. A
  reply that is not streamed is checked before any of it is shown, so it can always be sent again;
  a streamed one only when none of its text was shown yet.
- **Blank lines while a request waits** count as pieces of the reply, so a slow reply that is not
  streamed does not run out the [waits](#waits).
- **Cached input**: `prompt_cache_hit_tokens` is counted as `usage.cachedInputTokens`.
- **No balance left**: "Insufficient Balance" comes as HTTP 402, of kind `"quota"`, and is not sent
  again.
- Part reads name their output limit `max_tokens`.

### OpenRouter

```ts
import { openAiCompatible } from "llm-large-files/openai";

const openrouter = openAiCompatible({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: process.env.OPENROUTER_MODEL!, // "vendor/model", as OpenRouter names it
  contextTokens: 1_000_000,
});
```

- **Reasoning is kept and sent back.** A streamed reply's `reasoning` and `reasoning_details` are
  put together piece by piece (pieces of one detail share its `index`), kept in their order with
  their other fields, and sent back with the turn unchanged. They hold the thought signature of a
  Gemini 3 model behind OpenRouter, which that model needs in the next request.
- A request larger than the model takes is recognized from OpenRouter's error, with the window it
  names, and the loop makes the request smaller.
- "Insufficient credits" comes as HTTP 402, of kind `"quota"`, and is not sent again.
- Part reads name their output limit `max_tokens`, unless the model behind refuses it
  ([below](#the-name-of-the-output-limit)).

### vLLM, Ollama and llama.cpp

A server of your own needs its URL, the model name it serves, and the window it runs the model
with. Give `apiKey` only if your server asks for one.

```ts
import { openAiCompatible } from "llm-large-files/openai";

const vllm = openAiCompatible({
  baseUrl: "http://localhost:8000/v1",
  model: "my-model",     // the name the server serves the model under
  contextTokens: 32_768, // the server's max_model_len
});

const ollama = openAiCompatible({
  baseUrl: "http://localhost:11434/v1",
  model: "my-model",
  contextTokens: 32_768, // the context length the model runs with on this server
});

const llamaCpp = openAiCompatible({
  baseUrl: "http://localhost:8080/v1", // llama-server
  model: "my-model",
  contextTokens: 16_384, // the context size the server was started with
});
```

What the adapter handles for these servers:

- **Tool calls.** The tools are sent as `tools` with `type: "function"`. The server must return
  `tool_calls` for the model you serve; how to turn that on is the server's own setting.
- **Arguments that are not JSON.** A call whose arguments are not a JSON object is not run: the
  model is told what was wrong and can send it again. The call goes back with `"{}"` as its
  arguments, and so does a call whose arguments came empty: vLLM before 0.29 refuses the next
  request of a conversation that holds such a call (HTTP 400).
- **Two user turns in a row are sent as one.** The chat templates of Mistral and Gemma models
  refuse them.
- **A request larger than the window.** vLLM's error names the window (`max_model_len`) and the
  tokens asked for ("your request has 40000 input tokens" in its newer wording), and the loop reads
  both. The wordings of llama.cpp, LM Studio ("loaded with context length of only 4096 tokens"),
  Text Generation Inference and Together ("`inputs` tokens + `max_new_tokens` must be <= 32769.
  Given: 40000 …") and Amazon Bedrock ("Input is too long for requested model.") are recognized
  too. The loop then makes the request smaller and sends it again, but each question pays for the
  refused request: set `contextTokens`.
- **An error's message, wherever the server puts it.** Most servers put it in `error`. vLLM before
  its OpenAI-shaped errors, SGLang and FastChat put a `message` at the top of the body, and servers
  built on FastAPI a `detail` (a list of problems gives their `msg` joined with "; "). The adapter
  reads all three; before 0.6.0, such a request too large became "The model returned HTTP 400.",
  and the loop did not make it smaller.
- **The output limit** of a part read is named `max_tokens`.
- **`answerWithoutTools: "omit"`** for a server that refuses `tool_choice`, and
  **`stream: false`** for one that cannot stream.

What it cannot see: a server that cuts a prompt to fit its window, without an error, answers from
what was left, and nothing tells the library so. `contextTokens` set to the window the server
really runs with is the only guard.

### LiteLLM and other gateways

```ts
import { openAiCompatible } from "llm-large-files/openai";

const gateway = openAiCompatible({
  baseUrl: process.env.LITELLM_BASE_URL!, // the proxy's base URL; /chat/completions is added
  apiKey: process.env.LITELLM_API_KEY!,   // a key the proxy issued
  model: "reasoning-model",               // the model name in the proxy's configuration
  maxTokensField: "max_completion_tokens", // the model behind it is an OpenAI reasoning model
  contextTokens: 200_000,
  id: "litellm/reasoning-model",
});
```

- The host of a gateway is not OpenAI's, so part reads name their output limit `max_tokens`. When
  the model behind it refuses that name, the adapter learns the other one, at the cost of one
  refused request per adapter. `maxTokensField` saves that request.
- Set `maxRequestBytes` when the gateway limits the size of a request body. The budget's
  `maxRequestBytes` (10 MB by default) is lowered to it, never raised.
- `id` names the adapter in `usage.byModel` (it defaults to `model`). Set it when two adapters
  use the same model name.
- A gateway that gives up on a long request answers with an HTTP error (a 504, say), which is sent
  again. Its own timeout should be longer than the model takes to start a reply: a reasoning model
  sends nothing while it thinks. See [Deployment](./deployment.md) for proxies in front of your
  own server.
- A gateway that streams under another content type than `text/event-stream`
  (`application/octet-stream`, or none) is read by what its body starts with: events after
  `data:` or a comment, JSON after `{` or `[`. One that answers HTTP 200 with a page of its own (a
  sign-in page) fails with kind `"invalid"`, status 200, "The model's reply could not be read: it
  was not JSON (text/html). A proxy or gateway may have answered in its place.", and is not sent
  again. An empty body of HTTP 200 is sent again, as a reply cut off on its way.
- A gateway that sends `[DONE]` and then keeps the connection open is left one second later, with
  the whole reply; so is one whose connection breaks after `[DONE]`. 0.5.0 waited for such a
  connection to close, and took one that broke for a model that could not be reached, with the
  answer already shown.

## The name of the output limit

Only the part reads of a whole-file read send an output limit; chat requests do not, unless your
`body` does. Servers disagree on its name: OpenAI's newer models refuse `max_tokens` and want
`max_completion_tokens`, and many other servers know only `max_tokens`.

When you do not set `maxTokensField`, the name is chosen from the URL:

| URL | Name |
|---|---|
| `openai.com` and its subdomains (`api.openai.com`) | `max_completion_tokens` |
| Azure OpenAI ([the hosts above](#azure-openai)) | `max_completion_tokens` |
| Any other | `max_tokens` |

It is then learned. A part read that gets HTTP 400 refusing the name it was sent is sent again at
once with the other name, and the adapter keeps that name for every later part read. A refusal is
an error whose `param` is that name with the code `unsupported_parameter` or words that refuse it,
or, without a `param`, a message such as "Unsupported parameter: 'max_tokens' … Use
'max_completion_tokens' instead", where the refused name comes first. Part reads refused at the
same time learn it once. An error that only mentions a name ("max_tokens or model output limit was
reached", "max_tokens is too large") changes nothing. When you set `maxTokensField`, that name is
always sent and nothing is learned.

The number itself: part notes start at 4,096 output tokens, and the answer of a whole-file read at
8,192. A reasoning model counts its reasoning in that limit. When a part read is cut off with
nothing written, or with half its limit or more spent on reasoning (as the server reports it in
`completion_tokens_details.reasoning_tokens`), it is asked again with 32,768, and later part reads
of the same URL and model in this process start there. A server that refuses
32,768 with HTTP 400 is not asked for it again, unless the 400 says the request was too large for
the model's window with that limit and the window is larger than 32,768: a later part may still
get it. A request refused as larger than the tokens a minute allows (OpenAI's or Groq's TPM) turns
the larger limit off when that allowance is no larger than 32,768. Both requests are counted in
`usage`.

## Waits

| Wait | Option | Default | For |
|---|---|---|---|
| Before the first piece of a reply | `firstByteTimeoutMs` | 600,000 ms | Chat requests |
| Between two pieces of a reply | `idleTimeoutMs` | 300,000 ms | Chat requests |
| One request, in all | `timeoutMs` | 180,000 ms | Part reads |

- **Headers do not count** as a piece of a chat reply: a model that thinks sends nothing until it
  has thought, and a reply that is not streamed comes whole at the end. Keep-alives count: an SSE
  comment, or DeepSeek's blank lines in a reply that is not streamed. A reply that keeps arriving
  has no limit in time. 0 waits without end.
- **When a wait runs out**, the request is aborted with an `OpenAiRequestError` of status 0 and kind
  `"timeout"` ("The model sent nothing for 600 s."). `askWithFiles` sends it again once, unless
  text of it was already shown.
- **A part read** has `timeoutMs` for the whole request, reply included. One that runs out is an
  `OpenAiRequestError` of status 0 and kind `"timeout"` ("The model took longer than 180 s to
  answer."), since 0.10.0; before, the abort error of the timer, with no status, tried once more at
  once. It is tried once more, after the retry wait (`retry.baseDelayMs`: 250 to 500 ms by default)
  and with a `retry` event, and then counts as a part that could not be read, which the
  tool result says ("The model took too long to answer."). Raise `timeoutMs` for a model that
  thinks long over a large part; 0 sets none (since 0.10.0).

How failed requests are sent again, and what to tell your user, is in
[Errors and reliability](./errors-and-reliability.md).

## Errors

A request that failed throws an `OpenAiRequestError`, a `ModelRequestError` of this adapter. Its
fields, and every message the adapter writes with its status and kind:
[`OpenAiRequestError`](../reference/openai.md#openairequesterror) and the errors table under
[`openAiCompatible()`](../reference/openai.md#openaicompatibleoptions).

`code` and `param` are new in 0.6.0. They come from an HTTP error response, and from an error
inside a stream too: `context_length_exceeded` there is HTTP 400, of kind `"context_overflow"`,
and `insufficient_quota` HTTP 429, of kind `"quota"`. In 0.5.0 an error inside a stream kept the
stream's HTTP 200, and was not sent again. `retryAfterMs` comes from an HTTP error response only.

A reply of HTTP 200 whose body is not JSON is an `OpenAiRequestError` of kind `"invalid"`, status
200, with the `SyntaxError` as `cause`: "The model's reply could not be read: it was not JSON
(text/html). A proxy or gateway may have answered in its place." It was a `SyntaxError` before
0.6.0. An empty body of HTTP 200 is "The model could not be reached (the reply was empty).", status
0, and is sent again.

```ts
import { askWithFiles, partialResultOf } from "llm-large-files";
import { OpenAiRequestError } from "llm-large-files/openai";

// files and model as in the first sample; documentIds and messages from your application.
try {
  const result = await askWithFiles({ files, model, documentIds, messages });
  console.log(result.text);
} catch (error) {
  if (error instanceof OpenAiRequestError) {
    // The provider's own words: log them, and show your user a message of your own.
    console.error({ status: error.status, kind: error.kind, code: error.code, param: error.param, message: error.message });
  }
  const partial = partialResultOf(error); // what the question found and paid for before it failed
  if (partial) console.error(partial.usage);
  throw error;
}
```

The kinds, the retries and a message for each case: [Errors and reliability](./errors-and-reliability.md).
The classes and helpers: [the errors reference](../reference/errors-and-retries.md).

## What the adapter does with a reply

When it streams, what goes back to the model, how `finish_reason`, refusals and usage are read, and
the IDs it gives calls that came without one: "Streaming" and "The reply" under
[`openAiCompatible()`](../reference/openai.md#openaicompatibleoptions). A streamed tool call goes
back with every field the server sent in it, such as `extra_content`. A server that sends the name
of a tool call again with each piece of it is read right: the name is not doubled
(`search_documentsearch_document`, which the loop answered as an unknown tool before 0.6.0).

## What it does not do

- It speaks Chat Completions only, at `/chat/completions` or your `url`. OpenAI's Responses API is
  not supported.
- It sends no output limit in chat requests, and no prompt-cache settings. Cached tokens the server
  reports are counted.
- It does not ask the server for the model's window. Without `contextTokens` the library's budget
  holds.
- It counts no tokens with the model's tokenizer. The library estimates them, scaled by
  `tokenScale`, and a question corrects the estimate by the counts the server reports.
- It cannot tell that a server cut a prompt down without an error.
- It sends no pages of PDFs unless `pdfInput` is on.

## Pages of PDFs

By default the adapter says that its model cannot be sent a file, so `view_pages` is not offered.
That holds for the whole question: next to a Gemini model that could read the pages, an
OpenAI-compatible model without `pdfInput` turns them off for both.

```ts
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";

const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });

const model = openAiCompatible({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5.5",
  pdfInput: true,    // view_pages is offered, and its pages go to the model as a file part
  pageTokens: 1_000, // what the model bills for one page; 1,000 is the default
});
```

With `pdfInput: true`, the pages of a `view_pages` call go in a user message after the tool
results: a line that names the file ("pages-2-3.pdf (returned by view_pages):"), then a `file` part
with `filename` and `file_data` as a base64 data URL. A tool message holds text only, so they
cannot go inside it. `pageTokens` is what one page costs in the budget of a question.

Turn it on only for a model that reads PDF input. It has not worked on any server yet: Gemini's
OpenAI layer refuses the `file` part (HTTP 400), and it has not been run against OpenAI or any
other server that reads PDF input. Keeping originals, the optional
dependencies and the costs of pages are in [PDFs](./pdfs.md).

## Conversations kept as Chat Completions messages

If your application keeps its history as Chat Completions messages, two functions convert it:

```ts
import { askWithFiles } from "llm-large-files";
import { fromOpenAiMessages, openAiToolTurns, type OpenAiMessage } from "llm-large-files/openai";

// loadHistory and saveHistory are your own storage; chatId and question come from the request;
// files, model and documentIds as before.
const history: OpenAiMessage[] = await loadHistory(chatId);
history.push({ role: "user", content: question });

const { system, messages } = fromOpenAiMessages(history);
const result = await askWithFiles({ files, model, documentIds, system, messages });

// What this question read goes between the question and its answer, in the same form.
history.push(...openAiToolTurns(result.toolTurns));
if (result.answered) history.push({ role: "assistant", content: result.text });
await saveHistory(chatId, history);
```

`fromOpenAiMessages(history)`:

- joins the `system` and `developer` messages, with a blank line between them, into `system`;
- keeps text as text, and any other content part (`image_url`, a `file`) as a native part, sent to
  the model as it is;
- makes an assistant turn of tool calls, and the `tool` messages that answer it, one stored round.
  A tool message is read as a JSON object, or kept as `{ text }`. A call with no tool message gets
  `{ error: "No result was kept for this call." }`, and a tool message whose call is not in the
  history is dropped;
- does not keep the text of an assistant turn that also made tool calls.

`openAiToolTurns(result.toolTurns)` gives each round as an assistant message with its
`tool_calls` and one `tool` message per call, its content the JSON of the result. With
`{ native: true }` (new in 0.10.0), a round that kept its own assistant message (`ToolTurn.native`)
gets that message's `reasoning_content` back, which DeepSeek's thinking mode asks for in a request
with tools. **Since 0.6.0, a
call that came without an ID gets a random one**, `call_` and 24 hexadecimal characters, and a new
one each time you convert. Before, they were numbered from 1 each time, so the stored rounds of two
questions had the same IDs. Convert a question's rounds once and store the messages; do not convert
them again and compare IDs.

Why to keep the rounds, how large they grow and how to keep a long conversation inside the window:
[Conversations](./conversations.md).

## Next to Gemini

`askWithFiles` takes two adapters of any providers: `explorer` makes the tool calls and the part
reads, and `model` writes the answer from what they returned. A cheap OpenAI-compatible model can
explore while Gemini on Vertex AI answers:

```ts
import { GoogleAuth } from "google-auth-library";
import { askWithFiles } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

// Writes the answer, streamed.
const answering = gemini(vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
}), { contextTokens: 1_000_000 });

// Searches, reads, and reads whole files in parts.
const explorer = openAiCompatible({
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-flash",
  contextTokens: 128_000,
});

// files, documentIds and messages as before; send() writes to your stream to the browser.
const result = await askWithFiles({
  files,
  documentIds,
  messages,
  model: answering,
  explorer,
  onText: (delta) => send(delta),
});
console.log(result.usage.byModel); // one entry for "gemini-3.8-flash", one for "deepseek-v4-flash"
```

The other way round works the same: `model: openAiCompatible(…)`, `explorer: gemini(…)`. What to
know about the pair:

- **Each model gets the conversation in its own form.** The explorer's own turns, with their
  reasoning or signatures, go back only to the explorer. The answering model gets the calls and
  what they returned, built in its form. A call that came without an ID goes to Gemini without
  one. When the OpenAI-compatible model answers (the other way round), such a call is given one:
  `call_1_1` for the first call of the first round.
- **The budget fits the smaller window** that the two adapters declare, and the larger
  `tokenScale`. Give each its `contextTokens`.
- **`view_pages` needs both models to take files**: the OpenAI-compatible one only with `pdfInput`.
- **The explorer's requests are not streamed.** A thinking explorer sends nothing until its reply
  is whole, and `firstByteTimeoutMs` is its wait.
- **The part reads are the explorer's**: its `analysisBody`, `maxTokensField` and `timeoutMs`
  apply.
- **Native parts reach both models.** An `image_url` part in `messages` is sent to Gemini
  unchanged, in OpenAI's form, which is not a Gemini part. With two providers, keep the turns to
  text, or to parts both read.
- **`askGemini` cannot do this**: its explorer is a Gemini model. Use `askWithFiles` with
  `gemini(vertexAi(…))`, as above.

Who does what, what changes for your application, and what it costs:
[An explorer model](./explorer-model.md). Setting up Gemini and Vertex AI:
[Gemini and Vertex AI](./vertex-and-gemini.md).

Gemini also has an OpenAI layer, at `https://generativelanguage.googleapis.com/v1beta/openai`, and
the adapter reads its errors, which come wrapped in a list. For Gemini, `gemini()` is the adapter to
use: it sends pages to the model, which the layer refuses as a `file` part. The layer also leaves a
thinking model's thoughts out of its usage: in a live check in 0.10.0 on `gemini-3.8-flash`, its
`total_tokens` was about 46 more than `prompt_tokens` plus `completion_tokens`, with no
`reasoning_tokens`. Those tokens are billed, but `usage.outputTokens` does not hold them, and
`usage.thoughtTokens` is 0. `result.lastUsage` keeps the layer's own object, `total_tokens`
included.

## What was run live

The live checks on record for this adapter ran on Gemini's OpenAI layer, in 0.5.0: a streamed
question about a 5.2 MB log, an explorer behind the layer with a thinking Gemini model answering,
and a part read. In each, the usage the library returned was what the provider reported. `pdfInput`
has not worked on any server yet: Gemini's OpenAI layer refuses its `file` part. The handling for the other servers in this guide is covered
by the tests in `test/openai.test.ts` and `test/loop-robustness.test.ts`, which replay the shapes
of their requests and replies. Dates and numbers are in [Measurements](../measurements.md).
