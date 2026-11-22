import { randomUUID } from "node:crypto";
import { buildLogProfileInSlices, buildOutlineInSlices, looksLikeLog } from "./analyze.js";
import { givenBudget, resolveBudget, type ModelLimits } from "./budget.js";
import { DocumentCache, documentVersion, type Sized } from "./cache.js";
import { DocumentStoreError, noteStoreWriteFailure } from "./errors.js";
import { EventEmitter, eventErrorOf, newRunId, type IngestEvent, type IngestStage } from "./events.js";
import { detectFormat, extractText } from "./extract.js";
import { Limiter } from "./limiter.js";
import { TimeSlicer } from "./pause.js";
import { canBeReadWhole, CARD_LINES, documentToolsInstruction, formatBytes, planDocuments, renderCard, renderInline, type WholeRead } from "./plan.js";
import { openRangedDocument, pieceKey, type CachedPiece, type RangeStore, type ScanSettings } from "./ranged.js";
import { numberLines, SearchableDocument, type DocumentSource } from "./search.js";
import { DOCUMENT_ID_PATTERN } from "./stores.js";
import { buildTextIndexInSlices, canSerialize, serializeTextIndex } from "./text-index.js";
import { measureText, prepareText, removeInvisible, sliceWhole, wellFormed } from "./text.js";
import type { RetryOptions } from "./retry.js";
import { createDocumentTools } from "./tools.js";
import type {
  Budget,
  DocumentFormat,
  DocumentMeta,
  DocumentStore,
  DocumentSummary,
  ExtractedText,
  ExtractProgress,
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
    ...(meta.encoding ? { encoding: meta.encoding } : {}),
    ...(meta.replacedCharacters ? { replacedCharacters: meta.replacedCharacters } : {}),
    expiresAt: meta.expiresAt,
  };
}

/** An encoding's name as TextDecoder gives it ("windows-1255"): an extractor of your own may name another. */
const ENCODING_NAME = /^[a-z0-9][a-z0-9._:-]{0,39}$/i;

/**
 * Whether the name is an older encoding, as `DocumentMeta.encoding` records: not UTF-8 or UTF-16,
 * under any of their names ("utf8", "unicode"). The model is told the file is not in UTF-8.
 */
function olderEncoding(name: unknown): name is string {
  if (typeof name !== "string" || !ENCODING_NAME.test(name)) return false;
  let known: string;
  try {
    known = new TextDecoder(name).encoding;
  } catch {
    // A name TextDecoder does not know: the extractor read the file itself.
    return true;
  }
  return known !== "utf-8" && known !== "utf-16le" && known !== "utf-16be";
}

/** How the text of a file was read, as its extractor said, in the fields of `DocumentMeta`. */
function readingOf(extracted: ExtractedText): Pick<DocumentMeta, "encoding" | "replacedCharacters"> {
  const { encoding, replacedCharacters } = extracted;
  return {
    ...(olderEncoding(encoding) ? { encoding } : {}),
    ...(typeof replacedCharacters === "number" && Number.isSafeInteger(replacedCharacters) && replacedCharacters > 0 ? { replacedCharacters } : {}),
  };
}

/**
 * A file name as one printable line: the last path segment. Control characters, line and paragraph
 * separators, and text-direction controls (the marks of right-to-left text included) become a space.
 * Names are shown to the model and in UIs, so a name must not be able to start a new line of the
 * prompt, or disguise its extension. Most characters that show nothing are removed (tag characters,
 * zero-width spaces); the variation selectors and joiners that scripts and emoji need are kept, and
 * can still carry data a person does not see.
 */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).at(-1) ?? "";
  // Control characters, line and paragraph separators, and text-direction controls become a space.
  const spaced = base.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, " ");
  const name = removeInvisible(spaced).replace(/\s+/g, " ").trim();
  // At most 255 characters, never half of an emoji. A flag cut short loses the tags left of it.
  return (name.length > 255 ? removeInvisible(sliceWhole(name, 255)) : name) || "file";
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
 * Refuses an owner that every caller without a user would share: an empty string (what
 * `user?.id ?? ""` gives), one of spaces only, or null. Undefined is no owner. A number is let
 * through, as before, for JavaScript code that passes numeric user IDs.
 */
export function checkOwner(owner: unknown): void {
  if (owner === undefined || (typeof owner === "string" && owner.trim() !== "") || (typeof owner === "number" && Number.isFinite(owner))) return;
  throw new TypeError("owner must be a string that is not empty or only spaces, such as the signed-in user's ID. To let anyone with the document's ID use it, leave owner out.");
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
/** The refusal of a file whose text is larger than `maxTextBytes`. */
const tooMuchText = (name: string, maxTextBytes: number) =>
  new Error(`${name} holds more than ${formatBytes(maxTextBytes)} of text, more than is kept from one file. Split it, and attach the part you need.`);

/** Default for `maxPdfPages`. */
export const DEFAULT_MAX_PDF_PAGES = 5_000;
/** Default for `maxTextBytes`, when `maxUploadBytes` is not larger: 100 MB. */
export const DEFAULT_MAX_TEXT_BYTES = 100 * 1024 * 1024;
/** Default for `ingestTimeoutMs`: 2 minutes. */
export const DEFAULT_INGEST_TIMEOUT_MS = 120_000;
/** The longest a Node.js timer waits: a longer one fires at once. A limit past it is no limit. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** A time limit in the words of a message: "500 ms", "45 s", "2 min". */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 120_000) return `${Number((ms / 1_000).toFixed(1))} s`;
  return `${Number((ms / 60_000).toFixed(1))} min`;
}

/**
 * The signal one ingest runs under: aborted when the caller's is, or when `timeoutMs` has passed
 * (with an error that says the file took too long). `dispose` stops the timer.
 */
function ingestSignal(name: string, caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller!.reason);
  if (caller?.aborted) controller.abort(caller.reason);
  else caller?.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs > 0 && timeoutMs <= LONGEST_TIMER_MS
    ? setTimeout(() => controller.abort(new Error(`${name} took too long to read (more than ${formatDuration(timeoutMs)}). Split it, or save it as plain text, and attach that.`)), timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * `work`, or the signal's reason as soon as it is aborted: an extractor of your own that does not
 * look at the signal is no longer waited for (though the work it does cannot be stopped).
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The message of `ingest.error` when the store failed to write the document. */
const STORE_WRITE_FAILED = "The document could not be stored. Try again later.";

/** The least time between two `ingest.progress` events of one stage, in milliseconds: a slice of `TimeSlicer`. */
const PROGRESS_MS = 12;

type ProgressUnit = Extract<IngestEvent, { type: "ingest.progress" }>["unit"];
const EXTRACT_STAGES = new Set<unknown>(["extract", "check", "pictures", "decode"]);
const EXTRACT_UNITS = new Set<unknown>(["pages", "parts", "bytes"]);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** What `ingest.start` says of an ingest, worked out from whatever it was given: the checks come after it. */
function startOf(input: IngestInput | undefined): { name: string; format: DocumentFormat; bytes: number } {
  try {
    const name = typeof input?.name === "string" ? cleanFileName(input.name) : "";
    const mimeType = (typeof input?.mimeType === "string" ? input.mimeType.trim() : "") || "application/octet-stream";
    const bytes = input?.bytes?.byteLength;
    return { name, format: detectFormat(name, mimeType), bytes: isCount(bytes) ? bytes : 0 };
  } catch {
    return { name: "", format: "text", bytes: 0 };
  }
}

type HeldProgress = { done: number; total: number | undefined; unit: ProgressUnit; sent: boolean };

/**
 * Sends the `ingest.progress` events of one ingest: at most one every `PROGRESS_MS` for each stage,
 * however the stages take turns, then the last progress of each stage when the stages end (`end`).
 * A progress that completes its stage goes out at once, the first time, so that stages that run one
 * after the other end in that order. Made only when someone listens.
 */
class IngestProgress {
  /** Each stage that reported, in the order it first did: when it last sent, and its last progress. */
  private readonly stages = new Map<IngestStage, { sentAt: number; completed: boolean; last: HeldProgress }>();
  /** Set once a stage after the extractor's began: an extract stage is not reported again. */
  private extractOver = false;

  constructor(private readonly events: EventEmitter<IngestEvent>) {}

  report(stage: IngestStage, done: number, total: number | undefined, unit: ProgressUnit): void {
    if (!EXTRACT_STAGES.has(stage)) this.extractOver = true;
    const last: HeldProgress = { done, total, unit, sent: false };
    let state = this.stages.get(stage);
    if (!state) {
      state = { sentAt: Number.NEGATIVE_INFINITY, completed: false, last };
      this.stages.set(stage, state);
    }
    state.last = last;
    const now = performance.now();
    const completes = !state.completed && total !== undefined && done >= total;
    if (completes) state.completed = true;
    if (completes || now - state.sentAt >= PROGRESS_MS) {
      state.sentAt = now;
      this.send(stage, last);
    }
  }

  /** The progress an extractor reported (`ExtractInput.onProgress`). One of your own may send anything: what does not fit is left out. */
  extracted(progress: ExtractProgress): void {
    if (this.extractOver) return;
    const stage = progress?.stage ?? "extract";
    if (!EXTRACT_STAGES.has(stage) || !EXTRACT_UNITS.has(progress?.unit) || !isCount(progress?.done)) return;
    this.report(stage, progress.done, isCount(progress.total) ? progress.total : undefined, progress.unit);
  }

  /** The stages so far are over: the last progress of each, when it was held back, goes out, in the order they began. */
  end(): void {
    const held = [...this.stages].filter(([, state]) => !state.last.sent);
    this.stages.clear();
    for (const [stage, state] of held) this.send(stage, state.last);
  }

  private send(stage: IngestStage, last: HeldProgress): void {
    last.sent = true;
    this.events.emit({
      type: "ingest.progress",
      stage,
      done: last.done,
      ...(last.total !== undefined ? { total: last.total } : {}),
      unit: last.unit,
    });
  }
}

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
  const scannedPdfPages = Math.max(0, Math.trunc(numberOption("scannedPdfPages", options.scannedPdfPages, 30)));
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

  /**
   * The work of `ingest`, once the file is named: `detected` is the format its name and type say.
   * `progress` is given when someone listens to the events of the ingest. `storeFailed` is called
   * when the store fails to write the document, whatever it throws.
   */
  async function ingestFile(
    input: IngestInput,
    name: string,
    mimeType: string,
    detected: DocumentFormat,
    progress: IngestProgress | undefined,
    storeFailed: () => void,
  ): Promise<DocumentMeta> {
    if (input.bytes.byteLength === 0) throw new Error(`${name} is empty.`);
    if (input.bytes.byteLength > maxUploadBytes) {
      throw new Error(`${name} is larger than the ${formatBytes(maxUploadBytes)} upload limit.`);
    }
    let format = detected;
    const { signal, dispose } = ingestSignal(name, input.signal, ingestTimeoutMs);
    // Each long step works in slices, with pauses for other requests: one large upload no longer
    // holds the whole server while it is read.
    const slicer = new TimeSlicer(signal);
    let pages: number | undefined;
    let reading: ReturnType<typeof readingOf>;
    let text: string;
    let wrapped: number;
    let lines: string[];
    let measured: Awaited<ReturnType<typeof measureText>>;
    let outline: DocumentMeta["outline"];
    let logProfile: DocumentMeta["logProfile"];
    let index: Awaited<ReturnType<typeof buildTextIndexInSlices>> | undefined;
    try {
      signal.throwIfAborted();
      // In a function of its own, so that the text as extracted is let go once it is prepared:
      // the steps after it hold only the prepared text.
      const read = async () => {
        // What an extractor of your own reports once it has settled (from a timer, a worker) is
        // not reported: the stages after it have begun.
        let extracting = true;
        let extracted: ExtractedText;
        try {
          extracted = await untilAborted(extractText(input.bytes, {
            name,
            mimeType,
            format,
            // A scan is worth storing only if its pages can be shown later: that needs the file itself.
            ...(format === "pdf" && keeps(format) && scannedPdfPages > 0 ? { scannedPages: scannedPdfPages } : {}),
            signal,
            maxTextBytes,
            maxPages: maxPdfPages,
            ...(progress ? { onProgress: (report: ExtractProgress) => { if (extracting) progress.extracted(report); } } : {}),
          }, options.extractors), signal);
        } finally {
          extracting = false;
        }
        progress?.end();
        // A character is at least one byte: a text this long is too large whatever it holds.
        if (extracted.text.length > maxTextBytes) throw tooMuchText(name, maxTextBytes);
        await slicer.pauseNow();
        return { pages: extracted.pages, reading: readingOf(extracted), ...await prepareText(extracted.text, slicer, progress && ((done, total) => progress.report("prepare", done, total, "characters"))) };
      };
      ({ pages, reading, text, wrapped, lines } = await read());
      progress?.end();
      if (!text.trim()) throw new Error(`${name} did not contain any text.`);
      if (format === "text" && looksLikeLog(lines)) format = "log";
      measured = await measureText(text, slicer);
      if (measured.utf8 > maxTextBytes) throw tooMuchText(name, maxTextBytes);
      outline = await buildOutlineInSlices(lines, format, slicer);
      logProfile = format === "log" ? await buildLogProfileInSlices(lines, slicer) : undefined;
      // The line index, so that the text can be read by range: a few bytes a line, built from the
      // UTF-8 bytes the store writes. Kept by any store that can keep it, even one this library
      // then loads whole, so that switching to reading by range finds it ready.
      index = typeof store.putIndex === "function"
        ? await buildTextIndexInSlices(text, slicer, progress && ((done, total) => progress.report("index", done, total, "characters")))
        : undefined;
      progress?.end();
      signal.throwIfAborted();
    } finally {
      dispose();
    }
    const created = now();
    const expires = created.getTime() + ttlMs;
    const keepOriginal = keeps(format);
    const meta: DocumentMeta = {
      id: `doc_${randomUUID().replaceAll("-", "")}`,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      name,
      mimeType,
      format,
      bytes: input.bytes.byteLength,
      textBytes: measured.utf8,
      jsonBytes: measured.json,
      characters: text.length,
      lines: lines.length,
      estimatedTokens: measured.tokens,
      wrappedLines: wrapped,
      ...(pages ? { pages } : {}),
      ...reading,
      ...(keepOriginal ? { originalKept: true } : {}),
      outline,
      ...(logProfile ? { logProfile } : {}),
      createdAt: created.toISOString(),
      // Never, for a time to live without end (or one that runs past what a date can hold).
      expiresAt: expires >= Date.parse(NEVER_EXPIRES) ? NEVER_EXPIRES : new Date(expires).toISOString(),
    };
    const savedIndex = index && canSerialize(index) && index.lineCount === meta.lines && index.characters === meta.characters
      ? serializeTextIndex(index)
      : undefined;
    // Each write is reported once done. What the listener of the events throws is not the store's failure.
    const writes = (keepOriginal ? 1 : 0) + (savedIndex ? 1 : 0) + 1;
    let written = 0;
    let listenerFailed: { error: unknown } | undefined;
    const wrote = (last: boolean) => {
      if (!progress) return;
      try {
        progress.report("store", ++written, writes, "parts");
        if (last) progress.end();
      } catch (error) {
        listenerFailed = { error };
        throw error;
      }
    };
    try {
      // The files first, the document last: a document is there once its metadata is.
      if (keepOriginal) {
        await store.putOriginal!(meta.id, input.bytes);
        wrote(false);
      }
      if (savedIndex) {
        await store.putIndex!(meta.id, savedIndex);
        wrote(false);
      }
      await store.put({ meta, text });
      wrote(true);
    } catch (error) {
      // Do not leave a file of up to the upload limit, or a part of one, behind for a document
      // that does not exist.
      await store.delete(meta.id).catch(() => undefined);
      if (listenerFailed?.error !== error) {
        noteStoreWriteFailure(error);
        storeFailed();
      }
      throw error;
    }
    return meta;
  }

  return {
    budget,
    budgetFor,
    maxUploadBytes,

    async ingest(input) {
      // The events first, so that every ingest that throws, even on what it was given, ends with ingest.error.
      const events = new EventEmitter<IngestEvent>(input?.runId ?? newRunId("ing"), input?.onEvent);
      let storeFailed = false;
      try {
        if (events.active) events.emit({ type: "ingest.start", ...startOf(input) });
        checkOwner(input.owner);
        const name = cleanFileName(input.name);
        const mimeType = input.mimeType?.trim() || "application/octet-stream";
        const format = detectFormat(name, mimeType);
        // Progress is worked out only for someone who listens.
        const progress = events.active ? new IngestProgress(events) : undefined;
        const meta = await ingestFile(input, name, mimeType, format, progress, () => (storeFailed = true));
        try {
          events.emit({ type: "ingest.finish", document: toDocumentSummary(meta) });
        } catch (error) {
          // The caller never gets the id: the document goes, as on a throw of the listener a moment earlier.
          await store.delete(meta.id).catch(() => undefined);
          forget(meta.id);
          throw error;
        }
        return meta;
      } catch (error) {
        // A store's own error may name a host or a path, whatever it is: the event, which a browser
        // may see, says only that the document could not be stored.
        events.emit({ type: "ingest.error", error: storeFailed ? { message: STORE_WRITE_FAILED } : eventErrorOf(error) });
        throw error;
      }
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
        ...rest,
      });
    },
  };
}
