# Contributing

How to work on `llm-large-files`: set up, run the checks, the rules the code keeps, tests with fake
models, the changelog and the docs. Releasing a version to npm is in
[docs/publishing.md](docs/publishing.md).

## Set up and run the checks

You need Node 22.12 or later.

```bash
npm install
npm run check        # typecheck, tests, build: run it before every pull request
npm run test:watch   # the tests again on every save
```

`npm run check` runs three scripts, and stops at the first that fails. Each also runs alone:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `test/`, `examples/`, `evals/` and `scripts/`, in strict mode with `noUncheckedIndexedAccess` and no unused locals or parameters. The examples must compile too. |
| `npm test` | `vitest run`: every test in `test/`, in two Vitest projects: `unit`, files in parallel, then `timing`, the files of `test/timing/` one at a time ([Tests](#tests)). No test calls a real model or needs a key. |
| `npm run build` | Deletes `dist/` and compiles `src/` into it, with declarations and source maps (tsconfig.build.json). |

`npm run coverage` runs the `unit` project with V8 coverage of `src/`, without the tests of
`test/timing/`, and prints the share of lines, statements, functions and branches the tests run
(`coverage/coverage-summary.json` holds them). It fails when a test fails, or when a total is
under its threshold (`coverage.thresholds` in `vitest.config.ts`). The thresholds are 1 point under
the totals of the 0.10.0 suite, rounded down: raise them as the totals rise, and lower one only on
purpose, saying why in the pull request. Counting makes the tests several times slower, so it
gives each test 60 s. A test that sets a timeout of its own keeps it under coverage, and fails
past it: raise each such timeout to fit the test's time there ([Tests](#tests)).
`@vitest/coverage-v8` asks for the exact version of `vitest`: raise both together.
`node scripts/check-tarball.mjs` builds and packs the package, and checks the tarball as npm
installs it ([publishing](docs/publishing.md#what-the-release-workflow-does)); it needs the network.
`npm run eval:replay` replays the eval cases from their recordings, without the network or a key
([The evals](#the-evals)).

`npm run perf` builds the package, then runs the performance budgets (`scripts/perf.ts`): 100
uploads ingested at once, and a log of 100 MB ingested and searched, each against a bar of time or
memory ([Performance budgets](docs/measurements.md#performance-budgets-0999)). It takes one to three
minutes and about 0.7 GB of the temporary folder. It needs Node 22.18 or later (Node runs the
script's TypeScript), and checks memory only on Linux. It is not part of `npm test` or
`npm run check`: other work on the machine slows it. Change a bar only with a new record in
docs/measurements.md.

The examples and most tests import the package by its names (`llm-large-files`,
`llm-large-files/gemini` and the others), which tsconfig.json and vitest.config.ts map to `src/`.
Tests of internals import from `src/` directly. So the typecheck and the tests need no build. When
you run the examples, they load `dist/`: run `npm run build` first. They need Node
22.18 or a later 22.x, or Node 23.6 or later (Node runs their TypeScript directly), and a key, because they call a real model.

The dev dependencies include the optional peers `jszip`, `unpdf` and `@cantoo/pdf-lib`, so the
DOCX, PPTX and PDF tests run.

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: Node 22, 24
and 26, on Ubuntu and on Windows, where a rename can fail for a moment while another process has
the file open, and `FileDocumentStore` retries it (`EPERM`, `EACCES`, `EBUSY`); and on Ubuntu, Node
22.12.0 (the floor of `engines`) and 22.13.0. Each job runs `npm ci`, the typecheck, the tests, the
build and `npm pack --dry-run`. Five more jobs run on Ubuntu: `unpdf-versions` runs the tests with
other versions of the optional peer `unpdf`, `package` (Node 22.12.0, the newest 22, and 26) runs
`scripts/check-tarball.mjs` on the packed tarball, `coverage` (Node 24) runs `npm run coverage`,
which fails the job when a test fails or a total is under its threshold, `evals-replay` (Node 24)
runs `npm run eval:replay`, and `perf` (Node 22) runs `npm run perf` alone on its runner: a bar
that no run of three met fails it. Files use LF line endings (`.gitattributes`).

## Rules the code keeps

- **The core is provider-neutral.** `src/*.ts` works with any model through the `ModelAdapter`
  contract. Code for one provider goes in its folder: `src/gemini/`, `src/openai/`,
  `src/anthropic/`. The Node HTTP handlers are in `src/node/`.
- **No runtime dependencies.** `test/boundary.test.ts` fails when a file in `src/` imports anything
  other than:
  - a file inside `src/`;
  - a Node built-in, with the `node:` prefix: `node:fs/promises`, not `fs/promises`;
  - the optional peers `jszip`, `unpdf` and `@cantoo/pdf-lib`.

  Load a peer with `await import(...)` where it is needed, and its types with `import type`, so
  that the package works without it. When it is missing, throw an error that names it, as
  `Reading PDF files needs the optional dependency "unpdf".` does. Discuss before adding a peer.
- **The types are Node's, without the DOM.** `tsconfig.json` has `"lib": ["ES2023"]` and no
  `"DOM"`, as a server app compiles: `fetch`, `Response`, `TextDecoder` and `AbortSignal` come from
  `@types/node`. A type that only the DOM library declares (`TextDecoderOptions`, `HeadersInit`)
  does not compile: name it through the value, as `ConstructorParameters<typeof TextDecoder>[1]`
  does. `@types/node` follows the floor in `engines`: its range starts at the oldest Node supported
  (`^22.12.0` for `>=22.12`), so the code cannot use the API of a later major. Raise both in one
  pull request.
- **Tool names, arguments and result fields are public API; the rest of the text the model sees
  changes answers.** Models are prompted with the tool names, arguments and
  result fields, and the loop parses the calls they make. The tool descriptions (`src/tools.ts`),
  the tool guide (`src/plan.ts`) and the instructions in `src/ask.ts` change what models do, and
  any change to them makes the provider's prompt cache miss once. Change them on purpose, and say
  so in the changelog. What else is public is listed under "Versioning" in
  [docs/publishing.md](docs/publishing.md).

## Tests

Add a test for every change in behavior. No test calls a real model:

- **Tests of the tool loop** use `fakeModel` from `test/fake-model.ts`: a `ModelAdapter` that
  answers each request from a script and keeps every request it was sent in `.requests`. A script
  entry is a reply (`says(text)`, `calls([...])`), an `Error` to throw, or a function of the
  request. The last entry repeats. `httpError(status)` makes an error as an adapter throws it, and
  `serviceLog(lines)` makes a service log of about 90 characters a line, with an `ERROR` line every
  97 lines.
- **The fakes are part of the package.** They live in `src/testing/` and ship as
  `llm-large-files/testing`, for the tests of apps ([Testing](docs/guides/testing.md)), with
  `fakeFetch` for adapters. `test/fake-model.ts` re-exports them. A change to them is a change to
  the public API, and they import nothing but files of `src/`: no test framework.
- **Tests of an adapter** give it a fake `fetch` (its `fetch` option) that returns a provider's
  reply made by hand, and check the requests it sent.
- **Tests of the Node handlers** serve `createDocumentHandlers` on a local HTTP server on
  127.0.0.1.
- **PDFs** for the tests are written by hand in `test/pdf-fixtures.ts`, or kept in
  `test/fixtures/pdf/`. A test file that reads PDFs imports `./load-pdf-libraries.js` first. Each
  test file runs in a process of its own, and the library loads pdf.js and pdf-lib on first use:
  this import loads them while the file is collected, where no timeout applies, and not inside the
  first test's 5 s. Leave it out of a file that mocks them as not installed
  (`test/view-pages-library.test.ts`).
- **A slow test** gets a `timeout` of its own, with a comment that says how long it takes in a
  usual run and on a busy machine. That timeout holds under `npm run coverage` too, where the test
  is several times slower: when it takes more than half of it there, raise it, and say that time
  too. When a test could reach the library's own time limits on a busy machine (the regex limits
  read `performance.now()`), stop that clock with `vi.useFakeTimers({ toFake: ["performance"] })`,
  as `test/volume.test.ts` does.
- **A test that holds work to the clock** goes in a file of `test/timing/`, the `timing` project:
  `test/timing/<topic>.timing.test.ts`, a file of its subject or a new one. The other tests of
  its subject stay in their own file, and helpers both use go in a module of `test/` that both
  import (`test/pdf-fixtures.ts`, `test/word-fixtures.ts`); what the clock is read with is in
  `test/timing/clock.ts`. Such a test checks an elapsed time or an event-loop gap of work under a
  bound, counts the pauses that work leaves for a timer, or counts events in a time. With a bound
  less than about 10 times what the work takes on an idle machine, these failed when other files
  ran beside them on a busy machine, and coverage slows the work several times more. The files of
  `test/timing/` run one at a time, after the others, with one retry and 20 s for each test, and
  `npm run coverage` leaves them out. A wait on a timer alone (a 50 ms limit checked under 2 s)
  stays in the `unit` project. So do timers counted against a timer (heartbeats of 20 ms, at least
  4 in 260 ms), and a check that work does not hang, under a bound far above its time on a busy
  machine (a child process started within 8 s). `npx vitest run --project unit` runs the rest
  alone. Bars on whole workloads (a log of 100 MB, 100 uploads at once) are not tests: they are
  budgets in `scripts/perf.ts`, which CI runs in a job of its own (`npm run perf`).

A test of the loop, from start to answer:

```ts
// test/search-then-answer.test.ts
import { describe, expect, it } from "vitest";
import { askWithFiles, createLargeFiles, MemoryDocumentStore } from "llm-large-files";
import { calls, fakeModel, says, serviceLog, utf8 } from "./fake-model.js";

describe("the tool loop", () => {
  it("searches a log too large to send, then answers", async () => {
    // The log (about 440 KB, about 326,000 estimated tokens) is over the default inlineTokens of
    // 200,000, so the model gets a card and reads it through tools. A small inlineTokens keeps it
    // a card if the default changes.
    const files = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await files.ingest({ name: "app.log", bytes: utf8(serviceLog(5_000)) });
    const search = { id: "c1", name: "search_document", args: { document_id: meta.id, query: "ERROR", mode: "exact" } };
    const model = fakeModel([calls([search]), says("51 errors, the first at line 97.")]);

    const result = await askWithFiles({
      files,
      model,
      documentIds: [meta.id],
      messages: [{ role: "user", text: "How many errors?" }],
    });

    expect(model.requests).toHaveLength(2);
    expect(result).toMatchObject({ answered: true, turns: 2, text: "51 errors, the first at line 97." });
    expect(result.steps).toEqual(["Search app.log (exact) for “ERROR” — 51 matching lines"]);
  });
});
```

The same ways of testing, seen from an app that uses the library (a scripted model, the real
adapters with a fake `fetch`, recorded replies, timers, live tests that cost little), are in
[docs/guides/testing.md](docs/guides/testing.md).

## The evals

`evals/` holds the eval suite: Hebrew and English questions over synthetic files that
`evals/fixtures.ts` builds, each with the facts its answer must hold (`evals/cases.ts`), run through
`askWithFiles` with Gemini as the company chatbot asks them. `evals/cassettes` keeps a recording of
each case on each model, and `evals/baseline/0.9.0.md` the report of 0.9.0, which later versions are
compared with. It is not published, and the tests do not run it: it has its own Vitest config,
`vitest.evals.config.ts`. [Testing](docs/guides/testing.md#the-librarys-own-evals) lists every
option of `evals/cli.mjs`.

```bash
npm run eval:replay                          # every case from evals/cassettes: no network, no key
npm run eval:recheck                         # the facts checked again on the recorded answers
GEMINI_API_KEY=… npm run eval:record         # each case once on each model, recorded again
GEMINI_API_KEY=… npm run eval:live -- --k 3  # each case three times: pass^3
```

CI replays them on every pull request (`evals-replay`). A change that changes what the library
sends a model (a prompt, a tool description, the tool guide, a card, the planning of a question, the
part, merge and final prompts of a whole-file read) fails it with "prompt changed: re-record",
naming the case, the request and the first field that differs. The whole-file prompts are covered
by the cases of kind "whole-read" (`contract-summary`, `diary-timeline`): a replay fails when such a
case's recording holds no whole read. When the change is meant, record the cassettes again in the
same pull request:

- Record with `npm run eval:record`, with a Gemini API key in `GEMINI_API_KEY`: every case, on
  Gemini 3.5 Flash-Lite and 3.8 Flash, which costs about 2 million input tokens. `--cases id,id`
  records only those. Load the key into the environment without printing it, and never write it to
  a file: a cassette redacts the key header and the `key` parameter, and a test fails when a file
  under `evals/` holds a Google API key.
- Review the diff: each request file keeps the outline of the request's fields, so the diff shows
  which ones changed, and `case.json` whether each fact held. A fact that held before and fails now
  is a finding of the change: say so in the pull request.
- Run `npm run eval:live -- --k 3` before a release, and on a change that may make models use tools
  differently: a recording is one run, and a live run varies. Record and live fail a case when a
  question ends with an error, when a case not marked `failsOn090` misses pass^k, or when a fact
  that held in every run of `evals/baseline/0.9.0.json` fails now. The report figures the release
  gates and lists the facts lost.
- A change to a fact, with no request changed, needs no recording: `npm run eval:recheck` checks
  the facts again on the recorded answers and writes them to each `case.json`. Until it is run, a
  replay fails with "facts changed". Review the diff the same way.

The cassettes stay small (the folder is well under 5 MB, which a test checks): they keep hashes and
outlines of the requests, not their text. The files of the evals are synthetic, built by code: add
no real document. A new case goes in `evals/cases.ts`, with facts worked out in
`evals/fixtures.ts` from the numbers the file is built with, and is recorded with `--cases`.

## The changelog

Every change a user of the package can see gets an entry in [CHANGELOG.md](CHANGELOG.md), in the
same pull request: a change to the API, to behavior, to the text the model is sent, or a fix.
Changes only to tests or to internal code need none.

Entries go under the top version heading, marked "not released yet". If the top version already
has a date, start a new heading above it. Put each entry in one of the four parts:

- **Upgrading: what you need to change.** Whether code written for the previous version still
  compiles, then each difference in behavior an app may need to act on, with what to do. Always
  present: a version with nothing to change says "Nothing."
- **New: what you can add.** New exports, options, tools and fields, with a link to the page that
  explains them.
- **Changed: what works differently.** Behavior that changes with no change to the app's code.
- **Fixed.** Bugs, by what an app developer saw.

[docs/publishing.md](docs/publishing.md) says what each part holds in full, how to check the public
types against the last release, and how the heading gets its date and the version its number at
release. A template of an entry is in a comment at the top of CHANGELOG.md.

## The docs

A change a user can see updates the docs in the same pull request. Each topic has one page that
owns it; [docs/README.md](docs/README.md) lists every page and what it covers.

- Change the page that owns the topic, and link to it from other pages instead of repeating it.
- A new export or option goes on the reference page of its module in `docs/reference/`, with its
  default. The guide for the task shows it where it matters.
- Code samples in the docs and README.md are TypeScript that must compile against the current
  types. `npm run typecheck` checks `examples/`, not the samples in Markdown: try a new or changed
  sample in a file that imports the package.
- `docs/`, README.md and CHANGELOG.md are published to npm with the package. CONTRIBUTING.md and
  `examples/` are not.
