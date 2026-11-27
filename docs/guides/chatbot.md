# A chatbot in one page

This page is the whole integration for one kind of application, in one place: users sign in, each
has chats, a chat has uploaded files and a history kept in a database, the answers come from Gemini
on Vertex AI and stream to the browser, and the files of each chat live in a folder of their own.
It is about 190 lines of code in four files. Each part links to the guide that explains it, so
read this page first and open a guide when you need its detail.

It is also the page to hand to a coding assistant, with your answers to the questions below. The
docs come with the package, at the version you installed: `node_modules/llm-large-files/docs`.

## Before you start: what to decide

The library cannot know these. Each answer becomes a line of the code below.

| Question | What it decides | More |
|---|---|---|
| Does the model also call tools of your application? | If it does, this page is not your path: `askGemini` offers the model only the library's tools. | [Tools of your own](#when-the-model-has-tools-of-your-own) |
| Which Node runs the server? | 22.12 or later. On Node 22 install `unpdf@1`, on Node 24 and later `unpdf`. | [Getting started](../getting-started.md#install) |
| What names a user, and a chat? | The user's ID is the `owner` of every call, and `[userId, chatId]` is its `scope`. Both name folders, so they must be lowercase letters, digits, `_` and `-`: MongoDB ObjectIds and lowercase UUIDs are. | [Owners and scopes](./storage.md#owners-and-scopes) |
| Where do the files live, and how many servers read them? | One folder (`DOCUMENTS_DIR`), on a volume that every server mounts. A scheduled job sweeps it, not the servers. | [A shared store](./deployment.md#a-shared-store) |
| Which Vertex AI project, location and model, and how does the server get credentials? | The arguments of `vertexAi()`. A second, cheaper model can do the searching. | [Gemini and Vertex AI](./vertex-and-gemini.md#vertex-ai) |
| Where is the history kept? | One record for each question, with its tool rounds in full, apart from the chat's record: the rounds of one question can be large. | [Conversations](./conversations.md#storing-a-conversation-and-asking-the-next-question) |
| Which files do users upload? | `jszip` for DOCX, PPTX and XLSX, `unpdf` for PDF, `@cantoo/pdf-lib` and `keepOriginals: ["pdf"]` to let the model look at the pages of a PDF. | [PDFs and other formats](./pdfs.md) |
| Do you trust the uploads? | If not, read them in child processes: `createIsolatedExtractors`. | [Security](../security.md#uploads) |
| How long is a file kept? | 72 hours by default (`ttlMs`). With `touchOnUse: true`, as below, from its last use; without it, from the upload. | [Expiry from the last use](./storage.md#expiry-from-the-last-use) |
| What may one question cost? | The limits of a question, and its usage, which you count for each user. | [Costs and limits](./costs-and-limits.md) |
| Do users see the line citations, "(report.docx L188-L200)"? | If not, `showCitations: false`: the model still cites, the page gets the answer without them, and `result.citations.cited` keeps them for a list of sources. | [Citations the user does not see](../reference/ask.md#citations-the-user-does-not-see) |

## 1. Install

```bash
npm install llm-large-files google-auth-library jszip unpdf @cantoo/pdf-lib   # Node 24 and later
npm install llm-large-files google-auth-library jszip unpdf@1 @cantoo/pdf-lib # Node 22
```

The samples also use `express` and `mongodb`, as your application does already.

## 2. The library and the model

Made once, when the server starts, and shared by every request.

```ts
// large-files.ts
import { GoogleAuth } from "google-auth-library";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { vertexAi } from "llm-large-files/gemini";

export const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR!; // a volume that every server mounts

// The text of a chat's files is kept in <DOCUMENTS_DIR>/<user>/<chat>/.llm-large-files/.
export const files = createLargeFiles({
  store: new FileDocumentStore(DOCUMENTS_DIR, { scopes: { depth: 2 } }),
  requireScope: true, // every call names its chat; that it names its owner is the default
});

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
export const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: process.env.VERTEX_LOCATION ?? "global",
  model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash", // writes the answer
  explorerModel: process.env.GEMINI_EXPLORER_MODEL,      // optional: a cheaper model that searches and reads
  accessToken: async ({ refresh }) => { // asked for on each request
    const client = await auth.getClient();
    if (refresh) client.setCredentials({ ...client.credentials, expiry_date: 1 }); // after a 401: the cached token was refused
    return (await client.getAccessToken()).token!;
  },
});
```

- With `scopes`, a document of one chat is not found from another chat, even by its ID, and
  deleting a chat's folder deletes its files
  ([Files in a folder per user or per chat](./storage.md#files-in-a-folder-per-user-or-per-chat)).
- The budget assumes a window of 1,000,000 tokens and requests of 10 MB. For a smaller model, set
  `budget.contextTokens` ([Costs and limits](./costs-and-limits.md#the-budget)).
- Tokens, a token the server refused, and quotas on Vertex AI:
  [Gemini and Vertex AI](./vertex-and-gemini.md#access-tokens-for-vertex-ai).
- These servers do not sweep expired documents: a scheduled job does, in step 6.

## 3. Chats and their history

Your database keeps the chats. The library needs three things from it: a check that a chat is the
user's, the files of the chat with their names, and the earlier questions of the chat, each with
its tool rounds.

```ts
// chats.ts
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";
import { compactToolTurns, isSafeScopeSegment, type AskResult, type ChatTurn, type CitationAnchor, type CitedSource, type DocumentScope, type ToolTurn, type UsageTotals } from "llm-large-files";
import { DOCUMENTS_DIR } from "./large-files.js";

type ChatRecord = { _id: string; userId: string };
/** A file of a chat: its document ID and name, kept after the file expires or is deleted. */
type FileRecord = { _id: string; chatId: string; name: string };
/** One question of a chat. Kept apart from the chat: the tool rounds of one question can be megabytes. */
type TurnRecord = {
  chatId: string;
  question: string;
  toolTurns: ToolTurn[]; // in full: historyOf makes those of older questions small
  text?: string; // the answer as the page showed it
  modelText?: string; // the answer as the model wrote it: sent back as its turn
  anchors?: CitationAnchor[]; // where each chip goes in `text`
  sources?: Array<Omit<CitedSource, "quote">>; // what each chip opens, without quotes: hover text is read live
  usedDocumentIds: string[]; // the files of the chat the question had
  finish?: AskResult["finish"];
  usage: UsageTotals;
  createdAt: Date;
};

const db = new MongoClient(process.env.MONGODB_URI!).db("chat");
const chats = db.collection<ChatRecord>("chats");
const chatFiles = db.collection<FileRecord>("files");
const turns = db.collection<TurnRecord>("turns");

/** The scope of a chat. It is also its folder: <DOCUMENTS_DIR>/<userId>/<chatId>. */
export function scopeOf(userId: string, chatId: string): DocumentScope {
  // For IDs in mixed case or other letters, pass hashedScopeSegment(id) for each, here and nowhere else.
  if (!isSafeScopeSegment(userId) || !isSafeScopeSegment(chatId)) throw new TypeError("The user or chat ID cannot name a folder.");
  return [userId, chatId];
}

export async function createChat(userId: string, chatId: string): Promise<void> {
  // The folder first: the store never makes a chat's folder, so an upload into a chat that has
  // none fails, as it must for a chat that was deleted.
  await mkdir(path.join(DOCUMENTS_DIR, ...scopeOf(userId, chatId)), { recursive: true, mode: 0o700 });
  await chats.insertOne({ _id: chatId, userId });
}

export async function isChatOf(userId: string, chatId: string): Promise<boolean> {
  return (await chats.countDocuments({ _id: chatId, userId })) === 1;
}

/** The files of a chat, ID to name: also those that expired or were deleted, until a question names them. */
export async function filesOf(chatId: string): Promise<Map<string, string>> {
  return new Map((await chatFiles.find({ chatId }).toArray()).map((file) => [file._id, file.name]));
}

export async function keepFile(chatId: string, id: string, name: string): Promise<void> {
  await chatFiles.insertOne({ _id: id, chatId, name });
}

export async function forgetFiles(ids: string[]): Promise<void> {
  await chatFiles.deleteMany({ _id: { $in: ids } });
}

/**
 * The messages of the next question: each earlier question, its tool rounds, then its answer.
 * `live` holds the IDs of the chat's files that are still there.
 */
export async function historyOf(chatId: string, question: string, live: ReadonlySet<string>): Promise<Array<ChatTurn | ToolTurn>> {
  const earlier = await turns.find({ chatId }).sort({ createdAt: 1 }).toArray();
  return [
    ...earlier.flatMap((turn, index): Array<ChatTurn | ToolTurn> => {
      const rounds = withoutGoneFiles(turn.toolTurns, live);
      return [
        { role: "user", text: turn.question },
        ...(earlier.length - index > 2 ? compactToolTurns(rounds) : rounds), // the last two questions keep theirs whole
        ...(turn.modelText !== undefined ? [{ role: "assistant" as const, text: turn.modelText }] : []),
      ];
    }),
    { role: "user", text: question },
  ];
}

/** The rounds without their calls on files that expired or were deleted: what those read is not sent again. */
function withoutGoneFiles(rounds: ToolTurn[], live: ReadonlySet<string>): ToolTurn[] {
  return rounds
    .map((round) => ({ ...round, calls: round.calls.filter((call) => typeof call.args.document_id !== "string" || live.has(call.args.document_id)) }))
    .filter((round) => round.calls.length > 0);
}

export async function saveTurn(chatId: string, turn: Omit<TurnRecord, "chatId" | "createdAt">): Promise<void> {
  await turns.insertOne({ ...turn, chatId, createdAt: new Date() });
}

/** Deletes a chat: its records first, then its folder, with every file in it. */
export async function deleteChat(userId: string, chatId: string): Promise<void> {
  if (!(await isChatOf(userId, chatId))) return;
  await turns.deleteMany({ chatId });
  await chatFiles.deleteMany({ chatId });
  await chats.deleteOne({ _id: chatId, userId });
  await rm(path.join(DOCUMENTS_DIR, ...scopeOf(userId, chatId)), { recursive: true, force: true, maxRetries: 5 });
}
```

- Keep `toolTurns` in full with each question and send them back in their place. A follow-up
  question then reads what was found before, and often needs no new search
  ([Conversations](./conversations.md)).
- `historyOf` sends the rounds of the last two questions whole, and older ones through
  `compactToolTurns`: each large result becomes a stand-in with the lines or pages it showed, a
  search's query and count, and the first 6,000 characters of a whole-file read's answer or its
  first 20 items. On a chat of 15 questions over one 8,000-line log, with a whole-file read every
  third question, the first request of question 15 goes from 277K estimated tokens to 67K
  (276,271 and 66,086 when run again with a fixed clock). `storeRounds: "compact"` would cut every
  stored whole-file read's answer to 6,000 characters for good, the last two questions' too
  ([Keeping the history inside the window](./conversations.md#what-your-application-does)).
- Show `text`, and send `modelText` back as the assistant's turn (new in 0.99.13). With
  `citationMarkers: "remove"` they differ: the page gets the answer without its line citations, and
  the model gets its own words with them, so a follow-up is asked as it would be with citations
  shown.
- Keep `anchors` and `sources` with the turn (new in 0.99.14), so that a chat opened again draws
  its chips. Keep the sources without their quotes: a page reads the cited lines when it shows a
  hover card (step 5), so a file that was deleted since reads "file removed" instead of showing
  text the chat no longer has.
- An answer that is not one (`answered: false`) is not kept as the assistant's turn: the model
  would read your error message as its own words.
- The chat keeps the ID and name of each of its files (`keepFile` and `forgetFiles`, called by the
  upload handlers in step 4). `files.list` no longer lists a file once it expires or is deleted,
  and the page must still be able to name it.
- Calls on a file that expired or was deleted are left out of the history (`withoutGoneFiles`), so
  what they read is not sent again; a later version does this in the library. The model's earlier
  answers can still quote such a file.

## 4. Uploads

The browser posts the raw file, with the chat in a header. `currentUserId` stands for your sign-in:
it returns the user's ID, or `undefined`.

```ts
// server.ts, first half
import express from "express";
import { createDocumentHandlers } from "llm-large-files/node";
import { forgetFiles, isChatOf, keepFile, scopeOf } from "./chats.js";
import { files } from "./large-files.js";

export const app = express();

const documents = createDocumentHandlers(files, {
  getOwner: (request) => currentUserId(request), // undefined is answered 401 "Sign in first."
  getScope: async (request) => {
    const userId = currentUserId(request)!;
    const chatId = String(request.headers["x-chat-id"] ?? "");
    if (!(await isChatOf(userId, chatId))) throw Object.assign(new Error("This chat no longer exists."), { status: 404 });
    return scopeOf(userId, chatId);
  },
  refuseCrossSite: true, // a page of another site cannot upload into a chat, or delete from it
  onUploaded: (document, { scope }) => keepFile(scope![1], document.id, document.name), // scope is [userId, chatId]
  onRemoved: (id) => forgetFiles([id]), // the user removed it: no notice needed
  // The cited lines for a chip's hover card, through the same mask as what the model is sent
  // (`maskIds` stands for your onToolResult; null shows the lines as stored). Required to turn the route on.
  preview: { onPreview: maskIds },
});

app.post("/api/documents", documents.upload); // before any body parser: the body is the file
app.get("/api/documents", documents.list); // the files of the chat, for its panel
app.get("/api/documents/:id/lines", (req, res) => documents.preview!(req, res, req.params.id)); // ?from=12&to=14&version=…
app.delete("/api/documents/:id", (req, res) => documents.remove(req, res, req.params.id));
```

```ts
// In the browser. `file` comes from an <input type="file">.
const response = await fetch("/api/documents", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-Chat-Id": chatId },
  body: file,
});
const uploaded = await response.json(); // 201: { id, name, format, lines, estimatedTokens, expiresAt, … }; otherwise { error, category, code? }
```

- `refuseCrossSite: true` (new in 0.99.13) answers 403 to an upload or a delete that a page of
  another site made the user's browser send, before anything is read. A request with neither
  `Sec-Fetch-Site` nor `Origin` (curl, a server) is let through. Behind a proxy that changes `Host`
  without `X-Forwarded-Host`, list your site in `allowedOrigins`
  ([Security](../security.md#uploads-from-another-sites-page)).
- An error body has a `category` besides `error`, and a `code` when there is one (since 0.99.13):
  a page in another language words the error from them.
- Every status, multipart forms, progress of a long upload, and saving the uploaded file itself in
  the chat's folder: [Web app](./web-app.md#uploads-with-createdocumenthandlers).
- The preview route (new in 0.99.14) answers a chip's hover card: the cited lines (at most 50 lines
  and 8 KB), `404` alike for a file that is gone, another user's or another chat's, and `409` with
  no text when the file was replaced since the answer (`version`). It needs an explicit `onPreview`:
  pass the function you give `onToolResult`, so a preview never shows what the model was not shown
  ([Security](../security.md#quotes-and-previews)).

## 5. Questions

One route takes a question and answers with Server-Sent Events: each tool call as it runs, the text
as it is written, then `run.finish` or `run.error`.

```ts
// server.ts, second half
import { eventStream, partialResultOf, type AskEvent, type AskResult } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";
import { sseMessageOf, writeSseEvents } from "llm-large-files/node";
import { filesOf, forgetFiles, historyOf, saveTurn } from "./chats.js";
import { endpoint } from "./large-files.js";

/** POST /api/chat with { chatId, question }. */
app.post("/api/chat", express.json(), async (req, res) => {
  // What can be refused is refused before the stream starts, with a status.
  const userId = currentUserId(req);
  if (!userId) return void res.status(401).json({ error: "Sign in first." });
  const { chatId, question } = (req.body ?? {}) as { chatId?: unknown; question?: unknown };
  if (typeof chatId !== "string" || typeof question !== "string" || !question.trim()) {
    return void res.status(400).json({ error: "Send a chatId and a question." });
  }
  if (!(await isChatOf(userId, chatId))) return void res.status(404).json({ error: "No such chat." });

  const scope = scopeOf(userId, chatId);
  // The chat's own list still names the files that are gone; files.list has only those still there.
  const [kept, live] = await Promise.all([filesOf(chatId), files.list({ owner: userId, scope })]);
  const messages = await historyOf(chatId, question, new Set(live.map((document) => document.id)));
  const documentIds = [...kept.keys()]; // every file of the chat, on every question

  const stream = eventStream<AskEvent, AskResult>(
    (onEvent, signal) => askGemini({
      files,
      endpoint,
      owner: userId,
      scope,
      documentIds,
      onMissingDocuments: "drop", // a file that expired or was deleted is left out, with a notice
      touchOnUse: true, // a file the chat still uses is kept: see step 6
      citationMarkers: "remove", // line citations become chips: see below
      messages,
      streamText: true,
      onEvent,
      signal, // aborts at the deadline, or when the browser goes away
    }),
    { signal: AbortSignal.timeout(15 * 60 * 1000) },
  );
  // The notice of files that are gone has their IDs: the page gets their names too.
  const map = (event: AskEvent) =>
    event.type === "notice" && event.code === "documents_missing"
      ? { ...sseMessageOf(event), data: { ...event, names: (event.documentIds ?? []).map((id) => kept.get(id) ?? "a file") } }
      : sseMessageOf(event);
  await writeSseEvents(res, stream, { end: false, map }); // the response stays open until the question is kept

  // The tool rounds come from the result, never from the events. A question that failed or was
  // stopped keeps what it read too, so that asking again need not search again.
  const result = await stream.result.catch((error: unknown) => {
    console.error("A question failed or was stopped", error); // the provider's own words: for your log, not for the page
    return partialResultOf(error);
  });
  if (result) {
    await saveTurn(chatId, {
      question,
      toolTurns: result.toolTurns,
      ...(result.answered ? { text: result.text, modelText: result.modelText, anchors: result.anchors, sources: result.sources?.map(({ quote: _quote, ...source }) => source) } : {}),
      usedDocumentIds: documentIds.filter((id) => !result.missing?.includes(id)),
      ...(result.finish !== undefined ? { finish: result.finish } : {}),
      usage: result.usage,
    }).catch((error: unknown) => console.error("could not keep the question", error));
    // The page has named them: they are not named again.
    if (result.missing) await forgetFiles(result.missing).catch((error: unknown) => console.error("could not forget the files that are gone", error));
  }
  if (!res.writableEnded) res.end();
});
```

The page reads the events and shows them:

| Event | Show |
|---|---|
| `tool.start`, `tool.end` | What the model is doing: `label`, then `step` ("Search app.log (exact) for “timeout” — 12 matching lines"). |
| `text` | The answer, growing: add each `delta`. |
| `citation` | A chip (new in 0.99.14): at `anchor.at` in the text shown so far, opening `sources` (the file, and a sheet and row, a page, a slide or a clause). See "Chips" below. |
| `notice` | Most codes need nothing. `documents_missing`: files of the chat that expired or were deleted, which the question was answered without: show `names` ("contract.txt is no longer available"). `read_incomplete` (new in 0.99.13): a whole-file read could not read some of its parts, and the model was told to say its answer is incomplete. |
| `run.finish` | The end. `result.answered` is `false` when no answer came: show your own message. |
| `run.error` | `error.message`, which is safe to show, or your own words for `error.kind`. |

- The code of a page that reads these events, a Stop button, and a question sent again after a
  broken connection: [Web app](./web-app.md#reading-the-events-in-the-browser).
- Show labels and steps as plain text, never as markdown or HTML: they quote the model's words,
  which a file can steer.
- With `citationMarkers: "remove"`, an answer made only of line citations comes as the lines in
  words ("line 8", "שורה 8") in the `text` events, with a `citations_only` notice (new in 0.99.13):
  the page needs nothing more.
- The model answers in the language of the question. The labels, the steps and the error messages
  are English: for a page in another language, show your own words for each event and each kind of
  error. The messages of a chatbot for Hebrew speakers are in
  [Errors and reliability](./errors-and-reliability.md#your-users-words-errorinfoof).

### Chips

With `citationMarkers: "remove"` (new in 0.99.14) the model cites as it always did, the citations
leave the text, and each one leaves a chip: `result.anchors` says where it goes in `text`, and
`result.sources` what it opens. A `citation` event brings each one while the answer streams, and
`run.finish` brings them all, so a page that joined late, or opened the chat again, draws the same
chips.

```ts
// In the browser: a chip after the text it cites. `describeLocator` gives "גיליון לקוחות · שורה 8".
import { describeLocator, type CitationAnchor, type CitedSource } from "llm-large-files/client";

function chip(anchor: CitationAnchor, sources: Map<string, CitedSource>): HTMLElement {
  const source = sources.get(anchor.sources[0]!)!;
  const place = describeLocator(source.locators[0]!, "he");
  const button = document.createElement("button");
  button.className = "chip"; // CSS: user-select: none, so a copied answer has no chip numbers in it
  const isolated = document.createElement("bdi"); // keeps the chip's own direction in a Hebrew sentence
  isolated.textContent = String(anchor.label);
  button.append(isolated);
  button.setAttribute("aria-label", `מקור: ${[source.name, place].filter(Boolean).join(", ")}`);
  return button;
}
```

- Put each chip in a `<bdi>`, give it an accessible name that says the source, and never put a bare
  number next to a number of the answer: "30 ש״ח 1" reads as a price. A chip label is its
  `anchor.label`, 1 for the first chip of the answer.
- `user-select: none` keeps the chips out of a copy; a copy handler can add the sources as
  footnotes.
- The hover card fetches the cited lines from the preview route of step 4, with the source's
  `documentId`, `from`, `to` and `version`. Show them with `dir="auto"`. A `404` reads "file
  removed", and a `409` "the file was replaced since this answer".
- A source of a whole-file read may name lines the model saw only through the read's notes
  (`seen: "noted"`): the preview shows the lines themselves.
- For a page that renders Markdown, `citationMarkers: "token"` puts `⟦1⟧` at each chip's place in
  the text, which survives trimming; `insertCitationTokens` makes the same text from the anchors.

### A chat with files as knowledge, and no chips

A chat where the files are background, such as a group chat that answers from a shared handbook,
may show no chip and no preview. Ask with `sources: "off"` (new in 0.99.14): the text is as with
`citationMarkers: "remove"`, no `citation` event is sent, and `anchors` and `sources` are empty in
the result, so no event and no SSE message carries a file name, a sheet and row, or a quote of a
source. The model is asked as it always is.

```ts
// server.ts: the route of a group chat. A preview is refused for its files.
import { askGemini } from "llm-large-files/gemini";
import { createDocumentHandlers } from "llm-large-files/node";

const groupDocuments = createDocumentHandlers(files, {
  getOwner: (request) => currentUserId(request),
  getScope: async (request) => groupScopeOf(request),
  // The lines of a group chat's files are never previewed: every preview is refused (403, no text).
  preview: { onPreview: () => ({ reject: "This chat shows no sources." }) },
});

const result = await askGemini({ files, endpoint, owner, scope, documentIds, messages, sources: "off" });
```

- `result.citations` keeps its meaning, for checks on your server, and `modelText` is the model's
  own text as always.
- The model is not told to keep file names out of its words: a line in your own `system` text can
  ask it to.
- The simplest way to refuse previews is not to mount the preview route for those chats; the
  refusing hook above serves a route that both kinds of chat share.

## 6. Deleting and expiry

- **A chat.** `deleteChat` above removes the records, then the folder. An upload that arrives after
  that is answered `404`, and writes nothing.
- **A file.** The `DELETE` route of step 4. `onRemoved` takes it off the chat's list.
- **Expiry.** With `touchOnUse` (new in 0.99.13), a question touches its files (here, every file of the chat) once
  less than half of their 72 hours is left, so a file is kept 36 to 72 hours past the chat's last
  question. A file that expired, or was deleted other than by the route, is left out of the next
  question with a `documents_missing` notice, which the page shows by name. The chat then forgets
  it, and its calls stay out of the history
  ([Documents that are gone](./conversations.md#documents-that-are-gone)).
- **The sweep.** An expired document is never read, but its files stay on the volume until a sweep
  removes them. Run the sweep from a scheduled job (a Kubernetes CronJob, cron), not from the servers
  that answer users: on every server, each would list every chat's folder
  ([Sweeping expired documents](./deployment.md#sweeping-expired-documents)).

```ts
// sweep.ts: run every hour by a scheduled job.
import { files } from "./large-files.js";

const removed = await files.sweep();
console.log(`Removed ${removed} expired documents.`);
```

## When the model has tools of your own

`askGemini` and `askWithFiles` run the whole loop, and offer the model only the library's tools.
If your chatbot's model also calls tools of the application in the same question (a search of your
knowledge base, a look-up in your database), keep your own loop and add the documents to it:
`files.prepare()` gives the text and the instruction for the request, and `files.tools()` gives
the tool declarations, next to which you declare yours, and runs the library's calls. Steps 2 to 4
of this page stay as they are; step 5 becomes your loop
([Your own adapter and loop](./own-adapter-and-loop.md#your-own-loop)).

## Before production

- **Uploads you do not trust** are read in child processes with a memory limit:
  `createLargeFiles({ extractors: createIsolatedExtractors().extractors, … })`
  ([Security](../security.md#uploads)).
- **Memory.** Size the server for the files it reads at once
  ([Deployment](./deployment.md#memory-on-each-server)).
- **Proxies.** A proxy between the browser and the server must not buffer the stream, and must wait
  longer than a question takes ([Deployment](./deployment.md#streamed-answers-behind-proxies)).
- **Cost.** Every question has a ceiling on its input tokens by default. Set your own, and count
  `result.usage` for each user ([Costs and limits](./costs-and-limits.md#the-limits-of-a-question)).
- **Errors.** What each failure means and what to tell the user
  ([Errors and reliability](./errors-and-reliability.md)).
- **Tests.** The same routes with a scripted model, without a key ([Testing](./testing.md)).
