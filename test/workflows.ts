// The workflows of .github/workflows, read as text, for the tests that check them
// (test/evals-record.test.ts, test/perf-budgets.test.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The jobs of a workflow, each as the text of its block. */
export function jobsOf(workflow: string): Record<string, string> {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const names = [...body.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)];
  return Object.fromEntries(names.map((match, index) => [match[1]!, body.slice(match.index, names[index + 1]?.index ?? body.length)]));
}
export const workflow = (name: string) => readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
/** The lines of a job that are not comments. */
export const code = (job: string) => job.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
