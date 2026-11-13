import { randomUUID } from "node:crypto";
import { buildLogProfile, buildOutline, looksLikeLog } from "./analyze.js";
import { givenBudget, resolveBudget, type ModelLimits } from "./budget.js";
import { DocumentCache, documentVersion, type Sized } from "./cache.js";
import { DocumentStoreError } from "./errors.js";
import { detectFormat, extractText } from "./extract.js";
import { Limiter } from "./limiter.js";
import { canBeReadWhole, CARD_LINES, documentToolsInstruction, formatBytes, planDocuments, renderCard, renderInline } from "./plan.js";
import { openRangedDocument, pieceKey, type CachedPiece, type RangeStore, type ScanSettings } from "./ranged.js";
import { numberLines, SearchableDocument, type DocumentSource } from "./search.js";
import { DOCUMENT_ID_PATTERN } from "./stores.js";
import { buildTextIndex, canSerialize, serializeTextIndex } from "./text-index.js";
import { estimateTokens, normalizeText, textSizes, wrapLongLines } from "./text.js";
import type { RetryOptions } from "./retry.js";
import { createDocumentTools } from "./tools.js";
import type {
  Budget,
  DocumentFormat,
  DocumentMeta,
  DocumentStore,
  DocumentSummary,
  Extractor,
  GenerateText,
  PreparedContext,
  ProgressListener,
  ToolSet,
} from "./types.js";

export { DEFAULT_BUDGET } from "./budget.js";

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
  /** Clock override, for tests. */
  now?: () => Date;
};

export type IngestInput = {
  name: string;
  mimeType?: string;
  bytes: Uint8Array;
  /** The user (or tenant) the document belongs to. Later calls must pass the same owner. */
  owner?: string;
};

/** Access options. When a document has an owner, only that owner can use it. */
export type AccessOptions = { owner?: string };

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
  /** Extracts, normalizes, profiles, and stores a file. Throws a user-readable Error on bad input. */
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

/** The fields of a document that are safe to return to a browser. */
export function toDocumentSummary(meta: DocumentMeta): DocumentSummary {
  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    format: meta.format,
    bytes: meta.bytes,
    lines: meta.lines,
    estimatedTokens: meta.estimatedTokens,
    ...(meta.pages ? { pages: meta.pages } : {}),
    expiresAt: meta.expiresAt,
  };
}

/**
 * A file name as one printable line: the last path segment, without control characters, line
 * breaks, or text-direction overrides. Names are shown to the model and in UIs, so a name must
 * not be able to start a new line of the prompt or disguise its extension.
 */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).at(-1) ?? "";
  return base
    // Control characters, line and paragraph separators, and text-direction controls.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255) || "file";
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

/**
 * The `expiresAt` of a document that never expires (`ttlMs: Infinity`): the last instant of the
 * year 9999. A date, so that every comparison, and a server of an older version, reads it as any other.
 */
export const NEVER_EXPIRES = "9999-12-31T23:59:59.999Z";

function allowed(meta: DocumentMeta, access: AccessOptions | undefined): boolean {
  return meta.owner === undefined || meta.owner === access?.owner;
}

/** Default for `cacheBytes`. */
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
/** Default for `wholeDocumentBytes`. */
export const DEFAULT_WHOLE_DOCUMENT_BYTES = 2 * 1024 * 1024;

export function createLargeFiles(options: LargeFilesOptions): LargeFiles {
  /** The fields the application set. The others follow the context window, whichever it is for a request. */
  const ownBudget = givenBudget(options.budget);
  const budget: Budget = resolveBudget(ownBudget);
  const budgetFor = (overrides?: Partial<Budget>, limits?: ModelLimits): Budget => (
    overrides || limits ? resolveBudget({ ...ownBudget, ...givenBudget(overrides) }, limits) : budget
  );
  const ttlMs = options.ttlMs ?? 72 * 60 * 60 * 1000;
  const maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 * 1024;
  const now = options.now ?? (() => new Date());
  const { store } = options;
  const cacheBytes = Math.max(0, options.cacheBytes ?? DEFAULT_CACHE_BYTES);
  /** Documents ready to search, and decoded pieces of documents read by range, in one memory budget. */
  const cache = new DocumentCache<Sized>(
    cacheBytes,
    options.cacheSize === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(options.cacheSize)),
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
  const wholeDocumentBytes = Math.max(0, options.wholeDocumentBytes ?? DEFAULT_WHOLE_DOCUMENT_BYTES);
  /** Documents whose saved index did not match their text: the next opening builds it from the text. */
  const rebuildIndex = new Set<string>();
  const scan: ScanSettings = {
    chunkBytes: Math.max(1, Math.trunc(options.scanChunkBytes ?? 1024 * 1024)),
    limiter: new Limiter(Math.max(1, Math.trunc(options.maxConcurrentScans ?? 4))),
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
  const scannedPdfPages = Math.max(0, Math.trunc(options.scannedPdfPages ?? 30));
  /** Whether the uploaded file of a document of this format is kept. */
  const keeps = (format: DocumentFormat) => keepOriginals.has(format) && typeof options.store.putOriginal === "function";

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
    return meta;
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
    return stored ? new SearchableDocument(stored) : undefined;
  }

  /**
   * What a document contributes to the prompt: its text, or its card. Undefined when it is gone
   * by now. A copy found to disagree with the store is opened again once.
   */
  async function block(id: string, meta: DocumentMeta, whole: boolean, viewable: boolean, readableWhole: boolean): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const document = await load(id, attempt === 0 ? meta : undefined);
      if (!document) return undefined;
      try {
        return whole
          ? renderInline(document.meta, await document.readText())
          : renderCard(document.meta, numberLines(await document.readLines(1, CARD_LINES), 1), viewable, readableWhole);
      } catch (error) {
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

    async ingest(input) {
      const name = cleanFileName(input.name);
      const mimeType = input.mimeType?.trim() || "application/octet-stream";
      if (input.bytes.byteLength === 0) throw new Error(`${name} is empty.`);
      if (input.bytes.byteLength > maxUploadBytes) {
        throw new Error(`${name} is larger than the ${formatBytes(maxUploadBytes)} upload limit.`);
      }
      let format = detectFormat(name, mimeType);
      const extracted = await extractText(input.bytes, {
        name,
        mimeType,
        format,
        // A scan is worth storing only if its pages can be shown later: that needs the file itself.
        ...(format === "pdf" && keeps(format) && scannedPdfPages > 0 ? { scannedPages: scannedPdfPages } : {}),
      }, options.extractors);
      const { text, wrapped } = wrapLongLines(normalizeText(extracted.text));
      if (!text.trim()) throw new Error(`${name} did not contain any text.`);
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      if (format === "text" && looksLikeLog(lines)) format = "log";
      const created = now();
      const expires = created.getTime() + ttlMs;
      const sizes = textSizes(text);
      const keepOriginal = keeps(format);
      const meta: DocumentMeta = {
        id: `doc_${randomUUID().replaceAll("-", "")}`,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        name,
        mimeType,
        format,
        bytes: input.bytes.byteLength,
        textBytes: sizes.utf8,
        jsonBytes: sizes.json,
        characters: text.length,
        lines: lines.length,
        estimatedTokens: estimateTokens(text),
        wrappedLines: wrapped,
        ...(extracted.pages ? { pages: extracted.pages } : {}),
        ...(keepOriginal ? { originalKept: true } : {}),
        outline: buildOutline(lines, format),
        ...(format === "log" ? { logProfile: buildLogProfile(lines) } : {}),
        createdAt: created.toISOString(),
        // Never, for a time to live without end (or one that runs past what a date can hold).
        expiresAt: expires >= Date.parse(NEVER_EXPIRES) ? NEVER_EXPIRES : new Date(expires).toISOString(),
      };
      // The line index, so that the text can be read by range: a few bytes a line, built from the
      // UTF-8 bytes the store writes. Kept by any store that can keep it, even one this library
      // then loads whole, so that switching to reading by range finds it ready.
      const index = typeof store.putIndex === "function" ? buildTextIndex(text) : undefined;
      const savedIndex = index && canSerialize(index) && index.lineCount === meta.lines && index.characters === meta.characters
        ? serializeTextIndex(index)
        : undefined;
      try {
        // The files first, the document last: a document is there once its metadata is.
        if (keepOriginal) await store.putOriginal!(meta.id, input.bytes);
        if (savedIndex) await store.putIndex!(meta.id, savedIndex);
        await store.put({ meta, text });
      } catch (error) {
        // Do not leave a file of up to the upload limit, or a part of one, behind for a document
        // that does not exist.
        await store.delete(meta.id).catch(() => undefined);
        throw error;
      }
      return meta;
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
          const text = await block(meta.id, meta, inline.has(meta.id), shown.has(meta.id), canBeReadWhole(meta, budget));
          if (text === undefined) gone.push(meta.id);
          else blocks.set(meta.id, text);
        }
        if (gone.length === 0) {
          // A whole-document read is named only when one of the files is small enough for it.
          const wholeReads = plan.searchable.some((meta) => canBeReadWhole(meta, budget));
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
      return createDocumentTools({
        load,
        documentIds: documents.map((meta) => meta.id),
        names: Object.fromEntries([...documents, ...viewable].map((meta) => [meta.id, meta.name])),
        budget,
        ...(loadOriginal && viewable.length > 0 ? { viewableIds: viewable.map((meta) => meta.id), loadOriginal } : {}),
        // `analyze_whole_document` is declared only when it can read at least one of the documents.
        wholeReads: documents.some((meta) => canBeReadWhole(meta, budget)),
        ...rest,
      });
    },
  };
}
