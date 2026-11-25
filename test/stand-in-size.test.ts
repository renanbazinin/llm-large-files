// A stand-in (`stubResult`) is never larger than the result it replaces (0.9.0). A search counted by
// group, or an aggregate_table result, of a few short groups was a little over the 700 characters
// under which a result is left as it is, and its stand-in, which keeps up to 30 groups and adds a
// note, came out larger: 845 characters grew to 1,073, and 877 to 1,041.
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore, ModelRequestError, stubResult, type ModelMessage, type ModelToolRound, type ToolTurn } from "llm-large-files";
import { fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const groups = Array.from({ length: 30 }, (_, index) => ({ key: `E${index}`, count: index + 1 }));
const groupedCall = { name: "search_document", args: { document_id: "doc_x", query: "E\\d+", mode: "regex", group_by: "capture" } };
const grouped = { document: "app.log", mode: "regex", group_by: "capture", total_matching_lines: 465, total_groups: 30, groups };
const aggregateCall = { name: "aggregate_table", args: { document_id: "doc_x" } };
const aggregated = { document: "t.csv", table: "Sheet1", rows_matched: 1_200, total_groups: 30, groups: groups.map((group) => ({ key: [group.key], count: group.count })) };

const size = (value: unknown) => JSON.stringify(value).length;
const roundsOf = (messages: ModelMessage[]) => messages.filter((message): message is ModelToolRound => message.role === "tools");

describe("a stand-in", () => {
  it("is not given for a grouped search or an aggregate_table result it would be larger than", () => {
    // The two results of the probe: over the 700-character floor, under their stand-ins.
    expect(size(grouped)).toBe(845);
    expect(size(aggregated)).toBe(877);
    expect(stubResult(groupedCall, grouped)).toBeUndefined();
    expect(stubResult(aggregateCall, aggregated)).toBeUndefined();
  });

  it("is still given when it is smaller, and keeps the groups", () => {
    const many = { ...grouped, total_groups: 90, groups: [...groups, ...groups, ...groups] };
    const stub = stubResult(groupedCall, many)!;
    expect(stub).toMatchObject({ dropped: true, group_by: "capture", total_groups: 90 });
    expect((stub.groups as unknown[]).length).toBe(30);
    expect(size(stub)).toBeLessThan(size(many));
  });

  it("is always given for a result whose pages go with it, however small", () => {
    const call = { name: "view_pages", args: { document_id: "doc_x", from_page: 2 } };
    const stub = stubResult(call, { document: "r.pdf", pages: "2", total_pages: 9, file: "pages-2.pdf" }, true)!;
    expect(stub).toMatchObject({ dropped: true, pages: "2", total_pages: 9 });
    expect(size(stub)).toBeGreaterThan(size({ document: "r.pdf", pages: "2", total_pages: 9, file: "pages-2.pdf" }));
  });

  it("leaves such a result as it is when the loop makes room", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    const read = (from: number) => ({ name: "read_document", args: { document_id: meta.id, start_line: from, end_line: from + 199 } });
    // A stored round of an earlier question: the small grouped search, and a read.
    const stored: ToolTurn = { role: "tools", calls: [{ ...groupedCall, args: { ...groupedCall.args, document_id: meta.id }, result: grouped }, { ...read(1), result: { document: "app.log", lines: "1-200", total_lines: 5_000, text: "x".repeat(20_000) } }] };
    let refused = false;
    const model = fakeModel([
      () => {
        if (refused) return says("Done.");
        refused = true;
        return new ModelRequestError("The input token count (130000) exceeds the maximum number of tokens allowed (100000).", 400);
      },
    ]);
    const result = await askWithFiles({ files, model, documentIds: [meta.id], messages: [{ role: "user", text: "errors?" }, stored, { role: "assistant", text: "45." }, { role: "user", text: "again?" }] });
    expect(result.answered).toBe(true);
    const [round] = roundsOf(model.requests.at(-1)!.messages);
    // The read was replaced by its stand-in; the grouped search is sent as it was.
    expect(round!.answers[1]!.result.dropped).toBe(true);
    expect(round!.answers[0]!.result).toEqual(grouped);
  });
});
