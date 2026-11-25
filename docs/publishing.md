# Publishing to npm

For maintainers. This page covers how a version of `llm-large-files` reaches npm: the changelog
while the version is in development, the release pull request, the tag that starts the release
workflow, and publishing by hand when the workflow's publish job fails. Working on the code
itself is in [CONTRIBUTING.md](https://github.com/renanbazinin/llm-large-files/blob/main/CONTRIBUTING.md).

## The changelog

[CHANGELOG.md](../CHANGELOG.md) is written for the developers who upgrade. Each pull request with
a change they can see adds its entry in the same pull request, so the changelog is ready when the
version is.

### While a version is in development

Changes go under the top version heading, marked "not released yet". The heading already names the
version the changes will ship in:

```markdown
## 0.6.0 — not released yet
```

When the top version already has a date (it was released), start a new heading above it with the
next version: a patch (0.6.1) when nothing in it needs a change in the user's code, a minor
(0.7.0) when something does (see [Versioning](#versioning)). If a change made later turns a
patch into a version that needs changes, raise the number in the heading.

A version that was never published ships in the next one, and that version's **Upgrading** part
is written for apps on the last version that was.

A template of an entry is in a comment at the top of CHANGELOG.md.

### What an entry holds

Each version opens with two to four sentences on what it is about. Then four parts, in this order:

| Part | What goes in it |
| --- | --- |
| `### Upgrading: what you need to change` | Always present. First, whether code written for the previous version compiles as it is. Then each difference in behavior an app may need to act on: what changed, whom it affects, what to do. A change to the text the model is sent is one of these: the provider's prompt cache misses once after it (0.6.0: the tool guide, two tool descriptions, the frame of a file sent whole). A version with nothing to change says so: "Nothing." |
| `### New: what you can add` | Each addition (an export, an option, a tool, a field of a result) in one or two lines, with a link to the page that explains it, and a short sample for the ones most apps will use. |
| `### Changed: what works differently` | Behavior that changes with no change to the app's code: a default, a retry, a limit, how a plan is made. Also what a change to the text the model is sent (tool descriptions, the tool guide, the instructions) makes models do. When a point under **Upgrading** links here, this part says how the behavior works, not again what an app must do. One or two lines each. |
| `### Fixed` | Bugs, grouped by area, told by what an app developer saw, with the numbers that matter. One or two lines each. |

To know whether code written for the previous version still compiles, compare the public types of
the last release with the current build. For example, after 0.5.0:

```bash
npm run build
mkdir -p ../api-old
npm pack llm-large-files@0.5.0 --pack-destination ../api-old
tar -xzf ../api-old/llm-large-files-0.5.0.tgz -C ../api-old
diff -ru -x '*.js' -x '*.map' ../api-old/package/dist dist
```

The diff shows only the `.d.ts` files. A removed or renamed export, a new required option, a new
required member of a type an app implements, a narrower parameter type, or a new member of a union
an app receives (a `ModelErrorKind`, a `DocumentFormat`) goes in **Upgrading**: an exhaustive
`switch`, or a `Record` keyed by the union, needs the new case. A new export, a new optional option
or field, or a wider parameter type goes in **New**.

A new optional parameter at the end of a function or method goes in **Upgrading** too, for the code
that already fills its place: a store, or a subclass of a library class, whose method takes an extra
parameter of its own there, and a function passed as a callback (`.map(fromGeminiContents)` gets the
index in it). 0.9.0's `context` on every store method and `options` of `fromGeminiContents` did
both. Compile a probe of each case against the old and the new version before writing that a change
is only an addition.

### At release

The release pull request makes two edits:

1. Replace "not released yet" with the date of the release, as YYYY-MM-DD. For a release on
   24 November 2026:

   ```markdown
   ## 0.6.0 — 2026-11-24
   ```

2. Bump the version in package.json and package-lock.json to the same number:

   ```bash
   npm version 0.6.0 --no-git-tag-version   # the number in the changelog heading
   ```

   `npm version minor` or `npm version patch` works the next number out from package.json (0.6.0
   becomes 0.7.0 or 0.6.1). Give the number itself when the heading skips one.

   Keep `--no-git-tag-version`. Without it, `npm version` refuses to run while the changelog edit
   is not committed, and when it runs it commits and tags `v0.6.0` on your branch. The squash merge
   then puts a different commit on `main`, and that tag points at a commit that is not on `main`.

## Releasing a version

A release is a pull request squash-merged into `main`, then an annotated tag on the merged commit.
Pushing the tag starts the release workflow.

1. Start a branch from an up-to-date `main`:

   ```bash
   git switch main
   git pull
   git switch -c release/0.6.0
   ```

2. Date the changelog heading and bump the version, as in [At release](#at-release).

3. Run the checks, and look at what npm will publish:

   ```bash
   npm run check                    # typecheck, doc samples, tests, build
   npm pack --dry-run               # dist/, src/, docs/, CHANGELOG.md, README.md, LICENSE, package.json
   node scripts/check-tarball.mjs   # builds, packs, and checks the tarball as npm installs it
   ```

   `files` in package.json publishes all of `dist/`, `src/` and `docs/`. CONTRIBUTING.md,
   `evals/`, `examples/`, `scripts/` and `test/` are not published. `check-tarball.mjs` is what the release
   workflow runs on the tarball it publishes ([below](#what-the-release-workflow-does)); it
   installs into temporary projects from the npm registry, so it needs the network.

4. Commit, push, and open a pull request titled "Release 0.6.0: what the version is about". Wait
   for CI (the tests on Node 22, 24 and 26, on Ubuntu and Windows; the tarball check on Node 22
   and 26; the coverage report; the replayed evals; the performance budgets), then squash-merge
   it. When release.yml changed since the last release, run its dry run first
   ([below](#the-first-run-of-a-changed-workflow)): on the branch when the release.yml of `main`
   already has the `workflow_dispatch` trigger, or else on `main` after the merge and before the
   tag.

5. Tag the merged commit and push the tag:

   ```bash
   git switch main
   git pull
   git log -1 --oneline   # must be the release commit: "Release 0.6.0: ... (#N)"
   git tag -a v0.6.0 -m "Release 0.6.0"
   git push origin v0.6.0
   ```

   The tag must be `v` followed by exactly the `version` in package.json: the workflow checks it.
   It checks nothing else, so a tag on a later commit passes too. If another pull request was
   merged after the release, tag the release commit by its hash:
   `git tag -a v0.6.0 <hash> -m "Release 0.6.0"`.

6. Watch the release workflow:

   ```bash
   gh run list --workflow release.yml --limit 1
   gh run watch <run-id>
   ```

   If its build job fails, nothing was staged: see the end of
   [What the release workflow does](#what-the-release-workflow-does). If its publish job fails, see
   [When the publish job fails](#when-the-publish-job-fails).

7. Approve the staged version. The workflow stages it (`npm stage publish`): it is uploaded with
   its provenance, but not installable yet. Open npmjs.com → your account → **Staged Packages**,
   check that it is `llm-large-files` with the version of the tag, and click **Approve**; npm asks
   for the account's two-factor approval. From a terminal logged in to npm, `npm stage approve
   <stage-id>` does the same. Until then `npm view llm-large-files@0.7.0` answers 404. A staged
   version you do not want is removed with **Reject** (or `npm stage reject <stage-id>`), and the
   same version can be staged again.

8. [Check the release](#checking-a-release).

9. Create the GitHub release from the version's section of CHANGELOG.md. The workflow does not
   make one, and the changelog sends readers to the releases page:

   ```bash
   awk 'index($0, "## 0.6.0 ") == 1 { p = 1; next } /^## / { p = 0 } p' CHANGELOG.md \
     | sed 's#](docs/#](https://github.com/renanbazinin/llm-large-files/blob/v0.6.0/docs/#g' > notes.md
   gh release create v0.6.0 --verify-tag --title "0.6.0" --notes-file notes.md
   ```

   The `awk` keeps the lines between the `## 0.6.0 — …` heading and the next `## ` heading. The
   changelog's links are relative to the repository root, so `sed` points them at the docs of the
   tag. `--verify-tag` stops when the tag is not on GitHub yet.

## What the release workflow does

`.github/workflows/release.yml` runs when a tag that starts with `v` is pushed. It has two jobs, on
Ubuntu with Node 24 and no dependency cache (a poisoned cache would run its code in the job). The
actions it uses are pinned by the commit of their release, as in `ci.yml`, which says how to update
them. Run by hand, it is a dry run with a third job in place of the publish job:
[A dry run of the release workflow](#a-dry-run-of-the-release-workflow).

**The build job** has `contents: read` and no identity token: the tests and the dependencies run in
a job that cannot ask npm for a token. Its steps:

| Step | Fails when |
| --- | --- |
| `npm ci --ignore-scripts` | package-lock.json does not match package.json. No install script runs: nothing in the tree needs one (esbuild, under Vitest, finds its binary without its `postinstall`). |
| A dispatch that stages must run on a tag | Only in a run by hand with `dry_run` off: the run is on a branch. |
| Check the tag matches package.json | The tag is not `v` + the `version` in package.json: for example `v0.6.0` on a commit whose package.json still says 0.5.0. Skipped on a branch (a dry run). |
| `npm run check` | The typecheck, a sample of the docs (`npm run typecheck:docs`), a test or the build fails. |
| Pack | `npm pack` fails. The step prints the tarball's `npm shasum`, `npm integrity` and SHA-256: npm shows the first two for the version once it is published. |
| Check the tarball as npm installs it | `node scripts/check-tarball.mjs` on that tarball finds a fault (below). |
| Upload the tarball | It is kept as the artifact `package` of the run, for 7 days. |

`scripts/check-tarball.mjs` checks the tarball itself, not the checkout:

- the files in it: only those of `files` in package.json, and every file that `exports`, `main`,
  `types` and `typesVersions` name is there;
- installed into a new project without the optional peers: `import` and `require()` of every
  subpath of `exports`, `./testing` included, give the same module, and a PDF is refused with the
  message that names `unpdf`;
- `llm-large-files/node/ingest-child.js` resolves, and a text file is ingested in a child process
  of `createIsolatedExtractors`;
- a consumer compiles with the checkout's TypeScript under `moduleResolution` NodeNext (an ES module
  and a CommonJS one), Bundler and Node10, with `skipLibCheck: false`;
- installed with `unpdf`, `jszip` and `@cantoo/pdf-lib` at the versions of package-lock.json, a PDF
  and a DOCX are read, in the process and in a child process;
- `publint` and `@arethetypeswrong/cli` (`attw`) pass, at the versions pinned in the script. `attw`
  ignores `cjs-resolves-to-esm` (the package is ESM, and `require()` of it works from Node 22.12)
  and does not check `./node/ingest-child.js` (a script that child processes run, not a module to
  import).

CI's `package` job runs the same script on Node 22.12.0 (the floor of `engines`), the newest 22,
and 26 for every pull request.

**The publish job** runs after the build job passed. It has `contents: read` and `id-token: write`,
and does not check out the repository or install anything: no code of the package or of its
dependencies runs where the identity token is. Its steps:

| Step | Fails when |
| --- | --- |
| Download the tarball | The artifact `package` of this run is missing, or its digest does not match what was uploaded. |
| Check the tarball is the one the build job checked | Its SHA-256 is not the one the build job computed. |
| Check this npm can stage | The npm of Node 24 is older than 11.15.0, which has no `npm stage`. |
| Check that this job can identify itself to npm | The job has no identity token: "No identity token for this job. The workflow needs the id-token write permission." |
| `npm stage publish ./release/llm-large-files-<version>.tgz --provenance --access public --loglevel verbose` | npm does not accept the job's identity for this package, or the trusted publisher does not allow staging (see below). The version is staged, not public, until a maintainer approves it. |

`npm stage publish` takes a package spec as `npm publish` does, a tarball included (`npm help
stage`; it shares the code of `npm publish`). Given a tarball, npm stages those bytes as they are,
and runs no script of the package: `prepublishOnly` runs only when npm publishes a folder. So the
version on npm is the tarball that the build job checked, byte for byte. The path starts with `./`:
without it npm reads `release/llm-large-files-0.6.0.tgz` as a GitHub repository.

When the build job fails, nothing was staged. Fix the cause on `main` with a pull request, delete
the tag (`git tag -d v0.6.0`, then `git push origin :refs/tags/v0.6.0`), and tag the fixed commit.

### Trusted publishing

The workflow uses npm trusted publishing: npm exchanges the job's GitHub identity for a short-lived
token, so no npm token is stored anywhere. It works only when the package's settings on npmjs.com
name this workflow. Open the package on npmjs.com → Settings → Trusted Publisher → GitHub Actions:

- Organization or user: `renanbazinin`
- Repository: `llm-large-files`
- Workflow filename: `release.yml`
- Environment name: empty
- Permissions: `npm stage publish` only (npm's default and its recommendation). Leave `npm publish`
  off: then a pushed tag, or a changed workflow, can never make a version public without a
  maintainer's two-factor approval.

A new trusted publisher must be used for a first successful publish within two days, or npm drops
it and it has to be added again.

The workflow reads no token, so an `NPM_TOKEN` secret is ignored. It used to set `NODE_AUTH_TOKEN`
from that secret; when the secret did not exist the value was empty, and with an empty token npm
did not try trusted publishing and failed with `ENEEDAUTH`. Keep `NODE_AUTH_TOKEN` unset on the
publish step.

`--provenance` attaches a signed statement that links the package to the commit and the workflow
that built it. npm can make one only inside a supported CI job, so a version published by hand has
none. npm checks the trusted publisher only at publish time, and says why it refused an identity
only in the verbose log: that is why the step runs with `--loglevel verbose`.

## A dry run of the release workflow

The release workflow also runs by hand, from the Actions tab (Release, then Run workflow) or with
`gh`, on any branch or tag. Its one input, `dry_run`, is on by default. GitHub offers the run only
when the release.yml of the default branch, `main`, has the `workflow_dispatch` trigger; the run
then uses the release.yml of the branch or tag it runs on. So the release that adds the trigger
(0.10.0) cannot be dry-run on its branch before it merges: see
[The first run of a changed workflow](#the-first-run-of-a-changed-workflow).

```bash
gh workflow run release.yml --ref release/0.6.0      # a dry run
gh run list --workflow release.yml --limit 1
gh run watch <run-id>
```

With `dry_run` on, the build job runs as for a release, without the tag check on a branch: the
checks, the tarball, the tarball check, the artifact `package`. Then the `publish-dry` job runs in
place of the publish job. It has `contents: read` and no identity token, so nothing in it can reach
npm as the package. Its steps:

| Step | Fails when |
| --- | --- |
| Download the tarball | As in the publish job. |
| Check the tarball is the one the build job checked | As in the publish job. |
| Check this npm can stage | As in the publish job. |
| Check that this job has no identity token | The job has one: its permissions grant `id-token`. |
| `npm publish ./release/llm-large-files-<version>.tgz --access public --dry-run` | npm cannot read the tarball, or refuses the version. npm prints what it would publish (the files, the version, the shasum) and sends nothing. |

Run it on the release branch, after the version bump of [At release](#at-release): there the
version is not on npm yet. On `main` between releases, package.json names a version npm already
has, and npm may refuse the dry run for it.

With `dry_run` off, the run stages the version as a pushed tag does, and only on a tag: on a branch
the build job stops at its first check. Use it to run the release of a pushed tag again, instead of
deleting and pushing the tag.

### The first run of a changed workflow

A change to release.yml is tried in a dry run before a tag depends on it. A change that is wrong
there costs a deleted tag and a new pull request; in a dry run, nothing.

1. The pull request that changes the workflow passed CI.
2. Run the workflow by hand with `dry_run` on. When the release.yml of `main` already has the
   `workflow_dispatch` trigger, run it on the release branch (or the branch of that pull request):
   the run uses that branch's release.yml. When it does not, because this change adds the trigger,
   GitHub refuses a run on any ref (`gh workflow run release.yml --ref release/0.10.0` fails). Then
   either merge the release.yml change to `main` in a pull request of its own first, and run the
   dry run on the release branch; or merge the release pull request, run the dry run on `main`
   before you tag (the version is not on npm yet, so npm takes the dry run), and tag only once it
   passed.
3. In the build job: `npm ci --ignore-scripts`, `npm run check`, Pack and the tarball check passed;
   the tag check was skipped (on a branch); Pack printed the npm shasum, the integrity and the
   SHA-256.
4. The run has the artifact `package`, with one tarball named for the version of package.json.
5. In `publish-dry`: the SHA-256 check, the npm version check and the identity-token check passed,
   and `npm publish --dry-run` listed the files of `files` in package.json and ended with
   `+ llm-large-files@<version>`, without publishing.
6. The publish job was skipped.
7. Each `uses:` the change added is pinned by a full commit SHA, with its tag in a comment (ci.yml
   says how to find it).
8. The publish job still checks out nothing and installs nothing, and has `contents: read` and
   `id-token: write` only: no code of the repository or of a dependency runs where the identity
   token is.
9. Merge (unless step 2 merged already), and tag as in [Releasing a version](#releasing-a-version). Watch the first tagged run to
   its end (step 6 there): the dry run cannot try trusted publishing itself.

## When the publish job fails

The build job passed, so the tagged commit is good and the checked tarball is kept as the artifact
`package` of the run, for 7 days. Find why npm refused in the verbose log of the publish step.

**`403 Forbidden … OIDC permission denied for this action`.** npm accepted the job's identity
(`npm verbose oidc Successfully retrieved and set token`) but the trusted publisher does not allow
what the step asked for: a plain `npm publish` against a publisher that allows staging only. This
happened on the first v0.7.0 run, before the step was `npm stage publish`. Make the step and the
publisher's permissions agree, then tag again.

The publish step has failed with trusted publishing before: on every tag from v0.2.0 to v0.5.0, and
each of those versions was published by hand. The first v0.2.0 run failed with `ENEEDAUTH` (the
empty token above). Every run since shows this in the verbose log:

```text
npm verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/llm-large-files - Not found
```

npm did not accept the job's identity for this package: the trusted publisher on npmjs.com is
missing, or does not match the values above. There are two ways to finish the release.

**Fix trusted publishing, then run the publish job again.** Correct the setting on npmjs.com (this
needs an npm account that may publish the package), then `gh run rerun <run-id> --failed`. Only the
failed job runs again: it stages the same tarball, from the artifact, with provenance. This works
while the artifact is kept and the version is not on npm yet. After 7 days, run the whole workflow
again (`gh run rerun <run-id>`): its build job builds and checks a new tarball of the same commit.

**Publish by hand the tarball the build job checked:**

```bash
gh run download <run-id> --name package --dir release-v0.6.0
sha256sum release-v0.6.0/llm-large-files-0.6.0.tgz   # the SHA-256 the Pack step printed
npm whoami                  # an npm account that may publish the package; run npm login if not
npm publish ./release-v0.6.0/llm-large-files-0.6.0.tgz --access public
```

- The tarball is the one the build job checked, so nothing is built again: npm runs no script of
  the package when it publishes a tarball. Keep the `./`: npm reads `release-v0.6.0/…` as a GitHub
  repository without it.
- npm asks for the account's two-factor approval: it prints
  `Authenticate your account at: https://www.npmjs.com/auth/cli/…` (or asks for a one-time code).
  Open the link, on any device, and approve. npm waits only a few minutes (about five in past
  releases) and then gives up, so the person who approves must be there before you run it.
- Leave out `--provenance`: it works only inside a supported CI job.
- Before it publishes, npm prints `npm notice shasum:` for the package. The Pack step of the build
  job printed the same `npm shasum:`. When the two match, npm got the tarball that CI checked. (For
  0.5.0, published by hand from a checkout, the shasum matched that of the failed job.)

When the artifact is gone (after 7 days), publish from a clean checkout of the tag, and check its
tarball first:

```bash
git clone --depth 1 --branch v0.6.0 https://github.com/renanbazinin/llm-large-files.git release-v0.6.0
cd release-v0.6.0
npm ci --ignore-scripts
npm run check
npm pack
node scripts/check-tarball.mjs llm-large-files-0.6.0.tgz
npm publish ./llm-large-files-0.6.0.tgz --access public
```

Use a clean checkout, not your working copy. `files` publishes everything under `dist/`, `src/` and
`docs/`, so an untracked or changed file there would go to npm too. The checkout also makes sure the
version is exactly the tag's.

## Checking a release

```bash
npm view llm-large-files version              # the latest version
npm view llm-large-files@0.6.0 dist.shasum    # the npm shasum the Pack step of the build job printed
```

After npm prints `+ llm-large-files@0.6.0`, the registry can take several minutes to list the
version (about one minute for 0.4.1, about five for 0.5.0). A 404 in that time is not a failed
publish: wait before you test from the registry.

Then try it in an empty folder:

```bash
mkdir try-it && cd try-it && npm init -y && npm install llm-large-files@0.6.0
node -e "import('llm-large-files').then((m) => console.log(Object.keys(m).length, 'exports'))"
node -e "import('llm-large-files/gemini').then((m) => console.log(Object.keys(m)))"
```

## Access

To publish by hand or change the trusted publisher, you need an npm account that may publish
`llm-large-files`, with two-factor authentication on (npm requires it to publish), logged in on
your machine:

```bash
npm login
npm whoami        # prints your npm user name
npm owner ls llm-large-files
```

An owner adds another maintainer with `npm owner add <npm-user> llm-large-files`.

## Versioning

Versions follow [semantic versioning](https://semver.org). While the version is `0.x`, a patch
(0.6.1) never needs a change in the user's code. A version that needs one is at least a minor
(0.7.0), and its **Upgrading** part says what to change. 0.6.0 is a minor: its
**Upgrading** part says what to change from 0.5.0.

0.99.9 is the candidate for 1.0, without a promise yet that the API stays as it is. Versions 0.99.x
keep these 0.x rules: a minor (0.99.9 to 0.100.0) may need changes in the user's code, and a patch
(0.99.10) does not. 1.0.0 comes when the maintainer chooses to keep the API stable.

These are public, and a change to them can need a change in someone's code:

- Everything exported from the six entry points (`llm-large-files`, `llm-large-files/gemini`,
  `llm-large-files/openai`, `llm-large-files/anthropic`, `llm-large-files/node`,
  `llm-large-files/testing`): names, signatures, options and their defaults. That includes the
  types an app implements: `ModelAdapter`, `DocumentStore` and `Extractor`. A new required member
  or argument breaks every adapter, store or extractor written for the previous version, so make
  new members optional.
- The tools the model sees: their names, arguments and result fields. The rest of the text the
  model is sent (tool descriptions, the tool guide, the instructions) breaks no code but changes
  answers: it goes under **Upgrading** (the cache miss) and **Changed** (what models do
  differently).
- The routes, requests, responses and statuses of the HTTP handlers in `llm-large-files/node`.
- What a store already holds, and the rounds an app stores (`ToolTurn`): 0.99.9 reads every shape
  stored since 0.2, and from 0.99.9 on each version reads at least the shape of the version before
  it. A shape newer than the reader knows is refused with an error that says so. (0.4.0 gave
  documents stored by older versions their line index the first time they were used.)
- The supported Node versions (`engines`: 22.12 or later) and the version ranges of the optional
  peers `jszip`, `unpdf`, `@cantoo/pdf-lib` and `@napi-rs/canvas`.
