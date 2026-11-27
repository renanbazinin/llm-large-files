import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";

describe("a whole-file read stopped by the app's own error (since 0.99.13)", () => {
  it("does not tell an onToolResult hook's network failure as the model's", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, mapChunkTokens: 40_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    // Part requests that are still running when the hook throws, and end with why they were stopped.
    const generateText = ({ signal }: { signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve("notes"), 200);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
    const model = fakeModel([calls([
      { name: "analyze_whole_document", args: { document_id: meta.id, task: "everything" } },
      { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } },
    ]), says("never")], { generateText });
    // A DLP service that cannot be reached: a connection failure, but not the model's.
    const dlpDown = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNRESET 10.0.0.5:443"), { code: "ECONNRESET", syscall: "connect" }) });
    const events: AskEvent[] = [];
    const thrown = await askWithFiles({
      files,
      model,
      documentIds: [meta.id],
      messages: [{ role: "user", text: "?" }],
      onToolResult: async ({ call }) => {
        if (call.name !== "search_document") return undefined;
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw dlpDown;
      },
      onEvent: (event) => events.push(event),
    }).catch((error: unknown) => error);
    expect(thrown).toBe(dlpDown);
    const told = JSON.stringify(events);
    expect(told).not.toContain("could not be reached");
    expect(told).not.toContain('"kind":"unreachable"');
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: "run.error", error: { message: "fetch failed" } });
    expect(events.some((event) => event.type === "request.end" && event.outcome === "error")).toBe(true);
  });
});
