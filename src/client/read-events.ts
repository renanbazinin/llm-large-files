// The messages of a Server-Sent Events stream read with `fetch`, for a page: what `writeSseEvents`
// and the upload handlers send. Browser-safe: Web APIs only (fetch's Response, TextDecoderStream).
// New in 0.99.14 (until then a sample in the web-app guide).

/** `readEvents`'s options. New in 0.99.14. */
export type ReadEventsOptions = {
  /** Told of a message whose data is not JSON, which is skipped: one bad message does not stop the others. */
  onBadMessage?: (error: unknown, data: string) => void;
  /** Stops reading: the stream is cancelled, and `readEvents` ends. */
  signal?: AbortSignal;
};

/**
 * Calls `on` with the data of each message of an event stream, parsed as JSON, in order, until the
 * stream ends. `EventSource` sends only GET requests without a body, so a question asked with POST
 * is read with `fetch` and this. The `data:` lines of a message are joined with "\n"; comments
 * (": keep-alive") and messages without data are skipped, and so is a message that is not JSON
 * (`options.onBadMessage` is told). A message ends at a blank line; lines end in "\n" or "\r\n",
 * never U+2028 or U+2029, which JSON may hold. A last message the stream ends without its blank
 * line is not a whole message, and is left out. A response without a body is a TypeError.
 *
 * ```ts
 * const response = await fetch("/api/chat", { method: "POST", body: JSON.stringify({ question }) });
 * await readEvents(response, (data) => show(data as ChatEvent));
 * ```
 * New in 0.99.14.
 */
export async function readEvents(response: Response, on: (data: unknown) => void, options: ReadEventsOptions = {}): Promise<void> {
  if (!response || !response.body) throw new TypeError("readEvents needs a response with a body: the answer of fetch to a route that sends events.");
  const { onBadMessage, signal } = options;
  signal?.throwIfAborted();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const stop = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", stop, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: RegExpExecArray | null;
      while ((end = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
          .join("\n");
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch (error) {
          onBadMessage?.(error, data);
          continue;
        }
        on(parsed);
        if (signal?.aborted) return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
