import { describe, expect, it } from "vitest";
import {
  askWithFiles,
  createLargeFiles,
  DOCUMENT_META_VERSION,
  DocumentsNotFoundError,
  DocumentStoreError,
  MemoryDocumentStore,
  TOOL_TURN_VERSION,
  type ChatMessage,
  type DocumentMeta,
  type ToolTurn,
} from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

const NEWER = "The document was stored by a newer version of llm-large-files. Try again.";

/** A library over a memory store, with a log searched through tools and a short note sent whole. */
async function library() {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, budget: { inlineTokens: 1_000 } });
  const log = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(400)) });
  const note = await files.ingest({ name: "note.txt", bytes: utf8("Deploy on Friday.\n") });
  /** Writes the stored metadata again, changed by `change`, as an older or a newer version would have. */
  const rewrite = async (id: string, change: (meta: Record<string, unknown>) => void) => {
    const stored = (await store.get(id))!;
    const meta = { ...stored.meta } as Record<string, unknown>;
    change(meta);
    await store.put({ meta: meta as DocumentMeta, text: stored.text });
  };
  return { store, files, log, note, rewrite };
}

const question = (text: string, earlier: ChatMessage[] = []): ChatMessage[] => [...earlier, { role: "user", text }];

describe("DocumentMeta.metaVersion", () => {
  it("is 1 on the metadata ingest writes", async () => {
    const { store, files, log } = await library();
    expect(DOCUMENT_META_VERSION).toBe(1);
    expect(log.metaVersion).toBe(DOCUMENT_META_VERSION);
    expect((await store.getMeta(log.id))?.metaVersion).toBe(1);
    expect((await files.getMeta(log.id))?.metaVersion).toBe(1);
  });

  it("may be absent or null, on metadata of an earlier version, which is read as before", async () => {
    const { files, log, rewrite } = await library();
    await rewrite(log.id, (meta) => delete meta.metaVersion);
    expect((await files.getMeta(log.id))?.name).toBe("app.log");
    expect((await files.prepare([log.id], { tokens: 0, bytes: 0 })).missing).toEqual([]);
    await rewrite(log.id, (meta) => (meta.metaVersion = null));
    expect((await files.getMeta(log.id))?.name).toBe("app.log");
  });

  it("of a newer version is a store error, not a missing document, wherever the document is read", async () => {
    const { files, log, note, rewrite } = await library();
    const tools = files.tools([log]);
    await rewrite(log.id, (meta) => (meta.metaVersion = 2));

    const newer = { name: "DocumentStoreError", code: "NEWER_VERSION", operation: "read", status: 503, message: NEWER };
    await expect(files.getMeta(log.id)).rejects.toMatchObject(newer);
    await expect(files.getOriginal(log.id)).rejects.toMatchObject(newer);
    await expect(files.prepare([note.id, log.id], { tokens: 0, bytes: 0 })).rejects.toMatchObject(newer);
    // Not deleted: a newer version may mean what this one cannot tell.
    await expect(files.delete(log.id)).rejects.toBeInstanceOf(DocumentStoreError);
    expect(await tools.execute("read_document", { document_id: log.id, start_line: 1, end_line: 2 })).toEqual({ error: NEWER });

    // An application that took it for missing would ingest the file again over the newer one.
    const asked = askWithFiles({ files, model: fakeModel([says("never")]), documentIds: [log.id], messages: question("How many errors?") });
    await expect(asked).rejects.toBeInstanceOf(DocumentStoreError);
    await expect(asked).rejects.not.toBeInstanceOf(DocumentsNotFoundError);

    for (const version of ["2", 1.5, Number.NaN]) {
      await rewrite(log.id, (meta) => (meta.metaVersion = version));
      await expect(files.getMeta(log.id), String(version)).rejects.toMatchObject({ code: "NEWER_VERSION" });
    }
    await rewrite(log.id, (meta) => (meta.metaVersion = 1));
    expect(await files.delete(log.id)).toBe(true);
  });

  it("is never sent to the model: the requests are the same, byte for byte, without it", async () => {
    const { files, log, note, rewrite } = await library();
    const search = { id: "s1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact" } };
    const ask = async () => {
      const model = fakeModel([calls([search]), says("4 errors.")]);
      await askWithFiles({ files, model, documentIds: [log.id, note.id], messages: question("How many errors?") });
      return JSON.stringify(model.requests);
    };
    const stamped = await ask();
    expect(stamped).not.toContain("metaVersion");
    for (const id of [log.id, note.id]) await rewrite(id, (meta) => delete meta.metaVersion);
    expect((await files.getMeta(log.id))?.metaVersion).toBeUndefined();
    expect(await ask()).toBe(stamped);
  });
});

describe("ToolTurn.version", () => {
  it("is 1 on the rounds a question returns, and is not sent to the model with them", async () => {
    const { files, log } = await library();
    const search = { id: "s1", name: "search_document", args: { document_id: log.id, query: "ERROR", mode: "exact" } };
    const first = await askWithFiles({ files, model: fakeModel([calls([search]), says("4 errors.")]), documentIds: [log.id], messages: question("How many errors?") });
    expect(TOOL_TURN_VERSION).toBe(1);
    expect(first.toolTurns).toHaveLength(1);
    expect(first.toolTurns[0]).toMatchObject({ role: "tools", version: TOOL_TURN_VERSION });

    const later = async (rounds: ToolTurn[]) => {
      const model = fakeModel([says("The first at line 97.")]);
      const result = await askWithFiles({ files, model, documentIds: [log.id], messages: question("Where is the first?", [{ role: "user", text: "How many errors?" }, ...rounds, { role: "assistant", text: first.text }]) });
      expect(result.text).toBe("The first at line 97.");
      return JSON.stringify(model.requests);
    };
    const stamped = await later(first.toolTurns);
    const unstamped = await later(first.toolTurns.map(({ version: _version, ...round }) => round));
    expect(unstamped).toBe(stamped);
    expect(stamped).toContain("search_document");
    expect(stamped).not.toContain('"version"');
  });

  it("of a newer version is refused with a TypeError; version 1 and none are read", async () => {
    const { files, log } = await library();
    const round = (version?: unknown): ToolTurn => ({
      role: "tools",
      ...(version === undefined ? {} : { version: version as number }),
      calls: [{ id: "r1", name: "read_document", args: { document_id: log.id, start_line: 1, end_line: 2 }, result: { lines: "1-2", text: "…" } }],
    });
    let model = fakeModel([says("Done.")]);
    const ask = (turn: ToolTurn) => {
      model = fakeModel([says("Done.")]);
      return askWithFiles({
        files,
        model,
        documentIds: [log.id],
        messages: [{ role: "user", text: "Read the start." }, turn, { role: "assistant", text: "It starts with INFO lines." }, { role: "user", text: "And then?" }],
      });
    };
    for (const [version, message] of [
      [2, /stored tool round \(toolTurns\) has version 2: a newer version of llm-large-files made it/],
      ["1", /stored tool round \(toolTurns\) has a version that is not a number \("1"\)/],
      [Number.NaN, /stored tool round \(toolTurns\) has a version that is not a number \(NaN\)/],
    ] as const) {
      const refused = ask(round(version));
      await expect(refused, String(version)).rejects.toBeInstanceOf(TypeError);
      await expect(refused, String(version)).rejects.toThrow(message);
      // Refused before any request.
      expect(model.requests, String(version)).toHaveLength(0);
    }
    expect((await ask(round(1))).text).toBe("Done.");
    expect((await ask(round())).text).toBe("Done.");
  });
});
