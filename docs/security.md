# Security

Uploaded files often contain sensitive data: production logs, contracts, customer exports. Review
these points before deploying.

## Ownership

Pass the signed-in user (or tenant) as `owner`:

```ts
await files.ingest({ name, bytes, owner: user.id });
await files.prepare(ids, base, { owner: user.id });
await askGemini({ ..., owner: user.id });
createDocumentHandlers(files, { getOwner: (req) => req.user?.id });
```

A document with an owner is invisible to every other owner, and to callers that pass no owner. It
counts as missing in `prepare`, `getMeta`, `delete`, and `askGemini`. Documents ingested without an
owner are usable by anyone who has the ID.

**Without owners, a document ID works like a password.** IDs are random 128-bit values, but they
can leak through logs, browser storage, or shared links.

## Tool scoping

`files.tools(documents)` accepts only the IDs it was created with. A model (or a prompt injected
into a file) can't reach another conversation's documents by naming their IDs. `view_pages` has
its own list, the PDFs passed as `viewPages`, and checks it the same way.

## Prompt injection

File content goes to the model as text. A file can contain instructions ("ignore previous
instructions…"). The tools here only read the user's own documents, so the possible damage is
limited to the answer. If you combine them with tools that *act* (send email, change tickets),
treat the model's output as untrusted.

## Storage and retention

- Files expire after `ttlMs` (default 72 h); expired files are never returned. `sweep()` deletes
  them from disk. Set the TTL to match your data policy.
- A delete takes effect on every server that shares the store, from the next tool call on: a
  document kept in memory is used only after the store confirms that it is still there. (Before
  0.4, another server could keep answering from its memory until the document expired.)
- `FileDocumentStore` writes plain text to disk. Use an encrypted volume, or implement
  `DocumentStore` over storage with encryption at rest.
- Only IDs matching `doc_` plus 32 hex characters ever reach the file system, so there's no path
  traversal.

## Original files

With `keepOriginals`, the uploaded file itself is stored next to its text (`<id>.bin` in
`FileDocumentStore`). That is off by default. When you turn it on:

- **More is kept than before.** The text of a PDF leaves out its pictures, signatures, stamps and
  hidden layers; the file has them all, and its metadata (author, software, dates). Treat the
  store as you treat the uploads themselves.
- **It follows the document.** The file has the document's owner and its expiry: it is returned
  only to the owner (`files.getOriginal(id, { owner })`), it is gone for every reader once the
  document has expired, and `delete` and `sweep` remove it from disk. A store of your own must do
  the same in its `delete` and `sweep`.
- **It takes space.** Up to `maxUploadBytes` (100 MB) per document, for `ttlMs` (72 h). Lower
  either, or sweep more often, if disk is short.
- **Pages go to the model.** `view_pages` sends the pages the model asks for to your model
  provider, as the text of the file already goes. A PDF that is encrypted only to restrict printing
  or copying is opened, and the cut is not encrypted: the restriction does not travel with it.

## Reading PDFs for pages and pictures

Showing pages and marking pictures read the whole PDF into objects with `@cantoo/pdf-lib`, in your
process, on a file a user uploaded.

- **Memory.** About twice the size of the file, plus 1 to 1.6 KB for each object in it. A file of
  54 MB with 330,000 objects needed 700 MB. A file that declares more objects than the free heap
  can hold, or more than a million, is refused before it is read (150,000 for the picture marks).
  That check trusts what the file declares: a file that lies about it is still read.
- **Time, and no hard limit.** Reading cannot be interrupted once it has started. It pauses every
  4,000 objects so other requests get a turn, but a crafted file can hold the process: 1 MB of
  junk between two objects took 3.6 seconds to skip. Errors are caught and the model is told that
  the pages cannot be shown; a file that only takes long is not stopped.
- For uploads you do not trust, run ingest and the document tools in a worker thread or a separate
  process with a memory limit and a timeout, as recommended for PDF text extraction below.

## Uploads

- `maxUploadBytes` (default 100 MB) is enforced while reading, before the body is buffered fully.
- The handlers buffer the upload in memory before extraction. Under heavy concurrent uploads, put a
  limit in front (a reverse proxy or a rate limiter).
- A DOCX or PPTX is unpacked a piece at a time, and refused as it grows past 100 times its size
  (after the first 16 MB) or past 128 MB of XML: a zip bomb of 160 KB that unpacks to 50 MB is
  stopped at 16 MB. Its XML is read in one pass, so its shape cannot make reading slower.
- A terminal escape sequence (`ESC ]` …) is removed only up to its end on the same line: one
  without an end loses its two escape characters, not the lines after it.
- Binary files are rejected, including compressed ones (`.gz`, `.zip`), which get a message
  telling the user to decompress first. PDF parsing runs `unpdf` (pdf.js), and with it installed
  `@cantoo/pdf-lib`, on untrusted input in your process. Keep them updated, or move extraction to a
  worker or sandbox for high-risk deployments.
- File names are reduced to one printable line at ingest (no path, control characters, line
  breaks, or text-direction overrides) and quoted in the system instruction, so a name can't add
  lines to the prompt. The name is still text the model reads, like the file's content.

## Regex search

The model writes the regex, and the model reads untrusted file text, so a file can ask for a
slow pattern. Two things bound the cost:

- Regexes with nested quantifiers (`(a+)+`) are refused up front. This is a quick filter, not a
  guarantee: `(a|a)+$` and `((a+))+$` pass it.
- Every regex scan runs under a 3-second limit enforced by Node's `vm` timeout, which interrupts a
  match that is still backtracking. The search returns what it found with a note that it stopped
  early.
- The scan runs in slices of 250 ms, and other requests get a turn between two slices. A line
  that takes two whole slices ends the search: `(a|a)+$` on a line it cannot get past costs
  about 0.8 seconds, not 3.
- The regex searches of one tool set, which is one question in `askGemini`, share 6 seconds
  (`regexBudgetMs`). Past that, a regex search is refused and the model is told to search
  another way.
- `askGemini` runs at most 8 tool calls of one model turn (`maxToolCallsPerTurn`).

A slice is synchronous, so a slow pattern still holds the event loop for up to a quarter of a
second at a time, and twice that at the start of a search. If that matters for your latency, run
the document tools in a worker thread.

## What a question can cost

A file can ask a model to do expensive things, and a model can decide to on its own. These bound
one question, whatever the model:

- `limits.toolTurns` (12) chat requests, with at most `limits.callsPerTurn` (8) tool calls run in
  each.
- One whole-file read of each document (`limits.wholeDocumentReads`). A read is up to
  `maxMapChunks` requests of up to `mapChunkTokens` each: 3M input tokens with the defaults. In a
  probe a model asked for the same file to be read whole six times in one question.
- `limits.inputTokens` and `limits.requests`, unset by default, are ceilings for the whole
  question, part reads included. Set them if a question must not pass a cost.
- The request is kept inside the model's window ([Room in the request](configuration.md#room-in-the-request)),
  so a turn of many large reads cannot build a request that the model refuses.

`result.usage` is what the question used: every request that was answered, for each model. Log it
per user to see who spends what.

## Storage errors

A file-system error names the path it failed on, and a database error its host. Neither is shown
to a model or a user: a read of the store that fails becomes a `DocumentStoreError` whose message
holds the error code at most (`The document store could not be read (EACCES). Try again.`), and a
tool call answers with that message. The original error is its `cause`. Log that one.
