import {
  callerOf, checkMetaVersion, checkStuck, documentContext, isTimeLimit, mayUse, metaOf, OWNER_REQUIRED, SCOPE_REQUIRED, storeCall, storeContext, storeTimeout,
  stuckCalls, type AccessRules, type Caller,
} from "./access.js";
import { givenBudget, resolveBudget, type ModelLimits } from "./budget.js";
import { DocumentCache, documentVersion, type Sized } from "./cache.js";
import type { DocumentStoreOperation } from "./errors.js";
import type { IngestEvent } from "./events.js";
import { until } from "./http.js";
import { ingestDocument, LONGEST_TIMER_MS, type IngestContext } from "./ingest.js";
import { Limiter } from "./limiter.js";
import { canBeReadWhole, TABLE_FORMATS } from "./plan.js";
import { prepareDocuments, type PrepareContext } from "./prepare.js";
import { openRangedDocument, pieceKey, RangedDocument, type CachedPiece, type RangeStore, type ScanSettings } from "./ranged.js";
import { SearchableDocument, type DocumentSource } from "./search.js";
import { TimeSlicer } from "./pause.js";
import { checkScope } from "./scope.js";
import { isSha256, sha256InSlices } from "./source.js";
import { APP_DOCUMENT_ID_PATTERN } from "./stores.js";
import { wellFormed } from "./text.js";
import type { RetryOptions } from "./retry.js";
import { createDocumentTools, type PageLookTurns } from "./tools.js";
import type {
  Budget,
  DocumentContext,
  DocumentFormat,
  DocumentMeta,
  DocumentScope,
  DocumentStore,
  Extractor,
  GenerateText,
  PlacementState,
  PreparedContext,
  ProgressListener,
  ToolName,
  ToolSet,
} from "./types.js";

export { DEFAULT_BUDGET } from "./budget.js";
export { checkOwner, cleanFileName, cleanMimeType, NEVER_EXPIRES, toDocumentSummary } from "./ingest.js";

export type LargeFilesOptions = {
  /** Where extracted text is kept: `new FileDocumentStore(dir)`, `new MemoryDocumentStore()`, or your own. */
  store: DocumentStore;
  /**
   * Your model's limits. What is left out follows `contextTokens` (see `resolveBudget`), which is
   * 1M tokens unless you set it: for a model with a smaller window, setting that one number is
   * enough. Values that cannot work together are an error.
   */
  budget?: Partial<Budget>;
  /**
   * How long uploaded documents are kept. Defaults to 72 hours. `Infinity` keeps them until they
   * are deleted: their `expiresAt` is then `NEVER_EXPIRES`.
   */
  ttlMs?: number;
  /** Largest accepted upload. Defaults to 100 MB. */
  maxUploadBytes?: number;
  /**
   * The most text kept from one file, in UTF-8 bytes. Defaults to 100 MB, or `maxUploadBytes` when
   * that is larger: the text of a DOCX is often 2 to 4 times the size of the file, so a lower upload
   * limit does not lower it. A small PDF can
   * draw far more text than its own size (a 3 KB file built for it held 107 MB), so this is checked
   * as the text is extracted: the built-in extractors refuse a file as soon as its text passes it,
   * and `ingest` refuses a larger result from an extractor of your own.
   */
  maxTextBytes?: number;
  /** The most pages read from one PDF. Defaults to 5,000. A PDF with more is refused before any page is read. */
  maxPdfPages?: number;
  /**
   * The most time one `ingest` may take, in milliseconds: extracting the text, indexing it and
   * profiling a log. Defaults to 120,000 (2 minutes). Past it, `ingest` throws an error that says
   * the file took too long to read. 0 sets no limit, and so does a time past what a timer can wait
   * (2,147,483,647 ms, 24.8 days). One page of a PDF is not cut short: the limit is looked at
   * between pages.
   */
  ingestTimeoutMs?: number;
  /** Override or add text extractors per format. */
  extractors?: Partial<Record<DocumentFormat, Extractor>>;
  /**
   * Formats whose uploaded file is kept, for example `["pdf"]`, so that `view_pages` can show its
   * pages: as a copy in the store, next to its text (`putOriginal`), or, for an ingest with
   * `IngestInput.original`, where the application keeps it (`originals`). Empty by default: a kept
   * file takes disk space, up to the upload limit, until the document expires. A store without
   * `putOriginal` keeps no copies.
   */
  keepOriginals?: DocumentFormat[];
  /**
   * Reads the uploaded files that the application keeps itself (`IngestInput.original`), in place
   * of a copy in the store: `fileOriginals(root)`, of "llm-large-files/node", reads them from a
   * folder. A file read back is checked against the size and SHA-256 it had at ingest. New in 0.9.0.
   */
  originals?: OriginalsReader;
  /**
   * A PDF without any text (a scan) has nothing to search, and was always refused. When its
   * original is kept, its pages can be shown to the model instead, so one of up to this many pages
   * is accepted. Defaults to 30. 0 refuses every PDF without text, as before.
   */
  scannedPdfPages?: number;
  /**
   * The most memory, in bytes, that documents kept ready for repeated tool calls may take.
   * Defaults to 256 MB. A document larger than this is read again for each call. 0 keeps none.
   *
   * Every use of a kept document first asks the store whether it is still there, so a document
   * deleted or expired on another server sharing the store is never served from memory here.
   */
  cacheBytes?: number;
  /**
   * Also caps the number of documents kept (the only limit before 0.4). Unset: no cap on the
   * number. The pieces kept of a document that is read by range are not counted, and go when
   * their document does.
   */
  cacheSize?: number;
  /**
   * Documents whose text is at most this many bytes are loaded whole into memory (and kept there
   * within `cacheBytes`). Larger ones are read by range, when the store can (`readTextRange`, as
   * `FileDocumentStore` does): a tool call reads the lines it needs, and a search reads the text a
   * piece at a time, so memory does not grow with the size of the files or the number of users.
   * Defaults to 2 MB. `Infinity` loads every document whole, as before 0.4; 0 reads every one by range.
   */
  wholeDocumentBytes?: number;
  /** Reading by range: about this many bytes of text are read and searched at a time. Defaults to 1 MB. */
  scanChunkBytes?: number;
  /**
   * Reading by range: how many scans of whole documents (searches, counting the parts of a file)
   * run at once in this process. The others wait their turn. Defaults to 4.
   */
  maxConcurrentScans?: number;
  /**
   * How many ingests do their work at once in this library. The others wait their turn, in order,
   * and their time limit (`ingestTimeoutMs`) starts when their turn comes. An ingest holds about five
   * times its file in memory while it works, and ingests at once share one thread: more of them do
   * not finish sooner. `Infinity` for no limit (as before 0.8.2). Defaults to 2. New in 0.8.2.
   */
  maxConcurrentIngests?: number;
  /**
   * How many looks at pages (`view_pages`) run at once in this library, over all its questions.
   * The others wait their turn, in order, before the PDF is loaded. A look parses the whole PDF on
   * the one thread the questions share: more at once do not finish sooner, they only hold more
   * memory (six at once held 352 MB more than one). `Infinity` for no limit (as before 0.9.0).
   * Defaults to 1. A look reads its PDF from the store within `ingestTimeoutMs` (2 minutes when
   * that is 0): past it, the turn goes back and the model is told that the file could not be read
   * in time. New in 0.9.0.
   */
  maxConcurrentPageLooks?: number;
  /**
   * How long a look at pages waits for its turn, in milliseconds. Past it, the model is told that
   * the server is busy and to answer from the text, and the question gets a "page_looks_busy"
   * notice. `Infinity` waits without end; 0 does not wait. Defaults to 30,000. New in 0.9.0.
   */
  pageLookWaitMs?: number;
  /**
   * Every call must name its owner: `ingest`, `getMeta`, `getOriginal`, `delete`, `prepare`,
   * `askWithFiles` (and `askStream`, `askGemini`), and `tools`, which then needs `access`. A call
   * without one throws a TypeError ("owner is required: requireOwner is on"), and a document stored
   * without an owner reads as missing. For a server where every document belongs to a signed-in
   * user: a call that forgot the owner fails, rather than sees every document without one.
   * Defaults to false. New in 0.9.0.
   */
  requireOwner?: boolean;
  /**
   * The same for scopes (`DocumentScope`): every call must name its scope, and a document stored
   * without one reads as missing. `sweep` without a scope is still allowed: it is upkeep of the
   * store, not a user's access. Defaults to false. New in 0.9.0.
   */
  requireScope?: boolean;
  /**
   * The most time one store call may take, in milliseconds: a look-up of a document (`getMeta`), a
   * read of its text (whole, or a range of it), of its index or of its original, and a delete.
   * Past it, the call fails with a `DocumentStoreError` of code "ETIMEDOUT" (status 503): the call
   * itself goes on, as nothing can stop it, and counts as stuck until it ends. A call inside a
   * question's tool call ends the question. Defaults to 30,000; 0 sets no limit, and so does a time
   * past what a timer can wait. Keep it above the time your store takes to read the largest text
   * loaded whole (`wholeDocumentBytes`). `ingest` keeps its own limits (`ingestTimeoutMs`), past
   * which its store calls count as stuck too, and `sweep` has `sweepTimeoutMs`. New in 0.10.0.
   */
  storeTimeoutMs?: number;
  /**
   * How many calls of this process may be stuck (past their time limit, and not ended) before every
   * new store call of this library, those of `ingest` included, fails at once, without calling the
   * store, with code "STORE_STUCK" (status 503). A store call is stuck past `storeTimeoutMs`, and
   * one of `ingest` past the time it gives its store calls (`ingestTimeoutMs`, 2 minutes when that
   * is 0). The count is the process's, as the threads of libuv are: a store call that does not
   * answer holds one of them, and with all of them held every file call and DNS look-up of the
   * process waits. Defaults to half of `UV_THREADPOOL_SIZE` (4 when it is not set), read when the
   * library is made as libuv reads it (an empty value, 0, or one without leading digits is 1
   * thread), and at least 1: 2 by default, 16 with 32 threads. `Infinity` refuses nothing. New in
   * 0.10.0.
   */
  maxStuckStoreCalls?: number;
  /**
   * The most time one `sweep` may take, in milliseconds: past it, `sweep` fails with a
   * `DocumentStoreError` of code "ETIMEDOUT", and the sweep goes on. A sweep never counts as a stuck
   * call. Defaults to 0: no limit. New in 0.10.0.
   */
  sweepTimeoutMs?: number;
  /** Clock override, for tests. */
  now?: () => Date;
};

/**
 * Reads the uploaded files that the application keeps itself (`LargeFilesOptions.originals`). New
 * in 0.9.0.
 */
export type OriginalsReader = {
  /**
   * The bytes of the file at `ref` (`IngestInput.original.ref`), or undefined when it is not
   * there. `context` is that of the call (its scope and owner), with the document's `id`, and
   * `bytes`, the size the file had at ingest: a reader may stop one byte past it, as a file of
   * another size has changed. What it throws is passed on as a `DocumentStoreError` (operation
   * "read"), with its error as `cause`, as a store's errors are.
   */
  read(ref: string, context: OriginalReadContext): Promise<Uint8Array | undefined>;
};

/** What `OriginalsReader.read` is told of the call. New in 0.9.0. */
export type OriginalReadContext = DocumentContext & {
  /** The ID of the document whose file is read. */
  readonly id: string;
  /** The size of the file when it was ingested. */
  readonly bytes: number;
};

export type IngestInput = {
  name: string;
  mimeType?: string;
  bytes: Uint8Array;
  /**
   * The user (or tenant) the document belongs to. Later calls must pass the same owner. An empty
   * string, or one of spaces only, is refused with a TypeError: it would be one owner shared by
   * every caller without a user.
   */
  owner?: string;
  /**
   * Stops the ingest when aborted (the uploader went away): it throws `signal.reason`, and nothing
   * is stored. The built-in extractors stop between pages and pieces.
   */
  signal?: AbortSignal;
  /**
   * What the ingest does as it goes: `ingest.start`, `ingest.progress` for each stage, then
   * `ingest.finish` or `ingest.error`. See docs/reference/events.md. New in 0.7.0.
   */
  onEvent?: (event: IngestEvent) => void;
  /** The `runId` of those events. Defaults to one made for the ingest ("ing_…"). */
  runId?: string;
  /**
   * The document's ID, chosen by the application, such as the ID of its upload: lowercase letters,
   * digits, "_" and "-", up to 64 characters, starting with a letter or a digit
   * (`APP_DOCUMENT_ID_PATTERN`). Another ID is a TypeError. The model sees it, so it must hold no
   * personal data. Without it, an ID is made ("doc_" and 32 hex digits), as before. New in 0.9.0.
   */
  id?: string;
  /**
   * What to do when a document with `id` is already stored, as the store sees it for this scope.
   * "fail" (the default) throws an `IngestError` with code "exists" (status 409). "replace"
   * deletes it, then stores the new one: only a document of the same owner and scope; another is
   * "exists" too, even when its text is gone, unless it has expired. Over a store that keeps no
   * scopes apart, the check spans every scope, so one chat cannot write over another's document.
   * While an ingest of this library stores `id`, another ingest of it is "exists", whatever this
   * says. New in 0.9.0.
   */
  ifExists?: "fail" | "replace";
  /**
   * Where the document belongs, such as [userId, chatId] (`DocumentScope`). It is passed to every
   * store call, and kept in `DocumentMeta.scope`: only a caller of the same scope may use the
   * document. A scope that is not valid is a `DocumentScopeError`. New in 0.9.0.
   */
  scope?: DocumentScope;
  /**
   * Where the application keeps the uploaded file: `ref`, up to 1,024 characters, such as a path
   * under the folder of `fileOriginals`. When the format is kept (`keepOriginals`), the library
   * reads the file from there (`LargeFilesOptions.originals`) instead of keeping a copy in the
   * store, and records `DocumentMeta.original`: the ref, and the size and SHA-256 of the file, to
   * tell when it has changed. The ref is never sent to the model, nor in a summary. An event holds
   * it only with `AskOptions.eventResults: true`, in the full plan of `run.finish` and `run.error`.
   * Without `LargeFilesOptions.originals`, it is a TypeError. The library never writes, moves or
   * deletes the file: `delete` leaves it. New in 0.9.0.
   */
  original?: { ref: string };
};

/** A file to ingest from where it is, rather than from bytes in memory (`IngestFromSource`). New in 0.9.0. */
export type IngestSource = { path: string };

/**
 * An ingest of a file from a path: `IngestInput` with `source` in place of `bytes`. Before the
 * ingest's turn, the path is looked at with `lstat`, and nothing of it is read: a link is refused,
 * not followed, and so is anything that is not a file; an empty file, or one larger than
 * `maxUploadBytes`, is refused at once. When its name and type say nothing of its format, only the
 * parts of it that tell are read (its first KB; for a ZIP its first 64 KB and its last MB). At its
 * turn the file is read once, up to `maxUploadBytes + 1` bytes, so that one that has grown is
 * refused, and its bytes are let go once its text is read. An extractor that reads paths
 * (`Extractor.readsPath`, as the isolated readers do) reads it instead, and the server does not.
 * The library never writes, moves or deletes the file. New in 0.9.0.
 */
export type IngestFromSource = Omit<IngestInput, "bytes"> & { source: IngestSource; bytes?: never };

/**
 * Access options. When a document has an owner, only that owner can use it. `scope`, new in 0.9.0:
 * the scope of the caller; a document stored with a scope serves only a caller with the same one.
 */
export type AccessOptions = {
  owner?: string;
  scope?: DocumentScope;
  /**
   * Ends this caller's waits for the store, with the signal's reason: never a store call that other
   * callers wait on too (one opening of a document serves every caller of its scope), and never the
   * store call itself, which nothing can stop. Read by `getMeta`, `getOriginal`, `delete`,
   * `prepare`, `toolsFor`, and `tools` with `access`. New in 0.10.0.
   */
  signal?: AbortSignal;
};

export type PrepareOptions = AccessOptions & {
  /**
   * The budget of this request, when it is not the library's own: the fields to change, as in
   * `LargeFilesOptions.budget`. `askWithFiles` passes the budget that fits the model it was given.
   */
  budget?: Partial<Budget>;
  /**
   * Say that your tool loop can pass files to the model (see `ToolOptions.viewPages`). The result
   * then lists the PDFs whose pages can be shown in `viewable`, and the instruction and the cards
   * tell the model about `view_pages`. Without it, the result is that of 0.2.0.
   */
  viewPages?: boolean;
  /**
   * Say whether your tool set offers `analyze_whole_document`: pass false when you call `tools()`
   * without `generate`, and the instruction and the cards do not name it. Defaults to true.
   * `askWithFiles` passes false for a model without `generateText`, and for
   * `wholeDocumentAnalysis: false`.
   */
  wholeDocumentAnalysis?: boolean;
  /**
   * The `PlacementState` of the chat's last question: the documents keep the place they had.
   * New in 0.10.0. Not read yet.
   */
  placement?: PlacementState;
  /**
   * Number the lines of the documents sent whole, as the tools number them. Defaults to false here,
   * so that `prepare` gives the blocks of 0.9 (`askWithFiles` will ask for true). New in 0.10.0.
   * Not read yet.
   */
  numberInline?: boolean;
  /**
   * "tools": list the documents sent whole whose tables the tools can count in `toolable`; "text":
   * as in 0.9. Defaults to "text" here (`askWithFiles` will ask for "tools"). New in 0.10.0. Not
   * read yet.
   */
  inlineTables?: "tools" | "text";
  /**
   * Room to keep free in the request besides `base`: the tool declarations, the guide, the header
   * lines and the cards, at their rendered size. New in 0.10.0. Not read yet.
   */
  reserve?: { tokens: number; bytes: number };
};

export type ToolOptions = {
  /**
   * Who uses these tools. With it, every call of the tools asks the store for the document with
   * this owner and scope, and checks the owner and scope the store holds against them: metadata
   * made by hand, or handed in for another user, reads nothing. Without it, as before 0.9.0: each
   * document is checked against the owner and scope it was handed in with. `askWithFiles` always
   * passes it. Under `requireOwner` or `requireScope` it is required. New in 0.9.0.
   */
  access?: AccessOptions;
  /** Enables `analyze_whole_document`, which reads the entire file in parts. */
  generate?: GenerateText;
  /** Progress of whole-document reads, for status messages. */
  onProgress?: ProgressListener;
  signal?: AbortSignal;
  /**
   * The most time, in milliseconds, that the regex searches of this tool set may take together.
   * Past it, a regex search answers with an error that tells the model to search another way.
   * Defaults to 6,000. One search still stops after 3,000, and at once at a line its pattern
   * cannot get past.
   */
  regexBudgetMs?: number;
  /**
   * How many times each document may be read whole (`analyze_whole_document`) by this tool set.
   * A call past it answers with an error that tells the model to use what it has. Defaults to 1:
   * make one tool set for each question, as `askWithFiles` does.
   */
  maxWholeDocumentReads?: number;
  /** How a model request of a whole-document read that failed is sent again. Defaults to three more tries, with a wait that doubles. */
  retry?: RetryOptions;
  /** The budget of these tools, when it is not the library's own: the fields to change. Use the one you planned the request with. */
  budget?: Partial<Budget>;
  /**
   * Offers `view_pages`, which hands the model real pages of a PDF whose original file is kept
   * (see `keepOriginals`). The pages come back as a file, so turn this on only when your loop
   * runs tools with `executeWithFiles` and sends the files to the model. `true` offers it for the
   * documents passed to `tools`; a list offers it for exactly those documents, which may include
   * PDFs that are not searched because their text is already in the prompt.
   */
  viewPages?: boolean | DocumentMeta[];
  /**
   * Declare exactly these tools, in the order the tool set declares them (search, read, overview,
   * aggregate, analyze, view). A declared tool that cannot run answers with its reason. New in
   * 0.10.0. Not read yet.
   */
  declare?: readonly ToolName[];
  /**
   * The IDs of documents sent whole: `analyze_whole_document` refuses them, as they are shown in
   * full. New in 0.10.0. Not read yet.
   */
  inline?: readonly string[];
};

export interface LargeFiles {
  /** The effective budget (defaults merged with your overrides). */
  readonly budget: Budget;
  /**
   * The budget for one request: the library's, with `overrides` in place of its fields, made to
   * fit `limits` (a model's context window and request size, when they are smaller). Fields that
   * neither the library nor `overrides` set follow the context window that results.
   */
  budgetFor(overrides?: Partial<Budget>, limits?: ModelLimits): Budget;
  readonly maxUploadBytes: number;
  /**
   * What the library requires of every call (`requireOwner`, `requireScope`), for code that serves
   * it, such as the upload handlers. Optional, so that a `LargeFiles` of your own still compiles.
   * New in 0.9.0.
   */
  readonly access?: { readonly requireOwner: boolean; readonly requireScope: boolean };
  /**
   * Extracts, normalizes, profiles, and stores a file: from its bytes (`IngestInput`), or from a
   * path (`IngestFromSource`, new in 0.9.0). Throws a user-readable Error on bad input.
   * A store that fails to write is a `DocumentStoreError` (operation "write", status 503) since
   * 0.9.0, with the store's own error as `cause`: log that one, and do not show its message to a
   * user, as it may name a path, a host or a bucket. A path that is not there, a link or a folder
   * is an error with the `code` of a system error (ENOENT, ELOOP, EISDIR), passed on as it is.
   */
  ingest(input: IngestInput | IngestFromSource): Promise<DocumentMeta>;
  getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined>;
  /**
   * The uploaded file itself, when it was kept (see `keepOriginals`): from the store, or from where
   * the application keeps it (`IngestInput.original`, read by `LargeFilesOptions.originals`). Treat
   * the bytes as read-only. Undefined too when, once the bytes are read, the store no longer
   * describes the same document, or the bytes are not those of the upload: of another size, or
   * another SHA-256 (0.9.0).
   */
  getOriginal(id: string, access?: AccessOptions): Promise<Uint8Array | undefined>;
  /** Deletes a document. A store that fails is a `DocumentStoreError` (operation "delete") since 0.9.0. */
  delete(id: string, access?: AccessOptions): Promise<boolean>;
  /**
   * Removes expired documents from the store: those of `scope`, or of every scope without one.
   * Returns how many were removed. A store that fails is a `DocumentStoreError` (operation
   * "sweep") since 0.9.0.
   */
  sweep(options?: { scope?: DocumentScope }): Promise<number>;
  /**
   * Plans one model request: which documents go in whole and which become searchable cards.
   * `base` is the size of everything else in the request (messages, system prompt, other files).
   */
  prepare(ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext>;
  /** Tools scoped to these documents. Pass `generate` to enable whole-document analysis. */
  tools(documents: DocumentMeta[], options?: ToolOptions): ToolSet;
  /**
   * Counters for metrics and alerts, read without a store call and without waiting. Optional, so
   * that a `LargeFiles` of your own still compiles; the one `createLargeFiles` makes has it. New in
   * 0.10.0.
   */
  stats?(): LargeFilesStats;
  /**
   * Looks each ID up for `options.access`, as `getMeta` does, then makes the tools for the
   * documents found (`tools`, with `access`): `missing` lists the others, those of another owner or
   * scope included. A repeated ID counts once. Optional, so that a `LargeFiles` of your own still
   * compiles; the one `createLargeFiles` makes has it. New in 0.10.0.
   */
  toolsFor?(ids: string[], options: ToolOptions & { access: AccessOptions }): Promise<{ tools: ToolSet; missing: string[] }>;
}

/** What `files.stats()` counts: plain numbers, for metrics and alerts. New in 0.10.0. */
export type LargeFilesStats = {
  /** Ingests doing their work, and those waiting their turn (`maxConcurrentIngests`). */
  ingests: { active: number; waiting: number };
  /** Scans of whole documents read by range, and those waiting their turn (`maxConcurrentScans`). */
  scans: { active: number; waiting: number };
  /** Looks at pages, and those waiting their turn (`maxConcurrentPageLooks`). */
  pageLooks: { active: number; waiting: number };
  /**
   * What is kept in memory: its bytes, how many entries (documents, and pieces of documents read by
   * range), and the most bytes they may take (`cacheBytes`).
   */
  cache: { bytes: number; entries: number; maxBytes: number };
  /**
   * Calls of this process that ran past their time limit and have not settled: the store calls of
   * every library (past `storeTimeoutMs`, or for `ingest` past `ingestTimeoutMs`), and the calls to
   * the disk of the upload handlers (`uploadIdleTimeoutMs`).
   */
  stuckStoreCalls: number;
  /** This library's limit on them (`maxStuckStoreCalls`). */
  maxStuckStoreCalls: number;
};

/**
 * What `createLargeFiles` returns: a `LargeFiles` whose `stats` and `toolsFor` are always there, so
 * that `files.stats()` needs no `?.`. New in 0.10.0.
 */
export type CreatedLargeFiles = LargeFiles & { stats(): LargeFilesStats; toolsFor: NonNullable<LargeFiles["toolsFor"]> };

/**
 * Whether `value` has the shape of a document ID: one the library makes ("doc_" and 32 hex digits),
 * or one an application may give (`APP_DOCUMENT_ID_PATTERN`, since 0.9.0), which the library's fit too.
 */
export function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && APP_DOCUMENT_ID_PATTERN.test(value);
}

/**
 * Metadata with a whole file name. 0.5.0 and earlier cut a long name at 255 UTF-16 units, at times
 * inside an emoji, and stored it: half of a character is sent as a replacement character, never on
 * its own (Claude's API refuses it). Metadata whose name is whole comes back as it is.
 */
function wholeName(meta: DocumentMeta): DocumentMeta {
  const name = wellFormed(meta.name);
  return name === meta.name ? meta : { ...meta, name };
}

/** The key a caller's copy of a document is kept under in memory: the key of its scope, then the ID. */
const documentKey = (caller: Caller, id: string) => `${caller.key}\u0000${id}`;

/** A caller with no owner and no scope. */
const NO_CALLER: Caller = Object.freeze({ context: storeContext(undefined, undefined), key: "" });

/**
 * What `view_pages` answers for a file the application keeps (`IngestInput.original`) that is no
 * longer the one that was ingested. New in 0.9.0.
 */
const changedOriginal = (file: string) => `${file} changed on the server since it was read. Attach it again to look at its pages.`;

/**
 * Where the application keeps the uploaded file of a document (`DocumentMeta.original`), when its
 * metadata says so in the shape the library writes. Undefined for one kept in the store, and for
 * one written by hand in another shape, which reads as missing.
 */
function refOf(meta: DocumentMeta): { ref: string; bytes: number; sha256: string } | undefined {
  const original: unknown = meta.original;
  if (typeof original !== "object" || original === null) return undefined;
  const { ref, bytes, sha256 } = original as { ref?: unknown; bytes?: unknown; sha256?: unknown };
  return typeof ref === "string" && ref.length > 0 && typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 && isSha256(sha256)
    ? { ref, bytes, sha256 }
    : undefined;
}

/** Default for `cacheBytes`. */
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

/** Default for `maxPdfPages`. */
export const DEFAULT_MAX_PDF_PAGES = 5_000;
/** Default for `maxTextBytes`, when `maxUploadBytes` is not larger: 100 MB. */
export const DEFAULT_MAX_TEXT_BYTES = 100 * 1024 * 1024;
/** Default for `ingestTimeoutMs`: 2 minutes. */
export const DEFAULT_INGEST_TIMEOUT_MS = 120_000;

/** Default for `wholeDocumentBytes`. */
export const DEFAULT_WHOLE_DOCUMENT_BYTES = 2 * 1024 * 1024;
/** Default for `storeTimeoutMs`: 30 seconds. */
export const DEFAULT_STORE_TIMEOUT_MS = 30_000;

/**
 * Default for `maxStuckStoreCalls`: half of the threads of libuv's pool, and at least 1. The pool
 * is read from `UV_THREADPOOL_SIZE` as libuv reads it (`atoi`): 4 when it is not set; its leading
 * digits ("32abc" is 32); 1 thread for a value without them or for 0 ("", "x", "0"), which a
 * template with an empty value gives; 1,024 at most, and for a value below 0, which libuv reads as
 * a number without a sign, past the most.
 */
function defaultMaxStuck(): number {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UV_THREADPOOL_SIZE;
  let pool = 4;
  if (value !== undefined) {
    const given = Number.parseInt(value, 10);
    pool = Number.isNaN(given) || given === 0 ? 1 : given < 0 ? 1_024 : Math.min(1_024, given);
  }
  return Math.max(1, Math.floor(pool / 2));
}

/** Looks at pages that run at once in a library, unless `maxConcurrentPageLooks` says otherwise. */
const DEFAULT_PAGE_LOOKS = 1;
/** How long a look at pages waits for its turn, unless `pageLookWaitMs` says otherwise. */
const DEFAULT_PAGE_LOOK_WAIT_MS = 30_000;

/**
 * A number option as it was given, or `fallback` when it was left out. NaN, which
 * `Number(process.env.X)` gives for a variable that is not set, and a value that is not a number
 * are an error: NaN passes every `Math.max` and fails every comparison, so it hung the scans or
 * turned a limit off. `finite` refuses `Infinity` too, for an option that cannot be endless.
 */
function numberOption(name: string, value: unknown, fallback: number, finite = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new TypeError(`${name} must be a number, and is ${typeof value === "string" ? JSON.stringify(value) : typeof value}.`);
  if (Number.isNaN(value) || (finite && !Number.isFinite(value))) throw new RangeError(`${name} must be a ${finite ? "finite " : ""}number, and is ${value}. Leave it out for the default.`);
  return value;
}

export function createLargeFiles(options: LargeFilesOptions): CreatedLargeFiles {
  /** The fields the application set. The others follow the context window, whichever it is for a request. */
  const ownBudget = givenBudget(options.budget);
  const budget: Budget = resolveBudget(ownBudget);
  const budgetFor = (overrides?: Partial<Budget>, limits?: ModelLimits): Budget => (
    overrides || limits ? resolveBudget({ ...ownBudget, ...givenBudget(overrides) }, limits) : budget
  );
  const ttlMs = numberOption("ttlMs", options.ttlMs, 72 * 60 * 60 * 1000);
  const maxUploadBytes = numberOption("maxUploadBytes", options.maxUploadBytes, 100 * 1024 * 1024);
  const given = (value: number | undefined, fallback: number) => (typeof value === "number" && !Number.isNaN(value) ? value : fallback);
  const maxTextBytes = Math.max(1, given(options.maxTextBytes, Math.max(maxUploadBytes, DEFAULT_MAX_TEXT_BYTES)));
  const maxPdfPages = Math.max(1, Math.trunc(given(options.maxPdfPages, DEFAULT_MAX_PDF_PAGES)));
  const ingestTimeoutMs = given(options.ingestTimeoutMs, DEFAULT_INGEST_TIMEOUT_MS);
  const now = options.now ?? (() => new Date());
  const { store } = options;
  const cacheBytes = Math.max(0, numberOption("cacheBytes", options.cacheBytes, DEFAULT_CACHE_BYTES));
  /** What every call must name (`requireOwner`, `requireScope`). */
  const rules: AccessRules = Object.freeze({ requireOwner: options.requireOwner === true, requireScope: options.requireScope === true });
  /**
   * Documents ready to search, and decoded pieces of documents read by range, in one memory budget.
   * Each is kept under the key of the caller's scope and the document's ID (`documentKey`): one ID
   * in two scopes is two documents, and the copy of one is never served to the other. Its version
   * (`documentVersion`) holds the document's owner and scope too, so a copy is not served to
   * another owner either, once another document is stored under the same ID.
   */
  const cache = new DocumentCache<Sized>(
    cacheBytes,
    Math.max(0, Math.trunc(numberOption("cacheSize", options.cacheSize, Number.POSITIVE_INFINITY))),
  );
  /** Forgets everything kept of the document of one key (`documentKey`): the document, and its pieces. */
  const forgetKey = (key: string) => {
    cache.delete(key);
    cache.deletePrefix(pieceKey(key, 0).slice(0, -1));
  };
  /** Whether `key` is that of document `id`, or of one of its pieces, in any scope. */
  const keyOfId = (key: string, id: string) => {
    const rest = key.slice(key.indexOf("\u0000") + 1);
    return rest === id || rest.startsWith(`${id}#`);
  };
  /**
   * Forgets everything kept of document `id`, in every scope: it was deleted, or written again.
   * In a store that keeps no scopes apart, the copies of all scopes are of that one document.
   */
  const forget = (id: string) => {
    cache.deleteWhere((key) => keyOfId(key, id));
    for (const key of rebuildIndex) if (keyOfId(key, id)) rebuildIndex.delete(key);
  };
  /** The most time one store call may take (`storeTimeoutMs`): 0 for no limit. */
  const storeTimeoutMs = Math.max(0, numberOption("storeTimeoutMs", options.storeTimeoutMs, DEFAULT_STORE_TIMEOUT_MS));
  /** The most time one sweep may take (`sweepTimeoutMs`): 0 for no limit. */
  const sweepTimeoutMs = Math.max(0, numberOption("sweepTimeoutMs", options.sweepTimeoutMs, 0));
  /** While this many calls of the process are stuck, store calls of this library fail at once (`maxStuckStoreCalls`). */
  const maxStuckStoreCalls = Math.max(1, Math.trunc(numberOption("maxStuckStoreCalls", options.maxStuckStoreCalls, defaultMaxStuck())));
  /**
   * A call of the store, within `storeTimeoutMs`, refused at once while too many calls of the
   * process are stuck. `signal` ends the caller's wait, never the call: a call that other callers
   * wait on too (an opening of a document) is given none.
   */
  const timed = <T>(operation: DocumentStoreOperation, call: () => Promise<T>, signal?: AbortSignal): Promise<T> => (
    storeCall(operation, call, { timeoutMs: storeTimeoutMs, maxStuck: maxStuckStoreCalls, signal })
  );
  /**
   * A read of the store. Whatever it throws is passed on as a `DocumentStoreError`: a store that
   * could not be read is not a document that is gone, and its own error names paths or hosts.
   */
  const reading = <T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> => timed("read", read, signal);
  /** Documents being opened, so that calls arriving together open each one once. */
  const opening = new Map<string, Promise<DocumentSource | undefined>>();
  /**
   * The store, to read the text of a document by range rather than load it whole: each call carries
   * `context`: the caller's scope, and the document's owner when it has one (`documentContext`).
   * A document read by range is shared by every caller of its scope: its reads have a time limit,
   * and no caller's signal.
   */
  const rangeStore = (context: DocumentContext): RangeStore => ({
    readTextRange: (id, start, end) => reading(() => store.readTextRange!(id, start, end, context)),
    ...(store.getIndex ? { getIndex: (id: string) => reading(() => store.getIndex!(id, context)) } : {}),
    ...(store.putIndex ? { putIndex: (id: string, index: Uint8Array) => timed("write", () => store.putIndex!(id, index, context)) } : {}),
  });
  /** The uploaded file of a document, when the store keeps such files. */
  const loadOriginal = (id: string, context: DocumentContext, signal?: AbortSignal) => reading(() => store.getOriginal!(id, context), signal);
  /**
   * Removals of documents (`delete`) take their turns, one at a time: a store that does not answer
   * then holds one thread of the pool for them, not one for each.
   */
  const removals = new Limiter(1);
  const wholeDocumentBytes = Math.max(0, numberOption("wholeDocumentBytes", options.wholeDocumentBytes, DEFAULT_WHOLE_DOCUMENT_BYTES));
  /** Documents (by `documentKey`) whose saved index did not match their text: the next opening builds it from the text. */
  const rebuildIndex = new Set<string>();
  const scan: ScanSettings = {
    chunkBytes: Math.max(1, Math.trunc(numberOption("scanChunkBytes", options.scanChunkBytes, 1024 * 1024, true))),
    limiter: new Limiter(Math.max(1, Math.trunc(numberOption("maxConcurrentScans", options.maxConcurrentScans, 4)))),
    onBroken: (key) => {
      rebuildIndex.add(key);
      forgetKey(key);
    },
    pieces: {
      get: (key, version) => cache.get(key, version) as CachedPiece | undefined,
      // A piece belongs to its document: it is not one of the `cacheSize` documents, and leaves with
      // it. The document's key is all before the last "#", which no ID holds, and no scope key either.
      set: (key, version, piece) => cache.set(key, version, piece, key.slice(0, key.lastIndexOf("#"))),
      // A quarter of the cache: a few documents can be kept, and no one pushes out all the rest.
      maxDocumentBytes: cacheBytes / 4,
    },
  };
  const keepOriginals = new Set<DocumentFormat>(options.keepOriginals ?? []);
  /** The ingests doing their work, and those waiting their turn (`maxConcurrentIngests`). */
  const ingests = new Limiter(Math.max(1, Math.trunc(numberOption("maxConcurrentIngests", options.maxConcurrentIngests, 2))));
  /** How long work an ingest waits on, or gave up on, may keep its turn (see `IngestSlot`). */
  const slotCapMs = ingestTimeoutMs > 0 && ingestTimeoutMs <= LONGEST_TIMER_MS ? ingestTimeoutMs : DEFAULT_INGEST_TIMEOUT_MS;
  /**
   * The looks at pages of every question of this library take their turns (`maxConcurrentPageLooks`).
   * A look reads its original within the time the library gives its store calls (`slotCapMs`).
   */
  const pageLooks: PageLookTurns = {
    limiter: new Limiter(Math.max(1, Math.trunc(numberOption("maxConcurrentPageLooks", options.maxConcurrentPageLooks, DEFAULT_PAGE_LOOKS)))),
    waitMs: Math.max(0, numberOption("pageLookWaitMs", options.pageLookWaitMs, DEFAULT_PAGE_LOOK_WAIT_MS)),
    holdMs: slotCapMs,
  };

  const scannedPdfPages = Math.max(0, Math.trunc(numberOption("scannedPdfPages", options.scannedPdfPages, 30)));
  const { originals } = options;
  if (originals !== undefined && (typeof originals !== "object" || originals === null || typeof originals.read !== "function")) {
    throw new TypeError("originals must be an object with a read(ref, context) method, such as fileOriginals(root) gives.");
  }
  /**
   * Whether the uploaded file of a document of this format is kept: by its ref (`IngestInput.original`),
   * which `originals` reads back, or as a copy in the store (`putOriginal`).
   */
  const keeps = (format: DocumentFormat, byRef: boolean) => keepOriginals.has(format) && (byRef ? originals !== undefined : typeof store.putOriginal === "function");
  /**
   * Whether the original of a document, which its metadata says is kept, can be read: by its ref,
   * through `originals`, or from the store (`getOriginal`).
   */
  const readable = (meta: DocumentMeta) => (meta.original !== undefined && meta.original !== null ? originals !== undefined : typeof store.getOriginal === "function");
  /** Whether `view_pages` can show the pages of a document: a PDF whose original is kept, and can be read. */
  const viewableMeta = (meta: DocumentMeta) => meta.format === "pdf" && meta.originalKept === true && readable(meta);
  /** What `ingest` (src/ingest.ts) needs of this library. */
  const ingestContext: IngestContext = {
    store,
    now,
    ttlMs,
    maxUploadBytes,
    maxTextBytes,
    maxPdfPages,
    ingestTimeoutMs,
    scannedPdfPages,
    // Read at each ingest, as before the move: an application may set them after.
    get extractors() {
      return options.extractors;
    },
    ingests,
    slotCapMs,
    maxStuck: maxStuckStoreCalls,
    keeps,
    readsRefs: originals !== undefined,
    forget,
    rules,
    ingesting: new Set<string>(),
  };

  /**
   * The document as the store describes it now, asked with the caller's context: undefined when it
   * was never there, has been deleted (by this server or another one sharing the store), or has
   * expired. Whether the caller may use it is `metaFor`'s to say.
   */
  async function currentMeta(id: string, caller: Caller): Promise<DocumentMeta | undefined> {
    if (!isDocumentId(id)) return undefined;
    const meta = metaOf(await reading(() => store.getMeta(id, caller.context), caller.signal), id);
    if (meta) checkMetaVersion(meta);
    if (!meta || Date.parse(meta.expiresAt) <= now().getTime()) {
      forgetKey(documentKey(caller, id));
      return undefined;
    }
    return wholeName(meta);
  }

  /** The document, when `caller` may use it: one of another owner or scope is missing, not forbidden. */
  async function metaFor(id: string, caller: Caller): Promise<DocumentMeta | undefined> {
    const meta = await currentMeta(id, caller);
    return meta && mayUse(meta, caller, rules) ? meta : undefined;
  }

  /**
   * A document ready to read and search, for `caller`, who may use it. The store is asked first,
   * every time: a kept copy is used only while the store still has the same document. `known` is
   * metadata just read from the store and checked, to save asking twice. One opening serves every
   * caller of the scope who asks meanwhile: its reads have time limits, and each caller stops
   * waiting for it when its own signal aborts, which leaves the others waiting (0.10.0).
   */
  async function load(id: string, caller: Caller, known?: DocumentMeta): Promise<DocumentSource | undefined> {
    const meta = known ?? await metaFor(id, caller);
    if (!meta) return undefined;
    const key = documentKey(caller, id);
    const version = documentVersion(meta);
    const cached = cache.get(key, version) as DocumentSource | undefined;
    if (cached && !cached.broken) return cached;
    const opened = `${key}|${version}`;
    let pending = opening.get(opened);
    if (!pending) {
      // Kept once opened, whether or not a caller still waits for it.
      pending = open(id, meta, caller, key)
        .then((document) => {
          if (document) cache.set(key, version, document);
          return document;
        })
        .finally(() => opening.delete(opened));
      opening.set(opened, pending);
    }
    return until(pending, caller.signal);
  }

  /**
   * Reads a document from the store: its index, to read it by range, or all of it. `meta` is what
   * `metaFor` found for `caller`. The reads carry the caller's scope, and the document's owner when it
   * has one (`documentContext`): the copy is kept for every caller of the scope.
   */
  async function open(id: string, meta: DocumentMeta, caller: Caller, key: string): Promise<DocumentSource | undefined> {
    const context = documentContext(meta, caller);
    if (typeof store.readTextRange === "function" && meta.textBytes > wholeDocumentBytes) {
      const rebuild = rebuildIndex.delete(key);
      return openRangedDocument(rangeStore(context), meta, scan, { ignoreSavedIndex: rebuild, key });
    }
    const stored = await reading(() => store.get(id, context));
    // Another document is not this one: the metadata `get` gives must be of this ID, owner and
    // scope, and of the version `meta` is (not one deleted and stored again since, by another
    // server, nor one a store of your own gave from the wrong scope). And the text must be the one
    // that metadata describes, of its length and its number of lines: a store that writes the text
    // and the metadata apart can give one document's metadata with another's text (two servers that
    // ingest one ID at once, a file read between two writes). A document read by range is checked
    // too: its index against the metadata, and the end of its text against its index
    // (openRangedDocument). Missing, as for a caller who may not use it.
    const found = stored ? metaOf(stored.meta, id) : undefined;
    if (!stored || !found || !mayUse(found, caller, rules) || documentVersion(found) !== documentVersion(meta)) return undefined;
    if (typeof stored.text !== "string" || stored.text.length !== found.characters) return undefined;
    const named = wholeName(found);
    const document = new SearchableDocument(named === stored.meta ? stored : { ...stored, meta: named });
    return document.lineCount === found.lines ? document : undefined;
  }

  /**
   * The uploaded file of document `id`, which `meta`, checked for `caller`, says is kept: read from
   * where the application keeps it (`meta.original`, through `originals`), or from the store. Another
   * server may delete the document and store another under its ID while the bytes are read: so the
   * store is asked again once they are. "missing" unless it still describes the same document, of
   * the same owner and scope, and the bytes are the size of the file that was ingested, and have its
   * SHA-256 when it is known (0.9.0): a store that gives back other bytes of the same size is caught
   * too. "changed" for a file kept by the application that is no longer the one that was ingested:
   * of another size or another SHA-256.
   */
  async function originalOf(id: string, caller: Caller, meta: DocumentMeta): Promise<Uint8Array | "missing" | "changed"> {
    const kept = refOf(meta);
    let read: Uint8Array | undefined;
    if (kept) {
      if (!originals) return "missing";
      const context: OriginalReadContext = Object.freeze({ ...caller.context, id, bytes: kept.bytes });
      read = await reading(() => originals.read(kept.ref, context), caller.signal);
    } else {
      if (meta.original !== undefined && meta.original !== null) return "missing";
      if (!store.getOriginal) return "missing";
      read = await loadOriginal(id, caller.context, caller.signal);
    }
    if (!read) return "missing";
    const bytes = read;
    const after = await metaFor(id, caller);
    if (!after || documentVersion(after) !== documentVersion(meta)) return "missing";
    // The SHA-256 of a file of up to the upload limit is taken a slice at a time.
    const same = async (sha256: string) => await sha256InSlices(bytes, new TimeSlicer()) === sha256;
    if (kept) return bytes.byteLength === kept.bytes && await same(kept.sha256) ? bytes : "changed";
    if (bytes.byteLength !== meta.bytes) return "missing";
    return typeof meta.sha256 === "string" && !await same(meta.sha256) ? "missing" : bytes;
  }

  /**
   * Whether `document`, which a call of `caller` has just read, is still the one the store describes
   * for `caller`. A document loaded whole was checked as it was read (see `open`). The bytes of one
   * read by range carry nothing to check them by, and another server, or this one, may delete the
   * document and store another under its ID while they are read, or between the look-up and the
   * reads: so the store is asked again once they are, as `originalOf` does. When it no longer
   * describes the same document, of the same owner and scope, what was read may be another's: the
   * copy kept of it, read from the store too, is forgotten, and the read is missing.
   */
  async function stillOpened(document: DocumentSource, caller: Caller): Promise<boolean> {
    if (!(document instanceof RangedDocument)) return true;
    const after = await metaFor(document.meta.id, caller);
    if (after && documentVersion(after) === documentVersion(document.meta)) return true;
    forgetKey(documentKey(caller, document.meta.id));
    return false;
  }

  /**
   * Removes a document from the store (`store.delete`), in the removals' turn (`removals`). The turn
   * and the store call are waited for until `deadline` aborts (the delete's time limit, which they
   * share), or the caller's signal does; the turn is then held until the store call ends, even past
   * its time limit. The store call counts as stuck once it has itself run `storeTimeoutMs`.
   */
  async function removal(call: () => Promise<boolean>, signal: AbortSignal | undefined, deadline: AbortSignal): Promise<boolean> {
    checkStuck("delete", maxStuckStoreCalls);
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted) throw deadline.reason;
    const waits = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let release: () => void;
    try {
      release = await removals.acquire(waits);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw deadline.aborted ? deadline.reason : error;
    }
    let started = false;
    try {
      return await timed("delete", () => {
        started = true;
        let running: Promise<boolean>;
        try {
          running = Promise.resolve(call());
        } catch (error) {
          running = Promise.reject(error);
        }
        running.then(release, release);
        return running;
      }, waits);
    } finally {
      if (!started) release();
    }
  }

  /** What planning a request (`prepareDocuments`, src/prepare.ts) needs of this library. */
  const planning: PrepareContext = { callerOf: (access) => callerOf(access, rules), metaFor, load, stillOpened, budgetFor, viewableMeta, rules };

  /** `files.tools`: the tools for `documents`. */
  function tools(documents: DocumentMeta[], toolOptions: ToolOptions = {}): ToolSet {
    const { viewPages, budget: overrides, access, ...rest } = toolOptions;
    // Without `access`, the owner and scope of each document are those it was handed in with: a
    // library that requires them takes them only from the caller.
    if (access === undefined && (rules.requireOwner || rules.requireScope)) {
      throw new TypeError(rules.requireOwner ? OWNER_REQUIRED : SCOPE_REQUIRED);
    }
    // The tool set's signal ends its waits for the store too, unless `access` has a signal of its own.
    // It is taken as it is, as before 0.10.0 (an object made like an AbortSignal too): only
    // `access.signal`, new in 0.10.0, must be an AbortSignal (`callerOf`).
    const signal = access?.signal ?? toolOptions.signal;
    const asker = access !== undefined ? withSignal(callerOf(access, rules), signal) : undefined;
    const budget = budgetFor(overrides);
    // Which PDFs can be looked at, by the metadata handed in: each look reads the metadata the
    // store holds, and the file it names, not the one handed in.
    const viewable = (viewPages === true ? documents : viewPages || []).filter(viewableMeta);
    // Without `access`, as before 0.9.0: the owner and scope each document was handed in with.
    // The store is asked with them, and the owner and scope it holds are checked against them on
    // every call, so metadata built from an ID alone cannot read another owner's document: such a
    // document is answered as no longer available, as `getMeta` reports it missing. A handed scope
    // that is not valid reads nothing.
    const handed = new Map<string, Caller | undefined>(asker ? [] : [...documents, ...viewable].map((meta) => [meta.id, handedCaller(meta, signal)]));
    const noCaller = signal ? { ...NO_CALLER, signal } : NO_CALLER;
    const callerFor = (id: string): Caller | undefined => asker ?? (handed.has(id) ? handed.get(id) : noCaller);
    // The metadata the store holds now, not that of a copy kept in memory.
    const checkedLoad = async (id: string) => {
      const caller = callerFor(id);
      const meta = caller && await metaFor(id, caller);
      return meta ? load(id, caller, meta) : undefined;
    };
    const checkedOriginal = (store.getOriginal || originals) && (async (id: string) => {
      const caller = callerFor(id);
      const meta = caller && await metaFor(id, caller);
      if (!meta || !readable(meta)) return undefined;
      const original = await originalOf(id, caller, meta);
      // A file the application keeps that has changed since it was ingested: its pages are not
      // those of the text the model has, and the model is told so.
      if (original === "changed") throw new Error(changedOriginal(meta.name));
      return original === "missing" ? undefined : original;
    });
    return createDocumentTools({
      load: checkedLoad,
      // Once a call has read a document by range: the store is asked again (`stillOpened`).
      checkRead: async (document) => {
        const caller = callerFor(document.meta.id);
        return caller !== undefined && await stillOpened(document, caller);
      },
      documentIds: documents.map((meta) => meta.id),
      names: Object.fromEntries([...documents, ...viewable].map((meta) => [meta.id, wellFormed(meta.name)])),
      budget,
      ...(checkedOriginal && viewable.length > 0 ? { viewableIds: viewable.map((meta) => meta.id), loadOriginal: checkedOriginal, pageLooks } : {}),
      // `analyze_whole_document` is declared only when it can read at least one of the documents.
      wholeReads: documents.some((meta) => canBeReadWhole(meta, budget)),
      // `aggregate_table` only when one may hold a table.
      tables: documents.some((meta) => TABLE_FORMATS.has(meta.format)),
      ...rest,
    });
  }

  return {
    budget,
    budgetFor,
    maxUploadBytes,
    access: rules,

    ingest(input) {
      return ingestDocument(ingestContext, input);
    },

    async getMeta(id, access) {
      return metaFor(id, callerOf(access, rules));
    },

    async getOriginal(id, access) {
      const caller = callerOf(access, rules);
      const meta = await metaFor(id, caller);
      if (!meta?.originalKept || !readable(meta)) return undefined;
      const original = await originalOf(id, caller, meta);
      return original instanceof Uint8Array ? original : undefined;
    },

    async delete(id, access) {
      const caller = callerOf(access, rules);
      // One time limit for the whole delete: the look-up (which keeps its own, and its error of a
      // read), then the wait for the removals' turn and the store's delete. Before, the turn and the
      // delete had one each: with a slow delete before it, a delete answered after twice the limit.
      const deadline = new AbortController();
      const timer = isTimeLimit(storeTimeoutMs) ? setTimeout(() => deadline.abort(storeTimeout("delete", storeTimeoutMs)), storeTimeoutMs) : undefined;
      try {
        if (!await metaFor(id, caller)) return false;
        forget(id);
        return await removal(() => store.delete(id, caller.context), caller.signal, deadline.signal);
      } finally {
        clearTimeout(timer);
      }
    },

    async sweep(sweepOptions) {
      // Upkeep of the store, not a user's access: allowed without a scope under `requireScope`.
      const scope = checkScope(sweepOptions?.scope ?? undefined);
      if (typeof store.sweep !== "function") return 0;
      // Within its own time limit, and never counted as stuck: a sweep of a large volume may take
      // long. It is refused, as other calls are, while too many calls are stuck.
      return storeCall("sweep", () => store.sweep!(now(), storeContext(scope, undefined)), { timeoutMs: sweepTimeoutMs, maxStuck: maxStuckStoreCalls, counts: false });
    },

    // The options go on whole: planning (src/prepare.ts) reads the ones it knows.
    prepare(ids, base, prepareOptions) {
      return prepareDocuments(planning, ids, base, prepareOptions);
    },

    tools,

    stats() {
      // Counters only: no store call, no turn waited for.
      return {
        ingests: ingests.load,
        scans: scan.limiter.load,
        pageLooks: pageLooks.limiter.load,
        cache: { bytes: cache.bytes, entries: cache.size, maxBytes: cacheBytes },
        stuckStoreCalls: stuckCalls(),
        maxStuckStoreCalls,
      };
    },

    async toolsFor(ids, toolOptions) {
      const access: unknown = toolOptions?.access;
      if (typeof access !== "object" || access === null) throw new TypeError("toolsFor needs options.access: the owner and scope of the caller, such as { owner: userId }.");
      if (!Array.isArray(ids)) throw new TypeError("toolsFor needs an array of document IDs.");
      const caller = withSignal(callerOf(toolOptions.access, rules), toolOptions.access.signal ?? toolOptions.signal);
      const found: DocumentMeta[] = [];
      const missing: string[] = [];
      // One look-up at a time: a store that does not answer holds one thread of the pool, not one for each ID.
      for (const id of new Set<string>(ids)) {
        const meta = await metaFor(id, caller);
        if (meta) found.push(meta);
        else missing.push(id);
      }
      return { tools: tools(found, toolOptions), missing };
    },
  };

  /**
   * The caller a document was handed to `tools` for (without `access`): its owner and scope, and the
   * tool set's signal. Undefined for a scope that is not valid: only that reads as missing.
   */
  function handedCaller(meta: DocumentMeta, signal: AbortSignal | undefined): Caller | undefined {
    let caller: Caller;
    try {
      caller = callerOf({ owner: meta.owner, scope: meta.scope }, rules);
    } catch {
      return undefined;
    }
    return withSignal(caller, signal);
  }
}

/** `caller`, whose waits for the store end when `signal` aborts. */
function withSignal(caller: Caller, signal: AbortSignal | undefined): Caller {
  return signal === undefined ? caller : { ...caller, signal };
}
