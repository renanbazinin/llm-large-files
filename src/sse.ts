import { bodyPieces } from "./http.js";

/** What a stream reader can be told of as the stream goes: see `parseSseJson`. */
export type SseHooks = {
  /** Bytes arrived: an event, part of one, or a keep-alive comment. */
  onData?: () => void;
  /** The stream said it is done (`data: [DONE]`), as OpenAI-compatible servers do at the end. */
  onDone?: () => void;
  /** When it aborts, the next piece is not waited for: the stream ends with its reason. */
  signal?: AbortSignal | undefined;
  /**
   * The most characters one event may hold: what its data lines hold after `data:` and the spaces
   * after it, and the line feeds that join them. A line of another field (a comment, `event:`)
   * counts in full with the event, as it is held until its end. A longer event ends the stream with
   * an error named `SseEventTooLongError`, rather than fill the memory of the server, however the
   * stream is cut into pieces. Defaults to 64,000,000. `Infinity` sets no limit; a value that is not
   * a positive number counts as not set.
   */
  maxEventLength?: number;
};

/** The most characters one event holds, by default: see `SseHooks.maxEventLength`. */
const DEFAULT_MAX_EVENT_LENGTH = 64_000_000;
/** The data lines of an event are joined this many at a time as they come (see `parseSseJson`). */
const JOIN_LINES = 1_024;

/** An event of a stream held more characters than `SseHooks.maxEventLength`, and was not read. */
export class SseEventTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`An event of the stream held more than ${limit.toLocaleString("en-US")} characters.`);
    this.name = "SseEventTooLongError";
  }
}

/**
 * The message of a reply whose stream had an event too long to read. It is not sent again: the same
 * event would most likely come back. `who` is "Gemini's", "Claude's"…
 */
export function eventTooLongMessage(who: string, error: SseEventTooLongError): string {
  return `${who} reply could not be read: an event of its stream held more than ${error.limit.toLocaleString("en-US")} characters.`;
}

/**
 * Parses a `text/event-stream` body into JSON objects, one per `data:` event. The body is a web
 * stream (the global `fetch`), or a Node stream (node-fetch and the like). Lines end with LF, CRLF
 * or CR alone, as the format allows. Each piece of the body is read once, however long the event
 * it belongs to: a line that has not ended waits for the next piece.
 */
export async function* parseSseJson<T>(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>, hooks: SseHooks = {}): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  const most = typeof hooks.maxEventLength === "number" && hooks.maxEventLength > 0 ? hooks.maxEventLength : DEFAULT_MAX_EVENT_LENGTH;
  /** The data lines of the event being read, since the last ones were joined into `joined`. */
  let data: string[] = [];
  /**
   * Earlier data lines of the event, joined `JOIN_LINES` at a time: an event of millions of empty
   * data lines would otherwise hold a slot for each, far more memory than the characters counted.
   */
  let joined: string[] = [];
  /** The characters of the event those lines make. */
  let held = 0;
  /** The start of a line whose end has not arrived. */
  let partial = "";
  /**
   * Whether that line is a data line, and if so whether its value has begun after `data:` and the
   * spaces after it. Undefined while what has come of it may still be the start of `data:`.
   */
  let partialKind: "field" | "value" | "other" | undefined;
  /** The characters of the event that line holds, as `held` counts them. */
  let partialHeld = 0;
  /** The last piece ended with CR: a LF that starts the next one belongs to that line end. */
  let afterCr = false;
  const lineEnd = /\r\n?|\n/g;
  /** The event of the data lines read so far, which a blank line ends. */
  const event = (): T | undefined => {
    if (data.length > 0) joined.push(data.join("\n"));
    const text = joined.join("\n");
    data = [];
    joined = [];
    held = 0;
    if (text === "[DONE]") hooks.onDone?.();
    return text && text !== "[DONE]" ? JSON.parse(text) as T : undefined;
  };
  const take = (line: string): T | undefined => {
    if (!line) return event();
    if (line.startsWith("data:")) {
      const value = line.slice(5).trimStart();
      // The line feed that joins it to the line before counts too: empty data lines add up.
      held += value.length + (data.length > 0 || joined.length > 0 ? 1 : 0);
      if (held > most) throw new SseEventTooLongError(most);
      data.push(value);
      if (data.length >= JOIN_LINES) {
        joined.push(data.join("\n"));
        data = [];
      }
    } else if (held + line.length > most) {
      // Another line is not kept, but it was held until its end: it counts as it did then.
      throw new SseEventTooLongError(most);
    }
    return undefined;
  };
  /**
   * Adds the rest of a piece to the line whose end has not arrived, and counts it as `take` will
   * count the whole line. Only the rest is looked at, not what came of the line before.
   */
  const hold = (rest: string): void => {
    let at = 0;
    if (partialKind === undefined) {
      const start = partial + rest.slice(0, 5 - partial.length);
      at = start.length - partial.length;
      if (start === "data:") {
        partialKind = "field";
        partialHeld = data.length > 0 || joined.length > 0 ? 1 : 0;
      } else if (!"data:".startsWith(start)) {
        partialKind = "other";
        partialHeld = partial.length;
        at = 0;
      }
    }
    /** What is kept of the rest: all of it, but for the white space between `data:` and the value. */
    let kept = rest;
    if (partialKind === "field") {
      const value = rest.slice(at).search(/\S/);
      if (value >= 0) partialKind = "value";
      const begins = value >= 0 ? at + value : rest.length;
      // The white space after `data:` is not counted, as `take` drops it, so it is not kept either:
      // a line of nothing else, cut into pieces, would grow without end under any limit.
      kept = rest.slice(0, at) + rest.slice(begins);
      at = begins;
    }
    // What counts starts at `at`: at the end of the rest while the line may still be a data line,
    // or while the value of one has not begun.
    partialHeld += rest.length - at;
    partial += kept;
    if (held + partialHeld > most) throw new SseEventTooLongError(most);
  };
  // The events that end in this text, one at a time: a line that does not end in it waits for more.
  function* lines(text: string): Generator<T> {
    if (!text) return;
    let from = afterCr && text.startsWith("\n") ? 1 : 0;
    afterCr = false;
    lineEnd.lastIndex = from;
    for (let found = lineEnd.exec(text); found; found = lineEnd.exec(text)) {
      const line = partial + text.slice(from, found.index);
      partial = "";
      partialKind = undefined;
      partialHeld = 0;
      from = lineEnd.lastIndex;
      if (found[0] === "\r" && from === text.length) afterCr = true;
      const parsed = take(line);
      if (parsed !== undefined) yield parsed;
      lineEnd.lastIndex = from;
    }
    hold(text.slice(from));
  }
  for await (const value of bodyPieces(stream, hooks.signal)) {
    if (value.length > 0) hooks.onData?.();
    yield* lines(decoder.decode(value, { stream: true }));
  }
  yield* lines(decoder.decode());
  // A last line, and a last event, that the stream ended without a line end or a blank line after.
  if (partial.trim()) take(partial.trim());
  partial = "";
  const last = event();
  if (last !== undefined) yield last;
}
