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
into a file) can't reach another conversation's documents by naming their IDs.

## Prompt injection

File content goes to the model as text. A file can contain instructions ("ignore previous
instructions…"). The tools here only read the user's own documents, so the possible damage is
limited to the answer. If you combine them with tools that *act* (send email, change tickets),
treat the model's output as untrusted.

## Storage and retention

- Files expire after `ttlMs` (default 72 h); expired files are never returned. `sweep()` deletes
  them from disk. Set the TTL to match your data policy.
- `FileDocumentStore` writes plain text to disk. Use an encrypted volume, or implement
  `DocumentStore` over storage with encryption at rest.
- Only IDs matching `doc_` plus 32 hex characters ever reach the file system, so there's no path
  traversal.

## Uploads

- `maxUploadBytes` (default 100 MB) is enforced while reading, before the body is buffered fully.
- The handlers buffer the upload in memory before extraction. Under heavy concurrent uploads, put a
  limit in front (a reverse proxy or a rate limiter).
- Binary files are rejected, including compressed ones (`.gz`, `.zip`), which get a message
  telling the user to decompress first. PDF parsing runs `unpdf` (pdf.js) on untrusted input in
  your process. Keep it updated, or move extraction to a worker or sandbox for high-risk
  deployments.
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

The scan is synchronous, so a slow pattern still holds the event loop for up to 3 seconds per
search. If that matters for your latency, run the document tools in a worker thread.
