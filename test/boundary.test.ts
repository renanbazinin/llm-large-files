import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The package must stay extractable to its own npm repository: it may import only its own
// files, Node built-ins, and its declared optional peers.
const ALLOWED_PACKAGES = new Set(["jszip", "unpdf"]);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (
    entry.isDirectory() ? files(path.join(directory, entry.name)) : Promise.resolve([path.join(directory, entry.name)])
  )));
  return nested.flat().filter((file) => file.endsWith(".ts"));
}

describe("package boundary", () => {
  it("imports nothing from the host application", async () => {
    const problems: string[] = [];
    for (const file of await files(source)) {
      const code = await readFile(file, "utf8");
      for (const match of code.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith("node:") || ALLOWED_PACKAGES.has(specifier)) continue;
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(file), specifier);
          if (target.startsWith(source)) continue;
        }
        problems.push(`${path.relative(source, file)} imports ${specifier}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
