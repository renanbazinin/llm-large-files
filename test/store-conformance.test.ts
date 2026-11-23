// The checks of llm-large-files/testing (documentStoreChecks), run on the stores of the package:
// MemoryDocumentStore, FileDocumentStore in one folder, and FileDocumentStore with a folder per scope.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileDocumentStore, MemoryDocumentStore, type DocumentStore } from "llm-large-files";
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

  it("fail a store that loses the context, keeps an owner as null, or leaves a part behind, and say what it did", async () => {
    const run = async (options: DocumentStoreChecksOptions, name: RegExp) => {
      const check = documentStoreChecks(options).find((each) => name.test(each.name));
      expect(check, String(name)).toBeDefined();
      return check!.run().then(() => undefined, (error: unknown) => (error as Error).message);
    };
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
});
