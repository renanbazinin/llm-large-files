// With eventResults off, no planted document text reaches an event or an SSE message (specs/03-privacy-sse
// part 1, gate G1; the twin of its probes/01-today-canaries.mjs). 0.99.12 had one channel:
// aggregate_table's column errors listed the table's headers in tool.end.error, tool.end.step and the
// steps of run.finish and run.error. 0.99.13 closes it (decision 13, EVENT-COLUMNS): the model keeps
// the full error, and events say "no such column" with a count. So ALLOWED is empty, and this file
// guards that channel too.
import { describe, expect, it } from "vitest";
import { HOOKS, canariesIn, runQuestion, sentToModel, sseData, type Run } from "./privacy-fixtures.js";

/** Where document text may reach events with eventResults off: nowhere (0.99.12 let column names through in errors). */
const ALLOWED: RegExp[] = [];
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
          // And there only the column names of the table (header canaries), never a row.
          expect(found.every((c) => run.registry.get(c)!.kind === "column-header"), path).toBe(true);
        }
        expect(JSON.stringify(run.events)).not.toContain('"quote"');
      });
    }
  }

  it("a canary a hook removed is in no event, no SSE message and no result field but plan metadata, with or without eventResults", async () => {
    for (const eventResults of [false, true]) for (const hook of ["maskIds", "dropLines", "replaceValues", "redactWhole", "reject"]) {
      const run = await runQuestion({ hookFor: () => hook, eventResults });
      const sent = sentToModel(run.requests);
      const masked = [...run.removed].filter((c) => !sent.canaries.has(c));
      const { plan: _plan, ...result } = run.result!;
      const events = run.events.map((e) => (e.type === "run.finish" ? { ...e, result: { ...e.result, plan: undefined } } : e));
      const text = JSON.stringify([result, events, run.sse]);
      for (const canary of masked) expect(text, `${hook} ${eventResults} ${canary}`).not.toContain(canary);
    }
    // Ten questions: about 2 s alone, more while other test files run.
  }, 60_000);

  it("outline headings and sheet names reach events only with eventResults (run.finish's full plan)", async () => {
    const off = await runQuestion({ hookFor: () => "none" });
    const on = await runQuestion({ hookFor: () => "none", eventResults: true });
    const headings = (run: Run) => canariesIn(JSON.stringify(run.events)).filter((c) => ["heading", "sheet-name"].includes(run.registry.get(c)?.kind ?? ""));
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
