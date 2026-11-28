// Previews of a source's lines (CIT-8a, 0.99.14): `files.readLines` and the preview route of the
// upload handlers. A preview of a replaced document (same ID, another version) answers "changed"
// (409, no text). Deleted, expired, another owner, another scope and never stored answer 404, byte
// for byte alike. The preview hook fails closed, and the route needs it said explicitly. From the
// draft of spec 03-privacy-sse, invariant (b).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, MAX_PREVIEW_BYTES, MAX_PREVIEW_LINES, MemoryDocumentStore, type LargeFilesOptions, type PreviewContext } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";
import { utf8 } from "./fake-model.js";

const ALICE = { owner: "alice", scope: ["alice", "chat-1"] };
const roster = (tag: string) => Array.from({ length: 120 }, (_, i) => `עובד ${tag}${i + 1} | ת.ז. 7${String(10000000 + i * 7919).padStart(8, "0")} | שכר ${9000 + i}`).join("\n");

function library(options: Partial<LargeFilesOptions> = {}) {
  let clock = Date.parse("2026-11-27T08:00:00.000Z");
  const now = () => new Date(clock);
  const files = createLargeFiles({ store: new MemoryDocumentStore({ now }), now, ttlMs: 60_000, ...options });
  return { files, advance: (ms: number) => { clock += ms; } };
}

describe("files.readLines", () => {
  it("reads the stored lines of the version asked for, at most 50 lines and 8 KB", async () => {
    const { files } = library();
    const meta = await files.ingest({ name: "salaries.txt", bytes: utf8(roster("A")), id: "upload-1", ...ALICE });
    const first = await files.readLines("upload-1", [2, 4], ALICE);
    expect(first).toMatchObject({ document: { id: "upload-1", name: "salaries.txt" }, lines: [{ n: 2 }, { n: 3 }, { n: 4 }], truncated: false });
    expect((first as { lines: Array<{ text: string }> }).lines[0]!.text).toMatch(/^עובד A2 /);
    const version = (first as { version: string }).version;
    expect(version).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // Opaque: never the owner, the scope or the date that documentVersion holds.
    expect(version).not.toMatch(/alice|chat|2026/);
    expect(await files.readLines("upload-1", [2, 4], ALICE, { version })).toEqual(first);
    const many = await files.readLines("upload-1", [1, 200], ALICE);
    expect(many).toMatchObject({ truncated: true });
    expect((many as { lines: unknown[] }).lines).toHaveLength(MAX_PREVIEW_LINES);
    // The end of the file is no truncation; past it there is nothing.
    expect(await files.readLines("upload-1", [118, 130], ALICE)).toMatchObject({ lines: [{ n: 118 }, { n: 119 }, { n: 120 }], truncated: false });
    expect(await files.readLines("upload-1", [500, 501], ALICE)).toMatchObject({ lines: [], truncated: false });
    expect(meta.id).toBe("upload-1");
  });

  it("keeps a preview of wide lines within 8 KB, and still shows the start of one wider line", async () => {
    const { files } = library();
    const wide = Array.from({ length: 30 }, (_, i) => `${i + 1} ${"ש".repeat(270)}`).join("\n");
    await files.ingest({ name: "wide.txt", bytes: utf8(wide), id: "wide-1", ...ALICE });
    const read = (await files.readLines("wide-1", [1, 30], ALICE)) as { lines: Array<{ text: string }>; truncated: boolean };
    expect(read.truncated).toBe(true);
    const bytes = read.lines.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(read.lines.length).toBeGreaterThan(10);
    await files.ingest({ name: "one.txt", bytes: utf8("א".repeat(1_900)), id: "one-1", ...ALICE });
    const one = (await files.readLines("one-1", [1, 1], ALICE)) as { lines: Array<{ text: string }>; truncated: boolean };
    expect(one.truncated).toBe(false);
    expect(Buffer.byteLength(one.lines[0]!.text)).toBe(3_800);
  });

  it("refuses a range that is not two whole numbers of 1 or more", async () => {
    const { files } = library();
    for (const range of [[0, 2], [1.5, 2], [1], "1-2", [1, Number.NaN]] as unknown[]) {
      await expect(files.readLines("upload-1", range as [number, number], ALICE)).rejects.toThrow(TypeError);
    }
  });

  it("answers { changed: true } with no text for the old version of a replaced document", async () => {
    const { files, advance } = library();
    await files.ingest({ name: "salaries.txt", bytes: utf8(roster("A")), id: "upload-1", ...ALICE });
    const { version: v1 } = (await files.readLines("upload-1", [2, 2], ALICE)) as { version: string };
    advance(5);
    await files.ingest({ name: "salaries.txt", bytes: utf8(roster("B")), id: "upload-1", ifExists: "replace", ...ALICE });
    expect(await files.readLines("upload-1", [2, 2], ALICE, { version: v1 })).toEqual({ changed: true });
    const fresh = await files.readLines("upload-1", [2, 2], ALICE);
    expect((fresh as { lines: Array<{ text: string }> }).lines[0]!.text).toMatch(/^עובד B2 /);
    // The same bytes stored again are a new version too: the chip says "changed" rather than guess.
    const { version: v2 } = fresh as { version: string };
    expect(v2).not.toBe(v1);
    advance(5);
    await files.ingest({ name: "salaries.txt", bytes: utf8(roster("B")), id: "upload-1", ifExists: "replace", ...ALICE });
    expect(await files.readLines("upload-1", [2, 2], ALICE, { version: v2 })).toEqual({ changed: true });
  });

  it("answers undefined alike for another owner, another scope, no scope, deleted, expired and never stored", async () => {
    const { files, advance } = library();
    await files.ingest({ name: "salaries.txt", bytes: utf8(roster("A")), id: "upload-1", ...ALICE });
    const { version } = (await files.readLines("upload-1", [2, 2], ALICE)) as { version: string };
    await files.ingest({ name: "gone.txt", bytes: utf8("a\nb"), id: "upload-2", ...ALICE });
    await files.delete("upload-2", ALICE);
    await files.ingest({ name: "old.txt", bytes: utf8("a\nb"), id: "upload-3", ...ALICE });
    const asks = {
      otherOwner: () => files.readLines("upload-1", [2, 2], { owner: "bob", scope: ["alice", "chat-1"] }, { version }),
      otherScope: () => files.readLines("upload-1", [2, 2], { owner: "alice", scope: ["alice", "chat-2"] }, { version }),
      noScope: () => files.readLines("upload-1", [2, 2], { owner: "alice" }, { version }),
      // A wrong version from someone who may not read the file is undefined (404), never 409: no existence leak.
      otherOwnerOtherVersion: () => files.readLines("upload-1", [2, 2], { owner: "bob", scope: ["alice", "chat-1"] }, { version: "AAAAAAAAAAAAAAAA" }),
      deleted: () => files.readLines("upload-2", [1, 1], ALICE),
      neverStored: () => files.readLines("upload-404", [1, 1], ALICE),
      notAnId: () => files.readLines("../etc/passwd", [1, 1], ALICE),
    };
    for (const [name, ask] of Object.entries(asks)) expect(await ask(), name).toBeUndefined();
    advance(61_000);
    expect(await files.readLines("upload-3", [1, 1], ALICE)).toBeUndefined();
  });

  it("goes through onPreview, which is given a read_document call and fails closed", async () => {
    const seen: PreviewContext[] = [];
    const mask: LargeFilesOptions["onPreview"] = (context) => {
      seen.push(context);
      return { result: { ...context.result, text: String(context.result.text).replace(/\d{9}/g, "[ת.ז.]") } };
    };
    const masked = library({ onPreview: mask });
    await masked.files.ingest({ name: "salaries.txt", bytes: utf8(roster("A")), id: "upload-1", ...ALICE });
    const read = await masked.files.readLines("upload-1", [2, 4], ALICE);
    expect(JSON.stringify(read)).not.toMatch(/7\d{8}/);
    expect(read).toMatchObject({ lines: [{ n: 2, text: expect.stringContaining("[ת.ז.]") }, { n: 3 }, { n: 4 }] });
    expect(seen[0]).toMatchObject({ call: { name: "read_document", args: { document_id: "upload-1", start_line: 2, end_line: 4 } }, documentId: "upload-1", owner: "alice", scope: ALICE.scope, preview: true });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    // A call's own hook in its place, and null for none.
    expect(JSON.stringify(await masked.files.readLines("upload-1", [2, 2], ALICE, { onPreview: null }))).toMatch(/7\d{8}/);
    expect(await masked.files.readLines("upload-1", [2, 2], ALICE, { onPreview: () => ({ reject: "secret" }) })).toEqual({ rejected: true });
    // A hook does not widen a preview: lines outside the range asked are left out.
    const wider = await masked.files.readLines("upload-1", [2, 2], ALICE, { onPreview: () => ({ result: { text: "1| other\n2| two\n3| three" } }) });
    expect(wider).toMatchObject({ lines: [{ n: 2, text: "two" }] });
    for (const onPreview of [() => { throw new Error("DLP service down: עובד A2"); }, () => ({ text: "x" }), () => ({ reject: 5 }), () => "yes", async () => ({ result: "text" })] as unknown as Array<LargeFilesOptions["onPreview"]>) {
      const guarded = library({ onPreview });
      await guarded.files.ingest({ name: "salaries.txt", bytes: utf8(roster("A")), id: "upload-1", ...ALICE });
      const outcome = await guarded.files.readLines("upload-1", [2, 4], ALICE).catch((error: unknown) => ({ threw: String(error) }));
      expect(outcome).toHaveProperty("threw");
      expect(JSON.stringify(outcome)).not.toMatch(/עובד|7\d{8}/);
    }
  });
});

describe("the preview route (createDocumentHandlers, preview)", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => { if (!server) return resolve(); server.closeAllConnections(); server.close(() => resolve()); server = undefined; }));

  async function serve(owner: string, scope: string[], files: ReturnType<typeof library>["files"], onPreview: LargeFilesOptions["onPreview"] | null = null) {
    const handlers = createDocumentHandlers(files, { getOwner: () => owner, getScope: () => scope, preview: { onPreview: onPreview ?? null } });
    server = createServer((request, response) => {
      const url = new URL(request.url!, "http://x");
      void handlers.preview!(request, response, url.pathname.split("/")[2]!);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  const answer = async (response: Response) => ({ status: response.status, body: await response.text(), type: response.headers.get("content-type"), cache: response.headers.get("cache-control") });

  it("answers 200 private no-store, 409 changed with no text, and the same 404 for every missing case", async () => {
    const { files, advance } = library();
    await files.ingest({ name: "salaries.txt", bytes: utf8(roster("A")), id: "upload-1", ...ALICE });
    await files.ingest({ name: "gone.txt", bytes: utf8("a\nb"), id: "upload-2", ...ALICE });
    await files.delete("upload-2", ALICE);
    let base = await serve("alice", ALICE.scope, files);
    const ok = await fetch(`${base}/documents/upload-1/lines?from=2&to=4`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    const okBody = await ok.json() as { version: string; lines: unknown[] };
    expect(okBody.lines).toHaveLength(3);
    const { version } = okBody;
    // `to` defaults to `from`.
    expect(((await (await fetch(`${base}/documents/upload-1/lines?from=7`)).json()) as { lines: unknown[] }).lines).toHaveLength(1);
    advance(5);
    await files.ingest({ name: "salaries.txt", bytes: utf8(roster("B")), id: "upload-1", ifExists: "replace", ...ALICE });
    const changed = await fetch(`${base}/documents/upload-1/lines?from=2&to=4&version=${version}`);
    expect(changed.status).toBe(409);
    expect(changed.headers.get("cache-control")).toBe("private, no-store");
    const changedBody = await changed.text();
    expect(changedBody).not.toMatch(/עובד/);
    expect(JSON.parse(changedBody)).toMatchObject({ code: "changed" });
    const missing = await answer(await fetch(`${base}/documents/upload-404/lines?from=1&to=1`));
    expect(missing.status).toBe(404);
    expect(missing.cache).toBe("private, no-store");
    expect(await answer(await fetch(`${base}/documents/upload-2/lines?from=1&to=1`))).toEqual(missing);
    server!.closeAllConnections();
    server!.close();
    base = await serve("bob", ALICE.scope, files);
    // Another owner with an old version: the same 404, not a 409.
    const bob = await answer(await fetch(`${base}/documents/upload-1/lines?from=2&to=4&version=${version}`));
    expect(bob).toEqual(missing);
    server!.closeAllConnections();
    server!.close();
    base = await serve("alice", ["alice", "chat-2"], files);
    expect(await answer(await fetch(`${base}/documents/upload-1/lines?from=2&to=4`))).toEqual(missing);
  });

  it("answers 403 for a rejected preview, 500 for a hook that fails, and 400 for bad lines, all with no text", async () => {
    const { files } = library();
    await files.ingest({ name: "salaries.txt", bytes: utf8(roster("A")), id: "upload-1", ...ALICE });
    let base = await serve("alice", ALICE.scope, files, () => ({ reject: "no previews here" }));
    const refused = await answer(await fetch(`${base}/documents/upload-1/lines?from=2&to=4`));
    expect(refused.status).toBe(403);
    expect(refused.body).not.toMatch(/עובד|no previews here/);
    server!.closeAllConnections();
    server!.close();
    base = await serve("alice", ALICE.scope, files, () => { throw new Error("DLP down: עובד A2"); });
    const failed = await answer(await fetch(`${base}/documents/upload-1/lines?from=2&to=4`));
    expect(failed.status).toBe(500);
    expect(failed.body).not.toMatch(/עובד|DLP/);
    expect(failed.cache).toBe("private, no-store");
    for (const query of ["", "?from=0", "?from=x&to=2", "?from=2&to=-1", "?from=1e3"]) {
      const bad = await answer(await fetch(`${base}/documents/upload-1/lines${query}`));
      expect(bad.status, query).toBe(400);
    }
  });

  it("is off unless asked for, and asks for a decision on onPreview", () => {
    const { files } = library();
    const base = { getOwner: () => "alice", getScope: () => ALICE.scope };
    expect(createDocumentHandlers(files, base).preview).toBeUndefined();
    for (const preview of [true, {}, { onPreview: undefined }, { onPreview: "mask" }, null, false]) {
      expect(() => createDocumentHandlers(files, { ...base, preview: preview as never }), JSON.stringify(preview)).toThrow(TypeError);
    }
    expect(typeof createDocumentHandlers(files, { ...base, preview: { onPreview: null } }).preview).toBe("function");
    expect(typeof createDocumentHandlers(files, { ...base, preview: { onPreview: () => undefined } }).preview).toBe("function");
    // A LargeFiles of your own without readLines cannot serve it.
    const { readLines: _readLines, ...withoutReadLines } = files;
    expect(() => createDocumentHandlers(withoutReadLines as never, { ...base, preview: { onPreview: null } })).toThrow(TypeError);
  });
});
