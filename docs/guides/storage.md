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
| Metadata | `DocumentMeta`: owner, scope, file name, format, sizes, the SHA-256 of the upload (0.9.0), lines, outline, log profile, `createdAt`, `expiresAt`. | Always, last. |
| Text | The extracted text, normalized, as one string. | Always. |
| Line index | Where each line starts, in bytes and in characters: about 8 bytes a line. With it, a document read by range is opened without first reading all of its text. | When the store has `putIndex`. |
| Original | The uploaded file, byte for byte. | When `keepOriginals` lists the format and the store has `putOriginal`, unless the ingest gives `original`: then your application keeps the file, and the metadata says where ([Keeping the uploaded files](#keeping-the-uploaded-files)). |

The library makes the ID: `doc_` and 32 hexadecimal digits of a random UUID. It is new at every
ingest and never reused. `DOCUMENT_ID_PATTERN` (`/^doc_[a-f0-9]{32}$/`) matches it. Since 0.9.0 the
application may give the ID instead ([Application IDs](#application-ids)), of the shape
`APP_DOCUMENT_ID_PATTERN` (`/^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)[a-z0-9][a-z0-9_-]{0,63}$/`:
no name Windows keeps for a device), which the made IDs fit too.
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
- It copies the metadata it is given and the metadata it hands out, as a store that writes it
  somewhere does: changing the `meta` that `ingest` or `getMeta` returned (deleting its `owner`
  before you send it to a browser, say) changes nothing stored. Each call returns a new object.
  `getOriginal` returns a copy of the kept bytes too, since 0.9.0.
- `now` is its clock, `() => new Date()` by default. In a test, give the store and
  `createLargeFiles({ now })` the same clock: see [Testing](./testing.md).

### `FileDocumentStore`

`new FileDocumentStore(directory, options)` keeps each document as files on a volume. Without
`scopes`, they are all in `directory`, which it creates at the first write:

| File | Holds |
|---|---|
| `<id>.json` | The metadata, as JSON. The document exists while this file does. |
| `<id>.txt` | The text, as UTF-8. |
| `<id>.idx` | The line index: a 40-byte header, then 4 bytes for each line start in bytes and in characters, and for each passage and page start. About 6 MB for 730,000 lines. |
| `<id>.bin` | The uploaded file, with `keepOriginals`. |
| `<id>.<ext>.<8 hex digits>.tmp` | A file being written. It is renamed to its own name once complete. |

With `scopes` (new in 0.9.0), the files of each scope are in a folder of their own:
`<directory>/<userId>/<chatId>/.llm-large-files/<id>.json`. See
[Files in a folder per user or per chat](#files-in-a-folder-per-user-or-per-chat).

| Option | Default | What it does |
|---|---|---|
| `now` | `() => new Date()` | The store's clock: what has expired, and the default time of `sweep`. |
| `orphanAgeMs` | One hour | How old a file of no document must be before `sweep` removes it. |
| `scopes` | None | `{ depth, folder, createScopeFolders, unscoped }`: a folder per scope. New in 0.9.0. |
| `fileMode` | `0o600` | The mode of the files it writes, minus the umask. New in 0.9.0. |
| `directoryMode` | `0o700` | The mode of the folders it makes, minus the umask. New in 0.9.0. |
| `sweepConcurrency` | 16 | How many files `sweep` reads at once. New in 0.9.0. |

- Every file is written under a temporary name and then renamed, so no reader, on this server or
  another one, sees half a file. A rename or a removal that meets `EPERM`, `EACCES` or `EBUSY` (on
  Windows, another process has the file open for a moment) is tried again for about 2.6 seconds.
- `put` writes the text first and the metadata last. `delete` removes the metadata first, and
  nothing else when that fails: it throws, and the document stays whole. Once the metadata is
  gone, the document is gone: `delete` returns true, and a text, index or original it could not
  remove is left for `sweep` (new in 0.9.0: it threw). A document never appears without its text,
  and is never listed once its text is gone.
- File names are document IDs: the library's (`doc_` and 32 hex digits), or, since 0.9.0, an
  application's ([Application IDs](#application-ids)). `APP_DOCUMENT_ID_PATTERN` leaves out the
  names Windows keeps for devices (`con`, `nul`, `com1` and the like), since `con.json` is not a
  file there: `ingest` refuses them with a `TypeError`. A read or a `delete` with an ID that is not
  valid finds nothing, and `put`, `putIndex` and `putOriginal` throw "Invalid document ID." The
  library's IDs keep the names they had, so servers of 0.8 still read them.
- The names `<id>.json`, `<id>.txt`, `<id>.idx` and `<id>.bin`, and their temporary files, belong
  to the store for every ID it is given. Without `scopes`, `directory` is a folder where your files
  may sit too: an ingest under the ID `report` writes over your `report.txt`, and a `delete` or
  `ifExists: "replace"` removes it. Keep your own files in a subfolder, or under other names.
- A read does not follow a link at a file name (new in 0.9.0): a document file that is a link counts
  as missing. Windows cannot refuse such a link, so there it is followed.
- Files are written `0600` and folders made `0700` (new in 0.9.0: before, `0666` and `0777`, minus
  the umask, which gave `0664` and `0775` under the usual `0002`). Only the user the server runs as
  reads them. Servers or a backup job that run as other users of one group (a Kubernetes `fsGroup`)
  need `fileMode: 0o640` and `directoryMode: 0o750`. Files written before keep their modes.
- A missing file means a missing document. Any other failure of a read (a volume that does not
  answer, too many open files) is thrown, and the library passes it on as a `DocumentStoreError`.
  There are two exceptions: an index file that cannot be read is built again from the text, and
  `sweep` counts a folder it cannot list as empty. A failed write or delete is thrown as it came,
  and the library wraps it ([Errors](#errors)). Metadata that cannot be parsed counts as absent.
- `getMeta` removes a document that has expired, by the store's own clock (`now`), and returns
  undefined. Since 0.9.0 it does so also when the removal fails: the next `sweep` tries again.
- `readTextRange` reads only the bytes asked for, so a tool call never loads a large file whole.
  The whole text is read only when the plan sends it in the prompt.
- `sweep` removes expired documents and returns how many: those whose metadata it removed itself,
  so two sweeps at once count each document once. It also removes files that belong to no
  document (an upload that failed, a server that stopped while writing) and temporary files, once
  they are `orphanAgeMs` old, one hour by default: a younger one may be an upload in progress on
  another server. In a folder that may hold files of yours too (`directory` without `scopes`), it
  removes such a file only when its name is an ID the library makes, or a temporary file:
  `notes.txt` may be yours, not the text of a document `notes`. A document whose metadata could not
  be read at all is left alone, whatever its age. One that cannot be removed is left for the next
  sweep, and does not stop this one.
- `sweep` reads up to `sweepConcurrency` files at once (new in 0.9.0: one after another). A sweep
  of 5,000 documents in one folder on a local SSD took about 2.5 s one file at a time, and about
  1.1 s 16 at a time.
- The files are plain. The metadata names the owner, the scope, the file name, the headings and the
  log message templates. A delete removes the files without overwriting them. If that matters,
  encrypt the volume: see [Security](../security.md).

Several servers can share the directory on a network volume. What that needs, from where to run the
sweep to servers of two versions during an upgrade, is in [Deployment](./deployment.md).

## Owners and scopes

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

| Call | Takes the owner (and the scope) as | A document of another owner or scope |
|---|---|---|
| `files.ingest(input)` | `input.owner`, `input.scope` | |
| `files.getMeta(id, access)` | `access.owner`, `access.scope` | `undefined` |
| `files.getOriginal(id, access)` | `access.owner`, `access.scope` | `undefined` |
| `files.delete(id, access)` | `access.owner`, `access.scope` | `false`, and nothing is removed |
| `files.prepare(ids, base, options)` | `options.owner`, `options.scope` | Listed in `missing`, and never read |
| `files.tools(documents, options)` | `options.access` (new in 0.9.0); without it, the `owner` and `scope` of each `DocumentMeta` in `documents` (and in `viewPages`) | Each call that reads it answers `doc_… is no longer available on the server. Ask the user to attach the file again.` |
| `askWithFiles(options)`, `askStream(options)`, `askGemini(options)` | `options.owner`, `options.scope` | `DocumentsNotFoundError`, before any model request |
| `createDocumentHandlers(files, options)` | `options.getOwner(request)` | 404 "This file is no longer available." on GET; `{ "deleted": false }` on DELETE |

- An owner is a string that is not empty or only spaces. `ingest` throws a `TypeError` for `""`,
  for spaces only and for `null`, which would make one owner shared by every caller without a
  user: each could read and delete the documents of the others whose IDs it has. `user?.id ?? ""`
  gives `""` to a caller who is not signed in. The message is
  `owner must be a string that is not empty or only spaces, such as the signed-in user's ID. To let anyone with the document's ID use it, leave owner out.`
  It throws the same for an owner from JavaScript that is neither a string nor a finite number,
  such as the user object in place of its ID. A number is accepted, as before. Reads with
  `owner: ""` work as before, so documents that 0.5.0 stored with that owner stay readable until
  they expire (not under `requireOwner`, which refuses `""` on every call).
- In `createDocumentHandlers`, a `getOwner` that returns such an owner is the server's mistake: the
  upload is answered 500 `{ "error": "Upload failed (empty owner)." }` for `""`, spaces only or
  `null`, and `{ "error": "Upload failed (owner is not a string)." }` for an object, a boolean,
  `NaN` or an array, before its body is read. Nothing is logged. Where every upload needs a
  signed-in user, throw an error with `status: 401` from `getOwner`; return `undefined` only where
  anonymous uploads are meant (`user?.id || undefined`); and return the user's ID, not the user.
  Under `requireOwner`, `undefined` and `null` are a request that is not signed in: `401`
  `{ "error": "Sign in first." }` on every route, and `""` or spaces only a `500` "(empty owner)" on
  every route (new in 0.9.0).
- A document of another owner looks exactly like one that does not exist, so a caller cannot learn
  that an ID is in use. There is one exception: `ingest` with an
  [application's ID](#application-ids) answers 409 when the ID is taken, whoever has it.
- The comparison is exact (`===`): `"alice"` does not reach a document of `"Alice"` or of
  `"alice/chat-1"`. There is no hierarchy and no wildcard.
- A document ingested without an owner can be used by anyone who has its ID, whether they pass an
  owner or not. With signed-in users, always pass one, and turn on
  [`requireOwner`](#requiring-an-owner-and-a-scope). In `createDocumentHandlers`, a `getOwner` that
  returns undefined makes an anonymous upload. To refuse a request without a user, throw from it with
  a status ([Web app](./web-app.md)).
- An owner of `null` from your store (a MongoDB driver writes a field that was left out as `null`)
  counts as no owner, new in 0.9.0. Before, `getMeta` read such a document as missing for every
  owner, and the tools as open to all.
- The owner cannot be changed after ingest. Use a stable, opaque ID, not an email address that may
  change.
- `files.tools(documents, { access })` asks the store for each document with the owner and scope of
  `access`, and checks the ones the store holds against them, as `getMeta` does. `askWithFiles`
  passes it. Without `access`, as before 0.9.0, `tools` compares the owner and scope stored with
  each document with those of the metadata it is given, and answers a mismatch as a document that
  is gone. In a loop of your own, pass `access`
  ([Your own adapter and loop](./own-adapter-and-loop.md)).

### Scopes

A scope says where a document belongs, from the widest part to the narrowest: `[userId, chatId]`.
It is new in 0.9.0. Pass it at ingest and on every later call, as the owner:

```ts
// `files` and `bytes` as above.
const scope = ["user-42", "chat-7"];
const notes = await files.ingest({ name: "notes.txt", bytes, owner: "user-42", scope });

await files.getMeta(notes.id, { owner: "user-42", scope });                  // the metadata
await files.getMeta(notes.id, { owner: "user-42", scope: ["user-42", "chat-8"] }); // undefined
await files.getMeta(notes.id, { owner: "user-42" });                         // undefined
```

- The library keeps the scope in `meta.scope`, a copy, and passes it to every store call in the
  [context](#writing-a-store-of-your-own). It never reaches the model, a summary or an event.
- A document with a scope serves only a caller of the same scope, segment by segment: another
  scope, a longer or a shorter one, or none, finds it missing. A document without a scope serves a
  caller of any scope, unless the library has `requireScope`.
- A store may keep the documents of each scope apart: `MemoryDocumentStore` does, and
  `FileDocumentStore` with [`scopes`](#files-in-a-folder-per-user-or-per-chat), so one ID in two
  scopes is two documents. A store that ignores the context, as every store written for 0.8 does,
  still keeps scopes apart for the library, through `meta.scope`: a caller of scope B never reads a
  document of scope A.
- What the library keeps in memory is kept by scope too: a cached copy of a document of one scope
  is never served to a caller of another, even when both documents have the same ID. Nor to another
  owner: the copy is checked against the owner of the document the store holds now.
- A scope has 1 to 8 segments of 1 to 256 characters, with no control character, no `/` or `\`, and
  none of them `.` or `..`. Another is a `DocumentScopeError` of code `"scope_invalid"`, whose
  message never repeats a segment. `null` counts as no scope.
- Segments are compared exactly: `"Chat-7"` is not `"chat-7"`.

The owner says who may use a document. The scope says where it belongs. With both, one user's two
chats cannot use each other's files, and a store can lay the files of each chat out apart.

### Requiring an owner and a scope

New in 0.9.0. On a server where every document belongs to a signed-in user, turn both on:

```ts
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";

export const strict = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: true, requireScope: true });
```

- Every call must then name its owner and its scope: `ingest`, `getMeta`, `getOriginal`, `delete`,
  `prepare`, `askWithFiles`, `askStream`, `askGemini`, and `tools`, which needs `access`. A call
  without one throws `TypeError("owner is required: requireOwner is on")` or
  `TypeError("scope is required: requireScope is on")`, before the store is asked anything. A
  forgotten owner fails loudly, instead of reaching every document stored without one.
- A document stored without an owner, or without a scope, then reads as missing, for every caller.
- `files.sweep()` needs no scope: it is upkeep of the store, not a user's access.
- `files.access` says which are on, for code that serves the library (the upload handlers).

### Application IDs

New in 0.9.0. Give `ingest` the document's ID, such as the ID of the upload in your database:

```ts
// `strict` and `bytes` as above; "upload-3f9a" is the ID of the upload in your own records.
const report = await strict.ingest({ name: "report.txt", bytes, owner: "user-42", scope: ["user-42", "chat-7"], id: "upload-3f9a" });
```

- The ID must match `APP_DOCUMENT_ID_PATTERN`: lowercase letters, digits, `_` and `-`, up to 64
  characters, starting with a letter or a digit. Another is a `TypeError`. Without an `id`, the
  library makes one, as before.
- The model sees the ID, in the cards and the tool calls. It must hold no personal data: not an
  email address, not a name.
- `ifExists: "fail"`, the default, refuses an ID that is taken with an `IngestError` of code
  `"exists"` (status 409), before the file is read. `ifExists: "replace"` deletes the document there,
  then stores the new one, but only one of the same owner and scope. A document of another owner or
  scope is `"exists"` too, even when its text seems to be gone: a store that loses the context of a
  read would say that of a document that is there. A document that has expired is written over in
  both cases.
- The store is asked "is this ID taken?" in the scope of the ingest. Over a store that ignores the
  context, the question spans every scope: one chat cannot write over another chat's document, and
  the IDs must be unique in the whole store.
- In one library, one ID is stored by one ingest at a time. While an ingest of an ID is under way,
  from its first look at the store to the end of its writes, another ingest of that ID is
  `"exists"`, whatever its `ifExists`, owner or scope. A user who uploads the same file twice at once
  gets a 409 for the second.
- When the writes (or the clean-up after a write that failed) do not end within `ingestTimeoutMs`,
  the ingest throws, but its writes may still land. So the ID stays held in that library until they have ended, and the removal of what they
  wrote too. This fails closed: a store that never answers keeps that one ID refused in that library
  until the process restarts.
- Across servers, the store is asked twice: before the file is read, and just before the writes.
  Two servers can still both find an ID free and write it at the same moment. The library assumes
  that two ingests of one ID on two servers at once are the same upload, sent twice: the last write
  wins. So give each upload an ID of its own.
- When a write fails, the ingest removes what it wrote, but only while the document under the ID is
  its own. A document whose metadata it finds there, and that is not its own, is left. If that one
  has not expired and is of another owner or scope (another server stored it meanwhile), the ingest
  throws `"exists"`. Otherwise, as when the delete of the document a replace was to remove fails, it
  throws the store's error (503), as for any failed write.
- The clean-up sees only metadata. The parts of a document that another server is still writing at
  that moment (its original, its index) may be removed. One more reason to give each upload an ID of
  its own.
- A 409 tells the caller that the ID is taken, whoever has it: over a store that ignores the
  context, in any scope. So an ID that can be guessed can be probed. Use random IDs, as
  [`attach()` below](#a-layout-per-user-and-per-chat) does
  (`` `up-${randomUUID().replaceAll("-", "")}` ``), or IDs that start with the tenant's own prefix.
- Replacing a document is not atomic for readers on other servers: for a moment it is missing.
- An ID you choose keeps the stored rounds of a conversation valid: a file ingested again under the
  same ID is found by the `toolTurns` that name it ([Conversations](./conversations.md)).

### Choosing the owner and the scope

The owner and the scope are strings you choose. The library cannot list documents by owner or by
scope. A good fit for a chat application:

| Field | Value | What the library enforces |
|---|---|---|
| `owner` | `userId` | No user can use another user's documents. |
| `scope` | `[userId, chatId]` | A document can be used only in the chat it was uploaded to. A file used in two chats is uploaded twice. |
| `id` | the upload's ID | The ID your session record keeps is the document's ID. |

Build the same owner and scope for every call: upload, questions, GET, DELETE. Before 0.9.0, an
owner of `` `${userId}/${sessionId}` `` did the work of the scope. It still works, but a store
cannot lay files out by it, and the owner is no longer one user.

### A layout per user and per chat

With chats kept as MongoDB records, as in [Conversations](./conversations.md)
(`{ _id, userId, documentIds }`, and one record per question in `turns`), the session record is the
list of a chat's documents:

```ts
// chat-documents.ts. `files` is your library; `sessions` and `turns` are the collections of the
// Conversations guide.
import { randomUUID } from "node:crypto";
import { toDocumentSummary, type DocumentSummary } from "llm-large-files";

/** Adds a file to a chat. The user owns it, the chat is its scope, and the session record lists it. */
export async function attach(userId: string, sessionId: string, file: { name: string; mimeType?: string; bytes: Uint8Array }): Promise<DocumentSummary> {
  if (!await sessions.findOne({ _id: sessionId, userId })) throw new Error("No such chat.");
  const scope = [userId, sessionId];
  // The document's ID is yours: here a new one, as the ID of an upload record would be.
  const meta = await files.ingest({ ...file, owner: userId, scope, id: `up-${randomUUID().replaceAll("-", "")}` });
  try {
    await sessions.updateOne({ _id: sessionId, userId }, { $addToSet: { documentIds: meta.id } });
  } catch (error) {
    // A document that no chat lists would stay until it expires.
    await files.delete(meta.id, { owner: userId, scope }).catch(() => undefined);
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
  for (const id of session.documentIds) await files.delete(id, { owner: userId, scope: [userId, sessionId] });
  await turns.deleteMany({ sessionId });
  await sessions.deleteOne({ _id: sessionId, userId });
}
```

- Ask with `owner: userId`, `scope: [userId, sessionId]` and
  `documentIds: await documentsFor(userId, sessionId)`. When documents have expired, the question
  throws `DocumentsNotFoundError` with their IDs, or, with `onMissingDocuments: "drop"` (new in
  0.9.0), is answered without them and lists them in `result.missing`:
  [Conversations](./conversations.md#documents-that-are-gone) shows how to take them off the chat
  and ask the user for them again.
- `files.delete` gives false for a document that has already expired or been deleted. There is
  nothing left to do for it.
- Over a `FileDocumentStore` with `scopes`, `deleteChat` can remove the chat's folder in place of
  each document ([below](#files-in-a-folder-per-user-or-per-chat)).
- The `upload` handler of `createDocumentHandlers` answers the request itself. Since 0.9.0 its
  hooks do what `attach` does: `prepareUpload` gives the upload its ID (and can save the body in the
  chat's folder), and `onUploaded` records the ID in your session, or fails the upload
  ([Web app](./web-app.md#save-each-upload-where-you-keep-it-prepareupload)). Otherwise call
  `attach` from a route of your own.
- To delete everything of a user (an account that is closed), collect the IDs from the user's chats.
  The library cannot find a user's documents. A store of your own can, if it keeps the owner where it
  can query it, as the [example store](#example-object-storage-and-a-database) does: the context of
  every call gives it the owner and the scope.

### Files in a folder per user or per chat

New in 0.9.0. Give `FileDocumentStore` the `scopes` option, and one library serves every user and
every chat, with each chat's files in a folder of its own:

```ts
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createLargeFiles, FileDocumentStore, isSafeScopeSegment, toDocumentSummary } from "llm-large-files";

const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR!;

// One store and one library for the process: their limits hold for every chat at once.
export const store = new FileDocumentStore(DOCUMENTS_DIR, { scopes: { depth: 2 } });
export const files = createLargeFiles({ store, requireOwner: true, requireScope: true });

/**
 * Makes the folder of a chat. Call it once, when you create the chat's record, not on each upload:
 * an upload after you removed the folder must fail, not make it again.
 */
export async function startChat(userId: string, chatId: string) {
  // Check the IDs before they become a path. For IDs that do not pass, use hashedScopeSegment.
  if (!isSafeScopeSegment(userId) || !isSafeScopeSegment(chatId)) throw new TypeError("The user or chat ID cannot name a folder.");
  await mkdir(path.join(DOCUMENTS_DIR, userId, chatId), { recursive: true, mode: 0o700 });
}

/** Adds a file to a chat. `uploadId` is the ID of the upload in your records: lowercase, as UUIDs are. */
export async function upload(userId: string, chatId: string, uploadId: string, file: { name: string; bytes: Uint8Array }) {
  // The store makes only its own folder in the chat's. A chat whose folder is gone: "scope_missing".
  const meta = await files.ingest({ ...file, owner: userId, scope: [userId, chatId], id: uploadId });
  return toDocumentSummary(meta);
}
```

The volume then holds:

```text
<DOCUMENTS_DIR>/
  user-42/
    chat-7/
      .llm-large-files/     the store's: upload-3f9a.json, upload-3f9a.txt, upload-3f9a.idx
      uploads/              yours, if you keep the uploads: the sweep never goes in, and fileOriginals reads them
```

- Pass the same `scope` on every later call: questions (`askWithFiles({ owner, scope })`),
  `getMeta`, `getOriginal`, `delete`. A document of one chat is not found from another, even under
  the same ID: the folder is the boundary, and the library checks `meta.scope` too.
- `depth` is the number of segments of every scope: 2 for `[userId, chatId]`. A scope of another
  length, or a call without one, throws a `DocumentScopeError` (`"scope_invalid"`,
  `"scope_required"`).
- Each segment names a folder, so it must pass `isSafeScopeSegment`: lowercase letters, digits,
  `_` and `-`, up to 64 characters, and no name Windows keeps for a device (`con`, `nul`). Lower
  case only, because SMB and Azure Files ignore case: `Alice` and `alice` would share a folder. IDs
  your database makes (UUIDs, MongoDB ObjectIds in lowercase hex) pass as they are. For IDs in mixed
  case, or in Hebrew, pass `hashedScopeSegment(userId)` as the segment, everywhere: it gives `h` and
  40 hex digits of the ID's SHA-256. Name the folders you make and remove with it too.
- The store makes its own folder (`.llm-large-files`, the `folder` option) inside a chat's folder
  that exists, and never the chat's folder itself. To delete a chat, stop its questions, then remove
  its folder: `rm(path.join(DOCUMENTS_DIR, userId, chatId), { recursive: true, force: true })`. An
  upload that finishes after that throws a `DocumentScopeError` of code `"scope_missing"`, instead
  of making the folder again. Reads in that chat find nothing. To delete a user, remove the user's
  folder.
- `createScopeFolders: true` makes the folders of a chat at its first upload, for an application
  that keeps none of its own. The removal above then cannot stop a late upload. It makes them one
  level at a time, and makes nothing where a link points.
- `folder: ""` puts the store's files in the chat's folder itself, beside yours. The names
  `<id>.json`, `.txt`, `.idx` and `.bin`, and their temporary files, then belong to the store for
  every ID it is given: an ingest under the ID `report` writes over your `report.txt`. Keep your own
  files in a subfolder, such as `uploads/`, or under other names.
- `files.sweep()` sweeps every chat: it goes down exactly `depth` levels of folders, into folders
  whose names a segment may have, and never follows a link. `files.sweep({ scope })` sweeps one
  chat's folder. Run it from one server ([Deployment](./deployment.md#sweeping-expired-documents)).
- A folder of a scope that is a link, or lies under one, is refused with `"scope_invalid"`: a call
  checks that the folder is where its path says, inside `DOCUMENTS_DIR`. Writes, deletes and sweeps
  check every time. A read takes a folder checked less than a second ago as checked, so a link put
  in place of a chat's folder is seen by reads within a second. A link at a file name is not
  followed either, except on Windows.
- That check costs one `realpath` of the chat's folder, a look at each folder on its path. Reads
  share it for a second, so a search that reads a large document by range checks once a second,
  not once a read. On a local SSD, 10,000 ranged reads in a chat's folder took 0 to 17% longer than
  in the flat layout; when each read checked, they took 40 to 60% longer. On a network volume each
  of those looks can be a round trip.
- Documents ingested before 0.9.0 are in `DOCUMENTS_DIR` itself. `unscoped: "root"` serves a call
  without a scope from there, as before, until they expire, and `files.sweep()` sweeps them too.
  It cannot go with `requireScope`, which refuses such calls first.
- A wrapper or a subclass of the store must pass the context on (`super.getMeta(id, context)`):
  without it, every call throws `"scope_required"`.
- Servers of 0.8 do not see these folders, nor documents under an application's ID: during an
  upgrade they find them missing ([Deployment](./deployment.md#servers-of-two-versions)).

One library for the process keeps its limits for the whole process: `maxConcurrentIngests` and its
queue, `cacheBytes` and `maxConcurrentScans` bound every chat together, and a document read in one
question stays in the cache for the next.

#### A library per chat

Before 0.9.0, the only way to a folder per chat was a library per chat, each over its own
`FileDocumentStore`. It still works:

```ts
import path from "node:path";
import { createLargeFiles, FileDocumentStore, isSafeScopeSegment, type LargeFiles } from "llm-large-files";

/** The library of one chat: its files are in <DOCUMENTS_DIR>/<user>/<chat>/. */
export function filesOf(userId: string, sessionId: string): LargeFiles {
  // The IDs become a path: refuse anything that could lead out of the directory.
  if (!isSafeScopeSegment(userId) || !isSafeScopeSegment(sessionId)) throw new Error("Invalid user or chat ID.");
  return createLargeFiles({
    store: new FileDocumentStore(path.join(process.env.DOCUMENTS_DIR!, userId, sessionId)),
    cacheBytes: 32 * 1024 * 1024, // each library has a cache of its own
  });
}
```

What that costs, against one library over a store with `scopes`:

- `cacheBytes`, `maxConcurrentScans` and `maxConcurrentIngests` bound each library, not the process,
  and `maxPendingUploadBytes` each set of upload handlers. Ingests of different chats all work at
  once, as before 0.8.2: bound them for the process yourself, with one queue or count shared by the
  chats' routes. A library made for one request starts with an empty cache, so each question reads
  its documents from the store again.
- Each chat's folder needs a sweep of its own: `new FileDocumentStore(folder).sweep()` for each one.
- The store makes the chat's folder again at a late upload, after you removed it.
- The store's files sit in the chat's folder itself, so its sweep leaves files of no document there
  unless their names are the library's own IDs.

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
`DocumentsNotFoundError`, unless it is asked with `onMissingDocuments` (new in 0.9.0): `"drop"`
answers without them, and a function can ingest them again from the uploads you kept
([missing documents](../reference/ask.md#missing-documents)). To keep documents as long as their chat:

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

By default only the text of a document is kept. `keepOriginals` keeps the uploaded file too, for
the formats it lists, so that `view_pages` can show the model the pages of a PDF, and a scanned PDF
can be accepted ([PDFs](./pdfs.md)). The file is kept in one of two places:

- **A copy in the store**, next to the text (`putOriginal`).
- **Where your application keeps it**, new in 0.9.0: the ingest gives `original: { ref }`, and the
  library reads the file from there through `originals`. The store keeps no second copy.

| Option | Default | What it does |
|---|---|---|
| `keepOriginals` | `[]` | Formats whose uploaded file is kept, for example `["pdf"]`. |
| `originals` | none | Reads the files your application keeps, by their ref: `fileOriginals(root)` of `llm-large-files/node`, or your own `{ read(ref, context) }`. New in 0.9.0. |

Either way, `meta.originalKept` is true, `files.getOriginal(id, { owner, scope })` returns the
file under the same owner and scope rules as everything else, and `view_pages` reads it. Treat the
bytes as read-only: they may be the store's own copy.

### A copy in the store

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
- The store needs `putOriginal` to keep a file and `getOriginal` to give it back. The built-in stores
  have both. A store without `putOriginal` keeps no copy, whatever `keepOriginals` says.
- The bytes are checked when they are read back. Since 0.9.0, `getOriginal` and `view_pages` ask
  the store for the metadata again once the file is read, and the file is missing unless the
  document is still the same one, of the same owner and scope, and the file is that of the upload:
  of its size (`meta.bytes`) and, for documents of 0.9.0 and later, of its SHA-256 (`meta.sha256`).
  Another server may have deleted the document and stored another under its ID meanwhile, and a
  store may give back another file of the same size.
- Documents ingested before you turned it on have no original. Upload them again to get one.

### The file your application keeps

New in 0.9.0. When your application saves each upload anyway (to send it back, or to ingest it
again later), keep only that one. The ingest says where it is, and the library reads it from there.
With `createDocumentHandlers`, `prepareUpload` saves the body there and gives the ref
([Web app](./web-app.md#save-each-upload-where-you-keep-it-prepareupload)); a route of your own
saves it, then calls `ingest`:

```ts
import path from "node:path";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { fileOriginals } from "llm-large-files/node";

const VOLUME = process.env.DOCUMENTS_DIR!;

export const files = createLargeFiles({
  store: new FileDocumentStore(VOLUME, { scopes: { depth: 2 } }),
  keepOriginals: ["pdf"],
  originals: fileOriginals(VOLUME),
  requireOwner: true,
  requireScope: true,
});

/** Ingests an upload your route saved at <VOLUME>/<user>/<chat>/uploads/<uploadId>. */
export function ingestSaved(userId: string, chatId: string, uploadId: string, name: string) {
  const ref = `${userId}/${chatId}/uploads/${uploadId}`;
  return files.ingest({
    name,
    source: { path: path.join(VOLUME, ref) }, // read at its turn, not held while it waits
    original: { ref },
    owner: userId,
    scope: [userId, chatId],
    id: uploadId,
  });
}
```

- **The ref** is a string of 1 to 1,024 characters that your reader understands: for
  `fileOriginals(root)`, a path relative to `root`. It is never sent to the model, nor in a summary
  or an event. An ingest with `original` in a library without `originals` throws a `TypeError`. A
  format that `keepOriginals` does not list records nothing, whatever the ref.
- **What is recorded.** `meta.original` is `{ ref, bytes, sha256 }`: the ref, and the size and
  SHA-256 of the file at ingest. `meta.originalKept` is true, as for a copy. The store's
  `putOriginal` is not called.
- **Each read is checked.** `getOriginal` and `view_pages` read the ref the store holds (never one
  from metadata handed in), ask the store for the metadata again, then compare the file with the
  size and SHA-256 recorded. A file that has changed gives `undefined` from `getOriginal`, and
  `view_pages` tells the model: "report.pdf changed on the server since it was read. Attach it
  again to look at its pages." A file that is gone reads as missing.
- **The library never writes, moves or deletes it.** `files.delete` and the sweep leave it. Remove
  it with its chat: over a scoped store, `rm` of the chat's folder removes the store's files and
  your uploads together.
- **`fileOriginals(root)`** resolves a ref under `root`, and refuses one that leads out of it with a
  `TypeError`, which the library passes on as a `DocumentStoreError`. A link at any level below
  `root` reads as missing. It reads a file once, at most one byte past the size recorded, and never
  writes ([`fileOriginals`](../reference/node.md#fileoriginalsroot)).
- **A reader of your own** is an object with `read(ref, context)`, which returns the bytes, or
  `undefined` when the file is not there: a bucket key, a database ID. `context` has the scope and
  owner of the call, the document's `id`, and `bytes`, the size recorded; a reader may stop one
  byte past it. What it throws becomes a `DocumentStoreError` (operation `"read"`) with its error as
  `cause` ([`OriginalsReader`](../reference/library.md#originalsreader)).
- **The same file twice.** Every document of 0.9.0 has `meta.sha256`, the SHA-256 of the upload,
  for bytes and for paths. The library does not look for another document of the same file: to
  give a user the document of a file already in the chat, compare it with the `sha256` your
  session record keeps for the chat's documents. Never across owners.

## Writing a store of your own

A store of your own implements `DocumentStore`: four methods are required, six are optional. The
library calls them. Your application calls them only to test the store, or to sweep a store that no
library uses.

Every method takes a last, optional `context`, new in 0.9.0: the scope and the owner of the call
([`DocumentContext`](../reference/library.md#documentcontext)), as in `getMeta(id, context?)`. The
table below leaves it out. A store written for 0.8, without it, still compiles and works, unless
a method takes a parameter of its own in its place
([Does my code compile?](../upgrading-0.9.md#does-my-code-compile)).

- Use `context.scope` as the boundary of your storage, if you want one: a key prefix, a folder, a
  filter on a collection. `context.owner` lets you index documents by user. A store that ignores
  the context still keeps scopes apart for the library, through `meta.scope`; an application's IDs
  must then be unique in the whole store.
- A store that wraps another one, or a subclass that overrides a method, passes the context on.
  One that drops it loses the scope of every call: over a store that keeps scopes apart, such a
  call does not find the documents stored in a scope. Over a `FileDocumentStore` with `scopes`,
  every call but `sweep` throws; with `unscoped: "root"`, the documents go to the root folder,
  outside the chat's folder, without an error. A `sweep` that drops it sweeps every scope.

```ts
import { FileDocumentStore, type DocumentContext, type DocumentMeta } from "llm-large-files";

/** Counts the reads of metadata, and passes the context on, as every method of a wrapper must. */
export class CountingStore extends FileDocumentStore {
  reads = 0;

  override async getMeta(id: string, context?: DocumentContext): Promise<DocumentMeta | undefined> {
    this.reads++;
    return super.getMeta(id, context); // not super.getMeta(id)
  }
}
```

Which context a call carries:

- At ingest, every write and every look-up carries the owner and the scope of the new document.
- `getMeta`, `getOriginal` and `delete` carry those of the caller.
- The reads of a document's text carry the caller's scope and the document's owner: `get`,
  `readTextRange`, `getIndex`, and `putIndex` when an index is built again. The library reads them
  only once `getMeta` has found, in the caller's scope, a document the caller may use. So the scope
  is where the document was found, even when its metadata has none (a document of 0.8 that you moved
  into a scope). The owner is left out when the document has none, whoever asked. The library keeps
  one copy of a document for all callers of a scope: its reads carry one context whoever made them.
  A store that logs who reads should log the caller from `getMeta`.
- A wrapper or a cache in front of a store must never keep what `readTextRange` or `getIndex` gave
  by ID alone: key it by the context too. Bytes read by range carry nothing that the library can
  check them by (see [Reading by range](#reading-by-range)).
- A store keeps at most one document of an ID in a scope. It may keep the scopes apart; it must not
  keep a document of one ID for each owner in one scope.

### The methods

| Method | Required | When the library calls it | What it must do |
|---|---|---|---|
| `put(document)` | Yes | `ingest`, last, after `putOriginal` and `putIndex`. | Keep `document.meta` whole, as one object, and `document.text`. Keep the text exactly, as UTF-8: `readTextRange` offsets point into those bytes. Let the document appear only once all of it is written. |
| `getMeta(id)` | Yes | Before every use of a document: `getMeta`, `getOriginal`, `delete`, `prepare` (once a document), and every tool call that reads one. Once more after a document is read by range, or its original file is read. | Return the metadata, or undefined when there is no such document. Keep it cheap: one look-up by key, without reading the text. Return a field that was left out (`owner`, `scope`) absent, not `null`. |
| `get(id)` | Yes | To load a document whole: one whose text is at most `wholeDocumentBytes`, or any document when the store has no `readTextRange`. Once a library while the document stays in the cache. | Return `{ meta, text }` with the text exactly as `put` got it, or undefined. |
| `delete(id)` | Yes | `files.delete`, after the owner check. And `ingest`: to clean up after a write that failed, or a listener that threw on `ingest.finish`, only while the document under the ID is that ingest's own; and with `ifExists: "replace"`, to remove the document it replaces. | Remove the metadata first, then the text, the index and the original. When the metadata cannot be removed, throw, and leave the rest. Return true when the document was there. Cope with a document that was only partly written. |
| `sweep(now?)` | No | `files.sweep()`, with the library's clock. | Remove the documents whose `expiresAt` is at or before `now`, with all their parts. Return how many. |
| `putOriginal(id, bytes)` | No | `ingest`, first, when `keepOriginals` lists the format. | Keep the bytes as they are now: the caller may reuse its buffer afterwards. |
| `getOriginal(id)` | No | `files.getOriginal` and `view_pages`, for a document whose `meta.originalKept` is true. | Return the bytes, or undefined. |
| `readTextRange(id, start, end)` | No | To read a document larger than `wholeDocumentBytes`, and to build its index. Only after `getMeta` found the document. | Return the bytes of the text from `start` (inclusive) to `end` (exclusive). See [Reading by range](#reading-by-range). |
| `putIndex(id, index)` | No | `ingest`, after `putOriginal` and before `put`, for every document. Again when a document read by range has no index, or one that does not match its text. | Keep the bytes. |
| `getIndex(id)` | No | When a document read by range is opened. | Return the bytes `putIndex` kept, or undefined. A damaged index is noticed and built again. |

The library checks `expiresAt` itself, with its own clock, before every use. Your `getMeta` and
`get` may return a document that has expired; your `sweep` must remove it. If they remove an expired
document when they meet one, as the built-in stores do, they return undefined even when the removal
fails: an error there reaches the user as "try again" for a document that is gone, on every try.

Keep every field of `meta`, including those your store does not know. Later versions add optional
fields: 0.4.1 added `jsonBytes`, 0.6.0 `encoding` and `replacedCharacters`, which say how a
text file that was not valid UTF-8 was read ([PDFs and other formats](./pdfs.md#text-encodings)),
and 0.9.0 `metaVersion`, on every document it ingests
([`DOCUMENT_META_VERSION`](../reference/library.md#document_meta_version)).
A store that checks `meta` against a fixed list of fields (a `$jsonSchema` with
`additionalProperties: false`, a Mongoose schema in strict mode that throws) refuses the ingest of
every file that has them: a text file not in UTF-8, a UTF-8 log cut at a byte count, an ASCII log
with a stray byte. `createDocumentHandlers` then answers 503 "The document could not be stored. Try
again." (a 500 "Upload failed." before 0.9.0), and a retry fails the same way. A store that keeps
fixed columns and drops the others keeps the text, read right, but the model is no longer told how
the file was read. [The example below](#example-object-storage-and-a-database) stores `meta` whole.

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
  again. When the index built again has another number of lines or characters than the metadata
  says, the text is not the one that was ingested, and the document reads as missing (new in 0.9.0;
  before, that text was read).
- Return fewer bytes at the end of the text, and an empty array when `start` is at or past its end.
  That happens: the index is built by reading 4 MB at a time until a read comes back short, so a
  text whose size is a multiple of 4 MB ends with a read that starts at its end.
- Return undefined when the document is gone. The call then answers "doc_… is no longer available on
  the server. Ask the user to attach the file again."
- The bytes carry nothing to check them by: the library cannot tell them from the text of another
  document laid out the same way. So, since 0.9.0, once a tool call or `prepare` has read a document
  by range, the library asks `getMeta` once more (one call, however many ranges were read). The read
  is missing unless the store still describes the same document, of the same owner and scope. That
  catches a document deleted, and another stored under its ID, while it was read. It cannot catch a
  store whose `readTextRange` or `getIndex` answers from another document while its `getMeta` is
  right, such as a cache keyed by ID alone. Key any cache of those reads by the context too.

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
  the code in parentheses only when your error has a `code` that reads as one (capitals, digits and
  `_`, as `EIO`): a host a driver put in `code` is left out. Its `code` and `syscall` are
  those of your error, when they are strings, as a Node system error has them. Its `cause` is your
  error: log that one. The message names no path or host, so it can be shown to a user or a model.
  `prepare`, `askWithFiles` and `files.getMeta` throw it; a tool call answers the model with its
  message, and the model can try again. A `DocumentStoreError` you throw yourself
  (`new DocumentStoreError(cause)`, which takes only the cause) is passed on as it is; you never need
  to. What to show the user is in [Errors and reliability](./errors-and-reliability.md).
- **`getIndex`**: an error is not passed on. The index is built from the text instead.
- **Writes at ingest** (`putOriginal`, `putIndex`, `put`): the library calls `delete(id)` to remove
  what was written, ignores any error of that, and throws a `DocumentStoreError` of operation
  `"write"`, whose `cause` is your error (new in 0.9.0: it threw your error as it came). Its message
  is "The document could not be stored (EIO). Try again.", with the code only when your error has a
  string `code`, and its status 503. A write that does not end within `ingestTimeoutMs` is one of
  code `"ETIMEDOUT"`. The `upload` handler of `createDocumentHandlers` answers it 503 with that
  message, which names no host or path, and `Retry-After: 5` (before 0.9.0, a 500). The handlers log nothing: log your
  error in the store before you throw, or log `error.cause`. See the
  [node reference](../reference/node.md#uploadrequest-response). Under an application's ID, the
  library first asks `getMeta(id)`, and calls `delete(id)` only when nothing is there or the document
  there is this ingest's own (the same `createdAt`, owner and scope). Another document there is left.
  When it has not expired and is of another owner or scope, stored by another server meanwhile, the
  ingest throws an `IngestError` `"exists"` (409) instead: a `put` that refuses an ID it already has,
  as an insert with a unique key does, ends that way. Such a `put` must refuse before it writes
  anything under the ID. One that writes the text first and then fails at the insert has written
  over the text of the document that is left. The library reads that document as missing when its
  text has another length or number of lines than its metadata says, but cannot tell a text of the
  same length and lines. The [example](#example-object-storage-and-a-database) claims the record
  first. The document a replace was to remove, when that `delete` failed, is left too, and the error
  is the 503 above.
- **`delete` and `sweep`**: your error comes out of `files.delete` and `files.sweep` as a
  `DocumentStoreError` of operation `"delete"` or `"sweep"`, with your error as `cause` (new in
  0.9.0: it came out as it was). The DELETE handler answers it 503 with its message.
- **A scope you cannot keep**: throw a `DocumentScopeError` (`"scope_required"`, `"scope_invalid"`,
  `"scope_missing"`). It is passed on as it is from every call, reads and writes alike: it is a
  mistake of the call, not a store to try again. The handlers of `createDocumentHandlers` answer
  `"scope_missing"` `404` "This chat no longer exists.", and the other two `500` (new in 0.9.0).
- **`putIndex` on a later read**: an error is ignored. The index is used from memory, and built again
  the next time.

### Concurrency and several servers

- Every method may run many times at once, for the same document too. Many users ask at once, the
  tool calls of one turn run together, and a search reads the next piece of a text while it searches
  the current one.
- In one library, calls that open the same document at the same time share one opening: one `get`,
  or one `getIndex`.
- A document is written once. With an ID the library makes, the ID is new at every ingest. With an
  [application's ID](#application-ids), another document can be written under the ID later: after
  `files.delete`, once the document has expired, or with `ifExists: "replace"`, which calls
  `delete(id)` and then writes. The library forgets what it kept in memory of the old one. On other
  servers, the old one is missing for a moment, and their copies are checked against the new
  metadata before any use.
- Two servers may ingest one application's ID at the same moment, when both find it free. The
  library takes them for the same upload sent twice: let the last write win. Its clean-up after a
  failed write leaves a document whose metadata it finds. The parts of one still being written on
  the other server at that moment may be removed (see [Errors](#errors)).
- Only `putIndex` writes again, later, for a document whose index was missing or did not match its
  text. Several servers may do that at once, with the same bytes: let the last write win.
- Make the metadata the point where a document exists. Write it last, in `put`, after the text, and
  remove it first in `delete`. A server that finds the metadata must be able to read all of the text.
  `FileDocumentStore` gets this on a shared volume by writing under a temporary name and renaming. A
  store that inserts the metadata under a unique key can insert it first instead, hidden from
  `getMeta`, and show it once the text is written, as the
  [example](#example-object-storage-and-a-database) does. A `put` that loses a race for an ID then
  fails before it writes over the text of the one that won.
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
import { APP_DOCUMENT_ID_PATTERN, type DocumentMeta, type DocumentStore, type StoredDocument } from "llm-large-files";

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
  /** Set while `put` writes the text: the document is not there yet. */
  writing?: true;
};

/** A write that failed: a 503 from createDocumentHandlers, with a message that names no host. */
function notStored(cause: unknown): Error {
  console.error("document store write failed", cause); // the handlers log nothing
  return Object.assign(new Error("The file could not be stored. Try again.", { cause }), { status: 503 });
}

export class BlobDocumentStore implements DocumentStore {
  constructor(
    private readonly blobs: Blobs,
    private readonly records: Collection<DocumentRecord>,
    private readonly prefix = "llm-large-files",
  ) {}

  /** Only a document ID becomes part of a key, as in the built-in stores: the library's, or the application's. */
  private key(id: string, kind: "txt" | "idx" | "bin"): string {
    if (!APP_DOCUMENT_ID_PATTERN.test(id)) throw new Error("Invalid document ID.");
    return `${this.prefix}/${id}.${kind}`;
  }

  /**
   * Called last at ingest. The record first, marked as being written: a put that loses a race for
   * the ID fails at the unique `_id`, before it writes over the text of the one that won. Then the
   * text, then the mark goes: a document exists once its record is there without the mark.
   */
  async put({ meta, text }: StoredDocument): Promise<void> {
    try {
      await this.records.insertOne({ _id: meta.id, meta, owner: meta.owner ?? null, expiresAt: new Date(meta.expiresAt), writing: true });
      await this.blobs.write(this.key(meta.id, "txt"), new TextEncoder().encode(text));
      // This put's record only: another server may have removed it meanwhile.
      const { matchedCount } = await this.records.updateOne({ _id: meta.id, writing: true, "meta.createdAt": meta.createdAt }, { $unset: { writing: "" } });
      if (matchedCount === 0) throw new Error(`The record of ${meta.id} was removed while its text was written.`);
    } catch (error) {
      throw notStored(error);
    }
  }

  /** Called before every use of a document: one look-up by key. A record still being written is not a document yet. */
  async getMeta(id: string): Promise<DocumentMeta | undefined> {
    return (await this.records.findOne({ _id: id, writing: { $exists: false } }))?.meta;
  }

  async get(id: string): Promise<StoredDocument | undefined> {
    const meta = await this.getMeta(id);
    const bytes = meta && await this.blobs.read(this.key(id, "txt"));
    return meta && bytes ? { meta, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) } : undefined;
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
    if (!APP_DOCUMENT_ID_PATTERN.test(id)) return false;
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

- Reads let their errors through: the library turns them into a `DocumentStoreError`. Writes log
  theirs, then throw. Since 0.9.0 the library turns them into a `DocumentStoreError` too, so an
  upload that meets a database that is down is answered 503 "The document could not be stored. Try
  again.", with `Retry-After: 5`, whatever the store's own error says.
- `put` inserts the record first, marked `writing`, and `getMeta` does not see it until the text is
  written. When two servers ingest one ID at the same moment, the one whose insert fails has written
  no text. Its index and its original were written before `put`, so they can still land over the
  other's. The library checks both: an index that does not match the metadata is built again from
  the text, and an original of another size or SHA-256 reads as missing.
- A record left marked by a server that stopped in the middle of a `put` is not a document. `sweep`
  removes it once it has expired. A later ingest of that ID fails once with a 503, and removes it as
  it cleans up.
- `delete` removes the record first. If removing an object fails after that, the document is gone
  and the object stays behind. A lifecycle rule on the bucket that removes objects under the prefix
  some time after `ttlMs` cleans those up, when `ttlMs` is finite.
- Index the collection on `expiresAt` for the sweep, and on `owner` to find a user's documents:
  `records.find({ owner: userId })` gives the IDs to pass to `files.delete(id, { owner: userId })`.
- A MongoDB TTL index on `expiresAt` (`expireAfterSeconds: 0`) removes the records without a sweep,
  but not the objects. It needs a lifecycle rule on the bucket as well.

### Checking your store

`documentStoreChecks` from `llm-large-files/testing` (new in 0.9.0) checks a store against this
page: copies of the metadata, fields it does not know, `null` for a field left out, expiry, every
part removed by `delete`, ranges across multi-byte characters, the index, the original byte for
byte, the sweep's clock, the application's IDs, the context on every call, scopes kept apart, two
servers over one storage, and the library over the store against `MemoryDocumentStore`. Run them
in your tests:

```ts
// blob-document-store.test.ts, with Vitest. Jest: the same with `test`. node:test:
// test(check.name, { timeout: check.timeoutMs }, check.run).
import { it } from "vitest";
import { documentStoreChecks } from "llm-large-files/testing";
import { BlobDocumentStore } from "./blob-document-store.js";
import { blobsFor, recordsFor, dropStorage } from "./test-storage.js"; // a bucket prefix and a collection for each name

for (const check of documentStoreChecks({
  create: ({ storage }) => new BlobDocumentStore(blobsFor(storage), recordsFor(storage)),
  dispose: (_store, { storage }) => dropStorage(storage),
})) it(check.name, check.run, check.timeoutMs);
```

- `create` makes a store over new storage for each check, named by `storage`. Called twice with
  the same name, it must give two stores over the same storage, as two servers.
- Say what your store does: `isolatesScopes: true` if it keeps the documents of each scope apart,
  `requiresScope: true` if it refuses a call without a scope, and `skip` for the parts it does not
  have (`"originals"`, `"ranges"`, `"index"`, `"sweep"`, `"shared"`).
- A failed check says what it expected and what came back. The options and every check are in
  [the reference](../reference/testing.md#documentstorechecksoptions).

The library's own tests run them on `MemoryDocumentStore`, `FileDocumentStore` in one folder, and
`FileDocumentStore` with `scopes`.

What the checks cannot do for you, by hand:

- With the database stopped, `files.getMeta(id)` rejects with a `DocumentStoreError` instead of
  giving undefined, and a tool call answers "The document store could not be read. Try again.",
  with a code in parentheses when your error has one.
- With a write that fails, `files.ingest` throws, and leaves no record and no object behind.
- A text file that is not UTF-8, such as a CSV saved by Excel in windows-1255, is ingested, and
  `files.getMeta(id)` gives back its `encoding`. A schema of your database may refuse fields the
  checks' metadata does not have.
- An expired document whose removal fails is still read as missing.

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
  lines), so a store restored from a backup is read again. Since 0.9.0 it must also be of the same
  owner and scope: a document stored under a reused [application's ID](#application-ids) by another
  owner is read again, even within the same millisecond and with a text of the same size.
- A document loaded whole is used only when the document `get` returns is the one `getMeta`
  described, of the same owner, scope and version (new in 0.9.0). If another server replaced it in
  between, it is missing for this call.
- A document read by range is checked after its reads instead (new in 0.9.0): once a tool call or
  `prepare` has read it, the store is asked again (`getMeta`). If it no longer describes the same
  document, the call answers that the document is no longer available, and the copy kept of it, its
  pieces included, is forgotten.
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
