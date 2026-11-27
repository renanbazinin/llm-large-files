// An answer made only of citations, with `showCitations: false` (LOOP-10, new in 0.99.13). Taking
// its citations out showed it empty, while it was reported answered and complete. The lines it cited
// are now shown in words ("line 8" in an English chat, "שורה 8" in a Hebrew one), with one
// "citations_only" notice; what the model wrote, and what its citations come to, do not change.
import { describe, expect, it } from "vitest";
import { answerInfoOf, askWithFiles, createLargeFiles, MemoryDocumentStore, type AskEvent } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "llm-large-files/testing";

async function library() {
  const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
  const contract = await files.ingest({ id: "contract-1", name: "contract.txt", bytes: utf8("Clause 1.\nClause 2: late fee 5%.\nClause 3.") });
  const customers = await files.ingest({ id: "customers-1", name: "לקוחות.txt", bytes: utf8("לקוח 1\nלקוח 2\nדני כהן, חיפה\nלקוח 4\nלקוח 5\nלקוח 6\nלקוח 7\nדני כהן, תל אביב\n") });
  return { files, contract, customers };
}

/** One question answered with `answer`: what is shown, its notices and its result. */
async function asked(documentId: string, answer: string, options: { showCitations?: boolean; question?: string } = {}) {
  const { files } = await library();
  const events: AskEvent[] = [];
  const pieces: string[] = [];
  const result = await askWithFiles({
    files,
    model: fakeModel([says(answer)]),
    documentIds: [documentId],
    messages: [{ role: "user", text: options.question ?? "Where?" }],
    ...(options.showCitations !== undefined ? { showCitations: options.showCitations } : {}),
    onText: (delta) => pieces.push(delta),
    onEvent: (event) => events.push(event),
  });
  const notices = events.flatMap((event) => (event.type === "notice" && event.code === "citations_only" ? [event] : []));
  const shown = events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");
  return { result, notices, shown, streamed: pieces.join("") };
}

describe("an answer made only of citations, shown without them", () => {
  const CASES: Array<{ label: string; documentId: string; answer: string; words: string }> = [
    { label: "a list of citations", documentId: "contract-1", answer: "- (contract.txt L2)\n- (L3)", words: "lines 2 and 3" },
    { label: "one citation", documentId: "contract-1", answer: "(contract.txt L2)", words: "line 2" },
    { label: "one citation of a Hebrew file", documentId: "customers-1", answer: "(לקוחות.txt L8)", words: "שורה 8" },
    { label: "two citations of a Hebrew file", documentId: "customers-1", answer: "(לקוחות.txt L3, L8)", words: "שורות 3 ו-8" },
  ];

  for (const { label, documentId, answer, words } of CASES) {
    it(`is shown as the lines it cited, in words: ${label}`, async () => {
      const hidden = await asked(documentId, answer, { showCitations: false });
      const plain = await asked(documentId, answer);
      expect(hidden.result.text).toBe(words);
      // What the page was sent is the same text.
      expect(hidden.shown).toBe(words);
      expect(hidden.streamed).toBe(words);
      expect(hidden.notices).toHaveLength(1);
      expect(hidden.notices[0]).toMatchObject({ display: "none", message: "The answer was only line citations, which are not shown: the lines it cited are shown in words." });
      expect(hidden.result.answered).toBe(true);
      expect(answerInfoOf(hidden.result).complete).toBe(true);
      // The citations are read from what the model wrote, as with them shown.
      expect(hidden.result.citations?.cited).toEqual(plain.result.citations?.cited);
      expect(hidden.result.citations?.cited?.length).toBeGreaterThan(0);
      // Shown with its citations, the answer is as the model wrote it, with no notice.
      expect(plain.result.text).toBe(answer);
      expect(plain.notices).toHaveLength(0);
    });
  }

  it("takes the words of the chat's language when the citation has no file name", async () => {
    expect((await asked("contract-1", "(L3)", { showCitations: false, question: "באיזו שורה?" })).result.text).toBe("שורה 3");
    expect((await asked("customers-1", "(L3)", { showCitations: false, question: "Which line?" })).result.text).toBe("line 3");
    // Nothing to go by in the answer or the question: the name of a Hebrew file.
    expect((await asked("customers-1", "(L3-L4)", { showCitations: false, question: "?" })).result.text).toBe("שורות 3–4");
    expect((await asked("contract-1", "(L3-L4)", { showCitations: false, question: "?" })).result.text).toBe("lines 3–4");
    // A Hebrew chat about a file with a Latin name is still a Hebrew chat.
    expect((await asked("contract-1", "(contract.txt L2)", { showCitations: false, question: "איפה כתוב על הקנס?" })).result.text).toBe("שורה 2");
    expect((await asked("contract-1", "- (contract.txt L2)\n- (L3)", { showCitations: false, question: "איפה?" })).result.text).toBe("שורות 2 ו-3");
  });

  it("says rows for rows", async () => {
    expect((await asked("contract-1", "(contract.txt Row 2)", { showCitations: false })).result.text).toBe("row 2");
  });

  it("puts a space between the words and the punctuation the citations left", async () => {
    const english = await asked("contract-1", "(contract.txt L2).", { showCitations: false });
    expect(english.result.text).toBe(". line 2");
    expect(english.shown).toBe(". line 2");
    expect(english.streamed).toBe(". line 2");
    expect(english.result.modelText).toBe("(contract.txt L2).");
    expect((await asked("contract-1", "(contract.txt L2).", { showCitations: false, question: "איפה?" })).result.text).toBe(". שורה 2");
  });

  it("changes nothing in an answer with words, or with a symbol, left", async () => {
    for (const answer of ["The fee is 5% (contract.txt L2).", "5% (L2)", "👍 (contract.txt L2)"]) {
      const hidden = await asked("contract-1", answer, { showCitations: false });
      expect(hidden.notices).toHaveLength(0);
      expect(hidden.result.text).not.toMatch(/line/);
    }
    expect((await asked("contract-1", "👍 (contract.txt L2)", { showCitations: false })).result.text).toBe("👍");
  });

  it("leaves an answer of parentheses that are not citations as it is", async () => {
    const hidden = await asked("contract-1", "(none)", { showCitations: false });
    expect(hidden.result.text).toBe("(none)");
    expect(hidden.notices).toHaveLength(0);
  });

  it("is told once a question, for each request that showed nothing but citations", async () => {
    const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() });
    const log = await files.ingest({ id: "log-1", name: "app.log", bytes: utf8(serviceLog(4_000)) });
    const events: AskEvent[] = [];
    const result = await askWithFiles({
      files,
      model: fakeModel([
        calls([{ name: "read_document", args: { document_id: log.id, start_line: 1, end_line: 3 } }], { text: "(app.log L1)" }),
        says("(app.log L2-L3)"),
      ]),
      documentIds: [log.id],
      messages: [{ role: "user", text: "Where?" }],
      showCitations: false,
      onEvent: (event) => events.push(event),
    });
    // The line break between the two requests goes with the line the hider found empty, as before.
    expect(result.text).toBe("line 1\nlines 2–3");
    expect(events.filter((event) => event.type === "notice" && event.code === "citations_only")).toHaveLength(1);
  });
});
