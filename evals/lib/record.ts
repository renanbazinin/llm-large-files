// Record and replay, for the evals. Internal to evals/ in 0.10.0: the public API in
// llm-large-files/testing comes in 0.10.x, once the evals have used this for a release.
//
// A cassette is a folder. Recording writes one file for each request, `<n>-<hash>.json`: the
// request as a hash of its normalized bytes, with a short outline of its fields for finding what
// changed, and the response (its status, a few headers, and its body, or the chunks of a stream as
// they arrived). No request body is kept: the text of the documents stays out of the files.
//
// Normalized: the `key` parameter leaves the URL, the value of every other parameter but `alt` and
// `api-version` is redacted (api_key, access_token, sig…), so are the user and password of a URL,
// `projects/<id>/` becomes `projects/<project>/`, and the tool-call IDs an adapter makes itself
// (`call_<24 hex>`, `toolu_<24 hex>`) become placeholders in the order they appear. Request headers
// are written from an allow-list: content-type, accept, anthropic-version and anthropic-beta keep
// their values, every other header (authorization, x-goog-api-key, x-goog-user-project, a gateway's
// key…) is written as redacted. So no key, token or project ID is written.
//
// Replay answers each request from the file whose hash it has, in the order they were recorded
// for requests of the same hash, or strictly in order. A request with no file throws
// CassetteMissError, which names the first field that differs from the request expected there.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AskEvent, GenerateText, GenerateUsage, ModelAdapter, ModelCapabilities, ModelReply, ModelRequest, ModelUsage, SendHooks } from "../../src/index.js";

/** A request as it is written: what a `redact` function gets and gives back. */
export type RecordedRequest = {
  method: string;
  /** Without the `key` parameter, other parameters but `alt` and `api-version` redacted, with `projects/<project>/`. */
  url: string;
  /** Names in lower case; the values of all but a few redacted. */
  headers: Record<string, string>;
  /** The body parsed as JSON (or its text, when it is not JSON), tool-call IDs normalized. Not written: its hash and outline are. */
  body: unknown;
};

/** A piece of a body as it arrived: its text, or its bytes when the piece ends inside a character. */
export type Chunk = string | { base64: string };

/** A response as a cassette keeps it. */
export type RecordedResponse =
  | { status: number; statusText?: string; headers: Record<string, string>; json?: unknown; text?: string; base64?: string; chunks?: Chunk[] }
  | { error: { name: string; message: string } };

/** One file of a cassette. */
export type CassetteEntry = {
  n: number;
  request: { method: string; url: string; headers: Record<string, string>; hash: string; bytes: number; outline: Outline };
  response: RecordedResponse;
};

/** The fields of a body down to a few levels, each long text or deeper part as its length and a hash. */
export type Outline = null | boolean | number | string | Outline[] | { [key: string]: Outline };

/** Written in place of a secret. */
export const REDACTED = "<redacted>";

/** Request headers whose values are written: none of them can carry a key, a token or an account. */
const KEPT_REQUEST_HEADERS = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta"]);

/** URL parameters whose values are written. Every other value is redacted, and `key` is left out. */
const KEPT_PARAMETERS = new Set(["alt", "api-version"]);

/** Response headers worth keeping: those an adapter reads. */
const KEPT_HEADERS = ["content-type", "retry-after", "retry-after-ms", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"];

/** Tool-call IDs that the OpenAI-compatible and Claude adapters make when a model sends none. */
const MADE_ID = /^(call|toolu)_[0-9a-f]{24}$/;

/** How deep the outline of a body goes: Gemini's contents[i].parts[j].functionCall.name is at 6. */
const OUTLINE_DEPTH = 6;

/** A replay that found no recording for a request: the prompt, or what the library sends, changed. */
export class CassetteMissError extends Error {
  /** The first field of the request that differs from the one recorded at its place ("systemInstruction.parts[0].text"), or "request" when the recording has no more. */
  readonly field: string;
  /** The cassette: its folder's name, or the label it was given. */
  readonly cassette: string;
  /** Which request of the cassette, from 1. */
  readonly request: number;

  constructor(cassette: string, request: number, field: string, detail: string) {
    super(`prompt changed: re-record. Case "${cassette}", request ${request}: ${detail} Record the cassettes again (npm run eval:record, see CONTRIBUTING.md).`);
    this.name = "CassetteMissError";
    this.field = field;
    this.cassette = cassette;
    this.request = request;
  }
}

// Normalizing.

const parameterName = (name: string) => {
  try {
    return decodeURIComponent(name).toLowerCase();
  } catch {
    return name.toLowerCase();
  }
};

/**
 * The URL without its `key` parameter, the values of its other parameters redacted (but `alt` and
 * `api-version`), without a user and password, and with the project of a Vertex AI path replaced.
 */
export function normalizeUrl(url: string): string {
  let out = url.replace(/([?&])key=[^&#\s]*&?/gi, (_match, separator: string) => separator).replace(/[?&](?=#|$|\s)/, "");
  out = out.replace(/([?&])([^=&#\s?]+)=([^&#\s]*)/g, (match, separator: string, name: string) => (KEPT_PARAMETERS.has(parameterName(name)) ? match : `${separator}${name}=${REDACTED}`));
  out = out.replace(/\b([a-z][\w+.-]*:\/\/)[^/@?#\s]+@/gi, `$1${REDACTED}@`);
  out = out.replace(/\/projects\/[^/?#]+\//g, "/projects/<project>/");
  return out;
}

/** The headers with lower-case names, every value redacted but those of a few headers that hold no secret. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = KEPT_REQUEST_HEADERS.has(name.toLowerCase()) || value === REDACTED ? value : REDACTED;
  return out;
}

/** A copy of a parsed body with the tool-call IDs an adapter made replaced by `call_<1>`, `toolu_<2>`…, in order of appearance. */
export function normalizeBody(body: unknown): unknown {
  const seen = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!MADE_ID.test(value)) return value;
      let placeholder = seen.get(value);
      if (!placeholder) seen.set(value, (placeholder = `${value.slice(0, value.indexOf("_"))}_<${seen.size + 1}>`));
      return placeholder;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return walk(body);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const short = (text: string) => sha256(text).slice(0, 8);

/** A normalized body as the text it is hashed by. */
const bodyText = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body) ?? "");

/** The text a request is hashed by: its method, normalized URL and normalized body. */
const hashText = (method: string, url: string, body: unknown) => `${method} ${url}\n${bodyText(body)}`;

/** The hash of a normalized request, as cassette files are named and matched by. */
export function requestHash(request: Pick<RecordedRequest, "method" | "url" | "body">): string {
  return sha256(hashText(request.method, request.url, request.body)).slice(0, 16);
}

/** A string short and plain enough to keep as it is: a role, a tool name, a setting. */
const PLAIN = /^[\w.:/@ -]{0,24}$/;

/** The outline of a body: its fields down to `OUTLINE_DEPTH`, each long text or deeper part as its length and a hash. */
export function outlineOf(value: unknown, depth = 0): Outline {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return PLAIN.test(value) ? value : `${value.length} chars #${short(value)}`;
  if (Array.isArray(value)) {
    return depth >= OUTLINE_DEPTH ? `[${value.length} items] #${short(JSON.stringify(value))}` : value.map((item) => outlineOf(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (depth >= OUTLINE_DEPTH) return `{${entries.length} keys} #${short(JSON.stringify(value))}`;
    return Object.fromEntries(entries.map(([key, item]) => [key, outlineOf(item, depth + 1)]));
  }
  return String(value);
}

const isRecord = (value: unknown): value is Record<string, Outline> => value !== null && typeof value === "object" && !Array.isArray(value);
const said = (value: Outline | undefined) => (value === undefined ? "nothing" : typeof value === "string" ? value : JSON.stringify(value).slice(0, 80));

/** The first field where two outlines differ, as a path ("contents[2].parts[0].text"), with what each holds there. */
export function firstDifference(recorded: Outline | undefined, actual: Outline | undefined, at = ""): { field: string; was: string; now: string } | undefined {
  if (JSON.stringify(recorded) === JSON.stringify(actual)) return undefined;
  if (Array.isArray(recorded) && Array.isArray(actual)) {
    for (let index = 0; index < Math.max(recorded.length, actual.length); index++) {
      const found = firstDifference(recorded[index], actual[index], `${at}[${index}]`);
      if (found) return found;
    }
  }
  if (isRecord(recorded) && isRecord(actual)) {
    for (const key of [...new Set([...Object.keys(actual), ...Object.keys(recorded)])]) {
      const found = firstDifference(recorded[key], actual[key], at ? `${at}.${key}` : key);
      if (found) return found;
    }
    // The same fields in another order.
    return { field: at || "body", was: `fields ${Object.keys(recorded).join(", ")}`, now: `fields ${Object.keys(actual).join(", ")}` };
  }
  return { field: at || "body", was: said(recorded), now: said(actual) };
}

// Reading a request and a response.

/** The method, URL, headers and body text of a fetch call. */
async function requestOf(input: string | URL | Request, init?: RequestInit): Promise<{ method: string; url: string; headers: Record<string, string>; text: string }> {
  const given = typeof input === "object" && !(input instanceof URL) ? input : undefined;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? given?.method ?? "GET";
  const headers = init?.headers !== undefined || !given ? Object.fromEntries(new Headers(init?.headers)) : Object.fromEntries(given.headers);
  const body = init?.body ?? (given ? await given.clone().text() : undefined);
  return { method, url, headers, text: typeof body === "string" ? body : body === undefined || body === null ? "" : String(body) };
}

/** A request normalized for its hash and its file, from what fetch was called with. */
export async function recordedRequestOf(input: string | URL | Request, init?: RequestInit): Promise<RecordedRequest> {
  const { method, url, headers, text } = await requestOf(input, init);
  let body: unknown = text;
  try {
    body = text === "" ? "" : JSON.parse(text);
  } catch {
    // Not JSON: hashed as its text.
  }
  return { method, url: normalizeUrl(url), headers: redactHeaders(headers), body: typeof body === "string" ? body : normalizeBody(body) };
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A piece of a body as text, or as base64 when it is not whole UTF-8 (it ends inside a character). */
function chunkOf(bytes: Uint8Array): Chunk {
  try {
    return strict.decode(bytes);
  } catch {
    return { base64: Buffer.from(bytes).toString("base64") };
  }
}

const bytesOf = (chunk: Chunk): Uint8Array => (typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(Buffer.from(chunk.base64, "base64")));

/** Reads a whole body, piece by piece as it arrives. */
async function piecesOf(response: Response): Promise<Uint8Array[]> {
  if (!response.body) return [];
  const pieces: Uint8Array[] = [];
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return pieces;
    if (value.byteLength > 0) pieces.push(value);
  }
}

/** A response as a cassette keeps it: a stream as its pieces, a JSON body parsed, other text as text. */
async function recordedResponseOf(response: Response): Promise<{ recorded: RecordedResponse; pieces: Uint8Array[] }> {
  const pieces = await piecesOf(response);
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const base = { status: response.status, ...(response.statusText ? { statusText: response.statusText } : {}), headers };
  if (/event-stream/i.test(headers["content-type"] ?? "")) return { recorded: { ...base, chunks: pieces.map(chunkOf) }, pieces };
  const whole = Buffer.concat(pieces);
  const text = chunkOf(whole);
  if (typeof text !== "string") return { recorded: { ...base, base64: text.base64 }, pieces };
  try {
    return { recorded: { ...base, json: JSON.parse(text) as unknown }, pieces };
  } catch {
    return { recorded: { ...base, text }, pieces };
  }
}

/** A body that gives its pieces one at a time, as they arrived, and fails when `signal` aborts. */
function streamOf(pieces: Uint8Array[], signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  let next = 0;
  let stop: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!signal) return;
      stop = () => controller.error(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
    },
    pull(controller) {
      if (next < pieces.length) controller.enqueue(pieces[next++]!);
      if (next >= pieces.length) {
        if (stop) signal?.removeEventListener("abort", stop);
        controller.close();
      }
    },
    cancel() {
      if (stop) signal?.removeEventListener("abort", stop);
    },
  });
}

/** A Response from a recorded one. */
function responseOf(recorded: Exclude<RecordedResponse, { error: unknown }>, signal?: AbortSignal | null): Response {
  const init = { status: recorded.status, ...(recorded.statusText ? { statusText: recorded.statusText } : {}), headers: recorded.headers };
  // Statuses that have no body.
  if ([101, 204, 205, 304].includes(recorded.status)) return new Response(null, init);
  if (recorded.chunks) return new Response(streamOf(recorded.chunks.map(bytesOf), signal), init);
  const body = recorded.json !== undefined ? JSON.stringify(recorded.json) : recorded.text ?? (recorded.base64 !== undefined ? Buffer.from(recorded.base64, "base64") : "");
  return new Response(body, init);
}

const fileName = (n: number, hash: string) => `${String(n).padStart(3, "0")}-${hash}.json`;
const FILE = /^(\d+)-([0-9a-f]+)\.json$/;

/** The entries of a cassette folder, in the order they were recorded. */
export function readCassette(directory: string): CassetteEntry[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => FILE.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as CassetteEntry)
    .sort((left, right) => left.n - right.n);
}

const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);

// Fetch.

export type RecordingFetchOptions = {
  /** The fetch that reaches the provider. Defaults to the global one. */
  fetch?: typeof fetch;
  /**
   * More redaction, after the default: it changes what is written (headers, URL, the outline), never
   * the hash, which comes from the normalized request.
   */
  redact?: (request: RecordedRequest) => RecordedRequest;
};

/**
 * A fetch that sends each request on and writes it, with its response, to `directory` as
 * `<n>-<hash>.json`. It reads the whole response before it hands it on, piece by piece as it
 * arrived. A request that fails to connect is written as its error, and thrown again.
 */
export function recordingFetch(directory: string, options: RecordingFetchOptions = {}): typeof fetch {
  const upstream = options.fetch ?? globalThis.fetch;
  let count = 0;
  mkdirSync(directory, { recursive: true });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const n = ++count;
    const normalized = await recordedRequestOf(input, init);
    const hash = requestHash(normalized);
    const kept = options.redact ? options.redact(normalized) : normalized;
    const request = { method: kept.method, url: normalizeUrl(kept.url), headers: redactHeaders(kept.headers), hash, bytes: Buffer.byteLength(bodyText(normalized.body)), outline: outlineOf(kept.body) };
    let response: Response;
    try {
      response = await upstream(input, init);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      writeJson(path.join(directory, fileName(n, hash)), { n, request, response: { error: { name: failure.name, message: normalizeUrl(failure.message) } } } satisfies CassetteEntry);
      throw error;
    }
    const { recorded, pieces } = await recordedResponseOf(response);
    writeJson(path.join(directory, fileName(n, hash)), { n, request, response: recorded } satisfies CassetteEntry);
    const headers = new Headers(response.headers);
    for (const name of ["content-encoding", "content-length", "transfer-encoding"]) headers.delete(name);
    return new Response([101, 204, 205, 304].includes(response.status) ? null : streamOf(pieces, init?.signal), { status: response.status, statusText: response.statusText, headers });
  }) as typeof fetch;
}

export type ReplayOptions = {
  /** "hash" (the default): each request takes a recording with its hash, in recorded order. "order": the next recording, which must have its hash. */
  match?: "hash" | "order";
  /** The name errors give the cassette. Defaults to the folder's name. */
  label?: string;
};

/** What a replay can say after a run: the misses it threw, and the recordings no request took. */
export type ReplayReport = {
  readonly misses: CassetteMissError[];
  /** The numbers of the recordings no request took. */
  unused(): number[];
};

/** Picks the recording for a request, or throws CassetteMissError. Shared by fetch and model replays. */
function matcher<T extends { n: number; request: { hash: string; outline: Outline; method?: string; url?: string } }>(entries: T[], label: string, match: "hash" | "order") {
  const used = new Set<number>();
  const misses: CassetteMissError[] = [];
  let requests = 0;
  /** `where`: the method and normalized URL of a fetch request, compared before the body. */
  const take = (hash: string, outline: Outline, sameKind: (entry: T) => boolean, nearest?: (entry: T) => boolean, where?: { method: string; url: string }): T => {
    const n = ++requests;
    const open = entries.filter((entry) => !used.has(entry.n) && sameKind(entry));
    const found = match === "hash" ? open.find((entry) => entry.request.hash === hash) : open[0]?.request.hash === hash ? open[0] : undefined;
    if (found) {
      used.add(found.n);
      return found;
    }
    const expected = match === "hash" ? open.find(nearest ?? (() => true)) ?? open[0] : open[0];
    let miss: CassetteMissError;
    if (!expected) {
      miss = new CassetteMissError(label, n, "request", `the recording has no request left (it holds ${entries.filter(sameKind).length}).`);
    } else {
      const difference =
        (where && expected.request.method !== undefined && expected.request.method !== where.method ? { field: "method", was: expected.request.method, now: where.method } : undefined)
        ?? (where && expected.request.url !== undefined && expected.request.url !== where.url ? { field: "url", was: expected.request.url, now: where.url } : undefined)
        ?? firstDifference(expected.request.outline, outline)
        ?? { field: "body", was: `hash ${expected.request.hash}`, now: `hash ${hash}` };
      miss = new CassetteMissError(label, n, difference.field, `${difference.field} differs from recording ${expected.n} (was ${difference.was}, now ${difference.now}).`);
    }
    misses.push(miss);
    throw miss;
  };
  return { take, misses, unused: () => entries.filter((entry) => !used.has(entry.n)).map((entry) => entry.n) };
}

/**
 * A fetch that answers from the cassette in `directory`, without the network. A request that has no
 * recording throws CassetteMissError (kept in `misses` too, since an adapter may wrap what fetch
 * throws). A recorded stream comes in the pieces it arrived in.
 */
export function replayFetch(directory: string, options: ReplayOptions = {}): typeof fetch & ReplayReport {
  const label = options.label ?? path.basename(directory);
  const entries = readCassette(directory);
  const { take, misses, unused } = matcher(entries, label, options.match ?? "hash");
  const replay = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (typeof input === "object" && !(input instanceof URL) ? input.signal : undefined);
    signal?.throwIfAborted();
    const request = await recordedRequestOf(input, init);
    const entry = take(requestHash(request), outlineOf(request.body), () => true, (one) => one.request.url === request.url && one.request.method === request.method, { method: request.method, url: request.url });
    if ("error" in entry.response) throw Object.assign(new Error(entry.response.error.message), { name: entry.response.error.name });
    return responseOf(entry.response, signal);
  };
  return Object.assign(replay as typeof fetch, { misses, unused });
}

// Models.

/** What a model cassette keeps of the adapter: planning depends on it. */
export type RecordedModel = { id: string; capabilities: ModelCapabilities; generateText: boolean };

/** One call of a model cassette. */
export type ModelEntry = {
  n: number;
  kind: "send" | "generateText";
  request: { hash: string; outline: Outline };
  /** What came back: for send, the text as it was streamed and the reply; for generateText, the text, whether it was cut, and the usage it told. */
  reply?: { deltas?: string[]; reply?: ModelReply; text?: string; truncated?: boolean; usage?: GenerateUsage[] };
  error?: { name: string; message: string; status?: number; kind?: string; retryAfterMs?: number; code?: string };
};

const MODEL_FILE = "model.json";

/** An error as a cassette keeps it: its name, message, and the fields the loop reads. */
function errorOf(error: unknown): NonNullable<ModelEntry["error"]> {
  const failure = (error instanceof Error ? error : new Error(String(error))) as Error & { status?: unknown; kind?: unknown; retryAfterMs?: unknown; code?: unknown };
  return {
    name: failure.name,
    message: failure.message,
    ...(typeof failure.status === "number" ? { status: failure.status } : {}),
    ...(typeof failure.kind === "string" ? { kind: failure.kind } : {}),
    ...(typeof failure.retryAfterMs === "number" ? { retryAfterMs: failure.retryAfterMs } : {}),
    ...(typeof failure.code === "string" ? { code: failure.code } : {}),
  };
}

const errorFrom = (kept: NonNullable<ModelEntry["error"]>) => {
  const { name, message, ...fields } = kept;
  return Object.assign(new Error(message), { name }, fields);
};

/** The request of a part read, without its hooks. */
type ReadRequest = Parameters<GenerateText>[0];
const readBody = (request: ReadRequest) => ({ system: request.system, prompt: request.prompt, maxOutputTokens: request.maxOutputTokens });

/**
 * A model adapter that passes each call to `adapter` and writes it to `directory`: `model.json` with
 * the adapter's id, its capabilities and whether it has generateText (planning depends on them), and
 * `<n>-<hash>.json` for each send and part read, with the request's hash and outline and the reply.
 */
export function recordingModel(adapter: ModelAdapter, directory: string): ModelAdapter {
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, MODEL_FILE), { id: adapter.id, capabilities: adapter.capabilities, generateText: Boolean(adapter.generateText) } satisfies RecordedModel);
  let count = 0;
  const write = (entry: ModelEntry) => writeJson(path.join(directory, fileName(entry.n, entry.request.hash)), entry);
  const keyed = (kind: ModelEntry["kind"], body: unknown) => {
    const normalized = normalizeBody(body);
    return { hash: requestHash({ method: kind, url: adapter.id, body: normalized }), outline: outlineOf(normalized) };
  };
  const generate = adapter.generateText;
  return {
    ...adapter,
    id: adapter.id,
    capabilities: adapter.capabilities,
    async send(request: ModelRequest, hooks: SendHooks = {}) {
      const n = ++count;
      const key = keyed("send", JSON.parse(JSON.stringify(request)));
      const deltas: string[] = [];
      try {
        const reply = await adapter.send(request, { ...hooks, ...(hooks.onText ? { onText: (delta: string) => { deltas.push(delta); hooks.onText!(delta); } } : {}) });
        write({ n, kind: "send", request: key, reply: { deltas, reply: JSON.parse(JSON.stringify(reply)) as ModelReply } });
        return reply;
      } catch (error) {
        write({ n, kind: "send", request: key, error: errorOf(error) });
        throw error;
      }
    },
    ...(generate ? {
      generateText: async (request: ReadRequest) => {
        const n = ++count;
        const key = keyed("generateText", readBody(request));
        let truncated = false;
        const usage: GenerateUsage[] = [];
        try {
          const text = await generate({
            ...request,
            onTruncated: () => { truncated = true; request.onTruncated?.(); },
            onUsage: (told) => { usage.push(told); request.onUsage?.(told); },
          });
          write({ n, kind: "generateText", request: key, reply: { text, ...(truncated ? { truncated } : {}), ...(usage.length ? { usage } : {}) } });
          return text;
        } catch (error) {
          write({ n, kind: "generateText", request: key, error: errorOf(error) });
          throw error;
        }
      },
    } : {}),
  };
}

/**
 * A model adapter that answers from the cassette in `directory`: the recorded id, capabilities and
 * generateText, and each reply, its streamed text given to `onText` again. A call with no recording
 * throws CassetteMissError (kept in `misses` too).
 */
export function replayModel(directory: string, options: ReplayOptions = {}): ModelAdapter & ReplayReport {
  const label = options.label ?? path.basename(directory);
  const model = JSON.parse(readFileSync(path.join(directory, MODEL_FILE), "utf8")) as RecordedModel;
  const entries = readdirSync(directory)
    .filter((name) => FILE.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")) as ModelEntry)
    .sort((left, right) => left.n - right.n);
  const { take, misses, unused } = matcher(entries, label, options.match ?? "hash");
  const keyed = (kind: ModelEntry["kind"], body: unknown) => {
    const normalized = normalizeBody(body);
    return { hash: requestHash({ method: kind, url: model.id, body: normalized }), outline: outlineOf(normalized) };
  };
  const adapter: ModelAdapter = {
    id: model.id,
    capabilities: model.capabilities,
    async send(request, hooks = {}) {
      hooks.signal?.throwIfAborted();
      const key = keyed("send", JSON.parse(JSON.stringify(request)));
      const entry = take(key.hash, key.outline, (one) => one.kind === "send");
      if (entry.error) throw errorFrom(entry.error);
      for (const delta of entry.reply?.deltas ?? []) hooks.onText?.(delta);
      return entry.reply!.reply!;
    },
    ...(model.generateText ? {
      generateText: async (request: ReadRequest) => {
        request.signal?.throwIfAborted();
        const key = keyed("generateText", readBody(request));
        const entry = take(key.hash, key.outline, (one) => one.kind === "generateText");
        if (entry.error) throw errorFrom(entry.error);
        if (entry.reply?.truncated) request.onTruncated?.();
        for (const told of entry.reply?.usage ?? []) request.onUsage?.(told);
        return entry.reply?.text ?? "";
      },
    } : {}),
  };
  return Object.assign(adapter, { misses, unused });
}

// Events.

/** A request of a question as its events told it: start and end. */
export type RequestRecord = {
  requestId: string;
  role: string;
  purpose: string;
  model: string;
  turn?: number;
  detail?: string;
  callId?: string;
  estimatedInputTokens?: number;
  /** From its start to its end, retries included. */
  ms?: number;
  outcome?: "ok" | "error";
  usage?: Partial<ModelUsage>;
  finish?: string;
  finishReason?: string;
  toolCalls?: number;
  error?: string;
};

/**
 * A listener for `onEvent` that keeps the requests of a question, the notices and the tool calls.
 * Its events are normalized: the run ID becomes "<run>" and each time 0, so two runs compare.
 */
export function runRecorder(): {
  listener: (event: AskEvent) => void;
  requests(): RequestRecord[];
  events(): AskEvent[];
  notices(): string[];
  tools(): Array<{ tool: string; outcome?: string }>;
} {
  const events: AskEvent[] = [];
  const requests = new Map<string, RequestRecord>();
  const tools = new Map<string, { tool: string; outcome?: string }>();
  return {
    listener(event) {
      events.push({ ...event, runId: "<run>", time: 0 } as AskEvent);
      if (event.type === "request.start") {
        requests.set(event.requestId, {
          requestId: event.requestId, role: event.role, purpose: event.purpose, model: event.model,
          ...(event.turn !== undefined ? { turn: event.turn } : {}),
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          ...(event.callId !== undefined ? { callId: event.callId } : {}),
          ...(event.estimatedInputTokens !== undefined ? { estimatedInputTokens: event.estimatedInputTokens } : {}),
        });
      } else if (event.type === "request.end") {
        const record = requests.get(event.requestId);
        if (!record) return;
        Object.assign(record, {
          ms: event.ms, outcome: event.outcome,
          ...(event.usage ? { usage: event.usage } : {}),
          ...(event.finish !== undefined ? { finish: event.finish } : {}),
          ...(event.finishReason !== undefined ? { finishReason: event.finishReason } : {}),
          ...(event.toolCalls !== undefined ? { toolCalls: event.toolCalls } : {}),
          ...(event.error ? { error: event.error.message } : {}),
        });
      } else if (event.type === "tool.start") {
        tools.set(event.callId, { tool: event.tool });
      } else if (event.type === "tool.end") {
        const call = tools.get(event.callId);
        if (call) call.outcome = event.outcome;
      }
    },
    requests: () => [...requests.values()].map((record) => ({ ...record })),
    events: () => [...events],
    notices: () => events.flatMap((event) => (event.type === "notice" ? [event.code] : [])),
    tools: () => [...tools.values()].map((call) => ({ ...call })),
  };
}
