# Your own adapter and loop

This guide is for two cases: your model has no adapter in the package, or you already run a tool
loop and want only the documents and their tools. It shows the `ModelAdapter` contract as the loop
uses it, a complete adapter for a made-up provider, a wrapper around an existing adapter (logs,
quotas, a shared limit, a gateway's errors), and a loop of your own built on `files.prepare()` and `files.tools()`.
The exact types are in the [ask reference](../reference/ask.md#modeladapter) and the
[tools reference](../reference/tools.md#toolset).

## Three ways in

| You have | Do this | The library still does | You do |
|---|---|---|---|
| A model the package has no adapter for | [Write an adapter](#a-complete-adapter) and call `askWithFiles` | The plan, the tools, limits, retries, usage, room in the request, the request for the answer | Turn the neutral request into your provider's, and its reply back |
| An adapter of the package, and a need for logs, metrics, quotas or a limit on requests at once | [Wrap it](#wrapping-an-adapter) | Everything | Your code around `send` and `generateText` |
| A tool loop of your own (an agent framework, a provider's SDK) | [Use `prepare()` and `tools()`](#your-own-loop) | The plan, the document text and cards, the tools and their limits | Turns, room, retries, usage, the request for the answer |

Check first whether you need an adapter at all. A server that speaks Chat Completions (vLLM,
Ollama, LiteLLM, a gateway) works with `openAiCompatible()` and its `url`, and a gateway that
proxies Generate Content works with `gemini()` given your own `{ url, streamUrl, headers }`. See
[OpenAI-compatible endpoints](./openai-compatible.md) and [Gemini and Vertex AI](./vertex-and-gemini.md).

## The adapter contract

An adapter is one object. The loop uses these members:

| Member | Required | What the loop does with it |
|---|---|---|
| `id` | Yes | Names the model in `usage.byModel`. Two adapters with the same `id` add up in one entry. |
| `capabilities` | Yes | Sizes the question: see [Capabilities](#capabilities). |
| `send(request, hooks?)` | Yes | Every chat request: each tool turn, and the answer. |
| `generateText` | No | The part reads of `analyze_whole_document`. Without it on the model that explores, that tool is not offered. |
| `requestBytes(request)` | No | The size of a request body, so that the pages of `view_pages` get exactly the room that is left. Without it, the loop estimates. |
| `estimateTokens(text)` | No | Deprecated, and never called. Set `capabilities.tokenScale` instead: see [`requestBytes` and `estimateTokens`](#requestbytes-and-estimatetokens). |

One adapter object serves every question at once, so keep nothing of one request on it. The loop
tells models apart by object, not by `id`: `explorer` set to the same object as `model` is one
model, and two adapters of the same model are two (see [An explorer model](./explorer-model.md)).

### Capabilities

`capabilities` is a [`ModelCapabilities`](../reference/ask.md#modelcapabilities): its fields, their
defaults and what each changes are there. For an adapter of your own:

- Declare `contextTokens`, and `maxRequestBytes` when the provider has a limit. Left unset, the
  question is planned for the library's budget: 1,000,000 tokens and 10,000,000 bytes unless you
  set `budget`.
- `toolFiles` and `pageTokens` are required. With `toolFiles: "none"`, `view_pages` is not offered
  and any `pageTokens` will do. With `"inside"` or `"beside"`, the pages reach `send` in
  `answers[].files`, and your `send` puts them where the provider reads them: the loop only tells
  `"none"` from the other two.
- Set `appendOnly` only when the provider ties reasoning to earlier turns, as Claude ties its
  thinking blocks. It costs room: in a question the model takes part in, old tool results are
  never shortened to make room.
- Set `clearsToolResults` when your provider may clear old tool results from the conversation on
  its side, before the model reads it, as Claude's context editing does. A call the model makes
  again is then run again, instead of answered with a pointer to a result it may no longer have,
  and the pointers in stored rounds become stand-ins that say to call again.

### What `send` receives

`request` is a `ModelRequest`:

- `system`: your system prompt, then the guide to the document tools. On an explorer's requests,
  `EXPLORER_INSTRUCTION` follows. It may be empty: leave it out of the body then.
- `messages`: the conversation, oldest first. Each message is one of two kinds.
  - `{ role: "user" | "assistant", parts }`: a turn of text. A part is `{ text }`, or `{ native }`:
    something in the provider's own form that your application put in `messages` (an image, say),
    to pass through untouched. A native part may also carry `text`, which only sizes it. The text
    and cards of the documents are one `{ text }` part at the start of the first user turn, or at
    the end of the last with `documentPlacement: "last"`.
  - `{ role: "tools", calls, answers, raw? }`: one round of tool use. `calls` are the model's calls
    in order, and `answers` holds one `{ call, result, files? }` for each, in the same order. Send
    each `result` as JSON text: it is a plain object, and the loop adds `tool_turns_left` to it.
    The results of a round stored from an earlier question come without `tool_turns_left`.
    `files` are the pages of a `view_pages` call, one PDF (`application/pdf`), and come only when
    `toolFiles` is not `"none"`.
- `raw` on a round is the model's turn as your `send` returned it: send it back unchanged. The loop
  sets it only on rounds this adapter object produced in this question. A round stored from an
  earlier question (`toolTurns`) or made by another model has none: build the model's turn from
  `calls`, and give a call without an `id` one that is the same for the call and its result.
- The last message is the user's, or a tool round. Two user turns can follow each other: the
  question, then the request for the answer when no tool ran. In a provider whose tool results go
  in a user turn (Gemini, Claude), a tool round followed by the request for the answer is two user
  turns as well. Join them if your provider refuses that, as the OpenAI-compatible adapter does.
- `tools`: the declarations, `{ name, description, parameters }`, in a JSON Schema subset that
  Gemini, OpenAI and Claude accept. Left out when the request needs no tools.
- `toolChoice`: `"auto"` on a request that may call tools, `"none"` on the request for the answer,
  which must be answered in text. With `"none"` the tools are still listed, for a provider that
  wants them declared next to the calls already in the conversation. Leave them out if your
  provider ignores its own "none": the Gemini adapter does.

### Streaming and cancelling: `hooks`

- `hooks.onText` is given when your application streams (`onText` of `askWithFiles`) and the text
  of this request is shown: every chat request without an explorer, and the answering model's
  request with one. An explorer's requests come without it. When it is given, stream if you can,
  and pass each piece of the answer as it arrives. Pass text for the user only, never thoughts.
- The pieces must add up to the start of `reply.text`. What they did not cover is passed on by the
  loop once `send` returns, so an adapter that cannot stream can leave `onText` alone.
- Once a piece was passed, a failure of this request is not sent again: the user has seen it. A
  failure before the first piece is.
- `hooks.signal` aborts when the question is cancelled. Pass it to `fetch`, and when it has
  aborted, throw what `fetch` threw as it is. Nothing is sent again after an abort. The loop does
  not wait for `send` (or `generateText`) once the signal has aborted: the question throws the
  signal's reason at once, and a reply that arrives later is dropped and not counted in `usage`.
  Abort your own request all the same, so that the connection is freed and the provider stops
  billing it.
- The loop always passes `hooks`, but the type says it may be left out: write
  `send(request, hooks = {})`.

### What `send` returns

`send` returns a [`ModelReply`](../reference/ask.md#modelreply): its fields and what the loop does
with each are there. For an adapter of your own:

- `text` is what the model wrote for the user, without thoughts. `calls` is `[]` when there are
  none.
- Give a call that cannot be run as it came a `problem`: arguments that are not a JSON object, or a
  call cut off at the output limit. The loop answers it with `{ error: problem }`, and the model can
  send it again.
- Keep `raw` plain JSON: the loop measures it with `JSON.stringify`.
- Set `blockReason` when the provider refused the prompt, and return no calls with it.
- In `usage`, count the prompt and nothing else in `inputTokens`, cached tokens included; count the
  thoughts in `outputTokens`. Leave out, or give 0 for, what the provider does not report. The loop
  compares `inputTokens` with its own estimate of the request, and makes its later estimates up to
  twice as large when the provider counted more.
- Set `finish` as the next section says.

### How the reply ended: `finish`

| `finish` | Set it when | What the loop does |
|---|---|---|
| `"complete"` | The model ended its turn. | Nothing more. |
| `"cut"` | The reply stopped at the output limit. | A reply with text and no calls is still the answer; `finishReason` tells why it stopped. A first reply without text is not asked for again. |
| `"filtered"` | The provider's safety filters stopped the reply. | The same as `"cut"`. To end the question, set `blockReason` as well, and return no calls. |
| `"malformed_call"` | The model tried to call a tool, and the call could not be read (Gemini's `MALFORMED_FUNCTION_CALL`). | A reply without calls is asked for once more, with a note that says so. |
| Unset | You do not know why it ended. | The same as `"complete"`. |

Two kinds of reply are asked for once more, with a note that says what was wrong: a
`"malformed_call"` reply without calls, and a first reply with no text and no calls before any tool
ran, unless it was `"cut"` or `"filtered"`. A question makes at most two such second tries, each
takes a tool turn, and none is made when only the turn for the answer is left. Any other reply
without text, and the last tool turn, lead to one more request, with `toolChoice: "none"`, that
asks for the answer. When the reply to that request has no text either, or holds calls (which
`"none"` forbids), it is asked for once more, with a note that is not kept, unless it was
`"filtered"`, blocked, or `"cut"` with nothing in it. That try is one of the two, and may be one
request past `limits.toolTurns`.

### Errors to throw

Throw a `ModelRequestError` for every request that failed:
`new ModelRequestError(message, status, options?)`. Its options are all optional.

| Argument | What to give |
|---|---|
| `message` | The provider's message. The kind is read from it, and so are `limitTokens` and `requestedTokens` for a request too large. It is the provider's wording: log it, and do not show it to users. |
| `status` | The HTTP status. `0` for a request that got no answer: the connection failed, or a stream closed before it said how it ended. |
| `retryAfterMs` | The wait the provider asked for. `retryAfterMs(response.headers, body)` reads `retry-after-ms`, `Retry-After`, and the `RetryInfo` of a Gemini error body. |
| `code` | The provider's own word for the error (OpenAI's `error.code`, Claude's `error.type`, Gemini's `error.status`). `"insufficient_quota"` makes it a `"quota"`, as do HTTP 402 and a message that only a quota writes (no credit left, a spending cap, a quota per day). `"context_length_exceeded"` and `"request_too_large"` make it a `"context_overflow"` for a status below 500 other than 429, whose message does not speak of rate limits. A 429 or 413 that says "Request too large for … on tokens per min" (OpenAI's and Groq's TPM) is a `"context_overflow"` too, with its numbers. With status 0 the code is not read: the kind is `"unreachable"` unless you give `kind`. |
| `details` | The `details` of a Gemini error: a daily quota and an API key that is not valid are told from them. |
| `kind` | The kind, when you know it better than the classifier: `"timeout"` with status 0 when your own wait for a silent model ran out, or `"context_overflow"` for a gateway's wording that the classifier does not know. Give that one with the 4xx status the gateway sent, such as 400 (a 413 is read as one without it), and see [Wrapping an adapter](#wrapping-an-adapter). |
| `cause` | The error underneath, for your logs. |

The kind is told from the status, the message, `code` and `details` by `classifyModelError`, which
you can call to see how a message is read. The kinds and what to show for each are in
[Errors and reliability](./errors-and-reliability.md). What the loop does with your error:

- **Sent again**, up to 3 times by default (`AskOptions.retry`): status 0, 408, 409, 429 and 5xx
  (`isRetryableStatus`). The wait is 500 ms, doubled for each try, times a jitter between 0.5 and
  1, and never more than `maxDelayMs` (60 seconds). The wait in `retryAfterMs` is taken instead,
  unless it is longer than `maxDelayMs`: the error is then thrown at once.
- **Sent again once**: kind `"timeout"` with status 0.
- **Not sent again**: kind `"quota"`, any other status, and an error without a status (a plain
  `Error` ends the question). Nothing is sent again once text of the request was passed to
  `onText`, or after the signal aborted.
- **Made smaller**: kind `"context_overflow"`. It is never sent again as it is, whatever its status:
  only a smaller request can pass. Older tool results are shortened and the request is sent again,
  at most twice in a question, and never for an `appendOnly` model. When nothing could be
  shortened, or the shortened request was refused again, and no tool has run yet and no text was
  shown, the documents are planned again, once, for the window the provider named (`limitTokens`)
  or a smaller one. Otherwise the error is thrown. So set this kind only on an error that a wait
  would not mend.

A body of HTTP 200 that is not JSON (a gateway's page in the model's place) is best thrown as
`new ModelRequestError(message, response.status, { kind: "invalid", cause })`, as the package's
adapters do: it is not sent again, and a whole-file read tells the model "The model's reply could
not be read (HTTP 200).". An empty body of HTTP 200 is a reply cut off on its way: the package's
adapters throw it with status 0, which is sent again.

The error that ends a question reaches your code as it is, and `partialResultOf(error)` gives what
the question found and paid for until then. The adapters of the package throw subclasses
(`GeminiRequestError`, `OpenAiRequestError`, `AnthropicRequestError`); a subclass of your own
works the same way.

### Part reads: `generateText`

`analyze_whole_document` reads a file in parts, one plain completion each, through the
`generateText` of the model that explores: the explorer when there is one, otherwise `model`. A
`GenerateText` takes `{ system, prompt, maxOutputTokens, signal?, onTruncated?, onUsage? }` and
returns the text of the reply.

- One prompt, no tools, no conversation. `maxOutputTokens` is 4,096 for the notes on a part and
  for a merge of notes, and 8,192 for the answer of the read. Send it as the provider's output
  limit, and pass `signal` to the request.
- Call `onUsage` once for each request that was answered, with its tokens as in `usage` above. A
  part read that returns without calling it is counted as a request with no tokens.
- Call `onTruncated` when the reply stopped at the output limit, or a filter stopped it: the read
  then says that its answer is incomplete.
- Throw when the reply has no text. An empty string is taken as the notes on the part, and the
  part is not reported as one that could not be read.
- Throw `ModelRequestError` as `send` does. Part reads are sent again by the same rules, and an
  error without a status is tried once more at once. A part that still fails is reported as one
  that could not be read; one refused as too large (`"context_overflow"`) may be read as two
  halves. Up to four requests of one read run at once.
- The model is told why a part failed by the error's kind, its HTTP status (`status`,
  `statusCode` or `response.status`, as a provider's SDK sets them) or the code of a connection
  that failed, never by its message, which may name a host or a key. A plain `Error` without them
  is told as "The model request failed.". So give your errors a `kind` or a `status`
  ([Failures inside tools](./errors-and-reliability.md#failures-inside-tools)).
- A model that thinks counts its thoughts in `maxOutputTokens`, and can spend all of it on them.
  The adapters of the package send such a request again with `THINKING_OUTPUT_TOKENS` (32,768,
  exported by `llm-large-files/gemini`). For a model of yours that thinks, send at least that.
- Set a timeout of your own. The adapters of the package give a part read 180 seconds.

### `requestBytes` and `estimateTokens`

`requestBytes(request)` returns the size in bytes of the body `send` would post for `request`. The
loop calls it on the model that explores, in a turn that looks at pages, with the model's turn
that is about to be answered as a last round whose `answers` is empty. The pages then get what is
left of `maxRequestBytes` after that request and a margin of a tenth of it (at least 256 KB),
times 3/4 for base64. Without `requestBytes`, the loop uses its estimate of the request. The size
of the body without streaming is close enough.

`estimateTokens(text)` is deprecated: the loop never calls it, and a later version may remove it.
Every size is the library's estimate (`estimateTokens` from `llm-large-files`) scaled by
`capabilities.tokenScale`: set that for a tokenizer that counts differently, and leave the
`estimateTokens` member out of your adapter. An adapter that still declares it compiles as before.

## A complete adapter

Example AI is a made-up provider, so that the adapter shows the contract and nothing else. Its API
takes one `POST` to `{baseUrl}/chat` with `model`, `system`, `messages`, `tools`, `tool_choice` and
`stream`. A message is `{ role, content }`. A model turn may carry `tool_calls`
(`{ id, name, arguments }`, the arguments as JSON text), and a `tool` message answers one by its
`tool_call_id`. A reply is `{ message, stop_reason, usage }`. A stream sends `text`, `tool_call`,
`end` and `error` events. Errors are HTTP statuses with `{ error: { message, code } }`, and
`max_output_tokens` sets the output limit.

```ts
// example-ai.ts: an adapter for Example AI, a made-up provider.
import {
  ModelRequestError,
  parseSseJson,
  retryAfterMs,
  SseEventTooLongError,
  type GenerateText,
  type ModelAdapter,
  type ModelMessage,
  type ModelReply,
  type ModelRequest,
  type ModelUsage,
  type ToolCall,
} from "llm-large-files";

// The provider's own shapes.
type ExampleCall = { id: string; name: string; arguments: string };
type ExampleMessage = { role: "user" | "assistant" | "tool"; content: unknown; tool_calls?: ExampleCall[]; tool_call_id?: string };
type ExampleUsage = { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_tokens?: number };
type ExampleReply = { message?: { content?: string; tool_calls?: ExampleCall[] }; stop_reason?: string; usage?: ExampleUsage };
type ExampleEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ExampleCall }
  | { type: "end"; stop_reason: string; usage?: ExampleUsage }
  | { type: "error"; status?: number; message: string };

export type ExampleAiOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The model's context window, in tokens. */
  contextTokens: number;
};

/** Every prompt token, cached ones included; every output token, reasoning included. */
const usageOf = (usage: ExampleUsage | undefined): Partial<ModelUsage> => ({
  inputTokens: usage?.input_tokens ?? 0,
  cachedInputTokens: usage?.cached_input_tokens ?? 0,
  outputTokens: usage?.output_tokens ?? 0,
  thoughtTokens: usage?.reasoning_tokens ?? 0,
});

const finishOf = (reason: string | undefined): ModelReply["finish"] => {
  if (reason === "end" || reason === "tool_calls") return "complete";
  if (reason === "max_tokens") return "cut";
  if (reason === "safety") return "filtered";
  if (reason === "malformed_tool_call") return "malformed_call";
  return undefined;
};

/** A call whose arguments are not a JSON object is answered with `problem`, not run. */
function toCall(call: ExampleCall): ToolCall {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    args = undefined;
  }
  if (args && typeof args === "object" && !Array.isArray(args)) return { id: call.id, name: call.name, args: args as Record<string, unknown> };
  return { id: call.id, name: call.name, args: {}, problem: `The arguments were not a JSON object: ${call.arguments.slice(0, 200)}. Send the call again.` };
}

function replyOf(text: string, calls: ExampleCall[], reason: string | undefined, usage: ExampleUsage | undefined): ModelReply {
  const finish = finishOf(reason);
  return {
    text,
    calls: calls.map(toCall),
    // This turn as the provider wrote it: it comes back in `raw` of the tool round, to be sent as it is.
    raw: { role: "assistant", content: text, tool_calls: calls } satisfies ExampleMessage,
    ...(reason ? { finishReason: reason } : {}),
    ...(finish ? { finish } : {}),
    // Refused before it wrote anything: the question ends here, with `blockReason`.
    ...(reason === "safety" && !text && calls.length === 0 ? { blockReason: "safety" } : {}),
    ...(usage ? { usage: usageOf(usage), providerUsage: usage } : {}),
  };
}

/** The neutral conversation in Example AI's form. */
function toMessages(messages: ModelMessage[]): ExampleMessage[] {
  return messages.flatMap((message, at): ExampleMessage[] => {
    if (message.role !== "tools") {
      // Text parts, and parts in the provider's own form that the application passed in `messages`.
      return [{ role: message.role, content: message.parts.map((part) => (part.native !== undefined ? part.native : { type: "text", text: part.text })) }];
    }
    // A call without an ID (a stored round) gets one from its place: the same for the call and its result.
    const idOf = (call: ToolCall, index: number) => call.id ?? `call_${at}_${index}`;
    // This adapter's own turn goes back unchanged. Without `raw` (a stored round, or another model's), it is built from the calls.
    const asked: ExampleMessage = message.raw !== undefined ? message.raw as ExampleMessage : {
      role: "assistant",
      content: "",
      tool_calls: message.calls.map((call, index) => ({ id: idOf(call, index), name: call.name, arguments: JSON.stringify(call.args) })),
    };
    // One answer for each call, in call order.
    const results = message.answers.map((answer, index): ExampleMessage => ({
      role: "tool",
      tool_call_id: idOf(answer.call, index),
      content: JSON.stringify(answer.result),
    }));
    // Pages from view_pages go "beside" the results, in a user turn of their own.
    const files = message.answers.flatMap((answer) => (answer.files ?? []).map((file) => ({
      type: "file",
      name: file.name,
      mime_type: file.mimeType,
      data: Buffer.from(file.bytes).toString("base64"),
    })));
    return [asked, ...results, ...(files.length > 0 ? [{ role: "user" as const, content: files }] : [])];
  });
}

export function exampleAi(options: ExampleAiOptions): ModelAdapter {
  const bodyOf = (request: ModelRequest, stream: boolean) => ({
    model: options.model,
    ...(request.system ? { system: request.system } : {}),
    messages: toMessages(request.messages),
    // `toolChoice: "none"`: the tools stay listed, and the model must answer in text.
    ...(request.tools?.length ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" } : {}),
    stream,
  });

  /** Posts a body. A failed connection is status 0; an HTTP error keeps its status, code and wait. */
  const post = async (body: unknown, signal: AbortSignal | undefined): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // Stopped by the caller (or by a timeout of ours): passed on as it is.
      if (signal?.aborted) throw error;
      throw new ModelRequestError("Example AI could not be reached.", 0, { cause: error });
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
      const wait = retryAfterMs(response.headers, data);
      throw new ModelRequestError(data?.error?.message ?? `Example AI returned HTTP ${response.status}.`, response.status, {
        code: data?.error?.code,
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
      });
    }
    return response;
  };

  /** Part reads of analyze_whole_document: one prompt, no tools, no streaming. */
  const generateText: GenerateText = async ({ system, prompt, maxOutputTokens, signal, onTruncated, onUsage }) => {
    const timeout = AbortSignal.timeout(180_000);
    const response = await post({
      model: options.model,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      max_output_tokens: maxOutputTokens,
      stream: false,
    }, signal ? AbortSignal.any([signal, timeout]) : timeout);
    const data = (await response.json()) as ExampleReply;
    onUsage?.(usageOf(data.usage));
    const text = data.message?.content ?? "";
    if (!text.trim()) throw new Error(`Example AI returned no text (${data.stop_reason ?? "no reason given"}).`);
    if (data.stop_reason === "max_tokens" || data.stop_reason === "safety") onTruncated?.();
    return text;
  };

  return {
    id: options.model,
    capabilities: { contextTokens: options.contextTokens, toolFiles: "beside", pageTokens: 1_000 },
    requestBytes: (request) => Buffer.byteLength(JSON.stringify(bodyOf(request, false))),
    generateText,

    async send(request, hooks = {}) {
      const stream = Boolean(hooks.onText);
      const response = await post(bodyOf(request, stream), hooks.signal);
      if (!stream || !response.body) {
        // In one piece. The loop passes the text on to onText itself.
        const data = (await response.json()) as ExampleReply;
        return replyOf(data.message?.content ?? "", data.message?.tool_calls ?? [], data.stop_reason, data.usage);
      }
      let text = "";
      const calls: ExampleCall[] = [];
      let end: { stop_reason: string; usage?: ExampleUsage } | undefined;
      try {
        for await (const event of parseSseJson<ExampleEvent>(response.body, { signal: hooks.signal })) {
          if (event.type === "error") throw new ModelRequestError(event.message, event.status ?? 500);
          if (event.type === "text") {
            text += event.text;
            hooks.onText?.(event.text);
          } else if (event.type === "tool_call") {
            calls.push(event.call);
          } else {
            end = event;
          }
        }
      } catch (error) {
        if (hooks.signal?.aborted || error instanceof ModelRequestError) throw error;
        // An event too long to hold would come again: not sent again (status 200, kind "invalid").
        if (error instanceof SseEventTooLongError) throw new ModelRequestError(error.message, response.status, { kind: "invalid", cause: error });
        throw new ModelRequestError("The connection to Example AI failed during the reply.", 0, { cause: error });
      }
      // No end event: the stream was cut off on its way. Sent again like a lost connection, unless text was shown.
      if (!end) throw new ModelRequestError("Example AI's reply ended before it was complete.", 0);
      return replyOf(text, calls, end.stop_reason, end.usage);
    },
  };
}
```

It is a model like any other:

```ts
import { readFile } from "node:fs/promises";
import { askWithFiles, createLargeFiles, FileDocumentStore } from "llm-large-files";
import { exampleAi } from "./example-ai.js";

const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });
const model = exampleAi({
  baseUrl: process.env.EXAMPLE_AI_URL!,
  apiKey: process.env.EXAMPLE_AI_KEY!,
  model: "example-large",
  contextTokens: 256_000,
});

const log = await files.ingest({ name: "app.log", bytes: await readFile("./app.log") });
const result = await askWithFiles({
  files,
  model,
  documentIds: [log.id],
  messages: [{ role: "user", text: "Why did the checkout service time out?" }],
  onText: (delta) => process.stdout.write(delta),
});
console.log("\n", result.answered, result.usage.byModel["example-large"]);
```

What this adapter leaves out, and the adapters of the package do:

- **A wait for a silent model.** A request here waits as long as `fetch` does. The adapters of the
  package abort a request that sends nothing for `firstByteTimeoutMs` (600 seconds by default), or
  nothing between two pieces for `idleTimeoutMs` (300 seconds), and throw kind `"timeout"` with
  status 0. [`parseSseJson`](#parsessejson) below shows such a wait.
- **Two user turns in a row** are sent as they are. Join them if your provider refuses them.
- **A call cut off at the output limit** is run when its arguments still parse. The OpenAI-compatible
  adapter gives every call of a reply that ended at the limit a `problem` instead.
- **A body that is not JSON** throws a `SyntaxError`, which has no status: a chat request is not
  sent again, a part read is tried once more, and the model is told "The model request failed.".
  The adapters of the package throw kind `"invalid"` with the response's status for it, which is
  not sent again, and kind `"unreachable"` with status 0, which is, for an empty body.
- **A part read with no text** throws a plain `Error`, and the model is told "The model request
  failed.", not its message. The package's part readers say "The model returned no text
  (SAFETY).", with the provider's reason.
- **`pageTokens: 1_000`** is a placeholder: give what your provider bills for one PDF page.
- **A model that thinks**: `generateText` sends `maxOutputTokens` as it is.

## Wrapping an adapter

A wrapper is an adapter that calls another. It sees every chat request (`send`) and every part read
(`generateText`) of the questions it is given, so it is the place for logs, metrics, a quota per
user, and a limit on requests at once: the loop runs up to four tool calls of a turn at once, and
up to four requests of a whole-file read, but sets no limit across questions.

Keep the inner adapter's `id` and `capabilities`, pass `hooks` through unchanged, and keep
`requestBytes` and `generateText` when the inner adapter has them. A wrapper without
`generateText` turns whole-file reads off.

```ts
// controlled.ts: any adapter, with a quota per user, a shared limit and a record of every request.
import { ModelRequestError, type GenerateText, type ModelAdapter, type ModelRequest, type ModelUsage } from "llm-large-files";

/** Your own accounting: a database table, a metrics client. */
export type Accounting = {
  /** How many model requests this user may still make today. */
  requestsLeft(user: string): Promise<number>;
  record(entry: { user: string; model: string; kind: "chat" | "part"; ms: number; usage: Partial<ModelUsage> | undefined }): void;
};

// At most 16 model requests at once in this process, over every question and every user.
const MOST_AT_ONCE = 16;
let running = 0;
const waiting: Array<() => void> = [];
async function inTurn<T>(run: () => Promise<T>): Promise<T> {
  while (running >= MOST_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function controlled(inner: ModelAdapter, user: string, accounting: Accounting): ModelAdapter {
  const reader = inner.generateText;
  const generateText: GenerateText | undefined = reader && ((request) => inTurn(() => {
    const started = Date.now();
    return reader({
      ...request,
      // Called once for each answered part read: record it, and pass it on to the loop's totals.
      onUsage: (usage) => {
        accounting.record({ user, model: inner.id, kind: "part", ms: Date.now() - started, usage });
        request.onUsage?.(usage);
      },
    });
  }));

  return {
    // The same id and capabilities: usage totals and the budget stay those of the model.
    id: inner.id,
    capabilities: inner.capabilities,
    ...(inner.requestBytes ? { requestBytes: (request: ModelRequest) => inner.requestBytes!(request) } : {}),
    ...(generateText ? { generateText } : {}),

    async send(request, hooks) {
      if (await accounting.requestsLeft(user) <= 0) {
        // Kind "quota" is never sent again: the question ends with this error.
        throw new ModelRequestError("This user has no model requests left today.", 429, { kind: "quota" });
      }
      return inTurn(async () => {
        const started = Date.now();
        // The hooks go through unchanged: onText streams the answer, signal cancels the request.
        const reply = await inner.send(request, hooks);
        accounting.record({ user, model: inner.id, kind: "chat", ms: Date.now() - started, usage: reply.usage });
        return reply;
      });
    },
  };
}
```

Wrap the Vertex AI model, and handle the quota where the question is asked:

```ts
import { GoogleAuth } from "google-auth-library";
import { askWithFiles, errorKindOf, partialResultOf } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { controlled } from "./controlled.js";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const vertex = gemini(vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: "gemini-3.8-flash",
  accessToken: async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("No access token from the application default credentials.");
    return token;
  },
}));

// files, documentIds, userId and accounting come from your application.
try {
  const result = await askWithFiles({
    files,
    model: controlled(vertex, userId, accounting),
    documentIds,
    owner: userId,
    messages: [{ role: "user", text: "Summarize the errors of the last hour." }],
  });
  console.log(result.text);
} catch (error) {
  if (errorKindOf(error) !== "quota") throw error;
  // What the question found and paid for before the allowance ran out.
  console.log("Allowance used up.", partialResultOf(error)?.usage.requests ?? 0, "requests made");
}
```

- **Retries go through the wrapper.** The loop sends a failed request again by calling `send`
  again, so the quota is checked before every try, and a try that failed is not recorded.
- **The queue does not watch the signal.** A cancelled question waits for its turn, and then fails
  at once.
- **One wrapper per model and question.** `controlled(vertex, ...)` called twice gives two
  adapters: passed as `model` and `explorer`, they would be two models. Pass the same wrapper
  object, or leave `explorer` out.
- **Headers are not the wrapper's.** `send` never sees the HTTP request. For a header per tenant,
  use the adapter's own options: a `headers` function (on `openAiCompatible()` and `anthropic()`,
  or the endpoint's `headers` for `gemini()`), or its `fetch` option. Both are called for every
  request.

**Errors a gateway words its own way.** When a gateway refuses a request as too large in words the
classifier does not know, the error gets another kind, most often `"invalid"`, and the loop makes
no room for it. A wrapper can catch the inner adapter's error and throw a new one with the kind:
`kind` is read-only, so the error cannot be changed in place.

```ts
// gateway-errors.ts: a gateway's own wording for a request too large, read as one.
import { ModelRequestError, type ModelAdapter } from "llm-large-files";

const TOO_LARGE = /prompt exceeds the gateway's token limit/i; // your gateway's wording

export function withGatewayErrors(inner: ModelAdapter): ModelAdapter {
  return {
    ...inner, // id, capabilities, requestBytes and generateText stay the inner adapter's
    async send(request, hooks) {
      try {
        return await inner.send(request, hooks);
      } catch (error) {
        if (error instanceof ModelRequestError && error.kind === "invalid" && TOO_LARGE.test(error.message)) {
          // Keep the gateway's status. With this kind the error is never sent again as it is: the loop makes room.
          throw new ModelRequestError(error.message, error.status, { kind: "context_overflow", cause: error });
        }
        throw error;
      }
    },
  };
}
```

- The new error is a plain `ModelRequestError`: code that checks for a subclass, such as
  `GeminiRequestError`, no longer sees one. The first error is its `cause`.
- It has no `limitTokens`: those are read only from wording the classifier knows. A plan made
  again for it is for 7/10 of the window the budget assumed.
- Part reads do not go through `send`. Wrap `generateText` the same way when they pass the same
  gateway: a part refused as too large can then be read as two halves.

For a scripted adapter in tests, see [Testing](./testing.md).

## Your own loop

When you already run a tool loop, use the library for the documents only: `files.prepare()` plans
a request, and `files.tools()` gives the tools to offer and runs their calls. Nothing of
`askWithFiles` runs then.

### What is yours to do

- **Turns, and a last request for the answer.** Limit the turns, and end with a request that must
  be answered in text. The notes the loop sends for that are exported: `FINAL_ANSWER_REQUEST`
  (after tool results), `FINAL_ANSWER_AFTER_PAGES` (when the only tool was `view_pages`) and
  `FINAL_ANSWER_WITHOUT_TOOLS` (when no tool ran).
- **Room in the request.** One result is capped at `budget.toolResultCharacters` (24,000 by
  default), but nothing stops a turn of many calls from filling the window. Limit the calls of a
  turn, and pass the room that is left as `maxResultCharacters`. When the request runs short,
  replace the results of older rounds with `stubResult(call, result, hadFiles)`: the short
  stand-in `askWithFiles` uses, which keeps the document's name and the lines or pages the result
  showed, so that the model can get them again. Pass `true` as `hadFiles` for a result that came
  with pages, and drop the pages with it. It is `undefined` when it would save nothing: an error, a stand-in
  already, or a result under 700 characters without pages. Leave the turns of a model whose
  conversation may only grow, such as Claude, as they are ([Capabilities](#capabilities)).
- **Retries**, with [`withRetry`](#withretry) and errors that carry a status.
- **Usage.** `UsageMeter` sums it by model: `meter.add(modelId, usage)`, then `meter.totals`.
- **Steps and evidence.** `tools.describe(name, args)` labels a call ("Search app.log (exact) for
  “timeout”"), `toolResultSummary(label, result)` adds what it found ("— 12 matching lines", "— 1
  matching line"), and `evidenceOf(call, result)` gives the lines or pages it showed. A label
  quotes the model's words: `askWithFiles` makes its steps one line of plain text (no line breaks,
  no text-direction controls, `](` written `] (`), and a loop of your own should show them as plain
  text too, never as markdown or HTML.
- **Rounds of an earlier question.** `askWithFiles` sends their results without
  `tool_turns_left`, a count that was of their own question's turns. Leave it out too when you send
  stored rounds again.

Some of what `askWithFiles` does has no public form, and is not there in a loop of your own: when
to shorten old tool results, recovering from a request too large, the second try after an empty
reply or a malformed call, a pointer in place of a call that repeats one already answered, and
refusing a whole-file read that would pass a ceiling of the question before it starts.

### The steps

1. **Plan.** `files.prepare(documentIds, base, { owner, scope, viewPages, wholeDocumentAnalysis, budget })`.
   `base` is the size of the rest of the request, `{ tokens, bytes }`: the system prompt and the
   conversation, with a margin for what frames them (`askWithFiles` adds 2,000 tokens and 8,000
   bytes). The documents are fitted into what the budget leaves. Pass `wholeDocumentAnalysis: false`
   when your tools will have no `generate` (step 3): the instruction then leaves out
   `analyze_whole_document`, and the cards do not offer a whole-file read. The result is a
   `PreparedContext`:
   - `missing`: IDs that were never uploaded, were deleted, have expired, or belong to another
     owner or scope. Stop and ask for them again. `askWithFiles` throws `DocumentsNotFoundError`
     here, unless its `onMissingDocuments` says to answer without them (the plan you got is already
     made without them) or brings them back (plan again).
   - `blocks`: for each document, its whole text or its card. Put them at the start of the first
     user turn, in the order of your IDs.
   - `instruction`: the guide to the tools, for the system prompt. Empty when there is nothing to
     search or look at.
   - `plan`: `inline` (sent whole), `searchable` (reached through the tools), and the tokens and
     bytes of the inline text.
   - `viewable`: the PDFs whose pages `view_pages` can show, because their uploaded file is kept
     (`keepOriginals`). Empty unless you pass `viewPages: true` and the store keeps originals.
2. **No tools needed?** When `plan.searchable` and `viewable` are both empty, every document is in
   the prompt: send one request without tools.
3. **Tools.** `files.tools(prepared.plan.searchable, options)` gives a `ToolSet`. The options that
   matter here: `access` (the owner and scope of step 1), `generate` (a `GenerateText`, which turns on `analyze_whole_document`; without it,
   plan with `wholeDocumentAnalysis: false` in step 1), `viewPages` (pass `prepared.viewable`, and
   only when your loop sends files to the model), `signal`, `onProgress` (progress of whole-file
   reads, for every call; per call, see [`ToolCallHooks`](#progress-of-each-call-toolcallhooks)),
   `maxWholeDocumentReads` (1 by default), `regexBudgetMs` (6,000), `retry` and `budget`.
   Make one tool set for each question: the count of whole-file reads and the time for regex
   searches belong to it. The full list is in the
   [library reference](../reference/library.md#tooloptions).

   Pass `access: { owner, scope }`, new in 0.9.0: each call then asks the store for the document
   with that owner and scope, and checks the ones the store holds against them, whatever the
   metadata handed in says. A document of another owner or scope reads nothing: each call answers
   `doc_… is no longer available on the server. …`. Under `requireOwner` or `requireScope`, `tools()`
   throws without it. Without `access`, as before 0.9.0, each call compares the owner and scope
   stored with the document with those of the metadata it was handed, so pass `tools()` only
   metadata that came back for this user: `prepared.plan.searchable` and `prepared.viewable` from
   `prepare(ids, base, { owner, scope })`, or `getMeta(id, { owner, scope })`.
4. **Offer** `tools.declarations` in your provider's form. Gemini takes them as
   `functionDeclarations` (`toGeminiTools`), the OpenAI-compatible adapter sends each as
   `{ type: "function", function: declaration }`, and the Claude adapter as
   `{ name, description, input_schema: parameters }`.
5. **Run** each call with `tools.executeWithFiles(name, args, limits, hooks?)`, which returns
   `{ result, files }`. It does not throw for a call that went wrong: an unknown tool, bad
   arguments, a document outside this tool set, a store that failed, or a whole-file read that
   failed all come back as `{ error }`, for the model to read. It throws only when your `signal`
   aborted. `files` is empty for every tool but `view_pages`, whose pages come as one PDF
   (`{ name, mimeType: "application/pdf", bytes }`): send it with the result, in your provider's
   form. `tools.execute(name, args)` is the same without files and without limits, and answers
   `view_pages` with an error, because it has nowhere to put the pages. An unknown tool is
   answered `Unknown tool “do_magic”.`, its name quoted and cut at 64 characters. A whole-file read
   whose model requests failed tells the model why by the kind and status of the error, never by
   its words ([Failures inside tools](./errors-and-reliability.md#failures-inside-tools)).

   To offer tools of your own as well, declare them next to `tools.declarations`, with names other
   than the library's (`TOOL_NAMES`), and send a call to `tools.executeWithFiles` only when
   `tools.has(call.name)`. Run the others yourself, and treat their arguments as untrusted input:
   a file the model reads can ask it for anything. Check them, and ask the user before anything
   that cannot be undone.
6. **Loop** with the results, and end with a request for the answer.

Plan and run the tools with the same budget. The library's own fits a model with a 1M-token window
unless you set `budget.contextTokens` in `createLargeFiles`. For a budget of one request, pass
`budget` to both `prepare` and `tools`; `files.budgetFor(overrides, { contextTokens, maxRequestBytes })`
gives one that fits a model's limits.

### A loop on Vertex AI

This loop answers one question with Gemini on Vertex AI, through the Generate Content REST API and
the helpers of `llm-large-files/gemini`: `toGeminiTools` for the declarations,
`geminiFunctionResponseTurns` for the results and their pages, `createGeminiGenerateText` for part
reads, and `usageOfGemini` for usage.

```ts
import { GoogleAuth } from "google-auth-library";
import {
  createLargeFiles,
  estimateTokens,
  evidenceOf,
  FileDocumentStore,
  FINAL_ANSWER_AFTER_PAGES,
  FINAL_ANSWER_REQUEST,
  jsonBytes,
  retryAfterMs,
  toolResultSummary,
  UsageMeter,
  withRetry,
  type Evidence,
  type ToolAnswer,
  type ToolCall,
} from "llm-large-files";
import {
  createGeminiGenerateText,
  GEMINI_PAGE_TOKENS,
  geminiFunctionResponseTurns,
  GeminiRequestError,
  toGeminiTools,
  usageOfGemini,
  vertexAi,
  type GeminiContent,
} from "llm-large-files/gemini";

const MODEL = "gemini-3.8-flash";
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: MODEL,
  accessToken: async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("No access token from the application default credentials.");
    return token;
  },
});

// Keep the uploaded PDFs, so that view_pages can show their pages.
const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files"), keepOriginals: ["pdf"] });

const MAX_TURNS = 8; // model requests of the chat, the answer's included
const MAX_CALLS = 8; // tool calls run in one turn
const MAX_REQUESTS = 40; // every model request of the question, part reads included

type GenerateResponse = { candidates?: Array<{ content?: GeminiContent }>; usageMetadata?: Record<string, unknown> };

/** One generateContent request. Its errors carry the status and kind that withRetry reads. */
async function generateContent(body: unknown, signal: AbortSignal | undefined): Promise<GenerateResponse> {
  const headers = typeof endpoint.headers === "function" ? await endpoint.headers() : endpoint.headers;
  let response: Response;
  try {
    response = await fetch(endpoint.url, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GeminiRequestError("Vertex AI could not be reached.", 0, { cause: error });
  }
  const data = (await response.json().catch(() => null)) as (GenerateResponse & { error?: { message?: string; status?: string; details?: unknown } }) | null;
  if (!response.ok) {
    const wait = retryAfterMs(response.headers, data);
    throw new GeminiRequestError(data?.error?.message ?? `Vertex AI returned HTTP ${response.status}.`, response.status, {
      code: data?.error?.status,
      details: data?.error?.details,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    });
  }
  // A reply whose body could not be read: sent again, like a connection that failed.
  if (!data) throw new GeminiRequestError("The reply of Vertex AI could not be read.", 0);
  return data;
}

export async function ask(question: string, documentIds: string[], owner: string, signal?: AbortSignal) {
  const system = "You answer questions about the user's files. Cite line numbers.";
  const usage = new UsageMeter();
  const evidence: Evidence[] = [];
  const budget = files.budget;

  // 1. The plan. `base` is the size of the rest of the request: the system prompt and the question, with a margin.
  const base = { tokens: estimateTokens(system + question) + 2_000, bytes: jsonBytes(system + question) + 8_000 };
  const prepared = await files.prepare(documentIds, base, { owner, viewPages: true });
  if (prepared.missing.length > 0) throw new Error(`Attach these files again: ${prepared.missing.join(", ")}`);

  // 2. Whole texts and cards at the start of the question, the guide to the tools in the system prompt.
  const blocks = [...new Set(documentIds)].flatMap((id) => prepared.blocks.get(id) ?? []);
  const contents: GeminiContent[] = [{ role: "user", parts: [...blocks.map((text) => ({ text })), { text: question }] }];
  const systemInstruction = { parts: [{ text: [system, prepared.instruction].filter(Boolean).join("\n\n") }] };

  // 3. One tool set for this question: the documents that are searched, and the PDFs whose pages can be shown.
  const needsTools = prepared.plan.searchable.length > 0 || prepared.viewable.length > 0;
  const readPart = createGeminiGenerateText({ url: endpoint.url, headers: endpoint.headers });
  const tools = files.tools(prepared.plan.searchable, {
    // The store's owner of each document is checked against this one on every call.
    access: { owner },
    // Part reads of analyze_whole_document, counted with the chat's requests.
    generate: (request) => readPart({ ...request, onUsage: (used) => usage.add(MODEL, used) }),
    viewPages: prepared.viewable,
    onProgress: (event) => console.log(event.message),
    ...(signal ? { signal } : {}),
  });

  // Pages stay in the request: allow as many as half of what the budget keeps free can pay for.
  let pagesLeft = Math.floor(budget.reservedTokens / 2 / GEMINI_PAGE_TOKENS);
  let answerNow = !needsTools;
  for (let turn = 1; ; turn++) {
    const data = await withRetry(() => generateContent({
      contents,
      systemInstruction,
      // The request for the answer declares no tools: the model must answer in text.
      ...(answerNow ? {} : { tools: [toGeminiTools(tools.declarations)] }),
    }, signal), { signal, onRetry: ({ delayMs }) => console.log(`Trying again in ${Math.round(delayMs / 1_000)} s`) });
    const used = usageOfGemini(data.usageMetadata);
    usage.add(MODEL, used);

    const content: GeminiContent = data.candidates?.[0]?.content ?? { role: "model", parts: [] };
    const text = content.parts.filter((part) => typeof part.text === "string" && part.thought !== true).map((part) => String(part.text)).join("");
    const calls: ToolCall[] = content.parts.flatMap((part) => {
      const call = part.functionCall as { name?: string; args?: Record<string, unknown>; id?: string } | undefined;
      return call?.name ? [{ name: call.name, args: call.args ?? {}, ...(call.id ? { id: call.id } : {}) }] : [];
    });
    if (answerNow || calls.length === 0) return { text, usage: usage.totals, evidence };

    // The model's turn goes back unchanged: Gemini 3 wants its thought signatures.
    contents.push(content);
    // The room this turn's results share: about two characters a token, up to half of what the budget keeps free.
    const tokensLeft = budget.contextTokens - budget.reservedTokens / 2 - (used.inputTokens ?? 0);
    let sentBytes = Buffer.byteLength(JSON.stringify(contents));
    const answers: ToolAnswer[] = [];
    for (const [index, call] of calls.entries()) {
      if (index >= MAX_CALLS) {
        answers.push({ call, result: { error: `Not run: one turn runs at most ${MAX_CALLS} calls. Send it again if you still need it.` } });
        continue;
      }
      const label = tools.describe(call.name, call.args);
      const output = await tools.executeWithFiles(call.name, call.args, {
        maxResultCharacters: Math.floor((tokensLeft * 2) / Math.min(calls.length, MAX_CALLS)),
        maxFileBytes: Math.floor(((budget.maxRequestBytes - sentBytes - 1_000_000) * 3) / 4), // base64: four bytes for three
        maxPages: pagesLeft,
        maxRequests: MAX_REQUESTS - usage.totals.requests - 1, // for a whole-file read; one is kept for the answer
      });
      console.log(`${label}${toolResultSummary(label, output.result)}`);
      if (output.files.length > 0) {
        // `pages` is "12" or "12-14". The next look at pages has that much less room.
        const [from = 0, to = from] = String(output.result.pages ?? "").split("-").map(Number);
        pagesLeft -= to - from + 1;
        for (const file of output.files) sentBytes += Math.ceil(file.bytes.length / 3) * 4;
      }
      const shown = evidenceOf(call, output.result);
      if (shown) evidence.push(shown);
      answers.push({ call, result: output.result, files: output.files });
    }
    contents.push(...geminiFunctionResponseTurns(answers));
    // Out of turns or of requests: the next request is the last, and asks for the answer.
    answerNow = turn + 1 >= MAX_TURNS || usage.totals.requests >= MAX_REQUESTS - 1;
    // With nothing to search, the only tool was view_pages: the text of every file is in the prompt.
    const closing = prepared.plan.searchable.length > 0 ? FINAL_ANSWER_REQUEST : FINAL_ANSWER_AFTER_PAGES;
    if (answerNow) contents.push({ role: "user", parts: [{ text: closing }] });
  }
}
```

- **Every call gets an answer.** A call past `MAX_CALLS` is answered with an error, not dropped:
  the provider expects one response for each call of the turn.
- **The pages go inside the function responses.** For Gemini 2.5, which takes them there and does
  not see them, pass `{ files: "beside" }` to `geminiFunctionResponseTurns` (see
  [PDFs](./pdfs.md)).
- **The ceiling on requests is soft.** It is checked before each turn, and `maxRequests` keeps a
  whole-file read within it only where the read has a choice (see the next section). To refuse a
  costly read first, as `askWithFiles` does, run `get_document_overview` on the document: its
  `parts_for_whole_document_analysis` is the number of parts, worked out from the document's size.
  Or leave `generate` out, and pass `wholeDocumentAnalysis: false` to `prepare`.
- **To stream the answer**, post the last request to `endpoint.streamUrl` and read it with
  [`parseSseJson`](#parsessejson).
- **For a conversation**, keep `contents` with the chat, and see [Conversations](./conversations.md)
  for what to keep between questions.

### `ToolCallLimits`

The third argument of `executeWithFiles` says what one call may use of the request its result goes
into. Fill it from your own request, as the sample above does:

- `maxResultCharacters`: the room left for this call's result, in characters. The result is cut to
  it and says where to go on. `tools.resultCharacters(name)` is the most a result of that tool can
  have before any limit: what to set aside in your request before you run a call.
- `maxFileBytes`: the room left in your request for the pages of this call, times 3/4 when files go
  as base64.
- `maxPages`: the pages the question may still show. Lower it as the pages add up.
- `maxRequests`: what your ceiling on requests has left, for a whole-file read. Since 0.10.0 a read
  with more parts than this is refused before any request, and makes its merges within it; before,
  it only limited how many parts refused as too large were read again as two halves. Give it to
  `read_document` calls too, as the sample does (since 0.10.0): a read cut short of its range
  points at a whole read of its file (`whole_file`) only when the file's parts are within it. The
  model can call that read on its next turn at the earliest: `askWithFiles` keeps that turn's
  request out of what it gives a `read_document` call, and gives 0 when it would not run a whole
  read on that turn. Do the same in your loop.
- `maxWaitMs` (new in 0.9.0): the most a look at pages waits for its turn, when that is less than
  the library's `pageLookWaitMs`. `askWithFiles` gives 0 to the looks of a turn after one was told
  the server is busy (`onPagesBusy`, below), so that a wait that ends busy comes once in a turn. Do
  the same in your loop.

The defaults, the floors and the errors a call answers with are in the
[tools reference](../reference/tools.md#toolcalllimits).

### Progress of each call: `ToolCallHooks`

New in 0.7.0. `ToolOptions.onProgress` hears every whole-file read of the tool set, and its events
do not say which call they belong to. When your loop runs calls at once and shows each one, pass
listeners for one call as the fourth argument of `executeWithFiles`
([`ToolCallHooks`](../reference/library.md#toolcallhooks)):

- `onProgress`: the progress of this call's read, in place of the tool set's listener: "Reading
  app.log: part 3 of 12", with `done` and `total`.
- `onRequest(start)`: each model request of the read as it starts, with its `purpose` (`"part"`,
  `"merge"`, `"final"`) and a `detail` such as `"part 3 of 12"`. Return a handle: the read calls
  its `retry(notice)` before each retry of that request, and its `end({ outcome, usage, error })`
  once when it ends. `usage` is what the part reader passed to `onUsage` for that request, so you
  can show or count the cost of each read.

Only `analyze_whole_document` calls them; the other tools ignore them. Two more, new in 0.9.0,
are called by any tool:

- `onDocumentGone(documentId)`: the document was deleted or expired after you planned the request.
  The call's result tells the model so. Tell the user, or take it off the chat.
- `onPagesBusy(documentId)`: a look at pages waited longer than `pageLookWaitMs` for its turn
  (`maxConcurrentPageLooks` of the library) and was not run. The result tells the model the server
  is busy.

```ts
import type { ToolCall, ToolCallHooks, ToolCallLimits, ToolOutput, ToolSet } from "llm-large-files";

// show() is your own: it updates the line of one call on the page.
declare function show(callId: string, text: string): void;

/** Runs the calls of one turn at once, each with its own progress line. */
async function runTurn(tools: ToolSet, calls: Array<ToolCall & { id: string }>, limits: ToolCallLimits): Promise<ToolOutput[]> {
  return Promise.all(calls.map((call) => {
    const hooks: ToolCallHooks = {
      onProgress: (event) => show(call.id, `${event.message}…`),
      onRequest: (start) => ({
        retry: ({ attempt }) => show(call.id, `${start.detail}: trying again (${attempt})…`),
        end: ({ outcome }) => {
          if (outcome === "error") show(call.id, `${start.detail} could not be read`);
        },
      }),
    };
    return tools.executeWithFiles(call.name, call.args, limits, hooks);
  }));
}
```

Do not let the listeners throw: the read takes a throw from `onRequest` or a handle for a failed
request, and a throw from `onProgress` ends the read with `{ error }`. To stop the question on an
error of your own, abort the tool set's `signal`. `askWithFiles` uses these hooks for its
`tool.progress`, `request.start`, `retry` and `request.end` events ([events](../reference/events.md)).

## Streams and retries in your own code

The loop's own stream reader and retry rule are exported, for an adapter or a loop of yours.

### `parseSseJson`

`parseSseJson<T>(body, hooks?)` turns a `text/event-stream` body into one JSON value for each
`data:` event. The body is a web stream (`response.body` of the global `fetch`), or an async
iterable of bytes or strings (a Node stream, from node-fetch and the like). `event:` lines are
passed over, so what tells events apart must be in the JSON. For an adapter, the hooks are what
matter:

- `onData` is called for each piece of bytes that arrives, keep-alive comments included: restart
  your wait for a silent stream there.
- `onDone` is called for `data: [DONE]`. A stream that ends with neither it nor the provider's own
  last event was cut off on its way: throw status 0, so that the request is sent again while none
  of its text was shown.
- `signal`: when it aborts, the reader stops waiting and throws the signal's reason. Join the
  caller's signal and your own wait in it, as below.
- `maxEventLength`: the most characters one event may hold, 64,000,000 by default (`Infinity`
  for no limit). A longer event ends the stream with an error named `SseEventTooLongError`, "An
  event of the stream held more than 64,000,000 characters.", rather than fill the server's
  memory. The class is exported, with the limit in its `limit`. The package's adapters throw it as
  kind `"invalid"` with the reply's status, which is not sent again, as the example above does: the
  same event would come again.

A line may end with a line feed, a CRLF or a CR alone. Leaving the loop early cancels a web
stream's reader, or calls an async iterable's `return()`, without waiting for either to settle.

What it parses and what it throws are in the
[reference](../reference/errors-and-retries.md#parsessejsonstream-hooks).

This reader passes the text of a streamed Chat Completions reply on as it arrives, and stops when
nothing arrives for `idleMs`:

```ts
// read-stream.ts: the text of a streamed Chat Completions reply.
import { ModelRequestError, parseSseJson } from "llm-large-files";

type Chunk = { choices?: Array<{ delta?: { content?: string } }> };

/**
 * Passes the text on as it arrives, and stops the stream when nothing arrives for `idleMs`
 * (keep-alive comments count as something).
 */
export async function readStream(response: Response, onText: (delta: string) => void, caller?: AbortSignal, idleMs = 120_000): Promise<string> {
  if (!response.body) throw new ModelRequestError("The reply had no body.", 0);
  const silence = new AbortController();
  let timer = setTimeout(() => silence.abort(), idleMs);
  let text = "";
  let done = false;
  try {
    for await (const chunk of parseSseJson<Chunk>(response.body, {
      onData: () => {
        clearTimeout(timer);
        timer = setTimeout(() => silence.abort(), idleMs);
      },
      onDone: () => {
        done = true;
      },
      signal: caller ? AbortSignal.any([caller, silence.signal]) : silence.signal,
    })) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        text += delta;
        onText(delta);
      }
    }
  } catch (error) {
    // Our own wait ran out, not the caller's signal: a timeout, which is sent again once.
    if (silence.signal.aborted && !caller?.aborted) throw new ModelRequestError(`Nothing arrived for ${idleMs / 1_000} s.`, 0, { kind: "timeout" });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  // No `data: [DONE]`: the stream was cut off on its way.
  if (!done) throw new ModelRequestError("The reply ended before it was complete.", 0);
  return text;
}
```

### `withRetry`

`withRetry(run, options?)` runs `run`, and runs it again by the rule the loop uses for every model
request, described in [Errors to throw](#errors-to-throw). It reads `status`, `kind` and
`retryAfterMs` of what `run` throws, so any error with those fields works, and calls `run` again as
it is: build the request inside it. Two options matter most in code of your own:

- `canRetry`: return false once a try did something that must not happen twice, such as showing
  text. The loop does that for `onText`; in your own code, pass it as below.
- `unknownErrors: "once"` tries an error without a status once more, at once. Part reads use it;
  chat requests do not.

`retry` sets the count and the waits, `signal` stops them, and `onRetry` is called before each
wait. Every option is in the [reference](../reference/errors-and-retries.md#withretryrun-options).

With the reader above, a streamed request is sent again until the user has seen any of its text:

```ts
import { ModelRequestError, retryAfterMs, withRetry } from "llm-large-files";
import { readStream } from "./read-stream.js";

/** One streamed request, sent again by the library's rules until any of its text was shown. */
export async function streamAnswer(prompt: string, write: (delta: string) => void, signal?: AbortSignal): Promise<string> {
  let shown = false;
  return withRetry(async () => {
    let response: Response;
    try {
      response = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
        body: JSON.stringify({ model: process.env.LLM_MODEL, stream: true, messages: [{ role: "user", content: prompt }] }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModelRequestError("The server could not be reached.", 0, { cause: error });
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
      const wait = retryAfterMs(response.headers, body);
      throw new ModelRequestError(body?.error?.message ?? `HTTP ${response.status}`, response.status, {
        code: body?.error?.code,
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
      });
    }
    return readStream(response, (delta) => {
      shown = true;
      write(delta);
    }, signal);
  }, {
    retry: { retries: 2, maxDelayMs: 20_000 },
    signal,
    // Text the user has seen is not written a second time: the error is thrown instead.
    canRetry: () => !shown,
    onRetry: ({ attempt, delayMs, error }) => console.warn(`Sending again (${attempt}) in ${Math.round(delayMs)} ms:`, error),
  });
}
```

## See also

- [How it works](../how-it-works.md): the loop of `askWithFiles` from end to end.
- [Errors and reliability](./errors-and-reliability.md): every error and kind, and what to show.
- [Costs and limits](./costs-and-limits.md): `AskLimits`, the budget for each model, usage.
- [An explorer model](./explorer-model.md), [Conversations](./conversations.md),
  [PDFs](./pdfs.md), [Testing](./testing.md).
- Reference: [`ModelAdapter`](../reference/ask.md#modeladapter),
  [`ModelCapabilities`](../reference/ask.md#modelcapabilities),
  [`ModelReply`](../reference/ask.md#modelreply), [`GenerateText`](../reference/ask.md#generatetext),
  [`ToolSet`](../reference/tools.md#toolset), [`ToolCallLimits`](../reference/tools.md#toolcalllimits),
  [`ToolCallHooks`](../reference/library.md#toolcallhooks),
  [`PreparedContext`](../reference/library.md#preparedcontext),
  [`ModelRequestError`](../reference/errors-and-retries.md#modelrequesterror),
  [retries and streams](../reference/errors-and-retries.md), and the
  [Gemini helpers](../reference/gemini.md).
