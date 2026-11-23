// The tests of the question loop that hold work to the clock: a long history checked in one pass
// (from test/loop-robustness.test.ts), and one wait for a turn to look at pages, not one for each
// look (from test/page-looks.test.ts).
import "../load-pdf-libraries.js";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type ModelMessage, type ModelToolRound } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "../fake-model.js";
import { BUSY, library, sleep } from "../page-look-library.js";

const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");
const answersOf = (messages: ModelMessage[]) => roundsOf(messages).flatMap((round) => round.answers.map((answer) => answer.result));

async function largeLog(lines = 5_000, budget: Record<string, number> = {}) {
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, ...budget } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(lines)) });
  return { files, meta };
}

describe("since the second review of these changes", () => {
  it("checks the pointers of a long history in one pass", async () => {
    const { files, meta } = await largeLog();
    const stored: Array<Record<string, unknown>> = [{ role: "user", text: "Start." }];
    for (let round = 0; round < 1_500; round++) {
      const args = { document_id: meta.id, query: `term-${round}`, mode: "exact" };
      stored.push({ role: "tools", calls: [
        { name: "search_document", args, result: { document: "app.log", mode: "exact", total_matching_lines: 0, matches: [] } },
        { name: "search_document", args, result: { already_shown: true, note: "Not run: this exact call was answered earlier in this conversation." } },
        { name: "read_document", args: { document_id: meta.id, start_line: round + 1, end_line: round + 1 }, result: { document: "app.log", lines: `${round + 1}-${round + 1}`, total_lines: 5_000, text: "x" } },
        { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 1 }, result: { lines: "1-1", already_shown: true, note: "Not run: lines 1-1 are already shown." } },
      ] });
    }
    stored.push({ role: "assistant", text: "Done." }, { role: "user", text: "And now?" });
    const model = fakeModel([says("Done.")]);
    const started = Date.now();
    await askWithFiles({ files, model, documentIds: [meta.id], messages: stored as never });
    expect(Date.now() - started).toBeLessThan(3_000);
    // Every pointer still holds: its result is there.
    expect(answersOf(model.requests[0]!.messages).filter((answer) => answer.dropped === true)).toEqual([]);
  });
});

describe("looks at pages", () => {
  it("wait once in a turn: once a look of the turn was busy, its other looks do not wait", async () => {
    // Three looks of one turn, while another question held the turn, each waited pageLookWaitMs
    // in their turn: 90 s with the default.
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { files, meta } = await library({ pageLookWaitMs: 500 }, (load) => (load === 0 ? gate : 1));
    const view = (page: number) => ({ name: "view_pages", args: { document_id: meta.id, from_page: page } });
    const other = askWithFiles({ files, model: fakeModel([calls([view(1)]), says("Page 1.")]), documentIds: [meta.id], messages: [{ role: "user", text: "Page 1?" }] });
    await sleep(20);
    const events: AskEvent[] = [];
    const started = Date.now();
    const result = await askWithFiles({ files, model: fakeModel([calls([view(1), view(2), view(3)]), says("Busy.")]), documentIds: [meta.id], messages: [{ role: "user", text: "All pages?" }], onEvent: (event) => events.push(event) });
    const took = Date.now() - started;
    finish();
    expect(result.answered).toBe(true);
    expect(events.flatMap((event) => (event.type === "tool.end" ? [event.error] : []))).toEqual([BUSY, BUSY, BUSY]);
    expect(events.filter((event) => event.type === "notice" && event.code === "page_looks_busy")).toHaveLength(3);
    // One wait of 500 ms, not three.
    expect(took).toBeLessThan(1_000);
    expect((await other).answered).toBe(true);
  });
});
