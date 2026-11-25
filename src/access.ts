// Who is asking, and what they may use: the owner and the scope of a call, the context the store is
// given for it, and the rule that decides which documents serve it. New in 0.9.0.
import { DocumentScopeError, DocumentStoreError, type DocumentStoreOperation } from "./errors.js";
import { until } from "./http.js";
import { checkScope, sameScope, scopeKey } from "./scope.js";
import { DOCUMENT_META_VERSION } from "./stores.js";
import type { DocumentContext, DocumentMeta, DocumentScope } from "./types.js";

/** The TypeError of a call without an owner, when the library requires one (`requireOwner`). */
export const OWNER_REQUIRED = "owner is required: requireOwner is on";
/** The TypeError of a call without a scope, when the library requires one (`requireScope`). */
export const SCOPE_REQUIRED = "scope is required: requireScope is on";

/**
 * Refuses an owner that every caller without a user would share: an empty string (what
 * `user?.id ?? ""` gives), one of spaces only, or null. Undefined is no owner. A number is let
 * through, as before, for JavaScript code that passes numeric user IDs.
 */
export function checkOwner(owner: unknown): void {
  if (owner === undefined || (typeof owner === "string" && owner.trim() !== "") || (typeof owner === "number" && Number.isFinite(owner))) return;
  throw new TypeError("owner must be a string that is not empty or only spaces, such as the signed-in user's ID. To let anyone with the document's ID use it, leave owner out.");
}

/** What a library requires of every call (`LargeFilesOptions.requireOwner` and `requireScope`). */
export type AccessRules = { readonly requireOwner: boolean; readonly requireScope: boolean };

/** A caller, checked: its owner, its scope (a frozen copy), and what the store calls made for it carry. */
export type Caller = {
  readonly owner?: string;
  readonly scope?: DocumentScope;
  /** The context of the store calls made for this caller. */
  readonly context: DocumentContext;
  /** The key of the scope (`scopeKey`): what this caller's copies of documents are kept under in memory. */
  readonly key: string;
  /**
   * Ends this caller's waits for the store (`AccessOptions.signal`), with its reason: never a store
   * call that other callers wait on too. New in 0.10.0.
   */
  readonly signal?: AbortSignal;
};

/** The context of a store call: a frozen object, without the fields that are absent. */
export function storeContext(scope: DocumentScope | undefined, owner: string | undefined): DocumentContext {
  return Object.freeze({ ...(scope !== undefined ? { scope } : {}), ...(owner !== undefined ? { owner } : {}) });
}

/**
 * The caller of a call made with `access`. Null is no owner and no scope, as a database gives a
 * field that was left out. The scope is checked (`checkScope`: a `DocumentScopeError` when it is
 * not valid). Under `requireOwner`, a call without an owner, or with one that `checkOwner` refuses,
 * is a TypeError; under `requireScope`, a call without a scope. A `signal` that is not an
 * `AbortSignal` is a TypeError (0.10.0).
 */
export function callerOf(access: { readonly owner?: unknown; readonly scope?: unknown; readonly signal?: unknown } | undefined, rules: AccessRules): Caller {
  const owner = (access?.owner ?? undefined) as string | undefined;
  if (rules.requireOwner) {
    if (owner === undefined) throw new TypeError(OWNER_REQUIRED);
    checkOwner(owner);
  }
  const scope = checkScope(access?.scope ?? undefined);
  if (rules.requireScope && scope === undefined) throw new TypeError(SCOPE_REQUIRED);
  const signal: unknown = access?.signal ?? undefined;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
  return {
    ...(owner !== undefined ? { owner } : {}),
    ...(scope !== undefined ? { scope } : {}),
    context: storeContext(scope, owner),
    key: scopeKey(scope),
    ...(signal !== undefined ? { signal } : {}),
  };
}

/**
 * Whether `caller` may use the document `meta` describes. A document with an owner serves only that
 * owner, and one with a scope only a caller of the same scope, segment by segment. A document
 * without an owner serves any caller, unless the library requires owners; the same for scopes.
 * Null is no owner and no scope, as a database gives a field that was left out. A refusal is never
 * told: the document reads as missing.
 */
export function mayUse(meta: DocumentMeta, caller: Caller, rules: AccessRules): boolean {
  const owner: unknown = meta.owner ?? undefined;
  if (owner === undefined ? rules.requireOwner : owner !== caller.owner) return false;
  const scope: unknown = meta.scope ?? undefined;
  if (scope === undefined) return !rules.requireScope;
  // A scope that is not a list of segments (damaged, or written by hand) serves nobody.
  return Array.isArray(scope) && sameScope(scope as string[], caller.scope);
}

/**
 * Whether the document `found` has exactly this owner and this scope: no owner is the same as no
 * owner only, and so for scopes. An owner or a scope of null counts as none. A scope that is not a
 * list of segments (damaged, or written by hand) is nobody's.
 */
export function heldBy(found: DocumentMeta, owner: string | undefined, scope: DocumentScope | undefined): boolean {
  const theirs: unknown = found.scope ?? undefined;
  if ((found.owner ?? undefined) !== owner) return false;
  return theirs === undefined ? scope === undefined : Array.isArray(theirs) && sameScope(theirs as string[], scope);
}

/**
 * The context of the reads of a document's text (`get`, `readTextRange`, `getIndex`, and `putIndex`
 * when its index is built again), once `caller` may use it (`mayUse`): the caller's scope, where
 * `getMeta` found the document, and the owner only when the document has one. The copy kept in memory
 * is kept under the caller's scope, and shared by every caller of it, whose owners differ when the
 * document has none: so its reads carry one context whoever makes them. A document whose metadata
 * has no scope (one of 0.8, moved into a scope) is still read in the scope it was found in. The
 * owner sent is the caller's, which `mayUse` found the same as the document's; it is left out when
 * the document has none.
 */
export function documentContext(meta: DocumentMeta, caller: Caller): DocumentContext {
  return storeContext(caller.scope, (meta.owner ?? undefined) === undefined ? undefined : caller.owner);
}

/**
 * The metadata a store gave for `id`, when it is that of `id`: metadata of another document (a
 * store that looked up the wrong one) is none. An owner or a scope of null, as a database gives a
 * field that was left out, is left out.
 */
export function metaOf(found: DocumentMeta | undefined, id: string): DocumentMeta | undefined {
  if (typeof found !== "object" || found === null || found.id !== id) return undefined;
  const { owner, scope } = found as { owner?: unknown; scope?: unknown };
  if (owner !== null && scope !== null) return found;
  const { owner: _owner, scope: _scope, ...rest } = found;
  return { ...rest, ...(owner !== null && owner !== undefined ? { owner: owner as string } : {}), ...(scope !== null && scope !== undefined ? { scope: scope as string[] } : {}) };
}

/** The longest a Node.js timer waits: a longer time limit is no limit. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** Whether `ms` is a time limit a timer can keep: 0, and a time past what a timer can wait, are none. */
export const isTimeLimit = (ms: number): boolean => ms > 0 && ms <= LONGEST_TIMER_MS;

/** A time limit in the words of a message: "500 ms", "30 s", "2 min". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 120_000) return `${Number((ms / 1_000).toFixed(1))} s`;
  return `${Number((ms / 60_000).toFixed(1))} min`;
}

/**
 * The calls of this process that ran past their time limit and have not settled. One count for
 * every library, and for every copy of the package (two versions side by side, or one bundled):
 * the calls of a process share one pool of threads (libuv's, `UV_THREADPOOL_SIZE`), and a call
 * that does not answer holds one of them. New in 0.10.0.
 */
const STUCK = Symbol.for("llm-large-files.stuckCalls");
const stuck = (() => {
  const shared = globalThis as typeof globalThis & { [STUCK]?: { count: number } };
  const found = shared[STUCK];
  if (typeof found === "object" && found !== null && typeof found.count === "number") return found;
  return (shared[STUCK] = { count: 0 });
})();

/** Store calls of this process past their time limit that have not settled, and calls to the disk of the upload handlers. New in 0.10.0. */
export function stuckCalls(): number {
  return stuck.count;
}

/**
 * Counts `call` as stuck once it has run `ms` without settling, until it settles: whether or not
 * anyone still waits for it. A call that settles within `ms` never counts, and nothing counts
 * without a time limit (`isTimeLimit`). `late` is called when it passes `ms`. Returns `call`.
 * New in 0.10.0.
 */
export function watchStuck<T>(call: Promise<T>, ms: number, late?: () => void): Promise<T> {
  if (!isTimeLimit(ms)) return call;
  let counted = false;
  // The timer keeps the process alive: a call that never ends may hold nothing that does, and a
  // caller that waits on it would be lost.
  const timer = setTimeout(() => {
    counted = true;
    stuck.count++;
    late?.();
  }, ms);
  const settle = () => {
    clearTimeout(timer);
    if (counted) stuck.count--;
  };
  call.then(settle, settle);
  return call;
}

/** The time limit of a store call, and the limit on calls left stuck, of one library (`storeTimeoutMs`, `maxStuckStoreCalls`). New in 0.10.0. */
export type StoreCallOptions = {
  /** The most time the call may take, in milliseconds. 0, or a time past what a timer can wait, sets none. */
  timeoutMs?: number;
  /**
   * While this many calls of the process are stuck (`stuckCalls`), the call is refused at once, with
   * a `DocumentStoreError` of code "STORE_STUCK", and the store is not called. Defaults to no limit.
   */
  maxStuck?: number;
  /** Whether the call counts as stuck once past `timeoutMs`. Defaults to true; false for a sweep. */
  counts?: boolean;
  /** Ends the caller's wait with its reason. The call itself goes on: a store call cannot be stopped. */
  signal?: AbortSignal;
};

/** Refuses a call of `operation` while `maxStuck` calls of the process are stuck: the store is not answering. New in 0.10.0. */
export function checkStuck(operation: DocumentStoreOperation, maxStuck: number): void {
  if (stuck.count < maxStuck) return;
  const found = Object.assign(new Error(`${stuck.count} store calls of this process ran past their time limit and have not ended (the limit is ${maxStuck}): the store is not answering.`), { code: "STORE_STUCK" });
  throw new DocumentStoreError(found, { operation, code: "STORE_STUCK" });
}

/** A store call that did not end within `ms`. */
export const storeTimeout = (operation: DocumentStoreOperation, ms: number) => new DocumentStoreError(
  Object.assign(new Error(`The store did not answer within ${formatDuration(ms)}.`), { code: "ETIMEDOUT" }),
  { operation, code: "ETIMEDOUT" },
);

/**
 * A call of the store. What it throws is passed on as a `DocumentStoreError` of `operation`, with
 * the store's error as `cause`: the store's own error may name a path, a host or a bucket, and a
 * store that failed is not a document that is gone. A `DocumentStoreError` is passed on as it is,
 * and so is a `DocumentScopeError`: a scope the store cannot use is a mistake of the call, and the
 * same call would fail again.
 *
 * New in 0.10.0, `options`: a call that does not end within `timeoutMs` is a `DocumentStoreError`
 * of code "ETIMEDOUT", and counts as stuck until it ends; while `maxStuck` calls are stuck, it is
 * refused at once ("STORE_STUCK"); `signal` ends the caller's wait with its reason, as it is.
 */
export async function storeCall<T>(operation: DocumentStoreOperation, call: () => Promise<T>, options: StoreCallOptions = {}): Promise<T> {
  const { timeoutMs = 0, maxStuck = Number.POSITIVE_INFINITY, counts = true, signal } = options;
  checkStuck(operation, maxStuck);
  // A caller that has left starts no call. (Its signal may be an object made like an AbortSignal,
  // which `ToolOptions.signal` takes as before 0.10.0.)
  if (signal?.aborted) throw signal.reason;
  let running: Promise<T>;
  try {
    running = Promise.resolve(call());
  } catch (error) {
    running = Promise.reject(error);
  }
  let waited: Promise<T> = running;
  if (isTimeLimit(timeoutMs)) {
    waited = new Promise<T>((resolve, reject) => {
      const late = () => reject(storeTimeout(operation, timeoutMs));
      if (counts) watchStuck(running, timeoutMs, late);
      else {
        const timer = setTimeout(late, timeoutMs);
        const settle = () => clearTimeout(timer);
        running.then(settle, settle);
      }
      running.then(resolve, reject);
    });
  }
  try {
    return await until(waited, signal);
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    throw DocumentStoreError.is(error) || DocumentScopeError.is(error) ? error : new DocumentStoreError(error, { operation });
  }
}

/**
 * Whether stored metadata is of a version this package reads (H7): no metaVersion (before 0.9.0),
 * null, or a number up to `DOCUMENT_META_VERSION`. NaN, a higher number and anything not a number
 * are not. The one test of `checkMetaVersion`, `files.list` and ingest's `dedupe` look-up. Internal:
 * not exported from an entry point. New in 0.99.9.
 */
export function readableMetaVersion(meta: Pick<DocumentMeta, "metaVersion">): boolean {
  const version: unknown = meta.metaVersion ?? 0;
  return typeof version === "number" && version <= DOCUMENT_META_VERSION;
}

/**
 * Refuses metadata written by a newer version of the package (`metaVersion` above
 * `DOCUMENT_META_VERSION`), which may mean what this version cannot tell: a `DocumentStoreError`
 * with code "NEWER_VERSION", not a document that is missing, so that an application does not
 * ingest the file again over it. Metadata without a version (before 0.9.0), or with null as a
 * database gives a field that was left out, is read as before.
 */
export function checkMetaVersion(meta: DocumentMeta): void {
  if (readableMetaVersion(meta)) return;
  const version: unknown = meta.metaVersion;
  const found = new RangeError(`The metadata of ${String(meta.id)} has metaVersion ${String(version)}; this version of llm-large-files reads up to ${DOCUMENT_META_VERSION}.`);
  throw new DocumentStoreError(found, { operation: "read", code: "NEWER_VERSION" });
}
