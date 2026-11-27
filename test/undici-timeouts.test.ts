// Node's fetch (undici) cuts a request that gets no headers, or no more of its body, for 300 s: a
// TypeError "fetch failed" whose cause has the code UND_ERR_HEADERS_TIMEOUT or UND_ERR_BODY_TIMEOUT.
// Since 0.99.13 every adapter tells it as kind "timeout", sent again once, as its own watch's
// timeout is (ADAPT-1). A connection that never opened (UND_ERR_CONNECT_TIMEOUT) still could not
// reach the model, and is sent again three times.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, errorInfoOf, MemoryDocumentStore, type AskEvent, type ModelAdapter } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible, openAiResponses } from "llm-large-files/openai";
import { calls, fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";
import { connectionFailure } from "../src/connection-failure.js";
import { modelFailureReason } from "../src/map-reduce.js";

const ADAPTERS: Record<string, (fetch: typeof globalThis.fetch) => ModelAdapter> = {
  gemini: (fetch) => gemini(vertexAi({ project: "p", location: "europe-west4", model: "m", accessToken: "t" }), { fetch }),
  openAiCompatible: (fetch) => openAiCompatible({ model: "m", apiKey: "k", fetch }),
  openAiResponses: (fetch) => openAiResponses({ model: "m", apiKey: "k", fetch }),
  anthropic: (fetch) => anthropic({ model: "claude-test", apiKey: "k", fetch }),
};

const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
const small = await files.ingest({ name: "a.txt", bytes: utf8("hello\n") });
const big = await files.ingest({ name: "big.log", bytes: utf8(serviceLog(3_000)) });
const RETRY = { sleep: async () => undefined, random: () => 0.5 };

/** undici's error: "fetch failed", with the code in its cause. */
const undiciError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("Timeout Error"), { code }) });

/** A fetch that always fails with undici's error of `code`, and counts its calls. */
function failing(code: string) {
  let attempts = 0;
  const fetch = (async () => {
    attempts++;
    throw undiciError(code);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, attempts: () => attempts };
}

async function askOnce(name: string, code: string) {
  const api = failing(code);
  const seen: AskEvent[] = [];
  const error = await askWithFiles({ files, model: ADAPTERS[name]!(api.fetch), documentIds: [small.id], messages: [{ role: "user", text: "q" }], retry: RETRY, onEvent: (event) => void seen.push(event) }).catch((caught: unknown) => caught);
  return { error, attempts: api.attempts(), seen };
}

describe("ADAPT-1: undici's headers and body timeouts", () => {
  describe.each(Object.keys(ADAPTERS))("%s", (name) => {
    it.each(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])("%s: kind timeout, status 0, sent again once", async (code) => {
      const run = await askOnce(name, code);
      expect(run.error).toMatchObject({ kind: "timeout", status: 0 });
      // undici's error is kept, for the log.
      expect((run.error as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
      expect(errorInfoOf(run.error)).toMatchObject({ category: "model", code: "timeout", status: 504, retryable: true });
      expect(run.attempts).toBe(2);
      const retries = run.seen.filter((event): event is Extract<AskEvent, { type: "retry" }> => event.type === "retry");
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ attempt: 1, error: { kind: "timeout", status: 0, message: "The model took too long to answer." }, message: "The model sent nothing for too long. Trying again…" });
      expect(retries[0]!.reason).toBeUndefined();
    });

    it("UND_ERR_CONNECT_TIMEOUT: still a model that could not be reached, sent again three times", async () => {
      const run = await askOnce(name, "UND_ERR_CONNECT_TIMEOUT");
      expect(run.error).toMatchObject({ kind: "unreachable", status: 0 });
      expect(errorInfoOf(run.error)).toMatchObject({ category: "model", code: "unreachable", status: 502, retryable: true });
      expect(run.attempts).toBe(4);
    });

    it("a part read whose fetch times out: sent again once, then told as a timeout", async () => {
      const api = failing("UND_ERR_HEADERS_TIMEOUT");
      const model = ADAPTERS[name]!(api.fetch);
      const result = await askWithFiles({ files, model: fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: big.id, task: "List every ERROR line" } }]), says("Done.")], { generateText: model.generateText! }), documentIds: [big.id], messages: [{ role: "user", text: "List every ERROR line" }], retry: RETRY, budget: { inlineTokens: 2_000, mapChunkTokens: 20_000 } });
      const read = result.toolTurns.flatMap((turn) => turn.calls).find((call) => call.name === "analyze_whole_document")?.result as Record<string, unknown> | undefined;
      expect(read?.error).toBe("Could not read any part of big.log: The model took too long to answer.");
      // 11 parts, each tried twice.
      expect(api.attempts()).toBe(22);
    });
  });

  it("one table: a whole-file read tells undici's error by the same kinds (modelFailureReason)", () => {
    expect(connectionFailure(undiciError("UND_ERR_HEADERS_TIMEOUT"))).toEqual({ kind: "timeout", code: "UND_ERR_HEADERS_TIMEOUT" });
    expect(connectionFailure(undiciError("UND_ERR_CONNECT_TIMEOUT"))).toEqual({ kind: "unreachable", code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(modelFailureReason(undiciError("UND_ERR_HEADERS_TIMEOUT"))).toBe("The model took too long to answer.");
    expect(modelFailureReason(undiciError("UND_ERR_BODY_TIMEOUT"))).toBe("The model took too long to answer.");
    expect(modelFailureReason(undiciError("UND_ERR_CONNECT_TIMEOUT"))).toBe("The model could not be reached.");
  });
});
