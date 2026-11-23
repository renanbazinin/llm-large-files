import { givenBudget, resolveBudget, type ModelLimits } from "./budget.js";
import { DocumentCache, documentVersion, type Sized } from "./cache.js";
import { DocumentStoreError } from "./errors.js";
import type { IngestEvent } from "./events.js";
import { ingestDocument, LONGEST_TIMER_MS, type IngestContext } from "./ingest.js";
import { Limiter } from "./limiter.js";
import { canBeReadWhole, CARD_LINES, documentToolsInstruction, planDocuments, renderCard, renderInline, TABLE_FORMATS, type WholeRead } from "./plan.js";
import { DocumentGoneError, openRangedDocument, pieceKey, type CachedPiece, type RangeStore, type ScanSettings } from "./ranged.js";
import { numberLines, SearchableDocument, type DocumentSource } from "./search.js";
import { DOCUMENT_ID_PATTERN } from "./stores.js";
import { wellFormed } from "./text.js";
import type { RetryOptions } from "./retry.js";
import { createDocumentTools } from "./tools.js";
import type {
  Budget,
  DocumentFormat,
  DocumentMeta,
  DocumentScope,
  DocumentStore,
  Extractor,
  GenerateText,
  PreparedContext,
  ProgressListener,
  ToolSet,
} from "./types.js";

export { DEFAULT_BUDGET } from "./budget.js";
export { checkOwner, cleanFileName, NEVER_EXPIRES, toDocumentSummary } from "./ingest.js";

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
   * Formats whose uploaded file is kept in the store next to its text, for example `["pdf"]`.
   * Empty by default: a kept file takes disk space, up to the upload limit, until the document
   * expires. A store without `putOriginal` keeps none.
   */
  keepOriginals?: DocumentFormat[];
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
  /** Clock override, for tests. */
  now?: () => Date;
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
   * (`APP_DOCUMENT_ID_PATTERN`). The model sees it, so it must hold no personal data. Without it,
   * an ID is made ("doc_" and 32 hex digits). New in 0.9.0.
   */
  id?: string;
  /**
   * What to do when a document with `id` is already stored: "fail" (the default) throws an
   * `IngestError` with code "exists"; "replace" replaces it, when it has the same owner and scope.
   * New in 0.9.0.
   */
  ifExists?: "fail" | "replace";
  /**
   * Where the document belongs, such as [userId, chatId] (`DocumentScope`). Stored with it, and
   * passed to the store; only a caller with the same scope may use it. New in 0.9.0.
   */
  scope?: DocumentScope;
  /**
   * The uploaded file is kept by the application, at `ref` (up to 1,024 characters, never shown
   * to the model), and the library reads it from there (`LargeFilesOptions.originals`) instead of
   * keeping a copy in the store. New in 0.9.0.
   */
  original?: { ref: string };
};

/** A file to ingest from where it is, rather than from bytes in memory (`IngestFromSource`). New in 0.9.0. */
export type IngestSource = { path: string };

/**
 * An ingest of a file from a path: `IngestInput` with `source` in place of `bytes`. The file is
 * read when the ingest's turn comes, not held in memory while it waits. New in 0.9.0.
 */
export type IngestFromSource = Omit<IngestInput, "bytes"> & { source: IngestSource; bytes?: never };

/**
 * Access options. When a document has an owner, only that owner can use it. `scope`, new in 0.9.0:
 * the scope of the caller; a document stored with a scope serves only a caller with the same one.
 */
export type AccessOptions = { owner?: string; scope?: DocumentScope };

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
};

export type ToolOptions = {
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
   * Extracts, normalizes, profiles, and stores a file. Throws a user-readable Error on bad input.
   * A store that fails to write throws its own error, as it is: log it, and do not show its
   * message to a user, as it may name a path, a host or a bucket.
   */
  ingest(input: IngestInput): Promise<DocumentMeta>;
  getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined>;
  /** The uploaded file itself, when it was kept (see `keepOriginals`). Treat the bytes as read-only. */
  getOriginal(id: string, access?: AccessOptions): Promise<Uint8Array | undefined>;
  delete(id: string, access?: AccessOptions): Promise<boolean>;
  /** Removes expired documents from the store. Returns how many were removed. */
  sweep(): Promise<number>;
  /**
   * Plans one model request: which documents go in whole and which become searchable cards.
   * `base` is the size of everything else in the request (messages, system prompt, other files).
   */
  prepare(ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext>;
  /** Tools scoped to these documents. Pass `generate` to enable whole-document analysis. */
  tools(documents: DocumentMeta[], options?: ToolOptions): ToolSet;
}

export function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_ID_PATTERN.test(value);
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

/**
 * A read of the store. Whatever it throws is passed on as a `DocumentStoreError`: a store that
 * could not be read is not a document that is gone, and its own error names paths or hosts.
 */
async function reading<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw error instanceof DocumentStoreError ? error : new DocumentStoreError(error);
  }
}

function allowed(meta: DocumentMeta, access: AccessOptions | undefined): boolean {
  return meta.owner === undefined || meta.owner === access?.owner;
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

export function createLargeFiles(options: LargeFilesOptions): LargeFiles {
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
  /** Documents ready to search, and decoded pieces of documents read by range, in one memory budget. */
  const cache = new DocumentCache<Sized>(
    cacheBytes,
    Math.max(0, Math.trunc(numberOption("cacheSize", options.cacheSize, Number.POSITIVE_INFINITY))),
  );
  /** Forgets everything kept of a document: the document, and its pieces. */
  const forget = (id: string) => {
    cache.delete(id);
    cache.deletePrefix(pieceKey(id, 0).slice(0, -1));
  };
  /** Documents being opened, so that calls arriving together open each one once. */
  const opening = new Map<string, Promise<DocumentSource | undefined>>();
  /** The store, when large documents can be read from it by range rather than loaded whole. */
  const ranged: RangeStore | undefined = typeof store.readTextRange === "function" ? {
    readTextRange: (id, start, end) => reading(() => store.readTextRange!(id, start, end)),
    ...(store.getIndex ? { getIndex: (id: string) => reading(() => store.getIndex!(id)) } : {}),
    ...(store.putIndex ? { putIndex: (id: string, index: Uint8Array) => store.putIndex!(id, index) } : {}),
  } : undefined;
  /** The uploaded file of a document, when the store keeps such files. */
  const loadOriginal = store.getOriginal ? (id: string) => reading(() => store.getOriginal!(id)) : undefined;
  const wholeDocumentBytes = Math.max(0, numberOption("wholeDocumentBytes", options.wholeDocumentBytes, DEFAULT_WHOLE_DOCUMENT_BYTES));
  /** Documents whose saved index did not match their text: the next opening builds it from the text. */
  const rebuildIndex = new Set<string>();
  const scan: ScanSettings = {
    chunkBytes: Math.max(1, Math.trunc(numberOption("scanChunkBytes", options.scanChunkBytes, 1024 * 1024, true))),
    limiter: new Limiter(Math.max(1, Math.trunc(numberOption("maxConcurrentScans", options.maxConcurrentScans, 4)))),
    onBroken: (id) => {
      rebuildIndex.add(id);
      forget(id);
    },
    pieces: {
      get: (key, version) => cache.get(key, version) as CachedPiece | undefined,
      // A piece belongs to its document: it is not one of the `cacheSize` documents, and leaves with it.
      set: (key, version, piece) => cache.set(key, version, piece, key.slice(0, key.indexOf("#"))),
      // A quarter of the cache: a few documents can be kept, and no one pushes out all the rest.
      maxDocumentBytes: cacheBytes / 4,
    },
  };
  const keepOriginals = new Set<DocumentFormat>(options.keepOriginals ?? []);
  /** The ingests doing their work, and those waiting their turn (`maxConcurrentIngests`). */
  const ingests = new Limiter(Math.max(1, Math.trunc(numberOption("maxConcurrentIngests", options.maxConcurrentIngests, 2))));
  /** How long work an ingest waits on, or gave up on, may keep its turn (see `IngestSlot`). */
  const slotCapMs = ingestTimeoutMs > 0 && ingestTimeoutMs <= LONGEST_TIMER_MS ? ingestTimeoutMs : DEFAULT_INGEST_TIMEOUT_MS;

  const scannedPdfPages = Math.max(0, Math.trunc(numberOption("scannedPdfPages", options.scannedPdfPages, 30)));
  /** Whether the uploaded file of a document of this format is kept. */
  const keeps = (format: DocumentFormat) => keepOriginals.has(format) && typeof options.store.putOriginal === "function";
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
    extractors: options.extractors,
    ingests,
    slotCapMs,
    keeps,
    forget,
  };

  /**
   * The document as the store describes it now: undefined when it was never there, has been
   * deleted (by this server or another one sharing the store), or has expired.
   */
  async function currentMeta(id: string): Promise<DocumentMeta | undefined> {
    if (!isDocumentId(id)) return undefined;
    const meta = await reading(() => store.getMeta(id));
    if (!meta || Date.parse(meta.expiresAt) <= now().getTime()) {
      forget(id);
      return undefined;
    }
    return wholeName(meta);
  }

  /**
   * A document ready to read and search. The store is asked first, every time: a kept copy is
   * used only while the store still has the same document. `known` is metadata just read from
   * the store, to save asking twice.
   */
  async function load(id: string, known?: DocumentMeta): Promise<DocumentSource | undefined> {
    const meta = known ?? await currentMeta(id);
    if (!meta) return undefined;
    const version = documentVersion(meta);
    const cached = cache.get(id, version) as DocumentSource | undefined;
    if (cached && !cached.broken) return cached;
    const key = `${id}|${version}`;
    let pending = opening.get(key);
    if (!pending) {
      pending = open(id, meta).finally(() => opening.delete(key));
      opening.set(key, pending);
    }
    const document = await pending;
    if (document) cache.set(id, version, document);
    return document;
  }

  /** Reads a document from the store: its index, to read it by range, or all of it. */
  async function open(id: string, meta: DocumentMeta): Promise<DocumentSource | undefined> {
    if (ranged && meta.textBytes > wholeDocumentBytes) {
      const rebuild = rebuildIndex.delete(id);
      return openRangedDocument(ranged, meta, scan, { ignoreSavedIndex: rebuild });
    }
    const stored = await reading(() => store.get(id));
    if (!stored) return undefined;
    const named = wholeName(stored.meta);
    return new SearchableDocument(named === stored.meta ? stored : { ...stored, meta: named });
  }

  /**
   * What a document contributes to the prompt: its text, or its card. Undefined when it is gone
   * by now. A copy found to disagree with the store is opened again once.
   */
  async function block(id: string, meta: DocumentMeta, whole: boolean, viewable: boolean, wholeRead: WholeRead): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const document = await load(id, attempt === 0 ? meta : undefined);
      if (!document) return undefined;
      try {
        return whole
          ? renderInline(document.meta, await document.readText())
          : renderCard(document.meta, numberLines(await document.readLines(1, CARD_LINES), 1), viewable, wholeRead);
      } catch (error) {
        // The text is gone while its metadata is still there (removed outside the library): the
        // same as missing. It was a plain Error, which failed the whole question.
        if (error instanceof DocumentGoneError) return undefined;
        if (!document.broken) {
          // Deleted between the look-up and the read: the same as missing.
          if (!await currentMeta(id)) return undefined;
          throw error;
        }
      }
    }
    return undefined;
  }

  async function metaFor(id: string, access: AccessOptions | undefined): Promise<DocumentMeta | undefined> {
    const meta = await currentMeta(id);
    return meta && allowed(meta, access) ? meta : undefined;
  }

  return {
    budget,
    budgetFor,
    maxUploadBytes,

    ingest(input) {
      return ingestDocument(ingestContext, input);
    },

    getMeta: metaFor,

    async getOriginal(id, access) {
      const meta = await metaFor(id, access);
      return meta?.originalKept ? loadOriginal?.(id) : undefined;
    },

    async delete(id, access) {
      if (!await metaFor(id, access)) return false;
      forget(id);
      return options.store.delete(id);
    },

    async sweep() {
      return options.store.sweep?.(now()) ?? 0;
    },

    async prepare(ids, base, access) {
      const budget = budgetFor(access?.budget);
      const analysis = access?.wholeDocumentAnalysis !== false;
      const unique = [...new Set(ids)];
      let documents: DocumentMeta[] = [];
      const missing: string[] = [];
      for (const id of unique) {
        // A document owned by someone else is reported as missing, not as forbidden, and is not
        // read at all.
        const meta = await metaFor(id, access);
        if (meta) documents.push(meta);
        else missing.push(id);
      }
      // Planning needs only the metadata. The text is read for the documents sent whole, and the
      // first lines for the others. One that is gone by then is missing, and the plan is made again.
      for (;;) {
        const plan = planDocuments(documents, budget, base);
        const inline = new Set(plan.inline.map((meta) => meta.id));
        // Pages can be shown for a PDF whose file is kept, whether its text is in the prompt or searched.
        const viewable = access?.viewPages && store.getOriginal
          ? documents.filter((meta) => meta.format === "pdf" && meta.originalKept)
          : [];
        const shown = new Set(viewable.map((meta) => meta.id));
        const blocks = new Map<string, string>();
        const gone: string[] = [];
        for (const meta of documents) {
          const wholeRead = !analysis ? "not_offered" : canBeReadWhole(meta, budget) ? "offered" : "too_large";
          const text = await block(meta.id, meta, inline.has(meta.id), shown.has(meta.id), wholeRead);
          if (text === undefined) gone.push(meta.id);
          else blocks.set(meta.id, text);
        }
        if (gone.length === 0) {
          // A whole-document read is named only when the tools have it, and one of the files is
          // small enough for it.
          const wholeReads = analysis && plan.searchable.some((meta) => canBeReadWhole(meta, budget));
          return { plan, blocks, instruction: documentToolsInstruction(plan.searchable, viewable, wholeReads), missing, viewable };
        }
        missing.push(...gone);
        documents = documents.filter((meta) => !gone.includes(meta.id));
      }
    },

    tools(documents, toolOptions = {}) {
      const { viewPages, budget: overrides, ...rest } = toolOptions;
      const budget = budgetFor(overrides);
      const viewable = (loadOriginal ? (viewPages === true ? documents : viewPages || []) : [])
        .filter((meta) => meta.format === "pdf" && meta.originalKept);
      // The owner each document was handed in with. The store's owner is checked against it on
      // every call, so metadata built from an ID alone cannot read another owner's document: such
      // a document is answered as no longer available, as `getMeta` reports it missing.
      const handedOwner = new Map<string, string | undefined>([...documents, ...viewable].map((meta) => [meta.id, meta.owner]));
      const mayUse = (meta: DocumentMeta) => meta.owner === undefined || (handedOwner.has(meta.id) && meta.owner === handedOwner.get(meta.id));
      // The metadata the store holds now, not that of a copy kept in memory.
      const checkedLoad = async (id: string) => {
        const meta = await currentMeta(id);
        return meta && mayUse(meta) ? load(id, meta) : undefined;
      };
      const checkedOriginal = loadOriginal && (async (id: string) => {
        const meta = await currentMeta(id);
        return meta && mayUse(meta) ? loadOriginal(id) : undefined;
      });
      return createDocumentTools({
        load: checkedLoad,
        documentIds: documents.map((meta) => meta.id),
        names: Object.fromEntries([...documents, ...viewable].map((meta) => [meta.id, wellFormed(meta.name)])),
        budget,
        ...(checkedOriginal && viewable.length > 0 ? { viewableIds: viewable.map((meta) => meta.id), loadOriginal: checkedOriginal } : {}),
        // `analyze_whole_document` is declared only when it can read at least one of the documents.
        wholeReads: documents.some((meta) => canBeReadWhole(meta, budget)),
        // `aggregate_table` only when one may hold a table.
        tables: documents.some((meta) => TABLE_FORMATS.has(meta.format)),
        ...rest,
      });
    },
  };
}
