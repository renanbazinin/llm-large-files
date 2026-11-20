# Contributing

How to work on `llm-large-files`: set up, run the checks, the rules the code keeps, tests with fake
models, the changelog and the docs. Releasing a version to npm is in
[docs/publishing.md](docs/publishing.md).

## Set up and run the checks

You need Node 20.19 or later.

```bash
npm install
npm run check        # typecheck, tests, build: run it before every pull request
npm run test:watch   # the tests again on every save
```

`npm run check` runs three scripts, and stops at the first that fails. Each also runs alone:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `test/` and `examples/`, in strict mode with `noUncheckedIndexedAccess` and no unused locals or parameters. The examples must compile too. |
| `npm test` | `vitest run`: every test in `test/`. No test calls a real model or needs a key. |
| `npm run build` | Deletes `dist/` and compiles `src/` into it, with declarations and source maps (tsconfig.build.json). |

The examples and most tests import the package by its names (`llm-large-files`,
`llm-large-files/gemini` and the others), which tsconfig.json and vitest.config.ts map to `src/`.
Tests of internals import from `src/` directly. So the typecheck and the tests need no build. When
you run the examples, they load `dist/`: run `npm run build` first. They need Node
22.18 or a later 22.x, or Node 23.6 or later (Node runs their TypeScript directly), and a key, because they call a real model.

The dev dependencies include the optional peers `jszip`, `unpdf` and `@cantoo/pdf-lib`, so the
DOCX, PPTX and PDF tests run.

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: Node 20, 22
and 24, on Ubuntu and on Windows, where a rename can fail for a moment while another process has
the file open, and `FileDocumentStore` retries it (`EPERM`, `EACCES`, `EBUSY`). Each job runs `npm ci`, the typecheck, the tests, the build and `npm pack --dry-run`. Files
use LF line endings (`.gitattributes`).

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
- **Tests of an adapter** give it a fake `fetch` (its `fetch` option) that returns a provider's
  reply made by hand, and check the requests it sent.
- **Tests of the Node handlers** serve `createDocumentHandlers` on a local HTTP server on
  127.0.0.1.
- **PDFs** for the tests are written by hand in `test/pdf-fixtures.ts`, or kept in
  `test/fixtures/pdf/`.

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
