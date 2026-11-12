/**
 * Lets at most `max` tasks hold a slot at once; the others wait their turn, in order. Used for
 * scans of whole documents: on one thread more of them at once do not finish sooner, they only
 * hold more memory.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** Waits for a slot. Call the returned function once to give it back. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const at = this.waiting.indexOf(start);
        if (at !== -1) this.waiting.splice(at, 1);
        reject(signal!.reason);
      };
      const start = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiting.push(start);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The slot was handed over by the task that gave it back: `active` already counts it.
    return this.releaser();
  }

  /** Tasks holding a slot, and tasks waiting for one. */
  get load(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
