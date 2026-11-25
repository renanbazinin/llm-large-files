// The time limit of a part read of a whole-file read (A11, LLF-056; 0.10.0): `timeoutMs` in all three
// adapters, gemini() included. A part past it is a ModelRequestError of kind "timeout" and status 0,
// sent again once by the rule of withRetry, and then reported as "The model took too long to
// answer". 0 sets no limit.
import { describe, expect, it } from "vitest";
import { createLargeFiles, errorKindOf, MemoryDocumentStore, ModelRequestError, type ModelAdapter } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { createGeminiGenerateText, gemini, geminiApi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { fakeFetch, serviceLog, utf8, type FakeFetch } from "llm-large-files/testing";

/** A reply of each provider with this text. */
const replies = {
  gemini: (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }] }),
  openai: (text: string) => Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }] }),
  anthropic: (text: string) => Response.json({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
};
type Provider = keyof typeof replies;

/** An adapter of each provider, with a fetch of its own and a model name no other test uses (part reads learn by URL). */
function adapterOf(provider: Provider, api: FakeFetch, name: string, timeoutMs: number): ModelAdapter {
  if (provider === "gemini") return gemini(geminiApi({ apiKey: "k", model: name }), { fetch: api.fetch, timeoutMs });
  if (provider === "openai") return openAiCompatible({ model: name, apiKey: "k", baseUrl: "https://llm.example/v1", fetch: api.fetch, timeoutMs });
  return anthropic({ model: name, apiKey: "k", fetch: api.fetch, timeoutMs });
}

/** A fetch that answers after `ms`, unless the request is aborted first. */
const slow = (provider: Provider, ms: number) => fakeFetch([() => new Promise<Response>((resolve) => setTimeout(() => resolve(replies[provider]("Notes (L1).")), ms))]);

const PROVIDERS: Provider[] = ["gemini", "openai", "anthropic"];

describe("the time limit of a part read since 0.10.0", () => {
  for (const provider of PROVIDERS) {
    it(`reports a part read past timeoutMs as too slow, and sends it again once (${provider})`, async () => {
      const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
      const meta = await files.ingest({ name: "short.log", bytes: utf8(serviceLog(200)) });
      const api = slow(provider, 1_500);
      const model = adapterOf(provider, api, `${provider}-too-slow`, 50);
      const retries: Array<{ attempt: number; delayMs: number; error: unknown }> = [];
      const tools = files.tools([meta], { generate: model.generateText!, retry: { sleep: async () => undefined } });
      const read = await tools.executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "Summarize." }, {}, {
        onRequest: () => ({ retry: (notice) => retries.push(notice), end: () => undefined }),
      });
      expect(read.result.error).toMatch(/The model took too long to answer\./);
      // The part was sent twice: once, and once more after its first timeout.
      expect(api.sent).toHaveLength(2);
      expect(retries).toHaveLength(1);
      const error = retries[0]!.error;
      expect(ModelRequestError.is(error)).toBe(true);
      expect(error).toMatchObject({ status: 0, kind: "timeout" });
      expect(errorKindOf(error)).toBe("timeout");
      expect((error as Error).message).toMatch(/took longer than 50 ms to answer/);
    });

    it(`waits without end with timeoutMs 0, and stops at once when the caller does (${provider})`, async () => {
      const api = slow(provider, 80);
      const model = adapterOf(provider, api, `${provider}-no-limit`, 0);
      expect(await model.generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("Notes (L1).");

      // The caller's abort is the caller's: it is not a timeout.
      const stopped = new AbortController();
      const reason = new Error("The user left.");
      const waiting = adapterOf(provider, slow(provider, 5_000), `${provider}-stopped`, 60_000).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100, signal: stopped.signal });
      setTimeout(() => stopped.abort(reason), 20);
      await expect(waiting).rejects.toBe(reason);
    });
  }

  for (const provider of PROVIDERS) {
    it(`ends the wait at timeoutMs for a fetch that does not stop when its signal aborts (${provider})`, async () => {
      // A fetch of your own that never answers and does not listen to its signal.
      let sent = 0;
      const hung = (async () => {
        sent++;
        return new Promise<Response>(() => undefined);
      }) as unknown as typeof fetch;
      const model = provider === "gemini"
        ? gemini(geminiApi({ apiKey: "k", model: "gemini-hung" }), { fetch: hung, timeoutMs: 50 })
        : provider === "openai"
          ? openAiCompatible({ model: "openai-hung", apiKey: "k", baseUrl: "https://llm.example/v1", fetch: hung, timeoutMs: 50 })
          : anthropic({ model: "anthropic-hung", apiKey: "k", fetch: hung, timeoutMs: 50 });
      const started = Date.now();
      const error = await model.generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 }).then(() => undefined, (failed: unknown) => failed);
      expect(error).toMatchObject({ status: 0, kind: "timeout" });
      expect(sent).toBe(1);
      // In 0.9 and before this fix, it was still waiting after 2 s.
      expect(Date.now() - started).toBeLessThan(1_500);
    });
  }

  it("gives gemini() the default of 180 s, and createGeminiGenerateText none with 0", async () => {
    // A reply after 100 ms is well within it.
    const api = slow("gemini", 100);
    expect(await gemini(geminiApi({ apiKey: "k", model: "gemini-default-limit" }), { fetch: api.fetch }).generateText!({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("Notes (L1).");
    // In 0.9, 0 was a limit of no time at all: every request was aborted at once.
    const read = createGeminiGenerateText({ url: "https://gemini.example/v1/models/no-limit:generateContent", headers: {}, timeoutMs: 0, fetchImpl: slow("gemini", 50).fetch });
    expect(await read({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("Notes (L1).");
  });
});
