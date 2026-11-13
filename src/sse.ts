/** Parses a `text/event-stream` body into JSON objects, one per `data:` event. */
export async function* parseSseJson<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): T | undefined => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data && data !== "[DONE]" ? JSON.parse(data) as T : undefined;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event !== undefined) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const last = buffer.trim() ? parse(buffer.trim()) : undefined;
    if (last !== undefined) yield last;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
