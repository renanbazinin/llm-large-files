# How it works

```
upload ─► ingest ─► store        extract text · normalize · index lines · outline · log profile
                      │
chat turn ─► prepare(ids, size of the rest of the request)
                      ├─ fits ────► full text in the prompt
                      └─ too big ─► summary card in the prompt
                                    + tool guide in the system prompt
                                    + tools: search · read · overview · analyze-all
```

## Ingest

1. **Extract** text by format (built-in extractors or your own).
2. **Normalize**: strip the BOM, unify line endings, remove control characters, split lines over
   2,000 characters.
3. **Profile**: count lines, estimate tokens and UTF-8 bytes, and build an outline (headings with
   line numbers). For logs, also count levels, find the time range, and group ERROR/FATAL/WARN lines
   by *shape*. Numbers, IDs, IPs, hex, and quoted values are replaced with placeholders, so 800
   timeouts to different hosts become one entry: `[ERROR ×812, L1203] timeout after <n>ms to <ip>`.
4. **Store** the text and metadata. Nothing else is indexed up front.

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
    refused, and scans stop after 3 seconds.
- **`read_document`**: numbered line ranges, trimmed to the result-size cap, with `next_start_line`
  for paging.
- **`get_document_overview`**: the full outline and profile, the first and last lines, and how many
  parts a whole-file read would take.
- **`analyze_whole_document`**: map-reduce (below).

Every result is capped (`toolResultCharacters`) and states what was cut, so one tool call can never
overflow the request.

## Map-reduce

1. Split on line boundaries into parts that fit both `mapChunkTokens` and 80% of `maxRequestBytes`,
   counting the line-number prefixes.
2. Read the parts four at a time. Each part either takes notes with line citations or replies
   `NOTHING RELEVANT`. A failed part is retried once; if it fails again, it's reported in the answer
   rather than failing the whole read.
3. If the notes are still too large, merge them in batches (or pairs) for up to 8 rounds.
4. Write one answer from the notes, flagging contradictions and parts that couldn't be read.

Jobs needing more than `maxMapChunks` parts are refused, with advice to narrow the question first.

## The Gemini loop (`askGemini`)

- The model's turns are sent back **unchanged**, so Gemini 3 thought signatures stay intact.
- Each tool result includes `tool_turns_left`, and the tool guide asks the model to batch
  independent searches and stop when it has enough. This keeps it from searching one thing per turn.
- **Gemini can ignore `functionCallingConfig: { mode: "NONE" }`.** Live testing showed it kept
  calling tools on the turn meant to force an answer. So when the turns run out (or the model goes
  quiet), the final request **declares no tools at all** and adds a short "answer now" message.
  There is always a written answer.

## Live results

`gemini-3.8-flash` on the Gemini API, November 2026:

| Case | Outcome |
|---|---|
| 5 MB, 60,000-line log (about 1.27M tokens, over the 1M limit) | Correct root cause, failover time, and affected services, citing the right lines (checked with grep). About 60 s, 11 tool calls, about 15K prompt tokens per turn. |
| 467 KB novel | Sent whole. Token estimate 116,840; Gemini billed 116,842. |
| Map-reduce on the novel, 40K-token parts | 4 parts, 1 relevant. Correct answer citing L2036. 32 s. |
