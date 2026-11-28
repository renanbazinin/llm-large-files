// 0.99.14 gate CIT-17, sources "off", on the 112 recorded answers: no request body changed (byte-
// identical to the other modes: the same recordings); no citation event, empty anchors and sources,
// no locator or quote in any event or SSE message; the text is that of "remove".
import { describe, expect, it } from "vitest";
import { replayAll, sha256, SHOWN } from "./sources-replay-lib.js";

describe("sources on the recorded answers: sources off (CIT-17)", { timeout: 600_000 }, async () => {
  const run = await replayAll({ sources: "off" });

  it("replays the 96 recordings, with no request body changed (no miss) and no error", () => {
    expect(run.recordings).toBe(96);
    expect(run.answers.filter((answer) => answer.misses > 0 || answer.error).map((answer) => `${answer.id}: ${answer.error ?? `${answer.misses} misses`}`)).toEqual([]);
  });

  it("sends no citation event, has empty anchors and sources, and no locator or quote in any event or SSE message", () => {
    expect(run.answers.reduce((sum, answer) => sum + answer.citationEvents + answer.anchors + answer.sources + answer.quoteKeys, 0)).toBe(0);
    expect(run.answers.flatMap((answer) => answer.leaks)).toEqual([]);
  });

  it("shows the text of remove", () => {
    expect(run.answers.filter((answer) => sha256(answer.text) !== SHOWN[answer.id]).map((answer) => answer.id)).toEqual([]);
  });
});
