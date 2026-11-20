# Tools

This page lists the tools the model gets for documents too large for its prompt and for the
pages of PDFs: their names, arguments, results and limits, and the tool exports of `llm-large-files`. Read it when you write a
loop of your own, show `steps` to users, keep `toolTurns`, or want to know exactly what the model
was told and what it read.

```ts
import { MAX_VIEW_PAGES, MAX_WHOLE_DOCUMENT_READS, REGEX_BUDGET_MS, TOOL_NAMES, toolResultSummary } from "llm-large-files";
import type { JsonSchema, ToolCallLimits, ToolDeclaration, ToolFile, ToolFileLimits, ToolOutput, ToolResult, ToolSet } from "llm-large-files";
```

Contents:

- [The tools](#the-tools) and [which tools are offered](#which-tools-are-offered)
- [Rules for every tool](#rules-for-every-tool)
- [`search_document`](#search_document), [`read_document`](#read_document),
  [`get_document_overview`](#get_document_overview),
  [`analyze_whole_document`](#analyze_whole_document), [`view_pages`](#view_pages)
- [The tool guide](#the-tool-guide)
- [What `askWithFiles` adds to results](#what-askwithfiles-adds-to-results)
- Exports: [`TOOL_NAMES`](#tool_names), [`MAX_VIEW_PAGES`](#max_view_pages),
  [`MAX_WHOLE_DOCUMENT_READS`](#max_whole_document_reads), [`REGEX_BUDGET_MS`](#regex_budget_ms),
  [toolResultSummary(label, result)](#toolresultsummarylabel-result), [`ToolSet`](#toolset),
  [`ToolCallLimits`](#toolcalllimits), [`ToolFileLimits`](#toolfilelimits),
  [`ToolOutput`](#tooloutput), [`ToolFile`](#toolfile), [`ToolResult`](#toolresult),
  [`ToolDeclaration`](#tooldeclaration), [`JsonSchema`](#jsonschema)
- [Stability](#stability)

Related exports on other pages: [`LargeFiles`](./library.md#largefiles) (its `tools()` method),
[`ToolOptions`](./library.md#tooloptions), [`PreparedContext`](./library.md#preparedcontext) and
[`Budget`](./library.md#budget) are in the [library reference](./library.md). `ToolCall`,
`ToolAnswer`, `ToolTurn`, `evidenceOf`, `stubResult` and [`AskLimits`](./ask.md#asklimits) are in
the [loop reference](./ask.md).

## The tools

| Tool | What it does |
|---|---|
| `search_document` | Finds lines that contain a text or match a regex, with an exact count, or the passages that match keywords best. |
| `read_document` | Reads a range of lines, numbered, up to 600 a call. |
| `get_document_overview` | The outline, the log profile, the first 30 and last 20 lines, and what a whole-file read would take. |
| `analyze_whole_document` | Reads the whole file in parts with other model calls (map-reduce) and answers a task that needs all of it. |
| `view_pages` | Up to 5 pages of a PDF, cut out of the uploaded file, as one small PDF the model looks at. |

The model finds a document's `document_id` on its card in the prompt, or in the
[tool guide](#the-tool-guide) for a PDF whose text is in the prompt. How the card, the tools and
the loop work together is in [How it works](../how-it-works.md).

### Which tools are offered

In [askWithFiles(options)](./ask.md#askwithfilesoptions) (and `askGemini`, which runs it):

- No tool is offered when every document fits in the prompt and none has pages to look at. The
  question is then one request.
- `search_document`, `read_document` and `get_document_overview` are offered when at least one
  document is too large for the prompt (`plan.searchable`). They reach only those documents: a
  document whose text is in the prompt is not searched.
- `analyze_whole_document` is offered with them when all of these hold: the model that explores
  (the explorer, or else the model) has `generateText`, `wholeDocumentAnalysis` is not `false`, and
  at least one searchable document is estimated, from its metadata, to need no more than
  `maxMapChunks` parts (5% leeway).
- `view_pages` is offered for each PDF whose uploaded file is kept (`keepOriginals` includes
  `"pdf"` and the store keeps originals), when `viewPages` is not `false` and every model of the
  question can be sent a file (`capabilities.toolFiles` is not `"none"`). An OpenAI-compatible
  model needs `pdfInput: true`; Claude with `toolFilePlacement: "none"` turns it off. It is also
  offered for a PDF whose text is in the prompt; when no document is searchable, it is the only
  tool. See [PDFs](../guides/pdfs.md).

With an [explorer model](../guides/explorer-model.md), the explorer gets the tools and makes the
calls; the answering model gets what they returned.

Through `files.tools(documents, options)` (a loop of your own, see [`ToolSet`](#toolset)):

- The three text tools are declared unless `documents` is empty and there are PDFs to look at.
  With no documents and no PDFs they are still declared, and every call answers that no attached
  file is read with this tool.
- `analyze_whole_document` is declared when `options.generate` is given and at least one of
  `documents` is estimated within `maxMapChunks` parts (5% leeway). With `generate` and no such
  document it is not declared, but a call of it is still answered, with the reason. Without
  `generate`, pass `wholeDocumentAnalysis: false` to `prepare`: the tool guide then does not name
  it, and the cards do not offer a whole-file read.
- `view_pages` is declared when `options.viewPages` names at least one PDF whose `originalKept` is
  true and the store has `getOriginal`: `true` means every PDF in `documents`, and a list (such as
  `prepared.viewable`) means exactly those.

## Rules for every tool

**Arguments.** Integers may arrive as numbers or as numeric strings (`"12"`); fractions are cut to
whole numbers; a value that is neither a number nor a numeric string takes the default (an empty or
blank string counts as 0, so it is clamped to the minimum); line numbers and counts out of range
are clamped, not refused. Page numbers are the exception: `view_pages` refuses a page that is not a
number of 1 or more. A `mode` other than `"exact"` or `"regex"` is `"keywords"`, and
`case_sensitive` is on only when it is `true`.

**Scope.** A call reaches only the documents its tool set was made for. A `document_id` outside
them is refused with the IDs the model may use, so that the next call is right (`view_pages`
refuses it with the reason instead, see [its errors](#view_pages)). The tool set does
not check owners: make it from documents you looked up with the user's `owner`, as `prepare` and
`askWithFiles` do (see [Security](../security.md)).

**Errors.** A call that fails returns `{ "error": "..." }` for the model to read, and the loop goes
on. It never names a server path: a Node system error becomes "The file could not be read from
storage (EIO). Try the call again.", and a store that could not be read gives the message of
[`DocumentStoreError`](./library.md#documentstoreerror), "The document store could not be read
(CODE). Try again." Errors every tool can return, unless a row names the tools:

| Error | When |
|---|---|
| `document_id is required.` | `document_id` is missing or blank. |
| `Unknown document_id ID. Use one of: doc_… ("app.log"), ….` | `search_document`, `read_document`, `get_document_overview`, `analyze_whole_document`: the ID is not one of the tool set's documents. Up to 20 usable IDs are listed, each with its file name, and `…` when there are more. |
| `Unknown document_id ID. No attached file is read with this tool in this conversation.` | `search_document`, `read_document`, `get_document_overview`, `analyze_whole_document`: the tool set has no document for these tools. |
| `ID is no longer available on the server. Ask the user to attach the file again.` | The document was deleted or expired after the request was planned. |
| `Unknown tool NAME.` | The name is not a tool of this tool set. |

**Size.** One result is at most `toolResultCharacters` characters of JSON (a field of
[`Budget`](./library.md#budget): 24,000 with the default budget, less for a model with a small
window). The answer of `analyze_whole_document` may have up to the larger of that and 40,000.
`view_pages` returns a short JSON result and is limited in pages and bytes instead. A loop can
lower the cap of one call with [`ToolCallLimits.maxResultCharacters`](#toolcalllimits), never below
600 characters. A result that is too large is cut, and says so:

- A list (the matches or passages of a search, the outline of an overview) loses entries from its
  end, keeping at least one, and its `note` becomes "Showing K of N results to stay within the size
  limit. Narrow the query or read specific lines." This replaces any other note.
- When even one entry is too large, the result becomes
  `{ "truncated": true, "partial": "<the start of the result as JSON text>", "note": "Result cut to the size limit. Ask for a smaller range." }`.
- `read_document` shortens its range instead, and `analyze_whole_document` cuts the end of its
  answer. See their sections.

**Page numbers.** For a PDF whose pages `view_pages` can show in this tool set, search and read
results also carry page numbers, since a page number is what `view_pages` takes: `page` on a
matching line, `pages` (`"12"` or `"12-14"`) on a passage and on a read. They come from the
`--- Page N ---` lines the PDF extractor writes, counting up from 1. Other documents get no page
fields.

## `search_document`

The description the model sees:

> Search a large attached file. mode "keywords" returns the most relevant passages for a question;
> "exact" returns every line containing the text; "regex" returns lines matching a JavaScript
> regular expression. Results include line numbers to read further with read_document.

| Argument | Type | Required | Default and limits | Meaning |
|---|---|---|---|---|
| `document_id` | string | yes | | The `document_id` from the file's card. |
| `query` | string | yes | Not blank (`query is required.`) | Keywords, exact text, or a regex, by `mode`. |
| `mode` | `"keywords"` \| `"exact"` \| `"regex"` | no | `"keywords"` | How to search. |
| `max_results` | integer | no | keywords: 5, from 1 to 10. exact and regex: 20, from 1 to 50 | Passages, or matching lines, returned. It does not limit the count. |
| `context_lines` | integer | no | 0, from 0 to 5 | exact and regex: lines shown before and after each match. |
| `case_sensitive` | boolean | no | `false` | exact and regex: match case. Keywords never do. |

**`keywords`** ranks passages with BM25, computed at query time from substring hits: no index, any
language.

- The query is lowercased and split at anything that is not a letter, a digit or `_`. Terms of
  fewer than 2 characters and common English and Hebrew words are dropped; at most 12 distinct
  terms are kept. A term also matches inside longer words: "timeout" matches "timeouts".
- A passage is a run of whole lines of about 1,500 characters, or 40 lines at most. A passage that
  contains the whole query as a phrase (more than one term, up to 200 characters) is ranked higher.
- Passages come best first. `score` is rounded to two decimals and only orders the results.
- A query with no usable term, or with no hit, returns no passage and the note "No passage contains
  these keywords. Try other words, synonyms, or exact mode."

**`exact`** finds every line that contains the text. A line counts once, however many times it
contains the text. A text with a line break matches across lines and counts on the line where it
starts. The scan stops after 1,000,000 matching lines.

**`regex`** tests a JavaScript regular expression against each line on its own, so a match cannot
span lines. It runs with the `i` flag unless `case_sensitive` is `true`, and with the `u` flag when
the pattern is valid with it (so `\p{L}` means a letter); a pattern valid only without it, such as
`[\w-.]`, runs without it. Limits:

| Limit | Value | When it is reached |
|---|---|---|
| Pattern length | 300 characters | Refused: `Regex is longer than 300 characters.` |
| Nested quantifier, such as `(a+)+` | Refused up front | `Regex has a nested quantifier like (a+)+, which can hang on large files. Simplify it.` |
| Invalid pattern | | `Invalid regex: ` and the engine's message. |
| One search | 3,000 ms of matching, or what is left of the tool set's time when that is less | The scan stops; the result has the lines found so far and the note below. |
| A line the pattern cannot get past | Two whole slices of 250 ms on the same line | The scan stops there, the same way. |
| All regex searches of one tool set | [`REGEX_BUDGET_MS`](#regex_budget_ms), 6,000 ms | Each later regex search fails: `The time for regex searches is used up for this answer. Search with mode "exact" or "keywords" instead.` |

A regex scan runs in slices of 250 ms with other work of the server in between, and the regex
searches of one tool set run one after another, even when the calls of a turn run together. See
[Security](../security.md) for why.

Results of `exact` and `regex`:

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `mode` | `"exact"` \| `"regex"` | The mode that ran. |
| `total_matching_lines` | number | Every matching line in the file, not only those shown. This is the number to count with. |
| `note` | string, optional | "The scan stopped early; the total is a lower bound." when the scan stopped (1,000,000 lines, or a regex limit), or the size-limit note. |
| `matches` | array | The first `max_results` matching lines, in file order. |
| `matches[].line` | number | The line number. |
| `matches[].page` | number, optional | The page of the line, for a PDF whose pages can be shown. |
| `matches[].text` | string | The line. A line longer than 400 characters is cut to 400 around the match, with `…` where it was cut. |
| `matches[].before`, `matches[].after` | string[], optional | With `context_lines` above 0: the lines around the match, as `"1202\| text"`, each cut to 400 characters. |

```json
{
  "document": "app.log",
  "mode": "exact",
  "total_matching_lines": 51,
  "matches": [
    {
      "line": 1203,
      "text": "2026-05-01 12:00:03 ERROR payment-service: timeout after 1203ms calling ledger",
      "before": ["1202| 2026-05-01 12:00:02 INFO request 1202 ok"],
      "after": ["1204| 2026-05-01 12:00:04 INFO request 1204 ok"]
    }
  ]
}
```

Results of `keywords`:

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `mode` | `"keywords"` | |
| `passages` | array | The best passages, best first. |
| `passages[].lines` | string | `"412-436"`: the passage's first and last line. |
| `passages[].pages` | string, optional | `"37"` or `"37-38"`, for a PDF whose pages can be shown. |
| `passages[].score` | number | The BM25 score, rounded to two decimals. |
| `passages[].text` | string | The passage's lines, numbered (`"412\| text"`), one a line. |
| `note` | string, optional | The no-passage note, or the size-limit note. |

## `read_document`

The description the model sees:

> Read a range of lines from a large attached file, with line numbers. Up to 600 lines per call;
> long results are cut and tell you where to continue.

| Argument | Type | Required | Default and limits | Meaning |
|---|---|---|---|---|
| `document_id` | string | yes | | The document to read. |
| `start_line` | integer | yes | Clamped to 1 through the last line; 1 when it is missing | First line to read, 1-based. |
| `end_line` | integer | no | `start_line + 199`; clamped to `start_line` through `start_line + 599` and the last line | Last line to read. |

The numbered text must fit in the cap less 500 characters, as JSON. When it does not, the range is
shortened (to 70% of its length, step by step) until it fits, and `next_start_line` says where to
go on. When one line alone is longer than that, its text is cut to half of that room and
`text_cut` is `true`.

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `lines` | string | `"1200-1399"`: the lines shown, which may be fewer than asked. |
| `pages` | string, optional | The pages those lines are on, for a PDF whose pages can be shown. |
| `total_lines` | number | The lines of the whole file. |
| `text` | string | The lines, numbered (`"1200\| text"`), one a line. |
| `text_cut` | `true`, optional | The one line shown was cut: its end is missing. |
| `next_start_line` | number, optional | The first line not shown, when the file goes on. |
| `note` | `"End of file."`, optional | Instead of `next_start_line`, when the last line shown is the file's last. |

```json
{ "document": "app.log", "lines": "1200-1399", "total_lines": 5000, "text": "1200| ...\n1201| ...", "next_start_line": 1400 }
```

## `get_document_overview`

The description the model sees:

> Get the full outline (headings with line numbers), log profile (levels, time range, most
> frequent errors), and the first and last lines of a large attached file.

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `document_id` | string | yes | The document. |

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `format` | string | The [`DocumentFormat`](./library.md#documentformat): `"log"`, `"pdf"`, `"csv"`, and so on. |
| `size` | string | The size of the uploaded file: `"512 B"`, `"340 KB"`, `"61.2 MB"`. |
| `lines` | number | The lines of the extracted text. |
| `estimated_tokens` | number | The library's token estimate of the text. |
| `pages` | number, optional | The page count of a PDF, or the slide count of a PPTX. |
| `parts_for_whole_document_analysis` | number | About how many parts a whole-file read would take, estimated from the metadata, to within a part or two. The read itself counts them. |
| `whole_document_analysis` | string, optional | "Not available for this file: it would take about N parts, and the limit is M. Use search_document and read_document." when the estimate is above `maxMapChunks`. |
| `log_profile` | [`LogProfile`](./library.md#logprofile), optional | For a log: the count of each level, the first and last timestamps, and up to 15 problems (WARN, ERROR and FATAL message shapes: `template`, `level`, `count`, `firstLine`), FATAL first, then ERROR, then WARN, the most frequent first within each. |
| `first_lines` | string | The first 30 lines, numbered. |
| `last_lines` | string | The last 20 lines, numbered; `""` when the file has 30 lines or fewer. |
| `outline` | string[] | One entry a heading: `"L12 Title"`, with two more spaces before the title for each level below the shallowest heading (`"L40   Install"`). It is the outline stored at ingest: at most 400 headings. When a file has more, the outline keeps its top-level headings alone if there are 20 or more of them, and all its headings otherwise. With 20 to 400 top-level headings, each one is kept once, in order. More than 400 are cut to 400, taken at even steps across the file (see [`OutlineEntry`](./library.md#outlineentry)). Cut from its end to fit the cap. |

## `analyze_whole_document`

The description the model sees:

> Read an entire large file in parts and answer a task that needs all of it, such as a full
> summary, a timeline, or items that must be judged by meaning. To count or list lines that
> contain a word, an ID or a pattern, use search_document in exact or regex mode instead: its
> count is exact, and this can miss items. Slow and costly: prefer search_document and
> read_document for specific questions.

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `document_id` | string | yes | The document. |
| `task` | string | yes | What to find or produce from the whole file, stated completely. Not blank (`task is required.`). |

The file is split into parts of up to `mapChunkTokens` tokens (and 80% of `maxRequestBytes`), 4 are
read at a time with the `generate` function of the tool set, their notes are merged, and one answer
is written from them. A part the model refuses as too large is read as two halves, while
`maxMapChunks` and [`ToolCallLimits.maxRequests`](#toolcalllimits) allow it. The steps, output
limits and retries are in [How it works](../how-it-works.md); what a read costs is in
[Costs and limits](../guides/costs-and-limits.md).

Each document may be read whole [`MAX_WHOLE_DOCUMENT_READS`](#max_whole_document_reads) times (1)
by one tool set, which is one question in `askWithFiles`. Set it with `limits.wholeDocumentReads`
in [`AskLimits`](./ask.md#asklimits), or `maxWholeDocumentReads` in
[`ToolOptions`](./library.md#tooloptions). A read is counted when it starts, so two calls in one
turn do not both pass.

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `parts_read` | number | The parts the file was read in, those that could not be read included; a part read as two halves counts as two. |
| `parts_with_relevant_content` | number | The parts that were read and held something for the task. |
| `parts_that_failed` | number, optional | Parts that could not be read. The notes name each one: "[This part could not be read: reason]". |
| `notes_cut_short` | number, optional | Notes of parts, and merges of notes, that stopped at the output limit or were cut off by the provider. |
| `answer_cut_short` | `true`, optional | The final answer stopped at its output limit. |
| `notes_only` | `true`, optional | The last step, which writes one answer from the notes, failed: `answer` is the notes of the parts, with their line citations. |
| `note` | string, optional | With `notes_only`: "The last step of this read, which writes one answer from the notes of the parts, failed (REASON). The answer is those notes: answer from them.", plus "Some of them were cut off at the output limit, so they are incomplete: tell the user." when some were. Otherwise, when notes or the answer were cut short: "Incomplete: the model's output limit was reached, so some relevant items are missing from this answer. Tell the user it is incomplete. For a complete list or an exact count, use search_document in exact or regex mode (it returns total_matching_lines), or ask about a narrower part of the file." |
| `answer` | string | The answer. When no part held anything relevant: "No part of NAME contained anything relevant to: TASK", with the count of parts that could not be read, if any. |
| `answer_shortened` | string, optional | "The rest of this answer did not fit in the room left in this conversation." The answer was cut at its end, which then reads `…`. |

```json
{ "document": "novel.txt", "parts_read": 4, "parts_with_relevant_content": 3, "answer": "Ada appears first in chapter 2 (L412) ..." }
```

Errors:

| Error | When | Counted as a read |
|---|---|---|
| `NAME was already read whole for this question, and is not read whole again. Use the answer of that read, or search_document and read_document for the details.` | The document was read whole as often as it may be (" N times" is added when that is more than 1). | no |
| `Whole-file reads are turned off for this question. Use search_document and read_document on NAME.` | `maxWholeDocumentReads` (or `limits.wholeDocumentReads`) is 0. | no |
| `The whole-file read of NAME failed earlier in this question (REASON), and is not tried again. Use search_document and read_document.` | An earlier read of it could read no part. | no |
| `Reading all of NAME needs N model calls, over the limit of M. Use search_document to narrow the question first.` | The read counted more parts than `maxMapChunks`. Nothing was sent. | no |
| `Could not read any part of NAME: REASON` | Every part failed at the model. | yes |
| The store's error | No part could be read from the store. Nothing was sent. | no |

## `view_pages`

The description the model sees:

> Look at pages of an attached PDF as they are printed. Use it when the answer depends on
> something the text of the file cannot show: a picture, photo, chart, diagram, map, handwriting,
> a stamp or signature, or how a page is laid out. It is not for reading text. Up to 5 pages per
> call.

| Argument | Type | Required | Default and limits | Meaning |
|---|---|---|---|---|
| `document_id` | string | yes | | The `document_id` of the PDF. |
| `from_page` | integer | yes | 1 or more; not clamped | First page, 1-based: the N of the `--- Page N ---` lines in the text. |
| `to_page` | integer | no | `from_page`. A page past the end is taken as the last page | Last page. One call shows at most [`MAX_VIEW_PAGES`](#max_view_pages) (5) pages, fewer when the call's `maxPages` is lower. |

The pages are cut out of the kept original into one small PDF, and returned as a file next to a
short JSON result. Only [`ToolSet.executeWithFiles`](#toolset) returns the file; `execute` answers
with an error. Pages are left off the end until the file fits the call's `maxFileBytes`. Cutting
needs the optional dependency `@cantoo/pdf-lib`. How pages are cut and counted, and what they cost,
is in [PDFs](../guides/pdfs.md).

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `pages` | string | The pages shown: `"12"` or `"12-14"`. |
| `total_pages` | number | The pages of the PDF. |
| `file` | string | The name of the file returned with the result: `"pages-12-14.pdf"`. |
| `next_page` | number, optional | The first page asked for and not shown, when it can still be looked at. |
| `note` | string, optional | Why fewer pages were shown than asked (see below). |

When fewer pages were shown than asked, the note is one of:

- "Showing S of the W pages asked for: the others did not fit in this request. Call view_pages from
  page N if you need them." (with `next_page`)
- "Showing S of the W pages asked for: one call shows at most 5. Call view_pages from page N if you
  need them." (with `next_page`)
- "Showing S of the W pages asked for: no more pages can be looked at for this question." (no
  `next_page`: the call's `maxPages` was the limit)

The file is `{ name: "pages-12-14.pdf", mimeType: "application/pdf", bytes }` (a
[`ToolFile`](#toolfile)).

```json
{ "document": "report.pdf", "pages": "2-3", "total_pages": 6, "file": "pages-2-3.pdf" }
```

Errors, besides those of [every tool](#rules-for-every-tool):

| Error | When |
|---|---|
| `Unknown document_id ID. Use the document_id of an attached PDF.` | The ID is not a PDF this tool set can show. |
| `The pages of NAME cannot be shown: only its text was kept. Answer from the text.` | A document the text tools can read whose pages cannot be shown: not a PDF, or its original is not kept. |
| `from_page must be a page number: 1 or higher.` (or `to_page`) | Not a number, or below 1. |
| `to_page (T) is before from_page (F).` | |
| `NAME has N pages. There is no page F.` | `from_page` is past the last page. |
| `No more pages can be looked at for this question. Answer from the pages and the text you already have.` | The call's `maxPages` is below 1. |
| `There is no room left in this request to show more pages. Answer from the pages and the text you already have.` | The call's `maxFileBytes` is below 1,024. |
| `The original file of NAME is no longer on the server, so its pages cannot be shown. Answer from the text.` | The store no longer has the original. |
| `NAME: Page F is 2.1 MB as a file, more than the 1.5 MB that fit in this request.` | The first page alone does not fit `maxFileBytes`. |
| `NAME: ` and the reason | The file cannot be cut: it needs a password, is damaged, declares too many objects to cut in memory, has another page count than its text, has no page `from_page` (when its page count was not recorded), or `@cantoo/pdf-lib` is not installed. |
| `The pages could not be shown: this application does not pass files from tools to the model. Answer from the text.` | The call was run with `execute`, which has no place for a file. |

## The tool guide

When any document is searchable or has pages to look at, the planned request carries a tool guide
for the system instruction (`PreparedContext.instruction`; `askWithFiles` adds it, and a loop of
your own adds it to its system prompt). In short, it tells the model:

- which files are too large for its context, by name (quoted, so a name cannot read as an
  instruction) and `document_id`, and that it sees only a card of each;
- what each text tool is for, and this rule: "To count or list what can be matched as text (a word,
  an ID, an error code, a log level, a pattern), use search_document in exact or regex mode: its
  total_matching_lines is exact.";
- to read around search hits before relying on them;
- to use `analyze_whole_document` only when the task needs all of the file and cannot be done by
  matching text (a full summary, a timeline, items judged by meaning), and that it is slow, costly,
  and can miss items of a long list. This line is left out when `prepare` gets
  `wholeDocumentAnalysis: false` (`askWithFiles` passes it when its own `wholeDocumentAnalysis` is
  `false` or the model that explores has no `generateText`), or when no searchable file can be read
  whole;
- that its tool turns are limited: call several tools in one turn when they do not depend on each
  other, and answer as soon as it has enough evidence;
- to base the answer on text it read, cite line numbers like `(app.log L1203)`, and say so when the
  tools did not find something.

For PDFs whose pages can be shown, it names each one with its `document_id` and page count, and
says to use `view_pages` when the answer depends on a picture, chart, diagram, map, handwriting, a
stamp or signature, or the layout of a page; that a page is worth a look when its text says it has
a picture, has no text, or mentions a figure; that page numbers are the N of the `--- Page N ---`
lines; not to read text with it; and not to describe a picture it has not looked at.

The counting rule is also in the description of `analyze_whole_document`, and in the note of a
whole-file read that came out incomplete.

## What `askWithFiles` adds to results

The tools above answer one call. The loop of [askWithFiles(options)](./ask.md#askwithfilesoptions)
adds to their results, and answers some calls without running them. A loop of your own does none
of this unless you write it.

- **`tool_turns_left`.** Every result the loop sends has this field when it is first sent: the tool
  turns left after this one, or 0 when the request has no room left. A stand-in that later
  replaces the result, and the stand-in kept in `toolTurns` for a look at pages, do not have it.
- **A call made again.** A call whose result is still in the conversation in full (the same
  search with the same arguments as the tool reads them, the same overview, the same read, or a
  read of lines inside a read shown in full), in this question or in the tool rounds of an earlier
  one passed back in `messages`, is not run. Its result is a pointer, and its step ends
  " — already shown above":
  - `{ "document": "app.log", "already_shown": true, "note": "Not run: this exact call was answered earlier in this conversation, and its result is still shown above in full. The file has not changed, so it would return the same. Use that result. For more, read other lines, or search with other words or another mode." }`
  - For a read inside an earlier read: `{ "document": "app.log", "lines": "150-200", "already_shown": true, "note": "Not run: lines 150-200 are already shown above in full, in the result that has lines 100-299 of this file, and the file has not changed. Use them. To see more, read other lines." }`
  - For the same call twice in one turn: `{ "already_shown": true, "note": "Not run: call 1 of this turn is the same call, and its result is next to this one. Use it." }`

  A result of an earlier turn that failed, was cut (`truncated`, `text_cut`, a "Showing …" note),
  came from a search that stopped early, or is itself a pointer or a stand-in is never pointed to:
  the call runs, and may get more. The same call made twice in one turn gets the pointer to the
  first whatever the first returns (an error, a cut result, a pointer); only when the first is
  refused for lack of room is the second refused the same way. Whole-file reads and looks at pages
  are never pointed to.
- **Stand-ins.** When the request runs short of room, the results of older tool rounds are replaced
  by the short stand-ins of [`stubResult`](./ask.md#stubresultcall-result-hadfiles), with
  `"dropped": true`; when and how is in [How it works](../how-it-works.md), and nothing is replaced
  when any model of the question is append-only (Claude). A pointer whose result was replaced
  becomes
  `{ "document": "app.log", "dropped": true, "note": "Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it." }`.
  In `toolTurns`, the result of a look at pages is kept as its stand-in, since the file is not
  kept.
- **A hint after two failed searches.** When two `search_document` calls in a row fail in the
  same mode, the error of the second (and of any after it) ends with a hint. For `regex`: "Two
  regex searches in a row failed. Try mode "exact" with a plain word or ID from the file, or mode
  "keywords"." For the other modes: "This search failed twice in a row. Check the arguments against
  the tool's description, or answer from what you have." A call of another tool, or a search that
  works, starts the count again.
- **A share of the room.** Before the calls of a turn run, the room left in the request is shared
  among those that run and return text, and each gets its share as `maxResultCharacters`. A
  whole-file read is the exception: its answer is not cut up front; once the other results of the
  turn are in, it is cut to the room they left. A look at pages is not in the share: it gets
  `maxFileBytes` and `maxPages` instead (see [`ToolCallLimits`](#toolcalllimits)). How the room
  is shared is in [How it works](../how-it-works.md#room-in-the-request).
- **Calls that are not run**, each answered with an `error`:
  - past `limits.callsPerTurn` (8): "Not run: one turn runs at most 8 tool calls. Send this call
    again if you still need it.";
  - when there is not enough room left for the call: "Not run: there is no room left in this
    conversation for another tool result. Answer now, from what the tools returned so far.";
  - a call whose arguments did not arrive whole (`ToolCall.problem`, set by the adapter), such as
    "The arguments of this call were not valid JSON, and it was not run: … Send the call again.";
  - a whole-file read that would pass `limits.inputTokens` or `limits.requests`: "Not run: reading
    all of NAME takes about N input tokens, and M are left of the L this question may use. Use
    search_document and read_document." (or "model requests ... this question may make").
- **Steps.** Each call that runs starts an `onActivity` line, its `describe()` label and `…`.
  Each call up to `callsPerTurn` ends with a step, in `onStep` and `steps`: the label and
  [toolResultSummary(label, result)](#toolresultsummarylabel-result), or the label and
  " — already shown above" for a pointer. The calls past it share one step: "N more tool calls in
  this turn were not run (at most 8 a turn)". See [Web app](../guides/web-app.md) for showing them.

The regex time of a question is always [`REGEX_BUDGET_MS`](#regex_budget_ms) in `askWithFiles`: it
has no option for it.

## Exports

### `TOOL_NAMES`

The names of the five tools, as constants.

```ts
const TOOL_NAMES = {
  search: "search_document",
  read: "read_document",
  overview: "get_document_overview",
  analyze: "analyze_whole_document",
  view: "view_pages",
} as const;
```

Compare a `ToolCall.name` with these rather than with string literals. See
[Your own adapter and loop](../guides/own-adapter-and-loop.md).

### `MAX_VIEW_PAGES`

`5`. The most pages one `view_pages` call shows. [`ToolCallLimits.maxPages`](#toolcalllimits)
can only lower it. See [PDFs](../guides/pdfs.md).

### `MAX_WHOLE_DOCUMENT_READS`

`1`. How many times one tool set reads each document whole, unless `maxWholeDocumentReads` in
[`ToolOptions`](./library.md#tooloptions) (or `limits.wholeDocumentReads` in
[`AskLimits`](./ask.md#asklimits)) says otherwise. One read of a large file is up to
`maxMapChunks` part requests, plus the requests that merge their notes and the one that writes its
answer. See [Costs and limits](../guides/costs-and-limits.md).

### `REGEX_BUDGET_MS`

`6_000`. The milliseconds the regex searches of one tool set may take together, unless
`regexBudgetMs` in [`ToolOptions`](./library.md#tooloptions) says otherwise. One search still stops
after 3,000 ms of matching, and after two 250 ms slices that cannot get past the same line (see
[the regex limits](#search_document)). See [Security](../security.md).

### toolResultSummary(label, result)

`toolResultSummary(label: string, result: ToolResult): string`

What a finished call found, as a suffix for its `describe()` label in a list of steps. It never
throws.

| The result has | The suffix |
|---|---|
| `error` | ` — failed:` and the error, as in ` — failed: Unknown tool do_magic.` |
| `total_matching_lines` (exact, regex) | ` — 1,203 matching lines` (numbers in en-US form) |
| `passages` (keywords) | ` — 5 passages` |
| `parts_read` (whole-file read) | ` — 9 parts, 3 relevant`, then `, notes only` with `notes_only`, or `, incomplete` with `notes_cut_short` or `answer_cut_short` |
| `lines` and `total_lines` (read) | ` — got 1200-1342` when the label does not end with the lines shown, else `""` |
| `pages` and `total_pages` (view_pages) | ` — got page 2` or ` — got pages 2-3` when the label does not end with the pages shown, else `""` |
| anything else (an overview, a cut result) | `""` |

```ts
import { toolResultSummary } from "llm-large-files";

const label = "Search app.log (exact) for “timeout”";
const step = label + toolResultSummary(label, { document: "app.log", mode: "exact", total_matching_lines: 1203, matches: [] });
// "Search app.log (exact) for “timeout” — 1,203 matching lines"
```

`askWithFiles` makes its steps this way. See [Web app](../guides/web-app.md).

### `ToolSet`

The tools of one question, scoped to a set of documents. You get one from `files.tools(documents,
options)` (see [`LargeFiles`](./library.md#largefiles) and [`ToolOptions`](./library.md#tooloptions));
`askWithFiles` makes one per question. Make one per question in your own loop too: the regex time
and the whole-file reads are counted per tool set.

```ts
type ToolSet = {
  declarations: ToolDeclaration[];
  has(name: string): boolean;
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  executeWithFiles(name: string, args: Record<string, unknown>, limits?: ToolCallLimits): Promise<ToolOutput>;
  describe(name: string, args: Record<string, unknown>): string;
  resultCharacters(name: string): number;
};
```

| Member | What it does |
|---|---|
| `declarations` | The tools to declare to the model, in this order: `search_document`, `read_document`, `get_document_overview`, `analyze_whole_document`, `view_pages`, those that are [offered](#which-tools-are-offered). |
| `has(name)` | `true` for each declared tool. Also `true` for `analyze_whole_document` when `generate` was given and the text tools are declared, even if it is not declared because no document is small enough: a call then gets the reason. Use it to tell the calls of this tool set from others. |
| `execute(name, args)` | Runs a call and returns its JSON result, within the tool's own cap. Failures come back as `{ error }`, as listed above. `view_pages` answers with an error here: it returns a file. |
| `executeWithFiles(name, args, limits?)` | Runs any call with [`ToolCallLimits`](#toolcalllimits), and returns the result with the files it produced (`files` is empty for every tool but `view_pages`). Use it in a loop that can send files to the model. |
| `describe(name, args)` | A short line for a progress UI, read from the arguments the way the tool reads them: `Search app.log (exact) for “timeout”` (the query cut to 80 characters), `Read app.log lines 1200-1260` (`-1260` only when `end_line` is a number not below `start_line`), `Overview of app.log`, `Read all of novel.txt for “list every character”` (the task cut to 100 characters), `Look at report.pdf pages 2-3`. A file not yet known is "the file"; an unknown tool is its name. |
| `resultCharacters(name)` | The most characters of a result of this tool: the larger of `toolResultCharacters` and 40,000 for `analyze_whole_document`, 600 for `view_pages` (its file is counted in bytes), and `toolResultCharacters` for any other name. What a loop sets aside in its request before it runs a call. |

`execute` and `executeWithFiles` throw only when the tool set's `signal` was aborted: the error
that ended the call is thrown again instead of being returned to the model.

A turn of your own loop, run with the tool set. `files` is your
[`LargeFiles`](./library.md#largefiles), created once with
[createLargeFiles(options)](./library.md#createlargefilesoptions):

```ts
import { DocumentsNotFoundError, toolResultSummary } from "llm-large-files";
import type { ToolAnswer, ToolCall } from "llm-large-files";

const documentIds = ["doc_0123456789abcdef0123456789abcdef"];
// The size of everything else in the request: system prompt, messages.
const base = { tokens: 2_000, bytes: 8_000 };
const prepared = await files.prepare(documentIds, base, {
  owner: "user-42",
  viewPages: true,
  // The tool set below has no generate. This keeps the instruction from naming
  // analyze_whole_document, and the cards from offering a whole-file read.
  wholeDocumentAnalysis: false,
});
// A document that is gone (expired, or another owner's) is left out of the plan: say so, as askWithFiles does.
if (prepared.missing.length > 0) throw new DocumentsNotFoundError(prepared.missing);
const tools = files.tools(prepared.plan.searchable, { viewPages: prepared.viewable });
// Send prepared.instruction with your system prompt, and tools.declarations as the tools.

async function runCalls(calls: ToolCall[], roomCharacters: number, roomBytes: number): Promise<ToolAnswer[]> {
  const answers: ToolAnswer[] = [];
  for (const call of calls) {
    // Arguments that did not arrive whole: tell the model, and do not run the call.
    if (call.problem) {
      answers.push({ call, result: { error: call.problem } });
      continue;
    }
    const label = tools.has(call.name) ? tools.describe(call.name, call.args) : call.name;
    const { result, files: pages } = await tools.executeWithFiles(call.name, call.args, {
      maxResultCharacters: roomCharacters,
      maxFileBytes: Math.floor(roomBytes * 3 / 4), // base64 turns three bytes into four
    });
    console.log(`${label}${toolResultSummary(label, result)}`);
    answers.push({ call, result, files: pages });
  }
  return answers;
}
```

Send each answer back in your provider's form, its files with it. The whole loop, with sizing,
limits and each provider's converters, is in
[Your own adapter and loop](../guides/own-adapter-and-loop.md).

### `ToolCallLimits`

What one call may use of the request its result will be sent in: the third argument of
`executeWithFiles`. Every field is optional.

```ts
type ToolCallLimits = {
  maxFileBytes?: number;
  maxPages?: number;
  maxResultCharacters?: number;
  maxRequests?: number;
};
```

| Field | Type | Default | What it does |
|---|---|---|---|
| `maxFileBytes` | number | 3/8 of (`maxRequestBytes` − 262,144): 3,651,696 bytes with the default budget | `view_pages`: the most bytes its file may have. Pages are left off the end until the cut fits. Below 1,024 the call fails. Give the room left in your request, times 3/4 when you send files as base64. |
| `maxPages` | number | [`MAX_VIEW_PAGES`](#max_view_pages) (5) | `view_pages`: the most pages this call may show, never more than 5. Below 1 the call fails. Lower it as the pages already shown use up your token budget. |
| `maxResultCharacters` | number | The tool's own cap ([`resultCharacters`](#toolset)) | The most characters of the JSON result, when that is less than the tool's cap: the room left in the request. The result is cut to it and says where to go on. Never below 600. `view_pages` ignores it. |
| `maxRequests` | number | No limit | `analyze_whole_document`: the most model requests the read may make. It does not stop the read: a part the model refuses as too large is read as two halves only while this and `maxMapChunks` allow it (the parts, a merge and the answer must fit). New in 0.6.0. |

In `askWithFiles`, `maxFileBytes` is what is left of `maxRequestBytes` after the request so far
and a tenth kept free (256 KiB at least), times 3/4; `maxPages` is what is left of
`reservedTokens / 2 / pageTokens` pages for the question (60 with a `reservedTokens` of 64,000 and
Gemini's 530 tokens a page); `maxRequests`, when `limits.requests` is set, is the read's own
requests and a share of what the question has left of it. See
[Your own adapter and loop](../guides/own-adapter-and-loop.md).

### `ToolFileLimits`

```ts
type ToolFileLimits = ToolCallLimits;
```

The name of [`ToolCallLimits`](#toolcalllimits) before 0.5.0, kept so that older code compiles.
Use `ToolCallLimits`.

### `ToolOutput`

```ts
type ToolOutput = { result: ToolResult; files: ToolFile[] };
```

What `executeWithFiles` returns: a call's JSON result and the files that belong to it.

| Field | Type | Meaning |
|---|---|---|
| `result` | [`ToolResult`](#toolresult) | The JSON result, or `{ error }` for a call that failed. |
| `files` | [`ToolFile`](#toolfile)`[]` | The files of the result. Empty for every tool but `view_pages`, and for a `view_pages` call that failed. |

See [Your own adapter and loop](../guides/own-adapter-and-loop.md).

### `ToolFile`

```ts
type ToolFile = {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
};
```

| Field | Type | Meaning |
|---|---|---|
| `name` | string | A short ASCII name, unique among the files of one result: `"pages-12-14.pdf"`. The result's `file` field names it. |
| `mimeType` | string | `"application/pdf"` for `view_pages`. |
| `bytes` | `Uint8Array` | The file. Send it to the model in your provider's form; it is not kept in `toolTurns`. |

See [PDFs](../guides/pdfs.md).

### `ToolResult`

```ts
type ToolResult = Record<string, unknown>;
```

A tool's JSON result: an object whose fields are listed for each tool above, or `{ error: string }`
for a call that failed. Send it to the model as it is. To read one in code, test for the fields
(`error`, `already_shown`, `dropped`, `truncated`, `total_matching_lines`) rather than the wording
of notes. See [Your own adapter and loop](../guides/own-adapter-and-loop.md).

### `ToolDeclaration`

```ts
type ToolDeclaration = {
  name: string;
  description: string;
  parameters: JsonSchema & { type: "object" };
};
```

A tool as it is declared to the model. Every provider takes this form, or one made from it by its
adapter (`toGeminiTools` in the [Gemini reference](./gemini.md)).

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The tool's name: for the tools of a tool set, one of [`TOOL_NAMES`](#tool_names). |
| `description` | string | The description the model sees, quoted in the tool's section above. |
| `parameters` | [`JsonSchema`](#jsonschema) with `type: "object"` | The arguments: `properties` and `required`, as in the tool's argument table. |

See [Your own adapter and loop](../guides/own-adapter-and-loop.md).

### `JsonSchema`

```ts
type JsonSchema = {
  type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};
```

The subset of JSON Schema that Gemini, OpenAI and Anthropic function declarations all accept, and
the only one the tools use.

| Field | Type | Meaning |
|---|---|---|
| `type` | `"string"` \| `"integer"` \| `"number"` \| `"boolean"` \| `"object"` \| `"array"` | The JSON type of the value. |
| `description` | string, optional | What the value is, for the model. |
| `enum` | string[], optional | The values allowed, such as `mode`'s `"keywords"`, `"exact"` and `"regex"`. |
| `properties` | `Record<string, JsonSchema>`, optional | For an object: its fields. |
| `required` | string[], optional | For an object: the fields that must be given. |
| `items` | `JsonSchema`, optional | For an array: the schema of each item. |

See [Your own adapter and loop](../guides/own-adapter-and-loop.md).

## Stability

[Publishing](../publishing.md) counts the tool names, their arguments and their result fields as
public API, like the documented exports and the HTTP responses of `llm-large-files/node`: changing them is
a breaking change, and the [changelog](../../CHANGELOG.md) names it. While the version is `0.x`, a
minor version (0.7.0) may make breaking changes. Descriptions, notes, error texts and the tool
guide are written for the model and have changed between versions: 0.6.0 changed the guide, so
the provider's prompt cache misses once after upgrading to it. Do not parse them; test for result
fields instead.
