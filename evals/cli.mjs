// npm run eval:replay | eval:record | eval:live | eval:recheck [-- options], or
// node evals/cli.mjs report --results file.json: runs evals/run.ts under Vitest with
// vitest.evals.config.ts, the options turned into the variables run.ts reads.
//
//   --k 3                      runs of each case (live)
//   --models a,b               Gemini models
//   --cases id,id              only these cases
//   --results file.json        add the runs to this results file, and write its report beside it
//   --title "..."              the report's title
//   --notes notes.md           Markdown put under the report's title
//   --max-input-tokens N       the input tokens the run may use
//   --question-input-tokens N  a question that uses more is stopped
//   --concurrency N            cases run at once
//
// Record and live read GEMINI_API_KEY from the environment.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPTIONS = {
  "--k": "EVAL_K",
  "--models": "EVAL_MODELS",
  "--cases": "EVAL_CASES",
  "--results": "EVAL_RESULTS",
  "--title": "EVAL_TITLE",
  "--notes": "EVAL_NOTES_FILE",
  "--max-input-tokens": "EVAL_MAX_INPUT_TOKENS",
  "--question-input-tokens": "EVAL_QUESTION_INPUT_TOKENS",
  "--concurrency": "EVAL_CONCURRENCY",
};

const [mode, ...rest] = process.argv.slice(2);
if (!["replay", "record", "live", "recheck", "report"].includes(mode ?? "")) {
  console.error(`Usage: node evals/cli.mjs replay|record|live|recheck|report [options]. The options are: ${Object.keys(OPTIONS).join(", ")}.`);
  process.exit(2);
}
const env = { ...process.env, EVAL_MODE: mode };
for (let index = 0; index < rest.length; index++) {
  const [flag, inline] = rest[index].split(/=(.*)/s, 2);
  const name = OPTIONS[flag];
  if (!name) {
    console.error(`Unknown option ${flag}. The options are: ${Object.keys(OPTIONS).join(", ")}.`);
    process.exit(2);
  }
  const value = inline ?? rest[++index];
  if (value === undefined) {
    console.error(`${flag} needs a value.`);
    process.exit(2);
  }
  env[name] = value;
}
if ((mode === "record" || mode === "live") && !env.GEMINI_API_KEY) {
  console.error(`The ${mode} mode calls the Gemini API: set GEMINI_API_KEY in the environment.`);
  process.exit(2);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const child = spawn(process.execPath, [vitest, "run", "--config", path.join(root, "vitest.evals.config.ts")], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
