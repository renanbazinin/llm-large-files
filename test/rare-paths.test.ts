// Paths that no test ran before 0.6.1, as the review of 0.6.0 found: the rename that Windows
// refuses for a moment, upload limits on bodies that are streamed or already parsed, page numbers of
// a PDF read by range, waits of 0 for a silent model, and a pointer to a result that was shortened.
import "./load-pdf-libraries.js";
import fsp, { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, FileDocumentStore, MemoryDocumentStore, type DocumentMeta, type LargeFiles, type ModelMessage, type ModelToolRound } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { createDocumentHandlers } from "llm-large-files/node";
import { openAiCompatible } from "llm-large-files/openai";
import { idleWatch } from "../src/http.js";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";
import { numberedPdf } from "./pdf-fixtures.js";

let directory: string | undefined;
let server: Server | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  restore = undefined;
  if (server) {
    // A client may keep a connection open after an upload it was refused: do not wait for it.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function folder(): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), "llf-rare-"));
  return directory;
}

const log = (lines: number) => Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} took ${i % 900}ms`).join("\n");

/**
 * Makes the next `times` calls of `rename` fail with `code`, the way Windows refuses to replace a
 * file that a reader or a virus scanner has open for a moment. Notes the target of every call.
 */
function failRename(times: number, code: string): string[] {
  const table = fsp as unknown as { rename: (...args: unknown[]) => Promise<unknown> };
  const real = table.rename;
  const targets: string[] = [];
  let left = times;
  table.rename = function (this: unknown, ...args: unknown[]) {
    targets.push(String(args[1]));
    if (left-- > 0) return Promise.reject(Object.assign(new Error(`${code}: operation not permitted, rename '${String(args[0])}'`), { code, syscall: "rename" }));
    return real.apply(this, args);
  };
  syncBuiltinESMExports();
  restore = () => {
    table.rename = real;
    syncBuiltinESMExports();
  };
  return targets;
}

describe("FileDocumentStore when a rename is refused for a moment (Windows)", () => {
  it("tries the rename again, and stores the document whole", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir) });
    const targets = failRename(2, "EPERM");
    const meta = await files.ingest({ name: "app.log", bytes: utf8(log(50)) });
    // The first file written was renamed on the third try.
    expect(targets[0]).toBe(targets[1]);
    expect(targets[1]).toBe(targets[2]);
    expect(targets.length).toBeGreaterThan(3);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const tools = files.tools([meta]);
    expect(await tools.execute("read_document", { document_id: meta.id, start_line: 50, end_line: 50 })).toMatchObject({ text: expect.stringContaining("request 49 took 49ms") });
  });

  it("gives up after about three seconds of tries, and leaves no file behind", { timeout: 30_000 }, async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir) });
    const targets = failRename(Number.POSITIVE_INFINITY, "EBUSY");
    const started = performance.now();
    await expect(files.ingest({ name: "app.log", bytes: utf8(log(50)) })).rejects.toMatchObject({ code: "EBUSY" });
    // One try and ten more, with pauses that add up to 2.63 s.
    expect(targets).toHaveLength(11);
    expect(new Set(targets).size).toBe(1);
    expect(performance.now() - started).toBeGreaterThan(2_500);
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not try again a rename that fails for another reason", async () => {
    const dir = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(dir) });
    const targets = failRename(1, "ENOSPC");
    await expect(files.ingest({ name: "app.log", bytes: utf8(log(50)) })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(targets).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("createDocumentHandlers and the size of an upload", () => {
  const LIMIT = 1024 * 1024;

  /** A server whose framework may have read the body already (express.raw(), express.json()). */
  async function start(parsed?: () => unknown): Promise<number> {
    const documents = createDocumentHandlers(createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes: LIMIT }));
    server = createServer((request, response) => {
      const body = parsed?.();
      if (body !== undefined) (request as typeof request & { body?: unknown }).body = body;
      void documents.upload(request, response);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server!.address() as AddressInfo).port;
  }

  /** Posts `chunks` as a stream, as a browser streams a file: without a Content-Length. */
  async function post(port: number, name: string, chunks: Uint8Array[]): Promise<{ status: number; body: Record<string, unknown> }> {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "X-File-Name": name }, body, duplex: "half" } as RequestInit);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("refuses a streamed upload as soon as it passes the limit, and keeps serving", async () => {
    const port = await start();
    const twoMegabytes = Array.from({ length: 32 }, () => new Uint8Array(64 * 1024).fill(0x61));
    expect(await post(port, "big.txt", twoMegabytes)).toEqual({ status: 413, body: { error: "The file is larger than the 1 MB upload limit." } });
    expect(await post(port, "small.txt", [utf8("hello\nworld\n")])).toMatchObject({ status: 201, body: { name: "small.txt", lines: 2 } });
  });

  it("checks the limit on a body that a framework already read into a Buffer", async () => {
    let body: Buffer = Buffer.alloc(LIMIT + 1, 0x61);
    const port = await start(() => body);
    expect(await post(port, "raw.txt", [])).toEqual({ status: 413, body: { error: "The file is larger than the 1 MB upload limit." } });
    body = Buffer.from("hello\nworld\n");
    expect(await post(port, "raw.txt", [])).toMatchObject({ status: 201, body: { name: "raw.txt", lines: 2 } });
  });

  it("refuses a body that a framework already parsed into an object, and says how to mount the route", async () => {
    const port = await start(() => ({ hello: "world" }));
    expect(await post(port, "x.json", [])).toEqual({
      status: 400,
      body: { error: "The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream." },
    });
  });

  it("keeps a file name that is not valid URI encoding as it was sent", async () => {
    const port = await start();
    expect(await post(port, "%E0%A4%A.txt", [utf8("hello\n")])).toMatchObject({ status: 201, body: { name: "%E0%A4%A.txt" } });
  });
});

describe("page numbers of a PDF read by range", () => {
  const strip = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/doc_[0-9a-f]{32}/g, "DOC")) as Record<string, unknown>;

  it("are those of the same PDF loaded whole", async () => {
    const bytes = numberedPdf(40);
    const whole = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    // wholeDocumentBytes 0: every document is read by range, as a large one is.
    const ranged = createLargeFiles({ store: new FileDocumentStore(await folder()), keepOriginals: ["pdf"], wholeDocumentBytes: 0, scanChunkBytes: 256 });
    const results = async (files: LargeFiles) => {
      const meta: DocumentMeta = await files.ingest({ name: "book.pdf", bytes });
      const tools = files.tools([meta], { viewPages: true });
      const run = async (name: string, args: Record<string, unknown>) => strip(await tools.execute(name, { document_id: meta.id, ...args }));
      return [
        await run("search_document", { query: "Page 37 of", mode: "exact" }),
        await run("search_document", { query: "Page 2\\d of", mode: "regex" }),
        await run("search_document", { query: "test file", mode: "keywords" }),
        await run("read_document", { start_line: 1, end_line: 200 }),
        await run("read_document", { start_line: meta.lines - 1, end_line: meta.lines }),
      ];
    };
    const [fromWhole, fromRange] = [await results(whole), await results(ranged)];
    expect(fromRange).toEqual(fromWhole);
    expect(fromRange[0]).toMatchObject({ total_matching_lines: 1, matches: [{ page: 37 }] });
    expect((fromRange[1]!.matches as Array<{ page: number }>).map((match) => match.page)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(fromRange[3]).toMatchObject({ pages: expect.stringMatching(/^1-\d+$/) });
    expect(fromRange[4]).toMatchObject({ pages: "40" });
  });
});

describe("waits of 0 for a silent model", () => {
  const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "?" }] }] };
  /** A fetch that answers `body` after 300 ms, or ends with the signal's reason when it aborts first. */
  const slow = (body: unknown) => (async (_url: unknown, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    });
    return Response.json(body);
  }) as typeof globalThis.fetch;
  const openAiBody = { choices: [{ index: 0, message: { role: "assistant", content: "fine" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const claudeBody = { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "fine" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

  it("watch nothing: the caller's signal is the request's", () => {
    const caller = new AbortController().signal;
    expect(idleWatch(caller, { firstByteTimeoutMs: 0, idleTimeoutMs: 0 }).signal).toBe(caller);
    expect(idleWatch(undefined, { firstByteTimeoutMs: 0, idleTimeoutMs: 0 }).signal).toBeUndefined();
  });

  it("wait for a slow reply without end, where a short wait gives up", async () => {
    const forever = { firstByteTimeoutMs: 0, idleTimeoutMs: 0, retry: { retries: 0 } };
    expect((await openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", stream: false, fetch: slow(openAiBody), ...forever }).send(request)).text).toBe("fine");
    expect((await anthropic({ model: "claude-test", apiKey: "k", stream: false, fetch: slow(claudeBody), ...forever }).send(request)).text).toBe("fine");
    const short = { firstByteTimeoutMs: 100, idleTimeoutMs: 100, retry: { retries: 0, random: () => 1, sleep: async () => undefined } };
    await expect(openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", stream: false, fetch: slow(openAiBody), ...short }).send(request)).rejects.toMatchObject({ status: 0, kind: "timeout" });
    await expect(anthropic({ model: "claude-test", apiKey: "k", stream: false, fetch: slow(claudeBody), ...short }).send(request)).rejects.toMatchObject({ status: 0, kind: "timeout" });
  });
});

describe("a pointer to an earlier result, when older results are shortened in the same turn", () => {
  const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");

  /**
   * Runs the turns of `script` (calls named by their place: c<turn>_<index>) over a log of 6,000
   * lines with an ERROR every 50th, in a window too small for the last turn, whose three reads of
   * 600 lines make the loop shorten the older results.
   */
  async function run(script: (id: string) => Array<Array<{ name: string; args: Record<string, unknown> }>>) {
    const lines = Array.from({ length: 6_000 }, (_, i) => {
      const n = i + 1;
      return `2026-11-12T08:00:${String(n % 60).padStart(2, "0")}Z ${n % 50 === 0 ? "ERROR" : "INFO"} [w-${n % 8}] req=${(n * 2654435761 >>> 0).toString(16)} GET /api/orders/${n} took ${(n * 37) % 900}ms`;
    });
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 40_000, inlineTokens: 1_000, toolResultCharacters: 30_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(lines.join("\n")) });
    const turns = script(meta.id);
    const model = fakeModel([(_request, call) => {
      const list = turns[call - 1];
      return list ? calls(list.map((entry, index) => ({ id: `c${call}_${index}`, ...entry, args: { ...entry.args } }))) : says("The errors are on every 50th line.");
    }], { toolFiles: "none", contextTokens: 40_000 });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "List the errors." }], limits: { toolTurns: 8 } });
    // What the model was sent after the last turn of calls.
    const answers = roundsOf(model.requests[turns.length]!.messages).flatMap((round) => round.answers);
    return { steps: result.steps, answerOf: (id: string) => answers.find((answer) => answer.call.id === id)?.result };
  }
  const search = (id: string) => ({ name: "search_document", args: { document_id: id, query: "ERROR", mode: "exact" } });
  const read = (id: string, from: number, count = 600) => ({ name: "read_document", args: { document_id: id, start_line: from, end_line: from + count - 1 } });

  it("is dropped when its result is shortened, and the call is run after all", async () => {
    // The search of turn 1 is still shown in full when turn 3 repeats it, then shortened in turn 3.
    const { steps, answerOf } = await run((id) => [[search(id)], [read(id, 1, 20)], [search(id), read(id, 1), read(id, 601), read(id, 1_201)]]);
    expect(steps).toContain("Older tool results were shortened to make room in the request");
    expect(steps.some((step) => step.endsWith("already shown above"))).toBe(false);
    // The first search is a stand-in now, which says which lines it showed.
    expect(answerOf("c1_0")).toMatchObject({
      document: "app.log",
      dropped: true,
      mode: "exact",
      query: "ERROR",
      total_matching_lines: 120,
      lines_shown: expect.arrayContaining(["50", "100"]),
      note: "The results of this search were shown to you earlier and were dropped from the conversation to make room. Read the lines listed here with read_document, or search again, if you need them.",
    });
    // So the same search in turn 3 was run again, and not pointed to it.
    expect(answerOf("c3_0")).toMatchObject({ total_matching_lines: 120 });
    expect(answerOf("c3_0")).not.toHaveProperty("already_shown");
  });

  it("is kept when its result is still shown in full", async () => {
    // The read of turn 1 is shortened in turn 3; the search of turn 2, the last round, is kept.
    const { steps, answerOf } = await run((id) => [[read(id, 1)], [search(id)], [search(id), read(id, 601), read(id, 1_201), read(id, 1_801)]]);
    expect(steps).toContain("Older tool results were shortened to make room in the request");
    expect(steps).toContain("Search app.log (exact) for “ERROR” — already shown above");
    expect(answerOf("c1_0")).toMatchObject({ dropped: true });
    expect(answerOf("c2_0")).toMatchObject({ total_matching_lines: 120 });
    expect(answerOf("c3_0")).toMatchObject({ already_shown: true });
  });
});
