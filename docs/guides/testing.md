# Testing an integration

This guide shows how to test code that uses llm-large-files without calling a real model: tests
that run in milliseconds, cost nothing and give the same result every time. It is for application
developers. The samples use [Vitest](https://vitest.dev); the fakes they import from
[`llm-large-files/testing`](../reference/testing.md) do not depend on it.

## What to fake

Fake the layer below the code you test, and nothing above it.

| What you test | What to fake | Section |
| --- | --- | --- |
| Your code around a question: what it stores, shows and streams, and what it does with each error | The model: a scripted `ModelAdapter` | [A scripted model](#a-scripted-model) |
| Your provider setup: the URL, the token, the body fields, how a reply or a stream is read | The network: the `fetch` of a real adapter | [The real adapters with a fake fetch](#the-real-adapters-with-a-fake-fetch) |
| Expiry, owners, deleting | The clock: `now`, with `MemoryDocumentStore` | [Expiry, owners and the clock](#expiry-owners-and-the-clock) |
| Your upload and answer routes | Nothing for uploads, the model for answers: a real server on a free port, called with `fetch` | [Your routes](#your-routes) |
| Whether a real model finds the answer in a real file | Nothing: a few live tests | [Live tests, few and cheap](#live-tests-few-and-cheap) |
| A `DocumentStore` of your own | Nothing: `documentStoreChecks` runs the store against the contract | [Checking your store](./storage.md#checking-your-store) |

The library's own tests work the same way, with the same fakes. Since 0.9.0 they ship in the
package as `llm-large-files/testing`: import them instead of copying them.

## Test documents

Use a new `MemoryDocumentStore` in each test: it keeps documents in process memory, so tests do not
share them and leave nothing behind. `ingest` takes the bytes of a file; for text, encode a string
with `TextEncoder`, which writes UTF-8. To test a file in an older encoding, such as a CSV that
Excel saved in windows-1255, give `ingest` the bytes of a real file: `meta.encoding` then says how
it was read ([Text encodings](./pdfs.md#text-encodings)).

A document that fits goes into the prompt whole (by default up to 200,000 estimated tokens of
documents), and the question is then one model request without tools. To test the tool loop with a
small file, lower `budget.inlineTokens`: with 1,000, a document whose estimate is over 1,000 tokens
becomes a card that the model reaches through the tools, as a 50 MB log would. Set it on
`createLargeFiles`, or for one question with `budget` in `askWithFiles`. How the plan is made is in
[How it works](../how-it-works.md).

The samples encode text with `utf8()` from `llm-large-files/testing`, and use `appLog(count)`, a
log of `count` lines with a failed payment on every 50th, from the file below. From 19 lines on it
is over 1,000 estimated tokens. The samples use 400 lines, which hold 8 failed payments.

```ts
// test/documents.ts: test documents for code that calls askWithFiles.
/** A service log of `count` lines, with a failed payment on every 50th line. */
export function appLog(count: number): string {
  const lines: string[] = [];
  for (let n = 1; n <= count; n++) {
    const time = new Date(Date.UTC(2026, 0, 1, 8, 0, n)).toISOString();
    lines.push(n % 50 === 0
      ? `${time} ERROR [worker-${n % 4}] payment ${n} failed: card declined`
      : `${time} INFO [worker-${n % 4}] GET /api/orders/${n} 200 in ${(n * 37) % 900} ms`);
  }
  return lines.join("\n");
}
```

`serviceLog(lines)` from `llm-large-files/testing` is another: a log with an `ERROR` line every 97
lines, the one the library's own tests use.

## A scripted model

`askWithFiles` talks to a model only through a [`ModelAdapter`](../reference/ask.md#modeladapter):
an object with an `id`, its `capabilities` and a `send` method. `fakeModel` is one that answers
each request from a script and records what it was sent:

```ts
import { calls, fakeModel, says } from "llm-large-files/testing";

// Assumes `meta`, a log ingested as in the tests below.
const model = fakeModel([
  calls([{ name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } }]),
  says("8 payments failed."),
]);
// After the question, model.requests holds each request the loop sent, in order.
```

What the parts do:

- **The script.** One entry for each request, in order. The last entry repeats, so a model that
  always says the same thing is a script of one. An `Error` entry is thrown from `send`, as a real
  adapter throws a request that failed. A function entry gets the request, its number (1 for the
  first) and the hooks, and returns the reply: use it when the reply depends on what was asked.
- **`requests`.** A copy of each request as it was sent, failed attempts included.
- **`onText`.** When your code passes `onText` to `askWithFiles` (or `streamText: true`, or uses
  `askStream`), the loop passes a hook to the adapter, and the fake calls it with the text in two
  pieces, as a stream would arrive. With `onEvent` alone, it does not: the text then comes in one
  `text` event, once the reply is in.
- **The options.** `id` names the model in `usage.byModel`; give two fakes different ones. A
  `generateText` function offers `analyze_whole_document`, the whole-file read in parts; without it
  that tool is not offered. The capabilities make the fake look like a given model. Unless you
  say otherwise they are `toolFiles: "inside"`, as Gemini's, so the loop offers `view_pages` for
  PDFs whose original is kept (see [PDFs](./pdfs.md)), and `pageTokens: 500`. `toolFiles: "none"`
  makes a model that takes no files, `contextTokens` and `maxRequestBytes` make the budget of a
  question fit a model, and `appendOnly: true` makes the loop treat it as Claude (a conversation
  that may only grow). Since 0.99.9, `toolFileTypes: ["image/jpeg"]` makes a model that is shown
  pages as images (the loop then needs a renderer: test that path with a model that takes PDF, or
  with unpdf 2 and `@napi-rs/canvas` installed), and `documents: { formats: ["pdf"] }` one that is
  sent small visual files as they are: `request.messages[0].files` holds them.
- **The replies.** `says(text, more?)` is a reply of text, and `calls(list, more?)` a reply that
  calls tools. `more` adds fields, such as `usage`. The `raw` of a `calls` reply is
  `{ own: [the tool names] }`, a stand-in for the provider's own form of the turn.

Every export, with its defaults, is in the [reference](../reference/testing.md). The source of
`fakeModel` is in the package, in `src/testing/fake-model.ts`. A fake adapter is also the starting
point for one of your own: see [Your own adapter and loop](./own-adapter-and-loop.md).

## A first test

Two tests: a short document that goes in whole, and a log that the model must search. Owner
checks are on by default (since 0.99.9): a test that is not about owners makes its library with
`requireOwner: false`, as a script with one user would; a test of what users see passes the owner,
as your server does ([Expiry, owners and the clock](#expiry-owners-and-the-clock)).

```ts
// test/ask.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { calls, fakeModel, says, utf8 } from "llm-large-files/testing";
import { appLog } from "./documents.js";

const question = (text: string) => [{ role: "user" as const, text }];

describe("questions about documents", () => {
  it("sends a short document whole, in one request without tools", async () => {
    // One user: no owner checks.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    const model = fakeModel([says("Heron.", { usage: { inputTokens: 40, outputTokens: 3 } })]);

    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("What is the code word?") });

    expect(result).toMatchObject({ text: "Heron.", answered: true, steps: [], evidence: [], toolTurns: [], turns: 1 });
    expect(result.usage).toMatchObject({ requests: 1, inputTokens: 40, outputTokens: 3 });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools).toBeUndefined();
  });

  it("searches a log too large to send whole, then answers", async () => {
    // Any document over about 1,000 tokens becomes a card with tools: a small test file takes
    // the path that a real 50 MB log takes.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 }, requireOwner: false });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(appLog(400)) });
    const search = { id: "call_1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const model = fakeModel([calls([search]), says("8 payments failed, the first on line 50 (app.log L50).")]);

    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("How many payments failed?") });

    // The first request offers the tools; the second carries the call and what the tool returned.
    expect(model.requests[0]!.tools!.map((tool) => tool.name)).toEqual(["search_document", "read_document", "get_document_overview"]);
    const round = model.requests[1]!.messages.find((message) => message.role === "tools");
    expect(round).toMatchObject({ calls: [search], answers: [{ result: { document: "app.log", total_matching_lines: 8 } }] });

    expect(result).toMatchObject({ answered: true, turns: 2 });
    expect(result.plan.searchable.map((document) => document.name)).toEqual(["app.log"]);
    expect(result.steps).toEqual(["Search app.log (exact) for “ERROR” — 8 matching lines"]);
    expect(result.evidence).toEqual([expect.objectContaining({ tool: "search_document", documentId: meta.id, query: "ERROR", totalMatchingLines: 8 })]);
    expect(result.toolTurns[0]!.calls[0]).toMatchObject({ name: "search_document", result: { total_matching_lines: 8 } });
  });
});
```

The tool calls of a script are what a model would send: a tool name and its arguments, as the
[tools reference](../reference/tools.md) lists them. The tools run for real, against the document in
the store, so the test checks what your file holds. A call names its document by ID, and the ID is
new on every ingest: write the script after the ingest, as here, or in a function entry.

Each recorded `ModelRequest` holds what the model was given:

- `system`: your `system` text, then the library's guide to the tools when there are any, and in
  an explorer's requests `EXPLORER_INSTRUCTION` after them.
- `messages`: the conversation. A text turn is `{ role: "user" | "assistant", parts }`; a tool round
  is `{ role: "tools", calls, answers }`, where each answer's `result` is the JSON the model sees.
- `tools`: the declarations on offer, left out when the question needs none.
- `toolChoice`: `"auto"` while tools may run, `"none"` for the request that must be answered in
  text. Left out, with `tools`, when the question needs no tools.

The [`ModelRequest` reference](../reference/ask.md#modelrequest) has every field.

### Replies that depend on the request

A function entry decides from the request. These tests cover the end of the tool loop, streamed
text, a blocked prompt and an explorer model:

```ts
// test/loop.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { calls, fakeModel, says, utf8 } from "llm-large-files/testing";
import { appLog } from "./documents.js";

const question = (text: string) => [{ role: "user" as const, text }];

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 }, requireOwner: false });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(appLog(400)) });
  return { files, meta };
}

describe("the tool loop", () => {
  it("asks for the answer in text when the tool turns run out", async () => {
    const { files, meta } = await largeLog();
    // A model that never stops reading, until it is told to answer (toolChoice "none").
    const model = fakeModel([(request, call) => request.toolChoice === "none"
      ? says("No failure in the first 30 lines.")
      : calls([{ name: "read_document", args: { document_id: meta.id, start_line: call * 10, end_line: call * 10 + 9 } }])]);

    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("Any failures early on?"), limits: { toolTurns: 3 } });

    expect(model.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "none"]);
    expect(result.steps).toEqual(["Read app.log lines 10-19", "Read app.log lines 20-29"]);
    expect(result).toMatchObject({ text: "No failure in the first 30 lines.", answered: true, turns: 3 });
  });

  it("streams the text, and reports each step as it is taken", async () => {
    const { files, meta } = await largeLog();
    const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const model = fakeModel([calls([search], { text: "Checking the log." }), says("8 payments failed.")]);
    const deltas: string[] = [];
    const steps: string[] = [];

    const result = await askWithFiles({
      files, model, documentIds: [meta.id], messages: question("How many payments failed?"),
      onText: (delta) => deltas.push(delta),
      onStep: (step) => steps.push(step),
    });

    // The loop puts a blank line between the text of two model turns.
    expect(result.text).toBe("Checking the log.\n\n8 payments failed.");
    expect(deltas.join("")).toBe(result.text);
    expect(steps).toEqual(result.steps);
  });

  it("returns answered: false when the provider blocks the prompt", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([says("", { blockReason: "SAFETY" })]);

    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?") });

    expect(result).toMatchObject({ answered: false, blockReason: "SAFETY", text: "" });
  });

  it("lets an explorer search while the main model answers", async () => {
    const { files, meta } = await largeLog();
    const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    // The explorer calls the tools, then replies DONE; the other model writes the answer.
    const explorer = fakeModel([calls([search]), says("DONE")], { id: "explorer" });
    const model = fakeModel([says("8 payments failed.")], { id: "answerer" });

    const result = await askWithFiles({ files, model, explorer, documentIds: [meta.id], messages: question("How many payments failed?") });

    expect(explorer.requests).toHaveLength(2);
    expect(model.requests[0]!.toolChoice).toBe("none");
    expect(result).toMatchObject({ text: "8 payments failed.", answered: true, turns: 3 });
    expect(result.usage.byModel.explorer!.requests).toBe(2);
    expect(result.usage.byModel.answerer!.requests).toBe(1);
  });
});
```

What these show of the loop:

- `limits.toolTurns` counts the answer: with 3, tools run in the first two requests, and the third
  has `toolChoice: "none"`. The tools are still listed in it, and the last user turn asks for the
  answer (`FINAL_ANSWER_REQUEST`). See [`AskLimits`](../reference/ask.md#asklimits).
- The same search or read twice is not run twice: the second gets a pointer to the first result
  (in a later turn, it runs again when that result failed or was cut). That is why the reads above
  move on by ten lines a request.
- Text the model writes before a tool call is part of `text`, and of what `onText` receives, with
  `"\n\n"` before the next turn's text.
- In the tool loop (not for a document sent whole), a reply with no text and no tool call before
  any tool ran, or a tool call that could not be read (`finish: "malformed_call"`), is asked for
  once more. An empty reply that was cut off (`finish: "cut"`), filtered or blocked is not. This
  happens at most twice a question, and only while a tool turn is left: the second try is a
  request of its own and takes a tool turn. It adds a step to `steps` and `onStep`: "The model's
  first reply was empty: it was asked again", or "The model's tool call could not be read: it was
  asked to send it again". Script that reply too, or the fake repeats its last entry.
- The request for the answer (`toolChoice: "none"`) is asked for once more when its reply has no
  text, or holds a tool call, with a note at its end that is not kept: "Your last reply had no
  text. No tool can be called in this reply: write the answer now, in text, from what is above."
  Its step is "The model's answer was empty: it was asked again", or "The model called a tool
  instead of answering: it was asked again for the answer". It is one of the two second tries, and
  can be one request past `limits.toolTurns`; it is not made after a refusal, a filter, a reply
  cut off at the output limit with nothing in it, or once `limits.requests` or
  `limits.inputTokens` is reached. So a fake that answers the answer's request
  with nothing gets one more request, with `toolChoice: "none"`. The fake above repeats its last
  entry; a fake that throws when its queue of replies runs out fails there.
- With an `explorer`, the explorer gets the tool requests and what it writes is not shown. The
  answering model gets one request, with `toolChoice: "none"`. `turns` counts the chat requests of
  both. See [An explorer model](./explorer-model.md).

## What to assert

Assert what your application does with the result. These are the fields of
[`AskResult`](../reference/ask.md#askresult) worth checking, and what a fake makes them:

| Field | What it holds in a test |
| --- | --- |
| `text` | What the script wrote: the answer, after any remark made before a tool call. |
| `modelText` | The same as `text`, unless `showCitations: false` hid citations from `text`: then the script's text as it wrote it. Test that your application stores it as the assistant turn. Required since 0.99.13: an `AskResult` your tests build by hand needs it. |
| `answered` | `false` when the last turn had no text: a blocked prompt (`blockReason`), a reply cut off before any text, an answer with no text after its second try. Test that your application then shows its own message. |
| `steps` | The steps `onStep` received, in order. They are sentences for people, written by the library, one line of plain text each. |
| `evidence` | One entry per tool call that showed something: `tool`, `documentId`, `document`, `lines`, `pages`, `query`, `mode`, `totalMatchingLines`, `whole`. |
| `toolTurns` | The tool rounds as plain JSON. Test that your application stores them, and passes them back between the question and its answer (see [Conversations](./conversations.md)). |
| `turns` | Chat requests made, an explorer's included: 1 for a document sent whole. |
| `usage` | The sum of the `usage` your fake returned: `requests`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `thoughtTokens`, and the same per model `id` in `byModel`. A request that failed and was sent again counts once. |
| `plan` | `plan.inline` and `plan.searchable`: which documents went in whole and which were searched. |
| `finishReason`, `lastUsage` | The `finishReason` and `providerUsage` of the last reply, as the fake gave them. |

Some advice:

- Compare `steps` and `evidence` to the tools that ran, not to the model's wording. A test that
  compares whole step sentences checks the library's wording too, and needs an update when it
  changes; `toHaveLength` or `toContain` is often enough.
- Do not compare the `system` text or the document cards in a request whole: they are the
  library's prompts, not your application's. Check that your own `system` text is in it.
- To test what your application does with `usage` (a cost per user, a ceiling), give the fake's
  replies round numbers of tokens, as above. See [Costs and limits](./costs-and-limits.md).

### Events

New in 0.7.0. To test what your application shows while a question runs, collect the events of a
scripted question with `onEvent` (or read `askStream`), and assert their order and the fields your
page reads. Compare `type`s, ids and outcomes, not whole events: `time` changes on every run, and
the wording of a label or a notice is the library's.

```ts
// test/events.test.ts
import { expect, it } from "vitest";
import { askStream, createLargeFiles, MemoryDocumentStore, type AskEvent } from "llm-large-files";
import { calls, fakeModel, says, utf8 } from "llm-large-files/testing";
import { appLog } from "./documents.js";

it("shows the search, then the answer, in order", async () => {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 }, requireOwner: false });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(appLog(400)) });
  const search = { id: "s1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
  const model = fakeModel([calls([search]), says("8 payments failed.")]);

  const events: AskEvent[] = [];
  const stream = askStream({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "How many failed?" }], runId: "run_test" });
  for await (const event of stream) events.push(event);

  // seq counts from 1 without gaps, every event names the run, and the run ends once, last.
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect(events.every((event) => event.runId === "run_test")).toBe(true);
  expect(events.map((event) => event.type).filter((type) => type !== "text" && type !== "notice")).toEqual([
    "run.start", "plan",
    "request.start", "request.end", // the turn that calls the tool
    "tool.start", "tool.end",
    "request.start", "request.end", // the answer
    "run.finish",
  ]);
  expect(events.find((event) => event.type === "tool.end")).toMatchObject({ callId: "call_1", outcome: "ok" });
  // askStream streams by default: the fake passes the answer in two pieces, which join to the text.
  const text = events.flatMap((event) => (event.type === "text" ? [event.delta] : []));
  expect(text.join("")).toBe((await stream.result).text);
});
```

To test a failure, script an `Error` entry, as in [Errors](#errors): the run ends with `run.error`,
whose `error.message` is told in words for users, while `stream.result` rejects with the error as
the fake threw it. The library's own tests check the same rules for every run: each
`request.start` and `tool.start` has its end, and each `retry`, `text` and `tool.progress` falls
between them.

### Output that 0.6.0 changed

A test that pins the library's exact output breaks when that output changes. These changed in
0.6.0, for a test written for 0.5.0:

- **A stream must say that it ended.** A fake stream without Gemini's `finishReason`, an
  OpenAI-compatible `finish_reason` or `[DONE]`, or Claude's `stop_reason`, is no longer a whole
  reply: it throws "Gemini's reply ended before it was complete." (or "The model's …",
  "Claude's …"), status 0, kind `unreachable`, and is sent again when none of its text was shown.
  Give the last piece of a fake stream its end marker.
- **A repeated call is not run.** The same search, read or overview, or a read of lines inside a
  read shown in full, gets a pointer to the earlier result: `already_shown: true` and a note, a
  step that ends ` — already shown above`, and no entry in `evidence`. Script calls that differ.
- **An empty first reply, or a tool call that could not be read, is asked for once more**: one
  more request, and the step `The model's first reply was empty: it was asked again`. Script that
  reply too.
- **Tool results have new fields**: `already_shown`, `text_cut`, and on a whole-file read
  `notes_only` and `answer_shortened`. Compare with `toMatchObject`, not `toEqual`.
- **Model errors have a `kind`**, and some are not sent again as they were. A quota (a Gemini
  quota per day, OpenAI's `insufficient_quota`, HTTP 402, Claude's credit and spending limits) is
  thrown at once. A request too large, OpenAI's HTTP 429 for the tokens a minute among them, is
  never sent again as it was: the loop makes it smaller first, when it can. 0.5.0 sent every error
  of status 0, 408, 409, 429 or 500 and more again, up to three times.
- **Calls without an ID** get a random one from `anthropicToolTurns` and `openAiToolTurns`:
  `toolu_` or `call_` and 24 hex digits, a new one each time, where 0.5.0 gave `toolu_1_1` or
  `call_1_1`.
- **An upload whose store fails** while it writes, with an error that has no status, is answered
  `500` `{ "error": "Upload failed." }`, not `422` with the store's message.
- **A model that sends nothing fails after a wait.** A real adapter aborts a request that gets
  nothing for `firstByteTimeoutMs` (600,000 ms), or for `idleTimeoutMs` (300,000 ms) between
  pieces: a test with fake timers that moves the clock that far now aborts it
  ([Timers](#timers)). 0.5.0 waited without end.
- **Two searches in a row that fail in the same mode** get a hint at the end of their error:
  `Two regex searches in a row failed. Try mode "exact" with a plain word or ID from the file, or mode "keywords".`
  or `This search failed twice in a row. Check the arguments against the tool's description, or answer from what you have.`
- **An unknown `document_id`** is answered `Unknown document_id nope. Use one of: <id> ("app.log").`,
  where 0.5.0 said `Unknown document_id nope. Use an ID from a file card.`
- **Part reads of a fake `generateText` that does not call `onUsage`** count in `usage.requests`
  and toward `limits.requests`.
- **The frame of a file sent whole** carries a mark made from the document ID, before the quoted
  name: `--- Attached file [mark 1f0c3a9e]: "report.txt" (text, 6 lines; it ends only at the line with mark 1f0c3a9e) ---`
  and `--- End attached file [mark 1f0c3a9e] ---`. It was `--- Attached file: report.txt (text, 6 lines) ---`.
  The ID is new on every ingest, so the mark is too: match the start, `--- Attached file [mark `,
  or find one file by `]: ` and its name as a JSON string (`JSON.stringify(name)`), then ` (`. A
  file of one line says `1 line`, and the card of a PDF of one page `1 page`.
- **An exact or regex search** with more matching lines than `max_results` returns one more entry
  in `matches`: the first `max_results`, then the last matching line of the file, with the note
  `21 of the 442 matching lines are shown: the first 20 and the last (line 15269). To see the ones in between, narrow the search.`
  Its `evidence` lists the lines of the last match too. With no more matches than `max_results`,
  nothing changed, unless the result is cut to the room it has: the last match then stays, matches
  are dropped from the end of the first ones, and the note is new,
  `Showing 4 of the 10 matching lines to stay within the size limit: the first 3 and the last (line 1000). Narrow the query or read specific lines.`
  where 0.5.0 said `Showing 4 of 10 results to stay within the size limit. …`. Since 0.8.0 both
  notes end `To see the ones in between, search again with from_line N, or count them with group_by.`,
  where N is the line after the last of the first ones (below line 15269 in the first note, and
  below line 1000 in the second), and the result has `next_from_line` with that line
  ([`search_document`](../reference/tools.md#search_document)).
- **Steps with a count of one** are singular: ` — 1 matching line`, ` — 1 passage`,
  ` — 1 part, 1 relevant`, and `1 more tool call in this turn was not run (at most 8 a turn)`.
- **A call to a tool that does not exist** has the step `Call “do_magic” — failed: Unknown tool “do_magic”.`,
  and the model gets `Unknown tool “do_magic”.`, as `files.tools().execute()` returns it.
- **The answer's second try** ([above](#replies-that-depend-on-the-request)): one more request when
  the answer comes back without text. To cap the requests of a question exactly, set
  `limits.requests`.
- **A whole-file read that fails** says why by the kind and status of the error, never by its
  words: `Could not read any part of app.log: The model was busy (HTTP 429).` A fake `generateText`
  that throws a plain `Error` gives `The model request failed.`, and one that throws
  `new ModelRequestError("…", 401)` gives `The model refused the key or token it was sent (HTTP 401).`
- **A reply of HTTP 200 that is not JSON** is a `ModelRequestError` of kind `invalid` and status
  200, with the `SyntaxError` as its `cause`: test `error.cause instanceof SyntaxError`. Kind
  `invalid` alone also covers every other request the provider refused.
- **A fake `fetch` whose reply of HTTP 200 is empty** gets the request again: the reply is kind
  `unreachable`, status 0. A streamed reply that is not of type `text/event-stream` is read by what
  it holds: as events when it starts like them, as JSON when it starts with `{` or `[`.
- **An error inside a stream** has the status and the kind of its type: on an OpenAI-compatible
  endpoint, `context_length_exceeded` is 400, kind `context_overflow`; on Claude,
  `authentication_error` is 401, kind `auth`. Both kept the stream's HTTP 200 in 0.5.0.
- **A question stopped while its adapter is called** throws the signal's reason, even when the
  adapter then fails with its own error (a fake that throws a 503, say).
- **A Gemini part read** sends `generationConfig: { maxOutputTokens }`, without `temperature`.
- **The card of a text file that is not valid UTF-8** has one more line, and its frame a note
  after the count of lines, such as `, read as windows-1255`
  ([Text encodings](./pdfs.md#text-encodings)).
- **The stored text** of a file with characters that show nothing, with text that Word hides, or
  with a hidden slide differs from what 0.5.0 stored
  ([Characters that show nothing](../security.md#characters-that-show-nothing)).
- **Steps** quote the model's words on one line, without the characters that show nothing. The
  steps of a request too large are new, such as
  `The request was larger than the model takes: older tool results were shortened, and it was sent again`
  and `The first request was larger than the model's window of 60,000 tokens: the files were planned again to fit it`,
  and the same for the tokens a minute the provider allows. So is `, notes only` at the end of the
  step of a whole-file read that returned only its notes.
- **`anthropic().capabilities`** has `clearsToolResults: true` when `body.context_management`
  clears tool uses or compacts the conversation.
- **`geminiToolTurns`, `openAiToolTurns` and `anthropicToolTurns`** leave `tool_turns_left` out of
  each result, so their output no longer equals the stored result.
- **`MemoryDocumentStore`** returns a new copy of the metadata from each call: compare with
  `toEqual`, not `toBe`.
- **`files.ingest` with `owner: ""`** throws a `TypeError`
  ([Storage](./storage.md#how-ownership-works)).
- **The descriptions of `search_document` and `analyze_whole_document`** changed: the first now
  says that exact and regex results show the first `max_results` matching lines and the last one,
  and the second sends counting and listing to `search_document`. A test that compares the tool
  declarations, or the `tools` of a request, with a stored copy fails.

## Errors

A fake throws what a real adapter throws: a
[`ModelRequestError`](../reference/errors-and-retries.md#modelrequesterror) with an HTTP `status`
and a `kind`. The kind is told from the status, the message and the provider's `code` (and a
Gemini error's `details`), unless you pass `kind`:

| Kind | A fake throws | The loop sends it again |
| --- | --- | --- |
| `rate_limit` | `new ModelRequestError("Too many requests.", 429)` | Yes, up to `retry.retries` times (3) |
| `quota` | `new ModelRequestError("You exceeded your current quota.", 429, { code: "insufficient_quota" })` | No |
| `server` | `new ModelRequestError("The model is overloaded.", 503)` | Yes |
| `timeout` | `new ModelRequestError("The model sent nothing for 600 s.", 0, { kind: "timeout" })` | Once |
| `unreachable` | `new ModelRequestError("The model could not be reached.", 0)` | Yes |
| `auth` | `new ModelRequestError("Token expired.", 401)` | No |
| `invalid` | `new ModelRequestError("Bad request.", 400)` | No (HTTP 409 is `invalid` too, and is sent again) |
| `context_overflow` | `new ModelRequestError("prompt is too long: 210417 tokens > 200000 maximum", 400)` | Not as it was: the loop makes the request smaller, or plans the documents again for a smaller window |

An `Error` without a `status` is not sent again, and reaches your code as it is. What each kind
means for a user is in [Errors and reliability](./errors-and-reliability.md).

```ts
// test/errors.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, DocumentsNotFoundError, errorKindOf, MemoryDocumentStore, ModelRequestError, partialResultOf } from "llm-large-files";
import { calls, fakeModel, says, utf8 } from "llm-large-files/testing";
import { appLog } from "./documents.js";

/** Your application's own words for a question that failed: the code under test. */
function userMessage(error: unknown): string {
  if (error instanceof DocumentsNotFoundError) return "A file is no longer available. Upload it again.";
  switch (errorKindOf(error)) {
    case "rate_limit":
    case "server":
    case "timeout":
    case "unreachable":
      return "The assistant is busy. Try again in a minute.";
    case "context_overflow":
      return "This chat is too long for the model. Start a new one.";
    default:
      return "Something went wrong.";
  }
}

const question = [{ role: "user" as const, text: "How many payments failed?" }];

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(appLog(400)), owner: "alice" });
  const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
  return { files, meta, search };
}

describe("a question that fails", () => {
  it("shows a busy message when the model is overloaded", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([new ModelRequestError("The model is overloaded.", 503)]);

    // retries: 0, so the error comes back at once, not after three more tries and their waits.
    const error = await askWithFiles({ files, model, documentIds: [meta.id], owner: "alice", messages: question, retry: { retries: 0 } })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, kind: "server" });
    expect(userMessage(error)).toBe("The assistant is busy. Try again in a minute.");
  });

  it("is sent again after a busy reply, without waiting in the test", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([new ModelRequestError("Too many requests.", 429), says("8 payments failed.")]);
    const waits: number[] = [];

    const result = await askWithFiles({
      files, model, documentIds: [meta.id], owner: "alice", messages: question,
      // The wait is recorded instead of slept; random: () => 1 takes the jitter out of it.
      retry: { sleep: async (ms) => { waits.push(ms); }, random: () => 1 },
    });

    expect(result.text).toBe("8 payments failed.");
    expect(model.requests).toHaveLength(2);
    expect(waits).toEqual([500]);
    // A request that failed and was sent again counts once.
    expect(result.usage.requests).toBe(1);
  });

  it("keeps what was found before the failure", async () => {
    const { files, meta, search } = await largeLog();
    const model = fakeModel([calls([search]), new ModelRequestError("Token expired.", 401)]);

    const error = await askWithFiles({ files, model, documentIds: [meta.id], owner: "alice", messages: question })
      .catch((caught: unknown) => caught);

    expect(errorKindOf(error)).toBe("auth");
    expect(model.requests).toHaveLength(2); // a refused token is not sent again
    const partial = partialResultOf(error);
    expect(partial).toMatchObject({ answered: false, steps: ["Search app.log (exact) for “ERROR” — 8 matching lines"] });
    expect(partial!.toolTurns).toHaveLength(1);
  });

  it("refuses a document of another user before any model request", async () => {
    const { files, meta } = await largeLog();
    const model = fakeModel([says("never sent")]);

    const error = await askWithFiles({ files, model, documentIds: [meta.id], owner: "bob", messages: question })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DocumentsNotFoundError);
    expect((error as DocumentsNotFoundError).ids).toEqual([meta.id]);
    expect(userMessage(error)).toBe("A file is no longer available. Upload it again.");
    expect(model.requests).toHaveLength(0);
  });
});
```

Notes on these tests:

- **Waits.** The loop sends a failed request again after a real wait: up to 500 ms the first
  time, then twice as long each time, with jitter that takes up to half off each wait. With
  `random: () => 1` the waits are exactly 500, 1,000 and 2,000 ms. In tests, pass
  `retry: { retries: 0 }` to get the error at once, or a `sleep` that records the waits and
  returns at once, as above. Both are fields of
  [`RetryOptions`](../reference/errors-and-retries.md#retryoptions).
- **`partialResultOf(error)`** gives what the question found and used before it failed: its steps,
  evidence, tool rounds and usage, with `answered: false`. Test that your application keeps them.
  Its `usage` is a copy taken when the question failed: a request of a fake that was still running
  then, and answers later, is not counted.
- **`DocumentsNotFoundError`** comes before any model request, for a document that is missing,
  expired or owned by someone else. Its `ids` are the ones not found.
- **A request too large** (`context_overflow`) is mended inside the loop when it can be. A fake that
  repeats the error lets you see what your application does when it cannot be mended.

## The real adapters with a fake fetch

A fake model tests your code; it does not test that you set up the provider right. For that, run
the real adapter and fake the network. Every adapter takes a `fetch` option, and sends every request
through it, the part reads of a whole-file read included:

| Adapter | Where `fetch` goes |
| --- | --- |
| Gemini API and Vertex AI | `gemini(endpoint, { fetch })`, or `askGemini({ ..., fetch })` |
| OpenAI-compatible | `openAiCompatible({ ..., fetch })` |
| Claude | `anthropic({ ..., fetch })` |

`fakeFetch` from `llm-large-files/testing` answers from a script, as the fake model does. Each
request gets the next reply, and the last one repeats. A reply is a `Response`, answered with a
copy each time, or a function of the request and its number. `sent` records every request: its
`url`, `method` and `headers`, and its `body` parsed as JSON. `sse(events)` makes a streamed reply:
one `data:` line for each event, an object as JSON, a string such as `"[DONE]"` as it is.

```ts
import { fakeFetch } from "llm-large-files/testing";

const api = fakeFetch([Response.json({ candidates: [] })]);
// Give api.fetch to the adapter; after the question, api.sent holds each request it made.
```

### Gemini on Vertex AI

`vertexAi()` with a fixed `accessToken` string makes no call to get a token, so the test needs no
credentials. The replies are in Gemini's own JSON:

```ts
// test/vertex.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, gemini, GeminiRequestError, vertexAi } from "llm-large-files/gemini";
import { fakeFetch, sse, utf8 } from "llm-large-files/testing";
import { appLog } from "./documents.js";

// Replies as Gemini writes them.
const geminiText = (text: string) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1_200, candidatesTokenCount: 20, totalTokenCount: 1_220 },
});
const geminiCall = (name: string, args: Record<string, unknown>) => ({
  candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 15, totalTokenCount: 915 },
});

// A fixed token: vertexAi() calls nothing to get it.
const endpoint = vertexAi({ project: "test-project", location: "europe-west4", model: "gemini-test", accessToken: "test-token" });
const question = [{ role: "user" as const, text: "How many payments failed?" }];

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 }, requireOwner: false });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(appLog(400)) });
  return { files, meta };
}

describe("Gemini on Vertex AI, without the network", () => {
  it("sends the token, runs the tool loop and counts the usage", async () => {
    const { files, meta } = await largeLog();
    const api = fakeFetch([
      Response.json(geminiCall("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" })),
      Response.json(geminiText("8 payments failed (app.log L50).")),
    ]);
    const model = gemini(endpoint, { fetch: api.fetch });

    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question });

    expect(api.sent[0]!.url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/test-project/locations/europe-west4/publishers/google/models/gemini-test:generateContent");
    expect(api.sent[0]!.headers.Authorization).toBe("Bearer test-token");
    expect(api.sent[1]!.body.contents.at(-1).parts[0].functionResponse.response).toMatchObject({ total_matching_lines: 8 });
    expect(result).toMatchObject({ text: "8 payments failed (app.log L50).", answered: true, turns: 2, finishReason: "STOP" });
    expect(result.usage.byModel["gemini-test"]).toMatchObject({ requests: 2, inputTokens: 2_100, outputTokens: 35 });
  });

  it("streams the answer through askGemini", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.") });
    // A streamed Gemini reply ends with a chunk that says why it ended.
    const api = fakeFetch([sse([
      { candidates: [{ content: { role: "model", parts: [{ text: "The code word " }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "is heron." }] }, finishReason: "STOP" }] },
    ])]);
    const deltas: string[] = [];

    const result = await askGemini({
      files, endpoint, fetch: api.fetch, documentIds: [meta.id],
      messages: [{ role: "user", text: "What is the code word?" }],
      onText: (delta) => deltas.push(delta),
    });

    expect(api.sent[0]!.url).toMatch(/:streamGenerateContent\?alt=sse$/);
    expect(deltas).toEqual(["The code word ", "is heron."]);
    expect(result.text).toBe("The code word is heron.");
  });

  it("reports an HTTP error with its kind", async () => {
    const { files, meta } = await largeLog();
    const busy = { error: { code: 429, message: "Resource exhausted. Please try again later.", status: "RESOURCE_EXHAUSTED" } };
    const api = fakeFetch([Response.json(busy, { status: 429 })]);

    const error = await askGemini({ files, endpoint, fetch: api.fetch, documentIds: [meta.id], messages: question, retry: { retries: 0 } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GeminiRequestError);
    expect(error).toMatchObject({ status: 429, kind: "rate_limit", message: "Resource exhausted. Please try again later." });
  });

  it("reports a model that sends nothing as a timeout", async () => {
    const { files, meta } = await largeLog();
    // A fetch that never answers: it ends only when the adapter aborts it, as the real fetch does.
    const silent = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
    const model = gemini(endpoint, { fetch: silent, firstByteTimeoutMs: 20 });

    const error = await askWithFiles({ files, model, documentIds: [meta.id], messages: question, retry: { retries: 0 } })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 0, kind: "timeout" });
  });
});
```

A `fetch` that throws (`throw new TypeError("fetch failed")`) is a model that cannot be reached: a
`GeminiRequestError` with `status` 0, kind `"unreachable"` and the message
"Gemini could not be reached (fetch failed)." The setup itself is in
[Gemini and Vertex AI](./vertex-and-gemini.md).

### OpenAI-compatible endpoints and Claude

```ts
// test/providers.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";
import { anthropic } from "llm-large-files/anthropic";
import { fakeFetch, sse, utf8 } from "llm-large-files/testing";
import { appLog } from "./documents.js";

const question = [{ role: "user" as const, text: "How many payments failed?" }];

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 }, requireOwner: false });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(appLog(400)) });
  const args = { document_id: meta.id, query: "ERROR", mode: "exact" };
  return { files, meta, args };
}

describe("other providers, without the network", () => {
  it("runs the loop on an OpenAI-compatible endpoint, and streams its answer", async () => {
    const { files, meta, args } = await largeLog();
    const api = fakeFetch([
      // Asked for a stream, answered in one piece: a reply that is not text/event-stream is read by
      // its first characters, here as JSON.
      Response.json({
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
          { id: "call_1", type: "function", function: { name: "search_document", arguments: JSON.stringify(args) } },
        ] } }],
        usage: { prompt_tokens: 900, completion_tokens: 15 },
      }),
      // A stream ends with a finish_reason, or with [DONE].
      sse([
        { choices: [{ index: 0, delta: { content: "8 payments " } }] },
        { choices: [{ index: 0, delta: { content: "failed." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1_300, completion_tokens: 6 } },
        "[DONE]",
      ]),
    ]);
    const model = openAiCompatible({ model: "test-model", baseUrl: "https://llm.test/v1", apiKey: "test-key", fetch: api.fetch });
    const deltas: string[] = [];

    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question, onText: (delta) => deltas.push(delta) });

    expect(api.sent[0]!.url).toBe("https://llm.test/v1/chat/completions");
    expect(api.sent[0]!.headers.Authorization).toBe("Bearer test-key");
    expect(api.sent[0]!.body.stream).toBe(true);
    expect(deltas).toEqual(["8 payments ", "failed."]);
    expect(result).toMatchObject({ text: "8 payments failed.", answered: true, turns: 2 });
    expect(result.usage).toMatchObject({ requests: 2, inputTokens: 2_200, outputTokens: 21 });
  });

  it("runs the loop on Claude, and reads its stream of events", async () => {
    const { files, meta, args } = await largeLog();
    const api = fakeFetch([
      Response.json({
        type: "message", role: "assistant", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "search_document", input: args }],
        usage: { input_tokens: 900, output_tokens: 15 },
      }),
      // A stream ends with a message_delta that carries the stop_reason.
      sse([
        { type: "message_start", message: { usage: { input_tokens: 1_300, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "8 payments " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "failed." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
        { type: "message_stop" },
      ]),
    ]);
    const model = anthropic({ model: "claude-test", apiKey: "test-key", fetch: api.fetch });

    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question });

    expect(api.sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(api.sent[0]!.headers["x-api-key"]).toBe("test-key");
    expect(result).toMatchObject({ text: "8 payments failed.", answered: true, turns: 2, finishReason: "end_turn" });
  });
});
```

### What each adapter expects of a fake reply

The adapters differ in when they stream and in how they read a reply. A fake reply must match, or
the adapter takes it for a broken one:

| | Gemini (`gemini()`, `askGemini`) | OpenAI-compatible | Claude |
| --- | --- | --- | --- |
| A reply in text | `candidates[0].content.parts: [{ text }]` | `choices[0].message.content` | `content: [{ type: "text", text }]` |
| A tool call | `parts: [{ functionCall: { name, args } }]` | `message.tool_calls`, with `arguments` as a JSON string | `content: [{ type: "tool_use", id, name, input }]` |
| Usage | `usageMetadata.promptTokenCount`, `candidatesTokenCount` | `usage.prompt_tokens`, `completion_tokens` | `usage.input_tokens`, `output_tokens` |
| Streams when | `onText` is set and the endpoint has a `streamUrl` (`geminiApi()` and `vertexAi()` set one); the request goes to that URL | `onText` is set and the `stream` option is not `false` | Always, unless the `stream` option is `false` |
| A streamed request's reply | A stream when the content type is `text/event-stream`. Of any other type, by its first characters: events when it starts with `data:` or a comment, JSON when it starts with `{` or `[` (one chunk, or a list of chunks) | The same: a stream for `text/event-stream`, and by its first characters otherwise | The same |
| A stream ends with | A chunk with `finishReason` | A chunk with `finish_reason`, or `data: [DONE]` | A `message_delta` event with `stop_reason` |
| An HTTP error body | `{ error: { code, message, status, details } }` | `{ error: { message, type, code, param } }` | `{ type: "error", error: { type, message } }` |
| Error class | `GeminiRequestError` | `OpenAiRequestError` | `AnthropicRequestError` |

A stream that closes without its end is taken for a reply cut off on its way, with `status` 0:
"Gemini's reply ended before it was complete.", "The model's reply ended before it was complete."
(OpenAI-compatible) or "Claude's reply ended before it was complete." The loop then sends the
request again, unless text of it was shown, and `onActivity` gets "The model's reply was cut off
on its way. Trying again…". When a fake stream seems to be sent twice, check that it ends as the
table above says: for Claude, a `message_delta` event with `stop_reason`, not only `message_stop`.
A stream that said it is whole (`[DONE]`, `message_stop`) and then stays open is read for one more
second, then left, and its reply is returned.

Other fake replies, and what each adapter makes of them:

- A body of HTTP 200 that is not JSON, such as `new Response("<html>…", { headers: { "Content-Type": "text/html" } })`:
  a `ModelRequestError` with kind `invalid`, status 200 and the `SyntaxError` as `cause`, not sent
  again. Its message is "Gemini's reply could not be read: it was not JSON (text/html). A proxy or
  gateway may have answered in its place.", or the same with "The model's" or "Claude's". A body
  under another type that starts with more than 65,536 characters of white space is read as JSON,
  whatever follows.
- An empty body of HTTP 200, `new Response("")`: kind `unreachable`, status 0, "Gemini could not
  be reached (the reply was empty)." (or "The model could not…", "Claude could not…"), sent again
  as a reply cut off on its way.
- A stream with one event longer than 64,000,000 characters: kind `invalid`, status 200, "The
  model's reply could not be read: an event of its stream held more than 64,000,000 characters.",
  not sent again.

All three error classes extend `ModelRequestError`, with the same `status` and `kind`. A
`Retry-After` header on an error reply is the wait the loop takes before it sends the request
again; a wait longer than `retry.maxDelayMs` (60,000 ms by default) is not taken, and the error is
thrown.

All three adapters can read a whole file in parts, so `analyze_whole_document` is offered, and its
part reads go through the same `fetch`. Pass `wholeDocumentAnalysis: false` to `askWithFiles` or
`askGemini` when a test is not about it. A part read that fails is told to the model by the kind
and status of its error (`The model was busy (HTTP 429).`), never by the words of the fake's error
body; a part read whose reply has no text gives `The model returned no text (SAFETY).`, with the
provider's reason when it is a plain word. The adapters' options are in the reference:
[gemini](../reference/gemini.md), [openai](../reference/openai.md),
[anthropic](../reference/anthropic.md).

### Recorded replies

Writing a provider's JSON by hand is fine for a few replies. For the real shapes (thought
signatures, finish reasons, usage), record what a real model sends once, and replay it. Save this as
`test/record.ts`:

```ts
// test/record.ts: save the replies of a real model once, and replay them in tests.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Recording = { status: number; contentType: string; body: string };

/** A fetch that calls the real one and saves each reply to `${prefix}-1.json`, `${prefix}-2.json`, … */
export function recordingFetch(prefix: string, real: typeof fetch = fetch): typeof fetch {
  let count = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await real(input, init);
    const file = `${prefix}-${++count}.json`;
    // Waits for the whole body: a stream is recorded whole, and passed on once it is.
    const recording: Recording = { status: response.status, contentType: response.headers.get("content-type") ?? "", body: await response.clone().text() };
    // An error thrown here would reach the adapter as a failed connection, and the request would be
    // sent again: make the folder first.
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(recording, null, 2));
    return response;
  }) as typeof fetch;
}

/**
 * A recorded reply as a Response for `fakeFetch`. Document IDs are new on every ingest, so the
 * IDs in a recorded tool call are replaced with `documentId`, the one the test ingested.
 */
export async function replay(file: string, documentId?: string): Promise<Response> {
  const recording = JSON.parse(await readFile(file, "utf8")) as Recording;
  const body = documentId ? recording.body.replace(/doc_[a-f0-9]{32}/g, documentId) : recording.body;
  return new Response(body, { status: recording.status, headers: { "Content-Type": recording.contentType } });
}
```

Record in a live run, then replay in the test:

```ts
import { askWithFiles } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { fakeFetch } from "llm-large-files/testing";
import { recordingFetch, replay } from "./record.js";

// Assumes `files` and `meta` (a test document, as in largeLog()), and a real `endpoint`
// (vertexAi() with your credentials) for the live run.
const question = [{ role: "user" as const, text: "How many payments failed?" }];

// Once, in a live run: the real model, with each reply saved.
const live = gemini(endpoint, { fetch: recordingFetch("test/recordings/payments") });
await askWithFiles({ files, model: live, documentIds: [meta.id], messages: question, wholeDocumentAnalysis: false });

// In the test: the same replies from the files, with the document ID of this run.
const api = fakeFetch([
  await replay("test/recordings/payments-1.json", meta.id),
  await replay("test/recordings/payments-2.json", meta.id),
]);
// A fixed token, so the test needs no credentials. Use the live run's model name, so that
// usage.byModel keeps its key.
const testEndpoint = vertexAi({ project: "test-project", model: "gemini-3.5-flash-lite", accessToken: "test-token" });
const model = gemini(testEndpoint, { fetch: api.fetch });
const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question, wholeDocumentAnalysis: false });
```

- Give `fakeFetch` one `replay` for each file the live run wrote (`payments-1.json`,
  `payments-2.json`, …), in order: a request that was sent again is a file too. With fewer, the
  last reply repeats for the rest, and the run differs from the recorded one without an error.
- Replay with the same options you recorded with. With `onText`, a Gemini request goes to the
  stream URL and needs a recorded stream; with whole-file reads on, their part reads take replies
  of their own, in an order that is not fixed.
- The replay swaps every document ID in the recording for the one ID given: it suits a test of one
  document.
- A recording holds what the model wrote, and only the replies: no request, no token. Record with
  test documents, not your users' files.

### Timers

With fake timers (`vi.useFakeTimers()`), the library's waits are timers too. A retry waits with
`setTimeout` unless you pass `retry.sleep`. A real adapter starts a timer of `firstByteTimeoutMs`
(600,000 ms by default) for each request, and one of `idleTimeoutMs` (300,000 ms) between the pieces
of a reply: a test that moves the clock that far aborts the request as a model that went silent.
Pass `firstByteTimeoutMs: 0` and `idleTimeoutMs: 0` to such an adapter, or to `askGemini`: 0 waits
without end. The waits themselves are in [Errors and reliability](./errors-and-reliability.md).

## Expiry, owners and the clock

`createLargeFiles` takes a `now` option, a clock for its expiry checks and `sweep`. Give the store
the same clock: `MemoryDocumentStore` and `FileDocumentStore` take `now` too, and check expiry by
their own clock when they read a document. A library clock set in the past, next to a store on the
real clock, loses its documents at the first read: the store finds them expired by its own clock
and deletes them.

```ts
// test/expiry.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, DocumentsNotFoundError, MemoryDocumentStore } from "llm-large-files";
import { fakeModel, says, utf8 } from "llm-large-files/testing";

describe("documents that expire", () => {
  it("are gone after their time to live, and swept from the store", async () => {
    let clock = new Date("2026-01-01T09:00:00Z");
    const now = () => clock;
    // One clock for both: the library checks expiry by its clock, and the store by its own when it reads.
    const files = createLargeFiles({ store: new MemoryDocumentStore({ now }), now, ttlMs: 60 * 60_000 });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8("The code word is heron."), owner: "alice" });
    expect(meta.expiresAt).toBe("2026-01-01T10:00:00.000Z");
    // Another user cannot delete it.
    expect(await files.delete(meta.id, { owner: "bob" })).toBe(false);

    clock = new Date("2026-01-01T09:59:00Z");
    expect(await files.getMeta(meta.id, { owner: "alice" })).toBeDefined();

    clock = new Date("2026-01-01T10:00:00Z");
    expect(await files.sweep()).toBe(1);
    const model = fakeModel([says("never sent")]);
    await expect(askWithFiles({ files, model, documentIds: [meta.id], owner: "alice", messages: [{ role: "user", text: "?" }] }))
      .rejects.toBeInstanceOf(DocumentsNotFoundError);
    expect(model.requests).toHaveLength(0);
  });
});
```

- A document expires at `expiresAt` exactly: at 10:00 it is gone.
- `files.sweep()` passes the library's clock to the store's `sweep`, and returns how many documents
  it removed.
- Owners need no clock: ingest with `owner`, then ask with another one, as in
  [Errors](#errors). The question fails with `DocumentsNotFoundError` before any model request, the
  same error as for a document that expired. This test keeps the default, owner checks on (since
  0.99.9), and passes the owner on every call, as your server does: `files.sweep()` takes none. A
  call without an owner would throw a `TypeError` that says how to turn the checks off.
- `files.delete(id, { owner })` returns `false`, and deletes nothing, for a document of another
  owner; for the document's own owner it returns `true`.

To test your own `DocumentStore`, run the same tests against it. The contract is in
[Storage](./storage.md).

## Your routes

The handlers of `llm-large-files/node` take Node's own request and response, so a test can run them
on a real HTTP server, on a free port, and call them with `fetch`. Mount them as your server does;
this one routes `POST /api/documents` to `upload`, and `GET` and `DELETE /api/documents/:id` to
`get` and `remove` (`GET /api/documents` goes to `list`, new in 0.99.9, the same way):

```ts
// test/routes.test.ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** Starts the routes on a free port, and returns their base URL. */
async function start(): Promise<string> {
  const files = createLargeFiles({ store: new MemoryDocumentStore() });
  // In the test, the user is a header. Your server takes it from its session.
  const documents = createDocumentHandlers(files, {
    getOwner: (request) => (request.headers["x-user"] as string | undefined) || undefined,
  });
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.pathname.split("/")[3] ?? "";
    if (request.method === "POST" && url.pathname === "/api/documents") return void documents.upload(request, response);
    if (request.method === "GET" && id) return void documents.get(request, response, id);
    if (request.method === "DELETE" && id) return void documents.remove(request, response, id);
    response.statusCode = 404;
    response.end();
  });
  // Port 0: the system picks a free port, so test files can run side by side.
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/documents`;
}

describe("the upload routes", () => {
  it("keeps an upload to its owner", async () => {
    const base = await start();
    const upload = await fetch(base, {
      method: "POST",
      headers: { "X-File-Name": "notes.md", "X-User": "alice" },
      body: "# Notes\n\nThe code word is heron.",
    });
    expect(upload.status).toBe(201);
    const { id } = (await upload.json()) as { id: string };

    const asBob = await fetch(`${base}/${id}`, { headers: { "X-User": "bob" } });
    expect(asBob.status).toBe(404);
    // Since 0.99.13 an error body also has code and category (ErrorBody).
    expect(await asBob.json()).toEqual({ error: "This file is no longer available.", code: "documents_missing", category: "missing" });
    expect((await fetch(`${base}/${id}`, { headers: { "X-User": "alice" } })).status).toBe(200);
    const deleted = await fetch(`${base}/${id}`, { method: "DELETE", headers: { "X-User": "bob" } });
    expect(await deleted.json()).toEqual({ deleted: false });
  });
});
```

The other statuses (400 for a file without a name, 413 for one over `maxUploadBytes`, 422 for one
that cannot be read) are in the [`llm-large-files/node` reference](../reference/node.md).

The `|| undefined` in `getOwner` matters. With it, a header that arrives empty (`"X-User": ""`) is
a request without a user: owner checks are on by default (since 0.99.9), so it is answered `401`
`{ "error": "Sign in first." }` before its body is read (with `requireOwner: false` it would make
the upload anonymous, open to anyone who has its ID). With `?? ""` in its place, the same upload is
answered 500 `{ "error": "Upload failed (empty owner)." }`. Test what your sign-in hands
`getOwner` when there is no user ([A web app](./web-app.md#who-owns-an-upload-getowner)).

An answer route is tested the same way: give it `fakeModel()` where it would take the real model,
and read what it sends back with `fetch`. How such a route streams the answer is in
[A web app](./web-app.md).

## Live tests, few and cheap

Fakes test your code. Only a real model tells you whether it picks the right tool and finds the
answer in your files, and every run costs money and time and gives a slightly different answer.
Keep live tests few:

- **Out of the default run.** Skip them unless a variable is set, and run them on demand, before a
  release, or on a schedule.
- **Cheap.** One small model, one small document, `wholeDocumentAnalysis: false`, and ceilings in
  `limits`: once a question has used `inputTokens` input tokens, or is one request short of
  `requests`, no more tools run and the next request is the answer. See
  [Costs and limits](./costs-and-limits.md).
- **Loose.** Check that there is an answer and that it holds the fact, not its wording.
- **Measured.** Log `result.usage`, so you see what a run costs.
- **Useful twice.** Record the replies of a run that went well, and replay them in a fast test
  ([Recorded replies](#recorded-replies)).

```ts
// test/vertex.live.test.ts
import { describe, expect, it } from "vitest";
import { GoogleAuth } from "google-auth-library";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { utf8 } from "llm-large-files/testing";
import { appLog } from "./documents.js";

// Skipped unless LIVE_TESTS=1 is set: the default test run never calls a model.
describe.skipIf(process.env.LIVE_TESTS !== "1")("live: Gemini on Vertex AI", () => {
  it("finds the failed payments in a log", async () => {
    const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
    const model = gemini(vertexAi({
      project: process.env.GOOGLE_CLOUD_PROJECT!,
      location: "global",
      model: process.env.LIVE_MODEL ?? "gemini-3.5-flash-lite",
      accessToken: async () => {
        const token = await auth.getAccessToken();
        if (!token) throw new Error("No access token from the application default credentials.");
        return token;
      },
    }));
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 }, requireOwner: false });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(appLog(400)) });

    const result = await askWithFiles({
      files, model, documentIds: [meta.id],
      messages: [{ role: "user", text: "How many payments failed? Answer with the number." }],
      wholeDocumentAnalysis: false,
      // Ceilings: a model that keeps calling tools cannot run up a bill.
      limits: { toolTurns: 4, requests: 5, inputTokens: 50_000 },
    });

    // Loose checks: a real model words its answer its own way.
    expect(result.answered).toBe(true);
    expect(result.text).toMatch(/\b8\b/);
    expect(result.steps.length).toBeGreaterThan(0);
    console.log("live usage", result.usage);
  }, 120_000);
});
```

The credentials are the application default credentials, as on your servers: see
[Gemini and Vertex AI](./vertex-and-gemini.md). For another provider, swap the adapter:
[OpenAI-compatible endpoints](./openai-compatible.md), [Claude](./anthropic.md).

## The library's own evals

The repository has an eval suite in `evals/`: about 50 Hebrew and English questions over synthetic
files (a Hebrew policy in Word, a budget workbook with two header rows, a windows-1255 CSV of 3,000
rows, a deck, a 3 MB service log, a shift diary, Hebrew PDFs, a contract), each with the facts its
answer must hold. It is how the library checks that a change to what it sends a model keeps the
answers right. It is not part of the package. To run it, clone the repository and `npm install`:

```bash
npm run eval:replay                        # every case from its recording: no network, no key
npm run eval:recheck                       # the facts checked again on the recorded answers
GEMINI_API_KEY=… npm run eval:record       # each case once against the Gemini API, recorded
GEMINI_API_KEY=… npm run eval:live -- --k 3
```

- **Replay** answers each request from `evals/cassettes`, and checks the facts again on the
  recorded answers. CI runs it on every pull request. A request that changed fails with
  "prompt changed: re-record", with the case, the request and the first field that differs (the
  method, the URL, or a field of the body). A fact that held when recorded must hold again. A case
  that asks for a whole-file read must have made one when it was recorded, so its part, merge and
  final requests are in its cassette and a change to those prompts fails too.
- **Recheck** is a replay that writes each case's facts, checked on its recorded answer, to the
  cassette. Run it after you change a fact and no request: a replay whose facts changed since the
  recording fails with "facts changed" until you do. Since 0.99.13 a replay or a recheck also
  fails when a model listed in a case's `failsOn` now passes every fact: the entry is stale.
- **Record** runs each case once on each model (Gemini 3.5 Flash-Lite and 3.8 Flash by default), and
  writes its cassette: each request as a hash with an outline of its fields, and the response. A
  cassette holds no request text and no project ID. Request headers are written from a short list
  (content-type, accept, anthropic-version, anthropic-beta); every other header value, and every
  URL parameter but `alt` and `api-version`, is written as `<redacted>`.
- **Live** runs each case k times. A case passes only when every run passes (pass^k): a real model
  answers a little differently each time. A workflow of the repository runs it every week and on
  demand, once the repository has the `GEMINI_API_KEY` secret; until then it skips with a notice.

Record and live fail a case when a question ends with an error (a refused key, a quota), when a case
not known to fail on 0.9.0 (`failsOn090`), nor on that model (`failsOn`, 0.99.13), misses pass^k,
or when a fact that held in every run of the baseline fails now. Each writes a report, `evals/results/<mode>.md`, with the runs as JSON beside it
(`<mode>.json`, answers included). A replay or a recheck writes one only when given `--results`.
The report gives, for each case and model, whether it passed, the requests (mean and median), the
share of questions answered in one request, reads and whole reads per question, input tokens, the
cached share, latency, whether the question's input-token ceiling was reached, and the line
citations checked per answer. For each model it figures the release gates: counts right, Hebrew
lookups right, Hebrew answered in Hebrew, citations inside what the tools showed, the requests of
inline-table questions, and the facts lost against the baseline, which it lists. The baseline is
the report of 0.9.0, `evals/baseline/0.9.0.md` (runs in `0.9.0.json`). Its answers are kept, so its
facts are checked again as the cases say now.

| Option | What it does |
| --- | --- |
| `--k 3` | Runs of each case, live. |
| `--models a,b` | The Gemini models. |
| `--cases id,id` | Only these cases (their IDs are in `evals/cases.ts`). |
| `--results file.json` | Adds the runs to this file, and writes its report beside it. |
| `--title "…"` | The title of the report. |
| `--notes notes.md` | Markdown put under the report's title. |
| `--baseline file.json` | The results to compare facts with (`evals/baseline/0.9.0.json` by default; `none` for no comparison). |
| `--max-input-tokens N` | No question starts once the run has used this many input tokens. |
| `--question-input-tokens N` | A question that uses more is stopped (1,500,000 by default). |
| `--concurrency N` | Cases run at once (4 against the API, 1 in a replay, by default: a replay runs the cases in the order they were recorded, as a model's part reads learn its output limit once in a process). |

`node evals/cli.mjs report --results file.json` writes the report of a results file again.

A fact is a number (to a tolerance, and next to its label when the value belongs to one row), a
text the answer must say or must not say, a line the answer must cite, or the language: a Hebrew
question is answered with at least 60% Hebrew letters, once citations, file names, numbers, code,
identifiers, names and Latin glosses are left out. Facts read the answer without its markdown
emphasis.

The record and replay under it is internal to `evals/` for now. It becomes public in
`llm-large-files/testing` in 0.10.x, for recording the questions of your own app the same way;
until then, [Recorded replies](#recorded-replies) shows a small version to copy.

## Reference

- `fakeModel`, `says`, `calls`, `httpError`, `fakeFetch`, `sse`, `utf8`, `serviceLog` and
  `documentStoreChecks`: [`llm-large-files/testing`](../reference/testing.md).
- [`ModelAdapter`](../reference/ask.md#modeladapter), [`ModelRequest`](../reference/ask.md#modelrequest),
  [`AskResult`](../reference/ask.md#askresult), [`AskLimits`](../reference/ask.md#asklimits) and
  `partialResultOf`: [the tool loop and the adapter contract](../reference/ask.md).
- [`ModelRequestError`](../reference/errors-and-retries.md#modelrequesterror),
  [`RetryOptions`](../reference/errors-and-retries.md#retryoptions) and `errorKindOf`:
  [errors, retries, streams](../reference/errors-and-retries.md).
- [`MemoryDocumentStore`](../reference/library.md#memorydocumentstore) and the `now` option of
  [`LargeFilesOptions`](../reference/library.md#largefilesoptions):
  [the library and its documents](../reference/library.md).
- The tools a script can call, with their arguments and results: [tools](../reference/tools.md).
- The upload routes, their requests and statuses: [`llm-large-files/node`](../reference/node.md).
- Streaming answers to a browser: [A web app](./web-app.md).
