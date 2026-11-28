// 0.99.14 gates, citationMarkers "token", on the 112 recorded answers: no request body changed, no
// quote in events or SSE, and the text is that of "remove" with a token at each chip.
import { describe, expect, it } from "vitest";
import { replayAll, sha256, SHOWN } from "./sources-replay-lib.js";

describe("sources on the recorded answers: token", { timeout: 600_000 }, async () => {
  const run = await replayAll({ citationMarkers: "token" });

  it("replays the 96 recordings, with no request body changed (no miss) and no error", () => {
    expect(run.recordings).toBe(96);
    expect(run.answers.filter((answer) => answer.misses > 0 || answer.error).map((answer) => `${answer.id}: ${answer.error ?? `${answer.misses} misses`}`)).toEqual([]);
  });

  it("is the text of remove with ⟦n⟧ at each chip, and no quote reaches an event or SSE", () => {
    expect(run.answers.filter((answer) => sha256(answer.text.replace(/\u27e6\d+\u27e7/gu, "")) !== SHOWN[answer.id]).map((answer) => answer.id)).toEqual([]);
    expect(run.answers.reduce((sum, answer) => sum + answer.quoteKeys, 0)).toBe(0);
    expect(run.answers.flatMap((answer) => answer.leaks)).toEqual([]);
  });
});
