// Planning one model request: which documents go into it whole, which become cards that the
// tools read, and the text of each. `files.prepare()` runs it. Moved out of library.ts in 0.10.0:
// the library hands it what it needs of the store and of the documents kept in memory
// (`PrepareContext`), and the options of the call as they were given. With no option new in 0.10.0,
// its blocks and its instruction are those of 0.9.
import type { AccessRules, Caller } from "./access.js";
import type { AccessOptions, PrepareOptions } from "./library.js";
import { canBeReadWhole, CARD_LINES, documentToolsInstruction, isToolable, numberedText, planDocuments, renderCard, renderInline, type WholeRead } from "./plan.js";
import { DocumentGoneError } from "./ranged.js";
import { numberLines, type DocumentSource } from "./search.js";
import type { Budget, DocumentMeta, PreparedContext } from "./types.js";

/** What planning a request needs of the library that asks for it. */
export type PrepareContext = {
  /**
   * The caller of this call, from the options it was given: its owner and scope, checked against
   * `rules`. Throws a TypeError for options the library does not accept.
   */
  callerOf(access: AccessOptions | undefined): Caller;
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

/** How the text of a document sent whole is given (`numberInline`, `inlineTables`). */
type Shape = { numbered: boolean; tables: boolean };

/** The prompt text of a document, and, for one sent whole, whether the tools can count its tables. */
type Rendered = { text: string; toolable: boolean };

/**
 * What a document contributes to the prompt: its text, or its card. Undefined when it is gone
 * by now. A copy found to disagree with the store is opened again once.
 */
async function block(context: PrepareContext, id: string, meta: DocumentMeta, caller: Caller, whole: boolean, viewable: boolean, wholeRead: WholeRead, shape: Shape): Promise<Rendered | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const document = await context.load(id, caller, attempt === 0 ? meta : undefined);
    if (!document) return undefined;
    let rendered: Rendered;
    try {
      if (whole) {
        const text = await document.readText();
        rendered = {
          text: renderInline(document.meta, shape.numbered ? numberedText(text) : text),
          toolable: shape.tables && isToolable(document.meta.format, text),
        };
      } else {
        rendered = { text: renderCard(document.meta, numberLines(await document.readLines(1, CARD_LINES), 1), viewable, wholeRead), toolable: false };
      }
    } catch (error) {
      // The text is gone while its metadata is still there (removed outside the library): the
      // same as missing. It was a plain Error, which failed the whole question.
      if (error instanceof DocumentGoneError) return undefined;
      if (document.broken) continue;
      // Deleted between the look-up and the read: the same as missing.
      if (!await context.metaFor(id, caller)) return undefined;
      throw error;
    }
    return await context.stillOpened(document, caller) ? rendered : undefined;
  }
  return undefined;
}

/** The options of 0.10.0 that shape the text, checked. */
function shapeOf(options: PrepareOptions | undefined): Shape {
  const numbered: unknown = options?.numberInline;
  if (numbered !== undefined && typeof numbered !== "boolean") throw new TypeError(`PrepareOptions.numberInline must be true or false (got ${typeof numbered}).`);
  const tables: unknown = options?.inlineTables;
  if (tables !== undefined && tables !== "tools" && tables !== "text") throw new TypeError(`PrepareOptions.inlineTables must be "tools" or "text" (got ${JSON.stringify(tables) ?? String(tables)}).`);
  return { numbered: numbered === true, tables: tables === "tools" };
}

/**
 * Plans one model request (`LargeFiles.prepare`): which documents go in whole and which become
 * searchable cards. `base` is the size of everything else in the request. `options` is what the
 * caller gave `prepare`, passed on whole.
 *
 * The options new in 0.10.0: `numberInline` numbers the lines of the documents sent whole, and
 * plans them by that size; `inlineTables: "tools"` lists in `toolable` those whose tables the tools
 * can count. Without them, the blocks, the instruction and the plan are those of 0.9.
 */
export async function prepareDocuments(context: PrepareContext, ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext> {
  const caller = context.callerOf(options);
  const budget = context.budgetFor(options?.budget);
  const analysis = options?.wholeDocumentAnalysis !== false;
  const shape = shapeOf(options);
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
    const plan = planDocuments(documents, budget, base, { numbered: shape.numbered });
    const inline = new Set(plan.inline.map((meta) => meta.id));
    // Pages can be shown for a PDF whose file is kept, whether its text is in the prompt or searched.
    const viewable = options?.viewPages ? documents.filter((meta) => context.viewableMeta(meta)) : [];
    const shown = new Set(viewable.map((meta) => meta.id));
    const blocks = new Map<string, string>();
    const toolableIds = new Set<string>();
    const gone: string[] = [];
    for (const meta of documents) {
      const whole = inline.has(meta.id);
      const wholeRead = !analysis ? "not_offered" : canBeReadWhole(meta, budget) ? "offered" : "too_large";
      const rendered = await block(context, meta.id, meta, caller, whole, shown.has(meta.id), wholeRead, shape);
      if (rendered === undefined) {
        gone.push(meta.id);
        continue;
      }
      blocks.set(meta.id, rendered.text);
      if (whole && rendered.toolable) toolableIds.add(meta.id);
    }
    if (gone.length > 0) {
      missing.push(...gone);
      documents = documents.filter((meta) => !gone.includes(meta.id));
      continue;
    }
    // A whole-document read is named only when the tools have it, and one of the files is
    // small enough for it.
    const wholeReads = analysis && plan.searchable.some((meta) => canBeReadWhole(meta, budget));
    return {
      plan,
      blocks,
      instruction: documentToolsInstruction(plan.searchable, viewable, wholeReads),
      missing,
      viewable,
      ...(shape.tables ? { toolable: plan.inline.filter((meta) => toolableIds.has(meta.id)) } : {}),
    };
  }
}
