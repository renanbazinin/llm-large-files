// Checked by `tsc --noEmit` (npm run typecheck), not run: code written for 0.8 still compiles
// against the types of 0.9. Every method of DocumentStore takes a last, optional context since
// 0.9.0, and a method with fewer parameters still implements it.
import {
  createLargeFiles,
  MemoryDocumentStore,
  type AccessOptions,
  type DocumentContext,
  type DocumentMeta,
  type DocumentStore,
  type Extractor,
  type IngestInput,
  type StoredDocument,
  type ToolTurn,
} from "llm-large-files";

/** A store as 0.8 apps wrote it: no method takes a context. */
export class StoreOf08 implements DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly files = new Map<string, Uint8Array>();
  private readonly indexes = new Map<string, Uint8Array>();

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
    this.files.delete(id);
    this.indexes.delete(id);
    return this.documents.delete(id);
  }

  async sweep(now?: Date): Promise<number> {
    let removed = 0;
    for (const [id, { meta }] of this.documents) {
      if (Date.parse(meta.expiresAt) <= (now ?? new Date()).getTime() && await this.delete(id)) removed++;
    }
    return removed;
  }

  async putOriginal(id: string, bytes: Uint8Array): Promise<void> {
    this.files.set(id, bytes);
  }

  async getOriginal(id: string): Promise<Uint8Array | undefined> {
    return this.files.get(id);
  }

  async readTextRange(id: string, start: number, end: number): Promise<Uint8Array | undefined> {
    const document = this.documents.get(id);
    return document && new TextEncoder().encode(document.text).subarray(start, end);
  }

  async putIndex(id: string, index: Uint8Array): Promise<void> {
    this.indexes.set(id, index);
  }

  async getIndex(id: string): Promise<Uint8Array | undefined> {
    return this.indexes.get(id);
  }
}

/** A store of the four required methods only, as an object. */
export const smallest: DocumentStore = {
  put: async () => undefined,
  get: async () => undefined,
  getMeta: async () => undefined,
  delete: async () => false,
};

/** A wrapper as 0.8 apps wrote it: each method passes the id on, and nothing else. */
export function logged(inner: DocumentStore): DocumentStore {
  return {
    put: (document) => inner.put(document),
    get: (id) => inner.get(id),
    getMeta: (id) => inner.getMeta(id),
    delete: (id) => inner.delete(id),
  };
}

/** A subclass of a store of the package, with an override that takes the id alone. */
export class Counted extends MemoryDocumentStore {
  reads = 0;
  override async getMeta(id: string): Promise<DocumentMeta | undefined> {
    this.reads++;
    return super.getMeta(id);
  }
}

/** A store of 0.9, which keeps the documents of each scope apart, and a wrapper that passes the context on. */
export class ScopedStore extends StoreOf08 {
  override async getMeta(id: string, context?: DocumentContext): Promise<DocumentMeta | undefined> {
    const meta = await super.getMeta(id);
    return meta && (meta.scope ?? []).join("/") === (context?.scope ?? []).join("/") ? meta : undefined;
  }
}
export const forwarding = (inner: DocumentStore): DocumentStore => ({
  put: (document, context) => inner.put(document, context),
  get: (id, context) => inner.get(id, context),
  getMeta: (id, context) => inner.getMeta(id, context),
  delete: (id, context) => inner.delete(id, context),
  sweep: (now, context) => inner.sweep?.(now, context) ?? Promise.resolve(0),
});

/** Metadata, input, options and rounds as 0.8 wrote them: none of the fields new in 0.9 is needed. */
export const metaOf08: DocumentMeta = {
  id: "doc_0123456789abcdef0123456789abcdef",
  owner: "alice",
  name: "a.txt",
  mimeType: "text/plain",
  format: "text",
  bytes: 1,
  textBytes: 1,
  characters: 1,
  lines: 1,
  estimatedTokens: 1,
  wrappedLines: 0,
  outline: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-04T00:00:00.000Z",
};
export const inputOf08: IngestInput = { name: "a.txt", bytes: new Uint8Array([97]), owner: "alice" };
export const accessOf08: AccessOptions = { owner: "alice" };
export const roundOf08: ToolTurn = { role: "tools", calls: [{ name: "read_document", args: {}, result: {} }] };
/** An extractor is still a plain function. */
export const extractor: Extractor = async (bytes, input) => ({ text: `${input.name}: ${bytes.byteLength} bytes` });

export const files = createLargeFiles({ store: new StoreOf08(), extractors: { text: extractor } });
export const filesOverWrappers = createLargeFiles({ store: logged(forwarding(new Counted())) });
export const scoped = createLargeFiles({ store: new ScopedStore() });
export const tiny = createLargeFiles({ store: smallest });
