# Deployment

This page is for running an application built on llm-large-files in production: on several
servers, behind a proxy or a load balancer, through restarts and upgrades. It says what state lives
where, what the shared store must guarantee, how much memory a server needs, how to sweep expired
documents, how to keep a streamed answer alive, and what Node.js and packages a production image
needs.

## What lives where

A question is one call (`askWithFiles` or `askGemini`) that runs on one server from the plan to
the answer. Everything it needs comes from the store and from the conversation your application
passes in. What a server keeps in memory between two questions is a cache, which it can always
rebuild from the store.

| State | Where it lives | Shared by your servers | After a restart |
|---|---|---|---|
| Documents: metadata, text, line index, kept originals | The `DocumentStore` | Must be | Kept (lost with `MemoryDocumentStore`) |
| Conversations: messages and `toolTurns` | Your application's storage | Yours to share | Yours |
| Which documents belong to which user or chat | Your application, and `owner` on each document | Yours to share | Yours |
| Documents ready to search, decoded pieces of large ones, line indexes | A cache in each `LargeFiles`, within `cacheBytes` | No | Empty; filled again from the store |
| Searches of large files waiting their turn | A queue in each `LargeFiles` (`maxConcurrentScans`) | No | Empty |
| The output limit a thinking model needs for whole-file part reads | Each process, by URL and model | No | Learned again, at the cost of one request |
| The name of the output limit an OpenAI-compatible server takes | Each `openAiCompatible()` adapter | No | Learned again, at the cost of one refused request |

What follows from it:

- **Any server can answer any question**, when the store is shared and your application sends the
  whole conversation, `toolTurns` included ([Conversations](./conversations.md)). No sticky
  sessions are needed.
- **A server never serves a document that is gone.** Every use of a cached document asks the store
  first (`getMeta`), so a document deleted on one server, or expired, is gone on all of them at
  once. A cached copy is used only while the store still describes the same text (its `createdAt`,
  `textBytes`, `characters` and `lines`).
- **Create `files` once per process**, at startup, and import it everywhere. Each
  `createLargeFiles` call has its own cache and its own queue of scans: one per request would read
  every document from the store again and multiply the memory limits. Create adapters once too, so
  that what they learn is kept.
- **Nothing coordinates your servers.** `limits` apply to one question, each server retries its own
  requests, and the provider's quota is shared by all of them
  ([Errors and reliability](./errors-and-reliability.md), [Costs and limits](./costs-and-limits.md)).

## A shared store

Several servers need one store that all of them read. Whatever it is built on, it must guarantee
this:

- **A write is seen by every server once it has returned.** The browser uploads to one server and
  asks on another a second later. A store whose reads lag its writes makes the new document look
  missing, and the question throws `DocumentsNotFoundError`.
- **A delete is seen by every server once it has returned.** The cache of each server relies on
  `getMeta` to know that a document is gone.
- **A document appears whole.** `ingest` writes the original and the line index first, and calls
  `put` last; `put` must make the metadata visible only after the text. A server that finds the
  metadata must be able to read the text.
- **The text is kept byte for byte.** `readTextRange` reads UTF-8 byte offsets that the line index
  computed at ingest. A text that changed is noticed ("The stored text of … did not match its
  index. Try the call again.") and its index is built again.
- **`undefined` means "not there", and nothing else.** A read that failed (a timeout, a volume that
  does not answer) must throw: the library passes it on as `DocumentStoreError` instead of telling
  the user that the file is gone.
- **Two servers can do the same thing at once.** Two sweeps or two deletes of one document must
  not fail, and two servers saving the index of an older document at the same time must leave one
  whole index (the last write wins).
- **`getMeta` is fast.** It is called for each document at the start of every question, and again
  for every tool call that reads a document.

The built-in stores:

- **`MemoryDocumentStore`** lives in one process. With several servers, each sees only its own
  uploads: use it for tests and one-process demos only.
- **`FileDocumentStore`** works on a volume that every server mounts. It writes each file under a
  temporary name and renames it, so no server reads half a file; it writes the metadata last and
  deletes it first; it throws every error reading the metadata, the text or the original other
  than "no such file" (an index it cannot read is built again from the text); and its `sweep` leaves
  alone the files of an upload that may still be in progress (see
  [Sweeping expired documents](#sweeping-expired-documents)).

  It needs a file system whose rename is atomic and that shows each server the files of the
  others: an NFS share (Amazon EFS, Google Filestore, Azure Files over NFS) or similar. Two caveats:

  - An NFS client may remember for a while that a file did not exist (its negative lookup cache).
    A question sent to another server right after an upload can then find the document missing.
    Mount the share with `lookupcache=positive` (or `none`).
  - A bucket mounted as a file system (gcsfuse, s3fs and the like) often does not rename
    atomically. Write a store over the bucket's own API instead.

- **A store of your own**, over MongoDB, S3, Cloud Storage, Redis or a database: see
  [Storage](./storage.md) for the contract method by method and a complete example.

## Memory on each server

| What takes memory | How much | What bounds it |
|---|---|---|
| Documents kept ready to search | Up to `cacheBytes`, 256 MB by default | `cacheBytes`; `cacheSize` also caps their number |
| A document loaded whole: text up to `wholeDocumentBytes` (2 MB), or any size when the store has no `readTextRange` | Its text and a lowercased copy: 2 bytes a character for ASCII text, 4 for any other | Counted in `cacheBytes`. One larger than `cacheBytes` is loaded again for each call and not kept |
| A document read by range | Its line index: about 8 bytes a line (8.2 MB for a log of a million lines) | Counted in `cacheBytes` |
| Searches of documents read by range | A few MB each: `scanChunkBytes` (1 MB) of text read, decoded and lowercased, and the next piece read ahead | `maxConcurrentScans` (4) per `LargeFiles`. The others wait, and those waiting for the same file share one pass over it |
| Decoded pieces of a document read by range | Up to its whole decoded text | Kept within `cacheBytes`, and only for a document whose decoded text takes at most a quarter of it |
| An upload | The body, buffered whole | `maxUploadBytes`, 100 MB by default |
| An ingest | Several copies of the text at once (below), and what the parsers of PDF, DOCX and PPTX take while they read | `maxTextBytes` bounds the text (100 MB by default). One at a time, or in a process of its own (below) |
| A look at the pages of a PDF (`view_pages`) | The whole original, read and parsed: about twice the size of the file, plus 1 to 1.6 KB for each object in it (about 300 MB for a 100 MB file of photos, 700 MB for 54 MB of 330,000 objects) | Refused for a file that declares more than 1,000,000 objects, or more objects than about 60% of the free heap can hold |
| A question in flight | Its conversation, and each request it builds: up to `maxRequestBytes` (10 MB by default) of JSON, the pages it was shown included as base64 | The budget ([Costs and limits](./costs-and-limits.md)) |

Measured peaks are in [Measurements](../measurements.md#the-server): an ingest of a plain-text log
takes about five to seven times the log above the uploaded bytes, and eight searches at once take
little more than one.

Other formats were not measured for memory. PDF text is extracted by pdf.js, which reads the whole
file, and with `@cantoo/pdf-lib` installed the file is parsed a second time to mark the pages that
show a picture (given up for a file that declares more than 150,000 objects, or when finding the
pictures takes more than 5 seconds once the file is parsed). A PDF of more than `maxPdfPages`
(5,000) pages, and a file of more than `maxTextBytes` of text, are refused
([Security](../security.md#uploads)). The peak memory of `view_pages` on real files is in
[measurements](../measurements.md).

Set the heap limit of Node yourself: about three quarters of the memory of the container when
everything runs in one process (`NODE_OPTIONS=--max-old-space-size=1536` for 2 GB), less when
ingest runs in a process of its own. Each heap can also take up to about 190 MB of young
generation above its `--max-old-space-size`: on Node 24, `v8.getHeapStatistics().heap_size_limit`
is 1,216 MB for 1,024, and 704 MB for 512. Upload bodies and files read from the store are
`Buffer`s, which live outside the heap and need the rest. The check that refuses a PDF too large to
cut pages from compares it with the free heap, so a heap set to fit the container makes that check
right.

A worker thread does not get a heap limit of its own when the process has one: a
`--max-old-space-size` on the command line or in `NODE_OPTIONS` replaces the
`resourceLimits.maxOldGenerationSizeMb` of every worker. With `--max-old-space-size=1024`, a worker
given 512 MB had the process's limit, 1,216 MB, and setting `execArgv: []` or `env` on the worker
did not change it. A forked process does get its own: one forked with
`execArgv: ["--max-old-space-size=512"]` had 704 MB, with `NODE_OPTIONS=--max-old-space-size=1024`
in the environment it inherits or without it.

A starting point for a container of 2 GB, to check under your own load:

```ts
// large-files.ts: created once per process and imported by every route.
// Run with NODE_OPTIONS=--max-old-space-size=1024: ingests run in a process of their own (below).
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.DOCUMENTS_DIR ?? "/mnt/documents"),
  keepOriginals: ["pdf"],            // view_pages: a look reads the whole PDF into this heap
  cacheBytes: 256 * 1024 * 1024,     // the default
  maxConcurrentScans: 4,             // the default
  maxUploadBytes: 100 * 1024 * 1024, // the default
});
```

| Where 2 GB go | |
|---|---|
| The main heap, 1 GB | The cache (256 MB), the questions in flight, a look at the pages of a PDF |
| One ingest at a time, in a process with a heap of 512 MB | An ingest of a 95 MB log fitted in a heap of 256 MB. A process takes about 50 MB more for Node itself |
| Outside the heaps | The upload being read (up to 100 MB) and its copy sent to the ingest process, files read from the store, Node itself |

Raise `cacheBytes` to spend memory on speed: at 1 GB, the decoded pieces of an ASCII log of up to
about 125 MB are kept between searches. Lower `maxUploadBytes` if large uploads are not needed:
an ingest is one of the largest single uses of memory.

### Uploads and ingest

`createDocumentHandlers` reads the whole upload into memory before it calls `ingest`. It refuses a
body whose `Content-Length` is over `maxUploadBytes` before reading it, and stops reading one that
grows past it (HTTP 413). Node's own `server.requestTimeout` (300,000 ms by default) ends an upload
that takes longer than five minutes to arrive: raise it for users on slow links.

An ingest runs in your server's process, a slice at a time. It pauses for other requests about
every 12 ms of its work, so an answer streaming on the same server waits a fraction of a second,
not seconds: the longest stall measured was 34 ms for a 99 MB log and 0.16 s for a 2,000-page
PDF, where 0.6.0 held the server for 2.0 s and 4.5 s ([measured](../measurements.md#the-server)).
One page of a PDF that is slow to read still holds the server for as long as it takes: a page
built to paint forms inside forms held it for 25 s. It has limits too: `maxTextBytes` (the text kept from
one file, 100 MB by default), `maxPdfPages` (5,000) and `ingestTimeoutMs` (2 minutes) refuse a file
that would cost more ([Security](../security.md#uploads)).

The first PDF a process reads also loads the PDF parsers, in one block that no pause can split:
about 0.25 s for `@cantoo/pdf-lib` and 0.05 s for pdf.js, measured on Node 24. Load them when the
server starts, before it takes requests:

```ts
// Before the server listens: the first upload of a PDF then does not hold it while they load.
await import("@cantoo/pdf-lib");
await (await import("unpdf")).getResolvedPDFJS();
```

What it does not do is keep its memory apart. The text and its copies, and what pdf.js,
`@cantoo/pdf-lib` and JSZip take while they read, are in your server's heap, with the cache and the
questions in flight. A file that needs more than the heap has left stops the whole process, and
every answer streaming on it. A step under way, such as one slow page of a PDF, also runs to its
end after the time limit. Three ways to bound that:

- **Accept one or two ingests at a time** per server, and answer the others with 503 (the sample
  below does it): this bounds memory and keeps stalls from adding up.
- **Ingest in a process of its own**, with a heap limit and a time limit: below. A process that
  runs out of memory stops alone, and the upload is answered with an error.
- **Ingest in a service of its own.** All the state is in the store, so an upload service with its
  own `createLargeFiles` and `createDocumentHandlers`, on servers sized for uploads, can write the
  documents that the chat servers read. Give it the options that apply at ingest, the same as the
  chat servers would have: `ttlMs`, `maxUploadBytes`, `maxTextBytes`, `maxPdfPages`,
  `ingestTimeoutMs`, `extractors`, `keepOriginals` and `scannedPdfPages`. The chat servers need the
  options that apply to reading: `cacheBytes`, `cacheSize`, `wholeDocumentBytes`, `scanChunkBytes`,
  `maxConcurrentScans` and `budget`.

**Not a worker thread.** Until 0.6.1, this guide ran each ingest in a worker thread
(`ingestInWorker`) with `resourceLimits: { maxOldGenerationSizeMb: 512 }`. That keeps the event
loop free, but it does not bound memory. The process's heap flag replaces the worker's limit (see
[Memory on each server](#memory-on-each-server)): under the `NODE_OPTIONS` of `large-files.ts`
above, that worker had 1,216 MB, not 512. And a worker that runs out of memory can take the whole
process down with it: in the review of 0.6.0, a worker of 512 MB, with no heap flag on the process,
did so on a hostile DOCX. A child process stops alone.

A process that runs one ingest, with the options of `large-files.ts` above:

```ts
// ingest-process.ts: one ingest, in a process of its own, forked by documents.ts below.
import type { IngestInput } from "llm-large-files";
import { files } from "./large-files.js"; // the same options as the chat routes

process.once("message", async (message) => {
  try {
    process.send!({ meta: await files.ingest(message as IngestInput) });
  } catch (error) {
    const { code, syscall, status, statusCode } = (error ?? {}) as { code?: unknown; syscall?: unknown; status?: unknown; statusCode?: unknown };
    const httpStatus = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : undefined;
    process.send!({
      failed: error instanceof Error ? {
        message: error.message,
        // What createDocumentHandlers answers by: a status (a 503 from your store or an OCR service),
        // or the code and syscall of a failure of the store (500). Without either, a 422 with this
        // message, even for an error of your store (below).
        ...(httpStatus !== undefined ? { status: httpStatus } : {}),
        ...(typeof code === "string" && typeof syscall === "string" ? { code, syscall } : {}),
      } : {
        // Not an Error: its code and syscall when it has both, or else a 500 with no message.
        // createDocumentHandlers answers it as it does without this process: with the code, or with
        // { "error": "Upload failed." }.
        message: "",
        ...(typeof code === "string" && typeof syscall === "string" ? { code, syscall } : { status: 500 }),
      },
    });
  }
});
```

The upload routes, with `ingest` replaced by one that forks that process. `createDocumentHandlers`
takes any `LargeFiles`, so the rest stays as it is:

```ts
// documents.ts: the upload routes. Each ingest runs in a process of its own, one at a time on this server.
import { fork } from "node:child_process";
import type { DocumentMeta, IngestInput } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";
import { files } from "./large-files.js";
import { userIdOf } from "./auth.js"; // your sign-in

const INGESTS_AT_ONCE = 1;
let running = 0;

type IngestReply = { meta?: DocumentMeta; failed?: { message: string; code?: string; syscall?: string; status?: number } };

function ingestInProcess(input: IngestInput): Promise<DocumentMeta> {
  if (input.signal?.aborted) return Promise.reject(input.signal.reason);
  if (running >= INGESTS_AT_ONCE) {
    // An error with a status is answered with that status and its message.
    return Promise.reject(Object.assign(new Error("The server is reading other files. Try again in a minute."), { status: 503 }));
  }
  running++;
  return new Promise<DocumentMeta>((resolve, reject) => {
    const child = fork(new URL("./ingest-process.js", import.meta.url), {
      // A heap of its own. This flag wins over a --max-old-space-size in NODE_OPTIONS, which the
      // child inherits.
      execArgv: ["--max-old-space-size=512"],
      serialization: "advanced", // the bytes go as they are, not as JSON
    });
    let reply: IngestReply | undefined;
    let timedOut = false;
    let settled = false;
    // Above ingestTimeoutMs (120 s by default), so that the library's own message comes first. This
    // ends a step that cannot be stopped, such as one slow page of a PDF.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 150_000);
    // The upload handler aborts the signal when the client goes away: nobody waits for this file.
    const stop = () => child.kill();
    input.signal?.addEventListener("abort", stop, { once: true });
    // The slot is free once the process is gone, and only then is the upload answered: a user who
    // sends the next file as soon as this one is answered does not find the slot still taken.
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", stop);
      running--;
      if (reply?.meta) resolve(reply.meta);
      else if (input.signal?.aborted) reject(input.signal.reason);
      // With a status, that status and message (a 503 from your store or an OCR service); with a
      // code and a syscall, a failure of the store (500); otherwise a file that cannot be read
      // (422), even when the error came from your store (below).
      else if (reply?.failed) reject(Object.assign(new Error(reply.failed.message), reply.failed));
      else if (timedOut) reject(new Error(`${input.name} took too long to read.`));
      // Out of memory, or crashed: that process is gone, and this server goes on.
      else reject(new Error(`${input.name} could not be read on this server.`));
    };
    child.once("message", (message) => {
      reply = message as IngestReply;
      child.kill(); // its work is done: the file is stored, or refused
    });
    child.once("exit", settle);
    child.once("error", () => {
      child.kill();
      settle();
    });
    // The bytes are copied to the process. A signal cannot be sent: the process has its own
    // ingestTimeoutMs, and is killed when this one aborts.
    const { signal: _signal, ...message } = input;
    child.send(message);
  });
}

export const documents = createDocumentHandlers({ ...files, ingest: ingestInProcess }, { getOwner: userIdOf });
```

Checked on Node 24: with `NODE_OPTIONS=--max-old-space-size=1024` on the server and a heap of 48 MB
for the child, a 2,000-page PDF ran the child out of memory; the upload was answered "book.pdf
could not be read on this server.", and the next upload was ingested.

The error that `ingestInProcess` rebuilds from the process's reply is a new `Error`, so
`createDocumentHandlers` cannot tell a store that failed to write from a file that cannot be read.
Given `files` itself, it answers a store's error that has no status, and no `code` and `syscall`,
with 500 `{ "error": "Upload failed." }`. Through this process, it answers that error 422 with the
store's own message, which may name a database host. Give your store's errors a status and a
message of your own, as [Storage](./storage.md#errors) shows: the process passes the status on. A
thrown value that is not an `Error` gets the same answer with the process as without it.

A process stopped by its limit or its timeout may leave the files of a document that was never
finished. `FileDocumentStore` removes them at the first sweep after they are an hour old. One
stopped after its document was stored leaves a whole document whose ID nobody got: it expires
like any other.

### Pages of PDFs

`view_pages` runs on the chat server, not where the file was ingested. Each look reads the whole
original from the store and parses it with `@cantoo/pdf-lib`, which cannot be stopped once it has
started; it pauses every 500 objects so other requests get a turn. Its memory and its limits are
in the table above. The check that refuses a file too large compares it with the free heap, so set
the heap limit (above). What the model is told when pages cannot be shown, and the rest of
`view_pages`, are in [PDFs and other formats](./pdfs.md); without `keepOriginals` nothing is kept
and nothing is cut.

## Sweeping expired documents

A document expires `ttlMs` after its upload (72 hours by default; `Infinity` never). The library
checks `expiresAt` on every use, so an expired document is never served, whether or not it was
swept. `files.sweep()` only frees the space: it calls the store's `sweep` and returns how many
documents it removed, or 0 for a store without one.

`FileDocumentStore.sweep` also removes the files of uploads that were never finished, once they are
`orphanAgeMs` old (one hour by default): younger ones may be an upload in progress on another
server ([Storage](./storage.md#filedocumentstore)).

**Where to run it.** On one server, or from a scheduled job. Running it on every server is safe
with `FileDocumentStore`, since removing a file that another sweep just removed is no error, but
each server then lists the whole directory and reads every metadata file. A job of its own:

```ts
// sweep.ts: run every hour by a scheduled job (cron, a Kubernetes CronJob, Cloud Scheduler).
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

const files = createLargeFiles({ store: new FileDocumentStore(process.env.DOCUMENTS_DIR ?? "/mnt/documents") });
const removed = await files.sweep();
console.log(`Removed ${removed} expired documents.`);
```

**How often.** Once an hour is a good start. A document then takes space for up to `ttlMs` plus one
interval. On disk, `FileDocumentStore` keeps for each document its text, its metadata, its line
index (about 8 bytes a line) and, with `keepOriginals`, the uploaded file: a 95 MB log, without
its original, takes about 103 MB until it is swept.

A store that expires records itself (a MongoDB TTL index on a date copy of `expiresAt`, which the
metadata holds as a string; a lifecycle rule on a bucket) needs no sweep for them: see
[Storage](./storage.md).

## Streamed answers behind proxies

A streamed answer is a long HTTP response that is silent for long stretches. Before the first word
of the answer:

- a model that thinks sends nothing until it has thought;
- an explorer's requests are not streamed by `gemini()` and `openAiCompatible()`, so each one
  arrives whole at the end ([An explorer model](./explorer-model.md));
- a search of a large file, or a whole-file read of many requests, takes seconds to minutes;
- a request that failed is sent again after a wait of up to 60 seconds (`retry.maxDelayMs`).

`onStep` and `onActivity` report the steps between requests, but nothing comes during a chat
request: one stretch can last up to `firstByteTimeoutMs`, 10 minutes by default. Once the answer streams,
two pieces can be up to `idleTimeoutMs` apart, 5 minutes by default. The adapters' waits are in
[Errors and reliability](./errors-and-reliability.md).

### Keep the stream alive

Many proxies and load balancers close a connection on which nothing came for a while: nginx after
`proxy_read_timeout` (60 seconds by default), an AWS Application Load Balancer after its idle
timeout (60 seconds by default). Send a comment line every 15 seconds. A line that starts with `:`
is a comment in Server-Sent Events: browsers skip it, and the proxy sees traffic.

The route in [Web app](./web-app.md) does it: it sends the stream with
`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, and writes a `: keep-alive`
comment every 15 seconds. That page also has the events themselves and a reader over `fetch`.
`EventSource` ignores comments; a reader of your own must skip a block that has no `data:` line.

### Turn off buffering

A proxy that buffers the response holds the events back and lets them through in bunches, or only
at the end. nginx buffers by default (`proxy_buffering on`): an `X-Accel-Buffering: no` header on
the response turns it off for that response. Compression middleware buffers too: the Express
`compression` package skips a response marked `Cache-Control: no-transform`, or sends what it has
when you call `res.flush()` after each event. Check any CDN in front of your server for the same.

### Limits on the whole response

Some platforms and load balancers limit the time of the whole response, not the silence, and a
heartbeat does not reset that. Cloud Run's request timeout is 5 minutes by default (60 at most),
and the backend service timeout of Google Cloud's Application Load Balancers is 30 seconds by
default. Check what yours counts, and set it above your deadline for a question.

### The order of the timeouts

| Timeout | Set it to | Why |
|---|---|---|
| Your heartbeat | 15 seconds | Below every idle timeout on the way to the browser |
| Idle timeouts of proxies and load balancers | Anything above the heartbeat | The heartbeat keeps the connection busy |
| `firstByteTimeoutMs`, `idleTimeoutMs` of the adapter | The defaults (600 s, 300 s), or lower for a model that does not think long | A silent request is aborted and sent once more |
| Your deadline for a question (`signal`) | What your users will wait, for example 15 minutes. When it is below `firstByteTimeoutMs` (600 s by default), lower `firstByteTimeoutMs` too, or a silent request is ended by the deadline before it can be sent again | The question has none of its own. Yours ends it with your message, and `partialResultOf` keeps what it found |
| Limits on the whole response | Above your deadline | Otherwise the proxy cuts the stream first, and the user gets no message |
| A gateway between your server and the model | Above the time the slowest request takes to its first byte | A gateway that gives up answers 504, which is sent again and fails again |

How to build the deadline and tell it apart from a user who left is in
[Errors and reliability](./errors-and-reliability.md). Gateways in front of the model are covered
in [Gemini API and Vertex AI](./vertex-and-gemini.md) and
[OpenAI-compatible endpoints](./openai-compatible.md).

When the stream is cut anyway (a proxy, a dropped connection), there is no resume: your server sees
the response close, the question's `signal` should abort it so that it stops costing, and the user
asks again.

## Restarts and rolling upgrades

### Stopping a server

A question under way when its server stops is lost: the stream to the browser ends, and nothing
picks the question up. Let the questions under way finish within your platform's grace period, and
stop the rest yourself so that they end with a message and keep what they found:

```ts
// shutdown.ts
import type { Server } from "node:http";

/** Aborted when this server is told to stop. Each question passes it in its signal. */
export const stopping = new AbortController();

/** Call once the server listens. `graceMs`: a little less than your platform's grace period. */
export function stopOnSigterm(server: Server, graceMs = 25_000): void {
  process.once("SIGTERM", () => {
    server.close(); // no new connections; requests under way go on
    // Before the grace period runs out, stop the questions still running.
    setTimeout(() => stopping.abort(new Error("The server is restarting.")), graceMs).unref();
  });
}

// In the chat route:
//   signal: AbortSignal.any([userLeft.signal, stopping.signal, AbortSignal.timeout(15 * 60_000)])
// and when it throws with stopping.signal.aborted: tell the user to ask again, and store
// partialResultOf(error)?.toolTurns with the conversation.
```

Abort with an `Error`, as here, not a string: `partialResultOf` needs an object to look the
question up by. An upload cut by the restart leaves files that the sweep removes an hour later.

After a restart the cache is empty: the first tool calls read their documents from the store again,
and a thinking model's first whole-file read in the new process may spend one request finding the
output limit it needs.

### Servers of two versions

During a rolling upgrade, servers of the old and the new version share the store and answer the
same conversations.

- **Documents.** The files of `FileDocumentStore` have not changed since 0.4.0: `<id>.json`,
  `<id>.txt`, `<id>.idx` and `<id>.bin`, with the same index format. Servers of 0.4.x, 0.5.x and
  0.6.x share one directory, and each reads the documents the others wrote. Run the sweep from a
  server of the newest version: since 0.4.1 it leaves alone a document whose metadata it could not
  read. A document ingested before 0.4.1 has no `jsonBytes`: planning then assumes its text takes
  8% more in JSON. One ingested before 0.4.0 has no index: it is built the first time the document
  is used, and saved for the other servers. Upgrading from 0.3.x has notes of its own in
  [the 0.4.0 entry of the changelog](https://github.com/renanbazinin/llm-large-files/blob/v0.5.0/CHANGELOG.md#040---2026-11-12).
- **A document keeps what the version that ingested it extracted**: its text, outline and log
  profile. A better extractor applies to files uploaded after the upgrade.
- **Conversations.** `toolTurns` are plain JSON, and their type (`ToolTurn`) has not changed since
  they appeared in 0.5.0. Both versions read the ones the other stored.
- **Provider caches.** The tool guide in the system instruction and the description of
  `analyze_whole_document` changed in 0.6.0. Both come at the start of a request, so a request
  sent with the new text cannot reuse what the provider cached of the old: in each conversation
  whose files are searched, the first request after the upgrade pays the full input price once.
  While servers of both versions answer the same conversation in turn, it can miss more often:
  finish the rollout quickly, or keep a conversation on one version while it runs if that cost
  matters. Any upgrade that changes this text has the same effect; the
  [changelog](../../CHANGELOG.md) says when one does.

## Node.js, ESM and `require()`

- **Node.js 20.19 or newer** (`engines` in `package.json`). The tests run on Node 20, 22 and 24.
- **The package is ESM only.** It has `"type": "module"` and an `exports` map with `types` and
  `default`; there is no CommonJS build. An ESM application imports it as it is.
- **A CommonJS application can `require()` it** on Node 20.19 and newer in the 20 line, and on Node
  22.12 and newer: those load an ES module with `require()`, and the library has no top-level
  `await`. On Node 22.0 to 22.11, load it with `import()` from an async function: a CommonJS file
  has no top-level `await`, so write `const { createLargeFiles } = await import("llm-large-files");`
  inside `async function main() { ... }`.

  ```js
  // CommonJS, Node 20.19+ or 22.12+
  const { createLargeFiles, FileDocumentStore } = require("llm-large-files");
  const { askGemini, vertexAi } = require("llm-large-files/gemini");
  const { createDocumentHandlers } = require("llm-large-files/node");
  ```

- **TypeScript that compiles to CommonJS**: use `"module": "nodenext"`, which lets a CommonJS file
  import an ES module. With `"node16"` or `"node18"`, TypeScript refuses the import (TS1479).
  `"module": "commonjs"` with `"moduleResolution": "node10"` also works, and finds the types of the
  subpaths through `typesVersions`. Checked with TypeScript 5.9, and the output run on Node 24.

  ```json
  {
    "compilerOptions": {
      "module": "nodenext",
      "moduleResolution": "nodenext"
    }
  }
  ```

- **Bundlers.** The optional packages below are loaded with a dynamic `import()` when they are
  first needed. A bundle of your server must keep them resolvable at run time: mark them external,
  and install them next to the bundle.

## Optional dependencies in production images

Three formats and features need packages that npm does not install with this one: they are
optional peer dependencies. Add the ones you need to the `dependencies` of your application, not
`devDependencies`, which `npm ci --omit=dev` leaves out of a production image.

| Package | Version | Needed for | Without it |
|---|---|---|---|
| `unpdf` | `^1.4.0` | The text of PDFs | The upload is refused: `Reading PDF files needs the optional dependency "unpdf".` (422 from `createDocumentHandlers`) |
| `jszip` | `^3.10.0` | DOCX and PPTX | The upload is refused: `Reading DOCX and PPTX files needs the optional dependency "jszip".` |
| `@cantoo/pdf-lib` | `^2.11.1` | `view_pages`, and the marks on PDF pages that show a picture | `view_pages` answers the model `report.pdf: Showing PDF pages needs the optional dependency "@cantoo/pdf-lib".` (with the file's name), and PDFs are ingested without the marks, with no error |

The last one fails quietly at ingest, so an image without it ingests PDFs differently from your
machine. Check at startup that the image has what your application uses:

```ts
// check-dependencies.ts: run at startup, before the server listens.
const needed = ["unpdf", "jszip", "@cantoo/pdf-lib"]; // the ones your application uses
for (const name of needed) {
  try {
    await import(name);
  } catch {
    throw new Error(`${name} is not installed: add it to the dependencies of this application.`);
  }
}
```

What each format gives, and the rules for an extractor of your own, are in
[PDFs and other formats](./pdfs.md).

## Related pages

- [Storage](./storage.md): the `DocumentStore` contract, a store of your own, owners and retention.
- [Web app](./web-app.md): uploads, the events of a streamed answer, cancelling.
- [Errors and reliability](./errors-and-reliability.md): the waits of the adapters, retries, a
  deadline for a question.
- [Conversations](./conversations.md): what to store so that any server can answer the next question.
- [Security](../security.md): uploads you do not trust, the cost of a question.
- Reference: [`LargeFilesOptions`](../reference/library.md#largefilesoptions),
  [`FileDocumentStore`](../reference/library.md#filedocumentstore),
  [`createDocumentHandlers`](../reference/node.md#createdocumenthandlersfiles-options).
