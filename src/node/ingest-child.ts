// The child process of `createIsolatedExtractors` (isolated.ts): it reads the files it is sent with
// the built-in extractors, one at a time, and answers over the IPC channel. It runs with a heap
// limit of its own: a file that would exhaust the memory kills this process, not the server.
import { createPdfExtractor, extractText, type PdfExtractorOptions } from "../extract.js";
import type { DocumentFormat, ExtractedText, ExtractProgress } from "../types.js";

/** A file to read. */
export type ChildJob = {
  type: "extract";
  id: number;
  bytes: Uint8Array;
  input: { name: string; mimeType: string; format: DocumentFormat; scannedPages?: number; maxTextBytes?: number; maxPages?: number; progress: boolean };
  pdf?: PdfExtractorOptions;
};

/** What the child answers. */
export type ChildMessage =
  | { type: "ready" }
  | { type: "progress"; id: number; progress: ExtractProgress }
  | { type: "done"; id: number; result: ExtractedText }
  | { type: "error"; id: number; message: string; name: string; code?: string; syscall?: string };

const send = (message: ChildMessage) => {
  process.send?.(message);
};

process.on("message", (message: ChildJob | { type: "abort"; id: number }) => {
  if (message?.type === "extract") void run(message);
});

// The parent went away: nothing is left to answer.
process.on("disconnect", () => process.exit(0));

let pdfExtractor: { options: string; extract: ReturnType<typeof createPdfExtractor> } | undefined;

async function run(job: ChildJob): Promise<void> {
  try {
    const options = JSON.stringify(job.pdf ?? {});
    if (job.input.format === "pdf" && pdfExtractor?.options !== options) pdfExtractor = { options, extract: createPdfExtractor(job.pdf ?? {}) };
    const { progress, ...input } = job.input;
    const result = await extractText(job.bytes, {
      ...input,
      ...(progress ? { onProgress: (report: ExtractProgress) => send({ type: "progress", id: job.id, progress: report }) } : {}),
    }, job.input.format === "pdf" && pdfExtractor ? { pdf: pdfExtractor.extract } : {});
    const { text, pages, encoding, replacedCharacters } = result;
    send({ type: "done", id: job.id, result: { text, ...(pages !== undefined ? { pages } : {}), ...(encoding !== undefined ? { encoding } : {}), ...(replacedCharacters !== undefined ? { replacedCharacters } : {}) } });
  } catch (error) {
    // A system error keeps its code and system call: the server tells it apart from a file that cannot be read.
    const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
    send({
      type: "error",
      id: job.id,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof syscall === "string" ? { syscall } : {}),
    });
  }
}

send({ type: "ready" });
