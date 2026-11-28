// What part reads learn about a model's output limit is kept in a memory (0.99.15): one that every
// adapter of a process shares, as before, or one of its own given with `outputLimits`. The evals
// give each case its own, so that a case replays alone, in any order, or at the same time as others
// (EVAL-ORDER). In 0.99.14 it was kept in module state only, and a test could not start empty.
import { describe, expect, it } from "vitest";
import { createOutputLimits as fromRoot, type OutputLimits } from "../src/index.js";
import { createOutputLimits as fromAnthropic } from "../src/anthropic/index.js";
import { createOutputLimits as fromGemini, createGeminiGenerateText, gemini } from "../src/gemini/index.js";
import { createOutputLimits as fromOpenAi } from "../src/openai/index.js";
import { completeWithinLimit, seedOutputLimit, THINKING_OUTPUT_TOKENS, type LimitedReply } from "../src/output-limit.js";

/** A model that thinks its limit away: cut off with nothing written below the larger limit. */
function thinker(limits: number[]) {
  return async (limit: number): Promise<LimitedReply> => {
    limits.push(limit);
    return limit < THINKING_OUTPUT_TOKENS ? { text: "", cutOff: true, thoughts: limit } : { text: "notes", cutOff: false, thoughts: 1_000 };
  };
}

describe("the memory of output limits (0.99.15)", () => {
  it("is one function, exported by the package and by each adapter's entry", () => {
    expect(fromGemini).toBe(fromRoot);
    expect(fromOpenAi).toBe(fromRoot);
    expect(fromAnthropic).toBe(fromRoot);
  });

  it("keeps what one memory learned from another, and from the shared one", async () => {
    const model = `https://example.invalid/memory-${Date.now()}`;
    const one = fromRoot();
    const other = fromRoot();
    const first: number[] = [];
    expect(await completeWithinLimit(model, 4_096, thinker(first), { memory: one })).toBe("notes");
    expect(first).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    // The same memory starts at the larger limit: no request wasted.
    const again: number[] = [];
    await completeWithinLimit(model, 4_096, thinker(again), { memory: one });
    expect(again).toEqual([THINKING_OUTPUT_TOKENS]);
    // Another memory, and the shared one, learned nothing.
    const fresh: number[] = [];
    await completeWithinLimit(model, 4_096, thinker(fresh), { memory: other });
    expect(fresh).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    const shared: number[] = [];
    await completeWithinLimit(model, 4_096, thinker(shared));
    expect(shared).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
  });

  it("shares what is learned between calls that give no memory, as before 0.99.15", async () => {
    const model = `https://example.invalid/shared-${Date.now()}`;
    const first: number[] = [];
    await completeWithinLimit(model, 4_096, thinker(first));
    const second: number[] = [];
    await completeWithinLimit(model, 4_096, thinker(second));
    expect(first).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    expect(second).toEqual([THINKING_OUTPUT_TOKENS]);
  });

  it("lets memories learn at the same time without waiting on each other's first request", async () => {
    const model = `https://example.invalid/concurrent-${Date.now()}`;
    let release = () => undefined as void;
    const held = completeWithinLimit(model, 4_096, () => new Promise<LimitedReply>((resolve) => {
      release = () => resolve({ text: "held", cutOff: false, thoughts: 0 });
    }), { memory: fromRoot() });
    // A request with its own memory is not held behind the first request of another memory.
    const sent: number[] = [];
    expect(await completeWithinLimit(model, 4_096, async (limit) => {
      sent.push(limit);
      return { text: "free", cutOff: false, thoughts: 0 };
    }, { memory: fromRoot() })).toBe("free");
    expect(sent).toEqual([4_096]);
    release();
    expect(await held).toBe("held");
  });

  it("starts as a process that learned the limit when seeded (the evals' old recordings)", async () => {
    const model = `https://example.invalid/seeded-${Date.now()}`;
    const memory = fromRoot();
    seedOutputLimit(memory, model, THINKING_OUTPUT_TOKENS);
    const limits: number[] = [];
    await completeWithinLimit(model, 4_096, thinker(limits), { memory });
    expect(limits).toEqual([THINKING_OUTPUT_TOKENS]);
  });

  it("has nothing an app can change: the memory is a frozen object with no keys", () => {
    const memory: OutputLimits = fromRoot();
    expect(Object.keys(memory)).toEqual([]);
    expect(Object.isFrozen(memory)).toBe(true);
  });

  it("is used by createGeminiGenerateText and by a gemini() adapter's part reads", async () => {
    const url = `https://example.invalid/v1beta/models/m-${Date.now()}:generateContent`;
    const sent: number[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const limit = (JSON.parse(String(init?.body)) as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens;
      sent.push(limit);
      const body = limit < THINKING_OUTPUT_TOKENS
        ? { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }], usageMetadata: { thoughtsTokenCount: limit } }
        : { candidates: [{ content: { parts: [{ text: "notes" }] }, finishReason: "STOP" }], usageMetadata: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const memory = fromRoot();
    const generate = createGeminiGenerateText({ url, headers: {}, fetchImpl, outputLimits: memory });
    expect(await generate({ system: "", prompt: "Notes on this part.", maxOutputTokens: 4_096 })).toBe("notes");
    expect(sent).toEqual([4_096, THINKING_OUTPUT_TOKENS]);
    // An adapter given the same memory starts at the larger limit.
    const adapter = gemini({ url, streamUrl: url, headers: {} }, { fetch: fetchImpl, outputLimits: memory });
    sent.length = 0;
    expect(await adapter.generateText!({ system: "", prompt: "Notes on this part.", maxOutputTokens: 4_096 })).toBe("notes");
    expect(sent).toEqual([THINKING_OUTPUT_TOKENS]);
  });
});
