// The sources and anchors of one question (CIT-2): the citations the hider took out or put in
// words become chips, each with where it points to in the original file. Nothing here changes what
// is sent to the model. New in 0.99.14.
import { attributedCitations, type HiderEntry } from "./citations.js";
import { locatorInWords } from "./describe-locator.js";
import type { Evidence } from "./evidence.js";
import { lineTalkOf, type LineTalkFile } from "./line-talk.js";
import { aggregateSideOf, claimAround, deriveLocatorTables, resolveCitation, type AggregateSide, type LocatorTables } from "./locators.js";
import type { ModelToolRound } from "./model.js";
import type { CitationAnchor, CitedSource, LineTalk, SourceSeen } from "./sources.js";
import { TOOL_NAMES } from "./tools.js";
import type { DocumentMeta } from "./types.js";
import { versionToken } from "./version-token.js";

/** The longest quote a source carries. */
export const QUOTE_CHARACTERS = 300;
/** The deferred step before `run.finish`: at most this long, for the documents whose text was not in hand. */
export const DEFERRED_MS = 1_000;
/** A document whose text is larger than this is not read for its locators: its chips stay coarse. */
export const LOCATOR_TEXT_BYTES = 16 * 1024 * 1024;

/** What the tracker can ask of the library: a document's stored text. */
export type LocatorTextReader = (id: string, signal?: AbortSignal) => Promise<string | undefined>;

/** The line of each "--- Page N ---" marker that counts up from 1, as the text index finds them. */
export function pageStartsOf(lines: readonly string[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("--- Page ") && line === `--- Page ${starts.length + 1} ---`) starts.push(index + 1);
  }
  return starts;
}

/** An anchor still waiting for its line to end (its claim and its file may come after it). */
type Waiting = { entry: HiderEntry; requestId: string; at: number; label: number };

/** A line the model was sent, of a document: its text, and whether the result was one `onToolResult` replaced. */
type SentLine = { text: string; redacted: boolean };

const LINE_PREFIX = /^\s*(\d{1,9})\| ?(.*)$/;
const ROW_PREFIX = /^Row \d+: /;

export type SourceTrackerOptions = {
  documents: readonly DocumentMeta[];
  /** The evidence of the question, as it grows. */
  evidence: readonly Evidence[];
  /** The question's text in the answer's language: Hebrew when it is. */
  hebrew: () => boolean;
  /** Sends a `citation` event (sources on, and an event listener). */
  onCitation?: (anchor: CitationAnchor, sources: CitedSource[]) => void;

  /** How much of the answer was shown so far: a chip is told once the text that holds its place was. */
  shownLength: () => number;
  signal?: AbortSignal;
};

export class SourceTracker {
  private readonly metas = new Map<string, DocumentMeta>();
  private readonly names: Record<string, string> = {};
  private readonly formats: Record<string, DocumentMeta["format"]> = {};
  private readonly tables = new Map<string, LocatorTables>();
  private readonly lines = new Map<string, string[]>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly sent = new Map<string, Map<number, SentLine>>();
  private readonly aggregates: AggregateSide[] = [];
  /** What the whole-file reads of each document noted, and the parts they could not read (CIT-9). */
  private readonly wholeReads = new Map<string, { noted: Array<[number, number]>; failed: Array<[number, number]> }>();
  private readonly waiting: Waiting[] = [];
  private readonly removedSpans: Array<[number, number]> = [];
  readonly anchors: CitationAnchor[] = [];
  readonly sources = new Map<string, CitedSource>();
  private converted = 0;
  private ambiguous = 0;
  /** The raw text of the question so far (`AskResult.modelText`). */
  private raw = "";
  private reader?: LocatorTextReader;

  constructor(private readonly options: SourceTrackerOptions) {
    for (const meta of options.documents) {
      this.metas.set(meta.id, meta);
      this.names[meta.id] = meta.name;
      this.formats[meta.id] = meta.format;
    }
  }

  /** The reader of the documents' stored text: the tool set's, once there is one. */
  read(reader: LocatorTextReader | undefined): void {
    this.reader ??= reader;
  }

  /** The text of a file sent whole, as the model had it: its lines can be quoted, and its locators derived from them when they are all there. */
  addWhole(meta: DocumentMeta, block: string): void {
    const lines = this.sentOf(meta.id);
    for (const line of block.split("\n")) {
      const match = LINE_PREFIX.exec(line);
      if (match) lines.set(Number(match[1]), { text: match[2]!, redacted: false });
    }
    if (this.tables.has(meta.id) || lines.size !== meta.lines) return;
    const texts: string[] = [];
    for (let line = 1; line <= meta.lines; line++) {
      const found = lines.get(line);
      if (!found) return;
      texts.push(found.text);
    }
    this.derive(meta, texts);
  }

  private derive(meta: DocumentMeta, lines: string[]): void {
    this.lines.set(meta.id, lines);
    this.tables.set(meta.id, deriveLocatorTables({ meta, text: lines.join("\n"), pageStarts: pageStartsOf(lines) }));
  }

  /** A round as the model was sent it (after `onToolResult` and fitting): its lines, and the totals `aggregate_table` computed. */
  addRound(round: ModelToolRound): void {
    for (const { call, result } of round.answers) {
      const id = typeof call.args.document_id === "string" ? call.args.document_id : undefined;
      if (!id || !this.metas.has(id) || !result || typeof result !== "object") continue;
      if (typeof (result as { error?: unknown }).error === "string") continue;
      const redacted = (result as { redacted?: unknown }).redacted === true;
      // A result cut to the room as a fragment of JSON gives no quote: it has no whole lines.
      if (typeof (result as { truncated?: unknown }).truncated !== "undefined" && typeof (result as { partial?: unknown }).partial === "string") continue;
      // The notes of a whole-file read are the model's own words, not the file's: only its items' quotes.
      if (call.name === TOOL_NAMES.analyze) continue;
      if (call.name === TOOL_NAMES.aggregate) {
        const side = aggregateSideOf(call.id ?? "", id, result);
        if (side) this.aggregates.push(side);
        continue;
      }
      this.collect(id, result, redacted);
    }
    // The documents the round read: their tables are derived meanwhile, for the chips of the answer.
    for (const { call } of round.answers) if (typeof call.args.document_id === "string" && this.metas.has(call.args.document_id)) void this.load(call.args.document_id);
  }

  private sentOf(id: string): Map<number, SentLine> {
    let lines = this.sent.get(id);
    if (!lines) this.sent.set(id, (lines = new Map()));
    return lines;
  }

  /** Every line of a result the model was sent: "N| text" in its strings, and `{ line, text }` matches with their lines before and after. */
  private collect(id: string, value: unknown, redacted: boolean): void {
    const lines = this.sentOf(id);
    const walk = (item: unknown): void => {
      if (typeof item === "string") {
        if (!item.includes("| ")) return;
        for (const line of item.split("\n")) {
          const match = LINE_PREFIX.exec(line);
          if (match && !lines.has(Number(match[1]))) lines.set(Number(match[1]), { text: match[2]!, redacted });
        }
      } else if (Array.isArray(item)) for (const one of item) walk(one);
      else if (item !== null && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (typeof record.line === "number" && Number.isInteger(record.line) && typeof record.text === "string") {
          const line = record.line;
          if (!lines.has(line)) lines.set(line, { text: record.text, redacted });
          if (Array.isArray(record.before)) record.before.forEach((text, index, all) => typeof text === "string" && !lines.has(line - all.length + index) && lines.set(line - all.length + index, { text, redacted }));
          if (Array.isArray(record.after)) record.after.forEach((text, index) => typeof text === "string" && !lines.has(line + 1 + index) && lines.set(line + 1 + index, { text, redacted }));
        }
        for (const [key, one] of Object.entries(record)) if (key !== "outline" && key !== "cite" && !key.endsWith("note")) walk(one);
      }
    };
    walk(value);
  }

  /** A whole-file read of a document: the lines its notes cite inside each part, and the parts it could not read. */
  noteWholeRead(documentId: string, lines: { noted: Array<[number, number]>; failed: Array<[number, number]> } | undefined): void {
    const known = this.wholeReads.get(documentId) ?? { noted: [], failed: [] };
    if (lines) {
      known.noted.push(...lines.noted);
      known.failed.push(...lines.failed);
    }
    this.wholeReads.set(documentId, known);
  }

  /** Loads a document's text and derives its locator tables, once. */
  load(id: string): Promise<void> {
    if (this.tables.has(id)) return Promise.resolve();
    let pending = this.loading.get(id);
    if (pending) return pending;
    const meta = this.metas.get(id);
    const read = this.reader;
    if (!meta || !read || meta.textBytes > LOCATOR_TEXT_BYTES) return Promise.resolve();
    pending = read(id, this.options.signal)
      .then((text) => {
        if (typeof text === "string") this.derive(meta, text.split("\n"));
      })
      .catch(() => undefined);
    this.loading.set(id, pending);
    return pending;
  }

  /** The words for a citation the answer needs, where it stood ("שורה 8 בגיליון לקוחות"), or undefined to let the hider use its own. */
  describe = (place: { ids: string[]; numbers: Array<{ from: number; to: number; form: "line" | "row" }>; hebrew: boolean }): string | undefined => {
    const ids = place.ids.length > 0 ? place.ids : this.metas.size === 1 ? [...this.metas.keys()] : [];
    if (ids.length !== 1 || place.numbers.length !== 1) return undefined;
    const number = place.numbers[0]!;
    const resolved = resolveCitation({ citation: { documentId: ids[0]!, ids, ...number }, claim: { before: "", after: "" }, group: [], tablesOf: (id) => this.tables.get(id), aggregates: [], evidence: [...this.options.evidence] });
    if (resolved === "pending" || resolved.status !== "resolved" || resolved.locators.length !== 1) return undefined;
    return locatorInWords(resolved.locators[0]!, place.hebrew ? "he" : "en");
  };

  /** Text the model wrote, as it came (`modelText`). */
  pushRaw(delta: string): void {
    this.raw += delta;
  }

  /** Chips the hider placed: each removed or converted citation, at `at` in the shown text, becomes an anchor once its line ends. */
  addAnchors(chips: ReadonlyArray<{ entry: HiderEntry; at: number; label: number }>, requestId: string): void {
    for (const { entry, at, label } of chips) {
      if (entry.kind === "removed") this.removedSpans.push(entry.span);
      else this.converted++;
      this.waiting.push({ entry, requestId, at, label });
    }
  }

  /** Anchors whose line has ended in the raw text (or all, at `final`) are resolved and told. */
  settle(final = false, silent = false): void {
    while (this.waiting.length > 0) {
      const next = this.waiting[0]!;
      if (!final && (!this.raw.includes("\n", next.entry.span[1]) || next.at > this.options.shownLength())) return;
      if (!final && !this.ready(next)) return;
      this.waiting.shift();
      this.resolve(next, silent);
    }
  }

  /** Whether every document an anchor may name has its tables, or cannot get them. */
  private ready(waiting: Waiting): boolean {
    for (const id of this.idsOf(waiting.entry)) if (!this.tables.has(id) && this.loading.has(id)) return false;
    return true;
  }

  /** The documents a citation may be of: those named inside it, else those checkCitations' name rule gives, else the only one. */
  private idsOf(entry: HiderEntry): string[] {
    if (entry.ids?.length) return entry.ids;
    const found = this.attributed().find((one) => one.start >= entry.span[0] && one.end <= entry.span[1] && one.ids?.length);
    if (found?.ids) return found.ids;
    return this.metas.size === 1 ? [...this.metas.keys()] : [];
  }

  private attributedCache?: { length: number; list: ReturnType<typeof attributedCitations> };
  private attributed(): ReturnType<typeof attributedCitations> {
    if (this.attributedCache?.length !== this.raw.length) this.attributedCache = { length: this.raw.length, list: attributedCitations(this.raw, this.names, this.formats) };
    return this.attributedCache.list;
  }

  /** The documents of the anchors still waiting, to read before `run.finish`. */
  waitingDocuments(): string[] {
    const ids = new Set<string>();
    for (const waiting of this.waiting) for (const id of this.idsOf(waiting.entry)) if (!this.tables.has(id)) ids.add(id);
    return [...ids];
  }

  private resolve({ entry, requestId, at, label }: Waiting, silent: boolean): void {
    const ids = this.idsOf(entry);
    const claim = claimAround(this.raw, entry.span[0], entry.span[1], this.removedSpans);
    const group = entry.numbers.map((number) => ({ documentId: ids.length === 1 ? ids[0] : undefined, ids, ...number }));
    const keys: string[] = [];
    let status: CitationAnchor["status"] = "resolved";
    for (const citation of group) {
      const found = resolveCitation({ citation, claim, group, tablesOf: (id) => this.tables.get(id), aggregates: this.aggregates, evidence: [...this.options.evidence] });
      const resolved = found === "pending" ? { documentId: citation.documentId, locators: [{ kind: "document" as const }], status: "unresolved" as const, reason: "document_not_in_hand", basis: "none" as const } : found;
      const documentId = resolved.documentId;
      const key = `${documentId ?? "?"}:${citation.from}-${citation.to}`;
      keys.push(key);
      if (resolved.status === "ambiguous") status = "ambiguous";
      else if (resolved.status === "unresolved" && status === "resolved") status = "unresolved";
      if (this.sources.has(key)) continue;
      const meta = documentId ? this.metas.get(documentId) : undefined;
      const seen = this.seenOf(documentId, citation.from, citation.to, citation.form);
      const quote = documentId && citation.form === "line" ? this.quoteOf(documentId, citation.from, citation.to) : undefined;
      const source: CitedSource = {
        key,
        ...(documentId ? { documentId } : {}),
        ...(meta ? { name: meta.name, version: versionToken(meta), textVersion: meta.textVersion ?? 1 } : {}),
        from: citation.from,
        to: citation.to,
        form: citation.form,
        locators: resolved.locators,
        basis: resolved.basis,
        shown: seen === "shown",
        seen,
        reason: resolved.reason,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        ...(quote ? { quote: quote.text, ...(quote.redacted ? { redacted: true as const } : {}) } : {}),
      };
      this.sources.set(key, source);
    }
    if (status === "ambiguous") this.ambiguous++;
    const anchor: CitationAnchor = { at, requestId, sources: keys, status, label, kind: entry.kind === "converted" ? "converted" : "removed" };
    this.anchors.push(anchor);
    if (!silent) this.options.onCitation?.(anchor, keys.map((key) => this.sources.get(key)!));
  }

  /**
   * How far the model was shown lines `from`-`to` of a document: by a tool that showed them, or a
   * file sent whole ("shown"); else by a whole-file read, whose notes cite them inside their part
   * ("noted"), whose part with them failed ("part_failed"), or whose notes do not ("not_noted").
   */
  private seenOf(documentId: string | undefined, from: number, to: number, form: "line" | "row"): SourceSeen {
    if (!documentId) return "not_shown";
    const meta = this.metas.get(documentId);
    if (form === "line" && meta && to > meta.lines) return "past_end";
    if (form === "row" && meta?.format === "xlsx") {
      // A row of a workbook: shown when a line the model was sent starts with it.
      for (const line of this.sent.get(documentId)?.values() ?? []) if (line.text.startsWith(`Row ${from}:`)) return "shown";
    }
    const ranges: Array<[number, number]> = [];
    for (const entry of this.options.evidence) {
      if (entry.documentId !== documentId) continue;
      if (entry.tool === "inline") return "shown";
      // A whole-file read's entry holds every line: what it noted is told apart below.
      if (entry.tool === TOOL_NAMES.analyze) continue;
      for (const range of entry.lines ?? []) ranges.push([range[0], range[1]]);
    }
    if (covered(ranges, from, to)) return "shown";
    const read = this.wholeReads.get(documentId);
    if (!read) return "not_shown";
    if (covered(read.noted, from, to)) return "noted";
    if (read.failed.some(([start, end]) => from <= end && to >= start)) return "part_failed";
    return "not_noted";
  }

  /** The cited lines as the model was sent them, for people: no "N| " and no "Row R: ", at most 300 characters. */
  private quoteOf(documentId: string, from: number, to: number): { text: string; redacted: boolean } | undefined {
    const lines = this.sent.get(documentId);
    if (!lines || to - from > 50) return undefined;
    const parts: string[] = [];
    let redacted = false;
    for (let line = from; line <= to; line++) {
      const found = lines.get(line);
      if (!found) return undefined;
      redacted ||= found.redacted;
      const text = found.text.replace(ROW_PREFIX, "").trim();
      if (text) parts.push(text);
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return { text: text.length > QUOTE_CHARACTERS ? `${text.slice(0, QUOTE_CHARACTERS - 1)}…` : text, redacted };
  }

  /** Every anchor still waiting is resolved: once the documents they need are read, within `DEFERRED_MS`. */
  async finish(): Promise<void> {
    const ids = this.waitingDocuments();
    if (ids.length > 0 && !this.options.signal?.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, DEFERRED_MS)));
      try {
        await Promise.race([Promise.all(ids.map((id) => this.load(id))), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
    this.settle(true);
  }

  /** The talk of lines left in `shown`, with what the hider held. */
  lineTalk(shown: string, held: { characters: number; times: number }): LineTalk {
    const files: LineTalkFile[] = [...this.metas.values()].map((meta) => {
      const lines = this.lines.get(meta.id);
      return { id: meta.id, name: meta.name, format: meta.format, lines: meta.lines, wrappedLines: meta.wrappedLines, ...(lines ? { lineAt: (line: number) => lines[line - 1] } : {}) };
    });
    return { ...lineTalkOf(shown, files), kept: { count: this.converted }, held, ambiguous: { count: this.ambiguous } };
  }

  /** Every anchor and source dropped: the text they were in was taken back (`discardText`). */
  clear(): void {
    this.anchors.length = 0;
    this.sources.clear();
    this.waiting.length = 0;
  }
}

/** Whether `ranges` hold every line from `from` to `to`. */
function covered(ranges: ReadonlyArray<readonly [number, number]>, from: number, to: number): boolean {
  const sorted = [...ranges].sort((one, other) => one[0] - other[0]);
  let next = from;
  for (const [start, end] of sorted) {
    if (start > next) break;
    if (end >= next) next = end + 1;
    if (next > to) return true;
  }
  return next > to;
}
