# Configuration

## Budget

The budget describes **your model connection**. Set the real numbers of your connector; the
planner uses them to decide what goes into a request whole.

| Setting | Default | What it controls |
|---|---|---|
| `contextTokens` | 1,000,000 | The model's context window. |
| `maxRequestBytes` | 10,000,000 | The largest request body your connector accepts. Checked separately from tokens: non-English text and JSON escaping make bytes run ahead of tokens. |
| `inlineTokens` | 200,000 | The most document text sent whole in one request. Lower it to cut cost and latency; raise it to rely on the long context more. |
| `reservedTokens` | 64,000 | Kept free for the answer, tool results, and growing history. |
| `mapChunkTokens` | 100,000 | Part size when a whole file is read in parts. Smaller parts give more detailed notes but more model calls. |
| `maxMapChunks` | 30 | Refuse whole-file reads needing more model calls than this. 30 parts × 100K tokens = 3M tokens of input. |
| `toolResultCharacters` | 24,000 | Cap on one tool result, in characters. For a log that can be 16,000 tokens, and every result is sent again on each later turn. |

```ts
createLargeFiles({
  store,
  budget: { contextTokens: 128_000, maxRequestBytes: 4_000_000, inlineTokens: 60_000, mapChunkTokens: 40_000 },
});
```

### How the plan is made

For each request, `prepare(ids, base)` takes the size of everything else (`base.tokens`,
`base.bytes`) and fills the room left, smallest documents first:

- token room = `min(inlineTokens, contextTokens − reservedTokens − base.tokens)`
- byte room = `maxRequestBytes − 256 KB − base.bytes`

A document is sent whole if it fits both. Otherwise it becomes searchable.

### Token estimates

`estimateTokens` prices each kind of character, because characters per token depends on the kind
of text. As counted by Gemini:

| Text | Characters per token |
|---|---|
| English prose | 4.3 to 5.0 |
| Source code | 3.5 to 4.1 |
| Hebrew, Arabic, Russian prose | 2.1 to 3.3 |
| Chinese, Japanese, Korean prose | 1.4 to 1.7 |
| Logs (timestamps, IDs, IP addresses) | 1.4 to 2.8 |
| CSV of numbers, hex dumps, base64 | 1.0 to 1.4 |

Digits cost about one token each, which is why a log is three times denser than a novel of the
same size. The estimate was fitted to Gemini's `countTokens` on 60 texts (Gemini 2.5, 3.5, and 3.8
count identically) and lands between 0.98 and 1.7 times the real count. It leans high on purpose:
overestimating only makes a file searchable a little sooner. The one kind of text it still counts
low, at about 70%, is a long run of random letters in one case with no digits.

Tokenizers differ between providers. These weights are fitted to Gemini, which counts digits one
by one. A tokenizer that groups digits will count fewer tokens than this estimate for logs and
data, which is the safe direction.

## Stores

| Store | Use it for |
|---|---|
| `MemoryDocumentStore` | Tests, scripts, one-instance demos. Lost on restart. |
| `FileDocumentStore(dir)` | One server or a shared volume. Survives restarts. |
| Your own | Several instances: implement the interface below over Redis, S3, or a database. |

```ts
interface DocumentStore {
  put(document: { meta: DocumentMeta; text: string }): Promise<void>;
  get(id: string): Promise<{ meta: DocumentMeta; text: string } | undefined>; // undefined if expired
  getMeta(id: string): Promise<DocumentMeta | undefined>;
  delete(id: string): Promise<boolean>;                       // the original file too
  sweep?(now?: Date): Promise<number>;
  putOriginal?(id: string, bytes: Uint8Array): Promise<void>; // optional: see below
  getOriginal?(id: string): Promise<Uint8Array | undefined>;  // undefined if not kept, or expired
}
```

Keep `getMeta` cheap (store the metadata separately from the text). Parsed documents are cached
in memory (`cacheSize`, default 6), so repeated tool calls don't reload the text.

### Keeping the uploaded file

By default a store holds only the text of a document. `keepOriginals` also keeps the uploaded file,
which is what [showing pages of a PDF](#pictures-in-pdfs) needs:

```ts
createLargeFiles({ store: new FileDocumentStore(dir), keepOriginals: ["pdf"] });
```

- It is off by default because it costs disk: a kept file is as large as the upload (up to
  `maxUploadBytes`, 100 MB) and stays until the document expires or is deleted.
- `FileDocumentStore` writes it as `<id>.bin` next to `<id>.txt` and `<id>.json`.
  `MemoryDocumentStore` keeps a copy in memory.
- A store of your own keeps originals when it has `putOriginal` and `getOriginal`. `putOriginal` is
  called before `put` for the same ID, and `delete` and `sweep` must remove the file. A store
  without the two methods works as before: nothing is kept, and `view_pages` is not offered.
- `DocumentMeta.originalKept` says whether a document's file is kept. `files.getOriginal(id, { owner })`
  returns it.
- Documents ingested before you turned it on have no original. Upload them again to get one.

## Formats

| Format | Detected by | Notes |
|---|---|---|
| `log` | `.log`, `.out`, `.err`, or text whose early lines mostly start with a timestamp or level | Gets a log profile |
| `markdown` | `.md`, `.markdown`, `text/markdown` | Headings form the outline |
| `json` | `.json`, `.jsonl`, `.ndjson` | Minified JSON is wrapped into addressable lines |
| `csv` | `.csv`, `.tsv` | |
| `pdf` | `.pdf` | Needs `unpdf`. Pages are marked `--- Page N ---`, tables are rebuilt (below), and a page without text says so. With `@cantoo/pdf-lib`, a page that shows a picture says so too, and the model can be shown the page itself ([Pictures in PDFs](#pictures-in-pdfs)). A scanned PDF (no text layer at all) is rejected, unless its original is kept and it has at most 30 pages. |
| `docx`, `pptx` | extension or MIME type | Needs `jszip`. Slides are marked `## Slide N`. |
| `text` | anything else that decodes as text | UTF-8 or UTF-16 (with or without BOM); binary is rejected |

Lines longer than 2,000 characters are split, so every line can be read by number.

### PDF tables

A PDF stores no tables, only text at positions. Read in file order, a row with an empty cell looks
like a row without that column: `EMEA 80 95 101` under the headings `Q1 Q2 Q3 Q4`, and a model
reads 95 as Q2. The PDF extractor finds tables by the position of their text and writes each row
with its cells marked, so the same row becomes:

```
| Region | Q1 | Q2 | Q3 | Q4 |
| EMEA | 80 |  | 95 | 101 |
```

In a live test (`gemini-3.5-flash-lite`, 110 questions about single cells of seven PDFs made by
Word and Chrome, half of them about empty cells), 44 answers were right from the text in file
order and 110 from the rebuilt rows.

What it handles: empty cells, tables inside one column of a two-column page, right-to-left tables
(the first column is the rightmost), tables printed sideways, rotated pages, footnote marks,
headings that span columns, and cells whose text wraps onto several lines when the rows are
visibly spaced apart. Text that is not a table (paragraphs, lists, columns of prose, justified
text) is left as pdf.js gives it.

It is cautious: where the evidence for a table is weak, the text stays as it was. So:

- Two-column tables (key and value, a glossary) are left as lines of text. They read correctly
  that way.
- When a cell wraps and the rows have no extra space between them, each line of the cell is a row
  of its own, with the other cells empty.
- Columns that are closer together than a word space on every line of the table stay together in
  one cell, on every row alike.
- A table whose text is stored column by column in the file is not rebuilt.
- Pictures and charts are not in the text. A page with no text at all is written as
  `[No text on this page. It may be a scan, a photo, or a chart.]`, so the model can say that it
  cannot see it. To let the model look at such pages, see [Pictures in PDFs](#pictures-in-pdfs).

The cell marks cost tokens: about one per cell. A bank statement came to 27% more tokens than
its text in file order, a report with one table in it to 9% more. Reading 600 pages with 24,600
table rows took 1.6 seconds instead of 1.3.

The rules were tuned on PDFs made by Chrome and by Word. To get the text of version 0.1.0 instead:

```ts
import { createLargeFiles, createPdfExtractor } from "llm-large-files";

createLargeFiles({ store, extractors: { pdf: createPdfExtractor({ tables: false }) } });
```

Small PDFs are still better sent to Gemini as the file itself, when your payload limit allows:
it then sees every page, including pictures. For a PDF that is too large for that, the next section
gives the model the pages it asks for.

## Pictures in PDFs

The text of a PDF does not hold its photos, charts and diagrams. Asked about a bar chart from the
text alone, a model can only say that it cannot see it, or guess. Two things, both optional and
both for PDFs only, close that gap:

1. **A line in the text that says where the pictures are.**
2. **A tool, `view_pages`, that hands the model the real pages** as a small PDF, when it asks.

```bash
npm install @cantoo/pdf-lib      # optional dependency, needed for both
```

```ts
const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  keepOriginals: ["pdf"],        // needed for view_pages: it cuts pages out of the uploaded file
});
// askGemini then offers view_pages by itself. Nothing else changes in your code.
```

### The line that marks a page

At ingest, a page that shows a picture or a drawing gets one line under its header:

```
--- Page 12 ---
[Picture on this page. This text cannot show it.]
Figure 3: sales by region.
```

The words hold whether or not the model can look at the page later. A search for
`[Picture on this page` lists every such page.

What counts:

- **A picture:** the images on the page cover 3% of it or more, measured by the size they are
  shown at, not by their pixels. A logo covers about 1%. An image that is on 30% of the pages (and
  on three at least) is taken for a logo, a letterhead or a watermark, and does not count,
  whatever its size.
- **A drawing:** shapes filled in three or more colours, outside the tables. Greys, rules, dots
  and page backgrounds do not count, and neither does the shading of a table's cells.
- A page whose drawing instructions are larger than 2 MB: that is a map or a technical drawing.

What it gets wrong:

- Missed: a chart in one or two colours, and a chart or diagram drawn only with lines.
- Marked by mistake: a table with cells shaded in three colours, when the table itself was not
  recognised (a table of two columns, for example).

The mark is a hint. `view_pages` works on any page, marked or not, and in a live test the model
looked at a one-colour chart that had only a caption (below).

The pages are found from the structure of the file, without decoding any image, so it is cheap:
a PDF of 200 photos (85 MB) took 0.3 s to ingest without marks and 0.8 s with them. No page is
marked, and the text is exactly that of version 0.2.0, when:

- `@cantoo/pdf-lib` is not installed;
- you turn it off: `createPdfExtractor({ pictures: false })`;
- the file declares more than 150,000 objects (reading it would take over two seconds), reading
  took more than five seconds, or the file does not have the pages the text was read from.

One cost to know: a PDF whose streams do not state their length up front (Ghostscript writes them
so) is scanned byte by byte, about 30 ms per MB. A file of 100 MB written that way took 3 s to
ingest instead of 0.1 s.

### `view_pages`

`view_pages(document_id, from_page, to_page)` cuts those pages out of the kept original and
returns them as one PDF. `askGemini` puts it inside the function response, and Gemini reads it
like any PDF: text, pictures and layout.

It is offered for every PDF whose original is kept, also for one whose text is already in the
prompt: a slide deck of photos has little text, so its text fits, and without the tool the model
would see none of its slides. Such a PDF gets `view_pages` and no search tools.

For a PDF that the model can look at, search and read results also say which page a line is on
(`"page": 12`), since a page number is what `view_pages` takes.

Limits:

| Limit | Value | When it is reached |
|---|---|---|
| Pages per call | 5 | The result says where to continue (`next_page`). |
| Bytes | What is left of `maxRequestBytes`, less a tenth kept free (256 KB at least), times 3/4 for base64 | Pages are left off the end of the call. A page that does not fit by itself gives an error, and the model answers from what it has. |
| Pages per question | `reservedTokens / 2 / 530`: 60 with the default budget | The tool says that no more pages can be looked at. |

Pages stay in the request until the question is answered, so every look makes the later requests
of that question larger. They are not sent again with the next question.

A page costs Gemini about 530 tokens, whatever is on it: 532 for each of 1, 2, 3 and 5 A4 pages,
and 527 for a 16:9 slide (`gemini-3.5-flash-lite`).

A cut holds the pages asked for and little else. Copying pages the simple way does not: a contents
page links to every section, and those pages came along, so the cut was 89% of the file. Here every
other page is emptied before copying, and a page that shares its resources with the whole file
(FPDF, TCPDF and jsPDF write PDFs that way) gets a list of its own.

| File | Pages cut | Size of the cut |
|---|---|---|
| Chrome, 72 photos, 100 MB | 5 | 7.0 MB (7%) |
| PowerPoint deck, 40 photos, 9.9 MB | 5 | 1.2 MB (13%) |
| Word report with a contents page, 7.5 MB | the contents page | 55 KB (0.7%) |
| All images in one shared list, 12 MB | 2 | 0.6 MB (5%) |

What a cut costs the server: the whole file is read into memory on every call.

| File | Time | Memory at the peak |
|---|---|---|
| 100 MB of photos, 900 objects | 0.06 s | about 300 MB |
| 100 MB written the way Ghostscript writes | 3 s | about 300 MB |
| 54 MB, 330,000 objects (a tagged table of 591 pages) | 4 to 5 s | about 700 MB |

A file that declares more than a million objects, or more than the free memory can hold, is not
cut: the tool tells the model that the pages cannot be shown.

Also handled: PDFs encrypted only to restrict printing or copying (they open without a password),
hidden layers (they stay hidden), rotated pages, and links. Not shown: a PDF that needs a password
to open, a damaged file, and a file in which this reader counts other pages than the text
extractor did. In each case the model gets a message and answers from the text.

### Scanned PDFs

A PDF with no text at all has nothing to search, and is refused: `This PDF has no text layer`. When
its original is kept, the model can read it by looking at its pages, so a scan of **up to 30
pages** is accepted. Every page of its text says that it has no text, and the model gets
`view_pages`. A longer scan is still refused: it could only be read five pages at a time, and it
could not be searched.

```ts
createLargeFiles({ store, keepOriginals: ["pdf"], scannedPdfPages: 30 }); // 30 is the default; 0 refuses all scans
```

A PDF with text on any page was always accepted and still is, however many of its pages are scans.

### Live results

`gemini-3.5-flash-lite` on the Gemini API, November 2026, through `ingest` and `askGemini`:

| Check | Result |
|---|---|
| Which bar of a chart is tallest and shortest, and their colours; a number on a sign in a photo. Text sent whole. | Looked at 2 pages unasked. All five facts right. From the text alone, the model said it could not see the chart. |
| The same, with the PDF searched instead | One look, all five right. |
| Ten questions that the text answers, about a PDF with a photo on each of its 60 pages | 0 of 10 looked at a page, with the text sent whole and with the PDF searched. 10 of 10 right both times. |
| A chart in one colour: a caption, but no mark | The model looked at the page and read the chart correctly. |
| Five pages in one look (five numbers on five signs) | All five right. 2,660 tokens for the pages. |
| A slide deck of 41 slides: a number on slide 8, a bar on slide 1 | Two looks, both right. |
| A PDF encrypted to restrict printing | One look, all right. |
| A scan of three pages (pictures of text) | One look at the three pages. Four of four facts right. |
| The request without tools that ends a question, after a look | Accepted, answered correctly, with the pages still in it. |

Not checked yet: Vertex AI. The pages can go inside the function response (the default) or next
to it; both work on the Gemini API:

```ts
await askGemini({ ..., toolFilePlacement: "beside" }); // if your endpoint refuses a file inside a function response
```

### Your own loop

The pages are a file, and a loop that drops the file would tell the model that pages are attached
with nothing attached. So `view_pages` is declared only when you say that your loop delivers files:

```ts
const prepared = await files.prepare(documentIds, base, { owner, viewPages: true });
const tools = files.tools(prepared.plan.searchable, { viewPages: prepared.viewable });

const { result, files: attached } = await tools.executeWithFiles(call.name, call.args, {
  maxFileBytes: Math.floor(roomLeftInYourRequest * 3 / 4), // base64 turns three bytes into four
  maxPages: pagesYouStillAllowForThisQuestion,
});
// attached: [{ name: "pages-12-14.pdf", mimeType: "application/pdf", bytes }]
// Send `result` as the tool result and each file as a PDF next to it, in your provider's form.
```

`tools.execute("view_pages", ...)` returns only JSON, so it answers with an error instead of
pretending. `prepared.viewable` also lists PDFs that are not searched, because their text is in
the prompt: pass it as it is.

### Custom extractors

Replace or add one per format, for example OCR for scanned PDFs, or HTML to text:

```ts
createLargeFiles({
  store,
  extractors: {
    pdf: async (bytes, { name }) => ({ text: await myOcrService(bytes), pages: undefined }),
  },
});
```

Formats come from `detectFormat(name, mimeType)`; unknown extensions use the `text` extractor.
