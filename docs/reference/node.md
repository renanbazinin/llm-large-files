# `llm-large-files/node`

This page lists every export of `llm-large-files/node`: `createDocumentHandlers`, its options and
hooks, and the three HTTP handlers it returns, with the request each one expects and every status
and body it can answer; `uploadAnswerOf`, the rule by which they answer an error;
`createIsolatedExtractors`, which reads PDF and Office files in child processes with a
memory limit and a kill timer; and `writeSseEvents` and `sseMessageOf`, which send the events of a
question or an ingest to a browser as Server-Sent Events. It is for you if your server runs on Node
and you want uploads, look-ups and deletes of documents without writing the routes yourself, files
from users read apart from your server, or a streamed answer without writing the stream yourself.
How to mount them, what the browser sends, and how to read the stream in the browser are in the
guide [web app](../guides/web-app.md).

```ts
import { createDocumentHandlers, createIsolatedExtractors, sseMessageOf, uploadAnswerOf, writeSseEvents } from "llm-large-files/node";
import type {
  DocumentHandlerOptions, DocumentHandlers, IsolatedExtractorOptions, IsolatedExtractors, RemovedContext, SseMessage,
  SseWriteOptions, UploadAnswer, UploadedContext, UploadedResult,
} from "llm-large-files/node";
// What the signatures below use:
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DocumentFormat, DocumentMeta, DocumentScope, Extractor, IngestErrorCode, LargeFiles, PdfExtractorOptions } from "llm-large-files";
```

## Contents

- [`createDocumentHandlers()`](#createdocumenthandlersfiles-options)
- [`DocumentHandlerOptions`](#documenthandleroptions), with
  [`getScope`](#what-getscope-returns) and [the hooks](#the-hooks-onuploaded-and-onremoved)
- [`DocumentHandlers`](#documenthandlers): [`upload()`](#uploadrequest-response) and
  [its progress as events](#upload-with-progress-accept-textevent-stream),
  [`get()`](#getrequest-response-id), [`remove()`](#removerequest-response-id)
- [How errors are answered](#how-errors-are-answered):
  [`uploadAnswerOf()`](#uploadansweroferror), [`UploadAnswer`](#uploadanswer)
- [Isolated ingest](#isolated-ingest): [`createIsolatedExtractors()`](#createisolatedextractorsoptions),
  [`IsolatedExtractorOptions`](#isolatedextractoroptions), [`IsolatedExtractors`](#isolatedextractors)
- [Server-Sent Events](#server-sent-events): [`writeSseEvents()`](#writesseeventsresponse-events-options),
  [`sseMessageOf()`](#ssemessageofevent), [`SseMessage`](#ssemessage),
  [`SseWriteOptions`](#ssewriteoptions)

### createDocumentHandlers(files, options?)

```ts
declare function createDocumentHandlers(files: LargeFiles, options?: DocumentHandlerOptions): DocumentHandlers;
```

Upload, look-up and delete handlers for any Node HTTP server: `node:http` and Express; Fastify
through `request.raw` and `reply.raw`, with a pass-through parser for `application/octet-stream`
and `reply.hijack()`; Next.js API routes on the Node runtime, with `bodyParser: false`. The last two
are not tested in this repository: see [web app](../guides/web-app.md#mount-them-in-plain-nodehttp).
Each takes Node's `IncomingMessage` and `ServerResponse`, answers with JSON itself, errors
included, and never rejects, so it can be called without a `catch`.

| Parameter | Type | Default | What it does |
|---|---|---|---|
| `files` | [`LargeFiles`](./library.md#largefiles) | required | The library that uploads are ingested into and documents are looked up in. Its `maxUploadBytes` ([`LargeFilesOptions`](./library.md#largefilesoptions), 100 MB by default) is the upload limit. |
| `options` | [`DocumentHandlerOptions`](#documenthandleroptions) | `{}` | Who owns a request, how many bytes of uploads are held at once, and how long a body may stop arriving. |

**Returns** the three [`DocumentHandlers`](#documenthandlers). It makes no request and reads no
store. It throws:

- a `RangeError` for a `maxPendingUploadBytes` or `uploadIdleTimeoutMs` that is not a number in
  range;
- a `TypeError` when `files` has no `maxUploadBytes` above 0 (a `LargeFiles` of your own, from
  JavaScript, must keep the one of the library it wraps; new in 0.8.2);
- a `TypeError` when `files.access.requireOwner` is on and there is no `getOwner`, or
  `files.access.requireScope` is on and there is no `getScope` (new in 0.9.0). Every request would
  fail otherwise. The message names the option:
  "createDocumentHandlers needs getOwner: the library requires an owner on every call (requireOwner).";
- a `TypeError` when `getScope`, `onUploaded` or `onRemoved` is given and is not a function (new in
  0.9.0).

The handlers do not check the method or the path of a request: route each request to the one you
mean. Every response they write has the header `Content-Type: application/json; charset=utf-8`
and a JSON body, except an upload that asks for its progress as events
([below](#upload-with-progress-accept-textevent-stream)). When the response has already started
(`response.headersSent`), they write nothing.

```ts
import { createServer } from "node:http";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";

const files = createLargeFiles({ store: new MemoryDocumentStore() });

const documents = createDocumentHandlers(files, {
  getOwner: async (request) => {
    const userId = await signedInUser(request); // your sign-in: the user's ID, or undefined
    if (!userId) throw Object.assign(new Error("Sign in to attach files."), { status: 401 });
    return userId;
  },
});

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  const id = /^\/api\/documents\/([^/]+)$/.exec(pathname)?.[1];
  if (pathname === "/api/documents" && request.method === "POST") return void documents.upload(request, response);
  if (id !== undefined && request.method === "GET") return void documents.get(request, response, id);
  if (id !== undefined && request.method === "DELETE") return void documents.remove(request, response, id);
  response.writeHead(404).end();
}).listen(3000);
```

Guide: [web app](../guides/web-app.md), with the Express routes, the browser's `fetch`, and an
upload route of your own for multipart forms or the Fetch API's `Request`.

### `DocumentHandlerOptions`

```ts
type DocumentHandlerOptions = {
  getOwner?: (request: IncomingMessage) => string | undefined | Promise<string | undefined>;
  getScope?: (request: IncomingMessage) => DocumentScope | undefined | Promise<DocumentScope | undefined>;
  onUploaded?: (document: DocumentMeta, context: UploadedContext) => UploadedResult | Promise<UploadedResult>;
  onRemoved?: (id: string, context: RemovedContext) => void | Promise<void>;
  maxPendingUploadBytes?: number;
  uploadIdleTimeoutMs?: number;
};
```

The options of [`createDocumentHandlers()`](#createdocumenthandlersfiles-options).

| Option | Type | Default | What it does |
|---|---|---|---|
| `getOwner` | `(request: IncomingMessage) => string \| undefined \| Promise<string \| undefined>` | none: every request is anonymous | The owner of this request, usually the signed-in user's ID. Called at most once per request. In `upload` it runs after the name is read and before the body: an upload without a name is answered `400` without calling it, and a refused upload is never buffered. An empty owner (`""`, or spaces only) is the server's mistake: the upload is answered `500` `{ "error": "Upload failed (empty owner)." }`, before its body is read. So is an owner from JavaScript that is neither a string nor a finite number (`req.user` in place of `req.user.id`, say): `{ "error": "Upload failed (owner is not a string)." }`. Required when the library has `requireOwner` (new in 0.9.0): an owner of `undefined`, or `null` from JavaScript (`req.user?.id ?? null`), is then answered `401` `{ "error": "Sign in first." }`, on every route, before the body is read. |
| `getScope` | `(request: IncomingMessage) => DocumentScope \| undefined \| Promise<DocumentScope \| undefined>` | none: no scope | New in 0.9.0. The scope of this request, such as `[userId, chatId]` ([`DocumentScope`](./library.md#documentscope)). Called after `getOwner`, at most once per request, before the body is read, on every route. The upload is stored in that scope, and `get` and `remove` find only documents of that scope. Required when the library has `requireScope`. See [what `getScope` returns](#what-getscope-returns). |
| `onUploaded` | `(document: DocumentMeta, context: UploadedContext) => UploadedResult \| Promise<UploadedResult>` | none | New in 0.9.0. Called once an upload is stored, before it is answered: to record the document in your database, for example. What it returns can add fields to the answer. When it throws, the document is deleted and the upload fails. See [the hooks](#the-hooks-onuploaded-and-onremoved). |
| `onRemoved` | `(id: string, context: RemovedContext) => void \| Promise<void>` | none | New in 0.9.0. Called after `remove` deleted a document, before it answers `{ "deleted": true }`. See [the hooks](#the-hooks-onuploaded-and-onremoved). |
| `maxPendingUploadBytes` | `number` | twice `files.maxUploadBytes` (200 MB by default) | The most bytes of uploads these handlers hold at once. An upload is held whole in memory from the moment its body is read until its ingest ends (on the event-stream path too, also after its client went away). Since 0.9.0 its room is given back, and the body the handler read is freed, before `onUploaded` runs: a hook that waits on your database holds neither. Its room is taken before its body is read: its `Content-Length`, or, when it declares none, `maxUploadBytes` (at most this limit) until the body is read, then its size. One that would bring the uploads held past the limit, while another is held, is answered `503` with `Retry-After: 5` before its body is read (the body is drained as for a `413`); one upload alone is always taken. A client that sends its headers and then nothing holds its room until `uploadIdleTimeoutMs` ends it. `Infinity` for no limit, as before 0.8.2. A value that is not a number above 0 throws a `RangeError` when the handlers are made. New in 0.8.2. |
| `uploadIdleTimeoutMs` | `number` | 30,000 | How long the body of an upload may stop arriving. Past it, the upload is answered `408` `{ "error": "The upload stopped arriving: nothing came for 30 s. Send it again." }` with `Connection: close`, the connection is closed, and the upload's room is given back. It bounds the wait for each piece of the body, not the whole upload: Node's `server.requestTimeout` (300 s by default) bounds that. 0 or `Infinity` for no limit. A value below 0 throws a `RangeError`. New in 0.8.2. |

What `getOwner` returns decides what each handler does:

| `getOwner` | `upload` | `get` and `remove` |
|---|---|---|
| Returns a string that is not empty or only spaces | The document is ingested with that `owner`. | They pass `{ owner }`: they find the documents of that owner, and those that have no owner. A document of another owner answers as one that does not exist. |
| Returns `undefined`, or there is no `getOwner` | The document has no owner: anyone who has its ID can read it, delete it and ask about it. Under `requireOwner`: answered `401` `{ "error": "Sign in first." }`, before the body is read (new in 0.9.0). | They pass no owner: they find only documents that have no owner. Under `requireOwner`: `401` `{ "error": "Sign in first." }`. |
| Returns `""`, spaces only, or `null` from JavaScript | Answered `500` `{ "error": "Upload failed (empty owner)." }`, before the body is read, and nothing is logged. Under `requireOwner`, `null` is a request that is not signed in: `401`, as `undefined` (new in 0.9.0). Such an owner would be one owner shared by every caller without a user: `user?.id ?? ""` gives it for a user who is not signed in. New in 0.6.0: 0.5.0 stored the document with that owner. | As before: they pass it as `owner`, so documents that 0.5.0 stored with the owner `""` stay readable until they expire. |
| Returns, from JavaScript, something that is neither a string nor a finite number: an object such as `req.user`, `true`, `NaN`, an array | Answered `500` `{ "error": "Upload failed (owner is not a string)." }`, before the body is read, and nothing is logged. New in 0.6.0. A finite number is taken as the owner, as before. | They pass it as `owner`, as before. |
| Throws an `Error` whose `status` (or `statusCode`) is a whole number from 400 to 599, as the `http-errors` package makes them | Answered with that status and `{ "error": <the error's message> }`. | The same. |
| Throws anything else | Answered `500` without the error's message, which may name your hosts: `{ "error": "Upload failed." }` (with the code of a Node system error: "Upload failed (ECONNREFUSED)."). | `500`: "The file could not be looked up." or "The file could not be deleted.", the same way. |

The owner is one opaque string, compared as it is. Pass the same string as `owner` to
`askWithFiles` or `askGemini`, and to `files.getMeta`, `files.getOriginal` and `files.delete`. To
keep each chat's files apart, give a scope with `getScope` rather than an owner per chat session
([storage](../guides/storage.md)). What ownership protects and what it does not:
[security](../security.md).

#### What `getScope` returns

New in 0.9.0. The scope keeps the documents of one chat apart from those of another, in the
library and, with a scoped [`FileDocumentStore`](./library.md#filedocumentstore), on disk.

| `getScope` | `upload` | `get` and `remove` |
|---|---|---|
| Returns a valid scope: an array of 1 to 8 strings, such as `[userId, chatId]` | The document is stored in that scope (`IngestInput.scope`). | They pass `{ owner, scope }`: a document of another scope answers as one that does not exist, `404` or `{ "deleted": false }`. |
| Returns `undefined` (or `null` from JavaScript), or there is no `getScope` | The document has no scope. Under `requireScope`: answered `500` `{ "error": "Upload failed (no scope)." }`, before the body is read. | They pass no scope: they find only documents without one. Under `requireScope`: `500`, "The file could not be looked up (no scope)." or "The file could not be deleted (no scope).". |
| Returns a scope that is not valid (not an array, a segment with "/" or a control character, more than 8 segments…) | Answered `500` `{ "error": "Upload failed (invalid scope)." }`, before the body is read. It is the server's mistake: the message says nothing more. | `500`, "The file could not be looked up (invalid scope)." or "The file could not be deleted (invalid scope).". |
| Throws an `Error` with a `status` from 400 to 599 | Answered with that status and the error's message, as for `getOwner`. | The same. |
| Throws anything else | `500` "Upload failed.", without the error's message. | `500`, the same way. |

`getScope` runs after `getOwner`: a request refused by `getOwner` never reaches it. The scope a
handler passes is a frozen copy of what `getScope` returned. Pass the same scope to `askWithFiles`.

#### The hooks: `onUploaded` and `onRemoved`

New in 0.9.0. `onUploaded` lets your app record each upload where it keeps its chats, in the same
request, and fail the upload when it cannot:

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";

const files = createLargeFiles({ store: new FileDocumentStore("/data", { scopes: { depth: 2 } }), requireOwner: true, requireScope: true });

const documents = createDocumentHandlers(files, {
  getOwner: (request) => userIdOf(request), // your sign-in
  getScope: (request) => [userIdOf(request), chatIdOf(request)], // safe IDs: lowercase letters, digits, "_" and "-"
  onUploaded: async (document, { owner, scope, clientGone }) => {
    // Throw to fail the upload: the document is deleted, and the error is answered.
    const record = await chats.addFile(scope![1]!, { documentId: document.id, name: document.name, owner, clientGone });
    return { answer: { fileNumber: record.number } }; // in the 201, and in ingest.finish.app
  },
  onRemoved: async (id, { scope }) => {
    await chats.removeFile(scope![1]!, id);
  },
});
```

`onUploaded(document, context)`:

- **When.** Once `files.ingest` has stored the document, and before the upload is answered: before
  the `201`, or before `ingest.finish` on the [event-stream path](#upload-with-progress-accept-textevent-stream).
  The answer waits for it, with no time limit: bound the calls of your own (a database's
  timeout), or a hook that hangs leaves the client waiting. The upload's room
  (`maxPendingUploadBytes`) is given back, and the body the handler read is freed, before the hook is called, so a slow
  hook does not hold up other uploads (new in 0.9.0). It is called once per upload, and never for
  an upload that failed.
- **`document`** is the whole [`DocumentMeta`](./library.md#documentmeta), with its `owner` and
  `scope`: for your server, not for the browser.
- **`context`** is an [`UploadedContext`](#uploadedcontext): the `request` (its body is read; the
  bytes are not in the context, unless a framework left them in `request.body`, as `express.raw()`
  does: those stay until the request ends), the `owner` and the `scope` the handler used, and
  `clientGone`.
- **A client that went away.** The hook is still called, with `clientGone: true`, for a document
  that was stored before the ingest could stop. Nobody gets the answer. Record the document, or
  delete it, as your app needs.
- **What it returns.** Nothing, or `{ answer }`. `answer` is a plain object that JSON can hold. Its
  fields are added to the `201` JSON; the summary's own fields win when a name is the same. On the
  event-stream path it is `ingest.finish`'s `app` field. Anything it returns without an `answer`
  (a database's own result) adds nothing.
- **When it throws,** or returns an `answer` that is not a plain object JSON can hold, the document
  is deleted (best effort: a delete that fails is not told). The upload is then answered as an
  error of `ingest` is ([`uploadAnswerOf`](#uploadansweroferror)): an error with a `status` from
  400 to 599 gives that status and its message, and any other error a `500`
  `{ "error": "Upload failed." }`. On the event-stream path, that is the `ingest.error` event, and
  no `ingest.finish` is sent.

`onRemoved(id, context)` is called after `remove` deleted the document (`files.delete` returned
`true`), and before the answer `{ "deleted": true }`. `context` is a [`RemovedContext`](#removedcontext):
the `request`, the `owner` and the `scope`. It is not called for `{ "deleted": false }`. When it
throws, `remove` answers its error, as for an error of `files.delete`; the document is deleted all
the same, and a second `remove` answers `{ "deleted": false }` without calling it again.

##### `UploadedContext`

```ts
type UploadedContext = {
  request: IncomingMessage;
  owner?: string;
  scope?: DocumentScope;
  clientGone: boolean;
};
```

| Field | What it holds |
|---|---|
| `request` | The upload's request, for its headers and URL. Its body has been read. A body a framework left in `request.body` (`express.raw()`) is still there: it is the framework's. |
| `owner` | What `getOwner` returned, when it returned an owner. |
| `scope` | What `getScope` returned, when it returned a scope (a frozen copy). |
| `clientGone` | `true` when the client went away before the hook was called. |

##### `UploadedResult`

```ts
type UploadedResult = void | { answer?: Record<string, unknown> };
```

##### `RemovedContext`

```ts
type RemovedContext = { request: IncomingMessage; owner?: string; scope?: DocumentScope };
```

### `DocumentHandlers`

```ts
type DocumentHandlers = {
  upload(request: IncomingMessage, response: ServerResponse): Promise<void>;
  get(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
  remove(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
};
```

What [`createDocumentHandlers()`](#createdocumenthandlersfiles-options) returns. Each handler's
promise resolves once the response is written; none rejects.

| Handler | Route it for | What it does |
|---|---|---|
| [`upload(request, response)`](#uploadrequest-response) | `POST`, such as `/api/documents` | Reads the raw body and ingests it as a document of the request's owner. `201` with its summary, or, with `Accept: text/event-stream`, `200` and the ingest's events ending with the summary. |
| [`get(request, response, id)`](#getrequest-response-id) | `GET`, such as `/api/documents/:id` | `200` with the document's summary, or `404`. |
| [`remove(request, response, id)`](#removerequest-response-id) | `DELETE`, such as `/api/documents/:id` | Deletes the document. `200` with `{ "deleted": true }` or `{ "deleted": false }`. |

The summary is a [`DocumentSummary`](./library.md#documentsummary), the fields of a document that
are safe to send to a browser: `id`, `name`, `mimeType`, `format`, `bytes`, `lines`,
`estimatedTokens`, `pages` (for a PDF, a PPTX or an XLSX), `encoding` and `replacedCharacters` (for a text
file that was not valid UTF-8, since 0.6.0) and `expiresAt`. It holds no `owner`.

#### upload(request, response)

The request:

| Part | What it must be |
|---|---|
| Method and path | Any: the handler does not check them. Route `POST` to it. |
| Body | The file itself, as raw bytes. Not a multipart form: the handler does not parse one. |
| `X-File-Name` header | The file name, URI-encoded with `encodeURIComponent` so that any name survives a header. It is decoded with `decodeURIComponent` (a value that does not decode is used as it is) and trimmed. |
| `?name=` query parameter | The file name, when there is no `X-File-Name`. One of the two is required. |
| `X-File-Type` header | Optional: the MIME type, URI-decoded (a value that does not decode is used as it is). |
| `Content-Type` header | The MIME type when there is no `X-File-Type`, unless it starts with `application/octet-stream`. It is taken as it came: since 0.9.0 it is not URI-decoded, so `%0D%0A` in it stays three characters and cannot become a line break (S11). The value is kept whole, parameters included: a `fetch` with a string body sends `text/plain;charset=UTF-8`, and that is the type passed to `files.ingest`. A type with parameters does not set the format, so name the file with its extension. With neither header, the document's `mimeType` is `application/octet-stream`. Send `application/octet-stream`, which JSON and form parsers leave alone. |
| `Content-Length` header | Optional. When it is larger than `maxUploadBytes`, the handler answers `413` before it reads anything. |
| `Accept` header | Optional. When it names `text/event-stream`, the ingest is answered with its progress as Server-Sent Events: see [upload with progress](#upload-with-progress-accept-textevent-stream). New in 0.7.0. |

`files.ingest` then keeps the last path segment of the name, without control characters and
characters that show nothing, up to 255 characters and never cut in the middle of a character, and takes the format
from the name's extension first, then from the MIME type
([`detectFormat`](./library.md#detectformatname-mimetype-bytes)).

What it does, in order:

1. Reads the name. Without one, it answers `400`.
2. Calls `getOwner`, and checks what it returned: `""`, spaces only or `null`, or from JavaScript
   a value that is neither a string nor a finite number, is answered `500` (see
   [`DocumentHandlerOptions`](#documenthandleroptions)). Under `requireOwner`, `undefined` is
   answered `401` (new in 0.9.0).
3. Calls `getScope`, and checks what it returned: a scope that is not valid, or none under
   `requireScope`, is answered `500` ([what `getScope` returns](#what-getscope-returns)). New in
   0.9.0.
4. Makes room for the upload ([`maxPendingUploadBytes`](#documenthandleroptions)): a
   `Content-Length`, or a body in `request.body`, over `maxUploadBytes` is answered `413` first; an
   upload that would bring the uploads held past the limit, while others are held, is answered
   `503`, before its body is read. New in 0.8.2.
5. Reads the body, up to `files.maxUploadBytes`:
   - a `Uint8Array` or `Buffer` that a framework left in `request.body` (`express.raw()`) is used
     as the file, with the same limit;
   - an object with fields in `request.body` (`express.json()` on a JSON request) is answered
     `400`;
   - otherwise it reads the request stream, waiting at most `uploadIdleTimeoutMs` (30 s) for each
     piece; past that it answers `408` and closes the connection (new in 0.8.2). Past the limit it stops keeping the bytes, and
     answers `413` at once. The rest of the body is then read and dropped, up to 8 MB, and the
     answer ends when the body does: a client that is still sending reads the `413`, and can send
     its next request on the same keep-alive connection. A body that goes on more than 8 MB past
     that is cut off: the connection is closed, and a client still sending may then get a reset
     (`ECONNRESET`) instead of the answer. Closing the connection at once was not chosen: some
     systems (Windows) reset a connection closed while data is still arriving, and the client
     never reads the answer. The same holds for every answer sent before the body was read to its
     end (no name, or a `Content-Length` over the limit, whose body Node would otherwise read
     whole). Before 0.7.1 the rest was left unread, and the connection stayed open with the
     client stuck sending into it. The answer to such a body has no `Content-Length`. A stream
     that another middleware has already read gives no bytes, and the upload is answered `422` as
     an empty file.
6. Ingests it: `files.ingest({ name, bytes, mimeType, owner, scope, signal })`, `mimeType`,
   `owner` and `scope` only when there are any. The ingest may first wait its turn
   (`maxConcurrentIngests` of `createLargeFiles`, 2 by default). The `signal` aborts when the
   client closes the connection before the answer is sent: the ingest stops between two pages or
   pieces (or leaves the queue), and nothing is stored. The answer then goes to no one.
7. Gives back the upload's room, then calls `onUploaded` with the stored document
   ([the hooks](#the-hooks-onuploaded-and-onremoved)), also when the client went away. When it
   throws, the document is deleted and the upload is answered with its error. New in 0.9.0.
8. Answers `201` with the document's summary, and the fields of `onUploaded`'s `answer`. With
   `Accept: text/event-stream`, steps 6 to 8 are a stream of events instead
   ([below](#upload-with-progress-accept-textevent-stream)).

The responses:

| Status | Body | When |
|---|---|---|
| `201` | The [`DocumentSummary`](./library.md#documentsummary) of the new document, with the fields of `onUploaded`'s `answer` (the summary's win) | It was ingested, and `onUploaded`, when there is one, did not throw. |
| `401` | `{ "error": "Sign in first." }` | The library has `requireOwner`, and `getOwner` returned `undefined` (or `null`). The body is not read. New in 0.9.0. |
| `404` | `{ "error": "This chat no longer exists." }` | The store threw a [`DocumentScopeError`](./library.md#documentscopeerror) of code `"scope_missing"`: the scope's folder is gone (a scoped `FileDocumentStore` whose session folder your app removed). New in 0.9.0: it was `422` with the error's message. |
| `400` | `{ "error": "Name the file with an X-File-Name header or a ?name= query parameter." }` | No name. |
| `400` | `{ "error": "The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream." }` | `request.body` is an object with fields. |
| `413` | `{ "error": "The file is larger than the 100 MB upload limit." }`, with your `maxUploadBytes` in its place (`512 KB`, `1000 B`) | `Content-Length`, the bytes read, or the `Buffer` in `request.body` are over `maxUploadBytes`. |
| `422` | `{ "error": <the message of files.ingest> }` | The file cannot be read: `files.ingest` threw an [`IngestError`](./library.md#ingesterror), whose `status` is 422. The message says why and is meant for the user: "app.log is empty.", "app.log did not contain any text.", "This file looks binary, not text. Attach a text, log, PDF, Word, PowerPoint, Excel or HTML file.", "This file is gzip-compressed. Decompress it, then attach the text file inside.", "This file is a ZIP archive. Extract it, then attach the text file you need.", an Office file of before 2007 or with a password, a PDF with a password or with no text layer, and a PDF, DOCX, PPTX or XLSX while the optional dependency that reads it is missing ("Reading PDF files needs the optional dependency "unpdf".") or, for a PDF, would stop the server on this Node ("The unpdf installed would stop the whole server at the first PDF file on Node 22, so PDF files are not read. Install unpdf 1.6.1 or later, or run Node 24 or later.", see [defaultExtractors](./library.md#defaultextractors)). A text file is never refused for its encoding. A file past the limits of `createLargeFiles`: more text than `maxTextBytes`, more pages than `maxPdfPages`, longer to read than `ingestTimeoutMs` ("report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that."), or built to exhaust the server ([every message](../guides/pdfs.md#what-is-refused)). With [`createIsolatedExtractors`](#createisolatedextractorsoptions), also a file whose reader ran out of memory or time. A file of code `"unreadable"`, damaged or not of the type its name says, is answered with fixed words: "This file could not be read. It may be damaged, or not of the type its name says." Its own message is a parser's ("Invalid PDF structure."), or that of an extractor of your own that threw an `Error` (an OCR service's, which may name its host): it stays on the error, for your log. New in 0.9.0: that message was sent. |
| `408` | `{ "error": "The upload stopped arriving: nothing came for 30 s. Send it again." }`, with `Connection: close` | The body stopped arriving for `uploadIdleTimeoutMs`. The connection is closed. New in 0.8.2. |
| `503` | `{ "error": "The server is receiving other files right now. Try again in a moment." }`, with `Retry-After: 5` | Uploads are already held, and this one would bring them past `maxPendingUploadBytes`. Answered before the body is read, also to a request with `Accept: text/event-stream`. New in 0.8.2. |
| `503` | `{ "error": "The server is reading other files right now. Try again in a moment." }`, with `Retry-After: 5` | The isolated readers of [`createIsolatedExtractors`](#createisolatedextractorsoptions) are all busy and their queue is full: an `IngestError` of code `"busy"`. The header is its `retryAfterMs` in seconds, rounded up, at least 1. While they shut down (`close()`): "The server is shutting down. Try again in a moment." New in 0.8.0. |
| `409` | `{ "error": "report.pdf: a document with this ID already exists." }` | `files.ingest` threw an `IngestError` of code `"exists"`: a document of the ID the upload was given is there. New in 0.9.0. |
| `503` | `{ "error": "The document could not be stored (ENOSPC). Try again." }`, with `Retry-After: 5` | The store failed while it wrote the document, or did not finish writing it within `ingestTimeoutMs` (code `ETIMEDOUT`): `files.ingest` threw a [`DocumentStoreError`](./library.md#documentstoreerror) of operation `"write"`. The code is shown only when the store's error has one. The store's own message is not sent. New in 0.9.0: it was answered `500` "Upload failed (ENOSPC)." or "Upload failed.", with no `Retry-After`. |
| 400 to 599 | `{ "error": <the error's message> }` | `getOwner`, `getScope`, `onUploaded` or an extractor threw an error with that `status` or `statusCode`. A model's error (`ModelRequestError`) is the exception: it is answered with the status and words of [`errorInfoOf`](./errors-and-retries.md#errorinfooferror), never the provider's. |
| `500` | `{ "error": "Upload failed (empty owner)." }` | `getOwner` returned `""`, spaces only or `null` (`null` is a `401` under `requireOwner`). The body is not read. New in 0.6.0. |
| `500` | `{ "error": "Upload failed (invalid scope)." }` | `getScope` returned a scope that is not valid. The body is not read. New in 0.9.0. |
| `500` | `{ "error": "Upload failed (no scope)." }` | The library has `requireScope`, and `getScope` returned `undefined`. The body is not read. New in 0.9.0. |
| `500` | `{ "error": "Upload failed (owner is not a string)." }` | `getOwner` returned, from JavaScript, something that is neither a string nor a finite number: an object such as `req.user`, `true`, `NaN`, an array. The body is not read. New in 0.6.0. |
| `500` | `{ "error": "Upload failed (ENOSPC)." }` | An extractor of your own failed with a Node system error, one with a `code` and a `syscall`. Only the code is passed on. |
| `500` | `{ "error": "Upload failed." }` | `getOwner` threw an error without a status, or the request body could not be read: the client went away, or a proxy cut the upload. Node's error for a client that went away has a `code` (`ECONNRESET`) but no `syscall`, so no code is added. An error of either kind that has a `code` and a `syscall` is answered as in the row above, with its code. |
| `500` | `{ "error": "Upload failed." }` | `files.ingest` or `onUploaded` threw an error that is none of the above: not an `IngestError`, with no status and no system error's `code` and `syscall`. Its message is not sent: it may name a host, as a database driver's does. A `DocumentScopeError` of code `"scope_invalid"` or `"scope_required"`, the server's mistake, is answered so too. New in 0.9.0: an `Error` of a `LargeFiles` of your own was answered `422` with its message (S12). So is a value that is not an `Error` (an extractor of your own that throws a string, say), as before. |

A store that fails while it writes reaches the handler as a `DocumentStoreError` since 0.9.0, and is
answered `503` with `Retry-After: 5` and its message, which names no path or host. The store's own
error is its `cause`, and the handlers log nothing: log it in your store.

Only an [`IngestError`](./library.md#ingesterror) is answered `422`, since 0.9.0. A `LargeFiles` of
your own that refuses a file must throw one, `new IngestError(code, message)`, as `ingestInProcess`
in [deployment](../guides/deployment.md#uploads-and-ingest) does. A plain `Error` is answered `500`
"Upload failed.", whatever its message. A route of your own around `files.ingest` answers the same
way with [`uploadAnswerOf`](#uploadansweroferror) ([web app](../guides/web-app.md#filesingest-and-its-errors)).
Pass a `DocumentStoreError` on as it is: an `ingest` of your own must not throw a new error in its
place, or must copy its `status` onto the error it throws. [Storage](../guides/storage.md) has the
rules for a store's errors.

#### Upload with progress: `Accept: text/event-stream`

New in 0.7.0. An upload whose `Accept` header names `text/event-stream` is answered with the
ingest's events as Server-Sent Events, so that the page can show how far the server has read the
file: the pages of a PDF, the parts of a DOCX, the writes to the store. Without that header,
nothing changes: `201` and JSON, as above.

The handler reads the `Accept` header this way:

- The header is split at commas into media ranges. One of them must be `text/event-stream`
  itself, in any case, with spaces allowed around it and its parameters
  (`TEXT/Event-Stream ; q=0.5` counts).
- Its `q`, when there is one, must be a number above 0. `q=0` and `q=0.0` keep the JSON answer, and
  so does a `q` that is not a number.
- A wildcard keeps the JSON answer: `*/*` and `text/*` do not ask for events. So does any other
  type, such as `application/json`.
- Other parameters, such as `charset=utf-8`, change nothing.

What stays JSON: every check that runs before the ingest answers as it always did, with its status
and `{ "error": "…" }`, because the stream has not started yet. That is a missing name (`400`), a
refusal or a bad owner from `getOwner` (its status, `401` or `500`), a refusal or a bad scope from
`getScope` (its status, or `500`; new in 0.9.0), a body another middleware parsed
(`400`), a file over `maxUploadBytes` (`413`), an upload that finds no room (`503`, new in 0.8.2),
and a body that stops arriving (`408`, new in 0.8.2). Only a file that passes them is answered `200`
with the event-stream headers of [`writeSseEvents()`](#writesseeventsresponse-events-options) and
a `: keep-alive` comment every 15 seconds.

Each message is `id: <seq>`, `event: <type>` and `data: <the event as JSON>`. The events are those
of [`IngestEvent`](./events.md#ingestevent), stamped with `seq` (1, 2, 3… with no gaps), `runId`
("ing_" and 16 hex digits) and `time` (milliseconds since 1970):

| Event | `data` besides `type`, `seq`, `runId` and `time` | When |
|---|---|---|
| `ingest.start` | `name` (cleaned), `format` (what the name and the type say: a text file can still become a log), `bytes` | First. |
| `ingest.progress` | `stage` (`"decode"`, `"extract"`, `"check"`, `"pictures"`, `"prepare"`, `"index"` or `"store"`), `done`, `total` (absent when not known), `unit` (`"pages"`, `"parts"`, `"bytes"` or `"characters"`) | At most about every 12 ms for a stage, and once more when the stage ends. A stage with nothing to report may send none ([stages and units](./events.md#stages-and-units)). |
| `ingest.finish` | `document`: the [`DocumentSummary`](./library.md#documentsummary), the same fields as the body of a `201`. `app`: the `answer` of `onUploaded`, when it returned one (new in 0.9.0) | Last, when the document is stored and `onUploaded`, when there is one, is done. |
| `ingest.error` | `error`: `{ "message": …, "status": … }`, the message and status the JSON answer would have, and for a file that could not be read `"code"`, the [`IngestError`](./library.md#ingesterror) code (new in 0.8.0). For a store that failed, `"name": "DocumentStoreError"`; for a scope error, `"name": "DocumentScopeError"` and its `"code"`; for documents that are gone, `"name": "DocumentsNotFoundError"` (new in 0.9.0) | Last, when the ingest fails. |

```text
id: 4
event: ingest.finish
data: {"type":"ingest.finish","document":{"id":"doc_f6502d2f94694d709c7db2ec634c8397","name":"b.log","mimeType":"text/plain","format":"log","bytes":81000,"lines":3000,"estimatedTokens":74940,"expiresAt":"2026-11-25T19:09:01.650Z"},"seq":4,"runId":"ing_d19490eacdcd4546","time":1795374541651}
```

- **The stream always ends with one `ingest.finish` or one `ingest.error`.** A file the ingest
  refuses at once (an empty file) still gets `ingest.start`, then `ingest.error`. When an `ingest`
  of your own sends no events at all, the handler adds the last one: then that one event is the
  whole stream, with `seq` 1.
- **`ingest.error` holds what the JSON answer would.** A file that cannot be read gives
  `{ "message": "This file looks binary, not text. …", "status": 422, "code": "not_text" }`, and
  isolated readers that are all busy `{ "message": "The server is reading other files right now. Try
  again in a moment.", "status": 503, "code": "busy" }`, with no `Retry-After` (the headers are
  sent). A store that failed is `{ "message": "The document could not be stored. Try again.", "status": 503 }`
  (since 0.9.0; it was `"Upload failed."` and 500), never the store's own message, which may name a host. An error with a status keeps it. The error has no `kind` here,
  unlike the `EventError` of `files.ingest`'s own events; `code` is new in 0.8.0, so that a page
  can say why in its own words. Since 0.9.0 the library's own errors other than a refused file
  also have their `name`: `"DocumentStoreError"` (with `"name"` added to the 503 above),
  `"DocumentScopeError"` with its `code` (`{ "message": "This chat no longer exists.", "status":
  404, "name": "DocumentScopeError", "code": "scope_missing" }`), and `"DocumentsNotFoundError"`.
  So [`errorInfoOf`](./errors-and-retries.md#errorinfooferror) reads `ingest.error` as it reads the
  error itself; an error that is none of these is `"unknown"` there, with its status.
- **`onUploaded` runs before `ingest.finish`.** The event waits for it. When it throws, the
  document is deleted, and the stream ends with `ingest.error` holding the error's answer instead
  ([the hooks](#the-hooks-onuploaded-and-onremoved)). New in 0.9.0.
- **The status is `200` whatever happens next.** Once the stream has started, a failure can only be
  an `ingest.error` event.
- **A client that goes away stops the ingest**, as in step 6: nothing is stored, and nothing more
  is written. A document that was stored all the same still goes to `onUploaded`, once, with
  `clientGone: true`.
- **The handler still never rejects.**

How to read the stream in the browser: [web app](../guides/web-app.md#upload-with-progress).

#### get(request, response, id)

The request: route `GET` to it; the handler does not check the method. `id` is the document ID,
taken from your route. Nothing else is read but what `getOwner` and `getScope` read. It calls
`files.getMeta(id, { owner, scope })`.

| Status | Body | When |
|---|---|---|
| `200` | The [`DocumentSummary`](./library.md#documentsummary) | The document is there, has not expired, has no owner or the owner `getOwner` returned, and has no scope or the scope `getScope` returned. |
| `404` | `{ "error": "This file is no longer available." }` | `id` is not a document ID, was never uploaded, has expired or been deleted, or belongs to another owner or another scope. |
| `401` | `{ "error": "Sign in first." }` | The library has `requireOwner`, and `getOwner` returned `undefined` (or `null`). New in 0.9.0. |
| 400 to 599 | `{ "error": <the error's message> }` | `getOwner` or `getScope` threw an error with that `status` or `statusCode`. |
| `503` | `{ "error": "The document store could not be read (EIO). Try again." }`, with `Retry-After: 5` | The store could not be read: the message of its [`DocumentStoreError`](./library.md#documentstoreerror), with the code of the system error behind it, when there is one. Since 0.9.0, the status of that error; before, `500` "The file could not be looked up (EIO).". `Retry-After` is new in 0.9.0. |
| `500` | `{ "error": "The file could not be looked up (invalid scope)." }` | `getScope` returned a scope that is not valid; "(no scope)" for none under `requireScope`. New in 0.9.0. |
| `500` | `{ "error": "The file could not be looked up." }` | `getOwner` or `getScope` threw an error without a status. |

#### remove(request, response, id)

The request: route `DELETE` to it; the handler does not check the method. `id` is the document
ID, taken from your route. It deletes the document through `files.delete(id, { owner, scope })`,
which removes it from the store: its text, its index and any kept original, as far as your store's
`delete` does. Then it calls `onRemoved`, when the document was deleted.

| Status | Body | When |
|---|---|---|
| `200` | `{ "deleted": true }` | The document was deleted, and `onRemoved`, when there is one, did not throw. |
| `200` | `{ "deleted": false }` | This owner has no such document in this scope: `id` is not a document ID, was never uploaded, has expired or been deleted, or belongs to another owner or another scope. Also when the store's `delete` returned `false`. It never answers `404`. `onRemoved` is not called. |
| `401` | `{ "error": "Sign in first." }` | The library has `requireOwner`, and `getOwner` returned `undefined` (or `null`). New in 0.9.0. |
| 400 to 599 | `{ "error": <the error's message> }` | `getOwner`, `getScope` or `onRemoved` threw an error with that `status` or `statusCode`. When `onRemoved` threw, the document is deleted all the same. |
| `503` | `{ "error": "The document store could not be read (EIO). Try again." }`, with `Retry-After: 5` | The look-up before the delete could not read the store, as for `get`. Since 0.9.0. |
| `503` | `{ "error": "The document could not be deleted (EIO). Try again." }`, with `Retry-After: 5` | The store's `delete` failed: `files.delete` threw a `DocumentStoreError` of operation `"delete"`, with the code of the store's error when it has one. Since 0.9.0: it was `500` "The file could not be deleted (EIO).". |
| `500` | `{ "error": "The file could not be deleted (invalid scope)." }` | `getScope` returned a scope that is not valid; "(no scope)" for none under `requireScope`. New in 0.9.0. |
| `500` | `{ "error": "The file could not be deleted." }` | `getOwner`, `getScope` or `onRemoved` threw an error without a status. |

## How errors are answered

The three handlers answer an error by one rule, [`uploadAnswerOf`](#uploadansweroferror). Since
0.9.0 it reads the library's errors by their brand (`IngestError.is` and the others), so it also
knows them when another copy of the package made them:

| Error | Status | `{ "error": … }` |
|---|---|---|
| [`IngestError`](./library.md#ingesterror): a file that could not be read | Its `status`: 422, 413 for `"too_large"`, 409 for `"exists"`, 503 for `"busy"` (with `Retry-After`, its `retryAfterMs` in seconds) | Its message, written for the user. A `413` gets the size message of `upload`. A file of code `"unreadable"` gets "This file could not be read. It may be damaged, or not of the type its name says.": its message is a parser's, or an extractor's of your own (new in 0.9.0). |
| [`DocumentStoreError`](./library.md#documentstoreerror): the store failed | 503, with `Retry-After: 5` | Its message, which names what failed and a code, never a path or a host. |
| [`DocumentScopeError`](./library.md#documentscopeerror) `"scope_missing"`: the chat's folder is gone | 404 | "This chat no longer exists." |
| `DocumentScopeError` `"scope_invalid"` or `"scope_required"`: the server's mistake | 500 | What failed: "Upload failed.", "The file could not be looked up.", "The file could not be deleted." |
| A model's error (`ModelRequestError`, or any error with a `kind`) | The status of [`errorInfoOf`](./errors-and-retries.md#errorinfooferror) (429 for `"rate_limit"`, with `Retry-After` when the provider named a wait; 502, 503, 504, 413 or 500 for the others) | `errorInfoOf`'s words ("The model was busy (HTTP 429)."), never the provider's, which can name a project or a key. |
| Any other `Error` whose `status`, or else `statusCode`, is a whole number from 400 to 599 (`http-errors`) | That status. A `503` whose error has a `retryAfterMs` gets `Retry-After`. | Its message, or what failed when it is empty. |
| A Node system error (a `code` and a `syscall`) | 500 | What failed, with the code: "Upload failed (ENOSPC).". |
| Anything else: a plain `Error`, a value that is not an `Error` | 500 | What failed: "Upload failed.". Never the error's own message, which can name paths and hosts of your server. |

Until 0.9.0, `upload` answered any `Error` from `files.ingest` without a status `422` with its
message, as a file that could not be read. A `LargeFiles` of your own whose `ingest` threw a
database driver's error sent its host to the browser (S12). A store that failed was answered
without `Retry-After`.

### uploadAnswerOf(error)

```ts
declare function uploadAnswerOf(error: unknown): UploadAnswer;
```

New in 0.9.0. The answer the upload handler gives an error, by the table above, for a route of your
own that ingests files: a multipart form, the Fetch API's `Request`, a job in the background. It
never throws, and reads the errors of every copy of the package. The upload limit's own message of
a `413` is not in it: say it yourself, or keep the error's.

```ts
import type { ServerResponse } from "node:http";
import { uploadAnswerOf } from "llm-large-files/node";

/** Answers an error of files.ingest as createDocumentHandlers would. */
export function answerUploadError(response: ServerResponse, error: unknown): void {
  const { status, error: message, code, retryAfterMs } = uploadAnswerOf(error);
  if (status >= 500) console.error("An upload failed", error); // the error itself, for your log
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (retryAfterMs !== undefined) headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
  response.writeHead(status, headers).end(JSON.stringify({ error: message, ...(code ? { code } : {}) }));
}
```

### `UploadAnswer`

```ts
type UploadAnswer = { status: number; error: string; code?: IngestErrorCode; retryAfterMs?: number };
```

| Field | What it holds |
|---|---|
| `status` | The HTTP status: 400 to 599. |
| `error` | The message of the JSON body, `{ "error": … }`. Safe to show: it never holds a path, a host or a provider's words. An `"unreadable"` file is told in fixed words, as `errorInfoOf` tells it (new in 0.9.0). What it does hold is the message of an error that has a `status` (one your hooks threw) and of an `IngestError` of another code: keep hosts out of those. |
| `code` | For an `IngestError`: its code (`"too_large"`, `"busy"`…). |
| `retryAfterMs` | How long to wait before trying again, for the `Retry-After` header: 5,000 for a store that failed, an `IngestError`'s own for `"busy"`, a model's for a rate limit. |

To word an error in your users' language rather than with these messages, use
[`errorInfoOf`](./errors-and-retries.md#errorinfooferror) from the main entry.

Guide: [errors and reliability](../guides/errors-and-reliability.md), for the errors of a question
itself; [web app](../guides/web-app.md), for what to show in the browser.

## Isolated ingest

New in 0.8.0. The built-in extractors read a file in your server's process, in its heap: a file
built to exhaust a server (a zip bomb, a PDF whose objects take gigabytes) can run that heap out of
memory and stop every answer streaming on the server. `createIsolatedExtractors` reads PDF, DOCX,
PPTX and XLSX files in child processes instead, each with a heap limit and a kill timer, so that
such a file is refused and the server goes on. A worker thread does not reliably contain running
out of memory; a process does ([Security](../security.md#reading-pdfs-for-pages-and-pictures)).

### createIsolatedExtractors(options?)

```ts
declare function createIsolatedExtractors(options?: IsolatedExtractorOptions): IsolatedExtractors;
```

Starts nothing yet: a child process starts with the first file it is given. Pass its `extractors`
to `createLargeFiles`. Everything else stays as it is: `files.ingest`, the upload handler, events
and progress.

```ts
import { createServer } from "node:http";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { createDocumentHandlers, createIsolatedExtractors } from "llm-large-files/node";

const isolated = createIsolatedExtractors({ maxHeapMb: 512, concurrency: 2 });
const files = createLargeFiles({ store: new FileDocumentStore("./data"), extractors: isolated.extractors });
const documents = createDocumentHandlers(files);
const server = createServer(/* your routes, with documents.upload */).listen(3000);

// A SIGTERM listener replaces Node's own exit: stop the server there too, or it goes on serving.
// (On Windows no SIGTERM arrives: a kill ends the process.)
process.once("SIGTERM", () => {
  server.close(); // no new connections; requests under way go on
  void isolated.close(); // kills the children: the files they read are refused as "busy"
});
```

With nothing else open (a database pool, a timer of your own), the process then exits once the
requests under way end. To let the uploads under way finish before the children are killed, call
`close()` later, when the grace period of your platform runs out, as in
[Stopping a server](../guides/deployment.md#stopping-a-server).

What happens to a file of one of its formats:

1. `files.ingest` calls the isolated extractor, as it would the built-in one. When `concurrency`
   files are being read, the file waits, up to `maxQueue` files; past that it is refused at once
   as `"busy"`.
2. Its bytes are copied to a child process, with its name, MIME type, format and the limits of
   `createLargeFiles` (`maxTextBytes`, `maxPdfPages`, `scannedPdfPages`). The child reads it with the
   built-in extractor of its format, and sends its progress and then its text back.
3. The rest of the ingest runs in your server, as without it: the text is normalized, profiled,
   indexed and stored. A file costs its bytes copied to the child and its text copied back.
4. A child reads one file at a time. It is replaced by a new one after `maxFilesPerChild` files,
   since some parsers keep memory for the life of their process (`@cantoo/pdf-lib` keeps every name
   it reads), and stopped after `idleMs` with nothing to read. An idle child does not keep your
   process alive.

When the ingest's signal aborts (`ingestTimeoutMs`, or a client that went away), the child that
reads the file is killed, and a file that waits leaves the queue. The children load the same
optional dependencies (`unpdf`, `jszip`, `@cantoo/pdf-lib`) the server would, so install them on
the server. Text formats, HTML included, are read in the server, in slices, by default.

The refusals of the children. Each is an [`IngestError`](./library.md#ingesterror), with your
numbers in its message:

| `code` | Message | When |
|---|---|---|
| `"out_of_memory"` | `report.pdf needed more memory than is allowed for reading one file (512 MB). It may be built to exhaust the server, so it is not read. Split it, or save it as plain text, and attach that.` | The child ran out of its heap, `maxHeapMb`: its standard error says so, or it ended with `SIGABRT` or exit code 134. |
| `"timeout"` | `report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that.` | The file took longer than `timeoutMs`. The child is killed, even in the middle of a PDF page that pdf.js reads in one block, which `ingestTimeoutMs` cannot cut short. |
| `"busy"` | `The server is reading other files right now. Try again in a moment.` | `concurrency` files are being read and `maxQueue` wait. `retryAfterMs` is 5,000: the upload handler answers `503` with `Retry-After: 5` ([upload](#uploadrequest-response)). |
| `"busy"` | `The server is shutting down. Try again in a moment.` | `close()` was called while the file waited or was read, or before it was sent. |
| `"unreadable"` | `report.pdf could not be read: its reader stopped (SIGSEGV).`, or `(exit code 1)` | The child ended another way. |
| `"unreadable"` | `report.pdf could not be read: its reader could not be reached.` | The file could not be sent to the child. |

The upload handler answers a file of code `"unreadable"` with fixed words, not these messages
(new in 0.9.0): "This file could not be read. It may be damaged, or not of the type its name says."
The messages stay on the error, for your log.

A child that stops before it is ready to read, so before it was sent the file, is the server's
trouble, not the file's: a `childScript` that is not there, an `execArgv` that Node does not know.
Such a file is refused with an `Error` that is not an `IngestError`, with `status` 500:
`The server could not start a reader for report.pdf (exit code 1).` The upload handler answers it
`500` with that message. The end of the child's standard error, which names paths of the server, is
its `cause` only. The upload handler answers the error itself, so to log the cause there, wrap the
extractors before you hand them to `createLargeFiles`:

```ts
const isolated = createIsolatedExtractors();
const extractors = Object.fromEntries(Object.entries(isolated.extractors).map(([format, extract]) => [
  format,
  (bytes: Uint8Array, input: ExtractInput) => extract!(bytes, input).catch((error: unknown) => {
    if ((error as { status?: unknown }).status === 500) console.error("reader did not start", (error as Error).cause);
    throw error;
  }),
]));
const files = createLargeFiles({ store, extractors });
```

A file the built-in extractor refuses in the child is refused with the same message as in the
server, and the code of its words: a zip bomb or a PDF that would hold the server is `"hostile"`, a
PDF without text `"no_text"`, and so on ([`IngestError`](./library.md#ingesterror)).

**The heap limit.** Each child runs with `--max-old-space-size` set to `maxHeapMb`, and Node adds
its young generation above it: with 512, a heap limit of 560 MB on Node 22, 704 MB on Node
24 and 608 MB on Node 26 ([Deployment](../guides/deployment.md#memory-on-each-server)). The
server's own `NODE_OPTIONS` are not passed to the children: a `--max-old-space-size` there would
replace this one. The rest of its environment is. The limit bounds the heap only: what a parser
unpacks outside it, such as a stream of a PDF, is not bounded by it. For uploads you do not trust,
give the server a memory limit of its own too, such as that of its container
([Security](../security.md#uploads)).

### `IsolatedExtractorOptions`

```ts
type IsolatedExtractorOptions = {
  maxHeapMb?: number;
  timeoutMs?: number;
  concurrency?: number;
  maxQueue?: number;
  formats?: DocumentFormat[];
  pdf?: PdfExtractorOptions;
  maxFilesPerChild?: number;
  idleMs?: number;
  execArgv?: string[];
  childScript?: string | URL;
};
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `maxHeapMb` | `number` | 512 | The heap of each child process, in MB, given as `--max-old-space-size`. A file that needs more is refused (`"out_of_memory"`), and the server goes on. From 1 to 1,048,576, and finite; a fraction is cut to a whole number. Node reads `--max-old-space-size=0` as its default heap, so a value below 1 is refused rather than cut to 0. |
| `timeoutMs` | `number` | 120,000 | The most time one file may take, in milliseconds. Past it, its child is killed and the file refused (`"timeout"`). 0 sets none, and so does a value past what a timer can wait (2,147,483,647 ms, 24.8 days), `Infinity` included, as for `ingestTimeoutMs`. With both at their defaults, the `ingestTimeoutMs` of `createLargeFiles` usually ends the ingest first, and its signal kills the child too. |
| `concurrency` | `number` | 2 | How many files are read at once, each in a child process of its own. At least 1. A library sends the readers at most its `maxConcurrentIngests` files at once (2 by default, since 0.8.2): for more children at work, raise that too. |
| `maxQueue` | `number` | 8 | How many files may wait for a child. Past it, a file is refused at once as `"busy"`. 0: none waits. |
| `formats` | `DocumentFormat[]` | `["pdf", "docx", "pptx", "xlsx"]` | The formats read in child processes: by default those whose parsers a hostile file can exhaust. `extractors` has an entry for each. |
| `pdf` | [`PdfExtractorOptions`](./library.md#pdfextractoroptions) | `{}` | Options of the built-in PDF extractor in the children, as for [`createPdfExtractor`](./library.md#createpdfextractoroptions). |
| `maxFilesPerChild` | `number` | 50 | How many files one child reads before it is replaced by a new one. At least 1. |
| `idleMs` | `number` | 30,000 | A child with nothing to read is stopped after this many milliseconds. 0, or a value past what a timer can wait (`Infinity` included), keeps the children until `close()`. Either way an idle child does not keep your process alive. |
| `execArgv` | `string[]` | `[]` | Further Node options for the children, after the heap limit. |
| `childScript` | `string \| URL` | The `ingest-child.js` shipped next to the module | The script the children run: a path, a `file:` URL, or a string of one. For a bundler that moves files: `import.meta.resolve("llm-large-files/node/ingest-child.js")` gives the one in the installed package ([Bundlers](../guides/deployment.md#nodejs-esm-and-require)). |

A number option that is not a number, NaN, below 0, or 0 where it must be above 0, throws a
`RangeError` when `createIsolatedExtractors` is called: "maxHeapMb must be a number above 0, and is
NaN.", or "timeoutMs must be a number above or equal to 0, and is -1.". So does a `maxHeapMb` below
1, above 1,048,576 (1 TB, past which Node reads the flag wrong) or not finite: "maxHeapMb must be a
number from 1 to 1,048,576 (1 TB), and is 0.5.". A heap below about 32 MB cannot start a reader
that reads ordinary files: every file is then refused.

### `IsolatedExtractors`

```ts
type IsolatedExtractors = {
  extractors: Partial<Record<DocumentFormat, Extractor>>;
  stats(): { running: number; queued: number; children: number };
  close(): Promise<void>;
};
```

| Member | What it is |
|---|---|
| `extractors` | One extractor for each of `formats`, to pass to `createLargeFiles({ extractors })`. To add one of your own for another format: `{ ...isolated.extractors, text: myText }`. |
| `stats()` | The files being read (`running`), the files waiting (`queued`) and the child processes alive (`children`): for a health check or a metric. |
| `close()` | Kills every child process, and refuses the files waiting, those being read and those sent while it runs as `"busy"` ("The server is shutting down. Try again in a moment."). Resolves once the children have exited, also when nothing else keeps your process open, so code after `await isolated.close()` runs. Files sent after that start new children. Call it when the server stops, next to the server's own `close()`: a SIGTERM listener replaces Node's own exit ([above](#createisolatedextractorsoptions)). |

## Server-Sent Events

New in 0.7.0. Two functions send the events of a question (`askStream`, or
[`eventStream`](./events.md#eventstreamrun-options) over `askGemini`) or of an ingest to a browser,
one Server-Sent Events message per event. The events themselves are in the
[events reference](./events.md). The guide [web app](../guides/web-app.md#the-event-stream) has a
whole route and the browser code that reads it.

### writeSseEvents(response, events, options?)

```ts
declare function writeSseEvents<E extends { type: string; seq: number }>(
  response: ServerResponse,
  events: AsyncIterable<E>,
  options?: SseWriteOptions<E>,
): Promise<void>;
```

Sends `events` on `response` as Server-Sent Events, and ends the response after the last one. Any
iterable of objects with a `type` and a `seq` works: an `askStream`, an `eventStream`, or an async
generator of your own.

| Parameter | Type | Default | What it does |
|---|---|---|---|
| `response` | `ServerResponse` | required | The response to write on. Express's `res` is one. |
| `events` | `AsyncIterable<E>` | required | The events. Pass an `askStream` or an `eventStream` itself, not a generator around it: see [when the client goes away](#when-the-client-goes-away). |
| `options` | [`SseWriteOptions<E>`](#ssewriteoptions) | `{}` | The keep-alive, extra headers, what to send for each event, and whether to end the response. |

**What it writes.** When no headers are sent yet, it sets these and writes a `200` at once
(`flushHeaders()`), so the browser's `fetch` resolves before the first event:

| Header | Value |
|---|---|
| `Content-Type` | `text/event-stream; charset=utf-8` |
| `Cache-Control` | `no-cache, no-transform` |
| `Connection` | `keep-alive` |
| `X-Accel-Buffering` | `no` |

Then `headers` from the options are set on top: a name replaces the header above whatever its case
(`cache-control` replaces `Cache-Control`). A header you set on the response before the call
(`res.setHeader`, a CORS middleware) is kept, unless it has one of these names. The status is
always `200`. When the headers are already sent (you called `writeHead` yourself), it writes none
and leaves yours as they are.

Each event then becomes one message:

```text
id: 7
event: tool.start
data: {"type":"tool.start","callId":"call_1","tool":"search_document","args":{"document_id":"doc_3f9c…","query":"timeout","mode":"exact"},"label":"Search app.log (exact) for “timeout”","documentId":"doc_3f9c…","round":1,"seq":7,"runId":"run_8d2c41f07a9e3b65","time":1795374541651}
```

- `id` is the message's `id`, or else the event's `seq`.
- `event` is the message's `event`, or else the event's `type`.
- `data` is the message's `data` as JSON, always on one line. U+2028 and U+2029, which JSON leaves as
  they are, are written `\u2028` and `\u2029`: the same JSON, which a client that splits the stream
  on every Unicode line break still reads whole. `undefined` is sent as `null`.
- A line break in an `id` or an `event` becomes a space, so that it cannot end the field early.

What is sent for an event comes from `map`, [`sseMessageOf()`](#ssemessageofevent) by default. A
`: keep-alive` comment goes out every `heartbeatMs` (15 seconds by default) while the stream is
open; browsers and readers skip comments, and proxies see traffic. None is written while it waits
for the client.

**When the client reads slowly.** When `response.write()` returns false, it waits for `drain`
before it takes the next event. The question or the ingest does not wait: its events wait in
memory, in the `eventStream`, until they are read.

**When it resolves, and when it rejects.**

| What happens | What it does |
|---|---|
| The events end | Ends the response (unless `end: false`) and resolves. |
| The client goes away, or someone else ends the response | Stops reading, calls the iterator's `return()` and resolves. Nothing more is written. |
| The response is already ended or destroyed when it is called | Writes nothing, calls `return()` and resolves. |
| `map` throws | Calls `return()`, ends the response (unless `end: false`), and rejects with that error. |
| The iterable throws | Ends the response (unless `end: false`) and rejects with that error. It does not call `return()` of an iterator that failed. An `askStream` or an `eventStream` never throws: a run that fails ends with its `run.error` or `ingest.error` event, and the promise resolves. |
| A header cannot be set (an invalid name or value in `headers`) | Calls `return()`, destroys the response without a status line, and rejects with that error. |

#### When the client goes away

When the response closes before the end (the user pressed Stop, closed the tab or lost the
connection) or `finish`es because something else ended it, `writeSseEvents` stops reading at once,
even while it waits for the next event, and calls `return()` on the iterator it was reading:

- **An `askStream` or an `eventStream` passed in directly** stops its run at once: its signal
  aborts with an `AbortError` ("The events stopped being read."), the request under way stops, and
  no tool call starts. The stream's `result` rejects with that error, and
  [`partialResultOf(error)`](./ask.md#partialresultoferror) gives what the question found. The
  `run.error` event is not sent: nobody reads.
- **An async generator that wraps one** (to rename events or skip some) is only stopped when it
  next yields. A question that waits on a long model request goes on, and costs, until then. To
  change what is sent, use `map` and pass the stream itself; return `undefined` from `map` to skip
  an event. If you wrap it anyway, stop the run yourself:

```ts
import type { ServerResponse } from "node:http";
import { askStream, type AskEvent, type AskOptions } from "llm-large-files";
import { writeSseEvents } from "llm-large-files/node";

export async function sendWithoutRequests(res: ServerResponse, options: AskOptions): Promise<void> {
  const stream = askStream(options);
  // The generator only notices the client left when it next yields: stop the question yourself.
  res.once("close", () => stream.abort());
  async function* withoutRequests(): AsyncGenerator<AskEvent> {
    for await (const event of stream) if (!event.type.startsWith("request.")) yield event;
  }
  await writeSseEvents(res, withoutRequests());
}
```

The same with `map`, which needs no listener of its own:

```ts
import type { ServerResponse } from "node:http";
import { askStream, type AskOptions } from "llm-large-files";
import { sseMessageOf, writeSseEvents } from "llm-large-files/node";

export async function sendWithoutRequests(res: ServerResponse, options: AskOptions): Promise<void> {
  await writeSseEvents(res, askStream(options), {
    map: (event) => (event.type.startsWith("request.") ? undefined : sseMessageOf(event)),
  });
}
```

### sseMessageOf(event)

```ts
declare function sseMessageOf<E extends { type: string; seq: number }>(event: E): SseMessage;
```

The default `map` of [`writeSseEvents()`](#writesseeventsresponse-events-options): what is sent for
an event. Call it from a `map` of your own to change one event and send the others as they are.

It returns `{ event: <type>, id: <seq>, data }`. The `data` is the event itself, `type`, `seq`,
`runId` and `time` included, for every event but two, which it sends smaller:

| Event | `data` |
|---|---|
| `run.finish` | `{ type, seq, runId, time, result }`, where `result` holds only `answered`, `text`, `finishReason`, `blockReason`, `steps`, `evidence`, `turns`, `usage` and `missing`. Not `toolTurns`, `plan`, `budget` or `lastUsage`. |
| `run.error` | `{ type, seq, runId, time, error, partial }`, where `error` is the event's [`EventError`](./events.md#errors-eventerror) and `partial` holds only `steps`, `evidence`, `usage` and `missing` of the partial result. Without a partial result, `partial` is left out of the JSON. |
| Any other event, ingest events included | The event as it is: a notice's `documentIds` and `ingest.finish`'s `app` included. |

A field that is `undefined`, such as `finishReason`, `blockReason` or `missing`, is left out of the
JSON. `missing` lists the documents a question answered without (`onMissingDocuments: "drop"`); it
is sent since 0.9.0, as `AskResult.missing` is new in 0.9.0.

`toolTurns` are left out even when the question ran with `eventResults: true`: keep them on the
server, from the stream's `result` or from `partialResultOf(error)`
([conversations](../guides/conversations.md)). `eventResults: true` does put each tool result in
its `tool.end` event (`result`), and `sseMessageOf` sends that event as it is: leave
`eventResults` off for a stream to a browser, or drop `result` in a `map` of your own.

```ts
import type { AskEvent } from "llm-large-files";
import { sseMessageOf, type SseMessage } from "llm-large-files/node";

/** run.error in the app's own words; every other event as sseMessageOf sends it. */
export function mapForPage(event: AskEvent): SseMessage {
  if (event.type !== "run.error") return sseMessageOf(event);
  const message = event.error.kind === "rate_limit" ? "The assistant is busy. Try again in a minute." : event.error.message;
  return sseMessageOf({ ...event, error: { ...event.error, message } });
}
```

### `SseMessage`

```ts
type SseMessage = {
  event?: string;
  data: unknown;
  id?: string | number;
};
```

One message, as a `map` returns it.

| Field | Type | Default | What it does |
|---|---|---|---|
| `event` | `string` | the event's `type` | The `event:` field: the name a browser's `EventSource` dispatches on. |
| `data` | `unknown` | required | Any JSON value, sent as JSON on one `data:` line. |
| `id` | `string \| number` | the event's `seq` | The `id:` field. |

### `SseWriteOptions`

```ts
type SseWriteOptions<E> = {
  heartbeatMs?: number;
  headers?: Record<string, string | number | string[]>;
  map?: (event: E) => SseMessage | undefined;
  end?: boolean;
};
```

The options of [`writeSseEvents()`](#writesseeventsresponse-events-options).

| Option | Type | Default | What it does |
|---|---|---|---|
| `heartbeatMs` | `number` | `15000` | Milliseconds between two `: keep-alive` comments, which keep proxies and load balancers from closing a quiet stream. 0 sends none. The timer does not keep the process alive. |
| `headers` | `Record<string, string \| number \| string[]>` | none | Headers to send besides the event-stream ones, or in their place: a name replaces one of them whatever its case. Used only when no headers are sent yet. |
| `map` | `(event: E) => SseMessage \| undefined` | [`sseMessageOf`](#ssemessageofevent) | What to send for an event. Return `undefined` to skip it. A throw stops the run and rejects. |
| `end` | `boolean` | `true` | False keeps the response open after the last event, for something you write after it, or to end it yourself once the question is saved. You must then end it: `if (!res.writableEnded && !res.destroyed) res.end()`. |

Guide: [web app](../guides/web-app.md), with the route, the browser code that reads the events,
keep-alive comments and proxies; [deployment](../guides/deployment.md#streamed-answers-behind-proxies),
for timeouts and buffering on the way to the browser.
