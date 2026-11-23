// What the tests of ingest events (test/ingest-events.test.ts and test/timing/ingest.timing.test.ts)
// record and check: the events of one ingest, a log to ingest, and file stores in folders of their own.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { FileDocumentStore, type IngestEvent } from "llm-large-files";

export type Progress = Extract<IngestEvent, { type: "ingest.progress" }>;

/** Collects the events of one ingest. */
export function recorder() {
  const events: IngestEvent[] = [];
  /** When each event arrived, by `performance.now()`: the clock the library spaces progress with. */
  const arrived = new Map<IngestEvent, number>();
  return {
    events,
    arrived,
    onEvent: (event: IngestEvent) => {
      arrived.set(event, performance.now());
      events.push(event);
    },
    progress: (stage?: Progress["stage"]) => events.filter((event): event is Progress => event.type === "ingest.progress" && (stage === undefined || event.stage === stage)),
    /** The stages in the order they first reported. */
    stages: () => [...new Set(events.flatMap((event) => (event.type === "ingest.progress" ? [event.stage] : [])))],
  };
}

/** What every ingest's events have in common: seq from 1 without gaps, one run, start first, one terminal event last. */
export function expectWellFormed(events: IngestEvent[]): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect(new Set(events.map((event) => event.runId)).size).toBe(1);
  expect(events[0]!.type).toBe("ingest.start");
  const terminal = events.filter((event) => event.type === "ingest.finish" || event.type === "ingest.error");
  expect(terminal).toHaveLength(1);
  expect(events.at(-1)).toBe(terminal[0]);
}

export function logText(lines: number): string {
  const out: string[] = [];
  for (let index = 1; index <= lines; index++) {
    const second = String(index % 60).padStart(2, "0");
    out.push(index % 500 === 0
      ? `2026-05-01 12:00:${second} ERROR payment-service: timeout after ${index}ms calling ledger`
      : `2026-05-01 12:00:${second} INFO handled request ${index} in ${index % 40}ms`);
  }
  return out.join("\n");
}

const directories: string[] = [];

/** Removes the folders of the stores made by `fileStore()`: call it after each test. */
export async function removeFileStores(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function fileStore(): Promise<FileDocumentStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "llm-ingest-events-"));
  directories.push(directory);
  return new FileDocumentStore(directory);
}
