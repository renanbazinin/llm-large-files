# Upgrading to 0.9

This page takes an application from 0.8.x (0.8.0 to 0.8.2) to 0.9.0. Most applications change no
code: read [Requirements](#requirements), [Does my code compile?](#does-my-code-compile) and
[Behavior to check](#behavior-to-check). The other sections are for a store of your own, several
servers on one store, and an application that keeps files on a shared volume per user and chat.
Every change is in the [changelog](../CHANGELOG.md).

0.9.0 lets one library serve every user and chat of a server process. Each store call carries the
scope and the owner of the call. `FileDocumentStore` can keep a folder per user and chat. A
document can take your application's ID. The uploads your application keeps are read where they
are, instead of copied into the store. The text sent to the model is the same as in 0.8.2 for
ordinary chats, so the provider's prompt cache is not lost at the upgrade
([What did not change](#what-did-not-change)).

## Contents

- [Requirements](#requirements)
- [Does my code compile?](#does-my-code-compile)
- [Behavior to check](#behavior-to-check)
- [Stores of your own](#stores-of-your-own)
- [Several servers and rolling deploys](#several-servers-and-rolling-deploys)
- [A worked example: a Hebrew chatbot on Gemini, MongoDB and a shared volume](#a-worked-example-a-hebrew-chatbot-on-gemini-mongodb-and-a-shared-volume)
- [Moving the documents of 0.8](#moving-the-documents-of-08)
- [What did not change](#what-did-not-change)
- [New and optional](#new-and-optional)

## Requirements

- **Node.js 22.12 or later.** `engines.node` is `>=22.12`; it was `>=20.19`. Node 22.0 to 22.11
  cannot `require()` the package from CommonJS. CI runs Node 22, 24 and 26, on Ubuntu and Windows.
  npm only warns (`EBADENGINE`) unless `engine-strict` is set, so an app on Node 20 still installs,
  but nothing is tested there.
- **TypeScript:** `@types/node` ^22. The package is checked without the DOM library, as a server
  app compiles, and its declarations need nothing else.
- **The optional dependencies are unchanged:** `unpdf` `^1.4.0 || ^2.0.0`, `jszip` `^3.10.0`,
  `@cantoo/pdf-lib` `^2.11.1`.

## Does my code compile?

Most code does. Every new option and field is optional. Every method of `DocumentStore` takes a new
last argument, `context`, and it is optional too: a store whose methods take only the arguments of
0.8 still implements the interface. These do not compile:

| Code of yours | The error | What to write |
|---|---|---|
| A `switch` over `NoticeCode` with a `never` check, or a `Record<NoticeCode, …>` | Three new members: `"documents_missing"`, `"document_gone"`, `"page_looks_busy"` | Add them; a `switch` can end in a `default` instead |
| A `switch` over `IngestErrorCode` with a `never` check, or a `Record<IngestErrorCode, …>` | A new member: `"exists"` (409) | Add it |
| `event.error.code` used as an `IngestErrorCode`, or a `switch` over it with a `never` check | `EventError.code` is now `IngestErrorCode \| DocumentScopeErrorCode` | Check the code first; a `switch` needs `"exists"` and the three scope codes |
| Code that reads `input.bytes` of the argument of `ingest` (TS18048, TS2532): a `LargeFiles` of your own whose `ingest` parameter is inferred, the calls of a spy or mock of `files.ingest`, a value typed `Parameters<LargeFiles["ingest"]>[0]`. Or that passes it to a function that takes `IngestInput` (TS2345) | `ingest` takes `IngestInput \| IngestFromSource`: a file can come as a path, without bytes | Narrow `input` |
| A store of your own, or a subclass of `FileDocumentStore` or `MemoryDocumentStore`, whose method takes a parameter of its own after those of 0.8: `get(id, options?)`, `sweep(now?, dryRun?)` (TS2322, TS2416) | The new `context` takes that place, and the library passes it there | Put your parameter after `context`: `get(id, context?, options?)` |
| A subclass of `DocumentStoreError` that declares its own `status`, or of `DocumentsNotFoundError` that declares its own `status` or `code` | They are `503`, and `404` and `"documents_missing"` | Leave them out |
| A subclass of `IngestError`, `DocumentStoreError`, `DocumentsNotFoundError` or `ModelRequestError` with a static `is` that does not fit `(value: unknown) => value is …`, such as one that returns `boolean` (TS2417) | Each of them has a static `is` now | Return `value is` your class, or rename yours |
| `fromGeminiContents` passed as a callback: `histories.map(fromGeminiContents)` (TS2345) | Its new second parameter would get the index | `histories.map((contents) => fromGeminiContents(contents))` |

The fixes, for a page that words notices and the errors of uploads, and for a wrapper of the
library:

```ts
import type { EventError, IngestErrorCode, LargeFiles, NoticeCode } from "llm-large-files";

/** The words of a notice for your page, or none. */
export function noticeLabel(code: NoticeCode): string | undefined {
  switch (code) {
    case "documents_missing":
      return "Some files of this chat are no longer available.";
    case "page_looks_busy":
      return "The pages could not be looked at right now.";
    default:
      return undefined; // "document_gone", and the codes a later version adds
  }
}

const uploadWords: Record<IngestErrorCode, string> = {
  empty: "The file is empty.",
  too_large: "The file is too large.",
  too_much_text: "The file has too much text.",
  too_many_pages: "The file has too many pages.",
  not_text: "This kind of file cannot be read.",
  compressed: "The file is compressed.",
  legacy_office: "The Office file is old or has a password.",
  encrypted: "The PDF has a password.",
  no_text: "No text was found in the file.",
  hostile: "The file cannot be read safely.",
  timeout: "The file took too long to read.",
  out_of_memory: "The file needs too much memory to read.",
  busy: "The server is busy. Try again in a moment.",
  missing_dependency: "This kind of file cannot be read on this server.",
  unreadable: "The file could not be read.",
  exists: "This file is already attached.", // new in 0.9.0
};
const isIngestCode = (code: string | undefined): code is IngestErrorCode => code !== undefined && Object.hasOwn(uploadWords, code);
/** The words for the error of an ingest.error event. */
export const wordsOf = (error: EventError): string => (isIngestCode(error.code) ? uploadWords[error.code] : error.message);

/** A wrapper that logs each upload: it narrows the input, which may be a path since 0.9.0. */
export function loggedFiles(inner: LargeFiles): LargeFiles {
  return {
    ...inner,
    ingest: (input) => {
      console.info(`ingest ${input.name}: ${input.bytes ? `${input.bytes.byteLength} bytes` : "from a path"}`);
      return inner.ingest(input);
    },
  };
}
```

- **Narrow, or annotate.** `"source" in input` narrows too. `ingest: (input: IngestInput) => …`
  also compiles, because a method's parameter is compared both ways. But such a wrapper gets a path
  all the same from `createDocumentHandlers` with `uploadSpool` or `prepareUpload`, and its
  `input.bytes` is then undefined. Annotate only a wrapper that is never given a path.
- **A `LargeFiles` of your own given to `createDocumentHandlers`** must also throw `IngestError`
  for a file it refuses ([below](#the-upload-handler-answers-422-only-for-an-ingesterror)).

## Behavior to check

Each point says what changed, whom it affects, and what to do.

### Store failures are `DocumentStoreError`

- A store that fails while `files.ingest` writes now throws a `DocumentStoreError` with
  `operation: "write"`, `status: 503`, and the store's own error as `cause`. A write that does not
  end within `ingestTimeoutMs` is one of code `"ETIMEDOUT"`. Before, the store's error came out as
  it was.
- A failed `files.delete` throws one with `operation: "delete"`, and a failed `files.sweep` one
  with `operation: "sweep"`. They used to pass on the store's errors, which could hold the path of
  the volume.
- Its message names what failed and a code, never a path or a host: "The document could not be
  stored (EIO). Try again."
- `DocumentStoreError` has `status: 503`, and `DocumentsNotFoundError` has `status: 404` and
  `code: "documents_missing"`. Their `run.error` events carry these statuses too.

**What to do.** Code that caught its own store error class reads `error.cause`. Log `error.cause`:
the handlers log nothing. Code that takes any error with a numeric `status` for a model's error
checks these first, with `DocumentStoreError.is(error)` and `DocumentsNotFoundError.is(error)`, or
reads [`errorInfoOf(error)`](./guides/errors-and-reliability.md#your-users-words-errorinfoof).

### The upload handler answers 422 only for an `IngestError`

`createDocumentHandlers` answers errors by the rule of `uploadAnswerOf`
([node reference](./reference/node.md#how-errors-are-answered)). What changed (S12):

| The error | 0.8.2 | 0.9.0 |
|---|---|---|
| A plain `Error` from a `LargeFiles` of your own (no `status`, no system `code`) | 422 with its message, which could name a database host | 500 `{ "error": "Upload failed." }` |
| An `IngestError` of code `"unreadable"` | 422 with the parser's or extractor's message | 422 "This file could not be read. It may be damaged, or not of the type its name says." |
| A store that fails while it writes | 500 | 503 with `Retry-After: 5` |
| A store that fails on `get` or `remove` | 500, such as "The file could not be looked up (EIO)." | 503 with `Retry-After: 5` |
| A `DocumentScopeError` | 422 with its message | 404 "This chat no longer exists." for `"scope_missing"`, 500 for the other codes |
| A model's error thrown by an ingest of yours | The provider's status and message | The status and words of `errorInfoOf` |
| A 413 that the handler did not make (one thrown by `getOwner`, say) | The upload-limit message | Its own message |

The handler no longer URI-decodes `Content-Type`; `X-File-Type` still is decoded.

**What to do.** Throw `new IngestError(code, message)` for a file you refuse: only an
`IngestError` keeps its message. The `ingestInProcess` recipe of
[Deployment](./guides/deployment.md#uploads-and-ingest) rebuilds `IngestError` and
`DocumentStoreError` from its child process. A route of your own answers as the handler does with
`uploadAnswerOf`. A client sends a type that needs encoding in `X-File-Type`.

### `requireOwner` and `requireScope` in the handlers

Both are new options of `createLargeFiles`, off by default. When the library has them,
`createDocumentHandlers` throws a `TypeError` without `getOwner`, or without `getScope`. Under
`requireOwner`, an owner of `undefined` or `null` is a 401 `{ "error": "Sign in first." }` on every
route, before the body is read, and `""` a 500 "(empty owner)". Documents stored without an owner,
or without a scope, then read as missing: documents of 0.8, and those that 0.5.0 stored with the
owner `""`.

**What to do.** Give `getOwner` and `getScope`. Turn them on once every server runs 0.9.0, and
once the documents without an owner or a scope are moved or gone
([Moving the documents of 0.8](#moving-the-documents-of-08)).

### `FileDocumentStore` writes files `0600`

Files are written `0600` and folders made `0700`. Before, they were `0666` and `0777` minus the
umask: `0664` and `0775` under the usual `0002`. A server, a sidecar, or a backup or sweep job that
runs as another user of the same group (a Kubernetes `fsGroup`) reads "The document store could not
be read (EACCES)".

**What to do.** For those, set `fileMode: 0o640` and `directoryMode: 0o750` on every store. Files
written before keep their modes: `chmod` them once to narrow them.

### `files.delete` and leftovers

`FileDocumentStore.delete`, and so `files.delete`, returns true once the metadata is gone. A text,
index or original it cannot remove is left for `sweep`; it used to throw. Removals are tried again
for about 2.6 s on `EPERM`, `EACCES` and `EBUSY`, as renames are.

**What to do.** For erasure, keep a sweep running, or remove the chat's folder. Tests that mock
`fs.rm` to make a removal fail must mock `unlink`.

### MIME types are cleaned

`meta.mimeType` is now a lowercased type/subtype, without parameters: `"Text/CSV; charset=x"` is
stored as `"text/csv"`. A value that is not a valid type/subtype of at most 127 characters, or that
holds anything but printable ASCII (a line break, U+202E), is stored as
`application/octet-stream`. The library never used the charset: it reads a text's encoding from
its bytes.

**What to do.** Compare `meta.mimeType` with the clean form.

### New fields in what you store

- `ingest` writes `metaVersion: 1` and `sha256` into every `DocumentMeta`, and `scope` and
  `original` when it is given them.
- Every `ToolTurn` that `askWithFiles` returns has `version: 1`.

**What to do.** Tests that compare a meta or a round whole expect these fields. A schema that
refuses fields it does not know must allow them: for the metadata a store of yours keeps, and for
the rounds you keep with each question. Otherwise every ingest fails with a 503
([Stores of your own](#allow-the-new-fields)).

### Data written by a newer version

- Metadata with `metaVersion` above 1 makes `getMeta`, `getOriginal`, `delete`, `prepare`,
  `askWithFiles` and the tools throw a `DocumentStoreError` of code `"NEWER_VERSION"`. It is not
  read as missing, so your app does not ingest the file again over newer data.
- A stored `ToolTurn` with `version` above 1 makes `askWithFiles` throw a `TypeError`, before any
  request.

**What to do.** Nothing now: only a later version writes such data. While servers of two versions
share a store, let such a call be tried again on a newer server. Catch the `TypeError` to ask
again without the old rounds.

### Looks at pages take turns

One look at the pages of a PDF (`view_pages`) runs at a time in a library
(`maxConcurrentPageLooks: 1`), over all its questions. The others wait up to 30 s
(`pageLookWaitMs`). Past that, the model is told the server is busy, and the question gets a
`"page_looks_busy"` notice. Six looks at once used to run together, each about four times slower,
and held 352 MB more than one.

**What to do.** Nothing. On a server with heap to spare, raise `maxConcurrentPageLooks`;
`Infinity` runs every look at once, as in 0.8.2 ([PDFs](./guides/pdfs.md#view_pages)).

### Gemini `contents`

`fromGeminiContents`, which `askGemini` uses for `contents`, now turns the library's tool rounds
back into stored rounds (`ToolTurn`). A repeated call is then answered with a pointer, and old
results can be shortened, as with `toolTurns`. The first request is the same, byte for byte, for
rounds that `geminiToolTurns` wrote. Rounds that 0.5.0 converted hold `tool_turns_left` in their
responses: they are now sent without it, so such a conversation misses the prompt cache once.

**What to do.** Nothing. `fromGeminiContents(contents, { rounds: false })` gives the output of 0.8.

### Tests of the tool loop

- A question whose stored rounds make its first request too large is shortened before that
  request. A test sees a `"results_shortened"` step and one request fewer, where it saw a refused
  request and `"room_made"`.
- A result that its stand-in would not make smaller stays whole: a short grouped search, a small
  `aggregate_table` result.
- An error of an adapter of yours with a `status` and no `kind`, as `httpError` of
  `llm-large-files/testing` makes, gets a `kind` in its `EventError`: `"server"` for a 503. The
  retries go by that kind: a 429 of code `"insufficient_quota"` is a quota, and is not sent again.
- Thrown plain data with a status (`{ status: 429, message }`) is "Something went wrong." in its
  event.

**What to do.** Update tests that compare these whole.

### An ingest stopped during its write keeps nothing

When an ingest's `signal` aborts while the store writes, what the writes stored is removed once
they end, and `ingest` throws `signal.reason`. Before, the document stayed: for good under
`ttlMs: Infinity`. With the upload handlers, a client that leaves before its ingest ends leaves
nothing stored, and `onUploaded` is not called.

**What to do.** Nothing, unless your code counted on the document of an ingest it stopped.

### `isDocumentId` accepts application IDs

It now tests `APP_DOCUMENT_ID_PATTERN`, which the library's own `doc_` IDs match too.

**What to do.** To tell the library's IDs from yours, test `DOCUMENT_ID_PATTERN`.

## Stores of your own

### Pass the context on

The library now passes `{ scope, owner }` to every store call, as a last argument. A store of 0.8
ignores it, and still works. A wrapper or a subclass that passes only the ID on still compiles,
but drops the context:

- over a store that keeps the scopes apart, such a call does not find the documents stored in a
  scope;
- over a `FileDocumentStore` with `scopes`, every call but `sweep` throws a `DocumentScopeError` of
  code `"scope_required"`. With `unscoped: "root"`, the documents go to the root folder without an
  error, outside the chat's folder: removing that folder does not erase them;
- a `sweep` that drops it sweeps every scope: `files.sweep({ scope })` removes the expired
  documents of every chat.

Pass every argument on:

```ts
import type { DocumentContext, DocumentStore, StoredDocument } from "llm-large-files";

/** Logs the time of each read of metadata, and passes every argument on: the context too. */
export function timed(inner: DocumentStore): DocumentStore {
  return {
    put: (document: StoredDocument, context?: DocumentContext) => inner.put(document, context),
    get: (id, context) => inner.get(id, context),
    getMeta: async (id, context) => {
      const started = performance.now();
      try {
        return await inner.getMeta(id, context);
      } finally {
        console.info(`getMeta took ${Math.round(performance.now() - started)} ms`);
      }
    },
    delete: (id, context) => inner.delete(id, context),
    sweep: (now, context) => inner.sweep?.(now, context) ?? Promise.resolve(0),
  };
}
```

A subclass writes `super.getMeta(id, context)`, not `super.getMeta(id)`. A wrapper of a store with
optional methods, such as `readTextRange` and `getOriginal`, passes those on the same way: a
wrapper without them hides them from the library.

### Use the context, or not

- `context.scope` can be the boundary of your storage: a key prefix, a folder, a filter on a
  collection. `context.owner` lets you index the documents by user.
- A store that ignores the context still keeps the scopes apart for the library, through
  `meta.scope`. The IDs your application gives must then be unique in the whole store: an ingest
  under an ID that is taken in another scope is an `IngestError` `"exists"` (409).
- Which call carries which context, and the rules of a store, are in
  [Writing a store of your own](./guides/storage.md#writing-a-store-of-your-own). In short: return
  a field that was left out (`owner`, `scope`) absent, not `null`. Read an expired document as
  missing, even when its removal fails. Throw a `DocumentScopeError` for a scope you cannot keep.

### Allow the new fields

A schema that checks each field of what you store refuses the fields 0.9.0 adds: a MongoDB
`$jsonSchema` with `additionalProperties: false`, or a Mongoose schema in strict mode that throws.
Over the metadata of a store of yours, every ingest then fails with a 503 "The document could not
be stored (…). Try again.", and so does every retry. Over the rounds you keep, your own insert
fails. Change the schema before the first server of 0.9.0 starts:

```ts
import { MongoClient } from "mongodb";

const mongo = new MongoClient(process.env.MONGODB_URI!);
const db = mongo.db("chat");

export async function allowNewFields(): Promise<void> {
  // A collection of DocumentMeta (a store of your own), checked by a $jsonSchema without other fields.
  await db.command({
    collMod: "documents",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        properties: {
          _id: {},
          // ...the fields your schema already has, then those of 0.9.0:
          metaVersion: { bsonType: "number" },
          scope: { bsonType: "array", items: { bsonType: "string" } },
          sha256: { bsonType: "string" },
          original: {
            bsonType: "object",
            properties: { ref: { bsonType: "string" }, bytes: { bsonType: "number" }, sha256: { bsonType: "string" } },
          },
        },
      },
    },
  });
  // The rounds you keep with each question: a round gets `version`.
  await db.command({
    collMod: "turns",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        properties: {
          toolTurns: {
            bsonType: "array",
            items: {
              bsonType: "object",
              additionalProperties: false,
              required: ["role", "calls"],
              properties: { role: { enum: ["tools"] }, version: { bsonType: "number" }, calls: { bsonType: "array" } },
            },
          },
        },
      },
    },
  });
}
```

Keep every field of `meta`, including those your store does not know: later versions add more.

### Check the store

`documentStoreChecks` of `llm-large-files/testing` runs the checks a store must pass, in Vitest,
Jest or `node:test`. With `isolatesScopes`, it checks that one ID in two scopes is two documents
on every method: a wrapper that drops the context fails there
([Checking a store](./reference/testing.md#checking-a-store)).

## Several servers and rolling deploys

During a rolling deploy, servers of 0.8 and 0.9 share the store and answer the same chats. What a
server of 0.8 does with what 0.9.0 wrote:

| What 0.9.0 wrote | A server of 0.8 |
|---|---|
| A document in the flat layout of `FileDocumentStore`, under a library ID (`doc_…`) | Reads it, and ignores `metaVersion` and `sha256`. |
| A document under an application's ID | Finds it missing, over any store: it takes only `doc_` IDs. |
| A document in the folders of a `FileDocumentStore` with `scopes` | Finds it missing: it does not look there. |
| A document with a scope, in a store that ignores the context (the flat layout, a store of yours written for 0.8) | Serves it to its owner in any scope: it does not check `meta.scope`. |
| An original kept by reference | Takes it for kept, but the store has no copy: its `view_pages` answers that the original file is no longer on the server. |
| A file written `0600` | Cannot read it when it runs as another user. |
| A stored round with `version: 1` | Reads it, and ignores the field. |

0.9.0 reads what 0.8 wrote, as before. Documents of 0.8 have no `metaVersion` and no `sha256`: a
kept copy is checked by its size alone. They have no scope either: under `requireScope` they read
as missing, and a `FileDocumentStore` with `scopes` looks for them only in the folder of the
call's scope.

So upgrade in two steps:

1. **First the package, with your settings as they are.** Before that, change the schemas that
   refuse new fields ([above](#allow-the-new-fields)), and set `fileMode` and `directoryMode` if
   servers or jobs run as other users. During this deploy, servers of both versions read each
   other's documents.
2. **Then the new settings,** once no server of 0.8 is left: `scopes`, application IDs, originals
   by reference, `requireOwner` and `requireScope`. A server with the old settings does not find
   the documents of the new ones. Deploy them to every server at once (blue-green), or keep each
   chat on servers of one setting until the deploy ends.

Run the sweep from a server of 0.9.0. One of 0.8 does not go into the folders of a store with
`scopes`, and leaves the files of application IDs alone. More on several servers is in
[Deployment](./guides/deployment.md#servers-of-two-versions).

From 0.9.0 on, `metaVersion` and `ToolTurn.version` protect what a later version writes: 0.9.0
refuses it ([above](#data-written-by-a-newer-version)), where 0.8 ignores both fields.

## A worked example: a Hebrew chatbot on Gemini, MongoDB and a shared volume

A chatbot for Hebrew-speaking users answers with Gemini on Vertex AI. It keeps its chats in
MongoDB: one record per chat with its files, and one per question with its tool rounds. Several
pods mount one volume over NFS, with a folder per user and chat.

**Before, on 0.8.2,** each request made a library for its chat, over a store in the chat's folder.
The limits of 0.8.2 (`maxConcurrentIngests`, `cacheBytes`, `maxConcurrentScans`) then held for each
chat, not for the pod. Each PDF was kept twice: the upload the app saved, and a copy in the store.
The app kept a lookup of where each `doc_` ID lived.

```ts
// Before (0.8.2): a library for each chat, each with a store over the chat's folder.
const filesOf = (userId: string, sessionId: string) =>
  createLargeFiles({
    store: new FileDocumentStore(path.join(VOLUME, userId, sessionId)),
    keepOriginals: ["pdf"], // a second copy of each PDF, as <id>.bin
  });
```

**After, on 0.9.0,** one library serves the whole pod. The store keeps each chat's files in the
chat's folder. Each upload is saved once, by the upload handler, in the chat's `uploads` folder,
under an ID the app makes. The library reads it there for `view_pages`, and the store keeps no
copy. The ID is the document's ID, so the chat's record needs no lookup.

```text
/mnt/documents/
  h3f9a…/                         the user: a hash of the user's ID
    65a1f0c2e4b0a1b2c3d4e5f6/     the chat: its MongoDB ObjectId
      .llm-large-files/           the store's files: up-1c2d….json, .txt, .idx
      uploads/                    the uploads: up-1c2d…, the PDF as the user sent it
```

### The documents and the uploads

```ts
// documents.ts: one library for the process, the same on every pod.
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";
import { createLargeFiles, FileDocumentStore, hashedScopeSegment, isSafeScopeSegment, type DocumentScope, type ToolTurn } from "llm-large-files";
import { createDocumentHandlers, fileOriginals } from "llm-large-files/node";

// The volume every pod mounts (NFS, with lookupcache=positive).
const VOLUME = process.env.DOCUMENTS_DIR ?? "/mnt/documents";

/** A chat, with the files attached to it. `_id` is a MongoDB ObjectId in hex. */
type ChatFile = { id: string; name: string; sha256?: string };
export type SessionRecord = { _id: string; userId: string; files: ChatFile[] };
/** One question of a chat, with the tool rounds that answered it. */
export type TurnRecord = { sessionId: string; index: number; question: string; toolTurns: ToolTurn[]; answer?: string; createdAt: Date };

const mongo = new MongoClient(process.env.MONGODB_URI!);
export const db = mongo.db("chat");
export const sessions = db.collection<SessionRecord>("sessions");
export const turns = db.collection<TurnRecord>("turns");

export const files = createLargeFiles({
  // <VOLUME>/<user>/<session>/.llm-large-files/: the store's files of each chat.
  store: new FileDocumentStore(VOLUME, { scopes: { depth: 2 } }),
  keepOriginals: ["pdf"], // so that view_pages can look at the pages of a PDF
  originals: fileOriginals(VOLUME), // the uploads, read where the handler saved them
  ttlMs: Infinity, // a chat's documents stay as long as the chat
  requireOwner: true,
  requireScope: true,
});

/**
 * The scope of a chat, which is also its folder. A user ID from the sign-in may have capitals or
 * an "@", so its folder is its hash. A session ID is an ObjectId: lowercase hex.
 */
export function scopeOf(userId: string, sessionId: string): DocumentScope {
  if (!isSafeScopeSegment(sessionId)) throw new TypeError("This is not a session ID.");
  return [hashedScopeSegment(userId), sessionId];
}

/** Makes a chat's folders: call it when you create the chat's record, not on each upload. */
export async function startChat(userId: string, sessionId: string): Promise<void> {
  await mkdir(path.join(VOLUME, ...scopeOf(userId, sessionId), "uploads"), { recursive: true, mode: 0o700 });
}

/**
 * Deletes a chat, once its questions are stopped: its record first, so that no upload starts, then
 * its folder (the store's files and the uploads), then its questions, whose rounds hold excerpts.
 */
export async function deleteChat(userId: string, sessionId: string): Promise<void> {
  const { deletedCount } = await sessions.deleteOne({ _id: sessionId, userId });
  if (deletedCount === 0) return;
  await rm(path.join(VOLUME, ...scopeOf(userId, sessionId)), { recursive: true, force: true });
  await turns.deleteMany({ sessionId });
}

const chatGone = () => Object.assign(new Error("This chat no longer exists."), { status: 404 });

export const documents = createDocumentHandlers(files, {
  // Your sign-in: undefined answers 401 "Sign in first." under requireOwner.
  getOwner: (request) => userIdOf(request),
  // The chat comes in a header. Only the user's own chats.
  getScope: async (request) => {
    const userId = userIdOf(request)!;
    const sessionId = String(request.headers["x-session-id"] ?? "");
    if (!isSafeScopeSegment(sessionId) || !(await sessions.findOne({ _id: sessionId, userId }))) throw chatGone();
    return scopeOf(userId, sessionId);
  },
  // Before the body is read: the ID, where the body is saved, and the ref that fileOriginals reads.
  prepareUpload: (_request, { scope }) => {
    const id = `up-${randomUUID().replaceAll("-", "")}`;
    const ref = [...scope!, "uploads", id].join("/"); // <user>/<session>/uploads/<id>
    return { id, path: path.join(VOLUME, ref), original: { ref } };
  },
  // Once it is stored, the chat lists it. Throw, and the document and the saved file are removed.
  onUploaded: async (document, { owner, scope }) => {
    const file: ChatFile = { id: document.id, name: document.name, ...(document.sha256 ? { sha256: document.sha256 } : {}) };
    const { matchedCount } = await sessions.updateOne({ _id: scope![1]!, userId: owner! }, { $push: { files: file } });
    if (matchedCount === 0) throw chatGone();
  },
  // The library never removes the saved file: remove it with the document.
  onRemoved: async (id, { owner, scope }) => {
    await sessions.updateOne({ _id: scope![1]!, userId: owner! }, { $pull: { files: { id } } });
    await rm(path.join(VOLUME, ...scope!, "uploads", id), { force: true });
  },
});
```

`userIdOf(request)` is your sign-in: it gives the user's ID, or `undefined`. Mount
`documents.upload`, `documents.get` and `documents.remove` as in
[Web app](./guides/web-app.md#uploads-with-createdocumenthandlers).

- **One library, one store, every pod the same.** Each pod makes this library once. Its limits
  then hold for the pod, whatever the number of chats. Every pod opens its store over the same
  folder with the same options.
- **The folders.** The chat's folder and its `uploads` are made when the chat is. The store makes
  only its own folder, `.llm-large-files`, inside the chat's. The handler makes no folder.
  `fileOriginals` reads no file through a link in its folders, so the handler refuses such a path
  before it writes: 500 "Upload failed (ELOOP).". Mount another disk at the volume's path rather
  than link to it.
- **The user's folder is a hash.** A scope segment names a folder, so it must be lowercase letters,
  digits, `_` and `-` (`isSafeScopeSegment`). `hashedScopeSegment` turns any ID into one: `h` and 40
  hex digits. The owner stays the user's ID itself.
- **The ID.** `prepareUpload` makes the document's ID. It is random, so it cannot be guessed, and
  it holds nothing about the user: the model sees it.
- **The file is saved once.** The handler writes the body to `uploads/<id>` as it arrives, under
  `uploadIdleTimeoutMs`, and ingests it from there at its turn. It is not held in memory while it
  waits. When the upload fails for any reason, the file is removed.
- **`onUploaded` records the ID** before the browser gets its 201. When it throws, the document and
  the file are removed, and the browser gets the error. It has no time limit: give your database a
  timeout of its own.
- **`ttlMs: Infinity`.** A document that expired would be removed without a call to `onRemoved`,
  and would leave its upload and its line in the chat's record. So the documents stay as long as
  the chat, and go with it.
- **Deleting a chat.** `deleteChat` removes the record first: `getScope` then refuses a new upload
  with a 404. An upload already under way fails, with a 404 "This chat no longer exists." or a 500:
  the store does not make the chat's folder again (`createScopeFolders` is off by default).
- **Several pods.** Each upload's ID is new, so two pods never write one document. A question can
  run on another pod than its upload: each use asks the store first. Run the sweep from one pod, or
  from a scheduled job ([Deployment](./guides/deployment.md#sweeping-expired-documents)). With
  `ttlMs: Infinity` it removes no document, only what a failed delete or upload left behind.
- **Another user on the volume.** The store writes files `0600` in folders `0700`, the handler
  writes the uploads `0600` (`uploadFileMode`), and `startChat` makes its folders `0700`. If a backup
  job runs as another user of the pods' group, give the store `fileMode: 0o640` and
  `directoryMode: 0o750`, the handler `uploadFileMode: 0o640`, and `startChat` `mode: 0o750`.
- **The documents of 0.8** stay in the old folders, named by the user's ID itself, and the new
  store does not look there. Ingest them again when a question needs them
  ([Moving the documents of 0.8](#moving-the-documents-of-08)).

### Questions, with errors in Hebrew

```ts
// ask.ts: a question of a chat, answered by Gemini on Vertex AI, with errors in Hebrew.
import { GoogleAuth } from "google-auth-library";
import { errorInfoOf, partialResultOf, type ChatTurn, type ErrorInfo, type ToolTurn } from "llm-large-files";
import { askGemini, vertexAi } from "llm-large-files/gemini";
import { files, scopeOf, sessions, turns, type TurnRecord } from "./documents.js";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
});

/** The messages of the next question: each earlier question, its tool rounds, its answer. */
function historyOf(earlier: TurnRecord[], question: string): Array<ChatTurn | ToolTurn> {
  return [
    ...earlier.flatMap((turn): Array<ChatTurn | ToolTurn> => [
      { role: "user", text: turn.question },
      ...turn.toolTurns,
      ...(turn.answer !== undefined ? [{ role: "assistant" as const, text: turn.answer }] : []),
    ]),
    { role: "user", text: question },
  ];
}

export type Answer = { status: number; text?: string; missing?: string[]; error?: string; retryAfterMs?: number };

export async function ask(userId: string, sessionId: string, question: string, signal: AbortSignal): Promise<Answer> {
  const session = await sessions.findOne({ _id: sessionId, userId });
  if (!session) return { status: 404, error: "השיחה הזו כבר לא קיימת." };
  const earlier = await turns.find({ sessionId }).sort({ index: 1 }).toArray();
  const asked = { sessionId, index: earlier.length, question, createdAt: new Date() };
  try {
    const result = await askGemini({
      files,
      endpoint,
      owner: userId,
      scope: scopeOf(userId, sessionId),
      documentIds: session.files.map((file) => file.id),
      messages: historyOf(earlier, question),
      onMissingDocuments: "drop", // a file deleted in another tab: answer without it
      signal,
    });
    if (result.missing?.length) {
      await sessions.updateOne({ _id: sessionId, userId }, { $pull: { files: { id: { $in: result.missing } } } });
    }
    await turns.insertOne({ ...asked, toolTurns: result.toolTurns, ...(result.answered ? { answer: result.text } : {}) });
    return { status: 200, text: result.text, missing: result.missing ?? [] };
  } catch (error) {
    // What a failed question read is kept, so that the next one need not read it again.
    const partial = partialResultOf(error);
    if (partial) await turns.insertOne({ ...asked, toolTurns: partial.toolTurns });
    console.error("A question failed", error); // the provider's words are for your log
    const info = errorInfoOf(error);
    return { status: info.status, error: hebrew(info), ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}) };
  }
}

/** What to tell a Hebrew-speaking user. The whole table is in the errors guide. */
function hebrew(info: ErrorInfo): string {
  switch (info.category) {
    case "store":
      return "לא ניתן לגשת לקבצים כרגע. נסו שוב בעוד רגע.";
    case "missing":
      return info.code === "scope_missing" ? "השיחה הזו כבר לא קיימת." : "אחד הקבצים כבר לא זמין. צרפו אותו שוב.";
    case "model":
      switch (info.code) {
        case "context_overflow": return "השיחה ארוכה מדי. פתחו שיחה חדשה, או שאלו על פחות קבצים.";
        case "rate_limit": return "העוזר עמוס כרגע. נסו שוב בעוד דקה.";
        case "timeout": return "התשובה התעכבה יותר מדי. נסו שוב.";
        default: return "לא ניתן לקבל תשובה כרגע. נסו שוב.";
      }
    case "aborted":
      return "השאלה נעצרה.";
    default:
      return "משהו השתבש. נסו שוב מאוחר יותר.";
  }
}
```

- **The same owner and scope** as the upload: a document of another chat is missing here, even
  for the same user.
- **The rounds are kept** with each question, as `toolTurns`, each with `version: 1`. If the
  `turns` collection has a schema, it must allow that field ([above](#allow-the-new-fields)).
- **`onMissingDocuments: "drop"`** answers without a file that was deleted meanwhile, and lists it
  in `result.missing`, which the chat's record then drops.
- **`errorInfoOf`** gives one record for any error: a `category`, a `code`, the status to answer
  with, and when to try again. The words for the user are yours. The whole table is in
  [Errors and reliability](./guides/errors-and-reliability.md#your-users-words-errorinfoof), with
  the events of a streamed answer.
- **Nothing private reaches the model.** The owner, the scope, the ref of each upload and its
  SHA-256 are kept for the server. The model sees the file's name, its ID and its text.

### The page

The upload handlers answer in English. Their JSON answer is `{ "error": "…" }`, and its status
says enough to tell the user in Hebrew:

```ts
/** Sends a file to the chat, and gives its ID, or the words to show in Hebrew. */
export async function attach(sessionId: string, file: File): Promise<{ id: string } | { error: string }> {
  const response = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-Session-Id": sessionId },
    body: file,
  });
  if (response.ok) return { id: ((await response.json()) as { id: string }).id };
  return { error: uploadError(response.status, response.headers.get("Retry-After")) };
}

/** The upload handlers answer in English: the status says enough for the user. */
function uploadError(status: number, retryAfter: string | null): string {
  switch (status) {
    case 401: return "יש להתחבר מחדש.";
    case 404: return "השיחה הזו כבר לא קיימת.";
    case 408: return "ההעלאה נקטעה. נסו שוב.";
    case 413: return "הקובץ גדול מדי.";
    case 422: return "לא ניתן לקרוא את הקובץ. ייתכן שהוא פגום, סרוק או מסוג שאינו נתמך.";
    case 503: return `השרת עמוס כרגע. נסו שוב בעוד ${retryAfter ?? "כמה"} שניות.`;
    default: return "ההעלאה נכשלה. נסו שוב מאוחר יותר.";
  }
}
```

Set `dir="rtl"` (or `dir="auto"`) on the element that shows these words, so that a file name in
Latin letters stays in its place. An upload with progress (`Accept: text/event-stream`) ends with
`ingest.error`, whose `code` tells more: `"too_large"`, `"no_text"`, `"encrypted"`
([Web app](./guides/web-app.md#upload-with-progress)).

## Moving the documents of 0.8

Documents of 0.8 have no scope. Pick a way by the layout they are in.

- **A library per chat, each over `FileDocumentStore(<root>/<user>/<chat>)`.** Their files are in
  the chat's folder itself. `scopes: { depth: 2, folder: "" }` reads them there, in place, as long
  as `requireScope` is off and the names of the folders pass `isSafeScopeSegment`. Your own files
  then sit beside the store's: keep them in a subfolder, such as `uploads/`
  ([Storage](./guides/storage.md#files-in-a-folder-per-user-or-per-chat)).
- **One flat folder, `FileDocumentStore(<root>)`.** `scopes: { depth: 2, unscoped: "root" }` reads
  them from `<root>` for a call without a scope, as before, until they expire. New chats are asked
  with a scope, old ones without, and `requireScope` stays off.
- **Ingest them again, when a question needs them.** The new store does not find an old `doc_` ID
  in the chat's scope, so the question calls `onMissingDocuments`. Ingest the file again from the
  upload you kept, under a new ID in the chat's scope, and return `{ replace: { [oldId]: newId } }`.
  Then put the new ID in the chat's record, in place of the old one. This works with
  `requireScope` on. Earlier stored rounds still name the old ID: the model reads the file again
  under the new one.

```ts
import { askWithFiles, IngestError, type AskResult, type LargeFiles, type MissingDocumentsAction, type ModelAdapter } from "llm-large-files";

declare const files: LargeFiles;
declare const model: ModelAdapter;
// Your records of the uploads of 0.8: where each doc_ ID's file was saved.
declare const keptUploads: { find(userId: string, documentId: string): Promise<{ name: string; path: string } | undefined> };
declare const chats: { renameFiles(sessionId: string, replace: Record<string, string>): Promise<void> };

export async function askMoving(userId: string, sessionId: string, documentIds: string[], question: string): Promise<AskResult> {
  return askWithFiles({
    files,
    model,
    owner: userId,
    scope: [userId, sessionId],
    documentIds,
    messages: [{ role: "user", text: question }],
    onMissingDocuments: async (missing, { owner, scope }): Promise<MissingDocumentsAction> => {
      const replace: Record<string, string> = {};
      for (const oldId of missing) {
        const upload = await keptUploads.find(userId, oldId);
        if (!upload) continue; // gone for good
        const newId = `up-${oldId.slice(4)}`;
        try {
          await files.ingest({ name: upload.name, source: { path: upload.path }, owner, scope, id: newId });
        } catch (error) {
          // Another question of the chat ingested it meanwhile.
          if (!(IngestError.is(error) && error.code === "exists")) throw error;
        }
        replace[oldId] = newId;
      }
      await chats.renameFiles(sessionId, replace);
      // All back: plan again with the new IDs. Otherwise answer without those still missing.
      return Object.keys(replace).length === missing.length ? { replace } : "drop";
    },
  });
}
```

- The new ID is made from the old one, so two questions that meet the same old ID at once make one
  document. The second ingest gets `"exists"`. If the first has not stored it yet, that question
  fails with `DocumentsNotFoundError`, and can be asked again.
- `{ replace }` plans the question again once. An ID still missing then fails the question with
  `DocumentsNotFoundError`. With `"drop"`, the question is answered without the files still
  missing, and the files ingested again are used from the next question, under their new IDs
  ([missing documents](./reference/ask.md#missing-documents)).

## What did not change

- **The text sent to the model,** for ordinary chats: the tool guide, the tool descriptions, the
  cards and the instructions are those of 0.8.2. So the provider's prompt cache does not miss at
  the upgrade. Text is new only when its case happens:
  - the line for documents left out under `onMissingDocuments: "drop"`;
  - the busy answer of `view_pages`;
  - its answers for a file kept by reference that changed, and for a PDF the store did not return
    in time;
  - a document ingested under your ID is named by that ID, where the model saw `doc_…`;
  - a right-to-left PDF table ingested from 0.9.0 on can read in another order (LLF-037 in the
    changelog). Documents ingested before keep their text;
  - Gemini `contents` that 0.5.0 converted ([above](#gemini-contents)).
- **The store interface.** No method is new, and none is required that was not.
- **The flat layout of `FileDocumentStore`:** the names of its files, and their format.
- **The shape of `toolTurns`**, apart from `version`: a round of 0.8 is read as before.

## New and optional

- **Owners and scopes:** `requireOwner`, `requireScope`, `IngestInput.scope`, `AccessOptions.scope`,
  `AskOptions.scope` and `ToolOptions.access` ([Storage](./guides/storage.md#owners-and-scopes)).
- **Application IDs:** `IngestInput.id` and `ifExists` ([Storage](./guides/storage.md#application-ids)).
- **A folder per user and chat:** `FileDocumentStore` with `scopes`, `isSafeScopeSegment` and
  `hashedScopeSegment` ([Storage](./guides/storage.md#files-in-a-folder-per-user-or-per-chat)).
- **The uploads your application keeps:** `original: { ref }`, `originals` and `fileOriginals`
  ([Storage](./guides/storage.md#the-file-your-application-keeps)).
- **Ingest from a path:** `files.ingest({ name, source: { path } })`
  ([library](./reference/library.md#ingestfromsource)).
- **The upload handlers:** `getScope`, `prepareUpload`, `onUploaded`, `onRemoved`, `uploadSpool`
  and `uploadAnswerOf` ([Web app](./guides/web-app.md#uploads-with-createdocumenthandlers)).
- **Missing documents:** `onMissingDocuments` ([ask](./reference/ask.md#missing-documents)).
- **Your users' words:** `errorInfoOf`, with a table in Hebrew
  ([Errors and reliability](./guides/errors-and-reliability.md#your-users-words-errorinfoof)).
- **Looks at pages:** `maxConcurrentPageLooks` and `pageLookWaitMs` ([PDFs](./guides/pdfs.md#view_pages)).
- **Gemini histories:** `fromGeminiContents(contents, { rounds })`
  ([gemini](./reference/gemini.md#fromgeminicontentscontents-options)).
- **The same file twice:** `meta.sha256`, for your app to compare. The library does not dedupe.
- **Tests:** `llm-large-files/testing`, with `fakeModel`, `fakeFetch`, test documents and
  `documentStoreChecks` ([Testing](./reference/testing.md)).
