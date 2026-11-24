# Gemini API and Vertex AI

This guide sets up Gemini for production, on Vertex AI or on the Gemini API: endpoints and access
tokens, `askGemini` or `askWithFiles` with `gemini()`, fields of your own in the request (safety
settings, labels), the waits on a model that thinks, thinking, the budget, an explorer model,
whole-file reads, pages of PDFs, an enterprise gateway, quotas and errors. It is for developers who call Gemini from a server. Every export and option of
`llm-large-files/gemini` is listed in the [reference](../reference/gemini.md).

## Vertex AI or the Gemini API

`vertexAi()` and `geminiApi()` each return a `GeminiEndpoint`: the URLs of one model and the
headers to send. The adapter, the tools and the loop are the same for both. Only the URL and the
headers differ.

| | `vertexAi()` | `geminiApi()` |
|---|---|---|
| Sign-in | An OAuth access token, sent as `Authorization: Bearer …`; or an API key of express mode (`apiKey`, since 0.10.0) | An API key, sent as the `x-goog-api-key` header |
| Host | The host of the `location` you pick, `"global"` by default, or one of your own (`host`) | `https://generativelanguage.googleapis.com` (`baseUrl`) |
| API version | `"v1"` (`apiVersion`) | `"v1beta"` (`apiVersion`) |
| Streaming | `streamUrl` is set (`:streamGenerateContent?alt=sse`) | The same |
| A second model that explores | `explorerModel` | `explorerModel` |

Use Vertex AI when your servers run in a Google Cloud project: access goes through IAM and service
accounts, so there is no long-lived key to keep secret, you choose the location that processes the
requests, and quotas and billing are the project's. Use the Gemini API for a setup with an API key,
for prototypes and for tests.

### Vertex AI

`vertexAi({ project, model, accessToken, location?, apiVersion?, explorerModel?, headers?, host? })` builds the URL
`{host}/{apiVersion}/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`,
and the same with `:streamGenerateContent?alt=sse` for streaming. `location` defaults to
`"global"`. The host follows the location: see [`vertexHost()`](../reference/gemini.md#vertexhostlocation).

With `"global"`, Google may serve a request from any region. Pick `"us"`, `"eu"` or a region when
your data must be processed there. Which models a location offers is Google's to say: a model name
the location does not have is refused, and the error has `kind` `"invalid"`. Set `apiVersion` only
when you need another version of the API than `"v1"`. The library was checked live on Vertex AI in
the `global` and `eu` locations: see [Measurements](../measurements.md).

Three options are new in 0.10.0:

- **`headers`**: more headers, merged after the library's, so a name you give replaces the
  library's (`x-goog-user-project` for the project that is billed, `x-server-timeout`). A function
  is called before every request, with the same context as the token function (below).
- **`host`**: the https origin to send the requests to, in place of the host of the location: a
  Private Service Connect endpoint, or a proxy that keeps Vertex AI's paths. It must be an origin
  and nothing more (`"https://vertex.psc.example.internal"`, a port allowed): a path, a query, a
  fragment or an `@` throws a `TypeError`, since the token would go to another host.
- **`apiKey`**: Vertex AI express mode. The key goes in the `x-goog-api-key` header, and the URL
  names no project or location: `https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:generateContent`.
  Give `apiKey`, or `project` and `accessToken`, not both.

```ts
import { vertexAi } from "llm-large-files/gemini";

// accessToken as in Access tokens for Vertex AI below.
const privateEndpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "europe-west4",
  model: "gemini-3.8-flash",
  accessToken,
  host: process.env.VERTEX_HOST!, // "https://…": where your network reaches Vertex AI
  headers: { "x-goog-user-project": process.env.BILLING_PROJECT! },
});

// Express mode: an API key, no project.
const express = vertexAi({ apiKey: process.env.VERTEX_API_KEY!, model: "gemini-3.8-flash" });
```

### Access tokens for Vertex AI

`accessToken` is a string, or a function that returns one. Give a function: the adapter calls it
before every request, the part reads of a whole-file read included, so a token that was renewed is
used, and a question that outlasts a token keeps working. A string is sent as it is for as long as
the endpoint lives, and an access token expires (after an hour, by default): use one only in a
script.

The usual source is `google-auth-library` with application default credentials (ADC). It is not a
dependency of this package:

```bash
npm install google-auth-library
```

```ts
import { GoogleAuth } from "google-auth-library";
import { vertexAi } from "llm-large-files/gemini";

// Application default credentials: on Google Cloud (Cloud Run, GKE with Workload Identity, Compute
// Engine), the service account the server runs as; elsewhere, the key file that
// GOOGLE_APPLICATION_CREDENTIALS names; on a laptop, `gcloud auth application-default login`.
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

// Called before every request. GoogleAuth keeps the token and fetches a new one when it is about
// to expire, so the call is cheap. After a 401 it is called with { refresh: true }: the token in the
// cache was refused, so it is marked expired and a new one is fetched.
async function accessToken({ refresh }: { refresh: boolean }): Promise<string> {
  const client = await auth.getClient();
  if (refresh) client.setCredentials({ ...client.credentials, expiry_date: 1 });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("No access token from the application default credentials.");
  return token;
}

const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: "gemini-3.8-flash",
  accessToken,
});
```

- **A service account.** Prefer the account the server runs as (attached to Cloud Run or Compute
  Engine, or mapped to a Kubernetes service account with Workload Identity): there is no key file
  to store. Off Google Cloud, point `GOOGLE_APPLICATION_CREDENTIALS` at its key file, or pass
  `keyFilename` to `GoogleAuth`. The account needs a role that may call the model, such as Vertex AI
  User (`roles/aiplatform.user`).
- **An error thrown by your function** has no HTTP status and no `kind`. In a chat request it ends
  the question with that error: the request is not sent again. In a part read it is tried once
  more, and the part is then reported as one that could not be read.
- **A token that is refused with HTTP 401** is asked for again, since 0.10.0, when `accessToken` is
  a function: the function is called with `{ refresh: true }`, and the request is sent once more
  with the token it returns. A token provider such as `google-auth-library` returns the token in
  its cache until it nears its expiry, so calling it the same way again would send the token that
  was refused: force a new one when `refresh` is true, as the sample does. That sample works for
  the clients that keep their token in `credentials`: a service account, the metadata server
  (Cloud Run, GKE, Compute Engine) and user credentials. A second 401 is the error: there is no
  third try. A token given as a string, an API key and a gateway's headers get no second try.
- **A token that is refused for good** (HTTP 401 twice, or 403: a missing role, the Vertex AI API
  not enabled in the project) is a `GeminiRequestError` with `kind` `"auth"`. It is not sent again.

### The Gemini API

```ts
import { geminiApi } from "llm-large-files/gemini";

const endpoint = geminiApi({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.8-flash",
});
// endpoint.url:       https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
// endpoint.streamUrl: https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse
```

The key goes in a header, not in the URL, so it stays out of URL logs. `baseUrl` points the endpoint
at a proxy that keeps the Gemini API's paths. The samples below that take an `endpoint` use the
Vertex AI one of [Access tokens for Vertex AI](#access-tokens-for-vertex-ai); a `geminiApi()`
endpoint can take its place.

## `askGemini` or `askWithFiles` with `gemini()`

`askGemini` is [`askWithFiles`](../reference/ask.md#askwithfilesoptions) with Gemini models made for
you. It builds `gemini(endpoint, …)` for the model that answers and, when the endpoint names an
explorer (`explorerUrl`, which `explorerModel` sets), a second `gemini()` for it, with the same
headers.

```ts
import { readFile } from "node:fs/promises";
import { createLargeFiles, FileDocumentStore, type ChatTurn } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";

// endpoint as in Access tokens for Vertex AI.
const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });
const meta = await files.ingest({ name: "import.log", bytes: await readFile("./import.log") });

const documentIds = [meta.id];
const messages: ChatTurn[] = [{ role: "user", text: "Why did the import fail at 02:00?" }];

const result = await askGemini({
  files, endpoint, documentIds, messages,
  onText: (delta) => process.stdout.write(delta), // streamed: the endpoint has a streamUrl
});
console.log(result.answered, result.usage.byModel);
```

On top of `askWithFiles`, `askGemini` adds:

- `contents`: the history as Gemini `contents`, with images or inline PDFs, in place of `messages`
  ([below](#gemini-history-stored-as-contents)).
- `generationConfig` for the model that answers and `explorerGenerationConfig` for the explorer.
- `body` for the model that answers and `explorerBody` for the explorer (new in 0.10.0;
  [below](#fields-of-your-own-safety-settings-labels-and-more)).
- One value of `toolFilePlacement`, `analysisConfig`, `analysisBody`, `functionCallingMode`,
  `answerWithoutTools`, `timeoutMs`, `firstByteTimeoutMs`, `idleTimeoutMs` and `fetch`, given to
  both models.
- `maxToolTurns` and `maxToolCallsPerTurn`, the names that `limits.toolTurns` and
  `limits.callsPerTurn` had before 0.5.0. `limits` wins when both are set.

Every other option goes to `askWithFiles` as it is. Since 0.10.0 the type of `askGemini`'s options
is that of `askWithFiles`'s, with the models taken out and the options above added: an option new
in `askWithFiles` reaches the loop through `askGemini` too. What `askGemini` cannot do:

| You need | `askGemini` | `askWithFiles` with `gemini()` |
|---|---|---|
| A smaller window or request size for the model, so the budget follows it down | No: set them in the budget ([below](#the-window-and-the-budget)) | `contextTokens`, `maxRequestBytes` |
| The cost of a page, the name in `usage.byModel` | No: 530 tokens, the model in the URL | `pageTokens`, `id` |
| An explorer with other headers, or of another provider | No: the same headers (with `vertexAi()` or `geminiApi()`, the same project, location and key too) | `explorer`: any adapter |
| Different waits, `fetch` or `toolFilePlacement` for each model | No: one value for both | Each adapter its own |
| A part reader of your own | No | Yes: an adapter whose `generateText` is yours |

Start with `askGemini`. Move to `askWithFiles` when you need a row of this table:

```ts
import { askWithFiles } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";

// files, documentIds and messages as in the sample above; accessToken as in Access tokens for Vertex AI.
const model = gemini(
  vertexAi({ project: process.env.GOOGLE_CLOUD_PROJECT!, model: "gemini-3.8-flash", accessToken }),
  { generationConfig: { temperature: 0.3 } },
);

const result = await askWithFiles({
  files, model, documentIds, messages,
  onText: (delta) => process.stdout.write(delta),
});
```

What the Gemini adapter does in either case:

- **It streams** a reply when `onText` is given and the endpoint has a `streamUrl`. Otherwise each
  reply arrives whole, and `onText` gets its text once the reply is in: one call for each text part.
- **It sends its own model turns back unchanged** in the later requests of the question, because
  Gemini 3 wants its thought signatures back. Another model gets them rebuilt from their function
  calls, without signatures, as stored `toolTurns` always are. With an explorer, that is the
  answering model.
- **It never shows thoughts.** Parts that Gemini marks `"thought": true` are not in `text` and not
  passed to `onText`.
- **The request that must be answered in text declares no tools**, by default. Gemini can ignore
  `functionCallingConfig` mode `NONE` and go on calling them. `answerWithoutTools: "mode_none"`
  (new in 0.10.0) keeps the tools and sends mode `NONE`, so that the request starts as the ones
  before it did, which may let Vertex AI's prompt cache serve more of it; a tool call that still
  comes back is asked for again once. "omit" stays the default until a live measure says otherwise.
- **A stream that ends without a `finishReason` was cut off** on its way (a proxy, a dropped
  connection). It is sent again when none of its text was shown, and is an error otherwise.
- **A turn with `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL` or (since 0.10.0)
  `MALFORMED_RESPONSE`** is asked for once more, the request for the answer included: there the
  note says that no tool can be called, and asks for the answer in text.
- **Finish reasons.** `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`,
  `IMAGE_SAFETY` and, since 0.10.0, `MODEL_ARMOR` (Vertex AI's Model Armor), `IMAGE_PROHIBITED_CONTENT`,
  `IMAGE_RECITATION` and `IMAGE_OTHER` mark a reply that a filter stopped: `finish` `"filtered"`.
  `MAX_TOKENS` marks one cut off at the output limit: `"cut"`. Since 0.10.0 `OTHER`,
  `FINISH_REASON_UNSPECIFIED`, `NO_IMAGE`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE` and
  `LANGUAGE` are `"other"`: a reason that asking again does not mend. `LANGUAGE` (a language the
  model does not take) is no safety filter: tell a Hebrew user so, not that a filter stopped the
  answer. The provider's own word is always in `finishReason`.

**Usage.** `usage.byModel` is keyed by the model name in the URL (`"gemini-3.8-flash"`). Input
tokens are `promptTokenCount` plus `toolUsePromptTokenCount`, cached tokens `cachedContentTokenCount`,
and output tokens `candidatesTokenCount` plus `thoughtsTokenCount` (the thoughts are also
`thoughtTokens`). `lastUsage` is Gemini's own `usageMetadata` of the last response. Turning that into
a cost: [Costs and limits](./costs-and-limits.md).

## Fields of your own: safety settings, labels and more

`body` adds fields to the body of every chat request, the request for the answer included, and
`analysisBody` to each part read of a whole-file read. They are merged last, after the library's,
and are counted in the size of the request. New in 0.10.0, in the shape of the `body` and
`analysisBody` of the [OpenAI-compatible](./openai-compatible.md) and [Claude](./anthropic.md)
adapters.

```ts
import { askGemini, type GeminiRequestFields } from "llm-large-files/gemini";

// files, endpoint, documentIds and messages as in the askGemini sample above.
const body: GeminiRequestFields = {
  safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
  labels: { app: "chatbot", team: "hr" }, // Vertex AI: billing labels. No user IDs.
};
await askGemini({
  files, endpoint, documentIds, messages,
  body,                                        // the answering model, and the explorer
  explorerBody: { labels: { app: "chatbot", role: "explorer" } }, // the explorer, when it needs other fields
  analysisBody: () => ({ labels: { app: "chatbot", role: "parts" } }), // part reads
  functionCallingMode: "VALIDATED",
});
```

- **`GeminiRequestFields`** types `safetySettings`, `labels`, `serviceTier` and `cachedContent`, and
  takes any other field of the API. The fields the library writes (`contents`,
  `systemInstruction`, `tools`, `toolConfig`, `generationConfig`) are typed `never`, so setting one
  fails to compile: `generationConfig` and `analysisConfig` set those. Nothing is refused at run
  time.
- **Labels reach the billing export** of the project, and everyone who reads it. Keys and values
  are lower case, at most 63 characters. Never put a user ID, an email or other personal data in
  them: label by app, team or feature. The Gemini API does not take labels.
- **A reply a safety setting stops** has `finish` `"filtered"`, as one stopped by Gemini's own
  filters.
- **`cachedContent`** names an explicit context cache (`cachedContents/…`) that you made with the
  API. The library makes none: Gemini 3 caches the start of a request by itself (implicit caching),
  and the library keeps that start the same from one request to the next.
- **`functionCallingMode: "VALIDATED"`** has Gemini check each call against the declaration of its
  tool. It is sent only in a request that offers tools; `"AUTO"` is the default.
- **`body` changes the bytes of every request**, so the first request after you set it or change it
  misses the prompt cache once.

## Waits: a model that thinks sends nothing

A chat request has two waits. `firstByteTimeoutMs` (600,000 ms, ten minutes) is the longest wait for
the first piece of the reply, and `idleTimeoutMs` (300,000 ms) the longest gap between two pieces
once it has started. A request that gets nothing for that long is aborted with a
`GeminiRequestError` ("Gemini sent nothing for 600 s.", `status` 0, `kind` `"timeout"`) and sent
again, once.

The first wait is long because of how Gemini answers:

- **Headers do not count.** A server may send them at once and then think.
- **A model that thinks sends nothing while it thinks** (unless you ask it for its thoughts). The
  first piece comes when it starts to write, which on a large request with a high thinking level
  can take minutes.
- **A reply that is not streamed arrives whole, at the end.** The explorer's requests are never
  streamed, and neither is any request made without `onText` or to an endpoint without a
  `streamUrl`. For those, this wait covers the whole reply.

Any bytes count as a piece, keep-alives included, and a reply that keeps arriving has no limit.
Set the waits on `gemini()` or `askGemini` (which gives both models the same); 0 waits without end:

```ts
import { askGemini, gemini } from "llm-large-files/gemini";

// files, endpoint, documentIds and messages as in the askGemini sample above.
await askGemini({ files, endpoint, documentIds, messages, firstByteTimeoutMs: 900_000, idleTimeoutMs: 120_000 });

// With askWithFiles, each adapter has its own.
const patient = gemini(endpoint, { firstByteTimeoutMs: 900_000 });
```

What this means for your server:

- **A question has no deadline of its own.** Each chat request may wait the whole
  `firstByteTimeoutMs`, twice. Give `signal` a deadline:
  `AbortSignal.any([clientGone, AbortSignal.timeout(15 * 60_000)])`. A request that already showed
  text is not sent again, and `retry: { retries: 0 }` turns the second try off.
- **Keep the waits below the request timeout of what stands in front of your server**, or raise
  that timeout: a load balancer, a proxy, Cloud Run. Keep the stream to the browser alive while the
  model is silent: [Web app](./web-app.md) and [Deployment](./deployment.md).
- **Part reads have a limit of their own**, `timeoutMs` (180 s a request): [below](#whole-file-reads-in-parts).

## Thinking

Thinking is set in `generationConfig.thinkingConfig`, which the adapter sends as it is: the library
does not check it. A model that does not take a setting refuses the request with HTTP 400, `kind`
`"invalid"`, and the error is thrown. Given a `thinkingLevel`, `gemini-2.5-flash-lite` on Vertex AI
answered "thinking_level is not supported by this model".

- `generationConfig` goes with every chat request of its model. With `askGemini`,
  `explorerGenerationConfig` is the explorer's, and defaults to `generationConfig`: set it when the
  two models do not take the same settings.
- The part reads of a whole-file read do not get `generationConfig`. They get `analysisConfig`, or
  `{ maxOutputTokens }` without it, with no temperature: Gemini 3.6 and later ignore it, and
  Google says later models will refuse it. Until 0.6.0 the default was
  `{ maxOutputTokens, temperature: 0.2 }`; to keep it for an older model, pass
  `analysisConfig: (maxOutputTokens) => ({ maxOutputTokens, temperature: 0.2 })`. With an explorer,
  the explorer reads the parts, so write `analysisConfig` for it.
- A model that thinks counts its thoughts in `maxOutputTokens`. Leave the limit out, or leave room
  for the thoughts in it.

**Part reads and `THINKING_OUTPUT_TOKENS`.** A part of a whole-file read is asked for 4,096 tokens
of notes, and the answer of the read for 8,192. A thinking model can spend that on thoughts: asked
for 4,096 tokens of notes on a part of a log, Gemini 3.8 Flash spent 3,931 of them thinking and
wrote two lines, and Gemini 4 wrote nothing (November 2026). When a reply stops at the limit with
nothing written, or with half the limit or more gone on thoughts, it is asked for once more with
`THINKING_OUTPUT_TOKENS` (32,768), and later requests to that URL start there, for the life of the
process. A model or a gateway that refuses 32,768 (HTTP 400) is not asked for it again, unless the
400 says the request was too large for the model's window with that limit, and the window is
larger than 32,768: a later part may still get it. `analysisConfig` receives the limit: put it in
`maxOutputTokens`, or the second request is the same as the first.

```ts
import { askGemini } from "llm-large-files/gemini";

// files, endpoint, documentIds and messages as in the askGemini sample above.
await askGemini({
  files, endpoint, documentIds, messages,
  generationConfig: { temperature: 0.3, thinkingConfig: { thinkingLevel: "high" } }, // the answering model
  explorerGenerationConfig: { thinkingConfig: { thinkingBudget: 0 } },              // a Gemini 2.5 explorer
  // The part reads go to the Gemini 2.5 explorer, which takes a temperature.
  analysisConfig: (maxOutputTokens) => ({ maxOutputTokens, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } }),
  toolFilePlacement: "beside", // one of the two is Gemini 2.5: see Pages of PDFs below
});
```

## The window and the budget

The library plans every question against a budget: what goes in whole, what is searched, how large
a tool result may be. By default it assumes a window of 1,000,000 tokens and requests of at most
10,000,000 bytes. Its token estimate is fitted to Gemini's own count, so a Gemini model needs no
`tokenScale`. Vertex AI names a window of 1,048,576 tokens in its errors for
`gemini-3.1-flash-lite` (November 2026), and the default fits such a model.

Tell the library when your model, or the connection to it, takes less. A window or request size
that `gemini()` declares only lowers the budget: the smaller of it and the library's
`budget.contextTokens` (or `budget.maxRequestBytes`) holds. For a model that takes more than
1,000,000 tokens, raise the library's budget: `createLargeFiles({ budget: { contextTokens: 2_000_000 } })`.

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { askGemini, gemini } from "llm-large-files/gemini";

// endpoint, documentIds and messages as in the askGemini sample above.

// askWithFiles: the adapter says what its model takes, and the budget of each question follows it down.
const small = gemini(endpoint, { contextTokens: 128_000, maxRequestBytes: 4_000_000 });

// askGemini cannot say it for its models: put it in the library's budget...
const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  budget: { contextTokens: 128_000, maxRequestBytes: 4_000_000 },
});
// ...or in the budget of one question.
await askGemini({ files, endpoint, documentIds, messages, budget: { contextTokens: 128_000 } });
```

With an explorer, the budget must fit both models: `askWithFiles` takes the smaller of what the two
adapters declare; with `askGemini`, set the smaller one yourself.

A window left too large is not fatal. The first request that Gemini refuses as too large teaches
the loop the window it names; it shortens older tool results and sends the request again, or plans
the documents again when no tool has run yet
([A request too large](#a-request-too-large)). That costs a refused request and a step the user
sees: declare the window instead. How the budget is worked out, and what each field does:
[Costs and limits](./costs-and-limits.md).

## An explorer model

An explorer is a second, cheaper or faster model that makes the tool calls (search, read, look at
pages) and reads whole files in parts, while the model you named only writes the answer from what
the tools returned. With `askGemini`, name it in the endpoint: `explorerModel` in `vertexAi()` or
`geminiApi()` (left out, empty, or the same as `model`, one model does both), or `explorerUrl` in an
endpoint of your own. It is called with the endpoint's headers (with `vertexAi()`, in the same
project and location), never streamed, with `explorerGenerationConfig`, and it reads the parts, so
`analysisConfig` is for it. If either model is Gemini 2.5, use `toolFilePlacement: "beside"`. To
give the two models other headers or their own limits, or to pair Gemini with another provider,
use `askWithFiles` with two adapters. Who does what, what changes in the result, and the cost:
[An explorer model](./explorer-model.md).

```ts
import { askWithFiles } from "llm-large-files";
import { askGemini, gemini, vertexAi } from "llm-large-files/gemini";

// files, documentIds and messages as in the askGemini sample above; accessToken as in Access
// tokens for Vertex AI.
const project = process.env.GOOGLE_CLOUD_PROJECT!;

// askGemini: one endpoint names both models.
await askGemini({
  files, documentIds, messages,
  endpoint: vertexAi({ project, accessToken, model: "gemini-3.8-flash", explorerModel: "gemini-3.5-flash-lite" }),
});

// askWithFiles: two adapters, each with its own endpoint and settings.
await askWithFiles({
  files, documentIds, messages,
  model: gemini(vertexAi({ project, accessToken, model: "gemini-3.8-flash" })),
  explorer: gemini(vertexAi({ project, accessToken, model: "gemini-3.5-flash-lite", location: "europe-west4" })),
});
```

## Whole-file reads in parts

`analyze_whole_document` reads a file in parts, four at a time, and writes one answer from the
notes. `gemini()` reads the parts with `createGeminiGenerateText`: on the endpoint's `url` (not
streamed), with its headers (asked for before each request, and once more with `{ refresh: true }`
after a 401 on a `vertexAi()` endpoint with a token function), the adapter's `fetch`,
`analysisConfig` and `analysisBody`. The parts follow the question's `retry`, as chat requests do.
A part whose reply of HTTP 200 holds an error (a gateway, or Vertex AI) throws that error with its
status since 0.10.0, so a 503 is tried again; before, it was "The model returned no text".

Each part read may take `timeoutMs`: 180,000 ms by default, its whole reply included. That is a
limit of its own, not the waits above. A part past it is a `GeminiRequestError` of kind
`"timeout"` and status 0: it is tried once more at once, and is then reported in the answer of the
read as "The model took too long to answer". Set `timeoutMs` on `gemini()` or `askGemini` (both
models get it); 0 sets none. New in 0.10.0: before, the limit could be changed only by replacing
the adapter's part reader, and a part past it came as the abort error of the timer.

```ts
import { askGemini } from "llm-large-files/gemini";

// files, endpoint, documentIds and messages as in the askGemini sample above.
await askGemini({ files, endpoint, documentIds, messages, timeoutMs: 300_000 }); // five minutes a part
```

A part that Gemini refuses as larger than it takes is read as two halves, while `maxMapChunks` and
the requests the question has left allow it. A part that cannot be read is reported to the model
by the kind and status of its error ("The model was busy (HTTP 429).", "The model's quota has run
out (HTTP 429)."), never by Google's message, which can name your project. How the parts are cut
and merged: [How it works](../how-it-works.md).

## Pages of PDFs

When the library keeps the uploaded PDFs (`keepOriginals: ["pdf"]`), the model gets `view_pages`,
which hands it up to five pages at a time as one PDF. The Gemini adapter needs no setup for it. Two
settings matter:

- **`toolFilePlacement`.** `"inside"` (the default) puts the PDF in the `parts` of its function
  response, which names it as `{ "$ref": "pages-12-14.pdf" }`. Gemini 3 models read it there.
  Gemini 2.5 accepts that form, bills it, and does not see the pages: use `"beside"`, which sends the
  PDFs in a user turn of their own after the function responses. `askGemini` gives both models one
  value, so use `"beside"` when either is Gemini 2.5.
- **`pageTokens`.** What Gemini bills for one page: 530 by default (`GEMINI_PAGE_TOKENS`; 520 to 532
  were measured). A question may look at `reservedTokens / 2 / pageTokens` pages, 60 with the default
  budget. It is an option of `gemini()`; `askGemini` uses 530.

```ts
import { askGemini } from "llm-large-files/gemini";

// files, endpoint, documentIds and messages as in the askGemini sample above.
await askGemini({ files, endpoint, documentIds, messages, toolFilePlacement: "beside" }); // for Gemini 2.5
```

The optional dependency, the limits, scanned PDFs and the live results: [PDFs](./pdfs.md).

## An enterprise gateway

A gateway that proxies Generate Content takes an endpoint of your own: `{ url, streamUrl?, headers,
explorerUrl? }`. It must accept Gemini's request body and answer with Gemini's JSON, and its
`streamUrl` with server-sent events, as `:streamGenerateContent?alt=sse` does.

```ts
import type { GeminiEndpoint } from "llm-large-files/gemini";

const gateway = "https://llm-gateway.corp.example/gemini/models";

// Your gateway's token: called before every request, so keep it cached and renew it before it expires.
async function gatewayToken(): Promise<string> {
  return process.env.GATEWAY_TOKEN!;
}

const endpoint: GeminiEndpoint = {
  url: `${gateway}/gemini-3.8-flash:generateContent`,
  streamUrl: `${gateway}/gemini-3.8-flash:streamGenerateContent?alt=sse`, // optional
  explorerUrl: `${gateway}/gemini-3.5-flash-lite:generateContent`,       // optional, askGemini only
  headers: async () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${await gatewayToken()}`,
  }),
};
```

- **`headers` are sent exactly as given.** The adapter adds no `Content-Type`: include
  `"Content-Type": "application/json"` yourself.
- **`headers` as a function** is called before every request, part reads included. A plain object
  is sent as it is.
- **Without `streamUrl`** each reply arrives whole: nothing streams to the user.
- **`explorerUrl`** is the explorer's `...:generateContent` URL, on any host. `askGemini` calls it
  with the same headers. `gemini()` ignores it: an explorer is an adapter of its own.
- **The name in `usage.byModel`** is read from `/models/{name}` in the URL, or is the host when the
  URL has none. With `askWithFiles`, name it with `gemini(endpoint, { id })`.
- **A body limit** of the gateway goes in `maxRequestBytes` ([above](#the-window-and-the-budget)).

A private endpoint of your network that keeps Vertex AI's paths needs no endpoint of your own
since 0.10.0: give its origin as `vertexAi({ host })` ([above](#vertex-ai)), and the token keeps its
second try after a 401. An endpoint of your own gets that try too when its `headers` function
takes `{ refresh }` and it says `refreshable: true`:

```ts
import type { GeminiEndpoint } from "llm-large-files/gemini";

// accessToken as in Access tokens for Vertex AI.
const host = process.env.VERTEX_HOST!; // where your network reaches Vertex AI
const path = `/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/europe-west4/publishers/google/models/gemini-3.8-flash`;
const privateEndpoint: GeminiEndpoint = {
  url: `${host}${path}:generateContent`,
  streamUrl: `${host}${path}:streamGenerateContent?alt=sse`,
  headers: async (context) => ({ "Content-Type": "application/json", Authorization: `Bearer ${await accessToken({ refresh: context?.refresh === true })}` }),
  refreshable: true,
};
```

## Quotas, retries and errors on Vertex AI

A request that Gemini refused, or that got no whole answer, throws a `GeminiRequestError`: a
`ModelRequestError` with `status` (0 when no answer came), `kind`, and `retryAfterMs` when the error
names a wait. The loop sends a request again when another try can help, and throws the error when
it cannot. What each kind means for the user:
[Errors and reliability](./errors-and-reliability.md).

Two failures are not a `GeminiRequestError`, and have no `kind`:

- an error thrown by your `accessToken` or `headers` function;
- the abort of your own `signal`, thrown as it came.

A reply of HTTP 200 whose body is not JSON, such as a gateway's HTML page, is a
`GeminiRequestError` of kind `"invalid"`, status 200, with the `SyntaxError` as `cause`: "Gemini's
reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its
place." It is not sent again, streamed or not; until 0.6.0 it was the `SyntaxError` itself, and a
streamed request that got such a page came back as an empty reply. An empty body
of HTTP 200 is "Gemini could not be reached (the reply was empty).", status 0, and is sent again.
A reply asked for as a stream that comes under another content type than `text/event-stream` is
read by what it starts with: events, or one chunk or a list of chunks in JSON, as Gemini sends them
without `alt=sse`.

### Quotas

| What Gemini or Vertex AI answers | `kind` | What the library does |
|---|---|---|
| HTTP 429 whose `details` hold a `google.rpc.QuotaFailure` with a quota per day (`PerDay` in its `quotaId` or `quotaMetric`) | `"quota"` | Throws at once: a wait does not mend it. |
| HTTP 429 whose message alone names a quota per day ("Quota exceeded for … requests_per_day_per_project …") | `"quota"` | The same. |
| Any other HTTP 429, a quota per minute among them | `"rate_limit"` | Sends it again, up to `retry.retries` times (3): after the wait the error names, or after a wait that doubles. |

The wait an error names is its `Retry-After` or `retry-after-ms` header, or the `retryDelay` of a
`google.rpc.RetryInfo` in its body. One longer than `retry.maxDelayMs` (60 s) is not waited for: the
error is thrown. Without a named wait, the defaults wait 0.25 to 0.5 s, then 0.5 to 1 s, then 1 to
2 s: three and a half seconds at most, which a quota per minute can outlast. `onActivity` reports
each wait of a chat request ("The model did not answer (HTTP 429). Trying again in 2 s…"). The
waits of part reads are not told to `onActivity`; since 0.7.0, `onEvent` and `askStream` give every
wait, theirs included, as a `retry` event ([events](../reference/events.md#retry)).

A whole-file read is what reaches a quota per minute first: up to 30 part reads, four at a time,
each with the same rule. If your project hits its quota under load, wait longer:

```ts
import { askGemini } from "llm-large-files/gemini";

// files, endpoint, documentIds and messages as in the askGemini sample above.
await askGemini({
  files, endpoint, documentIds, messages,
  retry: { retries: 5, baseDelayMs: 2_000 }, // about 1-2, 2-4, 4-8, 8-16 and 16-32 s
});
```

When Vertex AI names a wait longer than 60 s (`Retry-After`, or `retryDelay` in its body), the
error is thrown at once. If your users can wait that long, raise `retry.maxDelayMs`, for example
`retry: { retries: 5, baseDelayMs: 2_000, maxDelayMs: 120_000 }`.

Longer waits also delay the error the user sees when the model is down. Raising the quota, or
moving the searching to an [explorer](#an-explorer-model) on another model, removes the cause.

### A request too large

Vertex AI refuses a request larger than the model's window with HTTP 400 and its own words: "The
input token count exceeds the maximum number of tokens allowed 1048576." The Gemini API puts the
numbers in parentheses, and another Vertex AI wording reads "the input token count is N but model
only supports up to M". Each is `kind` `"context_overflow"`, with `limitTokens` (1,048,576 here) and,
when the message gives it, `requestedTokens`.

The loop then makes the request smaller, or plans the documents again, before it throws:
[Errors and reliability](./errors-and-reliability.md#a-request-too-large-for-the-model). Vertex
AI's message gives no count, so a plan made again is for 1,048,576 divided by 1.25: 838,860 tokens.
That holds while the budget assumes a larger window, as its default of 1,000,000 does; a window
that comes to no less than the one the budget assumed becomes 7/10 of that one. A refused output
limit ("…has a maxOutputTokens value of 5000000 but the maximum supported value is…") is `"invalid"`,
not an overflow.

### Other errors

| What happened | `status` | `kind` | Sent again |
|---|---|---|---|
| The token was refused: expired, a missing role, the API not enabled | 401, 403 | `"auth"` | A 401 once, with a new token, when `accessToken` is a function (since 0.10.0); otherwise no |
| An API key of the Gemini API that is not valid (`API_KEY_INVALID`) | 400 | `"auth"` | No |
| A setting the model does not take, a model the location does not have, another refusal | 400, 404, and any other 4xx not in this table | `"invalid"` | No |
| The provider or a gateway timed out | 408 | `"timeout"` | Yes |
| A conflict | 409 | `"invalid"` | Yes |
| A gateway refused the body as too large | 413 | `"context_overflow"` | Made smaller, as in [A request too large](#a-request-too-large) |
| Gemini failed on its side | 5xx | `"server"` | Yes |
| An error inside a stream, or in a body of HTTP 200, without a numeric code | The status of its `google.rpc` name: `"UNAVAILABLE"` 503, `"RESOURCE_EXHAUSTED"` 429, `"DEADLINE_EXCEEDED"` 504, `"INVALID_ARGUMENT"` 400 …; 500 for a name it does not know. Before 0.10.0, 200. | By the status | Yes for 429 and 5xx, unless text was shown; a daily quota is `"quota"`, and is not |
| Nothing came for `firstByteTimeoutMs` or `idleTimeoutMs` | 0 | `"timeout"` | Once |
| A part read took longer than `timeoutMs` | 0 | `"timeout"` | Once (since 0.10.0) |
| The connection failed, or a stream ended before its `finishReason` | 0 | `"unreachable"` | Yes, unless text was shown |
| A reply of HTTP 200 whose body is empty | 0 | `"unreachable"` | Yes |
| A reply of HTTP 200 whose body is not JSON (a gateway's page) | 200 | `"invalid"` | No |
| An event of a stream longer than 64,000,000 characters | 200 | `"invalid"` | No |

The message of the error is Google's own text, and can name your project, model and quotas. Log
it; show the user a message of your own, chosen by `kind`, as the [sample below](#a-production-setup)
does.

## Gemini history stored as contents

`askGemini` takes `messages` as `askWithFiles` does (`ChatMessage[]`: plain turns, stored tool
rounds, turns with native parts; since 0.9.0), or your own Gemini `contents` (with images and inline
PDFs) in `contents`; given both, `contents` is used. The last turn must be
the user's. Document text and cards are added at the start of the first user turn, and your array
is not changed. `fromGeminiContents(contents)` turns `contents` into `messages` for `askWithFiles`,
and `geminiToolTurns(result.toolTurns)` gives the tool rounds of a question as `contents`, to store
between the question and its answer:

```ts
import { askGemini, geminiToolTurns, type GeminiContent } from "llm-large-files/gemini";

// files, endpoint and documentIds as in the askGemini sample above.
// The conversation as your application keeps it, with the new question as its last user turn.
const history: GeminiContent[] = [{ role: "user", parts: [{ text: "Why did the import fail at 02:00?" }] }];

const result = await askGemini({ files, endpoint, documentIds, contents: history });
history.push(...geminiToolTurns(result.toolTurns), ...(result.answered ? [{ role: "model" as const, parts: [{ text: result.text }] }] : []));
```

Store no model turn for a question that was not answered
([Conversations](./conversations.md#storing-a-conversation-and-asking-the-next-question)).

Rounds kept this way are sent as they are. Since 0.9.0 they are also rounds the loop knows, as
`toolTurns` in `messages` are: `fromGeminiContents` turns the rounds `geminiToolTurns` wrote back
into stored rounds, so a repeated call is answered with a pointer to its earlier result, old results
can be shortened when room runs short, and the rounds are sized as they are. Before, they were
plain parts, sized as media, and a repeated search ran again. Function turns of your own stay as
they are. What to store and how to keep a conversation inside the window:
[Conversations](./conversations.md#gemini-contents).

## A production setup

Vertex AI with application default credentials, an explorer, the answer streamed, limits on the
question, and errors told apart by `kind`. `answer()` is called by your HTTP route, with a `send`
that writes events to the browser ([Web app](./web-app.md)).

```ts
import { GoogleAuth } from "google-auth-library";
import {
  createLargeFiles,
  DocumentsNotFoundError,
  errorKindOf,
  FileDocumentStore,
  partialResultOf,
  type AskResult,
  type ChatTurn,
  type ToolTurn,
} from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

// After a 401, { refresh: true }: the token in the cache was refused, and a new one is fetched.
async function accessToken({ refresh }: { refresh: boolean }): Promise<string> {
  const client = await auth.getClient();
  if (refresh) client.setCredentials({ ...client.credentials, expiry_date: 1 });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("No access token from the application default credentials.");
  return token;
}

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.DOCUMENTS_DIR ?? "./data/large-files"),
  // askGemini cannot declare a model's window: the budget does. The default (1,000,000 tokens,
  // 10 MB a request) fits a model of 1,048,576 tokens; set it for a smaller one.
});

const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: process.env.VERTEX_LOCATION ?? "global",
  model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",  // writes the answer
  explorerModel: process.env.GEMINI_EXPLORER_MODEL,        // searches and reads; unset: one model does both
  accessToken,                                             // called before every request
});

export type Send = (event: "text" | "activity" | "step" | "done" | "error", data: unknown) => void;

export async function answer(question: {
  userId: string;
  documentIds: string[];
  /** The conversation, with stored tool rounds, and the new question last. */
  messages: Array<ChatTurn | ToolTurn>;
  send: Send;
  /** Aborted when the browser goes away. */
  signal: AbortSignal;
}): Promise<AskResult | undefined> {
  // A question has no deadline of its own: keep this above firstByteTimeoutMs (10 minutes).
  const signal = AbortSignal.any([question.signal, AbortSignal.timeout(15 * 60_000)]);
  try {
    const result = await askGemini({
      files,
      endpoint,
      documentIds: question.documentIds,
      messages: question.messages,
      owner: question.userId,
      system: "You are our support assistant. Cite the lines you used.",
      generationConfig: { temperature: 0.3, thinkingConfig: { thinkingLevel: "high" } }, // the answering model
      explorerGenerationConfig: { temperature: 0.2 },                                     // the explorer
      body: { labels: { app: "support-assistant" } },                                     // billing labels: no user IDs
      limits: { toolTurns: 12, inputTokens: 2_000_000, requests: 40 },
      retry: { retries: 5, baseDelayMs: 2_000 },
      signal,
      onText: (delta) => question.send("text", delta),
      onActivity: (text) => question.send("activity", text),
      onStep: (text) => question.send("step", text),
    });
    question.send("done", { answered: result.answered });
    return result; // store result.toolTurns and result.usage with the conversation
  } catch (error) {
    // What the question found and paid for before it failed: store its toolTurns and usage too.
    const partial = partialResultOf(error);
    console.error("question failed", errorKindOf(error), error);
    if (!question.signal.aborted) {
      question.send("error", signal.aborted ? "The answer took too long. Please try again." : messageFor(error));
    }
    return partial;
  }
}

function messageFor(error: unknown): string {
  if (error instanceof DocumentsNotFoundError) return "A file has expired or was removed. Please attach it again.";
  switch (errorKindOf(error)) {
    case "rate_limit":
      return "The assistant is busy. Please try again in a minute.";
    case "quota":
      return "The assistant has reached its limit for today. Please try again tomorrow.";
    case "context_overflow":
      return "This conversation is too long for the model. Please start a new chat.";
    case "timeout":
    case "unreachable":
    case "server":
      return "The model did not answer. Please try again.";
    default: // "auth", "invalid", and errors without a kind: a setup problem, in your logs
      return "Something went wrong on our side. Please try again later.";
  }
}
```

- `result.answered` is `false` when the last turn had no text (a blocked prompt, a reply stopped by
  the output limit or a filter before it wrote anything, or an answer with no text, empty or a
  tool call such as `UNEXPECTED_TOOL_CALL`, even after it was asked for once more): show your own
  message then. A reply cut off after some text is `answered: true`, with `finishReason`
  `"MAX_TOKENS"`. With an explorer, `text` and `onText` carry only the answering model's words.
- Steps and activity lines are one line of plain text each, and still quote the model's words:
  show them as text in the browser, never as HTML or markdown.
- `limits.inputTokens` and `limits.requests` are ceilings on the whole question, part reads
  included: once one is reached no more tools run and the next request is the answer.
- `owner` scopes the documents to the user: a document of another owner is reported missing
  ([Security](../security.md)).
- For tests, pass `fetch` to `askGemini` or `gemini()`, or use a fake adapter:
  [Testing](./testing.md).
