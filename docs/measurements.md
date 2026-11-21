# Measurements

This page gathers every live result and measurement that the documentation of this package has
quoted, each with its date, the version of the library, the models and the setup. Read it when you
choose a model or a setting, or want to know what has been run against a real provider and what
has not.

Each result is a measurement at one point in time, with the models named. It is not a guarantee.
Another model, a later version of the same model, another provider or other files can give other
results. Nothing was run again for this page: each result is given as it was recorded, with the
release it was recorded for. Before you rely on a number, check it on your own files
([Measuring your own setup](#measuring-your-own-setup)).

## How to read this page

- **Live** means against a real model provider. The other numbers are timings, sizes and counts
  from the library's own runs; the record says when one was taken against a fake model or in a
  probe that reproduced a fault, and so does this page.
- **Version** is the release a result was recorded for. 0.1.0 is of 2026-11-06, 0.2.0 and 0.3.0 of
  2026-11-10, 0.3.5 and 0.3.6 of 2026-11-11, 0.4.0 of 2026-11-12, and 0.4.1 and 0.5.0 of
  2026-11-13. The checks of 0.6.0 and 0.6.1 are of November 2026. All live results are of
  November 2026.
- Where the record names no model, this page says "model not recorded".
- What a result led to in the library is explained in the guides. This page links to them and does
  not repeat them. The [changelog](../CHANGELOG.md) records 0.6.0 and 0.6.1, and links to the
  history of 0.1.0 to 0.5.0.
- **Before** in a table of 0.6.1 is the code of 0.6.1 before the change measured, which was never
  released, unless the table names 0.6.0.

## What has been run live

| Provider | Live runs on record | Not run live |
|---|---|---|
| Gemini API: `askGemini`, `gemini()`, `geminiApi()` | From 0.1.0 to 0.5.0: large files, pages of PDFs, explorer pairs, follow-up questions | Gemini 2.5 with pages (`toolFilePlacement`) and in explorer pairs: it is closed to new users on the Gemini API |
| Vertex AI: `vertexAi()` | 0.3.0: pages of PDFs, in the locations `global` and `eu`. 0.3.5: explorer pairs. 0.6.0: a count, a repeated search, the error of a request too large, and in the review of 0.6.0 a production log of 3 MB | |
| OpenAI-compatible: `openAiCompatible()` | 0.5.0: Gemini's OpenAI layer only | Every other server: OpenAI, Azure OpenAI, DeepSeek, OpenRouter, vLLM, Ollama, LiteLLM, llama.cpp. The adapter is tested against fake servers. `pdfInput` was never run to an answer: Gemini's OpenAI layer refuses its `file` part (HTTP 400), it was not run against OpenAI itself, and it follows OpenAI's documented shape untested |
| Claude: `anthropic()` | None | The whole adapter. It is tested against the request and response shapes of the Messages API documentation |

Also live on Gemini, with the record not saying whether on the Gemini API or on Vertex AI: Gemini
ignoring `mode: "NONE"` (0.1.0), counting and listing (0.2.0), PDF tables (0.2.0), the prompt cache
(0.2.0), the usage of a run of 0.4.0, and models that think (0.4.1).

The models that the record names: `gemini-3.8-flash`, `gemini-3.5-flash-lite`,
`gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`, and, for whole-file reads on a model that thinks,
Gemini 4 Hydrogen. In 0.5.0, thinking Gemini models that the record does not name also ran, alone
and with an explorer. The explorer checks of 0.3.5 did not include models larger than Flash-Lite,
or Gemini 4, and the checks of pages (0.3.0) did not include Gemini 4.

The provider guides say what this means for your setup: [Vertex AI and the Gemini
API](./guides/vertex-and-gemini.md), [OpenAI-compatible endpoints](./guides/openai-compatible.md),
[Claude](./guides/anthropic.md).

## Large files with one model (0.1.0)

`gemini-3.8-flash` on the Gemini API, November 2026:

| File | Question | Result |
|---|---|---|
| A log of 5 MB and 60,000 lines, about 1.27M tokens: over the 1M window | "What caused the outage?" | The right root cause, failover time and affected services, citing the right lines (checked with grep). About 60 s, 11 tool calls, about 15K prompt tokens per turn. The model read straight to the FATAL line that the card listed. |
| A novel of 467 KB, about 117K tokens | "Where was the ledger hidden?" | Sent whole. Right. Estimated at 116,840 tokens; Gemini billed 116,842. |
| The same novel, read whole in parts of 40K tokens | "Read all of it…" | 4 parts, read in parallel, 1 of them relevant. A right answer that cited line 2036, in 32 s. |

The token counts of the two files are the estimate of 0.1.0, four characters a token. That rule
counted logs low, and the estimate of today counts a log as far more tokens
([Token estimates](#token-estimates-020)). For prose it was close, as the novel shows.

Live testing of 0.1.0 (model not recorded) also showed that Gemini can ignore
`functionCallingConfig: { mode: "NONE" }`: it kept calling tools on the turn meant to force an
answer. So the request that must be answered in text declares no tools to Gemini
([How it works](./how-it-works.md)).

## Token estimates (0.2.0)

Until 0.2.0, `estimateTokens` counted four characters a token. That holds for prose only: Gemini
counts about one token per digit. A service log was estimated at 37% of its real count and a CSV of
numbers at 26%, so such files were sent whole, and split into parts, at about three times the
configured budget.

The estimate of 0.2.0, which is still the one in the code, prices each kind of character. Its
weights were fitted to Gemini's `countTokens` on 60 texts: prose in eleven languages, source code,
JSON, CSV and eight log formats. Gemini 2.5, 3.5 and 3.8 count them identically. On those texts
the estimate is between 0.98 and 1.7 times Gemini's count. The one kind of text it counts low, at
about 70%, is a long run of random letters in one case with no digits.

Characters per token, as Gemini counts them:

| Text | Characters per token |
|---|---|
| English prose | 4.3 to 5.0 |
| Source code | 3.5 to 4.1 |
| Hebrew, Arabic, Russian prose | 2.1 to 3.3 |
| Chinese, Japanese, Korean prose | 1.4 to 1.7 |
| Logs (timestamps, IDs, IP addresses) | 1.4 to 2.8 |
| CSV of numbers, hex dumps, base64 | 1.0 to 1.4 |

Other providers' tokenizers were not measured. The `tokenScale` of 1.35 that `anthropic()` assumes
is a cautious guess, not a measurement: during a question the loop corrects it by the count the API
reports ([Costs and limits](./guides/costs-and-limits.md)).

## Reading a whole file

**Counting and listing (0.2.0, live, model not recorded).** A whole-file read was asked to list
every one of 1,200 matching lines: 492 came back, and the result said that it was incomplete. The
notes of a part were capped at 4,096 output tokens and the answer at 8,192, as they still are for
a model that does not think. Even without reaching a cap, the model can skip items: 91 of 120 in
the same test. Since 0.6.0 the tool guide sends counting and listing to `search_document` in exact
or regex mode, whose `total_matching_lines` is exact ([Tools](./reference/tools.md)).

**A count by exact search (0.6.0, live on Vertex AI, 2026-11-16).** `gemini-3.1-flash-lite`,
asked "how many ERROR lines say the payment gateway timed out" about a generated log of 4,000
lines, answered with one exact search: 40, the right count, with the first and last lines (100 and
4,000). After the merge of 0.6.0's changes, the packed package, installed in a clean folder, did
the same on a log of 2,000 lines: one exact search, 20, lines 100 and 2,000, in two requests and
5,531 input tokens. In that run a model that does not exist was refused as kind `"invalid"`, and
the request was sent once.

**The last match of a count (the review of 0.6.0, live on Vertex AI, 2026-11-20).**
`gemini-3.1-flash-lite` was asked how many PAY-5031 errors payments-api logged in a production log
of 3 MB, and on which lines the first and the last were. An exact search for "PAY-5031" found 884
lines, and a regex for the lines that payments-api wrote itself found 442. The count was right, and
so was the first line (11,355), but the model could not tell the last. That question took 11
requests, 3 of them repeats answered with pointers. Asked in a follow-up to run the search again
and confirm the count, it named line 12,088 as the last, in 6 requests. It was line 15,269. The
searches had shown the model their first matching lines and the total, and nothing of where the
others were. Since 0.6.1 an exact or regex search also shows the last matching line, with a note
that says how many of how many are shown ([How it works](./how-it-works.md#tools)). This page
records no live run of 0.6.1 on that log.

**Models that think (0.4.1, live).** Such a model counts its thoughts in `maxOutputTokens`. Asked
for 4,096 tokens of notes on a part of a log, Gemini 3.8 Flash spent 3,931 of them thinking and
wrote 317 characters, and Gemini 4 Hydrogen wrote none. With a second request at 32,768 tokens
(`THINKING_OUTPUT_TOKENS`), both models returned whole notes, and an answer cited all 70 matching
lines of a log read in three parts.

**The overview (0.4.1).** Before 0.4.1, `get_document_overview` read the whole file to count the
parts of a whole-file read: 60 MB of reads and 0.7 s for a log of 60 MB. It now works them out
from the metadata. The number is the count, or within a few percent of it.

**Reads of one turn run together (0.5.0, against a fake model).** Six whole-file reads, two in each
of three turns, took 841 ms one after another and about 540 ms run together.

**Reads asked for again (0.5.0, a probe).** A model asked for the same file to be read whole six
times in one question. Since 0.5.0, `limits.wholeDocumentReads` allows one read of each document
by default ([Costs and limits](./guides/costs-and-limits.md)).

## An explorer model (0.3.5)

Flash-Lite models, November 2026, through `ingest` and `askGemini`. The log has 6,000 lines, 24
deadlocks and one fatal error. The PDF is the one with a chart and a photo from
[Pages of PDFs](#pages-of-pdfs-030).

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

In the eleven checks with `gemini-3.5-flash-lite` exploring, the answering model was right every
time, from what the explorer found.

- `gemini-3.5-flash-lite` as explorer replied `DONE` each time, at one output token.
  `gemini-2.5-flash-lite` wrote an answer instead, which costs those output tokens and is dropped.
- Given a `thinkingLevel`, `gemini-2.5-flash-lite` on Vertex AI answers HTTP 400, "thinking_level
  is not supported by this model". That is what `explorerGenerationConfig` is for.
- A Gemini 3 model refuses a request that ends with the result of a function call it did not sign
  (HTTP 400, "Function call is missing a thought_signature"). When a user message follows the
  results, the same calls are accepted without a signature: by Gemini 3.1 and 3.5 Flash-Lite on
  the Gemini API and on Vertex AI, and by Gemini 2.5 Flash-Lite on Vertex AI. So the answering
  model's request always ends with a user message.
- Not checked: models larger than Flash-Lite, and Gemini 4. With `askGemini` the explorer is
  called with the endpoint's headers, so no check paired a model on the Gemini API with one on
  Vertex AI.

In 0.5.0 an explorer behind Gemini's OpenAI layer, with a thinking Gemini model answering, was
also run live on the Gemini API ([Checks of 0.5.0](#checks-of-050)).

In 0.6.0, on Vertex AI (2026-11-16), `gemini-3.5-flash-lite` explored and `gemini-3.1-flash-lite`
answered "What was the FATAL error, and what warning came shortly before it?" about the generated
log of 4,000 lines: the answer cited the FATAL line (3,210) and the warning 11 lines before it
(3,199). With the count and the repeated search of the same run, the three questions took 8
requests, 45,152 input tokens (7,755 cached) and 537 output tokens. The
[Explorer model guide](./guides/explorer-model.md) explains who does what and what it costs.

## Pages of PDFs (0.3.0)

### On the Gemini API

`gemini-3.5-flash-lite` on the Gemini API, November 2026, through `ingest` and `askGemini`:

| Check | Result |
|---|---|
| Which bar of a chart is tallest and shortest, and their colours; a number on a sign in a photo. Text sent whole. | Looked at 2 pages unasked. All five facts right, in 3 s. From the text alone, the model said that it could not see the chart. |
| The same, with the PDF searched instead | One look, all five right. |
| Ten questions that the text answers, about a PDF with a photo on each of its 60 pages | 0 of 10 looked at a page, with the text sent whole and with the PDF searched. 10 of 10 right both times. |
| A chart in one colour: a caption, but no mark | The model looked at the page and read the chart correctly. |
| Five pages in one look (five numbers on five signs) | All five right. 2,660 tokens for the pages. |
| A slide deck of 41 slides: a number on slide 8, a bar on slide 1 | Two looks, both right. |
| A PDF encrypted to restrict printing | One look, all right. |
| A scan of three pages (pictures of text) | One look at the three pages. Four of four facts right. |
| The request without tools that ends a question, after a look | Accepted, answered correctly, with the pages still in it. |

### On Vertex AI

The same model on Vertex AI, in the locations `global` and `eu`, November 2026: one look, two looks
in one model turn, one look that decides the next, the request without tools that ends a question,
and a PDF that is searched. All were accepted and answered correctly, with `vertexAi()` and through
an application's own URLs, streaming and not. Real files went through too: a number on a photo in a
report of 7.5 MB written by Word, and five numbers from one look at five pages of a file of 25 MB
(a PDF of 2.2 MB in the request).

### Where the pages go

| `toolFilePlacement` | Gemini 3.5 Flash-Lite, on the Gemini API and on Vertex AI | Gemini 2.5 Flash-Lite, on Vertex AI |
|---|---|---|
| `"inside"` (the default) | Works | Accepted and counted, but the model does not see the pages: it answers that it cannot see them |
| `"beside"` | Works | Works |

Vertex AI refuses a turn in which anything follows a function response (HTTP 400, "Requests ending
with a model turn are not supported", seen with Gemini 3.5), so with `"beside"` the pages have a
turn of their own. Not checked: Gemini 2.5 on the Gemini API, and Gemini 4.

### What a page costs the model

A page costs Gemini about 530 tokens, whatever is on it: 532 for each of 1, 2, 3 and 5 A4 pages,
and 527 for a 16:9 slide (`gemini-3.5-flash-lite`). On Vertex AI it was 532 as well. The default
`pageTokens` of `gemini()`, `GEMINI_PAGE_TOKENS`, is 530 ([gemini reference](./reference/gemini.md)).

### What a cut weighs

`view_pages` cuts the pages out of the kept file. Copied the simple way, a contents page took every
page it links to: the cut was 89% of the file, and the contents page of a report of 7.5 MB came
out at 6.7 MB. Cut the way the library does it:

| File | Pages cut | Size of the cut |
|---|---|---|
| Chrome, 72 photos, 100 MB | 5 | 7.0 MB (7%) |
| PowerPoint deck, 40 photos, 9.9 MB | 5 | 1.2 MB (13%) |
| Word report with a contents page, 7.5 MB | the contents page | 55 KB (0.7%) |
| All images in one shared list, 12 MB | 2 | 0.6 MB (5%) |

### What a cut costs the server

The whole file is read into memory on every call:

| File | Time | Memory at the peak |
|---|---|---|
| 100 MB of photos, 900 objects | 0.06 s | about 300 MB |
| 100 MB written the way Ghostscript writes | 3 s | about 300 MB |
| 54 MB, 330,000 objects (a tagged table of 591 pages) | 4 to 5 s | about 700 MB |

Memory is about twice the size of the file, plus 1.0 to 1.6 KB for each object in it, measured on
files of 300,000 objects. Reading cannot be interrupted once it has started: 1 MB of junk
between two objects took 3.6 seconds to skip. [Security](./security.md) and
[Deployment](./guides/deployment.md) say what to do about it.

### Marking the pages that show a picture

The marks are found from the structure of the file, without decoding any image. A PDF of 200
photos (85 MB) took 0.3 s to ingest without marks and 0.8 s with them. A PDF whose streams do not
state their length (Ghostscript writes them so) is scanned byte by byte, about 30 ms per MB: a file
of 100 MB written that way took 3 s to ingest instead of 0.1 s. A file that declares more than
150,000 objects gets no marks: reading it would take over two seconds.

Before 0.3.6, a PDF of 3 KB whose forms each paint the next one 30 times ran the process out of
memory. Since 0.3.6 such a file is read in 0.6 s.

### The PDFs these were tested with

The features of 0.3.0 (the marks and `view_pages`) were tested with PDFs made by Chrome, Word and
PowerPoint. PDFs made by LaTeX and InDesign were not tested. For FPDF, Ghostscript and scanners,
the structures they are known to write were tested with files made for the purpose, not with files
from those tools. Encrypted PDFs were tested with files encrypted by the library itself, and
confirmed as encrypted by pdf.js.

The [PDFs guide](./guides/pdfs.md) covers the marks, `view_pages` and its limits.

## PDF tables (0.2.0)

`gemini-3.5-flash-lite`, live: 110 questions about single cells of seven PDFs made by Word and
Chrome, half of them about empty cells. 44 answers were right from the text in file order, and 110
from the rebuilt rows. The rules that find the tables were tuned on PDFs made by Chrome and by
Word.

What the cell marks cost: a bank statement came to 27% more tokens than its text in file order, and
a report with one table in it to 9% more. Reading 600 pages with 24,600 table rows took 1.6 s
instead of 1.3 s. See the [PDFs guide](./guides/pdfs.md).

## Conversations and the prompt cache

**Documents first (0.2.0, live, with `askGemini`, model not recorded).** With the documents at the
start of the first user turn, a follow-up question about a document of 53,000 tokens had 96% of its
input served from Gemini's cache, against 0% when the document was appended to the latest turn.

**Stored tool rounds (0.5.0, live on the Gemini API, model not recorded).** With
`result.toolTurns` passed back in the conversation, a follow-up question took one request instead
of three, and no search.

**A repeated search (0.6.0, live on Vertex AI, 2026-11-16).** With `gemini-3.1-flash-lite`, a
follow-up that was sent the stored tool rounds of the first question and repeated its first search
got a pointer to the earlier result, instead of a second run, and answered from that result.

The [Conversations guide](./guides/conversations.md) shows how to keep tool rounds.

## Usage and the size of a request

**Usage totals (0.4.0, live, model not recorded).** In a live run of 0.4.0, whose `usage` was the
usage of the last response only, 13,687 prompt tokens were billed and 6,398 reported. For the
usage of 0.5.0 against the provider's, see [Checks of 0.5.0](#checks-of-050).

**Many reads in one turn.** Before 0.4.1, sixty reads in one turn built a request of 339,000 tokens;
0.4.1 runs at most eight calls of a turn. Before 0.5.0, a turn of sixty reads built a request of
491,000 tokens against a window of 128,000; with 0.5.0 the same run peaks at about 100,000.

**The error of a request too large (0.6.0, live on Vertex AI).** Sent a request of 1.78M tokens,
`gemini-3.1-flash-lite` on Vertex AI answered "The input token count exceeds the maximum number of
tokens allowed 1048576." The library reads that as the kind `"context_overflow"`, with a
`limitTokens` of 1,048,576 ([Errors and reliability](./guides/errors-and-reliability.md)).

## The server

**Regex search (0.4.1).** A pattern that backtracks without end on a line, such as `(a|a)+$`, costs
about 0.8 s, not the full 3-second limit. Before 0.4.1, five such searches in one turn kept the
server from answering any other request for 15 seconds. Before 0.2.0, `((a+))+$` and `(a|a)+$` never
finished on a line of 40 characters.

**DOCX and PPTX (0.3.6).** Before 0.3.6, a DOCX of 900 bytes held the server for 8 seconds, and one
of 10 KB would have held it for an hour. A DOCX of 160 KB that unpacked to 50 MB of XML was stored
as 29 million characters; since 0.3.6 it is refused at 16 MB, in 0.2 s.

**The memory cache (0.4.0).** Before 0.4.0 the cache was bounded in documents: six documents of 50
MB took over 600 MB. Since 0.4.0 every use of a document kept in memory asks the store first, with
`getMeta`: about a millisecond.

**Sizes counted for JSON (0.4.1).** Before 0.4.1, `jsonBytes` and the planner counted text with
quotes, backslashes, tabs or many line breaks low: by 23% for a JSON-lines export and 31% for TSV.
A read of quoted text came out at 42,514 characters against a cap of 24,000.

**Memory and stalls of an ingest (0.6.0, November 2026, Node 24 on Windows, plain-text logs).**
Peak memory above the uploaded bytes: about 175 MB for a log of 25 MB, 270 MB for 50 MB, and 470 MB
for 95 MB. An ingest of the 95 MB log fitted in a worker thread of 256 MB. One exact search of the
95 MB log, read by range, took about 60 to 80 MB. Eight such searches at once took about 70 to 85
MB, and about 220 MB with `cacheBytes` at 1 GB, which keeps the decoded pieces. An ingest held the
event loop for about 0.8 to 1.5 seconds (25 MB) and 3 to 5 seconds (95 MB). Linux was not
measured. [Deployment](./guides/deployment.md) turns these into sizing advice.

**Ingest of large and hostile files (0.6.1, November 2026, Node 24 on Windows).** Each file was
ingested into a `MemoryDocumentStore` in a fresh process, with the parsers loaded first, 0.6.0 and
0.6.1 in turn, on a machine that ran other work too. A stall is the longest gap between two beats
of a 5 ms timer; memory is the resident set at the beats, so for 0.6.0, whose ingests let no beat
in, it is not given.

| File | 0.6.0 | 0.6.1 |
|---|---|---|
| A log of 99 MB, 1,160,000 lines (3 runs each) | 1.9 to 2.0 s, all of it one stall | 1.9 s; longest stall 31 to 34 ms; 415 to 433 MB |
| A PDF of 2,000 pages, 30 lines each, 3.5 MB (3 runs each) | 4.6 to 4.9 s; longest stall 4.4 to 4.5 s | 4.9 to 5.0 s; longest stall 0.16 s |
| A DOCX of 1.5 MB holding 120 MB of empty paragraphs, heap of 512 MB (2 runs each) | Out of memory: the process stopped | Refused ("did not contain any text") in 3.0 to 3.2 s, at 115 MB |
| A DOCX of 3 MB that unpacks to 1,000 MB of XML, heap of 512 MB (2 runs each) | Out of memory: the process stopped | Refused at 1,000,000 paragraphs in 0.85 to 0.91 s, at 165 MB |
| PDFs of 3 KB and 6 KB whose page tree lists one dense page 150 and 600 times | 107 MB of text stored; 205 s held with a heap of 1.5 GB, and out of memory with 512 MB (review of 0.6.0) | Refused in 0.23 s |

The review of 0.6.0, on files of its own, measured stalls of 3.5 s for a 100 MB log and 8.3 s for
a 2,000-page PDF.

Hostile files, each in a fresh process with heaps of 256 and 512 MB, 0.6.1 only (2 runs each, the
parsers not loaded first):

| File | 0.6.1 |
|---|---|
| PDFs of 23 KB and 95 KB whose 140 and 600 distinct pages all paint one dense content stream | Refused at 16 MB of text ("draws more than 16 MB of text, over 100 times its size") in 5.5 to 6.0 s, at 210 MB; longest stall 0.34 to 0.59 s. Without that limit, the first was stored with 99.5 MB of text after 35 to 40 s, at 430 MB. |
| The DOCX of 1.5 MB holding 120 MB of empty paragraphs, with JSZip loaded first | Stalls of 0.2 to 0.25 s, one after the other, for 3 s: JSZip unpacks a piece of the file in one block, and a piece packed this tight is several MB of XML. A DOCX of 4 MB written the usual way, with 32 MB of XML, never held the event loop for 30 ms. |
| A PDF of 650 KB whose one page runs 160 MB of text operators, packed 250 times | Read: 9 KB of text in 24 to 26 s, nearly all of it one stall of about 25 s, at 510 MB. pdf.js reads a page in one block, and neither `ingestTimeoutMs` nor a signal stops it within the page. |
| A PDF of 160 KB of three pages that each run 40 MB | Read in 17 s, with one stall of 11 s. |

These last two, measured without the page check, are why it was written (below), and why
[Deployment](./guides/deployment.md#uploads-and-ingest) ingests files you do not trust in a process
of their own.

**The page check (0.6.1, November 2026, Node 24 on Windows).** Each file ingested into a
`MemoryDocumentStore` in a fresh process with the parsers loaded first, without the check (the
0.6.1 code before it; one or two runs) and with it (one run). Time is the whole ingest; the stall
is the longest gap between two beats of a 5 ms timer.

| File | Without the check | With the check |
|---|---|---|
| 2.8 KB: one page paints a form that paints the next 50 times, 3 deep (125,000 forms with text) | Read in 13 to 14 s, one stall of 13 to 14 s, at 345 to 380 MB | Refused in 15 ms, at 68 MB |
| 2.2 to 2.3 KB, the same 4, 5 and 6 deep (20, 12 and 8 times) | Read in 17 to 36 s, nearly all of it one stall, at 385 to 470 MB | Refused in 14 to 19 ms |
| 4.3 KB and 21 KB, the same 3 deep 100 times, and 2 deep 1,000 times (1,000,000 forms) | Refused once read, for 16 MB of text, after 95 to 119 s, all of it one stall | Refused in 19 and 22 ms |
| 636 KB: one page runs 160 MB of text operators, packed 250 times | Read in 23 to 29 s, one stall of 23 to 29 s, at 420 MB | Refused in 54 ms; longest stall 20 ms |
| 160 KB: three pages each run 40 MB | Read in 18 to 22 s, longest stall 6 to 14 s | Refused in 32 ms |
| 2.9 KB: a Type3 glyph paints a form 390,000 times, through forms inside forms | Read in 9.1 s, one stall of 9.0 s, at 730 MB | Refused in 17 ms, at 68 MB |
| 2.6 KB: eight forms with text that each paint all eight | Read in 5.8 to 6.0 s, one stall | Refused in 42 ms |
| 2.9 KB: forms inside forms, painted from content stored with a predictor | Read in 9.7 to 10.0 s, one stall | Refused in 20 ms |
| 23 KB: 140 pages show one dense content stream | Refused at 16 MB of text after 5.8 s; longest stall 0.53 s | Refused in 26 ms |
| 25 KB: 60 pages show one stream of 4 MB | Read in 38 s; a stall of 1.3 s a page | Refused in 35 ms |

The check found the pages of the documents tested at 11% of the limit at most. Under 2%: PDFs
printed by Chrome, Word and PowerPoint (10,000 to 150,000 units a page), books of 300 to 2,000
pages (10,000), a 3,000-page file of 60,000 objects (under 5,000), and 300 pages of 1,500 filled
shapes each (180,000). Under 11%: Edge printing a table of 6,000 rows, an SVG chart of 30,000
points (16.6 million units in a 4.6 MB file; pdf.js read the page in 0.32 s), 5,000 SVG icons,
30 fonts, and pages of CSS gradients and shadows; matplotlib saving a scatter plot of 50,000
points, a 40-page report of 16 charts a page, and 600,000 points of lines.

A form painted for its text counts 640 units, about 0.1 ms. pdf.js took 75 to 85 µs a form,
warm: 0.84 s for a page that paints one small form with text 10,000 times, 0.79 s for forms
inside forms 100 times 2 deep, 1.26 s for 25 times 3 deep, and 1.70 s for 12 times 4 deep. The
first two are read, the last two refused. Files built to make the check itself work hard are
checked fast: 300 pages whose resources all point to one list of 140,000 drawings in 0.16 s, and
a page that may paint any of 140,000 drawings 100 times in 0.42 s. Their longest stall, 0.1 to
0.15 s, is reading the list once, about as long as `@cantoo/pdf-lib` takes to parse it.

The 14 inputs of the identity check of 0.6.1 (logs of 10 to 100 MB, JSONL, CSV,
Markdown, and the PDFs below with and without picture marks) store byte for byte the text, index
and metadata that 0.6.0 stores. What the check adds to an ingest:

PDFs written with `@cantoo/pdf-lib` (pages of 45 lines of text, or of 1,500 small filled shapes),
ingested into a `FileDocumentStore` with originals kept, without the check and with it in turn,
three runs each: the median, and the range. A warm process ingests the file a second time, the
parsers already loaded; a fresh one loads them during the ingest. Peak memory is that of the
process.

| PDF | Picture marks | Ingest, warm: without / with | Longest stall, warm | Ingest, fresh process | Longest stall, fresh | Peak memory, fresh |
|---|---|---|---|---|---|---|
| 300 pages, 1 MB | on | 0.91 / 0.91 s | 50 / 46 ms | 1.48 / 1.56 s | 0.44 / 0.41 s | 169 / 169 MB |
| 300 pages | off | 0.84 / 0.93 s | 54 / 61 ms | 1.00 / 1.49 s | 0.13 / 0.41 s | 146 / 159 MB |
| 1,000 pages, 3.2 MB | on | | | 4.03 / 3.91 s | 0.50 / 0.43 s | 323 / 332 MB |
| 1,000 pages | off | | | 3.25 / 4.16 s | 0.22 / 0.47 s | 258 / 325 MB |
| 2,000 pages, 6.4 MB | on | 6.27 [5.99 to 8.01] / 7.26 [6.20 to 7.47] s | 0.18 / 0.19 s | 7.93 / 8.19 s | 0.52 / 0.49 s | 418 / 443 MB |
| 2,000 pages | off | 6.05 / 6.37 s | 0.19 / 0.19 s | 7.02 / 8.29 s | 0.33 / 0.49 s | 345 / 436 MB |
| 300 pages of drawings, 3 MB | on | 3.86 / 4.07 s | 40 / 33 ms | 5.08 / 4.87 s | 0.51 / 0.47 s | 315 / 323 MB |
| 300 pages of drawings | off | | | 2.95 / 3.64 s | 0.13 / 0.49 s | 87 / 154 MB |

With picture marks on, the file was read with `@cantoo/pdf-lib` before too, after the text: the
check itself took 31 ms for 300 pages of text, 0.11 s for 300 pages of drawings and 0.25 s for
2,000 pages, inside the spread of the runs. With them off, that reading is new: in a warm process
0.08 s for 300 pages and 0.3 s for 2,000. In a fresh process, the first PDF also loads
`@cantoo/pdf-lib`, one block of about 0.4 s: the longest stall of a fresh process with
`pictures: false` is that load, which a server that loads the parsers when it starts does not pay
([Deployment](./guides/deployment.md#uploads-and-ingest)).

**Heap limits of workers and child processes (0.6.1, Node 24 on Windows).** The heap limit a
thread sees (`v8.getHeapStatistics().heap_size_limit`), with `resourceLimits:
{ maxOldGenerationSizeMb: 512 }` on a worker or `--max-old-space-size=512` on a forked child:

| The parent runs with | Worker | Forked child |
|---|---|---|
| No heap flag | 704 MB | 704 MB |
| `--max-old-space-size=1024`, on the command line or in `NODE_OPTIONS` | 1,216 MB, the parent's | 704 MB |

`execArgv: []` or a cleared `NODE_OPTIONS` on the worker left it at 1,216 MB. In the review of
0.6.0, a worker of 512 MB with no heap flag on the parent ran out of memory on a hostile DOCX and
stopped the whole process. With the recipe of [Deployment](./guides/deployment.md#uploads-and-ingest),
a child forked with a heap of 48 MB ran out of memory on the 2,000-page PDF and stopped alone: the
upload was answered with an error, and the next one was ingested.

**Text files that are not UTF-8 (0.6.1, November 2026, Node 24 on Windows).** 0.6.0 read such a
file as UTF-8, in one go, with every letter of the older encoding stored as U+FFFD. 0.6.1 looks at
its lines, chooses an encoding, and decodes in steps of about a megabyte, with pauses in between.

A log of 77 MB in windows-1255, 1,002,740 lines each with a Hebrew name, and the same lines in
UTF-8 (84 MB), each ingested into a `MemoryDocumentStore` in a fresh process, in turn, nine runs
each, in two sessions of 2026-11-21, on a machine that ran other work too. The stall is the longest
gap between two beats of a 5 ms timer, and memory the peak resident set at the beats:

| Log | Ingest | Longest stall | Memory |
|---|---|---|---|
| 77 MB in windows-1255 | 2.8 to 4.0 s | 34 to 73 ms | 462 to 485 MB |
| The same lines in UTF-8, 84 MB | 2.5 to 3.5 s | 63 to 119 ms | 458 to 477 MB |

The second session (six runs each) took about a quarter longer than the first, with stalls up to
twice as long, under other load on the machine. In both, the windows-1255 log took longer on
average than its UTF-8 copy, and its stalls were shorter.

The decoder alone, on files of 30 MB, in a fresh process, three times, two passes each (the first
pass also builds the tables of the encodings):

| File of 30 MB | Before: whole time, longest step | 0.6.1: whole time, longest step |
|---|---|---|
| All in windows-1255 | 265 to 293 ms, 27 to 42 ms | 274 to 284 ms, 13 to 14 ms |
| Rows of ASCII and of windows-1255, and one row of UTF-8 | 215 to 234 ms, 23 to 36 ms, with the UTF-8 row read wrong | 348 to 372 ms, 21 to 22 ms |
| Lines with accents, of windows-1252 and of UTF-8 in turn, 100 bytes each, with one windows-1252 line more (with as many of each, the file is read as UTF-8) | 203 to 298 ms, 25 to 44 ms, with the UTF-8 lines read wrong | 495 to 532 ms, 9 to 21 ms |
| One row of UTF-8, then one line of 30 MB in windows-1255 | 247 to 275 ms, 13 to 16 ms | 291 to 320 ms, 17 to 19 ms |
| Lines of one letter, of windows-1252 and of UTF-8 in turn | 294 to 345 ms, 27 to 45 ms | 2,089 to 2,212 ms, 12 to 21 ms |
| CESU-8 (emoji as halves of surrogate pairs) | 195 to 266 ms, 16 to 34 ms, read as windows-1252 | 132 to 140 ms, 17 to 22 ms |

"Before" read a file with lines in both encodings whole in the older one. Reading each line in its
own encoding costs 1.6 times the time on a mixed CSV, about twice on lines that all take turns, and
7 times on lines of one letter, all of it spread over pauses. A whole ingest of the mixed CSV took
1,064 to 1,072 ms (two runs). The longest stalls of these whole ingests, 63 to 197 ms before and
after, came from later steps of the ingest, not from the decoder. Before the pauses between the
encodings it tries, choosing one held the event loop for 45 to 90 ms in one block the first time a
process met such a file.

**Cleaning a long line (0.6.1, November 2026, Node 24 on Windows).** Ingest cleans the text a
slice at a time, but a slice runs on to the next line break, so a text with no line break was
cleaned in one go. Each file below is one line of 30 MB, ingested into a `MemoryDocumentStore` in a
fresh process for each run, on a machine that ran other work too: the longest stall, and the peak
memory of the process. 0.6.0 is given where it was measured; it removed fewer characters, and held
the event loop for the whole ingest.

| One line of 30 MB | 0.6.0 | Before | 0.6.1 |
|---|---|---|---|
| A zero-width space between letters | 357 to 370 ms | 931 to 1,061 ms, 721 to 809 MB | 34 to 52 ms, 195 to 196 MB |
| A control character between letters | 1,856 to 1,887 ms, 761 MB | 2,014 to 3,428 ms, 1,497 to 1,567 MB | 71 to 76 ms, 248 to 250 MB |
| Soft hyphens alone | | 792 to 891 ms, 496 to 501 MB | 40 ms, 193 MB |
| Tag characters and variation selectors in turn | | 634 to 705 ms, 464 to 470 MB | 40 to 51 ms, 220 to 269 MB |
| `a` and `ESC [0m` in turn | 671 to 726 ms | 455 to 488 ms, 413 MB | 31 to 36 ms, 211 to 217 MB |
| `a` and `U+009B 1m` in turn | 467 ms | 573 to 656 ms, 427 MB | 42 to 55 ms, 245 to 260 MB |

With a heap of 1 GB, a line of 99 MB with a zero-width space or a control character between its
letters ran the process out of memory before; 0.6.1 held the event loop for 97 to 118 ms, at 467
to 476 MB. With `U+009B 1m` in turn, 2.1 to 2.3 s at 1.1 GB before, and 0.11 to 0.13 s at 542 to
547 MB. The text stored is the same. The rows of escape sequences were measured with the final
code; the other rows with a first version of it, which cleans those characters the same way, and
which the final code matched within the spread.

**Hidden text in Word (0.6.1, November 2026, Node 24 on Windows).** A hidden line longer than about
1,950 characters is cut into marked pieces. Before, the end of the line was looked for again for
each piece, so the work grew with the square of the line, in one block. Each DOCX ingested into a
`MemoryDocumentStore` in a fresh process, one run of 0.6.1 each:

| DOCX | Before | 0.6.1 |
|---|---|---|
| 16.7 KB, one hidden run of 16 million letters | 11.3 to 14.5 s (four runs), nearly all of it one stall | 0.55 s, longest stall 0.18 s |
| 348 KB, one hidden run of 16 million characters of words | 11.7 s, one stall of 11.3 s | 0.53 s, longest stall 74 ms |
| 1.48 MB, one hidden run of 134 million characters, refused for its text | 722 s | 0.75 s, longest stall 0.30 s, the same refusal |

0.6.0, which did not mark hidden text, read the 16.7 KB file in 0.46 to 0.54 s (three runs).
Marking the 16 million letters alone took 92 ms (10.1 s before). Reading the XML of 200,000 runs,
formatted, hidden or neither, took the same time before and after, within the spread (0.6 to 0.8 s,
five rounds).

**Reading a PDF into objects, and looks at pages (0.6.1, November 2026, Node 24 on Windows).**
`@cantoo/pdf-lib` reads the whole file into objects for the page check and the picture marks at
ingest, and for each look of `view_pages`. 0.6.1 makes it pause after every 12 ms of work, or up to
40 ms where a pause itself takes long, as a timer does on Windows. Before, it paused after a count
of 500 objects (0.6.0: 4,000). The stall is the longest the event loop was held:

| Read into objects | Before: count of 500 | 0.6.1: by time |
|---|---|---|
| A file of 4,000 large arrays: longest stall | 164 to 179 ms | 28 to 32 ms |
| A PDF of 2,000 pages: longest stall | 32 to 106 ms | 19 to 38 ms |
| A file of 61,000 small objects: whole read | 1.65 to 1.87 s | 0.91 to 0.96 s |
| A file of large objects: whole read | 1.13 to 1.22 s | 1.35 to 1.43 s |

What `@cantoo/pdf-lib` reads in one step still holds the server. One object takes about 0.1 to
0.2 s for each MB of an array of numbers, more when the numbers are short: 1.1 to 1.2 s for 8 MB,
4.1 s for 32 MB, 9 s for 64 MB. A crafted one-page PDF of 16 MB held the server for 2.7 s at
ingest and 2.5 s on each look. Measured again on a busy machine, one look at 16 MB took 2.1 s with
numbers such as `1234.5` and 3.5 s with numbers of one digit. A stream whose length the file gives
by reference takes about 0.03 s for each MB, and a cross-reference table written as text 0.15 s
for 150,000 objects: the longest stall of a file of 150,000 objects was 168 to 197 ms, 151 ms of
it that table. Such files also take many times their size in heap, the more the shorter their
numbers: one array of numbers such as `1234.5` left 173 MB in use at 16 MB and 399 MB at 32 MB,
and one of one-digit numbers 493 MB and 929 MB. One of 40 MB ran a heap of 256 MB out of memory.
The count of objects that a file declares does not show this.

A look at pages now also pauses while it copies the pages and writes the cut. Compared with 0.6.0:

| Look at pages | 0.6.0: longest stall, of the whole look | 0.6.1 |
|---|---|---|
| Pages 1,800 to 1,802 of a PDF of 2,000 pages, 6.2 MB | 159 to 177 ms, of 163 to 185 ms | 19 to 20 ms, of 0.2 s (19 to 48 ms on a busy machine) |
| One page that refers to 4,000 large arrays | 0.73 to 0.75 s, of 1.27 to 1.30 s | 39 to 50 ms, of 1.5 to 1.6 s |
| One page that refers to 20,000 large arrays | 1.87 to 2.02 s, of 3.8 to 3.9 s | 43 to 47 ms, of 4.0 s |

The writer of `@cantoo/pdf-lib` searched its list of objects for each new one, a block that grew
with the square of their count (0.5 s for 20,000 objects); the cut's own list is now added to at its
end. 65 cuts of 50 PDFs are the same to the byte as before. Still in one block: the first look of a
process loads `@cantoo/pdf-lib`, in about 0.4 s (0.37 to 0.39 s for the ES build that `import()`
loads); a page whose resources list 140,000 pictures
takes about 0.15 s to drop the ones it does not paint; and a content stream of 7 to 8 MB takes 74
to 84 ms to read for the pictures it paints.

**Streams of a reply (0.6.1, November 2026, Node 24 on Windows).** `parseSseJson`, which the
adapters read streamed replies with, scanned an event again with each piece that came. One event of
1, 4 and 8 MB, in pieces of 16 KB, in memory, took 11 to 15 ms, 201 to 220 ms and 794 to 954 ms
before, and takes 1 to 2 ms, 5 to 9 ms and 10 to 18 ms with 0.6.1. Now that it is fast, an endpoint
that never ends an event could fill memory fast: one event holds at most 64,000,000 characters. A
hostile endpoint on the same machine, read through the adapters' own `fetch`:

| The endpoint sends | Before | 0.6.1 |
|---|---|---|
| One event without an end | 513 MB read, failed as `"unreachable"` and sent again: 4 requests, 7.7 s, the process up 894 MB | Failed as `"invalid"` after 62 MB, not sent again: 1 request, 0.36 s, up 165 MB |
| Data lines without the blank line that ends an event, heap of 1 GB | Out of memory: the process stopped | Failed as `"invalid"` after 62 MB, 0.39 s, up 166 MB |

A reply made of many events has no cap yet.

[Security](./security.md) explains the limits that came of these measurements.

## Faults reproduced before a fix

Numbers from probes and tests that showed a fault, not from live runs. Each is fixed in the version
named.

- **0.3.6.** A log of 10,000 lines whose third line held a logged user agent `ua="evil␛]"` was
  stored as 3 lines, with no error.
- **0.6.0.** Two whole-file reads of one turn, each checked alone against what was left, ran
  together and passed the ceiling: 16 requests against a `limits.requests` of 11, in a probe.
- **0.6.0.** With a Gemini explorer and Claude answering, on text that cost 30% more than
  estimated, the request for the answer came to 66,000 tokens of Claude's window of 60,000.
- **0.6.0.** On a model whose conversation may only grow (Claude), four searches of about 300
  characters each, after four rounds of reads on a window of 64,000, ran three and forced the
  answer.
- **0.6.1.** A DOCX of 1.5 MB holding 120 MB of empty paragraphs ran a server with a heap of 512
  MB out of memory, and stopped it.
- **0.6.1.** A PDF of 3 KB whose page tree listed one dense page 150 times was stored with 107 MB
  of text. One of 6 KB with 600 listings held the event loop for 205 s.
- **0.6.1.** `files.tools()`, handed a `DocumentMeta` built from an ID with no owner or another
  one, read the text of a document that had an owner, and showed the pages of its PDF.
- **0.6.1.** A Hebrew CSV that Excel saved in windows-1255 was stored as U+FFFD: "ירושלים" was
  found in none of its 30 rows.
- **0.6.1.** A line with 44 Unicode tag characters, which spell out an instruction that a person
  does not see, sent all 44 to the model, in the prompt and in tool results.
- **0.6.1.** With unpdf 1.5.0 to 1.6.0 on Node 20.19 and 22.12, the first PDF stopped the whole
  process (`TypeError: Promise.try is not a function`, where nothing could catch it).
- **0.6.1.** A call to a tool named with 200,000 characters made a step of 400,025 characters, and
  an error result of 200,047 that went back to the model.
- **0.6.1.** A question whose adapter never ended its request, and ignored the signal, hung for
  good after an abort at 300 ms. It now throws the signal's reason at 310 ms.

## Checks of 0.5.0

Live on the Gemini API, models not recorded: `askWithFiles` with `gemini()`, and with
`openAiCompatible()` on Gemini's OpenAI layer (streamed, a log of 5.2 MB); an explorer behind the
OpenAI layer, with a thinking Gemini model answering; `askGemini` on a thinking model, alone and
with an explorer; a follow-up question from stored tool rounds; and a part read through the OpenAI
adapter. In each, the usage the library returned was what the provider reported, request by
request.

## Checks against earlier releases

These compare the requests or the tool results of a release with those of an earlier one.

| Release | Checked against | How |
|---|---|---|
| 0.3.0 | 0.2.0, as published | An application that changes nothing, and does not install `@cantoo/pdf-lib`, sends the same requests: byte for byte, over eight scenarios. |
| 0.3.5 | 0.3.0 | Without an explorer, the same requests: byte for byte, over seven scenarios. |
| 0.4.0 | 0.3.6 | The API, the tools and their results: call by call. |
| 0.4.1 | 0.3.6 | Tool results, call by call, over 40 documents: the same but for three changes that the 0.4.1 changelog lists. |
| 0.5.0 | 0.3.6 and 0.4.1 | Tool results, call by call with 0.3.6 over 40 documents: the same, except that a repeated whole-file read is refused. The requests of `askGemini` are those of 0.4.1: its 44 tests pass unchanged, but for one that now turns the retry off. |

## Measuring your own setup

The live answers above were judged against what is known to be in the file. To measure a model on
your own files, ask a question, log the fields of the result, and judge the answer the same way.
This sample uses Gemini on Vertex AI; `askWithFiles` returns the same fields for any adapter
([ask reference](./reference/ask.md)).

```ts
import { readFile } from "node:fs/promises";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";

const files = createLargeFiles({ store: new MemoryDocumentStore() });
const meta = await files.ingest({ name: "app.log", bytes: await readFile("./app.log") });

const started = Date.now();
const result = await askGemini({
  files,
  endpoint: vertexAi({
    project: process.env.GOOGLE_CLOUD_PROJECT!,
    location: "global",
    model: process.env.GEMINI_MODEL!,                 // the model you want to measure
    explorerModel: process.env.GEMINI_EXPLORER_MODEL, // optional: leave it unset for one model
    accessToken: process.env.VERTEX_ACCESS_TOKEN!,    // the Vertex AI guide shows tokens that renew
  }),
  documentIds: [meta.id],
  messages: [{ role: "user", text: "How many ERROR lines say the payment gateway timed out?" }],
  limits: { inputTokens: 250_000 },                   // past it, no more tools: the next request is the answer
});

console.log({
  answered: result.answered,
  seconds: (Date.now() - started) / 1000,
  searched: result.plan.searchable.map((document) => document.name), // the others were sent whole
  chatRequests: result.turns,  // part reads of a whole-file read not included
  usage: result.usage,         // the whole question: requests and tokens, and per model in byModel
  steps: result.steps,         // each tool call, as a user would see it
});
console.log(result.text);
```

Compare the answer with what you know is in the file: a count you made with grep, a line you know.
To test the integration without a real model, see [Testing](./guides/testing.md); to keep a
question's cost in bounds, [Costs and limits](./guides/costs-and-limits.md).
