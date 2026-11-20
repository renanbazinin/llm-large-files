# Web app

This guide is for you if you add large files to a web chat: the browser uploads files, your server
keeps them and asks the model, and the answer streams back to the page with its progress. It covers
uploads with `createDocumentHandlers` or with a route of your own, the browser side of an upload, a
Server-Sent Events route that streams the answer, cancelling, and reading the stream in the browser.
The samples use Express 5 and Gemini on Vertex AI. The approach depends on neither: with Express 4,
catch errors in async routes yourself, and with another model, call `askWithFiles` (see the end of
[the chat route](#a-server-sent-events-route)).

## What you build

Three routes. Their paths are yours: the library mounts none.

| Route | What it does | With |
|---|---|---|
| `POST /api/documents` | Takes one file, extracts and stores its text, and answers with a `DocumentSummary`. | `createDocumentHandlers(files).upload`, or `files.ingest` in a route of your own |
| `GET` and `DELETE /api/documents/:id` | Looks a document up, or deletes it. | `get` and `remove` of the same handlers |
| `POST /api/chat` | Asks the model about the chat's documents, and streams the answer, the progress and the result as Server-Sent Events. | `askGemini` or `askWithFiles`, with `onText`, `onActivity`, `onStep` and `signal` |

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
  last path segment of the name, without control characters, up to 255 characters: the name is
  shown to the model and in your UI.
- **`X-File-Type`** is the MIME type, and is optional. Without it, `Content-Type` is taken, unless
  it is `application/octet-stream`. The format comes from the extension first (`.log`, `.md`,
  `.json`, `.csv`, `.pdf`, `.docx`, `.pptx` and a few more), then from the MIME type; anything else
  is text, and text that looks like a log becomes a log.
- **`Content-Type: application/octet-stream`**, so that no body parser takes the upload.

[Upload from the browser](#upload-from-the-browser) has the `fetch` call.

### What it answers

A successful upload answers `201` with a `DocumentSummary`:

```json
{ "id": "doc_3f9c0a7e5b2d4c18a6e0f7b9d1c3e5a7", "name": "app.log", "mimeType": "text/plain",
  "format": "log", "bytes": 5082044, "lines": 60000, "estimatedTokens": 1270511,
  "expiresAt": "2026-11-22T07:43:14.435Z" }
```

`pages` is there too for a PDF or a PPTX. Everything else is JSON `{ "error": "…" }`, with a message
you can show: `400` for a missing name or a body another middleware already parsed, `413` over
`maxUploadBytes`, `422` for a file that cannot be read, an error's own status (400 to 599) from
`getOwner`, an extractor or your store, and `500` for a failure of the server. `get` answers `404`
for a document this owner cannot see, and `get` and `remove` answer `500` when the store cannot be
read. Every status and body is in the [node reference](../reference/node.md#uploadrequest-response).

A store of your own that fails while it writes an upload can throw an error with a `status` (or
`statusCode`) from 400 to 599 (a `503`, say): the handler answers with that status and the error's
message. A Node system error, with `code` and `syscall`, is answered `500` with its code. Any other
error it throws is answered `500` "Upload failed.", without its message, which may name your hosts.
The handlers log nothing: log the error in your store before you throw it. Behind an `ingest` of
your own that throws a new error in the store's place, as `ingestInWorker` in
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
| `owner` | Optional. The user (or tenant, or chat session) the document belongs to. Every later call must pass the same. |

Answer the browser with `toDocumentSummary(meta)`, not with `meta`: the summary holds the fields that
are safe to return to a browser, while `meta` also holds the owner, the outline and the log profile.

`ingest` throws a plain `Error`, with a message written for the user, when it cannot take the file:
the cases of the `422` above (an empty, binary or compressed file, no text, a missing optional
dependency), and a file larger than `maxUploadBytes` ("app.log is larger than the 100 MB upload
limit."). A store that fails while it writes throws its own error, as it came. This helper tells
them apart by the rule `createDocumentHandlers` uses, with two differences, given below the code:

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
scan ([PDFs](./pdfs.md)), answer at once and ingest afterwards. The library has no jobs of its own;
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
  const response = await fetch("/api/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      ...(file.type ? { "X-File-Type": file.type } : {}),
    },
    body: file,
  });
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
  summary.

## Streaming the answer

### The three callbacks

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
| A request is sent again | "The model did not answer (HTTP 503). Trying again in 2 s…", "The model could not be reached. Trying again…", "The model sent nothing for too long. Trying again…" |
| The answer is asked for | "Writing the answer…" |

**`onStep`.** One line for each tool call that ran, with what it found: "Search app.log (exact) for
“timeout” — 12 matching lines", "Read app.log lines 120-180", "Look at report.pdf pages 12-14". A
call answered from an earlier result ends in " — already shown above", and one that failed in
" — failed: " and the reason. The loop adds its own lines too, such as "Older tool results were
shortened to make room in the request". Every tool, and `toolResultSummary`, which writes what a
step found, are in the [tools reference](../reference/tools.md).

Activities and steps are English sentences, made by the library, with file names and the model's
search words in them. Render them as text, never as HTML. For a UI in another language, show your
own words for each event ("Searching your files…"), and build a list of sources from
`result.evidence` when the answer is done: it is the structured record of what each call showed,
the document and the lines or pages.

**Whole-file reads.** `askGemini` and `askWithFiles` take no `onProgress`. The progress of a
whole-file read, a `ProgressEvent` (`kind` "map" or "reduce", `message`, `done`, `total`), reaches
`onActivity` as its `message` followed by "…". `ProgressEvent` and `onProgress` are for a loop of
your own: `files.tools(documents, { onProgress })` ([Your own adapter and loop](./own-adapter-and-loop.md)).

### When the text streams

`onText` is called whether or not the model streams. When it does not, each reply reaches `onText`
once it is in: in one piece, or from Gemini, one piece for each text part. Whether it streams:

- **`askGemini` and `gemini()`**: when `onText` is set and the endpoint has a `streamUrl`.
  `vertexAi()` and `geminiApi()` set one; an endpoint of your own for a gateway needs it
  ([Gemini and Vertex AI](./vertex-and-gemini.md)).
- **`openAiCompatible()`**: when `onText` is set, unless `stream: false`
  ([OpenAI-compatible endpoints](./openai-compatible.md)).
- **`anthropic()`**: every chat request, unless `stream: false` ([Claude](./anthropic.md)).

An OpenAI-compatible server or a Claude gateway that answers without a stream is read in one piece.
An explorer model's requests are never shown: `gemini()` and `openAiCompatible()` do not stream
them, and `anthropic()` streams them (unless `stream: false`) without showing any of it. So between
the question and the first word, a page can get nothing but `activity` and `step` events for
minutes: an explorer at work, a model that thinks before it writes (up to `firstByteTimeoutMs`,
600 s by default, for each request). Plan the stream for that silence
([below](#keep-alive-comments-and-proxies)).

### A Server-Sent Events route

The route below streams one question of a chat as Server-Sent Events. Each event is
`event: <name>` and `data: <JSON>`:

| Event | `data` | When |
|---|---|---|
| `text` | A string: a piece of the answer. | As it streams, one event for each `onText` call. |
| `activity` | A string. | Each `onActivity` call. |
| `step` | A string. | Each `onStep` call. |
| `done` | `{ answered, blockReason, finishReason, steps, evidence, usage }` | Last, when the question ended without an error. |
| `error` | `{ kind, message, incomplete }` | Last, when the question failed. |

Every 15 seconds the route also writes a comment line, `: keep-alive`, which the browser ignores.

```ts
// chat-route.ts
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

Mount it after `express.json()`, next to the upload routes:

```ts
// server.ts, after the upload routes. chats is your ChatStore.
app.post("/api/chat", chatRoute(chats));
app.listen(3000);
```

What the route does, and why:

- **It refuses before it streams.** A missing user, a bad body or an unknown chat gets a status and
  a JSON error. Once `writeHead(200)` is sent, an error can only be an `error` event.
- **Every `data` is JSON.** A piece of text can hold a blank line, which would end an event if it
  were written as it is. `JSON.stringify` keeps each event on one `data:` line.
- **`flushHeaders()` sends the 200 at once**, so the browser's `fetch` resolves and the page can
  show that the question is under way.
- **The history comes from your store**, with the tool rounds of earlier questions in their place,
  and the question is kept with its `toolTurns`, and with its answer only when there is one
  (`answered`). What to keep, and why, is in [Conversations](./conversations.md). If your page
  keeps the history instead, as the example server does, send `toolTurns` in `done` and have the
  page put them back between the question and its answer. They can be large, which is a reason to
  keep them on the server.
- **`done` carries the result** the page needs: `answered` to know whether the text is an answer,
  `blockReason` and `finishReason` to say why not, `steps`, `evidence` for sources, and `usage`.
  Leave out what your users should not see. Counting `usage` per user or session is in
  [Costs and limits](./costs-and-limits.md).
- **`error` carries a kind and words for the user.** `kind` is the error's
  [`ModelErrorKind`](../reference/errors-and-retries.md#modelerrorkind) for a model error, and a
  name of the route's own otherwise. The messages follow
  [Errors and reliability](./errors-and-reliability.md), which says what each error means.
  `incomplete` is true when some of the answer was already shown: the page keeps that text and
  marks it as cut off.

With another model, call `askWithFiles({ files, model, ... })` in place of `askGemini`: it takes the
same `owner`, `documentIds`, `messages`, `signal` and callbacks, and returns the same result.

### Keep-alive comments and proxies

A load balancer or a proxy in front of your server may close a response on which nothing arrived
for a while, or hold the events back in a buffer. A question can be silent for minutes (an explorer
at work, a model that thinks, a whole-file read between two parts), so:

- **Write a comment line now and then.** A line that starts with `:` is a comment in Server-Sent
  Events: it keeps the connection busy, and the browser drops it. The route above writes one every
  15 seconds.
- **Turn off buffering for the route.** `X-Accel-Buffering: no` asks nginx to pass each event on
  at once. A compression middleware also holds events back; leave this route out of it.
- **Allow for the whole question in the proxy's timeout.** Keep-alives do not help against a limit
  on the total time of a response. The route's own deadline (15 minutes above) should end first.

Proxies, timeouts and several servers are in [Deployment](./deployment.md).

### Cancelling

A question stops when the `signal` you pass aborts. The route above aborts it in two cases:

- **The browser goes away**: the user pressed Stop, closed the tab, or lost the connection. The
  response's `close` event fires, and the route aborts its `AbortController`. Listen on the
  response, not on the request: the request's own `close` fires once its body has been read, long
  before the answer is done.
- **Your deadline passes**: `AbortSignal.timeout`, joined with the first by `AbortSignal.any`. A
  question has no time limit of its own.

What aborting stops, what a stopped question throws, how to tell your deadline from a user who
left, and why to abort with an `Error` rather than a string are in
[Errors and reliability](./errors-and-reliability.md#an-overall-deadline).

There is no resuming: a question whose stream was cut off is over, and the user asks again. With the
tool rounds of the stopped question kept, as the route does, the new question starts from what it
had found.

### Reading the stream in the browser

`EventSource` sends only `GET` requests without a body, so read a `POST` stream with `fetch`:

```ts
// chat-client.ts: runs in the browser.
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
      const payload: unknown = JSON.parse(data);
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
  first word, a broken tool call. The text may be empty or hold only a remark from before a tool
  call. Show your own message in its place, as above, and do not store it as the assistant's turn.
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
files directly. `npm install` also installs the
optional dependencies, which the repository has as dev dependencies, so PDF, DOCX and PPTX uploads
work. `GEMINI_MODEL` names the model, and `GEMINI_EXPLORER_MODEL`, when set, an
[explorer model](./explorer-model.md).

What it does:

- **The library.** `geminiApi()` with an API key for the endpoint, and `createLargeFiles` with a
  `FileDocumentStore` in `.data/large-files` and `keepOriginals: ["pdf"]`, so the model can look at
  the pages of a PDF ([PDFs](./pdfs.md)). To try Vertex AI, swap the endpoint for `vertexAi()`
  ([Gemini and Vertex AI](./vertex-and-gemini.md)).
- **Uploads.** `createDocumentHandlers` on `node:http`: `POST /api/documents` to `upload`,
  `DELETE /api/documents/:id` to `remove`. `getOwner` returns `undefined`, so every upload is
  anonymous.
- **The chat route.** `POST /api/chat` takes `{ messages, documentIds }` as JSON: the page keeps the
  history and the ID of the last file uploaded (a new upload replaces it), and sends both with each
  question. The route writes the event-stream headers, aborts an `AbortController` when the
  response closes, and calls `askGemini` with `onText`, `onActivity` and `onStep`, each written as
  an event (`text`, `activity`, `step`). It ends with `done`, or with `error` and a message, unless
  the client has gone.
- **The page.** A file input uploads with `fetch` (`application/octet-stream`, `X-File-Name`) and
  shows the format, lines and estimated tokens of the summary. A question is posted to `/api/chat`,
  and the response is read with a stream reader that splits it into events at blank lines, as
  [above](#reading-the-stream-in-the-browser).

It is a demo, kept short. Before you build on it, check your server against this list, which this
guide covers:

- `getOwner` returns the signed-in user, and the chat route passes the same `owner`.
- The JSON body is read and checked before the stream starts, and a bad one gets a `400`.
- `done` carries `answered`, and the page shows its own message when it is false.
- `toolTurns` are kept with each question, and passed back in the history.
- Errors are told apart by their kind, and the provider's message goes to your log only.
- Keep-alive comments and a deadline keep long questions alive and bounded.
- `files.sweep()` runs on a timer, so expired uploads leave the disk.

## Reference

- [`llm-large-files/node`](../reference/node.md): `createDocumentHandlers`, `DocumentHandlerOptions`,
  `DocumentHandlers`, and every route, status and body.
- [The library](../reference/library.md): `IngestInput`, `toDocumentSummary`, `DocumentSummary`,
  `DocumentMeta`, `ProgressEvent`, `ToolOptions`.
- [The tool loop](../reference/ask.md): `askWithFiles`, `AskOptions` (`onText`, `onActivity`,
  `onStep`, `signal`), `AskResult`, `partialResultOf`.
- [`llm-large-files/gemini`](../reference/gemini.md): `askGemini` and its options.
- [Errors, retries and streams](../reference/errors-and-retries.md): `ModelErrorKind`,
  `errorKindOf`, the default waits.

Related guides: [Conversations](./conversations.md) for the history and `toolTurns`,
[Errors and reliability](./errors-and-reliability.md) for every error and deadline,
[Storage](./storage.md) for owners and sessions, [Deployment](./deployment.md) for several servers
and proxies, and [Testing](./testing.md) for running these routes without a real model.
