// How an answer ended, in one value an application can switch on for the message it shows: the
// answer's own counterpart of `errorInfoOf`. New in 0.10.0: the types are here, and `answerInfoOf`
// is not written yet.
import type { AskResult } from "./ask.js";

/** How an answer ended (`answerInfoOf`). New in 0.10.0. */
export type AnswerInfo = {
  /** True when the answer came whole: not stopped by a filter or the output limit, and not refused. */
  complete: boolean;
  /**
   * Why it is not complete: "filtered" by the provider's filters, "cut" at the output limit,
   * "blocked" (the prompt was refused), "language" (Gemini's LANGUAGE: a language the model does
   * not take), "no_answer" (no text came), or "other".
   */
  reason?: "filtered" | "cut" | "blocked" | "language" | "no_answer" | "other";
  /** `AskResult.finish`. */
  finish?: AskResult["finish"];
  /** The provider's own word (`AskResult.finishReason`). */
  finishReason?: string;
};

/** How the answer of `result` ended. New in 0.10.0. Not written yet: it throws. */
export function answerInfoOf(result: Pick<AskResult, "answered" | "finish" | "finishReason" | "blockReason">): AnswerInfo {
  void result;
  throw new Error("answerInfoOf() is not available yet.");
}
