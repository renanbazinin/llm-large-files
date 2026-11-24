// documentStoreChecks: the checks a DocumentStore must pass, for the tests of a store of your own.
// New in 0.9.0. They depend on no test framework: each check is a name, a time limit and a function
// that throws when the store fails it. Give them to `it` (Vitest), `test` (Jest) or `test`
// (node:test), as the documentation of documentStoreChecks shows.
import { DocumentScopeError } from "../errors.js";
import { createLargeFiles, type LargeFiles } from "../library.js";
import { MemoryDocumentStore } from "../stores.js";
import type { DocumentContext, DocumentMeta, DocumentScope, DocumentStore } from "../types.js";
import { serviceLog, utf8 } from "./fake-model.js";

/** What each check gives `create`: its clock, a name for the storage, and the scopes it uses. */
export type StoreCheckEnvironment = {
  /**
   * The clock of the check: the time it started, which a check may move forward. Give it to the
   * store as its clock, when it has one: the `now` option of the built-in stores.
   */
  readonly now: () => Date;
  /**
   * A name for the storage of the store: lowercase letters, digits and "-", new for each check. Use
   * it as a folder, a key prefix or a collection name. When `create` is called twice with the same
   * name, give a second store over the same storage, as a second server would open it.
   */
  readonly storage: string;
  /**
   * The scopes the checks use (`scopeDepth` segments each, lowercase): for a store whose scopes
   * need a place made before a write, such as the folders of a `FileDocumentStore` with `scopes`.
   */
  readonly scopes: readonly DocumentScope[];
};

/** A part of the store a check needs, which `skip` leaves out. */
export type StoreCheckPart = "originals" | "ranges" | "index" | "sweep" | "shared";

export type DocumentStoreChecksOptions = {
  /** A new store over new, empty storage, named by `environment.storage`. */
  create(environment: StoreCheckEnvironment): DocumentStore | Promise<DocumentStore>;
  /** Called after each check for each store it made, to close it and remove its storage. */
  dispose?(store: DocumentStore, environment: StoreCheckEnvironment): void | Promise<void>;
  /**
   * Whether the store keeps the documents of each scope apart (`context.scope`), as
   * `MemoryDocumentStore` does: one ID in two scopes is then two documents. Defaults to false: a
   * store that ignores the context, which the library keeps apart by `meta.scope`.
   */
  isolatesScopes?: boolean;
  /**
   * Whether the store refuses a call without a scope, with a `DocumentScopeError` of code
   * "scope_required", as a `FileDocumentStore` with `scopes` does. Defaults to false.
   */
  requiresScope?: boolean;
  /** How many segments the scopes of the checks have, from 1 to 8. Defaults to 2: `[userId, chatId]`. */
  scopeDepth?: number;
  /**
   * The parts the store does not have: "originals" (`putOriginal`, `getOriginal`), "ranges"
   * (`readTextRange`), "index" (`putIndex`, `getIndex`), "sweep", or "shared" for a store whose
   * storage two stores cannot share (`MemoryDocumentStore`). A check of a part the store lacks, and
   * that is not skipped, fails and says so.
   */
  skip?: readonly StoreCheckPart[];
};

/** One check: give it to your test framework's `it` or `test`. */
export type DocumentStoreCheck = {
  /** What the store must do, as a sentence. */
  readonly name: string;
  /** The time the check may take, in milliseconds. */
  readonly timeoutMs: number;
  /** Runs the check. Rejects with an `Error` that says what the store did wrong. Takes no argument. */
  readonly run: () => Promise<void>;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A text that is hard to keep exactly: CRLF, Hebrew, an emoji, a tab, a byte-order mark inside, no break at the end. */
const TEXT = "first line\r\nשלום עולם, a line in Hebrew\n😀 four bytes, é two\n\tindented\n﻿a mark inside\nlast line without a break";

/** How the message of every failure of a check starts. */
const FAILED = "The store failed the check: ";

/** Throws the failure of a check. */
function fail(message: string, cause?: unknown): never {
  throw new Error(`${FAILED}${message}`, cause === undefined ? undefined : { cause });
}

/** Whether `error` is the failure of a check, made by `fail`. */
const failure = (error: unknown): error is Error => error instanceof Error && error.message.startsWith(FAILED);

/** What a thrown value says, for a failure: the error's name and message. */
const thrown = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : show(error));

/** "`what` threw `error`.", with one full stop. */
function threw(what: string, error: unknown): string {
  const text = `${what} threw ${thrown(error)}`;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function show(value: unknown): string {
  if (value instanceof Uint8Array) return `${value.length} bytes`;
  if (value === undefined) return "undefined";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Whether two values are the same, deeply. A field that is undefined counts as absent; bytes are compared byte for byte. */
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array && right instanceof Uint8Array) || left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = (value: object) => Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort();
  const leftKeys = keys(left);
  const rightKeys = keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (!equal(actual, expected)) fail(`${what}: expected ${show(expected)}, got ${show(actual)}.`);
}

/** Bytes as a plain Uint8Array, so that a Buffer or a view compares as its bytes. */
function bytesOf(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail(`${what}: expected bytes (a Uint8Array), got ${show(value)}.`);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** The error a call threw, or a failure when it threw none. */
async function thrownBy(call: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return fail(`${what}: expected it to throw, and it did not.`);
}

/** Runs `call`, and fails the check, saying what was called, when it throws. A failure of a check is passed on as it is. */
async function must<T>(call: () => Promise<T>, what: string): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (failure(error)) throw error;
    return fail(threw(what, error), error);
  }
}

/** A call to a store as a failure names it: `getMeta("check-copy", { scope: […] })`. */
function callOf(method: string, args: unknown[]): string {
  const shown = args.map((arg) => {
    if (typeof arg === "string" || typeof arg === "number") return JSON.stringify(arg);
    if (arg instanceof Date) return arg.toISOString();
    if (arg instanceof Uint8Array) return `${arg.length} bytes`;
    const id = (arg as { meta?: { id?: unknown } } | null)?.meta?.id;
    if (typeof id === "string") return `{ meta: { id: ${JSON.stringify(id)}, … }, text }`;
    return show(arg);
  });
  return `${method}(${shown.join(", ")})`;
}

/**
 * The store as the checks call it: a method that throws (or rejects) fails the check, and the
 * failure names the call. Its methods are the store's own, so a check can still test whether one
 * exists. The library, and checks of what a store throws, are given the store itself.
 */
function named(store: DocumentStore): DocumentStore {
  // Over an empty target: a store whose methods are frozen own properties (Object.freeze({ put, … }))
  // would make the proxy's invariants refuse a wrapped method.
  const target = store;
  return new Proxy(Object.create(null) as DocumentStore, {
    has: (_, key) => Reflect.has(target, key),
    get(_, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const failed = (error: unknown): never => {
          if (failure(error)) throw error;
          return fail(threw(callOf(String(key), args), error), error);
        };
        let result: unknown;
        try {
          result = (value as (...args: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          failed(error);
        }
        return Promise.resolve(result).catch(failed);
      };
    },
  });
}

/** Metadata as the library writes it, for a document written to the store directly. */
function metaFor(id: string, text: string, createdAt: number, expiresAt: number, more: Partial<DocumentMeta> = {}): DocumentMeta {
  const bytes = utf8(text).length;
  return {
    id, metaVersion: 1, name: "notes.txt", mimeType: "text/plain", format: "text", bytes, textBytes: bytes, jsonBytes: bytes + 16,
    characters: text.length, lines: text.split("\n").length, estimatedTokens: Math.ceil(bytes / 4), wrappedLines: 0,
    outline: [{ level: 1, title: "first line", line: 1 }], createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    ...more,
  };
}

/** What a check gets: its store, a way to open another one over the same storage, and its clock. */
type Harness = {
  /** The store, whose calls fail the check, naming the call, when they throw (`named`). */
  store: DocumentStore;
  /** The store itself, for the library and for checks of what it throws. */
  raw: DocumentStore;
  environment: StoreCheckEnvironment;
  /** When the check started: the clock's time until it is moved. */
  start: number;
  /** Moves the clock of the check (and of the stores that read it). */
  setClock(time: number): void;
  /** Another store over the same storage, as a second server, whose calls fail the check as `store`'s do. */
  open(): Promise<DocumentStore>;
  /** The context of a call in scope A or B, with an owner. */
  context(which?: "a" | "b"): DocumentContext;
  scopes: { a: DocumentScope; b: DocumentScope };
};

let checksMade = 0;

/**
 * The checks a `DocumentStore` must pass: what the library relies on, method by method, and the
 * library itself over the store, compared with `MemoryDocumentStore`. Run them in the tests of a
 * store of your own:
 *
 * ```ts
 * for (const check of documentStoreChecks({ create })) it(check.name, check.run, check.timeoutMs); // Vitest, Jest
 * for (const check of documentStoreChecks({ create })) test(check.name, { timeout: check.timeoutMs }, check.run); // node:test
 * ```
 *
 * Each check makes its own store with `create`, over storage of its own, and gives it to `dispose`
 * at the end. Checks are only added in minor versions. New in 0.9.0.
 */
export function documentStoreChecks(options: DocumentStoreChecksOptions): DocumentStoreCheck[] {
  if (typeof options?.create !== "function") throw new TypeError("documentStoreChecks needs a create function that makes a store.");
  const depth = options.scopeDepth ?? 2;
  if (!Number.isInteger(depth) || depth < 1 || depth > 8) throw new TypeError("scopeDepth must be a whole number from 1 to 8.");
  const skip = new Set(options.skip ?? []);
  const isolates = options.isolatesScopes === true;
  const requiresScope = options.requiresScope === true;
  const scopeOf = (tag: string): DocumentScope => Object.freeze(Array.from({ length: depth }, (_, index) => (index === depth - 1 ? `chat-${tag}` : `user-${index + 1}`)));
  const scopes = { a: scopeOf("a"), b: scopeOf("b") };

  /** Fails when the store lacks the methods of a part that is not skipped. */
  const needs = (store: DocumentStore, part: StoreCheckPart, methods: Array<keyof DocumentStore>) => {
    const absent = methods.filter((method) => typeof store[method] !== "function");
    if (absent.length > 0) fail(`it has no ${absent.join(" or ")}. Pass skip: ["${part}"] if it does not keep that.`);
  };

  const check = (name: string, body: (harness: Harness) => Promise<void>, timeoutMs = 10_000): DocumentStoreCheck => ({
    name,
    timeoutMs,
    run: async () => {
      let time = Math.floor(Date.now() / 1000) * 1000;
      const start = time;
      const environment: StoreCheckEnvironment = Object.freeze({
        now: () => new Date(time),
        storage: `check-${++checksMade}-${Math.random().toString(36).slice(2, 10)}`,
        scopes: Object.freeze([scopes.a, scopes.b]),
      });
      const stores: DocumentStore[] = [];
      const create = async () => {
        const store = await must(async () => options.create(environment), "create");
        stores.push(store);
        return store;
      };
      // Every failure starts with FAILED: one the check did not foresee names the check.
      const failed: unknown[] = [];
      try {
        const raw = await create();
        await body({
          store: named(raw), raw, environment, start, scopes,
          open: async () => named(await create()),
          setClock: (at) => {
            time = at;
          },
          context: (which = "a") => Object.freeze({ scope: scopes[which], owner: `owner-${which}` }),
        });
      } catch (error) {
        failed.push(error);
      }
      for (const store of stores) {
        try {
          await options.dispose?.(store, environment);
        } catch (error) {
          failed.push(new Error(`${FAILED}${threw("dispose", error)}`, { cause: error }));
        }
      }
      if (failed.length === 0) return;
      const [first] = failed;
      throw failure(first) ? first : new Error(`${FAILED}${threw(`the check "${name}"`, first)}`, { cause: first });
    },
  });

  const checks: DocumentStoreCheck[] = [];

  checks.push(check("keeps a document as it was put, and copies its metadata on the way in and out", async ({ store, start, context }) => {
    const meta = metaFor("check-copy", TEXT, start, start + DAY, { owner: "owner-a", scope: [...scopes.a] });
    const kept = structuredClone(meta);
    await must(() => store.put({ meta, text: TEXT }, context()), "put");
    meta.name = "changed.txt";
    meta.outline.push({ level: 1, title: "added", line: 2 });
    const got = await must(() => store.get("check-copy", context()), "get");
    if (!got) fail("get gave undefined for a document just put.");
    same(got.text, TEXT, "get(id).text, which must be the text exactly as put");
    same(got.meta, kept, "get(id).meta, after the caller changed the metadata it put");
    got.meta.name = "changed again.txt";
    const read = await must(() => store.getMeta("check-copy", context()), "getMeta");
    same(read, kept, "getMeta(id), after the caller changed the metadata get returned");
    read!.outline.push({ level: 1, title: "added", line: 3 });
    same(await store.getMeta("check-copy", context()), kept, "getMeta(id), after the caller changed the metadata getMeta returned");
  }));

  checks.push(check("gives undefined for an ID it does not have, and false when asked to delete it", async ({ store, context }) => {
    same(await must(() => store.getMeta("check-unknown", context()), "getMeta"), undefined, "getMeta of an unknown ID");
    same(await must(() => store.get("check-unknown", context()), "get"), undefined, "get of an unknown ID");
    same(await must(() => store.delete("check-unknown", context()), "delete"), false, "delete of an unknown ID");
    if (store.getOriginal && !skip.has("originals")) same(await must(() => store.getOriginal!("check-unknown", context()), "getOriginal"), undefined, "getOriginal of an unknown ID");
    if (store.getIndex && !skip.has("index")) same(await must(() => store.getIndex!("check-unknown", context()), "getIndex"), undefined, "getIndex of an unknown ID");
  }));

  checks.push(check("keeps fields of the metadata it does not know, for later versions", async ({ store, start, context }) => {
    const meta = metaFor("check-fields", TEXT, start, start + DAY, {
      scope: [...scopes.a], sha256: "0".repeat(64), original: { ref: "uploads/check-fields", bytes: 12, sha256: "1".repeat(64) },
    }) as DocumentMeta & Record<string, unknown>;
    meta.addedLater = { nested: [1, "two", null, { deep: true }], flag: false };
    meta.metaVersion = 1;
    await must(() => store.put({ meta, text: TEXT }, context()), "put");
    same(await store.getMeta("check-fields", context()), meta, "getMeta(id), with fields a later version adds");
    same((await store.get("check-fields", context()))?.meta, meta, "get(id).meta, with fields a later version adds");
  }));

  checks.push(check("gives back a field that was left out as absent, never as null", async ({ store, start, context }) => {
    await must(() => store.put({ meta: metaFor("check-absent", TEXT, start, start + DAY), text: TEXT }, context()), "put");
    const meta = await store.getMeta("check-absent", context());
    if (!meta) fail("getMeta gave undefined for a document just put.");
    for (const field of ["owner", "scope", "sha256", "original", "pages", "encoding"] as const) {
      if ((meta as Record<string, unknown>)[field] === null) fail(`getMeta gave ${field}: null for a document put without one. Leave it out (a MongoDB driver writes a missing field as null: remove nulls when you read).`);
    }
    await store.put({ meta: metaFor("check-owned", TEXT, start, start + DAY, { owner: "owner-a" }), text: TEXT }, context());
    same((await store.getMeta("check-owned", context()))?.owner, "owner-a", "getMeta(id).owner");
  }));

  checks.push(check("reads an expired document without an error: as undefined, or as it was for the library to refuse", async ({ store, start, context }) => {
    const meta = metaFor("check-expired", TEXT, start - DAY, start - MINUTE);
    await must(() => store.put({ meta, text: TEXT }, context()), "put");
    const read = await must(() => store.getMeta("check-expired", context()), "getMeta of an expired document");
    if (read !== undefined) same(read, meta, "getMeta of an expired document, which must be undefined or the metadata as it was");
    const whole = await must(() => store.get("check-expired", context()), "get of an expired document");
    if (whole !== undefined) same(whole, { meta, text: TEXT }, "get of an expired document, which must be undefined or the document as it was");
    if (store.sweep && !skip.has("sweep")) {
      await must(() => store.sweep!(new Date(start), {}), "sweep");
      same(await store.getMeta("check-expired", context()), undefined, "getMeta of an expired document after sweep");
    }
  }));

  checks.push(check("deletes every part of a document, gives false for a second delete, and survives two at once", async ({ store, start, context }) => {
    const originals = !skip.has("originals");
    const indexes = !skip.has("index");
    const ranges = !skip.has("ranges");
    if (originals) needs(store, "originals", ["putOriginal", "getOriginal"]);
    if (indexes) needs(store, "index", ["putIndex", "getIndex"]);
    if (ranges) needs(store, "ranges", ["readTextRange"]);
    const write = async (id: string) => {
      if (originals) await must(() => store.putOriginal!(id, utf8("the upload"), context()), "putOriginal");
      if (indexes) await must(() => store.putIndex!(id, utf8("an index"), context()), "putIndex");
      await must(() => store.put({ meta: metaFor(id, TEXT, start, start + DAY), text: TEXT }, context()), "put");
    };
    const gone = async (id: string, when: string) => {
      same(await store.getMeta(id, context()), undefined, `getMeta ${when}`);
      same(await store.get(id, context()), undefined, `get ${when}`);
      if (originals) same(await store.getOriginal!(id, context()), undefined, `getOriginal ${when}`);
      if (indexes) same(await store.getIndex!(id, context()), undefined, `getIndex ${when}`);
      if (ranges) same(await store.readTextRange!(id, 0, 4, context()), undefined, `readTextRange ${when}`);
    };
    await write("check-delete");
    same(await must(() => store.delete("check-delete", context()), "delete"), true, "delete of a document that is there");
    await gone("check-delete", "after delete");
    same(await must(() => store.delete("check-delete", context()), "a second delete"), false, "a second delete");

    await write("check-twice");
    await must(() => Promise.all([store.delete("check-twice", context()), store.delete("check-twice", context())]), "two deletes of one document at once");
    await gone("check-twice", "after two deletes at once");

    // What an ingest that failed leaves: an original and an index, without the document. The
    // library deletes them; a document put later under the ID must not find them.
    if (originals || indexes) {
      if (originals) await store.putOriginal!("check-partial", utf8("the upload"), context());
      if (indexes) await store.putIndex!("check-partial", utf8("an index"), context());
      await must(() => store.delete("check-partial", context()), "delete of a document written only in part");
      await store.put({ meta: metaFor("check-partial", TEXT, start, start + DAY), text: TEXT }, context());
      if (originals) same(await store.getOriginal!("check-partial", context()), undefined, "getOriginal of a document whose original was deleted before it was put");
      if (indexes) same(await store.getIndex!("check-partial", context()), undefined, "getIndex of a document whose index was deleted before it was put");
    }
  }));

  if (!skip.has("ranges")) {
    checks.push(check("reads the text by range, as UTF-8 bytes: across characters, past the end, and nothing after a delete", async ({ store, start, context }) => {
      needs(store, "ranges", ["readTextRange"]);
      await must(() => store.put({ meta: metaFor("check-range", TEXT, start, start + DAY), text: TEXT }, context()), "put");
      const bytes = utf8(TEXT);
      const size = bytes.length;
      const emoji = bytes.indexOf(0xf0);
      const points = [...new Set([0, 1, 11, 12, 13, emoji, emoji + 1, emoji + 2, emoji + 3, emoji + 4, size - 1, size])].sort((a, b) => a - b);
      for (const from of points) {
        for (const to of points) {
          if (to < from) continue;
          const got = bytesOf(await must(() => store.readTextRange!("check-range", from, to, context()), `readTextRange(id, ${from}, ${to})`), `readTextRange(id, ${from}, ${to})`);
          same(got, bytes.subarray(from, to), `readTextRange(id, ${from}, ${to})`);
        }
      }
      same(bytesOf(await store.readTextRange!("check-range", size - 3, size + 10, context()), "a range past the end"), bytes.subarray(size - 3), `readTextRange(id, ${size - 3}, ${size + 10}), which runs past the end`);
      same(bytesOf(await store.readTextRange!("check-range", size, size + 10, context()), "a range at the end"), new Uint8Array(0), `readTextRange(id, ${size}, ${size + 10}), which starts at the end`);
      same(bytesOf(await store.readTextRange!("check-range", size + 5, size + 10, context()), "a range after the end"), new Uint8Array(0), `readTextRange(id, ${size + 5}, ${size + 10}), which starts after the end`);
      await store.delete("check-range", context());
      same(await must(() => store.readTextRange!("check-range", 0, 4, context()), "readTextRange after delete"), undefined, "readTextRange after delete");
    }));
  }

  if (!skip.has("index")) {
    checks.push(check("keeps a line index byte for byte, as a copy, the last one written", async ({ store, start, context }) => {
      needs(store, "index", ["putIndex", "getIndex"]);
      const first = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256);
      await must(() => store.putIndex!("check-index", first, context()), "putIndex");
      await store.put({ meta: metaFor("check-index", TEXT, start, start + DAY), text: TEXT }, context());
      same(bytesOf(await must(() => store.getIndex!("check-index", context()), "getIndex"), "getIndex"), first, "getIndex(id)");
      const second = Uint8Array.from({ length: 41 }, (_, index) => 255 - index);
      const kept = second.slice();
      await store.putIndex!("check-index", second, context());
      second.fill(0);
      const got = bytesOf(await store.getIndex!("check-index", context()), "getIndex");
      same(got, kept, "getIndex(id) after a second putIndex, whose bytes the caller then changed");
      got.fill(1);
      same(bytesOf(await store.getIndex!("check-index", context()), "getIndex"), kept, "getIndex(id) after the caller changed the bytes getIndex returned");
    }));
  }

  if (!skip.has("originals")) {
    checks.push(check("keeps the original byte for byte, as a copy", async ({ store, start, context }) => {
      needs(store, "originals", ["putOriginal", "getOriginal"]);
      const original = Uint8Array.from({ length: 4_096 + 17 }, (_, index) => (index * 31 + (index >> 8)) % 256);
      const kept = original.slice();
      await must(() => store.putOriginal!("check-original", original, context()), "putOriginal");
      original.fill(0);
      await store.put({ meta: metaFor("check-original", TEXT, start, start + DAY, { originalKept: true }), text: TEXT }, context());
      const got = bytesOf(await must(() => store.getOriginal!("check-original", context()), "getOriginal"), "getOriginal");
      same(got, kept, "getOriginal(id), after the caller changed the bytes it put");
      got.fill(1);
      same(bytesOf(await store.getOriginal!("check-original", context()), "getOriginal"), kept, "getOriginal(id), after the caller changed the bytes getOriginal returned");
    }));
  }

  if (!skip.has("sweep")) {
    checks.push(check("sweeps the documents expired at the time it is given, every part of them, and no other", async ({ store, start, context }) => {
      needs(store, "sweep", ["sweep"]);
      const originals = !skip.has("originals");
      if (originals) needs(store, "originals", ["putOriginal", "getOriginal"]);
      const indexes = Boolean(store.putIndex && store.getIndex) && !skip.has("index");
      const put = async (id: string, expiresAt: number, which: "a" | "b" = "a") => {
        if (originals) await must(() => store.putOriginal!(id, utf8("the upload"), context(which)), "putOriginal");
        if (indexes) await store.putIndex!(id, utf8("an index"), context(which));
        await must(() => store.put({ meta: metaFor(id, TEXT, start, expiresAt, { scope: [...scopes[which]] }), text: TEXT }, context(which)), "put");
      };
      // An original or an index the sweep left is not read while the metadata is gone: it shows once
      // a document is put again under the ID, without them, as the delete check does.
      const left = async (id: string, which: "a" | "b" = "a") => {
        if (!originals && !indexes) return;
        await store.put({ meta: metaFor(id, TEXT, start, start + DAY, { scope: [...scopes[which]] }), text: TEXT }, context(which));
        if (originals) same(await store.getOriginal!(id, context(which)), undefined, "getOriginal of a document put under the ID of a swept one, without an original");
        if (indexes) same(await store.getIndex!(id, context(which)), undefined, "getIndex of a document put under the ID of a swept one, without an index");
        await store.delete(id, context(which));
      };
      await put("check-ends", start + MINUTE);
      await put("check-stays", start + DAY);
      same(await must(() => store.sweep!(new Date(start), {}), "sweep"), 0, "sweep(now) before any document expired");
      same(await must(() => store.sweep!(new Date(start + 2 * MINUTE), {}), "sweep"), 1, "sweep(now) after one document expired (the time it is given, not the time of day)");
      same(await store.getMeta("check-ends", context()), undefined, "getMeta of a swept document");
      if (store.readTextRange && !skip.has("ranges")) same(await store.readTextRange("check-ends", 0, 4, context()), undefined, "readTextRange of a swept document");
      if (indexes) same(await store.getIndex!("check-ends", context()), undefined, "getIndex of a swept document");
      if (!(await store.getMeta("check-stays", context()))) fail("sweep removed a document that had not expired.");
      await left("check-ends");
      if (isolates) {
        await put("check-ends-a", start + MINUTE, "a");
        await put("check-ends-b", start + MINUTE, "b");
        same(await must(() => store.sweep!(new Date(start + 2 * MINUTE), { scope: scopes.a }), "sweep with a scope"), 1, "sweep(now, { scope }) with an expired document in that scope and one in another");
        same(await must(() => store.sweep!(new Date(start + 2 * MINUTE)), "sweep without a context"), 1, "sweep(now) after a sweep of one scope: the expired document of the other scope");
        await left("check-ends-a", "a");
        await left("check-ends-b", "b");
      }
    }));
  }

  checks.push(check("keeps documents under the IDs an application may choose", async ({ store, start, context }) => {
    const ids = ["a", "0", "upload-3f9a", "a_b-c", `x${"0".repeat(63)}`, `doc_${"0123456789abcdef".repeat(2)}`];
    for (const id of ids) await must(() => store.put({ meta: metaFor(id, `${TEXT} ${id}`, start, start + DAY), text: `${TEXT} ${id}` }, context()), `put of the ID "${id}"`);
    for (const id of ids) {
      same((await store.getMeta(id, context()))?.id, id, `getMeta("${id}").id`);
      same((await store.get(id, context()))?.text, `${TEXT} ${id}`, `get("${id}").text`);
    }
    for (const id of ids) same(await store.delete(id, context()), true, `delete("${id}")`);
  }));

  checks.push(check("takes a context on every call", async ({ store, start, context }) => {
    const calls = async (id: string, given: DocumentContext | undefined, label: string) => {
      if (store.putOriginal && !skip.has("originals")) await must(() => store.putOriginal!(id, utf8("the upload"), given), `putOriginal ${label}`);
      if (store.putIndex && !skip.has("index")) await must(() => store.putIndex!(id, utf8("an index"), given), `putIndex ${label}`);
      await must(() => store.put({ meta: metaFor(id, TEXT, start, start + DAY), text: TEXT }, given), `put ${label}`);
      if (!(await must(() => store.getMeta(id, given), `getMeta ${label}`))) fail(`getMeta ${label} gave undefined for a document just put.`);
      same((await must(() => store.get(id, given), `get ${label}`))?.text, TEXT, `get ${label}`);
      if (store.readTextRange && !skip.has("ranges")) same(bytesOf(await must(() => store.readTextRange!(id, 0, 5, given), `readTextRange ${label}`), `readTextRange ${label}`), utf8("first"), `readTextRange ${label}`);
      if (store.getIndex && !skip.has("index")) same(bytesOf(await must(() => store.getIndex!(id, given), `getIndex ${label}`), `getIndex ${label}`), utf8("an index"), `getIndex ${label}`);
      if (store.getOriginal && !skip.has("originals")) same(bytesOf(await must(() => store.getOriginal!(id, given), `getOriginal ${label}`), `getOriginal ${label}`), utf8("the upload"), `getOriginal ${label}`);
      same(await must(() => store.delete(id, given), `delete ${label}`), true, `delete ${label}`);
      if (store.sweep && !skip.has("sweep")) await must(() => store.sweep!(new Date(start), given?.scope ? { scope: given.scope } : given), `sweep ${label}`);
    };
    await calls("check-context", context(), "with a scope and an owner");
    await calls("check-context", { scope: scopes.a }, "with a scope alone");
    if (!requiresScope) {
      // As the library called a store before 0.9.0, and as it calls one for a document without a scope.
      await calls("check-context", undefined, "without a context");
      await calls("check-context", {}, "with an empty context");
      await calls("check-context", { owner: "owner-a" }, "with an owner alone");
    }
  }));

  if (requiresScope) {
    checks.push(check("refuses a call without a scope with a DocumentScopeError of code scope_required, but sweeps every scope without one", async ({ store, raw, start }) => {
      const document = { meta: metaFor("check-scope", TEXT, start, start + DAY), text: TEXT };
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["put without a context", () => raw.put(document)],
        ["put with an owner alone", () => raw.put(document, { owner: "owner-a" })],
        ["getMeta without a context", () => raw.getMeta("check-scope")],
        ["get with an empty context", () => raw.get("check-scope", {})],
        ["delete without a context", () => raw.delete("check-scope")],
      ];
      for (const [label, call] of calls) {
        const error = await thrownBy(call, label);
        if (!DocumentScopeError.is(error) || error.code !== "scope_required") fail(`${label} threw ${thrown(error)}, not a DocumentScopeError of code "scope_required".`);
      }
      if (store.sweep && !skip.has("sweep")) {
        await must(() => store.sweep!(new Date(start)), "sweep without a context");
        await must(() => store.sweep!(new Date(start), {}), "sweep with an empty context");
      }
    }));
  }

  if (isolates) {
    checks.push(check("the context reaches every call: one ID in two scopes is two documents", async ({ store, start, context }) => {
      const texts = { a: `${TEXT}\nof chat a`, b: `${TEXT}\nof chat b, longer` };
      for (const which of ["a", "b"] as const) {
        if (store.putOriginal && !skip.has("originals")) await store.putOriginal("check-twin", utf8(`upload ${which}`), context(which));
        if (store.putIndex && !skip.has("index")) await store.putIndex("check-twin", utf8(`index ${which}`), context(which));
        await store.put({ meta: metaFor("check-twin", texts[which], start, start + DAY, { scope: [...scopes[which]], owner: `owner-${which}` }), text: texts[which] }, context(which));
      }
      for (const which of ["a", "b"] as const) {
        same((await store.getMeta("check-twin", context(which)))?.scope, [...scopes[which]], `getMeta in scope ${which}`);
        same((await store.get("check-twin", context(which)))?.text, texts[which], `get in scope ${which}`);
        if (store.readTextRange && !skip.has("ranges")) {
          const size = utf8(texts[which]).length;
          same(bytesOf(await store.readTextRange("check-twin", size - 6, size, context(which)), "readTextRange"), utf8(texts[which]).subarray(size - 6), `readTextRange in scope ${which}`);
        }
        if (store.getIndex && !skip.has("index")) same(bytesOf(await store.getIndex("check-twin", context(which)), "getIndex"), utf8(`index ${which}`), `getIndex in scope ${which}`);
        if (store.getOriginal && !skip.has("originals")) same(bytesOf(await store.getOriginal("check-twin", context(which)), "getOriginal"), utf8(`upload ${which}`), `getOriginal in scope ${which}`);
      }
      same(await store.delete("check-twin", context("a")), true, "delete in scope a");
      same(await store.getMeta("check-twin", context("a")), undefined, "getMeta in scope a after its delete");
      same((await store.get("check-twin", context("b")))?.text, texts.b, "get in scope b after the delete in scope a");
      same(await store.delete("check-twin", context("a")), false, "a second delete in scope a");
    }));

    checks.push(check("a document of one scope is missing from another scope, and from no scope", async ({ store, start, context }) => {
      if (store.putOriginal && !skip.has("originals")) await store.putOriginal("check-apart", utf8("the upload"), context("a"));
      if (store.putIndex && !skip.has("index")) await store.putIndex("check-apart", utf8("an index"), context("a"));
      await store.put({ meta: metaFor("check-apart", TEXT, start, start + DAY, { scope: [...scopes.a] }), text: TEXT }, context("a"));
      const elsewhere: Array<[string, DocumentContext | undefined]> = [["scope b", context("b")]];
      if (!requiresScope) elsewhere.push(["no scope", undefined], ["an owner alone", { owner: "owner-a" }]);
      for (const [label, given] of elsewhere) {
        same(await store.getMeta("check-apart", given), undefined, `getMeta from ${label}`);
        same(await store.get("check-apart", given), undefined, `get from ${label}`);
        if (store.readTextRange && !skip.has("ranges")) same(await store.readTextRange("check-apart", 0, 4, given), undefined, `readTextRange from ${label}`);
        if (store.getIndex && !skip.has("index")) same(await store.getIndex("check-apart", given), undefined, `getIndex from ${label}`);
        if (store.getOriginal && !skip.has("originals")) same(await store.getOriginal("check-apart", given), undefined, `getOriginal from ${label}`);
        same(await store.delete("check-apart", given), false, `delete from ${label}`);
      }
      same((await store.get("check-apart", context("a")))?.text, TEXT, "get in scope a, after the calls from elsewhere");
    }));
  }

  if (!skip.has("shared")) {
    checks.push(check("two stores over one storage, as two servers, see each other's writes and deletes", async ({ store, start, open, context }) => {
      const other = await open();
      const ranges = (each: DocumentStore) => each.readTextRange && !skip.has("ranges");
      const meta = metaFor("check-shared", TEXT, start, start + DAY);
      await store.put({ meta, text: TEXT }, context());
      // The first store reads the document, as the library does before every use: what it read must
      // not be served once the second store deleted or replaced the document.
      same(await must(() => store.getMeta("check-shared", context()), "getMeta from the first store"), meta, "getMeta from the first store of a document it put");
      same((await must(() => store.get("check-shared", context()), "get from the first store"))?.text, TEXT, "get from the first store of a document it put");
      if (ranges(store)) same(bytesOf(await store.readTextRange!("check-shared", 0, 5, context()), "readTextRange"), utf8("first"), "readTextRange from the first store");
      same((await must(() => other.get("check-shared", context()), "get from the second store"))?.text, TEXT, "get from the second store of a document the first put");
      if (ranges(other)) same(bytesOf(await other.readTextRange!("check-shared", 0, 5, context()), "readTextRange"), utf8("first"), "readTextRange from the second store");
      if (other.putIndex && store.getIndex && !skip.has("index")) {
        await other.putIndex("check-shared", utf8("built on the second server"), context());
        same(bytesOf(await store.getIndex("check-shared", context()), "getIndex"), utf8("built on the second server"), "getIndex from the first store of an index the second put");
      }
      same(await other.delete("check-shared", context()), true, "delete from the second store");
      same(await store.getMeta("check-shared", context()), undefined, "getMeta from the first store after the second deleted the document");
      same(await store.get("check-shared", context()), undefined, "get from the first store after the second deleted the document");
      if (ranges(store)) same(await store.readTextRange!("check-shared", 0, 5, context()), undefined, "readTextRange from the first store after the second deleted the document");
      // The second store puts a new document under the ID, as an ingest with ifExists: "replace" does.
      const text = `${TEXT}\nwritten again on the second server`;
      const replaced = metaFor("check-shared", text, start, start + 2 * DAY, { name: "again.txt" });
      await must(() => other.put({ meta: replaced, text }, context()), "put from the second store");
      same(await store.getMeta("check-shared", context()), replaced, "getMeta from the first store after the second put a new document under the ID");
      // The parts apart, as in the other checks: a store may give more fields, and the message
      // then says which part is not the new one.
      const got = await store.get("check-shared", context());
      same(got?.meta, replaced, "get(id).meta from the first store after the second put a new document under the ID");
      same(got?.text, text, "get(id).text from the first store after the second put a new document under the ID");
      if (ranges(store)) {
        const size = utf8(text).length;
        same(bytesOf(await store.readTextRange!("check-shared", size - 6, size, context()), "readTextRange"), utf8("server"), "readTextRange from the first store after the second put a new document under the ID");
      }
    }));
  }

  checks.push(check("the library over it, reading by range, gives what it gives over MemoryDocumentStore", async ({ raw, environment, context }) => {
    const keepOriginals = skip.has("originals") ? [] : ["log" as const];
    const libraryOver = (over: DocumentStore): LargeFiles => createLargeFiles({ store: over, now: environment.now, wholeDocumentBytes: 0, budget: { inlineTokens: 1_000 }, keepOriginals });
    const { scope, owner } = context() as { scope: DocumentScope; owner: string };
    const access = { scope, owner };
    const log = serviceLog(3_000);
    const transcript = async (files: LargeFiles) => {
      const meta = await files.ingest({ name: "service.log", bytes: utf8(log), id: "check-log", scope, owner });
      const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 }, access);
      const tools = files.tools([meta], { access });
      const results: unknown[] = [meta, [...prepared.blocks], prepared.missing];
      for (const [name, args] of [
        ["search_document", { query: "ERROR", mode: "exact", max_results: 50, context_lines: 1 }],
        ["search_document", { query: "took 8\\d\\dms", mode: "regex", max_results: 20 }],
        ["search_document", { query: "orders 4999 worker" }],
        ["read_document", { start_line: 1_490, end_line: 1_510 }],
        ["get_document_overview", {}],
      ] as const) results.push(await tools.execute(name, { document_id: meta.id, ...args }));
      if (keepOriginals.length > 0) results.push(await files.getOriginal(meta.id, access));
      results.push(await files.delete(meta.id, access), (await files.prepare([meta.id], { tokens: 0, bytes: 0 }, access)).missing);
      return results;
    };
    const expected = await transcript(libraryOver(new MemoryDocumentStore({ now: environment.now })));
    const actual = await must(() => transcript(libraryOver(raw)), "an ingest, a search and a delete through the library");
    expected.forEach((value, index) => same(actual[index], value, `step ${index + 1} of the ingest, search and delete through the library`));
  }, 30_000));

  return checks;
}
