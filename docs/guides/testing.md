# Testing an integration

This guide shows how to test code that uses llm-large-files without calling a real model: tests
that run in milliseconds, cost nothing and give the same result every time. It is for application
developers. The samples use [Vitest](https://vitest.dev); the helper files they build do not
depend on it.

## What to fake

Fake the layer below the code you test, and nothing above it.

| What you test | What to fake | Section |
| --- | --- | --- |
| Your code around a question: what it stores, shows and streams, and what it does with each error | The model: a scripted `ModelAdapter` | [A scripted model](#a-scripted-model) |
| Your provider setup: the URL, the token, the body fields, how a reply or a stream is read | The network: the `fetch` of a real adapter | [The real adapters with a fake fetch](#the-real-adapters-with-a-fake-fetch) |
| Expiry, owners, deleting | The clock: `now`, with `MemoryDocumentStore` | [Expiry, owners and the clock](#expiry-owners-and-the-clock) |
| Your upload and answer routes | Nothing for uploads, the model for answers: a real server on a free port, called with `fetch` | [Your routes](#your-routes) |
| Whether a real model finds the answer in a real file | Nothing: a few live tests | [Live tests, few and cheap](#live-tests-few-and-cheap) |

The library's own tests work the same way, with a fake model and fake `fetch` functions. Their
helper (`test/fake-model.ts` in the repository) is not part of the package, so the helper below is
one you copy into your own tests.

## Test documents

Use a new `MemoryDocumentStore` in each test: it keeps documents in process memory, so tests do not
share them and leave nothing behind. `ingest` takes the bytes of a file; for text, encode a string
with `TextEncoder`.

A document that fits goes into the prompt whole (by default up to 200,000 estimated tokens of
documents), and the question is then one model request without tools. To test the tool loop with a
small file, lower `budget.inlineTokens`: with 1,000, a document whose estimate is over 1,000 tokens
becomes a card that the model reaches through the tools, as a 50 MB log would. Set it on
`createLargeFiles`, or for one question with `budget` in `askWithFiles`. How the plan is made is in
[How it works](../how-it-works.md).

The helper file below has `bytes()` and `appLog(count)`, a log of `count` lines with a failed
payment on every 50th. From 19 lines on it is over 1,000 estimated tokens. The samples use 400
lines, which hold 8 failed payments.

## A scripted model

`askWithFiles` talks to a model only through a [`ModelAdapter`](../reference/ask.md#modeladapter):
an object with an `id`, its `capabilities` and a `send` method. A fake one answers each request from
a script and records what it was sent. Save this as `test/fake-model.ts`:

```ts
// test/fake-model.ts: a scripted model, and test documents, for code that calls askWithFiles.
import type { GenerateText, ModelAdapter, ModelCapabilities, ModelReply, ModelRequest, SendHooks, ToolCall } from "llm-large-files";

/** One entry of a script: a reply, an error to throw, or a function that picks one from the request. */
export type Scripted =
  | Partial<ModelReply>
  | Error
  | ((request: ModelRequest, call: number, hooks: SendHooks) => Partial<ModelReply> | Error | Promise<Partial<ModelReply> | Error>);

export type FakeModel = ModelAdapter & {
  /** Every request the loop sent, in order, failed ones included. */
  readonly requests: ModelRequest[];
};

/** A reply in text. */
export const says = (text: string, more: Partial<ModelReply> = {}): Partial<ModelReply> => ({ text, ...more });

/** A reply that calls tools. */
export const calls = (list: ToolCall[], more: Partial<ModelReply> = {}): Partial<ModelReply> => ({ calls: list, ...more });

/**
 * A model that answers each request with the next entry of its script; the last entry repeats.
 * An entry that is an Error is thrown, as an adapter throws a request that failed.
 */
export function fakeModel(
  script: Scripted[],
  options: Partial<ModelCapabilities> & { id?: string; generateText?: GenerateText } = {},
): FakeModel {
  const { id = "fake-model", generateText, ...capabilities } = options;
  const requests: ModelRequest[] = [];
  return {
    id,
    // "none": this model takes no files, so view_pages is not offered. Pass toolFiles: "inside" to test it.
    capabilities: { toolFiles: "none", pageTokens: 500, ...capabilities },
    requests,
    ...(generateText ? { generateText } : {}),
    async send(request, hooks = {}) {
      // A copy of the list, so that what was recorded cannot change later.
      requests.push({ ...request, messages: [...request.messages] });
      const entry = script[Math.min(requests.length - 1, script.length - 1)]!;
      const reply = typeof entry === "function" ? await entry(request, requests.length, hooks) : entry;
      if (reply instanceof Error) throw reply;
      const text = reply.text ?? "";
      // When the loop listens for text, pass it on in two pieces, as a streaming adapter would.
      if (text && hooks.onText) {
        const half = Math.ceil(text.length / 2);
        hooks.onText(text.slice(0, half));
        if (half < text.length) hooks.onText(text.slice(half));
      }
      return { calls: [], ...reply, text };
    },
  };
}

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

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

What the parts do:

- **The script.** One entry for each request, in order. The last entry repeats, so a model that
  always says the same thing is a script of one. An `Error` entry is thrown from `send`, as a real
  adapter throws a request that failed. A function entry gets the request, its number (1 for the
  first) and the hooks, and returns the reply: use it when the reply depends on what was asked.
- **`requests`.** A copy of each request as it was sent, failed attempts included.
- **`onText`.** When your code passes `onText` to `askWithFiles`, the loop passes a hook to the
  adapter, and the fake calls it with the text in two pieces, as a stream would arrive.
- **The options.** `id` names the model in `usage.byModel`; give two fakes different ones. A
  `generateText` function offers `analyze_whole_document`, the whole-file read in parts; without it
  that tool is not offered. The capabilities make the fake look like a given model:
  `contextTokens` and `maxRequestBytes` make the budget of a question fit them, `appendOnly: true`
  makes the loop treat it as Claude (a conversation that may only grow), and `toolFiles: "inside"`
  lets the loop offer `view_pages` for PDFs whose original is kept (see [PDFs](./pdfs.md)).

A fake adapter is also the starting point for one of your own: see
[Your own adapter and loop](./own-adapter-and-loop.md).

## A first test

Two tests: a short document that goes in whole, and a log that the model must search.

```ts
// test/ask.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { appLog, bytes, calls, fakeModel, says } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];

describe("questions about documents", () => {
  it("sends a short document whole, in one request without tools", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: bytes("# Notes\n\nThe code word is heron.") });
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
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(appLog(400)) });
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
import { appLog, bytes, calls, fakeModel, says } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: bytes(appLog(400)) });
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
- With an `explorer`, the explorer gets the tool requests and what it writes is not shown. The
  answering model gets one request, with `toolChoice: "none"`. `turns` counts the chat requests of
  both. See [An explorer model](./explorer-model.md).

## What to assert

Assert what your application does with the result. These are the fields of
[`AskResult`](../reference/ask.md#askresult) worth checking, and what a fake makes them:

| Field | What it holds in a test |
| --- | --- |
| `text` | What the script wrote: the answer, after any remark made before a tool call. |
| `answered` | `false` when the last turn had no text: a blocked prompt (`blockReason`), a reply cut off before any text, a broken tool call. Test that your application then shows its own message. |
| `steps` | The steps `onStep` received, in order. They are sentences for people, written by the library. |
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
import { appLog, bytes, calls, fakeModel, says } from "./fake-model.js";

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
  const meta = await files.ingest({ name: "app.log", bytes: bytes(appLog(400)), owner: "alice" });
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

A fake `fetch` answers from a script, as the fake model does, and records each request with its
parsed JSON body. Save this as `test/fake-fetch.ts`:

```ts
// test/fake-fetch.ts: a fetch for the real adapters that answers from a script, without the network.
type Json = Record<string, any>;

/** A request as the adapter sent it. */
export type Sent = { url: string; headers: Record<string, string>; body: Json };

type Reply = Response | ((sent: Sent, call: number) => Response | Promise<Response>);

/** Answers each request with the next reply of the script; the last one repeats. Records every request. */
export function fakeFetch(replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: Sent = {
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as Json,
    };
    sent.push(request);
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    // A body can be read only once: each request gets a copy.
    return typeof reply === "function" ? reply(request, sent.length) : reply.clone();
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

/** A streamed reply: Server-Sent Events, one `data:` line for each event. A string is sent as it is ("[DONE]"). */
export const sse = (events: unknown[]): Response => new Response(
  events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
  { headers: { "Content-Type": "text/event-stream" } },
);
```

### Gemini on Vertex AI

`vertexAi()` with a fixed `accessToken` string makes no call to get a token, so the test needs no
credentials. The replies are in Gemini's own JSON:

```ts
// test/vertex.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, gemini, GeminiRequestError, vertexAi } from "llm-large-files/gemini";
import { appLog, bytes } from "./fake-model.js";
import { fakeFetch, sse } from "./fake-fetch.js";

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
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: bytes(appLog(400)) });
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
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: bytes("# Notes\n\nThe code word is heron.") });
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
import { appLog, bytes } from "./fake-model.js";
import { fakeFetch, sse } from "./fake-fetch.js";

const question = [{ role: "user" as const, text: "How many payments failed?" }];

async function largeLog() {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: bytes(appLog(400)) });
  const args = { document_id: meta.id, query: "ERROR", mode: "exact" };
  return { files, meta, args };
}

describe("other providers, without the network", () => {
  it("runs the loop on an OpenAI-compatible endpoint, and streams its answer", async () => {
    const { files, meta, args } = await largeLog();
    const api = fakeFetch([
      // Asked for a stream, answered in one piece: the adapter reads a reply that is not text/event-stream as JSON.
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
| A streamed request's reply | Read as a stream whatever its content type: a JSON body is no reply | A stream only when the content type is `text/event-stream`; JSON otherwise | A stream only when the content type is `text/event-stream`; JSON otherwise |
| A stream ends with | A chunk with `finishReason` | A chunk with `finish_reason`, or `data: [DONE]` | A `message_delta` event with `stop_reason` |
| An HTTP error body | `{ error: { code, message, status, details } }` | `{ error: { message, type, code, param } }` | `{ type: "error", error: { type, message } }` |
| Error class | `GeminiRequestError` | `OpenAiRequestError` | `AnthropicRequestError` |

A stream that closes without its end is taken for a reply cut off on its way, with `status` 0:
"Gemini's reply ended before it was complete.", "The model's reply ended before it was complete."
(OpenAI-compatible) or "Claude's reply ended before it was complete." The loop then sends the
request again, as for a connection that failed, unless text of it was shown. When a fake stream
seems to be sent twice, check that it ends as the table above says: for Claude, a `message_delta`
event with `stop_reason`, not only `message_stop`.

All three error classes extend `ModelRequestError`, with the same `status` and `kind`. A
`Retry-After` header on an error reply is the wait the loop takes before it sends the request
again; a wait longer than `retry.maxDelayMs` (60,000 ms by default) is not taken, and the error is
thrown.

All three adapters can read a whole file in parts, so `analyze_whole_document` is offered, and its
part reads go through the same `fetch`. Pass `wholeDocumentAnalysis: false` to `askWithFiles` or
`askGemini` when a test is not about it. The adapters' options are in the reference:
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
import { fakeFetch } from "./fake-fetch.js";
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
import { bytes, fakeModel, says } from "./fake-model.js";

describe("documents that expire", () => {
  it("are gone after their time to live, and swept from the store", async () => {
    let clock = new Date("2026-01-01T09:00:00Z");
    const now = () => clock;
    // One clock for both: the library checks expiry by its clock, and the store by its own when it reads.
    const files = createLargeFiles({ store: new MemoryDocumentStore({ now }), now, ttlMs: 60 * 60_000 });
    const meta = await files.ingest({ name: "notes.md", bytes: bytes("The code word is heron."), owner: "alice" });
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
  same error as for a document that expired.
- `files.delete(id, { owner })` returns `false`, and deletes nothing, for a document of another
  owner; for the document's own owner it returns `true`.

To test your own `DocumentStore`, run the same tests against it. The contract is in
[Storage](./storage.md).

## Your routes

The handlers of `llm-large-files/node` take Node's own request and response, so a test can run them
on a real HTTP server, on a free port, and call them with `fetch`. Mount them as your server does;
this one routes `POST /api/documents` to `upload`, and `GET` and `DELETE /api/documents/:id` to
`get` and `remove`:

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
    expect(await asBob.json()).toEqual({ error: "This file is no longer available." });
    expect((await fetch(`${base}/${id}`, { headers: { "X-User": "alice" } })).status).toBe(200);
    const deleted = await fetch(`${base}/${id}`, { method: "DELETE", headers: { "X-User": "bob" } });
    expect(await deleted.json()).toEqual({ deleted: false });
  });
});
```

The other statuses (400 for a file without a name, 413 for one over `maxUploadBytes`, 422 for one
that cannot be read) are in the [`llm-large-files/node` reference](../reference/node.md).

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
import { appLog, bytes } from "./fake-model.js";

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
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: bytes(appLog(400)) });

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

## Reference

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
