# Changelog

What changed in each version of `llm-large-files`, for the developers who use it. Each version
says what you need to change when you upgrade, what you can add, what works differently, and what
was fixed. Versions follow [semantic versioning](https://semver.org). While the version is 0.x, a
minor version (0.5 to 0.6) may need changes in your code or settings: the **Upgrading** part of
each version says which, and it is there even when the answer is "nothing".

<!--
Template of an entry, for maintainers. Put the newest version first.

## X.Y.Z — not released yet
(At release, the date replaces "not released yet": ## X.Y.Z — YYYY-MM-DD.)

Two to four sentences: what this version is about.

### Upgrading: what you need to change

Always present. First, whether code written for the previous version compiles as it is (check
the diff of the public .d.ts files). Then each behavior difference an app may need to act on:
what changed, who it affects, and what to do. Write "Nothing." when there is none.

### New: what you can add

Each addition in one or two lines, with a link to the page that explains it. A short sample for
the ones most apps will use.

### Changed: what works differently

One or two lines each.

### Fixed

Grouped by area. One or two lines each, written for an app developer, with the numbers that
matter.
-->

## 0.6.0 — not released yet

Questions fail less often, and when one fails, you can tell why and keep what it found. Every
model error now has a kind, a request too large for the model is made smaller and sent again, a
model that goes silent is stopped after a wait, an empty or broken turn is asked for again, and a
call whose result is still in the conversation is not run twice. The rest are fixes from a review
of 0.5.0, in the tool loop, whole-file reads and the three adapters.

### Upgrading: what you need to change

Code written for 0.5.0 compiles with 0.6.0 as it is, but for one case. The turns of
`geminiFunctionResponses` and `geminiFunctionResponseTurns` now have `GeminiPart[]` parts, where
they had `unknown[]` (see **Changed**). Code that adds to those `parts` a string, or a value typed
`unknown`, `object` or by an interface (another SDK's `Part`), no longer compiles. Add an object
literal, or `{ ...part }`. Every other change to the public types is an addition: new exports, new
fields, new optional options, and wider parameter types. One member is marked deprecated:
`ModelAdapter.estimateTokens` (see **Your own adapter** below).

Some behavior is different. Check each point against your app:

- **A model that sends nothing now fails, after a wait.** In 0.5.0 a chat request had no time
  limit: a provider that stopped answering held the question, and the user, until your own
  timeout. Now each adapter aborts a chat request that gets nothing for 600 s before the first
  piece of its reply, or for 300 s between two pieces, and sends it once more; `onActivity` then
  says "The model sent nothing for too long. Trying again…". If that try is silent too, the
  question throws a `ModelRequestError` with `kind: "timeout"` and `status: 0` ("Gemini sent
  nothing for 600 s."). A reply whose text was already streamed to the user is not sent again: it
  fails at once. Headers do not count as a piece, because a model that thinks sends nothing until
  it has thought; keep-alives count. A reply that keeps arriving has no limit. A reply that is not
  streamed comes whole at the end, so it must be written within `firstByteTimeoutMs`: Gemini and
  OpenAI-compatible requests without `onText` (an explorer's requests among them), Gemini
  requests to an endpoint without `streamUrl`, and every request of `openAiCompatible()` or
  `anthropic()` with `stream: false`. Part reads of a whole-file read are not watched this way:
  they keep their limit of 180 s.
  **What to do:** handle the `"timeout"` kind (see the sample under **New**). With the defaults,
  a model that never answers fails after about 20 minutes (two waits of 600 s). To give up
  sooner, or never, set `firstByteTimeoutMs` and `idleTimeoutMs` on `askGemini`, `gemini()`,
  `openAiCompatible()` or `anthropic()`; `0` waits without end, as 0.5.0 did. A proxy, load
  balancer or gateway that closes a silent connection sooner still closes it first: keep the
  timeouts on the way longer than these waits, or set the waits shorter. See
  [Errors and reliability](docs/guides/errors-and-reliability.md) and
  [Deployment](docs/guides/deployment.md).
- **A reply cut off on its way can fail a question after its text was shown.** A stream that
  closes without saying why it ended, or DeepSeek's `insufficient_system_resource`, is no longer
  taken for a whole reply (see **Fixed**). It is sent again when none of it was shown. When some
  of it was already streamed to the user, the question throws at once: a `ModelRequestError` with
  status 0 and kind `"unreachable"` ("Gemini's reply ended before it was complete."), or status
  503 and kind `"server"` for DeepSeek. In 0.5.0 the cut text was returned as the answer.
  **What to do:** if you stream with `onText`, handle an error that comes after part of the
  answer was shown: mark that text as incomplete and offer to ask again. `partialResultOf(error)`
  has what the question found.
- **Quota errors are no longer sent again.** OpenAI's `insufficient_quota`, and a Gemini quota per
  day (HTTP 429 whose `details` name a per-day quota), now have `kind: "quota"` and are thrown at
  once, where 0.5.0 tried three more times (the default of `retry.retries`). A Gemini quota per
  minute is `"rate_limit"`, and is waited for as before.
  **What to do:** if you show "busy, try again" for every HTTP 429, show another message for
  `"quota"`, and tell whoever runs the service: trying again soon does not help.
- **`anthropicToolTurns` and `openAiToolTurns` give a call without an ID a random one**
  (`toolu_` or `call_` and 24 hex characters). Gemini's calls, for one, may come without an ID.
  0.5.0 numbered them from 1 on each call (`toolu_1_1`), so the stored rounds of two questions had
  the same IDs, which Claude's Messages API refuses. A call that came with an ID keeps it. In
  `anthropicToolTurns`, an ID the API would refuse is changed (see **Fixed**, Claude).
  **What to do:** nothing, unless you compare these IDs, or convert the same tool turns again for
  each request: each conversion now gives new IDs. Convert once and store the messages when you
  need the same IDs every time. See [Conversations](docs/guides/conversations.md).
- **The tool guide changed, so the provider's prompt cache misses once.** The system instruction
  of a question with tools now sends counting and listing to exact search (see **Changed**). With
  `wholeDocumentAnalysis: false`, or a model that explores without `generateText`, the cards
  change too, and the guide no longer names `analyze_whole_document`. The first request of each
  conversation after the upgrade misses the cache, so its input costs what it costs without one.
  **What to do:** nothing.
- **A second try costs a request and a tool turn.** When the model's first reply is empty, or it
  wrote a tool call that could not be read, the loop asks once more, at most twice a question
  (see **Changed**). Each second try is a chat request: it counts toward `limits.requests` and
  takes a turn of `limits.toolTurns`. It is only made while the answer's request is still left,
  so the question still ends with an answer, but with one tool turn fewer.
  **What to do:** if you set `limits.requests` or `limits.toolTurns` close to what a question
  needs, add two. See [Costs and limits](docs/guides/costs-and-limits.md).
- **A repeated call is answered with a pointer.** A call whose result is still in the
  conversation in full is not run again (see **Changed**). Its step reads
  "Search app.log (exact) for “timeout” — already shown above", its result in `toolTurns` has
  `already_shown: true` and a note, and it adds no entry to `evidence`. New steps also say when a
  turn was asked for again, or a request was made smaller, such as "The model's first reply was
  empty: it was asked again".
  **What to do:** if you parse `steps` or the lines of `onStep`, or expect one `evidence` entry
  per call, allow for these.
- **Your own adapter (optional).** An adapter written for 0.5.0 works as before. To get the new
  recovery, set `ModelReply.finish` (`"malformed_call"` lets the loop ask again for a call that
  could not be read), and throw a `ModelRequestError` from `send` and `generateText`. Its `kind`
  is told from the status and the message, or you pass it: `"context_overflow"` makes the request
  smaller (and a part read in halves), `"timeout"` with status 0 is sent again once, and
  `"quota"` is not sent again. In your own loop, `withRetry` follows the same rules: an error of
  kind `"quota"` is thrown at once, and one of kind `"timeout"` with status 0 is sent again once
  (not at all when `retry.retries` is 0). `ModelAdapter.estimateTokens` is now deprecated: the
  library never called it, and a later version may remove it. An adapter that declares it still
  compiles; leave it out, and set `capabilities.tokenScale` for a tokenizer that counts
  differently from the library's estimate. See
  [Your own adapter or loop](docs/guides/own-adapter-and-loop.md).
- **`parseSseJson` takes hooks and Node streams.** `parseSseJson(stream, hooks?)` also reads the
  body of node-fetch, and takes `{ onData, onDone, signal }`. Calls written for 0.5.0 work as
  before.
- **An upload whose store fails while it writes is answered 500, not 422.** When `put`,
  `putOriginal` or `putIndex` throws an error that has no `status` or `statusCode` from 400 to 599
  and is not a Node system error, `createDocumentHandlers` answers 500
  `{ "error": "Upload failed." }`. It answered 422 with the error's own message, which may name a
  database host (see **Fixed**). A thrown value that is not an `Error` also gets 500 "Upload
  failed.", where it was 422 with the value as text. Errors with a status, Node system errors (an
  `Error` or not) and files that cannot be read are answered as before.
  **What to do:** for a more specific answer, throw your store's write errors with a `status` and
  a message of your own (a 503 that says to try again), and log the cause in your store: the
  handlers log nothing. Two paths still answer a store's error 422 with its message: an `ingest` of
  your own that throws a new error in its place, as `ingestInWorker` in
  [Deployment](docs/guides/deployment.md#uploads-and-ingest) does, and a route of your own, as in
  [Web app](docs/guides/web-app.md#filesingest-and-its-errors). A status on the error avoids it.
  See the [node reference](docs/reference/node.md#uploadrequest-response).
- **A retry option that is not a finite number takes its default.** `retries`, `baseDelayMs` and
  `maxDelayMs` (of the `retry` option and of `withRetry`) count as not set when they are `NaN`,
  `Infinity`, `-Infinity` or not a number at all, such as a string from an environment variable.
  They are then 3, 500 and 60,000. In 0.5.0, `retries: Infinity` sent a failing request again
  without end, `-Infinity` counted as 0, and a string counted as the number in it. For `NaN`, see
  **Fixed**.
  **What to do:** nothing, unless you set one of them to `Infinity`, `-Infinity` or a string. Pass
  a finite number: `retries: 0` to turn retries off, a larger `maxDelayMs` to take a long
  `Retry-After`, and `Number(process.env.RETRIES)` rather than the string. See
  [`RetryOptions`](docs/reference/errors-and-retries.md#retryoptions).

### New: what you can add

The samples assume what your app already has: `files` from `createLargeFiles()`, `endpoint` from
`vertexAi()`, and the `documentIds` and `question` of the chat.

- **The kind of every model error.** `ModelRequestError` has `kind`, and so have the errors that
  extend it (`GeminiRequestError`, `OpenAiRequestError`, `AnthropicRequestError`):
  `"context_overflow"`, `"quota"`, `"rate_limit"`, `"timeout"`, `"unreachable"`, `"server"`,
  `"auth"` or `"invalid"`. It is told from the status, the message and the provider's own code
  (Gemini's `error.status` and `details`, OpenAI's `code`, Claude's `type`). For a request too
  large for the model, `limitTokens` and `requestedTokens` are the provider's numbers when its
  message gives them (the one Vertex AI sent in a live check gave only the limit).
  `errorKindOf(error)` reads the kind of any error,
  `classifyModelError(status, message, signals?)` tells it for errors of your own, and the types
  are `ModelErrorKind` and `ModelErrorClass`. The constructor of each error class takes `kind`,
  `code` and `details`. See
  [Errors and reliability](docs/guides/errors-and-reliability.md) and
  [Errors, retries and streams](docs/reference/errors-and-retries.md).

  ```ts
  import { errorKindOf, ModelRequestError } from "llm-large-files";
  import { askGemini } from "llm-large-files/gemini";

  try {
    const result = await askGemini({ files, endpoint, documentIds, messages: [{ role: "user", text: question }] });
    console.log(result.text);
  } catch (error) {
    const kind = errorKindOf(error);
    if (kind === "quota") console.log("The model's quota is used up. Try again later.");
    else if (kind === "timeout" || kind === "rate_limit") console.log("The model did not answer. Try again in a minute.");
    else if (error instanceof ModelRequestError && kind === "context_overflow") console.warn(error.requestedTokens, error.limitTokens);
    else throw error; // another kind, or not a model error (a missing document, a bug)
  }
  ```

  What to show for each kind: [Errors and reliability](docs/guides/errors-and-reliability.md).

  ```ts
  import { classifyModelError } from "llm-large-files";

  classifyModelError(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.");
  // { kind: "context_overflow", limitTokens: 128000, requestedTokens: 130512 }
  ```

- **What a failed question found: `partialResultOf(error)`.** The question still throws the
  provider's error. `partialResultOf(error)` gives what it had done until then, as an `AskResult`
  with `answered: false`: its steps, evidence, tool rounds and usage. It is undefined for an error
  thrown before the question started (a document that is missing). Exported from
  `llm-large-files` and `llm-large-files/gemini`. See
  [The tool loop and the adapter contract](docs/reference/ask.md).

  ```ts
  import { partialResultOf } from "llm-large-files";
  import { askGemini } from "llm-large-files/gemini";

  try {
    const result = await askGemini({ files, endpoint, documentIds, messages: [{ role: "user", text: question }] });
    console.log(result.text);
  } catch (error) {
    const partial = partialResultOf(error);
    if (partial) {
      // Not an answer, but paid for: count its usage, and keep its tool rounds if you store them.
      console.log(partial.usage.requests, partial.usage.inputTokens, partial.usage.outputTokens);
      console.log(partial.steps.join("\n"), partial.toolTurns.length);
    }
    throw error;
  }
  ```

- **Waits on a silent model: `firstByteTimeoutMs` and `idleTimeoutMs`**, on `askGemini`,
  `gemini()`, `openAiCompatible()` and `anthropic()`. The defaults are the new exports
  `DEFAULT_FIRST_BYTE_TIMEOUT_MS` (600,000) and `DEFAULT_IDLE_TIMEOUT_MS` (300,000); the type
  `IdleWaits` holds the two options. See
  [Errors and reliability](docs/guides/errors-and-reliability.md).

  ```ts
  import { askGemini } from "llm-large-files/gemini";
  import { openAiCompatible } from "llm-large-files/openai";

  // A chat that streams to a user: give up sooner than the defaults.
  const result = await askGemini({
    files,
    endpoint,
    documentIds,
    messages: [{ role: "user", text: question }],
    firstByteTimeoutMs: 180_000, // the first piece of a reply within 3 minutes
    idleTimeoutMs: 60_000, // then no pause longer than 1 minute
    onText: (delta) => process.stdout.write(delta),
  });

  // A local model that reads a long prompt slowly: wait for its first piece without end.
  const local = openAiCompatible({ baseUrl: "http://localhost:8000/v1", model: "local-model", firstByteTimeoutMs: 0 });
  ```

- **`ModelReply.finish`**: how a reply ended, in terms every adapter maps its own to:
  `"complete"`, `"cut"` (at the output limit, or Claude's full window), `"filtered"` (by the
  provider's safety filters) or `"malformed_call"` (a tool call that could not be read: Gemini's
  `MALFORMED_FUNCTION_CALL` and `UNEXPECTED_TOOL_CALL`). The three adapters set it. See [The tool loop and the adapter contract](docs/reference/ask.md).
- **`ToolCallLimits.maxRequests`**: the model requests a whole-file read may make. It does not
  stop the read: a part the model refuses as too large is read as two halves only while it allows.
  `askWithFiles` passes the read's own requests and a share of what the question has left of
  `limits.requests`; in your own loop, pass it to `executeWithFiles`. See
  [Tools](docs/reference/tools.md#toolcalllimits).
- **`PrepareOptions.wholeDocumentAnalysis`**: whether your tool set has `analyze_whole_document`.
  Defaults to `true`. In your own loop, pass `wholeDocumentAnalysis: false` to `files.prepare()`
  when you call `files.tools()` without `generate`: the tool guide then does not name the tool,
  and the cards do not offer a whole-file read. See
  [The library and its documents](docs/reference/library.md#prepareoptions).
- **`SseHooks`**: the second argument of `parseSseJson`: `onData` (bytes arrived, keep-alives
  included), `onDone` (`data: [DONE]` arrived) and `signal`. See
  [Errors, retries and streams](docs/reference/errors-and-retries.md).
- **`RetryNotice`**: the type of what `withRetry` passes to `onRetry`: `error`, `attempt` (the
  number of the retry to come) and `delayMs` (the wait). 0.5.0 passed the same notice but did not
  export its type. See
  [Errors, retries and streams](docs/reference/errors-and-retries.md#retrynotice).
- **`OpenAiRequestError.param` and `.code`**: the server's `error.param` (`"max_tokens"`) and
  `error.code` (`"unsupported_parameter"`). See [`llm-large-files/openai`](docs/reference/openai.md).

### Changed: what works differently

Besides the points under **Upgrading**:

- **A request too large for the model is made smaller and sent again**, where it failed the
  question. The loop takes the provider's count and window for the rest of the question,
  replaces older tool results with short stand-ins (the latest round too, if it must), and sends
  the request again, at most twice a question. When the first requests are too large before any
  tool ran, the documents are planned again, once, for a smaller window: the one the provider
  named, made smaller by as much as its count of the request passed the library's estimate (by a
  fifth when it gives no count). When it names none, it is 7/10 of the window assumed, made
  smaller the same way when the provider gave a count; and when the result is not smaller than the
  window assumed, it is 7/10 of the window assumed. Vertex AI's message names 1,048,576 tokens
  and no count: with the default window of 1,000,000, the documents are planned for 838,860. What the
  first try paid for, and the tool turns it took, are counted. When Claude is one of the models,
  nothing is shortened (its conversation may only grow), so only the second plan applies. See
  [How it works](docs/how-it-works.md).
- **An empty first reply, or a tool call that could not be read** (Gemini's
  `MALFORMED_FUNCTION_CALL` or `UNEXPECTED_TOOL_CALL`), **is asked for once more** with a short note, at most twice a
  question. Before, the answer was written from the document cards alone, and looked like any
  other. The note is not kept in the conversation, except when the model that explores is Claude,
  and an answering model other than the explorer never gets it.
- **A call whose result is still in the conversation in full is not run again**: the same search,
  the same read, the same overview, a read of lines inside one that is shown, in this question or
  in the stored tool rounds of an earlier one. The model gets a pointer to that result. A result
  of an earlier turn that failed, was cut to its room, was replaced by a stand-in, or came from a
  search that stopped early is not pointed to. The same search, read or overview made twice in
  one turn is not run twice: the second is pointed to the first. Live on Vertex AI, a follow-up
  that repeated its first search got the pointer and answered from the result.
- **Two searches in a row that failed in the same mode** get a hint added to the error: after two
  regex searches, to try exact or keywords mode; after two of another mode, to check the arguments
  or answer from what the model has.
- **An unknown `document_id`** is answered with the IDs the model may use, and their file names
  (up to 20).
- **The tool guide sends counting and listing to exact search.** It sent "every occurrence" to
  `analyze_whole_document`, which missed items in our live tests (492 of 1,200; 91 of 120), while
  `search_document` in exact or regex mode gives an exact `total_matching_lines`. The whole-file
  read is now for what needs meaning: a summary, a timeline, items judged one by one. See
  [Tools](docs/reference/tools.md).
- **In `askWithFiles` and `askGemini`, the tool guide names `analyze_whole_document`, and the
  cards offer a whole-file read, only when the question has the tool.** With
  `wholeDocumentAnalysis: false`, or a model that explores without `generateText`, they still
  offered a whole-file read when a file was small enough for one, and a model that called it was
  answered "Unknown tool analyze_whole_document.". Each card now says "Use the document tools to
  search it and to read line ranges.", and the guide leaves the tool's line out. In your own loop,
  pass `wholeDocumentAnalysis: false` to `files.prepare()` for the same (see **New**). See
  [Tools](docs/reference/tools.md#which-tools-are-offered).
- **A part of a whole-file read that the model refuses as too large is read as two halves**,
  while `maxMapChunks` and the requests the question has left allow it.
- **A part that the provider stopped before its end is said to be incomplete**, as one cut off at
  the output limit is: Gemini's `SAFETY` and its other filter reasons, OpenAI's `content_filter`,
  Claude's `refusal`, and Claude's `model_context_window_exceeded` (its window was full).
- **Tool results have new fields**: `already_shown` (a pointer), `text_cut` (a `read_document`
  whose text was cut to its room), and, on a whole-file read, `notes_only` and
  `answer_shortened` (see **Fixed**). The step of a whole-file read that returned its notes ends
  in ", notes only". See [Tools](docs/reference/tools.md).
- **`geminiFunctionResponses` returns a `GeminiContent & { role: "user" }`, and
  `geminiFunctionResponseTurns` an array of them**, which go into a `GeminiContent[]` without a
  cast. Their parts were typed `unknown[]` (see **Upgrading**). See
  [`llm-large-files/gemini`](docs/reference/gemini.md#geminifunctionresponsescalls).

### Fixed

The tool loop:

- **The calls of a turn share the room that is left.** Each call took its whole cap
  (`toolResultCharacters`, or at least 40,000 characters for a whole-file read) in call order, so
  the first calls could take all the room and the next were told "no room left, answer now". On
  Claude with a window of 64,000 tokens, four searches of about 300 characters each, after four
  rounds of reads, ran three and forced the answer. The room is now shared evenly, and only calls
  that cannot each get 1,500 characters are refused. The answer of a whole-file read gets all the
  room the other results of its turn leave.
- **Whole-file reads in one turn are counted together** against `limits.requests` and
  `limits.inputTokens`. Each was checked alone, so two reads that each fit passed the ceiling
  together: 16 requests against a ceiling of 11 in a probe. The input tokens of a read are now
  counted by the `tokenScale` of the model that reads its parts, not by the largest scale of the
  question, which refused reads that fit.
- **The provider's count of a request is read by the `tokenScale` of the model that gave it**,
  not by the largest scale of the question. With a Gemini explorer and Claude answering, the
  request for the answer came to 66,000 tokens of Claude's window of 60,000.
- **Part reads of a `generateText` that does not call `onUsage` count toward `limits.requests`**
  and `usage.requests`. They were left out.
- **The request for an answer after no tool ran is `FINAL_ANSWER_WITHOUT_TOOLS`**, also when the
  first reply was empty or `limits.toolTurns` left no turn for tools. It said "using only what
  the tools returned above".
- **Text that is cut is no longer cut inside an emoji** (a character outside the basic plane),
  which JSON writes as `\ud83d` and Claude's API refuses: results, search lines, stand-ins, the
  first lines of a card, and log templates of documents ingested from now on.

Whole-file reads:

- **A read whose last step failed returns the notes of its parts**, with `notes_only: true`,
  instead of an error that lost every part already paid for.
- **A model that asks again for a read that could read no part is told that it failed, and why.**
  It was told to "use the answer of that read", which there was not. A read that failed before any model request
  (a store that could not be read) is not counted, so the model can make it again.
- **A long answer is cut at its end**, with `answer_shortened`, and the other fields
  (`parts_read`, the notes on what is incomplete) are kept. It was cut as JSON, which dropped them.
- **A part that could not be read from storage no longer shows the model the server's file
  path.** Its note, and the error of a read that read no part, give only the error code ("The
  file could not be read from storage (EACCES)"), as the other tools do.

The adapters:

- **All three: a connection that failed while the body of a reply arrived is sent again**, like
  one that failed before the reply. In 0.5.0 a chat reply that came in one piece, not streamed,
  was not. A body that came whole but is not JSON (a gateway's HTML page) is not sent again; a
  part read tries it once more.
- **OpenAI-compatible: an error inside a stream is taken for the server's** (HTTP 500 unless it
  names another), and sent again when none of its text was shown. It was taken for HTTP 200 and
  never sent again.
- **OpenAI-compatible: a streamed reply keeps its `refusal`, and OpenRouter's `reasoning` and
  `reasoning_details`**, which hold the thought signature of a Gemini 3 model behind OpenRouter.
  A refusal was lost, so the question was not answered.
- **OpenAI-compatible: a call whose arguments are empty or not JSON goes back as `"{}"`.** vLLM
  before 0.29 refused the next request (HTTP 400).
- **OpenAI-compatible: part reads send `max_completion_tokens` to every Azure OpenAI host**
  (`*.openai.azure.com`, and the `/openai/` paths of `*.cognitiveservices.azure.com` and
  `*.services.ai.azure.com`). When `maxTokensField` is not set, a server that refuses the name it
  was sent (HTTP 400 naming it) is sent the other, and the adapter keeps it.
- **OpenAI-compatible: two user turns in a row are sent as one.** DeepSeek's reasoner and the chat
  templates of Mistral and Gemma models refuse them.
- **Claude: a stream that ended without saying why (no `stop_reason`) is not taken for a whole
  reply.** A gateway that ended it early made a cut answer count as answered; it is now sent
  again when none of it was shown. A call whose block was never closed is answered "send it
  again", not run with no arguments.
- **Claude: an empty text block is not sent back** ("text content blocks must be non-empty"),
  unless a thinking block follows it in the turn.
- **Claude: calls of other providers and of earlier questions get IDs the API takes**, each once
  in a request: Kimi's `functions.search:0` becomes `functions_search_0`, and the second of two
  stored rounds numbered alike gets a suffix.

Replies cut off on their way:

- **A stream that closes without saying why it ended is not taken for a whole reply**: Gemini's
  last chunk has a `finishReason`, and an OpenAI-compatible stream a `finish_reason` or `[DONE]`.
  A proxy or a dropped connection made a cut answer, or a cut turn of tool calls, count as whole.
  It is sent again when none of it was shown (see **Upgrading** for when some was).
- **DeepSeek's `insufficient_system_resource`** is the server's failure (HTTP 503), and is sent
  again when none of the reply was shown. It was taken for a whole reply.
- **A streamed reply through a `fetch` whose body is a Node stream** (node-fetch) failed with
  "stream.getReader is not a function". Both kinds of body are read.

Retries:

- **`retries: NaN` no longer sends a failing request again without end.** A `NaN`, such as
  `Number(process.env.RETRIES)` with the variable unset, never ran out: in `askWithFiles`,
  `askGemini`, `files.tools()` and `withRetry`, a request that kept failing with status 0, 408,
  409, 429 or 5xx was sent again until the signal aborted. A `baseDelayMs` or `maxDelayMs` of
  `NaN` cut the waits the library works out to about 1 ms, and a `maxDelayMs` of `NaN` took any
  wait the provider asked for. Each now takes its default. It was so in 0.5.0.

Ingest:

- **An outline of 20 to 399 top-level headings keeps each of them once, in order.** In a document
  of more than 400 headings, such an outline took its entries from the first headings only, some
  more than once: with 20 top-level headings, the first one 20 times; with 100, the first 25, four
  times each; with 300, the first 225. It was so in 0.5.0 and every version before. This applies
  to documents ingested from now on: ingest a document again to rebuild its outline.

Uploads:

- **The upload handler no longer sends a store's own error message to the browser.** When a
  store failed to write a document with an error that has no `status` or `statusCode` from 400 to
  599 and is not a Node system error, `createDocumentHandlers` answered 422 with the store's
  message, which may name a database host. It now answers 500 "Upload failed." (see
  **Upgrading**). It was so in 0.5.0 and every version before.

## Before 0.6.0

Versions 0.1.0 to 0.5.0 are recorded in the
[full history up to 0.5.0](https://github.com/renanbazinin/llm-large-files/blob/v0.5.0/CHANGELOG.md).
Each of them but 0.1.0 is a [tag of the repository](https://github.com/renanbazinin/llm-large-files/tags);
from 0.6.0 on, each release is also on the
[GitHub releases page](https://github.com/renanbazinin/llm-large-files/releases).
