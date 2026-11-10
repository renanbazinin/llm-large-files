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

export type ToolOptions = {
  /** Enables `analyze_whole_document`, which reads the entire file in parts. */
  generate?: GenerateText;
  /** Progress of whole-document reads, for status messages. */
  onProgress?: ProgressListener;
  signal?: AbortSignal;
};

export interface LargeFiles {
  /** The effective budget (defaults merged with your overrides). */
  readonly budget: Budget;
  readonly maxUploadBytes: number;
  /** Extracts, normalizes, profiles, and stores a file. Throws a user-readable Error on bad input. */
  ingest(input: IngestInput): Promise<DocumentMeta>;
  getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined>;
  delete(id: string, access?: AccessOptions): Promise<boolean>;
  /** Removes expired documents from the store. Returns how many were removed. */
  sweep(): Promise<number>;
  /**
   * Plans one model request: which documents go in whole and which become searchable cards.
   * `base` is the size of everything else in the request (messages, system prompt, other files).
   */
  prepare(ids: string[], base: { tokens: number; bytes: number }, access?: AccessOptions): Promise<PreparedContext>;
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
      const extracted = await extractText(input.bytes, { name, mimeType, format }, options.extractors);
      const { text, wrapped } = wrapLongLines(normalizeText(extracted.text));
      if (!text.trim()) throw new Error(`${name} did not contain any text.`);
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      if (format === "text" && looksLikeLog(lines)) format = "log";
      const created = now();
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
        outline: buildOutline(lines, format),
        ...(format === "log" ? { logProfile: buildLogProfile(lines) } : {}),
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
      };
      await options.store.put({ meta, text });
      return meta;
    },

    getMeta: metaFor,

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
      const blocks = new Map<string, string>();
      for (const document of documents) {
        blocks.set(document.meta.id, inline.has(document.meta.id) ? renderInline(document) : renderCard(document));
      }
      return { plan, blocks, instruction: documentToolsInstruction(plan.searchable), missing };
    },

    tools(documents, toolOptions = {}) {
      return createDocumentTools({
        load,
        documentIds: documents.map((meta) => meta.id),
        names: Object.fromEntries(documents.map((meta) => [meta.id, meta.name])),
        budget,
        ...toolOptions,
      });
    },
  };
}
