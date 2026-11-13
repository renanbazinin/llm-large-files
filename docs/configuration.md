# Configuration

## Budget

The budget describes **your model connection**. Set the real numbers of your connector; the
planner uses them to decide what goes into a request whole.

| Setting | Default | What it controls |
|---|---|---|
| `contextTokens` | 1,000,000 | The model's context window. |
| `maxRequestBytes` | 10,000,000 | The largest request body your connector accepts. Checked separately from tokens: non-English text and JSON escaping make bytes run ahead of tokens. |
| `inlineTokens` | half the window, 200,000 at most | The most document text sent whole in one request. Lower it to cut cost and latency; raise it to rely on the long context more. |
| `reservedTokens` | a quarter of the window, 64,000 at most | Kept free for the answer, tool results, and growing history. |
| `mapChunkTokens` | half the window, 100,000 at most | Part size when a whole file is read in parts. Smaller parts give more detailed notes but more model calls. |
| `maxMapChunks` | 30 | Refuse whole-file reads needing more model calls than this. 30 parts × 100K tokens = 3M tokens of input. |
| `toolResultCharacters` | 12% of the window, 24,000 at most | Cap on one tool result, in characters. For a log that can be 12,000 tokens. |

For a model with a smaller window, setting the window is enough: the rest follows it.

```ts
createLargeFiles({ store, budget: { contextTokens: 128_000, maxRequestBytes: 4_000_000 } });
// → inlineTokens 64,000 · reservedTokens 32,000 · mapChunkTokens 64,000 · toolResultCharacters 15,360
```

A field you set stays as you set it. Values that cannot work together are an error when the
library is created: `reservedTokens` or `mapChunkTokens` at or above `contextTokens`.
`resolveBudget(partial)` gives the whole budget for any set of fields.

### One library, several models

The budget of a question is the library's, made to fit the model that is asked. An adapter can say
what its model takes:

```ts
const small = openAiCompatible({ baseUrl, apiKey, model: "small-model", contextTokens: 128_000 });
const result = await askWithFiles({ files, model: small, documentIds, messages });
result.budget; // the library's budget, fitted to a window of 128,000 tokens
```

- The smaller window holds: the library's `contextTokens`, or the model's. With an explorer, the
  smallest of the three. The same for `maxRequestBytes`.
- Fields the library left open follow that window. Fields it set are kept, and lowered if they are
  too large for it.
- `outputTokens` of a model is kept free on top: Claude counts `max_tokens` against the window.
- `tokenScale` is how many of the model's tokens one token of the library's estimate comes to. The
  estimate is fitted to Gemini, so that is 1 there. For a tokenizer that counts more (the Claude
  adapter says 1.35), the window is that much smaller in the library's terms.
- `budget` in `askWithFiles` (and in `prepare` and `tools`) changes fields for one question:
  `budget: { inlineTokens: 20_000 }`.

### Limits and retries

What one question may do, in `limits` of `askWithFiles` and `askGemini`:

| Limit | Default | |
|---|---|---|
| `toolTurns` | 12 | Chat requests for one question, counting the answer. |
| `callsPerTurn` | 8 | Tool calls of one model turn that are run. The others are answered "send it again if you still need it". |
| `wholeDocumentReads` | 1 | How often each document may be read whole. One read is up to `maxMapChunks` requests. 0 refuses them all. |
| `inputTokens` | none | Once the question has used this many input tokens, over all its requests, the next request is the answer. A whole-file read that would pass it is refused with the numbers. |
| `requests` | none | The same, for the number of requests: the chat's and the part reads' together. |

```ts
await askWithFiles({ files, model, documentIds, messages, limits: { toolTurns: 8, inputTokens: 2_000_000 } });
```

A request that failed is sent again when another try can help: HTTP 408, 409, 429 and 5xx, and a
connection that failed. It waits 0.25 to 0.5 seconds, then twice and four times that, or as long as
the provider asks (`Retry-After`, or the `retryDelay` of Gemini's `RetryInfo`). It is not sent
again once text of the reply was shown, after you stopped the question, or when the provider asks
for a longer wait than `maxDelayMs`. The part reads of a whole-file read follow the same rule.

```ts
retry: { retries: 3, baseDelayMs: 500, maxDelayMs: 60_000 }  // the defaults; retries: 0 turns it off
```

### Room in the request

Every tool result stays in the conversation until the question is answered, and is sent again with
each later request. The loop counts the request as it grows, by the library's estimate and, once
the provider has answered, by the provider's own count:

- Before the calls of a turn run, each is given the room that is left, up to
  `toolResultCharacters`. A result is cut to its room and says where to go on.
- When the room runs short, the results of all but the last three tool rounds are replaced by
  stand-ins: `{ document, dropped: true, lines: "1-212", note: "… Read them again with
  read_document if you need them." }`. `steps` then holds "Older tool results were shortened to
  make room in the request". Claude's conversation is never rewritten, so this step is skipped for
  it.
- A call that still finds no room is answered "no room left, answer now", and the next request is
  the answer.

Text tools may fill the window up to half of `reservedTokens`; the other half is the answer's.

### How the plan is made

For each request, `prepare(ids, base)` takes the size of everything else (`base.tokens`,
`base.bytes`) and fills the room left, smallest documents first:

- token room = `min(inlineTokens, contextTokens − reservedTokens − base.tokens)`
- byte room = `maxRequestBytes − 256 KB − base.bytes`

A document is sent whole if it fits both. Otherwise it becomes searchable.

### Token estimates

`estimateTokens` prices each kind of character, because characters per token depends on the kind
of text. As counted by Gemini:

| Text | Characters per token |
|---|---|
| English prose | 4.3 to 5.0 |
| Source code | 3.5 to 4.1 |
| Hebrew, Arabic, Russian prose | 2.1 to 3.3 |
| Chinese, Japanese, Korean prose | 1.4 to 1.7 |
| Logs (timestamps, IDs, IP addresses) | 1.4 to 2.8 |
| CSV of numbers, hex dumps, base64 | 1.0 to 1.4 |

Digits cost about one token each, which is why a log is three times denser than a novel of the
same size. The estimate was fitted to Gemini's `countTokens` on 60 texts (Gemini 2.5, 3.5, and 3.8
count identically) and lands between 0.98 and 1.7 times the real count. It leans high on purpose:
overestimating only makes a file searchable a little sooner. The one kind of text it still counts
low, at about 70%, is a long run of random letters in one case with no digits.

Tokenizers differ between providers. These weights are fitted to Gemini, which counts digits one
by one. A tokenizer that groups digits will count fewer tokens than this estimate for logs and
data, which is the safe direction.

## An explorer model

The model is yours to choose: it is the `model` you give `geminiApi()` or `vertexAi()`, or the URL
of your own endpoint. The package has no default. That one model does both halves of the work on a
large file: it explores the file (searches, reads, looks at pages), and it answers.
`explorerModel` names a second model for the first half:

```ts
const endpoint = geminiApi({
  apiKey,
  model: "gemini-3.8-flash",                        // writes the answer
  explorerModel: process.env.GEMINI_EXPLORER_MODEL, // optional: searches and reads
});
// vertexAi({ project, model, explorerModel, accessToken }) takes it the same way.
```

Left out, empty, or the same as `model`, there is no explorer, and `askGemini` sends exactly the
requests it sent before. So a setting that may be unset can be passed as it is.

With URLs of your own, give the explorer's as `explorerUrl`. It is called with the same headers:

```ts
const endpoint = {
  url: "https://llm-gateway.corp.example/gemini/models/gemini-3.8-flash:generateContent",
  streamUrl: "https://llm-gateway.corp.example/gemini/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
  explorerUrl: "https://llm-gateway.corp.example/gemini/models/gemini-3.5-flash-lite:generateContent",
  headers,
};
```

The reason to use one: a question about a large log can take ten requests of searching and
reading, each larger than the one before, and a whole-file read adds up to 30 part reads. With an
explorer those go to a cheaper or faster model, and the model you chose for its answers is called
once.

### Who does what

| | The explorer | `model` |
|---|---|---|
| Requests with tools: `search_document`, `read_document`, `get_document_overview`, `view_pages` | All | None |
| The part reads of `analyze_whole_document` | All | None |
| The answer | | One request, without tools |
| A question about files that are sent whole, with no pages to look at | Not called | One request, as before |

The answering model gets the conversation, the explorer's tool calls, and what each call
returned, pages included. It does not get the explorer's thoughts, its thought signatures, or
anything it wrote: the answer is written from what the files say, not from what the explorer made
of them. So the answering model can use only what the explorer fetched. It has no tools of its own
to fetch more.

The explorer is told its part, in a line added to its system instruction (`EXPLORER_INSTRUCTION`):
gather what the answer needs, then reply `DONE`. `gemini-3.5-flash-lite` did exactly that, at one
output token. A model that writes an answer anyway (`gemini-2.5-flash-lite` did) costs those output
tokens, and its answer is dropped.

### What changes for your application

- **One request more.** The answer is always a request of its own, so a question that one model
  settles in three requests takes four. `maxToolTurns` still counts them all: the explorer has
  `maxToolTurns − 1` requests, and the last one is the answer.
- **`text` and `onText` carry only the answer.** Without an explorer, a remark that the model makes
  before a tool call ("Let me search…") is part of `text`. The explorer's words are not shown.
  `onActivity` and `onStep` report its tool calls as before, and `turns` counts its requests too.
  `usage` is the total of both models, with an entry for each in `usage.byModel`; `finishReason`
  and `lastUsage` are those of the answer.
- **The explorer need not be a Gemini model.** With `askWithFiles`, `explorer` is any adapter:
  `askWithFiles({ model: gemini(…), explorer: openAiCompatible(…) })`. The answering model gets
  the explorer's calls and results in its own provider's form.
- **The explorer's requests are not streamed.** Nothing it writes is shown, so each goes to
  `explorerUrl` in one piece. The answer streams as before.
- **Settings are per model.** `explorerGenerationConfig` is the explorer's `generationConfig`, and
  defaults to yours. Set it when the two models do not take the same settings: given a
  `thinkingLevel`, `gemini-2.5-flash-lite` on Vertex AI answers HTTP 400, "thinking_level is not
  supported by this model". `analysisConfig` is for the part reads, which the explorer does, so
  write it for the explorer.
- **The budget has to fit both models.** Both get the same conversation and the same tool
  results. Set `contextTokens` and `maxRequestBytes` to the smaller of the two.
- **Pages have to be readable by both models.** `toolFilePlacement: "inside"` is read by Gemini 3
  models only. If either model is Gemini 2.5, use `"beside"`, which both read
  ([below](#where-the-pages-go-toolfileplacement)).
- **An explorer that fails is an error.** A model name that does not exist, or a quota that is
  used up, throws `GeminiRequestError`, as it does for `model`. The question is not passed to
  `model` instead: that would hide the mistake, and send the searching to the model you wanted to
  spare.
- **A PDF whose text is in the prompt**, and whose pages can be looked at, goes to the explorer
  first: it decides whether to look. The text of such a PDF is then sent twice, once to each model.

```ts
await askGemini({
  files, endpoint, messages, documentIds,
  generationConfig: { thinkingConfig: { thinkingLevel: "high" } },   // for `model`
  explorerGenerationConfig: { thinkingConfig: { thinkingBudget: 0 } }, // for a Gemini 2.5 explorer
  toolFilePlacement: "beside",                                       // one of the two is Gemini 2.5
});
```

### Live results with an explorer

Flash-Lite models, November 2026, through `ingest` and `askGemini`. The log has 6,000 lines, 24
deadlocks and one fatal error. The PDF is the one with a chart and a photo from
[Pictures in PDFs](#live-results).

| Explorer → `model` | Question | Result |
|---|---|---|
| `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`, Gemini API | How many deadlocks, and the line of the first | Two searches, then `DONE`. Answer right. Four requests, 3 s. |
| | What shut the gateway down, its error code, the warning before it | One search, then `DONE`. Four of four facts, with the right lines. |
| | The name of the file and its line count, which the card shows | `DONE` at once. Answered from the card, in two requests. |
| | Every kind of error, from a whole-file read | The explorer read the four parts and wrote up the notes, then searched three times. Answer right. |
| | The chart and the photo, with the text sent whole | The explorer looked at two pages. The other model got them and had five of five facts right. |
| | The same, with the PDF searched | A read and a look in one turn. Five of five. |
| | The gateway and the chart again, both models thinking (`thinkingLevel: "high"`) | Both right. |
| `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite`, Gemini API | The deadlocks | Answer right. The explorer repeated one search until its eleven requests were used up, as it does when it works alone. |
| `gemini-2.5-flash-lite` → `gemini-3.5-flash-lite`, Vertex AI | The deadlocks, the gateway, and the chart with pages `"beside"` | All right. This explorer wrote an answer each time instead of `DONE`. |
| `gemini-3.5-flash-lite` → `gemini-2.5-flash-lite`, Vertex AI | The deadlocks, the chart with pages `"beside"`, and the card | All right. |
| `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite`, Vertex AI, both thinking | The gateway | Right. |

What made the form of the handoff: a Gemini 3 model refuses a request that ends with the result of
a function call it did not sign (HTTP 400, "Function call is missing a thought_signature"), and a
thought signature belongs to the model that made the call. When a user message follows the
results, the same calls are accepted without a signature: by Gemini 3.1 and 3.5 Flash-Lite on the
Gemini API and on Vertex AI, and by Gemini 2.5 Flash-Lite on Vertex AI. So the answering model's
request always ends with a user message, and holds no signatures.

Not checked: models larger than Flash-Lite, and Gemini 4. The two models have to be reachable with
the same headers, so one cannot be on the Gemini API and the other on Vertex AI.

## Stores

| Store | Use it for |
|---|---|
| `MemoryDocumentStore` | Tests, scripts, one-instance demos. Lost on restart. |
| `FileDocumentStore(dir)` | One server or a shared volume. Survives restarts. |
| Your own | Several instances: implement the interface below over Redis, S3, or a database. |

```ts
interface DocumentStore {
  put(document: { meta: DocumentMeta; text: string }): Promise<void>;
  get(id: string): Promise<{ meta: DocumentMeta; text: string } | undefined>; // undefined if expired
  getMeta(id: string): Promise<DocumentMeta | undefined>;
  delete(id: string): Promise<boolean>;                       // the original file and the index too
  sweep?(now?: Date): Promise<number>;
  putOriginal?(id: string, bytes: Uint8Array): Promise<void>; // optional: see below
  getOriginal?(id: string): Promise<Uint8Array | undefined>;  // undefined if not kept, or expired
  // Optional: read large documents by range instead of loading them whole (see below).
  readTextRange?(id: string, start: number, end: number): Promise<Uint8Array | undefined>; // UTF-8 bytes
  putIndex?(id: string, index: Uint8Array): Promise<void>;
  getIndex?(id: string): Promise<Uint8Array | undefined>;
}
```

Keep `getMeta` cheap (store the metadata separately from the text): it is called on every tool
call. A document ready to search is kept in memory between tool calls, within `cacheBytes`
(default 256 MB, the least recently used dropped first; `cacheSize` caps the number of documents too). Every
use of a kept document asks the store first, so a document deleted or expired anywhere is gone
everywhere at once.

### Large files, many users, several servers

With a store that has `readTextRange`, as `FileDocumentStore` does, a document whose text is larger
than `wholeDocumentBytes` (default 2 MB) is never loaded whole:

- At ingest, a line index is written next to the text (`<id>.idx`, four bytes a line: 3 MB for a
  file of 730,000 lines). `read_document`, the card and the overview read only the lines they show.
- A search reads the text 1 MB at a time (`scanChunkBytes`), reading the next piece while it searches
  the current one, so a search holds a few MB whatever the size of the file. At most
  `maxConcurrentScans` searches (default 4) run at once in a process; the others wait their turn,
  and those waiting for the same file share one pass over it: it is read, decoded and lowercased
  once for all of them. Results are the same as from the whole text: the tests compare them call by call.
- Decoded pieces of a file are kept in the same `cacheBytes` budget, so the next search of a file in
  use reads nothing. A file whose decoded text would take more than a quarter of the budget is never
  kept: it would push out everything else. A larger `cacheBytes` spends memory to save CPU.
- A document from an older version, without an index, gets one the first time it is used: it is
  built from the text in one pass and saved for the other servers. A damaged index, or one that
  does not match its document, is noticed and built again.

Smaller documents are loaded whole and kept in the cache: for them that is faster, and they are small.
`wholeDocumentBytes: Infinity` loads every document whole, as before 0.4; `0` reads every one by range.

`FileDocumentStore` on a volume that several servers share:

- Every file is written under a temporary name and then renamed, so no server reads half a file.
- `sweep` removes files of no document (an upload that failed, a server that stopped while writing)
  and temporary files once they are an hour old (`orphanAgeMs`), never younger ones: they may be an
  upload in progress on another server. Run `sweep` from one place, such as a scheduled job.
- A document whose metadata could not be read during a sweep (the volume did not answer) is left
  alone, whatever its age. Only metadata that is not valid is taken for a broken document.
- A read that fails for another reason than "no such file" is thrown, and the library passes it
  on as `DocumentStoreError`: a busy volume is not a deleted document. A store of your own should
  do the same: return `undefined` only for a document that is not there.
- Servers of an older version on the same volume (during a rolling update) read the same files and
  ignore the index. An index left behind when one of them deletes a document is swept an hour later.

A store of your own can do the same over S3 (`Range` requests), Redis (`GETRANGE`) or a database:
add `readTextRange`, and `putIndex` with `getIndex` to keep the index. Without `putIndex` the index
is built in memory each time the document is opened.

### Keeping the uploaded file

By default a store holds only the text of a document. `keepOriginals` also keeps the uploaded file,
which is what [showing pages of a PDF](#pictures-in-pdfs) needs:

```ts
createLargeFiles({ store: new FileDocumentStore(dir), keepOriginals: ["pdf"] });
```

- It is off by default because it costs disk: a kept file is as large as the upload (up to
  `maxUploadBytes`, 100 MB) and stays until the document expires or is deleted.
- `FileDocumentStore` writes it as `<id>.bin` next to `<id>.txt` and `<id>.json`.
  `MemoryDocumentStore` keeps a copy in memory.
- A store of your own keeps originals when it has `putOriginal` and `getOriginal`. `putOriginal` is
  called before `put` for the same ID, and `delete` and `sweep` must remove the file. A store
  without the two methods works as before: nothing is kept, and `view_pages` is not offered.
- `DocumentMeta.originalKept` says whether a document's file is kept. `files.getOriginal(id, { owner })`
  returns it.
- Documents ingested before you turned it on have no original. Upload them again to get one.

## Formats

| Format | Detected by | Notes |
|---|---|---|
| `log` | `.log`, `.out`, `.err`, or text whose early lines mostly start with a timestamp or level | Gets a log profile |
| `markdown` | `.md`, `.markdown`, `text/markdown` | Headings form the outline |
| `json` | `.json`, `.jsonl`, `.ndjson` | Minified JSON is wrapped into addressable lines |
| `csv` | `.csv`, `.tsv` | |
| `pdf` | `.pdf` | Needs `unpdf`. Pages are marked `--- Page N ---`, tables are rebuilt (below), and a page without text says so. With `@cantoo/pdf-lib`, a page that shows a picture says so too, and the model can be shown the page itself ([Pictures in PDFs](#pictures-in-pdfs)). A scanned PDF (no text layer at all) is rejected, unless its original is kept and it has at most 30 pages. |
| `docx`, `pptx` | extension or MIME type | Needs `jszip`. Slides are marked `## Slide N`. A text box is read once, after the paragraph it is anchored in. A file that unpacks to more than 100 times its size (past the first 16 MB), or to more than 128 MB of XML, is rejected as a possible zip bomb. |
| `text` | anything else that decodes as text | UTF-8 or UTF-16 (with or without BOM); binary is rejected |

Lines longer than 2,000 characters are split, so every line can be read by number.

### PDF tables

A PDF stores no tables, only text at positions. Read in file order, a row with an empty cell looks
like a row without that column: `EMEA 80 95 101` under the headings `Q1 Q2 Q3 Q4`, and a model
reads 95 as Q2. The PDF extractor finds tables by the position of their text and writes each row
with its cells marked, so the same row becomes:

```
| Region | Q1 | Q2 | Q3 | Q4 |
| EMEA | 80 |  | 95 | 101 |
```

In a live test (`gemini-3.5-flash-lite`, 110 questions about single cells of seven PDFs made by
Word and Chrome, half of them about empty cells), 44 answers were right from the text in file
order and 110 from the rebuilt rows.

What it handles: empty cells, tables inside one column of a two-column page, right-to-left tables
(the first column is the rightmost), tables printed sideways, rotated pages, footnote marks,
headings that span columns, and cells whose text wraps onto several lines when the rows are
visibly spaced apart. Text that is not a table (paragraphs, lists, columns of prose, justified
text) is left as pdf.js gives it.

It is cautious: where the evidence for a table is weak, the text stays as it was. So:

- Two-column tables (key and value, a glossary) are left as lines of text. They read correctly
  that way.
- When a cell wraps and the rows have no extra space between them, each line of the cell is a row
  of its own, with the other cells empty.
- Columns that are closer together than a word space on every line of the table stay together in
  one cell, on every row alike.
- A table whose text is stored column by column in the file is not rebuilt.
- Pictures and charts are not in the text. A page with no text at all is written as
  `[No text on this page. It may be a scan, a photo, or a chart.]`, so the model can say that it
  cannot see it. To let the model look at such pages, see [Pictures in PDFs](#pictures-in-pdfs).

The cell marks cost tokens: about one per cell. A bank statement came to 27% more tokens than
its text in file order, a report with one table in it to 9% more. Reading 600 pages with 24,600
table rows took 1.6 seconds instead of 1.3.

The rules were tuned on PDFs made by Chrome and by Word. To get the text of version 0.1.0 instead:

```ts
import { createLargeFiles, createPdfExtractor } from "llm-large-files";

createLargeFiles({ store, extractors: { pdf: createPdfExtractor({ tables: false }) } });
```

Small PDFs are still better sent to Gemini as the file itself, when your payload limit allows:
it then sees every page, including pictures. For a PDF that is too large for that, the next section
gives the model the pages it asks for.

## Pictures in PDFs

The text of a PDF does not hold its photos, charts and diagrams. Asked about a bar chart from the
text alone, a model can only say that it cannot see it, or guess. Two things, both optional and
both for PDFs only, close that gap:

1. **A line in the text that says where the pictures are.**
2. **A tool, `view_pages`, that hands the model the real pages** as a small PDF, when it asks.

```bash
npm install @cantoo/pdf-lib      # optional dependency, needed for both
```

```ts
const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"],        // needed for view_pages: it cuts pages out of the uploaded file
});
// askGemini then offers view_pages by itself. Nothing else changes in your code.
```

### The line that marks a page

At ingest, a page that shows a picture or a drawing gets one line under its header:

```
--- Page 12 ---
[Picture on this page. This text cannot show it.]
Figure 3: sales by region.
```

The words hold whether or not the model can look at the page later. A search for
`[Picture on this page` lists every such page.

What counts:

- **A picture:** the images on the page cover 3% of it or more, measured by the size they are
  shown at, not by their pixels. A logo covers about 1%. An image that is on 30% of the pages (and
  on three at least) is taken for a logo, a letterhead or a watermark, and does not count,
  whatever its size.
- **A drawing:** shapes filled in three or more colours, outside the tables. Greys, rules, dots
  and page backgrounds do not count, and neither does the shading of a table's cells.
- A page whose drawing instructions are larger than 2 MB: that is a map or a technical drawing.
  So is a page that paints more than 20,000 images, or whose instructions come to more than 16 MB
  once each form (a drawing kept apart and painted by name) is counted every time it is painted.
  Reading such a page stops there, so a few kilobytes of forms painted inside forms cannot hold
  the server.

What it gets wrong:

- Missed: a chart in one or two colours, and a chart or diagram drawn only with lines.
- Marked by mistake: a table with cells shaded in three colours, when the table itself was not
  recognised (a table of two columns, for example).

The mark is a hint. `view_pages` works on any page, marked or not, and in a live test the model
looked at a one-colour chart that had only a caption (below).

The pages are found from the structure of the file, without decoding any image, so it is cheap:
a PDF of 200 photos (85 MB) took 0.3 s to ingest without marks and 0.8 s with them. No page is
marked, and the text is exactly that of version 0.2.0, when:

- `@cantoo/pdf-lib` is not installed;
- you turn it off: `createPdfExtractor({ pictures: false })`;
- the file declares more than 150,000 objects (reading it would take over two seconds), reading
  took more than five seconds, or the file does not have the pages the text was read from.

One cost to know: a PDF whose streams do not state their length up front (Ghostscript writes them
so) is scanned byte by byte, about 30 ms per MB. A file of 100 MB written that way took 3 s to
ingest instead of 0.1 s.

### `view_pages`

`view_pages(document_id, from_page, to_page)` cuts those pages out of the kept original and
returns them as one PDF. `askGemini` puts it inside the function response, and Gemini reads it
like any PDF: text, pictures and layout.

It is offered for every PDF whose original is kept, also for one whose text is already in the
prompt: a slide deck of photos has little text, so its text fits, and without the tool the model
would see none of its slides. Such a PDF gets `view_pages` and no search tools.

For a PDF that the model can look at, search and read results also say which page a line is on
(`"page": 12`), since a page number is what `view_pages` takes.

Limits:

| Limit | Value | When it is reached |
|---|---|---|
| Pages per call | 5 | The result says where to continue (`next_page`). |
| Bytes | What is left of `maxRequestBytes`, less a tenth kept free (256 KB at least), times 3/4 for base64 | Pages are left off the end of the call. A page that does not fit by itself gives an error, and the model answers from what it has. |
| Pages per question | `reservedTokens / 2 / 530`: 60 with the default budget | The tool says that no more pages can be looked at. |

Pages stay in the request until the question is answered, so every look makes the later requests
of that question larger. They are not sent again with the next question.

A page costs Gemini about 530 tokens, whatever is on it: 532 for each of 1, 2, 3 and 5 A4 pages,
and 527 for a 16:9 slide (`gemini-3.5-flash-lite`).

A cut holds the pages asked for and little else. Copying pages the simple way does not: a contents
page links to every section, and those pages came along, so the cut was 89% of the file. Here every
other page is emptied before copying, and a page that shares its resources with the whole file
(FPDF, TCPDF and jsPDF write PDFs that way) gets a list of its own.

| File | Pages cut | Size of the cut |
|---|---|---|
| Chrome, 72 photos, 100 MB | 5 | 7.0 MB (7%) |
| PowerPoint deck, 40 photos, 9.9 MB | 5 | 1.2 MB (13%) |
| Word report with a contents page, 7.5 MB | the contents page | 55 KB (0.7%) |
| All images in one shared list, 12 MB | 2 | 0.6 MB (5%) |

What a cut costs the server: the whole file is read into memory on every call.

| File | Time | Memory at the peak |
|---|---|---|
| 100 MB of photos, 900 objects | 0.06 s | about 300 MB |
| 100 MB written the way Ghostscript writes | 3 s | about 300 MB |
| 54 MB, 330,000 objects (a tagged table of 591 pages) | 4 to 5 s | about 700 MB |

A file that declares more than a million objects, or more than the free memory can hold, is not
cut: the tool tells the model that the pages cannot be shown.

Also handled: PDFs encrypted only to restrict printing or copying (they open without a password),
hidden layers (they stay hidden), rotated pages, and links. Not shown: a PDF that needs a password
to open, a damaged file, and a file in which this reader counts other pages than the text
extractor did. In each case the model gets a message and answers from the text.

### Scanned PDFs

A PDF with no text at all has nothing to search, and is refused: `This PDF has no text layer`. When
its original is kept, the model can read it by looking at its pages, so a scan of **up to 30
pages** is accepted. Every page of its text says that it has no text, and the model gets
`view_pages`. A longer scan is still refused: it could only be read five pages at a time, and it
could not be searched.

```ts
createLargeFiles({ store, keepOriginals: ["pdf"], scannedPdfPages: 30 }); // 30 is the default; 0 refuses all scans
```

A PDF with text on any page was always accepted and still is, however many of its pages are scans.

### Live results

`gemini-3.5-flash-lite` on the Gemini API, November 2026, through `ingest` and `askGemini`:

| Check | Result |
|---|---|
| Which bar of a chart is tallest and shortest, and their colours; a number on a sign in a photo. Text sent whole. | Looked at 2 pages unasked. All five facts right. From the text alone, the model said it could not see the chart. |
| The same, with the PDF searched instead | One look, all five right. |
| Ten questions that the text answers, about a PDF with a photo on each of its 60 pages | 0 of 10 looked at a page, with the text sent whole and with the PDF searched. 10 of 10 right both times. |
| A chart in one colour: a caption, but no mark | The model looked at the page and read the chart correctly. |
| Five pages in one look (five numbers on five signs) | All five right. 2,660 tokens for the pages. |
| A slide deck of 41 slides: a number on slide 8, a bar on slide 1 | Two looks, both right. |
| A PDF encrypted to restrict printing | One look, all right. |
| A scan of three pages (pictures of text) | One look at the three pages. Four of four facts right. |
| The request without tools that ends a question, after a look | Accepted, answered correctly, with the pages still in it. |

**Vertex AI**, with the same model (locations `global` and `eu`, November 2026): one look, two
looks in one model turn, one look that decides the next, the request without tools that ends a
question, and a PDF that is searched. All were accepted and answered correctly, with `vertexAi()`
and through an application's own URLs, streaming and not. Real files went through too: a number
on a photo in a 7.5 MB report written by Word, and five numbers from one look at five pages of a
25 MB file (a 2.2 MB PDF in the request). A page costs 532 tokens there as well.

### Where the pages go: `toolFilePlacement`

| `toolFilePlacement` | What is sent | Gemini 3.5 Flash-Lite, on the Gemini API and on Vertex AI | Gemini 2.5 Flash-Lite, on Vertex AI |
|---|---|---|---|
| `"inside"` (default) | The PDF in the `parts` of its function response, which names it as `{ "$ref": "pages-12-14.pdf" }` | Works | Accepted and counted, but the model does not see the pages |
| `"beside"` | The function responses in one `user` turn, then the PDFs in a `user` turn of their own, each after a line that names it | Works | Works |

```ts
await askGemini({ ..., toolFilePlacement: "beside" }); // for Gemini 2.5
```

Keep the default for Gemini 3 models. Use `"beside"` for Gemini 2.5: it takes a file inside a
function response without an error, counts its tokens, and then answers that it cannot see the
page. Gemini 2.5 on the Gemini API was not checked (that model is closed to new users there), and
neither was Gemini 4.

With `"beside"` the files have a turn of their own because Vertex AI refuses a turn in which
anything follows a function response (HTTP 400, "Requests ending with a model turn are not
supported", seen with Gemini 3.5).

### Your own loop

The pages are a file, and a loop that drops the file would tell the model that pages are attached
with nothing attached. So `view_pages` is declared only when you say that your loop delivers files:

```ts
const prepared = await files.prepare(documentIds, base, { owner, viewPages: true });
const tools = files.tools(prepared.plan.searchable, { viewPages: prepared.viewable });

const { result, files: attached } = await tools.executeWithFiles(call.name, call.args, {
  maxFileBytes: Math.floor(roomLeftInYourRequest * 3 / 4), // base64 turns three bytes into four
  maxPages: pagesYouStillAllowForThisQuestion,
});
// attached: [{ name: "pages-12-14.pdf", mimeType: "application/pdf", bytes }]
// Send `result` as the tool result and each file as a PDF with it, in your provider's form.
// For Gemini, once every call of the model's turn is answered:
contents.push(...geminiFunctionResponseTurns(answers)); // answers: [{ call, result, files: attached }]
```

`tools.execute("view_pages", ...)` returns only JSON, so it answers with an error instead of
pretending. `prepared.viewable` also lists PDFs that are not searched, because their text is in
the prompt: pass it as it is.

### Custom extractors

Replace or add one per format, for example OCR for scanned PDFs, or HTML to text:

```ts
createLargeFiles({
  store,
  extractors: {
    pdf: async (bytes, { name }) => ({ text: await myOcrService(bytes), pages: undefined }),
  },
});
```

Formats come from `detectFormat(name, mimeType)`; unknown extensions use the `text` extractor.
