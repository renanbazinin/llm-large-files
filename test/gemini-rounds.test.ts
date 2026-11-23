// The tool rounds of earlier questions kept as Gemini `contents` (0.9.0): `fromGeminiContents` turns
// the turns `geminiToolTurns` wrote back into stored rounds, so a follow-up asked with `contents`
// is run as one asked with `messages` and `toolTurns`: a repeated call gets a pointer, and the
// rounds can be shortened. The first request stays the same, byte for byte.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, TOOL_TURN_VERSION, type AskEvent, type ChatTurn, type ToolTurn } from "llm-large-files";
import { askGemini, fromGeminiContents, geminiApi, geminiToolTurns, type GeminiContent } from "llm-large-files/gemini";
import { fakeFetch, serviceLog, utf8, type Sent } from "llm-large-files/testing";

const endpoint = geminiApi({ apiKey: "k", model: "gemini-test" });
const say = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10 } });
const callAll = (calls: Array<{ name: string; args: Record<string, unknown> }>) => Response.json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: calls.map((call) => ({ functionCall: call })) } }], usageMetadata: { promptTokenCount: 10 } });
/** True when the last turn sent answers function calls. */
const answered = (sent: Sent) => (sent.body.contents as GeminiContent[]).at(-1)!.parts.some((part) => part.functionResponse !== undefined);

async function setUp() {
  const files = createLargeFiles({ store: new MemoryDocumentStore() });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(20_000)) });
  const search = { name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
  const read = { name: "read_document", args: { document_id: meta.id, start_line: 1, end_line: 400 } };
  /** A Gemini that calls both tools while it may, then answers. */
  const gemini = () => fakeFetch([(sent) => (sent.body.tools && !answered(sent) ? callAll([search, read]) : say("51 errors."))]);
  const first = gemini();
  const q1 = await askGemini({ files, endpoint, fetch: first.fetch, documentIds: [meta.id], messages: [{ role: "user", text: "errors?" }] });
  return { files, meta, gemini, q1 };
}

async function followUp(files: Awaited<ReturnType<typeof setUp>>["files"], fetch: typeof globalThis.fetch, documentIds: string[], history: { messages: Array<ChatTurn | ToolTurn> } | { contents: GeminiContent[] }) {
  const events: AskEvent[] = [];
  const result = await askGemini({ files, endpoint, fetch, documentIds, onEvent: (event) => events.push(event), ...history });
  const first = events.find((event) => event.type === "request.start");
  const outcomes = events.flatMap((event) => (event.type === "tool.end" ? [event.outcome] : []));
  return { result, estimated: first?.type === "request.start" ? first.estimatedInputTokens : undefined, outcomes };
}

describe("a follow-up asked with Gemini contents", () => {
  it("answers a repeated call with a pointer, as one asked with toolTurns does", async () => {
    const { files, meta, gemini, q1 } = await setUp();
    const viaTurns = await followUp(files, gemini().fetch, [meta.id], { messages: [{ role: "user", text: "errors?" }, ...q1.toolTurns, { role: "assistant", text: q1.text }, { role: "user", text: "again?" }] });
    const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "errors?" }] }, ...geminiToolTurns(q1.toolTurns), { role: "model", parts: [{ text: q1.text }] }, { role: "user", parts: [{ text: "again?" }] }];
    const viaContents = await followUp(files, gemini().fetch, [meta.id], { contents });
    // The search is pointed to. (The read was cut to the room of its turn, so it is run again.)
    expect(viaTurns.outcomes).toEqual(["already_shown", "ok"]);
    expect(viaContents.outcomes).toEqual(viaTurns.outcomes);
    // Sized alike: the same rounds.
    expect(viaContents.estimated).toBe(viaTurns.estimated);
  });

  it("sends the same first request, byte for byte, as with toolTurns", async () => {
    const { files, meta, gemini, q1 } = await setUp();
    const viaTurns = gemini();
    await followUp(files, viaTurns.fetch, [meta.id], { messages: [{ role: "user", text: "errors?" }, ...q1.toolTurns, { role: "assistant", text: q1.text }, { role: "user", text: "more?" }] });
    const viaContents = gemini();
    await followUp(files, viaContents.fetch, [meta.id], { contents: [{ role: "user", parts: [{ text: "errors?" }] }, ...geminiToolTurns(q1.toolTurns), { role: "model", parts: [{ text: q1.text }] }, { role: "user", parts: [{ text: "more?" }] }] });
    expect(JSON.stringify(viaContents.sent[0]!.body)).toBe(JSON.stringify(viaTurns.sent[0]!.body));
  });
});

describe("contents that end with the responses of the library's tools", () => {
  it("are answered, as in 0.8.2: an application that ran the tools in its own loop hands them over", async () => {
    // 0.9.0 before its checks lifted the last round too, and the question failed with "The last
    // message must be the user's."
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
    const args = { document_id: meta.id, query: "ERROR", mode: "exact" };
    const turns: ToolTurn[] = [{ role: "tools", calls: [{ name: "search_document", args, result: await files.tools([meta]).execute("search_document", args) }] }];
    const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "How many errors?" }] }, ...geminiToolTurns(turns)];
    const gemini = fakeFetch([say("51.")]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], contents });
    expect(result).toMatchObject({ answered: true, text: "51." });
    // The responses are sent as they were given, as the last turn.
    expect((gemini.sent[0]!.body.contents as GeminiContent[]).slice(-2)).toEqual(contents.slice(-2));
  });
});

describe("fromGeminiContents", () => {
  const search = { name: "search_document", args: { document_id: "doc_a", query: "ERROR", mode: "exact" } };
  const result = { document: "app.log", mode: "exact", total_matching_lines: 2, matches: [] };

  it("turns a round of the library's tools back into a stored round, with its ids", () => {
    const turns: ToolTurn[] = [{ role: "tools", calls: [{ id: "c1", ...search, result }, { name: "get_document_overview", args: { document_id: "doc_a" }, result: { document: "app.log", lines: 5 } }] }];
    expect(fromGeminiContents([{ role: "user", parts: [{ text: "?" }] }, ...geminiToolTurns(turns), { role: "model", parts: [{ text: "2." }] }])).toEqual([
      { role: "user", parts: [{ text: "?" }] },
      { role: "tools", version: TOOL_TURN_VERSION, calls: turns[0]!.calls },
      { role: "assistant", parts: [{ text: "2." }] },
    ]);
  });

  it("leaves a round at the end of contents as it is: its responses are the turn to answer", () => {
    const contents: GeminiContent[] = [{ role: "user", parts: [{ text: "?" }] }, ...geminiToolTurns([{ role: "tools", calls: [{ ...search, result }] }])];
    const converted = fromGeminiContents(contents);
    expect(converted.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(converted.flatMap((message) => ("parts" in message ? message.parts.map((part) => part.native ?? { text: part.text }) : []))).toEqual(contents.flatMap((content) => content.parts));
  });

  it("leaves an application's own function turns as they are, sized by their JSON", () => {
    const own: GeminiContent[] = [
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Haifa" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { celsius: 31 } } }] },
    ];
    expect(fromGeminiContents(own)).toEqual([
      { role: "assistant", parts: [{ native: own[0]!.parts[0], text: JSON.stringify({ name: "get_weather", args: { city: "Haifa" } }) }] },
      { role: "user", parts: [{ native: own[1]!.parts[0], text: JSON.stringify({ name: "get_weather", response: { celsius: 31 } }) }] },
    ]);
  });

  it("leaves a round as it is when anything in it is not the library's plain form", () => {
    const response = { role: "user" as const, parts: [{ functionResponse: { name: search.name, response: result } }] };
    const cases: GeminiContent[][] = [
      // A thought signature, which Gemini wants back as it is.
      [{ role: "model", parts: [{ functionCall: search, thoughtSignature: "sig" }] }, response],
      // A call of the application's own next to one of the library's.
      [{ role: "model", parts: [{ functionCall: search }, { functionCall: { name: "get_weather", args: {} } }] }, { role: "user", parts: [...response.parts, { functionResponse: { name: "get_weather", response: {} } }] }],
      // Responses that do not match the calls: another name, another id, one missing.
      [{ role: "model", parts: [{ functionCall: search }] }, { role: "user", parts: [{ functionResponse: { name: "read_document", response: result } }] }],
      [{ role: "model", parts: [{ functionCall: { ...search, id: "c1" } }] }, { role: "user", parts: [{ functionResponse: { name: search.name, id: "c2", response: result } }] }],
      [{ role: "model", parts: [{ functionCall: search }] }, { role: "user", parts: [{ text: "?" }] }],
      [{ role: "model", parts: [{ functionCall: search }] }],
      // A file inside the response, which a stored round cannot hold.
      [{ role: "model", parts: [{ functionCall: search }] }, { role: "user", parts: [{ functionResponse: { name: search.name, response: result, parts: [{ inlineData: { mimeType: "application/pdf", data: "JVBE" } }] } }] }],
    ];
    for (const [index, contents] of cases.entries()) {
      const converted = fromGeminiContents(contents);
      expect(converted.every((message) => message.role !== "tools"), String(index)).toBe(true);
      expect(converted.flatMap((message) => ("parts" in message ? message.parts.map((part) => part.native ?? { text: part.text }) : [])), String(index)).toEqual(contents.flatMap((content) => content.parts));
    }
  });

  it("keeps every turn as it is with rounds: false, as 0.8 did", () => {
    const contents = geminiToolTurns([{ role: "tools", calls: [{ ...search, result }] }]);
    const converted = fromGeminiContents(contents, { rounds: false });
    expect(converted.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(converted.flatMap((message) => ("parts" in message ? message.parts.map((part) => part.native) : []))).toEqual(contents.flatMap((content) => content.parts));
  });
});
