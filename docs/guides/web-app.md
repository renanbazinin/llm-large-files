# Web app

This guide is for you if you add large files to a web chat: the browser uploads files, your server
keeps them and asks the model, and the answer streams back to the page with its progress. It covers
uploads with `createDocumentHandlers` or with a route of your own, the browser side of an upload
with its progress, a Server-Sent Events route that streams the question's events, cancelling, and
reading the stream in the browser. The samples use Express 5 and Gemini on Vertex AI. The approach
depends on neither: with Express 4, catch errors in async routes yourself, and with another model,
call `askStream` (see the end of [the chat route](#a-server-sent-events-route)).

## What you build

Three routes. Their paths are yours: the library mounts none.

| Route | What it does | With |
|---|---|---|
| `POST /api/documents` | Takes one file, extracts and stores its text, and answers with a `DocumentSummary`, or with its progress and then the summary as Server-Sent Events. | `createDocumentHandlers(files).upload`, or `files.ingest` in a route of your own |
| `GET` and `DELETE /api/documents/:id` | Looks a document up, or deletes it. | `get` and `remove` of the same handlers |
| `POST /api/chat` | Asks the model about the chat's documents, and streams the question's events as Server-Sent Events: the tool calls, the answer, the result. | `writeSseEvents` with `askStream`, or with `eventStream` over `askGemini` |

The ID an upload returns belongs to the chat session, not to one message: keep it with the session,
and pass every document of the session on every question. A runnable server with uploads, a
streamed chat route and a page is in the repository: see
[the example server](#the-example-server-examplesserverts).

The samples import `files` and `endpoint` from one module, created once per process:

```ts
// large-files.ts
import { GoogleAuth } from "google-auth-library";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { vertexAi } from "llm-large-files/gemini";

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.LARGE_FILES_DIR ?? "./data/large-files"),
});

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
export const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  model: "gemini-3.8-flash",
  accessToken: async () => (await auth.getAccessToken())!,
});

// An expired document is ignored at once. This frees the space it took.
setInterval(() => {
  files.sweep().catch((error) => console.error("sweep failed", error));
}, 60 * 60 * 1000).unref();
```

Uploads are taken up to 100 MB (`maxUploadBytes`) and kept for 72 hours (`ttlMs`). Every option
is in the [library reference](../reference/library.md#largefilesoptions); where the documents live,
and a layout per user and per chat session, are in [Storage](./storage.md).

## Uploads with `createDocumentHandlers`

`createDocumentHandlers(files, options)` from `llm-large-files/node` returns three handlers that
take Node's `IncomingMessage` and `ServerResponse`. Each answers with JSON itself, errors included,
and never rejects, so you can call it without a `catch`, from `node:http` or from Express 4 or 5.

| Handler | Route it for | What it does |
|---|---|---|
| `upload(request, response)` | `POST` | Asks `getOwner` who is asking, reads the raw body up to `files.maxUploadBytes`, ingests it with that owner, and answers `201` with the document's summary. |
| `get(request, response, id)` | `GET` | Answers `200` with the summary, or `404` when the document is unknown, expired, deleted, or another owner's. |
| `remove(request, response, id)` | `DELETE` | Deletes the document, its text and any kept original, and answers `200` with `{ "deleted": true }`, or `{ "deleted": false }` when this owner had no such document. |

The handlers do not check the method or the path. Route each request to the one you mean.

### Mount them in Express

```ts
// server.ts
import express from "express";
import { createDocumentHandlers } from "llm-large-files/node";
import { files } from "./large-files.js";

export const app = express();
// Your auth middleware goes first. currentUserId(request) stands for it: the signed-in user's ID, or undefined.

const documents = createDocumentHandlers(files, {
  // Uploads become this user's: no other user can read or delete them.
  getOwner: (request) => {
    const userId = currentUserId(request);
    if (!userId) throw Object.assign(new Error("Sign in to attach files."), { status: 401 });
    return userId;
  },
});

// Before any body parser: the body of an upload is the raw file.
app.post("/api/documents", documents.upload);
app.get("/api/documents/:id", (req, res) => documents.get(req, res, req.params.id));
app.delete("/api/documents/:id", (req, res) => documents.remove(req, res, req.params.id));
app.use(express.json());
```

`upload` reads the request body itself. A body parser that runs before it changes what it finds:

- **A `Buffer` in `request.body`**, as `express.raw()` leaves it, is used as the file, with the
  same size limit.
- **An object with fields in `request.body`**, as `express.json()` leaves it for a JSON request, is
  refused with `400`: "The upload body was already parsed by another middleware. Mount the upload
  route before body parsers, or send Content-Type: application/octet-stream."
- **A stream another parser has read and left nothing usable** reads as an empty file: `422`,
  "app.log is empty."

Mount the upload route before your body parsers, and have the browser send
`Content-Type: application/octet-stream`, which JSON and form parsers leave alone.

### Mount them in plain `node:http`

```ts
import { createServer } from "node:http";
import { createDocumentHandlers } from "llm-large-files/node";
import { files } from "./large-files.js";

// currentUserId(request) stands for your auth, as above.
const documents = createDocumentHandlers(files, { getOwner: (request) => currentUserId(request) });

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  const match = /^\/api\/documents(?:\/([^/]+))?$/.exec(pathname);
  if (match) {
    const id: string | undefined = match[1];
    if (request.method === "POST" && id === undefined) return void documents.upload(request, response);
    if (request.method === "GET" && id !== undefined) return void documents.get(request, response, id);
    if (request.method === "DELETE" && id !== undefined) return void documents.remove(request, response, id);
  }
  response.writeHead(404).end();
}).listen(3000);
```

The handlers work wherever you can reach Node's request and response objects, as long as the
framework has not read the body of the upload first and does not send a reply of its own. Other
frameworks need a step for that. These are not tested in this repository:

- **Next.js API routes** (the Pages Router, on the Node runtime):
  `export const config = { api: { bodyParser: false } }`, or Next.js reads the body first and the
  upload reads as empty.
- **Fastify**: add a content-type parser for `application/octet-stream` that leaves the body unread
  (Fastify refuses that type with `415` otherwise), and call `reply.hijack()` before you pass
  `request.raw` and `reply.raw`.
- **Koa**: set `ctx.respond = false` and pass `ctx.req` and `ctx.res`.

A framework that gives you only the Fetch API's `Request` and `Response` needs a route of its own:
[see below](#fetch-api-request-and-response).

### Who owns an upload: `getOwner`

`getOwner(request)` returns the owner of the request: a string, `undefined`, or a promise of
either. The handlers call it before they read the body, so a refused upload is never buffered.

- **A user ID.** The upload is ingested with that owner, and `get` and `remove` pass it on. A
  document of another owner answers exactly as one that does not exist: `404`, or
  `{ "deleted": false }`.
- **`undefined`.** The request is anonymous, and the upload has no owner: anyone who has its ID can
  read it, delete it and ask about it. Use this only for a demo.
- **An empty owner** (`""`, spaces only, or `null` from JavaScript) is the server's mistake, since
  it would be one owner shared by every caller without a user. The upload is answered `500`
  `{ "error": "Upload failed (empty owner)." }` before its body is read. An owner that is neither a
  string nor a finite number (`req.user` in place of `req.user.id`, say) is answered
  `{ "error": "Upload failed (owner is not a string)." }`. `get` and `remove` pass such an owner on
  as before. Where every upload needs a user, throw an error with `status: 401` when there is
  none, as the example above does. Return `undefined` only where anonymous uploads are meant, and
  write `user?.id || undefined` there, not `user?.id ?? ""`: a header that arrives empty gives `""`
  too.
- **A thrown error with a `status` (or `statusCode`) from 400 to 599**, as the `http-errors`
  package makes them: the handler answers with that status and the error's message, as the `401`
  above. Any other error is answered `500`, without its message, which may name your hosts.

The owner is one opaque string, compared as it is. Pass the same string as `owner` to `askGemini`
or `askWithFiles`, and to `files.getMeta`, `files.getOriginal` and `files.delete`. An owner per
chat session (for example `${userId}/${sessionId}`) works the same way, with `getOwner` reading the
session from the request: see [Storage](./storage.md), and [Security](../security.md) for what
ownership does and does not protect.

### What the browser sends

- **The body is the file**, as raw bytes, not a form.
- **`X-File-Name`** names it, URI-encoded with `encodeURIComponent`, so that any name survives an
  HTTP header. A `?name=` query parameter works too. One of them is required. The library keeps the
  last path segment of the name, up to 255 characters and never half of one. Control characters,
  line and paragraph separators and text-direction controls become a space, and most characters
  that show nothing are removed (variation selectors and joiners stay): the name is shown to the
  model and in your UI.
- **`X-File-Type`** is the MIME type, and is optional. Without it, `Content-Type` is taken, unless
  it is `application/octet-stream`. The format comes from the extension first (`.log`, `.md`,
  `.json`, `.csv`, `.pdf`, `.docx`, `.pptx` and a few more), then from the MIME type; anything else
  is text, and text that looks like a log becomes a log. A text file needs no charset: one that is
  not UTF-8 is read in the older encoding of Hebrew, Arabic, Cyrillic, Japanese or Western European
  text that its letters fit, or as UTF-8 with the characters that are not valid counted. None is
  refused for its encoding ([Text encodings](./pdfs.md#text-encodings)).
- **`Content-Type: application/octet-stream`**, so that no body parser takes the upload.

[Upload from the browser](#upload-from-the-browser) has the `fetch` call.

### What it answers

A successful upload answers `201` with a `DocumentSummary`:

```json
{ "id": "doc_3f9c0a7e5b2d4c18a6e0f7b9d1c3e5a7", "name": "app.log", "mimeType": "text/plain",
  "format": "log", "bytes": 5082044, "lines": 60000, "estimatedTokens": 1270511,
  "expiresAt": "2026-11-22T07:43:14.435Z" }
```

`pages` is there too for a PDF, a PPTX or an XLSX (its sheets). For a text file that was not valid
UTF-8, `encoding` names the older encoding it was read in (`"windows-1255"`), and
`replacedCharacters` counts the characters stored as � ([Text encodings](./pdfs.md#text-encodings)).
Your page can show "read as windows-1255", or warn that some characters could not be read and ask
for the file saved as UTF-8.

Everything else is JSON `{ "error": "…" }`, with a message you can show: `400` for a missing name or
a body another middleware already parsed, `413` over `maxUploadBytes`, `422` for a file that cannot
be read, `503` with `Retry-After` when the server holds as many uploads as it takes at once or its
readers are busy (send the file again after `Retry-After` seconds), `408` for a body that stopped
arriving, an error's own status (400 to 599) from `getOwner`, an extractor or your store, and `500`
for a failure of the server, among them `Upload failed (empty owner).` and
`Upload failed (owner is not a string).` ([above](#who-owns-an-upload-getowner)). `get` answers
`404` for a document this owner cannot see, and `get` and `remove` answer `500` when the store
cannot be read. Every status and body is in the
[node reference](../reference/node.md#uploadrequest-response).

A store of your own that fails while it writes an upload can throw an error with a `status` (or
`statusCode`) from 400 to 599 (a `503`, say): the handler answers with that status and the error's
message. A Node system error, with `code` and `syscall`, is answered `500` with its code. Any other
error it throws is answered `500` "Upload failed.", without its message, which may name your hosts.
The handlers log nothing: log the error in your store before you throw it. Behind an `ingest` of
your own that throws a new error in the store's place, as `ingestInProcess` in
[Deployment](./deployment.md#uploads-and-ingest) does, the handler answers `422` with that error's
message, the store's own, unless the error keeps a status, or a code and a syscall. See
[Storage](./storage.md#errors).

## Uploads through your own route

`upload` writes the response itself. Ingest the file in a route of your own when:

- the browser sends a `multipart/form-data` form;
- your server must record the new document in the chat session as it is uploaded;
- your framework gives you the Fetch API's `Request` and `Response`, not Node's objects;
- reading the file takes long enough that the user should not wait on the request (OCR of a long
  scan, for example).

### `files.ingest` and its errors

`files.ingest(input)` extracts, profiles and stores one file, and returns its `DocumentMeta`. Its
input, an [`IngestInput`](../reference/library.md#ingestinput):

| Field | What it is |
|---|---|
| `name` | The file's name. Cleaned as above. |
| `mimeType` | Optional. Used for the format when the extension says nothing. |
| `bytes` | The file, as a `Uint8Array`. A Node `Buffer` is one. |
| `owner` | Optional. The user (or tenant, or chat session) the document belongs to. Every later call must pass the same. A string that is not empty or only spaces: `""` and `null` throw a `TypeError` ([Storage](./storage.md#how-ownership-works)). Check it before you read the upload, as the handler does: the helper below would answer that error `422`. |
| `signal` | Optional. Stops the ingest when it aborts, for example when the uploader goes away: `ingest` throws its `reason`, and nothing is stored. |

Answer the browser with `toDocumentSummary(meta)`, not with `meta`: the summary holds the fields that
are safe to return to a browser, while `meta` also holds the owner, the outline and the log profile.

`ingest` throws an [`IngestError`](../reference/library.md#ingesterror) (a plain `Error` until
0.8.0), with a message written for the user and a `code`, when it cannot take the file:
the cases of the `422` above (an empty, binary or compressed file, no text, a missing optional
dependency, a file past `maxTextBytes` or `maxPdfPages`, one that took longer than
`ingestTimeoutMs`), and a file larger than `maxUploadBytes` ("app.log is larger than the 100 MB
upload limit."). [PDFs and other formats](./pdfs.md#what-is-refused) lists every message. A store
that fails while it writes throws its own error, as it came. This helper tells them apart by the
rule `createDocumentHandlers` uses, with two differences, given below the code:

```ts
// ingest-failure.ts
/**
 * The status and message for an error of files.ingest, by the rule of createDocumentHandlers: an
 * error with a status (or statusCode) keeps it; a Node system error is the server's 500, which
 * names only its code; a value that is not an Error is the server's 500 too; anything else is a
 * file that cannot be read, whose message is written for the user. Unlike the handler, it answers
 * a store's write error that has no status and no system error code with 422 and its message.
 */
export function ingestFailure(error: unknown): { status: number; error: string } {
  const { status, statusCode, code, syscall } = (error ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown; syscall?: unknown };
  const value = typeof status === "number" ? status : statusCode;
  if (error instanceof Error && typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) {
    return { status: value, error: error.message || "Upload failed." };
  }
  if (typeof code === "string" && typeof syscall === "string") return { status: 500, error: `Upload failed (${code}).` };
  if (!(error instanceof Error)) return { status: 500, error: "Upload failed." };
  return { status: 422, error: error.message };
}
```

The first difference is a store's write error with no status and no system error code. The
handler knows it by a mark that `ingest` keeps, and answers it `500` "Upload failed.", without the
store's message. The package does not export the mark, so this helper answers it `422` with the
store's own message, and the routes below send that message to the browser: it may name your hosts.
Give your store's write errors a status and a message of your own ([Storage](./storage.md#errors)),
and the handler and this helper answer them alike, except for the second difference. That one is a
status of `413`: the handler answers it with its upload-limit message ("The file is larger than the
100 MB upload limit."), and this helper with the error's own message.

Check the size before you call `ingest`, and refuse with `413` while you read: `ingest` checks it
too, but only once the whole file is in memory.

### Multipart forms

Any multipart parser works: read the one file into memory, up to `files.maxUploadBytes`, and pass
its bytes, name and type to `ingest`. This sketch uses `busboy`, and records the document in the
chat session as part of the upload:

```ts
// upload-form.ts
import busboy from "busboy";
import type { Request, Response } from "express";
import type { IncomingMessage } from "node:http";
import { toDocumentSummary, type DocumentMeta } from "llm-large-files";
import { ingestFailure } from "./ingest-failure.js";
import { files } from "./large-files.js";

type FormFile = { name: string; mimeType: string; bytes: Uint8Array };

class FormError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The one file of a multipart/form-data request, read up to the upload limit. */
function readFormFile(request: IncomingMessage): Promise<FormFile> {
  const limit = files.maxUploadBytes;
  return new Promise((resolve, reject) => {
    // busboy throws, and the promise rejects, when the request is not multipart/form-data.
    const form = busboy({ headers: request.headers, defParamCharset: "utf8", limits: { files: 1, fileSize: limit + 1 } });
    let file: FormFile | undefined;
    let size = 0;
    form.on("file", (_field, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= limit) chunks.push(chunk);
      });
      stream.on("end", () => {
        // filename is undefined when the form sent the part without one.
        file = { name: info.filename ?? "upload", mimeType: info.mimeType, bytes: Buffer.concat(chunks) };
      });
    });
    form.on("close", () => {
      if (!file) reject(new FormError(400, "Attach a file."));
      else if (size > limit) reject(new FormError(413, "The file is larger than the upload limit."));
      else resolve(file);
    });
    form.on("error", reject);
    request.pipe(form);
  });
}

/**
 * POST /api/chats/:sessionId/documents. addDocument is your app's: it checks that the chat is the
 * user's and records the document ID in it.
 */
export function formUploadRoute(addDocument: (sessionId: string, userId: string, documentId: string) => Promise<void>) {
  return async (req: Request<{ sessionId: string }>, res: Response): Promise<void> => {
    // Who is asking comes first, so a refused upload is not read.
    const userId = currentUserId(req);
    if (!userId) return void res.status(401).json({ error: "Sign in to attach files." });

    let file: FormFile;
    try {
      file = await readFormFile(req);
    } catch (error) {
      const failure = error instanceof FormError ? error : new FormError(400, "Send the file as multipart/form-data.");
      return void res.status(failure.status).json({ error: failure.message });
    }

    let meta: DocumentMeta;
    try {
      meta = await files.ingest({ ...file, owner: userId });
    } catch (error) {
      const failure = ingestFailure(error);
      return void res.status(failure.status).json({ error: failure.error });
    }

    try {
      await addDocument(req.params.sessionId, userId, meta.id);
    } catch (error) {
      // A document that is in no chat is of no use: remove it now rather than when it expires.
      await files.delete(meta.id, { owner: userId }).catch(() => undefined);
      throw error; // Express 5 passes it to your error handler: a 500.
    }
    res.status(201).json(toDocumentSummary(meta));
  };
}
```

- `defParamCharset: "utf8"` reads file names that are not ASCII (Hebrew, Chinese) as the browser
  sent them. busboy's own default is Latin-1.
- `fileSize: limit + 1` makes busboy cut the file one byte past the limit, which is how the size
  check knows it was larger. busboy reads the rest of the body and drops it.
- With `formidable` or `multer`, the shape is the same: let the parser enforce the size, then read
  the file's bytes, name and type into `ingest`. A parser that writes the file to disk first costs
  a write and a read for each upload, which `ingest` does not need.

### Fetch API `Request` and `Response`

Next.js App Router route handlers, and other frameworks built on the Fetch API, hand you a Web
`Request`. This route takes the same raw upload as `createDocumentHandlers`, so the browser code
below works with either:

```ts
// upload-route.ts. In the Next.js App Router, call it from app/api/documents/route.ts, on the Node
// runtime (below). ingestFailure is the helper above.
import { toDocumentSummary } from "llm-large-files";
import { ingestFailure } from "./ingest-failure.js";
import { files } from "./large-files.js";

/** A raw upload, named by its X-File-Name header, for the user `owner`. */
export async function uploadFromRequest(request: Request, owner: string): Promise<Response> {
  const sent = request.headers.get("x-file-name") ?? "";
  let name = sent;
  try {
    name = decodeURIComponent(sent);
  } catch {
    // Not URI-encoded: keep it as it came.
  }
  if (!name.trim()) return Response.json({ error: "Name the file with an X-File-Name header." }, { status: 400 });
  // This route reads the body before ingest: bound the bytes it holds at once yourself, as
  // createDocumentHandlers does with maxPendingUploadBytes (Deployment, Uploads and ingest).

  const tooLarge = { error: "The file is larger than the upload limit." };
  if (Number(request.headers.get("content-length")) > files.maxUploadBytes) return Response.json(tooLarge, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > files.maxUploadBytes) return Response.json(tooLarge, { status: 413 });

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const mimeType = request.headers.get("x-file-type") || (contentType.startsWith("application/octet-stream") ? "" : contentType);
    const meta = await files.ingest({ name, bytes, owner, ...(mimeType ? { mimeType } : {}) });
    return Response.json(toDocumentSummary(meta), { status: 201 });
  } catch (error) {
    const failure = ingestFailure(error);
    return Response.json({ error: failure.error }, { status: failure.status });
  }
}
```

The route itself is a `POST` function in `route.ts`:

```ts
// app/api/documents/route.ts
import { uploadFromRequest } from "../../../upload-route.js";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const owner = await currentUserId(request); // your auth: the signed-in user's ID, or undefined
  if (!owner) return Response.json({ error: "Sign in to attach files." }, { status: 401 });
  return uploadFromRequest(request, owner);
}
```

`request.arrayBuffer()` reads the whole body before you can count it, so a request without
`Content-Length` is held in memory up to whatever your framework or proxy allows. Set a body limit
there too.

The library is written for Node: it imports `node:crypto` and `node:fs`, and uses `Buffer`. Run the
route on the Node runtime; edge runtimes, such as the Next.js Edge runtime, are not supported.

### Long ingests in the background

`ingest` runs while the upload request waits: extraction, profiling, the line index, the store's
writes. That takes seconds for most files. For work that can take minutes, such as OCR of a long
scan ([PDFs](./pdfs.md)), answer at once and ingest afterwards, and raise `ingestTimeoutMs`
(2 minutes by default) above what that work takes. The library has no jobs of its own;
this sketch keeps them in memory, on one server:

```ts
// ingestFailure is the helper above.
import { randomUUID } from "node:crypto";
import { toDocumentSummary, type DocumentSummary, type IngestInput } from "llm-large-files";
import { ingestFailure } from "./ingest-failure.js";
import { files } from "./large-files.js";

export type UploadJob = { state: "working" } | { state: "ready"; document: DocumentSummary } | { state: "failed"; error: string };

// One server. With several, keep the jobs where all of them can read them: your database.
const jobs = new Map<string, { owner: string | undefined; job: UploadJob }>();

/** Starts an ingest, and returns its job ID at once: answer 202 with it. */
export function startIngest(input: IngestInput): string {
  const id = randomUUID();
  const set = (job: UploadJob) => jobs.set(id, { owner: input.owner, job });
  set({ state: "working" });
  files.ingest(input).then(
    (meta) => set({ state: "ready", document: toDocumentSummary(meta) }),
    (error: unknown) => set({ state: "failed", error: ingestFailure(error).error }),
  ).finally(() => setTimeout(() => jobs.delete(id), 60 * 60 * 1000).unref());
  return id;
}

/** GET /api/uploads/:id: the job, when it is this owner's. The browser asks until it is not "working". */
export function uploadJob(id: string, owner: string | undefined): UploadJob | undefined {
  const entry = jobs.get(id);
  return entry && entry.owner === owner ? entry.job : undefined;
}
```

The bytes stay in memory until `ingest` is done with them, so count the uploads in flight when you
size your servers ([Deployment](./deployment.md)).

## Upload from the browser

```ts
import type { DocumentSummary } from "llm-large-files";

/** Sends one file to POST /api/documents. Throws with a message you can show. */
export async function uploadFile(file: File): Promise<DocumentSummary> {
  const send = () => fetch("/api/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      ...(file.type ? { "X-File-Type": file.type } : {}),
    },
    body: file,
  });
  let response = await send();
  // A busy server (503) says when to try again: twice more, then its message is shown.
  for (let attempt = 0; response.status === 503 && attempt < 2; attempt++) {
    const seconds = Number(response.headers.get("retry-after")) || 5;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
    response = await send();
  }
  // An error page of a proxy (a 413 or a 502) is not JSON: the status then makes the message.
  const result = (await response.json().catch(() => ({}))) as Partial<DocumentSummary> & { error?: string };
  if (!response.ok || !result.id) throw new Error(result.error ?? `The upload failed (HTTP ${response.status}).`);
  return result as DocumentSummary; // keep result.id with the chat session
}
```

- The `import type` is erased when the page is built, so the browser loads nothing of the library.
- `encodeURIComponent` is needed: `fetch` refuses a header value with characters outside Latin-1,
  and a file name can have any.
- `fetch` reports no progress of an upload. For a progress bar on large files, send the same
  request with `XMLHttpRequest` and listen to `upload.onprogress`.
- Every file can take this path. A file small enough to fit in the request is sent to the model
  whole anyway; only the larger ones are searched ([How it works](../how-it-works.md)).
- Show `estimatedTokens`, `lines` or `pages` next to the file if you like: they come with the
  summary. So do `encoding` and `replacedCharacters`, for a text file that was not valid UTF-8:
  "read as windows-1255", or "12 characters could not be read: save the file as UTF-8 and attach
  it again".

### Upload with progress

New in 0.7.0. A large PDF or DOCX can take a while to read once it has arrived. Send the same
request with `Accept: text/event-stream`, and `upload` answers with the ingest's events as
Server-Sent Events: how far each stage is, then the summary. The checks that run before the ingest
(the name, `getOwner`, a body already parsed, the size, the room for uploads held at once) still answer with their status and JSON, so
read the response as JSON when it is not `200`:

```ts
// upload-progress.ts: runs in the browser. readEvents is the function in "Reading the events in the browser".
import type { DocumentSummary, IngestEvent, IngestStage } from "llm-large-files";
import { readEvents } from "./chat-client.js";

const STAGES: Record<IngestStage, string> = {
  decode: "Decoding",
  extract: "Reading",
  check: "Checking the pages",
  pictures: "Finding pictures",
  prepare: "Preparing the text",
  index: "Indexing",
  store: "Saving",
};

/** Sends one file to POST /api/documents and reports how far the server has read it. Throws with a message you can show. */
export async function uploadWithProgress(file: File, onProgress: (text: string) => void): Promise<DocumentSummary> {
  const response = await fetch("/api/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      ...(file.type ? { "X-File-Type": file.type } : {}),
      Accept: "text/event-stream",
    },
    body: file,
  });
  // A missing name, a refused owner or a file too large is still an HTTP error, in JSON.
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `The upload failed (HTTP ${response.status}).`);
  }
  let document: DocumentSummary | undefined;
  let failure: string | undefined;
  await readEvents(response, (data) => {
    const event = data as IngestEvent;
    if (event.type === "ingest.progress") {
      const of = event.total !== undefined ? ` of ${event.total.toLocaleString()}` : "";
      onProgress(`${STAGES[event.stage]}: ${event.done.toLocaleString()}${of} ${event.unit}…`);
    } else if (event.type === "ingest.finish") {
      document = event.document; // the summary a 201 answer holds: keep document.id with the chat session
    } else if (event.type === "ingest.error") {
      failure = event.error.message; // the message the JSON answer would have
    }
  });
  if (document) return document;
  throw new Error(failure ?? "The upload stopped before the file was read. Attach it again.");
}
```

- **The events start once the whole file has arrived.** They report the server's work on it, not
  the upload of its bytes: for that, use `XMLHttpRequest` and `upload.onprogress`, as above.
- **`ingest.progress`** has a `stage` (`decode`, `extract`, `check`, `pictures`, `prepare`,
  `index`, `store`), `done`, `total` when it is known, and a `unit` (`pages`, `parts`, `bytes`,
  `characters`): see [stages and units](../reference/events.md#stages-and-units). A stage reports
  at most about every 12 ms, and once more when it ends. Not every file goes through every stage,
  and a stage with nothing to report may send nothing.
- **The stream ends with one `ingest.finish` or one `ingest.error`.** `ingest.finish` holds in
  `document` the summary a `201` holds. `ingest.error` holds in `error` the `message` and `status`
  the JSON answer would have: `422` and "This file looks binary, not text. …", say. A store's own
  message is never in it.
- **Closing the page stops the ingest**, as it does for a JSON upload: nothing is stored.
- **A wildcard does not ask for events.** `Accept: */*` or `text/*` keeps the `201` and JSON, and so
  does `q=0`. The rules are in the [node reference](../reference/node.md#upload-with-progress-accept-textevent-stream).

## Streaming the answer

A question can take minutes: searches, reads, a whole-file read of many parts, then the answer.
There are two ways to show it in the page as it goes:

- **The event stream.** New in 0.7.0. Everything the question does comes as a typed event, in
  order: the plan, each model request, each tool call with its progress and outcome, the text, and
  the result. `writeSseEvents` sends the events to the browser as Server-Sent Events, one message
  per event. Use it for a new page.
- **The three callbacks** `onText`, `onActivity` and `onStep`. They get the same strings at the
  same moments as in 0.6.0, and a route of your own writes them to the browser. Code that uses
  them needs no change: see [the three callbacks](#the-three-callbacks-the-older-way).

### The event stream

`askStream(options)` takes the [`AskOptions`](../reference/ask.md#askoptions) of `askWithFiles` and
returns the question's events as an async iterable:

```ts
import { askStream } from "llm-large-files";

const stream = askStream({ files, model, documentIds, messages, owner });
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
  if (event.type === "run.error") console.log(event.error.message);
}
const result = await stream.result; // what askWithFiles returns, toolTurns included
```

| Member | What it is |
|---|---|
| The iterable | The events, in order. It ends after the last one. |
| `result` | A promise of what `askWithFiles` returns, `toolTurns` included. It rejects with the question's error. Awaiting it is optional: it never goes unhandled. |
| `abort(reason?)` | Stops the question. The events end after its `run.error`. |

`askGemini` builds its models from the endpoint, explorer included. To stream it, wrap it in
`eventStream`, which does the same for any function that takes an `onEvent` and a `signal`:

```ts
import { eventStream, type AskEvent, type AskResult } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";

const stream = eventStream<AskEvent, AskResult>(
  (onEvent, signal) => askGemini({ files, endpoint, documentIds, messages, owner, streamText: true, onEvent, signal }),
  { signal: deadline }, // optional: a signal of yours that stops the question too
);
```

What to know about the stream:

- **One run, in order.** Every event has its `type`, a `seq` (1, 2, 3… with no gaps), the `runId`
  ("run_" and 16 hex digits, or the `runId` you pass) and its `time` (milliseconds since 1970).
  `run.start` comes first. Exactly one event comes last: `run.finish` when the question returns,
  `run.error` when it throws, an abort included. Nothing comes after it.
- **The question runs at once.** Its events wait in memory until you read them. Read them once: a
  second loop over the same stream throws a `TypeError`.
- **Leaving the loop stops the question.** A `break`, a `return` or a throw in the loop aborts it.
- **The loop never throws.** A question that fails ends the loop after its `run.error` event. Read
  the error there, or await `result`, which rejects with it.
- **Errors in events are safe to show.** An event's error is an `EventError`: `message`, and `kind`,
  `status` and `name` when there are any. A model error is told by its kind and status ("The model
  was busy (HTTP 429)."), never in the provider's words, which can name projects, hosts or keys. A
  storage error is told by its code. The provider's words stay on the error that `result` rejects
  with, for your log.
- **Events hold no text of your documents.** They hold labels, steps, the arguments the model sent,
  and the lines and pages each call showed (`evidence`), but not what the tools returned: `tool.end`
  has no `result`, and the result in `run.finish` and `run.error` has no `toolTurns`.
  `eventResults: true` puts both in. Leave it off for a stream to a browser.
- **The answer streams.** `askStream` asks the model for the answer as it is written: `streamText`
  is true unless you set it to false. `askGemini` and `askWithFiles` with `onEvent` alone do not:
  `streamText` defaults to true only when `onText` is set, so the text of each reply then comes in
  one `text` event once the reply is in. Pass `streamText: true`, as above. More in
  [when the text streams](#when-the-text-streams).
- **The callbacks still work.** Pass `onText`, `onActivity` and `onStep` too, and they get what they
  always did. Each `notice` event says where its message went in the callbacks (`display`).
- **Evidence names its call.** Each entry of `result.evidence` has a `callId` ("call_3"): the call
  whose `tool.end` carries the same entry. A list of sources can point back to the list of tools.
- **A listener that throws ends the question** with that error, as a callback that throws always
  did. `askStream` gives each event to the stream before your own `onEvent`, so the stream still
  gets the last one. Changed in 0.7.0: a throw from `onActivity` or `onEvent` while a whole-file
  read runs now ends the question too; 0.6.0 made it that tool call's error and went on.

Every event and its fields are in the [events reference](../reference/events.md#askevent), with
the order they come in and how the callbacks map to them.

### A Server-Sent Events route

The route below streams one question of a chat with `writeSseEvents` from `llm-large-files/node`.
It writes the event-stream headers, sends each event as one message, writes a keep-alive comment
every 15 seconds, and stops the question when the browser goes away:

```ts
// chat-route.ts
import type { Request, Response } from "express";
import { eventStream, partialResultOf, type AskEvent, type AskResult, type ChatTurn, type ToolTurn, type UsageTotals } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";
import { sseMessageOf, writeSseEvents } from "llm-large-files/node";
import { endpoint, files } from "./large-files.js";

/** Your app's chats (in MongoDB, say). Conversations has what to keep and how to build the history. */
export type ChatStore = {
  /** The chat's documents and its history so far, when the chat is this user's. */
  load(sessionId: string, userId: string): Promise<{ documentIds: string[]; history: Array<ChatTurn | ToolTurn> } | undefined>;
  /** Keeps a question with its tool rounds, its answer when there is one, and what it used. */
  save(sessionId: string, turn: { question: string; toolTurns: ToolTurn[]; answer?: string; usage: UsageTotals }): Promise<void>;
};

const TOO_LONG = "The question took too long. Ask again, or ask about less.";

/** POST /api/chat with { sessionId, question }. */
export function chatRoute(chats: ChatStore) {
  return async (req: Request, res: Response): Promise<void> => {
    // Everything that can be refused is refused before the stream starts, with a status.
    const userId = currentUserId(req);
    if (!userId) return void res.status(401).json({ error: "Sign in to ask." });
    const { sessionId, question } = (req.body ?? {}) as { sessionId?: unknown; question?: unknown };
    if (typeof sessionId !== "string" || typeof question !== "string" || !question.trim()) {
      return void res.status(400).json({ error: "Send a sessionId and a question." });
    }
    const chat = await chats.load(sessionId, userId);
    if (!chat) return void res.status(404).json({ error: "No such chat." });

    // The question runs at once; its events wait until writeSseEvents reads them.
    const deadline = AbortSignal.timeout(15 * 60 * 1000);
    const stream = eventStream<AskEvent, AskResult>(
      (onEvent, signal) => askGemini({
        files,
        endpoint,
        owner: userId, // the owner the documents were uploaded with
        documentIds: chat.documentIds, // every document of the chat, on every question
        messages: [...chat.history, { role: "user", text: question }],
        streamText: true, // the answer as it is written: without onText, askGemini asks for it only when told
        onEvent,
        signal, // aborts at the deadline, when the browser goes away, or on stream.abort()
      }),
      { signal: deadline },
    );

    // From here on the answer is a stream: its status is 200, whatever happens next.
    await writeSseEvents(res, stream, {
      end: false, // the response stays open until the question is kept, below
      // Every event as it is, but the deadline in words of your own.
      map: (event) => sseMessageOf(
        event.type === "run.error" && deadline.aborted ? { ...event, error: { ...event.error, message: TOO_LONG } } : event,
      ),
    });

    // The result with its toolTurns comes from here, never from the events.
    let result: AskResult | undefined;
    try {
      result = await stream.result;
    } catch (error) {
      // The provider's own words are on this error: for your log, not for the page.
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("A question failed", error);
      // What a failed or stopped question read and paid for, so that asking again need not search again.
      result = partialResultOf(error);
    }
    if (result) {
      await chats.save(sessionId, {
        question,
        toolTurns: result.toolTurns,
        ...(result.answered ? { answer: result.text } : {}),
        usage: result.usage,
      }).catch((error: unknown) => console.error("could not keep the question", error));
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  };
}
```

Mount it after `express.json()`, next to the upload routes:

```ts
// server.ts, after the upload routes. chats is your ChatStore.
app.post("/api/chat", chatRoute(chats));
app.listen(3000);
```

What the route does, and why:

- **It refuses before it streams.** A missing user, a bad body or an unknown chat gets a status and
  a JSON error. Once `writeSseEvents` has sent the `200`, an error can only be a `run.error` event.
- **`writeSseEvents` does the stream's work.** It writes `200` with
  `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`,
  `Connection: keep-alive` and `X-Accel-Buffering: no`, and flushes them at once, so the browser's
  `fetch` resolves and the page can show that the question is under way. It waits when the browser
  reads slower than the events come, and it resolves when the events end or the browser has gone.
  Every option is in the [node reference](../reference/node.md#writesseeventsresponse-events-options).
- **The events go as they are.** The error in `run.error` is already safe to show. The `map` only
  puts the deadline in words of its own: without it, the page would read the deadline's own message
  ("The operation was aborted due to timeout"). For your own words for every error, map on
  `event.error.kind` (a [`ModelErrorKind`](../reference/errors-and-retries.md#modelerrorkind)) and
  `event.error.name` ("DocumentsNotFoundError", "DocumentStoreError"), as the
  [example server](#the-example-server-examplesserverts) does.
- **The question is kept before the stream ends.** `end: false` keeps the response open after
  `run.finish` while `chats.save` runs, and the route ends it after. A page that lets the user ask
  again only once the stream has closed, as the one [below](#reading-the-events-in-the-browser)
  does, never sends a follow-up before the last question is in the history.
- **The tool rounds come from `stream.result`**, or from `partialResultOf(error)` when the question
  failed or was stopped: see [where to keep `toolTurns`](#where-to-keep-toolturns).

With another model, call `askStream({ files, model, explorer, ... })` in place of `eventStream` and
`askGemini`: it takes the same `owner`, `documentIds`, `messages` and `signal`, streams the text
without `streamText`, and its `result` is the same.

### What the browser receives

Each message is one event: its `seq` as the `id:`, its `type` as the `event:`, and the event itself
as JSON in one `data:` line. The `data` carries `type`, `seq`, `runId` and `time` too, so a page
can read the `data` alone:

```text
id: 7
event: tool.start
data: {"type":"tool.start","callId":"call_1","tool":"search_document","args":{"document_id":"doc_3f9c…","query":"timeout","mode":"exact"},"label":"Search app.log (exact) for “timeout”","documentId":"doc_3f9c…","round":1,"seq":7,"runId":"run_8d2c41f07a9e3b65","time":1795374541651}
```

Between events, a comment line `: keep-alive` comes every 15 seconds. The events a page uses:

| `type` | Fields to read | Show it as |
|---|---|---|
| `run.start` | `models` (`answer`, and `explorer` when there is one), `documentIds` | Optional: the question is under way. |
| `plan` | `inline` and `searchable`: the documents sent whole and those searched, each with `id`, `name`, `format`, `estimatedTokens` and `pages` | Optional: "Searching app.log". It comes again when the question is planned again. |
| `tool.start` | `callId`, `tool`, `args`, `label`, `documentId`, `round` | A new line in the list of tools, and the status line: `label` and "…". |
| `tool.progress` | `callId`, `stage` (`"map"` or `"reduce"`), `done`, `total`, `message` | A whole-file read: a counter on that call's line, and the status line: `message` and "…". |
| `tool.end` | `callId`, `outcome` (`"ok"`, `"error"`, `"refused"`, `"already_shown"`, `"not_run"`), `ms`, `step`, `evidence`, `error` | The call's line, done: `step`, with a mark for the outcome. `step` is what `onStep` gets; it is absent for `"not_run"` and for a call ended because its turn failed. |
| `text` | `delta`, `requestId` | The answer, growing. The deltas add up to the result's `text`. |
| `notice` | `code`, `message`, `display` | `display` `"activity"`: the status line. `"step"`: a line in the list. `"none"`: notices earlier versions did not show, such as `budget_reached` and `blocked`; show them if you like. |
| `retry` | `requestId`, `attempt`, `delayMs`, `error`, `message` | The status line: `message` ("The model did not answer (HTTP 503). Trying again in 2 s…"). |
| `request.start`, `request.end` | `requestId`, `role`, `purpose`, `model`, `turn`; `ms`, `outcome`, `usage`, `error` | Usually not shown. For your logs and timings. |
| `run.finish` | `result` (below) | The summary under the answer. Last. |
| `run.error` | `error`, `partial` (below) | The error, and the answer so far marked as cut off. Last. |

`writeSseEvents` sends every event as it is, except the last one, which it sends smaller
([`sseMessageOf`](../reference/node.md#ssemessageofevent)):

| Event | `data` besides `type`, `seq`, `runId` and `time` |
|---|---|
| `run.finish` | `result`: `answered`, `text`, `finishReason` and `blockReason` (when there are any), `steps`, `evidence`, `turns` and `usage`. Not `toolTurns`, `plan`, `budget` or `lastUsage`. |
| `run.error` | `error`: `message`, and `kind`, `status` and `name` when there are any. `partial`: `steps`, `evidence` and `usage` of what the question found before it failed. `partial` is left out when there is none. |

Labels, steps and messages are English sentences made by the library, one line of plain text each,
with file names and the model's search words in them. Render them as plain text, never as markdown
or HTML ([the three callbacks](#the-three-callbacks-the-older-way) says how they are cleaned).

### Where to keep `toolTurns`

On the server. The tool rounds of a question hold the text the tools returned, and the next
question of the chat needs them in its history ([Conversations](./conversations.md)). The events
do not carry them, so take them from what the question returns:

- `await stream.result`, when the question returned;
- `partialResultOf(error)`, when `stream.result` rejected: what a failed or stopped question read
  and paid for, so that asking again need not search again.

`eventResults: true` would put them in `run.finish`, but `writeSseEvents` leaves them out of what it
sends anyway, and it would put each tool result in its `tool.end`, which it does send. Keep
`eventResults` off in a route to a browser.

### When the browser goes away

The user presses Stop, closes the tab or loses the connection, and the response closes.
`writeSseEvents` sees it at once, even while it waits for the next event: it stops reading, calls
the stream's `return()`, and resolves. For an `askStream` or an `eventStream` passed in directly,
that aborts the question: the request under way stops, and no other tool call starts.
`stream.result` then rejects with an `AbortError` ("The events stopped being read."), and
`partialResultOf` of it gives what the question found, which the route above keeps. Nothing more is
written: the `run.error` of the stopped question is not sent.

That holds only for the stream itself. An async generator that wraps it, to rename or skip events,
is stopped only when it next yields, and a question waiting on a long model request goes on, and
costs, until then. To change what is sent, use `map`, and return `undefined` from it to skip an
event. If you do wrap the stream, stop the question yourself:
`res.once("close", () => stream.abort())`. The
[node reference](../reference/node.md#when-the-client-goes-away) has both.

### Reading the events in the browser

`EventSource` sends only `GET` requests without a body, so read a `POST` stream with `fetch`. This
reader splits the stream into messages, joins the `data:` lines of each, and parses them as JSON:

```ts
// chat-client.ts: runs in the browser.
import type { AskEvent, EventResult } from "llm-large-files";

/** The result in run.finish, as sseMessageOf sends it. */
export type FinishResult = Pick<EventResult, "answered" | "text" | "finishReason" | "blockReason" | "steps" | "evidence" | "turns" | "usage">;
/** What run.error keeps of what the question found. */
export type PartialResult = Pick<EventResult, "steps" | "evidence" | "usage">;
/** The data of each message: the event itself, with run.finish and run.error made smaller. */
export type ChatEvent =
  | Exclude<AskEvent, { type: "run.finish" | "run.error" }>
  | (Omit<Extract<AskEvent, { type: "run.finish" }>, "result"> & { result: FinishResult })
  | (Omit<Extract<AskEvent, { type: "run.error" }>, "partial"> & { partial?: PartialResult });

/**
 * Calls `on` with the data of each message of an event stream, until the stream ends. Comments
 * (keep-alive) are skipped, and so is a message that is not JSON.
 */
export async function readEvents(response: Response, on: (data: unknown) => void): Promise<void> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    // A message ends at a blank line. Lines end in "\n" ("\r\n" through some proxies), never in
    // U+2028 or U+2029: split on those two endings only.
    let end: RegExpExecArray | null;
    while ((end = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, end.index);
      buffer = buffer.slice(end.index + end[0].length);
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
        .join("\n");
      if (!data) continue; // a comment: ": keep-alive"
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        console.error("An event could not be read", error); // one bad message does not stop the others
        continue;
      }
      on(parsed);
    }
  }
}
```

A page that uses it builds four things from the events: a status line that the next activity
replaces, a list of tool calls with their outcome and the progress of whole-file reads, the answer
as it streams, and a summary when the question ends. It has a Stop button too:

```ts
// chat-page.ts: runs in the browser. readEvents and ChatEvent are above.
import type { Evidence, ToolOutcome } from "llm-large-files";
import { readEvents, type ChatEvent, type FinishResult } from "./chat-client.js";

const statusView = document.querySelector<HTMLElement>("#status")!;
const toolsView = document.querySelector<HTMLUListElement>("#tools")!;
const answerView = document.querySelector<HTMLElement>("#answer")!;
const summaryView = document.querySelector<HTMLElement>("#summary")!;
const askButton = document.querySelector<HTMLButtonElement>("#ask")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;

const MARKS: Record<ToolOutcome, string> = { ok: "✓", error: "✗", refused: "–", already_shown: "↺", not_run: "–" };

/** "app.log lines 120-180, 300", or the pages of a PDF. */
const sourceOf = (evidence: Evidence) => {
  const ranges = evidence.lines ?? evidence.pages;
  const where = ranges?.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ");
  return `${evidence.document ?? evidence.documentId}${where ? ` ${evidence.lines ? "lines" : "pages"} ${where}` : ""}`;
};

/** One line under the answer: what was read, and what it took. */
function summaryOf(result: FinishResult): string {
  if (!result.answered) {
    return result.blockReason ? "This question was blocked by the model's safety filters." : "No answer this time. Ask again, or ask more precisely.";
  }
  const sources = [...new Set(result.evidence.map(sourceOf))];
  return `${sources.length ? `Sources: ${sources.join("; ")}. ` : ""}${result.usage.requests} model requests.`;
}

export async function showAnswer(sessionId: string, question: string): Promise<void> {
  const controller = new AbortController();
  stopButton.onclick = () => controller.abort(); // the server sees the connection close, and stops the question
  askButton.disabled = true;
  statusView.textContent = "Asking…";
  toolsView.replaceChildren();
  answerView.textContent = "";
  summaryView.textContent = "";
  const calls = new Map<string, { label: string; item: HTMLLIElement }>();
  const listItem = (text: string, className?: string) => {
    const item = document.createElement("li");
    item.textContent = text; // text, never HTML: labels hold file names and the model's search words
    if (className) item.className = className;
    toolsView.append(item);
    return item;
  };
  let answer = "";
  let ended = false;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, question }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      statusView.textContent = body.error ?? `The server answered HTTP ${response.status}.`;
      return;
    }
    await readEvents(response, (data) => {
      const event = data as ChatEvent;
      switch (event.type) {
        case "tool.start":
          calls.set(event.callId, { label: event.label, item: listItem(`… ${event.label}`) });
          statusView.textContent = `${event.label}…`;
          break;
        case "tool.progress": {
          // A whole-file read: how many of its parts are read, or of its notes combined.
          const call = calls.get(event.callId);
          if (call) call.item.textContent = `… ${call.label} (${event.done}/${event.total})`;
          statusView.textContent = `${event.message}…`;
          break;
        }
        case "tool.end": {
          const call = calls.get(event.callId);
          if (call) {
            call.item.textContent = `${MARKS[event.outcome]} ${event.step ?? call.label}`;
            call.item.className = event.outcome;
          }
          break;
        }
        case "notice":
          if (event.display === "activity") statusView.textContent = event.message;
          if (event.display === "step") listItem(`· ${event.message}`);
          break;
        case "retry":
          statusView.textContent = event.message;
          break;
        case "text":
          answer += event.delta;
          answerView.textContent = answer;
          statusView.textContent = "";
          break;
        case "run.finish":
          ended = true;
          statusView.textContent = "";
          summaryView.textContent = summaryOf(event.result);
          if (!event.result.answered) answerView.textContent = "";
          break;
        case "run.error":
          ended = true;
          statusView.textContent = event.error.message; // safe to show: never the provider's own words
          if (answer) answerView.textContent = `${answer}\n\n(The answer was cut off.)`;
          break;
      }
    });
    if (!ended) statusView.textContent = "The connection closed before the answer was complete. Ask again.";
  } catch {
    statusView.textContent = controller.signal.aborted ? "Stopped." : "The connection was lost. Ask again.";
    if (answer) answerView.textContent = `${answer}\n\n(The answer was cut off.)`;
  } finally {
    // Only once the stream has closed: by then the server has kept the question.
    askButton.disabled = false;
  }
}
```

- **The page reads `data` alone.** Every message's data is the event, with its `type`, so the
  `event:` line is not needed. `import type` is erased when the page is built: the browser loads
  nothing of the library.
- **Line breaks.** The reader splits on `"\n"` and `"\r\n"` only. JSON may hold U+2028 and U+2029,
  which some readers take for line breaks; `writeSseEvents` writes them as `\u2028` and `\u2029`,
  so even such a reader gets each message whole.
- **`JSON.parse` is in a `try`.** A message the page cannot read, from a proxy or a server of
  another version, is logged and skipped, and the stream goes on.
- **The text.** Without an explorer model, the text can hold a remark the model wrote before it
  called a tool ("I'll search the log for the failed job."); the next reply's text then starts
  after `"\n\n"`. With an [explorer model](./explorer-model.md), it is only the answer.
- **`answered: false`** means the text is no answer: a blocked prompt, a reply cut off before its
  first word, or an answer that had no text even when it was asked for once more. Show your own
  message in its place, as above, and do not store it as the assistant's turn (the route does not).
- **`run.error` after some text** leaves the text that arrived. Keep it, mark it as cut off, and let
  the user ask again.
- **Ask is enabled again only when the stream has closed**, not at `run.finish`: the route keeps the
  question before it ends the response.
- **Stop** aborts the `fetch`. The connection closes, the server stops the question, and the
  reader rejects with an `AbortError`.
- **A connection that drops** ends the stream without `run.finish` or `run.error`, or makes a read
  fail. Either way the page says so: the question cannot be resumed.

### When the text streams

Whether the model is asked for the answer as it is written is `streamText`. It defaults to true when
`onText` is set and in `askStream`, and to false otherwise: an `onEvent` alone does not change how
the model is asked. When the text does not stream, each reply reaches `onText` and the `text`
events once it is in: in one piece with `streamText` off, and with it on but an endpoint that
cannot stream, in one piece too, or from Gemini, one piece for each text part. When it does,
a reply that fails after its first piece of text is not sent again: the question throws, and
`partialResultOf(error).text` holds what was shown.

With `streamText` on, whether the provider streams:

- **`askGemini` and `gemini()`**: when the endpoint has a `streamUrl`. `vertexAi()` and
  `geminiApi()` set one; an endpoint of your own for a gateway needs it
  ([Gemini and Vertex AI](./vertex-and-gemini.md)).
- **`openAiCompatible()`**: unless `stream: false`
  ([OpenAI-compatible endpoints](./openai-compatible.md)).
- **`anthropic()`**: every chat request, unless `stream: false`, with `streamText` on or off; with
  it off, the text is passed on once the reply is in ([Claude](./anthropic.md)).

An OpenAI-compatible server or a Claude gateway that answers without a stream is read in one piece.
An explorer model's requests are never shown: `gemini()` and `openAiCompatible()` do not stream
them, and `anthropic()` streams them (unless `stream: false`) without showing any of it. So between
the question and the first word, a page can get nothing but tool and request events for minutes:
an explorer at work, a model that thinks before it writes (up to `firstByteTimeoutMs`, 600 s by
default, for each request). Plan the stream for that silence
([below](#keep-alive-comments-and-proxies)).

### Keep-alive comments and proxies

A load balancer or a proxy in front of your server may close a response on which nothing arrived
for a while, or hold the events back in a buffer. A question can be silent for minutes (an explorer
at work, a model that thinks, a whole-file read between two parts), so:

- **Write a comment line now and then.** A line that starts with `:` is a comment in Server-Sent
  Events: it keeps the connection busy, and the browser drops it. `writeSseEvents` writes
  `: keep-alive` every 15 seconds; `heartbeatMs` changes that, and 0 turns it off.
- **Turn off buffering for the route.** `writeSseEvents` sends `X-Accel-Buffering: no`, which asks
  nginx to pass each event on at once, and `Cache-Control: no-cache, no-transform`: the Express
  `compression` package skips a response marked `no-transform`, and so does a proxy that honors it.
  A compression middleware that ignores it still holds events back; leave this route out of it.
  `headers` adds headers of your own, or replaces these.
- **Allow for the whole question in the proxy's timeout.** Keep-alives do not help against a limit
  on the total time of a response. The route's own deadline (15 minutes above) should end first.

Proxies, timeouts and several servers are in [Deployment](./deployment.md).

### Cancelling

A question stops when its signal aborts. The route above stops it in two cases:

- **The browser goes away**: the user pressed Stop, closed the tab, or lost the connection.
  `writeSseEvents` sees the response close and calls the stream's `return()`, which aborts the
  question ([above](#when-the-browser-goes-away)). A route of your own without `writeSseEvents`
  listens on the response, not on the request: the request's own `close` fires once its body has
  been read, long before the answer is done.
- **Your deadline passes**: `AbortSignal.timeout`, passed as the `signal` option of `eventStream`
  (or of `askStream`). A question has no time limit of its own.

The question stops at once, even with an adapter of your own that does not look at the signal:
nothing more is sent, and text that such an adapter sends later is not shown. `usage` in
`partialResultOf(error)` is what was counted when it stopped; a request still running then may be
billed by the provider, and is not counted.

What aborting stops, what a stopped question throws, how to tell your deadline from a user who
left, and why to abort with an `Error` rather than a string are in
[Errors and reliability](./errors-and-reliability.md#an-overall-deadline).

There is no resuming: a question whose stream was cut off is over, and the user asks again. With the
tool rounds of the stopped question kept, as the route does, the new question starts from what it
had found.

### The three callbacks: the older way

The callbacks of earlier versions still work, unchanged: the same strings, at the same moments. A
route that sends them to the browser names its own events and writes its own keep-alive. For a new
page, use [the event stream](#the-event-stream), which says the same and more, as data.

`askGemini` and `askWithFiles` take three callbacks for a UI:

| Callback | Receives | Show it as |
|---|---|---|
| `onText(delta)` | Pieces of the text the user is meant to read, as they arrive. | The answer, growing. |
| `onActivity(text)` | What the question is doing now. | A status line that the next one replaces. |
| `onStep(text)` | A step that is done. | A list that grows. The same lines are in `result.steps`. |

**`onText`.** The pieces add up to `result.text`. They hold:

- the answer;
- without an explorer model, also any remark the model writes before it calls a tool ("I'll search
  the log for the failed job."). The text of the next reply then starts after `"\n\n"`. An
  `activity` or `step` after some text means that text was such a remark;
- with an [explorer model](./explorer-model.md), only the text of the model that answers: nothing
  the explorer writes is shown.

Thoughts are never passed on. Once text of a reply was shown, that reply is not sent again if it
fails: the question throws, and `partialResultOf(error).text` holds what was shown.

**`onActivity`.** One line, ending in "…":

| When | For example |
|---|---|
| A document must be searched | "Too large to read at once: app.log. Searching instead…" |
| A tool call starts | "Search app.log (keywords) for “timeout”…", "Read app.log lines 120-180…", "Overview of app.log…", "Look at report.pdf pages 2-3…" |
| A whole-file read goes on | "Reading app.log: part 3 of 12…", "Combining notes on app.log (round 1): 2 of 4…" |
| A request is sent again | "The model did not answer (HTTP 503). Trying again in 2 s…", "The model could not be reached. Trying again…", "The model's reply was cut off on its way. Trying again…", "The model sent nothing for too long. Trying again…" |
| The answer is asked for | "Writing the answer…" |

**`onStep`.** One line for each tool call that ran, with what it found: "Search app.log (exact) for
“timeout” — 12 matching lines", "Read app.log lines 120-180", "Look at report.pdf pages 12-14". A
call answered from an earlier result ends in " — already shown above", and one that failed in
" — failed: " and the reason. A call to a tool that does not exist reads
`Call “do_magic” — failed: Unknown tool “do_magic”.`, its name cut at 64 characters. The loop adds
its own lines too, such as "Older tool results were shortened to make room in the request" or "The
model's answer was empty: it was asked again". Every tool, and `toolResultSummary`, which writes
what a step found, are in the [tools reference](../reference/tools.md).

Activities and steps are English sentences, made by the library, with file names and the model's
search words in them. Each is one line of plain text: a line break, a tab or another control
character in what the model sent becomes one space, text-direction controls, zero-width spaces
and tag characters are dropped (variation selectors and joiners are not), `](` becomes `] (` so
that a markdown link or picture in a query stays text, and a query is cut at 80 characters and a
task at 100. They still quote the model's words, HTML tags and web addresses included. Render
them as plain text, never as markdown or HTML. For a UI in another language, show your own words
for each event ("Searching your files…"), and build a list of sources from `result.evidence` when
the answer is done: it is the structured record of what each call showed, the document and the
lines or pages.

The same strings are in the events: an activity is a `tool.start` `label`, a `tool.progress`
`message` or a `retry` `message` (the first two without the "…"), or a `notice` with `display`
`"activity"`; a step is a `tool.end` `step`, or a `notice` with `display` `"step"`.

**Whole-file reads.** `askGemini` and `askWithFiles` take no `onProgress`. The progress of a
whole-file read, a `ProgressEvent` (`kind` "map" or "reduce", `message`, `done`, `total`), reaches
`onActivity` as its `message` followed by "…". The event stream tells it apart by call, as
`tool.progress` events with the `callId` of the read. `ProgressEvent` and `onProgress` are for a
loop of your own: `files.tools(documents, { onProgress })`
([Your own adapter and loop](./own-adapter-and-loop.md)).

### A route with the three callbacks

The route below is the one earlier versions of this guide had. It streams one question of a chat
as Server-Sent Events that it writes itself, from the callbacks. Its event names and their data are
its own, not those of the event stream: `text` here is a string, where the event stream's `text` is
an event with a `delta`. Each event is `event: <name>` and `data: <JSON>`:

| Event | `data` | When |
|---|---|---|
| `text` | A string: a piece of the answer. | As it streams, one event for each `onText` call. |
| `activity` | A string. | Each `onActivity` call. |
| `step` | A string. | Each `onStep` call. |
| `done` | `{ answered, blockReason, finishReason, steps, evidence, usage }` | Last, when the question ended without an error. |
| `error` | `{ kind, message, incomplete }` | Last, when the question failed. |

Every 15 seconds the route also writes a comment line, `: keep-alive`, which the browser ignores.

```ts
// chat-route-callbacks.ts
import type { Request, Response } from "express";
import {
  DocumentsNotFoundError,
  DocumentStoreError,
  errorKindOf,
  partialResultOf,
  type ChatTurn,
  type ModelErrorKind,
  type ToolTurn,
  type UsageTotals,
} from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";
import { endpoint, files } from "./large-files.js";

/** Your app's chats (in MongoDB, say). Conversations has what to keep and how to build the history. */
export type ChatStore = {
  /** The chat's documents and its history so far, when the chat is this user's. */
  load(sessionId: string, userId: string): Promise<{ documentIds: string[]; history: Array<ChatTurn | ToolTurn> } | undefined>;
  /** Keeps a question with its tool rounds, its answer when there is one, and what it used. */
  save(sessionId: string, turn: { question: string; toolTurns: ToolTurn[]; answer?: string; usage: UsageTotals }): Promise<void>;
};

const MESSAGES: Record<ModelErrorKind, string> = {
  context_overflow: "This chat is too long for the model. Start a new chat, or ask about fewer files.",
  quota: "The assistant is not available right now.",
  rate_limit: "The assistant is busy. Try again in a minute.",
  timeout: "The model took too long to answer. Try again.",
  unreachable: "The model could not be reached. Try again.",
  server: "The model could not answer just now. Try again.",
  auth: "Something went wrong on our side. Try again later.",
  invalid: "Something went wrong on our side. Try again later.",
};

/** The error event: a kind the page can act on, and words for the user. The provider's message stays in your log. */
function errorEvent(error: unknown, pastDeadline: boolean): { kind: string; message: string } {
  if (pastDeadline) return { kind: "deadline", message: "The question took too long. Ask again, or ask about less." };
  if (error instanceof DocumentsNotFoundError) return { kind: "documents_not_found", message: "A file of this chat is no longer available. Attach it again." };
  if (error instanceof DocumentStoreError) return { kind: "store", message: "Your files could not be read just now. Try again in a moment." };
  const kind = errorKindOf(error);
  return kind ? { kind, message: MESSAGES[kind] } : { kind: "other", message: "Something went wrong on our side. Try again later." };
}

/** POST /api/chat with { sessionId, question }. */
export function chatRouteWithCallbacks(chats: ChatStore) {
  return async (req: Request, res: Response): Promise<void> => {
    // Everything that can be refused is refused before the stream starts, with a status.
    const userId = currentUserId(req);
    if (!userId) return void res.status(401).json({ error: "Sign in to ask." });
    const { sessionId, question } = (req.body ?? {}) as { sessionId?: unknown; question?: unknown };
    if (typeof sessionId !== "string" || typeof question !== "string" || !question.trim()) {
      return void res.status(400).json({ error: "Send a sessionId and a question." });
    }
    const chat = await chats.load(sessionId, userId);
    if (!chat) return void res.status(404).json({ error: "No such chat." });

    // From here on the answer is a stream: its status is 200, whatever happens next.
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no", // nginx: pass each event on at once
    });
    res.flushHeaders();
    const write = (chunk: string) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    };
    const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const keepAlive = setInterval(() => write(": keep-alive\n\n"), 15_000);

    // Stop the question when the browser goes away, or at your deadline.
    const userLeft = new AbortController();
    res.on("close", () => userLeft.abort());
    const deadline = AbortSignal.timeout(15 * 60 * 1000);

    try {
      const result = await askGemini({
        files,
        endpoint,
        owner: userId, // the owner the documents were uploaded with
        documentIds: chat.documentIds, // every document of the chat, on every question
        messages: [...chat.history, { role: "user", text: question }],
        signal: AbortSignal.any([userLeft.signal, deadline]),
        onText: (delta) => send("text", delta),
        onActivity: (text) => send("activity", text),
        onStep: (text) => send("step", text),
      });
      await chats.save(sessionId, {
        question,
        toolTurns: result.toolTurns,
        ...(result.answered ? { answer: result.text } : {}),
        usage: result.usage,
      });
      send("done", {
        answered: result.answered,
        blockReason: result.blockReason,
        finishReason: result.finishReason,
        steps: result.steps,
        evidence: result.evidence,
        usage: result.usage,
      });
    } catch (error) {
      // What a failed question read and paid for: keep it, so that asking again need not search again.
      const partial = partialResultOf(error);
      if (partial) {
        await chats.save(sessionId, { question, toolTurns: partial.toolTurns, usage: partial.usage })
          .catch((saveError: unknown) => console.error("could not keep a failed question", saveError));
      }
      if (userLeft.signal.aborted) return; // nobody is reading
      console.error("A question failed", error);
      send("error", { ...errorEvent(error, deadline.aborted), incomplete: Boolean(partial?.text) });
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  };
}
```

It is mounted as the route above is: `app.post("/api/chat", chatRouteWithCallbacks(chats))`.

What the route does, and why:

- **It refuses before it streams**, as the route above does. Once `writeHead(200)` is sent, an
  error can only be an `error` event.
- **Every `data` is JSON.** A piece of text can hold a blank line, which would end an event if it
  were written as it is. `JSON.stringify` keeps each event on one `data:` line.
- **`flushHeaders()` sends the 200 at once**, so the browser's `fetch` resolves and the page can
  show that the question is under way. It writes its own keep-alive every 15 seconds, and stops
  the question when the response closes ([cancelling](#cancelling)).
- **The history comes from your store**, with the tool rounds of earlier questions in their place,
  and the question is kept with its `toolTurns`, and with its answer only when there is one
  (`answered`). What to keep, and why, is in [Conversations](./conversations.md). It is kept
  before `done` is sent, so a follow-up question always finds it.
- **`done` carries the result** the page needs: `answered` to know whether the text is an answer,
  `blockReason` and `finishReason` to say why not, `steps`, `evidence` for sources, and `usage`.
  Leave out what your users should not see. Counting `usage` per user or session is in
  [Costs and limits](./costs-and-limits.md).
- **`error` carries a kind and words for the user.** `kind` is the error's
  [`ModelErrorKind`](../reference/errors-and-retries.md#modelerrorkind) for a model error, and a
  name of the route's own otherwise. The messages follow
  [Errors and reliability](./errors-and-reliability.md), which says what each error means. The
  provider's message is in the error the question throws: it goes to the log, never to the page.
  `incomplete` is true when some of the answer was already shown: the page keeps that text and
  marks it as cut off.

With another model, call `askWithFiles({ files, model, ... })` in place of `askGemini`: it takes the
same `owner`, `documentIds`, `messages`, `signal` and callbacks, and returns the same result.

### Reading that route's stream

The browser side of the route with the three callbacks reads its `text`, `activity`, `step`,
`done` and `error` events with `fetch`:

```ts
// chat-client-callbacks.ts: runs in the browser.
import type { Evidence, UsageTotals } from "llm-large-files";

/** The data of the `done` event. */
export type AnswerEnd = { answered: boolean; blockReason?: string; finishReason?: string; steps: string[]; evidence: Evidence[]; usage: UsageTotals };
/** The data of the `error` event. */
export type AnswerError = { kind: string; message: string; incomplete: boolean };
export type AnswerEvents = { text(delta: string): void; activity(text: string): void; step(text: string): void };

/**
 * Asks one question and reads the answer as it streams. Resolves with the `done` event. Rejects on
 * an `error` event (with its kind and message), an HTTP error, a dropped connection, or an abort.
 */
export async function askStreamed(sessionId: string, question: string, on: AnswerEvents, signal: AbortSignal): Promise<AnswerEnd> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, question }),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `The server answered HTTP ${response.status}.`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
        // A line that starts with ":" is a keep-alive comment.
      }
      if (!data) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        continue; // a message that is not JSON is skipped
      }
      if (event === "text") on.text(payload as string);
      else if (event === "activity") on.activity(payload as string);
      else if (event === "step") on.step(payload as string);
      else if (event === "done") return payload as AnswerEnd;
      else if (event === "error") throw Object.assign(new Error((payload as AnswerError).message), payload as AnswerError);
    }
  }
  throw new Error("The connection closed before the answer was complete. Ask again.");
}
```

And a page that uses it, with a Stop button:

```ts
// askStreamed is the function above.
const answerView = document.querySelector<HTMLElement>("#answer")!;
const statusView = document.querySelector<HTMLElement>("#status")!;
const stepsView = document.querySelector<HTMLElement>("#steps")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;

export async function showAnswer(sessionId: string, question: string): Promise<void> {
  const controller = new AbortController();
  stopButton.onclick = () => controller.abort(); // the server sees the connection close, and stops
  let answer = "";
  answerView.textContent = "";
  stepsView.replaceChildren();
  try {
    const end = await askStreamed(sessionId, question, {
      text: (delta) => {
        answer += delta;
        answerView.textContent = answer;
        statusView.textContent = "";
      },
      activity: (text) => {
        statusView.textContent = text;
      },
      step: (text) => {
        const line = document.createElement("li");
        line.textContent = text; // text, never HTML: it holds file names and search words
        stepsView.append(line);
      },
    }, controller.signal);
    statusView.textContent = "";
    if (!end.answered) {
      answerView.textContent = end.blockReason ? "This question was blocked by the model's safety filters." : "No answer this time. Ask again, or ask more precisely.";
    }
  } catch (error) {
    if (controller.signal.aborted) statusView.textContent = "Stopped.";
    else statusView.textContent = error instanceof Error ? error.message : String(error);
    if (answer) answerView.textContent = `${answer}\n\n(The answer was cut off.)`;
  }
}
```

- **`answered: false`** means the text is no answer: a blocked prompt, a reply cut off before its
  first word, or an answer that had no text (empty, or a tool call) even when it was asked for once
  more. The text may be empty or hold only a remark from before a tool call. Show your own message
  in its place, as above, and do not store it as the assistant's turn.
- **An error after some text** (`incomplete: true`, or a dropped connection) leaves the text that
  arrived. Keep it, mark it as cut off, and let the user ask again.
- **Stop** aborts the `fetch`. The connection closes, the server aborts the question, and `fetch`'s
  reader rejects with an `AbortError`.
- **A connection that drops** ends the stream without a `done` or `error` event, or makes a read
  fail. Either way the function throws: the question cannot be resumed.

## The example server: `examples/server.ts`

The repository has a chat server in one file, with no dependencies beyond the package and its
optional ones: the upload routes, a chat route that streams over Server-Sent Events, and a page.
To run it, from a clone of the repository:

```bash
npm install && npm run build
GEMINI_API_KEY=... node examples/server.ts   # then open http://localhost:3000
```

It needs Node 22.18 or a later 22.x, or Node 23.6 or later (24, for example), which run TypeScript
files directly. `npm install` also installs the optional dependencies, which the repository has as
dev dependencies, so PDF, DOCX, PPTX and XLSX uploads work. `GEMINI_MODEL` names the model, and
`GEMINI_EXPLORER_MODEL`, when set, an [explorer model](./explorer-model.md).

What it does:

- **The library.** `geminiApi()` with an API key for the endpoint, and `createLargeFiles` with a
  `FileDocumentStore` in `.data/large-files` and `keepOriginals: ["pdf"]`, so the model can look at
  the pages of a PDF ([PDFs](./pdfs.md)). To try Vertex AI, swap the endpoint for `vertexAi()`
  ([Gemini and Vertex AI](./vertex-and-gemini.md)).
- **Uploads.** `createDocumentHandlers` on `node:http`: `POST /api/documents` to `upload`,
  `DELETE /api/documents/:id` to `remove`. `getOwner` returns `undefined`, so every upload is
  anonymous.
- **The chat route.** `POST /api/chat` takes `{ chatId, question, documentIds }` as JSON, checked
  before the stream starts (`400` or `413` otherwise). The server keeps each chat's turns, tool
  rounds included, in a `Map` (for the demo only: in memory, the latest questions of the latest
  chats). The route calls `askStream` with the model, and the explorer when `GEMINI_EXPLORER_MODEL`
  names one, and passes the stream itself to `writeSseEvents`, so that the question stops as soon
  as the page goes away. Its `map` puts `run.error` in the app's own words, by `error.name` and
  `error.kind`. After the stream, it keeps `result.toolTurns` and the answer when there is one, or
  the `toolTurns` of `partialResultOf(error)`.
- **The page.** A file input uploads with `fetch` (`application/octet-stream`, `X-File-Name`,
  `Accept: text/event-stream`), shows the ingest's progress, then the format, lines and estimated
  tokens of the summary in `ingest.finish`. A question is posted to `/api/chat`, and the events
  are read with a stream reader that splits them at blank lines, as
  [above](#reading-the-events-in-the-browser). The page shows a status line, a list of tool calls
  with a mark for each outcome and a counter for whole-file reads, the text as it streams, and the
  usage in `run.finish` or the message of `run.error`.

During the work on 0.7.0, the event stream was checked live against the Gemini API: the counts the
events give, the roles of the requests of an explorer pair (`explorer` and `answer`), and this
server's stream to the page, end to end.

It is a demo, kept short. Before you build on it, check your server against this list, which this
guide covers:

- `getOwner` returns the signed-in user, and the chat route passes the same `owner`.
- The JSON body is read and checked before the stream starts, and a bad one gets a `400`.
- The page shows its own message when `answered` in `run.finish` is false.
- `toolTurns` are kept on the server with each question, from `stream.result` or
  `partialResultOf(error)`, and passed back in the history. The page never handles them.
- `eventResults` stays off, so no event carries the text of your documents.
- `run.error` carries a message safe to show; map it to your own words by `kind` and `name` if you
  like. The provider's message is on the thrown error, for your log only.
- The stream is passed to `writeSseEvents` itself, or the route stops the question when the
  response closes.
- Keep-alive comments and a deadline keep long questions alive and bounded.
- `files.sweep()` runs on a timer, so expired uploads leave the disk.

## Reference

- [`llm-large-files/node`](../reference/node.md): `createDocumentHandlers`, `DocumentHandlerOptions`,
  `DocumentHandlers`, every route, status and body, the upload's events, and `writeSseEvents`,
  `sseMessageOf`, `SseMessage` and `SseWriteOptions`.
- [The library](../reference/library.md): `IngestInput` (`onEvent`, `runId`), `toDocumentSummary`,
  `DocumentSummary`, `DocumentMeta`, `ProgressEvent`, `ToolOptions`.
- [Events](../reference/events.md): `AskEvent`, `IngestEvent`, `EventError`, `EventResult`,
  `askStream`, `eventStream`, `streamText`, and how the callbacks map to events.
- [The tool loop](../reference/ask.md): `askWithFiles`, `askStream`, `AskOptions` (`onEvent`,
  `streamText`, `eventResults`, `runId`, `onText`, `onActivity`, `onStep`, `signal`), `AskResult`,
  `partialResultOf`.
- [`llm-large-files/gemini`](../reference/gemini.md): `askGemini` and its options.
- [Errors, retries and streams](../reference/errors-and-retries.md): `ModelErrorKind`,
  `errorKindOf`, the default waits.

Related guides: [Conversations](./conversations.md) for the history and `toolTurns`,
[An explorer model](./explorer-model.md) for the second model whose requests the events tell apart,
[Errors and reliability](./errors-and-reliability.md) for every error and deadline,
[Storage](./storage.md) for owners and sessions, [Deployment](./deployment.md) for several servers
and proxies, and [Testing](./testing.md) for running these routes without a real model.
