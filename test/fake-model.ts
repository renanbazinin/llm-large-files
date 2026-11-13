import type { GenerateText, ModelAdapter, ModelCapabilities, ModelReply, ModelRequest, SendHooks, ToolCall } from "llm-large-files";

export type Scripted = Partial<ModelReply> | Error | ((request: ModelRequest, call: number, hooks: SendHooks) => Partial<ModelReply> | Error | Promise<Partial<ModelReply> | Error>);

export type FakeModel = ModelAdapter & {
  /** Every request `send` was called with, in order: failed attempts too. */
  requests: ModelRequest[];
};

/** A reply of text. */
export const says = (text: string, more: Partial<ModelReply> = {}): Partial<ModelReply> => ({ text, ...more });
/** A reply of tool calls, with the turn in a "provider's own form" so that tests can tell who gets it back. */
export const calls = (list: ToolCall[], more: Partial<ModelReply> = {}): Partial<ModelReply> => ({ calls: list, raw: { own: list.map((call) => call.name) }, ...more });

/**
 * A model that answers each request from a script. The last entry repeats. An entry that is an
 * Error is thrown. Text is passed to `onText` in two pieces when the loop listens.
 */
export function fakeModel(script: Scripted[], options: Partial<ModelCapabilities> & { id?: string; generateText?: GenerateText } = {}): FakeModel {
  const { id = "fake-model", generateText, ...capabilities } = options;
  const requests: ModelRequest[] = [];
  return {
    id,
    capabilities: { toolFiles: "inside", pageTokens: 500, ...capabilities },
    requests,
    ...(generateText ? { generateText } : {}),
    async send(request, hooks = {}) {
      // What was sent, as it was at that moment: the loop goes on changing its own list.
      requests.push({ ...request, messages: [...request.messages] });
      const entry = script[Math.min(requests.length - 1, script.length - 1)]!;
      const reply = typeof entry === "function" ? await entry(request, requests.length, hooks) : entry;
      if (reply instanceof Error) throw reply;
      const text = reply.text ?? "";
      if (text && hooks.onText) {
        const half = Math.ceil(text.length / 2);
        hooks.onText(text.slice(0, half));
        if (text.length > half) hooks.onText(text.slice(half));
      }
      return { text, calls: [], ...reply };
    },
  };
}

/** An error as an adapter throws it for an HTTP status. */
export function httpError(status: number, message = `HTTP ${status}`, retryAfterMs?: number): Error {
  return Object.assign(new Error(message), { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
}

/** A service log of the size the review measured: about 110 characters a line. */
export function serviceLog(lines: number): string {
  const out: string[] = [];
  for (let n = 1; n <= lines; n++) {
    const level = n % 97 === 0 ? "ERROR" : n % 13 === 0 ? "WARN" : "INFO";
    const time = new Date(Date.UTC(2026, 10, 12, 8, 0, 0) + n * 250).toISOString();
    out.push(`${time} ${level} [worker-${n % 8}] req=${(n * 2654435761 >>> 0).toString(16).padStart(8, "0")} GET /api/v2/orders/${n % 5000} took ${(n * 37) % 900}ms`);
  }
  return out.join("\n");
}

export const utf8 = (text: string) => new TextEncoder().encode(text);
