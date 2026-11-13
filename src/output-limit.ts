// A plain completion on a model that may think its output limit away: shared by the part readers
// of every adapter.

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

/** A reply to a plain completion. */
export type LimitedReply = {
  text: string;
  /** True when the model stopped because it reached the output limit. */
  cutOff: boolean;
  /** Why it stopped, in the provider's word, for the message when there is no text. */
  reason?: string;
  /** Tokens the model spent thinking, when the provider says. */
  thoughts: number;
};

/**
 * Sends a completion with an output limit, and once more with `THINKING_OUTPUT_TOKENS` when the
 * reply was cut off with nothing written, or with half the limit or more gone on thoughts. What
 * was learned is kept under `model` (a URL, or a URL and a model name): later requests start with
 * the larger limit, and a model that refused it (HTTP 400) is not asked for it again. Requests
 * that arrive while the first one to a model is on its way wait for it.
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
      await first;
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
        // Any other failure says nothing about the limit: the next request starts with it. What
        // the first reply had is kept; with nothing in it, this error is the one to report.
        if ((error as { status?: unknown } | null)?.status === 400) remember(model, 0);
        if (!reply.text.trim()) throw error;
      }
    }
    if (!reply.text.trim()) throw new Error(`The model returned no text${reply.reason ? ` (${reply.reason})` : ""}.`);
    // The text stops mid-list when the output limit is reached. Say so instead of passing it off as complete.
    if (reply.cutOff) options.onTruncated?.();
    return reply.text;
  } finally {
    learned();
  }
}
