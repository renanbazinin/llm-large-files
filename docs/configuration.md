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
  delete(id: string): Promise<boolean>;
  sweep?(now?: Date): Promise<number>;
}
```

Keep `getMeta` cheap (store the metadata separately from the text). Parsed documents are cached
in memory (`cacheSize`, default 6), so repeated tool calls don't reload the text.

## Formats

| Format | Detected by | Notes |
|---|---|---|
| `log` | `.log`, `.out`, `.err`, or text whose early lines mostly start with a timestamp or level | Gets a log profile |
| `markdown` | `.md`, `.markdown`, `text/markdown` | Headings form the outline |
| `json` | `.json`, `.jsonl`, `.ndjson` | Minified JSON is wrapped into addressable lines |
| `csv` | `.csv`, `.tsv` | |
| `pdf` | `.pdf` | Needs `unpdf`. Pages are marked `--- Page N ---`, tables are rebuilt (below), and a page without text says so. Scanned PDFs (no text layer at all) are rejected. |
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
- Pictures, charts and scanned pages are still not read. A page with no text at all is written as
  `[No text on this page. It may be a scan, a photo, or a chart.]`, so the model can say that it
  cannot see it.

The cell marks cost tokens: about one per cell. A bank statement came to 27% more tokens than
its text in file order, a report with one table in it to 9% more. Reading 600 pages with 24,600
table rows took 1.6 seconds instead of 1.3.

The rules were tuned on PDFs made by Chrome and by Word. To get the text of version 0.1.0 instead:

```ts
import { createLargeFiles, createPdfExtractor } from "llm-large-files";

createLargeFiles({ store, extractors: { pdf: createPdfExtractor({ tables: false }) } });
```

Small PDFs are still better sent to Gemini as the file itself, when your payload limit allows:
it then sees the page, including pictures.

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
