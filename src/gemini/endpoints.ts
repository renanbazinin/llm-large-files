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
};

/** The Gemini Developer API with an API key. */
export function geminiApi(options: {
  apiKey: string;
  model: string;
  /** Defaults to "v1beta". */
  apiVersion?: string;
  /** Defaults to https://generativelanguage.googleapis.com. */
  baseUrl?: string;
}): GeminiEndpoint {
  const base = `${(options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "")}/${options.apiVersion ?? "v1beta"}/models/${encodeURIComponent(options.model)}`;
  return {
    url: `${base}:generateContent`,
    streamUrl: `${base}:streamGenerateContent?alt=sse`,
    headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
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
  model: string;
  /** Defaults to "global". */
  location?: string;
  /** A token, or a function that returns a fresh one for each request. */
  accessToken: string | (() => string | Promise<string>);
  /** Defaults to "v1". */
  apiVersion?: string;
}): GeminiEndpoint {
  const location = options.location ?? "global";
  const base = `${vertexHost(location)}/${options.apiVersion ?? "v1"}/projects/${encodeURIComponent(options.project)}/locations/${location}/publishers/google/models/${encodeURIComponent(options.model)}`;
  const token = options.accessToken;
  return {
    url: `${base}:generateContent`,
    streamUrl: `${base}:streamGenerateContent?alt=sse`,
    headers: async () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${typeof token === "function" ? await token() : token}`,
    }),
  };
}

export async function resolveHeaders(endpoint: GeminiEndpoint): Promise<Record<string, string>> {
  return typeof endpoint.headers === "function" ? endpoint.headers() : endpoint.headers;
}
