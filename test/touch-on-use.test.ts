// `AskOptions.touchOnUse` (DX-1, new in 0.99.13): a question touches the documents it plans once
// less than half of their time to live is left, so that a chat that still uses its files keeps
// them. Off by default, as before: a file used on day 2 is gone on day 3.
import { describe, expect, it, vi } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskOptions, type DocumentStore, type LargeFiles } from "llm-large-files";
import { fakeModel, says, utf8 } from "llm-large-files/testing";

const HOUR = 3_600_000;
const owner = "u1";
const scope = ["u1", "chat1"];

/** A library with the default TTL of 72 hours, a clock of its own, and a count of the store's writes. */
async function library() {
  let clock = Date.parse("2026-11-10T08:00:00Z");
  const now = () => new Date(clock);
  const inner = new MemoryDocumentStore({ now });
  const writes: string[] = [];
  const store = new Proxy(inner, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "patchMeta" || key === "put") writes.push(String(key));
        return (value as (...given: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as DocumentStore;
  const files = createLargeFiles({ store, now });
  const used = await files.ingest({ id: "used-1", name: "used.txt", bytes: utf8("Used on day 2.\n"), owner, scope });
  writes.length = 0;
  return { files, used, writes, later: (hours: number) => (clock += hours * HOUR), now };
}

const ask = (files: LargeFiles, documentIds: string[], extra: Partial<AskOptions> = {}) =>
  askWithFiles({ files, model: fakeModel([says("ok")]), owner, scope, documentIds, messages: [{ role: "user", text: "q" }], ...extra });

describe("touchOnUse", () => {
  it("keeps a file used at 47 hours (25 of 72 left) past 73 hours", async () => {
    const { files, used, writes, later, now } = await library();
    later(47);
    const result = await ask(files, [used.id], { touchOnUse: true });
    expect(result.answered).toBe(true);
    expect(writes).toEqual(["patchMeta"]);
    const touched = await files.getMeta(used.id, { owner, scope });
    expect(touched?.expiresAt).toBe(new Date(now().getTime() + 72 * HOUR).toISOString());
    later(26);
    expect(await files.getMeta(used.id, { owner, scope })).toBeDefined();
  });

  it("is off by default: the file used at 47 hours is gone at 73", async () => {
    const { files, used, writes, later } = await library();
    later(47);
    await ask(files, [used.id]);
    expect(writes).toEqual([]);
    later(26);
    expect(await files.getMeta(used.id, { owner, scope })).toBeUndefined();
  });

  it("does not touch a file with more than half its time left: no write", async () => {
    const { files, used, writes, later } = await library();
    later(10);
    await ask(files, [used.id], { touchOnUse: true });
    expect(writes).toEqual([]);
    expect((await files.getMeta(used.id, { owner, scope }))?.expiresAt).toBe(used.expiresAt);
  });

  it("changes nothing that is sent to the model", async () => {
    const sent = async (touchOnUse: boolean) => {
      const { files, used, later } = await library();
      later(47);
      const model = fakeModel([says("ok")]);
      await askWithFiles({ files, model, owner, scope, documentIds: [used.id], messages: [{ role: "user", text: "q" }], touchOnUse });
      return JSON.stringify(model.requests);
    };
    expect(await sent(true)).toBe(await sent(false));
  });

  it("leaves out the documents that are missing, with onMissingDocuments \"drop\"", async () => {
    const { files, used, writes, later } = await library();
    later(47);
    const result = await ask(files, ["gone-1", used.id], { touchOnUse: true, onMissingDocuments: "drop" });
    expect(result.missing).toEqual(["gone-1"]);
    expect(writes).toEqual(["patchMeta"]);
  });

  it("is a TypeError before any request when it is not true or false", async () => {
    const { files, used } = await library();
    const model = fakeModel([says("ok")]);
    await expect(askWithFiles({ files, model, owner, scope, documentIds: [used.id], messages: [{ role: "user", text: "q" }], touchOnUse: "yes" as unknown as boolean })).rejects.toThrow(new TypeError("touchOnUse must be true or false, and is \"yes\"."));
    expect(model.requests).toHaveLength(0);
  });

  it("is a TypeError on the first question with a store without patchMeta, whether a document is due or not", async () => {
    let clock = Date.parse("2026-11-10T08:00:00Z");
    const now = () => new Date(clock);
    const inner = new MemoryDocumentStore({ now });
    // A store written before patchMeta existed.
    const store = new Proxy(inner, {
      get(target, key) {
        if (key === "patchMeta") return undefined;
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? (value as (...given: unknown[]) => unknown).bind(target) : value;
      },
    }) as DocumentStore;
    const files = createLargeFiles({ store, now });
    const used = await files.ingest({ id: "used-1", name: "used.txt", bytes: utf8("Used on day 2.\n"), owner, scope });
    const error = new TypeError("touchOnUse needs a store with patchMeta(): MemoryDocumentStore and FileDocumentStore have it (a subclass of one, or one whose put, get, getMeta or delete was replaced, needs its own patchMeta).");
    for (const hours of [0, 10, 37]) {
      clock = Date.parse("2026-11-10T08:00:00Z") + hours * HOUR;
      const model = fakeModel([says("ok")]);
      await expect(askWithFiles({ files, model, owner, scope, documentIds: [used.id], messages: [{ role: "user", text: "q" }], touchOnUse: true })).rejects.toThrow(error);
      expect(model.requests).toHaveLength(0);
    }
    // Without the option, the store serves as before.
    expect((await ask(files, [used.id])).answered).toBe(true);
  });

  it("calls touch of a library of your own by the default of 72 hours, by the clock of this process, and needs one", async () => {
    const { files, used, later, now } = await library();
    const touched: string[] = [];
    // A library of your own, made from one: without the hook of createLargeFiles.
    const own: LargeFiles = { ...files, touch: async (id, access) => {
      touched.push(id);
      return files.touch(id, access);
    } };
    delete (own as unknown as Record<symbol, unknown>)[Symbol.for("llm-large-files.touchOnUse")];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      later(10);
      vi.setSystemTime(now());
      await ask(own, [used.id], { touchOnUse: true });
      expect(touched).toEqual([]);
      later(37);
      vi.setSystemTime(now());
      await ask(own, [used.id], { touchOnUse: true });
      expect(touched).toEqual([used.id]);
    } finally {
      vi.useRealTimers();
    }
    const { touch: _touch, ...without } = own;
    const model = fakeModel([says("ok")]);
    await expect(askWithFiles({ files: without, model, owner, scope, documentIds: [used.id], messages: [{ role: "user", text: "q" }], touchOnUse: true })).rejects.toThrow(new TypeError("touchOnUse needs a library with touch(): createLargeFiles gives one."));
    expect(model.requests).toHaveLength(0);
  });
});
