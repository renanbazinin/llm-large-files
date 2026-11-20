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
  2026-11-13. The checks of 0.6.0 are of November 2026. All live results are of November 2026.
- Where the record names no model, this page says "model not recorded".
- What a result led to in the library is explained in the guides. This page links to them and does
  not repeat them. The [changelog](../CHANGELOG.md) records 0.6.0 and links to the history of 0.1.0
  to 0.5.0.

## What has been run live

| Provider | Live runs on record | Not run live |
|---|---|---|
| Gemini API: `askGemini`, `gemini()`, `geminiApi()` | From 0.1.0 to 0.5.0: large files, pages of PDFs, explorer pairs, follow-up questions | Gemini 2.5 with pages (`toolFilePlacement`) and in explorer pairs: it is closed to new users on the Gemini API |
| Vertex AI: `vertexAi()` | 0.3.0: pages of PDFs, in the locations `global` and `eu`. 0.3.5: explorer pairs. 0.6.0: a count, a repeated search, the error of a request too large | |
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
| A PDF of 650 KB whose one page paints forms inside forms | Read: 9 KB of text in 24 to 26 s, nearly all of it one stall of about 25 s, at 510 MB. pdf.js reads a page in one block, and neither `ingestTimeoutMs` nor a signal stops it within the page. |
| A PDF of 160 KB of three such pages | Read in 17 s, with one stall of 11 s. |

These last two are why [Deployment](./guides/deployment.md#uploads-and-ingest) ingests files you
do not trust in a process of their own.

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
