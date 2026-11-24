// FileDocumentStore writing a large text without holding the event loop (LO-2, the write half,
// 0.10.0): a slice of at most 1 Mi UTF-16 units is encoded at a time. Before, the whole text was
// encoded at once: a text of 97.5 MB held the thread for 1,016 ms (probe p5), so every answer
// streaming to another user stopped meanwhile.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileDocumentStore, type DocumentMeta } from "../../src/index.js";
import { measured } from "./clock.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("FileDocumentStore.put of a large text", () => {
  it("writes 50 MB with no event-loop gap of 50 ms or more, byte for byte as Buffer.from writes it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llf-store-timing-"));
    directories.push(directory);
    // A service log with Hebrew in it, 50 MB in UTF-8, joined at once (a flat string, as an ingest
    // leaves its text once it has read it through).
    const line = (i: number) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} took ${i % 900}ms שלום עולם`;
    const lines: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes < 50_000_000; i++) {
      const next = line(i);
      lines.push(next);
      bytes += Buffer.byteLength(next) + 1;
    }
    const text = lines.join("\n");
    lines.length = 0;
    text.charCodeAt(text.length - 1);
    const meta: DocumentMeta = {
      id: "big", metaVersion: 1, name: "big.log", mimeType: "text/plain", format: "log", bytes, textBytes: bytes, characters: text.length,
      lines: 1, estimatedTokens: 1, wrappedLines: 0, outline: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const store = new FileDocumentStore(directory);
    const { gap } = await measured(() => store.put({ meta, text }));
    expect(gap).toBeLessThan(50);
    const written = await readFile(path.join(directory, "big.txt"));
    expect(written.byteLength).toBeGreaterThanOrEqual(50_000_000);
    expect(written.equals(Buffer.from(text, "utf8"))).toBe(true);
  });
});
