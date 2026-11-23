import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The folder of the tests that hold work the CPU does to the clock: an elapsed time or an event-loop
 * gap under a bound, a count of the pauses the work leaves for a timer, or a count of events in a
 * time. Other test files running at the same time slow that work, and so does counting coverage: on
 * a busy machine, such tests with a bound less than about 10 times what the work takes on an idle
 * machine failed. Their files run in the "timing" project: one file at a time, after the other
 * files, each test with one retry and 20 s. The "unit" project, and so `npm run coverage`, leaves
 * them out. A new test of that kind goes in a file of this folder, test/timing/<topic>.timing.test.ts,
 * and the other tests of its subject stay in their own file (CONTRIBUTING.md). A wait on a timer
 * alone (a 50 ms time limit checked under 2 s) is not slowed that much, and stays with the other tests.
 * So do timers counted against a timer (heartbeats of 20 ms, at least 4 in 260 ms), and a check that
 * work does not hang, under a bound far above its time on a busy machine (a child process started
 * within 8 s).
 */
const TIMING = "test/timing/**/*.test.ts";

export default defineConfig({
  resolve: {
    // Tests and examples import the package by name; resolve it to source, not dist.
    alias: [
      { find: /^llm-large-files\/gemini$/, replacement: source("./src/gemini/index.ts") },
      { find: /^llm-large-files\/openai$/, replacement: source("./src/openai/index.ts") },
      { find: /^llm-large-files\/anthropic$/, replacement: source("./src/anthropic/index.ts") },
      { find: /^llm-large-files\/node$/, replacement: source("./src/node/index.ts") },
      { find: /^llm-large-files\/testing$/, replacement: source("./src/testing/index.ts") },
      { find: /^llm-large-files$/, replacement: source("./src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    // `npm run coverage`: the unit project, over the source (coverage/coverage-summary.json). No
    // thresholds yet: they are set from the suite of the release. The numbers are reported even when
    // a test fails: counting makes the tests several times slower, and its script gives each 60 s. A
    // test's own timeout is kept: one that is slow under coverage needs one that fits.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      reportOnFailure: true,
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Only the tests of this checkout: not those of a worktree or a copy kept inside it.
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, TIMING],
        },
      },
      {
        extends: true,
        test: {
          name: "timing",
          include: [TIMING],
          // One file at a time, which also puts these files after the others.
          fileParallelism: false,
          retry: 1,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
