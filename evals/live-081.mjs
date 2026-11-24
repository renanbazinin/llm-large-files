// Live check of 0.8.1 (aggregate_table, table headers on hits, format from bytes) against the Gemini API.
// Reads GEMINI_API_KEY from the environment. REPO is a built checkout: this one unless set (run
// `npm run build` first). MODEL picks the model; an argument runs one check ("sum", "row"…).
//   GEMINI_API_KEY=… node evals/live-081.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const REPO = process.env.REPO ?? fileURLToPath(new URL("..", import.meta.url));
const dist = (file) => pathToFileURL(path.join(REPO, "dist", file)).href;
const { createLargeFiles, MemoryDocumentStore, askWithFiles } = await import(dist("index.js"));
const { gemini, geminiApi } = await import(dist("gemini/index.js"));
const JSZip = createRequire(path.join(REPO, "package.json"))("jszip");

const MODEL = process.env.MODEL ?? "gemini-3.5-flash-lite";
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
const model = gemini(geminiApi({ apiKey, model: MODEL }));
const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_500 } });
const enc = new TextEncoder();
const only = process.argv[2];

// A workbook of sales, 1,200 rows.
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const regions = ["North", "South", "West", "Center"];
const cell = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const rows = [`<row r="1">${cell("A1", "Region")}${cell("B1", "Customer")}${cell("C1", "Revenue")}</row>`];
const sales = { East: { n: 0, sum: 0 } };
const byRegion = {};
for (let r = 2; r <= 1200; r++) {
  const region = r % 53 === 0 ? "East" : regions[r % 4];
  const revenue = 1000 + ((r * 37) % 900);
  byRegion[region] ??= { n: 0, sum: 0 };
  byRegion[region].n++;
  byRegion[region].sum += revenue;
  rows.push(`<row r="${r}">${cell(`A${r}`, region)}${cell(`B${r}`, `Customer ${r}`)}<c r="C${r}"><v>${revenue}</v></c></row>`);
}
const xlsx = new JSZip();
xlsx.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`);
xlsx.file("xl/workbook.xml", `<workbook ${S}><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`);
xlsx.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
xlsx.file("xl/worksheets/sheet1.xml", `<worksheet ${S}><sheetData>${rows.join("")}</sheetData></worksheet>`);
const salesBytes = await xlsx.generateAsync({ type: "uint8array" });

// A CSV with a title row above its header, 3,000 orders.
const statuses = ["paid", "paid", "paid", "shipped", "refunded", "pending"];
const csv = ["Orders export - November 2026", "Order,Region,Status,Amount"];
const refunded = { n: 0, sum: 0 };
let order41877;
for (let i = 0; i < 3000; i++) {
  const id = 40000 + i;
  const status = statuses[(i * 7) % statuses.length];
  const amount = ((i * 131) % 5000) / 10 + 5;
  if (status === "refunded") { refunded.n++; refunded.sum += amount; }
  if (id === 41877) order41877 = amount;
  csv.push(`${id},${regions[i % 4]},${status},${amount.toFixed(2)}`);
}
refunded.sum = Math.round(refunded.sum * 100) / 100;

const docs = {
  sales: await files.ingest({ name: "sales-2026.xlsx", bytes: salesBytes }),
  orders: await files.ingest({ name: "orders.csv", bytes: enc.encode(csv.join("\n")) }),
};
// Format from bytes: a workbook uploaded without an extension.
const sniffed = await files.ingest({ name: "export", bytes: salesBytes });
console.log(`format of "export": ${sniffed.format} ${sniffed.format === "xlsx" ? "PASS" : "CHECK"}`);

const total = { requests: 0, input: 0 };
async function ask(label, doc, question, check) {
  if (only && only !== label) return;
  const started = Date.now();
  const result = await askWithFiles({ files, model, documentIds: [doc.id], messages: [{ role: "user", text: question }] });
  const u = result.usage;
  total.requests += u.requests; total.input += u.inputTokens ?? 0;
  const verdict = check(result.text.replace(/,(?=\d{3}\b)/g, ""));
  console.log(`\n=== ${label} (${MODEL}) ${verdict.ok ? "PASS" : "CHECK"}: ${u.requests} requests, ${u.inputTokens} in, ${Date.now() - started} ms`);
  console.log(`Q: ${question}`);
  for (const step of result.steps) console.log(`  · ${step}`);
  console.log(`A: ${result.text.trim().slice(0, 700)}`);
  if (!verdict.ok) console.log(`expected: ${verdict.expected}`);
}

const east = byRegion.East;
await ask("sum", docs.sales, "What is the total revenue of the East region, and how many East rows are there?", (text) => ({ ok: text.includes(String(east.sum)) && text.includes(String(east.n)), expected: `${east.sum} over ${east.n} rows` }));
const averages = Object.entries(byRegion).map(([region, { n, sum }]) => [region, sum / n]);
await ask("averages", docs.sales, "What is the average revenue per region? List every region.", (text) => ({
  ok: averages.every(([, avg]) => text.includes(String(Math.trunc(avg)))),
  expected: averages.map(([region, avg]) => `${region} ${avg.toFixed(2)}`).join(", "),
}));
await ask("refunds", docs.orders, "How many orders are refunded, and what is their total amount?", (text) => ({ ok: text.includes(String(refunded.n)) && text.includes(String(Math.trunc(refunded.sum))), expected: `${refunded.n} orders, ${refunded.sum}` }));
await ask("row", docs.orders, "What is the status and the amount of order 41877?", (text) => ({ ok: text.includes(order41877.toFixed(2)) || text.includes(String(order41877)), expected: `${statuses[(1877 * 7) % statuses.length]}, ${order41877.toFixed(2)}` }));
console.log(`\nTotal: ${total.requests} requests, ${total.input} input tokens`);
