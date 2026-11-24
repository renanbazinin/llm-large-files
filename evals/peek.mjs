// What the Hebrew PDFs of the tests read as: format, pages, lines and the start of the text.
// REPO is a built checkout: this one unless set (run `npm run build` first). PDF_FIXTURES is the
// folder of the PDFs (REPO/test/fixtures/pdf unless set).
//   node evals/peek.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const REPO = process.env.REPO ?? fileURLToPath(new URL("..", import.meta.url));
const PDF_FIXTURES = process.env.PDF_FIXTURES ?? path.join(REPO, "test", "fixtures", "pdf");
const { createLargeFiles, MemoryDocumentStore } = await import(pathToFileURL(path.join(REPO, "dist", "index.js")).href);
const store = new MemoryDocumentStore(); const files = createLargeFiles({ store });
for (const name of ["chrome-hebrew-statement.pdf", "word-hebrew.pdf"]) {
  const bytes = new Uint8Array(await readFile(path.join(PDF_FIXTURES, name)));
  const doc = await files.ingest({ name, bytes });
  const text = await store.get(doc.id).then((d) => d.text);
  console.log("=====", name, doc.format, doc.pages, doc.lines, text.length);
  console.log(text.slice(0, 1500));
}
