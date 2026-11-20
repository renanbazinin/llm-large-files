# PDFs and other formats

This guide covers the files the library reads: the formats, what each needs installed, and what the
model gets from them. Most of it is about PDFs: rebuilt tables, the line that marks a page with a
picture, `view_pages`, which shows the model the real pages, scanned PDFs, and extractors of your
own, OCR among them. Exact signatures are in the [library reference](../reference/library.md).

## Formats

The readers of DOCX, PPTX and PDF files are optional dependencies. Install the ones you need on
every server that ingests files:

```bash
npm install jszip              # DOCX and PPTX
npm install unpdf              # PDF text
npm install @cantoo/pdf-lib    # PDF picture marks and view_pages
```

They are optional peer dependencies of the package: `jszip` ^3.10.0, `unpdf` ^1.4.0 and
`@cantoo/pdf-lib` ^2.11.1.

| Format | Detected by | Needs | What the text holds |
|---|---|---|---|
| `text` | Anything not below | | The file decoded as UTF-8, or as UTF-16 with a byte-order mark. Without the mark, only little-endian UTF-16 of mostly ASCII text is recognised. |
| `log` | `.log`, `.out`, `.err`; or a `text` file in which at least 40% of the first 200 non-empty lines (5 at least) start with a timestamp or a level | | As `text`, plus a log profile: levels, time range, most frequent errors. |
| `markdown` | `.md`, `.markdown`, `text/markdown` | | As `text`. Its `#` headings form the outline. |
| `json` | `.json`, `.jsonl`, `.ndjson`, `application/json` | | As `text`. Minified JSON becomes lines of at most 2,000 characters. |
| `csv` | `.csv`, `.tsv`, `text/csv` | | As `text`. |
| `pdf` | `.pdf`, `application/pdf` | `unpdf`; `@cantoo/pdf-lib` for picture marks and `view_pages` | A `--- Page N ---` line before each page, tables rebuilt as rows of cells, a line for a page without text and for a page with a picture ([PDF text](#pdf-text)). |
| `docx` | `.docx`, or the Word MIME type | `jszip` | The body, then the endnotes, footers, footnotes and headers, in that order. |
| `pptx` | `.pptx`, or the PowerPoint MIME type | `jszip` | `## Slide N` before each slide, `[No text on this slide]` for a slide without text. |

`detectFormat(name, mimeType)` picks the format: a known extension first, then the MIME type, then
`text`. So `report` with no extension, sent as `application/pdf`, is a PDF, and `data.txt` sent as
`application/json` is JSON, since `.txt` is not one of the known extensions. HTML, XML, YAML and
source code are `text`. The MIME type is compared whole: `application/json; charset=utf-8` is not
JSON. Send the bare type (or `X-File-Type: application/json` to the upload route of
`createDocumentHandlers`, which takes it before `Content-Type`).

Whatever the format, the text is then made uniform: line breaks become `\n`, colour codes and other
control characters are removed, and lines longer than 2,000 characters are split, so every line can
be read by its number. Every format but log, JSON and CSV gets an outline from its headings:
Markdown `#` lines (`## Slide N` among them), chapter and numbered section lines, and short lines in
capitals. `meta.pages` is the number of pages of a PDF and of slides of a PPTX.
[How it works](../how-it-works.md) follows ingest from there.

### DOCX and PPTX

- A text box is read once, after the paragraph it is anchored in. Word stores it twice, the second
  time for older programs.
- A table comes out one cell per line, and an empty cell leaves no line at all, so a row with an
  empty cell reads like a shorter row. PDF tables are rebuilt with their empty cells
  ([PDF tables](#pdf-tables)): if those matter, the PDF of the same document reads better.
- Comments and speaker notes are not read.
- Pictures are not marked, and `view_pages` works on PDFs only. For a deck of charts, the PDF
  export of the deck lets the model look at the slides.

### What is refused

`files.ingest` throws an `Error` whose message is meant for the user. `createDocumentHandlers`
answers it with HTTP 422 and that message, except a file over `maxUploadBytes`, which the upload
route refuses before reading it all: HTTP 413, `The file is larger than the 100 MB upload limit.`
([node reference](../reference/node.md)). For a damaged or locked file the message is the reader's
own, from pdf.js or jszip, and not written for a user: an application that wants friendlier wording
maps these messages itself.

| What | Message |
|---|---|
| An empty file | `report.pdf is empty.` |
| A file over `maxUploadBytes` (100 MB by default) | `report.pdf is larger than the 100 MB upload limit.` |
| A gzip file, such as `app.log.gz` | `This file is gzip-compressed. Decompress it, then attach the text file inside.` |
| A ZIP archive, and the Office files other than DOCX and PPTX that are ZIPs inside (XLSX, for example) | `This file is a ZIP archive. Extract it, then attach the text file you need.` |
| Any other binary file: images, legacy `.doc` and `.xls` | `This file looks binary, not text. Attach a text, log, PDF, DOCX, or PPTX file.` |
| A file that holds no text once read | `report.docx did not contain any text.` |
| A DOCX or PPTX that unpacks to more than 100 times its size (past the first 16 MB), or to more than 128 MB of XML | `This DOCX unpacks to more than …`, which ends `Save it as text or PDF, and attach that.` |
| A PDF without text on any page | See [Scanned PDFs](#scanned-pdfs). |
| A PDF that needs a password to open | `No password given`, the message of pdf.js. |
| A damaged PDF | The message of pdf.js, such as `Invalid PDF structure.` |
| A damaged DOCX or PPTX, or one that is not a ZIP | The message of jszip, such as `Can't find end of central directory : is this a zip file ? …` |
| A DOCX without `word/document.xml` | `This DOCX does not contain word/document.xml.` |
| A PPTX without slides | `This PPTX does not contain any slides.` |
| A DOCX or PPTX without `jszip` installed | `Reading DOCX and PPTX files needs the optional dependency "jszip".` |
| A PDF without `unpdf` installed | `Reading PDF files needs the optional dependency "unpdf".` |

A missing dependency is your server's fault, but it reaches the user as a 422, a file that cannot be
read. Install the dependencies wherever the upload route runs.

## PDF text

The PDF extractor reads the text with `unpdf` (pdf.js) and writes each page under a line of its own.
Pages are separated by a blank line:

```text
--- Page 12 ---
[Picture on this page. This text cannot show it.]
Figure 3: sales by region.
| Region | Q1 | Q2 | Q3 | Q4 |
| EMEA | 80 |  | 95 | 101 |
```

- `--- Page N ---` starts every page, counting from 1. The model passes these numbers to
  `view_pages`.
- A page with no text at all is written as
  `[No text on this page. It may be a scan, a photo, or a chart.]`, so the model can say that it
  cannot see it instead of guessing.
- With `@cantoo/pdf-lib` installed, a page that shows a picture or a drawing gets the second line
  ([The line that marks a page](#the-line-that-marks-a-page)).
- Tables are rebuilt as rows of cells ([PDF tables](#pdf-tables)).

### PDF tables

A PDF stores no tables, only text at positions. Read in file order, a row with an empty cell looks
like a row without that column: `EMEA 80 95 101` under the headings `Q1 Q2 Q3 Q4`, and a model reads
95 as Q2. The PDF extractor finds tables by the position of their text and writes each row with its
cells marked, so the same row becomes `| EMEA | 80 |  | 95 | 101 |`. In a live test of 110
questions about single cells, half of them empty, the text in file order gave 44 right answers and
the rebuilt rows 110 ([measurements](../measurements.md)).

What it handles: empty cells, tables inside one column of a two-column page, right-to-left tables
(the first column is the rightmost), tables printed sideways, rotated pages, footnote marks,
headings that span columns, and cells whose text wraps onto several lines when the rows are visibly
spaced apart. Text that is not a table (paragraphs, lists, columns of prose, justified text) is left
as pdf.js gives it.

It is cautious: where the evidence for a table is weak, the text stays as it was. So:

- A table needs three columns. Two-column tables (key and value, a glossary) stay lines of text,
  which read correctly that way.
- When a cell wraps and the rows have no extra space between them, each line of the cell is a row
  of its own, with the other cells empty.
- Columns that are closer together than a word space on every line of the table stay together in
  one cell, on every row alike.
- A table whose text is stored column by column in the file is not rebuilt.
- Pictures and charts are not in the text. See [Pictures in PDFs](#pictures-in-pdfs).

The cell marks cost about one token per cell. The rules were tuned on PDFs made by Chrome and by
Word. To turn them off and get the text in the order pdf.js gives it, as version 0.1.0 read it,
replace the PDF extractor with one made by `createPdfExtractor`:

```ts
import { createLargeFiles, createPdfExtractor, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  // Text in pdf.js order, without rebuilt tables, and without picture marks.
  extractors: { pdf: createPdfExtractor({ tables: false, pictures: false }) },
});
```

`tables: false` alone still writes the page lines, the line for a page without text, and the
picture marks. `pictures: false` leaves out the picture marks. Both default to `true`
([`PdfExtractorOptions`](../reference/library.md#pdfextractoroptions)).

## Pictures in PDFs

The text of a PDF does not hold its photos, charts and diagrams. Asked about a bar chart from the
text alone, a model can only say that it cannot see it, or guess. Two things, both for PDFs only,
close that gap:

1. **A line in the text that says where the pictures are.** It needs `@cantoo/pdf-lib`.
2. **A tool, `view_pages`, that hands the model the real pages** as a small PDF, when it asks. It
   needs `@cantoo/pdf-lib` and the uploaded file itself, which the store keeps when you list
   `"pdf"` in `keepOriginals`.

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore(process.env.LARGE_FILES_DIR ?? "./data/large-files"),
  // view_pages cuts pages out of the uploaded file, so the store keeps it next to the text.
  keepOriginals: ["pdf"],
});
```

Nothing else changes in your code. `askGemini` and `askWithFiles` offer `view_pages` by themselves
for every PDF whose file is kept, when the model can be sent a file
([Which models can see pages](#which-models-can-see-pages)). A kept file takes disk space, up to
`maxUploadBytes`, until the document expires: [Storage](./storage.md) covers originals in your own
store, and [Security](../security.md) what to weigh before you keep them.

The options of this page, and where each is explained:

| Option | Default | What it does |
|---|---|---|
| `keepOriginals` (`createLargeFiles`) | `[]`: no file kept | List `"pdf"` to keep the uploaded file, which `view_pages` and scanned PDFs need ([above](#pictures-in-pdfs)). |
| `scannedPdfPages` (`createLargeFiles`) | 30 | The most pages a PDF without text may have to be accepted, when PDFs are kept. 0 refuses every one ([Scanned PDFs](#scanned-pdfs)). |
| `tables`, `pictures` (`createPdfExtractor`) | `true` | Rebuild tables; write the line that marks a page with a picture ([PDF tables](#pdf-tables), [The line that marks a page](#the-line-that-marks-a-page)). |
| `viewPages` (`askGemini`, `askWithFiles`) | `true` | Offer `view_pages` for the PDFs whose file is kept ([Limits and cost](#limits-and-cost)). |
| `toolFilePlacement` (`gemini()`, `askGemini`, `anthropic()`) | `"inside"` | Where the pages go in the request ([Where the pages go](#where-the-pages-go-toolfileplacement)). |
| `pdfInput` (`openAiCompatible()`) | `false` | Send the pages as a `file` part; without it, no `view_pages` ([Which models can see pages](#which-models-can-see-pages)). |
| `pageTokens` (`gemini()`, `openAiCompatible()`, `anthropic()`) | 530, 1,000, 3,500 | What a page costs in input tokens ([Limits and cost](#limits-and-cost)). |

A PDF small enough to send whole can also go to the model as a file in your own message, in the
provider's own form ([Conversations](./conversations.md)). The model then sees every page.
`view_pages` is for the PDFs that are too large for that.

### The line that marks a page

At ingest, a page that shows a picture or a drawing gets one line under its header:

```text
--- Page 12 ---
[Picture on this page. This text cannot show it.]
Figure 3: sales by region.
```

The words hold whether or not the model can look at the page later. A search for
`[Picture on this page` lists every such page.

What counts:

- **A picture:** the images on the page cover 3% of it or more, measured by the size they are shown
  at, not by their pixels. A logo covers about 1%. An image that is on 30% of the pages (and on
  three at least) is taken for a logo, a letterhead or a watermark, and does not count, whatever its
  size.
- **A drawing:** shapes filled in three or more colours, outside the tables. Greys, rules, dots and
  page backgrounds do not count, and neither does the shading of a table's cells.
- **A page that paints too much to be text:** drawing instructions larger than 2 MB (a map, a
  technical drawing), more than 20,000 images, or more than 16 MB of instructions once each form (a
  drawing kept apart and painted by name) is counted every time it is painted. Reading such a page
  stops there, so forms painted inside forms cannot hold the server.

What it gets wrong:

- Missed: a chart in one or two colours, and a chart or diagram drawn only with lines.
- Marked by mistake: a table with cells shaded in three colours, when the table itself was not
  recognised (a table of two columns, for example).

The mark is a hint. `view_pages` works on any page, marked or not, and the model is told to look
when a page mentions a figure too.

The pages are found from the structure of the file, without decoding any image, so it is cheap
([measurements](../measurements.md)). No page is marked, and the text is exactly that of version
0.2.0, when:

- `@cantoo/pdf-lib` is not installed;
- you turn it off with `createPdfExtractor({ pictures: false })`;
- the file declares more than 150,000 objects (reading it would take over two seconds), or more
  than about 60% of the free heap can hold;
- finding the pictures, once the file is read, took more than five seconds;
- `@cantoo/pdf-lib` cannot read the file;
- `@cantoo/pdf-lib` counts other pages than the text extractor did.

### `view_pages`

`view_pages(document_id, from_page, to_page)` cuts those pages out of the kept file and returns them
as one PDF, which goes to the model with the tool result. The model reads it like any PDF: text,
pictures and layout. `to_page` defaults to `from_page`. The result says what was shown:

```json
{ "document": "report.pdf", "pages": "12-14", "total_pages": 40, "file": "pages-12-14.pdf" }
```

When fewer pages were shown than asked, it has a `note` that says why, and `next_page` where to go
on, unless the pages the question may show ran out. The exact results and errors are in the
[tools reference](../reference/tools.md).

What the model is told:

- The system instruction lists the PDFs it can look at, with their page counts, and tells it to
  look when the answer depends on a picture, a chart, a diagram, a map, handwriting, a stamp or the
  layout, and not to use the tool to read text.
- The card of a searched PDF says that its text cannot show pictures.
- Search and read results of such a PDF say which page a line is on (`"page": 12` for a match,
  `"pages": "12-14"` for a passage or a read), since a page number is what `view_pages` takes.

It is offered for every PDF whose file is kept, also for one whose text is already in the prompt: a
slide deck of photos has little text, so its text fits, and without the tool the model would see
none of its slides. Such a PDF gets `view_pages` and no search tools.

A look shows up in your steps and in the result:

```ts
import { GoogleAuth } from "google-auth-library";
import { askGemini, vertexAi } from "llm-large-files/gemini";

// files: the library above. reportId: the ID that files.ingest returned. userId: who asks.
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const endpoint = vertexAi({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: "global",
  model: "gemini-3.5-flash-lite",
  accessToken: async () => (await auth.getAccessToken()) ?? "",
});

const result = await askGemini({
  files,
  endpoint,
  owner: userId,
  documentIds: [reportId],
  messages: [{ role: "user", text: "Which region has the tallest bar in the chart on page 12?" }],
  onStep: (step) => console.log(step), // "Look at report.pdf page 12"
});

// The pages the model looked at, for a list of sources under the answer.
const looked = result.evidence.filter((item) => item.tool === "view_pages");
```

A cut holds the pages asked for and little else. Copied the simple way, a contents page brings
along every page it links to. Here every other page is emptied before copying, and a page that
shares one list of images with the whole file (FPDF, TCPDF and jsPDF write PDFs that way) gets a
list of its own. Hidden layers stay hidden, rotated pages and links are kept, and a PDF encrypted
only to restrict printing or copying opens without a password. The cut is not encrypted.

Pages that cannot be shown get an error result, and the model answers from the text:

| Case | The model is told |
|---|---|
| `@cantoo/pdf-lib` is not installed | `report.pdf: Showing PDF pages needs the optional dependency "@cantoo/pdf-lib".` |
| The PDF needs a password to open | `report.pdf: This PDF needs a password to open, so its pages cannot be shown.` |
| The file is damaged | `report.pdf: This PDF could not be read to cut pages from it. It may be damaged.` |
| `@cantoo/pdf-lib` counts other pages than the text has | `report.pdf: The pages of this PDF could not be matched to its text (41 pages against 40), so they cannot be shown.` |
| The file declares more than 1,000,000 objects, or more than about 60% of the free memory can hold | `report.pdf: This PDF has 1,200,000 objects, too many to cut pages from it in memory.` |
| A page past the end | `report.pdf has 40 pages. There is no page 41.` |

What a look costs the server: the whole file is read into memory for every call. At the peak that
is about twice the size of the file, plus 1 to 1.6 KB for each object in it. Reading pauses every 4,000 objects so other
requests get a turn, but it cannot be stopped once it has started. Peak memory for real files is in
[measurements](../measurements.md); [Deployment](./deployment.md) sizes servers for it.

### Limits and cost

| Limit | Value | When it is reached |
|---|---|---|
| Pages per call | 5 (`MAX_VIEW_PAGES`) | The result has `next_page`, and a note that says to call again from there. |
| Bytes per call | What is left of `maxRequestBytes`, less a tenth kept free (256 KB at least), times 3/4 for base64 | Pages are left off the end of the call. A first page that does not fit by itself is an error, and the model answers from what it has. |
| Pages per question | Half of `reservedTokens`, divided by what a page costs: 60 on Gemini, 32 on an OpenAI-compatible model with `pdfInput`, 12 on Claude, with the default budget | `No more pages can be looked at for this question. Answer from the pages and the text you already have.` |

What a page costs is what the adapter declares as `pageTokens`, in input tokens: 530 for `gemini()`
(Gemini bills 520 to 532 a page, whatever is on it), 1,000 for `openAiCompatible()`, and 3,500 for
`anthropic()`, a page's text and its picture, which the loop counts at Claude's `tokenScale` of 1.35.
Set `pageTokens` on the adapter (`gemini(endpoint, { pageTokens })`, `openAiCompatible({ pageTokens })`,
`anthropic({ pageTokens })`) when your model bills otherwise. `askGemini` has no such option: use
`askWithFiles` with `gemini()` for that. A smaller window means a smaller
`reservedTokens`, and fewer pages: [Costs and limits](./costs-and-limits.md) explains the budget.

Pages stay in the request until the question is answered, so every look makes each later request of
that question larger, and each of them bills the pages again. Only when the request runs short of
room are the older tool rounds, pages included, replaced by short stand-ins that say the pages are
no longer attached; when Claude takes part in the question, they never are ([How it works](../how-it-works.md)). Pages are not
sent with the next question: `toolTurns` keep only that the pages were shown. Turn the tool off for
one question with `viewPages: false` on `askGemini` or `askWithFiles`.

### Which models can see pages

The pages are a file. A model that cannot be sent one in a tool result does not get `view_pages`,
and with an [explorer model](./explorer-model.md), both models must be able to take it: the
answering model reads the same pages.

| Adapter | How the pages are sent | Setting | `pageTokens` |
|---|---|---|---|
| `gemini()`, `askGemini` | Inside the function response (default), or in a user turn after it | `toolFilePlacement`: `"inside"` or `"beside"` | 530 |
| `anthropic()` | A `document` block inside the `tool_result` (default), or after the tool results in the same user turn, or not at all | `toolFilePlacement`: `"inside"`, `"beside"` or `"none"` | 3,500 |
| `openAiCompatible()` | Not at all (default), or a `file` part in a user message after the tool messages | `pdfInput: true` | 1,000 |
| An adapter of your own | As its `capabilities.toolFiles` says | `"inside"`, `"beside"` or `"none"` | `capabilities.pageTokens` |

```ts
import { askWithFiles } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";

// auth, files, reportId and userId as above. Any of the three adapters below can be the model
// (or the explorer): view_pages is offered for each.
// Gemini 2.5 does not see a file inside a function response: send the pages beside it.
const gemini25 = gemini(
  vertexAi({
    project: process.env.GOOGLE_CLOUD_PROJECT!,
    model: "gemini-2.5-flash-lite",
    accessToken: async () => (await auth.getAccessToken()) ?? "",
  }),
  { toolFilePlacement: "beside" },
);

// Claude: the pages go inside the tool result by default. "none" takes view_pages away.
const claude = anthropic({ model: "claude-opus-5-5", apiKey: process.env.ANTHROPIC_API_KEY! });

// An OpenAI-compatible model that reads PDF input. Without pdfInput, view_pages is not offered.
const gpt = openAiCompatible({
  model: process.env.OPENAI_MODEL!,
  apiKey: process.env.OPENAI_API_KEY!,
  pdfInput: true,
});

// Here Claude answers; gemini25 or gpt in its place works the same way.
const answer = await askWithFiles({
  files,
  model: claude,
  owner: userId,
  documentIds: [reportId],
  messages: [{ role: "user", text: "What does the stamp on the last page say?" }],
});
```

`pdfInput` is off by default because many servers behind the OpenAI API take no PDF at all, and a
tool message holds text only. Gemini's own OpenAI-compatible endpoint refuses the `file` part with
HTTP 400: use `gemini()` for Gemini. The page parts of `anthropic()` and of `pdfInput` follow the
request shapes of the providers' documentation; [measurements](../measurements.md) lists what has
been run live. The provider guides cover the rest of each setup: [Vertex AI and
Gemini](./vertex-and-gemini.md), [Claude](./anthropic.md), [OpenAI-compatible
endpoints](./openai-compatible.md).

### Where the pages go: `toolFilePlacement`

On Gemini:

| `toolFilePlacement` | What is sent | Gemini 3.5 Flash-Lite, Gemini API and Vertex AI | Gemini 2.5 Flash-Lite, Vertex AI |
|---|---|---|---|
| `"inside"` (default) | The PDF in the `parts` of its function response, which names it as `{ "$ref": "pages-12-14.pdf" }` | Works | Accepted and billed, but the model does not see the pages |
| `"beside"` | The function responses in one `user` turn, then the PDFs in a `user` turn of their own, each after a line that names it | Works | Works |

The table is from live checks ([measurements](../measurements.md)). Keep the default for Gemini 3
models, and use `"beside"` for Gemini 2.5: it takes a file inside a function response without an
error, bills its tokens, and then answers that it cannot see the page. For another model, ask it
once about a chart and check that it reads it.

With `"beside"`, the files get a turn of their own because Vertex AI refuses a turn in which anything
follows a function response (HTTP 400). `askGemini` takes the option for the model and its explorer
together:

```ts
import { askGemini, vertexAi } from "llm-large-files/gemini";

// auth, files, reportId and userId as above.
const result25 = await askGemini({
  files,
  endpoint: vertexAi({
    project: process.env.GOOGLE_CLOUD_PROJECT!,
    model: "gemini-2.5-flash-lite",
    accessToken: async () => (await auth.getAccessToken()) ?? "",
  }),
  owner: userId,
  documentIds: [reportId],
  messages: [{ role: "user", text: "What does the chart on page 3 show?" }],
  toolFilePlacement: "beside",
});
```

On Claude, `"inside"` puts a `document` block in the `tool_result` itself, and `"beside"` puts the
blocks after all the tool results of the turn, each after a line that names it: the Messages API
refuses text before a tool result.

### When `view_pages` is missing

The model gets `view_pages` for a PDF only when all of these hold:

- `keepOriginals` lists `"pdf"`, and the store has `putOriginal` and `getOriginal`.
  `FileDocumentStore` and `MemoryDocumentStore` have both. Documents ingested before you turned it
  on have no file kept: upload them again. `meta.originalKept` says whether a document has one.
- Every model of the question can be sent a file: not `openAiCompatible()` without `pdfInput`, not
  `anthropic({ toolFilePlacement: "none" })`.
- The question does not set `viewPages: false`.
- In a loop of your own, you asked for it ([Your own tool loop](#your-own-tool-loop)).

The tool is offered without `@cantoo/pdf-lib` too, and then every call answers with the error above:
install it. If the tool is offered and the model never calls it, the text may be enough. In a live
test, ten questions that the text answers led to no look at all ([measurements](../measurements.md)).
[Troubleshooting](../troubleshooting.md) has more symptoms.

## Scanned PDFs

A PDF without text on any page (a scan, or pages of photos) has nothing to search. When its file is
not kept, it is refused at ingest:

```text
This PDF has no text layer (it may be scanned). It needs OCR before it can be searched.
```

When its file is kept, the model can read it by looking at its pages, so a scan of up to
`scannedPdfPages` pages is accepted. Each page of its text is its `--- Page N ---` line and the line
for a page without text (with `@cantoo/pdf-lib`, the picture line too). That text is short, so it
usually goes into the prompt whole, and the model gets `view_pages` and no search tools. A longer
scan is refused:

```text
This PDF has no text layer (it may be scanned) and 31 pages. Without text it can only be read by looking at its pages, which works for up to 30 pages. It needs OCR first.
```

```ts
import { createLargeFiles, FileDocumentStore } from "llm-large-files";

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"], // without it, every scan is refused
  scannedPdfPages: 30,    // the default. 0 refuses every scan.
});
```

`scannedPdfPages` has an effect only when PDFs are kept, by a store that can keep them. A PDF with
text on any page is always accepted, however many of its pages are scans: those pages say that they
have no text, and with the file kept the model can look at them.

Raising `scannedPdfPages` lets longer scans in, but the model still reads them five pages a call,
within the pages a question may show ([Limits and cost](#limits-and-cost)) and its tool turns, and
nothing in them can be searched. A long scan needs text: OCR it, at ingest or before
([OCR](#ocr)).

## Custom extractors

An extractor turns the bytes of one format into text:
`(bytes, input) => Promise<{ text: string; pages?: number }>`. `input` has the file's `name`, its
`mimeType` and its `format`, and for a PDF, `scannedPages` ([below](#rules-for-a-pdf-extractor)).
Pass yours in `extractors`, by format. The other formats keep the built-in extractors, which
`defaultExtractors` holds, one per format ([`Extractor`](../reference/library.md#extractor),
[`defaultExtractors`](../reference/library.md#defaultextractors)).

The eight formats are fixed: you can replace the extractor of a format, not add a format. A file of
another kind, such as HTML or XLSX, is detected as `text`, so it goes to the `text` extractor: check
the name or the MIME type there ([Other formats](#other-formats)).

What the library does with what you return:

- The text is made uniform, as for the built-in extractors ([Formats](#formats)). A text that is
  empty is refused: `report.pdf did not contain any text.`
- `pages` becomes `meta.pages`, which the card, the system instruction and `toDocumentSummary` show.
- A `text` file whose lines look like a log becomes `log`.

An error you throw is the answer to the upload. `createDocumentHandlers` answers 422 with its
message, unless the error has a `status` (or `statusCode`) from 400 to 599: then it answers that
status, with your message. A status of 413 is answered with the upload-limit message instead of
yours. An error with a Node system `code` and `syscall` (from `fs` or a socket) is answered 500,
`Upload failed (ENOENT).`, without its message. Write messages a user can read, and give a status when the fault is on
your side, such as an OCR service that is down.

### Rules for a PDF extractor

The tools find pages through the text, so a PDF extractor of your own must write it the way the
built-in one does:

1. **Start each page with a line `--- Page N ---`,** exactly that, on a line of its own, with N
   counting from 1 in page order. Only lines that continue the count are taken for pages. Search and
   read results take their page numbers from these lines, and the model passes them to
   `view_pages`. Without them, the model cannot tell which page a line is on.
2. **Return `pages`, the number of pages of the file.** `view_pages` refuses to cut a file in which
   `@cantoo/pdf-lib` counts another number, since a page number could then point at the wrong page.
   Without `pages`, that check is not made, and the card and the instruction give no page count.
3. **Honour `input.scannedPages`.** The library sets it on every PDF it ingests when PDFs are kept
   (`keepOriginals` lists `"pdf"` and the store has `putOriginal`) and `scannedPdfPages` is above 0.
   It does not say that the file has no text: its value is `scannedPdfPages`, the most pages a PDF
   without any text may have. Unset, refuse a PDF in which you found no text. The library does not check
   this for you: page lines alone are text, so a scan your extractor lets through is stored even
   when the model can never see it.

The simplest way to keep all of this, and the rebuilt tables and picture marks, is to wrap
`createPdfExtractor()` and change only what you need, as the OCR example below does.

### OCR

The library does no OCR. To make scans searchable, wrap the built-in PDF extractor and fill in the
pages it found no text on with the text of your OCR service. Here `OCR_URL` is a service of your own
that takes a PDF and answers `{ "pages": ["text of page 1", "text of page 2", ...] }`; Document AI,
Textract or Tesseract can stand behind it.

```ts
import { createLargeFiles, createPdfExtractor, FileDocumentStore, type Extractor } from "llm-large-files";

/** The text of each page of a PDF, in page order, from your OCR service. */
async function recognizePages(pdf: Uint8Array): Promise<string[]> {
  const response = await fetch(process.env.OCR_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: Buffer.from(pdf),
  });
  if (!response.ok) throw new Error(`The OCR service answered ${response.status}.`);
  const { pages } = (await response.json()) as { pages: string[] };
  return pages;
}

const builtIn = createPdfExtractor();
/** A page the built-in extractor found no text on: its line, the picture line if any, and the line that says it has no text. */
const PAGE_WITHOUT_TEXT =
  /^(--- Page (\d+) ---\n(?:\[Picture on this page\. This text cannot show it\.\]\n)?)\[No text on this page\. It may be a scan, a photo, or a chart\.\]$/gm;

const pdfWithOcr: Extractor = async (bytes, input) => {
  // Let a PDF without any text through for now: OCR may give it some.
  const extracted = await builtIn(bytes, { ...input, scannedPages: Number.MAX_SAFE_INTEGER });
  const blank = [...extracted.text.matchAll(PAGE_WITHOUT_TEXT)].length;
  if (blank === 0) return extracted;

  let recognized: string[];
  try {
    recognized = await recognizePages(bytes);
  } catch (error) {
    // With a status, the upload answers 503 and this message, not 422 and the service's own error.
    throw Object.assign(new Error("Text recognition is not available. Try again later.", { cause: error }), { status: 503 });
  }

  let filled = 0;
  const text = extracted.text.replace(PAGE_WITHOUT_TEXT, (page, header: string, number: string) => {
    const words = recognized[Number(number) - 1]?.trim();
    if (!words) return page;
    filled++;
    return `${header}${words}`;
  });
  // Nothing recognized in a PDF without any text: the built-in rules decide. It is refused, or
  // accepted when its pages can be shown.
  if (filled === 0 && blank === extracted.pages) return builtIn(bytes, input);
  return { text, pages: extracted.pages };
};

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"],
  extractors: { pdf: pdfWithOcr },
});
```

What this keeps: the page lines, so search results still give page numbers; `pages`; the rebuilt
tables and the picture marks of the pages that had text; and the picture line over a scanned page,
since the model can still look at it to check a stamp or a signature. Only PDFs with a page without
text go to the OCR service, and only those pages change. A scan of any length is accepted once OCR
found text in it.

OCR runs inside `files.ingest`, so the upload waits for it. For long scans, run ingest in a
background job and tell the user when the file is ready ([Web app](./web-app.md)).

### Other formats

A file the library does not know arrives at the `text` extractor. This one converts HTML to text,
with the `html-to-text` package here (any converter works), and leaves every other file to the
built-in extractor:

```ts
import { convert } from "html-to-text";
import { createLargeFiles, defaultExtractors, FileDocumentStore, type Extractor } from "llm-large-files";

const text: Extractor = async (bytes, input) => {
  // The built-in extractor decodes UTF-8 and UTF-16, and refuses binary files.
  const decoded = await defaultExtractors.text(bytes, input);
  const html = /\.html?$/i.test(input.name) || input.mimeType.startsWith("text/html");
  return html ? { text: convert(decoded.text, { wordwrap: false }) } : decoded;
};

export const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  extractors: { text },
});
```

Its format stays `text`. To read XLSX, test for its name the same way, before the built-in
extractor, which refuses ZIP files, and write each sheet as lines of text.

## Your own tool loop

`view_pages` returns a file, and a loop that dropped it would tell the model that pages are attached
when nothing is. So `files.tools()` declares it only when you say that your loop delivers files:
pass `viewPages: true` to `files.prepare()`, pass `prepared.viewable` as `viewPages` to
`files.tools()`, run calls with `executeWithFiles`, and send each file it returns with its tool
result, in your provider's form. `execute("view_pages", …)` answers with an error instead:
`The pages could not be shown: this application does not pass files from tools to the model. Answer from the text.`
Without limits, one call may use 3/8 of what is left of `maxRequestBytes` after 256 KB (3,651,696
bytes with the default of 10,000,000), and five pages.
[Your own adapter and loop](./own-adapter-and-loop.md) walks through it.
