// Joined tests (0.10.0): a provider's adapter on its own wire format, over a fake fetch, with the
// loop. Each part has its own tests; these check that they meet.
// - Gemini: the finish reasons of the adapter (MODEL_ARMOR and SAFETY are "filtered") and the
//   loop's rule for them: no nudge and no second try, so a filtered question costs 2 requests, and
//   says so with an "answer_filtered" notice. 0.9 read MODEL_ARMOR as no finish, and asked 4 times.
// - DeepSeek: the adapter's `reasoning_content` and the native rounds of the loop. A follow-up sends
//   the reasoning of the earlier question's tool round back. The reasoning of an earlier answer is
//   not kept yet (docs/guides/openai-compatible.md#deepseek): the answer turn goes back as its text.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type AskResult, type ChatMessage, type LargeFiles } from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { fakeFetch, serviceLog, utf8 } from "llm-large-files/testing";

type Json = Record<string, any>;
type Notice = Extract<AskEvent, { type: "notice" }>;
const notices = (events: AskEvent[]) => events.filter((event): event is Notice => event.type === "notice");

/** A log too large to send whole: the question runs the tool loop. */
async function library(): Promise<{ files: LargeFiles; log: string }> {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)), id: "log-1" });
  return { files, log: meta.id };
}

const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
/** A Gemini reply that ended with `reason` and has this text, or none. */
const geminiReply = (reason: string, text = ""): Response => Response.json({ candidates: [{ content: { role: "model", parts: text ? [{ text }] : [] }, finishReason: reason }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 3 } });
/** The same, streamed: the text, then the reason in a chunk of its own. */
const geminiStream = (reason: string, text: string): Response => new Response(
  `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: reason }] })}\n\n`,
  { headers: { "Content-Type": "text/event-stream" } },
);

describe("a Gemini answer that a filter stopped, through askGemini", () => {
  for (const reason of ["MODEL_ARMOR", "SAFETY"]) {
    it(`costs 2 requests with ${reason} and no text, and says the answer was filtered`, async () => {
      const { files, log } = await library();
      const events: AskEvent[] = [];
      const fetch = fakeFetch([geminiReply(reason)]);
      const result = await askGemini({ files, endpoint, fetch: fetch.fetch, documentIds: [log], messages: [{ role: "user", text: "How many errors?" }], onEvent: (event) => events.push(event) });
      // The turn with tools, then the closing request without them: no nudge, no second try.
      expect(fetch.sent).toHaveLength(2);
      expect(fetch.sent[0]!.body.tools).toBeDefined();
      expect(fetch.sent[1]!.body.tools).toBeUndefined();
      expect(result).toMatchObject({ answered: false, text: "", finish: "filtered", finishReason: reason, turns: 2 });
      const codes = notices(events).map((event) => event.code);
      expect(codes).not.toContain("nudged");
      expect(codes).not.toContain("answer_again");
      expect(notices(events).filter((event) => event.code === "answer_filtered")).toEqual([
        expect.objectContaining({ message: "A filter of the provider stopped the answer before any text came." }),
      ]);
      expect(events.at(-1)).toMatchObject({ type: "run.finish", result: { finish: "filtered" } });
    });
  }

  it("drops the streamed text of an answer Model Armor stopped, under filteredAnswer \"drop\", and asks the page to take it away", async () => {
    const { files, log } = await library();
    const events: AskEvent[] = [];
    const shown: string[] = [];
    const fetch = fakeFetch([geminiStream("MODEL_ARMOR", "The card numbers in the log are")]);
    const result = await askGemini({
      files, endpoint, fetch: fetch.fetch, documentIds: [log], messages: [{ role: "user", text: "List the card numbers." }],
      filteredAnswer: "drop", onText: (delta) => shown.push(delta), onEvent: (event) => events.push(event),
    });
    // A reply with text is the answer: one request, streamed, then dropped.
    expect(fetch.sent).toHaveLength(1);
    expect(fetch.sent[0]!.url).toContain(":streamGenerateContent");
    expect(shown.join("")).toBe("The card numbers in the log are");
    expect(result).toMatchObject({ answered: false, text: "", finish: "filtered", finishReason: "MODEL_ARMOR" });
    expect(notices(events).filter((event) => event.code === "answer_filtered")).toEqual([expect.objectContaining({ discardText: true })]);
  });

  it("is not a prompt Gemini refused: a blockReason is one request and a \"blocked\" notice, as before", async () => {
    const { files, log } = await library();
    const events: AskEvent[] = [];
    const fetch = fakeFetch([Response.json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 900 } })]);
    const result = await askGemini({ files, endpoint, fetch: fetch.fetch, documentIds: [log], messages: [{ role: "user", text: "How many errors?" }], onEvent: (event) => events.push(event) });
    expect(fetch.sent).toHaveLength(1);
    expect(result).toMatchObject({ answered: false, blockReason: "PROHIBITED_CONTENT" });
    const codes = notices(events).map((event) => event.code);
    expect(codes).toContain("blocked");
    expect(codes).not.toContain("answer_filtered");
  });
});

describe("a DeepSeek follow-up in thinking mode, through openAiCompatible", () => {
  const call = (documentId: string) => ({ id: "call_1", type: "function", function: { name: "search_document", arguments: JSON.stringify({ document_id: documentId, query: "ERROR", mode: "exact" }) } });
  const reply = (message: Json, finish: string): Response => Response.json({ id: "r1", model: "deepseek-v4-flash", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }], usage: { prompt_tokens: 900, completion_tokens: 20 } });
  const deepseek = (fetch: typeof globalThis.fetch) => openAiCompatible({ model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", fetch });

  it("sends the reasoning of the earlier question's tool round back, with the earlier answer after it", async () => {
    const { files, log } = await library();
    // Question 1: a search, with its reasoning, then the answer.
    const first = fakeFetch([
      reply({ content: "", reasoning_content: "The log is large: search it for ERROR.", tool_calls: [call(log)] }, "tool_calls"),
      reply({ content: "51 errors (app.log L97).", reasoning_content: "51 lines match." }, "stop"),
    ]);
    const one = await askWithFiles({ files, model: deepseek(first.fetch), documentIds: [log], messages: [{ role: "user", text: "How many errors?" }] });
    expect(one.text).toBe("51 errors (app.log L97).");
    expect(one.toolTurns).toHaveLength(1);
    expect(one.toolTurns[0]!.native).toMatchObject({ model: "deepseek-v4-flash", turn: { reasoning_content: "The log is large: search it for ERROR." } });

    // Question 2, from what an application stores as JSON: the turn, the rounds, the answer, the question.
    const messages = JSON.parse(JSON.stringify([one.userTurn, ...one.toolTurns, { role: "assistant", text: one.text }, { role: "user", text: "And the first one?" }])) as ChatMessage[];
    const second = fakeFetch([reply({ content: "At L97.", reasoning_content: "The first match." }, "stop")]);
    const two: AskResult = await askWithFiles({ files, model: deepseek(second.fetch), documentIds: [log], messages, placement: one.placement! });
    expect(two.text).toBe("At L97.");
    const sent = second.sent[0]!.body.messages as Json[];
    expect(second.sent[0]!.body.tools).toBeDefined();
    const round = sent.findIndex((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(sent[round]).toMatchObject({ reasoning_content: "The log is large: search it for ERROR.", tool_calls: [{ id: "call_1" }] });
    expect(sent[round + 1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    // The earlier answer follows its round, as its text: the library keeps no reasoning of an answer yet.
    const answer = sent.findIndex((message) => message.role === "assistant" && message.content === "51 errors (app.log L97).");
    expect(answer).toBeGreaterThan(round + 1);
    expect(sent[answer]).not.toHaveProperty("reasoning_content");
    expect(sent.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(sent.at(-1))).toContain("And the first one?");
  });
});
