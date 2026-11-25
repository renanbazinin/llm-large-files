// The upload handler on a local server, over a library whose extractor holds each file until the
// test lets it go: for the tests of the limits of 0.8.2 (test/limits-0.8.2.test.ts and
// test/timing/upload.timing.test.ts).
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { createLargeFiles, MemoryDocumentStore, type Extractor } from "llm-large-files";
import { createDocumentHandlers } from "llm-large-files/node";

/** Waits, a turn of the event loop at a time, until `ready` holds (at most about 5 s). */
export async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 5_000 && !ready(); turn++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(ready()).toBe(true);
}

/** A text extractor that holds each file until the test lets it go, and counts how many it holds at once. */
export function heldExtractor() {
  const waiting: Array<() => void> = [];
  const state = {
    calls: 0,
    running: 0,
    most: 0,
    names: [] as string[],
    waiting,
    releaseAll: () => waiting.splice(0).forEach((release) => release()),
    releaseOne: () => waiting.shift()?.(),
  };
  const extract: Extractor = async (bytes, input) => {
    state.calls++;
    state.names.push(input.name);
    state.running++;
    state.most = Math.max(state.most, state.running);
    await new Promise<void>((resolve) => waiting.push(resolve));
    state.running--;
    return { text: new TextDecoder().decode(bytes) };
  };
  return { state, extract };
}

/**
 * Serves the upload handler of a library whose text extractor is a `heldExtractor()`, on
 * 127.0.0.1. `keep` gets the server as soon as it is made, for the test file to close it after
 * each test.
 */
export async function uploadServer(handlerOptions: Parameters<typeof createDocumentHandlers>[1], maxUploadBytes: number, store: MemoryDocumentStore, keep: (server: Server) => void) {
  const held = heldExtractor();
  const files = createLargeFiles({ requireOwner: false, store, extractors: { text: held.extract }, maxUploadBytes, maxConcurrentIngests: 10 });
  const documents = createDocumentHandlers(files, handlerOptions);
  const server = createServer((request, response) => {
    // As express.raw() leaves it: the body already read, in request.body.
    const parsedSize = Number(request.headers["x-parsed-size"]);
    if (parsedSize) (request as IncomingMessage & { body?: unknown }).body = Buffer.alloc(parsedSize, 120);
    void documents.upload(request, response);
  });
  keep(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
  const upload = (name: string, size: number) => fetch(url, { method: "POST", headers: { "X-File-Name": name }, body: "x".repeat(size) });
  return { state: held.state, url, upload };
}
