// The checks of llm-large-files/testing (documentStoreChecks), run on the stores of the package:
// MemoryDocumentStore, FileDocumentStore in one folder, and FileDocumentStore with a folder per scope.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileDocumentStore, MemoryDocumentStore, type DocumentContext, type DocumentStore, type StoredDocument } from "llm-large-files";
import { documentStoreChecks, type DocumentStoreChecksOptions } from "llm-large-files/testing";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llf-conformance-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The stores of one storage name, so that a second `create` gives a store over the same memory. */
const memories = new Map<string, MemoryDocumentStore>();

const STORES: Record<string, DocumentStoreChecksOptions> = {
  MemoryDocumentStore: {
    // Two stores cannot share one memory: the same one stands for both servers.
    create: ({ now, storage }) => {
      const store = memories.get(storage) ?? new MemoryDocumentStore({ now });
      memories.set(storage, store);
      return store;
    },
    dispose: (_store, { storage }) => {
      memories.delete(storage);
    },
    isolatesScopes: true,
    skip: ["ranges", "index"],
  },
  "FileDocumentStore, one folder": {
    create: ({ now, storage }) => new FileDocumentStore(path.join(root, storage), { now }),
    dispose: (_store, { storage }) => rm(path.join(root, storage), { recursive: true, force: true }),
  },
  "FileDocumentStore, a folder per scope": {
    // The application makes the folder of each chat; the store makes only its own in it.
    create: async ({ now, storage, scopes }) => {
      for (const scope of scopes) await mkdir(path.join(root, storage, ...scope), { recursive: true });
      return new FileDocumentStore(path.join(root, storage), { now, scopes: { depth: 2 } });
    },
    dispose: (_store, { storage }) => rm(path.join(root, storage), { recursive: true, force: true }),
    isolatesScopes: true,
    requiresScope: true,
  },
  "FileDocumentStore, a folder per scope of 3 levels, with the root for calls without a scope": {
    create: ({ now, storage }) => new FileDocumentStore(path.join(root, storage), { now, scopes: { depth: 3, folder: "", createScopeFolders: true, unscoped: "root" } }),
    dispose: (_store, { storage }) => rm(path.join(root, storage), { recursive: true, force: true }),
    isolatesScopes: true,
    scopeDepth: 3,
  },
};

for (const [name, options] of Object.entries(STORES)) {
  describe(`documentStoreChecks: ${name}`, () => {
    for (const check of documentStoreChecks(options)) it(check.name, check.run, check.timeoutMs);
  });
}

describe("documentStoreChecks", () => {
  it("are a list of named checks with a time limit each, whose run takes no argument (Jest waits for `done` otherwise)", () => {
    const checks = documentStoreChecks({ create: () => new MemoryDocumentStore() });
    expect(checks.length).toBeGreaterThan(10);
    expect(new Set(checks.map((check) => check.name)).size).toBe(checks.length);
    for (const check of checks) {
      expect(check.run.length).toBe(0);
      expect(check.timeoutMs).toBeGreaterThan(0);
    }
    // The checks of what a store keeps apart, or refuses, are there only when the store says it does.
    const names = (options: Partial<DocumentStoreChecksOptions>) => documentStoreChecks({ create: () => new MemoryDocumentStore(), ...options }).map((check) => check.name);
    expect(names({ isolatesScopes: true }).length).toBeGreaterThan(names({}).length);
    expect(names({ requiresScope: true }).length).toBe(names({}).length + 1);
    expect(names({ skip: ["ranges", "index", "originals", "sweep", "shared"] }).length).toBe(names({}).length - 5);
    expect(() => documentStoreChecks({} as DocumentStoreChecksOptions)).toThrow(TypeError);
    expect(() => documentStoreChecks({ create: () => new MemoryDocumentStore(), scopeDepth: 9 })).toThrow(TypeError);
  });

  /** Runs the check whose name matches `name`: undefined when the store passes it, else the message of the failure. */
  const run = async (options: DocumentStoreChecksOptions, name: RegExp) => {
    const check = documentStoreChecks(options).find((each) => name.test(each.name));
    expect(check, String(name)).toBeDefined();
    return check!.run().then(() => undefined, (error: unknown) => (error as Error).message);
  };

  it("fail a store that loses the context, keeps an owner as null, or leaves a part behind, and say what it did", async () => {
    // A wrapper that passes on only the ID: the documents of two scopes become one.
    class ForwardsTheIdOnly implements DocumentStore {
      readonly inner = new MemoryDocumentStore();
      put = (document: Parameters<DocumentStore["put"]>[0]) => this.inner.put(document);
      get = (id: string) => this.inner.get(id);
      getMeta = (id: string) => this.inner.getMeta(id);
      delete = (id: string) => this.inner.delete(id);
      putOriginal = (id: string, bytes: Uint8Array) => this.inner.putOriginal(id, bytes);
      getOriginal = (id: string) => this.inner.getOriginal(id);
      sweep = (now?: Date) => this.inner.sweep(now);
    }
    expect(await run({ create: () => new ForwardsTheIdOnly(), isolatesScopes: true, skip: ["ranges", "index", "shared"] }, /one ID in two scopes/))
      .toMatch(/^The store failed the check: getMeta in scope a: expected \["user-1","chat-a"\], got \["user-1","chat-b"\]\.$/);

    // A database that writes a field left out as null.
    class Nulls extends MemoryDocumentStore {
      override async getMeta(id: string, context?: Parameters<DocumentStore["getMeta"]>[1]) {
        const meta = await super.getMeta(id, context);
        return meta && { ...meta, owner: meta.owner ?? (null as unknown as undefined) };
      }
    }
    expect(await run({ create: () => new Nulls(), skip: ["ranges", "index", "shared"] }, /never as null/)).toMatch(/getMeta gave owner: null/);

    // A delete that forgets the original.
    class KeepsOriginals extends MemoryDocumentStore {
      readonly kept = new Map<string, Uint8Array>();
      override async putOriginal(id: string, bytes: Uint8Array) {
        this.kept.set(id, bytes.slice());
      }
      override async getOriginal(id: string, context?: Parameters<DocumentStore["getMeta"]>[1]) {
        return await this.getMeta(id, context) ? this.kept.get(id) : undefined;
      }
    }
    expect(await run({ create: () => new KeepsOriginals(), skip: ["ranges", "index", "shared"] }, /deletes every part/)).toMatch(/getOriginal of a document whose original was deleted before it was put/);

    // A store without readTextRange that does not say so.
    expect(await run({ create: () => new MemoryDocumentStore() }, /by range, as UTF-8/)).toMatch(/it has no readTextRange\. Pass skip: \["ranges"\]/);
  });

  it("fail a store that serves, from what it read before, a document another store over the storage deleted", async () => {
    // A store that keeps what it read, for each server: it serves a document another server deleted.
    const storages = new Map<string, MemoryDocumentStore>();
    class ReadCaching implements DocumentStore {
      readonly #read = new Map<string, StoredDocument>();
      constructor(readonly inner: MemoryDocumentStore) {}
      async put(document: StoredDocument, context?: DocumentContext) {
        this.#read.delete(document.meta.id);
        await this.inner.put(document, context);
      }
      async get(id: string, context?: DocumentContext) {
        const kept = this.#read.get(id);
        if (kept) return structuredClone(kept);
        const document = await this.inner.get(id, context);
        if (document) this.#read.set(id, structuredClone(document));
        return document;
      }
      getMeta = async (id: string, context?: DocumentContext) => (await this.get(id, context))?.meta;
      async delete(id: string, context?: DocumentContext) {
        this.#read.delete(id);
        return this.inner.delete(id, context);
      }
      putOriginal = (id: string, bytes: Uint8Array, context?: DocumentContext) => this.inner.putOriginal(id, bytes, context);
      getOriginal = (id: string, context?: DocumentContext) => this.inner.getOriginal(id, context);
      async sweep(now?: Date, context?: DocumentContext) {
        this.#read.clear();
        return this.inner.sweep(now, context);
      }
    }
    const readCaching: DocumentStoreChecksOptions = {
      create: ({ now, storage }) => {
        const inner = storages.get(storage) ?? new MemoryDocumentStore({ now });
        storages.set(storage, inner);
        return new ReadCaching(inner);
      },
      skip: ["ranges", "index"],
    };
    expect(await run(readCaching, /two stores over one storage/)).toMatch(/getMeta from the first store after the second deleted the document: expected undefined, got \{/);
  });

  it("pass a shared store whose get gives a field more, and name the text when only the text is the old one", async () => {
    const storages = new Map<string, MemoryDocumentStore>();
    const over = (make: (inner: MemoryDocumentStore) => DocumentStore): DocumentStoreChecksOptions => ({
      create: ({ now, storage }) => {
        const inner = storages.get(storage) ?? new MemoryDocumentStore({ now });
        storages.set(storage, inner);
        return make(inner);
      },
      dispose: (_store, { storage }) => {
        storages.delete(storage);
      },
      skip: ["ranges", "index"],
    });
    /** Each method of `inner`, with the context passed on. */
    const forward = (inner: MemoryDocumentStore) => ({
      put: (document: StoredDocument, context?: DocumentContext) => inner.put(document, context),
      getMeta: (id: string, context?: DocumentContext) => inner.getMeta(id, context),
      delete: (id: string, context?: DocumentContext) => inner.delete(id, context),
      putOriginal: (id: string, bytes: Uint8Array, context?: DocumentContext) => inner.putOriginal(id, bytes, context),
      getOriginal: (id: string, context?: DocumentContext) => inner.getOriginal(id, context),
      sweep: (now?: Date, context?: DocumentContext) => inner.sweep(now, context),
    });
    // A database row spread into the result: { meta, text, _id }.
    const withRow = over((inner) => ({
      ...forward(inner),
      get: async (id: string, context?: DocumentContext) => {
        const document = await inner.get(id, context);
        return document && Object.assign(document, { _id: id });
      },
    }));
    expect(await run(withRow, /two stores over one storage/)).toBeUndefined();
    // A store that reads the metadata fresh, and keeps the text it read once, on each server.
    const keepsText = over((inner) => {
      const texts = new Map<string, string>();
      return {
        ...forward(inner),
        get: async (id: string, context?: DocumentContext) => {
          const document = await inner.get(id, context);
          if (!document) return undefined;
          if (!texts.has(id)) texts.set(id, document.text);
          return { meta: document.meta, text: texts.get(id)! };
        },
      };
    });
    expect(await run(keepsText, /two stores over one storage/)).toMatch(/^The store failed the check: get\(id\)\.text from the first store after the second put a new document under the ID: expected "/);
  });

  it("fail a sweep that leaves the original or the index of an expired document in storage", async () => {
    // A sweep apart from delete that leaves a part of each expired document in storage. Its
    // getOriginal and getIndex look at the metadata first, so the part shows only once a document
    // is put again under the ID.
    class SweepLeaves extends MemoryDocumentStore {
      readonly #parts = { original: new Map<string, Uint8Array>(), index: new Map<string, Uint8Array>() };
      #sweeping = false;
      constructor(readonly leaves: "original" | "index" | "nothing", options: { now: () => Date }) {
        super(options);
      }
      override async putOriginal(id: string, bytes: Uint8Array) {
        this.#parts.original.set(id, bytes.slice());
      }
      override async getOriginal(id: string, context?: DocumentContext) {
        return await this.getMeta(id, context) ? this.#parts.original.get(id)?.slice() : undefined;
      }
      async putIndex(id: string, bytes: Uint8Array) {
        this.#parts.index.set(id, bytes.slice());
      }
      async getIndex(id: string, context?: DocumentContext) {
        return await this.getMeta(id, context) ? this.#parts.index.get(id)?.slice() : undefined;
      }
      override async delete(id: string, context?: DocumentContext) {
        for (const part of ["original", "index"] as const) if (!(this.#sweeping && part === this.leaves)) this.#parts[part].delete(id);
        return super.delete(id, context);
      }
      override async sweep(now?: Date, context?: DocumentContext) {
        this.#sweeping = true;
        try {
          return await super.sweep(now, context);
        } finally {
          this.#sweeping = false;
        }
      }
    }
    for (const leaves of ["original", "index"] as const) {
      expect(await run({ create: ({ now }) => new SweepLeaves(leaves, { now }), skip: ["ranges", "shared"] }, /sweeps the documents expired/))
        .toMatch(leaves === "original" ? /getOriginal of a document put under the ID of a swept one/ : /getIndex of a document put under the ID of a swept one/);
    }
    // The same store, with a sweep that leaves nothing, passes.
    expect(await run({ create: ({ now }) => new SweepLeaves("nothing", { now }), skip: ["ranges", "shared"] }, /sweeps the documents expired/)).toBeUndefined();
  });
});
