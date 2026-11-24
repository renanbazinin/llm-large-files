// L1 (0.10.0): the room for tool results is shared in tokens, each result at its document's own
// characters per token (`characters` / `estimatedTokens`, from 0.8 to 4), not at 2 for all. A
// table of numbers takes about one token a character, so at 2 its results took 2.22 times their
// room and the request passed the window. Results that would still pass the room are cut.
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  MemoryDocumentStore,
  type AskEvent,
  type LargeFiles,
  type ModelMessage,
  type ModelToolRound,
  type ToolCallLimits,
  type ToolSet,
} from "llm-large-files";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");

/** probe1's numeric CSV: about 0.9 characters a token. */
function numbers(rows: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= rows; i++) lines.push(`${i},${(i * 7919) % 100_000},${(i * 104_729) % 1_000}.${i % 100},2026-03-${String((i % 28) + 1).padStart(2, "0")},${(i * 31) % 997}`);
  return lines.join("\n");
}

/** Hebrew prose: about 1.9 characters a token. */
const hebrew = (lines: number) => Array.from({ length: lines }, (_, index) => `${index + 1}. בחוזה השכירות נקבע כי השוכר ישלם לבעל הדירה סך של 4,167.90 ש"ח בכל חודש, וכי הסכום יוצמד למדד המחירים לצרכן.`).join("\n");

/** Reads of `count` pieces of `size` lines of a document, each from where the last one ended. */
const reads = (id: string, count: number, size: number, from = 1) => Array.from({ length: count }, (_, index) => ({
  id: `r${from + index * size}`,
  name: "read_document",
  args: { document_id: id, start_line: from + index * size, end_line: from + (index + 1) * size - 1 },
}));

/** The estimates of the chat's requests (`request.start`). */
function estimates() {
  const seen: number[] = [];
  return { seen, onEvent: (event: AskEvent) => event.type === "request.start" && event.role !== "reader" && seen.push(event.estimatedInputTokens ?? 0) };
}

describe("the room for tool results, in tokens", () => {
  it("keeps 8 reads of a numeric CSV on a 128K window within the limit of the request", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "numbers.csv", bytes: utf8(numbers(8_000)) });
    expect(meta.characters / meta.estimatedTokens).toBeLessThan(1);
    const model = fakeModel([calls(reads(meta.id, 8, 400)), calls(reads(meta.id, 8, 400, 3_201)), says("Done.")], { contextTokens: 128_000 });
    const record = estimates();
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("Sum the second column."), onEvent: record.onEvent });
    expect(result.plan.searchable).toHaveLength(1);
    // The tools may fill the window up to half of what is kept free; the answer takes the other half.
    const limit = result.budget.contextTokens - Math.floor(result.budget.reservedTokens / 2);
    expect(record.seen).toHaveLength(3);
    for (const tokens of record.seen) expect(tokens).toBeLessThanOrEqual(limit);
    // Every read ran, cut to its share: none was refused for want of room.
    expect(roundsOf(model.requests[1]!.messages)[0]!.answers.map((answer) => answer.result.error)).toEqual(Array(8).fill(undefined));
    expect(roundsOf(model.requests[1]!.messages)[0]!.answers.every((answer) => typeof answer.result.text === "string")).toBe(true);
  });

  it("gives a call the characters its document takes a token: a Hebrew text more than a table of numbers", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000, toolResultCharacters: 24_000 } });
    const table = await files.ingest({ name: "numbers.csv", bytes: utf8(numbers(4_000)) });
    const prose = await files.ingest({ name: "חוזה.txt", bytes: utf8(hebrew(3_000)) });
    // The limits each call was given, as the tool set saw them.
    const given: Array<{ id: unknown; limits: ToolCallLimits | undefined }> = [];
    const own: LargeFiles = {
      ...files,
      tools(documents, options) {
        const real = files.tools(documents, options);
        return { ...real, executeWithFiles: (name, args, limits, hooks) => {
          given.push({ id: args.document_id, limits });
          return real.executeWithFiles(name, args, limits, hooks);
        } };
      },
    };
    for (const meta of [table, prose]) {
      const model = fakeModel([calls(reads(meta.id, 4, 600)), says("Done.")], { contextTokens: 50_000 });
      await askWithFiles({ files: own, model, documentIds: [table.id, prose.id], messages: question("?") });
    }
    const shareOf = (id: string) => given.find((call) => call.id === id)!.limits!.maxResultCharacters!;
    const ratio = (meta: typeof table) => meta.characters / meta.estimatedTokens;
    // The same room, in tokens: shared in characters by each document's own rate.
    expect(shareOf(prose.id) / shareOf(table.id)).toBeCloseTo(ratio(prose) / ratio(table), 1);
    expect(shareOf(table.id)).toBeLessThan(24_000);
  });

  it("changes nothing on a 1M window: a Hebrew turn sends the results as the tools give them", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "חוזה.txt", bytes: utf8(hebrew(4_000)) });
    const turn = reads(meta.id, 4, 300);
    const model = fakeModel([calls(turn), says("סיכום.")], { contextTokens: 1_048_576 });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("מה נקבע בחוזה?") });
    const tools = files.tools([meta]);
    const sent = roundsOf(model.requests[1]!.messages)[0]!.answers.map((answer) => JSON.stringify(answer.result));
    const whole = await Promise.all(turn.map(async (call) => JSON.stringify({ ...await tools.execute(call.name, call.args), tool_turns_left: 10 })));
    expect(sent).toEqual(whole);
  });

  it("cuts results that would pass the room, from a tool set that does not keep to maxResultCharacters", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "numbers.csv", bytes: utf8(numbers(8_000)) });
    const digits = numbers(2_000).slice(0, 40_000);
    const own: LargeFiles = {
      ...files,
      tools(documents, options) {
        const real = files.tools(documents, options);
        const set: ToolSet = {
          ...real,
          // 40,000 characters of numbers, whatever the room: about 43,000 tokens each.
          executeWithFiles: async (_name, args) => ({ result: { document: "numbers.csv", lines: `${String(args.start_line)}-${String(args.end_line)}`, text: digits }, files: [] }),
        };
        return set;
      },
    };
    const model = fakeModel([calls(reads(meta.id, 4, 400)), says("Done.")], { contextTokens: 128_000 });
    const record = estimates();
    const result = await askWithFiles({ files: own, model, documentIds: [meta.id], messages: question("?"), onEvent: record.onEvent });
    const limit = result.budget.contextTokens - Math.floor(result.budget.reservedTokens / 2);
    for (const tokens of record.seen) expect(tokens).toBeLessThanOrEqual(limit);
    const answers = roundsOf(model.requests[1]!.messages)[0]!.answers;
    // The first results fit; those that would pass the room are cut, and say so.
    expect(answers[0]!.result.text).toBe(digits);
    expect(answers.at(-1)!.result).toMatchObject({ truncated: true, note: "Result cut to the size limit. Ask for a smaller range." });
  });
});
