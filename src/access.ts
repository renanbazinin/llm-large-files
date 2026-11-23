// Who is asking, and what they may use: the owner and the scope of a call, the context the store is
// given for it, and the rule that decides which documents serve it. New in 0.9.0.
import { DocumentScopeError, DocumentStoreError, type DocumentStoreOperation } from "./errors.js";
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
};

/** The context of a store call: a frozen object, without the fields that are absent. */
export function storeContext(scope: DocumentScope | undefined, owner: string | undefined): DocumentContext {
  return Object.freeze({ ...(scope !== undefined ? { scope } : {}), ...(owner !== undefined ? { owner } : {}) });
}

/**
 * The caller of a call made with `access`. Null is no owner and no scope, as a database gives a
 * field that was left out. The scope is checked (`checkScope`: a `DocumentScopeError` when it is
 * not valid). Under `requireOwner`, a call without an owner, or with one that `checkOwner` refuses,
 * is a TypeError; under `requireScope`, a call without a scope.
 */
export function callerOf(access: { readonly owner?: unknown; readonly scope?: unknown } | undefined, rules: AccessRules): Caller {
  const owner = (access?.owner ?? undefined) as string | undefined;
  if (rules.requireOwner) {
    if (owner === undefined) throw new TypeError(OWNER_REQUIRED);
    checkOwner(owner);
  }
  const scope = checkScope(access?.scope ?? undefined);
  if (rules.requireScope && scope === undefined) throw new TypeError(SCOPE_REQUIRED);
  return {
    ...(owner !== undefined ? { owner } : {}),
    ...(scope !== undefined ? { scope } : {}),
    context: storeContext(scope, owner),
    key: scopeKey(scope),
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

/**
 * A call of the store. What it throws is passed on as a `DocumentStoreError` of `operation`, with
 * the store's error as `cause`: the store's own error may name a path, a host or a bucket, and a
 * store that failed is not a document that is gone. A `DocumentStoreError` is passed on as it is,
 * and so is a `DocumentScopeError`: a scope the store cannot use is a mistake of the call, and the
 * same call would fail again.
 */
export async function storeCall<T>(operation: DocumentStoreOperation, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw DocumentStoreError.is(error) || DocumentScopeError.is(error) ? error : new DocumentStoreError(error, { operation });
  }
}

/**
 * Refuses metadata written by a newer version of the package (`metaVersion` above
 * `DOCUMENT_META_VERSION`), which may mean what this version cannot tell: a `DocumentStoreError`
 * with code "NEWER_VERSION", not a document that is missing, so that an application does not
 * ingest the file again over it. Metadata without a version (before 0.9.0), or with null as a
 * database gives a field that was left out, is read as before.
 */
export function checkMetaVersion(meta: DocumentMeta): void {
  const version: unknown = meta.metaVersion ?? 0;
  if (typeof version === "number" && version <= DOCUMENT_META_VERSION) return;
  const found = new RangeError(`The metadata of ${String(meta.id)} has metaVersion ${String(version)}; this version of llm-large-files reads up to ${DOCUMENT_META_VERSION}.`);
  throw new DocumentStoreError(found, { operation: "read", code: "NEWER_VERSION" });
}
