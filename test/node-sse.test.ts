import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { askStream, createLargeFiles, eventStream, MemoryDocumentStore, type AskEvent, type AskResult, type LargeFiles, type LargeFilesOptions } from "llm-large-files";
import { createDocumentHandlers, sseMessageOf, writeSseEvents } from "llm-large-files/node";
import { fakeModel, says } from "./fake-model.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
  server = undefined;
}));

type Tick = { type: string; seq: number; [key: string]: unknown };
type Message = { id?: string; event?: string; data?: unknown };

/** A server that answers every request with this handler. Its address. */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}

/** The messages of an event stream, and its comments. */
function parse(body: string): { messages: Message[]; comments: string[] } {
  const messages: Message[] = [];
  const comments: string[] = [];
  for (const block of body.split("\n\n")) {
    if (!block) continue;
    const message: Message = {};
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) comments.push(line.slice(1).trim());
      else if (line.startsWith("id: ")) message.id = line.slice(4);
      else if (line.startsWith("event: ")) message.event = line.slice(7);
      else if (line.startsWith("data: ")) message.data = JSON.parse(line.slice(6));
    }
    if (Object.keys(message).length) messages.push(message);
  }
  return { messages, comments };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* ticks(count: number, gapMs = 0): AsyncGenerator<Tick> {
  for (let seq = 1; seq <= count; seq++) {
    if (gapMs) await pause(gapMs);
    yield { type: seq === count ? "run.done" : "tick", seq, note: `tick ${seq}` };
  }
}

describe("writeSseEvents", () => {
  it("sends the event-stream headers and one id/event/data message per event, then ends", async () => {
    let finished = false;
    const url = await serve((_request, response) => {
      void writeSseEvents(response, ticks(3), { heartbeatMs: 0, headers: { "X-Run": "r1" } }).then(() => (finished = true));
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-run")).toBe("r1");
    const body = await response.text();
    expect(body).toBe(
      'id: 1\nevent: tick\ndata: {"type":"tick","seq":1,"note":"tick 1"}\n\n'
      + 'id: 2\nevent: tick\ndata: {"type":"tick","seq":2,"note":"tick 2"}\n\n'
      + 'id: 3\nevent: run.done\ndata: {"type":"run.done","seq":3,"note":"tick 3"}\n\n',
    );
    await expect.poll(() => finished).toBe(true);
  });

  it("maps events with `map`, skips those it returns undefined for, and keeps the response open with end: false", async () => {
    const url = await serve(async (_request, response) => {
      await writeSseEvents(response, ticks(3), {
        heartbeatMs: 0,
        end: false,
        map: (event) => (event.seq === 2 ? undefined : { event: event.seq === 1 ? "first\nline" : undefined, data: event.seq, id: `x${event.seq}` }),
      });
      response.end("data: 99\n\n");
    });
    const { messages } = parse(await (await fetch(url)).text());
    // A line break in a name would end its field early: it becomes a space.
    expect(messages).toEqual([{ id: "x1", event: "first line", data: 1 }, { id: "x3", event: "run.done", data: 3 }, { data: 99 }]);
  });

  it("keeps headers already sent, as they are", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "X-Own": "yes" });
      void writeSseEvents(response, ticks(1), { heartbeatMs: 0 });
    });
    const response = await fetch(url);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-own")).toBe("yes");
    expect(parse(await response.text()).messages).toHaveLength(1);
  });

  it("sends a keep-alive comment every heartbeatMs while no event comes", async () => {
    const url = await serve((_request, response) => void writeSseEvents(response, ticks(2, 130), { heartbeatMs: 20 }));
    const { messages, comments } = parse(await (await fetch(url)).text());
    expect(messages.map((message) => message.id)).toEqual(["1", "2"]);
    expect(comments.length).toBeGreaterThanOrEqual(4);
    expect(new Set(comments)).toEqual(new Set(["keep-alive"]));
  });

  it("stops reading and calls return() when the client goes away, which aborts an eventStream run", async () => {
    let runSignal: AbortSignal | undefined;
    let returned = 0;
    let written: Promise<void> | undefined;
    let run: ReturnType<typeof eventStream<Tick, never>> | undefined;
    const url = await serve((_request, response) => {
      run = eventStream<Tick, never>((onEvent, signal) => {
        runSignal = signal;
        onEvent({ type: "tick", seq: 1 });
        // A run that goes on until it is stopped.
        return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      });
      const iterator = run[Symbol.asyncIterator]();
      const watched: AsyncIterable<Tick> = {
        [Symbol.asyncIterator]: () => ({
          next: () => iterator.next(),
          return: () => {
            returned++;
            return iterator.return!();
          },
        }),
      };
      written = writeSseEvents(response, watched, { heartbeatMs: 0 });
    });
    // node:http, not fetch: fetch keeps an aborted connection open for seconds.
    await new Promise<void>((resolve, reject) => {
      const client = httpRequest(url, (response) => {
        response.once("data", () => {
          client.destroy();
          resolve();
        });
      });
      client.on("error", () => undefined);
      client.once("error", reject);
      client.end();
    });
    await expect.poll(() => runSignal?.aborted).toBe(true);
    await expect(written).resolves.toBeUndefined();
    expect(returned).toBe(1);
    await expect(run!.result).rejects.toThrow();
  });

  it("waits for the client to read when the socket's buffer is full, and loses nothing", async () => {
    const big = "x".repeat(64 * 1024);
    let falseWrites = 0;
    let drains = 0;
    let ahead = 0;
    const url = await serve((_request, response) => {
      const write = response.write.bind(response) as (chunk: string) => boolean;
      response.write = ((chunk: string) => {
        const accepted = write(chunk);
        if (!accepted) falseWrites++;
        return accepted;
      }) as typeof response.write;
      response.on("drain", () => drains++);
      async function* events(): AsyncGenerator<Tick> {
        for (let seq = 1; seq <= 60; seq++) {
          // No event is read while a full buffer waits for its drain.
          if (falseWrites > drains) ahead++;
          yield { type: "big", seq, big };
        }
      }
      void writeSseEvents(response, events(), { heartbeatMs: 0 });
    });
    const response = await fetch(url);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let body = "";
    for (;;) {
      // A slow reader.
      await pause(2);
      const { value, done } = await reader.read();
      if (done) break;
      body += value;
    }
    const { messages } = parse(body);
    expect(messages.map((message) => Number(message.id))).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(messages.every((message) => (message.data as Tick).big === big)).toBe(true);
    expect(falseWrites).toBeGreaterThan(0);
    expect(drains).toBeGreaterThan(0);
    expect(ahead).toBe(0);
  });

  it("lets a caller's headers replace the event-stream ones whatever the case of their names", async () => {
    const url = await serve((_request, response) => {
      void writeSseEvents(response, ticks(1), { heartbeatMs: 0, headers: { "content-type": "text/event-stream", "CACHE-CONTROL": "no-store" } });
    });
    const response = await fetch(url);
    // Sent twice, a header would read "text/event-stream; charset=utf-8, text/event-stream".
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(parse(await response.text()).messages).toHaveLength(1);
  });

  it("stops the producer, destroys the response and rejects when the headers cannot be written", async () => {
    let runSignal: AbortSignal | undefined;
    let outcome: unknown;
    let leftListeners = -1;
    let destroyed = false;
    const url = await serve((_request, response) => {
      const listeners = () => response.listenerCount("close") + response.listenerCount("finish");
      const before = listeners();
      const run = eventStream<Tick, never>((_onEvent, signal) => {
        runSignal = signal;
        return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      });
      writeSseEvents(response, run, { heartbeatMs: 0, headers: { "X-Bad": "one\ntwo" } }).catch((error: unknown) => {
        outcome = error;
        leftListeners = listeners() - before;
        destroyed = response.destroyed;
      });
    });
    await expect(fetch(url)).rejects.toThrow();
    await expect.poll(() => outcome).toBeInstanceOf(TypeError);
    expect((outcome as { code?: string }).code).toBe("ERR_INVALID_CHAR");
    expect(runSignal?.aborted).toBe(true);
    expect(leftListeners).toBe(0);
    expect(destroyed).toBe(true);
  });

  it.each([
    ["the next event comes at once", true],
    ["no event comes until the client has read it all", false],
  ])("writes nothing after someone else ends the response (%s), and stops", async (_case, nextComes) => {
    const errors: unknown[] = [];
    let returned = 0;
    let requested = 0;
    let written: Promise<void> | undefined;
    let ending!: () => void;
    const ended = new Promise<void>((resolve) => (ending = resolve));
    const url = await serve((_request, response) => {
      response.on("error", (error) => errors.push(error));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const events: AsyncIterable<Tick> = {
        [Symbol.asyncIterator]: () => ({
          async next() {
            const seq = ++requested;
            if (seq > 2) return { value: undefined, done: true };
            // The second event comes only once the response is ended.
            if (seq === 2) await held;
            return { value: { type: "tick", seq }, done: false };
          },
          async return() {
            returned++;
            return { value: undefined, done: true };
          },
        }),
      };
      written = writeSseEvents(response, events, { heartbeatMs: 5 });
      setTimeout(() => {
        // A timeout middleware, say, ends the response with a last word too large for the socket:
        // it is not finished (no 'finish', no 'close') until the client reads it.
        response.end(`: ${"x".repeat(32 * 1024 * 1024)}\n\n`);
        if (nextComes) release();
        ending();
      }, 30);
    });
    const body = await new Promise<string>((resolve, reject) => {
      const client = httpRequest(url, (response) => {
        // The client reads nothing for a while: the next event, and heartbeats every 5 ms, come meanwhile.
        response.pause();
        void ended.then(() => pause(40)).then(() => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.once("end", () => resolve(text));
          response.resume();
        });
      });
      client.once("error", reject);
      client.end();
    });
    await expect(written).resolves.toBeUndefined();
    expect(errors).toEqual([]);
    expect(parse(body).messages.map((message) => message.id)).toEqual(["1"]);
    expect(returned).toBe(1);
    expect(requested).toBe(2);
  });

  it("writes U+2028 and U+2029 escaped, so that a client splitting on line breaks reads the whole JSON", async () => {
    const note = "one\u2028two\u2029three";
    const url = await serve((_request, response) => {
      async function* events(): AsyncGenerator<Tick> {
        yield { type: "text", seq: 1, note };
      }
      void writeSseEvents(response, events(), { heartbeatMs: 0 });
    });
    const body = await (await fetch(url)).text();
    expect(body).not.toMatch(/[\u2028\u2029]/);
    expect(body).toContain("one\\u2028two\\u2029three");
    // A client that reads a field to the end of a line, as JavaScript's /^data: (.*)$/m does.
    const data = body.match(/^data: (.*)$/m)![1]!;
    expect(JSON.parse(data)).toEqual({ type: "text", seq: 1, note });
  });

  it("ends the response and rejects when the iterable throws", async () => {
    let outcome: unknown;
    const url = await serve((_request, response) => {
      async function* failing(): AsyncGenerator<Tick> {
        yield { type: "tick", seq: 1 };
        throw new Error("broken");
      }
      writeSseEvents(response, failing(), { heartbeatMs: 0 }).catch((error: unknown) => (outcome = error));
    });
    expect(parse(await (await fetch(url)).text()).messages).toHaveLength(1);
    await expect.poll(() => (outcome as Error | undefined)?.message).toBe("broken");
  });
});

describe("writeSseEvents with askStream", () => {
  it("streams a question from run.start to run.finish, the result without toolTurns", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const doc = await files.ingest({ name: "notes.txt", bytes: new TextEncoder().encode("The meeting is on Tuesday.") });
    const url = await serve((_request, response) => {
      const stream = askStream({ files, model: fakeModel([says("On Tuesday.")]), documentIds: [doc.id], messages: [{ role: "user", text: "When?" }] });
      void writeSseEvents(response, stream, { heartbeatMs: 0 });
    });
    const { messages } = parse(await (await fetch(url)).text());
    expect(messages.map((message) => Number(message.id))).toEqual(messages.map((_, i) => i + 1));
    expect(messages[0]!.event).toBe("run.start");
    expect(messages.filter((message) => message.event === "text").map((message) => (message.data as { delta: string }).delta).join("")).toBe("On Tuesday.");
    const last = messages.at(-1)!;
    expect(last.event).toBe("run.finish");
    const first = messages[0]!.data as { runId: string };
    expect(last.data).toMatchObject({ type: "run.finish", seq: messages.length, runId: first.runId, time: expect.any(Number) });
    expect(first.runId).toMatch(/^run_/);
    const sent = (last.data as { result: object }).result;
    expect(sent).toMatchObject({ answered: true, text: "On Tuesday.", turns: 1 });
    expect(Object.keys(sent)).not.toContain("toolTurns");
    expect(Object.keys(sent)).not.toContain("plan");
  });

  it("stops the question when the client goes away", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const doc = await files.ingest({ name: "notes.txt", bytes: new TextEncoder().encode("The meeting is on Tuesday.") });
    let modelSignal: AbortSignal | undefined;
    let result: Promise<AskResult> | undefined;
    let sending!: () => void;
    const sent = new Promise<void>((resolve) => (sending = resolve));
    // A model that answers only when it is stopped.
    const model = fakeModel([(_request, _call, hooks) => new Promise((_resolve, reject) => {
      modelSignal = hooks.signal;
      sending();
      hooks.signal?.addEventListener("abort", () => reject(hooks.signal!.reason), { once: true });
    })]);
    const url = await serve((_request, response) => {
      const stream = askStream({ files, model, documentIds: [doc.id], messages: [{ role: "user", text: "When?" }] });
      result = stream.result;
      void writeSseEvents(response, stream, { heartbeatMs: 0 });
    });
    await new Promise<void>((resolve, reject) => {
      const client = httpRequest(url, (response) => {
        // Once the model is asked, the page goes away.
        response.once("data", () => void sent.then(() => {
          client.destroy();
          resolve();
        }));
      });
      client.on("error", () => undefined);
      client.once("error", reject);
      client.end();
    });
    expect(modelSignal?.aborted).toBeDefined();
    await expect.poll(() => modelSignal?.aborted).toBe(true);
    await expect(result).rejects.toThrow();
  });
});

describe("sseMessageOf", () => {
  const result = {
    text: "The answer.",
    answered: true,
    steps: ["Search a.log (exact) for “x” — 1 matching line"],
    evidence: [{ documentId: "doc_1", name: "a.log", tool: "search_document", lines: [[1, 1]], callId: "call_1" }],
    toolTurns: [{ role: "tools", calls: [] }],
    plan: { inline: [], searchable: [] },
    budget: { contextTokens: 1 },
    turns: 2,
    finishReason: "STOP",
    usage: { inputTokens: 10, outputTokens: 5, requests: 2 },
    lastUsage: { promptTokenCount: 10 },
  } as unknown as AskResult;
  const base = { runId: "run_1", time: 1 };

  it("sends run.finish as the event, its result without toolTurns, plan, budget and lastUsage", () => {
    const message = sseMessageOf({ ...base, seq: 7, type: "run.finish", result } as AskEvent);
    expect(message).toEqual({
      event: "run.finish",
      id: 7,
      data: {
        type: "run.finish",
        seq: 7,
        ...base,
        result: { answered: true, text: "The answer.", finishReason: "STOP", blockReason: undefined, steps: result.steps, evidence: result.evidence, turns: 2, usage: result.usage },
      },
    });
    const sent = JSON.parse(JSON.stringify(message.data));
    expect(Object.keys(sent).sort()).toEqual(["result", "runId", "seq", "time", "type"]);
    expect(Object.keys(sent.result).sort()).toEqual(["answered", "evidence", "finishReason", "steps", "text", "turns", "usage"]);
  });

  it("sends run.error as the event, with a partial result of steps, evidence and usage", () => {
    const error = { message: "The model is busy.", kind: "rate_limit" as const, status: 429 };
    expect(sseMessageOf({ ...base, seq: 3, type: "run.error", error, partial: result } as AskEvent)).toEqual({
      event: "run.error",
      id: 3,
      data: { type: "run.error", seq: 3, ...base, error, partial: { steps: result.steps, evidence: result.evidence, usage: result.usage } },
    });
    expect(sseMessageOf({ ...base, seq: 1, type: "run.error", error } as AskEvent).data).toEqual({ type: "run.error", seq: 1, ...base, error, partial: undefined });
  });

  it("sends every other event as it is", () => {
    const event = { ...base, seq: 2, type: "text", requestId: "req_1", delta: "Hi" } as AskEvent;
    expect(sseMessageOf(event)).toEqual({ event: "text", id: 2, data: event });
  });

  // 0.9.0: `missing` (onMissingDocuments "drop") was left out of the fixed list of fields.
  it("sends the documents a question answered without, in run.finish and in run.error's partial", () => {
    const dropped = { ...result, missing: ["doc_gone"] } as AskResult;
    const finish = JSON.parse(JSON.stringify(sseMessageOf({ ...base, seq: 7, type: "run.finish", result: dropped } as AskEvent).data));
    expect(finish.result.missing).toEqual(["doc_gone"]);
    const error = { message: "The model is busy.", kind: "rate_limit" as const, status: 429 };
    const failed = JSON.parse(JSON.stringify(sseMessageOf({ ...base, seq: 3, type: "run.error", error, partial: dropped } as AskEvent).data));
    expect(failed.partial).toEqual({ steps: dropped.steps, evidence: dropped.evidence, usage: dropped.usage, missing: ["doc_gone"] });
    // The new fields of other events pass as they are: a notice's documentIds, ingest.finish's app.
    const notice = { ...base, seq: 4, type: "notice", code: "documents_missing", message: "1 of the attached files is no longer available.", display: "none", documentIds: ["doc_gone"] } as AskEvent;
    expect(sseMessageOf(notice).data).toEqual(notice);
    const finished = { ...base, seq: 5, type: "ingest.finish", document: { id: "doc_1" }, app: { chatFileId: "f-1" } };
    expect(sseMessageOf(finished).data).toEqual(finished);
  });

  // 0.10.0: how the answer ended and what its citations came to reach the browser; the state the
  // server keeps with the conversation does not.
  it("sends finish and citations in run.finish, and leaves out placement and userTurn", () => {
    const citations = { checked: 2, supported: 1, unchecked: 0, unsupported: [{ document: "a.log", line: 9 }] };
    const placement = { version: 1, head: "h", inline: ["doc_1"], cards: [], tools: [], stubbedThrough: 0 };
    const userTurn = { role: "user", text: "Why?", documentIds: ["doc_1"], notes: ["A note."] };
    const ended = { ...result, finish: "filtered", citations, placement, userTurn } as unknown as AskResult;
    const sent = JSON.parse(JSON.stringify(sseMessageOf({ ...base, seq: 7, type: "run.finish", result: ended } as AskEvent).data));
    expect(sent.result).toMatchObject({ finish: "filtered", citations });
    expect(Object.keys(sent.result).sort()).toEqual(["answered", "citations", "evidence", "finish", "finishReason", "steps", "text", "turns", "usage"]);
    expect(JSON.stringify(sent)).not.toContain("documentIds");
    expect(JSON.stringify(sent)).not.toContain("stubbedThrough");
  });

  it("reaches the browser from a question that dropped a missing document", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const doc = await files.ingest({ name: "notes.txt", bytes: new TextEncoder().encode("The meeting is on Tuesday.") });
    const gone = "doc_0123456789abcdef0123456789abcdef";
    const url = await serve((_request, response) => {
      const stream = askStream({ files, model: fakeModel([says("On Tuesday.")]), documentIds: [doc.id, gone], messages: [{ role: "user", text: "When?" }], onMissingDocuments: "drop" });
      void writeSseEvents(response, stream, { heartbeatMs: 0 });
    });
    const { messages } = parse(await (await fetch(url)).text());
    expect(messages.at(-1)).toMatchObject({ event: "run.finish", data: { result: { answered: true, missing: [gone] } } });
    expect(messages.find((message) => message.event === "notice" && (message.data as { code: string }).code === "documents_missing")?.data).toMatchObject({ documentIds: [gone] });
  });
});

describe("createDocumentHandlers().upload with Accept: text/event-stream", () => {
  async function start(options: Partial<LargeFilesOptions> = {}): Promise<string> {
    const documents = createDocumentHandlers(createLargeFiles({ store: new MemoryDocumentStore(), ...options }));
    return serve((request, response) => void documents.upload(request, response));
  }
  const upload = (url: string, name: string, body: string | Uint8Array<ArrayBuffer>, events = true) => fetch(url, {
    method: "POST",
    headers: { "X-File-Name": name, ...(events ? { Accept: "text/event-stream" } : {}) },
    body,
  });

  it("sends the ingest's progress, then ingest.finish with the summary a 201 would hold", async () => {
    const url = await start();
    const log = "2026-01-01 10:00:00 INFO a\n".repeat(2_000);
    const response = await upload(url, "app.log", log);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const { messages } = parse(await response.text());
    expect(messages.map((message) => Number(message.id))).toEqual(messages.map((_, i) => i + 1));
    expect(messages[0]).toMatchObject({ event: "ingest.start", data: { type: "ingest.start", name: "app.log", bytes: log.length } });
    const progress = messages.filter((message) => message.event === "ingest.progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(new Set(progress.map((message) => (message.data as { stage: string }).stage))).toContain("store");
    const last = messages.at(-1)!;
    expect(last.event).toBe("ingest.finish");
    expect(messages.filter((message) => message.event === "ingest.finish")).toHaveLength(1);
    // The event itself, as every message is: its document is the summary a 201 answer holds.
    expect(last.data).toMatchObject({ type: "ingest.finish", seq: messages.length, document: { name: "app.log", format: "log", lines: 2_000 } });
    const document = (last.data as { document: object }).document;
    expect(Object.keys(document)).not.toContain("owner");

    const plain = (await (await upload(url, "app.log", log, false)).json()) as object;
    expect(Object.keys(document).sort()).toEqual(Object.keys(plain).sort());
  });

  it("ends a file that cannot be read with ingest.error: the message and status of the JSON answer", async () => {
    const url = await start();
    const binary = new Uint8Array(500);
    const plain = await upload(url, "a.bin", binary, false);
    expect(plain.status).toBe(422);
    const { error } = (await plain.json()) as { error: string };

    const response = await upload(url, "a.bin", binary);
    expect(response.status).toBe(200);
    const { messages } = parse(await response.text());
    expect(messages.at(-1)).toEqual({ id: String(messages.length), event: "ingest.error", data: expect.objectContaining({ type: "ingest.error", seq: messages.length, error: { message: error, status: 422, code: "not_text" } }) });
    expect(error).toMatch(/binary/);
  });

  it("ends an empty file with ingest.error too", async () => {
    const url = await start();
    const response = await fetch(url, { method: "POST", headers: { "X-File-Name": "empty.txt", Accept: "text/event-stream" } });
    expect(response.status).toBe(200);
    expect(parse(await response.text()).messages.at(-1)).toMatchObject({ event: "ingest.error", data: { type: "ingest.error", error: { message: "empty.txt is empty.", status: 422 } } });
  });

  it("still ends with ingest.finish or ingest.error when the ingest sent no event", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    // A library whose ingest says nothing: the answer must still end with its outcome.
    const quiet: LargeFiles = { ...files, ingest: (input) => files.ingest({ ...input, onEvent: undefined }) };
    const documents = createDocumentHandlers(quiet);
    const url = await serve((request, response) => void documents.upload(request, response));
    const finished = parse(await (await upload(url, "notes.md", "# Notes")).text()).messages;
    expect(finished).toEqual([{ id: "1", event: "ingest.finish", data: expect.objectContaining({ type: "ingest.finish", seq: 1, document: expect.objectContaining({ name: "notes.md", format: "markdown" }) }) }]);
    const failed = parse(await (await upload(url, "a.bin", new Uint8Array(500))).text()).messages;
    expect(failed).toEqual([{ id: "1", event: "ingest.error", data: expect.objectContaining({ type: "ingest.error", seq: 1, error: { message: expect.stringMatching(/binary/), status: 422, code: "not_text" } }) }]);
  });

  it("does not repeat a store's own message in ingest.error", async () => {
    class CustomStore extends MemoryDocumentStore {
      override async put(): Promise<void> {
        throw new Error("connect ECONNREFUSED mongo-prod-1.internal.example:27017");
      }
    }
    const url = await start({ store: new CustomStore() });
    const body = await (await upload(url, "a.txt", "notes")).text();
    expect(body).not.toContain("mongo-prod-1");
    // A DocumentStoreError since 0.9.0, answered 503 in its own words (it was a 500, "Upload failed.").
    expect(parse(body).messages.at(-1)).toMatchObject({ event: "ingest.error", data: { type: "ingest.error", error: { message: "The document could not be stored. Try again.", status: 503 } } });
  });

  it("still answers a missing name, a refused owner and a file too large with an HTTP error in JSON", async () => {
    const url = await start({ maxUploadBytes: 1_000 });
    const big = await upload(url, "a.txt", "x".repeat(5_000));
    expect(big.status).toBe(413);
    expect(big.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await big.json()).toEqual({ error: "The file is larger than the 1000 B upload limit." });
    const unnamed = await fetch(url, { method: "POST", headers: { Accept: "text/event-stream" }, body: "x" });
    expect(unnamed.status).toBe(400);
    expect(((await unnamed.json()) as { error: string }).error).toMatch(/X-File-Name/);

    const documents = createDocumentHandlers(createLargeFiles({ store: new MemoryDocumentStore() }), {
      getOwner: () => {
        throw Object.assign(new Error("Sign in again."), { status: 401 });
      },
    });
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const refusedUrl = await serve((request, response) => void documents.upload(request, response));
    const refused = await upload(refusedUrl, "a.txt", "notes");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "Sign in again." });
  });

  it("answers with a 201 and JSON, as before, without the header", async () => {
    const url = await start();
    const response = await fetch(url, { method: "POST", headers: { "X-File-Name": "notes.md", Accept: "application/json" }, body: "# Notes" });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toMatchObject({ name: "notes.md", format: "markdown" });
  });

  it("streams only for text/event-stream itself: not with q=0, another type or a wildcard", async () => {
    const url = await start();
    const answer = async (accept: string) => {
      const response = await fetch(url, { method: "POST", headers: { "X-File-Name": "notes.md", Accept: accept }, body: "# Notes" });
      await response.arrayBuffer();
      return response.status === 200 && response.headers.get("content-type")?.startsWith("text/event-stream") ? "events" : response.status;
    };
    expect(await answer("text/event-stream;q=0")).toBe(201);
    expect(await answer("application/json, text/event-stream; q=0.0")).toBe(201);
    expect(await answer("text/event-streamx")).toBe(201);
    expect(await answer("application/x-text/event-stream")).toBe(201);
    expect(await answer("*/*")).toBe(201);
    expect(await answer("text/*")).toBe(201);
    expect(await answer("application/json;q=0.9, TEXT/Event-Stream ; Q = 0.5")).toBe("events");
    expect(await answer("text/event-stream;charset=utf-8")).toBe("events");
  });

  it("stops the ingest when the client goes away", async () => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    let stoppedWith: unknown;
    const url = await start({
      extractors: {
        text: (_bytes, input) => new Promise((_resolve, reject) => {
          started();
          input?.signal?.addEventListener("abort", () => {
            stoppedWith = input.signal!.reason;
            reject(input.signal!.reason);
          }, { once: true });
        }),
      },
    });
    const client = httpRequest(url, { method: "POST", headers: { "X-File-Name": "a.txt", Accept: "text/event-stream" } });
    client.on("error", () => undefined);
    client.end("notes");
    await reading;
    client.destroy();
    await expect.poll(() => stoppedWith).toBeInstanceOf(Error);
    expect((stoppedWith as Error).message).toMatch(/client closed the connection/);
  });
});
