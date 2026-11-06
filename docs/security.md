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
- Binary files are rejected. PDF parsing runs `unpdf` (pdf.js) on untrusted input in your process.
  Keep it updated, or move extraction to a worker or sandbox for high-risk deployments.

## Regex search

Model-supplied regexes with nested quantifiers (`(a+)+`) are refused, and scans stop after 3
seconds. A single very long line can still slow down a pathological pattern; lines are capped at
2,000 characters at ingest, which bounds the worst case.
