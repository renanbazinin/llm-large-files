// The performance budgets of llm-large-files (0.99.9): `npm run perf` builds the package, then runs
// this file. CI runs it in the job "perf" of .github/workflows/ci.yml, on Ubuntu with Node 22.
//
// It measures four kinds of work, with the library's defaults, and holds 11 numbers to bars taken
// from the records of docs/measurements.md ("Performance budgets (0.99.9)" says how they were
// chosen):
// - uploads: 100 logs of 2 MB, read into memory as an upload handler holds a body, all sent to
//   files.ingest at once, over a FileDocumentStore;
// - ingest: a log of 100 MB sent to files.ingest, over a FileDocumentStore;
// - search: in a new process, one exact search of the stored log, read by range;
// - searches: in a new process, eight exact searches of it at once.
// Each run of a measure is a fresh Node process (--expose-gc --max-old-space-size=2048), one at a
// time, over the package as built in dist/: "llm-large-files" resolves to it through the package's
// own name. The inputs are made once, in a process of their own, and checked by their size and
// SHA-256. A measure with a value over its bar runs again, up to --runs runs in all (3), and each
// budget counts its best run. Memory is read from /proc, so it is measured on Linux only. Every call
// names an owner ("perf"), so the runs measure the default path with owner checks on or off.
//
//   node scripts/perf.ts [--runs N] [--summary FILE] [--results FILE]
//
// --runs N: the most runs of one measure, 1 to 10 (3). --summary FILE: append the report, in
// Markdown, to FILE ($GITHUB_STEP_SUMMARY in CI). --results FILE: write every run's numbers as JSON.
// Exit 0 when every budget measured is within its bar, 1 when one is over or a measure failed, 2 for
// a usage error. It needs Node 22.18 or later, or 23.6 or later, which run TypeScript as it is (type
// stripping); on Node 22.12 to 22.17, run `node --experimental-strip-types scripts/perf.ts`, and the
// flag is passed on to the children.
//
// The children (internal): `node scripts/perf.ts --child <generate|uploads|ingest|search|searches>
// <dir>` works in the folder <dir> that the parent made, and prints its numbers as the last line of
// its output that starts with "PERF ", followed by JSON. Its error goes to stderr, and it exits 1.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLargeFiles, FileDocumentStore } from "llm-large-files";
import { serviceLog } from "llm-large-files/testing";

/** A measure: each run of it is a fresh process of its own. New in 0.99.9. */
export type MeasureName = "uploads" | "ingest" | "search" | "searches";

/** One bar CI holds the library to. New in 0.99.9. */
export type Budget = {
  /** `${measure}.${field}`. */
  id: string;
  measure: MeasureName;
  /** The field of the measure's result that is checked. */
  field: string;
  unit: "s" | "ms" | "MB";
  /** The most the best run may measure (≤ passes). */
  bar: number;
  /** Read from /proc: measured on Linux only. */
  linuxOnly: boolean;
  /** What is measured, for the report. */
  what: string;
  /** The record of docs/measurements.md the bar comes from, for the report. */
  record: string;
};

/**
 * What one run of a measure gives: numbers by field (null: a memory field off Linux), and `totals`
 * for the searches. New in 0.99.9.
 */
export type MeasureResult = Record<string, number | null | number[]>;

/** A budget, checked against the runs of its measure. New in 0.99.9. */
export type Verdict = {
  budget: Budget;
  /** The lowest value of the runs of its measure; undefined when not measured. */
  value: number | undefined;
  /** How many runs its measure had. */
  runs: number;
  /** undefined when not measured (a linuxOnly budget off Linux, or no run). */
  passed: boolean | undefined;
};

/**
 * The 11 bars, in the order of the report and of the table in docs/measurements.md ("Performance
 * budgets (0.99.9)"), which says how each was chosen. Change one only with a new record there.
 * New in 0.99.9.
 */
export const BUDGETS: readonly Budget[] = [
  { id: "uploads.allSeconds", measure: "uploads", field: "allSeconds", unit: "s", bar: 105, linuxOnly: false, what: "100 uploads at once: until the last is stored", record: "27.6 to 33.4 s (0.8.2)" },
  { id: "uploads.firstSeconds", measure: "uploads", field: "firstSeconds", unit: "s", bar: 3, linuxOnly: false, what: "100 uploads at once: until the first is stored", record: "0.5 to 0.7 s (0.8.2)" },
  { id: "uploads.peakMB", measure: "uploads", field: "peakMB", unit: "MB", bar: 200, linuxOnly: true, what: "100 uploads at once: memory above the uploads", record: "329 to 356 MB in all, about 95 MB above the uploads and the process (0.8.2)" },
  { id: "uploads.heapAfterMB", measure: "uploads", field: "heapAfterMB", unit: "MB", bar: 20, linuxOnly: false, what: "100 uploads at once: heap in use after", record: "back at about 10 MB (0.8.2)" },
  { id: "ingest.seconds", measure: "ingest", field: "seconds", unit: "s", bar: 50, linuxOnly: false, what: "a 100 MB log: ingest", record: "11.6 to 14.9 s for 95 MB (0.9.0)" },
  { id: "ingest.peakMB", measure: "ingest", field: "peakMB", unit: "MB", bar: 550, linuxOnly: true, what: "a 100 MB log: memory above the log", record: "342 to 347 MB for 95 MB (0.9.0); at most 5.5 times the log (Deployment)" },
  { id: "ingest.stallMs", measure: "ingest", field: "stallMs", unit: "ms", bar: 1_200, linuxOnly: false, what: "a 100 MB log: longest stall", record: "233 to 360 ms for 95 MB (0.9.0)" },
  { id: "search.seconds", measure: "search", field: "seconds", unit: "s", bar: 6, linuxOnly: false, what: "one search of the 100 MB log", record: "1.8 s (0.8.2)" },
  { id: "search.peakMB", measure: "search", field: "peakMB", unit: "MB", bar: 100, linuxOnly: true, what: "one search: memory", record: "49 MB above the process (0.8.2)" },
  { id: "searches.seconds", measure: "searches", field: "seconds", unit: "s", bar: 30, linuxOnly: false, what: "eight searches at once", record: "up to 9 s (0.8.2)" },
  { id: "searches.peakMB", measure: "searches", field: "peakMB", unit: "MB", bar: 200, linuxOnly: true, what: "eight searches at once: memory", record: "115 to 159 MB in a process of 59 MB (0.8.2)" },
];

/** The lines of the log of 100 MB: `serviceLog(LOG_LINES)` of `llm-large-files/testing`. New in 0.99.9. */
export const LOG_LINES = 1_180_000;
/** Its size: 99.78 MiB, just under the default `maxUploadBytes` and `maxTextBytes` of 100 MiB. New in 0.99.9. */
export const LOG_BYTES = 104_625_979;
/** Its SHA-256, the log the bars were set on. New in 0.99.9. */
export const LOG_SHA256 = "0d60c947ece784e73355532efc1a5af43aae16765079d4a7dd5888197ddc6b7c";
/** The uploads sent at once. New in 0.99.9. */
export const UPLOAD_COUNT = 100;
/** The size of each upload, `uploadLog(index)`. New in 0.99.9. */
export const UPLOAD_BYTES = 1_999_969;
/** The SHA-256 of the 100 uploads, one after the other in order. New in 0.99.9. */
export const UPLOADS_SHA256 = "7b79d5a9eaf5594f2ee3a60a33ed01e13d37ab0fed131237fd7b64516bed25bc";

/**
 * The exact searches of the log of 100 MB, with the lines each counts: `search` runs the first,
 * `searches` all eight at once. New in 0.99.9.
 */
export const SEARCHES: ReadonlyArray<{ readonly query: string; readonly lines: number }> = [
  { query: "ERROR", lines: 12_164 },
  { query: "WARN", lines: 89_834 },
  { query: "worker-3", lines: 147_500 },
  { query: "orders/4999", lines: 236 },
  { query: "took 899ms", lines: 1_311 },
  { query: "req=0000", lines: 18 },
  { query: "zzz-not-there", lines: 0 },
  { query: "/api/v3", lines: 0 },
];

/**
 * Upload `index` of the 100 (0 to 99): every tenth line in Hebrew, whole lines while the total stays
 * ≤ 2,000,000 bytes. New in 0.99.9.
 */
export function uploadLog(index: number): Buffer {
  const lines: string[] = [];
  let bytes = 0;
  for (let n = 1; ; n++) {
    const time = new Date(Date.UTC(2026, 10, 12, 8, 0, 0) + index * 3_600_000 + n * 250).toISOString();
    const id = (((n + index * 7_919) * 2_654_435_761) >>> 0).toString(16).padStart(8, "0");
    const line = n % 10 === 0
      ? `${time} INFO [gateway] req=${id} user_text="מה הסטטוס של ההזמנה שלי? שורה ${n}" intent=order_status`
      : `${time} ${n % 97 === 0 ? "ERROR" : n % 13 === 0 ? "WARN" : "INFO"} [worker-${n % 8}] req=${id} GET /api/v2/orders/${n % 5_000} took ${(n * 37) % 900}ms`;
    const size = Buffer.byteLength(line) + (lines.length > 0 ? 1 : 0);
    if (bytes + size > 2_000_000) break;
    lines.push(line);
    bytes += size;
  }
  return Buffer.from(lines.join("\n"));
}

/**
 * Each budget against the runs of its measure: its lowest value (null and missing values skipped),
 * passed when that value is at most its bar, undefined when there is none. `budgets` defaults to
 * `BUDGETS`. New in 0.99.9.
 */
export function verdicts(runs: Partial<Record<MeasureName, MeasureResult[]>>, budgets: readonly Budget[] = BUDGETS): Verdict[] {
  return budgets.map((budget) => {
    const measured = runs[budget.measure] ?? [];
    const values = measured.map((run) => run[budget.field]).filter((value): value is number => typeof value === "number");
    const value = values.length > 0 ? Math.min(...values) : undefined;
    return { budget, value, runs: measured.length, passed: value === undefined ? undefined : value <= budget.bar };
  });
}

// ---- The children ----

const MiB = 1024 * 1024;
/** The owner of every call: the runs pass with owner checks on (the default since 0.99.9) or off. */
const OWNER = "perf";
const LINUX = process.platform === "linux";
const CHILD_MS = 300_000;
const MEASURES: readonly MeasureName[] = ["uploads", "ingest", "search", "searches"];

/** An error of this script, printed as its message alone (other errors are printed with their stack). */
class PerfError extends Error {}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const seconds = (ms: number): number => Number((ms / 1000).toFixed(2));
const megabytes = (bytes: number): number => Number((bytes / MiB).toFixed(1));

/** Node's full collection, which --expose-gc gives. */
function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new PerfError("Run the measures with --expose-gc.");
  gc();
}

/**
 * The heap in use once full collections free nothing more: collected a turn of the loop apart, until
 * ten in a row free less than 256 KB (as test/limits-0.8.2.test.ts does). Never the peak of
 * `heapUsed`, which counts garbage not collected yet.
 */
async function heapKept(): Promise<number> {
  let used = Number.POSITIVE_INFINITY;
  for (let round = 0, calm = 0; round < 60 && calm < 10; round++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    collect();
    const now = process.memoryUsage().heapUsed;
    calm = used - now < 256 * 1024 ? calm + 1 : 0;
    used = now;
  }
  return used;
}

/** The resident set and its high-water mark, in bytes (Linux). */
function residentSet(): { rss: number; hwm: number } {
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(status);
    if (match === null) throw new PerfError(`/proc/self/status has no ${name} line.`);
    return Number(match[1]) * 1024;
  };
  return { rss: field("VmRSS"), hwm: field("VmHWM") };
}

/**
 * Settles the heap, then resets the kernel's high-water mark of the resident set to the resident set
 * (Linux 4.0 or later). Returns the resident set in bytes, the baseline of `peakSince`; null off Linux.
 */
async function startPeak(): Promise<number | null> {
  await heapKept();
  if (!LINUX) return null;
  try {
    writeFileSync("/proc/self/clear_refs", "5");
  } catch (error) {
    throw new PerfError(`The peak resident set could not be reset through /proc/self/clear_refs (${messageOf(error)}): the memory budgets need Linux 4.0 or later.`);
  }
  const { rss, hwm } = residentSet();
  if (hwm > rss + MiB) throw new PerfError(`The peak resident set was not reset: VmHWM ${hwm / 1024} kB, VmRSS ${rss / 1024} kB after writing 5 to /proc/self/clear_refs.`);
  return rss;
}

/**
 * The most the resident set held since `startPeak`, above its baseline, in MB: everything the work
 * held at its highest, outside the heap too, but not the inputs read before. null off Linux.
 */
const peakSince = (base: number | null): number | null => (base === null ? null : megabytes(residentSet().hwm - base));

/** Starts a 5 ms timer; the function it returns stops it and gives the longest gap between its beats, in ms. */
function stallTimer(): () => number {
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  return () => {
    clearInterval(timer);
    return Math.round(Math.max(longest, performance.now() - last));
  };
}

type Inputs = { logBytes: number; logSha256: string; uploadBytes: number; uploadsSha256: string; seconds: number };

/** Makes the inputs in `dir`, and checks they are the ones the bars were set on. */
async function generate(dir: string): Promise<Inputs> {
  const started = performance.now();
  const log = Buffer.from(serviceLog(LOG_LINES));
  const logSha256 = sha256(log);
  if (log.byteLength !== LOG_BYTES || logSha256 !== LOG_SHA256) {
    throw new PerfError(`The 100 MB log is not the one the bars were set on: ${log.byteLength} bytes, SHA-256 ${logSha256}, where the bars were set on 104,625,979 bytes, SHA-256 ${LOG_SHA256}. serviceLog of llm-large-files/testing changed: measure again, and set the bars again in scripts/perf.ts and docs/measurements.md.`);
  }
  await writeFile(path.join(dir, "big.log"), log);
  await mkdir(path.join(dir, "uploads"), { recursive: true });
  const hash = createHash("sha256");
  let uploadBytes = 0;
  for (let index = 0; index < UPLOAD_COUNT; index++) {
    const bytes = uploadLog(index);
    hash.update(bytes);
    uploadBytes += bytes.byteLength;
    await writeFile(path.join(dir, "uploads", `${index}.log`), bytes);
  }
  const uploadsSha256 = hash.digest("hex");
  if (uploadBytes !== UPLOAD_COUNT * UPLOAD_BYTES || uploadsSha256 !== UPLOADS_SHA256) {
    throw new PerfError(`The 100 uploads are not the ones the bars were set on: ${uploadBytes} bytes, SHA-256 ${uploadsSha256}, where the bars were set on 199,996,900 bytes, SHA-256 ${UPLOADS_SHA256}. uploadLog in scripts/perf.ts changed: measure again, and set the bars again in scripts/perf.ts and docs/measurements.md.`);
  }
  return { logBytes: log.byteLength, logSha256, uploadBytes, uploadsSha256, seconds: seconds(performance.now() - started) };
}

/** The 100 uploads, all sent to `files.ingest` at once. */
async function uploads(dir: string): Promise<MeasureResult> {
  const store = path.join(dir, "uploads-store");
  await rm(store, { recursive: true, force: true });
  const files = createLargeFiles({ store: new FileDocumentStore(store) });
  // Buffers outside the heap, as an upload handler holds a body.
  let bodies: Buffer[] | undefined = await Promise.all(Array.from({ length: UPLOAD_COUNT }, (_, index) => readFile(path.join(dir, "uploads", `${index}.log`))));
  const base = await startPeak();
  const stop = stallTimer();
  const started = performance.now();
  const settled: number[] = [];
  const metas = await Promise.all(bodies.map((bytes, index) => files.ingest({ name: `app-${index}.log`, bytes, owner: OWNER }).then((meta) => {
    settled.push(performance.now() - started);
    return meta;
  })));
  const all = performance.now() - started;
  const stallMs = stop();
  const peakMB = peakSince(base);
  bodies = undefined;
  const heapAfter = await heapKept();
  // Read after the heap is measured, so the metas are held while it is, as an app holds them.
  if (metas.length !== UPLOAD_COUNT) throw new PerfError(`${metas.length} of the ${UPLOAD_COUNT} uploads were stored.`);
  await rm(store, { recursive: true, force: true });
  return {
    allSeconds: seconds(all),
    firstSeconds: seconds(settled[0]!),
    halfSeconds: seconds(settled[UPLOAD_COUNT / 2 - 1]!),
    peakMB,
    heapAfterMB: megabytes(heapAfter),
    stallMs,
    baseMB: base === null ? null : megabytes(base),
  };
}

/** The log of 100 MB, sent to `files.ingest`; its ID is left in `big.id` for the searches. */
async function ingest(dir: string): Promise<MeasureResult> {
  const store = path.join(dir, "store");
  await rm(store, { recursive: true, force: true });
  const files = createLargeFiles({ store: new FileDocumentStore(store) });
  const bytes = await readFile(path.join(dir, "big.log"));
  const base = await startPeak();
  const stop = stallTimer();
  const started = performance.now();
  const meta = await files.ingest({ name: "big.log", bytes, owner: OWNER });
  const ms = performance.now() - started;
  const stallMs = stop();
  const peakMB = peakSince(base);
  if (meta.lines !== LOG_LINES) throw new PerfError(`The 100 MB log was stored with ${meta.lines} lines, not 1,180,000.`);
  await writeFile(path.join(dir, "big.id"), meta.id);
  return { seconds: seconds(ms), peakMB, stallMs, baseMB: base === null ? null : megabytes(base), lines: meta.lines };
}

/** Exact searches of the stored log, all at once, through `search_document`, in a new process. */
async function search(dir: string, queries: typeof SEARCHES): Promise<MeasureResult> {
  const id = (await readFile(path.join(dir, "big.id"), "utf8")).trim();
  const files = createLargeFiles({ store: new FileDocumentStore(path.join(dir, "store")) });
  const meta = await files.getMeta(id, { owner: OWNER });
  if (meta === undefined) throw new PerfError(`The stored log ${id} was not found in ${path.join(dir, "store")}.`);
  // The text is over wholeDocumentBytes (2 MB), so it is read by range, in pieces of 1 MB.
  const tools = files.tools([meta], { access: { owner: OWNER } });
  const base = await startPeak();
  const stop = stallTimer();
  const started = performance.now();
  // The first call loads the line index from the store, as a first question in a new process does.
  const results = await Promise.all(queries.map(({ query }) => tools.execute("search_document", { document_id: id, query, mode: "exact" })));
  const ms = performance.now() - started;
  const stallMs = stop();
  const peakMB = peakSince(base);
  const totals = results.map((result, index) => {
    const { query, lines } = queries[index]!;
    if (typeof result.error === "string") throw new PerfError(`The search for "${query}" failed: ${result.error}`);
    if (typeof result.note === "string" && result.note.startsWith("The scan stopped early")) throw new PerfError(`The search for "${query}" stopped early: ${result.note}`);
    const total = result.total_matching_lines;
    if (total !== lines) throw new PerfError(`The search for "${query}" counted ${String(total)} lines, not ${lines}.`);
    return lines;
  });
  return { seconds: seconds(ms), peakMB, stallMs, baseMB: base === null ? null : megabytes(base), totals };
}

/** Runs one child's work in this process, and prints its result. */
async function child(name: string | undefined, dir: string | undefined): Promise<void> {
  if (dir === undefined) throw new PerfError("--child needs a name and a folder.");
  let result: Inputs | MeasureResult;
  if (name === "generate") result = await generate(dir);
  else {
    collect();
    if (name === "uploads") result = await uploads(dir);
    else if (name === "ingest") result = await ingest(dir);
    else if (name === "search") result = await search(dir, SEARCHES.slice(0, 1));
    else if (name === "searches") result = await search(dir, SEARCHES);
    else throw new PerfError(`Unknown child ${String(name)}. The children are: generate, uploads, ingest, search, searches.`);
  }
  // Written, then the process ends: nothing the library left running keeps it up.
  process.stdout.write(`PERF ${JSON.stringify(result)}\n`, () => process.exit(0));
}

// ---- The parent ----

type Options = { runs: number; summary: string | undefined; results: string | undefined };

/** Thrown for a usage error: exit 2. */
class UsageError extends PerfError {}

function parseOptions(args: readonly string[]): Options {
  const options: Options = { runs: 3, summary: undefined, results: undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag !== "--runs" && flag !== "--summary" && flag !== "--results") throw new UsageError(`Unknown option ${flag}. The options are: --runs, --summary, --results.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value.`);
    index++;
    if (flag === "--runs") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10) throw new UsageError(`--runs must be a whole number from 1 to 10, and is ${value}.`);
      options.runs = Number(value);
    } else if (flag === "--summary") options.summary = value;
    else options.results = value;
  }
  return options;
}

/** Runs a child in a fresh process, and gives what it printed after "PERF ". */
function runChild(name: "generate" | MeasureName, dir: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const args = [...process.execArgv, "--expose-gc", "--max-old-space-size=2048", fileURLToPath(import.meta.url), "--child", name, dir];
    const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"], timeout: CHILD_MS, killSignal: "SIGKILL" });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (signal !== null) {
        const timedOut = signal === "SIGKILL" && performance.now() - started >= CHILD_MS;
        reject(new PerfError(timedOut ? `The ${name} measure took more than 300 s, and was stopped.` : `The ${name} measure was stopped by ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new PerfError(`The ${name} measure failed (exit code ${String(code)}); its error is above.`));
        return;
      }
      const lines = out.split("\n");
      for (const line of lines) if (line.trim() !== "" && !line.startsWith("PERF ")) console.log(line);
      const last = lines.filter((line) => line.startsWith("PERF ")).at(-1);
      if (last === undefined) {
        reject(new PerfError(`The ${name} measure printed no result.`));
        return;
      }
      try {
        resolve(JSON.parse(last.slice("PERF ".length)));
      } catch {
        reject(new PerfError(`The ${name} measure printed a result that is not JSON: ${last}`));
      }
    });
  });
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const amount = (value: number, unit: string): string => `${numberFormat.format(value)} ${unit}`;
const runsText = (count: number): string => `${count} ${count === 1 ? "run" : "runs"}`;
/** A number of a run, or null when it is not one. */
const field = (run: MeasureResult, name: string): number | null => {
  const value = run[name];
  return typeof value === "number" ? value : null;
};
const memory = (run: MeasureResult, above: string): string => {
  const peak = field(run, "peakMB");
  return peak === null ? "memory not measured" : `memory ${amount(peak, "MB")}${above}`;
};

/** The line printed after each run of a measure. */
function progressLine(measure: MeasureName, run: MeasureResult, n: number, runs: number): string {
  const s = (name: string) => amount(field(run, name) ?? Number.NaN, "s");
  const stall = `longest stall ${amount(field(run, "stallMs") ?? Number.NaN, "ms")}`;
  const head = `${measure}, run ${n} of up to ${runs}: `;
  if (measure === "uploads") return `${head}all ${s("allSeconds")}, first ${s("firstSeconds")}, half ${s("halfSeconds")}, ${memory(run, " above the uploads")}, heap after ${amount(field(run, "heapAfterMB") ?? Number.NaN, "MB")}, ${stall}.`;
  if (measure === "ingest") return `${head}${s("seconds")}, ${memory(run, " above the log")}, ${stall}.`;
  const totals = Array.isArray(run.totals) ? run.totals : [];
  return `${head}${s("seconds")}, ${memory(run, "")}, ${stall}; ${totals.length === 1 ? "1 search" : `${totals.length} searches`}, ${numberFormat.format(totals.reduce((sum, total) => sum + total, 0))} lines counted.`;
}

type Report = {
  inputs: Inputs | undefined;
  runs: Record<MeasureName, MeasureResult[]>;
  verdicts: Verdict[];
  maxRuns: number;
  loadAverage: number;
  stopped: string | undefined;
};

/** The report, in Markdown. */
function reportOf({ inputs, verdicts: list, maxRuns, loadAverage, stopped }: Report): string {
  const cpus = os.cpus();
  const machine = `Node ${process.version} on ${process.platform} ${process.arch}, ${cpus[0]?.model.trim() ?? "an unknown CPU"} × ${cpus.length}, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB of memory; load average ${loadAverage.toFixed(2)} when the run began.${inputs === undefined ? "" : ` Inputs made in ${inputs.seconds} s.`}`;
  const rows = list.map(({ budget, value, runs, passed }) => {
    const measured = value !== undefined ? amount(value, budget.unit) : budget.linuxOnly && !LINUX ? "not measured: needs Linux" : "not measured";
    const result = passed === undefined ? "–" : passed ? "within" : "over";
    return `| \`${budget.id}\`: ${budget.what} | ${measured} | ${amount(budget.bar, budget.unit)} | ${runs} | ${budget.record} | ${result} |`;
  });
  const failed = list.filter((verdict) => verdict.passed === false);
  const unmeasured = list.filter((verdict) => verdict.passed === undefined).length;
  let last: string;
  if (stopped !== undefined) last = `The run stopped: ${stopped}`;
  else if (failed.length > 0) {
    const items = failed.map(({ budget, value }) => `\`${budget.id}\` (${amount(value!, budget.unit)}, bar ${amount(budget.bar, budget.unit)})`).join(", ");
    const over = failed.length === 1 ? "is over its bar" : "are over their bars";
    last = `${failed.length} of ${list.length} budgets ${over} after ${runsText(maxRuns)}: ${items}. How the bars were chosen: docs/measurements.md, "Performance budgets (0.99.9)".`;
  } else if (unmeasured > 0) last = `All ${list.length - unmeasured} budgets measured are within their bars. ${unmeasured} memory budgets were not measured: they need Linux.`;
  else last = `All ${list.length} budgets are within their bars.`;
  return [
    "## Performance budgets",
    "",
    machine,
    "",
    "| Budget | Measured | Bar | Runs | Record (docs/measurements.md) | Result |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    last,
    "",
  ].join("\n");
}

/** Every run's numbers, for --results. */
function resultsOf({ inputs, runs, verdicts: list, loadAverage, stopped }: Report): object {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model.trim() ?? null,
    cpus: cpus.length,
    memoryMB: Math.round(os.totalmem() / MiB),
    loadAverage,
    inputs: inputs === undefined ? null : { logBytes: inputs.logBytes, uploadBytes: inputs.uploadBytes, seconds: inputs.seconds },
    runs,
    budgets: list.map(({ budget, value, runs: count, passed }) => ({ id: budget.id, unit: budget.unit, bar: budget.bar, value: value ?? null, runs: count, passed: passed ?? null })),
    passed: stopped === undefined && list.every((verdict) => verdict.passed !== false),
    ...(stopped !== undefined ? { stopped } : {}),
  };
}

/** The whole run: inputs, each measure, the runs again over a bar, the report. Gives the exit code. */
async function main(args: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
  if (!LINUX) console.log(`The memory budgets need Linux (/proc/self/status and /proc/self/clear_refs): they are not measured on ${process.platform}.`);
  const loadAverage = os.loadavg()[0] ?? 0;
  const runs: Record<MeasureName, MeasureResult[]> = { uploads: [], ingest: [], search: [], searches: [] };
  let inputs: Inputs | undefined;
  let stopped: string | undefined;
  const dir = await mkdtemp(path.join(os.tmpdir(), "llf-perf-"));
  const measure = async (name: MeasureName): Promise<void> => {
    const result = (await runChild(name, dir)) as MeasureResult;
    runs[name].push(result);
    console.log(progressLine(name, result, runs[name].length, options.runs));
  };
  try {
    try {
      inputs = (await runChild("generate", dir)) as Inputs;
      console.log(`inputs, made in ${inputs.seconds} s: a log of ${numberFormat.format(inputs.logBytes)} bytes and ${UPLOAD_COUNT} uploads of ${numberFormat.format(UPLOAD_BYTES)} bytes, their SHA-256 checked.`);
      for (const name of MEASURES) await measure(name);
      for (;;) {
        const now = verdicts(runs);
        const again = MEASURES.filter((name) => runs[name].length < options.runs && now.some((verdict) => verdict.budget.measure === name && verdict.passed === false));
        if (again.length === 0) break;
        for (const name of again) {
          const n = runs[name].length;
          const latest = runs[name][n - 1]!;
          const over = now
            .filter((verdict) => verdict.budget.measure === name && verdict.passed === false)
            .map(({ budget }) => `\`${budget.id}\` ${amount(field(latest, budget.field) ?? Number.NaN, budget.unit)}, bar ${amount(budget.bar, budget.unit)}`)
            .join("; ");
          console.log(`${name}: over its bar in run ${n} (${over}); running it again, run ${n + 1} of ${options.runs}.`);
          await measure(name);
        }
      }
    } catch (error) {
      if (!(error instanceof PerfError)) console.error(error);
      stopped = messageOf(error);
    }
    const report: Report = { inputs, runs, verdicts: verdicts(runs), maxRuns: options.runs, loadAverage, stopped };
    const text = reportOf(report);
    console.log(`\n${text}`);
    if (options.summary !== undefined) await appendFile(options.summary, `${text}\n`);
    if (options.results !== undefined) await writeFile(options.results, `${JSON.stringify(resultsOf(report), null, 2)}\n`);
    return report.stopped === undefined && report.verdicts.every((verdict) => verdict.passed !== false) ? 0 : 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--child") await child(args[1], args[2]);
    else process.exitCode = await main(args);
  } catch (error) {
    console.error(error instanceof PerfError ? error.message : error);
    process.exitCode = 1;
  }
}
