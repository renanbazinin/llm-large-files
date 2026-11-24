// Checked by `tsc --noEmit` (npm run typecheck), not run: the Gemini options of 0.10.0. `body` takes
// the fields an application adds, and not those the library writes (a reserved key fails to
// compile); askGemini takes every option of askWithFiles by its type, those new in 0.10.0 too;
// vertexAi takes a project with a token, or an API key of express mode, not both; and a token
// function of no arguments, as 0.9 wrote it, still fits.
import type { AskOptions, LargeFiles, PlacementState } from "llm-large-files";
import { askGemini, gemini, vertexAi, type AskGeminiOptions, type GeminiEndpoint, type GeminiRequestFields } from "llm-large-files/gemini";

declare const files: LargeFiles;
declare const endpoint: GeminiEndpoint;
declare const placement: PlacementState;

export const fields: GeminiRequestFields = {
  safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE", method: "SEVERITY" }],
  labels: { app: "chatbot", team: "hr" },
  serviceTier: "flex",
  cachedContent: "cachedContents/abc",
  // Any other field the API takes.
  speechConfig: {},
};

// @ts-expect-error contents is the library's: it is not set through body.
export const reservedContents: GeminiRequestFields = { contents: [] };
// @ts-expect-error generationConfig is set with generationConfig and analysisConfig.
export const reservedConfig: GeminiRequestFields = { generationConfig: { temperature: 0 } };
// @ts-expect-error tools and toolConfig are the library's.
export const reservedTools: GeminiRequestFields = { toolConfig: {} };

export const model = gemini(endpoint, {
  body: fields,
  analysisBody: (maxOutputTokens) => ({ labels: { use: "parts", limit: String(maxOutputTokens) } }),
  functionCallingMode: "VALIDATED",
  timeoutMs: 0,
  answerWithoutTools: "mode_none",
});

// @ts-expect-error a reserved key in the part reads' body fails too.
gemini(endpoint, { analysisBody: () => ({ systemInstruction: {} }) });

export async function asked(): Promise<void> {
  // The options of askWithFiles that askGemini does not name, new in 0.10.0 among them.
  await askGemini({
    files, endpoint, documentIds: [], messages: [{ role: "user", text: "?", documentIds: ["doc_1"] }],
    documentPlacement: "attached", placement, nativeRounds: true, inlineTables: "tools", numberInline: true, filteredAnswer: "drop",
    onToolResult: ({ result }) => ({ result }), limits: { wholeReadsPerQuestion: 2 },
    body: fields, explorerBody: { labels: { model: "explorer" } }, analysisBody: () => ({}), timeoutMs: 300_000, functionCallingMode: "AUTO", answerWithoutTools: "omit",
  });
  // @ts-expect-error askGemini makes the models itself.
  await askGemini({ files, endpoint, documentIds: [], model: gemini(endpoint) });
}

// Every option of askWithFiles but the models is an option of askGemini: no key is missing, and
// each takes what askWithFiles takes (an option narrowed in askGemini fails here).
type Shared = Exclude<keyof AskOptions, "model" | "explorer">;
type Missing = Exclude<Shared, keyof AskGeminiOptions>;
export const noneMissing: [Missing] extends [never] ? true : false = true;
export const sameTypes = (options: Omit<AskOptions, "model" | "explorer">): Partial<AskGeminiOptions> => options;

// A project with a token, as 0.9 wrote it: a string, or a function of no arguments.
vertexAi({ project: "p", model: "m", accessToken: "t" });
vertexAi({ project: "p", model: "m", accessToken: async () => "t" });
// A function that is told to refresh, headers of your own and a host of your own.
vertexAi({ project: "p", model: "m", location: "eu", accessToken: async ({ refresh }) => (refresh ? "new" : "kept"), headers: { "x-goog-user-project": "billing" }, host: "https://vertex.psc.example" });
// Express mode.
vertexAi({ apiKey: "k", model: "m", headers: async () => ({}) });
// @ts-expect-error express mode names no project.
vertexAi({ apiKey: "k", project: "p", model: "m" });
// @ts-expect-error a project needs a token.
vertexAi({ project: "p", model: "m" });

// An endpoint of your own, as 0.9 wrote it, still fits; one that can refresh says so.
export const own: GeminiEndpoint = { url: "https://gateway.example/models/m:generateContent", headers: async () => ({ Authorization: "Bearer x" }) };
export const refreshing: GeminiEndpoint = { ...own, headers: async (context) => ({ Authorization: `Bearer ${context?.refresh ? "new" : "kept"}` }), refreshable: true };
