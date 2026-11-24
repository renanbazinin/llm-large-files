// `checkCitations` (0.10.0) held to the clock: it runs at the end of every question, on the event
// loop, so its time grows with the length of the answer, not with its square. Before this, 120,000
// characters of bare "L1" took about a minute, and a list of 2,000 cited lines about 0.4 s. The
// other tests of the citations are in test/citations.test.ts.
import { describe, expect, it } from "vitest";
import { checkCitations, type Evidence } from "llm-large-files";

const evidence: Evidence[] = [
  { tool: "read_document", documentId: "doc_l", document: "app.log", lines: [[1, 50_000]] },
  { tool: "read_document", documentId: "doc_d", document: "db.log", lines: [[1, 50_000]] },
];
const names = { "doc_l": "app.log", "doc_d": "db.log" };

/** Milliseconds `checkCitations` takes on `text`, and what it found. */
function timed(text: string) {
  const began = performance.now();
  const found = checkCitations(text, evidence, names);
  return { ms: performance.now() - began, found };
}

describe("checkCitations on long answers", () => {
  it("reads one long line of bare L and a number, a hostile answer, in time that grows with its length", () => {
    const { ms, found } = timed("L1 ".repeat(40_000));
    expect(found.checked + found.unchecked).toBe(0);
    expect(ms).toBeLessThan(2_000);
  });

  it("reads thousands of citations, on one line or on many, in time that grows with their number", () => {
    const paragraph = Array.from({ length: 4_000 }, (_, index) => `the request failed again (app.log L${97 * (index + 1)}) and then the database (db.log L${index + 1}) followed`).join(", ");
    const bullets = Array.from({ length: 2_000 }, (_, index) => `- שגיאת זמן קצוב בבקשה מספר ${index} בשורה ${index + 1} של app.log`).join("\n");
    const listed = "app.log L1, ".repeat(5_000);
    expect(timed(paragraph).found.checked).toBe(8_000);
    expect(timed(bullets).found.checked).toBe(2_000);
    expect(timed(listed).found.checked).toBe(5_000);
    for (const text of [paragraph, bullets, listed]) expect(timed(text).ms).toBeLessThan(2_000);
  });
});
