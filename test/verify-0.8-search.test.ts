// Regression tests for the findings of the verification of 0.8.0 in search: each finding, with an
// input that showed it. Those that hold the work to the clock are in test/timing/search.timing.test.ts
// and test/timing/text.timing.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, type DocumentMeta, type LargeFiles, type ToolResult } from "../src/index.js";
import { Limiter } from "../src/limiter.js";
import { TimeSlicer } from "../src/pause.js";
import { openRangedDocument } from "../src/ranged.js";
import { grep, grepSource, queryTerms, rankPassages, rankSource, SearchableDocument, unsafeRegexReason } from "../src/search.js";
import { buildTextIndex } from "../src/text-index.js";
import { breaksAtNextLine, composed, normalizeInPieces, normalizeText } from "../src/text.js";
import { utf8 } from "./fake-model.js";

/**
 * The heap that is still used after a full collection: what the code keeps. The peak of `heapUsed`
 * counts garbage not collected yet too, whose room differs between versions of V8: in the search
 * below it was 16 MB on Node 22 and 65 MB on Node 24, with nothing kept.
 */
function keptBytes(): number {
  collectGarbage();
  return process.memoryUsage().heapUsed;
}
setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const doc = (text: string) => new SearchableDocument({ meta: { id: "doc_v", name: "v.txt", textBytes: text.length } as DocumentMeta, text });
/** A test that takes a second or two alone, with room for a machine busy with other tests. */
const BUSY_TIMEOUT_MS = 20_000;
const linesOf = (result: ToolResult) => (result.matches as Array<{ line: number }>).map((match) => match.line);

/** The same file in memory, and read by range from a folder in pieces of one passage: the results must agree. */
async function bothWays(name: string, text: string, scanChunkBytes = 64): Promise<Array<{ files: LargeFiles; meta: DocumentMeta; how: string }>> {
  const memory = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  directory = await mkdtemp(path.join(tmpdir(), "llf-verify-search-"));
  const ranged = createLargeFiles({ requireOwner: false, store: new FileDocumentStore(directory), budget: { inlineTokens: 10 }, wholeDocumentBytes: 0, scanChunkBytes });
  return [
    { files: memory, meta: await memory.ingest({ name, bytes: utf8(text) }), how: "in memory" },
    { files: ranged, meta: await ranged.ingest({ name, bytes: utf8(text) }), how: "by range" },
  ];
}

/** A log of `count` lines that all hold "ERROR", with numbers, addresses and IDs that vary. */
const errorLog = (count: number) => Array.from({ length: count }, (_, index) => `2026-11-10T14:${String(index % 60).padStart(2, "0")}:17Z ERROR job ${index} failed at 10.0.${index % 256}.1 id=${(index * 7919).toString(16)}`).join("\n");

describe("a document held in memory is searched in pieces, within a time limit (6, 50)", () => {
  // Under a second with one test file at a time, 2.3 s beside the other files on a busy machine.
  it("stops an exact search at its time limit, and says the counts are lower bounds", () => {
    const document = doc(errorLog(250_000));
    const result = grep(document, "ERROR", { maxResults: 5, contextLines: 0, groupBy: "shape", timeLimitMs: 20 });
    expect(result.stoppedEarly).toBe(true);
    expect(result.totalMatchingLines).toBeLessThan(250_000);
    expect(grep(document, "ERROR", { maxResults: 5, contextLines: 0, timeLimitMs: 60_000 }).totalMatchingLines).toBe(250_000);
  }, BUSY_TIMEOUT_MS);

  it("keeps nothing for each line a regex slice finds", async () => {
    const document = doc(Array.from({ length: 1_500_000 }, (_, index) => `ln${String(index).padStart(10, "0")}x`).join("\n"));
    document.lines.line(1);
    const start = keptBytes();
    let peak = start;
    // The clock is told the time of each slice at its end, while what the slice keeps is still held.
    let used = 0;
    const regexClock = {
      get usedMs() {
        return used;
      },
      set usedMs(value: number) {
        used = value;
        peak = Math.max(peak, keptBytes());
      },
    };
    const result = await grepSource(document, "x$", { regex: true, maxResults: 5, contextLines: 0, timeLimitMs: 60_000, regexClock });
    expect(result.totalMatchingLines).toBe(1_500_000);
    // An object for each line found, kept to the end of the slice, kept 7 MB here (a piece of the
    // document at a time); the search keeps under 1 MB.
    expect(peak - start).toBeLessThan(3 * 1024 * 1024);
  }, BUSY_TIMEOUT_MS);

  it("records every line of a regex search once, whatever batches and slices cut", () => {
    const text = Array.from({ length: 150_000 }, (_, index) => (index % 2 === 0 ? `PAY-${index % 7} ok ${index}` : `other ${index}`)).join("\n");
    const document = doc(text);
    const counted = grep(document, "PAY-(\\d)", { regex: true, maxResults: 5, contextLines: 0, groupBy: "capture", timeLimitMs: 60_000 });
    expect(counted.totalMatchingLines).toBe(75_000);
    expect(counted.groups!.groups.reduce((sum, group) => sum + group.count, 0)).toBe(75_000);
    const last = grep(document, "PAY-", { regex: true, maxResults: 3, contextLines: 1, order: "last", timeLimitMs: 60_000 });
    expect(last.matches.map((match) => match.line)).toEqual([149_995, 149_997, 149_999]);
    expect(last.matches[2]!.after).toEqual(["150000| other 149999"]);
  });
});

describe("keyword search of pointed Hebrew (7)", () => {
  const filler = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `שורה ${tag}${index} עוד טקסט רגיל בלי כלום`).join("\n");
  const TEXT = [filler(120, "א"), "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ", filler(29, "ב"), "שָׁלוֹם עֲלֵיכֶם וְהַחוֹזֶה נֶחְתַּם", filler(181, "ג")].join("\n");

  it("finds pointed words with queries written with points or without them, in memory and by range", async () => {
    for (const { files, meta, how } of await bothWays("bible.txt", TEXT, 2_048)) {
      const tools = files.tools([meta]);
      for (const [query, line] of [["בראשית ברא", 121], ["שלום", 151], ["החוזה", 151], ["אלהים", 121], ["אֱלֹהִים", 121], ["עֲלֵיכֶם", 151], ["נחתם", 151]] as const) {
        const result = await tools.execute("search_document", { document_id: meta.id, query });
        const [from, to] = (result.passages as Array<{ lines: string }>)[0]!.lines.split("-").map(Number);
        expect(from! <= line && line <= to!, `${how}: ${query}`).toBe(true);
      }
    }
  });

  it("finds a pointed word written with the presentation forms some fonts use", () => {
    // שׁ (U+FB2A) is composed to ש and a shin dot at ingest, as the query is.
    const document = doc([filler(50, "א"), composed("\ufb2aָלוֹם לכולם"), filler(50, "ב")].join("\n"));
    const ranked = rankPassages(document, "שלום", 1);
    expect(ranked[0]!.from <= 51 && 51 <= ranked[0]!.to).toBe(true);
  });
});

describe("keyword search of Hebrew acronyms (8)", () => {
  it("keeps a geresh or a gershayim between two Hebrew letters in a term", () => {
    expect(queryTerms("ש״ח")).toEqual(["ש\"ח"]);
    expect(queryTerms("עו״ד")).toEqual(["עו\"ד"]);
    expect(queryTerms("עו\"ד")).toEqual(["עו\"ד"]);
    expect(queryTerms("ש''ח")).toEqual(["ש\"ח"]);
    expect(queryTerms("בש״ח")).toEqual(["בש\"ח", "ש\"ח"]);
    expect(queryTerms("ג׳ורג׳")).toEqual(["ג'ורג"]);
    // Quotes elsewhere still split words.
    expect(queryTerms("\"חוזה\" 'דירה'")).toEqual(["חוזה", "דירה"]);
    expect(queryTerms("don't")).toEqual(["don"]);
  });

  it("finds the passage with the acronym, however the file or the query writes it", async () => {
    const filler = (count: number) => Array.from({ length: count }, (_, index) => `שורה ${index} עוד עובד בעבודה רגילה`).join("\n");
    const text = [filler(330), "שכר הטרחה של עו״ד כהן הוא 5,000 ש״ח לחודש.", filler(40), "דמי השכירות 4,000 ש''ח לחודש.", filler(40)].join("\n");
    for (const { files, meta, how } of await bothWays("fee.txt", text, 2_048)) {
      const tools = files.tools([meta]);
      const found = async (query: string) => ((await tools.execute("search_document", { document_id: meta.id, query })).passages as Array<{ lines: string }>)
        .map((passage) => passage.lines.split("-").map(Number) as [number, number]);
      const holds = ([from, to]: [number, number], line: number) => from <= line && line <= to;
      for (const query of ["עו״ד", "עו\"ד"]) expect(holds((await found(query))[0]!, 331), `${how}: ${query}`).toBe(true);
      // ש״ח is on two lines: one writes it with a gershayim, the other with two gereshes.
      for (const query of ["ש״ח", "ש\"ח", "ש''ח"]) {
        const passages = await found(query);
        expect(passages, `${how}: ${query}`).toHaveLength(2);
        expect(passages.some((passage) => holds(passage, 331)) && passages.some((passage) => holds(passage, 372)), `${how}: ${query}`).toBe(true);
      }
    }
  });
});

describe("exact text across lines that starts on to_line (9)", () => {
  it("finds it when to_line is the last line of a piece read by range", async () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1} ok`);
    lines[39] = "total: 12 items, status OK";
    lines[40] = "Approved by: Dana";
    lines[41] = "on the 3rd";
    for (const { files, meta, how } of await bothWays("r.txt", `${lines.join("\n")}\n`)) {
      const tools = files.tools([meta]);
      for (const [query, scope, expected] of [
        ["status OK\nApproved", { to_line: 40 }, [40]],
        ["status OK\nApproved", { from_line: 30, to_line: 40 }, [40]],
        ["status OK\nApproved", { to_line: 39 }, []],
        ["line 39 ok\ntotal: 12 items, status OK\nApproved", { to_line: 39 }, [39]],
        ["status OK\nApproved by: Dana\non the", { to_line: 40 }, [40]],
      ] as const) {
        const result = await tools.execute("search_document", { document_id: meta.id, query, mode: "exact", ...scope });
        expect(linesOf(result), `${how}: ${JSON.stringify({ query, scope })}`).toEqual(expected);
      }
    }
  });
});

describe("words next to emoji and full-width punctuation (10, 11)", () => {
  const document = doc("⚠\ufe0fWarning: disk full\n1\ufe0f\u20e3Step one\n⚠ Warning\nWarning😀\nxWarning\nID\uff3f2041 closed\nID 7\nnaïveté\nनमस्ते दुनिया\n");
  const lines = (query: string, options: { regex?: boolean; wholeWord?: boolean; caseSensitive?: boolean }) => grep(document, query, { maxResults: 20, contextLines: 0, ...options }).matches.map((match) => match.line);

  it("does not count a variation selector or a keycap as part of a word", () => {
    expect(lines("Warning", { wholeWord: true })).toEqual([1, 3, 4]);
    expect(lines("\\bWarning\\b", { regex: true })).toEqual([1, 3, 4]);
    expect(lines("Step", { wholeWord: true })).toEqual([2]);
    expect(lines("\\bStep\\b", { regex: true })).toEqual([2]);
    expect(lines("^\\W+Warning", { regex: true })).toEqual([1, 3]);
    // The marks of letters still belong to their words.
    expect(lines("नमस्ते", { wholeWord: true })).toEqual([9]);
    expect(lines("नमस्", { wholeWord: true })).toEqual([]);
    expect(lines("\\bनमस्ते\\b", { regex: true })).toEqual([9]);
    expect(lines("na\\w+", { regex: true })).toEqual([8]);
  });

  it("finds a whole word next to a full-width low line whether case is ignored or not", () => {
    expect(lines("ID", { wholeWord: true, caseSensitive: true })).toEqual([6, 7]);
    expect(lines("ID", { wholeWord: true })).toEqual([6, 7]);
    expect(lines("id", { wholeWord: true })).toEqual([6, 7]);
    expect(lines("ID\uff3f", { wholeWord: true })).toEqual([6]);
    expect(grep(doc("a__id\n__id x\n_id\n"), "_id", { maxResults: 5, contextLines: 0, wholeWord: true }).matches.map((match) => match.line)).toEqual([3]);
  });

  it("goes on past a whole-word candidate that starts with an emoji", () => {
    const emoji = doc("😀__ x\n😀_ y\n");
    expect(grep(emoji, "😀_", { maxResults: 5, contextLines: 0, wholeWord: true }).matches.map((match) => match.line)).toEqual([2]);
  });
});

describe("a ranged keyword search reads and counts only what it needs (13, 53, 54)", () => {
  it("stops reading a document by range after to_line", async () => {
    const text = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1} payment timeout ${index % 13}`).join("\n");
    const bytes = utf8(text);
    const index = buildTextIndex(text);
    let read = 0;
    const store = {
      readTextRange: async (_id: string, start: number, end: number) => {
        read += end - start;
        return bytes.slice(start, end);
      },
    };
    const meta = { id: "doc_r", name: "r.log", format: "log", lines: index.lineCount, characters: index.characters, textBytes: index.textBytes, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } as DocumentMeta;
    const document = (await openRangedDocument(store, meta, { chunkBytes: 4_096, limiter: new Limiter(4) }))!;
    read = 0;
    const ranked = await rankSource(document, "payment timeout", 5, undefined, { from: 1, to: 50 });
    expect(ranked.length).toBeGreaterThan(0);
    for (const passage of ranked) expect(passage.from).toBeLessThanOrEqual(50);
    expect(read).toBeLessThan(bytes.length / 10);
  });

  it("does not let phrases before the range fill the cap on phrase passages", () => {
    const pad = (line: string) => line.padEnd(99, " z");
    const filler = (index: number) => pad(`filler line ${index} lorem ipsum dolor sit amet`);
    const inRange: string[] = [];
    // Lines 200001-200015: the whole phrase once; lines 200016-200030: the two words apart, each twice.
    for (let index = 0; index < 15; index++) inRange.push(index === 7 ? pad("the payment failed for order 77") : filler(index));
    for (let index = 0; index < 15; index++) inRange.push(index === 3 || index === 9 ? pad("payment was retried, order 88") : index === 5 || index === 11 ? pad("then it failed again, order 88") : filler(100 + index));
    for (let index = 0; index < 2_000; index++) inRange.push(filler(1_000 + index));
    const range = { from: 200_001, to: 200_000 + inRange.length };
    for (const phrase of ["paymant faileq", "payment failed"]) {
      const before = Array.from({ length: 200_000 }, (_, index) => pad(`${phrase} at step ${index} in the old part`));
      const ranked = rankPassages(doc([...before, ...inRange].join("\n")), "payment failed", 3, range);
      // The passage of line 200008, with the phrase, first.
      expect(ranked[0]!.from <= 200_008 && 200_008 <= ranked[0]!.to, phrase).toBe(true);
    }
  }, BUSY_TIMEOUT_MS);
});

describe("a regex checked as it is compiled (55)", () => {
  it("refuses a nested quantifier whose separator is a decomposed letter", async () => {
    for (const pattern of ["(\\p{L}+e\u0301)+$", "([a-ze\u0301]+e\u0301)+$", "(e\u0301+e\u0301)+$", "(\\p{L}+é)+$"]) {
      expect(unsafeRegexReason(pattern), pattern).toMatch(/nested quantifier/);
    }
    for (const pattern of ["(\\w+\\.)+com", "(\\d{1,3}\\.){3}\\d{1,3}", "([a-z]+é)+x", "(\\w+')+s"]) expect(unsafeRegexReason(pattern), pattern).toBeNull();
    await expect(grepSource(doc(`${"é".repeat(40)}!\n`), "(\\p{L}+e\u0301)+$", { regex: true, maxResults: 5, contextLines: 0 })).rejects.toThrow(/nested quantifier/);
  });
});

describe("ingest of text with many marks (45, 47, 48)", () => {
  it("cleans a long line in pieces as it cleans it whole, marks, joiners and Hangul included", async () => {
    const slicer = new TimeSlicer();
    const atoms = ["a", "e", " ", "\n", "\u0301", "\u0316", "\u0308", "\u034f", "\u1100", "\u1161", "\u11a8", "\uac00", "\uac01", "\u200b", "\u00ad", "\u{1D167}", "\u0bc6", "\u0bbe", "\u05b0", "\u05bc", "\u0085", "\u00c4\u0085", "\u{1F600}", "\u0301".repeat(29), "\u0316\u0301".repeat(16), "\u200b\u0301"];
    let seed = 7;
    const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    for (let round = 0; round < 3_000; round++) {
      let text = "x";
      for (let count = Math.floor(random() * 30); count > 0; count--) text += atoms[Math.floor(random() * atoms.length)]!;
      const piece = 1 + Math.floor(random() * 12);
      expect(await normalizeInPieces(text, slicer, breaksAtNextLine(text), piece), JSON.stringify({ text, piece })).toBe(normalizeText(text));
    }
  });
});

describe("follow-ups of the check of the search fixes", () => {
  it("lets a plain exact search of a text full of curly quotes run to its end, with a whole count", async () => {
    const { foldCase } = await import("../src/text.js");
    const { grepSource, SearchableDocument } = await import("../src/search.js");
    expect(foldCase("Don’t “go” – ＡＢ \ud800 x")).toBe("don't \"go\" - ab \ud800 x");
    const line = "it’s “quoted” — and – dashed’s ".repeat(20);
    const text = Array.from({ length: 60_000 }, (_, index) => `${line}${index % 1_000 === 999 ? " needle" : ""}`).join("\n");
    const document = new SearchableDocument({ meta: { id: "doc_q", name: "q.txt", outline: [] } as never, text });
    const result = await grepSource(document, "needle", { maxResults: 5, contextLines: 0 });
    expect(result.stoppedEarly).toBe(false);
    expect(result.totalMatchingLines).toBe(60);
  }, 30_000);
});

describe("Hebrew prefixes before a quoted word, and short acronyms", () => {
  it("adds the word after a quote that follows prefix letters", async () => {
    const { queryTerms } = await import("../src/search.js");
    expect(queryTerms("ה\"ספק")).toEqual(["ה\"ספק", "ספק"]);
    expect(queryTerms("ב״הסכם")).toEqual(["ב\"הסכם", "הסכם"]);
    expect(queryTerms("מע״מ")).toEqual(["מע\"מ", "ע\"מ"]);
    expect(queryTerms("ש״ח")).toEqual(["ש\"ח"]);
  });
});

describe("composing twice", () => {
  it("changes nothing the second time, also for marks that NFC splits in two", async () => {
    const { composed } = await import("../src/text.js");
    for (const text of [`a${"̈́".repeat(40)}`, `ཀ${"ཱི".repeat(25)}${"́".repeat(10)}`, `e${"̖́".repeat(50)}`]) {
      const once = composed(text);
      expect(composed(once)).toBe(once);
    }
  });
});
