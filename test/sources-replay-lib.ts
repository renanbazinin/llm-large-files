// The replay of the 112 recorded answers in one citationMarkers/sources mode, for the 0.99.14 gates
// (test/sources-replay-*.test.ts, one file per mode: a whole-file read replays its recording only
// once in a process). Follow-ups send modelText back, as the chatbot guide does.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { askWithFiles, type AskEvent, type ChatMessage, type CitationMarkers } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { replayOutputLimits } from "../evals/lib/runner.js";
import { sseMessageOf } from "llm-large-files/node";
import { replayFetch } from "../evals/lib/record.js";
import { evalLibrary } from "../evals/fixtures.js";
import { evalCases, SYSTEM } from "../evals/cases.js";

const CASSETTES = fileURLToPath(new URL("../evals/cassettes", import.meta.url));
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

/** Text as the coverage check compares it: no "N| " line prefixes, no "Row R: ", white space collapsed. */
const normalized = (text: string) => text.replace(/^\s*\d{1,9}\| ?/gmu, "").replace(/\s+/gu, " ").trim();

export type Answer = { id: string; misses: number; error?: string; cites: boolean; text: string; anchors: number; sources: number; quotes: string[]; uncovered: string[]; sseFinish?: Record<string, unknown>; quoteKeys: number; citationEvents: number; leaks: string[]; lineTalk?: string };

export async function replayAll(mode: { citationMarkers?: CitationMarkers; sources?: "on" | "off" }) {
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
      const endpoint = geminiApi({ apiKey: "replay", model });
      // Each recording with its own memory of output limits, as the eval runner gives it (0.99.15).
      const outputLimits = replayOutputLimits(folder, endpoint.url);
      const adapter = gemini(endpoint, { fetch: fetching, outputLimits });
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
          if (result.lineTalk) answer.lineTalk = result.lineTalk.verdict;
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

/** The sha256 of each shown text of "remove" (= showCitations: false), pinned by test/model-text.test.ts. */
export const SHOWN = JSON.parse(readFileSync(new URL("./fixtures/shown-0.99.14.json", import.meta.url), "utf8")) as Record<string, string>;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
