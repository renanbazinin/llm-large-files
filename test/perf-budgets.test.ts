// The performance budgets of scripts/perf.ts: its bars against the table of docs/measurements.md,
// the uploads it measures, how it reads its runs, and the CI job that runs it. The measures
// themselves run in that job (npm run perf), never here: importing the script spawns nothing.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUDGETS, UPLOAD_BYTES, uploadLog, verdicts, type Budget } from "../scripts/perf.js";
import { code, jobsOf, workflow } from "./workflows.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const budget = (id: string): Budget => BUDGETS.find((one) => one.id === id)!;

describe("the performance budgets (scripts/perf.ts, 0.99.9)", () => {
  it("lists the bars that docs/measurements.md lists, one for one, in order", () => {
    const page = readFileSync(path.join(ROOT, "docs", "measurements.md"), "utf8");
    const start = page.indexOf("\n## Performance budgets (0.99.9)\n");
    expect(start, "a section \"Performance budgets (0.99.9)\" in docs/measurements.md").toBeGreaterThan(0);
    const end = page.indexOf("\n## ", start + 1);
    const section = page.slice(start, end === -1 ? page.length : end);
    const rows = [...section.matchAll(/^\| `([a-z]+\.[A-Za-z]+)`[^|]*\| ([\d,.]+) (s|ms|MB) \|/gm)].map((match) => [match[1], Number(match[2]!.replaceAll(",", "")), match[3]]);
    expect(rows).toEqual(BUDGETS.map((one) => [one.id, one.bar, one.unit]));
    for (const one of BUDGETS) expect(one.id).toBe(`${one.measure}.${one.field}`);
  });

  it("makes the uploads the bars were set on: whole lines, 1,999,969 bytes, every tenth line in Hebrew", () => {
    const pinned: Record<number, string> = {
      0: "f03d72f83b024561198979bb03e8c7cdd2130ceb044de3407c75a1654d3e7c2a",
      99: "8ee00754ac76140258b7f3541094474ba2aae7f527f10dcc241c09e930f1e850",
    };
    for (const index of [0, 99]) {
      const bytes = uploadLog(index);
      expect(bytes.byteLength).toBe(UPLOAD_BYTES);
      const lines = bytes.toString("utf8").split("\n");
      expect(lines).toHaveLength(21_251);
      expect(lines.filter((line) => line.includes("מה הסטטוס של ההזמנה שלי"))).toHaveLength(2_125);
      expect(lines.filter((line) => !/^2026-11-1\dT\d\d:\d\d:\d\d\.\d{3}Z (INFO|WARN|ERROR) \[/.test(line))).toEqual([]);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(pinned[index]);
    }
    expect(uploadLog(0).equals(uploadLog(0))).toBe(true);
    expect(uploadLog(0).equals(uploadLog(1))).toBe(false);
  });

  it("takes the best run of a budget, and fails it only when every run is over its bar", () => {
    const allSeconds = budget("uploads.allSeconds");
    expect(verdicts({ uploads: [{ allSeconds: 120 }, { allSeconds: 90 }] }, [allSeconds])).toEqual([{ budget: allSeconds, value: 90, runs: 2, passed: true }]);
    expect(verdicts({ uploads: [{ allSeconds: 120 }, { allSeconds: 110 }] }, [allSeconds])).toEqual([{ budget: allSeconds, value: 110, runs: 2, passed: false }]);
    // At the bar is within it.
    expect(verdicts({ uploads: [{ allSeconds: 105 }] }, [allSeconds])[0]).toMatchObject({ value: 105, runs: 1, passed: true });
  });

  it("leaves a memory budget unmeasured off Linux, and still checks the heap", () => {
    const [peak, heapAfter] = verdicts({ uploads: [{ peakMB: null, heapAfterMB: 7.8 }] }, [budget("uploads.peakMB"), budget("uploads.heapAfterMB")]);
    expect(peak).toMatchObject({ value: undefined, runs: 1, passed: undefined });
    expect(heapAfter).toMatchObject({ value: 7.8, runs: 1, passed: true });
    // A measure with no runs (a run that stopped before it) leaves its budgets unmeasured.
    const unmeasured = verdicts({ uploads: [{ allSeconds: 30 }] }).filter((verdict) => verdict.budget.measure !== "uploads");
    expect(unmeasured).toHaveLength(7);
    for (const verdict of unmeasured) expect(verdict).toMatchObject({ value: undefined, runs: 0, passed: undefined });
  });

  it("runs in a job of its own in CI: Ubuntu, Node 22, npm run perf, a time limit, the report kept", () => {
    const job = jobsOf(workflow("ci.yml")).perf;
    expect(job, "a perf job in ci.yml").toBeDefined();
    const lines = code(job!);
    for (const text of ["runs-on: ubuntu-latest", "timeout-minutes:", "node-version: 22", "npm run perf"]) expect(lines).toContain(text);
    for (const text of ["matrix:", "secrets.", "continue-on-error"]) expect(lines).not.toContain(text);
    expect(lines).toMatch(/upload-artifact@[0-9a-f]{40}[\s\S]*name: perf/);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; files: string[] };
    expect(pkg.scripts.perf?.startsWith("npm run build && node scripts/perf.ts")).toBe(true);
    for (const name of ["test", "check", "prepublishOnly"]) expect(pkg.scripts[name]).not.toContain("perf");
    expect(pkg.files.some((entry) => entry.startsWith("scripts"))).toBe(false);
  });
});
