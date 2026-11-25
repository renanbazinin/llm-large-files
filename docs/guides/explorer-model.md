# An explorer model

This guide is for you when questions about large files take many searches and reads, and you want
a cheaper or faster model to do them while the model you chose writes the answer. It shows how to
set that second model with `askGemini` or `askWithFiles`, what each model gets, what changes for
your application, and when a second model pays off.

## Who does what

The model is yours to choose: the package has no default. One model does both halves of the work
on a large file: it explores the file (searches, reads, looks at pages), and it answers. An
explorer is a second model for the first half. The model you chose, `model`, then writes the
answer from what the explorer's tool calls returned.

| Work | The explorer | `model` |
|---|---|---|
| Requests with tools: `search_document`, `read_document`, `get_document_overview`, `analyze_whole_document`, `view_pages` | All of them | None |
| The part reads of `analyze_whole_document` | All of them | None |
| A second try after an empty or broken turn, with its note | Gets it | Never sees the explorer's |
| The answer | None | One request, in which no tool can be called, and a second try with its own note when that request comes back without text |
| A question whose documents are all sent whole, with no pages to look at | Not called | One request, as without an explorer |

The explorer is called only when the question needs tools: a document is too large to send whole,
or a PDF has pages the model may look at (`view_pages`). When every document goes into the prompt
whole and there are no pages to look at, `model` gets one request, exactly as without an explorer.
The tools themselves are described in the [tools reference](../reference/tools.md).

## Set an explorer with `askGemini`

`askGemini` is `askWithFiles` with a `gemini()` model for the endpoint, and a second one for the
explorer when the endpoint names one. `geminiApi()` and `vertexAi()` take `explorerModel` next to
`model`. On Vertex AI:

```ts
import { GoogleAuth } from "google-auth-library";
import { askGemini, vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global",
  model: "gemini-3.8-flash",                        // writes the answer
  explorerModel: process.env.GEMINI_EXPLORER_MODEL, // searches and reads; unset or empty: no explorer
  accessToken: async () => (await auth.getAccessToken())!,
});

// files is your library (createLargeFiles); documentIds, messages and userId (the signed-in user,
// the documents' owner) come from the request.
const result = await askGemini({
  files,
  endpoint,
  documentIds,
  messages,
  owner: userId,
  generationConfig: { thinkingConfig: { thinkingLevel: "high" } },        // for `model`
  explorerGenerationConfig: { thinkingConfig: { thinkingLevel: "low" } }, // for the explorer
  onText: (delta) => process.stdout.write(delta),
});
```

`geminiApi({ apiKey, model, explorerModel })` takes it the same way. The name is trimmed. Left out,
empty, or the same as `model`, there is no explorer, and `askGemini` sends exactly the requests it
sends without one. So a setting that may be unset can be passed as it is.

`explorerModel` sets the endpoint's `explorerUrl`: the `...:generateContent` URL of the explorer,
next to the model's own `url` and `streamUrl`. With URLs of your own, for a gateway, set
`explorerUrl` yourself. An `explorerUrl` that is the same as `url` is no explorer.

```ts
import type { GeminiEndpoint } from "llm-large-files/gemini";

const gateway: GeminiEndpoint = {
  url: "https://llm-gateway.corp.example/gemini/models/gemini-3.8-flash:generateContent",
  streamUrl: "https://llm-gateway.corp.example/gemini/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
  explorerUrl: "https://llm-gateway.corp.example/gemini/models/gemini-3.5-flash-lite:generateContent",
  headers: { "Content-Type": "application/json", "x-api-key": process.env.GATEWAY_API_KEY! },
};
```

What `askGemini` gives each model:

- **The same headers.** The explorer is called with the endpoint's `headers`, so it uses the same
  API key or access token as `model`. `vertexAi()` builds the explorer's URL from the same
  `project` and `location`, so a `vertexAi()` explorer is in the same project and location too.
  Two models that need different headers (one on the Gemini API with a key, the other on Vertex AI
  with a token) cannot be paired this way: use `askWithFiles`
  ([below](#set-an-explorer-with-askwithfiles)).
- **Their own `generationConfig`.** `generationConfig` goes to `model`. `explorerGenerationConfig`
  goes to the explorer and defaults to `generationConfig`. Set it when the two models do not take
  the same settings: a `thinkingLevel` that a Gemini 2.5 model refuses with HTTP 400, for example
  (Gemini 2.5 takes `thinkingBudget`). It is not used without an explorer.
- **One value of the other settings for both.** `toolFilePlacement`, `analysisConfig`,
  `firstByteTimeoutMs`, `idleTimeoutMs` and `fetch` apply to both models. `analysisConfig` is the
  `generationConfig` of the part reads of a whole-file read, which the explorer makes: write it for
  the explorer. `toolFilePlacement: "inside"` is read by Gemini 3 models; if either model is
  Gemini 2.5, use `"beside"`, which both read (see [PDFs](./pdfs.md)). Since 0.10.0,
  `timeoutMs` (the time of one part read), `analysisBody`, `functionCallingMode` and
  `answerWithoutTools` apply to both models too. `body` goes to the chat requests of both, unless
  `explorerBody` is set for the explorer.
- **The defaults of `gemini()`.** `askGemini` has no option for `contextTokens`,
  `maxRequestBytes`, `pageTokens` or `id`, so both of its models keep the defaults of `gemini()`:
  no window and no request size declared, 530 tokens a page, and the model's name from its URL in
  `usage.byModel`. Set the window and the request size of the smaller of the two models in the
  library's `budget` (or in `budget` of the question). See [Costs and limits](./costs-and-limits.md).
- **No streaming for the explorer.** Its requests go to `explorerUrl` in one piece. The answer
  streams from `streamUrl` when you pass `onText`.

The options of `askGemini`, `geminiApi()` and `vertexAi()` are in the
[Gemini reference](../reference/gemini.md). Production setup for Vertex AI (access tokens,
locations, quotas) is in [Gemini and Vertex AI](./vertex-and-gemini.md).

## Set an explorer with `askWithFiles`

`askWithFiles` takes `explorer`: any `ModelAdapter`, of any provider. Each model is an adapter with
its own settings, so the two can differ in everything: provider, API, project, location,
`generationConfig`, where pages go, the window they declare, and their name in the usage totals.
The options of the question (`limits`, `retry`, `budget`, `signal`) apply to both.

```ts
import { GoogleAuth } from "google-auth-library";
import { askWithFiles } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const onVertex = (model: string) => vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model,
  accessToken: async () => (await auth.getAccessToken())!,
});

const model = gemini(onVertex("gemini-3.8-flash"), {
  generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
  contextTokens: 1_048_576, // its input window: no question is planned for more (the library's default, 1,000,000, is smaller here)
});
const explorer = gemini(onVertex("gemini-2.5-flash-lite"), {
  generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  toolFilePlacement: "beside", // Gemini 2.5 does not see a file inside a function response
  contextTokens: 1_048_576,
});

// files, documentIds, messages and userId as in the sample above.
const result = await askWithFiles({
  files, model, explorer, documentIds, messages, owner: userId,
  onText: (delta) => process.stdout.write(delta),
});
```

Here each model gets pages its own way: `"beside"` for the Gemini 2.5 explorer, `"inside"` (the
default) for the Gemini 3 model that answers. With `askGemini`, one placement serves both.

The explorer can be of another provider. A model on your own vLLM server, through the
OpenAI-compatible adapter, explores while Gemini on Vertex AI answers:

```ts
import { openAiCompatible } from "llm-large-files/openai";

// askWithFiles, files, documentIds, messages, userId and `model` (the Gemini adapter) are those of the sample above.
const local = openAiCompatible({
  baseUrl: process.env.VLLM_BASE_URL!, // for example http://vllm.internal:8000/v1
  model: process.env.VLLM_MODEL!,
  contextTokens: 131_072,              // the --max-model-len the server runs with
});

const answer = await askWithFiles({ files, model, explorer: local, documentIds, messages, owner: userId });
```

The question then runs inside the smaller window, 131,072 tokens, for both models. And this
explorer is sent no PDF (`pdfInput` is off by default), so `view_pages` is not offered to either
model: see [the budget, token scale and pages](#the-budget-token-scale-and-pages). The roles can
be the other way round, and any adapter can take either: `model: anthropic({ ... })` with
`explorer: gemini(...)` works the same. Recipes for each provider are in
[OpenAI-compatible endpoints](./openai-compatible.md) and [Claude](./anthropic.md).

Three things to know:

- **The same adapter is no explorer.** `explorer: model`, the same object, is the same as leaving
  `explorer` out. Two adapters for the same model are two models.
- **`gemini()` ignores `explorerUrl`.** An endpoint built with `explorerModel` and passed to
  `gemini()` gives one model. Make the explorer an adapter of its own, as above.
- **Whole-file reads need the explorer's `generateText`.** The part reads are the explorer's, so
  `analyze_whole_document` is offered only when the explorer's adapter has `generateText`. All
  three adapters of the package have it; an adapter of your own may not (see
  [Your own adapter and loop](./own-adapter-and-loop.md)).

`AskOptions` and the adapter contract are in the [ask reference](../reference/ask.md).

## What the answering model gets

The request for the answer holds:

- **Your system instruction and the tool guide**, without the explorer's line
  (`EXPLORER_INSTRUCTION`, [below](#the-explorers-part-done)).
- **The conversation**, with the documents' text and cards where `documentPlacement` puts them, as
  every request of the question has them.
- **Each tool round of the explorer, as its calls and their results**, in the answering model's
  own provider form. Pages that the explorer looked at are part of the results, so the answering
  model is shown them too, placed the way its own adapter places files.
- **A user message at the end** that asks for the answer:

| When | The message |
|---|---|
| No tool call was made: the explorer replied `DONE` at once, its replies stayed empty or its calls could not be read, or `limits` left no turn for tools | `FINAL_ANSWER_WITHOUT_TOOLS` |
| Otherwise, when a document is searchable (too large to send whole) | `FINAL_ANSWER_REQUEST` |
| Otherwise: the only tool was `view_pages`, and every text is in the prompt | `FINAL_ANSWER_AFTER_PAGES` |

The tools are listed in that request with a tool choice of "none", so no tool can be called. Each
adapter says it in its own way: `gemini()` leaves the tools out, `anthropic()` sends
`tool_choice: { type: "none" }`, and `openAiCompatible()` sends `tool_choice: "none"`, or leaves
the tools out with `answerWithoutTools: "omit"`. `openAiResponses()` sends `tool_choice: "none"`.

The request does not hold the explorer's thoughts, its thought signatures, anything it wrote next
to its calls, its `DONE`, or the notes it was sent. A thought signature belongs to the model that
wrote it, and what the explorer made of the files is not what the files say: the answer is written
from the tool results. So the answering model can use only what the explorer fetched. It has no
tools to fetch more. What each call showed is in `result.evidence`, as it is with one model.

## The explorer's part: DONE

Every chat request to the explorer (its tool turns and second tries, not the part reads of a
whole-file read) has one paragraph added at the end of its system instruction,
`EXPLORER_INSTRUCTION`, exported from `llm-large-files` and `llm-large-files/gemini`. It tells the
explorer that another model writes the answer from what its tool calls returned, and to reply with
the single word DONE when the results hold what the answer needs
([the text](../reference/ask.md#explorer_instruction)).

Its own turns go back to the explorer unchanged, thought signatures included, so a Gemini 3
explorer keeps its signatures across its tool rounds.

A reply of the explorer that calls no tool ends the exploring, whatever it says, unless it is an
empty or broken turn, which is asked for once more
([below](#notes-after-an-empty-or-broken-turn)). `DONE` is what it is asked for. A model that
writes an answer instead is not an error: its text is dropped, not shown and not sent to the
answering model, but you pay for its output tokens. The request for the answer follows in either
case.

Two cases end the question without an answer request:

- **The explorer's prompt was blocked.** A blocked prompt would be blocked again: the question ends
  with `answered: false` and `blockReason`.
- **The explorer's request failed.** Its error reaches you after the retries, as an error of
  `model` does (see [below](#what-changes-for-your-application)).

An explorer that never stops calling tools is stopped by `limits.toolTurns`, or earlier by the
ceilings of `limits` or the room left in the request. The request for the answer is still made,
from what the tools returned so far.

## Notes after an empty or broken turn

The loop asks the model that explores once more, with a short note, after one of two turns:

| Turn | The note to an explorer |
|---|---|
| A tool call that could not be read (`finish: "malformed_call"`: Gemini's `MALFORMED_FUNCTION_CALL` or `UNEXPECTED_TOOL_CALL`). `anthropic()` and `openAiCompatible()` answer such a call in the tool round with an error instead, and send no note. | "Your last reply tried to call a tool, but the call could not be read. Call the tools again, with arguments that match their declarations, or reply DONE if the results above already hold what the answer needs." |
| A first reply with nothing in it: no text and no call, before any tool call of the question, and not cut off or filtered | "Your last reply was empty. Call the tools to gather what the answer needs from the files, then reply DONE." |

Without an explorer, the notes ask the model to call the tools or to answer, instead of replying
`DONE`.

- When a second try is made, what it costs and what `steps` says:
  [Errors and reliability](./errors-and-reliability.md#empty-or-broken-turns).
- An explorer whose adapter declares `appendOnly` (Claude) keeps the note in its own conversation,
  because Claude ties what it thinks next to the turns before it.
- **With an explorer, the answering model never gets the explorer's notes**, whichever adapter
  explores or answers. It gets a note of its own only when its answer comes back without text,
  empty or with a tool call: the request for the answer is then made once more, with "Your last
  reply had no text. No tool can be called in this reply: write the answer now, in text, from what
  is above." at its end, and the note is not kept. That try is one of the two of the question, and
  it can be one request past `limits.toolTurns`.

## Limits and usage across both models

`limits` of the question counts the work of both models together. The table of every limit is in
the [ask reference](../reference/ask.md); what each costs is in
[Costs and limits](./costs-and-limits.md).

- **`limits.toolTurns`** (12 by default) counts every chat request: the explorer's, its second
  tries, and the answer. The second try of the answer itself, when the answering model wrote no
  text, can be one past it. With an explorer the answer is always a request of its own, so the
  explorer has at most `toolTurns − 1` requests. With `toolTurns: 1` there is no exploring: the one
  request is the answer, from what is in the prompt. `maxToolTurns` of `askGemini` is the same
  limit under its name from before 0.5.0.
- **`limits.callsPerTurn`** and **`limits.wholeDocumentReads`** apply to the explorer's turns, as
  they do to one model's.
- **`limits.inputTokens`** and **`limits.requests`** are ceilings on the totals of the question:
  both models' chat requests and the explorer's part reads together. Once one is reached (for
  `requests`, once one request is left), no more tools run and the next request is the answer.

`result.usage` has the totals of the question and an entry for each model in `usage.byModel`. The
part reads of a whole-file read are counted under the explorer.

```ts
// `result` is what askWithFiles or askGemini returned.
for (const [id, used] of Object.entries(result.usage.byModel)) {
  console.log(`${id}: ${used.requests} requests, ${used.inputTokens} input tokens (${used.cachedInputTokens} cached), ${used.outputTokens} output tokens`);
}
```

The key of an entry is the adapter's `id`. By default it is the model's name: the `model` option of
`openAiCompatible()`, `openAiResponses()` and `anthropic()`, and for `gemini()` the name after
`/models/` in its URL.
A gateway URL without `/models/` gives the host instead, so two Gemini models behind the same host
share one entry. With `askWithFiles`, name each model with the `id` option of its adapter;
`askGemini` has no such option.

`turns` counts the chat requests of both models, part reads not included. `finishReason` and
`lastUsage` are those of the last chat request that reported them: the answer, unless the
explorer's prompt was blocked.

## The budget, token scale and pages

Both models get the same conversation and the same tool results, so a question is planned for
what both can take. What a pair changes:

- **The smaller window.** The budget of the question, for both models, is no larger than the
  smaller `contextTokens` and `maxRequestBytes` that either adapter declares. With `askGemini`,
  whose models declare neither, set the smaller window in the library's `budget`.
- **The larger token scale.** The budget is divided by the larger `tokenScale` of the two, so a
  Claude model (1.35 by default) on either side plans the documents for a smaller window. The
  count each provider reports is read by the scale of the model that reported it, and a whole-file
  read is priced, against `limits.inputTokens`, in the explorer's tokens.
- **Pages only when both can take them.** `view_pages` is offered only when both adapters can be
  sent a file (`openAiCompatible()` only with `pdfInput: true`, `openAiResponses()` only with
  `toolFilePlacement`). Pages stay in the request until
  the answer, so a page is counted with the larger `pageTokens` of the two.
- **No stand-ins with Claude on either side.** When room runs short, older tool results are
  replaced by short stand-ins only when neither model declares `appendOnly`. With Claude exploring
  or answering, nothing is replaced, for either model: when the room runs out, the question is
  answered with what it has.

The rules and what each adapter declares by default are in [Costs and limits](./costs-and-limits.md).
How the request is kept inside the budget is in [How it works](../how-it-works.md).

## What changes for your application

- **One request more.** The answer is always a request of its own, after the explorer's last turn.
  A question that one model settles in three requests takes four.
- **`text` and `onText` carry only the answer.** Without an explorer, a remark the model makes
  before a tool call ("Let me search…") is part of `text`, and is streamed. With one, the first
  text your user sees is the answer. `answered` is false when the answering model wrote no text,
  also after the second try of its answer.
- **Progress still arrives.** `onActivity` and `onStep` report the explorer's tool calls, and
  `steps` and `evidence` list them, as they do for one model. `onActivity` says "Writing the
  answer…" when the answer is asked for. See [Web app](./web-app.md) for sending them over SSE.
- **The explorer's requests are not streamed** by `gemini()`, `openAiCompatible()` and
  `openAiResponses()`: nothing it writes is shown, so each reply comes in one piece. `anthropic()`
  streams every request unless `stream: false`, an explorer's too, and still shows none of it. A
  reply that is not streamed comes whole at the end, so `firstByteTimeoutMs` (600 seconds by
  default) is the longest an explorer's request may take before any of it arrives; one that takes
  longer is aborted and sent again, once. Your user sees steps, not text, during that time: keep the
  connection to the browser alive ([Deployment](./deployment.md)).
- **An explorer that fails is an error.** A model name that does not exist, or a quota that is
  used up, throws the explorer's `ModelRequestError` (`GeminiRequestError` with `askGemini`), as an
  error of `model` does. The question is not passed to `model` instead: that would hide the
  mistake, and send the searching to the model you wanted to spare. `partialResultOf(error)` gives
  what was found and paid for until then. See [Errors and reliability](./errors-and-reliability.md).
- **A PDF whose text is in the prompt** and whose pages can be looked at goes to the explorer
  first: it decides whether to look. The text of such a PDF is then sent to both models, so you pay
  for it twice.
- **Follow-up questions work as with one model.** `result.toolTurns` holds the explorer's rounds as
  plain calls and results, which any model can be given. Keep them with the conversation as
  [Conversations](./conversations.md) shows.

## When an explorer is worth it

Every request of a question carries the conversation so far: the documents in the prompt, the
cards, and the tool results. With one model, each round of searching and reading is a request to
that model, each larger than the one before, and a whole-file read is one request per part, up to
`maxMapChunks` (30 by default), and more to merge their notes. With an explorer, all of those go to
the explorer, and `model` gets one request, about as large as the explorer's last.

An explorer pays off when:

- **The files are searched, not sent whole.** A question about a large log can take ten requests of
  searching and reading. The more rounds and whole-file reads, the more of the cost moves to the
  explorer.
- **The model that answers costs much more per token**, or is slow: a model that thinks long, for
  example. Its quality goes into the answer, and its price into one request.
- **The explorer is faster.** The rounds of searching are most of the requests of a question about
  a large file, and they run one after another.

It does not, or it costs more, when:

- **The documents fit whole.** With no searchable document and no pages to look at, the explorer
  is not called: it changes nothing.
- **Questions end after a search or two.** With one model, two rounds and the answer are three
  requests. With an explorer, they are three requests to the explorer (two rounds and `DONE`) and
  one more to `model`, as large as the last: the saving is small, and the answer comes later.
- **The explorer misses what the answer needs.** The answering model cannot search again. An
  explorer that stops early, or reads the wrong lines, gives an answer from less than the stronger
  model would have found alone.
- **The two windows differ much.** The question runs inside the smaller one, for both models.

Try a pair on your own files and questions: `result.usage.byModel` shows what each model cost, and
`result.evidence` what was read. Live checks of explorer pairs on the Gemini API and Vertex AI,
with how each model behaved, are in [Measurements](../measurements.md).

## Related

- [Costs and limits](./costs-and-limits.md): `limits`, the budget per model, usage totals.
- [Gemini and Vertex AI](./vertex-and-gemini.md), [OpenAI-compatible endpoints](./openai-compatible.md), [Claude](./anthropic.md): setting up each adapter.
- [PDFs](./pdfs.md): `view_pages` and where pages go.
- [How it works](../how-it-works.md): the tool loop end to end.
- [Ask reference](../reference/ask.md): `askWithFiles`, `AskOptions`, `AskLimits`, `AskResult`, `EXPLORER_INSTRUCTION`, `FINAL_ANSWER_*`.
- [Gemini reference](../reference/gemini.md): `askGemini`, `explorerGenerationConfig`, `geminiApi()`, `vertexAi()`, `gemini()`.
