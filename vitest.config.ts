import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The test files that hold work the CPU does to the clock: an elapsed time or an event-loop gap under
 * a bound less than about 10 times what the work takes on an idle machine, or a count of the pauses
 * the work leaves for a timer. Other test files running at the same time slow that work, and on a
 * busy machine these failed. They run in the "timing" project: one file at a time, after the other
 * files, each test with one retry and 20 s. A new test of that kind goes in one of these files, or
 * in a file added here (CONTRIBUTING.md). A wait on a timer alone (a 50 ms time limit checked under
 * 2 s) is not slowed that much, and stays with the other tests.
 */
const TIMING = [
  "test/encodings.test.ts",
  "test/hygiene.test.ts",
  "test/ingest-limits.test.ts",
  "test/library.test.ts",
  "test/limits-0.8.2.test.ts",
  "test/limits.test.ts",
  "test/pdf-names.test.ts",
  "test/pdf-parse-pauses.test.ts",
  "test/pdf-pictures.test.ts",
  "test/review-0.8.test.ts",
  "test/sse.test.ts",
  "test/text-and-extract.test.ts",
  "test/verify-0.8-html.test.ts",
  "test/verify-0.8-office.test.ts",
  "test/verify-0.8-search.test.ts",
  "test/verify-0.8-tools.test.ts",
  "test/verify-0.8-xlsx.test.ts",
];

export default defineConfig({
  resolve: {
    // Tests and examples import the package by name; resolve it to source, not dist.
    alias: [
      { find: /^llm-large-files\/gemini$/, replacement: source("./src/gemini/index.ts") },
      { find: /^llm-large-files\/openai$/, replacement: source("./src/openai/index.ts") },
      { find: /^llm-large-files\/anthropic$/, replacement: source("./src/anthropic/index.ts") },
      { find: /^llm-large-files\/node$/, replacement: source("./src/node/index.ts") },
      { find: /^llm-large-files$/, replacement: source("./src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Only the tests of this checkout: not those of a worktree or a copy kept inside it.
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...TIMING],
        },
      },
      {
        extends: true,
        test: {
          name: "timing",
          include: TIMING,
          // One file at a time, which also puts these files after the others.
          fileParallelism: false,
          retry: 1,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
