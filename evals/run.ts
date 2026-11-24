// The evals, run by Vitest with vitest.evals.config.ts (npm run eval:replay, eval:record, eval:live,
// eval:recheck; evals/cli.mjs sets these variables from its options):
//
//   EVAL_MODE        "replay" (the default): every case from evals/cassettes, without the network
//                    or a key. A request that changed fails with "prompt changed: re-record", and
//                    a fact that held when recorded must hold again.
//                    "record": each case once against the Gemini API, written to its cassette.
//                    "live": each case EVAL_K times (3 by default) against the Gemini API: a case
//                    passes only when every run passes (pass^k).
//                    "recheck": a replay that writes each case's facts, checked again on the
//                    recorded answers, to its case.json: after a fact changed, with no request
//                    changed. It needs no key.
//                    "report": no run; the report of EVAL_RESULTS written again (with EVAL_TITLE and
//                    EVAL_NOTES_FILE, a Markdown file put under the title, when given).
//   EVAL_K           Runs of each case in live mode.
//   EVAL_MODELS      Comma-separated Gemini models. Defaults to gemini-3.5-flash-lite and
//                    gemini-3.8-flash; in a replay or a recheck, to every model with cassettes.
//   EVAL_CASES       Comma-separated case IDs: only those.
//   EVAL_RESULTS     A JSON file the runs are added to, with its report next to it (.md). Defaults to
//                    evals/results/<mode>.json for record and live, started afresh; a replay or a
//                    recheck writes none unless given one.
//   EVAL_TITLE       The title of the report.
//   EVAL_MAX_INPUT_TOKENS       The input tokens this run may use: no question starts past them.
//   EVAL_QUESTION_INPUT_TOKENS  A question that uses more is stopped. Defaults to 1,500,000.
//   GEMINI_API_KEY   For record and live. Never written: cassettes hold no key.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";
import { evalCases } from "./cases.js";
import { evalLibrary } from "./fixtures.js";
import { markdown, summarize, type Results } from "./lib/report.js";
import { runCase, type CaseRun, type RunMode } from "./lib/runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASSETTES = path.join(HERE, "cassettes");
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

const env = process.env;
const mode = (env.EVAL_MODE || "replay") as RunMode | "report" | "recheck";
if (!["replay", "record", "live", "report", "recheck"].includes(mode)) throw new Error(`EVAL_MODE must be replay, record, live, recheck or report, and is "${mode}".`);
/** A recheck is a replay that writes the facts it checked. */
const runMode: RunMode = mode === "recheck" ? "replay" : (mode as RunMode);
const apiKey = env.GEMINI_API_KEY;
if ((mode === "record" || mode === "live") && !apiKey) throw new Error(`The ${mode} mode calls the Gemini API: set GEMINI_API_KEY.`);
const k = mode === "live" ? Math.max(1, Number(env.EVAL_K) || 3) : 1;
const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const recordedModels = existsSync(CASSETTES) ? readdirSync(CASSETTES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
const models = mode === "report" ? [] : list(env.EVAL_MODELS).length ? list(env.EVAL_MODELS) : runMode === "replay" ? recordedModels : MODELS;
const resultsFile = env.EVAL_RESULTS ? path.resolve(env.EVAL_RESULTS) : runMode === "replay" ? undefined : path.join(HERE, "results", `${mode}.json`);
const cap = env.EVAL_MAX_INPUT_TOKENS ? { spent: 0, max: Number(env.EVAL_MAX_INPUT_TOKENS) } : undefined;
const questionInputTokens = env.EVAL_QUESTION_INPUT_TOKENS ? Number(env.EVAL_QUESTION_INPUT_TOKENS) : undefined;

// The files are ingested once, before the cases are collected: they name the facts.
const library = await evalLibrary();
const allCases = evalCases(library.facts);
const only = list(env.EVAL_CASES);
const unknown = only.filter((id) => !allCases.some((one) => one.id === id));
if (unknown.length) throw new Error(`No case ${unknown.join(", ")}. The cases are: ${allCases.map((one) => one.id).join(", ")}.`);
const cases = only.length ? allCases.filter((one) => only.includes(one.id)) : allCases;

/** The runs kept before this one, when the results file is added to (EVAL_RESULTS given). */
const earlier: Results | undefined = env.EVAL_RESULTS && resultsFile && existsSync(resultsFile) ? (JSON.parse(readFileSync(resultsFile, "utf8")) as Results) : undefined;
const runs: CaseRun[] = [];

const line = (run: CaseRun) => {
  const asked = run.questions.filter((question) => !question.error?.startsWith("not asked"));
  const sum = (pick: (question: (typeof asked)[number]) => number) => asked.reduce((total, question) => total + pick(question), 0);
  return `${run.passed ? "PASS" : "FAIL"} ${run.model} ${run.case} run ${run.run}: ${sum((question) => question.requests)} requests, ${sum((question) => question.inputTokens).toLocaleString("en-US")} input tokens, ${(sum((question) => question.ms) / 1000).toFixed(1)} s`;
};

if (mode === "report") {
  it("writes the report of EVAL_RESULTS", () => {
    if (!earlier) throw new Error("The report mode needs EVAL_RESULTS, a results file that exists.");
  });
} else if (models.length === 0) {
  it("has cassettes to replay", () => {
    throw new Error("evals/cassettes holds no recording: record them with npm run eval:record.");
  });
}

for (const model of models) {
  describe(model, () => {
    for (const evalCase of cases) {
      it.concurrent(evalCase.id, async () => {
        const before = earlier?.runs.filter((run) => run.model === model && run.case === evalCase.id).length ?? 0;
        for (let index = 1; index <= k; index++) {
          const run = await runCase({
            mode: runMode, evalCase, model, library, cassettes: CASSETTES, run: before + index,
            ...(apiKey ? { apiKey } : {}), ...(cap ? { cap } : {}), ...(questionInputTokens ? { questionInputTokens } : {}),
            ...(mode === "recheck" ? { rewriteFacts: true } : {}),
          });
          runs.push(run);
          // Written straight to the output: Vitest keeps a passing test's console to itself.
          if (runMode !== "replay") process.stdout.write(`${line(run)}\n`);
          if (run.replayProblems?.length) throw new Error(run.replayProblems.join("\n"));
        }
      });
    }
  });
}

afterAll(() => {
  const order = allCases.map((one) => one.id);
  if (runMode === "replay") {
    const summaries = summarize(runs, order);
    const failing = runs.filter((run) => run.replayProblems?.length);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `### Evals replayed\n\n${summaries.length} recordings of ${cases.length} cases on ${models.join(", ")}: ${failing.length ? `${failing.length} do not match` : "every one matches"}.\n\n${failing.map((run) => `- ${run.model}/${run.case}: ${run.replayProblems!.join(" ")}`).join("\n")}\n`);
    }
    if (!resultsFile) return;
  }
  if (!resultsFile) return;
  const notes = env.EVAL_NOTES_FILE ? readFileSync(env.EVAL_NOTES_FILE, "utf8").trimEnd().split("\n") : earlier?.notes ?? [];
  const results: Results = { title: env.EVAL_TITLE || earlier?.title || `Evals: ${mode}`, notes, runs: [...(earlier?.runs ?? []), ...runs.sort((left, right) => left.model.localeCompare(right.model) || order.indexOf(left.case) - order.indexOf(right.case) || left.run - right.run)] };
  mkdirSync(path.dirname(resultsFile), { recursive: true });
  writeFileSync(resultsFile, `${JSON.stringify(results, null, 1)}\n`);
  writeFileSync(resultsFile.replace(/\.json$/, "") + ".md", markdown(results, allCases));
  process.stdout.write(`Results: ${path.relative(process.cwd(), resultsFile)} and its .md\n`);
});
