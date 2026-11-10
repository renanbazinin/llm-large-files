import { randomUUID } from "node:crypto";
import { buildLogProfile, buildOutline, looksLikeLog } from "./analyze.js";
import { detectFormat, extractText } from "./extract.js";
import { documentToolsInstruction, formatBytes, planDocuments, renderCard, renderInline } from "./plan.js";
import { SearchableDocument } from "./search.js";
import { DOCUMENT_ID_PATTERN } from "./stores.js";
import { estimateTokens, normalizeText, utf8Bytes, wrapLongLines } from "./text.js";
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

/** Defaults sized for a 1M-token model behind a 10 MB request limit. */
export const DEFAULT_BUDGET: Budget = {
  contextTokens: 1_000_000,
  maxRequestBytes: 10_000_000,
  inlineTokens: 200_000,
  reservedTokens: 64_000,
  mapChunkTokens: 100_000,
  maxMapChunks: 30,
  toolResultCharacters: 24_000,
};

export type LargeFilesOptions = {
  /** Where extracted text is kept: `new FileDocumentStore(dir)`, `new MemoryDocumentStore()`, or your own. */
  store: DocumentStore;
  /** Your model's limits. Anything left out uses DEFAULT_BUDGET. */
  budget?: Partial<Budget>;
  /** How long uploaded documents are kept. Defaults to 72 hours. */
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
  /** How many parsed documents to keep in memory for repeated tool calls. Defaults to 6. */
  cacheSize?: number;
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

function allowed(meta: DocumentMeta, access: AccessOptions | undefined): boolean {
  return meta.owner === undefined || meta.owner === access?.owner;
}

export function createLargeFiles(options: LargeFilesOptions): LargeFiles {
  const budget: Budget = { ...DEFAULT_BUDGET, ...options.budget };
  const ttlMs = options.ttlMs ?? 72 * 60 * 60 * 1000;
  const maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 * 1024;
  const now = options.now ?? (() => new Date());
  const cacheSize = Math.max(1, options.cacheSize ?? 6);
  const cache = new Map<string, SearchableDocument>();
  const keepOriginals = new Set<DocumentFormat>(options.keepOriginals ?? []);
  const scannedPdfPages = Math.max(0, Math.trunc(options.scannedPdfPages ?? 30));
  /** Whether the uploaded file of a document of this format is kept. */
  const keeps = (format: DocumentFormat) => keepOriginals.has(format) && typeof options.store.putOriginal === "function";

  async function load(id: string): Promise<SearchableDocument | undefined> {
    const cached = cache.get(id);
    if (cached) {
      if (Date.parse(cached.meta.expiresAt) > now().getTime()) {
        // Refresh its place as most recently used.
        cache.delete(id);
        cache.set(id, cached);
        return cached;
      }
      cache.delete(id);
    }
    const stored = await options.store.get(id);
    if (!stored) return undefined;
    const document = new SearchableDocument(stored);
    cache.set(id, document);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return document;
  }

  async function metaFor(id: string, access: AccessOptions | undefined): Promise<DocumentMeta | undefined> {
    if (!isDocumentId(id)) return undefined;
    const meta = await options.store.getMeta(id);
    return meta && allowed(meta, access) ? meta : undefined;
  }

  return {
    budget,
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
      const keepOriginal = keeps(format);
      const meta: DocumentMeta = {
        id: `doc_${randomUUID().replaceAll("-", "")}`,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        name,
        mimeType,
        format,
        bytes: input.bytes.byteLength,
        textBytes: utf8Bytes(text),
        characters: text.length,
        lines: lines.length,
        estimatedTokens: estimateTokens(text),
        wrappedLines: wrapped,
        ...(extracted.pages ? { pages: extracted.pages } : {}),
        ...(keepOriginal ? { originalKept: true } : {}),
        outline: buildOutline(lines, format),
        ...(format === "log" ? { logProfile: buildLogProfile(lines) } : {}),
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
      };
      try {
        // The file first, the document last: a document is there once its metadata is.
        if (keepOriginal) await options.store.putOriginal!(meta.id, input.bytes);
        await options.store.put({ meta, text });
      } catch (error) {
        // Do not leave a file of up to the upload limit behind for a document that does not exist.
        if (keepOriginal) await options.store.delete(meta.id).catch(() => undefined);
        throw error;
      }
      return meta;
    },

    getMeta: metaFor,

    async getOriginal(id, access) {
      const meta = await metaFor(id, access);
      return meta?.originalKept ? options.store.getOriginal?.(id) : undefined;
    },

    async delete(id, access) {
      if (!await metaFor(id, access)) return false;
      cache.delete(id);
      return options.store.delete(id);
    },

    async sweep() {
      return options.store.sweep?.(now()) ?? 0;
    },

    async prepare(ids, base, access) {
      const unique = [...new Set(ids)];
      const documents: SearchableDocument[] = [];
      const missing: string[] = [];
      for (const id of unique) {
        const document = isDocumentId(id) ? await load(id) : undefined;
        // A document owned by someone else is reported as missing, not as forbidden.
        if (document && allowed(document.meta, access)) documents.push(document);
        else missing.push(id);
      }
      const plan = planDocuments(documents.map((document) => document.meta), budget, base);
      const inline = new Set(plan.inline.map((meta) => meta.id));
      // Pages can be shown for a PDF whose file is kept, whether its text is in the prompt or searched.
      const viewable = access?.viewPages && options.store.getOriginal
        ? documents.map((document) => document.meta).filter((meta) => meta.format === "pdf" && meta.originalKept)
        : [];
      const shown = new Set(viewable.map((meta) => meta.id));
      const blocks = new Map<string, string>();
      for (const document of documents) {
        const { id } = document.meta;
        blocks.set(id, inline.has(id) ? renderInline(document) : renderCard(document, shown.has(id)));
      }
      return { plan, blocks, instruction: documentToolsInstruction(plan.searchable, viewable), missing, viewable };
    },

    tools(documents, toolOptions = {}) {
      const { viewPages, ...rest } = toolOptions;
      const loadOriginal = options.store.getOriginal?.bind(options.store);
      const viewable = (loadOriginal ? (viewPages === true ? documents : viewPages || []) : [])
        .filter((meta) => meta.format === "pdf" && meta.originalKept);
      return createDocumentTools({
        load,
        documentIds: documents.map((meta) => meta.id),
        names: Object.fromEntries([...documents, ...viewable].map((meta) => [meta.id, meta.name])),
        budget,
        ...(loadOriginal && viewable.length > 0 ? { viewableIds: viewable.map((meta) => meta.id), loadOriginal } : {}),
        ...rest,
      });
    },
  };
}
