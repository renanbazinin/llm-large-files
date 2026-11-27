// 0.99.14 gates on the 112 recorded answers (specs/03-privacy-sse G7–G10, CIT-17, replay 96/96):
// every request body is the recorded one in "remove", "token" and sources "off" (the replay misses
// none); with eventResults off no event and no SSE message has a quote; every answer that cites has
// anchors and sources, without quotes, in SSE run.finish, each anchor inside the text; every quote
// is cut from what the model was sent; at least 215 sources have a quote; and with sources "off"
// nothing of a source reaches an event or SSE. Follow-ups send modelText back, as the guide does.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askWithFiles, type AskEvent, type ChatMessage, type CitationMarkers } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { sseMessageOf } from "llm-large-files/node";
import { replayFetch } from "../evals/lib/record.js";
import { evalLibrary } from "../evals/fixtures.js";
import { evalCases, SYSTEM } from "../evals/cases.js";

const CASSETTES = fileURLToPath(new URL("../evals/cassettes", import.meta.url));
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

/** Text as the coverage check compares it: no "N| " line prefixes, no "Row R: ", white space collapsed. */
const normalized = (text: string) => text.replace(/^\s*\d{1,9}\| ?/gmu, "").replace(/\s+/gu, " ").trim();

type Answer = { id: string; misses: number; error?: string; cites: boolean; text: string; anchors: number; sources: number; quotes: string[]; uncovered: string[]; sseFinish?: Record<string, unknown>; quoteKeys: number; citationEvents: number; leaks: string[] };

async function replayAll(mode: { citationMarkers?: CitationMarkers; sources?: "on" | "off" }) {
  const library = await evalLibrary();
  const cases = evalCases(library.facts);
  const answers: Answer[] = [];
  let recordings = 0;
  for (const model of MODELS) {
    for (const evalCase of cases) {
      const folder = path.join(CASSETTES, model, evalCase.id);
      if (!existsSync(path.join(folder, "case.json"))) continue;
      recordings++;
      const replay = replayFetch(folder, { label: `${model}/${evalCase.id}` });
      // What the model was sent, for the coverage of quotes: every string of every request body.
      const sent: string[] = [];
      const fetching: typeof fetch = async (input, init) => {
        if (typeof init?.body === "string") {
          const walk = (value: unknown): void => {
            if (typeof value === "string") sent.push(normalized(value));
            else if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === "object") Object.values(value).forEach(walk);
          };
          walk(JSON.parse(init.body));
        }
        return replay(input, init);
      };
      const adapter = gemini(geminiApi({ apiKey: "replay", model }), { fetch: fetching });
      const messages: ChatMessage[] = [];
      for (const [index, turn] of evalCase.turns.entries()) {
        messages.push({ role: "user", text: turn.question });
        const before = replay.misses.length;
        const answer: Answer = { id: `${model}/${evalCase.id}#${index + 1}`, misses: 0, cites: false, text: "", anchors: 0, sources: 0, quotes: [], uncovered: [], quoteKeys: 0, citationEvents: 0, leaks: [] };
        try {
          const result = await askWithFiles({
            files: library.files, model: adapter, documentIds: turn.documentIds, messages: [...messages], system: SYSTEM,
            ...(evalCase.budget ? { budget: evalCase.budget } : {}),
            ...(evalCase.limits ? { limits: evalCase.limits } : {}),
            ...(evalCase.onMissingDocuments ? { onMissingDocuments: evalCase.onMissingDocuments } : {}),
            streamText: true,
            ...mode,
            retry: { sleep: async () => undefined },
            onEvent: (event: AskEvent) => {
              const own = JSON.stringify(event);
              const sse = JSON.stringify(sseMessageOf(event).data);
              answer.quoteKeys += (own.match(/"quote":/g) ?? []).length + (sse.match(/"quote":/g) ?? []).length;
              if (event.type === "citation") answer.citationEvents++;
              if (mode.sources === "off" && /"locators"|"quote"/.test(own + sse)) answer.leaks.push(event.type);
              if (event.type === "run.finish") answer.sseFinish = (sseMessageOf(event).data as { result: Record<string, unknown> }).result;
            },
          });
          answer.cites = (result.citations?.cited?.length ?? 0) > 0;
          answer.text = result.text;
          answer.anchors = result.anchors?.length ?? 0;
          answer.sources = result.sources?.length ?? 0;
          for (const anchor of result.anchors ?? []) if (anchor.at > result.text.length) answer.leaks.push(`anchor ${anchor.at} past ${result.text.length}`);
          for (const source of result.sources ?? []) {
            if (typeof source.quote !== "string") continue;
            answer.quotes.push(source.quote);
            const quote = normalized(source.quote.replace(/…$/u, ""));
            if (!sent.some((one) => one.includes(quote))) answer.uncovered.push(source.key);
          }
          messages.push(...result.toolTurns);
          if (result.answered) messages.push({ role: "assistant", text: result.modelText });
        } catch (error) {
          answer.error = String((error as Error)?.message ?? error);
        }
        answer.misses = replay.misses.length - before;
        answers.push(answer);
        if (answer.error) break;
      }
    }
  }
  return { recordings, answers };
}

describe("sources on the recorded answers", { timeout: 600_000 }, async () => {
  const removed = await replayAll({ citationMarkers: "remove" });
  const tokens = await replayAll({ citationMarkers: "token" });
  const off = await replayAll({ sources: "off" });

  it("replays the 96 recordings in every mode, with no request body changed (no miss) and no error", () => {
    for (const run of [removed, tokens, off]) {
      expect(run.recordings).toBe(96);
      expect(run.answers).toHaveLength(112);
      expect(run.answers.filter((answer) => answer.misses > 0 || answer.error).map((answer) => `${answer.id}: ${answer.error ?? `${answer.misses} misses`}`)).toEqual([]);
    }
  });

  it("G7: no quote in any event or SSE message with eventResults off", () => {
    for (const run of [removed, tokens, off]) expect(run.answers.reduce((sum, answer) => sum + answer.quoteKeys, 0)).toBe(0);
  });

  it("G8: every answer whose citations were taken out has anchors and sources, without quotes, in SSE run.finish, each anchor inside the text", () => {
    const withChips = removed.answers.filter((answer) => answer.anchors > 0);
    const missing = withChips.filter((answer) => !Array.isArray(answer.sseFinish?.anchors) || !(answer.sseFinish!.anchors as unknown[]).length || !Array.isArray(answer.sseFinish?.sources) || !(answer.sseFinish!.sources as unknown[]).length);
    expect(missing.map((answer) => answer.id)).toEqual([]);
    expect(removed.answers.flatMap((answer) => answer.leaks)).toEqual([]);
    expect(tokens.answers.flatMap((answer) => answer.leaks)).toEqual([]);
    console.log(`G8: ${withChips.length} answers with chips; ${removed.answers.filter((answer) => answer.cites).length} answers cite`);
  });

  it("G9 and G10: every quote is cut from what the model was sent, and at least 215 sources have one", () => {
    expect(removed.answers.flatMap((answer) => answer.uncovered.map((key) => `${answer.id} ${key}`))).toEqual([]);
    const quotes = removed.answers.reduce((sum, answer) => sum + answer.quotes.length, 0);
    console.log(`G10: ${quotes} sources with a quote; ${removed.answers.reduce((sum, answer) => sum + answer.sources, 0)} sources; ${removed.answers.reduce((sum, answer) => sum + answer.anchors, 0)} anchors`);
    expect(quotes).toBeGreaterThanOrEqual(215);
  });

  it("CIT-17: with sources off, no citation event, empty anchors and sources, and no locator or quote anywhere; the text is that of remove", () => {
    expect(off.answers.reduce((sum, answer) => sum + answer.citationEvents + answer.anchors + answer.sources, 0)).toBe(0);
    expect(off.answers.flatMap((answer) => answer.leaks)).toEqual([]);
    expect(off.answers.map((answer) => answer.text)).toEqual(removed.answers.map((answer) => answer.text));
  });
});
