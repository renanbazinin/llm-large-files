import { describe, expect, it, vi } from "vitest";
import { extractText } from "../src/extract.js";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { numberedPdf, paint, PdfBuilder, textLine } from "./pdf-fixtures.js";

// In this file the optional dependency is not installed: importing it fails, as it does in an
// application that never ran `npm install @cantoo/pdf-lib`.
vi.mock("@cantoo/pdf-lib", () => {
  throw new Error("Cannot find package '@cantoo/pdf-lib'");
});

describe("view_pages without the PDF library", () => {
  it("says which dependency is missing, and everything else keeps working", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), keepOriginals: ["pdf"] });
    // Ingest and keeping the original need only the PDF reader.
    const meta = await files.ingest({ name: "report.pdf", bytes: numberedPdf(2) });
    expect(meta.originalKept).toBe(true);
    const tools = files.tools([meta], { viewPages: true });
    expect(await tools.executeWithFiles("view_pages", { document_id: meta.id, from_page: 1 })).toEqual({
      result: { error: "report.pdf: Showing PDF pages needs the optional dependency \"@cantoo/pdf-lib\"." },
      files: [],
    });
    expect(await tools.execute("read_document", { document_id: meta.id, start_line: 1, end_line: 2 })).toMatchObject({ text: "1| --- Page 1 ---\n2| Page 1 of the test file." });
  });

  it("extracts the text of 0.2.0: no page is marked as showing a picture", async () => {
    const builder = new PdfBuilder();
    builder.page(`${textLine("A photo.")}\n${paint("Im1", 300, 200)}`, { Im1: builder.image() });
    const input = { name: "a.pdf", mimeType: "application/pdf", format: "pdf" as const };
    expect((await extractText(builder.build(), input)).text).toBe("--- Page 1 ---\nA photo.");
  });
});
