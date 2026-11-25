// `onToolResult` (0.10.0): the application's say on every tool result before the model, the
// evidence, the steps and the events get it. `{ result }` sends another result, marked
// `redacted: true` (outcome "redacted"); `{ reject }` sends an error (outcome "refused"); undefined
// keeps it; a throw, or a value of another shape, ends the question.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent, type ModelMessage, type ModelToolRound, type ToolResultContext } from "llm-large-files";
import { calls, fakeModel, says, utf8 } from "./fake-model.js";

const question = (text: string) => [{ role: "user" as const, text }];
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");
type ToolEnd = Extract<AskEvent, { type: "tool.end" }>;

/** A log of payments with Israeli ID numbers and card numbers in it, searched with the tools. */
async function payments() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  const lines = Array.from({ length: 400 }, (_, index) => `2026-11-12 payment ${index + 1} by ת.ז. 0${String(12_345_678 + index)} card 4580-1234-5678-${String(1_000 + index)} ok`);
  const meta = await files.ingest({ name: "payments.log", bytes: utf8(lines.join("\n")) });
  return { files, meta };
}

const read = (id: string, from = 1, to = 3) => ({ id: `r${from}`, name: "read_document", args: { document_id: id, start_line: from, end_line: to } });
const masked = (text: string) => text.replace(/\b\d{9}\b/g, "#########").replace(/\b\d{4}-\d{4}-\d{4}-\d{4}\b/g, "####-####-####-####");

describe("onToolResult", () => {
  it("replaces a result: the model, the evidence, the step and the event get the replacement, marked redacted", async () => {
    const { files, meta } = await payments();
    const seen: ToolResultContext[] = [];
    const events: AskEvent[] = [];
    const model = fakeModel([calls([read(meta.id)]), says("Three payments.")]);
    const result = await askWithFiles({
      files,
      model,
      // A document of no owner serves any caller: the owner goes to the hook as it was given.
      owner: "user-7",
      documentIds: [meta.id],
      messages: question("Which payments?"),
      eventResults: true,
      onEvent: (event) => events.push(event),
      onToolResult: (context) => {
        seen.push(context);
        return { result: { ...context.result, text: masked(String(context.result.text)) } };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ call: { name: "read_document" }, documentId: meta.id, owner: "user-7" });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(String(seen[0]!.result.text)).toContain("4580-1234-5678-1000");
    const sent = roundsOf(model.requests[1]!.messages)[0]!.answers[0]!.result;
    expect(sent).toMatchObject({ redacted: true, lines: "1-3" });
    // (The card's first lines are no tool result: a file that must not reach the model is redacted at ingest.)
    expect(JSON.stringify(roundsOf(model.requests[1]!.messages))).not.toContain("4580-1234-5678");
    expect(JSON.stringify(sent)).toContain("####-####-####-####");
    // What is kept is what the model saw.
    expect(result.toolTurns[0]!.calls[0]!.result).toMatchObject({ redacted: true });
    expect(JSON.stringify(result.toolTurns)).not.toContain("4580-1234-5678");
    expect(result.evidence).toEqual([expect.objectContaining({ tool: "read_document", documentId: meta.id, lines: [[1, 3]] })]);
    const end = events.find((event): event is ToolEnd => event.type === "tool.end")!;
    expect(end.outcome).toBe("redacted");
    expect(JSON.stringify(end)).not.toContain("4580-1234-5678");
  });

  it("rejects a result: the model gets the error, the call is refused, and nothing is evidence", async () => {
    const { files, meta } = await payments();
    const events: AskEvent[] = [];
    const model = fakeModel([calls([read(meta.id)]), says("I cannot show them.")]);
    const result = await askWithFiles({
      files,
      model,
      documentIds: [meta.id],
      messages: question("Which payments?"),
      onEvent: (event) => events.push(event),
      onToolResult: () => ({ reject: "This file holds card numbers, which cannot be shown." }),
    });
    expect(roundsOf(model.requests[1]!.messages)[0]!.answers[0]!.result).toEqual({ error: "This file holds card numbers, which cannot be shown.", tool_turns_left: 10 });
    expect(result.evidence).toEqual([]);
    expect(result.steps[0]).toMatch(/ — failed: This file holds card numbers, which cannot be shown\.$/);
    expect(events.find((event): event is ToolEnd => event.type === "tool.end")).toMatchObject({ outcome: "refused", error: "This file holds card numbers, which cannot be shown." });
  });

  it("keeps a result when it returns undefined, and takes one that holds a reject key as a result", async () => {
    const { files, meta } = await payments();
    const kept = fakeModel([calls([read(meta.id)]), says("ok")]);
    const plain = fakeModel([calls([read(meta.id)]), says("ok")]);
    await askWithFiles({ files, model: kept, documentIds: [meta.id], messages: question("?"), onToolResult: async () => undefined });
    await askWithFiles({ files, model: plain, documentIds: [meta.id], messages: question("?") });
    expect(JSON.stringify(kept.requests)).toBe(JSON.stringify(plain.requests));

    const events: AskEvent[] = [];
    const model = fakeModel([calls([read(meta.id)]), says("ok")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event), onToolResult: () => ({ result: { reject: "a field of the result", note: "replaced" } }) });
    expect(roundsOf(model.requests[1]!.messages)[0]!.answers[0]!.result).toEqual({ reject: "a field of the result", note: "replaced", redacted: true, tool_turns_left: 10 });
    expect(events.find((event): event is ToolEnd => event.type === "tool.end")!.outcome).toBe("redacted");
  });

  it("ends the question when it throws, or returns what it cannot return: the result never reaches the model", async () => {
    const { files, meta } = await payments();
    for (const hook of [
      () => {
        throw new Error("The DLP service is down.");
      },
      async () => Promise.reject(new Error("The DLP service is down.")),
      () => ({ text: "not a verdict" }) as never,
      () => ({ reject: 42 }) as never,
      () => ({ result: "masked" }) as never,
    ]) {
      const events: AskEvent[] = [];
      const model = fakeModel([calls([read(meta.id)]), says("ok")]);
      const outcome = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event), onToolResult: hook }).then(() => undefined, (error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toMatch(/^(The DLP service is down\.|onToolResult returned .*: it must return \{ result \}, \{ reject: "why" \} or undefined\.)$/);
      expect(model.requests).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "run.error" });
      expect(JSON.stringify(events)).not.toContain("4580-1234-5678");
    }
  });

  it("never points a later call to a replaced result: the call runs again, through the hook", async () => {
    const { files, meta } = await payments();
    let calls_ = 0;
    const model = fakeModel([calls([read(meta.id, 1, 50)]), calls([read(meta.id, 2, 3)]), calls([read(meta.id, 1, 50)]), says("ok")]);
    await askWithFiles({
      files,
      model,
      documentIds: [meta.id],
      messages: question("?"),
      onToolResult: (context) => {
        calls_++;
        return { result: { ...context.result, text: masked(String(context.result.text)) } };
      },
    });
    // Without the hook, lines 2-3 and the read made again would be "already shown above".
    expect(calls_).toBe(3);
    const rounds = roundsOf(model.requests[3]!.messages);
    expect(rounds.map((round) => round.answers[0]!.result.already_shown)).toEqual([undefined, undefined, undefined]);
    expect(rounds.map((round) => round.answers[0]!.result.redacted)).toEqual([true, true, true]);
  });

  it("gives the same call made twice in one turn the first one's verdict, not a pointer to it", async () => {
    const { files, meta } = await payments();
    const twice = () => calls([{ ...read(meta.id), id: "a" }, { ...read(meta.id), id: "b" }]);
    const asked = async (hook: () => { result: { text: string } } | { reject: string } | undefined) => {
      const events: AskEvent[] = [];
      const model = fakeModel([twice(), says("ok")]);
      let hooked = 0;
      const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event), onToolResult: () => {
        hooked++;
        return hook();
      } });
      const sent = roundsOf(model.requests[1]!.messages)[0]!.answers.map((answer) => answer.result);
      const outcomes = events.filter((event): event is ToolEnd => event.type === "tool.end").map((event) => event.outcome);
      return { sent, outcomes, hooked, result };
    };
    // Replaced: the second gets the same replacement (before this, "already shown" pointed to it).
    const replaced = await asked(() => ({ result: { text: "[redacted]" } }));
    expect(replaced.sent).toEqual([{ text: "[redacted]", redacted: true, tool_turns_left: 10 }, { text: "[redacted]", redacted: true, tool_turns_left: 10 }]);
    expect(replaced.outcomes).toEqual(["redacted", "redacted"]);
    expect(replaced.hooked).toBe(1);
    // The copy shows nothing the first did not: one entry of evidence.
    expect(replaced.result.evidence).toHaveLength(1);
    // Rejected: the second gets the same error.
    const rejected = await asked(() => ({ reject: "Card numbers cannot be shown." }));
    expect(rejected.sent).toEqual([{ error: "Card numbers cannot be shown.", tool_turns_left: 10 }, { error: "Card numbers cannot be shown.", tool_turns_left: 10 }]);
    expect(rejected.outcomes).toEqual(["refused", "refused"]);
    // Kept: the second still points to the first, which is the tool's own result.
    const kept = await asked(() => undefined);
    expect(kept.sent[1]).toMatchObject({ already_shown: true });
    expect(kept.outcomes).toEqual(["ok", "already_shown"]);
    expect(kept.hooked).toBe(1);
  });

  it("fits a replacement to the room in the request, as it does the tool's own result", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10, contextTokens: 128_000 } });
    const lines = Array.from({ length: 5_000 }, (_, index) => `2026-11-12 08:00:00 INFO request ${index + 1} ok`);
    const meta = await files.ingest({ name: "app.log", bytes: utf8(lines.join("\n")) });
    const events: AskEvent[] = [];
    const model = fakeModel([calls([read(meta.id)]), says("ok")], { contextTokens: 128_000 });
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onEvent: (event) => events.push(event), onToolResult: () => ({ result: { text: "x ".repeat(1_000_000) } }) });
    const sent = roundsOf(model.requests[1]!.messages)[0]!.answers[0]!.result;
    expect(sent.redacted).toBe(true);
    expect(JSON.stringify(sent).length).toBeLessThan(400_000);
    // Before this, the replacement went as it was: a request of about 1,105,000 tokens on a window of 128,000.
    const starts = events.filter((event): event is Extract<AskEvent, { type: "request.start" }> => event.type === "request.start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.estimatedInputTokens).toBeLessThan(128_000);
  });

  it("runs the hooks of a turn at the same time, and applies their verdicts in call order", async () => {
    const { files, meta } = await payments();
    const reads = Array.from({ length: 8 }, (_, index) => read(meta.id, 1 + index * 10, 3 + index * 10));
    const model = fakeModel([calls(reads), says("ok")]);
    // Each hook waits until all eight have started. One after another, the first would wait for ever:
    // after 2 s the gate opens anyway, and the test fails.
    let started = 0;
    let opened: "together" | "late" | undefined;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const late = setTimeout(() => {
      opened ??= "late";
      open();
    }, 2_000);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onToolResult: async (context) => {
      started++;
      if (started === reads.length) {
        opened ??= "together";
        open();
      }
      await gate;
      return { result: { lines: context.result.lines, text: "masked" } };
    } });
    clearTimeout(late);
    expect(opened).toBe("together");
    expect(roundsOf(model.requests[1]!.messages)[0]!.answers.map((answer) => answer.result.lines)).toEqual(reads.map((call) => `${call.args.start_line}-${call.args.end_line}`));
  });

  it("ends the question when the hook of a later call fails, without waiting for the hook of an earlier one", async () => {
    const { files, meta } = await payments();
    const model = fakeModel([calls([read(meta.id, 1, 3), read(meta.id, 10, 12)]), says("ok")]);
    let firstAborted = false;
    const began = Date.now();
    const outcome = await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onToolResult: (context) => {
      if (context.call.args.start_line === 1) {
        // A DLP call that does not answer: it ends with the question.
        return new Promise(() => {
          context.signal.addEventListener("abort", () => {
            firstAborted = true;
          });
        });
      }
      throw new Error("The DLP service is down.");
    } }).then(() => undefined, (error: unknown) => error);
    expect(outcome).toMatchObject({ message: "The DLP service is down." });
    expect(firstAborted).toBe(true);
    expect(model.requests).toHaveLength(1);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it("is not called for a call that did not run, and stops waiting for it when the question is stopped", async () => {
    const { files, meta } = await payments();
    const seen: string[] = [];
    const model = fakeModel([calls([read(meta.id), { id: "u", name: "no_such_tool", args: {} }]), says("ok")]);
    await askWithFiles({ files, model, documentIds: [meta.id], messages: question("?"), onToolResult: (context) => {
      seen.push(context.call.name);
      return undefined;
    } });
    expect(seen).toEqual(["read_document"]);

    const stop = new AbortController();
    let aborted = false;
    const waiting = fakeModel([calls([read(meta.id)]), says("ok")]);
    const started = Date.now();
    const outcome = askWithFiles({ files, model: waiting, documentIds: [meta.id], messages: question("?"), signal: stop.signal, onToolResult: (context) => new Promise(() => {
      context.signal.addEventListener("abort", () => {
        aborted = true;
      });
      setTimeout(() => stop.abort(new Error("The user stopped the question.")), 50);
    }) }).then(() => undefined, (error: unknown) => error);
    expect(await outcome).toMatchObject({ message: "The user stopped the question." });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
