// Checked by `tsc --noEmit` (npm run typecheck), not run: askGemini takes as `messages` what
// askWithFiles takes (ChatMessage[], since 0.9.0), so that the conversion of 0.8,
// fromGeminiContents(contents, { rounds: false }), can be passed to it. A wider type than the
// Array<ChatTurn | ToolTurn> of 0.8: a call written for 0.8 still compiles.
import type { ChatMessage, ChatTurn, LargeFiles, ToolTurn } from "llm-large-files";
import { askGemini, fromGeminiContents, type GeminiContent, type GeminiEndpoint } from "llm-large-files/gemini";

declare const files: LargeFiles;
declare const endpoint: GeminiEndpoint;
declare const contents: GeminiContent[];
declare const history: Array<ChatTurn | ToolTurn>;

export async function asked(): Promise<void> {
  await askGemini({ files, endpoint, documentIds: [], messages: fromGeminiContents(contents, { rounds: false }) });
  await askGemini({ files, endpoint, documentIds: [], messages: fromGeminiContents(contents) });
  const messages: ChatMessage[] = [{ role: "user", parts: [{ text: "What is in the chart?" }, { native: { inlineData: { mimeType: "image/png", data: "" } } }] }];
  await askGemini({ files, endpoint, documentIds: [], messages });
  // As 0.8 wrote it.
  await askGemini({ files, endpoint, documentIds: [], messages: history });
}
