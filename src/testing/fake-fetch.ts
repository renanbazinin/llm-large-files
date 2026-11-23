/** A JSON body, read loosely: a test reaches into it without a cast. */
type Json = Record<string, any>;

/** A request as the adapter sent it: the URL, the headers as given, and the body parsed as JSON. */
export type Sent = { url: string; method: string; headers: Record<string, string>; body: Json };

/** One entry of a `fakeFetch` script: a reply, or a function that makes one from the request. */
export type FakeReply = Response | ((sent: Sent, call: number) => Response | Promise<Response>);

export type FakeFetch = {
  /** The `fetch` to give an adapter (its `fetch` option). */
  fetch: typeof globalThis.fetch;
  /** Every request, in order: requests sent again too. */
  readonly sent: Sent[];
};

/**
 * A `fetch` for the real adapters that answers from a script, without the network: each request
 * gets the next reply, and the last one repeats. A `Response` is answered with a copy, since a body
 * can be read only once. Every request is recorded in `sent`. As a real `fetch` does, it rejects with
 * the reason of the request's `signal` once that aborts, also while a reply made by a function waits.
 */
export function fakeFetch(replies: FakeReply[]): FakeFetch {
  if (replies.length === 0) throw new TypeError("fakeFetch needs at least one reply.");
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const given = typeof input === "object" && !(input instanceof URL) ? input : undefined;
    const signal = init?.signal ?? given?.signal ?? undefined;
    signal?.throwIfAborted();
    const request: Sent = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? given?.method ?? "GET",
      // A Request carries its own headers and body when `init` does not.
      headers: init?.headers !== undefined || !given ? headersOf(init?.headers) : Object.fromEntries(given.headers),
      body: init?.body !== undefined || !given ? bodyOf(init?.body) : bodyOf(await given.clone().text()),
    };
    sent.push(request);
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    const answer = Promise.resolve(typeof reply === "function" ? reply(request, sent.length) : reply.clone());
    if (!signal) return answer;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([answer, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort!);
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

/**
 * A streamed reply: Server-Sent Events, one `data:` line for each event, each object as JSON. A
 * string is sent as it is (`"[DONE]"`).
 */
export const sse = (events: unknown[]): Response => new Response(
  events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
  { headers: { "Content-Type": "text/event-stream" } },
);

/** The headers as the adapter wrote them: a plain object keeps its names, a `Headers` has them in lower case. */
function headersOf(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers || Array.isArray(headers)) return Object.fromEntries(new Headers(headers));
  return { ...(headers as Record<string, string>) };
}

/** The body parsed as JSON, or `{}` when there is none or it is not JSON text. */
function bodyOf(body: RequestInit["body"]): Json {
  if (typeof body !== "string") return {};
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" ? (value as Json) : {};
  } catch {
    return {};
  }
}
