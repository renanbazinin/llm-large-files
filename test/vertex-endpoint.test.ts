// The options of vertexAi() new in 0.10.0: headers merged after the library's, a host of your own,
// express mode with an API key, and one more try with a new token after a 401 (NEW-vertex-endpoint-
// options); and which endpoints take the rounds of earlier questions in Gemini's own form.
import { describe, expect, it } from "vitest";
import { createLargeFiles, errorInfoOf, MemoryDocumentStore } from "llm-large-files";
import { askGemini, createGeminiGenerateText, gemini, geminiApi, vertexAi, type GeminiEndpoint } from "llm-large-files/gemini";
import { fakeFetch, serviceLog, utf8, type FakeReply } from "llm-large-files/testing";

type Body = Record<string, any>;

const say = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }] });
const call = (name: string, args: Body) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const refused = () => Response.json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, { status: 401 });
const request = { system: "", messages: [{ role: "user" as const, parts: [{ text: "hi" }] }] };

/** A fetch that refuses a token it was not given as good with 401, and answers the rest from `reply`. */
function vertex(good: (token: string) => boolean, reply: FakeReply = say("ok")) {
  return fakeFetch([(sent, number) => {
    const token = (sent.headers.Authorization ?? "").replace(/^Bearer /, "");
    if (!good(token)) return refused();
    return typeof reply === "function" ? reply(sent, number) : reply.clone();
  }]);
}

/** A token source that keeps its token until it is asked to refresh. */
function tokens() {
  const asked: Array<boolean | undefined> = [];
  let current = 1;
  const accessToken = async (context: { refresh: boolean }) => {
    asked.push(context.refresh);
    if (context.refresh) current++;
    return `token-${current}`;
  };
  return { asked, accessToken };
}

describe("vertexAi() since 0.10.0", () => {
  it("merges headers of its own after the library's, and gives them the same context", async () => {
    const contexts: unknown[] = [];
    const endpoint = vertexAi({ project: "p", model: "gemini-test", accessToken: "t", headers: (context) => { contexts.push(context); return { "x-goog-user-project": "billing", "Content-Type": "application/json; charset=utf-8" }; } });
    const api = fakeFetch([say("ok")]);
    await gemini(endpoint, { fetch: api.fetch }).send(request);
    expect(api.sent[0]!.headers).toEqual({ "Content-Type": "application/json; charset=utf-8", Authorization: "Bearer t", "x-goog-user-project": "billing" });
    expect(contexts).toEqual([undefined]);
    const fixed = vertexAi({ project: "p", model: "gemini-test", accessToken: "t", headers: { "x-server-timeout": "600" } });
    expect(await (fixed.headers as () => Promise<Record<string, string>>)()).toEqual({ "Content-Type": "application/json", Authorization: "Bearer t", "x-server-timeout": "600" });
  });

  it("sends the requests to a host of your own, which must be an https origin and nothing more", () => {
    const endpoint = vertexAi({ project: "p", location: "europe-west4", model: "gemini-test", accessToken: "t", host: "https://vertex.psc.example.internal" });
    expect(endpoint.url).toBe("https://vertex.psc.example.internal/v1/projects/p/locations/europe-west4/publishers/google/models/gemini-test:generateContent");
    expect(endpoint.streamUrl).toBe("https://vertex.psc.example.internal/v1/projects/p/locations/europe-west4/publishers/google/models/gemini-test:streamGenerateContent?alt=sse");
    expect(vertexAi({ project: "p", model: "m", accessToken: "t", host: "https://proxy.example:8443/" }).url).toMatch(/^https:\/\/proxy\.example:8443\/v1\/projects\/p\/locations\/global\//);
    for (const host of [
      "https://proxy.example/v1",
      "https://proxy.example/?x=1",
      "https://proxy.example#frag",
      "https://user@proxy.example",
      "https://proxy.example@evil.example",
      "http://proxy.example",
      "proxy.example",
      "https://",
      "",
    ]) {
      expect(() => vertexAi({ project: "p", model: "m", accessToken: "t", host }), host).toThrow(TypeError);
    }
  });

  it("calls Vertex AI express mode with an API key, and no project in the URL", async () => {
    const endpoint = vertexAi({ apiKey: "express-key", model: "gemini-test", explorerModel: "gemini-lite" });
    expect(endpoint.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-test:generateContent");
    expect(endpoint.streamUrl).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-test:streamGenerateContent?alt=sse");
    expect(endpoint.explorerUrl).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-lite:generateContent");
    expect(endpoint.refreshable).toBeUndefined();
    const api = fakeFetch([say("ok")]);
    await gemini(endpoint, { fetch: api.fetch }).send(request);
    expect(api.sent[0]!.headers).toEqual({ "Content-Type": "application/json", "x-goog-api-key": "express-key" });
    expect(api.sent[0]!.url).not.toContain("projects/");
  });
});

describe("a Vertex AI token refused with HTTP 401, since 0.10.0", () => {
  it("is asked for again with { refresh: true }, and the new token is sent, once", async () => {
    const source = tokens();
    const api = vertex((token) => token === "token-2");
    const reply = await gemini(vertexAi({ project: "p", model: "gemini-test", accessToken: source.accessToken }), { fetch: api.fetch }).send(request);
    expect(reply.text).toBe("ok");
    expect(api.sent.map((sent) => sent.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(source.asked).toEqual([false, true]);
    // The body is the same both times.
    expect(api.sent[1]!.body).toEqual(api.sent[0]!.body);
  });

  it("is the error when the new token is refused too: no loop", async () => {
    const source = tokens();
    const api = vertex(() => false);
    await expect(gemini(vertexAi({ project: "p", model: "gemini-test", accessToken: source.accessToken }), { fetch: api.fetch }).send(request)).rejects.toMatchObject({ status: 401, kind: "auth" });
    expect(api.sent).toHaveLength(2);
    expect(source.asked).toEqual([false, true]);
  });

  it("is still the error, with why no new token came as its cause, when the refresh throws", async () => {
    const lapsed = new Error("invalid_grant: token has been expired or revoked");
    const asked: boolean[] = [];
    const accessToken = async ({ refresh }: { refresh: boolean }) => {
      asked.push(refresh);
      if (refresh) throw lapsed;
      return "old";
    };
    const api = fakeFetch([refused()]);
    const error = await gemini(vertexAi({ project: "p", model: "gemini-test", accessToken }), { fetch: api.fetch }).send(request).then(() => undefined, (failed: unknown) => failed);
    expect(error).toMatchObject({ name: "GeminiRequestError", status: 401, kind: "auth", message: "Request had invalid authentication credentials.", cause: lapsed });
    expect(errorInfoOf(error)).toMatchObject({ category: "model", code: "auth" });
    expect(api.sent).toHaveLength(1);
    expect(asked).toEqual([false, true]);

    // The same in a part read.
    const read = createGeminiGenerateText({ url: "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/refresh-throws:generateContent", headers: vertexAi({ project: "p", model: "m", accessToken }).headers, refreshable: true, fetchImpl: fakeFetch([refused()]).fetch });
    await expect(read({ system: "s", prompt: "p", maxOutputTokens: 100 })).rejects.toMatchObject({ name: "GeminiRequestError", status: 401, kind: "auth", cause: lapsed });
  });

  it("gets no second try for a token given as a string, an API key, or headers of your own", async () => {
    const endpoints: GeminiEndpoint[] = [
      vertexAi({ project: "p", model: "gemini-test", accessToken: "fixed" }),
      vertexAi({ apiKey: "k", model: "gemini-test" }),
      geminiApi({ apiKey: "k", model: "gemini-test" }),
      { url: "https://gateway.example/models/m:generateContent", headers: async () => ({ Authorization: "Bearer gateway" }) },
    ];
    for (const endpoint of endpoints) {
      expect(endpoint.refreshable).toBeUndefined();
      const api = fakeFetch([refused()]);
      await expect(gemini(endpoint, { fetch: api.fetch }).send(request)).rejects.toMatchObject({ status: 401 });
      expect(api.sent).toHaveLength(1);
    }
  });

  it("is tried again in a part read, and in askGemini's explorer", async () => {
    const source = tokens();
    const read = createGeminiGenerateText({ url: "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/refresh-part:generateContent", headers: vertexAi({ project: "p", model: "m", accessToken: source.accessToken }).headers, refreshable: true, fetchImpl: vertex((token) => token === "token-2", say("Notes (L1).")).fetch });
    expect(await read({ system: "s", prompt: "p", maxOutputTokens: 100 })).toBe("Notes (L1).");
    expect(source.asked).toEqual([false, true]);

    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    // The token in the cache has just expired: the first request gets a 401, and the next token is good.
    const explorerTokens = tokens();
    const api = vertex((token) => token === "token-2", (sent) => {
      if (sent.url.includes("gemini-answer")) return say("51 errors.");
      return (sent.body.contents as Body[]).some((content) => content.parts.some((part: Body) => part.functionResponse))
        ? say("DONE")
        : call("search_document", { document_id: meta.id, query: "ERROR", mode: "exact" });
    });
    const endpoint = vertexAi({ project: "p", model: "gemini-answer", explorerModel: "gemini-explorer", accessToken: explorerTokens.accessToken });
    expect(endpoint.refreshable).toBe(true);
    const result = await askGemini({ files, endpoint, fetch: api.fetch, documentIds: [meta.id], messages: [{ role: "user", text: "How many errors?" }] });
    expect(result.text).toBe("51 errors.");
    expect(api.sent.slice(0, 2).map((sent) => [sent.url.includes("gemini-explorer"), sent.headers.Authorization])).toEqual([[true, "Bearer token-1"], [true, "Bearer token-2"]]);
    expect(explorerTokens.asked.slice(0, 2)).toEqual([false, true]);
  });
});

describe("the rounds of earlier questions in Gemini's own form, since 0.10.0", () => {
  it("go back to models of the Gemini API, and not yet to those of Vertex AI", () => {
    expect(geminiApi({ apiKey: "k", model: "m" }).nativeRounds).toBe(true);
    expect(gemini(geminiApi({ apiKey: "k", model: "m" })).capabilities.nativeRounds).toBe(true);
    // Not until a live check on Vertex AI shows that it takes them.
    expect(vertexAi({ project: "p", model: "m", accessToken: "t" }).nativeRounds).toBeUndefined();
    expect(gemini(vertexAi({ project: "p", model: "m", accessToken: "t" })).capabilities.nativeRounds).toBeUndefined();
    expect(gemini(vertexAi({ apiKey: "k", model: "m" })).capabilities.nativeRounds).toBeUndefined();
    // An endpoint of your own says so itself.
    expect(gemini({ url: "https://gateway.example/models/m:generateContent", headers: {} }).capabilities.nativeRounds).toBeUndefined();
    expect(gemini({ url: "https://gateway.example/models/m:generateContent", headers: {}, nativeRounds: true }).capabilities.nativeRounds).toBe(true);
  });
});
