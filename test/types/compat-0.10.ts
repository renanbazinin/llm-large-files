// Checked by `tsc --noEmit` (npm run typecheck), not run: code written for 0.9 still compiles
// against the types of 0.10. Every field new in 0.10.0 is optional: a LargeFiles of your own whose
// prepare() gives the PreparedContext of 0.9, an adapter of your own, a store of your own and a
// result built by hand compile as they did. What does not: an exhaustive switch over a union that
// gained members (NoticeCode, ToolOutcome, ModelReply.finish), and the owner of a document in the
// plan of an event. createLargeFiles gives `stats()` and `toolsFor()` without `?.`.
import {
  askWithFiles,
  createLargeFiles,
  resolveBudget,
  type AccessOptions,
  type AskResult,
  type Budget,
  type ChatTurn,
  type DocumentMeta,
  type DocumentStore,
  type EventResult,
  type IngestFromSource,
  type IngestInput,
  type LargeFiles,
  type LargeFilesStats,
  type ModelAdapter,
  type ModelReply,
  type ModelRequest,
  type NoticeCode,
  type PrepareOptions,
  type PreparedContext,
  type StoredDocument,
  type ToolOptions,
  type ToolOutcome,
  type ToolSet,
  type ToolTurn,
} from "llm-large-files";

/** A store as 0.9 apps wrote it: the four required methods, with the context of 0.9. */
export class StoreOf09 implements DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();

  async put(document: StoredDocument): Promise<void> {
    this.documents.set(document.meta.id, document);
  }

  async get(id: string): Promise<StoredDocument | undefined> {
    return this.documents.get(id);
  }

  async getMeta(id: string): Promise<DocumentMeta | undefined> {
    return this.documents.get(id)?.meta;
  }

  async delete(id: string): Promise<boolean> {
    return this.documents.delete(id);
  }
}

/** A tool set of your own, as 0.9 wrote it: no `wholeReadsLeft`. */
export const toolsOf09: ToolSet = {
  declarations: [],
  has: () => false,
  execute: async () => ({ error: "No tools." }),
  executeWithFiles: async () => ({ result: { error: "No tools." }, files: [] }),
  describe: (name) => name,
  resultCharacters: () => 600,
};

/**
 * A LargeFiles of an application's own, as 0.9 wrote it: no `stats` or `toolsFor`, and a prepare()
 * that gives the PreparedContext of 0.9 (no `guide`, `listing`, `toolable` or `placement`).
 */
export class FilesOf09 implements LargeFiles {
  readonly budget: Budget = resolveBudget();
  readonly maxUploadBytes = 1_000_000;
  private readonly inner = createLargeFiles({ store: new StoreOf09() });

  budgetFor(overrides?: Partial<Budget>): Budget {
    return this.inner.budgetFor(overrides);
  }

  ingest(input: IngestInput | IngestFromSource): Promise<DocumentMeta> {
    return this.inner.ingest(input);
  }

  getMeta(id: string, access?: AccessOptions): Promise<DocumentMeta | undefined> {
    return this.inner.getMeta(id, access);
  }

  getOriginal(): Promise<Uint8Array | undefined> {
    return Promise.resolve(undefined);
  }

  delete(id: string, access?: AccessOptions): Promise<boolean> {
    return this.inner.delete(id, access);
  }

  sweep(): Promise<number> {
    return Promise.resolve(0);
  }

  async prepare(ids: string[], _base: { tokens: number; bytes: number }, options?: PrepareOptions): Promise<PreparedContext> {
    const found = await Promise.all(ids.map((id) => this.inner.getMeta(id, options)));
    const documents = found.filter((meta): meta is DocumentMeta => meta !== undefined);
    return {
      plan: { inline: [], searchable: documents, inlineTokens: 0, inlineBytes: 0 },
      blocks: new Map(documents.map((meta) => [meta.id, `--- Large attached file: ${meta.name} ---`])),
      instruction: "",
      missing: ids.filter((id) => !documents.some((meta) => meta.id === id)),
      viewable: [],
    };
  }

  tools(documents: DocumentMeta[], options?: ToolOptions): ToolSet {
    return documents.length > 0 ? this.inner.tools(documents, options) : toolsOf09;
  }
}

/** An adapter of your own, as 0.9 wrote it: the finish values of 0.9, no `nativeRounds`, no response ID. */
export const adapterOf09: ModelAdapter = {
  id: "own-model",
  capabilities: { toolFiles: "none", pageTokens: 1_000, contextTokens: 128_000 },
  async send(request: ModelRequest): Promise<ModelReply> {
    return { text: `${request.messages.length} messages.`, calls: [], finish: "complete", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } };
  },
};

/** A question asked with them, with a conversation of 0.9: plain turns and stored rounds without `native`. */
export async function askedWithOwn(): Promise<AskResult> {
  const turn: ChatTurn = { role: "user", text: "How many errors?" };
  const round: ToolTurn = { role: "tools", version: 1, calls: [{ id: "c1", name: "search_document", args: {}, result: { total_matching_lines: 3 } }] };
  return askWithFiles({ files: new FilesOf09(), model: adapterOf09, documentIds: [], messages: [turn, round, { role: "assistant", text: "3." }, turn] });
}

/** A result built by hand, as a test of 0.9 wrote it: `finish`, `citations`, `placement` and `userTurn` are optional. */
export const resultOf09: AskResult = {
  text: "3.",
  answered: true,
  steps: [],
  evidence: [],
  toolTurns: [],
  plan: { inline: [], searchable: [], inlineTokens: 0, inlineBytes: 0 },
  budget: resolveBudget(),
  turns: 1,
  usage: { requests: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, thoughtTokens: 0, byModel: {} },
};

/** What createLargeFiles makes has `stats()` and `toolsFor()`: no `?.` under strict. */
const created = createLargeFiles({ store: new StoreOf09() });
export function metrics(): LargeFilesStats {
  const stats = created.stats();
  return { ...stats, stuckStoreCalls: stats.stuckStoreCalls };
}
export async function toolsForUser(): Promise<ToolSet> {
  const { tools, missing } = await created.toolsFor(["doc-1"], { access: { owner: "alice" } });
  return missing.length === 0 ? tools : toolsOf09;
}
/** On a LargeFiles that may be your own, they are optional. */
export function metricsOf(files: LargeFiles): LargeFilesStats | undefined {
  // @ts-expect-error -- Cannot invoke an object which is possibly 'undefined' (TS2722).
  files.stats();
  return files.stats?.();
}

/** An exhaustive switch over the notice codes of 0.9: the four codes of 0.10.0 are not handled. */
export function noticeOf09(code: NoticeCode): string {
  switch (code) {
    case "searching_instead":
    case "writing_answer":
    case "replanned":
    case "room_made":
    case "nudged":
    case "results_shortened":
    case "answer_again":
    case "calls_not_run":
    case "budget_reached":
    case "no_room":
    case "blocked":
    case "documents_missing":
    case "document_gone":
    case "page_looks_busy":
      return code;
    default: {
      // @ts-expect-error -- "answer_filtered" | "answer_cut" | "placement_changed" | "native_rounds_dropped" is not assignable to 'never' (TS2322).
      const unhandled: never = code;
      return unhandled;
    }
  }
}

/** The same switch with the codes of 0.10.0. */
export function noticeOf010(code: NoticeCode): string {
  switch (code) {
    case "searching_instead":
    case "writing_answer":
    case "replanned":
    case "room_made":
    case "nudged":
    case "results_shortened":
    case "answer_again":
    case "calls_not_run":
    case "budget_reached":
    case "no_room":
    case "blocked":
    case "documents_missing":
    case "document_gone":
    case "page_looks_busy":
    case "answer_filtered":
    case "answer_cut":
    case "placement_changed":
    case "native_rounds_dropped":
      return code;
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

/** An exhaustive switch over the outcomes of 0.9: "redacted" is not handled. */
export function outcomeOf09(outcome: ToolOutcome): string {
  switch (outcome) {
    case "ok":
    case "error":
    case "refused":
    case "already_shown":
    case "not_run":
      return outcome;
    default: {
      // @ts-expect-error -- "redacted" is not assignable to 'never' (TS2322).
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** An exhaustive switch over the finish values of 0.9: "other" is not handled. */
export function finishOf09(reply: ModelReply): string {
  switch (reply.finish) {
    case undefined:
    case "complete":
    case "cut":
    case "filtered":
    case "malformed_call":
      return reply.finish ?? "unknown";
    default: {
      // @ts-expect-error -- "other" is not assignable to 'never' (TS2322).
      const unhandled: never = reply.finish;
      return unhandled;
    }
  }
}

/** The plan of an event names no owner since 0.10.0: read it from `AskResult.plan`. */
export function ownerOf(result: EventResult, returned: AskResult): string | undefined {
  // @ts-expect-error -- Property 'owner' does not exist on the event plan's documents (TS2339).
  const fromEvent: string | undefined = result.plan.inline[0]?.owner;
  return fromEvent ?? returned.plan.inline[0]?.owner;
}
