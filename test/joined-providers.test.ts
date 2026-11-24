// Joined tests (0.10.0): a provider's adapter on its own wire format, over a fake fetch, with the
// loop. Each part has its own tests; these check that they meet.
// - Gemini: the finish reasons of the adapter (MODEL_ARMOR and SAFETY are "filtered") and the
//   loop's rule for them: no nudge and no second try, so a filtered question costs 2 requests, and
//   says so with an "answer_filtered" notice. 0.9 read MODEL_ARMOR as no finish, and asked 4 times.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type AskEvent, type LargeFiles } from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { fakeFetch, serviceLog, utf8 } from "llm-large-files/testing";

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
