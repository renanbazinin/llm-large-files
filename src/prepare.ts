// Planning one model request: which documents go into it whole, which become cards that the
// tools read, and the text of each. `files.prepare()` runs it. Moved out of library.ts in 0.10.0,
// with no change to what it does: the library hands it what it needs of the store and of the
// documents kept in memory (`PrepareContext`), and the options of the call as they were given.
import { callerOf, type AccessRules, type Caller } from "./access.js";
import type { PrepareOptions } from "./library.js";
import { canBeReadWhole, CARD_LINES, documentToolsInstruction, planDocuments, renderCard, renderInline, type WholeRead } from "./plan.js";
import { DocumentGoneError } from "./ranged.js";
import { numberLines, type DocumentSource } from "./search.js";
import type { Budget, DocumentMeta, PreparedContext } from "./types.js";

/** What planning a request needs of the library that asks for it. */
export type PrepareContext = {
  /** The document, when `caller` may use it: one of another owner or scope is missing, not forbidden. */
  metaFor(id: string, caller: Caller): Promise<DocumentMeta | undefined>;
  /** A document ready to read and search, for `caller`. `known` is metadata just read from the store and checked. */
  load(id: string, caller: Caller, known?: DocumentMeta): Promise<DocumentSource | undefined>;
  /** Whether `document`, which a call of `caller` has just read, is still the one the store describes. */
  stillOpened(document: DocumentSource, caller: Caller): Promise<boolean>;
  /** The budget of one request: the library's, with `overrides` in place of its fields. */
  budgetFor(overrides?: Partial<Budget>): Budget;
  /** Whether `view_pages` can show the pages of a document: a PDF whose original is kept, and can be read. */
  viewableMeta(meta: DocumentMeta): boolean;
  /** What the library requires of every call (`requireOwner`, `requireScope`). */
  rules: AccessRules;
};

/**
 * What a document contributes to the prompt: its text, or its card. Undefined when it is gone
 * by now. A copy found to disagree with the store is opened again once.
 */
async function block(context: PrepareContext, id: string, meta: DocumentMeta, caller: Caller, whole: boolean, viewable: boolean, wholeRead: WholeRead): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const document = await context.load(id, caller, attempt === 0 ? meta : undefined);
    if (!document) return undefined;
    let text: string;
    try {
      text = whole
        ? renderInline(document.meta, await document.readText())
        : renderCard(document.meta, numberLines(await document.readLines(1, CARD_LINES), 1), viewable, wholeRead);
    } catch (error) {
      // The text is gone while its metadata is still there (removed outside the library): the
      // same as missing. It was a plain Error, which failed the whole question.
      if (error instanceof DocumentGoneError) return undefined;
      if (document.broken) continue;
      // Deleted between the look-up and the read: the same as missing.
      if (!await context.metaFor(id, caller)) return undefined;
      throw error;
    }
    return await context.stillOpened(document, caller) ? text : undefined;
  }
  return undefined;
}

/**
 * Plans one model request (`LargeFiles.prepare`): which documents go in whole and which become
 * searchable cards. `base` is the size of everything else in the request. `options` is what the
 * caller gave `prepare`, passed on whole.
 */
export async function prepareDocuments(context: PrepareContext, ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext> {
  const caller = callerOf(options, context.rules);
  const budget = context.budgetFor(options?.budget);
  const analysis = options?.wholeDocumentAnalysis !== false;
  const unique = [...new Set(ids)];
  let documents: DocumentMeta[] = [];
  const missing: string[] = [];
  for (const id of unique) {
    // A document of another owner or scope is reported as missing, not as forbidden, and is
    // not read at all.
    const meta = await context.metaFor(id, caller);
    if (meta) documents.push(meta);
    else missing.push(id);
  }
  // Planning needs only the metadata. The text is read for the documents sent whole, and the
  // first lines for the others. One that is gone by then is missing, and the plan is made again.
  for (;;) {
    const plan = planDocuments(documents, budget, base);
    const inline = new Set(plan.inline.map((meta) => meta.id));
    // Pages can be shown for a PDF whose file is kept, whether its text is in the prompt or searched.
    const viewable = options?.viewPages ? documents.filter((meta) => context.viewableMeta(meta)) : [];
    const shown = new Set(viewable.map((meta) => meta.id));
    const blocks = new Map<string, string>();
    const gone: string[] = [];
    for (const meta of documents) {
      const wholeRead = !analysis ? "not_offered" : canBeReadWhole(meta, budget) ? "offered" : "too_large";
      const text = await block(context, meta.id, meta, caller, inline.has(meta.id), shown.has(meta.id), wholeRead);
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
}
