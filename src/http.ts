// Small things every adapter needs for its HTTP requests.

/** Request headers, or a function returning them: called for each request, so a token can be renewed. */
export type HeaderSource = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export async function resolveHeaderSource(source: HeaderSource | undefined): Promise<Record<string, string>> {
  return typeof source === "function" ? source() : source ?? {};
}

/** A secret, or a function returning it: called for each request. */
export type SecretSource = string | (() => string | Promise<string>);

export async function resolveSecret(source: SecretSource | undefined): Promise<string | undefined> {
  return typeof source === "function" ? source() : source;
}

/** Base64 of bytes, worked out once for each array: the pages of a PDF are sent again with every later request. */
const encoded = new WeakMap<Uint8Array, string>();
export function base64(bytes: Uint8Array): string {
  let text = encoded.get(bytes);
  if (text === undefined) {
    text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    encoded.set(bytes, text);
  }
  return text;
}

/** The reason a request never got an answer, without the stack of the HTTP client. */
export function unreachableReason(error: unknown): string {
  return error instanceof Error && error.message ? ` (${error.message})` : "";
}

/**
 * Arguments of a tool call that arrived as JSON text, and, when the text is not a JSON object,
 * why the call cannot be run: a model that is told so sends the call again.
 */
export function readArguments(text: unknown): { args: Record<string, unknown>; problem?: string } {
  if (text && typeof text === "object" && !Array.isArray(text)) return { args: text as Record<string, unknown> };
  if (typeof text !== "string" || !text.trim()) return { args: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return { args: value as Record<string, unknown> };
  } catch {
    // Reported below.
  }
  return { args: {}, problem: `The arguments of this call were not a JSON object, and it was not run: ${text.slice(0, 300)}. Send the call again.` };
}

/** Arguments of a tool call that arrived as JSON text. Text that is no JSON object gives none. */
export function parseArguments(text: unknown): Record<string, unknown> {
  if (text && typeof text === "object" && !Array.isArray(text)) return text as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
