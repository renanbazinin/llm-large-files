// What `prepare` gives a loop that keeps the start of its requests the same (P2, the planning
// side): a tool guide without file names or figures that change (`guide`), a header line for each
// document kept with its block (`listing`), with "replaces doc_…" for a file uploaded again under
// its name, and room kept for the declarations, the cards, the header and the guide (`reserve`).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, estimateTokens, MemoryDocumentStore, resolveBudget, type DocumentMeta, type LargeFiles, type PreparedContext } from "llm-large-files";
import { serviceLog, utf8 } from "llm-large-files/testing";
import { emptyPlacement, placementHead } from "../src/placement.js";
import { prepareDocuments, type PrepareContext } from "../src/prepare.js";
import { INLINE_CITATION_LINE, INLINE_TABLES_LINE, LISTING_TITLE, listingLine, renderListing, toolGuide } from "../src/plan.js";

const base = { tokens: 0, bytes: 0 };
const HEAD = placementHead("first question");

/** A library whose clock moves a second at each call, so that each document is made after the one before. */
function library(options: Partial<Parameters<typeof createLargeFiles>[0]> = {}): LargeFiles {
  let now = Date.now();
  const clock = () => new Date((now += 1_000));
  return createLargeFiles({ store: new MemoryDocumentStore({ now: clock }), now: clock, ...options });
}

/** What a request holds of the files, as `askWithFiles` counts it: the files sent whole, the cards, the header and the guide. */
function requestTokens(prepared: PreparedContext): number {
  const cards = prepared.plan.searchable.map((meta) => estimateTokens(prepared.blocks.get(meta.id)!));
  return prepared.plan.inlineTokens + cards.reduce((sum, tokens) => sum + tokens, 0) + estimateTokens(renderListing([...prepared.listing!.values()])) + estimateTokens(prepared.guide!);
}

const steps = (count: number) => Array.from({ length: count }, (_, i) => `Step ${i + 1}: restart worker ${i % 9} and check queue depth on shard ${i % 12} before paging.`).join("\n");

const csv = (rows: number) => ["id,status,amount", ...Array.from({ length: rows }, (_, i) => `${i + 1},${i % 4 === 0 ? "late" : "paid"},${(i * 37) % 500}`)].join("\n");

describe("the guide that stays the same (prepared.guide)", () => {
  it("names no file and no document ID, and gives no count of turns", async () => {
    const files = library({ budget: { inlineTokens: 2_000 } });
    const log = await files.ingest({ name: "payments-service.log", bytes: utf8(serviceLog(3_000)) });
    const notes = await files.ingest({ name: "on-call notes.md", bytes: utf8("# On call\nRestart the payment worker.\n") });
    const prepared = await files.prepare([log.id, notes.id], base);
    // The instruction of 0.9 names the files searched; the guide does not.
    expect(prepared.instruction).toContain("\"payments-service.log\" (document_id ");
    for (const named of [log.name, log.id, notes.name, notes.id]) expect(prepared.guide).not.toContain(named);
    expect(prepared.guide).not.toContain("tool_turns_left");
    expect(prepared.guide!.split("\n")).toEqual([
      "The files the file list marks \"searched with the tools\" are too large for your context: you see only a summary card for each. Read them through the tools:",
      "- search_document finds lines (exact or regex) or the most relevant passages (keywords).",
      "- To count or list what can be matched as text (a word, an ID, an error code, a log level, a pattern), use search_document in exact or regex mode: its total_matching_lines is exact.",
      "- To count per group (per hour or day, per error code or ID with a regex group, per message shape), pass group_by: one call gives every count. For more matches than a result shows, search again from its next_from_line, or with order \"last\" for the last ones.",
      "- Search for the bare form of a word: a search matches inside longer words, so \"timeout\" also finds \"timeouts\", and a Hebrew word without its prefix letters (חוזה, not בחוזה) finds every form of it.",
      "- read_document reads a line range. Read around search hits before you rely on them.",
      "- get_document_overview returns the outline, log profile, and the start and end of a file.",
      "- analyze_whole_document reads the entire file in parts. Use it only when the task needs all of the file and cannot be done by matching text: a full summary, a timeline, or items that must be judged by meaning. It is slow and costly, and it can miss items of a long list.",
      "- To find every item of a kind across a whole file (each penalty clause, each incident), call analyze_whole_document with output \"items\" and up to 12 short labels: it lists each item with its line and a quote, and code counts them, not a model.",
      "You have a limited number of tool turns, and you are told when a turn is your last. Call several tools in the same turn when the searches do not depend on each other, and answer as soon as you have enough evidence.",
      "Base your answer on text you actually read. Cite line numbers like (app.log L1203). If the tools did not find something, say so rather than guessing.",
    ]);
  });

  it("is the same in each question of a chat, and changes only when a tool is declared for the first time", async () => {
    const files = library({ budget: { inlineTokens: 2_000 } });
    const first = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const one = await files.prepare([first.id], base, { placement: emptyPlacement(HEAD), inlineTables: "tools" });
    // An upload searched with the same tools: the same guide, though the files are others.
    const second = await files.ingest({ name: "worker.log", bytes: utf8(serviceLog(4_000)) });
    const two = await files.prepare([first.id, second.id], base, { placement: one.placement, inlineTables: "tools" });
    expect(two.guide).toBe(one.guide);
    expect(two.instruction).not.toBe(one.instruction);
    // A table sent whole: aggregate_table is declared for the first time, and the guide says so.
    const table = await files.ingest({ name: "invoices.csv", bytes: utf8(csv(20)) });
    const three = await files.prepare([first.id, second.id, table.id], base, { placement: two.placement, inlineTables: "tools" });
    expect(three.placement?.tools).toEqual(["search_document", "read_document", "get_document_overview", "aggregate_table", "analyze_whole_document"]);
    expect(three.guide).not.toBe(two.guide);
    expect(three.guide).toContain(INLINE_TABLES_LINE);
    // The table is left out of the next question: the tools stay, and so does the guide.
    const four = await files.prepare([first.id, second.id], base, { placement: three.placement, inlineTables: "tools" });
    expect(four.placement?.tools).toEqual(three.placement?.tools);
    expect(four.guide).toBe(three.guide);
  });

  it("is the citation line for a question without tools whose files sent whole are numbered", async () => {
    const files = library();
    const notes = await files.ingest({ name: "notes.md", bytes: utf8("# Notes\nOne.\nTwo.\n") });
    expect((await files.prepare([notes.id], base, { numberInline: true })).guide).toBe(INLINE_CITATION_LINE);
    expect((await files.prepare([notes.id], base)).guide).toBe("");
    expect(toolGuide([], { numberedInline: true })).toBe(INLINE_CITATION_LINE);
    expect(toolGuide([])).toBe("");
  });

  it("says how to look at pages without naming the PDF, and the header gives its pages", async () => {
    const files = library({ keepOriginals: ["pdf"] });
    const pdf = await files.ingest({ name: "דוח.pdf", bytes: new Uint8Array(readFileSync(new URL("./fixtures/pdf/word-hebrew.pdf", import.meta.url))) });
    expect(pdf.pages).toBeGreaterThan(0);
    const prepared = await files.prepare([pdf.id], base, { viewPages: true });
    expect(prepared.viewable.map((meta) => meta.id)).toEqual([pdf.id]);
    expect(prepared.placement?.tools).toEqual(["view_pages"]);
    expect(prepared.guide).not.toContain(pdf.name);
    expect(prepared.guide).not.toContain(pdf.id);
    expect(prepared.guide!.split("\n")[0]).toBe("The text of a PDF does not show its pictures, charts or diagrams. You can look at the real pages of a PDF with view_pages: the file list gives the pages of each PDF whose pages can be shown.");
    expect(prepared.guide).not.toContain("search_document");
    expect(prepared.listing?.get(pdf.id)).toBe(`- "דוח.pdf" (document_id ${pdf.id}, ${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}): shown in full below`);
    // Without viewPages, no pages in the header.
    expect((await files.prepare([pdf.id], base)).listing?.get(pdf.id)).toBe(`- "דוח.pdf" (document_id ${pdf.id}): shown in full below`);
  });
});

describe("the header lines (prepared.listing)", () => {
  it("has a line for each document found, in the order asked, that says where it is", async () => {
    const files = library({ budget: { inlineTokens: 2_000 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)) });
    const notes = await files.ingest({ name: "notes \"draft\".md", bytes: utf8("# Notes\nOne.\n") });
    const prepared = await files.prepare([notes.id, "doc_gone", log.id], base);
    expect([...prepared.listing!]).toEqual([
      [notes.id, `- "notes \\"draft\\".md" (document_id ${notes.id}): shown in full below`],
      [log.id, `- "app.log" (document_id ${log.id}): searched with the tools`],
    ]);
    expect(renderListing([...prepared.listing!.values()])).toBe(`${LISTING_TITLE}\n${prepared.listing!.get(notes.id)}\n${prepared.listing!.get(log.id)}`);
    expect(LISTING_TITLE).toBe("Attached files:");
    expect(renderListing([])).toBe("");
  });

  it("says that a file uploaded again under its name replaces the earlier one, in its own line only", async () => {
    const files = library();
    const old = await files.ingest({ name: "résumé.txt", bytes: utf8("version one\n") });
    const other = await files.ingest({ name: "notes.txt", bytes: utf8("other\n") });
    const one = await files.prepare([old.id, other.id], base, { placement: emptyPlacement(HEAD) });
    expect(one.listing?.get(old.id)).toBe(`- "résumé.txt" (document_id ${old.id}): shown in full below`);
    // The same name, written with a combining accent.
    const again = await files.ingest({ name: "résumé.txt", bytes: utf8("version two\n") });
    const two = await files.prepare([old.id, other.id, again.id], base, { placement: one.placement });
    expect(two.listing?.get(again.id)).toBe(`- "résumé.txt" (document_id ${again.id}): shown in full below; it replaces ${old.id}, an earlier file of the same name`);
    expect(two.listing?.get(old.id)).toBe(one.listing?.get(old.id));
    expect(two.listing?.get(other.id)).toBe(one.listing?.get(other.id));
    // A third upload replaces the latest before it.
    const third = await files.ingest({ name: "résumé.txt", bytes: utf8("version three\n") });
    const three = await files.prepare([third.id, old.id, again.id], base, { placement: two.placement });
    expect(three.listing?.get(third.id)).toContain(`; it replaces ${again.id},`);
    expect(three.listing?.get(again.id)).toBe(two.listing?.get(again.id));
    expect(listingLine({ ...old, pages: 3 }, { inline: false, viewable: true, replaces: "doc_x" })).toBe(`- "résumé.txt" (document_id ${old.id}, 3 pages): searched with the tools; it replaces doc_x, an earlier file of the same name`);
  });
});

describe("the replaces marker, from the metadata alone", () => {
  it("is on the same line whatever the order the question lists two files of one name made in the same millisecond", async () => {
    const fixed = new Date("2026-11-24T08:00:00.000Z");
    const files = createLargeFiles({ store: new MemoryDocumentStore({ now: () => fixed }), now: () => fixed });
    const a = await files.ingest({ name: "חוזה.txt", bytes: utf8("גרסה 1\n") });
    const b = await files.ingest({ name: "חוזה.txt", bytes: utf8("גרסה 2\n") });
    expect(a.createdAt).toBe(b.createdAt);
    const [first, second] = [a, b].sort((left, right) => (left.id < right.id ? -1 : 1));
    const one = await files.prepare([a.id, b.id], base, { placement: emptyPlacement(HEAD) });
    // The later by ID replaces the earlier: before, the one listed second did.
    expect(one.listing?.get(first!.id)).toBe(`- "חוזה.txt" (document_id ${first!.id}): shown in full below`);
    expect(one.listing?.get(second!.id)).toBe(`- "חוזה.txt" (document_id ${second!.id}): shown in full below; it replaces ${first!.id}, an earlier file of the same name`);
    for (const ids of [[b.id, a.id], [a.id, b.id]]) {
      const again = await files.prepare(ids, base, { placement: one.placement });
      expect([...again.listing!.entries()].sort()).toEqual([...one.listing!.entries()].sort());
    }
    expect([...(await files.prepare([b.id, a.id], base)).listing!.entries()].sort()).toEqual([...one.listing!.entries()].sort());
  });

  it("makes each name NFC once, so that a question of many files is planned in time", async () => {
    const count = 2_000;
    const metas = new Map<string, DocumentMeta>();
    for (let i = 0; i < count; i++) {
      const id = `doc_${i.toString(16).padStart(24, "0")}`;
      // Every tenth name is that of the file before it.
      const name = `שם קובץ ${i - (i % 10 === 9 ? 1 : 0)}.txt`;
      metas.set(id, { id, name, mimeType: "text/plain", format: "text", bytes: 4, textBytes: 4, characters: 4, lines: 2, estimatedTokens: 3, wrappedLines: 0, outline: [], createdAt: new Date(1_700_000_000_000 + i * 1_000).toISOString(), expiresAt: "2030-01-01T00:00:00.000Z" });
    }
    const context: PrepareContext = {
      callerOf: () => ({}) as never,
      metaFor: async (id) => metas.get(id),
      load: async (id) => ({ meta: metas.get(id)!, readText: async () => "a\nb", readLines: async () => ["a", "b"], broken: false }) as never,
      stillOpened: async () => true,
      budgetFor: () => resolveBudget({ contextTokens: 10_000_000, inlineTokens: 10_000_000 }),
      viewableMeta: () => false,
      rules: {} as never,
    };
    const normalize = vi.spyOn(String.prototype, "normalize");
    try {
      const prepared = await prepareDocuments(context, [...metas.keys()], base);
      // Twice for each pair of documents before: 8 million calls, and seconds of a blocked loop.
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(count);
      const replacing = [...prepared.listing!.entries()].filter(([, line]) => line.includes("; it replaces "));
      expect(replacing).toHaveLength(count / 10);
      expect(prepared.listing?.get(`doc_${(19).toString(16).padStart(24, "0")}`)).toContain(`; it replaces doc_${(18).toString(16).padStart(24, "0")}, `);
    } finally {
      normalize.mockRestore();
    }
  });
});

describe("room kept for what is besides the documents (reserve)", () => {
  it("keeps room for the declarations", async () => {
    const files = library({ budget: { contextTokens: 30_000, reservedTokens: 5_000, inlineTokens: 25_000 } });
    const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(200)) });
    expect(log.estimatedTokens).toBeLessThan(20_000);
    expect((await files.prepare([log.id], base)).plan.inline).toHaveLength(1);
    const room = 25_000 - log.estimatedTokens;
    // The guide and the header of a file sent whole are counted too: a few dozen tokens.
    expect((await files.prepare([log.id], base, { reserve: { tokens: room - 200, bytes: 0 } })).plan.inline).toHaveLength(1);
    expect((await files.prepare([log.id], base, { reserve: { tokens: room + 1, bytes: 0 } })).plan.inline).toEqual([]);
    expect((await files.prepare([log.id], base, { reserve: { tokens: 0, bytes: 10_000_000 } })).plan.inline).toEqual([]);
  });

  it("counts the cards, the header and the guide at their size", async () => {
    const files = library({ budget: { contextTokens: 40_000, reservedTokens: 4_000, inlineTokens: 30_000 } });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await files.ingest({ name: `service-${i}.log`, bytes: utf8(serviceLog(3_000 + i)) })).id);
    const runbook = await files.ingest({ name: "runbook.md", bytes: utf8(Array.from({ length: 700 }, (_, i) => `Step ${i + 1}: restart worker ${i % 9} and check queue depth on shard ${i % 12} before paging.`).join("\n")) });
    // As 0.9 planned it: the runbook is sent whole, and the 12 cards come on top of it.
    const plain = await files.prepare([...ids, runbook.id], base);
    expect(plain.plan.inline.map((meta) => meta.id)).toEqual([runbook.id]);
    // With the cards counted, there is no room for it.
    const counted = await files.prepare([...ids, runbook.id], base, { reserve: { tokens: 0, bytes: 0 } });
    expect(counted.plan.inline).toEqual([]);
    expect(counted.plan.searchable).toHaveLength(13);
    expect(counted.blocks.get(runbook.id)).toContain("--- Large attached file: runbook.md ---");
    expect(counted.listing?.get(runbook.id)).toContain("searched with the tools");
  });

  it("does not move small files to cards larger than they are, nor demote pinned ones, when nothing fits", async () => {
    // A window a little too small for 70 short notes beside the cards of 2 logs: no plan fits,
    // and each note's card is about twice the note.
    const files = library({ budget: { contextTokens: 20_000, reservedTokens: 4_000, inlineTokens: 30_000 } });
    const logs: string[] = [];
    for (let i = 0; i < 2; i++) logs.push((await files.ingest({ name: `big-${i}.log`, bytes: utf8(serviceLog(4_000 + i)) })).id);
    const notes: string[] = [];
    for (let i = 0; i < 70; i++) notes.push((await files.ingest({ name: `note-${i}.md`, bytes: utf8(Array.from({ length: 8 }, (_, j) => `Note ${i}.${j}: check worker ${j} on shard ${i}.`).join("\n")) })).id);
    const ids = [...logs, ...notes];
    const plain = await files.prepare(ids, base);
    expect(plain.plan.inline).toHaveLength(70);
    const room = 20_000 - 4_000;
    expect(requestTokens(plain)).toBeGreaterThan(room);
    const card = await files.prepare([notes[0]!], base, { placement: { ...emptyPlacement(HEAD), cards: [notes[0]!] } });
    expect(estimateTokens(card.blocks.get(notes[0]!)!)).toBeGreaterThan(2 * (plain.plan.inlineTokens / 70) - 20);
    // With the cards counted, the notes stay whole: as cards they would take more room. It made
    // every file a card before, 13K tokens over the room.
    const counted = await files.prepare(ids, base, { reserve: { tokens: 0, bytes: 0 } });
    expect(counted.plan.inline.map((meta) => meta.id).sort()).toEqual([...notes].sort());
    expect(requestTokens(counted)).toBeLessThanOrEqual(requestTokens(plain));
    // The same with the notes pinned by the state of the first plan: they stay pinned.
    const pinned = await files.prepare(ids, base, { placement: plain.placement, reserve: { tokens: 0, bytes: 0 } });
    expect(pinned.plan.inline).toHaveLength(70);
    expect(pinned.placement).toMatchObject({ inline: plain.placement!.inline, cards: plain.placement!.cards });
  });

  it("moves to a card the file whose card frees room, and leaves whole those whose cards would not", async () => {
    const files = library({ budget: { contextTokens: 24_000, reservedTokens: 4_000, inlineTokens: 30_000 } });
    const log = await files.ingest({ name: "worker.log", bytes: utf8(serviceLog(300)) });
    const runbook = await files.ingest({ name: "runbook.md", bytes: utf8(steps(250)) });
    const notes: string[] = [];
    for (let i = 0; i < 20; i++) notes.push((await files.ingest({ name: `note-${i}.md`, bytes: utf8(`Note ${i}: restart worker ${i % 7}.\nThen check shard ${i}.`) })).id);
    const ids = [log.id, runbook.id, ...notes];
    const room = 24_000 - 4_000;
    const plain = await files.prepare(ids, base);
    expect(plain.plan.inline.map((meta) => meta.id).sort()).toEqual([runbook.id, ...notes].sort());
    expect((await files.prepare(ids, base, { reserve: { tokens: 0, bytes: 0 } })).plan.inline).toHaveLength(21);
    // Room for all but the runbook: it goes to the cards, and the notes stay.
    const tight = await files.prepare(ids, base, { reserve: { tokens: room - requestTokens(plain) + 100, bytes: 0 } });
    expect(tight.plan.inline.map((meta) => meta.id).sort()).toEqual([...notes].sort());
    expect(tight.plan.searchable.map((meta) => meta.id).sort()).toEqual([log.id, runbook.id].sort());
    // Room for less than that: nothing fits, and the notes stay whole, as cards would take more
    // room. It made them all cards before.
    const over = { reserve: { tokens: room - requestTokens(tight) + 100, bytes: 0 } };
    const fresh = await files.prepare(ids, base, over);
    expect(fresh.plan.inline.map((meta) => meta.id).sort()).toEqual([...notes].sort());
    expect(requestTokens(fresh)).toBe(requestTokens(tight));
    // Pinned, the same: the runbook, which cannot fit even as the others are, moves to the cards.
    const pinned = await files.prepare(ids, base, { placement: plain.placement, ...over });
    expect(pinned.plan.inline.map((meta) => meta.id).sort()).toEqual([...notes].sort());
    expect(pinned.placement).toMatchObject({ inline: plain.placement!.inline.filter((id) => id !== runbook.id), cards: [log.id, runbook.id] });
  });

  it("is refused when it is not a size, and so are numberInline and inlineTables of the wrong kind", async () => {
    const files = library();
    const meta = await files.ingest({ name: "notes.txt", bytes: utf8("one\n") });
    await expect(files.prepare([meta.id], base, { reserve: { tokens: -1, bytes: 0 } })).rejects.toThrow(RangeError);
    await expect(files.prepare([meta.id], base, { reserve: { tokens: 0, bytes: Number.NaN } })).rejects.toThrow("PrepareOptions.reserve.bytes must be a number of 0 or more (got NaN).");
    await expect(files.prepare([meta.id], base, { reserve: "4K" as never })).rejects.toThrow(TypeError);
    await expect(files.prepare([meta.id], base, { numberInline: "yes" as never })).rejects.toThrow("PrepareOptions.numberInline must be true or false (got string).");
    await expect(files.prepare([meta.id], base, { inlineTables: "table" as never })).rejects.toThrow('PrepareOptions.inlineTables must be "tools" or "text" (got "table").');
  });
});
