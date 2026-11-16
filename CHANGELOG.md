# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org).

## [Unreleased]

Fixes from a review of 0.5.0, and what the loop took from other agent harnesses (DeepSeek
Harness, Codex, Gemini CLI, OpenCode, SWE-agent): waits on a model that went silent, the kind of
every error and a way back from a request too large for the model, a second try after an empty or
broken turn, and no second run of a call whose result is still shown. Nothing to change in your
code, unless you compare the IDs that `anthropicToolTurns` and `openAiToolTurns` give calls that
came without one (see **Changed**).

### Added

- **Waits on a model that went silent.** A chat request had no limit: a provider that stopped
  answering held the request, and the user, until the application's own timeout. Each adapter now
  aborts a request that gets nothing for `firstByteTimeoutMs` (600 s) before the first piece of
  its reply, or for `idleTimeoutMs` (300 s) between two pieces, and sends it again once. Headers do
  not count as a piece: Gemini without its thoughts, and OpenAI's reasoning models, send nothing
  while they think. Keep-alives count (DeepSeek's blank lines, Claude's pings). A reply that keeps
  arriving has no limit. Options of `gemini()`, `askGemini`, `openAiCompatible()` and
  `anthropic()`; 0 waits without end. The body of a reply is read a piece at a time to see them,
  from the global `fetch` or from node-fetch.
- **What went wrong, in `ModelRequestError.kind`**: `"context_overflow"`, `"quota"`,
  `"rate_limit"`, `"timeout"`, `"unreachable"`, `"server"`, `"auth"`, `"invalid"`, told from the
  status, the message and the provider's own code (Gemini's `error.status` and `details`, OpenAI's
  `code`, Claude's `type`). For a request too large for the model, `.limitTokens` and
  `.requestedTokens` are the provider's numbers when its message gives them. The wording of Gemini,
  Vertex AI (checked live: "The input token count exceeds the maximum number of tokens allowed
  1048576."), OpenAI, Claude, vLLM, Mistral and llama.cpp is known; throttling that shares words
  with it ("tokens per min") is not taken for it. `classifyModelError` and `errorKindOf` are
  exported.
- **A request too large for the model is made smaller and sent again**, instead of failing the
  question: the loop takes the provider's count and window for the rest of the question, replaces
  older results with stand-ins (the latest round too), and sends it again, at most twice a question.
  When the first requests of a question are too large before any tool ran (a window smaller than
  the budget assumed, a local server's `max_model_len`), the documents are planned again for the
  window the provider named, once, as for a model that declares it. What the first try paid for,
  and the tool turns it took, are counted. Claude's conversation is not rewritten, so for it only
  the second plan applies.
- **`partialResultOf(error)`**: what a question that failed had found and paid for, as an
  `AskResult` with `answered: false`: its steps, evidence, tool rounds and usage. The error itself
  is thrown as before.
- **`ModelReply.finish`**: how a reply ended, in terms every adapter maps its own to: `"complete"`,
  `"cut"`, `"filtered"`, `"malformed_call"`.
- `ToolCallLimits.maxRequests`: the requests a whole-file read may make. The loop passes what the
  question has left of `limits.requests`.
- `DEFAULT_FIRST_BYTE_TIMEOUT_MS`, `DEFAULT_IDLE_TIMEOUT_MS`; `parseSseJson` takes
  `{ onData, onDone, signal }`; types `ModelErrorKind`, `ModelErrorClass`, `IdleWaits`, `SseHooks`.

### Fixed

The tool loop:

- **The calls of a turn share the room that is left.** Each call was given its whole cap
  (`toolResultCharacters`, or at least 40,000 characters for a whole-file read) in call order,
  though most results are far smaller. When the room ran short, the first calls took it all and the
  next ones were answered "no room left, answer now", which ended the question: on a model whose
  conversation may only grow (Claude), four searches of about 300 characters each, after four rounds
  of reads on a window of 64,000, ran three and forced the answer. The room is now shared evenly, a
  call with a smaller cap leaving the rest to the others, and only calls that cannot each get 1,500
  characters are refused. The answer of a whole-file read, which cannot be asked for again, is not
  cut to a share: once the other results of the turn are in, it gets all the room they left. The
  room is also no longer counted for calls that are refused anyway.
- **Whole-file reads in one turn are counted together against `limits.requests` and
  `limits.inputTokens`.** Each was checked alone against what was left, so two reads that each fit
  ran together and passed the ceiling (16 requests against a ceiling of 11 in a probe). A second
  read of a document that the tool refuses anyway takes nothing from the reads of the others.
- **The provider's count of a request is read by the scale of the model that gave it.** It was read
  by the largest `tokenScale` of the question, so the count of an explorer with a smaller scale
  could not raise the estimate: with a Gemini explorer and Claude answering, on text that cost 30%
  more than estimated, the request for the answer came to 66,000 tokens of Claude's window of
  60,000. A whole-file read is also priced in the tokens of the model that reads it.
- **Part reads of a `generateText` that does not call `onUsage` count toward `limits.requests`.**
  They were left out of the totals.
- **The request for an answer after no tool ran no longer says "using only what the tools returned
  above"**: when the first reply was empty, or `limits.toolTurns` left no turn for tools, it is
  `FINAL_ANSWER_WITHOUT_TOOLS`, as it was already for an explorer that called no tool.
- **Text that is cut is no longer cut in half of a character outside the basic plane** (an emoji),
  which JSON writes as `\ud83d` and Claude's API refuses: results cut to their room, the lines a
  search shows, the stand-ins of dropped results, the first lines of a file's card, and the log
  templates of documents ingested from now on.

Whole-file reads:

- **A read whose last step failed returned an error**, and the notes of every part, paid for, were
  lost. The notes are now the answer, with `notes_only: true` and a note that says so.
- **A model that asked again after a read failed was told to "use the answer of that read"**, which
  there was not. A read that could read no part is still not tried again for the question, and the
  refusal now says that it failed and why. A read that failed before any model request (a store
  that could not be read, while counting the parts or reading them) is no longer counted, so the
  call can be made again, as its message says. Its count is given back without taking that of
  another read of the same document in the same turn.
- **The answer of a read in little room is cut at its end**, as much of it as fits, and the other
  fields of the result (`parts_read`, the notes on what is incomplete) are kept. It was cut as
  JSON, which left `{ truncated, partial }` and dropped them.

The adapters:

- **A connection that failed while the body of a reply arrived is sent again**, as one that failed
  before the reply is, in all three adapters. A chat reply that was not streamed (on an
  OpenAI-compatible endpoint or Gemini, an explorer's or any without `onText`; on Claude, with
  `stream: false` or from a gateway that answers without a stream) was tried once; a part read was
  tried twice, and is now sent again like any connection that failed. A chat reply whose body came
  whole but is not JSON is not sent again (a part read tries it once more, as it does any failure
  that gives no reason).
- OpenAI-compatible: **an error inside a stream is taken for the server's** (OpenAI's own is
  `{ type: "server_error", code: null }`), and sent again when no text of it was shown. It was taken
  for HTTP 200, and never sent again.
- OpenAI-compatible: **a streamed reply keeps its `refusal`, and OpenRouter's `reasoning` and
  `reasoning_details`**, as a reply in one piece does. A refusal was lost, so the question was not
  answered; the reasoning details, which hold the thought signature of a Gemini 3 model behind
  OpenRouter, were not sent back with the turn.
- OpenAI-compatible: **a call whose arguments are not JSON, or are empty, goes back with `"{}"`.**
  It went back as written, and vLLM before 0.29 refuses a conversation with such a call (HTTP 400).
- OpenAI-compatible: **the output limit of a part read is named `max_completion_tokens` on every
  host of Azure OpenAI**: `*.openai.azure.com`, and the `/openai/` paths of
  `*.cognitiveservices.azure.com` and `*.services.ai.azure.com`. Reasoning deployments refused the
  `max_tokens` sent there. When `maxTokensField` is not set, a server that refuses the name it was
  sent (HTTP 400 with `param` naming it, or a message that refuses it) is sent the other, which is
  kept for the adapter. An error that only mentions a name ("max_tokens or model output limit was
  reached") changes nothing, and part reads refused together learn the other name once.
  `OpenAiRequestError` now has the `param` and `code` of the error.
- OpenAI-compatible: **two user turns in a row are sent as one.** DeepSeek's reasoner and the chat
  templates of Mistral and Gemma models refuse them; the loop sends them when it asks for the answer
  after no tool ran.
- Claude: **a stream that ended without its last event is not taken for a whole reply.** A gateway
  that ended it early made a cut answer count as answered; it is now sent again like a connection
  that failed. A call whose block was never closed is answered, not run with no arguments.
- Claude: **a text block that a stream left empty is not sent back** ("text content blocks must be
  non-empty"), unless a thinking block follows it in the turn.
- Claude: **calls of other providers and of earlier questions get IDs the API takes**, each once in
  a request: Kimi's `functions.search:0` becomes `functions_search_0`, and the second of two stored
  rounds numbered alike is given a suffix.

Replies cut off on their way:

- **A stream that closes without saying why it ended is not taken for a whole reply**: Gemini's
  last chunk has a `finishReason`, and an OpenAI-compatible stream a `finish_reason` or `[DONE]`. A
  proxy or a dropped connection that ended it early made a cut answer, or a cut turn of tool calls,
  count as whole. It is sent again when none of it was shown, as Claude's already was.
- **DeepSeek's `insufficient_system_resource`** is the server's failure (HTTP 503), sent again. It
  was taken for a whole reply.
- **A streamed reply through a `fetch` whose body is a Node stream** (node-fetch) failed with
  "stream.getReader is not a function". Bodies of either kind are read.

### Changed

- **The tool guide sends counting and listing to exact search.** It sent "every occurrence" to
  `analyze_whole_document`, which our own live test showed missing items (492 of 1,200; 91 of
  120), while `search_document` in exact or regex mode gives an exact `total_matching_lines`. The
  whole-file read is now for what needs meaning: a summary, a timeline, items judged one by one.
  The system instruction of a question with tools changes, so the provider's cache misses it once.
- **A turn whose tool call could not be read** (Gemini's `MALFORMED_FUNCTION_CALL`), **or a first
  reply with nothing in it, is asked for once more** with a short note, at most twice a question.
  The answer was written from the cards alone and looked like any other. The second try takes a
  tool turn; the note is not kept in the conversation, except when the model that explores is
  Claude, and the answering model never gets it. An explorer is told to reply DONE.
- **A call whose result is still in the conversation in full is not run again**: the same search,
  the same read, a read of lines inside one that is shown, here or in the tool rounds of an earlier
  question. It is answered with a pointer to that result, and its step says "already shown above".
  A result cut to its room, replaced by a stand-in, or from a search that stopped early is not
  pointed to, and a pointer whose result is later replaced becomes a stand-in too. Live on Vertex
  AI, a follow-up that repeated its first search got the pointer and answered from the result.
- **Two searches in a row that failed in the same mode** get a hint to try another mode. An unknown
  `document_id` is answered with the IDs and names the model may use.
- **A quota that does not come back soon is not sent again** (OpenAI's `insufficient_quota`, a
  Gemini quota per day): three more tries could not help. Gemini's quota per minute is waited for
  as before.
- **A part of a whole-file read that the model refuses as too large is read as two halves**, while
  `maxMapChunks` and the requests the question has left allow it. A part the provider's filter
  stopped (Gemini `SAFETY`, `content_filter`, Claude `refusal` or `model_context_window_exceeded`)
  is said to be incomplete, as one cut off at the output limit is.
- `anthropicToolTurns` and `openAiToolTurns` give a call that came without an ID a random one
  (`toolu_…`, `call_…`). They numbered them from 1 each time, so the stored rounds of two questions
  had the same IDs, which the Messages API refuses.

## [0.5.0] - 2026-11-13

One tool loop for every model. What `askGemini` did (plan the documents, offer the tools, run the
calls, end with an answer) is now `askWithFiles` in the core, and a model provider is an adapter.
Three come with the package: Gemini and Vertex AI, any OpenAI-compatible endpoint, and Claude. The
loop also learned to send a failed request again, to count what a question costs, and to keep a
growing request inside the model's window.

`askGemini` is still there and takes the options it took. Read **Changed** before you upgrade:
six of its points can need a change in your code.

### Added

- **`askWithFiles({ files, model, explorer?, documentIds, messages, … })`** in `llm-large-files`.
  `model` and `explorer` are adapters, and need not be of the same provider: a cheap model behind
  an OpenAI-compatible endpoint can explore while Gemini or Claude writes the answer.
- **Adapters.** `gemini(endpoint, options)` in `llm-large-files/gemini`,
  `openAiCompatible({ baseUrl, apiKey, model })` in `llm-large-files/openai` (OpenAI, Azure OpenAI,
  DeepSeek, LiteLLM, vLLM, Ollama, OpenRouter, Gemini's OpenAI layer), and
  `anthropic({ apiKey, model })` in `llm-large-files/anthropic`. None needs an SDK. An adapter of
  your own is an object with `id`, `capabilities`, `send` and, for whole-file reads,
  `generateText`: see `ModelAdapter` in the API reference.
- **A request that failed is sent again.** HTTP 408, 409, 429, any 5xx, and a connection that
  failed are retried up to three times, after a wait that doubles (at most 0.5, 1 and 2 seconds,
  with jitter), or after the wait the provider asks for (`Retry-After`, `retry-after-ms`, and the
  `retryDelay` of Gemini's `RetryInfo`). A request the model refused (400, 401, 403, 404) is not retried, and nothing is
  retried once text of the reply was shown, or after the caller stopped the question. A wait the
  provider asks for that is longer than `retry.maxDelayMs` (one minute) is not waited for. The
  part reads of a whole-file read follow the same rule: a 429 was retried 0.2 ms later before.
  Set it with `retry: { retries, baseDelayMs, maxDelayMs }`.
- **`usage` is the whole question.** `{ requests, inputTokens, cachedInputTokens, outputTokens,
  thoughtTokens, byModel }`, summed over every request that was answered, the part reads of a
  whole-file read included. In a live run of 0.4.0, 13,687 prompt tokens were billed and 6,398
  reported.
- **Ceilings for one question**, in `limits`: `wholeDocumentReads` (1 for each document: the
  model asked for the same file to be read whole six times in one probe), `inputTokens` and
  `requests` (no more tools once they are reached, and a whole-file read that would pass them is
  refused with the numbers), next to `toolTurns` and `callsPerTurn`.
- **The request is kept inside the window.** The loop counts the request as it grows. Before it
  runs the calls of a turn it gives each one the room that is left: a result is cut to it and says
  where to go on, and a call that finds no room is answered "no room left, answer now", after
  which the next request is the answer. When the room runs short, the results of all but the last
  three tool rounds are replaced by short stand-ins that keep the document and the lines or pages
  they showed. A turn of sixty reads built a request of 491,000 tokens against a window of 128,000
  before; the same run now peaks at about 100,000.
- **The tool calls of one turn run together**, four at a time, and are answered in the order they
  were made. Looks at pages still run one after another, because each is given the room the one
  before it left, and so do regex searches, which share their time. Six whole-file reads, two in
  each of three turns, took 841 ms one after another against a fake model, and take about 540 ms.
- **Headers are asked for with every request**, the part reads included, so a token that
  `vertexAi({ accessToken })` renews is used. They were asked for once a question.
- **The budget follows the model.** `reservedTokens`, `inlineTokens`, `mapChunkTokens` and
  `toolResultCharacters` are worked out from `contextTokens` when they are left out
  (`resolveBudget`): setting only `contextTokens: 64_000` made a nine-token note a card with tools
  before. An adapter can say what its model takes (`contextTokens`, `maxRequestBytes`,
  `outputTokens`, `pageTokens`, and `tokenScale` for a tokenizer that counts more than the
  library's estimate), and the budget of a question is made to fit it. `budget` in `askWithFiles`,
  `prepare` and `tools` changes fields for one question, and `files.budgetFor()` shows the result.
- **`evidence`** in the result: for each tool call, the document and the lines or pages the model
  was shown.
- **`toolTurns`** in the result: the tool rounds of the question as plain JSON. Kept with the
  conversation and passed back in `messages` between the question and its answer, they let a
  follow-up question be answered from what was already read. In a live check the follow-up took
  one request and no search. `geminiToolTurns`, `openAiToolTurns` and `anthropicToolTurns` give
  them in a provider's own form, and `fromGeminiContents`, `fromOpenAiMessages` and
  `fromAnthropicMessages` turn a history kept in that form into `messages`.
- **A tool call that did not arrive whole is not run.** Arguments that are not JSON, or a call cut
  off at the output limit, are answered with what was wrong, and the model can send the call again.
- **The output limit of a part read is raised for any model that thinks**, not only Gemini: the
  rule of 0.4.1 is shared by the three adapters.
- For Claude: the model's turn goes back exactly as it came, thinking blocks included; the tools
  stay listed in the request that must be answered in text (`tool_choice: none`); the conversation
  is never rewritten, so old results are not shortened for it; pages go into the tool result as a
  document block; prompt caching is on; a refusal is reported as `blockReason`; and `fallbacks`
  turns on the API's own fallback to another model.

### Changed

What can need a change in your code:

- **`result.usage` is no longer Gemini's `usageMetadata` of the last response.** That object is
  now `result.lastUsage`. If you forward `usage` to a browser or a log, read `lastUsage` for the
  old shape, or use the totals.
- **A failure can take longer to reach you**, because the request is tried again first: up to
  three and a half seconds of waiting by default for a model that stays down, and up to a minute
  when the provider names a wait. `retry: { retries: 0 }` gives the old behaviour.
- **A connection that failed throws `GeminiRequestError` with `status` 0**, not the `TypeError` of
  `fetch`. The original error is its `cause`.
- **A second whole-file read of the same document in one question is refused.** Set
  `limits.wholeDocumentReads` (or `maxWholeDocumentReads` in `files.tools()`) to allow more. Make
  one tool set for each question: the count is the tool set's.
- **Budget values that cannot work together throw at `createLargeFiles`**: `reservedTokens` or
  `mapChunkTokens` at or above `contextTokens`. And with `contextTokens` below 400,000, fields you
  left out are now smaller than the fixed defaults they had.
- **`onActivity` and `onStep` can interleave differently.** Calls of one turn start together, so
  the "Searching…" lines of several calls can come before the first finished step. Steps still
  arrive in call order.

What needs none, unless you built on it:

- Old tool results can be replaced by stand-ins (`{ dropped: true, lines, note }`) late in a long
  question. `steps` then holds "Older tool results were shortened to make room in the request".
- `ToolSet` has a new member, `resultCharacters(name)`, and `LargeFiles` has `budgetFor()`: a mock
  of either needs them to type-check.
- `createGeminiGenerateText` throws `GeminiRequestError` (it threw an `Error` with a `status`),
  and takes `headers` as a function too.
- `GeminiFunctionCall` and `GeminiToolAnswer` are now the core's `ToolCall` and `ToolAnswer`, and
  `ToolFileLimits` is `ToolCallLimits` (the old name is kept).
- `maxToolTurns` and `maxToolCallsPerTurn` of `askGemini` still work. Their new home is
  `limits.toolTurns` and `limits.callsPerTurn`.
- Tool results are those of 0.4.1, compared call by call with 0.3.6 over 40 documents, except
  that a repeated whole-file read is refused.

### Checked

- 331 tests, 65 of them new. The requests `askGemini` sends are the ones 0.4.1 sent: its 44 tests
  pass unchanged but for one that now turns the retry off.
- Live, on the Gemini API: `askWithFiles` with `gemini()` and with `openAiCompatible()` on Gemini's
  OpenAI layer (streamed, a 5.2 MB log), an explorer behind the OpenAI layer with a thinking Gemini
  model answering, `askGemini` on a thinking model alone and with an explorer, a follow-up
  question from stored tool rounds, and a part read through the OpenAI adapter. In each, the usage
  the library returned was what the provider reported, request by request.
- **Not run against a real server:** the Claude adapter (there was no key: it is tested against
  the request and response shapes of the Messages API documentation), and `pdfInput` of the OpenAI
  adapter, which sends the pages of a PDF as a `file` part. Gemini's OpenAI layer refuses that part
  (HTTP 400), so it is off by default and follows OpenAI's documented shape untested.

## [0.4.1] - 2026-11-13

Fixes from a review of 0.4.0. Nothing to change in your code. Tool results are those of 0.4.0
except for the three points under Changed (compared call by call with 0.3.6 over 40 documents).

### Fixed

- **A whole-file read returned almost nothing on a model that thinks.** Such a model counts its
  thoughts in `maxOutputTokens`. Asked for 4,096 tokens of notes on a part of a log, Gemini 3.8
  Flash spent 3,931 of them thinking and wrote 317 characters, and Gemini 4 Hydrogen wrote none.
  `createGeminiGenerateText` now sends such a request once more with 32,768
  (`THINKING_OUTPUT_TOKENS`), and starts there for every later request to that model: one request
  is wasted per model and process, not one per part. A model or a gateway that refuses the larger
  limit is not asked for it again. An `analysisConfig` of your own still decides what it sets.
  Checked live: both models then returned whole notes, and an answer that cited all 70 matching
  lines of a log read in three parts.
- **`sweep` deleted a healthy document when one read of its metadata failed.** Every error counted
  as "cannot be read", and a file older than an hour was then removed, with its text and its
  original. Now only metadata that is not valid is that. A read that failed (a busy volume, too
  many open files) leaves the document alone, and a document that cannot be removed no longer
  stops the sweep.
- **A store that could not be read looked like a deleted document.** `FileDocumentStore` answered
  every failed read with "not there", and `askGemini` then told the user to upload the file
  again. A failed read is now a `DocumentStoreError`: retry the call. Its message names no path
  and no host, and the error that was caught is its `cause`.
- **Storage errors reached the model, and a user's screen, with the server's path.** A tool call
  that met `EACCES: permission denied, open '/data/large-files/doc_….txt'` passed that on in its
  result and in `steps`. It now answers `The document store could not be read (EACCES). Try again.`
- **One model turn could hold the server.** A regex that the quick check lets through, such as
  `(a|a)+$`, ran for its full 3 seconds on the main thread, and a turn can hold any number of
  calls: five such searches in one turn answered no other request for 15 seconds. A file can ask
  a model for exactly that. Now:
  - a regex scan runs in slices of 250 ms with other work in between, and stops at a line that
    takes two whole slices: 0.8 s for such a search, not 3;
  - the regex searches of one tool set (one question, in `askGemini`) share 6 seconds
    (`regexBudgetMs`). Past that, a regex search answers with an error that tells the model to
    search another way;
  - `askGemini` runs at most 8 tool calls of one turn (`maxToolCallsPerTurn`). The others are
    answered "not run, send it again if you still need it". Sixty reads in one turn built a
    request of 339,000 tokens before.
- **`ttlMs: Infinity` made every ingest throw** (`RangeError: Invalid time value`). It now keeps
  documents until they are deleted: their `expiresAt` is `NEVER_EXPIRES`.
- **A long line of emoji lost characters when it was wrapped.** The cut at 2,000 could fall
  between the two halves of a character outside the basic plane, and each half was stored as a
  replacement character.
- **`jsonBytes` and the planner under-counted** text with quotes, backslashes, tabs or many line
  breaks: by 23% for a JSON-lines export and 31% for TSV. They now count what JSON adds exactly,
  `DocumentMeta.jsonBytes` keeps it for planning, and `read_document` trims its result to the
  limit as it is sent: a read of quoted text came out at 42,514 characters against 24,000.
- **`**NOTHING RELEVANT**` counted as a relevant part** of a whole-file read. The reply of a part
  that found nothing is recognised whatever Markdown is around it.
- **A merge of notes that failed twice lost the notes of every part.** They now go on unmerged,
  and the answer is written from them.
- **`cacheSize` counted the pieces kept of a document that is read by range**, so with a small
  value a document pushed itself out of memory on every search. It counts documents again.
- **`delete` could leave a document listed without its text.** The metadata is removed first, and
  if that fails nothing else is removed.
- **`\p{L}` matched nothing in a regex search.** Patterns are compiled with the Unicode flag when
  they allow it, and without it otherwise.

### Changed

- **A file too large for `analyze_whole_document` is no longer offered it.** Its card says "It is
  too large to be analyzed whole", the tool guide and the declared tools leave the tool out when
  no file can use it, and `get_document_overview` says so in `whole_document_analysis`. A call of
  the tool still answers with the reason.
- **`get_document_overview` works out the number of parts from the metadata**, not by reading
  the whole file: that took 60 MB of reads and 0.7 s for a 60 MB log. The number is the count, or
  within a few percent of it.
- In a regex, `.` and a quantifier take a character outside the basic plane (an emoji) as one
  character.

### Added

- `DocumentStoreError`, `NEVER_EXPIRES`, `REGEX_BUDGET_MS` and `THINKING_OUTPUT_TOKENS`.
- Options `maxToolCallsPerTurn` (`askGemini`) and `regexBudgetMs` (`tools`).
- `DocumentMeta.jsonBytes`. Documents ingested before keep the planner's 8% rule.

## [0.4.0] - 2026-11-12

Nothing to change in your code: the API, the tools and their results are those of 0.3.6 (compared
call by call). Servers of 0.3.x and 0.4.0 can share a `FileDocumentStore` during a rolling update;
0.3.x servers ignore the new index files. The delete fix below holds once every server runs 0.4.0.

### Fixed

- **A document deleted on one server is no longer served by another.** Servers sharing a store
  kept a document in memory and answered from it until it expired, up to 72 hours after a delete.
  Every use of a kept document now asks the store first (`getMeta`, about a millisecond).

### Changed

- **The memory cache is bounded in bytes** (`cacheBytes`, default 256 MB), not in documents. Six
  documents of 50 MB took over 600 MB before. `cacheSize` still caps the number when given. Calls
  that arrive together for a document that is not in memory open it once.
- **Large documents are read by range on a store that can** (`FileDocumentStore`, or your own with
  `readTextRange`): a tool call reads the lines it needs, and a search reads the text 1 MB at a time,
  so memory no longer grows with file size and the number of users. Documents up to
  `wholeDocumentBytes` (2 MB) are loaded whole as before. Results are the same.
- `FileDocumentStore` writes every file whole (to a temporary name, then renamed), and `sweep` no
  longer deletes a document whose metadata cannot be read unless that file is an hour old: on a
  shared volume it may be an upload in progress.

### Added

- A line index per document (`<id>.idx` in `FileDocumentStore`, a few bytes a line), written at
  ingest. Documents from older versions get one the first time they are used.
- `DocumentStore.readTextRange`, `putIndex` and `getIndex`: optional, for stores of your own.
- `sweep` removes files that belong to no document, and temporary files, once they are an hour old
  (`orphanAgeMs`).
- Options `wholeDocumentBytes`, `scanChunkBytes` and `maxConcurrentScans` (at most 4 searches of
  large documents at once per process; the others wait, and those of the same document share one
  pass over it). Decoded pieces of documents in use are kept within `cacheBytes`.
- `get_document_overview` works out the number of parts of a file once per document, not on every call.

## [0.3.6] - 2026-11-11

### Fixed

- **A terminal escape without an end no longer deletes the rest of a file.** An `ESC ]` whose end
  (BEL, or `ESC \`) was not on its line removed everything up to the next escape, or to the end of
  the file: a log of 10,000 lines whose third line held a logged user agent `ua="evil␛]"` was
  stored as 3 lines, with no error. Now only those two characters go. The escapes that save and
  restore the cursor (`ESC 7`, `ESC 8`) and the like no longer leave a character behind.
- **DOCX and PPTX files are read in one pass, a piece at a time.** The paragraph pattern scanned
  to the end of the file from every paragraph that was not closed: a DOCX of 900 bytes held the
  server for 8 seconds, and one of 10 KB would have held it for an hour. The new reader looks at
  each character once. It also:
  - refuses a file that unpacks to more than 100 times its size (past the first 16 MB) or to more
    than 128 MB of XML, as it unpacks, before that much is in memory. A DOCX of 160 KB that unpacked
    to 50 MB of XML was stored as 29 million characters; it is now refused at 16 MB, in 0.2 s;
  - reads a text box once, after the paragraph it is anchored in. Word writes each text box twice,
    and the paragraph it was anchored in lost its text after the box: a resume template lost its
    "Objective" heading;
  - no longer takes the tab stops of a paragraph for tabs, and reads PowerPoint's line breaks
    (`<a:br>` with its run properties inside), which were lost.
- **Picture marks: forms painted inside forms cannot hold the server.** A form was read again each
  time it was painted, and the time limit was checked only between pages: a PDF of 3 KB whose
  forms each paint the next one 30 times ran the process out of memory. Now each form is decoded
  once per file, a page that paints more than 20,000 images or makes the reader go through more
  than 16 MB of content is marked as a drawing at once, and the time limit holds within a page.
  Such a file is now read in 0.6 s.
- **`llm-large-files/node`: `get` and `remove` answer their errors.** A `getOwner` that threw, or a
  store call that failed, rejected the handler's promise, which ends a Node process that has no
  handler for it (Express 4, plain `node:http`). All three handlers now answer every error
  themselves:
  - an error with a `status` between 400 and 599, as `getOwner` can now throw to refuse a request,
    is answered with that status and its message;
  - a store that fails is a 500 that gives the error's code (`Upload failed (ENOSPC).`). It was a
    422 with the error's message, which named the server's paths;
  - `getOwner` runs before the upload is read, so a refused upload is not buffered.

## [0.3.5] - 2026-11-11

### Added

- **`explorerModel`: a second model for the searching and reading.** The application chooses the
  model, as before, in `geminiApi()` or `vertexAi()`. It can now name two. The explorer makes the
  tool calls (search, read, look at pages) and reads a whole file in parts; `model` then writes the
  answer from what the tools returned, in one request without tools. So the many requests of a
  search through a large file can go to a cheaper or faster model.
  `geminiApi({ apiKey, model, explorerModel: process.env.GEMINI_EXPLORER_MODEL })`: left out,
  empty, or the same as `model`, one model does both, and the requests are those of 0.3.0 (checked
  byte for byte over seven scenarios). See
  [An explorer model](docs/configuration.md#an-explorer-model).
  - An endpoint of your own takes the explorer's URL as `explorerUrl`. It is called with the same
    headers.
  - `explorerGenerationConfig` is the explorer's `generationConfig`, for two models that do not
    take the same settings. It defaults to `generationConfig`. `analysisConfig` applies to the part
    reads of a whole-file read, which are the explorer's when there is one.
  - The answering model gets the explorer's tool calls and their results, pages included. It does
    not get the explorer's thoughts, thought signatures or words, and `text` and `onText` carry
    only the answer. The answer is always a request of its own, so a question takes one request
    more than with one model.
  - Checked live with Flash-Lite models, on the Gemini API and on Vertex AI, between Gemini 3.1 and
    3.5 and between Gemini 2.5 and 3.5, in both directions, with thinking on and off: counts and
    causes from a searched log, a whole-file read, and a chart and a photo from pages that the
    explorer looked at. Every answer was right. `gemini-3.5-flash-lite` as explorer stopped with
    `DONE` each time, at one output token.
- `EXPLORER_INSTRUCTION` and `FINAL_ANSWER_WITHOUT_TOOLS`: the two texts that `askGemini` adds for
  an explorer.

## [0.3.0] - 2026-11-10

The model can look at the pages of a large PDF. Until now such a PDF reached it as text only, and
pictures, charts and diagrams were lost. Everything here is off until you turn it on: an
application that changes nothing, and does not install the new optional dependency, sends the same
requests as with 0.2.0 (checked byte for byte against the published 0.2.0 over eight scenarios).

### Added

- **`view_pages`: the real pages of a PDF, on request.** The tool cuts up to five pages out of the
  uploaded file and returns them as one small PDF, which Gemini reads like any PDF. Asked which bar
  of a chart is tallest, `gemini-3.5-flash-lite` said from the text alone that it could not see the
  chart; with the tool it looked at the page unasked and answered correctly. For ten questions that
  the text answers, it did not look at a page once. A page costs about 530 tokens. See
  [Pictures in PDFs](docs/configuration.md#pictures-in-pdfs) for the limits and the measurements.
  - It needs the new optional dependency `@cantoo/pdf-lib`, and the uploaded file (next item).
  - `askGemini` offers it for every PDF whose original is kept, also for one whose text fits in
    the prompt (a slide deck of photos has little text). `viewPages: false` turns it off.
    It works on the Gemini API and on Vertex AI. `toolFilePlacement: "beside"` sends the pages in
    a user turn of their own instead of inside the function response: Gemini 2.5 needs that, as it
    does not see a file inside a function response.
  - In a loop of your own: `prepare(ids, base, { viewPages: true })` lists the PDFs in
    `PreparedContext.viewable`, `tools(documents, { viewPages })` declares the tool, and
    `ToolSet.executeWithFiles(name, args, { maxFileBytes, maxPages })` returns `{ result, files }`.
    The tool is declared only on request, and `execute()` answers it with an error, because a loop
    that drops the file would tell the model that pages are attached with nothing attached.
  - Search and read results carry page numbers (`page`, `pages`) for a PDF that can be shown.
- **`keepOriginals`: keep the uploaded file.** `createLargeFiles({ keepOriginals: ["pdf"] })`
  stores the file next to its text. It is off by default, because a kept file takes disk space, up
  to the upload limit, until the document expires. `DocumentStore` has two new optional methods,
  `putOriginal` and `getOriginal`; a store without them works as before and keeps nothing.
  `FileDocumentStore` writes `<id>.bin`, and delete, expiry and sweep remove it.
  `DocumentMeta.originalKept` records it, and `files.getOriginal(id, { owner })` returns the file
  to its owner.
- **Scanned PDFs of up to 30 pages are accepted** when their original is kept: the model reads them
  by looking at the pages. `scannedPdfPages` sets the limit, and 0 refuses them as before. A longer
  scan, and any scan without a kept original, is still refused.
- `geminiFunctionResponseTurns(answers, { files })`: the turns that answer a model turn's function
  calls, for a loop of your own. `geminiFunctionResponses` takes the files of each call and puts
  them inside its function response.
- `createPdfExtractor({ pictures })`, `ExtractInput.scannedPages`, `MAX_VIEW_PAGES`,
  `FINAL_ANSWER_AFTER_PAGES`, and the types `ToolFile`, `ToolOutput`, `ToolFileLimits`,
  `PrepareOptions`, `GeminiToolAnswer` and `GeminiToolFilePlacement`.

### Changed

- **A page of a PDF that shows a picture is marked**, with one line under its header:
  `[Picture on this page. This text cannot show it.]`. A picture is images that cover 3% of the
  page or more, other than a logo or background that is on most pages; a drawing is shapes filled
  in three or more colours, outside the tables. The pages are found from the structure of the file,
  without decoding any image: a PDF of 200 photos took 0.3 s to ingest before and takes 0.8 s now.
  This needs `@cantoo/pdf-lib`. Without it, and with `createPdfExtractor({ pictures: false })`, the
  text is exactly that of 0.2.0. Documents already in a store keep the text they were ingested
  with.
- `ToolSet` has a new method, `executeWithFiles`, `LargeFiles` has `getOriginal`, and
  `PreparedContext` has `viewable`. Code that builds these objects itself (a test double, for
  example) has to add them.

### Known limits

- A chart in one or two colours, and a drawing made only of lines, is not marked. The model can
  still look at the page: it did so for a one-colour chart that had only a caption.
- Every look reads the whole PDF into memory: 0.06 s for 100 MB of photos, but 4 to 5 seconds and
  700 MB for a file of 330,000 objects. A file that declares more objects than memory allows is
  refused. Reading cannot be interrupted, so a crafted PDF can hold the process for a long time:
  see [Security](docs/security.md#reading-pdfs-for-pages-and-pictures).
- Tested with PDFs made by Chrome, Word and PowerPoint. PDFs made by LaTeX and InDesign were not
  tested. For FPDF, Ghostscript and scanners, the structures they are known to write were tested
  with files made for the purpose, not with files from those tools. Encrypted PDFs were tested
  with files encrypted by the library itself, and confirmed as encrypted by pdf.js.

## [0.2.0] - 2026-11-10

### Fixed

- **Token estimates were far too low for logs and data files.** `estimateTokens` assumed 4
  characters per token, which holds for prose only: Gemini counts about one token per digit. A
  service log was estimated at 37% of its real size and a CSV of numbers at 26%, so such files were
  sent whole, and split into parts, at about three times the configured budget. The estimate now
  prices each kind of character and was fitted to Gemini's `countTokens` on 60 texts; it lands
  between 0.98 and 1.7 times the real count. Documents already in a store keep the estimate they
  were ingested with until they expire.
- **A regex search could freeze the server.** Patterns such as `((a+))+$` and `(a|a)+$` passed the
  nested-quantifier check and never finished on a 40-character line; the 3-second limit was only
  checked between lines. Regex scans now run under a hard time limit that interrupts a match in
  progress.
- **`askGemini` could return a remark instead of an answer.** If the model wrote "Let me search…"
  with a tool call and its next turn came back empty (cut off, or a malformed tool call), that
  remark was returned as the answer. The tool-free request is now sent whenever the model's last
  turn has no text.
- **A blocked prompt resolved as an empty answer with no reason.** The result now has
  `answered: false` and `blockReason`.
- **One model request was wasted when the tool turns ran out.** The last request was sent with
  tools, its calls were discarded, and then another was sent without tools. `askGemini` now goes
  straight to the tool-free request, so it never makes more than `maxToolTurns` requests.
- **Case-insensitive search found nothing in a file containing "İ"** (U+0130), in exact and
  keyword mode: the whole file silently fell back to case-sensitive matching.
- **Coloured logs lost their profile.** Only the ESC byte of a terminal colour code was removed,
  leaving `[31mERROR[0m`, which no longer matched as a level. Whole escape sequences are removed.
- **Compressed files were accepted as text.** A `.gz` log became a document of garbage. Gzip and
  ZIP files are refused with a message that says what to do, and other binary files without zero
  bytes are now detected too.
- **Ingest failed with "Maximum call stack size exceeded"** on files with a few hundred thousand
  short heading-like lines.
- **A file name could add lines to the prompt.** Control characters, line breaks, and
  text-direction overrides are removed from names at ingest, and names are quoted in the system
  instruction.
- **Whole-document reads hid that they were incomplete.** When part notes or the final answer
  reach the output limit, the tool result now says so (`notes_cut_short`, `answer_cut_short`, and a
  `note` telling the model to say so and to use exact search for complete lists). If no part can be
  read, the tool returns an error instead of an answer written from nothing.
- `read_document` reported a line range past the end of the file when no end line was given.

- **Words of right-to-left text in a PDF were glued together** when the file stores them piece by
  piece (as Word does): `יתרת סגירה4,167.90`. pdf.js adds the space only between pieces that run
  left to right. The space is now added from the positions.

### Changed

- **PDF tables are rebuilt.** A PDF stores text at positions, not tables. In file order, a row
  with an empty cell reads like a row without that column, so a model takes the next value for the
  missing one. The PDF extractor now finds tables by the position of their text and writes each
  row as `| cell | cell |  | cell |`. In a live test (`gemini-3.5-flash-lite`, 110 questions about
  single cells of seven PDFs made by Word and Chrome), 44 answers were right from the old text and
  110 from the new. It also handles tables in one column of a two-column page, right-to-left and
  sideways tables, headings that span columns, and wrapped cells; text that is not a table is left
  as it was. Two-column tables are left as text. See
  [PDF tables](docs/configuration.md#pdf-tables) for the limits.
  `createPdfExtractor({ tables: false })` gives the previous text. Documents already in a store
  keep the text they were ingested with.
- **A PDF page without any text is marked** `[No text on this page. It may be a scan, a photo, or a
  chart.]` instead of being left empty, so the model can say that it cannot see the page.
- **Documents are placed at the start of the first user turn**, not appended to the latest one.
  The document then stays in the same place as the conversation grows, so Gemini's prompt cache
  reuses it: in a live test, a follow-up question about a 53,000-token document had 96% of its
  input served from cache, against 0% before. Pass `documentPlacement: "last"` to `askGemini` for
  the previous layout.
- `maxToolTurns` is now the most requests one question can make, counting the answer. Tools still
  run in at most `maxToolTurns - 1` of them, as before.

### Added

- `createPdfExtractor({ tables })`, exported from the main entry point.
- `AskGeminiResult.answered` and `AskGeminiResult.blockReason`.
- `GenerateText` requests carry an optional `onTruncated` callback; `createGeminiGenerateText`
  calls it when Gemini stops at `MAX_TOKENS`.

## [0.1.0] - 2026-11-06

First release, extracted from the large-file support in the Gemini Prep chatbot.

### Added

- `createLargeFiles`: ingest, per-request planning against a token *and* byte budget, summary
  cards, and scoped tools (`search_document`, `read_document`, `get_document_overview`,
  `analyze_whole_document`).
- Extraction for text, Markdown, logs (UTF-8/UTF-16), JSON/JSONL, CSV/TSV, DOCX and PPTX (optional
  `jszip`), and PDF (optional `unpdf`).
- Log profiles (levels, time range, most frequent error shapes) and outlines for books and documents.
- Map-reduce over whole documents with parallel part reads, a retry, and rounds of merging.
- `MemoryDocumentStore` and `FileDocumentStore` with expiry.
- Document owners: documents are private to the user who uploaded them.
- `llm-large-files/gemini`: `askGemini` (streaming tool loop that always ends in an answer),
  `geminiApi` and `vertexAi` endpoints, and lower-level adapters.
- `llm-large-files/node`: upload, get, and delete handlers for any Node HTTP server.
