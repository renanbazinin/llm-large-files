import { defineConfig } from "vitest/config";

/**
 * The evals (evals/run.ts), apart from the tests: `npm run eval:replay` replays every case from
 * evals/cassettes without the network; `eval:record` and `eval:live` call the Gemini API. Vitest
 * runs their TypeScript, so they need no build. The variables are those evals/run.ts lists.
 */
const live = process.env.EVAL_MODE === "record" || process.env.EVAL_MODE === "live";

export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/run.ts"],
    // A live case of three runs takes minutes; a replayed one, seconds.
    testTimeout: live ? 0 : 120_000,
    // The files are built and ingested while the cases are collected.
    hookTimeout: 120_000,
    // Cases at once: a few against the API, 8 in a replay. Each case has its own memory of output
    // limits (src/output-limit.ts, `outputLimits`, 0.99.15), so a case does not depend on what
    // another learned before it: cases replay alone (--cases), in reverse (--order reverse) or at
    // once. Until then a replay ran one case at a time, in the order of the cases.
    maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || (live ? 4 : 8),
  },
});
