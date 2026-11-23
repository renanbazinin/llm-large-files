// "llm-large-files/testing" (new in 0.9.0): the fakes of the library's own tests, in the package,
// for the tests of an app.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type ModelRequest } from "llm-large-files";
import { openAiCompatible } from "llm-large-files/openai";
import * as testing from "llm-large-files/testing";
import { calls, fakeFetch, fakeModel, httpError, says, serviceLog, sse, utf8 } from "llm-large-files/testing";
import * as local from "./fake-model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("llm-large-files/testing", () => {
  it("exports the fakes, and test/fake-model.ts gives the same ones", () => {
    expect(Object.keys(testing).sort()).toEqual(["calls", "fakeFetch", "fakeModel", "httpError", "says", "serviceLog", "sse", "utf8"]);
    for (const name of ["calls", "fakeModel", "httpError", "says", "serviceLog", "utf8"] as const) expect(local[name]).toBe(testing[name]);
  });

  it("is a subpath of the package, built to dist/testing, with its types for every resolution", async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      typesVersions: { "*": Record<string, string[]> };
      sideEffects: boolean;
    };
    expect(pkg.exports["./testing"]).toEqual({ types: "./dist/testing/index.d.ts", default: "./dist/testing/index.js" });
    expect(pkg.typesVersions["*"].testing).toEqual(["./dist/testing/index.d.ts"]);
    expect(pkg.sideEffects).toBe(false);
  });

  it("imports no test framework and no peer: an app's tests load it with whatever they run on", async () => {
    const folder = path.join(ROOT, "src/testing");
    const imported: string[] = [];
    for (const file of await readdir(folder)) {
      const code = await readFile(path.join(folder, file), "utf8");
      for (const match of code.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) imported.push(match[1]!);
    }
    expect(imported.filter((specifier) => !specifier.startsWith("."))).toEqual([]);
  });

  it("runs the tool loop with a scripted model", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(400)) });
    const search = { id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const model = fakeModel([calls([search]), says("4 errors.")]);
    const shown: string[] = [];
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "How many errors?" }], onText: (text) => shown.push(text) });
    expect(result).toMatchObject({ answered: true, text: "4 errors." });
    expect(model.requests).toHaveLength(2);
    expect(model.capabilities).toMatchObject({ toolFiles: "inside", pageTokens: 500 });
    // The text comes in two pieces, as from a stream.
    expect(shown).toEqual(["4 err", "ors."]);
    expect(serviceLog(400).split("\n").filter((line) => line.includes(" ERROR ")).length).toBe(4);
    expect(httpError(429, "Busy.", 2_000)).toMatchObject({ message: "Busy.", status: 429, retryAfterMs: 2_000 });
  });

  it("gives a real adapter scripted replies, and records what it sent", async () => {
    const chunk = (content: string, finish?: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }] });
    const api = fakeFetch([
      Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "Heron." }, finish_reason: "stop" }] }),
      (sent) => sse([chunk(`Streamed for ${sent.body.model}.`, "stop"), "[DONE]"]),
    ]);
    const model = openAiCompatible({ model: "m", baseUrl: "https://llm.test/v1", apiKey: "test-key", fetch: api.fetch });
    const request: ModelRequest = { system: "", messages: [{ role: "user", parts: [{ text: "The code word?" }] }] };
    expect((await model.send(request)).text).toBe("Heron.");
    expect((await model.send(request, { onText: () => undefined })).text).toBe("Streamed for m.");
    // The last reply repeats.
    expect((await model.send(request, { onText: () => undefined })).text).toBe("Streamed for m.");
    expect(api.sent).toHaveLength(3);
    expect(api.sent[0]).toMatchObject({ url: "https://llm.test/v1/chat/completions", method: "POST", headers: { Authorization: "Bearer test-key" }, body: { model: "m" } });
    expect(api.sent[1]!.body.stream).toBe(true);
  });

  it("rejects with the signal's reason, also while a reply waits, and reads a Request's own headers and body", async () => {
    const slow = fakeFetch([async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return Response.json({ late: true });
    }]);
    const controller = new AbortController();
    const reason = new Error("Gave up.");
    const pending = slow.fetch("https://llm.test/slow", { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    const started = performance.now();
    await expect(pending).rejects.toBe(reason);
    expect(performance.now() - started).toBeLessThan(2_000);
    await expect(slow.fetch("https://llm.test/slow", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const api = fakeFetch([Response.json({ ok: true })]);
    await api.fetch(new Request("https://llm.test/r", { method: "POST", headers: { "X-Key": "k" }, body: JSON.stringify({ model: "m" }) }));
    expect(api.sent[0]).toEqual({ url: "https://llm.test/r", method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", "x-key": "k" }, body: { model: "m" } });
  });

  it("answers a Response more than once, each time with a copy", async () => {
    const api = fakeFetch([Response.json({ n: 1 })]);
    expect(await (await api.fetch("https://llm.test/a")).json()).toEqual({ n: 1 });
    expect(await (await api.fetch(new URL("https://llm.test/b"), { method: "POST", headers: new Headers({ "X-Key": "k" }), body: "not JSON" })).json()).toEqual({ n: 1 });
    expect(api.sent).toEqual([
      { url: "https://llm.test/a", method: "GET", headers: {}, body: {} },
      { url: "https://llm.test/b", method: "POST", headers: { "x-key": "k" }, body: {} },
    ]);
    expect(() => fakeFetch([])).toThrow(TypeError);
  });
});
