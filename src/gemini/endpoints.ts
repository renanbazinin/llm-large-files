/**
 * Where and how to call Gemini. Use `geminiApi()` or `vertexAi()`, or pass your own URLs and
 * headers for an enterprise gateway that proxies Generate Content.
 */
export type GeminiEndpoint = {
  /** Non-streaming `...:generateContent` URL. */
  url: string;
  /** Streaming `...:streamGenerateContent?alt=sse` URL. Without it, answers arrive in one piece. */
  streamUrl?: string;
  /** Request headers, or a function returning them (for short-lived access tokens). */
  headers: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * The non-streaming `...:generateContent` URL of a second model, the explorer. `askGemini` then
   * sends it the requests that search, read and look at pages, and the model of `url` only writes
   * the answer. It is called with the same headers. `geminiApi()` and `vertexAi()` set it from
   * `explorerModel`. Unset, or the same as `url`, one model does both.
   */
  explorerUrl?: string | undefined;
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

/** The host for a Vertex AI location: global, the us/eu multi-regions, or a single region. */
export function vertexHost(location: string): string {
  if (location === "global") return "https://aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

/** Vertex AI with an OAuth access token (for example from google-auth-library). */
export function vertexAi(options: {
  project: string;
  /** The model that answers. Without `explorerModel` it also searches and reads the documents. */
  model: string;
  /** A second model that explores the documents, as in `geminiApi()`. Leave it out or empty for one model. */
  explorerModel?: string | undefined;
  /** Defaults to "global". */
  location?: string;
  /** A token, or a function that returns a fresh one for each request. */
  accessToken: string | (() => string | Promise<string>);
  /** Defaults to "v1". */
  apiVersion?: string;
}): GeminiEndpoint {
  const location = options.location ?? "global";
  const models = `${vertexHost(location)}/${options.apiVersion ?? "v1"}/projects/${encodeURIComponent(options.project)}/locations/${location}/publishers/google/models/`;
  const base = `${models}${encodeURIComponent(options.model)}`;
  const explorer = explorerOf(options);
  const token = options.accessToken;
  return {
    url: `${base}:generateContent`,
    streamUrl: `${base}:streamGenerateContent?alt=sse`,
    headers: async () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${typeof token === "function" ? await token() : token}`,
    }),
    ...(explorer ? { explorerUrl: `${models}${encodeURIComponent(explorer)}:generateContent` } : {}),
  };
}

export async function resolveHeaders(endpoint: GeminiEndpoint): Promise<Record<string, string>> {
  return typeof endpoint.headers === "function" ? endpoint.headers() : endpoint.headers;
}
