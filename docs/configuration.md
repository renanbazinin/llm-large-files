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
| `toolResultCharacters` | 24,000 | Cap on one tool result. |

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

`estimateTokens` counts about 4 characters per token for ASCII and 1.5 for other scripts
(Hebrew, Arabic, CJK, …). That's deliberately conservative: overestimating only makes a file
searchable a little sooner. On English text it matched Gemini's own count within 0.01%.

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
| `pdf` | `.pdf` | Needs `unpdf`. Pages are marked `--- Page N ---`. Scanned PDFs (no text layer) are rejected. |
| `docx`, `pptx` | extension or MIME type | Needs `jszip`. Slides are marked `## Slide N`. |
| `text` | anything else that decodes as text | UTF-8 or UTF-16 (with or without BOM); binary is rejected |

Lines longer than 2,000 characters are split, so every line can be read by number.

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
