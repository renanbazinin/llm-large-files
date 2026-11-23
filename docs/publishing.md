# Publishing to npm

For maintainers. This page covers how a version of `llm-large-files` reaches npm: the changelog
while the version is in development, the release pull request, the tag that starts the release
workflow, and publishing by hand when the workflow's publish step fails. Working on the code
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
   npm run check          # typecheck, tests, build
   npm pack --dry-run     # dist/, src/, docs/, CHANGELOG.md, README.md, LICENSE, package.json
   ```

   `files` in package.json publishes all of `dist/`, `src/` and `docs/`. CONTRIBUTING.md,
   `examples/` and `test/` are not published.

4. Commit, push, and open a pull request titled "Release 0.6.0: what the version is about". Wait
   for CI (Node 22, 24 and 26, on Ubuntu and Windows), then squash-merge it.

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

   If its publish step fails, see [When the publish step fails](#when-the-publish-step-fails).

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

`.github/workflows/release.yml` runs when a tag that starts with `v` is pushed. It runs on Ubuntu
with Node 24 and no dependency cache (a poisoned cache could expose the publish token), and asks
GitHub for `contents: read` and `id-token: write`. Its steps:

| Step | Fails when |
| --- | --- |
| `npm ci` | package-lock.json does not match package.json. |
| Check the tag matches package.json | The tag is not `v` + the `version` in package.json: for example `v0.6.0` on a commit whose package.json still says 0.5.0. |
| `npm run check` | The typecheck, a test or the build fails. |
| Check that this job can identify itself to npm | The job has no identity token: "No identity token for this job. The workflow needs the id-token write permission." |
| `npm stage publish --provenance --access public --loglevel verbose` | npm does not accept the job's identity for this package, or the trusted publisher does not allow staging (see below). The version is staged, not public, until a maintainer approves it. |

When a step before the publish fails, nothing was published. Fix the cause on `main` with a pull
request, delete the tag (`git tag -d v0.6.0`, then `git push origin :refs/tags/v0.6.0`), and tag
the fixed commit.

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

## When the publish step fails

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
missing, or does not match the values above. Every step before the publish passed, so the tagged
commit is good. There are two ways to finish the release.

**Fix trusted publishing, then run the job again.** Correct the setting on npmjs.com (this needs an
npm account that may publish the package), then `gh run rerun <run-id> --failed`. The version is
published with provenance. This works only while the version is not on npm yet.

**Publish by hand from a clean checkout of the tag:**

```bash
git clone --depth 1 --branch v0.6.0 https://github.com/renanbazinin/llm-large-files.git release-v0.6.0
cd release-v0.6.0
npm ci
npm whoami                  # an npm account that may publish the package; run npm login if not
npm publish --access public
```

- Use a clean checkout, not your working copy. `files` publishes everything under `dist/`, `src/`
  and `docs/`, so an untracked or changed file there would go to npm too. The checkout also makes
  sure the version is exactly the tag's.
- `prepublishOnly` runs `npm run check` first; its build deletes `dist/` and builds it again.
- npm asks for the account's two-factor approval: it prints
  `Authenticate your account at: https://www.npmjs.com/auth/cli/…` (or asks for a one-time code).
  Open the link, on any device, and approve. npm waits only a few minutes (about five in past
  releases) and then gives up, so the person who approves must be there before you run it.
- Leave out `--provenance`: it works only inside a supported CI job.
- Before it publishes, npm prints `npm notice shasum:` for the package. The failed job's log has
  the same line. When the two match, npm got the same build that CI checked; for 0.5.0 they
  matched.

## Checking a release

```bash
npm view llm-large-files version              # the latest version
npm view llm-large-files@0.6.0 dist.shasum
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

These are public, and a change to them can need a change in someone's code:

- Everything exported from the six entry points (`llm-large-files`, `llm-large-files/gemini`,
  `llm-large-files/openai`, `llm-large-files/anthropic`, `llm-large-files/node`,
  `llm-large-files/testing`): names,
  signatures, options and their defaults. That includes the types an app implements:
  `ModelAdapter`, `DocumentStore` and `Extractor`. A new required member or argument breaks every
  adapter, store or extractor written for the previous version, so make new members optional.
- The tools the model sees: their names, arguments and result fields. The rest of the text the
  model is sent (tool descriptions, the tool guide, the instructions) breaks no code but changes
  answers: it goes under **Upgrading** (the cache miss) and **Changed** (what models do
  differently).
- The routes, requests, responses and statuses of the HTTP handlers in `llm-large-files/node`.
- What a store already holds: a new version reads documents an older one stored. (0.4.0 gave
  documents stored by older versions their line index the first time they were used.)
- The supported Node versions (`engines`: 22.12 or later) and the version ranges of the optional
  peers `jszip`, `unpdf` and `@cantoo/pdf-lib`.
