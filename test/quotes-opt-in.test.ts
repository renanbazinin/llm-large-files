// 0.99.14 (specs/03-privacy-sse part 3, decision 1): a quote (document text) is in an event only
// with eventResults: true. No separate option (the spec's option B was not taken).
import { describe, expect, it } from "vitest";
import type { AskEvent } from "llm-large-files";
import { runQuestion, sentToModel, sseData, valuesOf } from "./privacy-fixtures.js";

type Citation = Extract<AskEvent, { type: "citation" }>;
const citations = (events: AskEvent[]) => events.filter((e): e is Citation => e.type === "citation");
const finish = (events: AskEvent[]) => events.find((e): e is Extract<AskEvent, { type: "run.finish" }> => e.type === "run.finish")!;

describe("option A: quotes in events only with eventResults: true", () => {
  it("eventResults off (the default): the result has quotes; no event and no SSE message has one", async () => {
    const run = await runQuestion({ hookFor: () => "none" });
    expect((run.result!.sources ?? []).filter((s) => s.quote).length).toBeGreaterThan(0);
    expect(citations(run.events).length).toBeGreaterThan(0);
    for (const event of citations(run.events)) for (const source of event.sources) expect(source).not.toHaveProperty("quote");
    expect((finish(run.events).result.sources ?? []).every((s) => !("quote" in s))).toBe(true);
    expect(run.sse.A).not.toContain('"quote"');
  });

  it("eventResults on: citation events and run.finish carry quotes, each one sent to the model; SSE run.finish never does", async () => {
    const run = await runQuestion({ hookFor: () => "maskIds", eventResults: true });
    const sent = sentToModel(run.requests);
    const inEvents = citations(run.events).flatMap((e) => e.sources.flatMap((s) => (s.quote ? [s.quote] : [])));
    expect(inEvents.length).toBeGreaterThan(0);
    for (const quote of inEvents) expect(sent.covers(quote)).toBe(true);
    expect((finish(run.events).result.sources ?? []).some((s) => s.quote)).toBe(true);
    const sse = sseData(run.sse.A!);
    // citation events go out as they are (as tool.end with its result does under eventResults)...
    expect(sse.filter((d) => d.type === "citation").flatMap((d) => valuesOf(d, "quote")).length).toBe(inEvents.length);
    // ...but the run.finish allow-list keeps sources without quotes, as it keeps no toolTurns.
    expect(valuesOf(sse.find((d) => d.type === "run.finish"), "quote")).toEqual([]);
  });

  it("a joiner and a request sent again after run.finish follow the same rule", async () => {
    for (const eventResults of [false, true]) {
      const run = await runQuestion({ hookFor: () => "maskIds", eventResults, transport: "registry" });
      expect(sseData(run.sse.B!).some((d) => d.type === "citation")).toBe(true);
      const finishB = sseData(run.sse.B!).find((d) => d.type === "run.finish") as { result: { sources: unknown[]; anchors: unknown[] } };
      const finishC = sseData(run.sse.C!).find((d) => d.type === "run.finish") as { result: { sources: unknown[]; anchors: unknown[] } };
      expect(finishC.result).toEqual(finishB.result);
      expect(finishB.result.sources.length).toBe(run.result!.sources!.length);
      expect(JSON.stringify(finishB.result)).not.toContain('"quote"');
      if (!eventResults) for (const body of Object.values(run.sse)) expect(body).not.toContain('"quote"');
    }
  });
});
