// aggregate_table's column errors list the table's column names (EVENT-COLUMNS, 0.99.13, decision 13).
// The model keeps the full error, byte for byte, as before. Events, steps and SSE say "no such column"
// with a count, and neither the names nor the name the model gave: with eventResults off they carry
// no text of the documents (principle 9). Until 0.99.13 the names reached tool.end.error,
// tool.end.step, the steps of run.finish and run.error, and SSE.
import { describe, expect, it } from "vitest";
import { askStream, createLargeFiles, MemoryDocumentStore, toolResultSummary, type AskEvent, type AskOptions, type ModelRequest, type ToolResultVerdict } from "llm-large-files";
import { writeSseEvents } from "llm-large-files/node";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";
import { fakeResponse } from "./privacy-fixtures.js";

/** The planted column names: none of them is typed by the model below. */
const HEADERS = ["QZHEADA", "QZHEADB", "QZHEADC", "QZHEADD"];
const CSV = ["QZHEADA / QZLOW,QZHEADB / QZLOW,QZHEADC,QZHEADD", "1,2,3,4", "5,6,7,8"].join("\n");

async function table() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  const meta = await files.ingest({ id: "t-1", name: "budget.csv", bytes: utf8(CSV) });
  return { files, meta };
}

/** The three column errors, by the arguments that make them. */
const CASES = [
  { what: "a column the table does not have", args: { metrics: ["sum:nothing-like-it"] }, told: "No such column in this table, which has 4 columns." },
  { what: "a lower name of several joined headers", args: { metrics: ["sum:QZLOW"] }, told: "Ambiguous column: the name given matches 2 of the 4 columns of this table." },
  { what: "a filter's value that names several columns", args: { metrics: ["count"], filters: [{ column: "D", op: ">", value: "QZLOW" }] }, told: "Ambiguous column: the value of a filter matches 2 of the 4 columns of this table." },
];

type Run = { events: AskEvent[]; sse: string; requests: ModelRequest[]; steps: string[]; toolTurns: string };

async function ask(args: Record<string, unknown>, options: Partial<AskOptions> & { fail?: boolean; twice?: boolean } = {}): Promise<Run> {
  const { files, meta } = await table();
  const call = { name: "aggregate_table", args: { document_id: meta.id, ...args } };
  const model = fakeModel([
    calls(options.twice ? [{ id: "c1", ...call }, { id: "c2", ...call }] : [{ id: "c1", ...call }]),
    options.fail ? Object.assign(new Error("HTTP 400"), { status: 400 }) : says("The total is 6."),
  ]);
  const events: AskEvent[] = [];
  const stream = askStream({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "Total?" }], retry: { retries: 0 }, ...options, onEvent: (event) => events.push(event) });
  const response = fakeResponse();
  await writeSseEvents(response, stream, { heartbeatMs: 0 });
  const result = await stream.result.catch(() => undefined);
  const partial = events.find((event): event is Extract<AskEvent, { type: "run.error" }> => event.type === "run.error")?.partial;
  return { events, sse: response.body(), requests: model.requests, steps: result?.steps ?? partial?.steps ?? [], toolTurns: JSON.stringify(result?.toolTurns ?? []) };
}

/** What the model was sent as the call's result. */
const sentErrors = (run: Run) => run.requests.flatMap((request) => request.messages.flatMap((message) => (message.role === "tools" ? message.answers.map((answer) => answer.result.error) : [])));
const toolEnds = (run: Run) => run.events.filter((event): event is Extract<AskEvent, { type: "tool.end" }> => event.type === "tool.end");

describe("aggregate_table's column errors in events", () => {
  for (const { what, args, told } of CASES) {
    it(`${what}: the model gets the column names, events, steps and SSE a count`, async () => {
      const { files, meta } = await table();
      // The tool's own error, as the model has had it since 0.10.0.
      const raw = await files.tools([meta]).execute("aggregate_table", { document_id: meta.id, ...args });
      expect(String(raw.error)).toContain("QZHEADA / QZLOW");
      const run = await ask(args);
      expect(sentErrors(run)).toEqual([raw.error]);
      for (const name of HEADERS) {
        expect(JSON.stringify(run.events.filter((event) => event.type !== "tool.start")), name).not.toContain(name);
        expect(run.sse.split("\n\n").filter((block) => !block.includes("event: tool.start")).join("\n\n"), name).not.toContain(name);
        expect(JSON.stringify(run.steps.map((step) => step.slice(step.indexOf(" — ")))), name).not.toContain(name);
      }
      const [end] = toolEnds(run);
      expect(end).toMatchObject({ outcome: "error", error: told });
      expect(end!.step).toMatch(new RegExp(` — failed: ${told.replace(/[.()]/g, "\\$&")}$`));
      expect(run.steps.at(-1)).toBe(end!.step);
      // The model-typed name is not in the error's words either (it is in the label, as the model wrote it).
      expect(told).not.toMatch(/nothing-like-it|QZLOW/);
      // The tool rounds kept with the conversation hold what the model was sent.
      expect(run.toolTurns).toContain("QZHEADA / QZLOW");
    });
  }

  it("a hook that keeps the result, or sends a copy or a changed copy of it, does not bring the names back", async () => {
    const hooks: Array<(result: Record<string, unknown>) => ToolResultVerdict | undefined> = [
      () => undefined,
      (result) => ({ result: { ...result } }),
      (result) => ({ result: JSON.parse(JSON.stringify(result)) as Record<string, unknown> }),
      (result) => ({ result: { ...result, error: String(result.error).replace(/\d/g, "#") } }),
    ];
    for (const hook of hooks) {
      for (const twice of [false, true]) {
        const run = await ask(CASES[0]!.args, { onToolResult: ({ result }) => hook(result), twice });
        for (const name of HEADERS) expect(`${JSON.stringify(run.events)}${run.sse}${JSON.stringify(run.steps)}`, `${String(hook)} ${twice}: ${name}`).not.toContain(name);
        for (const end of toolEnds(run)) if (end.error !== undefined) expect(end.error).toBe(CASES[0]!.told);
        expect(sentErrors(run)[0]).toContain("QZHEADA / QZLOW");
      }
    }
  });

  it("a hook that refuses the call is told in its own words", async () => {
    const run = await ask(CASES[0]!.args, { onToolResult: () => ({ reject: "Blocked by policy." }) });
    expect(toolEnds(run)[0]).toMatchObject({ outcome: "refused", error: "Blocked by policy." });
  });

  it("with eventResults, tool.end's result is the result as sent; its error and step stay short", async () => {
    const run = await ask(CASES[0]!.args, { eventResults: true });
    const [end] = toolEnds(run);
    expect(end!.error).toBe(CASES[0]!.told);
    expect(String(end!.result?.error)).toContain("QZHEADA / QZLOW");
  });

  it("a question that fails after the call: run.error's partial steps, onEvent and SSE, carry the count only", async () => {
    const run = await ask(CASES[0]!.args, { fail: true });
    const failed = run.events.at(-1) as Extract<AskEvent, { type: "run.error" }>;
    expect(failed.type).toBe("run.error");
    expect(failed.partial?.steps.at(-1)).toContain(CASES[0]!.told);
    for (const name of HEADERS) {
      expect(JSON.stringify(failed), name).not.toContain(name);
      expect(run.sse.slice(run.sse.indexOf("event: run.error")), name).not.toContain(name);
    }
  });

  it("toolResultSummary tells the tool set's own result in the same words", async () => {
    const { files, meta } = await table();
    const raw = await files.tools([meta]).execute("aggregate_table", { document_id: meta.id, ...CASES[0]!.args });
    expect(toolResultSummary("Aggregate budget.csv", raw)).toBe(` — failed: ${CASES[0]!.told}`);
    // A result made elsewhere is told as it is.
    expect(toolResultSummary("Aggregate budget.csv", { ...raw })).toBe(` — failed: ${raw.error}`);
  });
});
