// The report of the evals: for each model and case, the pass rate over its runs and pass^k (every
// run passed), with requests (mean and median), reads and whole reads, input tokens, the cached
// share, latency, the ceiling reached and the citations checked per answer; the release gates of
// the plan, figured for each model; and the facts lost against the baseline. Written as JSON (every
// run with its answers, for the next gate to compare with) and as Markdown.
import type { EvalCase } from "../cases.js";
import type { LostFact } from "./gate.js";
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
  /** The median requests of a question, and the share of questions answered in one request. */
  medianRequests: number;
  oneRequestShare: number;
  /** read_document calls per question. */
  readsPerQuestion: number;
  inputTokensPerQuestion: number;
  /** Cached input tokens over input tokens, over all its questions. */
  cachedShare: number;
  /** The median time of a question. */
  medianMs: number;
  /** Questions whose ceiling was reached. */
  ceilingReached: number;
  /** Citations matched to a file and line, per answer; null for runs of 0.9.0, which had no checkCitations. */
  citationsPerAnswer: number | null;
  /** Answers with no citation recognized, of the answers; null for runs of 0.9.0, which had no checkCitations. */
  noCitationShare: number | null;
  /** Citations inside what the tools showed, of those checked; null while none is checked. */
  supportedShare: number | null;
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

/** read_document calls of a question (older results count them from its tools). */
const readsOf = (question: QuestionRun) => question.reads ?? question.tools.filter((tool) => tool === "read_document").length;

/** Citations inside what the tools showed, of those checked, over these questions; null while none is checked. */
function supportedOf(questions: QuestionRun[]): number | null {
  const checked = sum(questions.map((question) => question.citations?.checked ?? 0));
  return checked ? sum(questions.map((question) => question.citations?.supported ?? 0)) / checked : null;
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
        medianRequests: median(asked.map((question) => question.requests)),
        oneRequestShare: asked.length ? asked.filter((question) => question.requests === 1).length / asked.length : 0,
        readsPerQuestion: mean(asked.map(readsOf)),
        inputTokensPerQuestion: mean(asked.map((question) => question.inputTokens)),
        cachedShare: input ? sum(asked.map((question) => question.cachedInputTokens)) / input : 0,
        medianMs: median(asked.map((question) => question.ms)),
        ceilingReached: asked.filter((question) => question.ceilingReached).length,
        citationsPerAnswer: checked.length ? mean(checked.map((question) => question.citations!.checked)) : null,
        noCitationShare: checked.length ? checked.filter((question) => question.citations!.checked + question.citations!.unchecked === 0).length / checked.length : null,
        supportedShare: supportedOf(checked),
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

/** One gate of the plan: its figure for a model, the bar, and whether it is met. */
export type Gate = { name: string; figure: string; bar: string; met: boolean | null };

/** The questions of these runs that were asked. */
const askedIn = (runs: CaseRun[]) => runs.flatMap((run) => run.questions.filter((question) => !question.error?.startsWith("not asked")).map((question) => ({ run, question })));

/**
 * The release gates of the plan, figured over one model's runs: counts 100%; Hebrew lookups at
 * least 90%; Hebrew answers in Hebrew in every run; citations at least 90% supported and at most 10%
 * of answers with none; P1's inline tables (no-count questions in one request in at least 90% of
 * runs, count questions at most 3 requests at the median); no fact lost against the baseline. A
 * gate with nothing to figure yet (no citation checked) is null.
 */
export function gatesOf(runs: CaseRun[], lost: LostFact[] = []): Gate[] {
  const share = (part: number, whole: number) => (whole ? part / whole : 0);
  const kinds = (run: CaseRun, ...wanted: string[]) => wanted.every((kind) => run.kinds.includes(kind as never));
  const counts = askedIn(runs.filter((run) => kinds(run, "count")));
  const hebrewLookups = askedIn(runs.filter((run) => run.language === "he" && kinds(run, "lookup")));
  const language = runs.flatMap((run) => run.questions.flatMap((question) => question.facts.filter((fact) => fact.fact === "answers in Hebrew")));
  const asked = askedIn(runs).map(({ question }) => question);
  const checked = asked.filter((question) => question.citations !== null);
  const supported = supportedOf(checked);
  const noCitation = checked.length ? share(checked.filter((question) => question.citations!.checked + question.citations!.unchecked === 0).length, checked.length) : null;
  const inlineNoCount = askedIn(runs.filter((run) => kinds(run, "inline-table") && !kinds(run, "count")));
  const inlineCount = askedIn(runs.filter((run) => kinds(run, "inline-table", "count")));
  const oneRequest = share(inlineNoCount.filter(({ question }) => question.requests === 1).length, inlineNoCount.length);
  const countMedian = median(inlineCount.map(({ question }) => question.requests));
  const passedShare = (list: Array<{ question: QuestionRun }>) => share(list.filter(({ question }) => question.passed).length, list.length);
  /** A share and its counts, or "none" when nothing is counted. */
  const shareOf = (part: number, whole: number) => (whole ? `${percent(share(part, whole))} (${part} of ${whole})` : "none");
  return [
    { name: "Count questions answered right", figure: shareOf(counts.filter(({ question }) => question.passed).length, counts.length), bar: "100%", met: counts.length ? passedShare(counts) === 1 : null },
    { name: "Hebrew lookups answered right", figure: shareOf(hebrewLookups.filter(({ question }) => question.passed).length, hebrewLookups.length), bar: "at least 90%", met: hebrewLookups.length ? passedShare(hebrewLookups) >= 0.9 : null },
    { name: "Hebrew questions answered in Hebrew", figure: language.length ? `${language.filter((fact) => fact.status === "pass").length} of ${language.length}` : "none", bar: "every run", met: language.length ? language.every((fact) => fact.status === "pass") : null },
    { name: "Citations inside what the tools showed", figure: supported === null ? "not checked yet" : percent(supported), bar: "at least 90%", met: supported === null ? null : supported >= 0.9 },
    { name: "Answers with no citation recognized", figure: noCitation === null ? "not checked yet" : percent(noCitation), bar: "at most 10%", met: noCitation === null ? null : noCitation <= 0.1 },
    { name: "Inline-table questions with no count, in one request", figure: shareOf(inlineNoCount.filter(({ question }) => question.requests === 1).length, inlineNoCount.length), bar: "at least 90%", met: inlineNoCount.length ? oneRequest >= 0.9 : null },
    { name: "Inline-table count questions, requests at the median", figure: inlineCount.length ? String(countMedian) : "none", bar: "at most 3", met: inlineCount.length ? countMedian <= 3 : null },
    { name: "Facts lost against the baseline", figure: String(lost.length), bar: "none", met: lost.length === 0 },
  ];
}

/**
 * The report as Markdown. `cases` gives each case's place and the reason it fails on 0.9.0, when
 * known. `lost`: the facts lost against the baseline, when the runs were compared with one.
 */
export function markdown(results: Results, cases: EvalCase[], lost?: LostFact[]): string {
  const summaries = summarize(results.runs, cases.map((one) => one.id));
  const models = [...new Set(summaries.map((one) => one.model))];
  const lines: string[] = [`# ${results.title}`, "", ...results.notes.map((note) => `${note}`), ""];
  lines.push("## Totals", "");
  lines.push("| Model | Runs of each case | Cases passed in every run | Questions | Requests | Requests per question (median) | Input tokens | Cached share | Median latency of a question | Ceiling reached | Citations checked per answer |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const model of models) {
    const own = summaries.filter((one) => one.model === model);
    const runs = results.runs.filter((run) => run.model === model);
    const questions = askedIn(runs).map(({ question }) => question);
    const input = sum(questions.map((question) => question.inputTokens));
    const checked = questions.filter((question) => question.citations !== null);
    const k = [...new Set(own.map((one) => one.runs))].join(", ");
    lines.push(`| ${model} | ${k} | ${own.filter((one) => one.passAll).length} of ${own.length} | ${questions.length} | ${count(sum(questions.map((question) => question.requests)))} | ${median(questions.map((question) => question.requests))} | ${count(input)} | ${percent(input ? sum(questions.map((question) => question.cachedInputTokens)) / input : 0)} | ${seconds(median(questions.map((question) => question.ms)))} | ${questions.filter((question) => question.ceilingReached).length} | ${checked.length ? mean(checked.map((question) => question.citations!.checked)).toFixed(1) : "not checked yet"} |`);
  }
  lines.push("", "## Gates", "", "The gates of the plan, figured for each model. A gate with nothing to figure yet says so.", "");
  lines.push(`| Gate | Bar | ${models.join(" | ")} |`);
  lines.push(`| --- | --- | ${models.map(() => "---").join(" | ")} |`);
  const gates = models.map((model) => gatesOf(results.runs.filter((run) => run.model === model), (lost ?? []).filter((fact) => fact.model === model)));
  for (const [index, gate] of (gates[0] ?? []).entries()) {
    if (gate.name === "Facts lost against the baseline" && !lost) continue;
    lines.push(`| ${gate.name} | ${gate.bar} | ${gates.map((own) => `${own[index]!.figure}${own[index]!.met === false ? " ✗" : ""}`).join(" | ")} |`);
  }
  if (lost?.length) {
    lines.push("", "### Facts lost against the baseline", "");
    for (const fact of lost) lines.push(`- **${fact.model}/${fact.case}**, question ${fact.question}: ${cell(fact.fact)}, in ${fact.runs} of ${fact.of} runs${fact.detail ? ` (${cell(fact.detail)})` : ""}.`);
  }
  for (const model of models) {
    lines.push("", `## ${model}`, "");
    lines.push("| Case | Language | Kinds | Passed | Requests per question (mean, median) | Answered in one request | Reads per question | Whole reads | Input tokens per question | Cached share | Median latency | Ceiling reached | Citations per answer | Answers with no citation |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const one of summaries.filter((summary) => summary.model === model)) {
      lines.push(`| ${one.case} | ${one.language} | ${one.kinds.join(", ")} | ${one.passes} of ${one.runs}${one.passAll ? "" : " ✗"} | ${one.requestsPerQuestion.toFixed(1)}, ${one.medianRequests} | ${percent(one.oneRequestShare)} | ${one.readsPerQuestion.toFixed(1)} | ${one.wholeReads} | ${count(one.inputTokensPerQuestion)} | ${percent(one.cachedShare)} | ${seconds(one.medianMs)} | ${one.ceilingReached} | ${one.citationsPerAnswer === null ? "not checked yet" : one.citationsPerAnswer.toFixed(1)} | ${one.noCitationShare === null ? "not checked yet" : percent(one.noCitationShare)} |`);
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
  const knownOnModel = cases.filter((one) => one.failsOn && Object.keys(one.failsOn).length);
  if (knownOnModel.length) {
    lines.push("", "## Known to fail on a model", "");
    for (const one of knownOnModel) for (const [model, why] of Object.entries(one.failsOn!)) lines.push(`- **${one.id}** on ${model}: ${why}`);
  }
  return `${lines.join("\n")}\n`;
}
