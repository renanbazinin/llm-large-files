#!/usr/bin/env node
// Checks the package as npm would install it, from the tarball itself (the release workflow
// publishes the tarball this script checked). Run by the "package" job of CI and by the release
// workflow; see docs/publishing.md.
//
//   node scripts/check-tarball.mjs path/to/llm-large-files-x.y.z.tgz
//   node scripts/check-tarball.mjs            # builds and packs this checkout first
//   node scripts/check-tarball.mjs --keep ... # keeps the temporary projects, and prints where
//
// Needs the checkout's dev dependencies (npm ci): TypeScript for the consumer typecheck, and
// package-lock.json for the versions of the peers and of @types/node. Installs into temporary
// projects from the npm registry, and runs publint and @arethetypeswrong/cli through npx at the
// versions pinned below. Exits with 1, and says which checks failed, when any fails.
//
// Checks, in this order:
//   1. The files in the tarball: only package.json, README.md, LICENSE, CHANGELOG.md, dist/, src/
//      and docs/, and every target of "exports", "main", "types" and "typesVersions" is there.
//   2. Installed into a project without the optional peers (unpdf, jszip, @cantoo/pdf-lib) or a
//      test framework: import and require() of every subpath of "exports" (./testing included)
//      give the same module, and a PDF is refused with the message that names unpdf.
//   3. llm-large-files/node/ingest-child.js resolves from import and from require, and one text
//      file is ingested through createIsolatedExtractors, in a child process that runs it.
//   4. A consumer compiles with tsc (the checkout's TypeScript) under moduleResolution NodeNext
//      (an ES module and a CommonJS one), Bundler and Node10, with skipLibCheck false.
//   5. Installed with the peers, at the versions of package-lock.json: a PDF of test/fixtures and
//      a DOCX (made here with jszip: test/fixtures holds none) are read, in the process and in a
//      child process of createIsolatedExtractors.
//   6. publint and @arethetypeswrong/cli on the tarball.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLINT = "publint@0.3.25";
const ATTW = "@arethetypeswrong/cli@0.18.5";
/**
 * Rules of attw this package breaks on purpose:
 * - cjs-resolves-to-esm: the package is ESM only, and require() of it works from Node 22.12 (the
 *   floor in "engines"), which attw's own TypeScript (5.6) does not know. Step 2 runs require() of
 *   every subpath, and step 4 compiles a CommonJS consumer under NodeNext.
 */
const ATTW_IGNORED_RULES = ["cjs-resolves-to-esm"];
/**
 * Entry points attw does not check: node/ingest-child.js is the script that the child processes of
 * createIsolatedExtractors run, resolved by path (import.meta.resolve, require.resolve), never
 * imported for its types. Node10 resolution has no "exports", so it cannot find it; Node can, and
 * step 3 runs it.
 */
const ATTW_EXCLUDED_ENTRYPOINTS = ["./node/ingest-child.js"];
/** The files of the package root that npm publishes besides "files". */
const ROOT_FILES = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]);
const ROOT_FOLDERS = ["dist", "src", "docs"];
const PEERS = ["unpdf", "jszip", "@cantoo/pdf-lib"];

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const tarballArgs = args.filter((arg) => arg !== "--keep");
const isWindows = process.platform === "win32";

const failures = [];
/** The folder of the temporary projects, made once the arguments are checked. */
let work;

/**
 * Runs a command, and returns what it wrote (only its standard output with `stdout: true`); throws
 * with all of it when it fails.
 */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? work,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    // npm and npx are .cmd files on Windows.
    shell: isWindows && (command === "npm" || command === "npx"),
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) throw new Error(`${command} ${commandArgs.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}:\n${output}`);
  return options.stdout ? (result.stdout ?? "").trim() : output;
}

/** Runs one check, prints how it went, and keeps its failure. A required check stops the script. */
function step(name, check, { required = false } = {}) {
  const started = Date.now();
  process.stdout.write(`- ${name} ... `);
  try {
    const detail = check();
    console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)} s)${detail ? `: ${detail}` : ""}`);
    return true;
  } catch (error) {
    console.log("FAILED");
    const message = error instanceof Error ? error.message : String(error);
    console.log(message.replace(/^/gm, "    "));
    failures.push(name);
    if (required) finish();
    return false;
  }
}

function finish() {
  if (keep) console.log(`\nThe temporary projects are kept in ${work}`);
  else rmSync(work, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`\ncheck-tarball: ${failures.length} check${failures.length === 1 ? "" : "s"} failed:`);
    for (const name of failures) console.error(`  - ${name}`);
    process.exit(1);
  }
  console.log("\ncheck-tarball: every check passed.");
  process.exit(0);
}

const lock = JSON.parse(readFileSync(join(checkout, "package-lock.json"), "utf8"));
const repoPackage = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
/** The version package-lock.json installs, or the range package.json asks for. */
const lockedVersion = (name) =>
  lock.packages?.[`node_modules/${name}`]?.version ?? repoPackage.devDependencies?.[name] ?? repoPackage.peerDependencies?.[name];

let tsc;
try {
  tsc = createRequire(join(checkout, "package.json")).resolve("typescript/bin/tsc");
} catch {
  console.error("check-tarball: TypeScript is not installed in this checkout. Run npm ci first.");
  process.exit(1);
}

// The tarball: the one given, or one packed from this checkout.
let tarball;
if (tarballArgs.length > 1) {
  console.error(`check-tarball: give one tarball, not ${tarballArgs.length}: ${tarballArgs.join(" ")}`);
  process.exit(1);
} else if (tarballArgs.length === 1) {
  tarball = resolve(tarballArgs[0]);
  if (!tarball.endsWith(".tgz") || !existsSync(tarball)) {
    console.error(`check-tarball: no .tgz file at ${tarball}.`);
    process.exit(1);
  }
}
work = mkdtempSync(join(tmpdir(), "llf-tarball-"));
if (!tarball) {
  step("Build and pack this checkout", () => {
    run("npm", ["run", "build"], { cwd: checkout });
    const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], { cwd: checkout, stdout: true }));
    tarball = join(work, packed[0].filename);
    return basename(tarball);
  }, { required: true });
}
console.log(`check-tarball: ${tarball} on Node ${process.version}`);

/** A project in the work folder, with the tarball and `dependencies` installed. */
function project(name, dependencies) {
  const folder = join(work, name);
  mkdirSync(folder);
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: `check-${name}`, private: true, type: "module" }, null, 2));
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", "--loglevel=error", tarball, ...dependencies], { cwd: folder });
  return folder;
}

/** Writes `files` into `folder`, and runs `node` on the first. */
function node(folder, files, nodeArgs = [], options = {}) {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
  return run(process.execPath, [Object.keys(files)[0], ...nodeArgs], { cwd: folder, ...options });
}

/** Every file below `folder`, relative to it, with forward slashes. */
function filesIn(folder) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(folder, path).split(sep).join("/"));
    }
  };
  walk(folder);
  return found;
}

// 1 and 2: installed without the peers.
let bare;
step("Install the tarball without the optional peers", () => {
  bare = project("bare", [`@types/node@${lockedVersion("@types/node")}`]);
  const present = [...PEERS, "vitest"].filter((name) => existsSync(join(bare, "node_modules", name)));
  if (present.length > 0) throw new Error(`Installed although nothing asked for them: ${present.join(", ")}`);
}, { required: true });

const installed = join(bare, "node_modules", "llm-large-files");
const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));

step("The files in the tarball", () => {
  const files = filesIn(installed);
  const stray = files.filter((file) => !ROOT_FILES.has(file) && !ROOT_FOLDERS.some((folder) => file.startsWith(`${folder}/`)));
  if (stray.length > 0) throw new Error(`Files outside package.json "files": ${stray.join(", ")}`);
  const targets = new Set([pkg.main, pkg.types]);
  const collect = (value) => {
    if (typeof value === "string") targets.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(pkg.exports);
  collect(pkg.typesVersions);
  const missing = [...targets].filter((target) => target && !files.includes(target.replace(/^\.\//, "")));
  if (missing.length > 0) throw new Error(`package.json names files the tarball does not hold: ${missing.join(", ")}`);
  return `${files.length} files, version ${pkg.version}`;
});

const IMPORT_EVERY_SUBPATH = `
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("./node_modules/llm-large-files/package.json", import.meta.url), "utf8"));
const out = {};
for (const [key, target] of Object.entries(pkg.exports)) {
  const spec = key === "." ? pkg.name : pkg.name + key.slice(1);
  if (key === "./package.json") {
    const json = (await import(spec, { with: { type: "json" } })).default;
    if (json.version !== pkg.version || require(spec).version !== pkg.version) throw new Error(spec + " is not the package.json of the package");
    out[key] = "json";
    continue;
  }
  if (typeof target === "string") {
    // A script, not a module of the API (node/ingest-child.js): resolved, not run here.
    const path = fileURLToPath(import.meta.resolve(spec));
    if (!existsSync(path) || require.resolve(spec) !== path) throw new Error(spec + " does not resolve to the same file from import and require");
    out[key] = "file";
    continue;
  }
  const imported = await import(spec);
  const keys = Object.keys(imported).sort();
  if (keys.length === 0) throw new Error(spec + " exports nothing");
  // require() of an ES module gives the same module, not a second copy.
  const required = require(spec);
  const different = keys.filter((name) => required[name] !== imported[name]);
  if (different.length > 0) throw new Error("require(" + JSON.stringify(spec) + ") differs from import in " + different.join(", "));
  out[key] = keys;
}
console.log(JSON.stringify(out));
`;

const REQUIRE_EVERY_SUBPATH = `
"use strict";
const pkg = require("llm-large-files/package.json");
const out = {};
for (const [key, target] of Object.entries(pkg.exports)) {
  const spec = key === "." ? pkg.name : pkg.name + key.slice(1);
  if (key === "./package.json") { out[key] = "json"; continue; }
  if (typeof target === "string") { require.resolve(spec); out[key] = "file"; continue; }
  out[key] = Object.keys(require(spec)).filter((name) => name !== "__esModule").sort();
}
console.log(JSON.stringify(out));
`;

step('ESM import and require() of every subpath of "exports"', () => {
  const imported = JSON.parse(node(bare, { "import-every-subpath.mjs": IMPORT_EVERY_SUBPATH }, [], { stdout: true }));
  const required = JSON.parse(node(bare, { "require-every-subpath.cjs": REQUIRE_EVERY_SUBPATH }, [], { stdout: true }));
  const keys = Object.keys(pkg.exports);
  const notChecked = keys.filter((key) => !(key in imported) || !(key in required));
  if (notChecked.length > 0) throw new Error(`Not checked: ${notChecked.join(", ")}`);
  const differ = keys.filter((key) => JSON.stringify(imported[key]) !== JSON.stringify(required[key]));
  if (differ.length > 0) throw new Error(`From CommonJS, other exports than from an ES module: ${differ.join(", ")}`);
  if (!("./testing" in imported)) throw new Error('"exports" has no ./testing');
  return keys.map((key) => (Array.isArray(imported[key]) ? `${key} (${imported[key].length})` : key)).join(", ");
});

step("A PDF without unpdf is refused with a message that names it", () => {
  const pdf = join(checkout, "test", "fixtures", "pdf", "word-simple.pdf");
  return node(bare, {
    "no-peers.mjs": `
import { readFileSync } from "node:fs";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
const files = createLargeFiles({ store: new MemoryDocumentStore(), requireOwner: false });
try {
  await files.ingest({ name: "report.pdf", bytes: readFileSync(process.argv[2]) });
} catch (error) {
  if (!/needs the optional dependency "unpdf"/.test(error.message)) throw error;
  console.log(error.name + ": " + error.message);
  process.exit(0);
}
throw new Error("A PDF was read without unpdf installed");
`,
  }, [pdf]);
});

step("Resolve node/ingest-child.js and ingest a text file through createIsolatedExtractors", () =>
  node(bare, {
    "isolated-text.mjs": `
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { createIsolatedExtractors } from "llm-large-files/node";
const childScript = import.meta.resolve("llm-large-files/node/ingest-child.js");
const required = createRequire(import.meta.url).resolve("llm-large-files/node/ingest-child.js");
if (fileURLToPath(childScript) !== required) throw new Error("import and require resolve ingest-child.js to different files: " + childScript + ", " + required);
const isolated = createIsolatedExtractors({ formats: ["text"], childScript, concurrency: 1, maxHeapMb: 128 });
const store = new MemoryDocumentStore();
try {
  const files = createLargeFiles({ store, extractors: isolated.extractors, requireOwner: false });
  const meta = await files.ingest({ name: "notes.txt", bytes: new TextEncoder().encode("first line\\nשורה שנייה\\nthird line\\n") });
  const children = isolated.stats().children;
  if (children < 1) throw new Error("No child process read the file");
  const stored = await store.get(meta.id);
  if (meta.format !== "text" || meta.lines !== 3 || !stored?.text.includes("שורה שנייה")) throw new Error("Read wrong: " + JSON.stringify({ meta, text: stored?.text }));
  console.log(meta.format + ", " + meta.lines + " lines, read in " + children + " child process");
} finally {
  await isolated.close();
}
`,
  }),
);

const CONSUMER = `
import * as root from "llm-large-files";
import * as geminiModule from "llm-large-files/gemini";
import * as openAiModule from "llm-large-files/openai";
import * as anthropicModule from "llm-large-files/anthropic";
import * as nodeModule from "llm-large-files/node";
import * as testingModule from "llm-large-files/testing";
import { createLargeFiles, IngestError, MemoryDocumentStore, type DocumentMeta, type DocumentStore, type ModelAdapter } from "llm-large-files";
import { vertexAi } from "llm-large-files/gemini";
import { openAiCompatible } from "llm-large-files/openai";
import { anthropic } from "llm-large-files/anthropic";
import { createDocumentHandlers, createIsolatedExtractors } from "llm-large-files/node";
import { documentStoreChecks, fakeModel, says } from "llm-large-files/testing";

export const modules = [root, geminiModule, openAiModule, anthropicModule, nodeModule, testingModule];
const store: DocumentStore = new MemoryDocumentStore();
const files = createLargeFiles({ store });
export const ingested: Promise<DocumentMeta> = files.ingest({ name: "notes.txt", bytes: new Uint8Array([104, 105]) });
export const model: ModelAdapter = fakeModel([says("Two lines.")]);
export const handlers = createDocumentHandlers(files);
export const isolated = createIsolatedExtractors({ maxHeapMb: 256 });
export const endpoint = vertexAi({ project: "project", location: "global", model: "model", accessToken: "token" });
export const adapters = [openAiCompatible, anthropic, documentStoreChecks];
export const isIngestError = (error: unknown): error is IngestError => error instanceof IngestError;
// @ts-expect-error A number is not a store: the types are not any.
createLargeFiles({ store: 1 });
`;

const CONSUMER_CJS = `
import { createLargeFiles, MemoryDocumentStore, type DocumentMeta } from "llm-large-files";
import { fakeModel, says } from "llm-large-files/testing";
import { createIsolatedExtractors } from "llm-large-files/node";

const files = createLargeFiles({ store: new MemoryDocumentStore() });
export const ingested: Promise<DocumentMeta> = files.ingest({ name: "notes.txt", bytes: new Uint8Array([104, 105]) });
export const model = fakeModel([says("Two lines.")]);
export const isolated = createIsolatedExtractors({ childScript: require.resolve("llm-large-files/node/ingest-child.js") });
// @ts-expect-error A number is not a store: the types are not any.
createLargeFiles({ store: 1 });
`;

const COMPILER_OPTIONS = {
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  target: "ES2022",
  lib: ["ES2023"],
  types: ["node"],
};

const RESOLUTIONS = {
  NodeNext: { compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" }, files: ["consumer.ts", "consumer-cjs.cts"] },
  Bundler: { compilerOptions: { module: "Preserve", moduleResolution: "Bundler" }, files: ["consumer.ts"] },
  Node10: { compilerOptions: { module: "CommonJS", moduleResolution: "Node10" }, files: ["consumer.ts"] },
};

writeFileSync(join(bare, "consumer.ts"), CONSUMER);
writeFileSync(join(bare, "consumer-cjs.cts"), CONSUMER_CJS);
const typescriptVersion = JSON.parse(readFileSync(join(dirname(dirname(tsc)), "package.json"), "utf8")).version;
for (const [name, { compilerOptions, files }] of Object.entries(RESOLUTIONS)) {
  step(`tsc ${typescriptVersion}, moduleResolution ${name}, skipLibCheck false`, () => {
    const config = `tsconfig.${name.toLowerCase()}.json`;
    writeFileSync(join(bare, config), JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, ...compilerOptions }, files }, null, 2));
    run(process.execPath, [tsc, "-p", config], { cwd: bare });
    return files.join(", ");
  });
}

// 5: installed with the peers.
const PEERS_READ = `
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { createIsolatedExtractors } from "llm-large-files/node";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const zip = new JSZip();
zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document ' + W + '><w:body><w:p><w:r><w:t>Quarterly notes from a DOCX file.</w:t></w:r></w:p><w:p><w:pPr><w:bidi/></w:pPr><w:r><w:t>סיכום הרבעון</w:t></w:r></w:p></w:body></w:document>');
const docx = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
const pdf = readFileSync(process.argv[2]);

const expected = {
  "report.pdf": ["Revenue report", "EMEA"],
  "notes.docx": ["Quarterly notes from a DOCX file.", "סיכום הרבעון"],
};

async function readBoth(how, extractors) {
  const store = new MemoryDocumentStore();
  const files = createLargeFiles({ store, ...(extractors ? { extractors } : {}), requireOwner: false });
  const read = [];
  for (const [name, bytes] of [["report.pdf", pdf], ["notes.docx", docx]]) {
    const meta = await files.ingest({ name, bytes });
    const text = (await store.get(meta.id))?.text ?? "";
    const missing = expected[name].filter((part) => !text.includes(part));
    if (missing.length > 0) throw new Error(how + ": " + name + " was read without " + JSON.stringify(missing) + ":\\n" + text.slice(0, 600));
    read.push(name + " (" + meta.format + ", " + meta.lines + " lines)");
  }
  return how + ": " + read.join(", ");
}

const results = [await readBoth("in the process")];
const isolated = createIsolatedExtractors({ childScript: import.meta.resolve("llm-large-files/node/ingest-child.js"), concurrency: 1 });
try {
  results.push(await readBoth("in a child process", isolated.extractors));
} finally {
  await isolated.close();
}
console.log(results.join("; "));
`;

const peerVersions = PEERS.map((name) => `${name}@${lockedVersion(name)}`);
let withPeers;
step(`Install the tarball with the peers (${peerVersions.join(", ")})`, () => {
  withPeers = project("with-peers", peerVersions);
});
if (withPeers) {
  step("Read a PDF and a DOCX, in the process and in a child process", () =>
    node(withPeers, { "read-pdf-and-docx.mjs": PEERS_READ }, [join(checkout, "test", "fixtures", "pdf", "word-simple.pdf")]),
  );
}

// 6: the linters, on the tarball itself.
step(`publint (${PUBLINT})`, () => run("npx", ["--yes", PUBLINT, "run", tarball, "--strict", "--level", "suggestion"]).split("\n").at(-1));
step(`attw (${ATTW})`, () => {
  run("npx", [
    "--yes",
    ATTW,
    tarball,
    "--profile", "strict",
    "--format", "ascii",
    "--no-emoji",
    "--no-color",
    "--ignore-rules", ...ATTW_IGNORED_RULES,
    "--exclude-entrypoints", ...ATTW_EXCLUDED_ENTRYPOINTS,
  ]);
  return `ignored rules: ${ATTW_IGNORED_RULES.join(", ")}; not checked: ${ATTW_EXCLUDED_ENTRYPOINTS.join(", ")}`;
});

finish();
