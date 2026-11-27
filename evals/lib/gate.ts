// The gate of a live or recorded run of the evals: what fails it, and the facts lost against a
// baseline (evals/baseline/0.9.0.json). A replay has its own checks (runner.ts): a request that
// changed, a fact that held when recorded.
import type { EvalCase } from "../cases.js";
import type { CaseRun } from "./runner.js";

/** A fact that held in every baseline run of its model and case, and failed in a run now. */
export type LostFact = { model: string; case: string; question: number; fact: string; runs: number; of: number; detail?: string };

const keyOf = (model: string, id: string, question: number, fact: string) => [model, id, question, fact].join("\u0000");

/**
 * The facts lost against a baseline: each fact, by its words, that held in every baseline run of
 * its model and case where it was checked, and fails in some run now. A fact the baseline does not
 * have (a new one, or one whose words changed) is not compared.
 */
export function lostFacts(baseline: CaseRun[], now: CaseRun[]): LostFact[] {
  const held = new Map<string, boolean>();
  for (const run of baseline) {
    for (const question of run.questions) {
      for (const fact of question.facts) {
        if (fact.status === "not checked yet") continue;
        const key = keyOf(run.model, run.case, question.turn, fact.fact);
        held.set(key, (held.get(key) ?? true) && fact.status === "pass");
      }
    }
  }
  const runsOf = new Map<string, number>();
  for (const run of now) runsOf.set(`${run.model}\u0000${run.case}`, (runsOf.get(`${run.model}\u0000${run.case}`) ?? 0) + 1);
  const lost = new Map<string, LostFact>();
  for (const run of now) {
    for (const question of run.questions) {
      for (const fact of question.facts) {
        const key = keyOf(run.model, run.case, question.turn, fact.fact);
        if (fact.status !== "fail" || held.get(key) !== true) continue;
        const entry = lost.get(key) ?? { model: run.model, case: run.case, question: question.turn, fact: fact.fact, runs: 0, of: runsOf.get(`${run.model}\u0000${run.case}`) ?? 0 };
        entry.runs++;
        if (fact.detail) entry.detail = fact.detail;
        lost.set(key, entry);
      }
    }
  }
  return [...lost.values()];
}

/**
 * Why the runs of one case on one model fail the gate, or nothing: a question that ended with an
 * error or was not asked; pass^k missed by a case not known to fail on 0.9.0 (`failsOn090`), nor on
 * the runs' model (`failsOn`, 0.99.13); a fact lost against the baseline.
 */
export function gateProblems(evalCase: EvalCase, runs: CaseRun[], baseline: CaseRun[] = []): string[] {
  const problems: string[] = [];
  for (const run of runs) {
    for (const question of run.questions) {
      if (question.error) problems.push(`run ${run.run}, question ${question.turn}: ${question.error}`);
    }
  }
  const passed = runs.filter((run) => run.passed).length;
  const knownToFail = evalCase.failsOn090 !== undefined || (runs.length > 0 && runs.every((run) => evalCase.failsOn !== undefined && Object.hasOwn(evalCase.failsOn, run.model)));
  if (passed < runs.length && !knownToFail) {
    const failed = [...new Set(runs.flatMap((run) => run.questions.flatMap((question) => question.facts.filter((fact) => fact.status === "fail").map((fact) => `question ${question.turn}: ${fact.fact}`))))];
    problems.push(`pass^${runs.length} missed: ${passed} of ${runs.length} runs passed${failed.length ? ` (failed: ${failed.join("; ")})` : ""}.`);
  }
  for (const fact of lostFacts(baseline, runs)) {
    problems.push(`lost against the baseline: question ${fact.question}, "${fact.fact}" held in every baseline run and failed in ${fact.runs} of ${fact.of}${fact.detail ? ` (${fact.detail})` : ""}.`);
  }
  return problems;
}
