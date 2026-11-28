// 0.99.14 (specs/03-privacy-sse, invariant (a), gate G6; landed from its draft).
// Redaction cannot be undone: whatever onToolResult masked, dropped, replaced or refused, and
// whatever fitting cut, no quote and no preview brings back. A quote is a substring of what the
// model was sent: a tool result after the hook and after fitting, or a file sent whole. Never the
// stored text, the original, or a card. Runnable twin today: probes/03-proto-invariants.mjs
// (P0 fails, PF passes). Fixtures: ./privacy-fixtures.ts. A source's cited lines are its `from` and
// `to` (spec 01's locators are where they are in the original file).
import { describe, expect, it } from "vitest";
import { sseMessageOf, writeSseEvents } from "llm-large-files/node";
import { ACCESS, HOOKS, canariesIn, fakeResponse, prng, runQuestion, sentToModel, sseData, valuesOf, type Run } from "./privacy-fixtures.js";

const HOOK_NAMES = Object.keys(HOOKS);

/** Canaries a hook removed that no tool result and no file sent whole gave the model. */
const maskedOf = (run: Run) => { const sent = sentToModel(run.requests); return [...run.removed].filter((c) => !sent.canaries.has(c)); };
/** Every quote anywhere: result.sources, every event (onEvent), every SSE message of every caller. */
const allQuotes = (run: Run) => [
  ...valuesOf(run.result?.sources ?? [], "quote"),
  ...run.events.flatMap((e) => valuesOf(e, "quote")),
  ...Object.values(run.sse).flatMap((body) => sseData(body).flatMap((d) => valuesOf(d, "quote"))),
] as string[];
/**
 * Everything a page or a log could get, minus plan metadata (outline headings: eventResults only, see
 * events-baseline) and the locators of sources, which name sheets and headings from the stored text
 * by design (the owner's decision, Nov 28; docs/security.md, "Quotes and previews"). Quotes stay in.
 */
const withoutLocators = (value: unknown): unknown => (Array.isArray(value) ? value.map(withoutLocators) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "locators" && key !== "candidates" && key !== "plan").map(([key, item]) => [key, withoutLocators(item)])) : value);
const everything = (run: Run, extra: unknown[] = []) => JSON.stringify(withoutLocators([run.result?.sources, run.result?.anchors, run.events, Object.values(run.sse).map(sseData), extra]));

describe("redaction cannot be undone (CIT-2, CIT-8a)", () => {
  for (const hook of HOOK_NAMES) {
    for (const eventResults of [false, true]) {
      for (const transport of ["stream", "registry"] as const) {
        it(`${hook}, eventResults ${eventResults}, ${transport}: every quote was sent, no masked canary anywhere`, async () => {
          // The library's onPreview is the app's onToolResult: the same function (docs/security.md).
          const run = await runQuestion({ hookFor: () => hook, eventResults, transport, onPreview: HOOKS[hook] });
          const sent = sentToModel(run.requests);
          for (const quote of allQuotes(run)) expect(sent.covers(quote), quote).toBe(true);
          // readLines through onPreview, for every cited range.
          const previews = [];
          for (const source of run.result!.sources ?? []) if (source.documentId && source.form === "line") previews.push(await run.files.readLines!(source.documentId, [source.from, source.to], ACCESS));
          const text = everything(run, previews);
          for (const canary of maskedOf(run)) expect(text).not.toContain(canary);
          // A source of a call the hook replaced says so.
          if (hook === "redactWhole") expect((run.result!.sources ?? []).filter((s) => s.documentId === run.ids["roster.txt"]).every((s) => s.redacted === true && s.quote === undefined)).toBe(true);
        });
      }
    }
  }

  it("holds for 40 random per-call hook plans", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = prng(1000 + seed);
      const plan = new Map<string, string>();
      const run = await runQuestion({ hookFor: (id) => { if (!plan.has(id)) plan.set(id, HOOK_NAMES[Math.floor(random() * HOOK_NAMES.length)]!); return plan.get(id)!; }, eventResults: seed % 2 === 0, transport: seed % 4 === 1 ? "registry" : "stream" });
      const sent = sentToModel(run.requests);
      for (const quote of allQuotes(run)) expect(sent.covers(quote), `seed ${seed}: ${quote}`).toBe(true);
      const text = everything(run);
      for (const canary of maskedOf(run)) expect(text, `seed ${seed}`).not.toContain(canary);
    }
  }, 180_000);

  it("quotes come from the cut text when the loop cut a result the hook made larger", async () => {
    const run = await runQuestion({ hookFor: () => "expandNames", tight: true });
    const sent = sentToModel(run.requests);
    // c1's masked copy was larger than the room: the model got { truncated, partial } (a JSON
    // fragment), from which no quote is cut; c4 was not run for lack of room.
    const answers = run.requests.flatMap((r) => r.messages).flatMap((m) => (m.role === "tools" ? m.answers : []));
    expect(answers.find((a) => a.call.id === "c1")?.result).toMatchObject({ truncated: true, redacted: true });
    for (const quote of valuesOf(run.result!.sources ?? [], "quote") as string[]) expect(sent.covers(quote)).toBe(true);
    expect((run.result!.sources ?? []).find((s) => s.documentId === run.ids["roster.txt"] && s.from === 33)?.quote).toBeUndefined();
  });

  it("a line the model never saw, an aggregate's sample line and a whole-read line have no quote", async () => {
    const run = await runQuestion({ hookFor: () => "none" });
    const by = (file: string, line: number) => (run.result!.sources ?? []).find((s) => s.documentId === run.ids[file] && s.from === line);
    expect(by("roster.txt", 120)?.quote).toBeUndefined(); // never shown (the citation is unsupported)
    expect(by("table.csv", 12)?.quote).toBeUndefined();   // aggregate_table returns line numbers only
    expect(by("notes.txt", 20)?.quote).toBeUndefined();   // analyze_whole_document prose: notes, no line text
    expect(by("small.txt", 3)?.quote).toMatch(/^קובץ קטן שורה 3 QZ[A-Z]{5} 7\d{8}$/); // sent whole: the block as sent
    expect(by("contract.txt", 48)?.quote).toMatch(/^קנס בסך 3400/); // an item's quote, as the read's result had it
  });

  it("the run.error path: citation events before the failure carry no quote with eventResults off", async () => {
    const run = await runQuestion({ hookFor: () => "maskIds", fail: true });
    expect(run.events.at(-1)?.type).toBe("run.error");
    expect(run.events.some((e) => e.type === "citation")).toBe(true);
    expect(JSON.stringify(run.events)).not.toContain('"quote"');
    for (const body of Object.values(run.sse)) expect(body).not.toContain('"quote"');
    for (const canary of maskedOf(run)) expect(everything(run)).not.toContain(canary);
  });

  it("a custom SSE map that forwards run.finish's sources still gets no quote (eventResultOf strips them)", async () => {
    const run = await runQuestion({ hookFor: () => "maskIds" });
    const map = (event: (typeof run.events)[number]) => {
      const message = sseMessageOf(event);
      if (event.type === "run.finish") message.data = { ...(message.data as object), result: { ...(message.data as { result: object }).result, sources: event.result.sources } };
      return message;
    };
    const response = fakeResponse();
    await writeSseEvents(response, (async function* () { yield* run.events; })(), { heartbeatMs: 0, map });
    expect(response.body()).not.toContain('"quote"');
  });

  it("previews: readLines without onPreview shows the stored text; with the hook, nothing it masks", async () => {
    const unguarded = await runQuestion({ hookFor: () => "maskIds" });
    const guarded = await runQuestion({ hookFor: () => "maskIds", onPreview: HOOKS.maskIds });
    const plain = await unguarded.files.readLines!(unguarded.ids["roster.txt"]!, [33, 35], ACCESS);
    const masked = await guarded.files.readLines!(guarded.ids["roster.txt"]!, [33, 35], ACCESS);
    expect(canariesIn(JSON.stringify(plain)).some((c) => /^7\d{8}$/.test(c))).toBe(true);
    expect(canariesIn(JSON.stringify(masked)).some((c) => /^7\d{8}$/.test(c))).toBe(false);
  });
});
