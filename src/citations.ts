// The line citations of an answer, checked against what the tools showed the model. New in 0.10.0:
// the types are here, and `checkCitations` is not written yet.
import type { Evidence } from "./evidence.js";
import type { DocumentFormat } from "./types.js";

/** What `checkCitations` found in an answer (`AskResult.citations`). New in 0.10.0. */
export type CitationCheck = {
  /** Citations matched to a file and a line. */
  checked: number;
  /** Of those, the ones inside what the tools showed. A file sent whole counts as shown. */
  supported: number;
  /** Citations recognized but not matched: no file name when there are several files, or the row of a workbook. */
  unchecked: number;
  /** The citations of lines the tools did not show: the document's name, and the line. */
  unsupported: Array<{ document: string; line: number }>;
};

/**
 * Finds the line citations of `text` ("(name L12)", "(name L12-14)", the Hebrew forms) and checks
 * them against `evidence`. `names` gives each document ID's file name, and `formats` its format.
 * New in 0.10.0. Not written yet: it throws.
 */
export function checkCitations(text: string, evidence: Evidence[], names: Record<string, string>, formats?: Record<string, DocumentFormat>): CitationCheck {
  void [text, evidence, names, formats];
  throw new Error("checkCitations() is not available yet.");
}
