import { logTemplate } from "./analyze.js";
import { sliceWhole } from "./text.js";

/**
 * How `search_document` counts matching lines by group (`group_by`):
 * - "capture": by the text of the regex's first group (`PAY-(\d+)` counts each code);
 * - "minute", "hour", "day": by the first timestamp on the line, as written there;
 * - "shape": by the line with its numbers, IDs, addresses and quoted values replaced by
 *   placeholders, as the log profile groups problems.
 */
export type GroupBy = "capture" | "minute" | "hour" | "day" | "shape";

export const GROUP_BY_VALUES: readonly GroupBy[] = ["capture", "minute", "hour", "day", "shape"];

/** One group of matching lines. */
export type GroupCount = { key: string; count: number; firstLine: number; lastLine: number };

/** Distinct groups counted one by one, at most: lines of further groups are counted together, in `otherCount`. */
export const MAX_GROUP_KEYS = 10_000;
/** A key is cut to this many characters: a capture or a shape can be a whole line. */
const MAX_KEY_CHARACTERS = 120;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * The timestamps a log line may start or hold, each with the parts it gives. The first that matches
 * the line is used, at the first place it matches. The time is taken as written, in the zone the
 * line was written in: an offset (`+02:00`, `Z`) is not applied.
 */
const STAMPS: Array<{ pattern: RegExp; parts: (match: RegExpExecArray) => TimeParts | undefined }> = [
  // 2026-11-10T14:03:17Z, 2026-11-10 14:03:17,123, 2026/11/10 14:03:17 (nginx's error log).
  {
    pattern: /(?<![\d.])(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})/,
    parts: (match) => ({ year: match[1]!, month: match[2]!, day: match[3]!, hour: match[4]!, minute: match[5]! }),
  },
  // 10/Nov/2026:14:03:17 +0000 (the access logs of Apache and nginx).
  {
    pattern: /(?<!\d)(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2})/,
    parts: (match) => {
      const month = MONTHS[match[2]!.toLowerCase()];
      return month ? { year: match[3]!, month, day: match[1]!, hour: match[4]!, minute: match[5]! } : undefined;
    },
  },
  // "time":1731247397123 or "ts":1731247397 (pino, bunyan and other JSON logs give epoch time).
  {
    pattern: /"(?:time|ts|timestamp|@timestamp)"\s*:\s*(\d{10}(?:\d{3})?)(?![\d.])/,
    parts: (match) => {
      const value = Number(match[1]!);
      const date = new Date(match[1]!.length === 13 ? value : value * 1_000);
      if (Number.isNaN(date.getTime())) return undefined;
      const iso = date.toISOString();
      return { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10), hour: iso.slice(11, 13), minute: iso.slice(14, 16) };
    },
  },
  // 10.11.2026 14:03 and 10/11/2026 14:03: day and month as written, as the order cannot be told.
  {
    pattern: /(?<![\d.])(\d{1,2})([./])(\d{1,2})\2(\d{4})[ T,]+(\d{1,2}):(\d{2})/,
    parts: (match) => ({ year: match[4]!, month: match[3]!.padStart(2, "0"), day: match[1]!.padStart(2, "0"), hour: match[5]!.padStart(2, "0"), minute: match[6]!, order: match[2] === "." ? "dmy" : "as-written" }),
  },
  // Nov 10 14:03:17 (syslog), with no year.
  {
    pattern: /(?<![A-Za-z])([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):\d{2}/,
    parts: (match) => {
      const month = MONTHS[match[1]!.toLowerCase()];
      return month ? { month, day: match[2]!.padStart(2, "0"), hour: match[3]!, minute: match[4]! } : undefined;
    },
  },
  // I1110 14:03:17.123456 (klog, glog): the level letter, month and day, with no year.
  {
    pattern: /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):\d{2}/,
    parts: (match) => ({ month: match[1]!, day: match[2]!, hour: match[3]!, minute: match[4]! }),
  },
];

type TimeParts = { year?: string; month: string; day: string; hour: string; minute: string; order?: "dmy" | "as-written" };

/** The date of a timestamp's parts as a key: "2026-11-10", "11-10" without a year, "10/11/2026" when day and month cannot be told apart. */
function dateKey(parts: TimeParts): string {
  if (parts.order === "as-written") return `${parts.day}/${parts.month}/${parts.year}`;
  return parts.year ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.month}-${parts.day}`;
}

/**
 * The group of a line by its first timestamp: "2026-11-10" for a day, "2026-11-10 14:00" for an
 * hour, "2026-11-10 14:03" for a minute. Undefined for a line without a timestamp.
 */
export function timeKey(line: string, unit: "minute" | "hour" | "day"): string | undefined {
  for (const { pattern, parts: partsOf } of STAMPS) {
    const match = pattern.exec(line);
    if (!match) continue;
    const parts = partsOf(match);
    if (!parts) continue;
    const date = dateKey(parts);
    return unit === "day" ? date : `${date} ${parts.hour}:${unit === "hour" ? "00" : parts.minute}`;
  }
  return undefined;
}

/** What `GroupCounter.result()` gives. */
export type GroupResult = {
  /** The groups, largest first; by time, the order of their first lines. */
  groups: GroupCount[];
  /** Distinct groups counted, at most `MAX_GROUP_KEYS`. */
  totalGroups: number;
  /** Matching lines of further groups, past `MAX_GROUP_KEYS`. */
  otherCount: number;
  /** Matching lines that have no key: no timestamp, or a regex group that took part in no match. */
  ungrouped: number;
};

/** Counts matching lines by group, one line at a time. */
export class GroupCounter {
  private readonly groups = new Map<string, GroupCount>();
  private otherCount = 0;
  private ungrouped = 0;

  constructor(readonly by: GroupBy) {}

  /** A matching line, and for "capture" the text of the regex's first group, if it took part. */
  add(line: number, text: string, capture?: string): void {
    this.addKey(line, this.keyOf(text, capture));
  }

  /**
   * A matching line by its key, worked out before with `keyOf`. A regex search works the keys out
   * within its time limit, which can stop it anywhere, and adds them after: a stop never leaves a
   * count half done.
   */
  addKey(line: number, key: string | undefined): void {
    if (key === undefined) {
      this.ungrouped++;
      return;
    }
    const group = this.groups.get(key);
    if (group) {
      group.count++;
      group.lastLine = line;
    } else if (this.groups.size < MAX_GROUP_KEYS) {
      this.groups.set(key, { key, count: 1, firstLine: line, lastLine: line });
    } else {
      this.otherCount++;
    }
  }

  /** The group of a matching line: undefined for a line without one (see `GroupResult.ungrouped`). */
  keyOf(text: string, capture: string | undefined): string | undefined {
    if (this.by === "capture") return capture === undefined ? undefined : sliceWhole(capture, MAX_KEY_CHARACTERS);
    if (this.by === "shape") return sliceWhole(logTemplate(text), MAX_KEY_CHARACTERS) || undefined;
    return timeKey(text, this.by);
  }

  result(): GroupResult {
    const byTime = this.by === "minute" || this.by === "hour" || this.by === "day";
    const groups = [...this.groups.values()].sort(byTime
      ? (left, right) => left.firstLine - right.firstLine
      : (left, right) => right.count - left.count || left.firstLine - right.firstLine);
    return { groups, totalGroups: this.groups.size, otherCount: this.otherCount, ungrouped: this.ungrouped };
  }
}
