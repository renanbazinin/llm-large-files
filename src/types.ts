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
  delete(id: string): Promise<boolean>;
  /** Removes expired documents and returns how many were removed. */
  sweep?(now?: Date): Promise<number>;
}

export type ExtractedText = { text: string; pages?: number };

export type ExtractInput = {
  name: string;
  mimeType: string;
  format: DocumentFormat;
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

export type ToolSet = {
  declarations: ToolDeclaration[];
  has(name: string): boolean;
  /** Runs a tool call. Bad arguments come back as `{ error }` so the model can correct itself. */
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
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
  /** System instruction to add when any document is searchable, else an empty string. */
  instruction: string;
  /** IDs that were not found (never uploaded, deleted, or expired). */
  missing: string[];
};
