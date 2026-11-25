import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IngestError } from "../errors.js";
import type { PdfExtractorOptions } from "../extract.js";
import type { DocumentFormat, ExtractedText, ExtractInput, Extractor } from "../types.js";
import type { ChildJob, ChildMessage } from "./ingest-child.js";

export type IsolatedExtractorOptions = {
  /**
   * The heap of each child process, in MB: a file that needs more is refused ("out_of_memory"),
   * and the server goes on. Defaults to 512; at least 1, and finite. The server's own
   * `NODE_OPTIONS` are not passed to the children: a heap flag there would replace this one.
   */
  maxHeapMb?: number;
  /**
   * The most time one file may take, in milliseconds: past it, its child process is killed and the
   * file refused ("timeout"). Defaults to 120,000. 0 sets none, and so does a time past what a
   * timer can wait (2,147,483,647 ms), `Infinity` included. `ingestTimeoutMs` of the library stops
   * a file too; this one holds even for a page that pdf.js reads in one block.
   */
  timeoutMs?: number;
  /** How many files are read at once, each in a child process of its own. Defaults to 2. */
  concurrency?: number;
  /**
   * How many files may wait for a child process. Past it, a file is refused at once with
   * `IngestError` "busy" (`retryAfterMs`), which the upload handler answers with 503 and
   * `Retry-After`. Defaults to 8.
   */
  maxQueue?: number;
  /**
   * The formats read in child processes. Defaults to the ones whose parsers a hostile file can
   * exhaust: "pdf", "docx", "pptx" and "xlsx". Text formats are read in the server, in slices.
   */
  formats?: DocumentFormat[];
  /** Options of the built-in PDF extractor in the children (see `createPdfExtractor`). */
  pdf?: PdfExtractorOptions;
  /**
   * How many files one child process reads before it is replaced by a new one. Defaults to 50.
   * Some parsers keep memory for the life of their process (pdf-lib keeps every name it reads).
   */
  maxFilesPerChild?: number;
  /**
   * A child process with nothing to read is stopped after this many milliseconds. Defaults to
   * 30,000. 0, or a time past what a timer can wait, keeps the children until `close()`. Either
   * way an idle child does not keep your process alive.
   */
  idleMs?: number;
  /** Further Node options for the children, beside the heap limit. */
  execArgv?: string[];
  /**
   * Environment variables for the children, besides the short list they are given of the server's
   * own: where programs, libraries and temporary files are (`PATH`, `TMPDIR`…), the time zone and
   * the language (`TZ`, `LANG`, `LC_*`), Node's own settings (`NODE_ENV`, `NODE_PATH`…), and what
   * Windows needs (`SystemRoot`…). Nothing else of the server's environment reaches a child: its
   * keys and passwords are not in a process that reads files you do not trust. A variable here is
   * added, or replaces the server's; `undefined` takes one of the list out. `process.env` passes
   * the whole environment, as before 0.99.10. `NODE_OPTIONS` is never passed, from here either: a
   * heap flag there would replace the child's (`execArgv` is for Node's options). New in 0.99.10.
   */
  env?: Record<string, string | undefined>;
  /**
   * The script the children run: a path, a `file:` URL, or a string of one (as
   * `import.meta.resolve("llm-large-files/node/ingest-child.js")` gives). Defaults to the one
   * shipped next to this module. For a bundler that moves files.
   */
  childScript?: string | URL;
};

export type IsolatedExtractors = {
  /** Pass them to `createLargeFiles({ extractors })`. */
  extractors: Partial<Record<DocumentFormat, Extractor>>;
  /** Files being read, files waiting, and child processes running: for a health check or a metric. */
  stats(): { running: number; queued: number; children: number };
  /**
   * Stops every child process, and refuses the files waiting. Resolves once the children have
   * exited. Files sent later start new ones.
   */
  close(): Promise<void>;
};

/** What the out-of-memory death of a child process writes on its standard error. */
const OUT_OF_MEMORY = /heap out of memory|Reached heap limit|allocation failed/i;
/** The last characters kept of a child's standard error, to tell why it died. */
const STDERR_KEPT = 4_096;
/** How long to wait before trying again, when every reader is busy. */
const BUSY_RETRY_MS = 5_000;
/** The longest a Node.js timer waits: a longer one fires at once. A time past it is no limit, as for `ingestTimeoutMs`. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

const DEFAULT_FORMATS: DocumentFormat[] = ["pdf", "docx", "pptx", "xlsx"];

/**
 * The server's environment variables a child is given (0.99.10), with every `LC_*`: what Node
 * needs to start and to read a file as the server would, and nothing an application keeps a key
 * or a password in. Before, a child had the whole environment: a parser that a file takes over
 * would have read every secret of the server there.
 */
const CHILD_ENV = [
  // Where programs, libraries and temporary files are, and how memory is given out.
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
  "LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "LIBPATH",
  "MALLOC_ARENA_MAX", "MALLOC_CONF", "GLIBC_TUNABLES",
  // The time zone and the language: a child reads dates and numbers as the server does.
  "TZ", "TZDIR", "LANG", "LANGUAGE", "ICU_DATA",
  // Node's own settings. Never NODE_OPTIONS, whose heap flag would replace the child's.
  "NODE_ENV", "NODE_PATH", "NODE_ICU_DATA", "NODE_PRESERVE_SYMLINKS", "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE",
  "NODE_SKIP_PLATFORM_CHECK", "NODE_V8_COVERAGE", "UV_THREADPOOL_SIZE", "ELECTRON_RUN_AS_NODE",
  // Windows, where a process without SystemRoot does not start right.
  "SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

/**
 * The environment of a child: the short list of the server's variables (`CHILD_ENV`), then `more`
 * (`IsolatedExtractorOptions.env`), without `NODE_OPTIONS` in any case of its name (Windows reads
 * names whatever their case). Read when the child starts.
 */
function childEnvironment(more: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase().startsWith("LC_") && value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(more ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "NODE_OPTIONS") delete env[name];
  }
  return env;
}

type Job = {
  id: number;
  bytes: Uint8Array;
  input: ExtractInput;
  resolve(result: ExtractedText): void;
  reject(error: unknown): void;
  /** Takes the job out of the queue when its caller gives up while it waits. */
  cancel?: () => void;
};

type Child = {
  process: ChildProcess;
  ready: Promise<void>;
  /** Whether it said it is ready: a child that dies before has not been sent a file. */
  started: boolean;
  /** Settled once it is gone: it exited, or could not start at all. */
  gone: Promise<void>;
  job: Job | undefined;
  files: number;
  stderr: string;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Set when this module killed it, and why. */
  killedFor?: unknown;
};

function positive(name: string, value: number | undefined, fallback: number, zeroAllowed = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || (!zeroAllowed && value === 0)) {
    throw new RangeError(`${name} must be a number above ${zeroAllowed ? "or equal to " : ""}0, and is ${String(value)}.`);
  }
  return value;
}

/** Calls `then` once the standard error of a child that has exited is read to its end, or after a second. */
function afterStderr(child: ChildProcess, then: () => void): void {
  const stderr = child.stderr;
  if (!stderr || stderr.destroyed || stderr.readableEnded) {
    then();
    return;
  }
  let called = false;
  const once = () => {
    if (called) return;
    called = true;
    clearTimeout(timer);
    then();
  };
  const timer = setTimeout(once, 1_000);
  stderr.once("close", once);
}

/** A time option as a timer takes it: one past the longest timer, `Infinity` included, is none (0). */
const timerMs = (ms: number) => (ms > LONGEST_TIMER_MS ? 0 : ms);

/** A time limit as the refusal gives it, as `ingestTimeoutMs`'s does: "500 ms", "45 s", "2 min". */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 120_000) return `${Number((ms / 1_000).toFixed(1))} s`;
  return `${Number((ms / 60_000).toFixed(1))} min`;
}

/**
 * The largest heap given to a child, in MB: 1 TB. Node reads a far larger --max-old-space-size
 * wrong (Number.MAX_SAFE_INTEGER gave a 47 MB heap, and every file failed).
 */
const MAX_HEAP_MB = 1_048_576;

/**
 * Extractors that read files in child processes, each with a heap limit and a kill timer, so that
 * a hostile upload (a zip bomb, a PDF that draws gigabytes) is refused while the server goes on:
 * a worker thread does not reliably contain running out of memory, a process does. At most
 * `concurrency` files are read at once, and at most `maxQueue` wait; past that a file is refused
 * as "busy". Use them in place of the built-in extractors for files from users:
 *
 * ```ts
 * const isolated = createIsolatedExtractors({ maxHeapMb: 512, concurrency: 2 });
 * const files = createLargeFiles({ store, extractors: isolated.extractors });
 * // A SIGTERM listener replaces Node's own exit: stop the server there too, or it goes on serving.
 * process.once("SIGTERM", () => {
 *   server.close();
 *   void isolated.close();
 * });
 * ```
 *
 * A file costs its bytes copied to the child and its text copied back. A file ingested from a path
 * (`IngestFromSource`) is read by its child instead (`readsPath`, 0.9.0): the server reads none of
 * it, and holds none of it while it waits for a child. The children load the same
 * optional dependencies (`unpdf`, `jszip`, `@cantoo/pdf-lib`) the server would. They are given a
 * short list of the server's environment variables, without its keys and passwords (0.99.10; `env`
 * adds to it).
 */
export function createIsolatedExtractors(options: IsolatedExtractorOptions = {}): IsolatedExtractors {
  const maxHeapMb = Math.trunc(positive("maxHeapMb", options.maxHeapMb, 512));
  // Node takes --max-old-space-size=0 for its default heap, not for none, and a child given a
  // value it cannot read stops at its start: every file would then be refused.
  if (!Number.isSafeInteger(maxHeapMb) || maxHeapMb < 1 || maxHeapMb > MAX_HEAP_MB) throw new RangeError(`maxHeapMb must be a number from 1 to ${MAX_HEAP_MB.toLocaleString("en-US")} (1 TB), and is ${String(options.maxHeapMb)}.`);
  const timeoutMs = timerMs(positive("timeoutMs", options.timeoutMs, 120_000, true));
  const concurrency = Math.max(1, Math.trunc(positive("concurrency", options.concurrency, 2)));
  const maxQueue = Math.trunc(positive("maxQueue", options.maxQueue, 8, true));
  const maxFiles = Math.max(1, Math.trunc(positive("maxFilesPerChild", options.maxFilesPerChild, 50)));
  const idleMs = timerMs(positive("idleMs", options.idleMs, 30_000, true));
  const script = options.childScript ?? new URL("./ingest-child.js", import.meta.url);
  // fork() takes a path: a file URL given as a string (import.meta.resolve) would be read as a relative path.
  const scriptPath = script instanceof URL || script.startsWith("file:") ? fileURLToPath(script) : script;
  if (options.env !== undefined && (typeof options.env !== "object" || options.env === null)) {
    throw new TypeError(`env must be an object of environment variables, such as { TZ: "UTC" } or process.env, and is ${options.env === null ? "null" : typeof options.env}.`);
  }
  const children: Child[] = [];
  /** Every child not yet gone, those stopped and not yet exited included: close() waits for them. */
  const alive = new Set<Child>();
  const queue: Job[] = [];
  let nextId = 1;
  let closed = false;

  function spawn(): Child {
    const child = fork(scriptPath, [], {
      execArgv: [`--max-old-space-size=${maxHeapMb}`, ...(options.execArgv ?? [])],
      env: childEnvironment(options.env),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let markReady: () => void = () => undefined;
    let markGone: () => void = () => undefined;
    const entry: Child = {
      process: child,
      ready: new Promise((resolve) => (markReady = resolve)),
      started: false,
      gone: new Promise((resolve) => (markGone = resolve)),
      job: undefined,
      files: 0,
      stderr: "",
      idle: undefined,
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      entry.stderr = (entry.stderr + chunk).slice(-STDERR_KEPT);
    });
    child.on("message", (message: ChildMessage) => {
      if (message.type === "ready") {
        entry.started = true;
        markReady();
        return;
      }
      const job = entry.job;
      if (!job || message.id !== job.id) return;
      if (message.type === "progress") {
        try {
          job.input.onProgress?.(message.progress);
        } catch (error) {
          finish(entry, () => job.reject(error), true);
        }
        return;
      }
      finish(entry, () => (message.type === "done" ? job.resolve(message.result) : job.reject(childError(message))));
    });
    // A child that dies ends with "exit"; one that could not start (EAGAIN, EMFILE, ENOENT) only
    // with "error". Either way it is gone once, and its file is refused.
    let gone = false;
    const end = (code: number | null, signal: NodeJS.Signals | null, error?: unknown) => {
      if (gone) return;
      gone = true;
      clearTimeout(entry.idle);
      const index = children.indexOf(entry);
      if (index !== -1) children.splice(index, 1);
      alive.delete(entry);
      markReady();
      markGone();
      const job = entry.job;
      entry.job = undefined;
      if (job) {
        // A death that says itself why (killed here, never started, a heap that ran out by its
        // signal or its code, or by words already read) is told at once.
        const reason = entry.killedFor ?? (error !== undefined ? unstarted(job, error) : entry.started && ranOutOfMemory(entry, code, signal) ? deathOf(entry, job, code, signal) : undefined);
        if (reason !== undefined) job.reject(reason);
        // Any other is told by what the child wrote on its standard error, which may come after
        // "exit": its end is waited for, a second at most. A child that stopped before it was
        // ready wrote there why; one that died while it read a file, whether its heap ran out
        // (0.99.10: where a heap that ran out ends the process with a plain exit code, as on
        // Windows, the words that came after the exit were not read, and the file was told as
        // one that could not be read).
        else afterStderr(child, () => job.reject(entry.started ? deathOf(entry, job, code, signal) : notStarted(entry, job, code, signal)));
      }
      pump();
    };
    child.on("exit", (code, signal) => end(code, signal));
    child.on("error", (error) => {
      if (child.pid === undefined) end(null, null, error);
    });
    children.push(entry);
    alive.add(entry);
    return entry;
  }

  /** The refusal of a file whose reader could not be started. */
  function unstarted(job: Job, error: unknown): IngestError {
    const code = (error as { code?: unknown } | null)?.code;
    return new IngestError("busy", `${job.input.name} could not be read now: a reader could not be started${typeof code === "string" ? ` (${code})` : ""}. Try again in a moment.`, { cause: error, retryAfterMs: BUSY_RETRY_MS });
  }

  /** The error a child sent back: a system error keeps its code, so it is not told to a user as a file that cannot be read. */
  function childError(message: Extract<ChildMessage, { type: "error" }>): Error {
    const error = new Error(message.message);
    if (message.code !== undefined) Object.assign(error, { code: message.code, ...(message.syscall !== undefined ? { syscall: message.syscall } : {}) });
    return error;
  }

  /**
   * The error of a file whose child stopped before it was ready, so before it was sent the file: a
   * script that is not there, a Node option it does not know. That is the server's trouble, not the
   * file's, so it is not an `IngestError`: its status is 500, and the upload handler answers with
   * its message. The child's standard error names paths of the server, so it is only the `cause`.
   */
  function notStarted(entry: Child, job: Job, code: number | null, signal: NodeJS.Signals | null): Error {
    const stderr = entry.stderr.trim();
    const cause = new Error(stderr ? `The reader stopped before it was ready. The end of its standard error:\n${stderr}` : "The reader stopped before it was ready, and wrote nothing on its standard error.");
    return Object.assign(new Error(`The server could not start a reader for ${job.input.name} (${signal ?? `exit code ${code}`}).`, { cause }), { status: 500 });
  }

  /** Whether a child that died ran out of its heap: by its signal or its exit code, or by what it wrote while it read its file. */
  const ranOutOfMemory = (entry: Child, code: number | null, signal: NodeJS.Signals | null) => signal === "SIGABRT" || code === 134 || OUT_OF_MEMORY.test(entry.stderr);

  /** Why a child process died while it read a file. */
  function deathOf(entry: Child, job: Job, code: number | null, signal: NodeJS.Signals | null): IngestError {
    if (ranOutOfMemory(entry, code, signal)) {
      return new IngestError("out_of_memory", `${job.input.name} needed more memory than is allowed for reading one file (${maxHeapMb} MB). It may be built to exhaust the server, so it is not read. Split it, or save it as plain text, and attach that.`);
    }
    return new IngestError("unreadable", `${job.input.name} could not be read: its reader stopped (${signal ?? `exit code ${code}`}).`);
  }

  /** Ends the job of a child: settles it, and gives the child the next job, or replaces it. */
  function finish(entry: Child, settle: () => void, kill = false): void {
    const job = entry.job;
    if (!job) return;
    entry.job = undefined;
    job.cancel?.();
    entry.process.channel?.unref();
    settle();
    if (kill || entry.files >= maxFiles) stop(entry);
    pump();
  }

  /** Kills a child. `reason`: what its job, if it has one, is refused with. */
  function stop(entry: Child, reason?: unknown): void {
    if (reason !== undefined) entry.killedFor = reason;
    const index = children.indexOf(entry);
    if (index !== -1) children.splice(index, 1);
    clearTimeout(entry.idle);
    // A child that could not start has no pid, so no process to signal: its "error" event, on the
    // next tick, ends it (and close() waits for that).
    if (entry.process.pid === undefined) return;
    // An idle child was unref'd: held again, the process lives until its "exit", which close() waits for.
    entry.process.ref();
    entry.process.kill("SIGKILL");
  }

  /** Gives waiting jobs to idle children, starting new ones up to `concurrency`. */
  function pump(): void {
    while (queue.length > 0) {
      let entry = children.find((child) => !child.job);
      if (!entry) {
        if (children.length >= concurrency) return;
        try {
          entry = spawn();
        } catch (error) {
          // fork can throw at once (out of process slots or file handles): the waiting files are told to try again.
          for (const job of queue.splice(0)) {
            job.cancel?.();
            job.reject(unstarted(job, error));
          }
          return;
        }
      }
      const job = queue.shift()!;
      job.cancel?.();
      start(entry, job);
    }
    for (const child of children) {
      if (child.job || child.idle) continue;
      // An idle child, its channel and its pipe hold the server open no longer.
      child.process.unref();
      child.process.channel?.unref();
      (child.process.stderr as { unref?: () => void } | null)?.unref?.();
      if (idleMs === 0) continue;
      child.idle = setTimeout(() => {
        child.idle = undefined;
        if (!child.job) stop(child);
      }, idleMs);
      child.idle.unref?.();
    }
  }

  function start(entry: Child, job: Job): void {
    clearTimeout(entry.idle);
    entry.idle = undefined;
    entry.job = job;
    entry.files++;
    // What the child wrote while it read an earlier file says nothing of this one (0.99.10: a
    // warning kept from an earlier file, "Array buffer allocation failed", told a later death of
    // any kind as a heap that ran out).
    entry.stderr = "";
    entry.process.ref();
    entry.process.channel?.ref();
    (entry.process.stderr as { ref?: () => void } | null)?.ref?.();
    const signal = job.input.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => stop(entry, signal!.reason);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const { resolve, reject } = job;
    job.resolve = (result) => {
      cleanup();
      resolve(result);
    };
    job.reject = (error) => {
      cleanup();
      reject(error);
    };
    if (signal?.aborted) {
      stop(entry, signal.reason);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => stop(entry, new IngestError("timeout", `${job.input.name} took too long to read (more than ${formatDuration(timeoutMs)}). Split it, or save it as plain text, and attach that.`)), timeoutMs);
    }
    const { name, mimeType, format, scannedPages, maxTextBytes, maxPages, path, maxUploadBytes } = job.input;
    // A file at a path (0.9.0) goes as its path: the child reads it, and its bytes never wait here.
    const fromPath = typeof path === "string" && job.bytes.byteLength === 0;
    const message: ChildJob = {
      type: "extract",
      id: job.id,
      bytes: job.bytes,
      ...(fromPath ? { path } : {}),
      input: {
        name, mimeType, format,
        ...(scannedPages !== undefined ? { scannedPages } : {}),
        ...(maxTextBytes !== undefined && Number.isFinite(maxTextBytes) ? { maxTextBytes } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(fromPath && typeof maxUploadBytes === "number" && Number.isFinite(maxUploadBytes) ? { maxUploadBytes } : {}),
        progress: typeof job.input.onProgress === "function",
      },
      ...(options.pdf ? { pdf: options.pdf } : {}),
    };
    entry.ready.then(() => {
      if (entry.job !== job || !entry.process.connected) return;
      entry.process.send(message, (error) => {
        if (error && entry.job === job) stop(entry, new IngestError("unreadable", `${name} could not be read: its reader could not be reached.`, { cause: error }));
      });
    }, () => undefined);
  }

  // Reads a file ingested from a path in the child (`readsPath`): the server does not read it.
  const extract: Extractor = Object.assign((bytes: Uint8Array, input: ExtractInput) => new Promise<ExtractedText>((resolve, reject) => {
    if (closed) {
      reject(new IngestError("busy", "The server is shutting down. Try again in a moment.", { retryAfterMs: BUSY_RETRY_MS }));
      return;
    }
    input.signal?.throwIfAborted();
    const job: Job = { id: nextId++, bytes, input, resolve, reject };
    const idle = children.some((child) => !child.job) || children.length < concurrency;
    if (!idle && queue.length >= maxQueue) {
      reject(new IngestError("busy", "The server is reading other files right now. Try again in a moment.", { retryAfterMs: BUSY_RETRY_MS }));
      return;
    }
    // A caller that gives up while its file waits takes it out of the queue.
    const signal = input.signal;
    if (signal) {
      const onAbort = () => {
        const index = queue.indexOf(job);
        if (index !== -1) {
          queue.splice(index, 1);
          reject(signal.reason);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      job.cancel = () => signal.removeEventListener("abort", onAbort);
    }
    queue.push(job);
    pump();
  }), { readsPath: true });

  const formats = options.formats ?? DEFAULT_FORMATS;
  return {
    extractors: Object.fromEntries(formats.map((format) => [format, extract])) as Partial<Record<DocumentFormat, Extractor>>,
    stats: () => ({ running: children.filter((child) => child.job).length, queued: queue.length, children: children.length }),
    async close() {
      closed = true;
      const waiting = queue.splice(0);
      for (const job of waiting) {
        job.cancel?.();
        job.reject(new IngestError("busy", "The server is shutting down. Try again in a moment.", { retryAfterMs: BUSY_RETRY_MS }));
      }
      // Each child is gone once it has exited, or, if it could not start, once its "error" came.
      // Those stopped earlier (replaced, idle) and not yet exited are waited for too.
      const exits = [...alive].map((child) => child.gone);
      for (const child of [...children]) stop(child, new IngestError("busy", "The server is shutting down. Try again in a moment.", { retryAfterMs: BUSY_RETRY_MS }));
      await Promise.all(exits);
      closed = false;
    },
  };
}
