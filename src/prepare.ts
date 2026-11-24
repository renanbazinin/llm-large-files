// Planning one model request: which documents go into it whole, which become cards that the
// tools read, and the text of each. `files.prepare()` runs it. Moved out of library.ts in 0.10.0:
// the library hands it what it needs of the store and of the documents kept in memory
// (`PrepareContext`), and the options of the call as they were given. With no option new in 0.10.0,
// its blocks and its instruction are those of 0.9.
import type { AccessRules, Caller } from "./access.js";
import type { AccessOptions, PrepareOptions } from "./library.js";
import {
  canBeReadWhole,
  CARD_LINES,
  documentToolsInstruction,
  inlineSize,
  isToolable,
  numberedText,
  planDocuments,
  REQUEST_BYTES_MARGIN,
  renderCard,
  renderInline,
  type WholeRead,
} from "./plan.js";
import { DocumentGoneError } from "./ranged.js";
import { numberLines, type DocumentSource } from "./search.js";
import { estimateTokens, jsonBytes } from "./text.js";
import type { Budget, DocumentMeta, PreparedContext } from "./types.js";

/**
 * The mark of a `PreparedContext` that this package's `prepare` made (since 0.10.0): its blocks
 * have numbered lines when `numberInline` asks for them. `askWithFiles` numbers the citations of
 * the files sent whole only for a context with the mark. A `LargeFiles` of your own that returns
 * the result of this package's `prepare`, or a copy of it made with spread, keeps it; one of 0.9
 * has none, and its blocks are sent as they are. A registered symbol, so that another copy of the
 * package knows it too. It is not part of the public types.
 */
export const PREPARED_HERE = Symbol.for("llm-large-files.prepared");

/** Whether `prepared` was made by this package's `prepare` (`PREPARED_HERE`). */
export const preparedHere = (prepared: PreparedContext): boolean => (prepared as Marked)[PREPARED_HERE] === true;

/** A `PreparedContext` with the mark of this package's `prepare`. */
type Marked = PreparedContext & { [PREPARED_HERE]?: true };

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

type Size = { tokens: number; bytes: number };

/** How the text of a document sent whole is given (`numberInline`, `inlineTables`). */
type Shape = { numbered: boolean; tables: boolean };

/**
 * The prompt text of a document, and, for one sent whole, whether the tools can count its tables,
 * and the size of its numbered text with 200 bytes for its frame (`numberInline`).
 */
type Rendered = { text: string; toolable: boolean; size?: Size };

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
        const numbered = shape.numbered ? numberedText(text) : undefined;
        // A table the tools count has its document_id in its frame: the tools take it.
        const toolable = shape.tables && isToolable(document.meta.format, text);
        rendered = {
          text: renderInline(document.meta, numbered ?? text, toolable),
          toolable,
          ...(numbered !== undefined ? { size: { tokens: estimateTokens(numbered), bytes: jsonBytes(numbered) + 200 } } : {}),
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

const sum = (sizes: Iterable<Size>): Size => {
  const total = { tokens: 0, bytes: 0 };
  for (const size of sizes) {
    total.tokens += size.tokens;
    total.bytes += size.bytes;
  }
  return total;
};

/** How many times planning is made again when the request it planned does not fit. */
const MOST_EXTRA_PLANS = 6;

/** A plan and what goes with it. */
type Planned = Omit<PreparedContext, "missing">;

/**
 * Plans one model request (`LargeFiles.prepare`): which documents go in whole and which become
 * searchable cards. `base` is the size of everything else in the request. `options` is what the
 * caller gave `prepare`, passed on whole.
 *
 * The options new in 0.10.0: `numberInline` numbers the lines of the documents sent whole, and
 * plans them by that size; `inlineTables: "tools"` lists in `toolable` those whose tables the tools
 * can count. Without them, the blocks, the instruction and the plan are those of 0.9. The result
 * always has the mark of this package (`PREPARED_HERE`).
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
  // Pages can be shown for a PDF whose file is kept, whether its text is in the prompt or searched.
  const viewableOf = () => (options?.viewPages ? documents.filter((meta) => context.viewableMeta(meta)) : []);
  // With `numberInline`, the blocks read so far, by kind and ID: a plan made again reads each
  // block once. Without it, the reads of 0.9.
  const read = shape.numbered ? new Map<string, Rendered>() : undefined;
  const render = async (meta: DocumentMeta, whole: boolean, viewable: boolean): Promise<Rendered | undefined> => {
    const key = `${whole ? "whole" : "card"} ${meta.id}`;
    const known = read?.get(key);
    if (known) return known;
    const wholeRead = !analysis ? "not_offered" : canBeReadWhole(meta, budget) ? "offered" : "too_large";
    const rendered = await block(context, meta.id, meta, caller, whole, viewable, wholeRead, shape);
    if (rendered) read?.set(key, rendered);
    return rendered;
  };
  // What the request may hold of the documents.
  const limit: Size = {
    tokens: budget.contextTokens - budget.reservedTokens - base.tokens,
    bytes: budget.maxRequestBytes - REQUEST_BYTES_MARGIN - base.bytes,
  };
  // With `numberInline`, the size of the numbered text of each document read whole so far.
  const measured = new Map<string, Size>();
  /** How far a plan is over the room it has: 0 when it fits. */
  const excessOf = (planned: Planned): number => {
    const whole = { tokens: planned.plan.inlineTokens, bytes: planned.plan.inlineBytes };
    const tokens = Math.max(0, whole.tokens - limit.tokens, whole.tokens - budget.inlineTokens);
    const bytes = Math.max(0, whole.bytes - limit.bytes);
    return tokens / Math.max(1, budget.contextTokens) + bytes / Math.max(1, budget.maxRequestBytes);
  };
  const finish = ({ plan, blocks, instruction, viewable, toolable }: Planned): Marked => ({
    plan,
    blocks,
    instruction,
    missing,
    viewable,
    ...(toolable ? { toolable } : {}),
    [PREPARED_HERE]: true,
  });
  let extraPlans = 0;
  let best: { planned: Planned; excess: number } | undefined;
  // Planning needs only the metadata. The text is read for the documents sent whole, and the
  // first lines for the others. One that is gone by then is missing, and the plan is made again.
  for (;;) {
    const plan = planDocuments(documents, budget, base, {
      numbered: shape.numbered,
      ...(measured.size > 0 ? { measured } : {}),
    });
    const inline = new Set(plan.inline.map((meta) => meta.id));
    const viewable = viewableOf();
    const shown = new Set(viewable.map((meta) => meta.id));
    const blocks = new Map<string, string>();
    const toolableIds = new Set<string>();
    const gone: string[] = [];
    for (const meta of documents) {
      const whole = inline.has(meta.id);
      const rendered = await render(meta, whole, shown.has(meta.id));
      if (rendered === undefined) {
        gone.push(meta.id);
        continue;
      }
      blocks.set(meta.id, rendered.text);
      if (whole && rendered.toolable) toolableIds.add(meta.id);
      if (whole && rendered.size) measured.set(meta.id, rendered.size);
    }
    if (gone.length > 0) {
      missing.push(...gone);
      documents = documents.filter((meta) => !gone.includes(meta.id));
      best = undefined;
      continue;
    }
    // A whole-document read is named only when the tools have it, and one of the files is
    // small enough for it.
    const wholeReads = analysis && plan.searchable.some((meta) => canBeReadWhole(meta, budget));
    const toolable = shape.tables ? plan.inline.filter((meta) => toolableIds.has(meta.id)) : undefined;
    // The numbered text is counted as it was measured, where that is larger than its estimate.
    const counted = shape.numbered ? sum(plan.inline.map((meta) => inlineSize(meta, true, measured.get(meta.id)))) : undefined;
    const planned: Planned = {
      plan: counted ? { ...plan, inlineTokens: counted.tokens, inlineBytes: counted.bytes } : plan,
      blocks,
      instruction: documentToolsInstruction(plan.searchable, viewable, wholeReads),
      viewable,
      ...(toolable ? { toolable } : {}),
    };
    // Without `numberInline`, the plan of 0.9: the cards are the caller's to count.
    if (!shape.numbered) return finish(planned);
    // A plan that does not fit is made again with the numbered text as measured. A plan made
    // again that is no nearer to fitting is not used, and the nearest is.
    const excess = excessOf(planned);
    if (excess === 0) return finish(planned);
    if (best && excess >= best.excess) return finish(best.planned);
    best = { planned, excess };
    if (extraPlans >= MOST_EXTRA_PLANS) return finish(planned);
    extraPlans++;
  }
}
