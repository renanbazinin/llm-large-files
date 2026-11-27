# Conversations

This guide is for applications that ask more than one question in a chat. It covers the format of
`messages`, what to keep after each answer and how to send it back, how to keep a long history
inside the model's window, and how to work with a history kept in a provider's own format. It
applies to `askWithFiles` and to `askGemini`, which runs it.

## The message format

`askWithFiles` takes the conversation as `messages: ChatMessage[]`, oldest first. A `ChatMessage`
is one of three kinds:

| Kind | Shape | What it is |
|---|---|---|
| `ChatTurn` | `{ role: "user" \| "assistant" \| "model", text }` | A plain turn. `"model"` is the same as `"assistant"`. |
| `ToolTurn` | `{ role: "tools", calls: [{ id?, name, args, result }] }` | One tool round of an earlier question, as `AskResult.toolTurns` returned it. |
| `ModelTextMessage` | `{ role: "user" \| "assistant", parts: [{ text } \| { native, text? }] }` | A turn with parts in the provider's own form: an image, an inline PDF. |

The rules:

- **The last message is the user's question.** Otherwise `askWithFiles` throws
  `Error("The last message must be the user's.")` before it sends anything.
- **Send the whole conversation with every question.** The library keeps nothing between
  questions. The plan of the documents, the tools on offer and the room in the request are worked
  out again each time, from the conversation you pass. Any server can answer the next question
  ([Deployment](./deployment.md)). An API that keeps the history on the provider's side does not
  fit this.
- **Send the question as the user wrote it.** The loop adds the document text and cards on each
  request: at the start of the first user turn (`documentPlacement: "first"`, the default), or at
  the end of the last (`"last"`). Never store them in your history.
- **What you pass is not changed.** The loop works on copies.
- **A `native` part goes unchanged to every model of the question**: a Gemini part to `gemini()`, a
  Chat Completions content part to `openAiCompatible()`, a Responses content part (`input_image`,
  `input_file`) to `openAiResponses()`, a Messages API block to `anthropic()`.
  With an [explorer model](./explorer-model.md) of another provider, both models get it, so both
  must read it. A native part that also has `text` is counted in tokens by that text, and in bytes
  by the larger of that text and its JSON; one without is sized by the length of its JSON, as media.

Annotate the array as `ChatMessage[]`. Without the annotation TypeScript widens `role` to
`string`, and the array is not accepted as `messages`.

```ts
import { readFile } from "node:fs/promises";
import { GoogleAuth } from "google-auth-library";
import { askWithFiles, type ChatMessage } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";

// `files` is your library, `documentIds` the documents of this chat and `userId` their owner, the
// signed-in user (see Getting started).
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const model = gemini(vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
}));

const question = "Where is the first error in app.log?";
const first = await askWithFiles({ files, model, documentIds, owner: userId, messages: [{ role: "user", text: question }] });

const chart = (await readFile("chart.png")).toString("base64");
const messages: ChatMessage[] = [
  { role: "user", text: question },
  ...first.toolTurns, // what the tools returned, between the question and its answer
  ...(first.answered ? [{ role: "assistant" as const, text: first.modelText }] : []), // only an answer, in the model's own words
  // A turn with a part in Gemini's own form.
  { role: "user", parts: [{ text: "Does this chart show the same outage?" }, { native: { inlineData: { mimeType: "image/png", data: chart } } }] },
];
const second = await askWithFiles({ files, model, documentIds, owner: userId, messages });
```

`askGemini` takes the conversation in one of two options. `messages` takes what `askWithFiles`
takes (`ChatMessage[]`): plain turns, stored tool rounds and, since 0.9.0, turns with native parts,
such as the chart's turn above. Before 0.9.0 it took only `Array<ChatTurn | ToolTurn>`. `contents` takes
Gemini `contents`, native parts included, and converts them with `fromGeminiContents`
([below](#gemini-contents)). When both are given, `contents` is used.

Every field of these types is in the reference: [`askWithFiles(options)`](../reference/ask.md#askwithfilesoptions)
and the rest of [ask.md](../reference/ask.md).

## What `toolTurns` holds

`AskResult.toolTurns` is the tool rounds of the question, in order, as plain JSON. A round is the
tool calls of one model turn, each with what its tool returned:

```json
{
  "role": "tools",
  "version": 1,
  "calls": [
    {
      "id": "c1",
      "name": "read_document",
      "args": { "document_id": "doc_3f2a…", "start_line": 96, "end_line": 98 },
      "result": { "document": "app.log", "lines": "96-98", "total_lines": 5000, "text": "96| …", "next_start_line": 99, "tool_turns_left": 10 }
    }
  ]
}
```

- `version` is the version of this shape (`TOOL_TURN_VERSION`, 1 since 0.9.0). Keep it as it is: a
  later version reads the rounds of the version before its own, and refuses rounds of a newer one
  with a `TypeError` ([ToolTurn](../reference/ask.md#toolturn)).
- `id` is the provider's own ID of the call, when it gave one. `args` and `result` are what the
  model sent and what it was given back. The tools and their results are in
  [Tools](../reference/tools.md).
- Each result is **as the model last had it**. One that was shortened during the question to make
  room is stored as its stand-in (`dropped: true`). Every result, pointer and refusal carries
  `tool_turns_left`, the tool turns the question had left then. A stand-in does not.
- **`tool_turns_left` is stored, and not sent again.** When you pass the rounds back in a later
  question, the results go to the model without it: its count was of the turns their own question
  had left, and a model could take a 0 there for its own.
- **So the first request of a follow-up differs from the requests of the question before it**,
  from that question's first tool round on, for two reasons. The results are sent without
  `tool_turns_left`. And the model turns of the round are sent as their calls alone: within its own
  question a round went back with the model's own form of its turn (Gemini's thought signatures,
  Claude's thinking blocks), and a stored round has none ([below](#what-toolturns-holds)). Either
  one alone makes the provider's prompt cache miss from there, once in each follow-up question, in
  its first request. The rounds of older questions were already sent that way and still match, and
  the documents and cards before the rounds are still read from the cache
  ([Costs and limits](./costs-and-limits.md#prompt-caching)). Before 0.9.0 these pages named
  `tool_turns_left` alone; keeping the count in the results would not save the miss for a model
  that thinks. Keeping the raw turns is planned for a later version.
- Calls that were not run are there too, with an `error`: for example refused for lack of room,
  past `limits.callsPerTurn`, or whose arguments could not be read. So are pointers to results already
  shown ([Repeated calls](#repeated-calls-in-a-follow-up)).
- **Pages are not in them.** A `view_pages` result is stored as a stand-in that says which pages
  were shown: `{ document, pages: "2-3", total_pages, dropped: true, note: "These pages were shown
  to you earlier and are no longer attached. Look at them again with view_pages if you need
  them." }`.
- **No provider's own form.** A stored round has no thought signatures, thinking blocks or other
  raw parts of the model turn. Any adapter can be given it, and builds the turn from the calls.
  That is one of the two reasons the prompt cache misses once in a follow-up (above).
- Only the rounds of this question. The stored rounds you passed in `messages` are not repeated.
- With an explorer model they are the explorer's rounds. Its words are not kept.
- They are there when `answered` is false, and in `partialResultOf(error)` when the question failed.

`limits.toolTurns` is something else: the most chat requests of one question, the answer included,
plus one more when the answer comes back without text. Whole-file part reads do not count toward
it ([Costs and limits](./costs-and-limits.md)).

**Why keep them.** Passed back between their question and its answer, the rounds show the model
what it searched and read before. A follow-up is then often answered without a new search, and a
call that repeats one of them is answered from the stored result
([below](#repeated-calls-in-a-follow-up)). In a live check of 0.5.0 a follow-up took one request
and no search; in a live check of the pointers on Vertex AI, during the work on 0.6.0, a follow-up
that repeated its first search got a pointer and answered from the stored result
([Measurements](../measurements.md)).

## Storing a conversation and asking the next question

What to keep for each question:

| Keep | From | Why |
|---|---|---|
| The question | What the user typed | The user turn of the history. Not the document text: the loop adds it. |
| The tool rounds | `result.toolTurns` | Sent back between the question and its answer. |
| The answer | `result.modelText`, when `result.answered` is true | The assistant turn: the model's own words, citations included (new in 0.99.13). |
| What was shown | `result.text` | Only with `showCitations: false`, to show the chat again: `text` without its citations. Otherwise it equals `modelText`. |
| The documents | Your session record | Passed as `documentIds` on every question ([below](#owners-and-documents-across-turns)). |
| `evidence` | `result.evidence` | Optional: the document and the lines or pages each call showed, to show sources or check a citation. |
| `usage` | `result.usage` | Optional: tokens and requests of the question, to count cost per user or session ([Costs and limits](./costs-and-limits.md)). |

Send `modelText` back, not `text`. With `showCitations: false`, `text` is the answer without its
citations, and a history built from it changes the requests of later questions: in 9 of 16
recorded follow-ups, the request was not the one sent with citations shown. Built from
`modelText`, 16 of 16 replay as recorded. Until 0.99.12 `AskResult` held no copy of the model's own
text when citations were hidden. [A chatbot in one page](./chatbot.md#3-chats-and-their-history)
keeps both.

An answer that is not one (`answered: false`) is not stored as the assistant's turn: the model
would read your error message as its own words. Keep the question and its tool rounds, so a second
try can use what was found.

**Keep the tool rounds apart from the session record.** One question's `toolTurns` can be large: a
result is up to `toolResultCharacters` (24,000 characters by default; the answer of a whole-file
read up to 40,000), a turn runs up to 8 calls, and tools run in up to 11 requests of a question. With the default limits that is up to about
2 million characters, less when the request runs out of room first. A session record that embeds
every turn reaches a database's limit on one record (16 MB in MongoDB) after a handful of such
questions.

This sample keeps sessions in one MongoDB collection and one record per question in another, and
asks with Gemini on Vertex AI. `files` is your library ([Getting started](../getting-started.md)).

```ts
import { GoogleAuth } from "google-auth-library";
import { MongoClient } from "mongodb";
import { partialResultOf, type AskResult, type ChatTurn, type Evidence, type ToolTurn, type UsageTotals } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";

/** One chat. Its questions are kept apart, one record each. */
type SessionRecord = { _id: string; userId: string; documentIds: string[] };

/** One question of a chat and what came of it. */
type TurnRecord = {
  sessionId: string;
  index: number;
  question: string;
  toolTurns: ToolTurn[];
  answer?: string; // result.modelText, only when the question was answered
  evidence: Evidence[];
  usage: UsageTotals;
  createdAt: Date;
};

const mongo = new MongoClient(process.env.MONGODB_URI!);
const sessions = mongo.db("chat").collection<SessionRecord>("sessions");
const turns = mongo.db("chat").collection<TurnRecord>("turns");

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
});

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

export async function ask(sessionId: string, userId: string, question: string, onText: (delta: string) => void, signal: AbortSignal): Promise<AskResult> {
  const session = await sessions.findOne({ _id: sessionId, userId });
  if (!session) throw new Error("No such chat.");
  const earlier = await turns.find({ sessionId }).sort({ index: 1 }).toArray();
  const asked = { sessionId, index: earlier.length, question, createdAt: new Date() };
  try {
    const result = await askGemini({
      files,
      endpoint,
      owner: userId,
      documentIds: session.documentIds,
      messages: historyOf(earlier, question),
      onText,
      signal,
    });
    await turns.insertOne({
      ...asked,
      toolTurns: result.toolTurns,
      ...(result.answered ? { answer: result.modelText } : {}),
      evidence: result.evidence,
      usage: result.usage,
    });
    return result;
  } catch (error) {
    // A question that failed keeps what it read and what it cost.
    const partial = partialResultOf(error);
    if (partial) await turns.insertOne({ ...asked, toolTurns: partial.toolTurns, evidence: partial.evidence, usage: partial.usage });
    throw error;
  }
}
```

- `historyOf` puts each question's rounds right after it, in the order they came, and the answer
  after them. Keep that order: the rounds are what the model did between the question and its
  answer.
- `askWithFiles` takes the same array: `Array<ChatTurn | ToolTurn>` is a `ChatMessage[]`.
- `partialResultOf(error)` is undefined for an error raised before the question was under way:
  documents that are missing, a budget that does not work, a last message that is not the user's.
  Nothing was asked, so there is nothing to keep. What each error means and what to show the user
  is in [Errors and reliability](./errors-and-reliability.md).
- Streaming `onText` to a browser, and what to send when the answer ends, is in
  [Web app](./web-app.md).

## Keeping the history inside the window

A history grows with every question, and stored tool rounds grow it fast. The loop makes room on
its own in some ways, and not in others.

### What the loop does on its own

- **It plans the documents for the room the history leaves.** The text turns and the stored rounds
  are counted before any document goes in whole. As the history grows, a document that went in
  whole may be searched instead. `result.plan.searchable` lists the documents that did not go in
  whole, which the model reaches only through the tools.
- **It shortens old tool results.** When the results of a new turn do not fit, the results of all
  but the last three tool rounds are replaced by short stand-ins, then all but the last two, then
  all but the last one. Stored rounds of earlier questions are the oldest, so they go first.
  Since 0.9.0 this is done before the first request too, when the stored rounds make it larger
  than its room in tokens (the loop's estimate, which the recovery from a refused request uses
  too; a request is not shortened for its bytes alone): the first request goes out shortened,
  instead of being refused by the provider and sent again. A
  stand-in keeps the document and the lines or pages that were shown, and tells the model to read
  them again if it needs them:

  ```json
  { "document": "app.log", "dropped": true, "lines": "1-212", "total_lines": 5000, "note": "These lines were shown to you earlier and were dropped from the conversation to make room. Read them again with read_document if you need them." }
  ```

  Errors and results under 700 characters are left as they are, except a `view_pages` result
  that showed pages: it is always replaced, and its pages go with it. Since 0.9.0 a result that
  its stand-in would not make smaller is left as it is too, such as a search counted by group with
  a few short groups. A whole-file read keeps the
  first 6,000 characters of its answer. `steps` then holds "Older tool results were shortened to
  make room in the request".
- **It stops running tools when nothing fits.** A call that cannot get 1,500 characters of room is
  not run. The model is told to answer from what it has, and the next request is the answer.
- **It recovers when the provider refuses a request as too large**, for the model's window or for
  the tokens the provider allows in a minute. It shortens older results,
  down to the latest round if needed, and sends the request again, at most twice a question. When
  nothing can be shortened, or the request sent again is still too large, and no tool call has
  been answered and no text shown yet, it plans the documents again for a smaller window, once a
  question. Details are in [Errors and reliability](./errors-and-reliability.md).

What it does not do:

- **It never shortens a text turn**, a question or an answer, and never touches native parts.
- **It never shortens anything of the question for an append-only model.** When a model of the
  question declares `appendOnly` (Claude does: [Claude](./anthropic.md)), no turn is rewritten
  during the question, and its results are not replaced by stand-ins. The check of stored pointers
  at the start of a question ([below](#repeated-calls-in-a-follow-up)) still runs, and since 0.9.0
  so does the shortening of stored rounds before the first request: they hold no thinking blocks,
  and nothing of the question was sent yet. Before, such a question failed on Claude.
- **It does not change your stored rounds.** Stand-ins exist in the requests of one question. The
  `toolTurns` it returns are the new rounds as the model last had them.

### What your application does

A long conversation passes the window in the end, whatever the loop does. Then the question fails,
most often with a `ModelRequestError` whose `kind` is `"context_overflow"`. Keep the history under a limit
you choose:

- Measure stored turns with `estimateTokens`, the library's own estimate, which the budget is
  counted in. You can store the size of each turn when you save it.
- Before each question, send the newest turns that fit. Drop the tool rounds of old turns before
  their text, then drop the oldest turns.
- Take the limit from `result.budget.contextTokens` of the latest answer, kept with the session:
  the window the question ran with, in the library's tokens, fitted to the models (for Claude, its
  `tokenScale` and `maxTokens` included). Before the first answer, `files.budgetFor().contextTokens`
  gives the library's own. A quarter of it is a reasonable start: the rest is left for the
  documents sent whole (up to `inlineTokens`), the part kept free (`reservedTokens`), and the
  tool results of the new question. This is a starting point, not a rule of the library.
- With Claude, or any append-only model, this is the only thing that keeps the history inside the
  window.
- Instead of dropping old turns, you can replace them with a summary that your application writes
  with a model call of its own. The library does not do this.

The types and `historyOf` are those of the sample above.

```ts
import { estimateTokens, type ChatTurn, type ToolTurn } from "llm-large-files";

/** About how many tokens a stored question takes in a request, in the library's estimate. */
function tokensOf(turn: TurnRecord): number {
  return estimateTokens(turn.question) + estimateTokens(turn.answer ?? "") + estimateTokens(JSON.stringify(turn.toolTurns));
}

/**
 * The newest turns that fit in `limit` tokens. Once a turn does not fit whole, it and every older
 * turn are sent without their tool rounds. The oldest turns are left out first.
 */
function fitHistory(earlier: TurnRecord[], limit: number): TurnRecord[] {
  const kept: TurnRecord[] = [];
  let used = 0;
  let withRounds = true;
  for (const turn of [...earlier].reverse()) {
    if (withRounds && used + tokensOf(turn) > limit) withRounds = false;
    const sent = withRounds ? turn : { ...turn, toolTurns: [] };
    const size = tokensOf(sent);
    if (used + size > limit) break;
    kept.unshift(sent);
    used += size;
  }
  return kept;
}

/** The messages of the next question, the history cut to a quarter of the window. */
export function messagesFor(earlier: TurnRecord[], question: string, contextTokens: number): Array<ChatTurn | ToolTurn> {
  return historyOf(fitHistory(earlier, Math.floor(contextTokens / 4)), question);
}
```

To use it in the session sample:

- Add `contextTokens?: number` to `SessionRecord`.
- In `ask`, pass
  `messages: messagesFor(earlier, question, session.contextTokens ?? files.budgetFor().contextTokens)`
  in place of `historyOf(earlier, question)`.
- After `insertOne`, keep the window the question ran with:
  `await sessions.updateOne({ _id: sessionId, userId }, { $set: { contextTokens: result.budget.contextTokens } });`.

Dropping a round is safe for the rounds after it: a pointer to a result that is no longer sent is
turned into a stand-in at the start of the question ([below](#repeated-calls-in-a-follow-up)).

## Repeated calls in a follow-up

A call whose result is still in the conversation in full is not run again. That holds within a
question, and across questions for the stored rounds you pass back. The files do not change, so the
same call would return the same.

The model gets a pointer in place of a result. The step of a pointer ends in "— already shown
above", for example "Search app.log (exact) for “ERROR” — already shown above". A pointer runs
nothing and has no entry in `evidence`. It is stored in `toolTurns` like any result.

Which calls count as the same and which results are never pointed to:
[How it works](../how-it-works.md#pointers-to-repeated-calls). The exact pointer and stand-in
results: [Tools](../reference/tools.md#what-askwithfiles-adds-to-results).

Some stored results are run again rather than pointed to:

- **A read of one line in the rounds of an earlier question.** 0.5.0 cut a long line to the room
  it had without saying so, and a stored read cannot be told apart from such a one. Reads of more
  lines, and reads of the same question, are pointed to.
- **An exact or regex search that 0.5.0 stored** with more matching lines than it showed. It holds
  only the first matches; run again, it shows the last one too.
- **Any call, with a model whose provider may clear old tool results on its side**
  (`capabilities.clearsToolResults`: Claude with context editing that clears tool uses, or
  compaction). No call is pointed to then, and the same call twice in one turn runs twice.

With a model that clears tool results, every stored pointer is sent as the stand-in that says to
call again: "Not run then: it repeated an earlier call whose result was later dropped from the
conversation to make room. Call it again if you need it."

**When the result is no longer there.** When a result is later shortened to make room, the pointers
to it become stand-ins (`dropped: true`) that say the call was not run then and can be made again.
The same check runs at the start of every question, on the rounds you pass. A pointer whose result
you left out of the history, or whose result was stored as a stand-in, becomes such a stand-in, so
the model is never told to use what it no longer has. Pointers work only when the stored rounds
come back as they were stored, in their place.

## Histories in a provider's own form

When your application already keeps its history in a provider's format, convert it at the edges:
into `messages` before the question, and the new tool rounds back into that format after it.

| History kept as | Into `messages` | New rounds back into it | Entry point |
|---|---|---|---|
| Gemini `contents` | `fromGeminiContents(contents)`, or `askGemini({ contents })` | `geminiToolTurns(result.toolTurns)` | `llm-large-files/gemini` |
| Chat Completions messages | `fromOpenAiMessages(history)`, which returns `{ system, messages }` | `openAiToolTurns(result.toolTurns)` | `llm-large-files/openai` |
| Messages API messages (Claude) | `fromAnthropicMessages(history)` | `anthropicToolTurns(result.toolTurns)` | `llm-large-files/anthropic` |

Put the converted rounds between the question and its answer, as with `ToolTurn`s. The three
converters leave `tool_turns_left` out of each result, so a request built from them is the same as
one built from the stored `ToolTurn`s; a test that compares a converted result with the stored one
must leave that field out. The full signatures are in [gemini.md](../reference/gemini.md),
[openai.md](../reference/openai.md) and [anthropic.md](../reference/anthropic.md).

### Gemini `contents`

```ts
import type { LargeFiles } from "llm-large-files";
import { askGemini, geminiToolTurns, type GeminiContent, type GeminiEndpoint } from "llm-large-files/gemini";

/** Asks the next question of a history kept as Gemini `contents`, and returns the history with it. */
export async function next(files: LargeFiles, endpoint: GeminiEndpoint, owner: string, documentIds: string[], history: GeminiContent[], question: string): Promise<GeminiContent[]> {
  const asked: GeminiContent = { role: "user", parts: [{ text: question }] };
  const result = await askGemini({ files, endpoint, owner, documentIds, contents: [...history, asked] });
  return [
    ...history,
    asked,
    ...geminiToolTurns(result.toolTurns),
    ...(result.answered ? [{ role: "model" as const, parts: [{ text: result.modelText }] }] : []),
  ];
}
```

- `geminiToolTurns` gives, for each round, a `model` turn of `functionCall` parts and a `user` turn
  of `functionResponse` parts. A call's `id` is in both when it has one. Each result is given
  without its `tool_turns_left`, as the loop sends the rounds of an earlier question. `contents`
  that 0.5.0 converted keep it; from 0.9.0 their rounds are sent without it (below).
- `fromGeminiContents` makes a `"user"` turn a user turn and a `"model"` turn an assistant turn,
  and the rounds that `geminiToolTurns` wrote stored rounds again (below). A text part is text. A
  text part with more fields (a `thoughtSignature`) is kept whole as a native part: its tokens are
  counted from its text, and its bytes from the whole part. Every other part is a native part, as
  it is: an image, an inline PDF, and the `functionCall` and `functionResponse` parts of your own
  functions.

Since 0.9.0, `contents` and `messages` with `ToolTurn`s behave alike. `fromGeminiContents` turns
the rounds `geminiToolTurns` wrote back into stored rounds: a `model` turn of `functionCall` parts
of the library's tools, followed by the `user` turn of their `functionResponse` parts. For the
rounds that `geminiToolTurns` wrote, the request is the same, byte for byte, as before. But now
the loop can shorten them to make room, point a
repeated call to them, and size them as it sizes `toolTurns`. Before, it saw them as plain parts:
a repeated search was run again, nothing could be shortened, and they were sized as media, about
15,000 tokens short for a round of two calls.

- A turn of your own functions, or one with a thought signature or a file in a response, stays as
  it is. Its tokens are counted from the JSON of its calls and responses, and its bytes from the
  whole parts, a thought signature included.
- A round at the end of `contents`, with no turn after it, stays as it is too. Its responses are
  the turn the model answers, as when your application ran the tools in a loop of its own and
  hands the conversation over.
- `fromGeminiContents(contents, { rounds: false })` keeps every turn as its parts, as 0.8 did.
  With `askGemini`, pass it as `messages`.
- The stored rounds come back without `tool_turns_left`, as stored `ToolTurn`s are sent. The
  rounds that `geminiToolTurns` wrote never had it. Rounds that 0.5.0 converted have it in their
  responses: from 0.9.0 they are lifted too, and sent without it, and a call without `args` is
  sent with `args: {}`. Such a conversation misses the prompt cache once, in its first request
  after the upgrade, from that round on.

### Chat Completions messages

```ts
import { askWithFiles, type LargeFiles } from "llm-large-files";
import { fromOpenAiMessages, openAiCompatible, openAiToolTurns, type OpenAiMessage } from "llm-large-files/openai";

const model = openAiCompatible({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-5.5" });

/** Asks the next question of a history kept as Chat Completions messages, and returns the history with it. */
export async function next(files: LargeFiles, owner: string, documentIds: string[], history: OpenAiMessage[], question: string): Promise<OpenAiMessage[]> {
  const asked: OpenAiMessage = { role: "user", content: question };
  const { system, messages } = fromOpenAiMessages([...history, asked]);
  const result = await askWithFiles({ files, model, owner, documentIds, system, messages });
  return [
    ...history,
    asked,
    ...openAiToolTurns(result.toolTurns), // convert once: a call without an ID gets a new random one each time
    ...(result.answered ? [{ role: "assistant", content: result.modelText }] : []),
  ];
}
```

- `fromOpenAiMessages` joins the `system` and `developer` messages into `system`, with a blank line
  between them; pass it as `system`. An `assistant` message with `tool_calls`, and the `tool`
  messages that answer it, become one `ToolTurn`. Text that an assistant message carries next to
  its `tool_calls` is not kept.
- A `tool` message's content is read as a JSON object, or kept as `{ text }`. A call that no `tool`
  message answers gets `{ error: "No result was kept for this call." }`. A call without an `id`
  gets `call_<n>_<i>`.
- In a `user` or `assistant` message, content parts other than text are native parts. Messages of
  any other role are skipped.
- `openAiToolTurns` gives, for each round, an `assistant` message with `content: null` and
  `tool_calls`, then one `tool` message per call with the result as JSON text, without its
  `tool_turns_left`. A call without an ID gets a random one: `call_` and 24 hex characters.

### Messages API messages (Claude)

```ts
import { askWithFiles, type LargeFiles } from "llm-large-files";
import { anthropic, anthropicToolTurns, fromAnthropicMessages, type AnthropicMessage } from "llm-large-files/anthropic";

const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-5-5",
  contextTokens: 1_000_000, // your model's window
});

/** Asks the next question of a history kept as Messages API messages, and returns the history with it. */
export async function next(files: LargeFiles, owner: string, documentIds: string[], system: string, history: AnthropicMessage[], question: string): Promise<AnthropicMessage[]> {
  const asked: AnthropicMessage = { role: "user", content: question };
  const result = await askWithFiles({ files, model: claude, owner, documentIds, system, messages: fromAnthropicMessages([...history, asked]) });
  return [
    ...history,
    asked,
    ...anthropicToolTurns(result.toolTurns), // convert once: a call without an ID gets a new random one each time
    ...(result.answered ? [{ role: "assistant" as const, content: result.modelText }] : []),
  ];
}
```

- The Messages API keeps the system prompt apart from the messages, so pass it as `system`
  yourself.
- `fromAnthropicMessages` makes text blocks text, and leaves out empty ones. The `tool_use` blocks
  of an assistant message, and the `tool_result` blocks that answer them, become one `ToolTurn`. A
  result's content is read as a JSON object, or kept as `{ text }`; a call that no `tool_result`
  answers gets `{ error: "No result was kept for this call." }`. Thinking blocks (`thinking`,
  `redacted_thinking`) are left out: they belong to the conversation they were written in. Every
  other block, an image or a document, is a native part.
- `anthropicToolTurns` gives, for each round, an `assistant` message of `tool_use` blocks and a
  `user` message of `tool_result` blocks, each result without its `tool_turns_left`. A result with
  an `error` gets `is_error: true`. A call
  without an ID gets a random one, `toolu_` and 24 hex characters, and every ID is made to fit the
  API (`[A-Za-z0-9_-]`) and to appear once in the output.
- Set `contextTokens` on `anthropic()` to the model's window, and trim the history yourself: the
  loop shortens nothing for Claude ([Claude](./anthropic.md)).

## Mixing providers in one history

`ToolTurn`s belong to no provider. Store them once, and any adapter can be given them: a
conversation can start on Gemini and go on with Claude or an OpenAI-compatible model.

```ts
import { askWithFiles, type AskResult } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";

// SessionRecord, TurnRecord and files are those of the session sample above, messagesFor that of
// the trimming sample.
const claude = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-5-5",
  contextTokens: 1_000_000, // your model's window
});

/** `contextTokens` is the window to trim the history to, in the library's tokens: Claude's, not the earlier model's. */
export function askClaude(session: SessionRecord, earlier: TurnRecord[], question: string, contextTokens: number): Promise<AskResult> {
  return askWithFiles({
    files,
    model: claude,
    owner: session.userId,
    documentIds: session.documentIds,
    messages: messagesFor(earlier, question, contextTokens),
  });
}
```

What each adapter does with stored rounds:

- **Call IDs are made valid for its API, in each request.** `anthropic()` turns a character outside
  `[A-Za-z0-9_-]` into `_` (Kimi's `functions.read_document:0` is sent as
  `functions_read_document_0`), gives a call without an ID `toolu_<round>_<n>`, and adds `_2`,
  `_3` to an ID already used in the request. `openAiCompatible()` gives a call without an ID
  `call_<round>_<n>`, the same in the call and in its result, and sends other IDs as they are.
  `gemini()` sends a call's `id` in its `functionCall` and `functionResponse` when it has one, and
  none otherwise.
- **The provider's own form of a turn stays with that provider.** Gemini's thought signatures,
  Claude's thinking blocks and OpenRouter's reasoning details go back only to the adapter that
  produced them, within one question. They are never in `toolTurns`: a stored round is rebuilt
  from its calls by whichever adapter gets it.
- **Native parts are not converted.** A Gemini image part goes to Claude as it is, in Gemini's
  form. Convert native parts yourself, or keep only their text, before another provider gets the
  history.
- **Windows differ.** The budget of a question follows its models (`contextTokens` of the adapter).
  A history that fit a 1M-token window may not fit a smaller one: trim it for the new model
  ([above](#what-your-application-does)). The window kept with the session is the earlier
  model's until the new one has answered; what Claude's window comes to in the library's tokens
  is in [Claude](./anthropic.md).

Within one question, an explorer of another provider works the same way: the answering model gets
the explorer's calls and results, built in its own form ([Explorer model](./explorer-model.md)).

## Owners and documents across turns

- **Pass the same `owner` with every question.** A document ingested with another owner is treated
  as missing. The owner is a string that is not empty: `ingest` refuses `""`, which
  `user?.id ?? ""` gives a caller who is not signed in. How to choose the owner is in
  [Storage](./storage.md#how-ownership-works).
- **Pass the chat as `scope`**, new in 0.9.0: `scope: [userId, sessionId]` at ingest and with every
  question. A document of another chat is then treated as missing, even one of the same user
  ([Scopes](./storage.md#scopes)).
- **Give the documents IDs of your own** (`IngestInput.id`, new in 0.9.0), such as the ID of the
  upload. The stored rounds (`toolTurns`) name the documents by ID. A file ingested again under the
  same ID (from the upload you kept, once it expired) is found by those rounds and by the session
  record as it is: nothing to rewrite. With the IDs the library makes, each ingest gives a new ID,
  and the rounds keep naming the old one.
- **Keep the documents with the conversation, not with one message.** Pass all of them in
  `documentIds` on every question. They are planned again each time.
- **A document that is gone is settled before any model request**, by `onMissingDocuments`
  ([below](#documents-that-are-gone)). By default the question stops: one that expired, was
  deleted, or belongs to another owner raises `DocumentsNotFoundError`, with the IDs in `.ids` and
  the message "A document is no longer available: doc_…. Upload it again." `partialResultOf` gives
  undefined for it: nothing was asked.
- **A document you take out of `documentIds` is no longer planned or offered.** Its card is not
  sent, and a tool call that names it is answered "Unknown document_id …". The stored rounds that
  hold its lines still go to the model, which can use what they show. To take a document out of
  the conversation completely, drop those rounds from the history too.
- **Stored rounds hold the text of the files, word for word**, up to `toolResultCharacters` per
  result, and the answers of whole-file reads (up to 40,000 characters). They outlive the
  document: its expiry (`ttlMs` of `createLargeFiles`) and `files.delete`. Your rules for keeping and
  deleting data must cover them ([Security](../security.md), [Storage](./storage.md)).

### Documents that are gone

A chat often lives longer than its documents: they expire after `ttlMs` (72 hours by default), or
are deleted. Before 0.9.0 the next question then failed whole with `DocumentsNotFoundError`, and
the application caught it, took the IDs off the chat and asked again. Since 0.9.0
`onMissingDocuments` does it in the question ([missing documents](../reference/ask.md#missing-documents)):

- `"drop"` answers without them. The model is told, in one line of the system instruction, how many
  files are no longer available, so it can say so when the question needs them. `result.missing`
  lists their IDs, and a `documents_missing` notice names them, for the page.
- A function can ingest them again, from the uploads you kept, under the same IDs, and return
  `{ retry: true }`; or under new IDs, and return `{ replace: { [oldId]: newId } }`. The question is
  then planned again, once, with them.

With the session sample above, the files that are gone are taken off the chat, and the user is told:

```ts
import { askGemini } from "llm-large-files/gemini";

// `files`, `endpoint`, `sessions`, `turns` and `historyOf` are those of the session sample above.
/** Asks the question without the files that are gone. Returns what to tell the user about them. */
export async function askWithoutGone(sessionId: string, userId: string, question: string, onText: (delta: string) => void, signal: AbortSignal): Promise<string | undefined> {
  const session = await sessions.findOne({ _id: sessionId, userId });
  if (!session) throw new Error("No such chat.");
  const earlier = await turns.find({ sessionId }).sort({ index: 1 }).toArray();
  const result = await askGemini({
    files, endpoint, owner: userId, documentIds: session.documentIds, messages: historyOf(earlier, question),
    onMissingDocuments: "drop", onText, signal,
  });
  if (!result.missing) return undefined;
  await sessions.updateOne({ _id: sessionId, userId }, { $pull: { documentIds: { $in: result.missing } } });
  return result.missing.length === 1 ? "A file of this chat is no longer available. Please attach it again." : `${result.missing.length} files of this chat are no longer available. Please attach them again.`;
}
```

- Keep its turn as the sample above does: `result.toolTurns` and the answer.
- With your own IDs ([above](#owners-and-documents-across-turns)), the uploads you keep can bring
  a file back instead: the sample under [missing documents](../reference/ask.md#missing-documents)
  ingests each one again from its upload and returns `{ retry: true }`.
- A tool call that finds a document gone during the question (deleted while the question ran)
  answers the model that it is no longer available, and the question gets a `document_gone`
  notice ([events](../reference/events.md#noticecode-and-noticedisplay)).
- **Files of a chat still in use expire too.** A file uploaded on Monday is gone on Thursday,
  even if the chat asked about it an hour before. With `touchOnUse: true` (new in 0.99.13, off by
  default), each question touches the files it plans once less than half of their `ttlMs` is left:
  with the default 72 hours, a file used 47 hours after its upload is kept 72 hours from then, and
  one used at 10 hours is not touched, with no store call. It runs before the first request and
  changes nothing that is sent. A store write that fails while it touches fails the question, as
  any store failure does. A `LargeFiles` of your own (not made by `createLargeFiles`) is touched
  by the default 72 hours, whatever its own `ttlMs`.
- **The stored rounds still hold a gone file's text.** `"drop"` leaves the file out of the plan,
  but rounds that read it still carry its lines into every later question. To keep a gone file
  out of the request, leave out the stored calls whose `document_id` is no longer one of the
  chat's documents (the sample above takes `result.missing` off the chat) before you send the
  history, as [A chatbot in one page](./chatbot.md) does.

## Related pages

- [Web app](./web-app.md): uploads, streaming the answer, cancelling.
- [Storage](./storage.md): owners, a per-user or per-session layout, retention.
- [Errors and reliability](./errors-and-reliability.md): every error, and what to show the user.
- [Costs and limits](./costs-and-limits.md): `limits`, the budget, usage per user or session.
- [Explorer model](./explorer-model.md): a second model that searches while another answers.
- [How it works](../how-it-works.md): the loop, the plan and the room in the request.
- [ask.md](../reference/ask.md): `ChatMessage`, `ToolTurn`, `AskResult` and the rest of the loop's types.
