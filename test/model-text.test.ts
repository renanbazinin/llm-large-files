// AskResult.modelText (0.99.13): what the model wrote, as it wrote it. It is the internal `text` of
// askWithFiles (every text delta of the answering model, the "\n\n" between requests included),
// whatever `showCitations` says, and equals `text` when nothing is hidden. It is in run.finish's
// result (and run.error's partial, and partialResultOf), and never in sseMessageOf. A chat that sends
// it back as the assistant turn, with citations hidden, makes the requests the evals recorded
// (specs/05-quick-fixes §2).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, partialResultOf, type AskEvent, type ChatMessage } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { replayOutputLimits } from "../evals/lib/runner.js";
import { sseMessageOf } from "llm-large-files/node";
import { fakeModel, says, utf8 } from "llm-large-files/testing";
import { replayFetch } from "../evals/lib/record.js";
import { evalLibrary } from "../evals/fixtures.js";
import { evalCases, SYSTEM } from "../evals/cases.js";

const CASSETTES = fileURLToPath(new URL("../evals/cassettes", import.meta.url));
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
// The sha256 of each shown text (showCitations: false) that 0.99.14 gives on the same replay: the
// CIT-4 rules hide more than 0.99.12 did (fixtures/shown-0.99.12.json). LLF_WRITE_SHOWN=1 writes it
// again, after a change to the hiding rules that is meant.
const SHOWN_FILE = new URL("./fixtures/shown-0.99.14.json", import.meta.url);
const SHOWN = (existsSync(SHOWN_FILE) ? JSON.parse(readFileSync(SHOWN_FILE, "utf8")) : {}) as Record<string, string>;

describe("modelText on the recorded answers (replay, citations hidden, history from modelText)", async () => {
  const library = await evalLibrary();
  const cases = evalCases(library.facts);
  type Turn = { id: string; turn: number; misses: number; error?: string; text?: string; modelText?: unknown; recorded: string; finishModelText?: unknown; sseKeys?: string[]; notices: string[] };
  const turns: Turn[] = [];
  let recordings = 0;
  for (const model of MODELS) {
    for (const evalCase of cases) {
      const folder = path.join(CASSETTES, model, evalCase.id);
      if (!existsSync(path.join(folder, "case.json"))) continue;
      recordings++;
      const recorded = JSON.parse(readFileSync(path.join(folder, "case.json"), "utf8")) as { questions: Array<{ answer: string }> };
      const replay = replayFetch(folder, { label: `${model}/${evalCase.id}` });
      const endpoint = geminiApi({ apiKey: "replay", model });
      // Each recording with its own memory of output limits, as the eval runner gives it (0.99.15).
      const outputLimits = replayOutputLimits(folder, endpoint.url);
      const adapter = gemini(endpoint, { fetch: replay, outputLimits });
      const messages: ChatMessage[] = [];
      for (const [index, turn] of evalCase.turns.entries()) {
        messages.push({ role: "user", text: turn.question });
        const before = replay.misses.length;
        const entry: Turn = { id: `${model}/${evalCase.id}#${index + 1}`, turn: index + 1, misses: 0, recorded: recorded.questions[index]!.answer, notices: [] };
        try {
          const result = await askWithFiles({
            files: library.files, model: adapter, documentIds: turn.documentIds, messages: [...messages], system: SYSTEM,
            ...(evalCase.budget ? { budget: evalCase.budget } : {}),
            ...(evalCase.limits ? { limits: evalCase.limits } : {}),
            ...(evalCase.onMissingDocuments ? { onMissingDocuments: evalCase.onMissingDocuments } : {}),
            streamText: true,
            showCitations: false,
            retry: { sleep: async () => undefined },
            onEvent: (event: AskEvent) => {
              if (event.type === "notice") entry.notices.push(event.code);
              if (event.type !== "run.finish") return;
              entry.finishModelText = event.result.modelText;
              entry.sseKeys = Object.keys((sseMessageOf(event).data as { result: object }).result);
            },
          });
          entry.text = result.text;
          entry.modelText = result.modelText;
          messages.push(...result.toolTurns);
          // The chatbot guide's record (0.99.13): show `text`, send `modelText` back.
          if (result.answered) messages.push({ role: "assistant", text: result.modelText });
        } catch (error) {
          entry.error = String((error as Error)?.message ?? error);
        }
        entry.misses = replay.misses.length - before;
        turns.push(entry);
        if (entry.error) break;
      }
    }
  }
  const followUps = turns.filter((t) => t.turn >= 2);

  it("replays the 96 recordings and their 112 answers (16 follow-ups of 7 multi-turn cases on 2 models)", () => {
    expect(recordings).toBe(96);
    expect(turns.filter((t) => t.turn === 1)).toHaveLength(96);
  });

  it("gives modelText on every answer, equal byte for byte to the text without hiding (the recorded answer)", () => {
    expect(turns).toHaveLength(112);
    for (const t of turns) expect(t.modelText, t.id).toBe(t.recorded);
  });

  it("hits every recorded follow-up request when the history is built from modelText (16 of 16; with the shown text 9 of 16 miss)", () => {
    expect(followUps).toHaveLength(16);
    expect(followUps.filter((t) => t.misses > 0 || t.error).map((t) => t.id)).toEqual([]);
  });

  it("carries modelText in run.finish, and never in sseMessageOf", () => {
    for (const t of turns) {
      expect(t.finishModelText, t.id).toBe(t.recorded);
      expect(t.sseKeys, t.id).not.toContain("modelText");
    }
  });

  it("shows the hidden text: 94 of the 112 shown answers differ from modelText (78 in 0.99.12), and none is longer", () => {
    expect(turns.filter((t) => t.text !== t.modelText)).toHaveLength(94);
    for (const t of turns) expect((t.text ?? "").length, t.id).toBeLessThanOrEqual(t.recorded.length);
  });

  it("shows the text pinned for 0.99.14 on all 112, with no citations_only notice (LOOP-10, §4.4)", () => {
    if (process.env.LLF_WRITE_SHOWN) writeFileSync(SHOWN_FILE, `${JSON.stringify(Object.fromEntries(turns.map((t) => [t.id, createHash("sha256").update(t.text ?? "").digest("hex")]).sort(([a], [b]) => String(a).localeCompare(String(b)))), null, 1)}\n`);
    const pinned = process.env.LLF_WRITE_SHOWN ? (JSON.parse(readFileSync(SHOWN_FILE, "utf8")) as Record<string, string>) : SHOWN;
    expect(Object.keys(pinned)).toHaveLength(112);
    expect(turns.map((t) => t.id).sort()).toEqual(Object.keys(pinned).sort());
    const changed = turns.filter((t) => createHash("sha256").update(t.text ?? "").digest("hex") !== pinned[t.id]).map((t) => t.id);
    expect(changed).toEqual([]);
    expect(turns.filter((t) => t.notices.includes("citations_only")).map((t) => t.id)).toEqual([]);
  });
});

describe("modelText, unit", () => {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
  const doc = files.ingest({ id: "contract-1", name: "contract.txt", bytes: utf8("Clause 1.\nClause 2: late fee 5%.\nClause 3.") });

  it("equals text when citations are shown", async () => {
    const meta = await doc;
    const result = await askWithFiles({ files, model: fakeModel([says("The late fee is 5% (contract.txt L2).")]), documentIds: [meta.id], messages: [{ role: "user", text: "Late fee?" }] });
    expect(result.modelText).toBe(result.text);
    expect(result.modelText).toBe("The late fee is 5% (contract.txt L2).");
  });

  it("keeps the citations the shown text leaves out", async () => {
    const meta = await doc;
    const result = await askWithFiles({ files, model: fakeModel([says("The late fee is 5% (contract.txt L2).")]), documentIds: [meta.id], messages: [{ role: "user", text: "Late fee?" }], showCitations: false });
    expect(result.text).toBe("The late fee is 5%.");
    expect(result.modelText).toBe("The late fee is 5% (contract.txt L2).");
  });

  it("is empty, as text is, for a filtered answer that is dropped", async () => {
    const meta = await doc;
    const result = await askWithFiles({ files, model: fakeModel([says("The late fee is (contract.txt L2", { finish: "filtered" })]), documentIds: [meta.id], messages: [{ role: "user", text: "Late fee?" }], showCitations: false, filteredAnswer: "drop" });
    expect(result.text).toBe("");
    expect(result.modelText).toBe("");
  });

  it("is in the partial result of a question that failed", async () => {
    const meta = await doc;
    const failing = fakeModel([says("Partly (contract.txt L2)"), new Error("boom")]);
    let partial: unknown;
    try {
      await askWithFiles({ files, model: { ...failing, send: async (request, hooks) => { await failing.send(request, hooks); throw Object.assign(new Error("HTTP 400"), { status: 400 }); } }, documentIds: [meta.id], messages: [{ role: "user", text: "Late fee?" }], showCitations: false, streamText: true, onText: () => undefined });
    } catch (error) {
      partial = partialResultOf(error);
    }
    expect(partial).toMatchObject({ modelText: expect.any(String) });
  });
});
