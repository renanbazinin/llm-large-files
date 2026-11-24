// The report of the evals: for each model and case, the pass rate over its runs and pass^k (every
// run passed), with requests, input tokens, the cached share, latency, the ceiling reached and the
// citations checked per answer. Written as JSON (every run, for the next gate to compare with) and
// as Markdown.
import type { EvalCase } from "../cases.js";
import type { CaseRun, QuestionRun } from "./runner.js";

/** A results file: what the runs were, and every run. */
export type Results = { title: string; notes: string[]; runs: CaseRun[] };

/** One model's one case over its runs. */
export type CaseSummary = {
  case: string;
  model: string;
  language: "he" | "en";
  kinds: string[];
  runs: number;
  passes: number;
  /** Every run passed (pass^k for k runs). */
  passAll: boolean;
  questions: number;
  requestsPerQuestion: number;
  inputTokensPerQuestion: number;
  /** Cached input tokens over input tokens, over all its questions. */
  cachedShare: number;
  /** The median time of a question. */
  medianMs: number;
  /** Questions whose ceiling was reached. */
  ceilingReached: number;
  /** Citations matched to a file and line, per answer; null while checkCitations is not available. */
  citationsPerAnswer: number | null;
  /** Answers with no citation recognized, of the answers; null while checkCitations is not available. */
  noCitationShare: number | null;
  wholeReads: number;
  /** Each fact that failed in some run: how many runs, and the detail of the last. */
  failed: Array<{ question: number; fact: string; runs: number; detail?: string; excerpt?: string }>;
  errors: string[];
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : 0);
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The summaries of the runs, by model then in the order of the cases. */
export function summarize(runs: CaseRun[], order: string[] = []): CaseSummary[] {
  const groups = new Map<string, CaseRun[]>();
  for (const run of runs) {
    const key = `${run.model}\u0000${run.case}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const position = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return [...groups.values()]
    .map((group): CaseSummary => {
      const first = group[0]!;
      const questions: QuestionRun[] = group.flatMap((run) => run.questions);
      const asked = questions.filter((question) => !question.error?.startsWith("not asked"));
      const checked = asked.filter((question) => question.citations !== null);
      const failed = new Map<string, CaseSummary["failed"][number]>();
      for (const question of asked) {
        for (const fact of question.facts) {
          if (fact.status !== "fail") continue;
          const key = `${question.turn}\u0000${fact.fact}`;
          const entry = failed.get(key) ?? { question: question.turn, fact: fact.fact, runs: 0 };
          entry.runs++;
          if (fact.detail) entry.detail = fact.detail;
          if (question.excerpt) entry.excerpt = question.excerpt;
          failed.set(key, entry);
        }
      }
      const input = sum(asked.map((question) => question.inputTokens));
      return {
        case: first.case,
        model: first.model,
        language: first.language,
        kinds: first.kinds,
        runs: group.length,
        passes: group.filter((run) => run.passed).length,
        passAll: group.every((run) => run.passed),
        questions: asked.length,
        requestsPerQuestion: mean(asked.map((question) => question.requests)),
        inputTokensPerQuestion: mean(asked.map((question) => question.inputTokens)),
        cachedShare: input ? sum(asked.map((question) => question.cachedInputTokens)) / input : 0,
        medianMs: median(asked.map((question) => question.ms)),
        ceilingReached: asked.filter((question) => question.ceilingReached).length,
        citationsPerAnswer: checked.length ? mean(checked.map((question) => question.citations!.checked)) : null,
        noCitationShare: checked.length ? checked.filter((question) => question.citations!.checked + question.citations!.unchecked === 0).length / checked.length : null,
        wholeReads: sum(asked.map((question) => question.wholeReads)),
        failed: [...failed.values()].sort((left, right) => left.question - right.question),
        errors: [...new Set(questions.flatMap((question) => (question.error ? [question.error] : [])))],
      };
    })
    .sort((left, right) => left.model.localeCompare(right.model) || position(left.case) - position(right.case));
}

const count = (value: number) => Math.round(value).toLocaleString("en-US");
const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The report as Markdown. `cases` gives each case's place and the reason it fails on 0.9.0, when known. */
export function markdown(results: Results, cases: EvalCase[]): string {
  const summaries = summarize(results.runs, cases.map((one) => one.id));
  const models = [...new Set(summaries.map((one) => one.model))];
  const lines: string[] = [`# ${results.title}`, "", ...results.notes.map((note) => `${note}`), ""];
  lines.push("## Totals", "");
  lines.push("| Model | Runs of each case | Cases passed in every run | Questions | Requests | Input tokens | Cached share | Median latency of a question | Ceiling reached | Citations checked per answer |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const model of models) {
    const own = summaries.filter((one) => one.model === model);
    const runs = results.runs.filter((run) => run.model === model);
    const questions = runs.flatMap((run) => run.questions).filter((question) => !question.error?.startsWith("not asked"));
    const input = sum(questions.map((question) => question.inputTokens));
    const checked = questions.filter((question) => question.citations !== null);
    const k = [...new Set(own.map((one) => one.runs))].join(", ");
    lines.push(`| ${model} | ${k} | ${own.filter((one) => one.passAll).length} of ${own.length} | ${questions.length} | ${count(sum(questions.map((question) => question.requests)))} | ${count(input)} | ${percent(input ? sum(questions.map((question) => question.cachedInputTokens)) / input : 0)} | ${seconds(median(questions.map((question) => question.ms)))} | ${questions.filter((question) => question.ceilingReached).length} | ${checked.length ? mean(checked.map((question) => question.citations!.checked)).toFixed(1) : "not checked yet"} |`);
  }
  for (const model of models) {
    lines.push("", `## ${model}`, "");
    lines.push("| Case | Language | Kinds | Passed | Requests per question | Input tokens per question | Cached share | Median latency | Ceiling reached | Whole reads | Citations per answer | Answers with no citation |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const one of summaries.filter((summary) => summary.model === model)) {
      lines.push(`| ${one.case} | ${one.language} | ${one.kinds.join(", ")} | ${one.passes} of ${one.runs}${one.passAll ? "" : " ✗"} | ${one.requestsPerQuestion.toFixed(1)} | ${count(one.inputTokensPerQuestion)} | ${percent(one.cachedShare)} | ${seconds(one.medianMs)} | ${one.ceilingReached} | ${one.wholeReads} | ${one.citationsPerAnswer === null ? "not checked yet" : one.citationsPerAnswer.toFixed(1)} | ${one.noCitationShare === null ? "not checked yet" : percent(one.noCitationShare)} |`);
    }
    const failing = summaries.filter((summary) => summary.model === model && (summary.failed.length || summary.errors.length));
    if (failing.length) {
      lines.push("", `### What failed on ${model}`, "");
      for (const one of failing) {
        for (const fact of one.failed) {
          lines.push(`- **${one.case}**, question ${fact.question}: ${cell(fact.fact)}, in ${fact.runs} of ${one.runs} runs${fact.detail ? ` (${cell(fact.detail)})` : ""}.${fact.excerpt ? ` The answer began: “${cell(fact.excerpt.slice(0, 200))}”` : ""}`);
        }
        for (const error of one.errors) lines.push(`- **${one.case}**: ${cell(error)}`);
      }
    }
  }
  const known = cases.filter((one) => one.failsOn090);
  if (known.length) {
    lines.push("", "## Why cases fail on 0.9.0", "");
    for (const one of known) lines.push(`- **${one.id}**: ${one.failsOn090}`);
  }
  return `${lines.join("\n")}\n`;
}
