// A library whose looks at pages wait their turns (P10, 0.9.0), for test/page-looks.test.ts and
// test/timing/ask.timing.test.ts: a store that loads the original PDF as slowly as a test asks.
import { createLargeFiles, MemoryDocumentStore, TOOL_NAMES, type LargeFilesOptions, type ToolCallHooks } from "llm-large-files";
import { numberedPdf } from "./pdf-fixtures.js";

export const BUSY = "report.pdf: The pages cannot be looked at right now; the server is busy. Answer from the text, or look again later.";
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A library that keeps PDFs, over a store whose originals take `loadMs` to load (or until the
 * promise it returns settles), and that counts the loads under way. The PDF is ingested by a
 * library of its own, so that `options` (a short `ingestTimeoutMs`) apply to the looks alone.
 */
export async function library(options: Partial<LargeFilesOptions> = {}, loadMs: (load: number) => number | Promise<unknown> = () => 20) {
  const store = new MemoryDocumentStore();
  const meta = await createLargeFiles({ store, keepOriginals: ["pdf"] }).ingest({ name: "report.pdf", bytes: numberedPdf(3) });
  const files = createLargeFiles({ store, keepOriginals: ["pdf"], ...options });
  const loads = { started: 0, now: 0, most: 0 };
  const getOriginal = store.getOriginal.bind(store);
  store.getOriginal = async (id, context) => {
    const load = loads.started++;
    loads.most = Math.max(loads.most, ++loads.now);
    try {
      const wait = loadMs(load);
      await (typeof wait === "number" ? sleep(wait) : wait);
      return await getOriginal(id, context);
    } finally {
      loads.now--;
    }
  };
  /** A look from a tool set of its own, as each question has. */
  const look = (signal?: AbortSignal, hooks: ToolCallHooks | ((id: string) => void) = {}) => files.tools([meta], { viewPages: true, ...(signal ? { signal } : {}) })
    .executeWithFiles(TOOL_NAMES.view, { document_id: meta.id, from_page: 2 }, {}, typeof hooks === "function" ? { onPagesBusy: hooks } : hooks);
  return { files, meta, loads, look, store };
}
