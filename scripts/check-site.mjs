#!/usr/bin/env node
// Checks the landing page in site/ (the "check" job of .github/workflows/pages.yml). The page is
// hand-written and has no build, so what a build would catch is caught here. A problem is printed
// with the file and the line, and the script exits 1; otherwise each check prints one line.
//
//   node scripts/check-site.mjs               # site/
//   node scripts/check-site.mjs path/to/copy  # another copy of the folder
//
// Needs the checkout's dev dependencies (npm ci) for the first check, and no build.
//
// What is checked, in site/index.html and the files it loads:
//   samples    Every <code class="language-ts"> compiles against src/. The samples are written as
//              fenced blocks into a Markdown file in the system's temporary folder, each at the
//              line it has in index.html, and scripts/check-doc-samples.mjs compiles that file:
//              its header says what a sample may leave out.
//   sources    The text of every <pre data-src="README.md"> is a fenced block of README.md,
//              character for character (white space at the end of a line or of the block aside).
//   specimens  What the page shows as recorded is in site/data/run.json. The attribute names the
//              value by its dot path ("main.result.steps.2"; the longest key wins where a key has
//              a dot of its own), and the element's text, without tags, must be:
//                data-rec          that value, runs of white space taken as one space. A string as
//                                  it is; a number or a boolean as JSON prints it, a number also
//                                  with thousands separators ("142,492"); an object or an array as
//                                  JSON.stringify(value, null, 2).
//                data-rec-num      a number, as above.
//                data-rec-excerpt  lines of that value (of its JSON, when it is not a string), in
//                                  their order. A line that holds only "…" stands for one or more
//                                  lines left out; lines with no "…" between them follow each
//                                  other in the value, and an excerpt that starts after the first
//                                  line or stops before the last says so with a "…".
//   links      Every relative href and src is a file of the folder, and none starts with "/" (the
//              page is served under a subpath). Every href="#id", every label's for and every
//              aria-labelledby, aria-describedby and aria-controls has its id, and no id is there
//              twice. Every link to blob/main/<path> or tree/main/<path> of the repository on
//              GitHub names a path of the checkout, and one that ends in #heading names a heading
//              of that Markdown file. The relative url() of the stylesheets and the relative
//              imports of the scripts are files too.
//   requests   The page loads nothing from another origin: no script, stylesheet, icon, preload,
//              image, source, iframe, object, video, audio, embed or track with an absolute or
//              protocol-relative URL; no url(http…) and no @import in the CSS; no fetch(,
//              XMLHttpRequest, WebSocket, sendBeacon, EventSource or import of a URL in the
//              scripts. An ordinary <a href="https://…"> is a link, not a request.
//   weight     The files of the folder, data/ and what starts with a dot aside (.github/workflows/
//              pages.yml leaves dot files out of the deployment), total under 350,000 bytes.
//   shape      Every tag is closed by its own end tag; there is exactly one <h1>; every <img> has
//              an alt; and the page's own words (what it quotes from the recording or from a
//              data-src file aside) hold none of the words the page's voice does without, no em
//              dash, and not the token estimate of 0.1.0 ("1.27M").
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "https://github.com/renanbazinin/llm-large-files";
const MAX_BYTES = 350_000;
/** No hype: the words the docs do without, and the token estimate of 0.1.0, which counted logs low. */
const AVOIDED = ["blazing", "seamless", "supercharge", "revolutionary", "effortless", "powerful", "unlock", "magic", "game-changing", "cutting-edge", "robust", "simply", "just"];
const AVOIDED_FIGURE = "1.27M";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toPosix = (path) => path.split(sep).join("/");
const site = resolve(process.argv[2] ?? join(checkout, "site"));
/** A file of the folder, as the messages name it: "site/index.html". */
const named = (path) => {
  const fromCheckout = relative(checkout, path);
  return toPosix(fromCheckout.startsWith("..") || isAbsolute(fromCheckout) ? path : fromCheckout);
};
const pagePath = join(site, "index.html");
const page = named(pagePath);
const thousands = (number) => number.toLocaleString("en-US");

const problems = [];
const passed = [];
const problem = (file, line, message) => problems.push(`${file}${line ? `:${line}` : ""}  ${message}`);
/** Runs one check: it reports its problems itself, and returns the line to print when it found none. */
function check(name, run) {
  const before = problems.length;
  const summary = run();
  if (problems.length === before) passed.push(`${name.padEnd(10)} ${summary}`);
}

if (!existsSync(pagePath)) {
  console.error(`${page}  There is no such file.`);
  process.exit(1);
}
const html = readFileSync(pagePath, "utf8");

// ---------------------------------------------------------------------------------------------
// The page, read as a tree of elements. Enough of HTML for a page written by hand: every element
// is closed by its end tag (a void element and a self-closed SVG shape aside), and the text of
// <script> and <style> is not markup.
// ---------------------------------------------------------------------------------------------

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", middot: "·", hellip: "…", times: "×", rarr: "→", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };
const decode = (text) =>
  text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (entity, decimal, hex, name) =>
    decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (NAMED_ENTITIES[name] ?? entity),
  );

const lineStarts = [0];
for (let index = html.indexOf("\n"); index >= 0; index = html.indexOf("\n", index + 1)) lineStarts.push(index + 1);
/** The line of an offset, counted from 1. */
function lineOf(offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Every element in document order: { tag, attrs, line, start, openEnd, closeStart, end, parent }. */
function parse() {
  const elements = [];
  /** [start, end) of everything that is markup and not text: tags, comments, scripts and styles. */
  const markup = [];
  const open = [];
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(html); match; match = TOKEN.exec(html)) {
    const start = match.index;
    const end = start + match[0].length;
    markup.push([start, end]);
    if (match[1]) {
      const tag = match[1].toLowerCase();
      const at = open.findLastIndex((element) => element.tag === tag);
      if (at < 0) {
        problem(page, lineOf(start), `</${tag}> closes nothing: no <${tag}> is open here.`);
        continue;
      }
      // What was opened inside it and not closed ends here, and is said once.
      for (const unclosed of open.splice(at + 1)) {
        problem(page, unclosed.line, `This <${unclosed.tag}> is not closed: the </${tag}> of line ${lineOf(start)} closes the <${tag}> of line ${open[at].line}, around it.`);
        unclosed.closeStart = start;
        unclosed.end = start;
      }
      const element = open.pop();
      element.closeStart = start;
      element.end = end;
    } else if (match[2]) {
      const tag = match[2].toLowerCase();
      const attrs = {};
      for (const [, name, double, single, bare] of (match[3] ?? "").matchAll(ATTRIBUTE)) attrs[name.toLowerCase()] = decode(double ?? single ?? bare ?? "");
      const element = { tag, attrs, line: lineOf(start), start, openEnd: end, closeStart: end, end, parent: open.at(-1) };
      elements.push(element);
      if (VOID.has(tag) || match[4]) continue;
      if (tag === "script" || tag === "style") {
        const close = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(end));
        if (!close) {
          problem(page, element.line, `This <${tag}> is never closed.`);
          break;
        }
        element.closeStart = end + close.index;
        element.end = element.closeStart + close[0].length;
        markup.push([end, element.end]);
        TOKEN.lastIndex = element.end;
      } else open.push(element);
    }
  }
  for (const element of open) problem(page, element.line, `This <${element.tag}> is never closed.`);
  return { elements, markup };
}

const { elements, markup } = parse();
const parsedWhole = problems.length === 0;
const within = (element, ancestor) => element.start >= ancestor.start && element.end <= ancestor.end;
const hasClass = (element, name) => (element.attrs.class ?? "").split(/\s+/).includes(name);

/** The text of an element as a browser has it in textContent: no tags, no comments, entities decoded. */
function textOf(element) {
  let inner = "";
  let at = element.openEnd;
  for (const [start, end] of markup) {
    if (end <= element.openEnd) continue;
    if (start >= element.closeStart) break;
    inner += html.slice(at, start);
    at = end;
  }
  inner += html.slice(at, element.closeStart);
  // HTML drops a line feed that comes first in a <pre>.
  if (element.tag === "pre" && html[element.openEnd] === "\n") inner = inner.slice(1);
  return decode(inner);
}
const oneSpace = (text) => text.replace(/\s+/g, " ").trim();
const short = (text, length = 90) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// ---------------------------------------------------------------------------------------------
// samples: the TypeScript of the page compiles
// ---------------------------------------------------------------------------------------------

check("samples", () => {
  const samples = elements.filter((element) => element.tag === "code" && hasClass(element, "language-ts"));
  if (samples.length === 0) return "no TypeScript sample on the page";
  const lines = [];
  /** For each sample: where it starts in the Markdown file, and where it starts in the page. */
  const placed = [];
  for (const sample of samples) {
    const text = textOf(sample).replace(/\s+$/, "");
    const pageLine = lineOf(sample.openEnd);
    const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
    while (lines.length < pageLine - 2) lines.push("");
    lines.push(`${fence}ts`);
    placed.push({ markdownLine: lines.length + 1, pageLine });
    lines.push(...text.split("\n"), fence);
  }
  const folder = mkdtempSync(join(tmpdir(), "check-site-"));
  const markdown = join(folder, "index.md");
  try {
    writeFileSync(markdown, `${lines.join("\n")}\n`);
    const run = spawnSync(process.execPath, [join(checkout, "scripts", "check-doc-samples.mjs"), markdown], { encoding: "utf8" });
    // As check-doc-samples.mjs names the file: by its path from the checkout.
    const names = [toPosix(relative(checkout, markdown)), toPosix(markdown), markdown];
    /** A line of the Markdown file is a line of the page: the same one, unless two samples were too close. */
    const toPageLine = (line) => {
      const sample = placed.findLast((entry) => entry.markdownLine <= Number(line));
      return sample ? Number(line) - sample.markdownLine + sample.pageLine : Number(line);
    };
    const said = (text) => {
      let out = text;
      for (const name of names) out = out.split(name).join(page);
      return out
        .replace(new RegExp(`${page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`, "g"), (_, line) => `${page}:${toPageLine(line)}`)
        .replace(/\(sample at line (\d+)\)/g, (_, line) => `(sample at line ${toPageLine(line)})`)
        .replace(/of 1 page\(s\)|of 1 pages/, `of ${page}`)
        .trim();
    };
    if (run.status !== 0) {
      const output = said(`${run.stderr ?? ""}${run.error ? `\n${run.error.message}` : ""}`);
      const found = output.split("\n").filter((line) => line.startsWith(`${page}:`));
      if (found.length > 0) for (const line of found) problems.push(line);
      else problem(page, 0, `The samples were not compiled: scripts/check-doc-samples.mjs stopped.\n${output}`);
      return "";
    }
    return said(run.stdout);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// sources: a sample taken from a file of the repository is that file's text
// ---------------------------------------------------------------------------------------------

/** The fenced blocks of a Markdown file: { line, text }, the line being that of the opening fence. */
function fencedBlocks(markdown) {
  const blocks = [];
  let open;
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (!open) {
      const fence = /^\s*(`{3,}|~{3,})\s*[\w-]*\s*$/.exec(line);
      if (fence) open = { marker: fence[1], line: index + 1, body: [] };
      return;
    }
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
      blocks.push({ line: open.line, text: open.body.join("\n") });
      open = undefined;
    } else open.body.push(line);
  });
  return blocks;
}
const sameAtLineEnds = (text) => text.replace(/[ \t]+$/gm, "").replace(/\s+$/, "");

check("sources", () => {
  const quoted = elements.filter((element) => element.tag === "pre" && "data-src" in element.attrs);
  const files = new Map();
  for (const sample of quoted) {
    const source = sample.attrs["data-src"];
    const path = join(checkout, source);
    if (!files.has(source)) files.set(source, existsSync(path) && statSync(path).isFile() ? fencedBlocks(readFileSync(path, "utf8")) : undefined);
    const blocks = files.get(source);
    if (!blocks) {
      problem(page, sample.line, `data-src="${source}" names no file of the checkout.`);
      continue;
    }
    const text = sameAtLineEnds(textOf(sample));
    if (blocks.some((block) => sameAtLineEnds(block.text) === text)) continue;
    // Say where it parts from the block that starts the same way, when there is one.
    const lines = text.split("\n");
    const closest = blocks.find((block) => sameAtLineEnds(block.text).split("\n")[0] === lines[0]);
    if (!closest) {
      problem(page, lineOf(sample.openEnd), `This sample is not a fenced block of ${source}: no block there starts with "${short(lines[0], 70)}". Copy the block again.`);
      continue;
    }
    const theirs = sameAtLineEnds(closest.text).split("\n");
    const at = lines.findIndex((line, index) => line !== theirs[index]);
    const differs = at < 0 ? lines.length : at;
    problem(
      page,
      lineOf(sample.openEnd) + differs,
      `This sample is not the block of ${source}:${closest.line}: ${theirs[differs] === undefined ? `the block ends before "${short(lines[differs] ?? "", 60)}"` : lines[differs] === undefined ? `it stops before ${source}:${closest.line + 1 + differs}, "${short(theirs[differs], 60)}"` : `${source}:${closest.line + 1 + differs} is "${short(theirs[differs], 70)}"`}. Copy the block again.`,
    );
  }
  return `${quoted.length} samples are fenced blocks of ${[...files.keys()].join(", ") || "their files"}, character for character`;
});

// ---------------------------------------------------------------------------------------------
// specimens: what the page shows as recorded is in data/run.json
// ---------------------------------------------------------------------------------------------

const MISSING = Symbol("missing");
/** The value at a dot path. A key may hold dots ("handbook.md"): the longest key that exists wins. */
function valueAt(value, path) {
  const parts = path.split(".");
  let current = value;
  for (let index = 0; index < parts.length; ) {
    if (current === null || typeof current !== "object") return MISSING;
    let taken = 0;
    for (let length = parts.length - index; length >= 1; length--) {
      const key = parts.slice(index, index + length).join(".");
      if (Object.hasOwn(current, key)) {
        current = current[key];
        taken = length;
        break;
      }
    }
    if (taken === 0) return MISSING;
    index += taken;
  }
  return current;
}

/** Why the lines shown are not an excerpt of the value's lines, or undefined when they are. */
function notAnExcerpt(shown, whole) {
  const runs = []; // { lines, at: index in `shown` of its first line }
  const gapBefore = [];
  let pendingGap = false;
  shown.forEach((line, index) => {
    if (line === "…") pendingGap = true;
    else if (pendingGap || runs.length === 0) {
      runs.push({ lines: [line], at: index });
      gapBefore.push(pendingGap);
      pendingGap = false;
    } else runs.at(-1).lines.push(line);
  });
  if (runs.length === 0) return { at: 0, why: "it shows no line of the value" };
  // Each run is placed at the first place it fits after the run before it. The first run starts
  // the value unless a "…" comes before it, and the last run ends it unless a "…" comes after.
  let from = 0;
  for (const [number, run] of runs.entries()) {
    const gap = gapBefore[number];
    const isLast = number === runs.length - 1 && !pendingGap;
    const fits = (start) => start >= 0 && run.lines.every((line, offset) => whole[start + offset] === line);
    const first = gap && number > 0 ? from + 1 : from; // a "…" between two runs stands for a line at least
    const last = !gap ? first : whole.length - run.lines.length;
    let found = -1;
    if (isLast) {
      const end = whole.length - run.lines.length;
      if (end >= first && end <= last && fits(end)) found = end;
    } else {
      for (let start = first; start <= last && found < 0; start++) if (fits(start)) found = start;
    }
    if (found < 0) {
      const miss = run.lines.findIndex((line) => !whole.includes(line));
      if (miss >= 0) return { at: run.at + miss, why: `"${short(run.lines[miss], 70)}" is not a line of the value` };
      const from0 = `the lines from "${short(run.lines[0], 50)}"`;
      const leftOut = 'a line left out needs a line that holds only "…"';
      if (!gap && number === 0) return { at: run.at, why: `${from0} do not start the value, or do not follow each other there: ${leftOut}, at the start too` };
      if (isLast) return { at: run.at + run.lines.length - 1, why: `${from0} do not end the value, or do not follow each other there: ${leftOut}, at the end too` };
      return { at: run.at, why: `${from0} are lines of the value, but not in this order, or not one after the other: ${leftOut}` };
    }
    from = found + run.lines.length;
  }
  if (pendingGap && from === whole.length) return { at: shown.length - 1, why: 'its last "…" stands for no line: the value ends there' };
  return undefined;
}

check("specimens", () => {
  const recordingPath = join(site, "data", "run.json");
  if (!existsSync(recordingPath)) {
    problem(named(recordingPath), 0, "There is no such file: the page's specimens cannot be checked.");
    return "";
  }
  const recording = JSON.parse(readFileSync(recordingPath, "utf8"));
  const count = { "data-rec": 0, "data-rec-num": 0, "data-rec-excerpt": 0 };
  for (const element of elements) {
    for (const attribute of Object.keys(count)) {
      if (!(attribute in element.attrs)) continue;
      count[attribute] += 1;
      const path = element.attrs[attribute];
      const value = valueAt(recording, path);
      const where = `${attribute}="${path}"`;
      if (value === MISSING) {
        problem(page, element.line, `${where}: there is no such value in ${named(recordingPath)}.`);
        continue;
      }
      const text = textOf(element);
      if (attribute === "data-rec-excerpt") {
        const whole = (typeof value === "string" ? value : JSON.stringify(value, null, 2)).split("\n").map((line) => line.trim());
        while (whole.length > 0 && whole.at(-1) === "") whole.pop();
        const shown = text.split("\n").map((line) => line.trim());
        while (shown.length > 0 && shown.at(-1) === "") shown.pop();
        const wrong = notAnExcerpt(shown, whole);
        if (wrong) problem(page, lineOf(element.openEnd) + wrong.at, `${where}: this is not an excerpt of the recorded value: ${wrong.why}.`);
        continue;
      }
      const is = oneSpace(text);
      if (attribute === "data-rec-num" && typeof value !== "number") {
        problem(page, element.line, `${where}: the recorded value is not a number (${short(JSON.stringify(value), 40)}).`);
        continue;
      }
      const accepted = typeof value === "string" ? [oneSpace(value)] : typeof value === "number" ? [JSON.stringify(value), thousands(value)] : [oneSpace(JSON.stringify(value, null, 2))];
      if (accepted.includes(is)) continue;
      // The first place the two part, for a long value.
      const wanted = accepted[0];
      let at = 0;
      while (at < is.length && at < wanted.length && is[at] === wanted[at]) at++;
      const around = (whole) => `${at > 30 ? "…" : ""}${short(whole.slice(Math.max(0, at - 30)), 80)}`;
      problem(page, element.line, `${where}: the page shows "${around(is)}" and the recording has "${around(wanted)}"${typeof value === "number" && accepted[1] !== wanted ? ` (or "${accepted[1]}")` : ""}. The recording is right: correct the page.`);
    }
  }
  const all = count["data-rec"] + count["data-rec-num"] + count["data-rec-excerpt"];
  if (all === 0) problem(page, 0, "The page marks nothing as recorded (data-rec): its specimens are not checked.");
  return `${all} recorded values equal ${named(recordingPath)} (${count["data-rec"]} data-rec, ${count["data-rec-num"]} data-rec-num, ${count["data-rec-excerpt"]} data-rec-excerpt)`;
});

// ---------------------------------------------------------------------------------------------
// The files of the folder that are deployed: data/ aside for the weight, and nothing with a dot
// ---------------------------------------------------------------------------------------------

/** Every file under the folder whose name, and whose folders' names, do not start with a dot. */
function deployed(folder = site) {
  const files = [];
  for (const name of readdirSync(folder).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(folder, name);
    if (statSync(path).isDirectory()) files.push(...deployed(path));
    else files.push(path);
  }
  return files;
}
const files = deployed();
const stylesheets = files.filter((path) => path.endsWith(".css"));
const scripts = files.filter((path) => /\.m?js$/.test(path));
const lineIn = (text, offset) => text.slice(0, offset).split("\n").length;

// ---------------------------------------------------------------------------------------------
// links: every address the page names leads somewhere
// ---------------------------------------------------------------------------------------------

const isAbsoluteUrl = (url) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith("//");
/** Why a relative address is not a file of the folder, or undefined when it is. */
function notAFile(url, from) {
  if (url.startsWith("/")) return 'starts with "/": the page is served under a subpath, so its own files are named from where they are ("./assets/…")';
  const path = resolve(dirname(from), decodeURIComponent(url.replace(/[?#].*$/, "")));
  const inside = relative(site, path);
  if (inside.startsWith("..") || isAbsolute(inside)) return "leads out of the folder";
  if (!existsSync(path) || !statSync(path).isFile()) return `names no file (${named(path)})`;
  return undefined;
}

/** The anchors GitHub gives the headings of a Markdown file. */
function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  let fence;
  for (const line of markdown.split(/\r?\n/)) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (mark && (!fence || (mark[1][0] === fence[0] && mark[1].length >= fence.length))) {
      fence = fence ? undefined : mark[1];
      continue;
    }
    const heading = fence ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = heading[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const times = seen.get(slug) ?? 0;
    seen.set(slug, times + 1);
    anchors.add(times === 0 ? slug : `${slug}-${times}`);
  }
  return anchors;
}

check("links", () => {
  const ids = new Map();
  for (const element of elements) {
    const id = element.attrs.id;
    if (id === undefined) continue;
    if (ids.has(id)) problem(page, element.line, `id="${id}" is also on line ${ids.get(id)}: an id names one element.`);
    else ids.set(id, element.line);
  }
  const count = { files: 0, inPage: 0, repository: 0 };
  const anchorsOf = new Map();
  for (const element of elements) {
    // What names another element by its id: a label's control, and the ARIA relations.
    for (const attribute of ["for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"]) {
      if (attribute === "for" && element.tag !== "label") continue;
      for (const id of (element.attrs[attribute] ?? "").split(/\s+/).filter(Boolean)) {
        count.inPage += 1;
        if (!ids.has(id)) problem(page, element.line, `${attribute}="${id}" names no element of the page.`);
      }
    }
    for (const attribute of ["href", "src", "poster", "data"]) {
      if (attribute === "data" && element.tag !== "object") continue;
      const url = element.attrs[attribute]?.trim();
      if (url === undefined) continue;
      if (url.startsWith("#")) {
        count.inPage += 1;
        if (url.length > 1 && !ids.has(decodeURIComponent(url.slice(1)))) problem(page, element.line, `${attribute}="${url}" leads nowhere: no element of the page has that id.`);
        continue;
      }
      if (!isAbsoluteUrl(url)) {
        count.files += 1;
        const wrong = notAFile(url, pagePath);
        if (wrong) problem(page, element.line, `${attribute}="${url}" ${wrong}.`);
        continue;
      }
      const inRepository = url.startsWith(`${REPOSITORY}/`) ? /^(blob|tree)\/main\/([^?#]*)(?:#(.*))?$/.exec(url.slice(REPOSITORY.length + 1)) : null;
      if (!inRepository) continue;
      count.repository += 1;
      const [, kind, encoded, anchor] = inRepository;
      const path = join(checkout, decodeURIComponent(encoded));
      const there = existsSync(path) ? statSync(path) : undefined;
      if (!there || (kind === "blob" ? !there.isFile() : !there.isDirectory())) {
        problem(page, element.line, `This link names ${kind === "blob" ? "a file" : "a folder"} the checkout does not have: ${decodeURIComponent(encoded)}.`);
      } else if (anchor && /\.md$/i.test(path)) {
        if (!anchorsOf.has(path)) anchorsOf.set(path, headingAnchors(readFileSync(path, "utf8")));
        if (!anchorsOf.get(path).has(decodeURIComponent(anchor).toLowerCase())) problem(page, element.line, `This link names a heading that ${decodeURIComponent(encoded)} does not have: #${anchor}.`);
      }
    }
  }
  for (const path of stylesheets) {
    const css = readFileSync(path, "utf8");
    for (const match of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
      const url = match[2].trim();
      if (isAbsoluteUrl(url) || url.startsWith("#")) continue;
      count.files += 1;
      const wrong = notAFile(url, path);
      if (wrong) problem(named(path), lineIn(css, match.index), `url(${url}) ${wrong}.`);
    }
  }
  for (const path of scripts) {
    const js = readFileSync(path, "utf8");
    for (const match of js.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])([^"']+)\1|\bimport\s*\(?\s*(["'])([^"']+)\3/g)) {
      const url = match[2] ?? match[4];
      if (isAbsoluteUrl(url)) continue;
      count.files += 1;
      const wrong = notAFile(url, path);
      if (wrong) problem(named(path), lineIn(js, match.index), `The import of "${url}" ${wrong}.`);
    }
  }
  return `${count.files} relative addresses are files of ${named(site)}/, ${count.inPage} links and references in the page have their id (${ids.size} ids, none twice), ${count.repository} links to the repository name a path of the checkout`;
});

// ---------------------------------------------------------------------------------------------
// requests: nothing is loaded from another origin
// ---------------------------------------------------------------------------------------------

check("requests", () => {
  /** The attributes that make a browser load something, by element. `link` is told by its rel below. */
  const LOADS = { script: ["src"], img: ["src", "srcset"], source: ["src", "srcset"], iframe: ["src"], object: ["data"], video: ["src", "poster"], audio: ["src"], embed: ["src"], track: ["src"], image: ["href", "xlink:href"], use: ["href", "xlink:href"], input: ["src"] };
  /** A <link> of these kinds leads somewhere and loads nothing. */
  const LINK_ONLY = new Set(["canonical", "alternate", "author", "help", "license", "me", "next", "prev", "search"]);
  const elsewhere = (url) => /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(url.trim()) || /^(?:https?|wss?|ftp):/i.test(url.trim());
  const inCss = (css, file, firstLine) => {
    for (const match of css.matchAll(/url\(\s*["']?\s*((?:https?:|ftp:)?\/\/[^"')\s]*)|@import\b[^;]*/gi)) {
      problem(file, firstLine + lineIn(css, match.index) - 1, match[1] ? `url(${short(match[1], 60)}) loads from another origin.` : `${short(match[0], 60)}: a stylesheet does not import another (each is linked from the page).`);
    }
  };
  const inJs = (js, file, firstLine) => {
    for (const match of js.matchAll(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\bEventSource\b|\b(?:import|from)\s*\(?\s*["'`](?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/[^"'`]*/g)) {
      problem(file, firstLine + lineIn(js, match.index) - 1, `${short(match[0].trim(), 60)}: the page's scripts send no request and import no URL.`);
    }
  };
  for (const element of elements) {
    const attributes = element.tag === "link" ? ((element.attrs.rel ?? "").toLowerCase().split(/\s+/).every((rel) => LINK_ONLY.has(rel)) ? [] : ["href", "imagesrcset"]) : (LOADS[element.tag] ?? []);
    for (const attribute of attributes) {
      const value = element.attrs[attribute];
      if (value === undefined) continue;
      const urls = attribute.endsWith("srcset") ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]) : [value];
      for (const url of urls) if (elsewhere(url)) problem(page, element.line, `<${element.tag} ${attribute}="${short(url, 60)}"> loads from another origin.`);
    }
    if (element.attrs.style) inCss(element.attrs.style, page, element.line);
    if (element.tag === "style") inCss(html.slice(element.openEnd, element.closeStart), page, element.line);
    if (element.tag === "script" && !("src" in element.attrs)) inJs(html.slice(element.openEnd, element.closeStart), page, element.line);
  }
  for (const path of stylesheets) inCss(readFileSync(path, "utf8"), named(path), 1);
  for (const path of scripts) inJs(readFileSync(path, "utf8"), named(path), 1);
  return `the page, ${stylesheets.length} stylesheets and ${scripts.length} scripts load nothing from another origin`;
});

// ---------------------------------------------------------------------------------------------
// weight: what a visitor downloads
// ---------------------------------------------------------------------------------------------

check("weight", () => {
  const weighed = files.filter((path) => toPosix(relative(site, path)).split("/")[0] !== "data");
  const sizes = weighed.map((path) => [toPosix(relative(site, path)), statSync(path).size]);
  const total = sizes.reduce((sum, [, size]) => sum + size, 0);
  const list = sizes.map(([name, size]) => `${name} ${thousands(size)}`).join(", ");
  if (total >= MAX_BYTES) problem(named(site), 0, `The page and its assets weigh ${thousands(total)} bytes, and the limit is ${thousands(MAX_BYTES)}: ${list}.`);
  return `${thousands(total)} bytes of ${thousands(MAX_BYTES)} in ${sizes.length} files: ${list}`;
});

// ---------------------------------------------------------------------------------------------
// shape: one h1, an alt on every image, and the page's own words
// ---------------------------------------------------------------------------------------------

check("shape", () => {
  if (!parsedWhole) return ""; // the tags that do not balance are reported above
  const headings = elements.filter((element) => element.tag === "h1");
  if (headings.length === 0) problem(page, 0, "The page has no <h1>.");
  for (const extra of headings.slice(1)) problem(page, extra.line, `A second <h1>: the page has one, on line ${headings[0].line}.`);
  const images = elements.filter((element) => element.tag === "img");
  for (const image of images) if (!("alt" in image.attrs)) problem(page, image.line, 'This <img> has no alt (alt="" for one that says nothing).');

  // The page's own words: its text without what it quotes (a recorded value, a sample of a file).
  const quoted = elements.filter((element) => ["data-rec", "data-rec-num", "data-rec-excerpt", "data-src"].some((attribute) => attribute in element.attrs));
  const own = html.split("");
  const blank = (start, end) => {
    for (let index = start; index < end; index++) if (own[index] !== "\n") own[index] = " ";
  };
  for (const [start, end] of markup) blank(start, end);
  for (const element of quoted) blank(element.start, element.end);
  const words = new RegExp(`(?<![\\p{L}\\p{N}-])(?:${AVOIDED.join("|")})(?![\\p{L}\\p{N}-])|${AVOIDED_FIGURE.replace(".", "\\.")}|—`, "giu");
  const why = (word) => (word === "—" ? "the page's own sentences have no em dash (a step line of the library has one: quote it from the recording, with data-rec)" : word === AVOIDED_FIGURE ? "the docs call that figure the estimate of 0.1.0, which counted logs low" : "the page does without that word");
  const said = (text, line, where) => {
    for (const match of text.matchAll(words)) problem(page, line, `"${match[0]}" ${where}: ${why(match[0])}. The line: ${short(oneSpace(text), 160)}`);
  };
  own.join("").split("\n").forEach((line, index) => said(decode(line), index + 1, "is in the text"));
  for (const element of elements) {
    if (quoted.some((other) => within(element, other))) continue;
    for (const attribute of ["title", "aria-label", "alt", "placeholder"]) if (element.attrs[attribute]) said(element.attrs[attribute], element.line, `is in a ${attribute}`);
    if (element.tag === "meta" && element.attrs.content && (element.attrs.name === "description" || element.attrs.property?.startsWith("og:"))) said(element.attrs.content, element.line, "is in the description");
  }
  return `every tag is closed, one <h1>, ${images.length === 0 ? "no <img>" : `${images.length} <img> with an alt`}, and none of the ${AVOIDED.length} words the page does without`;
});

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s) in ${named(site)}/. The top of scripts/check-site.mjs says what each check wants.`);
  process.exit(1);
}
console.log(passed.join("\n"));
