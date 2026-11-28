// With eventResults off, no planted document text reaches an event or an SSE message (specs/03-privacy-sse
// part 1, gate G1; the twin of its probes/01-today-canaries.mjs). 0.99.12 had one channel:
// aggregate_table's column errors listed the table's headers in tool.end.error, tool.end.step and the
// steps of run.finish and run.error. 0.99.13 closes it (decision 13, EVENT-COLUMNS): the model keeps
// the full error, and events say "no such column" with a count, and this file guards that channel.
// 0.99.14 adds one channel by design (the owner's decision, Nov 28): a chip's locator names its
// sheet and its headings, read from the stored text, as the plan's outline and a card's head are, so
// a heading or sheet name may reach `citation` events and the sources of run.finish (in SSE too). It
// is never a line of the file (quotes stay out without eventResults), and onToolResult does not see
// it: DLP masks at ingest (docs/security.md, "Quotes and previews").
import { describe, expect, it } from "vitest";
import { HOOKS, canariesIn, runQuestion, sentToModel, sseData, type Run } from "./privacy-fixtures.js";

/** Where document text may reach events with eventResults off: a locator's sheet name or headings (0.99.14), and nowhere else. */
const ALLOWED: RegExp[] = [/^citation\.sources\.locators\.(?:sheet|headings)$/, /^citation\.sources\.candidates\.locator\.(?:sheet|headings)$/, /^run\.(?:finish\.result|error\.partial)\.sources\.locators\.(?:sheet|headings)$/, /^run\.(?:finish\.result|error\.partial)\.sources\.candidates\.locator\.(?:sheet|headings)$/];
/** The kinds of canary a locator may name: a heading of the outline, a sheet's name. */
const LOCATOR_KINDS = new Set(["heading", "sheet-name"]);
/** The fields a model writes: its arguments, labels and steps quoting them, the answer. None carries a canary in this script. */
const strings = (value: unknown, path: string, out: Array<[string, string]>) => {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, path, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  return out;
};
const streamsOf = (run: Run) => [
  ...run.events.flatMap((e) => strings(e, e.type, [])),
  ...Object.values(run.sse).flatMap((body) => sseData(body).flatMap((d) => strings(d, String(d.type), []))),
];

describe("events carry no document text with eventResults off", () => {
  for (const hook of Object.keys(HOOKS)) {
    for (const transport of ["stream", "registry"] as const) {
      it(`${hook}, ${transport}`, async () => {
        const run = await runQuestion({ hookFor: () => hook, transport });
        for (const [path, text] of streamsOf(run)) {
          const found = canariesIn(text).filter((c) => run.registry.has(c));
          if (found.length === 0) continue;
          expect(ALLOWED.some((re) => re.test(path)), `${path}: ${found.join(", ")}`).toBe(true);
          // And there only headings and sheet names, never a line of a file.
          expect(found.every((c) => LOCATOR_KINDS.has(run.registry.get(c)!.kind)), path).toBe(true);
        }
        expect(JSON.stringify(run.events)).not.toContain('"quote"');
      });
    }
  }

  it("a canary a hook removed is in no event, no SSE message and no result field but plan metadata and locators, with or without eventResults", async () => {
    for (const eventResults of [false, true]) for (const hook of ["maskIds", "dropLines", "replaceValues", "redactWhole", "reject"]) {
      const run = await runQuestion({ hookFor: () => hook, eventResults });
      const sent = sentToModel(run.requests);
      const masked = [...run.removed].filter((c) => !sent.canaries.has(c));
      // Locators name headings and sheets from the stored text (0.99.14): taken out like the plan.
      const withoutLocators = (sources: unknown) => (Array.isArray(sources) ? sources.map(({ locators: _locators, candidates: _candidates, ...rest }) => rest) : sources);
      const { plan: _plan, sources, ...rest } = run.result!;
      const result = { ...rest, sources: withoutLocators(sources) };
      const events = run.events
        .filter((e) => e.type !== "citation")
        .map((e) => (e.type === "run.finish" ? { ...e, result: { ...e.result, plan: undefined, sources: withoutLocators(e.result.sources) } } : e));
      const sse = Object.fromEntries(Object.entries(run.sse).map(([key, body]) => [key, sseData(body).filter((d) => d.type !== "citation").map((d) => (d.type === "run.finish" ? { ...d, result: { ...(d.result as object), sources: withoutLocators((d.result as { sources?: unknown }).sources) } } : d))]));
      const text = JSON.stringify([result, events, sse]);
      for (const canary of masked) expect(text, `${hook} ${eventResults} ${canary}`).not.toContain(canary);
    }
    // Ten questions: about 2 s alone, more while other test files run.
  }, 60_000);

  it("outline headings and sheet names reach events only with eventResults (run.finish's full plan), but for a chip's locator", async () => {
    const off = await runQuestion({ hookFor: () => "none" });
    const on = await runQuestion({ hookFor: () => "none", eventResults: true });
    const outside = (run: Run) => run.events.filter((e) => e.type !== "citation").map((e) => (e.type === "run.finish" ? { ...e, result: { ...e.result, sources: undefined } } : e));
    const headings = (run: Run) => canariesIn(JSON.stringify(outside(run))).filter((c) => ["heading", "sheet-name"].includes(run.registry.get(c)?.kind ?? ""));
    expect(headings(off)).toEqual([]);
    expect(headings(on).length).toBeGreaterThan(0);
  });

  it("the citations the hider removed are in no SSE message; modelText keeps them in onEvent's run.finish only (0.99.13)", async () => {
    const run = await runQuestion({ hookFor: () => "none" });
    for (const removed of ["(roster.txt L33)", "(policy.md L45)", "(small.txt L3)"]) {
      for (const body of Object.values(run.sse)) expect(body).not.toContain(removed);
      expect(run.result!.modelText).toContain(removed);
      const holders = run.events.filter((e) => JSON.stringify(e).includes(removed)).map((e) => e.type);
      expect(holders).toEqual(["run.finish"]);
    }
  });
});
