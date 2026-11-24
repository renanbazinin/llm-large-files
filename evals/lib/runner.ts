// Runs one case of the evals once: live, recorded to its cassette, or replayed from it. The
// question goes through askWithFiles with a gemini() model over the Gemini API, as the chatbot asks
// it: the answer streamed, the chat's earlier questions with their tool rounds and answers.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askWithFiles, type AskResult, type ChatMessage, type CitationCheck } from "../../src/index.js";
import { gemini, geminiApi } from "../../src/gemini/index.js";
import { SYSTEM, type CaseKind, type EvalCase } from "../cases.js";
import type { EvalLibrary } from "../fixtures.js";
import { checkFact, citationsOf, describeFact, type FactContext, type FactResult } from "./facts.js";
import { recordingFetch, replayFetch, runRecorder, type RequestRecord } from "./record.js";

export type RunMode = "record" | "replay" | "live";

/** One question of a run, as the report counts it. */
export type QuestionRun = {
  turn: number;
  answered: boolean;
  /** The question ended with an error, or was not asked (the run's cap, an earlier error). */
  error?: string;
  facts: FactResult[];
  /** Every fact that could be checked holds, and no error. */
  passed: boolean;
  /** Requests answered (`usage.requests`), and the tokens the provider reported. */
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  /** From the question to its answer. In a replay: as recorded. */
  ms: number;
  /** A `budget_reached` notice: the question's input-token ceiling or request limit stopped its tools. */
  ceilingReached: boolean;
  /** `checkCitations` of the answer; null in runs of 0.9.0, which had no checkCitations. */
  citations: CitationCheck | null;
  /** The tools called, in order, and how many line reads (read_document) and whole-file reads. */
  tools: string[];
  reads?: number;
  wholeReads: number;
  /** The requests of the question as its events told them. */
  log: RequestRecord[];
  /** The start of the answer, kept when a fact failed: what the report says the answer was. */
  excerpt?: string;
  /** The answer, so its facts can be checked again once a fact is fixed (the files are synthetic). */
  answer?: string;
};

/** One run of a case. */
export type CaseRun = {
  case: string;
  model: string;
  mode: RunMode;
  run: number;
  language: "he" | "en";
  kinds: CaseKind[];
  questions: QuestionRun[];
  /** Every question passed. */
  passed: boolean;
  /** Replay only: why the replay does not match its recording (a changed prompt, a fact lost), else nothing. */
  replayProblems?: string[];
};

/** What a recording keeps of its run besides the requests: what the replay compares its facts with. */
type CaseFile = Omit<CaseRun, "mode" | "run" | "replayProblems">;

export type RunCaseOptions = {
  mode: RunMode;
  evalCase: EvalCase;
  /** The Gemini model: "gemini-3.5-flash-lite". */
  model: string;
  library: EvalLibrary;
  /** The folder of the cassettes: a case's is `<cassettes>/<model>/<case>`. */
  cassettes: string;
  /** For record and live. A replay sends no key. */
  apiKey?: string;
  /**
   * Replay only: when every request matched, write the replay's facts and answers to the case's
   * case.json, in place of the recorded ones (`npm run eval:recheck`, after a fact changed). The
   * requests and the recorded times stay.
   */
  rewriteFacts?: boolean;
  /** The fetch that reaches the provider, for record and live. Defaults to the global one. */
  fetch?: typeof fetch;
  /** Which run of the case this is, from 1. */
  run?: number;
  /** A question that has used more input tokens than this is stopped. Defaults to 1,500,000. */
  questionInputTokens?: number;
  /** The input tokens the whole run may use: once `spent` reaches `max`, no more questions start. */
  cap?: { spent: number; max: number };
};

export const cassetteFolder = (cassettes: string, model: string, id: string) => path.join(cassettes, model, id);

const empty = (turn: number, error: string): QuestionRun => ({
  turn, answered: false, error, facts: [], passed: false, requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtTokens: 0,
  ms: 0, ceilingReached: false, citations: null, tools: [], reads: 0, wholeReads: 0, log: [],
});

/** Runs the questions of a case in order, once. */
export async function runCase(options: RunCaseOptions): Promise<CaseRun> {
  const { mode, evalCase, model, library } = options;
  const folder = cassetteFolder(options.cassettes, model, evalCase.id);
  const caseFile = path.join(folder, "case.json");
  let fetchImpl: typeof fetch;
  let replay: ReturnType<typeof replayFetch> | undefined;
  let recorded: CaseFile | undefined;
  if (mode === "replay") {
    if (!existsSync(caseFile)) {
      return { case: evalCase.id, model, mode, run: options.run ?? 1, language: evalCase.language, kinds: evalCase.kinds, questions: [], passed: false, replayProblems: [`not recorded: ${path.relative(process.cwd(), folder)} has no case.json. Record it with npm run eval:record.`] };
    }
    recorded = JSON.parse(readFileSync(caseFile, "utf8")) as CaseFile;
    fetchImpl = replay = replayFetch(folder, { label: `${model}/${evalCase.id}` });
  } else if (mode === "record") {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    fetchImpl = recordingFetch(folder, { fetch: options.fetch ?? globalThis.fetch });
  } else {
    fetchImpl = options.fetch ?? globalThis.fetch;
  }
  const adapter = gemini(geminiApi({ apiKey: options.apiKey ?? "replay", model }), { fetch: fetchImpl });
  const context: Omit<FactContext, "evidence"> = { names: library.names, formats: library.formats, linesWith: library.linesWith };

  const messages: ChatMessage[] = [];
  const questions: QuestionRun[] = [];
  let stopped: string | undefined;
  for (const [index, turn] of evalCase.turns.entries()) {
    const number = index + 1;
    if (stopped) {
      questions.push(empty(number, stopped));
      continue;
    }
    if (options.cap && options.cap.spent >= options.cap.max) {
      stopped = `not asked: the run reached its cap of ${options.cap.max.toLocaleString("en-US")} input tokens`;
      questions.push(empty(number, stopped));
      continue;
    }
    messages.push({ role: "user", text: turn.question });
    const recorder = runRecorder();
    const guard = new AbortController();
    const most = options.questionInputTokens ?? 1_500_000;
    let spent = 0;
    const listener: typeof recorder.listener = (event) => {
      recorder.listener(event);
      if (event.type !== "request.end") return;
      const used = event.usage?.inputTokens ?? 0;
      spent += used;
      if (options.cap) options.cap.spent += used;
      if (spent > most && !guard.signal.aborted) guard.abort(new Error(`The eval stopped the question: it used ${spent.toLocaleString("en-US")} input tokens, over its ${most.toLocaleString("en-US")}.`));
    };
    const began = Date.now();
    let result: AskResult | undefined;
    let error: string | undefined;
    try {
      result = await askWithFiles({
        files: library.files,
        model: adapter,
        documentIds: turn.documentIds,
        messages: [...messages],
        system: SYSTEM,
        ...(evalCase.budget ? { budget: evalCase.budget } : {}),
        ...(evalCase.limits ? { limits: evalCase.limits } : {}),
        ...(evalCase.onMissingDocuments ? { onMissingDocuments: evalCase.onMissingDocuments } : {}),
        // Streamed, as the chatbot shows answers.
        streamText: true,
        onEvent: listener,
        signal: guard.signal,
        // A replay waits for no retry: the recorded failures come back at once.
        ...(mode === "replay" ? { retry: { sleep: async () => {} } } : {}),
      });
    } catch (thrown) {
      error = replay?.misses[0]?.message ?? (guard.signal.aborted ? String((guard.signal.reason as Error).message) : thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown));
    }
    const ms = Date.now() - began;
    const log = recorder.requests();
    if (!result) {
      questions.push({ ...empty(number, error ?? "no result"), log, ms, tools: recorder.tools().map((call) => call.tool) });
      stopped = `not asked: question ${number} ended with an error`;
      continue;
    }
    messages.push(...result.toolTurns);
    if (result.answered) messages.push({ role: "assistant", text: result.text });
    const factContext: FactContext = { ...context, evidence: result.evidence, documentIds: turn.documentIds, ...(result.citations ? { citations: result.citations } : {}) };
    const facts = turn.facts.map((fact) => checkFact(fact, result.text, factContext));
    const passed = facts.every((fact) => fact.status !== "fail");
    const tools = recorder.tools().map((call) => call.tool);
    questions.push({
      turn: number,
      answered: result.answered,
      facts,
      passed,
      requests: result.usage.requests,
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      thoughtTokens: result.usage.thoughtTokens,
      ms,
      ceilingReached: recorder.notices().includes("budget_reached"),
      citations: citationsOf(result.text, factContext) ?? null,
      tools,
      reads: tools.filter((tool) => tool === "read_document").length,
      wholeReads: tools.filter((tool) => tool === "analyze_whole_document").length,
      log,
      ...(passed ? {} : { excerpt: result.text.trim().slice(0, 400) }),
      answer: result.text,
    });
  }

  const run: CaseRun = {
    case: evalCase.id, model, mode, run: options.run ?? 1, language: evalCase.language, kinds: evalCase.kinds,
    questions, passed: questions.length > 0 && questions.every((question) => question.passed),
  };
  if (mode === "record") {
    const kept: CaseFile = { case: run.case, model, language: run.language, kinds: run.kinds, questions: run.questions, passed: run.passed };
    writeFileSync(caseFile, `${JSON.stringify(kept, null, 1)}\n`);
  }
  if (mode === "replay" && recorded && replay) {
    // Latency is the recording's: a replay takes no time.
    for (const question of run.questions) {
      const before = recorded.questions[question.turn - 1];
      question.ms = before?.ms ?? 0;
      if (before) question.log = before.log;
    }
    if (options.rewriteFacts && !replay.misses.length && !replay.unused().length) {
      const kept: CaseFile = { ...recorded, questions: run.questions, passed: run.passed };
      writeFileSync(caseFile, `${JSON.stringify(kept, null, 1)}\n`);
      recorded = kept;
    }
    run.replayProblems = compare(recorded, run, replay, evalCase);
  }
  return run;
}

/** Checks the facts of a run again on its answers, with the facts of `evalCase` as they are now. A cited-line fact keeps its status: its evidence is not kept. */
export function recheckRun(run: CaseRun, evalCase: EvalCase, context: Omit<FactContext, "evidence">): CaseRun {
  const questions = run.questions.map((question) => {
    const turn = evalCase.turns[question.turn - 1];
    if (!turn || question.answer === undefined || question.error) return question;
    const facts = turn.facts.map((fact): FactResult => {
      if ("mustCite" in fact) return question.facts.find((kept) => kept.fact === describeFact(fact)) ?? { fact: describeFact(fact), status: "not checked yet" };
      return checkFact(fact, question.answer!, { ...context, evidence: [] });
    });
    const passed = facts.every((fact) => fact.status !== "fail");
    return { ...question, facts, passed, ...(passed ? {} : { excerpt: question.answer.trim().slice(0, 400) }) };
  });
  return { ...run, questions, passed: questions.length > 0 && questions.every((question) => question.passed) };
}

/**
 * What differs between a replay and its recording: a request that missed, recordings left over, a
 * fact that held and no longer does, facts that changed since the recording, and a case of kind
 * "whole-read" whose recording made no whole read.
 */
function compare(recorded: CaseFile, run: CaseRun, replay: ReturnType<typeof replayFetch>, evalCase: EvalCase): string[] {
  const problems: string[] = [];
  if (evalCase.kinds.includes("whole-read") && (evalCase.wholeReadOn ?? [run.model]).includes(run.model)) {
    const parts = recorded.questions.reduce((total, question) => total + question.log.filter((request) => request.purpose === "part").length, 0);
    const wholeReads = recorded.questions.reduce((total, question) => total + question.wholeReads, 0);
    if (!wholeReads || !parts) problems.push(`no whole read: case "${run.model}/${run.case}" is of kind "whole-read", and its recording holds ${wholeReads} whole reads and ${parts} part reads. Record it again, or change the case so that it needs a whole read.`);
  }
  if (replay.misses[0]) problems.push(replay.misses[0].message);
  const unused = replay.unused();
  if (!replay.misses.length && unused.length) problems.push(`requests changed: re-record. Case "${run.model}/${run.case}": the replay made fewer requests than were recorded (recordings ${unused.join(", ")} were not asked for).`);
  for (const [index, before] of recorded.questions.entries()) {
    const now = run.questions[index];
    if (!now) {
      problems.push(`question ${index + 1} was not asked`);
      continue;
    }
    if (before.error === undefined && now.error !== undefined && !replay.misses.length) problems.push(`question ${index + 1} ended with an error it did not have when recorded: ${now.error}`);
    const words = (facts: FactResult[]) => facts.map((fact) => fact.fact).join("\n");
    if (now.error === undefined && before.error === undefined && words(before.facts) !== words(now.facts)) {
      problems.push(`facts changed: question ${index + 1} of case "${run.model}/${run.case}" has other facts than when it was recorded. Check them on the recorded answers with npm run eval:recheck (see CONTRIBUTING.md).`);
      continue;
    }
    for (const [at, fact] of before.facts.entries()) {
      if (fact.status === "pass" && now.facts[at]?.status === "fail") problems.push(`question ${index + 1}: the fact "${fact.fact}" held when recorded and does not now (${now.facts[at]!.detail ?? ""})`);
    }
  }
  return problems;
}
