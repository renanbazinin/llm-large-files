# `llm-large-files/node`

This page lists every export of `llm-large-files/node`: `createDocumentHandlers`, its options, and
the three HTTP handlers it returns, with the request each one expects and every status and body it
can answer; and `writeSseEvents` and `sseMessageOf`, which send the events of a question or an
ingest to a browser as Server-Sent Events. It is for you if your server runs on Node and you want
uploads, look-ups and deletes of documents without writing the routes yourself, or a streamed
answer without writing the stream yourself. How to mount them, what the browser sends, and how to
read the stream in the browser are in the guide [web app](../guides/web-app.md).

```ts
import { createDocumentHandlers, sseMessageOf, writeSseEvents } from "llm-large-files/node";
import type { DocumentHandlerOptions, DocumentHandlers, SseMessage, SseWriteOptions } from "llm-large-files/node";
// What the signatures below use:
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LargeFiles } from "llm-large-files";
```

## Contents

- [`createDocumentHandlers()`](#createdocumenthandlersfiles-options)
- [`DocumentHandlerOptions`](#documenthandleroptions)
- [`DocumentHandlers`](#documenthandlers): [`upload()`](#uploadrequest-response) and
  [its progress as events](#upload-with-progress-accept-textevent-stream),
  [`get()`](#getrequest-response-id), [`remove()`](#removerequest-response-id)
- [How errors are answered](#how-errors-are-answered)
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
| `options` | [`DocumentHandlerOptions`](#documenthandleroptions) | `{}` | Who owns a request. |

**Returns** the three [`DocumentHandlers`](#documenthandlers). It makes no request, reads no
store and throws nothing.

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
};
```

The options of [`createDocumentHandlers()`](#createdocumenthandlersfiles-options).

| Option | Type | Default | What it does |
|---|---|---|---|
| `getOwner` | `(request: IncomingMessage) => string \| undefined \| Promise<string \| undefined>` | none: every request is anonymous | The owner of this request, usually the signed-in user's ID. Called at most once per request. In `upload` it runs after the name is read and before the body: an upload without a name is answered `400` without calling it, and a refused upload is never buffered. An empty owner (`""`, or spaces only) is the server's mistake: the upload is answered `500` `{ "error": "Upload failed (empty owner)." }`, before its body is read. So is an owner from JavaScript that is neither a string nor a finite number (`req.user` in place of `req.user.id`, say): `{ "error": "Upload failed (owner is not a string)." }`. |

What `getOwner` returns decides what each handler does:

| `getOwner` | `upload` | `get` and `remove` |
|---|---|---|
| Returns a string that is not empty or only spaces | The document is ingested with that `owner`. | They pass `{ owner }`: they find the documents of that owner, and those that have no owner. A document of another owner answers as one that does not exist. |
| Returns `undefined`, or there is no `getOwner` | The document has no owner: anyone who has its ID can read it, delete it and ask about it. | They pass no owner: they find only documents that have no owner. |
| Returns `""`, spaces only, or `null` from JavaScript | Answered `500` `{ "error": "Upload failed (empty owner)." }`, before the body is read, and nothing is logged. Such an owner would be one owner shared by every caller without a user: `user?.id ?? ""` gives it for a user who is not signed in. New in 0.6.0: 0.5.0 stored the document with that owner. | As before: they pass it as `owner`, so documents that 0.5.0 stored with the owner `""` stay readable until they expire. |
| Returns, from JavaScript, something that is neither a string nor a finite number: an object such as `req.user`, `true`, `NaN`, an array | Answered `500` `{ "error": "Upload failed (owner is not a string)." }`, before the body is read, and nothing is logged. New in 0.6.0. A finite number is taken as the owner, as before. | They pass it as `owner`, as before. |
| Throws an `Error` whose `status` (or `statusCode`) is a whole number from 400 to 599, as the `http-errors` package makes them | Answered with that status and `{ "error": <the error's message> }`. | The same. |
| Throws anything else | Answered `500` without the error's message, which may name your hosts: `{ "error": "Upload failed." }` (with the code of a Node system error: "Upload failed (ECONNREFUSED)."). | `500`: "The file could not be looked up." or "The file could not be deleted.", the same way. |

The owner is one opaque string, compared as it is. Pass the same string as `owner` to
`askWithFiles` or `askGemini`, and to `files.getMeta`, `files.getOriginal` and `files.delete`. An
owner per chat session (`${userId}/${sessionId}`) works the same way:
[storage](../guides/storage.md). What ownership protects and what it does not:
[security](../security.md).

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
`estimatedTokens`, `pages` (for a PDF or a PPTX), `encoding` and `replacedCharacters` (for a text
file that was not valid UTF-8, since 0.6.0) and `expiresAt`. It holds no `owner`.

#### upload(request, response)

The request:

| Part | What it must be |
|---|---|
| Method and path | Any: the handler does not check them. Route `POST` to it. |
| Body | The file itself, as raw bytes. Not a multipart form: the handler does not parse one. |
| `X-File-Name` header | The file name, URI-encoded with `encodeURIComponent` so that any name survives a header. It is decoded with `decodeURIComponent` (a value that does not decode is used as it is) and trimmed. |
| `?name=` query parameter | The file name, when there is no `X-File-Name`. One of the two is required. |
| `X-File-Type` header | Optional: the MIME type, URI-decoded. |
| `Content-Type` header | The MIME type when there is no `X-File-Type`, unless it starts with `application/octet-stream`. The value is kept whole, parameters included: a `fetch` with a string body sends `text/plain;charset=UTF-8`, and that is the document's `mimeType`. A type with parameters does not set the format, so name the file with its extension. With neither header, the document's `mimeType` is `application/octet-stream`. Send `application/octet-stream`, which JSON and form parsers leave alone. |
| `Content-Length` header | Optional. When it is larger than `maxUploadBytes`, the handler answers `413` before it reads anything. |
| `Accept` header | Optional. When it names `text/event-stream`, the ingest is answered with its progress as Server-Sent Events: see [upload with progress](#upload-with-progress-accept-textevent-stream). New in 0.7.0. |

`files.ingest` then keeps the last path segment of the name, without control characters and
characters that show nothing, up to 255 characters and never cut in the middle of a character, and takes the format
from the name's extension first, then from the MIME type
([`detectFormat`](./library.md#detectformatname-mimetype)).

What it does, in order:

1. Reads the name. Without one, it answers `400`.
2. Calls `getOwner`, and checks what it returned: `""`, spaces only or `null`, or from JavaScript
   a value that is neither a string nor a finite number, is answered `500` (see
   [`DocumentHandlerOptions`](#documenthandleroptions)).
3. Reads the body, up to `files.maxUploadBytes`:
   - a `Uint8Array` or `Buffer` that a framework left in `request.body` (`express.raw()`) is used
     as the file, with the same limit;
   - an object with fields in `request.body` (`express.json()` on a JSON request) is answered
     `400`;
   - otherwise it reads the request stream. Past the limit it stops reading, and answers `413`.
     The rest of the body is not read, and the answer has `Connection: close`: the server closes
     the connection once the answer is sent, rather than read megabytes nobody wants or leave the
     client sending into a connection that is not read. `fetch` and a `node:http` client both
     read the `413`; a `node:http` request that is still writing its body then gets `EPIPE` or
     `ECONNRESET` on the request, after the response. The same holds for every answer sent before
     the body was read to its end (no name, or a `Content-Length` over the limit). A stream that
     another middleware has already read gives no bytes, and the upload is answered `422` as an
     empty file.
4. Ingests it: `files.ingest({ name, bytes, mimeType, owner, signal })`, `mimeType` and `owner`
   only when there are any. The `signal` aborts when the client closes the connection before the
   answer is sent: the ingest stops between two pages or pieces, and nothing is stored. The
   answer then goes to no one.
5. Answers `201` with the document's summary. With `Accept: text/event-stream`, steps 4 and 5 are
   a stream of events instead ([below](#upload-with-progress-accept-textevent-stream)).

The responses:

| Status | Body | When |
|---|---|---|
| `201` | The [`DocumentSummary`](./library.md#documentsummary) of the new document | It was ingested. |
| `400` | `{ "error": "Name the file with an X-File-Name header or a ?name= query parameter." }` | No name. |
| `400` | `{ "error": "The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream." }` | `request.body` is an object with fields. |
| `413` | `{ "error": "The file is larger than the 100 MB upload limit." }`, with your `maxUploadBytes` in its place (`512 KB`, `1000 B`) | `Content-Length`, the bytes read, or the `Buffer` in `request.body` are over `maxUploadBytes`. |
| `422` | `{ "error": <the message of files.ingest> }` | The file cannot be read. The message says why and is meant for the user: "app.log is empty.", "app.log did not contain any text.", "This file looks binary, not text. Attach a text, log, PDF, DOCX, or PPTX file.", "This file is gzip-compressed. Decompress it, then attach the text file inside.", "This file is a ZIP archive. Extract it, then attach the text file you need.", a PDF with no text layer, and a PDF, DOCX or PPTX while the optional dependency that reads it is missing ("Reading PDF files needs the optional dependency "unpdf".") or, for a PDF, cannot run on this Node ("The unpdf installed cannot read PDF files on Node 20 (…). Install unpdf 1.7.0 (npm install unpdf@1.7.0), or run Node 22 or later.", see [defaultExtractors](./library.md#defaultextractors)). A text file is never refused for its encoding. A file past the limits of `createLargeFiles`: more text than `maxTextBytes`, more pages than `maxPdfPages`, longer to read than `ingestTimeoutMs` ("report.pdf took too long to read (more than 2 min). Split it, or save it as plain text, and attach that."), or built to exhaust the server ([every message](../guides/pdfs.md#what-is-refused)). An extractor of your own that throws an `Error` gives its message here too. |
| 400 to 599 | `{ "error": <the error's message> }` | `getOwner`, an extractor or the store threw an error with that `status` or `statusCode`. |
| `500` | `{ "error": "Upload failed (empty owner)." }` | `getOwner` returned `""`, spaces only or `null`. The body is not read. New in 0.6.0. |
| `500` | `{ "error": "Upload failed (owner is not a string)." }` | `getOwner` returned, from JavaScript, something that is neither a string nor a finite number: an object such as `req.user`, `true`, `NaN`, an array. The body is not read. New in 0.6.0. |
| `500` | `{ "error": "Upload failed (ENOSPC)." }` | The store failed with a Node system error, one with a `code` and a `syscall`. Only the code is passed on. |
| `500` | `{ "error": "Upload failed." }` | `getOwner` threw an error without a status, or the request body could not be read: the client went away, or a proxy cut the upload. Node's error for a client that went away has a `code` (`ECONNRESET`) but no `syscall`, so no code is added. An error of either kind that has a `code` and a `syscall` is answered as in the row above, with its code. |
| `500` | `{ "error": "Upload failed." }` | The store failed while it wrote the document, with an error that has no `status` or `statusCode` from 400 to 599 and is not a Node system error (a database driver's error, say). Or `files.ingest` threw a value that is not an `Error` (an extractor of your own that throws a string, say). Such a value with a `code` and a `syscall` gets its code, as in the `ENOSPC` row. The error's own message is not sent. See below. |

A store that fails while it writes is answered `500` "Upload failed." when its error has neither a
`status` (or `statusCode`) from 400 to 599 nor a Node system error's `code` and `syscall`. Its
message may name a host, so it is not sent, and the handlers log nothing. `files.ingest` throws
that error unchanged, and the handler knows it by a mark that `ingest` keeps. The package does not
export the mark, so two paths answer such an error `422` with the store's message, as a file that
cannot be read:

- an `ingest` of your own that throws a new error in place of the store's, such as `ingestInProcess`
  in [deployment](../guides/deployment.md#uploads-and-ingest);
- a route of your own around `files.ingest`, such as the one in
  [web app](../guides/web-app.md#filesingest-and-its-errors) with its `ingestFailure` helper.

In a store of your own, log the failure and throw an error with a `status` (a `503`, say) and a
message without hosts: every path keeps that status. An `ingest` of your own must copy the
`status`, and a system error's `code` and `syscall`, onto the error it throws.
[Storage](../guides/storage.md) has the rules for a store's errors.

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
refusal or a bad owner from `getOwner` (its status, or `500`), a body another middleware parsed
(`400`), and a file over `maxUploadBytes` (`413`). Only a file that passes them is answered `200`
with the event-stream headers of [`writeSseEvents()`](#writesseeventsresponse-events-options) and
a `: keep-alive` comment every 15 seconds.

Each message is `id: <seq>`, `event: <type>` and `data: <the event as JSON>`. The events are those
of [`IngestEvent`](./events.md#ingestevent), stamped with `seq` (1, 2, 3… with no gaps), `runId`
("ing_" and 16 hex digits) and `time` (milliseconds since 1970):

| Event | `data` besides `type`, `seq`, `runId` and `time` | When |
|---|---|---|
| `ingest.start` | `name` (cleaned), `format` (what the name and the type say: a text file can still become a log), `bytes` | First. |
| `ingest.progress` | `stage` (`"decode"`, `"extract"`, `"check"`, `"pictures"`, `"prepare"`, `"index"` or `"store"`), `done`, `total` (absent when not known), `unit` (`"pages"`, `"parts"`, `"bytes"` or `"characters"`) | At most about every 12 ms for a stage, and once more when the stage ends. A stage with nothing to report may send none ([stages and units](./events.md#stages-and-units)). |
| `ingest.finish` | `document`: the [`DocumentSummary`](./library.md#documentsummary), the same fields as the body of a `201` | Last, when the document is stored. |
| `ingest.error` | `error`: `{ "message": …, "status": … }`, the message and status the JSON answer would have | Last, when the ingest fails. |

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
  `{ "message": "This file looks binary, not text. …", "status": 422 }`. A store that failed is
  `{ "message": "Upload failed.", "status": 500 }`, never the store's own message, which may name a
  host. An error with a status keeps it. The error has no `kind` or `name` here, unlike the
  `EventError` of `files.ingest`'s own events.
- **The status is `200` whatever happens next.** Once the stream has started, a failure can only be
  an `ingest.error` event.
- **A client that goes away stops the ingest**, as in step 4: nothing is stored, and nothing more
  is written.
- **The handler still never rejects.**

How to read the stream in the browser: [web app](../guides/web-app.md#upload-with-progress).

#### get(request, response, id)

The request: route `GET` to it; the handler does not check the method. `id` is the document ID,
taken from your route. Nothing else is read but what `getOwner` reads.

| Status | Body | When |
|---|---|---|
| `200` | The [`DocumentSummary`](./library.md#documentsummary) | The document is there, has not expired, and has no owner or the owner `getOwner` returned. |
| `404` | `{ "error": "This file is no longer available." }` | `id` is not a document ID, was never uploaded, has expired or been deleted, or belongs to another owner. |
| 400 to 599 | `{ "error": <the error's message> }` | `getOwner` threw an error with that `status` or `statusCode`. |
| `500` | `{ "error": "The file could not be looked up (EIO)." }` | The store could not be read ([`DocumentStoreError`](./library.md#documentstoreerror)), with the code of the system error behind it, when there is one. |
| `500` | `{ "error": "The file could not be looked up." }` | The store could not be read and gave no system error code, or `getOwner` threw an error without a status. |

#### remove(request, response, id)

The request: route `DELETE` to it; the handler does not check the method. `id` is the document
ID, taken from your route. It deletes the document through `files.delete`, which removes it from
the store: its text, its index and any kept original, as far as your store's `delete` does.

| Status | Body | When |
|---|---|---|
| `200` | `{ "deleted": true }` | The document was deleted. |
| `200` | `{ "deleted": false }` | This owner has no such document: `id` is not a document ID, was never uploaded, has expired or been deleted, or belongs to another owner. Also when the store's `delete` returned `false`. It never answers `404`. |
| 400 to 599 | `{ "error": <the error's message> }` | `getOwner`, or the store's `delete`, threw an error with that `status` or `statusCode`. |
| `500` | `{ "error": "The file could not be deleted (EIO)." }` | The store could not be read, or its `delete` failed with a Node system error, with that error's code. |
| `500` | `{ "error": "The file could not be deleted." }` | The same with no system error code, or `getOwner` threw an error without a status. |

## How errors are answered

The three handlers answer an error by one rule:

- **An error with a status.** An `Error` whose `status`, or else `statusCode`, is a whole number
  from 400 to 599 is answered with that status and `{ "error": <its message> }`. With an empty
  message, the body says what failed instead ("Upload failed.", "The file could not be looked
  up.", "The file could not be deleted."). A `413` is always answered with the size message of
  `upload`.
- **Any other error** is the server's trouble: `500`, with what failed and, for a Node system error
  (one with a `code` and a `syscall`), its code: "Upload failed (ENOSPC).". The error's own message
  is never sent, since it can name paths and hosts of your server.
- **The one exception** is in `upload`: an `Error` from `files.ingest` that has neither a status nor
  a system error's `code` and `syscall` is a file that cannot be read, `422` with its message,
  unless `files.ingest` marked it as an error the store threw while it wrote the document. That
  one, and a thrown value that is not an `Error`, are answered as any other error. An `ingest` of
  your own that throws a new error in its place loses the mark ([upload](#uploadrequest-response)).

Guide: [errors and reliability](../guides/errors-and-reliability.md), for the errors of a question
itself; [web app](../guides/web-app.md), for what to show in the browser.

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
| `run.finish` | `{ type, seq, runId, time, result }`, where `result` holds only `answered`, `text`, `finishReason`, `blockReason`, `steps`, `evidence`, `turns` and `usage`. Not `toolTurns`, `plan`, `budget` or `lastUsage`. |
| `run.error` | `{ type, seq, runId, time, error, partial }`, where `error` is the event's [`EventError`](./events.md#errors-eventerror) and `partial` holds only `steps`, `evidence` and `usage` of the partial result. Without a partial result, `partial` is left out of the JSON. |
| Any other event, ingest events included | The event as it is. |

A field that is `undefined`, such as `finishReason` or `blockReason`, is left out of the JSON.

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
