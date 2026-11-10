import { getDocumentProxy } from "unpdf";
import { describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { askGemini, FINAL_ANSWER_AFTER_PAGES, FINAL_ANSWER_REQUEST, geminiApi, geminiFunctionResponses, geminiFunctionResponseTurns } from "llm-large-files/gemini";
import { numberedPdf, pdfWithPictures, utf8 } from "./pdf-fixtures.js";

const endpoint = geminiApi({ apiKey: "test-key", model: "gemini-test" });
const question = (text: string) => [{ role: "user" as const, text }];
const say = (value: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] });
const call = (name: string, args: Record<string, unknown>, id?: string) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args, ...(id ? { id } : {}) } }] } }] });
const pageLine = (number: number) => `Page ${number} of the test file.`;

type Body = Record<string, any>;

/** A Gemini that answers each request from a script. The last entry repeats. */
function fakeGemini(replies: Array<object | ((body: Body) => object)>) {
  const bodies: Body[] = [];
  const sizes: number[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body);
    sizes.push(Buffer.byteLength(raw));
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
    return Response.json(typeof reply === "function" ? reply(body) : reply);
  });
  return { fetch, bodies, sizes };
}

const toolNames = (body: Body): string[] => (body.tools?.[0]?.functionDeclarations ?? []).map((tool: { name: string }) => tool.name);
const systemOf = (body: Body): string => body.systemInstruction?.parts?.[0]?.text ?? "";
/** The function responses of the latest turn of a request that holds any. Files sent beside them make a later turn. */
const responsesOf = (body: Body): Array<Record<string, any>> => {
  const turns = (body.contents as Body[]).filter((content) => content.parts.some((part: Body) => part.functionResponse));
  return (turns.at(-1)?.parts ?? []).filter((part: Body) => part.functionResponse).map((part: Body) => part.functionResponse);
};
/** The PDFs in a request, wherever they are: inside function responses, or in a turn of their own. */
const pdfsOf = (body: Body): string[] => (body.contents as Body[]).flatMap((content) => content.parts as Body[])
  .flatMap((part) => [part, ...((part.functionResponse?.parts ?? []) as Body[])])
  .filter((part) => part.inlineData?.mimeType === "application/pdf").map((part) => part.inlineData.data as string);
const PLACEMENTS = ["inside", "beside"] as const;

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const texts: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const content = await (await document.getPage(number)).getTextContent();
    texts.push((content.items as Array<{ str?: string }>).map((item) => item.str ?? "").join("").trim());
  }
  return texts;
}

// The tool guide of 0.2.0, word for word: a library that keeps no originals must still send it.
const GUIDE_0_2_0 = (names: string) => [
  `Some attached files are too large for your context: ${names}.`,
  "You see only a summary card for each. Read them through the tools:",
  "- search_document finds lines (exact or regex) or the most relevant passages (keywords).",
  "- read_document reads a line range. Read around search hits before you rely on them.",
  "- get_document_overview returns the outline, log profile, and the start and end of a file.",
  "- analyze_whole_document reads the entire file in parts. Use it only when the task needs all of it (a full summary, every occurrence, a timeline). It is slow and costly.",
  "You have a limited number of tool turns. Call several tools in the same turn when the searches do not depend on each other, and answer as soon as you have enough evidence.",
  "Base your answer on text you actually read. Cite line numbers like (app.log L1203). If the tools did not find something, say so rather than guessing.",
].join("\n");

describe("askGemini with PDFs whose pages can be shown", () => {
  it("offers only view_pages for a PDF whose text is sent whole, and puts the pages inside the function response", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const gemini = fakeGemini([call("view_pages", { document_id: meta.id, from_page: 2, to_page: 3 }, "call-1"), say("Page 2 shows a bar chart.")]);
    const activity: string[] = [];
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], system: "Be brief.", messages: question("What does the chart on page 2 show?"), onActivity: (value) => activity.push(value) });

    // The first request: the whole text, one tool, and a guide that names the PDF and its ID.
    const [first, second] = gemini.bodies;
    expect(result.plan.inline.map((document) => document.name)).toEqual(["report.pdf"]);
    expect(result.plan.searchable).toEqual([]);
    expect(first!.contents[0].parts[0].text).toContain(pageLine(5));
    expect(toolNames(first!)).toEqual(["view_pages"]);
    expect(first!.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    const system = systemOf(first!);
    expect(system.startsWith("Be brief.\n\nThe text of a PDF does not show its pictures, charts or diagrams.")).toBe(true);
    expect(system).toContain(`"report.pdf" (document_id ${meta.id}, 6 pages)`);
    expect(system).not.toContain("too large for your context");

    // The second request answers the call with the pages as a PDF inside the function response.
    const turn = second!.contents.at(-1);
    expect(turn.role).toBe("user");
    expect(turn.parts).toHaveLength(1);
    const response = turn.parts[0].functionResponse;
    expect(response.name).toBe("view_pages");
    expect(response.id).toBe("call-1");
    expect(response.response).toEqual({ document: "report.pdf", pages: "2-3", total_pages: 6, file: { $ref: "pages-2-3.pdf" }, tool_turns_left: 10 });
    expect(response.parts).toHaveLength(1);
    expect(Object.keys(response.parts[0])).toEqual(["inlineData"]);
    expect(response.parts[0].inlineData.mimeType).toBe("application/pdf");
    expect(response.parts[0].inlineData.displayName).toBe("pages-2-3.pdf");
    expect(await pageTexts(Buffer.from(response.parts[0].inlineData.data, "base64"))).toEqual([pageLine(2), pageLine(3)]);

    expect(result).toMatchObject({ text: "Page 2 shows a bar chart.", answered: true, turns: 2, steps: ["Look at report.pdf pages 2-3"] });
    // Nothing was too large, so nothing says so.
    expect(activity).toEqual(["Look at report.pdf pages 2-3…"]);
  });

  it("offers view_pages next to the text tools for a PDF that is searched", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget: { inlineTokens: 20 } });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const gemini = fakeGemini([
      { candidates: [{ content: { parts: [
        { functionCall: { name: "search_document", args: { document_id: meta.id, query: "Page 4 of", mode: "exact" } } },
        { functionCall: { name: "view_pages", args: { document_id: meta.id, from_page: 4 } } },
      ] } }] },
      say("Done."),
    ]);
    const activity: string[] = [];
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("What is on page 4?"), onActivity: (value) => activity.push(value) });
    const [first, second] = gemini.bodies;
    expect(result.plan.searchable.map((document) => document.name)).toEqual(["report.pdf"]);
    expect(toolNames(first!)).toEqual(["search_document", "read_document", "get_document_overview", "analyze_whole_document", "view_pages"]);
    expect(first!.contents[0].parts[0].text).toContain("To see a picture, a chart or the layout of a page, look at the page with view_pages.");
    // Both parts of the guide: the one of 0.2.0, then the one about pages.
    const system = systemOf(first!);
    expect(system.startsWith(GUIDE_0_2_0(`"report.pdf" (document_id ${meta.id})`))).toBe(true);
    expect(system).toContain("You can look at the real pages of these PDFs with view_pages");
    expect(activity[0]).toBe("Too large to read at once: report.pdf. Searching instead…");

    // Two calls in one turn, answered in order: the search hit says which page it is on.
    const [search, view] = responsesOf(second!);
    expect(search!.response.matches).toEqual([{ line: 11, page: 4, text: pageLine(4) }]);
    expect(search!.parts).toBeUndefined();
    expect(view!.response).toMatchObject({ pages: "4", file: { $ref: "pages-4.pdf" } });
    expect(await pageTexts(Buffer.from(view!.parts[0].inlineData.data, "base64"))).toEqual([pageLine(4)]);
    expect(result.steps).toEqual(["Search report.pdf (exact) for “Page 4 of” — 1 matching lines", "Look at report.pdf page 4"]);
  });

  it.each(PLACEMENTS)("keeps every request under the byte limit, however many pages the model asks for (pages %s)", async (toolFilePlacement) => {
    // Twelve pages with a picture of 60,000 bytes each, and a connector that takes 900,000 bytes.
    const limit = 900_000;
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget: { maxRequestBytes: limit } });
    const meta = await files.ingest({ name: "album.pdf", bytes: pdfWithPictures(12) });
    // A model that goes on from where the last look stopped, for as long as it is told a next page.
    const gemini = fakeGemini([(body) => {
      const last = responsesOf(body)[0]?.response;
      if (last?.error) return say("That is all I could look at.");
      return call("view_pages", { document_id: meta.id, from_page: last?.next_page ?? 1, to_page: 12 });
    }]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], toolFilePlacement, messages: question("Describe every picture.") });

    expect(gemini.sizes.length).toBe(4);
    for (const size of gemini.sizes) expect(size).toBeLessThanOrEqual(limit);
    // The pages are in the requests: the later ones are large, and still fit.
    expect(gemini.sizes[1]).toBeGreaterThan(400_000);
    expect(gemini.sizes[2]).toBeGreaterThan(gemini.sizes[1]! + 100_000);
    expect(gemini.bodies.map((body) => pdfsOf(body).length)).toEqual([0, 1, 2, 2]);
    const responses = gemini.bodies.slice(1).map((body) => responsesOf(body)[0]!);
    expect(responses[0]!.response).toMatchObject({ pages: "1-5", next_page: 6 });
    // Less room the second time: two pages, then none.
    expect(responses[1]!.response).toMatchObject({ pages: "6-7", next_page: 8 });
    expect(responses[1]!.response.note).toBe("Showing 2 of the 7 pages asked for: the others did not fit in this request. Call view_pages from page 8 if you need them.");
    expect(responses[2]!.response.error).toMatch(/^album\.pdf: Page 8 is \d+ KB as a file, more than the \d+ KB that fit in this request\.$/);
    expect(responses[2]!.parts).toBeUndefined();
    expect(result.steps).toEqual([
      "Look at album.pdf pages 1-12 — got pages 1-5",
      "Look at album.pdf pages 6-12 — got pages 6-7",
      expect.stringMatching(/^Look at album\.pdf pages 8-12 — failed: album\.pdf: Page 8 is /),
    ]);
    expect(result).toMatchObject({ text: "That is all I could look at.", answered: true, turns: 4 });
  });

  it.each(PLACEMENTS)("counts several looks in one turn against the same room (pages %s)", async (toolFilePlacement) => {
    const limit = 700_000;
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget: { maxRequestBytes: limit } });
    const meta = await files.ingest({ name: "album.pdf", bytes: pdfWithPictures(12) });
    const look = (from: number) => ({ functionCall: { name: "view_pages", args: { document_id: meta.id, from_page: from, to_page: from + 3 } } });
    const gemini = fakeGemini([{ candidates: [{ content: { parts: [look(1), look(5), look(9)] } }] }, say("Seen.")]);
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], toolFilePlacement, messages: question("Describe every picture.") });
    expect(gemini.sizes[1]).toBeLessThanOrEqual(limit);
    expect(pdfsOf(gemini.bodies[1]!)).toHaveLength(2);
    const responses = responsesOf(gemini.bodies[1]!);
    // (700,000 - 262,144 kept free) leaves room for four pictures, then for one, then for none.
    expect(responses.map((response) => response.response.pages ?? "none")).toEqual(["1-4", "5", "none"]);
    expect(responses[2]!.response.error).toMatch(/fit in this request|no room left/);
  });

  it("counts the pages against the tokens the budget keeps free", async () => {
    // 3,000 reserved tokens: half of them, at about 530 a page, pay for two pages.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget: { reservedTokens: 3_000 } });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(8) });
    const gemini = fakeGemini([call("view_pages", { document_id: meta.id, from_page: 1, to_page: 5 }), call("view_pages", { document_id: meta.id, from_page: 3 }), say("Two pages seen.")]);
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("?") });
    expect(responsesOf(gemini.bodies[1]!)[0]!.response).toMatchObject({ pages: "1-2", note: "Showing 2 of the 5 pages asked for: no more pages can be looked at for this question." });
    expect(responsesOf(gemini.bodies[2]!)[0]!.response.error).toBe("No more pages can be looked at for this question. Answer from the pages and the text you already have.");
  });

  it("ends with a request without tools when the model keeps looking, with the pages still in it", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const gemini = fakeGemini([(body) => (body.tools ? call("view_pages", { document_id: meta.id, from_page: body.contents.length }) : say("Best effort."))]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], maxToolTurns: 3, messages: question("?") });
    expect(gemini.bodies.map((body) => Boolean(body.tools))).toEqual([true, true, false]);
    const last = gemini.bodies.at(-1)!;
    expect(last.toolConfig).toBeUndefined();
    // The text of the file is in the prompt, so the closing request does not say "only what the tools returned".
    expect(last.contents.at(-1)).toEqual({ role: "user", parts: [{ text: FINAL_ANSWER_AFTER_PAGES }] });
    const parts = last.contents.flatMap((content: Body) => content.parts) as Body[];
    expect(parts.filter((part) => part.functionCall)).toHaveLength(2);
    expect(parts.filter((part) => part.functionResponse?.parts?.[0]?.inlineData?.data)).toHaveLength(2);
    expect(result).toMatchObject({ text: "Best effort.", answered: true, turns: 3, steps: ["Look at report.pdf page 1", "Look at report.pdf page 3"] });
  });

  it("closes with the wording of 0.2.0 when a file is also searched", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget: { inlineTokens: 20 } });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const gemini = fakeGemini([(body) => (body.tools ? call("view_pages", { document_id: meta.id, from_page: 1 }) : say("Best effort."))]);
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], maxToolTurns: 2, wholeDocumentAnalysis: false, messages: question("?") });
    expect(gemini.bodies.at(-1)!.contents.at(-1)).toEqual({ role: "user", parts: [{ text: FINAL_ANSWER_REQUEST }] });
  });

  it("can send the pages in a user turn of their own, after the function responses", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const gemini = fakeGemini([call("view_pages", { document_id: meta.id, from_page: 2, to_page: 3 }), say("ok")]);
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], toolFilePlacement: "beside", messages: question("?") });
    // The question, the call, the function response, the pages.
    const contents = gemini.bodies[1]!.contents as Body[];
    expect(contents.map((content) => content.role)).toEqual(["user", "model", "user", "user"]);
    // Nothing but the function response in its turn: Vertex AI refuses anything after one.
    expect(contents[2]!.parts).toEqual([{ functionResponse: { name: "view_pages", response: { document: "report.pdf", pages: "2-3", total_pages: 6, file: "pages-2-3.pdf", tool_turns_left: 10 } } }]);
    const parts = contents[3]!.parts as Body[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: "pages-2-3.pdf (returned by view_pages):" });
    expect(Object.keys(parts[1]!.inlineData)).toEqual(["mimeType", "data"]);
    expect(parts[1]!.inlineData.mimeType).toBe("application/pdf");
    expect(await pageTexts(Buffer.from(parts[1]!.inlineData.data, "base64"))).toEqual([pageLine(2), pageLine(3)]);
  });

  it("keeps each turn of pages after its function responses over several looks, and before the closing request", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"], budget: { inlineTokens: 20 } });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    // A look, then a search (which returns no file), then a look the model would go on from.
    const gemini = fakeGemini([
      call("view_pages", { document_id: meta.id, from_page: 1 }),
      call("search_document", { document_id: meta.id, query: "Page 4 of", mode: "exact" }),
      (body) => (body.tools ? call("view_pages", { document_id: meta.id, from_page: 4 }) : say("Best effort.")),
    ]);
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], toolFilePlacement: "beside", maxToolTurns: 4, wholeDocumentAnalysis: false, messages: question("?") });
    const shape = (content: Body) => `${content.role}:${(content.parts as Body[]).map((part) => Object.keys(part)[0]).join("+")}`;
    expect(gemini.bodies.at(-1)!.contents.slice(1).map(shape)).toEqual([
      "model:functionCall", "user:functionResponse", "user:text+inlineData",
      // A turn of function responses with no file is followed by nothing.
      "model:functionCall", "user:functionResponse",
      "model:functionCall", "user:functionResponse", "user:text+inlineData",
      "user:text",
    ]);
    expect(gemini.bodies.at(-1)!.contents.at(-1)).toEqual({ role: "user", parts: [{ text: FINAL_ANSWER_REQUEST }] });
    expect(gemini.bodies.at(-1)!.tools).toBeUndefined();
  });
});

describe("askGemini without pages to show", () => {
  const log = utf8(Array.from({ length: 3_000 }, (_, index) => `2026-05-01 12:00:00 INFO request ${index + 1} ok`).join("\n"));

  /** The requests one question produces, with document IDs replaced by their order of appearance. */
  async function requestsFor(options: { keepOriginals: boolean; viewPages?: boolean }): Promise<Body[]> {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 2_000 }, ...(options.keepOriginals ? { keepOriginals: ["pdf" as const] } : {}) });
    const pdf = await files.ingest({ name: "report.pdf", bytes: numberedPdf(6) });
    const large = await files.ingest({ name: "app.log", bytes: log });
    const gemini = fakeGemini([
      call("search_document", { document_id: large.id, query: "request 250 ok", mode: "exact" }),
      call("read_document", { document_id: large.id, start_line: 1, end_line: 3 }),
      say("Found."),
    ]);
    await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [pdf.id, large.id], system: "Be brief.", messages: question("Where is request 250?"), ...(options.viewPages === undefined ? {} : { viewPages: options.viewPages }) });
    const ids = [pdf.id, large.id];
    return JSON.parse(JSON.stringify(gemini.bodies).replace(/doc_[a-f0-9]{32}/g, (id) => `doc_${ids.indexOf(id) + 1}`)) as Body[];
  }

  it("sends what 0.2.0 sent when the library keeps no originals", async () => {
    const bodies = await requestsFor({ keepOriginals: false });
    expect(bodies).toHaveLength(3);
    expect(toolNames(bodies[0]!)).toEqual(["search_document", "read_document", "get_document_overview", "analyze_whole_document"]);
    expect(systemOf(bodies[0]!)).toBe(`Be brief.\n\n${GUIDE_0_2_0(`"app.log" (document_id doc_2)`)}`);
    const block = bodies[0]!.contents[0].parts[0].text as string;
    expect(block.startsWith("--- Attached file: report.pdf (pdf, 17 lines) ---\n--- Page 1 ---\nPage 1 of the test file.\n")).toBe(true);
    expect(block).not.toContain("view_pages");
    expect(JSON.stringify(bodies)).not.toContain("view_pages");
    expect(Object.keys(bodies[0]!).sort()).toEqual(["contents", "systemInstruction", "toolConfig", "tools"]);
    expect(responsesOf(bodies[1]!)[0]).toEqual({ name: "search_document", response: { document: "app.log", mode: "exact", total_matching_lines: 1, matches: [{ line: 250, text: "2026-05-01 12:00:00 INFO request 250 ok" }], tool_turns_left: 10 } });
    expect(Object.keys(responsesOf(bodies[2]!)[0]!.response)).toEqual(["document", "lines", "total_lines", "text", "next_start_line", "tool_turns_left"]);
  });

  it("sends the same requests when originals are kept but view_pages is turned off", async () => {
    expect(await requestsFor({ keepOriginals: true, viewPages: false })).toEqual(await requestsFor({ keepOriginals: false }));
  });

  it("adds view_pages, and nothing else, when originals are kept", async () => {
    const plain = await requestsFor({ keepOriginals: false });
    const withPages = await requestsFor({ keepOriginals: true });
    expect(toolNames(withPages[0]!)).toEqual([...toolNames(plain[0]!), "view_pages"]);
    expect(systemOf(withPages[0]!).startsWith(`${systemOf(plain[0]!)}\nThe text of a PDF does not show its pictures`)).toBe(true);
    // The documents, the question and the results of the text tools are the same.
    expect(withPages.map((body) => body.contents)).toEqual(plain.map((body) => body.contents));
  });

  it("makes one request without tools for a PDF that fits and has no original", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(2) });
    const gemini = fakeGemini([say("Two pages.")]);
    const result = await askGemini({ files, endpoint, fetch: gemini.fetch, documentIds: [meta.id], messages: question("How long is it?") });
    expect(gemini.bodies).toEqual([{ contents: [{ role: "user", parts: [
      { text: "--- Attached file: report.pdf (pdf, 5 lines) ---\n--- Page 1 ---\nPage 1 of the test file.\n\n--- Page 2 ---\nPage 2 of the test file.\n--- End attached file: report.pdf ---" },
      { text: "How long is it?" },
    ] }] }]);
    expect(result).toMatchObject({ answered: true, turns: 1, steps: [] });
  });
});

describe("prepare with viewPages", () => {
  it("lists the PDFs whose pages can be shown only when asked to", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf", "markdown"], budget: { inlineTokens: 2_000 } });
    const small = await files.ingest({ name: "small.pdf", bytes: numberedPdf(2), owner: "alice" });
    // Its file is kept too, but only a PDF has pages to show.
    const notes = await files.ingest({ name: "notes.md", bytes: utf8("# Notes"), owner: "alice" });
    expect(notes.originalKept).toBe(true);
    const large = await files.ingest({ name: "large.pdf", bytes: numberedPdf(400), owner: "alice" });
    const ids = [large.id, notes.id, small.id];
    const base = { tokens: 0, bytes: 0 };

    const plain = await files.prepare(ids, base, { owner: "alice" });
    expect(plain.viewable).toEqual([]);
    expect(plain.instruction).toBe(GUIDE_0_2_0(`"large.pdf" (document_id ${large.id})`));
    expect(plain.blocks.get(large.id)).not.toContain("view_pages");

    const prepared = await files.prepare(ids, base, { owner: "alice", viewPages: true });
    expect(prepared.plan).toEqual(plain.plan);
    // In the order they were asked for: one is searched, one has its text in the prompt.
    expect(prepared.viewable.map((meta) => meta.name)).toEqual(["large.pdf", "small.pdf"]);
    expect(prepared.instruction).toContain(`with view_pages: "large.pdf" (document_id ${large.id}, 400 pages); "small.pdf" (document_id ${small.id}, 2 pages).`);
    expect(prepared.blocks.get(large.id)).toContain("look at the page with view_pages");
    expect(prepared.blocks.get(small.id)).toBe(plain.blocks.get(small.id));
    expect(prepared.blocks.get(notes.id)).toBe(plain.blocks.get(notes.id));

    // Another user's documents are missing, not viewable.
    const stranger = await files.prepare(ids, base, { owner: "bob", viewPages: true });
    expect(stranger.viewable).toEqual([]);
    expect(stranger.missing).toEqual(ids);
  });
});

describe("geminiFunctionResponses", () => {
  const bytes = utf8("%PDF-1.4 test");
  const file = { name: "pages-1.pdf", mimeType: "application/pdf", bytes };

  it("builds the turn of 0.2.0 when no call returned a file", () => {
    const calls = [{ call: { name: "read_document", args: {}, id: "a" }, result: { text: "1| x" } }, { call: { name: "search_document", args: {} }, result: { matches: [] }, files: [] }];
    expect(geminiFunctionResponses(calls)).toEqual({ role: "user", parts: [
      { functionResponse: { name: "read_document", id: "a", response: { text: "1| x" } } },
      { functionResponse: { name: "search_document", response: { matches: [] } } },
    ] });
    // One turn, wherever files would go, when there is none.
    expect(geminiFunctionResponseTurns(calls)).toEqual([geminiFunctionResponses(calls)]);
    expect(geminiFunctionResponseTurns(calls, { files: "beside" })).toEqual([geminiFunctionResponses(calls)]);
  });

  it("refers to each file by name from the result, and does not change the result it was given", () => {
    const result = { pages: "1", file: "pages-1.pdf" };
    const turn = geminiFunctionResponses([{ call: { name: "view_pages", args: {} }, result, files: [file, { ...file, name: "extra.pdf" }] }]);
    expect(turn.parts).toEqual([{ functionResponse: {
      name: "view_pages",
      response: { pages: "1", file: { $ref: "pages-1.pdf" }, files: [{ $ref: "extra.pdf" }] },
      parts: [
        { inlineData: { mimeType: "application/pdf", displayName: "pages-1.pdf", data: Buffer.from(bytes).toString("base64") } },
        { inlineData: { mimeType: "application/pdf", displayName: "extra.pdf", data: Buffer.from(bytes).toString("base64") } },
      ],
    } }]);
    expect(result).toEqual({ pages: "1", file: "pages-1.pdf" });
  });

  it("puts files inside the function responses unless asked otherwise", () => {
    const calls = [{ call: { name: "view_pages", args: {} }, result: { file: "pages-1.pdf" }, files: [file] }];
    expect(geminiFunctionResponseTurns(calls)).toEqual([geminiFunctionResponses(calls)]);
    expect(geminiFunctionResponseTurns(calls, { files: "inside" })).toEqual([geminiFunctionResponses(calls)]);
    expect(JSON.stringify(geminiFunctionResponses(calls))).toContain('"displayName":"pages-1.pdf"');
  });

  it("gives files that go beside a turn of their own, in call order, after all the function responses", () => {
    const data = Buffer.from(bytes).toString("base64");
    const result = { pages: "1", file: "pages-1.pdf" };
    const turns = geminiFunctionResponseTurns([
      { call: { name: "view_pages", args: {}, id: "a" }, result, files: [file] },
      { call: { name: "read_document", args: {} }, result: { text: "x" } },
      { call: { name: "make_chart", args: {} }, result: { ok: true }, files: [{ name: "chart.png", mimeType: "image/png", bytes }, { ...file, name: "notes.pdf" }] },
    ], { files: "beside" });
    expect(turns).toEqual([
      // The results as the tools gave them: a file is named, not referred to.
      { role: "user", parts: [
        { functionResponse: { name: "view_pages", id: "a", response: { pages: "1", file: "pages-1.pdf" } } },
        { functionResponse: { name: "read_document", response: { text: "x" } } },
        { functionResponse: { name: "make_chart", response: { ok: true } } },
      ] },
      { role: "user", parts: [
        { text: "pages-1.pdf (returned by view_pages):" }, { inlineData: { mimeType: "application/pdf", data } },
        { text: "chart.png (returned by make_chart):" }, { inlineData: { mimeType: "image/png", data } },
        { text: "notes.pdf (returned by make_chart):" }, { inlineData: { mimeType: "application/pdf", data } },
      ] },
    ]);
    expect(result).toEqual({ pages: "1", file: "pages-1.pdf" });
  });
});
