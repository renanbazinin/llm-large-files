# Tools

This page lists the tools the model gets for documents too large for its prompt and for the
pages of PDFs: their names, arguments, results and limits, and the tool exports of `llm-large-files`. Read it when you write a
loop of your own, show `steps` to users, keep `toolTurns`, or want to know exactly what the model
was told and what it read.

```ts
import { declarationsFor, MAX_VIEW_PAGES, MAX_WHOLE_DOCUMENT_READS, REGEX_BUDGET_MS, TOOL_NAMES, toolResultSummary } from "llm-large-files";
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
- Exports: [`TOOL_NAMES`](#tool_names), [declarationsFor(names)](#declarationsfornames), [`MAX_VIEW_PAGES`](#max_view_pages),
  [`MAX_WHOLE_DOCUMENT_READS`](#max_whole_document_reads), [`REGEX_BUDGET_MS`](#regex_budget_ms),
  [toolResultSummary(label, result)](#toolresultsummarylabel-result), [`ToolSet`](#toolset),
  [`ToolCallLimits`](#toolcalllimits), [`ToolFileLimits`](#toolfilelimits),
  [`ToolOutput`](#tooloutput), [`ToolFile`](#toolfile), [`ToolResult`](#toolresult),
  [`ToolDeclaration`](#tooldeclaration), [`JsonSchema`](#jsonschema)
- [Stability](#stability)

Related exports on other pages: [`LargeFiles`](./library.md#largefiles) (its `tools()` method),
[`ToolOptions`](./library.md#tooloptions), [`ToolCallHooks`](./library.md#toolcallhooks) (the
fourth argument of `executeWithFiles`), [`PreparedContext`](./library.md#preparedcontext) and
[`Budget`](./library.md#budget) are in the [library reference](./library.md). `ToolCall`,
`ToolAnswer`, `ToolTurn`, `evidenceOf`, `stubResult` and [`AskLimits`](./ask.md#asklimits) are in
the [loop reference](./ask.md).

## The tools

| Tool | What it does |
|---|---|
| `search_document` | Finds lines that contain a text or match a regex, with an exact count, the first of them and the last one, the last ones, or a count for each group (hour, code, message shape); or the passages that match keywords best. In all of a file or in a range of its lines. |
| `read_document` | Reads a range of lines, numbered, up to 600 a call. |
| `get_document_overview` | The outline, the log profile, the first 30 and last 20 lines, and what a whole-file read would take. |
| `aggregate_table` | Counts, sums, averages, minimums and maximums over the rows of a table (a CSV file, a sheet of a workbook, a `\| cell \|` table), with filters and groups, reading every row. New in 0.8.1. |
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
- `aggregate_table` is offered with them when at least one searchable document may hold a table:
  its format is `csv`, `xlsx`, `docx`, `pptx`, `pdf`, `html` or `markdown`. New in 0.8.1.
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
- `aggregate_table` is declared when at least one of `documents` may hold a table (the formats
  above); a call of it is answered for any document, with "This file has no table to aggregate"
  when it has none.
- `analyze_whole_document` is declared when `options.generate` is given and at least one of
  `documents` is estimated within `maxMapChunks` parts (5% leeway). With `generate` and no such
  document it is not declared, but a call of it is still answered, with the reason. Without
  `generate`, pass `wholeDocumentAnalysis: false` to `prepare`: the tool guide then does not name
  it, and the cards do not offer a whole-file read.
- `view_pages` is declared when `options.viewPages` names at least one PDF whose `originalKept` is
  true and the store has `getOriginal`: `true` means every PDF in `documents`, and a list (such as
  `prepared.viewable`) means exactly those.
- `options.declare` (new in 0.10.0) declares exactly the tools it names, in place of the rules
  above, always in the order search, read, overview, aggregate, analyze, view, whatever the order
  of the list: what [declarationsFor(names)](#declarationsfornames) gives. A chat whose tool set only
  grows declares the tools of its earlier questions too, so a declared tool may have nothing to work
  on: each call of it then answers with the reason, `No attached file has a table: aggregate_table
  needs one.` for `aggregate_table` when no document may hold a table, `No attached file has pages
  to look at: view_pages needs a PDF whose original file is kept. Answer from the text.` for
  `view_pages` with no PDF to look at, and `Whole-document analysis is not enabled.` for
  `analyze_whole_document` without `generate`. It answers those tools and no other: a call of a tool
  it does not name gets `Unknown tool “NAME”.`, and `has(name)` is false, where without `declare`
  `aggregate_table` and (with `generate`) `analyze_whole_document` are answered when not declared.
  With today's set, `declare` gives today's bytes.
- `options.inline` (new in 0.10.0) lists the IDs of documents whose text is in the prompt. Pass
  them among `documents` too, so that the text tools can count and search them;
  `analyze_whole_document` refuses them (see [its errors](#analyze_whole_document)), and
  `wholeReadsLeft` is 0 for them.

## Rules for every tool

**Arguments.** Integers may arrive as numbers or as numeric strings (`"12"`); fractions are cut to
whole numbers; a value that is neither a number nor a numeric string takes the default (an empty or
blank string counts as 0, so it is clamped to the minimum); line numbers and counts out of range
are clamped, not refused. Page numbers are the exception: `view_pages` refuses a page that is not a
number of 1 or more. A `mode` other than `"exact"` or `"regex"` is `"keywords"`, and
`case_sensitive` and `whole_word` are on only when they are `true`, `1`, or the same as text
(`"true"` in any case, or `"1"`), and off for any other value. Until 0.8.0, `case_sensitive: "true"`
was off. An `order` other than `"last"` is `"first"`. A `group_by` that is missing, `null`, `""` or `"none"` counts no groups; any other
value that is not one of its five is refused.

**Scope.** A call reaches only the documents its tool set was made for. A `document_id` outside
them is refused with the IDs the model may use, so that the next call is right (`view_pages`
refuses it with the reason instead, see [its errors](#view_pages)). The tool set does not know who
asks: it compares the owner stored with each document with the `owner` of the metadata it was
given, and answers a document whose stored owner is set and differs as one that is gone. A
document stored without an owner is read whatever the metadata holds: as everywhere, it is open to
anyone who has its ID. Make it from documents you looked up with the user's `owner`, as `prepare`
and `askWithFiles` do (see [Security](../security.md#tool-scoping)).

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
| `ID is no longer available on the server. Ask the user to attach the file again.` | The document was deleted or expired after the request was planned, or its text went while a search or read went through it. Since 0.9.0 the call's hooks are told (`ToolCallHooks.onDocumentGone`), and `askWithFiles` gives a `"document_gone"` notice. |
| `Unknown tool “NAME”.` | The name is not a tool of this tool set. The name is cut at 64 characters, never in the middle of a character. Until 0.6.0: `Unknown tool NAME.`, with the whole name. |

**Store timeouts.** Since 0.10.0 a call does not answer the model when the store did not answer in
time: a [`DocumentStoreError`](./library.md#documentstoreerror) of code `"ETIMEDOUT"` (a store call
past `storeTimeoutMs`, or a system error of that code), or of code `"STORE_STUCK"` (refused at once
because too many store calls of the process are stuck). `execute` and `executeWithFiles` throw it,
from any tool and from any part of a whole-file read, which would otherwise count as a part that
could not be read. The other parts of that read stop then: their requests under way are aborted
through the signal they were sent with, and no part is sent after it. In `askWithFiles` the question then ends with a `run.error`, which
[errorInfoOf(error)](./errors-and-retries.md#errorinfooferror) reads as a 503 to try again, and the model is sent no
new text. Until 0.10.0 the model read "The document store could not be read (ETIMEDOUT). Try
again." and went on, with a store that was not answering. Any other store error is still an error
result for the model.

**A call's own signal.** `ToolCallHooks.signal` (new in 0.10.0, the fourth argument of
`executeWithFiles`) ends that call alone: its load of the document, its search, its regex time, its
whole-file read, its wait for a turn to look at pages, its read of the original, and the check made
once it has read, that the store still holds the document it loaded. It is joined
with the tool set's `signal`. The call throws the signal's reason, as for the tool set's own; the
other calls of the tool set go on.

**Size.** One result is at most `toolResultCharacters` characters of JSON (a field of
[`Budget`](./library.md#budget): 24,000 with the default budget, less for a model with a small
window). The answer of `analyze_whole_document` may have up to the larger of that and 40,000.
`view_pages` returns a short JSON result and is limited in pages and bytes instead. A loop can
lower the cap of one call with [`ToolCallLimits.maxResultCharacters`](#toolcalllimits), never below
600 characters. A result that is too large is cut, and says so:

- A list (the matches or passages of a search, the outline of an overview) loses entries from its
  end, keeping at least one, and its `note` becomes "Showing K of N results to stay within the size
  limit. Narrow the query or read specific lines." The note of a search that stopped early is kept
  before it: "The scan stopped early; the total is a lower bound, and the last match in the file is
  not known. Showing K of N results to stay within the size limit. Narrow the query or read
  specific lines."
- An exact or regex search that read the whole file and has 2 matches or more is cut its own way:
  it loses matches from the end of the first ones, and keeps the last one. With `order: "last"` it
  loses the earliest of the last ones, and keeps the very last; with `group_by` it loses the
  smallest groups, and keeps at least one, and by time the groups it keeps stay in time order (see
  [`search_document`](#search_document)).
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
> "exact" finds the lines that contain the text; "regex" finds the lines that match a JavaScript
> regular expression (\w and \b know the letters of every language). For exact and regex,
> total_matching_lines counts every matching line, and the result shows the first max_results of
> them and the last one; search again from next_from_line for the ones after those shown, or with
> order "last" for the last ones. To count by group (per hour or day, per error code, per message
> shape), pass group_by: the result then counts each group, and shows no lines. from_line and
> to_line search part of the file. Results include line numbers to read further with read_document.

Until 0.6.0 it said that `exact` "returns every line containing the text", while the result showed
the first lines only: a model asked when something last happened named the last line it was shown.
0.8.0 added `from_line`, `to_line`, `order`, `group_by` and `whole_word`, and the sentences that
name them.

| Argument | Type | Required | Default and limits | Meaning |
|---|---|---|---|---|
| `document_id` | string | yes | | The `document_id` from the file's card. |
| `query` | string | yes | Not blank (`query is required.`) | Keywords, exact text, or a regex, by `mode`. |
| `mode` | `"keywords"` \| `"exact"` \| `"regex"` | no | `"keywords"` | How to search. |
| `max_results` | integer | no | keywords: 5, from 1 to 10. exact and regex: 20, from 1 to 50. With `group_by`: 50 groups, from 1 to 200 | Passages, matching lines or groups returned. It does not limit the count. exact and regex also show the last matching line after them, when it is not among them. |
| `context_lines` | integer | no | 0, from 0 to 5 | exact and regex: lines shown before and after each match. None with `group_by`. |
| `case_sensitive` | boolean | no | `false` | exact and regex: match case. Keywords never do. |
| `from_line` | integer | no | 1. Past the last line: refused | Search only from this line on, in every mode. Pass a result's `next_from_line` to see the matches after those it shows. New in 0.8.0. |
| `to_line` | integer | no | The last line. Past it: the last line. Before `from_line`: refused | Search only up to this line, in every mode. New in 0.8.0. |
| `order` | `"first"` \| `"last"` | no | `"first"` | exact and regex: `"last"` shows the last `max_results` matching lines, in file order, in place of the first ones. New in 0.8.0. |
| `group_by` | `"capture"` \| `"minute"` \| `"hour"` \| `"day"` \| `"shape"` | no | none | exact and regex: count the matching lines by group, and show none ([below](#counts-by-group-group_by)). `"capture"` needs mode `regex`. `order` and `context_lines` are ignored with it. New in 0.8.0. |
| `whole_word` | boolean | no | `false` | exact only: match the text only as a whole word, not inside a longer one. Ignored in regex mode, where `\b` does it. New in 0.8.0. |

With `from_line` or `to_line`, the counts are of the lines searched, and the result says which in
`searched_lines` (`"1941-3000"`). In keywords mode, the passages ranked are those with at least one
line in the range, each with all its lines. The errors of these arguments:

| Error | When |
|---|---|
| `from_line 9000 is past the end of the file, which has 3000 lines.` | `from_line` is past the last line. |
| `to_line 20 is before from_line 100.` | `to_line` is before `from_line` (1 when it is not given). |
| `group_by counts the lines of an exact or regex search: use mode "exact" or "regex".` | `group_by` in keywords mode. |
| `group_by "capture" counts by the first group of a regex: use mode "regex" with a group, as in PAY-(\d+).` | `group_by: "capture"` in exact mode. |
| `group_by must be one of "capture", "minute", "hour", "day", "shape".` | Any other `group_by`. |

**`keywords`** ranks passages with BM25, computed at query time from substring hits: no index, any
language.

- The query is composed (NFC) and folded as exact search folds it (see below), then split at
  anything that is not a letter, a mark, a digit or `_`, so a mark stays with its letter (Hindi,
  Bengali, Tamil, Thai, pointed Hebrew). A run of Chinese, Japanese, Thai, Lao, Khmer or Myanmar
  text is split into words with `Intl.Segmenter`. Terms of fewer than 2 characters (a Han or kana
  word may have one) and common English and Hebrew words are dropped; at most 12 distinct terms are
  kept. A term also matches inside longer words: "timeout" matches "timeouts".
- A Hebrew term loses its points. One that starts with prefix letters (ו ה ב כ ל מ ש: בחוזה,
  והחוזה) also searches its stem without them (חוזה), up to three letters off while three are
  left, so passages with the word as written rank first. One that ends in a final letter also
  matches its plain form, as inside a longer word: כסף finds כספים. New in 0.8.0.
- A passage is a run of whole lines of about 1,500 characters, or 40 lines at most. A passage that
  contains the whole query as a phrase (more than one term, up to 200 characters) is ranked higher.
- Passages come best first; of two with the same score, the one nearer the start of the file.
  `score` is rounded to two decimals and only orders the results. Since 0.10.0 the search keeps only
  the best passages as it goes, rather than sorting every passage it scored.
- A query with no usable term, or with no hit, returns no passage and the note "No passage contains
  these keywords. Try other words, synonyms, or exact mode."

**`exact`** finds every line that contains the text. A line counts once, however many times it
contains the text. A text with a line break matches across lines and counts on each line where it
starts, overlapping ones included: "a\na" counts 2 lines of "a\na\na" (1 until 0.8.0). Past
1,000,000 matching lines the scan goes on counting within 3 seconds, the time of a regex search, and
stops there (until 0.10.0 it stopped at 1,000,000, and a count of 1,200,000 lines read 1,000,000); with
`whole_word` or `group_by` it stops after 3 seconds in all. The query is composed (NFC), as the text is at ingest, so
"é" typed as "e" and an accent finds "é". Without `case_sensitive`, both sides are folded: lower
case, Greek final sigma as σ, curly quotes and primes as `'` and `"`, dashes and the minus sign as
`-`, no-break and thin spaces as a space, Hebrew geresh, gershayim and maqaf as `'`, `"` and `-`,
and full-width forms as ASCII. So "don't" finds "don’t", and צה"ל finds צה״ל (new in 0.8.0). With
`whole_word`, a match must not touch a letter, mark, digit or `_` of any script where the text
starts or ends with one.

**`regex`** tests a JavaScript regular expression against each line on its own, so a match cannot
span lines. It runs with the `i` flag unless `case_sensitive` is `true`, and with the `u` flag when
the pattern is valid with it (so `\p{L}` means a letter); a pattern valid only without it, such as
`[\w-.]`, runs without it. With the `u` flag, `\w`, `\W`, `\b` and `\B` know the letters, marks and
digits of every script: `\bחוזה\b` finds the word, and `\w+` does not stop at "é" (new in 0.8.0;
a pattern with `\W` inside a class is run as written). The pattern is composed (NFC) first. The
folds of exact search do not apply. Limits:

| Limit | Value | When it is reached |
|---|---|---|
| Pattern length | 300 characters | Refused: `Regex is longer than 300 characters.` |
| Nested quantifier, such as `(a+)+` | Refused up front, unless each repeat ends at a literal character that none of its quantified parts can match, as in `(\d{1,3}\.){3}\d{1,3}` or `(\w+\.)+com` (accepted since 0.8.0) | `Regex has a nested quantifier like (a+)+, which can hang on large files. Simplify it.` |
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
| `searched_lines` | string, optional | With `from_line` or `to_line`: the lines searched, as `"1941-3000"`. The counts are of those lines. Keyword results have it too. New in 0.8.0. |
| `total_matching_lines` | number | Every matching line in the file (or in `searched_lines`), not only those shown. This is the number to count with. |
| `order` | `"last"`, optional | With `order: "last"` ([below](#the-last-matches-order-last)). |
| `table_headers` | array, optional | When matches are rows of a table: the first row of each such table, as `{ line, text }`, up to 5: line 1 of a CSV file, the first row of each sheet of a workbook a match is in, the first row of each `\| cell \|` table elsewhere (looked for up to 20,000 lines above the match). Absent when no match is a row of a table, or the match is that first row. New in 0.8.1. |
| `note` | string, optional | When more lines match than are shown: "N of the M matching lines are shown: the first K and the last (line L). To see the ones in between, search again with from_line F, or count them with group_by." ("the first and the last" when K is 1). Until 0.8.0 it ended "narrow the search." When the scan stopped (3 seconds past 1,000,000 lines, 3 seconds of a `whole_word` or `group_by` search, or a regex limit): "The scan stopped early; the total is a lower bound, and the last match in the file is not known." Or a size-limit note (below). Absent when every match is shown. |
| `next_from_line` | number, optional | When matches between the first ones and the last one are not shown: the line after the last of the first ones (F above). A search with `from_line` set to it shows the ones after. Absent when every match is shown, when the scan stopped early, with `order: "last"` and with `group_by`. New in 0.8.0. |
| `matches` | array | The first `max_results` matching lines, in file order, then the last matching line of the file when it is not among them. A scan that stopped early shows no last line, since it did not reach the end. With `order: "last"`, the last `max_results` matching lines, in file order. |
| `matches[].line` | number | The line number. |
| `matches[].page` | number, optional | The page of the line, for a PDF whose pages can be shown. |
| `matches[].section` | string, optional | The heading of the outline above the line, up to 80 characters: "2.1 Rent", "Sheet 2: Sales". Absent for logs, JSON and CSV files, and for a document with no outline. New in 0.8.1. |
| `matches[].text` | string | The line. A line longer than 400 characters is cut to 400 around the match, with `…` where it was cut. |
| `matches[].before`, `matches[].after` | string[], optional | With `context_lines` above 0: the lines around the match, as `"1202\| text"`, each cut to 400 characters. |

A search with `max_results: 1` and `context_lines: 1`:

```json
{
  "document": "app.log",
  "mode": "exact",
  "total_matching_lines": 51,
  "note": "2 of the 51 matching lines are shown: the first and the last (line 4987). To see the ones in between, search again with from_line 1204, or count them with group_by.",
  "next_from_line": 1204,
  "matches": [
    {
      "line": 1203,
      "text": "2026-05-01 12:00:03 ERROR payment-service: timeout after 1203ms calling ledger",
      "before": ["1202| 2026-05-01 12:00:02 INFO request 1202 ok"],
      "after": ["1204| 2026-05-01 12:00:04 INFO request 1204 ok"]
    },
    {
      "line": 4987,
      "text": "2026-05-01 13:22:47 ERROR payment-service: timeout after 4987ms calling ledger",
      "before": ["4986| 2026-05-01 13:22:46 INFO request 4986 ok"],
      "after": ["4988| 2026-05-01 13:22:48 INFO request 4988 ok"]
    }
  ]
}
```

When the result is too large for its room, an exact or regex search that read the whole file and
has 2 matches or more loses matches from the end of the first ones, and keeps the last one. Its
note is then one of:

- "Showing N of the M matching lines to stay within the size limit: the first K and the last (line
  L). To see the ones in between, search again with from_line F, or count them with group_by."
  (N is K + 1; "the first and the last" when K is 1), with `next_from_line` F;
- "Showing 1 of the M matching lines to stay within the size limit: the last (line L). Narrow the
  query or read specific lines.", when only the last one fits;
- "Showing 1 of the M matching lines: the last (line L). Narrow the search.", when the last one
  fits only with this shorter note.

When not even that fits, the result is cut as text, as any other (see
[Size](#rules-for-every-tool)), and its `partial` holds the note before the match. A note that starts with
"Showing " marks a result that was cut: a call made again runs again. A result with the note "N of
the M matching lines are shown" is whole, and a call made again gets a pointer to it.

### The last matches: `order: "last"`

New in 0.8.0. With `order: "last"`, an exact or regex search shows the last `max_results` matching
lines, in file order, and no others: unlike a search in the default order, it adds no match from
the other end of the file. When not every match is shown, the note names the line of the last
match and of the first. A search with `max_results: 2`:

```json
{
  "document": "app.log",
  "mode": "exact",
  "total_matching_lines": 51,
  "order": "last",
  "note": "These are the last 2 of the 51 matching lines, in the order of the file: the last match is on line 4987, and the first on line 1203.",
  "matches": [
    { "line": 4410, "text": "2026-05-01 13:12:30 ERROR payment-service: timeout after 4410ms calling ledger" },
    { "line": 4987, "text": "2026-05-01 13:22:47 ERROR payment-service: timeout after 4987ms calling ledger" }
  ]
}
```

To fit its room, it loses the earliest of them first, and keeps the very last. The note is then
"Showing the last N of the M matching lines to stay within the size limit, in the order of the
file: the last match is on line L, and the first on line F. Narrow the query or read specific
lines."

When the scan stopped early (3 seconds past 1,000,000 lines, 3 seconds of a `whole_word` or `group_by` search, or a regex limit), the lines shown are the last of
those it found, and the line of the first match is not named. The note is then "The scan stopped
early; the total is a lower bound. These are the last N matching lines it found, in the order of
the file. There may be later ones, after line L: search again with from_line F." (F is L + 1;
" and to_line T" follows it when the call gave `to_line`, T being the last line searched). Cut to
its room, the second sentence is "Showing the last N matching lines it found to stay within the
size limit, in the order of the file." When L is the last line searched, the last sentence is left
out. When the scan found no matching line before it stopped (a regex out of time), the note is
"The scan stopped early, out of time, before it found a matching line: the lines it did not reach
may have some. Try a simpler pattern, mode "exact", or fewer lines with from_line and to_line."
Like every note that starts with "The scan stopped early", it marks a result that a call made
again runs again: a later question has time of its own.

### Counts by group: `group_by`

New in 0.8.0. With `group_by`, an exact or regex search counts its matching lines by group, and
shows no line. One call answers "how many errors per hour" or "which codes, how often":

| `group_by` | The key of a line |
|---|---|
| `"capture"` | The text of the regex's first group: `PAY-(\d+)` counts each code. A line where that group took no part has no key. Regex mode only. |
| `"minute"`, `"hour"`, `"day"` | The first timestamp on the line, as written there (an offset such as `+02:00` or `Z` is not applied): `"2026-11-10 14:03"`, `"2026-11-10 14:00"`, `"2026-11-10"`. Read: ISO 8601 (`2026-11-10T14:03:17Z`, `2026-11-10 14:03:17,123`), nginx's error log (`2026/11/10 14:03:17`), the access logs of Apache and nginx (`10/Nov/2026:14:03:17 +0000`), epoch times in a JSON field `time`, `ts`, `timestamp` or `@timestamp` (10 or 13 digits, as UTC), `10.11.2026 14:03` (day first), `10/11/2026 14:03` (kept as `"10/11/2026"`, since day and month cannot be told apart), syslog (`Nov 10 14:03:17`) and klog (`I1110 14:03:17.123456`), the last two without a year (`"11-10 14:00"`). A line without one has no key. |
| `"shape"` | The line with its timestamp taken out, and its UUIDs, IP addresses, hex, quoted values and numbers replaced by `<id>`, `<ip>`, `<hex>`, `<s>` and `<n>`, as the log profile groups problems. |

Keys are cut at 120 characters. At most 10,000 groups are counted one by one; the lines of further
groups are counted together in `other_count`. Results, besides `document`, `mode`, `searched_lines`
and `total_matching_lines`:

| Field | Type | Meaning |
|---|---|---|
| `group_by` | string | The grouping that ran. |
| `total_groups` | number | The groups counted, at most 10,000. |
| `other_count` | number, optional | Matching lines of groups past the first 10,000, with `other_note`: "Lines of groups past the first 10,000 found." |
| `lines_without_group` | number, optional | Matching lines with no key: no timestamp, or a regex group that took no part. |
| `note` | string, optional | When not every group is shown: "K of the N groups are shown, the largest first. Narrow the search, or use from_line and to_line, for the others." By time, "the largest, in time order". A result cut to its room says "Showing K of the N groups to stay within the size limit, …". After the note of a scan that stopped early, when there is one. |
| `groups` | array | Up to `max_results` groups (50 by default, 200 at most). By `capture` and `shape`, the largest first. By time, in time order; when there are more groups than are shown, the largest of them, in time order. A result cut to its room keeps the largest groups as well: by `capture` and `shape` it loses the end of its list, and by time the smallest groups, keeping the others in time order. |
| `groups[].key` | string | The group. |
| `groups[].count` | number | Its matching lines. |
| `groups[].first_line`, `groups[].last_line` | number | Its first and last matching line, to read with `read_document`. |

A search for `PAY-5031` with `group_by: "hour"`:

```json
{
  "document": "payments.log",
  "mode": "exact",
  "total_matching_lines": 214,
  "group_by": "hour",
  "total_groups": 3,
  "groups": [
    { "key": "2026-11-10 13:00", "count": 9, "first_line": 40211, "last_line": 41876 },
    { "key": "2026-11-10 14:00", "count": 187, "first_line": 42003, "last_line": 47950 },
    { "key": "2026-11-10 15:00", "count": 18, "first_line": 48012, "last_line": 48990 }
  ]
}
```

Its step reads `Search payments.log (exact) for “PAY-5031”, counted by hour — 214 matching lines in
3 groups`.

Results of `keywords`:

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `mode` | `"keywords"` | |
| `searched_lines` | string, optional | With `from_line` or `to_line`: the lines searched, as `"1941-3000"`. New in 0.8.0. |
| `passages` | array | The best passages, best first. |
| `passages[].lines` | string | `"412-436"`: the passage's first and last line. |
| `passages[].pages` | string, optional | `"37"` or `"37-38"`, for a PDF whose pages can be shown. |
| `passages[].score` | number | The BM25 score, rounded to two decimals. |
| `passages[].text` | string | The passage's lines, numbered (`"412\| text"`), one a line. |
| `note` | string, optional | The no-passage note, or the size-limit note. |

## `aggregate_table`

New in 0.8.1. Counts, sums, averages, minimums and maximums over the rows of one table of a
document, with filters and groups, exactly: it reads every row once, and runs no code. A model that
adds up thousands of rows by reading them needs hundreds of calls and gets it wrong; this answers
in one. Its description, as the model sees it:

> Count, sum, average, or find the minimum or maximum over the rows of a table in an attached file:
> a CSV or TSV file, a sheet of an Excel workbook, or a table written as | cell | rows (in Word,
> PowerPoint, PDF or HTML files). It can keep only the rows that match filters, and group them by up
> to 3 columns (a date column by year, month or day). Its numbers are exact, as it reads every row:
> use it instead of reading rows to add them up or count them. Columns are named as in the table's
> header row; a letter (C) or a number (3) works too. Each group lists the lines of its first rows,
> to cite.

| Argument | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `document_id` | string | yes | | The document. |
| `table` | string | no | the first | A sheet's name or number in a workbook; a table's number in other files (1 is the first `\| cell \|` table). |
| `metrics` | string[] | no | `["count"]` | `"count"`, or an operation and a column: `"sum:Revenue"`, `"avg:Price"`, `"min:Date"`, `"max:Amount"`, `"count_distinct:Customer"`. |
| `group_by` | string[] | no | none | Up to 3 columns. A column of ISO dates may end in `:year`, `:month` or `:day` (`"Date:month"` groups 2026-03-14 under 2026-03). |
| `filters` | `{ column, op, value }[]` | no | none | Rows kept: all must match. `op` is `=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `not_contains`, `starts_with`, `empty` or `not_empty`. Two numbers compare as numbers, ISO dates and other text as text, ignoring case; a cell that is not a number is neither more nor less than a number. |
| `order_by` | `"metric"` \| `"key"` | no | `"metric"` | The largest value of the first metric first, or the groups by their values, in order (months in time order). |
| `limit` | integer | no | 50 | Groups shown, 1 to 200. |
| `header_rows` | integer | no | found | The rows of the header, 0 to 5, below a title row. Leave it out: the header is found (below). |

The tables it reads:

- **A CSV or TSV file:** the whole file. The separator is found from the first lines (comma,
  semicolon, tab or `|`); quoted fields may hold separators, quotes and line breaks. Its first line
  is the header, or its second when the first holds one value only (a title).
- **A sheet of a workbook**, as the XLSX extractor writes it (`Row 7: | a | b |`). Its header is
  the rows above its first row with a number, up to 3, joined column by column with " / " ("Q1 /
  January"), a header cell left empty by a merged cell taking the one to its left; a year (1900 to
  2100) in a header row is a name. A first row with one value over rows of more is a title, left
  out. A first row of numbers means no header: the columns are named by their letters.
- **A `| cell |` table** of a DOCX, PPTX, PDF, HTML or Markdown file: a run of such lines, numbered
  in the order of the file. Its header is found as for a sheet; a Markdown separator row is
  skipped, and a row the same as the header, found again inside the table (a PDF repeats it on each
  page), is not a row.

A column is named as in the header (case and spaces ignored), by its letter (`C`) or number (`3`),
or by the lower part of a joined header ("הכנסות" for "פברואר / הכנסות") when only one column has
it. Numbers are read as people write them: `1,234.5`, `-12`, `(1,200)` for a negative, `₪4,750`,
`$ 12.00`, `12%` (12), `1 234`, `12,5` (a decimal comma), `1.234,56`. A sum or average leaves out
cells that are not numbers, and says how many (`values_not_numbers`); `min` and `max` of ISO dates
compare them as text. Up to 10,000 groups are counted one by one; rows of further groups are
counted in `other_rows`.

Result:

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `table` | string | The table read: "the CSV file", "Sheet 2: Sales", "table 3 of 5". |
| `tables_in_file` | number, optional | Sheets or tables in the file, when more than one. |
| `header_line` | number | The line of the header's last row (0 with no header). |
| `header_rows`, `title` | optional | The header's rows, when not one, and a title row left out. |
| `columns` | string[] | The column names, up to 60. |
| `rows_read`, `rows_matched` | number | The table's rows, and those the filters kept. |
| `total_groups` | number, optional | Groups found, with `group_by`. |
| `groups` | array | One entry a group: `group` (the value of each group-by column, as its first row writes it), each metric by its name (`count`, `"sum:Revenue"`: null when no row of the group had a number there), `rows` when `count` was not asked, and `lines`, the lines of its first 3 rows. |
| `note` | string, optional | "N of the M groups are shown…", when `limit` cut them. |
| `values_not_numbers`, `other_rows`, `repeated_header_rows`, `irregular_rows` | optional | Cells left out of a metric, rows of groups past 10,000, header rows found again inside the table, and rows with values past the header's columns (a sign that the header was read wrong). |

```json
{
  "document": "orders-2026.csv",
  "table": "the CSV file",
  "header_line": 1,
  "columns": ["OrderId", "Date", "Region", "Product", "Amount"],
  "rows_read": 5000,
  "rows_matched": 1250,
  "total_groups": 5,
  "groups": [
    { "group": { "Region": "Center" }, "avg:Amount": 535.27, "rows": 250, "lines": [5, 10, 15] },
    { "group": { "Region": "East" }, "avg:Amount": 530.85, "rows": 250, "lines": [3, 8, 13] }
  ]
}
```

Errors say what to change: "No column \"Profit\" in this table. Its columns are: …", "\"הכנסות\"
names 3 columns of this table: …. Name one of them in full.", "No table \"Budget\" in this file: it
has 3 sheets…", "This file has no table to aggregate…". `evidence` cites the header line and each
group's lines; a result dropped to make room keeps its largest 30 groups.

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

A read cut short of its range that way also says, in `whole_file`, that the whole file can be
read with `analyze_whole_document`, when all of these hold (new in 0.10.0):

- the tool set declares `analyze_whole_document` and has a part reader (`generate`);
- the file can be read whole: it is not sent whole in the prompt (`ToolOptions.inline`), its
  estimated parts are within `maxMapChunks`, and a whole read of it is left
  (`maxWholeDocumentReads`, and no earlier read of it that could read no part);
- the result, with it, stays within its cap.

A read that shows every line asked for, and one shortened only to 600 lines, have no `whole_file`.
Gemini 3.5 Flash-Lite and 3.8 Flash read a contract they were asked to summarize in ranges of about
16 lines, and answered from those, when a whole read would have given all of it.

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
| `whole_file` | string, optional | "Only N lines fit here. To read all M lines for a task that needs all of them, such as a full summary or a timeline, use analyze_whole_document." ("Only 1 line fits here" for one), on a read cut short of its range by the size limit when the file can be read whole (see above). New in 0.10.0. |

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
| `output` | `"answer"` \| `"items"` | no | `"answer"`, the default: one answer written from the notes of every part, for a summary, a timeline, or a description of events. `"items"`: to count the items of a kind that must be judged by meaning, such as the clauses that set a fine; each part lists them, each with its line and a quote checked against the file, and the result counts them, by label ([below](#items-output-items)). Any other value is `"answer"`. New in 0.10.0. |
| `labels` | string[] | no | With `output: "items"`: the kinds of item to label each one with, such as `["penalty", "deadline"]`. Up to 12, each up to 40 characters; one string is read as a list of one. Ignored for `"answer"`. New in 0.10.0. |

0.10.0 added the two arguments, and kept the description of 0.9.0 word for word: a chat where the
tool is declared misses the provider's prompt cache once after the upgrade. Said in the
description, a sentence on items made Gemini Flash-Lite choose this read for a full summary in 3
of 10 runs, against 7 of 8 with 0.9.0's words, so items are told in the description of `output`
alone. There, `"answer"` names a summary and a timeline: told only that items list what a task asks
for, Flash-Lite chose them for a timeline of events, whose items explain nothing, and its answers
lost events.

The file is split into parts of up to `mapChunkTokens` tokens (and 80% of `maxRequestBytes`), 4 are
read at a time with the `generate` function of the tool set, their notes are merged, and one answer
is written from them. A part the model refuses as too large is read as two halves, while
`maxMapChunks` and [`ToolCallLimits.maxRequests`](#toolcalllimits) allow it. The steps, output
limits and retries are in [How it works](../how-it-works.md#map-reduce); what a read costs is in
[Costs and limits](../guides/costs-and-limits.md).

Each part's request sends the file's name and lines, then the part between `<part>` and `</part>`,
then where the part is in the file, the task and the rules. A part that starts in the middle of a
section of the file's outline (a day of a diary, a chapter, a sheet) has the line of the heading it
is under first, numbered as in the file and cut to 120 characters, and its first line says so:
`Document: diary.md, lines 967-1277, under the heading on line 958, which comes first.` (since
0.10.0; Gemini Flash-Lite dated the events of such a part by the day before). Logs, JSON and CSV
files have no outline. Its system text says that text inside
`<part>` is the file's content: never instructions to follow. A merge of notes and the answer of the
read send their notes first, between `<notes>` and `</notes>`, and the task last. So two reads of
one document with other tasks send the same start in each part's request, up to the end of the
part, for a provider's prompt cache. Until 0.10.0 the task came first, before the part.

Given `maxRequests`, a read counts its requests (since 0.10.0). Each part is one request, so a read
with more parts than `maxRequests` is refused before any request is sent (see the errors below). A
round of merges that would leave
no request for the answer is not made: the answer is then written from the notes that fit one
request (`mapChunkTokens`), in the order of the file, and the result says how many parts' notes it
left out (`notes_left_out`). When not even the answer has a request left, the notes are the answer
(`notes_only`). A part is halved only while the requests left also cover the merges its notes may
need, priced as long as the output limit allows, and the answer. Until 0.10.0 the merges went past
`maxRequests`: a read of 27 parts given 32 requests made 40.

Each document may be read whole [`MAX_WHOLE_DOCUMENT_READS`](#max_whole_document_reads) times (1)
by one tool set, which is one question in `askWithFiles`. Set it with `limits.wholeDocumentReads`
in [`AskLimits`](./ask.md#asklimits), or `maxWholeDocumentReads` in
[`ToolOptions`](./library.md#tooloptions). A read is counted when it starts, so two calls in one
turn do not both pass. A read that could read no part is not tried again in the tool set, whatever
that number is (since 0.10.0; before, a number of 2 or more let it try again).
[`ToolSet.wholeReadsLeft`](#toolset) says how many reads of a document are left.

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `parts_read` | number | The parts the file was read in, those that could not be read included; a part read as two halves counts as two. |
| `parts_with_relevant_content` | number | The parts that were read and held something for the task. |
| `parts_that_failed` | number, optional | Parts that could not be read. The notes name each one: "[This part could not be read: reason]". |
| `notes_cut_short` | number, optional | Notes of parts, and merges of notes, that stopped at the output limit or were cut off by the provider. |
| `notes_left_out` | number, optional | The relevant parts whose notes are not in the answer: the read reached `maxRequests` before it could merge them. New in 0.10.0. |
| `answer_cut_short` | `true`, optional | The final answer stopped at its output limit. |
| `notes_only` | `true`, optional | The last step, which writes one answer from the notes, failed, or (since 0.10.0) had no request left within `maxRequests`: `answer` is the notes of the parts, with their line citations. |
| `note` | string, optional | With `notes_only`: "The last step of this read, which writes one answer from the notes of the parts, failed (REASON). The answer is those notes: answer from them.", or "This read reached the question's limit on model requests before its last step, which writes one answer from the notes of the parts. The answer is those notes: answer from them.", plus "Some of them were cut off at the output limit, so they are incomplete: tell the user." when some were. With `notes_left_out`: "Incomplete: this read reached the question's limit on model requests before it could combine the notes of every part, so the notes of N of the M relevant parts are not in this answer. Tell the user it is incomplete." and the same pointer to exact search as below. Otherwise, when notes or the answer were cut short: "Incomplete: the model's output limit was reached, so some relevant items are missing from this answer. Tell the user it is incomplete. For a complete list or an exact count, use search_document in exact or regex mode (it returns total_matching_lines), or ask about a narrower part of the file." |
| `answer` | string | The answer. When no part held anything relevant: "No part of NAME contained anything relevant to: TASK", with the count of parts that could not be read, if any. |
| `answer_shortened` | string, optional | "The rest of this answer did not fit in the room left in this conversation." The answer was cut at its end, which then reads `…`. |

```json
{ "document": "novel.txt", "parts_read": 4, "parts_with_relevant_content": 3, "answer": "Ada appears first in chapter 2 (L412) ..." }
```

### Items: `output: "items"`

New in 0.10.0. Each part replies with one JSON object for each item it finds, on a line of its own:
`{"line": 123, "label": "penalty", "value": "5%", "quote": "a fine of 5% of the order"}`, the label
only when the call gave `labels`. The rules ask for a quote of five to twelve words of the line
that state the item, copied exactly, letter by letter, at most 80 characters: the longer quotes
asked for at first (200 characters) made Gemini Flash-Lite cut its list at the output limit more
often, and copy more words wrong; asked for "the few words" of the line, it gave some quotes of 14
characters, too short for the near check below. Code reads the replies, checks the items and
counts them. No model merges them, and there is no answer of the read: one request a part.

- A reply is read leniently: a line may start with a list mark (`- `, `1. `) and end with a comma,
  or hold several objects (`{…} {…}`), code fences are passed over, and a JSON array of the objects
  is read too, and so is an object that wraps their list (`{"items": […]}`: no `quote` of its own,
  and one array of objects). A line that is not a JSON object is skipped. A reply that says
  `NOTHING RELEVANT` has no item, unless it lists items after it: those are checked as any other.
- An item counts when its `quote` is on the line it names, within the part that listed it. They
  are compared composed (NFC) and folded as exact search folds text (case, quotes, dashes, spaces),
  without Hebrew points, with final letters as plain ones (כסף is found in כספים), without the
  characters that show nothing (the direction marks U+200E, U+200F and U+061C that Hebrew text
  from Word and PDF files often has next to a number, and the joiners), and with runs of blanks as
  one space. A line number copied with the quote (`12| `) and the quote marks around it
  are left out, and a quote cut with `…` must have each of its pieces on the line, in order.
- An item whose quote is not on the line it names, but on exactly one line of its part, is given
  that line: in a file whose lines start with numbers ("7| 5. …", clause 5 on line 7), a model may
  name the number in the text.
- An item whose quote is on no line of its part, but near the line it names, keeps that line: a
  quote of 15 characters or more, compared as above, whose numbers are all numbers of the line,
  and whose pieces are runs of the line with at most one letter in five changed, added or taken
  out in all. Gemini Flash-Lite copies Hebrew quotes with a letter or a word changed (השרים for
  השרתים, מקוזז for לקזז, ש"ץ for ש"ח). A quote with an amount other than the line's is not near
  it, so neither is the quote of the next clause of a contract written to the same pattern. A line
  of up to 2,000 characters, the longest that ingest stores, is compared whole. A longer line, which
  a store of your own may give, is looked at only around the two longest words of each piece of the
  quote that are on it in 1 to 4 places: a piece none of whose words is so counts as wrong in all
  its letters, and a quote none of whose words is so is not near it. Measured along all of a line
  of 118,759 characters, one quote took 688 ms, and one cut with "…" into 41 short pieces 677 ms.
- An item whose quote is on no line of its part, nor near the line it names, is given the line of
  its part that is near its quote and starts with the number it names ("7| 5. …" for 5), when
  exactly one line is both: Gemini Flash-Lite named the clause for the line and copied a letter of
  the quote wrong (שילם for ישלם). When two lines start with that number and are near the quote,
  as in a file whose numbering starts again, it is not counted. New in 0.10.0.
- Any other item counts in `unverified_items`, not in `total_items`.
- A backslash that starts no JSON escape (`ש\"\ח`, as Gemini Flash-Lite escapes a Hebrew letter) is
  taken out before a line is read again, and a `\u` with fewer than four hex digits is taken out
  with the digits it has (Flash-Lite wrote ט as `\u05d`, which left "u05d" in the quote).
- The same item listed twice (the same line, label and value) counts once.
- A label is matched to `labels` as quotes are compared, and given as the call spelled it. A label
  that is not one of them is kept as the model wrote it.
- A part whose list stops at the output limit is read again as two halves, and a half as two
  quarters: two levels at most, while `maxRequests` allows it (without it, while the halves take no
  more than `maxMapChunks` requests). A part the model refuses as too large is halved the same way.
  A list still cut is counted as it is, and the result says that items may be missing.
- The read costs its parts alone, each with the longer rules of a list, which is less than an
  answer read, with its merges and its answer. In 0.10.0 the ceiling of `askWithFiles` does not
  tell them apart yet: it prices every whole-file read, items or not, as an answer read (its
  parts, a merge and its answer), so an items read can be refused by the ceiling at the higher
  price.

| Field | Type | Meaning |
|---|---|---|
| `document` | string | The file name. |
| `total_items` | number | The items found, each once, whose quote is on their line, or near it as above. Counted by code. |
| `counts_by_label` | object, optional | The items by label, when they have labels: `{ "penalty": 37 }`. An item with no label among labelled ones counts under `"unlabeled"`. |
| `items` | array | The first 50 items, in the order of the file, each `{ line, label?, value?, quote }`. The value and the quote are as the model wrote them, up to 200 and 300 characters. |
| `more_items` | number, optional | The items not shown: past the first 50, or past those kept when the result was cut to its room. |
| `unverified_items` | number | Items a part listed that are not counted: a quote on no line of the part and not near the line the item names, or on several lines but not on that one. A quote near its line (15 characters or more, at most one letter in five wrong, every number a number of the line) counts there, so it is not among them. |
| `parts_read` | number | The parts the file was read in, those that could not be read included; a halved part counts as its halves. |
| `parts_failed` | number, optional | Parts that could not be read: their items are missing. |
| `parts_cut_short` | number, optional | Parts whose list was still cut at the output limit. |
| `note` | string, optional | What to tell the user, from these: "No part of NAME listed an item for: TASK." (a stop is added to a task that has none); "No item was found on its line for: TASK." when items were listed and none is counted; "The first 50 items are shown; total_items counts them all.", or "The first K items are shown, to stay within the size limit; total_items counts them all." when the result was cut to its room; "N listed items are not counted: their quote is not on the line they name, nor on just one other line of the part." (an item whose quote is near its line counts, so it is not among them); "N parts could not be read (REASON), so items may be missing: tell the user the count may be incomplete."; "N parts listed more items than fit the model's output limit, even read in smaller pieces, so items may be missing: tell the user the count may be incomplete." |

```json
{
  "document": "contract.docx",
  "total_items": 37,
  "counts_by_label": { "penalty": 37 },
  "items": [{ "line": 7, "label": "penalty", "value": "1,250", "quote": "קנס בסך 1,250 ש\"ח לכל מקרה" }],
  "unverified_items": 0,
  "parts_read": 5
}
```

Cut to its room, it loses items from the end of its list (one is always kept), `more_items` counts
every item it does not show, and the note says how many it shows. Its counts are kept whole. Its evidence
([`evidenceOf`](./ask.md#evidenceofcall-result)) is `whole: true` with the lines of the items it
shows, and its stand-in keeps the counts and the first 20 items.

Errors:

| Error | When | Counted as a read |
|---|---|---|
| `NAME was already read whole for this question, and is not read whole again. Use the answer of that read, or search_document and read_document for the details.` | The document was read whole as often as it may be (" N times" is added when that is more than 1). | no |
| `Whole-file reads are turned off for this question. Use search_document and read_document on NAME.` | `maxWholeDocumentReads` (or `limits.wholeDocumentReads`) is 0. | no |
| `The whole-file read of NAME failed earlier in this question (REASON), and is not tried again. Use search_document and read_document.` | An earlier read of it could read no part. | no |
| `NAME is shown in full above: answer from it, and use search_document or aggregate_table for exact counts.` | The document is one of `ToolOptions.inline`: its text is in the prompt. Nothing is sent. New in 0.10.0. | no |
| `labels takes up to 12 labels, each up to 40 characters.` | `output: "items"` with more labels, or a longer one. New in 0.10.0. | no |
| `Reading all of NAME needs N model calls, over the limit of M. Use search_document to narrow the question first.` | The read counted more parts than `maxMapChunks` ("1 model call" for one). Nothing was sent. | no |
| `Reading all of NAME takes N model requests, one for each part, and M are left for it in this question. Use search_document and read_document.` | The read counted more parts than [`ToolCallLimits.maxRequests`](#toolcalllimits) ("1 is left" for one; "takes 1 model request, for its one part" for a file of one part). Nothing was sent. New in 0.10.0: before, the read sent every part whatever its limit. | no |
| `Could not read any part of NAME: REASON` | Every part failed at the model. | yes |
| The store's error | No part could be read from the store. Nothing was sent. A store timeout is thrown instead ([Store timeouts](#rules-for-every-tool)). | no |

REASON, in these errors, in the notes of a part that could not be read, and in the note of
`notes_only`, says why a model request failed. Since 0.6.0 it is built from the error's kind, its
HTTP status or its connection code, never from its message, which can name a project, a host, a
key or a URL. It is one of:

| REASON | For an error |
|---|---|
| `The request was larger than the model takes (HTTP 400).` | of kind `context_overflow` |
| `The model's quota has run out (HTTP 429).` | of kind `quota` |
| `The model was busy (HTTP 429).` | of kind `rate_limit` |
| `The model took too long to answer.` | of kind `timeout`; named `TimeoutError`, on the error or its cause (an `AbortSignal.timeout`, or a built-in part reader past its `timeoutMs`); or with undici's code `UND_ERR_HEADERS_TIMEOUT` or `UND_ERR_BODY_TIMEOUT` |
| `The model could not be reached.` | of kind `unreachable`; or whose code, or that of a cause up to 3 levels down, is that of a connection that failed: `ECONNREFUSED`, `ECONNRESET`, `ECONNABORTED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENETDOWN`, `EPIPE`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_SOCKET`, `UND_ERR_CLOSED`, `UND_ERR_DESTROYED` |
| `The model failed on its side (HTTP 503).` | of kind `server` |
| `The model refused the key or token it was sent (HTTP 401).` | of kind `auth` |
| `The model refused the request (HTTP 400).` | of kind `invalid` |
| `The model's reply could not be read (HTTP 200).` | of kind `invalid` with a status from 200 to 299: a reply that was not JSON, or a streamed event too long |
| `The model returned no text (SAFETY).` or `The model returned no text.` | the error a built-in part reader throws for a reply with no text. The provider's reason is given only when it is a plain word (letters and `_`, up to 40). |
| `The model request failed.` | any other: a plain `Error` or a string thrown by a `generate` of your own, an error whose fields throw when read. `The model request failed (HTTP 302).` for a status from 100 to 399. |

The status in brackets is there when the error has one: its `status`, else `statusCode`, else
`response.status`, as the errors of provider SDKs, got and axios carry it, when that is a whole
number from 100 to 599, or 0 (which is not shown). An error with a status and no `kind` has its kind
told from the status and its message, as [`classifyModelError`](./errors-and-retries.md#classifymodelerrorstatus-message-signals)
does. A failure to read a part's lines from the store is told as every tool tells a store's error
([Rules for every tool](#rules-for-every-tool)):
`[This part could not be read: The document store could not be read (EIO). Try again.]`. Until
0.6.0, REASON was the error's own message.

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
with an error. Since 0.9.0 the looks of a library take their turns (`maxConcurrentPageLooks`, 1 by
default): a look waits for its turn before the original is loaded. Pages are left off the end until the file fits the call's `maxFileBytes`. Cutting
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
| `The original file of NAME is no longer on the server, so its pages cannot be shown. Answer from the text.` | The store no longer has the original, or (0.9.0) what it gave back is not the file that was ingested: of another size or SHA-256; or a file your application keeps (`IngestInput.original`) is not there. When the document itself is gone too (deleted while the look waited for its turn), the call gives `ID is no longer available on the server. Ask the user to attach the file again.` instead, and its hooks are told (`ToolCallHooks.onDocumentGone`; since 0.9.0). |
| `NAME changed on the server since it was read. Attach it again to look at its pages.` | The file your application keeps for the document (`IngestInput.original`, read through `LargeFilesOptions.originals`) is no longer the one that was ingested: its size or SHA-256 differs. Its pages would not match the text. New in 0.9.0. |
| `The original file of NAME could not be read in time, so its pages cannot be shown. Answer from the text.` | The store's `getOriginal` did not answer within `ingestTimeoutMs` (2 minutes when that is 0). The look gave its turn back, so the next look runs. The read goes on in the background: give your store's `getOriginal` a time limit of its own. New in 0.9.0. |
| `NAME: The pages cannot be looked at right now; the server is busy. Answer from the text, or look again later.` | The look waited longer than `pageLookWaitMs` for its turn, or the call's `maxWaitMs` when that is less: other looks of the library held them all (`maxConcurrentPageLooks`, [library](./library.md#largefilesoptions)). It was not run, and its PDF was not loaded. The call's hooks are told (`ToolCallHooks.onPagesBusy`), and `askWithFiles` gives a `"page_looks_busy"` notice. New in 0.9.0. |
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
- since 0.8.0, how to count by group and see the rest of a list: "To count per group (per hour or
  day, per error code or ID with a regex group, per message shape), pass group_by: one call gives
  every count. For more matches than a result shows, search again from its next_from_line, or with
  order "last" for the last ones.";
- since 0.8.0, what to search for: "Search for the bare form of a word: a search matches inside
  longer words, so "timeout" also finds "timeouts", and a Hebrew word without its prefix letters
  (חוזה, not בחוזה) finds every form of it.";
- since 0.8.1, when a searchable file may hold a table: "To add up, average, count or group the
  rows of a table (a CSV, an Excel sheet, a | cell | table), use aggregate_table: it reads every
  row, and its numbers are exact. Do not add numbers up from rows you read.";
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
  `toolTurns` keep it, but the rounds of an earlier question passed back in `messages` are sent
  without it, since it counted the turns of their own question (since 0.6.0). `geminiToolTurns`,
  `openAiToolTurns` and `anthropicToolTurns` leave it out too.
- **A call made again.** A call whose result is still in the conversation in full (the same
  search with the same arguments as the tool reads them, the same overview, the same read, or a
  read of lines inside a read shown in full), in this question or in the tool rounds of an earlier
  one passed back in `messages`, is not run (new in 0.6.0). Its result is a pointer, and its step
  ends " — already shown above":
  - `{ "document": "app.log", "already_shown": true, "note": "Not run: this exact call was answered earlier in this conversation, and its result is still shown above in full. The file has not changed, so it would return the same. Use that result. For more, read other lines, or search with other words or another mode." }`
  - For a read inside an earlier read: `{ "document": "app.log", "lines": "150-200", "already_shown": true, "note": "Not run: lines 150-200 are already shown above in full, in the result that has lines 100-299 of this file, and the file has not changed. Use them. To see more, read other lines." }`
  - For the same call twice in one turn: `{ "already_shown": true, "note": "Not run: call 1 of this turn is the same call, and its result is next to this one. Use it." }`

  A result of an earlier turn that failed, was cut (`truncated`, `text_cut`, a note that starts
  "Showing "), came from a search that stopped early, is itself a pointer or a stand-in, or (since
  0.10.0) was replaced by your `onToolResult` (`redacted: true`) is never pointed to: the call runs,
  and may get more. A search whose note only says how many of its
  matches are shown ("21 of the 442 matching lines are shown: …") was not cut, and is pointed to.
  The same call made twice in one turn gets the pointer to the first whatever the first returns (an
  error, a cut result, a pointer); only when the first is refused for lack of room is the second
  refused the same way. Whole-file reads and looks at pages are never pointed to.

  Some calls run again all the same:
  - every call, with a model that declares
    [`clearsToolResults`](./ask.md#modelcapabilities) (Claude with `clear_tool_uses` or compaction
    in its `body`), which may no longer have the earlier result; the same call twice in one turn
    runs twice too;
  - a read of one line from the tool rounds of an earlier question: 0.5.0 cut the text of such a
    read without saying so (no `text_cut`), and the stored rounds do not tell which version wrote
    them;
  - an exact or regex search that 0.5.0 stored: fewer `matches` than `total_matching_lines`, and
    no note. Run now, it shows the last match too.
- **Stand-ins.** When the request runs short of room, the results of older tool rounds are replaced
  by the short stand-ins of [`stubResult`](./ask.md#stubresultcall-result-hadfiles), with
  `"dropped": true`; when and how is in [How it works](../how-it-works.md), and nothing is replaced
  during a question when any model of the question is append-only (Claude). Since 0.9.0 the
  results of stored rounds are replaced before the first request when they make it too large in tokens,
  for every model, and a result is never replaced by a stand-in as large as itself. A pointer whose result was replaced
  becomes
  `{ "document": "app.log", "dropped": true, "note": "Not run then: it repeated an earlier call whose result was later dropped from the conversation to make room. Call it again if you need it." }`.
  So does every pointer of a stored round when a model of the question declares
  `clearsToolResults`. In `toolTurns`, the result of a look at pages is kept as its stand-in,
  since the file is not kept.
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
    "The arguments of this call were not valid JSON, and it was not run: … Send the call again.",
    which quotes up to 300 characters of the arguments, never cut in the middle of a character;
  - a whole-file read that would pass `limits.inputTokens` or `limits.requests`: "Not run: reading
    all of NAME takes about N input tokens, and M are left of the L this question may use. Use
    search_document and read_document." (or "model requests ... this question may make").
- **Steps.** Each call that runs starts an `onActivity` line, its `describe()` label and `…`.
  Each call up to `callsPerTurn` ends with a step, in `onStep` and `steps`: the label and
  [toolResultSummary(label, result)](#toolresultsummarylabel-result), or the label and
  " — already shown above" for a pointer. The calls past it share one step: "N more tool calls in
  this turn were not run (at most 8 a turn)", or "1 more tool call in this turn was not run (at
  most 8 a turn)" for one. A call of a tool that does not exist has the label `Call “NAME”`, the
  name cut at 64 characters, and the step `Call “do_magic” — failed: Unknown tool “do_magic”.`;
  until 0.6.0 the label was the name itself. Labels and steps are one line of plain text: a line
  break or a control character the model sent becomes a space, the invisible characters that file
  text loses are dropped, and `](` becomes `] (` (see [`AskResult`](./ask.md#askresult)). See
  [Web app](../guides/web-app.md) for showing them.

The regex time of a question is always [`REGEX_BUDGET_MS`](#regex_budget_ms) in `askWithFiles`: it
has no option for it.

## Exports

### `TOOL_NAMES`

The names of the six tools, as constants.

```ts
const TOOL_NAMES = {
  search: "search_document",
  read: "read_document",
  overview: "get_document_overview",
  analyze: "analyze_whole_document",
  view: "view_pages",
  aggregate: "aggregate_table", // new in 0.8.1
} as const;
```

Compare a `ToolCall.name` with these rather than with string literals. See
[Your own adapter and loop](../guides/own-adapter-and-loop.md).

### declarationsFor(names)

`declarationsFor(names: readonly ToolName[]): ToolDeclaration[]`

The [declarations](#tooldeclaration) of the tools `names`, in the order a tool set declares them
(search, read, overview, aggregate, analyze, view), whatever the order of `names`: the declarations
of `files.tools(documents, { declare: names })`, byte for byte. A name that is not a tool's is left
out. Use it to plan the size of a request before the tools are made. New in 0.10.0.

```ts
import { declarationsFor } from "llm-large-files";

const declared = declarationsFor(["aggregate_table", "search_document", "read_document"]);
// search_document, read_document, aggregate_table
const bytes = Buffer.byteLength(JSON.stringify(declared));
```

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
| `error` | ` — failed:` and the error, as in ` — failed: Unknown tool “do_magic”.` |
| `total_matching_lines` (exact, regex) | ` — 1,203 matching lines` (numbers in en-US form), ` — 1 matching line` for one. With `total_groups` (`group_by`): ` — 214 matching lines in 3 groups`, ` in 1 group` for one |
| `passages` (keywords) | ` — 5 passages`, ` — 1 passage` for one |
| `total_items` and `parts_read` (a whole-file read that lists items, since 0.10.0) | ` — 37 items in 5 parts` (` — 1 item in 1 part` for one), then `, 2 not counted` with `unverified_items`, and `, incomplete` with `parts_failed` or `parts_cut_short` |
| `parts_read` (whole-file read) | ` — 9 parts, 3 relevant` (` — 1 part, 1 relevant` for one), then `, notes only` with `notes_only`, or `, incomplete` with `notes_cut_short`, `notes_left_out` (since 0.10.0) or `answer_cut_short` |
| `lines` and `total_lines` (read) | ` — got 1200-1342` when the label does not end with the lines shown, else `""` |
| `pages` and `total_pages` (view_pages) | ` — got page 2` or ` — got pages 2-3` when the label does not end with the pages shown, else `""` |
| anything else (an overview, a cut result) | `""` |

```ts
import { toolResultSummary } from "llm-large-files";

const label = "Search app.log (exact) for “timeout”";
const step = label + toolResultSummary(label, { document: "app.log", mode: "exact", total_matching_lines: 1203, matches: [] });
// "Search app.log (exact) for “timeout” — 1,203 matching lines"
```

Until 0.6.0 a count of one was plural too (` — 1 matching lines`). `askWithFiles` makes its steps
this way, and then makes each one line of plain text. See [Web app](../guides/web-app.md).

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
  executeWithFiles(name: string, args: Record<string, unknown>, limits?: ToolCallLimits, hooks?: ToolCallHooks): Promise<ToolOutput>;
  describe(name: string, args: Record<string, unknown>): string;
  resultCharacters(name: string): number;
  wholeReadsLeft?(documentId: string): number; // new in 0.10.0
};
```

| Member | What it does |
|---|---|
| `declarations` | The tools to declare to the model, in this order: `search_document`, `read_document`, `get_document_overview`, `aggregate_table`, `analyze_whole_document`, `view_pages`, those that are [offered](#which-tools-are-offered), or (since 0.10.0) exactly those `ToolOptions.declare` names, in the same order. |
| `has(name)` | `true` for each declared tool. Also `true` for `analyze_whole_document` when `generate` was given and the text tools are declared, even if it is not declared because no document is small enough: a call then gets the reason. With `ToolOptions.declare` (since 0.10.0), `true` for the declared tools alone. Use it to tell the calls of this tool set from others. |
| `execute(name, args)` | Runs a call and returns its JSON result, within the tool's own cap. Failures come back as `{ error }`, as listed above. `view_pages` answers with an error here: it returns a file. |
| `executeWithFiles(name, args, limits?, hooks?)` | Runs any call with [`ToolCallLimits`](#toolcalllimits), and returns the result with the files it produced (`files` is empty for every tool but `view_pages`). Use it in a loop that can send files to the model. `hooks` ([`ToolCallHooks`](./library.md#toolcallhooks), new in 0.7.0) are listeners for this call alone: the progress of a whole-file read, in place of `ToolOptions.onProgress`, and each of its model requests with their retries; a document found gone, and a look told the server is busy (0.9.0); and its own `signal` (0.10.0, [above](#rules-for-every-tool)). |
| `describe(name, args)` | A short line for a progress UI, read from the arguments the way the tool reads them: `Search app.log (exact) for “timeout”` (the query cut to 80 characters; since 0.8.0 followed by ` in lines 1941-end` with `from_line` or `to_line`, and by `, counted by hour` with `group_by` or `, the last ones` with `order: "last"` in exact and regex mode), `Read app.log lines 1200-1260` (`-1260` only when the call gave an `end_line` not below `start_line`, read as the tool reads it: since 0.10.0 an `end_line` sent as text, `"250"`, shows too, and one past the 600 lines a read shows reads as its last line), `Read all of contract.docx for “every penalty”, as a list of items` (with `output: "items"`, since 0.10.0), `Overview of app.log`, `Read all of novel.txt for “list every character”` (the task cut to 100 characters), `Look at report.pdf pages 2-3`. A cut never splits an emoji. A file not yet known is "the file"; an unknown tool is its name, as it came (`askWithFiles` labels it `Call “NAME”` instead). The line quotes the model's words as they are: show it as plain text, or clean it as `askWithFiles` does its steps. In `askWithFiles`, this line, made one line of plain text, is the `label` of the call's `tool.start` event, the line `onActivity` gets with "…", and the start of its step. |
| `resultCharacters(name)` | The most characters of a result of this tool: the larger of `toolResultCharacters` and 40,000 for `analyze_whole_document`, 600 for `view_pages` (its file is counted in bytes), 600 for a name the tool set does not answer (its error is a few words; since 0.10.0, before which it was `toolResultCharacters`), 600 for a tool declared with `declare` that cannot run and for `analyze_whole_document` without `generate` (since 0.10.0: they answer their reason), and `toolResultCharacters` for the other tools. What a loop sets aside in its request before it runs a call. |
| `wholeReadsLeft(documentId)` | How many more times this tool set may read the document whole: 0 once a read of it could read no part, at the cap (`maxWholeDocumentReads`), for a document sent whole (`inline`), for one that is not among its documents, and without `generate`. `askWithFiles` asks it before it prices a read, so a read the tool would refuse is refused with the tool's reason, not its price. Optional in the type, so a tool set of your own still compiles. New in 0.10.0. |

`execute` and `executeWithFiles` throw only when the tool set's `signal`, or (since 0.10.0) the
call's own `signal`, was aborted, or the store did not answer in time ([Store
timeouts](#rules-for-every-tool), since 0.10.0): the error that ended the call is thrown again
instead of being returned to the model.

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
  maxWaitMs?: number; // new in 0.9.0
};
```

| Field | Type | Default | What it does |
|---|---|---|---|
| `maxFileBytes` | number | 3/8 of (`maxRequestBytes` − 262,144): 3,651,696 bytes with the default budget | `view_pages`: the most bytes its file may have. Pages are left off the end until the cut fits. Below 1,024 the call fails. Give the room left in your request, times 3/4 when you send files as base64. |
| `maxPages` | number | [`MAX_VIEW_PAGES`](#max_view_pages) (5) | `view_pages`: the most pages this call may show, never more than 5. Below 1 the call fails. Lower it as the pages already shown use up your token budget. |
| `maxResultCharacters` | number | The tool's own cap ([`resultCharacters`](#toolset)) | The most characters of the JSON result, when that is less than the tool's cap: the room left in the request. The result is cut to it and says where to go on. Never below 600. `view_pages` ignores it. |
| `maxRequests` | number | No limit | `analyze_whole_document`: the most model requests the read may make. A part the model refuses as too large is read as two halves only while this and `maxMapChunks` allow it (the parts, their merges and the answer must fit). Since 0.10.0 the read keeps to it: a read with more parts than this is refused before any request, a round of merges that would pass it is not made ([above](#analyze_whole_document)), and a read that lists items reads a cut list again in halves only within it. New in 0.6.0. |
| `maxWaitMs` | number | The library's `pageLookWaitMs` (30,000) | `view_pages`: the most milliseconds the look waits for its turn, when that is less than `pageLookWaitMs`. 0: it runs only when a turn is free now, and is told the server is busy if not. New in 0.9.0. |

In `askWithFiles`, `maxFileBytes` is what is left of `maxRequestBytes` after the request so far
and a tenth kept free (256 KiB at least), times 3/4; `maxPages` is what is left of
`reservedTokens / 2 / pageTokens` pages for the question (60 with a `reservedTokens` of 64,000 and
Gemini's 530 tokens a page); `maxRequests`, when `limits.requests` is set, is the read's own
requests and a share of what the question has left of it; `maxWaitMs` is 0 for the looks of a
tool turn after one of them was told the server is busy, so that a wait that ends busy comes once
in a turn. See
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
guide are written for the model and have changed between versions: do not parse them; test for
result fields instead.

0.6.0 changed the guide, the descriptions of `search_document` and `analyze_whole_document`, and
the frame of every file sent whole ([`PreparedContext`](./library.md#preparedcontext)), so the
provider's prompt cache misses once after upgrading to it: the first request of each conversation
after the upgrade reads from the cache at most what comes before the first text that changed. For
a question with files to search, that is nothing where the tools come first (Claude,
OpenAI-compatible endpoints), and at most your own system text on Gemini, where the guide follows
it in the system instruction. For a question whose files are all sent whole, it is your own system
text, and `view_pages` with its guide when the pages of a PDF can be looked at.

0.8.0 changed the description of `search_document` (its new arguments), the guide (two lines: counts
by group and paging; searching the bare form of a word) and the closing requests
([`FINAL_ANSWER_REQUEST`](./ask.md#final_answer_request) and the two others), so the cache misses
once after upgrading to it too, the same way.

0.10.0 changes the arguments of `analyze_whole_document` (`output` and `labels`; its description
is 0.9.0's), so a chat where it is declared misses the cache once after the upgrade. The prompts of
its part reads, merges and answer changed too: they reach the model that reads the parts, not the
chat.
