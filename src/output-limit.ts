// A plain completion on a model that may think its output limit away: shared by the part readers
// of every adapter.
import { until } from "./http.js";

/**
 * A model that thinks counts its thoughts in its output limit. Asked for 4,096 tokens of notes on
 * a part of a log, Gemini 3.8 Flash spent 3,931 of them thinking and wrote two lines, and Gemini 4
 * wrote nothing at all (November 2026). A reply that was cut off that way is asked for again with
 * this limit, the least Google recommends for a Gemini 4 model. OpenAI says to keep at least
 * 25,000 for its reasoning models.
 */
export const THINKING_OUTPUT_TOKENS = 32_768;

/**
 * What has been learned about a model, so that a whole-file read does not pay for the wasted
 * request with every part: the output limit it needs, or 0 when it refused that limit.
 */
const learnedLimits = new Map<string, number>();
/** The first request to a model that is still on its way. Others wait for what it learns. */
const firstRequests = new Map<string, Promise<void>>();
/** Models that have answered at least once. */
const answered = new Set<string>();
const MOST_REMEMBERED = 200;

function remember(model: string, limit: number): void {
  if (learnedLimits.size >= MOST_REMEMBERED && !learnedLimits.has(model)) learnedLimits.clear();
  learnedLimits.set(model, limit);
}

/**
 * The errors `completeWithinLimit` threw for a reply with no text, with why the reply stopped, in
 * the provider's word ("" when it did not say).
 */
const noTextErrors = new WeakMap<object, string>();

/**
 * Why a reply had no text, when this error is the one `completeWithinLimit` throws for it: the
 * provider's word for why it stopped ("SAFETY", "refusal"), or "" when it did not say. Undefined
 * for any other error. The message of that error is the package's own.
 */
export function noTextReason(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? noTextErrors.get(error) : undefined;
}

/** A reply to a plain completion. */
export type LimitedReply = {
  text: string;
  /** True when the model stopped because it reached the output limit. */
  cutOff: boolean;
  /**
   * True when the provider stopped the reply before its end for another reason (its safety
   * filters): what it wrote is kept, and said to be incomplete, as a reply cut off at the limit is.
   */
  stopped?: boolean;
  /** Why it stopped, in the provider's word, for the message when there is no text. */
  reason?: string;
  /** Tokens the model spent thinking, when the provider says. */
  thoughts: number;
};

/**
 * Sends a completion with an output limit, and once more with `THINKING_OUTPUT_TOKENS` when the
 * reply was cut off with nothing written, or with half the limit or more gone on thoughts. What
 * was learned is kept under `model` (a URL, or a URL and a model name): later requests start with
 * the larger limit, and a model that refused it (HTTP 400, but not for a request too large for the
 * window with it) is not asked for it again, nor is one whose window, or allowance a minute, is no
 * larger than that limit. Requests that arrive while the first one to a model is on its way wait for it,
 * until their own signal aborts.
 */
export async function completeWithinLimit(model: string, maxOutputTokens: number, send: (limit: number) => Promise<LimitedReply>, options: {
  signal?: AbortSignal | undefined;
  onTruncated?: (() => void) | undefined;
} = {}): Promise<string> {
  const { signal } = options;
  // The first request to a model finds out whether it thinks its limit away. The parts of a
  // whole-file read are sent four at a time: the others wait for it, and one request is wasted
  // on such a model, not four.
  let learned = () => undefined as void;
  if (!answered.has(model)) {
    const first = firstRequests.get(model);
    if (first) {
      // The first request may be another question's: this one's abort ends the wait at once.
      await until(first, signal);
      signal?.throwIfAborted();
    } else {
      firstRequests.set(model, new Promise<void>((resolve) => {
        learned = () => {
          if (answered.size >= MOST_REMEMBERED) answered.clear();
          answered.add(model);
          firstRequests.delete(model);
          resolve();
        };
      }));
    }
  }
  try {
    const known = learnedLimits.get(model);
    const limit = Math.max(maxOutputTokens, known ?? 0);
    let reply = await send(limit);
    // Cut off, with nothing written or with at least half of the limit gone on thoughts: the
    // limit was too low for this model, not the notes too long.
    const starved = reply.cutOff && (!reply.text.trim() || reply.thoughts >= limit / 2);
    if (starved && known !== 0 && limit < THINKING_OUTPUT_TOKENS) {
      remember(model, THINKING_OUTPUT_TOKENS);
      try {
        reply = await send(THINKING_OUTPUT_TOKENS);
      } catch (error) {
        if (signal?.aborted) throw error;
        // A model or a gateway that refuses the larger limit (HTTP 400) is not asked for it again.
        // A refusal of this request as too large for the window with that limit is no such refusal,
        // unless the window is no larger than the limit itself: a smaller part may fit. Nothing is
        // learned from it, and the next request starts as this one did. A request too large for
        // what the provider allows in a minute (OpenAI's or Groq's TPM, HTTP 429 or 413) is too
        // large the same way, with that allowance as the window. Any other failure says nothing
        // about the limit: the next request starts with it. What the first reply had is kept; with
        // nothing in it, this error is the one to report.
        const { status, kind, limitTokens } = (error ?? {}) as { status?: unknown; kind?: unknown; limitTokens?: unknown };
        if (status === 400 || kind === "context_overflow") {
          const tooLarge = kind === "context_overflow" && !(typeof limitTokens === "number" && limitTokens <= THINKING_OUTPUT_TOKENS);
          if (!tooLarge) remember(model, 0);
          else if (learnedLimits.get(model) === THINKING_OUTPUT_TOKENS) learnedLimits.delete(model);
        }
        if (!reply.text.trim()) throw error;
      }
    }
    if (!reply.text.trim()) {
      const error = new Error(`The model returned no text${reply.reason ? ` (${reply.reason})` : ""}.`);
      noTextErrors.set(error, reply.reason ?? "");
      throw error;
    }
    // The text stops mid-list when the output limit is reached, or when a filter stopped it. Say so
    // instead of passing it off as complete.
    if (reply.cutOff || reply.stopped) options.onTruncated?.();
    return reply.text;
  } finally {
    learned();
  }
}
