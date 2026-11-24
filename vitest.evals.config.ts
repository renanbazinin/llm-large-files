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
    // Cases at once: a few against the API, one at a time in a replay. A part read learns the
    // output limit a model needs once in a process (THINKING_OUTPUT_TOKENS, src/output-limit.ts),
    // and Gemini 3.8 Flash's cassettes are recorded one case at a time, in the order of the cases:
    // its cleaning-sanctions and diary-planted-nothing start their part reads at the limit that
    // contract-summary's read learned before them. Replayed 8 at a time, they raced that read
    // and failed about one replay in five; one at a time, the 90 cases take about 15 seconds.
    maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || (live ? 4 : 1),
  },
});
