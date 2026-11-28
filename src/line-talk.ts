// What talk of lines is left in a shown answer, split into harmless and harmful (CIT-6): counts
// and hashes only, never text of the answer or the files. Ported from the review's line-talk.mjs,
// which is its specification. New in 0.99.14.
import { createHash } from "node:crypto";
import type { DocumentFormat } from "./types.js";
import type { LineTalk } from "./sources.js";

/** A file of the question as the count reads it: its line `n` from `lineAt`, or "" when its text is not in hand. */
export type LineTalkFile = { id: string; name: string; format: DocumentFormat; lines: number; wrappedLines: number; lineAt?: (line: number) => string | undefined };

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const NUMBER = String.raw`\d{1,6}`;
const more = (separator: string) => String.raw`((?:\s*(?:${separator})\s*L?${NUMBER})*)`;
const FORMS: Array<{ word: "L" | "line" | "row" | "שורה" | "copy"; pattern: RegExp }> = [
  { word: "L", pattern: new RegExp(String.raw`(?<![\p{L}\p{N}_])[Ll] ?(${NUMBER})${more(String.raw`[-–—־,]|and|ו-?`)}(?![\p{L}\p{N}_])`, "gu") },
  { word: "line", pattern: new RegExp(String.raw`(?<![\p{L}\p{N}_])lines?\s+(?:no\.?\s*|number\s*)?(${NUMBER})${more(String.raw`[-–—,]|to|and`)}`, "giu") },
  { word: "row", pattern: new RegExp(String.raw`(?<![\p{L}\p{N}_])rows?\s+(?:no\.?\s*|number\s*)?(${NUMBER})${more(String.raw`[-–—,]|to|and`)}`, "giu") },
  { word: "שורה", pattern: new RegExp(String.raw`(?<![\p{L}\p{N}_])[בלמוהכש]{0,2}שור(?:ה|ות)\s+(?:(?:מס['׳"]?|מספר)\s*)?(${NUMBER})${more(String.raw`[-–—־,]|עד|ו-?|ל-?`)}`, "gu") },
  { word: "copy", pattern: /^\s*(\d{1,6})\|\s()/gmu },
];
const normalized = (text: string) => text.normalize("NFC").replace(/[‎‏‪-‮֑-ׇ]/g, "").replace(/(?<=\d),(?=\d{3})/g, "");
/** The cells of a line that name something: a number of 2 digits or more, or several words. */
const cellsOf = (line: string | undefined) => (line ?? "").replace(/^Row \d+:/, "").split(/[|,]/).map((cell) => normalized(cell.trim())).filter((cell) => cell.length >= 2 && (/\d{2,}/.test(cell) || /\s/.test(cell)));

type Kind = keyof LineTalk["left"]["harmless"] | keyof LineTalk["left"]["harmful"];

/** The line and row numbers left in `text`, judged against `files`. */
export function lineTalkOf(text: string, files: readonly LineTalkFile[]): Pick<LineTalk, "verdict" | "left"> {
  const left: LineTalk["left"] = {
    mentions: 0,
    numbers: 0,
    harmfulMentions: 0,
    harmless: { logLine: 0, excelRow: 0, csvRow: 0 },
    harmful: { wrongWorkbookRow: 0, workbookTextLine: 0, documentLine: 0, csvShifted: 0, outOfRange: 0, unattributed: 0 },
    hashes: [],
  };
  const answer = sha(text);
  const plainText = normalized(text);
  const lineAt = (file: LineTalkFile, line: number) => file.lineAt?.(line) ?? "";
  // The first line of a CSV that starts inside a quoted field: rows and lines part from there.
  const breaks = new Map<string, number>();
  const firstBreak = (file: LineTalkFile) => {
    let at = breaks.get(file.id);
    if (at !== undefined) return at;
    at = Infinity;
    if (!file.lineAt) at = 0;
    else {
      let open = false;
      for (let line = 1; line <= file.lines; line++) {
        if (open) {
          at = line;
          break;
        }
        if (((lineAt(file, line).match(/"/g) ?? []).length) % 2) open = !open;
      }
    }
    breaks.set(file.id, at);
    return at;
  };
  const rowLines = new Map<string, number>();
  const lineOfRow = (file: LineTalkFile, row: number) => {
    const key = `${file.id}|${row}`;
    let at = rowLines.get(key);
    if (at !== undefined) return at;
    at = 0;
    for (let line = 1; line <= file.lines; line++) {
      if (lineAt(file, line).startsWith(`Row ${row}:`)) {
        at = line;
        break;
      }
    }
    rowLines.set(key, at);
    return at;
  };
  let offset = 0;
  for (const line of plainText.split("\n")) {
    const taken: Array<[number, number]> = [];
    for (const { word, pattern } of FORMS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (taken.some(([from, to]) => start < to && from < end)) continue;
        taken.push([start, end]);
        const numbers = [Number(match[1]), ...[...(match[2] ?? "").matchAll(/\d{1,6}/g)].map((found) => Number(found[0]))];
        // The file: one named on the line, the nearest; else the only file; else the only one the numbers fit.
        const named = files
          .map((file) => {
            const places = [file.name, file.id].map((name) => line.indexOf(name)).filter((index) => index >= 0);
            return places.length ? { file, distance: Math.min(...places.map((index) => Math.abs(index - start))) } : undefined;
          })
          .filter((found): found is { file: LineTalkFile; distance: number } => found !== undefined)
          .sort((one, other) => one.distance - other.distance);
        let file = named[0]?.file ?? (files.length === 1 ? files[0] : undefined);
        if (!file) {
          const fit = files.filter((one) => numbers.every((number) => number <= one.lines));
          if (fit.length === 1) file = fit[0];
        }
        left.mentions++;
        left.numbers += numbers.length;
        left.hashes.push(sha(`${answer}|${offset + start}|${word}`));
        const verdicts: Kind[] = numbers.map((number): Kind => {
          if (!file) return "unattributed";
          if (number < 1 || number > file.lines) return "outOfRange";
          if (file.format === "log") return file.wrappedLines ? "documentLine" : "logLine";
          if (file.format === "csv") return file.wrappedLines || number >= firstBreak(file) ? "csvShifted" : "csvRow";
          if (file.format === "xlsx") {
            if (word === "L" || word === "line" || word === "copy") return "workbookTextLine";
            const rowLine = lineOfRow(file, number);
            if (!rowLine) return "wrongWorkbookRow";
            const sentence = `${line.slice(0, start)} ${line.slice(end)}`;
            const asLine = cellsOf(lineAt(file, number)).filter((cell) => sentence.includes(cell)).length;
            const asRow = cellsOf(lineAt(file, rowLine)).filter((cell) => sentence.includes(cell)).length;
            return asRow > asLine || (asRow === asLine && word === "row") ? "excelRow" : "wrongWorkbookRow";
          }
          return "documentLine";
        });
        const bad = verdicts.filter((verdict): verdict is keyof LineTalk["left"]["harmful"] => verdict in left.harmful);
        if (bad.length) {
          left.harmfulMentions++;
          for (const verdict of new Set(bad)) left.harmful[verdict]++;
        } else for (const verdict of new Set(verdicts)) left.harmless[verdict as keyof LineTalk["left"]["harmless"]]++;
      }
    }
    offset += line.length + 1;
  }
  return { verdict: left.harmfulMentions ? "harmful" : left.mentions ? "harmless" : "none", left };
}
