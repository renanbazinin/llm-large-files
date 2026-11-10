// Ask Gemini a question about a file of any size, from the command line.
//
//   npm run build
//   GEMINI_API_KEY=... node examples/ask-cli.ts ./big.log "What failed first, and when?"
//
// Runs on Node 22.18+ or 24 (built-in TypeScript type stripping).
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, geminiApi } from "llm-large-files/gemini";

const [file, question, model = "gemini-3.8-flash"] = process.argv.slice(2);
const apiKey = process.env.GEMINI_API_KEY;
if (!file || !question || !apiKey) {
  console.error("Usage: GEMINI_API_KEY=... node examples/ask-cli.ts <file> \"<question>\" [model]");
  process.exit(1);
}

// keepOriginals: for a PDF, the model can then look at the pages themselves (a chart, a photo, a scan).
const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
const meta = await files.ingest({ name: basename(file), bytes: await readFile(file) });
console.error(`${meta.name}: ${meta.format}, ${meta.lines.toLocaleString()} lines, ~${meta.estimatedTokens.toLocaleString()} tokens\n`);

const result = await askGemini({
  files,
  endpoint: geminiApi({ apiKey, model }),
  documentIds: [meta.id],
  messages: [{ role: "user", text: question }],
  onText: (delta) => process.stdout.write(delta),
  onStep: (step) => console.error(`  · ${step}`),
});
console.error(`\n\n${result.plan.inline.length ? "Read in full" : "Searched with tools"} · ${result.turns} model turn(s)`);
