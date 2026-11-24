# Upgrading to 0.10

This page takes an application from 0.9.0 to 0.10.0. Most applications change no code: read
[Requirements](#requirements), [Does my code compile?](#does-my-code-compile),
[The one cache miss](#the-one-cache-miss) and [Behavior to check](#behavior-to-check). The other
sections carry the Hebrew chatbot of the 0.9 guide over, and cover loops of your own, Vertex AI,
servers on a shared volume and rolling deploys. Every change is in the
[changelog](../CHANGELOG.md).

0.10.0 is about counts that are right and a cost that is bounded. Tables sent whole get exact
counts, files sent whole get line numbers, and every question has a ceiling on input tokens. The
text sent to the model changes on purpose, all at once, so each chat with files misses the
provider's prompt cache once at the upgrade.

## Contents

- [Requirements](#requirements)
- [Does my code compile?](#does-my-code-compile)
- [The one cache miss](#the-one-cache-miss)
- [Behavior to check](#behavior-to-check)
- [The worked example](#the-worked-example)
- [Loops of your own](#loops-of-your-own)
- [Vertex AI controls](#vertex-ai-controls)
- [Operations on a shared volume](#operations-on-a-shared-volume)
- [Rolling deploys](#rolling-deploys)
- [New and optional](#new-and-optional)

## Requirements

- **Unchanged:** Node.js 22.12 or later, `@types/node` 22 or later, and the optional dependencies
  `unpdf` `^1.4.0 || ^2.0.0`, `jszip` `^3.10.0` and `@cantoo/pdf-lib` `^2.11.1`. The entry points
  are the same six.
- **What a store holds is unchanged.** `DocumentMeta` keeps `metaVersion: 1`, `ToolTurn` keeps
  `version: 1`, and the files of `FileDocumentStore` keep their names and format. The store
  interface has no new method. A server of 0.9 reads what 0.10.0 writes, and the reverse.
- **What you store is unchanged.** The `toolTurns` of a result have 0.9's shape (`version: 1`),
  and a result gives nothing new to store. A schema written for 0.9 needs no change.

## Does my code compile?

Most code does. Every new option and field is optional, and no export was removed or renamed.
These do not compile:

| Code of yours | The error | What to write |
|---|---|---|
| A `switch` over `NoticeCode` with a `never` check, or a `Record<NoticeCode, …>` | Two new members: `"answer_filtered"`, `"answer_cut"` | Add them; a `switch` can end in a `default` instead |
| The same over `ToolOutcome` | A new member: `"redacted"` | Add it |
| The same over `ModelReply["finish"]`, `AskResult["finish"]` or the `finish` of a `request.end` event | A new member: `"other"` | Add it |
| Code that reads `owner`, `scope`, `sha256`, `original` or `metaVersion` of a document in the plan of `run.finish` or `run.error` (`EventResult.plan`) (TS2339) | Its metas are `Omit<DocumentMeta, …>` of those fields, and `eventResults: true` leaves them out at run time too | Read them from `AskResult.plan` |
| A mock typed `ReturnType<typeof createLargeFiles>`, or a variable whose type was inferred from `createLargeFiles` and that you later give a `LargeFiles` of your own (TS2322) | `createLargeFiles` returns `CreatedLargeFiles`, whose `stats()` and `toolsFor()` are required | Type it `LargeFiles` |
| A `DocumentHandlers` made by hand, such as a mock (TS2741) | `DocumentHandlers` has a required `stats()` | Add `stats`, or type the mock as the part you use |
| A `LargeFiles` of your own with a member named `stats` or `toolsFor` of another type (TS2322, TS2416) | `LargeFiles` has optional methods of those names | Rename yours |
| A value typed `Parameters<typeof vertexAi>[0]` whose `project` you read as a string, or whose `accessToken` you call with no argument (TS2322, TS2554) | `vertexAi` takes `VertexAiOptions`, a union of the token form and express mode (`apiKey`), and its token function is typed with its `{ refresh }` argument | Type it `Extract<VertexAiOptions, { project: string }>`, and call `accessToken({ refresh: false })` |
| A subclass of `UsageMeter` whose `add` takes a parameter of its own after `usage` (TS2416) | `add(model, usage, estimatedInputTokens?)` takes that place | Put yours after it |

Code that compiles and still needs a look:

- **An adapter of your own:** `finish` may now be `"other"`, for a reason that asking again does not
  mend ([How the reply ended](./guides/own-adapter-and-loop.md#how-the-reply-ended-finish)).
- **A `LargeFiles` of your own:** `stats`, `toolsFor` and `PreparedContext.toolable` are optional.
  `askWithFiles` passes `numberInline` and `inlineTables` to its `prepare`. A `prepare` written for
  0.9 leaves them aside: its blocks are sent as it made them, with no citation line, and its tables
  get no tools, as it gives no `toolable`.
- **An extractor of your own** that wraps the built-in PDF extractor: pass `headings` on to get the
  new PDF outline ([PDF outline](#a-pdf-outline-from-type-sizes)).
- **Results built by hand:** `finish` and `citations` are optional.
- **`askGemini`'s options** are now `Omit<AskOptions, "model" | "explorer" | "messages">` with
  `GeminiOwnOptions`. No field was removed, and every option of `askWithFiles` now reaches the
  loop.

## The one cache miss

A provider's prompt cache serves the start of a request it saw before, byte for byte. 0.10.0
changes the text it sends for a chat with files, so the first request of each such chat after the
upgrade has a new start, and pays its full input price once. What changes:

- Files sent whole are numbered (`12| `), so answers can cite their lines. When no file is
  searched, the system text gets the line `Cite line numbers like (report.docx L12).`
- A table sent whole gets three tool declarations (`search_document`, `read_document` and
  `aggregate_table`), its `document_id` in the first line of its block, and a line of the system
  text that says to count with them.
- `analyze_whole_document` is declared with two more arguments, `output` and `labels`.
- The request for the answer after files shown in full asks for an answer from those files and
  what the tools returned, with line citations. 0.9's named only what the tools returned.
- On a card, a size between 999,500 and 999,999 tokens reads "1.0M"; on a card and in
  `get_document_overview`, a size between 1,048,064 and 1,048,575 bytes reads "1 MB", and so do the
  error messages that print such a size (upload and text limits, `view_pages`).

**Why one miss.** All these changes ship in one release, so a chat misses once, not once a
version. **After the miss,** the cache works across questions as in 0.9
([Prompt caching](./guides/costs-and-limits.md#prompt-caching)). A follow-up still differs from
its first stored round, which goes back as its calls: the cache can serve the system text, the
tools and the turns before that round. On the Gemini API with Gemini 3.8 Flash, such a follow-up
kept only the system text and tools in the cache (33.7% of a 7K request, 15.7% of a 15K one, 9 of
9) ([Measurements](./measurements.md#the-live-session-on-the-gemini-api)). The cache share is
reported in `usage.cachedInputTokens`, not promised: the provider decides what it serves.

### Going back to 0.9's text

Each of these gives 0.9's bytes for what it covers, for this version:

| Option | Gives back |
|---|---|
| `inlineTables: "text"` | Tables sent whole without tools: one request, counts made by eye |
| `numberInline: false` | Files sent whole without line numbers |

With both, the requests are still not 0.9's. These have no way back:

- the `whole_file` hint of a `read_document` result cut short, and the `filter_note` of
  `aggregate_table`;
- the declaration of `analyze_whole_document`, and the prompts of its part reads and merges (M8);
- the card sizes "1.0M" and "1 MB".

## Behavior to check

### A ceiling on input tokens, and 2 whole-file reads

A question that sets no `limits.inputTokens` has a ceiling: the larger of `DEFAULT_INPUT_TOKENS`
(1,000,000) and `toolTurns` times the estimate of its first request, plus room for its whole-file
reads. Before each tool request the loop looks ahead: when what was spent, the next tool request
and the answer would pass it, the next request is the answer. A request that reports no input
counts by its estimate (`usage.estimatedInputTokens`, `usage.unmeasuredRequests`). A question makes
at most 2 whole-file reads in all (`wholeReadsPerQuestion`).

**Who:** questions with long tool loops, or several whole-file reads.
**What to do:** nothing. `limits: { inputTokens: Infinity, wholeReadsPerQuestion: Infinity }`
gives 0.9's rules ([The default ceiling](./guides/costs-and-limits.md#the-default-ceiling)).

### Tables sent whole get tools, and files sent whole are numbered

In `askWithFiles` and `askGemini`, a table sent whole (a CSV, an XLSX workbook, or a DOCX, PPTX,
PDF, HTML or Markdown file with a table of at least 3 `| cell |` rows) gets `search_document`,
`read_document` and `aggregate_table`, and the question runs the tool loop. Counts and sums are
then exact. Files sent whole are numbered, about 8% to 16% more tokens each, and a file at the edge
of `inlineTokens` may become a card.

What a question over a table costs:

- **No count:** one request when the model answers at once, a little larger (about 1,500 tokens of
  declarations and a guide line).
- **A count:** 2 or 3 requests (live, a median of 2 on both models), each sending the table again.
  The later requests start as the first did, so an implicit cache bills most of them at the cached
  price.
- **At most:** about `toolTurns` times the first request, bounded by the ceiling: about 1.5M input
  tokens for a CSV of 3,000 invoices.
- **Live, on the eval's cases** shared with 0.9.0: about 2.3 to 2.4 times 0.9.0's input tokens.
  Counts were right in 24 of 24 on Gemini 3.5 Flash-Lite and 3.8 Flash.
- **Gemini 3.5 Flash-Lite looks rows up with a tool**, even when the table is shown in full: 21 of
  39 questions with no count took one request (3.8 Flash: 38 of 39). A lookup then takes 2
  requests, each with the table. The lookups are exact; 0.9.0 got some wrong by eye. This is
  recorded, not tuned.
- **Limits sized for 0.9's one request** (`toolTurns: 1`, `requests: 1`, an `inputTokens` between
  one and two requests with the table) leave no tool turn: the question makes 0.9's one request,
  without tools.

**Who:** chats whose files are sent whole.
**What to do:** nothing, or `inlineTables: "text"` for 0.9's cost and `numberInline: false` for
0.9's blocks ([Tables sent whole](./guides/costs-and-limits.md#tables-sent-whole)).

### Evidence lists the files sent whole first

`AskResult.evidence` starts with one entry for each file sent whole:
`{ tool: "inline", documentId, document, lines: [[1, n]], whole: true }`, with no `callId`.

**Who:** code that counts tool calls from evidence, or maps it to `tool.end`.
**What to do:** skip the entries without a `callId`.

### Store calls time out at 30 s

A `getMeta`, a read of a text, its index or its original, or a `delete` that does not end within
`storeTimeoutMs` (30 s) fails with a `DocumentStoreError` of code `"ETIMEDOUT"` (503, to retry).
In a question, also inside a tool call or a part of a whole-file read, it ends the question with
`run.error`. While `maxStuckStoreCalls` calls of the process are stuck past their limit, store
calls fail at once with `"STORE_STUCK"` (503).

**Who:** servers whose store is a network volume or a remote service.
**What to do:** set `UV_THREADPOOL_SIZE=32` on servers with a network volume, and see
[Operations on a shared volume](#operations-on-a-shared-volume). `storeTimeoutMs: 0` sets no
limit.

### Transient errors are 503, and Gemini's errors in a stream are retried

- `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `EAI_AGAIN`, `EAGAIN`, `EBUSY`, `EMFILE`,
  `ENFILE`, `ESTALE`, `EHOSTUNREACH` and `ENETUNREACH` are 503 with `Retry-After: 5` in
  `errorInfoOf` and the upload handlers; `ENOSPC` and `EDQUOT` are 503 with 30 s. They were 500:
  "Upload failed (ETIMEDOUT)." is now a 503. A path upload whose read does not answer within
  `ingestTimeoutMs` is such an `ETIMEDOUT`, not the `IngestError` `"timeout"` (422).
- A Gemini error inside a stream, or in a reply of HTTP 200, with no numeric code gets the status
  of its `google.rpc` name (`UNAVAILABLE` 503, `RESOURCE_EXHAUSTED` 429, `DEADLINE_EXCEEDED` 504),
  and a transient one is sent again up to `retry.retries` times, unless text was already shown. A
  daily quota is still not sent again.
- A part read that runs out of time is a `ModelRequestError` of kind `"timeout"` and status 0 in
  every adapter, sent again once after the first wait of `retry`. `timeoutMs: 0` sets no limit;
  in 0.9 it aborted every part read at once.

**Who:** pages that word errors, and code that reads `status`.
**What to do:** tell users to try again when `errorInfoOf(error).retryable` is true
([Transient errors](./guides/errors-and-reliability.md#transient-errors-a-store-or-a-disk-that-does-not-answer)).

### Filtered and cut answers

A reply that a filter stopped part-way was an answer like any other in 0.9. Now `result.finish`
says how the answer ended. An `answer_filtered` or `answer_cut` notice comes before `run.finish`.
A reply ended by `"filtered"` or `"other"` is not asked for again: 2 requests over a searched file,
where 0.9 made 4. Gemini's `MODEL_ARMOR` and the image filters new since 0.9
(`IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, `IMAGE_OTHER`) count as `"filtered"`, as
`IMAGE_SAFETY` did; `OTHER`, `LANGUAGE` and four more as `"other"`. `MALFORMED_RESPONSE` is now `"malformed_call"`: the turn is
asked for once more.

**Who:** every chat page.
**What to do:** switch on `answerInfoOf(result)` for the message to show. With
`filteredAnswer: "drop"`, a filtered answer is dropped, and the notice has `discardText: true`
when its text was already streamed: take it back on the page
([Filtered and cut answers](./guides/errors-and-reliability.md#filtered-and-cut-answers)).

### A malformed call on the last turn gets a closing request

On the last tool turn, a reply whose tool call could not be read was taken for the answer, its
remark included (LLF-048). The loop now asks for the answer.

**Who:** tests that count requests.
**What to do:** expect one request more in that case.

### The loop answers unknown tools itself

A call of an unknown tool is answered by the loop: "Unknown tool “x”. The tools are: …", with
outcome `"refused"` and no `onActivity` line. In 0.9 the tool set answered it, with outcome
`"error"`.

**Who:** tests that compare results or events whole, and code that counts outcomes.
**What to do:** update them.

### Event plans without owner data

With `eventResults: true`, the plan of `run.finish` and `run.error` no longer holds `owner`,
`scope`, `sha256`, `original` or `metaVersion`, and its type says so.

**Who:** code that reads those fields from events.
**What to do:** read them from `AskResult.plan`.

### A PDF outline from type sizes

A PDF ingested from 0.10.0 on, whose text gives fewer than 3 headings, gets an outline from its
lines set at least 15% larger than its body, when 3 or more of them are found in its text. That is
most PDFs with headings in larger type, Hebrew ones included: Hebrew has no capitals, and pdf.js
gives no blank lines, so the text rules found none. Its card gains an "Outline" block,
`get_document_overview` lists it, and search hits gain `section`. A PDF with a title alone keeps the
card and hits of 0.9. Bold headings at body size, Word's Heading 3 and month-name dates set large
are among what it misses or takes wrongly ([PDF outline](./guides/pdfs.md#pdf-outline)).

**Who:** apps with PDF uploads, and extractors of your own that wrap the built-in PDF extractor.
**What to do:** nothing for stored documents: they keep their outline until they are ingested
again (with your ID, `ifExists: "replace"`); `metaVersion` stays 1. A wrapper that returns only
`text` and `pages` keeps 0.9's outline: return `{ ...extracted, text }` to pass `headings` on.

## The worked example

The Hebrew chatbot of [the 0.9 guide](./upgrading-0.9.md#a-worked-example-a-hebrew-chatbot-on-gemini-mongodb-and-a-shared-volume)
answers with Gemini on Vertex AI, keeps its chats in MongoDB (one record per chat, one per
question), and stores its files on a shared volume with a folder per user and chat. Its
`documents.ts` and its records do not change: each question's record keeps the question's text,
its `toolTurns` and its answer, as in 0.9. Its `ask.ts` changes in four places:

- the token function takes `{ refresh }`, and fetches a new token after a 401;
- `body` puts billing labels on every request;
- `filteredAnswer: "drop"` drops a filtered answer;
- `answerInfoOf` gives the Hebrew message for an answer that is not complete.

```ts
// ask.ts: a question of a chat on Vertex AI, with Hebrew words for an answer cut or filtered.
import { GoogleAuth } from "google-auth-library";
import { answerInfoOf, errorInfoOf, partialResultOf, type AnswerInfo, type ChatTurn, type ErrorInfo, type ToolTurn } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";
import { files, scopeOf, sessions, turns, type TurnRecord } from "./documents.js";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

// After a 401, { refresh: true }: the token in the cache was refused, and a new one is fetched.
async function accessToken({ refresh }: { refresh: boolean }): Promise<string> {
  const client = await auth.getClient();
  if (refresh) client.setCredentials({ ...client.credentials, expiry_date: 1 });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("No access token from the application default credentials.");
  return token;
}

const endpoint = vertexAi({ project: process.env.GOOGLE_CLOUD_PROJECT!, location: "global", model: "gemini-3.8-flash", accessToken });

/** The messages of the next question: each earlier question, its tool rounds, its answer. */
function historyOf(earlier: TurnRecord[], question: string): Array<ChatTurn | ToolTurn> {
  return [
    ...earlier.flatMap((turn): Array<ChatTurn | ToolTurn> => [
      { role: "user", text: turn.question },
      ...turn.toolTurns,
      ...(turn.answer !== undefined ? [{ role: "assistant" as const, text: turn.answer }] : []),
    ]),
    { role: "user", text: question },
  ];
}

export type Answer = { status: number; text?: string; note?: string; error?: string; retryAfterMs?: number };

export async function ask(userId: string, sessionId: string, question: string, signal: AbortSignal): Promise<Answer> {
  const session = await sessions.findOne({ _id: sessionId, userId });
  if (!session) return { status: 404, error: "השיחה הזו כבר לא קיימת." };
  const earlier = await turns.find({ sessionId }).sort({ index: 1 }).toArray();
  const asked = { sessionId, index: earlier.length, question, createdAt: new Date() };
  try {
    const result = await askGemini({
      files,
      endpoint,
      body: { labels: { app: "chatbot", team: "hr" } }, // billing labels: never a user ID
      owner: userId,
      scope: scopeOf(userId, sessionId),
      documentIds: session.files.map((file) => file.id),
      messages: historyOf(earlier, question),
      onMissingDocuments: "drop",
      filteredAnswer: "drop",
      signal,
    });
    await turns.insertOne({ ...asked, toolTurns: result.toolTurns, ...(result.answered ? { answer: result.text } : {}) });
    if (result.missing?.length) {
      await sessions.updateOne({ _id: sessionId, userId }, { $pull: { files: { id: { $in: result.missing } } } });
    }
    const info = answerInfoOf(result);
    if (info.complete) return { status: 200, text: result.text };
    // A cut answer has text worth reading: the message goes under it.
    return result.answered && result.text ? { status: 200, text: result.text, note: hebrew(info) } : { status: 200, text: hebrew(info) };
  } catch (error) {
    const partial = partialResultOf(error);
    if (partial) await turns.insertOne({ ...asked, toolTurns: partial.toolTurns });
    console.error("A question failed", error);
    const info = errorInfoOf(error);
    // errorWords is the `hebrew` function of the 0.9 guide: the words for each kind of error.
    return { status: info.status, error: errorWords(info), ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}) };
  }
}

declare function errorWords(info: ErrorInfo): string;

/** Why the answer is not complete, in Hebrew. The whole table is in the errors guide. */
function hebrew(info: AnswerInfo): string {
  switch (info.reason) {
    case "filtered": return "התשובה נעצרה על ידי מסנן התוכן, ולכן היא לא מוצגת.";
    case "cut": return "התשובה נקטעה כי הייתה ארוכה מדי. אפשר לבקש את ההמשך, או לשאול שאלה ממוקדת יותר.";
    case "blocked": return "אי אפשר לענות על השאלה הזו. נסו לנסח אותה אחרת.";
    case "language": return "לא הצלחנו לענות בשפה של השאלה. נסו לנסח אותה שוב.";
    case "no_answer": return "לא התקבלה תשובה הפעם. נסו לשאול שוב, או לשאול בצורה מדויקת יותר.";
    default: return "משהו השתבש בזמן כתיבת התשובה. נסו שוב.";
  }
}
```

- **`filteredAnswer: "drop"`.** A filtered answer comes back with `answered: false` and no text,
  so the record keeps no answer. When the answer was streamed, the `answer_filtered` notice has
  `discardText: true`: the page takes back what it showed
  ([Filtered and cut answers](./guides/errors-and-reliability.md#filtered-and-cut-answers)).
- **`body` labels** reach the project's billing export. Label by app, team or feature, never by
  user.
- **The chat misses the cache once**, at its first question after the upgrade: its files are
  numbered from then on. A follow-up still differs from its first stored round, as in 0.9
  ([The one cache miss](#the-one-cache-miss)).

## Loops of your own

`files.prepare()` keeps 0.9's plan, blocks and `instruction`, names included, unless you pass
`numberInline` or `inlineTables`. With `inlineTables: "tools"` it also returns `toolable`.

- **Line numbers and tables with tools:** pass `numberInline: true` and `inlineTables: "tools"`,
  and give the tools the files of `prepared.toolable` too, with the IDs of the files sent whole as
  `ToolOptions.inline` and the tools to declare as `ToolOptions.declare` (`search_document`,
  `read_document` and `aggregate_table` for those tables). `declarationsFor(names)` gives the
  declarations of those tools, to plan the size of a request
  ([Numbered lines and tables sent whole](./how-it-works.md#numbered-lines-and-tables-sent-whole)).
- **Store timeouts end the call.** `execute` and `executeWithFiles` throw a `DocumentStoreError`
  of code `"ETIMEDOUT"` or `"STORE_STUCK"`, where they returned an error result. End the question
  on it.
- **`ToolCallHooks.signal`** stops a call's scans, reads and page looks, and
  `ToolSet.wholeReadsLeft(documentId)` says whether a whole read can still run.
- **A whole read given `ToolCallLimits.maxRequests`** with more parts than that is refused before
  any request; with enough for its parts, it stops merging at it (`notes_left_out`).

## Vertex AI controls

New options of `gemini()` and `askGemini`, each unset by default
([Vertex AI and Gemini](./guides/vertex-and-gemini.md#fields-of-your-own-safety-settings-labels-and-more)):

| Option | What it does |
|---|---|
| `body` | Fields merged last into every chat request: `safetySettings`, `labels`, `serviceTier`, `cachedContent` (`GeminiRequestFields`) |
| `explorerBody` | The same for the explorer, when it needs other fields (`askGemini`) |
| `analysisBody` | A function of `maxOutputTokens`, merged last into each part read |
| `functionCallingMode` | `"VALIDATED"` has Gemini check each call against its declaration; `"AUTO"` by default. Not measured live |
| `timeoutMs` | The time limit of a part read: 180,000 by default, 0 for none |
| `answerWithoutTools` | `"omit"` (the default) or `"mode_none"` for the request of the answer. Live, `"mode_none"` closings were never served from the cache where no earlier closing existed, and cost about 1.8K more input tokens: keep `"omit"` |

And of `vertexAi()`:

- **`accessToken({ refresh })`**: after a 401, the request is sent once more with
  `{ refresh: true }`, so fetch a new token then. A second 401 is the error
  ([Access tokens](./guides/vertex-and-gemini.md#access-tokens-for-vertex-ai)).
- **`headers`** and **`host`**: headers of your own, and another host (a private endpoint).
- **`apiKey`**: Vertex AI express mode, with no project or token.

Before you set them:

- **Labels reach the billing export** of the project, and everyone who reads it. Never put a user
  ID, an email or other personal data in them.
- **`body` changes the bytes of every request**: the first request after you set it misses the
  cache once.

## Operations on a shared volume

- **`storeTimeoutMs`** (30,000): the time limit of each store call. Size it above the slowest
  healthy call: the read of the largest text loaded whole (2 MB by default) or of the largest
  original a page look reads, at the volume's busiest.
- **`UV_THREADPOOL_SIZE=32`** in the environment of each server that uses a network volume. A
  disk call that does not answer holds one of libuv's threads until it does; with the default 4,
  four stuck calls froze every file call and DNS look-up of the process. Check that the value
  reaches the process: an empty value is a pool of 1 thread.
- **`maxStuckStoreCalls`**: half the pool by default (2 with 4 threads, 16 with 32). At the limit,
  store calls fail at once with `"STORE_STUCK"`, so the threads left keep serving.
- **`files.stats()` and `handlers.stats()`** read counters only, with no store call. Alert on
  `stuckStoreCalls` above 0. Fail readiness on local saturation (`ingests.waiting`,
  `handlers.stats().uploadsInFlight`), and on stuck calls only when they stay at the limit for 60 s or more:
  all pods share one volume, and a probe that fails at once takes every pod out at once.
- **The sweep:** run it from one pod, or from a scheduled job. `sweepTimeoutMs` bounds it; it never
  counts as stuck, but is refused while too many calls are.

The probe, the table of stuck calls and the alerts:
[A store that stops answering](./guides/deployment.md#a-store-that-stops-answering).

## Rolling deploys

Servers of 0.9 and 0.10 can share a store and answer the same chats. What 0.10.0 stores is what
0.9 stores, in both directions, so nothing fails. But the two versions send different text (the
numbered blocks, the declarations), so a chat answered by both versions in turn misses the prompt
cache on every switch.

- **Deploy every server at once**, or route each chat to one version until the rollout ends (by
  chat ID at the load balancer, for example).
- **Documents** need nothing: their metadata and files are those of 0.9.0. A PDF keeps the outline
  it was ingested with.
- **Run the sweep from a server of 0.10.0**: its time limit and stuck-call limit apply there.

More on servers of two versions: [Deployment](./guides/deployment.md#servers-of-two-versions).

## New and optional

- **How an answer ended:** `AskResult.finish`, `answerInfoOf`, `filteredAnswer`
  ([Errors and reliability](./guides/errors-and-reliability.md#filtered-and-cut-answers)).
- **Citations checked:** `AskResult.citations` and `checkCitations`, Hebrew forms included
  ([ask](./reference/ask.md#citationcheck)).
- **Tool results before the model sees them:** `onToolResult`
  ([Security](./security.md#tool-results-ontoolresult)).
- **Limits:** `wholeReadsPerQuestion`, `DEFAULT_INPUT_TOKENS`, `usage.estimatedInputTokens`
  ([Costs and limits](./guides/costs-and-limits.md#the-limits-of-a-question)).
- **Tables and line numbers:** `inlineTables`, `numberInline`
  ([Costs and limits](./guides/costs-and-limits.md#tables-sent-whole)).
- **Items read whole:** `analyze_whole_document` with `output: "items"` and `labels`
  ([tools](./reference/tools.md#items-output-items)).
- **Gemini and Vertex AI:** `body`, `analysisBody`, `explorerBody`, `functionCallingMode`,
  `timeoutMs`, `answerWithoutTools`, `vertexAi({ headers, host, apiKey })` and
  `accessToken({ refresh })` ([gemini](./reference/gemini.md#geminiownoptions)).
- **Other providers:** response IDs from every adapter.
- **Operations:** `storeTimeoutMs`, `sweepTimeoutMs`, `maxStuckStoreCalls`, `AccessOptions.signal`,
  `files.stats()`, `handlers.stats()`, `files.toolsFor()`
  ([library](./reference/library.md#largefilesoptions)).
- **PDFs:** `ExtractedText.headings` ([PDF outline](./guides/pdfs.md#pdf-outline)).
- **Loops of your own:** `PrepareOptions.numberInline` and `inlineTables`,
  `PreparedContext.toolable`, `ToolOptions.declare` and `inline`, `declarationsFor`, `ToolName`,
  `ToolCallHooks.signal` ([library](./reference/library.md#preparedcontext)).
