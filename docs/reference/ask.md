# The tool loop and the adapter contract

This is the reference for the part of `llm-large-files` that asks the questions: `askWithFiles`
and `askStream`, their options, limits and result, the conversation they take, the contract a model
adapter implements, usage totals and evidence. It is for you if you call `askWithFiles`, write or
wrap an adapter, or run a tool loop of your own. Sections link to the guide that explains the
task, where there is one.

```ts
import {
  askWithFiles, askStream, partialResultOf, DocumentsNotFoundError, UsageMeter, TOOL_TURN_VERSION,
  evidenceOf, mergeRanges, stubResult, compactToolTurns, DEFAULT_INPUT_TOKENS, answerInfoOf, checkCitations,
  hideCitations, CitationHider,
  EXPLORER_INSTRUCTION, FINAL_ANSWER_REQUEST, FINAL_ANSWER_AFTER_PAGES, FINAL_ANSWER_WITHOUT_TOOLS,
  createQuestionRegistry, QUESTION_ID_PATTERN, QuestionConflictError,
} from "llm-large-files";
import type {
  AskOptions, AskLimits, AskResult, MissingDocumentsAction, MissingDocumentsContext,
  ToolResultContext, ToolResultVerdict, CitationCheck, LineCitation, AnswerInfo,
  QuestionAskOptions, QuestionRegistry, QuestionRegistryOptions, QuestionRegistryStats,
  ChatMessage, ChatTurn, ToolTurn,
  ModelAdapter, ModelCapabilities, ModelRequest, ModelMessage, ModelTextMessage, ModelToolRound,
  ModelPart, ToolCall, ToolAnswer, SendHooks, ModelReply, GenerateText, GenerateUsage,
  ToolFileType, DocumentsCapability, NativeDocumentFormat,
  ModelUsage, UsageTotals, Evidence, NumberRange, AskEvent, EventStream,
} from "llm-large-files";
```

`llm-large-files/gemini` re-exports `DocumentsNotFoundError`, `partialResultOf`, `ChatTurn` and the
four message constants. They are the same values, documented here.

Contents:

- **The question:** [`askWithFiles(options)`](#askwithfilesoptions),
  [`askStream(options)`](#askstreamoptions), [`AskOptions`](#askoptions),
  [`AskLimits`](#asklimits), [`AskResult`](#askresult),
  [`partialResultOf(error)`](#partialresultoferror),
  [`DocumentsNotFoundError`](#documentsnotfounderror), [missing documents](#missing-documents),
  [`MissingDocumentsAction`](#missingdocumentsaction),
  [`MissingDocumentsContext`](#missingdocumentscontext),
  [`DEFAULT_INPUT_TOKENS`](#default_input_tokens),
  [`ToolResultContext` and `ToolResultVerdict`](#toolresultcontext-and-toolresultverdict),
  [`CitationCheck`](#citationcheck), [`AnswerInfo`](#answerinfo),
  [question IDs](#question-ids) (`QUESTION_ID_PATTERN`, `createQuestionRegistry`,
  `QuestionConflictError`)
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
  [`GenerateText`](#generatetext), [`GenerateUsage`](#generateusage),
  [`ToolFileType`, `DocumentsCapability` and `NativeDocumentFormat`](#toolfiletype-documentscapability-and-nativedocumentformat)
- **Usage:** [`ModelUsage`](#modelusage), [`UsageTotals`](#usagetotals),
  [`UsageMeter`](#usagemeter)
- **Evidence and ranges:** [`Evidence`](#evidence), [`NumberRange`](#numberrange),
  [`evidenceOf(call, result)`](#evidenceofcall-result), [`mergeRanges(ranges)`](#mergerangesranges),
  [`stubResult(call, result, hadFiles?)`](#stubresultcall-result-hadfiles),
  [`compactToolTurns(turns)`](#compacttoolturnsturns)

The rest of the main entry is on three other pages: [library and documents](./library.md)
(`createLargeFiles`, the budget, stores, extractors, document types), [errors and
retries](./errors-and-retries.md) (`ModelRequestError` and its kinds, `withRetry`, timeouts,
`parseSseJson`) and [tools](./tools.md) (each tool the model sees, `TOOL_NAMES`, `ToolResult`,
`ToolFile`, `ToolDeclaration`). The events of a question and of an ingest (`AskEvent`,
`IngestEvent`, `EventError`, `eventStream`) are on [events](./events.md).

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
2. **Plans the documents** with `files.prepare`, for the room the conversation leaves. Documents
   that are missing are settled by `onMissingDocuments` before any model request: by default the
   question throws `DocumentsNotFoundError` ([missing documents](#missing-documents)).
3. **Sends one request without tools** to `model` when every document went in whole, no PDF can be
   looked at, and no table sent whole gets the tools, and returns its reply. So it does when the
   tools are there only for tables sent whole and not one tool turn fits (`limits.toolTurns: 1`,
   `limits.requests: 1`, or a ceiling with room for one request): one request without the tools,
   with no notice (since 0.10.0).
4. **Otherwise runs tool rounds.** The model that explores (`explorer`, or `model` without one)
   gets the tools; `model` does when no file is searched and the tools are there for tables sent
   whole (since 0.10.0). Of each turn's calls, the loop runs at most `limits.callsPerTurn`, up to
   four at a time, each result fitted to the room left in the request, and sends the results back.
   Tools run in at most `limits.toolTurns - 1` model turns. Before each tool request it checks the
   ceiling of the question ([`AskLimits`](#asklimits)): when what was spent, that request and the
   answer's request would pass it, the next request is the answer.
5. **Ends with the answer.** A reply with text and no tool call is the answer, when there is no
   explorer. A turn whose tool call could not be read (`finish: "malformed_call"`) is not, even
   with a remark in it (since 0.10.0). Otherwise (out of turns, room or `limits`, a reply with no
   text, an explorer that is done) `model` gets one more request: the tools listed,
   `toolChoice: "none"`, and one of the [`FINAL_ANSWER_*`](#final_answer_request) lines as a user
   turn at the end. When its reply has no text (it is empty, or holds a tool call the model was
   told not to make), that request is sent once more with a note after the line, which is not
   kept: "Your last reply had no text. No tool can be called in this reply: write the answer now,
   in text, from what is above." Not after a refusal (`blockReason`), a reply `"filtered"` or
   `"other"`, or one `"cut"` with nothing in it; not once `limits.requests` or the ceiling of input
   tokens is reached; and not when the question already made its two second tries (see
   [`ModelReply`](#modelreply)). New in 0.6.0. When the tools are there only for tables sent whole,
   a turn with no call whose reply is `"filtered"` or `"other"` with no text, or `"cut"` before any
   text, ends the question without this request, as the request of step 3 would end (since 0.10.0).
6. **Says how the answer ended.** `result.finish` is the `finish` of the reply whose text is the
   answer, or of the last reply when none answered. A `"filtered"` answer has an `answer_filtered`
   notice, a `"cut"` one an `answer_cut` notice, before `run.finish`; `filteredAnswer: "drop"`
   drops a filtered answer. `result.citations` checks the answer's line citations against the
   evidence. [`answerInfoOf`](#answerinfo) turns the result into the reason to show. New in 0.10.0.

A call of a tool the question does not have is not run, and takes no room in the request: it is
answered `Unknown tool “name”. The tools are: search_document, read_document, …`, and its
`tool.end` has outcome `"refused"`. Until 0.10.0 it was run, and given room at the cap of a
result, so a turn of such calls shortened the results of earlier turns for nothing.

The room for tool results is counted in tokens (since 0.10.0): each result at its document's own
characters per token (`characters` / `estimatedTokens`, from 0.8 to 4), not at 2 for every file. A
table of numbers takes about one token a character, and its results took twice their room. A
result that would still pass the room (a guess that came out low, or a tool set of your own that
does not keep to `maxResultCharacters`) is cut, in call order, before the model gets it.

A request that fails is sent again by the rule of `retry` (see
[`withRetry`](./errors-and-retries.md#withretryrun-options)), but never once text of its reply was
shown. A request the provider refuses as too large (`kind: "context_overflow"`) is never sent again
as it was: it is made smaller. Older tool results are shortened, at most twice a question, and
never when a model of the question is `appendOnly`. When that does not mend it, and no tool call
was answered and no text was shown yet, the documents are planned again, once, for a smaller window
worked out from the provider's numbers. A request larger than the tokens a minute (or a day) that
the provider allows (OpenAI's and Groq's TPM, HTTP 429 or 413) is this kind too, with that
allowance as the window, and its steps say so.
[How it works](../how-it-works.md#a-request-too-large-for-the-model) explains each step.

New in 0.9.0: the first request of a question is not sent to be refused. When the stored rounds of
earlier questions make it larger than the room it has in tokens, by the loop's own estimate (the
window less half of `reservedTokens`), their results are shortened first, in the same steps, until
it fits. The request is then what 0.8.2 sent again after the provider refused it, without the
refused request before it. Only tokens are counted here, as in that recovery: a request is not
shortened for its bytes alone. This is done for an `appendOnly` model too: a stored round has no
thinking in it, and nothing of the question was sent yet. Before, such a question failed on Claude.
`steps` says "Older tool results were shortened to make room in the request", once: a question
planned again shortens them again without saying so twice.

**Returns** an [`AskResult`](#askresult).

**Throws:**

| Error | When | [`partialResultOf`](#partialresultoferror) |
|---|---|---|
| `Error`: "budget.… must be a number above 0, and is …", or "budget.reservedTokens (…) must be smaller than budget.contextTokens (…)…" (the same for `mapChunkTokens`) | A field of `options.budget` is not a number above 0, or the fields cannot work together. Before any request. See [`resolveBudget`](./library.md#resolvebudgetbudget-limits). | undefined |
| `Error`: "The last message must be the user's." | `messages` is empty, or its last message is not a user turn. | undefined |
| `RangeError`: "limits.… must be a number, and is NaN. Leave it out for the default.", or `TypeError`: "limits.… must be a number, and is …" | A field of `options.limits` is NaN, or not a number. Before any request. New in 0.7.1. | undefined |
| [`DocumentStoreError`](./library.md#documentstoreerror) | The store could not be read while the documents were planned. The documents are not gone: try again. A store that fails during a tool call is not thrown: the model gets the message as the tool's `error`. | undefined |
| What a tool call rejected with | The tool set's `executeWithFiles` rejected: the question ends with it, and the model gets nothing of it. The calls of the turn still running stop. A store call that timed out inside a tool is thrown this way. | What the question had done |
| What `onToolResult` threw, or `TypeError`: "onToolResult returned …: it must return { result }, { reject: "why" } or undefined." | The hook threw, its promise rejected, or it returned another shape. The result is not sent. New in 0.10.0. | What the question had done |
| [`DocumentsNotFoundError`](#documentsnotfounderror) | A document of `documentIds` was never stored, has expired or been deleted, or belongs to another `owner` or `scope`, and `onMissingDocuments` is `"throw"` (the default) or returned it; or a retry or replace of `onMissingDocuments` did not bring it back. Before any request. | undefined |
| `TypeError`: "onMissingDocuments must be "throw", "drop" or a function, and is …", or "onMissingDocuments returned …: it must return …" | `onMissingDocuments` is something else, or its function returned something else. New in 0.9.0. | undefined |
| What the function of `onMissingDocuments` threw | It threw, or its promise rejected. Before any request. New in 0.9.0. | undefined |
| `TypeError`: "questionId must be a string of 1 to 128 characters: …" | `questionId` is given and is not a question ID ([question IDs](#question-ids)). Before any request, after `run.start`, which then has no `questionId`. New in 0.99.9. | undefined |
| `TypeError("owner is required: requireOwner is on (the default). Pass the user's ID as owner, or create the library with requireOwner: false to allow calls without one.")`, `TypeError("scope is required: requireScope is on")` | The library requires an owner (the default since 0.99.9) or a scope ([`LargeFilesOptions`](./library.md#largefilesoptions)), and the question has none. Before any request. New in 0.9.0. | undefined |
| [`DocumentScopeError`](./library.md#documentscopeerror) | `scope` is not a valid scope, or the store threw one. Before any request when the scope is not valid. New in 0.9.0. | undefined |
| [`ModelRequestError`](./errors-and-retries.md#modelrequesterror), or the adapter's subclass (`GeminiRequestError`, `OpenAiRequestError`, `AnthropicRequestError`) | A chat request failed, and was not worth another try, still failed after `retry.retries` more, asked for a longer wait than `retry.maxDelayMs`, or had already shown text. A `context_overflow` that the recovery above did not mend. | What the question had done |
| Any other error of an adapter | Thrown as it came. An error without a numeric `status` is not sent again. | What the question had done |
| What a listener threw | `onEvent`, `onText`, `onActivity` or `onStep` threw. The question stops: the calls of the turn still running stop, and no request follows. New in 0.7.0 for a throw during a whole-file read (`onActivity` on its progress, `onEvent` on its events): 0.6.0 reported it to the model as the tool's error, and went on. | What the question had done, when the error is an object and the question was under way |
| The signal's reason | `signal` aborted. Nothing is sent or retried after that, no part of a whole-file read either. It is thrown at once, also while an adapter (or a part reader) that does not look at the signal is still at work, and also when the adapter then fails with its own error. Text that such an adapter sends later is not shown. Since 0.10.0 also while `files.prepare`, a tool call or `onToolResult` waits: on a store that hangs, with any `LargeFiles`. | What the question had done, when the reason is an object that no other question threw too (see [`partialResultOf`](#partialresultoferror)) |

When the documents were planned again after an overflow and the second plan fails before it sends
anything, the first overflow error is thrown, with what the first try had done. A whole-file part
read that fails does not end the question: the tool reports it to the model.

```ts
import { GoogleAuth } from "google-auth-library";
import { askWithFiles, DocumentsNotFoundError, partialResultOf, type AskResult, type ChatMessage, type LargeFiles } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const accessToken = async ({ refresh }: { refresh: boolean }) => {
  const client = await auth.getClient();
  if (refresh) client.setCredentials({ ...client.credentials, expiry_date: 1 }); // after a 401: the cached token was refused
  return (await client.getAccessToken()).token!;
};
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

### askStream(options)

```ts
declare function askStream(options: AskOptions): EventStream<AskEvent, AskResult>;
```

New in 0.7.0. [`askWithFiles`](#askwithfilesoptions) as a stream of its events, for a page that
shows the question as it goes. It starts the question at once and returns an async iterable of
[`AskEvent`](./events.md#askevent)s, in order: `run.start` first, then the plan, the requests, the tool
calls, the text and the notices, and last `run.finish` or `run.error`. Each event is also the one
`onEvent` would get.

| Member | What it is |
|---|---|
| `[Symbol.asyncIterator]()` | The events, read with `for await`. They wait in memory until they are read. The loop ends after the last event. It does not throw when the question fails: read the `run.error` event, or await `result`. Leaving the loop early (`break`, `return`, a throw) stops the question. It can be read once: a second `for await` throws `TypeError("These events can be read once.")`. |
| `result` | `Promise<AskResult>`: what `askWithFiles` returns, `toolTurns` included. It rejects with the question's error, and [`partialResultOf`](#partialresultoferror) works on that error. Awaiting it is optional: it never goes unhandled. |
| `abort(reason?)` | Stops the question. The stream ends after its last event, `run.error`. Without a reason, the question throws a `DOMException` named `"AbortError"`. |

The options are those of `askWithFiles`, with three differences:

- `streamText` defaults to `true`: the model is asked for the answer as it is written, and `text`
  events come as it arrives. Pass `streamText: false` to ask for each reply whole.
- `signal` still stops the question, as does `abort()` or leaving the loop.
- `onEvent`, when given, gets each event too, after the stream. A throw from it ends the question
  with that error, and the stream still ends with the `run.error`; a throw on `run.finish` leaves
  the stream ending with `run.finish`, and `result` rejects with it.

```ts
import { askStream, partialResultOf, type AskOptions, type ToolTurn } from "llm-large-files";

// options are those of askWithFiles. Returns the tool rounds to keep with the conversation.
export async function showQuestion(options: AskOptions): Promise<ToolTurn[]> {
  const stream = askStream(options);
  for await (const event of stream) {
    if (event.type === "tool.start") console.error(`${event.label}…`);
    if (event.type === "tool.progress") console.error(`${event.message}…`);
    if (event.type === "text") process.stdout.write(event.delta);
    if (event.type === "run.error") console.error(`\nFailed: ${event.error.message}`); // safe to show
  }
  try {
    return (await stream.result).toolTurns;
  } catch (error) {
    console.error(error); // the provider's own words, for your logs
    return partialResultOf(error)?.toolTurns ?? [];
  }
}
```

To send the events to a browser as Server-Sent Events, pass the stream itself to
[`writeSseEvents`](./node.md#writesseeventsresponse-events-options): it stops the question when the
client goes away. An async
generator that wraps the stream stops it only when it next yields; change what is sent with the
`map` option instead. What each event holds, and what goes over the wire: [events](./events.md).
[`eventStream`](./events.md#eventstreamrun-options) makes the same kind of stream around any
function that takes an `onEvent` and a `signal`.

### `AskOptions`

The options of `askWithFiles`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `files` | [`LargeFiles`](./library.md#largefiles) | required | The library that holds the documents, plans them and makes the tools. |
| `model` | [`ModelAdapter`](#modeladapter) | required | The model that answers. Without `explorer`, it also makes the tool calls and reads whole files in parts. |
| `explorer` | `ModelAdapter \| undefined` | none | A second model, of any provider, that makes the tool calls (search, read, look at pages) and reads whole files in parts. `model` then writes the answer from what the tools returned. Its requests get [`EXPLORER_INSTRUCTION`](#explorer_instruction), and its text is not shown. Left out, or the same object as `model`: one model does both. A question in which no file is searched and the tools are there for tables sent whole does not use it: `model` runs the tools (since 0.10.0). |
| `documentIds` | `string[]` | required | The documents this question may use. Duplicates count once. One that is missing throws [`DocumentsNotFoundError`](#documentsnotfounderror), unless `onMissingDocuments` says otherwise. |
| `messages` | [`ChatMessage[]`](#chatmessage) | required | The conversation, oldest first. The last message must be the user's question. The loop works on copies: your array is not changed. |
| `documentPlacement` | `"first" \| "last"` | `"first"` | Where document text and cards go. `"first"`: at the start of the first user turn, where they stay as the conversation grows, so the provider's prompt cache can reuse them on every follow-up question. `"last"`: after the text of the latest user turn; they then move on every turn and are billed in full each time. |
| `system` | `string` | none | Your system instruction. It is trimmed, and the guide to the document tools is added after it when a document is reached through tools or has pages to look at. |
| `owner` | `string` | none; required unless the library has `requireOwner: false` (since 0.99.9) | The user (or tenant) asking. A document ingested with another owner is treated as missing, and so is one ingested without an owner, under `requireOwner` (the default). Without `owner`, the question throws a `TypeError` before any request; under `requireOwner: false`, only documents ingested without one can be used. |
| `scope` | [`DocumentScope`](./library.md#documentscope) | none | The scope of the question, such as `[userId, chatId]`. Every store call of the question carries it, and a document ingested with another scope is treated as missing. The tools check the owner and scope the store holds against `owner` and `scope` (`ToolOptions.access`). New in 0.9.0. |
| `onMissingDocuments` | `"throw" \| "drop" \| ((missing: string[], context: MissingDocumentsContext) => MissingDocumentsAction \| Promise<MissingDocumentsAction>)` | `"throw"` | What to do when documents of `documentIds` are missing: expired, deleted, never stored, or of another owner or scope, which look the same. Settled before any request. `"throw"`: [`DocumentsNotFoundError`](#documentsnotfounderror), as before 0.9.0. `"drop"`: the question is answered without them. A function: it gets the missing IDs, and says what to do. See [missing documents](#missing-documents). New in 0.9.0. |
| `limits` | [`AskLimits`](#asklimits) | `{}` | The limits of this question: tool turns, calls per turn, whole-file reads, ceilings on tokens and requests. |
| `retry` | [`RetryOptions`](./errors-and-retries.md#retryoptions) | `{ retries: 3, baseDelayMs: 500, maxDelayMs: 60_000 }` | How a failed model request is sent again: chat requests and whole-file part reads. `{ retries: 0 }` turns it off. |
| `budget` | `Partial<`[`Budget`](./library.md#budget)`>` | the library's | Budget fields for this question, in place of the library's. Fields given nowhere follow the context window. The budget is then fitted to the models either way: `result.budget` shows it. |
| `wholeDocumentAnalysis` | `boolean` | `true` | Offer `analyze_whole_document`, which reads a whole file in many model requests. It is offered only when the model that explores has `generateText` and a document reached through tools is small enough to be read in about `budget.maxMapChunks` parts or fewer. `false` withholds it. The tool guide names it only when it is offered, and a card offers it only for a file that is small enough. With `false`, or a model that explores without `generateText`, a card says that its file can be searched and read by line ranges, not that it can be analyzed whole or is too large for that. |
| `viewPages` | `boolean` | `true` | Offer `view_pages` for PDFs whose original file is kept (`keepOriginals`). It is offered only when no model of the question has `capabilities.toolFiles: "none"`, and all of them take one kind of file (`capabilities.toolFileTypes`: one small PDF, or, since 0.99.9, each page drawn as an image). It changes nothing for a library that keeps no originals. |
| `nativeDocuments` | `boolean` | `true` | Send small visual files sent whole (a PDF with a picture or a scanned page, a deck) as the files themselves too, before their text, when every model of the question declares `capabilities.documents` and their original is kept. It changes nothing unless an adapter declares `documents`; `false` sends text only. Another value is a `TypeError` before any request ([The file itself](../guides/pdfs.md#the-file-itself-for-small-visual-files)). New in 0.99.9. |
| `showCitations` | `boolean` | `true` | Whether the user sees the answer's line citations. Since 0.99.14 `false` is `citationMarkers: "remove"`, and `true` is `"keep"`; given both, they must agree. `false`: the model is asked for them all the same (the requests are those of `true`), and `result.citations` checks and lists them (`cited`), but the citations in parentheses, such as `(report.docx L188-L200)`, `(L12)` or `(חוזה.docx שורות 188-200)`, are taken out of `onText`, the `text` events and `result.text`, each with the space before it. Text from a `(` is held back until its `)`, the end of its line or 200 characters, so a citation never shows for a moment. A parenthesis with other words in it, code, a form written in the files the model read (`(L4-L5)` of a medical report), and a citation written into a sentence ("line 12 of the contract says") stay. Since 0.99.13 [`AskResult.modelText`](#askresult) keeps the answer as the model wrote it, citations included: send that back as the assistant turn. An answer made only of citations is not shown empty: the lines it cited are shown in words ("line 8", "שורה 8"), with a `citations_only` notice. Another value is a `TypeError` before any request ([Citations the user does not see](#citations-the-user-does-not-see)). New in 0.99.12. |
| `citationMarkers` | `"keep" \| "remove" \| "token"` | `"keep"` | How the answer's citations are shown in `onText`, the `text` events and `result.text`. `"keep"`: as the model wrote them, as before 0.99.14: no `anchors`, no `sources`, no `citation` events. `"remove"`: taken out, as `showCitations: false` did, with more forms (lead-ins such as "(מקור: x L4)", square and full-width brackets, lists such as "שורות 12, 15 ו-18", a citation run at the end of a parenthesis); a citation the answer needs ("באיזו שורה?" answered "(שורה 8)", one right after ":" or a location word) is put into words where it stood, naming the place in the file ("שורה 8 בגיליון לקוחות"). Each one leaves a chip: [`result.anchors`](#askresult), [`result.sources`](#askresult) and a [`citation` event](./events.md#citation). `"token"`: as `"remove"`, with `⟦n⟧` (U+27E6, U+27E7) at each chip's place, for a page that renders Markdown ([`insertCitationTokens`](#insertcitationtokenstext-anchors)). The model is asked the same in every mode, and `result.modelText` is its own text. Another value is a `TypeError` before any request ([Sources and chips](#sources-and-chips)). New in 0.99.14. |
| `sources` | `"on" \| "off"` | `"on"` | `"off"` for a chat that shows no chips and no previews, such as a group chat with files as knowledge: the text is as with `citationMarkers: "remove"`, no `citation` event is sent, and `result.anchors` and `result.sources` are empty, so no event, `run.finish`, `run.error` or SSE message carries a file name, locator or quote of a source. `result.citations` keeps its meaning, and the model is asked as always. With `"off"`, `citationMarkers` defaults to `"remove"`; `"keep"`, `"token"` or `showCitations: true` is a `TypeError` before any request. New in 0.99.14. |
| `onText` | `(delta: string) => void` | none | The answer's text as it arrives. With it, `streamText` defaults to `true`, and the adapter streams when it can; otherwise the text of each reply comes once the reply is in: in one piece, or from `gemini()`, one piece for each text part. A remark the model wrote before a tool call comes too, and the text of a later reply then starts with `"\n\n"`. With an explorer, only the answering model's text comes. |
| `streamText` | `boolean` | `true` with `onText`, and in [`askStream`](#askstreamoptions); `false` otherwise | Whether to ask the model for the answer as it is written: the loop then passes `onText` to the adapter's `send` ([`SendHooks`](#sendhooks)), and an adapter that can stream does. A reply that fails after its first piece of text is not sent again: that text was shown. With `false`, the text of each reply comes once the reply is in, to `onText` and as `text` events, and a reply that fails can be sent again. A listener of the events alone (`onEvent` without `onText`) does not change how the model is asked. New in 0.7.0. |
| `onActivity` | `(text: string) => void` | none | Short-lived status in English: each tool call as it starts ("Search app.log (exact) for “timeout”…"), "Too large to read at once: app.log. Searching instead…", the progress of a whole-file read, a retry of a chat request ("The model did not answer (HTTP 503). Trying again in 2 s…", "The model could not be reached. Trying again…", or, for a reply that began and was cut off on its way, "The model's reply was cut off on its way. Trying again…"), and "Writing the answer…" before the request for the answer. Show it as plain text: a tool call's line can quote the model's words. The retries of a whole-file read's requests are not told here: they come only as `retry` events. |
| `onStep` | `(text: string) => void` | none | Each finished step, the same lines as `result.steps`, as they happen. |
| `onEvent` | `(event: AskEvent) => void` | none | Everything the question does, as typed events in order: `run.start`, the `plan`, each model request (`request.start`, `retry`, `request.end`), each tool call (`tool.start`, `tool.progress`, `tool.end`), the text, the notices, and last `run.finish` or `run.error`. See [events](./events.md). `onText`, `onActivity` and `onStep` still get the same strings, at the same moments. A model error in an event is told by its kind and status, never in the provider's words ([`EventError`](./errors-and-retries.md#errors-in-events-eventerror)). Tool results are left out unless `eventResults` is set. A throw from it ends the question with that error ([a listener that throws](./events.md#a-listener-that-throws)). New in 0.7.0. |
| `runId` | `string` | `"run_"` and 16 hex digits | The `runId` of every event of the question. Pass your own to find the events in your logs. New in 0.7.0. |
| `questionId` | `string` | none | A stable ID of this question, made by the client for the turn, such as a UUID, and the same when the request is sent again: 1 to 128 letters, digits, `.`, `_`, `:` or `-`, starting with a letter or a digit ([`QUESTION_ID_PATTERN`](#question-ids)). Every event of the question (`EventBase.questionId`) and its result carry it. On its own it only labels the question: [`createQuestionRegistry()`](#question-ids) runs questions by it. It is never sent to the model: the requests are the same with and without it. Another value is a `TypeError` before any request. New in 0.99.9. |
| `eventResults` | `boolean` | `false` | Put each tool result in its `tool.end` event (`result`), and `toolTurns` in the result that `run.finish` and `run.error` carry. Off by default: results hold the text of the documents, and events are often sent on to a browser. The result `askWithFiles` returns always has `toolTurns`. Either way, since 0.99.13, a tool error that quotes the document (the column names of a table, the sheet names of a workbook) reaches `tool.end.error` and the steps in the library's words, with a count; the model, and `result` with `eventResults`, get it whole ([what events carry](./events.md#tool-errors-that-quote-the-document)). New in 0.7.0. |
| `storeRounds` | `"full" \| "compact"` | `"full"` | How `result.toolTurns` holds the results of the question's calls. `"full"`: as the model had them. `"compact"`: each large result replaced by its stand-in ([`stubResult`](#stubresultcall-result-hadfiles)), as [`compactToolTurns`](#compacttoolturnsturns) makes it, so a stored question takes a few hundred bytes for most calls instead of up to 24,000 characters (the stand-in of a whole-file read keeps its notes, up to 6,000 characters). A later question sends the stand-ins, and the model reads again what it needs, at the price of a tool call. The requests of this question are the same either way. Another value is a `TypeError`. New in 0.10.2. |
| `touchOnUse` | `boolean` | `false` | Touch the documents the question plans ([`files.touch`](./library.md#filestouchid-access)) once less than half of their time to live is left, so that a chat that still uses its files keeps them. With the default `ttlMs` of 72 hours, a file used 47 hours after its upload is kept 72 hours from then, and one used at 10 hours is not touched, with no store call. Each touched document costs 2 store calls (its metadata read, then written), 8 documents at a time, before the first model request; what is sent to the model does not change. A document found gone meanwhile is left alone. The touches are best effort: one that the store fails leaves that document's expiry as it was, and the question goes on. A library that `createLargeFiles` did not make is taken to have the default 72 hours, by `Date.now()`, and its `touch` is called; one without `touch` is a `TypeError`, and so is a store without `patchMeta`. A document that never expires (`ttlMs: Infinity`) is never touched. Another value is a `TypeError` before any request. Off by default: how long files are kept is the application's to say ([missing documents](#missing-documents)). New in 0.99.13. |
| `filteredAnswer` | `"keep" \| "drop"` | `"keep"` | What to do with an answer that a filter of the provider stopped (`result.finish` `"filtered"`). `"keep"` keeps its text, as in 0.9, with `answered: true` when it has some. `"drop"` gives `answered: false` and `text: ""`. Text that was already sent (`onText`, `text` events) cannot be taken back: the `answer_filtered` notice then has `discardText: true`, before `run.finish`, and the page takes the text away. Text of a reply that was not streamed is not sent at all. Any other value (`"Drop"`, `true`) is a `TypeError` before any request: it would keep an answer that was meant to be dropped. See [filtered and cut answers](../guides/errors-and-reliability.md#filtered-and-cut-answers). New in 0.10.0. |
| `onToolResult` | `(context: ToolResultContext) => ToolResultVerdict \| undefined \| Promise<ToolResultVerdict \| undefined>` | none | Called with the result of every tool call that ran, as soon as it is in (the hooks of one turn may run at the same time), before the model, the evidence, the steps and the events get it ([`ToolResultContext` and `ToolResultVerdict`](#toolresultcontext-and-toolresultverdict)). A call that was refused, not run, or answered with a pointer is not passed to it. What it throws, or a value of another shape, ends the question. For data loss prevention: [security](../security.md#tool-results-ontoolresult). New in 0.10.0. |
| `signal` | `AbortSignal` | none | Stops the question: the request under way is aborted through the adapter, tool calls stop, and nothing is sent again. `askWithFiles` then throws the signal's reason, at once: the loop does not wait for an adapter, or a part reader, that does not look at the signal. A request left running that way may be billed by the provider, and is not counted in the usage. Since 0.10.0 the loop does not wait either for `files.prepare`, a tool call or `onToolResult` once it aborts, and it passes the signal on with the access of the question (`PrepareOptions.signal`, `ToolOptions.access.signal`), for a library that ends its own waits for the store with it. |

`inlineTables` and `numberInline` were removed in 0.99.9: a table sent whole always gets the tools
that count it, and files sent whole are always numbered
([tables sent whole](../guides/costs-and-limits.md#tables-sent-whole)). Any value but `"tools"` and
`true` is a `TypeError` before any request
([Upgrading to 0.99](../upgrading-0.99.md#the-way-back-to-09s-text)).

Guides: [conversations](../guides/conversations.md) (`messages`, `documentPlacement`),
[storage](../guides/storage.md) (`owner`), [web app](../guides/web-app.md) (`onText`,
`onActivity`, `onStep`, `signal`), [PDFs](../guides/pdfs.md) (`viewPages`),
[costs and limits](../guides/costs-and-limits.md) (`limits`, `budget`). Reference:
[events](./events.md) (`onEvent`, `runId`, `eventResults`).

### `AskLimits`

The limits of one question: `AskOptions.limits`. Every field is optional. A field that is NaN
(what `Number(process.env.X)` gives for a variable that is not set) throws a `RangeError`, and one
that is not a number a `TypeError`, before any request: since 0.7.1, as a budget field does. NaN
used to fail every comparison, so it turned off the ceilings and the cap on whole-file reads, or
every tool. `Infinity` sets no ceiling.

| Field | Type | Default | What it does |
|---|---|---|---|
| `toolTurns` | `number` | 12 | The most model turns of the chat for one question, counting the answer and a second try after an empty or broken reply. Tools run in all but the last: if the model is still calling tools then, the last turn must be answered in text. With an explorer, the explorer has up to `toolTurns - 1` turns and `model` the last. A request the provider refused as too large takes no turn of its own: what is sent again after it is the same turn, so `result.turns` can be a little higher. When the answer comes back without text, it is asked for once more, and that request can be one past `toolTurns`; it is not made once `requests` or the ceiling of input tokens is reached. Truncated to a whole number; below 1 counts as 1. With 1, no tool runs and the only request is the answer. |
| `callsPerTurn` | `number` | 8 | The most tool calls of one model turn that are run. Each call beyond it is answered with an error ("Not run: one turn runs at most 8 tool calls. Send this call again if you still need it."), and `steps` says how many were not run. Truncated to a whole number; below 1 counts as 1. |
| `wholeDocumentReads` | `number` | 1 ([`MAX_WHOLE_DOCUMENT_READS`](./tools.md#max_whole_document_reads)) | How many times each document may be read whole (`analyze_whole_document`) in one question. One read of a large file is up to `budget.maxMapChunks` part requests and a few more. 0 refuses every whole-file read but still lists the tool: to withhold it, set `wholeDocumentAnalysis: false`. |
| `inputTokens` | `number` | see below | A ceiling on the input tokens of the question, over all its requests, part reads included, as the adapters report them (`usage.inputTokens`, cached tokens included), and by the library's estimate for a request that reports no input (`usage.estimatedInputTokens`, since 0.10.0). Checked before each tool request, looking ahead (since 0.10.0): when what was spent, that request and the answer's request, as the loop estimates them now, would pass it, no further tool request is made and the next request is the answer. So the question spends at most about one request past it: the answer's, with the results of the last turn in it. A whole-file read that would pass it is refused, with the numbers, before it starts: priced with its line numbers, prompts and merges of notes since 0.10.0. `Infinity`: no ceiling, as before 0.10.0. |
| `requests` | `number` | none | The same ceiling on model requests, chat requests and part reads together, as `usage.requests` counts them. Once `requests - 1` are used, no further tool request is made: the last request is kept for the answer. The calls of the reply that used it still run, but a whole-file read that needs more requests than are left is refused, and the reads of one turn share what is left. |
| `wholeReadsPerQuestion` | `number` | 2 | How many whole-file reads one question may make over all its documents, next to `wholeDocumentReads` for each one. A read that sent requests counts, one that read no part among them; a read refused before it starts does not. A read past it is refused: "Not run: one question makes at most 2 whole-file reads, and this one has made them. Use search_document and read_document on app.log." Truncated to a whole number. `Infinity` keeps the rule of 0.9, one read of each document. New in 0.10.0. |

**The default ceiling** (new in 0.10.0). A question that sets no `inputTokens` has one: the larger
of [`DEFAULT_INPUT_TOKENS`](#default_input_tokens) (1,000,000) and `toolTurns` times the estimate
of its first request, plus room for its whole-file reads. That room is as many reads as
`wholeReadsPerQuestion` and the documents that can be read whole allow (`wholeDocumentReads` of
each), each at the price of the dearest of them, and 0 when no document can be read whole. So a
read of a 1.77 MB log, about 1.5M tokens, still runs, and a question of 4 tool turns over a 3 MB log
does not come near the ceiling. Set `inputTokens: Infinity` for the behavior of 0.9.

`askGemini` also takes `maxToolTurns` and `maxToolCallsPerTurn`, the names these had before 0.5.0
(see [gemini](./gemini.md)). Guide: [costs and limits](../guides/costs-and-limits.md).

### `AskResult`

What `askWithFiles` returns, and what [`partialResultOf`](#partialresultoferror) gives for a
question that failed.

| Field | Type | What it holds |
|---|---|---|
| `text` | `string` | Everything the answering model wrote, as `onText` got it: a remark made before a tool call, then `"\n\n"` and the answer. With an explorer, only what `model` wrote. `""` when nothing was written. With `showCitations: false`, without its citations in parentheses, as it was shown (since 0.99.12). |
| `modelText` | `string` | What the model wrote, as it wrote it: `text` with its citations, whatever `showCitations` says. Equal to `text` with `showCitations: true`, the default. Store it with the conversation and send it back as the assistant turn of a later question, and show `text`: the requests of that question are then the ones they would be with citations shown. Replayed over 16 recorded follow-ups with `showCitations: false`, history built from `modelText` sends the same requests in 16 of 16, and history built from `text` in 7 of 16. In the result of `run.finish`, in the `partial` of `run.error` and in what `partialResultOf` gives; never in what [`sseMessageOf`](./events.md#ssemessageofevent) sends to a browser, since it holds the citations that were hidden. Required: an `AskResult` you build by hand, such as a mock in a test, needs it. New in 0.99.13. |
| `answered` | `boolean` | True when the last reply had text that is not blank, and the provider did not refuse the prompt. False when the prompt was refused (`blockReason`), or the last reply had no text: it was cut off or filtered before any text, or the request for the answer came back without text, and so did its second try. A turn whose tool call could not be read is not the answer, even with a remark in it: the answer is asked for (since 0.10.0; before, the remark was the answer). With `filteredAnswer: "drop"`, false for a filtered answer. `text` may then be empty, or hold a remark made before a tool call, or the start of a reply that was refused: show your own message ([`answerInfoOf`](#answerinfo) says which). |
| `blockReason` | `string`, optional | Why the provider refused the prompt, in the adapter's words. Set only then. Nothing more is asked after a refusal. |
| `steps` | `string[]` | Each finished step, in order: a line for each tool call, run or refused ("Search app.log (exact) for “timeout” — 12 matching lines", or "… — already shown above"), one for the calls of a turn over `callsPerTurn`, and one when the loop shortened older results, asked again after an empty or broken reply, or planned the documents again. The second try of the answer says "The model's answer was empty: it was asked again" or "The model called a tool instead of answering: it was asked again for the answer". The lines `onStep` got. Each is one line of plain text: a line break, a tab or another control character in what the model sent becomes one space with the blanks around it; the invisible characters that file text loses are dropped (text-direction overrides and isolates, zero-width spaces, word joiners, soft hyphens, tag characters); `](` becomes `] (`, so that a markdown link or picture stays text. A query is cut at 80 characters and a task at 100, never in the middle of a character. Steps still quote the model's words, HTML tags and web addresses included: show them as plain text, never as markdown or HTML. |
| `evidence` | [`Evidence[]`](#evidence) | What the model was shown. First each file sent whole, in the order of its block: `{ tool: "inline", documentId, document, lines: [[1, lines]], whole: true }`, with no `callId` (new in 0.10.0), and right after it, for a file whose uploaded file was sent too, `{ tool: "original", documentId, document, pages: [[1, pages]] }`, with no `lines` and no `whole` (new in 0.99.9). Then what each tool call showed: the document, and the lines or pages, in call order. A call that failed, was not run, or was answered with a pointer to an earlier result adds none. Each of those has the `callId` of its call's events (new in 0.7.0). |
| `toolTurns` | [`ToolTurn[]`](#toolturn) | The tool rounds of this question, as plain JSON, as the model last had them. Pass them back in `messages`, between this question and its answer, and a later question sees what was found here. Each result of a call made in this question has `tool_turns_left`, except a stand-in (`dropped: true`, see [`stubResult`](#stubresultcall-result-hadfiles)): a result shortened to make room, a pointer whose result was shortened, and the result of a call that showed pages. The pages are not kept: their stand-in says which pages were shown. A call's `problem` is left out. With `storeRounds: "compact"` (0.10.2), each large result is its stand-in ([`compactToolTurns`](#compacttoolturnsturns)). |
| `plan` | [`DocumentPlan`](./library.md#documentplan) | Which documents went in whole (`inline`) and which were reached through tools (`searchable`). |
| `missing` | `string[]`, optional | The documents of `documentIds` that were missing, and that the question was answered without (`onMissingDocuments` `"drop"`). Absent when none was. New in 0.9.0. |
| `budget` | [`Budget`](./library.md#budget) | The budget the question ran with: the library's (with `options.budget`), fitted to the models. |
| `turns` | `number` | Chat requests of the question, the explorer's among them; whole-file part reads are not counted. A request counts when it is sent, so one that failed counts too. One sent again after a failure counts once; one sent again smaller after an overflow counts again. |
| `finishReason` | `string`, optional | The provider's own word for why the last reply that gave one ended (`"STOP"`, `"length"`, `"end_turn"`). |
| `usage` | [`UsageTotals`](#usagetotals) | Tokens and requests of the whole question, whole-file part reads included, in all and for each model by its `id`. The input of requests that reported none is in `estimatedInputTokens`. |
| `lastUsage` | `Record<string, unknown>`, optional | The provider's own usage object of the last chat reply that had one, as it came. |
| `finish` | `"complete" \| "cut" \| "filtered" \| "malformed_call" \| "other"`, optional | How the reply whose text is the answer ended (`ModelReply.finish`), or the last reply of the chat when none answered. Absent when the adapter does not say. `"filtered"` and `"cut"` come with an `answer_filtered` or `answer_cut` notice. New in 0.10.0. |
| `citations` | [`CitationCheck`](#citationcheck), optional | The line citations of `text`, checked against the evidence of the question: a document sent whole, or read whole for an answer, counts as shown, every line it has; a read of items, the lines of its items. Set when the question had documents. With `showCitations: false`, read from the answer as the model wrote it, before its citations were taken out. New in 0.10.0. |
| `questionId` | `string`, optional | `AskOptions.questionId`, when the question had one. Also in the result of `run.finish`, in the `partial` of `run.error`, and in what `partialResultOf` gives. New in 0.99.9. |
| `anchors` | [`CitationAnchor[]`](#citationanchor), optional | Where each chip goes in `text`, in order: one for each citation `citationMarkers` `"remove"` or `"token"` took out or put in words. Empty with `sources: "off"`, absent with `"keep"`. In `run.finish`, in the `partial` of `run.error` for `onEvent`, and in what `sseMessageOf` sends for `run.finish` (not for `run.error`). New in 0.99.14. |
| `sources` | [`CitedSource[]`](#citedsource), optional | What the chips open, one per distinct citation (a file and its lines), in the order first cited: the file, where the lines are in it ([`SourceLocator`](#sourcelocator)), its `version`, and a `quote` cut from what the model was sent. Empty with `sources: "off"`, absent with `"keep"`. In events without quotes unless `eventResults` is true; never with quotes in what `sseMessageOf` sends. New in 0.99.14. |
| `lineTalk` | [`LineTalk`](#linetalk), optional | What talk of lines is left in `text` once the citations were taken out: counts and hashes, for your logs. With `"remove"` or `"token"`. In `run.finish` and the `partial` of `run.error` for `onEvent`; never in what `sseMessageOf` sends. New in 0.99.14. |

Guides: [conversations](../guides/conversations.md) (`toolTurns`),
[costs and limits](../guides/costs-and-limits.md) (`usage`),
[errors and reliability](../guides/errors-and-reliability.md) (`answered`, `blockReason`).

### partialResultOf(error)

```ts
declare function partialResultOf(error: unknown): AskResult | undefined;
```

New in 0.6.0, from `llm-large-files` and `llm-large-files/gemini`.

What a question that failed had done before it failed. `askWithFiles` throws the error as it came;
this gives, for that error object, an [`AskResult`](#askresult) with `answered: false` and the
`steps`, `evidence`, `toolTurns`, `usage`, `turns`, `plan` and `budget` of the question until
then. Keep its `toolTurns` with the conversation and count its `usage`: those requests were paid
for. `usage` is a copy taken when the question failed: a request still running then (an adapter
or a part reader that did not stop at the signal) may be billed by the provider, and is not
counted. It returns `undefined` for an error that did not come from a question under way (a missing
document, a budget that cannot work, a store that could not be read while planning) and for a
value that is not an object. The sample under [`askWithFiles`](#askwithfilesoptions) uses it.

One error object can be thrown by several questions: the reason of a signal they share, such as
one controller for a batch, or a server's shutdown signal that each question joins with
`AbortSignal.any` (it passes the reason on as it is). Since 0.7.1, `partialResultOf` then returns
`undefined` for it, rather than the result of whichever question failed last, which held another
user's tool rounds and usage. Each question's `run.error` event still carries its own `partial`.
To get the result from `partialResultOf`, give each question a signal whose reason is its own:
`const own = new AbortController(); shared.addEventListener("abort", () => own.abort(new DOMException("Stopped.", "AbortError")), { once: true });`.

The `run.error` event carries the same result as `partial`, as an `EventResult`: without
`toolTurns`, and with a plan that names the documents only (both hold text of the documents),
unless `eventResults` is set; and
`sseMessageOf` sends only its `steps`, `evidence` and `usage`. Keep the tool rounds from
`partialResultOf(error)` on the server: with `askStream`, `error` is what `stream.result` rejects
with.

Guide: [errors and reliability](../guides/errors-and-reliability.md).

### `DocumentsNotFoundError`

```ts
declare class DocumentsNotFoundError extends Error {
  constructor(ids: string[]);
  readonly ids: string[];
  readonly code: "documents_missing"; // new in 0.9.0
  readonly status: 404; // new in 0.9.0
  static is(value: unknown): value is DocumentsNotFoundError; // new in 0.9.0
}
```

Thrown by `askWithFiles` (and `askGemini`) before any model request, when documents of
`documentIds` were never stored, have expired or been deleted, or belong to another owner or scope. `ids`
lists them. `name` is `"DocumentsNotFoundError"`. The message names the IDs, not the files: "A
document is no longer available: ‹id›. Upload it again.", or for several "3 documents are no longer
available: ‹id›, ‹id›, ‹id›. Upload them again." New in 0.9.0: `code` is `"documents_missing"`,
`status` is 404, and `DocumentsNotFoundError.is(error)` tells one apart also when another copy of
the package made it (see [errors](./errors-and-retries.md#telling-errors-apart-across-copies-of-the-package)).

Since 0.9.0 `onMissingDocuments` can answer without them, or bring them back, instead.

Guide: [errors and reliability](../guides/errors-and-reliability.md).

### Missing documents

New in 0.9.0. `AskOptions.onMissingDocuments` says what a question does with documents of
`documentIds` that are missing. A document that expired (`ttlMs`), was deleted, was never stored,
or belongs to another owner or scope is missing: the four look the same, so another user's ID tells
nothing. It is settled before any model request.

- **`"throw"`** (the default): the question throws [`DocumentsNotFoundError`](#documentsnotfounderror),
  as before.
- **`"drop"`**: the question is answered without them.
  - The system instruction gets one line at its end: "1 of the attached files is no longer
    available; say so if the question needs it." (or "3 of the attached files are no longer
    available; say so if the question needs them."). Only in this question.
  - `AskResult.missing` lists their IDs, and a `"documents_missing"` notice names them
    (`documentIds`), before the `plan` event.
  - With no document left, the question is a plain chat: no tool guide, no tools. The model may
    then answer from what it knows, without saying the files are gone. To refuse instead, give a
    function that throws when none is left:
    `(missing) => (missing.length === new Set(documentIds).size ? "throw" : "drop")`, with the
    question's own `documentIds`.
- **A function** gets the missing IDs and a [`MissingDocumentsContext`](#missingdocumentscontext),
  and returns a [`MissingDocumentsAction`](#missingdocumentsaction), or a promise of one.
  - `"throw"` or `"drop"`, as above.
  - `{ retry: true }`: you ingested them again under the same IDs (`IngestInput.id`). The documents
    are planned again, once.
  - `{ replace: { [oldId]: newId } }`: you ingested them under new IDs. The documents are planned
    again, once, with each new ID in the place of its old one.
  - After a retry or a replace, an ID still missing fails the question with
    `DocumentsNotFoundError`. When you cannot bring them all back, return `"drop"`: those you
    ingested again are used from the next question.
  - What it throws fails the question, as it came. When `signal` aborts while it runs, the
    question ends at once with the signal's reason, whether the function looks at the signal or not.

A question planned again for a smaller window (after the provider refused its first request) keeps
what was settled: the function is not asked again about the same documents.

To keep a chat's files from expiring while the chat still uses them, pass `touchOnUse: true`
(new in 0.99.13): each question then touches the documents it plans once less than half of their
time to live is left. With the default 72 hours, a file used at 47 hours is still there at 73
hours; without the option it is gone, and the next question finds it missing.

```ts
import { askWithFiles, IngestError, type AskResult, type LargeFiles, type MissingDocumentsAction, type ModelAdapter } from "llm-large-files";

declare const files: LargeFiles;
declare const model: ModelAdapter;
// The uploads you keep, by their ID, which is also the document's ID.
declare const uploads: { find(userId: string, id: string): Promise<{ name: string; bytes: Uint8Array } | undefined> };

export async function ask(userId: string, chatId: string, documentIds: string[], question: string): Promise<AskResult> {
  return askWithFiles({
    files,
    model,
    owner: userId,
    scope: [userId, chatId],
    documentIds,
    messages: [{ role: "user", text: question }],
    // Ingest again what was kept; answer without the files that are gone for good.
    onMissingDocuments: async (missing, { owner, scope }): Promise<MissingDocumentsAction> => {
      let back = 0;
      for (const id of missing) {
        const upload = await uploads.find(userId, id);
        if (!upload) continue;
        try {
          await files.ingest({ name: upload.name, bytes: upload.bytes, id, owner, scope });
        } catch (error) {
          // Another question of the chat ingested it meanwhile.
          if (!(IngestError.is(error) && error.code === "exists")) throw error;
        }
        back++;
      }
      return back === missing.length ? { retry: true } : "drop";
    },
  });
}
```

- Two questions of one chat can find the same document missing at once: a second tab, or a
  question sent again. The second ingest gets an [`IngestError`](./library.md#ingesterror) of code
  `"exists"`, and the ID counts as back. If the first has not stored it yet, that question fails
  with `DocumentsNotFoundError`, and can be asked again.

### `MissingDocumentsAction`

```ts
type MissingDocumentsAction = "throw" | "drop" | { retry: true } | { replace: Record<string, string> };
```

New in 0.9.0. What a function of `onMissingDocuments` returns: see
[missing documents](#missing-documents). Anything else is a `TypeError`: "onMissingDocuments returned
…: it must return "throw", "drop", { retry: true } or { replace: { [oldId]: newId } }." The map of
a replace is a plain object (made as `{}`, or with `Object.create(null)`), not a `Map` or an
instance of a class, and its new IDs are strings that are not empty. An action with a key of
another name, such as `{ retry: true, why: "…" }`, is a `TypeError` too.

### `MissingDocumentsContext`

```ts
type MissingDocumentsContext = { owner?: string; scope?: DocumentScope; signal?: AbortSignal };
```

New in 0.9.0. What a function of `onMissingDocuments` is told besides the IDs: the `owner`, `scope`
and `signal` of the question, when it has them. Ingest again with the same owner and scope, or the
documents are still missing for the question.

### `DEFAULT_INPUT_TOKENS`

```ts
declare const DEFAULT_INPUT_TOKENS: 1_000_000;
```

The least ceiling on the input tokens of a question that sets no `limits.inputTokens`. Its ceiling
is the larger of this and `toolTurns` times the estimate of its first request, with room for its
whole-file reads added (see [the default ceiling](#asklimits)). New in 0.10.0.

### `ToolResultContext` and `ToolResultVerdict`

```ts
type ToolResultContext = { call: ToolCall; result: ToolResult; files?: ToolFile[]; documentId?: string; owner?: string; scope?: DocumentScope; signal: AbortSignal };
type ToolResultVerdict = { result: ToolResult; keepFiles?: boolean } | { reject: string };
```

What `AskOptions.onToolResult` is given, and what it returns. New in 0.10.0.

The hook is called once for each tool call that ran, as soon as its result is in, with the result
as the tool returned it. The hooks of one turn may run at the same time: an async check of 200 ms
adds about 200 ms to a turn of eight calls, not 1.6 s. Their verdicts are applied in call order, and
what they let through is then fitted to the room in the request, as the tool's own result would be:
a replacement larger than the room is cut, and keeps `redacted: true`. Nothing else sees a result
before its hook: the model, `evidence`, `steps`, `toolTurns`, `onStep` and the `tool.end` event all
get what the hook let through. A call refused by the loop (no room, a limit, an unknown tool,
arguments that did not arrive whole), answered with a pointer to an earlier result, or over
`callsPerTurn`, is not passed to it: the model gets no file text from those. The same call made
twice in one turn is passed once: the second gets the first one's verdict (the same replacement, or
the same error), and a pointer only when the hook kept the result. The question waits for an async
hook, and stops waiting when its signal aborts. A hook that fails ends the question at once, without
waiting for the hooks of the other calls.

| Field | Type | What it holds |
|---|---|---|
| `call` | [`ToolCall`](#toolcall) | The tool call, as the model made it. |
| `result` | [`ToolResult`](./tools.md#toolresult) | What the tool returned, before it is fitted to the room in the request. An error result (`{ error }`) is passed too. |
| `files` | `ToolFile[]`, optional | The files the call hands the model next to its result: the pages of `view_pages`, as one PDF or an image of each page (`name`, `mimeType`, `bytes`). Present when there is at least one. New in 0.99.10. |
| `documentId` | `string`, optional | The document the call names (`args.document_id`), when it names one. |
| `owner` | `string`, optional | The question's `owner`. |
| `scope` | [`DocumentScope`](./library.md#documentscope), optional | The question's `scope`. |
| `signal` | `AbortSignal` | Aborts when the question is stopped or fails: pass it to a call of your own, such as a DLP service. |

| Verdict | What the model is sent | `tool.end` outcome |
|---|---|---|
| `{ result }` | That result in place of the tool's, with `redacted: true` added, fitted to the room in the request. A later call is never answered with a pointer to it ("already shown above"): it runs again, through the hook. The same call made again in the same turn gets the same replacement. Since 0.99.10 the call's `files` (the pages of `view_pages`) are not sent with it, and no evidence of those pages is kept: before, the pages of the replaced result still went to the model. | `"redacted"` |
| `{ result, keepFiles: true }` | The same, with the call's `files`. `keepFiles` must be a boolean when it is there: anything else ends the question with a `TypeError`. New in 0.99.10. | `"redacted"` |
| `{ reject: "why" }` | `{ error: "why" }`, without the call's `files`. No evidence. | `"refused"` |
| `undefined` | The tool's result. | as without the hook |

A verdict with a `result` key is a result, whatever else it holds: `{ result: { reject: "x" } }`
sends `{ reject: "x", redacted: true }`. A thrown error, a rejected promise, or a value of another
shape (`{ reject: 42 }`, `{ result: "text" }`, a result itself) ends the question with that error or
a `TypeError`: the hook is there to keep something from the model, and a mistake in it does not let
the result through.

```ts
import { askWithFiles, type AskOptions, type AskResult, type ToolResult } from "llm-large-files";

const CARD = /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g;
/** Every string of a result with the card numbers in it masked; numbers and keys as they are. */
const masked = (value: unknown): unknown =>
  typeof value === "string" ? value.replace(CARD, "[card]")
  : Array.isArray(value) ? value.map(masked)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, masked(field)]))
  : value;

// options are those of askWithFiles.
export function askMasked(options: AskOptions): Promise<AskResult> {
  return askWithFiles({
    ...options,
    onToolResult: ({ result }) => {
      const clean = masked(result) as ToolResult;
      return JSON.stringify(clean) === JSON.stringify(result) ? undefined : { result: clean };
    },
  });
}
```

### `CitationCheck`

```ts
type CitationCheck = { checked: number; supported: number; unchecked: number; unsupported: Array<{ document: string; line: number }>; cited?: LineCitation[] };
type LineCitation = { document?: string; documentId?: string; from: number; to: number; form: "line" | "row"; status: "supported" | "unsupported" | "unchecked" };

declare function checkCitations(text: string, evidence: Evidence[], names: Record<string, string>, formats?: Record<string, DocumentFormat>): CitationCheck;
declare function hideCitations(text: string, names?: Record<string, string>, content?: readonly string[]): string;
declare class CitationHider {
  constructor(names?: Record<string, string>, content?: readonly string[]);
  addContent(text: string): void;
  addToolResult(result: unknown): void;
  push(delta: string): string;
  flush(): string;
}
```

The line citations of an answer, checked against what the tools showed (`AskResult.citations`).
New in 0.10.0.

`checkCitations(text, evidence, names, formats?)` finds the citations of `text` and checks each
against `evidence`. `names` gives each document ID's file name; a document missing from it takes the
`document` of its evidence. `formats` gives each one's format, to tell a workbook's rows.

What it reads:

| Form | Example | Read as |
|---|---|---|
| `L` (or `l`, or `L` and a space) and a number or a range, with the file name next to it, in the same parentheses or on the same line | `(app.log L97)`, `(app.log L95-110, L118)`, `app.log L12–14`, `(L12 חוזה.docx)` | lines |
| `line` or `lines` and a number or a range | `app.log line 12`, `lines 12 to 14 of app.log` | lines |
| `Row` and a number | `sales.xlsx, Row 12` | a row: unchecked for a workbook (XLSX), a line for any other file |
| `שורה` and a number, `שורות` and a range, with a prefix letter or `מס'` | `לפי חוזה.docx, שורה 12`, `בשורות 40-45 של חשבוניות.csv`, `בשורה 40 בקובץ חשבוניות.csv` | as `Row`: in Hebrew שורה is both a line and a row |

A range is written with a hyphen, a dash, a maqaf (`12־14`), "to" or "עד". Hebrew points
(`שׁוּרָה`) and the marks that set the direction of text (RLM, LRM and the like) are not read.

A citation goes with the file name next to it: one in its parentheses, else one on its line within
40 characters. A name after it that is introduced as its own ("line 40 of x", "בשורה 40 בקובץ x",
"שורה 40 בx") is its name: in "בשורה 12 בקובץ חוזה.docx, והאיחור בשורה 40 בקובץ חשבוניות.csv", line
40 goes with חשבוניות.csv. Else, of the name before it and the name after it, the nearer one, where
a comma, a semicolon, the end of a sentence or "and" ("ו") between them counts as far, except a
comma or a colon right after the name before: in "לפי חוזה.docx, שורה 12 סותרת את חשבוניות.csv",
line 12 goes with חוזה.docx. The name may be
written without its extension ("report" for report.docx) or with a Hebrew prefix letter
("בחוזה.docx"). With one file, a citation needs no name. A bare `L12` with no name next to it counts
only inside parentheses (`(L12)`): "the L2 cache" is no citation. A citation is supported when every
line it names was shown, by the lines of an evidence entry of that document. An entry with
`whole: true` (a file read whole, or sent whole) and no `lines` shows every line; one with `lines`
(`[[1, 120]]`) shows those, so a line past the end of the file is not supported. Two documents of
one name support it by either. `askWithFiles` counts each document sent whole, and each document
read whole for an answer (`analyze_whole_document`), as shown from its first line to its last
(`DocumentMeta.lines`): its `evidence` is not changed for that. A read with `output: "items"` shows
the lines of its items only (its evidence has them as `lines`), so a citation of another line of
that file is not supported.

| Field | Type | What it holds |
|---|---|---|
| `checked` | `number` | Citations matched to a file and a line. |
| `supported` | `number` | Of those, the ones inside what the tools showed. A file sent whole counts as shown. |
| `unchecked` | `number` | Citations recognized but not matched: no file name when there are several files, or the row of a workbook. |
| `unsupported` | `Array<{ document: string; line: number }>` | The citations of lines the tools did not show. |
| `cited` | `LineCitation[]`, optional | Every citation read, in the order of the answer, the unchecked ones too. `checkCitations` always gives it; it is optional so that a `CitationCheck` made by hand still compiles. New in 0.99.12. |

A `LineCitation` (new in 0.99.12):

| Field | Type | What it holds |
|---|---|---|
| `document` | `string`, optional | The file name it goes with. None when no name was found and the question has several files. |
| `documentId` | `string`, optional | The ID of that file. Of two files of one name, the one that shows the lines, else the first. |
| `from`, `to` | `number` | The first and last line it names: `L12-14` is 12 and 14, `L12` is 12 and 12. |
| `form` | `"line" \| "row"` | `"line"` for `L12` and `line 12`; `"row"` for `Row 12` and the Hebrew `שורה 12`, which is both. |
| `status` | `"supported" \| "unsupported" \| "unchecked"` | Whether the tools showed every line it names (a file sent whole shows all of its lines), did not, or it could not be checked: no file found for it, or a row of a workbook. |

#### Citations the user does not see

With `showCitations: false` (since 0.99.14 `citationMarkers: "remove"`) the model cites as it
always does, and the library takes the citations out of what it shows. `result.sources` says
where each one points to in the file, as a person finds it there, for a list of sources beside the
answer ([Sources and chips](#sources-and-chips)); `result.citations.cited` keeps the citations as
written, for checking them:

```ts
import { askWithFiles, describeLocator } from "llm-large-files";

// files, model, documentIds and messages as in any question.
const result = await askWithFiles({ files, model, documentIds, messages, citationMarkers: "remove" });
// "Payment is due in 30 days (contract.docx L188-L200)." was shown as "Payment is due in 30 days."
const sources = (result.sources ?? []).map((source) => [source.name ?? "a file", ...source.locators.map((locator) => describeLocator(locator, "en"))].filter(Boolean).join(", "));
// ["contract.docx, clause 12.1"]: the place, never the library's line numbers.
```

Keep `result.modelText` for the history (since 0.99.13): it has the citations the user did not
see. Sent back as the assistant turn, it makes the requests of later questions those they would be
with citations shown: 16 of 16 recorded follow-ups, against 7 of 16 with the shown `text`:

```ts
import { askWithFiles, type ChatMessage } from "llm-large-files";

// files, model and documentIds as in any question.
declare const earlier: ChatMessage[]; // the chat so far, its answers stored as modelText
const question = "And the penalty for paying late?";
const answer = await askWithFiles({ files, model, documentIds, messages: [...earlier, { role: "user", text: question }], showCitations: false });
// Show answer.text; keep answer.modelText as the model's turn of the history.
const next: ChatMessage[] = [
  ...earlier,
  { role: "user", text: question },
  ...answer.toolTurns,
  ...(answer.answered ? [{ role: "assistant" as const, text: answer.modelText }] : []), // never an answer that is not one
];
```

What goes is a parenthesis that holds citations alone: line and row citations in any of the forms
above, file names (the question's, or any name with a known extension such as `.docx` or `.pdf`,
also in backticks or quotes), document IDs (the tool guide shows them, and a model may cite
`(contract-1 L3)`), separators, "and", "see", the words for a line or a row (`(שורות L1–L306)`) and
pages (`p. 3`). With it go:

- the space before it, or, at the start of a line, the space after it (the indentation stays):
  `## Payment terms (L188-L200)` becomes `## Payment terms`, `30 days (L12).` becomes `30 days.`;
- emphasis around it alone: `**(L12)**` goes whole, `**Title (L5)**` becomes `**Title**`;
- a list item or a line left with nothing else: `- (L12)` goes, with its end of line.

A parenthesis that holds only document IDs of the question goes the same way, as the IDs say
nothing to the user: `לפי המדיניות (policy-1):` becomes `לפי המדיניות:`. An ID goes only when it has
3 characters or more with a letter, is not its file's name (with or without the extension), and is
not written in the files the model read.

What stays as written:

| Stays | Example | Why |
|---|---|---|
| A parenthesis with other words in it | `(see the table, L12)`, `(tier L2)`, `(1312ms, L22776)` | It says more than where. |
| Code | `` `fn(L12)` ``, a fenced block | Code is shown as written. A backtick inside a parenthesis that is not a citation opens no code past its `)`. |
| A form written in the files, with no file name | `(L4-L5)` of a medical report, `(L2)` of a support plan, `(line 12)` of a tax form | The form is a word of the file the model read (a file sent whole, or what a tool showed), found as `checkCitations` finds citations: whole words, any dash, `L` or `l`. `XL2` or `L20` in a file does not keep `(L2)`. `(mri.pdf L4-L5)`, with a name, goes. |
| A document ID that is a word of the files, or the file's name | `(form-7)` of a file that says "use form-7", `(report.docx)` | It means something to the user. |
| A citation outside parentheses, or in brackets | `line 12 of the contract says`, `[L12]` | Rare in answers (none and 3 in 160), and brackets may be a link. |
| A parenthesis that does not close on its line within 200 characters | | The longest citation in 160 answers was 144 characters. |

**An answer made only of citations** (new in 0.99.13). When what a request shows has nothing left
but spaces and punctuation once its citations are taken out (no letter, digit or symbol), the lines
it cited are shown in words after it, without the file names: "line 8", "lines 2 and 3",
"lines 4–6", "row 12" when every citation is a row; "שורה 8", "שורות 3 ו-8" in Hebrew. In Hebrew
"שורה" is also a row, so a line citation of a workbook, whose line 7 may be its Row 400, reads
"שורה 7 בטקסט" (line 7 of the text). Hebrew words
are used when the answer or the question has Hebrew letters, English when either has words in
Latin letters, and otherwise by the names of the files. A `citations_only` notice (display
`"none"`) says so, once a question. The words reach `onText`, the `text` events and `result.text`;
`modelText`, `citations` and `answered` (still true) do not change. Before 0.99.13, such an answer
was shown empty and reported answered and complete: 4 of 4 in the tests, 0 of 4 now.
`hideCitations` and `CitationHider` do not add the words.

`hideCitations(text, names?, content?)` does the same over a whole text, and `CitationHider` a
piece at a time, for a loop of your own: `push(delta)` gives what can be shown now, and `flush()`
what it still holds when the reply ends; the pieces together are always `hideCitations` of the
whole. `names` gives each document ID's file name, as for `checkCitations`. `content`,
`addContent(text)` and `addToolResult(result)` give it what the model read of the files: a tool
result is read but its outline, its hint on how to cite, its notes and its errors. `askWithFiles`
gives it the files sent whole and every tool result, but a whole-file read's own notes (only the
quotes of its items). Both are new in 0.99.12.

### Sources and chips

New in 0.99.14. With `citationMarkers: "remove"` (or `"token"`), every citation the model writes
and the library takes out leaves a chip: the place in `result.text` where it goes, and the source
it opens, with where the cited lines are in the original file as a person finds them there: a
workbook's sheet and Excel row, a CSV row as a spreadsheet shows it, a PDF page, a slide, a clause
and its headings, or a log line. Nothing sent to the model changes: the sources come from the
citations it already writes.

```ts
import { askWithFiles, describeLocator, type AskOptions } from "llm-large-files";

declare const options: AskOptions;
const result = await askWithFiles({ ...options, citationMarkers: "remove" });
for (const anchor of result.anchors ?? []) {
  const source = result.sources!.find((one) => one.key === anchor.sources[0])!;
  // "after 'heron' → notes.md, # Notes · line 3" style labels, in Hebrew or English.
  console.log(anchor.at, anchor.label, source.name, source.locators.map((locator) => describeLocator(locator, "en")).join(" + "));
}
```

- **A locator says only what is certain.** When the row, page or clause is not certain, it is
  coarser: the sheet for a total computed over the sheet, or a Hebrew "שורה N" that may be read as
  the text line or as Excel's row; the file for a document line with no clause number of its own.
  It never names a guessed row. `reason` says why, for your logs.
- **`result.citations` keeps its meaning:** `cited[].from` and `to` stay text lines. Rows are in
  `sources` only.
- **A chip is told when its line is complete**, in a `citation` event after the text that holds its
  place: the file of a citation may be named after it on its line. Chips whose file was not read
  during the question are resolved within a second before `run.finish`; past that, a chip keeps a
  coarse locator, `unresolved`.
- **Documents uploaded before 0.99.14** get the same locators from their stored text, except where
  only the upload knows: lines split at 2,000 characters in a CSV or log, and speaker notes. Those
  stay coarse.

#### `SourceLocator`

```ts
type SourceLocator =
  | { kind: "row"; sheetIndex?: number; sheet?: string; row: number; toRow?: number } // a workbook's sheet and Excel row, or a CSV row
  | { kind: "cell"; sheetIndex: number; sheet?: string; row: number; column: string } // reserved: not given in 0.99.14
  | { kind: "sheet"; sheetIndex: number; sheet?: string }
  | { kind: "page"; page: number; toPage?: number }
  | { kind: "slide"; slide: number; toSlide?: number; notes?: true }
  | { kind: "section"; headings?: string[]; numbering?: string } // DOCX, HTML, Markdown: "3.1", "5.", "(ב)"
  | { kind: "line"; line?: number; toLine?: number; time?: string } // a log or text file
  | { kind: "document" };
```

#### `CitedSource`

| Field | Type | What it holds |
|---|---|---|
| `key` | `string` | `` `${documentId}:${from}-${to}` ``, the same in every event and the result; `"?:from-to"` when the file could not be decided. |
| `documentId`, `name` | `string`, optional | The document and its file name. Absent when the citation names no file and the question has several, or two files share the name and the cited lines do not tell them apart. |
| `version` | `string`, optional | The document's version, opaque (16 hex digits): pass it to [`files.readLines`](./library.md#filesreadlinesid-range-access-options) or the preview route, which answer "changed" for a file replaced since. Holds no owner, scope or date. |
| `textVersion` | `number`, optional | The version of the extractor that wrote the document's text (1 until 0.99.15). |
| `from`, `to`, `form` | `number`, `number`, `"line" \| "row"` | The citation as the model wrote it, as in `result.citations.cited`. |
| `locators` | `SourceLocator[]` | Where the lines are: one part, or one per sheet for a range across sheets (at most 4). |
| `basis` | `"text" \| "pages" \| "tool" \| "ingest" \| "outline" \| "none"` | What the place was decided from. |
| `shown`, `seen` | `boolean`, `"shown" \| "noted" \| "part_failed" \| "not_noted" \| "past_end" \| "not_shown"` | Whether the model was shown the lines: by a tool or a file sent whole; through a whole-file read's notes (`noted`), a read whose part with them failed, or whose notes do not cite them; past the end of the file; or not at all. |
| `reason` | `string`, optional | How the locator was found, or why it is no finer: `row_prefix`, `computed_over_sheet`, `l_number_contradicts_claim`, `hebrew_row_tie`, `no_heading_no_number`… |
| `candidates` | `Array<{ documentId?, locator }>`, optional | The places it may be, for an `ambiguous` chip. |
| `quote` | `string`, optional | The cited lines as the model was sent them, at most 300 characters. Not in events unless `eventResults`; never in SSE. |
| `redacted` | `true`, optional | The quote is cut from a result `onToolResult` replaced. |

#### `CitationAnchor`

| Field | Type | What it holds |
|---|---|---|
| `at` | `number` | The place in `result.text`, in UTF-16 units, at most its length: the text of the `text` events joined. Never inside code or at the start of a line; with `"token"`, where its token starts. |
| `requestId` | `string` | The request whose text holds it. |
| `sources` | `string[]` | The `key` of each source it opens, in the order cited. |
| `status` | `"resolved" \| "ambiguous" \| "unresolved"` | `ambiguous`: see `candidates`; `unresolved`: past the end of the file, or not read in time. (`"pending"` is reserved.) |
| `label` | `number` | Its number in the answer, from 1: the label of `"token"`. |
| `kind` | `"removed" \| "converted"` | Taken out of the text, or put into words there. |

#### `LineTalk`

Counts for your logs, never text: `verdict` (`"none"`, `"harmless"`, `"harmful"`); `left`, the line
and row numbers still in the shown text (`mentions`, `numbers`, `harmfulMentions`, harmless ones
by kind: true log lines, Excel rows whose cells the sentence names, CSV rows; harmful ones by
kind; a 16-hex-digit hash of each); `kept`, citations put into words; `held`, the most characters
the hider held back at once and how many times it held; `ambiguous`, chips that could not be told
apart.

#### insertCitationTokens(text, anchors)

`text` with `⟦label⟧` at each anchor's `at`, in order: what `citationMarkers: "token"` shows, made
from the text of `"remove"`. Also in `llm-large-files/client`. New in 0.99.14.

#### describeLocator(locator, language)

A locator as a short label, `"he"` or `"en"`: "גיליון לקוחות · שורה 8", "page 3", "slide 2 ·
speaker notes", "4. Payments · clause 4.2". An empty string for `{ kind: "document" }`: show the
file's name alone. Also in `llm-large-files/client`. New in 0.99.14.

### `AnswerInfo`

```ts
type AnswerInfo = {
  complete: boolean;
  reason?: "filtered" | "cut" | "blocked" | "language" | "no_answer" | "other";
  finish?: AskResult["finish"];
  finishReason?: string;
};

declare function answerInfoOf(result: Pick<AskResult, "answered" | "finish" | "finishReason" | "blockReason">): AnswerInfo;
```

How an answer ended, in one value to switch on for the message an application shows: the
answer's counterpart of [`errorInfoOf`](./errors-and-retries.md). New in 0.10.0.

`answerInfoOf(result)` tries the reasons in this order: a refused prompt (`blockReason`:
`"blocked"`), a filter (`finish` `"filtered"`), the output limit (`"cut"`), Gemini's `LANGUAGE`
(`finishReason` `"LANGUAGE"` with any `finish` but `"complete"`: `"language"`, which is not a
filter), another reason that asking again does not mend (`"other"`), and no text (`answered`
false: `"no_answer"`). Otherwise the answer is complete. It reads only these four fields, so a result
kept from an earlier version, or built by hand, works too. The messages to show, in Hebrew and
English: [errors and reliability](../guides/errors-and-reliability.md#filtered-and-cut-answers).

| Field | Type | What it holds |
|---|---|---|
| `complete` | `boolean` | True when the answer came whole: not stopped by a filter or the output limit, and not refused. |
| `reason` | `"filtered" \| "cut" \| "blocked" \| "language" \| "no_answer" \| "other"`, optional | Why it is not complete. `"language"`: Gemini's `LANGUAGE`, a language the model does not take. |
| `finish` | `AskResult["finish"]`, optional | `AskResult.finish`. |
| `finishReason` | `string`, optional | The provider's own word (`AskResult.finishReason`). |

### Question IDs

```ts
declare const QUESTION_ID_PATTERN: RegExp; // /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

declare function createQuestionRegistry(options?: QuestionRegistryOptions): QuestionRegistry;

type QuestionAskOptions = AskOptions & { questionId: string };

interface QuestionRegistry {
  ask(options: QuestionAskOptions): Promise<AskResult>;
  askStream(options: QuestionAskOptions): EventStream<AskEvent, AskResult>;
  stop(questionId: string, access?: Pick<AccessOptions, "owner" | "scope">, reason?: unknown): boolean;
  stats(): QuestionRegistryStats;
}

type QuestionRegistryStats = { running: number; kept: number; keptBytes: number };

declare class QuestionConflictError extends Error {
  constructor(questionId: string);
  readonly code: "question_conflict";
  readonly questionId: string;
  static is(value: unknown): value is QuestionConflictError;
}
```

New in 0.99.9. A stream to the browser can break: a proxy closes it, or a phone changes networks.
The page then sends the request again, and the question is asked again and paid for twice. A
question ID lets the server tell a request sent again from a new question:

- The client makes the ID, one per question (`crypto.randomUUID()`), and sends it again with the
  same question when it retries.
- [`AskOptions.questionId`](#askoptions) labels the question: every event and the result carry
  it. The model never sees it.
- `createQuestionRegistry()` runs questions by it. A request sent again joins the question that is
  still running, or gets its answer, instead of asking the model again.

**`QUESTION_ID_PATTERN`.** A question ID is 1 to 128 characters: letters, digits, `.`, `_`, `:` and
`-`, starting with a letter or a digit. A UUID fits. `askWithFiles` and the registry refuse any
other value with a `TypeError`: "questionId must be a string of 1 to 128 characters: letters,
digits, ".", "_", ":" or "-", starting with a letter or a digit, such as a UUID the client made for
this question."

**`createQuestionRegistry(options?)`** makes a registry. Create it once per process, at startup,
next to `createLargeFiles`: a registry made for each request holds nothing.

| Option | Type | Default | What it does |
|---|---|---|---|
| `keepMs` | `number` | 600,000 (10 minutes) | How long a finished answer is kept for a request sent again, from when it finished. 0 keeps none. `Infinity` keeps each until `maxQuestions` or `maxBytes` pushes it out. |
| `detachedMs` | `number` | 30,000 | How long a running question goes on while no request waits for it, before it is stopped. 0 stops it as soon as its last request leaves. `Infinity` (or more than 2,147,483,647) runs it to its end, and keeps its answer. |
| `maxQuestions` | `number` | 1,000 | The most questions held, running and kept. At least 1. |
| `maxBytes` | `number` | 33,554,432 (32 MiB) | The most bytes of kept answers: the UTF-8 JSON of each result and its `run.finish` event. An answer larger than this is not kept. |
| `now` | `() => number` | `Date.now` | The clock of `keepMs`, for tests. `detachedMs` runs on timers. |

A value that is not a number is a `TypeError` ("keepMs must be a number, and is "600000"."). NaN
is a `RangeError` ("… Leave it out for the default."), and so is a negative value ("maxBytes must
be 0 or more, and is -1.") and a `maxQuestions` below 1.

**`registry.ask(options)`** takes the options of `askWithFiles`, with `questionId` required
("registry.ask needs options.questionId: the client's ID for this question, such as a UUID."). A
signal that already aborted rejects with its reason, and nothing starts. Then:

1. **Which question it is.** Its key is `owner`, `scope` and `questionId`: the same ID from another
   user, or in another scope, is another question. What it asks is a hash of `messages`,
   `documentIds`, `system` and the ids of `model` and `explorer`. Limits, budget, callbacks and the
   other options are not part of it. Messages that JSON cannot hold are a `TypeError` ("questionId
   needs messages, documentIds and system that JSON can hold: …").
2. **Another question under the ID** (other messages, documents, system text or models) is a
   `QuestionConflictError`, while the first one runs and while its answer is kept. Nothing is
   asked. Once the answer has expired, the ID may name a new question.
3. **The same question, running:** the request joins it. It gets the events from the moment it
   joined: no `run.start`, a `seq` above 1, and `run.finish` or `run.error` last. It gets the text
   from then on (`onText`), and the same result. Its other options are not used: the running
   question's apply, its `streamText` among them.
4. **The same question, answered** within `keepMs`: the request gets a copy of the kept result at
   once. Its `onEvent` gets the run's `run.finish` event alone, with the same `seq`, `runId` and
   `questionId`; a throw from it rejects the request. No model request is made.
5. **Otherwise** the question starts: `askWithFiles` with these options, under a signal of the
   registry's. `streamText` is what `askWithFiles` makes of this request's options, so the
   requests are those `askWithFiles` would send.

How a question ends, and what each request gets:

- **With an answer:** each request that waits gets a copy of the result. The answer is kept for
  `keepMs`, unless it is larger than `maxBytes`. The oldest kept answers go first when the registry
  holds more than `maxQuestions` questions or `maxBytes` of answers.
- **With an error,** a stop included: every request that waits rejects with the same error, so
  [`partialResultOf(error)`](#partialresultoferror) works for each. Nothing is kept: a request sent
  again runs the question again.
- **A request whose signal aborts** (the browser went away, `writeSseEvents` stopped reading)
  leaves the question and rejects with the signal's reason. The question goes on while another
  request waits. When none is left, it goes on for `detachedMs`, so that a request sent again can
  join it, then stops with an `AbortError`: "Nobody waited for the answer to this question.".
- **A listener that throws** (`onEvent`, `onText`, `onActivity` or `onStep` of one request) takes
  that request off the question, and the request rejects with what it threw. The question goes on
  for the others.
- **When every place is taken by a running question** (`maxQuestions` running, none kept), a new
  one runs as `askWithFiles` runs it, and is not kept.

**`registry.askStream(options)`** is the same as a stream of events, as
[`askStream`](#askstreamoptions) gives it: `streamText` defaults to true. A `TypeError` or a
`QuestionConflictError` is thrown at once, before any event, so a route can still answer with a
status. Leaving the loop early takes only this request off the question.

**`registry.stop(questionId, access?, reason?)`** stops the running question of that owner and
scope for every request that waits: each rejects with `reason`, or with an `AbortError` "The
question was stopped.". It returns true when one was running. A kept answer stays. A request sent
again after it runs the question again.

**`registry.stats()`** gives `{ running, kept, keptBytes }`, after dropping the answers that
expired. Expiry needs no timer: it is checked by `ask`, `askStream` and `stats`.

What to know:

- **Memory.** A kept answer holds `toolTurns`, the text the tools read. `maxBytes` and
  `maxQuestions` bound them; a question that runs is never kept past `maxQuestions`.
- **One process.** The registry is in memory. A request sent again that reaches another process
  runs the question again ([Deployment](../guides/deployment.md#streamed-answers-behind-proxies)).
- **Owners.** With owners, an ID of one user never reaches another user's question. Without an
  owner or a scope, every caller shares one space of IDs: make them unguessable
  (`crypto.randomUUID()`), as the question asked must match too.

**`QuestionConflictError`** is what `registry.ask` rejects with, and `registry.askStream` throws,
for an ID that names another question: "This questionId was already used for another question:
other messages, documents or models. Use a new questionId for a new question." `name` is
`"QuestionConflictError"`, `code` is `"question_conflict"`, and `questionId` is the ID.
`QuestionConflictError.is(error)` tells one apart also when another copy of the package made it.
[`errorInfoOf`](./errors-and-retries.md#errorinfooferror) gives category `"input"`, code
`"question_conflict"`, status 409 and `retryable: false`. It has no `status` field.

```ts
import { createQuestionRegistry, type AskResult, type ChatMessage, type LargeFiles, type ModelAdapter } from "llm-large-files";

// Once per process, next to createLargeFiles.
const questions = createQuestionRegistry();

// questionId comes from the client: the same on every retry of this question.
export function answerOnce(files: LargeFiles, model: ModelAdapter, userId: string, documentIds: string[], messages: ChatMessage[], questionId: string, signal: AbortSignal): Promise<AskResult> {
  return questions.ask({ files, model, owner: userId, documentIds, messages, questionId, signal });
}
```

Guide: [web app](../guides/web-app.md#when-the-stream-breaks-a-question-id) (a route, and a page
that sends a question again).

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
> citations. Say plainly what you could not find. Answer in the language of my question.

When files were also sent whole, with their lines numbered or tables the tools count, the line
says to answer from them too (new in 0.10.0; it is not exported):

> Stop using tools now. Answer my question using only the files shown in full and what the tools
> returned above, with line citations. Say plainly what you could not find. Answer in the language
> of my question.

### `FINAL_ANSWER_AFTER_PAGES`

The same, when every document went in whole and the only tool was `view_pages`:

> Stop using tools now. Answer my question from the text of the files and the pages you looked at.
> Say plainly what you could not see or find. Answer in the language of my question.

### `FINAL_ANSWER_WITHOUT_TOOLS`

The same, when no tool call was answered in the question (an explorer called none, the first reply
was empty, or no turn was left for tools), so there is no tool result to answer from:

> Answer my question now, from what is in this conversation. No tools are available for this reply:
> if the answer needs a part of a file that is not shown here, say so plainly. Answer in the language
> of my question.

They all end with "Answer in the language of my question." since 0.8.0: a model asked in Hebrew
answered in English after an English closing request. To have answers in one language whatever
the question, say so in `system`.

None of them is kept in the conversation or in `toolTurns`. Nor is the note of the answer's
second try, which is not exported (new in 0.6.0): "Your last reply had no text. No tool can be
called in this reply: write the answer now, in text, from what is above."

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
type ToolTurn = { role: "tools"; version?: number; calls: Array<ToolCall & { result: ToolResult }> };

declare const TOOL_TURN_VERSION: 1;
```

One round of tool use as an application stores it: the calls of one model turn, each with what the
tool returned ([`ToolResult`](./tools.md#toolresult)), in call order. Plain JSON that belongs to no
provider. `askWithFiles` returns them in `result.toolTurns`; passed back in `messages`, the model
sees in a later question what its tools returned in an earlier one. Their results are sent without
`tool_turns_left`, which counted the turns of their own question (since 0.6.0; what `toolTurns`
holds is unchanged). A call whose result is still in the conversation in full is then not run
again: it is answered with a pointer (`already_shown: true`). Not with a model that declares
`clearsToolResults`, and not for a read of one line made in an earlier question, or an exact or
regex search that 0.5.0 stored without its last match: those run again (see
[tools](./tools.md#what-askwithfiles-adds-to-results)). Guide:
[conversations](../guides/conversations.md).

`version` is the version of this shape, new in 0.9.0: `TOOL_TURN_VERSION` (1) on the rounds
`askWithFiles` returns, absent on those of earlier versions, which are read as before. It is never
sent to the model: of a stored round, only its calls are. A round of a higher version, made by a
newer version of the package, is refused with a `TypeError` ("A stored tool round (toolTurns) has
version 2: …"), before any request. Catch it to ask again without the old rounds. A test that
compares the rounds whole must expect `version`. Since 0.99.9 every reader of stored rounds refuses
it the same way: [`compactToolTurns`](#compacttoolturnsturns), and `geminiToolTurns`,
`openAiToolTurns` and `anthropicToolTurns`. 0.99.9 reads every shape stored since 0.2; from 0.99.9
on, each version reads at least the shape of the version before it (H7;
[Servers of two versions](../guides/deployment.md#servers-of-two-versions)).

## The adapter contract

An adapter turns the loop's neutral request into a provider's, sends it, and reads the reply back.
Everything else (planning, tools, limits, retries, usage, the request for the answer) is the
loop's, once, for every provider. The built-in adapters are `gemini()` ([gemini](./gemini.md)),
`openAiCompatible()` and `openAiResponses()` ([openai](./openai.md)) and `anthropic()`
([anthropic](./anthropic.md)).

### `ModelAdapter`

```ts
interface ModelAdapter {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
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
| `generateText` | no | A plain completion for the parts of a whole-file read: see [`GenerateText`](#generatetext). The one of the model that explores is used. Without it, `analyze_whole_document` is not offered. It is called on its adapter, as `send` is, so a method of a class may use `this` (since 0.7.1; before, every part read of such a method failed). |

`estimateTokens`, deprecated in 0.6.0 and never called, was removed in 0.99.9: set
`capabilities.tokenScale`. `askWithFiles` sizes every request with the library's `estimateTokens`,
scaled by `tokenScale`.

What `send` must do with the request:

- **A tool round with `raw`** is sent back as `raw`, unchanged: the loop sets it only on rounds
  that this adapter returned. **Without `raw`** (a stored round, or one an explorer of another
  adapter made), build the model turn from `calls`.
- **The results** of a round go in call order, each with its call's `id`. The files of an answer
  (the pages of `view_pages`) go where `capabilities.toolFiles` says. They are of the kinds
  `capabilities.toolFileTypes` lists: a PDF unless it lists images too (0.99.9).
- **The files of a turn** (`ModelTextMessage.files`, 0.99.9) go first in that turn, before its
  parts. The loop puts files of its own there only for adapters that declare `documents`.
- **`toolChoice: "none"`** means the model must answer in text. The tools are still in `tools`.
- **Text:** call `hooks.onText` as text arrives when it is given; return the whole text in
  `reply.text` either way, starting with what was streamed. Pass `hooks.signal` to the request: the
  loop stops waiting for `send` when the signal aborts, and drops what it returns later, but a
  request that goes on holds a connection and may be billed.
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
| `toolFiles` | `"inside" \| "beside" \| "none"` | required | Where `send` puts a file that a tool returned (the pages of `view_pages`): `"inside"` the tool result, `"beside"` it in a user turn of its own, or `"none"` for a model that cannot be sent one. When any model of the question says `"none"`, `view_pages` is not offered. Since 0.7.1 a value that is none of the three (left out by an adapter written in JavaScript) counts as `"none"`. |
| `pageTokens` | `number` | required | About what the model bills for one page it is shown (a PDF page, or a page drawn as an image), in its tokens. The question counts the largest of its models': the pages of a question may take up to half of `budget.reservedTokens`. Since 0.7.1 a value that is missing, NaN, negative or not finite counts as 1,000, as `openAiCompatible()` declares by default: before, it took away the question's limit of pages and, once a page was shown, every count of the room left. |
| `toolFileTypes` | [`readonly ToolFileType[]`](#toolfiletype-documentscapability-and-nativedocumentformat) | `["application/pdf"]` | The kinds of file a tool may hand this model; `toolFiles` says where they go. `view_pages` sends one small PDF when every model of the question takes `"application/pdf"`; else each page drawn as an image, a JPEG when every model takes `"image/jpeg"`, else a PNG when every model takes `"image/png"`; else it is not offered. Ignored with `toolFiles: "none"`. A value that is not a list counts as left out; types the loop does not know are ignored. New in 0.99.9. |
| `documents` | [`DocumentsCapability`](#toolfiletype-documentscapability-and-nativedocumentformat) | none | The uploaded files this model reads natively in a user turn. When every model of the question declares it, small visual files sent whole go to it as the files themselves too, before their text (`ModelTextMessage.files`). Read leniently: unknown formats are dropped, a limit that is not a number above 0 is its default. The built-in adapters declare it only when you pass their `documents` option. New in 0.99.9. |
| `tokenScale` | `number` | 1 | How many of this model's tokens one token of the library's estimate (`estimateTokens`, fitted to Gemini) comes to. A model that counts a third more for the same text says 1.33, and its window is that much smaller in the library's tokens. The question uses the largest of its models'. A value that is not above 0 counts as 1. |
| `outputTokens` | `number` | none | Tokens set aside for the reply, when they come out of the same window as the prompt (Claude's `max_tokens`). The largest of the models' is kept free, but at least a quarter of the window is left for the prompt. |
| `appendOnly` | `boolean` | `false` | True for a model whose earlier turns may not be rewritten (Claude ties its thinking blocks to the turns they were written in). When any model of the question says so, old tool results are not shortened to make room: when the room runs out, the question is answered with what it has, and an overflow is mended only by planning the documents again. When the model that explores is append-only, a note the loop adds after an empty or broken reply stays in its conversation for the rest of the question. |
| `clearsToolResults` | `boolean` | `false` | True for a model whose provider may clear old tool results from the conversation on its side, before the model reads it: Claude's context editing with `clear_tool_uses`, or compaction. When any model of the question says so, no call is answered with a pointer to an earlier result: each call made again runs again, the same call twice in one turn runs twice, and pointers in stored rounds are sent as the stand-in that says to call again. The loop still counts every result as sent, so its room runs out where it would without it. `anthropic()` sets it from its `body`; set it in an adapter of your own whose provider does this. New in 0.6.0. |

With an explorer, every field counts for the pair: the budget is planned for the smaller window
and the larger scale, because both models get the same conversation. Pages go only as a kind of
file both take (`toolFileTypes`), and files go as they are only when both declare `documents`: the
formats they share, with the smaller limits. Guides:
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
type ModelTextMessage = { role: "user" | "assistant"; parts: ModelPart[]; files?: ToolFile[] };
```

A turn of the user or of the model, as text and native parts. It is also a
[`ChatMessage`](#chatmessage): pass one in `messages` to send parts in the provider's own form.

`files` ([`ToolFile[]`](./tools.md#toolfile), new in 0.99.9) are uploaded files sent as they are,
first in the turn, before its parts. The loop adds files of its own only when every model of the
question declares [`documents`](#modelcapabilities): the small visual files sent whole, named
`attached-1.pdf` and so on, with a line before the documents' text that names them. Files you put
in a message are passed on as they are, and counted in the size of the request. Each built-in
adapter sends what it can take, and throws a `TypeError` for another type before anything is sent:

| Adapter | A PDF | An image (PNG, JPEG, GIF, WebP) | Another type |
|---|---|---|---|
| `gemini()` | `inlineData` | `inlineData` | `inlineData` of its type: the provider says whether it reads it |
| `anthropic()` | A `document` block | An `image` block | `TypeError` |
| `openAiCompatible()` | A `file` part | An `image_url` part | `TypeError` |
| `openAiResponses()` | An `input_file` part | An `input_image` part | `TypeError` |

An adapter of your own that does not read `files` drops them: declare `documents` only once it
sends them.

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
then counts its tokens from that text, and its bytes from the larger of the text and the part's
JSON (since 0.9.0; before, from the text alone); otherwise it sizes it by the size of its JSON. Each built-in adapter passes a native
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
it (`dropped: true`) does not, and a result of a stored round is sent in a later question without
it.

### `SendHooks`

```ts
type SendHooks = {
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  onRefresh?: (refused: unknown) => void; // new in 0.99.13
};
```

| Field | What it holds |
|---|---|
| `onText` | Called with the reply's text as it arrives. The loop gives it only for a reply that is shown (never an explorer's) and only when the text is asked for as it is written: `streamText`, on by default with `onText` and in `askStream` (until 0.7.0, whenever the application gave `onText`). An adapter streams when it is given and it can; one that does not stream calls it once the reply is in: `openAiCompatible()`, `openAiResponses()` and `anthropic()` once with the whole text, `gemini()` once for each text part. The text is in `reply.text` either way, and the loop passes on what the adapter did not. The deltas must add up to the start of `reply.text`: the loop passes on the rest of `reply.text` only when it starts with what was streamed, and `result.text` is what was passed on. |
| `signal` | The question's signal. Pass it to the request. |
| `onRefresh` | Call it when a request refused with HTTP 401 is sent again at once with a new token, just before the token is asked for, with the 401 as `refused`. The loop tells it as a [`retry` event](./events.md#retry) with `reason: "auth_refresh"`, `attempt: 1` and `delayMs: 0`, and not to `onActivity`. `gemini()` calls it when its endpoint is `refreshable` (`vertexAi({ accessToken })` as a function). The loop gives it only when the question has an event listener. New in 0.99.13. |

### `ModelReply`

```ts
type ModelReply = {
  text: string;
  calls: ToolCall[];
  raw?: unknown;
  finishReason?: string;
  finish?: "complete" | "cut" | "filtered" | "malformed_call" | "other"; // "other": new in 0.10.0
  blockReason?: string;
  responseId?: string; // new in 0.10.0
  responseModel?: string; // new in 0.10.0
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
| `finish` | How the reply ended, in terms every adapter maps its own to: `"complete"`; `"cut"` at the output limit; `"filtered"` by the provider's safety filters; `"malformed_call"`, a tool call the model tried to make that could not be read (Gemini's `MALFORMED_FUNCTION_CALL`); `"other"`, a known reason that is none of these and that asking again does not mend (new in 0.10.0: `gemini()` gives it for Gemini's `OTHER`, `LANGUAGE`, `FINISH_REASON_UNSPECIFIED`, `NO_IMAGE`, `TOO_MANY_TOOL_CALLS` and `MISSING_THOUGHT_SIGNATURE`). Unset when the adapter does not know. The loop asks once more, with a note, after a reply with no calls that is `"malformed_call"`, or that is empty before any tool ran and is none of `"cut"`, `"filtered"` and `"other"`, while a tool turn is left before the answer. It also asks once more for the answer when its reply has no text and is neither `"filtered"` nor `"other"`: empty and not `"cut"`, or with calls, or `"malformed_call"`. At most two such second tries a question, the answer's included, and none for a reply with `blockReason` or once `limits.requests` or the ceiling of input tokens is reached. A reply `"malformed_call"` with text is not the answer (since 0.10.0). It becomes `result.finish` when it is the last reply. |
| `blockReason` | Why the provider refused the prompt, when it did. A reply with `blockReason` and no calls ends the question: no request for the answer follows, and the result has `answered: false` and this `blockReason`. |
| `responseId` | The provider's ID of this response (Gemini's `responseId`, the `id` of OpenAI and Claude), when it gives one. `gemini()`, `openAiCompatible()`, `openAiResponses()` and `anthropic()` set it. New in 0.10.0. |
| `responseModel` | The model that wrote this response, as the provider names it (Gemini's `modelVersion`, the `model` of OpenAI and Claude). `gemini()`, `openAiCompatible()`, `openAiResponses()` and `anthropic()` set it. New in 0.10.0. |
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
  onRefresh?: (refused: unknown) => void; // new in 0.99.13
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
| `onRefresh` | Optional to call, as `SendHooks.onRefresh`: when a request refused with HTTP 401 is sent again at once with a new token. The read tells it as a `retry` event of its `"reader"` request, with `reason: "auth_refresh"`. New in 0.99.13. |

Throw a `ModelRequestError` for a request that failed, as `send` does: the part is sent again by
the rule of `retry`, and an error without a status is tried once more. The model that asked for the
read, the step and `toolTurns` are told why a part failed by the error's `kind`, its HTTP status
(`status`, `statusCode` or `response.status`), or the code of a connection that failed, never by
its message: a plain `Error` is told as "The model request failed." (see
[`analyze_whole_document`](./tools.md#analyze_whole_document)). The loop stops waiting for
`generateText` when the signal aborts. Guide:
[your own adapter and loop](../guides/own-adapter-and-loop.md).

### `GenerateUsage`

```ts
type GenerateUsage = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; thoughtTokens?: number };
```

The tokens one part-read request used, as far as the provider said, for `onUsage`. The fields mean
what they mean in [`ModelUsage`](#modelusage).

### `ToolFileType`, `DocumentsCapability` and `NativeDocumentFormat`

```ts
type ToolFileType = "application/pdf" | "image/png" | "image/jpeg";
type NativeDocumentFormat = "pdf" | "pptx";
type DocumentsCapability = {
  formats: readonly NativeDocumentFormat[];
  maxFileBytes?: number;
  maxPages?: number;
};
```

New in 0.99.9. `ToolFileType` is a kind of file a tool may hand a model
([`toolFileTypes`](#modelcapabilities)): a PDF, or a page drawn as an image
([Pages as images](../guides/pdfs.md#pages-as-images)). `DocumentsCapability` is what a model reads
as it is in a user turn ([`documents`](#modelcapabilities)):

| Field | Default | What it is |
|---|---|---|
| `formats` | required | The formats it reads: `"pdf"`; `"pptx"` too on the Gemini API. |
| `maxFileBytes` | 4,194,304 (`DEFAULT_NATIVE_FILE_BYTES`) | The most bytes of one file. |
| `maxPages` | 10 (`DEFAULT_NATIVE_PAGES`) | The most pages of one file, slides for a deck. |

The adapters check their `documents` option when they are made: a value that is not an object with
a non-empty list of formats, a format the adapter does not send (`"pptx"` anywhere but `gemini()`),
or a limit that is not a whole number above 0 is a `TypeError` (a `RangeError` for a number), such
as `openAiCompatible(): documents.formats may name only "pdf", and names "pptx".` Which file goes is
in [The file itself](../guides/pdfs.md#the-file-itself-for-small-visual-files).

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
  estimatedInputTokens?: number; // new in 0.10.0
  unmeasuredRequests?: number; // new in 0.10.0
};
```

The usage of one question (`result.usage`): every request it made, whole-file part reads included,
in all and by model.

| Field | What it holds |
|---|---|
| `inputTokens`, `cachedInputTokens`, `outputTokens`, `thoughtTokens` | The sums over every request, as in [`ModelUsage`](#modelusage). |
| `requests` | Requests that were answered. One that failed and was sent again counts once; one that failed in the end does not count. |
| `byModel` | The same totals for each model, keyed by the adapter's `id`. |
| `estimatedInputTokens` | Optional. The input tokens of the requests whose provider did not give them (no usage, or an input of 0), by the library's estimate, in each model's own tokens (`tokenScale`): the chat requests as the loop sized them, and the part reads of a whole-file read by their system text and prompt. The ceiling of the question counts them with `inputTokens`. They are not in `inputTokens` nor in `byModel`. Absent when every request gave its input. New in 0.10.0. |
| `unmeasuredRequests` | Optional. The requests counted in `estimatedInputTokens`. Absent when there was none. New in 0.10.0. |

Guide: [costs and limits](../guides/costs-and-limits.md).

### `UsageMeter`

```ts
declare class UsageMeter {
  readonly totals: UsageTotals;
  add(model: string, usage: Partial<ModelUsage> | undefined, estimatedInputTokens?: number): void;
}
```

Sums the usage of the requests of one question: `askWithFiles` uses one, and you can use one in a
loop of your own. `totals` starts at zero, with an empty `byModel`. `add` counts one request in
`totals` and in `totals.byModel[model]`, and adds each field of `usage` that is a finite number
above 0. With `usage` undefined it counts the request and no tokens. New in 0.10.0: with
`estimatedInputTokens`, your estimate of the request's input in the model's tokens, a request whose
`usage` does not give its input (none, or 0) adds the estimate to `totals.estimatedInputTokens`, and
counts in `totals.unmeasuredRequests`. Without it, such a request is counted as before.

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
  callId?: string;
};
```

What one tool call showed the model of one document: `result.evidence` holds one for each call
that showed something. Since 0.10.0 `askWithFiles` lists before them one entry for each file sent
whole, in the order of its block: `{ tool: "inline", documentId, document, lines: [[1, n]], whole:
true }`, with no `callId`, since no tool call showed it.

| Field | What it holds |
|---|---|
| `tool` | The tool that was called: `"search_document"`, `"read_document"`, `"get_document_overview"`, `"aggregate_table"`, `"analyze_whole_document"`, `"view_pages"`. Or `"inline"`: a file sent whole, every line of which was in the prompt (since 0.10.0). Or `"original"`: the uploaded file of a file sent whole went to the model too, every page in `pages`, with no `lines` and no `whole`, right after its `"inline"` entry (since 0.99.9). |
| `documentId` | The document's ID. |
| `document` | The file's name, when the result gave it. |
| `lines` | The lines the model was shown, merged and in order. A read: its lines. A search: its passages, or each matching line with the lines of context around it, the last matching line of the file included when the search showed it. An overview: the first 30 and the last 20 lines (all of them in a file of 30 lines or fewer). An `aggregate_table` call: its header line and the lines its groups list (the table's other rows were counted, not shown). A whole-file read with `output: "items"`: the line of each item (since 0.10.0). |
| `pages` | The pages it looked at (`view_pages`), or the pages those lines are on, where the tool said. |
| `query` | What was searched for, or the task of a whole-file read. |
| `mode` | `"keywords"`, `"exact"` or `"regex"`, for a search. |
| `totalMatchingLines` | For an exact or regex search: how many lines match in the whole file, often more than were shown. |
| `whole` | True for a whole-file read: other model requests read every line, and the model saw their answer. It has no `lines`, except the lines of its items with `output: "items"`. True too for a file sent whole (`tool: "inline"`), whose `lines` are all of its lines, `[[1, n]]`. |
| `callId` | The tool call it came from, as its events name it (`"call_3"`): the `callId` of its `tool.start` and `tool.end`, whose `evidence` is this entry. `askWithFiles` sets it on every entry but those of the files sent whole (`tool: "inline"`), which no tool call showed: code that matches evidence to `tool.end` skips entries without it. [`evidenceOf`](#evidenceofcall-result) does not set it. New in 0.7.0. |

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

### compactToolTurns(turns)

```ts
declare function compactToolTurns(turns: readonly ToolTurn[]): ToolTurn[];
```

New in 0.10.2. Stored tool rounds made small, for a database that keeps every question: each call's
result is replaced by its [`stubResult`](#stubresultcall-result-hadfiles) stand-in when that is
smaller, and errors and small results stay as they are. It returns copies, and makes the same
rounds that `storeRounds: "compact"` gives, from rounds stored in full (by 0.10.1 and earlier, or
by `"full"`). A later question takes them as any stored round: the model sees that the results were
dropped to make room, and reads again what it needs. A round of a newer version, or whose `version`
is not a number, is a `TypeError`, as in `askWithFiles` (since 0.99.9).

```ts
// Shrink the stored questions of a chat once it is older than a day.
for (const turn of await turns.find({ sessionId, createdAt: { $lt: dayAgo } }).toArray()) {
  await turns.updateOne({ _id: turn._id }, { $set: { toolTurns: compactToolTurns(turn.toolTurns) } });
}
```

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
stand-in, or (without `hadFiles`) its JSON is under 700 characters, or is no larger than its
stand-in would be. That last rule is new in 0.9.0: a search counted by group, or an
`aggregate_table` result, of a few short groups came out larger as a stand-in (845 characters grew
to 1,073), and replaced the result it was meant to shorten. Otherwise, by tool:

| Tool | The stand-in keeps |
|---|---|
| `read_document` | `lines`, `total_lines` |
| `search_document` | `mode`, `query` (its first 200 characters), `total_matching_lines`, `lines_shown` (up to 60 ranges, such as `"120-180"`, the last match's among them when the search showed it); with `group_by`, `group_by`, `total_groups` and the first 30 `groups` |
| `aggregate_table` | `table`, `rows_matched`, `total_groups`, and the first 30 `groups` |
| `analyze_whole_document` | `parts_read`, and the first 6,000 characters of `answer`, followed by "…" when it was longer: the answer cannot be asked for again. A read that lists items (`output: "items"`): `parts_read`, `total_items`, `counts_by_label`, `unverified_items` and the first 20 `items`. Since 0.99.13 the stand-in of an incomplete read also keeps every field that says so (`parts_that_failed`, `notes_cut_short`, `notes_left_out`, `notes_only`, `answer_cut_short`; for items, `parts_failed`, `parts_cut_short` and `more_items`, counted again against the 20 items kept), with the read's own note after the stand-in's, so a later question still knows the answer is incomplete. The stand-in of a complete read is unchanged |
| `view_pages` | `pages`, `total_pages` |
| `get_document_overview`, any other | nothing more than `document` and the note |

Guide: [your own adapter and loop](../guides/own-adapter-and-loop.md).
