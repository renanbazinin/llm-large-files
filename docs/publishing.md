# Publishing to npm

For maintainers. The first release is published by hand. After that, tagging a version publishes
it from GitHub Actions.

## One-time setup

1. **Create an npm account** at <https://www.npmjs.com/signup> and verify your email.
2. **Turn on two-factor authentication** (Account → Two-Factor Authentication). npm requires it to
   publish.
3. **Log in from this machine:**

   ```bash
   npm login
   npm whoami        # should print your npm username
   ```

4. **Check the name is still free.** A 404 means it's available:

   ```bash
   npm view llm-large-files
   ```

   If it's taken, change `"name"` in `package.json`, either to another name or to a scope you own
   such as `@your-user/large-files`. Then update the imports in README, docs, and examples.

## First release (by hand)

```bash
npm ci
npm run check            # typecheck, tests, build
npm pack --dry-run       # review the file list: dist/, src/, docs/, README, LICENSE, CHANGELOG
npm publish --access public
```

npm asks for your 2FA code (or opens the browser). Then confirm:

```bash
npm view llm-large-files version
```

and try it in an empty folder:

```bash
mkdir try-it && cd try-it && npm init -y && npm install llm-large-files
node -e "import('llm-large-files').then(m => console.log(Object.keys(m)))"
```

## Automatic releases (after the first)

`.github/workflows/release.yml` publishes when a `v*` tag is pushed. Connect it to npm once, using
either method:

**Option A: trusted publishing (recommended, no secret to rotate).**
On npmjs.com, open the package → Settings → Trusted Publisher → GitHub Actions, and enter:

- Organization or user: `renanbazinin`
- Repository: `llm-large-files`
- Workflow filename: `release.yml`

**Option B: a token.** Create a granular access token on npmjs.com (Access Tokens → Generate New
Token → Granular, with read and write on this package). Add it to the GitHub repository as the
secret `NPM_TOKEN`. The workflow uses it when present.

Then each release is:

```bash
npm version patch        # or minor / major: bumps package.json, commits, and tags vX.Y.Z
# add the release notes to CHANGELOG.md first, or amend them in before pushing
git push --follow-tags
```

The workflow runs the full check, then publishes with provenance (a signed link from the package
back to the exact commit and workflow that built it).

## Versioning

Follow [semantic versioning](https://semver.org). While the version is `0.x`, a minor bump (`0.2.0`)
may include breaking changes; say so in the changelog. Breaking changes include anything in
`docs/api.md`, the tool names and arguments the model sees, and the HTTP responses of
`llm-large-files/node`.
