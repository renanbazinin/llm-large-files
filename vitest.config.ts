import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests and examples import the package by name; resolve it to source, not dist.
    alias: [
      { find: /^llm-large-files\/gemini$/, replacement: source("./src/gemini/index.ts") },
      { find: /^llm-large-files\/node$/, replacement: source("./src/node/index.ts") },
      { find: /^llm-large-files$/, replacement: source("./src/index.ts") },
    ],
  },
  test: {
    environment: "node",
  },
});
