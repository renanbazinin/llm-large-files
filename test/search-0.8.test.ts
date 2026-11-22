import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, MemoryDocumentStore, stubResult, toolResultSummary, type DocumentMeta, type LargeFiles, type ToolResult } from "../src/index.js";
import { timeKey } from "../src/groups.js";
import { grep, queryTerms, rankPassages, SearchableDocument, unicodeWordPattern, unsafeRegexReason } from "../src/search.js";
import { composed, foldCase } from "../src/text.js";
import { toolCallKey } from "../src/tools.js";
import { utf8 } from "./fake-model.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const doc = (text: string) => new SearchableDocument({ meta: { id: "doc_t", name: "t.txt" } as never, text });
const linesOf = (result: ToolResult) => (result.matches as Array<{ line: number }>).map((match) => match.line);

/** The same file in memory, and read by range from a folder, with small pieces: the results must agree. */
async function bothWays(name: string, text: string): Promise<Array<{ files: LargeFiles; meta: DocumentMeta; how: string }>> {
  const memory = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
  directory = await mkdtemp(path.join(tmpdir(), "llf-search-08-"));
  const ranged = createLargeFiles({ store: new FileDocumentStore(directory), budget: { inlineTokens: 10 }, wholeDocumentBytes: 0, scanChunkBytes: 2_048 });
  return [
    { files: memory, meta: await memory.ingest({ name, bytes: utf8(text) }), how: "in memory" },
    { files: ranged, meta: await ranged.ingest({ name, bytes: utf8(text) }), how: "by range" },
  ];
}

describe("text and queries in one Unicode form", () => {
  it("composes decomposed text at ingest, so a composed query finds it (LLF-045)", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "menu.txt", bytes: utf8("Le café est ouvert\nUne crème brûlée\n") });
    const tools = files.tools([meta]);
    const exact = await tools.execute("search_document", { document_id: meta.id, query: "café", mode: "exact" });
    expect(exact.total_matching_lines).toBe(1);
    // A decomposed query finds the composed text too.
    const decomposed = await tools.execute("search_document", { document_id: meta.id, query: "crème", mode: "exact", case_sensitive: true });
    expect(decomposed.total_matching_lines).toBe(1);
    const regex = await tools.execute("search_document", { document_id: meta.id, query: "brûlée", mode: "regex" });
    expect(regex.total_matching_lines).toBe(1);
  });

  it("leaves ASCII as it is, and does not compose Hebrew points away", () => {
    expect(composed("plain ascii")).toBe("plain ascii");
    const pointed = "בְּרֵאשִׁית";
    expect(composed(pointed).replace(/[֑-ׇ]/g, "")).toBe("בראשית");
  });

  it("folds final sigma, curly quotes, dashes, odd spaces and Hebrew punctuation without changing the length", () => {
    for (const [text, folded] of [
      ["ΟΔΟΣ", "οδοσ"],
      ["don’t “quote”", "don't \"quote\""],
      ["10–20 — x−y", "10-20 - x-y"],
      ["a b c", "a b c"],
      ["צה״ל וג׳ורג׳ תל־אביב", "צה\"ל וג'ורג' תל-אביב"],
      ["ＡＢＣ１２３", "abc123"],
    ] as const) {
      expect(foldCase(text)).toBe(folded);
      expect(foldCase(text)).toHaveLength(text.length);
    }
  });

  it("finds an upper-case word that ends in Σ inside a longer word, as a case-sensitive search does", () => {
    const document = doc("ΟΔΟΣΤΡΩΜΑ\nάλλο\n");
    expect(grep(document, "ΟΔΟΣ", { maxResults: 5, contextLines: 0, caseSensitive: true }).totalMatchingLines).toBe(1);
    expect(grep(document, "ΟΔΟΣ", { maxResults: 5, contextLines: 0 }).totalMatchingLines).toBe(1);
  });

  it("finds a Hebrew acronym typed with ASCII quotes, and the other way round", () => {
    const document = doc("דו״ח שנתי של צה״ל\nדו\"ח רבעוני\n");
    expect(grep(document, "דו\"ח", { maxResults: 5, contextLines: 0 }).totalMatchingLines).toBe(2);
    expect(grep(document, "צה״ל", { maxResults: 5, contextLines: 0 }).totalMatchingLines).toBe(1);
  });
});

describe("keyword terms in every script (LLF-014, F21)", () => {
  it("keeps marks with their letters, so Hindi, Bengali, Tamil and pointed Hebrew keep their words", () => {
    expect(queryTerms("हिन्दी भाषा में त्रुटि")).toEqual(["हिन्दी", "भाषा", "में", "त्रुटि"]);
    expect(queryTerms("ডাটাবেস সংযোগ")).toEqual(["ডাটাবেস", "সংযোগ"]);
    expect(queryTerms("பிழை சேவையகம்")).toEqual(["பிழை", "சேவையகம்"]);
    expect(queryTerms("בְּרֵאשִׁית")).toEqual(["בראשית", "ראשית"]);
  });

  it("splits Chinese, Japanese and Thai into words", () => {
    const chinese = queryTerms("数据库连接超时错误");
    expect(chinese.length).toBeGreaterThan(1);
    expect(chinese.join("")).toBe("数据库连接超时错误");
    expect(queryTerms("ข้อผิดพลาดของเซิร์ฟเวอร์").length).toBeGreaterThan(1);
  });

  it("adds the stem of a Hebrew word without its prefix letters, and the plain form of a final letter", () => {
    expect(queryTerms("בחוזה")).toEqual(["בחוזה", "חוזה"]);
    expect(queryTerms("והחוזה")).toEqual(["והחוזה", "חוזה"]);
    // Three letters are always left.
    expect(queryTerms("מחיר")).toEqual(["מחיר", "חיר"]);
    expect(queryTerms("בית")).toEqual(["בית"]);
  });

  it("ranks passages with any prefixed form of a Hebrew word, and plural forms of a word with a final letter", () => {
    const filler = (count: number) => Array.from({ length: count }, (_, index) => `שורה ${index} בלי שום דבר מיוחד`).join("\n");
    const text = [filler(40), "התשלום לפי החוזה נקבע מראש", filler(40), "שהחוזה ייחתם עד סוף החודש", filler(40), "הכספים הועברו לחשבון", filler(40)].join("\n");
    const document = doc(text);
    const ranked = rankPassages(document, "בחוזה", 5);
    const lines = text.split("\n");
    const found = ranked.flatMap((passage) => lines.slice(passage.from - 1, passage.to)).join("\n");
    expect(found).toContain("לפי החוזה");
    expect(found).toContain("שהחוזה");
    const money = rankPassages(document, "כסף", 3).flatMap((passage) => lines.slice(passage.from - 1, passage.to)).join("\n");
    expect(money).toContain("הכספים");
  });

  it("does not let a term past the hit cap push passages from the start of the file first (LLF-015)", () => {
    // "error" on every line, past the 200,000 hits counted; "payment" only near the end.
    const lines = Array.from({ length: 205_000 }, (_, index) => (index >= 204_000 && index % 50 === 0 ? `error payment failed ${index}` : `error ${index}`));
    const ranked = rankPassages(doc(lines.join("\n")), "payment error", 3);
    expect(ranked.length).toBeGreaterThan(0);
    for (const passage of ranked) expect(passage.from).toBeGreaterThan(200_000);
  });
});

describe("regular expressions", () => {
  it("lets \\w and \\b know the letters of every script", async () => {
    const document = doc("החוזה נחתם\nחוזה חדש\nקשר חוזה-עבודה\nnaïve café\n");
    expect(grep(document, "\\bחוזה\\b", { regex: true, maxResults: 10, contextLines: 0 }).matches.map((match) => match.line)).toEqual([2, 3]);
    expect(grep(document, "caf\\w\\b", { regex: true, maxResults: 10, contextLines: 0 }).totalMatchingLines).toBe(1);
    expect(grep(document, "na\\w+ve", { regex: true, maxResults: 10, contextLines: 0 }).totalMatchingLines).toBe(1);
  });

  it("rewrites the word classes outside and inside a class, and leaves what it cannot rewrite", () => {
    expect(unicodeWordPattern("[\\w-]+")).toBe("[\\p{L}\\p{M}\\p{N}_-]+");
    expect(unicodeWordPattern("\\\\w")).toBe("\\\\w");
    expect(unicodeWordPattern("[^\\W]")).toBeUndefined();
    // A pattern only valid without the Unicode flag still works.
    const document = doc("a-b.c\n");
    expect(grep(document, "[\\w-.]+", { regex: true, maxResults: 5, contextLines: 0 }).totalMatchingLines).toBe(1);
  });

  it("accepts repeated groups that a literal separates, as in addresses and domains (LLF-043)", () => {
    for (const safe of [String.raw`(\d{1,3}\.){3}\d{1,3}`, String.raw`(\w+\.)+com`, String.raw`(\d+-)+\d+`, String.raw`([a-z]+:)+`]) {
      expect(unsafeRegexReason(safe), safe).toBeNull();
    }
    for (const unsafe of ["(a+)+b", String.raw`(\w+\s?)+$`, "(.+x)+y", "(a|aa+)+", String.raw`(\d+\d)+x`]) {
      expect(unsafeRegexReason(unsafe), unsafe).toMatch(/nested quantifier/);
    }
    const document = doc("from 10.0.0.1 to 192.168.1.20\nno address\nhost 8.8.8.8\n");
    expect(grep(document, String.raw`(\d{1,3}\.){3}\d{1,3}`, { regex: true, maxResults: 5, contextLines: 0 }).totalMatchingLines).toBe(2);
  });
});

describe("exact search", () => {
  it("counts every line where an occurrence of a needle across lines starts (LLF-042)", () => {
    expect(grep(doc("a\na\na\na\n"), "a\na", { maxResults: 10, contextLines: 0 }).matches.map((match) => match.line)).toEqual([1, 2, 3]);
    expect(grep(doc("}\n}\n}\n"), "}\n}", { maxResults: 10, contextLines: 0 }).totalMatchingLines).toBe(2);
  });

  it("counts a line with many occurrences once", () => {
    expect(grep(doc(`${"e".repeat(10_000)}\nx\ne\n`), "e", { maxResults: 10, contextLines: 0 }).matches.map((match) => match.line)).toEqual([1, 3]);
  });

  it("matches whole words only when asked, in any script", async () => {
    for (const { files, meta, how } of await bothWays("w.txt", "the cat sat\ncatalog item\nconcat()\nCAT-5 cable\nחתול\nהחתול\n")) {
      const tools = files.tools([meta]);
      const whole = await tools.execute("search_document", { document_id: meta.id, query: "cat", mode: "exact", whole_word: true });
      expect(linesOf(whole), how).toEqual([1, 4]);
      const hebrew = await tools.execute("search_document", { document_id: meta.id, query: "חתול", mode: "exact", whole_word: true });
      expect(linesOf(hebrew), how).toEqual([5]);
      // A needle that ends in punctuation needs no boundary there.
      const call = await tools.execute("search_document", { document_id: meta.id, query: "concat(", mode: "exact", whole_word: true });
      expect(linesOf(call), how).toEqual([3]);
    }
  });
});

const LOG = Array.from({ length: 600 }, (_, index) => {
  const minute = String(index % 60).padStart(2, "0");
  const hour = String(10 + Math.floor(index / 60)).padStart(2, "0");
  const level = index % 7 === 0 ? "ERROR" : "INFO";
  const code = index % 7 === 0 ? ` PAY-${5000 + (index % 3)}` : "";
  return `2026-11-10T${hour}:${minute}:00Z ${level}${code} request ${index} took ${index % 13}ms`;
}).join("\n");

describe("searching part of a file, and the last matches (M3)", () => {
  it("searches only from_line to to_line, in every mode, in memory and by range", async () => {
    for (const { files, meta, how } of await bothWays("app.log", LOG)) {
      const tools = files.tools([meta]);
      const all = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 50 });
      expect(all.total_matching_lines, how).toBe(86);
      const part = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", from_line: 100, to_line: 200, max_results: 50 });
      expect(part.searched_lines, how).toBe("100-200");
      expect(part.total_matching_lines, how).toBe(14);
      expect(linesOf(part).every((line) => line >= 100 && line <= 200), how).toBe(true);
      const regex = await tools.execute("search_document", { document_id: meta.id, query: "PAY-\\d+", mode: "regex", from_line: 590 });
      expect(linesOf(regex), how).toEqual([596]);
      const keywords = await tools.execute("search_document", { document_id: meta.id, query: "request took", from_line: 300, to_line: 320 });
      for (const passage of keywords.passages as Array<{ lines: string }>) {
        const [from, to] = passage.lines.split("-").map(Number);
        expect(to! >= 300 && from! <= 320, how).toBe(true);
      }
    }
  });

  it("pages through the matches with next_from_line", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(LOG) });
    const tools = files.tools([meta]);
    const seen: number[] = [];
    let from: number | undefined = 1;
    for (let page = 0; from !== undefined && page < 10; page++) {
      const result: ToolResult = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", max_results: 30, from_line: from });
      const lines = linesOf(result);
      // Each page shows the first 30 from its line, and the last match of the file.
      for (const line of lines.slice(0, typeof result.next_from_line === "number" ? -1 : undefined)) if (!seen.includes(line)) seen.push(line);
      from = typeof result.next_from_line === "number" ? result.next_from_line : undefined;
      if (from === undefined) for (const line of lines) if (!seen.includes(line)) seen.push(line);
    }
    expect(seen).toHaveLength(86);
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
  });

  it("refuses a range past the end or upside down", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(LOG) });
    const tools = files.tools([meta]);
    expect((await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", from_line: 601 })).error).toBe("from_line 601 is past the end of the file, which has 600 lines.");
    expect((await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", from_line: 50, to_line: 10 })).error).toBe("to_line 10 is before from_line 50.");
  });

  it("shows the last matches and the first with order \"last\", with the lines around them", async () => {
    for (const { files, meta, how } of await bothWays("app.log", LOG)) {
      const tools = files.tools([meta]);
      const result = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", order: "last", max_results: 3, context_lines: 1 });
      expect(linesOf(result), how).toEqual([1, 582, 589, 596]);
      expect(result.note, how).toBe("4 of the 86 matching lines are shown: the first (line 1) and the last 3. To see others, search with from_line and to_line, or count them with group_by.");
      const matches = result.matches as Array<{ line: number; before: string[]; after: string[] }>;
      expect(matches[3]!.before, how).toEqual([`595| ${LOG.split("\n")[594]}`]);
      expect(matches[0]!.after, how).toEqual([`2| ${LOG.split("\n")[1]}`]);
    }
  });
});

describe("counts by group (M2)", () => {
  it("counts matching lines per hour, in time order, in memory and by range", async () => {
    for (const { files, meta, how } of await bothWays("app.log", LOG)) {
      const tools = files.tools([meta]);
      const result = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", group_by: "hour" });
      expect(result.total_matching_lines, how).toBe(86);
      expect(result.total_groups, how).toBe(10);
      const groups = result.groups as Array<{ key: string; count: number; first_line: number; last_line: number }>;
      expect(groups.map((group) => group.key), how).toEqual(Array.from({ length: 10 }, (_, index) => `2026-11-10 ${10 + index}:00`));
      expect(groups.reduce((sum, group) => sum + group.count, 0), how).toBe(86);
      expect(groups[0], how).toEqual({ key: "2026-11-10 10:00", count: 9, first_line: 1, last_line: 57 });
      expect(result.matches, how).toBeUndefined();
      expect(toolResultSummary("", result), how).toBe(" — 86 matching lines in 10 groups");
    }
  });

  it("counts by the regex's first group, the largest first", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(LOG) });
    const tools = files.tools([meta]);
    const result = await tools.execute("search_document", { document_id: meta.id, query: "PAY-(\\d+)", mode: "regex", group_by: "capture" });
    const groups = result.groups as Array<{ key: string; count: number }>;
    expect(groups.map((group) => group.key).sort()).toEqual(["5000", "5001", "5002"]);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(86);
    expect(groups[0]!.count).toBeGreaterThanOrEqual(groups[1]!.count);
    // Without a regex there is no group to count by.
    const exact = await tools.execute("search_document", { document_id: meta.id, query: "PAY", mode: "exact", group_by: "capture" });
    expect(exact.error).toMatch(/group_by "capture" counts by the first group of a regex/);
    const keywords = await tools.execute("search_document", { document_id: meta.id, query: "PAY", group_by: "hour" });
    expect(keywords.error).toMatch(/use mode "exact" or "regex"/);
    const unknown = await tools.execute("search_document", { document_id: meta.id, query: "PAY", mode: "exact", group_by: "week" });
    expect(unknown.error).toBe('group_by must be one of "capture", "minute", "hour", "day", "shape".');
  });

  it("counts by message shape, and counts lines with no key apart", async () => {
    const text = ["2026-11-10 10:00:01 ERROR db timeout after 30s id=17", "2026-11-10 10:00:02 ERROR db timeout after 45s id=99", "ERROR disk full on /dev/sda1", "no time here ERROR", "Nov 11 09:15:00 host ERROR db timeout after 5s id=1"].join("\n");
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "mixed.log", bytes: utf8(text) });
    const tools = files.tools([meta]);
    const shape = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", group_by: "shape" });
    expect((shape.groups as Array<{ count: number }>)[0]!.count).toBe(2);
    const day = await tools.execute("search_document", { document_id: meta.id, query: "ERROR", mode: "exact", group_by: "day" });
    expect(day.groups).toEqual([{ key: "2026-11-10", count: 2, first_line: 1, last_line: 2 }, { key: "11-11", count: 1, first_line: 5, last_line: 5 }]);
    expect(day.lines_without_group).toBe(2);
  });

  it("reads the timestamps of common log formats", () => {
    expect(timeKey("2026-11-10T14:03:17.120Z INFO x", "minute")).toBe("2026-11-10 14:03");
    expect(timeKey("2026/11/10 14:03:17 [error] 12#0", "hour")).toBe("2026-11-10 14:00");
    expect(timeKey('10.0.0.1 - - [10/Nov/2026:14:03:17 +0000] "GET / HTTP/1.1"', "day")).toBe("2026-11-10");
    expect(timeKey('{"level":50,"time":1762783397000,"msg":"x"}', "hour")).toBe("2025-11-10 14:00");
    expect(timeKey("10.11.2026 14:03:17 ERROR", "day")).toBe("2026-11-10");
    expect(timeKey("10/11/2026 14:03 ERROR", "day")).toBe("10/11/2026");
    expect(timeKey("Nov 10 14:03:17 host sshd[1]: x", "hour")).toBe("11-10 14:00");
    expect(timeKey("E1110 14:03:17.123456   1 main.go:10] x", "minute")).toBe("11-10 14:03");
    expect(timeKey("no time at all", "hour")).toBeUndefined();
    // A version number or an address is not a date.
    expect(timeKey("v1.2026.11 10:00 build", "hour")).toBeUndefined();
  });

  it("keeps the counts when a result is dropped to make room", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 10 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(LOG) });
    const call = { id: "c1", name: "search_document", args: { document_id: meta.id, query: "request", mode: "exact", group_by: "minute" } };
    const result = await files.tools([meta]).execute(call.name, call.args);
    const stub = stubResult(call, result)!;
    expect(stub.dropped).toBe(true);
    expect(stub.group_by).toBe("minute");
    expect(stub.total_groups).toBe(result.total_groups);
    expect((stub.groups as unknown[]).length).toBe(30);
  });
});

describe("the key of a search call", () => {
  it("is the same as before for a call without the new arguments, and differs with them", () => {
    const plain = { document_id: "doc_1", query: "ERROR", mode: "exact" };
    expect(toolCallKey("search_document", plain)).toBe(JSON.stringify(["search_document", "doc_1", "ERROR", "exact", 20, 0, false]));
    const keys = new Set([
      toolCallKey("search_document", plain),
      toolCallKey("search_document", { ...plain, from_line: 100 }),
      toolCallKey("search_document", { ...plain, order: "last" }),
      toolCallKey("search_document", { ...plain, group_by: "hour" }),
      toolCallKey("search_document", { ...plain, whole_word: true }),
      toolCallKey("search_document", { ...plain, group_by: "hour", from_line: 5 }),
    ]);
    expect(keys.size).toBe(6);
    expect(toolCallKey("search_document", { document_id: "doc_1", query: "x" })).toBe(JSON.stringify(["search_document", "doc_1", "x", "keywords", 5]));
  });
});
