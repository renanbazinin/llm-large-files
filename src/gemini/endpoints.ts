import { resolveHeaderSource, type HeaderContext, type HeaderSource } from "../http.js";

/**
 * Where and how to call Gemini. Use `geminiApi()` or `vertexAi()`, or pass your own URLs and
 * headers for an enterprise gateway that proxies Generate Content.
 */
export type GeminiEndpoint = {
  /** Non-streaming `...:generateContent` URL. */
  url: string;
  /** Streaming `...:streamGenerateContent?alt=sse` URL. Without it, answers arrive in one piece. */
  streamUrl?: string;
  /**
   * Request headers, or a function returning them (for short-lived access tokens). Since 0.10.0 the
   * function is called with `{ refresh: true }` when a request is sent again after a 401 (see
   * `refreshable`); one of no arguments still fits. Since 0.99.13 a function that throws fails the
   * request with a `GeminiRequestError` of status 0, its error as the cause: a connection that
   * failed on the way (a metadata server that reset) is of kind "unreachable" and is sent again;
   * anything else (a revoked grant) is of kind "auth" and is not.
   */
  headers: HeaderSource;
  /**
   * The non-streaming `...:generateContent` URL of a second model, the explorer. `askGemini` then
   * sends it the requests that search, read and look at pages, and the model of `url` only writes
   * the answer. It is called with the same headers. `geminiApi()` and `vertexAi()` set it from
   * `explorerModel`. Unset, or the same as `url`, one model does both.
   */
  explorerUrl?: string | undefined;
  /**
   * True when `headers` can give a token that is new, not the one it keeps in a cache: a request
   * refused with HTTP 401 is then sent once more, with the headers of `headers({ refresh: true })`.
   * A second 401 is the error. `vertexAi()` sets it when `accessToken` is a function. New in 0.10.0.
   * Since 0.99.13 the refresh is told as a `retry` event of reason "auth_refresh"; a refresh that
   * fails on a connection is sent again from the start, and one that fails otherwise leaves the
   * 401 as the error, with why as its cause.
   */
  refreshable?: true | undefined;
};

/**
 * The model that explores the documents, when one is named and it is not the answering model
 * itself. An empty name is no name, so a setting that was left empty can be passed as it is.
 */
function explorerOf(options: { model: string; explorerModel?: string | undefined }): string | undefined {
  const name = options.explorerModel?.trim();
  return name && name !== options.model ? name : undefined;
}

/** The Gemini Developer API with an API key. */
export function geminiApi(options: {
  apiKey: string;
  /** The model that answers. Without `explorerModel` it also searches and reads the documents. */
  model: string;
  /**
   * A second model that explores the documents: it makes the tool calls (search, read, look at
   * pages) and reads a whole file in parts, and `model` then writes the answer from what it found.
   * Leave it out or empty to have `model` do both.
   */
  explorerModel?: string | undefined;
  /** Defaults to "v1beta". */
  apiVersion?: string;
  /** Defaults to https://generativelanguage.googleapis.com. */
  baseUrl?: string;
}): GeminiEndpoint {
  const models = `${(options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "")}/${options.apiVersion ?? "v1beta"}/models/`;
  const base = `${models}${encodeURIComponent(options.model)}`;
  const explorer = explorerOf(options);
  return {
    url: `${base}:generateContent`,
    streamUrl: `${base}:streamGenerateContent?alt=sse`,
    headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
    ...(explorer ? { explorerUrl: `${models}${encodeURIComponent(explorer)}:generateContent` } : {}),
  };
}

/** A Vertex AI location: "global", "us", "eu", or a region such as "europe-west4". */
const LOCATION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The host for a Vertex AI location: global, the us/eu multi-regions, or a single region. A location
 * that is not one (with "/", "?", "#" or "@" it would name another host, which would get the access
 * token) throws a TypeError.
 */
export function vertexHost(location: string): string {
  if (typeof location !== "string" || !LOCATION.test(location)) {
    throw new TypeError(`location must be a Vertex AI location such as "global", "us" or "europe-west4", and is ${JSON.stringify(location) ?? String(location)}.`);
  }
  if (location === "global") return "https://aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

/** An https origin: a host name of letters, digits, dots and dashes, with a port or none, and nothing after it. */
const ORIGIN = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?\/?$/;

/**
 * The origin of `host`, which must be an https origin and nothing more. A path, a query, a
 * fragment or an "@" would send the requests, and the token or key with them, somewhere else than
 * the host it seems to name: it throws a TypeError, as a location that is not one does.
 */
function originOf(host: string): string {
  if (typeof host !== "string" || !ORIGIN.test(host)) {
    throw new TypeError(`host must be an https origin such as "https://europe-west4-aiplatform.googleapis.com", with no path, query or "@", and is ${JSON.stringify(host) ?? String(host)}.`);
  }
  return new URL(host).origin;
}

/** What the two forms of `vertexAi()` take alike. */
type VertexAiCommon = {
  /** The model that answers. Without `explorerModel` it also searches and reads the documents. */
  model: string;
  /** A second model that explores the documents, as in `geminiApi()`. Leave it out or empty for one model. */
  explorerModel?: string | undefined;
  /**
   * More headers, merged after the library's (a name you give replaces the library's). A function
   * is called for each request, with the same context as the endpoint's `headers`. New in 0.10.0.
   */
  headers?: HeaderSource | undefined;
  /**
   * The https origin to send the requests to, in place of the host of the location: a Private
   * Service Connect endpoint, or a proxy that keeps Vertex AI's paths. An origin only
   * ("https://host" or "https://host:port"); anything else throws a TypeError. New in 0.10.0.
   */
  host?: string | undefined;
  /** Defaults to "v1". */
  apiVersion?: string;
};

/**
 * The options of `vertexAi()`: a project with an OAuth access token, or (since 0.10.0) an API key of
 * Vertex AI express mode, which names no project or location.
 */
export type VertexAiOptions =
  | (VertexAiCommon & {
      project: string;
      /** Defaults to "global". */
      location?: string;
      /**
       * A token, or a function that returns one for each request. The function is called with
       * `{ refresh: true }` when the token it gave was refused (HTTP 401): return a new one then,
       * not the one kept in a cache. A function of no arguments still fits. Since 0.99.13 a
       * function that throws on a connection that failed (a metadata server that reset) is called
       * again, as a request that got no answer; one that throws otherwise (a revoked grant) ends
       * the request as an "auth" error, told "The model refused the key or token it was sent.".
       */
      accessToken: string | ((context: { refresh: boolean }) => string | Promise<string>);
      apiKey?: never;
    })
  | (VertexAiCommon & {
      /** The API key of Vertex AI express mode, sent as the `x-goog-api-key` header. */
      apiKey: string;
      project?: never;
      location?: never;
      accessToken?: never;
    });

/**
 * Vertex AI with an OAuth access token (for example from google-auth-library), or with an API key
 * of express mode (since 0.10.0).
 */
export function vertexAi(options: VertexAiOptions): GeminiEndpoint {
  const express = typeof options.apiKey === "string";
  const location = express ? undefined : options.location ?? "global";
  const host = options.host !== undefined ? originOf(options.host) : vertexHost(location ?? "global");
  const where = express ? "" : `projects/${encodeURIComponent(options.project!)}/locations/${encodeURIComponent(location!)}/`;
  const models = `${host}/${options.apiVersion ?? "v1"}/${where}publishers/google/models/`;
  const base = `${models}${encodeURIComponent(options.model)}`;
  const explorer = explorerOf(options);
  const token = options.accessToken;
  const own = options.headers;
  return {
    url: `${base}:generateContent`,
    streamUrl: `${base}:streamGenerateContent?alt=sse`,
    headers: async (context?: HeaderContext) => ({
      "Content-Type": "application/json",
      ...(express
        ? { "x-goog-api-key": options.apiKey! }
        : { Authorization: `Bearer ${typeof token === "function" ? await token({ refresh: context?.refresh === true }) : token}` }),
      ...await resolveHeaderSource(own, context),
    }),
    ...(explorer ? { explorerUrl: `${models}${encodeURIComponent(explorer)}:generateContent` } : {}),
    ...(typeof token === "function" ? { refreshable: true as const } : {}),
  };
}

/** The headers of an endpoint: `context` goes to a function of headers when it is given (a refresh after a 401). */
export async function resolveHeaders(endpoint: Pick<GeminiEndpoint, "headers">, context?: HeaderContext): Promise<Record<string, string>> {
  return resolveHeaderSource(endpoint.headers, context);
}
