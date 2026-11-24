// Planning one model request: which documents go into it whole, which become cards that the
// tools read, and the text of each. `files.prepare()` runs it. Moved out of library.ts in 0.10.0:
// the library hands it what it needs of the store and of the documents kept in memory
// (`PrepareContext`), and the options of the call as they were given. With no option new in 0.10.0,
// its blocks and its instruction are those of 0.9.
import type { AccessRules, Caller } from "./access.js";
import type { AccessOptions, PrepareOptions } from "./library.js";
import { checkedPlacement, nextPlacement } from "./placement.js";
import {
  canBeReadWhole,
  CARD_LINES,
  documentToolsInstruction,
  isToolable,
  listingLine,
  numberedText,
  planDocuments,
  questionTools,
  renderCard,
  renderInline,
  renderListing,
  toolGuide,
  toolsInOrder,
  type WholeRead,
} from "./plan.js";
import { DocumentGoneError } from "./ranged.js";
import { numberLines, type DocumentSource } from "./search.js";
import { estimateTokens, jsonBytes } from "./text.js";
import type { Budget, DocumentMeta, PlacementState, PreparedContext } from "./types.js";

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

/** `PrepareOptions.reserve` checked: undefined when it is not given. */
function reserveOf(value: unknown): Size | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw new TypeError("PrepareOptions.reserve must be an object: { tokens, bytes }.");
  const { tokens, bytes } = value as { tokens?: unknown; bytes?: unknown };
  for (const [name, size] of [["tokens", tokens], ["bytes", bytes]] as const) {
    if (typeof size !== "number" || Number.isNaN(size) || size < 0) throw new RangeError(`PrepareOptions.reserve.${name} must be a number of 0 or more (got ${String(size)}).`);
  }
  return { tokens: tokens as number, bytes: bytes as number };
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
 * The header line of each document (`PreparedContext.listing`), in the order of `documents`. A
 * document whose name an earlier document of the question has (by `createdAt`, then by place in
 * `documents`) says that it replaces the latest of them.
 */
function listingOf(documents: DocumentMeta[], inline: Set<string>, viewable: Set<string>): Map<string, string> {
  const nameKey = (meta: DocumentMeta) => meta.name.normalize("NFC");
  const order = new Map(documents.map((meta, index) => [meta.id, index]));
  const earlier = (left: DocumentMeta, right: DocumentMeta) => (left.createdAt === right.createdAt ? order.get(left.id)! < order.get(right.id)! : left.createdAt < right.createdAt);
  const listing = new Map<string, string>();
  for (const meta of documents) {
    let replaces: DocumentMeta | undefined;
    for (const other of documents) {
      if (other.id === meta.id || nameKey(other) !== nameKey(meta) || !earlier(other, meta)) continue;
      if (!replaces || earlier(replaces, other)) replaces = other;
    }
    listing.set(meta.id, listingLine(meta, { inline: inline.has(meta.id), viewable: viewable.has(meta.id), ...(replaces ? { replaces: replaces.id } : {}) }));
  }
  return listing;
}

/** The size of a text in a request, as `askWithFiles` counts the text it sends. */
const sizeOf = (text: string): Size => (text ? { tokens: estimateTokens(text), bytes: jsonBytes(text) } : { tokens: 0, bytes: 0 });

/** How many times planning is made again for the cards, header and guide it found it needs room for. */
const MOST_EXTRA_PLANS = 6;

/**
 * Plans one model request (`LargeFiles.prepare`): which documents go in whole and which become
 * searchable cards. `base` is the size of everything else in the request. `options` is what the
 * caller gave `prepare`, passed on whole.
 *
 * The options new in 0.10.0: `numberInline` numbers the lines of the documents sent whole, and
 * plans them by that size; `inlineTables: "tools"` lists in `toolable` those whose tables the tools
 * can count; `placement` keeps each document where an earlier question of the chat placed it;
 * `reserve` keeps room free for the tool declarations, and has planning count the cards, the header
 * lines and the guide at their size. Without them, the blocks, the instruction and the plan are
 * those of 0.9. `guide`, `listing` and `placement` are always given.
 */
export async function prepareDocuments(context: PrepareContext, ids: string[], base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext> {
  const caller = context.callerOf(options);
  const budget = context.budgetFor(options?.budget);
  const analysis = options?.wholeDocumentAnalysis !== false;
  const shape = shapeOf(options);
  const reserve = reserveOf(options?.reserve);
  // A state of another version, or of another shape, is not used: the question is planned afresh.
  const given = options?.placement === undefined ? undefined : checkedPlacement(options.placement);
  const head: unknown = (options?.placement as { head?: unknown } | undefined)?.head;
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
  // With `reserve`, what planning found the cards, the header and the guide need, and the blocks
  // read so far: a plan made again for them reads each block once.
  let extra: Size = { tokens: 0, bytes: 0 };
  let extraPlans = 0;
  const read = reserve ? new Map<string, Rendered>() : undefined;
  // Planning needs only the metadata. The text is read for the documents sent whole, and the
  // first lines for the others. One that is gone by then is missing, and the plan is made again.
  for (;;) {
    const room = reserve ? { tokens: base.tokens + reserve.tokens + extra.tokens, bytes: base.bytes + reserve.bytes + extra.bytes } : base;
    const plan = planDocuments(documents, budget, room, { numbered: shape.numbered, ...(given ? { pinned: given.inline, cards: given.cards } : {}) });
    const inline = new Set(plan.inline.map((meta) => meta.id));
    // Pages can be shown for a PDF whose file is kept, whether its text is in the prompt or searched.
    const viewable = options?.viewPages ? documents.filter((meta) => context.viewableMeta(meta)) : [];
    const shown = new Set(viewable.map((meta) => meta.id));
    const blocks = new Map<string, string>();
    const toolableIds = new Set<string>();
    const gone: string[] = [];
    for (const meta of documents) {
      const whole = inline.has(meta.id);
      const key = `${whole ? "whole" : "card"} ${meta.id}`;
      let rendered = read?.get(key);
      if (!rendered) {
        const wholeRead = !analysis ? "not_offered" : canBeReadWhole(meta, budget) ? "offered" : "too_large";
        rendered = await block(context, meta.id, meta, caller, whole, shown.has(meta.id), wholeRead, shape);
        if (rendered) read?.set(key, rendered);
      }
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
    const toolable = shape.tables ? plan.inline.filter((meta) => toolableIds.has(meta.id)) : undefined;
    // The tools declared: those of earlier questions of the chat, and those this one needs.
    const tools = toolsInOrder([...given?.tools ?? [], ...questionTools({ searchable: plan.searchable, ...(toolable ? { toolable } : {}), viewable }, wholeReads)]);
    const guide = toolGuide(tools, { fullTables: shape.tables, numberedInline: shape.numbered && plan.inline.length > 0 });
    const listing = listingOf(documents, inline, shown);
    if (reserve && extraPlans < MOST_EXTRA_PLANS) {
      // The cards, the header and the guide, at the size they have: when they need more room than
      // the plan left them, it is made again with that room kept.
      const needed = [guide, renderListing([...listing.values()]), ...plan.searchable.map((meta) => blocks.get(meta.id)!)].map(sizeOf)
        .reduce((sum, size) => ({ tokens: sum.tokens + size.tokens, bytes: sum.bytes + size.bytes }), { tokens: 0, bytes: 0 });
      if (needed.tokens > extra.tokens || needed.bytes > extra.bytes) {
        extra = { tokens: Math.max(extra.tokens, needed.tokens), bytes: Math.max(extra.bytes, needed.bytes) };
        extraPlans++;
        continue;
      }
    }
    const placement: PlacementState = nextPlacement(given, typeof head === "string" ? head : "", { ids: unique, plan, missing, tools });
    return {
      plan,
      blocks,
      instruction: documentToolsInstruction(plan.searchable, viewable, wholeReads),
      missing,
      viewable,
      ...(toolable ? { toolable } : {}),
      guide,
      listing,
      placement,
    };
  }
}
