// Records what a version of llm-large-files stores, for test/stored-shapes.test.ts (H7): the files
// FileDocumentStore writes for a log that is searched and a note sent whole, and the toolTurns of a
// question that searched and read the log. Run it with a build of that version:
//
//   npm i --prefix /tmp/llf-old llf090@npm:llm-large-files@0.9.0
//   node scripts/record-stored-shapes.mjs /tmp/llf-old/node_modules/llf090/dist/index.js test/fixtures/stored/0.9.0 0.9.0
//
// A version that is not on npm: `git archive v0.10.2 | tar -x -C /tmp/v0102`, then `npm ci` and
// `npm run build` there, and pass /tmp/v0102/dist/index.js. Versions before 0.9.0 take no `id` and
// no `scope`: their documents get the IDs the library makes, and an owner alone.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, outDir, version] = process.argv.slice(2);
if (!modulePath || !outDir || !version) throw new Error("Usage: node scripts/record-stored-shapes.mjs <dist/index.js of the version> <out folder> <version>");
const { askWithFiles, createLargeFiles, FileDocumentStore } = await import(pathToFileURL(path.resolve(modulePath)).href);
const before09 = /^0\.[0-8]\./.test(version);

const CLOCK = () => new Date("2026-11-20T08:00:00.000Z");
const utf8 = (text) => new TextEncoder().encode(text);
const LOG = `${Array.from({ length: 40 }, (_, i) => {
  const n = i + 1;
  const error = n % 10 === 7;
  return `2026-11-19 12:00:${String(n).padStart(2, "0")} ${error ? "ERROR" : "INFO"} ${error ? `payment worker failed for order ${1000 + n}` : `request ${n} ok`}`;
}).join("\n")}\n`;
const NOTE = "# Notes\n\nThe code word is heron.\nDeploy on Friday.\n";
const access = before09 ? { owner: "user-1" } : { owner: "user-1", scope: ["user-1", "chat-1"] };

const folder = await mkdtemp(path.join(tmpdir(), "llf-record-"));
try {
  const files = createLargeFiles({ store: new FileDocumentStore(folder, { now: CLOCK }), now: CLOCK, budget: { inlineTokens: 200 } });
  const upload = (name, text, id, extra = {}) => files.ingest({ name, bytes: utf8(text), ...access, ...(before09 ? {} : { id, ...extra }) });
  const log = await upload("app.log", LOG, "log-1");
  // appData is new in 0.10.2.
  const note = await upload("notes.md", NOTE, "notes-1", /^0\.(9|10\.[01])\./.test(version) ? {} : { appData: { rowId: "42" } });
  let turn = 0;
  const model = {
    id: "fake-model",
    capabilities: { contextTokens: 1_000_000, toolFiles: "none", pageTokens: 258 },
    async send() {
      turn++;
      if (turn === 1) return { text: "", calls: [{ id: "c1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact", max_results: 3 } }] };
      if (turn === 2) return { text: "", calls: [{ id: "c2", name: "read_document", args: { document_id: log.id, start_line: 7, end_line: 8 } }] };
      return { text: "4 errors; the first at line 7.", calls: [] };
    },
  };
  const result = await askWithFiles({ files, model, documentIds: [log.id, note.id], messages: [{ role: "user", text: "How many errors?" }], ...access });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "store"), { recursive: true });
  // The store's files as they were written, byte for byte.
  for (const name of await readdir(folder)) await writeFile(path.join(outDir, "store", name), await readFile(path.join(folder, name)));
  await writeFile(path.join(outDir, "tool-turns.json"), `${JSON.stringify(result.toolTurns, null, 2)}\n`);
  await writeFile(path.join(outDir, "fixture.json"), `${JSON.stringify({ version, log: log.id, note: note.id, access, answer: result.text }, null, 2)}\n`);
} finally {
  await rm(folder, { recursive: true, force: true });
}
