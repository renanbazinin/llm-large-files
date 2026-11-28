// 0.99.14: citationMarkers ("keep", "remove", "token"), sources "off" (CIT-17), and the anchors,
// sources and citation events of an answer (CIT-2, CIT-3). Nothing sent to the model changes.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type ModelAdapter, type ModelReply, type ModelRequest } from "llm-large-files";
import { sseMessageOf } from "llm-large-files/node";
import { fakeModel, says, utf8 } from "./fake-model.js";
import { insertCitationTokens } from "../src/citation-tokens.js";

const question = (text: string) => [{ role: "user" as const, text }];

/** A model that streams `text` in pieces of `size`, and keeps the requests it got. */
function streaming(text: string, size: number): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: "streaming",
    capabilities: { toolFiles: "none", pageTokens: 500 },
    requests,
    async send(request, hooks = {}): Promise<ModelReply> {
      requests.push(request);
      if (hooks.onText) for (let at = 0; at < text.length; at += size) hooks.onText(text.slice(at, at + size));
      return { text, calls: [], finish: "complete" };
    },
  };
}

const NOTE = "# Notes\n\nThe code word is heron.\nThe nightly import runs at 02:00 UTC.\n";
const ANSWER = "The code word is heron (notes.md L3), and the import runs at 02:00 (L4).\nThat is all.";
const SHOWN = "The code word is heron, and the import runs at 02:00.\nThat is all.";

let shared: Promise<{ files: ReturnType<typeof createLargeFiles>; meta: Awaited<ReturnType<ReturnType<typeof createLargeFiles>["ingest"]>> }> | undefined;
/** One library for every run: the same document ID and version in each. */
function noteLibrary() {
  shared ??= (async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const meta = await files.ingest({ name: "notes.md", bytes: utf8(NOTE) });
    return { files, meta };
  })();
  return shared;
}

type Run = { result: Awaited<ReturnType<typeof askWithFiles>>; events: AskEvent[]; deltas: string[]; model: ReturnType<typeof streaming> };
async function run(options: Record<string, unknown>, size = 5, answer = ANSWER): Promise<Run> {
  const { files, meta } = await noteLibrary();
  const model = streaming(answer, size);
  const events: AskEvent[] = [];
  const deltas: string[] = [];
  const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("Where is the code word?"), onText: (delta) => deltas.push(delta), onEvent: (event) => events.push(event), ...options });
  return { result, events, deltas, model };
}

describe("citationMarkers and sources: checked before any request", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ citationMarkers: "hide" }, 'citationMarkers must be "keep", "remove" or "token", and is "hide".'],
    [{ sources: false }, 'sources must be "on" or "off", and is boolean.'],
    [{ citationMarkers: "keep", showCitations: false }, 'citationMarkers "keep" and showCitations false disagree: give one of them.'],
    [{ citationMarkers: "remove", showCitations: true }, 'citationMarkers "remove" and showCitations true disagree: give one of them.'],
    [{ sources: "off", citationMarkers: "keep" }, 'sources "off" shows no chips: it cannot go with citationMarkers "keep", which shows the citations.'],
    [{ sources: "off", citationMarkers: "token" }, 'sources "off" shows no chips: it cannot go with citationMarkers "token", which puts a token at each chip.'],
    [{ sources: "off", showCitations: true }, 'sources "off" shows no chips: it cannot go with showCitations true, which shows the citations.'],
  ];
  for (const [options, message] of cases) {
    it(`${JSON.stringify(options)} is a TypeError`, async () => {
      const { files, meta } = await noteLibrary();
      const model = fakeModel([says("Heron.")]);
      await expect(askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), ...options })).rejects.toThrow(new TypeError(message));
      expect(model.requests).toHaveLength(0);
    });
  }
  it("showCitations false agrees with remove and token; sources off agrees with remove and showCitations false", async () => {
    for (const options of [{ showCitations: false, citationMarkers: "remove" }, { showCitations: false, citationMarkers: "token" }, { sources: "off", citationMarkers: "remove" }, { sources: "off", showCitations: false }]) {
      await expect(run(options)).resolves.toBeTruthy();
    }
  });
});

describe("keep (the default): as 0.99.13", () => {
  it("has no anchors, sources or lineTalk, and sends no citation event", async () => {
    for (const options of [{}, { citationMarkers: "keep" }, { showCitations: true }]) {
      const { result, events } = await run(options);
      expect(result.text).toBe(ANSWER);
      expect(result).not.toHaveProperty("anchors");
      expect(result).not.toHaveProperty("sources");
      expect(result).not.toHaveProperty("lineTalk");
      expect(events.some((event) => event.type === "citation")).toBe(false);
    }
  });
});

describe("remove: anchors, sources and citation events", () => {
  it("shows the text without its citations, with a chip where each one was, the same at every piece size", async () => {
    let first: Run | undefined;
    for (const size of [1, 3, 7, 1_000]) {
      const current = await run({ citationMarkers: "remove" }, size);
      const { result, deltas } = current;
      expect(deltas.join("")).toBe(SHOWN);
      expect(result.text).toBe(SHOWN);
      expect(result.modelText).toBe(ANSWER);
      expect(result.anchors!.map((anchor) => [anchor.at, anchor.label, anchor.kind, anchor.status])).toEqual([[SHOWN.indexOf(","), 1, "removed", "resolved"], [SHOWN.indexOf("."), 2, "removed", "resolved"]]);
      for (const anchor of result.anchors!) expect(anchor.at).toBeLessThanOrEqual(result.text.length);
      expect(result.sources!.map((source) => source.key)).toEqual([expect.stringMatching(/:3-3$/), expect.stringMatching(/:4-4$/)]);
      const [three] = result.sources!;
      expect(three).toMatchObject({ name: "notes.md", from: 3, to: 3, form: "line", shown: true, seen: "shown", textVersion: 1 });
      expect(three!.version).toMatch(/^[0-9a-f]{16}$/);
      expect(three!.locators[0]!.kind).toBe("section");
      // The file was sent whole: its line is quoted as the model had it.
      expect(three!.quote).toBe("The code word is heron.");
      if (first) {
        expect(result.anchors).toEqual(first.result.anchors);
        expect(result.sources).toEqual(first.result.sources);
      }
      first ??= current;
    }
  });

  it("tells each chip in a citation event after the text that holds its place, without quotes unless eventResults", async () => {
    for (const eventResults of [false, true]) {
      const { events, result } = await run({ citationMarkers: "remove", eventResults });
      let shown = 0;
      const citations = [];
      for (const event of events) {
        if (event.type === "text") shown += event.delta.length;
        if (event.type !== "citation") continue;
        citations.push(event);
        expect(event.anchor.at).toBeLessThanOrEqual(shown);
        for (const source of event.sources) expect("quote" in source).toBe(eventResults);
      }
      expect(citations.map((event) => event.anchor)).toEqual(result.anchors);
      const finish = events.find((event) => event.type === "run.finish") as Extract<AskEvent, { type: "run.finish" }>;
      expect(JSON.stringify(finish.result.sources).includes("quote")).toBe(eventResults);
      // A browser gets the chips and their sources, never a quote, never modelText or lineTalk.
      const sse = JSON.stringify(sseMessageOf(finish).data);
      expect(sse).toContain('"anchors"');
      expect(sse).toContain('"sources"');
      expect(sse).not.toMatch(/"quote"|"modelText"|"lineTalk"/);
    }
  });

  it("asks the model as keep does: the requests are byte for byte the same in every mode", async () => {
    const bodies = [];
    for (const options of [{}, { citationMarkers: "remove" }, { citationMarkers: "token" }, { sources: "off" }]) bodies.push(JSON.stringify((await run(options)).model.requests));
    expect(new Set(bodies).size).toBe(1);
  });

  it("reports lineTalk: none left in the shown text", async () => {
    const { result } = await run({ citationMarkers: "remove" });
    expect(result.lineTalk).toMatchObject({ verdict: "none", left: { mentions: 0 }, kept: { count: 0 }, ambiguous: { count: 0 } });
  });
});

describe("token: ⟦n⟧ at each chip", () => {
  it("is the remove text with a token at each anchor, at every piece size", async () => {
    const removed = await run({ citationMarkers: "remove" });
    for (const size of [1, 4, 1_000]) {
      const { result, deltas } = await run({ citationMarkers: "token" }, size);
      expect(result.text).toBe(insertCitationTokens(removed.result.text, removed.result.anchors!));
      expect(deltas.join("")).toBe(result.text);
      for (const anchor of result.anchors!) expect(result.text.slice(anchor.at)).toMatch(new RegExp(`^⟦${anchor.label}⟧`));
    }
  });

  it("puts the token of a citation at the start of a line at the end of the line before it", async () => {
    const answer = "First point.\n(notes.md L3) Second point.";
    const { result } = await run({ citationMarkers: "token" }, 2, answer);
    const removed = await run({ citationMarkers: "remove" }, 2, answer);
    expect(result.text).toBe(insertCitationTokens(removed.result.text, removed.result.anchors!));
  });
});

describe("sources off (CIT-17)", () => {
  it("shows the remove text, with no chip, no citation event and nothing of a source in any event or SSE message", async () => {
    const removed = await run({ citationMarkers: "remove" });
    const off = await run({ sources: "off" });
    expect(off.result.text).toBe(removed.result.text);
    expect(off.result.modelText).toBe(ANSWER);
    expect(off.result.anchors).toEqual([]);
    expect(off.result.sources).toEqual([]);
    // citations keeps its meaning, for checks on the server.
    expect(off.result.citations).toEqual(removed.result.citations);
    expect(off.events.some((event) => event.type === "citation")).toBe(false);
    for (const event of off.events) {
      const sent = JSON.stringify(sseMessageOf(event).data);
      expect(sent).not.toMatch(/"locators"|"quote"|"version"/);
      // The file is named only where 0.99.13 named it: the plan, and run.finish's citations.
      if (event.type !== "plan" && event.type !== "run.finish") expect(sent, event.type).not.toContain("notes.md");
    }
    expect(JSON.stringify(off.model.requests)).toBe(JSON.stringify(removed.model.requests));
  });
});
