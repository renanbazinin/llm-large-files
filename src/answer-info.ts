// How an answer ended, in one value an application can switch on for the message it shows: the
// answer's own counterpart of `errorInfoOf`. New in 0.10.0.
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

/**
 * How the answer of `result` ended, for the message to show: complete, or why not. The reasons
 * are tried in this order: a refused prompt ("blocked"), a filter ("filtered"), the output limit
 * ("cut"), Gemini's LANGUAGE ("language": the model does not take the language of the question,
 * which is no filter), another reason that asking again does not mend ("other"), and no text at
 * all ("no_answer"). A result that was built by hand without `finish` is told by `answered`,
 * `blockReason` and `finishReason` alone. New in 0.10.0.
 */
export function answerInfoOf(result: Pick<AskResult, "answered" | "finish" | "finishReason" | "blockReason">): AnswerInfo {
  const { answered, finish, finishReason, blockReason } = result;
  const told = {
    ...(finish !== undefined ? { finish } : {}),
    ...(typeof finishReason === "string" ? { finishReason } : {}),
  };
  const incomplete = (reason: NonNullable<AnswerInfo["reason"]>): AnswerInfo => ({ complete: false, reason, ...told });
  if (typeof blockReason === "string" && blockReason) return incomplete("blocked");
  if (finish === "filtered") return incomplete("filtered");
  if (finish === "cut") return incomplete("cut");
  // Gemini's word for a language the model does not take. An adapter maps it to "other" (asking
  // again would not mend it); an older one leaves `finish` unset. Either way it is not a filter.
  if (finish !== "complete" && typeof finishReason === "string" && finishReason.toUpperCase() === "LANGUAGE") return incomplete("language");
  if (finish === "other") return incomplete("other");
  if (answered !== true) return incomplete("no_answer");
  return { complete: true, ...told };
}
