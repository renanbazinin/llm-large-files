// A part read that waits for the first request to its model, which may be another question's
// (LLF-036, 0.10.0; probe2 of the 0.10.0 plan): its own abort ends the wait at once. In 0.9 it waited
// until the other request ended (1,501 ms for an abort at 50 ms).
import { describe, expect, it } from "vitest";
import { completeWithinLimit, type LimitedReply } from "../src/output-limit.js";

describe("completeWithinLimit since 0.10.0", () => {
  it("ends the wait for the first request of a model when the caller aborts", async () => {
    const model = `https://example.invalid/llf-036-${Date.now()}`;
    let release = () => undefined as void;
    const first = completeWithinLimit(model, 4_096, () => new Promise<LimitedReply>((resolve) => {
      release = () => resolve({ text: "first", cutOff: false, thoughts: 0 });
    }));
    const controller = new AbortController();
    const reason = new Error("The user left.");
    let sent = false;
    const second = completeWithinLimit(model, 4_096, async () => {
      sent = true;
      return { text: "second", cutOff: false, thoughts: 0 };
    }, { signal: controller.signal });
    let outcome = "still waiting";
    void second.then(() => (outcome = "resolved"), (error: unknown) => (outcome = error === reason ? "aborted" : `rejected: ${String(error)}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcome).toBe("still waiting");
    controller.abort(reason);
    // Ended at once: before the next turn of the event loop, and so before any timer could fire. A
    // wait that only looked at the signal now and then would still be waiting here.
    await new Promise((resolve) => setImmediate(resolve));
    expect(outcome).toBe("aborted");
    expect(sent).toBe(false);
    release();
    expect(await first).toBe("first");
  });

  it("still lets a waiter that is not aborted go on once the first request has learned the limit", async () => {
    const model = `https://example.invalid/llf-036-waiter-${Date.now()}`;
    let release = () => undefined as void;
    const limits: number[] = [];
    const first = completeWithinLimit(model, 4_096, (limit) => {
      limits.push(limit);
      return new Promise<LimitedReply>((resolve) => {
        release = () => resolve({ text: "first", cutOff: false, thoughts: 0 });
      });
    });
    const second = completeWithinLimit(model, 4_096, async (limit) => {
      limits.push(limit);
      return { text: "second", cutOff: false, thoughts: 0 };
    }, { signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(limits).toEqual([4_096]);
    release();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(limits).toEqual([4_096, 4_096]);
  });
});
