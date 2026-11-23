// Scopes (`DocumentScope`): where a document belongs, such as [userId, chatId]. New in 0.9.0.
import { DocumentScopeError } from "./errors.js";
import type { DocumentScope } from "./types.js";

/** The most segments a scope may have. */
export const MAX_SCOPE_SEGMENTS = 8;
/** The most UTF-16 units one segment may have. */
export const MAX_SCOPE_SEGMENT_LENGTH = 256;

/**
 * What a segment may not hold: "/" and "\" (path separators on every system), control characters
 * (NUL, line breaks, C1), and half of a surrogate pair, which has no UTF-8 form.
 */
const FORBIDDEN = /[/\\\p{Cc}\p{Cs}]/u;

const SHAPE = `scope must be an array of 1 to ${MAX_SCOPE_SEGMENTS} strings, such as [userId, chatId].`;

/**
 * A scope given to the library, checked: a frozen copy of it, or undefined when there is none.
 * Throws a `DocumentScopeError` with code "scope_invalid" unless it is an array of 1 to 8 strings,
 * each of 1 to 256 UTF-16 units, with no control characters, no "/" or "\", and none of them "." or
 * "..". The message says which segment is wrong, not what it holds: a segment may be a user's ID.
 */
export function checkScope(scope: unknown): DocumentScope | undefined {
  if (scope === undefined) return undefined;
  if (!Array.isArray(scope) || scope.length < 1 || scope.length > MAX_SCOPE_SEGMENTS) {
    throw new DocumentScopeError("scope_invalid", SHAPE);
  }
  const segments: string[] = [];
  // An index loop, not `map`: a hole in the array is a segment that is missing.
  for (let index = 0; index < scope.length; index++) {
    const segment: unknown = scope[index];
    const which = `scope segment ${index + 1}`;
    if (typeof segment !== "string" || segment.length < 1 || segment.length > MAX_SCOPE_SEGMENT_LENGTH) {
      throw new DocumentScopeError("scope_invalid", `${which} must be a string of 1 to ${MAX_SCOPE_SEGMENT_LENGTH} characters. ${SHAPE}`);
    }
    if (segment === "." || segment === "..") throw new DocumentScopeError("scope_invalid", `${which} cannot be "." or "..".`);
    if (FORBIDDEN.test(segment)) throw new DocumentScopeError("scope_invalid", `${which} cannot hold "/", "\\" or control characters.`);
    segments.push(segment);
  }
  return Object.freeze(segments);
}

/**
 * A scope as one string, to key maps and caches by: its segments, each URI-encoded, joined with
 * "/". Two scopes give the same key only when they are the same, and no scope gives "", which is
 * the key of no scope. Check the scope first (`checkScope`): a segment with half of a surrogate
 * pair cannot be encoded.
 */
export function scopeKey(scope: DocumentScope | undefined): string {
  return scope === undefined ? "" : scope.map(encodeURIComponent).join("/");
}

/**
 * Whether two scopes are the same, segment by segment. No scope is the same as no scope only; null
 * counts as no scope, as a database may give it for a field that was left out.
 */
export function sameScope(left: DocumentScope | null | undefined, right: DocumentScope | null | undefined): boolean {
  if (left === undefined || left === null || right === undefined || right === null) {
    return (left === undefined || left === null) && (right === undefined || right === null);
  }
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
