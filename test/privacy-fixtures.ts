// Shared fixtures of the privacy tests (specs/03-privacy-sse §4): seven files whose every line,
// column header, sheet name and heading carries unique canaries (the spec's
// probes/lib/canary-fixtures.mjs, byte for byte), the DLP hooks of docs/security.md's kind, one
// question that calls every tool, and a scan of what each byte stream carries. Uses only the public
// API and `fakeModel`.
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import JSZip from "jszip";
import { askStream, createLargeFiles, createQuestionRegistry, MemoryDocumentStore, type AskEvent, type AskOptions, type AskResult, type LargeFiles, type ModelRequest, type ToolResultContext, type ToolResultVerdict } from "llm-large-files";
import { writeSseEvents } from "llm-large-files/node";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";

export const ACCESS = { owner: "alice", scope: ["alice", "chat-1"] };
export const TEXT_CANARY = /QZ[A-Z]{5}/g;
export const PII_CANARY = /(?<!\d)7\d{8}(?!\d)/g;
export const NAME_CANARY = /NM[A-Z]{5}/g;
export const SECRET = "סודי";
export const canariesIn = (text: string): string[] => [...new Set([...(text.match(TEXT_CANARY) ?? []), ...(text.match(PII_CANARY) ?? []), ...(text.match(NAME_CANARY) ?? [])])];

export type Planted = { file: string; line: number; kind: string };
export type CanaryFiles = { registry: Map<string, Planted>; files: Array<{ name: string; bytes: Uint8Array }> };

/** The files of probes/lib/canary-fixtures.mjs, byte for byte. */
export async function canaryFiles(): Promise<CanaryFiles> {
  const registry = new Map<string, Planted>();
  let n = 0;
  const letters = (k: number) => { let s = ""; for (let i = 0; i < 5; i++) { s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26); } return s; };
  const plant = (prefix: string, file: string, line: number, kind: string) => { const token = `${prefix}${letters(n * 7919 + 17)}`; n++; registry.set(token, { file, line, kind }); return token; };
  const pii = (file: string, line: number) => { const token = `7${String((n * 104729 + 12345) % 100000000).padStart(8, "0")}`; n++; registry.set(token, { file, line, kind: "pii" }); return token; };
  const departments = [0, 1, 2, 3, 4].map((i) => plant("QZ", "table.csv", 0, `group-value-${i}`));
  const roster: string[] = [];
  for (let line = 1; line <= 150; line++) roster.push(`עובד ${plant("NM", "roster.txt", line, "name")} | ת.ז. ${pii("roster.txt", line)} | מחלקה ${line % 5} | שכר ${(9000 + line * 37).toLocaleString("en-US")} | ${plant("QZ", "roster.txt", line, "body")}${line % 7 === 0 ? ` | ${SECRET}` : ""}`);
  const csv = [`שם,ת.ז.,מחלקה,שכר,${plant("QZ", "table.csv", 1, "column-header")}`];
  for (let line = 2; line <= 101; line++) csv.push(`${plant("NM", "table.csv", line, "name")},${pii("table.csv", line)},${departments[line % 5]},${8000 + line * 41},${plant("QZ", "table.csv", line, "body")}${line % 7 === 0 ? ` ${SECRET}` : ""}`);
  const policy: string[] = [];
  for (let section = 1; section <= 8; section++) {
    policy.push(`## ${plant("QZ", "policy.md", policy.length + 1, "heading")} פרק ${section}`);
    for (let k = 1; k <= 14; k++) { const line = policy.length + 1; policy.push(`נוהל החזר הוצאות סעיף ${section}.${k}: העובד מגיש קבלה בתוך ${k + 3} ימים ${plant("QZ", "policy.md", line, "body")}${line % 7 === 0 ? ` ${SECRET}` : ""}`); }
  }
  const contract: string[] = [];
  for (let clause = 1; clause <= 90; clause++) {
    const line = contract.length + 1;
    contract.push(clause % 6 === 0
      ? `${clause}. בגין איחור ישלם הספק קנס בסך ${1000 + clause * 50} ש"ח למזמין ${pii("contract.txt", line)} ${plant("QZ", "contract.txt", line, "body")}${line % 7 === 0 ? ` ${SECRET}` : ""}`
      : `${clause}. הספק יבצע ביקור תחזוקה חודשי ויגיש דוח ${plant("QZ", "contract.txt", line, "body")}${line % 7 === 0 ? ` ${SECRET}` : ""}`);
  }
  const notes = Array.from({ length: 120 }, (_, i) => `יומן משמרת ${i + 1}: אירוע תפעולי שגרתי נרשם ${plant("QZ", "notes.txt", i + 1, "body")}${(i + 1) % 7 === 0 ? ` ${SECRET}` : ""}`);
  const small = Array.from({ length: 6 }, (_, i) => `קובץ קטן שורה ${i + 1} ${plant("QZ", "small.txt", i + 1, "body")} ${pii("small.txt", i + 1)}`);
  const sheetNames = [plant("QZ", "book.xlsx", 0, "sheet-name"), plant("QZ", "book.xlsx", 0, "sheet-name")];
  const header = plant("QZ", "book.xlsx", 0, "column-header");
  const sheets = sheetNames.map((_, s) => [["פריט", "קוד", header, "כמות"], ...Array.from({ length: 60 }, (_, r) => [plant("NM", "book.xlsx", 0, "name"), pii("book.xlsx", 0), plant("QZ", "book.xlsx", 0, "body"), String((r + 1) * (s + 2))])]);
  return {
    registry,
    files: [
      { name: "roster.txt", bytes: utf8(roster.join("\n")) }, { name: "table.csv", bytes: utf8(csv.join("\n")) },
      { name: "policy.md", bytes: utf8(policy.join("\n")) }, { name: "contract.txt", bytes: utf8(contract.join("\n")) },
      { name: "notes.txt", bytes: utf8(notes.join("\n")) }, { name: "small.txt", bytes: utf8(small.join("\n")) },
      { name: "book.xlsx", bytes: await workbook(sheetNames, sheets) },
    ],
  };
}

async function workbook(names: string[], sheets: string[][][]): Promise<Uint8Array> {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const archive = new JSZip();
  // A fixed date on every entry: the same bytes on every run, as the probe's.
  const zip = { file: (name: string, content: string) => archive.file(name, content, { date: new Date(Date.UTC(2026, 10, 27)), createFolders: false }), generateAsync: archive.generateAsync.bind(archive) };
  zip.file("xl/workbook.xml", `<workbook ${S}><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  sheets.forEach((rows, s) => zip.file(`xl/worksheets/sheet${s + 1}.xml`, `<worksheet ${S}><sheetData>${rows.map((cells, r) => `<row r="${r + 1}">${cells.map((cell, c) => /^\d+$/.test(cell) && cell.length < 9 ? `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${cell}</v></c>` : `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${cell}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

type Hook = (context: Pick<ToolResultContext, "result">) => ToolResultVerdict | undefined;
const mapStrings = (value: unknown, f: (s: string) => string): unknown => typeof value === "string" ? f(value) : Array.isArray(value) ? value.map((v) => mapStrings(v, f)) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)])) : value;
const dropWith = (value: unknown): unknown => typeof value === "string" ? value.split("\n").filter((l) => !l.includes(SECRET)).join("\n") : Array.isArray(value) ? value.filter((v) => !(v && typeof v === "object" && JSON.stringify(v).includes(SECRET))).map(dropWith) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dropWith(v)])) : value;
const changed = (before: unknown, after: unknown) => (JSON.stringify(before) === JSON.stringify(after) ? undefined : { result: after as ToolResultContext["result"] });

/** The DLP hooks of the spec's probes/lib/hooks.mjs: each reads only `result`, so each is also an `onPreview`. */
export const HOOKS: Record<string, Hook> = {
  none: () => undefined,
  maskDigits: ({ result }) => changed(result, mapStrings(result, (s) => s.replace(/\d/g, "•"))),
  maskIds: ({ result }) => changed(result, mapStrings(result, (s) => s.replace(/(?<!\d)\d{9}(?!\d)/g, "[ת.ז.]"))),
  dropLines: ({ result }) => changed(result, dropWith(result)),
  replaceValues: ({ result }) => changed(result, mapStrings(result, (s) => s.replace(NAME_CANARY, "[שם]"))),
  // About 280 characters for each 7-character name: the loop cuts the larger copy to the room.
  expandNames: ({ result }) => changed(result, mapStrings(result, (s) => s.replace(NAME_CANARY, `[${"שם העובד הוסתר לפי מדיניות הפרטיות של הארגון ".repeat(6).trim()}]`))),
  redactWhole: () => ({ result: { note: "[הוסתר לפי מדיניות]" } }),
  reject: () => ({ reject: "Blocked by policy." }),
};

/** A seeded PRNG (mulberry32), for random per-call hook plans that replay the same. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A ServerResponse that keeps what writeSseEvents writes. */
export function fakeResponse(): ServerResponse & { body(): string } {
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, writableEnded: false, req: { httpVersionMajor: 1 },
    setHeader() {}, writeHead() { response.headersSent = true; return response; }, flushHeaders() {},
    write(chunk: string) { chunks.push(String(chunk)); return true; },
    end() { response.writableEnded = true; queueMicrotask(() => response.emit("finish")); },
    destroy() { response.destroyed = true; },
    body: () => chunks.join(""),
  });
  return response as unknown as ServerResponse & { body(): string };
}
export const sseData = (body: string): Array<Record<string, unknown>> => body.split("\n\n").flatMap((block) => block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))));

export const ANSWER = "השכר (roster.txt L33). שורה סודית (roster.txt L35). לא נקראה (roster.txt L120). התאמה (roster.txt L62). נוהל (policy.md L45), כותרת (policy.md L16). סכום (table.csv L12). קנס (contract.txt L48). יומן (notes.txt L20). קובץ קטן (small.txt L3).";

export type Run = { result?: AskResult; error?: unknown; events: AskEvent[]; sse: Record<string, string>; requests: ModelRequest[]; removed: Set<string>; files: LargeFiles; registry: Map<string, Planted>; ids: Record<string, string> };

/**
 * One question that calls every tool (search exact/regex/keywords, read, overview, aggregate x3,
 * analyze items and prose), then answers with ANSWER. `hookFor(callId)` picks each call's hook.
 */
export async function runQuestion(options: { hookFor: (callId: string) => string; eventResults?: boolean; transport?: "stream" | "registry"; fail?: boolean; tight?: boolean; onPreview?: Hook }): Promise<Run> {
  const fixtures = await canaryFiles();
  const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 400, mapChunkTokens: 1500 }, ...(options.onPreview ? { onPreview: options.onPreview } : {}) });
  const ids: Record<string, string> = {};
  for (const file of fixtures.files) ids[file.name] = (await files.ingest({ name: file.name, bytes: file.bytes, ...ACCESS })).id;
  const reader = async ({ prompt }: { prompt: string }) => {
    const part = prompt.includes("<part>") ? prompt.slice(prompt.indexOf("<part>\n") + 7, prompt.indexOf("\n</part>")) : "";
    const lines = part.split("\n").map((l) => /^(\d+)\| (.*)$/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => [Number(m[1]), m[2]!] as const);
    if (part && prompt.includes("- quote:")) return lines.filter(([, t]) => t.includes("קנס")).map(([line, t]) => JSON.stringify({ line, label: "penalty", quote: t.slice(t.indexOf("קנס"), t.indexOf("קנס") + 70).trim() })).join("\n") || "NOTHING RELEVANT";
    if (part) return lines.slice(1, 3).map(([line, t]) => `(L${line}) ${t}`).join("\n") || "NOTHING RELEVANT";
    return `סיכום: ${prompt.split("\n").filter((l) => /\(L\d+\)/.test(l)).slice(0, 4).join(" ")}`;
  };
  let release = () => {};
  const gate = options.transport === "registry" ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  const model = fakeModel([
    calls([
      { id: "c1", name: "search_document", args: { document_id: ids["roster.txt"], query: "עובד", mode: "exact", max_results: 6, from_line: 40 } },
      { id: "c2", name: "search_document", args: { document_id: ids["roster.txt"], query: "ת\\.ז\\. 7\\d{3}", mode: "regex", max_results: 4, from_line: 60 } },
      { id: "c3", name: "search_document", args: { document_id: ids["policy.md"], query: "נוהל החזר הוצאות קבלה", mode: "keywords" } },
      { id: "c4", name: "read_document", args: { document_id: ids["roster.txt"], start_line: 30, end_line: 45 } },
      { id: "c5", name: "aggregate_table", args: { document_id: ids["table.csv"], metrics: ["sum:שכר"], group_by: ["מחלקה"] } },
      { id: "c6", name: "aggregate_table", args: { document_id: ids["table.csv"], metrics: ["sum:בונוס"] } },
      { id: "c7", name: "get_document_overview", args: { document_id: ids["policy.md"] } },
      { id: "c8", name: "aggregate_table", args: { document_id: ids["book.xlsx"], table: "2", metrics: ["count"], group_by: ["D"] } },
    ]),
    calls([
      { id: "c9", name: "analyze_whole_document", args: { document_id: ids["contract.txt"], task: "List every clause that sets a fine", output: "items", labels: ["penalty"] } },
      { id: "c10", name: "analyze_whole_document", args: { document_id: ids["notes.txt"], task: "Summarize the shifts" } },
      { id: "c11", name: "read_document", args: { document_id: ids["policy.md"], start_line: 40, end_line: 60 } },
      { id: "c12", name: "search_document", args: { document_id: ids["book.xlsx"], query: "Row 30", mode: "exact" } },
    ]),
    async (_request, _call, hooks) => {
      await gate;
      if (options.fail) { hooks.onText?.(ANSWER.slice(0, 120)); return Object.assign(new Error("The connection was reset."), { status: 0, kind: "unreachable" }); }
      return says(ANSWER);
    },
  ], { generateText: reader, contextTokens: options.tight ? 16_000 : 200_000 });
  const removed = new Set<string>();
  const events: AskEvent[] = [];
  const asked: AskOptions = {
    model, files, documentIds: Object.values(ids), ...ACCESS, messages: [{ role: "user", text: "מה השכר, מה הנוהל, ומה הקנסות?" }],
    showCitations: false, eventResults: options.eventResults === true, retry: { retries: 0 }, onEvent: (event) => events.push(event),
    onToolResult: (context) => {
      const verdict = HOOKS[options.hookFor(context.call.id ?? "")]!(context);
      const raw = canariesIn(JSON.stringify(context.result));
      const kept = verdict === undefined ? raw : "result" in verdict ? canariesIn(JSON.stringify(verdict.result)) : [];
      for (const canary of raw) if (!kept.includes(canary)) removed.add(canary);
      return verdict;
    },
  };
  const sse: Record<string, string> = {};
  let result: AskResult | undefined;
  let error: unknown;
  if (options.transport !== "registry") {
    const stream = askStream(asked);
    const response = fakeResponse();
    await writeSseEvents(response, stream, { heartbeatMs: 0 });
    sse.A = response.body();
    result = await stream.result.catch((thrown) => { error = thrown; return undefined; });
  } else {
    const registry = createQuestionRegistry();
    const withId = { ...asked, questionId: "q-privacy-1" };
    const a = registry.askStream(withId);
    const resA = fakeResponse();
    const doneA = writeSseEvents(resA, a, { heartbeatMs: 0 });
    while (events.filter((e) => e.type === "tool.end").length < 12) await new Promise((r) => setTimeout(r, 1));
    const resB = fakeResponse();
    const doneB = writeSseEvents(resB, registry.askStream(withId), { heartbeatMs: 0 });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([doneA, doneB]);
    sse.A = resA.body();
    sse.B = resB.body();
    result = await a.result.catch((thrown) => { error = thrown; return undefined; });
    if (result) { const resC = fakeResponse(); await writeSseEvents(resC, registry.askStream(withId), { heartbeatMs: 0 }); sse.C = resC.body(); }
  }
  return { result, error, events, sse, requests: model.requests, removed, files, registry: fixtures.registry, ids };
}

/** What the model was sent of the files: tool results as sent, files sent whole. Not the cards. */
export function sentToModel(requests: ModelRequest[]): { covers(quote: string): boolean; canaries: Set<string> } {
  const texts: string[] = [];
  const strings = (value: unknown): void => { if (typeof value === "string") texts.push(value); else if (Array.isArray(value)) value.forEach(strings); else if (value && typeof value === "object") Object.values(value).forEach(strings); };
  for (const request of requests) for (const message of request.messages) {
    if (message.role === "tools") for (const answer of message.answers) strings(answer.result);
    if (message.role === "user") {
      const text = JSON.stringify(message);
      for (const m of JSON.parse(text).parts?.map((p: { text?: string }) => p.text ?? "").join("\n").matchAll(/--- Attached file \[mark (\w+)\][^\n]*\n([\s\S]*?)\n--- End attached file \[mark \1\] ---/g) ?? []) texts.push(m[2]!);
    }
  }
  const normalize = (s: string) => s.replace(/^\s*\d+\| ?/gm, "").replace(/\s+/g, " ").trim();
  const corpus = texts.map(normalize);
  return { covers: (quote) => corpus.some((entry) => entry.includes(normalize(quote))), canaries: new Set(canariesIn(texts.join("\n"))) };
}

/** Every value under a key, at any depth. */
export function valuesOf(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((v) => valuesOf(v, key, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (k === key) out.push(v); valuesOf(v, key, out); }
  return out;
}
