// Checked by `tsc --noEmit` (npm run typecheck), not run: what 0.99.9 removed no longer compiles.
// `inlineTables` and `numberInline` left the options of askWithFiles and askGemini (files.prepare
// keeps them, for loops of your own), and `estimateTokens` left ModelAdapter.
import type { AskOptions, LargeFiles, ModelAdapter, ModelReply } from "llm-large-files";
import type { AskGeminiOptions, GeminiEndpoint } from "llm-large-files/gemini";

declare const files: LargeFiles;
declare const model: ModelAdapter;
declare const endpoint: GeminiEndpoint;

// @ts-expect-error inlineTables was removed in 0.99.9.
export const tables: AskOptions = { files, model, documentIds: [], messages: [], inlineTables: "text" };
// @ts-expect-error numberInline was removed in 0.99.9.
export const numbers: AskOptions = { files, model, documentIds: [], messages: [], numberInline: false };
// @ts-expect-error not in askGemini's options either.
export const gemini: AskGeminiOptions = { files, endpoint, documentIds: [], inlineTables: "tools" };

// @ts-expect-error ModelAdapter.estimateTokens was removed in 0.99.9.
export const literal: ModelAdapter = { id: "own", capabilities: { toolFiles: "none", pageTokens: 1_000 }, send: async (): Promise<ModelReply> => ({ text: "", calls: [] }), estimateTokens: (text: string) => text.length };

/** A class that still has the method compiles, as an interface allows more members: the loop never calls it. */
export class OwnAdapter implements ModelAdapter {
  readonly id = "own";
  readonly capabilities = { toolFiles: "none" as const, pageTokens: 1_000 };
  async send(): Promise<ModelReply> {
    return { text: "", calls: [] };
  }
  estimateTokens(text: string): number {
    return text.length;
  }
}

// files.prepare keeps both, off by default.
export const prepared = files.prepare([], { tokens: 0, bytes: 0 }, { numberInline: false, inlineTables: "text" });
