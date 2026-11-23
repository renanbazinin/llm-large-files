// documentStoreChecks: every failure starts with "The store failed the check:" and names what
// failed, whatever the store throws and wherever it throws it.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileDocumentStore, MemoryDocumentStore, type DocumentContext, type DocumentStore } from "llm-large-files";
import { documentStoreChecks, type DocumentStoreChecksOptions } from "llm-large-files/testing";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llf-check-messages-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const PREFIX = "The store failed the check: ";

/** The failures of every check, by the check's name. */
async function failures(options: DocumentStoreChecksOptions): Promise<Map<string, unknown>> {
  const failed = new Map<string, unknown>();
  for (const check of documentStoreChecks(options)) {
    await check.run().catch((error: unknown) => failed.set(check.name, error));
  }
  return failed;
}

function expectNamed(failed: Map<string, unknown>, call: string): void {
  expect(failed.size).toBeGreaterThan(0);
  for (const [name, error] of failed) {
    expect(error, name).toBeInstanceOf(Error);
    expect((error as Error).message.startsWith(PREFIX), `${name}: ${(error as Error).message}`).toBe(true);
  }
  expect([...failed.values()].some((error) => (error as Error).message.includes(call))).toBe(true);
}

/** A memory store with reads by range that throw an error of the store's own. */
class RangesThatThrow extends MemoryDocumentStore {
  async readTextRange(): Promise<Uint8Array | undefined> {
    throw new Error("the range server is down");
  }
}

describe("documentStoreChecks failure messages", () => {
  it("start with the prefix and name the call, when a call the check makes directly throws", async () => {
    const memories = new Map<string, MemoryDocumentStore>();
    const failed = await failures({
      create: ({ now, storage }) => {
        const store = memories.get(storage) ?? new RangesThatThrow({ now });
        memories.set(storage, store);
        return store;
      },
      isolatesScopes: true,
      skip: ["index"],
    });
    expectNamed(failed, "readTextRange");
    // The check of deletes reads by range after the delete, a call it made without must() before.
    const deletes = [...failed].find(([name]) => name.startsWith("deletes every part"));
    expect((deletes?.[1] as Error).message).toBe('The store failed the check: readTextRange("check-delete", 0, 4, {"scope":["user-1","chat-a"],"owner":"owner-a"}) threw Error: the range server is down.');
    expect((deletes?.[1] as Error).cause).toMatchObject({ message: "the range server is down" });
  });

  it("start with the prefix and name the call, for a wrapper over a scoped store that drops the context on readTextRange", async () => {
    const failed = await failures({
      create: async ({ now, storage, scopes }) => {
        for (const scope of scopes) await mkdir(path.join(root, storage, ...scope), { recursive: true });
        const inner = new FileDocumentStore(path.join(root, storage), { now, scopes: { depth: 2 } });
        const wrapper: DocumentStore = {
          put: (document, context?: DocumentContext) => inner.put(document, context),
          get: (id, context?: DocumentContext) => inner.get(id, context),
          getMeta: (id, context?: DocumentContext) => inner.getMeta(id, context),
          delete: (id, context?: DocumentContext) => inner.delete(id, context),
          putIndex: (id, index, context?: DocumentContext) => inner.putIndex(id, index, context),
          getIndex: (id, context?: DocumentContext) => inner.getIndex(id, context),
          putOriginal: (id, bytes, context?: DocumentContext) => inner.putOriginal(id, bytes, context),
          getOriginal: (id, context?: DocumentContext) => inner.getOriginal(id, context),
          sweep: (now, context?: DocumentContext) => inner.sweep(now, context),
          readTextRange: (id, start, end) => inner.readTextRange(id, start, end),
        };
        return wrapper;
      },
      dispose: (_store, { storage }) => rm(path.join(root, storage), { recursive: true, force: true }),
      isolatesScopes: true,
      requiresScope: true,
    });
    expectNamed(failed, "readTextRange");
    for (const error of failed.values()) expect((error as Error).message).not.toBe("A scope is required: pass the scope of the document, such as [userId, chatId].");
  });

  it("start with the prefix when create or dispose throws", async () => {
    const created = await failures({ create: () => { throw new Error("no database"); } });
    expectNamed(created, "create");
    const disposed = await failures({ create: ({ now }) => new MemoryDocumentStore({ now }), dispose: () => { throw new Error("cannot close"); }, skip: ["ranges", "index", "shared"] });
    expectNamed(disposed, "dispose");
  });

  it("start with the prefix and name the check, for an error no call of the check throws", async () => {
    // The method is read by the checks that look for it, outside any call of the store.
    const create = ({ now }: { now: () => Date }) => Object.defineProperty(new MemoryDocumentStore({ now }), "getOriginal", {
      get() {
        throw new RangeError("a getter that throws");
      },
    });
    const failed = await failures({ create, skip: ["ranges", "index", "shared"] });
    expectNamed(failed, 'threw RangeError: a getter that throws.');
    const [name, error] = [...failed][0]!;
    expect((error as Error).message).toBe(`The store failed the check: the check "${name}" threw RangeError: a getter that throws.`);
  });
});

describe("documentStoreChecks over a frozen store", () => {
  it("passes a store whose methods are frozen own properties", async () => {
    // A store written as Object.freeze({ put, get, … }): a proxy over it could not wrap its methods.
    const create = ({ now }: { now: () => Date }): DocumentStore => {
      const inner = new MemoryDocumentStore({ now });
      const methods = ["put", "get", "getMeta", "delete", "sweep", "putOriginal", "getOriginal"] as const;
      return Object.freeze(Object.fromEntries(methods.map((name) => [name, (...args: unknown[]) => (inner[name] as (...args: unknown[]) => unknown)(...args)]))) as unknown as DocumentStore;
    };
    const failed = await failures({ create, isolatesScopes: true, skip: ["ranges", "index", "shared"] });
    expect([...failed]).toEqual([]);
  });
});
