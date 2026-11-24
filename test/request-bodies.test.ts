// The bytes of the requests the library sends, for the questions of the ask, explorer,
// missing-document, Gemini, OpenAI and Claude fixtures below, kept in test/request-bodies/*.json.
// Recorded on 0.9.0, before the first change of 0.10.0 to src/. A change to src/ that is not meant
// to change what a model is sent must leave every body equal, byte for byte. The whole-file reads of
// the OpenAI and Claude fixtures came later, and were recorded on the source of 0.9.0 too.
//
// What is recorded:
// - for a fake model (`fakeModel` of llm-large-files/testing): each `ModelRequest` given to `send`,
//   and each request given to `generateText` (its system, prompt and maxOutputTokens), as
//   JSON.stringify makes them at the moment they are sent. A field set to undefined is left out,
//   as in JSON;
// - for a real adapter (`gemini()`, `openAiCompatible()`, `anthropic()`) over `fakeFetch`: each body
//   as the bytes it posted, and the URL it posted to.
// Each file keeps the bodies as parsed JSON, so that a change reads as a diff. The test checks that
// each body is JSON.stringify of what the file keeps: nothing is lost in between.
//
// What keeps them the same on every run: documents ingested under fixed IDs (their frame marks come
// from the IDs), tool calls with fixed IDs, and a fixed clock for the library and the store. No
// clock or random value reaches a body. One thing is put in order: the requests of a whole-file
// read run a few at once, so a run of them with the same system text (the parts, the merges) is
// sorted by its bytes. Nothing else is normalized.
//
// A change that is meant to change the text sent (a prompt, a declaration, a card) records the files
// again, in the same change, and the diff of the JSON files is reviewed with it:
//
//   RECORD_REQUEST_BODIES=1 npx vitest run --project unit test/request-bodies.test.ts
//
// A file that is not there is written by that command too; without it, the test fails.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  MemoryDocumentStore,
  type AskOptions,
  type AskResult,
  type ChatMessage,
  type GenerateText,
  type LargeFiles,
  type ModelAdapter,
} from "llm-large-files";
import { anthropic } from "llm-large-files/anthropic";
import { askGemini, geminiApi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { calls, fakeFetch, fakeModel, says, serviceLog, sse, utf8, type FakeModel, type FakeReply } from "llm-large-files/testing";

/** Set to "1" to write the files from this run instead of comparing with them. */
const RECORD = process.env.RECORD_REQUEST_BODIES === "1";
const FOLDER = new URL("./request-bodies/", import.meta.url);

/** One request as it was sent: to which model (a fake's id, or "generateText") or URL, and its body as its bytes. */
type Sent = { to: string; body: string };
/** A question of a fixture, and the requests it made, in order. */
type Case = { name: string; requests: Sent[] };

// The library and its documents, the same on every run.

const CLOCK = () => new Date("2026-11-20T08:00:00.000Z");
const question = (text: string) => ({ role: "user" as const, text });

/** A small CSV of sales, large enough to be searched (`inlineTokens` is 1,000), so aggregate_table is offered. */
function sales(rows: number): string {
  const regions = ["North", "South", "East", "West"];
  const lines = ["Date,Region,Product,Amount"];
  for (let n = 1; n <= rows; n++) lines.push(`2026-${String((n % 12) + 1).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")},${regions[n % 4]},P-${n % 17},${(n * 37) % 1000}`);
  return lines.join("\n");
}

/**
 * A library over a fresh memory store, with a fixed clock, and these documents under fixed IDs: a
 * note sent whole ("notes-1"), a log ("log-1", 5,000 lines) and a CSV ("sales-1") searched with the
 * tools, a short log for whole-file reads ("short-log-1", 300 lines), and "old-1", which was deleted.
 */
async function library(budget: Record<string, number> = {}): Promise<LargeFiles> {
  const files = createLargeFiles({ store: new MemoryDocumentStore({ now: CLOCK }), now: CLOCK, budget: { inlineTokens: 1_000, ...budget } });
  await files.ingest({ name: "notes.md", bytes: utf8("# Notes\n\nThe code word is heron.\nThe nightly import runs at 02:00 UTC.\n"), id: "notes-1" });
  await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)), id: "log-1" });
  await files.ingest({ name: "sales.csv", bytes: utf8(sales(400)), id: "sales-1" });
  await files.ingest({ name: "short.log", bytes: utf8(serviceLog(300)), id: "short-log-1" });
  await files.ingest({ name: "old.txt", bytes: utf8("The old total was 7.\n"), id: "old-1" });
  await files.delete("old-1");
  return files;
}

// Recording.

/** A fake model whose requests are kept, as JSON at the moment they are sent. */
function recorded(model: FakeModel, log: Sent[]): ModelAdapter {
  return {
    ...model,
    send(request, hooks) {
      log.push({ to: model.id, body: JSON.stringify(request) });
      return model.send(request, hooks);
    },
  };
}

/** A part reader for a fake model: its requests are kept, and `reply` answers them. */
function reader(log: Sent[], reply: (request: Parameters<GenerateText>[0]) => string): GenerateText {
  return async (request) => {
    log.push({ to: "generateText", body: JSON.stringify({ system: request.system, prompt: request.prompt, maxOutputTokens: request.maxOutputTokens }) });
    return reply(request);
  };
}

/** `fakeFetch` of llm-large-files/testing, which also keeps each body as the bytes that were posted, and its URL. */
function recordingFetch(replies: FakeReply[], log: Sent[]): typeof globalThis.fetch {
  const fake = fakeFetch(replies);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    log.push({ to: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return fake.fetch(input, init);
  }) as typeof globalThis.fetch;
}

/** The system text of a request of a whole-file read, or undefined for a request of the chat. */
function readSystem(sent: Sent): string | undefined {
  return readSystemOf(sent.to, JSON.parse(sent.body) as ReadBody);
}

/** What `readSystemOf` reads of a body, in the shape of each fixture's model. */
type ReadBody = {
  system?: string;
  systemInstruction?: { role?: string; parts?: Array<{ text?: string }> };
  messages?: Array<{ content?: unknown }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
};

/** The system text of a request posted to `to`, when it is one of a whole-file read. */
function readSystemOf(to: string, body: ReadBody): string | undefined {
  if (to === "generateText") return body.system;
  // OpenAI's requests of a whole-file read (its generateText) set an output limit; its chat requests here do not.
  if (to.startsWith("https://api.openai.com/")) {
    const system = body.messages?.[0]?.content;
    return (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) && typeof system === "string" ? system : undefined;
  }
  // Claude's chat requests here stream, as by default; its requests of a whole-file read do not.
  if (to.startsWith("https://api.anthropic.com/")) return body.stream === true ? undefined : body.system;
  // Gemini's part reads (createGeminiGenerateText) give their system instruction a role; its chat requests do not.
  return body.systemInstruction?.role === "system" ? body.systemInstruction.parts?.[0]?.text : undefined;
}

/** Notes of a part long enough that the notes of three parts of about 8,000 tokens need a merge. */
const LONG_NOTES = `Notes on these lines (L1). ${"The worker answered the orders route in time. ".repeat(450)}`;

/** What answers a request of a whole-file read, told by its system text: a part's notes, a merge, or the read's answer. */
const readReply = (system: string) => (system.startsWith("You read one part") ? LONG_NOTES : system.startsWith("You merge") ? "Merged notes (L1)." : "Every request was answered in time (L1).");

/** The requests in the order they are kept: each run of whole-file reads with the same system text sorted by its bytes. */
function settled(requests: Sent[]): Sent[] {
  const out: Sent[] = [];
  for (let index = 0; index < requests.length;) {
    const system = readSystem(requests[index]!);
    let end = index + 1;
    if (system !== undefined) while (end < requests.length && readSystem(requests[end]!) === system) end++;
    out.push(...requests.slice(index, end).sort((left, right) => (left.body < right.body ? -1 : left.body > right.body ? 1 : 0)));
    index = end;
  }
  return out;
}

/** The conversation of a follow-up question: the first question, its tool rounds and answer, then the next question. */
const followUp = (first: string, result: AskResult, next: string): ChatMessage[] => [
  question(first),
  ...result.toolTurns,
  { role: "assistant", text: result.text },
  question(next),
];

// The fixtures.

/** askWithFiles with one fake model: the tool loop, a follow-up on its stored rounds, a direct answer, a whole-file read. */
async function askCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const files = await library();
  {
    const log: Sent[] = [];
    const search = { id: "c1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
    const totals = { id: "c2", name: "aggregate_table", args: { document_id: "sales-1", metrics: ["count", "sum:Amount"], group_by: ["Region"] } };
    const read = { id: "c3", name: "read_document", args: { document_id: "log-1", start_line: 95, end_line: 99 } };
    const model = fakeModel([calls([search, totals], { text: "Checking." }), calls([read]), says("51 errors (app.log L97). North sold the most.")], { generateText: reader(log, () => "unused") });
    const first = await askWithFiles({
      files, model: recorded(model, log), documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.",
      messages: [question("How many errors are in the log, and which region sold the most?")],
    });
    cases.push({ name: "an inline note and two searched files: two tool turns, then the answer", requests: log });

    const again: Sent[] = [];
    const next = fakeModel([calls([{ ...search, id: "c4" }]), says("Still 51.")], { generateText: reader(again, () => "unused") });
    await askWithFiles({
      files, model: recorded(next, again), documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.",
      messages: followUp("How many errors are in the log, and which region sold the most?", first, "Are you sure about the errors?"),
    });
    cases.push({ name: "a follow-up on the stored rounds: a repeated search answered with a pointer", requests: again });
  }
  {
    const log: Sent[] = [];
    const model = fakeModel([says("Heron.")]);
    await askWithFiles({ files, model: recorded(model, log), documentIds: ["notes-1"], system: "Be brief.", documentPlacement: "last", messages: [question("What is the code word?")] });
    cases.push({ name: "a note sent whole at the end of the last turn: one request, no tools", requests: log });
  }
  {
    // Parts of about 8,000 tokens: three parts, whose long notes need a merge before the answer.
    const small = await library({ mapChunkTokens: 8_000 });
    const log: Sent[] = [];
    const generateText = reader(log, (request) => readReply(request.system));
    const model = fakeModel([calls([{ id: "c1", name: "analyze_whole_document", args: { document_id: "short-log-1", task: "Summarize the log." } }]), says("All in time.")], { generateText });
    await askWithFiles({ files: small, model: recorded(model, log), documentIds: ["short-log-1"], messages: [question("Summarize short.log.")] });
    cases.push({ name: "a whole-file read: parts, a merge, the read's answer, then the answer", requests: settled(log) });
  }
  return cases;
}

/** An explorer model that makes the tool calls, and another that answers: fake models, then askGemini. */
async function explorerCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const files = await library();
  {
    const log: Sent[] = [];
    const search = { id: "c1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
    const explorer = fakeModel([calls([search], { text: "Searching." }), says("DONE")], { id: "fake-explorer", generateText: reader(log, () => "unused") });
    const model = fakeModel([says("51 errors (app.log L97).")], { id: "fake-answer" });
    await askWithFiles({ files, model: recorded(model, log), explorer: recorded(explorer, log), documentIds: ["notes-1", "log-1"], system: "Be brief.", messages: [question("How many errors?")] });
    cases.push({ name: "fake models: the explorer searches and says DONE, the other model answers", requests: log });
  }
  {
    const log: Sent[] = [];
    const endpoint = geminiApi({ apiKey: "test-key", model: "gemini-answer", explorerModel: "gemini-explorer" });
    const search = { id: "call-1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
    const fetch = recordingFetch([
      Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Searching.", thought: true }, { functionCall: search, thoughtSignature: "signature-1" }] }, finishReason: "STOP" }] }),
      Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "DONE" }] }, finishReason: "STOP" }] }),
      Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "51 errors (app.log L97)." }] }, finishReason: "STOP" }] }),
    ], log);
    await askGemini({ files, endpoint, fetch, documentIds: ["notes-1", "log-1"], system: "Be brief.", generationConfig: { temperature: 0.2 }, messages: [question("How many errors?")] });
    cases.push({ name: "askGemini with an explorer model: two explorer turns, then the answer", requests: log });
  }
  return cases;
}

/** Documents that are gone when the question is asked: left out ("drop"), or replaced. */
async function missingCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const files = await library();
  {
    const log: Sent[] = [];
    const search = { id: "c1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
    const model = fakeModel([calls([search]), says("51 errors.")]);
    await askWithFiles({ files, model: recorded(model, log), documentIds: ["notes-1", "log-1", "old-1"], onMissingDocuments: "drop", messages: [question("How many errors?")] });
    cases.push({ name: "drop: the gone file is left out, and the system text says so", requests: log });
  }
  {
    const log: Sent[] = [];
    const model = fakeModel([says("That file is no longer available.")]);
    await askWithFiles({ files, model: recorded(model, log), documentIds: ["old-1"], onMissingDocuments: "drop", system: "Be brief.", messages: [question("What was the old total?")] });
    cases.push({ name: "drop: no file is left, a plain chat", requests: log });
  }
  {
    const log: Sent[] = [];
    const model = fakeModel([says("The new total is 9.")]);
    const onMissingDocuments: AskOptions["onMissingDocuments"] = async () => {
      await files.ingest({ name: "old.txt", bytes: utf8("The new total is 9.\n"), id: "new-1", ifExists: "replace" });
      return { replace: { "old-1": "new-1" } };
    };
    await askWithFiles({ files, model: recorded(model, log), documentIds: ["notes-1", "old-1"], onMissingDocuments, messages: [question("What is the total?")] });
    cases.push({ name: "replace: the gone file ingested again under a new ID", requests: log });
  }
  return cases;
}

const geminiText = (text: string) => Response.json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20, totalTokenCount: 920 } });

/** askGemini over the Gemini API: a tool turn, a follow-up on its stored rounds, a whole-file read. */
async function geminiCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const files = await library();
  const endpoint = geminiApi({ apiKey: "test-key", model: "gemini-test" });
  const asked = "How many errors are in the log?";
  {
    const log: Sent[] = [];
    const search = { id: "call-1", name: "search_document", args: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
    const fetch = recordingFetch([
      Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Checking." }, { functionCall: search, thoughtSignature: "signature-1" }] }, finishReason: "STOP" }] }),
      geminiText("51 errors (app.log L97)."),
    ], log);
    const first = await askGemini({ files, endpoint, fetch, documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.", generationConfig: { temperature: 0.2 }, messages: [question(asked)] });
    cases.push({ name: "a tool turn with a thought signature, then the answer", requests: log });

    const again: Sent[] = [];
    const next = recordingFetch([geminiText("Yes, 51.")], again);
    await askGemini({ files, endpoint, fetch: next, documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.", generationConfig: { temperature: 0.2 }, messages: followUp(asked, first, "Are you sure?") });
    cases.push({ name: "a follow-up on the stored rounds", requests: again });
  }
  {
    const small = await library({ mapChunkTokens: 8_000 });
    const log: Sent[] = [];
    const analyze = { id: "call-1", name: "analyze_whole_document", args: { document_id: "short-log-1", task: "Summarize the log." } };
    const fetch = recordingFetch([(sent) => {
      // A part read, or the read's answer: Gemini's part reads give their system instruction a role.
      if (sent.body.systemInstruction?.role === "system") return geminiText(String(sent.body.systemInstruction.parts[0].text).startsWith("You read one part") ? "Requests answered in time (L1)." : "Every request was answered in time (L1).");
      const called = (sent.body.contents as Array<{ parts: Array<Record<string, unknown>> }>).some((content) => content.parts.some((part) => "functionResponse" in part));
      return called ? geminiText("All in time.") : Response.json({ candidates: [{ content: { role: "model", parts: [{ functionCall: analyze }] }, finishReason: "STOP" }] });
    }], log);
    await askGemini({ files: small, endpoint, fetch, documentIds: ["short-log-1"], messages: [question("Summarize short.log.")] });
    cases.push({ name: "a whole-file read: part reads and their answer, then the answer", requests: settled(log) });
  }
  return cases;
}

const openAiReply = (message: Record<string, unknown>, finish = "stop") => Response.json({ id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }], usage: { prompt_tokens: 900, completion_tokens: 30 } });

/** openAiCompatible: a tool turn, a follow-up on its stored rounds, a whole-file read. */
async function openAiCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const files = await library();
  const asked = "How many errors are in the log?";
  const log: Sent[] = [];
  const toolCall = { id: "call_1", type: "function", function: { name: "search_document", arguments: JSON.stringify({ document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 }) } };
  const model = openAiCompatible({ model: "gpt-test", apiKey: "test-key", fetch: recordingFetch([openAiReply({ content: null, tool_calls: [toolCall] }, "tool_calls"), openAiReply({ content: "51 errors (app.log L97)." })], log) });
  const first = await askWithFiles({ files, model, documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.", messages: [question(asked)] });
  cases.push({ name: "a tool turn, then the answer", requests: log });

  const again: Sent[] = [];
  const next = openAiCompatible({ model: "gpt-test", apiKey: "test-key", fetch: recordingFetch([openAiReply({ content: "Yes, 51." })], again) });
  await askWithFiles({ files, model: next, documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.", messages: followUp(asked, first, "Are you sure?") });
  cases.push({ name: "a follow-up on the stored rounds", requests: again });

  // Parts of about 8,000 tokens: three part reads, a merge of their long notes, the read's answer.
  const small = await library({ mapChunkTokens: 8_000 });
  const read: Sent[] = [];
  const analyze = { id: "call_1", type: "function", function: { name: "analyze_whole_document", arguments: JSON.stringify({ document_id: "short-log-1", task: "Summarize the log." }) } };
  const reads = openAiCompatible({ model: "gpt-test", apiKey: "test-key", fetch: recordingFetch([(sent) => {
    const system = readSystemOf(sent.url, sent.body);
    if (system !== undefined) return openAiReply({ content: readReply(system) });
    const called = (sent.body.messages as Array<{ role: string }>).some((message) => message.role === "tool");
    return called ? openAiReply({ content: "All in time." }) : openAiReply({ content: null, tool_calls: [analyze] }, "tool_calls");
  }], read) });
  await askWithFiles({ files: small, model: reads, documentIds: ["short-log-1"], messages: [question("Summarize short.log.")] });
  cases.push({ name: "a whole-file read: parts, a merge, the read's answer, then the answer", requests: settled(read) });
  return cases;
}

/** A streamed Claude message, as the Messages API sends it: text and tool input in one piece each. */
function claudeStream(content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }>, stop: string): Response {
  const events: unknown[] = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 900, output_tokens: 1 } } }];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 30 } }, { type: "message_stop" });
  return sse(events);
}

/** A Claude message that is not streamed, as a part read gets it. */
const claudeMessage = (text: string) => Response.json({ id: "msg_2", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 30 } });

/** anthropic(), streamed as by default: a tool turn, a follow-up on its stored rounds, a whole-file read. */
async function anthropicCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const files = await library();
  const asked = "How many errors are in the log?";
  const log: Sent[] = [];
  const search = { type: "tool_use" as const, id: "toolu_1", name: "search_document", input: { document_id: "log-1", query: "ERROR", mode: "exact", max_results: 3 } };
  const model = anthropic({ model: "claude-test", apiKey: "test-key", fetch: recordingFetch([claudeStream([{ type: "text", text: "Checking." }, search], "tool_use"), claudeStream([{ type: "text", text: "51 errors (app.log L97)." }], "end_turn")], log) });
  const first = await askWithFiles({ files, model, documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.", messages: [question(asked)] });
  cases.push({ name: "a tool turn, then the answer", requests: log });

  const again: Sent[] = [];
  const next = anthropic({ model: "claude-test", apiKey: "test-key", fetch: recordingFetch([claudeStream([{ type: "text", text: "Yes, 51." }], "end_turn")], again) });
  await askWithFiles({ files, model: next, documentIds: ["notes-1", "log-1", "sales-1"], system: "Be brief.", messages: followUp(asked, first, "Are you sure?") });
  cases.push({ name: "a follow-up on the stored rounds", requests: again });

  // Parts of about 8,000 tokens: three part reads, a merge of their long notes, the read's answer.
  const small = await library({ mapChunkTokens: 8_000 });
  const read: Sent[] = [];
  const analyze = { type: "tool_use" as const, id: "toolu_1", name: "analyze_whole_document", input: { document_id: "short-log-1", task: "Summarize the log." } };
  const reads = anthropic({ model: "claude-test", apiKey: "test-key", fetch: recordingFetch([(sent) => {
    const system = readSystemOf(sent.url, sent.body);
    if (system !== undefined) return claudeMessage(readReply(system));
    const called = (sent.body.messages as Array<{ content: unknown }>).some((message) => Array.isArray(message.content) && message.content.some((block: { type?: string }) => block.type === "tool_result"));
    return called ? claudeStream([{ type: "text", text: "All in time." }], "end_turn") : claudeStream([analyze], "tool_use");
  }], read) });
  await askWithFiles({ files: small, model: reads, documentIds: ["short-log-1"], messages: [question("Summarize short.log.")] });
  cases.push({ name: "a whole-file read: parts, a merge, the read's answer, then the answer", requests: settled(read) });
  return cases;
}

const FIXTURES: Array<[name: string, run: () => Promise<Case[]>]> = [
  ["ask", askCases],
  ["explorer", explorerCases],
  ["missing-documents", missingCases],
  ["gemini", geminiCases],
  ["openai", openAiCases],
  ["anthropic", anthropicCases],
];

/** A recorded request as its file keeps it: the body parsed, so that a change reads as a diff. */
type Kept = { to: string; body: unknown };
type Recording = { fixture: string; cases: Array<{ name: string; requests: Kept[] }> };

const fileText = (recording: Recording) => `${JSON.stringify(recording, null, 2)}\n`;

describe("the request bodies of 0.9.0", () => {
  for (const [fixture, run] of FIXTURES) {
    it(`${fixture}: every body is the same, byte for byte`, async () => {
      const cases = await run();
      const recording: Recording = {
        fixture,
        cases: cases.map(({ name, requests }) => ({ name, requests: requests.map(({ to, body }) => ({ to, body: JSON.parse(body) as unknown })) })),
      };
      // The file keeps each body parsed: it must give back the very bytes that were sent.
      for (const { name, requests } of cases) {
        for (const [index, { body }] of requests.entries()) expect(JSON.stringify(JSON.parse(body)), `${name}, request ${index + 1}: a body JSON does not give back`).toBe(body);
      }
      const file = new URL(`${fixture}.json`, FOLDER);
      if (RECORD) {
        mkdirSync(FOLDER, { recursive: true });
        writeFileSync(file, fileText(recording));
        return;
      }
      if (!existsSync(file)) throw new Error(`test/request-bodies/${fixture}.json is not there: record it with RECORD_REQUEST_BODIES=1 npx vitest run --project unit test/request-bodies.test.ts`);
      const text = readFileSync(file, "utf8");
      const kept = JSON.parse(text) as Recording;
      expect(cases.map((one) => one.name), "the cases").toEqual(kept.cases.map((one) => one.name));
      for (const [at, { name, requests }] of cases.entries()) {
        const before = kept.cases[at]!.requests;
        expect(requests.map((one) => one.to), `${name}: where each request went`).toEqual(before.map((one) => one.to));
        for (const [index, { body }] of requests.entries()) {
          // The parsed body first, for a readable diff; then its bytes, which also see the order of keys and escapes.
          expect(JSON.parse(body), `${name}, request ${index + 1}`).toEqual(before[index]!.body);
          expect(body, `${name}, request ${index + 1}: its bytes`).toBe(JSON.stringify(before[index]!.body));
        }
      }
      expect(fileText(recording), `test/request-bodies/${fixture}.json`).toBe(text);
    }, 60_000);
  }
});
