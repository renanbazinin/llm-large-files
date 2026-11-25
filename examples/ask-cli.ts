// Ask Gemini a question about a file larger than the model's window (up to 100 MB, the default
// upload limit), from the command line.
//
//   npm install
//   npm run build
//   GEMINI_API_KEY=... node examples/ask-cli.ts ./big.log "What failed first, and when?"
//
// Two more arguments are optional: the model, and a second model that searches and reads the
// file, so that the first only writes the answer.
//
//   ... node examples/ask-cli.ts ./big.log "What failed first?" gemini-3.8-flash gemini-3.5-flash-lite
//
// Runs on Node 22.18+ or 24 (built-in TypeScript type stripping).
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createLargeFiles, errorKindOf, MemoryDocumentStore, partialResultOf, type UsageTotals } from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";

const [file, question, model = "gemini-3.8-flash", explorerModel] = process.argv.slice(2);
const apiKey = process.env.GEMINI_API_KEY;
if (!file || !question || !apiKey) {
  console.error("Usage: GEMINI_API_KEY=... node examples/ask-cli.ts <file> \"<question>\" [model] [explorer model]");
  process.exit(1);
}

const used = (usage: UsageTotals) =>
  `${usage.requests} model request(s), ${usage.inputTokens.toLocaleString()} input tokens (${usage.cachedInputTokens.toLocaleString()} cached), ${usage.outputTokens.toLocaleString()} output tokens`;

try {
  // keepOriginals: for a PDF, the model can then look at the pages themselves (a chart, a photo, a scan).
  // One user, on this machine: no owner checks.
  const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], requireOwner: false });
  const meta = await files.ingest({ name: basename(file), bytes: await readFile(file) });
  console.error(`${meta.name}: ${meta.format}, ${meta.lines.toLocaleString()} lines, ~${meta.estimatedTokens.toLocaleString()} tokens\n`);

  const result = await askGemini({
    files,
    endpoint: geminiApi({ apiKey, model, explorerModel }),
    documentIds: [meta.id],
    messages: [{ role: "user", text: question }],
    onText: (delta) => process.stdout.write(delta),
    onStep: (step) => console.error(`  · ${step}`),
  });
  if (!result.answered) {
    console.error(`\nNo answer${result.blockReason ? ` (blocked: ${result.blockReason})` : ""}. Ask again, or ask more precisely.`);
    process.exitCode = 1;
  }
  console.error(`\n\n${result.plan.inline.length ? "Read in full" : "Searched with tools"} · ${result.turns} model turn(s) · ${used(result.usage)}`);
} catch (error) {
  // A file it cannot read, or a model request that failed for good. `kind` says which kind of failure.
  const kind = errorKindOf(error);
  console.error(`\n\nFailed${kind ? ` (${kind})` : ""}: ${error instanceof Error ? error.message : String(error)}`);
  const partial = partialResultOf(error);
  if (partial) console.error(`Before it failed: ${used(partial.usage)}`);
  process.exitCode = 1;
}
