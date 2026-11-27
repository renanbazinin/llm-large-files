// A whole-file read that lost parts says so (LOOP-5, new in 0.99.13), and changes nothing else that
// is sent. One question, a read of an 8,000-line log in 29 parts, goes through the real gemini()
// adapter and a fake fetch; every request body is compared with the golden bodies of 0.99.12
// (test/fixtures/whole-read-failure-bodies, made from v0.99.12 by the probe 06-loop5-golden.mjs of
// specs/05-quick-fixes). With no failure, every body is the same, byte for byte. When parts 2 and 5
// answer 503 on every try, only two bodies change: the last step of the read, and the request
// that gets its result. And a stand-in of an incomplete read keeps every field that says so.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answerInfoOf, askWithFiles, createLargeFiles, MemoryDocumentStore, stubResult, type AskEvent, type ToolResult } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { fakeFetch, serviceLog, utf8 } from "llm-large-files/testing";

type Body = Record<string, any>;
type Golden = Array<{ key: string; text: string }>;

const golden = (name: "ok" | "fail"): Golden => JSON.parse(readFileSync(new URL(`./fixtures/whole-read-failure-bodies/${name}.json`, import.meta.url), "utf8")) as Golden;
const CLOCK = () => new Date("2026-11-20T08:00:00.000Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const say = (text: string) => json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] });
const callTool = (name: string, args: Body) => json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] });
const busy = () => json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, 503);
const promptOf = (body: Body): string => body.contents?.[0]?.parts?.[0]?.text ?? "";

/**
 * The question, as the probe asks it: "fail" makes parts 2 and 5 answer 503 on every try (1 + 3
 * tries each, with no wait). The bodies are keyed and ordered as the golden ones: the first chat
 * request, the parts by number and try (they are sent a few at a time, in any order), the last
 * step of the read, and the closing chat request.
 */
async function question(scenario: "ok" | "fail") {
  const files = createLargeFiles({ store: new MemoryDocumentStore({ now: CLOCK }), now: CLOCK, requireOwner: false });
  const log = await files.ingest({ id: "log-1", name: "app.log", bytes: utf8(serviceLog(8_000)) });
  let chats = 0;
  const fetch = fakeFetch([(sent) => {
    const body = sent.body as Body;
    if (!body.tools) {
      const prompt = promptOf(body);
      if (prompt.includes("<notes>")) return say("Timeline: ERROR at L97, L194, L291 (and so on).");
      const part = /part (\d+) of (\d+)/.exec(prompt)?.[1];
      if (scenario === "fail" && (part === "2" || part === "5")) return busy();
      return say(`Part ${part}: ERROR lines at L${97 * Number(part)}.`);
    }
    chats++;
    if (chats === 1) return callTool("analyze_whole_document", { document_id: log.id, task: "Timeline of all errors" });
    return say("Here is the full timeline (app.log L97).");
  }]);
  const events: AskEvent[] = [];
  const result = await askWithFiles({
    files,
    model: gemini(geminiApi({ apiKey: "test", model: "gemini-x" }), { fetch: fetch.fetch }),
    documentIds: [log.id],
    messages: [{ role: "user", text: "Give me the full timeline of errors." }],
    budget: { inlineTokens: 2000, mapChunkTokens: 20000 },
    retry: { sleep: async () => {} },
    onEvent: (event) => events.push(event),
  });
  const tries: Record<number, number> = {};
  const bodies = fetch.sent.map((sent, index) => {
    const body = sent.body as Body;
    const text = JSON.stringify(body);
    if (body.tools) return { key: `chat-${index}`, kind: "chat", text };
    if (text.includes("<notes>")) return { key: "final", kind: "final", text };
    const part = Number(/part (\d+) of (\d+)/.exec(promptOf(body))?.[1]);
    tries[part] = (tries[part] ?? 0) + 1;
    return { key: `part-${String(part).padStart(3, "0")}-try-${tries[part]}`, kind: "part", text };
  });
  const order = (body: { key: string; kind: string }) => (body.kind === "part" ? `1-${body.key}` : body.kind === "final" ? "2" : body.key === "chat-0" ? "0" : `3-${body.key}`);
  bodies.sort((first, second) => (order(first) < order(second) ? -1 : order(first) > order(second) ? 1 : 0));
  bodies.forEach((body, index) => {
    if (body.kind === "chat") body.key = index === 0 ? "chat-first" : "chat-closing";
  });
  const read = result.toolTurns[0]!.calls[0]!.result as ToolResult;
  return { bodies, result, events, read };
}

/** The keys of the bodies that are not the golden ones, byte for byte. */
function changed(bodies: Array<{ key: string; text: string }>, expected: Golden): string[] {
  expect(bodies.map((body) => body.key)).toEqual(expected.map((body) => body.key));
  const byKey = new Map(expected.map((body) => [body.key, body.text]));
  return bodies.filter((body) => byKey.get(body.key) !== body.text).map((body) => body.key);
}

/** The function response of the closing chat request: the result of the read, as the model got it. */
const functionResponseOf = (body: Body): Body => body.contents.flatMap((content: Body) => content.parts).find((part: Body) => part.functionResponse).functionResponse;

describe("a whole-file read, request by request against 0.99.12", () => {
  it("sends every body as 0.99.12 did when every part is read", async () => {
    const { bodies, result, events, read } = await question("ok");
    expect(bodies).toHaveLength(32);
    expect(changed(bodies, golden("ok"))).toEqual([]);
    // (f) The step of a read that lost nothing is unchanged, and so are its notices.
    expect(result.steps).toContain("Read all of app.log for “Timeline of all errors” — 29 parts, 29 relevant");
    expect(read.note).toBeUndefined();
    expect(events.filter((event) => event.type === "notice").map((event) => event.type === "notice" && event.code)).toEqual(["searching_instead"]);
  });

  it("changes only the last step of the read and the closing request when 2 of its 29 parts fail", async () => {
    const { bodies, result, events, read } = await question("fail");
    expect(bodies).toHaveLength(38);
    const expected = golden("fail");
    expect(changed(bodies, expected)).toEqual(["final", "chat-closing"]);

    // The last step of the read: only the line that says what the notes cover, and one sentence after it.
    const was = JSON.parse(expected.find((body) => body.key === "final")!.text) as Body;
    const now = JSON.parse(bodies.find((body) => body.key === "final")!.text) as Body;
    const before = promptOf(was).split("\n");
    const after = promptOf(now).split("\n");
    const at = before.indexOf("These notes cover all 29 parts of app.log (2 part(s) could not be read). Parts with nothing relevant are omitted.");
    expect(at).toBeGreaterThan(0);
    expect(after).toEqual([
      ...before.slice(0, at),
      "These notes cover 27 of the 29 parts of app.log (2 part(s) could not be read). Parts with nothing relevant are omitted.",
      "Some parts could not be read, so the notes are incomplete. Say in the answer that it is incomplete.",
      ...before.slice(at + 1),
    ]);
    now.contents[0].parts[0].text = promptOf(was);
    expect(JSON.stringify(now)).toBe(JSON.stringify(was));

    // The closing chat request: only the note of the read's result.
    const closingWas = JSON.parse(expected.find((body) => body.key === "chat-closing")!.text) as Body;
    const closingNow = JSON.parse(bodies.find((body) => body.key === "chat-closing")!.text) as Body;
    const response = functionResponseOf(closingNow).response;
    expect(response.note).toBe("Incomplete: 2 of the 29 parts could not be read, so this answer misses what they hold. Tell the user it is incomplete.");
    expect(functionResponseOf(closingWas).response.note).toBeUndefined();
    delete response.note;
    expect(JSON.stringify(closingNow)).toBe(JSON.stringify(closingWas));

    // The result keeps its count of the parts that failed, and the note.
    expect(read).toMatchObject({ parts_read: 29, parts_with_relevant_content: 27, parts_that_failed: 2, note: expect.stringMatching(/^Incomplete: 2 of the 29 parts/) });
    // (d) The step ends with ", incomplete".
    expect(result.steps).toContain("Read all of app.log for “Timeline of all errors” — 29 parts, 27 relevant, incomplete");
    // (e) One "read_incomplete" notice, with the counts.
    const notices = events.flatMap((event) => (event.type === "notice" ? [event] : []));
    expect(notices.map((notice) => notice.code)).toEqual(["searching_instead", "read_incomplete"]);
    expect(notices[1]).toMatchObject({ display: "none", documentIds: ["log-1"], counts: { failed: 2, parts: 29 }, message: "2 of the 29 parts of app.log could not be read, so the answer may miss what they hold." });
    // The answer itself still ended as it should: what it says is up to the model.
    expect(answerInfoOf(result).complete).toBe(true);
  });

  it("keeps the incomplete fields and the note in a stand-in of that read (c)", async () => {
    const { result, read } = await question("fail");
    const call = result.toolTurns[0]!.calls[0]!;
    // The answer is short here: a stand-in is made whatever its size, as for a result that showed pages.
    const stub = stubResult(call, read, true)!;
    expect(stub).toMatchObject({ dropped: true, parts_read: 29, parts_that_failed: 2 });
    expect(stub.note).toBe(`This is the start of the answer of the whole-file read. The rest was dropped from the conversation to make room. ${read.note}`);
  });
});

describe("a stand-in of a whole-file read keeps what says it is incomplete", () => {
  const call = { id: "c1", name: "analyze_whole_document", args: { document_id: "log-1", task: "Timeline" } };
  // Every field a read that writes an answer can have, large enough for a stand-in.
  const prose: ToolResult = {
    document: "app.log",
    parts_read: 29,
    parts_with_relevant_content: 20,
    parts_that_failed: 4,
    notes_cut_short: 1,
    notes_left_out: 2,
    answer_cut_short: true,
    notes_only: true,
    note: "Incomplete: 4 of the 29 parts could not be read, so this answer misses what they hold. Tell the user it is incomplete.",
    answer: "א".repeat(15_000),
    answer_shortened: "The rest of this answer did not fit in the room left in this conversation.",
    tool_turns_left: 9,
  };
  // Every field a read that lists items can have.
  const items: ToolResult = {
    document: "app.log",
    total_items: 180,
    counts_by_label: { ERROR: 180 },
    items: Array.from({ length: 50 }, (_, index) => ({ line: 97 * (index + 1), label: "ERROR", quote: "ERROR worker-3 took 900ms" })),
    more_items: 130,
    unverified_items: 3,
    parts_read: 29,
    parts_failed: 4,
    parts_cut_short: 1,
    note: "The first 50 items are shown; total_items counts them all. 4 parts could not be read (HTTP 503), so items may be missing: tell the user the count may be incomplete.",
    tool_turns_left: 9,
  };

  it("lists every field of an answer as kept or dropped", () => {
    const kept = ["document", "parts_read", "parts_that_failed", "notes_cut_short", "notes_left_out", "notes_only", "answer_cut_short", "answer", "note"];
    const dropped = ["parts_with_relevant_content", "answer_shortened", "tool_turns_left"];
    expect([...kept, ...dropped].sort()).toEqual(Object.keys(prose).sort());
    const stub = stubResult(call, prose)!;
    expect(Object.keys(stub)).toEqual(["document", "dropped", "parts_read", "parts_that_failed", "notes_cut_short", "notes_left_out", "notes_only", "answer_cut_short", "answer", "note"]);
    for (const field of kept.filter((field) => field !== "answer" && field !== "note")) expect(stub[field]).toEqual(prose[field]);
    for (const field of dropped) expect(stub).not.toHaveProperty(field);
    // Its answer is cut as before (decision 21: D6), and its note comes after the stand-in's own.
    expect(stub.answer).toBe(`${"א".repeat(6_000)}…`);
    expect(stub.note).toBe(`This is the start of the answer of the whole-file read. The rest was dropped from the conversation to make room. ${prose.note}`);
  });

  it("lists every field of an items read as kept or dropped", () => {
    const kept = ["document", "total_items", "counts_by_label", "items", "more_items", "unverified_items", "parts_read", "parts_failed", "parts_cut_short", "note"];
    const dropped = ["tool_turns_left"];
    expect([...kept, ...dropped].sort()).toEqual(Object.keys(items).sort());
    const stub = stubResult(call, items)!;
    expect(Object.keys(stub)).toEqual(["document", "dropped", "parts_read", "total_items", "counts_by_label", "unverified_items", "items", "more_items", "parts_failed", "parts_cut_short", "note"]);
    for (const field of ["document", "total_items", "counts_by_label", "unverified_items", "parts_read", "parts_failed", "parts_cut_short"]) expect(stub[field]).toEqual(items[field]);
    for (const field of dropped) expect(stub).not.toHaveProperty(field);
    // Its first 20 items (D6), and the items it does not show counted against them.
    expect(stub.items).toEqual((items.items as unknown[]).slice(0, 20));
    expect(stub.more_items).toBe(160);
    // The read's note without the sentence on the items its result showed.
    expect(stub.note).toBe("This is the start of the list of the whole-file read, with its counts. The rest of the list was dropped from the conversation to make room. 4 parts could not be read (HTTP 503), so items may be missing: tell the user the count may be incomplete.");
  });

  it("keeps 7 of 7 incomplete fields", () => {
    const fields = ["parts_that_failed", "notes_cut_short", "notes_left_out", "notes_only", "answer_cut_short", "parts_failed", "more_items"];
    const stubs = [stubResult(call, prose)!, stubResult(call, items)!];
    expect(fields.filter((field) => stubs.some((stub) => field in stub))).toEqual(fields);
  });

  it("is unchanged for a read that is complete", () => {
    const complete: ToolResult = { document: "app.log", parts_read: 29, parts_with_relevant_content: 29, answer: "x".repeat(8_000), tool_turns_left: 9 };
    expect(stubResult(call, complete)).toEqual({ document: "app.log", dropped: true, parts_read: 29, answer: `${"x".repeat(6_000)}…`, note: "This is the start of the answer of the whole-file read. The rest was dropped from the conversation to make room." });
    const list: ToolResult = { ...items, more_items: undefined, parts_failed: undefined, parts_cut_short: undefined, items: (items.items as unknown[]).slice(0, 30), total_items: 30, note: undefined };
    const stub = stubResult(call, JSON.parse(JSON.stringify(list)) as ToolResult)!;
    expect(Object.keys(stub)).toEqual(["document", "dropped", "parts_read", "total_items", "counts_by_label", "unverified_items", "items", "note"]);
    expect(stub.note).toBe("This is the start of the list of the whole-file read, with its counts. The rest of the list was dropped from the conversation to make room.");
    // A complete read with more items than its result showed: the stand-in of 0.10.0, without `more_items`.
    const longer: ToolResult = { ...items, parts_failed: undefined, parts_cut_short: undefined, note: "The first 50 items are shown; total_items counts them all." };
    const longStub = stubResult(call, JSON.parse(JSON.stringify(longer)) as ToolResult)!;
    expect(Object.keys(longStub)).toEqual(["document", "dropped", "parts_read", "total_items", "counts_by_label", "unverified_items", "items", "note"]);
    expect(longStub.note).toBe("This is the start of the list of the whole-file read, with its counts. The rest of the list was dropped from the conversation to make room.");
  });
});
