import { describe, expect, it } from "vitest";
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

async function events(pieces: Array<string | Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of parseSseJson(streamOf(pieces))) out.push(event);
  return out;
}

describe("parseSseJson", () => {
  it("reads events that arrive cut in the middle of a line, of a line ending, and of a character", async () => {
    const whole = encoder.encode("data: {\"text\":\"שלום 😀\"}\r\n\r\n");
    expect(await events([
      "data: {\"n\":1}\r\n\r\ndata: {\"n\"",
      ":2}\r",
      "\n\r",
      "\n",
      // Cut inside the four bytes of the emoji.
      whole.subarray(0, whole.length - 8),
      whole.subarray(whole.length - 8),
    ])).toEqual([{ n: 1 }, { n: 2 }, { text: "שלום 😀" }]);
  });

  it("takes line endings of either kind, joins the data lines of one event, and skips what is not data", async () => {
    expect(await events([
      ": a comment\nevent: message\ndata: {\"a\":\ndata: 1}\n\n",
      "data: [DONE]\n\n",
      "data:{\"b\":2}\n\n",
    ])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reads a last event that no blank line follows", async () => {
    expect(await events(["data: {\"n\":1}\n\ndata: {\"n\":2}"])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("fails on an event that is not JSON, rather than passing over it", async () => {
    await expect(events(["data: {\"n\":1}\n\n", "data: {oops\n\n"])).rejects.toThrow(SyntaxError);
  });
});
