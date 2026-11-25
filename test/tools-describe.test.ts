// The labels of tool calls, read from the arguments the way the tools read them (LLF-061), and the
// step of a whole-file read that lists items.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, toolResultSummary } from "../src/index.js";
import { serviceLog, utf8 } from "./fake-model.js";

async function tools() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(2_000)) });
  return { tools: files.tools([meta]), id: meta.id };
}

describe("describe() of read_document", () => {
  it("shows an end line sent as text, as the tool reads it (probe1, LLF-061)", async () => {
    const { tools: set, id } = await tools();
    // 0.9.0 read "250" as no end: "Read app.log lines 1", while the tool read lines 1-250.
    expect(set.describe("read_document", { document_id: id, start_line: 1, end_line: "250" })).toBe("Read app.log lines 1-250");
    expect((await set.execute("read_document", { document_id: id, start_line: 1, end_line: "250" })).lines).toBe("1-250");
    expect(set.describe("read_document", { document_id: id, start_line: "40", end_line: "45" })).toBe("Read app.log lines 40-45");
  });

  it("shows the end the tool reads up to, and none when the call gave none or one before its start", async () => {
    const { tools: set, id } = await tools();
    expect(set.describe("read_document", { document_id: id, start_line: 1200, end_line: 1260 })).toBe("Read app.log lines 1200-1260");
    expect(set.describe("read_document", { document_id: id, start_line: 1200 })).toBe("Read app.log lines 1200");
    expect(set.describe("read_document", { document_id: id, start_line: 30, end_line: 10 })).toBe("Read app.log lines 30");
    expect(set.describe("read_document", { document_id: id, start_line: 30, end_line: "" })).toBe("Read app.log lines 30");
    // One read shows at most 600 lines: the label says what the read shows.
    expect(set.describe("read_document", { document_id: id, start_line: 1, end_line: 5_000 })).toBe("Read app.log lines 1-600");
  });
});

describe("a whole-file read that lists items", () => {
  it("says so in its label, and gives its count in its step", async () => {
    const { tools: set, id } = await tools();
    expect(set.describe("analyze_whole_document", { document_id: id, task: "every timeout", output: "items" })).toBe("Read all of app.log for “every timeout”, as a list of items");
    const label = "Read all of app.log for “every timeout”, as a list of items";
    expect(toolResultSummary(label, { document: "app.log", total_items: 37, items: [], unverified_items: 0, parts_read: 4 })).toBe(" — 37 items in 4 parts");
    expect(toolResultSummary(label, { document: "app.log", total_items: 1, items: [], unverified_items: 2, parts_read: 1, parts_failed: 1 })).toBe(" — 1 item in 1 part, 2 not counted, incomplete");
    expect(toolResultSummary("Read all of app.log for “x”", { document: "app.log", parts_read: 9, parts_with_relevant_content: 3, notes_left_out: 2, answer: "…" })).toBe(" — 9 parts, 3 relevant, incomplete");
  });
});
