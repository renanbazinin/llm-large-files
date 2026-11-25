// What questions over files sent whole send, byte for byte. Kept in test/inline-bodies/ (in
// test/inline-opt-out/ until 0.99.9 removed `inlineTables` and `numberInline`, the options that gave
// 0.9's text back):
//
// - defaults.json: what they send with the library of this package: the numbered blocks, the
//   document_id in the frame of a table that gets the tools, the line that says to count with them,
//   their declarations, and the closing note. A change to that text shows there as a diff to
//   review. Recorded on 0.10.0, and again from the source of a branch whose change to that text is
//   meant:
//
//     RECORD_DEFAULT_BODIES=1 npx vitest run --project unit test/inline-bodies.test.ts
//
// - bodies.json: what 0.9.0 sent, recorded on the source P1 of 0.10.0 started from (a734d80), where
//   a table sent whole got no tools and no file had numbered lines. A library whose `prepare` gives
//   what 0.9's gave (test/prepare-of-09.ts) still sends those bodies: a `LargeFiles` of your own
//   decides. Never recorded again.
//
// The questions cover what P1 of 0.10.0 changed: a table sent whole (a CSV, a Word file with a
// table) with and without a count, in a chat with an explorer too; a note sent whole beside a
// searched log, with the request for the answer after the tool turns ran out; a note alone; and
// through gemini() over fakeFetch, as its bytes, the same note and CSV beside the log, and a count
// over the CSV alone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskOptions, type LargeFiles, type ModelAdapter } from "llm-large-files";
import { gemini, geminiApi } from "llm-large-files/gemini";
import { calls, fakeFetch, fakeModel, says, serviceLog, utf8, type FakeModel, type FakeReply } from "llm-large-files/testing";
import { withPrepareOf09 } from "./prepare-of-09.js";
import { p, word } from "./word-fixtures.js";

const RECORD_DEFAULTS = process.env.RECORD_DEFAULT_BODIES === "1";
const DEFAULTS = new URL("./inline-bodies/defaults.json", import.meta.url);
const OF_090 = new URL("./inline-bodies/bodies.json", import.meta.url);
const CLOCK = () => new Date("2026-11-20T08:00:00.000Z");
const question = (text: string) => ({ role: "user" as const, text });

/** One request as it was sent: to which model or URL, and its body as its bytes. */
type Sent = { to: string; body: string };
type Case = { name: string; requests: Sent[] };

function invoices(rows: number): string {
  const statuses = ["שולם", "באיחור", "בוטל", "פתוח"];
  const lines = ["מספר,לקוח,סכום,סטטוס,תאריך"];
  for (let i = 1; i <= rows; i++) lines.push(`${i},לקוח ${i % 211},${(i * 7919) % 50000}.${i % 100},${statuses[(i * 7) % 4]},2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
  return lines.join("\n");
}

const cell = (text: string) => `<w:tc>${p(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;

/** A library with fixed IDs and a fixed clock: a CSV and a Word table sent whole, a note, and a log searched. */
async function library(): Promise<LargeFiles> {
  const files = createLargeFiles({ store: new MemoryDocumentStore({ now: CLOCK }), now: CLOCK, budget: { inlineTokens: 3_000 }, requireOwner: false });
  await files.ingest({ name: "חשבוניות.csv", bytes: utf8(invoices(60)), id: "invoices-1" });
  await files.ingest({ name: "נוהל.docx", bytes: await word([p("נוהל החזר הוצאות"), `<w:tbl>${row("סוג", "תקרה")}${row("נסיעות", "500")}${row("ארוחות", "120")}</w:tbl>`].join("")), id: "policy-1" });
  await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.\nThe nightly import runs at 02:00 UTC.\n"), id: "notes-1" });
  await files.ingest({ name: "app.log", bytes: utf8(serviceLog(3_000)), id: "log-1" });
  return files;
}

function recorded(model: FakeModel, log: Sent[]): ModelAdapter {
  return {
    ...model,
    send(request, hooks) {
      log.push({ to: model.id, body: JSON.stringify(request) });
      return model.send(request, hooks);
    },
  };
}

function recordingFetch(replies: FakeReply[], log: Sent[]): typeof globalThis.fetch {
  const fake = fakeFetch(replies);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    log.push({ to: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return fake.fetch(input, init);
  }) as typeof globalThis.fetch;
}

const geminiText = (text: string) => Response.json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] });

/** The questions, asked of the library of this package, or of one whose `prepare` is that of 0.9. */
async function cases(of09 = false): Promise<Case[]> {
  const files = of09 ? withPrepareOf09(await library()) : await library();
  const out: Case[] = [];
  const ask = async (name: string, script: Parameters<typeof fakeModel>[0], options: Omit<AskOptions, "files" | "model">, explorerScript?: Parameters<typeof fakeModel>[0]) => {
    const log: Sent[] = [];
    const model = recorded(fakeModel(script, { id: "fake-answer" }), log);
    const explorer = explorerScript ? recorded(fakeModel(explorerScript, { id: "fake-explorer" }), log) : undefined;
    await askWithFiles({ files, model, ...(explorer ? { explorer } : {}), system: "Be brief.", ...options });
    out.push({ name, requests: log });
  };
  const count = { id: "c1", name: "aggregate_table", args: { document_id: "invoices-1", metrics: ["count"], filters: [{ column: "סטטוס", op: "=", value: "באיחור" }] } };
  const search = { id: "c2", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
  await ask("a CSV sent whole, a question with no count", [says("Five columns.")], { documentIds: ["invoices-1"], messages: [question("Which columns does the file have?")] });
  await ask("a CSV sent whole, a count", [calls([count]), says("15 late.")], { documentIds: ["invoices-1"], messages: [question("How many invoices are late?")] });
  await ask("a Word table sent whole", [says("500.")], { documentIds: ["policy-1"], messages: [question("What is the travel cap?")] });
  await ask("a CSV sent whole in a chat with an explorer", [says("Five columns.")], { documentIds: ["invoices-1"], messages: [question("Which columns does the file have?")] }, [says("DONE")]);
  await ask("a note sent whole beside a searched log, the tool turns run out", [calls([search]), says("31 errors.")], { documentIds: ["notes-1", "log-1"], messages: [question("How many errors?")], limits: { toolTurns: 2 } });
  await ask("a note and a CSV sent whole beside a searched log, with an explorer", [says("31 errors.")], { documentIds: ["notes-1", "invoices-1", "log-1"], messages: [question("How many errors?")] }, [calls([search]), says("DONE")]);
  await ask("a note alone", [says("Heron.")], { documentIds: ["notes-1"], messages: [question("What is the code word?")] });
  {
    const log: Sent[] = [];
    const call = { id: "call-1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
    const fetch = recordingFetch([
      Response.json({ candidates: [{ content: { role: "model", parts: [{ functionCall: call }] }, finishReason: "STOP" }] }),
      geminiText("31 errors."),
    ], log);
    const model = gemini(geminiApi({ apiKey: "test-key", model: "gemini-test" }), { fetch });
    await askWithFiles({ files, model, documentIds: ["notes-1", "invoices-1", "log-1"], system: "Be brief.", messages: [question("How many errors?")] });
    out.push({ name: "gemini(): a note and a CSV sent whole beside a searched log", requests: log });
  }
  {
    const log: Sent[] = [];
    const call = { id: "call-1", name: "aggregate_table", args: { document_id: "invoices-1", metrics: ["count"], filters: [{ column: "סטטוס", op: "=", value: "באיחור" }] } };
    // The count is asked for when the tools are declared; without them, the answer comes at once.
    const fetch = recordingFetch([
      (sent) => (sent.body.tools ? Response.json({ candidates: [{ content: { role: "model", parts: [{ functionCall: call }] }, finishReason: "STOP" }] }) : geminiText("15 late.")),
      geminiText("15 late."),
    ], log);
    const model = gemini(geminiApi({ apiKey: "test-key", model: "gemini-test" }), { fetch });
    await askWithFiles({ files, model, documentIds: ["invoices-1"], system: "Be brief.", messages: [question("How many invoices are late?")] });
    out.push({ name: "gemini(): a CSV sent whole, a count", requests: log });
  }
  return out;
}

type Kept = { to: string; body: unknown };
type Recording = { cases: Array<{ name: string; requests: Kept[] }> };
const fileText = (recording: Recording) => `${JSON.stringify(recording, null, 2)}\n`;

describe("questions over files sent whole", () => {
  it("send the bodies test/inline-bodies/defaults.json keeps, byte for byte", async () => {
    const asked = await cases();
    if (RECORD_DEFAULTS) {
      mkdirSync(new URL(".", DEFAULTS), { recursive: true });
      writeFileSync(DEFAULTS, fileText({ cases: asked.map(({ name, requests }) => ({ name, requests: requests.map(({ to, body }) => ({ to, body: JSON.parse(body) as unknown })) })) }));
      return;
    }
    if (!existsSync(DEFAULTS)) throw new Error("test/inline-bodies/defaults.json is not there.");
    const defaults = JSON.parse(readFileSync(DEFAULTS, "utf8")) as Recording;
    expect(asked.map((one) => one.name)).toEqual(defaults.cases.map((one) => one.name));
    for (const [at, { name, requests }] of asked.entries()) {
      const recorded = defaults.cases[at]!.requests;
      expect(requests.map((one) => one.to), name).toEqual(recorded.map((one) => one.to));
      for (const [index, { body }] of requests.entries()) {
        expect(JSON.parse(body), `${name}, request ${index + 1}`).toEqual(recorded[index]!.body);
        expect(body, `${name}, request ${index + 1}: its bytes`).toBe(JSON.stringify(recorded[index]!.body));
      }
    }
  }, 60_000);

  it("send the bodies of 0.9.0, byte for byte, for a library whose prepare is that of 0.9", async () => {
    if (RECORD_DEFAULTS) return;
    const asked = await cases(true);
    const kept = JSON.parse(readFileSync(OF_090, "utf8")) as Recording;
    expect(asked.map((one) => one.name)).toEqual(kept.cases.map((one) => one.name));
    for (const [at, { name, requests }] of asked.entries()) {
      const before = kept.cases[at]!.requests;
      expect(requests.map((one) => one.to), name).toEqual(before.map((one) => one.to));
      for (const [index, { body }] of requests.entries()) {
        expect(JSON.parse(body), `${name}, request ${index + 1}`).toEqual(before[index]!.body);
        expect(body, `${name}, request ${index + 1}: its bytes`).toBe(JSON.stringify(before[index]!.body));
      }
    }
  }, 60_000);
});
