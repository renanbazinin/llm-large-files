// `files.ingest`: reads a file, prepares its text, and stores it. Moved out of library.ts in 0.9.0:
// the library hands it what it needs in an `IngestContext`.
import { randomUUID } from "node:crypto";
import { checkMetaVersion, checkOwner, heldBy, metaOf, OWNER_REQUIRED, SCOPE_REQUIRED, storeCall, storeContext, type AccessRules } from "./access.js";
import { buildLogProfileInSlices, buildOutlineInSlices, looksLikeLog } from "./analyze.js";
import { DocumentScopeError, DocumentStoreError, IngestError, isStoreWriteFailure, noteStoreWriteFailure, toIngestError } from "./errors.js";
import { EventEmitter, eventErrorOf, newRunId, type EventError, type IngestEvent, type IngestStage } from "./events.js";
import { detectFormat, extractorFor, extractText, isZip, namedFormat, sniffParts, SNIFFED_FIRST, SNIFFED_HEAD, SNIFFED_TAIL } from "./extract.js";
import type { IngestFromSource, IngestInput } from "./library.js";
import type { Limiter } from "./limiter.js";
import { TimeSlicer } from "./pause.js";
import { formatBytes } from "./plan.js";
import { measureQuality, type TextQuality } from "./quality.js";
import { checkScope } from "./scope.js";
import { absolutePath, isSha256, readRanges, readSource, sha256InSlices, statSource, type SourceRead } from "./source.js";
import { APP_DOCUMENT_ID_PATTERN, DOCUMENT_META_VERSION } from "./stores.js";
import { buildTextIndexInSlices, canSerialize, serializeTextIndex } from "./text-index.js";
import { measureText, prepareText, removeInvisible, sliceWhole } from "./text.js";
import type { DocumentContext, DocumentFormat, DocumentMeta, DocumentScope, DocumentStore, DocumentSummary, ExtractedText, ExtractProgress, Extractor } from "./types.js";

export { checkOwner } from "./access.js";

/** What `ingest` needs of the library it belongs to: its options, as the library read them, and its state. */
export type IngestContext = {
  readonly store: DocumentStore;
  readonly now: () => Date;
  readonly ttlMs: number;
  readonly maxUploadBytes: number;
  readonly maxTextBytes: number;
  readonly maxPdfPages: number;
  readonly ingestTimeoutMs: number;
  readonly scannedPdfPages: number;
  readonly extractors: Partial<Record<DocumentFormat, Extractor>> | undefined;
  /** The ingests doing their work, and those waiting their turn (`maxConcurrentIngests`). */
  readonly ingests: Limiter;
  /** How long work an ingest waits on, or gave up on, may keep its turn (see `IngestSlot`). */
  readonly slotCapMs: number;
  /**
   * Whether the uploaded file of a document of this format is kept: by its ref (`IngestInput.original`,
   * read by `LargeFilesOptions.originals`), or else as a copy in the store (`putOriginal`).
   */
  readonly keeps: (format: DocumentFormat, byRef: boolean) => boolean;
  /** Whether the library reads uploaded files that the application keeps (`LargeFilesOptions.originals`). */
  readonly readsRefs: boolean;
  /** Forgets everything kept in memory of a document, in every scope: the document, and its pieces. */
  readonly forget: (id: string) => void;
  /** What every call must name (`requireOwner`, `requireScope`). */
  readonly rules: AccessRules;
  /**
   * The application's IDs (`IngestInput.id`) of the ingests of this library under way, from their
   * first look at the store to the end of their writes and of `ingest.finish`; and when writes did
   * not end in time, until they and the removal of what they wrote have ended. A second ingest of
   * one of them is refused ("exists"), whatever its `ifExists`, owner or scope: two ingests that both
   * found the ID free would write over each other, and a store that ignores the context keeps one
   * document of an ID for every scope.
   */
  readonly ingesting: Set<string>;
};

/**
 * Where an ingest writes: the ID the application gave (`IngestInput.id`), when it gave one, what
 * to do when it is taken, and the owner and scope of the document, which every store call carries.
 */
type Target = {
  readonly id: string | undefined;
  readonly ifExists: "fail" | "replace";
  readonly owner: string | undefined;
  readonly scope: DocumentScope | undefined;
  /** The context of every store call of the ingest. */
  readonly context: DocumentContext;
};

/** The TypeError of an `IngestInput.id` of another shape. It does not repeat the ID, which may hold what it must not. */
const ID_SHAPE = 'id must be lowercase letters, digits, "_" and "-", up to 64 characters, starting with a letter or a digit (APP_DOCUMENT_ID_PATTERN), and not a name Windows keeps for a device (con, nul, com1…).';

/** The ID, `ifExists`, owner and scope of an ingest, checked (the owner already is). */
function targetOf(input: IngestInput | IngestFromSource, rules: AccessRules): Target {
  if (rules.requireOwner && input.owner === undefined) throw new TypeError(OWNER_REQUIRED);
  // Null is no scope, as a database gives a field that was left out.
  const scope = checkScope(input.scope ?? undefined);
  if (rules.requireScope && scope === undefined) throw new TypeError(SCOPE_REQUIRED);
  const { id, ifExists = "fail" } = input;
  if (id !== undefined && (typeof id !== "string" || !APP_DOCUMENT_ID_PATTERN.test(id))) throw new TypeError(ID_SHAPE);
  if (ifExists !== "fail" && ifExists !== "replace") throw new TypeError('ifExists must be "fail" or "replace".');
  return { id, ifExists, owner: input.owner, scope, context: storeContext(scope, input.owner) };
}

/** The refusal of an application's ID that is taken (`ifExists`). It says nothing of the document that has it. */
const exists = (name: string) => new IngestError("exists", `${name}: a document with this ID already exists.`);

/**
 * Whether the application's ID may be written, as the store sees it for this context: a document
 * of that ID that is there is an `IngestError` "exists", unless `ifExists` is "replace" and the
 * document has the same owner and scope. One of another owner or scope is never replaced, even when
 * its text looks gone: a store, or a wrapper of one, that does not pass the context on to every
 * call would say so of a document that is there. A document written by a newer version of the
 * package is never replaced (`DocumentStoreError` "NEWER_VERSION"). Returns true when there is a
 * document to delete before the new one is written: the one being replaced, or one expired.
 */
async function claim(context: IngestContext, target: Target & { id: string }, name: string): Promise<boolean> {
  const { store, now } = context;
  const { id } = target;
  const found = metaOf(await storeCall("read", () => store.getMeta(id, target.context)), id);
  if (!found) return false;
  if (Date.parse(found.expiresAt) <= now().getTime()) return true;
  if (target.ifExists === "fail") throw exists(name);
  checkMetaVersion(found);
  if (heldBy(found, target.owner, target.scope)) return true;
  throw exists(name);
}

/**
 * Removes what an ingest wrote under its ID, after a write that failed or a listener that threw on
 * `ingest.finish`: only while the document there, if any, is the ingest's own (the same `createdAt`,
 * owner and scope). A made ID is the ingest's alone. Under an application's ID, another document may
 * be there: one the ingest was to replace (its delete failed), or one another server stored
 * meanwhile. It is left. "taken" when the ingest could not have replaced it: it has not expired, and
 * it is of another owner or scope. "left" for any other.
 */
async function removeOwn(context: Pick<IngestContext, "store" | "now">, target: Target, meta: DocumentMeta): Promise<"removed" | "left" | "taken"> {
  const { store, now } = context;
  if (target.id !== undefined) {
    const found = metaOf(await storeCall("read", () => store.getMeta(meta.id, target.context)), meta.id);
    if (found && !(found.createdAt === meta.createdAt && heldBy(found, meta.owner, meta.scope))) {
      // As `claim` sees it: a date that cannot be read has not expired.
      const expired = Date.parse(found.expiresAt) <= now().getTime();
      return !expired && !heldBy(found, target.owner, target.scope) ? "taken" : "left";
    }
  }
  await store.delete(meta.id, target.context);
  return "removed";
}

/** A store that did not answer in time, as it wrote or was read at ingest: its cause says for how long it was waited for. */
const storeTimeout = (name: string, ms: number, operation: "write" | "read" = "write") => new DocumentStoreError(
  Object.assign(new Error(`The store did not ${operation === "write" ? "finish writing" : "answer about"} ${name} within ${formatDuration(ms)}.`), { code: "ETIMEDOUT" }),
  { operation, code: "ETIMEDOUT" },
);

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

/** The MIME type of a file that says nothing of what it is. */
const OCTET_STREAM = "application/octet-stream";
/** A token of RFC 9110: the characters a type or a subtype of a MIME type is made of. */
const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9a-z-]+";
const MIME_TYPE = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}$`);
/** Printable ASCII, and tabs: a header value without a line break, or a character that shows nothing. */
const PRINTABLE = /^[\t\x20-\x7e]*$/;
/** The longest type/subtype kept: 127 characters. */
const MAX_MIME_TYPE = 127;

/**
 * A file's MIME type as it is kept: its type and subtype, in lower case, without parameters
 * ("Text/CSV; charset=x" is "text/csv"). One that is not a type/subtype of RFC 9110 token
 * characters, of at most 127 characters, or that holds anything but printable ASCII anywhere (a
 * line break, a text-direction control, a tag character), is "application/octet-stream". The
 * library never used the parameters: a text's encoding is found from its bytes. New in 0.9.0.
 */
export function cleanMimeType(raw: unknown): string {
  if (typeof raw !== "string" || !PRINTABLE.test(raw)) return OCTET_STREAM;
  const type = raw.split(";", 1)[0]!.trim().toLowerCase();
  return type.length <= MAX_MIME_TYPE && MIME_TYPE.test(type) ? type : OCTET_STREAM;
}

/** The longest `IngestInput.original.ref`, in UTF-16 units. */
const MAX_REF_LENGTH = 1_024;

/**
 * The path of an ingest from a path (`IngestFromSource.source`), checked; undefined for an ingest
 * of bytes. A source of null is none, as a database gives a field that was left out.
 *
 * A relative path is made absolute here, once, against the working directory of the call
 * (`absolutePath`): every read of the file, at the call, at the turn, and in a child process of an
 * isolated reader (whose working directory is its own), reads the file named then. Neither is
 * normalized: a ".." after a link, and a "/" at the end, are the system's to resolve, for a
 * relative path as for an absolute one.
 */
function sourcePathOf(input: IngestInput | IngestFromSource): string | undefined {
  const source: unknown = (input as { source?: unknown }).source;
  if (source === undefined || source === null) return undefined;
  if ((input as { bytes?: unknown }).bytes !== undefined) throw new TypeError("Give the file as bytes or as source, not both.");
  const path: unknown = typeof source === "object" ? (source as { path?: unknown }).path : undefined;
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new TypeError("source.path must be the path of a file: a string that is not empty.");
  return absolutePath(path);
}

/**
 * The ref of the uploaded file the application keeps (`IngestInput.original`), checked. It needs
 * a reader (`LargeFilesOptions.originals`): without one, the file could never be read back.
 */
function originalRefOf(input: IngestInput | IngestFromSource, readsRefs: boolean): string | undefined {
  const original: unknown = input.original;
  if (original === undefined || original === null) return undefined;
  const ref: unknown = typeof original === "object" ? (original as { ref?: unknown }).ref : undefined;
  if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_REF_LENGTH) throw new TypeError("original.ref must be a string of 1 to 1,024 characters.");
  if (!readsRefs) throw new TypeError("original needs LargeFilesOptions.originals, which reads the file from its ref.");
  return ref;
}

/** The refusal of a file of no bytes. */
const emptyFile = (name: string) => new Error(`${name} is empty.`);
/** The refusal of a file larger than `maxUploadBytes`. */
const tooLarge = (name: string, maxUploadBytes: number) => new Error(`${name} is larger than the ${formatBytes(maxUploadBytes)} upload limit.`);

/** `size`, the size of the file of an ingest, once it is neither empty nor larger than the upload limit. */
function checkedSize(name: string, size: number, maxUploadBytes: number): number {
  if (size === 0) throw emptyFile(name);
  if (size > maxUploadBytes) throw tooLarge(name, maxUploadBytes);
  return size;
}

const NO_BYTES = new Uint8Array(0);

/**
 * The format of a file at a path: the one its name and type say, or, when they say nothing, the
 * one its bytes say (`sniffParts`), from reads of the parts looked at and not the rest: its first
 * KB, and for a ZIP its first 64 KB and its last MB.
 */
async function formatAtPath(name: string, mimeType: string, path: string, size: number): Promise<DocumentFormat> {
  const { format, sniff } = namedFormat(name, mimeType);
  if (!sniff) return format;
  const [first = NO_BYTES] = await readRanges(path, [[0, Math.min(size, SNIFFED_FIRST)]]);
  if (!isZip(first)) return sniffParts(first, NO_BYTES) ?? format;
  const [head = NO_BYTES, tail = NO_BYTES] = await readRanges(path, [[0, Math.min(size, SNIFFED_HEAD)], [Math.max(SNIFFED_HEAD, size - SNIFFED_TAIL), size]]);
  return sniffParts(head, tail) ?? format;
}

/**
 * What an extractor that reads paths read (`ExtractedText.file`), when it said so in the shape it
 * is kept in: a whole number of bytes, and a SHA-256 of 64 lowercase hex digits.
 */
function fileOf(extracted: ExtractedText): { bytes: number; sha256: string } | undefined {
  const file: unknown = extracted.file;
  if (typeof file !== "object" || file === null) return undefined;
  const { bytes, sha256 } = file as { bytes?: unknown; sha256?: unknown };
  return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 && isSha256(sha256) ? { bytes, sha256 } : undefined;
}

/**
 * The `expiresAt` of a document that never expires (`ttlMs: Infinity`): the last instant of the
 * year 9999. A date, so that every comparison, and a server of an older version, reads it as any other.
 */
export const NEVER_EXPIRES = "9999-12-31T23:59:59.999Z";

/** The refusal of a file whose text is larger than `maxTextBytes`. */
const tooMuchText = (name: string, maxTextBytes: number) =>
  new Error(`${name} holds more than ${formatBytes(maxTextBytes)} of text, more than is kept from one file. Split it, and attach the part you need.`);

/** The longest a Node.js timer waits: a longer one fires at once. A limit past it is no limit. */
export const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** `value` copied through JSON: new strings, none of them a piece of a larger one. */
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** `work`, or the error `late` makes once `ms` have passed without it settling. */
function settleWithin<T>(work: Promise<T>, ms: number, late: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), ms);
  });
  return Promise.race([work, timeUp]).finally(() => clearTimeout(timer));
}

/**
 * A look at a file at a path before the ingest's turn (its lstat, the parts read for its format):
 * given up on with the caller's reason when the caller leaves, and failed, as the server's trouble
 * (a system error, which names no path), when the volume does not answer within `ms`. The look
 * itself cannot be stopped; it holds no turn.
 */
function lookWithin<T>(look: Promise<T>, signal: AbortSignal | undefined, ms: number, syscall: "lstat" | "read"): Promise<T> {
  return settleWithin(signal ? untilAborted(look, signal) : look, ms, () =>
    Object.assign(new Error(`The file to ingest did not answer within ${formatDuration(ms)}.`), { code: "ETIMEDOUT", syscall }));
}

/**
 * The turn of one ingest (`maxConcurrentIngests`). It is given back when the ingest ends; when the
 * ingest gave up on work that goes on (an extractor that does not stop on the signal, such as a
 * PDF being parsed when its caller left), once that work ends, or `capMs` later when it does not.
 * (Store writes that do not end fail the ingest after `capMs`: see `ingestFile`.)
 */
class IngestSlot {
  private released = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly release: () => void, private readonly capMs: number) {}

  private readonly free = () => {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timer);
    this.release();
  };

  /**
   * Gives the turn back `capMs` from now at the latest. The timer keeps the process alive: work
   * that never ends may hold nothing that does, and ingests waiting for the turn would be lost.
   */
  limit(): void {
    if (this.released || this.timer !== undefined) return;
    this.timer = setTimeout(this.free, this.capMs);
  }

  /** The ingest is over: the turn goes back now, or once `abandoned` ends (`capMs` at the latest). */
  end(abandoned?: Promise<unknown>): void {
    if (!abandoned) return this.free();
    abandoned.then(this.free, this.free);
    this.limit();
  }
}

/** A time limit in the words of a message: "500 ms", "45 s", "2 min". */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 120_000) return `${Number((ms / 1_000).toFixed(1))} s`;
  return `${Number((ms / 60_000).toFixed(1))} min`;
}

/**
 * The signal one ingest runs under: aborted when the caller's is, or when `timeoutMs` has passed
 * (with an error that says the file took too long). `dispose` stops the timer. `timedOut` says
 * whether an error is the one of the time limit.
 */
function ingestSignal(name: string, caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void; timedOut(error: unknown): boolean } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller!.reason);
  if (caller?.aborted) controller.abort(caller.reason);
  else caller?.addEventListener("abort", onAbort, { once: true });
  let late: Error | undefined;
  const timer = timeoutMs > 0 && timeoutMs <= LONGEST_TIMER_MS
    ? setTimeout(() => controller.abort(late = new Error(`${name} took too long to read (more than ${formatDuration(timeoutMs)}). Split it, or save it as plain text, and attach that.`)), timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
    timedOut: (error) => late !== undefined && error === late,
  };
}

/**
 * `work`, or the signal's reason as soon as it is aborted: an extractor of your own that does not
 * look at the signal is no longer waited for (though the work it does cannot be stopped). Work
 * given up on is still watched: if it fails later, that is not an unhandled rejection, which ends
 * a Node.js process.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * The error of `ingest.error` when the store failed to write the document: a `DocumentStoreError`
 * (503), in these words whatever the store threw, which may name a host or a path. Its name and
 * status are set here, not taken from the error: a store's own subclass of `DocumentStoreError`,
 * of a name of its own, is still told as one, which `errorInfoOf` reads as a store that failed.
 */
const storeWriteFailed = (): EventError => ({ message: "The document could not be stored. Try again later.", name: "DocumentStoreError", status: 503 });

/** The least time between two `ingest.progress` events of one stage, in milliseconds: a slice of `TimeSlicer`. */
const PROGRESS_MS = 12;

type ProgressUnit = Extract<IngestEvent, { type: "ingest.progress" }>["unit"];
const EXTRACT_STAGES = new Set<unknown>(["extract", "check", "pictures", "decode"]);
const EXTRACT_UNITS = new Set<unknown>(["pages", "parts", "bytes"]);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * What `ingest.start` says of an ingest, worked out from whatever it was given: the checks come
 * after it. `statSize`: the size of a file at a path, as `lstat` gave it.
 */
function startOf(input: IngestInput | IngestFromSource | undefined, statSize: number | undefined): { name: string; format: DocumentFormat; bytes: number } {
  try {
    const name = typeof input?.name === "string" ? cleanFileName(input.name) : "";
    const mimeType = cleanMimeType(input?.mimeType);
    const bytes = statSize ?? input?.bytes?.byteLength;
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

/** Work an ingest gave up on, which goes on once it has ended. */
type IngestWork = {
  /** An extraction it no longer waits for: the ingest's turn is kept until it ends (`IngestSlot`). */
  abandoned?: Promise<unknown>;
  /**
   * Writes that did not end in time, then the removal of what they wrote: the application's ID
   * stays held in `ingesting` until they have ended, since they may still land.
   */
  writes?: Promise<unknown>;
};

/**
 * Where the file of an ingest is: `path` for one from a path (`IngestFromSource`), else its bytes
 * (`IngestInput.bytes`); and `ref`, where the application keeps it (`IngestInput.original`).
 */
type Upload = { readonly path: string | undefined; readonly ref: string | undefined };

/**
 * The caller left (`IngestInput.signal`) while the document was written: once the writes have
 * ended, what they wrote is removed, while it is this ingest's own (`removeOwn`), and within the time
 * the writes were given; the caller gets its own reason. Before 0.9.0, a client that left during the
 * write left the document behind, kept for good under `ttlMs: Infinity`.
 */
async function removeAbandoned(context: IngestContext, target: Target, meta: DocumentMeta, work: IngestWork, reason: unknown): Promise<never> {
  let ended = false;
  const removal = removeOwn(context, target, meta).catch(() => undefined).then(() => {
    ended = true;
  });
  await settleWithin(removal, context.slotCapMs, () => new Error("")).catch(() => undefined);
  // A removal that has not ended may still land: the ID stays held until it has (see `IngestWork`).
  if (!ended) work.writes = removal;
  context.forget(meta.id);
  throw reason;
}

/**
 * The work of `ingest`, once the file is named: `detected` is the format its name and type say.
 * `progress` is given when someone listens to the events of the ingest. `storeFailed` is called
 * when the store fails to write the document, whatever it throws.
 */
async function ingestFile(
  context: IngestContext,
  input: IngestInput | IngestFromSource,
  target: Target,
  name: string,
  mimeType: string,
  detected: DocumentFormat,
  progress: IngestProgress | undefined,
  storeFailed: () => void,
  work: IngestWork,
  upload: Upload,
): Promise<DocumentMeta> {
  const { store, now, ttlMs, maxUploadBytes, maxTextBytes, maxPdfPages, ingestTimeoutMs, scannedPdfPages, extractors, slotCapMs, keeps, forget } = context;
  const { path, ref } = upload;
  const byRef = ref !== undefined;
  let format = detected;
  // A file kept in the store (`putOriginal`, without a ref) needs its bytes in the server. A text
  // may turn out to be a log once it is read.
  const mayCopy = !byRef && (keeps(format, false) || (format === "text" && keeps("log", false)));
  // A file at a path that its extractor reads itself (an isolated reader) is not read here at all.
  const extractorReads = path !== undefined && extractorFor(format, extractors).readsPath === true && !mayCopy;
  const { signal, dispose, timedOut } = ingestSignal(name, input.signal, ingestTimeoutMs);
  // Each long step works in slices, with pauses for other requests: one large upload no longer
  // holds the whole server while it is read.
  const slicer = new TimeSlicer(signal);
  /** The bytes of the file, while they are needed: until it is extracted, or kept in the store. */
  let bytes: Uint8Array | undefined;
  let size = 0;
  let sha256 = "";
  /** The bytes to keep in the store (`putOriginal`), until they are written. */
  let copy: Uint8Array | undefined;
  /**
   * A read of the file at `path`, or the signal's reason once it aborts. A volume that does not
   * answer within the ingest's time is the server's trouble, not the file's: a system error
   * ETIMEDOUT (503, to try again), not the `IngestError` "timeout" of a file that takes too long to
   * read (422, "split it"), since 0.10.0. The ingest keeps its turn until the read ends (`IngestSlot`).
   */
  const readWithin = async <T>(read: Promise<T>): Promise<T> => {
    work.abandoned = read;
    let got: T;
    try {
      got = await untilAborted(read, signal);
    } catch (error) {
      if (timedOut(error)) throw Object.assign(new Error(`The file to ingest did not answer within ${formatDuration(ingestTimeoutMs)}.`), { code: "ETIMEDOUT", syscall: "read" });
      throw error;
    }
    work.abandoned = undefined;
    return got;
  };
  let pages: number | undefined;
  let reading: ReturnType<typeof readingOf>;
  let text: string;
  let wrapped: number;
  let lines: string[];
  let measured: Awaited<ReturnType<typeof measureText>>;
  let outline: DocumentMeta["outline"];
  let logProfile: DocumentMeta["logProfile"];
  let quality: TextQuality = {};
  let index: Awaited<ReturnType<typeof buildTextIndexInSlices>> | undefined;
  try {
    signal.throwIfAborted();
    // The file is read once, at its turn, and never past the upload limit: one that has grown
    // since it was looked at is refused. Its SHA-256 is taken as it is read, a slice at a time.
    if (path === undefined) {
      bytes = (input as IngestInput).bytes;
      size = bytes.byteLength;
    } else if (!extractorReads) {
      // Cleared once taken apart: a variable of a block would hold the bytes in the suspended
      // function until the ingest ends.
      let got: SourceRead | undefined = await readWithin(readSource(path, maxUploadBytes, { keep: true, slicer, signal }));
      size = checkedSize(name, got.size, maxUploadBytes);
      bytes = got.bytes;
      sha256 = got.sha256;
      got = undefined;
    }
    // In a function of its own, so that the text as extracted is let go once it is prepared:
    // the steps after it hold only the prepared text.
    const read = async () => {
      // What an extractor of your own reports once it has settled (from a timer, a worker) is
      // not reported: the stages after it have begun.
      let extracting = true;
      let extracted: ExtractedText;
      try {
        // Kept, so that an ingest that stops waiting for it (its time is up, its caller left)
        // keeps its turn until the extractor is done too: it still holds memory.
        const extraction = extractText(bytes ?? NO_BYTES, {
          name,
          mimeType,
          format,
          // A scan is worth storing only if its pages can be shown later: that needs the file itself.
          ...(format === "pdf" && keeps(format, byRef) && scannedPdfPages > 0 ? { scannedPages: scannedPdfPages } : {}),
          // The extractor reads the file from its path, once, within the upload limit.
          ...(extractorReads ? { path, maxUploadBytes } : {}),
          signal,
          maxTextBytes,
          maxPages: maxPdfPages,
          ...(progress ? { onProgress: (report: ExtractProgress) => { if (extracting) progress.extracted(report); } } : {}),
        }, extractors);
        work.abandoned = extraction;
        extracted = await untilAborted(extraction, signal);
        work.abandoned = undefined;
        // The bytes read from a path go once the extractor is done with them: their SHA-256 was
        // taken as they were read, and only a copy for the store needs them. (Bytes given are the
        // caller's, and are hashed next.)
        if (path !== undefined && !mayCopy) bytes = undefined;
      } finally {
        extracting = false;
      }
      progress?.end();
      // A character is at least one byte: a text this long is too large whatever it holds.
      if (extracted.text.length > maxTextBytes) throw tooMuchText(name, maxTextBytes);
      await slicer.pauseNow();
      return { pages: extracted.pages, reading: readingOf(extracted), file: fileOf(extracted), ...await prepareText(extracted.text, slicer, progress && ((done, total) => progress.report("prepare", done, total, "characters"))) };
    };
    const done = await read();
    ({ pages, reading, text, wrapped, lines } = done);
    progress?.end();
    // Bytes given are hashed once the extractor is done with them, a slice at a time: the extractor
    // is called at once at the ingest's turn, as before 0.9.0, so the ingests of one turn reach it
    // in the order they came, and the SHA-256 is that of the bytes a kept copy holds.
    if (path === undefined) sha256 = await sha256InSlices(bytes!, slicer);
    if (path !== undefined && extractorReads) {
      // What the extractor read of the file: its size and SHA-256. One that did not say is hashed
      // here, a slice at a time, and nothing of it is kept.
      let hashed = done.file;
      if (!hashed) {
        const got = await readWithin(readSource(path, maxUploadBytes, { keep: false, slicer, signal }));
        hashed = { bytes: got.size, sha256: got.sha256 };
      }
      size = checkedSize(name, hashed.bytes, maxUploadBytes);
      sha256 = hashed.sha256;
    }
    if (!text.trim()) throw new Error(`${name} did not contain any text.`);
    if (format === "text" && looksLikeLog(lines)) format = "log";
    // The bytes are let go once the text is read, unless the store keeps them.
    if (keeps(format, byRef) && !byRef) copy = bytes;
    bytes = undefined;
    measured = await measureText(text, slicer);
    if (measured.utf8 > maxTextBytes) throw tooMuchText(name, maxTextBytes);
    outline = await buildOutlineInSlices(lines, format, slicer);
    logProfile = format === "log" ? await buildLogProfileInSlices(lines, slicer) : undefined;
    quality = await measureQuality(lines, format, slicer);
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
  // Kept by its ref, or as a copy in the store, which has the bytes to write.
  const keepOriginal = byRef ? keeps(format, true) : copy !== undefined;
  // A copy: the outline's headings and the log's timestamps are pieces of the text, and a piece
  // keeps the whole text in memory as long as it is held. A meta an application kept held its
  // text: 25 MB of heap for a log of 10 MB in Hebrew, 194 MB for one of 100 MB. Copied through
  // JSON, as a store that keeps it as JSON gives it back.
  const meta: DocumentMeta = jsonCopy<DocumentMeta>({
    id: target.id ?? `doc_${randomUUID().replaceAll("-", "")}`,
    metaVersion: DOCUMENT_META_VERSION,
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    // Never sent to the model, nor in a summary. An event holds it only with eventResults: true, in
    // the full plan of run.finish and run.error.
    ...(target.scope !== undefined ? { scope: [...target.scope] } : {}),
    // Nor these: the SHA-256 of the file, and where the application keeps it.
    sha256,
    ...(keepOriginal && byRef ? { original: { ref, bytes: size, sha256 } } : {}),
    name,
    mimeType,
    format,
    bytes: size,
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
    ...quality,
    createdAt: created.toISOString(),
    // Never, for a time to live without end (or one that runs past what a date can hold).
    expiresAt: expires >= Date.parse(NEVER_EXPIRES) ? NEVER_EXPIRES : new Date(expires).toISOString(),
  });
  const savedIndex = index && canSerialize(index) && index.lineCount === meta.lines && index.characters === meta.characters && index.textBytes === meta.textBytes
    ? serializeTextIndex(index)
    : undefined;
  // Each write is reported once done. What the listener of the events throws is not the store's failure.
  const writes = (copy ? 1 : 0) + (savedIndex ? 1 : 0) + 1;
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
  // An application's ID is looked at again just before the writes: another server may have stored
  // a document under it while the file was read. Within the time the writes are given, as they are.
  const clear = target.id !== undefined
    && await settleWithin(claim(context, { ...target, id: target.id }, name), slotCapMs, () => storeTimeout(name, slotCapMs, "read"));
  // The files first, the document last: a document is there once its metadata is. Every call
  // carries the owner and scope of the document.
  const storing = (async () => {
    if (clear) {
      await store.delete(meta.id, target.context);
      forget(meta.id);
    }
    if (copy) {
      await store.putOriginal!(meta.id, copy, target.context);
      copy = undefined;
      wrote(false);
    }
    if (savedIndex) {
      await store.putIndex!(meta.id, savedIndex, target.context);
      wrote(false);
    }
    await store.put({ meta, text }, target.context);
    wrote(true);
  })();
  try {
    // A store that does not answer fails the ingest after `slotCapMs`: it held the ingest's turn,
    // and the upload handler's room for the file, for as long as it did not answer.
    await settleWithin(storing, slotCapMs, () => storeTimeout(name, slotCapMs));
  } catch (error) {
    // Do not leave a file of up to the upload limit, or a part of one, behind for a document
    // that does not exist: once the writes have ended, when they have not yet. The removal is not
    // waited for longer than the writes were. A document under the ID that is not this ingest's is
    // left alone: the ID is taken when it is another owner's or another scope's, and live.
    let taken = false;
    let ended = false;
    const remove = async () => {
      taken = await removeOwn(context, target, meta) === "taken";
    };
    const removal = storing.then(remove, remove).catch(() => undefined).then(() => {
      ended = true;
    });
    await settleWithin(removal, slotCapMs, () => new Error("")).catch(() => undefined);
    // Writes that have not ended may still land, and so may their removal: the ID stays held in this
    // library until they have, or another ingest of it could be written over, or removed. A store
    // that never answers keeps that one ID refused here.
    if (!ended) work.writes = removal;
    // What the listener of the events threw is passed on as it is, and so is a scope the store
    // cannot use: a mistake of the call, which the same call would make again.
    if (listenerFailed?.error === error || DocumentScopeError.is(error)) throw error;
    // The write failed because another document had the ID by then (a store that refuses an ID it
    // has, as an insert with a unique key does): the answer of an ID that is taken.
    if (taken) throw exists(name);
    // The store's own error may name a path, a host or a bucket: it is the cause.
    const failure = DocumentStoreError.is(error) ? error : new DocumentStoreError(error, { operation: "write" });
    noteStoreWriteFailure(failure);
    storeFailed();
    throw failure;
  }
  // A copy of an earlier document of this ID, kept in memory, is not this one.
  if (target.id !== undefined) forget(meta.id);
  // The caller left while the document was written: it is not left behind.
  if (input.signal?.aborted) await removeAbandoned(context, target, meta, work, input.signal.reason);
  return meta;
}

/** `files.ingest` of the library that `context` describes. */
export async function ingestDocument(context: IngestContext, input: IngestInput | IngestFromSource): Promise<DocumentMeta> {
  const { maxUploadBytes, ingests, slotCapMs, forget, ingesting } = context;
  // The events first, so that every ingest that throws, even on what it was given, ends with ingest.error.
  // What the caller's listener throws is passed on as it is, not told as a file that could not be read.
  let listenerFailure: { error: unknown } | undefined;
  const listener = input?.onEvent;
  const events = new EventEmitter<IngestEvent>(input?.runId ?? newRunId("ing"), listener && ((event: IngestEvent) => {
    try {
      listener(event);
    } catch (error) {
      listenerFailure ??= { error };
      throw error;
    }
  }));
  let storeFailed = false;
  /** The application's ID this ingest holds in `ingesting`, once it does. */
  let holding: string | undefined;
  const work: IngestWork = {};
  try {
    // A file at a path is looked at first, without being read, so that ingest.start gives its size.
    // The library never writes, moves or deletes it.
    let quietPath: string | undefined;
    try {
      quietPath = sourcePathOf(input);
    } catch {
      // Told once ingest.start is out.
    }
    // Given up on when the caller leaves, and failed when the volume does not answer in the time the
    // ingest's store calls are given: the ingest's own time begins at its turn.
    const stated = quietPath === undefined
      ? undefined
      : await lookWithin(statSource(quietPath), input.signal, slotCapMs, "lstat").then((size) => ({ size }), (error: unknown) => ({ size: undefined, error }));
    if (events.active) events.emit({ type: "ingest.start", ...startOf(input, stated?.size) });
    checkOwner(input.owner);
    const target = targetOf(input, context.rules);
    // The path looked at, as it was made absolute then (the working directory may have changed
    // since); checked again for an input it was not taken from, which throws here.
    const path = quietPath ?? sourcePathOf(input);
    const ref = originalRefOf(input, context.readsRefs);
    const name = cleanFileName(input.name);
    const mimeType = cleanMimeType(input.mimeType);
    // Progress is worked out only for someone who listens.
    const progress = events.active ? new IngestProgress(events) : undefined;
    let meta: DocumentMeta;
    try {
      // A path that is not there, a link or a folder: the server's trouble, passed on as it is.
      if (stated && "error" in stated) throw stated.error;
      // Refused at once, without waiting for a turn, and without reading a file at a path.
      checkedSize(name, path !== undefined ? stated!.size! : (input as IngestInput).bytes.byteLength, maxUploadBytes);
      // A file whose name and type say nothing is known by its bytes: a PDF, an Office file, a page.
      // Of a file at a path, only the parts looked at are read.
      const bytes = (input as IngestInput).bytes;
      // The parts read to tell the format are given up on, with the caller's reason, when the caller
      // leaves, and fail the ingest when they do not answer in time, as the lstat does.
      const sniffed = path !== undefined ? formatAtPath(name, mimeType, path, stated!.size!) : undefined;
      const format = sniffed ? await lookWithin(sniffed, input.signal, slotCapMs, "read") : detectFormat(name, mimeType, bytes instanceof Uint8Array ? bytes : undefined);
      if (target.id !== undefined) {
        // An ID another ingest of this library is storing: refused, whoever's it is to be.
        if (ingesting.has(target.id)) throw exists(name);
        // A caller that has already gone: nothing is held, and the store is not asked.
        input.signal?.throwIfAborted();
        ingesting.add(target.id);
        holding = target.id;
        // An application's ID that is taken, before the file is read (again before it is written):
        // within the time the writes are given, and given up on, with the caller's own reason, when
        // the caller leaves meanwhile.
        const asked = settleWithin(claim(context, { ...target, id: target.id }, name), slotCapMs, () => storeTimeout(name, slotCapMs, "read"));
        await (input.signal ? untilAborted(asked, input.signal) : asked);
      }
      // Its turn (`maxConcurrentIngests`): a caller that gives up while it waits gets its own
      // reason, as it would once the work had begun. (An ingest started inside another of this
      // library, by an extractor of your own, waits for a turn like any other. Telling it apart
      // with AsyncLocalStorage made pdf.js about five times slower on Node 22, for every PDF.)
      const slot = new IngestSlot(await ingests.acquire(input.signal), slotCapMs);
      try {
        meta = await ingestFile(context, input, target, name, mimeType, format, progress, () => (storeFailed = true), work, { path, ref });
      } finally {
        slot.end(work.abandoned);
      }
    } catch (error) {
      // A store that failed, a scope it cannot use, and a caller that gave up (its own reason), are
      // passed on as they are; a file that could not be read is told with a code.
      if (storeFailed || (input.signal?.aborted && error === input.signal.reason) || isStoreWriteFailure(error) || DocumentScopeError.is(error) || (listenerFailure && error === listenerFailure.error)) throw error;
      throw toIngestError(error);
    }
    // Once more, before the document is told stored: a caller that has left by now gets its reason.
    if (input.signal?.aborted) await removeAbandoned(context, target, meta, work, input.signal.reason);
    try {
      events.emit({ type: "ingest.finish", document: toDocumentSummary(meta) });
    } catch (error) {
      // The caller never gets the id: the document goes, as on a throw of the listener a moment
      // earlier, while it is this ingest's own. The listener's error is passed on as it is.
      await removeOwn(context, target, meta).catch(() => undefined);
      forget(meta.id);
      throw error;
    }
    return meta;
  } catch (error) {
    // A store's own error may name a host or a path, whatever it is: the event, which a browser
    // may see, says only that the document could not be stored (a DocumentStoreError, 503).
    events.emit({ type: "ingest.error", error: storeFailed ? storeWriteFailed() : eventErrorOf(error) });
    throw error;
  } finally {
    if (holding !== undefined) {
      // Once writes given up on have ended, and the removal of what they wrote (see `IngestWork`).
      const id = holding;
      if (work.writes) void work.writes.finally(() => ingesting.delete(id));
      else ingesting.delete(id);
    }
  }
}
