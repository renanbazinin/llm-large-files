// A token or header function that fails, in every adapter that takes one, with a fake fetch
// (0.99.13: ADAPT-3, ADAPT-REFRESH and ERR-SANITIZE). A connection that failed while the token was
// fetched is sent again; anything else is an "auth" error that is not; a 401 that vertexAi refreshes
// is told as a retry of reason "auth_refresh"; and no event, nor what the SSE route sends of it,
// carries the token client's words or the metadata server's address.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, errorInfoOf, MemoryDocumentStore, type AskEvent, type ModelAdapter } from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { gemini, vertexAi } from "llm-large-files/gemini";
import { openAiCompatible, openAiResponses } from "llm-large-files/openai";
import { sseMessageOf } from "llm-large-files/node";
import { calls, fakeFetch, fakeModel, says, serviceLog, utf8, type Sent } from "llm-large-files/testing";

type Json = Record<string, any>;
type Ctx = { refresh?: boolean };
type TokenFn = (ctx: Ctx, n: number) => string;

// ---------- the shapes of a token client's connection reset ----------
const SHAPES: Record<string, () => Error> = {
  "Error with code ECONNRESET, no syscall": () => Object.assign(new Error("metadata server: socket hang up"), { code: "ECONNRESET" }),
  "Node socket error (code ECONNRESET, syscall read)": () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read", errno: -104 }),
  "undici TypeError('fetch failed') with an ECONNRESET cause": () => new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read", errno: -104 }) }),
  "node-fetch FetchError": () => Object.assign(new Error("request to http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token failed, reason: socket hang up"), { name: "FetchError", code: "ECONNRESET", errno: "ECONNRESET", type: "system" }),
  "google-auth 'Could not refresh access token'": () => Object.assign(new Error("Could not refresh access token: request to http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token failed, reason: socket hang up"), { name: "GaxiosError", code: "ECONNRESET" }),
};
const revoked = () => Object.assign(new Error("invalid_grant: Token has been expired or revoked."), { name: "GaxiosError" });

// ---------- replies ----------
const events = (list: unknown[], named = false) => new Response(list.map((e: any) => (named ? `event: ${e.type}\n` : "") + `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const geminiChunk = (text: string) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } });
const respObj = (text: string) => ({ id: "resp_1", object: "response", model: "m", status: "completed", error: null, incomplete_details: null, output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } });
const antMsg = (text: string) => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } });

type Provider = { reply: (text: string, stream: boolean) => Response; refused: () => Response };
const PROVIDERS: Record<string, Provider> = {
  gemini: {
    reply: (text, stream) => (stream ? events([geminiChunk(text)]) : Response.json(geminiChunk(text))),
    refused: () => Response.json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, { status: 401 }),
  },
  openai: {
    reply: (text, stream) => (stream
      ? events([{ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }, { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } }, "[DONE]"])
      : Response.json({ id: "c1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 10, completion_tokens: 3 } })),
    refused: () => Response.json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 }),
  },
  responses: {
    reply: (text, stream) => (stream
      ? events([{ type: "response.created", response: { ...respObj(text), status: "in_progress", output: [], usage: null } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: text }, { type: "response.output_item.done", output_index: 0, item: respObj(text).output[0] }, { type: "response.completed", response: respObj(text) }])
      : Response.json(respObj(text))),
    refused: () => Response.json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 }),
  },
  anthropic: {
    reply: (text, stream) => (stream
      ? events([
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ], true)
      : Response.json(antMsg(text))),
    refused: () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }),
  },
};

// ---------- every adapter that takes a token or header function ----------
const bearer = (token: (ctx: Ctx) => Promise<string>) => async (ctx?: Ctx) => ({ Authorization: `Bearer ${await token(ctx ?? {})}` });
type AdapterCase = { name: string; provider: keyof typeof PROVIDERS; refreshes: boolean; make: (token: (ctx: Ctx) => Promise<string>, fetch: typeof globalThis.fetch) => ModelAdapter };
const ADAPTERS: AdapterCase[] = [
  { name: "gemini(vertexAi({ accessToken: fn }))", provider: "gemini", refreshes: true, make: (token, fetch) => gemini(vertexAi({ project: "p", location: "europe-west4", model: "gemini-x", accessToken: (ctx) => token(ctx) }), { fetch }) },
  { name: "gemini({ headers: fn }) (gateway)", provider: "gemini", refreshes: false, make: (token, fetch) => gemini({ url: "https://gw.example/v1/models/m:generateContent", streamUrl: "https://gw.example/v1/models/m:streamGenerateContent?alt=sse", headers: bearer(token) }, { fetch }) },
  { name: "openAiCompatible({ apiKey: fn })", provider: "openai", refreshes: false, make: (token, fetch) => openAiCompatible({ model: "m", apiKey: () => token({}), fetch }) },
  { name: "openAiCompatible({ headers: fn })", provider: "openai", refreshes: false, make: (token, fetch) => openAiCompatible({ model: "m", headers: bearer(token), fetch }) },
  { name: "openAiResponses({ apiKey: fn })", provider: "responses", refreshes: false, make: (token, fetch) => openAiResponses({ model: "m", apiKey: () => token({}), fetch }) },
  { name: "openAiResponses({ headers: fn })", provider: "responses", refreshes: false, make: (token, fetch) => openAiResponses({ model: "m", headers: bearer(token), fetch }) },
  { name: "anthropic({ apiKey: fn })", provider: "anthropic", refreshes: false, make: (token, fetch) => anthropic({ model: "claude-test", apiKey: () => token({}), fetch }) },
  { name: "anthropic({ authToken: fn })", provider: "anthropic", refreshes: false, make: (token, fetch) => anthropic({ model: "claude-test", authToken: () => token({}), fetch }) },
  { name: "anthropic({ headers: fn })", provider: "anthropic", refreshes: false, make: (token, fetch) => anthropic({ model: "claude-test", headers: bearer(token), fetch }) },
];

const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
const small = await files.ingest({ name: "a.txt", bytes: utf8("hello world\n") });
// 3,000 lines read whole in 11 parts (and one request that writes the read's answer).
const big = await files.ingest({ name: "big.log", bytes: utf8(serviceLog(3_000)) });
const PARTS = 11;
const RETRY = { sleep: async () => undefined, random: () => 0.5 };
const authOf = (sent: Sent) => sent.headers.Authorization ?? sent.headers.authorization ?? sent.headers["x-api-key"] ?? "";

type Path = "chat" | "stream" | "part";
/** One question through askWithFiles; for "part", a whole-file read through the adapter's generateText. */
async function ask(adapter: AdapterCase, path: Path, token: TokenFn, replies?: (p: Provider, stream: boolean) => Array<Response | ((sent: Sent) => Response)>) {
  const p = PROVIDERS[adapter.provider]!;
  const tokenCalls: string[] = [];
  const tokenFn = async (ctx: Ctx) => {
    tokenCalls.push(ctx.refresh === true ? "refresh" : "plain");
    return token(ctx, tokenCalls.length);
  };
  const stream = path === "stream";
  const api = fakeFetch(replies ? replies(p, stream) : [p.reply(path === "part" ? "Notes: nothing relevant (L1)." : "It says hello world.", stream)]);
  const model = adapter.make(tokenFn, api.fetch);
  const seen: AskEvent[] = [];
  const common = { files, retry: RETRY, onEvent: (event: AskEvent) => void seen.push(event) };
  let result: Awaited<ReturnType<typeof askWithFiles>> | undefined;
  let error: unknown;
  try {
    result = path === "part"
      ? await askWithFiles({ ...common, model: fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: big.id, task: "List every ERROR line" } }]), says("Done.")], { generateText: model.generateText! }), documentIds: [big.id], messages: [{ role: "user", text: "List every ERROR line" }], budget: { inlineTokens: 2_000, mapChunkTokens: 20_000 } })
      : await askWithFiles({ ...common, model, documentIds: [small.id], messages: [{ role: "user", text: "What does it say?" }], ...(stream ? { onText: () => undefined } : {}) });
  } catch (caught) {
    error = caught;
  }
  const read = result?.toolTurns.flatMap((turn) => turn.calls).find((call) => call.name === "analyze_whole_document")?.result as Json | undefined;
  const retries = seen.filter((event): event is Extract<AskEvent, { type: "retry" }> => event.type === "retry");
  const runError = seen.find((event): event is Extract<AskEvent, { type: "run.error" }> => event.type === "run.error")?.error;
  const requestEnd = seen.find((event): event is Extract<AskEvent, { type: "request.end" }> => event.type === "request.end" && event.outcome === "error")?.error;
  return { result, error, read, retries, runError, requestEnd, tokenCalls, sent: api.sent, seen };
}

/** The token client's own words: the message of its error and those of the errors that caused it. */
function wordsOf(error: unknown): string[] {
  const words: string[] = [];
  for (let at = error, depth = 0; at instanceof Error && depth < 4; at = at.cause, depth++) words.push(at.message);
  return words;
}

/** The address of the metadata server, by its IP or its name. */
const METADATA_SERVER = /169\.254|metadata\.google/;

/**
 * ERR-SANITIZE: no event, and nothing the SSE route sends of one (`sseMessageOf`), holds the token
 * client's words or the metadata server's address. The thrown error keeps them, as its cause.
 */
function expectNoTokenWords(seen: AskEvent[], thrown: Error) {
  const words = wordsOf(thrown);
  expect(words.length).toBeGreaterThan(0);
  for (const event of seen) {
    for (const [where, json] of [["event", JSON.stringify(event)], ["sseMessageOf", JSON.stringify(sseMessageOf(event).data)]] as const) {
      for (const said of words) expect(json, `${where} ${event.type}`).not.toContain(said);
      expect(json, `${where} ${event.type}`).not.toMatch(METADATA_SERVER);
    }
  }
}

const STALE_THEN_FRESH = (p: Provider, stream: boolean, text = "It says hello world.") => [(sent: Sent) => (authOf(sent).endsWith("stale") ? p.refused() : p.reply(text, stream))];

describe("ADAPT-3: a token or header function that throws once is retried", () => {
  describe.each(ADAPTERS)("$name", (adapter) => {
    for (const [shape, make] of Object.entries(SHAPES)) {
      it.each(["chat", "stream"] as const)(`${shape}, %s: answered after one retry, told as a retry of a connection that failed`, async (path) => {
        const run = await ask(adapter, path, (_ctx, n) => {
          if (n === 1) throw make();
          return `tok${n}`;
        });
        expect(run.error).toBeUndefined();
        expect(run.result?.answered).toBe(true);
        expect(run.result?.text).toBe("It says hello world.");
        expect(run.tokenCalls).toEqual(["plain", "plain"]);
        // No request went out with the failed call: one HTTP request, with the second token.
        expect(run.sent).toHaveLength(1);
        expect(authOf(run.sent[0]!)).toMatch(/tok2$/);
        expect(run.retries).toHaveLength(1);
        expect(run.retries[0]).toMatchObject({ attempt: 1, error: { kind: "unreachable", status: 0 } });
        expect(run.retries[0]!.reason).toBeUndefined();
        expect(run.retries[0]!.error.message).not.toMatch(/storage/i);
      });
    }

    it("a blip in a whole-file read: every part is read, and the retry is told", async () => {
      const run = await ask(adapter, "part", (_ctx, n) => {
        if (n === 1) throw SHAPES["Error with code ECONNRESET, no syscall"]!();
        return `tok${n}`;
      });
      expect(run.read).toMatchObject({ parts_read: PARTS });
      expect(run.read?.parts_that_failed).toBeUndefined();
      expect(run.read?.error).toBeUndefined();
      // Before 0.99.13, Gemini's part read tried again at once and nothing said so (map-reduce's `unknownErrors: "once"`).
      expect(run.retries).toHaveLength(1);
      expect(run.retries[0]).toMatchObject({ error: { kind: "unreachable", status: 0 } });
    });
  });
});

describe("ADAPT-3: a token function that keeps failing is never told as storage", () => {
  describe.each(ADAPTERS)("$name", (adapter) => {
    for (const [shape, make] of Object.entries(SHAPES)) {
      it(`${shape}: a model error that could not reach the model, retryable, after 1 + 3 tries`, async () => {
        const run = await ask(adapter, "stream", () => {
          throw make();
        });
        expect(run.result).toBeUndefined();
        expect(errorInfoOf(run.error)).toMatchObject({ category: "model", code: "unreachable", status: 502, retryable: true });
        expect(run.error).toMatchObject({ status: 0, kind: "unreachable" });
        // The token client's error is kept, for the log.
        expect((run.error as { cause?: unknown }).cause).toBeInstanceOf(Error);
        // What the page sees: the library's words, never storage, never the token client's host.
        expect(run.runError?.message).toBe("The model could not be reached.");
        expect(errorInfoOf(run.runError)).toMatchObject({ category: "model", code: "unreachable", retryable: true });
        expect(run.requestEnd?.message).toBe("The model could not be reached.");
        for (const words of [run.runError?.message, run.requestEnd?.message, errorInfoOf(run.error).message]) {
          expect(words).not.toMatch(/storage/i);
          expect(words).not.toMatch(/https?:\/\/|169\.254|metadata\.google/);
        }
        // DEFAULT_RETRIES = 3: four token calls, no HTTP request.
        expect(run.tokenCalls).toHaveLength(4);
        expect(run.sent).toHaveLength(0);
        expect(run.retries).toHaveLength(3);
        for (const retry of run.retries) expect(retry.error.message).toBe("The model could not be reached.");
        expect(run.seen.map((event) => event.type)).toEqual(expect.arrayContaining(["request.end", "retry", "run.error"]));
        expectNoTokenWords(run.seen, make());
      });
    }

    // A token error that is not a connection failure (decision 21, D1): not retried, told as "auth"
    // in the library's words, its own message kept as the cause.
    it("a revoked grant: not retried, an auth error, without the token client's words", async () => {
      const run = await ask(adapter, "stream", () => {
        throw revoked();
      });
      expect(run.tokenCalls).toHaveLength(1);
      expect(errorInfoOf(run.error)).toMatchObject({ category: "model", code: "auth", retryable: false });
      expect(run.error).toMatchObject({ status: 0, kind: "auth", cause: { message: expect.stringMatching(/^invalid_grant/) } });
      expect(run.runError?.message).toBe("The model refused the key or token it was sent.");
      expect(run.runError?.message).not.toMatch(/invalid_grant/);
      expect(run.requestEnd).toMatchObject({ message: "The model refused the key or token it was sent.", kind: "auth", status: 0 });
      expect(run.retries).toHaveLength(0);
      expect(run.sent).toHaveLength(0);
      expectNoTokenWords(run.seen, revoked());
    });
  });
});

describe("ERR-SANITIZE: a whole-file read whose token function keeps failing", () => {
  describe.each(ADAPTERS)("$name", (adapter) => {
    for (const [shape, make] of [...Object.entries(SHAPES), ["revoked grant", revoked] as const]) {
      const transient = shape !== "revoked grant";
      it(`${shape}: the read fails in the library's words, and no event holds the token client's`, async () => {
        const run = await ask(adapter, "part", () => {
          throw make();
        });
        const why = transient ? "The model could not be reached." : "The model refused the key or token it was sent.";
        expect(run.read?.error).toBe(`Could not read any part of big.log: ${why}`);
        // A connection that failed is tried 1 + 3 times for each part; a revoked grant once.
        expect(run.tokenCalls).toHaveLength(PARTS * (transient ? 4 : 1));
        expect(run.sent).toHaveLength(0);
        const toolEnd = run.seen.find((event): event is Extract<AskEvent, { type: "tool.end" }> => event.type === "tool.end");
        expect(toolEnd?.error).toBe(`Could not read any part of big.log: ${why}`);
        const ends = run.seen.filter((event): event is Extract<AskEvent, { type: "request.end" }> => event.type === "request.end" && event.outcome === "error");
        expect(ends).toHaveLength(PARTS);
        for (const end of ends) expect(end.error?.message).toBe(why);
        expect(run.retries).toHaveLength(transient ? 3 * PARTS : 0);
        expectNoTokenWords(run.seen, make());
      });
    }
  });
});

const vertex = ADAPTERS[0]!;

describe("ADAPT-REFRESH: a 401 refreshed once (vertexAi with accessToken as a function)", () => {
  it.each(["chat", "stream"] as const)("401 then a fresh token, %s: answered, one refresh, told as a retry with reason auth_refresh", async (path) => {
    let current = "stale";
    const run = await ask(vertex, path, (ctx) => {
      if (ctx.refresh) current = "fresh";
      return current;
    }, STALE_THEN_FRESH);
    expect(run.result?.answered).toBe(true);
    expect(run.tokenCalls).toEqual(["plain", "refresh"]);
    expect(run.sent.map(authOf)).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(run.sent[1]!.body).toEqual(run.sent[0]!.body);
    expect(run.retries).toHaveLength(1);
    expect(run.retries[0]).toMatchObject({ reason: "auth_refresh", attempt: 1, delayMs: 0, error: { kind: "auth", status: 401 } });
    expect(run.retries[0]!.message).toBe("The model refused the token (HTTP 401). Trying again with a new one…");
  });

  it("401 in a whole-file read: every part read, one auth_refresh retry event per refreshed part request", async () => {
    let current = "stale";
    const run = await ask(vertex, "part", (ctx) => {
      if (ctx.refresh) current = "fresh";
      return current;
    }, (p) => STALE_THEN_FRESH(p, false, "Notes (L1)."));
    expect(run.read).toMatchObject({ parts_read: PARTS });
    expect(run.read?.parts_that_failed).toBeUndefined();
    const refreshes = run.tokenCalls.filter((call) => call === "refresh").length;
    expect(refreshes).toBeGreaterThan(0);
    expect(run.retries.filter((event) => event.reason === "auth_refresh")).toHaveLength(refreshes);
  });

  for (const shape of ["Error with code ECONNRESET, no syscall", "google-auth 'Could not refresh access token'"]) {
    it.each(["chat", "stream", "part"] as const)(`401, then the refresh throws (${shape}) once, %s: retried, answered`, async (path) => {
      let current = "stale";
      let refreshes = 0;
      const run = await ask(vertex, path, (ctx) => {
        if (ctx.refresh) {
          refreshes++;
          if (refreshes === 1) throw SHAPES[shape]!();
          current = "fresh";
        }
        return current;
      }, (p, stream) => STALE_THEN_FRESH(p, stream, path === "part" ? "Notes (L1)." : "It says hello world."));
      if (path === "part") {
        // Before 0.99.13: one part lost (parts_that_failed 1), told as an auth refusal.
        expect(run.read).toMatchObject({ parts_read: PARTS });
        expect(run.read?.parts_that_failed).toBeUndefined();
      } else {
        expect(run.error).toBeUndefined();
        expect(run.result?.answered).toBe(true);
        // stale -> 401 -> refresh throws (retried as a connection that failed) -> stale -> 401 -> fresh -> 200
        expect(run.tokenCalls).toEqual(["plain", "refresh", "plain", "refresh"]);
        expect(run.sent.map(authOf)).toEqual(["Bearer stale", "Bearer stale", "Bearer fresh"]);
        expect(run.retries.map((event) => event.reason ?? event.error.kind)).toEqual(["auth_refresh", "unreachable", "auth_refresh"]);
      }
    });
  }

  it.each(["chat", "stream"] as const)("401, then a refresh that fails for good (revoked grant), %s: the 401 is the error, with its cause, not retried", async (path) => {
    const run = await ask(vertex, path, (ctx) => {
      if (ctx.refresh) throw revoked();
      return "stale";
    }, (p) => [p.refused()]);
    expect(run.error).toMatchObject({ status: 401, kind: "auth", cause: { message: expect.stringMatching(/^invalid_grant/) } });
    expect(errorInfoOf(run.error)).toMatchObject({ category: "model", code: "auth", retryable: false });
    expect(run.sent).toHaveLength(1);
    expect(run.tokenCalls).toEqual(["plain", "refresh"]);
  });

  it.each(["chat", "stream"] as const)("two 401s stay an auth error, %s: 2 requests, 2 token calls, 1 auth_refresh event", async (path) => {
    const run = await ask(vertex, path, (ctx) => (ctx.refresh ? "fresh-but-bad" : "stale"), (p) => [p.refused()]);
    expect(run.error).toMatchObject({ status: 401, kind: "auth" });
    expect(errorInfoOf(run.error)).toMatchObject({ category: "model", code: "auth", status: 500, retryable: false });
    expect(run.sent.map(authOf)).toEqual(["Bearer stale", "Bearer fresh-but-bad"]);
    expect(run.tokenCalls).toEqual(["plain", "refresh"]);
    expect(run.retries.map((event) => event.reason)).toEqual(["auth_refresh"]);
  });

  it("two 401s in a whole-file read: each part tried twice, the read fails as an auth refusal, no more requests", async () => {
    const run = await ask(vertex, "part", (ctx) => (ctx.refresh ? "fresh-but-bad" : "stale"), (p) => [p.refused()]);
    expect(run.read?.error).toBe("Could not read any part of big.log: The model refused the key or token it was sent (HTTP 401).");
    expect(run.sent).toHaveLength(2 * PARTS);
  });

  it.each(ADAPTERS.filter((adapter) => !adapter.refreshes))("$name: a 401 is not refreshed (no refresh in 0.99.13), one request, an auth error", async (adapter) => {
    const run = await ask(adapter, "chat", () => "stale", (p) => [p.refused()]);
    expect(run.error).toMatchObject({ status: 401, kind: "auth" });
    expect(run.sent).toHaveLength(1);
    expect(run.retries).toHaveLength(0);
  });
});

describe("ERR-SANITIZE: a socket error that a model of your own lets through", () => {
  // A token function of an adapter of your own that is not wrapped: Node's socket error, with the
  // metadata server in its words. It has no kind and no status: not sent again, as before.
  const socketError = () => Object.assign(new Error("connect ECONNRESET http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"), { code: "ECONNRESET", syscall: "connect", errno: -104 });

  it("a chat request: told as a model that could not be reached, never as storage", async () => {
    const seen: AskEvent[] = [];
    const thrown = socketError();
    const error = await askWithFiles({ files, model: fakeModel([thrown]), documentIds: [small.id], messages: [{ role: "user", text: "What does it say?" }], retry: RETRY, onEvent: (event) => void seen.push(event) }).catch((caught: unknown) => caught);
    expect(error).toBe(thrown);
    const requestEnd = seen.find((event): event is Extract<AskEvent, { type: "request.end" }> => event.type === "request.end");
    const runError = seen.find((event): event is Extract<AskEvent, { type: "run.error" }> => event.type === "run.error");
    for (const told of [requestEnd?.error, runError?.error]) {
      expect(told).toMatchObject({ message: "The model could not be reached.", kind: "unreachable" });
      expect(errorInfoOf(told)).toMatchObject({ category: "model", code: "unreachable", retryable: true });
    }
    expectNoTokenWords(seen, thrown);
  });

  it("a part request of a generateText of your own: its request.end is told the same way", async () => {
    const seen: AskEvent[] = [];
    const generateText = async () => {
      throw socketError();
    };
    const result = await askWithFiles({ files, model: fakeModel([calls([{ name: "analyze_whole_document", args: { document_id: big.id, task: "List every ERROR line" } }]), says("Done.")], { generateText }), documentIds: [big.id], messages: [{ role: "user", text: "List every ERROR line" }], retry: RETRY, budget: { inlineTokens: 2_000, mapChunkTokens: 20_000 }, onEvent: (event) => void seen.push(event) });
    const read = result.toolTurns.flatMap((turn) => turn.calls).find((call) => call.name === "analyze_whole_document")?.result as Json | undefined;
    expect(read?.error).toBe("Could not read any part of big.log: The model could not be reached.");
    const ends = seen.filter((event): event is Extract<AskEvent, { type: "request.end" }> => event.type === "request.end" && event.outcome === "error");
    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends) expect(end.error).toMatchObject({ message: "The model could not be reached.", kind: "unreachable" });
    expectNoTokenWords(seen, socketError());
  });

  it("an error of the question's own signal is told as before, not as the model's", async () => {
    const seen: AskEvent[] = [];
    const stop = new AbortController();
    const reason = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" });
    const model = fakeModel([says("never")]);
    model.send = async () => {
      stop.abort(reason);
      throw reason;
    };
    await askWithFiles({ files, model, documentIds: [small.id], messages: [{ role: "user", text: "q" }], signal: stop.signal, onEvent: (event) => void seen.push(event) }).catch(() => undefined);
    const requestEnd = seen.find((event): event is Extract<AskEvent, { type: "request.end" }> => event.type === "request.end");
    expect(requestEnd?.error).toBeDefined();
    expect(requestEnd?.error?.kind).toBeUndefined();
    expect(requestEnd?.error?.message).not.toBe("The model could not be reached.");
  });
});
