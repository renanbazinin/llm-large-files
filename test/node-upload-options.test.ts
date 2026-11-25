// What prepareUpload may return since 0.99.9: `dedupe` and `appData`, the server's own values,
// passed to ingest. A file uploaded again gives back the document stored before (onUploaded is told
// `reused: true`), which the handlers never delete, and the file saved for that upload is removed.
// appData is checked before the body is read, and never answered.
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLargeFiles,
  FileDocumentStore,
  MAX_APP_DATA_BYTES,
  MemoryDocumentStore,
  type DocumentStore,
  type IngestFromSource,
  type IngestInput,
  type LargeFiles,
} from "llm-large-files";
import { createDocumentHandlers, fileOriginals, type DocumentHandlerOptions, type PreparedUpload, type UploadedContext } from "llm-large-files/node";

let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Serves the upload handler at /api/documents. Its URL. */
async function serve(files: LargeFiles, options: DocumentHandlerOptions): Promise<string> {
  const documents = createDocumentHandlers(files, options);
  server = createServer((request, response) => void documents.upload(request, response));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/documents`;
}

const userOf = (request: IncomingMessage) => (typeof request.headers["x-user"] === "string" ? request.headers["x-user"] : undefined);
const ALICE = { "X-User": "alice" };
const upload = (base: string, body: string, name = "notes.txt", events = false) =>
  fetch(base, { method: "POST", headers: { "X-File-Name": name, ...ALICE, ...(events ? { Accept: "text/event-stream" } : {}) }, body });

/** An upload whose body never ends: its answer, which comes only when it is given before the body is read. */
function unfinished(base: string): Promise<{ status?: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const client = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-File-Name": "notes.txt", ...ALICE, "Transfer-Encoding": "chunked" } });
    client.on("response", (response) => {
      response.setEncoding("utf8");
      response.once("data", (body: string) => {
        resolve({ status: response.statusCode, body });
        client.destroy();
      });
    });
    client.on("error", (error) => (client.destroyed ? undefined : reject(error)));
    client.write("The first piece of a body that never ends.");
  });
}

/** The library, with a spy on its ingest. */
function spied(store: DocumentStore = new MemoryDocumentStore()) {
  const files = createLargeFiles({ store });
  const ingest = vi.fn((input: IngestInput | IngestFromSource) => files.ingest(input));
  return { files, ingest, served: { ...files, ingest } as LargeFiles };
}

const exists = (file: string) => lstat(file).then(() => true, () => false);

describe("prepareUpload's appData", () => {
  it("passes appData from prepareUpload to ingest: kept in the metadata, never in the 201 or in ingest.finish", async () => {
    const { files, ingest, served } = spied();
    const base = await serve(served, { getOwner: userOf, prepareUpload: () => ({ appData: { rowId: "row-7", tags: ["contract"] } }) });
    const response = await upload(base, "The meeting is on Tuesday.");
    expect(response.status).toBe(201);
    const raw = await response.text();
    expect(raw).not.toContain("appData");
    expect(raw).not.toContain("row-7");
    const { id } = JSON.parse(raw) as { id: string };
    expect(ingest.mock.calls[0]![0]).toMatchObject({ appData: { rowId: "row-7", tags: ["contract"] }, owner: "alice" });
    expect((await files.getMeta(id, { owner: "alice" }))?.appData).toEqual({ rowId: "row-7", tags: ["contract"] });
    const streamed = await (await upload(base, "The meeting is on Wednesday.", "notes.txt", true)).text();
    expect(streamed).toContain('"type":"ingest.finish"');
    expect(streamed).not.toContain("appData");
    expect(streamed).not.toContain("row-7");
  });

  it("refuses appData that is not a JSON object, or is larger than MAX_APP_DATA_BYTES, before the body is read", async () => {
    const { ingest, served } = spied();
    let appData: unknown;
    const base = await serve(served, { getOwner: userOf, prepareUpload: () => ({ appData }) as PreparedUpload });
    for (const wrong of [["row-7"], "row-7", 7, true, { big: "x".repeat(MAX_APP_DATA_BYTES) }, { id: 1n }]) {
      appData = wrong;
      expect(await unfinished(base), JSON.stringify(wrong, (_key, value: unknown) => (typeof value === "bigint" ? "1n" : value)).slice(0, 40)).toEqual({ status: 500, body: JSON.stringify({ error: "Upload failed." }) });
    }
    expect(ingest).not.toHaveBeenCalled();
    // Null is none, as a database gives a field that was left out.
    appData = null;
    expect((await upload(base, "Plain.")).status).toBe(201);
    expect(ingest.mock.calls[0]![0]).not.toHaveProperty("appData");
  });
});

describe("prepareUpload's dedupe", () => {
  it("refuses a dedupe that is not true or false, and dedupe with id, before the body is read", async () => {
    const { ingest, served } = spied();
    let prepared: unknown;
    const base = await serve(served, { getOwner: userOf, prepareUpload: () => prepared as PreparedUpload });
    for (const wrong of [{ dedupe: "yes" }, { dedupe: 1 }, { id: "upload-1", dedupe: true }]) {
      prepared = wrong;
      expect(await unfinished(base), JSON.stringify(wrong)).toEqual({ status: 500, body: JSON.stringify({ error: "Upload failed." }) });
    }
    expect(ingest).not.toHaveBeenCalled();
    // false, or null, is no dedupe: with an ID too.
    prepared = { id: "upload-1", dedupe: false };
    expect((await upload(base, "Plain.")).status).toBe(201);
    prepared = { dedupe: null };
    expect((await upload(base, "Plain.")).status).toBe(201);
    for (const [input] of ingest.mock.calls) expect(input).not.toHaveProperty("dedupe");
  });

  it("gives back the document stored before for the same file with dedupe", async () => {
    const { files, ingest, served } = spied();
    const contexts: UploadedContext[] = [];
    let rowId = 0;
    const base = await serve(served, {
      getOwner: userOf,
      prepareUpload: () => ({ dedupe: true, appData: { rowId: String(++rowId) } }),
      onUploaded: (_document, context) => void contexts.push(context),
    });
    const first = (await (await upload(base, "The meeting is on Tuesday.")).json()) as { id: string; name: string; expiresAt: string };
    const again = await upload(base, "The meeting is on Tuesday.", "copy.txt");
    expect(again.status).toBe(201);
    const second = (await again.json()) as { id: string; name: string; expiresAt: string };
    // The same document, its expiry counted again from now.
    expect({ ...second, expiresAt: "" }).toEqual({ ...first, expiresAt: "" });
    expect(Date.parse(second.expiresAt)).toBeGreaterThanOrEqual(Date.parse(first.expiresAt));
    expect(ingest.mock.calls.map(([input]) => (input as IngestInput).dedupe)).toEqual([true, true]);
    expect(contexts.map((context) => context.reused)).toEqual([undefined, true]);
    expect(contexts[0]).not.toHaveProperty("reused");
    // It keeps its own name and data: the second upload's are not applied.
    expect(await files.getMeta(first.id, { owner: "alice" })).toMatchObject({ name: "notes.txt", appData: { rowId: "1" } });
    // Another file, or another owner, is stored apart.
    const other = (await (await upload(base, "The meeting is on Wednesday.")).json()) as { id: string };
    expect(other.id).not.toBe(first.id);
    expect(contexts[2]).not.toHaveProperty("reused");
    const bobs = await fetch(base, { method: "POST", headers: { "X-File-Name": "notes.txt", "X-User": "bob" }, body: "The meeting is on Tuesday." });
    expect(((await bobs.json()) as { id: string }).id).not.toBe(first.id);
  });

  it("never deletes a document dedupe gave back when onUploaded throws, on the JSON and event-stream paths", async () => {
    const { files, served } = spied();
    let refuse = false;
    const base = await serve(served, {
      getOwner: userOf,
      prepareUpload: () => ({ dedupe: true }),
      onUploaded: () => {
        if (refuse) throw Object.assign(new Error("This chat has too many files."), { status: 409 });
      },
    });
    const { id } = (await (await upload(base, "The meeting is on Tuesday.")).json()) as { id: string };
    refuse = true;
    const json = await upload(base, "The meeting is on Tuesday.");
    expect(json.status).toBe(409);
    expect(await json.json()).toEqual({ error: "This chat has too many files." });
    const streamed = await (await upload(base, "The meeting is on Tuesday.", "notes.txt", true)).text();
    expect(streamed).toContain('"type":"ingest.error"');
    expect(streamed).toContain("This chat has too many files.");
    // Stored before: still there.
    expect(await files.getMeta(id, { owner: "alice" })).toMatchObject({ id });
    // A new document with a hook that throws is deleted, as before.
    const fresh = await upload(base, "A file never uploaded before.");
    expect(fresh.status).toBe(409);
    expect(await files.list({ owner: "alice" })).toEqual([expect.objectContaining({ id })]);
  });

  it("removes the file saved to prepareUpload's path when dedupe gives back a document stored before, and does not tell its path", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "llf-dedupe-"));
    const uploads = path.join(directory, "uploads");
    await mkdir(uploads);
    const files = createLargeFiles({ store: new FileDocumentStore(path.join(directory, "store")), keepOriginals: ["text"], originals: fileOriginals(uploads) });
    const contexts: UploadedContext[] = [];
    let count = 0;
    const base = await serve(files, {
      getOwner: userOf,
      prepareUpload: () => {
        const ref = `up-${++count}`;
        return { path: path.join(uploads, ref), original: { ref }, dedupe: true };
      },
      onUploaded: (_document, context) => void contexts.push(context),
    });
    const first = (await (await upload(base, "The meeting is on Tuesday.")).json()) as { id: string };
    for (const events of [false, true]) {
      const again = await upload(base, "The meeting is on Tuesday.", "notes.txt", events);
      expect(again.status).toBe(events ? 200 : 201);
      expect(await again.text()).toContain(first.id);
    }
    // The first upload's file is its document's; the others refer to nothing, and are gone.
    expect(await readFile(path.join(uploads, "up-1"), "utf8")).toBe("The meeting is on Tuesday.");
    expect(await exists(path.join(uploads, "up-2"))).toBe(false);
    expect(await exists(path.join(uploads, "up-3"))).toBe(false);
    expect(contexts.map((context) => [context.path, context.reused])).toEqual([[path.join(uploads, "up-1"), undefined], [undefined, true], [undefined, true]]);
    expect((await files.getMeta(first.id, { owner: "alice" }))?.original).toMatchObject({ ref: "up-1" });
    expect(await files.getOriginal(first.id, { owner: "alice" })).toEqual(new TextEncoder().encode("The meeting is on Tuesday."));
  });

  it("fails an upload with dedupe over a store without list: 500 'Upload failed.', nothing stored", async () => {
    const memory = new MemoryDocumentStore();
    const bare: DocumentStore = { put: (d, c) => memory.put(d, c), get: (id, c) => memory.get(id, c), getMeta: (id, c) => memory.getMeta(id, c), delete: (id, c) => memory.delete(id, c) };
    const base = await serve(createLargeFiles({ store: bare }), { getOwner: userOf, prepareUpload: () => ({ dedupe: true }) });
    const response = await upload(base, "The meeting is on Tuesday.");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Upload failed." });
    expect(await memory.list()).toEqual([]);
  });
});
