// S11, the library's side (0.9.0): a file's MIME type is kept as a lowercased type/subtype of RFC 9110
// token characters, without parameters; anything else is "application/octet-stream". It reaches
// summaries, ingest.finish and logs, so a line break or a hidden character must not get through.
import { describe, expect, it } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type IngestEvent } from "llm-large-files";
import { cleanMimeType } from "../src/ingest.js";
import { utf8 } from "./fake-model.js";

const OCTET = "application/octet-stream";

describe("cleanMimeType", () => {
  it("keeps the type and subtype, in lower case, and drops parameters", () => {
    expect(cleanMimeType("Text/CSV; charset=x")).toBe("text/csv");
    expect(cleanMimeType("  application/PDF ")).toBe("application/pdf");
    expect(cleanMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(cleanMimeType("text/plain;charset=utf-8;format=flowed")).toBe("text/plain");
  });

  it("makes anything else application/octet-stream", () => {
    for (const raw of [
      "text/plain\r\nX-Injected: yes",
      "text/plain\n",
      "text/csv; charset=\r\n",
      "text/plain‮gnp.exe",
      "text/plain\u{E0041}",
      `text/${"x".repeat(8_006)}`,
      `${"a".repeat(64)}/${"b".repeat(63)}`,
      "text",
      "text/",
      "/plain",
      "text/plain/extra",
      "text plain",
      "téxt/plain",
      "",
      "   ",
      undefined,
      null,
      42,
    ]) expect(cleanMimeType(raw), JSON.stringify(raw)?.slice(0, 40)).toBe(OCTET);
    expect(`text/${"x".repeat(8_006)}`).toHaveLength(8_011);
    // 127 characters are kept.
    expect(cleanMimeType(`${"a".repeat(63)}/${"b".repeat(63)}`)).toHaveLength(127);
  });
});

describe("the MIME type of an ingest", () => {
  it("is cleaned before it is stored, told in events and summaries, or used to pick the format", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    const events: IngestEvent[] = [];
    const bad = await files.ingest({ name: "notes", mimeType: "text/plain\r\nX-Injected: yes", bytes: utf8("one\ntwo\n"), onEvent: (event) => events.push(event) });
    expect(bad.mimeType).toBe(OCTET);
    expect(JSON.stringify(events)).not.toContain("Injected");
    for (const raw of ["text/plain‮gnp.exe", "text/plain\u{E0041}", `text/${"x".repeat(8_006)}`]) {
      expect((await files.ingest({ name: "notes", mimeType: raw, bytes: utf8("one\n") })).mimeType).toBe(OCTET);
    }
    // A type with parameters names the format, as the type alone does.
    const table = await files.ingest({ name: "data", mimeType: "Text/CSV; charset=x", bytes: utf8("a,b\n1,2\n") });
    expect(table).toMatchObject({ mimeType: "text/csv", format: "csv" });
    expect((await files.getMeta(table.id))?.mimeType).toBe("text/csv");
  });
});
