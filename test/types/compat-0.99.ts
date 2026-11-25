// Checked by `tsc --noEmit` (npm run typecheck), not run: the types of 0.99.9. What createLargeFiles
// returns has `list`, `touch` and `update` without `!`; a mock typed `CreatedLargeFiles` needs them
// (type a mock as `LargeFiles`, whose members they stay optional on); a `DocumentHandlers` made by
// hand needs `list`. `prepareUpload` can return `dedupe` and `appData`, and `onUploaded` is told
// `reused`. Other packages of 0.99.9 add their own sections below.
import { createLargeFiles, MemoryDocumentStore, type CreatedLargeFiles, type DocumentMeta, type LargeFiles } from "llm-large-files";
import type { DocumentHandlers, PreparedUpload, UploadedContext } from "llm-large-files/node";

// --- owner: CreatedLargeFiles, DocumentHandlers, PreparedUpload, UploadedContext ---

const files = createLargeFiles({ store: new MemoryDocumentStore() });
const access = { owner: "user-1", scope: ["user-1", "chat-1"] };
export const listed: Promise<DocumentMeta[]> = files.list(access);
export const touched: Promise<DocumentMeta | undefined> = files.touch("doc-1", access);
export const updated: Promise<DocumentMeta | undefined> = files.update("doc-1", { appData: { rowId: "1" } }, access);

/** A mock of the library as `LargeFiles`: list, touch and update stay optional. */
export const ownLibrary = (): LargeFiles => {
  const { list: _list, touch: _touch, update: _update, ...rest } = files;
  return rest;
};

/** A mock typed `CreatedLargeFiles` without them does not compile (TS2739). */
export const mock = (): CreatedLargeFiles => {
  const { list: _list, touch: _touch, update: _update, ...rest } = files;
  // @ts-expect-error list, touch and update are required on CreatedLargeFiles since 0.99.9.
  return rest;
};

/** Handlers made by hand need `list` (TS2741). */
export const handlers = (made: DocumentHandlers): DocumentHandlers => {
  const { list: _list, ...rest } = made;
  // @ts-expect-error list is required on DocumentHandlers since 0.99.9.
  return rest;
};

export const prepared: PreparedUpload = { dedupe: true, appData: { rowId: "1" } };
export const reused = (context: UploadedContext): boolean => context.reused === true;
