// Stores for the tests of application IDs (0.9.0) whose calls can be held open: two libraries over
// one of them stand for two servers, and a held call for a slow store, so that a test makes a race
// without waiting on the clock.
import { MemoryDocumentStore, type DocumentContext, type DocumentStore, type StoredDocument } from "llm-large-files";

/** A store call held open: `reached` settles once the call is made, and it goes on at `release()`. */
export type Gate = { reached: Promise<void>; release: () => void };

/** Holds the next call of one method of a store, made for one owner or for anyone. */
export class Holds {
  private readonly holds = new Map<string, { owner: string | undefined; reach: () => void; opened: Promise<void> }>();

  hold(method: string, owner?: string): Gate {
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const opened = new Promise<void>((resolve) => (release = resolve));
    this.holds.set(method, { owner, reach, opened });
    return { reached, release };
  }

  async pass(method: string, context: DocumentContext | undefined): Promise<void> {
    const hold = this.holds.get(method);
    if (!hold || (hold.owner !== undefined && hold.owner !== context?.owner)) return;
    this.holds.delete(method);
    hold.reach();
    await hold.opened;
  }
}

/**
 * A store written for 0.8, as most stores of an application are: one map for every scope and owner,
 * whatever the context says. Any call can be held.
 */
export class StoreOf08 implements DocumentStore {
  readonly documents = new Map<string, StoredDocument>();
  readonly originals = new Map<string, Uint8Array>();
  readonly holds = new Holds();

  async put(document: StoredDocument, context?: DocumentContext) {
    await this.holds.pass("put", context);
    this.documents.set(document.meta.id, structuredClone(document));
  }
  async get(id: string, context?: DocumentContext) {
    await this.holds.pass("get", context);
    return structuredClone(this.documents.get(id));
  }
  async getMeta(id: string, context?: DocumentContext) {
    await this.holds.pass("getMeta", context);
    return structuredClone(this.documents.get(id)?.meta);
  }
  async delete(id: string) {
    this.originals.delete(id);
    return this.documents.delete(id);
  }
  async putOriginal(id: string, bytes: Uint8Array) {
    this.originals.set(id, bytes.slice());
  }
  async getOriginal(id: string, context?: DocumentContext) {
    await this.holds.pass("getOriginal", context);
    return this.originals.get(id)?.slice();
  }
}

/** A `MemoryDocumentStore` (scopes kept apart) whose `put` can be held. */
export class HeldMemoryStore extends MemoryDocumentStore {
  readonly holds = new Holds();
  override async put(document: StoredDocument, context?: DocumentContext) {
    await this.holds.pass("put", context);
    return super.put(document, context);
  }
}
