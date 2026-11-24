// Where the documents of a chat stay from one question to the next (P2, the planning side):
// `PlacementState` read and checked, given to `prepare` and given back by it, documents kept where
// they were (pins), stored rounds planned at their stand-in size (L3), and stand-ins made in
// batches (HL2-2).
import { describe, expect, it } from "vitest";
import { createLargeFiles, estimateTokens, MemoryDocumentStore, PLACEMENT_STATE_VERSION, type PlacementState } from "llm-large-files";
import { serviceLog, utf8 } from "llm-large-files/testing";
import type { ModelMessage, ModelToolRound } from "../src/model.js";
import {
  checkedPlacement,
  emptyPlacement,
  freeShare,
  movedToCards,
  nextPlacement,
  placementHead,
  readPlacement,
  roundsByQuestion,
  standInRound,
  STUB_END_FREE,
  STUB_START_FREE,
  stubbedFor,
  withStandIns,
} from "../src/placement.js";
import { jsonBytes } from "../src/text.js";

const base = { tokens: 0, bytes: 0 };
const HEAD = placementHead("What does step 12 say?");

const state = (fields: Partial<PlacementState> = {}): PlacementState => ({ ...emptyPlacement(HEAD), ...fields });

/** The size of the text turns and tool rounds of `messages`, as askWithFiles counts the base of its plan. */
function sizeOf(messages: ModelMessage[]): { tokens: number; bytes: number } {
  let tokens = 2_000;
  let bytes = 8_000;
  for (const message of messages) {
    if (message.role === "tools") {
      for (const answer of message.answers) {
        const sent = JSON.stringify(answer.result);
        tokens += estimateTokens(`${answer.call.name}${JSON.stringify(answer.call.args)}`) + 8 + estimateTokens(sent) + 8;
        bytes += Buffer.byteLength(sent) + 160;
      }
    } else {
      for (const part of message.parts) if (typeof part.text === "string") {
        tokens += estimateTokens(part.text);
        bytes += jsonBytes(part.text);
      }
    }
  }
  return { tokens, bytes };
}

/** probe2's runbook: 1,800 steps, about 52,000 tokens. */
const RUNBOOK = Array.from({ length: 1800 }, (_, i) => `Step ${i + 1}: restart worker ${i % 9} and check queue depth on shard ${i % 12} before paging the on-call engineer.`).join("\n");

/** A read of 600 lines of `id` stored with question `n`, as probe2 made them: about 11,500 tokens. */
function read(n: number, id: string): ModelToolRound {
  const call = { id: `s${n}`, name: "read_document", args: { document_id: id, start_line: 1 + n * 600, end_line: 600 + n * 600 } };
  return { role: "tools", calls: [call], answers: [{ call, result: { document: "app.log", lines: `${1 + n * 600}-${600 + n * 600}`, total_lines: 60000, text: "x".repeat(23_000) } }] };
}

/** A chat of `stored` earlier questions with one read each, and the question asked now. */
function chat(stored: number, id: string): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let q = 0; q < stored; q++) messages.push({ role: "user", parts: [{ text: `question ${q}` }] }, read(q, id), { role: "assistant", parts: [{ text: `answer ${q}` }] });
  messages.push({ role: "user", parts: [{ text: "What does step 12 say?" }] });
  return messages;
}

describe("a stored state, read and checked", () => {
  it("has a head made from the first user turn", () => {
    expect(HEAD).toMatch(/^[0-9a-f]{32}$/);
    expect(placementHead("What does step 12 say?")).toBe(HEAD);
    expect(placementHead("מה כתוב בשלב 12?")).not.toBe(HEAD);
    expect(placementHead("")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is used when it is of version 1, of the right shape, and of this head", () => {
    const kept = state({ inline: ["doc_a"], cards: ["doc_b"], tools: ["read_document", "search_document"], stubbedThrough: 2, nativeRefused: true });
    const read = readPlacement(JSON.parse(JSON.stringify(kept)), HEAD);
    expect(read.ignored).toBeUndefined();
    // The tools in the order they are declared.
    expect(read.state).toEqual({ ...kept, tools: ["search_document", "read_document"] });
    expect(PLACEMENT_STATE_VERSION).toBe(1);
  });

  it("is ignored, with the reason, when it is of another version, another head or another shape", () => {
    const empty = emptyPlacement(HEAD);
    expect(readPlacement(undefined, HEAD)).toEqual({ state: empty });
    expect(readPlacement(null, HEAD)).toEqual({ state: empty });
    expect(readPlacement({ ...state(), version: 2 }, HEAD)).toEqual({ state: empty, ignored: "version" });
    // The application trimmed the start of the list: its first user turn is another.
    expect(readPlacement(state({ head: placementHead("question 3") }), HEAD)).toEqual({ state: empty, ignored: "head" });
    for (const broken of [
      "a state",
      [state()],
      { ...state(), version: "1" },
      { ...state(), head: 7 },
      { ...state(), inline: "doc_a" },
      { ...state(), cards: [1] },
      { ...state(), tools: ["lookup_ticket"] },
      { ...state(), stubbedThrough: -1 },
      { ...state(), stubbedThrough: 1.5 },
      { ...state(), nativeRefused: false },
    ]) {
      expect(readPlacement(broken, HEAD)).toEqual({ state: empty, ignored: "invalid" });
    }
  });

  it("keeps each ID once, sent whole when a state lists it both ways, and leaves out fields it does not know", () => {
    const given = { ...state({ inline: ["doc_a", "doc_a"], cards: ["doc_b", "doc_a", "doc_b"] }), owner: "alice" };
    expect(checkedPlacement(given)).toEqual(state({ inline: ["doc_a"], cards: ["doc_b"] }));
  });
});

describe("the state given to prepare and given back", () => {
  async function library(budget = {}) {
    // A clock that moves: each document is made after the one before.
    let now = Date.now();
    const clock = () => new Date((now += 1_000));
    return createLargeFiles({ store: new MemoryDocumentStore({ now: clock }), budget, now: clock });
  }

  it("records where each document went, and gives the same plan and state again", async () => {
    const files = await library({ inlineTokens: 5_000 });
    const small = await files.ingest({ name: "notes.txt", bytes: utf8("Restart the payment worker.\nThen check PAY-5031 errors.\n") });
    const big = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const first = await files.prepare([big.id, small.id], base, { placement: emptyPlacement(HEAD) });
    expect(first.placement).toEqual(state({ inline: [small.id], cards: [big.id], tools: ["search_document", "read_document", "get_document_overview", "analyze_whole_document"] }));
    const second = await files.prepare([big.id, small.id], base, { placement: first.placement });
    expect(second.placement).toEqual(first.placement);
    expect([...second.blocks]).toEqual([...first.blocks]);
    expect(second.guide).toBe(first.guide);
    expect([...second.listing!]).toEqual([...first.listing!]);
    // The blocks and the instruction are those of a call without a state.
    const plain = await files.prepare([big.id, small.id], base);
    expect([...plain.blocks]).toEqual([...first.blocks]);
    expect(plain.instruction).toBe(first.instruction);
  });

  it("keeps a document sent whole in its place before a new one that is smaller", async () => {
    const files = await library({ inlineTokens: 2_500 });
    const older = await files.ingest({ name: "runbook.md", bytes: utf8(RUNBOOK.split("\n").slice(0, 60).join("\n")) });
    const newer = await files.ingest({ name: "notes.md", bytes: utf8(RUNBOOK.split("\n").slice(0, 40).join("\n")) });
    expect(older.estimatedTokens).toBeLessThanOrEqual(2_500);
    expect(older.estimatedTokens + newer.estimatedTokens).toBeGreaterThan(2_500);
    // Planned afresh, the smaller one goes first.
    const fresh = await files.prepare([older.id, newer.id], base);
    expect(fresh.plan.inline.map((meta) => meta.id)).toEqual([newer.id]);
    // The older one was sent whole in an earlier question: it keeps its place.
    const pinned = await files.prepare([older.id, newer.id], base, { placement: state({ inline: [older.id] }) });
    expect(pinned.plan.inline.map((meta) => meta.id)).toEqual([older.id]);
    expect(pinned.plan.searchable.map((meta) => meta.id)).toEqual([newer.id]);
    expect(pinned.placement).toMatchObject({ inline: [older.id], cards: [newer.id] });
  });

  it("keeps a searched document searched, though it would fit now", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8("one\ntwo\nthree\n") });
    const prepared = await files.prepare([meta.id], base, { placement: state({ cards: [meta.id] }) });
    expect(prepared.plan.searchable.map((document) => document.id)).toEqual([meta.id]);
    expect(prepared.blocks.get(meta.id)).toContain("--- Large attached file: notes.txt ---");
    expect(prepared.placement).toMatchObject({ inline: [], cards: [meta.id] });
  });

  it("moves a document that no longer fits to the cards, after the others", async () => {
    const files = await library({ inlineTokens: 1_000 });
    const runbook = await files.ingest({ name: "runbook.md", bytes: utf8(RUNBOOK.split("\n").slice(0, 100).join("\n")) });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    expect(runbook.estimatedTokens).toBeGreaterThan(1_000);
    const before = state({ inline: [runbook.id], cards: [log.id], tools: ["search_document", "read_document"] });
    const prepared = await files.prepare([runbook.id, log.id], base, { placement: before });
    expect(prepared.plan.inline).toEqual([]);
    expect(prepared.placement).toMatchObject({ inline: [], cards: [log.id, runbook.id] });
    expect(movedToCards(before, prepared.placement!)).toEqual([runbook.id]);
    expect(movedToCards(undefined, prepared.placement!)).toEqual([]);
  });

  it("leaves out the documents found missing, and keeps those this question does not name", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8("one\ntwo\n") });
    const prepared = await files.prepare([meta.id, "doc_gone"], base, { placement: state({ inline: ["doc_gone", "doc_elsewhere"], cards: ["doc_old"] }) });
    expect(prepared.missing).toEqual(["doc_gone"]);
    expect(prepared.placement).toMatchObject({ inline: ["doc_elsewhere", meta.id], cards: ["doc_old"] });
  });

  it("keeps the tools of earlier questions, and the loop's own fields", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8("one\ntwo\n") });
    const before = state({ tools: ["view_pages", "search_document"], stubbedThrough: 3, nativeRefused: true });
    const prepared = await files.prepare([meta.id], base, { placement: before });
    // Every document is sent whole: the tools stay declared, as the chat had them.
    expect(prepared.placement).toEqual(state({ inline: [meta.id], tools: ["search_document", "view_pages"], stubbedThrough: 3, nativeRefused: true }));
    expect(prepared.guide).toContain("view_pages");
  });

  it("plans afresh with a state of another version or shape, and gives one of this version", async () => {
    const files = await library({ inlineTokens: 2_500 });
    const older = await files.ingest({ name: "runbook.md", bytes: utf8(RUNBOOK.split("\n").slice(0, 60).join("\n")) });
    const newer = await files.ingest({ name: "notes.md", bytes: utf8(RUNBOOK.split("\n").slice(0, 40).join("\n")) });
    for (const placement of [{ ...state({ inline: [older.id] }), version: 2 }, { ...state({ inline: [older.id] }), tools: ["lookup_ticket"] }]) {
      const prepared = await files.prepare([older.id, newer.id], base, { placement: placement as never });
      expect(prepared.plan.inline.map((meta) => meta.id)).toEqual([newer.id]);
      expect(prepared.placement).toMatchObject({ version: 1, head: HEAD, inline: [newer.id], cards: [older.id] });
    }
  });

  it("gives a state without being given one, with an empty head", async () => {
    const files = await library();
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8("one\ntwo\n") });
    expect((await files.prepare([meta.id], base)).placement).toEqual({ ...emptyPlacement(""), inline: [meta.id] });
  });
});

describe("stored rounds planned at their stand-in size (L3)", () => {
  it("keeps probe2's runbook whole at 4 and 8 stored questions", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { contextTokens: 128_000 } });
    const runbook = await files.ingest({ name: "runbook.md", bytes: utf8(RUNBOOK) });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(60_000)) });
    const ids = [runbook.id, log.id];
    const first = await files.prepare(ids, sizeOf(chat(0, log.id)), { placement: emptyPlacement(HEAD) });
    expect(first.plan.inline.map((meta) => meta.id)).toEqual([runbook.id]);
    for (const stored of [4, 8]) {
      const messages = chat(stored, log.id);
      // As 0.9 planned it, with the rounds in full: the runbook flips to a card.
      const full = await files.prepare(ids, sizeOf(messages));
      expect(full.plan.inline).toEqual([]);
      // At their stand-in size, as the rounds of earlier questions are sent once stubbed, it stays.
      const planned = await files.prepare(ids, sizeOf(withStandIns(messages)), { placement: first.placement });
      expect(planned.plan.inline.map((meta) => meta.id)).toEqual([runbook.id]);
      expect(planned.placement).toEqual(first.placement);
    }
  });

  it("makes each result a stand-in that says what it showed, and leaves a round with nothing to shorten as it is", () => {
    const round = read(1, "doc_log");
    const stubbed = standInRound(round);
    expect(stubbed).not.toBe(round);
    expect(stubbed.calls).toBe(round.calls);
    expect(stubbed.answers[0]!.result).toMatchObject({ document: "app.log", dropped: true, lines: "601-1200", total_lines: 60000 });
    expect(JSON.stringify(stubbed).length).toBeLessThan(1_000);
    // A stand-in, an error and a small result are not shortened.
    expect(standInRound(stubbed)).toBe(stubbed);
    const call = { id: "e", name: "search_document", args: {} };
    const small: ModelToolRound = { role: "tools", calls: [call], answers: [{ call, result: { error: "Unknown document." } }] };
    expect(standInRound(small)).toBe(small);
  });

  it("finds the rounds of each question, and stubs those of the first questions only", () => {
    const messages = chat(3, "doc_log");
    expect(roundsByQuestion(messages).map((rounds) => rounds.length)).toEqual([1, 1, 1, 0]);
    expect(roundsByQuestion([read(0, "doc_log"), ...messages])[0]).toEqual(roundsByQuestion(messages)[0]);
    const two = withStandIns(messages, 2);
    const dropped = (list: ModelMessage[]) => list.filter((message) => message.role === "tools").map((round) => (round as ModelToolRound).answers[0]!.result.dropped === true);
    expect(dropped(two)).toEqual([true, true, false]);
    expect(dropped(withStandIns(messages))).toEqual([true, true, true]);
    expect(dropped(withStandIns(messages, 0))).toEqual([false, false, false]);
    // The text turns are the same objects.
    expect(two[0]).toBe(messages[0]);
    expect(two.at(-1)).toBe(messages.at(-1));
  });
});

describe("stand-ins in batches (HL2-2)", () => {
  const limit = { tokens: 100_000, bytes: 10_000_000 };
  const unit = (full: number, standIn = 100) => ({ full: { tokens: full, bytes: full * 3 }, standIn: { tokens: standIn, bytes: standIn * 3 } });

  it("starts a batch below 15% free, and ends it at 40% free", () => {
    expect([STUB_START_FREE, STUB_END_FREE]).toEqual([0.15, 0.4]);
    const units = [unit(10_000), unit(10_000), unit(10_000), unit(10_000), unit(10_000), unit(10_000)];
    // 30,000 + 60,000: 10% free. Stand-ins for the oldest until 40% is free: three leave 39.7%, four 49.6%.
    expect(stubbedFor(units, { tokens: 30_000, bytes: 0 }, limit)).toBe(4);
    expect(freeShare({ tokens: 30_000 + 300 + 30_000, bytes: 0 }, limit)).toBeLessThan(0.4);
    expect(freeShare({ tokens: 30_000 + 400 + 20_000, bytes: 0 }, limit)).toBeGreaterThanOrEqual(0.4);
    // 15% free exactly: no batch.
    expect(stubbedFor(units, { tokens: 25_000, bytes: 0 }, limit)).toBe(0);
    // Those already stubbed stay so, and count as stand-ins.
    expect(stubbedFor(units, { tokens: 25_000, bytes: 0 }, limit, 2)).toBe(2);
    expect(stubbedFor(units, { tokens: 30_000, bytes: 0 }, limit, 2)).toBe(2);
    // With little to gain, every unit, and no more.
    expect(stubbedFor(units, { tokens: 95_000, bytes: 0 }, limit)).toBe(6);
    expect(stubbedFor(units, { tokens: 0, bytes: 0 }, limit, 9)).toBe(6);
  });

  it("counts bytes too, by the less free of the two", () => {
    const units = [unit(1_000), unit(1_000)];
    expect(freeShare({ tokens: 10_000, bytes: 9_500_000 }, limit)).toBeCloseTo(0.05, 6);
    expect(stubbedFor(units, { tokens: 10_000, bytes: 9_000_000 }, { tokens: 100_000, bytes: 9_005_000 })).toBe(2);
    expect(freeShare({ tokens: 1, bytes: 1 }, { tokens: Number.POSITIVE_INFINITY, bytes: 0 })).toBe(1);
  });

  it("rewrites earlier rounds of a 19-turn question on a 60K window in 2 batches", () => {
    const window = { tokens: 60_000, bytes: 10_000_000 };
    const units: Array<ReturnType<typeof unit>> = [];
    let stubbed = 0;
    let batches = 0;
    for (let turn = 1; turn <= 19; turn++) {
      // The request of this turn: the question and its files, a result's room, and the rounds so far.
      const next = stubbedFor(units, { tokens: 13_500, bytes: 0 }, window, stubbed);
      if (next !== stubbed) batches++;
      stubbed = next;
      units.push(unit(3_500, 300));
    }
    expect(batches).toBe(2);
    expect(stubbed).toBeLessThan(units.length);
  });
});

describe("the next state, from a plan", () => {
  const doc = (id: string) => ({ id }) as never;
  it("adds new documents in the order of the question, and keeps the order of those placed before", () => {
    const given = state({ inline: ["doc_b"], cards: ["doc_c"], tools: ["read_document"] });
    const next = nextPlacement(given, HEAD, { ids: ["doc_e", "doc_c", "doc_d", "doc_b", "doc_a"], plan: { inline: [doc("doc_a"), doc("doc_b"), doc("doc_e")], searchable: [doc("doc_c"), doc("doc_d")] }, missing: [], tools: ["search_document"] });
    expect(next).toEqual(state({ inline: ["doc_b", "doc_e", "doc_a"], cards: ["doc_c", "doc_d"], tools: ["search_document", "read_document"] }));
  });
});
