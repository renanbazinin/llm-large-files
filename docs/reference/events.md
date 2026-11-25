# Events

This is the reference for the event stream of `llm-large-files`: typed events, in order, for
everything a question or an ingest does while it runs. It lists every event and its fields, the
rules of their order, how they map to the callbacks of earlier versions, what they carry of errors
and documents, `askStream` and `eventStream`, the events of an ingest, Server-Sent Events with
`writeSseEvents`, and the hooks of a tool call for a loop of your own. It is for you if you show a
question's progress in a page, send it to a browser, or log and trace what the library does. New
in 0.7.0.

```ts
import { askStream, askWithFiles, eventStream, newRunId } from "llm-large-files";
import type {
  AskEvent, IngestEvent, LibraryEvent, EventBase, EventError, EventResult, EventStream,
  DocumentRef, IngestStage, NoticeCode, NoticeDisplay, RequestPurpose, RequestRole, ToolOutcome,
  ExtractProgress, ToolCallHooks, ToolRequestHandle, ToolRequestStart, ToolRequestEnd,
} from "llm-large-files";
import { sseMessageOf, writeSseEvents } from "llm-large-files/node";
import type { SseMessage, SseWriteOptions } from "llm-large-files/node";
```

`llm-large-files/gemini` re-exports the type `AskEvent`. It is the same type, documented here.

Contents:

- **Start:** [Events or callbacks](#events-or-callbacks), [The envelope](#the-envelope),
  [A question, event by event](#a-question-event-by-event)
- **The events of a question:** [`AskEvent`](#askevent), [The order of the events](#the-order-of-the-events),
  [`RequestRole` and `RequestPurpose`](#requestrole-and-requestpurpose),
  [`ToolOutcome`](#tooloutcome), [`NoticeCode` and `NoticeDisplay`](#noticecode-and-noticedisplay),
  [How the callbacks map to events](#how-the-callbacks-map-to-events)
- **What events carry:** [Errors: `EventError`](#errors-eventerror),
  [Documents: `eventResults` and `EventResult`](#documents-eventresults-and-eventresult),
  [A listener that throws](#a-listener-that-throws)
- **Reading events:** [`askStream(options)`](#askstreamoptions),
  [`eventStream(run, options?)`](#eventstreamrun-options), [`streamText`](#streamtext),
  [`askGemini`](#askgemini)
- **To a browser:** [`writeSseEvents(response, events, options?)`](#writesseeventsresponse-events-options),
  [`sseMessageOf(event)`](#ssemessageofevent)
- **Ingest:** [`IngestEvent`](#ingestevent), [Stages and units](#stages-and-units),
  [Uploads with progress](#uploads-with-progress),
  [`ExtractInput.onProgress`, for an extractor of your own](#extractinputonprogress-for-an-extractor-of-your-own)
- **Your own loop:** [`ToolCallHooks`](#toolcallhooks)

## Events or callbacks

`askWithFiles` and `askGemini` still take `onText`, `onActivity` and `onStep`. They get the same
strings as in 0.6.0, at the same moments, with or without `onEvent`. Use them for a status line and
a list of steps.

Use events when you need more than strings:

- which tool call or model request a line belongs to, with ids that pair each start with its end;
- how each tool call ended (`ok`, `error`, `refused`…), how long it took, and what it showed;
- each model request: which model, why it was made, its usage, its retries and how it ended;
- the plan, the notices the callbacks never got, and the result at the end;
- one ordered stream to send to a browser, write to a log or turn into traces.

You can pass both: the callbacks run as before, and the events say the same things with more
detail. The events of a question come from `AskOptions.onEvent` or `askStream`; those of an ingest
from `IngestInput.onEvent` or an upload with `Accept: text/event-stream`.

```ts
import { askWithFiles, type AskEvent, type LargeFiles } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";

const model = gemini(geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.8-flash" }));

export async function answer(files: LargeFiles, documentIds: string[], question: string) {
  return askWithFiles({
    files, model, documentIds,
    messages: [{ role: "user", text: question }],
    onText: (delta) => process.stdout.write(delta),
    onEvent: (event: AskEvent) => {
      if (event.type === "request.end") console.error(event.requestId, event.outcome, `${event.ms} ms`, event.usage ?? "");
      if (event.type === "tool.end") console.error(event.callId, event.outcome, event.step ?? event.error ?? "");
      if (event.type === "notice") console.error(`[${event.code}] ${event.message}`);
    },
  });
}
```

The options that turn events on:

| Option | Type | Default | What it does |
|---|---|---|---|
| `AskOptions.onEvent` | `(event: AskEvent) => void` | none | Gets every event of the question, in order. It does not change how the model is asked (see [`streamText`](#streamtext)). A throw from it ends the question with that error. |
| `AskOptions.runId` | `string` | `"run_"` and 16 hex digits | The `runId` of the events. Pass your own to tie them to a request of your app. |
| `AskOptions.eventResults` | `boolean` | `false` | Put each tool result in its `tool.end` event, and the tool rounds in the result of `run.finish` and `run.error`. They hold document text: see [Documents](#documents-eventresults-and-eventresult). |
| `AskOptions.streamText` | `boolean` | `true` with `onText` or in `askStream`, `false` otherwise | Whether the model is asked for the answer as it is written. See [`streamText`](#streamtext). |
| `IngestInput.onEvent` | `(event: IngestEvent) => void` | none | Gets every event of the ingest, in order. A throw from it ends the ingest with that error, and nothing is stored. |
| `IngestInput.runId` | `string` | `"ing_"` and 16 hex digits | The `runId` of the ingest's events. |

`askGemini` takes `onEvent`, `runId`, `eventResults` and `streamText` too, and passes them on.

## The envelope

Every event is a plain object with a `type` and the fields of `EventBase`:

| Field | Type | What it holds |
|---|---|---|
| `seq` | `number` | 1 for the first event of a run, then one more for each event: no gaps, no repeats. |
| `runId` | `string` | The run the event belongs to: the `runId` you gave, or one made for it, `"run_…"` for a question and `"ing_…"` for an ingest. |
| `time` | `number` | When it was emitted, in milliseconds since 1970 (`Date.now()`). |

A run is one call of `askWithFiles` (or `askGemini`, or `askStream`) or of `files.ingest`. A
question that is planned again after its first request was too large is still one run.

`newRunId(prefix?)` makes an id the same way: the prefix (`"run"` by default), `_` and 16 hex
digits, such as `"run_3f9a0c1d2e4b5a67"`.

Events are JSON as they are, but for the result in `run.finish` and `run.error`, which can be large:
[`sseMessageOf`](#ssemessageofevent) makes it smaller. `LibraryEvent` is `AskEvent | IngestEvent`.

## A question, event by event

A question about a log too large to send whole, with one model and no explorer. The model searches
once, then answers. These are the `data:` lines that `writeSseEvents` sends, one per event:

```json
{"type":"run.start","models":{"answer":"gemini-3.8-flash"},"documentIds":["doc_6f1e2a9c4b7d4e0f8a3b5c7d9e1f2a3b"],"seq":1,"runId":"run_3f9a0c1d2e4b5a67","time":1795374302612}
{"type":"plan","inline":[],"searchable":[{"id":"doc_6f1e2a9c4b7d4e0f8a3b5c7d9e1f2a3b","name":"app.log","format":"log","estimatedTokens":325681}],"seq":2,"runId":"run_3f9a0c1d2e4b5a67","time":1795374302638}
{"type":"notice","code":"searching_instead","message":"Too large to read at once: app.log. Searching instead…","display":"activity","seq":3,"runId":"run_3f9a0c1d2e4b5a67","time":1795374302640}
{"type":"request.start","requestId":"req_1","role":"tools","purpose":"turn","model":"gemini-3.8-flash","turn":1,"estimatedInputTokens":5023,"seq":4,"runId":"run_3f9a0c1d2e4b5a67","time":1795374302640}
{"type":"request.end","requestId":"req_1","ms":1210,"outcome":"ok","usage":{"inputTokens":1800,"outputTokens":24},"finish":"complete","finishReason":"STOP","toolCalls":1,"seq":5,"runId":"run_3f9a0c1d2e4b5a67","time":1795374303850}
{"type":"tool.start","callId":"call_1","providerCallId":"fc_1","tool":"search_document","args":{"document_id":"doc_6f1e2a9c4b7d4e0f8a3b5c7d9e1f2a3b","query":"ERROR","mode":"exact","max_results":3},"label":"Search app.log (exact) for “ERROR”","documentId":"doc_6f1e2a9c4b7d4e0f8a3b5c7d9e1f2a3b","round":1,"seq":6,"runId":"run_3f9a0c1d2e4b5a67","time":1795374303851}
{"type":"tool.end","callId":"call_1","outcome":"ok","ms":4,"step":"Search app.log (exact) for “ERROR” — 51 matching lines","evidence":{"tool":"search_document","documentId":"doc_6f1e2a9c4b7d4e0f8a3b5c7d9e1f2a3b","document":"app.log","lines":[[97,97],[194,194],[291,291],[4947,4947]],"query":"ERROR","mode":"exact","totalMatchingLines":51,"callId":"call_1"},"resultCharacters":672,"seq":7,"runId":"run_3f9a0c1d2e4b5a67","time":1795374303855}
{"type":"request.start","requestId":"req_2","role":"tools","purpose":"turn","model":"gemini-3.8-flash","turn":2,"estimatedInputTokens":5461,"seq":8,"runId":"run_3f9a0c1d2e4b5a67","time":1795374303855}
{"type":"text","requestId":"req_2","delta":"The first error is at line 97.","seq":9,"runId":"run_3f9a0c1d2e4b5a67","time":1795374304630}
{"type":"request.end","requestId":"req_2","ms":775,"outcome":"ok","usage":{"inputTokens":2600,"outputTokens":12},"finish":"complete","finishReason":"STOP","toolCalls":0,"seq":10,"runId":"run_3f9a0c1d2e4b5a67","time":1795374304630}
{"type":"run.finish","seq":11,"runId":"run_3f9a0c1d2e4b5a67","time":1795374304631,"result":{"answered":true,"text":"The first error is at line 97.","finishReason":"STOP","steps":["Search app.log (exact) for “ERROR” — 51 matching lines"],"evidence":[{"tool":"search_document","documentId":"doc_6f1e2a9c4b7d4e0f8a3b5c7d9e1f2a3b","document":"app.log","lines":[[97,97],[194,194],[291,291],[4947,4947]],"query":"ERROR","mode":"exact","totalMatchingLines":51,"callId":"call_1"}],"turns":2,"usage":{"requests":2,"inputTokens":4400,"cachedInputTokens":0,"outputTokens":36,"thoughtTokens":0,"byModel":{"gemini-3.8-flash":{"requests":2,"inputTokens":4400,"cachedInputTokens":0,"outputTokens":36,"thoughtTokens":0}}}}}
```

What to see in it:

- The second request is the answer: its reply has text and no tool call. It is still `role`
  `"tools"`, `purpose` `"turn"`, as a model that may call tools.
- The text came in one piece, once the reply was in, because this question was asked with
  `streamText: false` (`askStream({ ..., streamText: false })`; `onEvent` alone, without `onText`,
  does the same). With `onText`, in `askStream` by default, or with `streamText: true`, it comes in
  many `text` events as it is written.
- `onEvent` gets the same 11 events. Its `run.finish` holds the whole result, without
  `toolTurns`: `writeSseEvents` sends a smaller one (see [`sseMessageOf`](#ssemessageofevent)).

## The events of a question

### `AskEvent`

The events of `askWithFiles`, `askGemini` and `askStream`, by `type`:

| `type` | When |
|---|---|
| [`run.start`](#runstart) | Always first. |
| [`plan`](#plan) | After `run.start`, before any request. Again after a `replanned` notice. |
| [`request.start`](#requeststart) | A model request starts: a turn of the chat, or one request of a whole-file read. |
| [`retry`](#retry) | That request failed and is sent again after a wait. |
| [`text`](#text) | Answer text arrives. |
| [`request.end`](#requestend) | The request ended, after any retries. |
| [`tool.start`](#toolstart) | A tool call starts to run, or is settled without running. |
| [`tool.progress`](#toolprogress) | Progress of a long tool call: a whole-file read. |
| [`tool.end`](#toolend) | The tool call ended. |
| [`notice`](#notice) | Something the question did that is not a request or a tool call. |
| [`run.finish`](#runfinish) | Always last when the question returns. |
| [`run.error`](#runerror) | Always last when the question throws, an abort included. |

Each event also has `seq`, `runId` and `time` ([the envelope](#the-envelope)). Fields marked
optional are left out, not set to `undefined`, unless the table says so.

#### `run.start`

| Field | Type | What it holds |
|---|---|---|
| `models` | `{ answer: string; explorer?: string }` | The adapter ids: the model that answers, and the explorer when there is one that is not the same adapter. `answer` is `""` when `model` is missing. |
| `documentIds` | `string[]` | The `documentIds` of the question, as given (a copy). `[]` when they are not an array. |

It is sent before the options are checked: a question whose options do not work sends `run.start`
and then `run.error`.

#### `plan`

| Field | Type | What it holds |
|---|---|---|
| `inline` | [`DocumentRef[]`](#documentref) | The documents whose whole text goes into the prompt. |
| `searchable` | [`DocumentRef[]`](#documentref) | The documents the model reaches through tools. |

##### `DocumentRef`

| Field | Type | What it holds |
|---|---|---|
| `id` | `string` | The document ID. |
| `name` | `string` | The file name. |
| `format` | `DocumentFormat` | `"text"`, `"log"`, `"pdf"`… |
| `estimatedTokens` | `number` | The library's estimate of the document's tokens. |
| `pages` | `number`, optional | For a PDF, a PPTX or an XLSX (its sheets). |

#### `request.start`

| Field | Type | What it holds |
|---|---|---|
| `requestId` | `string` | Unique in the run: `"req_1"`, `"req_2"`… A question planned again goes on counting. |
| `role` | [`RequestRole`](#requestrole-and-requestpurpose) | Which model the request goes to: `"tools"`, `"explorer"`, `"answer"` or `"reader"`. |
| `purpose` | [`RequestPurpose`](#requestrole-and-requestpurpose) | Why it is made. |
| `model` | `string` | The adapter id of the model the request goes to. |
| `turn` | `number`, optional | For a request of the chat (not `"reader"`): its number in the question, from 1, as `AskResult.turns` counts. |
| `callId` | `string`, optional | For a `"reader"` request: the tool call of the whole-file read it belongs to. |
| `detail` | `string`, optional | For a `"reader"` request: `"part 3 of 12"`, `"first half of part 3 of 12"`, `"round 2: 1 of 4"` (combining notes), or `"the answer"`. |
| `estimatedInputTokens` | `number`, optional | For a request of the chat: the library's estimate of its input tokens, before it is sent. |

A request that the provider refused as too large, and that is made smaller and sent again, is two
requests: the first ends with `outcome: "error"` and `error.kind: "context_overflow"`, then a
`room_made` notice, then a new `request.start`.

#### `retry`

| Field | Type | What it holds |
|---|---|---|
| `requestId` | `string` | The request sent again. |
| `attempt` | `number` | 1 for the first retry. |
| `delayMs` | `number` | The wait before it is sent again. |
| `error` | [`EventError`](#errors-eventerror) | Why it failed, in words for users. |
| `message` | `string` | The line `onActivity` gets for a retry of a chat request: "The model did not answer (HTTP 503). Trying again…". |

The retries of a `"reader"` request (a whole-file read) are told only here: `onActivity` never got
them.

#### `text`

| Field | Type | What it holds |
|---|---|---|
| `requestId` | `string` | The request whose reply holds the text. |
| `delta` | `string` | The text, as `onText` gets it. |

Joined, the deltas of a run are `AskResult.text`. Only the text that is shown comes: the answering
model's, never an explorer's. When a later reply adds text, it starts with a delta of `"\n\n"`, as
for `onText`.

#### `request.end`

| Field | Type | What it holds |
|---|---|---|
| `requestId` | `string` | The request that ended. |
| `ms` | `number` | From `request.start` to now, retries and their waits included. |
| `outcome` | `"ok" \| "error"` | How it ended. |
| `usage` | `Partial<ModelUsage>`, optional | What the provider said this request used. For a `"reader"` request, the sum of all its sends. |
| `finish` | `"complete" \| "cut" \| "filtered" \| "malformed_call" \| "other"`, optional | How the reply ended, in the library's words. Chat requests only. `"other"` is new in 0.10.0: `gemini()` gives it for Gemini's `OTHER`, `LANGUAGE` and four more reasons. |
| `finishReason` | `string`, optional | How the reply ended, in the provider's words. Chat requests only. |
| `toolCalls` | `number`, optional | How many tool calls the reply asked for. Chat requests with outcome `"ok"`. |
| `responseId` | `string`, optional | The provider's ID of the response (`ModelReply.responseId`), when the adapter gives one: to find the request in the provider's logs. Chat requests only. New in 0.10.0. |
| `responseModel` | `string`, optional | The model that wrote the response, as the provider names it (`ModelReply.responseModel`), when the adapter gives one: the exact version behind an alias. Chat requests only. New in 0.10.0. |
| `error` | [`EventError`](#errors-eventerror), optional | With outcome `"error"`: why. |

A request that failed does not always end the question. An overflow is made smaller and sent
again, and a part of a whole-file read that fails is read in halves or reported to the model.

#### `tool.start`

| Field | Type | What it holds |
|---|---|---|
| `callId` | `string` | Unique in the run: `"call_1"`, `"call_2"`… in call order. |
| `providerCallId` | `string`, optional | The provider's own id of the call, when it sent one (`ToolCall.id`). |
| `tool` | `string` | The tool's name: `"search_document"`, `"read_document"`… |
| `args` | `Record<string, unknown>` | The arguments as the model sent them. |
| `label` | `string` | One line of plain text: "Search app.log (exact) for “timeout”". It can quote the model's words: show it as text, never as HTML. |
| `documentId` | `string`, optional | `args.document_id`, when it is a string. |
| `round` | `number` | The turn of the tool loop the call came in, from 1. |

A call that runs starts when it gets its turn to run. A call settled without running (refused,
answered with a pointer, not well formed, over `limits.callsPerTurn`) starts too, and ends with the
outcome that says so.

#### `tool.progress`

| Field | Type | What it holds |
|---|---|---|
| `callId` | `string` | The whole-file read. |
| `stage` | `"map" \| "reduce"` | `"map"`: parts read (requests with purpose `"part"`). `"reduce"`: notes combined, or the answer written (`"merge"`, `"final"`). |
| `done` | `number` | How many are done. |
| `total` | `number` | How many there are. |
| `message` | `string` | "Reading app.log: part 3 of 12". `onActivity` gets it with `"…"` after it. |

#### `tool.end`

| Field | Type | What it holds |
|---|---|---|
| `callId` | `string` | The call that ended. |
| `outcome` | [`ToolOutcome`](#tooloutcome) | How it ended. |
| `ms` | `number` | From `tool.start` to now. Ends come in call order, so this includes the wait for the calls before it in the turn. |
| `step` | `string`, optional | The finished step, as `onStep` got it. Absent for `"not_run"` (one `calls_not_run` notice says it for all of them), and for a call ended because its turn failed. |
| `evidence` | [`Evidence`](./ask.md#evidence), optional | What the call showed the model, with this `callId`. Each entry of `AskResult.evidence` that a call made has its `callId` too, so you can find the call it came from. The entries of the files sent whole (`tool: "inline"`, new in 0.10.0) have none: no call made them. |
| `resultCharacters` | `number`, optional | The characters of the JSON result the model was sent. 0 for a call ended because its turn failed. |
| `error` | `string`, optional | When the result the model was sent is an error (outcomes `"error"`, `"refused"`, `"not_run"`): its message. For a call ended because its turn failed: why, as in `EventError.message`. |
| `result` | [`ToolResult`](./tools.md#toolresult), optional | The result the model was sent. Only with `eventResults: true`: it holds document text. |

#### `notice`

| Field | Type | What it holds |
|---|---|---|
| `code` | [`NoticeCode`](#noticecode-and-noticedisplay) | What happened. |
| `message` | `string` | One line of plain text, word for word what the callback got when there was one. |
| `display` | [`NoticeDisplay`](#noticecode-and-noticedisplay) | Where it went in the callbacks: `"activity"`, `"step"` or `"none"`. |
| `documentIds` | `string[]`, optional | The documents the notice is about: those left out (`"documents_missing"`), the one found gone (`"document_gone"`), the one whose pages were not looked at (`"page_looks_busy"`). New in 0.9.0. |
| `discardText` | `true`, optional | With `"answer_filtered"` under `AskOptions.filteredAnswer: "drop"`: text of the question was already sent (`text` events, `onText`), and the answer is dropped. The page takes away the text it showed for the question, and shows its own message. Absent when no text was sent. See [filtered and cut answers](../guides/errors-and-reliability.md#filtered-and-cut-answers). New in 0.10.0. |

#### `run.finish`

| Field | Type | What it holds |
|---|---|---|
| `result` | [`EventResult`](#documents-eventresults-and-eventresult) | A copy of the result `askWithFiles` returns, without `toolTurns` and with a plan that names the documents only, unless `eventResults: true`. |

Nothing comes after it.

#### `run.error`

| Field | Type | What it holds |
|---|---|---|
| `error` | [`EventError`](#errors-eventerror) | Why the question failed, in words for users. The error that is thrown keeps the provider's words. |
| `partial` | [`EventResult`](#documents-eventresults-and-eventresult), optional | What [`partialResultOf(error)`](./ask.md#partialresultoferror) gives: what the question found before it failed, without `toolTurns` unless `eventResults: true`. Absent for an error before the question was under way (a missing document, options that do not work). |

Nothing comes after it.

### The order of the events

These hold for every run.

1. **One run, counted.** `seq` goes 1, 2, 3… without gaps, and every event has the same `runId`.
2. **First and last.** `run.start` is always first. Exactly one terminal event, `run.finish` or
   `run.error`, is always last. Nothing comes after it: work that goes on after a question
   stopped, such as a part read whose adapter does not look at the signal, is never reported.
3. **The plan before the requests.** `plan` comes after `run.start` and before the first
   `request.start`. The `searching_instead` notice, when there is one, comes after it.
4. **Requests in pairs.** Each `request.start` has one `request.end` with the same `requestId`,
   after it. Its `retry` and `text` events come between them. A request that is made smaller and
   sent again is a new request.
5. **Tool calls in pairs.** Each `tool.start` has one `tool.end` with the same `callId`, after it.
   Its `tool.progress` events come between them, and so do the `"reader"` requests of a whole-file
   read, whose `callId` names it.
6. **A turn's tool calls.** The `request.end` of the reply comes before the `tool.start` events of
   its calls. The calls of one turn run a few at a time (up to four, and looks at pages one after
   another), so their starts, progress and reader requests interleave. Their ends come in call
   order: a call that finished early waits for the calls before it. Calls settled without running
   start as soon as the turn is planned, before the calls that run. Calls over
   `limits.callsPerTurn` start and end one after another, after the ends of the calls that ran,
   and then comes one `calls_not_run` notice.
7. **A failed turn.** When a turn fails (the question was stopped, or a listener threw), the calls
   still open end with outcome `"error"`, in call order, and their reader requests end with them,
   before `run.error`. Treat any start that has no end in a run that ended with `run.error` as
   ended by it.
8. **Planned again is one run.** When the first request was too large for the model and the
   documents are planned again, the run goes on: one `run.start`, the first `plan`, the failed
   `request.start` and `request.end`, a `replanned` notice, a second `plan`, and the rest.
   `requestId`, `callId` and `turn` go on counting.
9. **Notices where they happen.** `writing_answer` comes before the `request.start` of the
   answer after the tools. `budget_reached` comes where the limit is reached: before the answer's
   request when it stops the tools, or after the answer's `request.end` when it keeps the answer
   from being asked for again. `no_room` and `results_shortened` come while a turn is planned,
   before its `tool.start` events. `room_made`, `nudged` and `answer_again` come after the
   `request.end` of the request they are about, before the next `request.start`. `blocked` comes
   right after the `request.end` of the reply the provider refused. `answer_filtered` and
   `answer_cut` come last, right before `run.finish`, after every `text` event of the question
   (new in 0.10.0).

### `RequestRole` and `RequestPurpose`

`RequestRole`: which model a request goes to.

| Role | The request |
|---|---|
| `"tools"` | A turn of the one model of a question without an explorer, in which it may call tools. Its reply can also be the answer. |
| `"explorer"` | A turn of the explorer model, which only calls tools. |
| `"answer"` | A request of the model that writes the answer: the request after the tools, or the one request of a question that needs no tools. |
| `"reader"` | One request of a whole-file read (`analyze_whole_document`), made for one tool call. It goes to the model that explores. |

`RequestPurpose`: why a request is made.

| Purpose | Role | The request |
|---|---|---|
| `"turn"` | `"tools"`, `"explorer"` | A turn of the tool loop. |
| `"nudge"` | `"tools"`, `"explorer"` | The same turn asked again after an empty reply or a tool call that could not be read. |
| `"closing"` | `"answer"` | The request for the answer after the tools. |
| `"answer_again"` | `"answer"` | The answer asked for again after it came back without text. |
| `"direct"` | `"answer"` | The one request of a question that needs no tools: every document went in whole and no page can be looked at. |
| `"part"` | `"reader"` | A whole-file read reading one part, or half of one. |
| `"merge"` | `"reader"` | A whole-file read combining notes. |
| `"final"` | `"reader"` | A whole-file read writing its answer. |

### `ToolOutcome`

How a tool call ended (`tool.end.outcome`):

| Outcome | The call |
|---|---|
| `"ok"` | Ran and returned a result. |
| `"error"` | Ran, or was checked, and returned `{ error }`: bad arguments, a document it cannot read, a regex that took too long, a call that did not arrive whole. Or it was ended because its turn failed (the question was stopped, or a listener threw): then the model was sent nothing. |
| `"refused"` | Was not run, for a limit of the question: its cost, the room left in the conversation, the reads of a whole file. Since 0.10.0 also a call of a tool the question does not have, and a result that `AskOptions.onToolResult` rejected (`{ reject }`): the model was sent the error. |
| `"already_shown"` | Repeated a call whose result is still in the conversation, and was answered with a pointer to it. |
| `"not_run"` | Was over `limits.callsPerTurn` for its turn. |
| `"redacted"` | Ran, and `AskOptions.onToolResult` replaced its result: the model was sent the replacement, with `redacted: true`. `evidence`, `step`, `resultCharacters` and `result` tell the replacement. New in 0.10.0. |

### `NoticeCode` and `NoticeDisplay`

`NoticeDisplay` says where a notice went in the callbacks: `"activity"` to `onActivity`, `"step"`
to `onStep` and `AskResult.steps`, `"none"` to neither. The `"none"` notices are new in 0.7.0.

| Code | Display | When | Message |
|---|---|---|---|
| `"searching_instead"` | activity | Documents too large to send whole are searched instead. | "Too large to read at once: app.log. Searching instead…" |
| `"writing_answer"` | activity | The tools are done and the answer is asked for. | "Writing the answer…" |
| `"replanned"` | step | The question started again with less in the prompt. | "The first request was larger than the model's window of 128,000 tokens: the files were planned again to fit it", or another wording of the same |
| `"room_made"` | step | The request was too large for the model, was made smaller and sent again. | "The request was larger than the model takes: older tool results were shortened, and it was sent again" |
| `"nudged"` | step | An empty or malformed reply was asked for again. | "The model's first reply was empty: it was asked again", "The model's tool call could not be read: it was asked to send it again" |
| `"results_shortened"` | step | Older tool results were shortened to make room. | "Older tool results were shortened to make room in the request" |
| `"answer_again"` | step | The answer came back without text and was asked for again. | "The model's answer was empty: it was asked again", "The model called a tool instead of answering: it was asked again for the answer" |
| `"calls_not_run"` | step | A turn had more calls than `limits.callsPerTurn`. | "2 more tool calls in this turn were not run (at most 8 a turn)" |
| `"budget_reached"` | none | The ceiling of input tokens (`limits.inputTokens`, or the default since 0.10.0: the next tool request and the answer would pass it) or `limits.requests` was reached, so no more tools run, or the answer is not asked for again. Once a question. | "No more tools: the question reached its limit of input tokens or requests." |
| `"no_room"` | none | There is no room left in the conversation for another tool result. Once a question. | "There is no room left in this conversation for another tool result." |
| `"blocked"` | none | The provider refused the prompt (`AskResult.blockReason`). | "The provider refused the prompt: SAFETY." |
| `"documents_missing"` | none | Documents of `documentIds` were missing, and the question is answered without them (`onMissingDocuments: "drop"`, see [missing documents](./ask.md#missing-documents)). Before the `plan` event, once a question. `documentIds` names them; `AskResult.missing` lists them too. New in 0.9.0. | "1 of the attached files is no longer available: the question is answered without it." |
| `"document_gone"` | none | A tool call found a document gone during the question: deleted or expired since it was planned. The model was told so in the call's result ("‹id› is no longer available on the server. Ask the user to attach the file again."). Once for each document. `documentIds` names it. New in 0.9.0. | "app.log is no longer available on the server." |
| `"page_looks_busy"` | none | A look at pages waited longer than `pageLookWaitMs` for its turn (`maxConcurrentPageLooks`, [library](./library.md#largefilesoptions)) and was not run. The model was told the server is busy. `documentIds` names the PDF. New in 0.9.0. | "The pages of report.pdf were not looked at: the server was busy with other looks at pages." |
| `"answer_filtered"` | none | A filter of the provider stopped the answer, with or without text (`AskResult.finish` `"filtered"`). Right before `run.finish`. With `filteredAnswer: "drop"`, `discardText` says when text was already sent. New in 0.10.0. | "A filter of the provider stopped the answer before it was finished.", "… before any text came.", or under `"drop"` "… before it was finished: its text was dropped." |
| `"answer_cut"` | none | The answer stopped at the output limit (`AskResult.finish` `"cut"`). Right before `run.finish`. The answer is kept. New in 0.10.0. | "The answer stopped at the model's output limit, so it is incomplete.", or "… before any text came." |

The messages are written for people and may change between versions. Test `code`, not `message`.

New codes come with new versions: 0.9.0 added `"documents_missing"`, `"document_gone"` and
`"page_looks_busy"`, and 0.10.0 `"answer_filtered"` and `"answer_cut"`. In TypeScript, a `switch`
over `NoticeCode` that must handle every code (one with a `never` check in its `default`) no longer
compiles until it handles them. Give such a switch a `default` that shows nothing, or the message.

### How the callbacks map to events

The callbacks of earlier versions get nothing the events do not also say:

| Callback | The events that say the same |
|---|---|
| `onText(delta)` | `text`: `delta` is the same string, and the deltas come in the same pieces. |
| `onActivity(line)` | `tool.start`: `label` + `"…"`, for a call that runs (a call settled without running was never told to `onActivity`). `tool.progress`: `message` + `"…"`. `notice` with `display: "activity"`: `message`. `retry` of a chat request (not `"reader"`): `message`. |
| `onStep(line)` | `tool.end`: `step`, when it is there. `notice` with `display: "step"`: `message`. Together, in order, they are `AskResult.steps`. |

So a page that showed the callbacks can show the events in their place. The example server
(`examples/server.ts`) does: a status line from `tool.start`, `tool.progress`, the `activity`
notices and `retry`; a list of the tool calls, each marked by its `outcome`, with a counter for
whole-file reads; and the answer from `text`.

## What events carry

### Errors: `EventError`

An error in an event is plain data, safe to send to a browser:

| Field | Type | What it holds |
|---|---|---|
| `message` | `string` | A message your users may see. |
| `kind` | `ModelErrorKind`, optional | For a model error: what kind it is (`errorKindOf`): `"rate_limit"`, `"timeout"`, `"auth"`… Since 0.9.0 also for an error with a `status` (0, or 400 to 599) and no `kind` of its own, such as one an adapter of yours throws: the kind its status gives (`classifyModelError`). So a model's error always has its kind. Plain data thrown (`{ status: 429, message }`) gets none. |
| `status` | `number`, optional | For an HTTP error: its status. 0 when no answer came. Since 0.9.0 also 503 for a `DocumentStoreError` and 404 for a `DocumentsNotFoundError`. |
| `name` | `string`, optional | The error's class name: `"ModelRequestError"`, `"AbortError"`, `"DocumentsNotFoundError"`, `"DocumentScopeError"`, `"IngestError"`… Since 0.9.0 a subclass of `DocumentStoreError` or of `IngestError` with a name of its own is named `"DocumentStoreError"` or `"IngestError"` here, so that `errorInfoOf` reads it as its class. |
| `code` | `IngestErrorCode` or `DocumentScopeErrorCode`, optional | For a file `ingest` could not read: why, as [`IngestError.code`](./library.md#ingesterror) (`"too_large"`, `"no_text"`, `"hostile"`, `"busy"`…), so that a page can say it in its own words. New in 0.8.0. Since 0.9.0 also the code of a [`DocumentScopeError`](./library.md#documentscopeerror), with `name` `"DocumentScopeError"`: `"scope_missing"` when the chat was deleted. |

How `message` is written:

- **A model error** (one with a `kind`, or an error with a `status` of 0 or 400 to 599, other than
  the library's own errors and plain data thrown) is told by its kind and status, in
  the library's words: "The model was busy (HTTP 429).", "The model failed on its side (HTTP
  503).", "The model refused the key or token it was sent (HTTP 401).". The provider's own words
  can name projects, hosts or keys: they stay on the error that is thrown, for your logs.
- **A storage error** (`DocumentStoreError`) is told by its own message, which names only the
  code, and so is a `DocumentsNotFoundError`, which names the IDs. **A Node system error** (one with a `code` and a `syscall`) is told as "The file could not
  be read from storage (ENOENT).". Since 0.9.0 its code is told only when it reads as one
  (capitals, digits and `_`): a driver may put a host in `code`.
- **Another `status`** (not 0 or 400 to 599), and plain data thrown with a status
  (`{ status: 429, message }`), is told as "Something went wrong.", as `errorInfoOf` reads it.
  New in 0.9.0: such an error was told in a model's words ("The model was busy (HTTP 429).").
- **Any other `Error`** is told by its message as it is written: the library's own refusals and
  messages ("app.log is empty."), and the reason of an abort. That includes errors your own code
  throws: an adapter, an extractor or a listener of your own. Keep secrets out of their messages,
  or give them a `status`.
- **Anything that is not an `Error`** is told as "Something went wrong.".

An [`IngestError`](./library.md#ingesterror) is told by its message, with `name: "IngestError"` and
its `code`, and with its `status` only for `"too_large"` (413), `"exists"` (409, new in 0.9.0) and
`"busy"` (503): that status is the answer of an upload, not of a model, and the others are all 422. Until 0.8.0 the same refusals were
plain `Error`s, and their events said `name: "Error"`; a test that expects that needs
`"IngestError"`. A [`DocumentScopeError`](./library.md#documentscopeerror) is told by its message, with
`name: "DocumentScopeError"` and its `code` (new in 0.9.0). A store that failed, an abort and a
listener that threw have no `code`.

Where errors appear: `retry.error`, `request.end.error`, `run.error.error` and `ingest.error.error`
are `EventError`s. `tool.end.error` is a string: the error the model was sent, or, for a call
ended because its turn failed, the `message` of the turn's error. An ingest whose store failed to
write the document says only "The document could not be stored. Try again later.", whatever the
store threw. Since 0.9.0 that error also has `name: "DocumentStoreError"` and `status: 503`, so it
reads as the error `ingest` throws.

To show your own words, map the error by `kind` and `name`, as `examples/server.ts` does in its
`userMessage`, and the error of an ingest by `code`. [Errors and reliability](../guides/errors-and-reliability.md) says what each kind
means.

### Documents: `eventResults` and `EventResult`

Events are often sent on to a browser, so by default they carry no tool results, which hold the
text of the documents:

- `tool.end` has no `result`;
- the result in `run.finish` and `run.error` has no `toolTurns`, and its `plan` names each
  document as a [`DocumentRef`](#plan) (id, name, format, estimated tokens, pages) instead of its
  full `DocumentMeta`, which holds the `owner`, the `scope` (such as `[userId, chatId]`), the
  `sha256` of the file, the `original` with its `ref` (where your application keeps the file), the
  headings of the outline and, for a log, the templates of its most frequent lines.

`missing` (new in 0.9.0) is there as in `AskResult`: the IDs of the documents left out.

```ts
type EventResult = Omit<AskResult, "toolTurns" | "plan"> & {
  toolTurns?: ToolTurn[];
  // Since 0.10.0 the full metadata here has no owner, scope, sha256, original or metaVersion, in its
  // type (DocumentMeta before) and at run time.
  plan: {
    inline: Array<DocumentRef | Omit<DocumentMeta, "owner" | "scope" | "sha256" | "original" | "metaVersion">>;
    searchable: Array<DocumentRef | Omit<DocumentMeta, "owner" | "scope" | "sha256" | "original" | "metaVersion">>;
  };
};
```

With `eventResults: true`, `tool.end.result` is the result the model was sent, and
`run.finish.result` and `run.error.partial` have `toolTurns` and the full plan. Use it for a log or an
audit trail on your server, not for a browser. Since 0.10.0 even that plan has no `owner`, `scope`,
`sha256`, `original` or `metaVersion`: they stay on the server. Read them from `AskResult.plan`,
which keeps the full metadata. The result `askWithFiles` returns, `askStream`'s
`result`, and `partialResultOf(error)` always have `toolTurns`: keep them from there, with the
conversation.

What events carry without `eventResults`, and you should know before you send them on:

- `tool.start.args` and `label`, `tool.end.step` and `evidence.query`: what the model asked for, in
  its words, which can quote the documents.
- `text`, `run.finish.result.text` and `steps`: the answer and the steps.
- `plan` (the event, and `plan` in the result): the name, format, size and pages of each document.
- `run.finish.result` and `run.error.partial` whole: besides the answer, `budget` and `lastUsage`,
  the provider's own usage report. [`sseMessageOf`](#ssemessageofevent), the default of
  `writeSseEvents`, leaves these out.

### A listener that throws

A throw from `onEvent` is not swallowed: it ends the question with that error, as a throw from
`onText`, `onActivity` or `onStep` does. What is under way is ended first, and the events say so:

- A throw on a `request.start` ends that request (`request.end` with outcome `"error"`) before it
  is sent.
- A throw on a `tool.start`, or anywhere in a turn, ends the turn: its calls that wait for a slot
  do not run, the calls still running are stopped, and the open ones end with outcome `"error"`.
- A throw from `onEvent` or `onActivity` while a whole-file read runs (its progress, its requests,
  their retries) ends the question with that error. **Changed in 0.7.0:** 0.6.0 turned a throw of
  `onActivity` there into the tool's error, which the model was sent and the question went on.
- A throw on `run.finish` makes `askWithFiles` throw that error: the answer is lost. A throw on
  `run.error` is thrown in place of the question's own error.
- A throw from `IngestInput.onEvent` ends the ingest with that error, and stores nothing. On
  `ingest.finish` too: the document just stored is deleted.

Keep listeners from throwing. When a listener sends events over a network, catch its errors
there.

## Reading events

### askStream(options)

```ts
declare function askStream(options: AskOptions): EventStream<AskEvent, AskResult>;
```

`askWithFiles` as a stream of its events. It starts the question at once and returns an
[`EventStream`](#eventstreamrun-options): an async iterable of the events, its `result`, and
`abort()`.

- `streamText` defaults to `true`: the model is asked for the answer as it is written, so `text`
  events come as it is written. Pass `streamText: false` to ask as `askWithFiles` does without
  `onText`.
- `options.onEvent`, when given, gets each event too, after the stream. A throw from it ends the
  question, but the stream still gets that event, and then `run.error`. A throw on `run.finish`
  leaves the stream ending with `run.finish`, and `result` rejects.
- `options.signal` stops the question, as for `askWithFiles`.

```ts
import { askStream } from "llm-large-files";

// Assumed: files, model and documentIds are those of the chat being answered.
const stream = askStream({ files, model, documentIds, messages: [{ role: "user", text: "What failed first?" }] });
for await (const event of stream) {
  if (event.type === "tool.start") console.error(`${event.label}…`);
  if (event.type === "text") process.stdout.write(event.delta);
  if (event.type === "run.error") console.error(`\nFailed: ${event.error.message}`);
}
// The loop never throws. The result does, with the question's error.
const result = await stream.result.catch(() => undefined);
if (result) console.error(`\n${result.usage.requests} requests, ${result.usage.inputTokens} input tokens`);
```

### eventStream(run, options?)

```ts
declare function eventStream<E, T>(
  run: (onEvent: (event: E) => void, signal: AbortSignal) => Promise<T>,
  options?: { signal?: AbortSignal | undefined },
): EventStream<E, T>;

type EventStream<E, T> = AsyncIterable<E> & {
  result: Promise<T>;
  abort(reason?: unknown): void;
};
```

Runs `run` at once, with a listener and a signal, and gives what it emits as an async iterable.
`askStream` is `eventStream` around `askWithFiles`; the upload handler uses it around
`files.ingest`. Use it for any function that takes an `onEvent` and a `signal`.

| Parameter | Type | Default | What it does |
|---|---|---|---|
| `run` | `(onEvent, signal) => Promise<T>` | required | The run. Pass `onEvent` and `signal` on to it. A throw from it, at once or later, rejects `result`. |
| `options.signal` | `AbortSignal` | none | Aborts `signal` when it aborts. |

How the stream behaves:

- **Read once.** The events wait in memory until they are read: read them, or call `abort()`.
  A second `for await` over the same stream throws a `TypeError`: "These events can be read once."
- **Leaving the loop stops the run.** A `break`, a `return` or a throw in the loop aborts
  `signal` with an `AbortError` ("The events stopped being read."). `result` then rejects with
  it, and the events after it are dropped.
- **The iterable never throws.** It ends after the run's last event, whether the run returned or
  failed. To know how it ended, read the terminal event (`run.error`, `ingest.error`), or await
  `result`.
- **`result`** is what the run returned. It rejects with the run's error. Awaiting it is
  optional: it never goes unhandled.
- **`abort(reason?)`** aborts `signal` with `reason`, or an `AbortError` ("The run was stopped.").
  The stream ends after the run's last event, such as `run.error`.

### `streamText`

`streamText` decides how the model is asked for the answer. `onEvent` alone never changes it:

| `streamText` | The model is asked | `text` events |
|---|---|---|
| `true` | With the adapter's streaming request, when it can stream (`gemini()` with an endpoint that has `streamUrl`, `openAiCompatible()` and `anthropic()` unless `stream: false`). | Many, as the answer is written. From an adapter that cannot stream, once the reply is in: one, or from `gemini()` without `streamUrl`, one for each text part. |
| `false` | With a request whose reply comes whole (`anthropic()` still streams unless `stream: false`, but passes nothing on as it comes). | One for each reply that has text, once the reply is in. |

It defaults to `true` when `onText` is given and in `askStream`, and to `false` otherwise.
`streamText: false` with `onText` gets the text once each reply is in, in one piece. Either way, a
reply whose text follows earlier text of the question comes after a `"\n\n"` delta of its own.

Two things change with it. A streamed reply that fails after its first piece of text is not sent
again: the question throws, since the user has seen part of an answer. And a reply that is not
streamed must be written within the adapter's `firstByteTimeoutMs`, since nothing arrives until
it is done ([Waits on a silent model](../guides/errors-and-reliability.md#waits-on-a-silent-model)).
An explorer's requests are never streamed: their text is not shown.

### `askGemini`

`askGemini` takes `onEvent`, `runId`, `eventResults` and `streamText`, and passes them to
`askWithFiles`. There is no `askGemini` stream: make one with `eventStream`.

```ts
import { eventStream, type AskEvent } from "llm-large-files";
import { askGemini, type AskGeminiOptions, type AskGeminiResult } from "llm-large-files/gemini";

/** askGemini as a stream of its events, as askStream is for askWithFiles. */
export function askGeminiStream(options: AskGeminiOptions) {
  return eventStream<AskEvent, AskGeminiResult>(
    (onEvent, signal) => askGemini({
      ...options,
      streamText: options.streamText !== false,
      signal,
      onEvent: (event) => {
        onEvent(event);
        options.onEvent?.(event);
      },
    }),
    { signal: options.signal },
  );
}
```

## To a browser

### writeSseEvents(response, events, options?)

```ts
declare function writeSseEvents<E extends { type: string; seq: number }>(
  response: ServerResponse,
  events: AsyncIterable<E>,
  options?: SseWriteOptions<E>,
): Promise<void>;
```

From `llm-large-files/node`. Sends events to a browser as Server-Sent Events, one message per
event:

```text
id: 4
event: request.start
data: {"type":"request.start","requestId":"req_1",…,"seq":4,"runId":"run_3f9a0c1d2e4b5a67","time":1795374302640}

```

`id` is the event's `seq`, `event` its `type`, and `data` the JSON of the event itself, its
envelope included, on one line (U+2028 and U+2029 are written escaped). What it does:

1. Writes a `200` with these headers, when no headers are sent yet: `Content-Type:
   text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection:
   keep-alive` and `X-Accel-Buffering: no` (which tells nginx not to buffer).
2. Writes each event as it comes, and waits whenever the client reads slower than events come.
   Every `heartbeatMs` it sends a `: keep-alive` comment, which keeps proxies from closing a
   quiet stream.
3. Ends the response after the last event, unless `end: false`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `heartbeatMs` | `number` | `15_000` | Milliseconds between two `: keep-alive` comments. 0 sends none. |
| `headers` | `Record<string, string \| number \| string[]>` | none | Headers to send besides the event-stream ones, or in their place: a name matches whatever its case. Used only when the headers are not sent yet. |
| `map` | `(event: E) => SseMessage \| undefined` | [`sseMessageOf`](#ssemessageofevent) | What to send for an event: `{ event?, data, id? }`, with `event` and `id` taken from the event when left out. Return `undefined` to skip the event. |
| `end` | `boolean` | `true` | `false` keeps the response open after the last event. |

**When the client goes away**, or someone else ends the response, it stops reading the events and
calls the iterator's `return()`. For an `askStream`, or another `eventStream`, passed in directly,
that stops the run at once. An async generator that wraps one (to rename or skip events) stops it
only at its next `yield`: a run waiting on a long model request goes on until then. To change what
is sent, use `map` and pass the stream itself. If you do wrap it, stop the run yourself:
`response.once("close", () => stream.abort())`.

**It resolves** when the events end or the client goes away. It rejects when the iterable or
`map` throws, after ending the response (an `eventStream` never throws: a run that fails ends with
its error event), and when the headers cannot be written (an invalid value in `headers`), after
stopping the producer and destroying the response.

```ts
import { createServer } from "node:http";
import { askStream, createLargeFiles, FileDocumentStore } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { writeSseEvents } from "llm-large-files/node";

const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });
const model = gemini(geminiApi({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.8-flash" }));

// Assumed: readQuestion() reads and checks the JSON body, and saveToolTurns() keeps the tool
// rounds with the chat (see the conversations guide).
createServer(async (request, response) => {
  const { chatId, question, documentIds } = await readQuestion(request);
  const stream = askStream({ files, model, documentIds, messages: [{ role: "user", text: question }] });
  // Every event goes to the page. If the page goes away, the question stops.
  await writeSseEvents(response, stream);
  try {
    const result = await stream.result;
    saveToolTurns(chatId, result.toolTurns);
  } catch (error) {
    // The page saw run.error. An AbortError means it went away.
    if ((error as Error).name !== "AbortError") console.error(error);
  }
}).listen(3000);
```

To skip events, or to put an error in your app's own words, use `map`:

```ts
import { sseMessageOf, writeSseEvents } from "llm-large-files/node";

// Assumed: response and stream as above, and userMessage() turns an EventError into your app's own words, from its kind and name.
await writeSseEvents(response, stream, {
  map: (event) => {
    // The page does not show requests: skip them.
    if (event.type === "request.start" || event.type === "request.end") return undefined;
    if (event.type === "run.error") return sseMessageOf({ ...event, error: { ...event.error, message: userMessage(event.error) } });
    return sseMessageOf(event);
  },
});
```

`examples/server.ts` is a whole server and page built this way, with a reader of the events in the
browser. [Web app](../guides/web-app.md) has the rest of a chat page: uploads, cancelling,
proxies.

### sseMessageOf(event)

```ts
declare function sseMessageOf<E extends { type: string; seq: number }>(event: E): SseMessage;

type SseMessage = { event?: string; data: unknown; id?: string | number };
```

From `llm-large-files/node`. What `writeSseEvents` sends for an event by default: `{ event: type,
id: seq, data }`, where `data` is the event itself, `type`, `seq`, `runId` and `time` included.
Two events are made smaller:

| Event | `data` |
|---|---|
| `run.finish` | `{ type, seq, runId, time, result }`, where `result` is `{ answered, text, finishReason, blockReason, steps, evidence, turns, usage }`: not `toolTurns`, `plan`, `budget` or `lastUsage`. Keep `toolTurns` on the server, with the conversation. |
| `run.error` | `{ type, seq, runId, time, error, partial }`, where `partial` is `{ steps, evidence, usage }` of the partial result, or `undefined`. |
| Any other event | The event as it is. Ingest events too. |

## Ingest

### `IngestEvent`

The events of `files.ingest`, through `IngestInput.onEvent`:

| `type` | Fields | When |
|---|---|---|
| `ingest.start` | `name: string`, `format: DocumentFormat`, `bytes: number` | Always first, before the input is checked. `name` is the file name as it will be stored; `format` is what the name and type say (a text file can still become a log); `bytes` is the size of the file. For a file ingested from a path ([`IngestFromSource`](./library.md#ingestfromsource), new in 0.9.0), the size `lstat` gives, before any of the file is read; 0 when the path cannot be looked at. |
| `ingest.progress` | `stage: IngestStage`, `done: number`, `total?: number`, `unit: "pages" \| "parts" \| "bytes" \| "characters"` | How far a stage is. `total` is absent when it is not known. See [Stages and units](#stages-and-units). |
| `ingest.finish` | `document: DocumentSummary`, `app?: Record<string, unknown>` | Always last when the document is stored. `document` is [`toDocumentSummary(meta)`](./library.md#documentsummary): the summary an upload's `201` holds, without `owner`. `app` is set only by the upload handler of `llm-large-files/node`: the `answer` its `onUploaded` returned (new in 0.9.0). `files.ingest` never sets it. |
| `ingest.error` | `error: EventError` | Always last when the ingest throws: a refusal, an abort, a store that failed, or a listener that threw. |

Each event also has `seq`, `runId` and `time`. Nothing comes after `ingest.finish` or
`ingest.error`: what an extractor of your own reports after the ingest gave up, or after it
returned, is dropped. An input that is refused at once (an empty file, an owner that is not
allowed) still sends `ingest.start` and then `ingest.error`.

```ts
// Assumed: files is your createLargeFiles(), bytes the uploaded file, userId the signed-in user.
const meta = await files.ingest({
  name: "report.pdf",
  bytes,
  owner: userId,
  onEvent: (event) => {
    if (event.type === "ingest.progress") {
      console.log(`${event.stage}: ${event.done}${event.total !== undefined ? ` of ${event.total}` : ""} ${event.unit}`);
    }
    if (event.type === "ingest.error") console.log(`Not stored: ${event.error.message}`);
  },
});
```

### Stages and units

`IngestStage` is one of seven stages. A file goes only through the stages that apply to it, in
this order, and each stage ends before the next starts:

| Stage | Unit | `total` | What it counts | When |
|---|---|---|---|---|
| `"check"` | pages | the pages | Pages checked before their text is read. | A PDF, with `@cantoo/pdf-lib` installed and `checkPages` on. |
| `"extract"` | pages, or parts | the pages, or the parts | Text read: each page of a PDF; each part of a DOCX (body, footnotes, headers…), each slide of a PPTX or each sheet of an XLSX. | A PDF, DOCX, PPTX or XLSX, or an extractor of your own that reports it. Not a text file. |
| `"pictures"` | pages | the pages | Pages looked at for pictures. | A PDF, with `@cantoo/pdf-lib` installed and `pictures` on. |
| `"decode"` | bytes | the bytes | One event when the file is decoded. | A text file that is not UTF-8, and every HTML file. |
| `"prepare"` | characters | the characters | The text cleaned before it is cut into lines. | Every file, except one that `dedupe` (0.10.2) answers with a document stored before: it has no stage after `ingest.start`, only `ingest.finish`. |
| `"index"` | characters | the characters | The line index built. | A store with `putIndex`, such as `FileDocumentStore`. |
| `"store"` | parts | the writes | Each write to the store, once done: the original file (`keepOriginals`), the line index, then the text. | Every file. |

So with `FileDocumentStore` and `@cantoo/pdf-lib`, a PDF goes through `check`, `extract`,
`pictures`, `prepare`, `index` and `store`, and a UTF-8 log through `prepare`, `index` and
`store`. Measuring the text, the outline and the log profile
report nothing: they are quick.

**Throttling.** Each stage sends at most one `ingest.progress` every 12 ms, however stages take
turns. A progress that completes its stage (`done` reaches `total`) goes out at once. When the
stages end, the last progress of each that was held back goes out, in the order they began. So
the last progress of a stage always has its final `done`, which equals `total` when `total` is
known. A stage with nothing to report may send none. The events cost nothing when no one listens:
without `onEvent`, no progress is worked out.

### Uploads with progress

`createDocumentHandlers(files).upload`, from `llm-large-files/node`, answers with the ingest's
events when the request's `Accept` header names `text/event-stream` itself: not with `q=0`, and
not only through a wildcard such as `*/*` or `text/*`.

1. The checks that answer with an HTTP error come first, as before, in JSON: a missing name
   (`400`), an owner that `getOwner` refused or that is not allowed (its status, `401` or `500`), a
   scope that `getScope` refused or that is not valid (its status, or `500`; new in 0.9.0), a body
   another middleware already parsed (`400`), and a file larger than `maxUploadBytes` (`413`).
2. Then it answers `200` with Server-Sent Events, written by `writeSseEvents`: `ingest.start`,
   `ingest.progress`…, and last one of:
   - `ingest.finish`, whose `document` is the summary a `201` would hold, and whose `app` is the
     `answer` of `onUploaded` (new in 0.9.0). It is sent once `onUploaded` is done;
   - `ingest.error`, whose `error` is `{ message, status }`, the message and status a JSON answer
     would have: `422` with the reason for a file that cannot be read ("empty.txt is empty."),
     `503` "The document could not be stored. Try again." for a store that failed (since 0.9.0),
     `500` "Upload failed (ENOSPC)." for a Node system error, with its code when it reads as one,
     `500` "Upload failed." for any other error, what `onUploaded` threw, and so on, as in the
     [node reference](./node.md#uploadrequest-response). For a file that could not be read, it also
     has `code`, the `IngestError` code (`"empty"`, `"busy"`…; new in 0.8.0). Since 0.9.0, a store
     that failed also has `name` `"DocumentStoreError"`, and a scope error `name`
     `"DocumentScopeError"` and its `code` (`"scope_missing"`, 404, for a deleted chat), so that
     [`errorInfoOf`](./errors-and-retries.md#errorinfooferror) reads it.
3. When the client goes away, the ingest stops and nothing is stored.

It always ends with `ingest.finish` or `ingest.error`, even with a `LargeFiles` of your own whose
`ingest` sends no events: then that one event is all there is, with `seq` 1. Without the header,
`upload` answers `201` with JSON, as in 0.6.0.

In the browser, read the answer as a stream. The `data` of each message is the event itself:

```ts
import type { DocumentSummary, IngestEvent } from "llm-large-files";

/** Uploads a file and reports its progress. Resolves with the summary a 201 would hold. */
export async function upload(file: File, onProgress: (line: string) => void): Promise<DocumentSummary> {
  const response = await fetch("/api/documents", {
    method: "POST",
    body: file,
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), Accept: "text/event-stream" },
  });
  // A missing name, a refused owner or a file too large still get an HTTP error in JSON.
  if (!response.ok) throw new Error((await response.json()).error);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The upload ended without an answer.");
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (!data) continue; // a keep-alive comment
      const event = JSON.parse(data) as IngestEvent;
      if (event.type === "ingest.progress") onProgress(`${event.stage}: ${event.done}${event.total !== undefined ? ` of ${event.total}` : ""} ${event.unit}`);
      if (event.type === "ingest.finish") return event.document;
      if (event.type === "ingest.error") throw new Error(event.error.message);
    }
  }
}
```

### `ExtractInput.onProgress`, for an extractor of your own

An [extractor](./library.md#extractor) gets `onProgress` in its [`ExtractInput`](./library.md#extractinput) when someone listens
to the ingest's events. Call it as the extraction goes on, and the ingest reports it as
`ingest.progress`. An extractor that never calls it works as before: its file has no `extract`
progress. New in 0.7.0.

```ts
type ExtractProgress = {
  stage?: "extract" | "check" | "pictures" | "decode";
  done: number;
  total?: number;
  unit: "pages" | "parts" | "bytes";
};
```

| Field | Type | Default | What it does |
|---|---|---|---|
| `stage` | `"extract" \| "check" \| "pictures" \| "decode"` | `"extract"` | The stage it counts. |
| `done` | `number` | required | How many are done: a finite number from 0. |
| `total` | `number` | unknown | How many there are, when you know. |
| `unit` | `"pages" \| "parts" \| "bytes"` | required | What `done` and `total` count. |

A report that does not fit (another stage or unit, a `done` that is negative or not a number) is
left out, and a `total` that is not a number counts as unknown. Reports after the extractor
returned are dropped. Call it as often as you like: the ingest sends at most one event every
12 ms for each stage, and the last one. A throw from it is the listener's error: let it pass, so
that the ingest ends with it.

```ts
import { createLargeFiles, MemoryDocumentStore, type Extractor } from "llm-large-files";

// Assumed: splitPages() cuts a scanned PDF into page images, and recognize() is your OCR service.
const scannedPdf: Extractor = async (bytes, input) => {
  const pages = await splitPages(bytes);
  const texts: string[] = [];
  for (const [index, page] of pages.entries()) {
    texts.push(await recognize(page, input.signal));
    input.onProgress?.({ done: index + 1, total: pages.length, unit: "pages" });
  }
  return { text: texts.map((text, index) => `--- Page ${index + 1} ---\n${text}`).join("\n\n"), pages: pages.length };
};

export const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { pdf: scannedPdf } });
```

[`ExtractProgress`](./library.md#extractprogress) is in the library reference too, and
[Custom extractors](../guides/pdfs.md#custom-extractors) has more on extractors of your own and
OCR.

## Your own loop

### `ToolCallHooks`

When you run the tools in a loop of your own, [`ToolSet.executeWithFiles`](./tools.md#toolset) takes the listeners of one
call as an optional fourth argument. With them, the progress and the model requests of two
whole-file reads that run at once can be told apart. `askWithFiles` uses them for its events.
New in 0.7.0.

```ts
executeWithFiles(name: string, args: Record<string, unknown>, limits?: ToolCallLimits, hooks?: ToolCallHooks): Promise<ToolOutput>;

type ToolCallHooks = {
  onProgress?: ProgressListener;
  onRequest?: (request: ToolRequestStart) => ToolRequestHandle;
  onDocumentGone?: (documentId: string) => void; // new in 0.9.0
  onPagesBusy?: (documentId: string) => void; // new in 0.9.0
  signal?: AbortSignal; // new in 0.10.0
};
type ToolRequestStart = { purpose: "part" | "merge" | "final"; detail: string };
type ToolRequestHandle = {
  retry(notice: { attempt: number; delayMs: number; error: unknown }): void;
  end(end: ToolRequestEnd): void;
};
type ToolRequestEnd = { outcome: "ok" | "error"; usage?: GenerateUsage; error?: unknown };
```

| Field | Type | What it does |
|---|---|---|
| `onProgress` | `ProgressListener` | Progress of this call, in place of `ToolOptions.onProgress` for it: `{ kind: "map" \| "reduce", message, done, total }`. |
| `onRequest` | `(request: ToolRequestStart) => ToolRequestHandle` | Called as each model request of this call starts, with its `purpose` and `detail` (`"part 3 of 12"`, `"first half of part 3 of 12"`, `"round 2: 1 of 4"`, `"the answer"`). The handle you return is told of each retry of that request, and once of its end, with the usage its part reader reported (summed over its sends) and, on an error, the error. |
| `onDocumentGone` | `(documentId: string) => void` | Called when the document the call names is no longer in the store: deleted or expired since it was planned, or not the caller's. The call's result is the error the model is told. `askWithFiles` makes it a `"document_gone"` notice. New in 0.9.0. |
| `onPagesBusy` | `(documentId: string) => void` | Called when a look at pages (`view_pages`) waited longer than `pageLookWaitMs` for its turn and was not run. The call's result is the error the model is told. `askWithFiles` makes it a `"page_looks_busy"` notice. New in 0.9.0. |
| `signal` | `AbortSignal` | Ends this call alone: its scans, regex searches, whole-file read, look at pages and loads. Joined with `ToolOptions.signal`. New in 0.10.0. |

`onProgress` and `onRequest` are used only by `analyze_whole_document`; the other tools ignore
them, and `view_pages` too. `onDocumentGone` is called by every tool, and `onPagesBusy` by
`view_pages`.
`execute()` takes no hooks. A `ToolSet` of your own may take the fourth argument and ignore it;
code that implements `ToolSet` for 0.6.0 still compiles. Do not throw from the hooks: a throw
becomes a failed part, or the tool's error result, as a throw of `ToolOptions.onProgress` does.
The `error` given to `end` is the provider's own: do not send it to a browser as it is.

```ts
import type { ToolCallHooks } from "llm-large-files";

// Assumed: files, model and documentIds as in your loop, and call is one ToolCall of the model's reply.
const context = await files.prepare(documentIds, { tokens: 1_000, bytes: 4_000 });
const tools = files.tools(context.plan.searchable, { generate: model.generateText });

// The listeners of one call: two whole-file reads that run at once report apart.
const hooks: ToolCallHooks = {
  onProgress: (progress) => console.log(call.id, `${progress.message}…`),
  onRequest: (start) => {
    const began = Date.now();
    console.log(call.id, "request", start.purpose, start.detail);
    return {
      retry: ({ attempt, delayMs }) => console.log(call.id, `retry ${attempt} in ${delayMs} ms`),
      end: ({ outcome, usage }) => console.log(call.id, start.detail, outcome, `${Date.now() - began} ms`, usage?.inputTokens ?? 0),
    };
  },
};
const output = await tools.executeWithFiles(call.name, call.args, {}, hooks);
```

[Your own adapter and loop](../guides/own-adapter-and-loop.md) explains the rest of such a loop.

## Related

- [The tool loop](./ask.md): `askWithFiles`, `AskOptions` (`onText`, `onActivity`, `onStep`),
  `AskResult`, `Evidence`, `partialResultOf`.
- [`llm-large-files/node`](./node.md): `createDocumentHandlers` and every status and body of an
  upload.
- [The library](./library.md): `IngestInput`, `DocumentSummary`, extractors.
- [Tools](./tools.md): each tool, its arguments and results, `ToolSet`.
- [`llm-large-files/gemini`](./gemini.md): `askGemini` and its options.

Related guides: [Web app](../guides/web-app.md) for a chat page that streams answers and uploads,
[Errors and reliability](../guides/errors-and-reliability.md) for what each error kind means and
what to show, and [Conversations](../guides/conversations.md) for keeping `toolTurns` with the
chat.
