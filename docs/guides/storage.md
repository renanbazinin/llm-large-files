# Storage

Where your documents live, who may use them, and for how long. This guide covers the two stores
that come with the library, owners and a layout per user and per chat, retention, keeping the
uploaded files, the contract a store of your own must meet, and the memory cache in front of the
store. The signatures of everything named here are in [the library reference](../reference/library.md).

## What a store holds

`files.ingest` turns an upload into a document and hands it to the store, which keeps up to four
parts under the document's ID:

| Part | What it is | Written |
|---|---|---|
| Metadata | `DocumentMeta`: owner, file name, format, sizes, lines, outline, log profile, `createdAt`, `expiresAt`. | Always, last. |
| Text | The extracted text, normalized, as one string. | Always. |
| Line index | Where each line starts, in bytes and in characters: about 8 bytes a line. With it, a document read by range is opened without first reading all of its text. | When the store has `putIndex`. |
| Original | The uploaded file, byte for byte. | When `keepOriginals` lists the format and the store has `putOriginal`. |

The library makes the ID: `doc_` and 32 hexadecimal digits of a random UUID. It is new at every
ingest and never reused. `DOCUMENT_ID_PATTERN` (`/^doc_[a-f0-9]{32}$/`) matches it, and
`isDocumentId(value)` tests a value against it: use it on IDs that arrive in a request before they
reach your database. The library tests every ID itself before it asks the store. An ID that does
not match counts as missing, so a store only ever receives IDs that match.

A store holds documents, not conversations. The tool rounds of a conversation (`toolTurns`) hold
excerpts of the files, and keeping them is up to you: see [Conversations](./conversations.md).

## Choosing a store

| Store | Use it for | Survives a restart | Several servers | Reads large files by range |
|---|---|---|---|---|
| `MemoryDocumentStore` | Tests, scripts, a demo in one process. | No | No | No |
| `FileDocumentStore` | One server, or several on a shared volume. | Yes | On a shared volume | Yes |
| Your own | A database and object storage, or what your platform has ([below](#writing-a-store-of-your-own)). | Up to you | Up to you | When it has `readTextRange` |

```ts
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore } from "llm-large-files";

// A server: one directory, kept across restarts. Several servers can share it on one volume.
export const files = createLargeFiles({ store: new FileDocumentStore(process.env.DOCUMENTS_DIR!) });

// Tests and scripts: everything is gone when the process ends.
export const scratch = createLargeFiles({ store: new MemoryDocumentStore() });
```

### `MemoryDocumentStore`

`new MemoryDocumentStore({ now })` keeps everything in the memory of the process.

- It has no `readTextRange`: every document is loaded whole, whatever its size.
- It keeps originals, as a copy of the uploaded bytes.
- `get` and `getMeta` remove a document that has expired when they are asked for it. `sweep`
  removes every one that has.
- `now` is its clock, `() => new Date()` by default. In a test, give the store and
  `createLargeFiles({ now })` the same clock: see [Testing](./testing.md).

### `FileDocumentStore`

`new FileDocumentStore(directory, { now, orphanAgeMs })` keeps each document as files in one
directory, which it creates at the first write. There are no subdirectories:

| File | Holds |
|---|---|
| `<id>.json` | The metadata, as JSON. The document exists while this file does. |
| `<id>.txt` | The text, as UTF-8. |
| `<id>.idx` | The line index: a 40-byte header, then 4 bytes for each line start in bytes and in characters, and for each passage and page start. About 6 MB for 730,000 lines. |
| `<id>.bin` | The uploaded file, with `keepOriginals`. |
| `<id>.<ext>.<8 hex digits>.tmp` | A file being written. It is renamed to its own name once complete. |

- Every file is written under a temporary name and then renamed, so no reader, on this server or
  another one, sees half a file. A rename that meets `EPERM`, `EACCES` or `EBUSY` (on Windows,
  another process has the file open for a moment) is tried again for up to about three seconds.
- `put` writes the text first and the metadata last. `delete` removes the metadata first, and
  nothing else when that fails. A document never appears without its text, and is never listed once
  its text is gone.
- Only IDs that match `DOCUMENT_ID_PATTERN` reach the file system. A read or a `delete` with another
  ID finds nothing, and `put`, `putIndex` and `putOriginal` throw "Invalid document ID."
- A missing file means a missing document. Any other failure of a read (a volume that does not
  answer, too many open files) is thrown, and the library passes it on as a `DocumentStoreError`.
  There are two exceptions: an index file that cannot be read is built again from the text, and
  `sweep` returns 0 when it cannot list the directory. A failed write or delete is thrown as it
  came ([Errors](#errors)). Metadata that cannot be parsed counts as absent.
- `getMeta` removes a document that has expired, by the store's own clock (`now`).
- `readTextRange` reads only the bytes asked for, so a tool call never loads a large file whole.
  The whole text is read only when the plan sends it in the prompt.
- `sweep` removes expired documents and returns how many. It also removes files that belong to no
  document (an upload that failed, a server that stopped while writing) and temporary files, once
  they are `orphanAgeMs` old, one hour by default: a younger one may be an upload in progress on
  another server. A document whose metadata could not be read at all is left alone, whatever its
  age. One that cannot be removed is left for the next sweep, and does not stop this one.
- The files are plain. The metadata names the owner, the file name, the headings and the log
  message templates. A delete removes the files without overwriting them. If that matters, encrypt
  the volume: see [Security](../security.md).

Several servers can share the directory on a network volume. What that needs, from where to run the
sweep to servers of two versions during an upgrade, is in [Deployment](./deployment.md).

## Owners

### How ownership works

Pass `owner` when you ingest a file, and the same owner on every later call. The library records it
in `meta.owner` and compares it, before every use, with the owner of the call:

```ts
// `files` is your library, as in the sample above.
const bytes = new TextEncoder().encode("Clause 1. ...\nClause 2. ...\n");
const meta = await files.ingest({ name: "contract.txt", bytes, owner: "user-42" });

await files.getMeta(meta.id, { owner: "user-42" }); // the metadata
await files.getMeta(meta.id, { owner: "user-7" });  // undefined: as if it did not exist
await files.getMeta(meta.id);                        // undefined
await files.delete(meta.id, { owner: "user-7" });    // false: nothing is removed
await files.delete(meta.id, { owner: "user-42" });   // true
```

| Call | Takes the owner as | A document of another owner |
|---|---|---|
| `files.ingest(input)` | `input.owner` | |
| `files.getMeta(id, access)` | `access.owner` | `undefined` |
| `files.getOriginal(id, access)` | `access.owner` | `undefined` |
| `files.delete(id, access)` | `access.owner` | `false`, and nothing is removed |
| `files.prepare(ids, base, options)` | `options.owner` | Listed in `missing`, and never read |
| `askWithFiles(options)`, `askGemini(options)` | `options.owner` | `DocumentsNotFoundError`, before any model request |
| `createDocumentHandlers(files, options)` | `options.getOwner(request)` | 404 "This file is no longer available." on GET; `{ "deleted": false }` on DELETE |

- A document of another owner looks exactly like one that does not exist, so a caller cannot learn
  that an ID is in use.
- The comparison is exact (`===`): `"alice"` does not reach a document of `"Alice"` or of
  `"alice/chat-1"`. There is no hierarchy and no wildcard.
- A document ingested without an owner can be used by anyone who has its ID, whether they pass an
  owner or not. With signed-in users, always pass one. In `createDocumentHandlers`, a `getOwner` that
  returns undefined makes an anonymous upload. To refuse a request without a user, throw from it with
  a status ([Web app](./web-app.md)).
- The owner cannot be changed after ingest. Use a stable, opaque ID, not an email address that may
  change.
- `files.tools(documents)` takes no owner: it trusts the metadata it is given. In a loop of your
  own, pass it only metadata from `prepare(ids, base, { owner })` or `getMeta(id, { owner })`
  ([Your own adapter and loop](./own-adapter-and-loop.md)). `askWithFiles` does this for you.

### Choosing the owner string

The owner is any string you choose. The library has no notion of a chat or session, and cannot list
documents by owner. Two schemes work well:

| Owner | What the library enforces | What your application does |
|---|---|---|
| The user: `userId` | No user can use another user's documents. | Keeps each chat's document IDs in its session record and passes those, never a list from the browser as it came. A document can serve several chats of its user. |
| The user and the chat: `` `${userId}/${sessionId}` `` | A document can be used only in the chat it was uploaded to. | Builds the same string for every call: upload, questions, GET, DELETE. `getOwner` must then know the chat, from the URL or a header. A file used in two chats is uploaded twice. |

The [Conversations](./conversations.md) guide uses the first scheme. To switch to the second,
change the `owner` you pass, everywhere.

### A layout per user and per chat

With chats kept as MongoDB records, as in [Conversations](./conversations.md)
(`{ _id, userId, documentIds }`, and one record per question in `turns`), the session record is the
list of a chat's documents:

```ts
// chat-documents.ts. `files` is your library; `sessions` and `turns` are the collections of the
// Conversations guide.
import { toDocumentSummary, type DocumentSummary } from "llm-large-files";

/** Adds a file to a chat. The user owns it, and the session record lists it. */
export async function attach(userId: string, sessionId: string, file: { name: string; mimeType?: string; bytes: Uint8Array }): Promise<DocumentSummary> {
  if (!await sessions.findOne({ _id: sessionId, userId })) throw new Error("No such chat.");
  const meta = await files.ingest({ ...file, owner: userId });
  try {
    await sessions.updateOne({ _id: sessionId, userId }, { $addToSet: { documentIds: meta.id } });
  } catch (error) {
    // A document that no chat lists would stay until it expires.
    await files.delete(meta.id, { owner: userId }).catch(() => undefined);
    throw error;
  }
  return toDocumentSummary(meta);
}

/** The documents a question of this chat may use: all of the chat's, or those the user picked. */
export async function documentsFor(userId: string, sessionId: string, picked?: string[]): Promise<string[]> {
  const session = await sessions.findOne({ _id: sessionId, userId });
  if (!session) throw new Error("No such chat.");
  return picked ? picked.filter((id) => session.documentIds.includes(id)) : session.documentIds;
}

/** Deletes a chat: its documents, its questions (their tool rounds hold excerpts), then the chat. */
export async function deleteChat(userId: string, sessionId: string): Promise<void> {
  const session = await sessions.findOne({ _id: sessionId, userId });
  if (!session) return;
  for (const id of session.documentIds) await files.delete(id, { owner: userId });
  await turns.deleteMany({ sessionId });
  await sessions.deleteOne({ _id: sessionId, userId });
}
```

- Ask with `owner: userId` and `documentIds: await documentsFor(userId, sessionId)`. When documents
  have expired, the question throws `DocumentsNotFoundError` with their IDs:
  [Conversations](./conversations.md) shows how to take them off the chat and ask the user for them
  again.
- `files.delete` gives false for a document that has already expired or been deleted. There is
  nothing left to do for it.
- If your application lets a document serve several chats, delete it only when no other chat lists
  it.
- The `upload` handler of `createDocumentHandlers` answers the request itself, so it cannot record
  the new ID in your session. Call `attach` from a route of your own, or record the ID the browser
  sends back in a second request, after checking it with `files.getMeta(id, { owner })`. Routes are
  in [Web app](./web-app.md).
- To delete everything of a user (an account that is closed), collect the IDs from the user's chats.
  The library cannot find a user's documents. A store of your own can, if it keeps the owner where it
  can query it, as the [example store](#example-object-storage-and-a-database) does.

### Files in a folder per user or per chat

Every call but `put` gives a store the document ID without its metadata. `putOriginal` and
`putIndex` come before `put`, so a store cannot know the owner of a file it is writing.
A store therefore keys its files by document ID, and the layout by user and chat lives in your
database: the session record lists the IDs, and a store of your own can keep the owner next to each
document.

If your storage rules need each chat's files in a folder of their own, give each chat a library of
its own, over its own `FileDocumentStore`:

```ts
import path from "node:path";
import { createLargeFiles, FileDocumentStore, type LargeFiles } from "llm-large-files";

// One case only: on a volume that ignores case, "Alice" and "alice" would be one folder.
const SAFE_ID = /^[a-z0-9_-]{1,64}$/;

/** The library of one chat: its files are in <DOCUMENTS_DIR>/<user>/<chat>/. */
export function filesOf(userId: string, sessionId: string): LargeFiles {
  // The IDs become a path: refuse anything that could lead out of the directory.
  if (!SAFE_ID.test(userId) || !SAFE_ID.test(sessionId)) throw new Error("Invalid user or chat ID.");
  return createLargeFiles({
    store: new FileDocumentStore(path.join(process.env.DOCUMENTS_DIR!, userId, sessionId)),
    cacheBytes: 32 * 1024 * 1024, // each library has a cache of its own
  });
}
```

On a volume that ignores case (Windows, macOS, SMB shares), IDs that differ only in case would
share a folder, so the check takes lower case only. If your IDs are mixed case and unique
regardless of case, lower-case them before the check. IDs your database makes, such as UUIDs or
MongoDB ObjectIds in lower-case hex, pass it as they are.

What that costs:

- `cacheBytes` and `maxConcurrentScans` bound each library, not the process. A library made for one
  request starts with an empty cache, so each question reads its documents from the store again.
- Each chat's folder needs a sweep of its own: `new FileDocumentStore(folder).sweep()` for each one.
  The store never removes the folder itself.
- Deleting a chat is removing its folder, once no question of that chat is running.
- A document of another chat is not found: the folder is the boundary.

## Retention

| Option | Default | What it does |
|---|---|---|
| `ttlMs` | 72 hours (259,200,000 ms) | How long a document is kept after it is ingested. `Infinity` keeps it until it is deleted. |

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.DOCUMENTS_DIR!),
  ttlMs: 7 * 24 * 60 * 60 * 1000, // a week, in place of 72 hours
});

// Nothing runs the sweep for you. With several servers, one place is enough: see the Deployment guide.
setInterval(() => {
  files.sweep().then(
    (removed) => console.log(`sweep: ${removed} expired documents removed`),
    (error: unknown) => console.error("sweep failed", error),
  );
}, 60 * 60 * 1000).unref();
```

- At ingest, `expiresAt` is set to `createdAt` plus `ttlMs`. It never changes: the library has no
  call to extend it.
- From that instant the document counts as missing everywhere: `getMeta` and `getOriginal` give
  undefined, `prepare` lists it in `missing`, and a question throws `DocumentsNotFoundError`. The
  library checks `expiresAt` with its own clock before every use, whether or not the store has
  removed the files yet.
- `ttlMs: Infinity`, or a time to live that runs past the year 9999, sets `expiresAt` to
  `NEVER_EXPIRES`: `"9999-12-31T23:59:59.999Z"`. It is a date like any other, so every comparison,
  and a server of an older version, reads it without a special case. `meta.expiresAt ===
  NEVER_EXPIRES` tells you a document never expires.
- `files.sweep()` calls the store's `sweep` with the library's clock and returns how many documents
  it removed: 0 when the store has no `sweep`. Run it on a schedule. The built-in stores also remove
  an expired document when they are asked for it.
- `files.delete(id, { owner })` removes a document at once, with its index and its original. It
  returns true when the document was there, and false when it was missing, had expired, or belongs to
  another owner. Every server that shares the store sees the delete from its next call, since every
  use asks the store first.
- A delete or an expiry does not reach what your application kept. Stored tool rounds hold
  excerpts of the files (up to `toolResultCharacters` a result) and outlive both: your rules for
  keeping and deleting data must cover them ([Conversations](./conversations.md)). What the model
  provider keeps is in [Security](../security.md).

A chat that lives longer than `ttlMs` loses its documents, and its next question throws
`DocumentsNotFoundError`. To keep documents as long as their chat:

- Set a `ttlMs` longer than your chats live.
- Or set `ttlMs: Infinity`, and delete the documents yourself: with their chat (`deleteChat` above),
  or in a job of your own after a time without use. Then a document whose ID your application never
  recorded (an upload whose ID was never sent back, a server that stopped between ingest and saving
  the session) stays for good: the library cannot find it. Keep the owner where you can query it,
  as the [example store](#example-object-storage-and-a-database) does, or keep a finite `ttlMs`.
- Or, in a store of your own, write a later `expiresAt` into the metadata of a document whose chat
  is in use. The library reads the date from `getMeta` before every use. Keep the format of
  `toISOString()`. In the example store below, change `meta.expiresAt` and the record's own
  `expiresAt` together: `sweep` and a TTL index read the second.

## Keeping the uploaded files

By default a store keeps only the text of a document. `keepOriginals` also keeps the uploaded file:

| Option | Default | What it does |
|---|---|---|
| `keepOriginals` | `[]` | Formats whose uploaded file is kept next to its text, for example `["pdf"]`. |

```ts
import type { ServerResponse } from "node:http";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.DOCUMENTS_DIR!),
  keepOriginals: ["pdf"], // so that view_pages can show the model the pages of a PDF
});

/** A file name for `filename*` (RFC 8187), which does not allow ' ( ) *: encodeURIComponent leaves them. */
const encodeFileName = (name: string) =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Sends a kept upload back to its owner, or a 404. */
export async function sendOriginal(response: ServerResponse, id: string, owner: string): Promise<void> {
  const meta = await files.getMeta(id, { owner });
  const original = meta && await files.getOriginal(id, { owner });
  if (!meta || !original) {
    response.statusCode = 404;
    response.end();
    return;
  }
  // meta.mimeType is what the client declared at upload: do not serve the file as that.
  response.setHeader("Content-Type", meta.format === "pdf" ? "application/pdf" : "application/octet-stream");
  response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeFileName(meta.name)}`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(original);
}
```

- It is off by default because it costs space: a kept file is as large as the upload, up to
  `maxUploadBytes` (100 MB by default), and stays until the document expires or is deleted.
- A kept original is what `view_pages` shows the model, and what lets a scanned PDF be accepted.
  Both are in [PDFs](./pdfs.md).
- The store needs `putOriginal` to keep a file and `getOriginal` to give it back. The built-in stores
  have both. A store without `putOriginal` keeps nothing, whatever `keepOriginals` says.
- `meta.originalKept` is true when the file of a document is kept. `files.getOriginal(id, { owner })`
  returns it, under the same owner rule as everything else. Treat the bytes as read-only: they may be
  the store's own copy.
- Documents ingested before you turned it on have no original. Upload them again to get one.

## Writing a store of your own

A store of your own implements `DocumentStore`: four methods are required, six are optional. The
library calls them. Your application calls them only to test the store, or to sweep a store that no
library uses.

### The methods

| Method | Required | When the library calls it | What it must do |
|---|---|---|---|
| `put(document)` | Yes | `ingest`, last, after `putOriginal` and `putIndex`. | Keep `document.meta` and `document.text`. Keep the text exactly, as UTF-8: `readTextRange` offsets point into those bytes. Let the document appear only once all of it is written. |
| `getMeta(id)` | Yes | Before every use of a document: `getMeta`, `getOriginal`, `delete`, `prepare` (once a document), and every tool call that reads one. | Return the metadata, or undefined when there is no such document. Keep it cheap: one look-up by key, without reading the text. |
| `get(id)` | Yes | To load a document whole: one whose text is at most `wholeDocumentBytes`, or any document when the store has no `readTextRange`. Once a library while the document stays in the cache. | Return `{ meta, text }` with the text exactly as `put` got it, or undefined. |
| `delete(id)` | Yes | `files.delete`, after the owner check. And `ingest`, to clean up after a write that failed. | Remove the metadata first, then the text, the index and the original. Return true when the document was there. Cope with a document that was only partly written. |
| `sweep(now?)` | No | `files.sweep()`, with the library's clock. | Remove the documents whose `expiresAt` is at or before `now`, with all their parts. Return how many. |
| `putOriginal(id, bytes)` | No | `ingest`, first, when `keepOriginals` lists the format. | Keep the bytes as they are now: the caller may reuse its buffer afterwards. |
| `getOriginal(id)` | No | `files.getOriginal` and `view_pages`, for a document whose `meta.originalKept` is true. | Return the bytes, or undefined. |
| `readTextRange(id, start, end)` | No | To read a document larger than `wholeDocumentBytes`, and to build its index. Only after `getMeta` found the document. | Return the bytes of the text from `start` (inclusive) to `end` (exclusive). See [Reading by range](#reading-by-range). |
| `putIndex(id, index)` | No | `ingest`, after `putOriginal` and before `put`, for every document. Again when a document read by range has no index, or one that does not match its text. | Keep the bytes. |
| `getIndex(id)` | No | When a document read by range is opened. | Return the bytes `putIndex` kept, or undefined. A damaged index is noticed and built again. |

The library checks `expiresAt` itself, with its own clock, before every use. Your `getMeta` and
`get` may return a document that has expired; your `sweep` must remove it.

What a missing optional method changes:

| Without | What happens |
|---|---|
| `sweep` | `files.sweep()` returns 0. Expired documents stay in storage until you remove them, although they are never served. |
| `putOriginal` | No original is kept, whatever `keepOriginals` says, and `meta.originalKept` is never set. No `view_pages`, and a PDF without text (a scan) is refused. |
| `getOriginal` | `files.getOriginal` returns undefined, and `view_pages` is never offered. |
| `readTextRange` | Every document is loaded whole with `get`, whatever its size, so memory grows with the size of the files in use and the number of users. `wholeDocumentBytes`, `scanChunkBytes` and `maxConcurrentScans` change nothing. |
| `putIndex` and `getIndex` | With `readTextRange` only: the index of a large document is built by reading its whole text once, 4 MB at a time, each time the document is opened, that is, each time it is not in the cache. |

### Reading by range

`readTextRange(id, start, end)` is what lets a server answer questions about a 100 MB log without
holding it in memory. A tool call reads the lines it shows, and a search reads the text a piece at a
time ([the cache](#the-cache) has the sizes). The rules:

- `start` and `end` are UTF-8 byte offsets into the text exactly as `put` got it. The index is built
  from those bytes at ingest, so do not re-encode the text, add a byte-order mark or change line
  endings.
- Return every byte asked for, unless the text ends first. A read that comes back short in the
  middle of the text is taken for a text that does not match its index: that call answers "The
  stored text of report.log did not match its index. Try the call again.", and the index is built
  again.
- Return fewer bytes at the end of the text, and an empty array when `start` is at or past its end.
  That happens: the index is built by reading 4 MB at a time until a read comes back short, so a
  text whose size is a multiple of 4 MB ends with a read that starts at its end.
- Return undefined when the document is gone. The call then answers "doc_… is no longer available on
  the server. Ask the user to attach the file again."

How that maps to common storage:

- Object storage over HTTP (S3, Cloud Storage, Azure Blob Storage): send `Range:
  bytes=${start}-${end - 1}`, since the last byte of an HTTP range is included. A range that runs past
  the end gives what there is. One that starts at or past the end is answered 416 (Range Not
  Satisfiable): return an empty array then.
- Redis: `GETRANGE key start end-1`, whose end is included too. It answers an empty string for a
  missing key as well, so tell the two apart before you return an empty array.
- A file on a volume: read at an offset, as `FileDocumentStore` does.

### Errors

Return undefined only when the document is not there. Throw for everything else: a database that is
down, a timeout, a refused permission. A store that returns undefined for a failure tells the library
the document is gone, and the user is asked to upload it again.

What the library does with what you throw depends on the call:

- **Reads** (`get`, `getMeta`, `getOriginal`, `readTextRange`): whatever you throw is passed on as a
  `DocumentStoreError`. Its message is "The document store could not be read (EIO). Try again.", with
  the code in parentheses only when your error has a string `code`. Its `code` and `syscall` are
  those of your error, when they are strings, as a Node system error has them. Its `cause` is your
  error: log that one. The message names no path or host, so it can be shown to a user or a model.
  `prepare`, `askWithFiles` and `files.getMeta` throw it; a tool call answers the model with its
  message, and the model can try again. A `DocumentStoreError` you throw yourself
  (`new DocumentStoreError(cause)`, which takes only the cause) is passed on as it is; you never need
  to. What to show the user is in [Errors and reliability](./errors-and-reliability.md).
- **`getIndex`**: an error is not passed on. The index is built from the text instead.
- **Writes at ingest** (`putOriginal`, `putIndex`, `put`): the library calls `delete(id)` to remove
  what was written, ignores any error of that, and throws your error as it came. Through the `upload`
  handler of `createDocumentHandlers`, an error with a `status` (or `statusCode`) from 400 to 599 is
  answered with that status and its message (a 413 with "The file is larger than the … upload
  limit.", and an empty message with "Upload failed."). A Node system error (a string `code` and `syscall`) is
  answered 500 "Upload failed (CODE).". Any other error is answered 422 with its own message, as for
  a file that cannot be read: a database driver's error would reach the browser with its host name.
  Give your write errors a status and a message of your own, as the example below does.
- **`delete` and `sweep`**: your error comes out of `files.delete` and `files.sweep` as it came. The
  DELETE handler answers it 500 without its message, unless it has a status.
- **`putIndex` on a later read**: an error is ignored. The index is used from memory, and built again
  the next time.

### Concurrency and several servers

- Every method may run many times at once, for the same document too. Many users ask at once, the
  tool calls of one turn run together, and a search reads the next piece of a text while it searches
  the current one.
- In one library, calls that open the same document at the same time share one opening: one `get`,
  or one `getIndex`.
- A document is written once: its ID is new at every ingest. Only `putIndex` writes again, later, for
  a document whose index was missing or did not match its text. Several servers may do that at once,
  with the same bytes: let the last write win.
- Make the metadata the point where a document exists. Write it last, in `put`, after the text, and
  remove it first in `delete`. A server that finds the metadata must be able to read all of the text.
  `FileDocumentStore` gets this on a shared volume by writing under a temporary name and renaming.
- A document deleted by another server between `getMeta` and a read is answered as gone: return
  undefined from that read.

### Example: object storage and a database

This store keeps the metadata in a MongoDB collection and the text, the index and the original in
object storage. The object storage calls are behind a small interface of your own, `Blobs`, so the
store works over S3, Cloud Storage, Azure Blob Storage or a volume: write those four calls with your
SDK, following [Reading by range](#reading-by-range).

```ts
// blob-document-store.ts
import type { Collection } from "mongodb";
import { DOCUMENT_ID_PATTERN, type DocumentMeta, type DocumentStore, type StoredDocument } from "llm-large-files";

/** The object storage calls the store needs. Write them over S3, Cloud Storage, Azure Blob Storage or a volume. */
export interface Blobs {
  /** Writes the whole object, replacing any object under that key. */
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** The whole object, or undefined when there is no such object. Throws on any other failure. */
  read(key: string): Promise<Uint8Array | undefined>;
  /**
   * Bytes `start` (inclusive) to `end` (exclusive): fewer at the end of the object, an empty array
   * when `start` is at or past its end, and undefined when there is no such object.
   */
  readRange(key: string, start: number, end: number): Promise<Uint8Array | undefined>;
  /** Removes the object. No error when there is none. */
  remove(key: string): Promise<void>;
}

/** One record a document: the metadata, and two fields copied out of it to query by. */
export type DocumentRecord = {
  _id: string;
  meta: DocumentMeta;
  owner: string | null;
  expiresAt: Date;
};

/** A write that failed: a 503 from createDocumentHandlers, with a message that names no host. */
function notStored(cause: unknown): Error {
  return Object.assign(new Error("The file could not be stored. Try again.", { cause }), { status: 503 });
}

export class BlobDocumentStore implements DocumentStore {
  constructor(
    private readonly blobs: Blobs,
    private readonly records: Collection<DocumentRecord>,
    private readonly prefix = "llm-large-files",
  ) {}

  /** Only a document ID becomes part of a key, as in the built-in stores. */
  private key(id: string, kind: "txt" | "idx" | "bin"): string {
    if (!DOCUMENT_ID_PATTERN.test(id)) throw new Error("Invalid document ID.");
    return `${this.prefix}/${id}.${kind}`;
  }

  /** Called last at ingest. The text first, the record last: a document exists once its record does. */
  async put({ meta, text }: StoredDocument): Promise<void> {
    try {
      await this.blobs.write(this.key(meta.id, "txt"), new TextEncoder().encode(text));
      await this.records.insertOne({ _id: meta.id, meta, owner: meta.owner ?? null, expiresAt: new Date(meta.expiresAt) });
    } catch (error) {
      throw notStored(error);
    }
  }

  /** Called before every use of a document: one look-up by key. */
  async getMeta(id: string): Promise<DocumentMeta | undefined> {
    return (await this.records.findOne({ _id: id }))?.meta;
  }

  async get(id: string): Promise<StoredDocument | undefined> {
    const meta = await this.getMeta(id);
    const bytes = meta && await this.blobs.read(this.key(id, "txt"));
    return meta && bytes ? { meta, text: new TextDecoder().decode(bytes) } : undefined;
  }

  /** UTF-8 bytes of the text exactly as `put` wrote it. Called only after getMeta found the document. */
  async readTextRange(id: string, start: number, end: number): Promise<Uint8Array | undefined> {
    if (end <= start) return new Uint8Array(0); // never send an empty range to storage
    return this.blobs.readRange(this.key(id, "txt"), start, end);
  }

  async putIndex(id: string, index: Uint8Array): Promise<void> {
    try {
      await this.blobs.write(this.key(id, "idx"), index);
    } catch (error) {
      throw notStored(error);
    }
  }

  async getIndex(id: string): Promise<Uint8Array | undefined> {
    return this.blobs.read(this.key(id, "idx"));
  }

  async putOriginal(id: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.blobs.write(this.key(id, "bin"), bytes);
    } catch (error) {
      throw notStored(error);
    }
  }

  async getOriginal(id: string): Promise<Uint8Array | undefined> {
    return await this.getMeta(id) ? this.blobs.read(this.key(id, "bin")) : undefined;
  }

  /** The record first: if removing it fails, nothing else is touched and the document stays whole. */
  async delete(id: string): Promise<boolean> {
    if (!DOCUMENT_ID_PATTERN.test(id)) return false;
    const { deletedCount } = await this.records.deleteOne({ _id: id });
    // Also what a failed ingest left behind: an original or an index without a record.
    await Promise.all((["txt", "idx", "bin"] as const).map((kind) => this.blobs.remove(this.key(id, kind))));
    return deletedCount > 0;
  }

  async sweep(now = new Date()): Promise<number> {
    const expired = await this.records.find({ expiresAt: { $lte: now } }, { projection: { _id: 1 } }).toArray();
    let removed = 0;
    for (const { _id } of expired) {
      // One that cannot be removed now waits for the next sweep, and does not stop this one.
      if (await this.delete(_id).catch(() => false)) removed++;
    }
    return removed;
  }
}
```

And the library over it:

```ts
// large-files.ts
import { MongoClient } from "mongodb";
import { createLargeFiles } from "llm-large-files";
import { BlobDocumentStore, type DocumentRecord } from "./blob-document-store.js";
import { blobs } from "./blobs.js"; // your Blobs over S3, Cloud Storage or a volume

const mongo = new MongoClient(process.env.MONGODB_URI!);
const records = mongo.db("chat").collection<DocumentRecord>("documents");

export const files = createLargeFiles({
  store: new BlobDocumentStore(blobs, records),
  keepOriginals: ["pdf"],
});
```

- Reads let their errors through: the library turns them into a `DocumentStoreError`. Writes turn
  theirs into an error with status 503 and a message of their own, so an upload that meets a database
  that is down is answered 503, not 422 with the driver's message.
- `delete` removes the record first. If removing an object fails after that, the document is gone
  and the object stays behind. A lifecycle rule on the bucket that removes objects under the prefix
  some time after `ttlMs` cleans those up, when `ttlMs` is finite.
- Index the collection on `expiresAt` for the sweep, and on `owner` to find a user's documents:
  `records.find({ owner: userId })` gives the IDs to pass to `files.delete(id, { owner: userId })`.
- A MongoDB TTL index on `expiresAt` (`expireAfterSeconds: 0`) removes the records without a sweep,
  but not the objects. It needs a lifecycle rule on the bucket as well.

### Checking your store

Before you trust a store with users' files, check these with the library over it:

- A file ingested, then `prepare` and a `search_document` call give the same results as with
  `MemoryDocumentStore`. Do it once more with `wholeDocumentBytes: 0`, which reads every document by
  range.
- With the database stopped, `files.getMeta(id)` rejects with a `DocumentStoreError` instead of
  giving undefined, and a tool call answers "The document store could not be read. Try again.",
  with a code in parentheses when your error has one.
- With a write that fails, `files.ingest` throws, and leaves no record and no object behind.
- `files.delete` removes every part. `getMeta` then gives undefined, and a second delete gives false.
- With a clock past `expiresAt` (the `now` option of `createLargeFiles`), `files.sweep()` removes
  the document, every part of it, and counts it.
- `readTextRange(id, size, size + 10)` gives an empty array, where `size` is `meta.textBytes`.
- With `keepOriginals`, `files.getOriginal` gives the uploaded bytes, byte for byte.

## The cache

Each library keeps documents ready in memory between tool calls. A document loaded whole is read
from the store once, however many tool calls use it. For a document read by range, it keeps the
line index and, for searches, decoded pieces of the text, and each read of lines asks the store for
just those lines.

| Option | Default | What it does |
|---|---|---|
| `cacheBytes` | `DEFAULT_CACHE_BYTES`: 256 MB | The most memory the kept documents may take, decoded pieces of large documents included. The least recently used go first. A document larger than this is read again for each call. `0` keeps none. |
| `cacheSize` | No cap | Also caps the number of documents kept. The pieces of a document read by range do not count. |
| `wholeDocumentBytes` | `DEFAULT_WHOLE_DOCUMENT_BYTES`: 2 MB | A document whose text is at most this many bytes is loaded whole. A larger one is read by range, when the store has `readTextRange`. `Infinity` loads every document whole; `0` reads every one by range. |
| `scanChunkBytes` | 1 MB | Reading by range: about this many bytes of text are read and searched at a time. |
| `maxConcurrentScans` | 4 | Reading by range: how many scans of whole documents (searches, counting the parts of a file) run at once in this library. The others wait their turn. |

- The cache never decides whether a document exists. Every use asks the store first (`getMeta`), so
  a document deleted or expired on another server is never served from memory here. A kept copy is
  used only while the store describes the same text (the same `createdAt`, size, characters and
  lines), so a store restored from a backup is read again.
- A document loaded whole takes, once searched, about twice its size in memory when its text is all
  ASCII, and four bytes a character otherwise: the text and a lowercased copy.
- A document read by range keeps its line index in memory, about 8 bytes a line, and, within
  `cacheBytes`, the decoded pieces of its text, so the next search reads nothing. A document whose
  decoded text would take more than a quarter of `cacheBytes` never has its pieces kept: one search
  of it would push everything else out.
- A document read by range is read whole only when the plan sends its whole text in the prompt.
- Searches of one document read by range that wait for a turn together share one pass over its
  text: it is read, decoded and lowercased once for all of them.

The cache belongs to a library, which is to say, in most applications, to a process. Memory per
server and what each server keeps for itself are in [Deployment](./deployment.md).

## Related pages

- [Web app](./web-app.md): upload routes, `getOwner`, and answers streamed to the browser.
- [Conversations](./conversations.md): storing a chat, its tool rounds, and its documents across
  questions.
- [Deployment](./deployment.md): several servers on one store, memory, the sweep, upgrades.
- [Errors and reliability](./errors-and-reliability.md): `DocumentStoreError`,
  `DocumentsNotFoundError`, and what to show the user.
- [PDFs](./pdfs.md): `view_pages` and scanned PDFs, which need kept originals.
- [Security](../security.md): ownership, retention and what the files on disk hold.
- [How it works](../how-it-works.md): the plan, the tools and how a document is read.
- [The library reference](../reference/library.md): `createLargeFiles`, `LargeFilesOptions`,
  `DocumentStore`, `MemoryDocumentStore`, `FileDocumentStore`, `DocumentStoreError`,
  `NEVER_EXPIRES` and the rest.
