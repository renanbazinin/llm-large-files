// 0.99.14 gates, citationMarkers "remove", on the 112 recorded answers (specs/03-privacy-sse G7–G10,
// replay 96/96): no request body changed; with eventResults off no quote in any event or SSE
// message; every answer with chips has anchors and sources, without quotes, in SSE run.finish, each
// anchor inside the text; every quote cut from what the model was sent; at least 215 quotes.
import { describe, expect, it } from "vitest";
import { replayAll, sha256, SHOWN } from "./sources-replay-lib.js";

/**
 * The 3 answers that cite and keep every citation in the text: two name real log lines in words
 * ("Line 21880:", spec 02 R3), and one copies a whole-file read's labels "**שורה N (סעיף M):**" as
 * prose, which phase 2 (0.99.16, CIT-13) removes at its source.
 */
const KEPT_ONLY = ["gemini-3.5-flash-lite/cleaning-sanctions#1", "gemini-3.8-flash/log-pay5031#1", "gemini-3.8-flash/chat-log-orders#1"];

describe("sources on the recorded answers: remove", { timeout: 600_000 }, async () => {
  const run = await replayAll({ citationMarkers: "remove" });

  it("replays the 96 recordings, with no request body changed (no miss) and no error", () => {
    expect(run.recordings).toBe(96);
    expect(run.answers).toHaveLength(112);
    expect(run.answers.filter((answer) => answer.misses > 0 || answer.error).map((answer) => `${answer.id}: ${answer.error ?? `${answer.misses} misses`}`)).toEqual([]);
  });

  it("shows the texts pinned for showCitations: false", () => {
    expect(run.answers.filter((answer) => sha256(answer.text) !== SHOWN[answer.id]).map((answer) => answer.id)).toEqual([]);
  });

  it("G7: no quote in any event or SSE message with eventResults off", () => {
    expect(run.answers.reduce((sum, answer) => sum + answer.quoteKeys, 0)).toBe(0);
  });

  it("G8: every answer with chips has anchors and sources, without quotes, in SSE run.finish, each anchor inside the text", () => {
    const withChips = run.answers.filter((answer) => answer.anchors > 0);
    const missing = withChips.filter((answer) => !Array.isArray(answer.sseFinish?.anchors) || !(answer.sseFinish!.anchors as unknown[]).length || !Array.isArray(answer.sseFinish?.sources) || !(answer.sseFinish!.sources as unknown[]).length);
    expect(missing.map((answer) => answer.id)).toEqual([]);
    expect(run.answers.flatMap((answer) => answer.leaks)).toEqual([]);
    // The answers that cite and have no chip keep all their citations in the text, by the hiding
    // rules (a real log line in words, a form written in the file): there is nothing to place.
    const keptOnly = run.answers.filter((answer) => answer.cites && answer.anchors === 0).map((answer) => answer.id);
    expect(keptOnly, "answers that cite with no chip").toEqual(KEPT_ONLY);
    expect(withChips.length, `${withChips.length} answers with chips`).toBeGreaterThanOrEqual(Number(process.env.LLF_CHIP_FLOOR ?? 78));
  });

  it("G9 and G10: every quote is cut from what the model was sent, and at least 215 sources have one", () => {
    expect(run.answers.flatMap((answer) => answer.uncovered.map((key) => `${answer.id} ${key}`))).toEqual([]);
    const quotes = run.answers.reduce((sum, answer) => sum + answer.quotes.length, 0);
    const sources = run.answers.reduce((sum, answer) => sum + answer.sources, 0);
    expect({ quotes, sources }).toEqual({ quotes: expect.any(Number), sources: expect.any(Number) });
    expect(quotes, `${quotes} quotes of ${sources} sources`).toBeGreaterThanOrEqual(Number(process.env.LLF_QUOTE_FLOOR ?? 215));
  });

  it("CIT-6: lineTalk on every answer; harmful line talk left in no more answers than 0.99.12's 11", () => {
    const verdicts = run.answers.map((answer) => answer.lineTalk);
    expect(verdicts.every((verdict) => verdict !== undefined)).toBe(true);
    const harmful = verdicts.filter((verdict) => verdict === "harmful").length;
    expect(harmful, `${harmful} harmful, ${verdicts.filter((verdict) => verdict === "harmless").length} harmless`).toBeLessThanOrEqual(Number(process.env.LLF_HARMFUL_CEILING ?? 11));
  });
});
