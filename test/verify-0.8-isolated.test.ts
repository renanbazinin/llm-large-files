import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLargeFiles, IngestError, ingestErrorCodeOf, MemoryDocumentStore } from "../src/index.js";
import { toIngestError } from "../src/errors.js";
import { checkUnpdf, detectFormat } from "../src/extract.js";
import { utf8 } from "./fake-model.js";

// The children of createIsolatedExtractors run JavaScript: the sources are compiled once, into a
// folder under node_modules, so that the optional dependencies resolve from there as they do from dist.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "node_modules", ".cache", `llf-verify-isolated-${process.pid}`);

type Library = typeof import("../src/index.js");
type NodeModule = typeof import("../src/node/index.js");
let library: Library;
let node: NodeModule;

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", OUT, "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"], { cwd: ROOT });
  await mkdir(path.join(OUT, "scripts"), { recursive: true });
  library = await import(pathToFileURL(path.join(OUT, "index.js")).href) as Library;
  node = await import(pathToFileURL(path.join(OUT, "node", "index.js")).href) as NodeModule;
}, 120_000);

afterAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

/**
 * Runs ES module code in a plain Node process, which, unlike the test runner, exits as soon as
 * nothing holds its event loop. The code imports the compiled build as "../node/index.js".
 * `onOutput` sees its standard output as it comes, with the process. It is killed after 10 s.
 */
async function runScript(name: string, code: string, onOutput?: (stdout: string, child: ChildProcess) => void): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const file = path.join(OUT, "scripts", name);
  await writeFile(file, code);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: path.dirname(file), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      onOutput?.(stdout, child);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ code: exitCode, signal, stdout, stderr });
    });
  });
}

/** The library of the compiled build, with the isolated extractors. */
function createFromIsolated(isolated: ReturnType<NodeModule["createIsolatedExtractors"]>) {
  return library.createLargeFiles({ store: new library.MemoryDocumentStore(), extractors: isolated.extractors });
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A small workbook with one sheet of `rows` rows. */
async function workbook(rows: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<workbook ${S}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  const cells: string[] = [];
  for (let row = 1; row <= rows; row++) cells.push(`<row r="${row}"><c r="A${row}"><v>${row}</v></c><c r="B${row}" t="inlineStr"><is><t>row ${row}</t></is></c></row>`);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet ${S}><sheetData>${cells.join("")}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const TEXT_INPUT = { name: "a.txt", mimeType: "text/plain", format: "text" as const };

describe("close() (findings 31, 38, 56, 57)", () => {
  // Under the test runner something always holds the event loop, so these run in a plain process.
  for (const idleMs of [30_000, 0]) {
    it(`resolves after a file was read, when nothing else holds the process (idleMs ${idleMs})`, async () => {
      const result = await runScript(`close-${idleMs}.mjs`, `
        import { createIsolatedExtractors } from "../node/index.js";
        const isolated = createIsolatedExtractors({ formats: ["text"], idleMs: ${idleMs} });
        const read = await isolated.extractors.text(new TextEncoder().encode("hello\\nworld"), ${JSON.stringify(TEXT_INPUT)});
        console.log("read", JSON.stringify(read.text), JSON.stringify(isolated.stats()));
        await isolated.close();
        console.log("after close", JSON.stringify(isolated.stats()));
        // Files sent after close() start new children.
        await isolated.extractors.text(new TextEncoder().encode("again"), ${JSON.stringify(TEXT_INPUT)});
        await isolated.close();
        console.log("closed twice");
      `);
      expect(result.stderr).not.toMatch(/unsettled top-level await/);
      expect(result.stdout).toContain('read "hello\\nworld" {"running":0,"queued":0,"children":1}');
      expect(result.stdout).toContain('after close {"running":0,"queued":0,"children":0}');
      expect(result.stdout).toContain("closed twice");
      expect(result.code).toBe(0);
    }, 15_000);
  }

  it("waits for a child that was replaced after its files, and resolves", async () => {
    const result = await runScript("close-replaced.mjs", `
      import { createIsolatedExtractors } from "../node/index.js";
      const isolated = createIsolatedExtractors({ formats: ["text"], maxFilesPerChild: 1 });
      await isolated.extractors.text(new TextEncoder().encode("one"), ${JSON.stringify(TEXT_INPUT)});
      await isolated.close();
      console.log("after close");
    `);
    expect(result.stdout).toContain("after close");
    expect(result.code).toBe(0);
  }, 15_000);

  it("resolves when called in the same tick as a file whose reader could not start, and signals no process", async () => {
    // A failed spawn has no pid: kill() is stubbed for it here, so a regression cannot signal another process.
    const result = await runScript("close-same-tick.mjs", `
      import { ChildProcess } from "node:child_process";
      import { createIsolatedExtractors } from "../node/index.js";
      const kill = ChildProcess.prototype.kill;
      ChildProcess.prototype.kill = function (signal) {
        if (this.pid === undefined) {
          console.log("kill without a pid");
          return false;
        }
        return kill.call(this, signal);
      };
      process.execPath = ${JSON.stringify(path.join(OUT, "no-such-node"))};
      const isolated = createIsolatedExtractors({ concurrency: 1 });
      const job = isolated.extractors.docx(new Uint8Array([1]), { name: "a.docx", mimeType: "x", format: "docx" }).then(() => "read", (error) => error.code + ": " + error.message);
      await isolated.close();
      console.log("closed", JSON.stringify(isolated.stats()));
      console.log("job", await job);
    `);
    expect(result.stdout).not.toContain("kill without a pid");
    expect(result.stdout).toContain('closed {"running":0,"queued":0,"children":0}');
    expect(result.stdout).toContain("job busy: The server is shutting down. Try again in a moment.");
    expect(result.code).toBe(0);
  }, 15_000);

  it("leaves no child behind when the process ends after close()", async () => {
    const result = await runScript("close-pids.mjs", `
      import { createIsolatedExtractors } from "../node/index.js";
      import { ChildProcess } from "node:child_process";
      const pids = [];
      const kill = ChildProcess.prototype.kill;
      ChildProcess.prototype.kill = function (signal) {
        pids.push(this.pid);
        return kill.call(this, signal);
      };
      const isolated = createIsolatedExtractors({ formats: ["text"], concurrency: 2 });
      await Promise.all([1, 2].map((n) => isolated.extractors.text(new TextEncoder().encode("file " + n), ${JSON.stringify(TEXT_INPUT)})));
      await isolated.close();
      const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      console.log("killed", pids.length, "alive", alive.length);
    `);
    expect(result.stdout).toContain("killed 2 alive 0");
    expect(result.code).toBe(0);
  }, 15_000);
});

describe("idleMs 0 (findings 34, 41)", () => {
  it("keeps the children until close(), but an idle child does not keep the process alive", async () => {
    const started = Date.now();
    const result = await runScript("idle-0.mjs", `
      import { createIsolatedExtractors } from "../node/index.js";
      const isolated = createIsolatedExtractors({ formats: ["text"], idleMs: 0 });
      await isolated.extractors.text(new TextEncoder().encode("hello"), ${JSON.stringify(TEXT_INPUT)});
      setTimeout(() => console.log("stats", JSON.stringify(isolated.stats())), 300);
    `);
    expect(result.stdout).toContain('stats {"running":0,"queued":0,"children":1}');
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);
});

describe("times past what a timer can wait (findings 32, 39)", () => {
  for (const timeoutMs of [Number.POSITIVE_INFINITY, 3_000_000_000, 2 ** 31]) {
    it(`reads a file with timeoutMs ${timeoutMs}: no kill timer, as with ingestTimeoutMs`, async () => {
      const isolated = node.createIsolatedExtractors({ timeoutMs, formats: ["text"] });
      try {
        const read = await isolated.extractors.text!(utf8("hello\nworld"), TEXT_INPUT);
        expect(read.text).toBe("hello\nworld");
      } finally {
        await isolated.close();
      }
    }, 15_000);
  }

  it("keeps an idle child with idleMs Infinity, as with 0", async () => {
    const isolated = node.createIsolatedExtractors({ idleMs: Number.POSITIVE_INFINITY, formats: ["text"] });
    try {
      await isolated.extractors.text!(utf8("hello"), TEXT_INPUT);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isolated.stats().children).toBe(1);
    } finally {
      await isolated.close();
    }
  }, 15_000);

  it("still kills a child at the largest timer there is", async () => {
    // 2,147,483,647 is a real timer; one more is none.
    const isolated = node.createIsolatedExtractors({ timeoutMs: 2 ** 31 - 1, idleMs: 2 ** 31 - 1, formats: ["text"] });
    try {
      expect((await isolated.extractors.text!(utf8("x"), TEXT_INPUT)).text).toBe("x");
    } finally {
      await isolated.close();
    }
  }, 15_000);
});

describe("maxHeapMb (findings 36, 39)", () => {
  it("refuses a heap that would be Node's default or that Node cannot read", () => {
    for (const maxHeapMb of [0.5, 0.999, Number.POSITIVE_INFINITY, 2 ** 64, 1e21, Number.MAX_SAFE_INTEGER, 1_048_577]) {
      expect(() => node.createIsolatedExtractors({ maxHeapMb })).toThrow(`maxHeapMb must be a number from 1 to 1,048,576 (1 TB), and is ${String(maxHeapMb)}.`);
    }
    expect(() => node.createIsolatedExtractors({ maxHeapMb: 1_048_576 })).not.toThrow();
    // The messages of 0.8.0 stay as they are.
    expect(() => node.createIsolatedExtractors({ maxHeapMb: Number.NaN })).toThrow("maxHeapMb must be a number above 0, and is NaN.");
    expect(() => node.createIsolatedExtractors({ maxHeapMb: 0 })).toThrow("maxHeapMb must be a number above 0, and is 0.");
    expect(() => node.createIsolatedExtractors({ maxHeapMb: 1.5 })).not.toThrow();
  });
});

describe("childScript and a reader that does not start (finding 43)", () => {
  it("takes a file URL as a string, as import.meta.resolve gives it", async () => {
    const isolated = node.createIsolatedExtractors({ formats: ["text"], childScript: pathToFileURL(path.join(OUT, "node", "ingest-child.js")).href });
    try {
      expect((await isolated.extractors.text!(utf8("from a file URL"), TEXT_INPUT)).text).toBe("from a file URL");
    } finally {
      await isolated.close();
    }
  }, 15_000);

  const failing: Array<[string, { childScript?: string; execArgv?: string[] }]> = [
    ["a script that is not there", { childScript: path.join(OUT, "node", "no-such-child.js") }],
    ["a Node option Node does not know", { execArgv: ["--no-such-option-for-llf"] }],
  ];
  for (const [label, options] of failing) {
    it(`tells ${label} as the server's error, not as a damaged file, with the child's standard error as cause`, async () => {
      const isolated = node.createIsolatedExtractors({ concurrency: 1, ...options });
      try {
        const files = createFromIsolated(isolated);
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = await files.ingest({ name: "a.xlsx", bytes: await workbook(3) }).catch((caught: unknown) => caught);
          expect(error).not.toBeInstanceOf(library.IngestError);
          expect((error as Error).message).toMatch(/^The server could not start a reader for a\.xlsx \(exit code \d+\)\.$/);
          expect((error as { status?: number }).status).toBe(500);
          expect(String(((error as Error).cause as Error).message)).toMatch(label.includes("script") ? /Cannot find module/ : /no-such-option-for-llf/);
        }
        expect(isolated.stats()).toEqual({ running: 0, queued: 0, children: 0 });
      } finally {
        await isolated.close();
      }
    }, 20_000);
  }

  it("answers the upload of such a file with 500, without the child's standard error", async () => {
    const isolated = node.createIsolatedExtractors({ childScript: path.join(OUT, "node", "no-such-child.js") });
    const handlers = node.createDocumentHandlers(createFromIsolated(isolated));
    const { createServer, request } = await import("node:http");
    const server = createServer((req, res) => void handlers.upload(req, res));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      const bytes = await workbook(3);
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const post = request({ host: "127.0.0.1", port, method: "POST", path: "/upload", headers: { "x-file-name": "a.xlsx" } }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        });
        post.on("error", reject);
        post.end(Buffer.from(bytes));
      });
      expect(answer.status).toBe(500);
      expect(JSON.parse(answer.body)).toEqual({ error: "The server could not start a reader for a.xlsx (exit code 1)." });
    } finally {
      server.close();
      await isolated.close();
    }
  }, 20_000);

  it("exports the child script, for a bundle that has to point at it", async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    expect(pkg.exports["./node/ingest-child.js"]).toBe("./dist/node/ingest-child.js");
  });
});

describe("ingestErrorCodeOf (findings 29, 42)", () => {
  it("gives missing_dependency for an unpdf that cannot run on this Node", async () => {
    const refusal = (unpdf: Parameters<typeof checkUnpdf>[0], version: string) => checkUnpdf(unpdf, version).then(() => new Error("not refused"), (error: unknown) => error as Error);
    const cannotLoad = await refusal({ getResolvedPDFJS: async () => { throw new TypeError("Promise.withResolvers is not a function"); } }, "20.19.0");
    expect(cannotLoad.message).toMatch(/^The unpdf installed cannot read PDF files on Node 20/);
    // Node 22 has no Promise.try (Node 24 does): taken away here, to be sure of the other message.
    const promise = Promise as unknown as { try?: unknown };
    const saved = Object.getOwnPropertyDescriptor(Promise, "try");
    delete promise.try;
    let wouldStop: Error;
    try {
      wouldStop = await refusal({ getResolvedPDFJS: async () => ({}) }, "22.12.0");
    } finally {
      if (saved) Object.defineProperty(Promise, "try", saved);
    }
    expect(wouldStop.message).toMatch(/^The unpdf installed would stop the whole server at the first PDF file on Node 22/);
    for (const error of [cannotLoad, wouldStop]) {
      expect(ingestErrorCodeOf(error.message)).toBe("missing_dependency");
      expect((toIngestError(error) as IngestError).code).toBe("missing_dependency");
    }
    // The reason in the message does not change the code.
    expect(ingestErrorCodeOf("The unpdf installed cannot read PDF files on Node 20 (x is empty.). Install unpdf 1.7.0 (npm install unpdf@1.7.0), or run Node 22 or later.")).toBe("missing_dependency");
  });

  it("gives busy for the refusals of a busy or stopping reader, whatever the file is called", () => {
    for (const message of [
      "The server is reading other files right now. Try again in a moment.",
      "The server is shutting down. Try again in a moment.",
      "r.pdf could not be read now: a reader could not be started (EAGAIN). Try again in a moment.",
      "r.pdf could not be read now: a reader could not be started. Try again in a moment.",
      "a is larger than the 3 B upload limit and took too long to read.pdf could not be read now: a reader could not be started (EMFILE). Try again in a moment.",
    ]) expect(ingestErrorCodeOf(message)).toBe("busy");
    // The others keep theirs.
    expect(ingestErrorCodeOf("r.pdf could not be read: its reader stopped (exit code 9).")).toBe("unreadable");
    expect(ingestErrorCodeOf("r.pdf took too long to read (more than 2 minutes). Split it, or save it as plain text, and attach that.")).toBe("timeout");
    expect(ingestErrorCodeOf("Try again in a moment.")).toBe("unreadable");
  });
});

describe("detectFormat and names of Object.prototype (finding 44)", () => {
  const names = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupSetter__"];

  it("gives text for an extension or a MIME type that is a member of every object", () => {
    for (const name of names) {
      expect(detectFormat(`notes.${name}`, "application/octet-stream")).toBe("text");
      expect(detectFormat(`notes.${name.toUpperCase()}`, "application/octet-stream")).toBe("text");
      expect(detectFormat("notes", name)).toBe("text");
      expect(detectFormat(`notes.${name}`, name)).toBe("text");
    }
    expect(detectFormat("a.constructor", "application/pdf")).toBe("pdf");
    expect(detectFormat("a.PDF", "x")).toBe("pdf");
  });

  it("ingests such a file as text", async () => {
    const files = createLargeFiles({ store: new MemoryDocumentStore() });
    for (const name of names) {
      const meta = await files.ingest({ name: `notes.${name}`, bytes: utf8("one\ntwo\n"), mimeType: name });
      expect(meta.format).toBe("text");
      expect(meta.lines).toBe(2);
    }
  });
});

describe("the shutdown of the docs (findings 30, 40)", () => {
  it("shows no SIGTERM listener that only closes the readers", async () => {
    // A SIGTERM listener replaces Node's own exit: one that only kills the children leaves the server serving.
    const bare = /process\.on(?:ce)?\("SIGTERM",\s*\(\)\s*=>\s*(?:void\s+)?isolated\.close\(\)\s*\)/;
    for (const file of ["CHANGELOG.md", "docs/reference/node.md", "docs/guides/deployment.md", "src/node/isolated.ts", "README.md"]) {
      expect(await readFile(path.join(ROOT, file), "utf8"), file).not.toMatch(bare);
    }
  });

  it("exits on SIGTERM with the recipe of the node reference, after a file was read", async () => {
    let sent = false;
    const result = await runScript("sigterm.mjs", `
      import { createServer } from "node:http";
      import { createLargeFiles, MemoryDocumentStore } from "../index.js";
      import { createDocumentHandlers, createIsolatedExtractors } from "../node/index.js";
      const isolated = createIsolatedExtractors({ formats: ["text"] });
      const files = createLargeFiles({ store: new MemoryDocumentStore(), extractors: isolated.extractors });
      const documents = createDocumentHandlers(files);
      const server = createServer((request, response) => void documents.upload(request, response)).listen(0, "127.0.0.1");
      process.once("SIGTERM", () => {
        server.close();
        void isolated.close();
      });
      await files.ingest({ name: "a.txt", bytes: new TextEncoder().encode("hello") });
      console.log("ready", JSON.stringify(isolated.stats()));
    `, (stdout, child) => {
      // Stopped as a platform would, once the file is read.
      if (!sent && stdout.includes("ready")) {
        sent = true;
        child.kill("SIGTERM");
      }
    });
    expect(result.stdout).toContain('ready {"running":0,"queued":0,"children":1}');
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  }, 15_000);
});
