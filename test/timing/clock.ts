// What the tests of this folder read from the clock: how long work took, how often a timer got a
// turn while it ran, and the longest time the event loop went without one.

/** How long `work` took, by `performance.now()`. */
export const timed = async <T>(work: () => T | Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
};

/** Counts the beats of a 2 ms timer while `work` runs: 0 when the work never lets a timer run. */
export async function beatsDuring<T>(work: () => Promise<T>): Promise<{ beats: number; result: T }> {
  let beats = 0;
  const timer = setInterval(() => beats++, 2);
  try {
    const result = await work();
    return { beats, result };
  } finally {
    clearInterval(timer);
  }
}

/** The time `work` takes, and the longest time the event loop went without a turn meanwhile. */
export async function measured<T>(work: () => T | Promise<T>): Promise<{ value: T; ms: number; gap: number }> {
  let gap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 2);
  const started = performance.now();
  // A turn first, so that the timer has started.
  await new Promise((resolve) => setImmediate(resolve));
  last = performance.now();
  const value = await work();
  const ms = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(timer);
  return { value, ms, gap: Math.max(gap, performance.now() - last - 5) };
}
