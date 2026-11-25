// A library whose `prepare` gives what 0.9's gave, for the tests that compare requests with those of
// 0.9 or earlier: blocks without line numbers, no `toolable`, and no mark of this package's
// `prepare`, so that `askWithFiles` adds no citation line. What `numberInline: false` with
// `inlineTables: "text"` gave in `askWithFiles` before 0.99.9 removed them.
import type { LargeFiles } from "llm-large-files";

/** `files` with a `prepare` that gives what 0.9's gave: the blocks of 0.9, no `toolable`, no mark. */
export function withPrepareOf09<T extends LargeFiles>(files: T): T {
  return {
    ...files,
    async prepare(ids, base, options) {
      const { plan, blocks, instruction, missing, viewable } = await files.prepare(ids, base, { ...options, numberInline: false, inlineTables: "text" });
      return { plan, blocks, instruction, missing, viewable };
    },
  };
}

/**
 * A library whose `prepare` is this package's, asked for tables without the tools: what
 * `inlineTables: "text"` gave in `askWithFiles` before 0.99.9 (numbered lines, the citation line,
 * no `toolable`).
 */
export function withTablesAsText<T extends LargeFiles>(files: T): T {
  return { ...files, prepare: (ids, base, options) => files.prepare(ids, base, { ...options, inlineTables: "text" }) };
}
