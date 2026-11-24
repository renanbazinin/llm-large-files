// Live check of 0.9.0 against the Gemini API: the chatbot of docs/upgrading-0.9.md, with Hebrew
// files and questions, a scoped FileDocumentStore, uploads saved once by prepareUpload, and
// fileOriginals. MongoDB is a Map here. Reads GEMINI_API_KEY from the environment; never prints it.
// REPO is a built checkout: this one unless set (run `npm run build` first). PDF_FIXTURES is the
// folder of the test PDFs (REPO/test/fixtures/pdf unless set); SCRATCH, where the volume goes.
//   GEMINI_API_KEY=… node evals/live-090.mjs
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const REPO = process.env.REPO ?? fileURLToPath(new URL("..", import.meta.url));
const PDF_FIXTURES = process.env.PDF_FIXTURES ?? path.join(REPO, "test", "fixtures", "pdf");
const dist = (file) => pathToFileURL(path.join(REPO, "dist", file)).href;
const { createLargeFiles, FileDocumentStore, hashedScopeSegment, isSafeScopeSegment, errorInfoOf } = await import(dist("index.js"));
const { createDocumentHandlers, fileOriginals } = await import(dist("node/index.js"));
const { askGemini, geminiApi } = await import(dist("gemini/index.js"));
const JSZip = createRequire(path.join(REPO, "package.json"))("jszip");

const MODEL = process.env.MODEL ?? "gemini-3.8-flash";
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
const endpoint = geminiApi({ apiKey, model: MODEL });
const VOLUME = await mkdtemp(path.join(process.env.SCRATCH ?? tmpdir(), "volume-"));
const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- documents.ts of the worked example, with a Map for MongoDB ----
const sessions = new Map(); // _id -> { _id, userId, files }
const turns = new Map(); // sessionId -> [{ question, toolTurns, answer }]
const files = createLargeFiles({
  store: new FileDocumentStore(VOLUME, { scopes: { depth: 2 } }),
  keepOriginals: ["pdf"],
  originals: fileOriginals(VOLUME),
  ttlMs: Infinity,
  requireOwner: true,
  requireScope: true,
  budget: { inlineTokens: 1_500 },
});
const scopeOf = (userId, sessionId) => {
  if (!isSafeScopeSegment(sessionId)) throw new TypeError("This is not a session ID.");
  return [hashedScopeSegment(userId), sessionId];
};
async function startChat(userId, sessionId) {
  sessions.set(sessionId, { _id: sessionId, userId, files: [] });
  await mkdir(path.join(VOLUME, ...scopeOf(userId, sessionId), "uploads"), { recursive: true, mode: 0o700 });
}
const chatGone = () => Object.assign(new Error("This chat no longer exists."), { status: 404 });
const userIdOf = (request) => (request.headers["x-user-id"] ? String(request.headers["x-user-id"]) : undefined);
const findChat = (sessionId, userId) => {
  const chat = sessions.get(sessionId);
  return chat && chat.userId === userId ? chat : undefined;
};
const documents = createDocumentHandlers(files, {
  getOwner: (request) => userIdOf(request),
  getScope: async (request) => {
    const userId = userIdOf(request);
    const sessionId = String(request.headers["x-session-id"] ?? "");
    if (!isSafeScopeSegment(sessionId) || !findChat(sessionId, userId)) throw chatGone();
    return scopeOf(userId, sessionId);
  },
  prepareUpload: (_request, { scope }) => {
    const id = `up-${randomUUID().replaceAll("-", "")}`;
    const ref = [...scope, "uploads", id].join("/");
    return { id, path: path.join(VOLUME, ref), original: { ref } };
  },
  onUploaded: async (document, { owner, scope }) => {
    const chat = findChat(scope[1], owner);
    if (!chat) throw chatGone();
    chat.files.push({ id: document.id, name: document.name, ...(document.sha256 ? { sha256: document.sha256 } : {}) });
  },
  onRemoved: async (id, { owner, scope }) => {
    const chat = findChat(scope[1], owner);
    if (chat) chat.files = chat.files.filter((file) => file.id !== id);
    await rm(path.join(VOLUME, ...scope, "uploads", id), { force: true });
  },
});
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://x");
  const id = url.pathname.match(/^\/api\/documents\/([^/]+)$/)?.[1];
  if (request.method === "POST" && url.pathname === "/api/documents") return void documents.upload(request, response);
  if (request.method === "GET" && id) return void documents.get(request, response, id);
  if (request.method === "DELETE" && id) return void documents.remove(request, response, id);
  response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/api/documents`;
const upload = (bytes, name, user, session, accept) =>
  fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
      ...(user ? { "X-User-Id": user } : {}),
      ...(session ? { "X-Session-Id": session } : {}),
      ...(accept ? { Accept: accept } : {}),
    },
    body: bytes,
  });

// ---- the files ----
const enc = new TextEncoder();
// A long Hebrew policy in Word, with the facts buried among filler sections.
const facts = {
  12: "כל עובד במשרה מלאה זכאי ל-18 ימי חופשה בתשלום בכל שנה קלנדרית.",
  27: "בקשת חופשה של יותר משלושה ימי עבודה יש להגיש במערכת לפחות 21 ימים לפני תחילת החופשה.",
  41: "הבקשה מאושרת על ידי המנהל הישיר. בהיעדרו, הבקשה מאושרת על ידי מנהלת משאבי האנוש, נועה ברק.",
  58: "ניתן להעביר לשנה הבאה עד 6 ימי חופשה שלא נוצלו. ימים מעבר לכך אינם נצברים.",
  73: "החזר הוצאות נסיעה ברכב פרטי הוא 2.35 ש\"ח לכל קילומטר, לפי דיווח חודשי.",
};
const topics = ["נהלי בטיחות במשרד", "שימוש בציוד מחשוב", "אבטחת מידע", "קבלת אורחים", "חניה ותחבורה", "ישיבות צוות", "הדרכות מקצועיות", "רכש והזמנות"];
const paragraphs = [];
for (let section = 1; section <= 90; section++) {
  paragraphs.push(`סעיף ${section}: ${topics[section % topics.length]}`);
  paragraphs.push(facts[section] ?? `בסעיף זה מפורטים הכללים בנושא ${topics[section % topics.length]}. העובדים נדרשים לפעול לפי ההנחיות המעודכנות, לשמור על הסדר והניקיון, ולדווח לממונה על כל חריגה. נוהל זה מתעדכן מעת לעת ומפורסם בפורטל הארגוני.`);
  paragraphs.push(`הערות לסעיף ${section}: יש לתעד כל פעולה במערכת הניהול, ולשמור את המסמכים לפחות שבע שנים. במקרה של ספק יש לפנות למחלקה הרלוונטית לקבלת הבהרות נוספות לפני ביצוע הפעולה.`);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = new JSZip();
docx.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
docx.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
docx.file("word/document.xml", `<w:document ${W}><w:body>${paragraphs.map((p) => `<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">${p.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
const docxBytes = await docx.generateAsync({ type: "uint8array" });

// A Hebrew CSV of 2,500 service tickets.
const cities = ["תל אביב", "חיפה", "ירושלים", "באר שבע", "נתניה"];
const statuses = ["פתוח", "סגור", "סגור", "בטיפול", "בוטל", "סגור", "פתוח"];
const csv = ["מספר פנייה,לקוח,עיר,סטטוס,סכום"];
const haifaCanceled = { n: 0, sum: 0 };
for (let i = 0; i < 2500; i++) {
  const city = cities[(i * 3) % cities.length];
  const status = statuses[(i * 5) % statuses.length];
  const amount = 100 + ((i * 173) % 4900);
  if (city === "חיפה" && status === "בוטל") { haifaCanceled.n++; haifaCanceled.sum += amount; }
  csv.push(`${70000 + i},לקוח ${i % 400},${city},${status},${amount}`);
}
const csvBytes = enc.encode(csv.join("\n"));
const pdfBytes = new Uint8Array(await readFile(path.join(PDF_FIXTURES, "word-hebrew.pdf")));

// ---- uploads over HTTP ----
const ALICE = "Alice.Cohen@Example.co.il";
const BOB = "bob@example.co.il";
const CHAT1 = "65a1f0c2e4b0a1b2c3d4e5f6";
const CHAT2 = "65a1f0c2e4b0a1b2c3d4e5f7";
const CHATB = "65a1f0c2e4b0a1b2c3d4e5f8";
await startChat(ALICE, CHAT1);
await startChat(ALICE, CHAT2);
await startChat(BOB, CHATB);

check("no user: 401", (await upload(csvBytes, "a.csv", undefined, CHAT1)).status === 401);
check("another user's chat: 404", (await upload(csvBytes, "a.csv", BOB, CHAT1)).status === 404);
const uploaded = {};
for (const [key, bytes, name] of [["policy", docxBytes, "מדיניות חופשות 2026.docx"], ["tickets", csvBytes, "פניות שירות.csv"], ["report", pdfBytes, "דוח הכנסות.pdf"]]) {
  const response = await upload(bytes, name, ALICE, CHAT1);
  const body = await response.json();
  uploaded[key] = body;
  const recorded = sessions.get(CHAT1).files.find((file) => file.id === body.id);
  check(`upload ${key}: 201, Hebrew name kept, sha256 in the record (onUploaded), not in the answer`, response.status === 201 && body.name === name && body.sha256 === undefined && recorded?.sha256 === createHash("sha256").update(bytes).digest("hex"), `${response.status} ${body.name ?? body.error} ${body.id}`);
}
// The same upload with progress (SSE).
{
  const response = await upload(csvBytes, "עותק.csv", ALICE, CHAT2, "text/event-stream");
  const text = await response.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  check("SSE upload ends with ingest.finish", response.status === 200 && events.at(-1) === "ingest.finish", events.join(","));
}
const chatDir = path.join(VOLUME, ...scopeOf(ALICE, CHAT1));
const storeFiles = await readdir(path.join(chatDir, ".llm-large-files"));
const uploads = await readdir(path.join(chatDir, "uploads"));
const modes = await Promise.all([...uploads.map((f) => path.join(chatDir, "uploads", f)), ...storeFiles.map((f) => path.join(chatDir, ".llm-large-files", f))].map(async (f) => (await stat(f)).mode & 0o777));
check("each upload saved once under uploads/, no .bin copy, files 0600", uploads.length === 3 && !storeFiles.some((f) => f.endsWith(".bin")) && modes.every((m) => m === 0o600), `uploads ${uploads.length}, store ${storeFiles.join(" ")}`);
check("store folder is 0700", ((await stat(path.join(chatDir, ".llm-large-files"))).mode & 0o777) === 0o700);
check("user folder is a hash, not the e-mail", (await readdir(VOLUME)).every((name) => /^h[0-9a-f]{40}$/.test(name)));
const alice1 = { owner: ALICE, scope: scopeOf(ALICE, CHAT1) };
const original = await files.getOriginal(uploaded.report.id, alice1);
check("getOriginal reads the upload through fileOriginals", original && Buffer.from(original).equals(Buffer.from(pdfBytes)));
const bobsLook = await files.getOriginal(uploaded.report.id, { owner: BOB, scope: scopeOf(BOB, CHATB) }).catch((error) => error);
check("Bob cannot read Alice's original", bobsLook === undefined || bobsLook instanceof Error, String(bobsLook?.name ?? bobsLook));

// ---- questions in Hebrew ----
const total = { requests: 0, input: 0, output: 0 };
async function ask(label, user, session, question, documentIds, options = {}) {
  const earlier = turns.get(session) ?? [];
  const messages = [
    ...earlier.flatMap((turn) => [{ role: "user", text: turn.question }, ...turn.toolTurns, ...(turn.answer !== undefined ? [{ role: "assistant", text: turn.answer }] : [])]),
    { role: "user", text: question },
  ];
  const started = Date.now();
  const result = await askGemini({ files, endpoint, owner: user, scope: scopeOf(user, session), documentIds, messages, ...options });
  total.requests += result.usage.requests; total.input += result.usage.inputTokens ?? 0; total.output += result.usage.outputTokens ?? 0;
  if (options.keep !== false) turns.set(session, [...earlier, { question, toolTurns: result.toolTurns, ...(result.answered ? { answer: result.text } : {}) }]);
  console.log(`\n=== ${label} (${MODEL}): ${result.usage.requests} requests, ${result.usage.inputTokens} in, ${Date.now() - started} ms`);
  console.log(`ש: ${question}`);
  for (const step of result.steps ?? []) console.log(`  · ${step}`);
  console.log(`ת: ${result.text.trim().slice(0, 600)}`);
  if (result.missing?.length) console.log(`missing: ${result.missing.join(", ")}`);
  return result;
}
const ids = [uploaded.policy.id, uploaded.tickets.id, uploaded.report.id];
const plain = (text) => text.replace(/(?<=\d),(?=\d{3}\b)/g, "");

let r = await ask("policy", ALICE, CHAT1, "כמה ימי חופשה מגיעים לעובד במשרה מלאה, וכמה ימים מראש צריך להגיש בקשה לחופשה של שבוע?", ids);
check("policy: 18 days, 21 days ahead", /18/.test(r.text) && /21/.test(r.text));
r = await ask("follow-up", ALICE, CHAT1, "ומי מאשרת את הבקשה אם המנהל הישיר לא נמצא?", ids);
check("follow-up over stored rounds: נועה ברק", r.text.includes("נועה ברק"));
r = await ask("tickets", ALICE, CHAT1, "כמה פניות בסטטוס 'בוטל' יש בעיר חיפה, ומה הסכום הכולל שלהן?", ids);
check(`tickets: ${haifaCanceled.n} canceled in Haifa, total ${haifaCanceled.sum}`, plain(r.text).includes(String(haifaCanceled.n)) && plain(r.text).includes(String(haifaCanceled.sum)));
r = await ask("report", ALICE, CHAT1, "לפי דוח ההכנסות, מה היו ההכנסות של אזור צפון ברבעון 2, ובאיזה רבעון חסר נתון לאזור מרכז?", ids);
check("report: North Q2 135, Center Q2 missing", r.text.includes("135") && /(רבעון 2|רבעון השני|הרבעון השני|Q2)/.test(r.text));

// ---- isolation ----
r = await ask("Bob asks about Alice's files (drop)", BOB, CHATB, "כמה ימי חופשה מגיעים לעובד?", ids, { onMissingDocuments: "drop", keep: false });
check("Bob: every file of Alice is missing, and the answer does not know them", r.missing?.length === 3 && !r.text.includes("נועה") && !r.text.includes("סעיף 12") && r.usage.inputTokens < 500, `missing ${r.missing?.length}`);
const thrown = await askGemini({ files, endpoint, owner: BOB, scope: scopeOf(BOB, CHATB), documentIds: ids, messages: [{ role: "user", text: "מה כתוב בקובץ?" }] }).catch((error) => error);
const info = errorInfoOf(thrown);
check("Bob with the default: missing, 404, before any request", info.category === "missing" && info.status === 404, `${thrown?.name} ${info.category} ${info.status}`);
r = await ask("Alice in another chat (drop)", ALICE, CHAT2, "מה כתוב בדוח ההכנסות?", [uploaded.report.id], { onMissingDocuments: "drop", keep: false });
check("Alice's other chat does not see chat 1's files", r.missing?.length === 1);

// ---- a file removed in another tab ----
const removed = await fetch(`${base}/${uploaded.policy.id}`, { method: "DELETE", headers: { "X-User-Id": ALICE, "X-Session-Id": CHAT1 } });
const uploadsAfter = await readdir(path.join(chatDir, "uploads"));
check("DELETE removes the document, its upload (onRemoved) and the record's line", removed.ok && uploadsAfter.length === 2 && sessions.get(CHAT1).files.length === 2, `${removed.status}, uploads ${uploadsAfter.length}`);
r = await ask("after the removal (drop)", ALICE, CHAT1, "ומה לגבי החזר הוצאות נסיעה?", ids, { onMissingDocuments: "drop" });
check("the removed policy is listed in missing, and the question is answered", r.missing?.includes(uploaded.policy.id) && r.text.length > 0, `missing ${r.missing}`);

// ---- a model error, in the user's words ----
const bad = await askGemini({ files, endpoint: geminiApi({ apiKey: "not-a-key", model: MODEL }), owner: ALICE, scope: scopeOf(ALICE, CHAT1), documentIds: [uploaded.tickets.id], messages: [{ role: "user", text: "שלום" }], retry: { maxRetries: 0 } }).catch((error) => error);
const badInfo = errorInfoOf(bad);
check("a refused key: a model error with a status, no key in the message", badInfo.category === "model" && !String(badInfo.message).includes("not-a-key"), `${badInfo.category} ${badInfo.code} ${badInfo.status} "${badInfo.message}"`);

console.log(`\nTotal: ${total.requests} requests, ${total.input} input tokens, ${total.output} output tokens`);
console.log(`${results.filter((x) => x.ok).length}/${results.length} passed`);
server.close();
await rm(VOLUME, { recursive: true, force: true });
