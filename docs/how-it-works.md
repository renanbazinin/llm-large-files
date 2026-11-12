# How it works

```
upload ─► ingest ─► store        extract text · normalize · index lines · outline · log profile
                      │          (and the uploaded file itself, for formats in keepOriginals)
chat turn ─► prepare(ids, size of the rest of the request)
                      ├─ fits ────► full text in the prompt
                      └─ too big ─► summary card in the prompt
                                    + tool guide in the system prompt
                                    + tools: search · read · overview · analyze-all
                      a PDF whose file is kept, in either branch
                                  ─► + tool: view_pages (the real pages, as a small PDF)
```

## Ingest

1. **Extract** text by format (built-in extractors or your own). In a PDF, tables are rebuilt from
   the position of their text and written as `| cell | cell |  |` rows, so an empty cell stays an
   empty cell ([details and limits](configuration.md#pdf-tables)). A page that shows a picture or a
   drawing gets a line that says so. Those pages are found from the structure of the file: a small
   interpreter follows each page's drawing instructions and notes where images are painted and
   which shapes are filled, without decoding any image
   ([what counts](configuration.md#the-line-that-marks-a-page)).
2. **Normalize**: strip the BOM, unify line endings, remove terminal colour codes and control
   characters, split lines over 2,000 characters.
3. **Profile**: count lines, estimate tokens and UTF-8 bytes, and build an outline (headings with
   line numbers). For logs, also count levels, find the time range, and group ERROR/FATAL/WARN lines
   by *shape*. Numbers, IDs, IPs, hex, and quoted values are replaced with placeholders, so 800
   timeouts to different hosts become one entry: `[ERROR ×812, L1203] timeout after <n>ms to <ip>`.
4. **Store** the text and metadata, and the uploaded file when its format is in `keepOriginals`.
   With a store that can read by range (`FileDocumentStore`), also a line index: where each line
   starts, a few bytes a line, so a tool call on a large file reads only the lines it needs
   ([details](configuration.md#large-files-many-users-several-servers)). Nothing else is indexed up front.

## The card

A searchable file is replaced in the prompt by a few kilobytes: ID, size, line count, token
estimate, log profile, outline (first 40 headings), and the first 25 lines. In practice, the model
often knows where to look before its first tool call. In the live test, it read straight to the
FATAL line listed on the card.

## Tools

- **`search_document`**
  - `keywords`: BM25 ranking over passages of about 1,500 characters, computed at query time from
    substring hits. No index to build, it works in any language, and "timeout" also matches
    "timeouts". A passage containing the exact phrase gets a boost.
  - `exact` and `regex`: matching lines with optional context. Regexes with nested quantifiers are
    refused up front, and every regex scan runs under a 3-second limit that can interrupt a match
    in progress, so a slow pattern returns partial results instead of hanging the process.
- **`read_document`**: numbered line ranges, trimmed to the result-size cap, with `next_start_line`
  for paging.
- **`get_document_overview`**: the full outline and profile, the first and last lines, and how many
  parts a whole-file read would take.
- **`analyze_whole_document`**: map-reduce (below).
- **`view_pages`**: pages of a PDF, cut out of the kept original into a PDF of their own
  (below). It is the only tool that returns a file.

Every result is capped (`toolResultCharacters`) and states what was cut, so one tool call can never
overflow the request. `view_pages` is capped in pages and in bytes instead.

## Looking at pages

Text cannot show a chart. `view_pages(document_id, from_page, to_page)` gives the model the pages
themselves: up to five a call, as one PDF, which Gemini reads like any PDF.

Cutting pages out of a PDF sounds like copying them. Copied the way PDF libraries offer it, a page
brings along everything it refers to:

- **Links.** A contents page links to every section. Each link holds a reference to its target
  page, so the copy took those pages too, with their pictures: the contents page of a 7.5 MB report
  came out at 6.7 MB. Before copying, every page that is not wanted is replaced by an empty one, so
  a reference to it costs a few bytes. The same contents page is then 55 KB.
- **Shared resources.** FPDF, TCPDF, jsPDF and others write one list of all images of the file and
  give it to every page. A copy of one page carried all of them. The content of each wanted page is
  read to see which images it paints, and the page gets a list of only those. Nothing is dropped
  unless all content that could name an image was read.
- **Layers.** A file can hide a layer. The settings that say so are copied with the pages, or the
  hidden layer would show.

The pages are counted against the request twice. As bytes: base64 makes them a third larger, and
they stay in the request until the question is answered, so the room for the next look shrinks.
As tokens: about 530 a page, against half of `reservedTokens`. When either runs out, the tool says
so and the model answers from what it has
([limits and measurements](configuration.md#view_pages)).

A PDF whose text fits in the prompt gets `view_pages` too, and only that. Such a file is often a
slide deck: little text, a picture on every page.

## Map-reduce

1. Split on line boundaries into parts that fit both `mapChunkTokens` and 80% of `maxRequestBytes`,
   counting the line-number prefixes.
2. Read the parts four at a time. Each part either takes notes with line citations or replies
   `NOTHING RELEVANT`. A failed part is retried once; if it fails again, it's reported in the answer
   rather than failing the whole read.
3. If the notes are still too large, merge them in batches (or pairs) for up to 8 rounds.
4. Write one answer from the notes, flagging contradictions and parts that couldn't be read.

Part notes are capped at 4,096 output tokens and the answer at 8,192. When either cap is reached,
the tool result says the answer is incomplete and points the model to exact search. That matters
for "list every…" tasks: in a live test with 1,200 matching lines, 492 came back, flagged as
incomplete. Even without reaching a cap the model can skip items (91 of 120 in the same test), so
for a complete list or an exact count, `search_document` in exact or regex mode is the reliable
tool: it reports `total_matching_lines`.

Jobs needing more than `maxMapChunks` parts are refused, with advice to narrow the question first.

## The Gemini loop (`askGemini`)

- Document text and cards go at the **start of the first user turn** and stay there as the
  conversation grows. Gemini's prompt cache works on a matching prefix, so a follow-up question
  reuses the document instead of paying for it again (96% of input cached in a live test, against
  0% when the document was appended to the latest turn). `documentPlacement: "last"` restores the
  old layout.
- The model's turns are sent back **unchanged**, so Gemini 3 thought signatures stay intact.
- Each tool result includes `tool_turns_left`, and the tool guide asks the model to batch
  independent searches and stop when it has enough. This keeps it from searching one thing per turn.
- **Gemini can ignore `functionCallingConfig: { mode: "NONE" }`.** Live testing showed it kept
  calling tools on the turn meant to force an answer. So when the turns run out, or the model's
  last turn has no text, the final request **declares no tools at all** and adds a short "answer
  now" message. That request is the last of the `maxToolTurns`; no request is made whose tool
  calls would be thrown away.
- If even that request has no text, or Gemini blocks the prompt, the result has `answered: false`
  (and `blockReason`), so the caller can show its own message instead of an empty answer.
- Pages from `view_pages` go **inside the function response** (`functionResponse.parts`, with the
  result naming the file as `{ "$ref": "pages-12-14.pdf" }`). `toolFilePlacement: "beside"` sends
  them in a `user` turn of their own, right after the turn of function responses: Gemini 2.5 does
  not see a file inside a function response. The files do not share a turn with the function
  responses, because Vertex AI refuses a turn in which anything follows one. Both forms work with
  Gemini 3.5 on the Gemini API and on Vertex AI.
- Tool results, pages included, live inside one call of `askGemini`. They are not sent again with
  the next question.

### With an explorer model

One model does all of the above unless the endpoint names an explorer
([configuration](configuration.md#an-explorer-model)). Then the loop is split in two:

- **The requests with tools go to the explorer.** It gets the same conversation, the same tool
  guide and a line that says what its part is: gather what the answer needs, then reply `DONE`.
  Its turns go back to it unchanged, thought signatures included. Reading a whole file in parts is
  its work too.
- **The request without tools goes to the answering model**, and with an explorer it is always
  made. It holds the conversation, the explorer's function calls, and the function responses, pages
  included. It does not hold the explorer's thoughts, its thought signatures, or anything it
  wrote: the answer is written from what the files say.
- **That request ends with a user message.** A Gemini 3 model refuses a request that ends with
  the result of a function call it did not sign (HTTP 400, "Function call is missing a
  thought_signature"), and a signature belongs to the model that made the call. With a user message
  after the results, the calls belong to an earlier turn, and the request is accepted without
  signatures. The message is the "answer now" one from above.
- An explorer that calls no tool leaves nothing to answer from but the conversation, so the
  message then says that instead (`FINAL_ANSWER_WITHOUT_TOOLS`).

## Live results

`gemini-3.8-flash` on the Gemini API, November 2026:

| Case | Outcome |
|---|---|
| 5 MB, 60,000-line log (1.27M tokens by the 0.1.0 estimate, which undercounted logs) | Correct root cause, failover time, and affected services, citing the right lines (checked with grep). About 60 s, 11 tool calls, about 15K prompt tokens per turn. |
| 467 KB novel | Sent whole. Token estimate 116,840; Gemini billed 116,842. |
| Map-reduce on the novel, 40K-token parts | 4 parts, 1 relevant. Correct answer citing L2036. 32 s. |

The checks of `view_pages`, on `gemini-3.5-flash-lite`, are in
[Pictures in PDFs](configuration.md#live-results).
