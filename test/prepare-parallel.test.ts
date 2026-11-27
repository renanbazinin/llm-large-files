// The documents of a question are looked up and read a few at a time before its first request
// (LOOP-9, new in 0.99.13): one after another, 20 files took 40 store round trips on a first
// question and 20 on a follow-up (about 600 and 300 ms at 15 ms a call). The results are collected
// by index, so the first request is the one 0.99.12 sent, byte for byte. The store here answers
// every call at the next "round trip" tick, and all the calls waiting at a tick together: the
// number of ticks before the first model request is the latency, with no wall clock in it (the
// tick store of specs/05-quick-fixes, probe 07-loop9.mjs).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type DocumentStore } from "llm-large-files";
import { fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";

const CLOCK = () => new Date("2026-11-20T08:00:00.000Z");
/** The SHA-256 of the first request of the question below, as 0.99.12 sent it (93,283 bytes). */
const FIRST_REQUEST_0_99_12 = "842b207b931e9f4e4c79c035caabe1661e8e9ceee036c7222b65299263408645";

/** A store whose calls are answered at ticks, all those waiting at a tick together, and counted. */
function tickStore() {
  const inner = new MemoryDocumentStore({ now: CLOCK });
  let waiting: Array<() => void> = [];
  const counts = { counting: false, ticks: 0, calls: 0, largestBatch: 0 };
  const pump = setInterval(() => {
    if (waiting.length === 0) return;
    const batch = waiting;
    waiting = [];
    if (counts.counting) {
      counts.ticks++;
      counts.largestBatch = Math.max(counts.largestBatch, batch.length);
    }
    for (const go of batch) go();
  }, 1);
  const store = new Proxy(inner, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (counts.counting) counts.calls++;
        return new Promise<void>((resolve) => waiting.push(resolve)).then(() => (value as (...given: unknown[]) => unknown).apply(target, args));
      };
    },
  }) as DocumentStore;
  return { store, counts, stop: () => clearInterval(pump) };
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

/** 20 files: 15 small logs sent whole and 5 logs of 4,000 lines searched. */
async function library() {
  const ticks = tickStore();
  stop = ticks.stop;
  const files = createLargeFiles({ requireOwner: false, store: ticks.store, now: CLOCK });
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push((await files.ingest({ id: `f${i}`, name: `f${i}.log`, bytes: utf8(serviceLog(i < 15 ? 50 : 4000)) })).id);
  return { files, ids, counts: ticks.counts };
}

/** One question: the store round trips and calls before its first model request, and that request. */
async function question(setup: Awaited<ReturnType<typeof library>>, documentIds = setup.ids, extra: { onMissingDocuments?: "drop" } = {}) {
  const { files, counts } = setup;
  const model = fakeModel([says("ok")]);
  let atFirst: { ticks: number; calls: number } | undefined;
  Object.assign(counts, { counting: true, ticks: 0, calls: 0, largestBatch: 0 });
  const result = await askWithFiles({
    files,
    model: { ...model, send: (request, hooks) => {
      atFirst ??= { ticks: counts.ticks, calls: counts.calls };
      return model.send(request, hooks);
    } },
    documentIds,
    messages: [{ role: "user", text: "hi" }],
    ...extra,
  });
  counts.counting = false;
  const body = JSON.stringify(model.requests[0]);
  return { result, roundTrips: atFirst!.ticks, calls: atFirst!.calls, largestBatch: counts.largestBatch, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
}

describe("the documents of a question, read before its first request", () => {
  it("take at most 6 store round trips on a first question and 3 on a follow-up, and send the request of 0.99.12", async () => {
    const setup = await library();
    const first = await question(setup);
    expect(first.roundTrips).toBeLessThanOrEqual(6);
    expect(first.largestBatch).toBeGreaterThanOrEqual(2);
    // As many store calls as before: they are only made together.
    expect(first.calls).toBe(40);
    expect(first.bytes).toBe(93_283);
    expect(first.sha256).toBe(FIRST_REQUEST_0_99_12);

    const again = await question(setup);
    expect(again.roundTrips).toBeLessThanOrEqual(3);
    expect(again.largestBatch).toBeGreaterThanOrEqual(2);
    expect(again.calls).toBe(20);
    expect(again.sha256).toBe(first.sha256);
  });

  it("are read at most 8 at a time", async () => {
    const setup = await library();
    const first = await question(setup);
    expect(first.largestBatch).toBeLessThanOrEqual(8);
  });

  it("report missing documents in the order they were asked for", async () => {
    const setup = await library();
    const asked = ["gone-3", ...setup.ids.slice(0, 6), "gone-1", ...setup.ids.slice(6, 10), "gone-2"];
    const { result } = await question(setup, asked, { onMissingDocuments: "drop" });
    expect(result.missing).toEqual(["gone-3", "gone-1", "gone-2"]);
    expect(result.plan.inline.map((meta) => meta.id)).toEqual(setup.ids.slice(0, 10));
  });
});
