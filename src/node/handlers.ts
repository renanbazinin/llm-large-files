import type { IncomingMessage, ServerResponse } from "node:http";
import { toDocumentSummary, type LargeFiles } from "../library.js";
import { formatBytes } from "../plan.js";

export type DocumentHandlerOptions = {
  /**
   * The signed-in user for this request. When set, uploads are owned by that user and other
   * users cannot read or delete them. Return undefined to allow anonymous access.
   */
  getOwner?: (request: IncomingMessage) => string | undefined | Promise<string | undefined>;
};

export type DocumentHandlers = {
  /** POST: the body is the raw file. Name it with an `X-File-Name` header (URI-encoded) or `?name=`. */
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
    if (size > limit) {
      // Stop buffering; drain the rest so the client can read the response.
      request.resume();
      throw new HttpError(413, "");
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * Upload, get, and delete handlers for any Node HTTP server (node:http, Express, Fastify via
 * `request.raw`/`reply.raw`, Next.js API routes on the Node runtime). Responses are JSON.
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
        const bytes = await readBody(request, files.maxUploadBytes);
        const contentType = header(request, "content-type");
        const mimeType = header(request, "x-file-type") || (contentType && !contentType.startsWith("application/octet-stream") ? contentType : "");
        const currentOwner = await owner(request);
        let meta;
        try {
          meta = await files.ingest({
            name,
            bytes,
            ...(mimeType ? { mimeType } : {}),
            ...(currentOwner !== undefined ? { owner: currentOwner } : {}),
          });
        } catch (error) {
          throw new HttpError(422, error instanceof Error ? error.message : String(error));
        }
        send(response, 201, toDocumentSummary(meta));
      } catch (error) {
        if (error instanceof HttpError) send(response, error.status, { error: error.status === 413 ? tooLarge : error.message });
        else send(response, 500, { error: error instanceof Error ? error.message : "Upload failed." });
      }
    },

    async get(request, response, id) {
      const currentOwner = await owner(request);
      const meta = await files.getMeta(id, currentOwner !== undefined ? { owner: currentOwner } : {});
      if (meta) send(response, 200, toDocumentSummary(meta));
      else send(response, 404, { error: "This file is no longer available." });
    },

    async remove(request, response, id) {
      const currentOwner = await owner(request);
      send(response, 200, { deleted: await files.delete(id, currentOwner !== undefined ? { owner: currentOwner } : {}) });
    },
  };
}
