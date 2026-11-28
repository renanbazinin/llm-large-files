// The browser entry `llm-large-files/client` (CIT-7, 0.99.14): what it exports, `readEvents`, and
// that nothing it loads imports a Node module or another package, so it bundles for a browser.
// The import graph is walked over the JavaScript TypeScript emits for each module (type-only
// imports are left out, as in dist/), from src/client/index.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as client from "llm-large-files/client";
import { answerInfoOf, describeLocator, errorInfoOf, insertCitationTokens, readEvents } from "llm-large-files/client";

const SOURCE = fileURLToPath(new URL("../src/", import.meta.url));

/** The modules each emitted module imports: static, side-effect, re-export and dynamic imports. */
function importsOf(file: string): string[] {
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  const found: string[] = [];
  for (const match of outputText.matchAll(/(?:^|[;\s])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|(?:^|[;\s])import\s*["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gm)) {
    found.push((match[1] ?? match[2] ?? match[3])!);
  }
  if (/\brequire\s*\(/.test(outputText)) found.push("require()");
  return found;
}

/** Every module the entry loads, and each import that is not a module of the package. */
function walk(entry: string): { modules: string[]; outside: string[] } {
  const seen = new Set<string>();
  const outside: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith("./") || spec.startsWith("../")) visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
      else outside.push(`${path.relative(SOURCE, file).split(path.sep).join("/")} imports ${spec}`);
    }
  };
  visit(entry);
  return { modules: [...seen].map((file) => path.relative(SOURCE, file).split(path.sep).join("/")).sort(), outside };
}

describe("llm-large-files/client", () => {
  it("loads no Node module and no other package", () => {
    const { modules, outside } = walk(path.join(SOURCE, "client", "index.ts"));
    expect(outside).toEqual([]);
    // The server's parts stay out: the question loop, the library, the tools, the hider.
    for (const server of ["ask.ts", "library.ts", "tools.ts", "citations.ts", "map-reduce.ts", "search.ts"]) expect(modules).not.toContain(server);
    expect(modules).toContain("error-info.ts");
  });

  it("finds a Node import if one is added (the walk itself works)", () => {
    expect(importsOf(path.join(SOURCE, "search.ts"))).toContain("node:vm");
    expect(importsOf(path.join(SOURCE, "version-token.ts"))).toContain("node:crypto");
  });

  it("exports what a page needs", () => {
    expect(Object.keys(client).sort()).toEqual(["answerInfoOf", "describeLocator", "errorInfoOf", "insertCitationTokens", "readEvents"]);
    expect(insertCitationTokens("הקנס 30 ש״ח.", [{ at: 11, label: 1 }])).toBe("הקנס 30 ש״ח⟦1⟧.");
    expect(describeLocator({ kind: "row", sheetIndex: 2, sheet: "לקוחות", row: 8 }, "he")).toBe("גיליון לקוחות · שורה 8");
    expect(answerInfoOf({ answered: true, finish: "cut" })).toMatchObject({ complete: false, reason: "cut" });
    expect(errorInfoOf({ message: "x", kind: "rate_limit", status: 429 })).toMatchObject({ category: "model", code: "rate_limit" });
  });
});

describe("readEvents", () => {
  const streamOf = (pieces: string[]) => new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    },
  }));

  it("gives the data of each message, parsed, however the stream is cut", async () => {
    const whole = ": keep-alive\n\ndata: {\"type\":\"text\",\"delta\":\"שלום\\u2028\"}\n\nevent: x\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata: not json\n\ndata: [2]\n\ndata: {\"cut\":";
    for (const size of [1, 2, 3, 7, whole.length]) {
      const pieces: string[] = [];
      for (let at = 0; at < whole.length; at += size) pieces.push(whole.slice(at, at + size));
      const got: unknown[] = [];
      const bad: string[] = [];
      await readEvents(streamOf(pieces), (data) => got.push(data), { onBadMessage: (_error, data) => bad.push(data) });
      expect(got, `size ${size}`).toEqual([{ type: "text", delta: "שלום " }, { a: 1 }, [2]]);
      expect(bad).toEqual(["not json"]);
    }
  });

  it("stops when its signal aborts, and refuses a response without a body", async () => {
    const controller = new AbortController();
    const got: unknown[] = [];
    await readEvents(streamOf(["data: 1\n\ndata: 2\n\n"]), (data) => {
      got.push(data);
      controller.abort();
    }, { signal: controller.signal });
    expect(got).toEqual([1]);
    await expect(readEvents(new Response(null), () => undefined)).rejects.toThrow(TypeError);
  });
});
