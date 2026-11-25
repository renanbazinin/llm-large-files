// Stored shapes (H7): what earlier versions stored is read by this one, and what a newer version
// stores is refused with a clear error. test/fixtures/stored/<version>/ keeps, for 0.8.2 (no
// version), 0.9.0 and 0.10.2 (metaVersion 1, ToolTurn version 1): the files their FileDocumentStore
// wrote for a log that is searched and a note sent whole (`store/`), and the toolTurns of a question
// that searched and read the log (`tool-turns.json`). Recorded with scripts/record-stored-shapes.mjs
// from a build of each version; never edited by hand.
//
// A version that raises DOCUMENT_META_VERSION or TOOL_TURN_VERSION still reads the shape before it
// (N-1): it records a fixture of the last version that wrote that shape here, and these tests, which
// are written against the two constants, keep passing.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  askWithFiles,
  compactToolTurns,
  createLargeFiles,
  DOCUMENT_META_VERSION,
  DocumentsNotFoundError,
  DocumentStoreError,
  errorInfoOf,
  FileDocumentStore,
  MemoryDocumentStore,
  TOOL_TURN_VERSION,
  type ChatMessage,
  type DocumentMeta,
  type ModelToolRound,
  type ToolTurn,
} from "llm-large-files";
import { anthropicToolTurns } from "llm-large-files/anthropic";
import { askGemini, geminiApi, geminiToolTurns } from "llm-large-files/gemini";
import { openAiToolTurns } from "llm-large-files/openai";
import { calls, fakeFetch, fakeModel, says } from "llm-large-files/testing";

const VERSIONS = ["0.8.2", "0.9.0", "0.10.2"] as const;
type Version = (typeof VERSIONS)[number];
const CLOCK = () => new Date("2026-11-20T08:00:00.000Z");
const NEWER = "The document was stored by a newer version of llm-large-files. Try again.";
type Fixture = { version: Version; log: string; note: string; access: { owner: string; scope?: string[] }; answer: string };
/**
 * Optional fields of DocumentMeta that this version stores for the log and 0.10.2 did not, each
 * with the version that added it: older versions ignore them, so DOCUMENT_META_VERSION stays.
 * None yet.
 */
const ADDED_AFTER_0_10_2: string[] = [];

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const fixturePath = (version: Version, ...parts: string[]) => path.join(fileURLToPath(new URL(`./fixtures/stored/${version}/`, import.meta.url)), ...parts);
const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T;
const turnsOf = (version: Version) => json<ToolTurn[]>(fixturePath(version, "tool-turns.json"));
const withoutVersion = (turns: ToolTurn[]): ToolTurn[] => turns.map(({ version: _version, ...turn }) => turn);

/** A copy of the store a version wrote, opened by this one, with the library's clock at the time of the recording. */
async function opened(version: Version) {
  const fixture = await json<Fixture>(fixturePath(version, "fixture.json"));
  const folder = await mkdtemp(path.join(tmpdir(), "llf-stored-"));
  folders.push(folder);
  await cp(fixturePath(version, "store"), folder, { recursive: true });
  const files = createLargeFiles({ store: new FileDocumentStore(folder, { now: CLOCK }), now: CLOCK, budget: { inlineTokens: 200 } });
  return { fixture, folder, files, access: fixture.access };
}

describe("what earlier versions stored is read (H7)", () => {
  it.each(VERSIONS)("reads the documents %s stored in a FileDocumentStore folder", async (version) => {
    const { fixture, files, access } = await opened(version);
    for (const id of [fixture.log, fixture.note]) {
      expect(await files.getMeta(id, access)).toEqual(await json<DocumentMeta>(fixturePath(version, "store", `${id}.json`)));
    }
    const log = (await files.getMeta(fixture.log, access))!;
    expect(log.metaVersion).toBe(version === "0.8.2" ? undefined : 1);
    if (version === "0.10.2") expect((await files.getMeta(fixture.note, access))?.appData).toEqual({ rowId: "42" });
    const tools = files.tools([log], { access });
    expect(await tools.execute("read_document", { document_id: fixture.log, start_line: 7, end_line: 7 })).toMatchObject({ text: "7| 2026-11-19 12:00:07 ERROR payment worker failed for order 1007" });
    expect(await tools.execute("search_document", { document_id: fixture.log, query: "ERROR", mode: "exact" })).toMatchObject({ total_matching_lines: 4 });
    expect((await files.list!(access)).map((meta) => meta.id)).toEqual([fixture.log, fixture.note].sort());
    const prepared = await files.prepare([fixture.log, fixture.note], { tokens: 0, bytes: 0 }, access);
    expect(prepared.missing).toEqual([]);
    expect(prepared.plan.inline.map((meta) => meta.id)).toEqual([fixture.note]);
    expect(prepared.plan.searchable.map((meta) => meta.id)).toEqual([fixture.log]);
  });

  it.each(VERSIONS)("answers a later question with the tool rounds %s returned", async (version) => {
    const { fixture, files, access } = await opened(version);
    const turns = await turnsOf(version);
    const model = fakeModel([says("At line 7 (app.log L7).")]);
    const messages: ChatMessage[] = [{ role: "user", text: "How many errors?" }, ...turns, { role: "assistant", text: fixture.answer }, { role: "user", text: "Where is the first?" }];
    const result = await askWithFiles({ files, model, documentIds: [fixture.log, fixture.note], messages, ...access });
    expect(result.text).toBe("At line 7 (app.log L7).");
    const rounds = model.requests[0]!.messages.filter((message): message is ModelToolRound => message.role === "tools");
    expect(rounds.map((round) => round.answers.map((answer) => answer.result))).toEqual(turns.map((turn) => turn.calls.map(({ result: { tool_turns_left: _left, ...rest } }) => rest)));
    expect(JSON.stringify(model.requests[0])).not.toContain('"version"');
  });

  it.each(VERSIONS)("gives the rounds %s returned to every reader of stored rounds, which ignores their version", async (version) => {
    const turns = await turnsOf(version);
    expect(compactToolTurns(turns).map((turn) => turn.version)).toEqual(turns.map((turn) => turn.version));
    expect(geminiToolTurns(turns)).toEqual(geminiToolTurns(withoutVersion(turns)));
    expect(openAiToolTurns(turns)).toEqual(openAiToolTurns(withoutVersion(turns)));
    expect(anthropicToolTurns(turns)).toEqual(anthropicToolTurns(withoutVersion(turns)));
  });
});

describe("what a newer version stores is refused (H7)", () => {
  it("refuses metadata of the next metaVersion with NEWER_VERSION where a document is read, and leaves it out where documents are listed", async () => {
    const { files, folder, access } = await opened("0.10.2");
    const file = path.join(folder, "log-1.json");
    const newer = JSON.stringify({ ...await json<DocumentMeta>(file), metaVersion: DOCUMENT_META_VERSION + 1, addedLater: { kept: true } });
    await writeFile(file, newer);
    const error = await files.getMeta("log-1", access).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentStoreError);
    expect(error).toMatchObject({ name: "DocumentStoreError", code: "NEWER_VERSION", operation: "read", status: 503, message: NEWER });
    expect((error as Error).cause).toEqual(new RangeError(`The metadata of log-1 has metaVersion ${DOCUMENT_META_VERSION + 1}; this version of llm-large-files reads up to ${DOCUMENT_META_VERSION}.`));
    expect(errorInfoOf(error)).toMatchObject({ category: "store", code: "NEWER_VERSION", status: 503, retryable: true, message: NEWER });
    expect((await files.list!(access)).map((meta) => meta.id)).toEqual(["notes-1"]);
    const bytes = await readFile(path.join(folder, "log-1.txt"));
    // Never replaced, and never taken for the same upload.
    await expect(files.ingest({ name: "app.log", bytes, id: "log-1", ifExists: "replace", ...access })).rejects.toMatchObject({ code: "NEWER_VERSION" });
    expect(await readFile(file, "utf8")).toBe(newer);
    expect((await files.ingest({ name: "app.log", bytes, dedupe: true, ...access })).id).not.toBe("log-1");
    const model = fakeModel([says("never")]);
    const asked = askWithFiles({ files, model, documentIds: ["log-1"], messages: [{ role: "user", text: "How many errors?" }], ...access });
    await expect(asked).rejects.toBeInstanceOf(DocumentStoreError);
    await expect(asked).rejects.not.toBeInstanceOf(DocumentsNotFoundError);
    expect(model.requests).toHaveLength(0);
  });

  it("refuses a stored round of the next version with a TypeError, in askWithFiles and in every reader of stored rounds, before anything is sent", async () => {
    const turns = (await turnsOf("0.10.2")).map((turn) => ({ ...turn, version: TOOL_TURN_VERSION + 1 }));
    const refusal = new TypeError(`A stored tool round (toolTurns) has version ${TOOL_TURN_VERSION + 1}: a newer version of llm-large-files made it, and this one reads up to version ${TOOL_TURN_VERSION}. Leave it out of messages.`);
    const access = { owner: "user-1", scope: ["user-1", "chat-1"] };
    const files = createLargeFiles({ store: new MemoryDocumentStore({ now: CLOCK }), now: CLOCK });
    const messages: ChatMessage[] = [{ role: "user", text: "How many errors?" }, ...turns, { role: "assistant", text: "4." }, { role: "user", text: "Where is the first?" }];
    const model = fakeModel([says("never")]);
    await expect(askWithFiles({ files, model, documentIds: [], messages, ...access })).rejects.toThrow(refusal);
    expect(model.requests).toHaveLength(0);
    const gemini = fakeFetch([Response.json({})]);
    await expect(askGemini({ files, endpoint: geminiApi({ apiKey: "k", model: "gemini-test" }), fetch: gemini.fetch, documentIds: [], messages, ...access })).rejects.toThrow(refusal);
    expect(gemini.sent).toHaveLength(0);
    for (const read of [compactToolTurns, geminiToolTurns, openAiToolTurns, anthropicToolTurns] as Array<(turns: ToolTurn[]) => unknown>) expect(() => read(turns)).toThrow(refusal);
    const unreadable = [{ ...turns[0]!, version: "1" as unknown as number }];
    expect(() => geminiToolTurns(unreadable)).toThrow(new TypeError('A stored tool round (toolTurns) has a version that is not a number ("1"). Leave it out of messages, or store it as it was given.'));
  });
});

describe("what this version stores (H7)", () => {
  it("stores the metadata fields 0.10.2 stored for the same upload, at the same metaVersion", async () => {
    // A field added or removed here is a decision on metaVersion: see CONTRIBUTING.md, "Stored
    // shapes". An optional field older versions can ignore goes in ADDED_AFTER_0_10_2.
    const { fixture, access } = await opened("0.10.2");
    const folder = await mkdtemp(path.join(tmpdir(), "llf-stored-"));
    folders.push(folder);
    const files = createLargeFiles({ store: new FileDocumentStore(folder, { now: CLOCK }), now: CLOCK });
    const bytes = await readFile(fixturePath("0.10.2", "store", "log-1.txt"));
    await files.ingest({ name: "app.log", bytes, id: fixture.log, ...access });
    const written = await json<Record<string, unknown>>(path.join(folder, "log-1.json"));
    const recorded = await json<Record<string, unknown>>(fixturePath("0.10.2", "store", "log-1.json"));
    expect(Object.keys(written).sort()).toEqual([...Object.keys(recorded), ...ADDED_AFTER_0_10_2].sort());
    expect(written.metaVersion).toBe(DOCUMENT_META_VERSION);
  });

  it("returns tool rounds of the shape 0.10.2 returned", async () => {
    const { fixture, access } = await opened("0.10.2");
    const recorded = await turnsOf("0.10.2");
    const files = createLargeFiles({ store: new MemoryDocumentStore({ now: CLOCK }), now: CLOCK, budget: { inlineTokens: 200 } });
    await files.ingest({ name: "app.log", bytes: await readFile(fixturePath("0.10.2", "store", "log-1.txt")), id: fixture.log, ...access });
    const asked = (turn: ToolTurn) => calls(turn.calls.map(({ result: _result, ...call }) => call));
    const model = fakeModel([asked(recorded[0]!), asked(recorded[1]!), says(fixture.answer)]);
    const result = await askWithFiles({ files, model, documentIds: [fixture.log], messages: [{ role: "user", text: "How many errors?" }], ...access });
    expect(result.toolTurns.map((turn) => Object.keys(turn).sort())).toEqual(recorded.map((turn) => Object.keys(turn).sort()));
    expect(result.toolTurns.map((turn) => turn.calls.map((call) => Object.keys(call).sort()))).toEqual(recorded.map((turn) => turn.calls.map((call) => Object.keys(call).sort())));
    expect(result.toolTurns.map((turn) => turn.version)).toEqual([TOOL_TURN_VERSION, TOOL_TURN_VERSION]);
    expect(result.toolTurns.map((turn) => turn.calls.map(({ name, args }) => ({ name, args })))).toEqual(recorded.map((turn) => turn.calls.map(({ name, args }) => ({ name, args }))));
  });
});
