# Security

Uploaded files often hold sensitive data: production logs, contracts, customer exports. This page
says what the library does to keep each document to its owner and each question within bounds,
what it leaves to your application, and what reaches your model provider. Read it before you
deploy.

## Ownership

A document can have an owner: one string, such as the signed-in user's ID or a tenant's, compared
exactly as it is. Set it at ingest, and pass the same owner to every call that reaches the
document:

```ts
import { askWithFiles } from "llm-large-files";
import { askGemini } from "llm-large-files/gemini";

// `files` is your createLargeFiles() instance, `model` your adapter (for Vertex AI,
// gemini(vertexAi({ ... }))) and `endpoint` a vertexAi({ ... }) endpoint. `userId` comes from
// your sign-in session, never from the request body. `bytes`, `documentIds` and `messages` (an
// array of `ChatTurn` and `ToolTurn`, which both calls take) are yours.
const owner = userId;

const meta = await files.ingest({ name: "app.log", bytes, owner });
const current = await files.getMeta(meta.id, { owner });
const original = await files.getOriginal(meta.id, { owner });
const result = await askWithFiles({ files, model, documentIds, messages, owner });
// askGemini passes `owner` on to askWithFiles.
const geminiResult = await askGemini({ files, endpoint, documentIds, messages, owner });
const deleted = await files.delete(meta.id, { owner });
```

A document that has an owner is used only by calls that pass that owner. A call with another
owner, or with none, gets what it gets for a document that does not exist: `undefined`, `false`,
`missing`, `DocumentsNotFoundError` or a 404 (the table is in
[Storage](./guides/storage.md#how-ownership-works)).

A caller cannot tell a document of another owner from one that never existed or has expired.
`toDocumentSummary`, which the upload handlers answer with, leaves the owner out.

**An owner must be a string that is not empty.** `files.ingest` throws a `TypeError` for an owner
of `""`, of spaces only, or `null`:
`owner must be a string that is not empty or only spaces, such as the signed-in user's ID. To let anyone with the document's ID use it, leave owner out.`
Such an owner, which `user?.id ?? ""` gives a caller who is not signed in, would be one owner
shared by every caller without a user: each of them could read and delete the documents of the
others whose IDs it has. From JavaScript, an owner that is neither a string nor a finite number
(the user object in place of its ID, `true`, `NaN`, an array) is refused with the same error. A
number is accepted, as before. Only `ingest` and the upload handler refuse: calls that read with
`owner: ""` work as before, so documents that 0.5.0 stored with that owner stay readable until
they expire.

**A document ingested without an owner is open to every call that has its ID**, with an owner or
without. Its ID then works like a password. An ID is `doc_` and 32 hex digits, a random UUID with
122 random bits: it cannot be guessed, but it can leak. The ID of a document the model reads
through tools is in its card and in the system instruction your model provider receives (so a
model can repeat it in an answer), and IDs end up in your URLs, in browser storage and in logs.
Give every document an owner.

What the owner should be (a user, or a user and a chat session), and how to keep a list of a
session's documents, is in [Storage](./guides/storage.md). The owner stops one user from reaching
another's documents. It does not stop one user from mixing documents of their own sessions: take
`documentIds` from your session record, not from the browser.

### Requiring a signed-in user in the handlers

`createDocumentHandlers` calls `getOwner` for every request but an upload with no file name (no
`X-File-Name` header and no `?name=`), which is answered 400 before `getOwner` runs. When
`getOwner` returns `undefined`, the request is anonymous: an upload is stored without an owner, and
GET and DELETE reach only documents that have none. To refuse a request instead, throw an error
with a `status` (or `statusCode`) between 400 and 599: the handler answers with that status and the
error's message. Any other error is answered with a 500 that does not repeat its message.
`getOwner` runs before the body is read, so a refused upload is not buffered.

An owner that `ingest` refuses is the server's mistake, and the upload is answered with a 500
before its body is read: `{ "error": "Upload failed (empty owner)." }` when `getOwner` returns
`""`, a string of spaces or `null`, and `{ "error": "Upload failed (owner is not a string)." }`
when it returns something that is neither a string nor a finite number, such as the user object in
place of its ID. Nothing is logged. Where every upload needs a signed-in user, throw a 401 as
below. Return `undefined` only where anonymous uploads are meant (`user?.id || undefined`). GET and
DELETE pass such an owner on as before.

```ts
import type { IncomingMessage } from "node:http";
import { createDocumentHandlers } from "llm-large-files/node";

// `files` is your createLargeFiles() instance. Your sign-in middleware sets `request.user`.
type SignedInRequest = IncomingMessage & { user?: { id: string } };

export const documentHandlers = createDocumentHandlers(files, {
  getOwner(request) {
    const user = (request as SignedInRequest).user;
    // Returning undefined would store the upload without an owner, open to anyone with its ID.
    if (!user) throw Object.assign(new Error("Sign in first."), { status: 401 });
    return user.id;
  },
});
```

The routes, statuses and the rest of the upload flow are in [Web app](./guides/web-app.md) and the
[node reference](./reference/node.md).

## Tool scoping

`files.tools(documents)` reads only the documents it was made with. A model, or a prompt injected
into a file, that names any other document ID is answered `Unknown document_id …`, with the IDs it
may use. `view_pages` has its own list: the PDFs whose original is kept (in a store that has
`getOriginal`), among the documents passed to `tools()` (`viewPages: true`) or in the list given as
`viewPages`. A call for any other document is refused: one that `tools()` reads as text is answered
that only its text was kept, any other is an unknown `document_id`.

`askWithFiles` and `askGemini` make one tool set per question, from the plan that `prepare` made
with the question's owner. You have nothing to do.

**`files.tools()` checks owners through the metadata it is given.** It has no owner option. On
every call that reads a document's text or the pages of its PDF, it checks that the document is
still in the store and has not expired, and compares the owner stored with the document with the
`owner` of the `DocumentMeta` you passed for that ID. When they differ, the call answers
`doc_… is no longer available on the server. Ask the user to attach the file again.`, as for a
document that is gone, and `view_pages` shows no page. So metadata built from an ID a client sent,
with no owner or another one, reads nothing of a document that has an owner. The check compares
strings: metadata that carries the stored owner reads the document, wherever it came from, and a
document stored without an owner is open to any metadata. (Before 0.6.0, `tools()` checked no
owner.) In a tool loop of your own, give it only metadata that `prepare(ids, base, { owner })` or
`getMeta(id, { owner })` returned, never objects built from IDs a client sent:

```ts
import { DocumentsNotFoundError } from "llm-large-files";

// Your own loop: `base` is the size of the rest of your request. The tools below have no
// `generate`: `wholeDocumentAnalysis: false` keeps the instruction from naming
// `analyze_whole_document`, and the cards from offering a whole-file read.
const prepared = await files.prepare(documentIds, base, { owner, wholeDocumentAnalysis: false });
if (prepared.missing.length > 0) throw new DocumentsNotFoundError(prepared.missing);
const tools = files.tools(prepared.plan.searchable);
```

Writing your own loop is covered in [Your own adapter and loop](./guides/own-adapter-and-loop.md),
and every tool, its arguments and its limits in the [tools reference](./reference/tools.md).

## What is sent to model providers

The library sends data only through the adapters: to the provider's API (each adapter's default),
or to the URL you configure instead (an endpoint, a `baseUrl` or `url`, or your own gateway). It
makes no other network request and sends no telemetry.

A question's requests can hold:

- **The whole text of every document that fits**, framed by its name, at the start of the first
  user turn by default (`documentPlacement`). It is in every request of the question, and it is
  planned again, and sent again, for every later question that names the document.
- **A card for each document too large to send whole**: its name, ID, format, size, lines, pages
  and estimated tokens; for a log, its levels, time range and up to 8 message templates; up to 40
  outline headings; and its first 25 lines.
- **Tool results**: excerpts of the text (search hits, line ranges, the first and last lines), each
  up to `toolResultCharacters` (24,000 characters by default); the answer of a whole-file read is a
  tool result too, up to 40,000 characters (or `toolResultCharacters` when that is larger).
- **The whole text of a file read whole** (`analyze_whole_document`), in parts of up to
  `mapChunkTokens`, through the adapter's `generateText`.
- **Pages**: with `view_pages`, a small PDF of up to 5 pages cut from the kept original, for each
  call. The pages stay in the later requests of that question, unless room runs out: older
  results, pages included, are then replaced by a note of what they showed (never for a model whose
  conversation may only grow, as Claude's). They are not kept in `toolTurns`: only that they were
  shown.
- **File names, and the IDs of the documents read through tools.** Not the owner, and no original
  file other than those page cuts.
- **Whatever you pass in `messages`**: earlier questions' `toolTurns`, which hold excerpts of the
  files, and parts in a provider's own form.

The words of a failed model request are not among them. When a request of a whole-file read fails,
the model is told why by the error's kind, its HTTP status, the code of a connection that failed,
or a timeout, never by the error's message, which can name a project, a host, a masked key or a URL
with a key in it ([What the library logs](#what-the-library-logs)).

All of this but the parts of a whole-file read goes to every model of the question. With an
[explorer model](./guides/explorer-model.md), both models get the conversation with the
documents; the explorer makes the tool calls and alone reads files whole in parts, and the
answering model gets those calls and their results (the read's answer, not its parts), pages
included. When the two are of different providers, the files reach both.

What a provider keeps, for how long, and where it processes the data is set by your agreement with
it and by the endpoint you choose: for Vertex AI, the `location` of `vertexAi()`, which is
`"global"` by default ([Gemini API and Vertex AI](./guides/vertex-and-gemini.md)). Prompt caching
keeps a copy at the provider for a while: the Claude adapter asks for it by default (`cache: true`,
five minutes; `false` sends none), and `documentPlacement: "first"`, the default, puts the
documents where a provider's own cache can reuse them.

What comes back is read with one bound of its own. One event of a streamed reply holds at most
64,000,000 characters: a longer one ends the reply with an error of kind `"invalid"`, such as
`The model's reply could not be read: an event of its stream held more than 64,000,000 characters.`,
and the request is not sent again. A reply made of many events has no cap on its size, nor on its
time while it keeps arriving. An endpoint you do not trust, such as a gateway run by someone else,
can still take the memory of your server.

## Prompt injection

The model reads text you do not control: the content of the files, their names, the pages it looks
at. A file can hold instructions ("ignore previous instructions…"). The library does not filter or
detect instructions. It keeps the frame around a file intact, removes most characters that show
nothing, and marks text that Word and PowerPoint hide, so that what the model takes for a file's
text is closer to what a person sees in it. None of this stops an instruction written in plain
sight.

What limits the damage:

- **The tools only read**, and only the documents of the question ([Tool scoping](#tool-scoping)).
  No tool changes your data or reaches anything but the store and the models of the question (a
  whole-file read sends the file to the model that explores, in parts).
- **The cost of a question is bounded** ([What a question can cost](#what-a-question-can-cost)),
  whatever a file asks for.
- **A file cannot pass for the end of its frame.** The lines around a file sent whole carry a mark
  that its text cannot know, and the first one tells the model that the file ends only at the line
  with that mark. The mark does not make the model obey, and it is not a secret
  ([The frame around a file](#the-frame-around-a-file)).
- **Most characters that show nothing are removed** at ingest, from the text and from the file name:
  tag characters, zero-width spaces, the controls that reorder what a person sees
  ([Characters that show nothing](#characters-that-show-nothing)).
- **Text of hidden runs in Word, and slides the slide show skips, are marked** as such; text hidden
  in other ways is not ([Hidden text in Word, PowerPoint and HTML](#hidden-text-in-word-powerpoint-and-html)).
- **A file name cannot add lines to the instruction.** At ingest it is reduced to one printable line
  without most characters that show nothing (see [Uploads](#uploads)), and the system instruction
  and the frame quote it as a JSON string. It is still text the model reads, like the file's
  content.

What a hostile file can still do:

- **Steer the answer**: state false things, leave things out, claim that another file says
  something. `result.evidence` lists the documents, lines and pages each tool call showed the model,
  and the model is asked to cite line numbers: show them, so a user can check.
- **Bring another document of the same question into the answer.** Every document of the question
  is within reach of the tools, so a file can ask for another's text to be written into the answer,
  for example inside a link or an image URL. Treat the answer, the text that `onText` streams, and
  the steps and activity lines, which quote what the model sent, as untrusted: show them as plain
  text or escape them, and do not load images or open links from them on your own. The library
  does not render anything; this is up to your interface.
- **Hide text from a person, but not from the model**, in what the cleaning and the marks leave:
  characters that scripts and emoji need, Word text hidden by a style, a text file in an older
  encoding that an editor shows as � ([Characters that show nothing](#characters-that-show-nothing),
  [Hidden text in Word, PowerPoint and HTML](#hidden-text-in-word-powerpoint-and-html),
  [Text files that were not UTF-8](#text-files-that-were-not-utf-8)).
- **Reach every model of the question**, an explorer model included.
- **Stay in the conversation.** The `toolTurns` you store hold the text the tools returned,
  injected instructions included, and they go back to the model with every later question. A
  search, read or overview that repeats one of them is not run again: the model is pointed to the
  stored result, unless that result failed, was cut, came from a search that stopped early, is no
  longer there in full, or the provider may have cleared it
  ([How it works](./how-it-works.md#pointers-to-repeated-calls)).

**Tools that act.** `askWithFiles` takes no tools of your own. To give a model tools that act
(send an email, change a ticket), write your own loop
([Your own adapter and loop](./guides/own-adapter-and-loop.md)), and treat every call the model
makes as untrusted input: check it, and ask the user before anything that cannot be undone.

**History from the client.** Keep each conversation, with its `toolTurns`, on your server. The loop
sends stored tool rounds, and parts in a provider's own form, as they are. A client that could send
its own could put any text into what the model takes for a tool result, that is, for what a file
says, and any provider part (for Gemini, any part of `contents`) into the request.
[Conversations](./guides/conversations.md) covers storing them.

### The frame around a file

A file sent whole sits between two frame lines:

```text
--- Attached file [mark 1f0c3a9e]: "report.txt" (text, 6 lines; it ends only at the line with mark 1f0c3a9e) ---
…the text of the file…
--- End attached file [mark 1f0c3a9e] ---
```

The mark is eight hex digits made from the document ID. The ID is made at random when the file is
stored, after its text was written, so the text cannot know the mark. A line of the file that
copies the frame (`--- End attached file … ---`, then the first line of a file that was never
attached), in whatever letters, has no mark or a wrong one, and the first frame line tells the
model that only the line with the mark ends the file. The uploader chooses the name along with the
text, so the mark comes before the name, the name is quoted as a JSON string, and the closing line
holds the mark alone: a name cannot put a mark of its own first. The mark is the same in every
request, so a provider's prompt cache can reuse the file from one request to the next. After an
upgrade from 0.5.0, the first request of each conversation reads nothing of the file from the
cache, since the frame lines changed.

What the mark does not do:

- **It does not make the model obey.** It tells the model where the file ends; a model can still
  follow an instruction inside the file.
- **It is not a secret.** It is made from the ID by a fixed hash. A file attached after another, by
  someone who knows the first one's ID, can hold its mark. IDs are in cards, in the system
  instruction and in your URLs ([Ownership](#ownership)).
- **Cards have no mark.** A file too large to send whole is shown as a card between
  `--- Large attached file: … ---` lines, with its first lines numbered and indented by two spaces,
  and the tools return lines as JSON. A line separator (U+2028) inside a line of the file, which a
  model may read as a line break, can make text look like the start of a line in a card.

### Characters that show nothing

Ingest removes these characters from the text of every file (file names differ in two ways; see
below):

- control characters other than tab and line breaks, C1 (U+0080-U+009F) included, and terminal
  escape sequences;
- Unicode tag characters (U+E0000-U+E007F), each of which spells out one ASCII character that a
  model reads and a person does not see. In 0.5.0, a line with 44 of them sent all 44 to the model,
  in the prompt and in tool results. The flags of England, Scotland and Wales, which are written
  with them, are kept; any other flag written with them keeps only its black flag;
- the text-direction controls that change the order a person sees: embeddings and overrides
  (U+202A-U+202E) and isolates (U+2066-U+2069);
- the zero-width space (U+200B), the word joiner and the invisible operators (U+2060-U+2064), the
  deprecated format characters (U+206A-U+206F), a byte order mark inside the text (U+FEFF), and the
  soft hyphen (U+00AD), but not one at the end of a line, where it shows.

Kept, because scripts and emoji need them: the marks that right-to-left text needs (U+200E, U+200F,
U+061C), zero-width joiners and non-joiners (U+200C, U+200D), variation selectors (U+FE00-U+FE0F,
U+E0100-U+E01EF), Hangul fillers, and the line and paragraph separators (U+2028, U+2029). A few
others that show nothing pass too, such as U+034F, U+180E, U+FFF9-U+FFFB and the private use area.
A crafted file can still carry text a person does not see in them: in the review of 0.6.0, 32 bytes
written as variation selectors after one emoji reached the model whole, in the prompt and in a
tool result, and the line showed only the emoji. The library does not detect instructions there,
nor anywhere else.

File names lose the same characters, with two differences. A control character, a line or
paragraph separator and every text-direction control, the marks of right-to-left text included,
become a space. And an escape sequence is not removed whole: its ESC becomes a space, and the rest
stays (`re\x1b[31mport.txt` is stored as `re [31mport.txt`).

No line break is added or removed, except in a text with no line feed, where U+0085 ends lines
([Uploads](#uploads)). A line of more than 2,000 characters that held such characters can be split
into fewer pieces than 0.5.0 split it, which moves the lines after it. Documents stored by an
earlier version keep their text until they expire. Steps and activity lines drop the same
characters ([What the library logs](#what-the-library-logs)).

### Hidden text in Word, PowerPoint and HTML

A DOCX can hold text that Word does not show, a PPTX slides that the slide show skips, and an HTML
page text that a browser does not show. Their text is kept, and marked:

- **Text of a hidden run** (`<w:vanish/>` in the run's own properties) comes after the text of its
  paragraph that shows, and each of its lines starts with
  `[Hidden text, not shown in the document]`. A carriage return, a U+0085 or a line separator in it
  starts a new marked line. A line longer than about 1,950 characters is cut into pieces, each
  marked, so that no piece is stored without its mark. The text of a run inside a hidden run, such
  as the reading of a ruby, is marked too, and so is the rest of the hidden run after it.
- **A hidden slide** (`show="0"`) has the heading
  `## Slide 2 (hidden, not shown in the slide show)`. Its text is kept.
- **Text an HTML page hides** (an element with the `hidden` attribute, or an inline style of
  `display: none` or `visibility: hidden` or `collapse`) is marked the same way, line by line and
  in pieces. Hidden text inside a line that shows comes after that line, not where it stood. A row
  of a table that the page hides is written marked, in its place. The hiding ends where the element
  does; an element the page never closes hides the rest of its parent. A `hidden` attribute or a
  style is read in the first 4,096 characters of its value.

The attributes of `w:vanish` and of a slide's `p:sld` are read however long the tag is, and by
their exact names, as XML reads them: `W:VAL="0"` is another attribute, and the run stays hidden.

The mark is a hint, not a filter. Text without it may still be hidden, and a document's own text
can write the mark. Not told apart, and read as text that shows:

- text hidden through a character or paragraph style, and white or tiny text;
- in HTML, text hidden by a style sheet, a class, a script, `opacity`, a position off the page or
  a `<template>` (dropped, like scripts), and an `aria-hidden` element, which a browser shows;
- hidden shapes on a slide that shows;
- the content of `mc:Choice`, which the library reads where Word may show `mc:Fallback` instead
  (the Fallback is not read);
- tags written with a namespace prefix other than `w:` or `p:`, and a text box inside a hidden run;
- a `show` value written as a character reference (`show="&#48;"`); the same in a `w:val` marks
  text that shows as hidden;
- parts that no relationship references, such as an orphan header (a slide that
  `ppt/presentation.xml` does not list is not read, unless the deck lists none).

Speaker notes are read since 0.8.0, after a line `[Speaker notes]` under their slide, and so are
the comments of a DOCX, under `# Comments`: they are text a reader of the slide show or the page
does not see either. The marks count toward `maxTextBytes` and the limit of 32 million
characters.

### Text files that were not UTF-8

A text file that is not valid UTF-8 is read in the older encoding that its lines with letters fit,
when one does: windows-1255, windows-1256, windows-1251, Shift_JIS or windows-1252
([How it works](./how-it-works.md#text-encodings)). `meta.encoding` names it, and the model is told.
An editor that opens the file as UTF-8 shows those lines as �, so a person who checks the file there
does not see what the model reads. Three lines of instructions in windows-1251 between two lines of
UTF-8 reach the model as Cyrillic text, while the editor shows the two lines and �. Lines that are
valid UTF-8 read the same in both. Show `meta.encoding` to the user ("read as windows-1251"), and
check such a file in an editor set to that encoding.

The choice is made line by line. A line counts as UTF-8 when it holds at least as many characters
of more than one byte as characters that are not valid, and the file is read as UTF-8 when at least
as many lines count as UTF-8 as count as not, or when at most one line in 200 is not UTF-8. So lines
in an older encoding inside a mostly UTF-8 file become U+FFFD, and a few lines of half-width
katakana in Shift_JIS, whose bytes can pair into valid UTF-8 by chance, can be read as UTF-8 with
U+FFFD. `meta.replacedCharacters` counts the U+FFFD, and the model is told of them.

## Storage and retention

- **Expiry.** A document expires `ttlMs` after its upload (72 hours by default). Its `expiresAt` is
  set at ingest and no call moves it. `ttlMs: Infinity` keeps documents until they are deleted
  (`expiresAt` is then `NEVER_EXPIRES`). An expired document is never returned, by any call, on any
  server. Set the time to live to match your data policy.
- **Removing expired files is up to you.** `files.sweep()` asks the store to remove expired
  documents and returns how many it removed. Nothing calls it for you: run it on a schedule, from
  one place ([Deployment](./guides/deployment.md)). A store without `sweep` removes nothing, and
  `files.sweep()` returns 0. `FileDocumentStore` also removes an expired document when it next reads
  its metadata, and its `sweep` removes the files of failed uploads once they are `orphanAgeMs` old
  (one hour by default). `FileDocumentStore`'s `sweep` throws nothing: a directory it cannot read
  gives 0, and a document it cannot remove is left for the next sweep. Watch the count it returns,
  and the volume, to know that expired files really go.
- **A delete takes effect on every server that shares the store, from the next tool call on.**
  Every use of a document first asks the store whether it is still there. A copy kept in memory
  (within `cacheBytes`, 256 MB by default) is used only after that, and dropped when the document
  is gone.
- **What a delete or an expiry does not reach.** The `toolTurns` you stored with a conversation hold
  excerpts of the files word for word, up to `toolResultCharacters` each, and are sent again with
  later questions. Neither reaches the answers, steps and evidence you stored, your logs, or what
  your model provider keeps. To forget a document, also drop the tool rounds that name it from the
  stored conversation ([Conversations](./guides/conversations.md)).
- **`FileDocumentStore` writes plain files** in one directory: `<id>.txt`, the text; `<id>.json`,
  the metadata (owner, file name, MIME type, sizes, dates, outline headings and, for a log, its
  message templates); `<id>.idx`, a line index; `<id>.bin`, the original with `keepOriginals`; and
  `.tmp` files while it writes. Nothing is encrypted, and a delete removes the files without
  overwriting them. Use an encrypted volume, or write a `DocumentStore` over storage with encryption
  at rest ([Storage](./guides/storage.md)).
- **No path traversal.** Only IDs that match `DOCUMENT_ID_PATTERN` (`doc_` and 32 lowercase hex
  digits) reach the file system. File names never become paths.
- `MemoryDocumentStore` keeps everything in the memory of one process, until it restarts. It is for
  tests and single-process demos. It copies the metadata it is given and the metadata it hands out,
  so deleting `owner` from what `ingest` or `getMeta` returned, before you send it to a browser,
  changes nothing stored. (In 0.5.0 it opened the document to every owner.) The original it returns
  is the stored bytes themselves: treat them as read-only.

## Original files

With `keepOriginals` (for example `["pdf"]`), the uploaded file itself is stored next to its text
(`<id>.bin` in `FileDocumentStore`). That is off by default, and a store without `putOriginal`
keeps none. When you turn it on:

- **More is kept than before.** The text of a PDF leaves out its pictures, signatures, stamps and
  hidden layers; the file has them all, and its metadata (author, software, dates). Treat the store
  as you treat the uploads themselves.
- **It follows the document.** The file has the document's owner and its expiry.
  `files.getOriginal(id, { owner })` returns it only to the document's owner, or to any caller with
  the ID when the document has none. It returns `undefined` once the document has expired, and
  `delete` and `sweep` remove the file from disk. A store of your own must do the same in its
  `delete` and `sweep`.
- **Serving it is up to you.** `createDocumentHandlers` has no route that returns an original. If
  you send the bytes of `getOriginal` to a browser, do not take the content type from the stored
  `mimeType`: the client declared it at upload ([Uploads](#uploads)). Choose it from `format`, and
  send the file as a download (`Content-Disposition: attachment`).
- **It takes space.** Up to `maxUploadBytes` (100 MB) per document, for `ttlMs` (72 hours). Lower
  either, or sweep more often, if disk is short.
- **Pages go to the model.** `view_pages` sends the pages the model asks for to every model of the
  question, as the text of the file already goes. A PDF that is encrypted only to restrict printing
  or copying is opened with an empty password, and the cut is not encrypted: the restriction does
  not travel with it. A PDF that needs a password to open is not shown.

How `view_pages` works, and what to weigh before you keep originals, is in [PDFs](./guides/pdfs.md).

## Reading PDFs for pages and pictures

Three features read the whole PDF into objects with `@cantoo/pdf-lib`, in your process, on a file
a user uploaded:

- **`view_pages`** reads the kept original again for every call, to cut the pages out of it.
- **Picture marks** and **the page check** read every PDF at ingest, once for both, when
  `@cantoo/pdf-lib` is installed, whether or not originals are kept. The page check refuses a page
  that would hold the server while pdf.js reads it ([Uploads](#uploads)), before pdf.js reads any
  page. A page that shows a picture or a drawing gets the line
  `[Picture on this page. This text cannot show it.]`.

What bounds them:

- **Memory.** About twice the size of the file, plus 1 to 1.6 KB for each object in it
  ([measured](./measurements.md#what-a-cut-costs-the-server)). A crafted file can take far more.
  Each object is built in one step, and nothing checks it before: one MB of a file took 6 to
  91 MB of heap, by what it holds (empty dictionaries the most), and a stream unpacked twice packs
  such objects thousands of times. An upload of 16 MB that is one array of one-digit numbers ran a
  heap of 256 MB (`--max-old-space-size=256`) out of memory at ingest, a look at the pages of one
  of 8 MB did the same, and a file of 32 KB, an array of 32 MB packed in an object stream, ran a
  heap of 512 MB out of memory at ingest ([measured](./measurements.md#the-server)). What a stream
  unpacks to is outside the heap, where `--max-old-space-size` does not limit it: a look at a PDF
  of 1.6 KB whose object stream unpacks to 512 MB took 1.1 GB of the process's memory and 1.0 s in
  one block, with 20 MB of heap. Such files declare few objects, so the limits below do not see
  them. Before reading, the library looks up the number of
  objects the file declares. `view_pages` refuses a file that
  declares more than 1,000,000 objects, or more than 60% of the free heap holds at 1,700 bytes an
  object: the model is told
  `report.pdf: This PDF has 1,200,000 objects, too many to cut pages from it in memory.`
  Picture marks and the page check skip a file past 150,000 objects: it is ingested with no page
  marked, and no page checked. Both limits trust the number the file declares at its end: a file
  that declares fewer objects than it has, or none, is read, and so is one with a cross-reference
  stream inside it that declares more. `@cantoo/pdf-lib` makes an entry for each object such a
  stream declares, whatever it holds: in a file of 8.7 KB, a million of them took 0.7 s, and four
  million ran a heap of 512 MB out of memory.
- **Memory kept.** `@cantoo/pdf-lib` keeps every name and every reference it reads, for the life of
  the process: in the server that ingests, and in the one that answers `view_pages`. After the
  document was dropped, 2 MB of different names still took 37 MB of heap, and the million entries
  above about 140 MB. A file read again adds nothing, and real PDFs add little: names such as
  `/Type`, and references to the same object numbers, are kept once for all files. But each file
  with other names or other object numbers adds its own: files of 9 KB that each declared a million
  new objects added about 140 MB each, and the fourth ingest ran a heap of 512 MB out of memory. On
  the server that answers `view_pages`, the seventh look at such files ran a heap of 1 GB out of
  memory, and that memory comes back only when the server restarts. A process of its own for each
  ingest, as [Deployment](./guides/deployment.md#uploads-and-ingest) shows, gives it all back when
  it ends, and so do the child processes of
  [`createIsolatedExtractors`](./reference/node.md#createisolatedextractorsoptions), each replaced
  after 50 files and stopped when idle. For the documents of users you do not trust, do not offer
  `view_pages` (`viewPages: false`), or keep no PDF originals.
- **Time.** Reading cannot be interrupted once it has started, not even by the question's `signal`.
  It pauses so that other requests get a turn after every 12 ms of work, or up to 40 ms where a
  pause itself takes long, as a timer does on Windows. (Until 0.6.0 it paused every 4,000 objects,
  and 4,000 objects of a large file took 0.5 to 0.8 s.) `view_pages` pauses the same way while it
  copies the pages and writes the cut. What `@cantoo/pdf-lib` reads in one step still holds the
  server, and grows with the file: one object takes about 0.1 to 0.35 s for each MB, by what it
  holds, so a crafted PDF of 16 MB that is one array of numbers held the server for 1.6 to 3.2 s at
  ingest and 1.7 to 3.5 s on each look, on a heap that could hold it (up to 984 MB for a look), and
  a cross-reference table written as text takes 0.15 s for 150,000 objects. The first PDF of a process also loads `@cantoo/pdf-lib`, in one block of
  about 0.4 s, unless the server loads it when it starts ([measured](./measurements.md#the-server)).
  `view_pages` has no time limit.
  Picture marks pause every 12 ms or so between pages, and stop after 5 seconds of work once the
  file is read (the pauses do not count): then no page is marked. At ingest, picture marks also
  stop between two pages when `ingestTimeoutMs` (2 minutes) passes or `IngestInput.signal` aborts;
  a reading of the file already under way goes on in the background until it ends
  ([Uploads](#uploads)).
- **Errors** are caught. `view_pages` tells the model why the pages cannot be shown, and the model
  answers from the text. Picture marks that fail leave every page unmarked.

To turn them off: without `keepOriginals` for PDFs, `view_pages` is never offered
(`viewPages: false` turns it off for one question). Picture marks and the page check are turned off
in the PDF extractor, or by not installing `@cantoo/pdf-lib`; a `view_pages` call then fails too,
so keep no PDF originals either. Without the page check, a page that is slow to read holds the
server for as long as pdf.js takes ([Uploads](#uploads)): read PDFs in child processes with
`createIsolatedExtractors`, whose kill timer stops such a page, or ingest in a process of its own.

```ts
import { createLargeFiles, createPdfExtractor, FileDocumentStore } from "llm-large-files";

const files = createLargeFiles({
  store: new FileDocumentStore("./data/documents"),
  // No picture marks and no page check: PDFs are not read with @cantoo/pdf-lib at ingest.
  extractors: { pdf: createPdfExtractor({ pictures: false, checkPages: false }) },
  // No keepOriginals: no original is kept, so view_pages is never offered.
});
```

For uploads you do not trust, parse them in a process of their own, with a memory limit and a
timeout. Since 0.8.0 the library does it: the `extractors` of
[`createIsolatedExtractors`](./reference/node.md#createisolatedextractorsoptions), from
`llm-large-files/node`, read PDF, DOCX, PPTX and XLSX files in child processes, each with a heap
flag (`maxHeapMb`, 512 by default: a heap limit of 560 to 704 MB, depending on the version of Node,
[The heap limit](./reference/node.md#createisolatedextractorsoptions)) and a kill timer
(`timeoutMs`, 120 s). A file that runs its child out of memory is refused with the code
`"out_of_memory"`, one that takes too long with `"timeout"`, and your server goes on
([Uploads](#uploads)). To run the whole ingest apart, an
extractor of your own included, fork a process for it
([Deployment](./guides/deployment.md#uploads-and-ingest)). If you keep their PDFs for
`view_pages`, run the questions in a process of their own too (the tool loop of each question, in a
process you fork), or do not offer `view_pages` on their documents (`viewPages: false`): a look
parses the file again, in the server that answers. The limits of the library bound
what a file can make it keep, but not the memory a parser takes for its own work, and in your
server that memory is the server's heap. Choose the isolation with care:

- **A child process contains running out of memory.** A process started with `child_process.fork`,
  as `createIsolatedExtractors` starts its children, or a service of its own, with its own
  `--max-old-space-size`, stops alone, and your server goes on. `createIsolatedExtractors` does not
  pass the server's `NODE_OPTIONS` to its children, so a heap flag there does not replace theirs.
  That flag bounds the heap only. What a parser unpacks is held outside it: a PDF of 1.6 KB took 1.6
  GB of memory at ingest with 20 MB of heap ([Objects of a PDF](#uploads)). Give that process a
  memory limit of its own too, such as a container or a cgroup of its own.
- **A worker thread does not reliably contain it.** In the 0.6 review, on the code before this
  release ([Measurements](./measurements.md#how-to-read-this-page)), a worker given
  `resourceLimits: { maxOldGenerationSizeMb: 512 }` ran out of memory on a hostile DOCX and took
  the whole process down with it.
- **A heap flag of the process silently replaces a worker's limit.** With `--max-old-space-size`
  on the command line or in `NODE_OPTIONS`, every worker gets the process's heap limit in place of
  its `resourceLimits.maxOldGenerationSizeMb`. With `--max-old-space-size=1024`, a worker given 512
  MB had a heap limit of 1,216 MB, the process's, where it has 704 MB without the flag (Node 24,
  `v8.getHeapStatistics().heap_size_limit`). Clearing `execArgv` or `NODE_OPTIONS` for the worker
  does not change it.

[Deployment](./guides/deployment.md#uploads-and-ingest) has the recipes.

## Uploads

- **Size.** `maxUploadBytes` is 100 MB by default. `createDocumentHandlers` refuses a larger
  `Content-Length` before reading, and counts the body as it reads it, stopping at the limit: 413
  "The file is larger than the 100 MB upload limit." When a body parser in front (such as
  `express.raw()`) has already read the body, it buffered it under its own `limit`: set that one
  too. `files.ingest` checks the bytes you give it, which are already in memory.
- **Memory.** The handlers buffer the whole upload, up to `maxUploadBytes`, before reading its
  text, and an ingest then holds several copies of the text at once (several times the size of the
  text), in your server's heap. Since 0.8.2 the handlers hold uploads of at most
  `maxPendingUploadBytes` at once (twice `maxUploadBytes`), and answer the others 503 before reading
  their body; each library lets `maxConcurrentIngests` (2) ingests work at once, and queues the
  others. A route of your own must bound the bodies it reads itself. A rate limiter per user in
  front still keeps one user from taking that room from the others. Read PDF and Office files with
  `createIsolatedExtractors`, whose `concurrency` (2) and `maxQueue` (8) bound how many are read and
  wait, or ingest in a process of its own: [Deployment](./guides/deployment.md) has measurements
  and recipes.
- **Text.** A small file can hold far more text than its size: a PDF of 3 KB whose page tree listed
  one dense page 150 times drew 107 MB of text in 0.5.0. `maxTextBytes` (100 MB by default, or
  `maxUploadBytes` when that is larger) bounds the text kept from one file, in UTF-8 bytes. The PDF
  extractor counts it page by page, and DOCX, PPTX and XLSX as they are unpacked; each refuses the
  file as soon as it passes. The text of any other extractor is checked when it returns. A PDF whose
  page tree lists one page more than once is refused before its text grows: "This PDF lists the same
  page more than once. A file built that way can hold far more text than its size, so it is not
  read. Print it to a new PDF, and attach that." A PDF whose pages paint forms inside forms draws
  the text of the innermost one each time it is painted: past the first 16 MB, a PDF that draws more
  than 100 times its size in text is refused as it is read ("This PDF draws more than 16 MB of text,
  over 100 times its size. …"), whatever `maxTextBytes` allows.
- **Pages.** A PDF of more than `maxPdfPages` pages (5,000 by default) is refused before any page
  is read.
- **Time.** One ingest may take `ingestTimeoutMs` (2 minutes by default) to extract, index and
  profile the text. Past it, `ingest` throws "report.pdf took too long to read (more than 2 min).
  …", and nothing is stored. `IngestInput.signal` stops it sooner, when your route knows that the
  uploader left; the upload handler of `createDocumentHandlers` aborts it when the client closes
  the connection. The PDF, DOCX, PPTX and XLSX extractors stop between two pages or two pieces. At
  the limit, `ingest` stops waiting, but a step already under way (one page of pdf.js, JSZip reading
  the directory of a ZIP, a parse of `@cantoo/pdf-lib`, an extractor of your own that does not
  look at `ExtractInput.signal`) runs on to its end in the background. With
  `createIsolatedExtractors`, the child process that reads the file is killed then, step and all,
  and also at its own `timeoutMs`.
- **Work of a PDF page.** pdf.js reads the text of a page in one block that neither the time limit
  nor a signal cuts short, and a page can be built to make it run far more than its file holds: a
  3 KB page that paints a form that paints another, 50 times at each of three levels, held the
  event loop for 13 s, and one of 4 KB for about 100 s. With `@cantoo/pdf-lib` installed, the PDF
  extractor adds up, before pdf.js reads any page, what each page would make it run (its content,
  each form every time it is painted, and the fonts it sets, Type3 glyph programs included), and
  refuses a page past about 1 to 1.5 s of pdf.js, or past 32 times the size of the file when that
  is more: "Page 1 of this PDF draws far more than its file holds, and reading it would hold the
  server for a long time. A file built that way is not read: it may be built to exhaust the
  server. Print it to a new PDF, and attach that." Pages that add up to more than four such pages
  are refused with "This PDF draws far more than its file holds, …", and a page whose content
  cannot be decoded before pdf.js reads it with "Page 1 of this PDF stores its content in a way
  that cannot be checked before it is read, so it is not read. …". The hostile files of the review
  are refused in under 0.06 s. The check narrows what an upload can do; it does not bound it (see
  Stalls). How it counts: [Pages that would hold the server](./guides/pdfs.md#pages-that-would-hold-the-server).
- **Objects of a PDF.** Both parsers build each object of a PDF in one step, and an object can
  take far more memory than file: one MB of empty dictionaries took 91 MB of heap, and a stream
  unpacked twice packs such objects thousands of times. Nothing checks an object before it is
  built, and the limits on the number of objects a file declares do not see such files.
  `@cantoo/pdf-lib` builds every object of the file for the page check and the picture marks: an
  upload of 16 MB that is one array of one-digit numbers ran a heap of 256 MB out of memory, and
  one of 32 KB, an array of 32 MB packed in an object stream, a heap of 512 MB
  ([Reading PDFs for pages and pictures](#reading-pdfs-for-pages-and-pictures)). pdf.js builds the
  objects a page needs, and every object of an object stream once it needs one of them: a file of
  759 bytes whose object stream, unpacked twice, held the catalog and 8 MB of empty dictionaries
  ran a heap of 512 MB out of memory in pdf.js alone, with the page check and the picture marks
  off. With them on, as by default, both build such objects, and a file of 732 bytes with 4 MB of
  them did so ([measured](./measurements.md#the-server)). 0.5.0 did the same. What a stream unpacks
  to is held outside the heap, where `--max-old-space-size` does not limit it: a PDF of 1,633 bytes
  whose object stream holds the catalog after 512 MB of spaces was read with 20 MB of heap, but the
  process took 1.6 GB of memory. The same spaces in the content of a page are refused by the page
  check, in under 0.07 s. A check of each object before it is built is not in 0.6.0:
  pdf.js reads an object where the cross-reference table points, also inside what reads as the
  data of a stream, and the object streams of an encrypted file cannot be unpacked before they are
  decrypted, so such a check would be easy to get around. Read files you do not trust with
  `createIsolatedExtractors`, whose children have a heap limit, and for what a stream unpacks
  outside the heap, ingest in a container of its own with a memory limit of its own
  ([Deployment](./guides/deployment.md#uploads-and-ingest)). A look at their
  pages parses the file again on the server that answers the question: do not offer `view_pages`
  on their documents (`viewPages: false`), or keep no PDF originals
  ([Reading PDFs for pages and pictures](#reading-pdfs-for-pages-and-pictures)).
- **Stalls.** Ingest pauses for other requests about every 12 ms of its work: between the pages of
  a PDF, as a DOCX or PPTX is unpacked, as a text file that is not UTF-8 is decoded, and in every
  step after extraction, a line of megabytes included. In a measurement on one machine, the longest
  stall of the event loop was 31 to 34 ms for a 99 MB log and 0.16 s for a 2,000-page PDF, against
  1.9 to 2.0 s and 4.4 to 4.5 s with the ingest of 0.5.0
  ([Measurements](./measurements.md#the-server)). Some steps still hold the server, and neither the
  time limit nor a signal cuts them short:
  - A PDF page, for as long as pdf.js takes to read it: up to about 1.5 s for a page that passes
    the check in a small file, longer in a large file, and without limit when the page check does
    not run (without `@cantoo/pdf-lib`, on a file it cannot read or that declares more than 150,000
    objects, with `checkPages: false`) or on a file built to be read one way by `@cantoo/pdf-lib`
    and another way by pdf.js.
  - One object of a PDF, while `@cantoo/pdf-lib` reads it for the page check and the picture
    marks: about 0.1 to 0.35 s for each MB, by what the object holds. A crafted PDF of 16 MB held
    the server for 1.6 to 3.2 s, and one of 8 KB, an array of 8 MB packed in an object stream, for
    1.5 to 3.5 s.
    A cross-reference stream that declares a million entries held it for 0.7 s
    ([Reading PDFs for pages and pictures](#reading-pdfs-for-pages-and-pictures)).
  - One object of a PDF that a page needs, while pdf.js reads it: 1.1 to 1.3 s for an array of
    32 MB ([Objects of a PDF](#uploads)).
  - A stream that pdf.js unpacks to reach an object: 6.1 to 6.4 s for an object stream that
    unpacks to 512 MB, in a file of 1.6 KB. `@cantoo/pdf-lib` took 1.0 s for it at a look.
  - A piece of a DOCX, PPTX or XLSX packed hundreds of times tighter than documents are, about
    0.2 s at a time while JSZip unpacks it.

  Read files you do not trust with `createIsolatedExtractors`, or ingest them in a process of their
  own ([Deployment](./guides/deployment.md#uploads-and-ingest)): only that process waits, and it is
  stopped at its time limit.
- **Parsers.** PDF text is read with `unpdf` (pdf.js), pages, pictures and the page check with
  `@cantoo/pdf-lib`, and DOCX, PPTX and XLSX are unpacked with `jszip`. They are optional
  dependencies, and they run on untrusted input in your process, or in the child processes of
  `createIsolatedExtractors`. Keep them updated, and for high-risk deployments move extraction out
  of the server: into those child processes, a container of its own or a sandbox ([Reading PDFs for
  pages and pictures](#reading-pdfs-for-pages-and-pictures) says why a worker thread is not enough).
- **Zip bombs.** A DOCX, PPTX or XLSX is unpacked a piece at a time, and refused as it grows past
  100 times its size (after the first 16 MB) or past 128 MB of XML: "This DOCX unpacks to more than
  16 MB, over 100 times its size. A file that grows that much is not read: it may be a zip bomb.
  Save it as text or PDF, and attach that." Only the parts that hold text are unpacked (in a DOCX
  the document, its footnotes, endnotes, comments, headers and footers, and its styles and
  numbering; in a PPTX the slides and their speaker notes; in an XLSX the workbook, its styles, its
  shared strings and its sheets). Pictures and fonts stay packed. What is kept in memory is bounded
  by the text, not by the XML: each paragraph becomes one string when it closes, and an empty one is
  dropped. A file is refused with more than 32 million characters of text (or `maxTextBytes`, when
  that is smaller), more than 1,000,000 paragraphs with text, paragraphs nested more than 32 deep,
  or more than 20,000 parts in its ZIP directory. In 0.5.0, a DOCX of 1.5 MB that held 120 MB of
  empty paragraphs ran a heap of 512 MB out of memory and stopped the server; it is now refused with
  the process at 115 MB.
- **The ZIP directory of a DOCX, PPTX or XLSX** is read before JSZip reads it, the way JSZip 3.10 will
  read it: from where JSZip finds it (the last end record of the file, and for a ZIP64 file the
  last locator and the record it points to), record by record, each by its own lengths. JSZip reads
  every record of the directory into memory before it unpacks any part, and the count of parts that
  the file gives does not bound it: 300,002 parts with a count of 2 took 440 to 490 MB. What JSZip
  would keep is added up, and the file is refused before JSZip sees it:
  - more than 20,000 parts (JSZip keeps about 2 KB for each): "This DOCX has more than 20,000
    parts, more than an Office document has. It may be built to exhaust the server, so it is not
    read." The parts are not counted past the limit.
  - more than 80,000 extra fields (JSZip keeps about 250 bytes for each field of 4 bytes), or more
    than 8 MB of what JSZip turns into text or goes through byte by byte: for each part, the name
    in the local header it points to, its comment, and the data of its ZIP64, Unicode Path and
    Unicode Comment fields. The size of the file does not bound these. A name is decoded once for
    each part that points to its header, and a field gives all the data it says it has, even when
    that runs past its record over the records after it: 2,000 parts of a DOCX of 0.17 MB ran a
    heap of 256 MB out of memory, and the ZIP64 fields of a DOCX of 1 MB held the event loop for
    4.5 s. "This DOCX lists its parts in a way that no Office program does: reading the list would
    take far more memory or time than an Office document needs. It may be built to exhaust the
    server, so it is not read." Office writes no extra fields, other ZIP programs one to three for
    each part, and the Office files we tried had at most 68 KB of names and comments.
  - a ZIP64 end record that says it is longer than its fields: JSZip reads the rest in a loop that
    does not move on, until it runs out of data or forever. "This DOCX ends with a ZIP64 record
    that cannot be read, and reading it could hold the server without end. It may be built to
    exhaust the server, so it is not read."

  Real files are not refused: 245 ZIP files of Word, PowerPoint, Excel, Java and other programs,
  and of Python, Info-ZIP, git, .NET and other ZIP writers, gave the parts, and the bytes of text,
  that JSZip reads. What the limits still let through is bounded: a DOCX just under all three at
  once took JSZip 0.46 to 0.48 s in one block, with the heap at 126 to 140 MB. The reading takes
  under 4 ms for a directory of 46,000 parts, and 30 to 70 ms to search 100 MB for an end record
  that is not at the end (0.2 s for 100 MB built of near signatures), before JSZip searches the
  file again ([Measurements](./measurements.md#the-server)).
- **Binary files are refused**, with a message for the user: "This file looks binary, not text…".
  Compressed ones (`.gz`, `.zip`) get a message that says to decompress first, and an Office file
  of before 2007, an Outlook message or an Office file with a password one that says to save it
  again (since 0.8.0).
- **Refusals carry a code.** Since 0.8.0 `ingest` throws every refusal as an
  [`IngestError`](./reference/library.md#ingesterror), and `ingest.error` events carry its `code`.
  The files built the way files that exhaust a server are, which the checks above recognize (a zip
  bomb, a ZIP directory or a tag no Office program writes, a PDF that lists a page twice, draws far
  more text than its size or has a page that would hold the server), have the code `"hostile"`:
  count or log them apart, by user. `"out_of_memory"` and `"timeout"` from the child processes of
  `createIsolatedExtractors` can be such files too.
- **Scanned PDFs** (no text at all) are refused, unless PDF originals are kept (`keepOriginals`
  includes `"pdf"` and the store has `putOriginal`) and the file has at most `scannedPdfPages` pages
  (30 by default): their pages can then be shown.
- **File names** are reduced at ingest to one printable line: the last path segment. Control
  characters, line and paragraph separators and text-direction controls become a space, and the
  characters that show nothing which file text loses (tag characters, zero-width spaces, word
  joiners, soft hyphens, a byte order mark) are removed
  ([Characters that show nothing](#characters-that-show-nothing)). A name has at most 255
  characters, and is never cut in the middle of a character (`file` when nothing is left). An
  emoji of several characters, such as a flag, can lose its end at the cut. A name that an
  earlier version cut in the middle of a character is sent with U+FFFD in place of the half.
- **The MIME type is the client's word.** The handlers take it from an `X-File-Type` header, or
  from `Content-Type` unless that is `application/octet-stream`. The format is picked from the file
  name first, then from it. It is stored, and returned in summaries: do not trust it.
- **Text is cleaned.** Terminal escape sequences are removed, and so are control characters other
  than tab and line breaks, C1 (U+0080-U+009F) included, and the other characters listed in
  [Characters that show nothing](#characters-that-show-nothing). An `ESC ]` without its end on the
  same line loses only those two characters, not the lines after it. A sequence that starts with
  U+009B and a parameter (`\u009b31m`) is removed whole; a lone U+009B, or one right after a
  character of U+0080-U+00FF, is more often the end of a letter of UTF-8 read as Latin-1 ("ś" is
  C5 9B), and goes alone: "Coś? Tak" read as Latin-1 keeps its "? Tak". A line of megabytes is
  cleaned in pieces, with pauses for other requests.
  - **U+0085 (next line).** In a text with no other line break (one at its very end aside), such as
    a mainframe file converted to UTF-8, it ends a line, except right after U+0080-U+00FF, where it
    is the last byte of a UTF-8 letter read as Latin-1 and is removed. So a record that ends in
    such a character (É, °, £) runs into the next one, and an empty record is dropped. A file of
    one line, such as minified JSON, has no other line break either, so a U+0085 inside one of its
    strings becomes a line break too. In a text with other line breaks it is removed with the other
    C1 characters: there it is more often inside a JSON string or a CSV field, or a windows-1252 "…"
    read as Latin-1, where a line break would split the record. This applies to text in UTF-8 (or
    UTF-16 with a byte order mark): the same export converted to ISO-8859-1 is read as
    windows-1252, where its byte 0x85 is "…", and stays one long line.
  - **What changes in text that is not hostile.** A word joiner (U+2060, which French text may put
    before a "!"), a zero-width space (which Thai, Khmer and Lao text may put between words),
    embeddings around Arabic, and a byte order mark or a soft hyphen inside a line are removed,
    and a flag written with tag characters, other than those of England, Scotland and Wales, keeps
    only its black flag. Text with none of the characters that cleaning removes or changes is
    stored as before, byte for byte.

Formats, optional dependencies and the messages of refused files are in [PDFs](./guides/pdfs.md);
the upload routes in [Web app](./guides/web-app.md).

## Regex search

The model writes the regex, and the model reads untrusted file text, so a file can ask for a slow
pattern. These bound the cost:

- **Refused up front:** a pattern longer than 300 characters, one that is not valid, and one with a
  nested quantifier such as `(a+)+`. The model reads why. Since 0.8.0 a repeated group whose
  repeats end at a literal character that none of its quantified parts can match, as in
  `(\d{1,3}\.){3}\d{1,3}` or `(\w+\.)+com`, passes: each repeat ends at the next such character,
  so it takes time in proportion to the line. The nested-quantifier check is a quick filter, not a
  guarantee: `(a|a)+$` and `((a+))+$` pass it.
- **3 seconds for one search.** Node's `vm` timeout interrupts a match that is still backtracking.
  The search returns what it found, with the note "The scan stopped early; the total is a lower
  bound, and the last match in the file is not known."
- **Slices of 250 ms.** The scan runs a slice at a time, and other requests get a turn between two
  slices. A line that two whole slices cannot get past ends the search: a pattern stuck on one line
  costs three slices at most, under a second, not 3 seconds.
- **6 seconds for the regex searches of one tool set** (`REGEX_BUDGET_MS`). `askWithFiles` and
  `askGemini` make one tool set per question; in your own loop, `regexBudgetMs` of `files.tools()`
  sets it. Past it, a regex search is refused: "The time for regex searches is used up for this
  answer. Search with mode "exact" or "keywords" instead." The regex searches of one turn run one
  after another, each with what the ones before it left.
- **8 tool calls of one model turn** are run (`limits.callsPerTurn`), 4 at a time. The others are
  answered "Not run: one turn runs at most 8 tool calls. Send this call again if you still need it."

The 6 seconds are per question, not per process: several questions at once each have their own. A
slice is synchronous, so a slow pattern holds the event loop for up to a quarter of a second at a
time. If that matters for the latency of other users' streams, run the questions in a worker thread.

What does hold per library (per `createLargeFiles` call, so per process when you create it once
per process, as [Deployment](./guides/deployment.md#what-lives-where) advises): scans of documents
read by range (searches, counting the parts of a file) run at most `maxConcurrentScans` (4) at a
time, and the others wait their turn; the documents kept ready in memory between tool calls take at
most `cacheBytes` (256 MB).

## What a question can cost

A file can ask a model to do expensive things, and a model can decide to on its own. These bound one
question, whatever the model:

- **Chat requests:** `limits.toolTurns` (12), counting the answer. Tools run in all but the last,
  with at most `limits.callsPerTurn` (8) calls run in each.
- **Whole-file reads:** one of each document (`limits.wholeDocumentReads`). A read is up to
  `maxMapChunks` (30) part requests of up to `mapChunkTokens` each (100,000 at the default window of
  1M tokens: 3M input tokens), plus the requests that merge the notes and write the read's answer.
  With an explorer model, that model reads the parts.
- **Pages:** at most 5 a call, and for the question what half of `reservedTokens` holds at the
  adapter's `pageTokens`. They stay in the later requests of the question, which bills them again,
  unless room runs out and older results are replaced by a note of what they showed (never for a
  model whose conversation may only grow, as Claude's).
- **Requests sent again:** a request that failed is retried (`retry.retries`, 3 by default). One
  the provider refuses as too large is sent again smaller, at most twice a question (never for a
  model whose conversation may only grow, as Claude's), and a question whose first request is too
  large, before any tool ran, is planned again once. None of these takes a tool turn. A retried
  request counts once in the usage.
- **Ceilings, unset by default:** `limits.inputTokens` and `limits.requests` cover the whole question,
  part reads included. A whole-file read that would pass one is refused before it starts. Once
  `inputTokens` is reached, no more tools run, but the request that crosses it has already been
  sent, and the answer request is still sent with the whole conversation: a question can pass the
  ceiling by up to about two requests (the one that crosses it, and the answer). `requests` counts
  answered requests and keeps one for the answer.

`result.usage` is what a question used, in all and for each model. A question that fails or is
stopped returns nothing: `partialResultOf(error)` gives what it had used until then. Log both per
user. [Costs and limits](./guides/costs-and-limits.md) explains every lever, the budget, and cost
per user or session.

## How long a question can take

There is no overall time limit on a question. Each model request waits up to 600 s for its first
piece and 300 s between pieces, and is retried after waits of up to 60 s
([Errors and reliability](./guides/errors-and-reliability.md#waits-on-a-silent-model)). A question
is up to 12 chat requests, not counting retries, and part reads besides, so it can run for many
minutes. Give it a deadline with `signal`, and abort it too when the client goes away
([Web app](./guides/web-app.md)). This sample sets a deadline and logs what each question used,
failed ones included:

```ts
import { askWithFiles, partialResultOf, type UsageTotals } from "llm-large-files";

function recordUsage(owner: string, usage: UsageTotals): void {
  console.log(JSON.stringify({ owner, requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }));
}

// `files`, `model`, `documentIds`, `messages` and `owner` as in the first sample.
try {
  const result = await askWithFiles({
    files, model, documentIds, messages, owner,
    limits: { inputTokens: 2_000_000, requests: 40 },
    // 15 minutes: above firstByteTimeoutMs (10 minutes), so a silent request can be sent again.
    // Work that cannot be interrupted (reading a PDF for view_pages) finishes first.
    signal: AbortSignal.timeout(15 * 60_000),
  });
  recordUsage(owner, result.usage);
} catch (error) {
  // A question that failed, or was stopped, was still paid for until then.
  const partial = partialResultOf(error);
  if (partial) recordUsage(owner, partial.usage);
  throw error;
}
```

Waits, retries and deadlines are explained in
[Errors and reliability](./guides/errors-and-reliability.md).

## Storage errors

A store's own errors can name paths and hosts. Reads reach users and models only as
`DocumentStoreError`, whose message names neither, with the original error as its `cause`. Writes
are passed on as they came, and the upload handler answers a write error that has neither a
`status` (or `statusCode`) from 400 to 599 nor a Node system error's `code` and `syscall` with 500
"Upload failed.", without the error's own message. A write error with such a status, such as an
SDK's error with `statusCode`, is answered with that status and its own message, which can name a
host. Two paths answer a store's write error 422 with its own message, so a database driver's host
can reach the browser through them: an `ingest` of your own that throws a new error in place of the
store's, as `ingestInProcess` in [Deployment](./guides/deployment.md#uploads-and-ingest) does, and a
route of your own, as in [Web app](./guides/web-app.md#filesingest-and-its-errors). Give your
store's write errors a status and a message of your own, and log the cause yourself, since the
handlers log nothing: see [Storage](./guides/storage.md#errors) and the
[node reference](./reference/node.md#uploadrequest-response). What to show a user is in
[Errors and reliability](./guides/errors-and-reliability.md).

## What the library logs

Nothing. It writes no log, reads no environment variable, and makes no network request but the
adapters' requests: to the provider's API (each adapter's default), or to the URL you configure
instead. Two of its optional dependencies do write: pdf.js, which `unpdf` bundles, prints its own
warnings with `console.warn` (for example `Warning: Indexing all PDF objects`, for a damaged PDF),
and `@cantoo/pdf-lib` warns the same way about some malformed PDFs (for example
`Removing parsed object: 0 0 R`) when it reads one for picture marks or `view_pages`.

What you log is your choice, and some of what the library hands you holds user data:

- **Steps and activity.** The lines of `onStep`, `onActivity` and `result.steps` name the files,
  quote what the model searched for (up to 80 characters) or asked a whole-file read to do (up to
  100), and a failed step ends with the error the tool returned. Each is one line of plain text. A
  line break, a tab or another control character in what the model sent becomes one space, with
  the blanks around it. The characters that file text drops are dropped
  ([Characters that show nothing](#characters-that-show-nothing)), and those it keeps are kept.
  `](` becomes `] (`, so that a markdown link or picture written as `[text](https://…)` stays
  text. A call to a tool that does not exist is shown as `Call “<name>”`, with the name cut at 64
  characters, so that no line starts with the model's words. The lines still quote those words,
  HTML tags and web addresses included: show them as plain text, never as markdown or HTML.
- **`result.toolTurns`** hold the text of the files; `result.evidence` names the documents, lines
  and pages that were shown.
- **Errors.** The `cause` of a `DocumentStoreError` names paths or hosts. A `ModelRequestError`
  carries the provider's own message, unfiltered, and "could not be reached (…)" adds the HTTP
  client's message. Log them on the server, and show users a message of your own.
- **Errors in a whole-file read.** A model request of the read that failed is told to the model,
  and in steps and `toolTurns`, by the error's kind, its HTTP status (`status`, `statusCode` or
  `response.status`), the code of a connection that failed, or a timeout, never by its message:
  `Could not read any part of app.log: The model refused the key or token it was sent (HTTP 401).`
  This holds for the errors of the package's adapters and for those of a `generate` of your own,
  such as a provider SDK's. An error with none of these is told as `The model request failed.`, and
  a reply with no text to a part reader of the package as `The model returned no text (SAFETY).`,
  with the provider's reason only when it is a plain word. To give the model a reason of your own,
  throw an error with a `kind` or an HTTP `status`, and log the provider's words yourself. A read of
  the store that failed is told by the message of its `DocumentStoreError`, which names no path or
  host (`The document store could not be read (EIO). Try again.`).

## Before you deploy

- Give every document an owner, pass it to every call, and refuse anonymous requests in `getOwner`
  ([Ownership](#ownership)). Never pass `""` for a caller without a user: `ingest` refuses it.
- Take `documentIds` and the conversation, `toolTurns` included, from your server, not from the
  browser ([Prompt injection](#prompt-injection)).
- Set `ttlMs` to your data policy, run `sweep` on a schedule, and make your deletion rules cover
  stored `toolTurns` ([Storage and retention](#storage-and-retention)).
- Keep the store on encrypted storage.
- Turn on `keepOriginals` only if you want `view_pages`, and knowing what it keeps
  ([Original files](#original-files)).
- Set `limits` and a deadline, and log `usage` for failed questions too
  ([What a question can cost](#what-a-question-can-cost)).
- Keep the bound on uploads held at once (`maxPendingUploadBytes` of the handlers, or your own in a
  route of your own), limit uploads per user, and set the limit of any body parser in front of the
  handlers ([Uploads](#uploads)).
- Keep the limits on one file (`maxTextBytes`, `maxPdfPages`, `ingestTimeoutMs`) as low as your
  users allow ([Uploads](#uploads)).
- For untrusted uploads, parse them in a process of their own with a memory limit, not in a worker
  thread: pass the `extractors` of `createIsolatedExtractors` to `createLargeFiles`
  ([Reading PDFs for pages and pictures](#reading-pdfs-for-pages-and-pictures)), and keep
  `unpdf`, `@cantoo/pdf-lib` and `jszip` updated.
- Render answers as untrusted text, and steps and activity lines as plain text
  ([What the library logs](#what-the-library-logs)).
- Show users `meta.encoding` for a text file read in an older encoding
  ([Text files that were not UTF-8](#text-files-that-were-not-utf-8)).
- Check what your model provider keeps, and where it processes the data
  ([What is sent to model providers](#what-is-sent-to-model-providers)).

## Related pages

- [Storage](./guides/storage.md): owners per user or per session, a store of your own, retention.
- [Web app](./guides/web-app.md): uploads, streaming, cancelling.
- [Conversations](./guides/conversations.md): what `toolTurns` hold and how to store them.
- [PDFs](./guides/pdfs.md): formats, `view_pages`, picture marks, scans.
- [Costs and limits](./guides/costs-and-limits.md) and
  [Errors and reliability](./guides/errors-and-reliability.md).
- [Deployment](./guides/deployment.md): several servers, workers, memory, sweep.
- [library.md](./reference/library.md) (`createLargeFiles`, stores, `DocumentStoreError`),
  [ask.md](./reference/ask.md), [tools.md](./reference/tools.md) and [node.md](./reference/node.md).
