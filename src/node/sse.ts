import type { ServerResponse } from "node:http";
import type { AskEvent } from "../events.js";

/** One Server-Sent Events message: its `event:` name, its `data:` (sent as JSON), and its `id:`. */
export type SseMessage = {
  /** Defaults to the event's `type`. */
  event?: string;
  /** Any JSON value. */
  data: unknown;
  /** Defaults to the event's `seq`. */
  id?: string | number;
};

export type SseWriteOptions<E> = {
  /** Milliseconds between two `: keep-alive` comments, which keep proxies from closing a quiet stream. Defaults to 15,000; 0 sends none. */
  heartbeatMs?: number;
  /**
   * Headers to send besides the event-stream ones, or in their place: a name matches whatever its
   * case. Only used when the headers are not sent yet.
   */
  headers?: Record<string, string | number | string[]>;
  /** What to send for an event. Return undefined to skip it. Defaults to `sseMessageOf`. */
  map?: (event: E) => SseMessage | undefined;
  /** False keeps the response open after the last event. Defaults to true. */
  end?: boolean;
};

const DEFAULT_HEARTBEAT_MS = 15_000;
const GONE = Symbol("gone");
const EVENT_STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** A field of one line: a line break in an event name or id would end the field early. */
const oneLine = (value: string | number) => String(value).replace(/[\r\n]+/g, " ");

/**
 * What `writeSseEvents` sends for an event by default: the event itself, `type`, `seq`, `runId`
 * and `time` included, with two smaller than they are. `run.finish` has a `result` without
 * `toolTurns`, `plan`, `budget` and `lastUsage`: `{ answered, text, finishReason, blockReason,
 * steps, evidence, turns, usage }` (keep `toolTurns` on the server, with the conversation).
 * `run.error` has its `error` and a `partial` with only the `steps`, `evidence` and `usage` of the
 * partial result. Every other event is sent as it is.
 */
export function sseMessageOf<E extends { type: string; seq: number }>(event: E): SseMessage {
  const ask = event as unknown as AskEvent;
  if (ask.type === "run.finish") {
    const { type, seq, runId, time } = ask;
    const { answered, text, finishReason, blockReason, steps, evidence, turns, usage } = ask.result;
    return { event: type, id: seq, data: { type, seq, runId, time, result: { answered, text, finishReason, blockReason, steps, evidence, turns, usage } } };
  }
  if (ask.type === "run.error") {
    const { type, seq, runId, time, error } = ask;
    const partial = ask.partial && { steps: ask.partial.steps, evidence: ask.partial.evidence, usage: ask.partial.usage };
    return { event: type, id: seq, data: { type, seq, runId, time, error, partial } };
  }
  return { event: event.type, id: event.seq, data: event };
}

/**
 * The data of a message as JSON. U+2028 and U+2029, which JSON leaves as they are, are written
 * `\u2028` and `\u2029`: the same JSON, which a client that splits on line breaks reads whole.
 */
const jsonOf = (data: unknown) =>
  (JSON.stringify(data) ?? "null").replace(/[\u2028\u2029]/g, (char) => (char === "\u2028" ? "\\u2028" : "\\u2029"));

/** Stops the producer. Its own cleanup errors are not the caller's: the stream is over. */
function stop(iterator: AsyncIterator<unknown>): void {
  try {
    iterator.return?.()?.catch(() => undefined);
  } catch {
    // A return() that throws at once is treated the same way.
  }
}

/**
 * Sends events to a browser as Server-Sent Events, one message per event: `id: <seq>`,
 * `event: <type>`, `data: <JSON>`. Writes a 200 with the event-stream headers when no headers are
 * sent yet, waits whenever the client reads slower than events come, and ends the response after
 * the last event (unless `end: false`).
 *
 * When the client goes away first, or the response is ended by someone else, it stops reading the
 * events and calls the iterator's `return()`: for an `askStream` or another `eventStream` passed
 * in directly, that stops the run at once. An async generator that wraps one (to rename or skip
 * events) only stops when it next yields: a run waiting on a long model request goes on until
 * then. To change what is sent, use `map` (return undefined to skip an event) and pass the stream
 * itself; if you do wrap it, stop the run yourself:
 * `response.once("close", () => stream.abort())`.
 *
 * It resolves then, or when the events end. It rejects when the iterable or `map` throws, after
 * ending the response unless `end` is false (an `eventStream` never throws: a run that fails ends
 * with its error event), and when the headers cannot be written (an invalid one in `headers`), after stopping the
 * producer and destroying the response.
 */
export async function writeSseEvents<E extends { type: string; seq: number }>(
  response: ServerResponse,
  events: AsyncIterable<E>,
  options: SseWriteOptions<E> = {},
): Promise<void> {
  const map = options.map ?? sseMessageOf;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const iterator = events[Symbol.asyncIterator]();

  // Gone: the client went away, or the response was ended by someone else. Nothing more is written.
  let gone = response.destroyed || response.writableEnded;
  let onGone!: () => void;
  const goneNow = new Promise<typeof GONE>((resolve) => (onGone = () => resolve(GONE)));
  const onClose = () => {
    gone = true;
    onGone();
  };
  response.on("close", onClose);
  response.on("finish", onClose);
  const unwatch = () => {
    response.off("close", onClose);
    response.off("finish", onClose);
  };
  if (gone) onGone();

  if (!gone && !response.headersSent) {
    try {
      // setHeader replaces a header whatever the case of its name: a caller's own takes the place of ours.
      for (const [name, value] of Object.entries(EVENT_STREAM_HEADERS)) response.setHeader(name, value);
      for (const [name, value] of Object.entries(options.headers ?? {})) response.setHeader(name, value);
      response.writeHead(200);
      response.flushHeaders();
    } catch (error) {
      unwatch();
      stop(iterator);
      // No status line went out: the connection is closed rather than answered.
      response.destroy();
      throw error;
    }
  }

  let waiting = false;
  /** Until the client has read what is buffered, has gone away, or the response was ended. */
  const drained = () => new Promise<void>((resolve) => {
    waiting = true;
    const done = () => {
      waiting = false;
      response.off("drain", done);
      response.off("close", done);
      response.off("finish", done);
      resolve();
    };
    response.on("drain", done);
    response.on("close", done);
    response.on("finish", done);
  });

  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
        if (!gone && !waiting && !response.destroyed && !response.writableEnded) response.write(": keep-alive\n\n");
      }, heartbeatMs)
    : undefined;
  heartbeat?.unref();

  // Whether the iterator itself failed: it is then not asked to return.
  let iteratorFailed = false;
  let failure: { error: unknown } | undefined;
  try {
    while (!gone) {
      const next = iterator.next();
      // A read left pending when the client goes away may still fail: nobody waits for it.
      next.catch(() => undefined);
      let step: IteratorResult<E> | typeof GONE;
      try {
        step = await Promise.race([next, goneNow]);
      } catch (error) {
        iteratorFailed = true;
        throw error;
      }
      if (step === GONE || step.done) break;
      const message = map(step.value);
      if (!message) continue;
      const id = message.id ?? step.value.seq;
      const name = message.event ?? step.value.type;
      const chunk = `id: ${oneLine(id)}\nevent: ${oneLine(name)}\ndata: ${jsonOf(message.data)}\n\n`;
      // Ended meanwhile, by the client or someone else: a write after the end would throw.
      if (response.destroyed || response.writableEnded) gone = true;
      if (gone) break;
      if (!response.write(chunk)) await drained();
    }
  } catch (error) {
    failure = { error };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    unwatch();
  }

  if (gone || (failure && !iteratorFailed)) stop(iterator);
  if (!gone && !response.destroyed && !response.writableEnded && options.end !== false) response.end();
  if (failure) throw failure.error;
}
