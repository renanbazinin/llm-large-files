// The version of a document as a source and a preview name it: opaque, and stable for one version.
// New in 0.99.14.
import { createHmac } from "node:crypto";
import { documentVersion } from "./cache.js";
import type { DocumentMeta } from "./types.js";

/**
 * The version token of `meta`: 16 hex digits of an HMAC-SHA-256 of `documentVersion(meta)`, keyed
 * with the SHA-256 of the uploaded file (a field that stays on the server), so that it cannot be
 * worked out from a known upload time. It never holds the owner, scope or date of the document, and
 * changes when a document is stored again under the same ID. A document without a SHA-256 (stored
 * before 0.9.0) is keyed with its ID.
 */
export function versionToken(meta: DocumentMeta): string {
  const key = typeof meta.sha256 === "string" && meta.sha256 ? meta.sha256 : `id:${meta.id}`;
  return createHmac("sha256", key).update(documentVersion(meta)).digest("hex").slice(0, 16);
}
