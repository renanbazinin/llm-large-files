import type { IncomingMessage, ServerResponse } from "node:http";
import { isStoreWriteFailure } from "../errors.js";
import { eventStream, newRunId, type EventError, type IngestEvent } from "../events.js";
import { checkOwner, toDocumentSummary, type IngestInput, type LargeFiles } from "../library.js";
import { formatBytes } from "../plan.js";
import type { DocumentMeta } from "../types.js";
import { writeSseEvents } from "./sse.js";

export type DocumentHandlerOptions = {
  /**
   * The signed-in user for this request. When set, uploads are owned by that user and other
   * users cannot read or delete them. Return undefined to allow anonymous access. An empty owner
   * ("", spaces only, or null from JavaScript) is the server's mistake: the upload is answered with a 500
   * `{"error":"Upload failed (empty owner)."}`, before its body is read. So is an owner from
   * JavaScript that is neither a string nor a finite number (`req.user` in place of `req.user.id`,
   * say): `{"error":"Upload failed (owner is not a string)."}`.
   *
   * To refuse a request, throw an error with a `status` (or `statusCode`) between 400 and 599, as
   * the `http-errors` package makes: the handler answers with that status and the error's message.
   * Any other error is answered with a 500 that does not repeat its message. It is called before
   * the upload is read, so a refused upload is not buffered.
   */
  getOwner?: (request: IncomingMessage) => string | undefined | Promise<string | undefined>;
};

/**
 * The handlers answer every request themselves, errors included, and never reject: they can be
 * called without a `catch`, from `node:http`, from Express 4 (which does not catch a rejected
 * promise) or from Express 5.
 */
export type DocumentHandlers = {
  /**
   * POST: the body is the raw file. Name it with an `X-File-Name` header (URI-encoded) or `?name=`.
   * A file that cannot be read is answered with a 422 and the reason. A store that fails while it
   * writes is answered with a 500 that does not repeat its message, unless its error has a status.
   *
   * When the request's `Accept` header names `text/event-stream` (not with `q=0`, nor only through a
   * wildcard), a file that passes the checks of the name, the owner and the size (which still
   * answer with an HTTP error) is answered with a 200 and Server-Sent Events: the ingest's events (`ingest.start`, `ingest.progress`…), ending
   * with `ingest.finish`, whose data is the summary a 201 would hold, or `ingest.error`, whose data
   * is `{ error: { message, status } }` with the message and status a JSON answer would have.
   */
  upload(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** GET: the document's summary, or 404. */
  get(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
  /** DELETE: removes the document. Responds `{ deleted: boolean }`. */
  remove(request: IncomingMessage, response: ServerResponse, id: string): Promise<void>;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The HTTP status an error carries: this module's, or one `getOwner` throws (`http-errors` style). */
function statusOf(error: unknown): number | undefined {
  if (error instanceof HttpError) return error.status;
  if (!(error instanceof Error)) return undefined;
  const { status, statusCode } = error as Error & { status?: unknown; statusCode?: unknown };
  const value = typeof status === "number" ? status : statusCode;
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

/**
 * The code of a Node system error (a file or network call that failed, as `ENOSPC`). Its message
 * names server paths or hosts, so only the code is passed on.
 */
function systemErrorCode(error: unknown): string | undefined {
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
  return typeof code === "string" && typeof syscall === "string" ? code : undefined;
}

/**
 * The answer to a failed request. An error with a status keeps its status and message. Anything
 * else is the server's trouble: a 500 that says what failed and, for a system error, its code.
 */
function answerOf(error: unknown, failed: string, tooLarge: string): { status: number; message: string } {
  const status = statusOf(error);
  if (status !== undefined) {
    return { status, message: status === 413 ? tooLarge : error instanceof Error && error.message ? error.message : `${failed}.` };
  }
  const code = systemErrorCode(error);
  return { status: 500, message: code ? `${failed} (${code}).` : `${failed}.` };
}

/** Answers a failed request with JSON (see `answerOf`). */
function fail(response: ServerResponse, error: unknown, failed: string, tooLarge: string): void {
  const { status, message } = answerOf(error, failed, tooLarge);
  send(response, status, { error: message });
}

/**
 * An error of `ingest` as the upload answers it. A file that cannot be read is the client's 422,
 * with the reason. An error with a status keeps it, and a system error is the server's 500 with its
 * code. A store that failed in another way is the server's 500 too, without its message: that is
 * the store's own, and may name a database host. So is a value that is not an Error, whoever threw it.
 */
function ingestFailure(error: unknown): unknown {
  if (statusOf(error) !== undefined || systemErrorCode(error) !== undefined) return error;
  if (isStoreWriteFailure(error) || !(error instanceof Error)) return error;
  return new HttpError(422, error.message);
}

/**
 * Whether the client asked for the upload's progress as Server-Sent Events: its `Accept` header
 * names `text/event-stream` itself, without `q=0`. A wildcard (`text/*`, or any type at all) keeps
 * the JSON answer.
 */
function wantsEvents(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return (Array.isArray(accept) ? accept.join(",") : accept ?? "").split(",").some((range) => {
    const [type, ...parameters] = range.split(";").map((part) => part.trim().toLowerCase());
    if (type !== "text/event-stream") return false;
    const q = parameters.map((parameter) => parameter.split("=").map((part) => part.trim())).find(([name]) => name === "q");
    return q === undefined || Number(q[1]) > 0;
  });
}

/**
 * Ingests the upload and answers with its events as Server-Sent Events. The last one is always
 * `ingest.finish` or `ingest.error`, even with a `LargeFiles` of your own whose `ingest` sends no events.
 */
async function streamIngest(files: LargeFiles, input: IngestInput, response: ServerResponse, tooLarge: string): Promise<void> {
  const runId = newRunId("ing");
  const stream = eventStream<IngestEvent, DocumentMeta>(
    (onEvent, signal) => files.ingest({ ...input, runId, onEvent, signal }),
    { signal: input.signal },
  );
  // The error as a JSON answer would give it: the event's own may hold a store's message.
  const answer = async (fallback: EventError): Promise<EventError> => {
    try {
      await stream.result;
      return { message: fallback.message, ...(fallback.status !== undefined ? { status: fallback.status } : {}) };
    } catch (error) {
      return answerOf(ingestFailure(error), "Upload failed", tooLarge);
    }
  };
  async function* events(): AsyncGenerator<IngestEvent> {
    let seq = 0;
    for await (const event of stream) {
      seq = event.seq;
      if (event.type === "ingest.error") {
        yield { ...event, error: await answer(event.error) };
        return;
      }
      yield event;
      if (event.type === "ingest.finish") return;
    }
    // The ingest ended without a last event: a `LargeFiles` of your own whose ingest sends none.
    const base = { seq: seq + 1, runId, time: Date.now() };
    try {
      yield { ...base, type: "ingest.finish", document: toDocumentSummary(await stream.result) };
    } catch {
      yield { ...base, type: "ingest.error", error: await answer({ message: "Upload failed." }) };
    }
  }
  // Each message is the event itself, as for a question: `ingest.finish` holds the summary a 201
  // answer would (`document`), `ingest.error` the message and status a JSON answer would (`error`).
  await writeSseEvents(response, events());
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function header(request: IncomingMessage, name: string): string {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Reads the raw body, or uses one a framework already parsed into a Buffer (e.g. express.raw()). */
async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed instanceof Uint8Array) {
    if (parsed.byteLength > limit) throw new HttpError(413, "");
    return parsed;
  }
  if (parsed !== undefined && typeof parsed === "object" && parsed !== null && Object.keys(parsed).length) {
    throw new HttpError(400, "The upload body was already parsed by another middleware. Mount the upload route before body parsers, or send Content-Type: application/octet-stream.");
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    // Past the limit the rest is not read: leaving the loop ends the request stream. The answer
    // then closes the connection (see `upload`), so the client is not left sending into it.
    if (size > limit) throw new HttpError(413, "");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * Upload, get, and delete handlers for any Node HTTP server (node:http, Express, Fastify via
 * `request.raw`/`reply.raw`, Next.js API routes on the Node runtime). Responses are JSON, except an upload that asks for
 * `text/event-stream`: it is answered with its ingest events.
 */
export function createDocumentHandlers(files: LargeFiles, options: DocumentHandlerOptions = {}): DocumentHandlers {
  const tooLarge = `The file is larger than the ${formatBytes(files.maxUploadBytes)} upload limit.`;
  const owner = async (request: IncomingMessage) => options.getOwner?.(request);

  return {
    async upload(request, response) {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const name = header(request, "x-file-name").trim() || url.searchParams.get("name")?.trim() || "";
        if (!name) throw new HttpError(400, "Name the file with an X-File-Name header or a ?name= query parameter.");
        // Who is asking comes first: a refused upload is not read into memory. An owner that
        // `ingest` would refuse ("", or an object such as `req.user` from JavaScript) is the server's
        // mistake, answered with a 500 before the body is read. Its message says which, so that the
        // operator knows where to look; it says nothing else.
        const currentOwner = await owner(request);
        try {
          checkOwner(currentOwner);
        } catch {
          const empty = typeof currentOwner === "string" || currentOwner === null;
          throw new HttpError(500, empty ? "Upload failed (empty owner)." : "Upload failed (owner is not a string).");
        }
        const bytes = await readBody(request, files.maxUploadBytes);
        const contentType = header(request, "content-type");
        const mimeType = header(request, "x-file-type") || (contentType && !contentType.startsWith("application/octet-stream") ? contentType : "");
        // A client that goes away before the answer stops the reading of its file: nobody would
        // get the document, and the server has other work.
        const gone = new AbortController();
        const onClose = () => {
          if (!response.writableFinished) gone.abort(new Error("The upload was cancelled: the client closed the connection."));
        };
        response.once("close", onClose);
        const input: IngestInput = {
          name,
          bytes,
          ...(mimeType ? { mimeType } : {}),
          ...(currentOwner !== undefined ? { owner: currentOwner } : {}),
          signal: gone.signal,
        };
        let meta;
        try {
          if (wantsEvents(request)) return await streamIngest(files, input, response, tooLarge);
          meta = await files.ingest(input);
        } catch (error) {
          throw ingestFailure(error);
        } finally {
          response.off("close", onClose);
        }
        send(response, 201, toDocumentSummary(meta));
      } catch (error) {
        // Answered before the body was read to its end (too large, no name): the rest of it is
        // not read, so the connection is closed after the answer. Kept open, it would hold a
        // client that is still sending, and its next request would be read as part of this body.
        if (!request.complete && !response.headersSent) response.setHeader("Connection", "close");
        fail(response, error, "Upload failed", tooLarge);
        // An event stream that failed after its headers were sent cannot answer with a status.
        if (response.headersSent && !response.writableEnded) response.end();
      }
    },

    async get(request, response, id) {
      try {
        const currentOwner = await owner(request);
        const meta = await files.getMeta(id, currentOwner !== undefined ? { owner: currentOwner } : {});
        if (meta) send(response, 200, toDocumentSummary(meta));
        else send(response, 404, { error: "This file is no longer available." });
      } catch (error) {
        fail(response, error, "The file could not be looked up", tooLarge);
      }
    },

    async remove(request, response, id) {
      try {
        const currentOwner = await owner(request);
        send(response, 200, { deleted: await files.delete(id, currentOwner !== undefined ? { owner: currentOwner } : {}) });
      } catch (error) {
        fail(response, error, "The file could not be deleted", tooLarge);
      }
    },
  };
}
