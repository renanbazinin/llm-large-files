import { execFile } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLargeFiles as createFromSource, IngestError as SourceIngestError, MemoryDocumentStore as SourceStore } from "../src/index.js";
import { createDocumentHandlers as handlersFromSource } from "../src/node/index.js";
import { utf8 } from "./fake-model.js";

// The children of createIsolatedExtractors run JavaScript: the sources are compiled once, into a
// folder under node_modules, so that the optional dependencies resolve from there as they do from dist.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "node_modules", ".cache", `llf-isolated-${process.pid}`);

type Library = typeof import("../src/index.js");
type NodeModule = typeof import("../src/node/index.js");
let library: Library;
let node: NodeModule;

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", OUT, "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"], { cwd: ROOT });
  library = await import(pathToFileURL(path.join(OUT, "index.js")).href) as Library;
  node = await import(pathToFileURL(path.join(OUT, "node", "index.js")).href) as NodeModule;
}, 120_000);

afterAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A workbook of `rows` rows of inline text, `width` characters a cell. */
async function workbook(rows: number, width = 20): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<workbook ${S}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  const cells: string[] = [];
  for (let row = 1; row <= rows; row++) cells.push(`<row r="${row}"><c r="A${row}"><v>${row}</v></c><c r="B${row}" t="inlineStr"><is><t>${`r${row}x`.padEnd(width, "y")}</t></is></c></row>`);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet ${S}><sheetData>${cells.join("")}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

describe("createIsolatedExtractors", () => {
  it("reads files in a child process, with the text the server would get", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1 });
    try {
      const bytes = await workbook(50);
      const inChild = createFromIsolated(isolated);
      const meta = await inChild.ingest({ name: "data.xlsx", bytes });
      const local = createFromSource({ store: new SourceStore() });
      const expected = await local.ingest({ name: "data.xlsx", bytes });
      expect(meta.lines).toBe(expected.lines);
      expect(meta.textBytes).toBe(expected.textBytes);
      expect(isolated.stats()).toEqual({ running: 0, queued: 0, children: 1 });
      // Text formats stay in the server.
      expect(Object.keys(isolated.extractors).sort()).toEqual(["docx", "pdf", "pptx", "xlsx"]);
    } finally {
      await isolated.close();
    }
    expect(isolated.stats().children).toBe(0);
  }, 60_000);

  it("refuses a file that needs more memory than a child has, and the server goes on", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1, maxHeapMb: 24 });
    try {
      const files = createFromIsolated(isolated);
      const error = await files.ingest({ name: "huge.xlsx", bytes: await workbook(120_000, 120) }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(library.IngestError);
      expect((error as InstanceType<Library["IngestError"]>).code).toBe("out_of_memory");
      expect((error as Error).message).toMatch(/^huge\.xlsx needed more memory than is allowed for reading one file \(24 MB\)/);
      // A new child reads the next file.
      const meta = await files.ingest({ name: "small.xlsx", bytes: await workbook(10) });
      expect(meta.lines).toBeGreaterThan(5);
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it("kills a child that takes too long", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1, timeoutMs: 30 });
    try {
      const files = createFromIsolated(isolated);
      const error = await files.ingest({ name: "slow.xlsx", bytes: await workbook(80_000) }).catch((caught: unknown) => caught);
      expect((error as InstanceType<Library["IngestError"]>).code).toBe("timeout");
      expect((error as Error).message).toMatch(/^slow\.xlsx took too long to read \(more than 0 seconds\)|^slow\.xlsx took too long to read/);
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it("refuses a file when every reader is busy and the queue is full, and lets a waiting file be cancelled", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1, maxQueue: 1 });
    try {
      const files = createFromIsolated(isolated);
      const big = await workbook(60_000);
      const first = files.ingest({ name: "first.xlsx", bytes: big });
      const cancel = new AbortController();
      const waiting = files.ingest({ name: "second.xlsx", bytes: big, signal: cancel.signal });
      const refused = await files.ingest({ name: "third.xlsx", bytes: big }).catch((caught: unknown) => caught);
      expect((refused as InstanceType<Library["IngestError"]>).code).toBe("busy");
      expect((refused as InstanceType<Library["IngestError"]>).retryAfterMs).toBe(5_000);
      expect((refused as InstanceType<Library["IngestError"]>).status).toBe(503);
      expect(isolated.stats()).toMatchObject({ running: 1, queued: 1 });
      const reason = new Error("The user left.");
      cancel.abort(reason);
      await expect(waiting).rejects.toBe(reason);
      expect(isolated.stats().queued).toBe(0);
      await expect(first).resolves.toMatchObject({ format: "xlsx" });
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it("stops the child of a file whose caller gives up, and replaces a child after its files", async () => {
    const isolated = node.createIsolatedExtractors({ concurrency: 1, maxFilesPerChild: 2 });
    try {
      const files = createFromIsolated(isolated);
      const cancel = new AbortController();
      const reading = files.ingest({ name: "big.xlsx", bytes: await workbook(60_000), signal: cancel.signal });
      setTimeout(() => cancel.abort(new Error("Gone.")), 50);
      await expect(reading).rejects.toThrow("Gone.");
      for (let index = 0; index < 3; index++) await files.ingest({ name: `s${index}.xlsx`, bytes: await workbook(5) });
      expect(isolated.stats().children).toBeLessThanOrEqual(1);
    } finally {
      await isolated.close();
    }
  }, 60_000);

  it("checks its options", () => {
    expect(() => node.createIsolatedExtractors({ maxHeapMb: Number.NaN })).toThrow(RangeError);
    expect(() => node.createIsolatedExtractors({ concurrency: 0 })).toThrow("concurrency must be a number above 0, and is 0.");
    expect(() => node.createIsolatedExtractors({ maxQueue: -1 })).toThrow(RangeError);
  });
});

/** The library of the compiled build, with the isolated extractors. */
function createFromIsolated(isolated: ReturnType<NodeModule["createIsolatedExtractors"]>) {
  return library.createLargeFiles({ store: new library.MemoryDocumentStore(), extractors: isolated.extractors });
}

describe("the upload handler and a busy reader", () => {
  let server: Server | undefined;
  afterAll(() => server?.close());

  it("answers 503 with Retry-After, and the refusal's code in the events", async () => {
    const files = createFromSource({ store: new SourceStore(), extractors: { docx: async () => { throw new SourceIngestError("busy", "The server is reading other files right now. Try again in a moment.", { retryAfterMs: 2_500 }); } } });
    const handlers = handlersFromSource(files);
    server = createServer((request, response) => void handlers.upload(request, response));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const post = (headers: Record<string, string>) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/upload", headers: { "x-file-name": "a.docx", ...headers } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
      request.on("error", reject);
      request.end(Buffer.from(utf8("PK fake")));
    });
    const json = await post({});
    expect(json.status).toBe(503);
    expect(json.headers["retry-after"]).toBe("3");
    expect(JSON.parse(json.body)).toEqual({ error: "The server is reading other files right now. Try again in a moment." });
    const events = await post({ accept: "text/event-stream" });
    expect(events.body).toContain('"code":"busy"');
  });
});
