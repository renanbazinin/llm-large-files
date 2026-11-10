// Public types. Everything a consumer touches is defined here, so the package can be
// published without exposing internal module layout.

export type DocumentFormat = "text" | "markdown" | "log" | "json" | "csv" | "pdf" | "docx" | "pptx";

export type OutlineEntry = {
  /** 1-based line number in the extracted text. */
  line: number;
  /** 1 is the top level. */
  level: number;
  title: string;
};

export type LogIssue = {
  /** The message with numbers, IDs, addresses, and quoted values replaced by placeholders. */
  template: string;
  level: string;
  count: number;
  firstLine: number;
};

export type LogProfile = {
  levels: Record<string, number>;
  firstTimestamp?: string;
  lastTimestamp?: string;
  /** The most frequent ERROR/FATAL/WARN message shapes. */
  topIssues: LogIssue[];
};

export type DocumentMeta = {
  id: string;
  /** Who may use this document. Set it at ingest; access with another owner is refused. */
  owner?: string;
  name: string;
  mimeType: string;
  format: DocumentFormat;
  /** Size of the uploaded file. */
  bytes: number;
  /** UTF-8 size of the extracted text. */
  textBytes: number;
  characters: number;
  lines: number;
  estimatedTokens: number;
  /** Lines longer than the wrap limit are split so every line stays readable by line number. */
  wrappedLines: number;
  pages?: number;
  /**
   * True when the uploaded file itself is kept in the store next to its text (see `keepOriginals`).
   * Recorded here so that planning a request does not have to load the file to know.
   */
  originalKept?: boolean;
  outline: OutlineEntry[];
  logProfile?: LogProfile;
  createdAt: string;
  expiresAt: string;
};

export type StoredDocument = { meta: DocumentMeta; text: string };

/** A JSON-safe summary for API responses and browser state. */
export type DocumentSummary = {
  id: string;
  name: string;
  mimeType: string;
  format: DocumentFormat;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  pages?: number;
  expiresAt: string;
};

/** Where extracted text lives. Implement this for Redis, S3, a database, etc. */
export interface DocumentStore {
  put(document: StoredDocument): Promise<void>;
  /** Returns undefined for unknown or expired documents. */
  get(id: string): Promise<StoredDocument | undefined>;
  getMeta(id: string): Promise<DocumentMeta | undefined>;
  /** Removes the document, and its original file if one is kept. */
  delete(id: string): Promise<boolean>;
  /** Removes expired documents (and their original files) and returns how many were removed. */
  sweep?(now?: Date): Promise<number>;
  /**
   * Keeps the uploaded file of a document. It is called before `put` for the same ID. Optional: a
   * store without it works as before, and original files are then not kept.
   */
  putOriginal?(id: string, bytes: Uint8Array): Promise<void>;
  /** The uploaded file, or undefined when none was kept or the document is unknown or expired. */
  getOriginal?(id: string): Promise<Uint8Array | undefined>;
}

export type ExtractedText = { text: string; pages?: number };

export type ExtractInput = {
  name: string;
  mimeType: string;
  format: DocumentFormat;
  /**
   * Set when a PDF without any text (a scan) is worth storing, because its pages can be shown to
   * the model: the most pages such a PDF may have. Unset, a PDF without text is refused, as it
   * always was. An extractor of your own may ignore it.
   */
  scannedPages?: number;
};

export type Extractor = (bytes: Uint8Array, input: ExtractInput) => Promise<ExtractedText>;

/** The limits of the model connection the documents must fit through. */
export type Budget = {
  /** The model's context window, in tokens. */
  contextTokens: number;
  /** The largest request body the model connector accepts, in bytes. */
  maxRequestBytes: number;
  /** The most document text to include in full in one request, in tokens. */
  inlineTokens: number;
  /** Tokens kept free for the answer, tool results, and conversation growth. */
  reservedTokens: number;
  /** Size of each part when a whole document is read with map-reduce. */
  mapChunkTokens: number;
  /** Refuse whole-document reads that would need more parts than this. */
  maxMapChunks: number;
  /** Cap on the characters of one tool result sent back to the model. */
  toolResultCharacters: number;
};

/** A JSON Schema subset accepted by Gemini, OpenAI, and Anthropic function declarations. */
export type JsonSchema = {
  type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

export type ToolDeclaration = {
  name: string;
  description: string;
  parameters: JsonSchema & { type: "object" };
};

export type ToolResult = Record<string, unknown>;

/** A file a tool hands back next to its JSON result, for example pages cut out of a PDF. */
export type ToolFile = {
  /** A short ASCII name, unique among the files of one result: "pages-12-14.pdf". */
  name: string;
  mimeType: string;
  bytes: Uint8Array;
};

/** A tool's JSON result, and the files that belong to it. Most tools return no files. */
export type ToolOutput = { result: ToolResult; files: ToolFile[] };

/** What a call that can return files is allowed to use of the request it will be sent in. */
export type ToolFileLimits = {
  /**
   * The most bytes the files of this call may have together. Give the room left in your request,
   * times 3/4 when files are sent as base64. Defaults to about a third of `maxRequestBytes`.
   */
  maxFileBytes?: number;
  /** The most pages this call may show. Lower it as the pages already shown use up your token budget. */
  maxPages?: number;
};

export type ToolSet = {
  declarations: ToolDeclaration[];
  has(name: string): boolean;
  /**
   * Runs a tool call. Bad arguments come back as `{ error }` so the model can correct itself. A
   * tool that returns files (`view_pages`) answers with an error here: use `executeWithFiles`.
   */
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /**
   * Runs a tool call and also returns the files it produced, to be sent to the model with the
   * result. Use it in place of `execute` in a loop that can send files.
   */
  executeWithFiles(name: string, args: Record<string, unknown>, limits?: ToolFileLimits): Promise<ToolOutput>;
  /** A short, human-readable line describing a call, for progress UIs. */
  describe(name: string, args: Record<string, unknown>): string;
};

/** A plain text completion. The package stays provider-neutral by taking this as a function. */
export type GenerateText = (request: {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /**
   * Call this when the model stopped because it reached `maxOutputTokens`, so a whole-document
   * read can say its result is incomplete. Optional: an implementation that never calls it works
   * as before, without that warning.
   */
  onTruncated?: () => void;
}) => Promise<string>;

export type ProgressEvent = {
  kind: "map" | "reduce";
  message: string;
  done: number;
  total: number;
};

export type ProgressListener = (event: ProgressEvent) => void;

export type DocumentPlan = {
  /** Documents whose full text goes into the prompt. */
  inline: DocumentMeta[];
  /** Documents the model reaches only through tools. */
  searchable: DocumentMeta[];
  inlineTokens: number;
  inlineBytes: number;
};

export type PreparedContext = {
  plan: DocumentPlan;
  /** Prompt text per document ID: the full text for inline documents, a summary card otherwise. */
  blocks: Map<string, string>;
  /** System instruction to add when any document is searchable or viewable, else an empty string. */
  instruction: string;
  /** IDs that were not found (never uploaded, deleted, or expired). */
  missing: string[];
  /**
   * PDFs whose pages `view_pages` can show: their original file is kept. Empty unless `prepare`
   * was called with `viewPages: true`. Pass it to `tools(..., { viewPages })`.
   */
  viewable: DocumentMeta[];
};
