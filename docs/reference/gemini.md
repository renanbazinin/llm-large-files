# `llm-large-files/gemini`

This page lists every export of `llm-large-files/gemini` with its options, defaults, return values
and errors. The entry point covers Gemini on the Gemini API and on Vertex AI: the endpoints,
`askGemini`, the `gemini()` adapter for `askWithFiles`, converters for Gemini `contents`, and the
helpers for a tool loop of your own. How to set Gemini up for production is in the guide
[Gemini API and Vertex AI](../guides/vertex-and-gemini.md).

```ts
import { askGemini, gemini, geminiApi, vertexAi } from "llm-large-files/gemini";
import type { AskGeminiOptions, GeminiContent, GeminiEndpoint, GeminiModelOptions, GeminiRequestFields } from "llm-large-files/gemini";
```

The entry point needs no Google SDK: it posts to the Generate Content REST API with `fetch`.

## Contents

- [Endpoints](#endpoints): [`geminiApi()`](#geminiapioptions), [`vertexAi()`](#vertexaioptions),
  [`VertexAiOptions`](#vertexaioptions-1), [`vertexHost()`](#vertexhostlocation),
  [`GeminiEndpoint`](#geminiendpoint)
- [Asking a question](#asking-a-question): [`askGemini()`](#askgeminioptions),
  [`AskGeminiOptions`](#askgeminioptions-1), [`GeminiOwnOptions`](#geminiownoptions),
  [`AskGeminiResult`](#askgeminiresult)
- [The model adapter](#the-model-adapter): [`gemini()`](#geminiendpoint-options),
  [`GeminiModelOptions`](#geminimodeloptions), [`GeminiRequestFields`](#geminirequestfields),
  [`GEMINI_PAGE_TOKENS`](#gemini_page_tokens)
- [Gemini contents](#gemini-contents): [`fromGeminiContents()`](#fromgeminicontentscontents-options),
  [`FromGeminiContentsOptions`](#fromgeminicontentsoptions),
  [`geminiToolTurns()`](#geminitoolturnsturns), [`GeminiContent`](#geminicontent),
  [`GeminiPart`](#geminipart)
- [Helpers for your own loop](#helpers-for-your-own-loop):
  [`createGeminiGenerateText()`](#creategeminigeneratetextoptions),
  [`THINKING_OUTPUT_TOKENS`](#thinking_output_tokens), [`createOutputLimits()`](#createoutputlimits),
  [`toGeminiTools()`](#togeminitoolsdeclarations),
  [`geminiFunctionResponses()`](#geminifunctionresponsescalls),
  [`geminiFunctionResponseTurns()`](#geminifunctionresponseturnscalls-options),
  [`GeminiFunctionCall`](#geminifunctioncall), [`GeminiToolAnswer`](#geminitoolanswer),
  [`GeminiToolFilePlacement`](#geminitoolfileplacement), [`usageOfGemini()`](#usageofgeminiusage)
- [Errors](#errors): [`GeminiRequestError`](#geminirequesterror)
- [Re-exports of the main entry](#re-exports-of-the-main-entry): `DocumentsNotFoundError`,
  `partialResultOf`, `EXPLORER_INSTRUCTION`, `FINAL_ANSWER_REQUEST`, `FINAL_ANSWER_AFTER_PAGES`,
  `FINAL_ANSWER_WITHOUT_TOOLS`, `parseSseJson`, `ChatTurn`, `AskEvent`

## Endpoints

A `GeminiEndpoint` says where a Gemini model is and how to sign in to it. `geminiApi()` and
`vertexAi()` build one. For an enterprise gateway, write one yourself.

### geminiApi(options)

```ts
declare function geminiApi(options: {
  apiKey: string;
  model: string;
  explorerModel?: string | undefined;
  apiVersion?: string;
  baseUrl?: string;
}): GeminiEndpoint;
```

The endpoint of a model on the Gemini Developer API, signed in with an API key.

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `string` | required | Sent in the `x-goog-api-key` header of every request, not in the URL. |
| `model` | `string` | required | The model that answers, such as `"gemini-3.8-flash"`. Without an explorer it also makes the tool calls. URL-encoded into the path. |
| `explorerModel` | `string \| undefined` | none | A second model that explores the documents: it makes the tool calls and reads whole files in parts, and `model` writes the answer. The name is trimmed. `undefined`, an empty string, only spaces, or the name of `model` mean no explorer, so an unset environment variable can be passed as it is. |
| `apiVersion` | `string` | `"v1beta"` | The version segment of the path. |
| `baseUrl` | `string` | `"https://generativelanguage.googleapis.com"` | The host, for a proxy that keeps the Gemini API's paths. Trailing slashes are removed. |

It returns:

| Field | Value |
|---|---|
| `url` | `{baseUrl}/{apiVersion}/models/{model}:generateContent` |
| `streamUrl` | `{baseUrl}/{apiVersion}/models/{model}:streamGenerateContent?alt=sse` |
| `headers` | The object `{ "Content-Type": "application/json", "x-goog-api-key": apiKey }` |
| `explorerUrl` | `{baseUrl}/{apiVersion}/models/{explorerModel}:generateContent`, only when an explorer is named. Otherwise the field is absent. |

It makes no request and throws nothing.

```ts
import { geminiApi } from "llm-large-files/gemini";

const endpoint = geminiApi({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.8-flash",
  explorerModel: process.env.GEMINI_EXPLORER_MODEL, // unset or empty: one model does both
});
// endpoint.url:       https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
// endpoint.streamUrl: https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse
```

Guides: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md),
[an explorer model](../guides/explorer-model.md).

### vertexAi(options)

```ts
declare function vertexAi(options: VertexAiOptions): GeminiEndpoint;
```

The endpoint of a Gemini model on Vertex AI, signed in with an OAuth access token, or, since
0.10.0, with an API key of Vertex AI express mode.

| Option | Type | Default | What it does |
|---|---|---|---|
| `project` | `string` | required with `accessToken` | The Google Cloud project ID. URL-encoded into the path. Not with `apiKey`. |
| `model` | `string` | required | The model that answers, under `publishers/google/models/`. Without an explorer it also makes the tool calls. |
| `explorerModel` | `string \| undefined` | none | A second model that explores the documents, with the same rules as in [`geminiApi()`](#geminiapioptions). It is in the same project and location. |
| `location` | `string` | `"global"` | Where the requests are served. It picks the host ([`vertexHost()`](#vertexhostlocation)) and is the `locations/{location}` segment of the path. It must be lowercase letters, digits and single hyphens (`"global"`, `"us"`, `"europe-west4"`): anything else throws a `TypeError`, since 0.7.1 (with `host`, it is not checked, only URL-encoded). Not with `apiKey`. |
| `accessToken` | `string \| ((context: { refresh: boolean }) => string \| Promise<string>)` | required without `apiKey` | Sent as `Authorization: Bearer {token}`. A function is called before every request, chat requests and part reads of both models alike, so it can return a renewed token. Since 0.10.0 it is called with `{ refresh: true }` when the token it gave was refused with HTTP 401: return a new token then, not the one kept in a cache. A function of no arguments still fits. |
| `apiKey` | `string` | none | The API key of Vertex AI express mode, sent as the `x-goog-api-key` header. The URL then names no project or location: `{host}/{apiVersion}/publishers/google/models/{model}:generateContent`. Give `apiKey` or `project` and `accessToken`, not both. New in 0.10.0. |
| `headers` | `Record<string, string>` or a function that returns them | none | More headers, merged after the library's: a name you give replaces the library's. A function is called before every request with the context the endpoint's `headers` get (`{ refresh: true }` after a 401). New in 0.10.0. |
| `host` | `string` | the host of `location` | The https origin to send the requests to: a Private Service Connect endpoint, or a proxy that keeps Vertex AI's paths. `"https://host"` or `"https://host:port"`, with a slash at the end or none, and nothing more: a path, a query, a fragment, an `@` or another scheme throws a `TypeError`, as a bad `location` does, since the token would go to another host. New in 0.10.0. |
| `apiVersion` | `string` | `"v1"` | The version segment of the path. |

It returns:

| Field | Value |
|---|---|
| `url` | `{host}/{apiVersion}/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`, where `host` is `vertexHost(location)` unless given; with `apiKey`, `{host}/{apiVersion}/publishers/google/models/{model}:generateContent` |
| `streamUrl` | The same, ending in `:streamGenerateContent?alt=sse` |
| `headers` | An async function that returns `{ "Content-Type": "application/json", Authorization: "Bearer {token}" }` (with `apiKey`, `"x-goog-api-key": apiKey` in place of `Authorization`), then the fields of `headers` |
| `explorerUrl` | The `:generateContent` URL of `explorerModel`, only when an explorer is named. Otherwise the field is absent. |
| `refreshable` | `true` when `accessToken` is a function, new in 0.10.0: a request refused with HTTP 401 is sent once more with a new token. Absent for a token given as a string, and for `apiKey`. |

It makes no request and does not call `accessToken`. Since 0.99.13 an error that the token
function throws fails the request that needed the token with a `GeminiRequestError` of status 0,
what the function threw as its `cause`
([key and token functions](./errors-and-retries.md#key-and-token-functions)):

- a connection that failed (a metadata server that reset, `ECONNRESET`, undici's "fetch failed"):
  kind `"unreachable"`, "Gemini could not be reached: its key or token could not be fetched
  (ECONNRESET).", sent again as any request that got no answer;
- anything else (a revoked grant, a bug in the function): kind `"auth"`, "Gemini was sent no key or
  token: the function that gives it failed.", never sent again. Events say "The model refused the
  key or token it was sent."

After a 401, the call with `{ refresh: true }` is told as a `retry` event with
`reason: "auth_refresh"`. When it throws on a connection that failed, the request is sent again
from the start; when it throws otherwise, the request's error is that 401 (kind `"auth"`), with
what the function threw as its `cause`, as before. Until 0.99.13 the function's error came out as
it was thrown, with no status: a chat request was not sent again after one blip of the token
server.

```ts
import { GoogleAuth } from "google-auth-library";
import { vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: "gemini-3.8-flash",
  explorerModel: "gemini-3.5-flash-lite",
  accessToken: async ({ refresh }) => {
    const client = await auth.getClient();
    // The cached token was refused: mark it expired, so that the client fetches a new one.
    if (refresh) client.setCredentials({ ...client.credentials, expiry_date: 1 });
    return (await client.getAccessToken()).token ?? "";
  },
});

// Express mode: an API key, and no project.
const express = vertexAi({ apiKey: process.env.VERTEX_API_KEY!, model: "gemini-3.8-flash" });
```

Guide: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md), which covers access tokens.

### `VertexAiOptions`

```ts
type VertexAiOptions =
  | {
      project: string;
      location?: string;
      accessToken: string | ((context: { refresh: boolean }) => string | Promise<string>);
      apiKey?: never;
      model: string;
      explorerModel?: string | undefined;
      headers?: HeaderSource | undefined;
      host?: string | undefined;
      apiVersion?: string;
    }
  | {
      apiKey: string;
      project?: never;
      location?: never;
      accessToken?: never;
      model: string;
      explorerModel?: string | undefined;
      headers?: HeaderSource | undefined;
      host?: string | undefined;
      apiVersion?: string;
    };
// HeaderSource = Record<string, string> | ((context?: { refresh?: boolean }) => Record<string, string> | Promise<Record<string, string>>)
// HeaderSource is exported from llm-large-files since 0.10.1.
```

The options of [`vertexAi()`](#vertexaioptions): a project with a token, or an API key of express
mode. The type refuses a project with an API key (the `never` fields), and a project without a
token. New as a type of its own in 0.10.0.

### vertexHost(location)

```ts
declare function vertexHost(location: string): string;
```

The Vertex AI host of a location, as `vertexAi()` uses it. Since 0.7.1 the location is checked: one
that is not lowercase letters and digits joined by single hyphens throws a `TypeError` ("location
must be a Vertex AI location such as "global", "us" or "europe-west4", and is …"). With `/`, `?`,
`#` or `@` in it, it would have named another host, and that host would have got the access token.

| `location` | Host |
|---|---|
| `"global"` | `https://aiplatform.googleapis.com` |
| `"us"`, `"eu"` | `https://aiplatform.us.rep.googleapis.com`, `https://aiplatform.eu.rep.googleapis.com` |
| Any other, such as `"europe-west4"` | `https://europe-west4-aiplatform.googleapis.com` |

Use it to build the URLs of a [`GeminiEndpoint`](#geminiendpoint) of your own on Vertex AI.

### `GeminiEndpoint`

```ts
type GeminiEndpoint = {
  url: string;
  streamUrl?: string;
  headers: Record<string, string> | ((context?: { refresh?: boolean }) => Record<string, string> | Promise<Record<string, string>>);
  explorerUrl?: string | undefined;
  refreshable?: true | undefined;
};
```

Where a Gemini model is and how to call it.

| Field | Type | Default | What it does |
|---|---|---|---|
| `url` | `string` | required | The non-streaming `...:generateContent` URL. Chat requests made without `onText`, and the part reads of a whole-file read when there is no explorer, go here. |
| `streamUrl` | `string` | none | The streaming `...:streamGenerateContent?alt=sse` URL, used for a chat request when `onText` is given. Without it each reply arrives whole, and `onText` gets its text once it has arrived. |
| `headers` | `Record<string, string>` or a function that returns them | required | Sent with every request as they are. A function is called before every request, so a renewed token is used. Since 0.10.0 it may take a context: it is called with `{ refresh: true }` when a request of a `refreshable` endpoint is sent again after a 401, and with nothing otherwise. Since 0.99.13 a function that throws fails the request with a `GeminiRequestError` of status 0: kind `"unreachable"`, sent again, for a connection that failed; kind `"auth"`, not sent again, for anything else ([key and token functions](./errors-and-retries.md#key-and-token-functions)). `gemini()` adds no header of its own: give `"Content-Type": "application/json"`, as `geminiApi()` and `vertexAi()` do. |
| `explorerUrl` | `string \| undefined` | none | The `...:generateContent` URL of an explorer model, called with the same `headers` and never streamed. Only `askGemini` reads it, and only when it differs from `url`. With `askGemini` it receives the explorer's chat requests and the part reads of whole-file reads. `gemini()` ignores it. |
| `refreshable` | `true \| undefined` | none | `headers({ refresh: true })` gives a token that is new, not the one it keeps in a cache: a request refused with HTTP 401 is sent once more with those headers, in chat requests, part reads and askGemini's explorer alike. A second 401 is the error: there is no third try. `vertexAi()` sets it when `accessToken` is a function. New in 0.10.0. Since 0.99.13 the refresh is told as a `retry` event with `reason: "auth_refresh"`, and a refresh that fails on a connection sends the request again from the start. |

An endpoint for a gateway that proxies Generate Content:

```ts
import type { GeminiEndpoint } from "llm-large-files/gemini";

const models = "https://llm-gateway.example.com/gemini/models";

const gateway: GeminiEndpoint = {
  url: `${models}/gemini-3.8-flash:generateContent`,
  streamUrl: `${models}/gemini-3.8-flash:streamGenerateContent?alt=sse`,
  headers: async () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.GATEWAY_TOKEN}`,
  }),
  explorerUrl: `${models}/gemini-3.5-flash-lite:generateContent`, // optional
};
```

Guide: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md), which has a section on gateways.

## Asking a question

### askGemini(options)

```ts
declare function askGemini(options: AskGeminiOptions): Promise<AskGeminiResult>;
```

[`askWithFiles`](./ask.md#askwithfilesoptions) with Gemini models built for you. It makes
`gemini(endpoint, …)` the model that answers. When `endpoint.explorerUrl` is set and differs from
`endpoint.url`, it makes a second `gemini()` on that URL the explorer, with the same headers and no
stream. Documents that fit go into the prompt whole. A document too large for that, or a PDF whose
pages can be looked at, is reached through tools. When the tool loop ends without an answer in text
(out of turns or of room, a reply with no text, or always with an explorer), a last request without
tools asks for it. When that reply has no text (it is empty, or ends with `UNEXPECTED_TOOL_CALL` or
`MALFORMED_FUNCTION_CALL`), it is asked for once more. `answered` is false when there is still no
text: a blocked prompt, which gets no last request, or an empty or cut-off reply.

Since 0.10.0 `askGemini` takes every option of `askWithFiles` by its type, and gives the ones it does
not use itself to `askWithFiles` as they are: an option new in `askWithFiles` reaches the loop with no
change to `askGemini`.

`askGemini` cannot set `contextTokens`, `maxRequestBytes`, `pageTokens` or `id` on its models. Put
the model's window in the library's budget, or use `askWithFiles` with
[`gemini()`](#geminiendpoint-options), which also takes an explorer of another provider or on
another endpoint.

**Returns** an [`AskGeminiResult`](#askgeminiresult).

**Throws** what `askWithFiles` throws ([ask reference](./ask.md)). Among them:

- `DocumentsNotFoundError`, before any model request, when a document ID was never uploaded, has
  expired, or belongs to another `owner` or `scope`.
- `Error("The last message must be the user's.")`, when the last turn of `messages` or `contents`
  is not the user's, or when both are left out.
- `DocumentStoreError`, when the store could not be read.
- [`GeminiRequestError`](#geminirequesterror), for a chat request that Gemini did not answer, after
  the retries. An explorer that fails throws it too. `partialResultOf(error)` gives what the
  question found until then. A part read of a whole-file read that fails is not thrown: the tool
  reports it to the model.
- For an `accessToken` function that throws, a `GeminiRequestError` of status 0 since 0.99.13
  ([`vertexAi()`](#vertexaioptions)); before, its error as it was thrown.
- The reason of `signal`, when it aborts.

```ts
import { askGemini } from "llm-large-files/gemini";

// files (from createLargeFiles), endpoint (from vertexAi() above), userId and documentId
// come from your application.
const result = await askGemini({
  files,
  endpoint,
  owner: userId,
  documentIds: [documentId],
  messages: [{ role: "user", text: "Why did the nightly import fail?" }],
  onText: (delta) => process.stdout.write(delta),
});
if (!result.answered) console.log("No answer this time.");
console.log(result.usage.byModel); // one entry for each model, keyed by the model name in its URL
```

Guide: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md).

### `AskGeminiOptions`

```ts
type AskGeminiOptions = Omit<AskOptions, "model" | "explorer" | "messages"> & GeminiOwnOptions;
```

The options of `askGemini`. `AskOptions.model` and `AskOptions.explorer` are not here: `endpoint`
takes their place.

Every other option of [`AskOptions`](./ask.md#askoptions) is one of `askGemini`, with the same
meaning and default, and goes to `askWithFiles` as it is. Since 0.10.0 the type says so itself
(before, `askGemini` listed each option by hand); no option was removed. Among them: `files`,
`documentIds`, `documentPlacement`, `system`, `owner`, `scope`, `onMissingDocuments`, `limits`,
`retry`, `budget`, `wholeDocumentAnalysis`, `viewPages`, `onText`, `streamText`, `onActivity`,
`onStep`, `onEvent`, `runId`, `eventResults`, `signal`, and those new in 0.10.0. With Gemini:

- `messages` is optional and typed [`ChatMessage[]`](./ask.md#chatmessage), as in `askWithFiles`:
  plain turns, the `toolTurns` of earlier questions, and turns with parts, such as
  `fromGeminiContents(contents, { rounds: false })` gives. Before 0.9.0 it was typed
  `Array<ChatTurn | ToolTurn>`. Turns with native parts (images, inline PDFs, thought signatures)
  usually go in `contents`. Give `messages` or `contents`: with neither, the question throws "The
  last message must be the user's."
- `onText` streams only when the endpoint has a `streamUrl`. Without one, it gets the text of each
  reply once the reply has arrived. The same holds for `streamText` (on by default with `onText`):
  it asks for the answer as it is written only from an endpoint with a `streamUrl`.
- `limits` is merged with `maxToolTurns` and `maxToolCallsPerTurn` (below). A field of `limits`
  wins.

Fields `askGemini` adds, its own (`GeminiOwnOptions`):

| Field | Type | Default | What it does |
|---|---|---|---|
| `endpoint` | [`GeminiEndpoint`](#geminiendpoint) | required | The model that answers, and the explorer when `explorerUrl` is set and differs from `url`. |
| `contents` | [`GeminiContent[]`](#geminicontent) | none | The conversation as Gemini `contents`, with images, inline PDFs or function calls. Converted with [`fromGeminiContents()`](#fromgeminicontentscontents-options), whose tool rounds come back as stored rounds (new in 0.9.0). For the conversion of 0.8, pass `messages: fromGeminiContents(contents, { rounds: false })` instead. It wins over `messages` when both are given. The array is not changed. The last turn must be the user's. |
| `generationConfig` | `Record<string, unknown>` | none | Sent as `generationConfig` with every chat request of the answering model, and of the explorer unless `explorerGenerationConfig` is set: `temperature`, `maxOutputTokens`, `thinkingConfig` and so on. Not used for part reads. |
| `explorerGenerationConfig` | `Record<string, unknown>` | `generationConfig` | The same, for the explorer's chat requests, when the two models do not take the same settings. Not used without an explorer. |
| `toolFilePlacement` | [`GeminiToolFilePlacement`](#geminitoolfileplacement) | `"inside"` | Where the pages of `view_pages` go, for both models. `"beside"` for Gemini 2.5. |
| `documents` | [`DocumentsCapability`](./ask.md#toolfiletype-documentscapability-and-nativedocumentformat) | none | The files the model reads natively, for the model and its explorer: a small visual file sent whole goes as `inlineData` before its text ([The file itself](../guides/pdfs.md#the-file-itself-for-small-visual-files)). `"pdf"` anywhere; `"pptx"` on the Gemini API only. See [`GeminiModelOptions`](#geminimodeloptions). New in 0.99.9. |
| `analysisConfig` | `(maxOutputTokens: number) => Record<string, unknown>` | `{ maxOutputTokens }` | The `generationConfig` of the part reads of a whole-file read, for both models. The explorer reads the parts when there is one, so write it for that model. Put the limit it is given in `maxOutputTokens`: a second try raises it to [`THINKING_OUTPUT_TOKENS`](#thinking_output_tokens). The default sends no temperature since 0.6.0 (it was `temperature: 0.2`): Gemini 3.6 and later ignore it, and Google says later models will refuse it. For an older model that should keep it: `(maxOutputTokens) => ({ maxOutputTokens, temperature: 0.2 })`. |
| `firstByteTimeoutMs` | `number` | `600_000` | The longest wait for the first piece of a chat reply, for both models. See [`GeminiModelOptions`](#geminimodeloptions). 0 waits without end. |
| `idleTimeoutMs` | `number` | `300_000` | The longest wait between two pieces of a chat reply, for both models. 0 waits without end. |
| `maxToolTurns` | `number` | 12 | `limits.toolTurns`, under the name it had before 0.5.0. `limits.toolTurns` wins when both are set. |
| `maxToolCallsPerTurn` | `number` | 8 | `limits.callsPerTurn`, under the name it had before 0.5.0. `limits.callsPerTurn` wins when both are set. |
| `fetch` | `typeof fetch` | the global `fetch` | Used for every request of both models, part reads included: a proxy, logging, tests. |
| `body` | [`GeminiRequestFields`](#geminirequestfields) | none | More fields for the body of every chat request of the answering model, and of the explorer unless `explorerBody` is set: `safetySettings`, `labels`, `serviceTier`, `cachedContent`. Merged last. Not used for part reads. New in 0.10.0. |
| `explorerBody` | [`GeminiRequestFields`](#geminirequestfields) | `body` | The same, for the explorer's chat requests. Not used without an explorer. New in 0.10.0. |
| `analysisBody` | `(maxOutputTokens: number) => GeminiRequestFields` | none | More fields for the body of each part read of a whole-file read, for both models. New in 0.10.0. |
| `functionCallingMode` | `"AUTO" \| "VALIDATED"` | `"AUTO"` | The `functionCallingConfig` mode of the requests that offer tools, for both models. New in 0.10.0. |
| `answerWithoutTools` | `"omit" \| "mode_none"` | `"omit"` | How the request for the answer in text says so, for both models ([`GeminiModelOptions`](#geminimodeloptions)). New in 0.10.0. |
| `timeoutMs` | `number` | `180_000` | The longest time of one part read of a whole-file read, for both models. 0 sets none. New in 0.10.0. |
| `outputLimits` | [`OutputLimits`](#createoutputlimits) | the memory every adapter shares | Where the part reads of both models keep the output limit they learned a model needs. Give a test its own ([`createOutputLimits()`](#createoutputlimits)). New in 0.99.15. |

### `GeminiOwnOptions`

The options of `askGemini` that are not `askWithFiles`'s: `endpoint`, `messages` (optional here),
`contents`, `generationConfig`, `explorerGenerationConfig`, `body`, `explorerBody`, `analysisBody`,
`functionCallingMode`, `answerWithoutTools`, `timeoutMs`, `maxToolTurns`, `maxToolCallsPerTurn`,
`toolFilePlacement`, `documents` (new in 0.99.9), `analysisConfig`, `firstByteTimeoutMs`,
`idleTimeoutMs` and `fetch`, as described above. New as a type of its own in 0.10.0.

`askGemini` has no stream form of its own. To read its events with `for await`, as
[`askStream`](./ask.md#askstreamoptions) gives them for `askWithFiles`, wrap it in
[`eventStream`](./events.md#eventstreamrun-options) from `llm-large-files`: it passes the listener
and a signal, and leaving the loop early stops the question.

```ts
import { eventStream } from "llm-large-files";
import { askGemini, type AskEvent, type AskGeminiOptions, type AskGeminiResult } from "llm-large-files/gemini";

// options are those of askGemini, with your endpoint, files and messages.
export async function showGeminiQuestion(options: AskGeminiOptions): Promise<AskGeminiResult | undefined> {
  const stream = eventStream<AskEvent, AskGeminiResult>(
    (onEvent, signal) => askGemini({ ...options, onEvent, signal, streamText: options.streamText !== false }),
    { signal: options.signal },
  );
  for await (const event of stream) {
    if (event.type === "request.start") console.error(`${event.role} request ${event.requestId} to ${event.model}`);
    if (event.type === "tool.end") console.error(event.step ?? `${event.callId}: ${event.outcome}`);
    if (event.type === "text") process.stdout.write(event.delta);
    if (event.type === "run.error") console.error(event.error.message);
  }
  return stream.result.catch(() => undefined);
}
```

With an explorer, `run.start` names both models (`models.explorer`), and the explorer's requests
have `role: "explorer"`.

Guide: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md).

### `AskGeminiResult`

```ts
type AskGeminiResult = AskResult;
```

What `askGemini` returns: an [`AskResult`](./ask.md#askresult). With Gemini:

- `usage` is the total of the whole question, part reads included. `usage.byModel` has an entry
  for each model, keyed by the model name in its URL (`"gemini-3.8-flash"`).
- `lastUsage` is Gemini's own `usageMetadata`, as it came, and `finishReason` Gemini's own
  `finishReason`, such as `"STOP"` or `"MAX_TOKENS"`. Each is that of the last chat response that
  gave one, of either model: the answer's, unless the prompt was blocked before it.
- With an explorer, `text` holds only what the answering model wrote, and `turns` counts the chat
  requests of both models.

Guide: [errors and reliability](../guides/errors-and-reliability.md).

## The model adapter

### gemini(endpoint, options?)

```ts
declare function gemini(
  endpoint: Pick<GeminiEndpoint, "url" | "streamUrl" | "headers" | "refreshable">,
  options?: GeminiModelOptions,
): ModelAdapter;
```

A Gemini model for [`askWithFiles`](./ask.md#askwithfilesoptions), as a
[`ModelAdapter`](./ask.md#modeladapter). Use it instead of `askGemini` to set the model's window,
the cost of a page or the name in usage totals, to pair Gemini with a model of another provider,
or to give each model its own settings. `endpoint.explorerUrl` is ignored: an explorer is an
adapter of its own, passed as `explorer`.

The adapter it returns:

| Member | Value |
|---|---|
| `id` | `options.id`. Without it, the model name in the URL (`/models/{name}`, decoded); for a URL without one, its host; else `"gemini"`. |
| `capabilities` | `toolFiles` from `toolFilePlacement` (`"inside"`), `pageTokens` (530), and `contextTokens` and `maxRequestBytes` when they are set; `documents`, with its defaults filled in, when you pass it (0.99.9). No `toolFileTypes` (so PDF only), no `tokenScale` (so 1), no `outputTokens`, not `appendOnly`. |
| `send(request, hooks?)` | One chat request: to `streamUrl` when `hooks.onText` is given and the endpoint has one, otherwise to `url`. |
| `requestBytes(request)` | The size in bytes of the JSON body that `send` would post. |
| `generateText` | The part reader of whole-file reads: [`createGeminiGenerateText()`](#creategeminigeneratetextoptions) on `endpoint.url`, with `analysisConfig`, `analysisBody`, `timeoutMs`, `fetch` and the endpoint's `refreshable`. `askWithFiles` uses it when this model is the one that explores. Each of its requests may take `timeoutMs` (180 s); before 0.10.0, `gemini()` had no option to change that. |

What `send` does:

- It asks for the headers before every request.
- A turn with files (`ModelTextMessage.files`, 0.99.9) has them first, each as
  `{ inlineData: { mimeType, data } }` of its own type, then its parts; a turn with files and no
  text is kept. Gemini says which types it reads: on Vertex AI, send PDF only.
- A tool file that is an image (a page drawn as an image) goes as `inlineData` of its type, as a
  PDF does.
- The body holds `contents`; `systemInstruction` when the system instruction is not empty;
  `generationConfig` when it is set; when tools are offered, `tools: [{ functionDeclarations }]`
  with `toolConfig: { functionCallingConfig: { mode } }`, the mode being `functionCallingMode`
  (`"AUTO"`); and last, the fields of `body`. A request that must be answered in text declares no
  tools at all by default, because Gemini can ignore mode `NONE` and go on calling them; with
  `answerWithoutTools: "mode_none"` it keeps them, with mode `NONE`.
- A request refused with HTTP 401 by a `refreshable` endpoint is sent once more, with the headers of
  `headers({ refresh: true })`. A second 401 is the error. New in 0.10.0. Since 0.99.13 it calls
  `hooks.onRefresh` first ([`SendHooks`](./ask.md#sendhooks)), which the loop tells as a `retry`
  event with `reason: "auth_refresh"`.
- A model turn of the question goes back unchanged, thought signatures included, in the later
  requests to the same adapter. Another model of the question gets it rebuilt from its calls, as a
  stored tool round (`toolTurns`) is.
- A reply to `streamUrl` is read as a stream when its content type is `text/event-stream`, or when
  it starts like events (`data:`, `event:`, `id:`, `retry:` or a comment). Otherwise it is read in
  one piece, as one chunk or a list of chunks, as Gemini answers without `?alt=sse`: a gateway that
  drops `?alt=sse`, or does not stream, is read whole (since 0.6.0; 0.5.0 read it as an empty
  reply). A body that starts with more than 65,536 characters of white space is read in one piece.
- Parts marked `"thought": true` are not in the reply's `text` and are not passed to `onText`.
- Gemini's `finishReason` becomes the reply's `finish`, and stays as it came in `finishReason`:

  | `finishReason` | `finish` |
  |---|---|
  | `STOP` | `"complete"` |
  | `MAX_TOKENS` | `"cut"` |
  | `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`; since 0.10.0 `MODEL_ARMOR`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, `IMAGE_OTHER` | `"filtered"` |
  | `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`; since 0.10.0 `MALFORMED_RESPONSE` | `"malformed_call"` |
  | Since 0.10.0: `OTHER`, `FINISH_REASON_UNSPECIFIED`, `NO_IMAGE`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE`, `LANGUAGE` | `"other"` |
  | Any other | none |

  `LANGUAGE` (a language the model does not take) is `"other"`, not `"filtered"`: it is no safety
  filter. Before 0.10.0 the reasons new to the table gave no `finish`.
  `promptFeedback.blockReason` becomes `blockReason`, `usageMetadata` becomes `usage`
  ([`usageOfGemini()`](#usageofgeminiusage)) and `providerUsage`, and, since 0.10.0, `responseId`
  and `modelVersion` become `responseId` and `responseModel`.

`send` throws, and sends nothing again itself: `askWithFiles` decides what is retried.

| Case | Error | `status` | `kind` |
|---|---|---|---|
| Gemini answered with an HTTP error | `GeminiRequestError` with Gemini's `error.message`, or "Gemini returned HTTP 503." | The HTTP status | Told from the status, Gemini's `error.status` and `details` |
| An error object inside the stream, or in a reply of HTTP 200 that is not streamed | `GeminiRequestError` with its message, or "Gemini reported an error." | Its `code` when that is a whole number from 400 to 599; else, since 0.10.0, the status of its `google.rpc` name (`"UNAVAILABLE"` 503, `"RESOURCE_EXHAUSTED"` 429, `"DEADLINE_EXCEEDED"` 504, `"INVALID_ARGUMENT"` 400 …); else 500. Before 0.10.0, the response's 200, so it was not sent again. | As above |
| The connection failed, before or while the reply arrived, or an event of the stream was not JSON | `GeminiRequestError`: "Gemini could not be reached (fetch failed)." | 0 | `"unreachable"` |
| Node's own headers or body time limit ran out (undici's `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, 300 s by default) | `GeminiRequestError`: "Gemini took too long to answer (fetch failed).", sent again once. New in 0.99.13: it was `"unreachable"`, sent again 3 times ([Node's own time limits](./errors-and-retries.md#nodes-own-time-limits)) | 0 | `"timeout"` |
| The `headers` function threw | `GeminiRequestError`: "Gemini could not be reached: its key or token could not be fetched (ECONNRESET)." for a connection that failed; "Gemini was sent no key or token: the function that gives it failed." otherwise. New in 0.99.13 | 0 | `"unreachable"` (or `"timeout"`); `"auth"`, not sent again |
| A reply of HTTP 200 whose body is empty | `GeminiRequestError`: "Gemini could not be reached (the reply was empty).", new in 0.6.0. When the reply's type is `text/event-stream`, "Gemini's reply ended before it was complete." Either is sent again as a reply cut off on its way. | 0 | `"unreachable"` |
| Nothing arrived for a whole wait | `GeminiRequestError`: "Gemini sent nothing for 600 s." | 0 | `"timeout"` |
| A stream that closed with no `finishReason` and no `blockReason` | `GeminiRequestError`: "Gemini's reply ended before it was complete." | 0 | `"unreachable"` |
| A streamed response without a body | `GeminiRequestError`: "Gemini returned an empty stream." | The response's, a 2xx | `"invalid"` (the status is a 2xx); not sent again |
| A reply whose body is not JSON (a gateway's HTML page), streamed or not | `GeminiRequestError`: "Gemini's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.", the brackets holding the response's media type (left out when it has none), with the `SyntaxError` as `cause`. Not sent again. Until 0.6.0, the `SyntaxError` itself, and for a streamed request an empty reply. | The response's, 200 | `"invalid"` |
| An event of the stream longer than 64,000,000 characters | `GeminiRequestError`: "Gemini's reply could not be read: an event of its stream held more than 64,000,000 characters." Not sent again. New in 0.6.0. | The response's, 200 | `"invalid"` |
| `hooks.signal` aborted | The signal's reason, as it is | none | none |

For an HTTP error, `retryAfterMs` is the wait Gemini asked for: the `retry-after-ms` or
`Retry-After` header, or the `retryDelay` of a `google.rpc.RetryInfo` in the error's `details`. An
error inside a stream, or in the body of a response that was OK, has the `retryDelay` of its
`details` when it has one (since 0.10.0). An error body that is a list (`[{ "error": … }]`) is read
by its first entry, its message and `details` included (since 0.10.0).

```ts
import { askWithFiles } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";

// files, documentIds, messages and userId (their owner) come from your application.
const apiKey = process.env.GEMINI_API_KEY!;

const model = gemini(geminiApi({ apiKey, model: "gemini-3.8-flash" }), {
  contextTokens: 1_048_576,             // the model's window: it can only lower the budget, and the library's 1,000,000 is smaller here
  generationConfig: { temperature: 0.3 },
});
const explorer = gemini(geminiApi({ apiKey, model: "gemini-3.5-flash-lite" }), { id: "explorer" });

const result = await askWithFiles({ files, model, explorer, documentIds, messages, owner: userId });
console.log(result.usage.byModel); // keyed "gemini-3.8-flash" and, when the explorer ran, "explorer"
```

Guides: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md),
[an explorer model](../guides/explorer-model.md).

### `GeminiModelOptions`

The options of `gemini()`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `generationConfig` | `Record<string, unknown> \| undefined` | none: the field is left out of the body | Sent as `generationConfig` with every chat request: `temperature`, `maxOutputTokens`, `thinkingConfig` and so on. It is sent as it is, not checked. Not used for part reads. |
| `toolFilePlacement` | [`GeminiToolFilePlacement`](#geminitoolfileplacement) `\| undefined` | `"inside"` | Where the pages of `view_pages` go. `"inside"` puts the PDF in the function response itself, which Gemini 3 models read. `"beside"` sends it in a user turn of its own after the function responses: use it for Gemini 2.5, which does not see a file inside a function response. It is also `capabilities.toolFiles`. |
| `analysisConfig` | `((maxOutputTokens: number) => Record<string, unknown>) \| undefined` | `{ maxOutputTokens }` | The `generationConfig` of the part reads of a whole-file read. Put the limit it is given in `maxOutputTokens`: a second try raises it to [`THINKING_OUTPUT_TOKENS`](#thinking_output_tokens). No temperature by default since 0.6.0 (see `analysisConfig` of [`AskGeminiOptions`](#askgeminioptions)). |
| `contextTokens` | `number \| undefined` | none | The model's context window in tokens. Set as `capabilities.contextTokens`, it keeps the budget of a question within it. Without it the library's budget holds: 1,000,000 tokens unless you set another. |
| `maxRequestBytes` | `number \| undefined` | none | The largest request body the model or your gateway takes, in bytes. Set as `capabilities.maxRequestBytes`, it keeps the budget within it. |
| `pageTokens` | `number \| undefined` | `530` ([`GEMINI_PAGE_TOKENS`](#gemini_page_tokens)) | Tokens billed for one PDF page shown by `view_pages`, or sent as part of a file as it is (`documents`). |
| `documents` | [`DocumentsCapability`](./ask.md#toolfiletype-documentscapability-and-nativedocumentformat) `\| undefined` | none | The files this model reads natively: small visual files sent whole go to it as `inlineData` before their text ([The file itself](../guides/pdfs.md#the-file-itself-for-small-visual-files)). `"pdf"` anywhere; `"pptx"` on the Gemini API. Vertex AI refused Office files on Gemini 3 models (HTTP 400): list `"pdf"` only there. A value that is not valid is a `TypeError` (a `RangeError` for a limit out of range) when the adapter is made. It is also `capabilities.documents`. New in 0.99.9. |
| `id` | `string \| undefined` | the model name in the URL | The name of the model in `usage.byModel` and in messages. See `id` under [`gemini()`](#geminiendpoint-options). |
| `firstByteTimeoutMs` | `number \| undefined` | `600_000` | The longest wait, in milliseconds, for the first piece of a chat reply. Headers do not count: a model that thinks sends nothing until it has thought, and a reply that is not streamed comes whole at the end. A request that gets nothing for that long is aborted with a `GeminiRequestError` (`status` 0, `kind` `"timeout"`), which `askWithFiles` sends again once. 0, a negative or a non-finite number waits without end. Not used for part reads. |
| `idleTimeoutMs` | `number \| undefined` | `300_000` | The longest wait, in milliseconds, between two pieces of a chat reply once it has started to arrive. Any bytes count, keep-alives included. The same error; `askWithFiles` sends the request again once, unless text of it was shown. 0 waits without end. |
| `fetch` | `typeof fetch \| undefined` | the global `fetch` | Used for chat requests and part reads. |
| `body` | [`GeminiRequestFields`](#geminirequestfields) `\| undefined` | none | More fields for the body of every chat request, the request for the answer included, merged last. Counted in `requestBytes`. Not used for part reads. New in 0.10.0. |
| `analysisBody` | `((maxOutputTokens: number) => GeminiRequestFields) \| undefined` | none | More fields for the body of each part read, given its output limit, merged last. The part reads' `generationConfig` is `analysisConfig`. New in 0.10.0. |
| `functionCallingMode` | `"AUTO" \| "VALIDATED" \| undefined` | `"AUTO"` | The `functionCallingConfig` mode of a request that offers tools. With `"VALIDATED"`, Gemini checks each call against the declaration of its tool. Sent only with tools. New in 0.10.0. |
| `answerWithoutTools` | `"omit" \| "mode_none" \| undefined` | `"omit"` | How the request that must be answered in text says so. `"omit"` declares no tools, as before. `"mode_none"` keeps the tools and sends mode `NONE`, so the request starts as the ones before it did; a tool call that still comes back is asked for again once (the loop's `answer_again`). New in 0.10.0. |
| `outputLimits` | [`OutputLimits`](#createoutputlimits) `\| undefined` | the memory every adapter shares | Where part reads keep the output limit they learned a model needs (see [`createOutputLimits()`](#createoutputlimits)). New in 0.99.15. |
| `timeoutMs` | `number \| undefined` | `180_000` | The longest time, in milliseconds, of one part read, its whole reply included. A part past it is a `GeminiRequestError` of kind `"timeout"` and status 0, sent again once, and then reported as "The model took too long to answer." 0 sets none. New in 0.10.0. |

The two waits default to `DEFAULT_FIRST_BYTE_TIMEOUT_MS` and `DEFAULT_IDLE_TIMEOUT_MS`
([errors and retries](./errors-and-retries.md)). What to set them to, and why the first one is
long: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md) and
[errors and reliability](../guides/errors-and-reliability.md).

### `GeminiRequestFields`

```ts
type GeminiRequestFields = {
  safetySettings?: Array<{ category: string; threshold: string; method?: string }>;
  labels?: Record<string, string>;
  serviceTier?: string;
  cachedContent?: string;
  contents?: never;
  systemInstruction?: never;
  tools?: never;
  toolConfig?: never;
  generationConfig?: never;
  [key: string]: unknown;
};
```

What `body`, `explorerBody` and `analysisBody` add to a request body: fields of the Generate
Content API that the library does not write. They are merged last. The fields the library writes
are typed `never`, so setting one fails to compile; set `generationConfig` and `analysisConfig` for
those. Nothing is refused at run time: a field given anyway replaces the library's. New in 0.10.0.

| Field | What it is |
|---|---|
| `safetySettings` | The thresholds of Gemini's safety filters. A reply a filter stops has `finish` `"filtered"`. |
| `labels` | Vertex AI only: labels for the billing export, keys and values in lower case, at most 63 characters each. They reach everyone who reads the billing data: never put a user ID, an email or other personal data in them. |
| `serviceTier` | The service tier of the request, where the API offers one. |
| `cachedContent` | The name of an explicit context cache (`cachedContents/…`). The library keeps no cache of its own: Gemini 3 caches the start of a request by itself. A request that uses a cache may not set `systemInstruction`, `tools` or `toolConfig` (they must be in the cache), and the library's requests send the system text (part reads included), and tools when they offer them: it fits only requests that send neither ([the guide](../guides/vertex-and-gemini.md#fields-of-your-own-safety-settings-labels-and-more)). |

### `GEMINI_PAGE_TOKENS`

```ts
const GEMINI_PAGE_TOKENS = 530;
```

What Gemini bills for one PDF page it is shown, in tokens (measured: 520 to 532). It is the default
of `pageTokens` in `gemini()`, and the value `askGemini` always uses. Guide: [PDFs](../guides/pdfs.md).

## Gemini contents

For an application that keeps its conversations as Gemini `contents`.

### fromGeminiContents(contents, options?)

```ts
declare function fromGeminiContents(contents: GeminiContent[], options?: FromGeminiContentsOptions): ChatMessage[];
```

Gemini `contents` as the `messages` of `askWithFiles` ([`ChatMessage`](./ask.md#chatmessage)).
`askGemini` uses it for `contents`. The array and its parts are not changed.

- **The tool rounds of earlier questions become stored rounds** ([`ToolTurn`](./ask.md#toolturn)),
  as [`geminiToolTurns()`](#geminitoolturnsturns) wrote them: a `model` turn made only of
  `functionCall` parts that call the library's tools ([`TOOL_NAMES`](./tools.md#tool_names)),
  followed by the `user` turn of their `functionResponse` parts, one for each call, in the same
  order, with the same names and `id`s. New in 0.9.0, and on by default (`rounds`).
- The role `"user"` stays `"user"`, and `"model"` becomes `"assistant"`.
- A part that holds only `text` becomes `{ text }`. A part with `text` and other fields (a thought
  signature) becomes `{ native: part, text }`. The loop counts its tokens from the text and its
  bytes from the whole part (the bytes since 0.9.0).
- Every other part is kept as `{ native: part }`, which `gemini()` sends back as it is: an image,
  an inline PDF, and a function call or response that is not part of such a round.
- A `functionCall` or `functionResponse` part kept this way carries, as its `text`, the JSON of its
  call or response. The loop counts its tokens from that text, as it counts a stored round, and
  its bytes from the whole part, a thought signature next to the call included. One with files in
  it (`parts` in a response) is sized as media. New in 0.9.0: before, every function part was
  sized as media, at about a token for each 256 characters, and a follow-up whose rounds were in
  `contents` was counted about 15,000 tokens short in a test of two calls.

With its rounds as stored rounds, a follow-up asked with `contents` works as one asked with
`messages` and `toolTurns`: a repeated call is answered with a pointer to its earlier result, the
results can be shortened to make room, and they are sized alike. For a round that
`geminiToolTurns` wrote, the request is the same, byte for byte, as before 0.9.0: the round is
sent as it was written. When the loop shortens such a round, the later requests of the question
hold its stand-ins. A round that 0.5.0 converted has `tool_turns_left` in its responses: it is
lifted too, and sent without it, as stored rounds are, and a call without `args` is sent with
`args: {}`. A conversation that holds such a round misses the prompt cache once after the
upgrade, from that round on.

A turn is kept as it is, part by part, when anything in it is not of that form: a function of
your own, a call next to one of yours, a thought signature, a response with a file in it, or
responses that do not match the calls. So is a round that ends `contents`, with no turn after it:
its responses are the turn the model answers (an application that ran the tools in a loop of its
own hands the conversation over). `askWithFiles` throws "The last message must be the user's." for
a conversation that ends with a stored round.

Guide: [conversations](../guides/conversations.md#gemini-contents).

### `FromGeminiContentsOptions`

```ts
type FromGeminiContentsOptions = { rounds?: boolean };
```

New in 0.9.0.

| Field | Type | Default | What it does |
|---|---|---|---|
| `rounds` | `boolean` | `true` | Turn the tool rounds of earlier questions into stored rounds (above). `false` keeps every turn as its parts, as 0.8 did. Function parts are sized by their JSON either way. With `askGemini`: `messages: fromGeminiContents(contents, { rounds: false })`. |

### geminiToolTurns(turns)

```ts
declare function geminiToolTurns(turns: ToolTurn[]): GeminiContent[];
```

The tool rounds of a question ([`AskResult.toolTurns`](./ask.md#askresult)) as Gemini `contents`:
for each round, a `model` turn of `functionCall` parts (`{ name, args, id? }`), then a `user` turn
of `functionResponse` parts, in call order. Put them between the question and its answer, and the
model sees in a later question what its tools returned in this one. The results leave out
`tool_turns_left`, which counted the turns of their own question, as `askWithFiles` does with
stored rounds (since 0.6.0): a history kept as `contents` gives the same request as one kept as
`toolTurns`. Contents that 0.5.0 converted keep the field. Since 0.9.0 `fromGeminiContents` turns
these turns back into stored rounds, so the loop treats them alike too, and the rounds of 0.5.0
are then sent without the field (above). A round of a newer version (`version` above
`TOOL_TURN_VERSION`), or whose `version` is not a number, is the `TypeError` of `askWithFiles`
(since 0.99.9).

```ts
import { askGemini, geminiToolTurns, type GeminiContent } from "llm-large-files/gemini";

// files, endpoint, userId and documentId as above. history is what your application keeps for the chat.
const history: GeminiContent[] = [];

async function ask(question: string): Promise<string> {
  const turn: GeminiContent = { role: "user", parts: [{ text: question }] };
  const result = await askGemini({ files, endpoint, owner: userId, documentIds: [documentId], contents: [...history, turn] });
  history.push(turn, ...geminiToolTurns(result.toolTurns));
  if (result.answered) history.push({ role: "model", parts: [{ text: result.text }] });
  return result.text;
}
```

Guide: [conversations](../guides/conversations.md).

### `GeminiContent`

```ts
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
```

One entry of Gemini's `contents`.

### `GeminiPart`

```ts
type GeminiPart = Record<string, unknown>;
```

One part of a turn, in Gemini's own form: `{ text }`, `{ inlineData }`, `{ functionCall }`,
`{ functionResponse }` and so on. The library reads `text`, `thought` and `functionCall` (and,
since 0.9.0, the function parts of `fromGeminiContents`), and passes every part on as it is.

## Helpers for your own loop

These build Gemini requests in a tool loop of your own, made with `files.prepare()` and
`files.tools()`. Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

### createGeminiGenerateText(options)

```ts
declare function createGeminiGenerateText(options: {
  url: string;
  headers: Record<string, string> | ((context?: { refresh?: boolean }) => Record<string, string> | Promise<Record<string, string>>);
  fetchImpl?: typeof fetch;
  generationConfig?: (maxOutputTokens: number) => Record<string, unknown>;
  body?: (maxOutputTokens: number) => GeminiRequestFields;
  timeoutMs?: number;
  refreshable?: boolean | undefined;
}): GenerateText;
```

A [`GenerateText`](./ask.md#generatetext) on a non-streaming `...:generateContent` URL: the plain
completion a whole-file read uses for each part. `gemini()` builds one on its endpoint's `url`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `url` | `string` | required | The `...:generateContent` URL. What is learned about the model's output limit is kept under it. |
| `headers` | `Record<string, string>` or a function that returns them | required | A function is called before every request: a whole-file read can outlast an access token. Since 0.99.13 one that throws fails the part's request as `gemini()`'s does: kind `"unreachable"`, sent again, for a connection that failed; kind `"auth"`, not sent again, otherwise. |
| `fetchImpl` | `typeof fetch` | the global `fetch` | Your own `fetch`. |
| `generationConfig` | `(maxOutputTokens: number) => Record<string, unknown>` | `{ maxOutputTokens }` | The `generationConfig` of each request, from its output limit. Until 0.6.0 the default also sent `temperature: 0.2`. |
| `body` | `(maxOutputTokens: number) => GeminiRequestFields` | none | More fields for the body of each request, given its output limit, merged last (`gemini({ analysisBody })`). New in 0.10.0. |
| `timeoutMs` | `number` | `180_000` | The longest time one request may take, its whole body included. A second try at a larger limit gets its own. 0 sets none (since 0.10.0; before, 0 aborted every request at once). |
| `outputLimits` | [`OutputLimits`](#createoutputlimits) | the memory every adapter shares | Where what is learned about the limit is kept (see below). New in 0.99.15. |
| `refreshable` | `boolean` | `false` | A request refused with HTTP 401 is sent once more with the headers of `headers({ refresh: true })`. A second 401 is the error. New in 0.10.0. Since 0.99.13 it calls the request's `onRefresh` first ([`GenerateText`](./ask.md#generatetext)), and a refresh that fails on a connection sends the part again from the start. |

Each request posts `contents: [{ role: "user", parts: [{ text: prompt }] }]`, the system
instruction when it is not empty (since 0.99.10; before, an empty one was sent as a text part with
no text), the `generationConfig` and the fields of `body`. The text it returns is the reply's text parts without the
thoughts, joined. `onUsage` gets the usage of every request that was answered
([`usageOfGemini()`](#usageofgeminiusage)). `onTruncated` is called when the reply stopped at
`MAX_TOKENS`, a filter stopped it, or, since 0.10.0, it ended for a reason whose `finish` is
`"other"` ([`gemini()`](#geminiendpoint-options)).

A reply of HTTP 200 that is a list of chunks, as Gemini answers without `?alt=sse` (a gateway that
passes such a reply on), is read chunk by chunk, as a chat reply is: its text is that of every
chunk, and its finish reason and usage are the last ones it has (since 0.10.0; before, the read
threw "The model returned no text.").

When a reply stops at `MAX_TOKENS` with no text, or with half the limit or more spent on thoughts,
and the limit was below [`THINKING_OUTPUT_TOKENS`](#thinking_output_tokens), the request is sent
once more with that limit, and later requests to the same `url` start there (in the same memory: `outputLimits`, or the one every adapter shares). If that second request
fails, the first reply's text is kept when it had some, and the error is thrown when it had none. A
model or gateway that refused the larger limit with HTTP 400 is not asked for it again. A refusal
of the request as too large (kind `"context_overflow"`: for the model's window at HTTP 400, or for
the tokens a minute the provider allows at HTTP 429 or 413) is not taken for that since 0.6.0: it
turns the larger limit off only when the window or allowance it names is 32,768 tokens or less.
Otherwise what was learned is forgotten, and a later part may still get the larger limit. The
first request to a `url` goes alone: requests to it that arrive meanwhile wait for what it learns.

| Case | Error |
|---|---|
| An HTTP error | `GeminiRequestError` with Gemini's `error.message`, or "The model returned HTTP 503.", with `status`, `kind` and `retryAfterMs`. A body that is a list is read by its first entry (since 0.10.0). |
| An error in a body of HTTP 200 (a gateway, or Vertex AI), or in any chunk of a list | `GeminiRequestError` with its message, or "Gemini reported an error.", whose `status` is its `code`, else that of its `google.rpc` name, else 500. New in 0.10.0: before, the reply had no text, and the error was "The model returned no text." |
| The connection failed, or the body could not be read | `GeminiRequestError`: "Gemini could not be reached (…).", `status` 0 |
| A body of HTTP 200 that is empty | `GeminiRequestError`: "Gemini could not be reached (the reply was empty).", `status` 0 |
| A body that is not JSON | `GeminiRequestError`: "Gemini's reply could not be read: it was not JSON (text/html). A proxy or gateway may have answered in its place.", the response's `status`, kind `"invalid"`, the `SyntaxError` as `cause`. Until 0.6.0, the `SyntaxError` itself. |
| `timeoutMs` passed | `GeminiRequestError`: "Gemini took longer than 180 s to answer.", `status` 0, kind `"timeout"`, which a whole-file read sends again once. New in 0.10.0: before, the abort error of the timer, with no status. |
| `signal` aborted | The signal's reason, as it is |
| A reply with no text | `Error`: "The model returned no text." or, with its `finishReason`, "The model returned no text (SAFETY)." |
| A prompt Gemini blocked: HTTP 200 with `promptFeedback.blockReason` and no candidate | `Error`: "The model returned no text (PROHIBITED_CONTENT).", with the block reason. It is not sent again: it would be blocked again. Before 0.7.1 it had no reason, and a whole-file read sent it once more. |

A whole-file read tries a part once more after an error with no status, and after a timeout. It
tells the model why a part failed by the error's kind and status, never by Gemini's message: "The
model took too long to answer." for a request past `timeoutMs`, "The model returned no text
(SAFETY)." for a reply with no text, the reason only when it is a plain word (see
[`analyze_whole_document`](./tools.md#analyze_whole_document)).

Since 0.10.0 `gemini(endpoint, { timeoutMs })` and `askGemini({ timeoutMs })` set the time of each
part read: there is no need to replace the adapter's `generateText` for it.

Guides: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md),
[errors and reliability](../guides/errors-and-reliability.md).

### `THINKING_OUTPUT_TOKENS`

```ts
const THINKING_OUTPUT_TOKENS = 32_768;
```

The output limit that a part read is asked for again with when the model spent its limit on
thoughts. A model that thinks counts its thoughts in its output limit: asked for 4,096 tokens of
notes on a part of a log, Gemini 3.8 Flash spent 3,931 of them thinking and wrote two lines, and
Gemini 4 wrote nothing (November 2026). The part reads of `gemini()`, `openAiCompatible()` and
`anthropic()` all follow this rule; the constant is exported only from this entry point.

Guides: [Gemini API and Vertex AI](../guides/vertex-and-gemini.md); the rule for every adapter's
part reads: [How it works](../how-it-works.md#map-reduce).

### createOutputLimits()

```ts
declare function createOutputLimits(): OutputLimits;
```

A memory of output limits of its own, for the `outputLimits` option of `gemini()`, `askGemini()`,
`createGeminiGenerateText()`, `openAiCompatible()`, `openAiResponses()` and `anthropic()`. The part
reads of the adapters given it keep in it what they learn (that a model needs
[`THINKING_OUTPUT_TOKENS`](#thinking_output_tokens), or that it refused that limit), and learn
nothing from other adapters. Without it, every adapter of the process shares one memory, as before
0.99.15, so an app that makes an adapter for each question still learns once.

Give a test, or an eval case, its own memory: its requests then do not depend on the tests that ran
before it, nor on those that run at the same time. `OutputLimits` has nothing to read or change;
pass it on. It is also exported by `llm-large-files`, `llm-large-files/openai` and
`llm-large-files/anthropic`. New in 0.99.15.

```ts
import { createOutputLimits, gemini, geminiApi } from "llm-large-files/gemini";

const model = gemini(geminiApi({ apiKey: "test", model: "gemini-3.5-flash" }), { outputLimits: createOutputLimits() });
```

### toGeminiTools(declarations)

```ts
declare function toGeminiTools(declarations: ToolDeclaration[]): { functionDeclarations: ToolDeclaration[] };
```

The tool declarations of a [`ToolSet`](./tools.md#toolset) as an entry of Gemini's `tools`.
Gemini takes the library's JSON Schema subset as it is, so the declarations are not changed.

### geminiFunctionResponses(calls)

```ts
declare function geminiFunctionResponses(calls: GeminiToolAnswer[]): GeminiContent & { role: "user" };
```

The `user` turn that answers a model turn's function calls: one part
`{ functionResponse: { name, id?, response, parts? } }` for each call, in the order given, where
`response` is what the tool returned. A file a tool returned (`files`, from
`executeWithFiles`) goes inside its function response, as
`{ inlineData: { mimeType, displayName, data } }` with the bytes in base64. The field of the result
whose value is the file's name becomes `{ "$ref": name }`; a file that no field names is listed in
`response.files` as `{ "$ref": name }`. The results you pass are not changed. To put files beside
the function responses, use `geminiFunctionResponseTurns()`.

### geminiFunctionResponseTurns(calls, options?)

```ts
declare function geminiFunctionResponseTurns(
  calls: GeminiToolAnswer[],
  options?: { files?: GeminiToolFilePlacement },
): Array<GeminiContent & { role: "user" }>;
```

The turns that answer a model turn's function calls. Add them all to `contents`, in order.

| Option | Type | Default | What it does |
|---|---|---|---|
| `files` | [`GeminiToolFilePlacement`](#geminitoolfileplacement) | `"inside"` | `"inside"`, or any value but `"beside"`: one turn, that of `geminiFunctionResponses()`. `"beside"`: the function responses, without files, in one `user` turn; then, when a call returned files, a second `user` turn in which each file follows a text part "pages-2-3.pdf (returned by view_pages):", as `{ inlineData: { mimeType, data } }`. |

The files get a turn of their own because Vertex AI refuses a turn in which anything follows a
function response (HTTP 400 for Gemini 3 models, November 2026). Each turn is a `GeminiContent` with
the role `"user"`, so the turns go into a `GeminiContent[]` as they are.

One tool round of your own loop:

```ts
import type { ToolSet } from "llm-large-files";
import { geminiFunctionResponseTurns, type GeminiContent, type GeminiToolAnswer } from "llm-large-files/gemini";

// tools is the ToolSet of files.tools(); contents is the conversation of your request, and
// modelTurn is the model turn of Gemini's last reply, which called functions.
async function answerCalls(tools: ToolSet, contents: GeminiContent[], modelTurn: GeminiContent): Promise<void> {
  const answers: GeminiToolAnswer[] = [];
  for (const part of modelTurn.parts) {
    const call = part.functionCall as { name: string; args?: Record<string, unknown>; id?: string } | undefined;
    if (!call) continue;
    const args = call.args ?? {};
    const { result, files } = await tools.executeWithFiles(call.name, args);
    answers.push({ call: { name: call.name, args, ...(call.id ? { id: call.id } : {}) }, result, files });
  }
  // The model turn goes back unchanged: Gemini 3 wants its thought signatures.
  contents.push(modelTurn, ...geminiFunctionResponseTurns(answers, { files: "beside" }));
}
```

### `GeminiFunctionCall`

```ts
type GeminiFunctionCall = ToolCall; // { id?: string; name: string; args: Record<string, unknown>; problem?: string }
```

A function call of the model: [`ToolCall`](./ask.md#toolcall) under a Gemini name.

### `GeminiToolAnswer`

```ts
type GeminiToolAnswer = ToolAnswer; // { call: ToolCall; result: ToolResult; files?: ToolFile[] }
```

A function call with what the tool returned for it, and the files it returned:
[`ToolAnswer`](./ask.md#toolanswer) under a Gemini name.

### `GeminiToolFilePlacement`

```ts
type GeminiToolFilePlacement = "inside" | "beside";
```

Where a file that a tool returned (the pages of `view_pages`) goes in the request:

| Value | Where the file goes |
|---|---|
| `"inside"` | In the `parts` of its function response, which names it with `{ "$ref": name }`. Gemini 3 models read it there. Gemini 2.5 accepts that form and does not see the file. |
| `"beside"` | In a `user` turn of its own, after the turn of function responses, for a model that does not read a file inside a function response. |

Guide: [PDFs](../guides/pdfs.md), which has the live results for each model.

### usageOfGemini(usage)

```ts
declare function usageOfGemini(usage: Record<string, unknown> | undefined): GenerateUsage;
```

Gemini's `usageMetadata` in the terms every adapter reports ([`GenerateUsage`](./ask.md#generateusage)):
thoughts are output, and cached tokens are part of the input.

| Field | From `usageMetadata` |
|---|---|
| `inputTokens` | `promptTokenCount` + `toolUsePromptTokenCount` |
| `cachedInputTokens` | `cachedContentTokenCount` |
| `outputTokens` | `candidatesTokenCount` + `thoughtsTokenCount` |
| `thoughtTokens` | `thoughtsTokenCount` |

A field that is missing or not a number counts as 0, and `undefined` gives four zeros. Guide:
[costs and limits](../guides/costs-and-limits.md).

## Errors

### `GeminiRequestError`

```ts
declare class GeminiRequestError extends ModelRequestError {
  constructor(message: string, status: number, options?: {
    retryAfterMs?: number;
    cause?: unknown;
    kind?: ModelErrorKind;
    code?: string | undefined;
    details?: unknown;
  });
}
```

A Gemini request that failed: Gemini answered with an HTTP error, or `status` is 0 because Gemini
could not be reached, sent nothing for a whole wait, ended a stream before it was complete, or did
not answer a part read within `timeoutMs`. Since 0.99.13 also, with status 0, a request whose
token or headers function threw, with what it threw as the `cause`: kind `"unreachable"` (or
`"timeout"`) for a connection that failed, `"auth"` otherwise
([key and token functions](./errors-and-retries.md#key-and-token-functions)). A reply of HTTP 200 that could not be read (not JSON, or
an event too long) keeps its 200, with kind `"invalid"`. An error that came inside a reply of HTTP
200 has the status of its code or of its `google.rpc` name (since 0.10.0).
`gemini()` throws it for chat requests, and its part reader (`generateText`) for part reads.
`askGemini` and `askWithFiles` throw it for a chat request that failed and was not worth another
try, or still failed after the retries. A part read that fails is not thrown: the part counts as
unread, and when no part could be read the tool call returns
`{ error: "Could not read any part of app.log: …" }` to the model, with the kind and status of the
failure, not Gemini's message ("The model was busy (HTTP 429)."). Its `name` is
`"GeminiRequestError"`.

Its fields are those of [`ModelRequestError`](./errors-and-retries.md#modelrequesterror): `status`,
`kind`, `retryAfterMs`, and for a request too large, `limitTokens` and `requestedTokens` when the
message gives them (`kind`, `limitTokens` and `requestedTokens` are new in 0.6.0). Gemini's `error.status` (such as `"RESOURCE_EXHAUSTED"`) and `details` are
passed in as `code` and `details` to tell the `kind`, and are not kept on the error:

- HTTP 429 whose `details` name a quota per day (`google.rpc.QuotaFailure`) is `"quota"`, which is
  not retried. So is a 429 whose message alone names a quota per day, as Vertex AI's
  "Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_day_per_project_per_base_model …"
  does. Another 429 is `"rate_limit"`.
- HTTP 400 whose `details` give the reason `API_KEY_INVALID` is `"auth"`.
- A message such as Vertex AI's "Unable to submit request because the input token count is N but
  model only supports up to M." is `"context_overflow"`, with `requestedTokens` N and
  `limitTokens` M.

```ts
import { askGemini, DocumentsNotFoundError, GeminiRequestError, partialResultOf } from "llm-large-files/gemini";

// files, endpoint and userId as above; documentIds: string[];
// messages: ChatMessage[] (plain turns and stored toolTurns).
try {
  const result = await askGemini({ files, endpoint, owner: userId, documentIds, messages });
  console.log(result.text);
} catch (error) {
  if (error instanceof DocumentsNotFoundError) {
    console.error("Upload again:", error.ids);
  } else if (error instanceof GeminiRequestError) {
    // For your logs, not for your users: the message is Gemini's own.
    console.error(error.status, error.kind, error.retryAfterMs, error.message);
  }
  const partial = partialResultOf(error); // what the question found and paid for before it failed
  if (partial) console.error(`${partial.usage.requests} requests were answered before it failed`);
  throw error;
}
```

What to show your users for each `kind`: [errors and reliability](../guides/errors-and-reliability.md).

## Re-exports of the main entry

These are the same values and types as the exports of `llm-large-files`, so `instanceof` works
whichever entry point you import them from. Each is described on its own page.

| Export | What it is | Page |
|---|---|---|
| `DocumentsNotFoundError` | The error for document IDs that were never uploaded, have expired, or belong to another owner; `.ids` lists them. | [ask](./ask.md#documentsnotfounderror) |
| `partialResultOf(error)` | What a question that threw had found and used until then, or `undefined`. | [ask](./ask.md#partialresultoferror) |
| `EXPLORER_INSTRUCTION` | The line added to an explorer model's system instruction. | [ask](./ask.md#explorer_instruction) |
| `FINAL_ANSWER_REQUEST` | The message that asks for the answer after tools ran. | [ask](./ask.md#final_answer_request) |
| `FINAL_ANSWER_AFTER_PAGES` | The same, when `view_pages` was the only tool. | [ask](./ask.md#final_answer_after_pages) |
| `FINAL_ANSWER_WITHOUT_TOOLS` | The message that asks for the answer when no tool ran. | [ask](./ask.md#final_answer_without_tools) |
| `parseSseJson(stream, hooks?)` | The `text/event-stream` parser: JSON objects, one per `data:` event. | [errors and retries](./errors-and-retries.md#parsessejsonstream-hooks) |
| `ChatTurn` | The type `{ role: "user" \| "assistant" \| "model"; text: string }`. | [ask](./ask.md#chatturn) |
| `AskEvent` | The type of the events `onEvent` gets. New in 0.7.0. | [events](./events.md) |
