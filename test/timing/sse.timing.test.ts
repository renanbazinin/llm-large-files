// The test of the event-stream reader that holds work to the clock (from test/sse.test.ts): an
// event of 24 MB in pieces of 16 KB is read in time that follows its size.
import { describe, expect, it } from "vitest";
import type { SseHooks } from "llm-large-files";
import { parseSseJson } from "llm-large-files/gemini";

const encoder = new TextEncoder();

/** A stream that delivers these pieces one read at a time, as a network does: cut anywhere. */
function streamOf(pieces: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
      controller.close();
    },
  });
}

async function events(pieces: Array<string | Uint8Array>, hooks: SseHooks = {}): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of parseSseJson(streamOf(pieces), hooks)) out.push(event);
  return out;
}

describe("parseSseJson", () => {
  it("reads each piece once, however long the event: one of 24 MB in pieces of 16 KB takes no longer than its size", async () => {
    const text = "x".repeat(24 * 1024 * 1024);
    const whole = encoder.encode(`data: {"t":"${text}"}\n\ndata: {"n":2}\n\n`);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < whole.length; at += 16 * 1024) pieces.push(whole.subarray(at, at + 16 * 1024));
    const started = performance.now();
    const read = await events(pieces);
    // Read once, it takes a few tens of milliseconds; a buffer scanned again with every piece took about 8 s.
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(read).toHaveLength(2);
    expect((read[0] as { t: string }).t.length).toBe(text.length);
  });
});
