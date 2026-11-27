// The sources of an answer: where each citation the model wrote points to in the original file,
// as a person finds it there (a sheet and row, a page, a slide, a section), and where in the shown
// text its chip goes. Types only, with no import, so that the browser entry (`llm-large-files/client`)
// can take them as they are. New in 0.99.14.

/**
 * Where a citation points to in the original file. It says only what is certain: a part that is
 * not known is left out, and when nothing narrower than the file is known it is `{ kind: "document" }`.
 * It is never taken from the nearest heading, the line before, or a default page. New in 0.99.14.
 *
 * - `row`: a row of a workbook (its sheet, and Excel's row number, as Excel shows it) or of a CSV
 *   file (the row as a spreadsheet shows it: the header is row 1, a quoted line break does not
 *   start a row, a blank line is a row). `toRow` for a range of rows.
 * - `cell`: reserved for a cell of a workbook. Not given in 0.99.14.
 * - `sheet`: a sheet of a workbook (its number from 1, and its name), when no row is certain: a
 *   total computed over the sheet, a heading line, or a row number that may be read two ways.
 * - `page`: a page of a PDF, counted from 1 (not the label printed on it). `toPage` for a range.
 * - `slide`: a slide of a deck, counted from 1. `notes: true` when the line is in its speaker notes.
 * - `section`: a part of a DOCX, HTML or Markdown file: its headings, from the top one, and the
 *   number written at the start of the cited line itself ("3.1", "5.", "(ב)").
 * - `line`: a line of a log or text file as it is in the file, when it is known (no line of the
 *   file was split), and the time written on that line.
 * - `document`: the file, with nothing narrower known.
 */
export type SourceLocator =
  | { kind: "row"; sheetIndex?: number; sheet?: string; row: number; toRow?: number }
  | { kind: "cell"; sheetIndex: number; sheet?: string; row: number; column: string }
  | { kind: "sheet"; sheetIndex: number; sheet?: string }
  | { kind: "page"; page: number; toPage?: number }
  | { kind: "slide"; slide: number; toSlide?: number; notes?: true }
  | { kind: "section"; headings?: string[]; numbering?: string }
  | { kind: "line"; line?: number; toLine?: number; time?: string }
  | { kind: "document" };

/**
 * What a source's place was decided from: "text", the stored text of the document; "pages", its
 * page index; "tool", a tool's own result (a total `aggregate_table` computed over a sheet);
 * "ingest", what the upload recorded (lines split at 2,000 characters, speaker notes);
 * "outline", a list of the document's sheets or headings known to be complete; "none", nothing
 * (the locator is the document). New in 0.99.14.
 */
export type SourceBasis = "text" | "pages" | "tool" | "ingest" | "outline" | "none";

/**
 * How far the model was shown the lines a source names, in this question:
 * - "shown": a tool showed every one of them, or the file was sent whole;
 * - "noted": a whole-file read's notes for the part that holds them cite them;
 * - "part_failed": a whole-file read could not read the part that holds them;
 * - "not_noted": a whole-file read read them, and its notes do not cite them;
 * - "past_end": they are past the end of the file;
 * - "not_shown": no tool showed them.
 * New in 0.99.14.
 */
export type SourceSeen = "shown" | "noted" | "part_failed" | "not_noted" | "past_end" | "not_shown";

/**
 * A place an answer cites, in `AskResult.sources`, the `citation` events, and `run.finish`. One per
 * distinct citation of the answer (a file and its lines), kept as it was when the answer was made:
 * nothing is looked up again later from a line number. New in 0.99.14.
 */
export type CitedSource = {
  /**
   * `${documentId}:${from}-${to}`, the same in every event and in the result; "?:from-to" when the
   * citation names no file and the question has several.
   */
  key: string;
  /** The document. Absent when it could not be decided (no file named, or two files of the name). */
  documentId?: string;
  /** Its file name, as the question names it. */
  name?: string;
  /**
   * The document's version, opaque: give it to `files.readLines` (or the preview route) to read
   * the cited lines, and get "changed" when the file was replaced since. Never the owner, scope or
   * date of the file. Absent when the document is not decided.
   */
  version?: string;
  /** The version of the extractor that wrote the document's text (`DocumentMeta.textVersion`, 1 when absent). */
  textVersion?: number;
  /** The lines the model cited, as `AskResult.citations.cited` has them: text lines, or the row number of a "Row N" form. */
  from: number;
  to: number;
  form: "line" | "row";
  /** Where they are in the original file: one part, or one per sheet for a range across sheets (at most 4). */
  locators: SourceLocator[];
  /** What the place was decided from. */
  basis: SourceBasis;
  /** True when every cited line was shown to the model in this question (`seen` "shown"). */
  shown: boolean;
  /** How far the model was shown them. */
  seen: SourceSeen;
  /**
   * Why the locator is no finer than it is, or how it was found, as a code for logs ("row_prefix",
   * "computed_over_sheet", "l_number_contradicts_claim", "hebrew_row_tie"…).
   */
  reason?: string;
  /** The places it may be, when it is `ambiguous`: each document and locator. */
  candidates?: Array<{ documentId?: string; locator: SourceLocator }>;
  /**
   * The cited lines as the model was sent them, for people: at most 300 characters, the row of a
   * workbook as "header: value" pairs. Only from what the model was sent (a tool result after
   * `onToolResult` and fitting, or a file sent whole), never read again from the stored text. In
   * events only with `AskOptions.eventResults: true`; never in what `sseMessageOf` sends.
   */
  quote?: string;
  /** True when `onToolResult` changed the tool result the quote was cut from. */
  redacted?: true;
};

/**
 * Where a chip goes in the shown answer (`AskResult.text`), and the sources it opens. New in 0.99.14.
 */
export type CitationAnchor = {
  /**
   * The place in `AskResult.text`, in UTF-16 units: the text of the question's `text` events
   * joined, from `run.start` or the last notice with `discardText`. Always at most `text.length`.
   * Never inside code, never at the start of a line, and outside emphasis.
   */
  at: number;
  /** The request whose text holds it. */
  requestId: string;
  /** The `key` of each source it opens, in the order the model cited them. */
  sources: string[];
  /**
   * "resolved": its sources are final; "ambiguous": the file or the row may be one of several
   * (`CitedSource.candidates`); "unresolved": the lines are past the end of the file, or the file
   * could not be read in time. ("pending" is reserved; no event or result carries it in 0.99.14.)
   */
  status: "resolved" | "ambiguous" | "unresolved" | "pending";
  /** Its number in the answer, 1 for the first chip: the label of `citationMarkers: "token"`. */
  label: number;
  /** "removed": the citation was taken out of the text; "converted": it was put into words there ("שורה 8 בגיליון לקוחות"), as the answer needs the place. */
  kind: "removed" | "converted";
};

/**
 * What is left of the talk about lines in a shown answer, for your logs: counts and short hashes
 * only, never the text. `AskResult.lineTalk`, in `run.finish` and `run.error` for `onEvent`, never
 * sent to a browser by `sseMessageOf`. New in 0.99.14.
 */
export type LineTalk = {
  /** "none": the shown answer names no line or row; "harmless": only true log lines, Excel rows or CSV rows; "harmful": some other. */
  verdict: "none" | "harmless" | "harmful";
  /**
   * Line and row numbers left in the shown text ("L12", "line 12", "Row 12", "שורה 12", a copied
   * "12| " prefix), each mention judged by its numbers: harmless when it is a log line of a file
   * with no split line, an Excel row whose cells the sentence names, or a CSV row before any quoted
   * line break; harmful otherwise, by kind. `hashes`: a SHA-256 prefix (16 hex digits) per mention.
   */
  left: {
    mentions: number;
    numbers: number;
    harmfulMentions: number;
    harmless: { logLine: number; excelRow: number; csvRow: number };
    harmful: { wrongWorkbookRow: number; workbookTextLine: number; documentLine: number; csvShifted: number; outOfRange: number; unattributed: number };
    hashes: string[];
  };
  /** Citations converted into words because the answer needed the place. */
  kept: { count: number };
  /** What the hider held back while it decided: the most characters at once, and how many times. */
  held: { characters: number; times: number };
  /** Citations whose place could not be told apart (status "ambiguous"). */
  ambiguous: { count: number };
};

/** How `askWithFiles` shows the citations of an answer (`AskOptions.citationMarkers`). New in 0.99.14. */
export type CitationMarkers = "keep" | "remove" | "token";

/** Whether an answer has sources (`AskOptions.sources`). New in 0.99.14. */
export type SourcesMode = "on" | "off";
