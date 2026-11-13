// One rule for sending a model request again, used by the chat loop and by whole-file part reads.

/** How a model request that failed is sent again. */
export type RetryOptions = {
  /** How many times a failed request is sent again. Defaults to 3. 0 turns it off. */
  retries?: number;
  /** The first wait in milliseconds. Each later one is twice as long. Defaults to 500. */
  baseDelayMs?: number;
  /**
   * The longest wait in milliseconds. Defaults to 60,000. When the provider asks for a longer one
   * (`Retry-After`), the request is not sent again and the error is reported.
   */
  maxDelayMs?: number;
  /** For tests: the wait itself. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** For tests: the source of the jitter, a number from 0 up to 1. */
  random?: () => number;
};

export const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 60_000;

/** The HTTP status of an error, when it carries one. 0 stands for a connection that failed. */
export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/**
 * Whether a request that failed with this status is worth sending again: the model could not be
 * reached, timed out, was busy, or failed on its side. A request it refused (400, 401, 403, 404)
 * would be refused again.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** A wait that ends early, with the signal's reason, when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const done = () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * The wait a provider asked for, in milliseconds: the `retry-after-ms` or `Retry-After` header
 * (seconds, or a date), or the `retryDelay` of a `google.rpc.RetryInfo` in the error body ("17s").
 */
export function retryAfterMs(headers: Headers | undefined, body?: unknown, now: () => number = Date.now): number | undefined {
  const exact = Number(headers?.get("retry-after-ms"));
  if (headers?.get("retry-after-ms") && Number.isFinite(exact) && exact >= 0) return exact;
  const header = headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now());
  }
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details as Array<{ retryDelay?: unknown }>) {
      const match = typeof detail?.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay) : null;
      if (match) return Math.round(Number(match[1]) * 1000);
    }
  }
  return undefined;
}

export type RetryNotice = { error: unknown; attempt: number; delayMs: number };

/**
 * Runs a model request, and runs it again when it failed in a way that another try can mend.
 * - An error with a retryable status (see `isRetryableStatus`) is retried after a wait that doubles
 *   each time, with jitter, or after the wait the provider asked for.
 * - An error with another status is not retried.
 * - An error without a status is retried once, at once, when `unknownErrors` is "once"; otherwise not.
 * Nothing is retried after the signal aborted, or once `canRetry` says no.
 */
export async function withRetry<T>(run: () => Promise<T>, options: {
  retry?: RetryOptions | undefined;
  signal?: AbortSignal | undefined;
  /** False once the attempt did something that must not happen twice: text was shown to the user. */
  canRetry?: () => boolean;
  onRetry?: (notice: RetryNotice) => void;
  unknownErrors?: "once" | "never";
} = {}): Promise<T> {
  const retries = Math.max(0, Math.trunc(options.retry?.retries ?? DEFAULT_RETRIES));
  const base = Math.max(0, options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const longest = Math.max(0, options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const wait = options.retry?.sleep ?? sleep;
  const random = options.retry?.random ?? Math.random;
  let unknownRetried = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (options.signal?.aborted || options.canRetry?.() === false) throw error;
      const status = statusOf(error);
      if (status === undefined) {
        if (options.unknownErrors !== "once" || unknownRetried || retries === 0) throw error;
        unknownRetried = true;
        continue;
      }
      if (!isRetryableStatus(status) || attempt >= retries) throw error;
      const asked = (error as { retryAfterMs?: unknown }).retryAfterMs;
      let delayMs: number;
      if (typeof asked === "number" && Number.isFinite(asked) && asked >= 0) {
        // Waiting longer than the caller allows helps no one who is waiting for an answer.
        if (asked > longest) throw error;
        delayMs = asked;
      } else {
        delayMs = Math.min(longest, base * 2 ** attempt * (0.5 + random() / 2));
      }
      options.onRetry?.({ error, attempt: attempt + 1, delayMs });
      await wait(delayMs, options.signal);
    }
  }
}
