# The tool loop and the adapter contract

This is the reference for the part of `llm-large-files` that asks the questions: `askWithFiles`,
its options, limits and result, the conversation it takes, the contract a model adapter
implements, usage totals and evidence. It is for you if you call `askWithFiles`, write or wrap an
adapter, or run a tool loop of your own. Sections link to the guide that explains the task, where
there is one.

```ts
import {
  askWithFiles, partialResultOf, DocumentsNotFoundError, UsageMeter,
  evidenceOf, mergeRanges, stubResult,
  EXPLORER_INSTRUCTION, FINAL_ANSWER_REQUEST, FINAL_ANSWER_AFTER_PAGES, FINAL_ANSWER_WITHOUT_TOOLS,
} from "llm-large-files";
import type {
  AskOptions, AskLimits, AskResult,
  ChatMessage, ChatTurn, ToolTurn,
  ModelAdapter, ModelCapabilities, ModelRequest, ModelMessage, ModelTextMessage, ModelToolRound,
  ModelPart, ToolCall, ToolAnswer, SendHooks, ModelReply, GenerateText, GenerateUsage,
  ModelUsage, UsageTotals, Evidence, NumberRange,
} from "llm-large-files";
```

`llm-large-files/gemini` re-exports `DocumentsNotFoundError`, `partialResultOf`, `ChatTurn` and the
four message constants. They are the same values, documented here.

Contents:

- **The question:** [`askWithFiles(options)`](#askwithfilesoptions), [`AskOptions`](#askoptions),
  [`AskLimits`](#asklimits), [`AskResult`](#askresult),
  [`partialResultOf(error)`](#partialresultoferror),
  [`DocumentsNotFoundError`](#documentsnotfounderror)
- **What the loop adds to its requests:** [`EXPLORER_INSTRUCTION`](#explorer_instruction),
  [`FINAL_ANSWER_REQUEST`](#final_answer_request),
  [`FINAL_ANSWER_AFTER_PAGES`](#final_answer_after_pages),
  [`FINAL_ANSWER_WITHOUT_TOOLS`](#final_answer_without_tools)
- **The conversation:** [`ChatMessage`](#chatmessage), [`ChatTurn`](#chatturn),
  [`ToolTurn`](#toolturn)
- **The adapter contract:** [`ModelAdapter`](#modeladapter),
  [`ModelCapabilities`](#modelcapabilities), [`ModelRequest`](#modelrequest),
  [`ModelMessage`](#modelmessage), [`ModelTextMessage`](#modeltextmessage),
  [`ModelToolRound`](#modeltoolround), [`ModelPart`](#modelpart), [`ToolCall`](#toolcall),
  [`ToolAnswer`](#toolanswer), [`SendHooks`](#sendhooks), [`ModelReply`](#modelreply),
  [`GenerateText`](#generatetext), [`GenerateUsage`](#generateusage)
- **Usage:** [`ModelUsage`](#modelusage), [`UsageTotals`](#usagetotals),
  [`UsageMeter`](#usagemeter)
- **Evidence and ranges:** [`Evidence`](#evidence), [`NumberRange`](#numberrange),
  [`evidenceOf(call, result)`](#evidenceofcall-result), [`mergeRanges(ranges)`](#mergerangesranges),
  [`stubResult(call, result, hadFiles?)`](#stubresultcall-result-hadfiles)

The rest of the main entry is on three other pages: [library and documents](./library.md)
(`createLargeFiles`, the budget, stores, extractors, document types), [errors and
retries](./errors-and-retries.md) (`ModelRequestError` and its kinds, `withRetry`, timeouts,
`parseSseJson`) and [tools](./tools.md) (each tool the model sees, `TOOL_NAMES`, `ToolResult`,
`ToolFile`, `ToolDeclaration`).

## The question

### askWithFiles(options)

```ts
declare function askWithFiles(options: AskOptions): Promise<AskResult>;
```

Answers the last user message of `options.messages` from the documents `options.documentIds`,
with any model that has an adapter. Documents that fit go into the prompt whole; the others are
shown as a card, and the model reaches them through tools. The loop runs the model's tool calls
within `limits` and ends with a request that must be answered in text, so a question ends with an
answer or with `answered: false`.

What it does, in order:

1. **Fits the budget to the models.** It takes the library's budget, with the fields of
   `options.budget` in place of its own, and fits it to what the adapters declare:
   `contextTokens`, `maxRequestBytes`, `tokenScale`, `outputTokens` (see
   [`ModelCapabilities`](#modelcapabilities)). `result.budget` is the outcome.
2. **Plans the documents** with `files.prepare`, for the room the conversation leaves. A document
   that is missing throws `DocumentsNotFoundError` before any model request.
3. **Sends one request without tools** to `model` when every document went in whole and no PDF
   can be looked at, and returns its reply.
4. **Otherwise runs tool rounds.** The model that explores (`explorer`, or `model` without one)
   gets the tools. Of each turn's calls, the loop runs at most `limits.callsPerTurn`, up to four
   at a time, each result fitted to the room left in the request, and sends the results back.
   Tools run in at most `limits.toolTurns - 1` model turns.
5. **Ends with the answer.** A reply with text and no tool call is the answer, when there is no
   explorer. Otherwise (out of turns, room or `limits`, a reply with no text, an explorer that is
   done) `model` gets one more request: the tools listed, `toolChoice: "none"`, and one of the
   [`FINAL_ANSWER_*`](#final_answer_request) lines as a user turn at the end.

A request that fails is sent again by the rule of `retry` (see
[`withRetry`](./errors-and-retries.md#withretryrun-options)), but never once text of its reply was
shown. A request the provider refuses as too large (`kind: "context_overflow"`) is made smaller and sent again: older
tool results are shortened, at most twice a question, and never when a model of the question is
`appendOnly`. When that does not mend it, and no tool call was answered and no text was shown yet,
the documents are planned again, once, for a smaller window worked out from the provider's
numbers. [How it works](../how-it-works.md#a-request-too-large-for-the-model) explains each step.

**Returns** an [`AskResult`](#askresult).

**Throws:**

| Error | When | [`partialResultOf`](#partialresultoferror) |
|---|---|---|
| `Error`: "budget.… must be a number above 0, and is …", or "budget.reservedTokens (…) must be smaller than budget.contextTokens (…)…" (the same for `mapChunkTokens`) | A field of `options.budget` is not a number above 0, or the fields cannot work together. Before any request. See [`resolveBudget`](./library.md#resolvebudgetbudget-limits). | undefined |
| `Error`: "The last message must be the user's." | `messages` is empty, or its last message is not a user turn. | undefined |
| [`DocumentStoreError`](./library.md#documentstoreerror) | The store could not be read while the documents were planned. The documents are not gone: try again. A store that fails during a tool call is not thrown: the model gets the message as the tool's `error`. | undefined |
| [`DocumentsNotFoundError`](#documentsnotfounderror) | A document of `documentIds` was never stored, has expired or been deleted, or belongs to another `owner`. Before any request. | undefined |
| [`ModelRequestError`](./errors-and-retries.md#modelrequesterror), or the adapter's subclass (`GeminiRequestError`, `OpenAiRequestError`, `AnthropicRequestError`) | A chat request failed, and was not worth another try, still failed after `retry.retries` more, asked for a longer wait than `retry.maxDelayMs`, or had already shown text. A `context_overflow` that the recovery above did not mend. | What the question had done |
| Any other error of an adapter | Thrown as it came. An error without a numeric `status` is not sent again. | What the question had done |
| The signal's reason | `signal` aborted. Nothing is sent or retried after that. The error of a request that failed as it was stopped may come instead. | What the question had done, when the reason is an object |

When the documents were planned again after an overflow and the second plan fails before it sends
anything, the first overflow error is thrown, with what the first try had done. A whole-file part
read that fails does not end the question: the tool reports it to the model.

```ts
import { GoogleAuth } from "google-auth-library";
import { askWithFiles, DocumentsNotFoundError, partialResultOf, type AskResult, type ChatMessage, type LargeFiles } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const accessToken = async () => (await auth.getAccessToken())!;
const project = process.env.GOOGLE_CLOUD_PROJECT!;

const model = gemini(vertexAi({ project, model: "gemini-3.8-flash", accessToken }));         // writes the answer
const explorer = gemini(vertexAi({ project, model: "gemini-3.5-flash-lite", accessToken })); // searches and reads

// files is your createLargeFiles(); userId, documentIds and messages are the chat being answered.
export async function answer(files: LargeFiles, userId: string, documentIds: string[], messages: ChatMessage[], signal: AbortSignal): Promise<AskResult> {
  try {
    const result = await askWithFiles({
      files, model, explorer, documentIds, messages, signal,
      owner: userId,
      limits: { toolTurns: 12, inputTokens: 2_000_000 },
      onText: (delta) => process.stdout.write(delta),
      onActivity: (status) => console.error(status),
      onStep: (line) => console.error(`Done: ${line}`),
    });
    if (!result.answered) console.error(result.blockReason ? `Declined: ${result.blockReason}` : "No answer: show your own message.");
    return result;
  } catch (error) {
    if (error instanceof DocumentsNotFoundError) console.error("Upload again:", error.ids);
    const partial = partialResultOf(error); // what the question found and paid for before it failed
    if (partial) console.error(`${partial.usage.requests} requests were answered before it failed`);
    throw error;
  }
}
```

`askGemini` (in [`llm-large-files/gemini`](./gemini.md)) is this function with Gemini models made
for you. Guides: [web app](../guides/web-app.md) (streaming, progress, cancelling),
[conversations](../guides/conversations.md), [explorer model](../guides/explorer-model.md),
[errors and reliability](../guides/errors-and-reliability.md).

### `AskOptions`

The options of `askWithFiles`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `files` | [`LargeFiles`](./library.md#largefiles) | required | The library that holds the documents, plans them and makes the tools. |
| `model` | [`ModelAdapter`](#modeladapter) | required | The model that answers. Without `explorer`, it also makes the tool calls and reads whole files in parts. |
| `explorer` | `ModelAdapter \| undefined` | none | A second model, of any provider, that makes the tool calls (search, read, look at pages) and reads whole files in parts. `model` then writes the answer from what the tools returned. Its requests get [`EXPLORER_INSTRUCTION`](#explorer_instruction), and its text is not shown. Left out, or the same object as `model`: one model does both. |
| `documentIds` | `string[]` | required | The documents this question may use. Duplicates count once. One that is missing throws [`DocumentsNotFoundError`](#documentsnotfounderror). |
| `messages` | [`ChatMessage[]`](#chatmessage) | required | The conversation, oldest first. The last message must be the user's question. The loop works on copies: your array is not changed. |
| `documentPlacement` | `"first" \| "last"` | `"first"` | Where document text and cards go. `"first"`: at the start of the first user turn, where they stay as the conversation grows, so the provider's prompt cache can reuse them on every follow-up question. `"last"`: after the text of the latest user turn; they then move on every turn and are billed in full each time. |
| `system` | `string` | none | Your system instruction. It is trimmed, and the guide to the document tools is added after it when a document is reached through tools or has pages to look at. |
| `owner` | `string` | none | The user (or tenant) asking. A document ingested with another owner is treated as missing. Without `owner`, only documents ingested without one can be used. |
| `limits` | [`AskLimits`](#asklimits) | `{}` | The limits of this question: tool turns, calls per turn, whole-file reads, ceilings on tokens and requests. |
| `retry` | [`RetryOptions`](./errors-and-retries.md#retryoptions) | `{ retries: 3, baseDelayMs: 500, maxDelayMs: 60_000 }` | How a failed model request is sent again: chat requests and whole-file part reads. `{ retries: 0 }` turns it off. |
| `budget` | `Partial<`[`Budget`](./library.md#budget)`>` | the library's | Budget fields for this question, in place of the library's. Fields given nowhere follow the context window. The budget is then fitted to the models either way: `result.budget` shows it. |
| `wholeDocumentAnalysis` | `boolean` | `true` | Offer `analyze_whole_document`, which reads a whole file in many model requests. It is offered only when the model that explores has `generateText` and a document reached through tools is small enough to be read in about `budget.maxMapChunks` parts or fewer. `false` withholds it. |
| `viewPages` | `boolean` | `true` | Offer `view_pages` for PDFs whose original file is kept (`keepOriginals`). It is offered only when no model of the question has `capabilities.toolFiles: "none"`. It changes nothing for a library that keeps no originals. |
| `onText` | `(delta: string) => void` | none | The answer's text as it arrives. The adapter streams when it is set and it can; otherwise the text of each reply comes once the reply is in: in one piece, or from `gemini()`, one piece for each text part. A remark the model wrote before a tool call comes too, and the text of a later reply then starts with `"\n\n"`. With an explorer, only the answering model's text comes. |
| `onActivity` | `(text: string) => void` | none | Short-lived status in English: each tool call as it starts ("Search app.log (exact) for “timeout”…"), "Too large to read at once: app.log. Searching instead…", the progress of a whole-file read, a retry ("The model did not answer (HTTP 503). Trying again in 2 s…"), and "Writing the answer…" before the request for the answer. |
| `onStep` | `(text: string) => void` | none | Each finished step, the same lines as `result.steps`, as they happen. |
| `signal` | `AbortSignal` | none | Stops the question: the request under way is aborted through the adapter, tool calls stop, and nothing is sent again. `askWithFiles` then throws. |

Guides: [conversations](../guides/conversations.md) (`messages`, `documentPlacement`),
[storage](../guides/storage.md) (`owner`), [web app](../guides/web-app.md) (`onText`,
`onActivity`, `onStep`, `signal`), [PDFs](../guides/pdfs.md) (`viewPages`),
[costs and limits](../guides/costs-and-limits.md) (`limits`, `budget`).

### `AskLimits`

The limits of one question: `AskOptions.limits`. Every field is optional.

| Field | Type | Default | What it does |
|---|---|---|---|
| `toolTurns` | `number` | 12 | The most model turns of the chat for one question, counting the answer and a second try after an empty or broken reply. Tools run in all but the last: if the model is still calling tools then, the last turn must be answered in text. With an explorer, the explorer has up to `toolTurns - 1` turns and `model` the last. A request the provider refused as too large takes no turn of its own: what is sent again after it is the same turn, so `result.turns` can be a little higher. Truncated to a whole number; below 1 counts as 1. With 1, no tool runs and the only request is the answer. |
| `callsPerTurn` | `number` | 8 | The most tool calls of one model turn that are run. Each call beyond it is answered with an error ("Not run: one turn runs at most 8 tool calls. Send this call again if you still need it."), and `steps` says how many were not run. Truncated to a whole number; below 1 counts as 1. |
| `wholeDocumentReads` | `number` | 1 ([`MAX_WHOLE_DOCUMENT_READS`](./tools.md#max_whole_document_reads)) | How many times each document may be read whole (`analyze_whole_document`) in one question. One read of a large file is up to `budget.maxMapChunks` part requests and a few more. 0 refuses every whole-file read but still lists the tool: to withhold it, set `wholeDocumentAnalysis: false`. |
| `inputTokens` | `number` | none | A ceiling on the input tokens of the question, over all its requests, part reads included, as the adapters report them (`usage.inputTokens`, cached tokens included). Checked before each tool request: once it is reached, no further tool request is made and the next request is the answer. The calls of the reply that reached it still run, and their results and the answer come on top. A whole-file read that would pass it is refused, with the numbers, before it starts. |
| `requests` | `number` | none | The same ceiling on model requests, chat requests and part reads together, as `usage.requests` counts them. Once `requests - 1` are used, no further tool request is made: the last request is kept for the answer. The calls of the reply that used it still run, but a whole-file read that needs more requests than are left is refused, and the reads of one turn share what is left. |

`askGemini` also takes `maxToolTurns` and `maxToolCallsPerTurn`, the names these had before 0.5.0
(see [gemini](./gemini.md)). Guide: [costs and limits](../guides/costs-and-limits.md).

### `AskResult`

What `askWithFiles` returns, and what [`partialResultOf`](#partialresultoferror) gives for a
question that failed.

| Field | Type | What it holds |
|---|---|---|
| `text` | `string` | Everything the answering model wrote, as `onText` got it: a remark made before a tool call, then `"\n\n"` and the answer. With an explorer, only what `model` wrote. `""` when nothing was written. |
| `answered` | `boolean` | True when the last reply had text that is not blank, and the provider did not refuse the prompt. False when the prompt was refused (`blockReason`), or the last reply had no text: it was cut off before any text, or the request for the answer came back empty too. `text` may then be empty, or hold a remark made before a tool call, or the start of a reply that was refused: show your own message. |
| `blockReason` | `string`, optional | Why the provider refused the prompt, in the adapter's words. Set only then. Nothing more is asked after a refusal. |
| `steps` | `string[]` | Each finished step, in order: a line for each tool call, run or refused ("Search app.log (exact) for “timeout” — 12 matching lines", or "… — already shown above"), one for the calls of a turn over `callsPerTurn`, and one when the loop shortened older results, asked again after an empty or broken reply, or planned the documents again. The lines `onStep` got. |
| `evidence` | [`Evidence[]`](#evidence) | What each tool call showed the model: the document, and the lines or pages. In call order. A call that failed, was not run, or was answered with a pointer to an earlier result adds none. |
| `toolTurns` | [`ToolTurn[]`](#toolturn) | The tool rounds of this question, as plain JSON, as the model last had them. Pass them back in `messages`, between this question and its answer, and a later question sees what was found here. Each result of a call made in this question has `tool_turns_left`, except a stand-in (`dropped: true`, see [`stubResult`](#stubresultcall-result-hadfiles)): a result shortened to make room, a pointer whose result was shortened, and the result of a call that showed pages. The pages are not kept: their stand-in says which pages were shown. A call's `problem` is left out. |
| `plan` | [`DocumentPlan`](./library.md#documentplan) | Which documents went in whole (`inline`) and which were reached through tools (`searchable`). |
| `budget` | [`Budget`](./library.md#budget) | The budget the question ran with: the library's (with `options.budget`), fitted to the models. |
| `turns` | `number` | Chat requests of the question, the explorer's among them; whole-file part reads are not counted. A request counts when it is sent, so one that failed counts too. One sent again after a failure counts once; one sent again smaller after an overflow counts again. |
| `finishReason` | `string`, optional | The provider's own word for why the last reply that gave one ended (`"STOP"`, `"length"`, `"end_turn"`). |
| `usage` | [`UsageTotals`](#usagetotals) | Tokens and requests of the whole question, whole-file part reads included, in all and for each model by its `id`. |
| `lastUsage` | `Record<string, unknown>`, optional | The provider's own usage object of the last chat reply that had one, as it came. |

Guides: [conversations](../guides/conversations.md) (`toolTurns`),
[costs and limits](../guides/costs-and-limits.md) (`usage`),
[errors and reliability](../guides/errors-and-reliability.md) (`answered`, `blockReason`).

### partialResultOf(error)

```ts
declare function partialResultOf(error: unknown): AskResult | undefined;
```

What a question that failed had done before it failed. `askWithFiles` throws the error as it came;
this gives, for that error object, an [`AskResult`](#askresult) with `answered: false` and the
`steps`, `evidence`, `toolTurns`, `usage`, `turns`, `plan` and `budget` of the question until
then. Keep its `toolTurns` with the conversation and count its `usage`: those requests were paid
for. It returns `undefined` for an error that did not come from a question under way (a missing
document, a budget that cannot work, a store that could not be read while planning) and for a
value that is not an object. The sample under [`askWithFiles`](#askwithfilesoptions) uses it.

Guide: [errors and reliability](../guides/errors-and-reliability.md).

### `DocumentsNotFoundError`

```ts
declare class DocumentsNotFoundError extends Error {
  constructor(ids: string[]);
  readonly ids: string[];
}
```

Thrown by `askWithFiles` (and `askGemini`) before any model request, when documents of
`documentIds` were never stored, have expired or been deleted, or belong to another owner. `ids`
lists them. `name` is `"DocumentsNotFoundError"`. The message names the IDs, not the files: "A
document is no longer available: ‹id›. Upload it again.", or for several "3 documents are no longer
available: ‹id›, ‹id›, ‹id›. Upload them again."

Guide: [errors and reliability](../guides/errors-and-reliability.md).

## What the loop adds to its requests

Each is a `string`. The loop adds them itself. They are exported so that you can recognise them in
a request, or use them in a loop of your own.

### `EXPLORER_INSTRUCTION`

Added after the system instruction of every request of an explorer model:

> You only gather material in this conversation: another model writes the answer. It sees this
> conversation and what your tool calls returned, not what you thought or wrote. So call the tools
> until their results hold everything the answer needs from the files. Then, or at once if no tool
> is needed, reply with the single word DONE instead of an answer.

Guide: [explorer model](../guides/explorer-model.md).

### `FINAL_ANSWER_REQUEST`

The user turn at the end of the request for the answer, when a document is reached through tools
and tool calls were answered:

> Stop using tools now. Answer my question using only what the tools returned above, with line
> citations. Say plainly what you could not find.

### `FINAL_ANSWER_AFTER_PAGES`

The same, when every document went in whole and the only tool was `view_pages`:

> Stop using tools now. Answer my question from the text of the files and the pages you looked at.
> Say plainly what you could not see or find.

### `FINAL_ANSWER_WITHOUT_TOOLS`

The same, when no tool call was answered in the question (an explorer called none, the first reply
was empty, or no turn was left for tools), so there is no tool result to answer from:

> Answer my question now, from what is in this conversation. No tools are available for this reply:
> if the answer needs a part of a file that is not shown here, say so plainly.

None of the three is kept in the conversation or in `toolTurns`.

## The conversation

### `ChatMessage`

```ts
type ChatMessage = ChatTurn | ToolTurn | ModelTextMessage;
```

What `askWithFiles` takes as `messages`: plain turns ([`ChatTurn`](#chatturn)), the tool rounds an
earlier question returned ([`ToolTurn`](#toolturn), from `result.toolTurns`), and turns with parts
in a provider's own form ([`ModelTextMessage`](#modeltextmessage), such as
`{ role: "user", parts: [{ text }, { native: anImagePart }] }`). The last must be a user turn.
Declare the array as `ChatMessage[]`: without it, TypeScript widens `role` to `string`.

```ts
import type { ChatMessage } from "llm-large-files";

// first is the AskResult of the first question of this chat.
const messages: ChatMessage[] = [
  { role: "user", text: "Why did the nightly import fail?" },
  ...first.toolTurns, // between the question and its answer
  { role: "assistant", text: first.text },
  { role: "user", text: "And how long did recovery take?" },
];
```

The adapter entries convert histories kept in a provider's form: `fromGeminiContents`
([gemini](./gemini.md)), `fromOpenAiMessages` ([openai](./openai.md), which also returns the
system message) and `fromAnthropicMessages` ([anthropic](./anthropic.md)).
Guide: [conversations](../guides/conversations.md).

### `ChatTurn`

```ts
type ChatTurn = { role: "user" | "assistant" | "model"; text: string };
```

A plain turn of the user or of the model. `"model"` is taken as `"assistant"`.

### `ToolTurn`

```ts
type ToolTurn = { role: "tools"; calls: Array<ToolCall & { result: ToolResult }> };
```

One round of tool use as an application stores it: the calls of one model turn, each with what the
tool returned ([`ToolResult`](./tools.md#toolresult)), in call order. Plain JSON that belongs to no
provider. `askWithFiles` returns them in `result.toolTurns`; passed back in `messages`, the model
sees in a later question what its tools returned in an earlier one. A call whose result is still in
the conversation in full is then not run again: it is answered with a pointer
(`already_shown: true`). Guide: [conversations](../guides/conversations.md).

## The adapter contract

An adapter turns the loop's neutral request into a provider's, sends it, and reads the reply back.
Everything else (planning, tools, limits, retries, usage, the request for the answer) is the
loop's, once, for every provider. The built-in adapters are `gemini()` ([gemini](./gemini.md)),
`openAiCompatible()` ([openai](./openai.md)) and `anthropic()` ([anthropic](./anthropic.md)).

### `ModelAdapter`

```ts
interface ModelAdapter {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  estimateTokens?(text: string): number;
  send(request: ModelRequest, hooks?: SendHooks): Promise<ModelReply>;
  requestBytes?(request: ModelRequest): number;
  generateText?: GenerateText;
}
```

A model provider, as the tool loop sees it.

| Member | Required | What it is |
|---|---|---|
| `id` | yes | Names the model in `usage.byModel`, such as `"gemini-3.8-flash"`. Give the two models of a question different IDs to tell them apart there: requests of the same `id` are summed together. |
| `capabilities` | yes | What the model can take: see [`ModelCapabilities`](#modelcapabilities). |
| `send(request, hooks?)` | yes | One chat request. Returns a [`ModelReply`](#modelreply). Throw a [`ModelRequestError`](./errors-and-retries.md#modelrequesterror) for an HTTP error, with status 0 for a connection that failed. The loop reads `status`, `kind`, `retryAfterMs`, `limitTokens` and `requestedTokens` from the error, and sends again the ones worth it. |
| `requestBytes?(request)` | no | The size in bytes of the body `send` would post for `request`. The loop calls it before it shows the pages of a PDF in a turn, with the turn whose calls are being run as a round with no `answers` yet. With it the room for the pages is exact; without it, it is estimated. |
| `generateText` | no | A plain completion for the parts of a whole-file read: see [`GenerateText`](#generatetext). The one of the model that explores is used. Without it, `analyze_whole_document` is not offered. |
| `estimateTokens?(text)` | no | Declared for an adapter's own count of tokens. `askWithFiles` does not call it in 0.6.0: it sizes requests with the library's `estimateTokens`, scaled by `tokenScale`. |

What `send` must do with the request:

- **A tool round with `raw`** is sent back as `raw`, unchanged: the loop sets it only on rounds
  that this adapter returned. **Without `raw`** (a stored round, or one an explorer of another
  adapter made), build the model turn from `calls`.
- **The results** of a round go in call order, each with its call's `id`. The files of an answer
  (the pages of `view_pages`) go where `capabilities.toolFiles` says.
- **`toolChoice: "none"`** means the model must answer in text. The tools are still in `tools`.
- **Text:** call `hooks.onText` as text arrives when it is given; return the whole text in
  `reply.text` either way, starting with what was streamed. Pass `hooks.signal` to the request.
- **A call whose arguments could not be read** is returned with `problem`: the loop answers it with
  that message and does not run it.

```ts
import { ModelRequestError, retryAfterMs, type ModelAdapter, type ModelReply, type ModelRequest } from "llm-large-files";

// toProviderBody and fromProviderBody are your own: the neutral request in your provider's form,
// and your provider's response as a ModelReply.
declare function toProviderBody(request: ModelRequest): unknown;
declare function fromProviderBody(body: unknown): ModelReply;

const model: ModelAdapter = {
  id: "my-model",
  capabilities: { contextTokens: 128_000, toolFiles: "none", pageTokens: 0 },
  async send(request, hooks = {}) {
    let response: Response;
    try {
      response = await fetch(process.env.MODEL_URL!, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MODEL_API_KEY}` },
        body: JSON.stringify(toProviderBody(request)),
        signal: hooks.signal ?? null,
      });
    } catch (cause) {
      if (hooks.signal?.aborted) throw cause;
      throw new ModelRequestError("The model could not be reached.", 0, { cause });
    }
    if (!response.ok) {
      const message = (await response.text()) || `The model returned HTTP ${response.status}.`;
      throw new ModelRequestError(message, response.status, { retryAfterMs: retryAfterMs(response.headers) });
    }
    const reply = fromProviderBody(await response.json());
    if (reply.text) hooks.onText?.(reply.text); // no streaming here: the whole text at once
    return reply;
  },
};
```

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md), and
[testing](../guides/testing.md) for an adapter that answers from a script.

### `ModelCapabilities`

What a model can take, as far as its adapter knows. What each built-in adapter declares is on its
reference page.

| Field | Type | Default | What it does |
|---|---|---|---|
| `contextTokens` | `number` | none | The context window, in the model's tokens. The window of a question is the smallest of the library's `budget.contextTokens` and those its models declare. |
| `maxRequestBytes` | `number` | none | The largest request body, in bytes. A question's `budget.maxRequestBytes` is the smallest of the library's and those its models declare. |
| `toolFiles` | `"inside" \| "beside" \| "none"` | required | Where `send` puts a file that a tool returned (the pages of `view_pages`): `"inside"` the tool result, `"beside"` it in a user turn of its own, or `"none"` for a model that cannot be sent one. When any model of the question says `"none"`, `view_pages` is not offered. |
| `pageTokens` | `number` | required | About what the model bills for one PDF page it is shown, in its tokens. The question counts the largest of its models': the pages of a question may take up to half of `budget.reservedTokens`. |
| `tokenScale` | `number` | 1 | How many of this model's tokens one token of the library's estimate (`estimateTokens`, fitted to Gemini) comes to. A model that counts a third more for the same text says 1.33, and its window is that much smaller in the library's tokens. The question uses the largest of its models'. A value that is not above 0 counts as 1. |
| `outputTokens` | `number` | none | Tokens set aside for the reply, when they come out of the same window as the prompt (Claude's `max_tokens`). The largest of the models' is kept free, but at least a quarter of the window is left for the prompt. |
| `appendOnly` | `boolean` | `false` | True for a model whose earlier turns may not be rewritten (Claude ties its thinking blocks to the turns they were written in). When any model of the question says so, old tool results are not shortened to make room: when the room runs out, the question is answered with what it has, and an overflow is mended only by planning the documents again. When the model that explores is append-only, a note the loop adds after an empty or broken reply stays in its conversation for the rest of the question. |

With an explorer, every field counts for the pair: the budget is planned for the smaller window
and the larger scale, because both models get the same conversation. Guides:
[explorer model](../guides/explorer-model.md), [costs and limits](../guides/costs-and-limits.md).

### `ModelRequest`

```ts
type ModelRequest = {
  system: string;
  messages: ModelMessage[];
  tools?: ToolDeclaration[];
  toolChoice?: "auto" | "none";
};
```

| Field | What it holds |
|---|---|
| `system` | The system instruction: `options.system`, then the guide to the document tools, and for an explorer [`EXPLORER_INSTRUCTION`](#explorer_instruction) after them. May be empty. |
| `messages` | The conversation, oldest first. The last message is a user turn or a tool round. |
| `tools` | The tools on offer ([`ToolDeclaration`](./tools.md#tooldeclaration)). Left out of a request that needs none: every document went in whole and no page can be looked at. |
| `toolChoice` | `"auto"` for the requests that may call tools. `"none"` for the request for the answer: the model must answer in text, and the tools are still listed, for a provider that wants them declared next to the calls already in the conversation. Left out when `tools` is. |

### `ModelMessage`

```ts
type ModelMessage = ModelTextMessage | ModelToolRound;
```

One message of a [`ModelRequest`](#modelrequest): a turn of text, or a round of tool use.

### `ModelTextMessage`

```ts
type ModelTextMessage = { role: "user" | "assistant"; parts: ModelPart[] };
```

A turn of the user or of the model, as text and native parts. It is also a
[`ChatMessage`](#chatmessage): pass one in `messages` to send parts in the provider's own form.

### `ModelToolRound`

```ts
type ModelToolRound = { role: "tools"; calls: ToolCall[]; answers: ToolAnswer[]; raw?: unknown };
```

| Field | What it holds |
|---|---|
| `role` | `"tools"`. |
| `calls` | The calls of one model turn, in order ([`ToolCall`](#toolcall)). |
| `answers` | Each call with what the tool returned, in call order ([`ToolAnswer`](#toolanswer)). Empty for a model turn that has not been answered yet, as `requestBytes` may get it. |
| `raw` | That model turn in its provider's own form. Set only for the adapter that returned it, which sends it back unchanged (Gemini wants its thought signatures, Claude its thinking blocks). Without it, the turn is built from `calls`. |

### `ModelPart`

```ts
type ModelPart = { text: string; native?: undefined } | { native: unknown; text?: string };
```

One piece of a message: plain text, or something in the provider's own form (an image, an inline
PDF) that only its adapter reads. A native part may carry the text it holds in `text`: the loop
then sizes it by that text; otherwise by the size of its JSON. Each built-in adapter passes a native
part on to its provider as it is, and the loop sends it to every model of the question, so with an
explorer of another provider, that model gets it too.

### `ToolCall`

```ts
type ToolCall = { id?: string; name: string; args: Record<string, unknown>; problem?: string };
```

| Field | What it holds |
|---|---|
| `id` | The provider's own ID of the call, where it gives one. |
| `name` | The tool's name: see [tools](./tools.md). |
| `args` | The arguments, as an object. |
| `problem` | Why the call cannot be run as it came: its arguments were not JSON, or it was cut off. The loop answers it with `{ error: problem }`, does not run it, and the model can send it again. |

### `ToolAnswer`

```ts
type ToolAnswer = { call: ToolCall; result: ToolResult; files?: ToolFile[] };
```

A tool call with what the tool returned for it: its JSON result
([`ToolResult`](./tools.md#toolresult)) and the files that belong to it
([`ToolFile`](./tools.md#toolfile)), such as the pages of `view_pages`. Each result the loop adds in
a question has `tool_turns_left`, the tool turns left at that point. A stand-in that later replaces
it (`dropped: true`) does not.

### `SendHooks`

```ts
type SendHooks = { onText?: (delta: string) => void; signal?: AbortSignal };
```

| Field | What it holds |
|---|---|
| `onText` | Called with the reply's text as it arrives. The loop gives it only for a reply that is shown (never an explorer's) and only when the application gave `onText`. An adapter streams when it is given and it can; one that does not stream calls it once the reply is in: `openAiCompatible()` and `anthropic()` once with the whole text, `gemini()` once for each text part. The text is in `reply.text` either way, and the loop passes on what the adapter did not. The deltas must add up to the start of `reply.text`: the loop passes on the rest of `reply.text` only when it starts with what was streamed, and `result.text` is what was passed on. |
| `signal` | The question's signal. Pass it to the request. |

### `ModelReply`

```ts
type ModelReply = {
  text: string;
  calls: ToolCall[];
  raw?: unknown;
  finishReason?: string;
  finish?: "complete" | "cut" | "filtered" | "malformed_call";
  blockReason?: string;
  usage?: Partial<ModelUsage>;
  providerUsage?: Record<string, unknown>;
};
```

| Field | What it holds |
|---|---|
| `text` | What the model wrote for the user in this reply. Thoughts are not part of it. |
| `calls` | The tool calls of this reply, in order. `[]` when there are none. |
| `raw` | This turn in the provider's own form, to be sent back unchanged with the tool results. The loop gives it back only to this adapter. |
| `finishReason` | Why the reply ended, in the provider's own word (`"STOP"`, `"length"`, `"end_turn"`). It becomes `result.finishReason`. |
| `finish` | How the reply ended, in terms every adapter maps its own to: `"complete"`; `"cut"` at the output limit; `"filtered"` by the provider's safety filters; `"malformed_call"`, a tool call the model tried to make that could not be read (Gemini's `MALFORMED_FUNCTION_CALL`). Unset when the adapter does not know. The loop asks once more, with a note, after a reply with no calls that is `"malformed_call"`, or that is empty before any tool ran and is neither `"cut"` nor `"filtered"`: at most twice a question, only while a tool turn is left before the answer, and not for a reply with `blockReason` or once `limits.inputTokens` or `limits.requests` is reached. |
| `blockReason` | Why the provider refused the prompt, when it did. A reply with `blockReason` and no calls ends the question: no request for the answer follows, and the result has `answered: false` and this `blockReason`. |
| `usage` | The tokens of this request ([`ModelUsage`](#modelusage)), as far as the provider says. `inputTokens` must count every token of the prompt, cached ones included, and `outputTokens` the thoughts. The loop adds it to `result.usage`, and uses `inputTokens` to correct its own estimate of the request's size. |
| `providerUsage` | The provider's own usage object, as it came. It becomes `result.lastUsage`. |

### `GenerateText`

```ts
type GenerateText = (request: {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  onTruncated?: () => void;
  onUsage?: (usage: GenerateUsage) => void;
}) => Promise<string>;
```

A plain text completion, for the parts of a whole-file read (`analyze_whole_document`). The
library stays provider-neutral by taking it as a function: `ModelAdapter.generateText`, or the
`generate` option of `files.tools()` in a loop of your own. It returns the text of the reply.

| Field | What it holds |
|---|---|
| `system` | The system instruction of the part read. |
| `prompt` | The part of the file and the task. |
| `maxOutputTokens` | The most tokens the reply may have. Send it as the provider's output limit. |
| `signal` | Stops the read. Pass it to the request. |
| `onTruncated` | Optional to call. Call it when the model stopped because it reached `maxOutputTokens`, so the read can say its result is incomplete. |
| `onUsage` | Optional to call. Call it once for every request that was answered, with the tokens it used. In `askWithFiles`, a call of `generateText` that never calls it is counted as one request with no tokens. |

Throw a `ModelRequestError` for a request that failed, as `send` does: the part is sent again by
the rule of `retry`, and an error without a status is tried once more. Guide:
[your own adapter and loop](../guides/own-adapter-and-loop.md).

### `GenerateUsage`

```ts
type GenerateUsage = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; thoughtTokens?: number };
```

The tokens one part-read request used, as far as the provider said, for `onUsage`. The fields mean
what they mean in [`ModelUsage`](#modelusage).

## Usage

### `ModelUsage`

```ts
type ModelUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; thoughtTokens: number };
```

Tokens of one request, or summed over several.

| Field | What it holds |
|---|---|
| `inputTokens` | Every token of the prompt, those read from a cache included. |
| `cachedInputTokens` | The part of `inputTokens` that was read from the provider's prompt cache. |
| `outputTokens` | Every token the model produced, thoughts included. |
| `thoughtTokens` | The part of `outputTokens` that went on thinking, where the provider says. |

### `UsageTotals`

```ts
type UsageTotals = ModelUsage & {
  requests: number;
  byModel: Record<string, ModelUsage & { requests: number }>;
};
```

The usage of one question (`result.usage`): every request it made, whole-file part reads included,
in all and by model.

| Field | What it holds |
|---|---|
| `inputTokens`, `cachedInputTokens`, `outputTokens`, `thoughtTokens` | The sums over every request, as in [`ModelUsage`](#modelusage). |
| `requests` | Requests that were answered. One that failed and was sent again counts once; one that failed in the end does not count. |
| `byModel` | The same totals for each model, keyed by the adapter's `id`. |

Guide: [costs and limits](../guides/costs-and-limits.md).

### `UsageMeter`

```ts
declare class UsageMeter {
  readonly totals: UsageTotals;
  add(model: string, usage: Partial<ModelUsage> | undefined): void;
}
```

Sums the usage of the requests of one question: `askWithFiles` uses one, and you can use one in a
loop of your own. `totals` starts at zero, with an empty `byModel`. `add` counts one request in
`totals` and in `totals.byModel[model]`, and adds each field of `usage` that is a finite number
above 0. With `usage` undefined it counts the request and no tokens.

```ts
import { UsageMeter } from "llm-large-files";

const meter = new UsageMeter();
meter.add("gemini-3.8-flash", { inputTokens: 12_000, cachedInputTokens: 8_000, outputTokens: 450 });
meter.add("gemini-3.5-flash-lite", undefined); // a request that reported no usage still counts
console.log(meter.totals);
// { requests: 2, inputTokens: 12000, cachedInputTokens: 8000, outputTokens: 450, thoughtTokens: 0,
//   byModel: { "gemini-3.8-flash": { requests: 1, … }, "gemini-3.5-flash-lite": { requests: 1, inputTokens: 0, … } } }
```

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).

## Evidence and ranges

### `Evidence`

```ts
type Evidence = {
  tool: string;
  documentId: string;
  document?: string;
  lines?: NumberRange[];
  pages?: NumberRange[];
  query?: string;
  mode?: string;
  totalMatchingLines?: number;
  whole?: boolean;
};
```

What one tool call showed the model of one document: `result.evidence` holds one for each call
that showed something.

| Field | What it holds |
|---|---|
| `tool` | The tool that was called: `"search_document"`, `"read_document"`, `"get_document_overview"`, `"analyze_whole_document"`, `"view_pages"`. |
| `documentId` | The document's ID. |
| `document` | The file's name, when the result gave it. |
| `lines` | The lines the model was shown, merged and in order. A read: its lines. A search: its passages, or each matching line with the lines of context around it. An overview: the first 30 and the last 20 lines (all of them in a file of 30 lines or fewer). |
| `pages` | The pages it looked at (`view_pages`), or the pages those lines are on, where the tool said. |
| `query` | What was searched for, or the task of a whole-file read. |
| `mode` | `"keywords"`, `"exact"` or `"regex"`, for a search. |
| `totalMatchingLines` | For an exact or regex search: how many lines match in the whole file, often more than were shown. |
| `whole` | True for a whole-file read: other model requests read every line, and the model saw their answer. It has no `lines`. |

```ts
import { mergeRanges, type AskResult, type NumberRange } from "llm-large-files";

// The lines each document showed in a question: a "Sources" list under the answer.
function sources(result: AskResult): string[] {
  const shown = new Map<string, { name: string; lines: NumberRange[] }>();
  for (const entry of result.evidence) {
    const document = shown.get(entry.documentId) ?? { name: entry.document ?? entry.documentId, lines: [] };
    document.lines.push(...(entry.lines ?? []));
    shown.set(entry.documentId, document);
  }
  return [...shown.values()]
    .filter(({ lines }) => lines.length > 0)
    .map(({ name, lines }) => `${name}: lines ${mergeRanges(lines).map(([from, to]) => (to > from ? `${from}-${to}` : `${from}`)).join(", ")}`);
}
```

### `NumberRange`

```ts
type NumberRange = [from: number, to: number];
```

A range of lines or pages, 1-based, both ends included: `[12, 14]` is 12, 13 and 14.

### evidenceOf(call, result)

```ts
declare function evidenceOf(call: ToolCall, result: ToolResult): Evidence | undefined;
```

What a tool call showed of a document, read from the call and its result, as `askWithFiles` builds
`result.evidence`. Use it in a loop of your own. It returns `undefined` when the call's
`document_id` is missing, empty or not a string, the result is an error (`error`), or the result is
a stand-in for a dropped one (`dropped: true`).

```ts
import { evidenceOf, mergeRanges } from "llm-large-files";

evidenceOf(
  { name: "read_document", args: { document_id: "d1", start_line: 120, end_line: 180 } },
  { document: "app.log", lines: "120-180", total_lines: 50_000, text: "…" },
);
// { tool: "read_document", documentId: "d1", document: "app.log", lines: [[120, 180]] }

mergeRanges([[40, 52], [1, 30], [31, 35], [50, 60]]);
// [[1, 35], [40, 60]]
```

### mergeRanges(ranges)

```ts
declare function mergeRanges(ranges: NumberRange[]): NumberRange[];
```

The ranges in order, with those that overlap or touch made one: `[1, 30]` and `[31, 35]` become
`[1, 35]`. It returns a new array and leaves `ranges` as it was. The sample above shows it.

### stubResult(call, result, hadFiles?)

```ts
declare function stubResult(call: ToolCall, result: ToolResult, hadFiles?: boolean): ToolResult | undefined;
```

A short stand-in for a tool result that is dropped from the request to make room. It keeps the
document's name, says which lines or pages the result showed so that the model can get them again,
and has `dropped: true` and a `note` that says it is a stand-in. `askWithFiles` uses it to shorten
older tool results, and for the pages in `result.toolTurns`. Set `hadFiles` (default `false`) for a
result whose files (pages) are dropped with it, however small its JSON is.

It returns `undefined` when there is nothing to gain: the result is an error, is already a
stand-in, or (without `hadFiles`) its JSON is under 700 characters. Otherwise, by tool:

| Tool | The stand-in keeps |
|---|---|
| `read_document` | `lines`, `total_lines` |
| `search_document` | `mode`, `query` (its first 200 characters), `total_matching_lines`, `lines_shown` (up to 60 ranges, such as `"120-180"`) |
| `analyze_whole_document` | `parts_read`, and the first 6,000 characters of `answer`, followed by "…" when it was longer: the answer cannot be asked for again |
| `view_pages` | `pages`, `total_pages` |
| `get_document_overview`, any other | nothing more than `document` and the note |

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).
