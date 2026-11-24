// LO-2, the write half (0.10.0): FileDocumentStore writes a text over 1 Mi UTF-16 units to its
// temporary file a slice at a time, each cut before a high surrogate, then renames it as before.
// The bytes are those of the whole text encoded at once. The event-loop gap is measured in
// test/timing/store.timing.test.ts (a 97.5 MB text held the thread for 1,016 ms).
import fsp, { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLargeFiles, FileDocumentStore, type DocumentMeta } from "llm-large-files";
import { utf8 } from "llm-large-files/testing";
import { WRITE_SLICE_CHARACTERS } from "../src/stores.js";

const directories: string[] = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "llf-sliced-"));
  directories.push(directory);
  return directory;
}

/** Notes the size of every write through a handle the store opens on a temporary text file. */
function countWrites(): number[] {
  const sizes: number[] = [];
  const table = fsp as unknown as { open: (...args: unknown[]) => Promise<{ write: (...rest: unknown[]) => Promise<{ bytesWritten: number }> }> };
  const real = table.open;
  table.open = async function (this: unknown, ...args: unknown[]) {
    const handle = await real.apply(this, args);
    if (/\.txt\.[a-f0-9]{8}\.tmp$/.test(String(args[0]))) {
      const write = handle.write.bind(handle);
      handle.write = async (...rest: unknown[]) => {
        const done = await write(...rest);
        sizes.push(done.bytesWritten);
        return done;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  restores.push(() => {
    table.open = real;
    syncBuiltinESMExports();
  });
  return sizes;
}

function metaFor(id: string, text: string): DocumentMeta {
  const bytes = Buffer.byteLength(text);
  return {
    id, metaVersion: 1, name: `${id}.txt`, mimeType: "text/plain", format: "text", bytes, textBytes: bytes, characters: text.length,
    lines: text.split("\n").length, estimatedTokens: 1, wrappedLines: 0, outline: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe("FileDocumentStore writing a large text", () => {
  it("writes it in slices, and its bytes are those of the whole text: a high surrogate at a slice's end is not cut", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    // An emoji (two UTF-16 units) across the end of the first slice and of the third, Hebrew, and ASCII.
    const first = "a".repeat(WRITE_SLICE_CHARACTERS - 1) + "😀";
    const hebrew = "שלום עולם, זה טקסט ארוך בעברית.\n".repeat(Math.ceil(WRITE_SLICE_CHARACTERS / 32));
    const third = "b".repeat(WRITE_SLICE_CHARACTERS * 3 - first.length - hebrew.length - 1) + "🎉";
    const text = `${first}${hebrew}${third}tail\n`;
    expect(text.charCodeAt(WRITE_SLICE_CHARACTERS - 1)).toBe(0xd83d);
    const sizes = countWrites();
    await store.put({ meta: metaFor("big", text), text });
    const written = await readFile(path.join(directory, "big.txt"));
    expect(written.equals(Buffer.from(text, "utf8"))).toBe(true);
    // At least four slices, none more than a slice's characters can take in UTF-8.
    expect(sizes.length).toBeGreaterThanOrEqual(4);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(WRITE_SLICE_CHARACTERS * 3);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(written.byteLength);
    // No temporary file is left, and the store reads the text back whole.
    expect((await readdir(directory)).sort()).toEqual(["big.json", "big.txt"]);
    expect((await store.get("big"))?.text).toBe(text);
  });

  it("writes a text of one slice or less at once, as before", async () => {
    const directory = await folder();
    const store = new FileDocumentStore(directory);
    const sizes = countWrites();
    const text = "x".repeat(WRITE_SLICE_CHARACTERS);
    await store.put({ meta: metaFor("small", text), text });
    expect(sizes).toEqual([]);
    expect((await readFile(path.join(directory, "small.txt"), "utf8"))).toBe(text);
  });

  it("is read by range, through an ingest, as it was written", async () => {
    const directory = await folder();
    const files = createLargeFiles({ store: new FileDocumentStore(directory), wholeDocumentBytes: 0 });
    const lines = Array.from({ length: 60_000 }, (_, i) => `${i + 1}: שורה ${i + 1} 😀 ${"z".repeat(i % 40)}`);
    const meta = await files.ingest({ name: "long.txt", bytes: utf8(lines.join("\n")) });
    expect(meta.characters).toBeGreaterThan(WRITE_SLICE_CHARACTERS);
    const tools = files.tools([meta]);
    expect(await tools.execute("read_document", { document_id: meta.id, start_line: 59_999, end_line: 60_000 })).toMatchObject({ text: expect.stringContaining("שורה 60000 😀") });
  });
});
