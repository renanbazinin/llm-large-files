// Public types. Everything a consumer touches is defined here, so the package can be
// published without exposing internal module layout.

export type DocumentFormat = "text" | "markdown" | "log" | "json" | "csv" | "pdf" | "docx" | "pptx" | "xlsx" | "html";

export type OutlineEntry = {
  /** 1-based line number in the extracted text. */
  line: number;
  /** 1 is the top level. */
  level: number;
  title: string;
};

export type LogIssue = {
  /** The message with numbers, IDs, addresses, and quoted values replaced by placeholders. */
  template: string;
  level: string;
  count: number;
  firstLine: number;
};

export type LogProfile = {
  levels: Record<string, number>;
  firstTimestamp?: string;
  lastTimestamp?: string;
  /** The most frequent ERROR/FATAL/WARN message shapes. */
  topIssues: LogIssue[];
};

/**
 * Where a document belongs, from the widest part to the narrowest: `[userId, chatId]`. 1 to 8
 * segments, each 1 to 256 UTF-16 units, with no control characters, no "/" or "\", and none of them
 * "." or "..". A scope that breaks these rules is a `DocumentScopeError`. New in 0.9.0.
 */
export type DocumentScope = readonly string[];

/**
 * What the library knows of the caller of a store method: the scope and the owner it was given. It
 * is the last argument of every `DocumentStore` method, and both fields may be absent. A store may
 * keep the documents of each scope apart (a folder, a key prefix, a collection filter), and pass
 * the context on unchanged when it wraps another store. New in 0.9.0.
 */
export type DocumentContext = { readonly scope?: DocumentScope; readonly owner?: string };

export type DocumentMeta = {
  id: string;
  /**
   * The version of this metadata's shape: `DOCUMENT_META_VERSION` (1) on documents ingested by
   * 0.9.0 and later, absent on older ones. The library refuses a higher one (a document written by a
   * newer version of the package) with a `DocumentStoreError` of code "NEWER_VERSION". It is never
   * sent to the model. New in 0.9.0.
   */
  metaVersion?: number;
  /** Who may use this document. Set it at ingest; access with another owner is refused. */
  owner?: string;
  /**
   * The scope the document was ingested in (`IngestInput.scope`), as a copy. Only a caller with the
   * same scope may use it. It is never sent to the model, nor in a summary. An event holds it only
   * with `AskOptions.eventResults: true`, in the full plan of `run.finish` and `run.error`. New in 0.9.0.
   */
  scope?: string[];
  /**
   * The SHA-256 of the uploaded file, as 64 lowercase hex digits. It is never sent to the model, nor
   * in a summary. An event holds it only with `AskOptions.eventResults: true`, in the full plan of
   * `run.finish` and `run.error`. New in 0.9.0.
   */
  sha256?: string;
  /**
   * The uploaded file, when the application keeps it and the library reads it from there
   * (`IngestInput.original`): where it is, and its size and SHA-256 when it was read, to know that
   * it has not changed since. `ref` is never sent to the model, nor in a summary. An event holds it
   * only with `AskOptions.eventResults: true`, in the full plan of `run.finish` and `run.error`.
   * New in 0.9.0.
   */
  original?: { ref: string; bytes: number; sha256: string };
  name: string;
  mimeType: string;
  format: DocumentFormat;
  /** Size of the uploaded file. */
  bytes: number;
  /** UTF-8 size of the extracted text. */
  textBytes: number;
  /**
   * Bytes the text takes inside a JSON request body, with the escapes JSON adds. Absent on a
   * document ingested before 0.4.1: planning then assumes 8% more than `textBytes`.
   */
  jsonBytes?: number;
  characters: number;
  lines: number;
  estimatedTokens: number;
  /** Lines longer than the wrap limit are split so every line stays readable by line number. */
  wrappedLines: number;
  pages?: number;
  /**
   * The older encoding a text file was read in, because it is not UTF-8: "windows-1255" for a
   * Hebrew CSV that Excel saved. Lines of it that are valid UTF-8 are read as UTF-8 all the same.
   * Absent for valid UTF-8, for a file read as UTF-8 with characters that are not valid (see
   * `replacedCharacters`), for UTF-16, for PDF, DOCX and PPTX, and on documents from before 0.6.0.
   */
  encoding?: string;
  /**
   * Characters of a text file that were not valid in the encoding it was read in, such as a
   * character cut in two at the end of a UTF-8 log, or a byte that `encoding` does not have: each
   * is stored as U+FFFD (�). Absent when there were none, and on documents from before 0.6.0.
   */
  replacedCharacters?: number;
  /**
   * True when the uploaded file itself is kept in the store next to its text (see `keepOriginals`).
   * Recorded here so that planning a request does not have to load the file to know.
   */
  originalKept?: boolean;
  outline: OutlineEntry[];
  logProfile?: LogProfile;
  /**
   * The pages of a PDF that have no text at all: scans, photos, charts. Up to 200 are listed.
   * Absent when there are none, and on documents from before 0.8.1.
   */
  pagesWithoutText?: number[];
  /**
   * The pages of a PDF whose text looks garbled: few letters and digits among their characters, or
   * many replacement characters (a font without a Unicode map). Up to 200 are listed. Absent when
   * there are none, and on documents from before 0.8.1.
   */
  garbledPages?: number[];
  /**
   * The scripts the text is written in, by their share of its letters in percent ("Hebrew" 81,
   * "Latin" 19), from its first 2 MB, those of 5% or more. Absent for a text in Latin letters alone,
   * one with few letters, and documents from before 0.8.1.
   */
  scripts?: Array<{ script: string; percent: number }>;
  createdAt: string;
  expiresAt: string;
  /**
   * The application's own data about the document (`IngestInput.appData`, `files.update`): a JSON
   * object of at most `MAX_APP_DATA_BYTES` (16 KB) as JSON, such as the ID of its row in your
   * database or a label. The library keeps it with the metadata and does nothing else with it: it
   * is never sent to the model, nor in a summary. An event holds it only with
   * `AskOptions.eventResults: true`, in the full plan of `run.finish` and `run.error`. New in 0.10.2.
   */
  appData?: AppData;
};

/** A value JSON can hold: what `DocumentMeta.appData` is made of. New in 0.10.2. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The application's own data about a document (`DocumentMeta.appData`): a JSON object. New in 0.10.2. */
export type AppData = { [key: string]: JsonValue };

/**
 * What `DocumentStore.patchMeta` changes in the metadata of one document. New in 0.10.2.
 */
export type MetaPatch = {
  /**
   * The `createdAt` of the document to change. A document stored again under the same ID since
   * (deleted, then ingested again) has another, and is not changed.
   */
  createdAt: string;
  /**
   * The owner of the document to change, absent for none: a document of another owner, even of the
   * same `createdAt`, is not changed. Compare as `owner ?? undefined` (null is none).
   */
  owner?: string;
  /** The scope of the document to change, absent for none, compared segment by segment, as `owner` is. */
  scope?: DocumentScope;
  /** A later expiry: the stored `expiresAt` becomes the later of the two, as ISO 8601 dates compare. */
  expiresAt?: string;
  /** The application's own data: replaces `appData` whole, or removes it when null. */
  appData?: AppData | null;
};

export type StoredDocument = { meta: DocumentMeta; text: string };

/** A JSON-safe summary for API responses and browser state. */
export type DocumentSummary = {
  id: string;
  name: string;
  mimeType: string;
  format: DocumentFormat;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  pages?: number;
  /** See `DocumentMeta.encoding`. */
  encoding?: string;
  /** See `DocumentMeta.replacedCharacters`. */
  replacedCharacters?: number;
  expiresAt: string;
};

/**
 * Where extracted text lives. Implement this for Redis, S3, a database, etc.
 *
 * Every method takes a last, optional `context` (`DocumentContext`): the scope and the owner of
 * the call. New in 0.9.0. A store written for 0.8, whose methods take no context, still implements
 * this interface, and works as before. A store that wraps another one passes the context on.
 */
export interface DocumentStore {
  put(document: StoredDocument, context?: DocumentContext): Promise<void>;
  /** Returns undefined for unknown or expired documents. */
  get(id: string, context?: DocumentContext): Promise<StoredDocument | undefined>;
  getMeta(id: string, context?: DocumentContext): Promise<DocumentMeta | undefined>;
  /** Removes the document, and its original file if one is kept. */
  delete(id: string, context?: DocumentContext): Promise<boolean>;
  /**
   * Removes expired documents (and their original files) and returns how many were removed. With
   * a scope in `context`, only those of that scope; without one, those of every scope.
   */
  sweep?(now?: Date, context?: DocumentContext): Promise<number>;
  /**
   * Keeps the uploaded file of a document. It is called before `put` for the same ID. Optional: a
   * store without it works as before, and original files are then not kept.
   */
  putOriginal?(id: string, bytes: Uint8Array, context?: DocumentContext): Promise<void>;
  /** The uploaded file, or undefined when none was kept or the document is unknown or expired. */
  getOriginal?(id: string, context?: DocumentContext): Promise<Uint8Array | undefined>;
  /**
   * Bytes `start` (inclusive) to `end` (exclusive) of the stored text, as UTF-8. Optional: with it,
   * a tool call reads only the lines it needs, and a search reads the text a piece at a time,
   * instead of loading the whole text into memory. Return fewer bytes at the end of the text, and
   * undefined when the document is gone. It is called only after `getMeta` found the document.
   */
  readTextRange?(id: string, start: number, end: number, context?: DocumentContext): Promise<Uint8Array | undefined>;
  /**
   * Keeps the line index of a document (a few bytes a line), so that reading by range needs no
   * pass over the text first. Called at ingest, before `put`, and when an older document without an
   * index is first read. Optional, and only useful with `readTextRange`.
   */
  putIndex?(id: string, index: Uint8Array, context?: DocumentContext): Promise<void>;
  /** The index kept by `putIndex`, or undefined. A damaged one is noticed and built again. */
  getIndex?(id: string, context?: DocumentContext): Promise<Uint8Array | undefined>;
  /**
   * The metadata of the documents of the scope of `context`, in any order: those stored without a
   * scope when it has none. A store that keeps no scopes apart gives every document it has. It may
   * leave out the expired ones, or give them: the library leaves them out. Optional:
   * `files.list()` and `ingest({ dedupe })` need it. A store of many documents should answer
   * from an index (a database query on the scope), not by reading each one. New in 0.10.2.
   */
  list?(context?: DocumentContext): Promise<DocumentMeta[]>;
  /**
   * Changes the fields of `patch` in the metadata of the document `id` whose `createdAt`, owner and
   * scope are `patch`'s, and nothing else: its other fields, its text, line index and original stay
   * as they are. Returns the metadata as it is after the change, or undefined when no such document
   * is there (unknown, deleted, expired, or another one stored under the ID since), and nothing was
   * written. Apply the fields to what is stored at the time of the write, not to a copy read
   * before: two changes at once (a `touch` and an `update`) must both stay. A database does it in
   * one conditional update (`$max` on the expiry, `$set`/`$unset` on `appData`). Optional:
   * `files.touch()`, `files.update()` and `ingest({ dedupe })` use it. New in 0.10.2.
   */
  patchMeta?(id: string, patch: MetaPatch, context?: DocumentContext): Promise<DocumentMeta | undefined>;
}

export type ExtractedText = {
  text: string;
  pages?: number;
  /**
   * The older encoding the file was read in, when it is not UTF-8. Kept as `DocumentMeta.encoding`
   * when it is a name, and not one of UTF-8 or UTF-16.
   */
  encoding?: string;
  /** Characters that were not valid in the encoding the file was read in, each now U+FFFD. Kept as `DocumentMeta.replacedCharacters`. */
  replacedCharacters?: number;
  /**
   * What an extractor that reads paths (`Extractor.readsPath`) read from `ExtractInput.path`: how
   * many bytes the file has, and their SHA-256, as 64 lowercase hex digits. Kept as
   * `DocumentMeta.bytes` and `DocumentMeta.sha256`. Without it, `ingest` reads the file once more
   * to hash it, a slice at a time. Other extractors leave it out. New in 0.9.0.
   */
  file?: { bytes: number; sha256: string };
  /**
   * A PDF's headings, found from the size of its type: each line set larger than the body, with
   * its page (from 1), its level (1 is the top) and its text, in the order of the text; and `skip`,
   * when lines above it on its page read the same (a contents list, a running header), how many.
   * The built-in PDF extractor returns them; `ingest` finds each among the lines of its page (the
   * lines after `--- Page N ---`), with spaces left out of the comparison, past the first `skip`
   * that match, and makes them the outline when the text's own rules find fewer than 3 headings and
   * it finds 3 or more. Read for a PDF only. An extractor that wraps the built-in one passes them on
   * to keep that outline. New in 0.10.0.
   */
  headings?: Array<{ page: number; level: number; title: string; skip?: number }>;
};

export type ExtractInput = {
  name: string;
  mimeType: string;
  format: DocumentFormat;
  /**
   * Set when a PDF without any text (a scan) is worth storing, because its pages can be shown to
   * the model: the most pages such a PDF may have. Unset, a PDF without text is refused, as it
   * always was. An extractor of your own may ignore it.
   */
  scannedPages?: number;
  /**
   * Aborted when the ingest's time is up (`ingestTimeoutMs`) or the caller gave up
   * (`IngestInput.signal`). The built-in extractors stop between pages and pieces; its `reason`
   * is the error to throw. An extractor of your own should stop too: `ingest` stops waiting for it
   * either way, but cannot stop the work it does.
   */
  signal?: AbortSignal;
  /**
   * The most text to keep from this file, in UTF-8 bytes (`maxTextBytes`). The built-in extractors
   * refuse a file as soon as its text grows past it. `ingest` refuses any larger result.
   */
  maxTextBytes?: number;
  /** The most pages to read from one PDF (`maxPdfPages`). The built-in PDF extractor refuses more. */
  maxPages?: number;
  /**
   * Call it as the extraction goes on, so `ingest` can report progress (`IngestInput.onEvent`).
   * The built-in extractors call it for each page of a PDF (also for the page check and the
   * picture marks: `stage` "check" and "pictures"), each part of a DOCX or PPTX, and once when a
   * text file not in UTF-8 is decoded ("decode"). Calls after the extractor returned are dropped. An
   * extractor of your own may ignore it. New in 0.7.0.
   */
  onProgress?: (progress: ExtractProgress) => void;
  /**
   * The path of the file, when it is ingested from a path (`IngestFromSource`) and the extractor
   * reads the file itself (`Extractor.readsPath`): the bytes it is given are then empty. Read it
   * once, at most `maxUploadBytes + 1` bytes, refuse it when it has more than `maxUploadBytes`, and
   * return its size and SHA-256 in `ExtractedText.file`. Never write, move or delete it. New in 0.9.0.
   */
  path?: string;
  /** With `path`: the most bytes the file may have (`maxUploadBytes`). New in 0.9.0. */
  maxUploadBytes?: number;
};

/** How far an extraction is, for `ExtractInput.onProgress`. */
export type ExtractProgress = {
  /** "extract" (the default): text read; "check": pages checked before reading; "pictures": pages looked at for pictures; "decode": bytes of a text file decoded. */
  stage?: "extract" | "check" | "pictures" | "decode";
  done: number;
  /** Absent when not known. */
  total?: number;
  unit: "pages" | "parts" | "bytes";
};

/**
 * Reads the text of a file. A plain function is an extractor, as before. `readsPath`, new in 0.9.0:
 * the extractor reads a file ingested from a path itself, from `ExtractInput.path`, so the server
 * does not read it first (`createIsolatedExtractors` sets it: its child processes read the file).
 * It is then given empty bytes, unless the file is kept in the store (`keepOriginals` without
 * `IngestInput.original`), which needs its bytes in the server.
 */
export type Extractor = ((bytes: Uint8Array, input: ExtractInput) => Promise<ExtractedText>) & { readsPath?: boolean };

/** The limits of the model connection the documents must fit through. */
export type Budget = {
  /** The model's context window, in tokens. */
  contextTokens: number;
  /** The largest request body the model connector accepts, in bytes. */
  maxRequestBytes: number;
  /** The most document text to include in full in one request, in tokens. */
  inlineTokens: number;
  /** Tokens kept free for the answer, tool results, and conversation growth. */
  reservedTokens: number;
  /** Size of each part when a whole document is read with map-reduce. */
  mapChunkTokens: number;
  /** Refuse whole-document reads that would need more parts than this. */
  maxMapChunks: number;
  /** Cap on the characters of one tool result sent back to the model. */
  toolResultCharacters: number;
};

/** A JSON Schema subset accepted by Gemini, OpenAI, and Anthropic function declarations. */
export type JsonSchema = {
  type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

export type ToolDeclaration = {
  name: string;
  description: string;
  parameters: JsonSchema & { type: "object" };
};

export type ToolResult = Record<string, unknown>;

/**
 * A file a tool hands back next to its JSON result, for example pages cut out of a PDF. Since
 * 0.99.9 also an uploaded file a turn of the conversation carries (`ModelTextMessage.files`).
 */
export type ToolFile = {
  /** A short ASCII name, unique among the files of one result: "pages-12-14.pdf". */
  name: string;
  /**
   * "application/pdf" for the pages of `view_pages` as a PDF, "image/jpeg" or "image/png" for a
   * page drawn as an image (since 0.99.9), and the format's type for a file of
   * `ModelTextMessage.files`.
   */
  mimeType: string;
  bytes: Uint8Array;
};

/**
 * A kind of file a tool may hand a model (`ModelCapabilities.toolFileTypes`): a PDF, or a page drawn
 * as an image. New in 0.99.9.
 */
export type ToolFileType = "application/pdf" | "image/png" | "image/jpeg";

/**
 * How `view_pages` draws pages when they go as images (`ToolOptions.pageImages`): "jpeg" (quality
 * 0.85) or "png", at `PAGE_IMAGE_SIDE` (1,568) pixels on the longest side. New in 0.99.9.
 */
export type PageImageOptions = {
  format: "png" | "jpeg";
};

/** A tool's JSON result, and the files that belong to it. Most tools return no files. */
export type ToolOutput = { result: ToolResult; files: ToolFile[] };

/** What one tool call is allowed to use of the request its result will be sent in. */
export type ToolCallLimits = {
  /**
   * The most bytes the files of this call may have together. Give the room left in your request,
   * times 3/4 when files are sent as base64. Defaults to 3/8 of (`maxRequestBytes` − 262,144), the
   * 256 KB the library keeps free in a request taken off first: 3,651,696 bytes for the default budget.
   */
  maxFileBytes?: number;
  /** The most pages this call may show. Lower it as the pages already shown use up your token budget. */
  maxPages?: number;
  /**
   * The most characters the JSON result of this call may have, when that is less than the tool's
   * own cap (`toolResultCharacters`): the room left in the request. The result is cut to it, and
   * says where to go on.
   */
  maxResultCharacters?: number;
  /**
   * The most model requests a whole-file read (`analyze_whole_document`) may make: what the
   * question has left of `limits.requests`. A part the model refuses as too large is read as two
   * halves only while that and `maxMapChunks` allow it. Given to a `read_document` call (since
   * 0.10.0), it is what a whole read of its file may make on the model's next turn, the first it
   * can call one on: a read cut short of its range points at one (`whole_file`) only when the
   * file's estimated parts are within it. `askWithFiles` gives a read 0 when the question would not
   * start a whole read of its file on that turn (a ceiling it would pass, with that turn's request
   * counted, or its whole reads made).
   */
  maxRequests?: number;
  /**
   * The most milliseconds a look at pages (`view_pages`) of this call waits for its turn, when that
   * is less than the library's `pageLookWaitMs`. 0: it runs only when a turn is free now, and is
   * told the server is busy if not. `askWithFiles` gives 0 to the looks of a turn after one of them
   * came back busy, so that a wait that ends busy comes once in a turn. New in 0.9.0.
   */
  maxWaitMs?: number;
};

/** A format whose uploaded file a model may be sent as it is (`DocumentsCapability`). New in 0.99.9. */
export type NativeDocumentFormat = "pdf" | "pptx";

/**
 * The uploaded files a model reads natively when they are in a user turn (`ModelCapabilities.documents`).
 * New in 0.99.9.
 */
export type DocumentsCapability = {
  /** The formats it reads: "pdf"; "pptx" too on the Gemini API. */
  formats: readonly NativeDocumentFormat[];
  /** The most bytes of one file. Defaults to `DEFAULT_NATIVE_FILE_BYTES` (4,194,304). */
  maxFileBytes?: number;
  /** The most pages (slides, for a deck) of one file. Defaults to `DEFAULT_NATIVE_PAGES` (10). */
  maxPages?: number;
};

/**
 * What `prepare` is told of the files a question may send as they are (`PrepareOptions.nativeDocuments`):
 * the capability every model shares, with its defaults filled in, and what a page costs in the
 * library's estimate of tokens. New in 0.99.9.
 */
export type NativeDocumentsPlan = {
  formats: readonly NativeDocumentFormat[];
  maxFileBytes: number;
  maxPages: number;
  pageTokens: number;
};
/**
 * Listeners for one tool call, next to its limits. New in 0.7.0: with them, the progress of two
 * whole-file reads that run at once can be told apart.
 */
export type ToolCallHooks = {
  /** Progress of this call (a whole-file read), in place of `ToolOptions.onProgress` for it. */
  onProgress?: ProgressListener;
  /**
   * Each model request this call makes (a whole-file read), as it starts. Tell the handle it
   * returns about each retry of that request, and when it ends.
   */
  onRequest?: (request: ToolRequestStart) => ToolRequestHandle;
  /**
   * The document this call names is no longer in the store: deleted or expired since it was
   * planned, or not readable by the caller (which looks the same). The call answers the model with
   * an error that says so. `askWithFiles` makes it a "document_gone" notice. New in 0.9.0.
   */
  onDocumentGone?: (documentId: string) => void;
  /**
   * A look at pages (`view_pages`) waited longer than `pageLookWaitMs` for its turn
   * (`maxConcurrentPageLooks`) and was not run. The call answers the model with an error that says
   * the server is busy. `askWithFiles` makes it a "page_looks_busy" notice. New in 0.9.0.
   */
  onPagesBusy?: (documentId: string) => void;
  /**
   * Ends this call alone: its scans, regex searches, whole-file read, look at pages and loads. It is
   * joined with the tool set's own signal (`ToolOptions.signal`). New in 0.10.0.
   */
  signal?: AbortSignal;
};

/** One model request of a tool call (`ToolCallHooks.onRequest`). */
export type ToolRequestHandle = {
  /**
   * The request failed and is sent again after `delayMs`. `reason` "auth_refresh" (0.99.13): it
   * was refused with HTTP 401 and is sent again at once with a new token.
   */
  retry(notice: { attempt: number; delayMs: number; error: unknown; reason?: "auth_refresh" }): void;
  /** The request ended, after any retries. Call it once. */
  end(end: ToolRequestEnd): void;
};

/** A model request of a tool call, as it starts (`ToolCallHooks.onRequest`). */
export type ToolRequestStart = {
  purpose: "part" | "merge" | "final";
  /** "part 3 of 12", "first half of part 3 of 12", "round 2: 1 of 4", "the answer". */
  detail: string;
};

/** A model request of a tool call, as it ends. */
export type ToolRequestEnd = {
  outcome: "ok" | "error";
  usage?: GenerateUsage;
  error?: unknown;
};

/** The name of `ToolCallLimits` before 0.5.0. */
export type ToolFileLimits = ToolCallLimits;

export type ToolSet = {
  declarations: ToolDeclaration[];
  has(name: string): boolean;
  /**
   * Runs a tool call. Bad arguments come back as `{ error }` so the model can correct itself. A
   * tool that returns files (`view_pages`) answers with an error here: use `executeWithFiles`.
   */
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /**
   * Runs a tool call and also returns the files it produced, to be sent to the model with the
   * result. Use it in place of `execute` in a loop that can send files.
   */
  executeWithFiles(name: string, args: Record<string, unknown>, limits?: ToolCallLimits, hooks?: ToolCallHooks): Promise<ToolOutput>;
  /** A short, human-readable line describing a call, for progress UIs. */
  describe(name: string, args: Record<string, unknown>): string;
  /**
   * The most characters the JSON result of a tool can have: what a loop sets aside in its request
   * before it runs a call.
   */
  resultCharacters(name: string): number;
  /**
   * How many more times this tool set may read the document `documentId` whole
   * (`analyze_whole_document`): 0 once a read of it found no part it could read, or at the cap.
   * Optional, so that a tool set of your own still compiles. The tool set of `files.tools()` has
   * it. New in 0.10.0.
   */
  wholeReadsLeft?(documentId: string): number;
};

/** Tokens one model request used, as far as the provider said. */
export type GenerateUsage = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; thoughtTokens?: number };

/** A plain text completion. The package stays provider-neutral by taking this as a function. */
export type GenerateText = (request: {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /**
   * Call this when the model stopped because it reached `maxOutputTokens`, so a whole-document
   * read can say its result is incomplete. Optional: an implementation that never calls it works
   * as before, without that warning.
   */
  onTruncated?: () => void;
  /**
   * Call this once for every request that was answered, with the tokens it used, so that the cost
   * of a whole-document read is counted. Optional: without it, `askWithFiles` still counts each
   * answered request (in `usage.requests` and against `limits.requests`), but not its tokens.
   */
  onUsage?: (usage: GenerateUsage) => void;
  /**
   * Call this when a request refused with HTTP 401 is sent again at once with a new token, just
   * before the token is asked for; `refused` is the 401. A whole-document read tells it as a
   * `retry` event of reason "auth_refresh". Optional. New in 0.99.13.
   */
  onRefresh?: (refused: unknown) => void;
}) => Promise<string>;

export type ProgressEvent = {
  kind: "map" | "reduce";
  message: string;
  done: number;
  total: number;
};

export type ProgressListener = (event: ProgressEvent) => void;

export type DocumentPlan = {
  /** Documents whose full text goes into the prompt. */
  inline: DocumentMeta[];
  /** Documents the model reaches only through tools. */
  searchable: DocumentMeta[];
  inlineTokens: number;
  inlineBytes: number;
};

/**
 * The name of a document tool, as the model calls it (`TOOL_NAMES`). New in 0.10.0.
 */
export type ToolName = "search_document" | "read_document" | "get_document_overview" | "analyze_whole_document" | "view_pages" | "aggregate_table";

/**
 * What `prepare` gives for one request. The fields new in 0.10.0 are optional, so that a
 * `LargeFiles` of your own still compiles: without them, `askWithFiles` works as in 0.9.
 */
export type PreparedContext = {
  plan: DocumentPlan;
  /** Prompt text per document ID: the full text for inline documents, a summary card otherwise. */
  blocks: Map<string, string>;
  /** System instruction to add when any document is searchable or viewable, else an empty string. */
  instruction: string;
  /** IDs that were not found (never uploaded, deleted, or expired). */
  missing: string[];
  /**
   * PDFs whose pages `view_pages` can show: their original file is kept. Empty unless `prepare`
   * was called with `viewPages: true`. Pass it to `tools(..., { viewPages })`.
   */
  viewable: DocumentMeta[];
  /**
   * Documents sent whole whose tables the tools can still count and search: every CSV and XLSX
   * file, and a file of another format that `aggregate_table` reads whose text has a `| cell |`
   * table of at least 3 rows. Set when `prepare` was called with `inlineTables: "tools"`, else
   * absent. `askWithFiles` makes the tools for them with the searched documents. New in 0.10.0.
   */
  toolable?: DocumentMeta[];
  /**
   * Documents sent whole whose uploaded file goes to the model too, before their text: small visual
   * files (`PrepareOptions.nativeDocuments`), in the order of `plan.inline`. They are left out of
   * `viewable`. Absent unless `prepare` was called with `nativeDocuments`. New in 0.99.9.
   */
  native?: DocumentMeta[];
};
