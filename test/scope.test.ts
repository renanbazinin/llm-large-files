import { describe, expect, it } from "vitest";
import { DocumentScopeError, MemoryDocumentStore, type DocumentMeta, type StoredDocument } from "llm-large-files";
import { checkScope, sameScope, scopeKey } from "../src/scope.js";

const meta = (id: string, more: Partial<DocumentMeta> = {}): DocumentMeta => ({
  id,
  name: `${id}.txt`,
  mimeType: "text/plain",
  format: "text",
  bytes: 5,
  textBytes: 5,
  characters: 5,
  lines: 1,
  estimatedTokens: 2,
  wrappedLines: 0,
  outline: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-04T00:00:00.000Z",
  ...more,
});
const stored = (id: string, text: string, more: Partial<DocumentMeta> = {}): StoredDocument => ({ meta: meta(id, more), text });
const bytes = (text: string) => new TextEncoder().encode(text);
const clock = () => new Date("2026-01-02T00:00:00.000Z");

/** The error `work` throws: undefined when it throws none. */
function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("checkScope", () => {
  it("refuses what is not a scope, with a DocumentScopeError that is a TypeError", () => {
    const refused: Array<[string, unknown]> = [
      ["an empty array", []],
      ["nine segments", ["a", "b", "c", "d", "e", "f", "g", "h", "i"]],
      ["an empty segment", ["alice", ""]],
      ["'.'", ["alice", "."]],
      ["'..'", ["..", "chat"]],
      ["a segment with '/'", ["alice/bob"]],
      ["a segment with '\\'", ["alice\\bob"]],
      ["NUL", ["alice\u0000"]],
      ["a line break", ["alice\nbob"]],
      ["DEL", ["alice\u007f"]],
      ["a C1 control", ["alice\u0085"]],
      ["half of a surrogate pair", ["alice\uD83D"]],
      ["257 characters", ["x".repeat(257)]],
      ["a number segment", ["alice", 7]],
      ["a hole", [, "chat"]],
      ["a string", "alice"],
      ["null", null],
      ["an object", { 0: "alice", length: 1 }],
    ];
    for (const [what, scope] of refused) {
      const error = thrown(() => checkScope(scope));
      expect(error, what).toBeInstanceOf(DocumentScopeError);
      expect(error, what).toBeInstanceOf(TypeError);
      expect(error, what).toMatchObject({ name: "DocumentScopeError", code: "scope_invalid" });
      expect(DocumentScopeError.is(error), what).toBe(true);
    }
  });

  it("names the segment that is wrong, not what it holds", () => {
    const error = thrown(() => checkScope(["user-42", "secret/../chat"])) as Error;
    expect(error.message).toBe('scope segment 2 cannot hold "/", "\\" or control characters.');
    expect((thrown(() => checkScope(["user-42", ".."])) as Error).message).toBe('scope segment 2 cannot be "." or "..".');
    expect((thrown(() => checkScope([])) as Error).message).toBe("scope must be an array of 1 to 8 strings, such as [userId, chatId].");
  });

  it("accepts 1 to 8 segments of up to 256 characters, in any script, and gives a frozen copy", () => {
    const given = ["Alice", "שיחה 7", "#1", "100%", "a.b", "...", "x".repeat(256), "\u{1F600}"];
    const scope = checkScope(given);
    expect(scope).toEqual(given);
    expect(scope).not.toBe(given);
    expect(Object.isFrozen(scope)).toBe(true);
    given[0] = "mallory";
    expect(scope![0]).toBe("Alice");
    expect(checkScope(["one"])).toEqual(["one"]);
    expect(checkScope(undefined)).toBeUndefined();
  });
});

describe("scopeKey and sameScope", () => {
  it("gives one key for each scope, and none of them that of no scope", () => {
    expect(scopeKey(undefined)).toBe("");
    expect(scopeKey(["alice", "chat-1"])).toBe("alice/chat-1");
    // '#' and '%' are encoded: a key with them cannot be taken for another, or cut at a '#'.
    expect(scopeKey(["a#b", "50%"])).toBe("a%23b/50%25");
    expect(scopeKey(["שיחה"])).toBe(encodeURIComponent("שיחה"));
    // Scopes that a careless key would take for one another all have keys of their own.
    const scopes = [["a", "b"], ["a%2Fb"], ["a", "b", "c"], ["ab"], ["a b"], ["a%20b"], ["a+b"]];
    expect(new Set(scopes.map((scope) => scopeKey(scope))).size).toBe(scopes.length);
  });

  it("compares scopes segment by segment, with null as no scope", () => {
    expect(sameScope(undefined, undefined)).toBe(true);
    expect(sameScope(null, undefined)).toBe(true);
    expect(sameScope(["alice", "chat"], ["alice", "chat"])).toBe(true);
    expect(sameScope(["alice", "chat"], ["alice"])).toBe(false);
    expect(sameScope(["alice"], ["Alice"])).toBe(false);
    expect(sameScope(["alice"], undefined)).toBe(false);
    expect(sameScope(null, ["alice"])).toBe(false);
  });
});

describe("MemoryDocumentStore and scopes", () => {
  it("keeps one ID in two scopes as two documents", async () => {
    const store = new MemoryDocumentStore({ now: clock });
    const alice = { scope: ["alice", "chat-1"] };
    const bob = { scope: ["bob", "chat-1"] };
    await store.put(stored("upload-1", "alice's text"), alice);
    await store.put(stored("upload-1", "bob's text"), bob);

    expect((await store.get("upload-1", alice))?.text).toBe("alice's text");
    expect((await store.get("upload-1", bob))?.text).toBe("bob's text");
    // Without a scope, neither: the documents of no scope are those of calls without one.
    expect(await store.getMeta("upload-1")).toBeUndefined();
    expect(await store.getMeta("upload-1", { scope: ["alice"] })).toBeUndefined();
    // The owner is the library's rule, not the store's.
    expect((await store.getMeta("upload-1", { ...alice, owner: "someone" }))?.id).toBe("upload-1");

    expect(await store.delete("upload-1", alice)).toBe(true);
    expect(await store.get("upload-1", alice)).toBeUndefined();
    expect((await store.get("upload-1", bob))?.text).toBe("bob's text");
    expect(await store.delete("upload-1", alice)).toBe(false);
  });

  it("works as in 0.8 without a context", async () => {
    const store = new MemoryDocumentStore({ now: clock });
    await store.put(stored("doc_1", "text"));
    await store.putOriginal("doc_1", bytes("file"));
    expect((await store.get("doc_1"))?.text).toBe("text");
    expect((await store.getMeta("doc_1"))?.name).toBe("doc_1.txt");
    expect(await store.getOriginal("doc_1")).toEqual(bytes("file"));
    // A context without a scope is the same as none.
    expect((await store.get("doc_1", {}))?.text).toBe("text");
    expect((await store.get("doc_1", { owner: "alice" }))?.text).toBe("text");
    expect(await store.delete("doc_1")).toBe(true);
    expect(await store.get("doc_1")).toBeUndefined();
    expect(await store.getOriginal("doc_1")).toBeUndefined();
  });

  it("sweeps every scope without one, and only its own with one", async () => {
    let now = new Date("2026-01-02T00:00:00.000Z");
    const store = new MemoryDocumentStore({ now: () => now });
    const old = { expiresAt: "2026-01-03T00:00:00.000Z" };
    await store.put(stored("a", "1", old));
    await store.put(stored("a", "2", old), { scope: ["alice"] });
    await store.put(stored("a", "3", old), { scope: ["bob"] });
    await store.put(stored("b", "4"), { scope: ["bob"] });
    now = new Date("2026-01-03T12:00:00.000Z");

    expect(await store.sweep(now, { scope: ["alice"] })).toBe(1);
    expect(await store.sweep(now, { scope: ["alice"] })).toBe(0);
    expect(await store.sweep(now, { scope: ["carol"] })).toBe(0);
    expect(await store.sweep()).toBe(2);
    expect((await store.get("b", { scope: ["bob"] }))?.text).toBe("4");
    expect(await store.sweep(now, {})).toBe(0);
  });

  it("gives a copy of the original file, so that changing it changes nothing stored", async () => {
    const store = new MemoryDocumentStore({ now: clock });
    const scope = { scope: ["alice", "chat-1"] };
    await store.putOriginal("upload-1", bytes("%PDF-1.7"), scope);
    await store.put(stored("upload-1", "text"), scope);

    const first = await store.getOriginal("upload-1", scope);
    expect(first).toEqual(bytes("%PDF-1.7"));
    first![0] = 0;
    expect(await store.getOriginal("upload-1", scope)).toEqual(bytes("%PDF-1.7"));
    expect(await store.getOriginal("upload-1")).toBeUndefined();
    expect(await store.getOriginal("upload-1", { scope: ["bob", "chat-1"] })).toBeUndefined();
  });

  it("refuses a scope that is not valid", async () => {
    const store = new MemoryDocumentStore({ now: clock });
    await expect(store.put(stored("a", "1"), { scope: [".."] })).rejects.toMatchObject({ name: "DocumentScopeError", code: "scope_invalid" });
    await expect(store.get("a", { scope: [] })).rejects.toBeInstanceOf(DocumentScopeError);
  });

  it("still serves a subclass that overrides a method with the id alone, as one written for 0.8", async () => {
    class Counted extends MemoryDocumentStore {
      reads = 0;
      override async getMeta(id: string) {
        this.reads++;
        return super.getMeta(id);
      }
    }
    const store = new Counted({ now: clock });
    await store.put(stored("doc_1", "text"));
    expect((await store.getMeta("doc_1"))?.id).toBe("doc_1");
    expect(store.reads).toBe(1);
  });
});
