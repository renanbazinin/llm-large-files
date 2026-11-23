import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, DocumentsNotFoundError, FileDocumentStore, MemoryDocumentStore, type Extractor, type LargeFiles, type StoredDocument } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";
import { fakeModel, says, utf8 } from "./fake-model.js";
import { heldExtractor, until, uploadServer } from "./upload-server.js";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

/**
 * The heap in use after full collections, once pending timers have run. Three, a turn of the loop
 * apart: one collection right after an ingest has left 14 MB of its garbage for the next (Node 20).
 */
async function heapKept(): Promise<number> {
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    collectGarbage();
  }
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

describe("the meta that ingest returns (0.8.2)", () => {
  // About 2 s with one test file at a time, 5.5 s beside the other files on a busy machine.
  it("does not keep the text in memory through the log's timestamps or the outline's headings", { timeout: 20_000 }, async () => {
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
    const all = Array.from({ length: 5 }, (_, index) => files.ingest({ name: `f${index}.txt`, bytes: utf8(`file ${index}`) }));
    await until(() => state.running === 2);
    // Nothing more starts while those two work.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls).toBe(2);
    // One at a time: each freed turn goes to the one that has waited longest.
    for (let started = 2; started < 5; started++) {
      state.releaseOne();
      await until(() => state.calls === started + 1);
    }
    state.releaseAll();
    await until(() => state.running === 0);
    await Promise.all(all);
    expect(state.most).toBe(2);
    expect(state.names).toEqual(["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
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

  it("refuses an empty file, or one over the upload limit, without waiting for a turn", async () => {
    const { state, extract } = heldExtractor();
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: extract }, maxConcurrentIngests: 1, maxUploadBytes: 10 });
    const held = files.ingest({ name: "a.txt", bytes: utf8("a") });
    await until(() => state.running === 1);
    await expect(files.ingest({ name: "empty.txt", bytes: new Uint8Array(0) })).rejects.toThrow("empty.txt is empty.");
    await expect(files.ingest({ name: "big.txt", bytes: utf8("x".repeat(20)) })).rejects.toThrow("big.txt is larger than the 10 B upload limit.");
    state.releaseAll();
    await held;
  });

  it("keeps the turn of an ingest whose extractor goes on after its time is up, until the extractor ends", async () => {
    // An extractor that does not look at the signal, as pdf-lib's parse of a PDF does not.
    let running = 0;
    let most = 0;
    const deaf: Extractor = async (bytes) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 250));
      running--;
      return { text: new TextDecoder().decode(bytes) };
    };
    const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: { text: deaf }, maxConcurrentIngests: 1, ingestTimeoutMs: 150 });
    const results = await Promise.allSettled([files.ingest({ name: "a.txt", bytes: utf8("a") }), files.ingest({ name: "b.txt", bytes: utf8("b") })]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(/a\.txt took too long to read/);
    // The second extractor started only once the first had ended.
    expect(most).toBe(1);
  }, 15_000);

  it("fails an ingest whose store write does not end, after its time limit, and gives the turn back", async () => {
    class HangingStore extends MemoryDocumentStore {
      hung = 0;
      override async put(document: StoredDocument): Promise<void> {
        if (this.hung < 2) {
          this.hung++;
          return new Promise<void>(() => {});
        }
        return super.put(document);
      }
    }
    const store = new HangingStore();
    const files = createLargeFiles({ store, ingestTimeoutMs: 300 });
    const hung = [files.ingest({ name: "a.txt", bytes: utf8("a") }), files.ingest({ name: "b.txt", bytes: utf8("b") })].map((ingest) => ingest.catch((error: unknown) => error));
    await until(() => store.hung === 2);
    // The third gets a turn once the writes have failed, 300 ms later.
    const third = await files.ingest({ name: "c.txt", bytes: utf8("c") });
    expect(third.name).toBe("c.txt");
    const errors = await Promise.all(hung);
    // A DocumentStoreError since 0.9.0, with the code ETIMEDOUT; what happened is its cause.
    expect(errors[0]).toMatchObject({ name: "DocumentStoreError", operation: "write", code: "ETIMEDOUT", status: 503, message: "The document could not be stored (ETIMEDOUT). Try again." });
    expect(((errors[0] as Error).cause as Error).message).toBe("The store did not finish writing a.txt within 300 ms.");
  }, 15_000);

  it("removes a document whose write ended after the ingest failed for it", async () => {
    class LateStore extends MemoryDocumentStore {
      override async put(document: StoredDocument): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return super.put(document);
      }
    }
    const store = new LateStore();
    const files = createLargeFiles({ store, ingestTimeoutMs: 150 });
    let id: string | undefined;
    const spy = store.put.bind(store);
    store.put = async (document) => {
      id = document.meta.id;
      return spy(document);
    };
    await expect(files.ingest({ name: "a.txt", bytes: utf8("a") })).rejects.toMatchObject({ code: "ETIMEDOUT", cause: new Error("The store did not finish writing a.txt within 150 ms.") });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(id).toMatch(/^doc_/);
    expect(await store.getMeta(id!)).toBeUndefined();
  }, 15_000);

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
  const start = (handlerOptions: Parameters<typeof createDocumentHandlers>[1], maxUploadBytes = 4_000, store = new MemoryDocumentStore()) =>
    uploadServer(handlerOptions, maxUploadBytes, store, (made) => (server = made));

  it("answers 503 with Retry-After, before reading the body, an upload that would pass the limit", async () => {
    const { state, url, upload } = await start({ maxPendingUploadBytes: 1_000 });
    const first = upload("a.txt", 600);
    await until(() => state.running === 1);
    // Headers and 10 bytes of a body of 600, then nothing: the 503 comes anyway.
    const head = await rawRequest(url, "POST /upload HTTP/1.1\r\nHost: x\r\nX-File-Name: b.txt\r\nContent-Length: 600\r\n\r\n" + "x".repeat(10));
    expect(head).toMatch(/^HTTP\/1\.1 503 /);
    expect(head).toMatch(/\r\nretry-after: 5\r\n/i);
    const refused = await upload("b.txt", 600);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "The server is receiving other files right now. Try again in a moment." });
    // A body that a framework already read, and that is over maxUploadBytes, is too large, not busy.
    const parsed = await fetch(url, { method: "POST", headers: { "X-File-Name": "p.txt", "X-Parsed-Size": "5000" }, body: "x" });
    expect(parsed.status).toBe(413);
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

  it("answers 408 an upload whose body stops arriving, and gives its room back", async () => {
    const { state, url, upload } = await start({ maxPendingUploadBytes: 1_000, uploadIdleTimeoutMs: 200 });
    // Headers that announce 900 bytes, then nothing: the room is held until the idle time is up.
    const started = performance.now();
    const answer = await rawRequest(url, "POST /upload HTTP/1.1\r\nHost: x\r\nX-File-Name: slow.txt\r\nContent-Length: 900\r\n\r\n" + "x".repeat(10), { waitForClose: true });
    expect(answer).toMatch(/^HTTP\/1\.1 408 /);
    expect(answer).toMatch(/\r\nconnection: close\r\n/i);
    expect(answer).toContain("The upload stopped arriving: nothing came for 200 ms. Send it again.");
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    // Its room is back.
    const next = upload("next.txt", 900);
    await until(() => state.running === 1);
    state.releaseAll();
    expect((await next).status).toBe(201);
  });

  it("keeps counting with an upload limit of Infinity and a body without Content-Length", async () => {
    const { state, url, upload } = await start({ maxPendingUploadBytes: 1_000 }, Number.POSITIVE_INFINITY);
    const chunked = new Promise<number>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: { "X-File-Name": "chunked.txt" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      // Written in two parts, so that Node sends it chunked, without a Content-Length.
      request.write("x".repeat(50));
      setTimeout(() => request.end("x".repeat(50)), 20);
    });
    await until(() => state.running === 1);
    state.releaseAll();
    expect(await chunked).toBe(201);
    // The count is still a number: the limit still holds.
    const first = upload("a.txt", 800);
    await until(() => state.running === 1);
    expect((await upload("b.txt", 800)).status).toBe(503);
    state.releaseAll();
    expect((await first).status).toBe(201);
  });

  it("holds an upload answered as events until its ingest ends, also when the client goes away", async () => {
    class SlowStore extends MemoryDocumentStore {
      writing = 0;
      finish: Array<() => void> = [];
      override async put(document: StoredDocument): Promise<void> {
        this.writing++;
        await new Promise<void>((resolve) => this.finish.push(resolve));
        return super.put(document);
      }
    }
    const store = new SlowStore();
    const { state, url, upload } = await start({ maxPendingUploadBytes: 1_000 }, 4_000, store);
    const leaving = new AbortController();
    const events = fetch(url, { method: "POST", headers: { "X-File-Name": "a.txt", Accept: "text/event-stream" }, body: "x".repeat(800), signal: leaving.signal }).catch(() => undefined);
    await until(() => state.running === 1);
    state.releaseAll();
    await until(() => store.writing === 1);
    leaving.abort();
    await events;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Its write is still under way: it still holds its room.
    expect((await upload("b.txt", 800)).status).toBe(503);
    store.finish.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = upload("c.txt", 800);
    await until(() => state.running === 1);
    state.releaseAll();
    await until(() => store.writing === 2);
    store.finish.splice(0).forEach((resolve) => resolve());
    expect((await next).status).toBe(201);
  });

  it("gives the room of uploads back when their store writes do not end", async () => {
    class HangingStore extends MemoryDocumentStore {
      hung = 0;
      override async put(document: StoredDocument): Promise<void> {
        if (this.hung < 2) {
          this.hung++;
          return new Promise<void>(() => {});
        }
        return super.put(document);
      }
    }
    const store = new HangingStore();
    const files = createLargeFiles({ store, maxUploadBytes: 1_000, ingestTimeoutMs: 300 });
    const documents = createDocumentHandlers(files);
    server = createServer((request, response) => void documents.upload(request, response));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/upload`;
    const upload = (name: string, size: number) => fetch(url, { method: "POST", headers: { "X-File-Name": name }, body: "x".repeat(size) });
    // Two uploads fill the room (twice maxUploadBytes), and their writes never end.
    const hung = [upload("a.txt", 1_000), upload("b.txt", 1_000)];
    await until(() => store.hung === 2);
    expect((await upload("c.txt", 1)).status).toBe(503);
    // After the time limit they fail with the store's 503 (a 500 before 0.9.0), and the room is back.
    expect((await Promise.all(hung)).map((response) => response.status)).toEqual([503, 503]);
    expect((await upload("d.txt", 1)).status).toBe(201);
  }, 15_000);

  it("checks the option", () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    expect(() => createDocumentHandlers(files, { uploadIdleTimeoutMs: -1 })).toThrow("uploadIdleTimeoutMs must be a number of 0 or more, and is -1. Leave it out for the default.");
    expect(() => createDocumentHandlers(files, { uploadIdleTimeoutMs: 0 })).not.toThrow();
    // A LargeFiles of your own must keep maxUploadBytes, as its type says.
    const { maxUploadBytes: _omitted, ...withoutLimit } = files;
    expect(() => createDocumentHandlers(withoutLimit as LargeFiles)).toThrow(TypeError);
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: 0 })).toThrow("maxPendingUploadBytes must be a number above 0, and is 0. Leave it out for the default.");
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: Number.NaN })).toThrow(RangeError);
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: "1" as never })).toThrow(RangeError);
    expect(() => createDocumentHandlers(files, { maxPendingUploadBytes: Number.POSITIVE_INFINITY })).not.toThrow();
  });
});

/**
 * Sends `text` on a socket of its own and resolves with what comes back: once an answer's head has
 * come, or, with `waitForClose`, once the server closes the connection. The socket is then closed.
 */
function rawRequest(url: string, text: string, options: { waitForClose?: boolean } = {}): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let received = "";
    const done = () => {
      socket.destroy();
      resolve(received);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!options.waitForClose && received.includes("\r\n\r\n")) done();
    });
    socket.on("close", done);
    socket.on("error", (error) => (received ? done() : reject(error)));
    socket.write(text);
  });
}
