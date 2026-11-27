// No AskResult key without an event-visibility decision (EVENT-KEYLIST, 0.99.13; specs/03-privacy-sse
// §6.3):
//   - src/event-visibility.ts holds RESULT_VISIBILITY, declared
//     `satisfies Record<keyof AskResult, ResultVisibility>`: a new key that is not in it does not compile;
//   - eventResultOf and sseMessageOf's run.finish and run.error allow-lists read it: a key without a
//     decision is left out of every event (fail closed; until 0.99.13 eventResultOf copied every new
//     key into run.finish and run.error);
//   - FULL below is a `Required<AskResult>`: the test does not compile until a new key has a value
//     here too, and the runtime part then checks what each event does with it.
// 0.99.12's 16 keys keep what they did; modelText (0.99.13) is in onEvent's results and never in SSE.
import { describe, expect, it } from "vitest";
import type { AskEvent, AskResult } from "llm-large-files";
import { sseMessageOf } from "llm-large-files/node";
import { eventResultOf, RESULT_VISIBILITY, type ResultVisibility } from "../src/event-visibility.js";

// Compile-time key list: both directions.
type Missing = Exclude<keyof AskResult, keyof typeof RESULT_VISIBILITY>;
type Extra = Exclude<keyof typeof RESULT_VISIBILITY, keyof AskResult>;
const noneMissing: [Missing] extends [never] ? true : Missing = true;
const noneExtra: [Extra] extends [never] ? true : Extra = true;

const QUOTE = "עובד דנה כהן | ת.ז. 031234567";
/** Every key of AskResult, each with a value that shows whether an event kept it. */
const FULL: Required<AskResult> = {
  text: "השכר מוסתר.",
  modelText: "השכר מוסתר (salaries.txt L2).",
  answered: true,
  blockReason: "SAFETY",
  steps: ["Read salaries.txt lines 1-4"],
  evidence: [{ tool: "read_document", documentId: "upload-1", document: "salaries.txt", lines: [[1, 4]], callId: "call_1" }],
  toolTurns: [{ role: "tools", calls: [{ id: "c1", name: "read_document", args: { document_id: "upload-1" }, result: { text: `2| ${QUOTE}` } }] }] as unknown as AskResult["toolTurns"],
  plan: { inline: [], searchable: [{ id: "upload-1", name: "salaries.txt", format: "text", estimatedTokens: 10, owner: "alice", scope: ["alice", "chat-1"], sha256: "ab", outline: [{ line: 1, level: 1, title: "כותרת" }] }] } as unknown as AskResult["plan"],
  missing: ["upload-9"],
  budget: { contextTokens: 1, maxRequestBytes: 1, inlineTokens: 1, reservedTokens: 1, mapChunkTokens: 1, maxMapChunks: 1, toolResultCharacters: 1 } as AskResult["budget"],
  turns: 2,
  finishReason: "STOP",
  usage: { inputTokens: 1, outputTokens: 1, requests: 2 } as AskResult["usage"],
  lastUsage: { promptTokenCount: 1 },
  finish: "complete",
  citations: { checked: 1, supported: 1, unchecked: 0, unsupported: [], cited: [] },
  questionId: "q-1",
};

const finishOf = (result: AskResult, withResults: boolean) => ({ type: "run.finish", seq: 9, runId: "run_0", time: 0, result: eventResultOf(result, withResults) }) as AskEvent;
const errorOf = (result: AskResult, withResults: boolean) => ({ type: "run.error", seq: 9, runId: "run_0", time: 0, error: { message: "x" }, partial: eventResultOf(result, withResults) }) as AskEvent;

describe("every AskResult key has an event-visibility decision", () => {
  it("the table and AskResult name the same 17 keys", () => {
    expect(noneMissing).toBe(true);
    expect(noneExtra).toBe(true);
    expect(Object.keys(RESULT_VISIBILITY).sort()).toEqual(Object.keys(FULL).sort());
    expect(Object.keys(RESULT_VISIBILITY)).toHaveLength(17);
  });

  for (const [key, rule] of Object.entries(RESULT_VISIBILITY) as Array<[keyof AskResult, ResultVisibility]>) {
    it(`${key}: run.finish and run.error do what the table says (${rule.event} / sse ${rule.sse} / partial ${rule.ssePartial})`, () => {
      for (const withResults of [false, true]) {
        const event = eventResultOf(FULL, withResults) as Record<string, unknown>;
        const shown = rule.event === "yes" || rule.event === "plan" || (rule.event === "withResults" && withResults);
        expect(key in event, `${key} in run.finish, eventResults ${withResults}`).toBe(shown);
        if (rule.event === "yes") expect(event[key], key).toEqual(FULL[key]);
        if (rule.event === "plan") expect(JSON.stringify(event[key])).not.toMatch(/"owner"|"scope"|"sha256"/);
        if (rule.event === "plan" && !withResults) expect(JSON.stringify(event[key])).not.toContain("outline");
        if (rule.event === "plan" && withResults) expect(JSON.stringify(event[key])).toContain("outline");
        const sse = (sseMessageOf(finishOf(FULL, withResults)).data as { result: Record<string, unknown> }).result;
        expect(sse[key] !== undefined, `${key} in SSE run.finish, eventResults ${withResults}`).toBe(rule.sse !== "no");
        const partial = (sseMessageOf(errorOf(FULL, withResults)).data as { partial: Record<string, unknown> }).partial;
        expect(partial[key] !== undefined, `${key} in SSE run.error partial`).toBe(rule.ssePartial !== "no");
      }
    });
  }

  it("a key with no decision is left out of every event (fail closed)", () => {
    const withExtra = { ...FULL, debugRaw: QUOTE } as AskResult;
    for (const withResults of [false, true]) {
      expect(eventResultOf(withExtra, withResults)).not.toHaveProperty("debugRaw");
      expect((sseMessageOf(finishOf(withExtra, withResults)).data as { result: object }).result).not.toHaveProperty("debugRaw");
      expect((sseMessageOf(errorOf(withExtra, withResults)).data as { partial: object }).partial).not.toHaveProperty("debugRaw");
    }
    // Nor a key that names a property of every object.
    expect(eventResultOf({ ...FULL, constructor: QUOTE, toString: QUOTE } as unknown as AskResult, true)).not.toHaveProperty("toString", QUOTE);
  });

  it("modelText is never in SSE, with or without eventResults", () => {
    for (const withResults of [false, true]) {
      expect(eventResultOf(FULL, withResults).modelText).toBe(FULL.modelText);
      expect(JSON.stringify(sseMessageOf(finishOf(FULL, withResults)).data)).not.toContain("(salaries.txt L2)");
      expect(JSON.stringify(sseMessageOf(errorOf(FULL, withResults)).data)).not.toContain("(salaries.txt L2)");
    }
  });

  it("keeps the order of 0.99.12: the result's keys, then the tool rounds, then the plan; SSE byte for byte", () => {
    expect(Object.keys(eventResultOf(FULL, false))).toEqual(["text", "modelText", "answered", "blockReason", "steps", "evidence", "missing", "budget", "turns", "finishReason", "usage", "lastUsage", "finish", "citations", "questionId", "plan"]);
    expect(Object.keys(eventResultOf(FULL, true)).slice(-2)).toEqual(["toolTurns", "plan"]);
    // What 0.99.12's sseMessageOf wrote for this event, by its fixed lists.
    const { answered, text, finish, finishReason, blockReason, citations, steps, evidence, turns, usage, missing, questionId } = FULL;
    const finished = { type: "run.finish", seq: 9, runId: "run_0", time: 0, result: { answered, text, finish, finishReason, blockReason, citations, steps, evidence, turns, usage, missing, questionId } };
    expect(JSON.stringify(sseMessageOf(finishOf(FULL, true)).data)).toBe(JSON.stringify(finished));
    const failed = { type: "run.error", seq: 9, runId: "run_0", time: 0, error: { message: "x" }, partial: { steps, evidence, usage, missing } };
    expect(JSON.stringify(sseMessageOf(errorOf(FULL, false)).data)).toBe(JSON.stringify(failed));
    // A run.error without a partial result has none.
    expect(sseMessageOf({ type: "run.error", seq: 9, runId: "run_0", time: 0, error: { message: "x" } } as AskEvent).data).toEqual({ type: "run.error", seq: 9, runId: "run_0", time: 0, error: { message: "x" }, partial: undefined });
  });
});
