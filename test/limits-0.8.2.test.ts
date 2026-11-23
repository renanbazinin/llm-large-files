import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, DocumentsNotFoundError, FileDocumentStore, MemoryDocumentStore, type Extractor } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";
import { fakeModel, says, utf8 } from "./fake-model.js";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

/** The heap in use after a full collection, once pending timers have run. */
async function heapKept(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

let directory: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function folder(): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), "llf-082-"));
  return directory;
}

/** Waits, a turn of the event loop at a time, until `ready` holds (at most about 5 s). */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 5_000 && !ready(); turn++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(ready()).toBe(true);
}

/** A text extractor that holds each file until the test lets it go, and counts how many it holds at once. */
function heldExtractor() {
  const waiting: Array<() => void> = [];
  const state = { calls: 0, running: 0, most: 0, waiting, releaseAll: () => waiting.splice(0).forEach((release) => release()) };
  const extract: Extractor = async (bytes) => {
    state.calls++;
    state.running++;
    state.most = Math.max(state.most, state.running);
    await new Promise<void>((resolve) => waiting.push(resolve));
    state.running--;
    return { text: new TextDecoder().decode(bytes) };
  };
  return { state, extract };
}

describe("the meta that ingest returns (0.8.2)", () => {
  it("does not keep the text in memory through the log's timestamps or the outline's headings", async () => {
    const files = createLargeFiles({ store: new FileDocumentStore(await folder()) });
    // About 4 MB of a log in Hebrew: held, its text took about 8 MB of heap (two bytes a character).
    const log: string[] = [];
    for (let line = 0; line < 30_000; line++) log.push(`2026-11-20T00:${String(Math.floor(line / 600) % 60).padStart(2, "0")}:${String(line % 60).padStart(2, "0")}.${String(line % 1000).padStart(3, "0")}Z INFO [gateway] req=${line.toString(16).padStart(8, "0")} user_text="מה הסטטוס של ההזמנה שלי? שורה ${line}" intent=order_status`);
    const markdown: string[] = [];
    for (let section = 0; section < 300; section++) {
      markdown.push(`## סעיף ${section + 1}: הוראות כלליות לגבי השכירות והתשלומים`);
      for (let line = 0; line < 60; line++) markdown.push(`השוכר ישלם למשכיר דמי שכירות חודשיים כפי שנקבע בהסכם זה, שורה ${section}-${line}.`);
    }
    for (const [name, text] of [["gateway.log", log.join("\n")], ["lease.md", markdown.join("\n")]] as const) {
      let meta = await files.ingest({ name, bytes: utf8(text) });
      expect(meta.format === "log" ? meta.logProfile?.firstTimestamp : meta.outline[0]?.title).toBeTruthy();
      const holding = await heapKept();
      meta = JSON.parse(JSON.stringify(meta)) as typeof meta;
      const copied = await heapKept();
      expect(holding - copied, name).toBeLessThan(1024 * 1024);
      expect(meta.id).toMatch(/^doc_/);
    }
  });
});

describe("a document whose text is gone while its metadata is still there (0.8.2)", () => {
  it("is missing, for prepare and for askWithFiles, also when it is read by range", async () => {
    const dir = await folder();
    for (const wholeDocumentBytes of [0, Number.POSITIVE_INFINITY]) {
      const files = createLargeFiles({ store: new FileDocumentStore(dir), wholeDocumentBytes });
      const meta = await files.ingest({ name: "a.txt", bytes: utf8(Array.from({ length: 2_000 }, (_, line) => `line ${line}`).join("\n")), owner: "u" });
      await unlink(path.join(dir, `${meta.id}.txt`));
      // It threw "doc_… is no longer available on the server" when read by range, failing the question.
      const prepared = await files.prepare([meta.id], { tokens: 0, bytes: 0 }, { owner: "u" });
      expect(prepared.missing).toEqual([meta.id]);
      const error = await askWithFiles({ files, model: fakeModel([says("never sent")]), documentIds: [meta.id], owner: "u", messages: [{ role: "user", text: "?" }] }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DocumentsNotFoundError);
      expect((error as DocumentsNotFoundError).ids).toEqual([meta.id]);
    }
  });
});

describe("maxConcurrentIngests (0.8.2)", () => {
  it("lets two ingests work at once by default, and the others wait their turn in order", async () => {
    const { state, extract } = heldExtractor();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extract } });
    const done: string[] = [];
    const all = Array.from({ length: 5 }, (_, index) => files.ingest({ name: `f${index}.txt`, bytes: utf8(`file ${index}`) }).then((meta) => done.push(meta.name)));
    await until(() => state.running === 2);
    // Nothing more starts while those two work.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls).toBe(2);
    while (done.length < 5) {
      state.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(all);
    expect(state.most).toBe(2);
    expect(done.slice(0, 2).sort()).toEqual(["f0.txt", "f1.txt"]);
  });

  it("runs every ingest at once with Infinity, and checks the option", async () => {
    const { state, extract } = heldExtractor();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extract }, maxConcurrentIngests: Number.POSITIVE_INFINITY });
    const all = Array.from({ length: 5 }, (_, index) => files.ingest({ name: `f${index}.txt`, bytes: utf8(`file ${index}`) }));
    await until(() => state.running === 5);
    state.releaseAll();
    await Promise.all(all);
    expect(() => createLargeFiles({ store: new MemoryDocumentStore(), maxConcurrentIngests: Number.NaN })).toThrow(RangeError);
    expect(() => createLargeFiles({ store: new MemoryDocumentStore(), maxConcurrentIngests: "2" as never })).toThrow(TypeError);
  });

  it("drops an ingest whose caller gives up while it waits, with the caller's reason", async () => {
    const { state, extract } = heldExtractor();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extract }, maxConcurrentIngests: 1 });
    const first = files.ingest({ name: "a.txt", bytes: utf8("a") });
    const cancel = new AbortController();
    const events: string[] = [];
    const waiting = files.ingest({ name: "b.txt", bytes: utf8("b"), signal: cancel.signal, onEvent: (event) => events.push(event.type) });
    await until(() => state.running === 1);
    const reason = new Error("The user left.");
    cancel.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(events).toEqual(["ingest.start", "ingest.error"]);
    state.releaseAll();
    await first;
    expect(state.calls).toBe(1);
  });

  it("starts the time limit of an ingest when its turn comes, not while it waits", async () => {
    // Each file takes 1.2 s; the limit is 2 s; the second ends 2.4 s after it was sent, and is read.
    const slow: Extractor = async (bytes) => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { text: new TextDecoder().decode(bytes) };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: slow }, maxConcurrentIngests: 1, ingestTimeoutMs: 2_000 });
    const metas = await Promise.all([files.ingest({ name: "a.txt", bytes: utf8("a") }), files.ingest({ name: "b.txt", bytes: utf8("b") })]);
    expect(metas.map((meta) => meta.name)).toEqual(["a.txt", "b.txt"]);
  }, 15_000);
});

describe("maxPendingUploadBytes of the upload handler (0.8.2)", () => {
  async function start(handlerOptions: Parameters<typeof createDocumentHandlers>[1], maxUploadBytes = 4_000) {
    const held = heldExtractor();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: held.extract }, maxUploadBytes, maxConcurrentIngests: 10 });
    const documents = createDocumentHandlers(files, handlerOptions);
    server = createServer((request, response) => void documents.upload(request, response));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/upload`;
    const upload = (name: string, size: number) => fetch(url, { method: "POST", headers: { "X-File-Name": name }, body: "x".repeat(size) });
    return { state: held.state, url, upload };
  }

  it("answers 503 with Retry-After, before reading the body, an upload that would pass the limit", async () => {
    const { state, upload } = await start({ maxPendingUploadBytes: 1_000 });
    const first = upload("a.txt", 600);
    await until(() => state.running === 1);
    const refused = await upload("b.txt", 600);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toEqual({ error: "The server is receiving other files right now. Try again in a moment." });
    // A smaller one fits in what is left.
    const fits = upload("c.txt", 300);
    await until(() => state.running === 2);
    // Too large is said before busy.
    expect((await upload("d.txt", 5_000)).status).toBe(413);
    state.releaseAll();
    expect((await first).status).toBe(201);
    expect((await fits).status).toBe(201);
    // Once they are done, the refused one is taken.
    const again = upload("b.txt", 600);
    await until(() => state.running === 1);
    state.releaseAll();
    expect((await again).status).toBe(201);
  });

  it("always takes one upload alone, and counts one without a Content-Length at its size once read", async () => {
    const { state, url, upload } = await start({ maxPendingUploadBytes: 4_000 });
    // Chunked: counted at maxUploadBytes (4,000) until read, then at its 600 bytes.
    const chunked = new Promise<number>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: { "X-File-Name": "chunked.txt" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.write("x".repeat(300));
      setTimeout(() => request.end("x".repeat(300)), 20);
    });
    await until(() => state.running === 1);
    const second = upload("b.txt", 3_000);
    await until(() => state.running === 2);
    state.releaseAll();
    expect(await chunked).toBe(201);
    expect((await second).status).toBe(201);
    // Alone, an upload larger than the limit (but within maxUploadBytes) is taken.
    const { state: other, upload: uploadSmall } = await (async () => {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      return start({ maxPendingUploadBytes: 100 });
    })();
    const alone = uploadSmall("big.txt", 3_000);
    await until(() => other.running === 1);
    other.releaseAll();
    expect((await alone).status).toBe(201);
  });

  it("checks the option", () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: 0 })).toThrow("maxPendingUploadBytes must be a number above 0, and is 0. Leave it out for the default.");
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: Number.NaN })).toThrow(RangeError);
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: "1" as never })).toThrow(RangeError);
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: Number.POSITIVE_INFINITY })).not.toThrow();
  });
});
