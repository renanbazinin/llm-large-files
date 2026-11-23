import { describe, expect, it } from "vitest";
import { SseEventTooLongError as FromMain, type SseHooks } from "llm-large-files";
import { parseSseJson, SseEventTooLongError } from "llm-large-files/gemini";

const encoder = new TextEncoder();

/** The promise, or a failure when it has not settled within the wait: a test that hangs fails at once. */
async function settles<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Still waiting after ${ms} ms.`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

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

  it("takes a CR alone for a line end, as the format allows, also at the end of a piece", async () => {
    expect(await events(["data: {\"a\":1}\r\rdata: {\"a\":2}\r\r"])).toEqual([{ a: 1 }, { a: 2 }]);
    // A CR that ends a piece, then the next line: and a CR that ends a piece, then its LF.
    expect(await events(["data: {\"a\":1}\r", "\rdata: {\"a\":", "\r", "data: 2}\r", "\n\r", "\n: comment\r", "data: [DONE]\r\r"])).toEqual([{ a: 1 }, { a: 2 }]);
    // A CRLF cut between its CR and its LF inside an event is one line end, not a blank line.
    expect(await events(["data: {\"a\":\r", "\ndata: 1}\r\n\r\n"])).toEqual([{ a: 1 }]);
    // Line ends of all three kinds in one stream.
    expect(await events(["data: {\"a\":1}\n\r\ndata: {\"b\":\r\ndata: 2}\r\r", "data: {\"c\":3}"])).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("ends the stream on an event longer than maxEventLength, rather than hold it all", async () => {
    const tooLong = { name: "SseEventTooLongError", message: "An event of the stream held more than 100 characters." };
    // One line whose end never comes.
    await expect(events(["data: {\"t\":\"", "x".repeat(60), "x".repeat(60)], { maxEventLength: 100 })).rejects.toMatchObject(tooLong);
    // An event of thousands of data lines, joined as they come, reads as one.
    const many = ["data: [", ...Array.from({ length: 2_999 }, () => "data: 1,"), "data: 1]", "", ""].join("\n");
    expect(await events([many.slice(0, 7_000), many.slice(7_000)])).toEqual([Array.from({ length: 3_000 }, () => 1)]);
    // The error can be told by its class, from either entry, and carries the limit.
    const thrown = await events(["data: {\"t\":\"", "x".repeat(200)], { maxEventLength: 100 }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(SseEventTooLongError);
    expect(thrown).toBeInstanceOf(FromMain);
    expect((thrown as SseEventTooLongError).limit).toBe(100);
    // Lines that each end, with no blank line to end the event.
    await expect(events(Array.from({ length: 30 }, () => "data: \"xxxxx\"\n"), { maxEventLength: 100 })).rejects.toMatchObject(tooLong);
    // Data lines that are empty add up too: each is a line feed of the event.
    await expect(events(["data:\n".repeat(200)], { maxEventLength: 100 })).rejects.toMatchObject(tooLong);
    // Lines that are not data are not kept, however many.
    expect(await events([": keep-alive\n".repeat(200), "data: {\"n\":1}\n\n"], { maxEventLength: 100 })).toEqual([{ n: 1 }]);
  });

  it("counts each event on its own, and reads one at the limit", async () => {
    // Its JSON is 100 characters.
    const event = `data: {"t":"${"x".repeat(92)}"}\n\n`;
    expect(await events([event, event, event], { maxEventLength: 100 })).toHaveLength(3);
    // Two data lines and the line feed between them: 49 + 1 + 50.
    expect(await events([`data: {"t":"${"x".repeat(41)}",\ndata: "u":"${"y".repeat(43)}"}\n\n`], { maxEventLength: 100 })).toHaveLength(1);
  });

  it("reads an event at maxEventLength, and ends on one past it, wherever the pieces are cut", async () => {
    /** Events whose data is `length` characters: on one line, after more spaces, on two lines, after other fields. */
    const shapes = (length: number) => [
      `data: {"t":"${"x".repeat(length - 8)}"}\n\n`,
      `data:      {"t":"${"x".repeat(length - 8)}"}\r\n\r\n`,
      `data: {"t":"${"x".repeat(40)}",\ndata: "u":"${"y".repeat(length - 56)}"}\n\n`,
      `: ping\nevent: delta\nid: 7\ndata: {"t":"${"x".repeat(length - 8)}"}\n\n`,
    ];
    /** The event cut in two at every place, and in pieces of one character. */
    const cuts = (event: string) => [...Array.from({ length: event.length + 1 }, (_, at) => [event.slice(0, at), event.slice(at)]), [...event]];
    for (const event of shapes(100)) {
      for (const pieces of cuts(event)) expect(await events(pieces, { maxEventLength: 100 }), JSON.stringify(pieces)).toHaveLength(1);
    }
    for (const event of shapes(101)) {
      for (const pieces of cuts(event)) {
        await expect(events(pieces, { maxEventLength: 100 }), JSON.stringify(pieces)).rejects.toMatchObject({ name: "SseEventTooLongError" });
      }
    }
    // A line of another field that is longer is held until its end too: it ends the stream, however it comes.
    for (const pieces of cuts(`id: ${"x".repeat(200)}\ndata: 1\n\n`)) {
      await expect(events(pieces, { maxEventLength: 100 }), JSON.stringify(pieces)).rejects.toMatchObject({ name: "SseEventTooLongError" });
    }
  });

  it("takes a maxEventLength that is not a positive number for the default, and Infinity for no limit", async () => {
    /** A comment of 65,011,714 characters, then an event: its pieces are made as they are read. */
    const long = () => {
      const megabyte = new Uint8Array(1_048_576).fill(0x78);
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) controller.enqueue(encoder.encode(": "));
          else if (sent <= 62) controller.enqueue(megabyte);
          else {
            controller.enqueue(encoder.encode("\ndata: 1\n\n"));
            controller.close();
          }
          sent++;
        },
      }, { highWaterMark: 0 });
    };
    const read = async (maxEventLength: number) => {
      const out: unknown[] = [];
      for await (const event of parseSseJson(long(), { maxEventLength })) out.push(event);
      return out;
    };
    for (const maxEventLength of [0, -1, Number.NaN]) {
      await expect(read(maxEventLength), String(maxEventLength)).rejects.toMatchObject({ name: "SseEventTooLongError", message: "An event of the stream held more than 64,000,000 characters." });
    }
    expect(await read(Number.POSITIVE_INFINITY)).toEqual([1]);
  });
});

describe("parseSseJson over a reader of the app's", () => {
  /** A body with a `getReader` of its own, whose `cancel()` does as given. */
  const readerOf = (cancel: () => unknown) => ({
    getReader() {
      const pieces = [encoder.encode("data: {\"a\":1}\n\ndata: {\"a\":2}\n\n")];
      return {
        read: async () => (pieces.length > 0 ? { done: false, value: pieces.shift() } : { done: true, value: undefined }),
        cancel,
        releaseLock: () => undefined,
      };
    },
  }) as unknown as ReadableStream<Uint8Array>;

  it("is not failed by a cancel() that gives no promise, or throws at once", async () => {
    for (const cancel of [() => undefined, () => { throw new Error("cancel() threw"); }]) {
      const out: unknown[] = [];
      for await (const event of parseSseJson(readerOf(cancel))) out.push(event);
      expect(out).toEqual([{ a: 1 }, { a: 2 }]);
      // A caller that stops after the first event.
      for await (const event of parseSseJson(readerOf(cancel))) {
        expect(event).toEqual({ a: 1 });
        break;
      }
    }
  });
});

describe("parseSseJson over an iterable of the app's whose return() never settles", () => {
  /** These pieces, then a read that waits for ever (or the end, when `open` is false). `return()` does as `ends` says. */
  function stuck(pieces: string[], ends: "never" | "plain" | "throws" = "never", open = true): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]() {
        let at = 0;
        return {
          next: async () => {
            if (at < pieces.length) return { done: false, value: encoder.encode(pieces[at++]!) };
            return open ? new Promise<never>(() => undefined) : { done: true, value: undefined };
          },
          return: (() => {
            if (ends === "plain") return { done: true, value: undefined };
            if (ends === "throws") throw new Error("return() threw");
            return new Promise<never>(() => undefined);
          }) as () => Promise<IteratorResult<Uint8Array>>,
        };
      },
    };
  }
  const read = async (body: AsyncIterable<Uint8Array>, stopAtFirst = false) => {
    const out: unknown[] = [];
    for await (const event of parseSseJson(body)) {
      out.push(event);
      if (stopAtFirst) break;
    }
    return out;
  };

  it("still fails on an event that is not JSON", async () => {
    await expect(settles(read(stuck(["data: {oops\n\n"])))).rejects.toThrow(SyntaxError);
  });

  it("lets the caller stop after an event, and ends with a stream that ended", async () => {
    expect(await settles(read(stuck(["data: {\"a\":1}\n\n"]), true))).toEqual([{ a: 1 }]);
    expect(await settles(read(stuck(["data: {\"a\":1}\n\n"], "never", false)))).toEqual([{ a: 1 }]);
    // A return() that gives no promise, or throws at once, is no error of the caller's.
    expect(await settles(read(stuck(["data: {\"a\":1}\n\n"], "plain"), true))).toEqual([{ a: 1 }]);
    expect(await settles(read(stuck(["data: {\"a\":1}\n\n"], "throws"), true))).toEqual([{ a: 1 }]);
  });
});
