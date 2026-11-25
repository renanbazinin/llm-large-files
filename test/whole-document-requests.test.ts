// A whole-file read counts its requests (N12, new in 0.10.0): a round of merges that would pass the
// requests the read may make (`ToolCallLimits.maxRequests`) is not made. The answer is written from
// the notes that fit one request, and says it is incomplete; with no request left for the answer,
// the notes are the answer. probe3: a read given 32 requests made 40 (27 parts, 12 merges, the
// answer), and a question with `limits.requests: 32` made 42.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type GenerateText, type ToolRequestStart } from "../src/index.js";
import { PART_OUTPUT_TOKENS, TooManyPartsError } from "../src/map-reduce.js";
import { estimateMerges } from "../src/whole-cost.js";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

/** Notes of a part of about 2,600 tokens, as in probe3: three of them fill a batch of 8,000. */
const LONG_NOTES = `Notes (L1) ${"important finding ".repeat(900)}`;

/** probe3's document: a service log of 3,000 lines, read in parts of 8,000 tokens (27 parts). */
async function probe() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 8_000, contextTokens: 200_000, inlineTokens: 10 } });
  const meta = await files.ingest({ name: "big.log", bytes: utf8(serviceLog(3_000)) });
  return { files, meta };
}

/** Runs a read with `maxRequests`, and counts its requests by purpose. */
async function readWith(maxRequests: number | undefined, notes = LONG_NOTES) {
  const { files, meta } = await probe();
  const purposes: Record<string, number> = {};
  let finalPrompt = "";
  const generate: GenerateText = async ({ system, prompt }) => {
    if (system.startsWith("You write a complete answer")) finalPrompt = prompt;
    return system.startsWith("You write a complete answer") ? "The answer (L1)." : notes;
  };
  const onRequest = (start: ToolRequestStart) => {
    purposes[start.purpose] = (purposes[start.purpose] ?? 0) + 1;
    return { retry() {}, end() {} };
  };
  const { result } = await files.tools([meta], { generate }).executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every failure" }, maxRequests === undefined ? {} : { maxRequests }, { onRequest });
  const total = Object.values(purposes).reduce((sum, count) => sum + count, 0);
  return { result, purposes, total, finalPrompt };
}

describe("a whole-file read with maxRequests", () => {
  it("makes at most maxRequests requests (probe3: 32, where 0.9.0 made 40)", async () => {
    const open = await readWith(undefined);
    expect(open.purposes).toEqual({ part: 27, merge: 12, final: 1 });
    const capped = await readWith(32);
    expect(capped.total).toBeLessThanOrEqual(32);
    expect(capped.purposes.part).toBe(27);
    expect(capped.purposes.merge ?? 0).toBe(0);
    expect(capped.purposes.final).toBe(1);
  });

  it("writes the answer from the notes that fit one request, and says it is incomplete", async () => {
    const { result, finalPrompt } = await readWith(32);
    expect(result).toMatchObject({ parts_read: 27, parts_with_relevant_content: 27, notes_left_out: 24, answer: "The answer (L1)." });
    expect(result.note).toBe("Incomplete: this read reached the question's limit on model requests before it could combine the notes of every part, so the notes of 24 of the 27 relevant parts are not in this answer. Tell the user it is incomplete. For a complete list or an exact count, use search_document in exact or regex mode (it returns total_matching_lines), or ask about a narrower part of the file.");
    // The notes of the first parts, those that fit mapChunkTokens together.
    expect(finalPrompt.match(/### Lines \d+-\d+/g)).toHaveLength(3);
    expect(finalPrompt).toContain("The notes of 24 of the 27 relevant parts are left out: the read reached its limit on model requests before it could merge them. Say in the answer that it is incomplete.");
    expect(result.notes_cut_short).toBeUndefined();
  });

  it("merges while the rounds fit, then stops", async () => {
    // 27 parts, 9 merges of three notes each, then 3 merges: 40 requests in all, without a limit.
    const room = await readWith(39);
    expect(room.total).toBeLessThanOrEqual(39);
    expect(room.purposes).toEqual({ part: 27, merge: 9, final: 1 });
    expect(room.result.notes_left_out).toBeGreaterThan(0);
    const all = await readWith(40);
    expect(all.purposes).toEqual({ part: 27, merge: 12, final: 1 });
    expect(all.result.notes_left_out).toBeUndefined();
  });

  it("returns the notes when no request is left for the answer", async () => {
    const { result, purposes } = await readWith(27);
    expect(purposes).toEqual({ part: 27 });
    expect(result).toMatchObject({ parts_read: 27, notes_only: true });
    expect(result.note).toBe("This read reached the question's limit on model requests before its last step, which writes one answer from the notes of the parts. The answer is those notes: answer from them.");
    expect(String(result.answer)).toMatch(/^### Lines 1-\d+\nNotes \(L1\)/);
  });

  it("is refused before any request when it has more parts than maxRequests, in either output", async () => {
    for (const output of ["answer", "items"]) {
      const { files, meta } = await probe();
      let requests = 0;
      const generate: GenerateText = async () => {
        requests++;
        return "NOTHING RELEVANT";
      };
      const tools = files.tools([meta], { generate, maxWholeDocumentReads: 5 });
      // 27 parts and 26 requests: 0.10.0 before this fix read all 27 parts, and items mode did even with 0.
      for (const maxRequests of [26, 5, 0]) {
        const { result } = await tools.executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every failure", output }, { maxRequests });
        expect(result).toEqual({ error: `Reading all of big.log takes 27 model requests, one for each part, and ${maxRequests} ${maxRequests === 1 ? "is" : "are"} left for it in this question. Use search_document and read_document.` });
      }
      expect(requests).toBe(0);
      // No request was sent: that was no read.
      expect(tools.wholeReadsLeft?.(meta.id)).toBe(5);
      // As many requests as parts: the parts are read, and nothing more.
      const { result } = await tools.executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every failure", output }, { maxRequests: 27 });
      expect(result.parts_read).toBe(27);
      expect(requests).toBe(27);
    }
  });

  it("says one request, for one part, in the singular", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "all.txt", bytes: utf8("One line.\nTwo lines.") });
    const generate: GenerateText = async () => "NOTHING RELEVANT";
    const { result } = await files.tools([meta], { generate }).executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "anything" }, { maxRequests: 0 });
    // 0.10.0 before this fix: "takes 1 model requests, one for each part".
    expect(result).toEqual({ error: "Reading all of all.txt takes 1 model request, for its one part, and 0 are left for it in this question. Use search_document and read_document." });
    expect(new TooManyPartsError("all.txt", 2, 1, "requests").message).toBe("Reading all of all.txt takes 2 model requests, one for each part, and 1 is left for it in this question. Use search_document and read_document.");
    expect(new TooManyPartsError("all.txt", 1, 0).message).toBe("Reading all of all.txt needs 1 model call, over the limit of 0. Use search_document to narrow the question first.");
    expect(new TooManyPartsError("all.txt", 31, 30).message).toBe("Reading all of all.txt needs 31 model calls, over the limit of 30. Use search_document to narrow the question first.");
  });

  it("prices its merges before it halves a part the model finds too large", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { mapChunkTokens: 1_500, inlineTokens: 10 } });
    const meta = await files.ingest({ name: "small.log", bytes: utf8(serviceLog(160)) });
    let parts = 0;
    let tooLarge = 0;
    const generate: GenerateText = async ({ system, prompt }) => {
      if (system.startsWith("You read one part")) {
        parts = Number(/This is part \d+ of (\d+)/.exec(prompt)![1]);
        // The second part is refused as larger than the model takes, whole or halved.
        if (prompt.includes("part 2 of")) {
          tooLarge++;
          throw Object.assign(new Error("too large"), { status: 400, kind: "context_overflow" });
        }
      }
      return system.startsWith("You write a complete answer") ? "The answer (L1)." : "A note (L1).";
    };
    // Without a limit, the part is halved, and its halves are refused too.
    await files.tools([meta], { generate, retry: { retries: 0 } }).executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every failure" }, {});
    expect(tooLarge).toBe(3);
    const count = parts;
    const merges = estimateMerges(count, PART_OUTPUT_TOKENS, 1_500).requests;
    expect(merges).toBeGreaterThan(0);
    // Room for the parts, their merges as long as the output limit allows, and the answer: no halving.
    tooLarge = 0;
    const { result } = await files.tools([meta], { generate, retry: { retries: 0 } }).executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every failure" }, { maxRequests: count + merges + 1 });
    expect(tooLarge).toBe(1);
    expect(result.parts_that_failed).toBe(1);
    // One more request than that: the part is read as two halves.
    tooLarge = 0;
    await files.tools([meta], { generate, retry: { retries: 0 } }).executeWithFiles("analyze_whole_document", { document_id: meta.id, task: "list every failure" }, { maxRequests: count + merges + 2 });
    expect(tooLarge).toBe(3);
  });
});

describe("a question with limits.requests", () => {
  it("stays within it through a whole-file read (probe3: 32, where 0.9.0 made 42)", async () => {
    const { files, meta } = await probe();
    const generateText: GenerateText = async (request) => {
      request.onUsage?.({ inputTokens: 1_000, outputTokens: 3_000 });
      return request.system.startsWith("You write a complete answer") ? "The answer (L1)." : LONG_NOTES;
    };
    const model = fakeModel([calls([{ id: "a", name: "analyze_whole_document", args: { document_id: meta.id, task: "list every failure" } }]), says("answer")], { generateText });
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "q" }], limits: { requests: 32 } });
    expect(result.usage.requests).toBeLessThanOrEqual(32);
    expect(result.answered).toBe(true);
    expect(result.toolTurns[0]!.calls[0]!.result).toMatchObject({ parts_read: 27, notes_left_out: expect.any(Number) });
  });
});
