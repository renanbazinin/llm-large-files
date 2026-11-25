#!/usr/bin/env node
// Compiles the TypeScript samples of README.md and docs/ against src/ (npm run typecheck:docs, part
// of npm run check; the "docs" job of CI). A sample that names an export or an option the package
// does not have, or uses a result in a way its type does not allow, fails with the page and the line.
//
//   node scripts/check-doc-samples.mjs                          # every page
//   node scripts/check-doc-samples.mjs docs/guides/web-app.md   # these pages only
//
// Needs the checkout's dev dependencies (npm ci) and no build: the package's names resolve to src/
// through the "paths" of tsconfig.json, as they do for examples/ and the tests.
//
// What is checked: every block fenced as ts, tsx or typescript, each as a module of its own, in
// strict mode. Most samples are parts of a program, so two things are let through, and only these:
//   - A name the sample does not declare ("files", "session", "currentUserId") is `any`. A sample
//     says in a comment or in the text around it where such a name comes from.
//   - What a sample imports from a module that is not found is `any`: a package of the application
//     that is not a dev dependency here (express, mongodb, google-auth-library), and a file of the
//     sample's own ("./large-files.js"). A module that is installed (node:*, unpdf, vitest) is
//     checked, and so is every import of this package.
// Everything else must compile: the names imported from the package, the options passed to its
// functions, the fields read from what they return. A block that shows a shape and is not code (a
// signature outside a type, an object alone) does not parse: write it as a declaration
// (`declare function`, `declare const`, `type`), or fence it as text.
//
// `any` is not the type a name has in the whole program, and in a few samples that shows:
// Object.entries of an `any` gives values of type unknown, and a callback whose parameter takes its
// type from an `any` argument gets the widest type the function allows. Such a sample says what
// the name is: it imports it, or declares it (`declare const result: AskResult;`), or gives the
// parameter its type.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE = "llm-large-files";
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (path) => path.split(sep).join("/");
/** The folder the samples are compiled in. It is not on disk: the compiler is given their text. */
const virtualRoot = `${posix(checkout)}/.doc-samples`;

/** "Cannot find name", the same with a suggestion, and a shorthand property of a name not in scope. */
const UNDECLARED = new Set([2304, 2552, 18004]);
/** "Cannot find module", and the same with a hint about moduleResolution. */
const MODULE_NOT_FOUND = new Set([2307, 2792]);
/** "Untyped function calls may not accept type arguments": a call of a name that is `any` here. */
const CALL_OF_ANY = 2347;
const isThisPackage = (specifier) => specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`);

/** README.md and every Markdown file under docs/, or the pages named on the command line. */
function pagesToCheck(args) {
  if (args.length > 0) return args.map((arg) => resolve(arg));
  const pages = [join(checkout, "README.md")];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) pages.push(path);
    }
  };
  walk(join(checkout, "docs"));
  return pages;
}

/**
 * The TypeScript blocks of a page. Each sample's text starts with as many empty lines as the page
 * has before the block, so a line of the sample is the same line of the page.
 */
function samplesOf(page) {
  const samples = [];
  const lines = readFileSync(page, "utf8").split(/\r?\n/);
  let open; // { marker, typescript, start, body } while inside a fenced block
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!open) {
      const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
      if (fence) open = { marker: fence[1], typescript: /^(ts|tsx|typescript)$/.test(fence[2]), start: index + 1, body: [] };
      continue;
    }
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
      if (open.typescript) {
        const name = `${posix(relative(checkout, page)).replace(/\.md$/, "").replaceAll("/", "__")}.L${open.start + 1}.ts`;
        samples.push({ page, line: open.start + 1, file: `${virtualRoot}/${name}`, text: `${"\n".repeat(open.start)}${open.body.join("\n")}\nexport {};\n` });
      }
      open = undefined;
    } else open.body.push(line);
  }
  if (open) throw new Error(`${relative(checkout, page)}:${open.start}: this fenced block is never closed.`);
  return samples;
}

/** The options of tsconfig.json (so "paths" is in one place), as an application's strict project has them. */
function compilerOptions() {
  const configPath = join(checkout, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const { options, errors } = ts.parseJsonConfigFileContent(config.config, ts.sys, checkout, undefined, configPath);
  if (errors.length > 0) throw new Error(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  return {
    ...options,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], // some samples run in the browser
    // A sample is a part of a program: a callback of a name it does not declare has parameters
    // without a type, and it may leave unused what the text around it uses.
    noImplicitAny: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    // The repository's own rule, not one an application has by default.
    noUncheckedIndexedAccess: false,
    noEmit: true,
    skipLibCheck: true,
  };
}

/** A compiler host that serves the samples from memory, and parses every other file once. */
function createHost(options, texts) {
  const host = ts.createCompilerHost(options, true);
  const fromDisk = { exists: host.fileExists.bind(host), read: host.readFile.bind(host), source: host.getSourceFile.bind(host) };
  const parsed = new Map();
  host.fileExists = (file) => texts.has(file) || fromDisk.exists(file);
  host.readFile = (file) => texts.get(file) ?? fromDisk.read(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    const text = texts.get(file);
    if (text !== undefined) return ts.createSourceFile(file, text, languageVersion, true);
    if (!parsed.has(file)) parsed.set(file, fromDisk.source(file, languageVersion, onError, shouldCreate));
    return parsed.get(file);
  };
  return host;
}

/** Imports of the package under a name it does not export, which the `any` of other modules would hide. */
function unknownEntryPoints(sourceFile, entryPoints) {
  const found = [];
  const visit = (node) => {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0]
          : undefined;
    if (specifier && isThisPackage(specifier.text) && !entryPoints.has(specifier.text)) {
      found.push({ start: specifier.getStart(sourceFile), code: "entry", message: `"${specifier.text}" is not an entry point of the package (package.json "exports").` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const started = Date.now();
const pages = pagesToCheck(process.argv.slice(2));
const samples = pages.flatMap(samplesOf);
const options = compilerOptions();

// The entry points a sample may import: those of "exports" that are modules with types.
const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
const entryPoints = new Set(
  Object.entries(manifest.exports)
    .filter(([, target]) => typeof target === "object" && target !== null && "types" in target)
    .map(([subpath]) => (subpath === "." ? PACKAGE : `${PACKAGE}/${subpath.slice(2)}`)),
);

const texts = new Map(samples.map((sample) => [sample.file, sample.text]));
const host = createHost(options, texts);
const rootNames = samples.map((sample) => sample.file);

/** The names an import declaration binds: its default, its namespace, and each named import. */
function bindingsOf(declaration) {
  const clause = declaration.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
  else if (clause.namedBindings) for (const element of clause.namedBindings.elements) names.push(element.name.text);
  return names;
}

// First pass: the names each sample does not declare, and its imports from modules that are not found.
let program = ts.createProgram({ rootNames, options, host });
for (const sample of samples) {
  const sourceFile = program.getSourceFile(sample.file);
  if (program.getSyntacticDiagnostics(sourceFile).length > 0) continue; // reported by the second pass
  const names = new Set();
  let text = sample.text;
  for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
    if (diagnostic.start === undefined) continue;
    if (UNDECLARED.has(diagnostic.code)) {
      const name = sourceFile.text.slice(diagnostic.start, diagnostic.start + diagnostic.length);
      if (/^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(name)) names.add(name);
    } else if (MODULE_NOT_FOUND.has(diagnostic.code)) {
      const declaration = sourceFile.statements.find((statement) => ts.isImportDeclaration(statement) && statement.pos <= diagnostic.start && diagnostic.start < statement.end);
      if (!declaration || isThisPackage(declaration.moduleSpecifier.text)) continue;
      for (const name of bindingsOf(declaration)) names.add(name);
      // The import leaves, line breaks kept: a name cannot be imported and declared.
      const start = declaration.getStart(sourceFile);
      text = text.slice(0, start) + text.slice(start, declaration.end).replace(/[^\n]/g, " ") + text.slice(declaration.end);
    }
  }
  // As a value and as a type, with or without type arguments. An ambient declaration may follow its uses.
  const declarations = [...names].map((name) => `declare const ${name}: any; declare type ${name}<A = any, B = any, C = any, D = any> = any;`);
  if (declarations.length > 0) texts.set(sample.file, `${text}${declarations.join("\n")}\n`);
}

/** Not a problem: a call of an `any` name with type arguments, and a module not found that no import declaration names (`await import("express")`). */
const isProblem = (diagnostic) => diagnostic.code !== CALL_OF_ANY && !(MODULE_NOT_FOUND.has(diagnostic.code) && !/["']llm-large-files[/"']/.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")));

// Second pass: what is left is wrong.
program = ts.createProgram({ rootNames, options, host, oldProgram: program });
const problems = [];
for (const sample of samples) {
  const sourceFile = program.getSourceFile(sample.file);
  const syntactic = program.getSyntacticDiagnostics(sourceFile);
  const wrongEntryPoints = unknownEntryPoints(sourceFile, entryPoints);
  // Said once: the compiler does not find such a module either.
  const saidAbove = (diagnostic) => MODULE_NOT_FOUND.has(diagnostic.code) && wrongEntryPoints.some((problem) => problem.start === diagnostic.start);
  const found = [
    ...wrongEntryPoints,
    ...(syntactic.length > 0 ? syntactic : program.getSemanticDiagnostics(sourceFile).filter((diagnostic) => isProblem(diagnostic) && !saidAbove(diagnostic))).map((diagnostic) => ({
      start: diagnostic.start ?? 0,
      code: `TS${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n  "),
    })),
  ];
  for (const { start, code, message } of found) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    problems.push(`${posix(relative(checkout, sample.page))}:${line + 1}  ${code}  ${message}  (sample at line ${sample.line})`);
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s) in the TypeScript samples of ${pages.length} page(s) (${samples.length} samples, ${seconds} s).`);
  console.error("A sample must compile against src/: see the top of scripts/check-doc-samples.mjs for what it may leave out.");
  process.exit(1);
}
console.log(`${samples.length} TypeScript samples of ${pages.length} pages compile (${seconds} s).`);
