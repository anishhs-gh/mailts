# Contributing to mailts

Complete guide for contributors and maintainers — from first clone through publishing a signed release.

---

## Table of Contents

1. [Repository Layout](#1-repository-layout)
2. [Prerequisites](#2-prerequisites)
3. [Local Setup](#3-local-setup)
4. [Development Workflow](#4-development-workflow)
5. [TypeScript Standards](#5-typescript-standards)
6. [Testing Requirements](#6-testing-requirements)
7. [Feature Delivery Checklist](#7-feature-delivery-checklist)
8. [Branch & Commit Conventions](#8-branch--commit-conventions)
9. [Pull Request Process](#9-pull-request-process)
10. [Versioning](#10-versioning)
11. [Release & Deployment](#11-release--deployment)
12. [Dependency Rules](#12-dependency-rules)
13. [Security](#13-security)

---

## 1. Repository Layout

```
mailts/                        ← root package (npm: @mailts/core)
├── src/                       ← core SMTP/IMAP library source
├── tests/                     ← root unit tests (vitest)
├── packages/
│   ├── cli/                   ← npm: @mailts/cli
│   ├── trap/                  ← npm: @mailts/trap
│   └── testing/               ← npm: @mailts/testing
├── developer-reference/       ← internal docs (not shipped)
├── .github/workflows/         ← CI + per-package release workflows
├── tsconfig.base.json         ← shared TS config (all packages extend this)
└── package.json               ← workspace root, declares workspaces: ["packages/*"]
```

**Publish dependency order:**

```
@mailts/core  →  @mailts/trap   →  @mailts/testing
       →  @mailts/cli
```

`@mailts/trap` and `@mailts/cli` can be published in parallel after `@mailts/core`.  
`@mailts/testing` depends on both `@mailts/core` (peer) and `@mailts/trap` (dependency), so it ships last.

---

## 2. Prerequisites

| Tool | Minimum | Notes |
|---|---|---|
| Node.js | 18.x | 20.x recommended |
| npm | 9.x | ships with Node 18+ |
| Git | 2.x | — |

No global installs required beyond Node/npm.

---

## 3. Local Setup

```bash
git clone https://github.com/anishhs-gh/mailts.git
cd mailts
npm install          # installs root + all workspace packages via npm workspaces
```

`npm install` from the root links `packages/cli`, `packages/trap`, and `packages/testing` into `node_modules` so local `file:` references resolve correctly. **Never run `npm install` inside a package subdirectory** — always from the root.

### Verify setup

```bash
npm run typecheck    # typechecks root + all workspaces
npm test             # runs root tests + all workspace tests
npm run build        # builds root + all workspaces
```

All three must pass cleanly before you start working.

---

## 4. Development Workflow

### Working on the root `@mailts/core` package

```bash
# Watch mode — rebuilds on save
npm run dev

# Run only core tests (fast, skip workspaces)
npm run test:core

# Typecheck only root
npm run typecheck --workspace=.
```

### Working on a workspace package

```bash
# Example: working on @mailts/trap
npm run dev --workspace=packages/trap
npm test --workspace=packages/trap
npm run typecheck --workspace=packages/trap
```

### How local cross-package imports work

Each workspace `package.json` has `file:` references in `devDependencies`:

```json
"devDependencies": {
  "@mailts/core": "file:../..",
  "@mailts/trap": "file:../trap"
}
```

These are **dev-only** for local type resolution and testing. They are **not published** — the release workflow rewrites them to real semver ranges before `npm publish`. Do not change them to `*` or semver ranges; they would break local development.

---

## 5. TypeScript Standards

All packages extend `tsconfig.base.json` at the repo root. The following compiler flags are non-negotiable:

| Flag | Value | Why |
|---|---|---|
| `strict` | `true` | catches null dereferences, implicit any |
| `noUncheckedIndexedAccess` | `true` | array/object access returns `T \| undefined` |
| `noImplicitReturns` | `true` | all code paths must return |
| `useUnknownInCatchVariables` | `true` | `catch (e)` is `unknown`, not `any` |
| `isolatedModules` | `true` | required for tsup/esbuild compatibility |

**Rules:**

- No `as any`. Use type narrowing or `as unknown as T` only when unavoidable, with a comment explaining why.
- No `// @ts-ignore` or `// @ts-expect-error` without a comment on the next line explaining the suppression.
- All exported functions and types must have explicit return types.
- Prefer `unknown` over `any` for external input boundaries (HTTP bodies, config files, SMTP data).
- Imports must use `.js` extensions (e.g., `import { foo } from './foo.js'`) — required for ESM interop.

---

## 6. Testing Requirements

### Coverage expectations

| Area | Requirement |
|---|---|
| Core library (`src/`) | All public API methods, error paths, edge cases |
| `@mailts/trap` | SMTP capture, MIME parsing, HTTP API endpoints, SSE |
| `@mailts/cli` | Argument parsing, command dispatch (unit); SMTP integration (integration) |
| `@mailts/testing` | `useTrapServer()` lifecycle, `waitForMessage()` polling and timeout |

**Unit tests** live in `tests/` relative to the package root.  
**No test file should be skipped or pending at the time of a PR merge.**

### Running tests

```bash
# All tests (root + workspaces)
npm test

# Root package only
npm run test:core

# Single workspace
npm test --workspace=packages/trap

# Coverage report (root only)
npm run test:coverage
```

### Test conventions

- Use `describe` blocks to group related cases; name them after the unit being tested.
- Prefer real in-process servers over mocks for network-touching code (see `tests/unit/transports/HttpClient.test.ts` for the pattern).
- Never mock the SMTP/IMAP protocol layer — integration tests must use `TrapServer` or a real SMTP server.
- `@mailts/testing` tests **must** have `globals: true` in `vitest.config.ts` — `useTrapServer()` relies on `beforeAll`/`afterAll` globals.
- Assertion style: use `expect(x).toBe(y)` for primitives, `toEqual` for objects, `toMatchObject` for partial matching.
- Test file naming: `<Unit>.test.ts`. One file per unit (class or module).

### Vitest config requirement for `@mailts/testing`

```ts
// packages/testing/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], globals: true } });
```

`globals: true` is mandatory — without it, `useTrapServer()` silently registers no lifecycle hooks and tests leak server state.

---

## 7. Feature Delivery Checklist

Use this end-to-end checklist for every non-trivial change. Copy it into your PR description and check items off as you go.

---

### Before you start coding

- [ ] **Scope is clear** — write one sentence describing what changes and why. If you can't, narrow the scope first.
- [ ] **Affected packages identified** — list every package whose source, tests, or docs will change.
- [ ] **Backward compatibility assessed** — new params must be optional; new union members additive; no removed exports. If breaking, plan a major bump.
- [ ] **Planning doc created** (optional for large features) — a `FEATURE_NAME.md` at repo root with a state machine, affected files table, and checklist. Remove it or convert it to a permanent doc after shipping.
- [ ] **Existing tests read** — understand the test patterns in the affected area before writing code.

---

### While coding

- [ ] Run `npm run test:core` (or workspace equivalent) after each meaningful change — don't let failures accumulate.
- [ ] Keep new public API surface minimal — add only what the feature requires.
- [ ] No `console.log` in library code — use `Logger` from `@mailts/core/logger`.
- [ ] No hardcoded credentials, tokens, or file-system paths.
- [ ] Imports use `.js` extensions (ESM requirement).

---

### After coding — code quality

- [ ] `npm run typecheck` — zero errors across all packages
- [ ] `npm run test` — zero failing tests across all packages
- [ ] `npm run build` — all `dist/` artifacts produced cleanly
- [ ] No `dist/` files staged for commit (they are gitignored)
- [ ] No `file:` paths in `dependencies` (only in `devDependencies`)
- [ ] No new `peerDependencies` without a matching `peerDependenciesMeta` entry

---

### After coding — tests

- [ ] Every new public method or interface has at least one unit test covering the happy path
- [ ] Error paths and edge cases are covered for non-trivial logic
- [ ] No test files skipped or pending
- [ ] Test file named `<Unit>.test.ts`, placed under `tests/unit/<area>/`

---

### After coding — documentation

- [ ] **`CHANGELOG.md`** updated in every affected package
  - Add entry under the correct version heading (`[X.Y.Z] — YYYY-MM-DD`)
  - One bullet per user-visible change; group under `### Added`, `### Changed`, `### Fixed`
  - Do **not** create a new version entry if the version hasn't been published yet — append to the current unreleased entry
- [ ] **`README.md`** updated in every affected package
  - New public API documented with a usage snippet
  - New options added to relevant option tables
  - New commands added to CLI command tables
- [ ] **`QUEUE_LIFECYCLE.md`** (or equivalent planning doc) updated if it exists
  - Checklist items marked complete
  - New sections added for features not originally planned

---

### After coding — examples and gist sync

- [ ] **New example file added** to `examples/` if the feature introduces a new usage pattern
  - File name is descriptive and kebab-case (e.g. `mail-worker-redis.ts`)
  - Example is self-contained and runnable with env vars documented at the top
  - Imports use `../src/index.js` (the sync script rewrites them to `@mailts/core` in the gist)
- [ ] **`scripts/sync-gists.mjs` updated** — add a `META` entry for every new example file:
  ```js
  'my-example.ts': {
    description: '@mailts/core — <short description> | <searchable tags>',
    title:       '<Human readable title>',
    install:     'npm install @mailts/core',
    run:         'ENV_VAR=value npx tsx my-example.ts',
    features:    ['Feature one', 'Feature two'],
  },
  ```
  Without a `META` entry the sync script logs `skip` and the gist is never created or updated.

---

### After coding — versioning

| Scenario | Action |
|---|---|
| Feature not yet published (current version still in development) | Append to existing `CHANGELOG` entry. Do **not** bump `package.json`. |
| Feature is the first change since last publish | Bump `package.json` version (patch / minor / major). Add new `CHANGELOG` entry with today's date. |
| Multiple packages affected | Bump each package independently. Widen peer dependency floor in dependents if new API is required. |
| No user-visible change (internal refactor, test-only) | No version bump. No `CHANGELOG` entry. |

Version bump rules:

| Change type | Bump |
|---|---|
| Bug fix, internal refactor, test, docs | patch |
| New export, new option, new command | minor |
| Removed export, changed signature, renamed type | major |

#### `@mailts/cli` — version is injected at build time

The CLI version is **not** hardcoded in source. `tsup.config.ts` reads `package.json` at build time and injects it as `__CLI_VERSION__` via esbuild `define`. The only file you need to edit when bumping the CLI version is:

```
packages/cli/package.json  →  "version": "X.Y.Z"
```

`packages/cli/src/index.ts` uses `declare const __CLI_VERSION__: string` — this is replaced by the real value during `npm run build`. You never need to touch `src/index.ts` for a version bump.

---

### After coding — cross-package sync

- [ ] If `@mailts/core` adds a new export used by `@mailts/cli`: bump `@mailts/cli`'s peer floor and minor version
- [ ] If `@mailts/core` adds a new export used by `@mailts/trap`: same
- [ ] If a new `@mailts/cli` subcommand calls new core API: CLI `CHANGELOG` entry added, CLI version bumped
- [ ] `packages/cli/src/index.ts` HELP text updated if new CLI commands added
- [ ] If the CLI `VERSION` constant was bumped, it must match `packages/cli/package.json`

---

### Pre-push final gate

```bash
npm run typecheck && npm test && npm run build
```

All three must be green. Do not push if any fails.

---

## 8. Branch & Commit Conventions

### Branch naming

```
feat/<short-description>        new feature
fix/<short-description>         bug fix
chore/<short-description>       tooling, deps, CI
docs/<short-description>        documentation only
test/<short-description>        tests only
```

### Commit messages (Conventional Commits)

```
<type>(<scope>): <short description>

[optional body — the WHY, not the WHAT]
```

| Type | When |
|---|---|
| `feat` | adds user-visible functionality |
| `fix` | corrects a bug |
| `chore` | tooling, deps, CI changes |
| `docs` | documentation only |
| `test` | adds or fixes tests without changing logic |
| `refactor` | restructures code without changing behaviour |
| `perf` | measurable performance improvement |

Scope is the package name without the `@mailts/` prefix: `core`, `trap`, `cli`, `testing`, `ci`.

**Examples:**

```
feat(trap): add SSE endpoint for real-time message push
fix(core): handle SMTP 421 temporary rejection in retry loop
chore(ci): add workspace typecheck step to ci.yml
test(testing): cover waitForMessage timeout path
```

Breaking changes must include `BREAKING CHANGE:` in the commit body.

---

## 9. Pull Request Process

1. **One concern per PR.** A feature PR should not also refactor unrelated code.
2. Target `main`. No direct pushes to `main` — all changes go through PRs.
3. Every PR must:
   - Pass CI (typecheck + lint + test + build across Node 18 and 20)
   - Have a description explaining *why* the change is needed
   - Reference any related issue with `Closes #<n>`
4. For breaking changes: bump the major version in `package.json` and document migration steps in the PR description.
5. For new packages: the PR must include `package.json`, `tsconfig.json`, `tsup.config.ts`, a README, at least one test file, and a corresponding release workflow in `.github/workflows/`.

---

## 10. Versioning

All packages use [Semantic Versioning](https://semver.org):

| Change | Version bump |
|---|---|
| Bug fix, internal refactor | patch (`0.1.0 → 0.1.1`) |
| New feature, new export, new option | minor (`0.1.0 → 0.2.0`) |
| Breaking API change, removed export | major (`0.1.0 → 1.0.0`) |

Version bumps are **manual** — edit `package.json` in the PR that introduces the change. Do not rely on automated tooling to bump versions.

### Cross-package version coupling

- `@mailts/cli` and `@mailts/trap` declare `@mailts/core` as a `peerDependency` with range `>=X.Y.0 <(X+1).0.0`.
- `@mailts/testing` declares both `@mailts/core` and `@mailts/trap` as peers with the same pattern.
- When `@mailts/core` ships a **minor** with new API that `@mailts/cli` depends on, widen the peer range floor: `>=0.2.0 <2.0.0`. Bump `@mailts/cli` minor too.
- When `@mailts/core` ships a **major**, all packages must release a new major that widens the peer upper bound.

---

## 11. Release & Deployment

Publishing is **always triggered by a Git tag**, never by a CI commit. There is no automated versioning bot. You push the tag; GitHub Actions builds, signs, and publishes.

### One-time setup (per repository)

1. Add `NPM_TOKEN` to repository secrets (Settings → Secrets → Actions).  
   The token must have `Automation` scope and publish access to the `@mailts` npm org.
2. Ensure the repository has **Actions permissions** to create releases (`Settings → Actions → Workflow permissions → Read and write`).

### Release workflow per package

Each package has its own workflow file triggered by a specific tag pattern:

| Package | Workflow file | Tag pattern | Example tag |
|---|---|---|---|
| `@mailts/core` | `release.yml` | `@mailts/core@*` | `@mailts/core@1.2.0` |
| `@mailts/trap` | `release-trap.yml` | `@mailts/trap@*` | `@mailts/trap@1.0.1` |
| `@mailts/cli` | `release-cli.yml` | `@mailts/cli@*` | `@mailts/cli@1.0.1` |
| `@mailts/testing` | `release-testing.yml` | `@mailts/testing@*` | `@mailts/testing@1.0.1` |

### Step-by-step: releasing a package

**Step 1 — bump the version**

Edit `package.json` of the target package, commit, and merge to `main`:

```bash
# Example: releasing @mailts/core 1.2.0
# Edit package.json: "version": "1.2.0"
git add package.json
git commit -m "chore(core): bump version to 1.2.0"
git push origin main
```

Wait for CI to pass on `main` before tagging.

**Step 2 — push the tag**

```bash
git tag '@mailts/core@1.2.0'
git push origin '@mailts/core@1.2.0'
```

This triggers `release.yml`. The workflow will:

1. `npm ci` — install full workspace
2. Typecheck → Test → Build the package
3. Verify the tag version matches `package.json` version (fails if mismatched)
4. Create a GitHub Release with auto-generated notes
5. `npm publish --provenance --access public` — signed with OIDC

**Step 3 — verify the publish**

Check `https://www.npmjs.com/package/@mailts/core` and confirm:
- Version appears under "Versions"
- Provenance badge is shown (the shield icon) — this means the release was signed

### Releasing workspace packages

Follow the **same steps** but use the package-specific tag. In addition:

- For `@mailts/trap` and `@mailts/cli`: `@mailts/core` must already be published at the version declared in their `peerDependencies` range.
- For `@mailts/testing`: both `@mailts/core` and `@mailts/trap` must already be published.

```bash
# Publishing @mailts/trap 1.0.1 after mailts 1.0.0 is already on npm
git tag @mailts/trap@1.0.1
git push origin @mailts/trap@1.0.1
```

The release workflow automatically rewrites `file:../..` → real semver in the published `package.json` before `npm publish`. You never need to edit `devDependencies` manually for publishing.

### What the tag version guard does

Each workflow contains:

```bash
PKG_VERSION=$(node -p "require('./package.json').version")
TAG_VERSION="${GITHUB_REF_NAME#@mailts/core@}"
if [ "$PKG_VERSION" != "$TAG_VERSION" ]; then exit 1; fi
```

If the tag is `@mailts/core@1.2.0` but `package.json` says `1.1.0`, the workflow fails immediately. This prevents publishing the wrong version. Fix: update `package.json`, merge, re-tag.

### Rollback / yanking a release

npm does not support deleting published versions. To deprecate a bad release:

```bash
npm deprecate @mailts/core@1.2.0 "critical bug — use 1.2.1"
```

Then publish a patch fix immediately.

### What NOT to do

- Do not run `npm publish` locally — always let GitHub Actions publish. Local publishes lose provenance signing.
- Do not tag before the version bump is merged to `main` — the workflow checks out `main`'s code.
- Do not force-push tags. If a tag was pushed in error, delete it (`git push --delete origin '@mailts/core@1.2.0'`) and re-tag after fixing.
- Do not amend commits that have already been tagged.

---

## 12. Dependency Rules

### Root `@mailts/core` package

- **No runtime `dependencies`.** Everything is in `devDependencies`. The library uses only Node.js built-ins at runtime.
- Built-in modules used: `tls`, `net`, `crypto`, `stream`, `buffer`, `dns`, `fs`, `path`, `http`, `events`.

### `@mailts/trap`

- `peerDependencies`: `@mailts/core >=0.1.0 <2.0.0` (required, not optional)
- `devDependencies` (local dev only): `@mailts/core: file:../..`
- No other runtime dependencies — uses only Node built-ins beyond `@mailts/core`

### `@mailts/cli`

- `peerDependencies`: `@mailts/core >=0.1.0 <2.0.0` (required)
- `devDependencies` (local dev only): `@mailts/core: file:../..`
- No bundled `dependencies`

### `@mailts/testing`

- `dependencies`: `@mailts/trap >=0.1.0 <2.0.0` (bundled runtime dep — users install this for test helpers)
- `peerDependencies`: `@mailts/core >=0.1.0 <2.0.0` (required)
- `devDependencies` (local dev only): `@mailts/core: file:../..`, `@mailts/trap: file:../trap`

### General rules

- Never add a `dependency` that can be expressed as a peer — this forces a single version on all consumers.
- Never add a `file:` reference to `dependencies` — only `devDependencies`. `file:` paths don't resolve for npm consumers.
- Before adding any new dependency: check its transitive dep count, last publish date, TypeScript support, and license. Prefer packages with zero or minimal transitive deps.
- All `devDependencies` must be pinned to a caret range (`^x.y.z`) — no `*` or unranged versions.

---

## 13. Security

- **No secrets in source.** Use environment variables. Never log tokens, passwords, or session keys, even at debug level.
- **Input validation at all boundaries.** SMTP commands, HTTP request bodies, config file values, and CLI arguments must all be validated before use.
- **No `eval`, `Function()`, or dynamic `require()`** with user-controlled input.
- Run `npm audit --audit-level=high` before every PR merge. CI enforces this — a high-severity audit failure blocks merge.
- If a vulnerability is found in a dependency that cannot be patched immediately, open a security issue and add a `npm audit` exemption comment explaining the risk and timeline.
- For security vulnerabilities in `@mailts/core` itself: do not open a public issue. Email `anishsh701@gmail.com` directly with details.

---

## Quick Reference

```bash
# Setup
npm install

# Daily development
npm run dev                              # watch root
npm run dev --workspace=packages/trap   # watch a package

# Validate before push (all three must be green)
npm run typecheck && npm test && npm run build

# Release (example: @mailts/core 1.2.0)
# 1. Edit package.json version → commit → merge to main
# 2. git tag '@mailts/core@1.2.0' && git push origin '@mailts/core@1.2.0'
# 3. Watch https://github.com/anishhs-gh/mailts/actions
# 4. Verify on npmjs.com/package/@mailts/core
```

### Feature delivery — short form

```
Before:  scope clear → backward-compat assessed → planning doc (if large)
During:  test:core after each change → no console.log → .js imports
After:   typecheck + test + build → tests written → CHANGELOG → README
         → version bump (only if published) → examples + sync-gists.mjs
         → cross-package peer ranges → final gate
```
