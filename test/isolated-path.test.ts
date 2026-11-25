// Isolated readers and files ingested from a path (0.9.0): the extractors of createIsolatedExtractors
// read paths (`readsPath`), so the job sent to a child carries the path and no bytes, the child
// reads the file itself within the upload limit, and the server reads none of it.
import "./load-pdf-libraries.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLargeFiles, MemoryDocumentStore } from "../src/index.js";
import { hebrewLease, numberedPdf } from "./pdf-fixtures.js";

/** Each opening of a file by the server (this process), as node:fs/promises makes it. */
const reads = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>) => {
    reads.opened.push(String(args[0]));
    return actual.open(...args);
  };
  return { ...actual, open, default: { ...actual, open } };
});

// The children run JavaScript: the sources are compiled once, into a folder under node_modules, so
// that the optional dependencies resolve from there as they do from dist (as isolated-ingest.test.ts does).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "node_modules", ".cache", `llf-isolated-path-${process.pid}`);
type NodeModule = typeof import("../src/node/index.js");
let node: NodeModule;
/** A child script that writes down each job it is sent, then runs the real child. */
let spyChild: string;
let jobsLog: string;

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", OUT, "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"], { cwd: ROOT });
  node = await import(pathToFileURL(path.join(OUT, "node", "index.js")).href) as NodeModule;
  jobsLog = path.join(OUT, "jobs.jsonl");
  spyChild = path.join(OUT, "node", "spy-child.js");
  await writeFile(spyChild, [
    'import { appendFileSync } from "node:fs";',
    "process.on(\"message\", (message) => {",
    `  if (message?.type === "extract") appendFileSync(${JSON.stringify(jobsLog)}, JSON.stringify({ path: message.path, bytes: message.bytes.byteLength, input: message.input }) + "\\n");`,
    "});",
    'await import("./ingest-child.js");',
  ].join("\n"));
}, 120_000);

afterAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "llf-isolated-path-"));
  reads.opened.length = 0;
  await rm(jobsLog, { force: true });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

type Job = { path?: string; bytes: number; input: Record<string, unknown> };
const jobs = async (): Promise<Job[]> => (await readFile(jobsLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Job);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("isolated readers and paths", () => {
  it("send the child the path, not the bytes; the child reads and hashes the file, and the server reads none of it", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1, childScript: spyChild });
    try {
      expect(isolated.extractors.pdf!.readsPath).toBe(true);
      const pdf = numberedPdf(3);
      const at = path.join(directory, "report.pdf");
      await writeFile(at, pdf);
      const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), extractors: isolated.extractors, maxUploadBytes: 5_000_000 });
      const meta = await files.ingest({ name: "report.pdf", source: { path: at } });
      expect(await jobs()).toEqual([{ path: at, bytes: 0, input: expect.objectContaining({ name: "report.pdf", format: "pdf", maxUploadBytes: 5_000_000 }) }]);
      expect(reads.opened).not.toContain(at);
      expect(meta).toMatchObject({ format: "pdf", pages: 3, bytes: pdf.byteLength, sha256: sha256(pdf) });
      // The text the server would have read.
      const local = await createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() }).ingest({ name: "report.pdf", bytes: pdf });
      expect({ ...meta, id: "", createdAt: "", expiresAt: "" }).toEqual({ ...local, id: "", createdAt: "", expiresAt: "" });
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it("carry a PDF's headings back from the child: the outline is the one the server makes (0.10.0)", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1 });
    try {
      const pdf = hebrewLease();
      const at = path.join(directory, "lease.pdf");
      await writeFile(at, pdf);
      const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), extractors: isolated.extractors });
      const fromPath = await files.ingest({ name: "lease.pdf", source: { path: at } });
      const fromBytes = await files.ingest({ name: "lease.pdf", bytes: pdf });
      const local = await createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore() }).ingest({ name: "lease.pdf", bytes: pdf });
      expect(local.outline).toHaveLength(8);
      expect(local.outline[0]).toEqual({ line: 3, level: 1, title: "חוזה שכירות בלתי מוגנת" });
      expect(fromPath.outline).toEqual(local.outline);
      expect(fromBytes.outline).toEqual(local.outline);
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it("read a relative path against the working directory of the call, not the one the child started in", async () => {
    const before = process.cwd();
    const first = path.join(directory, "a");
    const second = path.join(directory, "b");
    await mkdir(first);
    await mkdir(second);
    const one = numberedPdf(1);
    const two = numberedPdf(2);
    await writeFile(path.join(first, "r.pdf"), one);
    await writeFile(path.join(second, "r.pdf"), two);
    const isolated = node.createIsolatedExtractors({ concurrency: 1, childScript: spyChild });
    try {
      process.chdir(first);
      const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), extractors: isolated.extractors });
      // The child starts here, in folder A.
      expect(await files.ingest({ name: "r.pdf", source: { path: "r.pdf" } })).toMatchObject({ pages: 1, sha256: sha256(one) });
      process.chdir(second);
      expect(await files.ingest({ name: "r.pdf", source: { path: "r.pdf" } })).toMatchObject({ pages: 2, bytes: two.byteLength, sha256: sha256(two) });
      expect((await jobs()).map((job) => job.path)).toEqual([path.join(first, "r.pdf"), path.join(second, "r.pdf")]);
    } finally {
      process.chdir(before);
      await isolated.close();
    }
  }, 60_000);

  it("refuse in the child a file past the upload limit", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1 });
    try {
      const at = path.join(directory, "report.pdf");
      await writeFile(at, numberedPdf(3));
      const extract = isolated.extractors.pdf!;
      await expect(extract(new Uint8Array(0), { name: "report.pdf", mimeType: "application/pdf", format: "pdf", path: at, maxUploadBytes: 100 })).rejects.toThrow("report.pdf is larger than the 100 B upload limit.");
      await expect(extract(new Uint8Array(0), { name: "gone.pdf", mimeType: "application/pdf", format: "pdf", path: path.join(directory, "gone.pdf"), maxUploadBytes: 100 })).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it("get the bytes from the server when the store keeps a copy of the file (keepOriginals)", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1, childScript: spyChild });
    try {
      const pdf = numberedPdf(2);
      const at = path.join(directory, "report.pdf");
      await writeFile(at, pdf);
      const files = createLargeFiles({ requireOwner: false, store: new MemoryDocumentStore(), extractors: isolated.extractors, keepOriginals: ["pdf"] });
      const meta = await files.ingest({ name: "report.pdf", source: { path: at } });
      expect(await jobs()).toEqual([{ bytes: pdf.byteLength, input: expect.not.objectContaining({ maxUploadBytes: expect.anything() }) }]);
      expect(reads.opened.filter((file) => file === at)).toHaveLength(1);
      expect(await files.getOriginal(meta.id)).toEqual(pdf);
    } finally {
      await isolated.close();
    }
  }, 60_000);
});
