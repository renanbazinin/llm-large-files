// `answerInfoOf` (0.10.0): how an answer ended, in one value an application switches on for the
// message it shows, as `errorInfoOf` does for errors.
import { describe, expect, it } from "vitest";
import { answerInfoOf, type AskResult } from "llm-large-files";

describe("answerInfoOf", () => {
  const info = (result: Partial<Pick<AskResult, "answered" | "finish" | "finishReason" | "blockReason">>) => answerInfoOf({ answered: false, ...result });

  it("gives \"language\" for Gemini's LANGUAGE, not a filter, whether the adapter maps it to \"other\" or not", () => {
    expect(info({ finish: "other", finishReason: "LANGUAGE" })).toEqual({ complete: false, reason: "language", finish: "other", finishReason: "LANGUAGE" });
    expect(info({ finishReason: "LANGUAGE" })).toEqual({ complete: false, reason: "language", finishReason: "LANGUAGE" });
    expect(info({ answered: true, finish: "other", finishReason: "OTHER" })).toEqual({ complete: false, reason: "other", finish: "other", finishReason: "OTHER" });
  });

  it("tells a refused prompt first, then a filter, the output limit, and no text", () => {
    expect(info({ blockReason: "PROHIBITED_CONTENT", finish: "filtered" })).toMatchObject({ complete: false, reason: "blocked" });
    expect(info({ answered: true, finish: "filtered" })).toMatchObject({ complete: false, reason: "filtered" });
    expect(info({ answered: true, finish: "cut" })).toMatchObject({ complete: false, reason: "cut" });
    expect(info({ finish: "malformed_call" })).toEqual({ complete: false, reason: "no_answer", finish: "malformed_call" });
    expect(info({})).toEqual({ complete: false, reason: "no_answer" });
    expect(info({ answered: true, finish: "complete", finishReason: "LANGUAGE" })).toEqual({ complete: true, finish: "complete", finishReason: "LANGUAGE" });
  });
});
