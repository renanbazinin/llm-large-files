# Costs and limits

This guide is for you if you need to bound what one question may spend, or to count what it did
spend. It covers the limits of a question, the budget that decides what goes into each request, the
usage a question reports, cost per user or per chat session, and the features that cost most. Every
field and default is in the reference: [`AskLimits`](../reference/ask.md#asklimits),
[`AskResult`](../reference/ask.md#askresult) and [`Budget`](../reference/library.md#budget).

## Where the tokens go

One question is a chain of model requests:

- **Chat requests.** Each one carries your system instruction and the tool guide, the conversation,
  the documents sent whole (or a card for each document that is searched), the tool declarations,
  and every tool result of the question so far. So each request of the tool loop is larger than the
  one before, and the documents sent whole are read again by every request.
- **Part reads.** A whole-file read (`analyze_whole_document`) sends the file to the model in parts,
  one request each, then writes an answer from their notes. When the notes together are larger
  than one part, it merges them first.
- **Pages.** A page that `view_pages` showed stays in every later request of the question.

The last request writes the answer. A question about documents that are sent whole, with no pages to
look at, is a single request. [How it works](../how-it-works.md) has the details.

## The limits of a question

`limits` of `askWithFiles` and `askGemini` bounds one question, whatever the model decides to do:

```ts
import { GoogleAuth } from "google-auth-library";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global",
  model: "gemini-3.8-flash",
  explorerModel: process.env.GEMINI_EXPLORER_MODEL, // optional: a cheaper model searches and reads
  accessToken: async () => (await auth.getAccessToken())!,
});
const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });

export async function ask(userId: string, documentIds: string[], question: string) {
  const result = await askGemini({
    files,
    endpoint,
    owner: userId,
    documentIds,
    messages: [{ role: "user", text: question }],
    limits: {
      toolTurns: 8,           // at most 8 chat requests, the answer included, plus one when the answer comes back without text
      callsPerTurn: 6,        // at most 6 tool calls run in one turn
      wholeDocumentReads: 1,  // each document is read whole once at most (the default)
      inputTokens: 1_500_000, // no more tools once the question has used this many input tokens
      requests: 30,           // chat requests and part reads together
    },
  });
  console.log(result.turns, result.usage);
  return result;
}
```

| Limit | Default | What it counts | When it is reached |
|---|---|---|---|
| `toolTurns` | 12 | Chat requests of the question: the answer and the second tries after an empty or broken turn included. The second try of the answer itself, when it came back without text, can be one request past it. | The last request must be answered in text (`toolChoice: "none"`; Gemini gets no tools declared, the other adapters keep them listed). |
| `callsPerTurn` | 8 | Tool calls of one model turn that are run. | Each call past it is answered "Not run: one turn runs at most 8 tool calls. Send this call again if you still need it." |
| `wholeDocumentReads` | 1 | Whole-file reads of each document. | A read past it is answered with an error that tells the model to use the answer it already has. 0 refuses every read. |
| `inputTokens` | none | Input tokens of the question: every chat request and part read, of every model. | No more tools run: the next request is the answer. A whole-file read that would pass it is refused before it starts. |
| `requests` | none | Answered requests of the question: chat requests and part reads together. | Once one request is left, no more tools run, and that request is the answer. A whole-file read that would pass it is refused before it starts. |

**No limit throws.** A question that reaches a limit ends with a request for the answer, written
from what the tools returned so far. That request usually ends with `FINAL_ANSWER_REQUEST`: "Stop
using tools now. Answer my question using only what the tools returned above, with line citations.
Say plainly what you could not find. Answer in the language of my question." When no tool ran (for
example with `toolTurns: 1` or `requests: 1`), it ends with `FINAL_ANSWER_WITHOUT_TOOLS` instead.
When pages were the only thing to look at, it ends with `FINAL_ANSWER_AFTER_PAGES`. `answered` is
true when the reply has text and was not refused.

- **The answer is asked for once more when it comes back without text**: empty, or with a tool call
  the model was told not to make. The note "Your last reply had no text. No tool can be called in
  this reply: write the answer now, in text, from what is above." goes at the end of that one
  request. It is one of the two second tries a question may make, and it can be one request past
  `toolTurns`. It is not made after a refusal, a filter or a reply cut off at the output limit with
  nothing in it, nor once `requests` or `inputTokens` is reached: those two are never passed by
  it. With `toolTurns: 8`, a question makes at most 9 answered chat requests; to cap them exactly,
  set `requests`.
- Each tool result carries `tool_turns_left`, so the model can see its turns run out and stop
  searching in time. The results of an earlier question, passed back in `messages`, are sent
  without it ([Conversations](./conversations.md#what-toolturns-holds)).
- A model that answers in text before a limit is reached ends the question there.
- The result does not say that a limit ended the question, and `steps` has no line for it. When
  `result.turns` reaches `toolTurns`, the model was most likely still calling tools when its turns
  ran out. `result.usage` shows how close the question came to `inputTokens` and `requests`.
- With an explorer model, the limits count the work of both models together. The answer is always
  a request of its own, so the explorer has at most `toolTurns − 1` requests
  ([explorer model](./explorer-model.md)).
- `maxToolTurns` and `maxToolCallsPerTurn` of `askGemini` are `toolTurns` and `callsPerTurn` under
  their names from before 0.5.0. When both are given, `limits` wins.

### `inputTokens` and `requests` are checked between turns

- **They are checked before each tool turn**, against what the question has used so far. The
  request that crosses `inputTokens` has already been sent: its tool calls run, and then the answer
  is asked for. So a question can pass `inputTokens` by about two requests: the one that crossed
  it, and the answer, which reads everything the tools returned. Set the ceiling that far below
  what must not be passed.
- **`requests` keeps one request for the answer**, so the answer stays within it.
- **A whole-file read is reckoned before it starts.** In input tokens, it is the size of the file
  in the tokens of the model that reads it. In requests, it is its parts, one merge of their notes,
  its answer, and the answer of the question. A read that does not fit what is left is not run, and
  costs nothing. The model gets the reason, for example: "Not run: reading all of app.log takes
  about 2,400,000 input tokens, and 900,000 are left of the 1,500,000 this question may use. Use
  search_document and read_document." Reads let through in the same turn share what is left. A read
  whose notes need more than one merge can pass `requests` by those merges.
- **A request that failed and was sent again counts once**, as it does in `usage`.

### Tools you can leave out

```ts
import { askGemini } from "llm-large-files/gemini";

// files and endpoint as in the first sample. documentIds and question are yours.
const result = await askGemini({
  files,
  endpoint,
  documentIds,
  messages: [{ role: "user", text: question }],
  wholeDocumentAnalysis: false, // no analyze_whole_document: no part reads
  viewPages: false,             // no view_pages: no pages in the requests
});
```

- **`wholeDocumentAnalysis: false`** leaves `analyze_whole_document` out of the tools of every
  request: the question makes no part reads. A model that explores without `generateText` (the
  explorer when there is one, otherwise `model`) has no whole-file reads either. In both cases the
  tool guide and the cards do not mention whole-file reads.
- **`limits.wholeDocumentReads: 0`** keeps the tool and refuses every call of it: "Whole-file reads
  are turned off for this question. Use search_document and read_document on app.log." Each refused
  call still takes a place in a turn. Prefer `wholeDocumentAnalysis: false`.
- **`viewPages: false`** leaves `view_pages` out, and the tool guide does not mention it.

Neither changes which documents are sent whole: that is the budget's work.

## The budget

The budget describes your model connection: how large one request may be, and how it is shared
between documents, tool results, pages and the answer. The library plans every request with it.

### What each field decides

| Field | Default | What it decides |
|---|---|---|
| `contextTokens` | 1,000,000 | The window a question is planned for. |
| `maxRequestBytes` | 10,000,000 | The largest request body. It is checked apart from tokens: non-English text and JSON escaping make bytes run ahead of tokens. |
| `inlineTokens` | half the window, 200,000 at most | The most document text sent whole in one request. Lower it to send fewer documents whole; raise it to rely on the long context more. |
| `reservedTokens` | a quarter of the window, 64,000 at most | Kept free of documents: for the answer, tool results and a growing history. Text tool results may fill the window up to `contextTokens − reservedTokens / 2`. Pages may take up to half of it. |
| `mapChunkTokens` | half the window, 100,000 at most | The size of one part of a whole-file read. |
| `maxMapChunks` | 30 | The most parts of a whole-file read. A file that needs more is not read whole. |
| `toolResultCharacters` | 12% of the window, from 1,000 to 24,000 | The most characters of one tool result. The answer of a whole-file read may have 40,000, or this many when it is more. |

The defaults fit a model with a window of 1M tokens behind a request limit of 10 MB. For a model
with a smaller window, set `contextTokens`: the fields you leave out follow it.

| `contextTokens` | `inlineTokens` | `reservedTokens` | `mapChunkTokens` | `toolResultCharacters` |
|---|---|---|---|---|
| 1,000,000 | 200,000 | 64,000 | 100,000 | 24,000 |
| 200,000 | 100,000 | 50,000 | 100,000 | 24,000 |
| 128,000 | 64,000 | 32,000 | 64,000 | 15,360 |
| 32,768 | 16,384 | 8,192 | 16,384 | 3,932 |

`maxRequestBytes` and `maxMapChunks` do not follow the window.

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  budget: { contextTokens: 128_000, maxRequestBytes: 4_000_000 },
});
console.log(files.budget);
// { contextTokens: 128000, maxRequestBytes: 4000000, inlineTokens: 64000, reservedTokens: 32000,
//   mapChunkTokens: 64000, maxMapChunks: 30, toolResultCharacters: 15360 }
```

- **A field you set stays as you set it**, unless a model's window is smaller than the budget's
  ([below](#one-library-several-models)). Then a value too large for that window is lowered:
  `inlineTokens` to the window, `reservedTokens` and `mapChunkTokens` to half of it,
  `toolResultCharacters` to the window (1,000 at least). `maxMapChunks` is never lowered.
- **Values that cannot work are an error.** A field that is not a number above 0 throws
  "budget.inlineTokens must be a number above 0, and is 0." A `reservedTokens` or `mapChunkTokens`
  at or above `contextTokens` throws, for example, "budget.reservedTokens (200,000) must be smaller
  than budget.contextTokens (128,000): nothing would be left for the conversation."
  `createLargeFiles` throws for the library's budget. `askWithFiles` and `askGemini` throw for the
  `budget` of a question, before any request.
- **`budget` of `askWithFiles` and `askGemini`** changes fields for one question, such as
  `budget: { inlineTokens: 20_000 }`. The other fields stay the library's.

`resolveBudget(partial, limits)` gives the whole budget for any set of fields.
`files.budgetFor(overrides, limits)` gives the library's budget with `overrides` in place of its
fields. Both fit the budget to `limits` ([`ModelLimits`](../reference/library.md#modellimits): a
model's `contextTokens` and `maxRequestBytes`) when those are smaller:

```ts
import { resolveBudget } from "llm-large-files";

resolveBudget({ contextTokens: 200_000 });
// inlineTokens 100,000 · reservedTokens 50,000 · mapChunkTokens 100,000 · toolResultCharacters 24,000

// A value you set that is too large for a model's smaller window is lowered to fit it.
resolveBudget({ inlineTokens: 300_000 }, { contextTokens: 128_000 });
// contextTokens 128,000 · inlineTokens 128,000 · reservedTokens 32,000 · mapChunkTokens 64,000

// files as in the sample above: the library's budget with fewer parts for a whole-file read.
files.budgetFor({ maxMapChunks: 10 });
```

### Whole or searched

For each question the budget decides which documents go into the prompt whole, and which the model
reads through the tools. The library takes the size of everything else in the request (your system
instruction, the conversation and its stored tool rounds, and a margin of 2,000 tokens and 8,000
bytes), then fills the room that is left, smallest document first:

- token room: `min(inlineTokens, contextTokens − reservedTokens − the rest)`
- byte room: `maxRequestBytes − 256 KB − the rest`

A document goes whole when it fits both, after the smaller ones. The others get a card and the
tools. With the default budget and a short conversation, a log of 150,000 tokens goes whole. Add a
second log of 80,000 tokens, and the 80,000 go whole while the 150,000 are searched: the two
together are more than 200,000.

The sizes are the library's estimate of tokens (`estimatedTokens` of each document) and the text's
size in JSON. As the conversation grows, the room for documents shrinks, so a document that went
whole in the first question of a chat can be searched in a later one. `result.plan` says what
happened:

```ts
// result: what askWithFiles or askGemini returned.
console.log("whole:", result.plan.inline.map((meta) => meta.name), result.plan.inlineTokens);
console.log("searched:", result.plan.searchable.map((meta) => meta.name));
```

### One library, several models

The budget of a question is the library's, with the question's `budget` in place of its fields,
made to fit the models of the question. An adapter says what its model takes in its
`capabilities` ([`ModelCapabilities`](../reference/ask.md#modelcapabilities)):

1. **The window** is the smallest of the budget's `contextTokens` and the `contextTokens` of each
   model. The same goes for `maxRequestBytes`.
2. **The largest `tokenScale`** of the models divides it. The budget is counted in the library's
   estimate of tokens, which is fitted to Gemini's count. A model whose tokenizer counts more tokens
   for the same text has, in those terms, a smaller window.
3. **The largest `outputTokens`**, divided the same way, is kept free. A model that counts its reply
   against the window (Claude's `max_tokens`) leaves that much less for the prompt. At least a
   quarter of the window is left.
4. **The other fields** follow the window that results: those the library left out are worked out
   from it, and those it set are lowered when they are too large for it.

What the adapters declare unless you set it:

| Adapter | `contextTokens` | `maxRequestBytes` | `tokenScale` | `outputTokens` | `pageTokens` |
|---|---|---|---|---|---|
| `gemini()` | only when set | only when set | 1 | none | 530 |
| `openAiCompatible()` | only when set | only when set | 1, or the option | none | 1,000 (pages need `pdfInput`) |
| `anthropic()` | only when set | 32,000,000 | 1.35, or the option | `maxTokens`: 64,000 | 3,500 |

A model that declares no window gets the library's: 1,000,000 tokens unless you set another. So
declare the window of every model whose window is smaller.

**With `askWithFiles`**, give each adapter its `contextTokens` (and `maxRequestBytes`), and every
question is planned for the smallest. Here a model on your own server explores for Gemini on
Vertex AI:

```ts
import { GoogleAuth } from "google-auth-library";
import { askWithFiles, createLargeFiles, FileDocumentStore } from "llm-large-files";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const files = createLargeFiles({ store: new FileDocumentStore("./data/large-files") });

// Writes the answers. Its window: 1,048,576 tokens.
const flash = gemini(vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
}), { contextTokens: 1_048_576 });

// Searches and reads. Its window: 131,072 tokens, and a tokenizer that counts a fifth more.
const local = openAiCompatible({
  baseUrl: process.env.LOCAL_LLM_URL!,
  model: process.env.LOCAL_LLM_MODEL!,
  contextTokens: 131_072,
  tokenScale: 1.2,
});

export async function ask(documentIds: string[], question: string) {
  const result = await askWithFiles({ files, model: flash, explorer: local, documentIds, messages: [{ role: "user", text: question }] });
  console.log(result.budget.contextTokens); // 109226: the library's 1,000,000, then 131,072, then / 1.2
  return result;
}
```

**With `askGemini`**, which makes its models without these numbers, put the window in the
library's `budget`, or in the `budget` of a question. With an explorer, use the smaller of the two
windows. [Vertex AI and Gemini](./vertex-and-gemini.md) has the setup.

`result.budget` is the budget a question ran with. `files.budgetFor(undefined, { contextTokens })`
gives the same in advance for a model that declares only a window. With a `tokenScale` or
`outputTokens`, only `result.budget` has it.

A window left too large is often recovered. The first request the provider refuses as too large
teaches the loop the window it names. Older tool results are shortened, or, when no tool has run
yet, the documents are planned again ([errors and reliability](./errors-and-reliability.md)). With
Claude, whose conversation may only grow, only the second works: a refusal after a tool ran is
thrown, with `kind: "context_overflow"`. So is one that shortening cannot fix. Even a recovery
costs a refused request and a step the user sees: declare the window instead.

### Setting `tokenScale`

The documents are planned before the first request, with the scale the adapters declare. During a
question, the input tokens each provider reports raise the loop's estimate of each request's size,
and so leave less room, when they are higher than the scale says (up to twice the estimate). The
latest report counts: a lower one brings the estimate back down, but never below what the scale
says, nor, since 0.7.1, below what a request the provider refused as too large showed (up to 8
times the estimate, for the rest of the question: see
[a request too large for the model](../how-it-works.md#a-request-too-large-for-the-model)). A scale set too low makes requests that the provider can refuse as too large. A scale set too
high leaves part of the window unused.

To find the scale of an OpenAI-compatible model, compare its count of a sample of a file like the
ones your users upload, well inside the model's window (a few thousand lines), with the library's
estimate. It costs one request, whose reply you do not need:

```ts
import { readFile } from "node:fs/promises";
import { estimateTokens } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";

const local = openAiCompatible({ baseUrl: process.env.LOCAL_LLM_URL!, model: process.env.LOCAL_LLM_MODEL! });
const text = (await readFile("sample.log", "utf8")).split("\n").slice(0, 5_000).join("\n");
const reply = await local.send({ system: "", messages: [{ role: "user", parts: [{ text }] }] });
console.log((reply.usage?.inputTokens ?? 0) / estimateTokens(text)); // about the tokenScale to set
```

`gemini()` needs no scale. `anthropic()` defaults to 1.35, a cautious guess for Claude's tokenizer
([Claude](./anthropic.md)).

## Usage: what a question used

`result.usage` ([`UsageTotals`](../reference/ask.md#usagetotals)) sums every request of the
question that was answered, part reads included, in all and for each model:

| Field | What it counts |
|---|---|
| `requests` | Answered requests: chat requests and part reads. A request that failed and was sent again counts once. |
| `inputTokens` | Every token of the prompts, those read from a cache included. |
| `cachedInputTokens` | The part of `inputTokens` that was read from the provider's prompt cache. |
| `outputTokens` | Every token the models wrote, thoughts included. |
| `thoughtTokens` | The part of `outputTokens` spent thinking, where the provider says. |
| `byModel` | The same five counts for each model, keyed by the adapter's `id`. |

What each provider's numbers become:

| | Gemini | OpenAI-compatible | Claude |
|---|---|---|---|
| `inputTokens` | `promptTokenCount` + `toolUsePromptTokenCount` | `prompt_tokens` | `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` |
| `cachedInputTokens` | `cachedContentTokenCount` | `prompt_tokens_details.cached_tokens`, or DeepSeek's `prompt_cache_hit_tokens` | `cache_read_input_tokens` |
| `outputTokens` | `candidatesTokenCount` + `thoughtsTokenCount` | `completion_tokens` | `output_tokens` |
| `thoughtTokens` | `thoughtsTokenCount` | `completion_tokens_details.reasoning_tokens` | 0: not reported |

- **Only answered requests are counted.** A request that failed is not, though the provider may
  have billed it: a stream cut off half-way, or a wait on a silent model that ran out. Your
  provider's bill is the record; `usage` is a close account of it.
- **A request without usage counts with 0 tokens**: an OpenAI-compatible server that sends no
  usage, or a part reader of your own that does not call `onUsage`.
- **`byModel` is keyed by the adapter's `id`.** For `gemini()` that is the model named in the URL
  (`"gemini-3.8-flash"`); for `openAiCompatible()` and `anthropic()`, the `model` option; for any of
  them, the `id` option when you set it. A part read counts under the model that read it: the
  explorer, when there is one. Two adapters with the same `id` share an entry, so give them their
  own. `askGemini` names its models from their URLs and has no `id` option.
- **`turns` is not `usage.requests`.** `result.turns` counts the chat requests the question made,
  part reads not included. `usage.requests` counts every answered request.
- **`lastUsage`** is the provider's own usage object of the last chat request, as it came.
- **A question that failed** throws. `partialResultOf(error)` gives what it had used until then.
- **A question planned again**, after the provider refused its first request as too large, counts
  what its first try used.

## Cost per user or per session

Add `result.usage` to the record of the chat session (or of the user) after each question, and
multiply by your prices. The library knows no prices: keep a price list for each model `id`, with
three rates: input not read from the cache, input read from the cache, and output. Thoughts are
part of `outputTokens`, so do not add `thoughtTokens` on top.

This module is the arithmetic. Save it as `usage.ts`:

```ts
import type { ModelUsage, UsageTotals } from "llm-large-files";

/** One model's prices per million tokens, from your provider's price list. */
export type Price = { input: number; cachedInput: number; output: number };

/** One model's usage in a session. The model ID is a value, not a field name: IDs hold dots. */
export type ModelSpend = ModelUsage & { model: string; requests: number };

/** The usage part of your session record. */
export type SessionUsage = { questions: number; failed: number; cost: number; unpriced: string[]; models: ModelSpend[] };

export const noUsage = (): SessionUsage => ({ questions: 0, failed: 0, cost: 0, unpriced: [], models: [] });

/** What one question cost by your prices, and the models that have no price. */
export function costOf(usage: UsageTotals, prices: Record<string, Price>): { cost: number; unpriced: string[] } {
  let cost = 0;
  const unpriced: string[] = [];
  for (const [model, used] of Object.entries(usage.byModel)) {
    const price = prices[model];
    if (!price) {
      unpriced.push(model);
      continue;
    }
    // inputTokens holds the cached tokens; outputTokens holds the thoughts.
    const fresh = used.inputTokens - used.cachedInputTokens;
    cost += (fresh * price.input + used.cachedInputTokens * price.cachedInput + used.outputTokens * price.output) / 1_000_000;
  }
  return { cost, unpriced };
}

/** A session's usage with one more question added. */
export function addUsage(session: SessionUsage, usage: UsageTotals, prices: Record<string, Price>, failed = false): SessionUsage {
  const { cost, unpriced } = costOf(usage, prices);
  const models = session.models.map((spend) => ({ ...spend }));
  for (const [model, used] of Object.entries(usage.byModel)) {
    let spend = models.find((known) => known.model === model);
    if (!spend) {
      spend = { model, requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
      models.push(spend);
    }
    spend.requests += used.requests;
    spend.inputTokens += used.inputTokens;
    spend.cachedInputTokens += used.cachedInputTokens;
    spend.outputTokens += used.outputTokens;
    spend.thoughtTokens += used.thoughtTokens;
  }
  return {
    questions: session.questions + 1,
    failed: session.failed + (failed ? 1 : 0),
    cost: session.cost + cost,
    unpriced: [...new Set([...session.unpriced, ...unpriced])],
    models,
  };
}
```

Then the chat route records what each question used, the failed ones too:

```ts
import { readFile } from "node:fs/promises";
import { partialResultOf, type ChatTurn, type ToolTurn, type UsageTotals } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";
import { addUsage, noUsage, type Price, type SessionUsage } from "./usage.js";

/** Your storage of chat sessions (MongoDB, SQL…): the usage is a field of the session record. */
export interface Sessions {
  usage(userId: string, sessionId: string): Promise<SessionUsage | undefined>;
  saveUsage(userId: string, sessionId: string, usage: SessionUsage): Promise<void>;
}

// Your price list, per million tokens: { "gemini-3.8-flash": { "input": …, "cachedInput": …, "output": … }, … }
const prices = JSON.parse(await readFile("./prices.json", "utf8")) as Record<string, Price>;

// files and endpoint as in the first sample. messages: the chat so far, ending with the question.
export async function answer(sessions: Sessions, userId: string, sessionId: string, documentIds: string[], messages: Array<ChatTurn | ToolTurn>) {
  const record = async (usage: UsageTotals, failed: boolean) => {
    const before = (await sessions.usage(userId, sessionId)) ?? noUsage();
    await sessions.saveUsage(userId, sessionId, addUsage(before, usage, prices, failed));
  };
  try {
    const result = await askGemini({ files, endpoint, owner: userId, documentIds, messages });
    await record(result.usage, false);
    return result;
  } catch (error) {
    // What the question paid for before it failed. Undefined when it failed before its first request.
    const partial = partialResultOf(error);
    if (partial) await record(partial.usage, true);
    throw error;
  }
}
```

- **Failed questions cost too.** `partialResultOf(error)` holds the usage of a question that failed
  once it was under way: a model error (its first request included, which then shows 0 requests),
  or a question you cancelled. It is undefined for a question that failed before its first request
  (a document that is gone, a budget that does not work), which used nothing.
- **Several servers.** Two questions of one session can end on two servers at the same moment, and
  a read, an addition and a write lose one of them. Add with an atomic update of your database
  (MongoDB's `$inc`, SQL's `UPDATE … SET n = n + ?`), or store one record per question and sum the
  records when you need the total. Model IDs hold dots (`gemini-3.8-flash`), which MongoDB reads as
  a path in an update, so keep them as values, as `models` does above, not as field names.
- **Claude's cache writes** are inside `inputTokens`, so the sample prices them at the plain input
  rate, and Anthropic bills them at another. [Claude](./anthropic.md) shows how to read Claude's own
  usage of each reply, which has them apart.
- **A price that depends on the size of each request** (a higher rate for a long prompt) cannot be
  worked out from the totals of a question. Price each reply as it comes
  ([below](#each-reply-as-it-comes)).

### An allowance per user

To keep a user within an allowance, turn what the user has left into `limits.inputTokens` of the
next question. Keep a margin: a question can pass its ceiling by about two requests.

```ts
import { askGemini } from "llm-large-files/gemini";

// files and endpoint as in the first sample. spentThisMonth: the user's input tokens this month,
// from your records. userId, documentIds and messages are yours.
const allowance = 50_000_000; // input tokens a month: your own figure
const margin = 2_000_000;     // about two requests of a 1M-token window
const left = allowance - spentThisMonth;
if (left <= margin) throw new Error("You have used this month's allowance.");

const result = await askGemini({
  files,
  endpoint,
  owner: userId,
  documentIds,
  messages,
  limits: { inputTokens: Math.min(5_000_000, left - margin) },
});
```

There is no limit across questions: each question runs up to four tool calls at a time, and each
whole-file read up to four parts at a time, whatever the other questions do. To bound how fast a
user or a tenant spends, wrap the adapters (below) and make them wait for your own limiter.

### Each reply as it comes

With `askWithFiles`, an adapter you wrap sees the usage of every request it answers: its chat
requests and its part reads. Make the wrapped adapter for each question, so that what it reports
belongs to that question:

```ts
import type { GenerateUsage, ModelAdapter } from "llm-large-files";

/** The adapter, with `onReply` called for every answered request: chat requests and part reads. */
export function metered(base: ModelAdapter, onReply: (model: string, usage: GenerateUsage) => void): ModelAdapter {
  const { generateText } = base;
  return {
    ...base,
    async send(request, hooks) {
      const reply = await base.send(request, hooks);
      onReply(base.id, reply.usage ?? {});
      return reply;
    },
    ...(generateText ? {
      generateText: (part) => generateText({
        ...part,
        onUsage: (used) => {
          onReply(base.id, used);
          part.onUsage?.(used); // the question's own count
        },
      }),
    } : {}),
  };
}
```

`reply.providerUsage` of each chat request is the provider's own usage object, for the fields the
totals do not have. More on wrapping an adapter: [your own adapter and loop](./own-adapter-and-loop.md).

## What costs most

### Whole-file reads

- **A read sends the whole file once**, in parts of up to `mapChunkTokens` (and 80% of
  `maxRequestBytes`), each line with its number. When the notes of the parts together are larger
  than one part, it first merges them, in up to 8 rounds of merge requests. Then it writes an
  answer. Its input is about the size of the file, and more for a file of many short lines. The
  notes of a part may be up to 4,096 output tokens and the answer up to 8,192. For a model that
  spends such a limit thinking, both are raised to 32,768.
- **With the defaults, one read can cost about 3,000,000 input tokens**: a file of up to 30 parts
  of 100,000 tokens may be read whole. A file that needs more parts is not: its card says that it is
  too large to be analyzed whole, and the tool is not offered when no file of the question can be
  read whole.
- **Parts are read four at a time**, by the explorer model when there is one.

What bounds it:

- `limits.wholeDocumentReads` (1 per document by default), `wholeDocumentAnalysis: false`, and
  `limits.inputTokens` and `limits.requests`, which refuse a read that would pass them.
- With your own loop, the same cap is `maxWholeDocumentReads` of `files.tools()`
  (`MAX_WHOLE_DOCUMENT_READS`, 1, by default), counted per tool set: make one for each question
  ([your own adapter and loop](./own-adapter-and-loop.md)).
- `budget.maxMapChunks`: with 10, only files of up to about 1,000,000 tokens are read whole at the
  default part size.
- `budget.mapChunkTokens`: smaller parts give more detailed notes, and more requests, notes and
  merges. The input of the parts is the file either way. With `maxMapChunks` it also sets the
  largest file that is read whole.
- For a model that thinks, less thinking in the part reads: `analysisConfig` of `gemini()` and
  `askGemini`, `analysisBody` of `openAiCompatible()` and `anthropic()`. See
  [Vertex AI and Gemini](./vertex-and-gemini.md).

### Long tool loops

Each chat request sends everything before it. One tool result may be up to `toolResultCharacters`
(24,000 characters, about 12,000 tokens of a log), up to 8 run in a turn, and every result stays in
the requests until the answer. Text tool results may fill the window up to
`contextTokens − reservedTokens / 2`: 968,000 tokens with the default budget. So the bound with the
defaults is 12 requests of up to about 968,000 tokens each, about 11.6 million input tokens, plus a
whole-file read of each document searched. A question of a few searches and reads is far from that
bound: [measurements](../measurements.md) has live numbers.

What bounds it: `limits.toolTurns` and `limits.callsPerTurn`; `limits.inputTokens`;
`budget.toolResultCharacters` (smaller results, though the model may then need more reads); and an
explorer model, which makes these requests at its own price.

### Pages of PDFs

- **One `view_pages` call shows up to five pages** (`MAX_VIEW_PAGES`). A page costs about 530
  tokens on Gemini, 1,000 on an OpenAI-compatible model and 3,500 on Claude by default (the
  adapter's `pageTokens`). An OpenAI-compatible model is shown pages only with `pdfInput: true`.
  Without it, `openAiCompatible()` declares `toolFiles: "none"`, and `view_pages` is offered to no
  model of the question.
- **Pages stay in every later request of the question**, so a page shown early is paid for again
  by each request after it. They are not kept in `toolTurns`, so a later question does not pay for
  them again.
- **A question shows pages up to half of `reservedTokens`**, counted with the largest `pageTokens`
  of its models: 60 pages on Gemini with the default budget, 32 on an OpenAI-compatible model with
  `pdfInput`, 12 on Claude with the library's default window. The size of the request in bytes
  bounds them too.

What bounds it: `viewPages: false`; `keepOriginals` only for the formats that need it (no kept
original, no pages); a smaller `reservedTokens`, which also keeps less of the window free for the
answer (text tool results may then grow the request further). See [PDFs](./pdfs.md).

### Documents sent whole

Up to `inlineTokens` (200,000 by default) of document text goes into every chat request of the
question, and into every later question that names the same documents. Prompt caching makes the
repeats cheaper ([below](#prompt-caching)).

- A lower `inlineTokens` sends fewer documents whole. Each request is then smaller, but the model
  needs tool turns to read what is searched: a question that one request answers from a document
  sent whole can take several when the document is searched.
- Name in `documentIds` only the documents a question is about. Each one named is planned: sent
  whole, or given a card.

### An explorer model

With an explorer, the requests of the tool loop and the part reads go to a cheaper model, and the
model you chose for its answers is called once, with what the tools returned. A question that uses
the tools takes one request more. When that pays off: [explorer model](./explorer-model.md).

## Prompt caching

A provider's prompt cache bills the start of a request it has seen recently at a lower rate, and
reports it in `cachedInputTokens`. The library keeps the start of the requests of a chat the same:

- **`documentPlacement: "first"`** (the default) puts the documents and cards at the start of the
  first user turn, where they stay as the conversation grows, so every later request and every
  follow-up question can read them from the cache. `"last"` appends them to the latest user turn:
  they move with every question and are billed in full each time. In a live test with Gemini, 96%
  of the input of a follow-up question was cached with `"first"`, against 0% with `"last"`
  ([measurements](../measurements.md)).
- **Notes are not kept.** The note sent after an empty or broken turn, which asks the model to try
  again, is in that one request only, and so is the note of the answer's second try. (When the
  model that makes the tool calls has a conversation that may only grow, such as Claude, it keeps
  the note of a broken tool turn.)
- **The request for the answer adds its line at the end.**

What you keep the same:

- **Your system instruction.** It comes first in every request, before the tool guide. A date, a
  time or the user's question in it changes the start of every request, and nothing is read from
  the cache. Put such things in the user's turn instead.
- **The documents, in the same order.** Their text and cards are in the order of `documentIds`.
  Pass the same IDs in the same order. A document added to the chat changes the first user turn,
  and the cache misses from there, once.
- **The history.** A turn you change or drop changes the request from that turn on
  ([conversations](./conversations.md)).

What the library changes:

- A document that went whole can become a card as the history grows (above). The tool guide, which
  names the files that are searched, changes with it.
- Within a question, when room runs short, older tool results are replaced by short stand-ins. The
  request changes from the first round replaced. A model whose conversation may only grow (Claude)
  has nothing of the question replaced. Since 0.9.0 the stored rounds of earlier questions are
  replaced before the first request when they make it larger than its room, for every model: the
  request changes from the first stored round replaced, as it did in 0.8 after the provider refused
  the request, but without the refused request.
- The tool rounds of an earlier question are not sent as they were in their own question, for two
  reasons. Their results go without `tool_turns_left`. And their model turns go as the calls alone:
  a stored round keeps no thought signatures (Gemini) or thinking blocks (Claude), which the
  requests of its own question sent back. So the first request of a follow-up question differs
  from the requests of the question before it from that question's first tool round on, and the
  cache misses from there, once in each follow-up question: those rounds are billed at the full
  price in that request (with Claude's `cache_control`, as a cache write). The rounds of older
  questions were already sent that way, and still match. The documents and cards before them are
  still read from the cache. Pages up to 0.8.2 named `tool_turns_left` alone; with a model that
  thinks, the signatures make the miss on their own. Keeping the model's own turns is planned for
  0.10.0.
- An upgrade that changes the library's prompts misses the cache once in each conversation. 0.6.0
  changed the tool guide, the descriptions of `search_document` and `analyze_whole_document`, and
  the frame lines of a file sent whole. The first request after the upgrade shares with what 0.5.0
  sent at most what comes before the first text that changed. For a question with files to
  search, that is nothing on Claude and OpenAI-compatible endpoints, where the tools come first,
  and at most your own system text on Gemini, where the tool guide follows it in the system
  instruction. For a question whose files are all sent whole, it is your own system text, and
  `view_pages` with its guide when the pages of a PDF can be looked at. From then on the frame of a
  document is the same in every request
  ([Deployment](./deployment.md#servers-of-two-versions)).

The adapters:

- `anthropic()` asks for caching: `cache` is `true` by default (five minutes), `"1h"` for an hour,
  `false` for none. See [Claude](./anthropic.md).
- `gemini()` and `openAiCompatible()` send no cache settings. What the provider caches on its own
  is reported in `cachedInputTokens`.

## Related pages

- [`llm-large-files` reference: the tool loop](../reference/ask.md): `AskLimits`, `AskResult`,
  `UsageTotals`, `ModelCapabilities`.
- [`llm-large-files` reference: the library](../reference/library.md): `Budget`, `DEFAULT_BUDGET`,
  `resolveBudget`, `ModelLimits`, `budgetFor`.
- [Tools reference](../reference/tools.md): what each tool returns, `MAX_VIEW_PAGES`,
  `MAX_WHOLE_DOCUMENT_READS`.
- [An explorer model](./explorer-model.md), [Vertex AI and Gemini](./vertex-and-gemini.md),
  [OpenAI-compatible endpoints](./openai-compatible.md), [Claude](./anthropic.md).
- [Errors and reliability](./errors-and-reliability.md): requests too large, retries,
  `partialResultOf`.
- [Conversations](./conversations.md): history, `toolTurns`, keeping the window.
- [How it works](../how-it-works.md): the room in the request and how the plan is made.
