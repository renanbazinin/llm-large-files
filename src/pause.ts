/** Lets other work on the server run (an answer streaming to another user) before going on. */
export const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

let turn: Promise<void> = Promise.resolve();

/**
 * `pause`, taken in turns: each caller waits for the pause before it, so one slice of work runs in
 * a turn of the event loop. Ten uploads that pause at once then hold the server for one slice
 * between two turns, not ten.
 */
export const fairPause = (): Promise<void> => (turn = turn.then(pause));

/** Work done between two pauses of a long loop, in milliseconds: short enough that nobody waits. */
const SLICE_MS = 12;

/**
 * Splits a long piece of synchronous work into slices, so that one upload does not hold the whole
 * server: call `maybePause()` now and then (every few thousand items), and it pauses once the
 * current slice has run for about 12 ms. It also stops the work when `signal` is aborted.
 */
export class TimeSlicer {
  private sliceStart = performance.now();

  constructor(private readonly signal?: AbortSignal) {}

  /** Whether the current slice has run its time: `maybePause` would pause now. */
  get due(): boolean {
    return performance.now() - this.sliceStart >= SLICE_MS;
  }

  async maybePause(): Promise<void> {
    if (this.due) await this.pauseNow();
  }

  /** Pauses, then starts a new slice. Throws the reason of `signal` when it was aborted meanwhile. */
  async pauseNow(): Promise<void> {
    await fairPause();
    this.signal?.throwIfAborted();
    this.sliceStart = performance.now();
  }
}
