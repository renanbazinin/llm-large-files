# `llm-large-files/node`

This page lists every export of `llm-large-files/node`: `createDocumentHandlers`, its options, and
the three HTTP handlers it returns, with the request each one expects and every status and body it
can answer. It is for you if your server runs on Node and you want uploads, look-ups and deletes of
documents without writing the routes yourself. How to mount them, what the browser sends, and how
to stream answers are in the guide [web app](../guides/web-app.md).

```ts
import { createDocumentHandlers } from "llm-large-files/node";
import type { DocumentHandlerOptions, DocumentHandlers } from "llm-large-files/node";
// What the signatures below use:
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LargeFiles } from "llm-large-files";
```

## Contents

- [`createDocumentHandlers()`](#createdocumenthandlersfiles-options)
- [`DocumentHandlerOptions`](#documenthandleroptions)
- [`DocumentHandlers`](#documenthandlers): [`upload()`](#uploadrequest-response),
  [`get()`](#getrequest-response-id), [`remove()`](#removerequest-response-id)
- [How errors are answered](#how-errors-are-answered)

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
and a JSON body. When the response has already started (`response.headersSent`), they write
nothing.

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
| `getOwner` | `(request: IncomingMessage) => string \| undefined \| Promise<string \| undefined>` | none: every request is anonymous | The owner of this request, usually the signed-in user's ID. Called at most once per request. In `upload` it runs after the name is read and before the body: an upload without a name is answered `400` without calling it, and a refused upload is never buffered. |

What `getOwner` returns decides what each handler does:

| `getOwner` | `upload` | `get` and `remove` |
|---|---|---|
| Returns a string | The document is ingested with that `owner`. | They pass `{ owner }`: they find the documents of that owner, and those that have no owner. A document of another owner answers as one that does not exist. |
| Returns `undefined`, or there is no `getOwner` | The document has no owner: anyone who has its ID can read it, delete it and ask about it. | They pass no owner: they find only documents that have no owner. |
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
| [`upload(request, response)`](#uploadrequest-response) | `POST`, such as `/api/documents` | Reads the raw body and ingests it as a document of the request's owner. `201` with its summary. |
| [`get(request, response, id)`](#getrequest-response-id) | `GET`, such as `/api/documents/:id` | `200` with the document's summary, or `404`. |
| [`remove(request, response, id)`](#removerequest-response-id) | `DELETE`, such as `/api/documents/:id` | Deletes the document. `200` with `{ "deleted": true }` or `{ "deleted": false }`. |

The summary is a [`DocumentSummary`](./library.md#documentsummary), the fields of a document that
are safe to send to a browser: `id`, `name`, `mimeType`, `format`, `bytes`, `lines`,
`estimatedTokens`, `pages` (for a PDF or a PPTX) and `expiresAt`. It holds no `owner`.

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

`files.ingest` then keeps the last path segment of the name, without control characters, up to
255 characters, and takes the format from the name's extension first, then from the MIME type
([`detectFormat`](./library.md#detectformatname-mimetype)).

What it does, in order:

1. Reads the name. Without one, it answers `400`.
2. Calls `getOwner`.
3. Reads the body, up to `files.maxUploadBytes`:
   - a `Uint8Array` or `Buffer` that a framework left in `request.body` (`express.raw()`) is used
     as the file, with the same limit;
   - an object with fields in `request.body` (`express.json()` on a JSON request) is answered
     `400`;
   - otherwise it reads the request stream. Past the limit it stops keeping the bytes, drains the
     rest so that the client can read the answer, and answers `413`. A stream that another
     middleware has already read gives no bytes, and the upload is answered `422` as an empty file.
4. Ingests it: `files.ingest({ name, bytes, mimeType, owner })`, `mimeType` and `owner` only when
   there are any.
5. Answers `201` with the document's summary.

The responses:

| Status | Body | When |
|---|---|---|
| `201` | The [`DocumentSummary`](./library.md#documentsummary) of the new document | It was ingested. |
| `400` | `{ "error": "Name the file with an X-File-Name header or a ?name= query parameter." }` | No name. |
| `400` | `{ "error": "The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream." }` | `request.body` is an object with fields. |
| `413` | `{ "error": "The file is larger than the 100 MB upload limit." }`, with your `maxUploadBytes` in its place (`512 KB`, `1000 B`) | `Content-Length`, the bytes read, or the `Buffer` in `request.body` are over `maxUploadBytes`. |
| `422` | `{ "error": <the message of files.ingest> }` | The file cannot be read. The message says why and is meant for the user: "app.log is empty.", "app.log did not contain any text.", "This file looks binary, not text. Attach a text, log, PDF, DOCX, or PPTX file.", "This file is gzip-compressed. Decompress it, then attach the text file inside.", "This file is a ZIP archive. Extract it, then attach the text file you need.", a PDF with no text layer, and a PDF, DOCX or PPTX while the optional dependency that reads it is missing ("Reading PDF files needs the optional dependency "unpdf"."). An extractor of your own that throws an `Error` gives its message here too. |
| 400 to 599 | `{ "error": <the error's message> }` | `getOwner`, an extractor or the store threw an error with that `status` or `statusCode`. |
| `500` | `{ "error": "Upload failed (ENOSPC)." }` | The store failed with a Node system error, one with a `code` and a `syscall`. Only the code is passed on. |
| `500` | `{ "error": "Upload failed." }` | `getOwner` threw an error without a status, or the request body could not be read: the client went away, or a proxy cut the upload. Node's error for a client that went away has a `code` (`ECONNRESET`) but no `syscall`, so no code is added. An error of either kind that has a `code` and a `syscall` is answered as in the row above, with its code. |
| `500` | `{ "error": "Upload failed." }` | The store failed while it wrote the document, with an error that has no `status` or `statusCode` from 400 to 599 and is not a Node system error (a database driver's error, say). Or `files.ingest` threw a value that is not an `Error` (an extractor of your own that throws a string, say). Such a value with a `code` and a `syscall` gets its code, as in the `ENOSPC` row. The error's own message is not sent. See below. |

A store that fails while it writes is answered `500` "Upload failed." when its error has neither a
`status` (or `statusCode`) from 400 to 599 nor a Node system error's `code` and `syscall`. Its
message may name a host, so it is not sent, and the handlers log nothing. `files.ingest` throws
that error unchanged, and the handler knows it by a mark that `ingest` keeps. The package does not
export the mark, so two paths answer such an error `422` with the store's message, as a file that
cannot be read:

- an `ingest` of your own that throws a new error in place of the store's, such as `ingestInWorker`
  in [deployment](../guides/deployment.md#uploads-and-ingest);
- a route of your own around `files.ingest`, such as the one in
  [web app](../guides/web-app.md#filesingest-and-its-errors) with its `ingestFailure` helper.

In a store of your own, log the failure and throw an error with a `status` (a `503`, say) and a
message without hosts: every path keeps that status. An `ingest` of your own must copy the
`status`, and a system error's `code` and `syscall`, onto the error it throws.
[Storage](../guides/storage.md) has the rules for a store's errors.

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
