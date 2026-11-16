import { bodyPieces } from "./http.js";

/** What a stream reader can be told of as the stream goes: see `parseSseJson`. */
export type SseHooks = {
  /** Bytes arrived: an event, part of one, or a keep-alive comment. */
  onData?: () => void;
  /** The stream said it is done (`data: [DONE]`), as OpenAI-compatible servers do at the end. */
  onDone?: () => void;
  /** When it aborts, the next piece is not waited for: the stream ends with its reason. */
  signal?: AbortSignal | undefined;
};

/**
 * Parses a `text/event-stream` body into JSON objects, one per `data:` event. The body is a web
 * stream (the global `fetch`), or a Node stream (node-fetch and the like).
 */
export async function* parseSseJson<T>(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>, hooks: SseHooks = {}): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): T | undefined => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "[DONE]") hooks.onDone?.();
    return data && data !== "[DONE]" ? JSON.parse(data) as T : undefined;
  };
  // Events whole in the buffer, one at a time: what follows the last blank line waits for more.
  function* events(): Generator<T> {
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event !== undefined) yield event;
      boundary = buffer.indexOf("\n\n");
    }
  }
  for await (const value of bodyPieces(stream, hooks.signal)) {
    if (value.length > 0) hooks.onData?.();
    buffer += decoder.decode(value, { stream: true });
    yield* events();
  }
  buffer += decoder.decode();
  yield* events();
  const last = buffer.trim() ? parse(buffer.trim()) : undefined;
  if (last !== undefined) yield last;
}
